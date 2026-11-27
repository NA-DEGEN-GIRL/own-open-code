// UI-only switch marker (03 §4.5 "계정 전환 표시", 15.3 SwitchMarkerRow):
//   ─── ⇄ 계정 전환 · 회사 Plus → 개인 Pro · GPT-5.6 Sol 유지 · 압축 후 전환 · 캐시 재작성 38k ───
// Drawn from the durable `model-switched` message plus the router's `switch.recorded` event when this window saw it.
// It is never part of the model input: nothing here writes to the session (0-6, S8). The accounts are the ones that
// signed the steps around the switch (./signer `switchSigners`, SL-8): several Claude accounts share `anthropic`, so
// the provider names only the first; a Claude model switch that also moved the account reads as an account switch.
import type { Estimate } from "@own/protocol"
import { createMemo, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { useI18n, type I18n, type I18nKey } from "@/i18n"
import type { FeatureText } from "@/queue/text"
import { AccountName } from "./chip"
import { useTranscript } from "./context"
import { formatCredits, formatTokens, formatUsd } from "./format"
import { useMarkerText, type MarkerKey } from "./marker-strings"
import type { SwitchMarker } from "./markers"
import type { SwitchRecord } from "./records"
import { fitSeps } from "./seps-fit"
import { switchSigners } from "./signer"

const STRATEGY: Record<Estimate.Strategy, I18nKey> = {
  now: "own.switch.optNow",
  "compact-then-switch": "own.switch.optCompact",
  "switch-then-compact": "own.switch.optSwitchThenCompact",
  "cold-point": "own.switch.optCold",
  "new-session": "own.switch.optNewSession",
  fork: "own.switch.optFork",
}

export function SwitchMarkerRow(props: { readonly marker: Accessor<SwitchMarker> }) {
  const i18n = useI18n()
  const words = useMarkerText()
  const transcript = useTranscript()
  const signers = createMemo(() =>
    switchSigners(
      { own: transcript.runtime.own, i18n, providerName: transcript.catalog.providerName },
      transcript.sessionID,
      props.marker(),
      transcript.ledger.line,
    ),
  )
  const from = () => signers().from.display
  const to = () => signers().to.display
  const kind = () => signers().kind
  const record = createMemo(() => transcript.records.match(transcript.sessionID, props.marker()))
  const title = () => words(switchTitle(kind()))
  const modelPart = () => {
    const marker = props.marker()
    const name = (ref: { providerID: string; id: string }) => transcript.catalog.modelName(ref.providerID, ref.id)
    if (marker.kind === "variant")
      return words("own.marker.modelChanged", {
        from: marker.from.variant ?? "default",
        to: marker.to.variant ?? "default",
      })
    if (name(marker.from) === name(marker.to)) return words("own.marker.modelKept", { model: name(marker.to) })
    return words("own.marker.modelChanged", { from: name(marker.from), to: name(marker.to) })
  }
  // Measured: the uncached input of the first step after the switch. Before that step: the router's estimate.
  const rewrite = createMemo(() => {
    const id = props.marker().firstStepID
    const step = id ? transcript.projection.messageByID().get(id) : undefined
    const tokens = step?.type === "assistant" ? step.tokens : undefined
    if (tokens)
      return {
        text: words("own.marker.rewrite", { tokens: formatTokens(tokens.input + tokens.cache.write) }),
        measured: true,
      }
    const estimate = record()?.estimate
    if (estimate) return { text: words("own.marker.rewriteCost", { cost: deltaText(i18n, estimate) }), measured: false }
    return undefined
  })
  const tooltip = () =>
    [
      words("own.marker.reason", { reason: reasonText(words, record()) }),
      words("own.marker.appliedAt", { time: new Date(props.marker().at).toLocaleString(i18n.locale()) }),
      words("own.marker.uiOnlyHint"),
    ].join("\n")

  let row!: HTMLDivElement
  let seps!: HTMLSpanElement
  // A wrapped pill ends at its widest line (./seps-fit, merge round 7).
  onMount(() => onCleanup(fitSeps(seps, row)))

  return (
    <div ref={row} class="own-marker" data-kind="switch" data-testid="switch-marker" role="note" title={tooltip()}>
      {/* Unbreakable parts on styles/seps.css lines: a wrapped line never starts with `·` (UX 2026-10-27). */}
      <span class="own-marker-pill">
        <span ref={seps} class="own-seps">
          <span class="own-seps-in">
            <span>
              <span aria-hidden="true">⇄</span> <b>{title()}</b>
            </span>
            <span>
              <AccountName account={from()} />
              <Show when={kind() === "account"}>
                {" "}
                <span aria-hidden="true">→</span> <AccountName account={to()} />
              </Show>
            </span>
            <span data-wrap>{modelPart()}</span>
            <Show when={record()}>{(current) => <span>{i18n.t(STRATEGY[current().strategy])}</span>}</Show>
            <Show when={rewrite()}>
              {(value) => (
                <span class="own-num" data-testid="switch-rewrite">
                  {value().text}{" "}
                  <span class="own-ttag" data-kind={value().measured ? "measured" : "estimate"}>
                    {i18n.t(value().measured ? "own.transcript.measured" : "own.transcript.estimated")}
                  </span>
                </span>
              )}
            </Show>
            <span data-sep="none">
              <span class="own-marker-uionly">{words("own.marker.uiOnly")}</span>
            </span>
          </span>
        </span>
      </span>
    </div>
  )
}

/** The marker's title, also the screen-reader line's (`switchSigners` kind: a Claude switch that moved the account). */
export function switchTitle(kind: SwitchMarker["kind"]): MarkerKey {
  if (kind === "variant") return "own.marker.variantTitle"
  if (kind === "model") return "own.marker.modelTitle"
  return "own.marker.switchTitle"
}

/** `+13.5 cr`, `+$0.72`, `+2~8%`; ranges as `+X~Y` (7.5). */
export function deltaText(i18n: I18n, delta: Estimate.Delta) {
  const one = (value: number) => {
    if (delta.unit === "credits") return formatCredits(value)
    if (delta.unit === "USD") return formatUsd(value)
    return value.toFixed(1)
  }
  const amount = delta.lo === delta.hi ? one(delta.hi) : `${one(delta.lo)}~${one(delta.hi)}`
  if (delta.unit === "credits") return `+${i18n.t("own.cost.credits", { value: amount })}`
  if (delta.unit === "USD") return `+${i18n.t("own.transcript.money", { value: amount })}`
  return `+${amount}%`
}

export function reasonText(words: FeatureText<MarkerKey>, record: SwitchRecord | undefined) {
  if (!record) return words("own.marker.reason.unknown")
  if (record.strategy === "fork") return words("own.marker.reason.fork")
  if (record.strategy === "cold-point") return words("own.marker.reason.schedule")
  if (record.reason === "hard") return words("own.marker.reason.hard")
  if (record.reason === "auth") return words("own.marker.reason.auth")
  return words("own.marker.reason.manual")
}
