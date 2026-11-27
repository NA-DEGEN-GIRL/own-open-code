// The preset editor's 모델 묶음 checklist (07 §8.1 ①, `모델 묶음에서 알아서`): what `presets.suggest` offers
// (`pool.candidates`) in four sections. `메인 계정에서` runs on whichever account of the group is the main (a metered
// group's rows say `메인 계정 · 종량제 · 돈이 듭니다`); each other company's subscription has one `[계정 ▾]` (R4: one
// account per company, switching moves the checks to the same models); `로컬 LLM`; and behind `API 키로 돌리기 · 돈이
// 듭니다` the paid accounts with their monthly budget and this month's spend (the target picker's `PaidAccount`: a row is
// checked only once a budget is set or declined, PG11). Rows show the card facts in Korean, a price band from the raw
// ranking prices (D8), `새` and a dimmed retirement date (never a notice, U3). `추천 묶음` fills the service's
// recommended pool at the moment of the click; the last line previews the default rule (`Preset.poolDefaults` over the
// session's or the candidates' facts). Same-company subscriptions are never listed, only named in the greyed line.
// PF 2026-11-03: `[계정 ▾]` lists every Claude account (the subscription's and Claude Agent's, each named with its
// route when both are there); local models, an OpenAI-compatible account's on this PC or the LAN included, have their
// own free `로컬 모델` group; every row can be hidden (`목록에서 숨기기`, presets/hidden.ts), and `숨긴 모델 n개`
// shows the hidden ones again with `다시 보이기`. A checked row stays in view, marked hidden.
import type { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { kindLabel } from "@/accounts/model"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { tokens } from "@/limits/format"
import { Tag } from "@/limits/kit"
import { minuteNow } from "@/shell/clock"
import { modelMarks } from "@/switcher/picker"
import {
  defaultItems,
  groupAccounts,
  hiddenCompany,
  monthDay,
  poolAccountOf,
  poolBand,
  poolFacts,
  poolSections,
  samePoolTarget,
  withoutPoolEntry,
  withPoolAccount,
  withPoolEntry,
  withRecommended,
  type Band,
  type PoolAccount,
} from "./model"
import { groupOfAccount, hiddenOf } from "./hidden"
import { usePresetFixesText } from "./pf-strings"
import { usePresetsText, type PresetsKey } from "./strings"
import { createSpend, PaidAccount, useTargetText } from "./target-picker"

type Text = ReturnType<typeof usePresetsText>

/** The badge of what a pool model runs on (07 §3.3 `runs`); a paid account says metered or prepaid. */
export function runsBadge(runs: Preset.PoolRuns | undefined, billing?: Account.Charge): PresetsKey | undefined {
  if (runs === "main") return "own.preset.badge.mainAccount"
  if (runs === "main-paid") return "own.preset.pool.mainPaid"
  if (runs === "subscription") return "own.preset.badge.subscription"
  if (runs === "local") return "own.preset.badge.local"
  if (runs === "paid") return billing === "prepaid" ? "own.preset.badge.prepaid" : "own.preset.badge.metered"
  return undefined
}

/**
 * A pool card's facts in Korean (07 §3.3 카드, as frozen): the window (a local model's running window once verified,
 * else `창 확인 안 됨`), the price band, reasoning levels and images, and Codex's description.
 */
export function cardFacts(
  text: Text,
  card: Preset.PoolCard | undefined,
  local: boolean,
  band?: Band,
): ReadonlyArray<string> {
  const window = card?.window
  const span = local
    ? card?.windowVerified === true && window !== undefined
      ? [text("own.preset.pool.runningWindow", { n: tokens(window) })]
      : [text("own.preset.picker.windowUnverified")]
    : window === undefined
      ? []
      : [text("own.preset.picker.window", { n: tokens(window) })]
  const summary = card?.summary === undefined ? "" : Preset.oneLine(card.summary, 120)
  return [
    ...span,
    ...(band ? [text(`own.preset.picker.price.${band}`)] : []),
    ...(card?.reasoning ? [text("own.preset.pool.reasoning")] : []),
    ...(card?.image ? [text("own.preset.picker.image")] : []),
    ...(summary ? [summary] : []),
  ]
}

/**
 * `모델을 고르지 않으면: 탐색·빠른 일 → GPT-6 Luna · 리뷰·어려운 일 → Claude Opus 5.5 · 일반 → 메인` (07 §8.1, 자세히):
 * the default rule's picks ({@link defaultItems}) by the entries' names.
 */
export function defaultLine(
  text: Text,
  role: (role: Preset.Role) => string,
  items: ReturnType<typeof defaultItems>,
  name: (key: string) => string,
) {
  return text("own.preset.pool.defaults", {
    list: items
      .map((item) =>
        text("own.preset.pool.defaultItem", {
          roles: item.roles.map(role).join("·"),
          model: item.key === undefined ? text("own.preset.pool.main") : name(item.key),
        }),
      )
      .join(" · "),
  })
}

/** An entry's name on screen: its frozen card's model name, else the model id. */
export function entryName(entry: Pick<Preset.PoolEntry, "card" | "model"> | undefined, key: string) {
  return entry?.card?.name ?? entry?.model ?? key
}

export function PoolList(props: {
  readonly group: Preset.Group
  readonly draft: Preset.Draft
  readonly update: (draft: Preset.Draft) => void
  /** `presets.suggest` `pool`; `undefined` while it loads (the pool's entries show checked meanwhile). */
  readonly offer: Preset.PoolOffer | undefined
  /** The default-rule preview's main: the session's, else the group's new-session default. */
  readonly main: Preset.Main | undefined
  /** The session's pool facts (`Resolution.pool`), read before the candidates'. */
  readonly facts?: Preset.PoolResolution
  /** `저장` was tried: an empty pool says so. */
  readonly tried: boolean
}) {
  const data = useData()
  const i18n = useI18n()
  const text = usePresetsText()
  const fixes = usePresetFixesText()
  const names = useTargetText()
  const own = data.local().own
  const spend = createSpend(own)
  const hidden = hiddenOf(own)
  const [paidOpen, setPaidOpen] = createSignal(false)
  const [hiddenOpen, setHiddenOpen] = createSignal(false)
  /** Paid accounts whose budget was set or declined (`상한 없음`) here. */
  const [decided, setDecided] = createSignal<ReadonlyArray<string>>([])
  /** The account picked per company (`[계정 ▾]`) while the pool pins none of it. */
  const [picked, setPicked] = createStore<Record<string, string>>({})
  const accounts = () =>
    own.state.accountOrder.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : []))
  const candidates = () => props.offer?.candidates ?? []
  const sections = createMemo(() => poolSections(candidates()))
  const pool = () => props.draft.workers.pool ?? []
  const full = () => pool().length >= Preset.POOL_MAX
  const used = (company: string) => {
    const section = sections().companies.find((item) => item.company === company)
    return section && poolAccountOf(props.draft, section.accounts, picked[company])
  }
  const missing = () => pool().filter((entry) => !candidates().some((candidate) => samePoolTarget(candidate, entry)))
  /** The provider group a candidate is hidden under (presets/hidden.ts). */
  const groupOf = (candidate: Preset.PoolCandidate) =>
    candidate.account === undefined ? props.group : groupOfAccount(candidate.account, own.state.accounts)
  const isHidden = (candidate: Preset.PoolCandidate) => hidden.is(groupOf(candidate), candidate.model)
  /** A hidden row is listed only while it is checked or `숨긴 모델 n개` is open. */
  const listed = (rows: ReadonlyArray<Preset.PoolCandidate>) =>
    hiddenOpen() ? rows : rows.filter((row) => !isHidden(row) || pool().some((entry) => samePoolTarget(entry, row)))
  const hiddenCount = () => candidates().filter(isHidden).length
  /** The main account's own models, and its local ones (an OpenAI-compatible server on this PC or the LAN). */
  const mainRows = () => listed(sections().main.filter((candidate) => candidate.runs !== "local"))
  const mainLocal = () => listed(sections().main.filter((candidate) => candidate.runs === "local"))
  /** `[계정 ▾]`'s name of an account: its label, with its route when the company lists more than one (Claude). */
  const accountName = (account: string, section: ReadonlyArray<PoolAccount>) => {
    const view = own.state.accounts[account]
    const label = view?.label ?? account
    const kinds = new Set(section.map((item) => own.state.accounts[item.account]?.kind))
    if (!view || kinds.size < 2) return label
    return fixes("own.pf.accountKind", { account: label, kind: kindLabel(i18n, view.kind) })
  }
  const preview = createMemo(() => {
    const main = props.main
    if (!main || pool().length === 0) return undefined
    const facts = poolFacts({ pool: pool(), candidates: candidates(), session: props.facts, main })
    return defaultItems(Preset.poolGuidance(facts.entries, facts.main).defaults)
  })
  const keyName = (key: string) =>
    entryName(
      pool().find((item) => item.key === key),
      key,
    )
  /** `새` and a retirement date (07 §4.3): the account's template marks (the group's for the main account's models). */
  const marksOf = (candidate: Preset.PoolCandidate) => {
    const owner = candidate.account === undefined ? undefined : own.state.accounts[candidate.account]
    return modelMarks({
      marks:
        candidate.account === undefined
          ? groupAccounts(props.group, accounts()).flatMap((account) => account.models ?? [])
          : owner?.models,
      retirements: {
        ...(owner ? own.state.presetGroups[owner.kind]?.retirements : undefined),
        ...own.state.presetGroups[props.group]?.retirements,
      },
      modelID: candidate.model,
      now: minuteNow(),
    })
  }
  const openPaid = () => {
    setPaidOpen(true)
    spend.load(sections().paid.flatMap((section) => own.state.accounts[section.account] ?? []))
  }
  const choose = (company: string, section: ReadonlyArray<PoolAccount>, account: PoolAccount["account"]) => {
    setPicked(company, account)
    props.update(withPoolAccount(props.draft, section, account))
  }

  return (
    <div class="own-pl" data-testid="preset-pool">
      <div class="own-pl-bar">
        <button
          type="button"
          class="own-pe-chip"
          disabled={!props.offer?.recommended.length}
          data-testid="preset-pool-recommended"
          onClick={() => props.offer && props.update(withRecommended(props.draft, props.offer, used))}
        >
          {text("own.preset.pool.recommended")}
        </button>
        <Show when={full()}>
          <span class="own-pe-hint" data-testid="preset-pool-full">
            {text("own.preset.pool.full", { n: Preset.POOL_MAX })}
          </span>
        </Show>
      </div>

      <Show when={props.offer?.candidates.length === 0}>
        <p class="own-tp-hidden">{text("own.preset.pool.none")}</p>
      </Show>

      <Show when={missing().length}>
        <Show when={props.offer}>
          <p class="own-tp-head">{text("own.preset.pool.missing")}</p>
        </Show>
        <For each={missing()}>
          {(entry) => (
            <label class="own-pl-row" data-testid="preset-pool-row" data-key={entry.key} data-missing="">
              <input
                type="checkbox"
                checked
                data-testid="preset-pool-check"
                onChange={() => props.update(withoutPoolEntry(props.draft, entry.key))}
              />
              <span class="own-pl-name">{entryName(entry, entry.key)}</span>
              <span class="own-tp-facts">{entry.key}</span>
            </label>
          )}
        </For>
      </Show>

      <Show when={mainRows().length}>
        <p class="own-tp-head" data-testid="preset-pool-main">
          {text("own.preset.pool.mainAccount")}{" "}
          <span class="font-normal">
            ({text("own.preset.pool.mainAccountHint", { group: names.group(props.group) })})
          </span>
        </p>
        <For each={mainRows()}>{(candidate) => <Row candidate={candidate} />}</For>
      </Show>

      <For each={sections().companies}>
        {(section) => {
          const account = () => used(section.company)
          const rows = () => section.accounts.find((item) => item.account === account())?.rows ?? []
          return (
            <>
              <div class="own-tp-account" data-testid="preset-pool-company" data-company={section.company}>
                <span>{text("own.preset.pool.company", { company: names.company(section.company) })}</span>
                <select
                  class="own-input own-pl-account"
                  aria-label={text("own.preset.pool.account", { company: names.company(section.company) })}
                  data-testid="preset-pool-account"
                  onChange={(event) => {
                    const next = section.accounts.find((item) => item.account === event.currentTarget.value)
                    if (next) choose(section.company, section.accounts, next.account)
                  }}
                >
                  <For each={section.accounts}>
                    {(item) => (
                      <option value={item.account} selected={item.account === account()}>
                        {accountName(item.account, section.accounts)}
                      </option>
                    )}
                  </For>
                </select>
              </div>
              <For each={listed(rows())}>{(candidate) => <Row candidate={candidate} />}</For>
            </>
          )
        }}
      </For>

      <Show when={sections().local.length || mainLocal().length}>
        <p class="own-tp-head" data-testid="preset-pool-local">
          {fixes("own.pf.local")} <span class="font-normal">({fixes("own.pf.localHint")})</span>
        </p>
        <Show when={mainLocal().length}>
          <p class="own-tp-account">{text("own.preset.pool.mainAccount")}</p>
          <For each={mainLocal()}>{(candidate) => <Row candidate={candidate} />}</For>
        </Show>
        <For each={sections().local}>
          {(section) => (
            <>
              <p class="own-tp-account">
                {Preset.isLocal(section.account)
                  ? names.group(section.account)
                  : (own.state.accounts[section.account]?.label ?? section.account)}
              </p>
              <For each={listed(section.rows)}>{(candidate) => <Row candidate={candidate} />}</For>
            </>
          )}
        </For>
      </Show>

      <button
        type="button"
        class="own-tp-paid"
        aria-expanded={paidOpen()}
        data-testid="preset-pool-paid"
        onClick={() => (paidOpen() ? setPaidOpen(false) : openPaid())}
      >
        <span aria-hidden="true">{paidOpen() ? "▾" : "▸"}</span>
        {text("own.preset.paidRow")}
      </button>
      <Show when={paidOpen()}>
        <Show when={sections().paid.length} fallback={<p class="own-tp-hidden">{text("own.preset.picker.noPaid")}</p>}>
          <For each={sections().paid}>
            {(section) => (
              <Show when={own.state.accounts[section.account]}>
                {(account) => (
                  <PaidAccount
                    account={account()}
                    spent={spend.of(account().id)}
                    decided={decided().includes(account().id)}
                    onDecided={() => setDecided((list) => [...list, account().id])}
                  >
                    <For each={listed(section.rows)}>
                      {(candidate) => (
                        <Row
                          candidate={candidate}
                          locked={
                            !account().budget && own.rpc.allowed("accounts.update") && !decided().includes(account().id)
                          }
                        />
                      )}
                    </For>
                  </PaidAccount>
                )}
              </Show>
            )}
          </For>
        </Show>
      </Show>

      <Show when={hiddenCount()}>
        <button
          type="button"
          class="own-tp-paid"
          aria-expanded={hiddenOpen()}
          data-testid="preset-pool-hidden-models"
          onClick={() => setHiddenOpen((open) => !open)}
        >
          <span aria-hidden="true">{hiddenOpen() ? "▾" : "▸"}</span>
          {fixes("own.pf.hiddenCount", { n: hiddenCount() })}
        </button>
      </Show>

      <Show when={hiddenCompany(props.group, accounts())}>
        {(company) => (
          <p class="own-tp-hidden" data-testid="preset-pool-hidden">
            {text("own.preset.pool.sameCompanyHidden", { company: names.company(company()) })}
          </p>
        )}
      </Show>

      <Show when={props.tried && pool().length === 0}>
        <span class="text-[12px] text-own-danger" role="alert" data-testid="preset-pool-empty">
          {text("own.preset.pool.empty")}
        </span>
      </Show>

      <Show when={preview()}>
        {(items) => (
          <p class="own-pe-sub m-0" data-testid="preset-pool-defaults">
            {defaultLine(text, names.role, items(), keyName)}
          </p>
        )}
      </Show>
    </div>
  )

  /** One model: its checkbox, card facts and marks; `locked` = a paid account's budget not decided yet. */
  function Row(rowProps: { readonly candidate: Preset.PoolCandidate; readonly locked?: boolean }) {
    const candidate = rowProps.candidate
    const entry = () => pool().find((item) => samePoolTarget(item, candidate))
    const billing = () => (candidate.account === undefined ? undefined : own.state.accounts[candidate.account]?.billing)
    const badge = () => runsBadge(candidate.runs, billing())
    const marks = () => marksOf(candidate)
    const facts = () =>
      cardFacts(text, candidate.card, candidate.runs === "local", poolBand(candidate.price, candidates()))
    const group = groupOf(candidate)
    const toggle = (event: MouseEvent) => {
      // A button inside the row's label must not check the row.
      event.preventDefault()
      if (group === undefined) return
      const change = isHidden(candidate) ? hidden.show(group, candidate.model) : hidden.hide(group, candidate.model)
      void change.catch(() => undefined)
    }
    return (
      <label
        class="own-pl-row"
        data-testid="preset-pool-row"
        data-key={candidate.key}
        data-runs={candidate.runs}
        data-checked={entry() ? "" : undefined}
        data-hidden={isHidden(candidate) ? "" : undefined}
      >
        <input
          type="checkbox"
          checked={entry() !== undefined}
          disabled={rowProps.locked || (entry() === undefined && full())}
          data-testid="preset-pool-check"
          onChange={(event) => {
            const current = entry()
            if (event.currentTarget.checked) return props.update(withPoolEntry(props.draft, candidate))
            if (current) props.update(withoutPoolEntry(props.draft, current.key))
          }}
        />
        <span class="own-pl-name">{candidate.card?.name ?? candidate.model}</span>
        <Show when={badge()}>
          {(key) => (
            <Tag
              tone={candidate.runs === "paid" || candidate.runs === "main-paid" ? "warn" : "soft"}
              testid="preset-pool-badge"
            >
              {text(key())}
            </Tag>
          )}
        </Show>
        <Show when={marks().fresh}>
          <Tag tone="accent" testid="preset-target-new">
            {text("own.preset.newTag")}
          </Tag>
        </Show>
        <Show when={isHidden(candidate)}>
          <Tag tone="soft" testid="preset-pool-hidden-tag">
            {fixes("own.pf.hiddenTag")}
          </Tag>
        </Show>
        <Show when={group !== undefined && hidden.editable()}>
          <button type="button" class="own-link text-[12px]" data-testid="preset-pool-hide" onClick={toggle}>
            {fixes(isHidden(candidate) ? "own.pf.unhide" : "own.pf.hide")}
          </button>
        </Show>
        <span class="own-tp-facts own-pl-facts">
          {facts().join(" · ")}
          <Show when={candidate.runs === "paid" || candidate.runs === "main-paid"}>
            {facts().length ? " · " : ""}
            {text("own.preset.pool.paidCard")}
          </Show>
          <Show when={marks().retires}>
            {(at) => (
              <span class="text-own-faint" data-testid="preset-target-retirement">
                {" · "}
                {text("own.preset.retirement", { date: monthDay(at()) })}
              </span>
            )}
          </Show>
        </span>
      </label>
    )
  }
}
