// Codex's incremental tools windows (the `incremental_tools` feature, stable and on by default since rust-v0.165.0,
// c953dacb42 #55368; codex-rs/core/src/session/world_state.rs `current_window_uses_incremental_tools`,
// session/step_context.rs `incremental_tools_enabled`). A context window that opens on a Responses Lite model records
// its tool declarations and base instructions in the window itself, so a later change of model appends to the window
// instead of rewriting its prefix: the window keeps the base instructions and collaboration text it opened with, and
// the step on the new model gets `<model_instructions>` (context/model_instructions.rs, world_state/model.rs) in place
// of `<model_switch>`, then the collaboration section's re-emission (world_state/collaboration_mode.rs: its snapshot
// names the model, so every change of model sends the new model's `<collaboration_mode>` again). A window that opens on
// any other model stays an ordinary one (`<model_switch>`), even where it later runs on a Lite model.
// Changed tool declarations (world_state/top_level_tools.rs: a notice and an `additional_tools` delta, or a removal
// notice) are not replayed: own's request always declares the request's tools in its first `additional_tools` item,
// which for a switch between the GPT-6 models is the window's own declaration byte for byte.
// Ported from openai/codex (Apache-2.0) @ rust-v0.165.0.
export * as CodexIncremental from "./incremental.js"

import type { Message } from "@opencode/ai/effect"
import { CodexEffort } from "./effort.js"

const REPLACEMENT_NOTICE = "The following instructions replace the previous base instructions:"
const REMOVAL_NOTICE = "The previous base instructions no longer apply. No replacement base instructions are active."

/**
 * The model whose request opened the newest context window when the window records its declarations: the model of
 * the window's first step (the first assistant message after the newest window start), else the request's own model.
 * `undefined` runs the request as an ordinary window: its model is not on Responses Lite (`lite`), or the window opened
 * on one that is not.
 */
export function opener(
  history: ReadonlyArray<Message>,
  steps: ReadonlyMap<string, CodexEffort.Step>,
  model: string,
  lite: (model: string) => boolean,
) {
  if (!lite(model)) return undefined
  const opened = firstStep(history, steps, model)
  return lite(opened) ? opened : undefined
}

/**
 * The model of the newest window's first step (the first assistant message after the newest window start), else the
 * request's own model: the model whose world state the window's initial context recorded.
 */
export function firstStep(
  history: ReadonlyArray<Message>,
  steps: ReadonlyMap<string, CodexEffort.Step>,
  model: string,
) {
  const first = history
    .slice(history.findLastIndex(CodexEffort.windowStart) + 1)
    .flatMap((entry) => (entry.role === "assistant" && entry.id !== undefined ? [steps.get(entry.id)] : []))
    .find((step) => step !== undefined)
  return first?.model ?? model
}

export interface Input {
  /** The conversation, oldest first. */
  readonly history: ReadonlyArray<Message>
  /** The first model-visible message after each change of model, with the model it changed to (hooks.ts). */
  readonly switches: ReadonlyMap<string, string>
  /** The model that opened the newest window ({@link opener}). */
  readonly opener: string
  /** Whether a model runs on Responses Lite on this route. */
  readonly lite: (model: string) => boolean
  /** The base instructions a model runs with in this session. */
  readonly base: (model: string) => string
  /** A model's `<collaboration_mode>` text. */
  readonly collaboration: (model: string) => string
  /** Codex's ordinary `<model_switch>` for a model. */
  readonly modelSwitch: (model: string) => string
  /** The `<tools>` update at a change of model, by the id of the message it goes before (request.ts `toolUpdates`). */
  readonly tools?: ReadonlyMap<string, string>
  /** A developer message with these input texts. */
  readonly developer: (texts: ReadonlyArray<string>) => Message
}

/**
 * The history with Codex's model updates in place. In the newest window, a change to a Lite model gets
 * `<model_instructions>` with the model and, when they differ from the base the window last recorded, its base
 * instructions; a change to another model gets `<model_switch>` and leaves the base unknown, so the next Lite model
 * replaces it. Each change of model is followed by the new model's `<collaboration_mode>` and the `<tools>` update when
 * the deferred tool namespaces changed, in one developer message: Codex sends these two world-state updates as
 * mergeable fragments, which share a message, while the model's own update stands alone
 * (context_manager/updates.rs `merge_world_state_updates`). Changes before the newest window start keep the ordinary
 * `<model_switch>`.
 */
export function apply(input: Input) {
  const start = input.history.findLastIndex(CodexEffort.windowStart)
  const state: State = { model: input.opener, base: input.base(input.opener) }
  return input.history.flatMap((entry, index) => {
    const id = entry.id
    const target = id === undefined ? undefined : input.switches.get(id)
    if (id === undefined || target === undefined) return [entry]
    if (index <= start) return [input.developer([input.modelSwitch(target)]), entry]
    const [update, ...mergeable] = transition(input, state, target)
    const merged = [...mergeable, ...[input.tools?.get(id)].filter((text) => text !== undefined)]
    return [
      ...(update === undefined ? [] : [input.developer([update])]),
      ...(merged.length === 0 ? [] : [input.developer(merged)]),
      entry,
    ]
  })
}

interface State {
  /** The model the window last recorded. */
  model: string
  /** Its base instructions; `undefined` after a step outside Responses Lite, which records only the model. */
  base: string | undefined
}

/** `ModelInstructionsState::render_diff` for one step on `model`, then the collaboration section's re-emission. */
function transition(input: Input, state: State, model: string) {
  const changed = state.model !== model
  if (!input.lite(model)) {
    state.model = model
    state.base = undefined
    return changed ? [input.modelSwitch(model), input.collaboration(model)] : []
  }
  const base = input.base(model)
  const replaced = state.base === undefined ? changed : state.base !== base
  state.model = model
  state.base = base
  if (!changed && !replaced) return []
  const update = instructions(changed ? model : undefined, replaced ? base : undefined)
  return changed ? [update, input.collaboration(model)] : [update]
}

/** Codex's `<model_instructions>` fragment: the current model, the replacement base instructions, or both. */
export function instructions(model: string | undefined, base: string | undefined) {
  const lines = [
    ...(model === undefined ? [] : [`The current model is ${model}.`]),
    ...(base === undefined ? [] : [base === "" ? REMOVAL_NOTICE : `${REPLACEMENT_NOTICE}\n\n${base}`]),
  ]
  return `<model_instructions>\n${lines.map((line) => `${line}\n`).join("")}</model_instructions>`
}
