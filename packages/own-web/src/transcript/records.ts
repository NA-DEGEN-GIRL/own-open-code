// Router `switch.recorded` events (02 §9.3) collected per session, so a switch marker can show the method, reason,
// estimate and measured cost next to the durable `model-switched` message (03 §4.5). The router keeps no queryable
// history of these, so markers of switches made before this window opened show only what the messages carry.
import type { ModelRef } from "@opencode/client/promise"
import type { Estimate, Switch } from "@own/protocol"
import { createStore, produce } from "solid-js/store"
import type { OwnStore } from "@/data"
import { sameRef, type SwitchMarker } from "./markers"

export interface SwitchRecord {
  readonly from: ModelRef | null
  readonly to: ModelRef
  readonly strategy: Estimate.Strategy
  readonly reason: Switch.Reason
  readonly estimate: Estimate.Delta | null
  readonly actual?: { readonly cold: number; readonly unit: Estimate.Unit }
  readonly at: number
}

const PER_SESSION = 20
/** A record belongs to the marker whose durable switch is closest in time, within this window. */
const MATCH_WINDOW_MS = 5 * 60_000

export function createSwitchRecords(own: OwnStore) {
  const [records, setRecords] = createStore<Record<string, SwitchRecord[]>>({})
  const stop = own.on("switch.recorded", (event) => {
    const data = event.data
    const record: SwitchRecord = {
      from: data.from,
      to: data.to,
      strategy: data.strategy,
      reason: data.reason,
      estimate: data.estimate,
      actual: data.actual,
      at: event.created,
    }
    setRecords(
      produce((draft) => {
        const list = (draft[data.sessionID] ??= [])
        // The router sends the record again with `actual` after the first step (02 §9.3): merge, keep the time.
        const index = list.findIndex(
          (item) => sameRef(item.to, record.to) && sameRef(item.from ?? undefined, record.from ?? undefined),
        )
        const previous = index >= 0 ? list[index] : undefined
        if (previous && record.actual && !previous.actual && record.at - previous.at < MATCH_WINDOW_MS) {
          list[index] = { ...previous, actual: record.actual }
          return
        }
        list.push(record)
        if (list.length > PER_SESSION) list.splice(0, list.length - PER_SESSION)
      }),
    )
  })
  return {
    match: (sessionID: string, marker: SwitchMarker) => matchRecord(records[sessionID], marker),
    dispose: stop,
  }
}

export type SwitchRecords = ReturnType<typeof createSwitchRecords>

export function matchRecord(records: readonly SwitchRecord[] | undefined, marker: SwitchMarker) {
  return records
    ?.filter((record) => sameRef(record.to, marker.to) && Math.abs(record.at - marker.at) <= MATCH_WINDOW_MS)
    .reduce<
      SwitchRecord | undefined
    >((best, record) => (!best || Math.abs(record.at - marker.at) < Math.abs(best.at - marker.at) ? record : best), undefined)
}
