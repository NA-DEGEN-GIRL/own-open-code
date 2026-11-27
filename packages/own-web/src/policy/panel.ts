// The browser tool line of the server status popover (03 §4.3, 01 §10.1): this window's creation rule, or the state of
// the session on screen. Apart from strings.ts and notice.tsx because only the lazy popover (mcp/server-panel.tsx)
// reads it: nothing in the first chunk may import this module, so its words stay out of it (PF5).
import { catalogText, useCatalogText } from "@/projects/text"
import { browserPaneHeld, type BrowserHost, type BrowserToolState } from "./browser"

export const panelKo = {
  "own.policy.browser.windowOff": "이 창에서 만드는 대화: 브라우저 도구 없음",
  "own.policy.browser.windowOn": "이 창에서 만드는 대화: 브라우저 도구 있음",
  "own.policy.browser.sessionOff": "이 대화: 브라우저 도구 없음(만들 때 꺼짐)",
  "own.policy.browser.sessionNoPane": "이 대화: 브라우저 도구 있음 — 이 창에서는 동작하지 않음",
  // A paired device (05 §8.10.5): the PC's desktop app holds the browser, whatever window shows the conversation.
  "own.policy.browser.sessionNoDesktop": "이 대화: 브라우저 도구 있음 — PC의 데스크톱 앱이 켜져 있어야 동작함",
  "own.policy.browser.sessionOn": "이 대화: 브라우저 도구 있음",
} as const satisfies Record<string, string>

export type PanelKey = keyof typeof panelKo

export const panelEn: Record<PanelKey, string> = {
  "own.policy.browser.windowOff": "Sessions from this window: no browser tool",
  "own.policy.browser.windowOn": "Sessions from this window: browser tool included",
  "own.policy.browser.sessionOff": "This session: no browser tool (off at creation)",
  "own.policy.browser.sessionNoPane": "This session: browser tool listed — not usable in this window",
  "own.policy.browser.sessionNoDesktop": "This session: browser tool listed — needs the desktop app running on the PC",
  "own.policy.browser.sessionOn": "This session: browser tool included",
}

export const panelText = catalogText(panelKo, panelEn)

export function usePanelText() {
  return useCatalogText(panelText)
}

/**
 * The line: the given session's state (notice.tsx `useSessionBrowserTool`), or without one what a session created here
 * starts with (rule 1: `browserPaneHeld`, so a paired device reads as the PC's desktop app does while that runs).
 */
export function browserPolicyLine(state: BrowserToolState | undefined, host: BrowserHost): PanelKey {
  if (state === "removed") return "own.policy.browser.sessionOff"
  if (state === "no-pane")
    return host.remotePane ? "own.policy.browser.sessionNoDesktop" : "own.policy.browser.sessionNoPane"
  if (state === "available") return "own.policy.browser.sessionOn"
  return browserPaneHeld(host) ? "own.policy.browser.windowOn" : "own.policy.browser.windowOff"
}
