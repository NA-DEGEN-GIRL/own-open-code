// The harness and prompt variant a new top-level session gets when its creator names none (10 §3.8): the user's choice
// from Settings > 일반 (`defaults.set`), kept in this plugin's storage, or the plugin options until the user chooses.
// Every creator follows it: own-web on this PC, a phone or another PC, team mains, owners and peers.
export * as Defaults from "./defaults.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect, Schema } from "effect"

const KEY = "defaults"

/**
 * Only what the user changed from the plugin options: a field left at its option is not stored, so it follows the
 * plugin's default when that changes (H-D7 moved `prompt` to `own` on 2026-10-17). Settings sends both fields on every
 * change, the other row's shown value included. A record without `version` was written before 2026-10-17 with both
 * fields: its harness was chosen, but a harness change copied the then-default prompt `reference` into it, so only an
 * `own` prompt (never the default then) is kept from it.
 */
const Stored = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(2)),
  harness: Schema.optionalKey(OwnHarness.HarnessID),
  prompt: Schema.optionalKey(OwnHarness.PromptID),
})

export interface Defaults {
  readonly harness: OwnHarness.HarnessID
  readonly prompt: OwnHarness.PromptID
}

/** The stored choice over `options`; `options` alone when none is stored or it no longer decodes. */
export function read(ctx: Pick<Context, "storage">, options: Defaults) {
  return ctx.storage.get(KEY).pipe(
    Effect.map((value) => Schema.decodeUnknownOption(Stored)(value)),
    Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value : {})),
    Effect.map((stored) => ({
      harness: stored.harness ?? options.harness,
      prompt: (stored.version === 2 || stored.prompt === "own" ? stored.prompt : undefined) ?? options.prompt,
    })),
  )
}

/** Stores `value`, each field only where it differs from `options`. */
export function save(ctx: Pick<Context, "storage">, value: Defaults, options: Defaults) {
  return ctx.storage.set(KEY, {
    version: 2,
    ...(value.harness === options.harness ? {} : { harness: value.harness }),
    ...(value.prompt === options.prompt ? {} : { prompt: value.prompt }),
  })
}
