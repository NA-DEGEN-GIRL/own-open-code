// Pure model of the "모델 @ 계정" picker (03 §5.2): accounts grouped by provider kind, search over account, provider
// and model names, keyboard movement inside a column, "keep the same model when the account changes" (else the group's
// default, 07 §2.2), the tightest limit window for mini bars (03 §7.2), why an account cannot run right now, the
// team's R4 filter of a team session's list (06 §10.1, 07 §5.5), and a model row's catalog marks (07 §4.3, §7.3: `새`
// for a model the pinned template gained lately, a dim Codex retirement date). No Solid, no DOM: unit-tested.
import type { Account, Kind, Limit } from "@own/protocol"
import { LimitModel } from "@own/protocol/limit-model"
import { LimitRank } from "@own/protocol/limit-rank"
import { Preset } from "@own/protocol/preset"

/**
 * Group order of 03 §5.2's drawing: subscriptions first, then APIs, then the Claude routes: Claude Agent (02 §8.10)
 * beside the third-party slot, which stays last.
 */
export const KIND_ORDER: readonly Kind.Any[] = [
  "codex",
  "siwc",
  "oai",
  "anth",
  "ds",
  "xai",
  "or",
  "compat",
  "claude-agent",
  "claude-sub",
]

/** Accounts the picker never lists (turned off or removed, 02 §2.4.1). */
const HIDDEN: ReadonlySet<Account.Status> = new Set(["disabled", "retired"])

export interface PickerModel {
  readonly id: string
  readonly name: string
  readonly variants: readonly string[]
}

export interface Group {
  readonly kind: Kind.Any
  readonly accounts: readonly Account.View[]
}

/**
 * Groups by kind in {@link KIND_ORDER}. `first` (e.g. `switch.suggested` candidates, 03 §6.6) moves those
 * providerIDs to the front of their group in the given order.
 */
export function groupAccounts(accounts: readonly Account.View[], first: readonly string[] = []): Group[] {
  const rank = (account: Account.View) => {
    const index = first.indexOf(account.providerID)
    return index < 0 ? first.length : index
  }
  return KIND_ORDER.flatMap((kind) => {
    const list = accounts
      .filter((account) => account.kind === kind && !HIDDEN.has(account.status))
      .map((account, index) => ({ account, index }))
      .toSorted((a, b) => rank(a.account) - rank(b.account) || a.index - b.index)
      .map((item) => item.account)
    return list.length ? [{ kind, accounts: list }] : []
  })
}

/** Case-insensitive search over the account label, its provider kind name and its model names (03 §5.2 "검색"). */
export function matchesQuery(
  query: string,
  account: Pick<Account.View, "label" | "shortLabel">,
  kindName: string,
  modelNames: readonly string[],
) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  const hay = [account.label, account.shortLabel, kindName, ...modelNames]
  return hay.some((text) => text.toLocaleLowerCase().includes(needle))
}

/** Models of one account filtered by the query; every model when the account itself matched by name. */
export function filterModels(query: string, accountMatched: boolean, models: readonly PickerModel[]) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle || accountMatched) return models
  const hits = models.filter(
    (model) => model.name.toLocaleLowerCase().includes(needle) || model.id.toLocaleLowerCase().includes(needle),
  )
  return hits.length ? hits : models
}

/** Wrap-around move inside a column (03 §5.2 "↑↓: 활성 열 안에서 이동"). */
export function step<T>(items: readonly T[], current: T | undefined, delta: 1 | -1): T | undefined {
  if (!items.length) return undefined
  const index = current === undefined ? -1 : items.indexOf(current)
  if (index < 0) return delta > 0 ? items[0] : items.at(-1)
  return items[(index + delta + items.length) % items.length]
}

/**
 * The model and effort after the account changes (03 §5.2 "오른쪽 열", 07 §2.2): the same model when the new account
 * has it (same id, else same display name), so an account switch and a model switch never happen at once by accident,
 * with the current effort when that model offers it; else the account's provider group default with its effort; else
 * the account's first model.
 */
export function modelForAccount(
  current: { readonly id: string; readonly name?: string; readonly variant?: string } | undefined,
  models: readonly PickerModel[],
  groupDefault?: { readonly id: string; readonly variant?: string },
) {
  const kept =
    current &&
    (models.find((model) => model.id === current.id) ??
      (current.name ? models.find((model) => model.name === current.name) : undefined))
  if (kept) return { model: kept, variant: keepVariant(current?.variant, kept) }
  const preferred = groupDefault && models.find((model) => model.id === groupDefault.id)
  if (preferred) return { model: preferred, variant: keepVariant(groupDefault?.variant, preferred) }
  const first = models[0]
  return first ? { model: first, variant: undefined } : undefined
}

/**
 * The picked model (03 §5.2, LV 2026-10-25): the user's explicit choice of model and effort. The conversation's at open,
 * then what the user chooses in the model column (a model or its effort) or a target (`최근`, a request's); never what
 * moving between accounts maps it to ({@link rowSelection}), so no row depends on where the cursor is.
 */
export interface Picked {
  readonly id: string
  readonly name?: string
  readonly variant?: string
}

/**
 * The model a switcher row's account would run (03 §5.2, LV 2026-10-24, one rule since 2026-10-25): every row, the
 * selected one or not, takes {@link modelForAccount} of the {@link Picked} model on its own models and group default,
 * which is exactly what selecting the row chooses ({@link rowSelection}); while the account's model list is not known
 * yet, the picked model itself. The row's line, its `한도 도달` and `추천` rank with it, so a row reads the same
 * wherever the cursor is, and a model weekly bucket counts on the rows that would run that model.
 */
export function rowModel(
  picked: Picked | undefined,
  models: readonly PickerModel[],
  groupDefault?: { readonly id: string; readonly variant?: string },
) {
  if (models.length === 0) return picked?.id
  return modelForAccount(picked, models, groupDefault)?.model.id
}

/**
 * Selecting an account's row, by the cursor or a click (03 §5.2): exactly its {@link rowModel}, with the picked effort
 * where that model offers it (else the group default's). It leaves the picked model as it was: going Claude 1 (Opus) →
 * ChatGPT (GPT-5.5) → Claude 2 keeps Opus picked, so Claude 2 runs Opus and coming back to Claude 1 selects Opus again.
 */
export function rowSelection(
  picked: Picked | undefined,
  accountID: string,
  models: readonly PickerModel[],
  groupDefault?: { readonly id: string; readonly variant?: string },
) {
  const chosen = modelForAccount(picked, models, groupDefault)
  if (!chosen) return { accountID, modelID: picked?.id, variant: picked?.variant }
  return { accountID, modelID: chosen.model.id, variant: chosen.variant }
}

/** How long a model the pinned template gained carries the `새` tag (07 §4.3, a fixed display window). */
export const NEW_TAG_DAYS = 14

const DAY = 24 * 60 * 60_000

/**
 * A model row's catalog marks (07 §4.3, §7.3): `fresh` while the model was added to the account's pinned template
 * (`accounts.list` `models[].addedAt`) within {@link NEW_TAG_DAYS}, the `새` tag and nothing else (no notice, nothing
 * switches); `retires`, the Codex retirement time `presets.list` names for the group (epoch ms), shown as a dim date
 * only, never a notice or a successor (U3).
 */
export function modelMarks(input: {
  readonly marks: readonly Account.ModelMark[] | undefined
  readonly retirements: Readonly<Record<string, number>> | undefined
  readonly modelID: string
  readonly now: number
}) {
  const added = input.marks?.find((mark) => mark.id === input.modelID)?.addedAt
  const at = added === undefined ? Number.NaN : Date.parse(added)
  return {
    fresh: Number.isFinite(at) && input.now - at < NEW_TAG_DAYS * DAY,
    retires: input.retirements?.[input.modelID],
  }
}

/** Keeps the variant when the model offers it; otherwise no variant (the model's default). */
export function keepVariant(variant: string | undefined, model: PickerModel | undefined) {
  if (!variant || !model) return undefined
  return model.variants.includes(variant) ? variant : undefined
}

export type Unusable =
  | { readonly reason: "auth" }
  /** 02 §8.7 (CS): a Claude account on Claude Code's own login whose token expired, waiting for Claude Code. */
  | { readonly reason: "shared" }
  | { readonly reason: "exhausted"; readonly resetAt?: number }
  | { readonly reason: "plugin" }
  | { readonly reason: "misconfigured" }

/**
 * Why an account cannot run now; dimmed rows stay selectable and applying leads to the fix (03 §5.2 "흐린 계정도
 * 선택할 수는 있다"). An exhausted account names the soonest reset of its exhausted windows that limit `model` (a model
 * weekly bucket only for its own family, `LimitModel.limits`; never Claude's extra usage, `LimitRank.extra`). Only the
 * account's own state says exhausted: a model week's exhaustion is not the account's (own-accounts announces none).
 */
export function unusable(
  account: Pick<Account.View, "status" | "kind" | "plugin" | "claude">,
  windows?: readonly Limit.Window[],
  model?: string,
): Unusable | undefined {
  if (account.kind === "claude-sub" && account.claude?.stale) return { reason: "shared" }
  if (account.status === "needs_reauth" || account.status === "auth_failed") return { reason: "auth" }
  if (account.kind === "claude-sub" && account.plugin && !account.plugin.installed) return { reason: "plugin" }
  if (account.status === "misconfigured") return { reason: "misconfigured" }
  if (account.status === "exhausted") {
    const exhausted = (windows ?? []).filter(
      (window) =>
        window.status === "exhausted" &&
        window.resetAt &&
        LimitModel.limits(window.id, model) &&
        !LimitRank.extra(window.id),
    )
    const resetAt = exhausted.reduce<number | undefined>(
      (soonest, window) => (soonest === undefined || window.resetAt! < soonest ? window.resetAt : soonest),
      undefined,
    )
    return { reason: "exhausted", resetAt }
  }
  return undefined
}

/**
 * 팀 거르기 (06 §10.1, 07 §5.5), the client copy of own-accounts' rule (`switching/targets.ts` `outsideTeam`): a
 * subscription account of a company the team already has a subscription account of, other than that subscription.
 * The same-login `codex`/`siwc` sibling of a team account stays in. An owner conversation and an area main never list
 * it; on the team main choosing it is 팀 계정 바꾸기.
 */
export function outsideTeam(account: Preset.Member, team: Pick<Preset.Team, "accounts">, lookup: Preset.Lookup) {
  if (account.billing !== "subscription") return false
  const company = Preset.company(account)
  const ofCompany = team.accounts.flatMap((accountID) => {
    const known = lookup(accountID)
    return known && Preset.company(known) === company ? [known] : []
  })
  return ofCompany.length > 0 && !ofCompany.some((known) => Preset.oneSubscription(known, account))
}

/**
 * The accounts a team session's picker lists (06 §10.1): every account outside {@link outsideTeam}, and the companies
 * whose other subscriptions were left out, for the greyed `다른 <회사> 계정은 팀에 넣을 수 없어 목록에 없습니다` line.
 * Turned-off and removed accounts are never listed, so they name no company.
 */
export function teamAccounts<A extends Account.View>(
  accounts: readonly A[],
  team: Pick<Preset.Team, "accounts">,
  lookup: Preset.Lookup,
) {
  const out = new Set(accounts.filter((account) => outsideTeam(account, team, lookup)))
  return {
    shown: accounts.filter((account) => !out.has(account)),
    hidden: [...new Set([...out].filter((account) => !HIDDEN.has(account.status)).map(Preset.company))],
  }
}

/**
 * `추천` on a session without turns (03 §5.1, LV 2026-10-24): among the ready accounts of one kind, the one whose lead
 * window has the most room left, in the one ranking (`LimitRank`) for the model it would run (`model(account)`, a
 * switcher row's {@link rowModel}). An account whose lead is used up, a model week of that model included, is never
 * recommended. Returns nothing when fewer than two accounts can be compared.
 */
export function recommendedAccount(
  accounts: readonly Account.View[],
  quota: Readonly<Record<string, readonly Limit.Window[] | undefined>>,
  now: number,
  model: (account: Account.View) => string | undefined,
) {
  const scored = accounts.flatMap((account) => {
    const lead = LimitRank.ranked(quota[account.id] ?? [], now, model(account))[0]
    const facts = lead ? LimitRank.facts(lead, now) : undefined
    if (account.status !== "ready" || !facts) return []
    if (facts.status === "exhausted") return [{ id: account.id, used: Number.POSITIVE_INFINITY }]
    return facts.percent === undefined ? [] : [{ id: account.id, used: facts.percent }]
  })
  if (scored.length < 2) return undefined
  const best = scored.reduce((best, item) => (item.used < best.used ? item : best))
  return best.used === Number.POSITIVE_INFINITY ? undefined : best.id
}

/**
 * Every `추천` of a list (03 §5.1, LV 2026-10-25): {@link recommendedAccount} of each provider group
 * ({@link groupAccounts}) with several accounts, each account ranked with `model(account)`, the model it would run
 * (the switcher row's and the import dialog's {@link rowModel} of the picked model). Neither the cursor nor the search
 * moves a badge, and none shows once the conversation has turns (`turns`).
 */
export function recommendedAccounts(
  accounts: readonly Account.View[],
  quota: Readonly<Record<string, readonly Limit.Window[] | undefined>>,
  now: number,
  model: (account: Account.View) => string | undefined,
  turns = false,
): ReadonlySet<string> {
  if (turns) return new Set()
  return new Set(
    groupAccounts(accounts).flatMap((group) => recommendedAccount(group.accounts, quota, now, model) ?? []),
  )
}
