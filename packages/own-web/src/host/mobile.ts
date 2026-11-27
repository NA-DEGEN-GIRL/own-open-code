// Mobile host (05 §13.9 M1): the web host for a page the own-remote gateway served to a paired device (a phone
// browser or the installed PWA). What it adds to `web`:
// - `connect()` → the local server behind the gateway's path prefix (`<origin>/srv/local`, 04 §12.1), `auth: "device"`
//   (the gateway's HttpOnly cookie), the control location and the device's scopes from `GET /own/device` (05 §13.4).
// - No credential (never paired, revoked, expired): `DeviceAuthRequiredError`, and the entry shows the pairing screen.
// - Offline (PC asleep, airplane mode): the remembered device info, so the cached list paints and the data layer's
//   reconnect loop takes over (05 §13.7); `reconnect()` asks again and reloads into the pairing screen on a 401.
// - The service worker for the app shell (src/pwa/register.ts), on this origin only (05 §13.6 "서비스 워커").
// - `remotePane` (05 §8.10.5 rule 1): whether the PC's desktop app is running, which decides if a conversation created
//   here starts with the agent's browser tools. All of it stays in this chunk; the first chunk only asks
//   `host.remotePane?.available()`.
import type { OwnAccounts } from "@own/protocol"
import { createSignal } from "solid-js"
import { probeDevice, rememberedDevice, type DeviceInfo } from "@/pwa/gateway"
import { registerServiceWorker } from "@/pwa/register"
import { DeviceAuthRequiredError, type HostConnection, type HostRemotePane, type OwnHost } from "./types"
import { createWebHost } from "./web"

const OWN_SCOPES: ReadonlySet<string> = new Set(["read", "prompt", "switch", "admin"])
/** How often a visible page asks again whether the PC's desktop app is there. */
export const PANE_STATUS_MS = 60_000

export async function createMobileHost(): Promise<OwnHost> {
  // The QR link lands on `/pair` (the gateway set the claim cookie): the pairing screen, even in a paired browser.
  if (location.pathname === "/pair") throw new DeviceAuthRequiredError("device_unauthorized")
  const probe = await probeDevice()
  if (probe.kind === "unauthorized") throw new DeviceAuthRequiredError(probe.reason)
  let device: DeviceInfo | undefined = probe.kind === "ok" ? probe.device : rememberedDevice()
  registerServiceWorker()
  const web = createWebHost()
  const pane = createRemotePane(() => (device ? desktopRunning(device.controlDir) : Promise.resolve(false)))
  const connection = (): HostConnection => ({
    baseUrl: `${location.origin}/srv/local`,
    auth: "device",
    controlDir: device?.controlDir,
    // `files`/`terminal` guard upstream HTTP at the gateway; own-web's RPC scopes are the `own.accounts` ones.
    scopes: (device?.scopes ?? ["read"]).filter((scope) => OWN_SCOPES.has(scope)) as OwnAccounts.Scope[],
    ...(device?.pc ? { pc: device.pc } : {}),
    deviceScopes: device?.scopes ?? ["read"],
  })
  return {
    ...web,
    kind: "mobile",
    capabilities: {
      ...web.capabilities,
      touch: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
      offlineCatalog: true,
    },
    remotePane: pane,
    connect: async () => connection(),
    async reconnect() {
      const next = await probeDevice()
      if (next.kind === "unauthorized") {
        // Revoked or expired while open (MG4): the entry shows why on the next load.
        window.location.replace("/")
        throw new DeviceAuthRequiredError(next.reason)
      }
      if (next.kind === "ok") device = next.device
      void pane.refresh()
      return connection()
    },
  }
}

/**
 * The last answer of `read` (`false` before the first one and after a failure). Read now, on `refresh()` (the host's
 * reconnect), when the page becomes visible and every {@link PANE_STATUS_MS} while it is: the desktop app starts and
 * quits without telling a device, and a hidden page asks nothing.
 */
export function createRemotePane(
  read: () => Promise<boolean>,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
): HostRemotePane & { refresh(): Promise<void>; dispose(): void } {
  const [available, setAvailable] = createSignal(false)
  let latest = 0
  const refresh = async () => {
    const mine = ++latest
    const desktop = await read().catch(() => false)
    // An answer a later read overtook is stale (a slow one from before the app quit).
    if (mine === latest) setAvailable(desktop)
  }
  const whileVisible = () => {
    if (page.visibilityState === "visible") void refresh()
  }
  page.addEventListener("visibilitychange", whileVisible)
  const timer = setInterval(whileVisible, PANE_STATUS_MS)
  void refresh()
  return {
    available,
    refresh,
    dispose() {
      page.removeEventListener("visibilitychange", whileVisible)
      clearInterval(timer)
    },
  }
}

/**
 * own.remote `browser.status` (`read` scope) at the device's control location, through the gateway: `desktop`. A plain
 * same-origin request like src/pwa/gateway.ts makes, because the host exists before the data layer and its client; the
 * shape is the client's `rpc.call` (`location[directory]` in the query, `{input}` as the body).
 */
export async function desktopRunning(controlDir: string, request: typeof fetch = fetch) {
  const response = await request(
    `/srv/local/api/rpc/own.remote/browser.status?${new URLSearchParams({ "location[directory]": controlDir })}`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
      signal: AbortSignal.timeout(4000),
    },
  )
  if (!response.ok) return false
  const body = (await response.json()) as { readonly output?: { readonly desktop?: unknown } }
  return body.output?.desktop === true
}
