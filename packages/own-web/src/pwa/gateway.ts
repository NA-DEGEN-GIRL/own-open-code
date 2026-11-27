// The device side of the own-remote gateway's own endpoints (05 §13.4, §13.5, §13.9 M1): who this device is, the
// servers it may reach, and the pairing handshake. Same-origin fetches only; the device credential is the gateway's
// HttpOnly cookie, which this code never sees. What is remembered locally (`own.web.device`) is the non-secret part of
// `/own/device` (name, scopes, servers, control location), so the offline list can paint with the right scopes.

/** `<meta name="own-gateway">`, added by the gateway to the page it serves (never on the PC's origins). */
export function onGateway() {
  return typeof document === "object" && document.querySelector('meta[name="own-gateway"]') !== null
}

export type DeviceScope = "read" | "prompt" | "switch" | "files" | "terminal" | "browser" | "admin"

export interface DeviceInfo {
  readonly deviceId: string
  readonly name: string
  readonly kind: "pwa" | "app" | "browser"
  readonly scopes: readonly DeviceScope[]
  readonly servers: { readonly mode: "all" } | { readonly mode: "only"; readonly keys: readonly string[] }
  readonly expiresAt: number
  readonly controlDir: string
  /** The name of the PC the service runs on, which view-only notices name (06 §9.8); absent from older gateways. */
  readonly pc?: string
}

export interface GatewayServer {
  readonly serverKey: string
  readonly name: string
  /** `/srv/<serverKey>` (04 §12.1 path prefix). */
  readonly baseUrl: string
  readonly controlDir: string | null
  readonly state: string
}

export type Probe =
  | { readonly kind: "ok"; readonly device: DeviceInfo }
  /** 401: never paired, revoked, or expired (`reason` from the gateway). */
  | { readonly kind: "unauthorized"; readonly reason: "device_unauthorized" | "device_revoked" | "device_expired" }
  /** No answer (offline, PC asleep): use what is remembered. */
  | { readonly kind: "offline" }

const DEVICE_KEY = "own.web.device"

export async function probeDevice(timeoutMs = 4000): Promise<Probe> {
  const response = await fetch("/own/device", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined)
  if (!response) return { kind: "offline" }
  if (response.status === 401) {
    const body = (await response.json().catch(() => ({}))) as { type?: string }
    const reason =
      body.type === "device_revoked" || body.type === "device_expired" ? body.type : ("device_unauthorized" as const)
    return { kind: "unauthorized", reason }
  }
  if (!response.ok) return { kind: "offline" }
  const device = (await response.json().catch(() => undefined)) as DeviceInfo | undefined
  if (!device || typeof device.deviceId !== "string") return { kind: "offline" }
  remember(device)
  return { kind: "ok", device }
}

export function rememberedDevice(): DeviceInfo | undefined {
  try {
    const text = localStorage.getItem(DEVICE_KEY)
    const value = text ? (JSON.parse(text) as DeviceInfo) : undefined
    return value && typeof value.deviceId === "string" && Array.isArray(value.scopes) ? value : undefined
  } catch {
    return undefined
  }
}

function remember(device: DeviceInfo) {
  try {
    // Non-secret fields only (the token is an HttpOnly cookie).
    const { deviceId, name, kind, scopes, servers, expiresAt, controlDir, pc } = device
    localStorage.setItem(
      DEVICE_KEY,
      JSON.stringify({ deviceId, name, kind, scopes, servers, expiresAt, controlDir, pc }),
    )
  } catch {}
}

export function forgetDevice() {
  try {
    localStorage.removeItem(DEVICE_KEY)
  } catch {}
}

/** `GET /own/servers` (05 §13.4 6): the servers this device may see, with their path prefix and control location. */
export async function gatewayServers(): Promise<readonly GatewayServer[]> {
  const response = await fetch("/own/servers", { credentials: "same-origin", cache: "no-store" })
  if (!response.ok) throw new Error(`gateway servers: ${response.status}`)
  const body = (await response.json()) as { servers?: GatewayServer[] }
  return body.servers ?? []
}

export type PairingState =
  | { readonly state: "pending"; readonly sas: string; readonly name: string; readonly expiresAt: number }
  | { readonly state: "approved"; readonly name: string; readonly expiresAt: number }
  | { readonly state: "none" | "rejected" | "expired" | "cancelled" | "claimed" | "unknown" }

/** The pairing this browser opened with the QR link (claim cookie), if any. */
export async function pairingState(): Promise<PairingState> {
  const response = await fetch("/own/pairing", { credentials: "same-origin", cache: "no-store" }).catch(() => undefined)
  if (!response?.ok) return { state: "unknown" }
  return (await response.json().catch(() => ({ state: "unknown" }))) as PairingState
}

/** Finishes an approved pairing: the gateway sets the device cookie. */
export async function claimPairing(kind: "pwa" | "browser") {
  const response = await fetch("/own/pairing/claim", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  })
  return response.ok
}

/**
 * Inside our Android app or another PC's desktop app (08 §3.4 user agent `OwnOpenCodeApp/1`): the page came through
 * the pinned-TLS app listener, the app owns pairing, and Android's WebView refuses service workers on a pinned origin.
 */
export function inOwnApp() {
  return typeof navigator === "object" && /OwnOpenCodeApp\/\d+/.test(navigator.userAgent)
}

/** Installed to the home screen (display-mode standalone). */
export function standalone() {
  return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches
}
