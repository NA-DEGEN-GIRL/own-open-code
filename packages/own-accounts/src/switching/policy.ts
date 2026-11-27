export * as PolicyRules from "./policy.js"

import { Compaction, OwnImage, type Policy, type Registry } from "@own/protocol"

/**
 * `policy.set` rules (02 §5.10, §9.2): leaving a subscription is never automatic, the Claude slot is never an
 * automatic target, and a chain with two or more subscription slots cannot be stored for automatic use. Returns the
 * denied field, or `undefined` when the patch is allowed.
 */
export function denied(patch: Policy.Patch, registry: Registry.File): string | undefined {
  const auto = patch.autoSwitch
  if (auto?.subscriptionToApi === "auto") return "autoSwitch.subscriptionToApi"
  if (auto?.subscriptionToSubscription === "auto") return "autoSwitch.subscriptionToSubscription"
  if (auto?.toClaudeSlot !== undefined && auto.toClaudeSlot !== "off") return "autoSwitch.toClaudeSlot"
  // 02 §8.8: between Claude accounts the switch happens before any output, so there is nothing to ask.
  if (auto?.claudeToClaude === "ask") return "autoSwitch.claudeToClaude"
  const chain = Object.entries(patch.fallbackChains ?? {}).find(
    (entry) => entry[1].filter((providerID) => subscription(registry, providerID)).length >= 2,
  )
  return chain ? `fallbackChains.${chain[0]}` : undefined
}

/** Whether a slot bills a subscription (codex seats and the Claude slot); chains with one are "recommended" only. */
export function subscription(registry: Registry.File, providerID: string) {
  if (providerID === "anthropic") return true
  return registry.accounts.some(
    (account) =>
      account.providerID === providerID && account.billing === "subscription" && account.status !== "retired",
  )
}

/**
 * Applies an allowed patch (checked by {@link denied}): sections merge one level deep (`thresholds.confirm` two),
 * arrays and records replace, and `outputLimit` is replaced whole (`null` removes it, back to the default).
 */
export function apply(current: Policy.File, patch: Policy.Patch): Policy.File {
  const auto = patch.autoSwitch
  const next: Policy.File = {
    ...current,
    autoSwitch: {
      apiToApi: auto?.apiToApi ?? current.autoSwitch.apiToApi,
      subscriptionToApi: subscriptionMode(auto?.subscriptionToApi) ?? current.autoSwitch.subscriptionToApi,
      subscriptionToSubscription:
        subscriptionMode(auto?.subscriptionToSubscription) ?? current.autoSwitch.subscriptionToSubscription,
      toClaudeSlot: "off",
      // 02 §8.8 (C-D3, default withdrawn by CAG-5): between this PC's Claude accounts; absent = `off`.
      claudeToClaude: claudeMode(auto?.claudeToClaude) ?? current.autoSwitch.claudeToClaude ?? "off",
      inTurnFailover: auto?.inTurnFailover ?? current.autoSwitch.inTurnFailover,
    },
    hysteresis: merge(current.hysteresis, patch.hysteresis),
    thresholds: merge(without(current.thresholds, RETIRED_THRESHOLDS), {
      ...patch.thresholds,
      confirm: merge(current.thresholds.confirm, patch.thresholds?.confirm),
    }),
    horizonRequests: patch.horizonRequests ?? current.horizonRequests,
    fallbackChains: patch.fallbackChains ?? current.fallbackChains,
    hideBuiltinProviders: patch.hideBuiltinProviders ?? current.hideBuiltinProviders,
    // An older file's `defaults.global` is dropped here: new-session models are group defaults (07 §2.2).
    defaults: { byKind: patch.defaults?.byKind ?? current.defaults.byKind },
    awayDetect: merge(current.awayDetect, patch.awayDetect),
    secretCacheSeconds: patch.secretCacheSeconds ?? current.secretCacheSeconds,
    credentialBackend: patch.credentialBackend ?? current.credentialBackend,
    ...compactionOf(current.compaction, patch.compaction),
    ...migratedOf(current.migrated, patch),
    ...(patch.imageGenerate === undefined ? {} : { imageGenerate: patch.imageGenerate }),
    ...(patch.hiddenModels === undefined ? {} : { hiddenModels: patch.hiddenModels }),
    ...(patch.image === undefined && current.image === undefined
      ? {}
      : { image: patch.image === undefined ? current.image : OwnImage.apply(current.image, patch.image) }),
  }
  if (patch.outputLimit === undefined) return next
  if (patch.outputLimit !== null) return { ...next, outputLimit: patch.outputLimit }
  const { outputLimit: _removed, ...rest } = next
  return rest
}

/**
 * Keys earlier builds wrote to `policy.json` that nothing reads any more: the token advice thresholds (07 §6.2
 * #9–#11) and `defaults.global` (07 §2.2). The store keeps keys it does not know (`Preserve`), so these
 * are dropped explicitly, by every write ({@link apply}) and once at startup ({@link prune}).
 */
const RETIRED_THRESHOLDS = [
  "compactAdviceUsedPercent",
  "compactMinTokens",
  "compactAfterSwitchMinTokens",
  "newSessionAdviceTokens",
]

/**
 * CAG-5 (2026-10-31), once per install: a stored `autoSwitch.claudeToClaude: "auto"` becomes `off`. Every `policy.set`
 * from 2026-10-11 (35d1a54409) on wrote `auto`, so an existing install still moved conversations between Claude
 * accounts on its own, which the user no longer wants (manual is fine; report §10.3). The marker (`changed`, which asks
 * the app for its one-time notice) keeps it from running again, and a `policy.set` that names the mode records the
 * user's own choice first ({@link apply}), so a later `auto` the user picks stands. `undefined`: nothing to write.
 */
export function migrate(file: Policy.File, now: number): Policy.File | undefined {
  if (file.migrated?.claudeToClaudeOff !== undefined || file.autoSwitch.claudeToClaude !== "auto") return undefined
  return {
    ...file,
    autoSwitch: { ...file.autoSwitch, claudeToClaude: "off" },
    migrated: { ...file.migrated, claudeToClaudeOff: { changed: true, at: now } },
  }
}

/**
 * `migrated` after a patch: a mode the user names is their choice, which {@link migrate} never changes; `noticed` marks
 * a notice shown.
 */
function migratedOf(current: Policy.File["migrated"], patch: Policy.Patch) {
  const chosen = claudeMode(patch.autoSwitch?.claudeToClaude) !== undefined
  const marker = current?.claudeToClaudeOff ?? (chosen ? { changed: false } : undefined)
  if (marker === undefined) return {}
  const noticed = patch.noticed === "claudeToClaudeOff" ? { noticed: true } : {}
  return { migrated: { ...current, claudeToClaudeOff: { ...marker, ...noticed } } }
}

/** The policy without the retired keys, or `undefined` when it has none (nothing to write). */
export function prune(file: Policy.File): Policy.File | undefined {
  if (!RETIRED_THRESHOLDS.some((key) => key in file.thresholds) && !("global" in file.defaults)) return undefined
  return {
    ...file,
    thresholds: without(file.thresholds, RETIRED_THRESHOLDS),
    defaults: without(file.defaults, ["global"]),
  }
}

/**
 * `policy.compaction` after a patch: kind defaults by {@link compactionByKind}, the idle compaction's fields over the
 * stored ones (02 §4.7.7). `keepTokens` lives in the own global config file, never in policy.json (02 §4.7.6 (가)).
 */
function compactionOf(current: Policy.File["compaction"], patch: Policy.Patch["compaction"]) {
  const byKind = patch?.byKind === undefined ? current?.byKind : compactionByKind(current?.byKind, patch.byKind)
  const idle = patch?.idle === undefined ? current?.idle : merge(current?.idle ?? { enabled: false }, patch.idle)
  if (byKind === undefined && idle === undefined) return {}
  return { compaction: { byKind: byKind ?? {}, ...(idle === undefined ? {} : { idle }) } }
}

type ByKindPatch = NonNullable<NonNullable<Policy.Patch["compaction"]>["byKind"]>

/**
 * `policy.compaction.byKind` after a patch (02 §2.4.3): a setting replaces the kind's value, `null` removes it (back
 * to the code constant). `claude-sub` never reaches here (`policy_denied`). Ranges are checked by the caller.
 */
export function compactionByKind(current: Compaction.ByKind | undefined, patch: ByKindPatch): Compaction.ByKind {
  return Object.fromEntries(
    Compaction.tunable.flatMap((kind): Array<[Compaction.Tunable, Compaction.Setting]> => {
      const value = patch[kind]
      if (value === null) return []
      if (value !== undefined) return [[kind, Compaction.normalize(value)]]
      const kept = current?.[kind]
      return kept ? [[kind, kept]] : []
    }),
  )
}

/** Kinds (own's and the Claude Agent route, CAG-50) a patch changes the compaction defaults of. */
export function compactionKinds(patch: ByKindPatch | undefined): ReadonlyArray<Compaction.Tunable> {
  return patch ? Compaction.tunable.filter((kind) => patch[kind] !== undefined) : []
}

function subscriptionMode(mode: Policy.SwitchMode | undefined): Policy.SubscriptionMode | undefined {
  return mode === "ask" || mode === "off" ? mode : undefined
}

function claudeMode(mode: Policy.SwitchMode | undefined): Policy.ClaudeMode | undefined {
  return mode === "auto" || mode === "off" ? mode : undefined
}

/** A section without keys outside its schema that the store preserved. */
function without<T extends object>(section: T, keys: ReadonlyArray<string>): T {
  // SAFETY: only keys `T` does not declare are removed, so every declared field is still there.
  return Object.fromEntries(Object.entries(section).filter((entry) => !keys.includes(entry[0]))) as T
}

/** Overlays the defined fields of a partial section on the stored one. */
function merge<T extends object>(base: T, patch: { readonly [K in keyof T]?: T[K] | undefined } | undefined): T {
  if (!patch) return base
  return Object.assign({}, base, Object.fromEntries(Object.entries(patch).filter((entry) => entry[1] !== undefined)))
}
