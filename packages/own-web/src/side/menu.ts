// The conversation `⋯`'s `곁질문…` (03 §4.4.2): the touch way in (a phone has no `/btw` habit and no palette key),
// loaded with the menu's lazy items (shell/session-menu-lazy.ts), so it costs the first chunk nothing.
import type { ServerRuntime } from "@/data"
import type { Locale } from "@/i18n"
import type { MenuItem } from "@/servers/menu"
import { openSide } from "./intents"

export function sideMenuItems(input: {
  readonly runtime: ServerRuntime
  readonly sessionID: string
  readonly locale: Locale
}): MenuItem[] {
  if (!input.runtime.rpc.allowed("side.ask")) return []
  return [
    {
      label: input.locale === "en" ? "Side question…" : "곁질문…",
      onSelect: () => openSide({ serverKey: input.runtime.key, sessionID: input.sessionID }),
      testid: "session-menu-side",
    },
  ]
}
