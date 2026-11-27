// OWN-PATCH(P-035) begin
// Context reset with the real SessionExecution and SessionRestart (11 §7.2): stops leave queued prompts parked and
// apply a waiting reset, a reset requested while idle applies at once, passive background notices ride along, and
// restart recovery continues only a turn that had begun.
import { describe, expect, setDefaultTimeout } from "bun:test"
import { AIError, InvalidRequestError, LanguageModel, type LLMRequest, type Message } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { EventTable } from "@opencode/core/event/sql"
import { Form } from "@opencode/core/form"
import { Instance } from "@opencode/core/instance/service"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { Instructions } from "@opencode/core/instructions/index"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { McpInstructions } from "@opencode/core/mcp/instructions"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { ReferenceInstructions } from "@opencode/core/reference/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { SkillInstructions } from "@opencode/core/skill/instructions"
import { Snapshot } from "@opencode/core/snapshot"
import { Tool } from "@opencode/core/tool"
import { Document, Info } from "@opencode/schema/config"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Scope, Stream } from "effect"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

setDefaultTimeout(30_000)

const model = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
class LLMRequests extends Context.Service<LLMRequests, LLMRequest[]>()("test/LLMRequests") {}
// Every model call a test does not push is a failure the test sees as an extra request.
const testLLM = Layer.unwrap(
  Effect.sync(() => {
    const requests: LLMRequest[] = []
    return TestLLM.testLayer({
      fallback: TestLLM.text("UNEXPECTED", "unexpected"),
      transformRequest: (request) => {
        requests.push(request)
        return request
      },
    }).pipe(Layer.merge(Layer.succeed(LLMRequests, requests)))
  }),
)

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
const empty = { load: () => Effect.succeed(Instructions.empty) }
const replacements: LayerNode.Replacements = [
  Snapshot.node.replace(Snapshot.noopLayer),
  LayerNodePlatform.llmClient.replace(testLLM),
  SessionRunnerModel.node.replace(
    Layer.mock(SessionRunnerModel.Service)({
      select: () =>
        Effect.succeed({
          info: Model.Info.default(Provider.ID.make(model.provider), Model.ID.make(String(model.id))),
          variant: undefined,
        }),
      resolve: () =>
        Effect.succeed(
          SessionRunnerModel.resolved(model, {
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            cost: [],
            limit: { context: 200_000, output: 32_000 },
          }),
        ),
    }),
  ),
  InstructionBuiltIns.node.replace(
    Layer.mock(InstructionBuiltIns.Service, {
      load: () =>
        Effect.succeed(
          Instructions.make({
            key: Instructions.Key.make("test/context"),
            codec: Schema.toCodecJson(Schema.String),
            read: Effect.succeed("Initial context"),
            render: { initial: String, changed: (_previous, current) => current, removed: () => "removed" },
          }),
        ),
    }),
  ),
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
          compaction: new ConfigCompaction.Info({ buffer: 3_000, keep: new ConfigCompaction.Keep({ tokens: 1_000 }) }),
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
// The real local execution (stop delivery in the settled hook, interrupt with resume) over the real runner.
const execution = makeGlobalNode({
  service: SessionExecution.Service,
  layer: SessionExecution.layer.pipe(
    Layer.provide(Layer.succeed(Instance.Service, Instance.Service.of({ provide: () => (effect) => effect as never }))),
    Layer.provide(
      AppNodeBuilder.build(SessionRunnerLLM.node, [
        ...replacements,
        McpInstructions.node.replace(Layer.mock(McpInstructions.Service, empty)),
      ]),
    ),
    Layer.orDie,
  ),
  deps: [SessionStore.node, Bus.node, Database.node, Job.node, SessionInbox.node],
})
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Bus.node,
    Form.node,
    KV.node,
    Job.node,
    SessionProjector.node,
    SessionStore.node,
    SessionInbox.node,
    Agent.node,
    Model.node,
    Tool.node,
    PluginHooks.node,
    makeLocationNode({ name: "test/session-reset-execution-tools", layer: echo, deps: [Tool.node] }),
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
    SessionRestart.node,
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
).pipe(Layer.provideMerge(testLLM))
const it = testEffect(layer)
const sessionID = Session.ID.make("ses_reset_execution")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
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
  const session = yield* Session.Service
  const test = yield* TestLLM.Test
  const llm = { push: test.push, wait: test.wait, gate: test.gate() }
  return {
    db,
    bus: yield* Bus.Service,
    session,
    execution: yield* SessionExecution.Service,
    restart: yield* SessionRestart.Service,
    store: yield* SessionStore.Service,
    jobs: yield* Job.Service,
    llm,
    requests: yield* LLMRequests,
    /** A client prompt: it wakes the Session (steer unless queued). */
    send: (text: string, delivery?: SessionInbox.Delivery) => session.prompt({ sessionID, text, delivery }),
    /** Admitted without a wake, like input a stop leaves parked. */
    admit: (text: string, delivery?: SessionInbox.Delivery) =>
      session.prompt({ sessionID, text, delivery, resume: false }),
    run: Effect.fnUntraced(function* (text: string) {
      yield* llm.push(TestLLM.text(`Answer to ${text}`, `text-${text}`))
      yield* session.prompt({ sessionID, text })
      yield* session.wait(sessionID)
    }),
    reset: session.reset({ sessionID }).pipe(Effect.tap(() => session.wait(sessionID))),
    undo: (resetID: SessionMessage.ID) =>
      session.undoReset({ sessionID, resetID }).pipe(Effect.tap(() => session.wait(sessionID))),
    settle: session.wait(sessionID),
    messages: session.messages({ sessionID }),
    inbox: session.inbox(sessionID),
  }
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

const users = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message: Message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
const pending = (items: readonly SessionInbox.Info[]) =>
  items.map((item) => `${item.type}:${item.delivery}${item.type === "user" ? `:${item.payload.text}` : ""}`)
const OLD_JOB = "<shell>old job</shell>"
/** The notice of a background job that started before every reset (the test clock stands at 0). */
const oldJob = (s: Scenario) => s.session.synthetic({ sessionID, text: OLD_JOB, startedAt: -1 })
/** Real time: restart recovery forks its resume outside the test fiber. */
const poll = (done: () => boolean) =>
  Effect.promise(async () => {
    for (let i = 0; i < 60 && !done(); i++) await Bun.sleep(50)
  })

/** A running turn for `text`, held at its first model call until `release`. */
const busy = Effect.fnUntraced(function* (s: Scenario, text: string) {
  yield* s.llm.push(TestLLM.text(`Answer to ${text}`, `busy-${text}`))
  const gate = yield* s.llm.gate
  yield* s.send(text)
  yield* gate.started
  return gate
})

describe("context reset with the session execution", () => {
  scenario(
    "a stop with resume applies the reset, keeps queued prompts parked, resumes steers behind it",
    function* (s) {
      yield* s.run("Old")
      const gate = yield* busy(s, "Busy")
      yield* s.admit("Queued before", "queue")
      yield* s.session.reset({ sessionID })
      yield* s.admit("Queued after", "queue")
      yield* s.llm.push(TestLLM.text("Steer answer", "steer"))
      yield* s.send("Steer after")
      // TUI ESC ESC: upstream resumes steers and controls only; a waiting reset is applied at the stop.
      yield* s.session.interrupt(sessionID, { resume: true })
      yield* gate.release
      yield* s.settle
      expect(s.requests).toHaveLength(3)
      expect(users(s.requests[2])).toEqual(["Steer after"])
      expect(pending(yield* s.inbox)).toEqual(["user:queue:Queued before", "user:queue:Queued after"])
    },
  )

  scenario(
    "a stop applies a reset ahead of a prompt queued before it, which then starts the new context",
    function* (s) {
      yield* s.run("Old")
      const gate = yield* busy(s, "Busy")
      yield* s.admit("Queued before", "queue")
      yield* s.session.reset({ sessionID })
      yield* s.session.interrupt(sessionID)
      yield* gate.release
      yield* s.settle
      expect(pending(yield* s.inbox)).toEqual(["user:queue:Queued before"])
      expect((yield* s.messages)[0]).toMatchObject({ type: "compaction", reason: "reset" })
      yield* s.llm.push(TestLLM.text("Answer before", "before"), TestLLM.text("Answer new", "new"))
      yield* s.send("New", "queue")
      yield* s.settle
      expect(s.requests.slice(2).map(users)).toEqual([["Queued before"], ["Queued before", "New"]])
    },
  )

  scenario("a reset requested while idle applies at once, ahead of a prompt a stop left parked", function* (s) {
    yield* s.run("Old")
    const gate = yield* busy(s, "Busy")
    yield* s.admit("Parked", "queue")
    yield* s.session.interrupt(sessionID)
    yield* gate.release
    yield* s.settle
    const reset = yield* s.reset
    expect(s.requests).toHaveLength(2)
    expect((yield* s.messages)[0]).toMatchObject({ id: reset.id, reason: "reset" })
    const [parked] = yield* s.inbox
    expect(parked).toMatchObject({ type: "user", delivery: "queue" })
    // Resumed from the queue dock, it runs in the new context.
    yield* s.llm.push(TestLLM.text("Parked answer", "parked"))
    yield* s.session.steerInbox({ sessionID, inboxID: parked!.id })
    yield* s.settle
    expect(users(s.requests.at(-1))).toEqual(["Parked"])
  })

  scenario("a passive notice at idle starts no turn and rides with the next prompt", function* (s) {
    yield* s.run("Old")
    const reset = yield* s.reset
    yield* SubagentCompletion.deliver(s.session, s.jobs, {
      status: "completed",
      output: "result one",
      recovery: {
        kind: "subagent",
        parentSessionID: sessionID,
        childSessionID: Session.ID.make("ses_reset_execution_child"),
        agent: Agent.ID.make("reviewer"),
        description: "review",
      },
      // The test clock stands at 0: the job started before the reset's marker.
      started_at: -1,
    })
    yield* s.settle
    expect(s.requests).toHaveLength(1)
    expect(yield* s.inbox).toMatchObject([{ type: "synthetic", payload: { beforeReset: reset.id } }])
    yield* s.llm.push(TestLLM.text("New answer", "new"))
    yield* s.send("New question", "queue")
    yield* s.settle
    expect(s.requests).toHaveLength(2)
    expect(users(s.requests[1])).toEqual([expect.stringContaining("result one"), "New question"])
    expect(yield* s.inbox).toEqual([])
  })

  scenario("a passive notice arriving during a one-step turn starts no turn after it", function* (s) {
    yield* s.run("Old")
    yield* s.reset
    const gate = yield* busy(s, "New turn")
    yield* s.session.synthetic({ sessionID, text: "<shell>old job</shell>", startedAt: -1 })
    yield* gate.release
    yield* s.settle
    expect(s.requests).toHaveLength(2)
    expect(pending(yield* s.inbox)).toEqual(["synthetic:steer"])
  })

  scenario("a passive notice arriving between steps does not join the continued step", function* (s) {
    yield* s.run("Old")
    yield* s.reset
    yield* s.llm.push(TestLLM.toolCall("call-1", "echo", { text: "tool ran" }), TestLLM.text("Done", "done"))
    const gate = yield* s.llm.gate
    yield* s.send("Two steps")
    yield* gate.started
    yield* s.session.synthetic({ sessionID, text: "<shell>old job</shell>", startedAt: -1 })
    yield* gate.release
    yield* s.settle
    expect(s.requests.slice(1).map(users)).toEqual([["Two steps"], ["Two steps"]])
    expect(pending(yield* s.inbox)).toEqual(["synthetic:steer"])
  })

  scenario("a second reset at idle with only a passive notice waiting makes no model call", function* (s) {
    yield* s.run("Old")
    yield* s.reset
    yield* s.session.synthetic({ sessionID, text: "<shell>old job</shell>", startedAt: -1 })
    const second = yield* s.reset
    expect(s.requests).toHaveLength(1)
    expect((yield* s.messages)[0]).toMatchObject({ id: second.id, reason: "reset" })
    expect(pending(yield* s.inbox)).toEqual(["synthetic:steer"])
  })

  scenario(
    "restart: with nothing begun since the last turn, a waiting reset applies without a continuation",
    function* (s) {
      yield* s.run("Old")
      // A crash between `Execution.Started` and the reset's delivery leaves a claim and the reset.
      const reset = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
      yield* s.store.claim(sessionID)
      yield* s.restart.resumeSuspendedSessions
      yield* s.settle
      expect(s.requests).toHaveLength(1)
      const messages = yield* s.messages
      expect(messages.find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
      expect(messages.some((message) => message.type === "synthetic")).toBe(false)
      expect(yield* s.store.listSuspended()).toEqual([])
    },
  )

  scenario("restart: a turn a shutdown cut off finishes before the waiting reset applies", function* (s) {
    yield* s.run("Old")
    // What a shutdown leaves (upstream v2.1 interrupts in-process only for the user; a shutdown is the owner scope
    // closing): a delivered prompt whose turn never finished, the claim, and a reset that waits behind that turn.
    const inbox = yield* SessionInbox.Service
    const prompt = SessionMessage.ID.create()
    yield* s.session.prompt({ sessionID, id: prompt, text: "Echo first", resume: false })
    yield* s.bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: prompt })
    yield* s.store.claim(sessionID)
    const reset = yield* inbox.admitReset({ sessionID, id: SessionMessage.ID.create() })
    expect(pending(yield* s.inbox)).toEqual(["reset:queue"])
    yield* s.llm.push(TestLLM.text("Turn finished", "finish"))
    yield* s.restart.resumeSuspendedSessions
    yield* poll(() => s.requests.length >= 2)
    yield* s.settle
    expect(s.requests).toHaveLength(2)
    expect(JSON.stringify(s.requests[1]?.messages)).toContain("Echo first")
    expect(users(s.requests[1]).at(-1)).toContain("server restarted")
    expect((yield* s.messages).find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
    expect(yield* s.inbox).toEqual([])
  })

  scenario("replays stop and idle delivery and a passive notice to the same rows", function* (s) {
    yield* s.run("First")
    const gate = yield* busy(s, "Busy")
    yield* s.admit("Parked", "queue")
    yield* s.session.reset({ sessionID })
    yield* s.session.interrupt(sessionID)
    yield* gate.release
    yield* s.settle
    yield* s.session.synthetic({ sessionID, text: "<shell>job</shell>", startedAt: -1 })
    yield* s.reset
    yield* s.llm.push(TestLLM.text("Parked answer", "parked"), TestLLM.text("Next answer", "next"))
    yield* s.send("Next", "queue")
    yield* s.settle
    expect(s.requests.slice(2).map(users)).toEqual([
      ["Parked", expect.stringContaining("<shell>job</shell>")],
      ["Parked", expect.stringContaining("<shell>job</shell>"), "Next"],
    ])
    yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    expect((yield* replays(s)).inbox).toHaveLength(1)
  })
})

describe("a background notice of the turn a reset waits for", () => {
  scenario("reaches that turn at its end; input admitted after the reset starts the new context", function* (s) {
    yield* s.run("Old")
    const gate = yield* busy(s, "Busy")
    yield* s.session.reset({ sessionID })
    yield* s.admit("Steer after")
    // The shell tool's or a subagent's result of work the running turn started.
    yield* oldJob(s)
    expect(yield* s.inbox).toMatchObject([
      { type: "reset" },
      { type: "user" },
      { type: "synthetic", payload: { text: OLD_JOB, background: true } },
    ])
    yield* s.llm.push(TestLLM.text("Seen", "seen"), TestLLM.text("Steer answer", "steer"))
    yield* gate.release
    yield* s.settle
    // The turn takes the result as without a reset, then the reset applies and the steer starts the new context.
    expect(s.requests.slice(1).map(users)).toEqual([["Old", "Busy"], ["Old", "Busy", OLD_JOB], ["Steer after"]])
    expect(yield* s.inbox).toEqual([])
    yield* replays(s)
  })

  scenario("reaches the continued step between steps", function* (s) {
    yield* s.run("Old")
    yield* s.llm.push(TestLLM.toolCall("call-1", "echo", { text: "tool ran" }), TestLLM.text("Done", "done"))
    const gate = yield* s.llm.gate
    yield* s.send("Two steps")
    yield* gate.started
    const reset = yield* s.session.reset({ sessionID })
    yield* oldJob(s)
    yield* gate.release
    yield* s.settle
    expect(s.requests.slice(1).map(users)).toEqual([
      ["Old", "Two steps"],
      ["Old", "Two steps", OLD_JOB],
    ])
    expect((yield* s.messages).find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
    expect(yield* s.inbox).toEqual([])
  })

  scenario("a failed turn applies the reset through its wake; a notice still pending is passive", function* (s) {
    yield* s.run("Old")
    yield* s.llm.push(Stream.fail(new AIError({ reason: new InvalidRequestError({ message: "Invalid request" }) })))
    const gate = yield* s.llm.gate
    yield* s.send("Failing")
    yield* gate.started
    const reset = yield* s.session.reset({ sessionID })
    // The job's result while the turn still runs; the turn fails before a boundary could take it.
    yield* oldJob(s)
    yield* gate.release
    yield* s.settle
    // The reset's wake outlives the failed run and its next drain applies the reset first: no reset waits at idle.
    expect(s.requests).toHaveLength(2)
    expect((yield* s.messages).find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
    expect(yield* s.inbox).toMatchObject([{ type: "synthetic", payload: { text: OLD_JOB, beforeReset: reset.id } }])
    yield* oldJob(s)
    yield* s.settle
    expect(s.requests).toHaveLength(2)
    expect((yield* s.inbox).map((item) => item.type === "synthetic" && item.payload.beforeReset)).toEqual([
      reset.id,
      reset.id,
    ])
  })

  scenario("a reset left waiting while idle applies ahead of it: alone it starts no model call", function* (s) {
    yield* s.run("Old")
    // As after a restart before recovery applied it: no turn runs that the notice could belong to.
    const reset = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    yield* oldJob(s)
    yield* s.settle
    expect(s.requests).toHaveLength(1)
    expect((yield* s.messages).find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
    expect(yield* s.inbox).toMatchObject([{ type: "synthetic", payload: { text: OLD_JOB, beforeReset: reset.id } }])
  })

  scenario("one admitted while a reset waits at idle names it at once, also without a resume", function* (s) {
    yield* s.run("Old")
    const reset = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    // A job's result with its start, and one recovered after a restart from a record without it.
    yield* s.session.synthetic({ sessionID, text: OLD_JOB, startedAt: -1, resume: false })
    yield* s.session.synthetic({ sessionID, text: "<subagent>recovered</subagent>", background: true, resume: false })
    // What own-team's safe point, a move's readiness and Main 멈춤-off read before any drain: no work but the reset.
    expect(yield* s.inbox).toMatchObject([
      { type: "reset" },
      { type: "synthetic", payload: { text: OLD_JOB, beforeReset: reset.id } },
      { type: "synthetic", payload: { text: "<subagent>recovered</subagent>", beforeReset: reset.id } },
    ])
    expect(s.requests).toHaveLength(1)
    yield* s.llm.push(TestLLM.text("Next answer", "next"))
    yield* s.send("Next")
    yield* s.settle
    expect(users(s.requests.at(-1))).toEqual([
      `${SessionInbox.BEFORE_RESET}\n${OLD_JOB}`,
      `${SessionInbox.BEFORE_RESET}\n<subagent>recovered</subagent>`,
      "Next",
    ])
    yield* replays(s)
  })

  for (const cancel of ["DELETE …/reset/:id", "the queue dock's ✕"] as const)
    scenario(`cancelling that reset (${cancel}) keeps a notice without a resume waiting, unwoken`, function* (s) {
      yield* s.run("Old")
      const reset = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
      yield* s.session.synthetic({ sessionID, text: OLD_JOB, startedAt: -1, resume: false })
      if (cancel === "the queue dock's ✕") yield* s.session.cancelInbox({ sessionID, inboxID: reset.id })
      else yield* s.session.undoReset({ sessionID, resetID: reset.id })
      yield* s.settle
      // Ordinary again, and still the notice its caller admitted: it starts nothing until the next input.
      expect(s.requests).toHaveLength(1)
      expect(yield* s.inbox).toMatchObject([{ type: "synthetic", payload: { text: OLD_JOB } }])
      expect((yield* s.inbox)[0]).not.toHaveProperty("payload.beforeReset")
      yield* s.llm.push(TestLLM.text("Next answer", "next"))
      yield* s.send("Next")
      yield* s.settle
      expect(users(s.requests.at(-1))).toEqual(["Old", OLD_JOB, "Next"])
    })

  scenario(
    "a prompt parked before that reset runs first without it: the notice waits for the new context",
    function* (s) {
      yield* s.run("Old")
      yield* s.admit("Parked", "queue")
      yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
      yield* s.session.synthetic({ sessionID, text: OLD_JOB, startedAt: -1, resume: false })
      yield* s.llm.push(TestLLM.text("Parked answer", "parked"), TestLLM.text("Next answer", "next"))
      yield* s.send("Next")
      yield* s.settle
      // The input wake runs the prompt parked before the reset in the old context, then the reset applies.
      expect(s.requests.slice(1).map(users)).toEqual([
        ["Old", "Parked"],
        [`${SessionInbox.BEFORE_RESET}\n${OLD_JOB}`, "Next"],
      ])
    },
  )

  scenario("a reset's delivery settles the compactions behind it in the same transaction", function* (s) {
    yield* s.run("Old")
    const gate = yield* busy(s, "Busy")
    const reset = yield* s.session.reset({ sessionID })
    yield* s.session.compact({ sessionID })
    // What every reader of the delivery sees: the reset applied and nothing left to compact.
    const seen: Array<ReadonlyArray<string>> = []
    const unsubscribe = yield* s.bus.listen((event) =>
      event.type === "session.inbox.delivered" && (event.data as { inboxID?: string }).inboxID === reset.id
        ? SessionInbox.list(s.db, sessionID).pipe(Effect.map((items) => void seen.push(items.map((item) => item.type))))
        : Effect.void,
    )
    yield* gate.release
    yield* s.settle
    yield* unsubscribe
    expect(seen).toEqual([[]])
  })
})

describe("a passive notice follows its reset", () => {
  scenario("undoing the reset makes a waiting one ordinary: it wakes the restored context", function* (s) {
    yield* s.run("Old")
    const reset = yield* s.reset
    yield* oldJob(s)
    yield* s.settle
    expect(s.requests).toHaveLength(1)
    yield* s.llm.push(TestLLM.text("Seen", "seen"))
    yield* s.undo(reset.id)
    expect(s.requests).toHaveLength(2)
    expect(users(s.requests[1])).toEqual(["Old", OLD_JOB])
    expect(yield* s.inbox).toEqual([])
  })

  scenario("one delivered before the undo keeps its line in history", function* (s) {
    yield* s.run("Old")
    const reset = yield* s.reset
    yield* oldJob(s)
    yield* s.run("New")
    const line = `${SessionInbox.BEFORE_RESET}\n${OLD_JOB}`
    expect(users(s.requests[1])).toEqual([line, "New"])
    yield* s.undo(reset.id)
    yield* s.run("After undo")
    expect(users(s.requests[2])).toEqual(["Old", line, "New", "After undo"])
  })

  scenario("undoing an earlier reset while a later one waits leaves it passive behind the later one", function* (s) {
    yield* s.run("Old")
    const first = yield* s.reset
    // A reset left waiting while idle (a restart before recovery): the notice names the earliest reset that applies.
    const second = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    yield* oldJob(s)
    expect(yield* s.inbox).toMatchObject([{ type: "reset" }, { type: "synthetic", payload: { beforeReset: first.id } }])
    yield* s.undo(first.id)
    expect(yield* s.inbox).toMatchObject([
      { type: "reset" },
      { type: "synthetic", payload: { beforeReset: second.id } },
    ])
    expect(s.requests).toHaveLength(1)
    yield* s.run("New")
    expect(users(s.requests[1])).toEqual([`${SessionInbox.BEFORE_RESET}\n${OLD_JOB}`, "New"])
  })

  scenario("replays a release by cancel and by undo, and a compaction settled by a reset", function* (s) {
    yield* s.run("Old")
    const gate = yield* busy(s, "Busy")
    const cancelled = yield* s.session.reset({ sessionID })
    yield* oldJob(s)
    yield* s.llm.push(TestLLM.text("Seen", "seen"))
    yield* s.session.cancelInbox({ sessionID, inboxID: cancelled.id })
    yield* gate.release
    yield* s.settle
    const undone = yield* s.reset
    yield* oldJob(s)
    yield* s.llm.push(TestLLM.text("Seen again", "again"))
    yield* s.undo(undone.id)
    const parked = yield* busy(s, "Parked turn")
    yield* s.session.compact({ sessionID, delivery: "queue" })
    yield* s.session.interrupt(sessionID)
    yield* parked.release
    yield* s.settle
    yield* s.reset
    yield* oldJob(s)
    expect(s.requests).toHaveLength(5)
    yield* replays(s)
  })
})

describe("a background notice of the old turn a reset overtakes", () => {
  const OLD_RESULT = "<shell>old result</shell>"
  const line = `${SessionInbox.BEFORE_RESET}\n${OLD_RESULT}`
  for (const order of ["notice, then reset", "reset, then notice"] as const)
    for (const resume of [true, false])
      scenario(
        `a stop${resume ? " with resume" : ""} that applies the reset leaves it passive (${order})`,
        function* (s) {
          yield* s.run("Old")
          const gate = yield* busy(s, "Busy")
          // The shell tool's notice of a job the old turn started; first it finishes before the reset is requested.
          if (order === "notice, then reset") yield* s.session.synthetic({ sessionID, text: OLD_RESULT, startedAt: -1 })
          const reset = yield* s.session.reset({ sessionID })
          if (order === "reset, then notice") yield* s.session.synthetic({ sessionID, text: OLD_RESULT, startedAt: -1 })
          yield* s.session.interrupt(sessionID, { resume })
          yield* gate.release
          yield* s.settle
          // 03 §18.18: a result of work started before the reset starts no turn in the new context.
          expect(s.requests).toHaveLength(2)
          expect(yield* s.inbox).toMatchObject([
            { type: "synthetic", payload: { text: OLD_RESULT, beforeReset: reset.id } },
          ])
          yield* s.llm.push(TestLLM.text("Next answer", "next"))
          yield* s.send("Next")
          yield* s.settle
          expect(users(s.requests.at(-1))).toEqual([line, "Next"])
        },
      )

  scenario("an idle reset after a stop overtakes it the same way; input a user typed stays ordinary", function* (s) {
    yield* s.run("Old")
    const gate = yield* busy(s, "Busy")
    yield* s.session.synthetic({ sessionID, text: OLD_RESULT, startedAt: -1 })
    // An editor selection the TUI admits before a prompt.
    yield* s.session.synthetic({ sessionID, text: "editor context", resume: false })
    yield* s.session.interrupt(sessionID)
    yield* gate.release
    yield* s.settle
    const reset = yield* s.reset
    expect(s.requests).toHaveLength(2)
    expect(
      (yield* s.inbox).map((item) => (item.type === "synthetic" ? [item.payload.text, item.payload.beforeReset] : [])),
    ).toEqual([
      [OLD_RESULT, reset.id],
      ["editor context", undefined],
    ])
    yield* replays(s)
    yield* s.llm.push(TestLLM.text("Next answer", "next"))
    yield* s.send("Next")
    yield* s.settle
    expect(users(s.requests.at(-1))).toEqual([line, "editor context", "Next"])
  })

  scenario("undoing the reset that overtook it makes it ordinary: the restored context answers it", function* (s) {
    yield* s.run("Old")
    const gate = yield* busy(s, "Busy")
    yield* s.session.synthetic({ sessionID, text: OLD_RESULT, startedAt: -1 })
    const reset = yield* s.session.reset({ sessionID })
    yield* s.session.interrupt(sessionID)
    yield* gate.release
    yield* s.settle
    yield* s.llm.push(TestLLM.text("Seen", "seen"))
    yield* s.undo(reset.id)
    expect(s.requests).toHaveLength(3)
    expect(users(s.requests[2])).toEqual(["Old", "Busy", OLD_RESULT])
    expect(yield* s.inbox).toEqual([])
  })
})

describe("a stop or a steer-scoped turn and a waiting reset", () => {
  for (const order of ["reset, then stop", "stop, then reset"] as const)
    scenario(
      `a stop applies the reset ahead of an undelivered steer and a queued prompt before it (${order})`,
      function* (s) {
        yield* s.run("Old")
        const gate = yield* busy(s, "Busy")
        yield* s.send("Steer before")
        yield* s.admit("Queued before", "queue")
        if (order === "reset, then stop") yield* s.session.reset({ sessionID })
        yield* s.session.interrupt(sessionID)
        yield* gate.release
        yield* s.settle
        if (order === "stop, then reset") yield* s.reset
        expect((yield* s.messages)[0]).toMatchObject({ type: "compaction", reason: "reset" })
        expect(pending(yield* s.inbox)).toEqual(["user:steer:Steer before", "user:queue:Queued before"])
        yield* s.llm.push(TestLLM.text("Steered", "steered"), TestLLM.text("Queued", "queued"))
        yield* s.send("Next")
        yield* s.settle
        expect(s.requests.slice(2).map(users)).toEqual([
          ["Steer before", "Next"],
          ["Steer before", "Next", "Queued before"],
        ])
      },
    )

  for (const resumed of [true, false])
    scenario(
      `a prompt queued during ${resumed ? "a steer-scoped turn (ESC ESC)" : "an ordinary turn"} before the reset runs in the old context`,
      function* (s) {
        yield* s.run("Old")
        if (resumed) yield* s.llm.push(TestLLM.text("Busy answer", "busy"))
        yield* s.llm.push(TestLLM.text("Steer answer", "steer"))
        const gate = yield* s.llm.gate
        yield* s.send(resumed ? "Busy" : "Steer")
        yield* gate.started
        if (resumed) {
          yield* s.send("Steer")
          yield* s.session.interrupt(sessionID, { resume: true })
          yield* gate.started
        }
        yield* s.send("Queued", "queue")
        yield* s.session.reset({ sessionID })
        yield* s.llm.push(TestLLM.text("Queued answer", "queued"))
        yield* gate.release
        yield* s.settle
        const last = users(s.requests.at(-1))
        expect(last.at(-1)).toBe("Queued")
        expect(last).toContain("Old")
        // The reset applied after its answer, at the end of that turn.
        const messages = yield* s.messages
        expect(messages.findIndex((message) => message.type === "compaction")).toBeLessThan(
          messages.findIndex((message) => message.type === "assistant"),
        )
        expect(yield* s.inbox).toEqual([])
      },
    )

  scenario(
    "a reset requested during a steer-scoped turn applies at its end ahead of a parked prompt; a steer after it runs",
    function* (s) {
      yield* s.run("Old")
      yield* s.llm.push(TestLLM.text("Busy answer", "busy"), TestLLM.text("Steer answer", "steer"))
      const gate = yield* s.llm.gate
      yield* s.send("Busy")
      yield* gate.started
      yield* s.admit("Parked", "queue")
      yield* s.send("Steer")
      yield* s.session.interrupt(sessionID, { resume: true })
      yield* gate.started
      const reset = yield* s.session.reset({ sessionID })
      yield* s.admit("Steer after")
      yield* s.llm.push(TestLLM.text("After answer", "after"))
      yield* gate.release
      yield* s.settle
      expect(users(s.requests.at(-1))).toEqual(["Steer after"])
      expect(pending(yield* s.inbox)).toEqual(["user:queue:Parked"])
      expect((yield* s.messages).find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
    },
  )

  for (const order of ["reset, then stop", "stop, then reset"] as const)
    scenario(`a reset overtaking a compaction queued before it settles it as not needed (${order})`, function* (s) {
      yield* s.run("Old")
      const gate = yield* busy(s, "Busy")
      const compaction = yield* s.session.compact({ sessionID, delivery: "queue" })
      if (order === "reset, then stop") yield* s.session.reset({ sessionID })
      yield* s.session.interrupt(sessionID)
      yield* gate.release
      yield* s.settle
      if (order === "stop, then reset") yield* s.reset
      expect(yield* s.inbox).toEqual([])
      yield* s.run("New")
      expect(users(s.requests.at(-1))).toEqual(["New"])
      const compactions = (yield* s.messages).filter((message) => message.type === "compaction")
      expect(compactions).toMatchObject([{ reason: "reset", status: "completed" }])
      yield* settledOnly(s, compaction.id)
    })

  for (const ending of ["the turn ends", "a stop"] as const)
    scenario(`a compaction admitted behind a waiting reset is settled as not needed when ${ending}`, function* (s) {
      yield* s.run("Old")
      const gate = yield* busy(s, "Busy")
      yield* s.session.reset({ sessionID })
      // The TUI's `/compact`, own-accounts' compact-then-switch or its `compaction.due`: a steered compaction.
      const compaction = yield* s.session.compact({ sessionID })
      if (ending === "a stop") yield* s.session.interrupt(sessionID)
      yield* gate.release
      yield* s.settle
      expect(s.requests).toHaveLength(2)
      expect(yield* s.inbox).toEqual([])
      yield* settledOnly(s, compaction.id)
    })
})

/** The compaction ended as cancelled once (not needed), and no compaction ran or failed. */
const settledOnly = Effect.fnUntraced(function* (s: Scenario, compactionID: SessionMessage.ID) {
  const events = yield* s.db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const settled = events.filter(
    (event) => event.type.startsWith("session.inbox.cancelled.") && JSON.stringify(event.data).includes(compactionID),
  )
  expect(settled).toHaveLength(1)
  expect(events.some((event) => event.type.startsWith("session.compaction."))).toBe(false)
})

describe("restart around a reset", () => {
  scenario("a reset delivered at the turn's end with nothing after it continues nothing", function* (s) {
    yield* s.run("Old")
    const gate = yield* busy(s, "Busy")
    yield* s.session.reset({ sessionID })
    yield* gate.release
    yield* s.settle
    // A death after the runner delivered it and before `Execution.Succeeded` leaves the claim.
    yield* s.store.claim(sessionID)
    yield* s.restart.resumeSuspendedSessions
    yield* s.settle
    expect(s.requests).toHaveLength(2)
    expect((yield* s.messages).some((message) => message.type === "synthetic")).toBe(false)
    expect(yield* s.store.listSuspended()).toEqual([])
  })

  scenario("with nothing begun, a waiting reset applies ahead of a parked prompt and an old notice", function* (s) {
    yield* s.run("Old")
    yield* s.admit("Parked", "queue")
    yield* s.session.synthetic({ sessionID, text: OLD_JOB, startedAt: -1, resume: false })
    // A crash between `Execution.Started` and the reset's delivery leaves a claim and the reset.
    const reset = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    yield* s.store.claim(sessionID)
    yield* s.restart.resumeSuspendedSessions
    yield* s.settle
    expect(s.requests).toHaveLength(1)
    expect((yield* s.messages).find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
    expect(yield* s.inbox).toMatchObject([
      { type: "user", delivery: "queue" },
      { type: "synthetic", payload: { text: OLD_JOB, beforeReset: reset.id } },
    ])
    expect(yield* s.store.listSuspended()).toEqual([])
  })

  scenario("with nothing begun, a reset the user cancels after recovery read it stays cancelled", function* (s) {
    yield* s.run("Old")
    const reset = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    yield* s.admit("Steer after")
    yield* s.store.claim(sessionID)
    // The queue dock's `✕` lands right after recovery read the inbox: its Session cancels the reset after that read.
    const restart = Context.get(
      yield* Layer.build(
        SessionRestart.layer().pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                Session.Service,
                Session.Service.of({
                  ...s.session,
                  inbox: (id) =>
                    s.session
                      .inbox(id)
                      .pipe(
                        Effect.tap(() =>
                          s.session.cancelInbox({ sessionID: id, inboxID: reset.id }).pipe(Effect.orDie),
                        ),
                      ),
                }),
              ),
              Layer.succeed(SessionStore.Service, s.store),
              Layer.succeed(SessionExecution.Service, s.execution),
              Layer.succeed(Bus.Service, s.bus),
              Layer.succeed(Job.Service, s.jobs),
              Layer.succeed(Database.Service, yield* Database.Service),
              Layer.succeed(Instance.Service, Instance.Service.of({ provide: () => (effect) => effect as never })),
            ),
          ),
        ),
      ),
      SessionRestart.Service,
    )
    yield* s.llm.push(TestLLM.text("Steer answer", "steer"))
    yield* restart.resumeSuspendedSessions
    yield* s.settle
    // No marker: the cancelled reset was not admitted again, and the steer after it runs in the old context.
    expect((yield* s.messages).some((message) => message.type === "compaction")).toBe(false)
    expect(users(s.requests.at(-1))).toEqual(["Old", "Steer after"])
    expect(yield* s.inbox).toEqual([])
    expect(yield* s.store.listSuspended()).toEqual([])
  })

  scenario(
    "startup applies a waiting reset only while it still waits: one cancelled meanwhile stays so",
    function* (s) {
      const other = Session.ID.make("ses_reset_execution_other")
      yield* s.db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: Project.ID.global,
          slug: other,
          directory: "/project",
          title: "t",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const inbox = yield* SessionInbox.Service
      const first = yield* inbox.admitReset({ sessionID, id: SessionMessage.ID.create() })
      const second = yield* inbox.admitReset({ sessionID: other, id: SessionMessage.ID.create() })
      // The user cancels the other session's reset after startup read both, while it applies the first.
      const unsubscribe = yield* s.bus.listen((event) =>
        event.type === "session.inbox.delivered" && (event.data as { inboxID?: string }).inboxID === first.id
          ? s.session.cancelInbox({ sessionID: other, inboxID: second.id }).pipe(Effect.ignore)
          : Effect.void,
      )
      yield* s.restart.resumeSuspendedSessions
      yield* unsubscribe
      expect((yield* s.messages)[0]).toMatchObject({ id: first.id, reason: "reset" })
      expect(yield* s.session.messages({ sessionID: other })).toEqual([])
      expect(yield* s.session.inbox(other)).toEqual([])
    },
  )

  scenario("a reset left waiting while idle with no claim applies at startup", function* (s) {
    yield* s.run("Old")
    yield* s.admit("Parked", "queue")
    // A death between a stop's terminal, which released the claim, and the settled hook's delivery.
    const reset = yield* (yield* SessionInbox.Service).admitReset({ sessionID, id: SessionMessage.ID.create() })
    yield* s.restart.resumeSuspendedSessions
    yield* s.settle
    expect(s.requests).toHaveLength(1)
    expect((yield* s.messages).find((message) => message.id === reset.id)).toMatchObject({ reason: "reset" })
    expect(pending(yield* s.inbox)).toEqual(["user:queue:Parked"])
  })
})

/** Rebuilds the Session's projections from its events: the same messages, inbox rows and instruction state. */
const replays = Effect.fnUntraced(function* (s: Scenario) {
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
  yield* s.db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).run().pipe(Effect.orDie)
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
  return live
})
// OWN-PATCH(P-035) end
