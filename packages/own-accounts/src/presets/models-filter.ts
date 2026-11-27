export * as ModelsFilter from "./models-filter.js"

import { Schema } from "effect"
import type { Result } from "@opencode/plugin/promise/tool"
import { optional } from "@opencode/schema/schema"
import type { Access } from "./access.js"

/**
 * Core's `models` tool by its effective name: namespace `opencode` + `models`
 * (`packages/core/src/tool/plugin/opencode.ts`, `packages/core/src/tool/runtime.ts` `effectiveName`).
 */
export const TOOL = "opencode_models"

/** What the filter reads and writes of a tool `execute.after` event (`plugin/src/promise/tool.ts`). */
export type After = {
  readonly tool: string
  readonly sessionID: string
  readonly input: unknown
} & ({ readonly status: "completed"; result: Result } | { readonly status: "error" })

/** The tool's structured output (`ModelsOutput`); provider and model entries keep every field core gave them. */
const Listing = Schema.Struct({
  providers: Schema.Array(Schema.Struct({ id: Schema.String, models: Schema.Array(Schema.Unknown) })),
  total: Schema.Number,
  next: Schema.NullOr(Schema.Number),
})
const isListing = Schema.is(Listing)
const isPaging = Schema.is(Schema.Struct({ offset: optional(Schema.Number) }))

/**
 * `execute.after` of `opencode_models` (07 §5.4 "`models` 도구 거르기"): the listing keeps only the providers of A
 * (`Access.providers`: the main account's slot and the root preset's pinned targets that can run now), so other
 * accounts (another ChatGPT account, an API key the preset does not name) never reach the LLM.
 * - Core sorts the calling session's own provider first, then the others by id, and pages through that order. A page
 *   whose last provider was removed ends the listing (`next: null`) unless a kept provider can still come on a later
 *   page: the own provider (it comes first, so anything may follow it), or one whose id sorts after that provider.
 * - `total` counts the kept models up to this page (core's count includes removed providers; the full kept count is
 *   not known here).
 * The result loses its `content`, so core renders the text from the filtered output. A tool result is not part of the
 * request prefix, so this costs no cache. A main the filter cannot find (a failed lookup, a root without a stored
 * model), or a preset it cannot resolve, lists nothing: `providers: []`, `total: 0`, `next: null` (decision
 * 2026-10-02).
 */
export function create(access: Access.Api) {
  return async (event: After) => {
    if (event.tool !== TOOL || event.status !== "completed") return
    const listing: unknown = event.result.output
    if (!isListing(listing)) return
    const main = await access.main(event.sessionID).catch(() => undefined)
    const kept = main && (await access.providers(main).catch(() => undefined))
    const providers = listing.providers.filter((provider) => kept?.has(provider.id) === true)
    const listed = providers.reduce((sum, provider) => sum + provider.models.length, 0)
    const offset = kept && isPaging(event.input) ? (event.input.offset ?? 0) : 0
    const last = listing.providers.at(-1)?.id
    const more =
      main !== undefined &&
      kept !== undefined &&
      last !== undefined &&
      [...kept].some((id) => later(id, last, main.parent.providerID))
    const metadata = event.result.metadata
    event.result = {
      output: { ...listing, providers, total: offset + listed, next: more ? listing.next : null },
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
}

/** Whether provider `id` can be listed on a page after one that ends with `last` (core's order: `own` first, then by id). */
function later(id: string, last: string, own: string) {
  if (id === last || last === own) return true
  return id !== own && id.localeCompare(last) > 0
}
