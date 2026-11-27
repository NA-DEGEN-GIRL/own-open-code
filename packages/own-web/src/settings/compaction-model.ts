// Auto-compaction settings model (03 §5.8.4). The choices are shortcuts for `Compaction.Setting` values of 02 §4.7.3
// (no new schema): `inherit` clears the layer, `v2` writes the v2 default (the model limit), `custom` edits the three
// fields. There is no conservative kind default (07 §6.2 #3): every kind starts at the model limit. Previews use
// `Compaction.resolve`/`cycleCost` from @own/protocol, so no RPC runs while the user types (5.8.4 "미리보기는 그
// 자리에서 계산한다").
import type { Kind, Ratecard } from "@own/protocol"
import { Compaction } from "@own/protocol/compaction"

export type Choice = "inherit" | "v2" | "custom"

export type Fields = Pick<Compaction.Setting, "triggerPercent" | "maxTriggerTokens" | "minReserveTokens">

/** 02 §6.3 ⑫ defaults when no open session gives its own `cycle` (5.8.4). */
export const DEFAULT_CYCLE: Compaction.Cycle = { Z: 12_000, delta: 3_000, summary: 8_000 }

/** Kinds whose caches may drop to cold at once (`TTL_lo = 0`): ⑫ reads count as cold writes (worst case). */
const READ_AS_COLD: ReadonlySet<Kind.Any> = new Set(["ds", "xai", "or", "compat"])

/** Choices of a kind row: the model limit or the user's own values. */
export const KIND_CHOICES: readonly Choice[] = ["v2", "custom"]

/** Choices of an account or account×model row (5.8.4: `종류 기본` = follow the layer above). */
export const LAYER_CHOICES: readonly Choice[] = ["inherit", "v2", "custom"]

/** Which choice a stored kind layer (`policy.compaction.byKind[kind]`) shows. */
export function kindChoiceOf(stored: Fields | undefined): Choice {
  if (!stored || !hasFields(stored) || sameFields(stored, Compaction.V2)) return "v2"
  return "custom"
}

/** Which choice a stored account or model layer shows. */
export function layerChoiceOf(stored: Fields | null | undefined): Choice {
  if (!stored || !hasFields(stored)) return "inherit"
  if (sameFields(stored, Compaction.V2)) return "v2"
  return "custom"
}

/**
 * The value to write for a kind row (`policy.set{patch:{compaction:{byKind:{[kind]: …}}}}`): `null` returns to the
 * code constant (the model limit); kind layers have no models UI.
 */
export function kindValue(choice: Choice, custom: Fields): Compaction.SettingInput | null {
  if (choice === "custom") return clean(custom)
  return null
}

/**
 * The account setting after changing its top-level choice (`accounts.update{compaction}`); per-model entries are kept.
 * `null` when nothing remains (back to the kind default).
 */
export function accountValue(
  current: Compaction.Setting | null | undefined,
  choice: Choice,
  custom: Fields,
): Compaction.SettingInput | null {
  const models = current?.models
  const top = choice === "custom" ? clean(custom) : choice === "v2" ? { ...Compaction.V2 } : {}
  const next = { ...top, ...(models && Object.keys(models).length ? { models } : {}) }
  return Object.keys(next).length ? next : null
}

/** The account setting after changing one model's choice (`models[modelID]`). */
export function modelValue(
  current: Compaction.Setting | null | undefined,
  modelID: string,
  choice: Choice,
  custom: Fields,
): Compaction.SettingInput | null {
  const models = { ...current?.models }
  if (choice === "inherit") delete models[modelID]
  if (choice === "v2") models[modelID] = { ...Compaction.V2 }
  if (choice === "custom") models[modelID] = clean(custom)
  const top = current ? topFields(current) : {}
  const next = { ...top, ...(Object.keys(models).length ? { models } : {}) }
  return Object.keys(next).length ? next : null
}

function topFields(setting: Compaction.Setting): Fields {
  return {
    ...(setting.triggerPercent === undefined ? {} : { triggerPercent: setting.triggerPercent }),
    ...(setting.maxTriggerTokens === undefined ? {} : { maxTriggerTokens: setting.maxTriggerTokens }),
    ...(setting.minReserveTokens === undefined ? {} : { minReserveTokens: setting.minReserveTokens }),
  }
}

function clean(fields: Fields): Fields {
  return topFields(fields)
}

function hasFields(fields: Fields) {
  return (
    fields.triggerPercent !== undefined ||
    fields.maxTriggerTokens !== undefined ||
    fields.minReserveTokens !== undefined
  )
}

function sameFields(a: Fields, b: Fields) {
  return (
    (a.triggerPercent ?? Compaction.PERCENT_MAX) === (b.triggerPercent ?? Compaction.PERCENT_MAX) &&
    (a.maxTriggerTokens ?? null) === (b.maxTriggerTokens ?? null) &&
    (a.minReserveTokens ?? 0) === (b.minReserveTokens ?? 0)
  )
}

/** Fields shown in a `custom` editor when it opens: the stored ones, else what the layer above resolves to. */
export function editorFields(stored: Fields | null | undefined, fallback: Fields): Fields {
  if (stored && hasFields(stored)) return topFields(stored)
  return topFields(fallback)
}

export interface Preview {
  readonly resolved: Compaction.Resolved
  /** 5.8.4: the model window is too small to move the threshold at all. */
  readonly fixed: boolean
}

/**
 * `T_slot` of one account model with a draft account setting (02 §4.7.3–4.7.4). `undefined` when the window is
 * unknown (core never compacts automatically).
 */
export function preview(input: {
  readonly kind: Kind.Any
  readonly modelID: string
  readonly windowTokens: number
  readonly byKind: Compaction.ByKind | undefined
  readonly account: Compaction.Setting | null | undefined
  readonly keep: number
}): Preview | undefined {
  const kind = input.kind
  const layers = Compaction.chain({
    kind,
    modelID: input.modelID,
    policy: input.byKind,
    account: input.account ?? null,
  })
  // With the kind, as the account registration does: a compat model keeps 90% of its window (`Compaction.ceilingOf`).
  const resolved = Compaction.resolve(layers, { context: input.windowTokens }, input.keep, kind)
  if (!resolved) return undefined
  return { resolved, fixed: resolved.ceilingTokens < input.keep + Compaction.FLOOR_MARGIN_TOKENS }
}

/** A draft kind layer applied on top of the stored `byKind`, for kind-row previews. */
export function withKind(
  byKind: Compaction.ByKind | undefined,
  kind: Compaction.Tunable,
  value: Compaction.SettingInput | null,
) {
  const next: Record<string, Compaction.Setting | undefined> = { ...byKind }
  next[kind] = value === null ? undefined : Compaction.normalize(value)
  return next as Compaction.ByKind
}

export interface Rates {
  readonly unit: Ratecard.Unit
  readonly read: number
  readonly cold: number
  readonly out: number
}

/**
 * Rates of a kind and model from the rate cards (02 §2.4.4). Only explicit card rates count: a card that takes its
 * prices from the model catalog (`inFromCatalog`) or lacks an output rate gives `undefined`, and the cost line is
 * hidden (5.8.4 "계정의 요율을 모르면 비용 줄을 숨긴다").
 */
export function ratesFor(cards: readonly Ratecard.Card[], kind: Kind.Any, modelID: string): Rates | undefined {
  const card = matchCard(cards, kind, modelID)
  if (!card || card.inFromCatalog || card.in === undefined || card.in === null) return undefined
  const rateIn = card.in
  const out = card.out
  if (out === undefined || out === null) return undefined
  const read = card.read ?? (card.readMul === undefined ? undefined : rateIn * card.readMul) ?? rateIn
  const cold =
    card.write5m ?? card.write ?? (card.writeMul === undefined ? undefined : rateIn * card.writeMul) ?? rateIn
  return { unit: card.unit, read, cold, out }
}

/** ⑫ average cost per request at the v2 default and at the chosen threshold (5.8.4 비용 비교 줄). */
export function costCompare(input: {
  readonly kind: Kind.Any
  readonly windowTokens: number
  readonly triggerTokens: number
  readonly rates: Rates
  readonly cycle: Compaction.Cycle
  readonly keep: number
}) {
  const cost = (triggerTokens: number) =>
    Compaction.cycleCost({
      triggerTokens,
      cycle: input.cycle,
      keep: input.keep,
      rates: input.rates,
      readAsCold: READ_AS_COLD.has(input.kind),
    })
  return { v2: cost(Compaction.ceiling(input.windowTokens)), chosen: cost(input.triggerTokens), unit: input.rates.unit }
}

/**
 * The most specific card (02 §2.4.4): exact `model` beats a `modelGte`/`modelLt` range, which beats a kind-only
 * card; ties go to the earlier card. Same rule as the router's `Rates.match`.
 */
export function matchCard(cards: readonly Ratecard.Card[], kind: Kind.Any, modelID: string) {
  const base = modelID.slice(modelID.lastIndexOf("/") + 1)
  const scored = cards.flatMap((card, index) => {
    if (card.match.kind !== kind) return []
    if (card.match.model !== undefined && card.match.model !== modelID && card.match.model !== base) return []
    if (card.match.modelGte !== undefined && !((compareVersion(base, card.match.modelGte) ?? -1) >= 0)) return []
    if (card.match.modelLt !== undefined && !((compareVersion(base, card.match.modelLt) ?? 0) < 0)) return []
    const ranged = card.match.modelGte !== undefined || card.match.modelLt !== undefined
    return [{ card, index, specificity: card.match.model !== undefined ? 3 : ranged ? 2 : 1 }]
  })
  return scored.toSorted((a, b) => b.specificity - a.specificity || a.index - b.index)[0]?.card
}

function compareVersion(a: string, b: string) {
  const left = version(a)
  const right = version(b)
  if (!left || !right || left.prefix !== right.prefix) return undefined
  const length = Math.max(left.numbers.length, right.numbers.length)
  const diff = Array.from({ length }, (_, index) => (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)).find(
    (value) => value !== 0,
  )
  return diff === undefined ? 0 : Math.sign(diff)
}

function version(id: string) {
  const found = /^(?<prefix>[a-z-]*?)(?<version>\d+(?:\.\d+)*)/i.exec(id)?.groups
  if (!found) return undefined
  return { prefix: found.prefix!.toLowerCase(), numbers: found.version!.split(".").map(Number) }
}
