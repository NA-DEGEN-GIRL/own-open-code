export * as PresetStore from "./store.js"

import { Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import { Account, ClaudeAgent, CodexModels, Preset, type Broker, type Kind } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { RemoteMirror } from "../remote/mirror.js"
import type { RpcTypes } from "../rpc/types.js"
import { CodexMeta } from "../slots/codex-meta.js"
import type { Variant } from "../switching/variant.js"
import { PresetCards } from "./cards.js"
import { PresetRepair } from "./repair.js"
import { PresetResolve } from "./resolve.js"

/**
 * Owner: PRESETS (07 §8.1). `OWN_HOME\presets.json` through the runtime presets store (atomic writes under the
 * registry lock, fields this build does not know kept): each provider group's presets, ★, lighter-pair table,
 * new-session default model and repair history, and the global start-preset rule, recent presets and ultra level.
 * - Loading checks every stored preset like a save (R4 with `main: null`, 07 §5.4): a pinned target of a same-company
 *   subscription (a hand edit) is dropped from the loaded preset, never from the file, and `preset_entry_dropped` is
 *   raised once. Everything that reads presets (★, the gate, `presets.list`) reads the loaded view.
 * - A group's `auto` default model is decided once, from the group's first live account in registry order, and never
 *   changes by itself afterwards (U3); a `user` value is never overwritten. Only the leader writes an `auto` value,
 *   when provider reloads settle; anything that needs a value earlier decides it in memory, and that is the value the
 *   leader writes; reads never write. The ChatGPT group also reads the Codex CLI's files on this PC (`CodexMeta`).
 * - The presence check (07 §4.3 (가), `Preset.presence`) marks what the catalog took away: a preset whose pinned model
 *   is gone is `needs_repair`, a gone lighter pair `missing` (`없어짐`, never decided again) and a gone default model
 *   `missing` (kept, `user` and `auto` alike; new sessions start on the group rule). Each gone use carries what its
 *   repair notice offers (`[고치기]`): a successor for a pin, the pair rule's result, the model new sessions now start
 *   on. Nothing is rewritten by it; `presets.set{repairOf}` records the user's fix in the group's history (07 §7.2).
 * - A remote service reads only what the registry mirror wrote (T3, 07 §8.1 원격): `presets.json` while the stored
 *   mirror names its revision (`MirrorMeta.presetsRevision`), else nothing but each group's `평소대로` (a view of an
 *   older local build, no view yet). It loads the file like this PC does, so R4 is judged again there; the mirror
 *   carries no identities, so one ChatGPT login's `codex` and `siwc` accounts count as two subscriptions (fail
 *   closed). It never writes the file (what it decides stays in memory), lists no repair notices (the local PC owns
 *   them) and takes the money state of paid accounts from the mirror ({@link Api.budgets}).
 */
export interface Api extends Module.Lifecycle {
  /**
   * The model and effort a new session on this account starts with (07 §2.2 rule 3): its group's default when the
   * account has that model, else the group rule over the account's own models. `undefined` when the account has no
   * model a session can start on.
   */
  defaultFor(target: Target): Promise<Variant.Ref | undefined>
  /** The group's default as this process knows it now (written, or decided and not written yet); never decides. */
  known(group: Preset.Group): Preset.DefaultModel | undefined
  /**
   * The group's ★ preset, the single source of ★ (07 §5.1); `undefined` = its `평소대로`, also when the stored ★ names
   * no preset of the group. A remote service has the mirrored one (07 §8.1 원격).
   */
  star(group: Preset.Group): Preset.ID | undefined
  /** A preset of the group by id as loaded: its `평소대로`, or a stored preset; `undefined` for any other id. */
  preset(id: Preset.ID, group: Preset.Group): Preset.Info | undefined
  /** The group's stored presets as loaded, in file order (`평소대로` not included). */
  presetsOf(group: Preset.Group): ReadonlyArray<Preset.Info>
  /** The group's lighter-pair table, keyed by main model id (07 §4.2). */
  lighter(group: Preset.Group): Readonly<Record<string, Preset.Lighter>>
  /**
   * Stores a decided `auto` lighter pair unless the group already has one for that main model (the first stored pair
   * stands). Answers the stored pair; `undefined` when `presets.json` cannot be written.
   */
  recordLighter(group: Preset.Group, mainModelID: string, pair: Preset.Lighter): Promise<Preset.Lighter | undefined>
  /** The global settings with their defaults applied (07 §8.1): start preset, recent presets, ultra level. */
  settings(): Settings
  /** Live accounts a new session can start on, in registry order; the Claude slot last when acknowledged. */
  newSessionTargets(): ReadonlyArray<Target>
  /**
   * The repair notices of every group now (07 §4.3): one per gone model, with each place that uses it and what its
   * notice offers. Reads only. None on a remote service.
   */
  repairs(): Promise<ReadonlyArray<Preset.Repair>>
  /**
   * A remote service's money state of the paid accounts, as the local PC mirrored it (`MirrorView.presetsBudget`, 07
   * §5.4 step 4): empty until a view carrying it arrives in this process. `undefined` on this PC, where the ledger
   * decides (`PresetBudget.exhausted`).
   */
  budgets(): Readonly<Record<string, Broker.PresetBudget>> | undefined
  list: RpcTypes.Handler<"presets.list">
  set: RpcTypes.Handler<"presets.set">
  remove: RpcTypes.Handler<"presets.remove">
  defaultsSet: RpcTypes.Handler<"presets.defaults.set">
}

/** An account a new session can start on: an own slot, or the Claude slot (`anthropic`). */
export interface Target {
  readonly kind: Kind.Any
  readonly providerID: string
}

export interface Settings {
  readonly newSession: Preset.NewSession
  /** Most recent first; only presets that exist. */
  readonly recent: ReadonlyArray<Preset.ID>
  readonly ultraCaps: Preset.UltraCaps
}

/** Provider reloads come in bursts (every Location, every registry change); groups are filled once they settle. */
export const SETTLE_MS = 2_000

/** How many presets `recent` keeps (07 §8.1). */
export const RECENT_MAX = 10

/**
 * What a loaded preset leaves out (07 §5.4 "presets.json 로드", §8.1): a pinned target that breaks R4 (`r4`, with its
 * account), or a model pool entry a hand edit broke (`invalid`).
 */
export interface Dropped {
  readonly presetID: Preset.ID
  readonly name: string
  readonly place: Preset.Spot
  readonly accountID?: Account.ID
  readonly reason: "r4" | "invalid"
}

/** One group's presence check: its `presets.list` row and every use of a gone model, suggestions filled in. */
interface Checked {
  readonly view: Preset.GroupView
  readonly gone: ReadonlyArray<Preset.GoneUse>
}

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("presets")
  const lookup = PresetResolve.lookupOf(peers)
  const state = {
    /** `presets.json` as read or written. */
    file: Preset.empty(),
    /** The file as this build uses it: R4 breaches dropped, presets filed under another group left out. */
    view: Preset.empty(),
    /** Preset ids last announced; a reload that loses one sends it in `presets.changed{removed}`. */
    ids: new Set<Preset.ID>(),
    /** Dropped entries already alerted (once per entry). */
    dropped: new Set<string>(),
    /** `auto` values decided in this process that `presets.json` does not have (not written yet, or unwritable). */
    decided: new Map<Preset.Group, Preset.DefaultModel>(),
    /** Groups whose failed write was logged; an unwritable file is logged once per group, not on every settle. */
    unwritable: new Set<Preset.Group>(),
    stops: [] as Array<() => void>,
    cancel: undefined as (() => void) | undefined,
  }

  /** Takes a file as current: loads it (07 §5.4) and alerts entries dropped for the first time. */
  const adopt = (file: Preset.File) => {
    const loaded = load(file, lookup)
    state.file = file
    state.view = loaded.file
    loaded.dropped
      .filter((entry) => !state.dropped.has(droppedKey(entry)))
      .forEach((entry) => {
        state.dropped.add(droppedKey(entry))
        log.warn("preset_entry_dropped", {
          presetID: entry.presetID,
          place: entry.place,
          accountID: entry.accountID,
          reason: entry.reason,
        })
        const key = Preset.poolKeyOf(entry.place)
        const what = key === undefined ? `${entry.place} 대상은` : `모델 묶음 항목 ${key}은(는)`
        peers().telemetry.alert({
          code: "preset_entry_dropped",
          severity: "warning",
          ...(entry.accountID === undefined ? {} : { accountID: entry.accountID }),
          subject: `${entry.presetID}:${entry.place}`,
          message:
            entry.reason === "r4"
              ? `프리셋 '${entry.name}'의 ${what} 같은 회사의 다른 구독 계정이라 빼고 씁니다. presets.json은 그대로입니다.`
              : `프리셋 '${entry.name}'의 ${what} 이름·메모·개수가 맞지 않거나 다른 항목과 겹쳐서 빼고 씁니다. presets.json은 그대로입니다.`,
        })
      })
  }

  /** Live accounts in registry order, then the Claude slot when its models are enabled (02 §8.4). */
  const targets = (): ReadonlyArray<Target> => {
    const own = peers()
      .slots.snapshot()
      .accounts.filter((account) => account.status !== "retired")
      .map((account) => ({ kind: account.kind, providerID: account.providerID }))
    const claude = peers().plugins.claudeSlot()
    // The Claude Agent route's account is a group of its own (02 §8.10).
    const agent = peers().claudeAgent.account()
      ? [{ kind: "claude-agent" as const, providerID: ClaudeAgent.PROVIDER_ID }]
      : []
    return claude.detected && claude.verified
      ? [...own, { kind: "claude-sub", providerID: Provider.ID.anthropic }, ...agent]
      : [...own, ...agent]
  }

  /** What an account offers: the slot's models as they register (gone ones `deprecated`), the Claude slot's catalog. */
  const entriesOf = async (target: Target): Promise<ReadonlyArray<Preset.Entry>> => {
    const slots = peers().slots
    if (target.kind === "claude-agent") {
      // Claude Code's own model list, as the provider registers it (core's live list).
      const listed = await Promise.resolve()
        .then(() => deps.ctx.model.list())
        .catch(() => undefined)
      return (listed?.data ?? []).filter((model) => model.providerID === target.providerID)
    }
    return target.kind === "claude-sub" ? slots.catalog(Provider.ID.anthropic) : slots.models(target.providerID)
  }

  /**
   * The models a new session on this account may start on: the slot as it registers now, priced like 07 §3.4 (a
   * ChatGPT OAuth slot, `codex` or `siwc`, from the `openai` catalog because the slot is free); the Claude slot's
   * `anthropic` catalog. The prices come first: reading the catalog forces the first fold, so the slot's models carry
   * their live fields.
   */
  const candidates = async (target: Target) => {
    const price = await PresetResolve.prices(peers().slots, target.kind)
    return Preset.candidates(await entriesOf(target), price)
  }

  /**
   * The `auto` rule for these models; only the ChatGPT group reads Codex (never on a remote host): the Codex CLI's
   * config on this PC and the Codex metadata snapshot (07 §2.2 ①②, 07 §4.5).
   */
  const decide = async (group: Preset.Group, models: ReadonlyArray<Preset.Candidate>) =>
    Preset.defaultModel(group, models, group === "codex" && !deps.remote ? await CodexMeta.hints(deps) : {})

  const known = (group: Preset.Group) => state.file.groups[group]?.defaultModel ?? state.decided.get(group)

  /** The group's default; the first time, its `auto` value is decided in memory from its first live account. */
  const groupDefault = async (group: Preset.Group) => {
    const existing = known(group)
    if (existing) return existing
    const first = targets().find((target) => target.kind === group)
    const decided = first ? await decide(group, await candidates(first)) : undefined
    if (!decided) return undefined
    // A concurrent call may have decided (or another instance written) meanwhile; the first value stands.
    const value = known(group) ?? { ...decided, source: "auto" as const }
    if (!state.file.groups[group]?.defaultModel) state.decided.set(group, value)
    return value
  }

  /**
   * Changes `presets.json` under the registry lock and announces it (`store.changed{store:"presets"}`). A remote
   * service only changes its memory.
   */
  const mutate = async (change: (current: Preset.File) => Preset.File | undefined) => {
    if (deps.remote) {
      adopt(change(state.file) ?? state.file)
      return state.file
    }
    const outcome = { changed: false }
    const next = await deps.runtime.presets.update((current) => {
      const result = change(current)
      outcome.changed = result !== undefined && result !== current
      return result
    })
    adopt(next)
    if (outcome.changed) deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "local" })
    return state.file
  }

  /** {@link mutate} for an RPC: `false` (logged) when `presets.json` cannot be read or written. */
  const tryMutate = (what: string, change: (current: Preset.File) => Preset.File | undefined) =>
    mutate(change).then(
      () => true,
      (error: unknown) => {
        log.error("presets_write_failed", { what, error })
        return false
      },
    )

  /**
   * Writes a group's `auto` value unless the file has one (another instance may have written first; its value
   * stands). An unusable file is never overwritten (Store): the value then stays in memory, so `presets.list` and new
   * sessions keep agreeing.
   */
  const write = async (group: Preset.Group, value: Preset.DefaultModel) => {
    const written = await mutate((current) =>
      current.groups[group]?.defaultModel
        ? undefined
        : withGroup(current, group, (entry) => ({ ...entry, defaultModel: value })),
    ).catch((error: unknown) => {
      if (!state.unwritable.has(group)) log.error("presets_write_failed", { group, error })
      state.unwritable.add(group)
      return undefined
    })
    if (written?.groups[group]?.defaultModel) state.decided.delete(group)
  }

  /** The leader writes the `auto` value of every group with a live account (the T0 migration, a first account). */
  const settle = async () => {
    const groups = [...new Set(targets().map((target) => target.kind))]
    await Promise.all(
      groups.map(async (group) => {
        const value = await groupDefault(group)
        if (value && !state.file.groups[group]?.defaultModel) await write(group, value)
      }),
    )
  }

  const presetsOf = (group: Preset.Group) =>
    (state.view.groups[group]?.presets ?? []).filter((preset) => preset.group === group)

  const star = (group: Preset.Group) => {
    const stored = state.view.groups[group]?.star
    return stored !== undefined && presetsOf(group).some((preset) => preset.id === stored) ? stored : undefined
  }

  const lighter = (group: Preset.Group) => state.view.groups[group]?.lighter ?? {}

  const settings = (): Settings => ({
    newSession: state.view.newSession ?? "star",
    recent: (state.view.recent ?? []).filter(
      (id) => Preset.isBuiltin(id) || groupsOf(state.view).some((group) => presetsOf(group).some((p) => p.id === id)),
    ),
    ultraCaps: state.view.ultraCaps ?? Preset.ULTRA_LEVEL,
  })

  /**
   * One group's presence check (07 §4.3 (가), `Preset.presence`) over what the group's live accounts and the pinned
   * accounts offer now, and its `presets.list` row: the stored presets with their status (★ first, `평소대로` always),
   * the lighter pairs and the default model marked `missing` where gone, the repair history (07 §7.2) and the Codex
   * retirement time of each model the group names (shown dimmed, never a notice, U3). Each gone use carries what its
   * notice offers: the successor of a pinned model on its account (`Preset.successor`, with the account's Codex
   * metadata), of a main-account model pool entry among the group's models (with the group's Codex metadata), the pair
   * rule's result (`Preset.lighterPick`), the model a new session now starts on (the group rule). Reads only: nothing
   * is decided again or written.
   */
  const check = async (group: Preset.Group): Promise<Checked> => {
    const resolver = peers().presets.resolver
    const value = await groupDefault(group)
    const stored = [Preset.builtin(group), ...presetsOf(group)]
    const pins = stored.flatMap((preset) => pinnedOf(preset.workers))
    const offers = new Map<string, PresetResolve.Inventory | undefined>(
      await Promise.all(
        [...new Set(pins.map((pin) => pin.account))].map(
          async (account) => [account, await resolver.inventory(account)] as const,
        ),
      ),
    )
    const first = targets().find((target) => target.kind === group)
    const choices = first ? await candidates(first) : []
    const models = await groupEntries(group)
    const table = lighter(group)
    const presence = Preset.presence(
      group,
      { presets: stored, lighter: table, ...(value ? { defaultModel: value } : {}) },
      { offers: (account) => offers.get(account)?.models, group: models },
    )
    // Codex metadata is the `codex` kind's only (07 §4.5): the group's own names, and pins on a codex account.
    const codex =
      group === "codex" || [...offers.values()].some((offer) => offer?.kind === "codex")
        ? await CodexMeta.snapshot(deps)
        : undefined
    const offered = async (entry: Preset.GoneUse) => {
      const use = entry.use
      if (use.kind === "lighter") return Preset.lighterPick(group, use.main, choices)?.model
      if (use.kind === "default") return (await decide(group, choices))?.id
      // A main-account model pool entry: whichever account of the group is the main, so the group's models.
      if (use.account === undefined)
        return Preset.successor(
          await PresetRepair.gone({ models, ...(Preset.isLocal(group) ? {} : { kind: group }) }, entry.model),
          choices,
          group === "codex" ? CodexModels.find(codex, entry.model) : undefined,
        )
      const offer = offers.get(use.account)
      if (!offer) return undefined
      return Preset.successor(
        await PresetRepair.gone(offer, entry.model),
        Preset.candidates(offer.models, offer.price),
        offer.kind === "codex" ? CodexModels.find(codex, entry.model) : undefined,
      )
    }
    // Repair notices are the local PC's (07 §4.3, T2.17): a remote service shows statuses only.
    const gone = deps.remote
      ? []
      : await Promise.all(
          presence.gone.map(async (entry): Promise<Preset.GoneUse> => {
            const suggestion = await offered(entry)
            return { model: entry.model, use: suggestion === undefined ? entry.use : { ...entry.use, suggestion } }
          }),
        )
    const named = [
      ...pins.flatMap((pin) => (offers.get(pin.account)?.kind === "codex" ? [pin.model] : [])),
      ...(group === "codex"
        ? [
            ...Object.entries(table).flatMap(([main, row]) => [main, row.model]),
            ...(value ? [value.id] : []),
            ...stored.flatMap((preset) =>
              (preset.workers.pool ?? []).flatMap((entry) => (entry.account === undefined ? [entry.model] : [])),
            ),
          ]
        : []),
    ]
    const retirements = Object.fromEntries(
      named.flatMap((id) => {
        const row = CodexModels.find(codex, id)
        const at = row && CodexModels.upgrade(row)?.retirementAt
        return at === undefined ? [] : [[id, at] as const]
      }),
    )
    const starred = star(group) ?? Preset.builtinID(group)
    const label = value && Preset.labelOf(value)
    const history = state.view.groups[group]?.history ?? []
    const poolHistory = state.view.groups[group]?.poolHistory ?? []
    return {
      view: {
        group,
        defaultModel: presence.defaultModel ?? null,
        presets: [
          ...presence.presets.filter((preset) => preset.id === starred),
          ...presence.presets.filter((preset) => preset.id !== starred),
        ],
        star: starred,
        lighter: presence.lighter,
        status: presence.status,
        ...(label ? { label } : {}),
        ...(history.length > 0 ? { history } : {}),
        ...(Object.keys(retirements).length > 0 ? { retirements } : {}),
        ...(poolHistory.length > 0 ? { poolHistory } : {}),
      },
      gone,
    }
  }

  /**
   * What a pool entry runs on (07 §3.3 `PoolRuns`), for its key's tail: the group's billing for a main-account entry
   * (`local` for a local group), else its account's. `undefined` for an account the registry does not know.
   */
  const runsOf = (entry: Preset.PoolEntry, group: Preset.Group): Preset.PoolRuns | undefined => {
    const account = entry.account
    if (account === undefined) {
      if (Preset.isLocal(group)) return "local"
      const billing =
        group === "claude-sub" || group === "claude-agent"
          ? "subscription"
          : peers()
              .slots.snapshot()
              .accounts.find((item) => item.kind === group)?.billing
      return billing === undefined ? undefined : billing === "subscription" ? "main" : "main-paid"
    }
    if (Preset.isLocal(account)) return "local"
    const billing = lookup(account)?.billing
    if (billing === "local") return "local"
    return billing === undefined ? undefined : billing === "subscription" ? "subscription" : "paid"
  }

  /**
   * The pool with frozen cards (07 §3.3 D2): an entry the stored pool already has under the same key and target keeps
   * its card, unless `refresh` (`카드 새로 고치기`); every other entry gets a card from the catalog now. A card a client
   * sent is never kept. A model nothing offers now keeps the stored card, else gets one with its time only.
   */
  const cardsOf = async (
    pool: ReadonlyArray<Preset.PoolEntry>,
    group: Preset.Group,
    before: ReadonlyArray<Preset.PoolEntry> | undefined,
    refresh: boolean,
  ): Promise<ReadonlyArray<Preset.PoolEntry>> => {
    const resolver = peers().presets.resolver
    const now = deps.clock.now()
    const models = pool.some((entry) => entry.account === undefined) ? await groupEntries(group) : []
    const codex = { snapshot: undefined as Promise<CodexModels.Snapshot | undefined> | undefined }
    const inventories: { list?: ReturnType<typeof resolver.inventories> } = {}
    return Promise.all(
      pool.map(async (entry) => {
        const { card: _sent, ...rest } = entry
        const kept = before?.find((old) => old.key === entry.key && sameTarget(old, entry))?.card
        if (kept && !refresh) return { ...rest, card: kept }
        const account = entry.account ?? group
        const offer = entry.account === undefined ? undefined : await resolver.inventory(entry.account)
        const found = (entry.account === undefined ? models : (offer?.models ?? [])).find(
          (model) => model.id === entry.model,
        )
        if (!found) return { ...rest, card: kept ?? { at: now } }
        // A local model behind an OpenAI-compatible account (PF 2026-11-03) gets a local card too.
        const behind =
          entry.account === undefined
            ? (await (inventories.list ??= resolver.inventories())).find(
                (item) =>
                  item.local === true && item.kind === group && item.models.some((model) => model.id === entry.model),
              )
            : offer?.local === true
              ? offer
              : undefined
        const local = Preset.isLocal(account) || behind !== undefined
        const kind = entry.account === undefined ? (Preset.isLocal(group) ? undefined : group) : offer?.kind
        const providerID = behind?.providerID ?? account.slice("local:".length)
        codex.snapshot ??= kind === "codex" ? CodexMeta.snapshot(deps) : undefined
        const window = local ? resolver.localWindow(providerID, entry.model) : undefined
        const card = PresetCards.of(
          found,
          kind,
          kind === "codex" ? await codex.snapshot : undefined,
          local
            ? {
                verified: resolver.localVerified(providerID, entry.model),
                ...(window === undefined ? {} : { runtime: window }),
              }
            : undefined,
          now,
        )
        return { ...rest, card }
      }),
    )
  }

  /** The models a group's live accounts offer now (a local group's provider): what its main-account entries run on. */
  const groupEntries = async (group: Preset.Group): Promise<ReadonlyArray<Preset.Entry>> => {
    if (Preset.isLocal(group)) return (await peers().presets.resolver.inventory(group))?.models ?? []
    return (
      await Promise.all(
        targets()
          .filter((target) => target.kind === group)
          .map(entriesOf),
      )
    ).flat()
  }

  /** {@link check} of every group with a live account or stored in `presets.json` (or of `only`), in list order. */
  const checkAll = (only?: Preset.Group) => {
    const live = targets().map((target) => target.kind)
    const stored = groupsOf(state.view).toSorted()
    return Promise.all(
      [...new Set([...live, ...stored])].filter((group) => only === undefined || group === only).map(check),
    )
  }

  /**
   * The first place with a pinned target that is unknown or cannot call tools (07 §3.4, `preset_target_unavailable`):
   * every target counts, used by the mode or not; `single` mode needs its target. A model pool entry on the main
   * account needs one of the group's live accounts to offer its model. A pin (or pool entry) the stored preset already
   * has in that place is not judged again: its model gone since is a repair notice (07 §4.3), so a save that fixes one
   * place (`repairOf`), or changes anything else, is never refused because of another gone pin.
   */
  const unavailable = async (
    workers: Preset.Workers,
    group: Preset.Group,
    before?: Preset.Workers,
  ): Promise<Preset.Spot | undefined> => {
    if (Preset.modeOf(workers) === "single" && !workers.single) return "single"
    const resolver = peers().presets.resolver
    const kept = before ? Preset.placesOf(before) : []
    const places = Preset.placesOf(workers)
    const onMain = (entry: Preset.PlaceOf) => (entry.pool?.account === undefined ? entry.pool : undefined)
    const models = places.some((entry) => onMain(entry)) ? await groupEntries(group) : []
    const usable = await Promise.all(
      places.map(async (entry) => {
        const earlier = kept.filter((old) => old.spot === entry.spot)
        const main = onMain(entry)
        if (main)
          return (
            earlier.some((old) => old.pool?.account === undefined && old.pool?.model === main.model) ||
            models.some((model) => model.id === main.model && PresetResolve.callable(model))
          )
        const pins = entry.targets.flatMap((target) => ("pin" in target ? [target.pin] : []))
        const checked = await Promise.all(
          pins.map(async (pin) => {
            const had = earlier.some((old) =>
              old.targets.some(
                (item) => "pin" in item && item.pin.account === pin.account && item.pin.model === pin.model,
              ),
            )
            if (had) return true
            const offer = await resolver.inventory(pin.account)
            return offer?.models.some((model) => model.id === pin.model && PresetResolve.callable(model)) === true
          }),
        )
        return checked.every(Boolean)
      }),
    )
    return places.find((_entry, index) => !usable[index])?.spot
  }

  /**
   * Save warnings (07 §3.4, §6.2 #8): a used target that costs money, a local target whose window is unverified (a
   * local group's main-account pool entry too). A metered group's main-account entries cost what the main costs and
   * are not warned about.
   */
  const warningsOf = (workers: Preset.Workers, group: Preset.Group): Preset.Warning[] => {
    const resolver = peers().presets.resolver
    return usedPlacesOf(workers).flatMap((entry) => {
      const local = entry.pool?.account === undefined && entry.pool && Preset.isLocal(group) ? entry.pool : undefined
      const pins = [
        ...entry.targets.flatMap((target) => ("pin" in target ? [target.pin] : [])),
        ...(local ? [{ account: group, model: local.model }] : []),
      ]
      const paid = pins.some((pin) => {
        if (Preset.isLocal(pin.account)) return false
        const billing = lookup(Account.ID.make(pin.account))?.billing
        return billing === "metered" || billing === "prepaid"
      })
      const unverified = pins.some(
        (pin) => Preset.isLocal(pin.account) && !resolver.localVerified(pin.account.slice("local:".length), pin.model),
      )
      return [
        ...(paid ? [{ code: "paid" as const, place: entry.spot }] : []),
        ...(unverified ? [{ code: "local-unverified" as const, place: entry.spot }] : []),
      ]
    })
  }

  /**
   * A remote service's presets (07 §8.1 원격): `presets.json` while the stored mirror names its revision, else none (a
   * view of an older local build, no view yet, a file the mirror did not write). The mirror writes the meta before it
   * announces a presets change. A file that cannot be read keeps `kept` (what was loaded before, as this PC's store
   * keeps its last file), so a passing read error never resets a binding.
   */
  const mirrored = async (kept: Preset.File) => {
    const registry = deps.runtime.registry.cached() ?? (await deps.runtime.registry.read().catch(() => undefined))
    if (RemoteMirror.metaOf(registry)?.presetsRevision === undefined) return Preset.empty()
    return deps.runtime.presets.read().catch((error: unknown) => {
      log.error("presets_unreadable", { error })
      return kept
    })
  }

  const reload = async () => {
    // This PC takes the file the runtime cached for the change at once, before the next listener runs.
    adopt(
      deps.remote
        ? await mirrored(state.file)
        : (deps.runtime.presets.cached() ??
            (await deps.runtime.presets.read().catch((error: unknown) => {
              log.error("presets_unreadable", { error })
              return state.file
            }))),
    )
    for (const group of state.decided.keys()) if (state.file.groups[group]?.defaultModel) state.decided.delete(group)
    const ids = idsOf(state.view)
    const removed = [...state.ids].filter((id) => !ids.has(id))
    state.ids = ids
    await deps.emitter.global("presets.changed", removed.length ? { removed } : {})
  }

  return {
    start: async () => {
      adopt(
        deps.remote
          ? await mirrored(Preset.empty())
          : await deps.runtime.presets.read().catch((error: unknown) => {
              log.error("presets_unreadable", { error })
              return Preset.empty()
            }),
      )
      state.ids = idsOf(state.view)
      state.stops.push(
        deps.runtime.broadcast.on("store.changed", (payload) => {
          if (payload.store === "presets")
            void reload().catch((error: unknown) => log.error("presets_reload_failed", { error }))
        }),
      )
    },
    stop: async () => {
      state.cancel?.()
      state.cancel = undefined
      for (const stop of state.stops.splice(0)) stop()
    },
    onEvent: (event, meta) => {
      // After a fold the catalog is known; the leader alone writes the groups that have no default yet.
      if (event.type !== "provider.updated" || !meta.local || !deps.runtime.isLeader()) return
      state.cancel?.()
      state.cancel = deps.clock.schedule(SETTLE_MS, () => {
        state.cancel = undefined
        void settle().catch((error: unknown) => log.error("presets_settle_failed", { error }))
      })
    },

    defaultFor: async (target) => {
      const models = await candidates(target)
      const value = await groupDefault(target.kind)
      // The group's value while this account has its model, the level fitted to the model's levels (07 §2.3); else the
      // group rule over this account's models, so a gone default never fails a new session (07 §4.3).
      const choice =
        value && models.some((model) => model.id === value.id)
          ? Preset.groupDefault(target.kind, value, models)?.start
          : await decide(target.kind, models)
      if (!choice) return undefined
      return { providerID: target.providerID, id: choice.id, ...(choice.variant ? { variant: choice.variant } : {}) }
    },

    known,
    star,
    preset: (id, group) =>
      id === Preset.builtinID(group) ? Preset.builtin(group) : presetsOf(group).find((preset) => preset.id === id),
    presetsOf,
    lighter,

    recordLighter: async (group, mainModelID, pair) => {
      const written = await mutate((current) =>
        current.groups[group]?.lighter?.[mainModelID]
          ? undefined
          : withGroup(current, group, (entry) => ({ ...entry, lighter: { ...entry.lighter, [mainModelID]: pair } })),
      ).catch((error: unknown) => {
        log.error("presets_write_failed", { group, what: "lighter", error })
        return undefined
      })
      return written?.groups[group]?.lighter?.[mainModelID]
    },

    settings,
    newSessionTargets: targets,

    repairs: async () => Preset.repairs((await checkAll()).flatMap((item) => item.gone)),

    budgets: () => (deps.remote ? (deps.remote.presetsBudget() ?? {}) : undefined),

    // `read` scope (paired devices): an undecided `auto` value is computed for the answer, never written here.
    list: async (input) => {
      const checked = await checkAll(input.group)
      const repairs = Preset.repairs(checked.flatMap((item) => item.gone))
      const current = settings()
      return {
        groups: checked.map((item) => item.view),
        newSession: current.newSession,
        recent: current.recent,
        ultraCaps: current.ultraCaps,
        ...(repairs.length > 0 ? { repairs } : {}),
      }
    },

    set: async (input, context) => {
      const save = input.preset
      if (save.id !== undefined && Preset.isBuiltin(save.id))
        return context.error("preset_builtin_locked", "preset_builtin_locked", { presetID: save.id })
      const stored =
        save.id === undefined
          ? undefined
          : groupsOf(state.view)
              .flatMap((group) => presetsOf(group))
              .find((preset) => preset.id === save.id)
      if (save.id !== undefined && !stored)
        return context.error("preset_not_found", "preset_not_found", { presetID: save.id })
      if (stored && stored.group !== save.group)
        return context.error("preset_wrong_group", "preset_wrong_group", { group: stored.group })
      // 07 §2.1 모델 묶음: a repaired entry gets a new key for its new model; then the pool's format. A `single` on
      // `메인과 같게` (an older window's save) is stored as `same` (UC 2026-10-18).
      const workers = rekeyed(Preset.plainWorkers(save.workers), stored?.workers, input.repairOf, (entry) =>
        runsOf(entry, save.group),
      )
      if (workers.pool !== undefined && !poolValid(workers.pool))
        return context.error("internal_error", "pool_invalid", {})
      const place = await unavailable(workers, save.group, stored?.workers)
      if (place) return context.error("preset_target_unavailable", "preset_target_unavailable", { role: place })
      // A preset serves every account of its group as the main, so R4 is judged without one (07 §5.4 저장 때의 판정).
      const verdict = Preset.allowed({ group: save.group, workers }, null, lookup)
      if (!verdict.ok)
        return context.error("same_company_subscription", "same_company_subscription", { accountID: verdict.accountID })
      if (!sensible(save.caps) || (typeof save.ultraCaps === "object" && save.ultraCaps && !sensible(save.ultraCaps)))
        return context.error("internal_error", "caps_invalid", {})
      const resolver = peers().presets.resolver
      const warnings = warningsOf(workers, save.group)
      // A model pool is stored with mode `same` (an older build reads it as 모두 메인과 같게) and frozen cards.
      const fields = {
        name: save.name,
        group: save.group,
        workers: workers.pool?.length
          ? {
              ...workers,
              mode: "same" as const,
              pool: await cardsOf(workers.pool, save.group, stored?.workers.pool, input.refreshCards === true),
            }
          : workers,
        delegation: save.delegation,
        caps: save.caps,
        ultraCaps: save.ultraCaps,
        // 07 §2.3: the default (`max`) is stored as absent.
        ...(save.subagentEffortMax === undefined || save.subagentEffortMax === Preset.EFFORT_MAX
          ? {}
          : { subagentEffortMax: save.subagentEffortMax }),
        ...(save.forcedEffort === undefined ? {} : { forcedEffort: save.forcedEffort }),
      }
      if (input.dryRun) {
        const preset: Preset.Info = {
          ...fields,
          id: save.id ?? Preset.ID.create(),
          revision: (stored?.revision ?? 0) + 1,
        }
        const main = await resolver.groupMain(save.group)
        return {
          preset,
          resolution: main ? await resolver.resolve(preset, main, { preview: true }) : null,
          warnings,
          dryRun: true,
        }
      }
      const outcome: { preset?: Preset.Info } = {}
      const id = save.id ?? Preset.ID.create()
      const written = await tryMutate("set", (current) => {
        const group = current.groups[save.group]
        const presets = group?.presets ?? []
        const existing = presets.find((preset) => preset.id === id)
        // Removed (or moved) by another writer since the checks above.
        if (save.id !== undefined && !existing) return undefined
        const preset: Preset.Info = { ...fields, id, revision: (existing?.revision ?? 0) + 1 }
        outcome.preset = preset
        // 07 §7.2: `[고치기]` of a gone model is recorded when the stored preset had that model in that place, with
        // the place's first target after the fix (`메인과 같게` when none is left). A model pool entry's fix goes to
        // `poolHistory` (the stored history's `place` stays a role or `single` for older builds).
        const fix = input.repairOf
        const spot =
          fix === undefined
            ? undefined
            : Preset.placesOf(existing?.workers ?? EMPTY).find((entry) => entry.spot === fix.place)
        const fixed =
          fix !== undefined &&
          spot !== undefined &&
          (spot.pool?.model === fix.model ||
            spot.targets.some((target) => "pin" in target && target.pin.model === fix.model))
        const role = fix !== undefined && isPlace(fix.place) ? fix.place : undefined
        const record: Preset.RepairRecord | undefined =
          fixed && role
            ? {
                at: deps.clock.now(),
                presetID: id,
                place: role,
                from: fix.model,
                to: Preset.placesOf(preset.workers).find((entry) => entry.spot === role)?.targets[0] ?? {
                  rel: "main",
                },
              }
            : undefined
        const old = fixed ? spot.pool : undefined
        const keys = new Set((existing?.workers.pool ?? []).map((entry) => entry.key))
        const now = (preset.workers.pool ?? []).find(
          (entry) =>
            old !== undefined && (entry.key === old.key || (!keys.has(entry.key) && entry.account === old.account)),
        )
        const pooled: Preset.PoolRepairRecord | undefined =
          fix && old
            ? {
                at: deps.clock.now(),
                presetID: id,
                key: old.key,
                from: fix.model,
                ...(now && now.model !== old.model ? { to: now.model } : {}),
              }
            : undefined
        return {
          ...withGroup(current, save.group, (entry) => ({
            ...entry,
            presets: existing ? presets.map((item) => (item.id === id ? preset : item)) : [...presets, preset],
            ...(record ? { history: [...(entry.history ?? []), record] } : {}),
            ...(pooled ? { poolHistory: [...(entry.poolHistory ?? []), pooled] } : {}),
          })),
          recent: [id, ...(current.recent ?? []).filter((recent) => recent !== id)].slice(0, RECENT_MAX),
        }
      })
      if (!written) return context.error("internal_error", "presets.json could not be written", {})
      if (!outcome.preset) return context.error("preset_not_found", "preset_not_found", { presetID: id })
      const main = await resolver.groupMain(save.group)
      // Saving is not a need of a lighter pair (07 §4.2): the answer shows the pair the rule gives now, unstored.
      const resolution = main ? await resolver.resolve(outcome.preset, main, { preview: true }) : null
      return { preset: outcome.preset, resolution, warnings, dryRun: false }
    },

    remove: async (input, context) => {
      const id = input.presetID
      if (Preset.isBuiltin(id)) return context.error("preset_builtin_locked", "preset_builtin_locked", { presetID: id })
      const outcome: { group?: Preset.Group } = {}
      const written = await tryMutate("remove", (current) => {
        const group = groupsOf(current).find((key) => current.groups[key]?.presets?.some((preset) => preset.id === id))
        if (!group) return undefined
        outcome.group = group
        const changed = withGroup(current, group, (entry) => ({
          ...(entry.star === id ? withoutStar(entry) : entry),
          presets: (entry.presets ?? []).filter((preset) => preset.id !== id),
        }))
        return current.recent ? { ...changed, recent: current.recent.filter((recent) => recent !== id) } : changed
      })
      if (!written) return context.error("internal_error", "presets.json could not be written", {})
      if (!outcome.group) return context.error("preset_not_found", "preset_not_found", { presetID: id })
      return { presetID: id, group: outcome.group, star: star(outcome.group) ?? Preset.builtinID(outcome.group) }
    },

    defaultsSet: async (input, context) => {
      const group = input.group
      const value = input.defaultModel
      const starred = input.star
      if (
        starred !== undefined &&
        starred !== Preset.builtinID(group) &&
        !presetsOf(group).some((p) => p.id === starred)
      )
        return context.error(
          "internal_error",
          Preset.isBuiltin(starred) ? "preset_wrong_group" : "preset_not_found",
          {},
        )
      if (typeof input.ultraCaps === "object" && !sensible(input.ultraCaps))
        return context.error("internal_error", "caps_invalid", {})
      const pair = input.lighter
      const changes: ReadonlyArray<(file: Preset.File) => Preset.File> = [
        ...(value === null ? [(file: Preset.File) => withoutDefault(file, group) ?? file] : []),
        ...(value
          ? [
              (file: Preset.File) =>
                withGroup(file, group, (entry) => ({ ...entry, defaultModel: { ...value, source: "user" as const } })),
            ]
          : []),
        ...(starred === undefined
          ? []
          : [
              (file: Preset.File) =>
                withGroup(file, group, (entry) =>
                  Preset.isBuiltin(starred) ? withoutStar(entry) : { ...entry, star: starred },
                ),
            ]),
        ...(pair
          ? [
              (file: Preset.File) =>
                withGroup(file, group, (entry) => ({
                  ...entry,
                  lighter: { ...entry.lighter, [pair.mainModelID]: { model: pair.model, source: "user" as const } },
                })),
            ]
          : []),
        ...(input.newSession ? [(file: Preset.File) => ({ ...file, newSession: input.newSession })] : []),
        ...(input.ultraCaps ? [(file: Preset.File) => ({ ...file, ultraCaps: input.ultraCaps })] : []),
      ]
      const written =
        changes.length === 0 ||
        (await tryMutate("defaults", (current) => {
          const next = changes.reduce((file, change) => change(file), current)
          return next === current ? undefined : next
        }))
      if (!written) return context.error("internal_error", "presets.json could not be written", {})
      if (value !== undefined) state.decided.delete(group)
      // `null`: the group is `auto` again, decided and written now from its live accounts (07 §8.1).
      const decided = value === null ? await groupDefault(group) : undefined
      if (decided) await write(group, decided)
      return (await check(group)).view
    },
  }
}

/**
 * The preset a root uses now (07 §5.3): its binding's while the main stays in the binding's group and that preset is
 * loaded, else the group's ★, else its `평소대로`. A binding to a removed preset runs like the ★ even before
 * `PresetApply.reconcile` rebinds it (a session whose Location was not loaded when the preset went).
 */
export function inEffect(
  presets: Pick<Api, "preset" | "star">,
  binding: Preset.Binding | undefined,
  group: Preset.Group,
): Preset.Info {
  const bound = binding?.group === group ? presets.preset(binding.presetID, group) : undefined
  return bound ?? presets.preset(presets.star(group) ?? Preset.builtinID(group), group) ?? Preset.builtin(group)
}

/**
 * `presets.json` as this build uses it (07 §5.4 "presets.json 로드"): every stored preset is judged like a save (R4
 * with `main: null`), and the pinned targets of each offending account are dropped from the loaded preset (one at a
 * time, the first offender in R4's order, until the preset holds). A preset filed under another group than its own
 * is not loaded.
 */
export function load(file: Preset.File, lookup: Preset.Lookup): { file: Preset.File; dropped: ReadonlyArray<Dropped> } {
  const groups = groupsOf(file).map((group) => {
    const entry = file.groups[group] ?? {}
    const cleaned = (entry.presets ?? [])
      .filter((preset) => preset.group === group)
      .map((preset) => clean(preset, lookup))
    return {
      group,
      entry: entry.presets ? { ...entry, presets: cleaned.map((item) => item.preset) } : entry,
      dropped: cleaned.flatMap((item) => item.dropped),
    }
  })
  return {
    file: { ...file, groups: Object.fromEntries(groups.map((item) => [item.group, item.entry])) },
    dropped: groups.flatMap((item) => item.dropped),
  }
}

function clean(stored: Preset.Info, lookup: Preset.Lookup): { preset: Preset.Info; dropped: ReadonlyArray<Dropped> } {
  // UC 2026-10-18: `다른 모델 하나로` on `메인과 같게` is read as `메인과 같은 모델로` (presets.json stays as it is).
  const plain = Preset.plainWorkers(stored.workers)
  const preset = plain === stored.workers ? stored : { ...stored, workers: plain }
  const pool = poolOf(preset)
  const valid = pool.dropped.length ? { ...preset, workers: { ...preset.workers, pool: pool.kept } } : preset
  const verdict = Preset.allowed(valid, null, lookup)
  if (verdict.ok) return { preset: valid, dropped: pool.dropped }
  const accountID = verdict.accountID
  const pinned = (target: Preset.Target) => "pin" in target && target.pin.account === accountID
  const workers = valid.workers
  const dropped = Preset.placesOf(workers)
    .filter((entry) => entry.targets.some(pinned))
    .map((entry) => ({ presetID: preset.id, name: preset.name, place: entry.spot, accountID, reason: "r4" as const }))
  const rest = clean(
    {
      ...valid,
      workers: {
        mode: workers.mode,
        roles: Object.fromEntries(
          Object.entries(workers.roles).map(([role, entry]) => [
            role,
            { ...entry, targets: entry.targets.filter((target) => !pinned(target)) },
          ]),
        ),
        ...(workers.single && !pinned(workers.single) ? { single: workers.single } : {}),
        ...(workers.pool ? { pool: workers.pool.filter((entry) => entry.account !== accountID) } : {}),
      },
    },
    lookup,
  )
  return { preset: rest.preset, dropped: [...pool.dropped, ...dropped, ...rest.dropped] }
}

/**
 * A stored pool read leniently, judged entry by entry (07 §2.1, §8.1): an entry whose key is no pool key, whose key
 * or target (account, model) an earlier entry already has, whose note is too long, or past {@link Preset.POOL_MAX},
 * is left out of the loaded view; every other entry and preset stays.
 */
function poolOf(preset: Preset.Info) {
  const entries = preset.workers.pool ?? []
  const verdicts = entries.map((entry, index) => {
    const earlier = entries.slice(0, index)
    return (
      Preset.isPoolKey(entry.key) &&
      (entry.note ?? "").length <= Preset.NOTE_MAX &&
      index < Preset.POOL_MAX &&
      !earlier.some((other) => other.key === entry.key || sameTarget(other, entry))
    )
  })
  return {
    kept: entries.filter((_entry, index) => verdicts[index]),
    dropped: entries.flatMap((entry, index): Dropped[] =>
      verdicts[index]
        ? []
        : [{ presetID: preset.id, name: preset.name, place: Preset.poolSpot(entry.key), reason: "invalid" }],
    ),
  }
}

/**
 * The pool's format when saving (07 §8.1 `pool_invalid`): 1 to {@link Preset.POOL_MAX} entries, every key a pool key,
 * notes at most {@link Preset.NOTE_MAX} characters, a forced level one this build knows, no key or target twice.
 */
function poolValid(pool: ReadonlyArray<Preset.PoolEntry>) {
  return (
    pool.length >= 1 &&
    pool.length <= Preset.POOL_MAX &&
    pool.every(
      (entry, index) =>
        Preset.isPoolKey(entry.key) &&
        (entry.note ?? "").length <= Preset.NOTE_MAX &&
        (entry.forcedEffort === undefined || Preset.forcedEffortOf(entry.forcedEffort) !== undefined) &&
        !pool.slice(0, index).some((other) => other.key === entry.key || sameTarget(other, entry)),
    )
  )
}

/**
 * A repaired pool entry (07 §4.3 `[고치기]` on `pool:<key>`) that kept its old key with a new model takes a new key
 * for that model (keys are frozen per model, 07 §3.3 이름 규칙 5); every other entry is as saved.
 */
function rekeyed(
  workers: Preset.Workers,
  before: Preset.Workers | undefined,
  fix: Preset.RepairOf | undefined,
  runs: (entry: Preset.PoolEntry) => Preset.PoolRuns | undefined,
): Preset.Workers {
  const key = fix === undefined ? undefined : Preset.poolKeyOf(fix.place)
  const pool = workers.pool
  const old = before?.pool?.find((entry) => entry.key === key && entry.model === fix?.model)
  if (key === undefined || pool === undefined || !old) return workers
  const taken = pool.flatMap((entry) => (entry.key === key ? [] : [entry.key]))
  return {
    ...workers,
    pool: pool.map((entry) =>
      entry.key === key && entry.model !== old.model
        ? { ...entry, key: Preset.poolKey(entry.model, taken, runs(entry)) }
        : entry,
    ),
  }
}

/** Whether two pool entries run the same model on the same account (no account = the main account). */
function sameTarget(a: Preset.PoolEntry, b: Preset.PoolEntry) {
  return a.model === b.model && a.account === b.account
}

/** The places the mode uses: `single` for `single`, the role rows for `by-role`, the pool's entries, none for `same`. */
function usedPlacesOf(workers: Preset.Workers) {
  const mode = Preset.modeOf(workers)
  if (mode === "same") return []
  return Preset.placesOf(workers).filter((entry) =>
    mode === "pool" ? entry.pool !== undefined : (mode === "single") === (entry.spot === "single"),
  )
}

function pinnedOf(workers: Preset.Workers) {
  return Preset.targetsOf(workers).flatMap((target) => ("pin" in target ? [target.pin] : []))
}

/**
 * Caps that make sense together: neither the concurrent nor the per-message cap exceeds the per-conversation one, when
 * there is one.
 */
function sensible(caps: Preset.Caps) {
  const total = caps.perSession ?? Infinity
  return caps.concurrent <= total && caps.perMessage <= total
}

const isGroup = Schema.is(Preset.Group)

const isPlace = Schema.is(Preset.Place)

/** Workers with nothing in them, for a preset not stored yet. */
const EMPTY: Preset.Workers = { mode: "same", roles: {} }

function groupsOf(file: Preset.File) {
  return Object.keys(file.groups).filter(isGroup)
}

function idsOf(file: Preset.File) {
  return new Set(groupsOf(file).flatMap((group) => (file.groups[group]?.presets ?? []).map((preset) => preset.id)))
}

function droppedKey(entry: Dropped) {
  return `${entry.presetID}\n${entry.place}\n${entry.accountID ?? ""}`
}

function withGroup(
  file: Preset.File,
  group: Preset.Group,
  change: (entry: Preset.GroupState) => Preset.GroupState,
): Preset.File {
  return { ...file, groups: { ...file.groups, [group]: change(file.groups[group] ?? {}) } }
}

function withoutDefault(file: Preset.File, group: Preset.Group): Preset.File | undefined {
  const current = file.groups[group]
  if (!current?.defaultModel) return undefined
  const { defaultModel: _removed, ...rest } = current
  return { ...file, groups: { ...file.groups, [group]: rest } }
}

function withoutStar(entry: Preset.GroupState): Preset.GroupState {
  const { star: _removed, ...rest } = entry
  return rest
}
