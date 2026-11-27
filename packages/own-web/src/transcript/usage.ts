// Turn footer data (03 §4.5): tokens, cache ratio and cost of one turn, summed over its steps (one assistant message
// is one step). Pure; the footer component feeds it reactive inputs. Costs follow the unit the router records:
// credits (ChatGPT subscription, always an estimate), USD (API keys, core's `cost`, or the router's recomputed value),
// or unknown (Claude subscription slot, or nothing recorded). The UI never prices tokens itself (03 P10). Output speed
// (t/s) per step and turn from the step's own timestamps ({@link stepSpeed}). Also whether the turn fetched a big-file
// folder (06 §4.14), for the note under its footer.
import type { SessionMessageAssistant } from "@opencode/client/promise"
import type { Kind, Ledger } from "@own/protocol"

export interface StepUsage {
  readonly id: string
  /** Request size: `input + cache.read + cache.write`. */
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Billed output: `output + reasoning`. */
  readonly output: number
  readonly hit: number | null
  /** The request start (`time.created`), for the step table's `시각` (4.5 `날짜·시각`). */
  readonly startedAt: number
  readonly durationMs: number | null
  readonly speed: StepSpeed | null
}

/** One step's generation timing; `null` when the step cannot be timed (see {@link stepSpeed}). */
export interface StepSpeed {
  /** Generated tokens: `output + reasoning`. */
  readonly tokens: number
  readonly ms: number
  /**
   * `decode`: from the first output (a thinking block or a tool call) to the end of the response body. `request`:
   * from the request start, so the wait for the first token (prompt processing) is in it.
   */
  readonly basis: "decode" | "request"
  /** Request start → first output, when the first output carries a time and no hidden reasoning came before it. */
  readonly firstTokenMs: number | null
}

export interface TurnSpeed {
  readonly tokensPerSecond: number
  /** `request` when any timed step had no first-output time. */
  readonly basis: "decode" | "request"
  /** The turn's first step's time to first token. */
  readonly firstTokenMs: number | null
}

export type TurnCost =
  | { readonly kind: "usd"; readonly value: number; readonly recomputed: boolean }
  | { readonly kind: "credits"; readonly value: number }
  | { readonly kind: "unknown" }

export interface TurnUsage {
  readonly steps: readonly StepUsage[]
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly hit: number | null
  /** Cache ratio of the first step; under 50 % is tagged "캐시 재작성" (03 §4.5). */
  readonly firstHit: number | null
  readonly providerID: string | undefined
  readonly modelID: string | undefined
  readonly cost: TurnCost
  readonly speed: TurnSpeed | null
}

const API_KINDS: ReadonlySet<Kind.Any> = new Set(["oai", "anth", "ds", "xai", "or", "compat"])

export function stepUsage(message: SessionMessageAssistant): StepUsage {
  const tokens = message.tokens
  const input = tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0
  return {
    id: message.id,
    input,
    cacheRead: tokens?.cache.read ?? 0,
    cacheWrite: tokens?.cache.write ?? 0,
    output: tokens ? tokens.output + tokens.reasoning : 0,
    hit: input > 0 ? (tokens?.cache.read ?? 0) / input : null,
    startedAt: message.time.created,
    durationMs: message.time.completed === undefined ? null : message.time.completed - message.time.created,
    speed: stepSpeed(message),
  }
}

/** Shorter windows are one buffered chunk (a provider that does not stream), not a speed. */
export const MIN_SPEED_WINDOW_MS = 200

/**
 * Output speed of one step (one LLM call). Timestamps are the server's (03 §4.5): `time.created` is the request start
 * (reset by a retry), `time.streamed` the end of the provider response body before tools settle, and a thinking block's
 * or tool call's `time.created` the arrival of its first chunk. Text parts carry no time.
 * - tokens: `output + reasoning`; nothing generated, nothing to time.
 * - end: `time.streamed`; without it (older steps) `time.completed` only for a step without tool calls, whose
 *   completion then includes no tool run. Tool execution is never inside the window.
 * - start: the first content's time when it is a thinking block or a tool call (`decode`), unless the step reports
 *   reasoning tokens but did not start with a thinking block: hidden reasoning came before the first visible output, so
 *   its tokens would land in a too-short window. Otherwise the request start (`request`, slower than the real decode
 *   speed by the time to first token).
 */
export function stepSpeed(message: SessionMessageAssistant): StepSpeed | null {
  const tokens = message.tokens ? message.tokens.output + message.tokens.reasoning : 0
  if (!(tokens > 0)) return null
  const tools = message.content.some((content) => content.type === "tool")
  const end = message.time.streamed ?? (tools ? undefined : message.time.completed)
  if (end === undefined) return null
  const start = message.time.created
  const first = firstOutput(message)
  const hidden = (message.tokens?.reasoning ?? 0) > 0 && message.content[0]?.type !== "reasoning"
  const firstTokenMs = first !== undefined && !hidden && first >= start && first <= end ? first - start : null
  if (firstTokenMs !== null && end - (start + firstTokenMs) >= MIN_SPEED_WINDOW_MS)
    return { tokens, ms: end - start - firstTokenMs, basis: "decode", firstTokenMs }
  if (end - start >= MIN_SPEED_WINDOW_MS) return { tokens, ms: end - start, basis: "request", firstTokenMs }
  return null
}

/** A turn's speed: all timed steps' tokens over their summed windows (so long steps weigh more). */
export function turnSpeed(steps: readonly (StepSpeed | null)[]): TurnSpeed | null {
  const timed = steps.filter((step): step is StepSpeed => step !== null)
  if (timed.length === 0) return null
  const tokens = timed.reduce((total, step) => total + step.tokens, 0)
  const ms = timed.reduce((total, step) => total + step.ms, 0)
  return {
    tokensPerSecond: (tokens * 1_000) / ms,
    basis: timed.every((step) => step.basis === "decode") ? "decode" : "request",
    firstTokenMs: steps[0]?.firstTokenMs ?? null,
  }
}

function firstOutput(message: SessionMessageAssistant) {
  const first = message.content[0]
  if (first?.type === "reasoning") return first.time?.created
  if (first?.type === "tool") return first.time.created
  return undefined
}

export function turnUsage(
  assistants: readonly SessionMessageAssistant[],
  input: {
    /** The router's ledger line of a step (`ledger.session` / `ledger.step`), keyed by assistant message id. */
    readonly lineOf: (messageID: string) => Ledger.Line | undefined
    readonly accountKind: Kind.Any | undefined
  },
): TurnUsage {
  const steps = assistants.map(stepUsage)
  const sum = (pick: (step: StepUsage) => number) => steps.reduce((total, step) => total + pick(step), 0)
  const total = sum((step) => step.input)
  const cacheRead = sum((step) => step.cacheRead)
  const last = assistants.at(-1)
  return {
    steps,
    input: total,
    cacheRead,
    cacheWrite: sum((step) => step.cacheWrite),
    output: sum((step) => step.output),
    hit: total > 0 ? cacheRead / total : null,
    firstHit: steps[0]?.hit ?? null,
    providerID: last?.model.providerID,
    modelID: last?.model.id,
    cost: turnCost(assistants, input),
    speed: turnSpeed(steps.map((step) => step.speed)),
  }
}

function turnCost(
  assistants: readonly SessionMessageAssistant[],
  input: {
    readonly lineOf: (messageID: string) => Ledger.Line | undefined
    readonly accountKind: Kind.Any | undefined
  },
): TurnCost {
  // 5.4.1(d): the Claude subscription slot has no price; it may be billed as extra usage.
  if (input.accountKind === "claude-sub") return { kind: "unknown" }
  const lines = assistants.map((message) => input.lineOf(message.id))
  const credits = lines.flatMap((line) => (line?.cost?.unit === "credits" ? [line.cost.amount] : []))
  if (credits.length) return { kind: "credits", value: credits.reduce((a, b) => a + b, 0) }
  // A router-priced USD line replaces core's cost for that step (5.6): Anthropic 1h cache writes, cards with peak
  // windows such as DeepSeek (02 §7.5), and steps core priced at 0 or not at all.
  const recomputed = (line: Ledger.Line | undefined) => line?.cost?.unit === "USD" && line.cost.source === "ratecard"
  const perStep = assistants.map((message, index) => {
    const line = lines[index]
    if (recomputed(line)) return line!.cost!.amount
    if (message.cost !== undefined) return message.cost
    return line?.cost?.unit === "USD" ? line.cost.amount : undefined
  })
  const known = perStep.filter((value): value is number => value !== undefined)
  const value = known.reduce((a, b) => a + b, 0)
  // A Claude Agent plan prices nothing (core leaves its cost empty): like the Claude slot, not a $0 turn (CAG-53).
  if (input.accountKind === "claude-agent" && value === 0) return { kind: "unknown" }
  const priced = value > 0 || lines.some((line) => line?.cost?.unit === "USD")
  if (priced || (input.accountKind !== undefined && API_KINDS.has(input.accountKind) && known.length))
    return { kind: "usd", value, recomputed: lines.some(recomputed) }
  return { kind: "unknown" }
}

/**
 * The turn fetched a big-file folder with `team_need_paths` (06 §4.14): core's snapshots do not see changes inside it,
 * so the turn's changes and going back may miss them. Team tools are Code Mode tools: the call is a row of the
 * `execute` part's `toolCalls` metadata (`team.need_paths`, packages/core/src/codemode/tool.ts).
 */
export function fetchedHeavyFolder(assistants: readonly SessionMessageAssistant[]) {
  return assistants.some((message) =>
    message.content.some((content) => {
      if (content.type !== "tool" || content.name !== "execute" || content.state.status === "streaming") return false
      const calls = content.state.metadata?.toolCalls
      return (
        Array.isArray(calls) &&
        calls.some(
          (call) =>
            typeof call === "object" &&
            call !== null &&
            !Array.isArray(call) &&
            call.tool === "team.need_paths" &&
            call.status === "completed",
        )
      )
    }),
  )
}
