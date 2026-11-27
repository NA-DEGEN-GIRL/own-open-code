// Test support for several Claude accounts (02 §8.7): the claude module on a real runtime (temp OWN_HOME, memory vault,
// manual clock) with a fake of the bundled claude-auth (`multi` = the patched plugin's exports) and fake peers. Login folders,
// tokens and the Claude Code CLI are fakes in temp directories: the CLI is a Bun script, never a compiled program.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account, Kv, Preset, type Plugin, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { ClaudeAccounts } from "../../src/claude/accounts.js"
import { ClaudeLogin } from "../../src/claude/login.js"
import type { Module } from "../../src/module.js"
import type { Modules } from "../../src/modules.js"
import type { RemoteHost } from "../../src/remote/host.js"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { removeTree } from "../e2e-kit/harness/remove.js"
import { testDeps } from "../support/deps.js"
import { type FakeState, writeFakeClaudeAuth } from "../support/fake-claude-auth.js"

/** The fake Claude Code CLI: `<bun> <script> <mode> auth login --claudeai`, writing a fake login into its folder. */
export const FAKE_CLI = `import fs from "node:fs"
import path from "node:path"
const [mode, ...rest] = process.argv.slice(2)
const dir = process.env.CLAUDE_CONFIG_DIR
const shown = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_CONFIG_DIR",
  "DISABLE_AUTOUPDATER",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DO_NOT_TRACK",
  "DISABLE_GROWTHBOOK",
  "DISABLE_BUG_COMMAND",
  "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
  "USERNAME",
  "USERDOMAIN",
  "LOGONSERVER",
  "COMPUTERNAME",
]
const values = Object.fromEntries(shown.map((name) => [name, process.env[name]]))
fs.writeFileSync(path.join(dir, "env.json"), JSON.stringify({ names: Object.keys(process.env), args: rest, values }))
if (mode === "fail") process.exit(1)
if (mode === "hang") await Bun.sleep(60_000)
fs.writeFileSync(
  path.join(dir, ".credentials.json"),
  JSON.stringify({ claudeAiOauth: { accessToken: "fake-new", refreshToken: "fake-new-r", expiresAt: Date.now() + 3600000 } }),
)
const email = mode === "dup" ? "dup@example.test" : "max@example.test"
const accountUuid = mode === "dup" ? "uuid-1" : "uuid-new"
fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid } }))
`

export interface Session {
  readonly id: string
  readonly parentID?: string
}

export async function world(
  options: {
    readonly multi?: boolean
    readonly mode?: string
    readonly cli?: false
    /** The login window's limit; long by default so a slow machine still sees the fake CLI finish. */
    readonly timeoutMs?: number
    /** A remote service's process-wide part (the members the claude module reads: the PC's mirrored Claude view). */
    readonly remote?: unknown
    /** The service's `CLAUDE_CONFIG_DIR` (none by default, whatever this process has). */
    readonly claudeConfigDir?: string
    /** The presets a root's binding names (PF 2026-11-03: a tree starts on the Claude account its preset pins). */
    readonly preset?: (presetID: string, group: string) => Preset.Info | undefined
  } = {},
) {
  const storage = new Map<string, unknown>()
  const sessions = new Map<string, Session>()
  /** Storage keys and session ids whose reads fail (a transient storage or session-service error). */
  const failing = new Set<string>()
  const connection = { value: undefined as unknown }
  const ctx = {
    storage: {
      get: async (key: string) => {
        if (failing.has(key)) throw new Error(`test: reading ${key} failed`)
        return storage.get(key)
      },
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async (input: { readonly prefix: string; readonly after?: string; readonly limit?: number }) => ({
        entries: [...storage.entries()]
          .filter((entry) => entry[0].startsWith(input.prefix) && (input.after === undefined || entry[0] > input.after))
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map((entry) => ({ key: entry[0], value: entry[1] })),
      }),
    },
    session: {
      get: async (input: { readonly sessionID: string }) => {
        if (failing.has(input.sessionID)) throw new Error(`test: reading ${input.sessionID} failed`)
        return sessions.get(input.sessionID)
      },
    },
    integration: { connection: { active: async () => connection.value } },
  }
  /** What the module logged (one JSON line each). */
  const logs: string[] = []
  const test = await testDeps({
    ctx,
    control: true,
    leader: true,
    logs,
    // SAFETY: a test passes only the remote members the claude module reads.
    ...(options.remote === undefined ? {} : { remote: options.remote as RemoteHost.Api }),
  })
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-home-")))
  // The account list and the plugin state live in the stable folder; the bundle in the app version's folder.
  const stateDir = ClaudeBundle.stateDir(test.deps.runtime.layout.thirdparty)
  const bundleDir = path.join(test.deps.runtime.layout.app, "plugins", ClaudeBundle.DIR_NAME)
  const fake = writeFakeClaudeAuth(bundleDir, {
    multi: options.multi ?? true,
    account: { source: "file", token: "t1" },
  })
  const state = (await import(fake.module)) as {
    fake: FakeState
    prepareClaudeRequest: (
      request: Request,
      accessToken: undefined,
      source: string | undefined,
      options: { readonly conversationID: string },
    ) => Promise<Request>
  }
  const script = path.join(home, "fake-claude.ts")
  fs.writeFileSync(script, FAKE_CLI)
  const holder: { registry: Registry.File } = { registry: Store.emptyRegistry() }
  const alerts: Telemetry.AlertInput[] = []
  const slot = { detected: true, version: "0.4.0-fake", integrity: "sha512-x", verified: true }
  /** The bundle's verified state and claude-auth's hook order, as the plugins module reports them. */
  const patch = {
    state: (options.multi ?? true) ? "patched" : "modified",
    order: "ok",
  } as { state: ClaudeBundle.State | null; order: Plugin.ClaudeAuthOrder }
  const peers: Module.Peers = () =>
    // SAFETY: the claude module uses only these members of its peers.
    ({
      plugins: {
        claudeSlot: () => slot,
        bundleSettled: async () =>
          patch.state === null
            ? undefined
            : {
                dir: bundleDir,
                version: slot.version,
                integrity: slot.integrity,
                patchSha256: "f".repeat(64),
                buildId: null,
                state: patch.state,
              },
        claudeOrder: () => patch.order,
        claudeRemote: () => ({ ready: true, billing: false, acknowledged: true, fast: false, entry: fake.entry }),
      },
      slots: {
        snapshot: () => holder.registry,
        mutate: async (change: (current: Registry.File) => Registry.File | undefined) => {
          holder.registry = await test.deps.runtime.registry.update(change)
          return holder.registry
        },
      },
      telemetry: { alert: (input: Telemetry.AlertInput) => alerts.push(input) },
      presets: { preset: options.preset ?? (() => undefined) },
    }) as unknown as Modules.All
  const login: ClaudeLogin.Config = {
    ...ClaudeLogin.defaults(home),
    ...(options.cli === false ? { cli: undefined } : { cli: [process.execPath, script, options.mode ?? "ok"] }),
    spawn: (command, env) => {
      const child = Bun.spawn([...command], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      return { exited: child.exited, kill: () => child.kill() }
    },
    pollMs: 20,
    timeoutMs: options.timeoutMs ?? 30_000,
    exitGraceMs: 1_000,
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
  }
  // Account 1 holds a login in the plugin unless a test removes it.
  state.fake.accounts[ClaudeLogin.key(path.join(home, ".claude"))] = "tok-1"
  const claude = ClaudeAccounts.make(test.deps, peers, {
    userHome: home,
    claudeConfigDir: options.claudeConfigDir,
    login,
  })
  return {
    deps: test.deps,
    clock: test.clock,
    logs,
    storage,
    sessions,
    failing,
    connection,
    home,
    stateDir,
    bundleDir,
    fake: state.fake,
    alerts,
    slot,
    patch,
    claude,
    /** The fake peers and login settings, for a second instance on the same service (a restart). */
    peers,
    login,
    get registry() {
      return holder.registry
    },
    /**
     * One request as core runs the hooks: own-accounts' `http.request` (binds), the fake plugin's (signs with the bound
     * account), the answer, own-accounts' `http.response` (CR: an account's first request is one that was sent).
     * Answers the request's account.
     */
    async send(sessionID: string) {
      const event = request(sessionID)
      const accountID = await claude.onHttpRequest(event)
      const prepared = await state.prepareClaudeRequest(event.request, undefined, state.fake.bound[sessionID], {
        conversationID: sessionID,
      })
      await claude.onHttpResponse({ ...event, request: prepared, response: new Response("{}") })
      return accountID
    },
    /** Adds a Claude account to the registry like a login does (folder made, fake login inside). */
    async add(accountID: string, folder: string, extra: Partial<Registry.ClaudeAccount> = {}) {
      fs.mkdirSync(folder, { recursive: true })
      holder.registry = await test.deps.runtime.registry.update((current) => ({
        ...current,
        claudeAccounts: [
          ...(current.claudeAccounts ?? []),
          {
            accountID: Account.ID.make(accountID),
            key: ClaudeLogin.key(folder),
            configDir: folder,
            label: null,
            shortLabel: "C2",
            color: "amber",
            managed: true,
            addedAt: "2026-10-10T00:00:00Z",
            ...extra,
          },
        ],
      }))
      state.fake.accounts[ClaudeLogin.key(folder)] = `tok-${accountID}`
      return ClaudeLogin.key(folder)
    },
    async setDefault(accountID: string | undefined) {
      holder.registry = await test.deps.runtime.registry.update((current) => {
        const { claudeDefault: _old, ...rest } = current
        return accountID === undefined ? rest : { ...rest, claudeDefault: Account.ID.make(accountID) }
      })
    },
    /** A team member root: its preset binding names the team (07 §5.1), and the team's accounts when given. */
    async team(rootID: string, teamID: string, accounts: ReadonlyArray<string> = []) {
      storage.set(Kv.preset(rootID), {
        presetID: Preset.builtinID("anth"),
        group: "anth",
        revision: 0,
        appliedAt: 0,
        entryHash: null,
        team: { teamID, role: "owner", accounts, pinned: [] },
      })
    },
    async [Symbol.asyncDispose]() {
      await claude.stop()
      await test[Symbol.asyncDispose]()
      await removeTree(home)
    },
  }
}

/** A `http.request` event of `anthropic` for a session. */
export function request(sessionID: string) {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-fake" },
    kind: "context",
    request: new Request("http://127.0.0.1:9/v1/messages", { method: "POST", body: "{}" }),
  } as unknown as Parameters<ReturnType<typeof ClaudeAccounts.make>["onHttpRequest"]>[0]
}
