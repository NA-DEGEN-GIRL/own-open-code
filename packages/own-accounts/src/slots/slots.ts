export * as Slots from "./slots.js"

import { Option, Schema } from "effect"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionID } from "@opencode/schema/session-id"
import { Credentials, Store, type LastResponse } from "@own/runtime"
import {
  Account,
  ClaudeAgent,
  Compaction,
  Kind,
  OwnID,
  Policy,
  Preset,
  type Credential,
  type OwnAccounts,
  type Registry,
} from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import { Nonces } from "../nonces.js"
import { LocalWindow } from "../presets/local-window.js"
import { RpcTypes } from "../rpc/types.js"
import { CodexMeta } from "./codex-meta.js"
import { CompatProbe } from "./compat-probe.js"
import { CoreConfig } from "./core-config.js"
import { Registration } from "./registration.js"
import { TemplateDiff } from "./template-diff.js"
import { Templates } from "./templates.js"
import { Views } from "./views.js"
import { StoreWatch } from "./watch.js"

/**
 * Owner: SLOTS agent. Account registry in memory, provider/model registration (02 §3.6), pinned template capture
 * (02 §3.6a) and its diff against each fold's catalog (07 §4.4, `TemplateDiff`), `anthropic` activation and built-in
 * hiding (02 §8.4, §2.4.3), reconcile on registry change (02 §3.8), and the account-management RPCs
 * (`accounts.list/update/remove.*`).
 */

/** What the hot path needs about an own slot. Read synchronously from memory, never from disk. */
export interface SlotInfo {
  readonly providerID: Kind.ProviderID
  readonly kind: Kind.Own
  /** MVP: the single account of the slot (02 §2.2 R-ID-2). */
  readonly account: Account.Info
  readonly slot: Registry.Slot
  /** `Kind.meta[kind].canonical`; the slot-neutral identity value of D9 (`openai-compatible` for compat). */
  readonly canonical: string
  readonly retired: boolean
}

/** Input of {@link Api.createAccount}; the caller stored the secret under `id` first (persist-before-use). */
export interface NewAccount {
  readonly id: Account.ID
  readonly kind: Kind.Own
  readonly label: string
  readonly color?: Account.Color
  readonly identity: Account.Identity
  /** Absent = `{ type: "vault" }`. */
  readonly credential?: Credential.Ref
  readonly cacheDomain: { readonly scope: Registry.CacheDomainScope; readonly externalId?: string }
  readonly quotaDomain: { readonly scope: Registry.QuotaDomainScope; readonly externalId?: string }
  /** `compat` (required) and user-specified base URLs. */
  readonly baseURL?: string
  /** `compat` only: the user's model list (02 §3.3). */
  readonly compatModels?: ReadonlyArray<OwnAccounts.CompatModel>
  /** `compat` only: a local model and its format; `keyless` when added without a key (02 §3.3a). */
  readonly local?: { readonly format: Account.LocalFormat; readonly keyless?: true }
  readonly status?: Account.Status
  /** How the account was connected (`connection.method` in `accounts.list`). */
  readonly method?: Account.ConnectionMethod
}

/** Proposed compaction settings whose effect `impact` reports before (or while) they are stored (02 §4.7.5). */
export interface ImpactInput {
  /** Slots to look at. */
  readonly providerIDs: Iterable<string>
  /** Proposed `policy.compaction.byKind`; default: the current one. */
  readonly policy?: Compaction.ByKind
  /** Proposed account settings (`null` = back to the kind default); other accounts keep theirs. */
  readonly accounts?: ReadonlyMap<string, Compaction.Setting | null>
}

export type CreateResult =
  | { readonly ok: true; readonly account: Account.Info }
  | { readonly ok: false; readonly error: "template_unavailable"; readonly reason: string }

export interface Api extends Module.Lifecycle {
  /** The own slot of a provider id, or `undefined`: hooks must then leave the request untouched (02 §4.6). */
  slot(providerID: string): SlotInfo | undefined
  account(accountID: string): Account.Info | undefined
  /** The registry as last loaded (`start`) or reconciled (`store.changed`). */
  snapshot(): Registry.File
  /**
   * Changes `accounts.json` under the registry lock (`runtime.registry.update`), bumps `revision`, refreshes memory,
   * broadcasts `store.changed{store:"accounts"}` (every Location then reloads providers) and emits
   * `accounts.changed`. `change` returning `undefined` means no change.
   */
  mutate(change: (current: Registry.File) => Registry.File | undefined): Promise<Registry.File>
  /**
   * Creates cache domain, quota domain, account and slot (02 §3.2 step 4, §3.3) with a fresh `own-<kind>-<slug>`
   * and the kind's pinned template (captured from the latest catalog snapshot, else bundled). Throws when `id` is
   * already registered (a caller bug: re-logins update the existing account instead).
   */
  createAccount(input: NewAccount): Promise<CreateResult>
  /** `ctx.provider.transform` fold body. No I/O (02 §3.8): registry and detection state are already in memory. */
  transformProviders(editor: ProviderEditor): void
  /** `ctx.model.transform` fold body (reserved; slot models already come from pinned templates). */
  transformModels(editor: ModelEditor): void
  /** `ctx.provider.reload()` for this Location. */
  reload(): Promise<void>
  /**
   * A slot model as it registers now: its pinned template entry with the limit, cost, status and release date of the
   * fold's live catalog, `deprecated` (still enabled) when the catalog dropped it (`upstream: "missing"`, 07 §4.4).
   * `undefined` when the slot's template has no such model.
   */
  model(providerID: string, modelID: string): Registry.TemplateModel | undefined
  /** Every model of a slot as it registers now ({@link model}); empty for an unknown slot. */
  models(providerID: string): ReadonlyArray<Registry.TemplateModel>
  /**
   * A catalog provider's models as this Location's fold last saw them (`openai`, `anthropic`, …); forces one fold when
   * none was captured yet. Empty when the catalog has no such provider.
   */
  catalog(source: string): Promise<ReadonlyArray<Model.Info>>

  /**
   * `T_slot` of a model (02 §4.7.4 steps 1–5): own slots from their model as it registers ({@link model}) and
   * settings; `anthropic` and built-in providers are not ours and keep the v2 default of the window (`window`, else the
   * fold's catalog snapshot). `claude-agent` takes the kind default and the setting of the account the session's tree
   * runs on (`sessionID`; the default account without one, CAG-50). `undefined` when the window is unknown.
   */
  compaction(providerID: string, modelID: string, window?: number, sessionID?: string): Compaction.Resolved | undefined
  /** Core compaction settings of the own global config as last read (`keep` enters `T_floor`). */
  core(): CoreConfig.Values
  /** Re-reads the own global config; providers are re-registered when `keep` changed. */
  refreshCore(): Promise<CoreConfig.Values>
  /** Sessions of the given slots that would compact at their next step under the proposed settings. */
  impact(input: ImpactInput): Compaction.Impact
  /** Original windows of the models a kind's settings apply to (validation of `policy.compaction.byKind`). */
  windows(kind: Compaction.Tunable): ReadonlyMap<string, number>
  /** `accounts.list` `compaction` of a Claude Agent account (CAG-50): its setting over the route's models. */
  agentCompaction(accountID: string): Compaction.AccountView
  /**
   * A local model's running window, what a request needs and whether it fits (07 §6.2 #8): a model of the discovered
   * `ollama` or `lmstudio` provider, or of a `compat` slot whose server is Ollama. `undefined` for every other model.
   * Read on the control Location's discovery cadence; elsewhere an Ollama model stays `unknown`.
   */
  localWindow(providerID: string, modelID: string): Account.LocalWindow | undefined
  /** Asks a `compat` account's server for its family and output caps now and stores them (07 §6.2 #2, #7). */
  probeCompat(accountID: string): Promise<void>

  list: RpcTypes.Handler<"accounts.list">
  update: RpcTypes.Handler<"accounts.update">
  removePlan: RpcTypes.Handler<"accounts.remove.plan">
  removeExecute: RpcTypes.Handler<"accounts.remove.execute">
}

/** Kinds whose accounts may turn the balance/key poller off (02 §7.2). */
const POLL_BALANCE: ReadonlySet<Kind.Own> = new Set(["ds", "or", "xai"])

const COLORS = Account.Color.literals

const decodeSessionID = Schema.decodeUnknownOption(SessionID)

function effective(modelID: string, resolved: Compaction.Resolved): Compaction.Effective {
  return {
    modelID: Model.ID.make(modelID),
    windowTokens: resolved.windowTokens,
    triggerTokens: resolved.triggerTokens,
    source: resolved.source,
  }
}

/** Display metadata of `acc_claude_slot` before the user changes it (`label: null` = connection label, 02 §8.5). */
const CLAUDE_SLOT: Registry.ClaudeSlot = { accountID: "acc_claude_slot", label: null, shortLabel: "C", color: "orange" }

/** Session ids own's own requests to a compat or local server carry (`headersFor` records the injected hash). */
const PROBE_SESSION = "own-accounts:compat-probe"
const LOCAL_WINDOW_SESSION = "own-accounts:local-window"

/** Sessions whose last settled step is remembered for the overflow observation. */
const SETTLED_MAX = 20_000

interface Removal {
  readonly accountID: Account.ID
  readonly mode: "disable" | "delete"
}

/**
 * The Claude Agent route's models with their windows as the latest fold of any Location in this process saw them
 * (CAG-50). The provider lists them only where its own check ran (a project Location; the control Location, which
 * answers `accounts.list` and the settings, lists none), and the windows are the same for every Location. Each
 * Location loads its own copy of this module, so the snapshot lives under a registered symbol, as the provider's
 * observer channel does (claude-agent/agent.ts).
 */
const AGENT_MODELS = Symbol.for("own.accounts.claude-agent.models")
const agentModels = (() => {
  const scope = globalThis as {
    [AGENT_MODELS]?: { current?: ReadonlyMap<string, Model.Info>; signature?: string }
  }
  scope[AGENT_MODELS] ??= {}
  return scope[AGENT_MODELS]
})()

export function create(deps: Deps, peers: Module.Peers): Api {
  const log = deps.log.child("slots")
  const removals = new Nonces.Scope<Removal>(deps.clock)
  // Catalog providers as this instance's fold last saw them (02 §3.6a, kept per instance: ARCHITECTURE.md §12).
  const catalog = new Map<string, { readonly models: ReadonlyMap<string, Model.Info>; readonly takenAt: number }>()
  const state = {
    registry: Store.emptyRegistry(),
    policy: Policy.defaults as Policy.File,
    slots: new Map<string, SlotInfo>(),
    hidden: [] as ReadonlyArray<string>,
    stops: [] as Array<() => void>,
    /** accountID → time of its latest ledger line in this process (`accounts.list` `lastUsedAt`, 02 §9.2). */
    lastStep: new Map<string, number>(),
    core: CoreConfig.UNKNOWN,
  }

  const keep = () => state.core.keepTokens ?? Compaction.KEEP_TOKENS

  // Discovered local providers as this instance's fold last saw them (07 §6.2 #8).
  const discovered = new Map<string, LocalWindow.Target>()
  // Per session, the provider answer its last settled step left (overflow observation, 07 §6.2 #2).
  const settled = new Map<string, LastResponse.Capture | undefined>()
  const probes = { controller: new AbortController(), pending: new Set<Promise<void>>() }
  // Template diff writes (07 §4.4), one after another; `stop` awaits the last.
  const templates = { chain: Promise.resolve() }

  /** The account's auth headers for a request own sends to its server itself; none when they cannot be had. */
  const headersOf = async (account: Account.Info, sessionID: string) => {
    const auth = await peers().logins.headers(account, sessionID)
    return auth.ok ? auth.headers : {}
  }

  /** `compat` slots whose server is Ollama: their running windows are read like the discovered `ollama` (6.2 #8). */
  const compatTargets = () =>
    [...state.slots.values()].flatMap((info): LocalWindow.Target[] => {
      const baseURL = info.slot.baseURL
      if (info.kind !== "compat" || info.retired || info.account.compat?.server?.family !== "ollama" || !baseURL)
        return []
      return [
        {
          providerID: info.providerID,
          accountID: info.account.id,
          source: { type: "ollama", baseURL, headers: () => headersOf(info.account, LOCAL_WINDOW_SESSION) },
          models: modelsOf(info.slot).map(localModel),
        },
      ]
    })

  const local = LocalWindow.create({
    clock: deps.clock,
    log: log.child("local-window"),
    targets: () => [...discovered.values(), ...compatTargets()],
    keep,
    alert: (alert) => peers().telemetry.alert(alert),
    ollamaContextLength: positiveInt(process.env.OLLAMA_CONTEXT_LENGTH),
  })

  const probeCompat = async (accountID: string) => {
    const info = state.slots.get(state.registry.accounts.find((item) => item.id === accountID)?.providerID ?? "")
    const baseURL = info?.slot.baseURL
    if (!info || info.kind !== "compat" || info.retired || !baseURL) return
    const result = await CompatProbe.run({
      baseURL,
      headers: await headersOf(info.account, PROBE_SESSION),
      models: modelsOf(info.slot).map((model) => model.id),
      signal: probes.controller.signal,
    })
    if (!result || probes.controller.signal.aborted) return
    log.info("compat_server_read", { accountID, family: result.family, outputs: result.outputs.size })
    await mutate((current) => CompatProbe.apply(current, accountID, result))
  }

  /** {@link probeCompat} in the background; `stop` aborts and awaits it. */
  const probeLater = (accountID: string) => {
    const pending: Promise<void> = probeCompat(accountID)
      .catch((error: unknown) => log.warn("compat_probe_failed", { accountID, error }))
      .finally(() => probes.pending.delete(pending))
    probes.pending.add(pending)
  }

  /**
   * Core started an automatic compaction right after a `compat` server answered an error, with no step settled and no
   * retry scheduled in between: core classified that error as a context overflow and recovers from it (07 §6.2 #2,
   * PG9), so the account's card drops its warning. Core never retries an overflow, and every other compaction follows
   * a settled step.
   */
  const overflowRecovered = async (sessionID: string) => {
    const capture = deps.runtime.lastResponse.get(sessionID)
    const info = capture && state.slots.get(capture.providerID)
    if (!capture || !info || info.kind !== "compat" || (capture.status ?? 0) < 400) return
    if (capture === settled.get(sessionID) || info.account.compat?.server?.overflowClassified) return
    log.info("compat_overflow_classified", { accountID: info.account.id, status: capture.status })
    await mutate((current) => CompatProbe.classified(current, info.account.id))
  }

  const settle = (sessionID: string) => {
    settled.delete(sessionID)
    settled.set(sessionID, deps.runtime.lastResponse.get(sessionID))
    if (settled.size > SETTLED_MAX) settled.delete(settled.keys().next().value ?? "")
  }

  /** Slot definitions with the catalog this instance's fold last saw (07 §4.4). */
  const definitions = () =>
    Registration.definitions(
      state.registry,
      deps.endpoints,
      { policy: state.policy.compaction?.byKind, keep: keep() },
      catalog,
      servedRows(),
    )

  /** The served Codex rows of the shared list (10 §6.14): models no catalog lists yet register from them. */
  const servedRows = () => {
    const snapshot = CodexMeta.current()
    return snapshot?.source === "backend" ? (snapshot.harness ?? []) : []
  }

  /** A slot's models registered from served rows ({@link Registration.served}). */
  const servedOf = (slot: Registry.Slot) => {
    const template = state.registry.modelTemplates[slot.modelTemplate]
    return template ? Registration.served(slot.kind, template, catalog, servedRows()) : []
  }

  /** A slot's models as they register now (07 §4.4), served ones included (10 §6.14). */
  const modelsOf = (slot: Registry.Slot | undefined) => {
    if (!slot) return []
    return [...(state.registry.modelTemplates[slot.modelTemplate]?.models ?? []), ...servedOf(slot)].map((model) =>
      Registration.current(slot.kind, model, catalog),
    )
  }

  /**
   * Writes the lasting template diff of the catalog this instance's fold last saw (07 §4.4), recomputed on the current
   * file under the registry lock, and raises `template_update_available` once per new fixed-field change. The commit
   * reloads every Location, whose next fold registers the result.
   */
  const writeTemplates = async () => {
    const at = iso(deps.clock.now())
    const outcome = { applied: [] as ReadonlyArray<TemplateDiff.Applied> }
    await mutate((current) => {
      const reconciled = TemplateDiff.reconcile(current, catalog, at)
      outcome.applied = reconciled?.applied ?? []
      return reconciled?.registry
    })
    for (const applied of outcome.applied) {
      log.info("template_diff_applied", { ...applied, update: applied.update?.join(",") })
      if (applied.update)
        peers().telemetry.alert({
          code: "template_update_available",
          severity: "info",
          subject: `${applied.templateID}:${applied.update.join(",")}`,
          message: `${Registration.KIND_NAMES[applied.kind]} 모델 템플릿의 고정 항목(${applied.update.join(", ")})이 카탈로그에서 바뀌었습니다. 계정 카드의 '템플릿 갱신 있음'에서 적용합니다.`,
        })
    }
  }

  const rebuild = () => {
    // The fold builds the definitions from the catalog it sees; problems are reported once per registry change.
    for (const problem of definitions().problems) log.error("slot_unregistrable", { ...problem })
    state.slots = new Map(
      Object.entries(state.registry.slots).flatMap(([id, slot]): Array<[string, SlotInfo]> => {
        const account = Registration.accountOf(state.registry, slot)
        if (!account) return []
        const providerID = Kind.ProviderID.make(id)
        return [
          [
            id,
            {
              providerID,
              kind: slot.kind,
              account,
              slot,
              canonical: Kind.meta[slot.kind].canonical,
              retired: slot.retired === true || account.status === "retired",
            },
          ],
        ]
      }),
    )
    state.hidden = Registration.hiddenBuiltins(state.registry, state.policy.hideBuiltinProviders)
  }

  /** Adopts a registry value if it is not older than memory (a racing read can hand back an older file). */
  const adopt = (registry: Registry.File) => {
    if (registry !== state.registry && registry.revision >= state.registry.revision) {
      state.registry = registry
      rebuild()
    }
  }

  const reload = () =>
    Promise.resolve()
      .then(() => deps.ctx.provider.reload())
      .catch((error: unknown) => log.error("provider_reload_failed", { error }))

  const onAccountsChanged = async () => {
    const cached = deps.runtime.registry.cached()
    adopt(cached ?? (await deps.runtime.registry.read()))
    await reload()
    await deps.emitter.global("accounts.changed", { revision: state.registry.revision })
  }

  const onPolicyChanged = async () => {
    const policy = deps.runtime.policy.cached() ?? (await deps.runtime.policy.read())
    state.policy = policy
    // `policy.set{compaction.keepTokens}` writes the config file, then announces a policy change.
    state.core = await readCore()
    rebuild()
    await reload()
  }

  const readCore = () =>
    CoreConfig.read(process.env.OPENCODE_CONFIG_DIR || undefined).catch((error: unknown) => {
      log.warn("core_config_unreadable", { error })
      return CoreConfig.UNKNOWN
    })

  /** `T_slot` of an own slot model under optional proposed settings. */
  const ownThreshold = (
    info: SlotInfo,
    modelID: string,
    proposed: { readonly policy?: Compaction.ByKind; readonly account?: Compaction.Setting | null } = {},
  ) => {
    const model = modelsOf(info.slot).find((item) => item.id === modelID)
    if (!model) return undefined
    const account = "account" in proposed ? { compaction: proposed.account } : info.account
    return Registration.threshold(info.kind, account, model, {
      policy: "policy" in proposed ? proposed.policy : state.policy.compaction?.byKind,
      keep: keep(),
    })
  }

  /** `accounts.list` `compaction` of an own account (02 §9.2). */
  const compactionView = (info: Account.Info): Compaction.AccountView => ({
    setting: info.compaction ?? null,
    effective: modelsOf(state.registry.slots[info.providerID]).flatMap((model) => {
      const resolved = Registration.threshold(info.kind, info, model, {
        policy: state.policy.compaction?.byKind,
        keep: keep(),
      })
      return resolved ? [effective(model.id, resolved)] : []
    }),
  })

  /**
   * `T_slot` of a Claude Agent model for an account (CAG-50): the kind default (`policy.compaction.byKind`) and the
   * account's setting over the window Claude Code reported for the route's model (`window` when given), with optional
   * proposed settings as in {@link ownThreshold}. Core keeps its own ceiling for the route (one provider serves every
   * account), so own-accounts enforces an earlier one per conversation (switching/compaction.ts).
   */
  const agentThreshold = (
    modelID: string,
    accountID: string | undefined,
    window?: number,
    proposed: { readonly policy?: Compaction.ByKind; readonly account?: Compaction.Setting | null } = {},
  ) => {
    const limit =
      window === undefined ? agentModels.current?.get(modelID)?.limit : { context: window }
    if (!limit) return undefined
    // On an SSH host the accounts and their settings are the mirror's (02 §8.10.13): `entry` reads either.
    const stored = accountID === undefined ? undefined : peers().claudeAgent.entry(accountID)?.compaction
    return Compaction.resolve(
      Compaction.chain({
        kind: "claude-agent",
        modelID,
        policy: "policy" in proposed ? proposed.policy : state.policy.compaction?.byKind,
        account: "account" in proposed ? proposed.account : stored,
      }),
      limit,
      keep(),
      "claude-agent",
    )
  }

  /** `accounts.list` `compaction` of a Claude Agent account (CAG-50). */
  const agentCompaction = (accountID: string): Compaction.AccountView => ({
    setting: peers().claudeAgent.entry(accountID)?.compaction ?? null,
    effective: [...(agentModels.current?.keys() ?? [])].flatMap((modelID) => {
      const resolved = agentThreshold(modelID, accountID)
      return resolved ? [effective(modelID, resolved)] : []
    }),
  })

  /** The Claude slot: v2 defaults over the `anthropic` catalog models the fold saw. */
  const claudeCompaction = (): Compaction.AccountView => ({
    setting: null,
    effective: [...(catalog.get(Provider.ID.anthropic)?.models.values() ?? [])].flatMap((model) => {
      const resolved = Compaction.resolve(
        Compaction.chain({ kind: "claude-sub", modelID: model.id }),
        model.limit,
        keep(),
      )
      return resolved ? [effective(model.id, resolved)] : []
    }),
  })

  const impact = (input: ImpactInput): Compaction.Impact => {
    const K = keep()
    const sessions = [...new Set(input.providerIDs)].flatMap((providerID) => {
      if (providerID === ClaudeAgent.PROVIDER_ID) return agentImpact(input, K)
      const info = state.slots.get(providerID)
      if (!info || info.retired) return []
      const proposed = {
        ...(input.policy === undefined ? {} : { policy: input.policy }),
        ...(input.accounts?.has(info.account.id) ? { account: input.accounts.get(info.account.id) ?? null } : {}),
      }
      return deps.runtime.sessions.list({ providerID }).flatMap((entry) => {
        const sessionID = Option.getOrUndefined(decodeSessionID(entry.sessionID))
        const resolved = entry.modelID === null ? undefined : ownThreshold(info, entry.modelID, proposed)
        if (!sessionID || !resolved || entry.P === null || entry.P < resolved.triggerTokens) return []
        return [
          {
            sessionID,
            P: entry.P,
            triggerTokens: resolved.triggerTokens,
            truncates: Compaction.truncates(entry.P, resolved.triggerTokens, K),
            ...(entry.revertStaged ? { revertStaged: true } : {}),
          },
        ]
      })
    })
    return { sessions }
  }

  /** Claude Agent conversations that would compact at their next step under the proposed settings (CAG-50). */
  const agentImpact = (input: ImpactInput, K: number) =>
    deps.runtime.sessions.list({ providerID: ClaudeAgent.PROVIDER_ID }).flatMap((entry) => {
      const sessionID = Option.getOrUndefined(decodeSessionID(entry.sessionID))
      const accountID = peers().claudeAgent.peek(entry.sessionID)
      const proposed = {
        ...(input.policy === undefined ? {} : { policy: input.policy }),
        ...(accountID !== undefined && input.accounts?.has(accountID)
          ? { account: input.accounts.get(accountID) ?? null }
          : {}),
      }
      const resolved =
        entry.modelID === null ? undefined : agentThreshold(entry.modelID, accountID, undefined, proposed)
      if (!sessionID || !resolved || entry.P === null || entry.P < resolved.triggerTokens) return []
      return [
        {
          sessionID,
          P: entry.P,
          triggerTokens: resolved.triggerTokens,
          truncates: Compaction.truncates(entry.P, resolved.triggerTokens, K),
          ...(entry.revertStaged ? { revertStaged: true } : {}),
        },
      ]
    })

  /** modelID → original window of every live slot model of a kind (compat: every compat slot's own models). */
  const windows = (kind: Compaction.Tunable) =>
    kind === "claude-agent"
      ? new Map<string, number>(
          [...(agentModels.current?.values() ?? [])].map((model) => [
            model.id,
            Compaction.windowOf(model.limit),
          ]),
        )
      : new Map<string, number>(
          [...state.slots.values()]
            .filter((info) => info.kind === kind && !info.retired)
            .flatMap((info) => modelsOf(info.slot))
            .map((model) => [model.id, Compaction.windowOf(model.limit)]),
        )

  const templateWindows = (info: Account.Info) =>
    new Map<string, number>(
      modelsOf(state.registry.slots[info.providerID]).map((model) => [model.id, Compaction.windowOf(model.limit)]),
    )

  const mutate = async (change: (current: Registry.File) => Registry.File | undefined) => {
    const outcome = { changed: false }
    const next = await deps.runtime.registry.update((current) => {
      const result = change(current)
      outcome.changed = result !== undefined && result !== current
      return result
    })
    adopt(next)
    if (outcome.changed)
      deps.runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local", revision: next.revision })
    return next
  }

  /** Fold snapshot of a catalog provider; forces this Location's fold once when none was captured yet. */
  const snapshotOf = async (source: string) => {
    if (!catalog.has(source))
      await Promise.resolve()
        .then(() => deps.ctx.provider.list())
        .catch(() => undefined)
    return catalog.get(source)
  }

  /** The kind's template built now: fold snapshot first, bundled fallback second (02 §3.6a rules 2–3). */
  const buildTemplate = async (kind: Templates.CatalogKind, at: string): Promise<Templates.Built> => {
    const snapshot = await snapshotOf(Templates.SOURCE[kind])
    const built = snapshot ? Templates.fromCatalog(kind, snapshot.models.values(), at) : undefined
    if (built?.ok) {
      if (built.dropped.length > 0)
        peers().telemetry.alert({
          code: "template_cost_missing",
          severity: "warning",
          message: `${built.dropped.length} ${kind} model(s) without a price were not registered: ${built.dropped.join(", ")}`,
        })
      return built
    }
    log.warn("template_snapshot_unusable", { kind, reason: built?.reason ?? "no_snapshot" })
    const template = await Templates.bundled(kind)
    return template ? { ok: true, template, dropped: [] } : { ok: false, reason: "bundled_missing" }
  }

  const createAccount = async (input: NewAccount): Promise<CreateResult> => {
    const now = deps.clock.now()
    const at = iso(now)
    const kind = input.kind
    // A new template only when the kind has none yet: every slot of a kind shares one (02 §2.4.2).
    const prepared =
      kind === "compat"
        ? Templates.fromCompat(input.compatModels ?? [], at, input.local)
        : Templates.current(state.registry, kind)
          ? undefined
          : await buildTemplate(kind, at)
    if (prepared && !prepared.ok) return { ok: false, error: "template_unavailable", reason: prepared.reason }
    const created = { account: undefined as Account.Info | undefined, missing: false }
    await mutate((current) => {
      if (current.accounts.some((account) => account.id === input.id))
        throw new Error(`account ${input.id} is already registered`)
      const shared = kind === "compat" ? undefined : Templates.current(current, kind)
      const template = shared ? undefined : prepared?.ok ? prepared.template : undefined
      if (!shared && !template) {
        created.missing = true
        return undefined
      }
      const templateID = shared ? OwnID.TemplateID.make(shared) : Templates.newID(kind, now, current.modelTemplates)
      const providerID = freshProviderID(current, kind)
      const slug = Kind.ProviderID.parse(providerID)?.slug ?? providerID
      const cacheDomain = domainID(current.cacheDomains, "cd_", slug, kind, input.cacheDomain)
      const quotaDomain = domainID(current.quotaDomains, "qd_", slug, kind, input.quotaDomain)
      const cacheDomainID = OwnID.CacheDomainID.make(cacheDomain.id)
      const quotaDomainID = OwnID.QuotaDomainID.make(quotaDomain.id)
      const billing = Kind.meta[kind].billing
      const account: Account.Info = {
        id: input.id,
        kind,
        label: input.label,
        shortLabel: shortLabel(input.label),
        color: input.color ?? nextColor(current),
        providerID,
        cacheDomain: cacheDomainID,
        quotaDomain: quotaDomainID,
        billing,
        identity: input.identity,
        autoSwitch: billing !== "subscription",
        budget: null,
        status: input.status ?? "ready",
        createdAt: at,
        lastVerifiedAt: at,
        pollBalance: POLL_BALANCE.has(kind) ? true : null,
        ...(input.credential && input.credential.type !== "vault" ? { credential: input.credential } : {}),
        ...(input.method === undefined ? {} : { method: input.method }),
        // 07 §6.2 #7: each model's output cap with its source until the server is asked; 02 §3.3: the add form's
        // image input and tools settings (models left on `auto` store none).
        ...(kind === "compat" ? { compat: compatOf(input.compatModels ?? [], input.local) } : {}),
      }
      const slot: Registry.Slot = {
        kind,
        accounts: [input.id],
        pooling: "off",
        modelTemplate: templateID,
        ...(kind === "codex" ? { transport: "websocket" as const } : {}),
        ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
      }
      created.account = account
      return {
        ...current,
        cacheDomains: cacheDomain.created
          ? { ...current.cacheDomains, [cacheDomainID]: { kind, ...input.cacheDomain, poolingVerified: false } }
          : current.cacheDomains,
        quotaDomains: quotaDomain.created
          ? { ...current.quotaDomains, [quotaDomainID]: { kind, ...input.quotaDomain } }
          : current.quotaDomains,
        accounts: [...current.accounts, account],
        slots: { ...current.slots, [providerID]: slot },
        modelTemplates: template ? { ...current.modelTemplates, [templateID]: template } : current.modelTemplates,
      }
    })
    if (created.missing || !created.account)
      return { ok: false, error: "template_unavailable", reason: "template_changed_concurrently" }
    log.info("account_created", { accountID: created.account.id, providerID: created.account.providerID, kind })
    // The server's family and output caps arrive with a later `accounts.changed` (07 §6.2 #2, #7).
    if (kind === "compat") probeLater(created.account.id)
    return { ok: true, account: created.account }
  }

  const views = () => {
    const limits = deps.runtime.limits
    const sessions = deps.runtime.sessions
    const accounts = state.registry.accounts.map((info) => {
      const view = Views.account(
        state.registry,
        info,
        limits.list({ accountID: info.id }),
        state.lastStep.get(info.id),
        {
          sessions: sessions.counts(info.providerID),
          compaction: compactionView(info),
          now: deps.clock.now(),
          served: (() => {
            const slot = state.registry.slots[info.providerID]
            return slot ? servedOf(slot).map((model) => model.id) : []
          })(),
        },
      )
      if (info.kind !== "compat") return view
      const compat = CompatProbe.view(info, modelsOf(state.registry.slots[info.providerID]), (modelID) =>
        local.get(info.providerID, modelID),
      )
      return { ...view, compat }
    })
    // Every Claude subscription account (02 §8.7): the slot's own and the added ones, while claude-auth is installed.
    const slot = peers().plugins.claudeSlot()
    const claude = slot.detected
      ? peers().claude.views(slot, {
          windows: (accountID) => limits.list({ accountID }),
          compaction: claudeCompaction(),
          summary: (windows) => Views.summary(windows, deps.clock.now()),
        })
      : []
    // The Claude Agent route's account (02 §8.10).
    const agent = peers().claudeAgent.views({
      windows: (accountID) => limits.list({ accountID }),
      compaction: agentCompaction,
      lastUsed: (accountID) => state.lastStep.get(accountID),
      summary: (windows) => Views.summary(windows, deps.clock.now()),
    })
    return [...accounts, ...claude, ...agent]
  }

  const viewOf = (accountID: string) => views().find((view) => view.id === accountID)

  /**
   * The Claude slot rule of the fold (02 §8.4, 04 §8.11.4.3). A failing peer must not cost the fold its own slots, so
   * an error here only keeps `anthropic` disabled (fail closed).
   */
  const claudeSlotMode = (): Registration.FoldInput["claudeSlot"] => {
    try {
      const claude = peers().plugins.claudeSlot()
      if (!claude.detected || !claude.verified) return "off"
      return deps.remote ? "remote" : "plugin"
    } catch (error) {
      log.error("claude_slot_unknown", { error })
      return "off"
    }
  }

  return {
    start: async () => {
      // Another Location's instance usually read both files already; the store watcher keeps that copy current.
      state.policy =
        deps.runtime.policy.cached() ??
        (await deps.runtime.policy.read().catch((error: unknown) => {
          log.error("policy_unreadable", { error })
          return Policy.defaults
        }))
      // An unusable accounts.json is never overwritten (Store.StoreError); run without slots and report it.
      state.registry =
        deps.runtime.registry.cached() ??
        (await deps.runtime.registry.read().catch((error: unknown) => {
          log.error("registry_unreadable", { error })
          return Store.emptyRegistry()
        }))
      state.core = await readCore()
      rebuild()
      const broadcast = deps.runtime.broadcast
      state.stops.push(
        broadcast.on("store.changed", (payload) => {
          const run =
            payload.store === "accounts" ? onAccountsChanged : payload.store === "policy" ? onPolicyChanged : undefined
          void run?.().catch((error: unknown) => log.error("reconcile_failed", { store: payload.store, error }))
        }),
        broadcast.on("claudeSlot.changed", () => void reload()),
        broadcast.on("ledger.line", (payload) => {
          const accountID = payload.line.accountID
          if (accountID !== null && payload.line.ts > (state.lastStep.get(accountID) ?? -1))
            state.lastStep.set(accountID, payload.line.ts)
        }),
        StoreWatch.start(deps),
      )
      log.info("registry_loaded", { revision: state.registry.revision, slots: state.slots.size })
      // Local servers are read once per process, by the Location that answers the global RPCs (07 §6.2 #2, #8).
      if (!deps.location.control) return
      local.start()
      const unread = [...state.slots.values()].filter(
        (info) =>
          info.kind === "compat" &&
          !info.retired &&
          CompatProbe.due(
            info.account,
            modelsOf(info.slot).map((model) => model.id),
          ),
      )
      unread.forEach((info) => probeLater(info.account.id))
      // 02 §3.3a: a `기타 OpenAI 호환` account on this PC or the local network without rates is a local model.
      const migrating = [...state.slots.values()].filter((info) =>
        CompatProbe.migratable(info.account, info.slot, modelsOf(info.slot)),
      )
      if (migrating.length > 0)
        void mutate((current) =>
          migrating.reduce<Registry.File | undefined>(
            (registry, info) =>
              CompatProbe.localize(registry ?? current, info.account.id, {
                format: info.account.compat?.server?.family === "ollama" ? "ollama" : "chat",
              }) ?? registry,
            undefined,
          ),
        )
          .then(() => log.info("compat_made_local", { accounts: migrating.map((info) => info.account.id) }))
          .catch((error: unknown) => log.warn("compat_local_failed", { error }))
    },
    stop: async () => {
      for (const stop of state.stops.splice(0)) stop()
      probes.controller.abort()
      await Promise.all([local.stop(), ...probes.pending, templates.chain])
    },
    onEvent: (event, meta) => {
      local.observe(event)
      if (!meta.local) return
      if (event.type === "session.step.ended" || event.type === "session.step.failed") settle(event.data.sessionID)
      if (event.type === "session.retry.scheduled") settle(event.data.sessionID)
      if (event.type === "session.deleted") settled.delete(event.data.sessionID)
      if (event.type === "session.compaction.started" && event.data.reason === "auto")
        return overflowRecovered(event.data.sessionID)
    },
    slot: (providerID) => state.slots.get(providerID),
    account: (accountID) => state.registry.accounts.find((account) => account.id === accountID),
    snapshot: () => state.registry,
    mutate,
    createAccount,
    transformProviders: (editor) => {
      const takenAt = deps.clock.now()
      for (const source of Templates.SOURCES) {
        const record = editor.get(source)
        if (record) catalog.set(source, { models: record.models, takenAt })
      }
      // The Claude Agent route's models with the windows Claude Code reported: its compaction (CAG-50).
      const agent = editor.get(ClaudeAgent.PROVIDER_ID)
      if (agent && agent.models.size > 0) {
        // CAM-2: the accounts' rows (`accounts.list` `compaction`) show these windows; a client lists them again only
        // on `accounts.changed`, so the first list of the process (the control Location folds none) and every change
        // (the login check's windows after the saved ones, a new alias, a turn's window) is announced; before, the rows
        // kept whatever the first list a client read held.
        const signature = [...agent.models.values()]
          .map((model) => `${model.id}\u0000${model.name}\u0000${Compaction.windowOf(model.limit)}`)
          .join("\u0001")
        const changed = agentModels.signature !== signature
        agentModels.current = agent.models
        agentModels.signature = signature
        if (changed)
          void deps.emitter
            .global("accounts.changed", { revision: state.registry.revision })
            .catch((error: unknown) => log.warn("agent_models_announce_failed", { error }))
      }
      for (const providerID of Preset.LOCAL_PROVIDERS) {
        const target = localTarget(providerID, editor.get(providerID))
        if (target) discovered.set(providerID, target)
        if (!target) discovered.delete(providerID)
      }
      // Limits, prices, status and release dates follow the catalog just captured (07 §4.4). A slot this catalog cannot
      // build is left out of this fold only; the other slots still register.
      const built = definitions()
      for (const problem of built.problems)
        if (problem.reason === "definition_failed") log.error("slot_fold_failed", { ...problem })
      Registration.apply(editor, {
        definitions: built.definitions,
        hidden: state.hidden,
        claudeSlot: claudeSlotMode(),
      })
      // 07 §4.4: the template diff is a pure check here; what lasts is written after the fold. One writer per PC (the
      // control Location), so two Locations folding different catalog revisions never undo each other's marks; a
      // remote service only mirrors this PC's registry.
      if (!deps.location.control || deps.remote || !TemplateDiff.reconcile(state.registry, catalog, iso(takenAt)))
        return
      templates.chain = templates.chain
        .then(writeTemplates)
        .catch((error: unknown) => log.error("template_diff_failed", { error }))
    },
    transformModels: () => {},
    reload,
    model: (providerID, modelID) => modelsOf(state.registry.slots[providerID]).find((model) => model.id === modelID),
    models: (providerID) => modelsOf(state.registry.slots[providerID]),
    catalog: async (source) => [...((await snapshotOf(source))?.models.values() ?? [])],

    compaction: (providerID, modelID, window, sessionID) => {
      const info = state.slots.get(providerID)
      if (info) return ownThreshold(info, modelID)
      if (providerID === ClaudeAgent.PROVIDER_ID)
        return agentThreshold(modelID, peers().claudeAgent.peek(sessionID), window)
      const limit = window === undefined ? catalog.get(providerID)?.models.get(modelID)?.limit : { context: window }
      if (!limit) return undefined
      return Compaction.resolve(Compaction.chain({ kind: "claude-sub", modelID }), limit, keep())
    },
    core: () => state.core,
    refreshCore: async () => {
      const before = keep()
      state.core = await readCore()
      if (keep() !== before) {
        rebuild()
        await reload()
      }
      return state.core
    },
    impact,
    windows,
    agentCompaction,
    localWindow: (providerID, modelID) => local.get(providerID, modelID),
    probeCompat,

    list: async () => ({ revision: state.registry.revision, accounts: views() }),

    update: async (input, context) => {
      // A Claude Agent account's auto-compaction (CAG-50, 02 §8.10.5): on its own, checked against the route's windows.
      const agent = (state.registry.claudeAgents ?? []).find((item) => item.accountID === input.accountID)
      if (agent && input.compaction !== undefined) {
        const other = Object.entries(input).find(
          (entry) => entry[1] !== undefined && !["accountID", "compaction", "dryRun"].includes(entry[0]),
        )
        if (other)
          return context.error("policy_denied", `${other[0]} is changed apart from compaction`, { field: other[0] })
        const requested = input.compaction
        const problem =
          requested === null
            ? undefined
            : Compaction.check(requested, windows("claude-agent"), { keep: keep(), prefix: "compaction." })
        if (problem) return context.error("setting_out_of_range", `${problem.field} is out of range`, problem)
        const setting = requested === null ? null : Compaction.normalize(requested)
        const compactionImpact = impact({
          providerIDs: [ClaudeAgent.PROVIDER_ID],
          accounts: new Map([[agent.accountID, setting]]),
        })
        if (!input.dryRun)
          await mutate((current) => ({
            ...current,
            claudeAgents: (current.claudeAgents ?? []).map((item) => {
              if (item.accountID !== agent.accountID) return item
              const { compaction: _previous, ...rest } = item
              return setting === null ? rest : { ...rest, compaction: setting }
            }),
          }))
        const view = viewOf(agent.accountID)
        if (!view) return context.error("account_not_found", "the account was removed", { accountID: agent.accountID })
        return { account: view, compactionImpact }
      }
      const added = (state.registry.claudeAccounts ?? []).some((item) => item.accountID === input.accountID)
      if (input.accountID === Account.ID.claudeSlot || added) {
        if (!peers().plugins.claudeSlot().detected)
          return context.error("account_not_found", "the Claude slot is not installed", { accountID: input.accountID })
        const denied = deniedClaudeField(input)
        if (denied)
          return context.error("policy_denied", `${denied} cannot be changed for the Claude slot`, { field: denied })
        const display = {
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.shortLabel === undefined ? {} : { shortLabel: input.shortLabel }),
          ...(input.color === undefined ? {} : { color: input.color }),
        }
        // `라벨 바꾸기` of any Claude account (02 §8.7): the slot's own in `claudeSlot`, the others in `claudeAccounts`.
        await mutate((current) =>
          input.accountID === Account.ID.claudeSlot
            ? { ...current, claudeSlot: { ...(current.claudeSlot ?? CLAUDE_SLOT), ...display } }
            : {
                ...current,
                claudeAccounts: (current.claudeAccounts ?? []).map((item) =>
                  item.accountID === input.accountID ? { ...item, ...display } : item,
                ),
              },
        )
        const claude = viewOf(input.accountID)
        if (!claude)
          return context.error("account_not_found", "the Claude slot is not installed", { accountID: input.accountID })
        return { account: claude }
      }
      // `이름 바꾸기` of a Claude Agent account (PF 2026-11-03, 02 §8.10): its name, short name and color in
      // `claudeAgents`, as for the Claude subscription's accounts; its folder and its login stay as they are.
      if ((state.registry.claudeAgents ?? []).some((item) => item.accountID === input.accountID)) {
        const denied = deniedClaudeField(input)
        if (denied)
          return context.error("policy_denied", `${denied} cannot be changed for a Claude Agent account`, {
            field: denied,
          })
        await mutate((current) => ({
          ...current,
          claudeAgents: (current.claudeAgents ?? []).map((item) =>
            item.accountID === input.accountID
              ? {
                  ...item,
                  ...(input.label === undefined ? {} : { label: input.label }),
                  ...(input.shortLabel === undefined ? {} : { shortLabel: input.shortLabel }),
                  ...(input.color === undefined ? {} : { color: input.color }),
                }
              : item,
          ),
        }))
        const agent = viewOf(input.accountID)
        if (!agent) return context.error("account_not_found", "no such account", { accountID: input.accountID })
        return { account: agent }
      }
      const account = state.registry.accounts.find((item) => item.id === input.accountID)
      if (!account || account.status === "retired")
        return context.error("account_not_found", "no such account", { accountID: input.accountID })
      const denied = deniedField(account, input)
      if (denied) return context.error("policy_denied", `${denied} is not allowed for this account`, { field: denied })
      // 02 §3.3: image input and tools of the account's models, checked against its template before anything is stored.
      const capabilities = input.compatCapabilities
      const configured = capabilities && CompatProbe.configure(state.registry, account.id, capabilities)
      if (configured && !configured.ok)
        return context.error("policy_denied", `no model ${configured.unknown.join(", ")} on this account`, {
          field: "compatCapabilities",
        })
      // Auto-compaction (02 §4.7.3–4.7.5): validated against the account's template, impact before anything is stored.
      const requested = input.compaction
      const problem =
        requested === undefined || requested === null
          ? undefined
          : Compaction.check(requested, templateWindows(account), { keep: keep(), prefix: "compaction." })
      if (problem) return context.error("setting_out_of_range", `${problem.field} is out of range`, problem)
      const setting = requested === undefined ? undefined : requested === null ? null : Compaction.normalize(requested)
      const compactionImpact =
        setting === undefined
          ? undefined
          : impact({ providerIDs: [account.providerID], accounts: new Map([[account.id, setting]]) })
      if (input.dryRun && compactionImpact !== undefined) {
        const unchanged = viewOf(account.id)
        if (!unchanged) return context.error("account_not_found", "the account was removed", { accountID: account.id })
        return { account: unchanged, compactionImpact }
      }
      if (input.replaceKey !== undefined) {
        const replaced = await peers().logins.replaceKey(account, input.replaceKey)
        if (!replaced.ok) {
          if (replaced.error === "vault_unavailable") return context.error("vault_unavailable", replaced.message, {})
          return context.error("probe_failed", replaced.message, {
            message: replaced.message,
            ...(replaced.status === undefined ? {} : { status: replaced.status }),
          })
        }
        await mutate((current) =>
          withAccount(current, account.id, (item) => ({
            ...item,
            identity: { ...item.identity, ...known(replaced.detected), keyHint: replaced.keyHint },
            // 02 §3.3a: a local model added without a key sends this one from now on.
            ...(item.compat?.local?.keyless
              ? { compat: { ...item.compat, local: { format: item.compat.local.format } } }
              : {}),
            status: item.status === "auth_failed" || item.status === "needs_reauth" ? "ready" : item.status,
            lastVerifiedAt: iso(deps.clock.now()),
          })),
        )
      }
      if (input.refreshCatalog && account.kind !== "compat") {
        const kind = account.kind
        const built = await buildTemplate(kind, iso(deps.clock.now()))
        if (!built.ok)
          return context.error("template_unavailable", "no catalog or bundled template", { kind, reason: built.reason })
        // The new capture has no `update` (07 §4.4: the user applied it); marks carry over from the template it replaces.
        await mutate((current) =>
          refreshTemplate(
            current,
            kind,
            TemplateDiff.carry(current.modelTemplates[Templates.current(current, kind) ?? ""], built.template),
            deps.clock.now(),
          ),
        )
      }
      // 02 §3.3a `로컬 모델로 바꾸기`: the format's package and variants re-register the slot's models.
      const local = input.local
      if (local !== undefined) await mutate((current) => CompatProbe.localize(current, account.id, local))
      // Recomputed on the current file under the registry lock; a capability change re-registers the slot's models.
      if (capabilities)
        await mutate((current) => {
          const next = CompatProbe.configure(current, account.id, capabilities)
          return next.ok ? next.registry : undefined
        })
      const patch = {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.shortLabel === undefined ? {} : { shortLabel: input.shortLabel }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.autoSwitch === undefined ? {} : { autoSwitch: input.autoSwitch }),
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        ...(input.pollBalance === undefined ? {} : { pollBalance: input.pollBalance }),
        // 04 §8.9: `deny` makes the local broker refuse this account to every SSH host (`account_not_remote`).
        ...(input.remote === undefined ? {} : { remote: input.remote }),
      }
      if (Object.keys(patch).length > 0 || input.enabled !== undefined || setting !== undefined)
        await mutate((current) =>
          withAccount(current, account.id, (item) => {
            const { compaction: _previous, ...rest } = item
            // `null` clears the account value (kind default); the revision bump re-registers every slot (3.8).
            const compaction = setting === undefined ? item.compaction : setting
            return {
              ...rest,
              ...patch,
              ...(input.enabled === undefined ? {} : { status: enabledStatus(item.status, input.enabled) }),
              ...(compaction === undefined || compaction === null ? {} : { compaction }),
            }
          }),
        )
      const view = viewOf(account.id)
      if (!view) return context.error("account_not_found", "the account was removed", { accountID: account.id })
      return compactionImpact === undefined ? { account: view } : { account: view, compactionImpact }
    },

    removePlan: async (input, context) => {
      if (input.accountID === Account.ID.claudeSlot)
        return context.error("policy_denied", "remove the Claude slot with plugin.claudeAuth.uninstall", {
          field: "accountID",
        })
      // A Claude Agent account goes with its own RPC, which moves its conversations and may delete its folder (CAG-53).
      if ((state.registry.claudeAgents ?? []).some((item) => item.accountID === input.accountID))
        return context.error("policy_denied", "remove a Claude Agent account with claudeAgent.remove", {
          field: "accountID",
        })
      const account = state.registry.accounts.find((item) => item.id === input.accountID)
      if (!account || account.status === "retired")
        return context.error("account_not_found", "no such account", { accountID: input.accountID })
      // A linked codex login or old-app key lives in the old app's file: removal forgets only our reference.
      const linked = Credentials.linked(account)
      return {
        ...removals.issue({ accountID: account.id, mode: input.mode }),
        // Sessions bound to the slot, from the process-wide session index (every Location writes its own sessions).
        affectedSessions: deps.runtime.sessions
          .list({ providerID: account.providerID })
          .flatMap((entry) => Option.toArray(decodeSessionID(entry.sessionID))),
        willShredVault: input.mode === "delete" && !linked,
      }
    },

    removeExecute: async (input, context) => {
      const planned = removals.consume(input.nonce)
      if (!planned) return context.error("nonce_invalid", "the plan expired or was already used", {})
      const account = state.registry.accounts.find((item) => item.id === planned.accountID)
      if (!account || account.status === "retired")
        return context.error("account_not_found", "the account was removed", { accountID: planned.accountID })
      if (planned.mode === "delete") {
        const forgotten = await peers().logins.forget(account, { shred: true })
        if (!forgotten.ok) return context.error("vault_unavailable", "the vault item could not be deleted", {})
      }
      await mutate((current) => {
        const next = withAccount(current, account.id, (item) => ({
          ...item,
          status: planned.mode === "delete" ? ("retired" as const) : ("disabled" as const),
        }))
        if (planned.mode === "disable" || !next) return next
        const slot = next.slots[account.providerID]
        return slot ? { ...next, slots: { ...next.slots, [account.providerID]: { ...slot, retired: true } } } : next
      })
      if (planned.mode === "delete") deps.runtime.limits.remove(account.id)
      log.info("account_removed", { accountID: account.id, providerID: account.providerID, mode: planned.mode })
      const view = viewOf(account.id)
      if (!view) return context.error("account_not_found", "the account was removed", { accountID: account.id })
      return { account: view }
    },
  }
}

/** A provider id not used by any slot, live or retired (R-ID-3: never reused). */
function freshProviderID(registry: Registry.File, kind: Kind.Own): Kind.ProviderID {
  const id = Kind.ProviderID.create(kind)
  return id in registry.slots ? freshProviderID(registry, kind) : id
}

/**
 * An existing domain with the same kind, scope and external id (the same org/workspace/login), else a new
 * `cd_<slug>`/`qd_<slug>`. Per-key scopes and domains without an external id are never shared (02 §3.3).
 */
function domainID(
  domains: Readonly<Record<string, { readonly kind: Kind.Own; readonly scope: string; readonly externalId?: string }>>,
  prefix: "cd_" | "qd_",
  slug: string,
  kind: Kind.Own,
  input: { readonly scope: string; readonly externalId?: string },
) {
  const existing =
    input.externalId !== undefined && input.scope !== "api_key"
      ? Object.entries(domains).find(
          (entry) =>
            entry[1].kind === kind && entry[1].scope === input.scope && entry[1].externalId === input.externalId,
        )?.[0]
      : undefined
  if (existing) return { id: existing, created: false }
  const free = (suffix: string): string => (`${prefix}${suffix}` in domains ? free(`${suffix}_`) : `${prefix}${suffix}`)
  return { id: free(slug), created: true }
}

/** A new `compat` account's stored facts: the output caps and the settings the user chose (02 §3.3, 07 §6.2 #7). */
function compatOf(models: ReadonlyArray<OwnAccounts.CompatModel>, local: NewAccount["local"]): Account.Compat {
  const capabilities = Object.fromEntries(
    models.flatMap((model) => {
      const settings = Templates.compatSettings(undefined, model)
      return Object.keys(settings).length === 0 ? [] : [[model.id, settings] as const]
    }),
  )
  return {
    outputs: Object.fromEntries(models.map((model) => [model.id, Templates.compatOutput(model)])),
    ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    ...(local ? { local } : {}),
  }
}

function withAccount(
  registry: Registry.File,
  accountID: string,
  change: (account: Account.Info) => Account.Info,
): Registry.File | undefined {
  if (!registry.accounts.some((account) => account.id === accountID)) return undefined
  return {
    ...registry,
    accounts: registry.accounts.map((account) => (account.id === accountID ? change(account) : account)),
  }
}

/**
 * `registry` with `template` as the new shared template of `kind`: every slot of the kind points at it (D4), and the
 * kind's templates no slot uses any more are dropped.
 */
export function refreshTemplate(
  registry: Registry.File,
  kind: Kind.Own,
  template: Registry.ModelTemplate,
  now: number,
): Registry.File {
  const id = Templates.newID(kind, now, registry.modelTemplates)
  const slots = Object.fromEntries(
    Object.entries(registry.slots).map(([providerID, slot]) => [
      providerID,
      slot.kind === kind ? { ...slot, modelTemplate: id } : slot,
    ]),
  )
  const used = new Set<string>(Object.values(slots).map((slot) => slot.modelTemplate))
  return {
    ...registry,
    slots,
    modelTemplates: Object.fromEntries(
      [...Object.entries(registry.modelTemplates), [id, template] as const].filter(
        (entry) => entry[1].kind !== kind || used.has(entry[0]),
      ),
    ),
  }
}

function deniedField(account: Account.Info, input: RpcTypes.Input<"accounts.update">) {
  if (input.pollBalance !== undefined && !POLL_BALANCE.has(account.kind)) return "pollBalance"
  if (input.replaceKey !== undefined && Kind.isOAuth(account.kind)) return "replaceKey"
  // A linked old-app key is changed in the old app (02 §3.2b); this account follows its file.
  if (input.replaceKey !== undefined && account.credential?.type === "linked-legacy-key") return "replaceKey"
  if (input.refreshCatalog && account.kind === "compat") return "refreshCatalog"
  if (input.compatCapabilities !== undefined && account.kind !== "compat") return "compatCapabilities"
  if (input.local !== undefined && account.kind !== "compat") return "local"
  // A local model added without a key has nothing to send as `기타 OpenAI 호환` (02 §3.3a): add a key first.
  if (input.local === null && account.compat?.local?.keyless) return "local"
  return undefined
}

function deniedClaudeField(input: RpcTypes.Input<"accounts.update">) {
  const fields = [
    "autoSwitch",
    "budget",
    "replaceKey",
    "refreshCatalog",
    "enabled",
    "pollBalance",
    "compaction",
    "dryRun",
    "remote",
    "compatCapabilities",
  ] as const
  return fields.find((field) => input[field] !== undefined)
}

/** The facts a connection probe revealed; `null`/absent ones keep what the registry has. */
function known(detected: Account.Detected): Account.Identity {
  return Object.fromEntries(Object.entries(detected).filter((entry) => typeof entry[1] === "string"))
}

function enabledStatus(status: Account.Status, enabled: boolean): Account.Status {
  if (!enabled) return "disabled"
  return status === "disabled" ? "ready" : status
}

function shortLabel(label: string) {
  return Array.from(label.trim())[0]?.toUpperCase() ?? "?"
}

/** The first color no live account uses, cycling through the eight tokens. */
function nextColor(registry: Registry.File): Account.Color {
  const used = new Set(registry.accounts.filter((item) => item.status !== "retired").map((item) => item.color))
  return COLORS.find((color) => !used.has(color)) ?? COLORS[registry.accounts.length % COLORS.length] ?? "indigo"
}

function iso(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * A discovered local provider as the fold left it (07 §6.2 #8): upstream's Ollama discovery registers trained maxima,
 * so its windows are read from the server; LM Studio's registered window is the loaded one (07 §4.1). The Ollama key,
 * when one is configured, goes only to that same server. `undefined` while the provider has no models.
 */
function localTarget(providerID: string, record: ProviderRecord | undefined): LocalWindow.Target | undefined {
  const baseURL: unknown = record?.provider.settings?.baseURL
  const apiKey: unknown = record?.provider.settings?.apiKey
  if (!record || record.models.size === 0 || typeof baseURL !== "string") return undefined
  const headers: Record<string, string> =
    typeof apiKey === "string" && apiKey !== "" ? { authorization: `Bearer ${apiKey}` } : {}
  return {
    providerID,
    source:
      providerID === "ollama" ? { type: "ollama", baseURL, headers: async () => headers } : { type: "registered" },
    models: [...record.models.values()].map(localModel),
  }
}

function localModel(model: Pick<Model.Info, "id" | "capabilities" | "limit">) {
  return { id: model.id, tools: model.capabilities.tools, window: model.limit.context }
}

function positiveInt(text: string | undefined) {
  const value = Number(text)
  return Number.isInteger(value) && value > 0 ? value : undefined
}
