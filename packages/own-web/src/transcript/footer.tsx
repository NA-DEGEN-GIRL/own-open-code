// Turn footer and step table (03 §4.5 "턴 footer", 15.3 TurnFooter/StepTable):
//   ● 회사 Plus · GPT-5.6 Sol · 입력 148k (캐시 96%) · 출력 2.1k · ≈15.8 cr 추정 · 42 t/s · 첫 토큰 1.2초 · 42초 ·
//   10월 18일 오후 3:43
// The account is the one that signed the turn's last step, from its ledger line (./signer, SL 2026-10-26: several
// Claude accounts share one provider); the step table gets an account column when the steps ran on more than one. A
// first step that read under half its input from the cache is tagged `첫 단계 캐시 재작성`, or `계정이 바뀌어서 캐시가
// 비었어요` when the step before it ran on another account (each account has its own cache).
// Tokens come from the steps (`step.ended.tokens`), the unit and amount from the router's ledger (credits for the
// ChatGPT subscription, USD for API keys, unknown for the Claude slot), the speed from the steps' timestamps
// (usage.ts `stepSpeed`), the date and time (`날짜·시각`, off until turned on) from the steps' own times: when the
// answer finished, or started while it runs, with both in the tooltip. Clicking opens the per-step table (its `시각`
// column: each step's start). The chat view (src/chat-view) picks the parts; with none left the footer draws nothing.
import type { SessionMessageAssistant } from "@opencode/client/promise"
import { createEffect, createMemo, For, Show } from "solid-js"
import { chatView } from "@/chat-view"
import { useChatViewText } from "@/chat-view/strings"
import { useI18n } from "@/i18n"
import { AccountDot } from "./chip"
import { useTranscript } from "./context"
import {
  formatClock,
  formatClockFull,
  formatClockTime,
  formatCredits,
  formatDuration,
  formatPercent,
  formatSeconds,
  formatSpeed,
  formatTokens,
  formatUsd,
} from "./format"
import { useMarkerText } from "./marker-strings"
import { signerOf } from "./signer"
import { turnUsage, type StepSpeed, type TurnCost, type TurnSpeed } from "./usage"
import { footerSlots, type FooterSlot } from "./view-filter"

const empty: SessionMessageAssistant[] = []

export function TurnFooter(props: { readonly turnID: string; readonly onSizeChange?: () => void }) {
  const i18n = useI18n()
  const transcript = useTranscript()
  const own = transcript.runtime.own
  const text = useChatViewText()
  const words = useMarkerText()
  const assistants = createMemo(() => transcript.projection.assistantMessagesByParent().get(props.turnID) ?? empty)
  const names = { own, i18n, providerName: transcript.catalog.providerName }
  const signer = (message: SessionMessageAssistant) =>
    signerOf(names, {
      sessionID: transcript.sessionID,
      providerID: message.model.providerID,
      line: transcript.ledger.line(message.id),
    })
  const signers = createMemo(() => assistants().map(signer))
  const account = createMemo(() => signers().at(-1)?.display)
  /** The steps ran on more than one account (a switch inside the turn): the step table names each one's. */
  const mixed = createMemo(() => new Set(signers().map((item) => item.key)).size > 1)
  /** The first step ran on another account than the step before it, both as their ledger lines say. */
  const accountChange = createMemo(() => {
    const first = assistants()[0]
    const before = first ? transcript.stepBefore(first.id) : undefined
    const from = before ? signer(before) : undefined
    const to = signers()[0]
    if (!from?.recorded || !to?.recorded || from.key === to.key) return undefined
    return { from: from.display.label, to: to.display.label }
  })
  const rewriteText = () =>
    accountChange() ? words("own.marker.accountRewrite") : i18n.t("own.transcript.firstStepRewrite")
  const usage = createMemo(() =>
    turnUsage(assistants(), { lineOf: transcript.ledger.line, accountKind: account()?.kind }),
  )
  const model = createMemo(() => {
    const current = usage()
    return current.providerID && current.modelID
      ? transcript.catalog.modelName(current.providerID, current.modelID)
      : ""
  })
  const duration = createMemo(() => {
    const user = transcript.projection.messageByID().get(props.turnID)
    const completed = assistants().reduce((latest, message) => Math.max(latest, message.time.completed ?? 0), 0)
    if (user?.type !== "user" || completed < user.time.created) return undefined
    return completed - user.time.created
  })
  /** `날짜·시각`: the answer's first step start and its last step end (no end while the turn runs). */
  const span = createMemo(() => {
    const steps = assistants()
    const first = steps[0]
    if (!first) return undefined
    const completed = steps.reduce((latest, message) => Math.max(latest, message.time.completed ?? 0), 0)
    return { start: first.time.created, end: completed > 0 ? completed : undefined }
  })
  const clockText = () => {
    const value = span()
    return value ? formatClock(i18n, value.end ?? value.start) : ""
  }
  const clockTitle = () => {
    const value = span()
    if (!value) return undefined
    const start = formatClockFull(i18n, value.start)
    return value.end === undefined
      ? text("own.clock.started", { start })
      : text("own.clock.span", { start, end: formatClockFull(i18n, value.end) })
  }
  // A footer of a turn older than the loaded ledger page asks for the next page (router accounts only).
  createEffect(() => {
    if (account()?.builtin !== false) return
    if (assistants().some((message) => message.tokens && !transcript.ledger.line(message.id)))
      transcript.ledger.wantOlder()
  })
  const open = () => transcript.disclosure.value(`footer:${props.turnID}`) === true
  const toggle = () => {
    transcript.disclosure.set(`footer:${props.turnID}`, !open())
    props.onSizeChange?.()
  }
  const cost = createMemo(() => costText(i18n, usage().cost))
  const rewrote = () => {
    const hit = usage().firstHit
    return hit !== null && hit < 0.5
  }
  const slots = createMemo(() =>
    footerSlots(chatView(), {
      speed: usage().speed,
      duration: duration() !== undefined,
      rewrote: rewrote(),
      clock: span() !== undefined,
    }),
  )
  const has = (slot: FooterSlot) => slots().includes(slot)
  const label = createMemo(() =>
    slots()
      .flatMap((slot) => {
        const current = usage()
        if (slot === "account") return [account()?.label ?? ""]
        if (slot === "model") return [model()]
        if (slot === "input")
          return [
            i18n.t("own.transcript.inputHit", { input: formatTokens(current.input), hit: formatPercent(current.hit) }),
          ]
        if (slot === "output") return [i18n.t("own.transcript.outputTokens", { output: formatTokens(current.output) })]
        if (slot === "cost") return [cost().text]
        if (slot === "rewrite") return [rewriteText()]
        if (slot === "speed") return current.speed ? [speedText(text, current.speed)] : []
        if (slot === "firstToken") return current.speed ? [firstTokenText(text, current.speed)] : []
        if (slot === "clock") return [clockText()]
        const time = duration()
        return time === undefined ? [] : [formatDuration(i18n, time)]
      })
      .filter(Boolean)
      .join(" · "),
  )
  // Step table columns follow the footer parts: tokens with the usage line, time, date and time, and speed with theirs;
  // the account (only when the steps ran on more than one) with the model and account.
  const columns = () => ({
    account: chatView().model && mixed(),
    usage: chatView().usage,
    time: chatView().time,
    clock: chatView().clock,
    speed: chatView().speed,
  })

  return (
    <Show when={slots().length > 0}>
      <div class="own-turn-footer" data-testid="turn-footer" data-turn-id={props.turnID}>
        <button
          type="button"
          class="own-foot"
          aria-expanded={open()}
          aria-label={label()}
          title={i18n.t("own.transcript.showSteps")}
          onClick={toggle}
        >
          {/* Unbreakable parts on styles/seps.css lines: a wrapped line never starts with `·` (UX 2026-10-27). */}
          <span class="own-seps">
            <span class="own-seps-in">
              <Show when={has("account")}>
                <span class="own-account-name">
                  <AccountDot color={account()?.color} />
                  <bdi data-slot="account">{account()?.label}</bdi>
                </span>
              </Show>
              <Show when={has("model")}>
                <span data-slot="model">{model()}</span>
              </Show>
              <Show when={has("input")}>
                <span class="own-num" data-slot="input">
                  {i18n.t("own.transcript.inputHit", {
                    input: formatTokens(usage().input),
                    hit: formatPercent(usage().hit),
                  })}
                </span>
              </Show>
              <Show when={has("output")}>
                <span class="own-num" data-slot="output">
                  {i18n.t("own.transcript.outputTokens", { output: formatTokens(usage().output) })}
                </span>
              </Show>
              <Show when={has("cost")}>
                <span class="own-num" data-slot="cost" data-unit={usage().cost.kind}>
                  {cost().text}
                  <Show when={cost().tag}>
                    {(tag) => (
                      <span class="own-ttag" data-kind="estimate">
                        {tag()}
                      </span>
                    )}
                  </Show>
                </span>
              </Show>
              <Show when={has("speed") && usage().speed}>
                {(speed) => (
                  <span
                    class="own-num"
                    data-slot="speed"
                    data-basis={speed().basis}
                    title={text(speed().basis === "decode" ? "own.speed.decodeHint" : "own.speed.requestHint")}
                  >
                    {speedText(text, speed())}
                  </span>
                )}
              </Show>
              <Show when={has("firstToken") && usage().speed}>
                {(speed) => (
                  <span class="own-num" data-slot="first-token">
                    {firstTokenText(text, speed())}
                  </span>
                )}
              </Show>
              <Show when={has("time") && duration()}>
                {(time) => (
                  <span class="own-num" data-slot="time">
                    {formatDuration(i18n, time())}
                  </span>
                )}
              </Show>
              <Show when={has("clock")}>
                <span class="own-num" data-slot="clock" title={clockTitle()}>
                  {clockText()}
                </span>
              </Show>
              <Show when={has("rewrite")}>
                <span data-sep="none">
                  <span
                    class="own-ttag"
                    data-kind="warn"
                    data-testid="footer-rewrite"
                    data-cause={accountChange() ? "account" : undefined}
                    title={accountChange() ? words("own.marker.accountRewriteHint", accountChange()) : undefined}
                  >
                    {rewriteText()}
                  </span>
                </span>
              </Show>
            </span>
          </span>
        </button>
        <Show when={open()}>
          <table class="own-steps" data-testid="step-table">
            <thead>
              <tr>
                <th scope="col">{i18n.t("own.transcript.step")}</th>
                <Show when={columns().account}>
                  <th scope="col">{words("own.marker.stepAccount")}</th>
                </Show>
                <Show when={columns().usage}>
                  <th scope="col">{i18n.t("own.transcript.input")}</th>
                  <th scope="col">{i18n.t("own.transcript.cacheRead")}</th>
                  <th scope="col">{i18n.t("own.transcript.cacheWrite")}</th>
                  <th scope="col">{i18n.t("own.transcript.output")}</th>
                </Show>
                <Show when={columns().time}>
                  <th scope="col">{i18n.t("own.transcript.time")}</th>
                </Show>
                <Show when={columns().clock}>
                  <th scope="col">{text("own.clock.column")}</th>
                </Show>
                <Show when={columns().speed}>
                  <th scope="col">{text("own.speed.column")}</th>
                </Show>
              </tr>
            </thead>
            <tbody>
              <For each={usage().steps}>
                {(step, index) => (
                  <tr>
                    <td>{index() + 1}</td>
                    <Show when={columns().account}>
                      <td data-slot="step-account">{signers()[index()]?.display.label}</td>
                    </Show>
                    <Show when={columns().usage}>
                      <td>{formatTokens(step.input)}</td>
                      <td>{`${formatTokens(step.cacheRead)} (${formatPercent(step.hit)})`}</td>
                      <td>{formatTokens(step.cacheWrite)}</td>
                      <td>{formatTokens(step.output)}</td>
                    </Show>
                    <Show when={columns().time}>
                      <td>{step.durationMs === null ? "—" : formatDuration(i18n, step.durationMs)}</td>
                    </Show>
                    <Show when={columns().clock}>
                      <td data-slot="step-clock" title={formatClockFull(i18n, step.startedAt)}>
                        {formatClockTime(i18n, step.startedAt)}
                      </td>
                    </Show>
                    <Show when={columns().speed}>
                      <td data-slot="step-speed">{step.speed ? stepSpeedText(text, step.speed) : "—"}</td>
                    </Show>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </Show>
  )
}

type SpeedText = ReturnType<typeof useChatViewText>

/** `42 t/s`, or `≈38 t/s` when a step could only be timed from its request start. */
function speedText(text: SpeedText, speed: Pick<TurnSpeed, "tokensPerSecond" | "basis">) {
  const value = formatSpeed(speed.tokensPerSecond)
  return text(speed.basis === "decode" ? "own.speed.value" : "own.speed.approx", { value })
}

function stepSpeedText(text: SpeedText, speed: StepSpeed) {
  return speedText(text, { tokensPerSecond: (speed.tokens * 1_000) / speed.ms, basis: speed.basis })
}

/** `첫 토큰 1.2초`. */
function firstTokenText(text: SpeedText, speed: TurnSpeed) {
  return text("own.speed.firstToken", {
    value: text("own.speed.seconds", { n: formatSeconds(speed.firstTokenMs ?? 0) }),
  })
}

/** 7.5: credits always carry `≈` and the 추정 tag; USD may carry 재계산; unknown says so (P4). */
export function costText(i18n: ReturnType<typeof useI18n>, cost: TurnCost): { text: string; tag?: string } {
  if (cost.kind === "credits")
    return {
      text: i18n.t("own.cost.credits", { value: formatCredits(cost.value) }),
      tag: i18n.t("own.transcript.estimated"),
    }
  if (cost.kind === "usd")
    return {
      text: i18n.t("own.transcript.money", { value: formatUsd(cost.value) }),
      tag: cost.recomputed ? i18n.t("own.cost.recomputed") : undefined,
    }
  return { text: i18n.t("own.transcript.costUnknown") }
}
