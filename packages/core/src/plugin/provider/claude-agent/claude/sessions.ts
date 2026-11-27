export * as ClaudeSessions from "./sessions.js"

import type { Options, SDKControlGetUsageResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-044) begin
import type { SpareProcess } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-044) end
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
} from "@ai-sdk/provider"
import { Effect, Fiber, Semaphore } from "effect"
// OWN-PATCH(P-043) begin
import { SubscriptionRef } from "effect"
// OWN-PATCH(P-043) end
import { ClaudeIO } from "./io.js"
// OWN-PATCH(P-039) begin
import { ClaudeObserver } from "./observer.js"
// OWN-PATCH(P-039) end
// OWN-PATCH(P-044) begin
import { ClaudePool } from "./pool.js"
// OWN-PATCH(P-044) end
import { ClaudeProbe } from "./probe.js"
import type { ClaudeStatus } from "./status.js"
import { ClaudeQueryOptions } from "./query-options.js"
// OWN-PATCH(P-052) begin
import type { ClaudeRelay } from "./relay.js"
// OWN-PATCH(P-052) end
import { ClaudeSession } from "./session.js"
// OWN-PATCH(P-043) begin
import { ClaudeTranscripts } from "./transcripts.js"
// OWN-PATCH(P-052) begin
import { FolderStore } from "./folder-store.js"
// OWN-PATCH(P-052) end
import { NativeTranscript } from "../sync/native.js"
// OWN-PATCH(P-043) end
import { SessionRecord } from "../sync/record.js"
import { Checkpoints } from "../sync/checkpoints.js"
import { SyncDecision } from "../sync/decide.js"
import { CatchUp } from "../sync/catch-up.js"
import { ConvertToClaudeMessage } from "../language-model/convert-to-claude-message.js"
import { PendingTools } from "../tools/pending.js"
import { ToolNames } from "../tools/names.js"
import { ToolResult } from "../tools/result.js"

export const HANDOVER_MS = 10_000
export const IDLE_MS = 5 * 60_000
// OWN-PATCH(P-044) begin
// The idle exit once half the pool's slots are in use.
export const SHORT_IDLE_MS = 2 * 60_000
// OWN-PATCH(P-044) end

export interface Request {
  // Only primary calls have one. Side calls run in a throwaway process.
  readonly sessionID?: string
  // Native OpenCode fork lineage, or the session supplying a compaction/generate snapshot.
  readonly sourceID?: string
  // OWN-PATCH(P-044) begin
  // The parent of a subagent's conversation: a start its parked parent waits for may go over the pool's cap.
  readonly parentID?: string
  // OWN-PATCH(P-044) end
  readonly model: string
  readonly effort?: Options["effort"]
  // OWN-PATCH(P-060) begin
  // Claude Code's Fast mode for this turn (its `fastMode` flag setting); Standard when unset.
  readonly fastMode?: boolean
  // OWN-PATCH(P-060) end
  readonly maxOutputTokens?: number
  readonly connection?: Readonly<Record<string, string>>
  readonly system: NonNullable<Options["systemPrompt"]>
  readonly prompt: LanguageModelV3Prompt
  readonly tools: readonly LanguageModelV3FunctionTool[]
  readonly emit: (message: SDKMessage) => void
}

interface LiveProcess {
  readonly session: ClaudeSession.Interface
  readonly pending: PendingTools.Interface
  model: string
  effort?: Options["effort"]
  // OWN-PATCH(P-060) begin
  fastMode?: boolean
  // OWN-PATCH(P-060) end
  // Settings that need a new process to change. Model and effort change on the running one.
  readonly launch: string
  // OWN-PATCH(P-039) begin
  readonly configDir?: string
  // OWN-PATCH(P-039) end
  waiting?: string[]
  // OWN-PATCH(P-044) begin
  // Set while the turn is parked on a tool that can wait for another conversation (CAG-43): `child` for a subagent.
  waits?: { readonly since: number; readonly child: boolean }
  // OWN-PATCH(P-044) end
}

interface ToolContinuation {
  readonly end: number
  readonly results: Array<{ id: string; result: ToolResult.Result }>
}

interface Entry {
  readonly lock: Semaphore.Semaphore
  process?: LiveProcess
  record?: SessionRecord.Record
  configDir?: string
  idle?: Fiber.Fiber<void, never>
  active?: Fiber.Fiber<unknown, unknown>
  // OWN-PATCH(P-043) begin
  // Conversations the record replaced, kept for an undo (saved as the record's `previous`).
  kept?: readonly SessionRecord.Epoch[]
  // The record was read from storage once; later requests keep what this entry holds.
  loaded?: boolean
  // Seals the record against its transcript once claude has written its last entries (after the process stops).
  reseal?: () => Effect.Effect<void>
  // OWN-PATCH(P-043) end
  // OWN-PATCH(P-044) begin
  readonly sessionID?: string
  readonly side: boolean
  parentID?: string
  // Requests in flight, counted before they take the lock: such an entry is never closed by the pool.
  runs: number
  // OpenCode stopped running the conversation while claude still waited for tool results that will not come.
  abandoned?: boolean
  idleSince?: number
  idleShort?: boolean
  // OWN-PATCH(P-044) end
}

export interface Interface {
  readonly run: (request: Request) => Effect.Effect<void, Error>
  // OpenCode stopped running the session, so a turn still waiting for tool results will not get them.
  readonly idle: (sessionID: string) => Effect.Effect<void>
  // OpenCode deleted the session, so nothing can resume it.
  readonly remove: (sessionID: string) => Effect.Effect<void>
  // OWN-PATCH(P-039) begin
  // Plan windows of the account folder `connection` names: a live process of that folder answers, else a short one.
  readonly usage: (connection: Readonly<Record<string, string>>) => Effect.Effect<SDKControlGetUsageResponse, Error>
  // OWN-PATCH(P-039) end
  // OWN-PATCH(P-043) begin
  // Removes the transcripts of an account folder that no record points to (once per folder and process).
  readonly sweep: (configDir: string) => Effect.Effect<void>
  // OWN-PATCH(P-043) end
}

const launch = (request: Request) =>
  JSON.stringify([request.maxOutputTokens, request.connection, request.system, request.tools])

// OWN-PATCH(P-045) begin
const folderOf = (request: Request, directory: string): ClaudeIO.Folder | undefined => {
  const configDir = request.connection?.CLAUDE_CONFIG_DIR
  return configDir ? { configDir, directory } : undefined
}
// OWN-PATCH(P-045) end

// OWN-PATCH(P-044) begin
// OpenCode's tools that can wait for another conversation (CAG-43), known by name when Claude calls them: a subagent
// (`task` in older agents) waits for its child conversation, a question for its answer. A permission prompt is asked
// inside the tool it guards, so no name tells it apart; the user answers it, never a conversation that needs a slot.
const CHILD_TOOLS = new Set(["subagent", "task"])
const REPLY_TOOLS = new Set(["question"])
// OWN-PATCH(P-044) end

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError })
const attemptSync = <A>(run: () => A) => Effect.try({ try: run, catch: toError })

export function registry() {
  const entries = new Map<string, Entry>()
  // Side calls share startup/draining with chat, but are tracked only until their request ends.
  const temporary = new Set<Entry>()
  let owners = 0
  let handover: Fiber.Fiber<void, never> | undefined
  // OWN-PATCH(P-043) begin
  const swept = new Set<string>()
  // OWN-PATCH(P-043) end

  const interrupt = Effect.fn("ClaudeSessions.interrupt")(function* (entry: Entry) {
    const process = entry.process
    if (!process) return
    yield* attempt(() => process.session.interrupt())
    process.pending.clear()
    process.waiting = undefined
    // OWN-PATCH(P-044) begin
    process.waits = undefined
    // OWN-PATCH(P-044) end
  }, Effect.uninterruptible)

  // OWN-PATCH(P-044) begin
  // Typed: the pool closes processes through it, and it hands their slots back to the pool.
  const stop: (entry: Entry) => Effect.Effect<void, Error> = Effect.fn("ClaudeSessions.stop")(function* (
    entry: Entry,
  ) {
    // OWN-PATCH(P-044) end
    const process = entry.process
    // OWN-PATCH(P-044) begin
    if (!process) return pool.release(entry)
    // OWN-PATCH(P-044) end
    yield* attempt(() => process.session.stop()).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.pending.clear()
          entry.process = undefined
          // OWN-PATCH(P-044) begin
          pool.release(entry)
          // OWN-PATCH(P-044) end
        }),
      ),
    )
  }, Effect.uninterruptible)

  // OWN-PATCH(P-043) begin
  // A process closed for good (idle exit, the pool, shutdown): claude has written its last entries, so own seals them.
  const retire = (entry: Entry) =>
    stop(entry).pipe(Effect.andThen(Effect.suspend(() => entry.reseal?.() ?? Effect.void)))
  // OWN-PATCH(P-043) end

  // OWN-PATCH(P-044) begin
  const busy = (entry: Entry) =>
    entry.runs > 0 || (!entry.abandoned && (!!entry.process?.waiting || !!entry.process?.session.running))
  // Parked, with no request of its own in flight, on a tool that can wait for another conversation (CAG-43).
  const stuck = (entry: Entry) =>
    entry.runs === 0 && !entry.abandoned && entry.process?.waiting ? entry.process.waits : undefined
  // OWN-PATCH(P-052) begin
  // SSH hosts' claude processes on this PC (02 §8.10.13): members of this pool like local ones, their state read from
  // their relayed streams.
  const hosted = new Map<Entry, ClaudeRelay.Watched>()
  const parentOf = (entry: Entry) => {
    if (!entry.parentID) return undefined
    return entries.get(entry.parentID) ?? [...hosted.keys()].find((other) => other.sessionID === entry.parentID)
  }
  const stuckOf = (entry: Entry) => {
    const watched = hosted.get(entry)
    return watched ? watched.stuck() : stuck(entry)
  }
  // OWN-PATCH(P-052) end
  const pool = ClaudePool.make<Entry>({
    cap: () => ClaudeObserver.settings().processes ?? ClaudePool.DEFAULT_CAP,
    // OWN-PATCH(P-052) begin
    busy: (entry) => hosted.get(entry)?.busy() ?? busy(entry),
    stuck: (entry) => stuckOf(entry)?.since,
    parentWaits: (entry) => {
      const parent = parentOf(entry)
      return !!parent && !!stuckOf(parent)?.child
    },
    // OWN-PATCH(P-052) end
    evict: (entry) =>
      Effect.gen(function* () {
        // OWN-PATCH(P-052) begin
        const watched = hosted.get(entry)
        if (watched) return yield* Effect.promise(() => watched.close())
        // OWN-PATCH(P-052) end
        if (spares.has(entry)) return yield* discard(entry)
        if (entry.idle) yield* Fiber.interrupt(entry.idle)
        entry.idle = undefined
        yield* entry.lock.withPermit(retire(entry))
      }).pipe(Effect.catch((error) => Effect.logWarning(error))),
    report: (status, queued) => ClaudeObserver.emit({ sessionID: queued?.sessionID, pool: status }),
    spare: (entry) => spares.has(entry),
  })

  // Spare processes for new conversations (02 §8.10.12, off by default): prewarmed with the host-level options of the
  // latest new conversation of an account folder, claimed by the next new conversation with the same options. Each
  // holds a slot of the pool and is the first one closed.
  interface Spare {
    readonly key: string
    readonly configDir?: string
    readonly pending: PendingTools.Interface
    process?: SpareProcess
  }
  const spares = new Map<Entry, Spare>()
  const discard = (entry: Entry) =>
    Effect.sync(() => {
      const spare = spares.get(entry)
      spares.delete(entry)
      spare?.process?.close()
      pool.release(entry)
    })
  const claim = (key: string) => {
    const found = [...spares.entries()].find(([, spare]) => spare.key === key && spare.process)
    if (!found) return undefined
    spares.delete(found[0])
    return { entry: found[0], spare: found[1] }
  }

  // New settings apply at once (CAG-36): spares beyond the setting close, then the pool checks its cap again.
  const recheck = () => {
    const wanted = ClaudeObserver.settings().spares ?? 0
    const held = new Map<string, number>()
    for (const [entry, spare] of [...spares]) {
      held.set(spare.key, (held.get(spare.key) ?? 0) + 1)
      if (held.get(spare.key)! > wanted) Effect.runSync(discard(entry))
    }
    pool.recheck()
  }

  // A short claude that is no conversation's (the login check, an idle account's usage read; CAG-38): it counts against
  // the cap while it runs, never waits for a slot and is never closed by the pool.
  const side = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync((): Entry => ({ lock: Semaphore.makeUnsafe(1), side: true, runs: 0 })).pipe(
        Effect.tap((entry) => pool.acquire(entry)),
      ),
      () => effect,
      (entry) => Effect.sync(() => pool.release(entry)),
    )

  // The conversations whose processes on an account folder are busy (CAG-37). With `close` the folder's spares and idle
  // processes close first, so the folder can move to the other route.
  const busyOn = Effect.fn("ClaudeSessions.busyOn")(function* (configDir: string, close: boolean) {
    // Side calls' processes on the folder too (CAG-46): they have no conversation, so they are named `side`.
    const mine = [...entries.values(), ...temporary].filter((entry) => entry.process?.configDir === configDir)
    if (close) {
      for (const [entry, spare] of [...spares]) if (spare.configDir === configDir) yield* discard(entry)
      for (const entry of mine.filter((entry) => !busy(entry))) {
        if (entry.idle) yield* Fiber.interrupt(entry.idle)
        entry.idle = undefined
        yield* entry.lock.withPermit(retire(entry)).pipe(Effect.catch((error) => Effect.logWarning(error)))
      }
    }
    return mine.filter(busy).map((entry) => entry.sessionID ?? "side")
  })

  // Once half the slots are in use, processes already idle exit after the shorter time, counted from when they idled.
  const shorten = Effect.fn("ClaudeSessions.shorten")(function* () {
    if (pool.live() < pool.cap() / 2) return
    for (const entry of entries.values()) {
      if (!entry.idle || entry.idleShort || entry.idleSince === undefined) continue
      yield* armIdle(entry, Math.max(0, SHORT_IDLE_MS - (Date.now() - entry.idleSince)), entry.idleSince)
    }
  })
  // OWN-PATCH(P-044) end

  const armIdle = Effect.fn("ClaudeSessions.armIdle")(function* (
    entry: Entry,
    // OWN-PATCH(P-044) begin
    duration?: number,
    since = Date.now(),
    // OWN-PATCH(P-044) end
  ) {
    if (entry.idle) yield* Fiber.interrupt(entry.idle)
    // OWN-PATCH(P-044) begin
    const short = pool.live() >= pool.cap() / 2
    entry.idleSince = since
    entry.idleShort = duration !== undefined || short
    entry.idle = yield* Effect.sleep(duration ?? (short ? SHORT_IDLE_MS : IDLE_MS)).pipe(
      Effect.andThen(entry.lock.withPermit(retire(entry))),
      // OWN-PATCH(P-044) end
      Effect.catch((error) => Effect.logWarning(error)),
      Effect.forkDetach,
    )
  })

  const closeEntry = Effect.fn("ClaudeSessions.closeEntry")(function* (
    entry: Entry,
    // OWN-PATCH(P-043) begin
    // Shutdown retires a process (its transcript is sealed); a deleted conversation's process only stops.
    end: (entry: Entry) => Effect.Effect<void, Error> = stop,
    // OWN-PATCH(P-043) end
  ) {
    if (entry.active) yield* Fiber.interrupt(entry.active)
    // The active turn's finalizer can install a new idle timer.
    if (entry.idle) yield* Fiber.interrupt(entry.idle)
    // OWN-PATCH(P-043) begin
    yield* entry.lock.withPermit(end(entry)).pipe(Effect.catch((error) => Effect.logWarning(error)))
    // OWN-PATCH(P-043) end
  })

  const closeEntries = Effect.fn("ClaudeSessions.closeEntries")(function* () {
    // OWN-PATCH(P-044) begin
    for (const entry of [...spares.keys()]) yield* discard(entry)
    // OWN-PATCH(P-044) end
    // OWN-PATCH(P-043) begin
    for (const entry of [...entries.values(), ...temporary]) yield* closeEntry(entry, retire)
    // OWN-PATCH(P-043) end
    entries.clear()
  })

  const cancelHandover = Effect.fn("ClaudeSessions.cancelHandover")(function* () {
    if (!handover) return
    yield* Fiber.interrupt(handover)
    handover = undefined
  })

  const close = Effect.fn("ClaudeSessions.close")(function* () {
    yield* cancelHandover()
    yield* closeEntries()
  })

  const attach = Effect.fn("ClaudeSessions.attach")(function* (input: {
    readonly io: ClaudeIO.Interface
    readonly status: ClaudeStatus.Interface
    readonly storage: SessionRecord.Storage
    readonly directory: string
  }) {
    const records = SessionRecord.make(input.storage)
    // OWN-PATCH(P-045) begin
    // own's account folders share one transcript store (FolderStore, and P-043's transcripts), so a conversation keeps
    // one record whatever folder runs it and resumes there after a move to another account. Upstream keeps one per folder.
    const recordFolder = (request: Request) =>
      input.io.requiresFolder || input.io.transcripts ? undefined : request.connection?.CLAUDE_CONFIG_DIR
    // OWN-PATCH(P-045) end
    owners++
    // OWN-PATCH(P-044) begin
    const unwatch = ClaudeObserver.watch(recheck)
    // OWN-PATCH(P-044) end
    yield* cancelHandover()
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        owners--
        if (owners !== 0) return
        // OWN-PATCH(P-044) begin
        unwatch()
        // OWN-PATCH(P-044) end
        if (entries.size === 0 && temporary.size === 0) return
        handover = yield* Effect.sleep(HANDOVER_MS).pipe(Effect.andThen(closeEntries()), Effect.forkDetach)
      }),
    )
    // OWN-PATCH(P-043) begin
    const transcripts = input.io.transcripts
    const native = transcripts
      ? ClaudeTranscripts.make({
          io: input.io,
          transcripts,
          directory: input.directory,
          version: () =>
            SubscriptionRef.get(input.status.state).pipe(
              Effect.map((state) =>
                state.type === "ready" ? (state.probe.version ?? ClaudeTranscripts.VERSION) : ClaudeTranscripts.VERSION,
              ),
            ),
        })
      : undefined
    // OWN-PATCH(P-043) end

    // OWN-PATCH(P-044) begin
    const spareKey = (request: Request) => JSON.stringify([request.connection?.CLAUDE_CONFIG_DIR, launch(request)])

    // After a new conversation starts: keep the folder's spares at the setting, with this conversation's options.
    const warm = Effect.fn("ClaudeSessions.warm")(function* (request: Request) {
      const prewarm = input.io.prewarm
      const executable = input.io.which()
      const wanted = ClaudeObserver.settings().spares ?? 0
      const key = spareKey(request)
      const configDir = request.connection?.CLAUDE_CONFIG_DIR
      // Spares of this folder for other options will never be claimed.
      for (const [entry, spare] of spares)
        if (spare.configDir === configDir && spare.key !== key) yield* discard(entry)
      if (!prewarm || !executable || wanted <= 0) return
      const have = [...spares.values()].filter((spare) => spare.key === key).length
      for (let count = have; count < wanted; count++) {
        const entry: Entry = { lock: Semaphore.makeUnsafe(1), side: false, runs: 0 }
        if (!pool.take(entry)) return
        const spare: Spare = { key, configDir, pending: PendingTools.make() }
        spares.set(entry, spare)
        const options = yield* attempt(() =>
          ClaudeQueryOptions.session({
            executable,
            io: input.io,
            connection: request.connection,
            directory: input.directory,
            model: request.model,
            maxOutputTokens: request.maxOutputTokens,
            system: request.system,
            tools: request.tools,
            pending: spare.pending,
            persist: true,
          }),
        ).pipe(Effect.option)
        if (options._tag === "None") return yield* discard(entry)
        // The session's own half (its folder, id and model) comes with the claim.
        const { cwd: _cwd, sessionId: _id, model: _model, ...host } = options.value
        void prewarm(host).then(
          (process) => {
            if (!spares.has(entry)) return process.close()
            spare.process = process
            void process.exited.then(() => {
              if (spares.get(entry) === spare) Effect.runFork(discard(entry))
            })
          },
          () => Effect.runFork(discard(entry)),
        )
      }
    })
    // OWN-PATCH(P-044) end

    const open = Effect.fn("ClaudeSessions.open")(function* (
      entry: Entry,
      request: Request,
      // OWN-PATCH(P-044) begin
      spareAllowed = true,
      // OWN-PATCH(P-044) end
    ): Effect.fn.Return<LiveProcess, Error> {
      const starting = !entry.process
      // OWN-PATCH(P-044) begin
      // A new conversation (nothing to resume) may take a spare prewarmed with its options; a refused claim falls back.
      const claimed =
        spareAllowed && starting && request.sessionID && !entry.record ? claim(spareKey(request)) : undefined
      if (claimed) pool.transfer(claimed.entry, entry)
      // OWN-PATCH(P-044) end
      // A cancel can only land while waiting for ready, so a started process is always recorded and stopped.
      const opened = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!entry.process) {
            // OWN-PATCH(P-044) begin
            // A slot of the pool first: waiting for one can be cancelled, a granted one goes back if claude fails.
            if (!claimed) yield* restore(pool.acquire(entry))
            const free = Effect.sync(() => pool.release(entry))
            // OWN-PATCH(P-044) end
            const executable = input.io.which()
            if (!executable) {
              // OWN-PATCH(P-044) begin
              yield* free
              // OWN-PATCH(P-044) end
              yield* input.status.report({ type: "missing" })
              return yield* Effect.fail(new Error("Install Claude Code and run `claude auth login` first"))
            }
            // OWN-PATCH(P-044) begin
            const pending = claimed?.spare.pending ?? PendingTools.make()
            // OWN-PATCH(P-044) end
            // OWN-PATCH(P-052) begin
            // On an SSH host the PC's pool grants the process a slot first (that wait can be cancelled too).
            const admit = input.io.admit
            const admitted = admit
              ? yield* restore(
                  Effect.tryPromise({
                    try: (signal) =>
                      admit(
                        { sessionID: request.sessionID, parentID: entry.parentID, side: entry.side },
                        { configDir: request.connection?.CLAUDE_CONFIG_DIR ?? "", directory: input.directory },
                        signal,
                      ),
                    catch: toError,
                  }),
                ).pipe(Effect.onError(() => free))
              : undefined
            const io = admitted ? { ...input.io, spawn: admitted.spawn } : input.io
            // OWN-PATCH(P-052) end
            const session = yield* attempt(async () =>
              ClaudeSession.start(
                await ClaudeQueryOptions.session({
                  executable,
                  // OWN-PATCH(P-052) begin
                  io,
                  // OWN-PATCH(P-052) end
                  connection: request.connection,
                  directory: input.directory,
                  model: request.model,
                  effort: request.effort,
                  maxOutputTokens: request.maxOutputTokens,
                  system: request.system,
                  tools: request.tools,
                  pending,
                  persist: request.sessionID !== undefined,
                  resume: entry.record?.claudeSessionID,
                }),
                // OWN-PATCH(P-044) begin
                claimed?.spare.process,
                // OWN-PATCH(P-051) begin
                input.io.version,
                // OWN-PATCH(P-051) end
              ),
              // OWN-PATCH(P-052) begin
            ).pipe(Effect.onError(() => Effect.andThen(Effect.sync(() => admitted?.release()), free)))
            // OWN-PATCH(P-052) end
            // OWN-PATCH(P-044) end
            entry.process = {
              session,
              pending,
              model: request.model,
              effort: request.effort,
              launch: launch(request),
              // OWN-PATCH(P-039) begin
              configDir: request.connection?.CLAUDE_CONFIG_DIR,
              // OWN-PATCH(P-039) end
            }
          }
          const process = entry.process
          const probe = yield* restore(
            attempt(() => process.session.ready).pipe(
              Effect.timeoutOrElse({
                duration: "60 seconds",
                orElse: () => Effect.fail(new Error("claude did not start within 60 seconds")),
              }),
            ),
          ).pipe(Effect.onError(() => stop(entry).pipe(Effect.ignore)))
          return { process, probe }
        }),
        // OWN-PATCH(P-044) begin
      ).pipe(
        Effect.catch((error) =>
          claimed
            ? Effect.logWarning("Claude Agent could not use a spare process", { error }).pipe(
                Effect.andThen(open(entry, request, false)),
                Effect.map((process) => ({ process, probe: undefined })),
              )
            : Effect.fail(error),
        ),
      )
      if (!opened.probe) return opened.process
      // OWN-PATCH(P-044) end
      const process = opened.process
      // A new process reports its version, login and models, which keeps the model list current without a separate check.
      if (starting) {
        const configDir = request.connection?.CLAUDE_CONFIG_DIR
        yield* input.status.report({ type: "ready", probe: opened.probe, configDir, fromChat: true })
        // OWN-PATCH(P-039) begin
        ClaudeObserver.emit({
          configDir,
          sessionID: request.sessionID,
          account: ClaudeObserver.plan(opened.probe.account),
        })
        // OWN-PATCH(P-039) end
        // Fail before sending the prompt, because Claude Code's own error does not say which folder needs a login.
        if (!ClaudeProbe.isLoggedIn(opened.probe.account)) {
          yield* stop(entry)
          return yield* Effect.fail(new Error(ClaudeProbe.loginMessage(configDir)))
        }
      }
      // OWN-PATCH(P-044) begin
      if (starting) yield* shorten()
      if (starting && request.sessionID && !entry.record) yield* warm(request)
      // OWN-PATCH(P-044) end
      // Apply controls before sending input or releasing parked tool results.
      if (process.model !== request.model) {
        yield* attempt(() => process.session.setModel(request.model))
        process.model = request.model
      }
      if (process.effort !== request.effort) {
        yield* attempt(() => process.session.setEffort(request.effort))
        process.effort = request.effort
      }
      // OWN-PATCH(P-060) begin
      // A process starts in Standard (an SDK host must opt in, `sdk_opt_in_required`), so only Fast is ever applied.
      if ((process.fastMode ?? false) !== (request.fastMode ?? false)) {
        yield* attempt(() => process.session.setFastMode(request.fastMode ?? false))
        process.fastMode = request.fastMode ?? false
      }
      // OWN-PATCH(P-060) end
      return process
    })

    const turn = Effect.fn("ClaudeSessions.turn")(function* (
      entry: Entry,
      request: Request,
      start: number,
      continuation?: ToolContinuation,
    ) {
      // Validate before opening a process: a rejected rebuild must not pair an empty process with the old record.
      const content = yield* attemptSync(() => {
        if (request.sessionID || entry.record) return CatchUp.content(request.prompt, continuation?.end ?? start)
        return ConvertToClaudeMessage.content(request.prompt)
        // OWN-PATCH(P-043) begin
        // Resumed history that ends with tool results and nothing new asked still needs input to start the turn.
      }).pipe(
        Effect.map((blocks) =>
          native && !continuation && entry.record && blocks.length === 0
            ? [{ type: "text" as const, text: NativeTranscript.CONTINUE }]
            : blocks,
        ),
      )
      // OWN-PATCH(P-043) end
      const live = yield* open(entry, request)
      const session = live.session

      const addsUserMessage = !continuation || content.length > 0
      const userID = addsUserMessage ? crypto.randomUUID() : undefined

      const reply: Array<LanguageModelV3TextPart | LanguageModelV3ToolCallPart> = []
      const toolMessages = new Map<string, string>()
      const seen = new Set<string>()
      let messageID: string | undefined
      const waiting: string[] = []
      // OWN-PATCH(P-044) begin
      const waitingNames: string[] = []
      // OWN-PATCH(P-044) end

      const emit = (message: SDKMessage) => {
        // OWN-PATCH(P-039) begin
        if (message.type === "rate_limit_event")
          ClaudeObserver.emit({
            configDir: request.connection?.CLAUDE_CONFIG_DIR,
            sessionID: request.sessionID,
            rateLimit: message.rate_limit_info,
          })
        // OWN-PATCH(P-039) end
        // OWN-PATCH(P-053) begin
        if (message.type === "result" && message.modelUsage)
          ClaudeObserver.emit({
            configDir: request.connection?.CLAUDE_CONFIG_DIR,
            sessionID: request.sessionID,
            windows: {
              model: request.model,
              usage: Object.entries(message.modelUsage)
                .filter((entry) => Number.isSafeInteger(entry[1].contextWindow) && entry[1].contextWindow > 0)
                .map((entry) => ({
                  key: entry[0],
                  ...(entry[1].canonicalModel ? { canonical: entry[1].canonicalModel } : {}),
                  contextWindow: entry[1].contextWindow,
                })),
            },
          })
        // OWN-PATCH(P-053) end
        // OWN-PATCH(P-060) begin
        if (message.type === "result" && (request.fastMode || message.fast_mode_state === "on"))
          ClaudeObserver.emit({
            configDir: request.connection?.CLAUDE_CONFIG_DIR,
            sessionID: request.sessionID,
            fast: {
              model: request.model,
              requested: request.fastMode ?? false,
              ...(message.fast_mode_state === undefined ? {} : { state: message.fast_mode_state }),
              ...(message.fast_mode_disabled_reason === undefined ? {} : { reason: message.fast_mode_disabled_reason }),
            },
          })
        // OWN-PATCH(P-060) end
        if (message.type === "system" && message.subtype === "init" && request.tools.length > 0) {
          const connected = message.mcp_servers.some(
            (server) => server.name === "opencode" && server.status === "connected",
          )
          if (!connected) throw new Error("The OpenCode tool server did not connect to Claude Code")
        }
        if (
          message.type === "assistant" &&
          message.parent_tool_use_id === null &&
          !message.error &&
          !seen.has(message.uuid)
        ) {
          seen.add(message.uuid)
          messageID = message.uuid
          for (const part of message.message.content) {
            if (part.type === "text") {
              reply.push({ type: "text", text: part.text })
              continue
            }
            if (part.type !== "tool_use") continue
            const name = ToolNames.original(part.name, request.tools)
            if (!name && part.name.startsWith(ToolNames.PREFIX)) {
              // A tool removed after this process started is still on its tool server; answer here so the turn goes on.
              live.pending.expect(part.id, part.name)
              live.pending.resolve(part.id, {
                mcp: { isError: true, content: [{ type: "text", text: "This tool is no longer available." }] },
                replacement: undefined,
              })
            }
            if (!name) continue
            live.pending.expect(part.id, part.name)
            waiting.push(part.id)
            // OWN-PATCH(P-044) begin
            waitingNames.push(name)
            // OWN-PATCH(P-044) end
            reply.push({ type: "tool-call", toolCallId: part.id, toolName: name, input: part.input })
          }
        }
        if (message.type === "user" && message.uuid && Array.isArray(message.message.content)) {
          for (const part of message.message.content) {
            if (part.type === "tool_result") toolMessages.set(part.tool_use_id, message.uuid)
          }
        }
        request.emit(message)
      }

      let completed = false
      let interrupted = false
      let started = false
      let parked = false
      const step = Effect.gen(function* () {
        if (!continuation) session.begin(content, userID)
        if (continuation) {
          if (userID !== undefined) session.addUser(content, userID)
          for (const item of continuation.results) {
            live.pending.resolve(item.id, item.result)
          }
        }
        started = true
        const outcome = yield* attempt(() => session.readStep(emit, request.tools))
        parked = outcome === "tools"
        completed = true
        live.waiting = parked ? waiting : undefined
        // OWN-PATCH(P-044) begin
        const child = waitingNames.some((name) => CHILD_TOOLS.has(name))
        live.waits =
          parked && (child || waitingNames.some((name) => REPLY_TOOLS.has(name)))
            ? { since: Date.now(), child }
            : undefined
        // OWN-PATCH(P-044) end
      })

      // A tool boundary ends only the OpenCode step; the Claude turn waits for the results. Anything else interrupts and drains it.
      const interruptUnlessParked = Effect.gen(function* () {
        if (parked) return
        yield* interrupt(entry).pipe(Effect.orDie)
      })

      const saveRecord = Effect.gen(function* () {
        if (!request.sessionID || !session.persisted || !started) return
        const history =
          completed || interrupted
            ? Checkpoints.build({
                prompt: request.prompt,
                previous: entry.record,
                userID,
                reply: completed ? reply : [],
                messageID: completed ? messageID : undefined,
                toolMessages,
              })
            : undefined
        // OWN-PATCH(P-043) begin
        // The seal and version stay with their conversation; the kept ones stay with the OpenCode session.
        const same = entry.record?.claudeSessionID === session.id
        entry.record = {
          ...(same && entry.record?.seal ? { seal: entry.record.seal } : {}),
          ...(same && entry.record?.version ? { version: entry.record.version } : {}),
          claudeSessionID: session.id,
          history,
          interrupted: interrupted && !completed,
          ...(entry.kept?.length ? { previous: entry.kept } : {}),
        }
        // OWN-PATCH(P-043) end
        // OWN-PATCH(P-045) begin
        yield* records.set(request.sessionID, entry.record, recordFolder(request))
        // OWN-PATCH(P-045) end
      })

      yield* step.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
        Effect.ensuring(interruptUnlessParked),
        Effect.ensuring(saveRecord),
      )
    })

    const release = Effect.fn("ClaudeSessions.release")(function* (entry: Entry, request: Request) {
      entry.active = undefined
      // OWN-PATCH(P-044) begin
      pool.touch(entry)
      pool.changed()
      // OWN-PATCH(P-044) end
      if (!request.sessionID) {
        yield* stop(entry).pipe(Effect.catch((error) => Effect.logWarning(error)))
        const sessionID = entry.record?.claudeSessionID
        if (sessionID)
          // OWN-PATCH(P-045) begin
          yield* attempt(() => input.io.remove(sessionID, folderOf(request, input.directory))).pipe(
            Effect.catch((error) => Effect.logWarning(error)),
          )
        // OWN-PATCH(P-045) end
        temporary.delete(entry)
        return
      }
      // A turn waiting for tool results is still busy. Subagents, permission prompts and questions can take longer
      // than IDLE_MS, so idle() starts the timer once OpenCode stops running the session.
      if (entry.process?.waiting) return
      yield* armIdle(entry)
    })

    const branch = Effect.fn("ClaudeSessions.branch")(function* (
      entry: Entry,
      request: Request,
      source?: SessionRecord.Record,
    ) {
      const boundary = SyncDecision.boundary(request.prompt, source)
      if (!source || !boundary) return 0
      // Validate catch-up input before creating a forked transcript on disk.
      yield* attemptSync(() => CatchUp.content(request.prompt, boundary.start))
      // OWN-PATCH(P-045) begin
      const fork = yield* attempt(() =>
        input.io.fork(source.claudeSessionID, boundary.messageID, folderOf(request, input.directory)),
      )
      // OWN-PATCH(P-045) end
      if (!fork) return 0
      const history = boundary.history.map((checkpoint) => ({
        hash: checkpoint.hash,
        claudeMessageID: checkpoint.claudeMessageID ? fork.messages.get(checkpoint.claudeMessageID) : undefined,
      }))
      entry.record = { claudeSessionID: fork.sessionID, history }
      return boundary.start
    }, Effect.uninterruptible)

    const snapshot = Effect.fn("ClaudeSessions.snapshot")(function* (entry: Entry, request: Request) {
      const sourceID = request.sourceID
      if (!sourceID) return 0
      const source = entries.get(sourceID)
      const copy = Effect.gen(function* () {
        // OWN-PATCH(P-045) begin
        const configDir = recordFolder(request)
        // OWN-PATCH(P-045) end
        const record =
          source?.record && source.configDir === configDir ? source.record : yield* records.get(sourceID, configDir)
        // OWN-PATCH(P-043) begin
        // A copy of the source's transcript up to its last safe point with the rest written on, or a new one from the
        // history alone; the source's own transcript is never written.
        const folder = folderOf(request, input.directory)
        if (native && folder) {
          const made = yield* native.materialize({
            conversation: request.sessionID,
            record,
            owned: false,
            decision: { kind: "changed", start: 0 },
            prompt: request.prompt,
            tools: request.tools,
            folder,
          })
          entry.record = made.record
          return made.record ? made.start : 0
        }
        // OWN-PATCH(P-043) end
        return yield* branch(entry, request, record)
      })
      // Hold the source only while copying its settled prefix, never during side-call inference.
      if (!source) return yield* copy
      return yield* source.lock.withPermit(copy)
    })

    // OWN-PATCH(P-043) begin
    // The history claude has not seen goes into its transcript (02 §8.10.11): the turn then resumes it and sends only the
    // new input. A turn parked on tool results takes them, and a live process with nothing new to see goes on, as upstream.
    const prepareNative = Effect.fn("ClaudeSessions.prepareNative")(function* (
      entry: Entry,
      request: Request,
      sessionID: string,
      folder: ClaudeIO.Folder,
      materializer: NonNullable<typeof native>,
    ) {
      if (!entry.loaded) {
        entry.loaded = true
        entry.kept = entry.record?.previous ?? []
      }
      entry.reseal = () =>
        Effect.gen(function* () {
          const record = entry.record
          if (!record) return
          const next = yield* materializer.reseal(record, folder)
          if (!next || (next.seal?.last === record.seal?.last && next.seal?.digest === record.seal?.digest)) return
          entry.record = next
          yield* records.set(sessionID, { ...next, ...(entry.kept?.length ? { previous: entry.kept } : {}) })
        }).pipe(Effect.catch((error) => Effect.logWarning(error)))

      const current = entry.record ? { ...entry.record, previous: entry.kept } : undefined
      const picked = ClaudeTranscripts.pick(request.prompt, current)
      if (current && picked.index >= 0) {
        // A kept conversation the history continues (an undo of a reset): it becomes current again.
        yield* stop(entry)
        const swapped = ClaudeTranscripts.swap(current, picked.index)
        entry.kept = swapped.previous ?? []
        entry.record = swapped
      }
      const decision = picked.decision
      const live = entry.process
      if (live && live.session.running && live.waiting && !live.session.ended) {
        const collected = yield* attemptSync(() => ToolResult.collect(request.prompt, decision.start))
        const results = live.waiting.map((id) => ({ id, result: collected.results.get(id) }))
        const ready = results.flatMap((item) => (item.result ? [{ id: item.id, result: item.result }] : []))
        if (!collected.aborted && decision.kind === "catch-up" && ready.length === results.length)
          return { start: decision.start, continuation: { end: collected.end, results: ready } }
      }
      if (live && !live.session.ended && !live.waiting && decision.kind === "continue")
        return { start: decision.start, continuation: undefined }
      yield* stop(entry)
      if (!entry.record && request.sourceID) return { start: yield* snapshot(entry, request), continuation: undefined }
      const made = yield* materializer.materialize({
        conversation: sessionID,
        record: entry.record,
        owned: true,
        decision,
        prompt: request.prompt,
        tools: request.tools,
        folder,
      })
      const listed = ClaudeTranscripts.keep(entry.kept ?? [], made.replaced, made.record?.claudeSessionID)
      entry.kept = listed.kept
      entry.record = made.record
      // What fell off the kept list and a transcript that changed under its record go now.
      for (const id of [...made.discard, ...listed.dropped.map((epoch) => epoch.claudeSessionID)])
        yield* attempt(() => input.io.remove(id, folder)).pipe(Effect.catch((error) => Effect.logWarning(error)))
      if (made.record)
        yield* records.set(sessionID, { ...made.record, ...(listed.kept.length ? { previous: listed.kept } : {}) })
      return { start: made.start, continuation: undefined }
    })
    // OWN-PATCH(P-043) end

    const prepare = Effect.fn("ClaudeSessions.prepare")(function* (entry: Entry, request: Request) {
      // Retire an exited or incompatible process first: once we continue its parked turn, open() must not replace it.
      // A launch change waits for a parked turn to end: stopping it makes Claude Code record the waiting tool calls as
      // refused by the user. A step without tools (the step limit) still stops it, since the old process offers them.
      if (entry.process) {
        const parked = entry.process.waiting && entry.process.session.running && request.tools.length > 0
        const needsRestart = entry.process.session.ended || (entry.process.launch !== launch(request) && !parked)
        if (needsRestart) yield* stop(entry)
      }

      if (!request.sessionID) {
        const start = yield* snapshot(entry, request)
        return { start, continuation: undefined }
      }

      // OWN-PATCH(P-045) begin
      const configDir = recordFolder(request)
      // OWN-PATCH(P-045) end
      if (entry.configDir !== configDir) entry.record = undefined
      entry.configDir = configDir
      if (!entry.record) entry.record = yield* records.get(request.sessionID, configDir)
      // OWN-PATCH(P-043) begin
      const folder = folderOf(request, input.directory)
      if (native && folder) return yield* prepareNative(entry, request, request.sessionID, folder, native)
      // OWN-PATCH(P-043) end
      const decision = SyncDecision.decide(request.prompt, entry.record)
      const start = yield* Effect.gen(function* () {
        if (decision.kind === "fresh" || decision.kind === "changed") {
          yield* stop(entry)
          const previous = entry.record
          entry.record = undefined
          if (decision.kind === "changed") return yield* branch(entry, request, previous)
          if (!previous) return yield* snapshot(entry, request)
          return decision.start
        }
        if (entry.process || !entry.record) return decision.start
        const sessionID = entry.record.claudeSessionID
        // OWN-PATCH(P-045) begin
        const exists = yield* attempt(() => input.io.sessionExists(sessionID, folderOf(request, input.directory)))
        // OWN-PATCH(P-045) end
        if (exists) return decision.start
        entry.record = undefined
        return 0
      })

      const live = entry.process
      if (!live || !live.session.running || !live.waiting) return { start, continuation: undefined }
      const collected = yield* attemptSync(() => ToolResult.collect(request.prompt, start))
      const continuation: ToolContinuation = { end: collected.end, results: [] }
      for (const id of live.waiting) {
        const result = collected.results.get(id)
        if (!result) {
          yield* stop(entry)
          entry.record = undefined
          return { start: 0, continuation: undefined }
        }
        continuation.results.push({ id, result })
      }
      if (collected.aborted) {
        // A stopped OpenCode turn needs a fresh Claude turn; addUser would only steer the old one.
        // After a launch change it also needs a new process.
        yield* live.launch === launch(request) ? interrupt(entry) : stop(entry)
        return { start, continuation: undefined }
      }
      return { start, continuation }
    })

    const entryFor = (request: Request) => {
      if (request.sessionID) {
        const existing = entries.get(request.sessionID)
        if (existing) return existing
        // OWN-PATCH(P-044) begin
        const entry: Entry = { lock: Semaphore.makeUnsafe(1), sessionID: request.sessionID, side: false, runs: 0 }
        // OWN-PATCH(P-044) end
        entries.set(request.sessionID, entry)
        return entry
      }
      // OWN-PATCH(P-044) begin
      const entry: Entry = { lock: Semaphore.makeUnsafe(1), side: true, runs: 0 }
      // OWN-PATCH(P-044) end
      temporary.add(entry)
      return entry
    }

    const run = Effect.fn("ClaudeSessions.run")(function* (asked: Request) {
      const connection = asked.connection && ClaudeQueryOptions.withoutDefaultFolder(asked.connection, input.io)
      const request = { ...asked, connection }
      const entry = entryFor(request)
      // OWN-PATCH(P-044) begin
      entry.runs++
      entry.abandoned = false
      if (request.parentID) entry.parentID = request.parentID
      // OWN-PATCH(P-044) end
      yield* entry.lock
        .withPermit(
          Effect.gen(function* () {
            if (entry.idle) {
              yield* Fiber.interrupt(entry.idle)
              entry.idle = undefined
            }
            entry.active = yield* Effect.withFiber(Effect.succeed)
            const prepared = yield* prepare(entry, request)
            yield* turn(entry, request, prepared.start, prepared.continuation)
          }).pipe(Effect.ensuring(release(entry, request))),
        )
        // OWN-PATCH(P-044) begin
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.runs--
              pool.changed()
            }),
          ),
        )
      // OWN-PATCH(P-044) end
    })

    const idle = Effect.fn("ClaudeSessions.idle")(function* (sessionID: string) {
      const entry = entries.get(sessionID)
      // Other processes already have a timer, and a running request starts one when it ends.
      if (!entry?.process?.waiting || entry.active) return
      // OWN-PATCH(P-044) begin
      // Its tool results will not come: the pool may close it before its idle exit.
      entry.abandoned = true
      pool.changed()
      // OWN-PATCH(P-044) end
      yield* armIdle(entry)
    })

    const remove = Effect.fn("ClaudeSessions.remove")(function* (sessionID: string) {
      const entry = entries.get(sessionID)
      entries.delete(sessionID)
      if (entry) yield* closeEntry(entry)
      yield* records.remove(sessionID)
    })

    // OWN-PATCH(P-039) begin
    const usage = Effect.fn("ClaudeSessions.usage")(function* (connection: Readonly<Record<string, string>>) {
      const configDir = connection.CLAUDE_CONFIG_DIR
      const live = [...entries.values()]
        .map((entry) => entry.process)
        .find((process) => process && !process.session.ended && process.configDir === configDir)
      const executable = input.io.which()
      const ask = live
        ? () => live.session.usage()
        : executable
          ? () => ClaudeProbe.usage(ClaudeQueryOptions.base({ executable, io: input.io, connection }))
          : undefined
      if (!ask) return yield* Effect.fail(new Error("Claude Code is not installed"))
      // OWN-PATCH(P-044) begin
      // A short claude of its own counts against the cap while it runs (CAG-38).
      const answer = yield* live ? attempt(ask) : side(attempt(ask))
      // OWN-PATCH(P-044) end
      ClaudeObserver.emit({ configDir, usage: answer })
      return answer
    })
    // OWN-PATCH(P-039) end

    // OWN-PATCH(P-043) begin
    const sweep = Effect.fn("ClaudeSessions.sweep")(function* (configDir: string) {
      if (!native || swept.has(configDir)) return
      swept.add(configDir)
      const referenced = yield* records.referenced()
      for (const entry of [...entries.values(), ...temporary]) {
        if (entry.record) referenced.add(entry.record.claudeSessionID)
        for (const kept of entry.kept ?? []) referenced.add(kept.claudeSessionID)
      }
      // OWN-PATCH(P-052) begin
      // SSH hosts' transcripts belong to their hosts' records (each host sweeps its own through the relay).
      const root = ClaudeObserver.hostsRoot()
      const removed = yield* native
        .sweep(configDir, referenced, root ? FolderStore.projectKey(root) + "-" : undefined)
      // OWN-PATCH(P-052) end
        .pipe(Effect.catch((error) => Effect.logWarning(error).pipe(Effect.as<readonly string[]>([]))))
      if (removed.length > 0) yield* Effect.logInfo("Claude Agent removed transcripts no record points to", { removed })
    })

    return { run, idle, remove, usage, sweep } satisfies Interface
    // OWN-PATCH(P-043) end
  })

  // OWN-PATCH(P-052) begin
  // A slot of this pool for a host's process: waits like a local start (cancelled with `signal`), counts until released.
  const host = (member: ClaudeRelay.Member, watched: ClaudeRelay.Watched, signal?: AbortSignal) => {
    const entry: Entry = {
      lock: Semaphore.makeUnsafe(1),
      side: member.side,
      runs: 0,
      ...(member.sessionID === undefined ? {} : { sessionID: member.sessionID }),
      ...(member.parentID === undefined ? {} : { parentID: member.parentID }),
    }
    hosted.set(entry, watched)
    return Effect.runPromise(pool.acquire(entry), { signal }).then(
      (): ClaudeRelay.Slot => ({
        release: () => {
          hosted.delete(entry)
          pool.release(entry)
        },
        changed: () => {
          pool.touch(entry)
          pool.changed()
        },
      }),
      (error: unknown) => {
        hosted.delete(entry)
        throw error
      },
    )
  }
  // OWN-PATCH(P-052) end

  // OWN-PATCH(P-044) begin
  // OWN-PATCH(P-052) begin
  return { attach, close, side, busy: busyOn, host }
  // OWN-PATCH(P-052) end
  // OWN-PATCH(P-044) end
}
