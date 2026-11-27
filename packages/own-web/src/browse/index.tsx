// 내 브라우저 사용 in the conversation UI (BRW). Small and in the first chunk:
// - `BrowseLayer`, mounted once by the shell: the per-conversation dialog (lazy chunk);
// - `useBrowseMenu`, the conversation `⋯` item "이 대화에서 내 브라우저 사용…" that opens it.
// The item is for this PC's top-level conversations only, in a PC window (`browse.set` is `local`), and only while the
// setting is on (`browse.status`, asked when the menu opens) or the conversation still has it on (to turn it off).
// The settings page (settings.tsx) and the dialog (dialog.tsx) stay in their lazy chunks.
import { lazy, Show, Suspense } from "solid-js"
import { LOCAL, useData, type ServerKey } from "@/data"
import type { MenuItem } from "@/servers/menu"
import { useBrowseMenuText } from "./menu-strings"
import { browseDialog, browseOf, browseStatus, closeBrowseDialog, openBrowseDialog, refreshBrowseStatus } from "./state"

export { browseOf, openBrowseDialog } from "./state"

const BrowseDialog = lazy(() => import("./dialog"))

export function BrowseLayer() {
  return (
    <Show when={browseDialog()}>
      {(request) => (
        <Suspense>
          <BrowseDialog sessionID={request().sessionID} onClose={closeBrowseDialog} />
        </Suspense>
      )}
    </Show>
  )
}

export function useBrowseMenu(serverKey: () => ServerKey, sessionID: () => string | undefined) {
  const data = useData()
  const text = useBrowseMenuText()
  return {
    prepare() {
      if (serverKey() === LOCAL) void refreshBrowseStatus(data.local().rpc)
    },
    items(): MenuItem[] {
      const id = sessionID()
      if (!id || serverKey() !== LOCAL) return []
      const runtime = data.local()
      const info = runtime.data.session.get(id)
      if (!info || info.parentID || !runtime.rpc.allowed("session.approval.set")) return []
      const on = browseOf(info.permissions) === "on"
      if (!on && (browseStatus()?.enabled !== true || !runtime.rpc.allowed("browse.set"))) return []
      return [
        {
          label: text("own.browse.menu"),
          onSelect: () => openBrowseDialog({ sessionID: id }),
          testid: "session-menu-browse",
        },
      ]
    },
  }
}
