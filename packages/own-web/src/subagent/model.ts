// Subagent (child session) model (03 §18.11), pure: the ancestor chain for the breadcrumb (nested subagents
// included), the agent name, the child's state, which children the parent view lists (running or waiting on the
// user first), and subagent calls the preset gate refused (07 §5.4, §7.3) with the gate's own text for
// `Preset.parse` (presets/chips.ts turns it into a neutral chip). Core titles child sessions
// "<task> (@<agent> subagent)"; the session's own `agent` wins when set.
import type { SessionMessageInfo } from "@opencode/client"
import type { SessionMessageAssistant } from "@opencode/client/promise"

export interface SessionFacts {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly agent?: string
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly created?: number
}

const SUFFIX = /\s*\(@([^)\s]+) subagent\)\s*$/

export function agentOf(info: Pick<SessionFacts, "agent" | "title"> | undefined) {
  return info?.agent ?? info?.title?.match(SUFFIX)?.[1]
}

/** The task part of a child title, without the `(@agent subagent)` suffix. */
export function taskTitle(title: string | undefined) {
  return title?.replace(SUFFIX, "").trim() || undefined
}

/**
 * Root → … → the session itself. Stops at an unknown or repeated id (a parent not loaded yet ends the chain there;
 * the caller loads it and the chain grows).
 */
export function ancestry(get: (id: string) => SessionFacts | undefined, sessionID: string) {
  const chain: SessionFacts[] = []
  const seen = new Set<string>()
  let current: string | undefined = sessionID
  while (current && !seen.has(current)) {
    seen.add(current)
    const info: SessionFacts = get(current) ?? { id: current }
    chain.unshift(info)
    current = info.parentID
  }
  return chain
}

export type ChildState = "running" | "succeeded" | "failed" | "interrupted" | "idle"

export function childState(info: Pick<SessionFacts, "outcome"> | undefined, running: boolean): ChildState {
  if (running) return "running"
  return info?.outcome ?? "idle"
}

export interface ChildRow {
  readonly id: string
  readonly agent?: string
  readonly task?: string
  readonly state: ChildState
  /** Pending permission requests and forms of this child and its own descendants. */
  readonly requests: number
  readonly created: number
}

/**
 * Children the parent view lists: those waiting on the user, then running ones, then the rest, newest first within a
 * group. `active` is true when any child runs or waits on the user (the strip shows only then).
 */
export function childRows(rows: readonly ChildRow[]) {
  const rank = (row: ChildRow) => (row.requests > 0 ? 0 : row.state === "running" ? 1 : 2)
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || b.created - a.created)
  return { rows: sorted, active: sorted.some((row) => rank(row) < 2) }
}

/** core's failure text for an agent it does not know (`tool/plugin/subagent.ts`). */
const UNKNOWN_AGENT = "Unknown agent: "

/**
 * How a refused subagent call reads in the transcript (07 §5.4 거절 경로). own-accounts' gate rewrites `input.agent` to a
 * sentence starting with `own-preset:` and core fails the call with `Unknown agent: <sentence>` (core
 * `tool/plugin/subagent.ts`, upstream text registered as `subagent-unknown-agent-error`). `model.test.ts`
 * cross-checks it against `Preset.REJECT_PREFIX`.
 */
export const PRESET_REJECTION_PREFIX = `${UNKNOWN_AGENT}own-preset:`

export interface PresetRejection {
  /** `input.model` as the LLM wrote it: transcript tool input is never the gate's rewrite. */
  readonly requestedModel?: string
  readonly agent?: string
  /** The gate's sentence after the prefix, written for the LLM. */
  readonly reason: string
}

/**
 * A failed `subagent` call the preset gate refused, read from the failure text only (the agent input is the LLM's,
 * 07 §5.4 화면). Any other content or failure is `undefined` and keeps its session-ui drawing.
 */
export function presetRejection(
  content: SessionMessageAssistant["content"][number] | undefined,
): PresetRejection | undefined {
  if (content?.type !== "tool" || content.name !== "subagent" || content.state.status !== "error") return undefined
  const message = content.state.error.message
  if (!message.startsWith(PRESET_REJECTION_PREFIX)) return undefined
  const input = content.state.input
  return {
    requestedModel: filled(input.model),
    agent: filled(input.agent),
    reason: message.slice(PRESET_REJECTION_PREFIX.length).trim(),
  }
}

/**
 * The gate's own text (`own-preset: …`) of a refusal, as `Preset.parse` reads it back (presets/chips.ts): core's
 * wrapper taken off, the sentence as the gate wrote it.
 */
export function gateText(rejection: Pick<PresetRejection, "reason">) {
  return `${PRESET_REJECTION_PREFIX.slice(UNKNOWN_AGENT.length)} ${rejection.reason}`
}

/**
 * `provider/model[#variant]` as the LLM wrote it, split so the chip can name the account and the model instead of an
 * internal slot id; `undefined` for any other shape (the chip then shows it as written).
 */
export function requestedRef(value: string) {
  const match = /^([^/#]+)\/([^#]+)(?:#.*)?$/.exec(value)
  return match?.[1] && match[2] ? { providerID: match[1], modelID: match[2] } : undefined
}

/**
 * The per-call effort (07 §2.3 대화에서 정하는 강도) a `model` the LLM wrote asks for: what follows its one `#`
 * (`#high`, `review#low`, `provider/model#max`), as the gate splits it (`Preset.effortRequest`, cross-checked in
 * `model.test.ts`). A value the gate declines as an effort (`#ultra`) is still named, so its chip can say which;
 * `undefined` without one `#` or with nothing after it.
 */
export function effortOf(value: unknown) {
  if (typeof value !== "string") return undefined
  const parts = value.split("#")
  const intent = parts[1]
  return parts.length === 2 && intent ? intent : undefined
}

/**
 * The effort the parent's latest `subagent` call of a child asked for (07 §2.3, the child's role chip `(요청)`): the
 * gate's record once the call finished (`metadata.own.effort.requested`), else the `#…` of the LLM's own `model`. Calls
 * are matched by the child's id in their metadata; `undefined` when none of the loaded messages asked one.
 */
export function requestedEffort(messages: readonly SessionMessageInfo[], childID: string) {
  const call = messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .findLast((part) => part.type === "tool" && part.name === "subagent" && metadataOf(part)?.sessionID === childID)
  if (call?.type !== "tool") return undefined
  const own = metadataOf(call)?.own
  const recorded = isObject(own) && isObject(own.effort) ? own.effort.requested : undefined
  if (typeof recorded === "string") return recorded
  return call.state.status === "streaming" ? undefined : effortOf(call.state.input.model)
}

/**
 * The effort part of a child's role chip (07 §2.3, §7.3): the variant the child's own Ref carries (core reads none back
 * as `default`), never the one asked for, since the gate fits and may lower it. Without a variant the chip says nothing
 * unless an effort was asked: then `기본` on a model with levels, or that the model has none (`none`, the gate's
 * unplaced case). `asked` adds `(요청)`.
 */
export function roleEffort(input: {
  readonly variant?: string
  readonly asked?: string
  /** How many levels the child's model lists in the catalog. */
  readonly levels: number
}): { readonly variant?: string; readonly none?: true; readonly asked: boolean } | undefined {
  const asked = input.asked !== undefined
  const variant = input.variant === "default" ? undefined : input.variant
  if (variant) return { variant, asked }
  if (!asked) return undefined
  return input.levels > 0 ? { asked } : { none: true, asked }
}

function metadataOf(part: SessionMessageAssistant["content"][number]) {
  if (part.type !== "tool" || part.state.status === "streaming") return undefined
  return part.state.metadata
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function filled(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
