export * as SwitchInbox from "./inbox.js"

import { Option, Schema } from "effect"
import type { ServiceTarget } from "@own/runtime"

/** Requests to the own service give up after this. */
export const TIMEOUT_MS = 15_000

/** The fields of a `session.inbox.list` item this module reads. */
export interface Item {
  readonly id: string
  readonly type: string
}

/** A session's pending inbox items in enqueue order, or `undefined` when the service did not answer. */
export type Reader = (sessionID: string) => Promise<ReadonlyArray<Item> | undefined>

const decodeListed = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String, type: Schema.String })) }),
)

/**
 * Self-HTTP to the own service (06 §2.6: the plugin API lists no inbox): `GET /api/session/:id/inbox` for a session of
 * this Location (`location[directory]`), through an `@own/runtime` `ServiceTarget.Source` (the channel's registration
 * file in an installed build, `ServiceTarget.fixed` in source runs and tests). A 401 re-reads the source once. The
 * password goes only into `Authorization` of that loopback request.
 */
export function reader(source: () => ServiceTarget.Source, directory: string, timeoutMs = TIMEOUT_MS): Reader {
  const read = async (sessionID: string, retry: boolean): Promise<ReadonlyArray<Item> | undefined> => {
    const service = source()
    const target = await service.current().catch(() => undefined)
    if (!target) return undefined
    const url = new URL(`/api/session/${encodeURIComponent(sessionID)}/inbox`, target.url)
    url.searchParams.set("location[directory]", directory)
    const response = await fetch(url, {
      headers: { authorization: target.authorization },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined)
    if (!response) return undefined
    if (!response.ok) await response.body?.cancel().catch(() => {})
    if (response.status === 401 && retry) {
      service.invalidate()
      return read(sessionID, false)
    }
    if (!response.ok) return undefined
    return Option.getOrUndefined(decodeListed(await response.json().catch(() => undefined)))?.data
  }
  return (sessionID) => read(sessionID, true)
}
