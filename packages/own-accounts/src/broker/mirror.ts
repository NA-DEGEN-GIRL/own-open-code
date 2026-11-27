export * as Mirror from "./mirror.js"

import { createHash } from "node:crypto"
import { Account, Broker, type CodexModels, type Policy, type Preset, type Ratecard, type Registry } from "@own/protocol"
import { ClaudeAccounts } from "../claude/accounts.js"
import { PresetBudget } from "../presets/budget.js"
import type { Contract } from "./contract.js"

/**
 * The registry view the local broker hands to a host (04 §9.2). Only what slot registration, auto-compaction and the
 * switching state machine need: no secrets, no identifiers (e-mail, ChatGPT account id, fingerprints, key hints,
 * organization/workspace ids, domain `externalId`s), no credential refs (a linked source path is a local path), no
 * budgets, and of the Claude slot only the PC's verdict for this host with its display metadata and the display of the
 * Claude accounts the host may use (`claude`, 04 §8.11.4.3, 02 §8.7: no connection label, e-mail, folder, plugin
 * version or integrity, never `remoteHosts`; tokens never leave this PC). Accounts the host may not
 * use (account `remote:"deny"`, outside the host's account scope) keep their slot but are `disabled`, so every model
 * stays registered and disabled (past turns keep their attribution, 01 §8.1). Model templates travel separately by
 * content hash (`template.get`). A `compat` account keeps its server facts (`compat`, without `keyless`), and the view
 * says this PC relays the host's local model requests (`localRelay`, 04 §8.14).
 *
 * T3 (07 §8.1 원격): `presets.json` travels as it is with its content-hash revision, so the host's subagent gate uses
 * the same presets (the host judges R4 again when it loads them, without identities). Instead of budgets the view
 * says, for every paid account the host may use, whether this month's budget is used up (`presetsBudget`).
 *
 * 10 §6.14: the served Codex rows this PC's harness runs from travel like templates, by content hash (`codexRows`,
 * `codexRow.get`), so a host's harness runs new Codex models from them; they hold no account data.
 */

/** First 16 hex digits of the sha256 of a value's compact JSON: the template hash of `MirrorView.templates`. */
export function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

/** A stable revision number for files without a `revision` field (policy, rate cards): 48 bits of the content hash. */
export function revisionOf(value: unknown) {
  return Number.parseInt(hash(value).slice(0, 12), 16)
}

export function allowed(account: Account.Info, scope: Contract.AccountScope) {
  if (account.remote === "deny") return false
  return scope.mode === "all" || scope.ids.includes(account.id)
}

export interface Built {
  readonly view: Broker.MirrorView
  readonly templates: ReadonlyMap<string, { readonly hash: string; readonly template: Registry.ModelTemplate }>
  /** The served Codex rows by slug (`codexRow.get`, 10 §6.14). */
  readonly codexRows: ReadonlyMap<string, { readonly hash: string; readonly row: CodexModels.HarnessRow }>
}

/**
 * The accounts `presetsBudget` names for a host: those it may use (not retired, inside its scope) that cost money per
 * use. The host's gate counts any other paid account as used up.
 */
export function paid(registry: Registry.File, scope: Contract.AccountScope) {
  return registry.accounts.filter(
    (account) => account.status !== "retired" && allowed(account, scope) && PresetBudget.paid(account),
  )
}

/**
 * `presets`: this PC's `presets.json` (absent when it cannot be read; the host then keeps only each group's
 * `평소대로`). `budget`: this PC's verdict for the accounts of {@link paid}.
 */
export function build(input: {
  readonly registry: Registry.File
  readonly policy: Policy.File
  readonly ratecards: Ratecard.File
  readonly scope: Contract.AccountScope
  readonly presets?: Preset.File
  readonly budget?: Readonly<Record<string, Broker.PresetBudget>>
  /** The PC's verdict for this host (04 §8.11.4.3); absent when this PC has no Claude slot detected. */
  readonly claude?: Omit<Broker.ClaudeRemote, "display">
  /** Whether this PC can sign with a Claude account now (the mirrored `usable`, 02 §8.8). */
  readonly claudeUsable?: (accountID: Account.ID) => boolean
  /** The Claude Agent accounts this host may use (02 §8.10.13); absent = the route is off there. */
  readonly claudeAgent?: Broker.ClaudeAgentRemote
  /** The served Codex rows this PC's harness runs from (10 §6.14); absent before this PC holds a fetched list. */
  readonly codex?: ReadonlyArray<CodexModels.HarnessRow>
}): Built {
  const registry = input.registry
  const accounts = registry.accounts.map((account): Account.Info => {
    const usable = allowed(account, input.scope)
    return {
      id: account.id,
      kind: account.kind,
      label: account.label,
      shortLabel: account.shortLabel,
      color: account.color,
      providerID: account.providerID,
      cacheDomain: account.cacheDomain,
      quotaDomain: account.quotaDomain,
      billing: account.billing,
      identity: {},
      autoSwitch: account.autoSwitch,
      status: usable || account.status === "retired" ? account.status : "disabled",
      ...(account.remote === undefined ? {} : { remote: account.remote }),
      ...(account.compaction === undefined ? {} : { compaction: account.compaction }),
      ...(account.compat === undefined ? {} : { compat: compatOf(account.compat) }),
    }
  })
  const strip = <D extends { readonly externalId?: string }>(record: Readonly<Record<string, D>>) =>
    Object.fromEntries(
      Object.entries(record).map(([id, domain]) => {
        const { externalId: _, ...rest } = domain
        return [id, rest]
      }),
    )
  const templates = new Map(
    Object.entries(registry.modelTemplates).map(([id, template]) => [id, { hash: hash(template), template }] as const),
  )
  const codexRows = new Map((input.codex ?? []).map((row) => [row.slug, { hash: hash(row), row }] as const))
  const view: Broker.MirrorView = {
    schemaVersion: Broker.MIRROR_SCHEMA_VERSION,
    registryRevision: registry.revision,
    policyRevision: revisionOf(input.policy),
    ratecardsRevision: revisionOf(input.ratecards),
    registry: {
      schemaVersion: registry.schemaVersion,
      revision: registry.revision,
      // SAFETY: only `externalId` (optional) is removed; the rest of each domain is kept as it is.
      cacheDomains: strip(registry.cacheDomains) as Registry.File["cacheDomains"],
      quotaDomains: strip(registry.quotaDomains) as Registry.File["quotaDomains"],
      accounts,
      slots: registry.slots,
      modelTemplates: {},
    },
    templates: Object.fromEntries([...templates].map(([id, item]) => [id, item.hash])),
    policy: input.policy,
    ratecards: input.ratecards,
    ...(input.presets ? { presets: input.presets, presetsRevision: revisionOf(input.presets) } : {}),
    ...(input.budget ? { presetsBudget: input.budget } : {}),
    ...(input.claude
      ? {
          claude: {
            ...input.claude,
            display: claudeDisplay(registry),
            accounts: claudeAccounts(registry, input.scope, input.claudeUsable),
          },
        }
      : {}),
    ...(input.claudeAgent ? { claudeAgent: input.claudeAgent } : {}),
    ...(input.codex ? { codexRows: Object.fromEntries([...codexRows].map(([slug, item]) => [slug, item.hash])) } : {}),
    localRelay: true,
  }
  return { view, templates, codexRows }
}

/**
 * A `compat` account's server facts as the host registers them (SLM, 04 §8.14): the server family, output caps,
 * capabilities and the local model's format, so the host builds the same request a conversation of this PC would. No
 * secret is in them; `keyless` stays here (the host never sends a local model's key, the PC adds it).
 */
function compatOf(compat: Account.Compat): Account.Compat {
  const local = compat.local
  return { ...compat, ...(local === undefined ? {} : { local: { format: local.format } }) }
}

/** The slot's own display metadata (02 §8.5 defaults); the hosts it is switched on for stay on this PC. */
export function claudeDisplay(registry: Registry.File): Broker.ClaudeRemote["display"] {
  return {
    label: registry.claudeSlot?.label ?? null,
    shortLabel: registry.claudeSlot?.shortLabel ?? "C",
    color: registry.claudeSlot?.color ?? "orange",
  }
}

/**
 * Every Claude account of this PC the host's account scope allows (02 §8.7, 04 §8.11), display only: no folder, key,
 * e-mail or uuid. `default` is this PC's default when the host may use it, else the first one it may.
 */
export function claudeAccounts(
  registry: Registry.File,
  scope: Contract.AccountScope,
  usable?: (accountID: Account.ID) => boolean,
): NonNullable<Broker.ClaudeRemote["accounts"]> {
  const all = [
    { accountID: Account.ID.claudeSlot, ...claudeDisplay(registry) },
    ...(registry.claudeAccounts ?? []).map((item) => ({
      accountID: item.accountID,
      label: item.label,
      shortLabel: item.shortLabel,
      color: item.color,
    })),
  ]
  const allowed = all.filter((item) => scope.mode === "all" || scope.ids.includes(item.accountID))
  const fallback = ClaudeAccounts.defaultOf(registry)
  const chosen = allowed.some((item) => item.accountID === fallback) ? fallback : allowed[0]?.accountID
  return allowed.map((item) => ({
    ...item,
    default: item.accountID === chosen,
    ...(usable === undefined ? {} : { usable: usable(item.accountID) }),
  }))
}

/** Account statuses that end a host's leases for that account (04 §8.9 "폐기"). */
export function revokes(status: Account.Status) {
  return status === "disabled" || status === "retired" || status === "needs_reauth"
}
