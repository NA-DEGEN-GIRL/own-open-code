import { Plugin } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { ServiceTarget } from "@own/runtime"
import { Effect, Result, Stream } from "effect"
import { Build } from "./build.js"
import { Defaults } from "./defaults.js"
import { AgentStore } from "./codex/agent-store.js"
import { AsyncQuestion } from "./codex/async-question.js"
import { SendMessage } from "./codex/send-message.js"
import { Clock } from "./codex/clock.js"
import { CodeModeTools } from "./codex/code-mode-tools.js"
import { Collab } from "./codex/collab.js"
import { CollabV1 } from "./codex/collab-v1.js"
import type { CodexAgents } from "./codex/agents/index.js"
import { ExecManager } from "./codex/exec/manager.js"
import { GoalRuntime } from "./codex/goal-runtime.js"
import type { Goals } from "./codex/goals/index.js"
import { CodexTools } from "./codex/tools.js"
import { Gate } from "./gate.js"
import { Hooks } from "./hooks.js"
import { Options } from "./options.js"
import { DshObserve } from "./dsh/observe.js"
import { DshSnapshots } from "./dsh/snapshots.js"
import { DshTools } from "./dsh/tools.js"
import { PiTools } from "./pi/tools.js"
import { ResetWatch } from "./reset-watch.js"
import { HarnessRpc } from "./rpc.js"
import { Sessions } from "./sessions.js"
import { Skills } from "./skills.js"

/**
 * own.harness (10): which harness each session runs and what that harness sends. `opencode` is upstream's request as
 * it is; `codex` rebuilds the request as Codex CLI does and runs Codex's tools (listed only in its sessions, `Gate`);
 * `pi` sends the Pi coding agent's prompt and tools (src/pi/); `dsh` sends DeepSeek deepseek-harness's (src/dsh/, 13).
 * The binding lives in session metadata; switching happens between runs with a durable notice.
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = Result.getOrUndefined(Options.decodeResult(ctx.options))
      if (
        options === undefined ||
        process.env[Build.ENV_MARKER] !== "1" ||
        ctx.app.version !== Build.EXPECTED_APP_VERSION
      ) {
        warn("guard_failed", { appVersion: ctx.app.version, options: options !== undefined })
        return
      }
      yield* Gate.register(ctx)
      // The Claude desktop app's synced skills are for that app's tools only (skills.ts).
      yield* Skills.register(ctx)
      // exec_command sessions outlive turns, as in Codex; they end with their own session or with the plugin.
      const manager = new ExecManager.Manager()
      yield* Effect.addFinalizer(() => Effect.sync(() => manager.terminate()))
      yield* CodexTools.register(ctx, manager)
      // Pi's read, bash, edit and write, listed only in pi sessions (12).
      yield* PiTools.register(ctx)
      // dsh's shell, file, search and todo tools, listed only in dsh sessions (13); what each session has read.
      const observed = new DshObserve.State()
      yield* DshTools.register(ctx, observed)
      // Code Mode cells and clock sleeps belong to their session, like exec_command processes.
      const runtimes = new CodeModeTools.Runtimes()
      const activity = new Clock.Activity()
      yield* Effect.addFinalizer(() => Effect.promise(() => runtimes.terminate()))
      // The context reset waiting for each session's running turn and the input behind it (reset-watch.ts); input that
      // reached the turn ends its sleeps and waits, also when it was already there as they started.
      const resets = new ResetWatch.Watch()
      // Codex's goals: durable in the plugin's storage, charged per step, continued when a turn ends.
      const goals = new GoalRuntime.Runtime(ctx)
      yield* GoalRuntime.register(ctx, goals)
      // `/goal` in a codex session is Codex's own; elsewhere core's goal loop (MR8-15).
      yield* GoalRuntime.command(ctx, goals, (sessionID) => codexSession(ctx, sessionID))
      yield* CodeModeTools.register(
        ctx,
        manager,
        runtimes,
        activity,
        goals,
        (sessionID) => resets.pending(sessionID).length > 0,
      )
      yield* AsyncQuestion.register(ctx)
      yield* SendMessage.register(ctx)
      // Codex's MultiAgentV2 agent tree on child sessions (collaboration tools for v2 models).
      const tree = new Collab.Tree(
        ctx,
        (sessionID) => resets.pending(sessionID),
        (sessionID) => goals.stopping(sessionID),
      )
      yield* Collab.register(ctx, tree)
      // Codex's MultiAgent v1 agents (gpt-5.5, models outside the catalog) and their tool search.
      const treeV1 = new CollabV1.Tree(ctx, tree)
      yield* CollabV1.register(ctx, treeV1)
      yield* Hooks.register(ctx, tree, treeV1, options.compactionFallback)
      // What a new top-level session runs until Settings > 일반 stores a choice (defaults.ts).
      const defaults = { harness: options.default, prompt: options.prompt }
      // Runs this instance saw start. A switch is refused while one runs: the tools of a run stay the same throughout.
      const running = new Set<string>()
      const service: { source?: ServiceTarget.Source } = {}
      const inbox = ResetWatch.reader(() => {
        service.source ??= new ServiceTarget.Service(ServiceTarget.registrationPath(ctx.app.channel))
        return service.source
      }, ctx.location.directory)
      // Input that reaches the running turn ends a `clock.sleep` early (Codex's input-queue activity) and a `wait_agent`
      // as steered, unless it is an inter-agent message.
      const reached = (sessionID: Session.ID, metadata: Readonly<Record<string, unknown>> | undefined) => {
        activity.notify(sessionID)
        tree.input(sessionID, metadata)
      }
      yield* ctx.event.subscribe().pipe(
        Stream.runForEach((event) => {
          if (event.type === "session.execution.started")
            return Effect.sync(() => void running.add(event.data.sessionID)).pipe(
              Effect.tap(() => Effect.all([tree.started(event.data.sessionID), treeV1.started(event.data.sessionID)])),
              Effect.andThen(codexSession(ctx, event.data.sessionID)),
              Effect.map((codex) => codex && goals.started(event.data.sessionID)),
            )
          if (event.type === "session.step.started")
            return Effect.sync(() => {
              goals.stepped(event.data.sessionID, event.data.started)
              // A session older than this instance: its pending input and waiting reset are read back once, tried again
              // while the service gives no answer yet (only for a codex session here, which alone has waits).
              void resets.readBack(event.data.sessionID, () =>
                Effect.runPromise(codexSession(ctx, event.data.sessionID)).then((codex) =>
                  codex ? inbox(event.data.sessionID) : undefined,
                ),
              )
            })
          if (event.type === "session.step.ended")
            return Effect.sync(() => void goals.charge(event.data.sessionID, GoalRuntime.stepTokens(event.data.tokens)))
          if (event.type === "session.deleted")
            return Effect.sync(() => {
              running.delete(event.data.sessionID)
              resets.forget(event.data.sessionID)
              manager.terminate(event.data.sessionID)
              void runtimes.terminate(event.data.sessionID)
              goals.forget(event.data.sessionID)
              observed.forget(event.data.sessionID)
            }).pipe(
              Effect.andThen(DshSnapshots.forget(ctx, event.data.sessionID)),
              Effect.andThen(Effect.all([tree.forget(event.data.sessionID), treeV1.forget(event.data.sessionID)])),
            )
          // Only input that reaches the running turn ends its waits (reset-watch.ts): not queued input until it is
          // steered, as in Codex, and not a context reset waiting for the turn (core P-035, 11 §7.2) or what is admitted
          // behind it, except background notices; cancelling the reset lets the steered input it held in.
          if (event.type === "session.inbox.enqueued")
            return Effect.sync(() => {
              const item = event.data.item
              const input = resets.enqueued(
                event.data.sessionID,
                event.data.inboxID,
                item.type === "synthetic" || item.type === "user" ? item : { type: item.type, delivery: item.delivery },
              )
              if (input !== undefined) reached(event.data.sessionID, input.metadata)
            })
          if (event.type === "session.inbox.delivery.changed")
            return Effect.sync(() => {
              const input = resets.changed(event.data.sessionID, event.data.inboxID, event.data.delivery)
              if (input !== undefined) reached(event.data.sessionID, input.metadata)
            })
          if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled")
            return Effect.sync(() =>
              resets
                .settled(event.data.sessionID, event.data.inboxID, event.type === "session.inbox.cancelled")
                .forEach((metadata) => reached(event.data.sessionID, metadata)),
            )
          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"
          )
            return Effect.sync(() => {
              running.delete(event.data.sessionID)
              const kind =
                event.type === "session.execution.succeeded"
                  ? "completed"
                  : event.type === "session.execution.failed"
                    ? USAGE_LIMIT.test(event.data.error.type)
                      ? "usageLimit"
                      : "error"
                    : event.data.reason === "user"
                      ? goals.stoppedByAgent(event.data.sessionID)
                        ? "aborted"
                        : "interrupted"
                      : event.data.reason === "inactivity"
                        ? "error"
                        : undefined
              Effect.runFork(goalEnded(ctx, goals, event.data.sessionID, kind))
              Effect.runFork(agentEnded(ctx, [tree, treeV1], event))
            })
          // A rule write that raced the binding's own (Sessions.heal) gets the session's tool gate back.
          if (event.type === "session.permissions")
            return Sessions.heal(ctx, event.data.sessionID, ctx.location.directory).pipe(
              Effect.tap((healed) =>
                healed ? Effect.sync(() => warn("gate_restored", { sessionID: event.data.sessionID })) : Effect.void,
              ),
              Effect.catchCause((cause) => Effect.sync(() => warn("gate_restore_failed", { cause: String(cause) }))),
            )
          if (event.type === "session.created")
            return Effect.sync(() => resets.created(event.data.sessionID)).pipe(
              Effect.andThen(Defaults.read(ctx, defaults)),
              Effect.flatMap((current) =>
                Sessions.stamp(
                  ctx,
                  {
                    sessionID: event.data.sessionID,
                    parentID: event.data.parentID,
                    metadata: event.data.metadata,
                    model: event.data.model,
                  },
                  current.harness,
                  current.prompt,
                ),
              ),
              Effect.catchCause((cause) => Effect.sync(() => warn("stamp_failed", { cause: String(cause) }))),
            )
          return Effect.void
        }),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* HarnessRpc.register(ctx, {
        defaults,
        busy: (sessionID) => running.has(sessionID),
        compactionFallback: options.compactionFallback,
      })
    }),
})

/** Provider errors that mean the account's usage limit, which Codex records as `usageLimited` on a goal. */
const USAGE_LIMIT = /usage.?limit|quota/i

/**
 * A `codex` session of this instance's Location. Events reach every Location's instance; only the session's own charges
 * its goal, or a goal would be charged and continued once per open Location.
 */
function codexSession(ctx: Pick<Context, "session" | "location">, sessionID: Session.ID) {
  return ctx.session.get({ sessionID }).pipe(
    Effect.map(
      (info) =>
        OwnHarness.harnessOf(info.metadata as Record<string, unknown>) === "codex" && AgentStore.local(ctx, info),
    ),
    Effect.orElseSucceed(() => false),
  )
}

/** A child agent's turn ended: its Codex status for both agent trees, which tell its parent (collab.ts, collab-v1.ts). */
function agentEnded(
  ctx: Pick<Context, "session">,
  trees: ReadonlyArray<{
    ended(sessionID: Session.ID, status: CodexAgents.AgentStatus): Effect.Effect<void, unknown>
  }>,
  event: {
    readonly type: string
    readonly data: {
      readonly sessionID: Session.ID
      readonly error?: { readonly message?: string; readonly type: string }
      readonly reason?: string
    }
  },
) {
  const ended = (status: CodexAgents.AgentStatus) =>
    Effect.forEach(trees, (tree) => tree.ended(event.data.sessionID, status), { discard: true })
  return Effect.gen(function* () {
    if (event.type === "session.execution.interrupted") return yield* ended("interrupted")
    if (event.type === "session.execution.failed")
      return yield* ended({ errored: event.data.error?.message ?? event.data.error?.type ?? "" })
    const messages = yield* ctx.session
      .context({ sessionID: event.data.sessionID })
      .pipe(Effect.orElseSucceed(() => []))
    const last = messages.findLast((message) => message.type === "assistant")
    const text =
      last?.type === "assistant"
        ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
        : undefined
    yield* ended({ completed: text === undefined || text === "" ? null : text })
  }).pipe(Effect.catchCause((cause) => Effect.sync(() => warn("agent_turn_failed", { cause: String(cause) }))))
}

/** Reads the finished turn for Codex's goal rules and hands it to the goal runtime. */
function goalEnded(
  ctx: Pick<Context, "session">,
  goals: GoalRuntime.Runtime,
  sessionID: Session.ID,
  kind: Goals.TurnOutcome["kind"] | undefined,
) {
  return Effect.gen(function* () {
    if (kind === undefined) return yield* Effect.promise(() => goals.ended(sessionID, undefined))
    const messages = yield* ctx.session.context({ sessionID }).pipe(Effect.orElseSucceed(() => []))
    const last = messages.findLast((message) => message.type === "assistant")
    const outcome = GoalRuntime.outcome(messages, kind, last?.type === "assistant" && last.agent === "plan")
    yield* Effect.promise(() => goals.ended(sessionID, outcome))
  }).pipe(Effect.catchCause((cause) => Effect.sync(() => warn("goal_turn_failed", { cause: String(cause) }))))
}

function warn(message: string, fields: Readonly<Record<string, unknown>>) {
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), level: "warn", scope: Build.PLUGIN_ID, msg: message, ...fields })}\n`,
  )
}
