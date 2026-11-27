// Compaction marker (03 §4.5 "압축 표시", 15.3 CompactionMarkerRow):
//   ⊟ 문맥 압축 · 152k → 41k · 개인 Pro에서 요약 · 자동(245k 지점)
// The account is the one that signed the compaction request, from its ledger line (./signer, SL 2026-10-26).
// A checkpoint a fallback wrote (own/docs/11 §3) says so: "…에서 대체 요약 · <model>" when another account's model
// stood in, "모델 없이 줄임" when code made it; the failure is in the label's title.
// "before" is the context after the last step before the compaction, "after" the request size of the first step
// after it (core records the compaction request's own usage, not the resulting context). The summary itself stays
// available through session-ui's compaction row behind "요약 보기"; "압축 내용 보기" opens every compaction of the
// conversation with this one open (src/compactions, UC 2026-10-18).
import type { SessionMessageInfo } from "@opencode/client/promise"
import { createMemo, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { openCompactions } from "@/compactions"
import { useCompactionsText } from "@/compactions/strings"
import { useI18n } from "@/i18n"
import { AccountName } from "./chip"
import { useTranscript } from "./context"
import { formatTokens, splitAt } from "./format"
import { useMarkerText } from "./marker-strings"
import { compactionSizes, type CompactionMarker } from "./markers"
import { fitSeps } from "./seps-fit"
import { signerOf } from "./signer"

type Completed = Extract<SessionMessageInfo, { type: "compaction"; status: "completed" }>

export function CompactionMarkerRow(props: {
  readonly message: Accessor<Completed>
  readonly marker: Accessor<CompactionMarker | undefined>
  /** session-ui's own rendering of the compaction row (separator + summary). */
  readonly summary: () => JSX.Element
  readonly onSizeChange?: () => void
}) {
  const i18n = useI18n()
  const words = useMarkerText()
  const text = useCompactionsText()
  const transcript = useTranscript()
  const own = transcript.runtime.own
  const sizes = createMemo(() => compactionSizes(props.marker(), (id) => transcript.projection.messageByID().get(id)))
  const before = () => sizes().before
  const after = () => sizes().after
  const fallback = createMemo(() => fallbackOf(props.message().metadata))
  const account = createMemo(() => {
    const providerID = fallback()?.model?.split("/")[0] ?? props.message().model?.providerID
    if (!providerID) return undefined
    return signerOf(
      { own, i18n, providerName: transcript.catalog.providerName },
      { sessionID: transcript.sessionID, providerID, line: transcript.ledger.line(props.message().id) },
    ).display
  })
  const reason = createMemo(() => {
    const message = props.message()
    const requested = own.state.compactionRequested[transcript.sessionID]
    if (requested?.inputID === message.id)
      return words("own.marker.compactSession", { tokens: formatTokens(requested.triggerTokens) })
    const switchID = props.marker()?.switchID
    const marker = switchID ? transcript.markers().switches.get(switchID) : undefined
    const record = marker ? transcript.records.match(transcript.sessionID, marker) : undefined
    if (record?.strategy === "compact-then-switch") return words("own.marker.compactSwitch")
    // own-accounts' idle compaction (02 §4.7.7) is admitted like /compact; its trigger is in the checkpoint's metadata
    // (`CompactionCache.TRIGGER_KEY`, read by name to keep @own/protocol/compaction-cache out of the first chunk).
    if (message.metadata?.["own.compaction.trigger"] === "idle") return text("own.compactions.idle")
    if (message.reason === "manual") return words("own.marker.compactManual")
    // The trigger is known for the current model only; older compactions of another model show just "자동".
    const view = own.state.cache[transcript.sessionID]?.compaction
    const model = message.model
    if (view && model && view.providerID === model.providerID && view.modelID === model.id)
      return words("own.marker.compactAutoAt", { tokens: formatTokens(view.triggerTokens) })
    return words("own.marker.compactAuto")
  })
  const open = () => transcript.disclosure.value(`compaction:${props.message().id}`) === true
  const toggle = () => {
    transcript.disclosure.set(`compaction:${props.message().id}`, !open())
    props.onSizeChange?.()
  }
  let row!: HTMLDivElement
  let seps!: HTMLSpanElement
  // A wrapped pill ends at its widest line (./seps-fit, merge round 7).
  onMount(() => onCleanup(fitSeps(seps, row)))

  return (
    <div class="own-compaction" data-testid="compaction-marker">
      <div ref={row} class="own-marker" data-kind="compaction" role="note">
        {/* Unbreakable parts on styles/seps.css lines: a wrapped line never starts with `·` (merge round 7, as the
            switch marker). The buttons follow without one (`data-sep="none"`). */}
        <span class="own-marker-pill">
          <span ref={seps} class="own-seps">
            <span class="own-seps-in">
              <span>
                <span aria-hidden="true">⊟</span>{" "}
                <span data-testid="compaction-sizes">
                  {words("own.marker.compact", {
                    before: before() === undefined ? "—" : formatTokens(before()!),
                    after: after() === undefined ? words("own.marker.compactAfterPending") : formatTokens(after()!),
                  })}
                </span>
              </span>
              <Show when={fallback()?.model === undefined && fallback()}>
                {(value) => (
                  <span
                    class="own-marker-fallback"
                    data-testid="compaction-fallback"
                    title={words("own.marker.compactFailure", { reason: value().reason })}
                  >
                    {words("own.marker.compactByCode")}
                  </span>
                )}
              </Show>
              <Show when={(fallback() === undefined || fallback()?.model !== undefined) && account()}>
                {(value) => {
                  // The account name is an element inside the translated phrase "{account}에서 요약".
                  const stoodIn = fallback()
                  const [head, tail] = splitAt(
                    words(stoodIn ? "own.marker.compactByFallback" : "own.marker.compactBy"),
                    "{account}",
                  )
                  return (
                    <span
                      data-wrap
                      classList={{ "own-marker-fallback": !!stoodIn }}
                      data-testid={stoodIn ? "compaction-fallback" : undefined}
                      title={stoodIn ? words("own.marker.compactFailure", { reason: stoodIn.reason }) : undefined}
                    >
                      {head}
                      <AccountName account={value()} />
                      {tail}
                      {stoodIn?.model ? ` · ${stoodIn.model.split("/").slice(1).join("/")}` : ""}
                    </span>
                  )
                }}
              </Show>
              <span data-testid="compaction-reason">{reason()}</span>
              <span data-sep="none">
                <button type="button" class="own-marker-toggle" aria-expanded={open()} onClick={toggle}>
                  {words(open() ? "own.marker.hideSummary" : "own.marker.showSummary")}
                </button>
              </span>
              <span data-sep="none">
                <button
                  type="button"
                  class="own-marker-toggle"
                  aria-haspopup="dialog"
                  data-testid="compaction-open-view"
                  onClick={() =>
                    openCompactions({
                      serverKey: transcript.runtime.key,
                      sessionID: transcript.sessionID,
                      messageID: props.message().id,
                    })
                  }
                >
                  {text("own.compactions.open")}
                </button>
              </span>
            </span>
          </span>
        </span>
      </div>
      <Show when={open()}>
        <div class="own-compaction-summary" ref={expandQuiet}>
          {props.summary()}
        </div>
      </Show>
    </div>
  )
}

/**
 * Since upstream v2.3.1 session-ui draws an automatic compaction as one quiet divider whose summary opens on a click
 * (#64290). own's marker already is the header with `요약 보기`, so the divider opens with it and its button is hidden
 * (transcript.css): one click shows the summary, as before.
 */
function expandQuiet(element: HTMLDivElement) {
  queueMicrotask(() => {
    const divider = element.querySelector<HTMLButtonElement>(
      '[data-component="session-compaction-message"][data-quiet] [data-slot="session-compaction-divider"]',
    )
    if (divider?.getAttribute("aria-expanded") === "false") divider.click()
  })
}

/** Core's `fallback` metadata on a checkpoint (P-025): the stand-in model, if one wrote it, and why the compaction failed. */
function fallbackOf(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.fallback
  if (typeof value !== "object" || value === null) return undefined
  const fallback = value as { model?: unknown; reason?: unknown }
  return {
    model: typeof fallback.model === "string" ? fallback.model : undefined,
    reason: typeof fallback.reason === "string" ? fallback.reason : "",
  }
}
