export * as PresetResolve from "./resolve.js"

import { Provider } from "@opencode/schema/provider"
import { Account, ClaudeAgent, CodexModels, Kind, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { CodexMeta } from "../slots/codex-meta.js"
import type { Slots } from "../slots/slots.js"
import { Templates } from "../slots/templates.js"
import { Planner } from "../switching/planner.js"
import { Variant } from "../switching/variant.js"
import { PresetLighter } from "./lighter.js"
import type { PresetStore } from "./store.js"

/**
 * Owner: PRESETS (07 §3.4, §4.2). The server side of target resolution: what each own account, the Claude slot and
 * each discovered local provider offers now ({@link Inventory}, priced like 07 §3.4), the main a preset resolves
 * against, and `Preset.resolve` over the live registry, the fold's catalog snapshot and the group's lighter-pair table
 * (a pair is decided on first need, `PresetLighter`). A `codex` account's models carry their Codex metadata
 * (`CodexMeta`), so efforts fit in Codex's level order (07 §2.3, §4.5). Nothing here ever picks a model outside a
 * preset's list.
 */
export interface Api {
  /** R4's view of an account (07 §5.4): an own account, with its ChatGPT login, or the Claude slot. In memory. */
  readonly lookup: Preset.Lookup
  /** Whether a local model's running window is verified (07 §6.2 #8); every local model is unverified until wired. */
  readonly localVerified: LocalVerified
  /** A local model's running window in tokens when known (07 §6.2 #8), for a model pool card. */
  readonly localWindow: LocalWindow
  /** What an account or local provider offers now; `undefined` for an unknown, retired or uninstalled one. */
  inventory(account: string): Promise<Inventory | undefined>
  /**
   * Every live own account, each Claude account of the slot when installed and acknowledged (the default first), each
   * Claude Agent account (the default first), and every discovered local provider.
   */
  inventories(): Promise<ReadonlyArray<Inventory>>
  /**
   * Whether an own provider is a local model account (`Account.isLocal`, 02 §3.3a, PF 2026-11-03): free, never "only
   * when others fail".
   */
  localCompat(providerID: string): boolean
  /**
   * The main a preset resolves against for a session's main Ref; `undefined` when its provider is in no group. With a
   * session, a Claude Agent main is the account its tree is bound to (02 §8.10.10, CAG-55), else the default account.
   */
  main(ref: Variant.Ref, sessionID?: string): Promise<Preset.Main | undefined>
  /**
   * A model's levels as a per-call effort fits them (07 §2.3): an own account's, the Claude slot's or a local
   * provider's like {@link main} (a `codex` model with its Codex metadata), any other provider's from the Location's
   * model list; none for a model nobody lists.
   */
  levels(ref: Variant.Ref): Promise<{ readonly variants: ReadonlyArray<string>; readonly meta?: CodexModels.Model }>
  /**
   * A group's preview main (07 §4.2 "편집기 미리 보기", `presets.set`): its first live account on the group's
   * new-session default model; a local group's first model. `undefined` while the group has nothing to run on.
   */
  groupMain(group: Preset.Group): Promise<Preset.Main | undefined>
  /**
   * A preset's targets as Refs for this main (07 §4.2). The group of the main's account owns the lighter-pair table; a
   * pair needed for the first time is decided now ({@link ResolveOptions.write}). A pinned target outside R4 with the
   * main (and the binding's team) is skipped as `r4`, one that cannot run now (02 §5.7) as `unavailable`. A model pool
   * preset's entries carry their facts (`Preset.PoolSide`, 07 §3.3): what they run on, the company and the raw ranking
   * price, decided from the registry and the catalog whether or not the entry can run now.
   */
  resolve(preset: Pick<Preset.Info, "workers">, main: Preset.Main, options?: ResolveOptions): Promise<Preset.Resolution>
}

export interface ResolveOptions {
  /** The binding's team context (07 §5.1): its accounts and pins join the R4 check. */
  readonly team?: Preset.Team
  /**
   * Store a lighter pair decided by this call (`source:"auto"`). Paths that use it (applying a preset, the gate) pass
   * `true`; read paths keep the decided pair in memory, and it is the value a later write stores (U3).
   */
  readonly write?: boolean
  /**
   * Saving or checking a preset (`presets.set`) is not a need (07 §4.2: a pair is decided when first needed, after the
   * user picks that main): a missing pair is worked out for this answer only, neither stored nor remembered, so a
   * model released before the first need still counts.
   */
  readonly preview?: boolean
}

/** Whether a local model's running window is verified (07 §6.2 #8, PG9). */
export type LocalVerified = (providerID: string, modelID: string) => boolean

/** A local model's running window in tokens, when known (07 §6.2 #8). */
export type LocalWindow = (providerID: string, modelID: string) => number | undefined

export interface Options {
  /** Default: no local window is verified, so no local model is suggested (T1.10 wires the slots' local window). */
  readonly localVerified?: LocalVerified
  /** Default: the slots' running window (`Slots.localWindow`). */
  readonly localWindow?: LocalWindow
}

/**
 * What one own account, the Claude slot (`acc_claude_slot`) or one discovered local provider (`local:<id>`) offers
 * now: the provider a call goes to, its models as they register, and the input price that ranks them (07 §3.4).
 * `ready` = it can run at all (status ready or unverified; the Claude slot installed and acknowledged); `usable` = ready
 * and not exhausted or failing auth now (02 §5.7).
 */
export interface Inventory {
  readonly account: Account.ID | `local:${string}`
  /** The account's kind (`claude-sub` for the Claude slot); absent for a local provider. */
  readonly kind?: Kind.Any
  readonly providerID: string
  readonly billing: Account.Billing | "local"
  /** The account's company (`Preset.company`); absent for a local provider. */
  readonly company?: string
  /** A local model account (`Account.isLocal`, 02 §3.3a): its models are local models. */
  readonly local?: true
  readonly models: ReadonlyArray<Preset.Entry>
  /** A model's raw ranking price; a ChatGPT OAuth slot's and the Claude slot's are found by id alone. */
  readonly price: (model: Price) => number | undefined
  readonly ready: boolean
  readonly usable: boolean
}

export function create(deps: Deps, peers: Module.Peers, store: PresetStore.Api, options: Options = {}): Api {
  const localVerified = options.localVerified ?? (() => false)
  const localWindow: LocalWindow =
    options.localWindow ??
    ((providerID, modelID) => peers().slots.localWindow(providerID, modelID)?.runtime ?? undefined)
  const lookup = lookupOf(peers)
  const claudeReady = () => {
    const slot = peers().plugins.claudeSlot()
    return slot.detected && slot.verified
  }
  // Claude (no own account) is usable while any of this PC's Claude accounts is (02 §8.7); a tree on an exhausted one
  // moves to another by itself (02 §8.8).
  const usable = (account: Account.Info | undefined, providerID: string) =>
    Planner.usability(
      deps.runtime.limits,
      account,
      providerID,
      account === undefined && providerID === Provider.ID.anthropic
        ? peers()
            .claude.list()
            .map((item) => item.accountID)
        : account === undefined && providerID === ClaudeAgent.PROVIDER_ID
          ? peers()
              .claudeAgent.list()
              .map((item) => item.accountID)
          : undefined,
    ).usable

  // 02 §3.3a: the local model marker decides; LMT-7 marks older compat accounts on a local server at control start.
  const localCompat = (providerID: string) => {
    const slot = peers().slots.slot(providerID)
    return slot !== undefined && Account.isLocal(slot.account)
  }

  const ownInventory = async (account: Account.Info): Promise<Inventory> => {
    const slots = peers().slots
    const ready = account.status === "ready" || account.status === "unverified"
    return {
      account: account.id,
      kind: account.kind,
      providerID: account.providerID,
      billing: Account.chargeOf(account),
      company: Preset.company(account),
      ...(Account.isLocal(account) ? { local: true as const } : {}),
      models: slots.models(account.providerID),
      // 02 §3.3a: a local model has no price, like a discovered local provider.
      price: Account.isLocal(account) ? () => undefined : await prices(slots, account.kind),
      ready,
      usable: ready && usable(account, account.providerID),
    }
  }

  /**
   * One Claude account of the slot (02 §8.7; account 1 is `acc_claude_slot`): the slot's `anthropic` catalog, usable
   * while that account is not exhausted. A pin to it is the account a tree without a Claude account starts on
   * (`ClaudeAccounts` `initial`, PF 2026-11-03); R4 still allows one Claude account per tree.
   */
  const claudeInventory = async (accountID: Account.ID = Account.ID.claudeSlot): Promise<Inventory> => {
    const slots = peers().slots
    const ready = claudeReady()
    return {
      account: accountID,
      kind: "claude-sub",
      providerID: Provider.ID.anthropic,
      billing: "subscription",
      company: Preset.company(CLAUDE_SLOT),
      models: await slots.catalog(Provider.ID.anthropic),
      price: await prices(slots, "claude-sub"),
      ready,
      usable: ready && Planner.usability(deps.runtime.limits, undefined, Provider.ID.anthropic, [accountID]).usable,
    }
  }

  /** The Claude slot's accounts, the default first; the slot alone while its list is empty (a remote service early). */
  const claudeAccounts = () => {
    const claude = peers().claude
    const listed = claude.list()
    if (!listed.length) return [Account.ID.claudeSlot]
    const first = claude.defaultID()
    return listed.map((item) => item.accountID).toSorted((a, b) => Number(b === first) - Number(a === first))
  }

  /**
   * A Claude Agent account (02 §8.10), the default one unless named: its models are the provider's live list (Claude
   * Code's own). The route is one group like the Claude slot; a tree runs on its own bound account (R4).
   */
  const agentInventory = async (accountID?: string): Promise<Inventory | undefined> => {
    const agent = accountID === undefined ? peers().claudeAgent.account() : peers().claudeAgent.entry(accountID)
    if (!agent) return undefined
    const member = { id: agent.accountID, kind: "claude-agent" as const, billing: "subscription" as const }
    return {
      account: agent.accountID,
      kind: "claude-agent",
      providerID: ClaudeAgent.PROVIDER_ID,
      billing: "subscription",
      company: Preset.company(member),
      models: (await listed(deps)).filter((model) => model.providerID === ClaudeAgent.PROVIDER_ID),
      price: await prices(peers().slots, "claude-agent"),
      ready: true,
      usable: Planner.usability(deps.runtime.limits, undefined, ClaudeAgent.PROVIDER_ID, [agent.accountID]).usable,
    }
  }

  /** The Claude Agent account a session's tree runs on (its binding), else the default one. */
  const agentOf = async (sessionID: string | undefined) => {
    const claudeAgent = peers().claudeAgent
    const bound = sessionID === undefined ? undefined : await claudeAgent.accountOf(sessionID)
    return (bound === undefined ? undefined : claudeAgent.entry(bound)) ?? claudeAgent.account()
  }

  const localInventory = (account: `local:${string}`, models: ReadonlyArray<Preset.Entry>): Inventory => ({
    account,
    providerID: account.slice("local:".length),
    billing: "local",
    models,
    price: () => undefined,
    ready: true,
    usable: true,
  })

  const inventory = async (account: string): Promise<Inventory | undefined> => {
    if (Preset.isLocal(account)) {
      const models = await localModels(deps, account.slice("local:".length))
      return models.length ? localInventory(account, models) : undefined
    }
    if (account === Account.ID.claudeSlot || peers().claude.entry(account))
      return claudeReady() ? claudeInventory(Account.ID.make(account)) : undefined
    if (peers().claudeAgent.entry(account)) return agentInventory(account)
    const found = peers().slots.account(account)
    return found && found.status !== "retired" ? ownInventory(found) : undefined
  }

  const main = async (ref: Variant.Ref, sessionID?: string): Promise<Preset.Main | undefined> => {
    const slots = peers().slots
    const levels = (models: ReadonlyArray<Preset.Entry>) =>
      models.find((model) => model.id === ref.id)?.variants.map((variant) => variant.id) ?? []
    const own = slots.slot(ref.providerID)
    if (own) {
      const meta = own.kind === "codex" ? await CodexMeta.model(deps, ref.id) : undefined
      return {
        account: own.account.id,
        ref: Variant.ref(ref),
        variants: levels(slots.models(ref.providerID)),
        ...(meta === undefined ? {} : { meta }),
      }
    }
    if (ref.providerID === Provider.ID.anthropic && peers().plugins.claudeSlot().detected)
      return {
        account: Account.ID.claudeSlot,
        ref: Variant.ref(ref),
        variants: levels(await slots.catalog(Provider.ID.anthropic)),
      }
    const agent = ref.providerID === ClaudeAgent.PROVIDER_ID ? await agentOf(sessionID) : undefined
    if (agent)
      return {
        account: agent.accountID,
        ref: Variant.ref(ref),
        variants: levels((await listed(deps)).filter((model) => model.providerID === ClaudeAgent.PROVIDER_ID)),
      }
    if (!Preset.LOCAL_PROVIDERS.some((id) => id === ref.providerID)) return undefined
    return {
      account: `local:${ref.providerID}`,
      ref: Variant.ref(ref),
      variants: levels(await localModels(deps, ref.providerID)),
    }
  }

  const lighter = PresetLighter.create(store, async (account) => {
    const found = await inventory(account)
    return found ? Preset.candidates(found.models, found.price) : []
  })

  return {
    lookup,
    localVerified,
    localWindow,
    inventory,
    localCompat,

    inventories: async () => {
      const accounts = peers()
        .slots.snapshot()
        .accounts.filter((account) => account.status !== "retired")
      const models = await listed(deps)
      const locals = Preset.LOCAL_PROVIDERS.flatMap((providerID) => {
        const offered = models.filter((model) => model.providerID === providerID)
        return offered.length ? [localInventory(`local:${providerID}`, offered)] : []
      })
      return [
        ...(await Promise.all(accounts.map(ownInventory))),
        ...(claudeReady() ? await Promise.all(claudeAccounts().map((id) => claudeInventory(id))) : []),
        ...(
          await Promise.all(
            peers()
              .claudeAgent.list()
              .map((item) => agentInventory(item.accountID)),
          )
        ).filter((item) => item !== undefined),
        ...locals,
      ]
    },

    main,

    levels: async (ref) => {
      const found = await main(ref)
      if (found) return { variants: found.variants, ...(found.meta === undefined ? {} : { meta: found.meta }) }
      const model = (await listed(deps)).find((item) => item.providerID === ref.providerID && item.id === ref.id)
      return { variants: model?.variants.map((variant) => variant.id) ?? [] }
    },

    groupMain: async (group) => {
      if (Preset.isLocal(group)) {
        const providerID = group.slice("local:".length)
        const first = (await localModels(deps, providerID))[0]
        return first && main({ providerID, id: first.id })
      }
      const target = store.newSessionTargets().find((candidate) => candidate.kind === group)
      const ref = target && (await store.defaultFor(target))
      return ref && main(ref)
    },

    resolve: async (preset, current, resolveOptions = {}) => {
      const workers = preset.workers
      // Every role row, `single` and the model pool's pinned entries (`Preset.targetsOf`), used by the mode or not.
      const targets = Preset.targetsOf(workers)
      const group = groupOfMain(current.account, lookup)
      const pair =
        group && targets.some((target) => "rel" in target && target.rel === "lighter")
          ? await lighter.pair(
              group,
              current,
              resolveOptions.preview ? "preview" : resolveOptions.write ? "write" : "read",
            )
          : undefined
      const table = { ...(group ? store.lighter(group) : {}), ...(pair ? { [current.ref.id]: pair } : {}) }
      const accounts = [
        ...new Set([current.account, ...targets.flatMap((target) => ("pin" in target ? [target.pin.account] : []))]),
      ]
      const found = new Map(
        (await Promise.all(accounts.map(async (account) => [account, await inventory(account)] as const))).flatMap(
          (entry): Array<[string, Inventory]> => (entry[1] ? [[entry[0], entry[1]]] : []),
        ),
      )
      const codex = [...found.values()].some((offer) => offer.kind === "codex")
        ? await CodexMeta.snapshot(deps)
        : undefined
      // R4 with the main and the binding's team, judged once per pinned account (07 §5.4). A main whose account is
      // gone has no company to judge against: none of its pins runs (fail closed).
      const mainID = Preset.isLocal(current.account) ? null : Account.ID.make(current.account)
      const broken = new Set<string>(
        targets.flatMap((target) => {
          if (!("pin" in target) || Preset.isLocal(target.pin.account)) return []
          if (!group) return [target.pin.account]
          const single = { group, workers: { mode: "single" as const, single: target, roles: {} } }
          return Preset.allowed(single, mainID, lookup, resolveOptions.team).ok ? [] : [target.pin.account]
        }),
      )
      const catalog: Preset.Catalog = (account, model) => {
        if (broken.has(account)) return "r4"
        const offer = found.get(account)
        if (!offer) return undefined
        if (!offer.usable) return "unavailable"
        const entry = offer.models.find((candidate) => candidate.id === model && callable(candidate))
        const meta = offer.kind === "codex" ? CodexModels.find(codex, model) : undefined
        return (
          entry && {
            providerID: offer.providerID,
            variants: entry.variants.map((variant) => variant.id),
            ...(meta === undefined ? {} : { meta }),
          }
        )
      }
      const resolution = Preset.resolve(preset, current, catalog, table)
      const pool = resolution.pool
      if (!pool) return resolution
      // 07 §3.3: each entry's facts and the main's, the same whether or not the entry can run now.
      const priced = new Map<Kind.Any, ReturnType<typeof prices>>()
      const sideOf = async (account: string, model: string, main: boolean): Promise<Preset.PoolSide> => {
        if (Preset.isLocal(account)) return { runs: "local" }
        const member = lookup(Account.ID.make(account))
        if (!member) return {}
        // 02 §3.3a: a local model account runs free like a discovered local provider.
        if (member.billing === "local") return { runs: "local" }
        const pricing = priced.get(member.kind) ?? prices(peers().slots, member.kind)
        priced.set(member.kind, pricing)
        const entry = found.get(account)?.models.find((candidate) => candidate.id === model)
        const price = (await pricing)({ id: model, cost: entry?.cost ?? [] })
        const subscription = member.billing === "subscription"
        return {
          runs: main ? (subscription ? "main" : "main-paid") : subscription ? "subscription" : "paid",
          company: Preset.company(member),
          ...(price === undefined ? {} : { price }),
        }
      }
      const stored = new Map((workers.pool ?? []).map((entry) => [entry.key, entry]))
      const entries = await Promise.all(
        pool.entries.map(async (item) => {
          const entry = stored.get(item.key)
          return entry
            ? { ...item, ...(await sideOf(entry.account ?? current.account, entry.model, entry.account === undefined)) }
            : item
        }),
      )
      const main = await sideOf(current.account, current.ref.id, true)
      return { ...resolution, pool: { main: { ...main, local: Preset.isLocal(current.account) }, entries } }
    },
  }
}

/** What a price function reads of a model: its id, and its own costs when the account still lists it. */
export interface Price {
  readonly id: string
  readonly cost: Preset.Entry["cost"]
}

/**
 * R4's view of an account (07 §5.4): an own account from the registry in memory, a Claude Agent account, or the Claude
 * slot, which every one of its accounts reads as (07 §5.4 여러 Claude 구독 계정: the tree's binding keeps one account per
 * tree, so R4 counts the slot once whichever account a preset names).
 */
export function lookupOf(peers: Module.Peers): Preset.Lookup {
  return (accountID) =>
    accountID === Account.ID.claudeSlot || peers().claude.entry(accountID)
      ? CLAUDE_SLOT
      : (peers().claudeAgent.lookup(accountID) ?? member(peers().slots.account(accountID)))
}

/** An own account as the money rules see it: a local model's billing is `local` (02 §3.3a). */
function member(account: Account.Info | undefined): Preset.Member | undefined {
  return account && { ...account, billing: Account.chargeOf(account) }
}

/**
 * Input prices of a kind's models (07 §3.4). A ChatGPT OAuth slot (`codex`, `siwc`) is free, so its models are priced
 * from the fold's `openai` catalog; the Claude slot's `anthropic` catalog loses its prices to claude-auth, so a missing
 * price comes from the bundled `anth` template; every other kind has its own live price. Reading the catalog also
 * forces the first fold, so the slot's models carry their live fields.
 */
export async function prices(slots: Slots.Api, kind: Kind.Any): Promise<(model: Price) => number | undefined> {
  if (kind === "claude-sub") {
    const bundled = await anthPrices()
    return (model) => Preset.basePrice(model.cost) ?? bundled.get(model.id)
  }
  // The Claude Agent provider prices its models from Anthropic's on an API key, and lists a plan's as free (02 §8.10).
  if (kind === "compat" || kind === "claude-agent") return (model) => Preset.basePrice(model.cost)
  const catalog = await slots.catalog(Templates.SOURCE[kind])
  if (!Kind.isOAuth(kind)) return (model) => Preset.basePrice(model.cost)
  const openai = new Map(catalog.map((model) => [String(model.id), Preset.basePrice(model.cost)]))
  return (model) => openai.get(model.id)
}

const bundledAnth: { prices?: Promise<ReadonlyMap<string, number | undefined>> } = {}

/** The bundled `anth` template's input prices; it ships with the build, so it is read and decoded once. */
function anthPrices() {
  bundledAnth.prices ??= Templates.bundled("anth").then(
    (template) => new Map((template?.models ?? []).map((model) => [String(model.id), Preset.basePrice(model.cost)])),
  )
  return bundledAnth.prices
}

/** A model a subagent can run on: listed, not deprecated, and able to call tools (07 §3.4). */
export function callable(model: Preset.Entry) {
  return model.enabled && model.status !== "deprecated" && model.capabilities?.tools !== false
}

/** The group whose lighter pairs a main reads: its account's kind, `claude-sub`, or its local provider. */
function groupOfMain(account: string, lookup: Preset.Lookup): Preset.Group | undefined {
  if (Preset.isLocal(account)) return account
  return lookup(Account.ID.make(account))?.kind
}

/** The Location's models of one discovered local provider (core's live list); empty when it cannot be read. */
async function localModels(deps: Deps, providerID: string): Promise<ReadonlyArray<Preset.Entry>> {
  return (await listed(deps)).filter((model) => model.providerID === providerID)
}

/**
 * Core's live model list of this Location, where discovered local providers appear (07 §4.1). A Location that cannot
 * answer lists nothing (the call is deferred so a missing context member rejects instead of throwing).
 */
async function listed(deps: Deps) {
  const result = await Promise.resolve()
    .then(() => deps.ctx.model.list())
    .catch(() => undefined)
  return result?.data ?? []
}

/** R4 member of the Claude slot (`acc_claude_slot`, 02 §8.5). */
const CLAUDE_SLOT: Preset.Member = { id: Account.ID.claudeSlot, kind: "claude-sub", billing: "subscription" }
