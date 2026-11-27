export * as ImportWorker from "./worker.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnImport } from "@own/protocol/rpc-import"
import { Redact } from "@own/runtime"
import { SelfHttp } from "./http.js"
import { Scan } from "./index/scan.js"
import { Options } from "./options.js"
import { View } from "./render/view.js"
import type { ImportRpc } from "./rpc.js"
import { Search } from "./search.js"
import { ClaudeSource } from "./sources/claude.js"
import { CodexStore } from "./sources/codex.js"
import { Paths } from "./sources/paths.js"
import type { Transcript } from "./transcript/ir.js"

/**
 * The own.import Worker (09 §2.3, §2.8, IG5): the index (`Scan`), the viewer (`View`), the search and the full parse
 * of a conversation run on this one thread, so the service's event loop keeps streaming other conversations and
 * answering RPCs while another tool's store is scanned or a large rollout is decoded. The service thread (`rpc.ts`)
 * starts it on the first `sources.list` or `sessions.list` and forwards the {@link METHODS} to it, and asks it for
 * {@link SOURCE} (the parse a `migrate.plan` or a job reads); `health`, `migrate.*` and `jobs.list` answer there.
 *
 * - **Source runs** start this file (`worker.ts` next to `index.ts`); a desktop bundle carries its bundled source as
 *   the define `OWN_IMPORT_WORKER_SOURCE` and runs it from a Blob URL (`rpc.ts` `spawnWorker`).
 * - **Messages** ({@link Request} in, `ImportRpc.WorkerMessage` out): `hello` creates the {@link create}d service for
 *   OWN_HOME; `call` runs a method with the service thread's current plugin options and answers `{rid, ok, …}` (a
 *   declared error type of the method, never a throw); `cancel` aborts a running read or search; the Worker asks the
 *   service thread for `ctx.worktree.list` (`worktrees`, answered by `reply`) and reports `index.changed`; `close`
 *   flushes `import-index.json` before the service thread ends the Worker.
 * - **Privacy** (IG10, 09 §5.5): nothing here logs, and answers carry conversation content only to the service thread,
 *   which hands it to the RPC caller. What the viewer and the searches answer (`sessions.read`, `sessions.search`, the
 *   list's titles and first prompts) shows secrets as `[redacted:<label>]` (`Redact.named`), so a device given `read`
 *   never sees one; the full parse ({@link SOURCE}) stays unredacted for the plan and the stored shape, which redact
 *   it themselves. Errors name a declared type and a fixed message.
 */

/** The methods the Worker answers (09 §5.2 I1); the rest of own.import answers on the service thread. */
export const METHODS = [
  "sources.list",
  "sources.configure",
  "sessions.list",
  "sessions.read",
  "sessions.search",
] as const
export type Method = (typeof METHODS)[number]
/** Not an RPC method: the full parse `migrate.plan` and a job read through the service thread (09 §4). */
export const SOURCE = "source"
/** What the Worker answers: the RPC methods it serves and {@link SOURCE}. */
export type Call = Method | typeof SOURCE

/** How long the Worker waits for the service thread's `ctx.worktree.list` before going on without it. */
const ASK_MS = 10_000
/**
 * The Worker's own start (about 0.4 s from source, measured on this PC) comes out of the first list's 2 s budget, so
 * every list waits this much less for the scan before it answers `scanning: true` (09 §2.8, IG5).
 */
const START_MS = 500
/** How long the imported marks of `sessions.read` (the project sessions' `own.import` metadata) are reused. */
const MARKS_MS = 5_000

/** The service thread's current plugin options and channel, sent with every call (a changed config applies at once). */
export const Settings = Schema.Struct({ options: Options.Info, channel: Schema.String })
export type Settings = typeof Settings.Type

const Request = Schema.Union([
  Schema.Struct({ op: Schema.Literal("hello"), rid: Schema.Int, home: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("call"),
    rid: Schema.Int,
    method: Schema.Literals([...METHODS, SOURCE]),
    input: Schema.Unknown,
    settings: Settings,
  }),
  Schema.Struct({ op: Schema.Literal("cancel"), rid: Schema.Int }),
  Schema.Struct({ op: Schema.Literal("reply"), call: Schema.Int, folders: Schema.Array(Schema.String) }),
  Schema.Struct({ op: Schema.Literal("close"), rid: Schema.Int }),
])
/** What the service thread sends. */
export type Request = typeof Request.Type
const decodeRequest = Schema.decodeUnknownOption(Request)

/**
 * {@link SOURCE}'s input: the conversation and, for a plan, the folder whose project it must belong to (`scope: "all"`:
 * any conversation, `이 폴더로 가져오기`). A job's read names no folder: its plan checked it.
 */
const SourceInput = Schema.Struct({
  ref: OwnImport.SourceRef,
  directory: optional(Schema.String),
  scope: optional(OwnImport.Reach),
})

const INPUT = {
  "sources.configure": Schema.decodeUnknownOption(OwnImport.Definition.methods["sources.configure"].input),
  "sessions.list": Schema.decodeUnknownOption(OwnImport.Definition.methods["sessions.list"].input),
  "sessions.read": Schema.decodeUnknownOption(OwnImport.Definition.methods["sessions.read"].input),
  "sessions.search": Schema.decodeUnknownOption(OwnImport.Definition.methods["sessions.search"].input),
  [SOURCE]: Schema.decodeUnknownOption(SourceInput),
}

type Answer = ImportRpc.Answer
type ReadInput = (typeof OwnImport.Definition.methods)["sessions.read"]["input"]["Type"]
type SearchRequest = (typeof OwnImport.Definition.methods)["sessions.search"]["input"]["Type"]
type SourceInput = typeof SourceInput.Type
type SearchInput = Pick<Search.Input, "query" | "cursor" | "limit" | "signal">

export interface ServiceInput {
  /** OWN_HOME: `state/import-sources.json`, `state/import-index.json` and `tmp/` (the Codex state DB copy). */
  readonly home: string
  /** The folders core recorded for a project (`ctx.worktree.list({projectID})`, asked of the service thread). */
  readonly worktrees: (projectID: string) => Promise<ReadonlyArray<string>>
  /** `index.changed` for the listed folders whose lists changed (09 §5.3). */
  readonly emit: (directories: ReadonlyArray<string>) => void
  readonly now?: () => number
  /** Real paths for folder membership; tests inject a `subst` drive (09 §2.2, IG3). Default `Paths.realpath`. */
  readonly resolve?: Paths.Realpath
}

export type Service = ReturnType<typeof create>

/**
 * The methods over one index and one viewer. Runs in the Worker; tests and the perf run create it in-process to
 * observe the allowlist (`Paths.observe`) and the viewer's memory. Nothing is read before the first call.
 */
export function create(input: ServiceInput) {
  const now = input.now ?? Date.now
  const state = {
    settings: { options: {}, channel: "local" } as Settings,
    marks: undefined as { readonly at: number; readonly value: Promise<ReadonlyMap<string, Scan.Mark[]>> } | undefined,
    indexed: undefined as Promise<void> | undefined,
  }
  // The service of the latest settings: a source run's `service` option, else the channel's registration file.
  const http = SelfHttp.create({
    source: SelfHttp.following(() => ({
      service: state.settings.options.service,
      channel: state.settings.channel,
    })),
  })
  const file = Paths.sources(input.home)
  const roots = () => Paths.roots({ options: state.settings.options, file })
  const scan = Scan.create({
    home: input.home,
    roots,
    http,
    worktrees: input.worktrees,
    emit: input.emit,
    now,
    resolve: input.resolve,
    budgetMs: Scan.BUDGET_MS - START_MS,
  })
  const viewer = View.viewer()

  /** Builds the index once for the methods that need rows but do not list (a folder search). */
  const indexed = () => (state.indexed ??= scan.refresh())

  /** A conversation's row; one the index does not know yet (a new file, a restarted Worker) waits for a refresh. */
  const locate = async (ref: OwnImport.SourceRef) => {
    const known = scan.locate(ref)
    if (known !== undefined) return known
    await scan.refresh()
    return scan.locate(ref)
  }

  /**
   * `ref` as the caller may reach it (09 §5.5): one of the conversations of `directory`'s project, or with `scope:
   * "all"` any the index knows (this PC's windows only: the gateway refuses it from devices). One outside the project
   * is `source_not_found`, as if the index did not know it, so a `read` device learns nothing of other folders.
   */
  const reach = async (
    ref: OwnImport.SourceRef,
    directory: string,
    scope: OwnImport.Reach | undefined,
  ): Promise<
    | { readonly ok: true; readonly located: Scan.Located; readonly project: Scan.Project }
    | { readonly ok: false; readonly answer: Answer }
  > => {
    const resolved = await scan.project(directory)
    if (!resolved.ok) return { ok: false, answer: unknownFolder(directory, resolved.reason) }
    const located = await locate(ref)
    if (located === undefined || (scope !== "all" && !scan.member(located.row, resolved.project)))
      return { ok: false, answer: notFound(ref) }
    return { ok: true, located, project: resolved.project }
  }

  const rootList = async () =>
    Promise.all(
      (await roots()).map(async (root) => {
        const problem = await Paths.problem(root)
        const sessions = scan.sessions(root.rootID)
        return {
          rootID: root.rootID,
          kind: root.kind,
          label: root.label,
          directory: root.directory,
          added: root.added,
          available: problem === undefined,
          ...(problem === undefined ? {} : { problem }),
          ...(sessions === undefined ? {} : { sessions }),
        }
      }),
    )

  /**
   * The imports of a conversation (`가져옴`), from the root sessions' `own.import` metadata. `sessions.read` reuses
   * them for {@link MARKS_MS}; {@link SOURCE} always reads them again and leaves the reused ones alone, so a plan right
   * after an import offers 열기 / 새로 가져오기 (09 §4.7) and a job's read never keeps the marks from before it.
   */
  const importedOf = async (row: Scan.Row, reuse: boolean) => {
    const at = now()
    const marks =
      reuse && state.marks !== undefined && at - state.marks.at <= MARKS_MS
        ? state.marks
        : {
            at,
            value: http.session
              .all({ parentID: null })
              .then((listed) => (listed.ok ? Scan.marks(listed.value) : new Map<string, Scan.Mark[]>())),
          }
    if (reuse) state.marks = marks
    const found = await marks.value
    return (found.get(`${row.ref.kind}/${row.ref.id}`) ?? []).map((mark) => ({
      sessionID: mark.sessionID,
      mode: mark.mode,
      importedAt: mark.importedAt,
    }))
  }

  const read = async (request: ReadInput, signal: AbortSignal) => {
    const reached = await reach(request.ref, request.directory, request.scope)
    if (!reached.ok) return reached.answer
    const located = reached.located
    if (located.target === undefined) return unreadable(request.ref, located.row.problem ?? "missing")
    // The marks come over self-HTTP while the page is decoded.
    const [page, imported] = await Promise.all([
      viewer.read(located.target, { from: request.from, count: request.count }, signal),
      importedOf(located.row, true),
    ])
    if (!page.ok) return unreadable(request.ref, page.reason)
    const outline = page.value.outline
    return answer({
      summary: Scan.summary(located.row, {
        now: now(),
        exists: (cwd) => Paths.realpath(cwd) !== undefined,
        imported,
        children: outline.children.length,
        compactions: Math.max(located.row.compactions, outline.checkpoints.length),
      }),
      // What the viewer shows a device given `read` (09 §5.5): the turns' first lines and every message string.
      outline: redacted(outline),
      outlineComplete: page.value.outlineComplete,
      messages: redacted(page.value.messages),
      ...(page.value.next === undefined ? {} : { next: page.value.next }),
    })
  }

  /**
   * {@link SOURCE}: the conversation parsed in full with its Codex `history_base` prefix (09 §2.5), the project of
   * `directory` when one is given, and its earlier imports. The parse also gives the index the exact turn count and
   * prefix hashes behind `원본에 새 턴 N개` (`Scan.Service.parsed`).
   */
  const source = async (request: SourceInput, signal: AbortSignal) => {
    const reached =
      request.directory === undefined
        ? { ok: true as const, located: await locate(request.ref), project: undefined }
        : await reach(request.ref, request.directory, request.scope)
    if (!reached.ok) return reached.answer
    const located = reached.located
    if (located === undefined) return notFound(request.ref)
    if (located.target === undefined) return unreadable(request.ref, located.row.problem ?? "missing")
    const [parsed, existing] = await Promise.all([
      parse(located.target, located.row.title, signal),
      importedOf(located.row, false),
    ])
    if (signal.aborted) return unreadable(request.ref, "cancelled")
    if (!parsed.ok) return unreadable(request.ref, parsed.reason)
    scan.parsed(request.ref, parsed.info)
    return answer({
      transcript: parsed.info,
      existing,
      basePartial: parsed.basePartial,
      ...(reached.project === undefined ? {} : { project: reached.project }),
    })
  }

  const searchOne = async (request: SearchRequest, ref: OwnImport.SourceRef, options: SearchInput) => {
    const reached = await reach(ref, request.directory, request.scope)
    if (!reached.ok) return reached.answer
    const target = reached.located.target
    if (target === undefined) return unreadable(ref, reached.located.row.problem ?? "missing")
    const found = await Search.conversation(viewer, target, options)
    return found.ok ? answer(found.value) : unreadable(ref, found.reason)
  }

  /** `내용까지`: the folder's top-level conversations in list order (newest first, no exec runs or archived threads). */
  const searchFolder = async (directory: string, options: SearchInput) => {
    const resolved = await scan.project(directory)
    if (!resolved.ok) return unknownFolder(directory, resolved.reason)
    await indexed()
    const targets = scan
      .members(resolved.project)
      .filter((row) => !row.exec && !row.archived)
      .toSorted((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1))
      .flatMap((row) => {
        const target = Scan.targetOf(row)
        return target === undefined ? [] : [target]
      })
    const found = await Search.folder(viewer, targets, options)
    return found.ok ? answer(found.value) : failure("internal_error", "the search was cancelled")
  }

  const run = async (method: Call, raw: unknown, signal: AbortSignal): Promise<Answer> => {
    if (method === SOURCE) {
      const request = Option.getOrUndefined(INPUT[method](raw))
      return request === undefined ? invalid() : source(request, signal)
    }
    if (method === "sources.list") {
      // The first sources.list or sessions.list builds the index (09 §2.3); the root counts follow it.
      void scan.refresh()
      return answer({ roots: await rootList() })
    }
    if (method === "sources.configure") {
      const request = Option.getOrUndefined(INPUT[method](raw))
      if (request === undefined) return invalid()
      // Never stores what the allowlist refuses (a relative path, a share, a folder own never reads, 09 §2.1).
      const kept = await Promise.all(
        request.extraRoots.map(async (extra) => ((await Paths.problem(extra)) === "path_denied" ? [] : [extra])),
      )
      await Paths.configure(file, kept.flat())
      // A list a moment ago would make an ordinary refresh re-read only the known rows, never the changed roots.
      void scan.refresh({ full: true })
      return answer({ roots: await rootList() })
    }
    if (method === "sessions.list") {
      const request = Option.getOrUndefined(INPUT[method](raw))
      if (request === undefined) return invalid()
      const listed = await scan.list(request)
      return listed.ok ? answer(listed.value) : unknownFolder(request.directory, listed.error)
    }
    if (method === "sessions.read") {
      const request = Option.getOrUndefined(INPUT[method](raw))
      return request === undefined ? invalid() : read(request, signal)
    }
    const request = Option.getOrUndefined(INPUT[method](raw))
    if (request === undefined) return invalid()
    const options = { query: request.query, cursor: request.cursor, limit: request.limit, signal }
    return request.ref === undefined
      ? searchFolder(request.directory, options)
      : searchOne(request, request.ref, options)
  }

  return {
    /** Runs `method`; never rejects: every failure is a declared error of the method or `internal_error`. */
    call: (method: Call, raw: unknown, settings: Settings, signal: AbortSignal): Promise<Answer> => {
      state.settings = settings
      return run(method, raw, signal).catch(() => failure("internal_error", "the import worker failed"))
    },
    /** The viewer's LRU and the conversations it keeps (perf and tests). */
    stats: () => viewer.stats(),
    /** Resolves when the index, its confirm pass and the `import-index.json` write are done (perf and tests). */
    idle: () => scan.idle(),
    close: async () => {
      viewer.clear()
      await scan.close()
    },
  }
}

/** A full parse; `basePartial`: the Codex `history_base` prefix could not be read to its end (09 §2.5). */
async function parse(
  target: Scan.Target,
  title: string,
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly info: Transcript.Info; readonly basePartial: boolean }
  | { readonly ok: false; readonly reason: OwnImport.Unreadable }
> {
  if (target.kind === "codex") {
    const read = await CodexStore.transcript(target.root, target.file, {
      base: true,
      title,
      visit: () => !signal.aborted,
    })
    if (!read.ok) return read
    return {
      ok: true,
      info: read.value.info,
      basePartial: read.value.base !== undefined && read.value.base !== "complete",
    }
  }
  const read = await ClaudeSource.transcript(target.root, target.conversation)
  return read.ok ? { ok: true, info: read.value, basePartial: false } : read
}

/** Every string of a view answer through `Redact.named` (09 §5.5); the keys and the shape stay. */
function redacted(value: unknown): unknown {
  if (typeof value === "string") return Redact.named(value).text
  if (Array.isArray(value)) return value.map(redacted)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map((entry) => [entry[0], redacted(entry[1])]))
}

function answer(value: unknown): Answer {
  return { ok: true, value }
}

function failure(type: OwnImport.ErrorName, message: string, data: unknown = {}): Answer {
  return { ok: false, error: { type, message, data } }
}

function invalid() {
  return failure("internal_error", "the input does not match the method")
}

function notFound(ref: OwnImport.SourceRef) {
  return failure("source_not_found", "no such conversation in the index", { ref })
}

/** `cancelled` is the caller's own abort: nobody reads that answer. */
function unreadable(ref: OwnImport.SourceRef, reason: View.Failure) {
  if (reason === "cancelled") return failure("internal_error", "the read was cancelled")
  return failure("source_unreadable", "the conversation cannot be read", { ref, reason })
}

function unknownFolder(directory: string, reason: "directory_unknown" | "unavailable") {
  if (reason === "directory_unknown")
    return failure("directory_unknown", "not a working folder of a project", { directory })
  return failure("internal_error", "the own service did not answer")
}

// ---------------------------------------------------------------------------------------------------------------
// The Worker thread

if (!Bun.isMainThread) serve()

function serve() {
  const state = { service: undefined as Service | undefined, asks: 0 }
  const running = new Map<number, AbortController>()
  const asked = new Map<number, (folders: ReadonlyArray<string>) => void>()
  const send = (message: ImportRpc.WorkerMessage) => postMessage(message)
  const worktrees = (projectID: string) =>
    new Promise<ReadonlyArray<string>>((resolve) => {
      const call = ++state.asks
      const timer = setTimeout(() => settle([]), ASK_MS)
      const settle = (folders: ReadonlyArray<string>) => {
        clearTimeout(timer)
        asked.delete(call)
        resolve(folders)
      }
      asked.set(call, settle)
      send({ call, op: "worktrees", projectID })
    })
  const emit = (directories: ReadonlyArray<string>) => send({ event: "index.changed", directories: [...directories] })

  self.onmessage = (event: MessageEvent<unknown>) => {
    const request = Option.getOrUndefined(decodeRequest(event.data))
    if (request === undefined) return
    if (request.op === "hello") {
      state.service ??= create({ home: request.home, worktrees, emit })
      return send({ rid: request.rid, ok: true, value: {} })
    }
    if (request.op === "reply") return asked.get(request.call)?.(request.folders)
    if (request.op === "cancel") return running.get(request.rid)?.abort()
    if (request.op === "close") {
      const closed = state.service?.close() ?? Promise.resolve()
      void closed.then(
        () => send({ rid: request.rid, ok: true, value: {} }),
        () => send({ rid: request.rid, ok: true, value: {} }),
      )
      return
    }
    const service = state.service
    if (service === undefined)
      return send({ rid: request.rid, ...failure("internal_error", "the import worker was not started") })
    const controller = new AbortController()
    running.set(request.rid, controller)
    void service.call(request.method, request.input, request.settings, controller.signal).then((answered) => {
      running.delete(request.rid)
      send({ rid: request.rid, ...answered })
    })
  }
}
