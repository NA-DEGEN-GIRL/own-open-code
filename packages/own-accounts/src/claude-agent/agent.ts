export * as ClaudeAgent from "./agent.js"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import { Integration } from "@opencode/schema/integration"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Schema } from "effect"
import { Account, type Broker, ClaudeAgent as Route, Kv, Unified, type Limit, Preset, type Registry } from "@own/protocol"
import { ClaudeLogin } from "../claude/login.js"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Claude } from "../plugins/claude.js"
import { PresetBinding } from "../presets/binding.js"
import type { RpcTypes } from "../rpc/types.js"
import type { Views } from "../slots/views.js"
import type { Contract } from "../broker/contract.js"
import { Bindings } from "./binding.js"
import { ClaudeQuiet } from "./quiet.js"
import { Transcripts } from "./transcripts.js"

/**
 * Owner: CLAUDE AGENT (02 §8.10, user decisions CAG 2026-10-31). Claude Code itself as own accounts: upstream's
 * built-in provider `claude-agent` runs the user's own, unmodified `claude` through the Agent SDK, and the user logs
 * that Claude Code in with `claude auth login` in folders own made. own never reads a token: it looks only at whether
 * Claude Code's credentials file exists and at `.claude.json`'s `oauthAccount` e-mail and account uuid.
 *
 * - Phase 0 (no second refresher, no upstream connect path): the provider is enabled only by this module's fold, on
 *   the default account's folder (`settings.configDir`, core P-045). Without an account it is disabled, and core
 *   refuses to start the real `claude` without a folder, so a connection made elsewhere starts nothing.
 * - Phase 2 (several accounts, manual switching): each conversation tree (and each team, 07 R4) is bound to one
 *   account (`Bindings`), and every request of it names that account's folder as the provider option `configDir`
 *   (P-045 per conversation; {@link Api.onRequest}, fail closed). Every folder's `projects` is a junction to one shared
 *   transcript folder (`Transcripts`), so a move to another account resumes the same Claude conversation. Only the user
 *   moves a tree (`claudeAgent.session.set`); a session keeps its account until its turn ends (the safe point).
 * - A folder belongs to one route: these live under `<OWN_HOME>\claude-agent\accounts`, which claude-auth's source
 *   change refuses, and `claudeAgent.folders.assign` moves a folder (and its login) from one route to the other.
 * - Limits (P-039): Claude Code's `rate_limit_event`s and usage answers reach this module over the provider's observer
 *   channel and become the windows of the account whose folder they name. A rejected window marks the account
 *   exhausted without naming a session, so nothing switches on its own (CAG-3); an idle account's windows are read on
 *   demand with a claude that sends no prompt.
 * - SSH hosts (02 §8.10.13, CAG-R1): claude runs on this PC for a host's conversations too. On the PC, the broker hands
 *   a host's request the folder of an account the host may use ({@link Api.hostFolder}) and the mirror lists them
 *   ({@link Api.offer}); on a host (`deps.remote`) the accounts are the mirror's, each named by its relay token instead
 *   of a folder, a tree binds to one in the host's own KV like here, and the host's default lives in its KV too.
 */

export interface Config {
  readonly login: ClaudeLogin.Config
  /** The core provider's observer channel (P-039); tests give their own. */
  readonly channel: () => Channel
  /** The service environment the login window's allow-list picks from; tests give their own. */
  readonly env: () => Readonly<Record<string, string | undefined>>
}

export function defaults(): Config {
  return { login: ClaudeLogin.defaults(os.homedir()), channel: observerChannel, env: () => process.env }
}

/**
 * The login window's environment: the allow-list core gives the provider's claude (P-042, `ClaudeIO.allowed`, kept the
 * same here: own-accounts is another bundle) plus the account folder and its own Anthropic profile directory (P-045, as
 * core's `ClaudeQueryOptions.base` names it). Never `CLAUDE_*` (a Claude Code terminal's user e-mail and account ids),
 * another `ANTHROPIC_*`, `OPENCODE_*`, `USERNAME`, `USERDOMAIN` or `COMPUTERNAME`; Claude Code's updater, telemetry and
 * error reports stay off, as in every claude the route starts.
 */
export function loginEnvironment(folder: string, source: Readonly<Record<string, string | undefined>>) {
  const picked = Object.entries(source).flatMap(([name, value]) =>
    value !== undefined && ENV_ALLOW.has(name.toUpperCase()) ? [[name, value] as const] : [],
  )
  return {
    ...Object.fromEntries(picked),
    ...ClaudeQuiet.ANONYMOUS,
    DISABLE_AUTOUPDATER: "1",
    ...ClaudeQuiet.FLAGS,
    CLAUDE_CONFIG_DIR: folder,
    ANTHROPIC_CONFIG_DIR: profileDirectory(folder),
  }
}

/**
 * The account folder's own Anthropic profile directory (core P-045). Claude Code falls back from a missing or expired
 * claude.ai login to the profile in `ANTHROPIC_CONFIG_DIR`, else to the PC's `%APPDATA%\Anthropic` (`ant auth login`),
 * which bills that Console organization. This one holds none; it need not exist, and is never an empty value (Claude
 * Code reads that as unset).
 */
function profileDirectory(folder: string) {
  return path.join(folder, "anthropic")
}

/** Core's P-042 list (`packages/core/src/plugin/provider/claude-agent/claude/io.ts`); a test keeps the two equal. */
const ENV_ALLOW = new Set(
  [
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ].map((name) => name.toUpperCase()),
)

/**
 * The core provider's observer channel (`claude/observer.ts`, P-039), read by shape: the provider is another bundle, so
 * both sides meet under a registered symbol. Whoever comes first makes it.
 */
export interface Observation {
  readonly configDir?: string
  readonly sessionID?: string
  readonly rateLimit?: Route.RateLimitInfo
  readonly account?: {
    readonly subscriptionType?: string
    readonly tokenSource?: string
    readonly apiKeySource?: string
  }
  readonly usage?: Route.UsageAnswer
  /** The provider's process pool (core P-044): live processes, the cap, the conversations waiting for a slot. */
  readonly pool?: Omit<Route.Pool, "spares">
  /** The provider's model list as Claude Code reported it (core P-060): each alias's model, window and Fast. */
  readonly models?: ReadonlyArray<ModelFact>
  /** A turn's Fast mode as Claude Code reported it (core P-060), with what the request asked. */
  readonly fast?: FastState
  readonly at: number
}

/** One model of the route as Claude Code reported it (core P-060 `ClaudeObserver.ModelFact`). */
export interface ModelFact {
  readonly id: string
  readonly name: string
  readonly resolvedModel?: string
  readonly contextWindow?: number
  readonly supportsFastMode?: boolean
}

/** A turn's Fast mode (core P-060 `ClaudeObserver.FastState`): `state` and `reason` are Claude Code's own. */
export interface FastState {
  readonly model: string
  readonly requested: boolean
  readonly state?: string
  readonly reason?: string
}

export interface Channel {
  readonly version: 1
  readonly listeners: Set<(observation: Observation) => void>
  usage?: (configDir: string) => Promise<unknown>
  /** The pool settings the provider reads (core P-044): the cap and spares per account. */
  settings?: { readonly processes?: number; readonly spares?: number }
  /** The pool as the provider last reported it. */
  pool?: Omit<Route.Pool, "spares">
  /** Every live pool's re-check: run after `settings` change, so a new cap applies at once (CAG-36). */
  rechecks?: Set<() => void>
  /**
   * The conversations whose claude processes on an account folder are busy; with `close` the folder's idle ones close
   * first (CAG-37). Missing while no provider runs, so no claude does either.
   */
  busy?: (configDir: string, close: boolean) => Promise<ReadonlyArray<string>>
  /**
   * The shared transcript folder's checked real path (CAG-34, CAG-42): the provider sweeps, removes and writes
   * transcripts only through it. Set once a check passed, cleared while one refuses.
   */
  shared?: string
  /** On the PC: the provider's server for SSH hosts' processes and transcript work (core P-052). */
  hosts?: Route.HostServer
  /** On the PC: the hosts' working folders' root; the provider's own sweep leaves their transcripts alone. */
  hostsRoot?: string
  /** On a host: this service's relay to the PC (own-accounts' remote handle); the provider then runs claude there. */
  relay?: Route.HostTransport
  /** The latest model list a provider instance reported (core P-060). */
  models?: ReadonlyArray<ModelFact>
}

const KEY = Symbol.for("opencode.claude-agent.observer")

function observerChannel(): Channel {
  const scope = globalThis as { [KEY]?: Channel }
  scope[KEY] ??= { version: 1, listeners: new Set() }
  return scope[KEY]
}

/** What own-accounts' session request hooks hand to {@link Api.onRequest}. */
export interface Request {
  readonly sessionID: string
  readonly model: { readonly providerID: string }
  options: Record<string, unknown>
}

export interface Api extends Module.Lifecycle {
  /** Every account, the default first. */
  list(): ReadonlyArray<Registry.ClaudeAgentAccount>
  /** The default account (what a conversation without a binding starts on). */
  account(): Registry.ClaudeAgentAccount | undefined
  entry(accountID: string): Registry.ClaudeAgentAccount | undefined
  /** The account a session's tree ran on last (sync); the default without a session or before one ran. */
  peek(sessionID?: string): Account.ID | undefined
  /** The account a session's tree runs on, read from its binding (no write). */
  accountOf(sessionID: string): Promise<Account.ID | undefined>
  /** R4 member of the account a session's tree runs on (the default without one) when `providerID` is the route's. */
  member(providerID: string, sessionID?: string): Preset.Member | undefined
  /** R4 lookup: every account of the route is a subscription of its own (07 §5.4). */
  lookup(accountID: string): Preset.Member | undefined
  /** The provider fold (02 §8.10.2): `claude-agent` on the default account's folder, else disabled. No I/O. */
  fold(editor: ProviderEditor): void
  /** The prompt cache lifetime Claude Code uses for an account: one hour on a plan, five minutes on an API key. */
  ttl(accountID?: string): "1h" | "5m"
  /** The route's models as Claude Code last reported them (what each alias runs, its window, Fast); none yet: `[]`. */
  models(): ReadonlyArray<ModelFact>
  /** `accounts.list` views, one per account (02 §9.2). */
  views(extra: ViewExtra): Account.View[]
  /**
   * The session request hooks (context, compaction, generate): a request on the route names the folder of the account
   * its tree runs on (provider option `configDir`, P-045). A session keeps the account it started its turn on until the
   * turn ends. Throws to refuse (fail closed): a tree bound to an account that is gone, or a transcript link own could
   * not repair.
   */
  onRequest(event: Request): Promise<void>
  status: RpcTypes.Handler<"claudeAgent.status">
  setup: RpcTypes.Handler<"claudeAgent.setup">
  login: RpcTypes.Handler<"claudeAgent.login">
  remove: RpcTypes.Handler<"claudeAgent.remove">
  limitsRefresh: RpcTypes.Handler<"claudeAgent.limits.refresh">
  sessionGet: RpcTypes.Handler<"claudeAgent.session.get">
  sessionSet: RpcTypes.Handler<"claudeAgent.session.set">
  defaultSet: RpcTypes.Handler<"claudeAgent.default.set">
  poolSet: RpcTypes.Handler<"claudeAgent.pool.set">
  foldersList: RpcTypes.Handler<"claudeAgent.folders.list">
  foldersAssign: RpcTypes.Handler<"claudeAgent.folders.assign">
  /**
   * PC (02 §8.10.13): the folder of an account a host with this scope may use for its conversations, the transcript
   * link checked. Throws the refusal (Korean) otherwise.
   */
  hostFolder(accountID: string, scope: Contract.AccountScope): Promise<string>
  /** PC: the accounts a host with this scope may use (the mirror's `claudeAgent`); none = the route is off there. */
  offer(scope: Contract.AccountScope): Broker.ClaudeAgentRemote | undefined
}

export interface ViewExtra {
  readonly windows: (accountID: Account.ID) => ReadonlyArray<Limit.Window>
  readonly summary: (windows: ReadonlyArray<Limit.Window>) => Limit.Summary
  /** When the account last ran a step in this process (`lastUsedAt`, the sidebar's accounts in use, CAG-53). */
  readonly lastUsed?: (accountID: Account.ID) => number | undefined
  /** The account's compaction view (CAG-50). */
  readonly compaction?: (accountID: Account.ID) => NonNullable<Views.Extra["compaction"]>
}

type LoginState = "idle" | "waiting" | "logged_in" | "failed" | "timeout"

/** What own knows of an account's folder now (nothing of it is a secret). */
interface Seen {
  loggedIn: boolean
  plan?: string | null
  apiKey: boolean
  checked?: number
  transcripts?: "linked" | "broken"
}

const COLORS: ReadonlyArray<Account.Color> = ["orange", "amber", "rose", "violet", "teal", "indigo", "green", "slate"]
const isSessionID = Schema.is(SessionID)
/** Events after which a session's turn is over: its next turn may start on another account. */
const TURN_ENDS: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

export function create(deps: Deps, peers: Module.Peers): Api {
  return make(deps, peers)
}

export function make(deps: Deps, peers: Module.Peers, overrides: Partial<Config> = {}): Api {
  const config = { ...defaults(), ...overrides }
  const log = deps.log.child("claude-agent")
  const hub = deps.runtime.broadcast
  const state = {
    cli: undefined as ReadonlyArray<string> | undefined,
    login: "idle" as LoginState,
    loginAccount: undefined as Account.ID | undefined,
    connected: false,
  }
  const seen = new Map<string, Seen>()
  /** The account each running turn started on (the safe point: a move takes effect at the session's next turn). */
  const turns = new Map<string, Account.ID>()
  const stops: Array<() => void> = []
  const shared = () => path.join(deps.runtime.layout.claudeAgent, "projects")
  const accountsRoot = () => path.join(deps.runtime.layout.claudeAgent, "accounts")

  const list = (): ReadonlyArray<Registry.ClaudeAgentAccount> => {
    const all = deps.remote ? mirrored() : (peers().slots.snapshot().claudeAgents ?? [])
    const chosen = deps.remote ? hostDefault() : peers().slots.snapshot().claudeAgentDefault
    const first = all.find((item) => item.accountID === chosen) ?? all[0]
    return first ? [first, ...all.filter((item) => item !== first)] : []
  }
  /** On a host: the PC's accounts the mirror offers, each named by its relay token (no folder, no e-mail). */
  const mirrored = (): ReadonlyArray<Registry.ClaudeAgentAccount> =>
    (deps.remote?.claudeAgent()?.accounts ?? []).map((item) => ({
      accountID: item.accountID,
      configDir: Route.relayToken(item.accountID),
      label: item.label,
      shortLabel: item.shortLabel,
      color: item.color,
      addedAt: "",
      ...(item.compaction === undefined ? {} : { compaction: item.compaction }),
    }))
  /** On a host: the default chosen here (KV), else the PC's. */
  const hostDefault = () =>
    hostDefaults().value ?? deps.remote?.claudeAgent()?.accounts.find((item) => item.default)?.accountID
  const entry = (accountID: string) => list().find((item) => item.accountID === accountID)
  const defaultID = () => list()[0]?.accountID
  const seenOf = (accountID: string) => {
    const known = seen.get(accountID)
    if (known) return known
    const fresh: Seen = { loggedIn: false, apiKey: false }
    seen.set(accountID, fresh)
    return fresh
  }

  const bindings = Bindings.make(deps, {
    exists: (accountID) => entry(accountID) !== undefined,
    defaultID,
    // PF 2026-11-03: a tree without an account starts on the one its preset names, while it has not run out.
    preferred: async (root) => {
      const pins = await PresetBinding.pinned(deps, peers, root).catch((): ReadonlyArray<string> => [])
      return pins
        .map((accountID) => entry(accountID))
        .find((item) => item !== undefined && deps.runtime.limits.exhaustion(item.accountID) === undefined)?.accountID
    },
  })

  const memberOf = (accountID: Account.ID | undefined): Preset.Member | undefined =>
    accountID === undefined || !entry(accountID)
      ? undefined
      : { id: accountID, kind: "claude-agent", billing: "subscription" }

  const labelOf = (item: Registry.ClaudeAgentAccount) => {
    const index = (peers().slots.snapshot().claudeAgents ?? []).findIndex((other) => other.accountID === item.accountID)
    return item.label ?? item.email ?? (index <= 0 ? "Claude Agent" : `Claude Agent ${index + 1}`)
  }

  /** What the disk says now for every account: logged in (the credentials file exists), the masked e-mail. */
  const check = async () => {
    state.cli = await ClaudeLogin.find(config.login)
    for (const item of list()) {
      const known = seenOf(item.accountID)
      known.loggedIn = await ClaudeLogin.signedIn(item.configDir)
      if (!known.loggedIn) continue
      const profile = await ClaudeLogin.profile(item.configDir, config.login.userHome)
      const email = profile?.email === undefined ? undefined : Claude.maskEmail(profile.email)
      if (email === item.email && profile?.accountUuid === item.accountUuid) continue
      await peers().slots.mutate((current) => ({
        ...current,
        claudeAgents: (current.claudeAgents ?? []).map((other) =>
          other.accountID === item.accountID
            ? {
                ...other,
                ...(email === undefined ? {} : { email }),
                ...(profile?.accountUuid === undefined ? {} : { accountUuid: profile.accountUuid }),
              }
            : other,
        ),
      }))
    }
  }

  /**
   * The shared transcript link of one account, made or repaired; a {@link Transcripts.Broken} is remembered. The
   * provider is told the shared folder only once it passed the check, as its checked real path, and told none while a
   * check refuses (CAG-42): core then sweeps, removes and writes nothing.
   */
  const link = async (item: Registry.ClaudeAgentAccount) => {
    const known = seenOf(item.accountID)
    const ensured = await Transcripts.ensure(item.configDir, shared(), deps.runtime.layout.root).catch(
      (error: unknown) => {
        known.transcripts = "broken"
        config.channel().shared = undefined
        throw error
      },
    )
    config.channel().shared = ensured.real
    if (ensured.outcome !== "linked")
      log.info("transcripts_linked", { accountID: item.accountID, outcome: ensured.outcome })
    known.transcripts = "linked"
  }

  /** The connection upstream's provider needs before it checks Claude Code and lists its models (02 §8.10.2). */
  const connect = async () => {
    if (state.connected || list().length === 0 || !deps.location.control) return
    const active = await deps.ctx.integration.connection.active(Route.PROVIDER_ID).catch(() => undefined)
    if (!active)
      await deps.ctx.integration.connect.external({
        integrationID: Integration.ID.make(Route.PROVIDER_ID),
        methodID: Integration.MethodID.make(Route.METHOD_ID),
        label: "own",
      })
    state.connected = true
  }

  const statusOf = (): RpcTypes.Output<"claudeAgent.status"> => {
    const chosen = defaultID()
    return {
      accounts: list().map((item) => {
        const known = seenOf(item.accountID)
        return {
          accountID: item.accountID,
          folder: item.configDir,
          label: item.label,
          shortLabel: item.shortLabel,
          loggedIn: known.loggedIn,
          ...(item.email === undefined ? {} : { email: item.email }),
          ...(known.plan === undefined ? {} : { plan: known.plan }),
          default: item.accountID === chosen,
          commands: state.cli ? commands(item.configDir, state.cli) : null,
        }
      }),
      cli: state.cli?.join(" ") ?? null,
      login: state.login,
      ...(state.loginAccount === undefined ? {} : { loginAccount: state.loginAccount }),
      pool: poolView(),
    }
  }

  /** The pool settings of this service (registry `claudeAgentPool`), with their defaults. */
  const poolSettings = () => {
    const saved = peers().slots.snapshot().claudeAgentPool
    return { processes: saved?.processes ?? Route.PROCESSES, spares: saved?.spares ?? 0 }
  }

  /** The pool as the provider last reported it, with this service's settings. */
  const poolView = (): Route.Pool => {
    const reported = config.channel().pool
    const settings = poolSettings()
    return {
      live: reported?.live ?? 0,
      cap: settings.processes,
      over: reported?.over ?? 0,
      spares: settings.spares,
      waiting: reported?.waiting ?? [],
    }
  }

  /** Hands the settings to the provider (process-wide) and tells the clients when the pool's view changed. */
  const poolLast = { view: "" }
  const poolChanged = () => {
    const view = poolView()
    const key = JSON.stringify(view)
    if (key === poolLast.view) return
    poolLast.view = key
    void deps.emitter.global("claudeAgent.pool", { pool: view }).catch((error: unknown) =>
      log.warn("pool_event_failed", { error }),
    )
  }

  /** Windows from one observation of an account's folder; a rejected one marks the account exhausted. */
  const observe = (observation: Observation) => {
    if (observation.pool) poolChanged()
    const item = observation.configDir === undefined ? undefined : folderAccount(observation.configDir)
    if (!item) return
    const known = seenOf(item.accountID)
    const plan = known.plan
    if (observation.account) {
      known.plan = observation.account.subscriptionType ?? (observation.account.apiKeySource ? null : known.plan)
      known.apiKey =
        observation.account.apiKeySource !== undefined && observation.account.subscriptionType === undefined
      known.checked = observation.at
    }
    if (observation.usage?.subscription_type !== undefined) known.plan = observation.usage.subscription_type
    if (known.plan !== plan) void announce().catch((error: unknown) => log.warn("announce_failed", { error }))
    const windows = [
      ...(observation.rateLimit ? Route.fromRateLimit(observation.rateLimit, observation.at, item.accountID) : []),
      ...(observation.usage ? Route.fromUsage(observation.usage, observation.at, item.accountID) : []),
    ]
    if (windows.length === 0) return
    const changed = deps.runtime.limits.upsert(windows)
    // A usage answer without `five_hour` (02 §7.1.2): the account has no five-hour window, so the stored one goes.
    const gone =
      observation.usage !== undefined &&
      Route.withoutFiveHour(observation.usage) &&
      deps.runtime.limits.drop(item.accountID, Unified.FIVE_HOUR)
    if (changed.length > 0 || gone)
      deps.runtime.broadcast.emit("limits.updated", {
        windows: changed,
        ...(gone ? { dropped: [{ accountID: item.accountID, id: Unified.FIVE_HOUR }] } : {}),
      })
    const refused =
      observation.rateLimit?.status === "rejected" ? windows.find((w) => w.status === "exhausted") : undefined
    if (!refused) return
    const exhaustion: Limit.Exhaustion = {
      accountID: item.accountID,
      windowId: refused.id,
      until: refused.resetAt ?? observation.at + 5 * 60_000,
      class: "hard",
      reason: `${refused.id.replace(/^claude\./, "")}_rejected`,
    }
    deps.runtime.limits.exhaust(exhaustion)
    log.info("exhausted", { accountID: item.accountID, windowId: refused.id, until: exhaustion.until })
    // No session: the route switches accounts by hand only, so nothing plans a move (CAG-3).
    deps.runtime.broadcast.emit("exhausted", { exhaustion, providerID: Route.PROVIDER_ID })
  }

  const folderAccount = (configDir: string) => list().find((item) => same(item.configDir, configDir))

  /** The view changed without a registry write (login state, plan): own-web lists the accounts again. */
  const announce = () => deps.emitter.global("accounts.changed", { revision: peers().slots.snapshot().revision })

  /** Tells every instance and client that these sessions now run on `accountID`. */
  const moved = (sessions: ReadonlyArray<string>, accountID: Account.ID, reason: "user" | "removed", teamID?: string) => {
    hub.emit("claudeAgent.bound", { sessionIDs: sessions, accountID, ...(teamID === undefined ? {} : { teamID }) })
    for (const id of sessions.filter(isSessionID)) {
      const known = deps.runtime.sessions.get(id)
      if (known?.providerID !== Route.PROVIDER_ID || !known.modelID) continue
      const model = {
        providerID: Route.PROVIDER_ID,
        id: known.modelID,
        ...(known.variant ? { variant: known.variant } : {}),
      } as RpcTypes.EventBody<"binding.changed">["model"]
      void deps.emitter
        .session("binding.changed", {
          sessionID: id,
          model,
          previous: model,
          accountID,
          reason: reason === "user" ? "manual" : "external",
          external: reason === "removed",
        })
        .catch((error: unknown) => log.warn("binding_event_failed", { error }))
    }
  }

  const rebind = async (sessionID: string, accountID: Account.ID, reason: "user" | "removed") => {
    const result = await bindings.move(sessionID, accountID)
    moved(result.sessions, accountID, reason, result.teamID)
    log.info("claude_agent_rebound", { reason, accountID, sessions: result.sessions.length, team: !!result.teamID })
    return result.sessions
  }

  const chooseDefault = async (accountID: Account.ID) => {
    if (defaultID() === accountID) return
    if (deps.remote) {
      // A host's default is its own (KV): the PC's accounts.json is the PC's.
      await deps.ctx.storage.set(Kv.CLAUDE_AGENT_HOST_DEFAULT, accountID)
      hostDefaults().value = accountID
      return
    }
    await peers().slots.mutate((current) => ({ ...current, claudeAgentDefault: accountID }))
  }

  const refuse = (sessionID: string, accountID: string | undefined, message: string): never => {
    peers().telemetry.alert({
      code: "claude_account_refused",
      severity: "warning",
      sessionID,
      ...(accountID === undefined ? {} : { accountID }),
      message,
    })
    throw new Error(message)
  }

  /** Adds an account on `folder` (made or moved there), its transcript link and the provider connection. */
  const register = async (accountID: Account.ID, folder: string, from?: Partial<Registry.ClaudeAgentAccount>) => {
    await fs.mkdir(folder, { recursive: true })
    const count = (peers().slots.snapshot().claudeAgents ?? []).length
    await peers().slots.mutate((current) => ({
      ...current,
      claudeAgents: [
        ...(current.claudeAgents ?? []),
        {
          accountID,
          configDir: folder,
          label: from?.label ?? null,
          shortLabel: count === 0 ? "CA" : `CA${count + 1}`,
          color: from?.color ?? COLORS[count % COLORS.length]!,
          ...(from?.email === undefined ? {} : { email: from.email }),
          ...(from?.accountUuid === undefined ? {} : { accountUuid: from.accountUuid }),
          addedAt: new Date(deps.clock.now()).toISOString(),
        },
      ],
    }))
    await peers().slots.reload()
    const item = entry(accountID)!
    await link(item).catch((error: unknown) => log.warn("transcripts_broken", { accountID, error }))
    log.info("account_created", { accountID })
  }

  /** Takes an account out (its trees move to the new default); answers the sessions that moved. */
  const drop = async (accountID: Account.ID) => {
    const bound = await bindings.boundTo(accountID)
    await peers().slots.mutate((current) => {
      const next = {
        ...current,
        claudeAgents: (current.claudeAgents ?? []).filter((item) => item.accountID !== accountID),
      }
      if (current.claudeAgentDefault !== accountID) return next
      const { claudeAgentDefault: _dropped, ...rest } = next
      return rest
    })
    await peers().slots.reload()
    seen.delete(accountID)
    const fallback = defaultID()
    if (fallback === undefined) return []
    // Teams first (their members follow the team's binding), then the trees.
    const moves: string[][] = []
    for (const teamID of bound.teams) {
      await bindings.write(Kv.claudeAgentTeam(teamID), fallback)
      const sessions = [...new Set((await bindings.teamRoots(teamID)).flatMap(bindings.tree))]
      moved(sessions, fallback, "removed", teamID)
      moves.push(sessions)
    }
    for (const sessionID of bound.sessions) moves.push(await rebind(sessionID, fallback, "removed"))
    return [...new Set(moves.flat())].filter(isSessionID)
  }

  /**
   * Sessions on an account that are running now, and those whose claude still works in its folder (the provider's
   * pool): a folder moves only when none is. With `close` the folder's idle claude processes close first (CAG-37).
   */
  const busyOn = async (accountID: Account.ID, close: boolean) => {
    const bound = await bindings.boundTo(accountID)
    const roots = [
      ...bound.sessions,
      ...(await Promise.all(bound.teams.map((teamID) => bindings.teamRoots(teamID)))).flat(),
    ]
    const running = [...new Set(roots.flatMap(bindings.tree))].filter(
      (sessionID) => deps.runtime.sessions.get(sessionID)?.busy === true || turns.get(sessionID) === accountID,
    )
    const folder = entry(accountID)?.configDir
    const pooled = folder === undefined ? [] : ((await config.channel().busy?.(folder, close)) ?? [])
    return [...new Set([...running, ...pooled])]
  }

  const views: Api["views"] = (extra) => {
    if (deps.remote) return []
    const chosen = defaultID()
    const sessions = deps.runtime.sessions.list({ providerID: Route.PROVIDER_ID })
    return list().map((item) => {
      const known = seenOf(item.accountID)
      const mine = sessions.filter((session) => bindings.peek(session.sessionID) === item.accountID)
      return {
        id: item.accountID,
        kind: "claude-agent",
        label: labelOf(item),
        shortLabel: item.shortLabel,
        color: item.color,
        providerID: Route.PROVIDER_ID,
        billing: "subscription",
        status: !state.cli ? "misconfigured" : known.loggedIn ? "ready" : "needs_reauth",
        autoSwitch: false,
        thirdParty: false,
        readOnly: true,
        connection: { type: "oauth", method: "claude-code" },
        limitsSummary: extra.summary(extra.windows(item.accountID)),
        claudeAgent: {
          folder: item.configDir,
          loggedIn: known.loggedIn,
          ...(item.email === undefined ? {} : { email: item.email }),
          cli: state.cli !== undefined,
          ...(known.plan === undefined ? {} : { plan: known.plan }),
          ...(known.checked === undefined ? {} : { checked: known.checked }),
          default: item.accountID === chosen,
          ...(known.transcripts === undefined ? {} : { transcripts: known.transcripts }),
        },
        sessions: { running: mine.filter((session) => session.busy).length, total: mine.length },
        lastUsedAt: extra.lastUsed?.(item.accountID) ?? null,
        ...(extra.compaction === undefined ? {} : { compaction: extra.compaction(item.accountID) }),
      }
    })
  }

  /** PC: the hosts' working folders' root, made and named to the provider (its sweep leaves them to their hosts). */
  const hostsRoot = async () => {
    const root = path.join(deps.runtime.layout.claudeAgent, "hosts")
    await fs.mkdir(root, { recursive: true })
    config.channel().hostsRoot = await fs.realpath(root)
  }

  return {
    start: async () => {
      // CAM-6: Claude Code's Fast answer for a turn goes to the speed of the Location that sent the turn (the one that
      // remembers the request; the others ignore it), on this PC and on a host alike, unlike the windows below.
      const fastChannel = config.channel()
      const fast = (observation: Observation) => {
        if (observation.fast && observation.sessionID)
          peers().speed.claudeAgentFast(observation.sessionID, observation.fast)
        // Claude Code's list read again (a login check, a new process's report): Fast it refused is tried once more,
        // as a Codex account's list read again clears its refused tiers. The route's marks live under its provider id.
        if (observation.models) deps.runtime.speed.clear(Route.PROVIDER_ID)
      }
      fastChannel.listeners.add(fast)
      stops.push(() => fastChannel.listeners.delete(fast))
      if (deps.remote) {
        // 02 §8.10.13: the host binds its trees to the mirror's accounts; the provider runs claude on the PC.
        stops.push(hub.on("claudeAgent.bound", (change) => bindings.forget(change)))
        const saved = await deps.ctx.storage.get(Kv.CLAUDE_AGENT_HOST_DEFAULT).catch(() => undefined)
        if (typeof saved === "string") hostDefaults().value = saved as Account.ID
        const reconnect = () => void connect().catch((error: unknown) => log.warn("connect_failed", { error }))
        stops.push(hub.on("store.changed", (change) => change.store === "accounts" && reconnect()))
        reconnect()
        return
      }
      stops.push(hub.on("claudeAgent.bound", (change) => bindings.forget(change)))
      // Observations are process-wide: one instance turns them into windows (the control Location's).
      if (deps.location.control) {
        const channel = config.channel()
        const listener = (observation: Observation) => {
          try {
            observe(observation)
          } catch (error) {
            log.warn("observation_failed", { error })
          }
        }
        channel.listeners.add(listener)
        stops.push(() => channel.listeners.delete(listener))
        channel.settings = poolSettings()
      }
      await check().catch((error: unknown) => log.warn("check_failed", { error }))
      if (deps.location.control)
        await hostsRoot().catch((error: unknown) => log.warn("hosts_root_failed", { error }))
      if (deps.location.control)
        for (const item of list())
          await link(item).catch((error: unknown) =>
            log.warn("transcripts_broken", { accountID: item.accountID, error }),
          )
      await connect().catch((error: unknown) => log.warn("connect_failed", { error }))
    },
    stop: async () => {
      for (const stop of stops.splice(0)) stop()
    },
    onEvent: (event) => {
      if (event.type === "session.deleted") {
        bindings.drop(event.data.sessionID)
        turns.delete(event.data.sessionID)
        return
      }
      if (!TURN_ENDS.has(event.type)) return
      const sessionID = (event.data as { readonly sessionID?: string }).sessionID
      if (sessionID !== undefined) turns.delete(sessionID)
    },

    list,
    account: () => list()[0],
    entry,
    peek: (sessionID) => bindings.peek(sessionID),
    accountOf: (sessionID) => bindings.accountOf(sessionID),
    member: (providerID, sessionID) =>
      providerID === Route.PROVIDER_ID ? memberOf(bindings.peek(sessionID)) : undefined,
    lookup: (accountID) => memberOf(entry(accountID)?.accountID),

    fold: (editor) => {
      const item = list()[0]
      const record = editor.get(Route.PROVIDER_ID)
      if (!record) return
      const retired = retiredLongContext(record.models)
      if (retired.length > 0) editor.models.set(Route.PROVIDER_ID, [...record.models.values(), ...retired])
      editor.update(Route.PROVIDER_ID, (provider) => {
        // A remote service has no Claude Agent account of its own: its accounts are the PC's (02 §8.10.13), named by
        // their relay tokens, and its provider runs claude on the PC. A folder set by hand goes too, so no claude ever
        // starts on it (one refresher per folder, 02 §8.10.2).
        if (!item) {
          provider.activation = "disabled"
          const { configDir: _dropped, ...rest } = provider.settings ?? {}
          provider.settings = rest
          return
        }
        provider.activation = "enabled"
        // The default account's folder: the provider's own login check and model list, and requests without a session.
        provider.settings = { ...provider.settings, configDir: item.configDir }
      })
    },

    ttl: (accountID) => (seenOf(accountID ?? defaultID() ?? "").apiKey ? "5m" : "1h"),

    models: () => config.channel().models ?? [],

    views,

    onRequest: async (event) => {
      if (event.model.providerID !== Route.PROVIDER_ID) return
      const kept = turns.get(event.sessionID)
      const settled = kept !== undefined && entry(kept) ? kept : await bindings.settle(event.sessionID)
      if (settled === "none") return refuse(event.sessionID, undefined, deps.remote ? NO_REMOTE_ACCOUNT : NO_ACCOUNT)
      if (settled === "gone") return refuse(event.sessionID, undefined, deps.remote ? GONE_REMOTE : GONE)
      const item = entry(settled)!
      // On a host the PC checks the account folder and its transcript link for every process (02 §8.10.13).
      if (!deps.remote)
        await link(item).catch((error: unknown) =>
          refuse(event.sessionID, item.accountID, error instanceof Transcripts.Broken ? error.reason : String(error)),
        )
      turns.set(event.sessionID, item.accountID)
      event.options.configDir = item.configDir
    },

    status: async () => {
      await check()
      return statusOf()
    },

    setup: async (input) => {
      const add = input.add === true || list().length === 0
      const accountID = add ? Account.ID.create() : undefined
      if (accountID !== undefined) await register(accountID, path.join(accountsRoot(), accountID))
      await check()
      await connect().catch((error: unknown) => log.warn("connect_failed", { error }))
      return { ...statusOf(), ...(accountID === undefined ? {} : { created: accountID }) }
    },

    login: async (input, context) => {
      const item = entry(input.accountID ?? defaultID() ?? "")
      if (!item)
        return context.error("account_not_found", "no such Claude Agent account", { accountID: input.accountID ?? "" })
      if (state.login === "waiting")
        return context.error("claude_account_unavailable", "a login window is open", { reason: "busy" })
      const cli = await ClaudeLogin.find(config.login)
      state.cli = cli
      if (!cli)
        return context.error("claude_account_unavailable", "Claude Code is not installed", { reason: "cli_missing" })
      state.login = "waiting"
      state.loginAccount = item.accountID
      const abort = new AbortController()
      stops.push(() => abort.abort())
      void ClaudeLogin.run(
        config.login,
        cli,
        item.configDir,
        abort.signal,
        loginEnvironment(item.configDir, config.env()),
      )
        .then(async (outcome) => {
          state.login = outcome.type === "logged_in" ? "logged_in" : outcome.type === "timeout" ? "timeout" : "failed"
          log.info("login_finished", { accountID: item.accountID, outcome: outcome.type })
          await check()
          await announce()
        })
        .catch((error: unknown) => {
          state.login = "failed"
          log.warn("login_failed", { error })
        })
      return statusOf()
    },

    remove: async (input, context) => {
      const item = entry(input.accountID ?? defaultID() ?? "")
      if (!item)
        return context.error("account_not_found", "no such Claude Agent account", { accountID: input.accountID ?? "" })
      const movedSessions = await drop(item.accountID)
      // Only a folder of this route's own (`<OWN_HOME>\claude-agent\accounts\<id>`) is ever deleted; its `projects` is
      // a junction, which a recursive delete removes without touching the shared transcripts.
      const owned = same(path.dirname(item.configDir), accountsRoot())
      const folderDeleted =
        input.deleteFolder && owned
          ? await Transcripts.unlink(item.configDir)
              .then(() => fs.rm(item.configDir, { recursive: true, force: true }))
              .then(
                () => true,
                (error: unknown) => {
                  log.warn("folder_delete_failed", { error })
                  return false
                },
              )
          : false
      log.info("account_removed", { accountID: item.accountID, folderDeleted, moved: movedSessions.length })
      return { folderDeleted, movedSessions }
    },

    limitsRefresh: async (input, context) => {
      const item = entry(input.accountID ?? defaultID() ?? "")
      if (!item)
        return context.error("account_not_found", "no such Claude Agent account", { accountID: input.accountID ?? "" })
      const usage = config.channel().usage
      if (!usage)
        return context.error("claude_account_unavailable", "Claude Agent is not running", { reason: "cli_missing" })
      // The answer also reaches the listener, which stores the windows; this call only waits for it.
      const answer = await usage(item.configDir).catch((error: unknown) => {
        log.warn("usage_failed", { error })
        return undefined
      })
      if (answer === undefined)
        return context.error("claude_account_unavailable", "Claude Code did not answer", { reason: "cli_missing" })
      return {
        windows: deps.runtime.limits.list({ accountID: item.accountID }),
        plan: seenOf(item.accountID).plan ?? null,
      }
    },

    sessionGet: async (input) => {
      if (list().length === 0) return { accountID: null, bound: false }
      const found = await bindings.bindingOf(input.sessionID)
      return { accountID: (await bindings.accountOf(input.sessionID)) ?? null, bound: found.bound !== null }
    },

    sessionSet: async (input, context) => {
      if (!entry(input.accountID))
        return context.error("account_not_found", "no such Claude Agent account", { accountID: input.accountID })
      const sessions = await rebind(input.sessionID, input.accountID, "user")
      // New conversations start on the account chosen last (like the Claude slot's, 02 §8.7).
      await chooseDefault(input.accountID)
      return { accountID: input.accountID, sessions: sessions.filter(isSessionID) }
    },

    poolSet: async (input) => {
      const current = poolSettings()
      const next = { processes: input.processes ?? current.processes, spares: input.spares ?? current.spares }
      await peers().slots.mutate((saved) => ({ ...saved, claudeAgentPool: next }))
      // As core's `ClaudeObserver.configure`: the provider's pools apply it now (CAG-36).
      const channel = config.channel()
      channel.settings = next
      for (const recheck of channel.rechecks ?? []) recheck()
      log.info("pool_set", next)
      poolChanged()
      return poolView()
    },

    defaultSet: async (input, context) => {
      if (!entry(input.accountID))
        return context.error("account_not_found", "no such Claude Agent account", { accountID: input.accountID })
      await chooseDefault(input.accountID)
      return { accountID: input.accountID }
    },

    hostFolder: async (accountID, scope) => {
      const item = entry(accountID)
      if (!item || (scope.mode === "only" && !scope.ids.includes(accountID)))
        throw new Error(
          "이 호스트가 쓸 수 있는 Claude Agent 계정이 아니에요. PC의 원격 호스트 설정에서 계정 범위를 확인하세요.",
        )
      await link(item).catch((error: unknown) => {
        throw new Error(error instanceof Transcripts.Broken ? error.reason : String(error))
      })
      return item.configDir
    },

    offer: (scope) => {
      if (deps.remote) return undefined
      const chosen = defaultID()
      const allowed = list().filter((item) => scope.mode === "all" || scope.ids.includes(item.accountID))
      if (allowed.length === 0) return undefined
      const fallback = allowed.some((item) => item.accountID === chosen) ? chosen : allowed[0]!.accountID
      return {
        accounts: allowed.map((item) => ({
          accountID: item.accountID,
          label: labelOf(item),
          shortLabel: item.shortLabel,
          color: item.color,
          default: item.accountID === fallback,
          loggedIn: seenOf(item.accountID).loggedIn,
          ...(item.compaction === undefined ? {} : { compaction: item.compaction }),
        })),
      }
    },

    foldersList: async () => {
      await check()
      const claude = peers().claude
      const multi = claude.multi()
      const auth = await Promise.all(
        claude.list().map(async (item) => {
          const reason =
            item.accountID === Account.ID.claudeSlot
              ? ("slot" as const)
              : item.readOnly
                ? ("claude_code" as const)
                : !item.managed
                  ? ("not_managed" as const)
                  : (await claude.busy(item.accountID)).length > 0
                    ? ("busy" as const)
                    : undefined
          return {
            folder: item.configDir,
            route: "claude-auth" as const,
            accountID: item.accountID,
            label: item.label ?? item.email ?? item.shortLabel,
            ...(item.email === undefined ? {} : { email: item.email }),
            loggedIn: await ClaudeLogin.signedIn(item.configDir),
            movable: reason === undefined,
            ...(reason === undefined ? {} : { reason }),
          }
        }),
      )
      const agents = await Promise.all(
        list().map(async (item) => {
          const reason = !multi
            ? ("not_patched" as const)
            : (await busyOn(item.accountID, false)).length > 0
              ? ("busy" as const)
              : undefined
          return {
            folder: item.configDir,
            route: "claude-agent" as const,
            accountID: item.accountID,
            label: labelOf(item),
            ...(item.email === undefined ? {} : { email: item.email }),
            loggedIn: seenOf(item.accountID).loggedIn,
            movable: reason === undefined,
            ...(reason === undefined ? {} : { reason }),
          }
        }),
      )
      return { folders: [...agents, ...auth] }
    },

    foldersAssign: async (input, context) => {
      const unavailable = (reason: "slot" | "claude_code" | "not_managed" | "not_patched" | "transcripts") =>
        context.error("claude_account_unavailable", "the folder cannot move to the other route", { reason })
      if (input.route === "claude-agent") {
        const claude = peers().claude
        const source = claude.entry(input.accountID)
        if (!source) return context.error("account_not_found", "no such Claude account", { accountID: input.accountID })
        if (source.accountID === Account.ID.claudeSlot) return unavailable("slot")
        if (source.readOnly) return unavailable("claude_code")
        if (!source.managed) return unavailable("not_managed")
        const busy = await claude.busy(source.accountID)
        if (busy.length > 0)
          return context.error("session_busy", "a conversation on it is running", { sessionIDs: busy.filter(isSessionID) })
        const accountID = Account.ID.create()
        const folder = path.join(accountsRoot(), accountID)
        // Moved out first: claude-auth's sweep deletes login folders under its root that no account names, and the
        // release below makes this one such a folder.
        await fs.mkdir(accountsRoot(), { recursive: true })
        await fs.rename(source.configDir, folder)
        await claude.release(source.accountID).catch(async (error: unknown) => {
          await fs.rename(folder, source.configDir)
          throw error
        })
        await register(accountID, folder, source)
        await check()
        await connect().catch((error: unknown) => log.warn("connect_failed", { error }))
        log.info("folder_assigned", { from: source.accountID, accountID, route: input.route })
        return { accountID, route: input.route, folder }
      }
      const source = entry(input.accountID)
      if (!source)
        return context.error("account_not_found", "no such Claude Agent account", { accountID: input.accountID })
      if (!peers().claude.multi()) return unavailable("not_patched")
      if (!same(path.dirname(source.configDir), accountsRoot())) return unavailable("not_managed")
      const busy = await busyOn(source.accountID, true)
      if (busy.length > 0)
        return context.error("session_busy", "a conversation on it is running", { sessionIDs: busy.filter(isSessionID) })
      const accountID = Account.ID.create()
      const folder = path.join(deps.runtime.layout.claudeAccounts, accountID)
      await fs.mkdir(deps.runtime.layout.claudeAccounts, { recursive: true })
      // Named by a claude-auth account before it lands under claude-auth's root, so its sweep never takes it. The move
      // comes before this route lets go: a rename that fails (a claude still holding the folder) takes that name back,
      // and the account stays here as it was (CAG-37).
      await peers().claude.adopt({ accountID, folder, from: source })
      await fs.rename(source.configDir, folder).catch(async (error: unknown) => {
        await peers().claude.release(accountID)
        log.warn("folder_assign_failed", { accountID: source.accountID, error })
        throw error
      })
      await drop(source.accountID)
      await Transcripts.unlink(folder)
      log.info("folder_assigned", { from: source.accountID, accountID, route: input.route })
      return { accountID, route: input.route, folder }
    },
  }
}

/**
 * On a host: the default account its switcher chose (KV `claude-agent:host-default`), shared by every Location of the
 * service: the switcher sets it through the control Location, a new conversation starts in its project's.
 */
const HOST_DEFAULT = Symbol.for("own-open-code.claude-agent.host-default")
function hostDefaults() {
  const scope = globalThis as { [HOST_DEFAULT]?: { value?: Account.ID } }
  scope[HOST_DEFAULT] ??= {}
  return scope[HOST_DEFAULT]
}

const NO_ACCOUNT =
  "Claude Agent 계정이 없어요 — 요청을 보내지 않았어요. 계정·한도에서 Claude Agent 계정을 추가하세요."
const GONE =
  "이 대화의 Claude Agent 계정을 이 PC에서 쓸 수 없어요 — 요청을 보내지 않았어요. 모델 선택에서 다른 Claude Agent 계정을 고르세요."
const NO_REMOTE_ACCOUNT =
  "이 원격 호스트가 쓸 수 있는 Claude Agent 계정이 없어요 — 요청을 보내지 않았어요. PC에서 Claude Agent 계정과 이 호스트의 계정 범위를 확인하세요."
const GONE_REMOTE =
  "이 대화의 Claude Agent 계정을 이 원격 호스트에서 쓸 수 없어요 — 요청을 보내지 않았어요. 모델 선택에서 다른 Claude Agent 계정을 고르세요."

/**
 * What a user runs to log in there from a terminal, with the login window's folder and profile directory: in 명령
 * 프롬프트 (cmd.exe, `set` keeps them for that window only) and in PowerShell (`$env:` likewise). POSIX shells take the
 * variables before the command.
 */
function commands(folder: string, cli: ReadonlyArray<string>) {
  const quoted = cli.map((part) => `"${part}"`).join(" ")
  const profile = profileDirectory(folder)
  if (process.platform !== "win32") {
    const line = `CLAUDE_CONFIG_DIR="${folder}" ANTHROPIC_CONFIG_DIR="${profile}" ${quoted} auth login --claudeai`
    return { cmd: line, powershell: line }
  }
  return {
    cmd: `set "CLAUDE_CONFIG_DIR=${folder}" && set "ANTHROPIC_CONFIG_DIR=${profile}" && ${quoted} auth login --claudeai`,
    powershell: `$env:CLAUDE_CONFIG_DIR = '${folder}'; $env:ANTHROPIC_CONFIG_DIR = '${profile}'; & ${cli.map((part) => `'${part}'`).join(" ")} auth login --claudeai`,
  }
}

function same(a: string, b: string) {
  return ClaudeLogin.key(a) === ClaudeLogin.key(b)
}

/**
 * Claude Code 2.1.311 dropped the `[1m]` suffix where it changes nothing: 2.1.282 listed `opus[1m]`, now `opus` is the
 * 1M model. Conversations, presets and defaults saved under the old id would name a model the provider no longer has
 * (core fails such a step, `ModelUnavailableError`). For each model without its suffixed id, that id registers again
 * as a `deprecated` copy that keeps the model's `modelID`, so its requests run the model itself (07 §4.4): a
 * conversation on it keeps running, nothing offers or picks it anew, and a preset pinned to it gets the repair notice
 * offering the new id (`Preset.successor`).
 */
function retiredLongContext(models: ReadonlyMap<string, Model.Info>): Model.Info[] {
  return [...models.values()].flatMap((model) => {
    const id = Model.ID.make(`${model.id}${Preset.LONG_CONTEXT_SUFFIX}`)
    if (model.id.endsWith(Preset.LONG_CONTEXT_SUFFIX) || models.has(id)) return []
    return [{ ...model, id, status: "deprecated" }]
  })
}
