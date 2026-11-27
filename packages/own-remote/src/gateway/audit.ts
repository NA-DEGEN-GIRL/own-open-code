export * as Audit from "./audit.js"

import fs from "node:fs/promises"
import path from "node:path"

/**
 * Gateway audit (05 §13.4 "감사"): per device, requests and refusals summed over 5-minute windows, with the last
 * address. Appended to `OWN_HOME\gateway\audit-YYYY-MM.jsonl` like the ops journal (04 §15). Never a body, a path
 * with ids, a header value or a token: `deviceId`, counts and the address only. The one dated line is a browser view
 * opening or closing (05 §8.10.2): the device, the session id and the time, never an address of a page or its content.
 */

export const WINDOW_MS = 5 * 60 * 1000
/** Notes kept for the next write; past it the oldest go (a device opening views in a loop). */
const MAX_NOTES = 1000

interface Bucket {
  requests: number
  denied: number
  unauthorized: number
  lastIp: string | null
}

export type NoteEvent = "browser_view_opened" | "browser_view_closed"

export class Journal {
  readonly dir: string
  readonly #now: () => number
  #windowStart: number
  readonly #buckets = new Map<string, Bucket>()
  #notes: string[] = []
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(input: { readonly ownHome: string; readonly now?: () => number; readonly intervalMs?: number }) {
    this.dir = path.join(input.ownHome, "gateway")
    this.#now = input.now ?? Date.now
    this.#windowStart = this.#now()
    this.#timer = setInterval(() => void this.flush(), input.intervalMs ?? WINDOW_MS)
    this.#timer.unref?.()
  }

  /** `deviceId` `null`: a request without a valid device (counted under `-`). */
  record(deviceId: string | null, ip: string | null, outcome: "ok" | "denied" | "unauthorized") {
    const key = deviceId ?? "-"
    const bucket = this.#buckets.get(key) ?? { requests: 0, denied: 0, unauthorized: 0, lastIp: null }
    bucket.requests++
    if (outcome === "denied") bucket.denied++
    if (outcome === "unauthorized") bucket.unauthorized++
    if (ip) bucket.lastIp = ip
    this.#buckets.set(key, bucket)
  }

  /** A browser view of a device opened or closed: written with the window's counts. */
  note(deviceId: string, event: NoteEvent, sessionID: string) {
    this.#notes = [...this.#notes.slice(1 - MAX_NOTES), JSON.stringify({ at: this.#now(), deviceId, event, sessionID })]
  }

  async flush() {
    if (this.#buckets.size === 0 && this.#notes.length === 0) {
      this.#windowStart = this.#now()
      return
    }
    const from = this.#windowStart
    const to = this.#now()
    const lines = [
      ...[...this.#buckets].map(([deviceId, bucket]) => JSON.stringify({ from, to, deviceId, ...bucket })),
      ...this.#notes,
    ]
    this.#buckets.clear()
    this.#notes = []
    this.#windowStart = to
    const file = path.join(this.dir, `audit-${new Date(to).toISOString().slice(0, 7)}.jsonl`)
    await fs.mkdir(this.dir, { recursive: true })
    await fs.appendFile(file, lines.join("\n") + "\n", { mode: 0o600 })
  }

  async close() {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    await this.flush().catch(() => undefined)
  }
}
