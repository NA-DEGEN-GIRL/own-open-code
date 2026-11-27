export * as PresetCards from "./cards.js"

import { CodexModels, type Kind, type Preset } from "@own/protocol"

/**
 * Owner: PRESETS (07 §3.3 모델 묶음, D2). The facts a model pool card freezes when an entry is added (or on `카드 새로
 * 고치기`): only what does not depend on the main or on whether the entry can run now. `presets.suggest` and
 * `presets.set` both build cards here, so the editor shows the card the LLM will read.
 * - `window`: the model's largest input (`limit.input ?? limit.context`); a local model's running window once it is
 *   verified (07 §6.2 #8), and `windowVerified` says whether it is (locals only).
 * - `reasoning`: the model has reasoning levels; `image`: it takes image input.
 * - `summary`: Codex's description of the model, for a `codex` account only (a `siwc` login never reads Codex
 *   metadata, 07 §2.2).
 */
export function of(
  entry: Preset.Entry,
  kind: Kind.Any | undefined,
  codex: CodexModels.Snapshot | undefined,
  local: Local | undefined,
  now: number,
): Preset.PoolCard {
  const verified = local?.verified === true
  const window =
    kind === undefined
      ? verified
        ? local?.runtime
        : undefined
      : entry.limit === undefined
        ? undefined
        : (entry.limit.input ?? entry.limit.context)
  const summary = kind === "codex" ? (CodexModels.find(codex, entry.id)?.description ?? undefined) : undefined
  return {
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(window === undefined ? {} : { window }),
    ...(kind === undefined ? { windowVerified: verified } : {}),
    reasoning: entry.variants.length > 0,
    image: entry.capabilities?.input?.includes("image") ?? false,
    ...(summary ? { summary } : {}),
    at: now,
  }
}

/** A local model's running window as the resolver knows it (07 §6.2 #8): verified or not, and its size when known. */
export interface Local {
  readonly verified: boolean
  readonly runtime?: number
}
