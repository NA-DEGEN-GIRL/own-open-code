export * as SearchKey from "./search-key.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/**
 * Keys of the web search services that take the user's own key (02 §9.2, SP 2026-10-19, SK 2026-10-23): Brave's, and
 * those of core's five keyless services (Exa, Firecrawl, Parallel, Tavily, TinyFish). Each is a feature item of own's
 * vault (DPAPI), never an account, never core's credential table and never an environment variable; own.accounts
 * reads it for that service's request only. `websearch.key.get` shows whether one is set, `websearch.key.set` (this
 * PC only) stores or removes it.
 */

/** The services whose key own keeps, in the order `websearch.key.get` lists them. */
export const Service = Schema.Literals(["brave", "exa", "firecrawl", "parallel", "tavily", "tinyfish"]).annotate({
  identifier: "Own.SearchKey.Service",
})
export type Service = typeof Service.Type

/**
 * Core's keyless services that own also asks with the user's key, under an id of its own ({@link providerID}): core
 * keeps the keyless one, which stays free, and core's own key method stores keys in plain text (SK 2026-10-23).
 */
export const KEYED = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"] as const satisfies readonly Service[]
export type Keyed = (typeof KEYED)[number]

export function isKeyed(service: string): service is Keyed {
  return (KEYED as readonly string[]).includes(service)
}

/** The web search service that searches with the key: `brave`, else own's keyed variant `own-<service>`. */
export function providerID(service: Service) {
  return service === "brave" ? service : (`own-${service}` as const)
}

/** The vault item of a service's key. Never `acc_…`, so it can never be taken for an account's credential. */
export function keyID(service: Service) {
  return `websearch-${service}` as const
}

/** API keys are short; anything longer is a paste mistake. */
export const MAX_KEY_CHARS = 512

/** Whether a service has its key. `keyHint` is its last four characters (`…a1B2`), never the key. */
export interface KeyState extends Schema.Schema.Type<typeof KeyState> {}
export const KeyState = Schema.Struct({
  service: Service,
  configured: Schema.Boolean,
  keyHint: optional(Schema.String),
}).annotate({ identifier: "Own.SearchKey.KeyState" })

/** `websearch.key.get` and `websearch.key.set` result. */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  /** One row per service, in {@link Service}'s order. */
  keys: Schema.Array(KeyState),
  /** `unavailable`: the vault helper does not answer, so key states are unknown. */
  vault: Schema.Literals(["ok", "unavailable"]),
}).annotate({ identifier: "Own.SearchKey.View" })

/** `key: null` removes the service's key. The key goes only into the vault and never comes back. */
export interface SetInput extends Schema.Schema.Type<typeof SetInput> {}
export const SetInput = Schema.Struct({
  service: Service,
  key: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_KEY_CHARS))),
}).annotate({ identifier: "Own.SearchKey.SetInput" })
