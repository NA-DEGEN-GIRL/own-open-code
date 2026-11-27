// Per-window layout state (03 §3: outside the route, never in the URL; 4.2: saved in browser storage, defaults when
// storage fails). Widths change only CSS variables while dragging (R7).
import { createStore } from "solid-js/store"

export type PanelTab = "review" | "files" | "terminal" | "browser" | "accounts" | "team"
export const PANEL_TABS: readonly PanelTab[] = ["review", "files", "terminal", "browser", "accounts", "team"]

export interface LayoutState {
  /** User widths; `undefined` follows the tier default. */
  sidebarWidth?: number
  panelWidth?: number
  /** Push-mode panel (wide/desk). Overlay modes open per interaction and are never persisted. */
  panelOpen?: boolean
  /** Column-mode sidebar hidden with Ctrl+B (wide/desk/compact). */
  sidebarCollapsed?: boolean
  /** Last tab per session key `serverKey/sessionID` (4.7 "마지막 탭은 세션별로 기억한다"). */
  panelTab: Record<string, PanelTab>
  /** Settings > Layout > 터미널 위치 (4.7.3). */
  terminalPlacement: "tab" | "bottom"
}

const SAVE_DELAY = 300

export function createLayoutState(windowKey: string) {
  const key = `own.web.layout.${windowKey}`
  const [state, setState] = createStore<LayoutState>({ panelTab: {}, terminalPlacement: "tab", ...load(key) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(state))
      } catch {}
    }, SAVE_DELAY)
  }
  return {
    state,
    setSidebarWidth(width: number) {
      setState("sidebarWidth", Math.round(width))
      save()
    },
    setPanelWidth(width: number) {
      setState("panelWidth", Math.round(width))
      save()
    },
    setPanelOpen(open: boolean) {
      setState("panelOpen", open)
      save()
    },
    setSidebarCollapsed(collapsed: boolean) {
      setState("sidebarCollapsed", collapsed)
      save()
    },
    setPanelTab(sessionKey: string, tab: PanelTab) {
      setState("panelTab", sessionKey, tab)
      save()
    },
    setTerminalPlacement(placement: LayoutState["terminalPlacement"]) {
      setState("terminalPlacement", placement)
      save()
    },
  }
}

export type LayoutStore = ReturnType<typeof createLayoutState>

function load(key: string): Partial<LayoutState> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (typeof value !== "object" || value === null) return {}
    const read = value as Partial<LayoutState>
    return {
      sidebarWidth: typeof read.sidebarWidth === "number" ? read.sidebarWidth : undefined,
      panelWidth: typeof read.panelWidth === "number" ? read.panelWidth : undefined,
      panelOpen: typeof read.panelOpen === "boolean" ? read.panelOpen : undefined,
      sidebarCollapsed: read.sidebarCollapsed === true ? true : undefined,
      panelTab:
        typeof read.panelTab === "object" && read.panelTab !== null
          ? Object.fromEntries(
              Object.entries(read.panelTab).filter((entry): entry is [string, PanelTab] =>
                PANEL_TABS.includes(entry[1] as PanelTab),
              ),
            )
          : {},
      terminalPlacement: read.terminalPlacement === "bottom" ? "bottom" : "tab",
    }
  } catch {
    return {}
  }
}
