export * as SearchKeyRpc from "./search-key.js"

import { SearchKey } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: web search services (02 §9.2, SP 2026-10-19, SK 2026-10-23). The keys of services that take the user's own
 * key (Brave, and Exa, Firecrawl, Parallel, Tavily and TinyFish for own's keyed variants) are feature items of own's
 * vault (`websearch-<service>`, DPAPI), like the voice-only keys: never an account, never core's credential table,
 * never in a log, an event or an RPC answer (only whether one is set and its last four characters). Storing or
 * removing one tells every Location to fold the web search services again (`searchKey.changed`).
 */
export type Methods = "websearch.key.get" | "websearch.key.set"

/** Keys are pasted: printable ASCII without spaces. Anything else is a paste mistake, not a key. */
const KEY_PATTERN = /^[\x21-\x7e]+$/

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const log = deps.log.child("websearch")
  const credentials = deps.runtime.credentials
  const view = async (): Promise<SearchKey.View> => {
    const keys = await Promise.all(
      SearchKey.Service.literals.map(async (service) => ({
        service,
        state: await credentials.inspectFeatureKey(SearchKey.keyID(service)),
      })),
    )
    return {
      keys: keys.map((key) => ({
        service: key.service,
        configured: key.state.configured,
        ...(key.state.keyHint ? { keyHint: key.state.keyHint } : {}),
      })),
      vault: keys.some((key) => key.state.problem === "vault_unavailable") ? "unavailable" : "ok",
    }
  }
  return {
    "websearch.key.get": async () => view(),
    "websearch.key.set": async (input, context) => {
      const id = SearchKey.keyID(input.service)
      const key = input.key?.trim()
      if (key !== undefined && !KEY_PATTERN.test(key))
        return context.error("websearch_key_invalid", "not a key: empty, or holds spaces or control characters", {})
      const stored =
        key === undefined ? await credentials.removeFeatureKey(id) : await credentials.storeFeatureKey(id, key)
      if (!stored.ok) {
        log.warn("websearch_key_vault_failed", { service: input.service, problem: stored.problem })
        return context.error("vault_unavailable", "the vault did not answer", {})
      }
      // Never the key or its hint: only which service and whether it is set now.
      log.info("websearch_key_set", { service: input.service, configured: key !== undefined })
      deps.runtime.broadcast.emit("searchKey.changed", { service: input.service })
      return view()
    },
  }
}
