// Target picker of the preset editor (07 §7.1 `바꾸기`, §7.3, §3.4). Rows: `메인과 같게` (never for `다른 모델 하나로`,
// which says to pick `메인과 같은 모델로` instead, UC 2026-10-18), `메인 계정의 더 가벼운 모델`, another company's
// subscription, local LLMs, each with its card facts (badge, window, price band, effort levels,
// tools and images, release date; `창 확인 안 됨` for an unverified local model). Below a separator, the
// `API 키로 돌리기 · 돈이 듭니다` row: metered and prepaid accounts appear only after it is clicked (PG11), each with its
// monthly budget and this month's spend, and a budget typed in place (`accounts.update{budget}`) before its models can
// be picked. Same-company subscriptions are never listed (PG2, R4), only named in the greyed last line. T2 (07 §4.3,
// §7.3): a model the account's pinned template gained lately carries `새`, and a known Codex retirement date shows
// dimmed in its facts; neither is a notice, and nothing is picked or changed by itself (U3). The model pool's checklist
// (pool-list.tsx) shows its paid accounts with `PaidAccount` too.
import type { Account, Ledger } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { createMemo, createSignal, For, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { errorMessage } from "@/accounts/errors"
import { useData, type OwnStore } from "@/data"
import { useI18n } from "@/i18n"
import { tokens, usd } from "@/limits/format"
import { Dialog, Tag, TextField, createStatus, StatusLine } from "@/limits/kit"
import { minuteNow } from "@/shell/clock"
import { catalog, variantName } from "@/switcher/labels"
import { modelMarks } from "@/switcher/picker"
import {
  budgetSpent,
  clashes,
  monthDay,
  monthStart,
  parseBudget,
  pickerSections,
  sameTarget,
  type Badge,
  type LocalCheck,
  type ModelRow,
} from "./model"
import { usePresetsText, type PresetsKey } from "./strings"

const BADGE: Record<Badge, PresetsKey> = {
  subscription: "own.preset.badge.subscription",
  metered: "own.preset.badge.metered",
  prepaid: "own.preset.badge.prepaid",
  local: "own.preset.badge.local",
  mainAccount: "own.preset.badge.mainAccount",
}

const ROLE: Record<Preset.Role, PresetsKey> = {
  explore: "own.preset.role.explore",
  general: "own.preset.role.general",
  "own-review": "own.preset.role.review",
  "own-quick": "own.preset.role.quick",
  "own-deep": "own.preset.role.deep",
}

const LOCAL_NAME: Readonly<Record<string, PresetsKey>> = {
  ollama: "own.preset.groupName.ollama",
  lmstudio: "own.preset.groupName.lmstudio",
}

const COMPANY: Readonly<Record<string, PresetsKey>> = {
  openai: "own.preset.company.openai",
  anthropic: "own.preset.company.anthropic",
}

/** Names the presets screens share: groups, roles, targets and their badges. Reactive in JSX. */
export function useTargetText() {
  const data = useData()
  const i18n = useI18n()
  const text = usePresetsText()
  const own = () => data.local().own
  const localName = (providerID: string) => {
    const key = LOCAL_NAME[providerID]
    return key ? text(key) : providerID
  }
  const modelName = (providerID: string | undefined, modelID: string) =>
    catalog(data.local()).find((model) => model.providerID === providerID && model.id === modelID)?.name ?? modelID
  const providerOf = (account: string) =>
    Preset.isLocal(account) ? account.slice("local:".length) : own().state.accounts[account]?.providerID
  return {
    group(group: Preset.Group) {
      if (Preset.isLocal(group)) return localName(group.slice("local:".length))
      return text(`own.preset.groupName.${group}`)
    },
    /** A model's display name from the catalog, its id until the catalog is loaded. */
    model: modelName,
    role: (role: Preset.Role) => text(ROLE[role]),
    company: (company: string) => {
      const key = COMPANY[company]
      return key ? text(key) : company
    },
    /** `메인과 같게`, `메인 계정의 더 가벼운 모델`, or `<account> · <model>` of a pinned target. */
    target(target: Preset.Target) {
      if ("rel" in target) return text(target.rel === "main" ? "own.preset.target.main" : "own.preset.target.lighter")
      const account = target.pin.account
      const label = Preset.isLocal(account)
        ? localName(account.slice("local:".length))
        : own().state.accounts[account]?.label
      return `${label ?? account} · ${modelName(providerOf(account), target.pin.model)}`
    },
    badge(target: Preset.Target): Badge {
      if ("rel" in target) return "mainAccount"
      if (Preset.isLocal(target.pin.account)) return "local"
      const billing = own().state.accounts[target.pin.account]?.billing
      return billing === "prepaid" ? "prepaid" : billing === "metered" ? "metered" : "subscription"
    },
    badgeText: (badge: Badge) => text(BADGE[badge]),
    /** `GPT-6 Luna · high` for a resolved Ref. */
    ref(ref: Pick<Preset.Resolution["main"], "providerID" | "id" | "variant">) {
      return `${modelName(ref.providerID, ref.id)} · ${variantName(i18n, ref.variant)}`
    },
  }
}

/**
 * This month's spend of paid accounts (07 §3.4): an account with a budget reads its `api.budget_month` window; one
 * without asks `accounts.usage` once while the screen is open.
 */
export function createSpend(own: OwnStore) {
  const [loaded, setLoaded] = createStore<Record<string, number>>({})
  const asked = new Set<string>()
  return {
    of: (accountID: string) => budgetSpent(own.state.quota[accountID]) ?? loaded[accountID],
    load(accounts: ReadonlyArray<Account.View>) {
      const now = Date.now()
      accounts
        .filter((account) => !asked.has(account.id) && budgetSpent(own.state.quota[account.id]) === undefined)
        .forEach((account) => {
          asked.add(account.id)
          void own.rpc
            .call("accounts.usage", { accountID: account.id, from: monthStart(now), to: now, groupBy: "day" })
            .then((output) => setLoaded(account.id, sumUSD(output.rows)))
            .catch(() => asked.delete(account.id))
        })
    },
  }
}

function sumUSD(rows: ReadonlyArray<Pick<Ledger.UsageRow, "cost">>) {
  return rows.reduce(
    (sum, row) => sum + row.cost.filter((item) => item.unit === "USD").reduce((part, item) => part + item.amount, 0),
    0,
  )
}

export interface TargetPickerProps {
  readonly group: Preset.Group
  readonly place: Preset.Place
  readonly draft: Preset.Draft
  /** The main the lighter row describes (`지금 메인 X → Y`). */
  readonly main: Preset.Main | undefined
  readonly lighter: Readonly<Record<string, Preset.Lighter>>
  readonly local: LocalCheck
  readonly onPick: (target: Preset.Target) => void
  readonly onClose: () => void
}

export function TargetPicker(props: TargetPickerProps) {
  const data = useData()
  const text = usePresetsText()
  const names = useTargetText()
  const runtime = data.local()
  const own = runtime.own
  const spend = createSpend(own)
  const [paidOpen, setPaidOpen] = createSignal(false)
  /** Paid accounts whose budget was set or declined (`상한 없음`) in this picker. */
  const [decided, setDecided] = createSignal<ReadonlyArray<string>>([])
  const accounts = () =>
    own.state.accountOrder.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : []))
  const sections = createMemo(() =>
    pickerSections({ group: props.group, accounts: accounts(), models: catalog(runtime), local: props.local }),
  )
  const lookup: Preset.Lookup = (id) => own.state.accounts[id]
  const current = () =>
    props.place === "single"
      ? props.draft.workers.single
      : (props.draft.workers.roles[props.place]?.targets[0] ?? { rel: "main" as const })
  const picked = (target: Preset.Target) => {
    const value = current()
    return value !== undefined && sameTarget(value, target)
  }
  const title = () =>
    props.place === "single"
      ? text("own.preset.picker.titleSingle")
      : text("own.preset.picker.titleRole", { role: names.role(props.place) })
  const lighterLine = () => {
    const main = props.main
    if (Preset.isLocal(props.group)) return text("own.preset.starter.noLighter")
    if (!main) return undefined
    const pair = props.lighter[main.ref.id]
    if (!pair) return text("own.preset.editor.lighterUnknown")
    if (pair.missing) return text("own.preset.editor.lighterMissing")
    if (pair.source === "none" || pair.model === main.ref.id) return text("own.preset.lighter.none")
    return text("own.preset.editor.nowMain", {
      main: names.model(main.ref.providerID, main.ref.id),
      target: names.model(main.ref.providerID, pair.model),
    })
  }
  const openPaid = () => {
    setPaidOpen(true)
    spend.load(sections().paid.map((section) => section.account))
  }
  const pick = (target: Preset.Target) => {
    props.onPick(target)
    props.onClose()
  }
  /** `새` and a retirement date of a pinned model (07 §4.3): its account's template marks, the groups' known dates. */
  const marksOf = (account: Account.View, row: ModelRow) =>
    "pin" in row.target
      ? modelMarks({
          marks: account.models,
          retirements: {
            ...own.state.presetGroups[account.kind]?.retirements,
            ...own.state.presetGroups[props.group]?.retirements,
          },
          modelID: row.target.pin.model,
          now: minuteNow(),
        })
      : undefined

  return (
    <Dialog open title={title()} onClose={props.onClose} dismissable testid="preset-target-picker">
      <div class="own-tp">
        {/* UC 2026-10-18: `다른 모델 하나로` never points at the main; that choice is `메인과 같은 모델로` in ①. */}
        <Show
          when={props.place !== "single"}
          fallback={
            <p class="own-tp-hidden" data-testid="preset-target-single-note">
              {text("own.preset.picker.singleNote")}
            </p>
          }
        >
          <p class="own-tp-head">{text("own.preset.picker.relative")}</p>
          <Relative
            label={text("own.preset.target.main")}
            detail={text("own.preset.picker.mainSame")}
            badge={text("own.preset.badge.mainAccount")}
            pressed={picked({ rel: "main" })}
            onPick={() => pick({ rel: "main" })}
            testid="preset-target-main"
          />
        </Show>
        <Show when={props.place === "single" && !Preset.isLocal(props.group)}>
          <p class="own-tp-head">{text("own.preset.picker.relative")}</p>
        </Show>
        <Show when={!Preset.isLocal(props.group)}>
          <Relative
            label={text("own.preset.target.lighter")}
            detail={lighterLine()}
            badge={text("own.preset.badge.mainAccount")}
            pressed={picked({ rel: "lighter" })}
            onPick={() => pick({ rel: "lighter" })}
            testid="preset-target-lighter"
          />
        </Show>

        <Show when={sections().subscriptions.some((section) => section.rows.length)}>
          <p class="own-tp-head">{text("own.preset.picker.otherSubscription")}</p>
          <For each={sections().subscriptions.filter((section) => section.rows.length)}>
            {(section) => (
              <>
                <p class="own-tp-account" data-account-id={section.account.id}>
                  {section.account.label}
                </p>
                <For each={section.rows}>
                  {(row) => (
                    <Row
                      row={row}
                      pressed={picked(row.target)}
                      taken={clashes(props.draft, props.place, row.target, lookup)}
                      company={names.company(Preset.company(section.account))}
                      marks={marksOf(section.account, row)}
                      onPick={() => pick(row.target)}
                    />
                  )}
                </For>
              </>
            )}
          </For>
        </Show>

        <Show when={sections().local.length || sections().localAccounts.length}>
          <p class="own-tp-head">{text("own.preset.picker.local")}</p>
          <For each={sections().localAccounts.filter((section) => section.rows.length)}>
            {(section) => (
              <>
                <p class="own-tp-account" data-account-id={section.account.id}>
                  {section.account.label}
                </p>
                <For each={section.rows}>
                  {(row) => <Row row={row} pressed={picked(row.target)} onPick={() => pick(row.target)} />}
                </For>
              </>
            )}
          </For>
          <For each={sections().local}>
            {(item) => (
              <>
                <p class="own-tp-account">{names.group(`local:${item.providerID}`)}</p>
                <For each={item.rows}>
                  {(row) => <Row row={row} pressed={picked(row.target)} onPick={() => pick(row.target)} />}
                </For>
              </>
            )}
          </For>
        </Show>

        <button
          type="button"
          class="own-tp-paid"
          aria-expanded={paidOpen()}
          data-testid="preset-target-paid"
          onClick={() => (paidOpen() ? setPaidOpen(false) : openPaid())}
        >
          <span aria-hidden="true">{paidOpen() ? "▾" : "▸"}</span>
          {text("own.preset.paidRow")}
        </button>
        <Show when={paidOpen()}>
          <Show
            when={sections().paid.length}
            fallback={<p class="own-tp-hidden">{text("own.preset.picker.noPaid")}</p>}
          >
            <For each={sections().paid}>
              {(section) => (
                <PaidAccount
                  account={section.account}
                  spent={spend.of(section.account.id)}
                  decided={decided().includes(section.account.id)}
                  onDecided={() => setDecided((list) => [...list, section.account.id])}
                >
                  <For each={section.rows}>
                    {(row) => (
                      <Row
                        row={row}
                        pressed={picked(row.target)}
                        locked={
                          !section.account.budget &&
                          own.rpc.allowed("accounts.update") &&
                          !decided().includes(section.account.id)
                        }
                        marks={marksOf(section.account, row)}
                        onPick={() => pick(row.target)}
                      />
                    )}
                  </For>
                </PaidAccount>
              )}
            </For>
          </Show>
        </Show>

        <Show when={sections().hidden}>
          {(company) => (
            <p class="own-tp-hidden" data-testid="preset-target-hidden">
              {text("own.preset.sameCompanyHidden", { company: names.company(company()) })}
            </p>
          )}
        </Show>
      </div>
    </Dialog>
  )
}

function Relative(props: {
  readonly label: string
  readonly detail: string | undefined
  readonly badge: string
  readonly pressed: boolean
  readonly onPick: () => void
  readonly testid: string
}) {
  return (
    <button
      type="button"
      class="own-tp-row"
      aria-pressed={props.pressed}
      data-testid={props.testid}
      onClick={() => props.onPick()}
    >
      <span class="own-tp-title">
        <b>{props.label}</b>
        <Tag tone="soft">{props.badge}</Tag>
      </span>
      <Show when={props.detail}>
        <span class="own-tp-facts">{props.detail}</span>
      </Show>
    </button>
  )
}

/**
 * One model with its card facts (07 §3.4); `taken` = R4 with another place, `locked` = budget not decided yet, `marks`
 * = the `새` tag and a dim retirement date (07 §4.3).
 */
function Row(props: {
  readonly row: ModelRow
  readonly pressed: boolean
  readonly taken?: boolean
  readonly company?: string
  readonly locked?: boolean
  readonly marks?: ReturnType<typeof modelMarks>
  readonly onPick: () => void
}) {
  const text = usePresetsText()
  const facts = () => {
    const row = props.row
    const window =
      row.badge === "local" && !row.verified
        ? text("own.preset.picker.windowUnverified")
        : row.window
          ? text("own.preset.picker.window", { n: tokens(row.window) })
          : undefined
    return [
      window,
      row.band && text(`own.preset.picker.price.${row.band}`),
      row.levels > 0 ? text("own.preset.picker.effort", { n: row.levels }) : undefined,
      [text("own.preset.picker.tools"), ...(row.image ? [text("own.preset.picker.image")] : [])].join("·"),
      row.released > 0
        ? text("own.preset.picker.released", { date: new Date(row.released).toISOString().slice(0, 10) })
        : undefined,
    ]
      .filter((item) => item)
      .join(" · ")
  }
  return (
    <button
      type="button"
      class="own-tp-row"
      aria-pressed={props.pressed}
      disabled={props.taken || props.locked}
      data-testid="preset-target-row"
      data-badge={props.row.badge}
      onClick={() => props.onPick()}
    >
      <span class="own-tp-title">
        <b>{props.row.name}</b>
        <Tag tone={props.row.badge === "metered" || props.row.badge === "prepaid" ? "warn" : "soft"}>
          {text(BADGE[props.row.badge])}
        </Tag>
        <Show when={props.marks?.fresh}>
          <Tag tone="accent" testid="preset-target-new">
            {text("own.preset.newTag")}
          </Tag>
        </Show>
      </span>
      <span class="own-tp-facts">
        {facts()}
        <Show when={props.marks?.retires}>
          {(at) => (
            <span class="text-own-faint" data-testid="preset-target-retirement">
              {" · "}
              {text("own.preset.retirement", { date: monthDay(at()) })}
            </span>
          )}
        </Show>
      </span>
      <Show when={props.taken && props.company}>
        <span class="own-tp-facts">{text("own.preset.picker.taken", { company: props.company! })}</span>
      </Show>
    </button>
  )
}

/**
 * A paid account's head: monthly budget and this month's spend, or the budget entered here (07 §3.4). The model pool's
 * checklist (pool-list.tsx) shows its paid accounts with it too.
 */
export function PaidAccount(
  props: ParentProps<{
    readonly account: Account.View
    readonly spent: number | undefined
    readonly decided: boolean
    readonly onDecided: () => void
  }>,
) {
  const data = useData()
  const i18n = useI18n()
  const text = usePresetsText()
  const own = data.local().own
  const [value, setValue] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const spent = () => (props.spent === undefined ? "—" : usd(props.spent, true))
  const writable = () => own.rpc.allowed("accounts.update")
  const save = async () => {
    const budget = parseBudget(value())
    if (budget === undefined || busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.update", {
        accountID: props.account.id,
        budget: budget === null || budget === 0 ? null : { monthlyUSD: budget },
      })
      .then(() => props.onDecided())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }
  return (
    <>
      <p class="own-tp-account" data-account-id={props.account.id}>
        {props.account.label}
        <span class="own-tp-budget" data-testid="preset-target-budget">
          {props.account.budget
            ? text("own.preset.picker.budget", { budget: usd(props.account.budget.monthlyUSD, true), spent: spent() })
            : text("own.preset.picker.noBudget", { spent: spent() })}
        </span>
      </p>
      <Show when={!props.account.budget && !props.decided}>
        <Show when={writable()} fallback={<p class="own-tp-hidden">{text("own.preset.picker.budgetElsewhere")}</p>}>
          <div class="own-tp-budget-form" data-testid="preset-target-budget-form">
            <TextField
              label={text("own.preset.picker.budgetField")}
              value={value()}
              onValue={setValue}
              onEnter={() => void save()}
              inputMode="decimal"
              error={parseBudget(value()) === undefined ? text("own.preset.picker.budgetInvalid") : undefined}
            />
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              disabled={busy() || parseBudget(value()) === undefined}
              onClick={() => void save()}
            >
              {text("own.preset.picker.budgetSet")}
            </button>
            <button type="button" class="own-btn" data-size="sm" data-variant="ghost" onClick={() => props.onDecided()}>
              {text("own.preset.picker.noCap")}
            </button>
          </div>
          <p class="own-tp-hidden">{text("own.preset.picker.budgetFirst")}</p>
          <StatusLine status={status} />
        </Show>
      </Show>
      {props.children}
    </>
  )
}
