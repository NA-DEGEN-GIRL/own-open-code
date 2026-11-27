export * as Access from "./access.js"

import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account, Kv, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Planner } from "../switching/planner.js"
import type { Variant } from "../switching/variant.js"
import { PresetBudget } from "./budget.js"
import { PresetResolve } from "./resolve.js"
import { PresetStore } from "./store.js"

/**
 * Who a subagent call or a model listing answers to (07 §5.4). `parent` is the calling session's Ref, which a call
 * "like the main" inherits (07 §2.8). `ref` is the root session's Ref: its provider is the main account's slot.
 * `member` is that account when it is an own account or the Claude slot; `group` is set for those and for a local
 * provider. Any other provider has neither, so only its own models are allowed.
 */
export interface Main {
  readonly root: string
  readonly parent: Variant.Ref
  readonly ref: Variant.Ref
  readonly member: Preset.Member | undefined
  readonly group: Preset.Group | undefined
}

/**
 * How a configured `agent.model` outside the main account fares (07 §5.4 steps 3–4): `ok` = allowed for that agent,
 * `subscription` = an own subscription slot (the call runs on the role's target instead), `budget` = a metered account
 * whose monthly budget is used up, `denied` = anything else.
 */
export type Admission = "ok" | "subscription" | "budget" | "denied"

/**
 * What a root's preset allows now (07 §5.4 허용 집합 A). `resolution`: every role resolved against the main, with the
 * binding's team in the R4 check (`undefined` when the preset names no target, so every role runs like the main).
 * `pinned`: the providers of resolved pinned targets (model pool pins included) that can take a call now (usable,
 * inside R4, a paid account within its budget). With the main account's slot they are A's providers; configured agent
 * models join A only for their own agent. `pool`: a model pool preset's entries as the gate reads them now.
 */
export interface Plan {
  readonly resolution: Preset.Resolution | undefined
  readonly pinned: ReadonlySet<string>
  readonly pool?: Pool
}

/**
 * A model pool as the gate reads it (07 §5.4 2단계 모델 묶음): the main's facts, each entry in pool order with its Ref
 * now and its default-rule view (`Preset.PoolChoice`, `usable` and `verified` live: a paid entry over its budget is
 * not usable, a local one needs its running window verified), and the static default rule (`Preset.poolDefaults`) the
 * guidance names, so a call that runs elsewhere can say so.
 */
export interface Pool {
  readonly main: Preset.PoolMain
  readonly entries: ReadonlyArray<PoolEntry>
  readonly defaults: Partial<Readonly<Record<Preset.Role, string>>>
}

export interface PoolEntry extends Preset.PoolChoice {
  readonly model: string
  readonly ref?: Variant.Ref
  /** The entry costs money (`paid`, `main-paid`) and its account's monthly budget is used up. */
  readonly spent: boolean
}

export interface Api {
  /**
   * The main of a session tree; `undefined` when a lookup fails or the session or its root has no model. The gate and
   * the models filter then fail closed (decision 2026-10-02).
   */
  main(sessionID: string): Promise<Main | undefined>
  /** The root's binding (KV `sess:<root>:preset`); `undefined` before it is bound or when this build cannot read it. */
  binding(root: string): Promise<Preset.Binding | undefined>
  /**
   * The preset the root uses now (07 §5.3, `PresetStore.inEffect`): the binding's while the main stays in its group
   * and the preset is loaded, else the group's ★, else its `평소대로`. `undefined` for a main in no group.
   */
  preset(main: Main, binding: Preset.Binding | undefined): Preset.Info | undefined
  /**
   * A's resolution and pinned providers for this root (see {@link Plan}), for a call: a lighter pair needed for the
   * first time is stored (07 §4.2). Throws when a lookup fails.
   */
  plan(main: Main, preset: Preset.Info | undefined, team: Preset.Team | undefined): Promise<Plan>
  /**
   * The providers a model listing keeps (07 §5.4 "`models` 도구 거르기"): the main slot and {@link Plan.pinned} of the
   * root's preset (and its binding's team). A read: nothing is stored. Throws when a lookup fails.
   */
  providers(main: Main): Promise<ReadonlySet<string>>
  /** An own subscription slot: an own account billed by subscription, or the Claude slot. In memory (folds use it). */
  subscription(providerID: string): boolean
  /** The own account of a paid provider (metered or prepaid, 07 §5.4 step 4); `undefined` otherwise. In memory. */
  paid(providerID: string): Account.Info | undefined
  /**
   * The group of a main on this provider (07 P-D2): its own account's kind, `claude-sub` for `anthropic` only while
   * the Claude slot is installed (an Anthropic API key is no group), `local:<id>` for a local provider, else
   * `undefined`. The gate and the session binding both use it. In memory.
   */
  groupOf(providerID: string): Preset.Group | undefined
  /**
   * A model the LLM wrote, as a model of the main account: unchanged on the main slot, or moved there from the
   * main kind's canonical provider (`openai/<id>` names the main Codex slot's model, 02 §4.3 D9). `undefined` otherwise.
   */
  onMain(main: Main, ref: Variant.Ref): Variant.Ref | undefined
  /**
   * A configured `agent.model` outside the main account (07 §5.4 step 3): a local provider, or an own metered or
   * prepaid account that is usable now, passes R4 (`Preset.allowed`, the binding's team included) and has budget left.
   */
  admit(main: Main, ref: Variant.Ref, team?: Preset.Team): Promise<Admission>
}

export function create(deps: Deps, peers: Module.Peers): Api {
  const session = (sessionID: string) => deps.ctx.session.get({ sessionID }).catch(() => undefined)

  /** The runtime index knows most parents without a lookup (`runtime.sessions`); the session itself decides. */
  const indexed = (sessionID: string): string => {
    const parentID = deps.runtime.sessions.get(sessionID)?.parentID
    return parentID ? indexed(parentID) : sessionID
  }
  const root = async (sessionID: string): Promise<Awaited<ReturnType<typeof session>>> => {
    const info = await session(indexed(sessionID))
    return info?.parentID ? root(info.parentID) : info
  }

  const claudeSlot = (providerID: string) =>
    providerID === Provider.ID.anthropic && peers().plugins.claudeSlot().detected

  // A Claude Agent account is a subscription of company Anthropic like the slot (02 §8.10, CAG): the one the root's
  // tree runs on, so R4 tells the route's accounts apart.
  const member = (providerID: string, root?: string): Preset.Member | undefined =>
    claudeSlot(providerID)
      ? CLAUDE_SLOT
      : (peers().claudeAgent.member(providerID, root) ?? peers().slots.slot(providerID)?.account)

  // The registry's own `Account.Info`, identity included: R4 counts one ChatGPT login's codex and siwc accounts once.
  const lookup = PresetResolve.lookupOf(peers)

  const subscription = (providerID: string) =>
    claudeSlot(providerID) ||
    peers().claudeAgent.member(providerID) !== undefined ||
    peers().slots.slot(providerID)?.account.billing === "subscription"

  const paid = (providerID: string) => {
    const account = peers().slots.slot(providerID)?.account
    return account && PresetBudget.paid(account) ? account : undefined
  }

  const groupOf = (providerID: string) => Preset.groupOf(providerID, member(providerID))

  const preset = (main: Main, binding: Preset.Binding | undefined) =>
    main.group === undefined ? undefined : PresetStore.inEffect(peers().presets, binding, main.group)

  /** `write`: a lighter pair needed for the first time is stored (the gate), else kept in memory (a listing, 07 §4.2). */
  const resolved = async (
    main: Main,
    current: Preset.Info | undefined,
    team: Preset.Team | undefined,
    write: boolean,
  ): Promise<Plan> => {
    if (!current || !targeted(current.workers)) return NOTHING
    const resolver = peers().presets.resolver
    const against = await resolver.main(main.ref, main.root)
    if (!against) return NOTHING
    const resolution = await resolver.resolve(current, against, { team, write })
    const stored = new Map((current.workers.pool ?? []).map((entry) => [entry.key, entry]))
    const pool = resolution.pool
    const refs = [
      ...Preset.ROLES.flatMap(
        (role) =>
          resolution.roles[role]?.targets.flatMap((item) => ("pin" in item.target && item.ref ? [item.ref] : [])) ?? [],
      ),
      // A pinned pool entry; a main-account one runs on the main slot, already in A.
      ...(pool?.entries.flatMap((item) => (item.ref && stored.get(item.key)?.account ? [item.ref] : [])) ?? []),
    ]
    const spent = async (ref: Variant.Ref | undefined) => {
      const account = ref && paid(ref.providerID)
      return account !== undefined && (await PresetBudget.exhausted(peers, account))
    }
    const kept = await Promise.all(refs.map(async (ref) => ((await spent(ref)) ? [] : [ref.providerID])))
    if (!pool) return { resolution, pinned: new Set(kept.flat()) }
    const facts = pool.entries.flatMap((item) => {
      const entry = stored.get(item.key)
      const side = { ...(item.runs ? { runs: item.runs } : {}), ...(item.company ? { company: item.company } : {}) }
      return entry ? [{ item, entry, side: item.price === undefined ? side : { ...side, price: item.price } }] : []
    })
    const compared = { model: against.ref.id, side: pool.main }
    const entries = await Promise.all(
      facts.map(async (fact): Promise<PoolEntry> => {
        const ref = fact.item.ref
        const exhausted = await spent(ref)
        return {
          key: fact.entry.key,
          model: fact.entry.model,
          ...(ref === undefined ? {} : { ref }),
          side: fact.side,
          relation: Preset.poolRelation({ ...fact.entry, side: fact.side }, compared),
          usable: ref !== undefined && !exhausted,
          verified: fact.side.runs !== "local" || (ref !== undefined && resolver.localVerified(ref.providerID, ref.id)),
          spent: exhausted,
        }
      }),
    )
    const defaults = Preset.poolDefaults(
      facts.map((fact) => ({ ...fact.entry, side: fact.side })),
      compared,
    )
    return { resolution, pinned: new Set(kept.flat()), pool: { main: pool.main, entries, defaults } }
  }

  const binding = async (rootID: string) =>
    Option.getOrUndefined(decodeBinding(await deps.ctx.storage.get(Kv.preset(rootID))))

  return {
    main: async (sessionID) => {
      const parent = await session(sessionID)
      const top = parent?.parentID ? await root(parent.parentID) : parent
      if (!parent?.model || !top?.model) return undefined
      return {
        root: top.id,
        parent: parent.model,
        ref: top.model,
        member: member(top.model.providerID, top.id),
        group: groupOf(top.model.providerID),
      }
    },

    binding,

    preset,

    plan: (main, current, team) => resolved(main, current, team, true),

    providers: async (main) => {
      const bound = await binding(main.root)
      const found = await resolved(main, preset(main, bound), bound?.team, false)
      return new Set([main.ref.providerID, ...found.pinned])
    },

    subscription,

    paid,

    groupOf,

    onMain: (main, ref) => {
      if (ref.providerID === main.ref.providerID) return ref
      const slots = peers().slots
      const canonical = slots.slot(main.ref.providerID)?.canonical
      return ref.providerID === canonical && slots.model(main.ref.providerID, ref.id)
        ? { ...ref, providerID: main.ref.providerID }
        : undefined
    },

    admit: async (main, ref, team) => {
      if (Preset.LOCAL_PROVIDERS.some((id) => id === ref.providerID)) return "ok"
      if (subscription(ref.providerID)) return "subscription"
      const account = peers().slots.slot(ref.providerID)?.account
      if (!account || !Planner.usability(deps.runtime.limits, account, ref.providerID, undefined, ref.id).usable)
        return "denied"
      // The configured target as a pinned preset entry; a main without an own account judges it like a saved preset.
      const pinned = {
        group: main.group ?? account.kind,
        workers: {
          mode: "single" as const,
          single: { pin: { account: account.id, model: Model.ID.make(ref.id) } },
          roles: {},
        },
      }
      if (!Preset.allowed(pinned, main.member?.id ?? null, lookup, team).ok) return "denied"
      return (await PresetBudget.exhausted(peers, account)) ? "budget" : "ok"
    },
  }
}

/**
 * `provider/model` or `provider/model#variant`, the subagent tool's `model` format. Core reads a session stored without
 * a variant back as variant `default` (`packages/core/src/session/info.ts`), the provider's default and never one of
 * the model's variants, so the tool would refuse `#default` (`Variant "default" is not available`): it is written
 * without one.
 */
export function text(ref: Variant.Ref) {
  return `${ref.providerID}/${ref.id}${ref.variant === undefined || ref.variant === "default" ? "" : `#${ref.variant}`}`
}

/** A `model` value the LLM wrote; `undefined` when it is not `provider/model[#variant]` (core then rejects it). */
export function parse(value: string): Variant.Ref | undefined {
  // Checked first because `Model.Ref.parse` throws on anything else.
  return REF.test(value) ? Model.Ref.parse(value) : undefined
}

/**
 * Whether a preset sends any role to a target of its own (07 §3.2): `single` with a target, a role row, or a model
 * pool with an entry.
 */
function targeted(workers: Preset.Workers) {
  const mode = Preset.modeOf(workers)
  if (mode === "pool") return true
  if (mode === "single") return workers.single !== undefined
  if (mode === "same") return false
  return Preset.ROLES.some((role) => (workers.roles[role]?.targets.length ?? 0) > 0)
}

const REF = /^[^/#]+\/[^#]+(?:#[^#]+)?$/

const NOTHING: Plan = { resolution: undefined, pinned: new Set() }

const decodeBinding = Schema.decodeUnknownOption(Preset.Binding)

/** R4 member of the Claude slot (`acc_claude_slot`, 02 §8.5). */
const CLAUDE_SLOT: Preset.Member = { id: Account.ID.claudeSlot, kind: "claude-sub", billing: "subscription" }
