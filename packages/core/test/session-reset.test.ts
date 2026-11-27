// OWN-PATCH(P-035) begin
// Context reset: a queued inbox control item that delivers between turns as a completed compaction marker without a
// summary (history starts after it, the instruction epoch moves), and can be undone while it is the newest boundary.
import { describe, expect, setDefaultTimeout } from "bun:test"
import { CompactionCheckpointResponse, LanguageModel, type LLMRequest, type Message } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { OpenAIResponses } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { EventTable } from "@opencode/core/event/sql"
import { Form } from "@opencode/core/form"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { Document, Info } from "@opencode/schema/config"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { asc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

setDefaultTimeout(30_000)

const limits = new Map<string, { readonly context: number; readonly output: number }>()
const testModel = (id: string, limit = { context: 200_000, output: 32_000 }) => {
  limits.set(id, limit)
  return LanguageModel.make({ id, provider: "fake", route: OpenAIChat.route })
}
const model = testModel("fake-model")
// Auto compaction keeps 10% of the window free: due from 9,000 tokens.
const windowModel = testModel("reset-window", { context: 10_000, output: 1_000 })
const nativeModel = LanguageModel.make({ id: "native", provider: "openai", route: OpenAIResponses.route })
limits.set("native", { context: 11_000, output: 1_000 })

const makeState = () => ({
  currentModel: model,
  compaction: undefined as SessionRunnerModel.Resolved["compaction"],
  systemBaseline: "Initial context",
})
class State extends Context.Service<State, ReturnType<typeof makeState>>()("test/SessionReset") {}
class LLMRequests extends Context.Service<LLMRequests, LLMRequest[]>()("test/LLMRequests") {}
const testLLM = Layer.unwrap(
  Effect.sync(() => {
    const requests: LLMRequest[] = []
    return TestLLM.testLayer({
      fallback: [],
      transformRequest: (request) => {
        requests.push(request)
        return request
      },
    }).pipe(Layer.merge(Layer.succeed(LLMRequests, requests)))
  }),
)

const layer = Layer.unwrap(
  Effect.map(State, (state) => {
    const echo = Layer.effectDiscard(
      Tool.Service.use((registry) =>
        registry.transform((editor) =>
          editor.add({
            name: "echo",
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
            options: { codemode: false },
          }),
        ),
      ),
    )
    const models = Layer.mock(SessionRunnerModel.Service)({
      select: () =>
        Effect.sync(() => ({
          info: Model.Info.default(
            Provider.ID.make(state.currentModel.provider),
            Model.ID.make(String(state.currentModel.id)),
          ),
          variant: undefined,
        })),
      resolve: () =>
        Effect.succeed(
          SessionRunnerModel.resolved(state.currentModel, {
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            cost: [],
            limit: limits.get(String(state.currentModel.id)) ?? { context: 200_000, output: 32_000 },
            compaction: state.compaction,
          }),
        ),
    })
    const context = Layer.mock(InstructionBuiltIns.Service, {
      load: () =>
        Effect.sync(() =>
          Instructions.make({
            key: Instructions.Key.make("test/context"),
            codec: Schema.toCodecJson(Schema.String),
            read: Effect.sync(() => state.systemBaseline),
            render: { initial: String, changed: (_previous, current) => current, removed: () => "removed" },
          }),
        ),
    })
    const empty = { load: () => Effect.succeed(Instructions.empty) }
    const replacements: LayerNode.Replacements = [
      Snapshot.node.replace(Snapshot.noopLayer),
      LayerNodePlatform.llmClient.replace(testLLM),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(context),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, { project: true, global: true, claude: false, ...empty }),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, empty)),
      ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, empty)),
      Permission.node.replace(permissionLayer()),
      Config.node.replace(
        Config.testLayer([
          new Document({
            type: "document",
            info: new Info({
              compaction: new ConfigCompaction.Info({
                buffer: 3_000,
                keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
              }),
            }),
          }),
        ]),
      ),
      PluginSupervisor.node.replace(Layer.empty),
      Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
      SessionModelTransport.node.replace(
        Layer.succeed(
          SessionModelTransport.Service,
          SessionModelTransport.Service.of({
            bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
            close: () => Effect.void,
            closeAll: Effect.void,
          }),
        ),
      ),
    ]
    const runner = AppNodeBuilder.build(SessionRunnerLLM.node, [
      ...replacements,
      McpInstructions.node.replace(Layer.mock(McpInstructions.Service, empty)),
    ])
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const sessionRunner = yield* SessionRunner.Service
        const drain = (
          sessionID: Session.ID,
          force: boolean,
          continuation?: SessionRunner.Continuation,
        ): Effect.Effect<void, SessionRunner.RunError> =>
          sessionRunner
            .drain({ sessionID, force, continuation })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "Complete" ? Effect.void : drain(sessionID, false, result.continuation),
              ),
            )
        const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
          drain: (sessionID, force) => drain(sessionID, force),
        })
        return SessionExecution.Service.of({
          active: coordinator.active,
          isActive: coordinator.isActive,
          resume: coordinator.run,
          wake: coordinator.wake,
          interrupt: (sessionID) => coordinator.interrupt(sessionID),
          awaitIdle: coordinator.awaitIdle,
        })
      }),
    ).pipe(Layer.provide(runner), Layer.orDie)
    return AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Form.node,
        SessionProjector.node,
        SessionStore.node,
        SessionInbox.node,
        Agent.node,
        Model.node,
        Tool.node,
        PluginHooks.node,
        makeLocationNode({ name: "test/session-reset-tools", layer: echo, deps: [Tool.node] }),
        SessionRunnerModel.node,
        InstructionBuiltIns.node,
        InstructionDiscovery.node,
        InstructionEntry.node,
        SkillInstructions.node,
        ReferenceInstructions.node,
        Config.node,
        Snapshot.node,
        SessionCompaction.node,
        LayerNodePlatform.llmClient,
        SessionRunnerLLM.node,
        SessionExecution.node,
        Session.node,
      ]),
      [
        ...replacements,
        Bus.node.replace(Bus.configured({ persist: true })),
        LocationServiceMap.node.replace(promptLocationNode),
        Model.node.replace(
          Layer.mock(Model.Service, {
            get: () => Effect.undefined,
            all: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
            default: () => Effect.undefined,
            small: () => Effect.undefined,
          }),
        ),
        SessionExecution.node.replace(execution),
      ],
    )
  }),
).pipe(Layer.provideMerge(Layer.sync(State, makeState)), Layer.provideMerge(testLLM))
const it = testEffect(layer)
const sessionID = Session.ID.make("ses_reset_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  // These cases count each request of a synchronous compaction: no background summaries (upstream's default since
  // v2.3.1; a held one no longer describes the conversation once a reset applies, SessionCompaction `heldIndex`).
  yield* (yield* SessionCompaction.Service).transform((editor) => editor.configure({ background: false }))
  yield* (yield* Agent.Service).transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: "t",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const state = yield* State
  const session = yield* Session.Service
  const test = yield* TestLLM.Test
  const llm = { push: test.push, wait: test.wait, gate: test.gate() }
  const resume = session.resume(sessionID)
  return Object.assign(state, {
    db,
    bus: yield* Bus.Service,
    session,
    llm,
    requests: yield* LLMRequests,
    resume,
    admit: (text: string, delivery?: SessionInbox.Delivery) =>
      session.prompt({ sessionID, text, delivery, resume: false }),
    run: Effect.fnUntraced(function* (text: string, answer = `Answer to ${text}`) {
      yield* llm.push(TestLLM.text(answer, `text-${text}`))
      const message = yield* session.prompt({ sessionID, text, resume: false })
      yield* resume
      return message
    }),
    // A wake delivers the reset; `resume` would also force a model step.
    reset: Effect.fnUntraced(function* () {
      const admitted = yield* session.reset({ sessionID })
      yield* session.wait(sessionID)
      return admitted
    }),
    compact: session.compact({ sessionID }).pipe(Effect.andThen(session.wait(sessionID))),
    settle: session.wait(sessionID),
    undo: (resetID: SessionMessage.ID) => session.undoReset({ sessionID, resetID }),
    context: session.context(sessionID),
    messages: session.messages({ sessionID }),
    inbox: session.inbox(sessionID),
  })
})
type Scenario = Effect.Success<typeof setup>
const scenario = (
  name: string,
  body: (s: Scenario) => Effect.gen.Return<void, unknown, Layer.Success<typeof layer> | Scope.Scope>,
) =>
  it.effect(
    name,
    Effect.gen(function* () {
      return yield* body(yield* setup)
    }),
  )

const texts = (request: LLMRequest | undefined, role: Message["role"]) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === role ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
const all = (request: LLMRequest | undefined) => JSON.stringify(request?.messages ?? [])
const marker = (messages: readonly SessionMessage.Info[], id: SessionMessage.ID) =>
  messages.find((message) => message.id === id)

describe("context reset", () => {
  scenario("delivers at the idle boundary as a marker the next request starts after, moving the epoch", function* (s) {
    yield* s.run("Before reset")
    s.systemBaseline = "Changed before reset"
    yield* s.run("Still before")
    expect(texts(s.requests[1], "system")).toEqual(["Changed before reset"])

    const reset = yield* s.reset()
    expect(reset).toMatchObject({ type: "reset", delivery: "queue" })
    expect(yield* s.inbox).toEqual([])
    expect(s.requests).toHaveLength(2)
    const context = yield* s.context
    expect(context).toMatchObject([
      { id: reset.id, type: "compaction", status: "completed", reason: "reset", summary: "" },
    ])
    expect(
      toLLMMessages(context, Model.Ref.make({ id: Model.ID.make("fake-model"), providerID: Provider.ID.make("fake") })),
    ).toEqual([])
    expect((yield* s.session.reset({ sessionID, id: reset.id }).pipe(Effect.flip))._tag).toBe(
      "Session.ResetConflictError",
    )

    yield* s.run("After reset")
    expect(texts(s.requests[2], "user")).toEqual(["After reset"])
    expect(all(s.requests[2])).not.toContain("before")
    // The baseline now holds the values at the reset; the update before it left with the older history.
    expect(JSON.stringify(s.requests[2]?.system)).toContain("Changed before reset")
    expect(texts(s.requests[2], "system")).toEqual([])
  })

  scenario("waits for the running turn and orders against queued prompts", function* (s) {
    yield* s.llm.push(
      TestLLM.toolCall("call-1", "echo", { text: "tool ran" }),
      TestLLM.text("Turn done", "turn"),
      TestLLM.text("Answer before", "before"),
      TestLLM.text("Answer after", "after"),
    )
    yield* s.admit("Echo first")
    const gate = yield* s.llm.gate
    const running = yield* s.resume.pipe(Effect.forkChild)
    yield* gate.started
    yield* s.admit("Queued before", "queue")
    const reset = yield* s.session.reset({ sessionID })
    expect((yield* s.session.reset({ sessionID })).id).toBe(reset.id)
    expect((yield* s.session.steerInbox({ sessionID, inboxID: reset.id }).pipe(Effect.flip))._tag).toBe(
      "Session.InboxConflictError",
    )
    yield* s.admit("Queued after", "queue")
    yield* gate.release
    yield* Fiber.join(running)
    yield* s.settle

    expect(s.requests).toHaveLength(4)
    // The turn's second step still sees its own prompt: a reset never delivers at a step boundary.
    expect(texts(s.requests[1], "user")).toEqual(["Echo first"])
    expect(texts(s.requests[2], "user")).toEqual(["Echo first", "Queued before"])
    expect(texts(s.requests[3], "user")).toEqual(["Queued after"])
    expect(all(s.requests[3])).not.toContain("Echo first")
    expect(yield* s.inbox).toEqual([])
  })

  // This harness's interrupt only stops the drain (SessionExecution's stop delivery is covered in
  // session-execution.test.ts), so the reset stays pending as after a shutdown.
  scenario("is a barrier: a prompt admitted after a pending reset starts the new context", function* (s) {
    yield* s.run("Old question")
    yield* s.llm.push(TestLLM.text("Busy answer", "busy"))
    yield* s.admit("Busy prompt")
    const gate = yield* s.llm.gate
    const running = yield* s.resume.pipe(Effect.forkChild)
    yield* gate.started
    const reset = yield* s.session.reset({ sessionID })
    yield* s.session.interrupt(sessionID)
    yield* Fiber.await(running)
    yield* gate.release
    yield* s.settle
    expect((yield* s.inbox).map((item) => item.type)).toEqual(["reset"])

    yield* s.llm.push(TestLLM.text("Fresh answer", "fresh"))
    // An idle boundary prefers steers, but not over the reset they were admitted after.
    yield* s.session.prompt({ sessionID, text: "Fresh question" })
    yield* s.settle
    expect(texts(s.requests.at(-1), "user")).toEqual(["Fresh question"])
    const messages = yield* s.messages
    // Newest first.
    expect(messages.findIndex((message) => message.id === reset.id)).toBeGreaterThan(
      messages.findIndex((message) => message.type === "user" && message.text === "Fresh question"),
    )
  })

  scenario("holds a steer sent while the reset waits until after it, at step boundaries too", function* (s) {
    yield* s.llm.push(TestLLM.toolCall("call-1", "echo", { text: "tool ran" }), TestLLM.text("Done", "done"))
    yield* s.admit("Echo first")
    const gate = yield* s.llm.gate
    const running = yield* s.resume.pipe(Effect.forkChild)
    yield* gate.started
    yield* s.session.reset({ sessionID })
    yield* s.llm.push(TestLLM.text("Steer answer", "steer"))
    yield* s.admit("Steered new task")
    yield* gate.release
    yield* Fiber.join(running)
    yield* s.settle
    expect(s.requests).toHaveLength(3)
    expect(texts(s.requests[1], "user")).toEqual(["Echo first"])
    expect(texts(s.requests[2], "user")).toEqual(["Steered new task"])
    expect(all(s.requests[2])).not.toContain("Echo first")
  })

  scenario("a forced resume first finishes the cut-off turn, then the reset applies", function* (s) {
    yield* s.run("Old question")
    yield* s.llm.push(TestLLM.toolCall("call-1", "echo", { text: "tool ran" }), TestLLM.text("never", "never"))
    yield* s.admit("Echo first")
    const gate = yield* s.llm.gate
    const running = yield* s.resume.pipe(Effect.forkChild)
    yield* gate.started
    yield* gate.release
    yield* s.llm.wait(3)
    const reset = yield* s.session.reset({ sessionID })
    yield* s.session.interrupt(sessionID)
    yield* Fiber.await(running)
    yield* s.settle
    expect((yield* s.inbox).map((item) => item.type)).toEqual(["reset"])

    // Restart recovery resumes the claimed turn with a forced step.
    const before = s.requests.length
    yield* s.llm.push(TestLLM.text("Turn finished", "finish"))
    yield* s.resume
    yield* s.settle
    expect(s.requests.length - before).toBe(1)
    expect(texts(s.requests.at(-1), "user")).toEqual(["Old question", "Echo first"])
    expect(all(s.requests.at(-1))).toContain("tool ran")
    expect(yield* s.inbox).toEqual([])
    expect((yield* s.messages)[0]).toMatchObject({ id: reset.id, reason: "reset" })
  })

  scenario(
    "a steer-scoped drain ends at a prompt queued before a waiting reset, like upstream (the execution settles it)",
    function* (s) {
      yield* s.run("Old")
      yield* s.admit("Parked before", "queue")
      yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
      yield* s.admit("Steered follow-up")
      // Whether the queued prompt is parked depends on the wakes only the execution sees (session-reset-execution).
      yield* (yield* SessionRunner.Service).drain({ sessionID, force: false, promotable: "steer" })
      expect(s.requests).toHaveLength(1)
      expect((yield* s.inbox).map((item) => item.type)).toEqual(["user", "reset", "user"])
    },
  )

  scenario("a background job started before the reset reports without starting a turn", function* (s) {
    yield* s.run("Old")
    const reset = yield* s.reset()
    const at = DateTime.toEpochMillis(marker(yield* s.messages, reset.id)!.time.created)
    const startedAt = at - 1
    const notice = (text: string) =>
      s.session.synthetic({ sessionID, text, startedAt, metadata: { source: "shell" } }).pipe(Effect.andThen(s.settle))
    yield* notice("<shell>old job</shell>")
    expect(s.requests).toHaveLength(1)
    const [pending] = yield* s.inbox
    // Passive while the reset it names applies; the line is written at delivery.
    expect(pending).toMatchObject({
      type: "synthetic",
      payload: { text: "<shell>old job</shell>", metadata: { source: "shell" }, beforeReset: reset.id },
    })
    // It rides along with the next prompt into the new context.
    yield* s.run("New")
    expect(texts(s.requests.at(-1), "user")).toEqual([`${SessionInbox.BEFORE_RESET}\n<shell>old job</shell>`, "New"])
    expect(all(s.requests.at(-1))).not.toContain("Old")

    // A job started after the reset, or one whose reset was undone, reports as usual.
    yield* s.llm.push(TestLLM.text("Seen", "seen"))
    yield* s.session.synthetic({ sessionID, text: "<shell>new job</shell>", startedAt: at })
    yield* s.settle
    expect(s.requests).toHaveLength(3)
    yield* s.undo(reset.id)
    yield* s.llm.push(TestLLM.text("Seen again", "again"))
    yield* notice("<shell>restored job</shell>")
    expect(s.requests).toHaveLength(4)
    expect(all(s.requests.at(-1))).toContain("restored job")
    expect(yield* s.inbox).toEqual([])
  })

  scenario(
    "a background job ending while the reset waits reaches the old turn; the follow-up starts the new context",
    function* (s) {
      yield* s.llm.push(
        TestLLM.text("Busy answer", "busy"),
        TestLLM.text("Late answer", "late"),
        TestLLM.text("Follow-up answer", "follow"),
      )
      yield* s.admit("Busy prompt")
      const gate = yield* s.llm.gate
      const running = yield* s.resume.pipe(Effect.forkChild)
      yield* gate.started
      yield* s.session.reset({ sessionID })
      yield* s.admit("Follow-up", "queue")
      const reporting = yield* s.session
        .synthetic({ sessionID, text: "<subagent>late result</subagent>", startedAt: -1 })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* gate.release
      yield* Fiber.join(running)
      yield* Fiber.join(reporting)
      yield* s.settle
      // Work of the running turn belongs to it: the result crosses the barrier and the turn answers it before the reset.
      expect(s.requests).toHaveLength(3)
      expect(all(s.requests[0])).not.toContain("late result")
      expect(texts(s.requests[1], "user")).toEqual(["Busy prompt", expect.stringContaining("late result")])
      expect(texts(s.requests[2], "user")).toEqual(["Follow-up"])
      expect(yield* s.inbox).toEqual([])
    },
  )

  scenario("refuses a subagent session", function* (s) {
    const child = Session.ID.make("ses_reset_child")
    yield* s.db
      .insert(SessionTable)
      .values({
        id: child,
        project_id: Project.ID.global,
        parent_id: sessionID,
        slug: child,
        directory: "/project",
        title: "child",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    expect(yield* s.session.reset({ sessionID: child }).pipe(Effect.flip)).toMatchObject({
      _tag: "Session.ResetConflictError",
      reason: "subagent",
    })
    expect(yield* s.session.inbox(child)).toEqual([])
  })

  scenario("cancels a pending reset and undoes a delivered one", function* (s) {
    yield* s.llm.push(TestLLM.text("Busy answer", "busy"))
    yield* s.admit("Busy prompt")
    const gate = yield* s.llm.gate
    const running = yield* s.resume.pipe(Effect.forkChild)
    yield* gate.started
    const pending = yield* s.session.reset({ sessionID })
    yield* s.undo(pending.id)
    expect(yield* s.inbox).toEqual([])
    yield* gate.release
    yield* Fiber.join(running)
    expect(marker(yield* s.messages, pending.id)).toBeUndefined()

    yield* s.run("Second before")
    const before = s.requests.at(-1)!
    const reset = yield* s.reset()
    yield* s.run("After one")
    expect(texts(s.requests.at(-1), "user")).toEqual(["After one"])

    const busy = yield* s.llm.gate
    yield* s.llm.push(TestLLM.text("Paused answer", "paused"))
    yield* s.admit("While busy")
    const paused = yield* s.resume.pipe(Effect.forkChild)
    yield* busy.started
    expect((yield* s.undo(reset.id).pipe(Effect.flip))._tag).toBe("Session.BusyError")
    yield* busy.release
    yield* Fiber.join(paused)

    yield* s.undo(reset.id)
    expect(marker(yield* s.messages, reset.id)).toMatchObject({ reason: "reset", undone: expect.anything() })
    expect(yield* s.undo(reset.id).pipe(Effect.flip)).toMatchObject({
      _tag: "Session.ResetConflictError",
      reason: "undone",
    })
    yield* s.run("After undo")
    const restored = s.requests.at(-1)!
    expect(texts(restored, "user")).toEqual(["Busy prompt", "Second before", "After one", "While busy", "After undo"])
    // Without an instruction change the part before the reset is the last request before it, byte for byte.
    expect(JSON.stringify(restored.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
    expect(JSON.stringify(restored.system)).toBe(JSON.stringify(before.system))
    expect((yield* s.context).map((message) => message.type)).toContain("compaction")
  })

  scenario("undo restores the epoch the reset ended: the pre-reset request's bytes, then later updates", function* (s) {
    yield* s.run("First")
    s.systemBaseline = "Changed before reset"
    yield* s.run("Second")
    const before = s.requests.at(-1)!
    expect(texts(before, "system")).toEqual(["Changed before reset"])
    const reset = yield* s.reset()
    expect(marker(yield* s.messages, reset.id)).toMatchObject({ baseline: { values: expect.any(Object) } })
    s.systemBaseline = "Changed after reset"
    yield* s.run("Third")
    expect(JSON.stringify(s.requests.at(-1)?.system)).toContain("Changed before reset")
    yield* s.undo(reset.id)
    yield* s.run("Fourth")
    const request = s.requests.at(-1)!
    expect(texts(request, "user")).toEqual(["First", "Second", "Third", "Fourth"])
    // The system is the pre-reset baseline again and the update before the reset is back in place, so the request
    // starts with the last pre-reset request byte for byte; the update after the reset follows in order.
    expect(JSON.stringify(request.system)).toBe(JSON.stringify(before.system))
    expect(JSON.stringify(request.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
    expect(texts(request, "system")).toEqual(["Changed before reset", "Changed after reset"])
  })

  scenario("reset, undo, reset, undo keeps returning the pre-reset prefix byte for byte", function* (s) {
    yield* s.run("One")
    s.systemBaseline = "Changed once"
    yield* s.run("Two")
    const before = s.requests.at(-1)!
    yield* s.undo((yield* s.reset()).id)
    const again = yield* s.reset()
    yield* s.run("Three")
    expect(texts(s.requests.at(-1), "user")).toEqual(["Three"])
    yield* s.undo(again.id)
    yield* s.run("Four")
    const restored = s.requests.at(-1)!
    expect(texts(restored, "user")).toEqual(["One", "Two", "Three", "Four"])
    expect(JSON.stringify(restored.system)).toBe(JSON.stringify(before.system))
    expect(JSON.stringify(restored.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
  })

  scenario("a fork leaves no epoch to restore; a committed revert that keeps the fold keeps it", function* (s) {
    yield* s.run("First")
    s.systemBaseline = "Changed before reset"
    yield* s.run("Second")
    const before = s.requests.at(-1)!
    const reset = yield* s.reset()
    yield* s.run("Third")
    const forked = yield* s.session.fork({ sessionID })
    const copied = (yield* s.session.context(forked.id))[0]
    expect(copied).toMatchObject({ reason: "reset" })
    expect(copied).not.toHaveProperty("baseline")

    // Upstream's rewind (v2.1) keeps the instruction fold when the revert removes no update and not the epoch start,
    // so the marker's ended epoch is still the one before it and an undo returns the pre-reset prefix.
    const fourth = yield* s.run("Fourth")
    yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: fourth.id })
    expect(marker(yield* s.messages, reset.id)).toHaveProperty("baseline")
    yield* s.undo(reset.id)
    yield* s.run("Fifth")
    const request = s.requests.at(-1)!
    expect(texts(request, "user")).toEqual(["First", "Second", "Third", "Fifth"])
    expect(JSON.stringify(request.system)).toBe(JSON.stringify(before.system))
    expect(texts(request, "system")).toEqual(["Changed before reset"])
  })

  scenario("a committed revert that re-initializes the instructions leaves no epoch to restore", function* (s) {
    yield* s.run("First")
    s.systemBaseline = "Changed before reset"
    yield* s.run("Second")
    const reset = yield* s.reset()
    yield* s.run("Third")
    s.systemBaseline = "Changed after reset"
    yield* s.run("Fourth")
    // Removes the update after the reset, so core folds the instructions again from the reset's epoch.
    const messages = yield* s.messages
    // Newest first: the update is among the messages before the marker in this list.
    const update = messages
      .slice(0, messages.findIndex((message) => message.id === reset.id))
      .find((message) => message.type === "system")!
    yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: update.id })
    expect(marker(yield* s.messages, reset.id)).not.toHaveProperty("baseline")
    yield* s.undo(reset.id)
    yield* s.run("Fifth")
    const request = s.requests.at(-1)!
    expect(texts(request, "user")).toEqual(["First", "Second", "Third", "Fifth"])
    // The re-initialized baseline already holds the changes, so the update before the reset is not repeated.
    expect(JSON.stringify(request.system)).toContain("Changed after reset")
    expect(texts(request, "system")).toEqual([])
  })

  scenario("refuses undo with a staged revert or after a later compaction, last in first out", function* (s) {
    const first = yield* s.run("First")
    const one = yield* s.reset()
    yield* s.run("Second")
    const two = yield* s.reset()
    yield* s.run("Third")
    expect(yield* s.undo(one.id).pipe(Effect.flip)).toMatchObject({ reason: "superseded" })
    yield* s.bus.publish(SessionEvent.RevertEvent.Staged, { sessionID, revert: { messageID: first.id, files: [] } })
    expect(yield* s.undo(two.id).pipe(Effect.flip)).toMatchObject({ reason: "revert" })
    yield* s.bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID })
    yield* s.undo(two.id)
    expect(texts((yield* s.run("Fourth"), s.requests.at(-1)), "user")).toEqual(["Second", "Third", "Fourth"])
    yield* s.undo(one.id)
    yield* s.run("Fifth")
    expect(texts(s.requests.at(-1), "user")).toEqual(["First", "Second", "Third", "Fourth", "Fifth"])

    const three = yield* s.reset()
    yield* s.run("Sixth")
    yield* s.llm.push(TestLLM.text("## Objective\n- after the reset", "summary"))
    yield* s.compact
    expect(yield* s.undo(three.id).pipe(Effect.flip)).toMatchObject({ reason: "superseded" })
    expect((yield* s.undo(SessionMessage.ID.create()).pipe(Effect.flip))._tag).toBe("Session.MessageNotFoundError")
  })

  scenario("compacts only what follows the reset, with the first-time prompt", function* (s) {
    yield* s.run("Secret before the reset", "Secret answer")
    yield* s.reset()
    yield* s.run("Post one")
    yield* s.run("Post two")
    yield* s.llm.push(TestLLM.text("## Objective\n- post only", "summary"))
    yield* s.compact
    const request = s.requests.at(-1)!
    expect(all(request)).not.toContain("Secret")
    expect(texts(request, "user").at(-1)).toBe(SessionCompaction.buildPrompt(false))
    const checkpoint = (yield* s.context)[0]
    expect(checkpoint).toMatchObject({ type: "compaction", status: "completed", reason: "manual" })
    expect(JSON.stringify(checkpoint)).not.toContain("Secret")
  })

  scenario("native compaction retains only the users after the reset", function* (s) {
    s.currentModel = nativeModel
    s.compaction = { type: "native" }
    yield* s.run("Pre native request")
    yield* s.reset()
    yield* s.run("Post native request")
    yield* s.llm.push(
      CompactionCheckpointResponse.make({
        responseID: "resp_window",
        checkpoint: { type: "compaction", provider: s.currentModel.provider, encrypted: "window" },
      }),
    )
    yield* s.compact
    yield* s.run("Next native request")
    expect(texts(s.requests.at(-1), "user")).toEqual(["Post native request", "Next native request"])
    expect(all(s.requests.at(-1))).not.toContain("Pre native")
  })

  scenario(
    "is not due right after a reset, and after an undo counts no anchor measured while it hid history",
    function* (s) {
      s.currentModel = windowModel
      yield* s.llm.push(TestLLM.textWithUsage("Long answer", "long", 8_995))
      yield* s.session.prompt({ sessionID, text: "Long question", resume: false })
      yield* s.resume
      const reset = yield* s.reset()
      yield* s.llm.push(TestLLM.textWithUsage("Short answer", "short", 50))
      yield* s.session.prompt({ sessionID, text: "Short question", resume: false })
      yield* s.resume
      expect(s.requests).toHaveLength(2)

      yield* s.undo(reset.id)
      yield* s.llm.push(
        TestLLM.text("## Objective\n- restored", "summary"),
        TestLLM.text("Restored answer", "restored"),
      )
      yield* s.session.prompt({ sessionID, text: "Question after the undo", resume: false })
      yield* s.resume
      // The restored window reaches the trigger: the anchor before the reset plus the rest, not the hidden count of 50.
      expect(s.requests).toHaveLength(4)
      expect(texts(s.requests[2], "user").at(-1)).toBe(SessionCompaction.buildPrompt(false))
    },
  )

  scenario("forks copy the marker; a fork before it and a committed revert keep the earlier history", function* (s) {
    const first = yield* s.run("Before fork")
    const reset = yield* s.reset()
    yield* s.run("After fork point")
    const through = yield* s.session.fork({ sessionID })
    const forked = yield* s.session.context(through.id)
    expect(forked[0]).toMatchObject({ type: "compaction", reason: "reset" })
    yield* s.session.undoReset({ sessionID: through.id, resetID: forked[0]!.id })
    expect(
      (yield* s.session.context(through.id)).some(
        (message) => message.type === "user" && message.text === "Before fork",
      ),
    ).toBe(true)
    expect((yield* s.context)[0]).toMatchObject({ id: reset.id, reason: "reset" })
    expect(marker(yield* s.messages, reset.id)).not.toHaveProperty("undone")

    const before = yield* s.session.fork({ sessionID, before: reset.id })
    expect((yield* s.session.context(before.id)).map((message) => message.type === "user" && message.text)).toContain(
      "Before fork",
    )
    expect((yield* s.session.messages({ sessionID: before.id })).some((message) => message.type === "compaction")).toBe(
      false,
    )

    yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: first.id })
    expect(marker(yield* s.messages, reset.id)).toBeUndefined()
  })

  scenario("replays to the same messages, inbox and instruction state", function* (s) {
    yield* s.run("First")
    s.systemBaseline = "Changed"
    const reset = yield* s.reset()
    yield* s.run("Second")
    yield* s.undo(reset.id)
    yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    // Rows carry their projection's wall-clock `time_updated`; everything else must replay identically.
    const snapshot = Effect.gen(function* () {
      return {
        messages: (yield* s.db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()).map((row) => ({ ...row, time_updated: undefined })),
        inbox: yield* s.db.select().from(SessionInboxTable).where(eq(SessionInboxTable.session_id, sessionID)).all(),
        state: yield* s.db
          .select()
          .from(InstructionStateTable)
          .where(eq(InstructionStateTable.session_id, sessionID))
          .all(),
      }
    }).pipe(Effect.orDie)
    const live = yield* snapshot
    const recorded = yield* s.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    yield* s.bus.remove(sessionID)
    yield* s.db
      .delete(InstructionStateTable)
      .where(eq(InstructionStateTable.session_id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* s.db.delete(SessionInboxTable).where(eq(SessionInboxTable.session_id, sessionID)).run().pipe(Effect.orDie)
    yield* s.db
      .delete(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      recorded,
      (event) =>
        s.bus.replay({
          id: event.id,
          created: event.created,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        }),
      { discard: true },
    )
    expect(yield* snapshot).toEqual(live)
    expect(live.inbox).toHaveLength(1)
  })
})
// OWN-PATCH(P-035) end
