export * as CodexModelsRpc from "./codex-models.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: SLOTS (07 §4.5, CA 2026-10-19). Which Codex version the ChatGPT accounts' model lists are asked as, the
 * setting `Codex 최신 모델 자동 확인`, and the rows own left out, answered by the Codex metadata module of the control
 * Location (the one that fetches). This PC's: a remote service answers `remote_managed` (`Register.REMOTE_MANAGED`).
 * `codexModels.rows` hands own.harness the served rows it runs from (10 §6.14), from any Location's copy.
 */
export type Methods = "codexModels.get" | "codexModels.set" | "codexModels.rows"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "codexModels.get": async () => modules.codexMeta.view(),
    "codexModels.set": (input) => modules.codexMeta.setAutoVersion(input.autoVersion),
    // In-process (own.harness, 10 §6.14): a remote service holds no list and answers none.
    "codexModels.rows": async (input) => modules.codexMeta.rows(input.have),
  }
}
