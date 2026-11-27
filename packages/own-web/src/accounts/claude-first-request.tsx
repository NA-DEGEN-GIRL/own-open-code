// The composer's notice of a Claude account's first request (02 §8.9, CW 2026-10-19), a lazy chunk: the request is
// already on its way (the user chose "warn and verify", not a consent), so `계속` only closes the notice and `취소`
// stops the turn as the composer's stop does. The router remembers the account (KV `claude:firstRequest:<id>`), so it
// comes once per account and service.
import { Show } from "solid-js"
import type { ServerRuntime } from "@/data"
import { dismissFirstRequest } from "@/composer/claude-first"
import { useClaudeBillingText } from "./claude-billing-strings"

export function ClaudeFirstRequest(props: {
  readonly runtime: ServerRuntime
  readonly sessionID: string
  readonly alertID: string
}) {
  const t = useClaudeBillingText()
  const running = () => props.runtime.data.session.status(props.sessionID) === "running"
  const cancel = async () => {
    dismissFirstRequest(props.alertID)
    await props.runtime
      .client()
      .session.interrupt({ sessionID: props.sessionID })
      .catch((error: unknown) => console.error("[own-web] claude first request: interrupt failed", error))
  }
  return (
    <div class="own-sw-chip-line" role="status" data-testid="claude-first-request">
      <span class="own-sw-chip-icon" aria-hidden="true">
        ⓘ
      </span>
      <span class="min-w-0 flex-1">{t("own.claude.first.line")}</span>
      <button
        type="button"
        class="own-sw-chip-link"
        onClick={() => dismissFirstRequest(props.alertID)}
        data-testid="claude-first-request-continue"
      >
        {t("own.claude.first.continue")}
      </button>
      {/* Stopping is only offered while the turn runs; afterwards there is nothing left to stop. */}
      <Show when={running()}>
        <button
          type="button"
          class="own-sw-chip-link"
          onClick={() => void cancel()}
          data-testid="claude-first-request-cancel"
        >
          {t("own.claude.first.cancel")}
        </button>
      </Show>
    </div>
  )
}
