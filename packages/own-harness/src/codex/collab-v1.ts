// Codex's MultiAgent v1 agents on own sessions: the `CodexAgentsV1.Host` the `multi_agent_v1` tools run against
// (gpt-5.5 and models outside the catalog). Every spawned agent is a child session of its caller with a Codex thread
// id (a UUID, kept in the child's metadata) and a nickname from the tree's pool. Input reaches an agent as a prompt:
// it starts a turn when the agent is idle and steers the running one otherwise. When an agent's turn ends, its parent
// gets Codex's `<subagent_notification>` without a new turn. A full-history fork copies the parent's last request
// history like the v2 tree (collab.ts). The agents (ids, nicknames, statuses, closed flags) and the forked copies are
// kept in the plugin's storage (agent-store.ts) and read back after a restart.
export * as CollabV1 from "./collab-v1.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { Gate } from "../gate.js"
import { AgentStore } from "./agent-store.js"
import { CodexAgents } from "./agents/index.js"
import type { AgentArgs } from "./agents/args.js"
import { CodexAgentsV1 } from "./agents/v1.js"
import type { Collab } from "./collab.js"
import { ToolSearch } from "./tool-search.js"

type Ctx = Pick<Context, "session" | "tool" | "location" | "storage">

/** Session metadata of a v1 agent: its Codex thread id and its spawn depth. */
export const ID_KEY = "own.harness.agentId"
export const DEPTH_KEY = "own.harness.agentDepth"

/** Metadata `source` of the notifications own sends a parent. */
export const SOURCE = "own.harness.agent.v1"

/** Plugin tool names: flat names placed in Codex's `multi_agent_v1` namespace on the wire (P-024). */
export const toolName = (name: CodexAgentsV1.ToolName) => `${CodexAgentsV1.NAMESPACE}__${name}`
export const TOOLS = CodexAgentsV1.TOOL_NAMES.map(toolName)

/** Codex's tool search index over the deferred v1 agent tools. */
export const SEARCH_INDEX = new ToolSearch.Index(CodexAgentsV1.searchEntries())

interface Node {
  readonly id: string
  readonly sessionID: Session.ID
  readonly parent: Session.ID
  /** The user's session the tree grew from (Codex's per-session registry). */
  readonly root: Session.ID
  readonly depth: number
  readonly nickname?: string
  status: CodexAgentsV1.AgentStatus
  closed: boolean
  /** The status order of the agent's last terminal moment, for `wait`'s "in the order they became final". */
  finalAt?: number
  /** When input last reached the agent, in this process: its `<subagent_notification>` reports work since. */
  inputAt?: number
}

/** A tree's agents as stored, under `collab-v1/<root session>`. */
const Stored = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sessionID: Session.ID,
      parent: Session.ID,
      depth: Schema.Number,
      nickname: Schema.optional(Schema.String),
      status: AgentStore.Status,
      closed: Schema.Boolean,
      finalAt: Schema.optional(Schema.Number),
    }),
  ),
})

export class Tree {
  private readonly nodes = new Map<string, Node>()
  private readonly pools = new Map<string, CodexAgentsV1.NicknamePool>()
  private readonly records: AgentStore.Records<typeof Stored.Type>
  private readonly listeners = new Set<() => void>()
  private sequence = 0

  constructor(
    private readonly ctx: Ctx,
    /** The v2 tree keeps the history each session's last request carried, the forks of both trees, and stops agents. */
    private readonly shared: Pick<Collab.Tree, "history" | "forks" | "stop">,
  ) {
    this.records = new AgentStore.Records(ctx, "collab-v1/", Schema.decodeUnknownOption(Stored))
  }

  /**
   * Reads a tree's stored agents into memory, once per process: their nicknames stay reserved, and the order in which
   * they became final continues. Agents this process already knows stay as they are.
   */
  load(root: Session.ID) {
    return this.records.load(root, (record) =>
      Effect.forEach(
        record.nodes,
        // An agent whose session was deleted while its tree was not loaded drops out.
        (node) =>
          this.ctx.session.get({ sessionID: node.sessionID }).pipe(
            Effect.map(() => {
              if (this.nodes.has(node.id)) return
              const pool = this.pools.get(root) ?? new CodexAgentsV1.NicknamePool()
              this.pools.set(root, pool)
              if (node.nickname !== undefined) pool.reserve(node.nickname)
              if (node.finalAt !== undefined) this.sequence = Math.max(this.sequence, node.finalAt + 1)
              this.nodes.set(node.id, { ...node, root, status: AgentStore.restored(node.status) })
            }),
            Effect.ignore,
          ),
        { discard: true },
      ),
    )
  }

  started(sessionID: Session.ID) {
    return this.locate(sessionID).pipe(
      Effect.flatMap((node) => {
        if (node === undefined) return Effect.void
        node.status = "running"
        this.changed()
        return this.persist(node.root)
      }),
    )
  }

  /** An agent's turn ended: its Codex status, and the parent's `<subagent_notification>`. */
  ended(sessionID: Session.ID, status: CodexAgentsV1.AgentStatus) {
    return this.locate(sessionID).pipe(
      Effect.flatMap((node) => {
        if (node === undefined) return Effect.void
        node.status = status
        if (CodexAgentsV1.isFinal(status)) node.finalAt = this.sequence++
        this.changed()
        const text = CodexAgentsV1.notification(node.id, status)
        const notify =
          text === undefined || node.closed
            ? Effect.void
            : this.ctx.session
                .synthetic({
                  sessionID: node.parent,
                  text,
                  description: `Agent ${node.nickname ?? node.id} finished`,
                  metadata: { source: SOURCE, agent: node.id },
                  delivery: "steer",
                  resume: false,
                  // Background work of the agent (core P-035, 11 §7.2): it reaches the parent's running turn while a
                  // context reset waits, and a reset that applied since the agent's input waits for the next input.
                  background: true,
                  ...(node.inputAt === undefined ? {} : { startedAt: node.inputAt }),
                })
                .pipe(Effect.asVoid)
        return this.persist(node.root).pipe(Effect.andThen(notify))
      }),
    )
  }

  /** A deleted session: its agent, its forked history, and the record of the tree it was the root of. */
  forget(sessionID: Session.ID) {
    const node = this.bySession(sessionID)
    if (node !== undefined) this.nodes.delete(node.id)
    return Effect.all(
      [
        this.shared.forks.forget(sessionID),
        this.records.remove(sessionID),
        ...(node === undefined ? [] : [this.persist(node.root)]),
      ],
      { discard: true },
    )
  }

  /** The Host for a calling session; `root` is the user's session of its tree. */
  host(caller: Session.ID, root: Session.ID): CodexAgentsV1.Host {
    const tree = this
    const ctx = this.ctx
    const open = (id: string) => {
      const node = tree.nodes.get(id)
      if (node === undefined || node.closed) throw new CodexAgents.AgentError(CodexAgentsV1.notFound(id))
      return node
    }
    return {
      list: async () =>
        [...tree.nodes.values()]
          .filter((node) => node.root === root && !node.closed)
          .map((node) => ({ id: node.id, status: node.status, nickname: node.nickname })),
      spawn: (request) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const parent = yield* ctx.session.get({ sessionID: caller })
            const id = crypto.randomUUID()
            const pool = tree.pools.get(root) ?? new CodexAgentsV1.NicknamePool()
            tree.pools.set(root, pool)
            const nickname = pool.reserve()
            const created = yield* ctx.session.create({
              parentID: caller,
              title: nickname ?? id,
              agent: parent.agent,
              model:
                request.model === undefined || parent.model === undefined
                  ? parent.model
                  : { ...parent.model, id: Model.ID.make(request.model) },
              // Codex agents report through `wait` and their notifications, never by waking the parent (core P-063).
              metadata: { [ID_KEY]: id, [DEPTH_KEY]: request.depth, "own.report": false },
            })
            const sessionID = created.id as Session.ID
            tree.nodes.set(id, {
              id,
              sessionID,
              parent: caller,
              root,
              depth: request.depth,
              nickname,
              status: "pending_init",
              closed: false,
            })
            yield* tree.persist(root)
            if (request.forkContext)
              yield* tree.shared.forks.save(sessionID, { kind: "history", messages: tree.shared.history(caller) ?? [] })
            yield* tree.prompt(sessionID, request.input)
            return { id, status: "pending_init", nickname } satisfies CodexAgentsV1.Agent
          }),
        ),
      sendInput: async (id, input) => {
        const node = open(id)
        const running = node.status === "running"
        const messageID = await Effect.runPromise(tree.prompt(node.sessionID, input))
        // Codex answers the new turn's id, or a fresh UUIDv7 when the input steers a running turn.
        return running ? Bun.randomUUIDv7() : messageID
      },
      interrupt: async (id) => {
        const node = open(id)
        await Effect.runPromise(tree.shared.stop(node.sessionID))
      },
      resume: async (id) => {
        const node = tree.nodes.get(id)
        if (node === undefined) throw new CodexAgents.AgentError(CodexAgentsV1.notFound(id))
        node.closed = false
        await Effect.runPromise(tree.persist(node.root))
        return node.status
      },
      close: async (id) => {
        const node = open(id)
        const previous = node.status
        node.closed = true
        await Effect.runPromise(tree.persist(node.root))
        await Effect.runPromise(ctx.session.interrupt({ sessionID: node.sessionID }).pipe(Effect.ignore))
        tree.changed()
        return previous
      },
      status: async (id) => {
        const node = tree.nodes.get(id)
        return node === undefined || node.closed ? "not_found" : node.status
      },
      wait: (ids, timeoutMs) => tree.wait(ids, timeoutMs),
    }
  }

  private bySession(sessionID: Session.ID) {
    return [...this.nodes.values()].find((node) => node.sessionID === sessionID)
  }

  /** Stores a tree's agents as they are when the write runs. */
  private persist(root: Session.ID) {
    return this.records.save(root, () => {
      const nodes = [...this.nodes.values()].filter((node) => node.root === root)
      if (nodes.length === 0) return undefined
      return {
        nodes: nodes.map((node) => ({
          id: node.id,
          sessionID: node.sessionID,
          parent: node.parent,
          depth: node.depth,
          ...(node.nickname === undefined ? {} : { nickname: node.nickname }),
          status: node.status,
          closed: node.closed,
          ...(node.finalAt === undefined ? {} : { finalAt: node.finalAt }),
        })),
      }
    })
  }

  /**
   * The agent node of a session, reading its tree from storage the first time (after a restart). Events reach every
   * plugin instance; only the instance of the session's Location reads, so one instance answers for an agent.
   */
  private locate(sessionID: Session.ID): Effect.Effect<Node | undefined> {
    const known = this.bySession(sessionID)
    if (known !== undefined) return Effect.succeed(known)
    return this.ctx.session.get({ sessionID }).pipe(
      Effect.flatMap((info) => {
        if (info.metadata?.[ID_KEY] === undefined || !AgentStore.local(this.ctx, info)) return Effect.succeed(undefined)
        return rootOf(this.ctx, sessionID).pipe(
          Effect.flatMap((root) => this.load(root)),
          Effect.map(() => this.bySession(sessionID)),
        )
      }),
      Effect.orElseSucceed(() => undefined),
    )
  }

  /** Codex's user input as an own prompt: text items as text, data-URL images as files; others are not supported. */
  private prompt(sessionID: Session.ID, input: ReadonlyArray<AgentArgs.UserInput>) {
    const text = input.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
    const files = input.flatMap((item) =>
      item.type === "image" && "image_url" in item && item.image_url.startsWith("data:")
        ? [{ uri: item.image_url }]
        : [],
    )
    const node = this.bySession(sessionID)
    if (node !== undefined) node.inputAt = Date.now()
    return this.ctx.session
      .prompt({ sessionID, text, ...(files.length === 0 ? {} : { files }), metadata: { source: SOURCE } })
      .pipe(Effect.map((item) => String((item as { id?: string }).id ?? Bun.randomUUIDv7())))
  }

  private wait(ids: ReadonlyArray<string>, timeoutMs: number) {
    const final = () =>
      ids
        .flatMap((id) => {
          const node = this.nodes.get(id)
          return node !== undefined && CodexAgentsV1.isFinal(node.status) ? [node] : []
        })
        .toSorted((left, right) => (left.finalAt ?? 0) - (right.finalAt ?? 0))
        .map((node) => [node.id, node.status] as const)
    const ready = final()
    if (ready.length > 0) return Promise.resolve(ready)
    return new Promise<ReadonlyArray<readonly [string, CodexAgentsV1.AgentStatus]>>((resolve) => {
      const check = () => {
        const done = final()
        if (done.length === 0) return
        finish(done)
      }
      const finish = (result: ReadonlyArray<readonly [string, CodexAgentsV1.AgentStatus]>) => {
        clearTimeout(timer)
        this.listeners.delete(check)
        resolve(result)
      }
      const timer = setTimeout(() => finish([]), timeoutMs)
      this.listeners.add(check)
    })
  }

  private changed() {
    this.listeners.forEach((listener) => listener())
  }
}

export const register = (ctx: Ctx, tree: Tree) =>
  ctx.tool.transform((editor) => {
    // Client tool search: the result is the `tool_search_output` tools as JSON (P-026 sends it as such).
    editor.add({
      name: ToolSearch.TOOL_NAME,
      description: "Search deferred tools.",
      input: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      },
      options: { codemode: false, permission: Gate.ACTION },
      execute: (raw: unknown) =>
        Effect.sync(() => {
          const outcome = ToolSearch.handle(SEARCH_INDEX, raw)
          return {
            content: outcome.kind === "output" ? JSON.stringify(outcome.tools) : outcome.text,
            metadata: { truncated: true },
          }
        }),
    })
    const tools = CodexAgentsV1.DEFINITION.tools as ReadonlyArray<{
      readonly name: CodexAgentsV1.ToolName
      readonly description: string
      readonly parameters?: unknown
    }>
    tools.forEach((spec) =>
      editor.add({
        name: toolName(spec.name),
        description: spec.description,
        input: (spec.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
        options: { codemode: false, permission: Gate.ACTION },
        execute: (raw: unknown, tool: Tool.Context) =>
          Effect.gen(function* () {
            const info = yield* ctx.session.get({ sessionID: tool.sessionID })
            const depth = Number(info.metadata?.[DEPTH_KEY] ?? 0)
            const root = yield* rootOf(ctx, tool.sessionID)
            // After a restart the tree's agents come back from storage before any of them is looked up.
            yield* tree.load(root)
            const output = yield* Effect.promise(() =>
              CodexAgentsV1.handle(spec.name, JSON.stringify(raw ?? {}), {
                host: tree.host(tool.sessionID, root),
                depth,
              }),
            )
            return { content: output.text, metadata: { truncated: true, success: output.success ?? true } }
          }).pipe(Effect.orDie),
      }),
    )
  })

/** The user's session at the top of a v1 agent's chain. */
function rootOf(ctx: Pick<Context, "session">, sessionID: Session.ID): Effect.Effect<Session.ID> {
  return ctx.session.get({ sessionID }).pipe(
    Effect.flatMap((info) =>
      info.parentID === undefined || info.metadata?.[ID_KEY] === undefined
        ? Effect.succeed(sessionID)
        : rootOf(ctx, info.parentID as Session.ID),
    ),
    Effect.orElseSucceed(() => sessionID),
  )
}
