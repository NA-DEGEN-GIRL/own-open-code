// Codex's MultiAgentV2 agent tree on own sessions: the `CodexAgents.Host` the collaboration tools run against. The
// user's codex session is `/root`; every spawned agent is a child session (parentID = the spawning agent's session)
// whose canonical path is kept in its metadata. Inter-agent messages are synthetic messages in Codex's text format:
// NEW_TASK starts or steers a turn, MESSAGE and FINAL_ANSWER wait for the recipient's next step without starting one.
// A full-history fork (`fork_turns` omitted or `all`, Codex's default) copies the parent's last request exactly as it
// was sent, then the spawning call completed as `aborted` (Codex 0.164.0, #55548); the child's requests start with that
// copy, so they reuse the parent's prompt cache. The agents of each tree and the forks are kept in the plugin's storage
// (agent-store.ts) and read back after a restart.
export * as Collab from "./collab.js"

import { Message, ToolCallPart, ToolResultPart } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { Gate } from "../gate.js"
import { AgentStore } from "./agent-store.js"
import { CodexAgents } from "./agents/index.js"
import { AgentPath } from "./agents/path.js"

type Ctx = Pick<Context, "session" | "tool" | "location" | "storage">

/** Session metadata: the agent's canonical path (`/root/<task_name>`, …). Absent on the root. */
export const PATH_KEY = "own.harness.agentPath"

/** Metadata `source` of the synthetic messages that carry inter-agent communication. */
export const SOURCE = "own.harness.agent"

/** Plugin tool names: flat names placed in Codex's `collaboration` namespace on the wire (P-024). */
export const toolName = (name: CodexAgents.ToolName) => `${CodexAgents.NAMESPACE}__${name}`
export const TOOLS = CodexAgents.TOOL_NAMES.map(toolName)

/** Codex's text form of an inter-agent message, as it reaches a recipient's history. */
const MESSAGE = /^Message Type: (MESSAGE|NEW_TASK|FINAL_ANSWER)\nTask name: /

export function isAgentMessage(text: string) {
  return MESSAGE.test(text)
}

interface Node {
  readonly sessionID: Session.ID
  readonly path: string
  /** The `/root` session of the tree. */
  readonly root: Session.ID
  status: CodexAgents.AgentStatus
  /** When the agent's current task reached it (its last NEW_TASK), in this process: its messages report work since. */
  taskAt?: number
}

/** A tree's agents as stored, under `collab/<root session>`. */
const Stored = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ sessionID: Session.ID, path: Schema.String, status: AgentStore.Status })),
})

/** The tool call that runs a host method: `spawn_agent` records it in a full-history fork. */
export interface Call {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export class Tree {
  private readonly nodes = new Map<string, Node>()
  private readonly histories = new Map<string, ReadonlyArray<Message>>()
  private readonly inputs = new Map<string, AgentStore.Prefix>()
  /** Forked histories, shared with the v1 tree (collab-v1.ts). */
  readonly forks: AgentStore.Forks
  private readonly records: AgentStore.Records<typeof Stored.Type>
  private readonly waiters = new Map<string, Set<(outcome: CodexAgents.WaitOutcome) => void>>()
  /** Sessions with inter-agent messages delivered since their last request: `wait_agent` returns at once. */
  private readonly mailbox = new Set<string>()

  constructor(
    private readonly ctx: Ctx,
    /** The metadata of input that reached a session's running turn and waits for its next step (ResetWatch). */
    private readonly pending: (
      sessionID: Session.ID,
    ) => ReadonlyArray<Readonly<Record<string, unknown>> | undefined> = () => [],
    /** Marks a turn another agent stops (GoalRuntime `stopping`); returns the mark's withdrawal. */
    private readonly stopping: (sessionID: Session.ID) => () => void = () => () => {},
  ) {
    this.forks = new AgentStore.Forks(ctx)
    this.records = new AgentStore.Records(ctx, "collab/", Schema.decodeUnknownOption(Stored))
  }

  /** Reads a tree's stored agents into memory, once per process; agents this process already knows stay as they are. */
  load(root: Session.ID) {
    return this.records.load(root, (record) =>
      Effect.forEach(
        record.nodes,
        // An agent whose session was deleted while its tree was not loaded drops out.
        (node) =>
          this.ctx.session.get({ sessionID: node.sessionID }).pipe(
            Effect.map(() => {
              if (this.nodes.has(node.sessionID)) return
              this.nodes.set(node.sessionID, { ...node, root, status: AgentStore.restored(node.status) })
            }),
            Effect.ignore,
          ),
        { discard: true },
      ),
    )
  }

  /** The agent path of a session: from its metadata, else `/root`. */
  path(sessionID: Session.ID, metadata: Readonly<Record<string, unknown>> | undefined) {
    const known = this.nodes.get(sessionID)
    if (known !== undefined) return known.path
    const stored = metadata?.[PATH_KEY]
    return typeof stored === "string" ? stored : AgentPath.ROOT
  }

  /**
   * Records what a session's request carried, for forks of its children: the model-visible history (v1's
   * `fork_context`, and the v2 fallback) and the whole request as sent (v2 full-history forks; absent off OpenAI
   * Responses, whose requests have no developer messages to keep the prefix in).
   */
  remember(sessionID: Session.ID, history: ReadonlyArray<Message>, input?: AgentStore.Prefix) {
    this.histories.set(sessionID, history)
    if (input === undefined) this.inputs.delete(sessionID)
    if (input !== undefined) this.inputs.set(sessionID, input)
    this.mailbox.delete(sessionID)
  }

  /** The model-visible history the session's last request carried. */
  history(sessionID: Session.ID) {
    return this.histories.get(sessionID)
  }

  /** The fork a child's requests start with (from storage after a restart). */
  forked(sessionID: Session.ID) {
    return this.forks.get(sessionID)
  }

  started(sessionID: Session.ID) {
    return this.locate(sessionID).pipe(
      Effect.flatMap((node) => {
        if (node === undefined) return Effect.void
        node.status = "running"
        return this.persist(node.root)
      }),
    )
  }

  /** A child's turn ended: record its status and send its FINAL_ANSWER to the parent, as Codex does. */
  ended(sessionID: Session.ID, status: CodexAgents.AgentStatus) {
    return this.locate(sessionID).pipe(
      Effect.flatMap((node) => {
        if (node === undefined) return Effect.void
        node.status = status
        const communication = CodexAgents.completion(node.path, status)
        const parent = this.byPath(node.root, AgentPath.parent(node.path) ?? AgentPath.ROOT)
        return this.persist(node.root).pipe(
          Effect.andThen(
            communication === undefined || parent === undefined
              ? Effect.void
              : this.deliver(parent, communication, false, sessionID),
          ),
        )
      }),
    )
  }

  /** New input that is not an inter-agent message ends a `wait_agent` of that session as Codex's `steered`. */
  input(sessionID: Session.ID, metadata: Readonly<Record<string, unknown>> | undefined) {
    if (metadata?.source === SOURCE) return
    this.wake(sessionID, "steered")
  }

  /** A deleted session: its agent, its forked history, and the record of the tree it was the root of. */
  forget(sessionID: Session.ID) {
    const node = this.nodes.get(sessionID)
    this.nodes.delete(sessionID)
    this.histories.delete(sessionID)
    this.inputs.delete(sessionID)
    this.mailbox.delete(sessionID)
    return Effect.all(
      [
        this.forks.forget(sessionID),
        this.records.remove(sessionID),
        ...(node === undefined ? [] : [this.persist(node.root)]),
      ],
      { discard: true },
    )
  }

  /** The Host for a calling session, run by the tool call `call`. */
  host(caller: Session.ID, callerPath: string, root: Session.ID, call?: Call): CodexAgents.Host {
    const tree = this
    const ctx = this.ctx
    return {
      list: async () => [
        { id: root, path: AgentPath.ROOT, status: root === caller ? "running" : (this.nodes.get(root)?.status ?? "running") },
        ...[...tree.nodes.values()]
          .filter((node) => node.root === root)
          .map((node) => ({ id: node.sessionID, path: node.path, status: node.status })),
      ],
      spawn: (request) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const parentID = request.parent.id as Session.ID
            const parent = yield* ctx.session.get({ sessionID: parentID })
            const created = yield* ctx.session.create({
              parentID,
              title: request.path.slice(request.path.lastIndexOf("/") + 1),
              agent: parent.agent,
              model:
                request.model === undefined || parent.model === undefined
                  ? parent.model
                  : { ...parent.model, id: Model.ID.make(request.model) },
              // Codex agents report through `wait_agent` and the mailbox, never by waking the parent (core P-063).
              metadata: { [PATH_KEY]: request.path, "own.report": false },
            })
            const sessionID = created.id as Session.ID
            tree.nodes.set(sessionID, { sessionID, path: request.path, root, status: "pending_init" })
            yield* tree.persist(root)
            if (request.fork === "all") yield* tree.fork(sessionID, parentID, call)
            yield* tree.deliver(sessionID, request.communication, true)
            return { id: sessionID, path: request.path, status: "pending_init" } satisfies CodexAgents.Agent
          }),
        ),
      followup: (target, communication) => Effect.runPromise(tree.deliver(target.id as Session.ID, communication, true)),
      send: (target, communication) =>
        Effect.runPromise(tree.deliver(target.id as Session.ID, communication, false, caller)),
      interrupt: (target) => Effect.runPromise(tree.stop(target.id as Session.ID)),
      wait: (_, timeoutMs) => tree.wait(caller, timeoutMs),
    }
  }

  /**
   * A full-history fork (Codex spawn.rs with `preserve_fork_prefix`, rust-v0.165.0): the parent's last request as sent,
   * with inter-agent messages, `<multi_agent_role>`, commentary and tool records, then the spawning call, which has no
   * output yet in the parent and gets Codex's `aborted` (normalize.rs `ensure_call_outputs_present`). The same step's
   * reasoning and commentary are not in it: core gives the plugin no view of a step in flight. Without a recorded
   * request (none off OpenAI Responses), and when the prefix is too large to store, the child forks the parent's
   * conversation without inter-agent messages and `<multi_agent_role>` instead, as before 0.164.0.
   */
  private fork(sessionID: Session.ID, parentID: Session.ID, call: Call | undefined) {
    const history: AgentStore.Fork = {
      kind: "history",
      messages: (this.histories.get(parentID) ?? []).filter((message) => !agentHistory(message)),
    }
    const input = this.inputs.get(parentID)
    if (input === undefined) return this.forks.save(sessionID, history)
    const step =
      call === undefined
        ? []
        : [
            Message.make({
              role: "assistant",
              content: [ToolCallPart.make({ id: call.id, name: call.name, input: call.input })],
            }),
            Message.make({
              role: "tool",
              content: [ToolResultPart.make({ id: call.id, name: call.name, result: "aborted", resultType: "text" })],
            }),
          ]
    return this.forks.save(sessionID, { kind: "prefix", ...input, messages: [...input.messages, ...step] }, history)
  }

  /**
   * Stops an agent's turn for another agent (`interrupt_agent`, v1 `send_input` with `interrupt`): the goal runtime
   * learns the stop was no user's (#52640), unless no turn was running.
   */
  stop(sessionID: Session.ID) {
    const withdraw = this.stopping(sessionID)
    return this.ctx.session.interrupt({ sessionID }).pipe(
      Effect.tap((result) => Effect.sync(() => void (result.interrupted || withdraw()))),
      Effect.tapCause(() => Effect.sync(withdraw)),
      Effect.asVoid,
    )
  }

  /** The session of an agent path in a tree. */
  byPath(root: Session.ID, path: string) {
    if (AgentPath.isRoot(path)) return root
    return [...this.nodes.values()].find((node) => node.root === root && node.path === path)?.sessionID
  }

  /** Stores a tree's agents as they are when the write runs. */
  private persist(root: Session.ID) {
    return this.records.save(root, () => {
      const nodes = [...this.nodes.values()].filter((node) => node.root === root)
      return nodes.length === 0
        ? undefined
        : { nodes: nodes.map((node) => ({ sessionID: node.sessionID, path: node.path, status: node.status })) }
    })
  }

  /**
   * The agent node of a session, reading its tree from storage the first time (after a restart). Events reach every
   * plugin instance; only the instance of the session's Location reads, so one instance answers for an agent.
   */
  private locate(sessionID: Session.ID): Effect.Effect<Node | undefined> {
    const known = this.nodes.get(sessionID)
    if (known !== undefined) return Effect.succeed(known)
    return this.ctx.session.get({ sessionID }).pipe(
      Effect.flatMap((info) => {
        const path = info.metadata?.[PATH_KEY]
        if (typeof path !== "string" || !AgentStore.local(this.ctx, info)) return Effect.succeed(undefined)
        return rootOf(this.ctx, sessionID, path).pipe(
          Effect.flatMap((root) => this.load(root)),
          Effect.map(() => this.nodes.get(sessionID)),
        )
      }),
      Effect.orElseSucceed(() => undefined),
    )
  }

  /**
   * A NEW_TASK starts (or steers into) a turn; MESSAGE and FINAL_ANSWER wait for the recipient's next step. Those two
   * report the `sender`'s work in the background (core P-035, 11 §7.2): while a context reset waits for the
   * recipient's running turn they still reach that turn, and a reset that applied since the sender's task started
   * holds them back for the next input instead of starting the new context with them.
   */
  private deliver(
    sessionID: Session.ID,
    communication: CodexAgents.Communication,
    trigger: boolean,
    sender?: Session.ID,
  ) {
    const taskAt = sender === undefined ? undefined : this.nodes.get(sender)?.taskAt
    const recipient = trigger ? this.nodes.get(sessionID) : undefined
    if (recipient !== undefined) recipient.taskAt = Date.now()
    return this.ctx.session
      .synthetic({
        sessionID,
        text: communication.content,
        description: `Message from ${communication.author}`,
        metadata: { source: SOURCE, author: communication.author, recipient: communication.recipient },
        delivery: "steer",
        ...(trigger ? {} : { resume: false, background: true, ...(taskAt === undefined ? {} : { startedAt: taskAt }) }),
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.mailbox.add(sessionID)
            this.wake(sessionID, "mailbox")
          }),
        ),
        Effect.asVoid,
      )
  }

  /**
   * `wait_agent` (multi_agents_v2/wait.rs): input already pending for the caller's turn ends it at once, steered input
   * before inter-agent messages (Codex 0.164.0, #55644; `InputQueue::subscribe_activity`), as either ends it later.
   */
  private wait(sessionID: Session.ID, timeoutMs: number) {
    if (this.pending(sessionID).some((metadata) => metadata?.source !== SOURCE))
      return Promise.resolve<CodexAgents.WaitOutcome>("steered")
    if (this.mailbox.has(sessionID)) return Promise.resolve<CodexAgents.WaitOutcome>("mailbox")
    return new Promise<CodexAgents.WaitOutcome>((resolve) => {
      const waiters = this.waiters.get(sessionID) ?? new Set()
      const done = (outcome: CodexAgents.WaitOutcome) => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve(outcome)
      }
      const timer = setTimeout(() => done("timed_out"), timeoutMs)
      waiters.add(done)
      this.waiters.set(sessionID, waiters)
    })
  }

  private wake(sessionID: Session.ID, outcome: CodexAgents.WaitOutcome) {
    const waiters = this.waiters.get(sessionID)
    this.waiters.delete(sessionID)
    waiters?.forEach((done) => done(outcome))
  }
}

/** Inter-agent messages and `<multi_agent_role>` stay out of a history fork (Codex filtered both before 0.164.0). */
function agentHistory(message: Message) {
  return message.content.some(
    (part) => part.type === "text" && (isAgentMessage(part.text) || part.text.startsWith("<multi_agent_role>")),
  )
}

export const register = (ctx: Ctx, tree: Tree) =>
  ctx.tool.transform((editor) => {
    const tools = (CodexAgents.DEFINITION.tools ?? []) as ReadonlyArray<{
      readonly name: CodexAgents.ToolName
      readonly description: string
      readonly parameters: Record<string, unknown>
    }>
    tools.forEach((spec) =>
      editor.add({
        name: toolName(spec.name),
        description: spec.description,
        input: spec.parameters,
        options: { codemode: false, permission: Gate.ACTION },
        execute: (raw: unknown, tool: Tool.Context) =>
          Effect.gen(function* () {
            const info = yield* ctx.session.get({ sessionID: tool.sessionID })
            const path = tree.path(tool.sessionID, info.metadata as Record<string, unknown> | undefined)
            const root = yield* rootOf(ctx, tool.sessionID, path)
            // After a restart the tree's agents come back from storage before any of them is looked up.
            yield* tree.load(root)
            const output = yield* Effect.promise(() =>
              CodexAgents.handle(spec.name, JSON.stringify(raw ?? {}), {
                host: tree.host(tool.sessionID, path, root, {
                  id: tool.id,
                  name: toolName(spec.name),
                  input: raw ?? {},
                }),
                caller: path,
              }),
            )
            // The transcript's subagent card links to the spawned child session (own-web tool aliases).
            const spawned =
              spec.name === "spawn_agent" && output.success === true
                ? tree.byPath(root, String((JSON.parse(output.text) as { task_name?: string }).task_name ?? ""))
                : undefined
            return {
              content: output.text,
              metadata: {
                truncated: true,
                success: output.success ?? true,
                ...(spawned === undefined ? {} : { sessionID: spawned }),
              },
            }
          }).pipe(Effect.orDie),
      }),
    )
  })

/** The `/root` session of a session's tree: up the parent chain while the sessions are agents. */
function rootOf(ctx: Pick<Context, "session">, sessionID: Session.ID, path: string): Effect.Effect<Session.ID> {
  if (AgentPath.isRoot(path)) return Effect.succeed(sessionID)
  return ctx.session.get({ sessionID }).pipe(
    Effect.flatMap((info) =>
      info.parentID === undefined
        ? Effect.succeed(sessionID)
        : ctx.session
            .get({ sessionID: info.parentID })
            .pipe(
              Effect.flatMap((parent) =>
                rootOf(
                  ctx,
                  parent.id as Session.ID,
                  typeof parent.metadata?.[PATH_KEY] === "string" ? (parent.metadata[PATH_KEY] as string) : AgentPath.ROOT,
                ),
              ),
            ),
    ),
    Effect.orElseSucceed(() => sessionID),
  )
}
