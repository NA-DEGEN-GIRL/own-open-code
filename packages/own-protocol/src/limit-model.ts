export * as LimitModel from "./limit-model.js"

import type { Window } from "./limit.js"

/**
 * Which requests a limit window limits (LV 2026-10-24). Most windows limit the whole account. Claude's model weekly
 * buckets (`claude.7d_oi`, Claude Code's "Fable limit", and the claimed `claude.7d_opus` / `claude.7d_sonnet`) limit one
 * model family only: an exhausted Fable week still lets the account run Sonnet, and an exhaustion record naming one
 * holds back only that family. own-web ranks and own-accounts switches and waits by this, so the module has no runtime
 * imports (own-web's first chunk reads it).
 */
const BUCKETS: Readonly<Record<string, Family>> = {
  "claude.7d_oi": "fable",
  "claude.7d_opus": "opus",
  "claude.7d_sonnet": "sonnet",
}

export type Family = "fable" | "opus" | "sonnet"

/** 02 §7.4's stale band: an observation older than 15 minutes. */
export const STALE_AFTER_MS = 15 * 60_000

/** The model family a window limits alone, or `undefined` for an account-wide window. */
export function bucket(windowID: string): Family | undefined {
  return BUCKETS[windowID]
}

/**
 * The bucket family of a model id: `claude-fable-5-1`, `anthropic/claude-opus-5-5`, `us.anthropic.claude-sonnet-4-5`,
 * `claude-3-5-sonnet-latest`. `undefined` for other models and an unknown model.
 */
export function family(modelID: string | undefined): Family | undefined {
  const match = /(fable|opus|sonnet)/i.exec(modelID ?? "")?.[1]?.toLowerCase()
  return match === "fable" || match === "opus" || match === "sonnet" ? match : undefined
}

/**
 * Whether a window limits requests of `modelID`: an account-wide window always, a model bucket only when the model is
 * of its family (an unknown model: never, so a surface without a model ranks account-wide windows only).
 */
export function limits(windowID: string, modelID: string | undefined) {
  const owner = BUCKETS[windowID]
  return owner === undefined || owner === family(modelID)
}

/**
 * Whether an exhaustion record holds back the whole account: one without a window or with an account-wide one. A model
 * bucket's (`Limit.Exhaustion.windowId` `claude.7d_oi`, …) holds back only that bucket's model family.
 */
export function accountWide(windowID: string | null) {
  return windowID === null || BUCKETS[windowID] === undefined
}

/**
 * A model bucket without a reset whose observation is stale: its state no longer counts. Only some answers carry a
 * bucket (`7d_oi` comes with that model's requests), so the store keeps the last one for good; without a reset
 * nothing would ever end an exhausted one. The screen still shows it, faded and tagged stale, but it never leads a
 * ranking and never blocks an account.
 */
export function lapsed(window: Pick<Window, "id" | "resetAt" | "observedAt">, now: number) {
  return BUCKETS[window.id] !== undefined && window.resetAt === undefined && now - window.observedAt > STALE_AFTER_MS
}
