// Ports Codex's `/goal` extension (codex-rs/ext/goal/src/{tool,spec,api,runtime,steering,accounting,extension}.rs) and
// the goal state it persists (codex-rs/state/src/runtime/goals.rs, codex-rs/state/src/model/thread_goal.rs, and
// `ThreadGoal`/`ThreadGoalStatus`/`validate_thread_goal_objective` in codex-rs/protocol/src/protocol.rs). A goal is
// keyed by the own session id where Codex keys it by thread id. Tool definitions stay in codex-data/tools.win32.json.
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1 (092d3acd6b)
export * as Goals from "./index.js"

import { GoalArgs } from "./args.js"
import { BUDGET_LIMIT, CONTINUATION, OBJECTIVE_UPDATED } from "./templates.js"

export const GET_GOAL_TOOL_NAME = "get_goal"
export const CREATE_GOAL_TOOL_NAME = "create_goal"
export const UPDATE_GOAL_TOOL_NAME = "update_goal"
export const MAX_OBJECTIVE_CHARS = 4_000

export const PERSISTENT_THREAD_REQUIRED = "Goal tools require a persistent thread."
export const UNFINISHED_GOAL =
  "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first"
export const NO_GOAL = "cannot update goal because this thread has no goal"
export const UPDATE_STATUS_REJECTED =
  "update_goal can only mark the existing goal complete, blocked, or paused at the user's explicit request; resume, budget-limited, and usage-limited status changes are controlled by the user or system"
export const COMPLETION_BUDGET_REPORT =
  "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."

/** Protocol `ThreadGoalStatus` (serde camelCase); the state crate's snake_case spelling never reaches the model. */
export type Status = GoalArgs.StatusVariant

/** `codex_state::ThreadGoal`. Timestamps are epoch milliseconds, like Codex's `created_at_ms`/`updated_at_ms` columns. */
export interface Goal {
  readonly goalID: string
  readonly sessionID: string
  readonly objective: string
  readonly status: Status
  readonly tokenBudget?: number
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One goal per session, as Codex keeps one `thread_goals` row per thread. */
export interface Store {
  readonly get: (sessionID: string) => Promise<Goal | undefined>
  readonly set: (sessionID: string, goal: Goal | undefined) => Promise<void>
}

export function memoryStore(): Store & { readonly goals: Map<string, Goal> } {
  const goals = new Map<string, Goal>()
  return {
    goals,
    get: async (sessionID) => goals.get(sessionID),
    set: async (sessionID, goal) => {
      if (goal === undefined) {
        goals.delete(sessionID)
        return
      }
      goals.set(sessionID, goal)
    },
  }
}

export interface Context {
  readonly store: Store
  readonly sessionID: string
  /** `false` reproduces Codex's ephemeral threads: the tools stay visible but every call fails. Defaults to true. */
  readonly persistent?: boolean
  /** `GoalExtensionConfig.max_goal_token_budget`: the default budget for `create_goal` and its upper bound. */
  readonly maxTokenBudget?: number
  readonly now?: () => number
  readonly newGoalID?: () => string
}

/** Protocol `ThreadGoal` exactly as serde serializes it: camelCase, `tokenBudget` omitted when absent, seconds. */
export interface ProtocolGoal {
  readonly threadId: string
  readonly objective: string
  readonly status: Status
  readonly tokenBudget?: number
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** `GoalToolResponse`; absent values serialize as `null`. */
export interface Response {
  readonly goal: ProtocolGoal | null
  readonly remainingTokens: number | null
  readonly completionBudgetReport: string | null
}

/** A successful call carries the function-call output text (`serde_json::Value::to_string`); a failure is the text Codex returns to the model. */
export type Result =
  | { readonly ok: true; readonly value: Response; readonly output: string }
  | { readonly ok: false; readonly message: string }

/** Token and wall-clock progress to charge to a goal. `goalID` restricts it to that goal, like Codex's `expected_goal_id`. */
export interface Usage {
  readonly tokens: number
  readonly elapsedMs: number
  readonly goalID?: string
}

/** `codex_state::GoalAccountingMode`: which goal statuses may still be charged. */
export type AccountingMode = "activeStatusOnly" | "activeOnly" | "activeOrComplete" | "activeOrStopped"

// ---------------------------------------------------------------------------------------------------------------------
// Tools (tool.rs)

export async function getGoal(ctx: Context): Promise<Result> {
  if (ctx.persistent === false) return fail(PERSISTENT_THREAD_REQUIRED)
  const goal = await attempt(ctx.store.get(ctx.sessionID), "failed to read goal")
  if (!goal.ok) return goal
  return succeed(response(goal.value, false))
}

export async function createGoal(ctx: Context, args: unknown): Promise<Result> {
  if (ctx.persistent === false) return fail(PERSISTENT_THREAD_REQUIRED)
  const request = GoalArgs.create(args)
  if (!request.ok) return fail(request.message)
  const objective = trimRust(request.value.objective)
  const objectiveError = validateObjective(objective)
  if (objectiveError) return fail(objectiveError)
  const tokenBudget = request.value.token_budget ?? ctx.maxTokenBudget
  const budgetError = validateBudget(tokenBudget, ctx.maxTokenBudget)
  if (budgetError) return fail(budgetError)

  const existing = await attempt(ctx.store.get(ctx.sessionID), "failed to create goal")
  if (!existing.ok) return existing
  // `insert_thread_goal` only replaces a row whose status is `complete`.
  if (existing.value && existing.value.status !== "complete") return fail(UNFINISHED_GOAL)
  const now = clock(ctx)
  const goal: Goal = {
    goalID: ctx.newGoalID?.() ?? crypto.randomUUID(),
    sessionID: ctx.sessionID,
    objective,
    status: statusAfterBudgetLimit("active", 0, tokenBudget),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  }
  const written = await attempt(ctx.store.set(ctx.sessionID, goal), "failed to create goal")
  if (!written.ok) return written
  return succeed(response(goal, false))
}

/**
 * `update_goal`. `pending` is the turn's not yet charged progress: Codex charges it before the status change, in mode
 * `activeOrComplete` for `complete` and `activeOrStopped` for `blocked`/`paused`, so the result reports final usage.
 */
export async function updateGoal(ctx: Context & { readonly pending?: Usage }, args: unknown): Promise<Result> {
  if (ctx.persistent === false) return fail(PERSISTENT_THREAD_REQUIRED)
  const request = GoalArgs.update(args)
  if (!request.ok) return fail(request.message)
  const status = request.value.status
  if (status !== "complete" && status !== "blocked" && status !== "paused") return fail(UPDATE_STATUS_REJECTED)

  if (ctx.pending) {
    const accounted = await attempt(
      account({
        store: ctx.store,
        sessionID: ctx.sessionID,
        ...ctx.pending,
        mode: status === "complete" ? "activeOrComplete" : "activeOrStopped",
        now: ctx.now,
      }),
      "failed to account goal progress",
    )
    if (!accounted.ok) return accounted
  }

  const current = await attempt(ctx.store.get(ctx.sessionID), "failed to update goal")
  if (!current.ok) return current
  if (!current.value) return fail(NO_GOAL)
  const goal = { ...current.value, status: statusAfterUpdate(current.value, status), updatedAt: clock(ctx) }
  const written = await attempt(ctx.store.set(ctx.sessionID, goal), "failed to update goal")
  if (!written.ok) return written
  return succeed(response(goal, status === "complete"))
}

/** `GoalToolResponse::new`; the completion report is only offered when `update_goal` marked the goal complete. */
export function response(goal: Goal | undefined, includeCompletionReport: boolean): Response {
  const protocol = goal ? toProtocol(goal) : null
  return {
    goal: protocol,
    remainingTokens: goal?.tokenBudget === undefined ? null : Math.max(goal.tokenBudget - goal.tokensUsed, 0),
    completionBudgetReport:
      includeCompletionReport && protocol && protocol.status === "complete" ? completionBudgetReport(protocol) : null,
  }
}

export function toProtocol(goal: Goal): ProtocolGoal {
  return {
    threadId: goal.sessionID,
    objective: goal.objective,
    status: goal.status,
    ...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: Math.floor(goal.createdAt / 1000),
    updatedAt: Math.floor(goal.updatedAt / 1000),
  }
}

/** `validate_thread_goal_objective`, applied after trimming. Length counts Unicode scalar values like `chars()`. */
export function validateObjective(objective: string) {
  if (objective === "") return "goal objective must not be empty"
  if ([...objective].length > MAX_OBJECTIVE_CHARS)
    return `goal objective must be at most ${MAX_OBJECTIVE_CHARS} characters`
  return undefined
}

/** `validate_goal_budget`. */
export function validateBudget(value: number | undefined, max: number | undefined) {
  if (value !== undefined && value <= 0) return "goal budgets must be positive when provided"
  if (value !== undefined && max !== undefined && value > max)
    return `goal token budget ${value} exceeds the maximum allowed goal token budget of ${max}`
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Accounting (accounting.rs, state/runtime/goals.rs `account_thread_goal_usage`)

export interface TokenUsage {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
}

/** `goal_token_delta_for_usage`: uncached input plus output; reasoning is already inside output. */
export function usageTokens(usage: TokenUsage) {
  return usage.inputTokens - usage.cachedInputTokens + Math.max(usage.outputTokens, 0)
}

/** `token_delta_since_last_accounting`: the goal tokens between two cumulative usage readings of one turn. */
export function usageDelta(previous: TokenUsage, current: TokenUsage) {
  return usageTokens({
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
  })
}

export interface AccountInput extends Usage {
  readonly store: Store
  readonly sessionID: string
  /** Defaults to `activeOnly`, which Codex uses at tool finish, turn stop, turn abort and turn error. */
  readonly mode?: AccountingMode
  readonly now?: () => number
}

export interface AccountResult {
  /** The stored goal after the call (unchanged when nothing was charged). */
  readonly goal: Goal | undefined
  /** Whether a progress write happened (`GoalAccountingOutcome::Updated`). */
  readonly updated: boolean
  /** This charge moved the goal from another status to `budgetLimited`: inject `budgetLimitMessage` once. */
  readonly reachedBudgetLimit: boolean
  /** Elapsed time not yet charged: Codex charges whole seconds and keeps the remainder; add it to the next `elapsedMs`. */
  readonly carryMs: number
}

/**
 * Charges token and elapsed-time progress to the session's goal (`account_thread_goal_usage`). Whole seconds are charged
 * and the sub-second remainder is returned as `carryMs`. Crossing the token budget while the status is eligible moves
 * the goal to `budgetLimited`; a budget-limited goal keeps accruing usage in modes that include it.
 */
export async function account(input: AccountInput): Promise<AccountResult> {
  const seconds = Math.max(Math.floor(input.elapsedMs / 1000), 0)
  const tokens = Math.max(input.tokens, 0)
  const goal = await input.store.get(input.sessionID)
  const idle = { goal, updated: false, reachedBudgetLimit: false }
  if (seconds === 0 && tokens === 0) return { ...idle, carryMs: Math.max(input.elapsedMs, 0) }
  const mode = input.mode ?? "activeOnly"
  if (!goal || !CHARGEABLE[mode].includes(goal.status)) return { ...idle, carryMs: 0 }
  if (input.goalID !== undefined && goal.goalID !== input.goalID) return { ...idle, carryMs: 0 }

  const tokensUsed = goal.tokensUsed + tokens
  const exhausted = goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget
  const next: Goal = {
    ...goal,
    tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds + seconds,
    status: exhausted && BUDGET_LIMITABLE[mode].includes(goal.status) ? "budgetLimited" : goal.status,
    updatedAt: (input.now ?? Date.now)(),
  }
  await input.store.set(input.sessionID, next)
  return {
    goal: next,
    updated: true,
    reachedBudgetLimit: goal.status !== "budgetLimited" && next.status === "budgetLimited",
    carryMs: input.elapsedMs - seconds * 1000,
  }
}

const STOPPED: readonly Status[] = ["active", "paused", "blocked", "usageLimited", "budgetLimited"]
const CHARGEABLE: Record<AccountingMode, readonly Status[]> = {
  activeStatusOnly: ["active"],
  activeOnly: ["active", "budgetLimited"],
  activeOrComplete: ["active", "budgetLimited", "complete"],
  activeOrStopped: STOPPED,
}
const BUDGET_LIMITABLE: Record<AccountingMode, readonly Status[]> = {
  activeStatusOnly: ["active"],
  activeOnly: ["active"],
  activeOrComplete: ["active"],
  activeOrStopped: STOPPED,
}

/**
 * System status changes from `stop_active_goal_for_turn` (turn error -> `blocked`, usage limit -> `usageLimited`,
 * three failed-exec or empty continuation turns -> `blocked`) and the TUI's pause on user interrupt (`paused`). Only an
 * active goal stops; a budget-limited goal may still become `usageLimited`. Returns the stored goal after the call.
 */
export async function stop(input: {
  readonly store: Store
  readonly sessionID: string
  readonly status: "blocked" | "usageLimited" | "paused"
  readonly goalID?: string
  readonly now?: () => number
}) {
  const goal = await input.store.get(input.sessionID)
  if (!goal) return undefined
  if (input.goalID !== undefined && goal.goalID !== input.goalID) return goal
  const stoppable = goal.status === "active" || (goal.status === "budgetLimited" && input.status === "usageLimited")
  if (!stoppable) return goal
  const next = { ...goal, status: input.status, updatedAt: (input.now ?? Date.now)() }
  await input.store.set(input.sessionID, next)
  return next
}

// ---------------------------------------------------------------------------------------------------------------------
// Steering (steering.rs, runtime.rs `continue_if_idle`, extension.rs turn hooks)
//
// How Codex keeps working on an active goal (rust-v0.162.1):
//
// - When a turn ends and the thread goes idle (`on_thread_idle`, after `on_turn_stop`/`on_turn_abort`), the goal
//   runtime's `continue_if_idle` reads the goal and, when its status is `active`, starts a new turn by itself through
//   `start_turn_if_idle` with `turn_trigger: "goal"`. The only input of that turn is one hidden user message:
//   `<codex_internal_context source="goal">\n` + the rendered `goals/continuation.md` + `\n</codex_internal_context>`
//   (see `continuationMessage`). The template's "Progress visibility:" paragraph is dropped when `update_plan` is
//   disabled (`without_update_plan_instructions`). The objective is XML-escaped (`&`, `<`, `>`); a missing budget
//   renders as `none` and its remaining tokens as `unbounded`.
// - No continuation starts when: the goal is missing or not `active` (paused, blocked, complete, budgetLimited,
//   usageLimited); goal tools are unavailable (disabled, ephemeral thread, review sub-agent); a continuation deferral
//   is recorded (set when a goal snapshot is restored, cleared at the next turn start); the collaboration mode is Plan;
//   queued user input or another trigger turn is pending; a turn is already running; the server is draining.
// - Plan-mode turns neither charge usage nor count as goal turns.
// - Turn error: usage-limit errors set `usageLimited` (also from `budgetLimited`); any other terminal error sets
//   `blocked` so continuation cannot loop on a persistent failure. Usage is charged first.
// - Three consecutive goal turns whose `exec` tool failed after its handler ran, with no successful tool in that turn,
//   set `blocked`; a successful tool resets the count and a turn without failed exec leaves it unchanged.
// - Three consecutive automatic continuation turns that end with an empty final answer and no other activity (tool
//   calls, non-empty text or reasoning summary) set `blocked`; any other turn, an abort, or a new goal resets the count.
//   Since rust-v0.164.0 (#52640) an automatic continuation interrupted without activity counts too, whatever its final
//   answer; the interruption is evaluated once the thread is idle, and a continuation follows while the limit is not
//   reached. own counts the stops that are no user's (another agent's `interrupt_agent`, kind `aborted`): a user's stop
//   pauses the goal, as the Codex TUI does, so its count never matters.
// - The token budget: usage is charged at every tool finish and at turn stop. Crossing the budget sets `budgetLimited`
//   (no further continuations); the first time a tool finish observes that, `goals/budget_limit.md` is injected into the
//   running turn (`budgetLimitMessage`) telling the model to wrap up. Usage keeps accruing until the turn stops.
// - The "blocked audit" (three consecutive turns with the same blocker) is not enforced by code: it is an instruction in
//   the continuation prompt and the `update_goal` description, and the model reports it with `update_goal` `blocked`.
// - Abort (user interrupt): usage is charged and the empty-turn count resets; the Codex TUI then pauses an active goal
//   (`pause_active_goal_for_interrupt`), so no continuation follows.
// - Objective edits by the user inject `goals/objective_updated.md` into the running turn (`objectiveUpdatedMessage`).

export interface LoopState {
  readonly goalID?: string
  readonly emptyTurns: number
  readonly failedExecTurns: number
}

export const INITIAL_LOOP: LoopState = { emptyTurns: 0, failedExecTurns: 0 }

export interface TurnOutcome {
  /**
   * How the turn ended: normal completion, a terminal error, a usage-limit error, a user interrupt, or an interrupt by
   * another cause (`aborted`: Codex's `TurnAbortReason::Interrupted` that no TUI turns into a pause).
   */
  readonly kind: "completed" | "error" | "usageLimit" | "interrupted" | "aborted"
  /** The turn was started by a goal continuation (`turn_trigger: "goal"`), not by the user. */
  readonly automatic?: boolean
  /** The final answer (or a message without phase) had no non-whitespace text. */
  readonly emptyFinal?: boolean
  /** Any tool call, non-empty message text, question, reasoning summary, or other turn item. */
  readonly activity?: boolean
  /** An `exec` tool call failed after its handler ran. */
  readonly failedExec?: boolean
  /** A tool call completed successfully. */
  readonly successfulTool?: boolean
  /** The turn ran in Plan collaboration mode. */
  readonly planMode?: boolean
  /** Queued user input or another trigger turn is waiting. */
  readonly pendingInput?: boolean
  /** `update_plan` is available; selects the continuation text variant. Defaults to true. */
  readonly updatePlan?: boolean
}

export type StopReason =
  | "noGoal"
  | "inactive"
  | "planMode"
  | "pendingInput"
  | "turnError"
  | "usageLimit"
  | "executionUnavailable"
  | "emptyResponse"
  | "interrupted"

export type Action =
  | { readonly continue: true; readonly message: string; readonly loop: LoopState }
  | {
      readonly continue: false
      readonly reason: StopReason
      /** A status the caller should apply with `stop` before going idle. */
      readonly stop?: "blocked" | "usageLimited" | "paused"
      readonly loop: LoopState
    }

/**
 * Decides what follows a finished turn. `goal` is the stored goal after the turn's usage was charged with `account`;
 * `loop` carries Codex's per-session counters between turns (start with `INITIAL_LOOP`, keep the returned `loop`).
 */
export function nextAction(goal: Goal | undefined, outcome: TurnOutcome, loop: LoopState = INITIAL_LOOP): Action {
  if (!goal) return { continue: false, reason: "noGoal", loop: INITIAL_LOOP }
  const counters = loop.goalID === goal.goalID ? loop : { ...INITIAL_LOOP, goalID: goal.goalID }
  const reset = { ...INITIAL_LOOP, goalID: goal.goalID }
  const goalTurn = !outcome.planMode && (goal.status === "active" || goal.status === "budgetLimited")

  if (outcome.kind === "usageLimit" && goalTurn)
    return { continue: false, reason: "usageLimit", stop: "usageLimited", loop: reset }
  if (outcome.kind === "error" && goalTurn && goal.status === "active")
    return { continue: false, reason: "turnError", stop: "blocked", loop: reset }
  if (outcome.kind === "interrupted") {
    if (goal.status === "active") return { continue: false, reason: "interrupted", stop: "paused", loop: reset }
    return { continue: false, reason: "interrupted", loop: { ...counters, emptyTurns: 0 } }
  }
  if (outcome.kind !== "completed" && outcome.kind !== "aborted")
    return {
      continue: false,
      reason: goal.status === "active" && outcome.planMode ? "planMode" : "inactive",
      loop: counters,
    }

  // Codex judges failed exec only when a turn stops (`on_turn_stop`), not when it is interrupted.
  const aborted = outcome.kind === "aborted"
  const failedExecTurns =
    !goalTurn || aborted
      ? counters.failedExecTurns
      : outcome.successfulTool
        ? 0
        : outcome.failedExec
          ? counters.failedExecTurns + 1
          : counters.failedExecTurns
  if (failedExecTurns >= 3 && goal.status === "active")
    return { continue: false, reason: "executionUnavailable", stop: "blocked", loop: reset }
  // accounting.rs `empty_response_goal`: `automatic && !has_activity && (empty_final || interrupted)` (#52640).
  const empty = goalTurn && !!outcome.automatic && !outcome.activity && (aborted || !!outcome.emptyFinal)
  const emptyTurns = empty ? counters.emptyTurns + 1 : 0
  if (emptyTurns >= 3 && goal.status === "active")
    return { continue: false, reason: "emptyResponse", stop: "blocked", loop: reset }

  const next = { goalID: goal.goalID, emptyTurns, failedExecTurns }
  if (goal.status !== "active") return { continue: false, reason: "inactive", loop: next }
  if (outcome.planMode) return { continue: false, reason: "planMode", loop: next }
  if (outcome.pendingInput) return { continue: false, reason: "pendingInput", loop: next }
  return { continue: true, message: continuationMessage(goal, outcome.updatePlan ?? true), loop: next }
}

/** The hidden user message of an automatic continuation turn. */
export function continuationMessage(goal: Goal, updatePlan = true) {
  return internalContext(continuationPrompt(goal, updatePlan))
}

/** Injected into the running turn the first time a tool finish finds the goal `budgetLimited`. */
export function budgetLimitMessage(goal: Goal) {
  return internalContext(budgetLimitPrompt(goal))
}

/** Injected into the running turn when the user edits the objective of an active goal. */
export function objectiveUpdatedMessage(goal: Goal) {
  return internalContext(objectiveUpdatedPrompt(goal))
}

export function continuationPrompt(goal: Goal, updatePlan = true) {
  return render(updatePlan ? CONTINUATION : withoutUpdatePlan(CONTINUATION), {
    objective: escapeXml(goal.objective),
    tokens_used: String(goal.tokensUsed),
    token_budget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
    remaining_tokens:
      goal.tokenBudget === undefined ? "unbounded" : String(Math.max(goal.tokenBudget - goal.tokensUsed, 0)),
  })
}

export function budgetLimitPrompt(goal: Goal) {
  return render(BUDGET_LIMIT, {
    objective: escapeXml(goal.objective),
    time_used_seconds: String(goal.timeUsedSeconds),
    tokens_used: String(goal.tokensUsed),
    token_budget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
  })
}

export function objectiveUpdatedPrompt(goal: Goal) {
  return render(OBJECTIVE_UPDATED, {
    objective: escapeXml(goal.objective),
    tokens_used: String(goal.tokensUsed),
    token_budget: goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget),
    remaining_tokens:
      goal.tokenBudget === undefined ? "unknown" : String(Math.max(goal.tokenBudget - goal.tokensUsed, 0)),
  })
}

/** `InternalModelContextFragment::render` with source `goal`. */
export function internalContext(prompt: string) {
  return `<codex_internal_context source="goal">\n${prompt}\n</codex_internal_context>`
}

// ---------------------------------------------------------------------------------------------------------------------
// The user's `/goal` (codex-rs/tui chatwidget/slash_dispatch.rs `SlashCommand::Goal`, app/thread_goal_actions.rs, and
// app-server thread_goal_processor.rs `thread/goal/set`/`thread/goal/clear` with origin `User`, rust-v0.165.0). In
// own the command runs on the server, so it cannot ask before replacing a goal as the TUI does: a new objective
// replaces whatever goal the session has (the TUI's `ReplaceExisting`), and `edit` (the TUI's goal editor) only says
// how to replace it. The words are own's (Korean, the user's), the rules Codex's.

/** What a user's `/goal` asks for: the argument as typed, `pause`/`resume`/`clear`/`edit` in any case. */
export type UserCommand =
  | { readonly kind: "show" }
  | { readonly kind: "edit" }
  | { readonly kind: "clear" }
  | { readonly kind: "status"; readonly status: "paused" | "active" }
  | { readonly kind: "set"; readonly objective: string }

export function userCommand(text: string): UserCommand {
  const argument = trimRust(text)
  const control = argument.toLowerCase()
  if (argument === "") return { kind: "show" }
  if (control === "edit") return { kind: "edit" }
  if (control === "clear") return { kind: "clear" }
  if (control === "pause") return { kind: "status", status: "paused" }
  if (control === "resume") return { kind: "status", status: "active" }
  return { kind: "set", objective: argument }
}

export const USER_USAGE = "사용법: /goal <목표> · /goal pause · /goal resume · /goal clear"
export const USER_EDIT = "목표를 바꾸려면 /goal <새 목표>를 보내세요. 지금 목표를 새 목표로 바꿔요."
export const USER_NO_GOAL = "이 대화에는 목표가 없어요."
export const USER_COMPLETE = "이미 이룬 목표예요. 새 목표는 /goal <목표>로 정해요."
export const USER_TOO_LONG = `목표는 ${MAX_OBJECTIVE_CHARS.toLocaleString("en-US")}자까지 쓸 수 있어요.`

const STATUS_LABEL: Record<Status, string> = {
  active: "진행 중",
  paused: "멈춤",
  blocked: "막힘",
  budgetLimited: "예산을 다 씀",
  usageLimited: "사용 한도에 걸림",
  complete: "이룸",
}

/** The answer to an empty `/goal` (the TUI's goal menu, as text): the goal, its status and usage, and the usage line. */
export function describeForUser(goal: Goal | undefined) {
  if (!goal) return `${USER_NO_GOAL}\n${USER_USAGE}`
  const tokens = goal.tokenBudget === undefined ? `${goal.tokensUsed}` : `${goal.tokensUsed}/${goal.tokenBudget}`
  return `목표(${STATUS_LABEL[goal.status]}): ${goal.objective}\n토큰 ${tokens} · ${goal.timeUsedSeconds}초\n${USER_USAGE}`
}

/**
 * `/goal <objective>`: a new active goal with no budget replaces any goal of the session, with its usage (the TUI clears
 * the old goal first, then sets the new one; `token_budget` none keeps none). Fails with own's words.
 */
export async function setByUser(ctx: Context, objective: string) {
  if ([...objective].length > MAX_OBJECTIVE_CHARS) return { ok: false as const, message: USER_TOO_LONG }
  const now = clock(ctx)
  const goal: Goal = {
    goalID: ctx.newGoalID?.() ?? crypto.randomUUID(),
    sessionID: ctx.sessionID,
    objective,
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  }
  await ctx.store.set(ctx.sessionID, goal)
  return { ok: true as const, goal }
}

/**
 * `/goal pause` and `/goal resume` (`thread/goal/set` with only a status). Resuming a goal over its budget leaves it
 * `budgetLimited`, as `set_thread_goal` does. A complete goal stays complete.
 */
export async function statusByUser(ctx: Context, status: "paused" | "active") {
  const current = await ctx.store.get(ctx.sessionID)
  if (!current) return { ok: false as const, message: USER_NO_GOAL }
  if (current.status === "complete") return { ok: false as const, message: USER_COMPLETE }
  const goal: Goal = {
    ...current,
    status: statusAfterBudgetLimit(status, current.tokensUsed, current.tokenBudget),
    updatedAt: clock(ctx),
  }
  await ctx.store.set(ctx.sessionID, goal)
  return { ok: true as const, goal }
}

/** `/goal clear` (`thread/goal/clear`): removes the session's goal, or says there is none. */
export async function clearByUser(ctx: Context) {
  if (!(await ctx.store.get(ctx.sessionID))) return { ok: false as const, message: USER_NO_GOAL }
  await ctx.store.set(ctx.sessionID, undefined)
  return { ok: true as const }
}

// ---------------------------------------------------------------------------------------------------------------------

function succeed(value: Response): Result {
  return { ok: true, value, output: JSON.stringify(value) }
}

function fail(message: string): Result {
  return { ok: false, message }
}

/** Store failures become the model-facing `failed to …: {err}` texts Codex returns for state-db errors. */
async function attempt<T>(promise: Promise<T>, prefix: string) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      message: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    }),
  )
}

function clock(ctx: Context) {
  return (ctx.now ?? Date.now)()
}

function statusAfterBudgetLimit(status: Status, tokensUsed: number, tokenBudget: number | undefined): Status {
  if (status === "active" && tokenBudget !== undefined && tokensUsed >= tokenBudget) return "budgetLimited"
  return status
}

/** The status `CASE` of `update_thread_goal`: budget limits take precedence over pausing or blocking. */
function statusAfterUpdate(goal: Goal, status: Status): Status {
  if (goal.status === "budgetLimited" && (status === "paused" || status === "blocked")) return goal.status
  return statusAfterBudgetLimit(status, goal.tokensUsed, goal.tokenBudget)
}

function completionBudgetReport(goal: ProtocolGoal) {
  if (goal.tokenBudget === undefined && goal.timeUsedSeconds <= 0) return null
  return COMPLETION_BUDGET_REPORT
}

/** Rust's `str::trim`: strips Unicode `White_Space`, which differs from `String.prototype.trim` (U+0085, U+FEFF). */
function trimRust(value: string) {
  return value.replace(RUST_WHITESPACE_EDGES, "")
}

const RUST_WHITESPACE = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]"
const RUST_WHITESPACE_EDGES = new RegExp(`^${RUST_WHITESPACE}+|${RUST_WHITESPACE}+$`, "g")

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** `codex_utils_template::Template::render` for the `{{ name }}` placeholders these templates use. */
function render(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name: string) => values[name] ?? "")
}

/** `without_update_plan_instructions` as it applies to continuation.md: drops the "Progress visibility:" paragraph. */
function withoutUpdatePlan(template: string) {
  return template.replace(/^Progress visibility:\nIf update_plan is available[^\n]*\n\n?/m, "")
}
