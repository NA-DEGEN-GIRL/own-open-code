// Pin/archive from outside the sidebar tree (03 §4.4 header `⋯` → 고정, 19.15 palette `session.pin/archive`): the same
// write, toasts and `보관 취소` as the row menu (row-menu.tsx), through the server tree's live flag store, so the
// sidebar updates at once. Unavailable (`undefined`) until the sidebar mounted that server's tree.
import { showToast } from "@/switcher/toast"
import { sessionFlags, type FlagKey } from "./flags"
import { useSidebarText, type SidebarKey } from "./strings"

const FAILED: Record<FlagKey, readonly [on: SidebarKey, off: SidebarKey]> = {
  pinned: ["own.sidebar.pinFailed", "own.sidebar.unpinFailed"],
  archived: ["own.sidebar.archiveFailed", "own.sidebar.unarchiveFailed"],
}

export function useSessionFlagActions() {
  const text = useSidebarText()
  async function toggle(serverKey: string, sessionID: string, key: FlagKey, on: boolean, title: string) {
    const store = sessionFlags(serverKey)
    if (!store) return
    const ok = await store.set(sessionID, key, on)
    if (!ok) return void showToast({ message: text(FAILED[key][on ? 0 : 1]), tone: "danger" })
    if (key !== "archived") return
    if (!on) return void showToast({ message: text("own.sidebar.unarchived", { title }) })
    showToast({
      message: text("own.sidebar.archived", { title }),
      action: {
        label: text("own.sidebar.archivedUndo"),
        run: () => void toggle(serverKey, sessionID, key, false, title),
      },
    })
  }
  return {
    /** `undefined` while the server's tree is not mounted (no store to write through). */
    state(serverKey: string, sessionID: string) {
      const store = sessionFlags(serverKey)
      return store ? { pinned: store.pinned(sessionID), archived: store.archived(sessionID) } : undefined
    },
    toggle,
    label: (
      key:
        | "own.sidebar.pin"
        | "own.sidebar.unpin"
        | "own.sidebar.archive"
        | "own.sidebar.unarchive"
        | "own.sidebar.delete"
        | "own.sidebar.deleteSession"
        | "own.sidebar.archiveOpen",
    ) => text(key),
  }
}
