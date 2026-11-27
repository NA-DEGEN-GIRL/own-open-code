export * as Compaction from "./compaction.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { NonNegative } from "./id.js"
import type { Kind } from "./kind.js"

/**
 * Automatic compaction threshold (02 §4.7, user decision D6). Core compacts before a step when the context reaches its
 * ceiling of `ctx = limit.input || limit.context`: `ctx − max(floor(0.15·ctx), RESERVE_MIN_TOKENS)`, the reserve
 * dropping to 15% for a window below twice that (`core/src/session/compaction.ts` calculateCeiling, upstream
 * d9987ef9c8; 15% since v2.1, 10% before). A slot moves its threshold `T_slot` by registering `limit.input = ctx_eff`, the smallest window whose
 * ceiling reaches `T_slot`; `limit` is not part of the request bytes, so the cache prefix never changes (D6). A `compat`
 * slot keeps compacting at 90% of its window ({@link ceilingOf}), above core's ceiling below a 160k window. A session
 * can only compact earlier than its slot (`compaction.setSession`; own-accounts admits that compaction on the server
 * at `compaction.due`). These functions are pure so the server and own-web share them.
 */

/** Core's share of the window kept free for the reply and a large last step (`RESERVE_SHARE`, 0.1 before v2.1). */
export const RESERVE_SHARE = 0.15
/** A `compat` slot's share kept free: 10%, core's rule before upstream d9987ef9c8 ({@link ceilingOf}). */
export const COMPAT_RESERVE_SHARE = 0.1
/** Core's least reserve (`RESERVE_MIN`), kept by every window of at least twice this size. */
export const RESERVE_MIN_TOKENS = 16_000
/** Core's default `keep` (recent tokens a summary compaction keeps verbatim, `compaction.ts:189`). */
export const KEEP_TOKENS = 15_000
/** `T_floor = min(ceiling(ctx), K + 48k)`: headroom above the post-compaction context `S ≈ Z + S_sum + K` (4.7.3). */
export const FLOOR_MARGIN_TOKENS = 48_000
export const PERCENT_MIN = 10
export const PERCENT_MAX = 90
/** Bounds of the global `keep` written through `policy.set{patch.compaction.keepTokens}` (4.7.6 (가)). */
export const KEEP_MIN = 4_000
export const KEEP_MAX = 60_000

const fields = {
  /** Share of the original window `ctx` (10–90). */
  triggerPercent: optional(Schema.Int.check(Schema.isBetween({ minimum: PERCENT_MIN, maximum: PERCENT_MAX }))),
  /** Upper bound of the trigger in tokens; `null` = none. */
  maxTriggerTokens: optional(Schema.NullOr(PositiveInt)),
  /** At least this much of `ctx` stays free (output, tool results, estimation error). */
  minReserveTokens: optional(NonNegativeInt),
}

/** One model's setting (`Setting.models[modelID]`). */
export interface ModelSetting extends Schema.Schema.Type<typeof ModelSetting> {}
export const ModelSetting = Schema.Struct(fields).annotate({ identifier: "Own.Compaction.ModelSetting" })

/**
 * One layer of settings (02 §4.7.3): kind defaults, `policy.compaction.byKind[kind]` and `accounts[].compaction`.
 * Every field is optional; a later layer overrides field by field (4.7.4). `models` exists only in kind and account
 * layers.
 */
export interface Setting extends Schema.Schema.Type<typeof Setting> {}
export const Setting = Schema.Struct({
  ...fields,
  models: optional(Schema.Record(Schema.String, ModelSetting)),
}).annotate({ identifier: "Own.Compaction.Setting" })

const inputFields = {
  triggerPercent: optional(Schema.Int),
  maxTriggerTokens: optional(Schema.NullOr(Schema.Int)),
  minReserveTokens: optional(Schema.Int),
}

/**
 * A {@link Setting} as RPC input (`accounts.update`, `policy.set`). Ranges are not checked by the schema so that an
 * out-of-range value reaches the handler, which answers `setting_out_of_range{field, min, max}` (02 §9.2, §9.4).
 * Any valid `Setting` is a valid input.
 */
export interface SettingInput extends Schema.Schema.Type<typeof SettingInput> {}
export const SettingInput = Schema.Struct({
  ...inputFields,
  models: optional(Schema.Record(Schema.String, Schema.Struct(inputFields))),
}).annotate({ identifier: "Own.Compaction.SettingInput" })

/** Where an effective threshold comes from (02 §4.7.4), shown as `v2 기본`/`종류 기본`/… (03 §5.8.2). */
export const Source = Schema.Literals(["v2", "kind", "kindModel", "account", "accountModel", "session"]).annotate({
  identifier: "Own.Compaction.Source",
})
export type Source = typeof Source.Type

/** One model of an account as `accounts.list` shows it (`compaction.effective[]`). */
export interface Effective extends Schema.Schema.Type<typeof Effective> {}
export const Effective = Schema.Struct({
  modelID: Model.ID,
  /** The template's original window `ctx`. */
  windowTokens: PositiveInt,
  triggerTokens: PositiveInt,
  source: Source,
}).annotate({ identifier: "Own.Compaction.Effective" })

/** `accounts.list` item field (02 §9.2). The Claude slot has `setting: null` and only `source: "v2"`. */
export interface AccountView extends Schema.Schema.Type<typeof AccountView> {}
export const AccountView = Schema.Struct({
  setting: Schema.NullOr(Setting),
  effective: Schema.Array(Effective),
}).annotate({ identifier: "Own.Compaction.AccountView" })

/** A session's per-cycle estimates for {@link cycleCost} (ledger medians, defaults `Z=12k, δ=3k, S_sum=8k`). */
export interface Cycle extends Schema.Schema.Type<typeof Cycle> {}
export const Cycle = Schema.Struct({ Z: NonNegative, delta: NonNegative, summary: NonNegative }).annotate({
  identifier: "Own.Compaction.Cycle",
})

/**
 * A `compaction.due` whose compaction has not started yet: the server admits it itself, and a reconnecting client may
 * still run the same id (03 §5.8.5).
 */
export interface PendingDue extends Schema.Schema.Type<typeof PendingDue> {}
export const PendingDue = Schema.Struct({
  inputID: SessionMessage.ID,
  P: NonNegative,
  triggerTokens: PositiveInt,
}).annotate({ identifier: "Own.Compaction.PendingDue" })

/**
 * `cache.state.compaction` (02 §9.2): the session's **current** model. `null` for an unpinned session or a model whose
 * window is unknown (core never compacts it automatically).
 */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  providerID: Provider.ID,
  modelID: Model.ID,
  /** Original window: the denominator of the context bar (not the registered `ctx_eff`). */
  windowTokens: PositiveInt,
  /** Effective trigger `T` (session value included): the marker on the context bar. */
  triggerTokens: PositiveInt,
  slotTriggerTokens: PositiveInt,
  source: Source,
  sessionTriggerTokens: Schema.NullOr(PositiveInt),
  /** Lower bound of the session value; `compaction.setSession` accepts `[floorTokens, slotTriggerTokens)`. */
  floorTokens: PositiveInt,
  /** Core `compaction.keep.tokens` / `compaction.auto` from the own global config file; `null` when unreadable. */
  keepTokens: Schema.NullOr(NonNegativeInt),
  auto: Schema.NullOr(Schema.Boolean),
  /** Last step's `input + cache.read + cache.write + output + reasoning`; `null` before the first step. */
  P: Schema.NullOr(NonNegative),
  /** `max(0, triggerTokens − P)`; `null` without `P`. */
  remainingTokens: Schema.NullOr(NonNegative),
  cycle: Cycle,
  /** Always `null` while a revert is staged (02 §4.7.4). */
  pendingDue: Schema.NullOr(PendingDue),
}).annotate({ identifier: "Own.Compaction.View" })

/** One session a threshold change would compact at its next step (02 §4.7.5). */
export interface ImpactSession extends Schema.Schema.Type<typeof ImpactSession> {}
export const ImpactSession = Schema.Struct({
  sessionID: SessionID,
  P: NonNegative,
  /** The new threshold of the session's model. */
  triggerTokens: PositiveInt,
  /** The next summary request exceeds the new budget, so the oldest exchanges drop out of the summary. */
  truncates: Schema.Boolean,
  /** "Compact first" must not be offered: `POST /compact` would commit the staged revert (02 §4.7.4). */
  revertStaged: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Compaction.ImpactSession" })

/** `compactionImpact` of `accounts.update`/`policy.set` (with or without `dryRun`). */
export interface Impact extends Schema.Schema.Type<typeof Impact> {}
export const Impact = Schema.Struct({ sessions: Schema.Array(ImpactSession) }).annotate({
  identifier: "Own.Compaction.Impact",
})

/** `policy.json` `compaction` (02 §2.4.3): the user's changes to the kind defaults only. */
export interface ByKind extends Schema.Schema.Type<typeof ByKind> {}
export const ByKind = Schema.Struct({
  codex: optional(Setting),
  siwc: optional(Setting),
  oai: optional(Setting),
  anth: optional(Setting),
  ds: optional(Setting),
  xai: optional(Setting),
  or: optional(Setting),
  compat: optional(Setting),
  /** The Claude Agent route (02 §8.10.5, CAG-50): own enforces it, core keeps its v2 ceiling. */
  "claude-agent": optional(Setting),
}).annotate({ identifier: "Own.Compaction.ByKind" })

/** The kinds whose defaults `policy.compaction.byKind` can change: own's slots and the Claude Agent route (CAG-50). */
export type Tunable = Kind.Own | "claude-agent"
export const tunable: ReadonlyArray<Tunable> = ["codex", "siwc", "oai", "anth", "ds", "xai", "or", "compat", "claude-agent"]

// ---------------------------------------------------------------------------------------------------------------
// Kind defaults (02 §4.7.3 table)

/** The v2 default written explicitly (`v2 기본` choice of 03 §5.8.4). */
export const V2 = { triggerPercent: 90, maxTriggerTokens: null, minReserveTokens: 0 } as const satisfies Setting

/**
 * Every kind uses its full model window with core's output headroom (07 §6.1 R8): a window is never shortened to
 * guard against an overflow error core may not classify (compat servers; 07 §6.2 #2, PG9). User overrides still win.
 */
export const defaults: Readonly<Record<Kind.Own | "claude-sub" | "claude-agent", Setting>> = {
  codex: V2,
  siwc: V2,
  oai: V2,
  anth: V2,
  "claude-sub": V2,
  "claude-agent": V2,
  ds: V2,
  xai: V2,
  or: V2,
  compat: V2,
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution (02 §4.7.3–4.7.4)

type Fields = Pick<Setting, "triggerPercent" | "maxTriggerTokens" | "minReserveTokens">

/** One step of the resolution order; `setting` may be absent (nothing set at that step). */
export interface Layer {
  readonly source: Exclude<Source, "session">
  readonly setting: Fields | undefined
}

export interface ChainInput {
  readonly kind: Kind.Own | "claude-sub" | "claude-agent"
  readonly modelID: string
  /** `policy.compaction.byKind`. Ignored for `claude-sub`. */
  readonly policy?: ByKind | undefined
  /** `accounts[].compaction`. Ignored for `claude-sub`. */
  readonly account?: Setting | null | undefined
}

/**
 * Steps 2–5 of 02 §4.7.4 for one model, least specific first: kind constant, `policy.byKind[kind]`, its
 * `models[modelID]`, the account, the account's `models[modelID]`. Every kind constant is the v2 default, so a model
 * reports `v2` until something else is set.
 */
export function chain(input: ChainInput): ReadonlyArray<Layer> {
  const base: Layer = { source: "v2", setting: defaults[input.kind] }
  // The Claude slot is not own's: no kind or account setting applies (02 §8.4). The Claude Agent route takes both
  // (02 §8.10.5, CAG-50): own-accounts enforces them per conversation, since one provider serves every account.
  if (input.kind === "claude-sub") return [base]
  const kind = input.policy?.[input.kind]
  const account = input.account ?? undefined
  return [
    base,
    { source: "kind", setting: kind },
    { source: "kindModel", setting: kind?.models?.[input.modelID] },
    { source: "account", setting: account },
    { source: "accountModel", setting: account?.models?.[input.modelID] },
  ]
}

export interface Limit {
  readonly context: number
  readonly input?: number | undefined
}

export interface Resolved {
  /** `ctx = limit.input || limit.context` of the template (the original window). */
  readonly windowTokens: number
  /** `T_slot`. */
  readonly triggerTokens: number
  /** `T_floor = min(ceiling(ctx), K + 48k)`. */
  readonly floorTokens: number
  /** The kind's ceiling of `ctx` ({@link ceilingOf}), the upper bound of any threshold. */
  readonly ceilingTokens: number
  /**
   * `limit.input` to register (`ctx_eff`), or `null` when the threshold is core's own ceiling of `ctx` and the template
   * limit stays as it is (no key added, 02 §3.6).
   */
  readonly effectiveInput: number | null
  readonly source: Exclude<Source, "session">
  /** The setting asked for less than `T_floor` (raised) or more than the v2 default (lowered). */
  readonly clamped: "floor" | "ceiling" | null
}

/**
 * `T_slot` of one model (02 §4.7.3): fields merged over `layers` (later wins per field), `T_raw = min(pct·ctx, max,
 * ctx − reserve)`, clamped to `[T_floor, ceilingOf(ctx, kind)]`. The top percentage (`PERCENT_MAX`, the v2 default)
 * stands for that ceiling itself, which for most kinds is core's and not exactly 90% (it keeps at least 16k free).
 * `keep` is the core `keep` read from the own global config (default {@link KEEP_TOKENS}). Without `kind` the ceiling is
 * core's. `undefined` when the window is unknown (≤ 0): core never compacts automatically.
 */
export function resolve(
  layers: ReadonlyArray<Layer>,
  limit: Limit,
  keep: number = KEEP_TOKENS,
  kind?: ChainInput["kind"],
): Resolved | undefined {
  const window = windowOf(limit)
  if (window <= 0) return undefined
  const merged = merge(layers)
  const ceilingTokens = ceilingOf(window, kind)
  const floorTokens = floorOf(window, keep)
  const percent = merged.triggerPercent ?? PERCENT_MAX
  const raw = Math.floor(
    Math.min(
      percent >= PERCENT_MAX ? ceilingTokens : (percent / 100) * window,
      merged.maxTriggerTokens ?? Number.POSITIVE_INFINITY,
      window - (merged.minReserveTokens ?? 0),
    ),
  )
  const triggerTokens = Math.min(Math.max(raw, floorTokens), ceilingTokens)
  return {
    windowTokens: window,
    triggerTokens,
    floorTokens,
    ceilingTokens,
    effectiveInput: triggerTokens === ceiling(window) ? null : windowFor(triggerTokens),
    source: merged.source,
    clamped: raw < floorTokens ? "floor" : raw > ceilingTokens ? "ceiling" : null,
  }
}

export interface SessionResolved {
  readonly triggerTokens: number
  readonly source: Source
  /** The stored session value after raising it to this slot's floor; `null` when none is set. */
  readonly sessionTriggerTokens: number | null
}

/**
 * Step 6 (02 §4.7.4): a session can only compact earlier. `T = min(T_slot, max(T_session, T_floor))`, so a value
 * kept from a larger slot is raised to the new slot's floor after a switch.
 */
export function withSession(resolved: Resolved, session: number | null | undefined): SessionResolved {
  if (session === null || session === undefined)
    return { triggerTokens: resolved.triggerTokens, source: resolved.source, sessionTriggerTokens: null }
  const raised = Math.max(session, resolved.floorTokens)
  if (raised >= resolved.triggerTokens)
    return { triggerTokens: resolved.triggerTokens, source: resolved.source, sessionTriggerTokens: raised }
  return { triggerTokens: raised, source: "session", sessionTriggerTokens: raised }
}

/** `ctx` of a template limit (`limit.input || limit.context`). */
export function windowOf(limit: Limit) {
  return (limit.input ?? 0) || limit.context
}

/** Core's ceiling of a window: `window − max(floor(0.15·window), 16k)`, or 15% below a 32k window. */
export function ceiling(window: number) {
  const reserve = Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN_TOKENS ? RESERVE_MIN_TOKENS : 0)
  return window - reserve
}

/**
 * The latest threshold a model of `kind` can have: core's {@link ceiling}, except for `compat`, which keeps 90% of its
 * window, core's rule before upstream d9987ef9c8 (07 §6.1 R8). A compat window is often a small local one, where core's
 * fixed 16k reserve would compact a 32,768 window at 16,768 (51%). The slot gets there by registering a `limit.input`
 * above its window ({@link windowFor}): core reads `limit.input` only for this ceiling and fits every output limit
 * to `limit.context`, so a request never asks for more output than the real window has left; at the threshold that is
 * the 10% the reserve leaves. From a 160k window both rules are the same.
 */
export function ceilingOf(window: number, kind?: ChainInput["kind"]) {
  const core = ceiling(window)
  return kind === "compat" ? Math.max(core, Math.floor(window * (1 - COMPAT_RESERVE_SHARE))) : core
}

/**
 * The share of a large window that a `percent` setting (unset: {@link PERCENT_MAX}) compacts at, as screens name it
 * (03 §5.8.4): never later than the kind's {@link ceilingOf}, which is 85% under core's 15% reserve and 90% for
 * `compat`. The top percentage stands for that ceiling, so the model limit reads 85% on every kind but `compat`.
 */
export function shownPercent(percent: number | undefined, kind?: ChainInput["kind"]) {
  const top = Math.round((1 - (kind === "compat" ? COMPAT_RESERVE_SHARE : RESERVE_SHARE)) * 100)
  return Math.min(percent ?? PERCENT_MAX, top)
}

/** `T_floor` of a window. */
export function floorOf(window: number, keep: number = KEEP_TOKENS) {
  return Math.min(ceiling(window), keep + FLOOR_MARGIN_TOKENS)
}

/**
 * The smallest window whose core ceiling reaches `trigger`: `T + 16k` where the fixed reserve applies, else
 * `ceil(T / 0.85)` (corrected for floating point). The ceiling drops at the 32k window, so both are tried.
 */
export function windowFor(trigger: number) {
  const guess = Math.ceil(trigger / (1 - RESERVE_SHARE))
  return Math.min(
    ...[guess - 3, guess - 2, guess - 1, guess, guess + 1, trigger + RESERVE_MIN_TOKENS, guess + 2].filter(
      (window) => window > 0 && ceiling(window) >= trigger,
    ),
  )
}

/**
 * Whether the next summary request exceeds a budget `T` (02 §4.7.5): the request sends `Z + P_older ≈ P − K`
 * (6.3 ⑥); older exchanges drop out when that is above the budget.
 */
export function truncates(P: number, triggerTokens: number, keep: number = KEEP_TOKENS) {
  return P - keep > triggerTokens
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (`setting_out_of_range`, 02 §9.2)

export interface OutOfRange {
  readonly field: string
  readonly min: number | null
  readonly max: number | null
}

/**
 * The first field of `setting` that is out of range (02 §9.2 `accounts.update{compaction}`): `triggerPercent` 10–90,
 * `maxTriggerTokens ≥ T_floor`, `0 ≤ minReserveTokens < ctx`. `windows` maps each model the setting applies to onto
 * its original window. Top-level fields apply to every model: the cap must reach the largest floor, and the reserve
 * must leave room in the largest window (a smaller model then simply stays at its floor). `models[id]` fields use
 * that model's window. Field names are prefixed with `prefix` (e.g. `compaction.` or `compaction.byKind.ds.`).
 */
export function check(
  setting: SettingInput,
  windows: ReadonlyMap<string, number>,
  options: { readonly keep?: number; readonly prefix?: string } = {},
): OutOfRange | undefined {
  const prefix = options.prefix ?? ""
  const keep = options.keep ?? KEEP_TOKENS
  const all = [...windows.values()].filter((window) => window > 0)
  const top = checkFields(setting, all, keep, prefix)
  if (top) return top
  return Object.entries(setting.models ?? {})
    .map(([modelID, model]) => {
      const window = windows.get(modelID)
      return checkFields(
        model,
        window !== undefined && window > 0 ? [window] : all,
        keep,
        `${prefix}models.${modelID}.`,
      )
    })
    .find((problem) => problem !== undefined)
}

function checkFields(
  fields: Pick<SettingInput, "triggerPercent" | "maxTriggerTokens" | "minReserveTokens">,
  windows: ReadonlyArray<number>,
  keep: number,
  prefix: string,
): OutOfRange | undefined {
  const percent = fields.triggerPercent
  if (percent !== undefined && !(Number.isInteger(percent) && percent >= PERCENT_MIN && percent <= PERCENT_MAX))
    return { field: `${prefix}triggerPercent`, min: PERCENT_MIN, max: PERCENT_MAX }
  const floor = windows.length === 0 ? keep + FLOOR_MARGIN_TOKENS : Math.max(...windows.map((w) => floorOf(w, keep)))
  const max = fields.maxTriggerTokens
  if (max !== undefined && max !== null && !(Number.isInteger(max) && max >= floor))
    return { field: `${prefix}maxTriggerTokens`, min: floor, max: null }
  const reserve = fields.minReserveTokens
  const largest = windows.length === 0 ? undefined : Math.max(...windows)
  if (
    reserve !== undefined &&
    !(Number.isInteger(reserve) && reserve >= 0 && (largest === undefined || reserve < largest))
  )
    return { field: `${prefix}minReserveTokens`, min: 0, max: largest === undefined ? null : largest - 1 }
  return undefined
}

/** A checked {@link SettingInput} as a stored {@link Setting} (same shape; call {@link check} first). */
export function normalize(input: SettingInput): Setting {
  const fields = (value: Pick<SettingInput, "triggerPercent" | "maxTriggerTokens" | "minReserveTokens">): Fields => ({
    ...(value.triggerPercent === undefined ? {} : { triggerPercent: value.triggerPercent }),
    ...(value.maxTriggerTokens === undefined ? {} : { maxTriggerTokens: value.maxTriggerTokens }),
    ...(value.minReserveTokens === undefined ? {} : { minReserveTokens: value.minReserveTokens }),
  })
  const models = Object.entries(input.models ?? {})
  return {
    ...fields(input),
    ...(models.length === 0
      ? {}
      : { models: Object.fromEntries(models.map(([modelID, model]) => [modelID, fields(model)])) }),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ⑫ cycle cost (02 §6.3)

export interface CycleCostInput {
  /** Threshold `T` in tokens. */
  readonly triggerTokens: number
  readonly cycle: Cycle
  /** Core `keep` `K`. */
  readonly keep?: number
  /** Rates per 1M tokens in the account's unit (`ratecards.get`); `out: null` = unknown. */
  readonly rates: { readonly read: number; readonly cold: number; readonly out: number | null }
  /** Hit rate of the summary request (`h_c`); default 1 (longest-prefix caches within TTL). */
  readonly summaryHit?: number
  /** Worst case of kinds with `TTL_lo = 0` (ds, xai, or, compat): reads cost as cold writes. */
  readonly readAsCold?: boolean
}

/**
 * ⑫ Average cost per request of staying on one slot with threshold `T` (02 §6.3): the cycle's average input plus the
 * summary request and the cold first request after it, spread over the requests between compactions. `null` when
 * the output rate is unknown (02 §2.4.4: never computed as 0).
 */
export function cycleCost(input: CycleCostInput): number | null {
  const out = input.rates.out
  if (out === null) return null
  const keep = input.keep ?? KEEP_TOKENS
  const cold = input.rates.cold / 1e6
  const read = (input.readAsCold ? input.rates.cold : input.rates.read) / 1e6
  const hit = input.summaryHit ?? 1
  const T = input.triggerTokens
  const S = input.cycle.Z + input.cycle.summary + keep
  const n = Math.max(1, (T - S) / Math.max(1, input.cycle.delta))
  const average = (S + T) / 2
  const compaction = Math.max(0, T - keep) * (hit * read + (1 - hit) * cold) + input.cycle.summary * (out / 1e6)
  return average * read + input.cycle.delta * cold + (compaction + S * (cold - read)) / n
}

// ---------------------------------------------------------------------------------------------------------------

function merge(layers: ReadonlyArray<Layer>) {
  return layers.reduce<Fields & { readonly source: Exclude<Source, "session"> }>(
    (merged, layer) => {
      const setting = layer.setting
      if (!setting) return merged
      const set = {
        ...(setting.triggerPercent === undefined ? {} : { triggerPercent: setting.triggerPercent }),
        ...(setting.maxTriggerTokens === undefined ? {} : { maxTriggerTokens: setting.maxTriggerTokens }),
        ...(setting.minReserveTokens === undefined ? {} : { minReserveTokens: setting.minReserveTokens }),
      }
      if (Object.keys(set).length === 0) return merged
      return { ...merged, ...set, source: layer.source }
    },
    { source: "v2" },
  )
}
