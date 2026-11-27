// Fallback page (05 §5.5): shown instead of own-web when the installed version (OWN_HOME\app\current.json →
// app\<version>) has no web\index.html (or nothing is installed), or its web carries another rpcHash. It calls no
// upstream IPC (the contract may differ); it reads only the shell's own `window.own` and, for its two buttons,
// `window.own.support` (feature-detected like own-web's mismatch screen does). Strings follow 03 §8
// "셸·렌더러 버전 불일치" (03 owns the wording). No [다시 확인]: main chose this page at start (the fallback root stays
// while the shell runs; only an installed UI follows the pointer on reload), so only a new start checks again.
// Dark like own-web by default (scheme.ts); index.html's CSS paints the tone main started the window in until this
// module sets `data-scheme` from own-web's stored choice.
import type { OwnShellApi } from "../preload/own-api"
import { COLOR_SCHEME_KEY, fallbackScheme } from "./scheme"

applyScheme()

function applyScheme() {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(COLOR_SCHEME_KEY)
  } catch {
    // Blocked storage: the default (dark).
  }
  const light = matchMedia("(prefers-color-scheme: light)")
  const apply = () => (document.documentElement.dataset.scheme = fallbackScheme(stored, light.matches))
  apply()
  if (stored === "system") light.addEventListener("change", apply)
}

const own = (window as { own?: OwnShellApi }).own
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null
const text = (id: string, value: string) => {
  const target = element(id)
  if (target) target.textContent = value
}
const status = (value: string, tone: "info" | "error" = "info") => {
  const target = element("status")
  if (!target) return
  target.textContent = value
  target.dataset.tone = tone
}

if (own) {
  text("shell", `${own.shell.version} · ${own.shell.rpcHash}`)
  const support = own.support
  const logs = element<HTMLButtonElement>("logs")
  const browser = element<HTMLButtonElement>("browser")
  if (logs && typeof support?.openLogs === "function") {
    logs.hidden = false
    logs.addEventListener("click", () => {
      void support.openLogs().then(
        (opened) => opened || status("로그 폴더를 열지 못했어요.", "error"),
        () => status("로그 폴더를 열지 못했어요.", "error"),
      )
    })
  }
  if (browser && typeof support?.openInBrowser === "function") {
    browser.hidden = false
    browser.addEventListener("click", () => {
      browser.disabled = true
      status("브라우저로 여는 중…")
      void support
        .openInBrowser()
        .then(
          (result) =>
            result.ok
              ? status("브라우저에서 열었어요.")
              : status(`브라우저로 열지 못했어요: ${result.detail}`, "error"),
          (error: unknown) => status(`브라우저로 열지 못했어요: ${String(error)}`, "error"),
        )
        .finally(() => (browser.disabled = false))
    })
  }
  void own.shell.renderer.then((renderer) => {
    if (renderer.source !== "fallback") return
    document.documentElement.dataset.reason = renderer.reason
    if (renderer.reason === "missing") {
      text("title", "Own OpenCode가 설치되지 않았어요")
      text(
        "body",
        "설치된 버전을 찾지 못했어요(%LOCALAPPDATA%\\own-open-code\\app\\current.json). 설치 파일을 다시 실행하거나 " +
          "PowerShell에서 own status로 확인한 뒤 다시 여세요.",
      )
      text("ui", renderer.uiVersion ?? "없음")
      // Nothing to open in a browser without an installed service.
      if (browser) browser.hidden = true
      element("hint")?.remove()
      return
    }
    text("ui", `${renderer.uiVersion ?? "?"} · ${renderer.uiRpcHash ?? "?"}`)
  })
}
