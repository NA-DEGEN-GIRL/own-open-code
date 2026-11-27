// The models a failed compaction falls back to (own/docs/11 §3): the user's ordered list from Settings, kept in this
// plugin's storage, or, until the user chooses, an automatic choice by model preference (plugin option
// `compactionFallback`). The account whose compaction failed never stands in for itself, and only the first few are
// asked so a failing compaction does not wait on a long list.
export * as Fallback from "./fallback.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Model } from "@opencode/schema/model"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect, Schema } from "effect"

const KEY = "compaction/fallback"

/** Stand-ins asked at most per failed compaction. */
export const LIMIT = 3

type Ctx = Pick<Context, "model" | "storage">

const Stored = Schema.Struct({ models: Schema.Array(OwnHarness.FallbackModel) })

/** The models to ask, in order, when `failing`'s compaction fails: enabled catalog entries only. */
export function pick<Entry extends { readonly providerID: string; readonly id: string; readonly enabled: boolean }>(
  entries: ReadonlyArray<Entry>,
  chosen: ReadonlyArray<OwnHarness.FallbackModel> | undefined,
  preferred: ReadonlyArray<string>,
  failing?: string,
) {
  const usable = (entry: Entry) => entry.enabled && entry.providerID !== failing
  const ordered =
    chosen === undefined
      ? preferred.flatMap((id) => entries.filter((entry) => usable(entry) && entry.id === id))
      : chosen.flatMap((model) =>
          entries.filter((entry) => usable(entry) && entry.providerID === model.providerID && entry.id === model.modelID),
        )
  return ordered.slice(0, LIMIT)
}

/** The fallback models for a compaction of `model`, as the compaction hook names them (P-025). */
export function standIns(ctx: Ctx, preferred: ReadonlyArray<string>, model: Model.Ref) {
  return Effect.gen(function* () {
    const entries = yield* catalog(ctx)
    const chosen = yield* stored(ctx)
    return pick(entries, chosen, preferred, model.providerID).map((entry) => ({
      providerID: entry.providerID,
      id: entry.id,
    }))
  })
}

/** What Settings shows: the user's list, or what the automatic choice finds among the accounts now. */
export function view(ctx: Ctx, preferred: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const chosen = yield* stored(ctx)
    if (chosen !== undefined) return { automatic: false, models: chosen }
    const entries = yield* catalog(ctx)
    return {
      automatic: true,
      models: pick(entries, undefined, preferred).map((entry) => ({ providerID: entry.providerID, modelID: entry.id })),
    }
  })
}

/** `null` returns to the automatic choice. */
export function save(ctx: Ctx, models: ReadonlyArray<OwnHarness.FallbackModel> | null) {
  return models === null ? ctx.storage.remove(KEY) : ctx.storage.set(KEY, { models: models.map((model) => ({ ...model })) })
}

function stored(ctx: Ctx) {
  return ctx.storage.get(KEY).pipe(
    Effect.map((value) => Schema.decodeUnknownOption(Stored)(value)),
    Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value.models : undefined)),
  )
}

function catalog(ctx: Ctx) {
  return ctx.model.list().pipe(
    Effect.map((list) => list.data),
    Effect.orElseSucceed(() => []),
  )
}
