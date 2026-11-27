export * as SessionRecord from "./record.js"

import { Effect, Option, Schema } from "effect"

const Checkpoint = Schema.Struct({ hash: Schema.String, claudeMessageID: Schema.optional(Schema.String) })
export type Checkpoint = typeof Checkpoint.Type
// OWN-PATCH(P-043) begin
// own (report §14.3): what own last verified or wrote of the transcript, so a resume can tell a file that changed under
// it: the prefix of the chain up to `last` holds `count` user and assistant messages with this digest.
const Seal = Schema.Struct({ last: Schema.String, count: Schema.Number, digest: Schema.String })
export type Seal = typeof Seal.Type
const Epoch = Schema.Struct({
  claudeSessionID: Schema.String,
  history: Schema.optional(Schema.Array(Checkpoint)),
  // After cancellation, Claude owns the partial reply; history ends at the input it received.
  interrupted: Schema.optional(Schema.Boolean),
  seal: Schema.optional(Seal),
  // The Claude Code version own wrote its entries for (report §14.6).
  version: Schema.optional(Schema.String),
})
export type Epoch = typeof Epoch.Type
const Record = Schema.Struct({
  ...Epoch.fields,
  // Conversations this one replaced (a context reset, a compaction, a branch), newest first: an undo that brings their
  // history back resumes them as they were. Their transcripts are kept while they are listed here.
  previous: Schema.optional(Schema.Array(Epoch)),
})
// OWN-PATCH(P-043) end
export type Record = typeof Record.Type

export interface Storage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: Record) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  // OWN-PATCH(P-043) begin
  // Lists saved records page by page with their values, so the transcripts none of them points to can be found and
  // removed (upstream reads only the keys).
  readonly scan: (options: {
    readonly prefix: string
    readonly after?: string
    readonly limit?: number
  }) => Effect.Effect<{
    readonly entries: readonly { readonly key: string; readonly value?: unknown }[]
    readonly next?: string
  }>
  // OWN-PATCH(P-043) end
}

export function make(storage: Storage) {
  return {
    get: Effect.fn("SessionRecord.get")(function* (sessionID: string, configDir?: string) {
      const saved = Schema.decodeUnknownOption(Record)(yield* storage.get(key(sessionID, configDir)))
      return Option.getOrUndefined(saved)
    }),
    set: (sessionID: string, record: Record, configDir?: string) => storage.set(key(sessionID, configDir), record),
    remove: Effect.fn("SessionRecord.remove")(function* (sessionID: string) {
      yield* storage.remove(key(sessionID))
      const folders = yield* storage.scan({ prefix: `${key(sessionID)}:` })
      for (const entry of folders.entries) yield* storage.remove(entry.key)
    }),
    // OWN-PATCH(P-043) begin
    // Every Claude session id a saved record points to (its conversation and the ones it keeps for an undo).
    referenced: Effect.fn("SessionRecord.referenced")(function* () {
      const ids = new Set<string>()
      let after: string | undefined
      while (true) {
        const page = yield* storage.scan({ prefix: "sessions/", after, limit: 500 })
        for (const entry of page.entries) {
          const saved = Option.getOrUndefined(Schema.decodeUnknownOption(Record)(entry.value))
          if (!saved) continue
          ids.add(saved.claudeSessionID)
          for (const epoch of saved.previous ?? []) ids.add(epoch.claudeSessionID)
        }
        if (!page.next) return ids
        after = page.next
      }
    }),
    // OWN-PATCH(P-043) end
  }
}

// Each Claude config folder has its own transcripts, so a chat keeps one record per folder.
function key(sessionID: string, configDir?: string) {
  return configDir ? `sessions/${sessionID}:${configDir}` : `sessions/${sessionID}`
}
