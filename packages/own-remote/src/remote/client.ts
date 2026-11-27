export * as RemoteClient from "./client.js"

import { ServiceTarget } from "@own/runtime"

/**
 * own-remote's own HTTP client for a remote server over the `-L` tunnel (04 §5.7 "own-remote가 자기 HTTP client로
 * 부름"): readiness, active sessions for drain, and the `own.remote agent.*` methods at the remote control location
 * (04 §16.6). Authenticated with the remote service password (Basic), which never leaves this process.
 */
export interface Endpoint {
  readonly url: string
  readonly secret: string
  readonly controlDir: string
}

export async function info(endpoint: Pick<Endpoint, "url" | "secret">, timeoutMs = 2000) {
  const response = await fetch(new URL("/api/info", endpoint.url), {
    headers: { authorization: ServiceTarget.basic(endpoint.secret) },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined)
  if (!response || !response.ok) return undefined
  return (await response.json().catch(() => ({}))) as { readonly version?: string }
}

/**
 * Polls `GET /api/info` every 100 ms (2 s timeout each) until it answers or `deadlineMs` passes; the deadline is
 * extended while `extend()` is true (an auth prompt is open), like upstream `waitReady` (`controller.ts:344-365`).
 */
export async function waitReady(
  endpoint: Pick<Endpoint, "url" | "secret">,
  input: { readonly timeoutMs: number; readonly extend?: () => boolean; readonly signal?: AbortSignal },
) {
  let deadline = Date.now() + input.timeoutMs
  while (!input.signal?.aborted) {
    if (input.extend?.()) deadline = Date.now() + input.timeoutMs
    if (await info(endpoint)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/** `GET /api/session/active` (04 §6.4, surface `session-active-endpoint`): ids of running sessions, or `null`. */
export async function activeSessions(endpoint: Pick<Endpoint, "url" | "secret">) {
  const response = await fetch(new URL("/api/session/active", endpoint.url), {
    headers: { authorization: ServiceTarget.basic(endpoint.secret) },
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined)
  if (!response || !response.ok) return null
  const body = (await response.json().catch(() => undefined)) as { readonly data?: Record<string, unknown> } | undefined
  if (!body || typeof body.data !== "object" || body.data === null) return null
  return Object.keys(body.data)
}

export type RpcResult<T> =
  | { readonly ok: true; readonly output: T }
  | { readonly ok: false; readonly type: string; readonly message: string; readonly data?: unknown }

/**
 * `POST /api/rpc/own.remote/<method>?location[directory]=<controlDir>` with `{input}` (surface `rpc-http-route`). A host
 * service loads its plugins in the background (upstream v2.4.0 #63814; RPCs stopped waiting for them in v2.2.7 #62796),
 * so `rpc.unavailable` right after a start is asked again within the same time budget.
 */
export async function call<T>(endpoint: Endpoint, method: string, input: unknown, timeoutMs = 10_000): Promise<RpcResult<T>> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const result = await callOnce<T>(endpoint, method, input, Math.max(1000, deadline - Date.now()))
    if (result.ok || result.type !== "rpc.unavailable" || Date.now() + 250 >= deadline) return result
    await Bun.sleep(250)
  }
}

async function callOnce<T>(endpoint: Endpoint, method: string, input: unknown, timeoutMs: number): Promise<RpcResult<T>> {
  const url = new URL(`/api/rpc/own.remote/${method}`, endpoint.url)
  url.searchParams.set("location[directory]", endpoint.controlDir)
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: ServiceTarget.basic(endpoint.secret), "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error: unknown) => error)
  if (!(response instanceof Response)) return { ok: false, type: "unreachable", message: String(response) }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (response.ok) return { ok: true, output: body?.output as T }
  return {
    ok: false,
    type: typeof body?.type === "string" ? body.type : `http_${response.status}`,
    message: typeof body?.message === "string" ? body.message : "",
    ...(body?.data !== undefined ? { data: body.data } : {}),
  }
}
