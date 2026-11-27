// The Claude Agent route's accounts (02 §8.10, CAG 2026-10-31): the login folders own makes, the provider fold (phase
// 0), the login window (a fake Claude Code CLI, a Bun script: never a real login), limits from Claude Code's own reports
// (P-039), R4, and phase 2: several accounts, the shared transcript folder, per-tree bindings moved by hand only, the
// folder of each request (P-045 per conversation) and the folders moving between routes. Fake peers; a real runtime on
// a temp OWN_HOME.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { Account, Kv, Preset, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { ClaudeAgent } from "../../src/claude-agent/agent.js"
import { Transcripts } from "../../src/claude-agent/transcripts.js"
import type { ClaudeAccounts } from "../../src/claude/accounts.js"
import { ClaudeLogin } from "../../src/claude/login.js"
import type { Module } from "../../src/module.js"
import type { Modules } from "../../src/modules.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { removeTree } from "../e2e-kit/harness/remove.js"
import { testDeps } from "../support/deps.js"
import { call, ok } from "../plugins/support.js"
import { FAKE_CLI } from "../claude/support.js"

const SUMMARY = { windows: () => [], summary: () => ({ state: "unknown" }) as never }
const sid = (id: string) => SessionID.make(id)

/** A service environment as a Claude Code terminal and Windows hand it over: identity, other routes, own's secrets. */
const OUTER = {
  USERNAME: "someone",
  USERDOMAIN: "SOMEONE-PC",
  COMPUTERNAME: "SOMEONE-PC",
  CLAUDECODE: "1",
  CLAUDE_CODE_USER_EMAIL: "someone@example.com",
  CLAUDE_CODE_ACCOUNT_UUID: "uuid-outer",
  CLAUDE_CODE_SESSION_ID: "outer",
  CLAUDE_CONFIG_DIR: "C:/other/route",
  ANTHROPIC_API_KEY: "sk-test",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
  OPENCODE_SERVER_PASSWORD: "secret",
}

/** claude-auth's accounts as the folder screen reads them (02 §8.7), with what a move to the other route asks of it. */
function fakeClaude(root: string) {
  const entries: ClaudeAccounts.Entry[] = []
  const adopted: unknown[] = []
  const released: string[] = []
  const busy = new Map<string, string[]>()
  /** `adopt` leaves something in the folder it names, so the rename onto it fails (a folder held open, say). */
  const block = { adopt: false }
  const add = (accountID: string, input: Partial<ClaudeAccounts.Entry> = {}) => {
    const configDir = input.configDir ?? path.join(root, "claude-accounts", accountID)
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, ".credentials.json"), "{}")
    entries.push({
      accountID: Account.ID.make(accountID),
      key: ClaudeLogin.key(configDir),
      configDir,
      label: null,
      shortLabel: "C2",
      color: "violet",
      managed: true,
      readOnly: false,
      email: "cl***@…",
      default: false,
      ...input,
    })
    return configDir
  }
  const api = {
    list: () => entries,
    entry: (accountID: string) => entries.find((item) => item.accountID === accountID),
    multi: () => true,
    busy: async (accountID: string) => busy.get(accountID) ?? [],
    release: async (accountID: string) => {
      // Whether the folder still lay under claude-auth's root when it let go (its sweep could take it then).
      released.push(`${accountID}:${fs.existsSync(entries.find((item) => item.accountID === accountID)!.configDir)}`)
      entries.splice(
        entries.findIndex((item) => item.accountID === accountID),
        1,
      )
    },
    adopt: async (input: { readonly accountID: Account.ID; readonly folder: string }) => {
      // Named before the folder lands under claude-auth's root.
      adopted.push({ ...input, there: fs.existsSync(input.folder) })
      if (block.adopt) fs.mkdirSync(path.join(input.folder, "blocker"), { recursive: true })
      entries.push({
        accountID: input.accountID,
        key: ClaudeLogin.key(input.folder),
        configDir: input.folder,
        label: null,
        shortLabel: "C3",
        color: "violet",
        managed: true,
        readOnly: false,
        default: false,
      })
    },
  }
  return { api, add, adopted, released, busy, block }
}

async function world(options: { readonly cli?: false; readonly mode?: string } = {}) {
  const connects: unknown[] = []
  const connection = { value: undefined as unknown }
  const storage = new Map<string, unknown>()
  const test = await testDeps({
    control: true,
    ctx: {
      integration: {
        connection: { active: async () => connection.value },
        connect: {
          external: async (input: unknown) => {
            connects.push(input)
            connection.value = { id: "c1" }
          },
        },
      },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => {
          storage.set(key, value)
        },
        scan: async (input: { readonly prefix: string }) => ({
          entries: [...storage.entries()]
            .filter((item) => item[0].startsWith(input.prefix))
            .map((item) => ({ key: item[0], value: item[1] })),
        }),
      },
      session: { get: async () => undefined },
    },
  })
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-agent-home-")))
  const script = path.join(home, "fake-claude.ts")
  fs.writeFileSync(script, FAKE_CLI)
  const holder = { registry: Store.emptyRegistry() as Registry.File, reloads: 0 }
  const alerts: Telemetry.AlertInput[] = []
  const claude = fakeClaude(test.deps.runtime.layout.root)
  const peers: Module.Peers = () =>
    // SAFETY: the module uses only these members of its peers.
    ({
      slots: {
        snapshot: () => holder.registry,
        mutate: async (change: (current: Registry.File) => Registry.File | undefined) => {
          holder.registry = await test.deps.runtime.registry.update(change)
          return holder.registry
        },
        reload: async () => {
          holder.reloads++
        },
      },
      telemetry: { alert: (input: Telemetry.AlertInput) => void alerts.push(input) },
      claude: claude.api,
    }) as unknown as Modules.All
  const channel: ClaudeAgent.Channel = { version: 1, listeners: new Set() }
  const login: ClaudeLogin.Config = {
    ...ClaudeLogin.defaults(home),
    ...(options.cli === false ? { cli: undefined } : { cli: [process.execPath, script, options.mode ?? "ok"] }),
    // No Claude Code of this PC is ever found: the user's home is the temp folder.
    userHome: home,
    spawn: (command, env) => {
      const child = Bun.spawn([...command], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      return { exited: child.exited, kill: () => child.kill() }
    },
    pollMs: 20,
    timeoutMs: 30_000,
    exitGraceMs: 1_000,
  }
  const agent = ClaudeAgent.make(test.deps, peers, {
    login,
    channel: () => channel,
    env: () => ({ ...process.env, ...OUTER }),
  })
  const shared = path.join(test.deps.runtime.layout.claudeAgent, "projects")
  /** A Claude Agent request of `sessionID` as own-accounts' context hook hands it over. */
  const request = async (sessionID: string) => {
    const event = { sessionID, model: { providerID: "claude-agent" }, options: {} as Record<string, unknown> }
    await w.agent.onRequest(event)
    return event.options.configDir
  }
  /** A session in the runtime's index (a root, or a subagent of `parentID`). */
  const session = (sessionID: string, input: { readonly parentID?: string; readonly busy?: boolean } = {}) =>
    test.deps.runtime.sessions.update(sessionID, {
      providerID: "claude-agent",
      modelID: "opus",
      parentID: input.parentID ?? null,
      busy: input.busy ?? false,
    })
  const turnEnds = (sessionID: string) =>
    w.agent.onEvent?.({ type: "session.execution.succeeded", data: { sessionID } } as never, { local: true })
  const w = {
    deps: test.deps,
    agent,
    channel,
    connects,
    holder,
    home,
    storage,
    alerts,
    claude,
    shared,
    request,
    session,
    turnEnds,
    async [Symbol.asyncDispose]() {
      await agent.stop()
      await test[Symbol.asyncDispose]()
      await removeTree(home)
    },
  }
  return w
}

/** A provider editor holding upstream's `claude-agent` as the core plugin registers it, with `models` as listed. */
function editor(models: ReadonlyArray<Model.Info> = []) {
  const provider = { id: "claude-agent", activation: "auto", settings: {} as Record<string, unknown> }
  const listed = { models: new Map(models.map((model) => [model.id as string, model])) }
  const fake = {
    get: (id: string) => (id === "claude-agent" ? { info: provider, models: listed.models } : undefined),
    update: (id: string, change: (value: typeof provider) => void) => {
      if (id === "claude-agent") change(provider)
    },
    models: {
      set: (id: string, next: ReadonlyArray<Model.Info>) => {
        if (id === "claude-agent") listed.models = new Map(next.map((model) => [model.id as string, model]))
      },
    },
  }
  // SAFETY: the fold uses only `get`, `update` and `models.set`.
  return { provider, listed, editor: fake as unknown as ProviderEditor }
}

/** A model of the provider as core's `toModel` lists it (Claude Code's alias as the id). */
function agentModel(id: string, context = 1_000_000): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make("claude-agent"), Model.ID.make(id)),
    name: id,
    limit: { context, output: 0 },
    variants: [{ id: Model.VariantID.make("high"), settings: { effort: "high" } }],
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

describe("Claude Agent account", () => {
  test("phase 0: the provider stays off until the account exists, then runs only on its own folder", async () => {
    await using w = await world()
    await w.agent.start()
    const before = editor()
    w.agent.fold(before.editor)
    expect(before.provider.activation).toBe("disabled")
    expect(w.connects).toHaveLength(0)

    const status = await ok(w.agent.setup, {})
    const account = status.accounts[0]!
    expect(status.created).toBe(account.accountID)
    expect(path.dirname(account.folder)).toBe(path.join(w.deps.runtime.layout.claudeAgent, "accounts"))
    expect(fs.statSync(account.folder).isDirectory()).toBe(true)
    expect(account.loggedIn).toBe(false)
    expect(account.default).toBe(true)
    // 02 §8.10.3 (manual 20.8): the same login from 명령 프롬프트 and from PowerShell.
    expect(account.commands?.cmd).toContain(`set "CLAUDE_CONFIG_DIR=${account.folder}"`)
    expect(account.commands?.cmd).toContain("auth login")
    expect(account.commands?.powershell).toContain(`$env:CLAUDE_CONFIG_DIR = '${account.folder}'`)
    expect(account.commands?.powershell).toContain("& '")
    // Core P-045: never the PC's Anthropic profile, like the login window and every claude of the route.
    expect(account.commands?.cmd).toContain(`set "ANTHROPIC_CONFIG_DIR=${path.join(account.folder, "anthropic")}" && `)
    expect(account.commands?.powershell).toContain(`$env:ANTHROPIC_CONFIG_DIR = '${path.join(account.folder, "anthropic")}'; & '`)
    // own makes upstream's connection itself, once, so the provider checks Claude Code and lists its models.
    expect(w.connects).toEqual([{ integrationID: "claude-agent", methodID: "claude-login", label: "own" }])
    // Without `add` setup is idempotent.
    expect((await ok(w.agent.setup, {})).created).toBeUndefined()
    expect(w.connects).toHaveLength(1)
    expect(w.holder.registry.claudeAgents).toHaveLength(1)

    const after = editor()
    w.agent.fold(after.editor)
    expect(after.provider.activation).toBe("enabled")
    expect(after.provider.settings.configDir).toBe(account.folder)
  })

  test("the login window runs Claude Code's own login in the folder with an allow-list environment", async () => {
    await using w = await world()
    await w.agent.start()
    const folder = (await ok(w.agent.setup, {})).accounts[0]!.folder
    const opened = await ok(w.agent.login, {})
    expect(opened.login).toBe("waiting")
    // The credentials file appears before the login process exits, and the window's state follows its exit.
    await until(async () => (await ok(w.agent.status, {})).login !== "waiting")
    const status = await ok(w.agent.status, {})
    expect(status.login).toBe("logged_in")
    expect(status.accounts[0]?.loggedIn).toBe(true)
    expect(status.accounts[0]!.email).not.toBe("max@example.test")
    expect(status.accounts[0]!.email).toContain("@")
    const seen = JSON.parse(fs.readFileSync(path.join(folder, "env.json"), "utf8")) as {
      names: string[]
      args: string[]
      values: Record<string, string | undefined>
    }
    expect(seen.args).toEqual(["auth", "login", "--claudeai"])
    // P-042's allow-list, as every claude of the route gets it: no other route and nothing of own's; the identity
    // variables Windows would copy from the service (libuv) arrive empty.
    const forbidden = /^(ANTHROPIC_|CLAUDE|OPENCODE_)/i
    const named = new Set(["CLAUDE_CONFIG_DIR", "ANTHROPIC_CONFIG_DIR", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY"])
    expect(seen.names.filter((name) => forbidden.test(name) && !named.has(name))).toEqual([])
    expect(seen.values).toEqual({
      CLAUDE_CONFIG_DIR: folder,
      // Core P-045: the folder's own Anthropic profile directory, never the PC's %APPDATA%\Anthropic.
      ANTHROPIC_CONFIG_DIR: path.join(folder, "anthropic"),
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DO_NOT_TRACK: "1",
      DISABLE_GROWTHBOOK: "1",
      DISABLE_BUG_COMMAND: "1",
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      USERNAME: "",
      USERDOMAIN: "",
      LOGONSERVER: "",
      COMPUTERNAME: "",
    })
    const view = w.agent.views(SUMMARY)[0]!
    expect(view.kind).toBe("claude-agent")
    expect(view.providerID).toBe(Provider.ID.make("claude-agent"))
    expect(view.status).toBe("ready")
    expect(view.thirdParty).toBe(false)
    expect(view.claudeAgent?.loggedIn).toBe(true)
  })

  test("the login's allow-list is core's (P-042) plus the account folder and its profile directory (P-045)", async () => {
    const { ClaudeIO } = await import("../../../core/src/plugin/provider/claude-agent/claude/io.ts")
    const { ClaudeQueryOptions } = await import("../../../core/src/plugin/provider/claude-agent/claude/query-options.ts")
    const folder = "C:/own/claude-agent/accounts/a"
    const source = {
      ...process.env,
      ...OUTER,
      TZ: "Asia/Seoul",
      HTTPS_PROXY: "http://proxy",
      LC_CTYPE: "C",
      ANTHROPIC_CONFIG_DIR: "C:/Users/someone/AppData/Roaming/Anthropic",
    }
    const core = ClaudeQueryOptions.base({ executable: "claude", io: ClaudeIO.local, connection: { CLAUDE_CONFIG_DIR: folder } })
    expect<Record<string, string | undefined>>(ClaudeAgent.loginEnvironment(folder, source)).toEqual({
      ...ClaudeIO.allowed(source),
      CLAUDE_CONFIG_DIR: folder,
      ANTHROPIC_CONFIG_DIR: core.env!.ANTHROPIC_CONFIG_DIR,
    })
  })

  test("a model saved under Claude Code's retired [1m] id stays registered, deprecated, and runs the new id", async () => {
    await using w = await world()
    await w.agent.start()
    // Claude Code 2.1.311+ lists `opus` (1M) where 2.1.282 listed `opus[1m]`; a real suffixed id is never doubled.
    const listed = editor([agentModel("opus"), agentModel("haiku", 200_000), agentModel("sonnet"), agentModel("sonnet[1m]")])
    const fold = w.agent.fold
    fold(listed.editor)
    const models = [...listed.listed.models.values()]
    expect<string[][]>(models.map((model) => [model.id, model.modelID, model.status])).toEqual([
      ["opus", "opus", "active"],
      ["haiku", "haiku", "active"],
      ["sonnet", "sonnet", "active"],
      ["sonnet[1m]", "sonnet[1m]", "active"],
      ["opus[1m]", "opus", "deprecated"],
      ["haiku[1m]", "haiku", "deprecated"],
    ])
    // The same window, levels and name as the model it runs; enabled, so a conversation on it resolves.
    const alias = listed.listed.models.get("opus[1m]")!
    expect(alias).toMatchObject({ enabled: true, name: "opus", limit: { context: 1_000_000 }, variants: [{ id: "high" }] })
    // Nothing offers it anew (07 §4.4); a preset pinned to it is offered the new id (07 §4.3).
    expect(Preset.callable({ ...alias, capabilities: alias.capabilities })).toBe(false)
    expect<string | undefined>(
      Preset.successor({ id: "opus[1m]" }, Preset.candidates(models.filter((model) => model.status !== "deprecated"))),
    ).toBe("opus")
    // A second fold over the result adds nothing.
    fold(listed.editor)
    expect(listed.listed.models.size).toBe(6)
  })

  test("without Claude Code the login is refused and the view says so", async () => {
    await using w = await world({ cli: false })
    await w.agent.start()
    const status = await ok(w.agent.setup, {})
    // A Claude Code on this PC's PATH is found like the user's: then there is nothing to check here.
    if (status.cli !== null) return
    expect(status.accounts[0]!.commands).toBeNull()
    expect(await call(w.agent.login, {})).toMatchObject({
      ok: false,
      type: "claude_account_unavailable",
      data: { reason: "cli_missing" },
    })
    expect(w.agent.views(SUMMARY)[0]!.status).toBe("misconfigured")
  })

  test("P-039: Claude Code's limit reports become the account's windows; a refusal moves nothing", async () => {
    await using w = await world()
    await w.agent.start()
    const status = await ok(w.agent.setup, {})
    const accountID = status.accounts[0]!.accountID
    const folder = status.accounts[0]!.folder
    const exhausted: unknown[] = []
    const off = w.deps.runtime.broadcast.on("exhausted", (payload) => {
      exhausted.push(payload)
    })
    const emit = (observation: Omit<ClaudeAgent.Observation, "at">) => {
      for (const listener of w.channel.listeners) listener({ ...observation, at: 1_000_000 })
    }
    // Another folder's process (another route, a stale account) is not this account's.
    emit({ configDir: path.join(w.home, "elsewhere"), rateLimit: { status: "allowed", rateLimitType: "five_hour" } })
    expect(w.deps.runtime.limits.list({ accountID })).toEqual([])

    emit({
      configDir: folder,
      sessionID: "ses_1",
      rateLimit: {
        status: "allowed",
        resetsAt: 1_792_833_000,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: 1_792_833_000 } },
      },
    })
    const fiveHours = w.deps.runtime.limits.list({ accountID }).find((window) => window.id === "claude.5h")!
    expect(fiveHours.usedPercent).toBe(5)
    expect(fiveHours.resetAt).toBe(1_792_833_000_000)
    expect(fiveHours.providerID).toBe(Provider.ID.make("claude-agent"))
    expect(fiveHours.status).toBe("ok")
    const overage = w.deps.runtime.limits.list({ accountID }).find((window) => window.id === "claude.overage")!
    expect(overage.meta?.disabledReason).toBe("org_level_disabled")

    emit({
      configDir: folder,
      sessionID: "ses_1",
      rateLimit: { status: "rejected", resetsAt: 1_792_900_000, rateLimitType: "seven_day", utilization: 1 },
    })
    expect(w.deps.runtime.limits.exhaustion(accountID)?.windowId).toBe("claude.7d")
    // No session in the record: nothing plans a move on its own (manual switching only).
    expect(exhausted).toEqual([
      {
        exhaustion: {
          accountID,
          windowId: "claude.7d",
          until: 1_792_900_000_000,
          class: "hard",
          reason: "7d_rejected",
        },
        providerID: "claude-agent",
      },
    ])
    off()

    emit({
      configDir: folder,
      account: { subscriptionType: "max", tokenSource: "claude.ai" },
      usage: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-11-01T05:00:00.000Z" },
          seven_day: { utilization: 13, resets_at: "2026-11-05T00:00:00.000Z" },
          seven_day_opus: { utilization: 88, resets_at: "2026-11-05T00:00:00.000Z" },
          model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: null }],
          extra_usage: { is_enabled: true, utilization: 10 },
        },
      },
    })
    const windows = new Map(w.deps.runtime.limits.list({ accountID }).map((window) => [window.id, window]))
    expect(windows.get("claude.5h")?.usedPercent).toBe(42)
    expect(windows.get("claude.7d_opus")?.status).toBe("warning")
    expect(windows.get("claude.7d_oi")?.usedPercent).toBe(3)
    expect(windows.get("claude.overage")?.usedPercent).toBe(10)
    expect((await ok(w.agent.status, {})).accounts[0]?.plan).toBe("max")
    expect(w.agent.ttl()).toBe("1h")

    // A verified Ultra account (02 §7.1.2): a weekly `rate_limit_event` names one window and says nothing of the five
    // hours; a usage answer without `five_hour` forgets them and says so.
    const updates: unknown[] = []
    const stop = w.deps.runtime.broadcast.on("limits.updated", (payload) => {
      updates.push(payload)
    })
    emit({ configDir: folder, rateLimit: { status: "allowed", rateLimitType: "seven_day", utilization: 0.2 } })
    expect(w.deps.runtime.limits.list({ accountID }).some((window) => window.id === "claude.5h")).toBe(true)
    updates.length = 0
    emit({
      configDir: folder,
      usage: {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: { seven_day: { utilization: 21, resets_at: "2026-11-05T00:00:00.000Z" } },
      },
    })
    expect(w.deps.runtime.limits.list({ accountID }).some((window) => window.id === "claude.5h")).toBe(false)
    expect(updates).toEqual([
      {
        windows: [expect.objectContaining({ id: "claude.7d", usedPercent: 21 })],
        dropped: [{ accountID, id: "claude.5h" }],
      },
    ])
    stop()
  })

  test("R4: the account is a subscription of Anthropic, so a team cannot add the Claude slot beside it", async () => {
    await using w = await world()
    await w.agent.start()
    const accountID = (await ok(w.agent.setup, {})).accounts[0]!.accountID
    const member = w.agent.member("claude-agent")!
    expect(member).toEqual({ id: accountID, kind: "claude-agent", billing: "subscription" })
    expect(w.agent.member("anthropic")).toBeUndefined()
    expect(Preset.company(member)).toBe("anthropic")
    const slot: Preset.Member = { id: Account.ID.claudeSlot, kind: "claude-sub", billing: "subscription" }
    const lookup: Preset.Lookup = (id) => (id === accountID ? member : id === slot.id ? slot : undefined)
    const verdict = Preset.allowed({ group: "claude-agent", workers: { mode: "same", roles: {} } }, accountID, lookup, {
      accounts: [accountID, slot.id],
      pinned: [],
    } as unknown as Preset.Team)
    expect(verdict).toEqual({ ok: false, accountID: slot.id })
  })
})

describe("Claude Agent phase 2: several accounts, switched by hand", () => {
  test("every account's projects is a junction to the one shared transcript folder", async () => {
    await using w = await world()
    await w.agent.start()
    const first = (await ok(w.agent.setup, {})).created!
    const second = (await ok(w.agent.setup, { add: true })).created!
    expect(second).not.toBe(first)
    const status = await ok(w.agent.status, {})
    expect(status.accounts.map((item) => [item.accountID, item.default, item.shortLabel])).toEqual([
      [first, true, "CA"],
      [second, false, "CA2"],
    ])
    for (const item of status.accounts) {
      expect(fs.lstatSync(path.join(item.folder, "projects")).isSymbolicLink()).toBe(true)
      expect(await Transcripts.linked(item.folder, w.shared)).toBe(true)
    }
    // A conversation one account writes is the other account's too.
    const project = path.join(status.accounts[0]!.folder, "projects", "C--work")
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, "11111111-1111-4111-8111-111111111111.jsonl"), "{}\n")
    expect(
      fs.existsSync(path.join(status.accounts[1]!.folder, "projects", "C--work", "11111111-1111-4111-8111-111111111111.jsonl")),
    ).toBe(true)
    expect(w.agent.views(SUMMARY).map((view) => [view.id, view.claudeAgent?.default, view.claudeAgent?.transcripts])).toEqual([
      [first, true, "linked"],
      [second, false, "linked"],
    ])
  })

  test("a broken transcript link is repaired before the request, or the request is refused saying why", async () => {
    await using w = await world()
    await w.agent.start()
    const folder = (await ok(w.agent.setup, {})).accounts[0]!.folder
    const link = path.join(folder, "projects")
    w.session("ses_broken")

    // A link to another folder is made again; that folder stays as it was.
    const elsewhere = path.join(w.home, "elsewhere")
    fs.mkdirSync(path.join(elsewhere, "keep"), { recursive: true })
    fs.unlinkSync(link)
    fs.symlinkSync(elsewhere, link, "junction")
    expect(await w.request("ses_broken")).toBe(folder)
    expect(await Transcripts.linked(folder, w.shared)).toBe(true)
    expect(fs.existsSync(path.join(elsewhere, "keep"))).toBe(true)

    // A link whose target is gone: the shared folder comes back and the link stands.
    fs.rmSync(w.shared, { recursive: true, force: true })
    w.turnEnds("ses_broken")
    expect(await w.request("ses_broken")).toBe(folder)
    expect(fs.existsSync(w.shared)).toBe(true)

    // A real folder (Claude Code ran there before the link): its conversations move into the shared folder, a name the
    // shared folder already has is kept beside it, and the link is made.
    const shared = path.join(w.shared, "C--work")
    fs.mkdirSync(shared, { recursive: true })
    fs.writeFileSync(path.join(shared, "same.jsonl"), "shared\n")
    fs.unlinkSync(link)
    fs.mkdirSync(path.join(link, "C--work"), { recursive: true })
    fs.writeFileSync(path.join(link, "C--work", "same.jsonl"), "local\n")
    fs.writeFileSync(path.join(link, "C--work", "only-here.jsonl"), "local\n")
    w.turnEnds("ses_broken")
    expect(await w.request("ses_broken")).toBe(folder)
    expect(await Transcripts.linked(folder, w.shared)).toBe(true)
    expect(fs.readFileSync(path.join(shared, "same.jsonl"), "utf8")).toBe("shared\n")
    expect(fs.readFileSync(path.join(shared, "only-here.jsonl"), "utf8")).toBe("local\n")
    const kept = fs.readdirSync(folder).find((name) => name.startsWith("projects.kept-"))!
    expect(fs.readFileSync(path.join(folder, kept, "C--work", "same.jsonl"), "utf8")).toBe("local\n")

    // A file where the folder belongs cannot be repaired: the request is refused and says what to do.
    fs.unlinkSync(link)
    fs.writeFileSync(link, "not a folder")
    w.turnEnds("ses_broken")
    const refused = await w.request("ses_broken").then(
      () => "sent",
      (error: Error) => error.message,
    )
    expect(refused).toContain("폴더가 아니라 파일이에요")
    expect(w.alerts.at(-1)).toMatchObject({ code: "claude_account_refused", sessionID: "ses_broken" })
    expect(w.agent.views(SUMMARY)[0]!.claudeAgent?.transcripts).toBe("broken")
  })

  test("a junction on the way to the shared folder is refused, never followed (CAG-34)", async () => {
    await using w = await world()
    await w.agent.start()
    const folder = (await ok(w.agent.setup, {})).accounts[0]!.folder
    // The provider learns the shared folder over the channel, as it learns the pool settings.
    expect(w.channel.shared).toBe(w.shared)
    w.session("ses_junction")
    // Outside OWN_HOME, e.g. the user's ~/.claude/projects.
    const outside = path.join(w.home, "outside")
    fs.mkdirSync(path.join(outside, "P"), { recursive: true })
    fs.writeFileSync(path.join(outside, "P", "11111111-1111-4111-8111-111111111111.jsonl"), "{}\n")
    const outsideNow = () => fs.readdirSync(outside, { recursive: true }).map(String).sort()
    const before = outsideNow()
    const refused = async () =>
      w.request("ses_junction").then(
        () => "sent",
        (error: Error) => error.message,
      )

    // The shared folder itself is a junction to the outside folder.
    fs.rmSync(w.shared, { recursive: true, force: true })
    fs.symlinkSync(outside, w.shared, "junction")
    expect(await refused()).toContain("다른 곳으로 이어진 링크(정션)")
    expect(w.alerts.at(-1)).toMatchObject({ code: "claude_account_refused", sessionID: "ses_junction" })
    expect(w.agent.views(SUMMARY)[0]!.claudeAgent?.transcripts).toBe("broken")
    // While a check refuses, the provider is told no shared folder, so it sweeps and writes nothing (CAG-42).
    expect(w.channel.shared).toBeUndefined()

    // A folder above it under OWN_HOME is the junction (`<OWN_HOME>\claude-agent` pointing elsewhere).
    fs.unlinkSync(w.shared)
    const route = w.deps.runtime.layout.claudeAgent
    const moved = path.join(w.home, "claude-agent-elsewhere")
    fs.renameSync(route, moved)
    fs.symlinkSync(moved, route, "junction")
    w.turnEnds("ses_junction")
    expect(await refused()).toContain(`${route}가 다른 곳으로 이어진 링크(정션)`)
    expect(w.channel.shared).toBeUndefined()
    expect(outsideNow()).toEqual(before)

    // Back to a real folder: the link is made and the request goes.
    fs.unlinkSync(route)
    fs.renameSync(moved, route)
    w.turnEnds("ses_junction")
    expect(await w.request("ses_junction")).toBe(folder)
    expect(await Transcripts.linked(folder, w.shared)).toBe(true)
    expect(fs.lstatSync(w.shared).isSymbolicLink()).toBe(false)
    expect(w.channel.shared).toBe(fs.realpathSync(w.shared))
    expect(outsideNow()).toEqual(before)
  })

  test("a real projects folder merged into the shared one keeps its links aside, at any depth (CAG-34, CAG-44)", async () => {
    await using w = await world()
    await w.agent.start()
    const folder = (await ok(w.agent.setup, {})).accounts[0]!.folder
    const link = path.join(folder, "projects")
    const outside = path.join(w.home, "outside")
    fs.mkdirSync(path.join(outside, "P"), { recursive: true })
    fs.writeFileSync(path.join(outside, "P", "keep.jsonl"), "{}\n")
    fs.unlinkSync(link)
    fs.mkdirSync(path.join(link, "C--work"), { recursive: true })
    fs.writeFileSync(path.join(link, "C--work", "only-here.jsonl"), "local\n")
    fs.symlinkSync(outside, path.join(link, "C--evil"), "junction")
    fs.symlinkSync(outside, path.join(link, "C--work", "nested"), "junction")
    // A hard link to a file outside: an append in the shared folder would change that file too (CAG-44).
    fs.linkSync(path.join(outside, "P", "keep.jsonl"), path.join(link, "C--work", "hard.jsonl"))
    w.session("ses_merge")
    expect(await w.request("ses_merge")).toBe(folder)
    expect(await Transcripts.linked(folder, w.shared)).toBe(true)
    expect(fs.readFileSync(path.join(w.shared, "C--work", "only-here.jsonl"), "utf8")).toBe("local\n")
    // Nothing in the shared folder leads elsewhere; the junctions went beside projects, their targets untouched.
    expect(fs.existsSync(path.join(w.shared, "C--evil"))).toBe(false)
    expect(fs.existsSync(path.join(w.shared, "C--work", "nested"))).toBe(false)
    const kept = path.join(folder, fs.readdirSync(folder).find((name) => name.startsWith("projects.kept-"))!)
    expect(fs.lstatSync(path.join(kept, "C--evil")).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(kept, "C--work", "nested")).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(w.shared, "C--work", "hard.jsonl"))).toBe(false)
    expect(fs.lstatSync(path.join(kept, "C--work", "hard.jsonl")).nlink).toBe(2)
    expect(fs.readFileSync(path.join(outside, "P", "keep.jsonl"), "utf8")).toBe("{}\n")
  })

  test("a tree keeps its account; only the user moves it, at each session's next turn, and limits never do", async () => {
    await using w = await world()
    await w.agent.start()
    const a = (await ok(w.agent.setup, {})).accounts[0]!
    const b = (await ok(w.agent.setup, { add: true })).accounts.find((item) => !item.default)!
    w.session("ses_root")
    w.session("ses_child", { parentID: "ses_root" })

    // A new tree starts on the default and keeps it, also after the default changes; its subagent runs on it too.
    expect(await w.request("ses_root")).toBe(a.folder)
    expect(await w.request("ses_child")).toBe(a.folder)
    await ok(w.agent.defaultSet, { accountID: b.accountID })
    w.turnEnds("ses_root")
    expect(await w.request("ses_root")).toBe(a.folder)
    expect(await ok(w.agent.sessionGet, { sessionID: sid("ses_child") })).toEqual({ accountID: a.accountID, bound: true })

    // A refused window of A moves nothing (CAG-D3): the tree stays on A.
    for (const listener of w.channel.listeners)
      listener({
        configDir: a.folder,
        sessionID: "ses_root",
        rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000 },
        at: 1_000,
      })
    w.turnEnds("ses_root")
    expect(await w.request("ses_root")).toBe(a.folder)

    // The user moves the tree to B in the middle of a turn: the running turn keeps A (the safe point), the next one
    // and the subagent's next one run on B.
    const moved = await ok(w.agent.sessionSet, { sessionID: sid("ses_child"), accountID: b.accountID })
    expect(moved.sessions.toSorted()).toEqual([sid("ses_child"), sid("ses_root")])
    expect(await w.request("ses_root")).toBe(a.folder)
    w.turnEnds("ses_root")
    expect(await w.request("ses_root")).toBe(b.folder)
    w.turnEnds("ses_child")
    expect(await w.request("ses_child")).toBe(b.folder)
    expect(w.storage.get(Kv.claudeAgentSession("ses_root"))).toMatchObject({ accountID: b.accountID })
    expect(w.agent.peek("ses_child")).toBe(b.accountID)
    expect(w.agent.member("claude-agent", "ses_root")?.id).toBe(b.accountID)
  })

  test("R4 tells the route's accounts apart: a team on one cannot pin the other", async () => {
    await using w = await world()
    await w.agent.start()
    const a = (await ok(w.agent.setup, {})).created!
    const b = (await ok(w.agent.setup, { add: true })).created!
    expect(w.agent.lookup(a)).toEqual({ id: a, kind: "claude-agent", billing: "subscription" })
    expect(w.agent.lookup(b)).toEqual({ id: b, kind: "claude-agent", billing: "subscription" })
    const lookup: Preset.Lookup = (id) => w.agent.lookup(id)
    const verdict = Preset.allowed({ group: "claude-agent", workers: { mode: "same", roles: {} } }, a, lookup, {
      accounts: [a, b],
      pinned: [],
    } as unknown as Preset.Team)
    expect(verdict).toEqual({ ok: false, accountID: b })
    expect(
      Preset.allowed({ group: "claude-agent", workers: { mode: "same", roles: {} } }, a, lookup, {
        accounts: [a],
        pinned: [],
      } as unknown as Preset.Team).ok,
    ).toBe(true)
  })

  test("a team runs on one account: a member root joining follows it, and a move takes the whole team", async () => {
    await using w = await world()
    await w.agent.start()
    const a = (await ok(w.agent.setup, {})).accounts[0]!
    const b = (await ok(w.agent.setup, { add: true })).accounts.find((item) => !item.default)!
    const team = { teamID: "tm_01", role: "owner", accounts: [], pinned: [] }
    const bind = (root: string, role: "main" | "owner") =>
      w.storage.set(Kv.preset(root), {
        presetID: "builtin:claude-agent",
        group: "claude-agent",
        revision: 0,
        appliedAt: 1,
        entryHash: null,
        team: { ...team, role },
      })
    w.session("ses_main")
    w.session("ses_owner")
    // The owner ran on B before it joined the team.
    await ok(w.agent.sessionSet, { sessionID: sid("ses_owner"), accountID: b.accountID })
    await ok(w.agent.defaultSet, { accountID: a.accountID })
    bind("ses_main", "main")
    expect(await w.request("ses_main")).toBe(a.folder)
    bind("ses_owner", "owner")
    w.turnEnds("ses_owner")
    // The team's account wins: one Claude Agent account per team (07 R4).
    expect(await w.request("ses_owner")).toBe(a.folder)
    expect(w.storage.get(Kv.claudeAgentTeam("tm_01"))).toMatchObject({ accountID: a.accountID })
    // The user moves the team main: the whole team goes.
    const moved = await ok(w.agent.sessionSet, { sessionID: sid("ses_main"), accountID: b.accountID })
    expect(moved.sessions.toSorted()).toEqual([sid("ses_main"), sid("ses_owner")])
    w.turnEnds("ses_main")
    w.turnEnds("ses_owner")
    expect(await w.request("ses_owner")).toBe(b.folder)
    expect(await w.request("ses_main")).toBe(b.folder)
  })

  test("an idle account's limits are read with its own folder", async () => {
    await using w = await world()
    await w.agent.start()
    await ok(w.agent.setup, {})
    const idle = (await ok(w.agent.setup, { add: true })).accounts.find((item) => !item.default)!
    const asked: string[] = []
    w.channel.usage = async (configDir) => {
      asked.push(configDir)
      for (const listener of w.channel.listeners)
        listener({
          configDir,
          usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 7, resets_at: null } } },
          at: 2_000_000,
        })
      return {}
    }
    const answer = await ok(w.agent.limitsRefresh, { accountID: idle.accountID })
    expect(asked).toEqual([idle.folder])
    expect(answer.windows.find((window) => window.id === "claude.5h")?.usedPercent).toBe(7)
    expect(w.deps.runtime.limits.list({ accountID: idle.accountID })[0]?.accountID).toBe(idle.accountID)
  })

  test("P-044: the pool's cap and spares are this service's setting; its count reaches the view and the clients", async () => {
    await using w = await world()
    const sent: Array<{ name: string; body: unknown }> = []
    const global = w.deps.emitter.global.bind(w.deps.emitter)
    w.deps.emitter.global = (name, body) => {
      sent.push({ name, body })
      return global(name, body)
    }
    await w.agent.start()
    await ok(w.agent.setup, {})
    // The defaults reach the provider at start.
    expect(w.channel.settings).toEqual({ processes: 8, spares: 0 })
    expect((await ok(w.agent.status, {})).pool).toEqual({ live: 0, cap: 8, over: 0, spares: 0, waiting: [] })
    // The provider's pools re-check at once (CAG-36), as core's `ClaudeObserver.configure` has them.
    const rechecked: unknown[] = []
    w.channel.rechecks = new Set([() => void rechecked.push(w.channel.settings)])
    const set = await ok(w.agent.poolSet, { processes: 4, spares: 1 })
    expect(set).toMatchObject({ cap: 4, spares: 1 })
    expect(w.channel.settings).toEqual({ processes: 4, spares: 1 })
    expect(rechecked).toEqual([{ processes: 4, spares: 1 }])
    expect(w.holder.registry.claudeAgentPool).toEqual({ processes: 4, spares: 1 })
    // Only the cap changes: the spares setting stays.
    expect(await ok(w.agent.poolSet, { processes: 6 })).toMatchObject({ cap: 6, spares: 1 })
    // The provider reports the pool; the view and a global event follow it.
    const pool = { live: 6, cap: 6, over: 0, waiting: [{ sessionID: "ses_waiting", since: 1_000 }] }
    w.channel.pool = pool
    for (const listener of w.channel.listeners) listener({ pool, at: 2_000_000 })
    const status = await ok(w.agent.status, {})
    expect(status.pool).toEqual({ ...pool, spares: 1 })
    const event = sent.findLast((item) => item.name === "claudeAgent.pool")
    expect((event?.body as { pool?: unknown }).pool).toEqual({ ...pool, spares: 1 })
  })

  test("removing an account moves its conversations to the default and deletes only the route's own folder", async () => {
    await using w = await world()
    await w.agent.start()
    const a = (await ok(w.agent.setup, {})).accounts[0]!
    const b = (await ok(w.agent.setup, { add: true })).accounts.find((item) => !item.default)!
    w.session("ses_b")
    await ok(w.agent.sessionSet, { sessionID: sid("ses_b"), accountID: b.accountID })
    await ok(w.agent.defaultSet, { accountID: a.accountID })
    fs.mkdirSync(path.join(w.shared, "C--work"), { recursive: true })
    fs.writeFileSync(path.join(w.shared, "C--work", "kept.jsonl"), "{}\n")
    const removed = await ok(w.agent.remove, { accountID: b.accountID, deleteFolder: true })
    expect(removed).toEqual({ folderDeleted: true, movedSessions: [sid("ses_b")] })
    expect(fs.existsSync(b.folder)).toBe(false)
    // The shared transcripts stay (the junction went, not its target).
    expect(fs.existsSync(path.join(w.shared, "C--work", "kept.jsonl"))).toBe(true)
    w.turnEnds("ses_b")
    expect(await w.request("ses_b")).toBe(a.folder)

    await ok(w.agent.remove, { deleteFolder: true })
    expect(w.holder.registry.claudeAgents).toEqual([])
    const after = editor()
    w.agent.fold(after.editor)
    expect(after.provider.activation).toBe("disabled")
    expect(await call(w.agent.remove, { deleteFolder: true })).toMatchObject({ ok: false, type: "account_not_found" })
    // A folder set by hand in the provider settings goes with it: no claude ever starts on a folder own did not make.
    const hand = editor()
    hand.provider.settings.configDir = "C:/Users/someone/.claude"
    hand.provider.settings.baseURL = "http://127.0.0.1:1"
    w.agent.fold(hand.editor)
    expect(hand.provider.activation).toBe("disabled")
    expect(hand.provider.settings).toEqual({ baseURL: "http://127.0.0.1:1" })
    // A tree bound to an account that is gone is refused, never moved to another account by itself.
    w.storage.set(Kv.claudeAgentSession("ses_gone"), { accountID: b.accountID, at: 1 })
    await ok(w.agent.setup, {})
    w.session("ses_gone")
    expect(await w.request("ses_gone").then(() => "sent", (error: Error) => error.message)).toContain("쓸 수 없어요")
  })

  test("a folder that cannot move to claude-auth stays as it was, and its idle claude closes first (CAG-37)", async () => {
    await using w = await world()
    await w.agent.start()
    await ok(w.agent.setup, {})
    const b = (await ok(w.agent.setup, { add: true })).accounts.find((item) => !item.default)!
    fs.writeFileSync(path.join(b.folder, ".credentials.json"), "{}")
    w.session("ses_b")
    await ok(w.agent.sessionSet, { sessionID: sid("ses_b"), accountID: b.accountID })
    const asked: Array<readonly [string, boolean]> = []
    const pooled = { busy: [] as string[] }
    w.channel.busy = async (configDir, close) => {
      asked.push([configDir, close])
      return pooled.busy
    }
    // The folder screen only asks: no claude closes for a look.
    await ok(w.agent.foldersList, {})
    expect(asked).toContainEqual([b.folder, false])
    expect(asked.some((item) => item[1])).toBe(false)
    // A claude of the account still at work in the folder keeps it here; a move closes the idle ones first.
    pooled.busy = ["ses_b"]
    expect(await call(w.agent.foldersAssign, { accountID: b.accountID, route: "claude-auth" })).toMatchObject({
      ok: false,
      type: "session_busy",
      data: { sessionIDs: ["ses_b"] },
    })
    expect(asked.at(-1)).toEqual([b.folder, true])
    expect(w.claude.adopted).toEqual([])

    // The rename fails: claude-auth's name for the folder is taken back, and the account, its folder, its link and its
    // conversations stay as they were.
    pooled.busy = []
    w.claude.block.adopt = true
    const failed = await call(w.agent.foldersAssign, { accountID: b.accountID, route: "claude-auth" }).then(
      () => "moved",
      (error: Error) => error.message,
    )
    expect(failed).not.toBe("moved")
    const adopted = (w.claude.adopted[0] as { readonly accountID: string }).accountID
    expect(w.claude.released).toEqual([`${adopted}:true`])
    expect(w.claude.api.list().map((item) => item.accountID)).not.toContain(adopted)
    expect(w.agent.entry(b.accountID)?.configDir).toBe(b.folder)
    expect(fs.existsSync(path.join(b.folder, ".credentials.json"))).toBe(true)
    expect(await Transcripts.linked(b.folder, w.shared)).toBe(true)
    expect(await w.request("ses_b")).toBe(b.folder)
  })

  test("a folder belongs to one route: claude-auth's own folder moves to Claude Agent and back, others never", async () => {
    await using w = await world()
    await w.agent.start()
    await ok(w.agent.setup, {})
    const moving = w.claude.add("acc_01J9AUTHMOVE000000000000000")
    w.claude.add("acc_01J9AUTHSHARED00000000000000", { readOnly: true })
    w.claude.add("acc_01J9AUTHBUSY0000000000000000")
    w.claude.busy.set("acc_01J9AUTHBUSY0000000000000000", ["ses_busy"])
    w.claude.add(Account.ID.claudeSlot)
    const listed = await ok(w.agent.foldersList, {})
    const reasons = Object.fromEntries(listed.folders.map((item) => [item.accountID, [item.route, item.reason ?? "ok"]]))
    expect(reasons).toMatchObject({
      acc_01J9AUTHMOVE000000000000000: ["claude-auth", "ok"],
      acc_01J9AUTHSHARED00000000000000: ["claude-auth", "claude_code"],
      acc_01J9AUTHBUSY0000000000000000: ["claude-auth", "busy"],
      [Account.ID.claudeSlot]: ["claude-auth", "slot"],
    })
    expect(listed.folders.filter((item) => item.route === "claude-agent")).toHaveLength(1)

    for (const [accountID, reason] of [
      ["acc_01J9AUTHSHARED00000000000000", "claude_code"],
      [Account.ID.claudeSlot, "slot"],
    ] as const)
      expect(await call(w.agent.foldersAssign, { accountID: Account.ID.make(accountID), route: "claude-agent" })).toMatchObject({
        ok: false,
        type: "claude_account_unavailable",
        data: { reason },
      })
    expect(
      await call(w.agent.foldersAssign, { accountID: Account.ID.make("acc_01J9AUTHBUSY0000000000000000"), route: "claude-agent" }),
    ).toMatchObject({ ok: false, type: "session_busy", data: { sessionIDs: ["ses_busy"] } })

    // claude-auth's own folder becomes a Claude Agent account: claude-auth lets go first, the folder (and the login
    // inside) moves under the route's root and gets its transcript link.
    const assigned = await ok(w.agent.foldersAssign, {
      accountID: Account.ID.make("acc_01J9AUTHMOVE000000000000000"),
      route: "claude-agent",
    })
    // claude-auth lets go only once the folder left its root (its sweep deletes login folders nothing names there).
    expect(w.claude.released).toEqual(["acc_01J9AUTHMOVE000000000000000:false"])
    expect(path.dirname(assigned.folder)).toBe(path.join(w.deps.runtime.layout.claudeAgent, "accounts"))
    expect(fs.existsSync(moving)).toBe(false)
    expect(fs.existsSync(path.join(assigned.folder, ".credentials.json"))).toBe(true)
    expect(await Transcripts.linked(assigned.folder, w.shared)).toBe(true)
    expect(w.agent.entry(assigned.accountID)?.email).toBe("cl***@…")

    // And back: the Claude Agent folder leaves the route without its link and becomes claude-auth's own folder.
    const back = await ok(w.agent.foldersAssign, { accountID: assigned.accountID, route: "claude-auth" })
    expect(path.dirname(back.folder)).toBe(w.deps.runtime.layout.claudeAccounts)
    expect(fs.lstatSync(path.join(back.folder, ".credentials.json")).isFile()).toBe(true)
    expect(fs.existsSync(path.join(back.folder, "projects"))).toBe(false)
    expect(w.claude.adopted).toMatchObject([{ accountID: back.accountID, folder: back.folder, there: false }])
    expect(w.agent.entry(assigned.accountID)).toBeUndefined()
  })
})
