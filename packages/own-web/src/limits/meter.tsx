// Limit and context visuals (03 §15.3 LimitBar, LimitMeterGroup, MiniLimitBar, ResetCountdown, ConfidenceTag,
// CacheStateBadge, ContextMeter bar form). Every number carries its source and confidence (0-7, 7.3); unknown values
// are written as `— 알 수 없음`, never drawn as 0 %. Times come from the shared minute clock (R9) through `now`.
import type { Account, Cache, Compaction, Limit } from "@own/protocol"
import { LimitRank } from "@own/protocol/limit-rank"
import { For, Match, Show, Switch } from "solid-js"
import { useI18n, type I18n } from "@/i18n"
import { formatTokens } from "@/switcher/format"
import { fill, limitText, shown, stateWord, valueText, type LimitMode } from "./display"
import { absolute, ago, amount, budget, resetText, resetTitle, tokens } from "./format"
import { Tag } from "./kit"
import { useSessionCardText } from "./session-strings"
import { resetLong, rows, stateTone, text, windowNote } from "./summary-model"
import { stateOnly, tightest, view, type WindowView } from "./windows"

export interface MeterProps {
  readonly now: () => number
}

/** 7.3 tags; `source: "ledger"` adds `로컬 집계` with its tooltip. The others give the observation time on hover. */
export function ConfidenceTag(props: { readonly view: WindowView } & MeterProps) {
  const i18n = useI18n()
  const observed = () => text(i18n, "own.lim.sum.observedAt", { date: absolute(i18n, props.view.observedAt) })
  return (
    <>
      <Switch>
        <Match when={props.view.source === "ledger"}>
          <Tag title={i18n.t("own.lim.localNote")} testid="conf-local">
            {i18n.t("own.conf.local")}
          </Tag>
        </Match>
        <Match when={props.view.confidence === "live"}>
          <Tag tone="plain" title={observed()} testid="conf-live">
            {i18n.t("own.conf.live", { ago: ago(i18n, props.now(), props.view.observedAt) })}
          </Tag>
        </Match>
        <Match when={props.view.confidence === "recent"}>
          <Tag title={observed()} testid="conf-recent">
            {i18n.t("own.conf.live", { ago: ago(i18n, props.now(), props.view.observedAt) })}
          </Tag>
        </Match>
        <Match when={props.view.confidence === "stale"}>
          <Tag tone="warn" title={observed()} testid="conf-stale">
            {i18n.t("own.lim.staleAgo", { ago: ago(i18n, props.now(), props.view.observedAt) })}
          </Tag>
        </Match>
        <Match when={props.view.confidence === "estimated"}>
          <Tag tone="dashed" testid="conf-estimated">
            {i18n.t("own.conf.estimated")}
          </Tag>
        </Match>
        <Match when={props.view.confidence === "unknown"}>
          <Tag testid="conf-unknown">{i18n.t("own.conf.unknown")}</Tag>
        </Match>
      </Switch>
    </>
  )
}

/**
 * 7.2 reset text with the absolute time on hover; a passed, unobserved reset reads `리셋됨(추정)`. `clock` (an unfolded
 * summary) also gives the clock time: `2시간 14분 후 리셋 (오후 5:40)`.
 */
export function ResetCountdown(props: { readonly view: WindowView; readonly clock?: boolean } & MeterProps) {
  const i18n = useI18n()
  return (
    <Switch>
      <Match when={props.view.resetEstimated}>
        <span>{i18n.t("own.limit.resetEstimated")}</span>
      </Match>
      <Match when={props.view.resetAt}>
        {(resetAt) => (
          <span title={resetTitle(i18n, resetAt())} data-testid="limit-reset">
            {props.clock ? resetLong(i18n, props.now(), resetAt()) : resetText(i18n, props.now(), resetAt())}
          </span>
        )}
      </Match>
    </Switch>
  )
}

/**
 * The bar itself (`role=meter`, 11장): full and shrinking in `remaining` mode, growing in `used` mode (./display).
 * `aria-valuenow` is the shown share; `aria-valuetext` says which one.
 */
export function Bar(props: {
  readonly view: WindowView
  readonly size?: "mini"
  readonly label: string
  readonly valueText: string
  readonly mode?: LimitMode
}) {
  const width = () => fill(props.view.percent ?? 0, props.mode)
  return (
    <span
      class="own-meter"
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown(props.view.percent ?? 0, props.mode))}
      aria-valuetext={props.valueText}
      data-size={props.size}
      data-tone={props.view.tone}
      data-hatched={props.view.hatched ? "" : undefined}
      data-faded={props.view.faded ? "" : undefined}
      data-empty={width() === 0 ? "" : undefined}
    >
      <span style={{ width: `${width()}%` }} />
    </span>
  )
}

/**
 * One window row (7.2): `5시간 ▰▰▰▱ 남음 62%` with the reset and the tag on a second line under the bar
 * (`2시간 14분 후 리셋  실측 · 1분 전`).
 */
export function LimitRow(
  props: {
    readonly window: Limit.Window
    readonly mode?: LimitMode
    /** Resets with the clock time (an unfolded summary). */
    readonly clock?: boolean
    /** Claude's extra usage would cover a used-up plan limit of the surface's model (`LimitRank.covering`). */
    readonly covering?: boolean
  } & MeterProps,
) {
  const i18n = useI18n()
  const item = () => view(props.window, props.now())
  const note = () => windowNote(i18n, props.window, props.covering ?? false)
  return (
    <div class="own-mrow" data-window={props.window.id} data-confidence={item().confidence} data-testid="limit-row">
      <span class="own-mrow-label">{item().label}</span>
      <Switch>
        {/* Known only by its state (Claude `추가 사용량` without a percent, a claimed `주간 · Opus`): `허용`/`주의`/`차단`. */}
        <Match when={stateOnly(item())}>
          <span
            class="own-mrow-state col-span-2"
            data-tone={stateTone(item(), props.window, props.covering ?? false)}
            data-testid="limit-state"
          >
            {stateWord(i18n, item().status)}
          </span>
        </Match>
        <Match when={item().unknown}>
          <span class="col-span-2 text-own-faint">{i18n.t("own.limit.unknown")}</span>
        </Match>
        <Match when={item().percent === undefined}>
          <span class="own-num col-span-2">{amount(item().remaining ?? 0, item().unit)}</span>
        </Match>
        <Match when={item().percent !== undefined}>
          <Bar
            view={item()}
            label={item().label}
            valueText={valueText(i18n, item(), props.now(), props.mode)}
            mode={props.mode}
          />
          <span class="own-mrow-value">{limitText(i18n, item().percent ?? 0, props.mode)}</span>
        </Match>
      </Switch>
      <span class="own-mrow-meta">
        <Show when={spendText(i18n, item())}>{(text) => <span class="own-num">{text()}</span>}</Show>
        <Show when={note()}>
          {(value) => (
            <span class="own-mrow-note" data-tone={value().tone} title={value().title} data-testid="limit-note">
              {value().text}
            </span>
          )}
        </Show>
        <ResetCountdown view={item()} clock={props.clock} now={props.now} />
        <Show when={!item().unknown || stateOnly(item())}>
          <ConfidenceTag view={item()} now={props.now} />
        </Show>
      </span>
    </div>
  )
}

/** Budgets and key limits: `$23.10 / 예산 $100`; rate windows: `남은 48 / 50`. */
function spendText(i18n: I18n, item: WindowView) {
  if (item.limit === undefined || item.remaining === undefined) return undefined
  if (item.kind === "budget" || item.kind === "spend_cap")
    return i18n.t("own.lim.spendOf", {
      spent: amount(item.limit - item.remaining, item.unit),
      budget: budget(item.limit, item.unit),
    })
  if (item.kind === "rate")
    return i18n.t("own.lim.remainingOf", { remaining: fmt(item.remaining), limit: fmt(item.limit) })
  return undefined
}

function fmt(value: number) {
  return value >= 10_000 ? tokens(value) : String(Math.round(value))
}

/** An account's windows as rows (./summary unfolded, the panel's rate windows, the settings preview), or its empty text. */
export function LimitMeterGroup(
  props: {
    readonly windows: readonly Limit.Window[] | undefined
    readonly max?: number
    /** Include per-minute rate windows (expanded rows). */
    readonly rates?: boolean
    readonly mode?: LimitMode
    /** The account's kind: a Sign in with ChatGPT account says none came yet and where to look (02 §7.1). */
    readonly kind?: Account.View["kind"]
    /** Resets with the clock time (an unfolded summary). */
    readonly clock?: boolean
    /** The surface's model: whether Claude's extra usage is in play for it (`LimitRank.covering`). */
    readonly model?: string
  } & MeterProps,
) {
  const i18n = useI18n()
  const covering = () => LimitRank.covering(props.windows ?? [], props.now(), props.model)
  const shown = () => {
    const list = rows(props.windows ?? [], props.rates, props.now(), props.model)
    return props.max === undefined ? list : list.slice(0, props.max)
  }
  const empty = () => i18n.t(props.kind === "siwc" ? "own.lim.sharingUnreported" : "own.lim.noWindows")
  return (
    <div class="own-meters" data-testid="limit-group">
      <For
        each={shown()}
        fallback={
          <span class="text-[12px] text-own-faint" data-testid="limit-empty">
            {empty()}
          </span>
        }
      >
        {(window) => (
          <LimitRow window={window} clock={props.clock} covering={covering()} now={props.now} mode={props.mode} />
        )}
      </For>
    </div>
  )
}

/** 7.2 mini bar: the tightest window only. */
export function MiniLimitBar(props: { readonly windows: readonly Limit.Window[] | undefined } & MeterProps) {
  const i18n = useI18n()
  const item = () => tightest(props.windows ?? [], props.now())
  return (
    <Show when={item()} fallback={<span class="text-[11.5px] text-own-faint">—</span>}>
      {(current) => (
        <Bar view={current()} size="mini" label={current().label} valueText={valueText(i18n, current(), props.now())} />
      )}
    </Show>
  )
}

/** The state as of `now`: the router's value ages on the minute clock (7.4 warm → cooling → cold). */
export function temperature(slot: Cache.Slot, now: number): Cache.Temperature {
  const warmUntil = slot.warmUntil ?? undefined
  const coldAfter = slot.coldAfter
  if (slot.state === "warm" && warmUntil !== undefined && now >= warmUntil) {
    if (coldAfter === null || coldAfter === undefined) return "unknown"
    return now >= coldAfter ? "cold" : "cooling"
  }
  if (slot.state === "cooling" && coldAfter !== null && coldAfter !== undefined && now >= coldAfter) return "cold"
  return slot.state
}

/**
 * 7.4 (UX 2026-10-26): a 6 px dot in the state's color, then the header pill's words (`own.pill.cache`): `캐시 따뜻함 ·
 * 약 4분 추정` / `캐시 식는 중` / `캐시 차가움` / `캐시 알 수 없음`. No glyph to learn (the ●◐○◌ of before).
 */
export function CacheStateBadge(props: { readonly slot: Cache.Slot | undefined } & MeterProps) {
  const i18n = useI18n()
  const state = () => (props.slot ? temperature(props.slot, props.now()) : "cold")
  const minutes = () => {
    const until = props.slot?.warmUntil
    return until ? Math.max(1, Math.ceil((until - props.now()) / 60_000)) : undefined
  }
  const words = () => {
    const current = state()
    const left = minutes()
    if (current === "warm") return left ? i18n.t("own.cache.warm", { minutes: left }) : i18n.t("own.lim.cacheWarm")
    if (current === "cooling") return i18n.t("own.cache.cooling")
    if (current === "cold") return i18n.t("own.cache.cold")
    return i18n.t("own.cache.unknown")
  }
  return (
    <span class="own-cache" data-state={state()} data-testid="cache-state">
      <span class="own-cache-dot" aria-hidden="true" />
      {i18n.t("own.pill.cache", { state: words() })}
      <Show when={state() === "warm" && minutes()}>
        <Tag tone="dashed">{i18n.t("own.conf.estimated")}</Tag>
      </Show>
    </span>
  )
}

export const SOURCE_LABEL = {
  v2: "own.compact.source.v2",
  kind: "own.compact.source.kind",
  kindModel: "own.compact.source.kindModel",
  account: "own.compact.source.account",
  accountModel: "own.compact.source.accountModel",
  session: "own.compact.source.session",
} as const satisfies Record<Compaction.Source, string>

/**
 * 5.8.3 context bar: fill `P` (at least 2 px once anything is in it), a tick at the effective trigger; the track up to
 * the trigger is the empty bar's track and the space beyond it, used only after a compaction, is hatched (UX
 * 2026-10-26: `6k / 272k` reads as nearly empty in both themes, only the fill is solid). With a session value a
 * second, fainter tick at the account·model point. Denominator is the original window (`windowTokens`), like the
 * composer's ring. The caption: `6k / 272k` and `자동 압축 245k`, the source in parentheses only when it is not the
 * model's own limit (`자동 압축 200k (이 대화)`).
 */
export function ContextBar(props: { readonly compaction: Compaction.View }) {
  const i18n = useI18n()
  const t = useSessionCardText()
  const window = () => props.compaction.windowTokens
  const used = () => props.compaction.P ?? 0
  const at = (value: number) => `${Math.min(100, (100 * value) / window())}%`
  const share = () => Math.round((100 * used()) / window())
  const sessionTick = () =>
    props.compaction.sessionTriggerTokens !== null &&
    props.compaction.sessionTriggerTokens < props.compaction.slotTriggerTokens
  const text = () =>
    i18n.t("own.lim.ctxAria", {
      used: tokens(used()),
      window: tokens(window()),
      percent: share(),
      trigger: tokens(props.compaction.triggerTokens),
      remaining: tokens(props.compaction.remainingTokens ?? Math.max(0, props.compaction.triggerTokens - used())),
    })
  return (
    <div data-testid="context-bar">
      <div
        class="own-ctxbar"
        role="meter"
        aria-label={i18n.t("own.lim.context")}
        aria-valuemin={0}
        aria-valuemax={window()}
        aria-valuenow={used()}
        aria-valuetext={text()}
        title={i18n.t("own.ctx.cacheNote")}
        style={{ "--own-ctxbar-trigger": at(props.compaction.triggerTokens) }}
      >
        <span
          class="own-ctxbar-fill"
          data-tone={used() >= props.compaction.triggerTokens * 0.9 ? "warn" : undefined}
          data-some={used() > 0 ? "" : undefined}
          style={{ width: at(used()) }}
        />
        <span
          class="own-ctxbar-over"
          style={{ width: `${Math.max(0, 100 - (100 * props.compaction.triggerTokens) / window())}%` }}
        />
        <Show when={sessionTick()}>
          <span class="own-ctxbar-tick" data-kind="slot" style={{ left: at(props.compaction.slotTriggerTokens) }} />
        </Show>
        <span
          class="own-ctxbar-tick"
          data-kind={sessionTick() ? "session" : undefined}
          data-testid="context-tick"
          style={{ left: at(props.compaction.triggerTokens) }}
        />
      </div>
      <div class="flex flex-wrap justify-between gap-x-2 text-[11.5px] leading-4 text-own-muted">
        {/* The composer's ring writes the same number beside it (composer/context-meter, `formatTokens`). */}
        <span class="own-num" data-testid="context-used">
          {props.compaction.P === null ? "—" : formatTokens(used())} / {formatTokens(window())}
        </span>
        <span data-testid="context-trigger">
          {props.compaction.source === "v2"
            ? t("own.lim.sess.autoAt", { tokens: tokens(props.compaction.triggerTokens) })
            : i18n.t("own.lim.autoAt", {
                tokens: tokens(props.compaction.triggerTokens),
                source: i18n.t(SOURCE_LABEL[props.compaction.source]),
              })}
        </span>
      </div>
    </div>
  )
}
