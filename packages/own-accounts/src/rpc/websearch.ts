export * as WebSearchRpc from "./websearch.js"

import { Fsx } from "@own/runtime"
import type { Approval } from "@own/protocol"
import type { Deps } from "../deps.js"
import { CoreConfig } from "../slots/core-config.js"
import { MultiSearch } from "../websearch/multi.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: SLOTS' core config (03 §18.2). The server's web search service is core's `websearch` key in own's global
 * config, so the user can choose it once in settings instead of answering the first-use form in the middle of a task.
 * It reads and writes `opencode.jsonc`, plus which listed services use the user's own key (core's integrations; never
 * the key itself) and the selection of `여러 서비스 함께` (`own-multi`, own's KV row `websearch:multi`, MS 2026-10-19).
 * A service must be one the server lists; own never picks one. `default` removes the key, so own's default
 * (`own-chatgpt` while a ChatGPT account is there, 02 §9.2) applies again. `multi` stores its services when given
 * (each listed now, never `own-multi` itself) and writes `{provider:"own-multi"}`; the stored selection stays when
 * another choice is saved, so switching back keeps it.
 */
export type Methods = "websearch.get" | "websearch.set"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  return {
    "websearch.get": async (_input, context) => {
      if (!deps.configDir) return context.error("websearch_unavailable", "no own config directory", unavailable)
      const text = await Fsx.readText(CoreConfig.file(deps.configDir)).catch(() => null)
      if (text === null) return context.error("websearch_unavailable", "opencode.jsonc cannot be read", unavailable)
      return state(deps, text === undefined ? undefined : CoreConfig.webSearchOf(text))
    },
    "websearch.set": async (input, context) => {
      if (!deps.configDir) return context.error("websearch_unavailable", "no own config directory", unavailable)
      const choice = input.choice
      const wanted = choice.type === "service" ? [choice.id] : choice.type === "multi" ? (choice.services ?? []) : []
      if (wanted.length > 0) {
        const listed = await deps.ctx.websearch.providers().then(
          (providers) => providers.data.map((provider) => provider.id),
          () => [] as string[],
        )
        const unknown = wanted.find((id) => !listed.includes(id) || (choice.type === "multi" && id === MultiSearch.ID))
        if (unknown !== undefined)
          return context.error("websearch_unavailable", `no search service ${unknown}`, {
            reason: "unknown_service",
            id: unknown,
          })
      }
      if (choice.type === "multi" && choice.services) await MultiSearch.store(deps, [...new Set(choice.services)])
      const written = await CoreConfig.writeWebSearch(deps.configDir, choice).catch(() => undefined)
      if (!written?.ok) return context.error("websearch_unavailable", "opencode.jsonc cannot be written", unavailable)
      deps.log.info("websearch_set", {
        choice: choice.type,
        ...(choice.type === "multi" && choice.services ? { services: choice.services.length } : {}),
      })
      return state(deps, choice.type === "default" ? undefined : choice.type === "multi" ? { type: "multi" } : choice)
    },
  }
}

const unavailable = { reason: "config_unavailable" as const }

/** The answer: the choice, the services with the user's key, and what `여러 서비스 함께` asks. */
async function state(deps: Deps, choice: Approval.WebSearchChoice | undefined): Promise<Approval.WebSearchState> {
  const [keys, listed] = await Promise.all([
    MultiSearch.readKeys(deps),
    deps.ctx.websearch.providers().then(
      (providers) => providers.data.map((provider) => provider.id).filter((id) => id !== MultiSearch.ID),
      () => undefined,
    ),
  ])
  const multi = listed && (await MultiSearch.selection(deps, listed, keys))
  return { ...(choice ? { choice } : {}), ...(keys ? { keys } : {}), ...(multi ? { multi } : {}) }
}
