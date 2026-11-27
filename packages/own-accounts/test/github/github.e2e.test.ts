// End to end on a real upstream server with own-accounts loaded (16, GH 2026-10-31): two GitHub accounts added
// through `github.add.token`, GitHub's MCP server's tools read with one of them and registered in the workspace's
// Location under the namespace `github` (Code Mode's `tools.github.*`), a conversation whose model calls them runs as
// the project's account, a conversation's own choice runs as that account, read-only accounts offer no write tool,
// and a write asks the user before anything reaches GitHub. No token is in the event stream, OWN_HOME's files or the
// chat requests. GitHub (its `/user`, its MCP server) is the e2e kit's fake, the chat model a fake DeepSeek-dialect
// server; every token is fake.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import {
  afterToolResult,
  deepseekProvider,
  lastUserText,
  startFakeCodex,
  startFakeOpenAIChat,
  startPresetRig,
  toolOutputs,
  toolParts,
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

const WORK = "ghp_e2eWorkToken9X7c2Lq8Rz4Tn6Vb1Mk3Wp5"
const HOME = "github_pat_11E2EHOME8Kd_e2eHomeToken4Hs9Jq2Lm7Np3Rt6Vx1Zc5"
const CHAT_KEY = "fake-github-chat-key"
const CHAT = { providerID: "fake-ds", id: "deepseek-v4-flash" }

const fixture: { codex?: FakeCodex; chat?: FakeOpenAIChat; github?: FakeGitHub; rig?: PresetRig } = {}
const ids: { work?: string; home?: string } = {}

beforeAll(async () => {
  fixture.codex = startFakeCodex()
  fixture.chat = startFakeOpenAIChat({ responder: reply, credentials: { [CHAT_KEY]: { domain: "chat-model" } } })
  fixture.github = startFakeGitHub({
    accounts: { [WORK]: { login: "octo-work", scopes: "repo" }, [HOME]: { login: "octo-home" } },
  })
  fixture.rig = await startPresetRig({
    name: "github",
    codex: fixture.codex,
    chatgpt: [],
    endpoints: { ...fixture.github.endpoints },
    config: {
      providers: { [CHAT.providerID]: deepseekProvider(fixture.chat, { apiKey: CHAT_KEY, models: [CHAT.id] }) },
    },
    models: [CHAT],
    control: true,
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.chat?.stop()])
  fixture.github?.stop()
}, 60_000)

describe("GitHub accounts and their tools on a real service (16, GH)", () => {
  test("two accounts by token; the tool list is read with the first", async () => {
    const rig = required(fixture.rig)
    const work = await rig.call("github.add.token", { token: WORK, label: "회사" })
    const home = await rig.call("github.add.token", { token: HOME, label: "개인" })
    const accounts = (home.accounts as Array<{ id: string; label: string; hint: string }>) ?? []
    ids.work = accounts.find((item) => item.label === "회사")?.id
    ids.home = accounts.find((item) => item.label === "개인")?.id
    expect(work.default).toBe(ids.work)
    expect(accounts.map((item) => item.hint)).toEqual([`…${WORK.slice(-4)}`, `…${HOME.slice(-4)}`])
    await waitUntil(async () => {
      const view = await rig.call("github.view", {})
      return isRecord(view.catalog) ? view.catalog : false
    }, "the tool list was never read")
  })

  test(
    "the project's account answers its conversations; the code mode catalog lists the read tools only",
    async () => {
      const rig = required(fixture.rig)
      await rig.call("github.bind", {
        target: { type: "project", directory: rig.server.paths.workspace },
        account: required(ids.work),
      })
      const github = required(fixture.github)
      const chat = required(fixture.chat)
      const from = { mcp: github.mcp.length, chat: chat.requests.length }
      const session = await rig.server.createSession({ model: CHAT, title: "github as work" })
      await waitUntil(async () => offered(rig, { read: 3, write: 0 }), "the github tools never reached the workspace")
      await rig.server.prompt(session.id, "[github] get_me")
      await rig.server.waitIdle(session.id)
      const [execute] = await toolParts(rig.server, session.id, "execute")
      expect(required(execute).state.status).toBe("completed")
      const calls = github.mcp.slice(from.mcp).filter((item) => item.method === "tools/call")
      expect(calls.map((item) => [item.login, item.tool, item.readOnly])).toEqual([["octo-work", "get_me", true]])
      const requests = chat.requests.slice(from.chat)
      const catalog = requests.map((request) => request.body).join("\n")
      expect(catalog).toContain("get_me")
      expect(catalog).not.toContain("create_pull_request")
      expect(toolOutputs(requests.at(-1)!).join("\n")).toContain("GitHub account: octo-work (회사)")
    },
    TURN_TIMEOUT,
  )

  test(
    "a conversation's own choice runs as that account",
    async () => {
      const rig = required(fixture.rig)
      const github = required(fixture.github)
      const session = await rig.server.createSession({ model: CHAT, title: "github as home" })
      await rig.call("github.bind", {
        target: { type: "session", sessionID: session.id, directory: rig.server.paths.workspace },
        account: required(ids.home),
      })
      const view = await rig.call("github.view", { directory: rig.server.paths.workspace, sessionID: session.id })
      expect(view.inUse).toMatchObject({ account: ids.home, source: "session" })
      const from = github.mcp.length
      await rig.server.prompt(session.id, "[github] get_me")
      await rig.server.waitIdle(session.id)
      const calls = github.mcp.slice(from).filter((item) => item.method === "tools/call")
      expect(calls.map((item) => [item.login, item.tool])).toEqual([["octo-home", "get_me"]])
    },
    TURN_TIMEOUT,
  )

  test(
    "writing allowed: the write tool is listed, and it asks before anything reaches GitHub",
    async () => {
      const rig = required(fixture.rig)
      const github = required(fixture.github)
      await rig.call("github.update", { id: required(ids.work), write: true })
      await waitUntil(async () => offered(rig, { read: 3, write: 2 }), "the write tools were never offered")
      const session = await rig.server.createSession({ model: CHAT, title: "github write" })
      const from = github.mcp.length
      const seen = new Set(rig.events.events.filter((event) => event.type === "permission.asked"))
      await rig.server.prompt(session.id, "[github-write] create_pull_request")
      const asked = await rig.events
        .waitFor(
          (event) => event.type === "permission.asked" && event.data.sessionID === session.id && !seen.has(event),
        )
        .catch(async (error: unknown) => {
          // What happened instead: the Code Mode call's state and what reached GitHub.
          const parts = await toolParts(rig.server, session.id, "execute")
          throw new Error(
            `${String(error)}; execute: ${JSON.stringify(parts.map((part) => part.state))}; github: ${JSON.stringify(github.mcp.slice(from))}`,
          )
        })
      expect(asked.data).toMatchObject({ action: "github.write", resources: [`create_pull_request octo/hello as octo-work (${required(ids.work)})`] })
      // Nothing went to GitHub while the user had not answered.
      expect(github.mcp.slice(from).filter((item) => item.method === "tools/call")).toEqual([])
      await rig.server.call("POST", `/api/session/${session.id}/permission/${String(asked.data.id)}/reply`, {
        body: { decision: "once" },
      })
      await rig.server.waitIdle(session.id)
      const calls = github.mcp.slice(from).filter((item) => item.method === "tools/call")
      expect(calls.map((item) => [item.login, item.tool, item.readOnly])).toEqual([
        ["octo-work", "create_pull_request", false],
      ])
    },
    TURN_TIMEOUT,
  )

  test("no token in the event stream, OWN_HOME's files or a chat request", async () => {
    const rig = required(fixture.rig)
    const text = rig.events.text()
    const files = await everyFile(rig.home)
    const chat = required(fixture.chat)
      .requests.map((request) => request.body)
      .join("\n")
    for (const token of [WORK, HOME]) {
      expect(text).not.toContain(token)
      expect(chat).not.toContain(token)
      for (const file of files) expect(`${file.path}: ${file.text.includes(token)}`).toBe(`${file.path}: false`)
    }
    const github = await Bun.file(path.join(rig.home, "github.json")).text()
    expect(github).toContain("octo-work")
  })
})

/** The chat model: a `[github]` turn runs Code Mode with a read tool, `[github-write]` with a write tool. */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: "확인했어요." }
  const text = lastUserText(request)
  if (text.includes("[github-write]"))
    return {
      type: "tool-call",
      name: "execute",
      input: {
        code: 'return await tools.github.create_pull_request({ owner: "octo", repo: "hello", title: "Fix" })',
      },
    }
  if (text.includes("[github]"))
    return { type: "tool-call", name: "execute", input: { code: "return await tools.github.get_me({})" } }
  return { type: "text", text: "답변" }
}

/**
 * Whether the workspace's Location registered these GitHub tools last (core has no tool list endpoint): its
 * own-accounts instance logs `github_tools_offered` with the counts whenever what it offers changes.
 */
async function offered(rig: PresetRig, counts: { readonly read: number; readonly write: number }) {
  const text = await Bun.file(path.join(rig.home, "logs", "own-accounts.log"))
    .text()
    .catch(() => "")
  const last = text
    .split(/\r?\n/)
    .flatMap((line): Array<Record<string, unknown>> => {
      if (!line.includes("github_tools_offered")) return []
      // The line being written may be cut: it reads as nothing until it is whole.
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

async function everyFile(root: string): Promise<Array<{ readonly path: string; readonly text: string }>> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  return Promise.all(
    files.map(async (entry) => {
      const file = path.join(entry.parentPath, entry.name)
      return {
        path: file,
        text: await Bun.file(file)
          .text()
          .catch(() => ""),
      }
    }),
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing")
  return value
}
