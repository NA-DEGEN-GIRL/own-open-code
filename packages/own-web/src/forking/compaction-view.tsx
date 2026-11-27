// Compaction progress in the composer (03 §19.12): a chip while a compaction is asked for, waits or runs
// (`압축 중…`), and a failure banner with `다시 시도` / `닫기`. Nothing (no DOM) while idle. The manual entry points
// (`지금 압축` in the context meter and the header `⋯`, `/compact`) share `useCompactNow`.
import { Match, Show, Switch } from "solid-js"
import type { ServerRuntime } from "@/data"
import { useI18n, type Locale } from "@/i18n"
import { showToast } from "@/switcher/toast"
import { compactionTracker } from "./compaction"
import { useForkText } from "./strings"
import "./compaction.css"

/**
 * `지금 압축`: admits a manual compaction for the session. A staged revert is committed by a compaction (core
 * `Session.compact`), so that case asks first with a toast action, like `/compact` did (03 §5.8.4 impactRevert). A
 * waiting context reset leaves nothing to compact: the reset chunk says so and offers to cancel it (03 §18.18).
 */
export function useCompactNow() {
  const i18n = useI18n()
  const text = useForkText()
  return (runtime: ServerRuntime, sessionID: string) => {
    const run = () => void compactionTracker(runtime).request(sessionID)
    const reset = runtime.data.session.pending.list(sessionID).find((item) => item.type === "reset")
    if (reset) return void behindReset({ runtime, sessionID, resetID: reset.id, locale: i18n.locale(), compact: run })
    if (runtime.data.session.get(sessionID)?.revert)
      return showToast({
        message: i18n.t("own.compact.impactRevert"),
        action: { label: text("own.compaction.anyway"), run },
      })
    run()
  }
}

/** The reset's words live in its lazy chunk (PF5). */
async function behindReset(input: {
  readonly runtime: ServerRuntime
  readonly sessionID: string
  readonly resetID: string
  readonly locale: Locale
  readonly compact: () => void
}) {
  const { compactBehindReset } = await import("@/context-reset")
  compactBehindReset({ ...input, toast: showToast })
}

export function CompactionStatus(props: { readonly runtime: ServerRuntime; readonly sessionID: string }) {
  const text = useForkText()
  const compactNow = useCompactNow()
  const view = () => compactionTracker(props.runtime).view(props.sessionID)
  const reason = () => {
    const current = view().reason
    return current ? ` · ${text(`own.compaction.reason.${current}`)}` : ""
  }
  return (
    <Switch>
      <Match when={view().phase === "running" || view().phase === "requesting" || view().phase === "queued"}>
        <div class="own-fc-chip" role="status" data-testid="compaction-status" data-phase={view().phase}>
          <span class="own-fc-spin" aria-hidden="true" />
          <span>
            <Switch>
              <Match when={view().phase === "running"}>
                {text("own.compaction.running")}
                {reason()}
              </Match>
              <Match when={view().phase === "requesting"}>{text("own.compaction.requesting")}</Match>
              <Match when={view().phase === "queued"}>{text("own.compaction.queued")}</Match>
            </Switch>
          </span>
        </div>
      </Match>
      <Match when={view().phase === "failed"}>
        <div class="own-fc-banner" role="alert" data-testid="compaction-failed">
          <span class="own-fc-banner-icon" aria-hidden="true">
            ⊟
          </span>
          <span class="own-fc-banner-text">
            {view().requestFailed ? text("own.compaction.requestFailed") : text("own.compaction.failed")}
            {reason()}
            <Show when={view().error}>{(error) => <span class="own-fc-banner-detail"> — {error()}</span>}</Show>
          </span>
          <span class="own-fc-banner-actions">
            <Show when={props.runtime.rpc.can("prompt")}>
              <button
                type="button"
                class="own-fc-link"
                data-testid="compaction-retry"
                onClick={() => compactNow(props.runtime, props.sessionID)}
              >
                {text("own.compaction.retry")}
              </button>
            </Show>
            <button
              type="button"
              class="own-fc-link"
              data-testid="compaction-dismiss"
              onClick={() => compactionTracker(props.runtime).dismiss(props.sessionID)}
            >
              {text("own.compaction.dismiss")}
            </button>
          </span>
        </div>
      </Match>
    </Switch>
  )
}
