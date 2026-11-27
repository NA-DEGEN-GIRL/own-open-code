export * as HarnessText from "./harness.js"

import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Creator } from "@own/protocol/creator"
import { Portable } from "@own/protocol/portable"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Fsx } from "@own/runtime"
import { Effect, Schema } from "effect"
import type { CreatorStore } from "./store.js"

/**
 * `harness.instructions` items (17 §6.4): a harness's 내 지시문 is one text own.harness keeps for every project, so an
 * extension takes it over rather than adding to it. The first time an extension provides a harness's text, the text
 * the user had (or none) is kept in `creator\harness.json`; it is put back when no extension in force provides one
 * any more (turned off, removed, rolled back). This runs after each write, in the instance that wrote; own.harness'
 * RPC does the saving, so its checks and its storage stay the only ones.
 */

const Takeover = Schema.Struct({ extension: Schema.String, previous: Schema.NullOr(Schema.String) })
const File = Schema.Record(Schema.String, Takeover)
type File = typeof File.Type
const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(File))

type Ctx = Pick<Context, "rpc" | "location">

export interface Outcome {
  readonly changed: ReadonlyArray<string>
  /** own.harness did not answer (not loaded here); nothing was changed and the takeovers stay as they were. */
  readonly unavailable: boolean
}

export const sync = (ctx: Ctx, store: CreatorStore.Store, snapshot: CreatorStore.Snapshot) =>
  Effect.gen(function* () {
    const file = path.join(store.root, "harness.json")
    const text = yield* Effect.promise(() => Fsx.readText(file).catch(() => undefined))
    const decoded = text === undefined ? undefined : decodeFile(text)
    const takeovers: File = decoded !== undefined && decoded._tag === "Some" ? decoded.value : {}
    const wanted = new Map(
      snapshot.loaded.flatMap((loaded) =>
        loaded.status !== "active" || loaded.extension === undefined
          ? []
          : loaded.extension.items.flatMap((item) =>
              item.type === "harness.instructions"
                ? [[item.harness, { id: loaded.entry.id, text: item.text }] as const]
                : [],
            ),
      ),
    )
    const next: Record<string, { extension: string; previous: string | null }> = { ...takeovers }
    const changed: string[] = []
    for (const harness of OwnHarness.CUSTOM_HARNESSES) {
      const want = wanted.get(harness)
      const held = takeovers[harness]
      if (want === undefined && held === undefined) continue
      const read = yield* saved(ctx, harness)
      if (!read.ok) return { changed, unavailable: true } satisfies Outcome
      const current = read.text
      if (want !== undefined) {
        if (held === undefined) next[harness] = { extension: want.id, previous: current ?? null }
        else next[harness] = { ...held, extension: want.id }
        if (current !== want.text) {
          yield* set(ctx, harness, want.text)
          changed.push(harness)
        }
        continue
      }
      if (held === undefined) continue
      if (current !== (held.previous ?? undefined)) {
        yield* set(ctx, harness, held.previous)
        changed.push(harness)
      }
      delete next[harness]
    }
    if (JSON.stringify(next) !== JSON.stringify(takeovers))
      yield* Effect.promise(() => Fsx.writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`))
    return { changed, unavailable: false } satisfies Outcome
  }).pipe(Effect.catchCause(() => Effect.succeed({ changed: [], unavailable: true } satisfies Outcome)))

/** own.harness' client, through its portable definition (the host validates with this bundle's schemas). */
const client = (ctx: Ctx) => ctx.rpc(Portable.definition(OwnHarness.Definition))

/** The harness's saved 내 지시문 (undefined when none), or not `ok` when own.harness does not answer. */
function saved(ctx: Ctx, harness: OwnHarness.CustomHarnessID) {
  return client(ctx)
    ["prompt.preview"]({ harness, prompt: "custom" })
    .pipe(
      Effect.map((preview) => ({ ok: true as const, text: preview.custom?.text })),
      Effect.orElseSucceed(() => ({ ok: false as const })),
    )
}

function set(ctx: Ctx, harness: OwnHarness.CustomHarnessID, text: string | null) {
  return client(ctx)
    ["prompt.custom.set"]({ harness, text: text === null ? null : text.slice(0, Creator.LIMITS.harnessInstructions) })
    .pipe(Effect.ignore)
}
