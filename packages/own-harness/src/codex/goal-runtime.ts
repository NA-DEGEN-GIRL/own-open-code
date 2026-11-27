// Codex's goal extension (codex-rs/ext/goal, rust-v0.162.1) on own sessions: the goal lives in the plugin's storage, the
// tools are Codex's (Direct `get_goal`/`create_goal`/`update_goal`, and the same nested in Code Mode's `exec`), usage
// is charged at every step end and at the end of the turn, and an active goal continues the session with Codex's hidden
// continuation message when a turn ends. The rules themselves are in goals/index.ts.
export * as GoalRuntime from "./goal-runtime.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Schema as EffectSchema } from "effect"
import type { Session } from "@opencode/schema/session"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { Gate } from "../gate.js"
import { Goals } from "./goals/index.js"
import { CodexTools } from "./tools.js"

type Ctx = Pick<Context, "storage" | "session" | "tool">

export const TOOLS = [Goals.GET_GOAL_TOOL_NAME, Goals.CREATE_GOAL_TOOL_NAME, Goals.UPDATE_GOAL_TOOL_NAME] as const

/** The metadata `source` of the continuation and budget messages own sends for a goal. */
export const SOURCE = "own.harness.goal"

interface TurnState {
  /** Started by a goal continuation (Codex's `turn_trigger: "goal"`). */
  automatic: boolean
  /**
   * When the turn's latest step started (core's dispatch time), else the run: the goal's messages report the turn's
   * work (core P-035's `startedAt`). A context reset applies only between turns, so a reset since then is one since the
   * turn started. A run can hold more than one turn: a reset it waited for applies at the first one's end, and the
   * input admitted behind it starts the next, whose messages report work in the new context.
   */
  startedAt: number
  /** Wall-clock time not charged yet: since the turn started or the last charge, plus Codex's sub-second carry. */
  chargedAt: number
  carryMs: number
}

/** Goal state of the sessions this plugin instance sees; the goals themselves are durable in storage. */
export class Runtime {
  private readonly turns = new Map<string, TurnState>()
  private readonly loops = new Map<string, Goals.LoopState>()
  private readonly pendingAutomatic = new Set<string>()
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Sessions whose turn another agent is stopping: that interrupt is no user's (`stopping`). */
  private readonly agentStops = new Set<string>()
  readonly store: Goals.Store

  constructor(private readonly ctx: Ctx) {
    this.store = {
      get: (sessionID) =>
        Effect.runPromise(ctx.storage.get(key(sessionID))).then((value) => (value ?? undefined) as Goals.Goal | undefined),
      set: (sessionID, goal) =>
        Effect.runPromise(
          goal === undefined
            ? ctx.storage.remove(key(sessionID))
            : ctx.storage.set(key(sessionID), goal as unknown as EffectSchema.Json),
        ),
    }
  }

  /** Runs `work` after the session's earlier goal work; Codex updates a goal under a per-thread lock. */
  serial<A>(sessionID: string, work: () => Promise<A>) {
    const previous = this.locks.get(sessionID) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.locks.set(
      sessionID,
      next.catch(() => undefined),
    )
    return next
  }

  context(sessionID: string): Goals.Context {
    return { store: this.store, sessionID }
  }

  started(sessionID: string) {
    const now = Date.now()
    this.turns.set(sessionID, {
      automatic: this.pendingAutomatic.delete(sessionID),
      startedAt: now,
      chargedAt: now,
      carryMs: this.turns.get(sessionID)?.carryMs ?? 0,
    })
  }

  /** A step of the session's turn started at `at` (`session.step.started`). */
  stepped(sessionID: string, at: number) {
    const turn = this.turns.get(sessionID)
    if (turn !== undefined) turn.startedAt = at
  }

  /** Charges a step's tokens and the time since the last charge; a goal that just hit its budget is told so at once. */
  charge(sessionID: Session.ID, tokens: number) {
    // The step that just ended: a later step may start (after a reset, in the new context) before the charge runs.
    const startedAt = this.turns.get(sessionID)?.startedAt
    if (startedAt === undefined) return Promise.resolve()
    return this.serial(sessionID, async () => {
      const turn = this.turns.get(sessionID)
      const now = Date.now()
      const elapsedMs = turn === undefined ? 0 : now - turn.chargedAt + turn.carryMs
      const result = await Goals.account({ store: this.store, sessionID, tokens, elapsedMs })
      if (turn !== undefined) {
        turn.chargedAt = now
        turn.carryMs = result.carryMs
      }
      if (result.reachedBudgetLimit && result.goal !== undefined)
        await Effect.runPromise(
          this.ctx.session.synthetic({
            sessionID,
            text: Goals.budgetLimitMessage(result.goal),
            description: "Goal budget reached",
            metadata: { source: SOURCE, kind: "budget-limit" },
            delivery: "steer",
            resume: false,
            // The step's work (core P-035, 11 §7.2): it reaches the turn a reset waits for, and waits for the next
            // input once a reset applied since that step.
            background: true,
            startedAt,
          }),
        ).catch(() => undefined)
    })
  }

  /**
   * After a turn (`undefined` when it ended for the process, not by itself): charge what is left, then continue an
   * active goal, or apply the stop Codex would (a user's interrupt pauses the goal; repeated empty, failing or
   * agent-interrupted automatic turns block it).
   */
  ended(sessionID: Session.ID, outcome: Omit<Goals.TurnOutcome, "automatic"> | undefined) {
    if (!this.turns.has(sessionID)) return Promise.resolve()
    return this.serial(sessionID, async () => {
      const turn = this.turns.get(sessionID)
      this.turns.delete(sessionID)
      const charged =
        turn === undefined
          ? undefined
          : await Goals.account({
              store: this.store,
              sessionID,
              tokens: 0,
              elapsedMs: Date.now() - turn.chargedAt + turn.carryMs,
            })
      // A turn that ended for the process (shutdown, a superseding run) is charged and nothing else.
      if (outcome === undefined) return
      const goal = charged?.goal ?? (await this.store.get(sessionID))
      const action = Goals.nextAction(
        goal,
        { ...outcome, automatic: turn?.automatic ?? false },
        this.loops.get(sessionID) ?? Goals.INITIAL_LOOP,
      )
      this.loops.set(sessionID, action.loop)
      if (!action.continue) {
        if (action.stop !== undefined) await Goals.stop({ store: this.store, sessionID, status: action.stop })
        return
      }
      this.pendingAutomatic.add(sessionID)
      await Effect.runPromise(
        this.ctx.session.synthetic({
          sessionID,
          text: action.message,
          description: "Continue the goal",
          metadata: { source: SOURCE, kind: "continuation" },
          // The turn's work (core P-035, 11 §7.2): a reset that waited for this turn applied at its end, after its
          // last step, so the continuation waits for the next input; a turn that ran after the reset continues there.
          background: true,
          ...(turn === undefined ? {} : { startedAt: turn.startedAt }),
        }),
      ).catch(() => this.pendingAutomatic.delete(sessionID))
    })
  }

  forget(sessionID: string) {
    this.turns.delete(sessionID)
    this.loops.delete(sessionID)
    this.pendingAutomatic.delete(sessionID)
    this.agentStops.delete(sessionID)
  }

  /**
   * Another agent is about to stop the session's turn (collab trees' `interrupt_agent`, v1 `send_input` with
   * `interrupt`). Core records every stop through its API as the user's; this mark makes the next one an `aborted`
   * turn, which counts toward the goal's empty-turn limit (#52640) instead of pausing the goal. The returned function
   * takes the mark back when no turn was running.
   */
  stopping(sessionID: string) {
    this.agentStops.add(sessionID)
    return () => void this.agentStops.delete(sessionID)
  }

  /** Whether the session's turn that just stopped for "the user" was stopped by an agent; reads the mark once. */
  stoppedByAgent(sessionID: string) {
    return this.agentStops.delete(sessionID)
  }

  /**
   * The user's `/goal` in a codex session (`Goals.userCommand`, MR8-15). A goal that becomes active continues at once
   * when the session is idle (Codex's `continue_if_idle` after `thread/goal/set`), else when the running turn ends; a
   * new goal starts the empty and failed-exec counts afresh. An empty `/goal` and `edit` fail with the text to show,
   * as core's `/goal` answers its own empty form.
   */
  user(sessionID: Session.ID, text: string): Promise<UserResult> {
    return this.serial(sessionID, async () => {
      const context = this.context(sessionID)
      const command = Goals.userCommand(text)
      if (command.kind === "show") return failed(Goals.describeForUser(await this.store.get(sessionID)))
      if (command.kind === "edit") return failed(Goals.USER_EDIT)
      if (command.kind === "clear") {
        const cleared = await Goals.clearByUser(context)
        if (cleared.ok) this.loops.delete(sessionID)
        return cleared
      }
      const changed =
        command.kind === "set"
          ? await Goals.setByUser(context, command.objective)
          : await Goals.statusByUser(context, command.status)
      if (!changed.ok) return changed
      if (command.kind === "set") this.loops.delete(sessionID)
      if (changed.goal.status !== "active" || this.turns.has(sessionID)) return DONE
      this.pendingAutomatic.add(sessionID)
      await Effect.runPromise(
        this.ctx.session.synthetic({
          sessionID,
          text: Goals.continuationMessage(changed.goal),
          description: "Continue the goal",
          metadata: { source: SOURCE, kind: "continuation" },
        }),
      ).catch(() => this.pendingAutomatic.delete(sessionID))
      return DONE
    })
  }

  /** The three tools' handlers, shared by the Direct tools and Code Mode's nested ones. */
  call(name: string, sessionID: string, args: unknown) {
    return this.serial(sessionID, () => {
      const context = this.context(sessionID)
      if (name === Goals.GET_GOAL_TOOL_NAME) return Goals.getGoal(context)
      if (name === Goals.CREATE_GOAL_TOOL_NAME) return Goals.createGoal(context, args)
      return Goals.updateGoal(context, args)
    })
  }
}

const key = (sessionID: string) => `goal/${sessionID}`

type UserResult = { readonly ok: true } | { readonly ok: false; readonly message: string }
const DONE: UserResult = { ok: true }
const failed = (message: string): UserResult => ({ ok: false, message })

/** The command core's goal plugin registers (upstream v2.2, #59437) and this one wraps. */
export const COMMAND = "goal"

/** A `/goal` with files, agents or skills in a codex session: Codex's goal takes the objective's text only here. */
export const ATTACHED = "목표에는 글만 넣을 수 있어요. 파일·에이전트·스킬은 목표를 정한 뒤 보내세요."

/** `/goal` where core has no `/goal` and the session is no codex session. */
export const UNAVAILABLE = "이 대화에서는 /goal을 쓸 수 없어요."

/**
 * `/goal` (MR8-15): in a codex session it is Codex's own `/goal` on this harness's goals ({@link Runtime.user}), so a
 * Codex goal and its tools stay one goal; in every other session it is core's `/goal` loop, which this wraps
 * (core P-038's `get` reads it). The listed description stays core's; own-web words each harness's own.
 */
export const command = (
  ctx: Pick<Context, "command">,
  runtime: Runtime,
  codex: (sessionID: Session.ID) => Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    yield* ctx.command.transform((editor) => {
      const core = editor.get(COMMAND)
      editor.add({
        name: COMMAND,
        ...(core?.description === undefined ? {} : { description: core.description }),
        execute: (input) =>
          codex(input.sessionID).pipe(
            Effect.flatMap((mine) => {
              if (!mine) return core ? core.execute(input) : Effect.fail(new Error(UNAVAILABLE))
              const attached = [input.prompt.files, input.prompt.agents, input.prompt.skills].some(
                (items) => items !== undefined && items.length > 0,
              )
              if (attached) return Effect.fail(new Error(ATTACHED))
              return Effect.promise(() => runtime.user(input.sessionID, input.prompt.text)).pipe(
                Effect.flatMap((result) => (result.ok ? Effect.void : Effect.fail(new Error(result.message)))),
              )
            }),
          ),
      })
    })
    yield* ctx.command.reload()
  })

/** Codex's goal tokens of one step: uncached input plus output (own counts reasoning and cache writes apart). */
export function stepTokens(tokens: {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}) {
  return tokens.input + tokens.cache.write + tokens.output + tokens.reasoning
}

export const register = (ctx: Ctx, runtime: Runtime) =>
  ctx.tool.transform((editor) => {
    TOOLS.forEach((name) => {
      const spec = CodexTools.definition(name)
      editor.add({
        name,
        description: spec.description ?? "",
        input: (spec.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
        options: { codemode: false, permission: Gate.ACTION },
        execute: (raw: unknown, tool: Tool.Context) =>
          Effect.promise(() => runtime.call(name, tool.sessionID, raw)).pipe(
            Effect.map((result) => ({
              content: result.ok ? result.output : result.message,
              metadata: { truncated: true },
            })),
          ),
      })
    })
  })

/**
 * What a turn's messages say about it, for {@link Runtime.ended}: Codex's empty-answer and failed-exec rules. The turn
 * starts at the user's last message or the goal's last continuation, the inputs that open a turn in Codex (user input,
 * `turn_trigger: "goal"`). Every other synthetic message is hidden or system input that stays in the turn before it:
 * core's continuations after a cut answer, Code Mode's `notify` steers, background shell and subagent results, agent
 * messages, harness notices and the goal's own budget steer arrive in a running turn, or wake an idle session for work
 * Codex opens no turn for (10 §6.4).
 */
export function outcome(
  messages: ReadonlyArray<{
    readonly type: string
    readonly content?: unknown
    readonly metadata?: Readonly<Record<string, unknown>>
  }>,
  kind: Goals.TurnOutcome["kind"],
  planMode: boolean,
): Omit<Goals.TurnOutcome, "automatic"> {
  const start = messages.findLastIndex(
    (message) =>
      message.type === "user" ||
      (message.type === "synthetic" && message.metadata?.source === SOURCE && message.metadata.kind === "continuation"),
  )
  const parts = messages
    .slice(start + 1)
    .flatMap((message) =>
      message.type === "assistant" && Array.isArray(message.content)
        ? (message.content as ReadonlyArray<{ type: string; text?: string; name?: string; state?: { status: string } }>)
        : [],
    )
  const tools = parts.filter((part) => part.type === "tool")
  const last = parts.findLast((part) => part.type === "text")
  return {
    kind,
    planMode,
    emptyFinal: (last?.text ?? "").trim() === "",
    activity: tools.length > 0 || parts.some((part) => part.type !== "tool" && (part.text ?? "").trim() !== ""),
    failedExec: tools.some((part) => part.name === "exec" && part.state?.status === "error"),
    successfulTool: tools.some((part) => part.state?.status === "completed"),
  }
}
