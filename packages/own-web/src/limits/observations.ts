// Recent observations of each limit window, for the dashboard's "현재 속도면 약 N 뒤 한도 도달 (추정)" line (03 §5.5:
// slope of the last 30 minutes, hidden with fewer than 3 observations). The router keeps only the latest window, so
// the points are collected here from `quota.updated` while the accounts/limits chunk is loaded. Memory only, bounded.
import type { Limit } from "@own/protocol"
import { createSignal } from "solid-js"
import type { OwnStore } from "@/data"

const KEEP_MS = 30 * 60_000
const MAX_POINTS = 60

export interface Point {
  readonly at: number
  readonly percent: number
}

const series = new Map<string, Point[]>()
const attached = new WeakSet<OwnStore>()
const [version, setVersion] = createSignal(0)

function key(accountID: string, windowID: string) {
  return `${accountID}\u0000${windowID}`
}

export function record(windows: readonly Limit.Window[]) {
  const changed = windows.filter((window) => {
    if (window.usedPercent === undefined || window.kind !== "rolling_quota") return false
    const list = series.get(key(window.accountID, window.id)) ?? []
    if (list.at(-1)?.at === window.observedAt) return false
    list.push({ at: window.observedAt, percent: window.usedPercent })
    const fresh = list.filter((point) => window.observedAt - point.at <= KEEP_MS).slice(-MAX_POINTS)
    series.set(key(window.accountID, window.id), fresh)
    return true
  })
  if (changed.length) setVersion((value) => value + 1)
}

/** Starts collecting for a store once (idempotent) and seeds the current snapshot. */
export function observe(own: OwnStore) {
  if (attached.has(own)) return
  attached.add(own)
  record(Object.values(own.state.quota).flat())
  own.on("quota.updated", (event) => record(event.data.windows))
}

/** Reactive: re-read when a new observation lands. */
export function points(accountID: string, windowID: string): readonly Point[] {
  version()
  return series.get(key(accountID, windowID)) ?? []
}

/** Tests only. */
export function reset() {
  series.clear()
  setVersion(0)
}
