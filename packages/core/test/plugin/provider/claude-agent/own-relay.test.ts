// OWN-PATCH(P-052) begin
// The Claude Agent route on an SSH host (02 §8.10.13): the host's provider drives a claude on the PC through
// ClaudeRelay. Here both sides run in one process: the host's sessions use `ClaudeRelay.io` over an in-memory transport,
// the PC's server starts a real child process (the fake `claude` CLI) in the PC's account and working folders and counts
// it in the PC's pool. Also the PC's checks: the arguments, the host's input and the login's e-mail.
import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Effect, Fiber, SubscriptionRef } from "effect"
import { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { ClaudeObserver } from "@opencode/core/plugin/provider/claude-agent/claude/observer"
import { ClaudeQueryOptions } from "@opencode/core/plugin/provider/claude-agent/claude/query-options"
import { ClaudeRelay } from "@opencode/core/plugin/provider/claude-agent/claude/relay"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { ClaudeStatus } from "@opencode/core/plugin/provider/claude-agent/claude/status"
import { FolderStore } from "@opencode/core/plugin/provider/claude-agent/claude/folder-store"
import { ClaudeAgentLanguageModel } from "@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind"
import { SessionRecord } from "@opencode/core/plugin/provider/claude-agent/sync/record"
import { it } from "../../../lib/effect"
import { tmpdirScoped } from "../../../fixture/tmpdir"
import { Recorder } from "./lib/recorder"
import { TestSessions } from "./lib/sessions"

const FAKE = path.join(import.meta.dir, "lib", "fake-claude-cli.ts")
const ACCOUNT = "acc_01JRELAYTESTACCOUNT000000"
const HOST_DIRECTORY = "/home/dev/project"
const LOOKUP: LanguageModelV3FunctionTool = {
  type: "function",
  name: "lookup",
  description: "Look up a fixture marker by key.",
  inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
}
const SECRET_EMAIL = "fake-owner@example.invalid"

// The provider's arguments as the SDK builds them (a recorded spawn of a chat with tools).
const RECORDED = [...(Recorder.load("tools").find((line) => line.from === "spawn") as { readonly args: readonly string[] }).args]

describe("the PC's checks on a host's claude (P-052)", () => {
  test("the provider's own arguments pass, with every optional flag the SDK may add", () => {
    expect(ClaudeRelay.gate(RECORDED)).toEqual(RECORDED)
    const more = [
      ...RECORDED.filter((arg) => !arg.startsWith("--session-id")),
      "--thinking=adaptive",
      "--thinking-display=summarized",
      "--effort=high",
      "--resume=8d32d1aa-e50f-4cad-a767-fbd3348866f8",
      "--fork-session",
      "--no-session-persistence",
    ]
    expect(ClaudeRelay.gate(more)).toEqual(more)
  })

  test("anything that would give the PC's claude its own tools, settings, plugins or folders is refused", () => {
    const refused = (args: string[]) => expect(() => ClaudeRelay.gate(args)).toThrow(ClaudeRelay.Refused)
    refused([...RECORDED, "--add-dir=C:\\"])
    refused([...RECORDED, "--plugin-dir=/x"])
    refused([...RECORDED, "--dangerously-skip-permissions"])
    refused([...RECORDED, "--mcp-config", '{"mcpServers":{"x":{"command":"calc"}}}'])
    refused([...RECORDED, "--debug-file=C:\\x"])
    refused(RECORDED.map((arg) => (arg === "--tools=" ? "--tools=Bash" : arg)))
    refused(RECORDED.map((arg) => (arg === "--permission-mode=dontAsk" ? "--permission-mode=bypassPermissions" : arg)))
    refused(RECORDED.map((arg) => (arg === '{"disableAllHooks":true}' ? '{"apiKeyHelper":"calc"}' : arg)))
    refused(RECORDED.filter((arg) => arg !== "--tools="))
    refused(RECORDED.filter((arg) => arg !== "--setting-sources="))
    refused([...RECORDED.filter((arg) => !arg.startsWith("--model")), "--model=-x"])
    refused([...RECORDED, "--allowedTools=Bash"])
  })

  test("the host's input: messages verbatim, the provider's controls, nothing else", () => {
    const initialize = Recorder.load("tools").find(
      (line) => line.from === "sdk" && line.message.request?.subtype === "initialize",
    ) as { message: Record<string, any> }
    expect(ClaudeRelay.admitInput(JSON.stringify(initialize.message)).kind).toBe("pass")
    const user = ClaudeRelay.admitInput(
      JSON.stringify({ type: "user", message: { role: "user", content: "/login" }, parent_tool_use_id: null }),
    )
    expect(user).toMatchObject({ kind: "pass", message: { client_composed: true } })
    const control = (request: object) =>
      ClaudeRelay.admitInput(JSON.stringify({ type: "control_request", request_id: "r1", request }))
    expect(control({ subtype: "set_model", model: "sonnet" }).kind).toBe("pass")
    expect(control({ subtype: "apply_flag_settings", settings: { effortLevel: "high" } }).kind).toBe("pass")
    // OWN-PATCH(P-060) begin
    // own's speed turns Claude Code's Fast mode on and off for a turn; only a boolean passes.
    expect(control({ subtype: "apply_flag_settings", settings: { fastMode: true } }).kind).toBe("pass")
    expect(control({ subtype: "apply_flag_settings", settings: { fastMode: false } }).kind).toBe("pass")
    expect(control({ subtype: "apply_flag_settings", settings: { fastMode: "on" } }).kind).toBe("refuse")
    // OWN-PATCH(P-060) end
    expect(control({ subtype: "interrupt" }).kind).toBe("pass")
    for (const request of [
      { subtype: "mcp_set_servers", servers: { x: { command: "calc" } } },
      { subtype: "apply_flag_settings", settings: { apiKeyHelper: "calc" } },
      { subtype: "update_settings", settings: {} },
      { subtype: "read_file", path: "C:\\Users" },
      { subtype: "set_cwd", cwd: "C:\\" },
      { subtype: "set_permission_mode", mode: "bypassPermissions" },
      { ...initialize.message.request, agents: { x: { tools: ["Bash"] } } },
      { ...initialize.message.request, sdkMcpServers: ["opencode", "other"] },
      { ...initialize.message.request, plugins: [{ type: "local", path: "/x" }] },
    ]) {
      const verdict = control(request)
      expect(verdict.kind).toBe("refuse")
      expect(verdict.kind === "refuse" ? verdict.answer : undefined).toMatchObject({
        type: "control_response",
        response: { subtype: "error", request_id: "r1" },
      })
    }
    expect(ClaudeRelay.admitInput(JSON.stringify({ type: "update_environment_variables", variables: {} })).kind).toBe(
      "refuse",
    )
  })

  test("the initialize answer reaches the host with the login's plan only", () => {
    const scrubbed = ClaudeRelay.scrub({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "r",
        response: { models: [], account: { email: SECRET_EMAIL, organization: "Org", subscriptionType: "max", tokenSource: "claude.ai" } },
      },
    })
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET_EMAIL)
    expect(JSON.stringify(scrubbed)).not.toContain("Org")
    expect(scrubbed.response.response.account).toEqual({ subscriptionType: "max", tokenSource: "claude.ai" })
  })
})

function storage() {
  const data = new Map<string, unknown>()
  return {
    data,
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: SessionRecord.Record) =>
      Effect.sync(() => {
        data.set(key, structuredClone(value))
      }),
    remove: (key: string) =>
      Effect.sync(() => {
        data.delete(key)
      }),
    scan: (options: { readonly prefix: string }) =>
      Effect.sync(() => ({
        entries: [...data.entries()].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, value })),
      })),
  }
}

// The PC: an account folder whose `projects` is the shared folder, a working folder for the host's directory, the real
// transcript helpers and the fake CLI as `claude`.
const pc = Effect.fn(function* () {
  const root = (yield* tmpdirScoped("own-relay-")).path
  const configDir = path.join(root, "account")
  const hosts = path.join(root, "hosts")
  const directory = path.join(hosts, "h1", "work")
  fs.mkdirSync(path.join(configDir, "projects"), { recursive: true })
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(configDir, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-PCONLY"}}')
  ClaudeObserver.share(path.join(configDir, "projects"))
  ClaudeObserver.channel().hostsRoot = hosts
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      ClaudeObserver.share(undefined)
      ClaudeObserver.channel().hostsRoot = undefined
      ClaudeObserver.configure({})
    }),
  )
  const io: ClaudeIO.Interface = { ...ClaudeIO.local, which: () => FAKE }
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const server = ClaudeRelay.server({ io, connection: async () => ({}), slot: registry.host })
  return { root, configDir, directory, hosts, server, registry }
})

// own-accounts' part, in memory: the host's account token and directory become the PC's folders; every byte the host
// receives is kept, and `drop` ends every stream as a lost SSH connection would.
function transport(place: Effect.Success<ReturnType<typeof pc>>) {
  const received: string[] = []
  const open: ClaudeRelay.Stream[] = []
  const relay: ClaudeRelay.Transport = {
    open: async (input, signal) => {
      expect(ClaudeRelay.accountOf(input.configDir)).toBe(ACCOUNT)
      const placement = { configDir: place.configDir, directory: place.directory }
      const stream =
        input.kind === "process"
          ? await place.server.open({ ...placement, member: input.member ?? { side: true } }, signal)
          : ClaudeRelay.callStream(place.server, { ...placement, root: path.join(place.hosts, "h1") }, input.op!)
      open.push(stream)
      return {
        ...stream,
        onData: (listener: (data: string) => void) =>
          stream.onData((data: string) => {
            received.push(data)
            listener(data)
          }),
      }
    },
  }
  return { relay, received, drop: () => open.splice(0).forEach((stream) => stream.close()) }
}

const host = Effect.fn(function* (relay: ClaudeRelay.Transport, saved = storage()) {
  const io = ClaudeRelay.io(relay)
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const connection = { CLAUDE_CONFIG_DIR: ClaudeRelay.token(ACCOUNT) }
  const status = yield* ClaudeStatus.make(
    io,
    () => Effect.succeed(connection),
    () => Effect.succeed([]),
    registry.side,
  )
  const sessions = yield* registry.attach({ io, status, storage: saved, directory: HOST_DIRECTORY })
  const context = yield* Effect.context<never>()
  const model = new ClaudeAgentLanguageModel.Model(
    "sonnet",
    { run: (request, signal) => Effect.runPromiseWith(context)(sessions.run(request), { signal }) },
    ClaudeQueryOptions.connectionEnv({ settings: { configDir: connection.CLAUDE_CONFIG_DIR } }),
  )
  return { registry, sessions, model, status, saved }
})

const ask = (model: ClaudeAgentLanguageModel.Model, prompt: LanguageModelV3Prompt, sessionID = "ses_host_a") =>
  Effect.promise(async () => {
    const result = await model.doStream({
      prompt,
      tools: [LOOKUP],
      headers: { [RequestKind.HEADER]: "primary", [RequestKind.SESSION_HEADER]: sessionID },
    })
    return TestSessions.collect(result.stream)
  })

const system: LanguageModelV3Prompt[number] = { role: "system", content: "You are a concise test assistant." }
const user = (text: string): LanguageModelV3Prompt[number] => ({ role: "user", content: [{ type: "text", text }] })

function runs(configDir: string) {
  const file = path.join(configDir, "fake-claude-runs.jsonl")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string; env: string[]; anthropicConfigDir: string | null })
}

// These tests start the fake CLI as real `bun` processes (about 0.5–1.5 s each on Windows, more under load or a virus
// scan of the new temp folder), so they take 1–3.5 s; bun's 5 s default timed out under load, and the leftover claude
// it then killed failed the next test (PE-8). They wait for what they check instead of sleeping a fixed time.
const LIVE = { timeout: 30_000 }

const settled = (check: () => boolean) =>
  Effect.promise(async () => {
    const end = Date.now() + 15_000
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out")
      await Bun.sleep(10)
    }
  })

describe("a host's conversation on the PC's claude (P-052)", () => {
  it.live("a tool turn runs the tool on the host's side, claude in the PC's folders, the login never leaves", () =>
    Effect.gen(function* () {
      const place = yield* pc()
      const link = transport(place)
      const test = yield* host(link.relay)
      const call = "TOOL lookup " + JSON.stringify({ key: "a" })
      const first = yield* ask(test.model, [system, user(call)])
      const toolCall = first.find((part) => part.type === "tool-call")
      expect(toolCall).toMatchObject({ toolName: "lookup" })
      // The host's OpenCode runs the tool and sends its result with the next request; the PC's claude takes it.
      const second = yield* ask(test.model, [
        system,
        user(call),
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: (toolCall as any).toolCallId, toolName: "lookup", input: { key: "a" } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: (toolCall as any).toolCallId,
              toolName: "lookup",
              output: { type: "text", value: "LILAC-HERON" },
            },
          ],
        },
      ])
      expect(TestSessions.text(second)).toBe("DONE LILAC-HERON")
      const started = runs(place.configDir)
      expect(started).toHaveLength(1)
      // claude ran in the PC's working folder for the host directory, with the allow-list environment only.
      expect(path.resolve(started[0]!.cwd)).toBe(path.resolve(place.directory))
      const allowed = new Set([
        ...Object.keys(ClaudeIO.allowed(process.env)),
        ...Object.keys(ClaudeQueryOptions.base({ executable: FAKE, io: ClaudeIO.local, connection: { CLAUDE_CONFIG_DIR: "x" } }).env ?? {}),
        ...ClaudeRelay.HOST_ENV,
        // The fake CLI is a script: it runs on Bun.
        "BUN_BE_BUN",
      ].map((name) => name.toUpperCase()))
      expect(started[0]!.env.filter((name) => !allowed.has(name.toUpperCase()))).toEqual([])
      // The PC names the placement folder's own Anthropic profile directory itself (the host sends no such variable).
      expect(started[0]!.anthropicConfigDir).toBe(path.join(place.configDir, "anthropic"))
      // The host got claude's stream, never the login's e-mail, organization or token.
      const seen = link.received.join("")
      expect(seen).toContain("DONE LILAC-HERON")
      expect(seen).not.toContain(SECRET_EMAIL)
      expect(seen).not.toContain("Fake Org")
      expect(seen).not.toContain("sk-ant-oat01-PCONLY")
      // The conversation's transcript is in the PC's shared folder, under the host's working folder.
      const record = (yield* SessionRecord.make(test.saved).get("ses_host_a"))!
      const file = path.join(place.configDir, "projects", FolderStore.projectKey(place.directory), `${record.claudeSessionID}.jsonl`)
      expect(fs.existsSync(file)).toBe(true)
    }),
    LIVE,
  )

  it.live("after the link drops, the next turn resumes the same Claude conversation (native transcript)", () =>
    Effect.gen(function* () {
      const place = yield* pc()
      const link = transport(place)
      const test = yield* host(link.relay)
      expect(TestSessions.text(yield* ask(test.model, [system, user("one")]))).toBe("ECHO one")
      const record = (yield* SessionRecord.make(test.saved).get("ses_host_a"))!
      yield* settled(() => ClaudeObserver.pool()?.live === 1)
      link.drop()
      // The PC's claude is gone and its slot back before the next turn starts a new one.
      yield* settled(() => ClaudeObserver.pool()?.live === 0)
      const reply = yield* ask(test.model, [
        system,
        user("one"),
        { role: "assistant", content: [{ type: "text", text: "ECHO one" }] },
        user("two"),
      ])
      expect(TestSessions.text(reply)).toBe("ECHO two")
      const started = runs(place.configDir)
      expect(started).toHaveLength(2)
      expect(started[1]!.args).toContain(`--resume=${record.claudeSessionID}`)
    }),
    LIVE,
  )

  it.live("the PC's pool counts the host's process: with the cap taken, the host's start waits for a slot", () =>
    Effect.gen(function* () {
      const place = yield* pc()
      ClaudeObserver.configure({ processes: 1 })
      // Something else on the PC holds the only slot and is busy.
      const held = yield* Effect.promise(() =>
        place.registry.host({ sessionID: "ses_pc_busy", side: false }, { busy: () => true, stuck: () => undefined, close: async () => {} }),
      )
      const link = transport(place)
      const test = yield* host(link.relay)
      const turn = yield* Effect.forkChild(ask(test.model, [system, user("waiting")], "ses_host_wait"))
      yield* settled(() => ClaudeObserver.pool()?.waiting.some((item) => item.sessionID === "ses_host_wait") === true)
      expect(runs(place.configDir)).toHaveLength(0)
      held.release()
      const reply = yield* Fiber.join(turn)
      expect(TestSessions.text(reply)).toBe("ECHO waiting")
      expect(ClaudeObserver.pool()?.live).toBe(1)
    }),
    LIVE,
  )

  it.live("the host's status check and models come from the PC's claude (side call, scrubbed account)", () =>
    Effect.gen(function* () {
      const place = yield* pc()
      const link = transport(place)
      const test = yield* host(link.relay)
      yield* test.status.refresh()
      const state = yield* SubscriptionRef.get(test.status.state)
      expect(state.type).toBe("ready")
      if (state.type !== "ready") return
      expect(state.probe.models.map((model) => model.value)).toEqual(["sonnet", "haiku"])
      expect(state.probe.version).toBe("2.1.301")
      expect(JSON.stringify(state.probe.account)).not.toContain(SECRET_EMAIL)
      expect(runs(place.configDir)[0]!.args).toContain("--no-session-persistence")
    }),
    LIVE,
  )
})
// OWN-PATCH(P-052) end
