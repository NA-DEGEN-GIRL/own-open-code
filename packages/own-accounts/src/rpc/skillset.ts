export * as SkillsetRpc from "./skillset.js"

import type { Deps } from "../deps.js"
import { SkillsetService } from "../skillset/service.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: the skill switches and scopes (03 §19.6.1, SG 2026-10-26). The logic is `SkillsetService`; these handlers
 * turn its declared failure into `skillset_invalid` and anything thrown into `internal_error`, like `McpRpc`. Global
 * methods at the control Location. A remote service refuses them (`REMOTE_MANAGED`): an SSH host's skills are its
 * own folders.
 */
export type Methods = "skillset.view" | "skillset.switch"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const service = SkillsetService.create(deps)
  return {
    "skillset.view": (input, context) =>
      service.view(input).catch((error: unknown) => context.error("internal_error", message(error), {})),
    "skillset.switch": async (input, context) => {
      const result = await service
        .change(input)
        .catch((error: unknown): SkillsetService.Answer<never> | Error =>
          error instanceof Error ? error : new Error(String(error)),
        )
      if (result instanceof Error) return context.error("internal_error", result.message, {})
      if (result.ok) return result.value
      return context.error("skillset_invalid", result.error.message, { field: result.error.field })
    },
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
