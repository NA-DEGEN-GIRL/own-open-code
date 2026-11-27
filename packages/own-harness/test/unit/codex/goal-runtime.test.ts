// The goal runtime's turn reading (src/codex/goal-runtime.ts `outcome`): the turn starts at the user's last message or
// the goal's last continuation; every other synthetic message (core's continuations after a cut answer, Code Mode's
// notify steers, background shell results, the goal's own budget steer) stays inside the turn it arrives in.
import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { CodeModeTools } from "../../../src/codex/code-mode-tools.js"
import { GoalRuntime } from "../../../src/codex/goal-runtime.js"
import { Goals } from "../../../src/codex/goals/index.js"

const user = (text: string) => ({ type: "user", text })
const assistant = (...content: Array<{ type: string; text?: string; name?: string; state?: { status: string } }>) => ({
  type: "assistant",
  content,
})
const exec = (status: string) => ({ type: "tool", name: "exec", state: { status } })
const synthetic = (text: string, description?: string, metadata?: Record<string, unknown>) => ({
  type: "synthetic",
  text,
  ...(description === undefined ? {} : { description }),
  ...(metadata === undefined ? {} : { metadata }),
})

/** The goal continuation `Runtime.ended` sends: Codex's hidden message with the goal's metadata. */
const GOAL: Goals.Goal = {
  goalID: "goal_1",
  sessionID: "ses_1",
  objective: "Write the release notes",
  status: "active",
  tokenBudget: 1000,
  tokensUsed: 1200,
  timeUsedSeconds: 60,
  createdAt: 0,
  updatedAt: 0,
}
const continuation = synthetic(Goals.continuationMessage(GOAL), "Continue the goal", {
  source: GoalRuntime.SOURCE,
  kind: "continuation",
})

describe("GoalRuntime.outcome", () => {
  test("hidden and system synthetics arriving mid-turn do not start a turn", () => {
    for (const steered of [
      // Core's continuations after a cut answer (core/src/session/runner/llm.ts): no description, no metadata.
      synthetic(
        "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.",
      ),
      synthetic(
        "The previous response was interrupted. Continue from where you left off without repeating completed content.",
      ),
      // Code Mode's `notify(...)` steer (code-mode-tools.ts `notify`).
      synthetic(CodeModeTools.notification("call_1", "half way"), "exec notify", {
        source: CodeModeTools.NOTIFY_SOURCE,
        callID: "call_1",
      }),
      // A background shell's completion (core/src/shell/result.ts `notification`).
      synthetic('<shell id="job_1" state="completed" command="bun test">\nok\n</shell>', "bun test", {
        source: "shell",
        shellID: "sh_1",
        jobID: "job_1",
        state: "completed",
      }),
      // The goal's own budget steer (`Runtime.charge`).
      synthetic(Goals.budgetLimitMessage(GOAL), "Goal budget reached", {
        source: GoalRuntime.SOURCE,
        kind: "budget-limit",
      }),
    ]) {
      const outcome = GoalRuntime.outcome(
        [
          user("Do the work."),
          assistant(exec("error"), { type: "text", text: "Partial answer" }),
          steered,
          assistant({ type: "text", text: "" }),
        ],
        "completed",
        false,
      )
      // The exec failure before the steered message still belongs to the turn.
      expect(outcome).toEqual({
        kind: "completed",
        planMode: false,
        emptyFinal: true,
        activity: true,
        failedExec: true,
        successfulTool: false,
      })
    }
  })

  test("the user's message and the goal's continuation start a turn", () => {
    for (const start of [user("Next step."), continuation]) {
      const outcome = GoalRuntime.outcome(
        [user("Do the work."), assistant(exec("error")), start, assistant({ type: "text", text: "Done." })],
        "completed",
        false,
      )
      expect(outcome.failedExec).toBe(false)
      expect(outcome.emptyFinal).toBe(false)
      expect(outcome.activity).toBe(true)
    }
  })

  test("a steer after the goal's continuation stays in the automatic turn it opened", () => {
    const outcome = GoalRuntime.outcome(
      [
        user("Do the work."),
        assistant({ type: "text", text: "Started." }),
        continuation,
        assistant(exec("error")),
        synthetic(CodeModeTools.notification("call_2", "still going"), "exec notify", {
          source: CodeModeTools.NOTIFY_SOURCE,
          callID: "call_2",
        }),
        assistant({ type: "text", text: "" }),
      ],
      "completed",
      false,
    )
    expect(outcome.failedExec).toBe(true)
    expect(outcome.emptyFinal).toBe(true)
  })
})

describe("GoalRuntime.Runtime messages (core P-035, 11 §7.2)", () => {
  /** A runtime over in-memory storage that records the synthetic messages it admits. */
  function setup() {
    const storage = new Map<string, unknown>()
    const admitted: Array<{
      readonly metadata?: { readonly kind?: string }
      readonly background?: boolean
      readonly startedAt?: number
    }> = []
    const ctx = {
      storage: {
        get: (key: string) => Effect.sync(() => storage.get(key)),
        set: (key: string, value: unknown) => Effect.sync(() => void storage.set(key, value)),
        remove: (key: string) => Effect.sync(() => void storage.delete(key)),
      },
      session: {
        synthetic: (input: (typeof admitted)[number]) => Effect.sync(() => void admitted.push(input)),
      },
    }
    const runtime = new GoalRuntime.Runtime(ctx as unknown as ConstructorParameters<typeof GoalRuntime.Runtime>[0])
    return { runtime, admitted }
  }

  test("the budget steer and the continuation are background work of the turn that charged them", async () => {
    const world = setup()
    await world.runtime.store.set("ses_1", { ...GOAL, tokensUsed: 0, timeUsedSeconds: 0 })
    const before = Date.now()
    world.runtime.started("ses_1")
    await world.runtime.charge("ses_1" as Session.ID, 1_500)
    expect(world.admitted.map((entry) => entry.metadata?.kind)).toEqual(["budget-limit"])
    const budget = world.admitted[0]!
    expect(budget.background).toBe(true)
    expect(budget.startedAt).toBeGreaterThanOrEqual(before)
    // A goal that keeps going: its continuation reports the turn that just ended.
    await world.runtime.store.set("ses_1", { ...GOAL, tokenBudget: 1_000_000, tokensUsed: 0, timeUsedSeconds: 0 })
    world.runtime.started("ses_1")
    const turn = Date.now()
    await world.runtime.ended("ses_1" as Session.ID, { kind: "completed", activity: true })
    const continuation = world.admitted.at(-1)!
    expect(continuation).toMatchObject({ metadata: { kind: "continuation" }, background: true })
    expect(continuation.startedAt).toBeLessThanOrEqual(turn)
    expect(continuation.startedAt).toBeGreaterThanOrEqual(budget.startedAt!)
  })

  test("they report the turn of the latest step: a run's turn after a reset is not before it", async () => {
    const world = setup()
    await world.runtime.store.set("ses_1", { ...GOAL, tokensUsed: 0, timeUsedSeconds: 0 })
    // One run: a turn whose step started at 1000, a reset at its end (2000), then the turn of the input behind it.
    world.runtime.started("ses_1")
    world.runtime.stepped("ses_1", 1_000)
    world.runtime.stepped("ses_1", 3_000)
    const charged = world.runtime.charge("ses_1" as Session.ID, 1_500)
    // The next step starts before the charge of the one that ended is written.
    world.runtime.stepped("ses_1", 4_000)
    await charged
    expect(world.admitted.map((entry) => [entry.metadata?.kind, entry.startedAt])).toEqual([["budget-limit", 3_000]])
    await world.runtime.store.set("ses_1", { ...GOAL, tokenBudget: 1_000_000, tokensUsed: 0, timeUsedSeconds: 0 })
    await world.runtime.ended("ses_1" as Session.ID, { kind: "completed", activity: true })
    expect(world.admitted.at(-1)).toMatchObject({ metadata: { kind: "continuation" }, startedAt: 4_000 })
  })

  // Codex 0.164.0 (#52640): automatic continuations another agent stops without activity block the goal at the third;
  // the user's own stop still pauses it.
  test("continuations another agent stops without activity block the goal at the third", async () => {
    const world = setup()
    await world.runtime.store.set("ses_1", { ...GOAL, tokenBudget: 1_000_000, tokensUsed: 0, timeUsedSeconds: 0 })
    // The mark another agent's stop leaves is read once; a withdrawn one is gone.
    world.runtime.stopping("ses_1")()
    expect(world.runtime.stoppedByAgent("ses_1")).toBe(false)
    world.runtime.stopping("ses_1")
    expect(world.runtime.stoppedByAgent("ses_1")).toBe(true)
    expect(world.runtime.stoppedByAgent("ses_1")).toBe(false)
    // The user's turn ends; three automatic continuations are stopped by an agent without activity.
    world.runtime.started("ses_1")
    await world.runtime.ended("ses_1" as Session.ID, { kind: "completed", activity: true })
    for (const turn of [1, 2, 3]) {
      world.runtime.started("ses_1")
      await world.runtime.ended("ses_1" as Session.ID, { kind: "aborted", activity: false })
      const status = (await world.runtime.store.get("ses_1"))?.status
      expect([turn, status]).toEqual([turn, turn < 3 ? "active" : "blocked"])
    }
    expect(world.admitted.filter((entry) => entry.metadata?.kind === "continuation")).toHaveLength(3)
  })
})

// The user's `/goal` in a codex session (MR8-15): Codex's TUI goal commands on the harness's goals; core's `/goal`
// everywhere else (core P-038 lets the harness wrap it).
describe("the user's /goal", () => {
  function setup() {
    const storage = new Map<string, unknown>()
    const admitted: Array<{ readonly text: string; readonly metadata?: { readonly kind?: string } }> = []
    const ctx = {
      storage: {
        get: (key: string) => Effect.sync(() => storage.get(key)),
        set: (key: string, value: unknown) => Effect.sync(() => void storage.set(key, value)),
        remove: (key: string) => Effect.sync(() => void storage.delete(key)),
      },
      session: {
        synthetic: (input: (typeof admitted)[number]) => Effect.sync(() => void admitted.push(input)),
      },
    }
    const runtime = new GoalRuntime.Runtime(ctx as unknown as ConstructorParameters<typeof GoalRuntime.Runtime>[0])
    return { runtime, admitted }
  }
  const session = "ses_1" as Session.ID

  test("an objective on an idle session sets an active goal and continues it at once", async () => {
    const world = setup()
    expect(await world.runtime.user(session, "  Ship the release  ")).toEqual({ ok: true })
    const goal = await world.runtime.store.get(session)
    expect(goal).toMatchObject({ objective: "Ship the release", status: "active", tokensUsed: 0 })
    expect(goal?.tokenBudget).toBeUndefined()
    expect(world.admitted).toEqual([
      expect.objectContaining({
        text: Goals.continuationMessage(goal!),
        metadata: expect.objectContaining({ kind: "continuation" }),
      }),
    ])
    // The continuation opens an automatic turn (Codex's `turn_trigger: "goal"`).
    world.runtime.started(session)
    await world.runtime.ended(session, { kind: "completed", activity: false, emptyFinal: true })
    expect(world.admitted).toHaveLength(2)
  })

  test("while a turn runs, the new goal waits for its end; a new objective replaces the goal and its usage", async () => {
    const world = setup()
    await world.runtime.store.set(session, { ...GOAL, status: "blocked" })
    world.runtime.started(session)
    expect(await world.runtime.user(session, "Tidy the changelog")).toEqual({ ok: true })
    expect(world.admitted).toEqual([])
    const goal = await world.runtime.store.get(session)
    expect(goal).toMatchObject({ objective: "Tidy the changelog", status: "active", tokensUsed: 0, timeUsedSeconds: 0 })
    expect(goal?.goalID).not.toBe(GOAL.goalID)
    await world.runtime.ended(session, { kind: "completed", activity: true })
    expect(world.admitted.map((entry) => entry.metadata?.kind)).toEqual(["continuation"])
  })

  test("pause, resume and clear; a goal over its budget resumes budget-limited and does not continue", async () => {
    const world = setup()
    for (const text of ["pause", "RESUME", "clear"])
      expect(await world.runtime.user(session, text)).toEqual({ ok: false, message: Goals.USER_NO_GOAL })
    await world.runtime.store.set(session, GOAL)
    expect(await world.runtime.user(session, "pause")).toEqual({ ok: true })
    expect((await world.runtime.store.get(session))?.status).toBe("paused")
    expect(await world.runtime.user(session, "resume")).toEqual({ ok: true })
    expect((await world.runtime.store.get(session))?.status).toBe("budgetLimited")
    expect(world.admitted).toEqual([])
    await world.runtime.store.set(session, { ...GOAL, tokenBudget: 1_000_000, status: "paused" })
    expect(await world.runtime.user(session, "resume")).toEqual({ ok: true })
    expect(world.admitted.map((entry) => entry.metadata?.kind)).toEqual(["continuation"])
    await world.runtime.store.set(session, { ...GOAL, status: "complete" })
    expect(await world.runtime.user(session, "resume")).toEqual({ ok: false, message: Goals.USER_COMPLETE })
    expect(await world.runtime.user(session, "clear")).toEqual({ ok: true })
    expect(await world.runtime.store.get(session)).toBeUndefined()
  })

  test("an empty /goal shows the goal and the usage; edit says how to replace it; a too long objective fails", async () => {
    const world = setup()
    expect(await world.runtime.user(session, " ")).toEqual({
      ok: false,
      message: `${Goals.USER_NO_GOAL}\n${Goals.USER_USAGE}`,
    })
    await world.runtime.store.set(session, GOAL)
    expect(await world.runtime.user(session, "")).toEqual({
      ok: false,
      message: `목표(진행 중): Write the release notes\n토큰 1200/1000 · 60초\n${Goals.USER_USAGE}`,
    })
    expect(await world.runtime.user(session, "Edit")).toEqual({ ok: false, message: Goals.USER_EDIT })
    expect(await world.runtime.user(session, "x".repeat(Goals.MAX_OBJECTIVE_CHARS + 1))).toEqual({
      ok: false,
      message: Goals.USER_TOO_LONG,
    })
    expect(await world.runtime.store.get(session)).toEqual(GOAL)
  })

  test("the command runs Codex's goal in a codex session and core's /goal elsewhere", async () => {
    const world = setup()
    const transforms: Array<
      (editor: { add: (definition: Definition) => void; get: (name: string) => Definition | undefined }) => void
    > = []
    type Definition = {
      readonly name: string
      readonly description?: string
      readonly execute: (input: {
        readonly sessionID: Session.ID
        readonly prompt: { readonly text: string; readonly files?: ReadonlyArray<unknown> }
        readonly delivery: "steer"
      }) => Effect.Effect<void, unknown>
    }
    const commands = new Map<string, Definition>()
    const coreCalls: string[] = []
    commands.set("goal", {
      name: "goal",
      description: "keep working until an objective is met [pause|resume|clear]",
      execute: (input) => Effect.sync(() => void coreCalls.push(input.prompt.text)),
    })
    const ctx = {
      command: {
        transform: (callback: (typeof transforms)[number]) =>
          Effect.sync(() =>
            callback({
              add: (definition) => void commands.set(definition.name, definition),
              get: (name) => commands.get(name),
            }),
          ),
        reload: () => Effect.void,
      },
    }
    await Effect.runPromise(
      Effect.scoped(
        GoalRuntime.command(ctx as unknown as Parameters<typeof GoalRuntime.command>[0], world.runtime, (sessionID) =>
          Effect.succeed(sessionID === session),
        ),
      ),
    )
    const goal = commands.get("goal")!
    expect(goal.description).toBe("keep working until an objective is met [pause|resume|clear]")
    const run = (sessionID: string, text: string, files?: ReadonlyArray<unknown>) =>
      Effect.runPromise(
        goal
          .execute({
            sessionID: sessionID as Session.ID,
            prompt: { text, ...(files ? { files } : {}) },
            delivery: "steer",
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => String((error as Error).message)),
            Effect.orElseSucceed(() => "ok"),
          ),
      )
    expect(await run("ses_other", "Ship it")).toBe("ok")
    expect(coreCalls).toEqual(["Ship it"])
    expect(await run(session, "Ship it")).toBe("ok")
    expect((await world.runtime.store.get(session))?.objective).toBe("Ship it")
    expect(coreCalls).toEqual(["Ship it"])
    expect(await run(session, "Ship it", [{ uri: "file:///x.png" }])).toBe(GoalRuntime.ATTACHED)
    expect(await run(session, "")).toContain("목표(진행 중): Ship it")
  })
})
