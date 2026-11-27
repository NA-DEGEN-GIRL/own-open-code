// Host selection. `kind` comparisons are allowed only in src/host/ (03 §16.7); everything else reads
// `capabilities` and the helpers below.
import { createContext, useContext } from "solid-js"
import { createWebHost } from "./web"
import type { OwnHost } from "./types"

export type { ChromeTheme, HostCapabilities, HostConnection, OwnHost } from "./types"
export { DeviceAuthRequiredError, HostUnavailableError } from "./types"

export async function createHost(): Promise<OwnHost> {
  if (typeof window === "object" && "electron" in window) {
    const { createDesktopHost } = await import("./desktop")
    return createDesktopHost()
  }
  // A page the own-remote gateway served to a paired device (05 §13.9 M1): the mobile host, its own chunk.
  if (typeof document === "object" && document.querySelector('meta[name="own-gateway"]')) {
    const { createMobileHost } = await import("./mobile")
    return createMobileHost()
  }
  return createWebHost()
}

/**
 * Router implementation per host (01 §6.2): the desktop `oc://renderer` handler has no SPA fallback, so desktop
 * uses a memory router keyed by window; web and mobile use path routing. Route names are the same in both.
 */
export function routerMode(host: OwnHost): "path" | "memory" {
  return host.kind === "desktop" ? "memory" : "path"
}

/** Key for per-window state (desktop: `window.electron.windowID`; web: one per tab). */
export function windowKey(host: OwnHost): string {
  if (host.kind !== "desktop") return "web"
  const electron = (window as { electron?: { windowID?: unknown } }).electron
  return typeof electron?.windowID === "string" || typeof electron?.windowID === "number"
    ? `desktop:${electron.windowID}`
    : "desktop"
}

const HostContext = createContext<OwnHost>()
export const HostProvider = HostContext.Provider

export function useHost() {
  const host = useContext(HostContext)
  if (!host) throw new Error("useHost() needs <HostProvider>")
  return host
}
