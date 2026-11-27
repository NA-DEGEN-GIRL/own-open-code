// Where a dsh session's runtime-context snapshots sit in its history (request.ts). dsh appends a snapshot as a durable
// message when the context changes, so later requests keep it where it was; own adds dsh's messages at request time,
// so this plugin keeps each snapshot's place (the message it follows) and text in its storage, per session. A snapshot
// whose message left the history (a compaction) is no longer placed; the next request places the current one again.
export * as DshSnapshots from "./snapshots.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import type { DshRequest } from "./request.js"

/** Snapshots kept per session; older ones belong to history a compaction already replaced. */
const KEEP = 16

const Stored = Schema.Struct({
  snapshots: Schema.Array(Schema.Struct({ after: Schema.String, text: Schema.String })),
})

const key = (sessionID: string) => `dsh/context/${sessionID}`

export function read(ctx: Pick<Context, "storage">, sessionID: string) {
  return ctx.storage.get(key(sessionID)).pipe(
    Effect.map((value) => Schema.decodeUnknownOption(Stored)(value)),
    Effect.map(
      (decoded): ReadonlyArray<DshRequest.Snapshot> => (decoded._tag === "Some" ? decoded.value.snapshots : []),
    ),
    Effect.orElseSucceed((): ReadonlyArray<DshRequest.Snapshot> => []),
  )
}

export function add(ctx: Pick<Context, "storage">, sessionID: string, snapshot: DshRequest.Snapshot) {
  return read(ctx, sessionID).pipe(
    Effect.flatMap((current) =>
      ctx.storage.set(key(sessionID), {
        snapshots: [...current, snapshot].slice(-KEEP).map((entry) => ({ after: entry.after, text: entry.text })),
      }),
    ),
    Effect.ignore,
  )
}

export function forget(ctx: Pick<Context, "storage">, sessionID: string) {
  return ctx.storage.remove(key(sessionID)).pipe(Effect.ignore)
}
