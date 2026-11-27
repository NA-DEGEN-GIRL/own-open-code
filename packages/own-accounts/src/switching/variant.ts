export * as Variant from "./variant.js"

import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import type { Estimate, Kind } from "@own/protocol"

/** Reasoning efforts that core lowers to per-message effort markers (`ai/src/schema/options.ts` `ReasoningEfforts`). */
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])

/** A model reference as events carry it (plain strings); `Model.Ref` is the branded protocol form. */
export interface Ref {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

const decodeRef = Schema.decodeUnknownSync(Model.Ref)

/** The protocol `Model.Ref` of a plain Ref (events and the plugin client use plain strings). */
export function ref(value: Ref): Model.Ref {
  return decodeRef({
    providerID: value.providerID,
    id: value.id,
    ...(value.variant === undefined ? {} : { variant: value.variant }),
  })
}

/** Whether two Refs select the same model; a missing variant equals `default` (`core/src/session/session.ts:97-109`). */
export function same(a: Ref | undefined, b: Ref | undefined) {
  if (!a || !b) return a === b
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "default") === (b.variant ?? "default")
}

/**
 * `switch.estimate.variantOnly` (02 §5.1, §9.2): set only when the target differs from the current Ref by variant.
 * The cache survives only on routes with per-message effort updates and when both variants are effort levels;
 * `effort_marker_mismatch` needs the stored history and is not detected here.
 */
export function only(current: Ref | undefined, target: Ref, kind: Kind.Any | undefined): Estimate.VariantOnly | null {
  if (!current || current.providerID !== target.providerID || current.id !== target.id) return null
  if (same(current, target)) return null
  if (!effort(current.variant) || !effort(target.variant))
    return { preservesCache: false, reason: "non_effort_variant" }
  if (!supportsEffortUpdates(kind, target.id)) return { preservesCache: false, reason: "route_unsupported" }
  // Claude's `none` turns thinking off (`core/src/variant.ts`), and Anthropic sends no effort update then (upstream v2.0.28).
  if ((kind === "anth" || kind === "claude-sub") && (current.variant === "none" || target.variant === "none"))
    return { preservesCache: false, reason: "route_unsupported" }
  return { preservesCache: true, reason: "message_effort_update" }
}

function effort(variant: string | undefined) {
  return variant !== undefined && EFFORTS.has(variant)
}

/**
 * Routes with per-message effort updates: Anthropic Claude Opus 5+ and every Claude 5.1+
 * (`ai/src/protocols/anthropic-messages.ts` `supportsEffortUpdates`), OpenAI Responses GPT-6 and later
 * (`openai-responses.ts`, not in pro mode). Both rules are forward-compatible from upstream 033b9ea560 and 91b9bc52a4.
 * Not Sign in with ChatGPT: token sharing refuses the `configuration_update` item, so own drops its markers
 * (`Shape.withoutEffortUpdates`, 02 §3.2c) and a variant change rewrites the prefix there.
 */
export function supportsEffortUpdates(kind: Kind.Any | undefined, modelID: string) {
  if (kind === "anth" || kind === "claude-sub") {
    const version = claudeVersion(modelID)
    if (!version) return false
    if (version.family === "opus" && version.major >= 5) return true
    return version.major > 5 || (version.major === 5 && version.minor >= 1)
  }
  if (kind === "codex" || kind === "oai") {
    const match = /(?:^|\/)gpt-(\d+)(?:\.\d+)?(?:-|$)/i.exec(modelID)
    return match !== null && Number(match[1]) >= 6
  }
  return false
}

/** `ai/src/protocols/utils/claude-model.ts` `claudeVersion`. */
function claudeVersion(id: string) {
  const match = /(?:^|[./])claude-(?<family>[a-z]+)-(?<major>\d+)(?:[.-](?<minor>\d{1,2}))?(?:$|[-:@])/.exec(
    id.toLowerCase(),
  )?.groups
  if (!match) return undefined
  return { family: match.family, major: Number(match.major), minor: Number(match.minor ?? 0) }
}
