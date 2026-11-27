// The effort and subagent-role fixes of 2026-11-08 (07 §2.3, §2.4; decisions PE), pure: a model pool entry's one
// `추론 강도` choice that holds both its effort and its fixed level, and the subagent role guide (what each role may do
// and where it runs now under a preset). Lazy screens only (the editor's 자세히, 설정 > 프리셋, 설정 > 에이전트 방식).
import { Model } from "@opencode/schema/model"
import { Preset } from "@own/protocol/preset"
import { Struct } from "effect"
import type { Account } from "@own/protocol"
import { catalogOf, levelChoices, poolFacts, previewCards, withPoolEffort, type CatalogModel } from "./model"

// ---- a pool entry's 추론 강도 (07 §2.3, §7.2) ----

/** What one role may do (07 §2.4), from the role lists the permission hooks enforce. */
export type Access = "search" | "review" | "full"

export function accessOf(role: Preset.Role): Access {
  if (Preset.noShell(role)) return "search"
  if (Preset.READ_ONLY_ROLES.some((item) => item === role)) return "review"
  return "full"
}

/** The select value of a fixed level; an effort's value is the effort itself. */
const FIXED = "fixed:"

/**
 * The one `추론 강도` choice of a model pool entry (07 §2.3 강도 고정, §7.2). The entry's fixed level wins over its
 * effort, so one select holds both: the efforts the conversation may change per call ({@link levelChoices}: the whole
 * scale while the model's levels are unknown, its own levels else), then the fixed levels the model has (every
 * {@link Preset.ForcedEffort} while unknown). A stored fixed level the model lacks stays listed, dimmed. `undefined`
 * for a model without levels and nothing fixed: there is nothing to choose.
 */
export function entryChoices(levels: ReadonlyArray<string> | undefined, fixed: Preset.ForcedEffort | undefined) {
  const efforts = levelChoices(levels) ?? []
  const has = (level: string) => levels === undefined || levels.includes(level)
  const fixedLevels = Preset.ForcedEffort.literals
    .filter((level) => has(level) || level === fixed)
    .map((level) => ({ value: `${FIXED}${level}`, level, available: has(level) }))
  if (efforts.length === 0 && fixedLevels.length === 0) return undefined
  return { efforts, fixed: fixedLevels }
}

/** The select value of an entry: its fixed level when set, else its effort (`inherit` when absent). */
export function entryValue(entry: Pick<Preset.PoolEntry, "effort" | "forcedEffort"> | undefined) {
  const fixed = Preset.forcedEffortOf(entry?.forcedEffort)
  return fixed ? `${FIXED}${fixed}` : (entry?.effort ?? "inherit")
}

/**
 * The draft with an entry's `추론 강도` choice: a fixed level is stored as `forcedEffort` and leaves the stored
 * `effort` as it is (it is unused while fixed, `Preset.forcedFor`); an effort is stored and drops the fixed level.
 */
export function withPoolChoice(draft: Preset.Draft, key: string, value: string): Preset.Draft {
  const fixed = value.startsWith(FIXED) ? Preset.forcedEffortOf(value.slice(FIXED.length)) : undefined
  if (fixed) return editEntry(draft, key, (entry) => ({ ...entry, forcedEffort: fixed }))
  const effort = value === "inherit" || value === "default" ? value : Model.VariantID.make(value)
  return editEntry(withPoolEffort(draft, key, effort), key, (entry) => Struct.omit(entry, ["forcedEffort"]))
}

function editEntry(draft: Preset.Draft, key: string, edit: (entry: Preset.PoolEntry) => Preset.PoolEntry) {
  const pool = (draft.workers.pool ?? []).map((entry) => (entry.key === key ? edit(entry) : entry))
  return { ...draft, workers: { ...draft.workers, pool } }
}

// ---- the subagent role guide (07 §2.4) ----

/** Where a role's model comes from under a preset. */
export type RunSource = "main" | "role" | "fallback" | "single" | "pool-default" | "pool-main"

/** The effort a role sends: a level, none (the provider default), or a fixed level with what it runs at. */
export type RunEffort =
  | { readonly kind: "level"; readonly level: string }
  | { readonly kind: "default" }
  | { readonly kind: "fixed"; readonly level: Preset.ForcedEffort; readonly sent?: string }

export interface RoleRun {
  readonly role: Preset.Role
  readonly access: Access
  /** The main is told it can delegate to this role ({@link Preset.namedRoles}). */
  readonly named: boolean
  readonly source: RunSource
  /** What the role runs on now and on which account (`local:<id>` for a local provider); absent without a main. */
  readonly ref?: Model.Ref
  readonly account?: string
  readonly effort?: RunEffort
}

/**
 * Each role under a preset (07 §2.4, §1.2, §3.3), in {@link Preset.ROLES} order: what it may do, whether the main is
 * told about it, and where it runs now against `main`. By role and single target from `Preset.resolve`'s `use` (a role
 * whose targets cannot run falls back to the main); a model pool from its default rule (`defaults`: the entry key per
 * role, `Preset.poolDefaults`), else like the main; `메인과 같은 모델로` and `평소대로` like the main. The preset's
 * or the entry's fixed level wins over the resolved effort, fitted to the model that runs ({@link Preset.forcedFit}).
 */
export function roleRuns(input: {
  readonly preset: Pick<Preset.Info, "workers" | "forcedEffort" | "delegation">
  readonly main: Preset.Main | undefined
  readonly resolution: Preset.Resolution | undefined
  readonly catalog: Preset.Catalog
  readonly named: ReadonlyArray<Preset.Role>
  readonly defaults?: Partial<Readonly<Record<Preset.Role, string>>>
}): RoleRun[] {
  const mode = Preset.modeOf(input.preset.workers)
  return Preset.ROLES.map((role) => {
    const base = { role, access: accessOf(role), named: input.named.includes(role) }
    const main = input.main
    const placed = main && place(role, mode, main, input)
    if (!placed) return { ...base, source: sourceOf(role, mode, input.preset.workers) }
    const fixed = Preset.forcedFor(input.preset, placed.entry)
    return {
      ...base,
      source: placed.source,
      ref: placed.ref,
      account: placed.account,
      effort: fixed
        ? fixedEffort(fixed, levelsOf(placed, main, input.catalog))
        : placed.ref.variant
          ? { kind: "level", level: placed.ref.variant }
          : { kind: "default" },
    }
  })
}

interface Placed {
  readonly source: RunSource
  readonly ref: Model.Ref
  readonly account: string
  readonly entry?: Preset.PoolEntry
}

function place(
  role: Preset.Role,
  mode: Preset.Mode,
  main: Preset.Main,
  input: Parameters<typeof roleRuns>[0],
): Placed | undefined {
  const likeMain = (source: RunSource): Placed => ({ source, ref: main.ref, account: main.account })
  if (mode === "pool") {
    const key = input.defaults?.[role]
    const entry = key === undefined ? undefined : input.preset.workers.pool?.find((item) => item.key === key)
    const ref = input.resolution?.pool?.entries.find((item) => item.key === key)?.ref
    if (!entry || !ref) return likeMain("pool-main")
    return { source: "pool-default", ref, account: entry.account ?? main.account, entry }
  }
  if (mode !== "by-role" && mode !== "single") return likeMain("main")
  const resolved = input.resolution?.roles[role]
  if (!resolved || resolved.targets.length === 0) return likeMain("main")
  if (resolved.fallback) return likeMain("fallback")
  const used = resolved.targets.find((item) => item.ref !== undefined)
  const target = used?.target
  return {
    source: mode === "single" ? "single" : "role",
    ref: resolved.use,
    account: target && "pin" in target ? target.pin.account : main.account,
  }
}

/** Where a role's model comes from when no main is known to resolve against. */
function sourceOf(role: Preset.Role, mode: Preset.Mode, workers: Preset.Workers): RunSource {
  if (mode === "pool") return "pool-main"
  if (mode === "single") return "single"
  return mode === "by-role" && workers.roles[role]?.targets.length ? "role" : "main"
}

/** The levels of the model a role runs on: the main's own, else the catalog's for that account. */
function levelsOf(placed: Placed, main: Preset.Main, catalog: Preset.Catalog) {
  if (placed.account === main.account && placed.ref.id === main.ref.id)
    return { variants: main.variants, meta: main.meta }
  const offered = catalog(placed.account, placed.ref.id)
  return typeof offered === "object" ? { variants: offered.variants, meta: offered.meta } : undefined
}

function fixedEffort(
  level: Preset.ForcedEffort,
  model: { readonly variants: ReadonlyArray<string>; readonly meta?: Preset.Main["meta"] } | undefined,
): RunEffort {
  const fit = model ? Preset.forcedFit(level, model.variants, model.meta) : undefined
  return { kind: "fixed", level, ...(fit?.variant === undefined ? {} : { sent: fit.variant }) }
}

/**
 * {@link roleRuns} of a stored preset against a main, the way the editor previews it (07 §2.4): `Preset.resolve` over
 * this window's catalog, the role cards and the model pool's default rule over its candidates (`presets.suggest`; none
 * while it loads, so a pool's roles read like the main until then). 설정 > 프리셋 shows its ★ preset this way.
 */
export function presetRuns(input: {
  readonly preset: Pick<Preset.Info, "workers" | "forcedEffort" | "delegation">
  readonly main: Preset.Main | undefined
  readonly accounts: Readonly<Record<string, Account.View>>
  readonly models: ReadonlyArray<CatalogModel>
  readonly lighter: Readonly<Record<string, Preset.Lighter>>
  readonly candidates: ReadonlyArray<Preset.PoolCandidate>
}): RoleRun[] {
  const main = input.main
  const catalog = catalogOf(input.accounts, input.models)
  const resolution = main && Preset.resolve(input.preset, main, catalog, input.lighter)
  const facts =
    main && Preset.modeOf(input.preset.workers) === "pool"
      ? poolFacts({ pool: input.preset.workers.pool ?? [], candidates: input.candidates, main })
      : undefined
  const pool = facts?.entries.length ? Preset.poolGuidance(facts.entries, facts.main) : undefined
  const cards = previewCards({
    workers: input.preset.workers,
    main,
    resolution,
    accounts: input.accounts,
    models: input.models,
  })
  return roleRuns({
    preset: input.preset,
    main,
    resolution,
    catalog,
    named: Preset.namedRoles({
      delegation: input.preset.delegation,
      ultra: false,
      cards,
      ...(pool ? { pool } : {}),
    }),
    ...(pool ? { defaults: pool.defaults } : {}),
  })
}
