// Shell ↔ UI mismatch screen (05 §5.5 "렌더러 재검사", 03 §8 "셸·렌더러 버전 불일치"): own-web's own copy of the
// shell's fallback page, drawn by the entry when T0-0 refused the shell (another rpcHash, or no `window.own`), in
// place of the app. It loads no upstream IPC and reads only `window.own`: the versions, and for two of its buttons
// `window.own.support`, feature-detected because a shell of another contract may not have it. The window is
// frameless (WCO), so the top band is a drag region like the app's header. Plain DOM: nothing of the app (Solid
// providers, theme) is running on this path. Wording: 03 §8, in the stored language.
import type { OwnShellApi } from "../../../own-desktop/src/preload/own-api"
import { storedLocale } from "../i18n"
import type { ShellMismatchError } from "./types"

export const MISMATCH_TEXT = {
  title: "앱 셸과 화면 버전이 맞지 않아요",
  body: "데스크톱 앱을 다시 설치하거나 업데이트를 마치세요.",
  noShell: "이 창에는 데스크톱 셸의 연결(window.own)이 없어요. 데스크톱 앱을 다시 설치하세요.",
  hint: "그동안은 브라우저로 열 수 있어요. PowerShell:",
  shell: "셸",
  ui: "화면",
  retry: "다시 확인",
  browser: "브라우저로 열기",
  logs: "로그 폴더",
  opening: "브라우저로 여는 중…",
  opened: "브라우저에서 열었어요.",
  browserFailed: "브라우저로 열지 못했어요:",
  logsFailed: "로그 폴더를 열지 못했어요.",
} as const

const MISMATCH_EN: Readonly<Record<keyof typeof MISMATCH_TEXT, string>> = {
  title: "The app shell and the interface do not match",
  body: "Reinstall the desktop app or finish the update.",
  noShell: "This window has no connection to the desktop shell (window.own). Reinstall the desktop app.",
  hint: "Until then you can open it in a browser. PowerShell:",
  shell: "Shell",
  ui: "Interface",
  retry: "Check again",
  browser: "Open in a browser",
  logs: "Log folder",
  opening: "Opening in a browser…",
  opened: "Opened in the browser.",
  browserFailed: "Could not open it in a browser:",
  logsFailed: "Could not open the log folder.",
}

const MUTED = "color: var(--own-text-muted, #5c6168)"
const BUTTON =
  "font: inherit; color: inherit; background: var(--own-bg-subtle, #f6f6f7); " +
  "border: 1px solid var(--own-border, #d9dbe0); border-radius: 6px; padding: 5px 14px; cursor: pointer"

/**
 * Replaces `root`'s content with the mismatch screen. `own` is the page's `window.own` (absent on a bare shell).
 * Returns a function that removes it.
 */
export function showShellMismatch(root: HTMLElement, error: ShellMismatchError, own = shellApi()) {
  const words = storedLocale() === "en" ? MISMATCH_EN : MISMATCH_TEXT
  const support = own?.support
  const node = (tag: string, style?: string, text?: string) => {
    const element = document.createElement(tag)
    if (style) element.setAttribute("style", style)
    if (text !== undefined) element.textContent = text
    return element
  }
  const screen = node(
    "div",
    "position: fixed; inset: 0; background: var(--own-bg-subtle, #f6f6f7); color: var(--own-text, #1d1f22); " +
      "font-size: 14px; line-height: 1.6",
  )
  screen.dataset.testid = "shell-mismatch"
  // Frameless window (05 §7.1): the band under the WCO buttons moves the window.
  const band = node("div", "height: env(titlebar-area-height, 44px); -webkit-app-region: drag")
  band.dataset.testid = "shell-mismatch-drag"
  const main = node("main", "max-width: 560px; margin: 8vh auto 0; padding: 0 24px")
  const card = node(
    "section",
    "background: var(--own-bg-raised, #fff); border: 1px solid var(--own-border, #d9dbe0); border-radius: 10px; " +
      "padding: 20px 24px",
  )
  card.setAttribute("role", "alert")
  card.append(
    node("h1", "font-size: 18px; font-weight: 600; margin: 0 0 8px", words.title),
    node("p", `margin: 8px 0; ${MUTED}`, own ? words.body : words.noShell),
  )
  const hint = node("p", `margin: 8px 0; ${MUTED}`, `${words.hint} `)
  hint.append(node("code", "user-select: all; font-family: var(--own-font-mono, monospace)", "own open --browser"))
  card.append(hint)

  const versions = node(
    "dl",
    `display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 16px 0 0; ${MUTED}`,
  )
  const uiValue = node("dd", "margin: 0; font-family: var(--own-font-mono, monospace)", `? · ${error.ui}`)
  versions.append(
    node("dt", undefined, words.shell),
    node(
      "dd",
      "margin: 0; font-family: var(--own-font-mono, monospace)",
      own ? `${own.shell.version} · ${own.shell.rpcHash}` : "–",
    ),
    node("dt", undefined, words.ui),
    uiValue,
  )
  card.append(versions)
  // `renderer` is an own addition to window.own: an older shell has none, and the UI version stays "?".
  const renderer = own?.shell.renderer
  if (renderer && typeof renderer.then === "function")
    void renderer.then(
      (value) => {
        if (value.source === "installed" && value.uiVersion) uiValue.textContent = `${value.uiVersion} · ${error.ui}`
      },
      () => undefined,
    )

  const status = node("p", `min-height: 1.6em; margin: 12px 0 0; ${MUTED}`)
  status.setAttribute("role", "status")
  const say = (text: string, tone: "info" | "error" = "info") => {
    status.textContent = text
    status.dataset.tone = tone
    status.style.color = tone === "error" ? "var(--own-danger, #c93a3a)" : "var(--own-text-muted, #5c6168)"
  }
  const button = (action: string, label: string, onClick: (target: HTMLButtonElement) => void) => {
    const target = node("button", BUTTON, label) as HTMLButtonElement
    target.type = "button"
    target.dataset.action = action
    target.addEventListener("click", () => onClick(target))
    return target
  }
  const actions = node("div", "display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 0")
  actions.append(button("retry", words.retry, () => window.location.reload()))
  if (typeof support?.openInBrowser === "function")
    actions.append(
      button("browser", words.browser, (target) => {
        if (target.disabled) return
        target.disabled = true
        say(words.opening)
        void support
          .openInBrowser()
          .then(
            (result) =>
              result.ok ? say(words.opened) : say(`${words.browserFailed} ${result.detail}`, "error"),
            (failure: unknown) => say(`${words.browserFailed} ${String(failure)}`, "error"),
          )
          .finally(() => (target.disabled = false))
      }),
    )
  if (typeof support?.openLogs === "function")
    actions.append(
      button("logs", words.logs, () => {
        void support.openLogs().then(
          (opened) => opened || say(words.logsFailed, "error"),
          () => say(words.logsFailed, "error"),
        )
      }),
    )
  card.append(actions, status)
  main.append(card)
  screen.append(band, main)
  root.replaceChildren(screen)
  return () => screen.remove()
}

function shellApi() {
  return (window as { own?: OwnShellApi }).own
}
