// Ports Codex's `clock` tools (codex-rs/core/src/tools/handlers/sleep.rs, current_time.rs and
// core/src/context/current_time_reminder.rs): `clock.sleep` waits, ending early when new input arrives for the session,
// and `curr_time` answers the time as Codex's reminder. Ported from openai/codex (Apache-2.0) @ rust-v0.162.1; input
// already pending when a sleep starts ends it at once since rust-v0.164.0 (#55644).
export * as Clock from "./clock.js"

/** `MAX_SLEEP_DURATION_MS`: 12 hours. */
const MAX_SLEEP_DURATION_MS = 12 * 60 * 60 * 1000

/** Sessions with input waiting, so a sleep ends early (Codex's `input_queue` activity). */
export class Activity {
  private readonly waiters = new Map<string, Set<() => void>>()

  /** New input for the session (own: `session.inbox.enqueued`). */
  notify(sessionID: string) {
    const waiters = this.waiters.get(sessionID)
    this.waiters.delete(sessionID)
    waiters?.forEach((wake) => wake())
  }

  wait(sessionID: string) {
    return new Promise<void>((resolve) => {
      const waiters = this.waiters.get(sessionID) ?? new Set<() => void>()
      waiters.add(resolve)
      this.waiters.set(sessionID, waiters)
    })
  }

  forget(sessionID: string, wake: () => void) {
    this.waiters.get(sessionID)?.delete(wake)
  }
}

/**
 * `clock.sleep`: Codex's answer text, or its validation error. `pending`: input already reached the running turn and
 * waits for its next step, which interrupts the sleep before it starts.
 */
export async function sleep(activity: Activity, sessionID: string, durationMs: number, pending = false) {
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > MAX_SLEEP_DURATION_MS)
    return `duration_ms must be between 1 and ${MAX_SLEEP_DURATION_MS}`
  const started = performance.now()
  const interrupted =
    pending ||
    (await Promise.race([
      activity.wait(sessionID).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), durationMs)),
    ]))
  const seconds = (performance.now() - started) / 1000
  return `Wall time: ${seconds.toFixed(4)} seconds\n${interrupted ? "Sleep interrupted by new input." : "Sleep completed."}`
}

/** `curr_time`: `<current_time_reminder>It is YYYY-MM-DD HH:MM:SS UTC.</current_time_reminder>`. */
export function currentTime(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`
  return `<current_time_reminder>It is ${time}.</current_time_reminder>`
}
