// OwnStore (03 §15.3): router data from `own.accounts`, normalized by id, updated by events, resynced on every
// `server.connected` (02 §9.1 "재동기화"). Screens read it; only this file and rpc.ts know the RPC id. Presets
// (07 §8.1): every group's `presets.list` view and the global preset settings, and the `session.preset.get` view of
// the root sessions a screen watches; their `session.speed.get` view too (02 §4.8, the composer's 속도), and the
// `speed.offers` of the mains a screen shows before a session exists (the new-conversation composer, the switcher).
import type { OpenCodeClient } from "@opencode/client"
import type { Account, Alert, Cache, ClaudeAgent, Limit, OwnAccounts, Policy, Speed, Switch } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { batch, createEffect, createSignal, getOwner, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { kept } from "@/limits/windows"
import { markOnce } from "@/perf/marks"
import type { EventBus } from "./events"
import { createKeyedCoalescer } from "./frame"
import {
  ownEvent,
  OwnRpcError,
  type OwnEvent,
  type OwnEventData,
  type OwnEventName,
  type OwnOutput,
  type OwnRpc,
} from "./rpc"

export type OwnStatus = "idle" | "loading" | "ready" | "unmanaged" | "unavailable"

export interface AlertEntry {
  readonly id: string
  readonly at: number
  readonly code: Alert.Code
  readonly severity: Alert.Severity
  readonly message: string
  readonly sessionID?: string
  readonly accountID?: string
}

export interface CompactionRequest {
  readonly inputID: string
  readonly triggerTokens: number
  readonly at: number
}

/** The global settings of `presets.list` (07 §8.1), with the defaults of an older service filled in. */
export interface PresetSettings {
  /** The preset a new session starts with (07 §5.1). */
  newSession: Preset.NewSession
  /** Recently applied presets, newest first (the composer's `최근`). */
  recent: Preset.ID[]
  /** The global ultra level or the user's own three numbers (07 §2.6). */
  ultraCaps: Preset.UltraCaps
}

export interface OwnState {
  status: OwnStatus
  /** Why `unmanaged`/`unavailable`: the guard value or the RPC error type. */
  reason?: string
  health?: OwnAccounts.Health
  revision?: number
  accounts: Record<string, Account.View>
  /** Server order of `accounts.list`. */
  accountOrder: string[]
  /** providerID → accountID; MVP is one account per provider (03 §4.5 turn footer). */
  accountByProvider: Record<string, string>
  /** accountID → windows. */
  quota: Record<string, Limit.Window[]>
  /**
   * `quota.snapshot` answered once, so an account without an entry in {@link quota} has no windows. Until then the card's
   * state tag has only the list's `limitsSummary.worst` (`cardLead`).
   */
  quotaLoaded: boolean
  /** accountID → its reset credit count (02 §7.1.1), from `quota.snapshot`, `quota.updated` and the 리셋권 calls. */
  resetCredits: Record<string, Limit.ResetCredits>
  binding: Record<string, OwnAccounts.Binding>
  cache: Record<string, Cache.Snapshot>
  switchState: Record<string, Switch.State>
  /** Last `compaction.due` this client executed, per session (03 §8 "세션 압축 요청함"). */
  compactionRequested: Record<string, CompactionRequest>
  /** Provider group → its new-session default model (`presets.list`, 07 §2.2). */
  groupDefaults: Record<string, Preset.DefaultModel>
  /** Kind → the account a new session prefers (`policy.defaults.byKind`, 07 §2.2 rule 3). */
  defaultAccounts: Policy.ByKind
  /** `presets.list` answered (or failed) once; until then a new session has no default model to show. */
  defaultsLoaded: boolean
  /**
   * Provider group → its `presets.list` view (07 §8.1): the presets (★ first, `평소대로` always), ★, lighter pairs and
   * status. On an SSH host's store the host's own list (07 §8.1 원격, T3): the mirror of this PC's presets without
   * repairs, or `평소대로` only from an older host.
   */
  presetGroups: Record<string, Preset.GroupView>
  /** The global settings of the same `presets.list` (an SSH host's are its mirror of this PC's). */
  presetSettings: PresetSettings
  /** Root sessionID → `session.preset.get` of the sessions a screen watches (`watchPreset`). */
  sessionPreset: Record<string, Preset.SessionView>
  /** Root sessionID → `session.speed.get` of the sessions a screen watches (`watchSpeed`, 02 §4.8). */
  sessionSpeed: Record<string, Speed.View>
  /** {@link speedOffersKey} → `speed.offers` of the mains a screen shows before a session runs on them (`watchSpeedOffers`). */
  speedOffers: Record<string, Speed.Targeted>
  /** Newest first, at most 50 (03 §9 bell list). */
  alerts: AlertEntry[]
  /**
   * accountID → why it is out of service now, from `account.status{status, reason}` (02 §9.2), e.g. the Sign in with
   * ChatGPT usage-limit code. Removed on `status: "ready"`; in memory only, the list's `status` stays the record. A
   * resync replaces exhaustion reasons with the `quota.snapshot` ones.
   */
  statusReason: Record<string, string>
  /**
   * The Claude Agent process pool (02 §8.10.12): read with `claudeAgent.status` when the window opens (and on each
   * resync) while a Claude Agent account exists, then kept by `claudeAgent.pool` events.
   */
  claudeAgentPool?: ClaudeAgent.Pool
}

const COALESCE_MS = 250
const SEEN_LIMIT = 1024
const ALERT_LIMIT = 50
const BINDING_BATCH = 500

type Listener = (event: OwnEvent) => void

export function createOwnStore(input: {
  readonly rpc: OwnRpc
  readonly bus: EventBus
  readonly client: () => OpenCodeClient
  /** Directory of a known session, for `session.binding` grouping. */
  readonly sessionDirectory: (sessionID: string) => string | undefined
  /**
   * SSH servers (04 §12.6): accounts and limits come from this PC's store (the local control location), not from
   * the host's own.accounts, whose mirror has the same account and provider ids but never announces changes (a remote
   * service publishes no global events). Session methods (binding, cache, switch) stay on this server.
   */
  readonly registry?: () => OwnStore | undefined
  /** Tests shorten how long `rpc.unavailable` counts as a service still starting (`STARTING_MS`). */
  readonly startingMs?: number
}) {
  const [state, setState] = createStore<OwnState>({
    status: "idle",
    accounts: {},
    accountOrder: [],
    accountByProvider: {},
    quota: {},
    quotaLoaded: false,
    resetCredits: {},
    binding: {},
    cache: {},
    switchState: {},
    compactionRequested: {},
    groupDefaults: {},
    defaultAccounts: {},
    defaultsLoaded: false,
    presetGroups: {},
    presetSettings: { newSession: "star", recent: [], ultraCaps: Preset.ULTRA_LEVEL },
    sessionPreset: {},
    sessionSpeed: {},
    speedOffers: {},
    alerts: [],
    statusReason: {},
  })
  const seen = new Set<string>()
  /**
   * `quota.updated` and `account.status` events applied so far: a resync asks for the snapshot again when one arrived
   * while it waited.
   */
  let snapshotEvents = 0
  /** `claudeAgent.pool` events seen: a pool read answered after one is older than the event. */
  let poolEvents = 0
  const listeners = new Map<OwnEventName, Set<Listener>>()
  /**
   * Reference counts: sessions whose chips are visible (binding), sessions that are open (cache, switch) and root
   * sessions whose preset view is on screen (`session.preset.get`).
   */
  const visible = new Map<string, number>()
  const open = new Map<string, number>()
  const presetViews = new Map<string, number>()
  const speedViews = new Map<string, number>()
  const offerViews = new Map<string, number>()
  /** An SSH host's presets were asked for once (`refreshPresets`): every resync reads them again (07 §8.1 원격). */
  let hostPresets = false
  // Plugins load in the background since upstream v2.4.0 (#63814): right after a service start own.accounts may not have
  // registered yet and answers `rpc.unavailable`. That is "still starting", not an unmanaged instance: the store keeps
  // `loading` and asks again (backoff, and at once on `plugin.updated`) for up to STARTING_MS before the banner shows.
  let starting: { readonly since: number; attempt: number; timer?: ReturnType<typeof setTimeout> } | undefined
  /**
   * Sessions whose directory was not known when something was read for them ({@link directoryOf}): a conversation
   * opened by its link before the session list or its info arrived. Session methods go to the session's own Location
   * (02 §9.1), so its binding, cache and switch state, preset and speed views are read once the directory is known.
   */
  const [waiting, setWaiting] = createSignal<readonly string[]>([])
  if (getOwner())
    createEffect(() => {
      const known = waiting().filter((id) => input.sessionDirectory(id) !== undefined)
      if (known.length === 0) return
      setWaiting((ids) => ids.filter((id) => !known.includes(id)))
      if (untrack(() => state.status) !== "ready") return
      void loadBindings(known.filter((id) => visible.has(id))).catch(report)
      known.forEach((id) => {
        if (open.has(id)) void loadSession(id).catch(report)
        if (presetViews.has(id)) void loadPreset(id).catch(report)
        if (speedViews.has(id)) void loadSpeed(id).catch(report)
      })
    })

  /** The session's directory; while it is not known the session waits for it (`waiting`). */
  function directoryOf(sessionID: string) {
    const directory = untrack(() => input.sessionDirectory(sessionID))
    if (directory === undefined) setWaiting((ids) => (ids.includes(sessionID) ? ids : [...ids, sessionID]))
    return directory
  }

  // 03 §16.4: these three are grouped at 250 ms on top of the per-frame batch; the last value per key wins.
  const quotaUpdates = createKeyedCoalescer<OwnEventData<"quota.updated">>(COALESCE_MS, (items) =>
    batch(() =>
      items.forEach((item) => {
        setState("quota", item.accountID, reconcile(kept(item.windows), { key: "id" }))
        // Absent: the count is unchanged; `null`: it is unknown now (a redeem whose read after it reported none).
        if (item.resetCredits === null) forgetResetCredits(item.accountID)
        if (item.resetCredits) setResetCredits(item.resetCredits)
      }),
    ),
  )
  const cacheUpdates = createKeyedCoalescer<OwnEventData<"cache.state">>(COALESCE_MS, (items) =>
    batch(() => items.forEach((item) => setState("cache", item.sessionID, reconcile(item)))),
  )
  const ledgerSteps = createKeyedCoalescer<OwnEvent<"ledger.step">>(COALESCE_MS, (items) => items.forEach(emit))

  function emit(event: OwnEvent) {
    listeners.get(event.name)?.forEach((listener) => {
      try {
        listener(event)
      } catch (error) {
        console.error("[own-web] own event listener failed", event.name, error)
      }
    })
  }

  function setAccounts(output: OwnOutput<"accounts.list">) {
    // Several Claude accounts share `anthropic` (02 §8.7): the first one listed (the slot's own) answers for the provider;
    // a session's own Claude account comes from its binding.
    const byProvider = Object.fromEntries(
      output.accounts.toReversed().map((account) => [account.providerID, account.id]),
    )
    batch(() => {
      setState("revision", output.revision)
      setState("accounts", reconcile(Object.fromEntries(output.accounts.map((account) => [account.id, account]))))
      setState("accountOrder", reconcile(output.accounts.map((account) => account.id)))
      setState("accountByProvider", reconcile(byProvider))
    })
  }

  function setQuota(windows: readonly Limit.Window[]) {
    const grouped: Record<string, Limit.Window[]> = {}
    for (const window of kept(windows)) (grouped[window.accountID] ??= []).push(window)
    batch(() => {
      setState("quota", reconcile(grouped, { key: "id" }))
      setState("quotaLoaded", true)
    })
  }

  function setResetCredits(credits: Limit.ResetCredits) {
    setState("resetCredits", credits.accountID, reconcile(credits))
  }

  function forgetResetCredits(accountID: string) {
    setState(
      "resetCredits",
      produce((counts) => {
        delete counts[accountID]
      }),
    )
  }

  /**
   * A missed `ready` or a service restart (which keeps no exhaustion) would otherwise leave a reason behind. Reasons
   * of accounts the list still shows out of service (a login problem) stay; the registry never records exhaustion.
   */
  function setStatusReasons(exhausted: readonly Limit.Exhausted[]) {
    const kept = Object.entries(state.statusReason).filter(([accountID]) => {
      const status = state.accounts[accountID]?.status
      return status !== undefined && status !== "ready"
    })
    const reasons = exhausted.map((exhaustion) => [exhaustion.accountID, exhaustion.reason] as const)
    setState("statusReason", reconcile(Object.fromEntries([...kept, ...reasons])))
  }

  /** The pool as the service has it now, so a window opened while a start waits shows its line at once (CAG-39). */
  async function loadPool() {
    if (input.registry || !Object.values(state.accounts).some((account) => account.kind === "claude-agent")) return
    const seen = poolEvents
    const status = await input.rpc.call("claudeAgent.status", {})
    if (poolEvents === seen && status.pool) setState("claudeAgentPool", reconcile(status.pool))
  }

  async function loadAccounts() {
    if (input.registry) return
    setAccounts(await input.rpc.call("accounts.list", {}))
  }

  /**
   * New-session defaults (07 §2.2) and the presets (07 §8.1): each group's default model and presets, the global
   * preset settings, and each kind's default account. The default accounts change only through `policy.set`, whose
   * answer this window applies ({@link setDefaultAccounts}); `presets.changed` reads `presets.list` alone.
   */
  async function loadDefaults(withPolicy: boolean) {
    if (input.registry) {
      if (hostPresets) await loadHostPresets()
      return
    }
    const [presets, policy] = await Promise.allSettled([
      input.rpc.call("presets.list", {}),
      withPolicy ? input.rpc.call("policy.get", {}) : undefined,
    ])
    batch(() => {
      if (presets.status === "fulfilled") setPresets(presets.value)
      if (policy.status === "fulfilled" && policy.value) setDefaultAccounts(policy.value.policy.defaults.byKind)
      // A server without `presets.list` (older build) still gets new sessions: the account's group rule then.
      setState("defaultsLoaded", true)
    })
    if (presets.status === "rejected") report(presets.reason)
    if (policy.status === "rejected") report(policy.reason)
    // CAG-5: the service turned a stored automatic Claude-to-Claude switch off once; the app says so once.
    const migrated = policy.status === "fulfilled" ? policy.value?.policy.migrated?.claudeToClaudeOff : undefined
    if (migrated?.changed && !migrated.noticed)
      void import("@/settings/claude-to-claude-notice").then((module) => module.notify(input.rpc), report)
  }

  function setPresets(output: OwnOutput<"presets.list">) {
    setState(
      "groupDefaults",
      reconcile(
        Object.fromEntries(
          output.groups.flatMap((row) => (row.defaultModel ? [[row.group, row.defaultModel] as const] : [])),
        ),
      ),
    )
    setPresetViews(output)
  }

  /**
   * An SSH host's presets (07 §8.1 원격, T3): its `presets.list` lists the mirror of this PC's `presets.json`, an older
   * host `평소대로` only. New-session defaults stay the registry store's. Read only once a screen asks
   * (`refreshPresets`: a remote composer, a preset menu opening), then on every resync; a remote service sends no
   * `presets.changed` (it publishes no global events). A failed read keeps the last list.
   */
  async function loadHostPresets() {
    const output = await input.rpc.call("presets.list", {}).catch((error: unknown) => {
      report(error)
      return undefined
    })
    if (output) batch(() => setPresetViews(output))
  }

  /** An older service answers without the T1 fields: no presets but `평소대로`, ★ new sessions, the default level. */
  function setPresetViews(output: OwnOutput<"presets.list">) {
    setState("presetGroups", reconcile(Object.fromEntries(output.groups.map((row) => [row.group, row]))))
    setState(
      "presetSettings",
      reconcile({
        newSession: output.newSession ?? "star",
        recent: [...(output.recent ?? [])],
        ultraCaps: output.ultraCaps ?? Preset.ULTRA_LEVEL,
      }),
    )
  }

  async function loadPreset(sessionID: string) {
    const directory = directoryOf(sessionID)
    if (directory === undefined) return
    const view = await input.rpc.call("session.preset.get", { sessionID }, { directory })
    // Released while the answer was on its way: keep no view nobody refreshes.
    if (presetViews.has(sessionID)) setState("sessionPreset", sessionID, reconcile(view))
  }

  /** A root's speed view (02 §4.8); an older service without `session.speed.get` leaves none. */
  async function loadSpeed(sessionID: string) {
    const directory = directoryOf(sessionID)
    if (directory === undefined) return
    const view = await input.rpc.call("session.speed.get", { sessionID }, { directory })
    if (speedViews.has(sessionID)) setState("sessionSpeed", sessionID, reconcile(view))
  }

  /** A main's offers before a session exists (2026-10-10); an older service without `speed.offers` leaves none. */
  async function loadOffers(key: string) {
    const [providerID = "", modelID = ""] = key.split(KEY_SEPARATOR)
    const view = await input.rpc.call("speed.offers", { providerID, modelID })
    if (offerViews.has(key)) setState("speedOffers", key, reconcile(view))
  }

  /** Every watched main's offers again: the accounts, the Claude slot or a consent changed what they offer. */
  function reloadOffers() {
    offerViews.forEach((_, key) => void loadOffers(key).catch(report))
  }

  function setDefaultAccounts(byKind: Policy.ByKind) {
    setState("defaultAccounts", reconcile({ ...byKind }))
  }

  // 04 §12.6: follow the registry store. The JSON copy reads every nested field, so any change re-runs the copy.
  if (input.registry) {
    const registry = input.registry
    createEffect(() => {
      const source = registry()?.state
      if (!source) return
      const copy = JSON.parse(
        JSON.stringify({
          revision: source.revision ?? null,
          accounts: source.accounts,
          accountOrder: source.accountOrder,
          accountByProvider: source.accountByProvider,
          quota: source.quota,
          quotaLoaded: source.quotaLoaded,
          resetCredits: source.resetCredits,
          groupDefaults: source.groupDefaults,
          defaultAccounts: source.defaultAccounts,
          defaultsLoaded: source.defaultsLoaded,
          // 02 §8.10.13: a host conversation's claude runs in this PC's pool, so its wait shows this PC's pool.
          claudeAgentPool: source.claudeAgentPool ?? null,
        }),
      ) as Pick<
        OwnState,
        | "accounts"
        | "accountOrder"
        | "accountByProvider"
        | "quota"
        | "quotaLoaded"
        | "resetCredits"
        | "groupDefaults"
        | "defaultAccounts"
        | "defaultsLoaded"
      > & { revision: number | null; claudeAgentPool: OwnState["claudeAgentPool"] | null }
      batch(() => {
        setState("revision", copy.revision ?? undefined)
        setState("accounts", reconcile(copy.accounts))
        setState("accountOrder", reconcile(copy.accountOrder))
        setState("accountByProvider", reconcile(copy.accountByProvider))
        setState("quota", reconcile(copy.quota))
        setState("quotaLoaded", copy.quotaLoaded)
        setState("resetCredits", reconcile(copy.resetCredits))
        setState("groupDefaults", reconcile(copy.groupDefaults))
        setState("defaultAccounts", reconcile(copy.defaultAccounts))
        setState("defaultsLoaded", copy.defaultsLoaded)
        if (copy.claudeAgentPool) setState("claudeAgentPool", reconcile(copy.claudeAgentPool))
      })
    })
  }

  async function loadBindings(sessionIDs: readonly string[]) {
    // `session.binding` goes to the sessions' own Location, so one call per directory (02 §9.1).
    const located = sessionIDs.flatMap((id) => {
      const directory = directoryOf(id)
      return directory === undefined ? [] : [{ id, directory }]
    })
    const byDirectory = Map.groupBy(located, (item) => item.directory)
    await Promise.all(
      [...byDirectory].flatMap(([directory, items]) =>
        chunks(
          items.map((item) => item.id),
          BINDING_BATCH,
        ).map(async (part) => {
          const output = await input.rpc.call("session.binding", { sessionIDs: part }, { directory })
          batch(() => output.bindings.forEach((binding) => setState("binding", binding.sessionID, reconcile(binding))))
        }),
      ),
    )
  }

  async function loadSession(sessionID: string) {
    const directory = directoryOf(sessionID)
    if (directory === undefined) return
    const [cache, switchState] = await Promise.all([
      input.rpc.call("cache.state", { sessionID }, { directory }),
      input.rpc.call("switch.state", { sessionID }, { directory }),
    ])
    batch(() => {
      setState("cache", sessionID, reconcile(cache))
      setState("switchState", sessionID, reconcile(switchState))
    })
  }

  /** 02 §9.1 resync list: health, accounts, quota, visible bindings, open sessions' cache and switch state. */
  async function resync() {
    if (starting?.timer !== undefined) clearTimeout(starting.timer)
    if (starting) starting.timer = undefined
    setState("status", (status) => (status === "ready" ? status : "loading"))
    // The first `health` after a service start waits for the vault helper, so accounts and quota do not wait for it.
    // Health still decides: on an unmanaged instance their calls fail (or answer) and are ignored.
    const revision = state.revision
    const snapshotSeen = snapshotEvents
    const [health, accounts, quota] = await Promise.allSettled([
      input.rpc.call("health", {}),
      input.registry ? undefined : input.rpc.call("accounts.list", {}),
      input.registry ? undefined : input.rpc.call("quota.snapshot", {}),
    ])
    try {
      const info = settled(health)
      setState("health", reconcile(info))
      if (info.guard !== "ok") {
        setState({ status: "unmanaged", reason: info.guard })
        return
      }
      // Events applied while health was pending can be newer than these early answers: a list that an
      // `accounts.changed` reload brought in meanwhile wins over an older one, and a `quota.updated` or
      // `account.status` means the snapshot is asked for again (it carries no revision).
      const list = settled(accounts)
      if (list && !(state.revision !== revision && list.revision < (state.revision ?? 0))) setAccounts(list)
      const snapshot = snapshotEvents === snapshotSeen ? settled(quota) : await input.rpc.call("quota.snapshot", {})
      if (snapshot) setQuota(snapshot.windows)
      // The whole set, as the windows: a count the service forgot while this window was away is not kept.
      if (snapshot)
        setState(
          "resetCredits",
          reconcile(Object.fromEntries((snapshot.resetCredits ?? []).map((credits) => [credits.accountID, credits]))),
        )
      if (snapshot?.exhausted) setStatusReasons(snapshot.exhausted)
      starting = undefined
      setState({ status: "ready", reason: undefined })
      markOnce("own:accounts-ready")
      await Promise.allSettled([
        loadBindings([...visible.keys()]),
        ...[...open.keys()].map(loadSession),
        loadDefaults(true),
        loadPool(),
        ...[...presetViews.keys()].map(loadPreset),
        ...[...speedViews.keys()].map(loadSpeed),
        ...[...offerViews.keys()].map(loadOffers),
      ])
    } catch (error) {
      const type = error instanceof OwnRpcError ? error.type : "network"
      if (type === "rpc.unavailable" && stillStarting()) return
      // RPC id missing, or only `health` registered because guard 1 failed: the unmanaged-instance screen (03 §8).
      if (type === "rpc.unavailable" || type === "rpc.method_not_found") setState({ status: "unmanaged", reason: type })
      else setState({ status: "unavailable", reason: type })
    }
  }

  /** While the service may still be loading own.accounts: stay `loading` and ask again later (see `starting`). */
  function stillStarting() {
    const now = Date.now()
    starting ??= { since: now, attempt: 0 }
    if (now - starting.since >= (input.startingMs ?? STARTING_MS)) return false
    const delay = Math.min(STARTING_STEP_MS * 2 ** starting.attempt, STARTING_MAX_STEP_MS)
    starting.attempt++
    setState({ status: "loading", reason: undefined })
    starting.timer = setTimeout(() => void resync(), delay)
    return true
  }

  function apply(event: OwnEvent) {
    switch (event.name) {
      case "accounts.changed":
        if (state.revision !== event.data.revision) void loadAccounts().catch(report)
        // A plan's model list (its tiers) or the account set changed what a main offers.
        reloadOffers()
        break
      case "plugin.status":
        // The Claude subscription slot came or went.
        reloadOffers()
        break
      case "presets.changed":
        // An edited preset resolves differently, and sessions on a removed one moved to the group's ★.
        void loadDefaults(false)
        presetViews.forEach((_, sessionID) => void loadPreset(sessionID).catch(report))
        break
      case "session.preset.changed":
        if (presetViews.has(event.data.sessionID)) void loadPreset(event.data.sessionID).catch(report)
        break
      case "session.speed.changed":
        if (speedViews.has(event.data.sessionID)) void loadSpeed(event.data.sessionID).catch(report)
        // A refused tier, a cooldown or the Claude consent changes every view of that main.
        reloadOffers()
        break
      case "quota.updated":
        if (input.registry) break
        snapshotEvents++
        quotaUpdates.push(event.data.accountID, event.data)
        break
      case "cache.state":
        cacheUpdates.push(event.data.sessionID, event.data)
        break
      case "ledger.step":
        ledgerSteps.push(event.data.eventId, event)
        return
      case "switch.state":
        setState("switchState", event.data.sessionID, reconcile(event.data.detail))
        break
      case "binding.changed":
        if (state.binding[event.data.sessionID]) void loadBindings([event.data.sessionID]).catch(report)
        // A new main (account, model or group) changes the resolution and maybe the preset in effect (07 §5.3).
        if (presetViews.has(event.data.sessionID)) void loadPreset(event.data.sessionID).catch(report)
        // …and what speeds the main offers (02 §4.8).
        if (speedViews.has(event.data.sessionID)) void loadSpeed(event.data.sessionID).catch(report)
        break
      case "compaction.due":
        void executeCompactionDue(event.data)
        break
      case "account.status": {
        const data = event.data
        const accountID = data.accountID
        if (!accountID || !data.status) break
        snapshotEvents++
        setState(
          "statusReason",
          produce((reasons) => {
            delete reasons[accountID]
            if (data.status !== "ready" && data.reason) reasons[accountID] = data.reason
          }),
        )
        // 02 §8.7 (CS, CR): a Claude account's card changes without a registry change (Claude Code's own login went
        // stale or Claude Code refreshed it; its refresh line changed): the list is read again.
        const listed = state.accounts[accountID]
        if (listed?.kind === "claude-sub" && (listed.status !== data.status || data.reason === "claude_refresh"))
          void loadAccounts().catch(report)
        break
      }
      case "claudeAgent.pool":
        poolEvents++
        setState("claudeAgentPool", reconcile(event.data.pool))
        break
      case "alert": {
        const data = event.data
        setState(
          "alerts",
          produce((alerts) => {
            alerts.unshift({
              id: data.eventId,
              at: event.created,
              code: data.code,
              severity: data.severity,
              message: data.message,
              sessionID: data.sessionID,
              accountID: data.accountID,
            })
            if (alerts.length > ALERT_LIMIT) alerts.length = ALERT_LIMIT
          }),
        )
        break
      }
    }
    emit(event)
  }

  /**
   * 02 §4.7.4: the session reached its "compact earlier" threshold. A client with the `prompt` scope checks there
   * is no staged revert and admits the compaction under the given id. The server admits one id once, so every open
   * client may try; a 409 is expected and ignored.
   */
  async function executeCompactionDue(data: OwnEventData<"compaction.due">) {
    if (!input.rpc.can("prompt")) return
    try {
      const session = await input.client().session.get({ sessionID: data.sessionID })
      if (session.revert) return
      await input.client().session.compact({ sessionID: data.sessionID, id: data.inputID })
      setState("compactionRequested", data.sessionID, {
        inputID: data.inputID,
        triggerTokens: data.triggerTokens,
        at: Date.now(),
      })
    } catch (error) {
      if (!isConflict(error)) report(error)
    }
  }

  // A new session's chip asks for its binding as soon as the composer navigates, which is before the server has the
  // session (the create is optimistic); that early read says `model: null`. Read it again once the server announces
  // the session. Over an SSH tunnel the early read is the usual case (04 §12.1). The preset and speed views read at
  // the same moment are just as early (`none: "session"`, no offers: the 속도 control stayed off), so they are read
  // again too.
  const stopCreated = input.bus.on("session.created", (event) => {
    const sessionID = event.data.sessionID
    if (visible.has(sessionID) || state.binding[sessionID]) void loadBindings([sessionID]).catch(report)
    if (presetViews.has(sessionID)) void loadPreset(sessionID).catch(report)
    if (speedViews.has(sessionID)) void loadSpeed(sessionID).catch(report)
  })

  const unlisten = input.bus.listen((raw) => {
    if (raw.type === "server.connected") {
      // A new connection may be a new service: its plugins start loading again.
      if (starting?.timer !== undefined) clearTimeout(starting.timer)
      starting = undefined
      void resync()
      return
    }
    // A plugin finished loading somewhere: if own.accounts was not there yet, it may be now.
    if (raw.type === "plugin.updated") {
      if (starting !== undefined || (state.status === "unmanaged" && state.reason === "rpc.unavailable")) void resync()
      return
    }
    const event = ownEvent(raw)
    if (!event) return
    const id = event.data.eventId
    if (seen.has(id)) return
    seen.add(id)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!)
    apply(event)
  })

  return {
    state,
    resync,
    rpc: input.rpc,
    /** Account of a providerID (chips, turn footer); `undefined` for built-in or unknown providers. */
    accountFor(providerID: string): Account.View | undefined {
      const id = state.accountByProvider[providerID]
      return id ? state.accounts[id] : undefined
    },
    /**
     * The account a session runs on for `providerID`: its binding's account when that is one of this provider's (02
     * §8.7: several Claude accounts share `anthropic`, so the provider alone names only the first), else
     * {@link accountFor}.
     */
    accountOfSession(sessionID: string | undefined, providerID: string): Account.View | undefined {
      const bound = sessionID === undefined ? undefined : state.binding[sessionID]?.accountID
      const owner = bound ? state.accounts[bound] : undefined
      if (owner?.providerID === providerID) return owner
      const id = state.accountByProvider[providerID]
      return id ? state.accounts[id] : undefined
    },
    /** `policy.defaults.byKind` from a `policy.set` answer (07 §2.2 rule 3); `policy.get` has no change event. */
    setDefaultAccounts,
    /** Marks sessions as visible (chips); returns a release. Bindings load now and on every resync. */
    watchVisible(sessionIDs: readonly string[]) {
      const fresh = sessionIDs.filter((id) => retain(visible, id))
      if (fresh.length && state.status === "ready") void loadBindings(fresh).catch(report)
      return () => sessionIDs.forEach((id) => release(visible, id))
    },
    /** Marks a session as open (cache state, switch state, read once its directory is known); returns a release. */
    watchOpen(sessionID: string) {
      if (retain(open, sessionID) && state.status === "ready") void loadSession(sessionID).catch(report)
      return () => release(open, sessionID)
    },
    /**
     * Marks a root session's preset view as on screen (`sessionPreset`): read now (once the session's directory is
     * known) and on every resync, again on `session.preset.changed`, `binding.changed` and `presets.changed`. Returns a
     * release; the last one drops it.
     */
    watchPreset(sessionID: string) {
      if (retain(presetViews, sessionID) && state.status === "ready") void loadPreset(sessionID).catch(report)
      return () => {
        release(presetViews, sessionID)
        if (!presetViews.has(sessionID))
          setState(
            "sessionPreset",
            produce((views) => {
              delete views[sessionID]
            }),
          )
      }
    },
    /**
     * Marks a root session's speed view as on screen (`sessionSpeed`, 02 §4.8): read now (once the session's directory
     * is known) and on every resync, again on `session.speed.changed` and `binding.changed`. Returns a release; the last
     * one drops it.
     */
    watchSpeed(sessionID: string) {
      // Untracked: a caller's effect must not rerun (release, retain, read again) when the status changes.
      if (retain(speedViews, sessionID) && untrack(() => state.status) === "ready")
        void loadSpeed(sessionID).catch(report)
      return () => {
        release(speedViews, sessionID)
        if (!speedViews.has(sessionID))
          setState(
            "sessionSpeed",
            produce((views) => {
              delete views[sessionID]
            }),
          )
      }
    },
    /** A `session.speed.set` answer's view, applied before its `session.speed.changed` arrives. */
    setSpeed(view: Speed.View) {
      if (speedViews.has(view.sessionID)) setState("sessionSpeed", view.sessionID, reconcile(view))
    },
    /** Reads a watched root's speed view now, e.g. once its create settled (the early read did not know it). */
    refreshSpeed(sessionID: string) {
      if (speedViews.has(sessionID)) return loadSpeed(sessionID)
      return Promise.resolve()
    },
    /**
     * Marks a main's offers as on screen (`speedOffers[speedOffersKey(...)]`, 2026-10-10): the new-conversation
     * composer and the switcher's speed row. Read now and on every resync, again on `accounts.changed`,
     * `plugin.status` and `session.speed.changed`. Returns a release; the last one drops it.
     */
    watchSpeedOffers(providerID: string, modelID: string) {
      const key = speedOffersKey(providerID, modelID)
      // Untracked, as in `watchSpeed`: the resync reads the watched mains once it is ready.
      if (retain(offerViews, key) && untrack(() => state.status) === "ready") void loadOffers(key).catch(report)
      return () => {
        release(offerViews, key)
        if (!offerViews.has(key))
          setState(
            "speedOffers",
            produce((views) => {
              delete views[key]
            }),
          )
      }
    },
    /**
     * Reads `presets.list` now, e.g. right after a save, before the service's `presets.changed` arrives. On an SSH
     * host's store it reads the host's list (its mirror of this PC's presets), from now on also on every resync.
     */
    refreshPresets() {
      if (!input.registry) return loadDefaults(false)
      hostPresets = true
      return loadHostPresets()
    },
    /** Own events after de-duplication by `eventId`; `ledger.step` arrives coalesced (250 ms). */
    on<E extends OwnEventName>(name: E, listener: (event: OwnEvent<E>) => void) {
      const set = listeners.get(name) ?? new Set<Listener>()
      listeners.set(name, set)
      // SAFETY: `emit` only calls listeners registered under the event's own name.
      const erased = listener as Listener
      set.add(erased)
      return () => set.delete(erased)
    },
    /** A reset credit answer (`quota.resetCredits.*`, 02 §7.1.1) before its `quota.updated` arrives. */
    setResetCredits,
    /** A redeem whose read after it reported no count: the count is unknown until the next read (as Codex). */
    forgetResetCredits,
    /**
     * Reads the pool now (the accounts page's pool line), guarded as the resync's read: none on an SSH host's store or
     * without a Claude Agent account, and a `claudeAgent.pool` event or a setting's answer that arrives while it is out
     * wins (CAG-47).
     */
    readClaudeAgentPool: loadPool,
    /**
     * A `claudeAgent.pool.set` answer's pool, shown at once rather than with the next `claudeAgent.pool` event; a read
     * still out is older than it.
     */
    setClaudeAgentPool(pool: ClaudeAgent.Pool) {
      poolEvents++
      setState("claudeAgentPool", reconcile(pool))
    },
    /** The windows a redeem read again (02 §7.1.1), shown at once rather than with the next `quota.updated`. */
    setWindows(accountID: string, windows: readonly Limit.Window[]) {
      setState("quota", accountID, reconcile(kept(windows), { key: "id" }))
    },
    /** Delivers coalesced updates now (tests, teardown). */
    flush() {
      quotaUpdates.flush()
      cacheUpdates.flush()
      ledgerSteps.flush()
    },
    dispose() {
      if (starting?.timer !== undefined) clearTimeout(starting.timer)
      unlisten()
      stopCreated()
      quotaUpdates.dispose()
      cacheUpdates.dispose()
      ledgerSteps.dispose()
      listeners.clear()
    },
  }
}

export type OwnStore = ReturnType<typeof createOwnStore>

/** How long `rpc.unavailable` from own.accounts counts as a service still loading its plugins (upstream #63814). */
const STARTING_MS = 120_000
const STARTING_STEP_MS = 250
const STARTING_MAX_STEP_MS = 5_000

const KEY_SEPARATOR = "\u0000"

/** The `speedOffers` key of a main (account provider and model). */
export function speedOffersKey(providerID: string, modelID: string) {
  return `${providerID}${KEY_SEPARATOR}${modelID}`
}

function retain(map: Map<string, number>, id: string) {
  const count = map.get(id) ?? 0
  map.set(id, count + 1)
  return count === 0
}

function release(map: Map<string, number>, id: string) {
  const count = (map.get(id) ?? 0) - 1
  if (count > 0) map.set(id, count)
  else map.delete(id)
}

/** The value of a settled call; a failure is rethrown into the caller's error mapping. */
function settled<T>(result: PromiseSettledResult<T>) {
  if (result.status === "rejected") throw result.reason
  return result.value
}

function chunks<T>(items: readonly T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

/** `POST /compact` answers 409 `ConflictError` when another client already admitted the same id. */
function isConflict(error: unknown) {
  return error instanceof Error && error.name === "ConflictError"
}

/**
 * Whether the page is being left (`pagehide`, reset when the back-forward cache shows it again): the browser then
 * cancels its pending requests, which fail as "Failed to fetch" and are no failure to report.
 */
let leaving = false
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void (leaving = true))
  window.addEventListener("pageshow", () => void (leaving = false))
}

function report(error: unknown) {
  if (leaving) return
  console.error("[own-web] own.accounts request failed", error)
}
