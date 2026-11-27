// Neutral chips for subagent calls the preset gate declined (07 §5.4 거절 경로, §7.3 거절 안내, §2.6). A refusal is
// recognised by its failure text only (`Unknown agent: own-preset: …`, subagent/model.ts `presetRejection`) and read
// back with `Preset.parse`; the LLM's tool input is never what decides it, only what the chip names (the model it asked
// for, the role). Also what the chip's actions need: the role and the pinned target `[하위 에이전트에 추가…]` opens the
// editor with (never offered for another subscription of the main's company, R4), the model `[묶음에 추가…]` checks in
// a model pool (07 §8.3 모델 묶음: the main account's model when the main slot offers it), and the paid account a consent
// or budget chip names, from the preset in effect and its resolution (`session.preset.get`). A per-call effort's
// refusal (07 §2.3) is its own kind: unknown, or above the ceiling with the level allowed and whether `이번 메시지만
// 허용` applies. Pure.
import { Model } from "@opencode/schema/model"
import type { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { gateText, requestedRef, type PresetRejection } from "@/subagent/model"
import type { PoolPick } from "./model"

export type Chip =
  /** A cap reached (2.6): `하위 에이전트 대기: 3개 실행 중`, per message (with `이번 메시지만 늘리기`) or per conversation. */
  | { readonly kind: "caps"; readonly cap: Preset.Cap; readonly max: number }
  /** Delegation `안 함` (2.5). */
  | { readonly kind: "off" }
  /**
   * A model outside the preset (`pool`: outside its model pool, `이 모델 묶음에 없습니다`); `add` = what
   * `[하위 에이전트에 추가…]` or `[묶음에 추가…]` fills, absent when it may not be added.
   */
  | { readonly kind: "model"; readonly pool?: true; readonly add?: Addition }
  /** A paid target over its monthly budget (5.4 step 4). */
  | { readonly kind: "budget"; readonly account?: Account.ID }
  /** A role would move onto a paid account the user has not allowed in this conversation (5.4 step 4). */
  | {
      readonly kind: "consent"
      readonly role: Preset.Role
      readonly account?: Account.ID
      /** The subscription target the role waits on (`Claude 한도 대기 · …`). */
      readonly blocked?: Account.ID
    }
  /** A per-call effort the gate cannot read (07 §2.3): an unknown level, `ultra` or `persistent`. */
  | { readonly kind: "effort" }
  /**
   * A per-call effort above the ceiling (07 §2.3): `max` = the highest level allowed on that target now; `once` = the
   * user may allow more for this message (`이번 메시지만 허용`), never for a paid target.
   */
  | { readonly kind: "effortCap"; readonly max: string; readonly once: boolean }
  /** A gate text this build does not know: the plain T0 chip. */
  | { readonly kind: "unknown" }

/** What a chip's add button fills: a role's first target, or a model of the pool (`EditorRequest.prefill`). */
export type Addition = { readonly role: Preset.Role; readonly target: Preset.Target } | { readonly pool: PoolPick }

export interface ChipContext {
  /** The group of the root's main (07 P-D2); absent while the main is not known. */
  readonly group?: Preset.Group
  /** The preset in effect and its resolution for the main now (`session.preset.get`). */
  readonly preset?: Pick<Preset.Info, "workers">
  readonly resolution?: Preset.Resolution | null
  /** The own account of a provider id (OwnStore `accountFor`). */
  readonly accountOf: (providerID: string) => Account.View | undefined
  readonly lookup: Preset.Lookup
  /** The root's main slot and the model ids it offers (a model pool's main-account models, 07 §8.3). */
  readonly main?: { readonly providerID: string; readonly models: ReadonlyArray<string> }
}

export function chipOf(rejection: PresetRejection, context: ChipContext): Chip {
  const parsed = Preset.parse(gateText(rejection))
  if (!parsed) return { kind: "unknown" }
  if (parsed.reason === "caps") return { kind: "caps", cap: parsed.cap, max: parsed.max }
  if (parsed.reason === "off") return { kind: "off" }
  if (parsed.reason === "effort") return { kind: "effort" }
  if (parsed.reason === "effort-cap") return { kind: "effortCap", max: parsed.max, once: parsed.once }
  if ("models" in parsed) {
    const pick = poolAddition(rejection, context)
    return pick ? { kind: "model", pool: true, add: { pool: pick } } : { kind: "model", pool: true }
  }
  const role = roleOf(rejection)
  if (parsed.reason === "model") {
    const target = pinned(rejection, context)
    return target ? { kind: "model", add: { role, target } } : { kind: "model" }
  }
  const targets = targetsOf(context.preset, role)
  const account = targets.flatMap((target) => {
    const accountID = pinnedAccount(target)
    const billing = accountID ? context.lookup(accountID)?.billing : undefined
    return accountID && (billing === "metered" || billing === "prepaid") ? [accountID] : []
  })[0]
  if (parsed.reason === "budget") return account ? { kind: "budget", account } : { kind: "budget" }
  const blocked = context.resolution?.roles[role]?.targets.flatMap((resolved) => {
    const accountID = pinnedAccount(resolved.target)
    return accountID && resolved.skip === "unavailable" && context.lookup(accountID)?.billing === "subscription"
      ? [accountID]
      : []
  })[0]
  return { kind: "consent", role, ...(account ? { account } : {}), ...(blocked ? { blocked } : {}) }
}

/** The role the LLM asked for: its `agent`, else a role name written as the model (07 §3.2), else `general`. */
function roleOf(rejection: PresetRejection): Preset.Role {
  return Preset.roleOf(rejection.agent ?? "") ?? Preset.roleOf(rejection.requestedModel ?? "") ?? "general"
}

/** A role's targets in the preset's worker mode (`single` sends every role to its one target; a pool pins no role). */
function targetsOf(preset: Pick<Preset.Info, "workers"> | undefined, role: Preset.Role) {
  const workers = preset?.workers
  const mode = workers && Preset.modeOf(workers)
  if (mode === "single") return workers?.single ? [workers.single] : []
  if (mode === "by-role") return workers?.roles[role]?.targets ?? []
  return []
}

function pinnedAccount(target: Preset.Target) {
  return "pin" in target && !Preset.isLocal(target.pin.account) ? target.pin.account : undefined
}

/**
 * The asked-for `provider/model` pinned on its own account or local provider (07 §7.3 `[하위 에이전트에 추가…]`). None
 * for a model this window cannot place (a built-in or canonical provider id) and none for another subscription of the
 * main's company, which no preset of the group may pin (R4, 07 §5.4).
 */
function pinned(rejection: PresetRejection, context: ChipContext) {
  const ref = rejection.requestedModel ? requestedRef(rejection.requestedModel) : undefined
  if (!ref || !context.group) return undefined
  const model = Model.ID.make(ref.modelID)
  const account = context.accountOf(ref.providerID)
  if (account) {
    const home = Preset.isLocal(context.group) ? undefined : Preset.company({ kind: context.group })
    if (account.billing === "subscription" && Preset.company(account) === home) return undefined
    return { pin: { account: account.id, model } }
  }
  if (!Preset.LOCAL_PROVIDERS.some((id) => id === ref.providerID)) return undefined
  return { pin: { account: `local:${ref.providerID}` as const, model } }
}

/**
 * What `[묶음에 추가…]` checks (07 §8.3 모델 묶음): a main-account model (no account, whichever account is the main) for
 * the main slot's model, for a model of the main slot under its company's canonical provider id (`openai/…`, the gate's
 * `Access.onMain` rule) and for a bare id the main slot offers; else the model pinned like `[하위 에이전트에 추가…]`
 * (another company's subscription, a paid account, a local provider); nothing for another subscription of the main's
 * company (R4) or a model this window cannot place.
 */
function poolAddition(rejection: PresetRejection, context: ChipContext): PoolPick | undefined {
  const requested = rejection.requestedModel
  const main = context.main
  if (!requested || !context.group) return undefined
  const offered = (id: string) => main?.models.includes(id) === true
  const ref = requestedRef(requested)
  if (!ref) {
    const bare = requested.split("#")[0] ?? ""
    return offered(bare) ? { model: Model.ID.make(bare) } : undefined
  }
  const owner = main && context.accountOf(main.providerID)
  const canonical = owner !== undefined && ref.providerID === Preset.company(owner) && offered(ref.modelID)
  if (ref.providerID === main?.providerID || canonical) return { model: Model.ID.make(ref.modelID) }
  const target = pinned(rejection, context)
  return target && { model: target.pin.model, account: target.pin.account }
}
