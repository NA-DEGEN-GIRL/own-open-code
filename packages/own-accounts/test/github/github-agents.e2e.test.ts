// GitHub writes ask under every agent and conversation (16 §5.4, GH-13), end to end on a real upstream server with
// own-accounts loaded: the user's config agent as `default_agent` (core's `post` ConfigAgentPlugin applies it after
// own's setup transform, and gives it the default `*` allow), a conversation whose own rules allow everything (as omo
// gives its children the v1 `*` allow), `항상 허용` of one tool, repository and account honoured until the user removes
// it (then every conversation asks again, the allow-all one too: core patch P-047, GH-26), and a repository the model
// made up never saved. GitHub (its `/user`, its MCP server) is the e2e kit's fake, the chat model a fake
// DeepSeek-dialect server; every token is fake.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { Option, Schema } from "effect"
import {
  afterToolResult,
  deepseekProvider,
  lastUserText,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  waitUntil,
  type FakeCodex,
  type FakeOpenAIChat,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { startFakeGitHub, type FakeGitHub } from "../e2e-kit/fakes/github"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const WORK = "ghp_e2eAgentsToken9X7c2Lq8Rz4Tn6Vb1Mk3W"
const CHAT_KEY = "fake-github-agents-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }
const ALLOW_ALL = [{ action: "*", resource: "*", effect: "allow" }]

const fixture: { codex?: FakeCodex; chat?: FakeOpenAIChat; github?: FakeGitHub; rig?: PresetRig; account?: string } =
  {}

/** A write's permission resource: the tool, the repository and the account (GH-32). */
const resource = (tool: string, repository: string) => `${tool} ${repository} as octo-work (${required(fixture.account)})`

beforeAll(async () => {
  fixture.codex = startFakeCodex()
  fixture.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
  fixture.github = startFakeGitHub({ accounts: { [WORK]: { login: "octo-work", scopes: "repo" } } })
  fixture.rig = await startPresetRig({
    name: "ghagents",
    codex: fixture.codex,
    chatgpt: [],
    endpoints: { ...fixture.github.endpoints },
    config: {
      providers: { [CHAT.providerID]: deepseekProvider(fixture.chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) },
      agents: { mine: { mode: "primary", description: "the user's own agent" } },
      default_agent: "mine",
    },
    models: [CHAT],
    control: true,
  })
  const rig = fixture.rig
  const added = await rig.call("github.add.token", { token: WORK, label: "회사", write: true })
  const id = (added.accounts as Array<{ id: string }>)[0]!.id
  fixture.account = id
  await rig.call("github.bind", { target: { type: "project", directory: rig.server.paths.workspace }, account: id })
  await waitUntil(async () => {
    const view = await rig.call("github.view", {})
    return isRecord(view.catalog) ? view.catalog : false
  }, "the tool list was never read")
  await waitUntil(async () => offered(rig, { read: 3, write: 2 }), "the write tools never reached the workspace")
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
  fixture.github?.stop()
}, 60_000)

describe("GitHub writes ask under every agent (GH-13)", () => {
  test(
    "the user's config agent as the default asks; 항상 허용 keeps that tool and repository",
    async () => {
      const rig = required(fixture.rig)
      // No agent named: core runs the configured `default_agent`, the user's `mine`.
      const session = await rig.server.createSession({ model: CHAT, title: "config agent write" })
      const asked = await write(session.id, "[github-write] octo/hello")
      const pr = resource("create_pull_request", "octo/hello")
      expect(asked.data).toMatchObject({ action: "github.write", resources: [pr], save: [pr] })
      await answer(session.id, asked.data.id, "always")
      expect(calls(asked.from)).toEqual([["octo-work", "create_pull_request", "octo/hello"]])
      // Core saved it for the project, so the same write in another conversation runs at once.
      expect(await saved(rig)).toEqual([pr])
      const again = await rig.server.createSession({ model: CHAT, title: "config agent again" })
      const from = required(fixture.github).mcp.length
      await rig.server.prompt(again.id, "[github-write] octo/hello")
      await rig.server.waitIdle(again.id)
      expect(calls(from)).toEqual([["octo-work", "create_pull_request", "octo/hello"]])
    },
    TURN_TIMEOUT,
  )

  test(
    "a conversation whose own rules allow everything (omo's children) still asks a write",
    async () => {
      const rig = required(fixture.rig)
      const created = await rig.server.call("POST", "/api/session", {
        body: {
          title: "allow-all conversation",
          model: CHAT,
          location: { directory: rig.server.paths.workspace },
          permissions: ALLOW_ALL,
        },
      })
      const session = required((created as { data?: { id: string } }).data)
      const asked = await write(session.id, "[github-write] octo/other")
      expect(asked.data).toMatchObject({ resources: [resource("create_pull_request", "octo/other")] })
      expect(calls(asked.from)).toEqual([])
      await answer(session.id, asked.data.id, "once")
      expect(calls(asked.from)).toEqual([["octo-work", "create_pull_request", "octo/other"]])
    },
    TURN_TIMEOUT,
  )

  test(
    "a made-up repository is allowed once only; a removed 항상 허용 asks again, in an allow-all conversation too",
    async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: CHAT, title: "made-up repository" })
      const asked = await write(session.id, "[github-write] */*")
      expect(asked.data).toMatchObject({ resources: [resource("create_pull_request", "*/*")], save: [] })
      await answer(session.id, asked.data.id, "always")
      const pr = resource("create_pull_request", "octo/hello")
      expect(await saved(rig)).toEqual([pr])
      // An allow-all conversation (omo's children carry v1's `*` allow as session rules) runs the saved write at once.
      const allowAll = async (title: string) => {
        const created = await rig.server.call("POST", "/api/session", {
          body: { title, model: CHAT, location: { directory: rig.server.paths.workspace }, permissions: ALLOW_ALL },
        })
        return required((created as { data?: { id: string } }).data)
      }
      const before = await allowAll("allow-all, saved")
      const from = required(fixture.github).mcp.length
      await rig.server.prompt(before.id, "[github-write] octo/hello")
      await rig.server.waitIdle(before.id)
      expect(calls(from)).toEqual([["octo-work", "create_pull_request", "octo/hello"]])
      // The user takes `항상 허용` back in 설정 > 승인·권한: the next write asks again, in a conversation of the default
      // agent and in an allow-all one alike (gw1: the allow-all one wrote unasked while own kept its own copy).
      const listed = (await rig.server.call("GET", "/api/permission/saved")) as {
        data: Array<{ id: string; action: string }>
      }
      for (const item of listed.data.filter((entry) => entry.action === "github.write"))
        await rig.server.call("DELETE", `/api/permission/saved/${item.id}`)
      const later = await rig.server.createSession({ model: CHAT, title: "after removal" })
      const again = await write(later.id, "[github-write] octo/hello")
      expect(again.data).toMatchObject({ resources: [pr] })
      await answer(later.id, again.data.id, "once")
      const after = await allowAll("allow-all, removed")
      const stale = await write(after.id, "[github-write] octo/hello")
      expect(stale.data).toMatchObject({ resources: [pr] })
      await answer(after.id, stale.data.id, "once")
    },
    TURN_TIMEOUT * 2,
  )
})

/** Prompts a write and waits for its ask; nothing reached GitHub by then. */
async function write(sessionID: string, prompt: string) {
  const rig = required(fixture.rig)
  const from = required(fixture.github).mcp.length
  const seen = new Set(rig.events.events.filter((event) => event.type === "permission.asked"))
  await rig.server.prompt(sessionID, prompt)
  const asked = await rig.events.waitFor(
    (event) => event.type === "permission.asked" && event.data.sessionID === sessionID && !seen.has(event),
    30_000,
  )
  expect(calls(from)).toEqual([])
  return { data: asked.data as { id: string } & Record<string, unknown>, from }
}

async function answer(sessionID: string, requestID: string, decision: "once" | "always") {
  const rig = required(fixture.rig)
  await rig.server.call("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, { body: { decision } })
  await rig.server.waitIdle(sessionID)
}

/** The tool calls GitHub got since `from`: login, tool, repository. */
function calls(from: number) {
  return required(fixture.github)
    .mcp.slice(from)
    .filter((item) => item.method === "tools/call")
    .map((item) => {
      const args = isRecord(item.args) ? item.args : {}
      return [item.login, item.tool, `${String(args.owner)}/${String(args.repo)}`]
    })
}

/** The project's saved `항상 허용` of GitHub writes, as core holds them (설정 > 승인·권한). */
async function saved(rig: PresetRig) {
  const listed = (await rig.server.call("GET", "/api/permission/saved")) as {
    data: Array<{ action: string; resource: string }>
  }
  return listed.data.filter((item) => item.action === "github.write").map((item) => item.resource)
}

/** The chat model: `[github-write] <owner>/<repo>` runs Code Mode with GitHub's create_pull_request. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "확인했어요." }
  const text = lastUserText(request)
  const target = /\[github-write\] (\S+)\/(\S+)/.exec(text)
  if (target)
    return {
      type: "tool-call",
      name: "execute",
      input: {
        code: `return await tools.github.create_pull_request(${JSON.stringify({ owner: target[1], repo: target[2], title: "Fix" })})`,
      },
    }
  return { type: "text", text: "답변" }
}

/** Whether the workspace's Location registered these GitHub tools last (its `github_tools_offered` log line). */
async function offered(rig: PresetRig, counts: { readonly read: number; readonly write: number }) {
  const text = await Bun.file(path.join(rig.home, "logs", "own-accounts.log"))
    .text()
    .catch(() => "")
  const last = text
    .split(/\r?\n/)
    .flatMap((line): Array<Record<string, unknown>> => {
      if (!line.includes("github_tools_offered")) return []
      const parsed = Option.getOrUndefined(decodeLine(line))
      return isRecord(parsed) ? [parsed] : []
    })
    .filter(
      (line) =>
        typeof line.location === "string" && path.resolve(line.location) === path.resolve(rig.server.paths.workspace),
    )
    .at(-1)
  return last?.read === counts.read && last?.write === counts.write
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing")
  return value
}
