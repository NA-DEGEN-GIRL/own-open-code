// A team area owner on upstream's built-in Claude Agent provider (`claude-agent`, Claude Code through the Agent SDK) on
// a real server (06 §6.1–6.2, 02 §8.10, 11 §7): a Claude Agent account in the registry (own-accounts enables the
// provider on its folder, P-045) and a fake `claude` (`fake-claude.ts`) that the SDK starts and the directive responder
// answers. The owner's tools run in OpenCode: Claude calls them over the provider's MCP server `opencode`, and they come
// back as OpenCode tool calls under OpenCode's permissions. Verdicts come from durable state (op records, the area,
// session rows, messages, instruction entries, the provider's session records in KV, files on disk) and from what the
// fake received (its log under the account folder).
//
// - The area moves to Claude Agent (area main); a main request makes the owner write a file, which waits for the
//   user's answer to OpenCode's permission request while Claude waits in its `tools/call`, and report.
// - A rotation that arrives while the owner is mid-turn (its write waits for the user's answer, Claude parked in its
//   `tools/call`) waits for the owner's safe point: no handoff request reaches Claude before the turn ends, then the
//   warm handoff runs in the same Claude conversation and the write ran once.
// - A rotation with a warm handoff: the Claude Agent owner answers `<team-request kind="handoff">` with `team_handoff`;
//   the new owner (Claude Agent too) starts with the handoff document as an instruction entry, which reaches Claude's
//   system prompt, and works on.
// - A core subagent from the owner.
// - A context reset (P-035) starts a new Claude conversation without the earlier history; its undo brings the history
//   back as catch-up.
// - A compaction summarizes on a fork of the Claude conversation (the SDK's forkSession over the account folder's
//   transcripts); the owner works on from the summary.
// - After a server restart a new claude resumes the owner's conversation (`--resume`) from its transcript.
//
// Fake credentials only; nothing reaches a real `claude` or account; every listener binds 127.0.0.1. Run from a path
// without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { childOf, instructionEntries, toolParts, type ToolPart } from "../../../own-accounts/test/e2e-kit"
import { HANDOFF_REQUEST, HANDOFF_TEXT } from "./directives.js"
import { SUMMARY, SUMMARY_ASK, projectKey, readLog, type LogLine } from "./fake-claude.js"
import {
  BOOT_TIMEOUT,
  CLAUDE_AGENT,
  MODEL,
  active,
  claudeAgentFolder,
  dispatches,
  enableTeam,
  messages,
  opEnd,
  permissions,
  reply,
  sessionRows,
  startTeamServer,
  teamMeta,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { inbox, kv } from "./inspect.js"

const STEP_TIMEOUT = 300_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
/** Core's Claude Agent plugin, whose KV holds each session's Claude conversation (`sessions/<id>`). */
const PROVIDER_PLUGIN = "opencode.provider.claude-agent"

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
}

describe("claude-agent: a team owner on the Claude Agent provider (fake claude)", () => {
  const state: { team?: Team; owner?: string } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "claude-agent", claudeAgent: true })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 1]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = { server, teamID: team.id, main: team.main.sessionID }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "claude-agent: the area moves to Claude Agent; its owner writes through OpenCode's permission and reports",
    async () => {
      const team = required(state.team)
      const before = await areaOf(team)
      const changed = await team.server.team("area.main", {
        teamID: team.teamID,
        areaID: AREA_1,
        model: CLAUDE_AGENT.model,
      })
      const moved = await opEnd(team.server, required(changed.opID))
      expect(moved.steps.filter((step) => step.state !== "done")).toEqual([])
      const area = await areaOf(team)
      const owner = required(area.owner.sessionID ?? undefined)
      expect(owner).not.toBe(before.owner.sessionID)
      expect(rowOf(team, owner).model).toMatchObject(CLAUDE_AGENT.model)
      state.owner = owner

      // `ask`: the owner's write waits for the user's answer to OpenCode's permission request.
      await team.server.accounts("session.approval.set", { sessionID: owner, mode: "ask" }, area.directory)
      await team.server.turn(
        team.main,
        "[dispatch area-1 [write ca.txt 클로드 에이전트가 썼어요] [report progress ca.txt를 썼어요]]",
      )
      const asked = await waitValue(
        async () => (await permissions(team.server, owner))[0],
        "the owner's write never asked for permission",
        STEP_TIMEOUT,
      )
      // The request is for the very call Claude made, and Claude is parked in its `tools/call` for it meanwhile: the SDK
      // has not answered it, and nothing is written yet. OpenCode asks as soon as Claude's step ends, so the fake's
      // `tools/call` may come just after the request. What held before the answer is read first and checked after it,
      // so a failed check does not leave the owner waiting.
      const made = log(team).find((line) => line.kind === "reply" && line.reply?.name === "write")
      const parked = await waitValue(
        async () => log(team).find((line) => isToolCall(line, "write")),
        "claude never called the write over MCP",
      )
      const held = {
        calls: log(team).filter((line) => isToolCall(line, "write")).length,
        answered: answers(team).has(String(record(parked.message).request_id)),
        written: fs.existsSync(path.join(area.directory, "ca.txt")),
      }
      await reply(team.server, owner, String(asked.id), "once")
      expect(record(asked.source)).toMatchObject({ type: "tool", id: made?.reply?.id })
      expect(JSON.stringify(asked.resources)).toContain("ca.txt")
      expect(held).toEqual({ calls: 1, answered: false, written: false })
      await settled(team, 1)

      expect(fs.readFileSync(path.join(area.directory, "ca.txt"), "utf8")).toBe("클로드 에이전트가 썼어요")
      const write = required((await toolParts(team.server.server, owner, "write")).at(-1))
      expect(write.state.status).toBe("completed")
      const report = required(
        (await toolParts(team.server.server, owner, "execute")).find((part) =>
          inputOf(part).includes("ca.txt를 썼어요"),
        ),
      )
      expect(report.state.status).toBe("completed")
      expect(JSON.stringify(report)).toContain("팀 소식에 적었습니다.")

      // The owner's Claude conversation: started in the area's folder on the account folder, offered OpenCode's tools
      // over the SDK server `opencode`, and both calls came back to Claude as MCP results.
      const claude = conversationOf(team, owner)
      const lines = log(team).filter((line) => line.session === claude)
      const spawn = required(lines.find((line) => line.kind === "spawn"))
      expect(projectKey(required(spawn.cwd))).toBe(projectKey(area.directory))
      expect(spawn.args).toContain(`--session-id=${claude}`)
      // Its transcript, where Claude Code keeps it: the account folder's project folder of the area.
      const folder = claudeAgentFolder(team.server.ownHome)
      expect(fs.existsSync(path.join(folder, "projects", projectKey(area.directory), `${claude}.jsonl`))).toBe(true)
      const init = required(lines.find((line) => controlOf(line) === "initialize"))
      const request = record(init.message?.request)
      expect(request.sdkMcpServers).toEqual(["opencode"])
      expect(toolNames(request)).toEqual(expect.arrayContaining(["write", "execute", "subagent"]))
      expect(userTexts(lines).some((text) => text.includes("[write ca.txt"))).toBe(true)
      const called = lines.filter((line) => isToolCall(line, "write") || isToolCall(line, "execute"))
      expect(called.length).toBe(2)
      for (const line of called) expect(answers(team).get(String(record(line.message).request_id))).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent: a rotation that arrives while the owner is mid-turn waits for the owner's safe point",
    async () => {
      const team = required(state.team)
      const old = required(state.owner)
      const area = await areaOf(team)
      const claude = conversationOf(team, old)
      // The owner is still in `ask`: its write waits for the answer, with Claude parked in its `tools/call`.
      await team.server.turn(team.main, "[dispatch area-1 [write safe.txt 안전 지점에서 썼어요]]")
      const asked = await waitValue(
        async () => (await permissions(team.server, old))[0],
        "the owner's write never asked for permission",
        STEP_TIMEOUT,
      )
      const started = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_1 })
      // The rotation waits for the owner's safe point: while the turn is open nothing asks it for the handoff, the
      // owner is still the area's, and the parked call is still unanswered.
      await Bun.sleep(3_000)
      const during = (await team.server.team("op.get", { opID: started.opID })).op
      const held = {
        state: during.state === "done" ? "done" : "open",
        handoff: during.steps.find((step) => step.kind === "rotate.handoff")?.state === "done",
        owner: (await areaOf(team)).owner.sessionID,
        asked: userTexts(log(team).filter((line) => line.session === claude)).some((text) =>
          text.includes(HANDOFF_REQUEST),
        ),
        written: fs.existsSync(path.join(area.directory, "safe.txt")),
      }
      await reply(team.server, old, String(asked.id), "once")
      expect<unknown>(held).toEqual({ state: "open", handoff: false, owner: old, asked: false, written: false })

      const op = await opEnd(team.server, started.opID)
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        ["rotate.begin", "done"],
        ["rotate.handoff", "done"],
        ["rotate.owner", "done"],
        ["rotate.swap", "done"],
        ["rotate.archive", "done"],
      ])
      expect(op.steps[1]?.note).toBe("담당이 인계 메모를 썼어요")
      // The turn finished first (its write ran once), then the warm handoff ran in the same Claude conversation.
      expect(fs.readFileSync(path.join(area.directory, "safe.txt"), "utf8")).toBe("안전 지점에서 썼어요")
      expect(
        (await toolParts(team.server.server, old, "write")).filter((part) => inputOf(part).includes("safe.txt")).length,
      ).toBe(1)
      const texts = userTexts(log(team).filter((line) => line.session === claude))
      const write = texts.findIndex((text) => text.includes("[write safe.txt"))
      const handoff = texts.findIndex((text) => text.includes(HANDOFF_REQUEST))
      expect(write).toBeGreaterThanOrEqual(0)
      expect(handoff).toBeGreaterThan(write)
      const next = required((await areaOf(team)).owner.sessionID ?? undefined)
      expect(next).not.toBe(old)
      expect(rowOf(team, next).model).toMatchObject(CLAUDE_AGENT.model)
      // The new owner works once, so the next rotation has a conversation to hand over warm.
      await team.server.turn(team.main, "[dispatch area-1 [report progress 안전 지점 뒤 일]]")
      await settled(team, 3)
      state.owner = next
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent: a rotation's warm handoff runs on Claude Agent; the new owner starts with the handoff and works on",
    async () => {
      const team = required(state.team)
      const old = required(state.owner)
      const started = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_1 })
      const op = await opEnd(team.server, started.opID)
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        ["rotate.begin", "done"],
        ["rotate.handoff", "done"],
        ["rotate.owner", "done"],
        ["rotate.swap", "done"],
        ["rotate.archive", "done"],
      ])
      expect(op.steps[1]?.note).toBe("담당이 인계 메모를 썼어요")
      const area = await areaOf(team)
      const next = required(area.owner.sessionID ?? undefined)
      expect(area.owner.previous.at(-1)).toMatchObject({ sessionID: old, why: "user" })
      expect(fs.readFileSync(required(area.handoff?.file), "utf8")).toBe(HANDOFF_TEXT)
      expect(rowOf(team, next).model).toMatchObject(CLAUDE_AGENT.model)
      expect(teamMeta(rowOf(team, next))).toEqual({ role: "owner", teamID: team.teamID, areaID: AREA_1 })
      const entries = await instructionEntries(team.server.server, next)
      expect(entries.find((entry) => entry.key === "own.team.handoff")?.value).toBe(HANDOFF_TEXT)

      // The warm turn ran in the old owner's Claude conversation: the request in, `team_handoff` out through OpenCode.
      const oldLines = log(team).filter((line) => line.session === conversationOf(team, old))
      expect(userTexts(oldLines).some((text) => text.includes(HANDOFF_REQUEST))).toBe(true)
      const handoff = required(
        (await toolParts(team.server.server, old, "execute")).find((part) =>
          inputOf(part).includes("tools.team.handoff"),
        ),
      )
      expect(handoff.state.status).toBe("completed")

      await team.server.turn(team.main, "[dispatch area-1 [report progress 인계 뒤 일]]")
      await settled(team, 2)
      const report = required(
        (await toolParts(team.server.server, next, "execute")).find((part) => inputOf(part).includes("인계 뒤 일")),
      )
      expect(report.state.status).toBe("completed")
      // The handoff document reached Claude's system prompt (the provider appends OpenCode's instructions).
      const lines = log(team).filter((line) => line.session === conversationOf(team, next))
      const init = required(lines.findLast((line) => controlOf(line) === "initialize"))
      expect(String(record(init.message?.request).appendSystemPrompt)).toContain(HANDOFF_TEXT)
      state.owner = next
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent: a core subagent from the Claude Agent owner",
    async () => {
      const team = required(state.team)
      const owner = required(state.owner)
      await team.server.turn(owner, "[subagent general 하위 작업입니다]")
      const call = required((await toolParts(team.server.server, owner, "subagent")).at(-1))
      expect(call.state.status).toBe("completed")
      const child = await childOf(team.server.server, call)
      expect(child.parentID).toBe(owner)
      // The child follows the owner's model (the area preset's roles name the main) in a Claude conversation of its own,
      // and its answer came back to the owner's Claude as the subagent tool's MCP result.
      expect(rowOf(team, child.id).model).toMatchObject(CLAUDE_AGENT.model)
      const lines = log(team).filter((line) => line.session === conversationOf(team, child.id))
      expect(userTexts(lines).some((text) => text.includes("하위 작업입니다"))).toBe(true)
      const called = required(
        log(team)
          .filter((line) => line.session === conversationOf(team, owner))
          .findLast((line) => isToolCall(line, "subagent")),
      )
      expect(answers(team).get(String(record(called.message).request_id))).toBe(false)
      // The child's background result reaches the owner as a turn of its own (upstream v2.4 background subagents). Under
      // load it came after the next test's reset and rode along with that test's request (2.4.1-own.3 release tier):
      // this test ends once it was delivered and the owner is idle again.
      await until(
        async () =>
          userTexts(log(team).filter((line) => line.session === conversationOf(team, owner))).some((text) =>
            text.includes(`<background-result kind="subagent" sessionID="${child.id}"`),
          ) &&
          inbox(db(team), owner).length === 0 &&
          !(await active(team.server)).has(owner) &&
          (await team.server.server.messages(owner)).at(0)?.type === "idle",
        "the subagent's background result never reached the owner",
        STEP_TIMEOUT,
      )
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent: a context reset starts a new Claude conversation; its undo resumes the one from before the reset",
    async () => {
      const team = required(state.team)
      const owner = required(state.owner)
      const before = conversationOf(team, owner)
      const created = record(await team.server.server.call("POST", `/api/session/${owner}/reset`, { body: {} }))
      const resetID = String(record(created.data).id)
      await until(
        async () => !inbox(db(team), owner).some((item) => item.id === resetID),
        "the reset was never delivered",
      )
      await team.server.turn(owner, "[report progress 비운 뒤]")
      const reset = conversationOf(team, owner)
      expect(reset).not.toBe(before)
      const fresh = required(userTexts(log(team).filter((line) => line.session === reset))[0])
      expect(fresh).toContain("[report progress 비운 뒤]")
      expect(fresh).not.toContain("인계 뒤 일")
      expect(fresh).not.toContain("<conversation-checkpoint>")
      expect(reportOf(await toolParts(team.server.server, owner, "execute"), "비운 뒤")?.state.status).toBe("completed")

      const undone = await team.server.server.request("DELETE", `/api/session/${owner}/reset/${resetID}`)
      expect(undone.status).toBe(204)
      await team.server.turn(owner, "[report progress 되돌린 뒤]")
      // P-043: the conversation from before the reset is resumed (kept with the record), the turns made while the reset
      // stood written into it as entries; claude was sent only the new request.
      const restored = conversationOf(team, owner)
      expect(restored).toBe(before)
      const lines = log(team).filter((line) => line.session === restored)
      const resumed = required(lines.findLast((line) => line.kind === "spawn"))
      expect(resumed.args).toContain(`--resume=${before}`)
      expect(userTexts(lines.filter((line) => line.pid === resumed.pid))).toEqual(["[report progress 되돌린 뒤]"])
      const read = JSON.stringify(
        required(lines.find((line) => line.kind === "request" && line.pid === resumed.pid)).request?.messages,
      )
      expect(read).toContain("인계 뒤 일")
      expect(read).toContain("비운 뒤")
      expect(read).not.toContain("conversation-checkpoint")
      // Claude read the history as history: the earlier request did not run again.
      const reports = await toolParts(team.server.server, owner, "execute")
      expect(reportOf(reports, "되돌린 뒤")?.state.status).toBe("completed")
      expect(reports.filter((part) => inputOf(part).includes("인계 뒤 일")).length).toBe(1)
      const marker = (await messages(team.server, owner)).findLast(
        (message) => message.type === "compaction" && message.reason === "reset",
      )
      expect(marker?.undone).toBeDefined()
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent: a compaction summarizes on a fork of the Claude conversation; the owner works on from it",
    async () => {
      const team = required(state.team)
      const owner = required(state.owner)
      const before = conversationOf(team, owner)
      const spawned = log(team).filter((line) => line.kind === "spawn").length
      await team.server.server.call("POST", `/api/session/${owner}/compact`, { body: {} })
      const compaction = await waitValue(
        async () =>
          (await messages(team.server, owner)).findLast(
            (message) => message.type === "compaction" && message.reason === "manual" && message.status !== "running",
          ),
        "the compaction never ended",
        STEP_TIMEOUT,
      )
      expect(compaction.status).toBe("completed")
      expect(compaction.summary).toBe(SUMMARY)
      await team.server.server.waitIdle(owner)

      // The summary ran in a throwaway claude on a fork of the owner's conversation, saved nowhere and removed after.
      const side = log(team)
        .filter((line) => line.kind === "spawn")
        .slice(spawned)
        .find((line) => (line.args ?? []).includes("--no-session-persistence") && line.session !== before)
      const forked = required(side).session
      expect(required(side).args).toContain(`--resume=${forked}`)
      expect(userTexts(log(team).filter((line) => line.session === forked)).join("\n")).toContain(SUMMARY_ASK[0])
      const transcripts = path.join(claudeAgentFolder(team.server.ownHome), "projects")
      expect(
        fs
          .readdirSync(transcripts, { recursive: true })
          .map(String)
          .some((name) => name.includes(forked)),
      ).toBe(false)

      await team.server.turn(owner, "[report progress 압축 뒤]")
      const after = conversationOf(team, owner)
      expect(after).not.toBe(before)
      const resumed = required(userTexts(log(team).filter((line) => line.session === after))[0])
      expect(resumed).toContain("e2e 대화를 요약했습니다")
      expect(resumed).toContain("[report progress 압축 뒤]")
      // P-043: the summary went in once, under core's own checkpoint tag only (never wrapped in a second one).
      const read = JSON.stringify(
        required(log(team).find((line) => line.session === after && line.kind === "request")).request?.messages,
      )
      expect(read.match(/<conversation-checkpoint>/g)).toHaveLength(1)
      expect(read).not.toContain("The following is conversation history from OpenCode")
      const reports = await toolParts(team.server.server, owner, "execute")
      expect(reportOf(reports, "압축 뒤")?.state.status).toBe("completed")
      // The summary's recent context is history too: the request before the compaction did not run again.
      expect(reports.filter((part) => inputOf(part).includes("되돌린 뒤")).length).toBe(1)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent: after a server restart claude resumes the owner's conversation from the account folder",
    async () => {
      const team = required(state.team)
      const owner = required(state.owner)
      const before = conversationOf(team, owner)
      await team.server.restart()
      await team.server.turn(owner, "[report progress 다시 켠 뒤]")
      expect(conversationOf(team, owner)).toBe(before)
      // A new claude on the same conversation: `--resume`, read back from the transcript, so only the new text is sent.
      const lines = log(team).filter((line) => line.session === before)
      const spawns = lines.filter((line) => line.kind === "spawn")
      expect(spawns.length).toBe(2)
      expect(spawns.at(-1)?.args).toContain(`--resume=${before}`)
      const texts = userTexts(lines.filter((line) => line.pid === spawns.at(-1)?.pid))
      expect(texts).toEqual(["[report progress 다시 켠 뒤]"])
      const reports = await toolParts(team.server.server, owner, "execute")
      expect(reportOf(reports, "다시 켠 뒤")?.state.status).toBe("completed")
      expect(reports.filter((part) => inputOf(part).includes("압축 뒤")).length).toBe(1)
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

function db(team: Team) {
  return team.server.server.paths.database
}

async function areaOf(team: Team) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return required(view.areas.find((area) => area.id === AREA_1))
}

function rowOf(team: Team, sessionID: string) {
  return required(sessionRows(db(team)).find((row) => row.id === sessionID))
}

/** The Claude conversation the provider keeps for an OpenCode session (its record in the plugin's KV). */
function conversationOf(team: Team, sessionID: string) {
  const saved = record(kv(db(team), PROVIDER_PLUGIN)[`sessions/${sessionID}`])
  if (typeof saved.claudeSessionID !== "string") throw new Error(`no Claude conversation for ${sessionID}`)
  return saved.claudeSessionID
}

/** What the fake `claude` received and answered, in order. */
function log(team: Team) {
  return readLog(claudeAgentFolder(team.server.ownHome))
}

function controlOf(line: LogLine) {
  return line.kind === "in" && line.message?.type === "control_request"
    ? record(line.message.request).subtype
    : undefined
}

/** The texts of the user messages the SDK sent, oldest first, each joined over its text blocks. */
function userTexts(lines: ReadonlyArray<LogLine>) {
  return lines.flatMap((line) => {
    if (line.kind !== "in" || line.message?.type !== "user") return []
    const content = record(line.message.message).content
    const blocks = Array.isArray(content) ? content : [{ text: content }]
    return [blocks.map((block) => String(record(block).text ?? "")).join("\n")]
  })
}

/** The fake's MCP `tools/call` of OpenCode tool `name` (a control request it sent the SDK). */
function isToolCall(line: LogLine, name: string) {
  if (line.kind !== "out") return false
  const request = record(line.message?.request)
  const call = record(request.message)
  return request.subtype === "mcp_message" && call.method === "tools/call" && record(call.params).name === name
}

/** The SDK's answers to the fake's MCP `tools/call` requests: request id → whether the result was an error. */
function answers(team: Team) {
  const lines = log(team)
  return new Map(
    lines.flatMap((line) => {
      if (line.kind !== "in" || line.message?.type !== "control_response") return []
      const response = record(line.message.response)
      const mcp = record(record(response.response).mcp_response)
      if (!("result" in mcp) && !("error" in mcp)) return []
      return [[String(response.request_id), record(mcp.result).isError === true || "error" in mcp] as const]
    }),
  )
}

function toolNames(request: Readonly<Record<string, unknown>>) {
  const manifest = record(record(record(request.sdkMcpServerManifests).opencode).toolsListResult)
  return (Array.isArray(manifest.tools) ? manifest.tools : []).map((tool) => String(record(tool).name))
}

function inputOf(part: ToolPart) {
  return JSON.stringify(part.state.input)
}

function reportOf(parts: ReadonlyArray<ToolPart>, text: string) {
  return parts.find((part) => inputOf(part).includes(text))
}

/** Waits until the area has `count` sent requests, nothing waits, and its owner is idle with an empty inbox. */
async function settled(team: Team, count: number) {
  await until(
    async () => {
      const items = dispatches(db(team), team.teamID).filter((item) => item.areaID === AREA_1)
      const area = await areaOf(team)
      const sessionID = area.owner.sessionID
      return (
        items.filter((item) => item.state === "sent").length >= count &&
        items.every((item) => item.state !== "waiting") &&
        sessionID !== null &&
        !(await active(team.server)).has(sessionID) &&
        (await team.server.server.messages(sessionID)).at(0)?.type === "idle"
      )
    },
    `area ${AREA_1} did not settle with ${count} requests sent`,
    STEP_TIMEOUT,
  )
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
