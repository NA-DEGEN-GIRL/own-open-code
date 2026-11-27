// Web host: the web fallback (`own open --browser`, same-origin cookie) and the Vite dev server (proxy injects
// Basic). T0 per 05 §6.3 "웹 구현": no rpcHash check, connect() is the page origin, ready/setChrome are no-ops
// beyond the theme-color meta, openExternal is a new tab.
import type { HostCapabilities, HostConnection, OwnHost } from "./types"

const CONTROL_KEY = "own.web.controlDir"

export function createWebHost(): OwnHost {
  const capabilities: HostCapabilities = {
    windowControlsOverlay: false,
    nativeDirectoryPicker: false,
    nativeFilePaths: false,
    openInApp: false,
    clipboardImage: false,
    saveDialog: false,
    osNotifications: typeof Notification === "function" ? "web" : "none",
    browserPane: false,
    serviceControl: false,
    multiWindow: false,
    keepScreenAwake: false,
    touch: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    offlineCatalog: false,
  }
  const connect = async (): Promise<HostConnection> => ({
    baseUrl: location.origin,
    auth: import.meta.env.DEV ? "injected" : "cookie",
    controlDir: controlDir(),
  })
  return {
    kind: "web",
    capabilities,
    connect,
    reconnect: connect,
    ready() {},
    setChrome(theme) {
      document.querySelector("meta[name='theme-color']")?.setAttribute("content", theme.background)
    },
    openExternal(url) {
      if (!/^(https?:|mailto:)/i.test(url)) return
      window.open(url, "_blank", "noopener,noreferrer")
    },
    window: {
      focus: () => window.focus(),
      show: () => window.focus(),
      isFocused: () => document.hasFocus(),
    },
    notify(input) {
      if (typeof Notification !== "function" || Notification.permission !== "granted") return
      const notification = new Notification(input.title, { body: input.body, tag: input.tag, silent: true })
      notification.onclick = () => {
        window.focus()
        input.onClick?.()
        notification.close()
      }
    },
  }
}

/**
 * The launcher passes the control location as `#control=<encoded path>` (02 §9.1). The fragment is dropped once
 * read so it does not follow navigation; the value survives reloads in sessionStorage. Dev uses OWN_WEB_CONTROL_DIR.
 */
function controlDir() {
  const fragment = new URLSearchParams(location.hash.slice(1)).get("control")
  if (fragment) {
    remember(fragment)
    history.replaceState(history.state, "", location.pathname + location.search)
    return fragment
  }
  return recall() ?? (import.meta.env.OWN_DEV_CONTROL_DIR || undefined)
}

function remember(value: string) {
  try {
    sessionStorage.setItem(CONTROL_KEY, value)
  } catch {}
}

function recall() {
  try {
    return sessionStorage.getItem(CONTROL_KEY) ?? undefined
  } catch {
    return undefined
  }
}
