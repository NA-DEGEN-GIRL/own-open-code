// Smoke test of the team e2e harness (06 §11.2) and the gates' non-team parts: TG1 dev path (own.team from source next
// to own-accounts, `health` round trip with no `rpc.invalid_output`) and TG16 for sessions outside any team (a team
// tool called there answers a refusal the model reads, never an error; the tool definitions and the Code Mode catalog
// of such a session are byte-identical with and without own-team). The directive responder is checked on its own
// first, against the request shapes of all three fake providers.
//
// Two servers share one set of fakes: one with own-accounts + own-team, one with own-accounts only. Fake credentials
// only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { hashSecret, type RecordedRequest } from "../../../own-accounts/test/e2e-kit"
import { MainTools } from "../../src/tools/main.js"
import { f1, git, temp } from "../fixtures/repo.js"
import {
  DONE,
  IDLE,
  NEED_PATHS_REASON,
  TITLE,
  TITLE_PROMPT,
  addFile,
  parse,
  proposal,
  responder,
  turn,
} from "./directives.js"
import {
  ANTHROPIC,
  BOOT_TIMEOUT,
  DEEPSEEK,
  MODEL,
  TURN_TIMEOUT,
  codexIdentity,
  startTeamFakes,
  startTeamServer,
  type TeamFakes,
  type TeamServer,
} from "./harness.js"
import {
  cache,
  catalog,
  catalogHash,
  catalogMissing,
  files,
  inbox,
  kv,
  ofSession,
  sessionLog,
  sparse,
  toolBytes,
  toolNames,
  toolsHash,
  worktrees,
} from "./inspect.js"

describe("directives (no server)", () => {
  test("top-level directives in order; bodies keep nested directives; other brackets are text", () => {
    expect(parse("[메인 요청] [dispatch ui +fresh +task=정렬 [write a.txt] [report done]] 그리고 [status]")).toEqual([
      { kind: "dispatch", area: "ui", text: "[write a.txt] [report done]", fresh: true, task: "정렬" },
      { kind: "status" },
    ])
    expect(parse("a ] [need-paths Assets/Textures docs] [report blocked 한도 대기")).toEqual([
      { kind: "need-paths", dirs: ["Assets/Textures", "docs"] },
    ])
    expect(parse("[report progress 절반] [handoff] [shell bun run typecheck] [subagent explore [shell ls]]")).toEqual([
      { kind: "report", status: "progress", text: "절반" },
      { kind: "handoff", text: "인계 문서: e2e 지시어로 쓴 인계입니다." },
      { kind: "shell", command: "bun run typecheck" },
      { kind: "subagent", agent: "explore", prompt: "[shell ls]" },
    ])
    expect(parse("[report] [dispatch] [need-paths] [write] [shell] [propose-areas x] 그냥 글")).toEqual([])
  })

  test("[propose-areas n] answers a 06 §3.4 proposal that creates n areas from main", () => {
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OwnTeam.Proposal))
    const [two] = parse("사용자 힌트: [propose-areas 2 ui]")
    const answer = respond({ input: [user(`<data>\n사용자 힌트: [propose-areas 2 ui]\n</data>`)] })
    expect(two).toEqual({ kind: "propose-areas", count: 2, slugs: ["ui"] })
    expect(answer.type).toBe("text")
    const decoded = decode(answer.type === "text" ? answer.text : "")
    expect(decoded.areas?.map((area) => [area.slug, area.create, area.adopt])).toEqual([
      ["ui", { from: "main" }, null],
      ["area-2", { from: "main" }, null],
    ])
    expect(decode(JSON.stringify(proposal(0))).areas).toEqual([])
  })

  test("Responses: one directive per request, team tools through Code Mode, `write` as `patch` for GPT", () => {
    const tools = [
      { type: "function", name: "patch" },
      { type: "function", name: "execute" },
    ]
    const first = { input: [user("[write src/new.ts] [report done]")], tools }
    expect(respond(first)).toMatchObject({
      type: "tool-call",
      name: "patch",
      input: { patchText: addFile("src/new.ts", "e2e write: src/new.ts\n") },
    })
    expect(addFile("a.txt", "x\ny\n")).toBe("*** Begin Patch\n*** Add File: a.txt\n+x\n+y\n*** End Patch")
    const second = {
      ...first,
      input: [...first.input, { type: "function_call", name: "patch" }, { type: "function_call_output", output: "ok" }],
    }
    expect(respond(second)).toMatchObject({
      type: "tool-call",
      name: "execute",
      input: { code: 'return await tools.team.report({"kind":"done","text":"done 보고입니다."})' },
    })
    const third = {
      ...second,
      input: [
        ...second.input,
        { type: "function_call", name: "execute" },
        { type: "function_call_output", output: "{}" },
      ],
    }
    expect(turn(fake(third))).toMatchObject({ done: 2, results: ["ok", "{}"], tools: ["patch", "execute"] })
    expect(respond(third)).toEqual({ type: "text", text: DONE })
  })

  test("a follow-up that holds only the tool result (Codex `previous_response_id`) continues its turn", () => {
    const model = responder()
    const follow = (id: string | undefined) =>
      model(
        fake({ previous_response_id: "resp_x", input: [{ type: "function_call_output", call_id: id, output: "{}" }] }),
      )
    const first = required(model(fake({ input: [user("[status] [report ready 준비됨]")] })))
    expect(first).toMatchObject({
      type: "tool-call",
      name: "execute",
      input: { code: "return await tools.team.status({})" },
    })
    const second = required(follow(first.type === "tool-call" ? first.id : undefined))
    expect(second).toMatchObject({
      type: "tool-call",
      input: { code: 'return await tools.team.report({"kind":"ready","text":"준비됨"})' },
    })
    expect(follow(second.type === "tool-call" ? second.id : undefined)).toEqual({ type: "text", text: DONE })
    // A result of a call this responder did not make (a test's own queued tool call) gets the plain answer.
    expect(follow("call_other")).toEqual({ type: "text", text: IDLE })
  })

  test("Anthropic: tool results inside a user message count as steps; `write` stays `write`", () => {
    const tools = [{ name: "write" }, { name: "shell" }]
    const ask = { role: "user", content: [{ type: "text", text: "[write docs/a.md 안녕] [shell bun run typecheck]" }] }
    expect(respond({ system: [{ type: "text", text: "system" }], messages: [ask], tools })).toMatchObject({
      type: "tool-call",
      name: "write",
      input: { path: "docs/a.md", content: "안녕" },
    })
    const after = [
      ask,
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "write", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
    ]
    expect(respond({ messages: after, tools })).toMatchObject({
      type: "tool-call",
      name: "shell",
      input: { command: "bun run typecheck" },
    })
    expect(turn(fake({ system: [{ type: "text", text: "system" }], messages: after }))).toMatchObject({
      system: "system",
      done: 1,
    })
  })

  test("chat completions: `tool` messages are results; titles and plain text get fixed answers", () => {
    const ask = { role: "user", content: "[need-paths Assets/Textures]" }
    expect(respond({ messages: [{ role: "system", content: "s" }, ask] })).toMatchObject({
      type: "tool-call",
      name: "execute",
      input: {
        code: `return await tools.team.need_paths({"dirs":["Assets/Textures"],"reason":"${NEED_PATHS_REASON}"})`,
      },
    })
    const done = [
      ask,
      { role: "assistant", tool_calls: [{ function: { name: "execute" } }] },
      { role: "tool", content: "x" },
    ]
    expect(respond({ messages: done })).toEqual({ type: "text", text: DONE })
    expect(respond({ messages: [{ role: "user", content: "팀 소식입니다" }] })).toEqual({ type: "text", text: IDLE })
    expect(respond({ messages: [{ role: "system", content: TITLE_PROMPT }, ask] })).toEqual({
      type: "text",
      text: TITLE,
    })
  })
})

describe("git inspectors (fixture, no server)", () => {
  test("worktrees and sparse read a locked code-only worktree made like 06 §4.5", () => {
    const folder = temp("own-team-inspect-")
    const home = f1(folder.root).home
    const area = path.join(folder.root, "home-team", "ui")
    git(home, [
      "worktree",
      "add",
      "--no-checkout",
      "--lock",
      "--reason",
      "own.team area:ar_ui",
      "-b",
      "ui",
      area,
      "main",
    ])
    git(area, ["sparse-checkout", "set", "--cone", "--sparse-index", "src"])
    git(area, ["read-tree", "-mu", "HEAD"])
    const listed = worktrees(home)
    expect(listed.map((entry) => entry.branch)).toEqual(["main", "ui"])
    expect(same(listed[0].path, home) && same(listed[1].path, area)).toBe(true)
    expect(listed[1]).toMatchObject({ locked: "own.team area:ar_ui", detached: false, bare: false })
    expect(sparse(area)).toMatchObject({ enabled: true, cone: true, list: ["src"] })
    expect(sparse(area).patterns).toContain("/src/")
    expect(files(area).filter((file) => file.includes("/"))).toEqual([
      "src/app/lib",
      "src/app/main.ts",
      "src/lib/util.ts",
    ])
    folder.dispose()
  })
})

describe("own-accounts + own-team on a real server (06 TG1 dev path, TG16 non-team)", () => {
  const state: { fakes?: TeamFakes; team?: TeamServer; plain?: TeamServer } = {}

  beforeAll(async () => {
    state.fakes = startTeamFakes()
    const [team, plain] = await Promise.all([
      startTeamServer({ name: "smoke", fakes: state.fakes }),
      startTeamServer({ name: "smoke-plain", fakes: state.fakes, team: false }),
    ])
    Object.assign(state, { team, plain })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await Promise.all([state.team?.stop(), state.plain?.stop()])
    await state.fakes?.stop()
  }, 120_000)

  test("own.team boots: health and team.list answer and decode, no rpc.invalid_output, no setup failure", async () => {
    const team = required(state.team)
    const health = await team.team("health", {})
    expect(health).toMatchObject({ guard: "ok", mode: "local", buildId: team.buildId })
    expect(Array.isArray(health.features)).toBe(true)
    expect((await team.team("team.list", {})).teams).toEqual([])
    const logs = team.server.logs()
    expect(logs).toContain('"scope":"own.team","msg":"ready"')
    expect(logs).not.toContain("rpc.invalid_output")
    expect(logs).not.toMatch(/"scope":"own\.team[^"]*","msg":"(setup_failed|guard_failed)"/)
    // The plain server has no own.team: its RPC is unavailable there.
    expect((await required(state.plain).rpc(OwnTeam.ID, "health")).status).not.toBe(200)
  })

  test("team.get is null for the F1 project; the git inspectors read its single unlocked, full checkout", async () => {
    const team = required(state.team)
    const project = required(team.project)
    expect(await team.team("team.get", { directory: project })).toEqual({
      team: null,
      areas: [],
      waiting: {},
      op: null,
      pending: [],
    })
    expect(Object.keys(kv(team.server.paths.database)).filter((key) => key.startsWith("team:"))).toEqual([])
    const listed = worktrees(project)
    expect(listed.map((entry) => [same(entry.path, project), entry.branch, entry.locked, entry.detached])).toEqual([
      [true, "main", undefined, false],
    ])
    expect(sparse(project)).toEqual({ enabled: false, cone: false, list: [], patterns: [] })
    expect(files(project)).toEqual(expect.arrayContaining(["README.md", "src/app/main.ts", "-dash/notes.md"]))
  })

  test("the self-HTTP proxy forwards own.team's and the registration file's credentials only", async () => {
    const team = required(state.team)
    const option = ServiceTarget.fixed(team.service.option)
    const registered = new ServiceTarget.Service(
      ServiceTarget.registrationPath("local", { XDG_STATE_HOME: path.join(team.root, "xdg-state") }),
    )
    const get = async (source: ServiceTarget.Source | { readonly url: string; readonly authorization: string }) => {
      const target = "current" in source ? required(await source.current()) : source
      return (
        await fetch(new URL("/api/session/active", target.url), { headers: { authorization: target.authorization } })
      ).status
    }
    const before = team.service.calls.length
    expect(await get(option)).toBe(200)
    expect(await get(registered)).toBe(200)
    expect(await get({ url: team.service.url, authorization: ServiceTarget.basic("wrong-fake-password") })).toBe(401)
    expect(team.service.calls.slice(before).map((call) => [call.caller, call.path, call.status])).toEqual([
      ["own.team", "/api/session/active", 200],
      ["registration", "/api/session/active", 200],
    ])
  })

  test(
    "a non-team session calling team_status reads the refusal as a tool result, without an error (TG16)",
    async () => {
      const team = required(state.team)
      const fakes = required(state.fakes)
      // The allow makes the tool visible; the registry decides that this session is no main or owner (06 §2.8).
      const sessionID = await team.createSession({
        title: "팀이 아닌 대화",
        permissions: [{ action: "team.member", resource: "*", effect: "allow" }],
      })
      await team.turn(sessionID, "[status] 비팀 상태 확인")

      const messages = await team.server.messages(sessionID)
      const parts = messages
        .filter((message) => message.type === "assistant")
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((part) => isRecord(part) && part.type === "tool" && part.name === "execute")
      expect(parts).toHaveLength(1)
      const part = parts[0]
      expect(part).toMatchObject({
        state: { status: "completed", metadata: { toolCalls: [{ tool: "team.status", status: "completed" }] } },
      })
      expect(JSON.stringify(part)).toContain(MainTools.NOT_TEAM)
      expect(messages.filter((message) => message.type === "assistant" && message.error !== undefined)).toEqual([])
      expect(messages.find((message) => message.type === "idle")).toMatchObject({ outcome: "succeeded" })

      // The model got the refusal back and ended the turn.
      expect(JSON.stringify(messages.find((message) => message.type === "assistant")?.content)).toContain(DONE)
      const requests = ofSession(fakes.codex.requests, sessionID)
      expect(requests.map((request) => [request.identity, request.status])).toEqual([
        [codexIdentity("01"), 200],
        [codexIdentity("01"), 200],
      ])
      expect(turn(required(requests[1])).results.join("\n")).toContain(MainTools.NOT_TEAM)
      // The team namespace is listed; since upstream v2.4 (descriptions up to 2,000 characters, more of core's own tools)
      // the catalog is partial and `status` may be reached through `search(...)`.
      expect(catalog(required(requests[0]))).toMatch(/^- team \(\d+ tools/m)
      expect(cache(requests).requests).toBe(2)

      // Durable state: delivered (no inbox row left), the log moved, still no team.
      expect(inbox(team.server.paths.database, sessionID)).toEqual([])
      expect((await sessionLog(team.server, sessionID, { directory: required(team.project) })).seq).toBeGreaterThan(0)
      expect(Object.keys(kv(team.server.paths.database)).filter((key) => key.startsWith("team:"))).toEqual([])
      // The namespace reader works on real rows: own.accounts keeps per-session state in its own namespace.
      expect(Object.keys(kv(team.server.paths.database, "own.accounts")).some((key) => key.includes(sessionID))).toBe(
        true,
      )
    },
    TURN_TIMEOUT,
  )

  test(
    "a non-team session's tool definitions and Code Mode catalog are identical with and without own-team (TG16)",
    async () => {
      const fakes = required(state.fakes)
      const servers = [required(state.team), required(state.plain)]
      const [withTeam, without] = await Promise.all(
        servers.map(async (server, index) => {
          const sessionID = await server.createSession({ title: "도구 비교" })
          await server.turn(sessionID, `도구 비교 ${index}`)
          return required(ofSession(fakes.codex.requests, sessionID)[0])
        }),
      )
      expect(toolNames(withTeam)).toEqual(toolNames(without))
      expect(toolsHash(withTeam)).toBe(toolsHash(without))
      expect(toolBytes(withTeam)).toBe(toolBytes(without))
      expect(catalog(withTeam)).toBeDefined()
      // Every conversation has the worktree conversation tools (06 §13.3); apart from them nothing changes.
      expect(catalog(withTeam)).toContain("tools.worktree.start(")
      expect(catalog(withTeam)).toContain("The catalog is complete.")
      expect(catalogMissing(withTeam, without)).toEqual([])
      expect(catalog(withTeam)).not.toContain("tools.team.")
      expect(catalog(withTeam)).not.toMatch(/^- team \(/m)
    },
    TURN_TIMEOUT,
  )

  test(
    "ChatGPT 02, DeepSeek and Anthropic answer through their fakes with the seeded credentials",
    async () => {
      const team = required(state.team)
      const fakes = required(state.fakes)
      const ask = async (model: (typeof MODEL)[keyof typeof MODEL], requests: ReadonlyArray<RecordedRequest>) => {
        const sessionID = await team.createSession({ model, title: "계정 확인" })
        await team.turn(sessionID, "안녕하세요")
        const answer = (await team.server.messages(sessionID)).find((message) => message.type === "assistant")
        expect(JSON.stringify(answer?.content)).toContain(IDLE)
        return ofSession(requests, sessionID)
      }
      expect((await ask(MODEL["02"], fakes.codex.requests)).map((request) => request.identity)).toEqual([
        codexIdentity("02"),
      ])
      expect(
        (await ask(MODEL.deepseek, fakes.deepseek.requests)).map((request) => request.headers.authorization),
      ).toEqual([hashSecret(`Bearer ${DEEPSEEK.key}`)])
      expect(
        (await ask(MODEL.anthropic, fakes.anthropic.requests)).map((request) => request.headers["x-api-key"]),
      ).toEqual([hashSecret(ANTHROPIC.key)])
    },
    TURN_TIMEOUT,
  )

  test(
    "after a killed process the harness boots the same root again: same sessions, own.team healthy, proxy retargeted",
    async () => {
      const team = required(state.team)
      const sessionID = await team.createSession({ title: "재시작 전" })
      const before = team.server.pid
      await team.restart({ kill: true })
      expect(team.server.pid).not.toBe(before)
      expect((await team.team("health", {})).guard).toBe("ok")
      expect(await team.server.call("GET", `/api/session/${sessionID}`)).toMatchObject({ data: { id: sessionID } })
      const target = required(await ServiceTarget.fixed(team.service.option).current())
      const answer = await fetch(new URL("/api/session/active", target.url), {
        headers: { authorization: target.authorization },
      })
      expect(answer.status).toBe(200)
    },
    BOOT_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** A recorded request around `json`, as the fakes hand it to the responder. */
function fake(json: Readonly<Record<string, unknown>>): RecordedRequest {
  const body = JSON.stringify(json)
  return {
    seq: 0,
    fake: "test",
    transport: "http",
    method: "POST",
    path: "/",
    headers: {},
    identity: undefined,
    body,
    bodyHash: "",
    json,
    model: "m",
    cache: undefined,
    status: 200,
    responseHeaders: {},
    at: 0,
  }
}

function respond(json: Readonly<Record<string, unknown>>) {
  return required(responder()(fake(json)))
}

function user(text: string) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] }
}

function same(a: string, b: string) {
  return path.relative(a, b) === ""
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
