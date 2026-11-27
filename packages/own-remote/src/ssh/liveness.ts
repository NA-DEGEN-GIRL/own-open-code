export * as Liveness from "./liveness.js"

import { ServiceTarget } from "@own/runtime"

/**
 * How own-remote notices a half-dead link (04 §6.3 "죽은 링크"): a Wi-Fi switch, a sleeping PC or a dropped router or
 * LTE link sends no FIN or RST, so the tunnel's ssh and every `-L` connection inside it look alive until something
 * notices the silence.
 *
 * The first line is ssh's own keepalive. ssh asks the server for an answer once it has received nothing for
 * `interval` seconds and exits (255, `Timeout, server … not responding.`) at the `countMax + 1`-th check, so a fully
 * silent link ends the tunnel `(countMax + 1) × interval` seconds after its last received byte. Any received byte
 * resets that timer: a large transfer or a long model reply keeps it quiet, and an upload only needs the server's
 * channel window adjustments (one per three packets it consumed). Only ssh sees those bytes; a request of our own
 * through the tunnel would queue behind a large transfer and declare a slow but alive link dead.
 *
 * The second line is a probe after the service process was frozen (the PC slept): the clock jumps, and a link that
 * died during the sleep would otherwise wait out ssh's timer again after the wake.
 */
export const SERVER_ALIVE_INTERVAL = 4
export const SERVER_ALIVE_COUNT_MAX = 2
/** The longest a fully silent link keeps its tunnel: ssh's last check after its last received byte. */
export const SILENT_LIMIT_MS = (SERVER_ALIVE_COUNT_MAX + 1) * SERVER_ALIVE_INTERVAL * 1000

/** The controller's clock tick: a tick this late means the process did not run in between (sleep, hibernation). */
export const TICK_MS = 2000
export const RESUME_GAP_MS = 8000
/** How long a probe after a wake waits for any answer through the tunnel. */
export const PROBE_MS = 4000
/**
 * After a live tunnel dropped by itself, `connection` failures keep retrying at the backoff cap for this long before
 * the usual pause after five failures (04 §6.3): a quick notice must not turn a minute without network (a router
 * restart, a train tunnel, the Wi-Fi coming back after a wake) into a paused host.
 */
export const DROP_RETRY_MS = 10 * 60_000

export function resumed(previousTick: number, now: number) {
  return now - previousTick >= TICK_MS + RESUME_GAP_MS
}

/** Whether a `connection` failure after a drop at `droppedAt` keeps the host retrying past the five-failure pause. */
export function keepRetrying(droppedAt: number | undefined, now: number) {
  return droppedAt !== undefined && now - droppedAt < DROP_RETRY_MS
}

/** ssh's own text when its keepalive gave up (OpenSSH `server_alive_check`, Win32-OpenSSH alike). */
export function silentExit(stderr: string) {
  return /Timeout, server .* not responding/i.test(stderr)
}

/**
 * Whether anything answers through the tunnel within `timeoutMs`: any HTTP response counts (a 401 still crossed the
 * link and back), only a timeout or a refused or reset connection does not.
 */
export async function reachable(endpoint: { readonly url: string; readonly secret: string }, timeoutMs = PROBE_MS) {
  const response = await fetch(new URL("/api/info", endpoint.url), {
    headers: { authorization: ServiceTarget.basic(endpoint.secret) },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined)
  await response?.body?.cancel().catch(() => undefined)
  return response !== undefined
}
