// Codex's cache-preserving reasoning-effort updates (codex-rs/core/src/session/reasoning_effort.rs, state/session.rs
// `ReasoningEffortPin` and client.rs `build_responses_request`; the `reasoning_effort_override` feature is stable and
// on by default since rust-v0.165.0). For a catalog model with `supports_reasoning_effort_updates` on the OpenAI
// route, Codex records a `configuration_update` item before a sampling request whose effort differs from the newest
// one in the history (or from the window's pinned effort when there is none), and keeps the request's top-level
// `reasoning.effort` at the effort the context window started with, so changing the effort never rewrites the cached
// prefix. Codex records the items as it samples; own builds every request again from the stored history, so this walk
// replays that bookkeeping step by step: an update right after the first user message of a session, another only
// where the effort changed, none after a completed compaction (own's checkpoint starts a window with a fresh baseline),
// none for a compaction request itself. Adjacent updates collapse to the newest in @opencode/ai's Responses lowering.
// The items go out as core's effort markers (`Message.effort`). own-accounts drops core's markers on Sign in with
// ChatGPT (`Shape.withoutEffortUpdates`) before this hook runs, so the caller turns the walk off there.
// Ported from openai/codex (Apache-2.0) @ rust-v0.165.0.
export * as CodexEffort from "./effort.js"

import { Message, ReasoningEfforts } from "@opencode/ai/effect"
import { Checkpoint } from "../checkpoint.js"
import { Catalog } from "./catalog.js"
import { CodexCompaction } from "./compaction.js"

/** One logical LLM call of the stored history: the model and variant its assistant message ran on (hooks.ts). */
export interface Step {
  readonly model: string
  readonly variant?: string
}

export interface Input {
  /** The conversation as the request sends it, oldest first, without core's own effort markers ({@link isUpdate}). */
  readonly history: ReadonlyArray<Message>
  /** Each assistant message's step, by message id. */
  readonly steps: ReadonlyMap<string, Step>
  /** The request's model and the effort it sends (its variant's, else the catalog's default). */
  readonly model: string
  readonly effort: string | undefined
  /** Whether a model takes updates on this request's route ({@link enabled}). */
  readonly enabled: (model: string) => boolean
  /** A sampling request records its own update; a compaction request does not (Codex `RequestEffortUsage`). */
  readonly sampling: boolean
}

/**
 * Whether Codex sends effort updates for `model` on this route (`ModelClient::reasoning_effort_override_enabled`): a
 * route that takes them (OpenAI Responses, not Sign in with ChatGPT) and a catalog model that says so.
 */
export function enabled(model: string, route: boolean) {
  return route && Catalog.lookup(model).supports_reasoning_effort_updates === true
}

/** A message that is only an effort marker (`ai/src/effort-updates.ts` effortUpdate). */
export function isUpdate(message: Message) {
  return updateOf(message) !== undefined
}

/**
 * The history with Codex's updates in place, and the request's own effort. Every update's `previous` is the window's
 * pinned effort and the request's effort is the newest update's, so core's `resolveEffortUpdates` sends the pinned
 * effort as the top-level `reasoning.effort` while the updates carry the changes.
 */
export function apply(input: Input) {
  const state: State = { pin: undefined, compacted: false, latest: undefined }
  const walked = input.history.flatMap((entry): Array<Message> => {
    if (windowStart(entry)) {
      state.pin = undefined
      state.compacted = true
      state.latest = undefined
    }
    // A full-history fork carries its parent's updates, and Codex's fork inherits the parent's pin.
    const inherited = updateOf(entry)
    if (inherited?.effort !== undefined) {
      state.pin ??= { model: input.model, effort: inherited.previous ?? inherited.effort }
      state.latest = { effort: inherited.effort, tail: true }
      return [entry]
    }
    const step = entry.role === "assistant" && entry.id !== undefined ? input.steps.get(entry.id) : undefined
    const effort = step === undefined ? undefined : effortOf(step.model, step.variant)
    const update =
      step === undefined || effort === undefined ? undefined : record(state, input, step.model, effort.value)
    if (state.latest !== undefined) state.latest = { effort: state.latest.effort, tail: false }
    return update === undefined ? [entry] : [update, entry]
  })
  const own = input.sampling ? record(state, input, input.model, input.effort) : undefined
  // Codex's compaction request takes the pin too, and the current effort only while there is none.
  const baseline = state.pin?.model === input.model ? state.pin.effort : input.effort
  const history = [...walked, ...(own === undefined ? [] : [own])].map((entry) => {
    const update = updateOf(entry)
    return update?.effort === undefined ? entry : Message.effort({ effort: update.effort, previous: baseline })
  })
  const newest = history.findLast(isUpdate)
  return { history, effort: (newest === undefined ? undefined : updateOf(newest)?.effort) ?? baseline }
}

interface State {
  /** The window's request effort for one model (`ReasoningEffortPin::Active`); absent while unset. */
  pin: { readonly model: string; readonly effort: string } | undefined
  /** A completed compaction started this window (`ReasoningEffortPin::Compacted`). */
  compacted: boolean
  /** The newest update in the history, and whether nothing follows it yet. */
  latest: { readonly effort: string; readonly tail: boolean } | undefined
}

const EFFORTS = new Set<string>(ReasoningEfforts)

/**
 * `record_reasoning_effort_override`, then `reasoning_effort_for_request` (Sampling), for one step: the update to
 * record before it, if any. A step whose model takes no updates (or that has no effort) unsets the pin.
 */
function record(state: State, input: Input, model: string, effort: string | undefined) {
  if (effort === undefined || !input.enabled(model)) {
    state.pin = undefined
    state.compacted = false
    return undefined
  }
  // Only a completed compaction lets the request baseline take the selection without an update.
  if (state.compacted) {
    state.pin = { model, effort }
    state.compacted = false
  }
  const pinned = state.pin?.model === model ? state.pin.effort : undefined
  // A matching update at the tail is reused (a retried request); otherwise the newest update, else the pin, decides.
  const skip =
    (state.latest?.tail === true && state.latest.effort === effort) ||
    (pinned !== undefined && (state.latest?.effort ?? pinned) === effort)
  if (pinned === undefined) state.pin = { model, effort }
  if (skip) return undefined
  state.latest = { effort, tail: true }
  return Message.effort({ effort, previous: effort })
}

/**
 * The effort a step on `model` with `variant` runs with: the variant when it is an effort, the catalog's default for
 * the default variant (what the request sends then). A variant that names no effort says nothing about it (`undefined`),
 * so such a step changes nothing.
 */
export function effortOf(
  model: string,
  variant: string | undefined,
): { readonly value: string | undefined } | undefined {
  if (variant === undefined || variant === "default")
    return { value: Catalog.lookup(model).default_reasoning_level ?? undefined }
  return EFFORTS.has(variant) ? { value: variant } : undefined
}

/** Where a context window starts: own's checkpoint (or one rendered as Codex's summary), or native compaction. */
export function windowStart(entry: Message) {
  return entry.content.some(
    (part) =>
      part.type === "compaction" ||
      (entry.role === "user" &&
        part.type === "text" &&
        (Checkpoint.isCheckpoint(part.text) || part.text.startsWith(`${CodexCompaction.SUMMARY_PREFIX}\n`))),
  )
}

function updateOf(message: Message) {
  const part = message.content[0]
  return message.role === "system" && message.content.length === 1 && part?.type === "effort" ? part : undefined
}
