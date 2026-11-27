// Presets screens model (07 §7.1, §7.2, §7.3, §3.4, §2.6, §5.1): the editor's draft and its two questions, the 자세히
// panel's edits (per-role effort, target order, caps, the preset's ultra level, the guidance preview, lighter pairs, ★,
// copies, repair history and retirement dates), value provenance, the live resolution line, the target picker's
// sections, the settings 프리셋 page's tabs, rows and choices, and where a session's presets come from (this PC's, or a
// remote server's mirror of them, 07 §8.1 원격). T4 adds the model pool (`모델 묶음에서 알아서`, 07 §3.3, §8.1): its
// checklist sections over `presets.suggest` candidates, one account per other company, `추천 묶음`, per-entry effort and
// notes, and its previews. Pure functions over store values (no RPC, no stores), so the editor preview runs the same
// `Preset.resolve`, `Preset.allowed`, `Preset.effortToVariant`, `Preset.renderGuidance` and `Preset.poolGuidance` as the
// service (07 §2.3, §3.3, §4.2, §5.4). A mode is read through `Preset.modeOf` only ({@link draftMode}). The one piece
// of state is the open-editor request (`openPresetEditor`), kept here so a first-chunk caller (the composer's preset
// button, a refusal chip, a repair notice) can open the lazy editor without loading it.
import type { ModelInfo } from "@opencode/client"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import type { Account, Limit } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { Speed } from "@own/protocol/speed"
import { Struct } from "effect"
import { createSignal } from "solid-js"
import { KIND_ORDER } from "@/switcher/picker"

/** A catalog model as the screens read it (`ModelInfo` of the server's model list). */
export type CatalogModel = Pick<
  ModelInfo,
  | "id"
  | "modelID"
  | "providerID"
  | "name"
  | "family"
  | "capabilities"
  | "variants"
  | "time"
  | "cost"
  | "status"
  | "enabled"
  | "limit"
>

/** The main a preview resolves against: a session's main, else the group's new-session default (07 §7.1). */
export interface MainRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

/**
 * A model `[묶음에 추가…]` checks (07 §8.3 모델 묶음): on the main account (no `account`, whichever account of the group
 * is the main) or pinned to an account or local provider.
 */
export interface PoolPick {
  readonly model: Model.ID
  readonly account?: Preset.PoolEntry["account"]
}

/**
 * What a refusal chip fills (07 §7.3): `하위 에이전트에 추가…` a role's first target, or `묶음에 추가…` a model of the
 * pool (07 §8.3 모델 묶음).
 */
export type Prefill = { readonly role: Preset.Role; readonly target: Preset.Target } | { readonly pool: PoolPick }

/** What opens the editor (07 §7.1, §7.3): a group's new preset, one of its presets, or what a refusal chip fills. */
export interface EditorRequest {
  readonly group: Preset.Group
  /** A stored preset to edit; a `평소대로` id opens a new preset (the builtin is locked). */
  readonly presetID?: Preset.ID
  /** A refusal chip's role target or pool model ({@link Prefill}); nothing is stored before `저장`. */
  readonly prefill?: Prefill
  /** The main of the session the editor was opened from; without it the preview uses the group's default model. */
  readonly main?: MainRef
  /**
   * The model pool facts of the session the editor was opened from, for the preset it edits (`Resolution.pool` of
   * `session.preset.get`, 07 §3.3): the previews read them before the editor's candidates.
   */
  readonly pool?: Preset.PoolResolution
  /**
   * A place to show first (07 §4.3 `[직접 고르기]`, the team view's `고치기`): the editor opens with 자세히 expanded on
   * that role's target order (`single`: the one target of `다른 모델 하나로`; `pool:<key>`: that pool entry). Nothing
   * changes until the user picks.
   */
  readonly focusRole?: Preset.Spot
}

/** What the 자세히 panel (07 §7.2, presets/details.tsx) gets from the editor (`registerPresetDetail`). */
export interface PresetDetailProps {
  readonly draft: Preset.Draft
  readonly update: (draft: Preset.Draft) => void
  /** The preview's main: the session's main, else the group's new-session default model (07 §7.1). */
  readonly main: Preset.Main | undefined
  readonly resolution: Preset.Resolution | undefined
  /** The role rows the editor shows (07 §2.4: 탐색·일반·리뷰, then the added ones). */
  readonly roles: ReadonlyArray<Preset.Role>
  /** The lighter pairs the preview resolves with ({@link lighterFor}). */
  readonly lighter: Readonly<Record<string, Preset.Lighter>>
  readonly local: LocalCheck
  /** `presets.suggest` `pool`: the model pool's candidates (their facts feed the previews); absent from an older service. */
  readonly offer?: Preset.PoolOffer
  /** The session's model pool facts ({@link EditorRequest.pool}). */
  readonly facts?: Preset.PoolResolution
  readonly focusRole?: Preset.Spot
  /** Holds `저장` while a field of the panel is invalid; `on: false` releases it. */
  readonly block: (field: string, on: boolean) => void
  /** The editor's message for a `presets.*` error (R4 names the account, 07 §5.4). */
  readonly errorText: (error: unknown) => string
}

const [request, setRequest] = createSignal<EditorRequest>()

/** The open editor's request; the editor layer (presets/editor.tsx) renders while it is set. */
export const presetEditorRequest = request

/** Opens the preset editor (07 §7.1): `openPresetEditor({group, presetID?, prefill?, main?, pool?, focusRole?})`. */
export function openPresetEditor(input: EditorRequest) {
  // A new object every time, so reopening the same preset starts a fresh editor.
  setRequest({ ...input })
}

export function closePresetEditor() {
  setRequest(undefined)
}

// ---- editor draft (07 §7.1) ----

/** Roles the editor always shows, in its order (07 §2.4): 탐색, 일반, 리뷰. */
export const BASE_ROLES: ReadonlyArray<Preset.Role> = ["explore", "general", "own-review"]

/** Roles behind `+ 역할 추가`: 빠른 일, 어려운 일. */
export const EXTRA_ROLES: ReadonlyArray<Preset.Role> = ["own-quick", "own-deep"]

/**
 * The ① choices, simplest first (`Preset.modeOf` values): `메인과 같은 모델로`, `다른 모델 하나로`, `모델 묶음에서 알아서`,
 * `일마다 정하기`, each with its one-line hint. The editor shows `pool` only when `presets.suggest` offers a pool (07
 * §8.1).
 */
export const WORKER_MODES: ReadonlyArray<Preset.Mode> = ["same", "single", "pool", "by-role"]

/** The ② choices of the simple editor; `안 함` is set in 자세히 only (07 §2.5). */
export const DELEGATIONS: ReadonlyArray<Exclude<Preset.Delegation, "off">> = [
  "model",
  "on-request",
  "when-useful",
  "active",
]

/**
 * A preset to edit: a stored one, or a new one of the group (`메인과 같은 모델로`, `모델 기본`, the default caps). A
 * stored `다른 모델 하나로` on `메인과 같게` (an older service's list) opens as `메인과 같은 모델로` (UC 2026-10-18).
 */
export function draftOf(group: Preset.Group, preset?: Preset.Info): Preset.Draft {
  if (!preset || Preset.isBuiltin(preset.id))
    return {
      name: "",
      group,
      workers: { mode: "same", roles: {} },
      delegation: "model",
      caps: Preset.CAPS,
      ultraCaps: null,
    }
  return {
    id: preset.id,
    name: preset.name,
    group: preset.group,
    // An empty stored pool is no pool (`Preset.modeOf`): the draft holds a pool only in the pool mode.
    workers: Preset.plainWorkers(preset.workers.pool?.length ? preset.workers : Struct.omit(preset.workers, ["pool"])),
    delegation: preset.delegation,
    caps: preset.caps,
    ultraCaps: preset.ultraCaps,
    // 07 §2.3: read leniently (a value this build does not know raises nothing); absent stays absent (`max`).
    ...(preset.subagentEffortMax === undefined ? {} : { subagentEffortMax: Preset.effortMaxOf(preset) }),
    ...(Preset.forcedEffortOf(preset.forcedEffort) ? { forcedEffort: Preset.forcedEffortOf(preset.forcedEffort) } : {}),
  }
}

/** The rows the editor shows: the base roles, then extra roles that have a row or were added in this editor. */
export function shownRoles(draft: Preset.Draft, added: ReadonlyArray<Preset.Role>) {
  return [
    ...BASE_ROLES,
    ...EXTRA_ROLES.filter((role) => draft.workers.roles[role] !== undefined || added.includes(role)),
  ]
}

/**
 * The ① choice a draft shows: `pool` while the editor holds a pool, also before a model is checked (saving then waits,
 * {@link problems}); else `Preset.modeOf`.
 */
export function draftMode(draft: Pick<Preset.Draft, "workers">): Preset.Mode {
  return draft.workers.pool ? "pool" : Preset.modeOf(draft.workers)
}

/**
 * A ① choice. `pool` keeps the stored mode `same` with the given pool (07 §2.1: an older build reads it as `메인과 같은
 * 모델로`); any other choice drops the pool. Role rows and `single` stay either way, except a `single` on `메인과
 * 같게`: `다른 모델 하나로` then starts with no target and waits for one ({@link problems}, UC 2026-10-18). The editor
 * keeps the checked list while it is open, so choosing `pool` again brings it back.
 */
export function withMode(
  draft: Preset.Draft,
  mode: Preset.Mode,
  pool: ReadonlyArray<Preset.PoolEntry> = [],
): Preset.Draft {
  const workers = Struct.omit(draft.workers, ["pool"])
  if (mode === "pool") return { ...draft, workers: { ...workers, mode: "same", pool } }
  return { ...draft, workers: { ...Preset.plainWorkers(workers), mode } }
}

export function withDelegation(draft: Preset.Draft, delegation: Preset.Delegation): Preset.Draft {
  return { ...draft, delegation }
}

/**
 * A picked target in its place (07 §7.1 `바꾸기`). `single` takes it as it is, except `메인과 같게`: that is the
 * `메인과 같은 모델로` choice (`Preset.plainWorkers`; the picker does not offer it there). For a role, `메인과 같게`
 * removes the row (a role without a row runs like the main); any other target becomes the first target, the later ones
 * kept (their order is edited in 자세히, {@link withMovedTarget}).
 */
export function withTarget(draft: Preset.Draft, place: Preset.Place, target: Preset.Target): Preset.Draft {
  if (place === "single") return { ...draft, workers: Preset.plainWorkers({ ...draft.workers, single: target }) }
  const row = draft.workers.roles[place]
  if ("rel" in target && target.rel === "main") return withoutRole(draft, place)
  const rest = (row?.targets ?? []).slice(1).filter((item) => !sameTarget(item, target))
  const roles = { ...draft.workers.roles, [place]: { targets: [target, ...rest], effort: row?.effort ?? "inherit" } }
  return { ...draft, workers: { ...draft.workers, roles } }
}

export function withoutRole(draft: Preset.Draft, role: Preset.Role): Preset.Draft {
  const roles = Object.fromEntries(Object.entries(draft.workers.roles).filter(([key]) => key !== role))
  return { ...draft, workers: { ...draft.workers, roles } }
}

/**
 * A refusal chip's fill (07 §7.3): `하위 에이전트에 추가…` sets the role's first target in `일마다 정하기`;
 * `묶음에 추가…` (07 §8.3) checks the model in the pool, the pool kept.
 */
export function withPrefill(draft: Preset.Draft, prefill: Prefill, lookup: Preset.Lookup): Preset.Draft {
  if ("role" in prefill) return withTarget(withMode(draft, "by-role"), prefill.role, prefill.target)
  const pick = prefill.pool
  const runs = poolRuns(pick.account, lookup)
  return withPoolEntry(withMode(draft, "pool", draft.workers.pool ?? []), {
    key: Preset.poolKey(pick.model, [], runs),
    model: pick.model,
    ...(pick.account === undefined ? {} : { account: pick.account }),
    ...(runs === undefined ? {} : { runs }),
  })
}

/** A starter (07 §3.4) fills the rows and the delegation; it names the preset only while the name is empty. */
export function withStarter(draft: Preset.Draft, starter: Preset.Draft): Preset.Draft {
  return {
    ...draft,
    name: draft.name.trim() ? draft.name : starter.name,
    workers: starter.workers,
    delegation: starter.delegation,
  }
}

/** A role's targets as the editor reads them: its row's, or `메인과 같게` without a row. */
export function targetsOf(draft: Preset.Draft, role: Preset.Role): ReadonlyArray<Preset.Target> {
  return draft.workers.roles[role]?.targets ?? [{ rel: "main" }]
}

export function sameTarget(a: Preset.Target, b: Preset.Target) {
  if ("rel" in a || "rel" in b) return "rel" in a && "rel" in b && a.rel === b.rel
  return a.pin.account === b.pin.account && a.pin.model === b.pin.model
}

export type Provenance = "suggested" | "user"

/**
 * Where a value came from (07 §7.1 `추천` / `직접 고름`): `user` once picked in this editor; otherwise `suggested`
 * while it equals `presets.suggest`'s row, else `user` for a stored row. A role without a row that the suggestion
 * would fill differently shows nothing (nobody chose `메인과 같게` for it). `single` has no suggestion.
 */
export function provenance(
  draft: Preset.Draft,
  place: Preset.Place,
  chosen: ReadonlyArray<Preset.Place>,
  suggestion: Preset.Suggestion | undefined,
): Provenance | undefined {
  if (chosen.includes(place)) return "user"
  if (place === "single") return draft.workers.single ? "user" : undefined
  const suggested = suggestion?.rows[place]?.targets
  if (!suggested) return undefined
  const targets = targetsOf(draft, place)
  const same =
    targets.length === suggested.length && targets.every((target, index) => sameTarget(target, suggested[index]!))
  if (same) return "suggested"
  return draft.workers.roles[place] ? "user" : undefined
}

/**
 * Why `저장` is not possible yet: no name, `다른 모델 하나로` without a target, a model pool without a model, or an R4
 * breach (07 §5.4, `main: null`; the pool's pins count, `Preset.allowed`).
 */
export type Problem =
  | { readonly code: "name" }
  | { readonly code: "single" }
  | { readonly code: "pool" }
  | { readonly code: "same-company"; readonly accountID: Account.ID }

export function problems(draft: Preset.Draft, lookup: Preset.Lookup): Problem[] {
  const verdict = Preset.allowed(draft, null, lookup)
  const mode = draftMode(draft)
  return [
    ...(draft.name.trim() ? [] : [{ code: "name" } as const]),
    ...(mode === "single" && !draft.workers.single ? [{ code: "single" } as const] : []),
    ...(mode === "pool" && !draft.workers.pool?.length ? [{ code: "pool" } as const] : []),
    ...(verdict.ok ? [] : [{ code: "same-company", accountID: verdict.accountID } as const]),
  ]
}

/** `presets.set` input: the draft with its name trimmed. */
export function toSave(draft: Preset.Draft): Preset.Save {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    group: draft.group,
    workers: draft.workers,
    delegation: draft.delegation,
    caps: draft.caps,
    ultraCaps: draft.ultraCaps,
    ...(draft.subagentEffortMax === undefined ? {} : { subagentEffortMax: draft.subagentEffortMax }),
    ...(draft.forcedEffort === undefined ? {} : { forcedEffort: draft.forcedEffort }),
  }
}

/**
 * Whether a pinned target would break R4 in this place (07 §5.4, judged as `presets.set` does, `main: null`): another
 * place already pins a different subscription of that company, or it is the group's own company. Not blamed on the
 * row when the draft breaks R4 without it.
 */
export function clashes(draft: Preset.Draft, place: Preset.Place, target: Preset.Target, lookup: Preset.Lookup) {
  if ("rel" in target) return false
  const without =
    place === "single" ? { ...draft, workers: { ...draft.workers, single: undefined } } : withoutRole(draft, place)
  if (!Preset.allowed(without, null, lookup).ok) return false
  return !Preset.allowed(withTarget(draft, place, target), null, lookup).ok
}

// ---- 모델 묶음 (07 §3.3, §8.1) ----

/** Whether two pool entries (or candidates) run the same model on the same account (none = the main account). */
export function samePoolTarget(
  a: Pick<Preset.PoolEntry, "account" | "model">,
  b: Pick<Preset.PoolEntry, "account" | "model">,
) {
  return a.account === b.account && a.model === b.model
}

/**
 * What a pool entry runs on as far as this window knows (the tail its key takes, `Preset.poolKey`): the main account,
 * a local model, a subscription, or a paid account; `undefined` for an account it does not know.
 */
export function poolRuns(account: Preset.PoolEntry["account"], lookup: Preset.Lookup): Preset.PoolRuns | undefined {
  if (account === undefined) return "main"
  if (Preset.isLocal(account)) return "local"
  const billing = lookup(account)?.billing
  if (billing === undefined) return undefined
  if (billing === "local") return "local"
  return billing === "subscription" ? "subscription" : "paid"
}

/**
 * A checked model joins the pool, last. It keeps the candidate's key (`presets.suggest` hands them out, 07 §3.3 이름
 * 규칙) unless another entry has it, then gets `Preset.poolKey`. A model already in the pool on that account changes
 * nothing.
 */
export function withPoolEntry(
  draft: Preset.Draft,
  candidate: Pick<Preset.PoolCandidate, "key" | "model" | "account" | "card" | "runs">,
): Preset.Draft {
  const pool = draft.workers.pool ?? []
  if (pool.some((entry) => samePoolTarget(entry, candidate))) return draft
  const taken = pool.map((entry) => entry.key)
  const entry: Preset.PoolEntry = {
    key: taken.includes(candidate.key) ? Preset.poolKey(candidate.model, taken, candidate.runs) : candidate.key,
    model: candidate.model,
    ...(candidate.account === undefined ? {} : { account: candidate.account }),
    ...(candidate.card === undefined ? {} : { card: candidate.card }),
  }
  return withMode(draft, "pool", [...pool, entry])
}

/** Unchecking a model: its entry leaves the pool (an empty pool waits for a model, {@link problems}). */
export function withoutPoolEntry(draft: Preset.Draft, key: string): Preset.Draft {
  return withMode(
    draft,
    "pool",
    (draft.workers.pool ?? []).filter((entry) => entry.key !== key),
  )
}

/** An entry's effort (07 §2.3); `메인과 같게` stores none (`inherit`). */
export function withPoolEffort(draft: Preset.Draft, key: string, effort: Preset.Effort): Preset.Draft {
  return withPoolEdit(draft, key, (entry) =>
    effort === "inherit" ? Struct.omit(entry, ["effort"]) : { ...entry, effort },
  )
}

/** An entry's one-line note for the LLM (07 §3.3 `Note from the user`); a blank one stores none. */
export function withPoolNote(draft: Preset.Draft, key: string, note: string): Preset.Draft {
  return withPoolEdit(draft, key, (entry) => (note.trim() ? { ...entry, note } : Struct.omit(entry, ["note"])))
}

/** `카드 새로 고치기` (07 §7.2): the cards `presets.set{refreshCards}` froze, on the entries of the same key and target. */
export function withPoolCards(draft: Preset.Draft, stored: ReadonlyArray<Preset.PoolEntry>): Preset.Draft {
  if (!draft.workers.pool) return draft
  return withMode(
    draft,
    "pool",
    draft.workers.pool.map((entry) => {
      const card = stored.find((item) => item.key === entry.key && samePoolTarget(item, entry))?.card
      return card ? { ...entry, card } : entry
    }),
  )
}

function withPoolEdit(
  draft: Preset.Draft,
  key: string,
  edit: (entry: Preset.PoolEntry) => Preset.PoolEntry,
): Preset.Draft {
  return withMode(
    draft,
    "pool",
    (draft.workers.pool ?? []).map((entry) => (entry.key === key ? edit(entry) : entry)),
  )
}

/** The candidates of one account in the checklist (another company's subscription, a local provider, a paid account). */
export interface PoolAccount {
  readonly account: NonNullable<Preset.PoolEntry["account"]>
  readonly rows: ReadonlyArray<Preset.PoolCandidate>
}

/** The checklist's sections (07 §8.1 ①), in `presets.suggest`'s order. */
export interface PoolSections {
  /** `메인 계정에서`: the group's models, run on whichever account is the main. */
  readonly main: ReadonlyArray<Preset.PoolCandidate>
  /** Other companies' subscriptions, each with its accounts (the roomiest first); a pool uses one account per company. */
  readonly companies: ReadonlyArray<{ readonly company: string; readonly accounts: ReadonlyArray<PoolAccount> }>
  readonly local: ReadonlyArray<PoolAccount>
  /** Metered and prepaid accounts, behind `API 키로 돌리기 · 돈이 듭니다`. */
  readonly paid: ReadonlyArray<PoolAccount>
}

export function poolSections(candidates: ReadonlyArray<Preset.PoolCandidate>): PoolSections {
  const pinned = candidates.flatMap((candidate) =>
    candidate.account === undefined ? [] : [{ account: candidate.account, candidate }],
  )
  const accounts = (runs: Preset.PoolRuns) =>
    [
      ...Map.groupBy(
        pinned.filter((item) => item.candidate.runs === runs),
        (item) => item.account,
      ),
    ].map(([account, items]): PoolAccount => ({ account, rows: items.map((item) => item.candidate) }))
  return {
    main: candidates.filter((candidate) => candidate.account === undefined),
    companies: [...Map.groupBy(accounts("subscription"), (item) => item.rows[0]?.company ?? "")].map(
      ([company, list]) => ({ company, accounts: list }),
    ),
    local: accounts("local"),
    paid: accounts("paid"),
  }
}

/**
 * The account a company's section uses (07 §8.1 `[계정 ▾]`): the one the pool pins, else the one picked on screen, else
 * the first listed (the roomiest).
 */
export function poolAccountOf(
  draft: Pick<Preset.Draft, "workers">,
  accounts: ReadonlyArray<PoolAccount>,
  picked?: string,
): PoolAccount["account"] | undefined {
  const ids = accounts.map((item) => item.account)
  const pinned = draft.workers.pool?.find((entry) => ids.some((id) => id === entry.account))?.account
  return pinned ?? ids.find((id) => id === picked) ?? ids[0]
}

/**
 * Another account of a company (07 §8.1, R4: one subscription per company): its checks move to the same model of the
 * new account, with that account's card; a model the new account lacks leaves the pool.
 */
export function withPoolAccount(
  draft: Preset.Draft,
  accounts: ReadonlyArray<PoolAccount>,
  account: PoolAccount["account"],
): Preset.Draft {
  const offered = accounts.find((item) => item.account === account)?.rows ?? []
  const others = accounts.filter((item) => item.account !== account).map((item) => item.account)
  const pool = (draft.workers.pool ?? []).flatMap((entry): Preset.PoolEntry[] => {
    if (!others.some((id) => id === entry.account)) return [entry]
    const next = offered.find((row) => row.model === entry.model)
    if (!next) return []
    return [{ ...Struct.omit(entry, ["card"]), account, ...(next.card === undefined ? {} : { card: next.card }) }]
  })
  return withMode(draft, "pool", pool)
}

/**
 * `추천 묶음` (07 §3.4): the pool becomes the service's recommended keys, at the moment of the click (U3). A key of
 * another company's subscription is the model of the account that company's section uses (`used`), skipped when that
 * account lacks it; an entry already in the pool keeps its effort and note. `presets.suggest` never recommends a paid
 * model.
 */
export function withRecommended(
  draft: Preset.Draft,
  offer: Preset.PoolOffer,
  used: (company: string) => string | undefined,
): Preset.Draft {
  const pool = draft.workers.pool ?? []
  const picked = offer.recommended.flatMap((key) => {
    const named = offer.candidates.filter((candidate) => candidate.key === key)
    const first = named[0]
    if (first?.runs !== "subscription" || first.company === undefined) return first ? [first] : []
    const account = used(first.company)
    return named.filter((candidate) => candidate.account === account)
  })
  return picked.reduce(
    (current, candidate) => {
      const kept = pool.find((entry) => samePoolTarget(entry, candidate))
      return kept
        ? withMode(current, "pool", [...(current.workers.pool ?? []), kept])
        : withPoolEntry(current, candidate)
    },
    withMode(draft, "pool"),
  )
}

/** A candidate's price band among every candidate's raw ranking price (07 §3.4, D8; never Codex's priority order). */
export function poolBand(price: number | undefined, candidates: ReadonlyArray<Preset.PoolCandidate>) {
  const prices = [
    ...new Set(candidates.flatMap((candidate) => (candidate.price === undefined ? [] : [candidate.price]))),
  ].toSorted((a, b) => a - b)
  return bandOf(price, prices)
}

/** The facts the pool previews read ({@link poolFacts}): each entry's, and the main's. */
export interface PoolFactsOf {
  readonly entries: ReadonlyArray<Preset.PoolFacts>
  readonly main: { readonly model: string; readonly side: Preset.PoolMain }
}

/**
 * What the pool previews read (07 §3.3, D8: raw ranking prices, never a local price rule): an entry's facts from the
 * session's `Resolution.pool` when it names the entry with facts, else from the editor's candidate of the same target;
 * the main's from the session, else from the main account's candidate of the main model (`local` by the main's
 * account).
 */
export function poolFacts(input: {
  readonly pool: ReadonlyArray<Preset.PoolEntry>
  readonly candidates: ReadonlyArray<Preset.PoolCandidate>
  readonly session?: Preset.PoolResolution
  readonly main: Preset.Main
}): PoolFactsOf {
  const side = (value: Preset.PoolSide | undefined): Preset.PoolSide => ({
    runs: value?.runs,
    company: value?.company,
    price: value?.price,
  })
  const model = input.main.ref.id
  const own = input.candidates.find((candidate) => candidate.account === undefined && candidate.model === model)
  const served = input.session?.main
  return {
    entries: input.pool.map((entry) => ({
      key: entry.key,
      model: entry.model,
      account: entry.account,
      note: entry.note,
      card: entry.card,
      side: side(
        [
          input.session?.entries.find((item) => item.key === entry.key),
          input.candidates.find((candidate) => samePoolTarget(candidate, entry)),
        ].find((item) => item?.runs !== undefined),
      ),
    })),
    main: {
      model,
      side: served?.runs !== undefined ? served : { ...side(own), local: Preset.isLocal(input.main.account) },
    },
  }
}

/**
 * `모델을 고르지 않으면: 탐색·빠른 일 → GPT-6 Luna · …` (07 §8.1 last line, `Preset.poolDefaults`): the roles of one
 * pick together in role order, then `일반` with the roles that run like the main (`key` absent).
 */
export function defaultItems(defaults: Partial<Readonly<Record<Preset.Role, string>>>) {
  const roles: ReadonlyArray<Preset.Role> = [...Preset.POOL_DEFAULT_ROLES, "general"]
  return [...Map.groupBy(roles, (role) => (role === "general" ? undefined : defaults[role]))]
    .map(([key, list]) => ({ key, roles: list }))
    .toSorted((a, b) => Number(a.key === undefined) - Number(b.key === undefined))
}

/** 수리 기록 of the pool (07 §7.2 모델 묶음): this preset's pool repairs, newest first. */
export function poolHistoryOf(view: Preset.GroupView | undefined, presetID: Preset.ID | undefined) {
  if (!presetID) return []
  return (view?.poolHistory ?? []).filter((record) => record.presetID === presetID).toSorted((a, b) => b.at - a.at)
}

// ---- 자세히 (07 §7.2) ----

/** The levels of the intent scale (07 §2.3 table: low … max), in their usual order. */
const LEVELS = ["low", "medium", "high", "xhigh", "max"]

/** One choice of a role's effort; `available: false` = a level the pinned model does not have (shown dimmed, 2.3). */
export interface EffortChoice {
  readonly value: Preset.Effort
  readonly available: boolean
}

/**
 * The effort choices of a role (07 §2.3 화면) by its first target. A relative target (or none: like the main) has the
 * whole intent scale: `메인과 같게`, `기본`, low … max. A pinned model offers its own levels: the scale with the levels
 * it lacks unavailable, then its other level names as they are. A pinned model without levels (compat, local) shows no
 * effort (`undefined`); one not in the catalog (gone, or not loaded yet) gets the whole scale.
 */
export function effortChoices(
  target: Preset.Target | undefined,
  levels: ReadonlyArray<string> | undefined,
): EffortChoice[] | undefined {
  return levelChoices(target && "pin" in target ? levels : undefined)
}

/**
 * The effort choices of one model by its levels (a pinned target, a model pool entry): the whole scale when they are
 * not known, none for a model without levels, else the scale with the missing levels unavailable and its own names.
 */
export function levelChoices(levels: ReadonlyArray<string> | undefined): EffortChoice[] | undefined {
  const fixed: EffortChoice[] = [
    { value: "inherit", available: true },
    { value: "default", available: true },
  ]
  const scale = (has: (level: string) => boolean) =>
    LEVELS.map((level) => ({ value: Model.VariantID.make(level), available: has(level) }))
  if (levels === undefined) return [...fixed, ...scale(() => true)]
  if (levels.length === 0) return undefined
  return [
    ...fixed,
    ...scale((level) => levels.includes(level)),
    ...levels
      .filter((level) => !LEVELS.includes(level))
      .map((level) => ({ value: Model.VariantID.make(level), available: true })),
  ]
}

/**
 * What a role's effort sends now (07 §2.3 `medium → high로 보냄`): the intent (the main's level for `메인과 같게`)
 * against the variant the role's first usable target resolves to, fitted by `Preset.effortToVariant` inside
 * `Preset.resolve`. `unplaced`: the model has no level for it, so none is sent. `undefined` without an intent to fit
 * (`기본`, or a main without a level) or without a usable target. A model pool entry passes its one resolved entry.
 */
export function effortLine(
  effort: Preset.Effort,
  main: Preset.Main,
  role: { readonly targets: ReadonlyArray<Pick<Preset.Resolved, "ref" | "unplaced">> } | undefined,
) {
  const intent = effort === "inherit" ? main.ref.variant : effort
  const used = role?.targets.find((item) => item.ref !== undefined)
  if (intent === undefined || intent === "default" || !used?.ref) return undefined
  if (used.unplaced) return { intent, unplaced: true as const }
  return { intent, level: used.ref.variant, unplaced: false as const }
}

/**
 * A role's effort (07 §2.3). A role without a row runs like the main, so a level other than `메인과 같게` gives it the
 * row `메인과 같게` with that level; back to `메인과 같게`, such a row goes away again.
 */
export function withEffort(draft: Preset.Draft, role: Preset.Role, effort: Preset.Effort): Preset.Draft {
  const row = draft.workers.roles[role]
  if (!row) return effort === "inherit" ? draft : withRow(draft, role, { targets: [{ rel: "main" }], effort })
  if (effort === "inherit" && onlyMain(row.targets)) return withoutRole(draft, role)
  return withRow(draft, role, { ...row, effort })
}

/**
 * `대상 추가` (07 §7.2): the target goes last, before the list's final `메인과 같게`. `메인과 같게` itself, or a target
 * already listed, changes nothing.
 */
export function withAddedTarget(draft: Preset.Draft, role: Preset.Role, target: Preset.Target): Preset.Draft {
  if ("rel" in target && target.rel === "main") return draft
  const row = draft.workers.roles[role]
  const targets = row && !onlyMain(row.targets) ? row.targets : []
  if (targets.some((item) => sameTarget(item, target))) return draft
  return withRow(draft, role, { targets: [...targets, target], effort: row?.effort ?? "inherit" })
}

/** `위로` (`by: -1`) / `아래로` (`by: 1`): the target at `index` trades places with its neighbour (1순위, 2순위 …). */
export function withMovedTarget(draft: Preset.Draft, role: Preset.Role, index: number, by: -1 | 1): Preset.Draft {
  const row = draft.workers.roles[role]
  const other = index + by
  if (!row || index < 0 || other < 0 || index >= row.targets.length || other >= row.targets.length) return draft
  const targets = row.targets.map((target, at) =>
    at === index ? row.targets[other]! : at === other ? row.targets[index]! : target,
  )
  return withRow(draft, role, { ...row, targets })
}

/**
 * `대상 빼기`: the role keeps its other targets. Without any it runs like the main: the row goes away, or stays as
 * `메인과 같게` when it names a level of its own.
 */
export function withRemovedTarget(draft: Preset.Draft, role: Preset.Role, index: number): Preset.Draft {
  const row = draft.workers.roles[role]
  if (!row) return draft
  const targets = row.targets.filter((_, at) => at !== index)
  if (targets.length) return withRow(draft, role, { ...row, targets })
  return row.effort === "inherit"
    ? withoutRole(draft, role)
    : withRow(draft, role, { targets: [{ rel: "main" }], effort: row.effort })
}

/** The targets 자세히 lists in order: a row of `메인과 같게` alone (a level only) lists none, like no row. */
export function listedTargets(row: Preset.RoleEntry | undefined): ReadonlyArray<Preset.Target> {
  return row && !onlyMain(row.targets) ? row.targets : []
}

function withRow(draft: Preset.Draft, role: Preset.Role, row: Preset.RoleEntry): Preset.Draft {
  return { ...draft, workers: { ...draft.workers, roles: { ...draft.workers.roles, [role]: row } } }
}

function onlyMain(targets: ReadonlyArray<Preset.Target>) {
  return targets.length === 1 && "rel" in targets[0]! && targets[0].rel === "main"
}

/**
 * The caps typed in 자세히 (07 §2.6): whole numbers of 1 or more (else `format`), and neither the at-once nor the
 * per-message cap above the per-conversation cap when there is one (else `order`).
 */
export function readCaps(fields: CapsFields): Preset.Caps | "format" | "order" {
  const caps = parseCaps(fields)
  if (!caps) return "format"
  const total = caps.perSession ?? Infinity
  return caps.concurrent > total || caps.perMessage > total ? "order" : caps
}

/**
 * The role cards the guidance preview renders (07 §3.3), by the service's rule (own-accounts presets/guidance.ts
 * `cards`) over this window's catalog: each role's first configured target only. `메인과 같게` is the main's card,
 * `더 가벼운 모델` lighter on the main account (the main's card when the pair is the main itself). A pinned target says
 * what it runs on, another company's canonical id when not the main's, and its relation to the main by input price
 * (07 §3.4, the API twin pricing a free slot); without both prices a local model is lighter than a hosted main and
 * anything else similar. A target whose account is gone runs like the main.
 */
export function previewCards(input: {
  readonly workers: Preset.Workers
  readonly main: Preset.Main | undefined
  readonly resolution: Preset.Resolution | undefined
  readonly accounts: Readonly<Record<string, Account.View>>
  readonly models: ReadonlyArray<CatalogModel>
}): Partial<Record<Preset.Role, Preset.Card>> {
  const main = input.main
  const companyOf = (account: string) => {
    const owner = Preset.isLocal(account) ? undefined : input.accounts[account]
    return owner && Preset.company(owner)
  }
  const priceIn = (account: string, modelID: string) => {
    const providerID =
      input.accounts[account]?.providerID ?? (Preset.isLocal(account) ? account.slice("local:".length) : undefined)
    const model = input.models.find((item) => item.providerID === providerID && item.id === modelID)
    return model && priceOf(model, input.models)
  }
  const home = main && companyOf(main.account)
  const cardOf = (role: Preset.Role, target: Preset.Target): Preset.Card => {
    if ("rel" in target) {
      if (target.rel === "main") return Preset.MAIN_CARD
      const ref = input.resolution?.roles[role]?.targets[0]?.ref
      return main && ref?.providerID === main.ref.providerID && ref.id === main.ref.id
        ? Preset.MAIN_CARD
        : { relation: "lighter", runs: "main" }
    }
    const pin = target.pin
    const local = Preset.isLocal(pin.account)
    const billing = local ? "local" : input.accounts[pin.account]?.billing
    if (billing === undefined) return Preset.MAIN_CARD
    const company = local ? undefined : companyOf(pin.account)
    const runs =
      pin.account === main?.account
        ? "main"
        : billing === "local"
          ? "local"
          : billing === "subscription"
            ? "subscription"
            : "paid"
    const other = company !== undefined && company !== home ? { company } : {}
    if (main && !local && company === home && pin.model === main.ref.id) return { relation: "same", runs, ...other }
    const price = priceIn(pin.account, pin.model)
    const against = main && priceIn(main.account, main.ref.id)
    const relation =
      price === undefined || against === undefined
        ? local && main !== undefined && !Preset.isLocal(main.account)
          ? "lighter"
          : "similar"
        : price < against
          ? "lighter"
          : price > against
            ? "stronger"
            : "similar"
    return { relation, runs, ...other }
  }
  const workers = input.workers
  const mode = Preset.modeOf(workers)
  return Object.fromEntries(
    Preset.ROLES.flatMap((role) => {
      const target =
        mode === "single" ? workers.single : mode === "by-role" ? workers.roles[role]?.targets[0] : undefined
      return target ? [[role, cardOf(role, target)] as const] : []
    }),
  )
}

/**
 * The `own.preset` instruction this draft adds with ultra off (07 §3.3, 자세히 `넣는 안내문`): `Preset.renderGuidance`,
 * the service's renderer, over the preset's caps in force; a model pool's block (`Preset.poolGuidance`) replaces the
 * role cards; the per-call effort line unless the draft raises no effort (07 §2.3), like the service's
 * `PresetGuidance.render`. `null`: it adds none (requests as without a preset).
 */
export function guidanceOf(
  draft: Pick<Preset.Draft, "delegation" | "caps" | "ultraCaps" | "subagentEffortMax" | "forcedEffort">,
  cards: Partial<Record<Preset.Role, Preset.Card>>,
  pool?: Preset.PoolGuidance,
) {
  return Preset.renderGuidance({
    delegation: draft.delegation,
    ultra: false,
    caps: Preset.caps(draft, false),
    cards,
    ...(pool ? { pool } : {}),
    effort: Preset.effortMaxOf(draft) !== "off" && !Preset.forcedEffortOf(draft.forcedEffort),
  })
}

/** One row of 자세히's lighter-pair table (07 §4.2): a main model and its stored pair, none yet when absent. */
export interface LighterRow {
  readonly main: string
  readonly pair?: Preset.Lighter
}

/**
 * 자세히's lighter-pair table (07 §4.2, §7.2 `GPT-6 Astra → GPT-6 Luna · 자동 [바꾸기]`): the group's stored rows (a gone
 * pair keeps its `missing` mark, `없어짐`), with the preview's main first when it has no pair yet, so a local group
 * (never decided by itself) can get one.
 */
export function lighterRows(stored: Readonly<Record<string, Preset.Lighter>> | undefined, main?: string): LighterRow[] {
  const rows = Object.entries(stored ?? {}).map(([id, pair]): LighterRow => ({ main: id, pair }))
  return main === undefined || stored?.[main] ? rows : [{ main }, ...rows]
}

/**
 * Models a main model's lighter pair can be set to (`짝 바꾸기`): the main account's other models a subagent can run
 * on, cheapest first by input price (07 §3.4; unpriced ones last), then by name.
 */
export function lighterChoices(models: ReadonlyArray<CatalogModel>, providerID: string, mainModelID: string) {
  const price = (model: CatalogModel) => priceOf(model, models) ?? Number.POSITIVE_INFINITY
  return models
    .filter((model) => model.providerID === providerID && model.id !== mainModelID && pickable(model))
    .toSorted((a, b) => price(a) - price(b) || a.name.localeCompare(b.name))
}

/** `★ 이 묶음에서 먼저 쓰기` as a toggle (07 §7.2): the preset becomes the group's ★, or, already it, `평소대로` does. */
export function starToggle(group: Preset.Group, presetID: Preset.ID, star: Preset.ID): Preset.ID {
  return star === presetID ? Preset.builtinID(group) : presetID
}

/**
 * `다른 묶음에 복사…` (07 §2.1, §7.2): a new preset of `group` with the draft's settings, as `presets.set` stores it
 * (no `id`; never a main model or effort). The service judges R4 for the new group (`same_company_subscription`).
 */
export function copyInput(draft: Preset.Draft, group: Preset.Group): Preset.Save {
  return toSave({ ...draft, id: undefined, group })
}

/** 수리 기록 (07 §7.2): this preset's repairs, newest first; a preset not saved yet has none. */
export function historyOf(view: Preset.GroupView | undefined, presetID: Preset.ID | undefined) {
  if (!presetID) return []
  return (view?.history ?? []).filter((record) => record.presetID === presetID).toSorted((a, b) => b.at - a.at)
}

/** A pinned target's Codex retirement time (07 §4.3): shown dimmed beside it, never a notice or a successor (U3). */
export function retirementOf(view: Preset.GroupView | undefined, target: Preset.Target) {
  return "pin" in target ? view?.retirements?.[target.pin.model] : undefined
}

/**
 * The draft's pinned targets (the model pool's pins included, `Preset.targetsOf`) whose model has a retirement date
 * (07 §4.3), each model once, soonest first.
 */
export function retiringOf(view: Preset.GroupView | undefined, draft: Pick<Preset.Draft, "workers">) {
  const pins = Preset.targetsOf(draft.workers).flatMap((target) => {
    const at = retirementOf(view, target)
    return at === undefined || !("pin" in target) ? [] : [{ target, at }]
  })
  return pins
    .filter((item, index) => pins.findIndex((other) => other.target.pin.model === item.target.pin.model) === index)
    .toSorted((a, b) => a.at - b.at)
}

const two = (value: number) => String(value).padStart(2, "0")

/** `10-14` in local time: a retirement date (07 §4.3 `10-14 은퇴 예정(Codex)`). */
export function monthDay(at: number) {
  const date = new Date(at)
  return `${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/** `10-14 09:00` in local time: when a repair was recorded (07 §7.2). */
export function stamp(at: number) {
  const date = new Date(at)
  return `${monthDay(at)} ${two(date.getHours())}:${two(date.getMinutes())}`
}

// ---- preview (07 §7.1 last line, §4.2) ----

/** Where a Ref or model of the catalog lives as a preset account: an own account, else `local:<id>` for a local one. */
export function accountKey(providerID: string, accountOf: (providerID: string) => Account.View | undefined) {
  const account = accountOf(providerID)
  if (account) return account.id
  return Preset.LOCAL_PROVIDERS.some((id) => id === providerID) ? `local:${providerID}` : providerID
}

/** The main a preview resolves against, with the main model's own levels. */
export function mainOf(
  ref: MainRef | undefined,
  accountOf: (providerID: string) => Account.View | undefined,
  models: ReadonlyArray<CatalogModel>,
): Preset.Main | undefined {
  if (!ref) return undefined
  const model = models.find((item) => item.providerID === ref.providerID && item.id === ref.id)
  return {
    account: accountKey(ref.providerID, accountOf),
    ref: {
      providerID: Provider.ID.make(ref.providerID),
      id: Model.ID.make(ref.id),
      ...(ref.variant ? { variant: Model.VariantID.make(ref.variant) } : {}),
    },
    variants: model?.variants.map((variant) => variant.id) ?? [],
  }
}

/** Whether an account can serve now: `ready`, or an own account before its first answer (the Claude slot's means off). */
export function serving(account: Account.View) {
  return account.status === "ready" || (account.status === "unverified" && account.kind !== "claude-sub")
}

/**
 * The main of a preview opened from settings (07 §7.1): the group's new-session default model on its first account
 * that can serve (a local group: on its provider), else the group rule over that account's models (07 §2.2), priced
 * like the service: a ChatGPT login's free models by their API twin in the catalog ({@link priceOf}).
 */
export function groupMain(
  group: Preset.Group,
  accounts: ReadonlyArray<Account.View>,
  defaultModel: Preset.DefaultModel | null | undefined,
  models: ReadonlyArray<CatalogModel>,
): MainRef | undefined {
  const providerID = Preset.isLocal(group)
    ? group.slice("local:".length)
    : (
        accounts.find((account) => account.kind === group && serving(account)) ??
        accounts.find((account) => account.kind === group && account.status !== "retired")
      )?.providerID
  if (!providerID) return undefined
  // Enabled and not `deprecated`: a model the catalog dropped runs on in its sessions but is not offered (07 §4.4); a
  // speed mode entry is not offered either (02 §4.8).
  const offered = models.filter(
    (model) =>
      model.providerID === providerID &&
      model.enabled &&
      model.status !== "deprecated" &&
      Speed.modeOf(model) === undefined,
  )
  const preferred = defaultModel && offered.find((model) => model.id === defaultModel.id)
  if (preferred)
    return { providerID, id: preferred.id, ...(defaultModel.variant ? { variant: defaultModel.variant } : {}) }
  const auto = Preset.defaultModel(
    group,
    Preset.candidates(offered, (model) => priceOf(model, models)),
  )
  return auto ? { providerID, id: auto.id, ...(auto.variant ? { variant: auto.variant } : {}) } : undefined
}

/**
 * What `Preset.resolve` reads in the editor: the model as the account or local provider offers it in this window's
 * catalog; an account that cannot serve now is `unavailable` (the service also applies 02 §5.7's filters).
 */
export function catalogOf(
  accounts: Readonly<Record<string, Account.View>>,
  models: ReadonlyArray<CatalogModel>,
): Preset.Catalog {
  return (account, modelID) => {
    const owner = accounts[account]
    if (owner && !serving(owner)) return "unavailable"
    const providerID = owner?.providerID ?? (Preset.isLocal(account) ? account.slice("local:".length) : undefined)
    const model =
      providerID === undefined
        ? undefined
        : models.find((item) => item.providerID === providerID && item.id === modelID)
    return model ? { providerID: model.providerID, variants: model.variants.map((variant) => variant.id) } : undefined
  }
}

/**
 * Input price of a model (07 §3.4): its own, else its twin's on another provider of the catalog (a ChatGPT or Claude
 * subscription slot is free; the API catalog's same model carries the price).
 */
export function priceOf(model: Pick<Preset.Entry, "id" | "cost">, models: ReadonlyArray<CatalogModel>) {
  const own = Preset.basePrice(model.cost)
  if (own !== undefined) return own
  const twin = models.find((item) => item.id === model.id && item.cost.length > 0)
  return twin ? Preset.basePrice(twin.cost) : undefined
}

/**
 * The lighter pairs the preview uses (07 §4.2): the group's stored table, and for a main without a stored pair the pick
 * the service would make now (`Preset.lighterPick`, not stored; the service decides it once on first need).
 */
export function lighterFor(
  group: Preset.Group,
  stored: Readonly<Record<string, Preset.Lighter>> | undefined,
  main: Preset.Main | undefined,
  models: ReadonlyArray<CatalogModel>,
): Readonly<Record<string, Preset.Lighter>> {
  const table = { ...stored }
  if (!main || table[main.ref.id]) return table
  const offered = models.filter((model) => model.providerID === main.ref.providerID && model.enabled)
  const pick = Preset.lighterPick(
    group,
    main.ref.id,
    Preset.candidates(offered, (model) => priceOf(model, models)),
  )
  return pick ? { ...table, [main.ref.id]: pick } : table
}

/**
 * The resolution line (07 §7.1): every subagent like the main, one place for all, each role with a row, or each model
 * of the pool (the Ref it runs on, or why it is skipped: a call naming it then runs on the default rule).
 */
export type Line =
  | { readonly kind: "same" }
  | { readonly kind: "single"; readonly ref: Model.Ref; readonly fallback: boolean }
  | {
      readonly kind: "roles"
      readonly items: ReadonlyArray<{ readonly role: Preset.Role; readonly ref: Model.Ref; readonly fallback: boolean }>
    }
  | {
      readonly kind: "pool"
      readonly items: ReadonlyArray<{ readonly key: string; readonly ref?: Model.Ref; readonly skip?: Preset.Skip }>
    }

export function resolutionLine(draft: Preset.Draft, resolution: Preset.Resolution): Line {
  const workers = draft.workers
  const mode = draftMode(draft)
  if (mode === "pool")
    return {
      kind: "pool",
      items: (resolution.pool?.entries ?? []).map((entry) => ({ key: entry.key, ref: entry.ref, skip: entry.skip })),
    }
  if (mode === "single" && workers.single) {
    const general = resolution.roles.general
    return general ? { kind: "single", ref: general.use, fallback: general.fallback } : { kind: "same" }
  }
  if (mode !== "by-role") return { kind: "same" }
  const items = [...BASE_ROLES, ...EXTRA_ROLES].flatMap((role) => {
    const resolved = resolution.roles[role]
    return resolved && resolved.targets.length ? [{ role, ref: resolved.use, fallback: resolved.fallback }] : []
  })
  return items.length ? { kind: "roles", items } : { kind: "same" }
}

/** `provider/model#variant`, shown only behind `[복사]` (07 §7.1). */
export function refText(ref: Pick<Model.Ref, "providerID" | "id" | "variant">) {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`
}

/** The text `[복사]` puts on the clipboard: one `role: provider/model#variant` line per resolved place (pool: key). */
export function copyLines(line: Line) {
  if (line.kind === "same") return ""
  if (line.kind === "single") return `*: ${refText(line.ref)}`
  if (line.kind === "pool")
    return line.items.flatMap((item) => (item.ref ? [`${item.key}: ${refText(item.ref)}`] : [])).join("\n")
  return line.items.map((item) => `${item.role}: ${refText(item.ref)}`).join("\n")
}

// ---- target picker (07 §7.1 `바꾸기`, §3.4 badges and cards) ----

export type Badge = "subscription" | "metered" | "prepaid" | "local" | "mainAccount"
export type Band = "low" | "mid" | "high"

/** A local model's running window as the service checked it (07 §6.2 #8); unknown = `창 확인 안 됨`. */
export type LocalCheck = (
  providerID: string,
  modelID: string,
) => { readonly status: Account.LocalWindow["status"]; readonly runtime?: number | null } | undefined

/** One model a role may be pinned to, with the card facts of 07 §3.4 (all from the live catalog). */
export interface ModelRow {
  readonly target: Preset.Target
  readonly name: string
  readonly badge: Badge
  /** The full window; a local model shows its running window, and only once verified. */
  readonly window?: number
  readonly verified?: boolean
  readonly band?: Band
  /** Input price ranking the band (07 §3.4); also what a client-side suggestion ranks by. */
  readonly price?: number
  /** Reasoning effort levels the model offers (0 = none shown). */
  readonly levels: number
  readonly image: boolean
  readonly released: number
}

export interface AccountSection {
  readonly account: Account.View
  readonly rows: ReadonlyArray<ModelRow>
}

export interface PickerSections {
  /** Other companies' subscriptions (07 §3.4); never one of the group's own company (R4). */
  readonly subscriptions: ReadonlyArray<AccountSection>
  readonly local: ReadonlyArray<{ readonly providerID: string; readonly rows: ReadonlyArray<ModelRow> }>
  /** Local model accounts (02 §3.3a): free, listed with the local LLMs. */
  readonly localAccounts: ReadonlyArray<AccountSection>
  /** Metered and prepaid accounts, shown only after the `API 키로 돌리기 · 돈이 듭니다` row is clicked (PG11). */
  readonly paid: ReadonlyArray<AccountSection>
  /** The company whose subscriptions are left out (`다른 <회사> 계정은 쓸 수 없어 목록에 없습니다`). */
  readonly hidden?: string
}

/** Accounts a picker lists: not retired or turned off; the Claude slot only once acknowledged (07 §3.4 동의). */
function listed(account: Account.View) {
  if (account.status === "retired" || account.status === "disabled") return false
  return account.kind !== "claude-sub" || account.status !== "unverified"
}

/**
 * Models a subagent can run on: enabled, not deprecated, with tools (07 §3.4: every role uses tools), and not a speed
 * mode entry (02 §4.8: a child inherits the root's speed on its account instead).
 */
function pickable(model: CatalogModel) {
  return model.enabled && model.status !== "deprecated" && model.capabilities.tools && Speed.modeOf(model) === undefined
}

/**
 * The target picker's sections for a group (07 §7.1, §7.3). Same-company subscriptions are never listed, the same
 * ChatGPT login's `siwc`/`codex` sibling included (a saved preset may run on another subscription of the group's company
 * only relatively, on the main account). Price bands rank the listed models' input prices in thirds (a price order, as
 * 07 §3.4 says, never a hard-coded table).
 */
export function pickerSections(input: {
  readonly group: Preset.Group
  readonly accounts: ReadonlyArray<Account.View>
  readonly models: ReadonlyArray<CatalogModel>
  readonly local?: LocalCheck
}): PickerSections {
  const home = Preset.isLocal(input.group) ? undefined : Preset.company({ kind: input.group })
  const shown = input.accounts.filter(listed)
  const row = (model: CatalogModel, account: Account.ID | `local:${string}`, badge: Badge): ModelRow => {
    const price = priceOf(model, input.models)
    return {
      target: { pin: { account, model: Model.ID.make(model.id) } },
      name: model.name,
      badge,
      window: model.limit.context,
      ...(price === undefined ? {} : { price }),
      levels: model.variants.length,
      image: model.capabilities.input.includes("image"),
      released: model.time.released,
    }
  }
  const section = (account: Account.View, badge: Badge): AccountSection => ({
    account,
    rows: input.models
      .filter((model) => model.providerID === account.providerID && pickable(model))
      .map((model) => row(model, account.id, badge)),
  })
  const subscriptions = shown
    .filter((account) => account.billing === "subscription" && Preset.company(account) !== home)
    .map((account) => section(account, "subscription"))
  const localAccounts = shown
    .filter((account) => account.billing === "local")
    .map((account) => section(account, "local"))
  const paid = shown
    .filter((account) => account.billing === "metered" || account.billing === "prepaid")
    .map((account) => section(account, account.billing === "prepaid" ? "prepaid" : "metered"))
  const local = Preset.LOCAL_PROVIDERS.flatMap((providerID) => {
    const rows = input.models
      .filter((model) => model.providerID === providerID && pickable(model))
      .map((model): ModelRow => {
        const check = input.local?.(providerID, model.id)
        const verified = check?.status === "verified"
        return {
          ...row(model, `local:${providerID}`, "local"),
          window: verified ? (check?.runtime ?? undefined) : undefined,
          verified,
        }
      })
    return rows.length ? [{ providerID, rows }] : []
  })
  // Bands rank the listed accounts' models only; a local model has no price.
  const prices = [
    ...new Set(
      [...subscriptions, ...paid].flatMap((item) =>
        item.rows.flatMap((entry) => (entry.price === undefined ? [] : [entry.price])),
      ),
    ),
  ].toSorted((a, b) => a - b)
  const banded = (item: AccountSection): AccountSection => ({
    account: item.account,
    rows: item.rows.map((entry) => {
      const band = bandOf(entry.price, prices)
      return band ? { ...entry, band } : entry
    }),
  })
  const hidden = hiddenCompany(input.group, shown)
  return {
    subscriptions: subscriptions.map(banded),
    local,
    localAccounts,
    paid: paid.map(banded),
    ...(hidden ? { hidden } : {}),
  }
}

/**
 * The group's company when it has subscription accounts a preset may not pin (R4: `다른 <회사> 계정은 쓸 수 없어 목록에
 * 없습니다`); the picker and the pool checklist both say so. `undefined` for a local group or none to hide.
 */
export function hiddenCompany(group: Preset.Group, accounts: ReadonlyArray<Account.View>) {
  const home = Preset.isLocal(group) ? undefined : Preset.company({ kind: group })
  return accounts.some(
    (account) => listed(account) && account.billing === "subscription" && Preset.company(account) === home,
  )
    ? home
    : undefined
}

/** A price's third among the sorted distinct prices: one price alone is `mid`. */
function bandOf(price: number | undefined, prices: ReadonlyArray<number>): Band | undefined {
  if (price === undefined || prices.length === 0) return undefined
  if (prices.length === 1) return "mid"
  const rank = prices.indexOf(price) / (prices.length - 1)
  return rank < 1 / 3 ? "low" : rank <= 2 / 3 ? "mid" : "high"
}

/**
 * The picker's pinned targets as `Preset.suggest` input, for a client-side suggestion when the service has no
 * `presets.suggest` yet. Paid ones are passed too; `Preset.suggest` never picks them.
 */
export function pinnables(sections: PickerSections): Preset.Pinnable[] {
  const accounts = [...sections.subscriptions, ...sections.localAccounts, ...sections.paid].flatMap((section) =>
    section.rows.flatMap((row): Preset.Pinnable[] =>
      "pin" in row.target
        ? [
            {
              account: row.target.pin.account,
              model: row.target.pin.model,
              billing: section.account.billing,
              company: Preset.company(section.account),
              tools: true,
              ...(row.price === undefined ? {} : { price: row.price }),
            },
          ]
        : [],
    ),
  )
  const local = sections.local.flatMap((item) =>
    item.rows.flatMap((row): Preset.Pinnable[] =>
      "pin" in row.target
        ? [
            {
              account: row.target.pin.account,
              model: row.target.pin.model,
              billing: "local",
              tools: true,
              verified: row.verified === true,
            },
          ]
        : [],
    ),
  )
  return [...accounts, ...local]
}

/** The first day of this month (local time), where `이번 달` spend starts. */
export function monthStart(now: number) {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

/** This month's spend of an account with a budget: its `api.budget_month` window (limit − remaining). */
export function budgetSpent(windows: ReadonlyArray<Limit.Window> | undefined) {
  const window = windows?.find((item) => item.id === "api.budget_month")
  if (window?.limit === undefined || window.remaining === undefined) return undefined
  return Math.max(0, window.limit - window.remaining)
}

/** A monthly budget typed in the picker: empty = `상한 없음` (`null`), else a non-negative number; `undefined` = invalid. */
export function parseBudget(text: string): number | null | undefined {
  const value = text.replaceAll(/[,$\s]/g, "")
  if (!value) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

// ---- settings 프리셋 page (07 §7.1, §2.2, §2.6, §5.1) ----

/**
 * The group tabs (07 §7.1 `ChatGPT | Claude 구독 | DeepSeek | Ollama …`): groups with an account (not retired), each
 * kind its own group (`siwc` too), in the switcher's kind order; then local groups whose provider is in the catalog.
 */
export function presetTabs(accounts: ReadonlyArray<Account.View>, models: ReadonlyArray<CatalogModel>): Preset.Group[] {
  const kinds = KIND_ORDER.filter((kind) =>
    accounts.some((account) => account.kind === kind && account.status !== "retired"),
  )
  const locals = Preset.LOCAL_PROVIDERS.filter((id) => models.some((model) => model.providerID === id && model.enabled))
  return [...kinds, ...locals.map((id): Preset.Group => `local:${id}`)]
}

/** Accounts of a group: the header's `모든 <묶음> 계정(n개)`. */
export function groupAccounts(group: Preset.Group, accounts: ReadonlyArray<Account.View>) {
  return accounts.filter((account) => account.kind === group && account.status !== "retired")
}

export function starOf(group: Preset.Group, view: Preset.GroupView | undefined): Preset.ID {
  return view?.star ?? Preset.builtinID(group)
}

/**
 * Where a session's preset controls read presets (07 §7.3, §8.1 원격). `local`: this PC's `presets.list`, with its
 * repairs. `mirror` (T3): a remote server's own `presets.list`, the mirror of this PC's presets (no repairs on a remote
 * service); applying goes to that server, editing is this PC's. `builtin`: a remote server that does not mirror them
 * (an older build, or before its first mirror) uses `평소대로` only. A mirroring server lists the same stored presets
 * as this PC, so one listing none while this PC has some does not mirror; with none on either side there is nothing to
 * tell apart, and nothing to miss.
 */
export type PresetPlace = "local" | "mirror" | "builtin"

export function presetPlace(
  remote: Readonly<Record<string, Preset.GroupView>> | undefined,
  local: Readonly<Record<string, Preset.GroupView>>,
): PresetPlace {
  if (!remote) return "local"
  const stored = (groups: Readonly<Record<string, Preset.GroupView>>) =>
    Object.values(groups).some((view) => view.presets?.some((preset) => !Preset.isBuiltin(preset.id)))
  return stored(remote) || !stored(local) ? "mirror" : "builtin"
}

/**
 * A group's presets for the list (07 §7.1): ★ first and `평소대로` always, as `presets.list` gives them; an older
 * service lists none, so `평소대로` alone.
 */
export function presetRows(group: Preset.Group, view: Preset.GroupView | undefined): Preset.Listed[] {
  const builtin: Preset.Listed = { ...Preset.builtin(group), status: "ok" }
  const listed = view?.presets ?? []
  const rows = listed.some((item) => item.id === builtin.id) ? [...listed] : [builtin, ...listed]
  const star = starOf(group, view)
  return rows.toSorted((a, b) => Number(b.id === star) - Number(a.id === star))
}

export type UltraChoice = "save" | "recommended" | "large" | "custom"

export const ULTRA_CHOICES: ReadonlyArray<UltraChoice> = ["save", "recommended", "large", "custom"]

export function ultraChoice(value: Preset.UltraCaps): UltraChoice {
  return typeof value === "string" ? value : "custom"
}

/** A preset's own ultra level (07 §2.6, 자세히): `global` follows the settings page's level (`ultraCaps: null`). */
export type PresetUltraChoice = "global" | UltraChoice

export const PRESET_ULTRA_CHOICES: ReadonlyArray<PresetUltraChoice> = ["global", ...ULTRA_CHOICES]

export function presetUltraChoice(value: Preset.UltraCaps | null): PresetUltraChoice {
  return value === null ? "global" : ultraChoice(value)
}

/** The `ultraCaps` a choice stores: `null` for the global level, the level's name, or the typed numbers. */
export function ultraCapsOf(choice: PresetUltraChoice, custom: Preset.Caps): Preset.UltraCaps | null {
  if (choice === "global") return null
  return choice === "custom" ? custom : choice
}

/** The caps as typed; `perSession: null` is the conversation cap turned off (`제한 없음`, the default). */
export interface CapsFields {
  concurrent: string
  perMessage: string
  perSession: string | null
}

/** The number a conversation cap starts at when the user turns it on (`대화당 상한 두기`): the old default. */
export const PER_SESSION_START = String(Preset.LEGACY_PER_SESSION)

/** The typed fields of caps in force: no conversation cap is `null`. */
export function capsFields(caps: Preset.Caps): CapsFields {
  return {
    concurrent: String(caps.concurrent),
    perMessage: String(caps.perMessage),
    perSession: caps.perSession === null ? null : String(caps.perSession),
  }
}

/** `직접 정하기` numbers: whole numbers of 1 or more (a conversation cap only when on), else `undefined`. */
export function parseCaps(fields: CapsFields) {
  const values = [fields.concurrent, fields.perMessage, fields.perSession ?? "1"].map((text) =>
    /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0,
  )
  if (values.some((value) => value < 1)) return undefined
  return {
    concurrent: values[0]!,
    perMessage: values[1]!,
    perSession: fields.perSession === null ? null : values[2]!,
  } satisfies Preset.Caps
}

/** The `새 대화 기본 모델` row's source label (07 §2.2 `Codex 설정을 따름` …). */
export function defaultLabel(view: Preset.GroupView | undefined): Preset.DefaultLabel | undefined {
  return view?.label ?? (view?.defaultModel ? Preset.labelOf(view.defaultModel) : undefined)
}
