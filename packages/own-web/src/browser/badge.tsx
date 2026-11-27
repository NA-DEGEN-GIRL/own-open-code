// `●` on the 브라우저 tab (the center workspace's since ab31dc31dd, and the work panel's) while the agent drives the
// routed session's browser (03 §4.7 "탭 머리줄").
// First chunk: reads only the registry signal; renders nothing on hosts without the pane (no tracker registered).
import { Show } from "solid-js"
import { useI18n } from "@/i18n"
import { browserPhase } from "./registry"

export function BrowserTabBadge(props: {
  readonly serverKey: () => string
  readonly sessionID: () => string | undefined
}) {
  const i18n = useI18n()
  const phase = () => browserPhase(props.serverKey(), props.sessionID())
  return (
    <Show when={phase() === "operating" || phase() === "recent"}>
      <span
        data-testid="browser-tab-badge"
        role="img"
        aria-label={i18n.t("own.browser.agentActive")}
        title={i18n.t("own.browser.agentActive")}
        style={{
          color: "var(--own-accent-text)",
          "margin-inline-start": "4px",
          "font-size": "9px",
          "vertical-align": "1px",
        }}
      >
        ●
      </span>
    </Show>
  )
}
