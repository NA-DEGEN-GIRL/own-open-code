export * as ClaudeAccounts from "./accounts.js"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import type { SessionHttpRequest, SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { Account, Kv, OwnID, type Limit, type Registry } from "@own/protocol"
import { Fsx } from "@own/runtime"
import { ClaudeWire } from "../broker/claude-wire.js"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Nonces } from "../nonces.js"
import { ClaudeBundle } from "../plugins/bundle.js"
import { Claude } from "../plugins/claude.js"
import { PresetBinding } from "../presets/binding.js"
import type { RpcTypes } from "../rpc/types.js"
import type { Views } from "../slots/views.js"
import { ClaudeSwitch } from "./autoswitch.js"
import { ClaudeLogin } from "./login.js"

/**
 * Owner: CLAUDE ACCOUNTS (02 §8.7, user decisions C-D1/C-D2 2026-10-10). Several Claude subscription accounts on this
 * PC, used by different conversations at the same time through the patched claude-auth the app ships (02 §8.2).
 *
 * - Accounts: account 1 is the slot's own (`acc_claude_slot`, the folder `accounts.json` `claudeSlot.configDir` names
 *   once `own 전용 로그인으로 바꾸기` moved it, else the one `claude-auth.json` names, else `%USERPROFILE%\.claude`); the
 *   others are `accounts.json` `claudeAccounts` (`acc_<ulid>`, usually a folder own made under
 *   `<OWN_HOME>\claude-accounts\<id>`). The leader writes the list the patched plugin reads,
 *   `<OWN_HOME>\thirdparty\claude-auth\claude-accounts.json` `{version: 2, default, accounts: [{key, configDir, label,
 *   readOnly?}]}` (no secret), outside the versioned app folder, so an update keeps every account. No request is signed
 *   before this instance saw the list of this version on disk ({@link ClaudeBundle.LIST_VERSION}): an older own's list
 *   (the first start after an update) may lack `readOnly`.
 * - Claude Code's own login (CS, 2026-10-22): own decides which logins are read only and says so per account in the
 *   list (`readOnly: true`): account 1 on its unmanaged base folder (no `claudeSlot.configDir`: `%USERPROFILE%\.claude`
 *   or the folder `claude-auth.json` names, which the launcher exports as Claude Code's `CLAUDE_CONFIG_DIR`), and any
 *   account whose folder is one of those, or the service's `CLAUDE_CONFIG_DIR`, by realpath (a junction, another
 *   spelling), or whose credentials file is one of theirs by realpath or file id (a symbolic or hard link). The patched
 *   plugin never refreshes or writes such a login (a rotation would log Claude Code out) and adds the same check of
 *   its own for `%USERPROFILE%\.claude` and `CLAUDE_CONFIG_DIR`; once its token expired the account is `stale` until
 *   Claude Code refreshed it, and `다시 로그인` moves it to a login folder of its own instead of logging in there.
 * - Binding (G2): a root session's tree runs on one account (`claude:session:<root>`), a team on one
 *   (`claude:team:<teamID>`), 07 R4. own-accounts' `http.request` hook runs before claude-auth's and binds the
 *   request's session in the plugin (`bindSession`), so the plugin signs with that account and no other; a new root
 *   without a binding gets the default account (the one chosen last) and keeps it. No request header carries it.
 * - Fail closed: while the loaded plugin is not the verified bundle (or lacks its multi-account exports), a
 *   conversation bound to another account than the slot's own is refused before anything is signed
 *   (`claude_account_refused`); the plugin itself holds no account own did not list.
 * - Attribution (G4): the account that signed a request is read from the plugin (`accountOf(request)`), never from the
 *   binding at the time the response arrives; the runtime hands that to the observers.
 * - `Claude 계정 추가`: Claude Code's own login in a window on this PC ({@link ClaudeLogin}); `계정 빼기…` moves the
 *   account's conversations to the default account and may delete a folder own made.
 *
 * Remote service (04 §8.11): the accounts are the PC's mirrored list (display only); a session's binding is kept here
 * the same way and travels to the PC inside the egress proof (v2), which the PC checks and signs with.
 */

export interface Entry {
  readonly accountID: Account.ID
  /** The plugin's name of the account: the folder resolved, lower-cased on Windows (`""` on a remote service). */
  readonly key: string
  readonly configDir: string
  readonly label: string | null
  readonly shortLabel: string
  readonly color: Account.Color
  readonly managed: boolean
  /** A login Claude Code itself uses (CS): the patched plugin only reads it; the list file says so. */
  readonly readOnly: boolean
  readonly email?: string
  readonly accountUuid?: string
  /** The default account (what a new conversation without a binding gets). */
  readonly default: boolean
}

export interface Config {
  /** `%USERPROFILE%`: the default Claude Code folder is `<userHome>\.claude`. */
  readonly userHome: string
  /**
   * The service's `CLAUDE_CONFIG_DIR` (the launcher exports `claude-auth.json`'s folder there at start), a folder
   * Claude Code uses and the patched plugin reads only, so own marks it read only too.
   */
  readonly claudeConfigDir: string | undefined
  readonly login: ClaudeLogin.Config
}

/**
 * What a login window is for: a new account (`add`), the account's own folder again (`relogin`, `다시 로그인`), or a new
 * own folder that account 1 moves to off Claude Code's own `%USERPROFILE%\.claude` (`move`, CS 2026-10-22).
 */
type LoginMode = "add" | "relogin" | "move"

export function defaults(): Config {
  const userHome = os.homedir()
  return {
    userHome,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    login: ClaudeLogin.defaults(userHome),
  }
}

export interface Api extends Module.Lifecycle {
  /** Every Claude account, account 1 first; empty while the slot is not detected. */
  list(): ReadonlyArray<Entry>
  entry(accountID: string): Entry | undefined
  defaultID(): Account.ID
  /** The loaded plugin carries the patch (several accounts can sign). Always `false` on a remote service. */
  multi(): boolean
  /** This PC can sign with the account now (the loaded plugin holds its login; account 1 on a one-account plugin). */
  usable(accountID: string): boolean
  /** The account a session's tree runs on: its root's or team's binding, else the default (no write). */
  accountOf(sessionID: string): Promise<Account.ID>
  /** The last account {@link accountOf} or a binding gave this session (sync, for folds and views). */
  peek(sessionID: string): Account.ID
  /**
   * own-accounts' `http.request` hook for `anthropic`, before claude-auth's: binds the session in the plugin and
   * answers its account. Throws to refuse (fail closed): a conversation on another account while the plugin runs
   * one, or an account the plugin does not know.
   */
  onHttpRequest(event: SessionHttpRequest): Promise<Account.ID | undefined>
  /**
   * own-accounts' `http.response` hook for `anthropic`: the first request an account really sent (the plugin signed it
   * and an answer came) raises `claude_first_request` once (02 §8.9); a request the plugin refused (its login could
   * not be refreshed) sent nothing and raises nothing (CR).
   */
  onHttpResponse(event: SessionHttpResponse): Promise<void>
  /** Moves the tree (or the team) of `sessionID` to `accountID`; answers the sessions that moved. */
  rebind(sessionID: string, accountID: Account.ID, reason: "user" | "auto" | "removed"): Promise<ReadonlyArray<string>>
  /** The own account that signed an `anthropic` request (patched plugin), else `undefined`. */
  signer(request: Request): Account.ID | undefined
  /** `accounts.list` views of every Claude account (02 §9.2). */
  views(slot: { readonly verified: boolean; readonly version: string | null }, extra: ViewExtra): Account.View[]
  /** Writes own's account list for the plugin now when it differs. */
  sync(): Promise<void>
  /**
   * Whether this instance saw own's account list of this version on disk (the leader writes it first when it has not),
   * so the plugin may sign (CS). `false` refuses: this PC's requests, and the egress relay's (`not_ready`).
   */
  ready(): Promise<boolean>
  /**
   * 02 §8.8 (C-D3): a failed `anthropic` request whose account ran out moves the tree to another Claude account of this
   * PC and is sent again at once (`retry: true, delay: 0`), before any output. Policy `autoSwitch.claudeToClaude`, off
   * unless the user picks `auto` (CAG-5 2026-10-31).
   */
  onRetry(event: SessionRetry): Promise<void>

  /** 02 §8.10 폴더 나누기: the running sessions on an account (its folder moves to another route only when none is). */
  busy(accountID: Account.ID): Promise<ReadonlyArray<string>>
  /**
   * 02 §8.10 폴더 나누기: takes an added account out of claude-auth without touching its folder (it moves to the Claude
   * Agent route); its trees and teams move to the default account, and the plugin's list forgets it.
   */
  release(accountID: Account.ID): Promise<void>
  /** 02 §8.10 폴더 나누기: an own-made login folder the Claude Agent route gave up becomes an added account. */
  adopt(input: {
    readonly accountID: Account.ID
    readonly folder: string
    readonly from: Pick<Registry.ClaudeAgentAccount, "label" | "color" | "email" | "accountUuid">
  }): Promise<void>

  sessionGet: RpcTypes.Handler<"plugin.claudeAuth.session.get">
  sessionSet: RpcTypes.Handler<"plugin.claudeAuth.session.set">
  defaultSet: RpcTypes.Handler<"plugin.claudeAuth.default.set">
  addPlan: RpcTypes.Handler<"plugin.claudeAuth.accounts.add.plan">
  addExecute: RpcTypes.Handler<"plugin.claudeAuth.accounts.add.execute">
  addStatus: RpcTypes.Handler<"plugin.claudeAuth.accounts.add.status">
  detect: RpcTypes.Handler<"plugin.claudeAuth.accounts.detect">
  removePlan: RpcTypes.Handler<"plugin.claudeAuth.accounts.remove.plan">
  removeExecute: RpcTypes.Handler<"plugin.claudeAuth.accounts.remove.execute">
}

export interface ViewExtra {
  readonly windows: (accountID: Account.ID) => ReadonlyArray<Limit.Window>
  readonly compaction?: Views.Extra["compaction"]
  readonly summary: (windows: ReadonlyArray<Limit.Window>) => Limit.Summary
}

export function create(deps: Deps, peers: Module.Peers): Api {
  return make(deps, peers)
}

const Bound = Schema.Struct({ accountID: Account.ID, at: Schema.Finite })
const decodeBound = Schema.decodeUnknownOption(Bound)
const toJson = Schema.decodeUnknownSync(Schema.Json)
const isSessionID = Schema.is(SessionID)
const SLOT_DISPLAY = { label: null, shortLabel: "C", color: "orange" as Account.Color }
const SLOT_META: Registry.ClaudeSlot = { accountID: "acc_claude_slot", ...SLOT_DISPLAY }
const TEAM_PREFIX = "claude:team:"
/** How often the leader looks whether an account on Claude Code's own login went stale or fresh (02 §8.7 CS). */
const SHARED_POLL_MS = 15_000
/** A login this close to its expiry is not used (the patched plugin's margin). */
const EXPIRY_MARGIN_MS = 60_000
/** A login folder nothing names is swept once it is this much older than the login limit. */
const SWEEP_MARGIN_MS = 60_000
const COLORS: ReadonlyArray<Account.Color> = ["amber", "rose", "violet", "teal", "indigo", "green", "slate", "orange"]

/** {@link create} with test overrides (a temp user profile, a fake CLI and window). */
export function make(deps: Deps, peers: Module.Peers, overrides: Partial<Config> = {}): Api {
  const config: Config = { ...defaults(), ...overrides }
  const log = deps.log.child("claude")
  const hub = deps.runtime.broadcast
  const stateDir = ClaudeBundle.stateDir(deps.runtime.layout.thirdparty)
  const state = {
    /** Account 1's folder (`claude-auth.json` or the default), read at start and on every account change. */
    base: path.join(config.userHome, ".claude"),
    /**
     * Claude Code's own login folders (`%USERPROFILE%\.claude`, {@link state.base} and the service's
     * `CLAUDE_CONFIG_DIR`): their realpath keys, and their credentials files' realpath keys and file ids.
     */
    claudeCode: { folders: new Set<string>(), files: new Set<string>(), ids: new Set<string>() },
    /** Each account folder's {@link Identity}, by account key, as {@link resolveFolders} last read them. */
    real: new Map<string, Identity>(),
    /** This instance saw own's account list of this version on disk (requests are signed only then). */
    listed: false,
    multi: false,
    /** The loaded plugin's multi-account exports, kept for the synchronous attribution resolver. */
    api: undefined as ClaudeWire.Multi | undefined,
    loaded: new Set<string>(),
    labels: new Map<string, string>(),
    /** Each loaded login's expiry and last failed refresh by account key (CR), as the plugin last said. */
    expiries: new Map<string, number>(),
    refreshes: new Map<string, ClaudeWire.RefreshFailure>(),
    started: false,
    /**
     * Account uuids read from a folder's `.claude.json` for entries that keep none (account 1), once per folder key
     * (`""`: none there): the views name a Claude app's synced skills folder with them (SK2).
     */
    uuids: new Map<string, string>(),
  }
  /** session → its root; a binding key (`claude:session:<root>`, `claude:team:<id>`) → its account, once read. */
  const roots = new Map<string, string>()
  const bindings = new Map<string, Account.ID>()
  /** One settle or switch per tree (or team) at a time ({@link locked}). */
  const locks = new Map<string, Promise<void>>()
  /** The refusal (`lastResponse.at`) each session's switch decision already used (02 §8.8). */
  const handled = new Map<string, number>()
  const last = new Map<string, Account.ID>()
  /** Claude accounts whose first request this instance already handled (02 §8.9, `claude_first_request`). */
  const noticed = new Set<string>()
  const adds = new Nonces.Scope<{ readonly accountID: Account.ID; readonly folder: string; readonly mode: LoginMode }>(
    deps.clock,
  )
  const removals = new Nonces.Scope<{
    readonly accountID: Account.ID
    readonly sessions: ReadonlyArray<string>
    readonly folder: string | undefined
  }>(deps.clock)
  const attempts = new Map<
    string,
    {
      state: "waiting" | "added" | "duplicate" | "mismatch" | "failed" | "timeout"
      accountID?: Account.ID
      label?: string
    }
  >()
  const unsubscribe: Array<() => void> = []
  /** Login windows this instance opened, until they end. */
  const logins = new Map<
    string,
    { readonly folder: string; readonly controller: AbortController; readonly running: Promise<unknown> }
  >()
  /**
   * Automatic switches per tree root (the breaker) and the accounts a tree left, per refused scope until its reset
   * (02 §8.8, `ClaudeSwitch.depart`).
   */
  const switches = new Map<string, number[]>()
  const departed = new Map<string, ClaudeSwitch.Departures>()
  /** The stale state of each account on Claude Code's own login the leader last told clients about (02 §8.7 CS). */
  const announced = new Map<Account.ID, boolean>()
  /** The refresh view of each account the leader last told clients about (CR), as {@link refreshView}'s key. */
  const announcedRefresh = new Map<Account.ID, string>()
  const poll = { cancel: () => {} }

  const registry = () => peers().slots.snapshot()

  /**
   * A login Claude Code itself uses (02 §8.7 CS, 2026-10-22), which the patched plugin only reads: a refresh by own
   * would rotate the refresh token Claude Code holds, so an account there waits for Claude Code. Account 1 on its
   * unmanaged base folder always is; any account is when its folder is one of Claude Code's by realpath, or its
   * credentials file is one of theirs (a symbolic or hard link: same realpath or file id).
   */
  const readOnly = (key: string, base: boolean) => {
    if (deps.remote) return false
    if (base) return true
    const real = state.real.get(key)
    const claudeCode = state.claudeCode
    if (real === undefined) return claudeCode.folders.has(key)
    return (
      claudeCode.folders.has(real.folder) ||
      claudeCode.files.has(real.file) ||
      (real.id !== null && claudeCode.ids.has(real.id))
    )
  }
  /** An account on Claude Code's own login whose token expired: the plugin neither signs with nor refreshes it. */
  const stale = (item: Entry) => {
    if (!item.readOnly || !state.multi) return false
    const expiresAt = state.api?.accounts().find((account) => account.key === item.key)?.expiresAt
    return expiresAt !== undefined && expiresAt <= deps.clock.now() + EXPIRY_MARGIN_MS
  }
  /** An account own refreshes whose last refresh the token endpoint refused for good (CR): only `다시 로그인` helps. */
  const failed = (item: Entry) => refreshView(item)?.state === "failed"
  /**
   * CR (2026-10-26): the card's refresh line of an account the plugin refreshes (not Claude Code's own login): its last
   * failed refresh (`failed`, `retrying`), else `due` while its access token expired and no refresh was tried yet (the
   * first request refreshes it: not an error), else none.
   */
  const refreshView = (item: Entry): Account.ClaudeRefresh | undefined => {
    if (deps.remote || item.readOnly || !state.multi || !state.loaded.has(item.key)) return undefined
    const failure = state.refreshes.get(item.key)
    if (failure)
      return {
        state: failure.kind === "terminal" ? "failed" : "retrying",
        at: failure.at,
        ...(failure.status > 0 ? { status: failure.status } : {}),
        ...(failure.error === undefined ? {} : { error: failure.error }),
        ...(failure.reason === undefined ? {} : { reason: failure.reason }),
        ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
      }
    const expiresAt = state.expiries.get(item.key)
    return expiresAt !== undefined && expiresAt <= deps.clock.now() + EXPIRY_MARGIN_MS ? { state: "due" } : undefined
  }

  /**
   * Reads account 1's base folder and what {@link readOnly} compares: the folders' realpaths (a junction or another
   * spelling of Claude Code's folder is still Claude Code's) and their credentials files' realpaths and ids (a link of
   * Claude Code's file in another folder). Run where a decision is made, never older than the call that uses it.
   */
  const resolveFolders = async () => {
    // A remote service holds no login folder (its accounts are the PC's mirror).
    if (deps.remote) return
    state.base = await baseFolder(deps, config.userHome)
    const claudeCode = await Promise.all(
      [path.join(config.userHome, ".claude"), state.base, config.claudeConfigDir]
        .filter((folder) => folder !== undefined)
        .map(identity),
    )
    state.claudeCode = {
      folders: new Set(claudeCode.map((item) => item.folder)),
      files: new Set(claudeCode.map((item) => item.file)),
      ids: new Set(claudeCode.flatMap((item) => (item.id === null ? [] : [item.id]))),
    }
    state.real = new Map(
      await Promise.all(all().map(async (item) => [item.key, await identity(item.configDir)] as const)),
    )
    await Promise.all(
      all()
        .filter((item) => item.accountUuid === undefined && !state.uuids.has(item.key))
        .map(async (item) =>
          state.uuids.set(item.key, (await ClaudeLogin.profile(item.configDir, config.userHome))?.accountUuid ?? ""),
        ),
    )
  }

  /**
   * Every Claude account the registry (or the mirror) names, whether or not this Location has detected the plugin
   * yet: a binding is read and refused against this list, never against a list that is still empty at startup.
   */
  const all = (): ReadonlyArray<Entry> => {
    if (deps.remote) return mirrored()
    const file = registry()
    const fallback = defaultOf(file)
    const meta = file.claudeSlot
    // An own folder once `own 전용 로그인으로 바꾸기` moved account 1 there (CS), else `claude-auth.json` or the default.
    const folder = meta?.configDir ?? state.base
    const first: Entry = {
      accountID: Account.ID.claudeSlot,
      key: ClaudeLogin.key(folder),
      configDir: folder,
      label: meta?.label ?? SLOT_DISPLAY.label,
      shortLabel: meta?.shortLabel ?? SLOT_DISPLAY.shortLabel,
      color: meta?.color ?? SLOT_DISPLAY.color,
      managed: meta?.configDir !== undefined,
      readOnly: readOnly(ClaudeLogin.key(folder), meta?.configDir === undefined),
      default: fallback === Account.ID.claudeSlot,
    }
    const others = (file.claudeAccounts ?? []).map(
      (item): Entry => ({
        accountID: item.accountID,
        key: item.key,
        configDir: item.configDir,
        label: item.label,
        shortLabel: item.shortLabel,
        color: item.color,
        managed: item.managed,
        readOnly: readOnly(item.key, false),
        ...(item.email === undefined ? {} : { email: item.email }),
        ...(item.accountUuid === undefined ? {} : { accountUuid: item.accountUuid }),
        default: fallback === item.accountID,
      }),
    )
    return [first, ...others]
  }

  /** A remote service's accounts: the PC's mirrored list (display only), else the slot alone. */
  const mirrored = (): ReadonlyArray<Entry> => {
    const view = deps.remote?.claude()
    if (!view) return []
    const accounts = view.accounts ?? [{ accountID: Account.ID.claudeSlot, ...view.display, default: true }]
    return accounts.map((item) => ({
      accountID: item.accountID,
      key: "",
      configDir: "",
      label: item.label,
      shortLabel: item.shortLabel,
      color: item.color,
      managed: false,
      readOnly: false,
      default: item.default,
    }))
  }

  /** The accounts the UI lists: none while claude-auth is not detected here (a remote service: the mirror's). */
  const list = (): ReadonlyArray<Entry> => (deps.remote || peers().plugins.claudeSlot().detected ? all() : [])
  const entry = (accountID: string) => all().find((item) => item.accountID === accountID)
  const defaultID = () => all().find((item) => item.default)?.accountID ?? Account.ID.claudeSlot

  /**
   * The patched plugin's exports on core's instance, resolved from the loaded entry's folder (before this Location's
   * plugin list was read: the bundle the app ships, which is what core loads), as core's import from `server.js`
   * resolves it. `module`: the loaded module carries the marker; `multi`: and the bundle's files are verified as
   * `patched`, the only state that signs for several accounts (anything else runs account 1 only).
   */
  const plugin = async () => {
    if (deps.remote) return { module: undefined, multi: undefined }
    const bundle = await peers().plugins.bundleSettled()
    const module = bundle ? await ClaudeWire.multi(bundle.dir, stateDir).catch(() => undefined) : undefined
    const patched = module !== undefined && bundle?.state === "patched"
    state.multi = patched
    state.api = module
    return { module, multi: patched ? module : undefined }
  }
  const multiApi = async () => (await plugin()).multi

  /**
   * The root of a session: the runtime's index, else core's session (a subagent's parent chain). A failed read throws,
   * so the request fails closed instead of running a subagent as a tree of its own; only answers are cached.
   */
  const rootOf = async (sessionID: string): Promise<string> => {
    const known = roots.get(sessionID)
    if (known) return known
    const parentID =
      deps.runtime.sessions.get(sessionID)?.parentID ??
      (await deps.ctx.session.get({ sessionID: sessionID as SessionID }))?.parentID ??
      undefined
    const root = parentID ? await rootOf(parentID) : sessionID
    roots.set(sessionID, root)
    return root
  }

  /**
   * The team a root belongs to (its preset binding's team context, 07 §5.1), read every time: own.team adopts an
   * existing root into a team or changes its context at any time. A failed read throws (fail closed).
   */
  const teamOf = async (root: string) => (await PresetBinding.read(deps, root))?.team ?? null

  /** A stored binding; a failed read throws and caches nothing, and a missing one is never cached either. */
  const readBound = async (key: string) => {
    const cached = bindings.get(key)
    if (cached !== undefined) return cached
    const value = await deps.ctx.storage.get(key)
    const bound = value === undefined ? undefined : Option.getOrUndefined(decodeBound(value))?.accountID
    if (bound !== undefined) bindings.set(key, bound)
    return bound ?? null
  }

  /** The bindings of a session's tree: its root's and, in a team, the team's, which is the one that counts (07 R4). */
  const bindingOf = async (sessionID: string) => {
    const root = await rootOf(sessionID)
    const team = await teamOf(root)
    const rootBound = await readBound(Kv.claudeSession(root))
    const teamBound = team === null ? null : await readBound(Kv.claudeTeam(team.teamID))
    return { root, team, rootBound, bound: team === null ? rootBound : teamBound }
  }
  type Found = Awaited<ReturnType<typeof bindingOf>>

  /**
   * The account a tree without a binding starts on (07 R4: one per team). A team: the Claude account its context names,
   * else the account this root already ran on, else the one another member root already ran on (a team formed or
   * adopted after its sessions ran keeps an account one of them has). Otherwise the default (the account chosen last).
   */
  const initial = async (found: Found): Promise<Account.ID> => {
    const present = (accountID: Account.ID | null) => (accountID !== null && entry(accountID) ? accountID : undefined)
    if (found.team === null) return present(found.rootBound) ?? (await preferred(found.root)) ?? defaultID()
    const named = found.team.accounts.find((accountID) => entry(accountID) !== undefined)
    if (named) return named
    if (present(found.rootBound)) return found.rootBound!
    for (const root of await teamRoots(found.team.teamID)) {
      const bound = present(await readBound(Kv.claudeSession(root)).catch(() => null))
      if (bound) return bound
    }
    return defaultID()
  }

  const write = async (key: string, accountID: Account.ID) => {
    await deps.ctx.storage.set(key, toJson({ accountID, at: deps.clock.now() }))
    bindings.set(key, accountID)
  }

  /**
   * The Claude account the root's preset names (PF 2026-11-03, the preset editor's `Claude 구독 [계정 ▾]`): the first
   * pinned account of this route that can sign now and has not run out; `undefined` otherwise (the default then).
   */
  const preferred = async (root: string) => {
    const pins = await PresetBinding.pinned(deps, peers, root).catch(() => [])
    if (!pins.length) return undefined
    const signs = await usableAccounts()
    return pins
      .map((accountID) => entry(accountID))
      .find((item) => item !== undefined && signs(item) && deps.runtime.limits.exhaustion(item.accountID) === undefined)
      ?.accountID
  }

  /** Runs `work` after every earlier call with the same key finished (one settle or switch per tree at a time). */
  const locked = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return next
  }

  /** The account a session's tree runs on (no write): its binding, else the account it would start on. */
  const accountOf = async (sessionID: string) => {
    const found = await bindingOf(sessionID)
    const accountID = found.bound !== null && entry(found.bound) ? found.bound : await initial(found)
    last.set(sessionID, accountID)
    return accountID
  }

  /** Why a request was refused, in the words the alert and the conversation's error show (Korean, with the remedy). */
  const refusal = (accountID: Account.ID, reason: Refusal) => {
    if (reason === "one_account")
      return `이 대화는 Claude 계정 ${labelOf(accountID)}로 정해져 있지만, 앱에 든 Claude 구독 플러그인을 확인할 수 없어 계정 하나만 씁니다 — 요청을 보내지 않았습니다. 서비스를 다시 시작하세요.`
    if (reason === "gone")
      return `이 대화의 Claude 계정(${labelOf(accountID)})을 이 PC에서 쓸 수 없습니다 — 요청을 보내지 않았습니다. 전환기에서 다른 Claude 계정을 고르세요.`
    if (reason === "not_listed")
      return `Claude 계정 목록을 아직 준비하지 못했어요 · 잠시 뒤 다시 시도해요. 계속 뜨면 서비스를 다시 시작해요. Claude 계정 ${labelOf(accountID)}의 요청은 보내지 않았어요.`
    return `이 대화의 Claude 계정(${labelOf(accountID)})에 이 PC의 로그인이 없습니다 — 요청을 보내지 않았습니다. 계정 화면에서 그 계정의 [다시 로그인]을 누르세요.`
  }

  const refuse = (sessionID: string, accountID: Account.ID, reason: Refusal): never => {
    const message = refusal(accountID, reason)
    peers().telemetry.alert({ code: "claude_account_refused", severity: "warning", sessionID, accountID, message })
    throw new Error(message)
  }

  /**
   * The account a request of `sessionID` runs on, settling its tree once (07 R4), one tree at a time: a team's binding
   * wins; a team without one takes {@link initial} and a member's own binding follows the team; a tree without a
   * binding keeps the account it started on. A binding to an account that is gone is refused, never moved to another
   * account here (removal moves them). Nothing is written from a read that failed: that throws first.
   */
  const settle = async (sessionID: string) => {
    const first = await bindingOf(sessionID)
    const key = first.team === null ? Kv.claudeSession(first.root) : Kv.claudeTeam(first.team.teamID)
    return locked(key, async () => {
      const found = await bindingOf(sessionID)
      if (found.bound !== null && !entry(found.bound)) return refuse(sessionID, found.bound, "gone")
      const accountID = found.bound ?? (await initial(found))
      if (found.team === null) {
        if (found.bound === null) await write(Kv.claudeSession(found.root), accountID)
        return accountID
      }
      if (found.bound === null) await write(Kv.claudeTeam(found.team.teamID), accountID)
      // A root that ran on another account before it joined the team follows the team's account (one per team).
      if (found.rootBound !== null && found.rootBound !== accountID) {
        await write(Kv.claudeSession(found.root), accountID)
        announce(tree(found.root), accountID, "joined")
      }
      return accountID
    })
  }

  const onHttpRequest = async (event: SessionHttpRequest) => {
    if (event.model.providerID !== Provider.ID.anthropic) return undefined
    return sign(event)
  }

  const onHttpResponse = async (event: SessionHttpResponse) => {
    if (event.model.providerID !== Provider.ID.anthropic) return
    // The account that signed it: the relay's proof (a remote service), the plugin's attribution, else (a one-account
    // plugin) account 1, which its request hook gave the session.
    const accountID = deps.remote
      ? remoteSigner(event.request)
      : state.multi
        ? signer(event.request)
        : last.get(event.sessionID)
    if (accountID !== undefined) await firstRequest(event.sessionID, accountID)
  }

  /**
   * 02 §8.9 (CW, 2026-10-19): the first request this service sends on a Claude account raises `claude_first_request`
   * once (KV {@link Kv.claudeFirstRequest}), for the composer's notice, when its answer arrives (CR: a request the plugin
   * refused before sending is none). It never holds the request: the notice only informs, and a failed read or write is
   * logged and tried again on the account's next answer.
   */
  const firstRequest = async (sessionID: string, accountID: Account.ID) => {
    if (noticed.has(accountID)) return
    noticed.add(accountID)
    const key = Kv.claudeFirstRequest(accountID)
    const raise = async () => {
      if ((await deps.ctx.storage.get(key)) !== undefined) return
      const root = await rootOf(sessionID)
      await deps.ctx.storage.set(key, toJson({ at: deps.clock.now(), sessionID: root }))
      peers().telemetry.alert({
        code: "claude_first_request",
        severity: "warning",
        sessionID: root,
        accountID,
        message: "이 계정의 첫 Claude 요청이에요 · 추가 사용량으로 청구될 수 있어요",
      })
      log.info("claude_first_request", { accountID })
    }
    await raise().catch((error: unknown) => {
      noticed.delete(accountID)
      log.warn("claude_first_request_failed", { accountID, error })
    })
  }

  /** The account a request is signed with (see {@link Api.onHttpRequest}); throws to refuse. */
  const sign = async (event: SessionHttpRequest): Promise<Account.ID> => {
    if (deps.remote) return remoteRequest(event.sessionID)
    if (!(await ready())) return refuse(event.sessionID, await accountOf(event.sessionID), "not_listed")
    const loaded = await plugin()
    const multi = loaded.multi
    if (!multi) {
      const found = await bindingOf(event.sessionID)
      // One account in the plugin: only the slot's own may sign; an unbound tree is that account and stays unbound.
      if (found.bound !== null && found.bound !== Account.ID.claudeSlot)
        return refuse(event.sessionID, found.bound, "one_account")
      // A module that carries the patch but is not verified as patched still reads bindings: account 1, never the
      // list's default.
      const slotKey = entry(Account.ID.claudeSlot)?.key
      if (loaded.module && slotKey !== undefined) loaded.module.bindSession(event.sessionID, slotKey)
      last.set(event.sessionID, Account.ID.claudeSlot)
      return Account.ID.claudeSlot
    }
    // claude-auth's hook running before this one would sign with the previous binding: refused until the order is fixed.
    if (peers().plugins.claudeOrder() === "before_own_accounts") {
      const accountID = await accountOf(event.sessionID)
      return refuse(event.sessionID, accountID, "one_account")
    }
    const accountID = await settle(event.sessionID)
    const target = entry(accountID)
    if (!target) return refuse(event.sessionID, accountID, "gone")
    // The plugin signs only an account it holds a login of (its own mode reads own's list); anything else is refused
    // here rather than signed with whatever the plugin falls back to.
    if (!multi.accounts().some((item) => item.key === target.key))
      return refuse(event.sessionID, accountID, "not_loaded")
    multi.bindSession(event.sessionID, target.key)
    last.set(event.sessionID, accountID)
    return accountID
  }

  /**
   * A remote service (04 §8.11, G5): the same rules as this PC's, against the PC's mirrored list. A new tree is bound
   * to the mirror's default on its first request and keeps it; a binding the mirror does not carry (the host's scope
   * dropped it) is refused, never signed as another account. Before the mirror arrived nothing is written.
   */
  const remoteRequest = async (sessionID: string) => {
    if (!deps.remote?.claude()) {
      last.set(sessionID, Account.ID.claudeSlot)
      return Account.ID.claudeSlot
    }
    const accountID = await settle(sessionID)
    last.set(sessionID, accountID)
    return accountID
  }

  /** Every session the runtime knows in the tree of `root`. */
  const tree = (root: string) => {
    const found = [root]
    for (let index = 0; index < found.length; index++)
      for (const child of deps.runtime.sessions.children(found[index]!)) found.push(child.sessionID)
    return found
  }

  /** The roots of a team among the sessions this instance knows (each root's team read again). */
  const teamRoots = async (teamID: string) => {
    const known = [
      ...new Set([
        ...roots.keys(),
        ...deps.runtime.sessions.list({ providerID: Provider.ID.anthropic }).map((item) => item.sessionID),
      ]),
    ]
    const resolved = await Promise.all(
      known.map((sessionID) =>
        rootOf(sessionID).then(
          (root) => root,
          () => undefined,
        ),
      ),
    )
    const candidates = [...new Set(resolved.filter((root) => root !== undefined))]
    const teams = await Promise.all(
      candidates.map((root) =>
        teamOf(root).then(
          (team) => team?.teamID,
          () => undefined,
        ),
      ),
    )
    return candidates.filter((_root, index) => teams[index] === teamID)
  }

  /** Tells every instance and client that these sessions now run on `accountID`. */
  const announce = (
    sessions: ReadonlyArray<string>,
    accountID: Account.ID,
    reason: "user" | "auto" | "removed" | "joined",
  ) => {
    for (const id of sessions) last.set(id, accountID)
    hub.emit("claude.bound", { sessionIDs: sessions, accountID })
    // Clients read the binding of a Claude conversation again (its account changed, its model did not).
    for (const id of sessions.filter(isSessionID)) {
      const entry = deps.runtime.sessions.get(id)
      if (entry?.providerID !== Provider.ID.anthropic || !entry.modelID) continue
      const model = {
        providerID: Provider.ID.anthropic,
        id: entry.modelID,
        ...(entry.variant ? { variant: entry.variant } : {}),
      } as RpcTypes.EventBody<"binding.changed">["model"]
      void deps.emitter
        .session("binding.changed", {
          sessionID: id,
          model,
          previous: model,
          accountID,
          reason: reason === "auto" ? "hard" : reason === "user" ? "manual" : "external",
          external: reason === "removed" || reason === "joined",
        })
        .catch((error: unknown) => log.warn("binding_event_failed", { error }))
    }
  }

  const rebind = async (sessionID: string, accountID: Account.ID, reason: "user" | "auto" | "removed") => {
    const found = await bindingOf(sessionID)
    if (found.team === null) {
      await write(Kv.claudeSession(found.root), accountID)
      const sessions = [...new Set([found.root, ...tree(found.root)])]
      announce(sessions, accountID, reason)
      log.info("claude_rebound", { reason, accountID, sessions: sessions.length, team: false })
      return sessions
    }
    await write(Kv.claudeTeam(found.team.teamID), accountID)
    // Every member root's own binding follows, so none of them signs with the old account later.
    const members = [...new Set([found.root, ...(await teamRoots(found.team.teamID))])]
    for (const root of members) {
      const own = await readBound(Kv.claudeSession(root)).catch(() => null)
      if (own !== null && own !== accountID) await write(Kv.claudeSession(root), accountID)
    }
    const sessions = [...new Set(members.flatMap(tree))]
    announce(sessions, accountID, reason)
    log.info("claude_rebound", { reason, accountID, sessions: sessions.length, team: true })
    return sessions
  }

  const labelOf = (accountID: string) => {
    const index = all().findIndex((item) => item.accountID === accountID)
    const item = all()[index]
    if (!item) return accountID
    return item.label ?? (index === 0 ? "Claude" : (item.email ?? `Claude ${index + 1}`))
  }

  const onRetry = async (event: SessionRetry) => {
    if (event.model.providerID !== Provider.ID.anthropic) return
    const mode = deps.runtime.policy.cached()?.autoSwitch.claudeToClaude ?? "off"
    if (mode !== "auto") return
    const capture = deps.runtime.lastResponse.get(event.sessionID)
    if (capture?.providerID !== Provider.ID.anthropic) return
    const now = deps.clock.now()
    const signal = ClaudeSwitch.signal(
      new Headers(capture.headers),
      event.error.status ?? capture.status ?? undefined,
      now,
    )
    if (!signal) return
    if (!deps.remote && !(await multiApi())) return
    const first = await bindingOf(event.sessionID)
    const treeKey = first.team === null ? first.root : `team:${first.team.teamID}`
    // One decision per tree at a time: siblings rejected together see the switch the first one made.
    await locked(`switch:${treeKey}`, async () => {
      const from = deps.runtime.claude.lastOf(event.sessionID) ?? (await accountOf(event.sessionID))
      const current = await accountOf(event.sessionID)
      if (current !== from) {
        // The same refusal again: the retry on the tree's account failed before any answer. Not a new switch.
        if (handled.get(event.sessionID) === capture.at) return
        // Another session of this tree already moved it: sent again at once on the tree's account, not counted.
        handled.set(event.sessionID, capture.at)
        deps.runtime.claude.markSwitched(event.sessionID)
        event.decision = { retry: true, delay: 0 }
        return
      }
      const history = switches.get(treeKey) ?? []
      const perHour = deps.runtime.policy.cached()?.hysteresis.breakerAutoPerHour ?? 2
      if (!ClaudeSwitch.allowed(history, now, perHour)) {
        log.info("claude_switch_breaker", { tree: first.team === null ? "session" : "team" })
        return
      }
      const usable = await usableAccounts()
      const to = ClaudeSwitch.choose({
        from,
        candidates: all().map((item) => ({ accountID: item.accountID, loaded: usable(item) })),
        now,
        model: event.model.id,
        kept: await mainModels(first, event.sessionID),
        windows: (accountID) => deps.runtime.limits.list({ accountID }),
        exhausted: (accountID, model) => deps.runtime.limits.exhaustion(accountID, model) !== undefined,
        departed: (accountID, model) => ClaudeSwitch.returns(departed.get(`${treeKey}\u0000${accountID}`), model),
      })
      if (to === undefined) return
      // Never back to the account it left before the refused window's reset (an unknown reset: one hour), for the
      // refused model family only when a model weekly bucket refused.
      const left = `${treeKey}\u0000${from}`
      departed.set(left, ClaudeSwitch.depart(departed.get(left), signal, signal.until ?? now + 3_600_000))
      switches.set(treeKey, [...history.filter((at) => now - at < 3_600_000), now])
      handled.set(event.sessionID, capture.at)
      await rebind(event.sessionID, to as Account.ID, "auto")
      deps.runtime.claude.markSwitched(event.sessionID)
      event.decision = { retry: true, delay: 0 }
      await deps.runtime.ledger
        .event({
          eid: `csw_${OwnID.ulid(now)}`,
          ts: now,
          type: "claude.switch",
          accountID: to,
          providerID: Provider.ID.anthropic,
          sessionID: event.sessionID,
          data: { from, to, reason: signal.reason, windowId: signal.windowId, auto: true },
        })
        .catch((error: unknown) => log.warn("claude_switch_record_failed", { error }))
      peers().telemetry.alert({
        code: "claude_account_switched",
        severity: "info",
        sessionID: event.sessionID,
        accountID: to,
        message: `Claude 한도 소진 — ${labelOf(from)}에서 ${labelOf(to)}로 바꿨습니다 (캐시 새로 쌓임)`,
      })
      log.info("claude_switched", { from, to, reason: signal.reason })
    })
  }

  /**
   * The Claude models the mains of a tree run now (the root's, a team's member roots'), from the runtime session index
   * (`model.selected`), other than the refused session's own: the whole tree moves with one refusal (02 §8.8), so the
   * account it moves to must not hold back what its mains run (LV 2026-10-25).
   */
  const mainModels = async (found: Found, refused: string) => {
    const roots = found.team === null ? [found.root] : [found.root, ...(await teamRoots(found.team.teamID))]
    return [
      ...new Set(
        roots.flatMap((root) => {
          const entry = root === refused ? undefined : deps.runtime.sessions.get(root)
          return entry?.providerID === Provider.ID.anthropic && entry.modelID ? [entry.modelID] : []
        }),
      ),
    ]
  }

  /**
   * Which accounts can sign now: on this PC the ones the loaded plugin holds a login of; on a remote service the ones
   * the PC's mirror marks usable (an older PC that does not say: none, so nothing switches blindly).
   */
  const usableAccounts = async () => {
    if (deps.remote) {
      const mirrored = deps.remote.claude()?.accounts ?? []
      return (item: Entry) =>
        mirrored.some((account) => account.accountID === item.accountID && account.usable === true)
    }
    await refreshLoaded()
    return (item: Entry) => state.loaded.has(item.key) && !stale(item) && !failed(item)
  }

  /**
   * `<OWN_HOME>\thirdparty\claude-auth\claude-accounts.json` as the patched plugin reads it (`ClaudeBundle`); written
   * by the leader only when it changed.
   */
  const sync = async () => {
    if (deps.remote || !deps.runtime.isLeader()) return
    await resolveFolders()
    const accounts = all()
    if (accounts.length === 0) return
    const fallback = accounts.find((item) => item.default) ?? accounts[0]!
    const text = `${JSON.stringify(
      {
        version: ClaudeBundle.LIST_VERSION,
        default: fallback.key,
        accounts: accounts.map((item) => ({
          key: item.key,
          configDir: item.configDir,
          label: labelOf(item.accountID),
          ...(item.readOnly ? { readOnly: true } : {}),
        })),
      },
      null,
      2,
    )}\n`
    const file = path.join(stateDir, ClaudeBundle.ACCOUNTS_FILE)
    if ((await Fsx.readText(file).catch(() => undefined)) !== text) {
      await Fsx.writeAtomic(file, text)
      log.info("claude_accounts_written", { accounts: accounts.length })
    }
    state.listed = true
  }

  /**
   * 02 §8.7 (CS): a request is signed only once this instance saw own's account list of this version on disk. A list
   * an older own wrote (the first start after an update) may lack `readOnly`, and the plugin may read it before this
   * module's start wrote the new one. The leader writes it now when it has not yet; another instance looks whether the
   * leader's is there. Until then the request is refused (fail closed), and the next one looks again.
   */
  const ready = async () => {
    if (state.listed || deps.remote) return true
    if (deps.runtime.isLeader()) await sync().catch((error: unknown) => log.warn("claude_sync_failed", { error }))
    else state.listed = await ClaudeBundle.listCurrent(stateDir)
    return state.listed
  }

  /**
   * Which folders the loaded plugin holds a login of, its labels (plan and e-mail), each login's expiry and last failed
   * refresh, for views and messages. The leader also listens to the plugin's refreshes (CR).
   */
  const refreshLoaded = async () => {
    const multi = await multiApi()
    const loaded = multi?.accounts() ?? []
    state.loaded = new Set(loaded.map((item) => item.key))
    state.labels = new Map(loaded.map((item) => [item.key, item.label]))
    state.expiries = new Map(
      loaded.flatMap((item) => (item.expiresAt === undefined ? [] : [[item.key, item.expiresAt]])),
    )
    state.refreshes = new Map(loaded.flatMap((item) => (item.refresh === undefined ? [] : [[item.key, item.refresh]])))
    if (multi && state.started && !deps.remote && deps.runtime.isLeader()) multi.onRefresh(onRefresh)
  }

  /**
   * CR (2026-10-26, closes CS-8 (d)): every refresh the patched plugin makes is a line in own's log (`own-accounts.log`,
   * scope `own.accounts.claude`): started, ok, failed with the token endpoint's HTTP status, OAuth error and description
   * (cut short, tokens replaced by the plugin), the kind, retry-after and the account's id and label; never a token. A
   * change of the account's refresh line is announced at once.
   */
  const onRefresh = (event: ClaudeWire.RefreshEvent) => {
    const item = all().find((entry) => entry.key === event.key)
    const fields = {
      accountID: item?.accountID ?? null,
      label: item === undefined ? event.label : labelOf(item.accountID),
      trigger: event.trigger,
    }
    // An absent optional field is left out of the line (the logger writes JSON).
    if (event.type === "started") {
      log.info("claude_refresh_started", { ...fields, expiresAt: event.expiresAt })
      return
    }
    if (event.type === "ok") {
      log.info("claude_refresh_ok", { ...fields, ms: event.ms, expiresAt: event.expiresAt, rotated: event.rotated })
      state.refreshes.delete(event.key)
      state.expiries.set(event.key, event.expiresAt)
    } else {
      log.warn("claude_refresh_failed", {
        ...fields,
        kind: event.kind,
        status: event.status,
        error: event.error,
        description: event.description,
        reason: event.reason,
        retryAfterMs: event.retryAfterMs,
        retryAt: event.retryAt,
        ms: event.ms,
      })
      state.refreshes.set(event.key, {
        kind: event.kind,
        at: deps.clock.now(),
        status: event.status,
        ...(event.error === undefined ? {} : { error: event.error }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }),
      })
    }
    watchRefresh()
  }

  /**
   * 02 §8.7 (CS): the leader looks every {@link SHARED_POLL_MS} whether an account on Claude Code's own login went
   * stale (its token expired) or fresh again (Claude Code refreshed it: the plugin reads that login again whenever
   * Claude Code rewrote its file), and tells the clients (`account.status`), whose accounts page then reads the list
   * again. Never reads a credential.
   */
  const watchShared = () => {
    if (deps.remote || !deps.runtime.isLeader()) return
    const now = new Map(
      all()
        .filter((item) => item.readOnly && state.loaded.has(item.key))
        .map((item) => [item.accountID, stale(item)] as const),
    )
    for (const accountID of new Set([...announced.keys(), ...now.keys()])) {
      const waiting = now.get(accountID) ?? false
      if ((announced.get(accountID) ?? false) === waiting) continue
      log.info("claude_shared_login", { accountID, stale: waiting })
      void deps.emitter
        .global("account.status", {
          accountID,
          status: waiting ? "needs_reauth" : "ready",
          ...(waiting ? { reason: "claude_shared_stale" } : {}),
        })
        .catch((error: unknown) => log.warn("claude_shared_event_failed", { error }))
    }
    announced.clear()
    for (const [accountID, waiting] of now) announced.set(accountID, waiting)
  }
  /**
   * CR: the leader tells the clients when an account's refresh line changed (`account.status{reason: "claude_refresh"}`,
   * `needs_reauth` while it failed for good), whose accounts page then reads the list again.
   */
  const watchRefresh = () => {
    if (deps.remote || !deps.runtime.isLeader()) return
    const now = new Map(
      all().map((item) => {
        const view = refreshView(item)
        return [
          item.accountID,
          view === undefined ? "" : `${view.state}:${view.status ?? ""}:${view.error ?? ""}`,
        ] as const
      }),
    )
    for (const [accountID, key] of now) {
      if ((announcedRefresh.get(accountID) ?? "") === key) continue
      log.info("claude_refresh_line", { accountID, line: key || "none" })
      void deps.emitter
        .global("account.status", {
          accountID,
          status: key.startsWith("failed:") ? "needs_reauth" : "ready",
          reason: "claude_refresh",
        })
        .catch((error: unknown) => log.warn("claude_refresh_event_failed", { error }))
    }
    announcedRefresh.clear()
    for (const [accountID, key] of now) announcedRefresh.set(accountID, key)
  }
  /**
   * Every instance reads the folders' realpaths (the leader rewrites the list when one became Claude Code's) and which
   * logins the plugin holds again (a login Claude Code made later); the leader announces.
   */
  const pollShared = () => {
    poll.cancel = deps.clock.schedule(SHARED_POLL_MS, pollShared)
    void (deps.runtime.isLeader() ? sync() : resolveFolders())
      .then(refreshLoaded)
      .then(() => {
        watchShared()
        watchRefresh()
      })
      .catch((error: unknown) => log.warn("claude_shared_watch_failed", { error }))
  }

  /** The account's uuid: the entry's, else the one {@link resolveFolders} read from its folder. */
  const uuidOf = (item: Entry) => item.accountUuid ?? (state.uuids.get(item.key) || undefined)

  const views = (slot: { readonly verified: boolean; readonly version: string | null }, extra: ViewExtra) => {
    const counts = new Map<string, { running: number; total: number }>()
    for (const session of deps.runtime.sessions.list({ providerID: Provider.ID.anthropic })) {
      const accountID = last.get(session.sessionID) ?? defaultID()
      const count = counts.get(accountID) ?? { running: 0, total: 0 }
      count.total++
      if (session.busy) count.running++
      counts.set(accountID, count)
    }
    return list().map((item, index): Account.View => {
      const windows = extra.windows(item.accountID)
      // A remote service holds no login at all: the PC decides per request (04 §8.11.18).
      const loaded = deps.remote ? null : state.multi ? state.loaded.has(item.key) : index === 0 ? null : false
      const waiting = loaded === true && stale(item)
      const refresh = refreshView(item)
      return {
        id: item.accountID,
        kind: "claude-sub",
        label: item.label ?? (index === 0 ? "Claude" : (item.email ?? `Claude ${index + 1}`)),
        shortLabel: item.shortLabel,
        color: item.color,
        providerID: Provider.ID.make("anthropic"),
        billing: "subscription",
        status: !slot.verified
          ? "unverified"
          : loaded === false || waiting || refresh?.state === "failed"
            ? "needs_reauth"
            : "ready",
        autoSwitch: false,
        thirdParty: true,
        readOnly: true,
        connection: { type: "oauth", method: "claude-code" },
        limitsSummary: extra.summary(windows),
        plugin: { installed: true, acknowledged: slot.verified, version: slot.version },
        claude: {
          managed: item.managed,
          default: item.default,
          folder: item.configDir,
          ...(item.email === undefined ? {} : { email: item.email }),
          loaded: state.multi || index !== 0 ? loaded : null,
          ...(item.readOnly ? { shared: true, stale: waiting } : {}),
          ...(refresh === undefined ? {} : { refresh }),
          ...(uuidOf(item) === undefined ? {} : { accountUuid: uuidOf(item) }),
        },
        sessions: counts.get(item.accountID) ?? { running: 0, total: 0 },
        ...(extra.compaction === undefined ? {} : { compaction: extra.compaction }),
      }
    })
  }

  /**
   * The end of a login window. A new folder (made just now: a new account's, or the one `move` takes account 1 to)
   * goes again unless it holds a login of an account this PC does not have yet. `다시 로그인` (`relogin`) wrote into an
   * existing account's folder, which always stays: the account takes the new login (its e-mail and uuid follow) unless
   * that login is another account of this PC's. `move` (CS): account 1 leaves Claude Code's own folder for the new one;
   * its id, label, color, bindings and ledger stay, and Claude Code's folder is left as it is. A login of another
   * Claude account than the shared one (`mismatch`) leaves it where it was.
   */
  const finishLogin = async (
    attemptID: string,
    accountID: Account.ID,
    folder: string,
    mode: LoginMode,
    outcome: ClaudeLogin.Outcome,
  ) => {
    const attempt = attempts.get(attemptID)!
    const relogin = mode === "relogin"
    // A login may change the account a folder holds: its uuid is read again.
    state.uuids.clear()
    if (outcome.type !== "logged_in") {
      attempt.state = outcome.type === "cancelled" ? "failed" : outcome.type
      if (!relogin) await Fsx.removeTree(folder).catch(() => undefined)
      log.info("claude_login_ended", { outcome: outcome.type, mode })
      return
    }
    const profile = await ClaudeLogin.profile(folder, config.userHome)
    const others = await Promise.all(
      all()
        .filter((item) => item.accountID !== accountID)
        .map(async (item) => ({
          item,
          uuid: item.accountUuid ?? (await ClaudeLogin.profile(item.configDir, config.userHome))?.accountUuid,
        })),
    )
    const duplicate =
      profile?.accountUuid === undefined ? undefined : others.find((other) => other.uuid === profile.accountUuid)
    if (duplicate) {
      // A new folder goes again, so no second copy of that login stays; an account's own folder is never deleted.
      if (!relogin) await Fsx.removeTree(folder).catch(() => undefined)
      attempt.state = "duplicate"
      attempt.accountID = duplicate.item.accountID
      log.info("claude_login_duplicate", { accountID: duplicate.item.accountID, mode })
      return
    }
    const email = profile?.email === undefined ? undefined : Claude.maskEmail(profile.email)
    if (mode === "move") {
      // The own login must be the Claude account the shared one is (its uuid), else the account would turn into another
      // subscription under its name, bindings and history. Not known on either side: the login is taken.
      const before = entry(accountID)
      const previous =
        before === undefined
          ? undefined
          : (before.accountUuid ?? (await ClaudeLogin.profile(before.configDir, config.userHome))?.accountUuid)
      if (profile?.accountUuid !== undefined && previous !== undefined && previous !== profile.accountUuid) {
        await Fsx.removeTree(folder).catch(() => undefined)
        attempt.state = "mismatch"
        attempt.accountID = accountID
        log.info("claude_login_mismatch", { accountID })
        return
      }
      await peers().slots.mutate((current) =>
        accountID === Account.ID.claudeSlot
          ? { ...current, claudeSlot: { ...(current.claudeSlot ?? SLOT_META), configDir: folder } }
          : {
              ...current,
              claudeAccounts: (current.claudeAccounts ?? []).map((item) =>
                item.accountID === accountID
                  ? { ...item, key: ClaudeLogin.key(folder), configDir: folder, managed: true }
                  : item,
              ),
            },
      )
      await sync()
      await refreshLoaded()
      hub.emit("claudeSlot.changed", { reason: "accounts" })
      attempt.state = "added"
      attempt.accountID = accountID
      attempt.label = labelOf(accountID)
      log.info("claude_account_moved", { accountID })
      return
    }
    if (relogin) {
      await peers().slots.mutate((current) => {
        const accounts = current.claudeAccounts ?? []
        if (!accounts.some((item) => item.accountID === accountID)) return undefined
        return {
          ...current,
          claudeAccounts: accounts.map((item) =>
            item.accountID === accountID
              ? {
                  ...item,
                  ...(email === undefined ? {} : { email }),
                  ...(profile?.accountUuid === undefined ? {} : { accountUuid: profile.accountUuid }),
                }
              : item,
          ),
        }
      })
      await sync()
      await refreshLoaded()
      hub.emit("claudeSlot.changed", { reason: "accounts" })
      attempt.state = "added"
      attempt.accountID = accountID
      attempt.label = labelOf(accountID)
      log.info("claude_account_relogged", { accountID })
      return
    }
    await peers().slots.mutate((current) => {
      const accounts = current.claudeAccounts ?? []
      const added: Registry.ClaudeAccount = {
        accountID,
        key: ClaudeLogin.key(folder),
        configDir: folder,
        label: null,
        shortLabel: `C${accounts.length + 2}`,
        color: COLORS[accounts.length % COLORS.length]!,
        managed: true,
        ...(email === undefined ? {} : { email }),
        ...(profile?.accountUuid === undefined ? {} : { accountUuid: profile.accountUuid }),
        addedAt: new Date(deps.clock.now()).toISOString(),
      }
      return { ...current, claudeAccounts: [...accounts, added] }
    })
    await sync()
    await refreshLoaded()
    hub.emit("claudeSlot.changed", { reason: "accounts" })
    const plan = state.labels.get(ClaudeLogin.key(folder))?.split(":")[0]?.trim() || "Claude"
    attempt.state = "added"
    attempt.accountID = accountID
    attempt.label = email === undefined ? plan : `${plan} · ${email}`
    log.info("claude_account_added", { accountID })
  }

  /**
   * Login folders own made (`<OWN_HOME>\claude-accounts\acc_*`) that no account names and no window of this instance
   * is filling, older than the login limit: a window that outlived its service, or a login whose registration failed.
   * Deleted, so no live refresh token stays behind unmanaged. The leader only.
   */
  const sweep = async () => {
    if (deps.remote || !deps.runtime.isLeader()) return
    const dir = deps.runtime.layout.claudeAccounts
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const known = new Set(
      [...all(), ...[...logins.values()].map((login) => ({ configDir: login.folder }))].map((item) =>
        ClaudeLogin.key(item.configDir),
      ),
    )
    const cutoff = config.login.now() - config.login.timeoutMs - SWEEP_MARGIN_MS
    for (const name of names.filter((item) => item.startsWith("acc_"))) {
      const folder = path.join(dir, name)
      if (known.has(ClaudeLogin.key(folder))) continue
      const stat = await fs.stat(folder).catch(() => undefined)
      // A login writes into its folder, so a folder whose last change is older than the limit has no window filling it.
      if (!stat?.isDirectory() || stat.mtimeMs > cutoff) continue
      await Fsx.removeTree(folder).catch(() => undefined)
      log.info("claude_login_folder_swept", {})
    }
  }

  /**
   * Takes an added account out of the registry and the plugin's list; its teams, then its trees move to the default.
   * Answers the sessions it knew bound to it and the sessions that moved.
   */
  const drop = async (accountID: Account.ID, planned: ReadonlyArray<string>) => {
    await peers().slots.mutate((current) => {
      const kept = (current.claudeAccounts ?? []).filter((item) => item.accountID !== accountID)
      const next = { ...current, claudeAccounts: kept }
      return current.claudeDefault === accountID ? omitDefault(next) : next
    })
    const fallback = defaultID()
    // Teams first (their members follow the team's binding), then the trees.
    for (const team of await teamsBoundTo(accountID)) {
      await write(Kv.claudeTeam(team), fallback)
      announce([...new Set((await teamRoots(team)).flatMap(tree))], fallback, "removed")
    }
    const sessions = [...new Set([...planned, ...(await boundTo(accountID))])]
    const moved = await Promise.all(sessions.map((sessionID) => rebind(sessionID, fallback, "removed")))
    await sync()
    hub.emit("claudeSlot.changed", { reason: "accounts" })
    return { sessions, moved }
  }

  /** `claudeDefault` (absent for the slot's own account), written only when it changes. */
  const chooseDefault = async (accountID: Account.ID) => {
    if (defaultID() === accountID) return
    await peers().slots.mutate((current) =>
      accountID === Account.ID.claudeSlot ? omitDefault(current) : { ...current, claudeDefault: accountID },
    )
  }

  /** The teams bound to `accountID` (KV `claude:team:<teamID>`). */
  const teamsBoundTo = async (accountID: Account.ID) => {
    const page = async (after?: string): Promise<string[]> => {
      const result = await deps.ctx.storage.scan({
        prefix: TEAM_PREFIX,
        ...(after === undefined ? {} : { after }),
        limit: 1000,
      })
      const found = result.entries.flatMap((item) =>
        Option.getOrUndefined(decodeBound(item.value))?.accountID === accountID
          ? [item.key.slice(TEAM_PREFIX.length)]
          : [],
      )
      return result.next === undefined ? found : [...found, ...(await page(result.next))]
    }
    return page()
  }

  /** The tree roots and teams bound to `accountID` (KV), and every known session that resolves to it. */
  const boundTo = async (accountID: Account.ID) => {
    const page = async (after?: string): Promise<string[]> => {
      const result = await deps.ctx.storage.scan({
        prefix: Kv.CLAUDE_SESSION_PREFIX,
        ...(after === undefined ? {} : { after }),
        limit: 1000,
      })
      const found = result.entries.flatMap((item) =>
        Option.getOrUndefined(decodeBound(item.value))?.accountID === accountID
          ? [item.key.slice(Kv.CLAUDE_SESSION_PREFIX.length)]
          : [],
      )
      return result.next === undefined ? found : [...found, ...(await page(result.next))]
    }
    const rooted = await page()
    const resolved = [...last.entries()].filter((item) => item[1] === accountID).map((item) => item[0])
    return [...new Set([...rooted, ...resolved])].filter(isSessionID)
  }

  return {
    start: async () => {
      await resolveFolders()
      unsubscribe.push(
        hub.on("claude.bound", (change) => {
          for (const sessionID of change.sessionIDs) {
            last.set(sessionID, change.accountID as Account.ID)
            const root = roots.get(sessionID)
            if (root) bindings.delete(Kv.claudeSession(root))
          }
          for (const key of [...bindings.keys()]) if (key.startsWith("claude:team:")) bindings.delete(key)
        }),
        hub.on("claudeSlot.changed", () => {
          void sync()
            .then(refreshLoaded)
            .catch((error: unknown) => log.warn("claude_sync_failed", { error }))
        }),
        hub.on("store.changed", (change) => {
          if (change.store !== "accounts") return
          void sync().catch((error: unknown) => log.warn("claude_sync_failed", { error }))
        }),
        deps.runtime.claude.install((request) => signer(request) ?? remoteSigner(request)),
      )
      state.started = true
      await sync().catch((error: unknown) => log.warn("claude_sync_failed", { error }))
      await refreshLoaded().catch((error: unknown) => log.warn("claude_loaded_unknown", { error }))
      if (!deps.remote) {
        pollShared()
        unsubscribe.push(() => poll.cancel())
      }
      // Login folders a window of an earlier service filled after it stopped: now, and once more after the limit.
      void sweep().catch((error: unknown) => log.warn("claude_sweep_failed", { error }))
      unsubscribe.push(
        deps.clock.schedule(config.login.timeoutMs + SWEEP_MARGIN_MS, () => {
          void sweep().catch((error: unknown) => log.warn("claude_sweep_failed", { error }))
        }),
      )
    },
    stop: async () => {
      state.started = false
      for (const off of unsubscribe.splice(0)) off()
      // An open login window is closed and its folder removed: no login lands where nothing would register it.
      const open = [...logins.values()]
      for (const login of open) login.controller.abort()
      await Promise.all(open.map((login) => login.running))
    },
    onEvent: (event) => {
      if (event.type === "session.deleted") {
        roots.delete(event.data.sessionID)
        last.delete(event.data.sessionID)
        handled.delete(event.data.sessionID)
      }
    },

    list,
    entry,
    defaultID,
    multi: () => state.multi,
    usable: (accountID) => {
      const item = entry(accountID)
      if (!item || deps.remote) return false
      return state.multi
        ? state.loaded.has(item.key) && !stale(item) && !failed(item)
        : item.accountID === Account.ID.claudeSlot
    },
    accountOf,
    peek: (sessionID) => last.get(sessionID) ?? defaultID(),
    onHttpRequest,
    onHttpResponse,
    rebind,
    signer,
    views,
    sync,
    ready,
    onRetry,

    busy: async (accountID) => {
      const roots = [
        ...(await boundTo(accountID)),
        ...(await Promise.all((await teamsBoundTo(accountID)).map((team) => teamRoots(team)))).flat(),
      ]
      return [...new Set(roots.flatMap(tree))].filter((sessionID) => deps.runtime.sessions.get(sessionID)?.busy === true)
    },

    release: async (accountID) => {
      if (accountID === Account.ID.claudeSlot || !entry(accountID)) return
      await drop(accountID, [])
      log.info("claude_account_released", { accountID })
    },

    adopt: async (input) => {
      await peers().slots.mutate((current) => {
        const accounts = current.claudeAccounts ?? []
        const added: Registry.ClaudeAccount = {
          accountID: input.accountID,
          key: ClaudeLogin.key(input.folder),
          configDir: input.folder,
          label: input.from.label,
          shortLabel: `C${accounts.length + 2}`,
          color: input.from.color,
          managed: true,
          ...(input.from.email === undefined ? {} : { email: input.from.email }),
          ...(input.from.accountUuid === undefined ? {} : { accountUuid: input.from.accountUuid }),
          addedAt: new Date(deps.clock.now()).toISOString(),
        }
        return { ...current, claudeAccounts: [...accounts, added] }
      })
      await sync()
      await refreshLoaded().catch((error: unknown) => log.warn("claude_loaded_unknown", { error }))
      hub.emit("claudeSlot.changed", { reason: "accounts" })
      log.info("claude_account_adopted", { accountID: input.accountID })
    },

    sessionGet: async (input) => {
      const found = await bindingOf(input.sessionID)
      return { accountID: await accountOf(input.sessionID), bound: found.bound !== null }
    },

    sessionSet: async (input, context) => {
      const target = entry(input.accountID)
      if (!target) return context.error("account_not_found", "no such Claude account", { accountID: input.accountID })
      if (!deps.remote && input.accountID !== Account.ID.claudeSlot && !(await multiApi()))
        return context.error("claude_account_unavailable", "the installed claude-auth runs one account", {
          reason: "not_patched",
        })
      const sessions = await rebind(input.sessionID, input.accountID, "user")
      // New conversations start on the account chosen last (02 §8.7).
      if (!deps.remote) await chooseDefault(input.accountID)
      return { accountID: input.accountID, sessions: sessions.filter(isSessionID) }
    },

    defaultSet: async (input, context) => {
      if (!entry(input.accountID))
        return context.error("account_not_found", "no such Claude account", { accountID: input.accountID })
      if (input.accountID !== Account.ID.claudeSlot && !(await multiApi()))
        return context.error("claude_account_unavailable", "the installed claude-auth runs one account", {
          reason: "not_patched",
        })
      await chooseDefault(input.accountID)
      return { accountID: input.accountID }
    },

    addPlan: async (input, context) => {
      const slot = peers().plugins.claudeSlot()
      if (!slot.detected) return context.error("plugin_not_installed", "claude-auth is not loaded", {})
      if (!(await multiApi()))
        return context.error("claude_account_unavailable", "the installed claude-auth runs one account", {
          reason: "not_patched",
        })
      const cli = await ClaudeLogin.find(config.login)
      // Relogin or move is decided on the folders as they are now, not as the last watch saw them.
      await resolveFolders()
      // `다시 로그인`: the same login window into the account's own folder (an expired or revoked login).
      const existing = input.accountID === undefined ? undefined : entry(input.accountID)
      if (input.accountID !== undefined && !existing)
        return context.error("account_not_found", "no such Claude account", { accountID: input.accountID })
      // CS: never a login into Claude Code's own folder (it would replace Claude Code's login and keep sharing it); the
      // account moves to a new own folder instead (`own 전용 로그인으로 바꾸기`).
      const mode: LoginMode = existing === undefined ? "add" : existing.readOnly ? "move" : "relogin"
      const accountID = existing?.accountID ?? Account.ID.create()
      const folder =
        existing !== undefined && mode === "relogin"
          ? existing.configDir
          : path.join(deps.runtime.layout.claudeAccounts, mode === "move" ? Account.ID.create() : accountID)
      return {
        ...adds.issue({ accountID, folder, mode }),
        cli: cli?.[0] ?? null,
        folder,
        ...(mode === "move" ? { move: true } : {}),
      }
    },

    addExecute: async (input, context) => {
      const planned = adds.consume(input.nonce)
      if (!planned) return context.error("nonce_invalid", "unknown or expired nonce", {})
      // A `다시 로그인` into a folder that turned into Claude Code's since the plan would replace Claude Code's login:
      // planned again, it moves instead (CS).
      await resolveFolders()
      if (planned.mode === "relogin" && entry(planned.accountID)?.readOnly)
        return context.error("nonce_invalid", "the account's folder is Claude Code's now: plan again", {})
      if ([...attempts.values()].some((attempt) => attempt.state === "waiting"))
        return context.error("claude_account_unavailable", "a login window is already open", { reason: "busy" })
      const cli = await ClaudeLogin.find(config.login)
      if (!cli)
        return context.error("claude_account_unavailable", "Claude Code is not installed", { reason: "cli_missing" })
      await fs.mkdir(planned.folder, { recursive: true })
      const attemptID =
        planned.mode === "add"
          ? `cla_${planned.accountID.slice("acc_".length)}`
          : `cla_${Account.ID.create().slice("acc_".length)}`
      attempts.set(attemptID, { state: "waiting" })
      log.info("claude_login_started", { accountID: planned.accountID, mode: planned.mode })
      const controller = new AbortController()
      const running = ClaudeLogin.run(config.login, cli, planned.folder, controller.signal)
        .then((outcome) => finishLogin(attemptID, planned.accountID, planned.folder, planned.mode, outcome))
        .catch(async (error: unknown) => {
          // A new folder that nothing names goes, so no login of it stays behind unmanaged; an account's stays.
          log.warn("claude_login_failed", { error })
          attempts.set(attemptID, { state: "failed" })
          if (planned.mode !== "relogin") await Fsx.removeTree(planned.folder).catch(() => undefined)
        })
        .finally(() => logins.delete(attemptID))
      logins.set(attemptID, { folder: planned.folder, controller, running })
      return { attemptID }
    },

    addStatus: async (input, context) => {
      const attempt = attempts.get(input.attemptID)
      if (!attempt) return context.error("nonce_invalid", "unknown login", {})
      return {
        state: attempt.state,
        ...(attempt.accountID === undefined ? {} : { accountID: attempt.accountID }),
        ...(attempt.label === undefined ? {} : { label: attempt.label }),
      }
    },

    detect: async () => {
      const folder = registry().claudeSlot?.configDir ?? (await baseFolder(deps, config.userHome))
      const signed = await ClaudeLogin.signedIn(folder)
      const email = signed ? (await ClaudeLogin.profile(folder, config.userHome))?.email : undefined
      const connection = await deps.ctx.integration.connection.active(Claude.PROVIDER_ID).catch(() => undefined)
      return {
        found: signed ? { folder, email: email === undefined ? null : Claude.maskEmail(email) } : null,
        imported: connection !== undefined,
      }
    },

    removePlan: async (input, context) => {
      await resolveFolders()
      const target = entry(input.accountID)
      if (!target || target.accountID === Account.ID.claudeSlot)
        return context.error("account_not_found", "not a removable Claude account", { accountID: input.accountID })
      // Never Claude Code's own folder (by realpath or credentials file: a junction or a link to it is Claude Code's).
      const offered = target.managed && !target.readOnly
      const sessions = await boundTo(target.accountID)
      return {
        ...removals.issue({ accountID: target.accountID, sessions, folder: offered ? target.configDir : undefined }),
        boundSessions: sessions,
        deleteFolder: { offered, default: offered },
      }
    },

    removeExecute: async (input, context) => {
      const planned = removals.consume(input.nonce)
      if (!planned) return context.error("nonce_invalid", "unknown or expired nonce", {})
      await resolveFolders()
      const target = entry(planned.accountID)
      if (!target)
        return context.error("account_not_found", "the account was removed", { accountID: planned.accountID })
      // A folder that turned into Claude Code's since the plan (a junction or a link made meanwhile) is never deleted.
      const folder = target.readOnly ? undefined : planned.folder
      const { sessions, moved } = await drop(planned.accountID, planned.sessions)
      const folderDeleted =
        input.deleteFolder && folder !== undefined
          ? await Fsx.removeTree(folder).then(
              () => true,
              () => false,
            )
          : false
      log.info("claude_account_removed", { accountID: planned.accountID, sessions: sessions.length, folderDeleted })
      return { movedSessions: [...new Set(moved.flat())].filter(isSessionID), folderDeleted }
    },
  }

  function signer(request: Request) {
    const key = state.api?.accountOf(request)
    if (key === undefined) return undefined
    return all().find((item) => item.key === key)?.accountID
  }

  /** A remote service: the account the relayed request's proof named. */
  function remoteSigner(request: Request) {
    const accountID = deps.remote?.claudeSigner(request)
    return accountID === undefined ? undefined : entry(accountID)?.accountID
  }
}

/** Why own refuses a request before the plugin signs it ({@link Api.onHttpRequest}). */
type Refusal = "one_account" | "gone" | "not_loaded" | "not_listed"

/** What makes two login folders one (CS): the folder's realpath key, its credentials file's and that file's id. */
interface Identity {
  readonly folder: string
  readonly file: string
  readonly id: string | null
}

/** A folder's {@link Identity}; a path that does not exist (yet) is its own, and a missing file has no id. */
async function identity(folder: string): Promise<Identity> {
  const real = async (target: string) => ClaudeLogin.key(await fs.realpath(target).catch(() => target))
  const file = path.join(folder, ".credentials.json")
  const stat = await fs.stat(file, { bigint: true }).catch(() => undefined)
  return {
    folder: await real(folder),
    file: await real(file),
    // A file system without file ids answers 0 for every file.
    id: stat === undefined || stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`,
  }
}

/** Account 1's folder: `claude-auth.json`'s `configDir` (8.7 계정 소스), else `<userHome>\.claude`. */
export async function baseFolder(deps: Deps, userHome: string) {
  const text = await Fsx.readText(deps.runtime.layout.claudeAuth).catch(() => undefined)
  const configDir = text === undefined ? undefined : Option.getOrUndefined(decodeSource(text))?.configDir
  return configDir && path.isAbsolute(configDir) ? configDir : path.join(userHome, ".claude")
}

const decodeSource = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ configDir: Schema.String })))

/** The default account: `claudeDefault` when it is still an account, else the slot's own. */
export function defaultOf(file: Registry.File): Account.ID {
  const chosen = file.claudeDefault
  return chosen !== undefined && (file.claudeAccounts ?? []).some((item) => item.accountID === chosen)
    ? chosen
    : Account.ID.claudeSlot
}

function omitDefault(file: Registry.File): Registry.File {
  const { claudeDefault: _default, ...rest } = file
  return rest
}
