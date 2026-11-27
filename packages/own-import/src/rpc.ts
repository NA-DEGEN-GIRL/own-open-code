export * as ImportRpc from "./rpc.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { RpcCallContext, RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Project } from "@opencode/schema/project"
import type { Rpc } from "@opencode/schema/rpc"
import { optional } from "@opencode/schema/schema"
import { OwnID } from "@own/protocol"
import { Portable } from "@own/protocol/portable"
import { OwnImport } from "@own/protocol/rpc-import"
import { Home } from "@own/runtime"
import { Effect, Exit, Option, Schema } from "effect"
import { Build } from "./build.js"
import { SelfHttp } from "./http.js"
import { Execute } from "./migrate/execute.js"
import { Helper } from "./migrate/helper.js"
import { Plan } from "./migrate/plan.js"
import { Singleton } from "./singleton.js"
import { Skills } from "./skills/service.js"
import type { SkillRemote } from "./skills/remote.js"
import { Paths } from "./sources/paths.js"
import { Transcript } from "./transcript/ir.js"
import type { ImportWorker } from "./worker.js"

/**
 * `own.import` on the service thread (09 §5): the handlers every Location registers, the Worker client and the
 * migration job they share through the build's process singleton, and the event leader rule (02 §9.1).
 *
 * - **Handlers** never throw (02 §9.4): `health` answers from memory and never starts the Worker; the I1 methods
 *   (`sources.*`, `sessions.*`) go to the Worker, whose answer is decoded once here with the method's output schema
 *   (it crossed a thread); a failure becomes the method's declared error or `internal_error`. `sessions.list` keeps
 *   its 2 s even while the Worker starts or is busy scanning: past {@link LIST_MS} it answers an empty `scanning` page
 *   and `index.changed` follows the Worker's answer.
 * - **Migration** (I2, 09 §4): `migrate.plan` has the Worker parse the conversation in full (`ImportWorker.SOURCE`,
 *   decoded once here) and sizes it with `Plan.create` over self-HTTP (the import Location's catalog and branch,
 *   own.accounts' `estimate.request` and `accounts.list`); its nonce lives in the singleton. `migrate.execute` answers
 *   `job_busy` while the process's one job runs and only then uses the nonce, starts the job (`Execute`) and answers
 *   its id; `migrate.cancel` and `jobs.list` ask the job. The job imports over self-HTTP and compacts, interrupts and
 *   removes the hidden helper through a live instance's `ctx.session` (09 §5.1).
 * - **Worker** ({@link client}): one per process, started on the first forwarded call (never at load, PF1/PF6) and
 *   unreferenced, so it never keeps the service alive. Source runs start `worker.ts` next to this file; a bundle starts
 *   its embedded source (`OWN_IMPORT_WORKER_SOURCE`) from a Blob URL like own-computer-use's driver workers. An
 *   unexpected end fails the pending calls with `internal_error`, sets `workerReady` false and starts it again once;
 *   after a second end the methods answer `internal_error` until the service restarts.
 * - **Events**: only the leader instance publishes `index.changed` and `job.*`: the control Location's instance when it
 *   exists, else the oldest live one (02 §9.1). Any live instance answers the Worker's `ctx.worktree.list` question.
 * - **Activation** ({@link cleanup}): once per process, when the control Location's instance activates, the helpers a
 *   restart left behind are interrupted and removed (09 §4.4 남은 보조 세션 정리).
 * - **Logs** carry no conversation content, path or password (IG10): a JSON line with a fixed message.
 */

declare const OWN_IMPORT_WORKER_SOURCE: string | undefined

/** What this build offers (`health.features`, 09 §5.2): the viewer, the search, the migration (I2) and skills (09 §9). */
export const FEATURES: ReadonlyArray<OwnImport.Feature> = ["view", "search", "migrate", "skills"]
/** Starts after an unexpected end of the Worker. */
export const RESTARTS = 1
/** How long `close` waits for the Worker to flush `import-index.json` before ending it. */
const CLOSE_MS = 5_000
/**
 * How long `sessions.list` waits for the Worker before it answers a partial page itself: the index's 2 s budget
 * (`Scan.BUDGET_MS`, 09 §2.8) less the decoding and the HTTP answer.
 */
const LIST_MS = 1_900
/**
 * The activation cleanup asks the service's session list this often, this far apart, while the service does not
 * answer yet: the control Location may activate while the service is still starting.
 */
const CLEANUP_TRIES = 10
const CLEANUP_MS = 3_000
/** A list page while the index is still being built and the Worker has not answered yet. */
const PARTIAL: Answer = { ok: true, value: { items: [], total: 0, fresh: 0, cursor: null, scanning: true } }
/** List answers kept per Location for a late Worker (one per input: folder, filters, query, page). */
const ANSWERS = 32
const STOPPED = "the import worker stopped"

// ---------------------------------------------------------------------------------------------------------------
// Worker messages (decoded once here; the Worker decodes what it receives, `ImportWorker.Request`)

const Failure = Schema.Struct({ type: Schema.String, message: Schema.String, data: optional(Schema.Unknown) })
export type Failure = typeof Failure.Type

const Answered = Schema.Union([
  Schema.Struct({ rid: Schema.Int, ok: Schema.Literal(true), value: Schema.Unknown }),
  Schema.Struct({ rid: Schema.Int, ok: Schema.Literal(false), error: Failure }),
])

const Message = Schema.Union([
  Answered,
  Schema.Struct({ event: Schema.Literal("index.changed"), directories: Schema.Array(Schema.String) }),
  Schema.Struct({ call: Schema.Int, op: Schema.Literal("worktrees"), projectID: Schema.String }),
])
/** What the Worker sends: answers by `rid`, `index.changed`, and its `ctx.worktree.list` questions. */
export type WorkerMessage = typeof Message.Type
const decodeMessage = Schema.decodeUnknownOption(Message)

/** A method's result as the Worker gives it: the output before its schema, or a declared error. */
export type Answer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Failure }

/** `ImportWorker.SOURCE`'s answer: the full parse, the folder's project (when asked) and the earlier imports. */
const Sourced = Schema.Struct({
  transcript: Transcript.Info,
  existing: Schema.Array(OwnImport.Imported),
  basePartial: Schema.Boolean,
  project: optional(Schema.Struct({ id: Schema.String, root: Schema.String, folders: Schema.Array(Schema.String) })),
})
const decodeSourced = Schema.decodeUnknownOption(Sourced)
const decodeUnreadable = Schema.decodeUnknownOption(OwnImport.errors.source_unreadable)

/** Keeps the last {@link ANSWERS} list answers, the newest last. */
function remember(answers: Map<string, Answer>, key: string, answer: Answer) {
  answers.delete(key)
  answers.set(key, answer)
  if (answers.size > ANSWERS) answers.delete(answers.keys().next().value ?? key)
}

function broken(message: string): Answer {
  return { ok: false, error: internal(message) }
}

function internal(message: string): Failure {
  return { type: "internal_error", message, data: {} }
}

// ---------------------------------------------------------------------------------------------------------------
// Starting the Worker

export interface Handlers {
  readonly message: (data: unknown) => void
  /** An uncaught error in the Worker (Bun then ends it). */
  readonly error: () => void
  readonly exit: () => void
}

/** One started Worker. */
export interface Port {
  readonly post: (message: ImportWorker.Request) => void
  /** Ends the Worker; returns at once. */
  readonly terminate: () => void
}

/** Starts a Worker that reports to `handlers`; the default is {@link spawnWorker}, tests wrap it. */
export type Spawn = (handlers: Handlers) => Port

/**
 * The Worker of this build: the bundle's embedded source from a Blob URL (revoked once it ran), else `worker.ts` next
 * to this file. Unreferenced, so it never keeps the service process alive.
 */
export const spawnWorker: Spawn = (handlers) => {
  const source = typeof OWN_IMPORT_WORKER_SOURCE === "string" ? OWN_IMPORT_WORKER_SOURCE : undefined
  const url =
    source === undefined
      ? new URL("./worker.ts", import.meta.url).href
      : URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
  // Not on `open`: Bun fires it before the module is fetched. A message, an error or the end means it was read.
  const revoke = () => {
    if (source !== undefined) URL.revokeObjectURL(url)
  }
  const worker = new Worker(url) as unknown as BunWorker
  worker.unref()
  worker.addEventListener("message", (event) => {
    revoke()
    handlers.message(event.data)
  })
  worker.addEventListener("error", () => {
    revoke()
    handlers.error()
  })
  worker.addEventListener("close", () => {
    revoke()
    handlers.exit()
  })
  return { post: (message) => worker.postMessage(message), terminate: () => worker.terminate() }
}

/**
 * What this uses of Bun's `Worker`: with the DOM lib loaded the global `Worker` type is the browser's, without Bun's
 * `close` event or `unref`.
 */
interface BunWorker {
  readonly postMessage: (message: unknown) => void
  readonly terminate: () => void
  readonly unref: () => void
  readonly addEventListener: (
    type: "message" | "error" | "close",
    listener: (event: { readonly data?: unknown }) => void,
  ) => void
}

// ---------------------------------------------------------------------------------------------------------------
// The Worker client

export interface ClientInput {
  /** OWN_HOME of the build's singleton. */
  readonly home: string
  /** Answers the Worker's `ctx.worktree.list({projectID})`. */
  readonly worktrees: (projectID: string) => Promise<ReadonlyArray<string>>
  /** Publishes `index.changed`. */
  readonly publish: (directories: ReadonlyArray<string>) => void
  readonly spawn?: Spawn
  /** Default {@link RESTARTS}. */
  readonly restarts?: number
}

export type Client = ReturnType<typeof client>

interface Running {
  readonly port: Port
  /** Resolves `true` once the Worker answered `hello`. */
  started: Promise<boolean>
  ready: boolean
}

/** The process's Worker: started by the first call, restarted {@link RESTARTS} times after an unexpected end. */
export function client(input: ClientInput) {
  const spawn = input.spawn ?? spawnWorker
  const pending = new Map<number, { readonly port: Port; readonly resolve: (answer: Answer) => void }>()
  const state = {
    current: undefined as Running | undefined,
    restarts: input.restarts ?? RESTARTS,
    /** Closed, or ended once more than it may restart. */
    stopped: false,
    closing: false,
    rid: 0,
  }

  const request = (port: Port, message: (rid: number) => ImportWorker.Request) =>
    new Promise<Answer>((resolve) => {
      const rid = ++state.rid
      pending.set(rid, { port, resolve })
      port.post(message(rid))
    })
  const settle = (rid: number, answer: Answer) => {
    const waiting = pending.get(rid)
    if (waiting === undefined) return
    pending.delete(rid)
    waiting.resolve(answer)
  }
  const failAll = (port: Port, message: string) =>
    [...pending].filter((entry) => entry[1].port === port).forEach((entry) => settle(entry[0], broken(message)))

  const receive = (running: Running, data: unknown) => {
    const message = Option.getOrUndefined(decodeMessage(data))
    if (message === undefined) return
    if ("rid" in message) return settle(message.rid, message)
    if (state.current !== running) return
    if ("event" in message) return input.publish(message.directories)
    void input
      .worktrees(message.projectID)
      .catch(() => [])
      .then((folders) => running.port.post({ op: "reply", call: message.call, folders: [...folders] }))
  }

  const ended = (running: Running) => {
    if (state.current !== running) return
    state.current = undefined
    running.ready = false
    running.port.terminate()
    failAll(running.port, STOPPED)
    if (state.closing) return
    if (state.restarts <= 0) {
      state.stopped = true
      warn("worker_stopped", {})
      return
    }
    state.restarts -= 1
    warn("worker_restarted", {})
    state.current = start()
  }

  const start = (): Running => {
    const holder: { running?: Running } = {}
    const handlers: Handlers = {
      message: (data) => {
        if (holder.running) receive(holder.running, data)
      },
      error: () => {
        if (holder.running) ended(holder.running)
      },
      exit: () => {
        if (holder.running) ended(holder.running)
      },
    }
    const port = spawned(spawn, handlers)
    const running: Running = { port, started: Promise.resolve(false), ready: false }
    holder.running = running
    running.started = request(port, (rid) => ({ op: "hello", rid, home: input.home })).then((answer) => {
      running.ready = answer.ok && state.current === running
      return running.ready
    })
    return running
  }

  return {
    /** A Worker answered `hello` and is running (`health.workerReady`). */
    get ready() {
      return state.current?.ready === true
    },
    /** Runs a method in the Worker (starting it); never rejects. An aborted call answers `internal_error`. */
    async call(
      method: ImportWorker.Call,
      payload: unknown,
      settings: ImportWorker.Settings,
      signal?: AbortSignal,
    ): Promise<Answer> {
      if (state.stopped) return broken(STOPPED)
      state.current ??= start()
      const running = state.current
      if (!(await running.started) || state.current !== running) return broken(STOPPED)
      if (signal?.aborted) return broken("cancelled")
      const answered = new Promise<Answer>((resolve) => {
        const rid = ++state.rid
        const abort = () => {
          running.port.post({ op: "cancel", rid })
          settle(rid, broken("cancelled"))
        }
        pending.set(rid, {
          port: running.port,
          resolve: (answer) => {
            signal?.removeEventListener("abort", abort)
            resolve(answer)
          },
        })
        signal?.addEventListener("abort", abort, { once: true })
        running.port.post({ op: "call", rid, method, input: payload, settings })
      })
      return answered
    },
    /** Lets the Worker flush `import-index.json`, then ends it; later calls answer `internal_error`. */
    async close() {
      state.closing = true
      state.stopped = true
      const running = state.current
      if (running === undefined) return
      await Promise.race([request(running.port, (rid) => ({ op: "close", rid })), Bun.sleep(CLOSE_MS)])
      state.current = undefined
      running.port.terminate()
      failAll(running.port, "the import worker was closed")
    },
  }
}

/** A Worker that cannot even start counts as one that ended at once. */
function spawned(spawn: Spawn, handlers: Handlers): Port {
  try {
    return spawn(handlers)
  } catch {
    const port: Port = { post: () => {}, terminate: () => {} }
    queueMicrotask(handlers.exit)
    return port
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The process's state: the Worker, the migration job and the live instances

interface Instance {
  /** This instance serves the control Location (02 §9.1). */
  readonly control: boolean
  /** `ctx.app.channel`: whose registration file the installed build reads. */
  readonly channel: string
  readonly publish: (directories: ReadonlyArray<string>) => void
  /** Publishes a `job.*` event through this instance's registration. */
  readonly job: (event: Execute.Event) => void
  readonly worktrees: (projectID: string) => Promise<ReadonlyArray<string>>
  /** This Location's `ctx.session`: the helper's compaction, interrupt and removal (09 §4.4, §5.1). */
  readonly sessions: Helper.Sessions
}

export interface Host {
  readonly instances: Instance[]
  readonly client: Client
  /** `index.changed` through the leader. */
  readonly publish: (directories: ReadonlyArray<string>) => void
  /** The service thread's self-HTTP: the plan's reads, the job's imports and helper logs. */
  readonly http: SelfHttp.Client
  /** The control Location's folder: own.accounts' `accounts.list` and `estimate.request` are asked there (02 §9.1). */
  readonly control: string
  /** The process's one migration job (09 §4.8). */
  readonly jobs: Execute.Service
  /** The build's plan nonces (`Plan.NONCES`). */
  readonly nonces: Plan.Nonces
  /** The activation cleanup ({@link cleanup}): `done` once it ran to its end in this process. */
  readonly cleanup: { state: "idle" | "running" | "done" }
  /** The skills methods (09 §9), on this thread: their reads are small and the copies are own's own files. */
  readonly skills: Skills.Service
}

/** The build's skill previews (`SkillRemote.Nonces`): their nonces and temp clones. */
const SKILL_NONCES = Singleton.slot<SkillRemote.Nonces>("skills.nonces", () => new Map())

const HOST = Singleton.slot(
  "worker",
  (shared): Host => {
    const instances: Instance[] = []
    // The control Location's instance leads; without one, the oldest live instance (02 §9.1).
    const leader = () => instances.find((instance) => instance.control) ?? instances[0]
    const publish = (directories: ReadonlyArray<string>) => leader()?.publish(directories)
    // The latest options and the leader's channel, for work no instance asked for (the job's reads).
    const settings = (): ImportWorker.Settings => {
      const options = shared.options()
      return { options, channel: options.channel ?? leader()?.channel ?? "local" }
    }
    const worker = client({
      home: shared.home,
      worktrees: (projectID) => leader()?.worktrees(projectID) ?? Promise.resolve([]),
      publish,
    })
    const http = SelfHttp.create({
      source: SelfHttp.following(() => {
        const current = settings()
        return { service: current.options.service, channel: current.channel }
      }),
    })
    // Session ops go by session id, so any live instance's `ctx.session` serves; the leader's is asked.
    const sessions: Helper.Sessions = {
      compact: (sessionID) => leader()?.sessions.compact(sessionID) ?? Promise.resolve(false),
      interrupt: (sessionID) => leader()?.sessions.interrupt(sessionID) ?? Promise.resolve(false),
      remove: (sessionID) => leader()?.sessions.remove(sessionID) ?? Promise.resolve(false),
    }
    return {
      instances,
      client: worker,
      publish,
      http,
      control: Home.layout(shared.home).control,
      jobs: Execute.create({
        http,
        sessions,
        read: (ref, signal) => read(worker, settings(), ref, signal),
        emit: (event) => leader()?.job(event),
        // The service keeps no durable session events, so its session log never shows the summary's end.
        end: "messages",
      }),
      nonces: shared.get(Plan.NONCES),
      cleanup: { state: "idle" },
      skills: Skills.create({
        home: shared.home,
        options: () => shared.options(),
        nonces: shared.get(SKILL_NONCES),
        // 설정 > 스킬's 상세 보기 of a skill core loads (SK2): the folder core reports for that project.
        loaded: (directory) => http.location.skills(directory).then((found) => (found.ok ? found.value : undefined)),
      }),
    }
  },
  (host) =>
    Effect.promise(async () => {
      await host.skills.close()
      await host.jobs.close()
      await host.client.close()
    }),
)

/** A job's read (09 §4.8): the Worker's full parse of `ref`, decoded once here. */
async function read(
  worker: Client,
  settings: ImportWorker.Settings,
  ref: OwnImport.SourceRef,
  signal: AbortSignal,
): Promise<Execute.Read> {
  const answer = await worker.call("source", { ref }, settings, signal)
  if (!answer.ok) {
    if (answer.error.type === "source_not_found") return { ok: false, error: "source_not_found" }
    const unreadable = Option.getOrUndefined(decodeUnreadable(answer.error.data ?? {}))
    if (answer.error.type === "source_unreadable" && unreadable !== undefined)
      return { ok: false, error: "source_unreadable", reason: unreadable.reason }
    return { ok: false, error: "internal_error" }
  }
  const sourced = Option.getOrUndefined(decodeSourced(answer.value))
  return sourced === undefined ? { ok: false, error: "internal_error" } : { ok: true, transcript: sourced.transcript }
}

// ---------------------------------------------------------------------------------------------------------------
// Registration, the activation cleanup and the handlers

type Definition = OwnImport.Definition
type MethodName = OwnImport.MethodName
type CallContext<M extends MethodName> = RpcCallContext<Definition["methods"][M]>
type Output<M extends MethodName> = Rpc.HandlerOutput<Definition["methods"][M]["output"]>
type Handled<M extends MethodName> = Effect.Effect<Output<M>, Rpc.HandlerError<Definition["methods"][M]>>
type PlanInput = (typeof OwnImport.Definition.methods)["migrate.plan"]["input"]["Type"]

/**
 * Registers `own.import` at this Location over the build's shared Worker and job; this instance joins the leader
 * election. Answers whether it serves the control Location.
 */
export const register = (
  ctx: Pick<Context, "app" | "location" | "rpc" | "session" | "worktree">,
  shared: Singleton.Shared,
) =>
  Effect.gen(function* () {
    const host = shared.get(HOST)
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const settings = (): ImportWorker.Settings => {
      const options = shared.options()
      return { options, channel: options.channel ?? ctx.app.channel }
    }
    const registration = yield* ctx.rpc
      .register(Portable.definition(OwnImport.Definition), handlers(host, settings))
      .pipe(Effect.orDie)
    const envelope = () => ({ eventId: OwnID.EventID.create(), origin: "global" as const })
    const instance: Instance = {
      // Compared as normalized strings: the client names the control folder own gave it (no I/O at load).
      control: Paths.key(ctx.location.directory) === Paths.key(Home.layout(shared.home).control),
      channel: ctx.app.channel,
      publish: (directories) =>
        void run(
          registration.events
            .emit("index.changed", { ...envelope(), directories: [...directories] })
            .pipe(Effect.ignore),
        ),
      job: (event) =>
        void run(
          (event.name === "job.progress"
            ? registration.events.emit("job.progress", { ...envelope(), ...event.data })
            : registration.events.emit("job.finished", { ...envelope(), ...event.data })
          ).pipe(Effect.ignore),
        ),
      worktrees: (projectID) =>
        run(ctx.worktree.list({ projectID: Project.ID.make(projectID) })).then((list) =>
          list.map((item) => item.directory),
        ),
      sessions: Helper.sessions(ctx.session),
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => host.instances.push(instance)),
      () => Effect.sync(() => host.instances.splice(host.instances.indexOf(instance), 1)),
    )
    return instance.control
  })

/**
 * 09 §4.4 남은 보조 세션 정리: core resumes a session it had claimed when the service stopped, so a helper whose job
 * died with the service could summarize again. Once per process, after the control Location activated, every helper is
 * interrupted and removed (`Execute.Service.cleanupHelpers`, sparing a running job's). The service may still be
 * starting, so a list it does not answer is asked again, up to {@link CLEANUP_TRIES} times; a cleanup interrupted with
 * its instance runs again with the next control instance. A request core's recovery sent before this can still spend
 * usage, which own.accounts records like any other (⚠IG8).
 */
export const cleanup = (shared: Singleton.Shared) =>
  Effect.suspend(() => {
    const host = shared.get(HOST)
    if (host.cleanup.state !== "idle") return Effect.void
    host.cleanup.state = "running"
    const attempt = (left: number): Effect.Effect<void> =>
      Effect.promise(() => host.jobs.cleanupHelpers()).pipe(
        Effect.flatMap((cleaned) => {
          if (cleaned.ok)
            return Effect.sync(() => {
              if (cleaned.found > 0) warn("helpers_removed", { found: cleaned.found, removed: cleaned.removed })
            })
          if (left <= 1) return Effect.sync(() => warn("helper_cleanup_failed", { error: cleaned.error }))
          return Effect.sleep(CLEANUP_MS).pipe(Effect.andThen(attempt(left - 1)))
        }),
      )
    return attempt(CLEANUP_TRIES).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          host.cleanup.state = Exit.hasInterrupts(exit) ? "idle" : "done"
        }),
      ),
    )
  })

/** The handlers of one Location; `settings` gives the current plugin options with every call. */
export function handlers(host: Host, settings: () => ImportWorker.Settings): RpcHandlers<Definition> {
  const forward =
    <M extends ImportWorker.Method>(method: M) =>
    (input: unknown, context: CallContext<M>) =>
      Effect.promise((signal) => host.client.call(method, input, settings(), signal)).pipe(
        Effect.flatMap((answer) => decide(method, context, answer)),
      )
  // The 2 s of `sessions.list` hold even while the Worker starts or a scan keeps it busy (09 §2.8): past the
  // deadline the list answers the Worker's last answer to the same input (else an empty `scanning` page), and the late
  // answer is followed by `index.changed` for the folder only when it differs, so the screen asks again once, never
  // in a loop while the Worker stays slow.
  const answered = new Map<string, Answer>()
  const list = async (input: { readonly directory: string }) => {
    const key = JSON.stringify(input)
    const listed = host.client.call("sessions.list", input, settings()).then((answer) => {
      if (answer.ok) remember(answered, key, answer)
      return answer
    })
    const early = await Promise.race([listed, Bun.sleep(LIST_MS).then(() => undefined)])
    if (early !== undefined) return early
    const shown = answered.get(key) ?? PARTIAL
    void listed.then((late) => {
      if (JSON.stringify(late) !== JSON.stringify(shown)) host.publish([input.directory])
    })
    return shown
  }
  return {
    health: () =>
      Effect.sync(() => ({ version: Build.PLUGIN_VERSION, features: [...FEATURES], workerReady: host.client.ready })),
    "sources.list": forward("sources.list"),
    "sources.configure": forward("sources.configure"),
    "sessions.list": (input, context) =>
      Effect.promise(() => list(input)).pipe(Effect.flatMap((answer) => decide("sessions.list", context, answer))),
    "sessions.read": forward("sessions.read"),
    "sessions.search": forward("sessions.search"),
    "migrate.plan": (input, context) =>
      Effect.promise((signal) => plan(host, settings(), input, signal)).pipe(
        Effect.flatMap((planned) =>
          planned.ok ? Effect.succeed(planned.plan) : Effect.fail(declared("migrate.plan", context, planned.error)),
        ),
      ),
    "migrate.execute": (input, context) =>
      Effect.promise(() => runnable(host, input.nonce)).pipe(
        Effect.flatMap((checked): Handled<"migrate.execute"> => {
          if (checked === "nonce_invalid")
            return Effect.fail(context.error("nonce_invalid", "the plan is unknown, used or expired", {}))
          if (checked !== "ready")
            return Effect.fail(
              context.error("target_unavailable", "the target account cannot run now", {
                model: checked.model,
                reason: "account_not_ready",
              }),
            )
          // Asked before the nonce is used, so a busy answer leaves the plan valid for a later try (09 §4.8).
          const busy = host.jobs.running()
          if (busy !== undefined) return Effect.fail(context.error("job_busy", "another import runs", { jobID: busy }))
          const planned = Plan.take(host.nonces, input.nonce)
          if (planned === undefined)
            return Effect.fail(context.error("nonce_invalid", "the plan is unknown, used or expired", {}))
          const started = host.jobs.start(planned)
          return started.ok
            ? Effect.succeed({ jobID: started.jobID })
            : Effect.fail(context.error("job_busy", "another import runs", { jobID: started.jobID }))
        }),
      ),
    "migrate.cancel": (input, context) =>
      Effect.promise(() => host.jobs.cancel(input.jobID)).pipe(
        Effect.flatMap((cancelled) =>
          cancelled.ok
            ? Effect.succeed({ cancelled: cancelled.cancelled })
            : Effect.fail(context.error("job_not_found", "no such running import", { jobID: input.jobID })),
        ),
      ),
    "jobs.list": () => Effect.sync(() => ({ jobs: [...host.jobs.list()] })),
    "skills.list": skill("skills.list", (input) => host.skills.list(input)),
    "skills.import": skill("skills.import", (input) => host.skills.import(input)),
    "skills.preview": skill("skills.preview", (input) => host.skills.preview(input)),
    "skills.install": skill("skills.install", (input) => host.skills.install(input)),
    "skills.updates": skill("skills.updates", () => host.skills.updates()),
    "skills.remove": skill("skills.remove", (input) => host.skills.remove(input)),
    "skills.detail": skill("skills.detail", (input) => host.skills.detail(input)),
  }
}

type SkillMethod =
  | "skills.list"
  | "skills.import"
  | "skills.preview"
  | "skills.install"
  | "skills.updates"
  | "skills.remove"
  | "skills.detail"

/**
 * A skills handler (09 §9): the service's answer, or its declared failure; anything it throws (a file system error
 * while copying) is `internal_error` with a fixed message, never a path.
 */
function skill<M extends SkillMethod>(
  method: M,
  run: (input: (typeof OwnImport.Definition.methods)[M]["input"]["Type"]) => Promise<Skills.Answer<Output<M>>>,
) {
  return (input: (typeof OwnImport.Definition.methods)[M]["input"]["Type"], context: CallContext<M>): Handled<M> =>
    Effect.promise(() =>
      run(input).catch((): Skills.Answer<Output<M>> => {
        warn("skills_failed", { method })
        return { ok: false, error: { type: "internal_error", message: "the skills operation failed", data: {} } }
      }),
    ).pipe(
      Effect.flatMap(
        (answer): Handled<M> =>
          answer.ok ? Effect.succeed(answer.value) : Effect.fail(declared(method, context, answer.error)),
      ),
    )
}

/**
 * Whether a nonce's plan can run now (09 §5.4 `target_unavailable` at execute too): the plan is still valid, and the
 * target's own account, as own.accounts lists it now, can run (`Plan.notReady`). Without an answer from own.accounts
 * the plan's own check stands.
 */
async function runnable(host: Host, nonce: string) {
  const planned = Plan.get(host.nonces, nonce)
  if (planned === undefined) return "nonce_invalid" as const
  const listed = await host.http.accounts.list({ directory: host.control })
  // The account the plan was made for (its picked one), else the provider's first, as the plan read it.
  const account = listed.ok
    ? listed.value.find((item) =>
        planned.accountID === undefined ? item.providerID === planned.target.providerID : item.id === planned.accountID,
      )
    : undefined
  return Plan.notReady(account) ? { model: planned.target } : ("ready" as const)
}

/**
 * `migrate.plan` (09 §4.3–4.6): the Worker's full parse of the conversation and the folder's project, sized by
 * `Plan.create` against the import Location's catalog over self-HTTP. A catalog the service does not answer is
 * `service_unreachable`; any other failure of a read the plan needs is `internal_error`.
 */
async function plan(
  host: Host,
  settings: ImportWorker.Settings,
  input: PlanInput,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly plan: OwnImport.Plan } | { readonly ok: false; readonly error: Failure }> {
  const answer = await host.client.call(
    "source",
    { ref: input.ref, directory: input.directory, ...(input.scope === undefined ? {} : { scope: input.scope }) },
    settings,
    signal,
  )
  if (!answer.ok) return answer
  const sourced = Option.getOrUndefined(decodeSourced(answer.value))
  if (sourced?.project === undefined) return { ok: false, error: internal("unexpected worker answer") }
  // own.accounts answers both at its control Location: the accounts, and the slot's Z and exchange measured at every
  // Location (02 §9.1, 09 §5.6).
  const where = { directory: host.control }
  const failed = { unreachable: false }
  const created = await Plan.create(
    {
      request: input,
      transcript: sourced.transcript,
      project: sourced.project,
      existing: sourced.existing,
      basePartial: sourced.basePartial,
    },
    {
      nonces: host.nonces,
      estimate: (request) => host.http.accounts.estimate(request, where),
      accounts: () => host.http.accounts.list(where).then((listed) => (listed.ok ? listed.value : undefined)),
      catalog: async (directory) => {
        const found = await host.http.location.catalog(directory)
        if (found.ok) return found.value
        failed.unreachable = found.status === null
        throw new Error("the import location's catalog could not be read")
      },
      branch: (directory) => host.http.location.branch(directory).then((found) => (found.ok ? found.value : undefined)),
    },
  ).catch(() => undefined)
  if (created === undefined)
    return {
      ok: false,
      error: failed.unreachable
        ? { type: "service_unreachable", message: "the own service did not answer", data: {} }
        : internal("the plan failed"),
    }
  if (created.ok) return { ok: true, plan: created.plan }
  if (created.error === "target_unavailable")
    return {
      ok: false,
      error: { type: created.error, message: "the target model cannot take the conversation", data: created.data },
    }
  return { ok: false, error: { type: created.error, message: "not a working folder of a project", data: created.data } }
}

/** The Worker's answer as the method's output (decoded once: it crossed a thread) or its declared error. */
function decide<M extends ImportWorker.Method>(method: M, context: CallContext<M>, answer: Answer): Handled<M> {
  if (!answer.ok) return Effect.fail(declared(method, context, answer.error))
  const value = Option.getOrUndefined(OUTPUT[method](answer.value))
  if (value === undefined) return Effect.fail(declared(method, context, internal("unexpected worker answer")))
  return Effect.succeed(value)
}

const OUTPUT: { readonly [M in ImportWorker.Method]: (value: unknown) => Option.Option<Output<M>> } = {
  "sources.list": Schema.decodeUnknownOption(OwnImport.Definition.methods["sources.list"].output),
  "sources.configure": Schema.decodeUnknownOption(OwnImport.Definition.methods["sources.configure"].output),
  "sessions.list": Schema.decodeUnknownOption(OwnImport.Definition.methods["sessions.list"].output),
  "sessions.read": Schema.decodeUnknownOption(OwnImport.Definition.methods["sessions.read"].output),
  "sessions.search": Schema.decodeUnknownOption(OwnImport.Definition.methods["sessions.search"].output),
}

const ERRORS = new Map(
  Object.entries(OwnImport.errors).map(([name, schema]) => [name, Schema.decodeUnknownOption(schema)] as const),
)

/**
 * The Worker's failure as the method's declared error; a type the method does not declare, or data that does not fit
 * its schema, is `internal_error`.
 */
function declared<M extends MethodName>(method: M, context: CallContext<M>, failure: Failure) {
  const known = Object.hasOwn(OwnImport.Definition.methods[method].errors, failure.type)
  const data = known
    ? Option.getOrUndefined(ERRORS.get(failure.type)?.(failure.data ?? {}) ?? Option.none())
    : undefined
  const [type, message, payload] =
    data === undefined ? ["internal_error", "the import worker failed", {}] : [failure.type, failure.message, data]
  // SAFETY: `type` is a declared error of `method` (checked above) and `payload` was decoded with that error's schema.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const error = context.error as unknown as (
    type: string,
    message: string,
    data: unknown,
  ) => Rpc.HandlerError<Definition["methods"][M]>
  return error(type, message, payload)
}

/** One JSON line on stderr; never conversation content, paths or the service password (IG10). */
export function warn(message: string, fields: Readonly<Record<string, unknown>>) {
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), level: "warn", scope: Build.PLUGIN_ID, msg: message, ...fields })}\n`,
  )
}
