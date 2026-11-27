import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { OwnAccounts } from "@own/protocol"
import { Clock } from "../src/clock.js"
import { Emitter } from "../src/emitter.js"
import { Events } from "../src/events.js"
import { Endpoints } from "../src/endpoints.js"
import { Guard } from "../src/health/guard.js"
import { Logger } from "../src/logger.js"
import { logLeaks } from "./e2e-kit"
import type { Module } from "../src/module.js"
import { Modules } from "../src/modules.js"
import { Nonces } from "../src/nonces.js"
import { Options } from "../src/options.js"
import { AccountsRpc } from "../src/rpc/accounts.js"
import { ClaudeRpc } from "../src/rpc/claude.js"
import { ClaudeAgentRpc } from "../src/rpc/claude-agent.js"
import { CodexModelsRpc } from "../src/rpc/codex-models.js"
import { ConversationFolderRpc } from "../src/rpc/conversation-folder.js"
import { SideRpc } from "../src/rpc/side.js"
import { DiagnosticsRpc } from "../src/rpc/diagnostics.js"
import { EstimateRpc } from "../src/rpc/estimate.js"
import { HealthRpc } from "../src/rpc/health.js"
import { LimitResetRpc } from "../src/rpc/limit-reset.js"
import { LoginsRpc } from "../src/rpc/logins.js"
import { McpRpc } from "../src/rpc/mcp.js"
import { IdeasRpc } from "../src/rpc/ideas.js"
import { ImageRpc } from "../src/rpc/image.js"
import { BrowseRpc } from "../src/rpc/browse.js"
import { NotesRpc } from "../src/rpc/notes.js"
import { PluginsRpc } from "../src/rpc/plugins.js"
import { PresetsRpc } from "../src/rpc/presets.js"
import { ProjectListRpc } from "../src/rpc/project-list.js"
import { ProtectedPathsRpc } from "../src/rpc/protected-paths.js"
import { Register } from "../src/rpc/register.js"
import { SearchKeyRpc } from "../src/rpc/search-key.js"
import { SessionPresetRpc } from "../src/rpc/session-preset.js"
import { SkillsetRpc } from "../src/rpc/skillset.js"
import { SwitchRpc } from "../src/rpc/switch.js"
import type { RpcTypes } from "../src/rpc/types.js"
import { SpeedRpc } from "../src/rpc/speed.js"
import { UsageRpc } from "../src/rpc/usage.js"
import { VoiceRpc } from "../src/rpc/voice.js"
import { GitHubRpc } from "../src/rpc/github.js"
import { ToolUpdatesRpc } from "../src/rpc/tool-updates.js"
import { WebSearchRpc } from "../src/rpc/websearch.js"
import { WorktreeRpc } from "../src/rpc/worktree.js"
import { testDeps } from "./support/deps.js"

describe("RPC wiring", () => {
  test("every protocol method has exactly one group and a handler", async () => {
    await using test = await testDeps()
    const modules = test.modules()
    const groups = [
      ...[
        HealthRpc,
        DiagnosticsRpc,
        AccountsRpc,
        LoginsRpc,
        SwitchRpc,
        EstimateRpc,
        UsageRpc,
        LimitResetRpc,
        PluginsRpc,
        PresetsRpc,
        SessionPresetRpc,
        SpeedRpc,
        ClaudeAgentRpc,
      ].map((group) => Object.keys(group.handlers(modules))),
      Object.keys(WorktreeRpc.handlers(test.deps)),
      Object.keys(NotesRpc.handlers(test.deps)),
      Object.keys(IdeasRpc.handlers(test.deps)),
      Object.keys(VoiceRpc.handlers(test.deps)),
      Object.keys(ClaudeRpc.handlers(modules, test.deps)),
      Object.keys(WebSearchRpc.handlers(test.deps)),
      // 02 §9.6 (IM): image.get and image.clear.
      Object.keys(ImageRpc.handlers(modules, test.deps)),
      // BRW: browse.status and browse.set.
      Object.keys(BrowseRpc.handlers(test.deps)),
      Object.keys(SearchKeyRpc.handlers(test.deps)),
      Object.keys(ConversationFolderRpc.handlers(test.deps)),
      // 03 §4.3: projectList.get and projectList.set.
      Object.keys(ProjectListRpc.handlers(test.deps)),
      // 02 §9.7 곁질문: side.ask, side.get, side.list, side.cancel and side.remove.
      Object.keys(SideRpc.handlers(modules)),
      // 01 §13 (PP): the five protectedPaths.* methods.
      Object.keys(ProtectedPathsRpc.handlers(modules, test.deps)),
      Object.keys(CodexModelsRpc.handlers(modules)),
      Object.keys(McpRpc.handlers(test.deps)),
      Object.keys(SkillsetRpc.handlers(test.deps)),
      Object.keys(GitHubRpc.handlers(test.deps)),
      Object.keys(ToolUpdatesRpc.handlers(test.deps)),
    ]
    const methods = Object.keys(OwnAccounts.Definition.methods).sort()
    expect(groups.flat().sort()).toEqual(methods)
    expect(new Set(groups.flat()).size).toBe(methods.length)
    expect(Object.keys(Register.handlers(modules, test.deps)).sort()).toEqual(methods)
    // 02 §9.2 notes add notes.list, notes.get, notes.put and notes.remove; 02 §3.9 adds voice.get, voice.set,
    // voice.key.set and voice.transcribe; 04 §8.11.12 adds plugin.claudeAuth.remote.{ack,set} and
    // plugin.claudeAuth.fastAck; 03 §18.2 adds websearch.get and websearch.set; 02 §8.7 (2026-10-10) adds the patch,
    // Claude account and Claude session methods; speed.offers (07, composer speed); 03 §5.1 adds
    // conversationFolder.get, conversationFolder.set and conversationFolder.ensure; 03 §18.3 adds folderPicker.get and
    // folderPicker.set; 07 §4.5 (CA) adds codexModels.get and codexModels.set; 02 §9.2 (SP) adds websearch.key.get and
    // websearch.key.set; 02 §4.7.7 (CC-14) adds session.presence; 03 §18.14 (SM) adds the nine mcp.* methods; 02 §7.1.1
    // (RP) adds quota.resetCredits.list, quota.resetCredits.redeem.plan and quota.resetCredits.redeem.execute; 03
    // §19.6.1 (SG) adds skillset.view and skillset.switch; 02 §8.10 (CAG) adds the five claudeAgent.* methods, and its
    // phase 2 claudeAgent.session.get, session.set, default.set, folders.list and folders.assign; 16 (GH) adds the ten
    // github.* methods; 02 §3.3a (LMT) adds accounts.local.detect; 02 §9.6 (IM) image.get and image.clear; 05 §20 (UPD)
    // the five tools.* methods; 01 §13 (PP) the five protectedPaths.* methods; BRW browse.status and browse.set; 03 §18.3
    // (SN) folderPicker.list and folderPicker.create; 10 §6.14 codexModels.rows; 02 §9.7 the five side.* methods;
    // 03 §4.3 projectList.get and projectList.set.
    // 04 §13.1 (MH): mcp.host.{view,probe,save,remove,test,prefetch} and mcp.hosts.{send,unsend,view}.
    expect(methods).toHaveLength(176)
  })

  test("the degraded definition exposes only health", () => {
    expect(Object.keys(Register.HealthOnly.methods)).toEqual(["health"])
    expect(Register.HealthOnly.id).toBe(OwnAccounts.ID)
  })
})

describe("Modules", () => {
  test("start runs in order, stop in reverse, and peers resolve lazily", async () => {
    await using test = await testDeps()
    const calls: string[] = []
    const traced =
      <K extends Modules.Name>(name: K) =>
      (deps: Parameters<Modules.Factories[K]>[0], peers: Parameters<Modules.Factories[K]>[1]) => {
        const real = Modules.FACTORIES[name](deps, peers)
        return {
          ...real,
          start: async () => {
            calls.push(`start:${name}`)
            expect(peers().slots).toBeDefined()
          },
          stop: async () => {
            calls.push(`stop:${name}`)
          },
        }
      }
    const modules = test.modules(
      Object.fromEntries(Modules.ORDER.map((name) => [name, traced(name)])) as Partial<Modules.Factories>,
    )
    await Modules.start(modules, Logger.silent)
    await Modules.stop(modules, Logger.silent)
    expect(calls).toEqual([
      ...Modules.ORDER.map((name) => `start:${name}`),
      ...[...Modules.ORDER].reverse().map((name) => `stop:${name}`),
    ])
  })

  test("a failing start stops the modules already started and rethrows", async () => {
    await using test = await testDeps()
    const calls: string[] = []
    const modules = test.modules({
      logins: (deps, peers) => ({
        ...Modules.FACTORIES.logins(deps, peers),
        start: async () => {
          throw new Error("boom")
        },
      }),
      slots: (deps, peers) => ({
        ...Modules.FACTORIES.slots(deps, peers),
        stop: async () => {
          calls.push("stop:slots")
        },
      }),
    })
    await expect(Modules.start(modules, Logger.silent)).rejects.toThrow("boom")
    expect(calls).toEqual(["stop:slots"])
  })
})

describe("Guard 1", () => {
  test("fails closed on version skew or a missing env marker", () => {
    expect(Guard.check({ appVersion: "2.0.18", env: { OWN_OPEN_CODE: "1" }, expectedVersion: "2.0.18" })).toEqual({
      guard: "ok",
    })
    expect(Guard.check({ appVersion: "2.0.19", env: { OWN_OPEN_CODE: "1" }, expectedVersion: "2.0.18" }).guard).toBe(
      "skew",
    )
    expect(Guard.check({ appVersion: "2.0.18", env: {}, expectedVersion: "2.0.18" }).guard).toBe("unmanaged")
    // Unbundled source: the server reports "local" and so does the build.
    expect(Guard.check({ appVersion: "local", env: { OWN_OPEN_CODE: "1" } }).guard).toBe("ok")
  })
})

describe("Options and endpoints", () => {
  test("options decode strictly and endpoints fall back to production", () => {
    expect(() => Options.decode({ vault: "plaintext" })).toThrow()
    const options = Options.decode({ vault: "memory", endpoints: { codex: "http://127.0.0.1:1/backend-api/codex" } })
    const endpoints = Endpoints.resolve(options.endpoints)
    expect(endpoints.url.codex).toBe("http://127.0.0.1:1/backend-api/codex")
    expect(endpoints.url.anthropic).toBe(Endpoints.DEFAULTS.anthropic)
    expect(endpoints.overrides).toEqual({ codex: "http://127.0.0.1:1/backend-api/codex" })
    expect(Endpoints.resolve(undefined).overrides).toEqual({})
  })
})

describe("Emitter", () => {
  test("adds the envelope, applies the leader rule, and drops while unbound", async () => {
    const sent: unknown[][] = []
    const registration = {
      dispose: async () => {},
      events: {
        emit: async (...args: unknown[]) => {
          sent.push(args)
        },
      },
    }
    const leader = { value: false }
    const emitter = new Emitter.Publisher({ isLeader: () => leader.value, log: Logger.silent })
    expect(await emitter.session("switch.state", sample())).toBe(false)
    // SAFETY: the fake implements the only member the emitter uses, `events.emit`.
    emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
    expect(await emitter.global("accounts.changed", { revision: 3 })).toBe(false)
    leader.value = true
    expect(await emitter.global("accounts.changed", { revision: 3 })).toBe(true)
    expect(await emitter.session("switch.state", sample())).toBe(true)
    expect(sent.map((args) => args[0])).toEqual(["accounts.changed", "switch.state"])
    expect(sent[0][1]).toMatchObject({
      revision: 3,
      origin: "global",
      eventId: expect.stringMatching(/^[0-9A-Z]{26}$/),
    })
    expect(sent[1][1]).toMatchObject({ origin: "session" })
  })

  function sample(): RpcTypes.EventBody<"switch.state"> {
    return { sessionID: "ses_test" as never, state: "STEADY", detail: { state: "STEADY" } }
  }
})

describe("Nonces", () => {
  test("a nonce is consumed once and expires", () => {
    const clock = Clock.manual()
    const scope = new Nonces.Scope<{ readonly accountID: string }>(clock)
    const first = scope.issue({ accountID: "acc_1" })
    expect(first.expiresAt).toBe(clock.now() + Nonces.TTL_MS)
    expect(scope.consume(first.nonce)).toEqual({ accountID: "acc_1" })
    expect(scope.consume(first.nonce)).toBeUndefined()
    const second = scope.issue({ accountID: "acc_2" })
    clock.advance(Nonces.TTL_MS)
    expect(scope.consume(second.nonce)).toBeUndefined()
  })
})

describe("Clock.manual", () => {
  test("fires due timers in order, including ones scheduled while firing, and cancels", () => {
    const clock = Clock.manual(0)
    const fired: string[] = []
    clock.schedule(20, () => fired.push("b"))
    clock.schedule(10, () => {
      fired.push("a")
      clock.schedule(5, () => fired.push("a2"))
    })
    const cancel = clock.schedule(15, () => fired.push("cancelled"))
    cancel()
    clock.advance(25)
    expect(fired).toEqual(["a", "a2", "b"])
    expect(clock.now()).toBe(25)
    expect(clock.pending()).toBe(0)
  })
})

describe("Logger", () => {
  test("redacts secrets in messages and fields", () => {
    const lines: string[] = []
    const log = Logger.create({ scope: "t", sink: (line) => lines.push(line) }).child("m")
    const fake = "sk-ant-api03-" + "x".repeat(40)
    log.info(`key ${fake}`, { authorization: `Bearer ${fake}`, count: 1 })
    log.debug("hidden at info level")
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain(fake)
    expect(JSON.parse(lines[0])).toMatchObject({ scope: "t.m", level: "info", count: 1 })
  })

  test("with a file, every line also lands there, redacted, one stream for every instance; a full file moves to .1", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-accounts-log-"))
    // The process keeps its log streams open; the folder goes when the OS lets it.
    await using _cleanup = { [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}) }
    const file = path.join(dir, "logs", "own-accounts.log")
    const lines: string[] = []
    const log = Logger.create({ scope: "t", sink: (line) => lines.push(line), file }).child("speed")
    const other = Logger.create({ scope: "other", sink: (line) => lines.push(line), file })
    const fake = "sk-ant-api03-" + "y".repeat(40)
    log.info("speed_downgraded", { requested: "ultrafast", served: "default", token: fake })
    log.debug("hidden at info level")
    other.info("limits_observed")
    const written = await settled(file, 2)
    expect(written).toEqual(lines)
    expect(written[0]).not.toContain(fake)
    expect(JSON.parse(written[0] ?? "")).toMatchObject({ scope: "t.speed", msg: "speed_downgraded" })
    expect(JSON.parse(written[1] ?? "")).toMatchObject({ scope: "other", msg: "limits_observed" })
    // A file already past the size moves aside before the first line.
    const full = path.join(dir, "logs", "full.log")
    await fs.writeFile(full, "x".repeat(Logger.FILE_MAX_BYTES + 1))
    Logger.create({ scope: "t", sink: () => {}, file: full }).warn("limits_absent")
    expect((await settled(full, 1)).map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ msg: "limits_absent", level: "warn" }),
    ])
    expect((await fs.stat(`${full}.1`)).size).toBe(Logger.FILE_MAX_BYTES + 1)
  })

  test("a file that fills while open moves to .1 between two lines; one that cannot move stops at the cap", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-accounts-log-"))
    await using _cleanup = { [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}) }
    const file = path.join(dir, "busy.log")
    const log = Logger.create({ scope: "t", sink: () => {}, file })
    const filler = "f".repeat(100_000)
    const full = Math.ceil(Logger.FILE_MAX_BYTES / 100_000)
    const write = (indexes: ReadonlyArray<number>) => indexes.forEach((index) => log.info("filler", { index, filler }))
    write(Array.from({ length: full }, (_, at) => at))
    expect((await settledAll([file], full))[0]).toHaveLength(full)
    // The first line past the size moves the file, the stream still open; the next lines start a new one.
    write([full, full + 1, full + 2])
    const [moved, current] = (await settledAll([`${file}.1`, file], full + 3)).map((lines) =>
      lines.map((line) => (JSON.parse(line) as { readonly index: number }).index),
    )
    expect(moved).toEqual(Array.from({ length: full }, (_, at) => at))
    expect(current).toEqual([full, full + 1, full + 2])
    expect((await fs.stat(`${file}.1`)).size).toBeGreaterThan(Logger.FILE_MAX_BYTES)

    // `.1` is a folder here, so the move fails: past the cap the lines are dropped, the other sink still gets them.
    const stuck = path.join(dir, "stuck.log")
    await fs.writeFile(stuck, "x".repeat(Logger.FILE_CAP_BYTES + 1))
    await fs.mkdir(`${stuck}.1`)
    await fs.writeFile(path.join(`${stuck}.1`, "keep"), "")
    const seen: string[] = []
    Logger.create({ scope: "t", sink: (line) => seen.push(line), file: stuck }).warn("dropped")
    await Bun.sleep(200)
    expect(seen).toHaveLength(1)
    expect((await fs.stat(stuck)).size).toBe(Logger.FILE_CAP_BYTES + 1)
  }, 60_000)

  test("the file's lines carry no Bearer value, key, JWT or token-named value, whatever a caller logged", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-accounts-log-"))
    await using _cleanup = { [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}) }
    const file = path.join(dir, "own-accounts.log")
    const log = Logger.create({ scope: "t", sink: () => {}, file, level: "debug" })
    const opaque = "oat_" + "q7".repeat(16)
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{"sub":"user-fake"}').toString("base64url")}.c2lnbmF0dXJlLWZha2U`
    const key = "sk-proj-" + "k".repeat(40)
    const password = "pw-fake-hunter2"
    log.info(`refresh answered for Bearer ${opaque}`, {
      authorization: `Bearer ${opaque}`,
      headers: { authorization: `Bearer ${jwt}`, "x-api-key": key, cookie: `session=${opaque}` },
      token: opaque,
      access_token: opaque,
      tokens: [{ refresh_token: opaque, idToken: jwt }],
      password,
      error: new Error(`401 for Bearer ${opaque} with ${key}`),
      detail: `upstream said ${jwt}`,
    })
    log.debug("auth_headers", { Authorization: `Bearer ${opaque}`, ok: true })
    log.warn(`key ${key} refused`)
    const written = await settled(file, 3)
    expect(written).toHaveLength(3)
    expect(logLeaks(written.join("\n"), [opaque, jwt, key, password])).toEqual([])
    // The scan itself finds what an unredacted line would give away.
    expect(logLeaks(JSON.stringify({ msg: `Bearer ${opaque}`, token: opaque }), [opaque])).toEqual([
      "line 1: field token",
      "line 1: bearer token",
      "line 1: bearer value",
      "line 1: plain text #0",
    ])
  })
})

/** The complete lines of each file once they hold `count` together (streams flush in the background), within 10 s. */
async function settledAll(files: ReadonlyArray<string>, count: number): Promise<string[][]> {
  const deadline = performance.now() + 10_000
  for (;;) {
    const texts = await Promise.all(files.map((file) => fs.readFile(file, "utf8").catch(() => "")))
    const lines = texts.map((text) =>
      text
        .slice(0, text.lastIndexOf("\n") + 1)
        .split("\n")
        .filter((line) => line !== ""),
    )
    if (lines.flat().length >= count || performance.now() > deadline) return lines
    await Bun.sleep(50)
  }
}

/** The file's lines once it has `count` of them (the stream writes in the background), within two seconds. */
async function settled(file: string, count: number): Promise<string[]> {
  const deadline = performance.now() + 2_000
  for (;;) {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    const lines = text.split("\n").filter((line) => line.startsWith("{"))
    if (lines.length >= count || performance.now() > deadline) return lines
    await Bun.sleep(20)
  }
}

describe("Events", () => {
  test("a location-less session event inherits the Location the session was last seen in", async () => {
    const here = path.resolve("own-events-test", "here")
    const there = path.resolve("own-events-test", "there")
    // Plain objects in the stream's shape; only `type`, `location` and `data.sessionID` matter to the dispatcher.
    const stream = [
      { type: "session.created", data: { sessionID: "ses_here", location: { directory: here } } },
      { type: "session.step.started", location: { directory: there }, data: { sessionID: "ses_there" } },
      // Published through the plugin host (`ctx.session.switchModel`): no envelope.
      { type: "session.model.selected", data: { sessionID: "ses_here" } },
      { type: "session.model.selected", data: { sessionID: "ses_there" } },
      { type: "session.model.selected", data: { sessionID: "ses_unknown" } },
      { type: "session.deleted", location: { directory: here }, data: { sessionID: "ses_here" } },
      { type: "session.model.selected", data: { sessionID: "ses_here" } },
    ]
    const seen: Array<{ readonly type: string; readonly sessionID: string; readonly local: boolean }> = []
    const done = Promise.withResolvers<void>()
    await using test = await testDeps({
      // Windows compares Locations case-insensitively.
      directory: process.platform === "win32" ? here.toUpperCase() : here,
      ctx: {
        event: {
          subscribe: async function* (input: { readonly signal: AbortSignal }) {
            // SAFETY: test doubles of `Module.OpenCodeEvent`; the dispatcher reads only the fields above.
            yield* stream as unknown as Module.OpenCodeEvent[]
            done.resolve()
            await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }))
          },
        },
      },
    })
    const quiet =
      <K extends Modules.Name>(name: K) =>
      (deps: Parameters<Modules.Factories[K]>[0], peers: Parameters<Modules.Factories[K]>[1]) => ({
        ...Modules.FACTORIES[name](deps, peers),
        onEvent:
          name === "health"
            ? (event: Module.OpenCodeEvent, meta: Module.EventMeta) => {
                const data = "data" in event ? (event.data as { readonly sessionID?: string }) : {}
                seen.push({ type: event.type, sessionID: data.sessionID ?? "", local: meta.local })
              }
            : undefined,
      })
    const modules = test.modules(
      Object.fromEntries(Modules.ORDER.map((name) => [name, quiet(name)])) as Partial<Modules.Factories>,
    )
    const stop = Events.start(test.deps, modules)
    await done.promise
    await stop()
    expect(seen.map((item) => [item.type, item.sessionID, item.local])).toEqual([
      ["session.created", "ses_here", true],
      ["session.step.started", "ses_there", false],
      ["session.model.selected", "ses_here", true],
      ["session.model.selected", "ses_there", false],
      ["session.model.selected", "ses_unknown", false],
      ["session.deleted", "ses_here", true],
      ["session.model.selected", "ses_here", false],
    ])
  })

  test("a subscription after a failed one tells the modules before its first event", async () => {
    const here = path.resolve("own-events-test", "resubscribe")
    const order: string[] = []
    const subscriptions = { count: 0 }
    const done = Promise.withResolvers<void>()
    await using test = await testDeps({
      directory: here,
      ctx: {
        event: {
          subscribe: async function* (input: { readonly signal: AbortSignal }) {
            subscriptions.count += 1
            const event = {
              type: "session.created",
              data: { sessionID: `ses_${subscriptions.count}`, location: { directory: here } },
            }
            // SAFETY: a test double of `Module.OpenCodeEvent`; the dispatcher reads only these fields.
            yield event as unknown as Module.OpenCodeEvent
            // The shared stream fails a consumer that fell 4096 events behind.
            if (subscriptions.count === 1) throw new Error("lagged")
            done.resolve()
            await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }))
          },
        },
      },
    })
    const quiet =
      <K extends Modules.Name>(name: K) =>
      (deps: Parameters<Modules.Factories[K]>[0], peers: Parameters<Modules.Factories[K]>[1]) => ({
        ...Modules.FACTORIES[name](deps, peers),
        onEvent:
          name === "health"
            ? (event: Module.OpenCodeEvent) => {
                const data = "data" in event ? (event.data as { readonly sessionID?: string }) : {}
                order.push(data.sessionID ?? "")
              }
            : undefined,
        onResubscribe: name === "health" ? () => void order.push("resubscribed") : undefined,
      })
    const modules = test.modules(
      Object.fromEntries(Modules.ORDER.map((name) => [name, quiet(name)])) as Partial<Modules.Factories>,
    )
    const stop = Events.start(test.deps, modules)
    const deadline = performance.now() + 5_000
    while (subscriptions.count < 2 && performance.now() < deadline) {
      test.clock.advance(Events.RETRY_MS)
      await Bun.sleep(10)
    }
    await done.promise
    await stop()
    expect(order).toEqual(["ses_1", "resubscribed", "ses_2"])
  })
})
