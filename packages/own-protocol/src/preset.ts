export * as Preset from "./preset.js"

import { Schema, Struct } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { NonNegativeInt, PositiveInt, optional, statics } from "@opencode/schema/schema"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Account } from "./account.js"
import { AccountID } from "./account-id.js"
import { CodexModels } from "./codex-models.js"
import { EpochMillis, NonNegative, ULID_PATTERN, ulid } from "./id.js"
import { Kind } from "./kind.js"
import { keyedRecord } from "./util.js"

/**
 * LLM behavior presets (07). Pure pieces shared by the service, own-web and own.team: provider groups, preset ids and
 * the preset shape (07 §2.1), the caps in force (§2.6), the session binding (§5.1), the R4 rule (§5.4, with one
 * ChatGPT login counted once), the subagent gate's rejection text and its parser, effort fitting and the ultra effort
 * (§2.3, §2.9, in Codex's level order where the Codex metadata has one), a conversation's per-call effort and its
 * ceiling (§2.3 대화에서 정하는 강도), target resolution and lighter pairs (§4.2),
 * the `own.preset` guidance text (§3.3), starters and suggestions (§3.4), each group's new-session default model
 * (§2.2), the catalog-change rules: presence, successors and repair notices (§4.3), and the model pool (T4, §3.3): its
 * lenient stored entries, keys, relation, default rule, guidance block and editor offer. A preset has no main model or
 * effort and no window or summary thresholds (U1, P-D8). `presets.json` keeps fields this build does not know.
 */

/** A discovered local provider (07 P-D2): `local:<providerID>`, both a group and the account of a pinned target. */
const Local = Schema.TemplateLiteral(["local:", Schema.NonEmptyString])

/** The account of a pinned target: an own account (or the Claude slot), or a local provider. */
const PinAccount = Schema.Union([AccountID, Local])

/**
 * Provider group (07 P-D2): one account kind (`claude-sub` is the Claude slot; an account kind is its own group), or
 * one discovered local provider (`local:<providerID>`). Presets and the new-session default model belong to a group,
 * never to an account (U4).
 */
export const Group = Schema.Union([Kind.Any, Local]).annotate({ identifier: "Own.Preset.Group" })
export type Group = typeof Group.Type

/** Whether a group or a pinned target's account names a discovered local provider. */
export function isLocal(value: string): value is `local:${string}` {
  return value.startsWith("local:")
}

/**
 * Discovered providers that run a local LLM (07 P-D2): upstream's `ollama` and `lmstudio` discovery plugins
 * (`packages/core/src/plugin/provider/{ollama,lmstudio}.ts`, `const providerID`). `vllm` is left out because its
 * discovery fixes tool support to `false`. A mirror of upstream ids (07 §3.5), registered as `local-provider-ollama`
 * and `local-provider-lmstudio` in `own/upstream-surface.json`.
 */
export const LOCAL_PROVIDERS = ["ollama", "lmstudio"] as const

/**
 * The group of a session's main provider (07 P-D2): its account's kind (the Claude slot's is `claude-sub`), or
 * `local:<providerID>` for a local provider; `undefined` for any other provider (no preset applies).
 */
export function groupOf(providerID: string, account?: { readonly kind: Kind.Any }): Group | undefined {
  if (account) return account.kind
  return LOCAL_PROVIDERS.some((id) => id === providerID) ? `local:${providerID}` : undefined
}

const Builtin = Schema.TemplateLiteral(["builtin:", Group])

/**
 * Preset id (07 §2.1): `pr_<ulid>` for a stored preset, `builtin:<group>` for the group's locked `평소대로`, which is
 * never stored. Bindings, 06 `area.preset`, ★ and `recent` all use it.
 */
export const ID = Schema.Union([
  Schema.TemplateLiteral(["pr_", Schema.String.check(Schema.isPattern(ULID_PATTERN))]),
  Builtin,
]).pipe(
  Schema.brand("Own.Preset.ID"),
  Schema.annotate({ identifier: "Own.Preset.ID" }),
  statics((schema) => ({ create: () => schema.make(`pr_${ulid()}`) })),
)
export type ID = typeof ID.Type

export function builtinID(group: Group): ID {
  return ID.make(`builtin:${group}`)
}

/** Whether a value is the id of a group's `평소대로`. */
export function isBuiltin(value: string) {
  return Schema.is(Builtin)(value)
}

/**
 * Subagent roles (07 §2.4): the subagent tool's `agent` value. `explore` and `general` are upstream's; the `own-*`
 * roles are hidden agents own-accounts registers.
 */
export const Role = Schema.Literals(["explore", "general", "own-review", "own-quick", "own-deep"]).annotate({
  identifier: "Own.Preset.Role",
})
export type Role = typeof Role.Type
export const ROLES = Role.literals

/**
 * The read-only roles (07 §2.4): `explore` searches and `own-review` reviews. Neither edits nor drives the desktop;
 * own-accounts' permission hook and own.computer-use's gate both read this one list.
 */
export const READ_ONLY_ROLES = ["explore", "own-review"] as const satisfies ReadonlyArray<Role>
export type ReadOnlyRole = (typeof READ_ONLY_ROLES)[number]

/**
 * The read-only roles that run no command in any approval mode: own-accounts denies their `shell` (07 §2.4). In the
 * harnesses whose models read and list through a shell (Codex's `exec_command`, Pi's `bash`), own.harness answers their
 * simple reads itself instead (10 §3.10), so they can still read, list and search.
 */
export const NO_SHELL_ROLES = ["explore"] as const satisfies ReadonlyArray<ReadOnlyRole>

/** Whether `agent` is one of the {@link NO_SHELL_ROLES}. */
export function noShell(agent: string | undefined) {
  return NO_SHELL_ROLES.some((role) => role === agent)
}

/**
 * The rules own-accounts gives the read-only roles last so they ask before a web request, `webfetch` or Code Mode's
 * `fetch` (decisions MR10-3) and `websearch` (MR11): what they read can carry a prompt injection, and a URL or a search
 * query can send data out. A parent's session rules come after them, so `full` approval's web allows still let them
 * reach the web unasked, and `ask` or `read-only` ask as they do anyway; a session without an own bundle asks.
 */
export const ROLE_WEB_ASK = [
  { action: "webfetch", resource: "*", effect: "ask" },
  { action: "websearch", resource: "*", effect: "ask" },
] as const

/**
 * Whether `rule` of `agent`'s rules is one of the {@link ROLE_WEB_ASK} rules own added to a read-only role. Readers of a
 * user's own rules (a config's deny of a web request) skip them, and only them: the user's own `ask` rules count.
 */
export function roleWebAsk(
  agent: string | undefined,
  rule: { readonly action: string; readonly resource: string; readonly effect: string },
) {
  return (
    READ_ONLY_ROLES.some((role) => role === agent) &&
    ROLE_WEB_ASK.some(
      (own) => own.action === rule.action && own.resource === rule.resource && own.effect === rule.effect,
    )
  )
}

/** The role an LLM named, as an agent id or as a `model` value (07 §3.2): `review` is `own-review`, and so on. */
export function roleOf(name: string): Role | undefined {
  return ROLES.find((role) => role === name || role === `own-${name}`)
}

/** Where a preset keeps targets: a role's row, or `workers.single`. Errors and warnings name it. */
export const Place = Schema.Union([Role, Schema.Literal("single")]).annotate({ identifier: "Own.Preset.Place" })
export type Place = typeof Place.Type

/**
 * A place, or one model pool entry (`pool:<key>`): what errors, warnings, repair notices and `repairOf` name. RPC
 * only; the stored repair history keeps {@link Place} (an older build must still read it).
 */
export const Spot = Schema.Union([Place, Schema.TemplateLiteral(["pool:", Schema.String])]).annotate({
  identifier: "Own.Preset.Spot",
})
export type Spot = typeof Spot.Type

/** The spot of a pool entry. */
export function poolSpot(key: string): `pool:${string}` {
  return `pool:${key}`
}

/** The pool key a spot names; `undefined` for a role or `single`. */
export function poolKeyOf(spot: Spot): string | undefined {
  return spot.startsWith("pool:") ? spot.slice("pool:".length) : undefined
}

/**
 * Where a subagent runs (07 §2.1, P-D3). Relative: `main` (the main's model and effort) or `lighter` (the group's
 * lighter pair on the main account, 07 §4.2); both always run on the main account. `pin`: one model of one account
 * or local provider, chosen by the user.
 */
export const Target = Schema.Union([
  Schema.Struct({ rel: Schema.Literals(["main", "lighter"]) }),
  Schema.Struct({ pin: Schema.Struct({ account: PinAccount, model: Model.ID }) }),
]).annotate({ identifier: "Own.Preset.Target" })
export type Target = typeof Target.Type

/**
 * A role's reasoning effort as an intent (07 §2.3): `inherit` the main's, `default` sends none, else a level fitted to
 * the target model's own levels. A pinned target may name a level only that model has.
 */
export const Effort = Schema.Union([Schema.Literals(["inherit", "default"]), Model.VariantID]).annotate({
  identifier: "Own.Preset.Effort",
})
export type Effort = typeof Effort.Type

/**
 * How far a conversation may raise one subagent's reasoning effort above the preset's (07 §2.3 대화에서 정하는 강도,
 * the preset's `subagentEffortMax`): up to `max` (the default), `xhigh` or `high`, or `off` = never above the preset's
 * effort. Lowering is always allowed, and a paid target is never raised whatever this says.
 */
export const EffortMax = Schema.Literals(["max", "xhigh", "high", "off"]).annotate({
  identifier: "Own.Preset.EffortMax",
})
export type EffortMax = typeof EffortMax.Type

/** A preset without `subagentEffortMax` lets a conversation raise a free target's effort up to `max`. */
export const EFFORT_MAX: EffortMax = "max"

/**
 * A preset's stored `subagentEffortMax`, read leniently (the stored field is a plain string, 07 §2.1): absent is
 * {@link EFFORT_MAX}; a value this build does not know raises nothing (`off`, fail closed).
 */
export function effortMaxOf(preset: { readonly subagentEffortMax?: string }): EffortMax {
  const value = preset.subagentEffortMax
  if (value === undefined) return EFFORT_MAX
  return EffortMax.literals.find((item) => item === value) ?? "off"
}

/**
 * A forced reasoning level (07 §2.3 강도 고정, PF 2026-11-03): one of the usual level names, fitted to each model's own
 * levels when it runs ({@link forcedFit}).
 */
export const ForcedEffort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).annotate({
  identifier: "Own.Preset.ForcedEffort",
})
export type ForcedEffort = typeof ForcedEffort.Type

/** A stored forced level, read leniently: a value this build does not know forces nothing. */
export function forcedEffortOf(value: string | undefined): ForcedEffort | undefined {
  return ForcedEffort.literals.find((item) => item === value)
}

/**
 * The forced level of one subagent target or of the main (07 §2.3 강도 고정): a pool entry's own, else the preset's.
 * `undefined` = nothing forced.
 */
export function forcedFor(
  preset: { readonly forcedEffort?: string } | undefined,
  entry?: { readonly forcedEffort?: string },
): ForcedEffort | undefined {
  return forcedEffortOf(entry?.forcedEffort) ?? forcedEffortOf(preset?.forcedEffort)
}

/**
 * A forced level fitted to one model (07 §2.3 강도 고정): {@link effortToVariant}'s level (the same name, else the
 * model's next level above, else its highest), `clamped` when that is not the forced name (the screen and the
 * subagent's result say so), `unplaced` for a model without known levels (sent without an effort).
 */
export function forcedFit(level: ForcedEffort, variants: ReadonlyArray<string>, meta?: CodexModels.Model) {
  const fit = effortToVariant(level, variants, meta)
  return { ...fit, clamped: !fit.unplaced && fit.variant !== level }
}

/** One role row: targets in order (1st, 2nd …); when all are blocked the role runs like the main (07 §1.2). */
export interface RoleEntry extends Schema.Schema.Type<typeof RoleEntry> {}
export const RoleEntry = Schema.Struct({ targets: Schema.Array(Target), effort: Effort }).annotate({
  identifier: "Own.Preset.RoleEntry",
})

/**
 * The facts of a model pool entry frozen when the entry was added (07 §3.3 모델 묶음, D2): only what does not change
 * with the main. Every field is optional and plain, so a hand edit or a later field never makes `presets.json`
 * unreadable. Money, company and the relation to the main are worked out again on every render (`PoolSide`).
 * - `window`: `limit.input ?? limit.context`; a local model's verified running window. `windowVerified`: locals only.
 * - `reasoning`: the model has reasoning levels; `image`: it takes image input.
 * - `summary`: Codex's `description` (a `codex` account only); `at`: when the card was frozen (epoch ms).
 */
export interface PoolCard extends Schema.Schema.Type<typeof PoolCard> {}
export const PoolCard = Schema.Struct({
  name: optional(Schema.String),
  window: optional(Schema.Number),
  windowVerified: optional(Schema.Boolean),
  reasoning: optional(Schema.Boolean),
  image: optional(Schema.Boolean),
  summary: optional(Schema.String),
  at: optional(Schema.Number),
}).annotate({ identifier: "Own.Preset.PoolCard" })

/**
 * One model of a model pool (07 §2.1 `workers.pool`, U7): the name the LLM writes as `model` ({@link isPoolKey}), the
 * model, and where it runs. No `account` = the main account (whichever account of the group is the main; adds no
 * account to R4); an `account` pins it like a role's pinned target. `effort` absent = `inherit`. Read leniently: the
 * key and note formats are checked only when saving and when loading (an entry that breaks them is left out of the
 * loaded view, never the whole file). The service freezes `card`; a client's card is ignored.
 */
export interface PoolEntry extends Schema.Schema.Type<typeof PoolEntry> {}
export const PoolEntry = Schema.Struct({
  key: Schema.String,
  model: Model.ID,
  account: optional(PinAccount),
  effort: optional(Effort),
  /**
   * The level this entry always runs at (07 §2.3 강도 고정, PF 2026-11-03), read through {@link forcedEffortOf}; it wins
   * over the preset's `forcedEffort`, the entry's `effort` and a per-call effort.
   */
  forcedEffort: optional(Schema.String),
  note: optional(Schema.String),
  card: optional(PoolCard),
}).annotate({ identifier: "Own.Preset.PoolEntry" })

/** At most this many models in one pool (07 §3.3: the guidance stays under about 3 KB). */
export const POOL_MAX = 12

/** The longest note of a pool entry, in characters (checked when saving and loading). */
export const NOTE_MAX = 120

/**
 * Subagent targets (07 §2.1, §3.2): `same` = every role like the main, `single` = every call to `single`, `by-role` =
 * the LLM picks a role and each role maps to its row. A role without a row runs like the main. A non-empty `pool`
 * makes it a model pool preset ({@link modeOf}): stored with `mode: "same"`, so an older build reads it as `모두 메인과
 * 같게` and keeps the field it does not know.
 */
export interface Workers extends Schema.Schema.Type<typeof Workers> {}
export const Workers = Schema.Struct({
  mode: Schema.Literals(["same", "single", "by-role"]),
  single: optional(Target),
  roles: keyedRecord(Role, RoleEntry),
  pool: optional(Schema.Array(PoolEntry)),
}).annotate({ identifier: "Own.Preset.Workers" })

/** How a preset runs subagents: the stored mode, or `pool` while the pool has an entry. */
export type Mode = Workers["mode"] | "pool"

/** The one place a mode is judged (07 §2.1): a non-empty pool is the model pool mode, else the stored mode. */
export function modeOf(workers: Pick<Workers, "mode" | "pool">): Mode {
  return workers.pool?.length ? "pool" : workers.mode
}

/**
 * `다른 모델 하나로` on `메인과 같게` is `메인과 같은 모델로` (UC 2026-10-18): `single` points somewhere other than the
 * main, so a stored or sent `single: {rel: "main"}` reads as mode `same` without `single` (in any mode: it adds nothing
 * there). A loaded preset and a save pass through it; an older build reads the result the same way it ran before.
 */
export function plainWorkers(workers: Workers): Workers {
  const single = workers.single
  if (!single || !("rel" in single) || single.rel !== "main") return workers
  return { ...Struct.omit(workers, ["single"]), mode: workers.mode === "single" ? "same" : workers.mode }
}

/**
 * Every target a preset keeps (07 §5.4 R4's S): the role rows, `single`, and the pool's pinned entries, used by the
 * mode or not. A pool entry on the main account is no target: it runs on the main account, like a relative target.
 */
export function targetsOf(workers: Workers): ReadonlyArray<Target> {
  return placesOf(workers).flatMap((place) => place.targets)
}

/**
 * Where a preset keeps something: the role rows in role order, `single`, then each pool entry (`pool:<key>`, its pin
 * as the one target, none for a main-account entry), used by the mode or not.
 */
export function placesOf(workers: Workers): ReadonlyArray<PlaceOf> {
  return [
    ...ROLES.flatMap((role) => {
      const entry = workers.roles[role]
      return entry ? [{ spot: role, targets: entry.targets }] : []
    }),
    ...(workers.single ? [{ spot: "single" as const, targets: [workers.single] }] : []),
    ...(workers.pool ?? []).map((entry) => ({
      spot: poolSpot(entry.key),
      targets: entry.account === undefined ? [] : [{ pin: { account: entry.account, model: entry.model } }],
      pool: entry,
    })),
  ]
}

/** One place of {@link placesOf}; `pool` is set for a pool entry. */
export interface PlaceOf {
  readonly spot: Spot
  readonly targets: ReadonlyArray<Target>
  readonly pool?: PoolEntry
}

/**
 * What a pool entry runs on, for its card and the default rule (07 §3.3): the main account (`main`, or `main-paid`
 * when the main account costs money), another company's subscription (the Claude slot included), a paid API key, or
 * a local model.
 */
export const PoolRuns = Schema.Literals(["main", "main-paid", "subscription", "paid", "local"]).annotate({
  identifier: "Own.Preset.PoolRuns",
})
export type PoolRuns = typeof PoolRuns.Type

/** The longest pool key (07 §3.3 이름 규칙). */
const KEY_MAX = 40

/** The tail a key takes when its name is taken (07 §3.3 이름 규칙 4), by what the entry runs on. */
const KEY_TAILS: Readonly<Record<PoolRuns, string>> = {
  paid: "-api",
  local: "-local",
  subscription: "-sub",
  main: "-main",
  "main-paid": "-main",
}

/**
 * The pool key of a model (07 §3.3 이름 규칙), frozen when the entry is added: the model id after its last `/`,
 * lowercased, every run of other characters than `[a-z0-9.]` as `-`, trimmed and at most 40 characters (`model` when
 * nothing is left). A name a role answers to ({@link roleOf}) takes `-model`. A name in `taken` takes the tail of what
 * the entry runs on (`-api`, `-local`, `-sub`, `-main`), then `-2`, `-3` …. The same input always gives the same key.
 */
export function poolKey(model: string, taken: ReadonlyArray<string>, runs?: PoolRuns): string {
  const fit = (base: string, tail: string) => `${trimKey(base.slice(0, KEY_MAX - tail.length))}${tail}`
  const cleaned =
    trimKey(
      model
        .toLowerCase()
        .slice(model.lastIndexOf("/") + 1)
        .replace(/[^a-z0-9.]+/g, "-"),
    ) || "model"
  const base = roleOf(fit(cleaned, "")) ? fit(cleaned, "-model") : fit(cleaned, "")
  if (!taken.includes(base)) return base
  const tailed = runs === undefined ? base : fit(base, KEY_TAILS[runs])
  if (!taken.includes(tailed)) return tailed
  const free = Array.from({ length: taken.length + 1 }, (_, index) => fit(tailed, `-${index + 2}`)).find(
    (key) => !taken.includes(key),
  )
  return free ?? fit(tailed, `-${taken.length + 2}`)
}

/** Whether a value can be a pool key: the key format, and no role answers to it (so the gate never reads it twice). */
export function isPoolKey(key: string) {
  return KEY_PATTERN.test(key) && roleOf(key) === undefined
}

const KEY_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?$/

function trimKey(value: string) {
  return value.replace(/^[-.]+|[-.]+$/g, "")
}

/** How readily the main delegates (07 §2.5), apart from reasoning effort. `model` adds no instruction. */
export const Delegation = Schema.Literals(["off", "model", "on-request", "when-useful", "active"]).annotate({
  identifier: "Own.Preset.Delegation",
})
export type Delegation = typeof Delegation.Type

/**
 * Subagent caps of a root session (07 §2.6): running at once, new per user message, total per conversation.
 * `perSession: null` is no conversation cap (the default since 2026-11-03): only a number the user set caps it.
 */
export interface Caps extends Schema.Schema.Type<typeof Caps> {}
export const Caps = Schema.Struct({
  concurrent: PositiveInt,
  perMessage: PositiveInt,
  perSession: Schema.NullOr(PositiveInt),
}).annotate({ identifier: "Own.Preset.Caps" })

/** Caps of `평소대로` and of a new preset (07 §2.6): no conversation cap. */
export const CAPS: Caps = { concurrent: 3, perMessage: 6, perSession: null }

/**
 * The conversation cap every preset had before 2026-11-03 (`presets.json` version 1). That version stored it like a
 * number the user typed, so {@link upgrade} reads exactly this value as the old default (07 §2.6, decision SC-1).
 */
export const LEGACY_PER_SESSION = 100

/** Ultra caps (07 §2.6): a level (`아껴서`, `추천`, `크게`) or the user's own three numbers. */
export const UltraCaps = Schema.Union([Schema.Literals(["save", "recommended", "large"]), Caps]).annotate({
  identifier: "Own.Preset.UltraCaps",
})
export type UltraCaps = typeof UltraCaps.Type

/**
 * The ultra levels (07 §1.2, §2.6), concurrent · per message · per conversation: `아껴서` is Codex's own default,
 * `추천` the default level, `크게` the user's Codex setting. No level caps the conversation (2026-11-03).
 */
export const ULTRA_LEVELS: Readonly<Record<Exclude<UltraCaps, Caps>, Caps>> = {
  save: { concurrent: 3, perMessage: 12, perSession: null },
  recommended: { concurrent: 8, perMessage: 24, perSession: null },
  large: { concurrent: 64, perMessage: 128, perSession: null },
}

/** The global ultra level when `presets.json` names none (07 §8.1). */
export const ULTRA_LEVEL = "recommended" satisfies UltraCaps

/** New subagents per user message that `적극적으로` allows by default (07 §2.6). */
const ACTIVE_PER_MESSAGE = 12

/** The numbers of an ultra level, or the user's own. */
export function levelCaps(value: UltraCaps): Caps {
  return typeof value === "string" ? ULTRA_LEVELS[value] : value
}

/**
 * The caps in force for a root session (07 §2.6, §2.9).
 * - A preset that keeps the default caps ({@link CAPS}) takes its delegation's defaults: `적극적으로`, and ultra (which
 *   delegates actively), allow 12 new subagents per user message. Caps the user set stay as they are.
 * - With ultra on, each cap is the larger of the preset's and the ultra level's: the preset's own `ultraCaps`, else
 *   `level` (the global level, `presets.json` `ultraCaps`). No conversation cap is larger than any number.
 */
export function caps(
  preset: Pick<Info, "caps" | "delegation" | "ultraCaps">,
  ultra: boolean,
  level: UltraCaps = ULTRA_LEVEL,
): Caps {
  const stored = preset.caps
  const untouched =
    stored.concurrent === CAPS.concurrent &&
    stored.perMessage === CAPS.perMessage &&
    stored.perSession === CAPS.perSession
  const base =
    untouched && (ultra || preset.delegation === "active") ? { ...stored, perMessage: ACTIVE_PER_MESSAGE } : stored
  if (!ultra) return base
  const raised = levelCaps(preset.ultraCaps ?? level)
  return {
    concurrent: Math.max(base.concurrent, raised.concurrent),
    perMessage: Math.max(base.perMessage, raised.perMessage),
    // No cap (`null`) is the largest.
    perSession:
      base.perSession === null || raised.perSession === null ? null : Math.max(base.perSession, raised.perSession),
  }
}

/**
 * A preset (07 §2.1): how the LLM works, never which main model, effort or window it uses (U1, P-D8). `ultraCaps:
 * null` follows the global ultra level. `revision` grows by one on every save. `subagentEffortMax` (07 §2.3) is a
 * plain string read through {@link effortMaxOf}, so a value of a later build never makes `presets.json` unreadable.
 */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Schema.NonEmptyString,
  group: Group,
  workers: Workers,
  delegation: Delegation,
  caps: Caps,
  ultraCaps: Schema.NullOr(UltraCaps),
  subagentEffortMax: optional(Schema.String),
  /**
   * The level the conversation's main and every subagent of this preset run at (07 §2.3 강도 고정, PF 2026-11-03),
   * fitted to each model ({@link forcedFit}); absent = efforts as without it. A plain string read through
   * {@link forcedEffortOf}, so a later build's value never makes `presets.json` unreadable.
   */
  forcedEffort: optional(Schema.String),
  revision: NonNegativeInt,
}).annotate({ identifier: "Own.Preset.Info" })

/** A group's locked `평소대로` (07 §2.7): like the company's own client, so its sessions send the same bytes. */
export function builtin(group: Group): Info {
  return {
    id: builtinID(group),
    name: "평소대로",
    group,
    workers: { mode: "same", roles: {} },
    delegation: "model",
    caps: CAPS,
    ultraCaps: null,
    revision: 0,
  }
}

/**
 * `presets.set` input (07 §8.1): a preset to store. Without `id` it is a new preset; the service sets `id` and
 * `revision`. `subagentEffortMax` absent or `max` is stored as absent (the default, 07 §2.3).
 */
export interface Save extends Schema.Schema.Type<typeof Save> {}
export const Save = Schema.Struct({
  id: optional(ID),
  name: Info.fields.name,
  group: Group,
  workers: Workers,
  delegation: Delegation,
  caps: Caps,
  ultraCaps: Schema.NullOr(UltraCaps),
  subagentEffortMax: optional(EffortMax),
  forcedEffort: optional(ForcedEffort),
}).annotate({ identifier: "Own.Preset.Save" })

/** An unsaved preset as the editor fills it (`presets.suggest`): `name` may still be empty. */
export interface Draft extends Schema.Schema.Type<typeof Draft> {}
export const Draft = Schema.Struct({ ...Save.fields, id: optional(ID), name: Schema.String }).annotate({
  identifier: "Own.Preset.Draft",
})

/**
 * Team context own.team passes with `session.preset.apply` (07 §5.1, 06 §10.1): the team's subscription accounts
 * (one per company) and the pinned targets of the team main's and every area's preset, so one session can rebuild
 * the team's R4 set.
 */
export interface Team extends Schema.Schema.Type<typeof Team> {}
export const Team = Schema.Struct({
  teamID: Schema.String.check(Schema.isStartingWith("tm_")),
  role: Schema.Literals(["main", "owner"]),
  accounts: Schema.Array(AccountID),
  pinned: Schema.Array(Target),
}).annotate({ identifier: "Own.Preset.Team" })

/**
 * KV `sess:<root>:preset` (07 §5.1, `Kv.preset`). The main (account, model, variant) is the session's own state and
 * not here. `ultra` present = ultra on; `before` is the main variant from before it was turned on. `ultra.pending`: the
 * effort ultra wants on a main the session moved to, when that variant switch rewrites the cache; it waits for the
 * user's OK in the cost dialog (07 §2.9, `session.ultra.set{on:true}` applies it). `entryHash`: the `own.preset`
 * instruction entry last written, `null` when the preset needs none.
 */
export interface Binding extends Schema.Schema.Type<typeof Binding> {}
export const Binding = Schema.Struct({
  presetID: ID,
  group: Group,
  revision: NonNegativeInt,
  appliedAt: EpochMillis,
  entryHash: Schema.NullOr(Schema.String),
  ultra: optional(
    Schema.Struct({
      raiseClaude: optional(Schema.Boolean),
      before: optional(Schema.NullOr(Model.VariantID)),
      pending: optional(Model.VariantID),
    }),
  ),
  team: optional(Team),
}).annotate({ identifier: "Own.Preset.Binding" })

/**
 * The preset a session uses now: its binding's while the main stays in the binding's group; after the main moved to
 * another group, that group's ★, else its `평소대로` (07 §5.3).
 */
export function effective(binding: Binding | undefined, group: Group, star?: ID): ID {
  return binding?.group === group ? binding.presetID : (star ?? builtinID(group))
}

/**
 * KV `sess:<root>:presetUsage` (07 §8.1, `Kv.presetUsage`): new subagents in this conversation so far, the one user
 * message whose per-message cap `session.preset.raiseOnce` raised, and the one user message for which it lifted the
 * effort ceiling (`effort`, `이번 메시지만 허용`, 07 §2.3). Per-message counts and reservations stay in memory (07 §2.6).
 */
export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({
  perSession: NonNegativeInt,
  raise: optional(Schema.Struct({ messageID: SessionMessage.ID, perMessage: PositiveInt })),
  effort: optional(Schema.Struct({ messageID: SessionMessage.ID })),
}).annotate({ identifier: "Own.Preset.Usage" })

/**
 * KV `sess:<root>:presetConsent` (07 §5.4 step 4, `Kv.presetConsent`): the user's answer, for this conversation only,
 * to moving a role onto a paid account (`session.preset.consent`).
 */
export interface Consent extends Schema.Schema.Type<typeof Consent> {}
export const Consent = Schema.Struct({
  accounts: keyedRecord(AccountID, Schema.Struct({ allow: Schema.Boolean, at: EpochMillis })),
}).annotate({ identifier: "Own.Preset.Consent" })

/**
 * What R4 reads of an account: an `Account.Info`, or the Claude slot (`acc_claude_slot`, `claude-sub`). `identity`
 * carries the ChatGPT login key of `codex` and `siwc` accounts ({@link loginOf}).
 */
export interface Member {
  readonly id: AccountID
  readonly kind: Kind.Any
  /** `local` for a local model account (02 §3.3a): never a paid target. */
  readonly billing: Account.Charge
  readonly identity?: { readonly login?: string; readonly fingerprint?: string }
}

export type Lookup = (accountID: AccountID) => Member | undefined

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly accountID: AccountID }

/**
 * An account's company (07 §5.4): its kind's `canonical` provider; the Claude slot and the Claude Agent route are
 * Anthropic's (CAG 2026-10-31: a team or a subagent tree keeps to one Claude subscription across both routes).
 */
export function company(account: { readonly kind: Kind.Any }) {
  return Kind.meta[account.kind === "claude-sub" || account.kind === "claude-agent" ? "anth" : account.kind].canonical
}

/**
 * The ChatGPT login an account signs in as (07 §5.4): `sha256(chatgpt_account_id + ":" + sub)`, the Codex guard
 * fingerprint formula, so a `codex` account's fingerprint is its login. A `siwc` fingerprint uses the issued client id
 * instead, so only its recorded `login` counts. `undefined` for other kinds and for an account whose login is not
 * known (it then counts as a subscription of its own: fail closed).
 */
export function loginOf(member: Member): string | undefined {
  if (member.kind === "codex") return member.identity?.login ?? member.identity?.fingerprint
  if (member.kind === "siwc") return member.identity?.login
  return undefined
}

/** Whether two accounts are one subscription: the same account, or `codex`/`siwc` accounts of one ChatGPT login. */
export function oneSubscription(a: Member, b: Member) {
  const login = loginOf(a)
  return a.id === b.id || (login !== undefined && login === loginOf(b))
}

/**
 * R4 (07 P-D4, §5.4; a team: 06 §10.1), the one check every save, load, apply and gate call uses.
 * - S = the main account, with a team its accounts, the pinned targets of every role, of `single` and of the model
 *   pool ({@link targetsOf}, inactive ones too), and with a team its pinned targets. Relative targets and main-account
 *   pool entries run on the main account and local targets are no account, so they add nothing; nor do accounts the
 *   lookup does not know (removed: no request can reach them).
 * - Holds when each company has at most one subscription in S and, for the main account's company, that subscription
 *   is the main account's (with a metered main, no subscription of its company at all).
 * - One subscription = one account, or the `codex` and `siwc` accounts of one ChatGPT login ({@link loginOf}); an
 *   unknown login is a subscription of its own, and a different login is always another subscription. So a team's
 *   ChatGPT 01 main may have an area on the `siwc` account of the same login.
 * - A pinned target of the main's company must be the main account itself: a subagent never runs on another slot of
 *   the main's company, not even the same login's sibling.
 * - `main: null` judges a preset being saved: its main may be any account of its group, so no subscription of the
 *   group's company may be pinned at all (`siwc` included).
 * The answer names the first offending account in S order, so the main and the team's accounts are never the one
 * named while a preset's target clashes with them.
 */
export function allowed(
  preset: Pick<Info, "group" | "workers">,
  main: AccountID | null,
  lookup: Lookup,
  team?: Team,
): Verdict {
  const own = main === null ? undefined : lookup(main)
  const home = own ? company(own) : isLocal(preset.group) ? undefined : company({ kind: preset.group })
  const targets = targetsOf(preset.workers)
  const subscriptions = [
    ...(team?.accounts ?? []).map((accountID) => ({ accountID, pinned: false })),
    ...[...pinnedAccounts(targets), ...pinnedAccounts(team?.pinned ?? [])].map((accountID) => ({
      accountID,
      pinned: true,
    })),
  ].flatMap((entry) => {
    const member = lookup(entry.accountID)
    return member?.billing === "subscription" ? [{ member, pinned: entry.pinned }] : []
  })
  const offender = subscriptions.find((entry, index) =>
    company(entry.member) === home
      ? entry.member.id !== main && (entry.pinned || own === undefined || !oneSubscription(entry.member, own))
      : subscriptions
          .slice(0, index)
          .some(
            (other) => company(other.member) === company(entry.member) && !oneSubscription(other.member, entry.member),
          ),
  )
  return offender ? { ok: false, accountID: offender.member.id } : { ok: true }
}

function pinnedAccounts(targets: ReadonlyArray<Target>) {
  return targets.flatMap((target) => ("pin" in target && !isLocal(target.pin.account) ? [target.pin.account] : []))
}

/**
 * The targets a preset uses now: the role rows for `by-role`, `single` for `single`, the pool's pinned entries for a
 * model pool, none for `same`. A pool entry on the main account is no target (a metered main's lighter models are not
 * counted, like its lighter pair).
 */
function inUse(workers: Workers): ReadonlyArray<Target> {
  const mode = modeOf(workers)
  if (mode === "single") return workers.single ? [workers.single] : []
  if (mode === "same") return []
  if (mode === "pool") return placesOf(workers).flatMap((place) => (place.pool ? place.targets : []))
  return ROLES.flatMap((role) => workers.roles[role]?.targets ?? [])
}

/** Whether a preset sends work to an account that costs money (metered or prepaid), a paid pool entry included. */
function paid(preset: Pick<Info, "workers">, lookup: Lookup) {
  return pinnedAccounts(inUse(preset.workers)).some((accountID) => {
    const billing = lookup(accountID)?.billing
    return billing === "metered" || billing === "prepaid"
  })
}

/**
 * A light preset (07 §5.1): delegation at most `요청할 때만` and no paid target. Only a light preset carries over to a
 * new session as `마지막에 쓴 것`.
 */
export function light(preset: Pick<Info, "workers" | "delegation">, lookup: Lookup) {
  return (["off", "model", "on-request"] as const).some((mode) => mode === preset.delegation) && !paid(preset, lookup)
}

/** A heavy preset (07 §5.1, §7.4): `적극적으로` or a paid target. Its sessions show a one-line banner. */
export function heavy(preset: Pick<Info, "workers" | "delegation">, lookup: Lookup) {
  return preset.delegation === "active" || paid(preset, lookup)
}

/**
 * Start of every gate rejection (07 §5.4). The gate writes the text into the subagent call's `agent`, core answers
 * `Unknown agent: <text>` as a tool failure, and own-web recognises the prefix to draw a neutral chip.
 */
export const REJECT_PREFIX = "own-preset:"

/** One of the three subagent caps (07 §2.6). */
export type Cap = keyof Caps

/**
 * Why the gate declined a call: a model outside the preset (listing roles, or a model pool's names), a paid target
 * over its budget, a paid target the user has not allowed in this conversation (`consent`), delegation `off`, a cap
 * reached (`max` = that cap), a per-call effort it cannot read (`effort`, listing {@link INTENTS}), or a per-call effort
 * above the ceiling (`effort-cap`, 07 §2.3: `max` = the highest level this target may run at now; `once` = the user may
 * allow more for this message, never for a paid target). A pool's list is never empty, so it never reads like the
 * `roles: []` text.
 */
export type Rejection =
  | { readonly reason: "model" | "budget" | "consent"; readonly roles: ReadonlyArray<Role> }
  | { readonly reason: "model"; readonly models: readonly [string, ...string[]] }
  | { readonly reason: "off" }
  | { readonly reason: "caps"; readonly cap: Cap; readonly max: number }
  | { readonly reason: "effort" }
  | { readonly reason: "effort-cap"; readonly max: string; readonly once: boolean }

/** First and last sentence of the rejections that list allowed roles between them. */
const LISTED = {
  model: ["model not in this preset.", "Ask the user if another model is needed."],
  budget: ["this model's monthly budget is used up.", "Ask the user if more budget is needed."],
  consent: [
    "this role would move to a paid API that the user has not allowed in this conversation.",
    "Ask the user if paid use is allowed.",
  ],
} as const

/** The cap sentences around the number. A per-message cap can be raised for one message (`raiseOnce`). */
const CAPPED: Readonly<Record<Cap, readonly [string, string]>> = {
  concurrent: [
    "at most ",
    " subagents may run at once. Continue other work or wait for a running subagent to finish, then retry.",
  ],
  perMessage: [
    "at most ",
    " new subagents per user message. Continue other work, or ask the user to allow more for this message.",
  ],
  perSession: ["at most ", " subagents per conversation. Ask the user if more subagents are needed."],
}

/** The effort ceiling's sentence before the level, and after it: `once` (the user may allow more) or a paid target. */
const EFFORT_CAP_HEAD = "reasoning effort above this session's limit. Allowed up to: "
const EFFORT_CAP_TAIL = {
  once: ". Use that or lower, or ask the user to allow more for this message.",
  paid: " (a pay-per-use model). Use that or lower; ask the user if more is needed.",
} as const

/**
 * The text the LLM reads for a declined subagent call (07 §5.4). It names role names or model pool names only, never
 * provider ids, account labels or prices (they change and are not the LLM's to pick), and ends by sending the LLM to
 * the user (or, for a cap, to other work), never to a file. {@link parse} reads it back.
 */
export function rejection(input: Rejection) {
  if (input.reason === "off")
    return `${REJECT_PREFIX} delegation is off in this session. Ask the user if subagents are needed.`
  if (input.reason === "caps") {
    const [head, tail] = CAPPED[input.cap]
    return `${REJECT_PREFIX} subagent cap reached: ${head}${input.max}${tail}`
  }
  if (input.reason === "effort")
    return `${REJECT_PREFIX} unknown reasoning effort. Valid levels: ${INTENTS.join(", ")}. Ask the user if another effort is needed.`
  if (input.reason === "effort-cap")
    return `${REJECT_PREFIX} ${EFFORT_CAP_HEAD}${input.max}${EFFORT_CAP_TAIL[input.once ? "once" : "paid"]}`
  const [head, tail] = LISTED[input.reason]
  if ("models" in input) return `${REJECT_PREFIX} ${head} Allowed models: ${input.models.join(", ")}. ${tail}`
  const roles = input.roles.length ? ` Allowed roles: ${input.roles.join(", ")}.` : ""
  return `${REJECT_PREFIX} ${head}${roles} ${tail}`
}

/**
 * The rejection a gate text stands for, the exact inverse of {@link rejection}: `parse(rejection(x))` equals `x`, and
 * any other text (core's `Unknown agent: ` wrapper included) is `undefined`.
 */
export function parse(text: string): Rejection | undefined {
  const candidates: Rejection[] = [
    { reason: "off" },
    ...(["model", "budget", "consent"] as const).flatMap((reason): Rejection[] => {
      const [head, tail] = LISTED[reason]
      const start = `${REJECT_PREFIX} ${head}`
      const end = ` ${tail}`
      if (!text.startsWith(start) || !text.endsWith(end) || text.length < start.length + end.length) return []
      const middle = text.slice(start.length, text.length - end.length)
      if (middle === "") return [{ reason, roles: [] }]
      const pooled = reason === "model" ? /^ Allowed models: (.+)\.$/.exec(middle)?.[1]?.split(", ") : undefined
      const [first, ...others] = pooled ?? []
      if (first !== undefined && pooled?.every(isPoolKey)) return [{ reason: "model", models: [first, ...others] }]
      const listed = /^ Allowed roles: (.+)\.$/.exec(middle)?.[1]?.split(", ") ?? []
      const roles = listed.flatMap((name) => ROLES.filter((role) => role === name))
      return roles.length && roles.length === listed.length ? [{ reason, roles }] : []
    }),
    ...(["concurrent", "perMessage", "perSession"] as const).flatMap((cap): Rejection[] => {
      const [head, tail] = CAPPED[cap]
      const start = `${REJECT_PREFIX} subagent cap reached: ${head}`
      if (!text.startsWith(start) || !text.endsWith(tail)) return []
      const number = text.slice(start.length, text.length - tail.length)
      return /^[1-9]\d*$/.test(number) ? [{ reason: "caps", cap, max: Number(number) }] : []
    }),
    { reason: "effort" },
    ...([true, false] as const).flatMap((once): Rejection[] => {
      const start = `${REJECT_PREFIX} ${EFFORT_CAP_HEAD}`
      const tail = EFFORT_CAP_TAIL[once ? "once" : "paid"]
      if (!text.startsWith(start) || !text.endsWith(tail)) return []
      const max = text.slice(start.length, text.length - tail.length)
      return /^[^\s()]+$/.test(max) ? [{ reason: "effort-cap", max, once }] : []
    }),
  ]
  return candidates.find((candidate) => rejection(candidate) === text)
}

/** Effort names in their usual order, used only to place an intent among a model's own levels (07 §2.3). */
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Client-only values that are never sent (07 §2.3, Appendix A): Codex's `ultra` mode and the `persistent` alias of a
 * Codex config, which Codex itself sends as `disabled`.
 */
const CLIENT_ONLY = ["ultra", "persistent"]

/** An effort fitted to a model: the variant to send (none = the provider default), and whether the intent had no place. */
export interface Fit {
  readonly variant?: string
  readonly unplaced: boolean
}

/**
 * An effort intent fitted to one model's levels (07 §2.3). The model's list order is its order (catalog `variants`;
 * for a Codex account with metadata, `meta`'s `supported_reasoning_levels` order over the variants the model offers,
 * {@link CodexModels.levels}; ⚠PG5 assumes low→high), without the client-only values.
 * - No intent or `default`: none.
 * - A level the model has (any name): that level.
 * - Else the intent is placed by the usual order and the model's next level above it is sent, or its highest known
 *   level when none is above (a GPT `xhigh` main sends `max` to DeepSeek's low/high/max).
 * - An intent the usual order does not know, or a model without known levels: none, with `unplaced` so the caller can
 *   say so. Unknown level names of a model are offered by name but never used to fit an intent.
 */
export function effortToVariant(
  intent: string | undefined,
  variants: ReadonlyArray<string>,
  meta?: CodexModels.Model,
): Fit {
  if (intent === undefined || intent === "default") return { unplaced: false }
  const levels = CodexModels.levels(meta, variants).filter((variant) => !CLIENT_ONLY.includes(variant))
  if (!CLIENT_ONLY.includes(intent) && levels.includes(intent)) return { variant: intent, unplaced: false }
  const rank = LEVELS.indexOf(intent)
  const known = levels.filter((variant) => LEVELS.includes(variant))
  const highest = known.at(-1)
  if (rank < 0 || highest === undefined) return { unplaced: true }
  return { variant: known.find((variant) => LEVELS.indexOf(variant) > rank) ?? highest, unplaced: false }
}

/**
 * What a conversation may ask one subagent call to run at (07 §2.3 대화에서 정하는 강도), the {@link Effort} values:
 * the level names in their usual order, `default` (send none) and `inherit` (the main's effort). A pinned model's own
 * level names are taken too, but only on that model.
 */
export const INTENTS: ReadonlyArray<string> = [...LEVELS, "default", "inherit"]

/**
 * A subagent call's `model` split into a target and a per-call effort (07 §2.3 대화에서 정하는 강도), the one reader
 * of every `#` the LLM writes, `provider/model#variant` included:
 * - no `#`, or two or more (left whole for the gate to decline as a model): `plain`, the value as it came;
 * - `<target>#<intent>`, or `#<intent>` with no target (the call runs where it would with `model` empty): `effort`;
 * - an empty intent or a client-only value (`ultra`, `persistent`): `invalid`, never an effort.
 * An intent outside {@link INTENTS} is checked against the target's levels later ({@link fitRequest}).
 */
export type EffortRequest =
  | { readonly type: "plain"; readonly target?: string }
  | { readonly type: "effort"; readonly target?: string; readonly intent: string }
  | { readonly type: "invalid" }

export function effortRequest(value: string | undefined): EffortRequest {
  const parts = value?.split("#") ?? []
  if (value === undefined || parts.length !== 2) return { type: "plain", ...(value ? { target: value } : {}) }
  const [target = "", intent = ""] = parts
  if (intent === "" || CLIENT_ONLY.includes(intent)) return { type: "invalid" }
  return { type: "effort", ...(target ? { target } : {}), intent }
}

/**
 * A per-call effort fitted to its target and checked against the ceiling (07 §2.3):
 * - `unknown`: an intent outside {@link INTENTS} that the model does not list either.
 * - The intent (`inherit` = the main's variant) is fitted by {@link effortToVariant}. A model without known levels
 *   sends none (`unplaced`, never a rejection).
 * - Lowering is always allowed: the fitted level at or below `base`, the variant the call sends without a request
 *   (the preset's effort fitted, `inherit` resolved). Levels compare by the usual order only; an unknown level name or
 *   none (the provider default) is never known to be lower.
 * - A raise is allowed up to `ceiling` (a level name; `undefined` = never above `base`). An intent within the ceiling
 *   whose fitted level is above it rounds down to the model's highest level within it, never below `base` (`capped`;
 *   DeepSeek's low/high/max under `xhigh` sends `high`). Sending none is a raise allowed only under a `max` ceiling.
 * - Anything else is over the ceiling: `max` = the highest level allowed on this model (`base`, `default` for none).
 */
export type RequestFit =
  | { readonly ok: true; readonly variant?: string; readonly unplaced: boolean; readonly capped: boolean }
  | { readonly ok: false; readonly reason: "unknown" }
  | { readonly ok: false; readonly reason: "cap"; readonly max: string }

export function fitRequest(input: {
  readonly intent: string
  readonly inherit?: string
  readonly base?: string
  readonly variants: ReadonlyArray<string>
  readonly meta?: CodexModels.Model
  readonly ceiling?: string
}): RequestFit {
  const levels = CodexModels.levels(input.meta, input.variants).filter((variant) => !CLIENT_ONLY.includes(variant))
  const intent = input.intent
  if (CLIENT_ONLY.includes(intent) || (!INTENTS.includes(intent) && !levels.includes(intent)))
    return { ok: false, reason: "unknown" }
  const placed = intent === "inherit" ? input.inherit : intent
  const fit = effortToVariant(placed, input.variants, input.meta)
  const sent = fit.variant
  const base = input.base
  const ok = (variant: string | undefined, capped = false): RequestFit => ({
    ok: true,
    ...(variant === undefined ? {} : { variant }),
    unplaced: fit.unplaced,
    capped,
  })
  const asked = rankOf(sent)
  const floor = rankOf(base)
  if (sent === base || (asked !== undefined && floor !== undefined && asked <= floor)) return ok(sent)
  const ceiling = rankOf(input.ceiling)
  if (ceiling !== undefined && asked !== undefined && asked <= ceiling) return ok(sent)
  if (ceiling === TOP && sent === undefined) return ok(sent)
  const within =
    ceiling === undefined ? undefined : levels.filter((level) => (rankOf(level) ?? Infinity) <= ceiling).at(-1)
  const allowed = within !== undefined && (floor === undefined || (rankOf(within) ?? -1) >= floor) ? within : base
  const wanted = rankOf(placed)
  if (ceiling !== undefined && wanted !== undefined && wanted <= ceiling && allowed !== undefined)
    return ok(allowed, true)
  return { ok: false, reason: "cap", max: allowed ?? "default" }
}

/** A level's place in the usual order; `undefined` for none or a name the order does not know. */
function rankOf(level: string | undefined) {
  const rank = level === undefined ? -1 : LEVELS.indexOf(level)
  return rank < 0 ? undefined : rank
}

/** The top of the usual order: a ceiling there allows any raise. */
const TOP = LEVELS.length - 1

/**
 * The highest level a per-call effort may raise a target to (07 §2.3): never above the preset's effort for a target
 * that costs money; else the preset's {@link effortMaxOf} (`off` = never above it), or `max` for the user message
 * the user allowed more for (`once`). `undefined` = no raise.
 */
export function effortCeiling(max: EffortMax, input: { readonly paid: boolean; readonly once: boolean }) {
  if (input.paid) return undefined
  if (input.once) return LEVELS[TOP]
  return max === "off" ? undefined : max
}

/**
 * The main's effort with ultra on (07 §2.9), given the main model's levels.
 * - `codex`, `siwc`, `oai` (OpenAI models): Codex's rule. The multi-agent effort (`multiAgent`, else `meta`'s
 *   `multi_agent_reasoning_effort`) when the model has it, else `max`, else the highest level that is not client-only,
 *   in `meta`'s level order when it has one (the rule of {@link CodexModels.ultraLevel}, over the offered variants).
 *   `ultra` is never sent; a model without levels sends none (`unplaced`). Codex metadata counts for `codex` and
 *   `oai`, the same OpenAI models (07 §2.9); a `siwc` login never reads it (07 §2.2), so its `meta` is ignored.
 * - `claude-sub`, `claude-agent`, `anth`: unchanged (`current`, ultracode is a toggle apart from effort), or the
 *   `xhigh` intent when the user ticked `켤 때 강도도 xhigh로` (`raiseClaude`), only ever up: an effort at `xhigh` or
 *   above, or one the fitted level would not raise, stays ({@link raisesClaude}, UC 2026-10-18).
 * - Every other group has no tool to follow: the `xhigh` intent (DeepSeek: `max`).
 */
export function ultraEffort(
  group: Group,
  variants: ReadonlyArray<string>,
  input: {
    readonly current?: string
    readonly multiAgent?: string
    readonly raiseClaude?: boolean
    readonly meta?: CodexModels.Model
  } = {},
): Fit {
  if (group === "claude-sub" || group === "claude-agent" || group === "anth") {
    const kept: Fit = input.current === undefined ? { unplaced: false } : { variant: input.current, unplaced: false }
    if (!input.raiseClaude || !raisesClaude(input.current)) return kept
    const raised = effortToVariant("xhigh", variants)
    const above =
      raised.variant !== undefined &&
      (input.current === undefined || LEVELS.indexOf(raised.variant) > LEVELS.indexOf(input.current))
    return above ? raised : kept
  }
  if (!Kind.isOAuth(group) && group !== "oai") return effortToVariant("xhigh", variants)
  const meta = group === "codex" || group === "oai" ? input.meta : undefined
  const levels = CodexModels.levels(meta, variants).filter((variant) => !CLIENT_ONLY.includes(variant))
  const multiAgent = input.multiAgent ?? meta?.multi_agent_reasoning_effort ?? undefined
  const pick = [multiAgent, "max"].find((level) => level !== undefined && levels.includes(level)) ?? levels.at(-1)
  return pick === undefined ? { unplaced: true } : { variant: pick, unplaced: false }
}

/**
 * Whether Claude's `켤 때 강도도 xhigh로` can raise this effort (07 §2.9, UC 2026-10-18): none set, or a level of the
 * usual order below `xhigh`. At `xhigh` or above (or a level name the order does not know) ultra keeps it, so the
 * box is off there.
 */
export function raisesClaude(current: string | undefined) {
  if (current === undefined) return true
  const rank = LEVELS.indexOf(current)
  return rank >= 0 && rank < LEVELS.indexOf("xhigh")
}

/**
 * One row of a group's lighter-pair table (07 §4.2, `presets.json` `groups[g].lighter[<mainModelID>]`). `source`:
 * `auto` = decided once by {@link lighterPick} and never recomputed (U3; absent in older files means `auto`), `user`
 * = chosen by the user, `none` = the main is already the cheapest family, so the role runs like the main. `missing`:
 * the pair's model is gone; the role then runs like the main until the user fixes it.
 */
export interface Lighter extends Schema.Schema.Type<typeof Lighter> {}
export const Lighter = Schema.Struct({
  model: Model.ID,
  source: optional(Schema.Literals(["auto", "user", "none"])),
  missing: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Preset.Lighter" })

/**
 * The lighter pair of a main model (07 §4.2), from the main account's models (`candidates`, so without mode entries,
 * `deprecated` or `alpha`, priced like 07 §3.4): the newest model of the cheapest family that is cheaper than the
 * main, each family priced by its newest model. Tool-less models and the main's own family are left out. The main
 * already in the cheapest family pairs with itself (`none`). `undefined` when it cannot be decided: a local group (no
 * prices; the user picks), or a main whose price is unknown.
 */
export function lighterPick(group: Group, main: string, models: ReadonlyArray<Candidate>): Lighter | undefined {
  if (isLocal(group)) return undefined
  const own = models.find((model) => model.id === main)
  const price = own?.price
  if (own === undefined || price === undefined) return undefined
  const family = (model: Candidate) => model.family ?? model.id
  const heads = [
    ...Map.groupBy(
      models.filter((model) => model.tools !== false && family(model) !== family(own)),
      family,
    ).values(),
  ].flatMap((list) => list.toSorted((a, b) => b.released - a.released || a.id.localeCompare(b.id))[0] ?? [])
  const cheaper = heads.flatMap((model) =>
    model.price !== undefined && model.price < price ? [{ model, price: model.price }] : [],
  )
  const pick = cheaper.toSorted(
    (a, b) => a.price - b.price || b.model.released - a.model.released || a.model.id.localeCompare(b.model.id),
  )[0]?.model
  return pick ? { model: Model.ID.make(pick.id), source: "auto" } : { model: Model.ID.make(main), source: "none" }
}

/**
 * Why a target was skipped (07 §4.2, §4.3): its model is not usable now (gone, exhausted, auth failing, a local server
 * off …), it breaks R4 with the binding's team, the group has no lighter pair for this main yet, or the pair is gone.
 */
export const Skip = Schema.Literals(["unavailable", "r4", "lighter-unknown", "lighter-missing"]).annotate({
  identifier: "Own.Preset.Skip",
})
export type Skip = typeof Skip.Type

/** How one target resolved now: the Ref a call would run on, or why it is skipped. */
export interface Resolved extends Schema.Schema.Type<typeof Resolved> {}
export const Resolved = Schema.Struct({
  target: Target,
  ref: optional(Model.Ref),
  skip: optional(Skip),
  /** The effort had no place on the model's levels, so none is sent (07 §2.3); the role row says so. */
  unplaced: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Preset.Resolved" })

/**
 * One role, resolved: each target in order, and the Ref the role uses now (the first usable target, else the main's
 * Ref: `fallback`, 07 §1.2). A role without targets runs like the main and is no fallback.
 */
export interface RoleResolution extends Schema.Schema.Type<typeof RoleResolution> {}
export const RoleResolution = Schema.Struct({
  targets: Schema.Array(Resolved),
  use: Model.Ref,
  fallback: Schema.Boolean,
}).annotate({ identifier: "Own.Preset.RoleResolution" })

/**
 * What a model pool entry runs on and costs (07 §3.3 모델 묶음): `runs` and `company` from the registry, `price` the
 * raw ranking input price (07 §3.4, never Codex's priority order). Decided whether or not the entry can run now, so
 * a limit, a budget, a local server or a team never changes the guidance. Absent `runs` = the account is unknown: the
 * card says nothing about money and the default rule never picks the entry.
 */
export interface PoolSide extends Schema.Schema.Type<typeof PoolSide> {}
export const PoolSide = Schema.Struct({
  runs: optional(PoolRuns),
  company: optional(Schema.String),
  price: optional(Schema.Number),
}).annotate({ identifier: "Own.Preset.PoolSide" })

/** The main's side for a model pool: the same facts, and whether the main is a local model. */
export interface PoolMain extends Schema.Schema.Type<typeof PoolMain> {}
export const PoolMain = Schema.Struct({ ...PoolSide.fields, local: Schema.Boolean }).annotate({
  identifier: "Own.Preset.PoolMain",
})

/** One model pool entry resolved now: the Ref a call would run on, or why it is skipped, with its facts. */
export interface PoolResolved extends Schema.Schema.Type<typeof PoolResolved> {}
export const PoolResolved = Schema.Struct({
  key: Schema.String,
  ref: optional(Model.Ref),
  skip: optional(Skip),
  unplaced: optional(Schema.Boolean),
  ...PoolSide.fields,
}).annotate({ identifier: "Own.Preset.PoolResolved" })

/** A model pool resolved against a main: the main's facts and each entry in pool order. */
export interface PoolResolution extends Schema.Schema.Type<typeof PoolResolution> {}
export const PoolResolution = Schema.Struct({
  main: PoolMain,
  entries: Schema.Array(PoolResolved),
}).annotate({ identifier: "Own.Preset.PoolResolution" })

/**
 * A preset resolved against a main (07 §4.2, §7.1's last line): every role, `single` mode included, and for a model
 * pool preset its entries (`pool`, absent for every other preset so their resolution keeps its bytes).
 */
export interface Resolution extends Schema.Schema.Type<typeof Resolution> {}
export const Resolution = Schema.Struct({
  main: Model.Ref,
  roles: keyedRecord(Role, RoleResolution),
  pool: optional(PoolResolution),
}).annotate({ identifier: "Own.Preset.Resolution" })

/**
 * The main a preset resolves against: its account (`local:<id>` for a local provider), Ref and the model's levels,
 * with the model's Codex metadata on a `codex` account (its level order, 07 §2.3).
 */
export interface Main {
  readonly account: string
  readonly ref: Model.Ref
  readonly variants: ReadonlyArray<string>
  readonly meta?: CodexModels.Model
}

/**
 * A model an account or local provider offers now: the provider to send it to and the model's levels, with the
 * model's Codex metadata on a `codex` account.
 */
export interface Offered {
  readonly providerID: string
  readonly variants: ReadonlyArray<string>
  readonly meta?: CodexModels.Model
}

/**
 * What {@link resolve} reads of the live registry and catalog: the model as `account` offers it now, or why not
 * (`undefined` = `unavailable`). The service applies 02 §5.7's filters and the binding team's R4 here.
 */
export type Catalog = (account: string, model: string) => Offered | "unavailable" | "r4" | undefined

/**
 * A preset's targets as Refs for this main (07 §4.2), the same code on the server and in the editor preview.
 * - `{rel:"main"}`: the main's Ref; a role effort other than `inherit` is fitted to the main model's levels.
 * - `{rel:"lighter"}`: the main account with the group's lighter pair for the main model (`lighter`, keyed by main
 *   model id); the pair `none` runs like the main.
 * - `{pin}`: that model of that account or local provider.
 * - Effort: `inherit` fits the main's variant to the target model, `default` sends none, a level is fitted (2.3), in
 *   Codex's level order for a model that comes with Codex metadata.
 * A skipped target hands over to the next; when all are skipped the role runs on the main's Ref. Nothing outside the
 * list is ever picked (no other provider or model).
 */
export function resolve(
  preset: Pick<Info, "workers">,
  main: Main,
  catalog: Catalog,
  lighter: Readonly<Record<string, Lighter>> = {},
): Resolution {
  const workers = preset.workers
  const mode = modeOf(workers)
  const entryOf = (role: Role): RoleEntry | undefined => {
    if (mode === "by-role") return workers.roles[role]
    if (mode === "single" && workers.single) return { targets: [workers.single], effort: "inherit" }
    return undefined
  }
  const roles = Object.fromEntries(
    ROLES.map((role): [Role, RoleResolution] => {
      const entry = entryOf(role)
      if (!entry?.targets.length) return [role, { targets: [], use: main.ref, fallback: false }]
      const targets = entry.targets.map((target) => resolveTarget(target, entry.effort, main, catalog, lighter))
      const used = targets.find((item) => item.ref !== undefined)?.ref
      return [role, { targets, use: used ?? main.ref, fallback: used === undefined }]
    }),
  )
  if (mode !== "pool") return { main: main.ref, roles }
  // A model pool (07 §3.3): every role runs like the main unless the LLM (or the default rule) names an entry. An
  // entry without an account is the main account's model; its facts are the service's to add (`PoolSide`).
  const entries = (workers.pool ?? []).map((entry): PoolResolved => {
    const effort = entry.effort ?? "inherit"
    const resolved =
      entry.account === undefined && entry.model === main.ref.id
        ? likeMain(effort, main)
        : resolveOn(entry.account ?? main.account, entry.model, effort, main, catalog)
    return { key: entry.key, ...resolved }
  })
  return { main: main.ref, roles, pool: { main: { local: isLocal(main.account) }, entries } }
}

function resolveTarget(
  target: Target,
  effort: Effort,
  main: Main,
  catalog: Catalog,
  lighter: Readonly<Record<string, Lighter>>,
): Resolved {
  if ("pin" in target) return { target, ...resolveOn(target.pin.account, target.pin.model, effort, main, catalog) }
  if (target.rel === "main") return { target, ...likeMain(effort, main) }
  const pair = lighter[main.ref.id]
  if (!pair) return { target, skip: "lighter-unknown" }
  if (pair.missing) return { target, skip: "lighter-missing" }
  if (pair.source === "none" || pair.model === main.ref.id) return { target, ...likeMain(effort, main) }
  return { target, ...resolveOn(main.account, pair.model, effort, main, catalog) }
}

/** A resolved target without the target itself. */
type Placed = Omit<Resolved, "target">

/** `model` as `account` offers it now, its effort fitted to the model's levels; else why it is skipped. */
function resolveOn(account: string, model: string, effort: Effort, main: Main, catalog: Catalog): Placed {
  const found = catalog(account, model)
  if (found === undefined || typeof found === "string") return { skip: found ?? "unavailable" }
  return placedOn(found.providerID, model, found.variants, found.meta, effort, main)
}

/** The main's Ref; an effort other than `inherit` fitted to the main model's levels. */
function likeMain(effort: Effort, main: Main): Placed {
  return effort === "inherit"
    ? { ref: main.ref }
    : placedOn(main.ref.providerID, main.ref.id, main.variants, main.meta, effort, main)
}

/** A Ref on `providerID` with the effort fitted (2.3): `inherit` fits the main's variant, `default` sends none. */
function placedOn(
  providerID: string,
  model: string,
  variants: ReadonlyArray<string>,
  meta: CodexModels.Model | undefined,
  effort: Effort,
  main: Main,
): Placed {
  const fit = effortToVariant(effort === "inherit" ? main.ref.variant : effort, variants, meta)
  const ref = {
    providerID: Provider.ID.make(providerID),
    id: Model.ID.make(model),
    ...(fit.variant === undefined ? {} : { variant: Model.VariantID.make(fit.variant) }),
  }
  return { ref, ...(fit.unplaced ? { unplaced: true } : {}) }
}

/**
 * What the guidance may say about where a role runs (07 §3.3): its rough relation to the main, what it runs on, and
 * another company's canonical provider id when it is not the main's company. Never a model name, window, price,
 * account label or slot id, so switching the main within a tier keeps the text (and the cached prefix) the same.
 */
export interface Card {
  readonly relation: "same" | "lighter" | "similar" | "stronger"
  readonly runs: "main" | "subscription" | "paid" | "local"
  readonly company?: string
}

/** The card of a role that runs like the main (`메인과 같게`), and of every role the input leaves out. */
export const MAIN_CARD: Card = { relation: "same", runs: "main" }

/** A target's rough relation to the main (07 §3.3). */
export type Relation = Card["relation"]

/**
 * A model pool entry's relation to the main (07 §3.3 모델 묶음), one rule for the guidance, the gate and the editor
 * preview over the same raw prices ({@link PoolSide}):
 * 1. a main-account entry on the main's own model is `same`;
 * 2. with both prices: cheaper `lighter`, dearer `stronger`, equal `similar`;
 * 3. a local entry against a hosted main is `lighter`, a hosted entry against a local main `stronger`;
 * 4. anything else `similar`.
 */
export function poolRelation(
  entry: { readonly account?: string; readonly model: string; readonly side: PoolSide },
  main: { readonly model: string; readonly side: PoolMain },
): Relation {
  if (entry.account === undefined && entry.model === main.model) return "same"
  const price = entry.side.price
  const against = main.side.price
  if (price !== undefined && against !== undefined)
    return price < against ? "lighter" : price > against ? "stronger" : "similar"
  const local = entry.side.runs === "local"
  if (local && !main.side.local) return "lighter"
  if (!local && main.side.local) return "stronger"
  return "similar"
}

/**
 * One entry as the default rule sees it: its facts and relation, whether it can take a call now (`usable`: it
 * resolves, and a paid one has budget left) and whether its window is known (`verified`: a local model's running
 * window; always true for a hosted one).
 */
export interface PoolChoice {
  readonly key: string
  readonly side: PoolSide
  readonly relation: Relation
  readonly usable: boolean
  readonly verified: boolean
}

/** The roles the default rule picks for (07 §3.3 U7a); every other agent runs as it would without a pool. */
export const POOL_DEFAULT_ROLES = [
  "explore",
  "own-quick",
  "own-review",
  "own-deep",
] as const satisfies ReadonlyArray<Role>

/**
 * The default rule (07 §3.3 U7a) for a call that names no model: the entry the agent runs on, `undefined` = like the
 * main (`general` and every other agent are never picked for). Candidates are usable, verified, of known `runs`, not
 * `paid` and not `same`; ties go to pool order.
 * - `explore`, `own-quick`: a `lighter` free entry (`main`, `subscription`, `local`), the cheapest priced first, then
 *   the first unpriced; else the cheapest `lighter` `main-paid` entry (a metered main's cheaper model saves money).
 * - `own-review`: the dearest free entry of another company than the main's (unpriced last); with a local main every
 *   entry of a company counts.
 * - `own-deep`: the dearest `stronger` free entry (unpriced last).
 */
export function poolPick(agent: string, choices: ReadonlyArray<PoolChoice>, main: PoolMain): string | undefined {
  const open = choices.filter(
    (choice) =>
      choice.usable &&
      choice.verified &&
      choice.side.runs !== undefined &&
      choice.side.runs !== "paid" &&
      choice.relation !== "same",
  )
  const free = open.filter((choice) => choice.side.runs !== "main-paid")
  if (agent === "explore" || agent === "own-quick")
    return (
      byPrice(
        free.filter((choice) => choice.relation === "lighter"),
        1,
      )[0]?.key ??
      byPrice(
        open.filter((choice) => choice.side.runs === "main-paid" && choice.relation === "lighter"),
        1,
      )[0]?.key
    )
  if (agent === "own-review")
    return byPrice(
      free.filter((choice) => choice.side.company !== undefined && choice.side.company !== main.company),
      -1,
    )[0]?.key
  if (agent === "own-deep")
    return byPrice(
      free.filter((choice) => choice.relation === "stronger"),
      -1,
    )[0]?.key
  return undefined
}

/** Priced entries first, by price in `order` (1 cheapest first, −1 dearest first), then unpriced; ties keep order. */
function byPrice(list: ReadonlyArray<PoolChoice>, order: 1 | -1) {
  const rank = (choice: PoolChoice) => (choice.side.price === undefined ? Infinity : choice.side.price * order)
  return list
    .map((choice, index) => ({ choice, index }))
    .toSorted((a, b) => rank(a.choice) - rank(b.choice) || a.index - b.index)
    .map((item) => item.choice)
}

/** One model pool entry with what the guidance and the default rule read of it. */
export interface PoolFacts {
  readonly key: string
  readonly model: string
  readonly account?: string
  readonly note?: string
  readonly card?: PoolCard
  readonly side: PoolSide
}

/**
 * The static default rule (07 §3.3): {@link poolPick} for the four roles with every entry usable and a local one
 * verified as its frozen card says, so the guidance and the editor preview never follow a limit or a budget.
 */
export function poolDefaults(
  entries: ReadonlyArray<PoolFacts>,
  main: { readonly model: string; readonly side: PoolMain },
): Partial<Record<Role, string>> {
  const choices = entries.map((entry) => ({
    key: entry.key,
    side: entry.side,
    relation: poolRelation(entry, main),
    usable: true,
    verified: entry.card?.windowVerified !== false,
  }))
  return Object.fromEntries(
    POOL_DEFAULT_ROLES.flatMap((role) => {
      const key = poolPick(role, choices, main.side)
      return key === undefined ? [] : [[role, key] as const]
    }),
  )
}

/** The model pool part of {@link GuidanceInput}: each entry with its relation, and the static default rule. */
export interface PoolGuidance {
  readonly entries: ReadonlyArray<Pick<PoolFacts, "key" | "card" | "note" | "side">>
  readonly relation: Readonly<Record<string, Relation>>
  readonly defaults: Partial<Readonly<Record<Role, string>>>
}

/** The guidance input of a model pool, from its entries' facts and the main's (07 §3.3). */
export function poolGuidance(
  entries: ReadonlyArray<PoolFacts>,
  main: { readonly model: string; readonly side: PoolMain },
): PoolGuidance {
  return {
    entries: entries.map((entry) => ({
      key: entry.key,
      side: entry.side,
      ...(entry.card === undefined ? {} : { card: entry.card }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    })),
    relation: Object.fromEntries(entries.map((entry) => [entry.key, poolRelation(entry, main)])),
    defaults: poolDefaults(entries, main),
  }
}

export interface GuidanceInput {
  readonly delegation: Delegation
  /** Ultra delegates actively whatever the preset says (07 §2.9). */
  readonly ultra: boolean
  /** The caps in force ({@link caps}). */
  readonly caps: Caps
  /** Each role's first configured target; a temporary fallback never changes a card (07 §3.3). */
  readonly cards: Partial<Readonly<Record<Role, Card>>>
  /** A model pool preset's entries (07 §3.3 모델 묶음); they replace the role cards. */
  readonly pool?: PoolGuidance
  /**
   * Add the static per-call effort line (07 §2.3 대화에서 정하는 강도): the preset lets a conversation raise efforts
   * (`effortMaxOf` is not `off`). Never in an `off` entry or when there is no entry at all (`평소대로`, 07 §2.7).
   */
  readonly effort?: boolean
}

/** The `own.preset` instruction entry: its text and the hash the binding keeps (`entryHash`). */
export interface Guidance {
  readonly text: string
  readonly hash: string
}

const HEADER =
  "Session delegation instruction, set by the user for this session. Follow it like AGENTS.md instructions."

const REPLACES = "This replaces any earlier instruction that allows subagents only on explicit request."
const SPLIT =
  "When work splits into independent parts, or an independent second look would improve quality, delegate with the subagent tool."
const FIRST =
  "Research, exploration and review go to subagents first; use background=true when you can keep working meanwhile."
const OWN_WORK = "Keep small or tightly coupled changes yourself. The user's requests override this mode."

/**
 * The delegation paragraph of each mode (07 §2.5, §3.3). `도움될 때` is `적극적으로` without the "subagents first,
 * in the background" sentence, which is what 2.5 says `적극적으로` adds. `model` adds none.
 */
const PARAGRAPH: Readonly<Record<Exclude<Delegation, "off" | "model">, string>> = {
  "on-request":
    "Delegation mode: on request. Spawn subagents only when the user or AGENTS.md/skill instructions ask for it. This replaces any earlier delegation mode.",
  "when-useful": `Delegation mode: when useful. ${REPLACES} ${SPLIT} ${OWN_WORK}`,
  active: `Delegation mode: active. ${REPLACES} ${SPLIT} ${FIRST} ${OWN_WORK}`,
}

const OFF = "Delegation mode: off. Do not use the subagent tool in this session."

const ROLE_HEADER =
  "Subagent roles. Pass the role as `agent` and leave `model` empty; the session maps each role to its model."

/** Role cards in the order the LLM reads them: `general` first as the baseline. */
const CARD_ORDER: ReadonlyArray<Role> = ["general", "explore", "own-review", "own-quick", "own-deep"]

const PURPOSE: Readonly<Record<Role, string>> = {
  general: "Parallel implementation.",
  explore: "Read-only search.",
  "own-review": "Read-only review.",
  "own-quick": "Quick, simple tasks.",
  "own-deep": "Hard problems that need deeper reasoning.",
}

/** Display names of the companies (`Kind.meta[kind].canonical`); an unknown id is shown as it is. */
const COMPANY: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  xai: "xAI",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible",
}

/**
 * The per-call effort line (07 §2.3 대화에서 정하는 강도). Static: it names no current effort or ceiling, so changing
 * the main, its effort or the ceiling's level never changes the guidance bytes.
 */
const EFFORT_LINE = [
  "Reasoning effort: the user lets you choose a subagent's reasoning effort in this session.",
  `Append \`#<level>\` to \`model\`: \`#low\` alone keeps the subagent's usual model, \`<name>#high\` also names one (levels: ${INTENTS.join(", ")}).`,
  "Use a lower effort for simple work; a raise is allowed only within the limit this session allows, and a call over it is declined.",
].join(" ")

/**
 * The `own.preset` guidance (07 §3.3): English for the LLM, about 1 KB, the same bytes for the same input.
 * - `off`: the header and the off sentence only.
 * - Otherwise the mode's paragraph (none for `model`), then role cards, the effort line when `effort` is set, and the
 *   caps line. Cards list `general` and every role whose card differs from `general`'s (so `explore`, already in the
 *   tool description, only when its target differs); with no such role there are no cards.
 * - `model` with no cards: `null`, no entry at all (core then says the entry no longer applies).
 */
export function renderGuidance(input: GuidanceInput): Guidance | null {
  const mode = input.ultra ? "active" : input.delegation
  if (mode === "off") return guidance([[HEADER, OFF]])
  const cardOf = (role: Role) => input.cards[role] ?? MAIN_CARD
  const listed = cardRoles(input.cards)
  const cards = input.pool
    ? poolLines(input.pool)
    : listed.length > 1
      ? [ROLE_HEADER, ...listed.map((role) => `- ${role}: ${describe(cardOf(role))} ${PURPOSE[role]}`)]
      : []
  if (mode === "model" && cards.length === 0) return null
  const capped = [
    `Caps: at most ${input.caps.concurrent} subagents running at once, at most ${input.caps.perMessage} per user message.`,
    "A call over a cap is declined; continue other work or wait for a running subagent to finish, then retry.",
  ].join(" ")
  return guidance([
    mode === "model" ? [HEADER] : [HEADER, PARAGRAPH[mode]],
    [...cards, ...(input.effort ? [EFFORT_LINE] : []), capped],
  ])
}

/** The roles with a card, in reading order: `general` and every role whose card differs from `general`'s. */
function cardRoles(cards: GuidanceInput["cards"]) {
  const cardOf = (role: Role) => cards[role] ?? MAIN_CARD
  const general = cardOf("general")
  return CARD_ORDER.filter((role) => role === "general" || !sameCard(cardOf(role), general))
}

/**
 * The roles the main is told it can delegate to (07 §2.4, §3.3), in {@link ROLES} order: `explore` and `general`,
 * which the subagent tool lists itself, and the hidden `own-*` roles the `own.preset` guidance names (a model pool's
 * header names all of them; role cards only those whose card differs from `general`'s). Delegation `off` (without
 * ultra) names none: the main does not delegate.
 */
export function namedRoles(input: Pick<GuidanceInput, "delegation" | "ultra" | "cards" | "pool">): ReadonlyArray<Role> {
  if (!input.ultra && input.delegation === "off") return []
  const carded = input.pool ? ROLES : cardRoles(input.cards)
  return ROLES.filter((role) => role === "explore" || role === "general" || carded.includes(role))
}

const POOL_HEADER = [
  "Subagent models. The user chose the models below for subagents in this session, so naming one as `model` is the user's explicit request.",
  "Pass the kind of work as `agent` (explore: read-only search; own-review: read-only review; own-quick: quick, simple tasks; own-deep: hard problems; general: anything else) and one name below as `model`.",
].join(" ")

const COSTS = "it costs the user money. Use it only when no subscription or local model here can do the task"

/** What a pool card says an entry runs on (07 §3.3); a local entry says it in place of the company. */
const RUNS: Readonly<Record<PoolRuns, string>> = {
  main: "on your own account and limits",
  "main-paid": `on your own pay-per-use account, like you: ${COSTS}`,
  subscription: "on the user's subscription",
  paid: `on a pay-per-use API key: ${COSTS}`,
  local: "a local model on the user's machine, free; speed depends on the machine",
}

/** The order of the relation groups in the `Compared with you` line. */
const RELATIONS: ReadonlyArray<Relation> = ["lighter", "similar", "stronger", "same"]

/** The roles of the default-rule line, `general` last (it always runs like the main). */
const DEFAULT_LINE: ReadonlyArray<Role> = [...POOL_DEFAULT_ROLES, "general"]

/**
 * The model pool block (07 §3.3 모델 묶음): the header, one card per entry in pool order, the relation line and the
 * default-rule line. Cards name the entry, the company and what it runs on, the window and capabilities, Codex's
 * description and the user's note; never an account label, slot or provider id, a price, a budget or a limit.
 */
function poolLines(pool: PoolGuidance): string[] {
  const relationOf = (key: string) => pool.relation[key] ?? "similar"
  const order = pool.entries.map((entry, index) => ({ key: entry.key, price: entry.side.price, index }))
  const groups = RELATIONS.flatMap((relation) => {
    const keys = order
      .filter((entry) => relationOf(entry.key) === relation)
      .toSorted((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.index - b.index)
      .map((entry) => entry.key)
    return keys.length ? [`${relation}: ${keys.join(", ")}`] : []
  })
  const defaults = [...Map.groupBy(DEFAULT_LINE, (role) => (role === "general" ? undefined : pool.defaults[role]))]
    .map(([key, roles]) => `${listed(roles)} ${roles.length > 1 ? "use" : "uses"} ${key ?? "your own model"}`)
    .join("; ")
  return [
    POOL_HEADER,
    ...pool.entries.map((entry) => `- ${entry.key}: ${poolCard(entry)}`),
    `Compared with you: ${groups.join("; ")}.`,
    `Leave \`model\` empty to let the session choose: ${defaults}.`,
  ]
}

/** One pool card's text after its key (07 §3.3 카드 한 줄). */
function poolCard(entry: Pick<PoolFacts, "card" | "note" | "side">): string {
  const card = entry.card
  const runs = entry.side.runs
  const local = runs === "local"
  const company = entry.side.company
  const name = card?.name === undefined ? "" : oneLine(card.name, 60)
  const head = [
    ...(name ? [name] : []),
    ...(local || company === undefined ? [] : [COMPANY[company] ?? company]),
    ...(runs === undefined ? [] : [RUNS[runs]]),
  ]
  const window = card?.window
  const span =
    local && card?.windowVerified === false
      ? ["Context not verified."]
      : window === undefined
        ? []
        : [local ? `${amount(window)} context as running.` : `About ${amount(window)} context.`]
  const abilities = [...(card?.reasoning ? ["reasoning levels"] : []), ...(card?.image ? ["image input"] : [])]
  const summary = card?.summary === undefined ? "" : oneLine(card.summary, 120)
  const note = entry.note === undefined ? "" : oneLine(entry.note, 120)
  return [
    ...(head.length ? [`${head.join(", ")}.`] : []),
    ...span,
    ...(abilities.length ? [`${capitalized(abilities.join(", "))}.`] : []),
    ...(summary ? [`Codex: '${summary}'`] : []),
    ...(note ? [`Note from the user: '${note}'`] : []),
  ].join(" ")
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: ReadonlyArray<string>) {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

function capitalized(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A token count in two significant digits: `870k`, `1M`, `33k`. */
function amount(tokens: number) {
  const rounded = Number(tokens.toPrecision(2))
  if (rounded >= 1e6) return `${Number((rounded / 1e6).toPrecision(2))}M`
  if (rounded >= 1e3) return `${Number((rounded / 1e3).toPrecision(2))}k`
  return `${rounded}`
}

/**
 * A text the guidance quotes as data (a model name, Codex's description, the user's note), as one line: control
 * characters and line breaks become spaces, backticks go, double quotes become single ones, runs of spaces become one,
 * and the result is cut to `max` characters. Applied when rendering, so a hand-edited value is cleaned too.
 */
export function oneLine(text: string, max: number) {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replaceAll("`", "")
    .replaceAll('"', "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim()
}

function sameCard(a: Card, b: Card) {
  return a.relation === b.relation && a.runs === b.runs && a.company === b.company
}

function describe(card: Card) {
  if (card.runs === "main" && card.relation === "same") return "same model and reasoning effort as you."
  const local = card.runs === "local"
  const noun =
    card.relation === "lighter"
      ? `a lighter, faster ${local ? "local model" : "model"}`
      : local
        ? "a local model"
        : "a model"
  const from = local
    ? ""
    : card.company === undefined
      ? " from your own provider"
      : ` from another company (${COMPANY[card.company] ?? card.company})`
  const where = {
    main: " on the same account",
    subscription: " on the user's subscription",
    paid: " on a pay-per-use API",
    local: " on the user's machine",
  }[card.runs]
  const tail = {
    same: ", the same model as you",
    lighter: "",
    similar: ", about as strong as you",
    stronger: ", at least as strong as you",
  }[card.relation]
  return `${noun}${from}${where}${tail}.`
}

function guidance(blocks: ReadonlyArray<ReadonlyArray<string>>): Guidance {
  const text = blocks.map((lines) => lines.join("\n")).join("\n\n")
  return { text, hash: hash(text) }
}

/** FNV-1a 64 of the UTF-8 bytes: a change marker for the entry (not a secret), the same in the browser and Bun. */
function hash(text: string) {
  const value = new TextEncoder()
    .encode(text)
    .reduce((acc, byte) => BigInt.asUintN(64, (acc ^ BigInt(byte)) * 0x100000001b3n), 0xcbf29ce484222325n)
  return `fnv1a64:${value.toString(16).padStart(16, "0")}`
}

/**
 * Where a starter or a suggestion puts a role, relative to the main (07 §3.4): like the main, the main account's
 * lighter pair, the strongest model of another company's subscription, or a local model whose running window is
 * verified. The service fills the last two from the live catalog at that moment.
 */
export const Fill = Schema.Literals(["main", "lighter", "other-company", "local"]).annotate({
  identifier: "Own.Preset.Fill",
})
export type Fill = typeof Fill.Type

/** The three starters of the editor (07 §3.4): `가볍게 나눠 쓰기`, `다른 회사 리뷰`, `로컬로 탐색`. */
export const Starter = Schema.Literals(["light-split", "cross-review", "local-explore"]).annotate({
  identifier: "Own.Preset.Starter",
})
export type Starter = typeof Starter.Type

/** Starters as data relative to the main; each delegates `도움될 때`. */
export const STARTERS: Readonly<
  Record<Starter, { readonly name: string; readonly roles: Partial<Readonly<Record<Role, Fill>>> }>
> = {
  "light-split": { name: "가볍게 나눠 쓰기", roles: { explore: "lighter", "own-quick": "lighter" } },
  "cross-review": { name: "다른 회사 리뷰", roles: { "own-review": "other-company" } },
  "local-explore": { name: "로컬로 탐색", roles: { explore: "local" } },
}

/** Each role's suggestion in order of preference (07 §2.4 자동 제안); with none usable the role runs like the main. */
const SUGGESTED: Readonly<Record<Role, ReadonlyArray<Fill>>> = {
  explore: ["local", "lighter"],
  general: ["main"],
  "own-review": ["other-company", "main"],
  "own-quick": ["lighter", "local"],
  "own-deep": ["main"],
}

/** Why a starter cannot be used now (shown with it, greyed): a local group has no lighter pair, nothing to pin. */
export const StarterProblem = Schema.Literals(["local-group", "no-other-subscription", "no-local"]).annotate({
  identifier: "Own.Preset.StarterProblem",
})
export type StarterProblem = typeof StarterProblem.Type

export interface StarterView extends Schema.Schema.Type<typeof StarterView> {}
export const StarterView = Schema.Struct({
  template: Starter,
  name: Schema.String,
  available: Schema.Boolean,
  problem: optional(StarterProblem),
}).annotate({ identifier: "Own.Preset.StarterView" })

/**
 * A model the pool editor offers (07 §3.4 모델 묶음): a pool entry with its frozen card and stable key, its facts
 * ({@link PoolSide}) and its release time. No `account` = the main account's model.
 */
export interface PoolCandidate extends Schema.Schema.Type<typeof PoolCandidate> {}
export const PoolCandidate = Schema.Struct({
  ...PoolEntry.fields,
  ...PoolSide.fields,
  released: optional(Schema.Number),
}).annotate({ identifier: "Own.Preset.PoolCandidate" })

/**
 * `presets.suggest` `pool` (07 §3.4): every model a pool may take, in section order (the main account, each other
 * company's subscription accounts with the roomiest first, local models, paid accounts), and the `추천 묶음` keys.
 */
export interface PoolOffer extends Schema.Schema.Type<typeof PoolOffer> {}
export const PoolOffer = Schema.Struct({
  candidates: Schema.Array(PoolCandidate),
  recommended: Schema.Array(Schema.String),
}).annotate({ identifier: "Own.Preset.PoolOffer" })

/**
 * `presets.suggest` result (07 §3.4): a draft, each role's suggestion with where it came from, and the starters. `pool`
 * (T4): the model pool's candidates; an older service has none, and the editor then hides the pool choice.
 */
export interface Suggestion extends Schema.Schema.Type<typeof Suggestion> {}
export const Suggestion = Schema.Struct({
  draft: Draft,
  rows: keyedRecord(Role, Schema.Struct({ targets: Schema.Array(Target), fill: Fill })),
  starters: Schema.Array(StarterView),
  pool: optional(PoolOffer),
}).annotate({ identifier: "Own.Preset.Suggestion" })

/** One model a pool section offers, as the service found it now (tool-less, mode and non-active models left out). */
export interface PoolModel {
  readonly id: string
  readonly family?: string
  /** Release time, epoch ms (`0` when unknown). */
  readonly released: number
  /** The raw ranking input price (07 §3.4). */
  readonly price?: number
  readonly card: PoolCard
}

/**
 * One section of the pool editor's checklist: the main account's models (no `account`; `main`, `main-paid` or
 * `local` by the group), one other company's subscription account, one local provider, or one paid account.
 */
export interface PoolSection {
  readonly runs: PoolRuns
  readonly account?: AccountID | `local:${string}`
  readonly company?: string
  readonly models: ReadonlyArray<PoolModel>
}

/** The section order of the checklist and of key assignment (07 §3.3 이름 규칙 4). */
const SECTION_ORDER: Readonly<Record<PoolRuns, number>> = {
  main: 0,
  "main-paid": 0,
  subscription: 1,
  local: 2,
  paid: 3,
}

/**
 * The pool editor's candidates and `추천 묶음` (07 §3.4 모델 묶음), from the sections the service found:
 * - Order: the main account's section, other companies' subscriptions (one account per company is picked on screen;
 *   the first given is the default), local models, paid accounts. Keys follow {@link poolKey} in that order, so a
 *   main-account model gets the plain name; one company's subscription accounts share a model's key (only one of them
 *   can be in a pool).
 * - Recommended: the newest model of each family (by release, like the lighter pair's families) from the main
 *   account's section when it costs nothing (a subscription group, or a verified local model), the first
 *   subscription account of each other company, and verified local models; never a paid entry; at most
 *   {@link POOL_MAX}. Prices and Codex priorities play no part.
 */
export function poolOffer(sections: ReadonlyArray<PoolSection>): PoolOffer {
  const ordered = sections
    .map((section, index) => ({ section, index }))
    .toSorted(
      (a, b) =>
        (a.section.account === undefined ? -1 : SECTION_ORDER[a.section.runs]) -
          (b.section.account === undefined ? -1 : SECTION_ORDER[b.section.runs]) || a.index - b.index,
    )
    .map((item) => item.section)
  // Keys are handed out in section order; one company's subscription accounts share a model's key.
  const taken: string[] = []
  const shared = new Map<string, string>()
  const keyed = ordered.map((section) => ({
    section,
    rows: section.models.map((model) => {
      const same = `${section.company ?? ""}\n${model.id}`
      const known = section.runs === "subscription" ? shared.get(same) : undefined
      const key = known ?? poolKey(model.id, taken, section.runs)
      if (known === undefined) taken.push(key)
      if (section.runs === "subscription") shared.set(same, key)
      const candidate: PoolCandidate = {
        key,
        model: Model.ID.make(model.id),
        ...(section.account === undefined ? {} : { account: section.account }),
        card: model.card,
        runs: section.runs,
        ...(section.company === undefined ? {} : { company: section.company }),
        ...(model.price === undefined ? {} : { price: model.price }),
        released: model.released,
      }
      return { candidate, model }
    }),
  }))
  const firsts = new Set(
    [
      ...Map.groupBy(
        keyed.filter((item) => item.section.runs === "subscription" && item.section.company !== undefined),
        (item) => item.section.company,
      ).values(),
    ].flatMap((items) => items[0] ?? []),
  )
  const recommended = keyed.flatMap((item) => {
    const runs = item.section.runs
    const offered =
      runs === "local"
        ? item.rows.filter((row) => row.model.card.windowVerified === true)
        : runs === "main" || firsts.has(item)
          ? item.rows
          : []
    const newest = new Set(
      [...Map.groupBy(offered, (row) => row.model.family ?? row.model.id).values()].flatMap(
        (rows) =>
          rows.toSorted((a, b) => b.model.released - a.model.released || a.model.id.localeCompare(b.model.id))[0] ?? [],
      ),
    )
    return offered.filter((row) => newest.has(row)).map((row) => row.candidate.key)
  })
  return {
    candidates: keyed.flatMap((item) => item.rows.map((row) => row.candidate)),
    recommended: [...new Set(recommended)].slice(0, POOL_MAX),
  }
}

/** A pinned target the service offers {@link suggest}: one model of a live account or of a local provider. */
export interface Pinnable {
  readonly account: AccountID | `local:${string}`
  readonly model: string
  /** The account's billing; `local` for a local provider. */
  readonly billing: Account.Billing | "local"
  /** The account's company ({@link company}); absent for a local provider. */
  readonly company?: string
  readonly tools: boolean
  /** Input price ranking "strongest" (07 §3.4, a price order it does not hide). */
  readonly price?: number
  /** `min(1 − used%/100)` of the account; the roomiest account of a company wins a tie. */
  readonly headroom?: number
  /** A local model whose running window is verified (07 §6.2 #8). */
  readonly verified?: boolean
}

/**
 * Suggestions for a group's editor (07 §3.4). Never a paid target (metered or prepaid; the user adds those by hand),
 * never a tool-less model, never a subscription of the group's own company (R4 when saving), never an unverified
 * local model. Another company's strongest subscription model is the highest price, then the roomiest account; the
 * local pick is the first verified one in the given order. With `template` (when usable) the draft is that starter
 * (`일마다 정하기`, `도움될 때`); otherwise it is a new preset (`모두 메인과 같게`, `모델 기본`). Starters that cannot be
 * used come back with their problem.
 */
export function suggest(group: Group, pins: ReadonlyArray<Pinnable>, template?: Starter): Suggestion {
  const home = isLocal(group) ? undefined : company({ kind: group })
  const usable = pins.filter((pin) => pin.tools && pin.billing !== "metered" && pin.billing !== "prepaid")
  const other = usable
    .filter((pin) => pin.billing === "subscription" && pin.company !== undefined && pin.company !== home)
    .toSorted(
      (a, b) =>
        (b.price ?? -Infinity) - (a.price ?? -Infinity) ||
        (b.headroom ?? -Infinity) - (a.headroom ?? -Infinity) ||
        a.account.localeCompare(b.account) ||
        a.model.localeCompare(b.model),
    )[0]
  const local = usable.find((pin) => pin.billing === "local" && pin.verified === true)
  const pinned = (pin: Pinnable | undefined): Target | undefined =>
    pin && { pin: { account: pin.account, model: Model.ID.make(pin.model) } }
  const targetOf = (fill: Fill): Target | undefined => {
    if (fill === "main") return { rel: "main" }
    if (fill === "lighter") return isLocal(group) ? undefined : { rel: "lighter" }
    return pinned(fill === "local" ? local : other)
  }
  const rows = Object.fromEntries(
    ROLES.map((role) => {
      const found = SUGGESTED[role].flatMap((fill) => {
        const target = targetOf(fill)
        return target ? [{ targets: [target], fill }] : []
      })[0]
      return [role, found ?? { targets: [{ rel: "main" as const }], fill: "main" as const }]
    }),
  )
  const problemOf = (starter: Starter): StarterProblem | undefined => {
    const lacking = Object.values(STARTERS[starter].roles).find((fill) => fill !== undefined && !targetOf(fill))
    if (lacking === undefined) return undefined
    return lacking === "lighter" ? "local-group" : lacking === "local" ? "no-local" : "no-other-subscription"
  }
  const starters = Starter.literals.map((starter) => {
    const problem = problemOf(starter)
    return { template: starter, name: STARTERS[starter].name, available: !problem, ...(problem ? { problem } : {}) }
  })
  const fresh: Draft = {
    name: "",
    group,
    workers: { mode: "same", roles: {} },
    delegation: "model",
    caps: CAPS,
    ultraCaps: null,
  }
  if (!template || problemOf(template)) return { draft: fresh, rows, starters }
  const roles = Object.fromEntries(
    Object.entries(STARTERS[template].roles).flatMap(([role, fill]): Array<[string, RoleEntry]> => {
      const target = fill && targetOf(fill)
      return target ? [[role, { targets: [target], effort: "inherit" }]] : []
    }),
  )
  return {
    draft: {
      ...fresh,
      name: STARTERS[template].name,
      workers: { mode: "by-role", roles },
      delegation: "when-useful",
    },
    rows,
    starters,
  }
}

/** How an `auto` default was decided (the "Codex 설정을 따름" label of 07 §2.2). */
export const Basis = Schema.Literals(["codex-config", "codex-meta", "family-price", "newest", "first"]).annotate({
  identifier: "Own.Preset.Basis",
})
export type Basis = typeof Basis.Type

/** A model and reasoning effort a new session starts with. No variant = the provider default (`기본`). */
export interface Choice extends Schema.Schema.Type<typeof Choice> {}
export const Choice = Schema.Struct({ id: Model.ID, variant: optional(Model.VariantID) }).annotate({
  identifier: "Own.Preset.Choice",
})

/**
 * A group's new-session default model (07 §2.2). `auto` is decided once and never changes by itself (U3); `user` is
 * set through `presets.defaults.set` and never overwritten. `missing`: no live account of the group has the model.
 */
export interface DefaultModel extends Schema.Schema.Type<typeof DefaultModel> {}
export const DefaultModel = Schema.Struct({
  ...Choice.fields,
  source: Schema.Literals(["auto", "user"]),
  basis: optional(Basis),
  missing: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Preset.DefaultModel" })

/**
 * Where a group's default model comes from, for the row's label (07 §2.2 `Codex 설정을 따름` …): `user` for one the
 * user chose, else the `auto` basis.
 */
export const DefaultLabel = Schema.Union([Schema.Literal("user"), Basis]).annotate({
  identifier: "Own.Preset.DefaultLabel",
})
export type DefaultLabel = typeof DefaultLabel.Type

export function labelOf(value: DefaultModel): DefaultLabel | undefined {
  return value.source === "user" ? "user" : value.basis
}

/**
 * `presets.set` `repairOf` (07 §4.3 `[고치기]`, §7.2): the save fixes `model`, gone from `place`; the service records
 * the fix in the group's repair history.
 */
export interface RepairOf extends Schema.Schema.Type<typeof RepairOf> {}
export const RepairOf = Schema.Struct({ model: Model.ID, place: Spot }).annotate({ identifier: "Own.Preset.RepairOf" })

/**
 * One row of a group's repair history (07 §7.2 `10-14 09:00 리뷰: GPT-5.5 없어짐 → GPT-5.6 Sol로 고침`): when, the
 * preset and place, the gone model, and the place's first target after the fix (`{rel:"main"}` when none is left).
 */
export interface RepairRecord extends Schema.Schema.Type<typeof RepairRecord> {}
export const RepairRecord = Schema.Struct({
  at: EpochMillis,
  presetID: ID,
  place: Place,
  from: Model.ID,
  to: Target,
}).annotate({ identifier: "Own.Preset.RepairRecord" })

/**
 * One model pool repair (07 §7.2 모델 묶음): when, the preset, the entry's key before the fix, the gone model, and the
 * model the entry runs now (absent when the entry was removed). Kept apart from {@link RepairRecord}, whose `place` an
 * older build reads strictly. Plain strings: a hand edit never makes the file unreadable.
 */
export interface PoolRepairRecord extends Schema.Schema.Type<typeof PoolRepairRecord> {}
export const PoolRepairRecord = Schema.Struct({
  at: EpochMillis,
  presetID: ID,
  key: Schema.String,
  from: Model.ID,
  to: optional(Schema.String),
}).annotate({ identifier: "Own.Preset.PoolRepairRecord" })

/**
 * One `presets.json` group (07 §8.1). No `star` = the group's `평소대로`; `presets` are the stored ones only. `history`
 * (T2): the repairs `presets.set{repairOf}` recorded, oldest first; `poolHistory` (T4) the model pool's.
 */
export interface GroupState extends Schema.Schema.Type<typeof GroupState> {}
export const GroupState = Schema.Struct({
  defaultModel: optional(DefaultModel),
  star: optional(ID),
  presets: optional(Schema.Array(Info)),
  lighter: optional(Schema.Record(Schema.String, Lighter)),
  history: optional(Schema.Array(RepairRecord)),
  poolHistory: optional(Schema.Array(PoolRepairRecord)),
}).annotate({ identifier: "Own.Preset.GroupState" })

/** The preset a new session starts with (07 §5.1): the group's ★, or the last one used when it is light. */
export const NewSession = Schema.Literals(["star", "last-light"]).annotate({ identifier: "Own.Preset.NewSession" })
export type NewSession = typeof NewSession.Type

/**
 * `OWN_HOME\presets.json` (07 §8.1). Keyed by group, never by account (U4). Absent global fields read as their
 * defaults: `newSession` `star`, `recent` empty, `ultraCaps` {@link ULTRA_LEVEL}. Version 2 (2026-11-03) can store no
 * conversation cap (`caps.perSession: null`); a version 1 file is read through {@link upgrade}.
 */
export interface File extends Schema.Schema.Type<typeof File> {}
export const File = Schema.Struct({
  version: Schema.Literals([1, 2]),
  groups: keyedRecord(Group, GroupState),
  newSession: optional(NewSession),
  recent: optional(Schema.Array(ID)),
  ultraCaps: optional(UltraCaps),
}).annotate({ identifier: "Own.Preset.File" })

export function empty(): File {
  return { version: 2, groups: {} }
}

/**
 * A version 1 `presets.json` as version 2 (07 §2.6, decision SC-1). Version 1 had no "no cap" and wrote the default
 * conversation cap like a typed one, so a preset's `caps.perSession` of exactly {@link LEGACY_PER_SESSION} is read as
 * the old default and becomes no cap; any other number was typed by the user and stays, and so does every `ultraCaps`
 * (`직접 정하기` always took three typed numbers). Version 2 numbers are all the user's.
 */
export function upgrade(file: File): File {
  if (file.version === 2) return file
  const groups = Object.entries(file.groups).map(([group, entry]) => {
    if (!entry?.presets) return [group, entry] as const
    const presets = entry.presets.map((preset) =>
      preset.caps.perSession === LEGACY_PER_SESSION
        ? { ...preset, caps: { ...preset.caps, perSession: null } }
        : preset,
    )
    return [group, { ...entry, presets }] as const
  })
  return { ...file, version: 2, groups: Object.fromEntries(groups) }
}

/** Whether a preset (or a group) still resolves as saved: `needs_repair` when a pinned model or a pair is gone (4.3). */
export const Status = Schema.Literals(["ok", "needs_repair"]).annotate({ identifier: "Own.Preset.Status" })
export type Status = typeof Status.Type

/** One preset of `presets.list`, with its status. */
export interface Listed extends Schema.Schema.Type<typeof Listed> {}
export const Listed = Schema.Struct({ ...Info.fields, status: Status }).annotate({ identifier: "Own.Preset.Listed" })

/**
 * Where a model that is gone was in use (07 §4.3): a preset's pinned target or model pool entry (`place` of
 * `presetID`, on `account`; a pool entry on the main account has none), the
 * lighter pair of main model `main`, or the group's new-session default. `suggestion` is what the notice offers: the
 * {@link successor} for a pin, the {@link lighterPick} result for a pair, the model new sessions now start on for a
 * default ({@link groupDefault}); the service fills it in.
 */
export const Use = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pin"),
    group: Group,
    presetID: ID,
    place: Spot,
    /** Absent for a model pool entry on the main account (07 §4.3 모델 묶음): it is the group's model. */
    account: optional(PinAccount),
    suggestion: optional(Model.ID),
  }),
  Schema.Struct({ kind: Schema.Literal("lighter"), group: Group, main: Model.ID, suggestion: optional(Model.ID) }),
  Schema.Struct({ kind: Schema.Literal("default"), group: Group, suggestion: optional(Model.ID) }),
]).annotate({ identifier: "Own.Preset.Use" })
export type Use = typeof Use.Type

/**
 * One repair notice (07 §4.3): a model that is gone and every place that used it, so one model event is one notice
 * however many presets, groups or accounts use it ({@link repairs}).
 */
export interface Repair extends Schema.Schema.Type<typeof Repair> {}
export const Repair = Schema.Struct({
  model: Model.ID,
  uses: Schema.Array(Use).check(Schema.isMinLength(1)),
}).annotate({ identifier: "Own.Preset.Repair" })

/**
 * One group of `presets.list` (07 §8.1). `defaultModel: null` until the group has an account. The T1 fields are
 * optional so an older service still answers: `presets` (★ first, `평소대로` always), `star` (absent = `평소대로`),
 * the lighter-pair table, the group's status, and `label` for the default model row. T2 adds, as optional too, the
 * group's repair `history` (07 §7.2) and `retirements`: the Codex retirement time (epoch ms) of each model the group's
 * presets, pairs or default name, shown dimmed beside it and never a notice (07 §4.3, U3). T4 adds the model pool's
 * repair history (`poolHistory`).
 */
export interface GroupView extends Schema.Schema.Type<typeof GroupView> {}
export const GroupView = Schema.Struct({
  group: Group,
  defaultModel: Schema.NullOr(DefaultModel),
  presets: optional(Schema.Array(Listed)),
  star: optional(ID),
  lighter: optional(Schema.Record(Schema.String, Lighter)),
  status: optional(Status),
  label: optional(DefaultLabel),
  history: optional(Schema.Array(RepairRecord)),
  retirements: optional(Schema.Record(Schema.String, EpochMillis)),
  poolHistory: optional(Schema.Array(PoolRepairRecord)),
}).annotate({
  identifier: "Own.Preset.GroupView",
})

/**
 * `session.preset.get` result (07 §8.1): the root's binding (`null` before it is bound), the preset in effect and its
 * resolution for the main now (`null` without a group), the caps in force, the subagents running, started for the
 * current user message and in the conversation, and the USD spent on paid targets in this conversation. `main` (T2,
 * 07 §4.3): the session's main model, or its effort level, is gone; the next prompt waits for the user's 02 switch,
 * offered with `suggestion` (a successor model, or the level refitted by 07 §2.3). Absent while the main is usable.
 */
export interface SessionView extends Schema.Schema.Type<typeof SessionView> {}
export const SessionView = Schema.Struct({
  binding: Schema.NullOr(Binding),
  preset: Schema.NullOr(Info),
  resolution: Schema.NullOr(Resolution),
  caps: Caps,
  counts: Schema.Struct({ running: NonNegativeInt, message: NonNegativeInt, session: NonNegativeInt }),
  spend: NonNegative,
  main: optional(Schema.Struct({ missing: Schema.Literals(["model", "variant"]), suggestion: optional(Choice) })),
}).annotate({ identifier: "Own.Preset.SessionView" })

/** What the service warns about when saving (07 §3.4, §6.2 #8): a target that costs money, an unverified local window. */
export interface Warning extends Schema.Schema.Type<typeof Warning> {}
export const Warning = Schema.Struct({
  code: Schema.Literals(["paid", "local-unverified"]),
  place: Spot,
}).annotate({ identifier: "Own.Preset.Warning" })

/** What the `auto` rule needs of a model a new session may start on. */
export interface Candidate {
  readonly id: string
  readonly family?: string
  /** Release time, epoch ms (`0` when unknown). */
  readonly released: number
  /** Input price, USD per 1M tokens; `undefined` without a catalog price. */
  readonly price?: number
  /** Variant ids in the model's order. */
  readonly variants: ReadonlyArray<string>
  /** `false` when the model cannot call tools (no subagent target, 07 §3.4); absent = it can. */
  readonly tools?: false
}

/**
 * What the ChatGPT group's `auto` default reads of Codex (07 §2.2, §4.5): the Codex CLI's `config.toml` on this PC
 * (`model`, `effort`, read only) and the Codex model metadata (`models`: own's fetched snapshot, else the CLI's cache,
 * as {@link CodexModels.hints} gives them).
 */
export interface CodexHints {
  readonly model?: string
  readonly effort?: string
  /** `priority` 1 comes first. */
  readonly models?: ReadonlyArray<{
    readonly slug: string
    readonly priority?: number
    readonly defaultEffort?: string
  }>
}

/** An `auto` default and how it was decided. */
export interface Auto extends Choice {
  readonly basis: Basis
}

/**
 * The fields of a catalog (`Model.Info`) or template model that {@link candidates} reads, and that a model pool card
 * freezes (`name`, `limit`, `capabilities.input`).
 */
export interface Entry {
  readonly id: string
  readonly modelID?: string
  readonly family?: string
  readonly name?: string
  readonly time: { readonly released: number }
  readonly cost: ReadonlyArray<{ readonly input: number; readonly tier?: unknown }>
  readonly status: string
  readonly enabled: boolean
  readonly variants: ReadonlyArray<{ readonly id: string }>
  readonly capabilities?: { readonly tools: boolean; readonly input?: ReadonlyArray<string> }
  readonly limit?: { readonly context: number; readonly input?: number }
}

/**
 * The models a new session may start on, in the given order: enabled, `active`, and not a mode entry such as
 * `-fast` or `-pro` (its `modelID` names the base model). `price` overrides the model's own input price: callers pass
 * the `openai` catalog price for every ChatGPT OAuth kind (`codex`, `siwc`), whose slots are free (07 §3.4).
 */
export function candidates(
  models: ReadonlyArray<Entry>,
  price: (model: Entry) => number | undefined = (model) => basePrice(model.cost),
): Candidate[] {
  return models
    .filter((model) => model.enabled && model.status === "active" && (model.modelID ?? model.id) === model.id)
    .map((model) => {
      const input = price(model)
      return {
        id: model.id,
        ...(model.family === undefined ? {} : { family: model.family }),
        released: model.time.released,
        ...(input === undefined ? {} : { price: input }),
        variants: model.variants.map((variant) => variant.id),
        ...(model.capabilities?.tools === false ? { tools: false as const } : {}),
      }
    })
}

/** Input price of the untiered entry, else of the first one. */
export function basePrice(cost: Entry["cost"]) {
  return (cost.find((entry) => entry.tier === undefined) ?? cost[0])?.input
}

/**
 * The `auto` new-session default of a group (07 §2.2 table), from its candidates in registration order.
 * - `codex`: the Codex config's `model` when the group has it, else the first Codex metadata priority, else the newest
 *   model of the most expensive family (each family priced by its newest model) among the models Codex's own catalog
 *   offers, so a specialised model such as GPT-5.6 Cyber never becomes a default (MR8-16). Effort: the config's
 *   `model_reasoning_effort`, else the model's `default_reasoning_level`, when the model offers it; else none.
 * - `siwc`: the codex rule without Codex CLI hints (they describe the Codex client, not this login): always the newest
 *   model of the most expensive family, priced from the `openai` catalog, no effort (`family-price`).
 * - `claude-sub`, `claude-agent`: the newest, a tie going to the higher input price (⚠PG8 until Claude Code's plan
 *   default is known).
 * - `oai`, `anth`, `ds`, `xai`, `or`: the newest, a tie going to the lower input price (they cost money).
 * - `compat`, local groups: the first model.
 * Remaining ties go to the smaller id so the result never depends on catalog order.
 */
export function defaultModel(of: Group, models: ReadonlyArray<Candidate>, codex: CodexHints = {}): Auto | undefined {
  const first = models[0]
  if (!first) return undefined
  if (Kind.isOAuth(of)) return codexDefault(models, first, of === "codex" ? codex : {})
  if (of === "compat" || of.startsWith("local:")) return { id: Model.ID.make(first.id), basis: "first" }
  // An unknown price never wins a tie.
  const subscription = of === "claude-sub" || of === "claude-agent"
  const rank = (model: Candidate) => (subscription ? -(model.price ?? -Infinity) : (model.price ?? Infinity))
  const newest = models.toSorted((a, b) => b.released - a.released || rank(a) - rank(b) || a.id.localeCompare(b.id))
  return { id: Model.ID.make(newest[0]?.id ?? first.id), basis: "newest" }
}

function codexDefault(models: ReadonlyArray<Candidate>, first: Candidate, codex: CodexHints): Auto {
  const configured = models.find((model) => model.id === codex.model)
  const ranked = models
    .flatMap((model) => {
      const priority = codex.models?.find((entry) => entry.slug === model.id)?.priority
      return priority === undefined ? [] : [{ model, priority }]
    })
    .toSorted((a, b) => a.priority - b.priority || a.model.id.localeCompare(b.model.id))[0]?.model
  const model = configured ?? ranked ?? priciest(general(models), first)
  const basis = configured ? "codex-config" : ranked ? "codex-meta" : "family-price"
  const effort = [codex.effort, codex.models?.find((entry) => entry.slug === model.id)?.defaultEffort].find(
    (value) => value !== undefined && model.variants.includes(value),
  )
  return { id: Model.ID.make(model.id), ...(effort ? { variant: Model.VariantID.make(effort) } : {}), basis }
}

/**
 * The candidates the Codex picker would list (`CodexModels.catalogued`), or all of them when it lists none: a
 * specialised model outside Codex's catalog (GPT-5.6 Cyber, priced above every general model) is never the price rule's
 * pick (MR8-16).
 */
function general(models: ReadonlyArray<Candidate>) {
  const listed = models.filter((model) => CodexModels.catalogued(model.id))
  return listed.length > 0 ? listed : models
}

/** The newest model of the family whose newest model has the highest input price (07 §2.2 codex ③). */
function priciest(models: ReadonlyArray<Candidate>, first: Candidate): Candidate {
  const newest = (list: ReadonlyArray<Candidate>) =>
    list.toSorted((a, b) => b.released - a.released || a.id.localeCompare(b.id))
  const heads = [...Map.groupBy(models, (model) => model.family ?? model.id).values()].flatMap(
    (family) => newest(family)[0] ?? [],
  )
  const price = (model: Candidate) => model.price ?? -Infinity
  return (
    heads.toSorted((a, b) => price(b) - price(a) || b.released - a.released || a.id.localeCompare(b.id))[0] ?? first
  )
}

/**
 * A group's new-session default now (07 §2.2, §4.3), from its stored value and its live candidates: `value` is what
 * `presets.json` keeps, `start` what a new session starts on.
 * - A stored value whose model is still a candidate stands as it is, `auto` included: a newer Codex priority, config
 *   or catalog never decides it again (U3), and a `user` value is never overwritten.
 * - Nothing stored: the `auto` rule ({@link defaultModel}) decides it once.
 * - The stored model is gone: new sessions start on the rule's result. A `user` value stays stored, marked `missing`
 *   (it is used again when the model comes back); an `auto` value gives way to the rule's result. With no candidate at
 *   all the stored value stays, marked `missing`.
 * The start keeps the stored effort, fitted to the model's levels (07 §2.3). `undefined` with nothing stored and no
 * candidate.
 */
export function groupDefault(
  of: Group,
  stored: DefaultModel | undefined,
  models: ReadonlyArray<Candidate>,
  codex: CodexHints = {},
): { readonly value: DefaultModel; readonly start: Choice } | undefined {
  const found = stored && models.find((model) => model.id === stored.id)
  if (stored && found) {
    const fit = effortToVariant(stored.variant, found.variants)
    return {
      value: Struct.omit(stored, ["missing"]),
      start: { id: stored.id, ...(fit.variant === undefined ? {} : { variant: Model.VariantID.make(fit.variant) }) },
    }
  }
  const rule = defaultModel(of, models, codex)
  if (!stored) return rule && { value: { ...rule, source: "auto" }, start: choiceOf(rule) }
  const kept = { ...stored, missing: true }
  if (!rule) return { value: kept, start: choiceOf(stored) }
  return { value: stored.source === "user" ? kept : { ...rule, source: "auto" }, start: choiceOf(rule) }
}

function choiceOf(value: Choice): Choice {
  return { id: value.id, ...(value.variant === undefined ? {} : { variant: value.variant }) }
}

/** Whether a model can be a subagent target now (07 §3.4, §4.3): enabled, not deprecated, able to call tools. */
export function callable(model: Pick<Entry, "enabled" | "status" | "capabilities">) {
  return model.enabled && model.status !== "deprecated" && model.capabilities?.tools !== false
}

/** What is known of a model that is gone: its last template row's family and release time, or only its id. */
export interface Gone {
  readonly id: string
  readonly family?: string
  /** Release time, epoch ms; absent or `0` when unknown. */
  readonly released?: number
}

/**
 * Claude Code's long-context suffix on a model id (`opus[1m]`). Claude Code 2.1.311 dropped it where it changes nothing
 * (`opus` is the 1M model now), so a saved `X[1m]` is `X` renamed.
 */
export const LONG_CONTEXT_SUFFIX = "[1m]"

/**
 * The model a repair notice offers in place of a pinned model that is gone (07 §4.3 `[고치기]`), never applied by
 * itself. In order: Codex's `upgrade.model` (`meta`, the gone model's row; Codex accounts only), a rename (Claude
 * Code's id without {@link LONG_CONTEXT_SUFFIX}, or a model of the same family released the same day), the newest model
 * of the same family, else none. Only the pinned account's live candidates that can call tools are offered, never the
 * gone model itself.
 */
export function successor(
  gone: Gone,
  models: ReadonlyArray<Candidate>,
  meta?: CodexModels.Model,
): Model.ID | undefined {
  const usable = models.filter((model) => model.tools !== false && model.id !== gone.id)
  const named = meta && CodexModels.upgrade(meta)?.model
  const shorter = gone.id.endsWith(LONG_CONTEXT_SUFFIX) ? gone.id.slice(0, -LONG_CONTEXT_SUFFIX.length) : undefined
  const kin = gone.family === undefined ? [] : usable.filter((model) => model.family === gone.family)
  const pick =
    usable.find((model) => model.id === named) ??
    usable.find((model) => model.id === shorter) ??
    newestOf(gone.released ? kin.filter((model) => model.released === gone.released) : []) ??
    newestOf(kin)
  return pick && Model.ID.make(pick.id)
}

function newestOf(models: ReadonlyArray<Candidate>) {
  return models.toSorted((a, b) => b.released - a.released || a.id.localeCompare(b.id))[0]
}

/** What {@link presence} reads of the live registry and catalog. */
export interface Live {
  /** The models an own account, the Claude slot or a local provider offers now; `undefined` when it is gone. */
  readonly offers: (account: string) => ReadonlyArray<Entry> | undefined
  /** The models the group's live accounts offer now (a lighter pair and the default model are the group's). */
  readonly group: ReadonlyArray<Entry>
}

/** A model in use that is gone, and where it was used (07 §4.3). */
export interface GoneUse {
  readonly model: Model.ID
  readonly use: Use
}

/** One group's presence check ({@link presence}). */
export interface Presence {
  /** The given presets with their status, in order. */
  readonly presets: ReadonlyArray<Listed>
  /** The lighter-pair table with gone pairs marked `missing`. */
  readonly lighter: Readonly<Record<string, Lighter>>
  /** The stored default model, marked `missing` when gone and kept either way. */
  readonly defaultModel?: DefaultModel
  /** `needs_repair` while a preset or a lighter pair needs it; the default model has its own alert. */
  readonly status: Status
  /** Every use of a gone model, for the repair notices ({@link repairs}). */
  readonly gone: ReadonlyArray<GoneUse>
}

/**
 * Whether what a group's presets, lighter pairs and default model name still exists (07 §4.3 (가)), the rule the
 * service runs on `models-dev.refreshed`, a provider refold and a `presets.json` change. It only marks: nothing is
 * changed, picked again or announced here.
 * - A pinned target (a pinned model pool entry too), used by the mode or not, needs its account to offer the model
 *   {@link callable}; a model pool entry on the main account needs a callable model of the group. Else its preset is
 *   `needs_repair`, with a use at `pool:<key>` for a pool entry.
 * - A lighter pair (not `none`) needs a callable model of the group; else the row is `missing` (`없어짐`) and is never
 *   picked again by itself (07 §4.2). A row whose model came back loses the mark.
 * - The default model needs a group candidate ({@link candidates}); else it is `missing` and stays stored, `user` and
 *   `auto` alike ({@link groupDefault} says what new sessions start on).
 * - A retirement date (Codex `upgrade.retirement_at`) is no issue: only a model that is gone counts (U3).
 */
export function presence(
  group: Group,
  state: Pick<GroupState, "presets" | "lighter" | "defaultModel">,
  live: Live,
): Presence {
  const pins = (state.presets ?? []).map((preset) => ({
    preset,
    gone: placesOf(preset.workers).flatMap((entry): GoneUse[] => {
      const use = { kind: "pin" as const, group, presetID: preset.id, place: entry.spot }
      // A main-account pool entry runs on whichever account of the group is the main: the group's models count.
      const main = entry.pool !== undefined && entry.pool.account === undefined ? entry.pool : undefined
      if (main)
        return live.group.some((model) => model.id === main.model && callable(model))
          ? []
          : [{ model: main.model, use }]
      return entry.targets.flatMap((target): GoneUse[] => {
        if (!("pin" in target)) return []
        const pin = target.pin
        if (live.offers(pin.account)?.some((model) => model.id === pin.model && callable(model))) return []
        return [{ model: pin.model, use: { ...use, account: pin.account } }]
      })
    }),
  }))
  const pairs = Object.entries(state.lighter ?? {}).map(([main, row]) => ({
    main,
    row,
    gone: row.source !== "none" && !live.group.some((model) => model.id === row.model && callable(model)),
  }))
  const stored = state.defaultModel
  const defaultGone = stored !== undefined && !candidates(live.group).some((model) => model.id === stored.id)
  const presets = pins.map((entry): Listed => ({ ...entry.preset, status: entry.gone.length ? "needs_repair" : "ok" }))
  return {
    presets,
    lighter: Object.fromEntries(
      pairs.map((pair) => [pair.main, pair.gone ? { ...pair.row, missing: true } : Struct.omit(pair.row, ["missing"])]),
    ),
    ...(stored === undefined
      ? {}
      : { defaultModel: defaultGone ? { ...stored, missing: true } : Struct.omit(stored, ["missing"]) }),
    status:
      presets.some((preset) => preset.status === "needs_repair") || pairs.some((pair) => pair.gone)
        ? "needs_repair"
        : "ok",
    gone: [
      ...pins.flatMap((entry) => entry.gone),
      ...pairs.flatMap((pair): GoneUse[] =>
        pair.gone ? [{ model: pair.row.model, use: { kind: "lighter", group, main: Model.ID.make(pair.main) } }] : [],
      ),
      ...(stored && defaultGone ? [{ model: stored.id, use: { kind: "default" as const, group } }] : []),
    ],
  }
}

/**
 * Gone uses as repair notices (07 §4.3): one per model, in the order first seen, however many presets, groups or
 * accounts use it (one model event is one notice, also with seven ChatGPT accounts sharing the group's presets).
 */
export function repairs(gone: ReadonlyArray<GoneUse>): Repair[] {
  return [...Map.groupBy(gone, (entry) => entry.model)].map(([model, entries]) => ({
    model,
    uses: entries.map((entry) => entry.use),
  }))
}
