// OWN-PATCH(P-045) begin
// own's Claude Agent route (own/docs/02-accounts-providers-cache.md §8.10): the account folder (P-045), the environment
// claude gets (P-042) and the plan limits handed to own's accounts plugin (P-039), on upstream's fake `claude`.
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, SubscriptionRef } from "effect"
import { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { ClaudeObserver } from "@opencode/core/plugin/provider/claude-agent/claude/observer"
import { ClaudeQueryOptions } from "@opencode/core/plugin/provider/claude-agent/claude/query-options"
import { ClaudeSessions } from "@opencode/core/plugin/provider/claude-agent/claude/sessions"
import { ClaudeStatus } from "@opencode/core/plugin/provider/claude-agent/claude/status"
import { ClaudeAgentLanguageModel } from "@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"
import { RequestKind } from "@opencode/core/plugin/provider/claude-agent/language-model/request-kind"
import { it } from "../../../lib/effect"
import { tmpdirScoped } from "../../../fixture/tmpdir"
import { FakeClaude } from "./lib/fake-claude"
import { FakeIO } from "./lib/fake-io"
import { TestSessions } from "./lib/sessions"

const first = TestSessions.prompt("Remember the marker COPPER-OTTER. Reply only with that marker.")

// The real IO's rules (allow-list environment, folder required) over the fake `claude`.
function ownIO(claude: FakeClaude.Fake, source: Record<string, string | undefined> = {}): ClaudeIO.Interface {
  return { ...FakeIO.make({ claude }), env: () => ClaudeIO.allowed(source), requiresFolder: true }
}

const routed = Effect.fn(function* (claude: FakeClaude.Fake, io: ClaudeIO.Interface, configDir: string) {
  const registry = ClaudeSessions.registry()
  yield* Effect.addFinalizer(() => registry.close())
  const status = yield* ClaudeStatus.make(io, () => Effect.succeed({ CLAUDE_CONFIG_DIR: configDir }))
  const sessions = yield* registry.attach({ io, status, storage: TestSessions.storage(), directory: "/tmp/opencode" })
  const context = yield* Effect.context<never>()
  const model = new ClaudeAgentLanguageModel.Model(
    "haiku",
    { run: (request, signal) => Effect.runPromiseWith(context)(sessions.run(request), { signal }) },
    ClaudeQueryOptions.connectionEnv({ settings: { configDir } }),
  )
  return { sessions, status, model }
})

function observe() {
  const seen: ClaudeObserver.Observation[] = []
  const listener = (observation: ClaudeObserver.Observation) => {
    seen.push(observation)
  }
  ClaudeObserver.channel().listeners.add(listener)
  return { seen, stop: () => ClaudeObserver.channel().listeners.delete(listener) }
}

describe("own's Claude Agent route", () => {
  it.effect("P-042: claude gets an allow-list of the service environment", () =>
    Effect.sync(() => {
      const env = ClaudeIO.allowed({
        PATH: "C:/bin",
        SystemRoot: "C:/Windows",
        USERPROFILE: "C:/t/home",
        CLAUDE_CODE_USER_EMAIL: "someone@example.com",
        CLAUDE_CODE_ACCOUNT_UUID: "uuid",
        CLAUDE_CODE_SESSION_ID: "outer",
        CLAUDECODE: "1",
        CLAUDE_CONFIG_DIR: "C:/other/route",
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        OPENCODE_SERVER_PASSWORD: "secret",
        USERNAME: "someone",
        COMPUTERNAME: "PC",
        USERDOMAIN: "PC",
      })
      expect(env).toEqual({
        PATH: "C:/bin",
        SystemRoot: "C:/Windows",
        USERPROFILE: "C:/t/home",
        USERNAME: "",
        USERDOMAIN: "",
        LOGONSERVER: "",
        COMPUTERNAME: "",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DO_NOT_TRACK: "1",
        DISABLE_GROWTHBOOK: "1",
        DISABLE_BUG_COMMAND: "1",
        CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      })
      // An inherited opt-in never reaches claude (decisions TLM).
      const opted = ClaudeIO.allowed({ PATH: "C:/bin", CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "x" })
      expect(Object.keys(opted).some((name) => name.startsWith("OTEL_") || name === "CLAUDE_CODE_ENABLE_TELEMETRY")).toBe(false)
    }),
  )

  it.effect("P-045: the real binary runs only with the account folder the provider settings name", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([])
      const io = ownIO(claude, { PATH: "C:/bin", CLAUDE_CONFIG_DIR: "C:/other/route" })
      expect(() => ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io })).toThrow("no account folder")
      const connection = ClaudeQueryOptions.connectionEnv({ settings: { configDir: "C:/own/claude-agent/a" } })
      expect(connection).toEqual({ CLAUDE_CONFIG_DIR: "C:/own/claude-agent/a" })
      const options = ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io, connection })
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe("C:/own/claude-agent/a")
      expect(options.env?.ANTHROPIC_CONFIG_DIR).toBe(path.join("C:/own/claude-agent/a", "anthropic"))
      expect(options.env?.PATH).toBe("C:/bin")

      // Without a folder the login check starts no claude, so it never refreshes another login. P-052: before any
      // folder is named it waits (`checking`, own-accounts' fold may come later); once a check ran, a folder that went
      // away fails it.
      const status = yield* ClaudeStatus.make(io, () => Effect.succeed({}))
      yield* status.refresh()
      expect((yield* SubscriptionRef.get(status.state)).type).toBe("checking")
      yield* status.report({ type: "missing" })
      yield* status.refresh()
      expect((yield* SubscriptionRef.get(status.state)).type).toBe("failed")
      expect(claude.runs).toHaveLength(0)
    }),
  )

  it.effect("P-045 and P-042: a chat's claude runs in the account folder with no outer Claude identity", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectInterrupt(),
      ])
      const io = ownIO(claude, { PATH: "C:/bin", CLAUDE_CODE_USER_EMAIL: "someone@example.com", USERNAME: "someone" })
      const test = yield* routed(claude, io, "C:/own/claude-agent/a")
      const parts = yield* TestSessions.reply(test.model, first)
      expect(TestSessions.text(parts)).toBe("COPPER-OTTER")
      const env = claude.runs[0]!.env
      expect(env.CLAUDE_CONFIG_DIR).toBe("C:/own/claude-agent/a")
      expect(env.ANTHROPIC_CONFIG_DIR).toBe(path.join("C:/own/claude-agent/a", "anthropic"))
      expect(Object.keys(env).filter((name) => /EMAIL|ACCOUNT_UUID|^CLAUDECODE$/i.test(name))).toEqual([])
      expect([env.USERNAME, env.USERDOMAIN, env.LOGONSERVER, env.COMPUTERNAME]).toEqual(["", "", "", ""])
    }),
  )

  it.effect("P-045: no claude falls back to the PC's Anthropic profile; each start names its folder's own", () =>
    Effect.gen(function* () {
      const folder = "C:/own/claude-agent/a"
      const profile = path.join(folder, "anthropic")
      const claude = FakeClaude.make([FakeClaude.expectStartup()])
      // The service's own profile directory never reaches claude, and a connection cannot name another one.
      const io = ownIO(claude, { PATH: "C:/bin", ANTHROPIC_CONFIG_DIR: "C:/Users/someone/AppData/Roaming/Anthropic" })
      const options = ClaudeQueryOptions.base({
        executable: FakeIO.EXECUTABLE,
        io,
        connection: { CLAUDE_CONFIG_DIR: folder, ANTHROPIC_CONFIG_DIR: "C:/elsewhere" },
      })
      expect(options.env?.ANTHROPIC_CONFIG_DIR).toBe(profile)
      // An IO without an account folder (upstream's) sets none: an empty value would read as unset.
      expect(ClaudeQueryOptions.base({ executable: FakeIO.EXECUTABLE, io: FakeIO.make({ claude }) }).env).not.toHaveProperty(
        "ANTHROPIC_CONFIG_DIR",
      )
      // The login check's claude (its usage reads build the same options).
      const status = yield* ClaudeStatus.make(io, () => Effect.succeed({ CLAUDE_CONFIG_DIR: folder }))
      yield* status.refresh()
      expect((yield* SubscriptionRef.get(status.state)).type).toBe("ready")
      expect(claude.runs[0]!.env.ANTHROPIC_CONFIG_DIR).toBe(profile)
      claude.check()
    }),
  )

  it.effect("P-045: transcript checks, forks and removals use the account folder's transcripts", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped("own-claude-agent-")).path
      const configDir = path.join(root, "config")
      const directory = path.join(root, "work")
      const sessionId = crypto.randomUUID()
      const user = crypto.randomUUID()
      const assistant = crypto.randomUUID()
      const entry = (type: "user" | "assistant", uuid: string, parentUuid: string | null, message: object) => ({
        type,
        uuid,
        parentUuid,
        isSidechain: false,
        userType: "external",
        entrypoint: "sdk-ts",
        cwd: directory,
        sessionId,
        version: "2.1.301",
        timestamp: new Date().toISOString(),
        message,
      })
      // Claude Code's layout: projects/<the directory with every other character a dash>/<session>.jsonl
      const project = path.join(configDir, "projects", directory.replace(/[^a-zA-Z0-9]/g, "-"))
      yield* Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        await fs.writeFile(
          path.join(project, `${sessionId}.jsonl`),
          [
            entry("user", user, null, { role: "user", content: [{ type: "text", text: "Remember LILAC-HERON." }] }),
            entry("assistant", assistant, user, {
              role: "assistant",
              type: "message",
              id: "msg_1",
              model: "claude-haiku",
              content: [{ type: "text", text: "LILAC-HERON" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ]
            .map((line) => JSON.stringify(line))
            .join("\n") + "\n",
        )
      })
      const folder = { configDir, directory }
      // own-accounts names the shared transcript folder (CAG-34); the account folder's own projects stands in for it.
      ClaudeObserver.share(path.join(configDir, "projects"))
      yield* Effect.addFinalizer(() => Effect.sync(() => ClaudeObserver.share(undefined)))
      expect(yield* Effect.promise(() => ClaudeIO.real.sessionExists(sessionId, folder))).toBe(true)
      expect(yield* Effect.promise(() => ClaudeIO.real.sessionExists(crypto.randomUUID(), folder))).toBe(false)

      const fork = yield* Effect.promise(() => ClaudeIO.real.fork(sessionId, assistant, folder))
      expect(fork).toBeDefined()
      expect(fork!.messages.size).toBe(2)
      // The fork lands where `claude --resume` reads it: next to its source.
      const forked = path.join(project, `${fork!.sessionID}.jsonl`)
      expect(yield* Effect.promise(() => fs.stat(forked).then(() => true))).toBe(true)

      yield* Effect.promise(() => ClaudeIO.real.remove(fork!.sessionID, folder))
      expect(
        yield* Effect.promise(() =>
          fs.stat(forked).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect(yield* Effect.promise(() => fs.stat(path.join(project, `${sessionId}.jsonl`)).then(() => true))).toBe(true)
    }),
  )

  it.effect("P-045: the conversation's account folder comes per request, and another folder resumes its transcript", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        FakeClaude.expectInterrupt(),
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn({ recording: "text-resume" }),
        FakeClaude.expectInterrupt(),
      ])
      // The provider settings name account A (the default); the conversation's tree is bound to B, then moved to C.
      const test = yield* routed(claude, ownIO(claude), "C:/own/claude-agent/accounts/a")
      const ask = (prompt: typeof first, configDir: string) =>
        Effect.promise(() =>
          test.model.doStream({
            prompt,
            providerOptions: { "claude-agent": { configDir } },
            headers: { [RequestKind.HEADER]: "primary", [RequestKind.SESSION_HEADER]: "session-switch" },
          }),
        ).pipe(Effect.flatMap((result) => Effect.promise(() => TestSessions.collect(result.stream))))
      expect(TestSessions.text(yield* ask(first, "C:/own/claude-agent/accounts/b"))).toBe("COPPER-OTTER")
      expect(TestSessions.text(yield* ask(TestSessions.followup(), "C:/own/claude-agent/accounts/c"))).toBe(
        "COPPER-OTTER",
      )
      expect(claude.runs.map((run) => run.env.CLAUDE_CONFIG_DIR)).toEqual([
        "C:/own/claude-agent/accounts/b",
        "C:/own/claude-agent/accounts/c",
      ])
      const id = claude.runs[0]!.args.find((arg) => arg.startsWith("--session-id="))!.split("=")[1]
      expect(claude.runs[1]!.args).toContain(`--resume=${id}`)
    }),
  )

  it.effect("P-045: transcript checks, forks and removals without an account folder fail closed", () =>
    Effect.gen(function* () {
      const id = crypto.randomUUID()
      const refused = (run: () => Promise<unknown>) =>
        Effect.promise(() =>
          run().then(
            () => "ran",
            (error: Error) => error.message,
          ),
        )
      expect(yield* refused(() => ClaudeIO.real.sessionExists(id))).toContain("no account folder")
      expect(yield* refused(() => ClaudeIO.real.fork(id, crypto.randomUUID()))).toContain("no account folder")
      expect(yield* refused(() => ClaudeIO.real.remove(id))).toContain("no account folder")
    }),
  )

  it.effect("P-039: plan limits and the login reach own's listener with the account folder and session", () =>
    Effect.gen(function* () {
      const claude = FakeClaude.make([
        FakeClaude.expectStartup({
          account: { email: "someone@example.com", organization: "Org", subscriptionType: "max", tokenSource: "oauth" },
        }),
        FakeClaude.expectTurn(),
        FakeClaude.expectInterrupt(),
      ])
      const watch = observe()
      yield* Effect.addFinalizer(() => Effect.sync(() => watch.stop()))
      const test = yield* routed(claude, ownIO(claude), "C:/own/claude-agent/a")
      yield* TestSessions.reply(test.model, first, "session-limits")
      const limits = watch.seen.filter((observation) => observation.rateLimit)
      expect(limits.length).toBeGreaterThan(0)
      expect(limits[0]!.configDir).toBe("C:/own/claude-agent/a")
      expect(limits[0]!.sessionID).toBe("session-limits")
      expect(limits[0]!.rateLimit!.rateLimitType).toBe("five_hour")
      const accounts = watch.seen.filter((observation) => observation.account)
      expect(accounts).toHaveLength(1)
      expect(accounts[0]!.configDir).toBe("C:/own/claude-agent/a")
      // The plan only: the login's e-mail and organization never leave the provider.
      expect(accounts[0]!.account).toEqual({ subscriptionType: "max", tokenSource: "oauth" })
    }),
  )

  it.effect("P-039: a usage question goes to the live process of that folder", () =>
    Effect.gen(function* () {
      const answer = {
        session: {
          total_cost_usd: 0,
          total_api_duration_ms: 0,
          total_duration_ms: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
          model_usage: {},
        },
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-11-01T05:00:00.000Z" },
          seven_day: { utilization: 13, resets_at: "2026-11-05T00:00:00.000Z" },
        },
      }
      const usage: FakeClaude.Step = {
        type: "exchange",
        input: { type: "control_request", request_id: "usage-1", request: { subtype: "get_usage" } },
        replies: [
          { type: "control_response", response: { subtype: "success", request_id: "usage-1", response: answer } },
        ],
        started: Promise.withResolvers<void>(),
        done: Promise.withResolvers<void>(),
      }
      const claude = FakeClaude.make([
        FakeClaude.expectStartup(),
        FakeClaude.expectTurn(),
        usage,
        FakeClaude.expectInterrupt(),
      ])
      const watch = observe()
      yield* Effect.addFinalizer(() => Effect.sync(() => watch.stop()))
      const test = yield* routed(claude, ownIO(claude), "C:/own/claude-agent/a")
      yield* TestSessions.reply(test.model, first)
      const got = yield* test.sessions.usage({ CLAUDE_CONFIG_DIR: "C:/own/claude-agent/a" })
      expect(got.rate_limits?.five_hour?.utilization).toBe(42)
      expect(claude.runs).toHaveLength(1)
      expect(watch.seen.find((observation) => observation.usage)?.configDir).toBe("C:/own/claude-agent/a")
      yield* Effect.promise(() => claude.reached(usage))
    }),
  )

  it.effect("P-039: usage stays served while any Location's provider is open, not only the last one opened", () =>
    Effect.gen(function* () {
      const answer = (label: string) => async () => ({ subscription_type: label }) as never
      const control = ClaudeObserver.serve(answer("control"))
      const project = ClaudeObserver.serve(answer("project"))
      const ask = () => Effect.promise(() => ClaudeObserver.channel().usage!("C:/own/claude-agent/a"))
      expect((yield* ask()).subscription_type).toBe("project")
      // A project Location closes while the control Location stays: 한도 새로 읽기 still has a provider to ask.
      project()
      expect((yield* ask()).subscription_type).toBe("control")
      control()
      expect(ClaudeObserver.channel().usage).toBeUndefined()
    }),
  )
})
// OWN-PATCH(P-045) end
