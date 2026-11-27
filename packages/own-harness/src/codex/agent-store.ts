// The durable side of the agent trees (collab.ts, collab-v1.ts) in the plugin's storage, so a restarted server still
// resolves agents by path or id, still tells a parent when its agent finishes, and still starts an agent's requests with
// the history it forked. Codex keeps the same facts in its state database and rollouts (agent/control/spawn.rs
// `restore_v2_agent_metadata`). Each tree's agents are one record per root session, read once per process when the
// tree is first used; forks are one record per agent. Waiters and mailboxes stay in memory: a restart ends every
// pending `wait_agent` call anyway.
export * as AgentStore from "./agent-store.js"

import { Message, SystemPart } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { Effect, Option, Schema } from "effect"
import type { CodexAgents } from "./agents/index.js"

/**
 * A fork whose JSON is longer than this is not stored. A full-history prefix falls back to the history fork; a history
 * fork is kept in memory only, so after a restart that agent starts without it.
 */
export const MAX_FORK_CHARS = 16 * 1024 * 1024

const FORK_PREFIX = "collab-fork/"

/** Codex's agent status as stored. */
export const Status = Schema.Union([
  Schema.Literals(["pending_init", "running", "interrupted", "shutdown", "not_found"]),
  Schema.Struct({ completed: Schema.NullOr(Schema.String) }),
  Schema.Struct({ errored: Schema.String }),
])

/**
 * The status of a stored agent this process did not run: a turn that was still going when the process stopped did
 * not survive it (core resumes top-level sessions only), so it reads as interrupted, as Codex leaves restored agents'
 * runtimes closed.
 */
export function restored(status: CodexAgents.AgentStatus): CodexAgents.AgentStatus {
  return status === "pending_init" || status === "running" ? "interrupted" : status
}

/** Whether a session belongs to this plugin instance's Location: events reach every instance, one acts on them. */
export function local(ctx: Pick<Context, "location">, info: Pick<Session.Info, "location">) {
  return info.location.directory === ctx.location.directory && info.location.workspaceID === ctx.location.workspaceID
}

/** One stored record per tree root: read once per process, written one at a time with the state current at writing. */
export class Records<A> {
  private readonly loads = new Map<string, Promise<void>>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Pick<Context, "storage">,
    private readonly prefix: string,
    /** The record's schema decoder (`Schema.decodeUnknownOption`). */
    private readonly decode: (value: unknown) => Option.Option<A>,
  ) {}

  /** Gives `apply` the stored record of `root` the first time; later calls wait for that first load. */
  load(root: string, apply: (record: A) => Effect.Effect<void>) {
    const known = this.loads.get(root)
    if (known !== undefined) return Effect.promise(() => known)
    const loading = Effect.runPromise(
      this.ctx.storage.get(this.prefix + root).pipe(
        Effect.map((value) => (value === undefined ? Option.none() : this.decode(value))),
        Effect.flatMap((record) => (Option.isSome(record) ? apply(record.value) : Effect.void)),
        Effect.catchCause((cause) => Effect.sync(() => warn("agent_tree_load_failed", String(cause)))),
      ),
    )
    this.loads.set(root, loading)
    return Effect.promise(() => loading)
  }

  /** Stores what `current` answers when the write runs; undefined removes the record. */
  save(root: string, current: () => A | undefined) {
    const write = () => {
      const record = current()
      return Effect.runPromise(
        (record === undefined
          ? this.ctx.storage.remove(this.prefix + root)
          : this.ctx.storage.set(this.prefix + root, record as Schema.Json)
        ).pipe(Effect.catchCause((cause) => Effect.sync(() => warn("agent_tree_save_failed", String(cause))))),
      )
    }
    const next = this.queue.then(write, write)
    this.queue = next
    return Effect.promise(() => next)
  }

  /** Drops the record of a deleted root. */
  remove(root: string) {
    this.loads.delete(root)
    return this.save(root, () => undefined)
  }
}

/** A session's request as it was sent, which a full-history fork of its children starts with. */
export interface Prefix {
  readonly system: ReadonlyArray<SystemPart>
  readonly messages: ReadonlyArray<Message>
  /** The session whose id names the request's `additional_tools` item: the first of a chain of such forks. */
  readonly thread: string
  /**
   * The Responses Lite window the request ran in (incremental.ts): the model it recorded last and that model's base
   * instructions. Absent for an ordinary window, and in prefixes stored before merge round 8 (MR8-17).
   */
  readonly window?: { readonly model: string; readonly base: string }
}

/**
 * What an agent's requests start with.
 * - `prefix`: a v2 full-history fork (`fork_turns` omitted or `all`) since Codex 0.164.0 (#55548 made #52535's
 *   `preserve_fork_prefix` the default): the parent's last request exactly as sent, then the spawning call completed as
 *   `aborted`. The child's requests add their own fragments and conversation after it (CodexRequest).
 * - `history`: the parent's conversation without inter-agent messages and `<multi_agent_role>`, placed after the child's
 *   own initial context. v1's `fork_context`, v2 forks stored before 0.164.0 (read back as they were, no migration), and
 *   a prefix too large to store.
 */
export type Fork =
  | { readonly kind: "history"; readonly messages: ReadonlyArray<Message> }
  | ({ readonly kind: "prefix" } & Prefix)

/** As stored: a history fork is its message array (the shape from before 0.164.0), a prefix fork an object. */
const Stored = Schema.toCodecJson(
  Schema.Union([
    Schema.Array(Message),
    Schema.Struct({
      prefix: Schema.Struct({
        system: Schema.Array(SystemPart),
        messages: Schema.Array(Message),
        thread: Schema.String,
        window: Schema.optional(Schema.Struct({ model: Schema.String, base: Schema.String })),
      }),
    }),
  ]),
)
const decodeStored = Schema.decodeUnknownOption(Stored)

function stored(fork: Fork) {
  if (fork.kind === "history") return fork.messages
  return {
    prefix: {
      system: fork.system,
      messages: fork.messages,
      thread: fork.thread,
      ...(fork.window === undefined ? {} : { window: fork.window }),
    },
  }
}

function fromStored(value: typeof Stored.Type): Fork {
  if ("prefix" in value) return { kind: "prefix", ...value.prefix }
  return { kind: "history", messages: value }
}

/** The forks of agents (`fork_turns: all`, `fork_context`), by the agent's session. */
export class Forks {
  private readonly known = new Map<string, Fork | undefined>()

  constructor(private readonly ctx: Pick<Context, "storage">) {}

  /**
   * Keeps an agent's fork. A prefix whose JSON exceeds the storage cap gives way to `fallback` (logged): the agent
   * forks as before 0.164.0, so a restart still finds what it started with.
   */
  save(sessionID: Session.ID, fork: Fork, fallback?: Fork): Effect.Effect<void> {
    // JSON's omission of undefined fields, as core stores message windows (session/provider-context.ts); media assets
    // serialize their bytes as base64.
    const json = JSON.stringify(stored(fork))
    if (json.length > MAX_FORK_CHARS && fallback !== undefined)
      return Effect.sync(() =>
        warn("agent_fork_prefix_not_stored", `${sessionID}: ${json.length} characters, forking the history instead`),
      ).pipe(Effect.andThen(this.save(sessionID, fallback)))
    this.known.set(sessionID, fork)
    if (json.length > MAX_FORK_CHARS)
      return Effect.sync(() => warn("agent_fork_not_stored", `${sessionID}: ${json.length} characters`))
    return this.ctx.storage
      .set(FORK_PREFIX + sessionID, JSON.parse(json) as Schema.Json)
      .pipe(Effect.catchCause((cause) => Effect.sync(() => warn("agent_fork_save_failed", String(cause)))))
  }

  /** The fork of an agent's session; undefined for a session that forked nothing. */
  get(sessionID: Session.ID): Effect.Effect<Fork | undefined> {
    if (this.known.has(sessionID)) return Effect.succeed(this.known.get(sessionID))
    return this.ctx.storage.get(FORK_PREFIX + sessionID).pipe(
      Effect.map((value) =>
        value === undefined ? undefined : Option.getOrUndefined(Option.map(decodeStored(value), fromStored)),
      ),
      Effect.tap((fork) => Effect.sync(() => this.known.set(sessionID, fork))),
      // The request goes out without the fork rather than not at all.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          warn("agent_fork_load_failed", String(cause))
          return undefined
        }),
      ),
    )
  }

  forget(sessionID: Session.ID) {
    this.known.delete(sessionID)
    return this.ctx.storage
      .remove(FORK_PREFIX + sessionID)
      .pipe(Effect.catchCause((cause) => Effect.sync(() => warn("agent_fork_remove_failed", String(cause)))))
  }
}

function warn(message: string, detail: string) {
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), level: "warn", scope: "own.harness", msg: message, detail })}\n`,
  )
}
