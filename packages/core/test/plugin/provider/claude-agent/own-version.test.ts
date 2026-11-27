// OWN-PATCH(P-051) begin
// own's Claude Code version check (decisions CAG-49): a Claude Code that leaves `claude_code_version` out of its
// initialize reply (2.1.282, the native install's version on the user's PC) is read through `claude --version`; when
// that does not answer either, the check is skipped and the chat runs. Only a version known to be too old blocks.
import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, SubscriptionRef } from "effect"
import { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { ClaudeProbe } from "@opencode/core/plugin/provider/claude-agent/claude/probe"
import { ClaudeQueryOptions } from "@opencode/core/plugin/provider/claude-agent/claude/query-options"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { ClaudeStatus } from "@opencode/core/plugin/provider/claude-agent/claude/status"
import { ClaudeIntegration } from "@opencode/core/plugin/provider/claude-agent/integration"
import { ClaudeProvider } from "@opencode/core/plugin/provider/claude-agent/provider"
import { ID, make } from "@opencode/core/plugin/provider/claude-agent/index"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { KV } from "@opencode/core/kv"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { it, testEffect } from "../../../lib/effect"
import { PluginTestLayer } from "../../fixture"
import { FakeClaude } from "./lib/fake-claude"
import { FakeIO } from "./lib/fake-io"
import { TestSessions } from "./lib/sessions"

const first = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")

// A startup whose initialize reply has no version, as Claude Code 2.1.282 sends it.
function unversioned() {
  const startup = FakeClaude.expectStartup()
  delete startup.reply.claude_code_version
  return startup
}

function io(claude: FakeClaude.Fake, version?: string) {
  const asked: string[] = []
  const value: ClaudeIO.Interface = {
    ...FakeIO.make({ claude }),
    version: version === undefined ? undefined : async (executable) => (asked.push(executable), version),
  }
  return { io: value, asked }
}

const chat = Effect.fn(function* (claude: FakeClaude.Fake, value: ClaudeIO.Interface) {
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const status = yield* ClaudeStatus.make(value, () => Effect.succeed({}))
  const sessions = yield* registry.attach({
    io: value,
    status,
    storage: TestSessions.storage(),
    directory: "/tmp/opencode",
  })
  return { status, model: yield* TestSessions.model(sessions) }
})

describe("P-051: Claude Code's version", () => {
  test("only a version known to be too old is an error, and its text is own's", () => {
    expect(ClaudeProbe.versionError("2.1.248")).toBeUndefined()
    expect(ClaudeProbe.versionError("2.1.282")).toBeUndefined()
    expect(ClaudeProbe.versionError(undefined)).toBeUndefined()
    const error = ClaudeProbe.versionError("2.1.247")?.message
    expect(error).toContain("2.1.248 이상")
    expect(error).toContain("오래돼서")
  })

  it.effect("the login check reads --version when the initialize reply has none, and then discovers windows", () =>
    Effect.gen(function* () {
      const steps = FakeClaude.replay("startup")
      const startup = steps[0]
      if (startup?.type !== "startup") throw new Error("Missing startup recording")
      delete startup.reply.claude_code_version
      const claude = FakeClaude.make(steps)
      const fake = io(claude, "2.1.282")
      const result = yield* ClaudeProbe.run(
        ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io: fake.io }),
        fake.io.version,
      )
      expect(result.version).toBe("2.1.282")
      expect(fake.asked).toEqual([FakeIO.EXECUTABLE])
      // 2.1.282 supports summary-only context usage (2.1.257 or later), so the windows are discovered.
      expect(result.models.find((model) => model.value === "opus")?.contextWindow).toBe(1_000_000)
      claude.check()
    }),
  )

  it.effect("the login check without any version stays ready and keeps the conservative windows", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([unversioned()])
      const fake = io(claude)
      const status = yield* ClaudeStatus.make(fake.io, () => Effect.succeed({}))
      yield* status.refresh()
      const state = yield* SubscriptionRef.get(status.state)
      expect(state.type).toBe("ready")
      if (state.type === "ready") expect(state.probe.version).toBeUndefined()
    }),
  )

  it.effect("a chat runs when Claude Code reports no version and --version does not answer (fail open)", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([unversioned(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()])
      const test = yield* chat(claude, io(claude).io)
      const parts = yield* TestSessions.reply(test.model, first)
      expect(TestSessions.text(parts)).toBe("COPPER-OTTER")
    }),
  )

  it.effect("a chat runs on a version read from --version, and records it", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([unversioned(), FakeClaude.expectTurn(), FakeClaude.expectInterrupt()])
      const fake = io(claude, "2.1.282")
      const test = yield* chat(claude, fake.io)
      const parts = yield* TestSessions.reply(test.model, first)
      expect(TestSessions.text(parts)).toBe("COPPER-OTTER")
      expect(fake.asked).toEqual([FakeIO.EXECUTABLE])
      const state = yield* SubscriptionRef.get(test.status.state)
      expect(state.type === "ready" ? state.probe.version : undefined).toBe("2.1.282")
    }),
  )

  it.effect("a chat stops before its prompt when --version names a version that is too old", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([unversioned()])
      const test = yield* chat(claude, io(claude, "2.1.200").io)
      const error = yield* TestSessions.reply(test.model, first).pipe(Effect.flip)
      expect(String(error.cause)).toContain("2.1.200 버전은 너무 오래돼서")
      expect(claude.runs[0]!.received.some((message) => message.type === "user")).toBe(false)
      yield* Effect.promise(() => claude.runs[0]!.closed)
    }),
  )

  // The real reader on the Agent SDK's bundled binary (no network, no login: `--version` only), when installed.
  const bundled = (() => {
    const store = path.resolve(import.meta.dir, "../../../../../../node_modules/.bun")
    const folder = fs.existsSync(store)
      ? fs.readdirSync(store).find((name) => name.startsWith("@anthropic-ai+claude-agent-sdk-win32-x64@"))
      : undefined
    const file = folder && path.join(store, folder, "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe")
    return file && fs.existsSync(file) ? file : undefined
  })()
  test.skipIf(!bundled)(
    "the real reader gets the bundled claude's version from --version, and a missing binary gives none",
    async () => {
      const env = ClaudeIO.allowed(process.env)
      const version = await ClaudeIO.real.version!(bundled!, env)
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
      expect(ClaudeProbe.versionError(version)).toBeUndefined()
      expect(await ClaudeIO.real.version!(path.join(path.dirname(bundled!), "missing-claude.exe"), env)).toBeUndefined()
    },
    30_000,
  )
})

// CAG-52: a model list saved by a check that skipped discovery (every window missing) gets its windows on the next start;
// a list where only some model has none (one the login cannot use) does not start a check.
describe("P-051: saved model lists without context windows", () => {
  const plugin = testEffect(PluginTestLayer)
  const start = Effect.fn(function* (
    saved: ReadonlyArray<{ id: string; contextWindow?: number }>,
    claude: FakeClaude.Fake,
    // OWN-PATCH(P-060) begin
    checked?: ReadonlyArray<string>,
    // OWN-PATCH(P-060) end
  ) {
    const store = PluginHost.storage(yield* KV.Service, ID)
    yield* store.set("models", {
      models: saved.map((model) => ({ ...model, name: model.id, efforts: [] })),
      // OWN-PATCH(P-060) begin
      ...(checked ? { checked } : {}),
      // OWN-PATCH(P-060) end
    })
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID: Integration.ID.make(ClaudeProvider.ID),
      value: Credential.External.make({
        type: "external",
        methodID: Integration.MethodID.make(ClaudeIntegration.METHOD_ID),
      }),
    })
    const registry = ClaudeSessions.registry()
    yield* Effect.addFinalizer(() => registry.close())
    const host = yield* PluginHost.make(yield* Plugin.Service, ID)
    yield* make(FakeIO.make({ claude }), registry).effect(host)
  })
  const window = Effect.fn(function* (id: string) {
    const models = yield* Model.Service
    return (yield* models.all()).find((model) => model.providerID === ClaudeProvider.ID && model.id === id)?.limit
      .context
  })

  plugin.live("a list with no window at all is checked again and gets Claude Code's windows", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make(FakeClaude.replay("startup"))
      yield* start([{ id: "opus" }, { id: "sonnet" }], claude)
      expect(yield* window("opus")).toBe(200_000)
      const deadline = Date.now() + 20_000
      while ((yield* window("opus")) !== 1_000_000 && Date.now() < deadline) yield* Effect.promise(() => Bun.sleep(20))
      expect(yield* window("opus")).toBe(1_000_000)
    }),
  )

  // OWN-PATCH(P-060) begin
  // A model a check already asked (`checked`) and could not read starts none; a list saved before `checked` is
  // checked once per process (own-models.test.ts).
  plugin.live("a list with some windows starts no check once a check asked every model", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([])
      yield* start([{ id: "opus", contextWindow: 1_000_000 }, { id: "fable" }], claude, ["opus", "fable"])
      // OWN-PATCH(P-060) end
      yield* Effect.promise(() => Bun.sleep(200))
      expect(claude.runs).toHaveLength(0)
      expect(yield* window("opus")).toBe(1_000_000)
    }),
  )
})
// OWN-PATCH(P-051) end
