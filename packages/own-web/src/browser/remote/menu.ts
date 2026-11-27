// The conversation `⋯` entry `브라우저` on a paired device (05 §8.10): the session's browser pane on the PC, shown on
// this device. It arrives with the menu's lazy items (shell/session-menu-lazy.ts), so the first chunk holds neither
// its code nor its words. A window with its own pane (the desktop app) keeps its header button and gets no entry;
// neither does a PC's own browser window, which is not a device of the gateway and has no viewer socket.
// Always there for a device, also one without the `브라우저` permission: the view then says how to turn it on.
import type { DataLayer } from "@/data"
import type { Locale } from "@/i18n"
import type { MenuItem } from "@/servers/menu"
import type { Shell } from "@/shell/context"

/** The words the entry and the dock's hint need before the viewer's own chunk (and its string table) is loaded. */
export const ENTRY_TEXT: Record<Locale, { readonly open: string; readonly using: string }> = {
  ko: { open: "브라우저", using: "브라우저 사용 중 · 보기" },
  en: { open: "Browser", using: "Browser in use · View" },
}

/** A paired device without a pane of its own: the only kind of window the viewer is for. */
export function viewerHost(input: { readonly data: DataLayer; readonly shell: Shell }) {
  return !input.shell.shownView("browser") && input.data.local().entry()?.auth === "device"
}

export function remoteBrowserItems(input: {
  readonly data: DataLayer
  readonly shell: Shell
  readonly locale: Locale
}): MenuItem[] {
  if (!viewerHost(input)) return []
  return [
    {
      label: ENTRY_TEXT[input.locale].open,
      onSelect: () => input.shell.setBrowserView(true),
      testid: "session-menu-browser",
    },
  ]
}
