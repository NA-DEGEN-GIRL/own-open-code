// The app side of the gateway's native pairing and route refresh (08 §3.5, §3.6), over a transport that already goes
// through the PC's partition (proxy + pin): `ses.fetch` in the shell, a pinned fetch in tests. Responses are
// validated here, at the boundary; callers get typed values or a RemotePcError. Electron-free so tests run under bun.
import { cleanName, cleanRoutes, PC_KEY, PIN } from "../../shared/remote-pc"

export type RemotePcErrorCode =
  | "invalid_link"
  | "expired"
  | "rejected"
  | "cancelled"
  | "rate_limited"
  | "unreachable"
  | "pin_mismatch"
  | "key_changed"
  | "aborted"
  | "failed"

export class RemotePcError extends Error {
  override readonly name = "RemotePcError"
  constructor(
    readonly code: RemotePcErrorCode,
    /** Non-secret detail for the log and the dialog (an HTTP status, a gateway state). */
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

export interface TransportInit {
  readonly method?: "GET" | "POST"
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly signal?: AbortSignal
}

/**
 * One request to the PC's app origin (`path` starts with `/`). Network failures throw a RemotePcError
 * (`unreachable`, `pin_mismatch`, `aborted`, `failed`): only the transport knows which happened.
 */
export type Transport = (path: string, init: TransportInit) => Promise<Response>

export interface OpenedPairing {
  /** The claim secret (`x-own-pairing`); stays in main. */
  readonly claim: string
  /** The confirmation number the PC shows. */
  readonly sas: string
  /** Approval deadline, epoch ms. (The response's `name` is the device name the PC chose, not the PC's.) */
  readonly expiresAt: number
}

export interface DeviceCredential {
  readonly deviceId: string
  /** The device token; goes straight into the partition's cookie store. */
  readonly token: string
  readonly expiresAt: number
}

export type RoutesResult =
  | {
      readonly kind: "ok"
      readonly pcKey: string
      readonly pin: string
      readonly name: string
      readonly routes: readonly string[]
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly status: number }

export const POLL_INTERVAL_MS = 1_000
/** Polls that may fail in a row (a route flapping) before the pairing gives up as unreachable. */
const POLL_FAILURES = 3

/** `GET /auth/connect/<code>` as an app (`Accept: application/json`): consumes the code, starts the SAS step. */
export async function openPairing(transport: Transport, code: string, signal?: AbortSignal): Promise<OpenedPairing> {
  const response = await transport(`/auth/connect/${encodeURIComponent(code)}`, {
    headers: { accept: "application/json" },
    signal,
  })
  if (response.status === 410) throw new RemotePcError("expired")
  if (response.status === 429) throw new RemotePcError("rate_limited")
  if (!response.ok) throw new RemotePcError("failed", `HTTP ${response.status}`)
  const body = await bodyOf(response)
  if (
    typeof body.claim !== "string" ||
    body.claim.length === 0 ||
    body.claim.length > 512 ||
    typeof body.sas !== "string" ||
    !/^[0-9A-Za-z]{1,16}$/.test(body.sas) ||
    typeof body.expiresAt !== "number"
  )
    throw new RemotePcError("failed", "unexpected pairing response")
  return { claim: body.claim, sas: body.sas, expiresAt: body.expiresAt }
}

/** Polls `GET /own/pairing` until the PC approves; throws for every other ending (rejected, expired, …). */
export async function awaitApproval(
  transport: Transport,
  claim: string,
  options: { readonly signal?: AbortSignal; readonly intervalMs?: number } = {},
) {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS
  let failures = 0
  for (;;) {
    const response = await transport("/own/pairing", {
      headers: { accept: "application/json", "x-own-pairing": claim },
      signal: options.signal,
    }).catch((error: unknown) => {
      if (!(error instanceof RemotePcError) || error.code !== "unreachable" || ++failures >= POLL_FAILURES) throw error
      return undefined
    })
    if (response) {
      failures = 0
      const state = await pairingState(response)
      if (state === "approved") return
      if (state === "rejected" || state === "expired" || state === "cancelled") throw new RemotePcError(state)
      if (state !== "pending" && state !== "waiting" && state !== "rate_limited")
        throw new RemotePcError("failed", `pairing ${state}`)
    }
    await sleep(interval, options.signal)
  }
}

/** `POST /own/pairing/claim` once approved: the device credential. */
export async function claimDevice(
  transport: Transport,
  claim: string,
  signal?: AbortSignal,
): Promise<DeviceCredential> {
  const response = await transport("/own/pairing/claim", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-own-pairing": claim },
    body: "{}",
    signal,
  })
  if (response.status === 410 || response.status === 401) throw new RemotePcError("expired")
  if (!response.ok) throw new RemotePcError("failed", `HTTP ${response.status}`)
  const body = await bodyOf(response)
  if (
    typeof body.deviceId !== "string" ||
    body.deviceId.length === 0 ||
    body.deviceId.length > 128 ||
    typeof body.token !== "string" ||
    body.token.length === 0 ||
    body.token.length > 1024 ||
    typeof body.expiresAt !== "number"
  )
    throw new RemotePcError("failed", "unexpected claim response")
  return { deviceId: body.deviceId, token: body.token, expiresAt: body.expiresAt }
}

/** `GET /own/routes` with the device token (08 §3.6). */
export async function fetchRoutes(transport: Transport, token: string, signal?: AbortSignal): Promise<RoutesResult> {
  const response = await transport("/own/routes", {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal,
  })
  if (response.status === 401) return { kind: "unauthorized" }
  if (!response.ok) return { kind: "unavailable", status: response.status }
  const body = await bodyOf(response).catch(() => undefined)
  const routes = Array.isArray(body?.routes)
    ? cleanRoutes(body.routes.filter((route): route is string => typeof route === "string"))
    : []
  if (
    !body ||
    typeof body.pcKey !== "string" ||
    !PC_KEY.test(body.pcKey) ||
    typeof body.pin !== "string" ||
    !PIN.test(body.pin) ||
    routes.length === 0
  )
    return { kind: "unavailable", status: response.status }
  return {
    kind: "ok",
    pcKey: body.pcKey,
    pin: body.pin,
    name: typeof body.name === "string" ? cleanName(body.name) : "",
    routes,
  }
}

/**
 * `POST /own/device/revoke` with the device token (08 §3.6a): the PC revokes this device like its own 폐기. `true`
 * when the PC confirmed; network failures throw like every transport call (the caller removes the PC anyway).
 */
export async function revokeDevice(transport: Transport, token: string, signal?: AbortSignal) {
  const response = await transport("/own/device/revoke", {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    signal,
  })
  if (!response.ok) return false
  const body = await bodyOf(response).catch(() => undefined)
  return body?.revoked === true
}

async function pairingState(response: Response) {
  if (response.status === 429) return "rate_limited"
  if (!response.ok) throw new RemotePcError("failed", `HTTP ${response.status}`)
  const body = await bodyOf(response)
  return typeof body.state === "string" ? body.state : "unknown"
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => undefined)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RemotePcError("failed", "unexpected response")
  return value as Record<string, unknown>
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new RemotePcError("aborted"))
    const done = () => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }
    const stop = () => {
      clearTimeout(timer)
      reject(new RemotePcError("aborted"))
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", stop, { once: true })
  })
}
