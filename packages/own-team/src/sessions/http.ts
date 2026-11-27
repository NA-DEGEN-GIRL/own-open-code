export * as SessionHttp from "./http.js"

import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { optional } from "@opencode/schema/schema"
import { ServiceTarget } from "@own/runtime"

/**
 * Self-HTTP to the own service (06 §2.6): what the plugin API cannot do, or must be done without a live `ctx`
 * (session list/get/log/message, create, prompt, synthetic, generate, interrupt, inbox, permission/form/shell/pty
 * lists, instruction entries, metadata, worktree refresh, a folder's Location). The target comes from an `@own/runtime`
 * `ServiceTarget.Source`: the channel's registration file in an installed build, the plugin option
 * `service:{url, password}` in source runs and tests (loopback `http:` only, 06 §12.2). Every call about a session or
 * a folder carries `location[directory]` (01 §15). A 401 re-reads the source once. Responses are decoded into narrow
 * views of what own.team reads. The password goes only into `Authorization` of these loopback requests.
 *
 * Nothing here throws: every call answers a {@link Result}. own.team never calls `session.compact` (U6, 6.5).
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      /** HTTP status, or `null` when no request was answered (no service, unreachable, timeout). */
      readonly status: number | null
      /** The server's error tag (`SessionNotFoundError`, …), `no_service`, `unreachable` or `invalid_response`. */
      readonly type: string
      readonly message: string
    }

export interface Call {
  readonly signal?: AbortSignal
  /** Default 30 s; `generate` defaults to 3 minutes. */
  readonly timeoutMs?: number
}

/** The service of an installed build (registration file of `channel`) or the plugin option `service`. */
export function source(input: {
  readonly service?: { readonly url: string; readonly password: string }
  readonly channel: string
}): ServiceTarget.Source {
  if (input.service) return ServiceTarget.fixed(input.service)
  return new ServiceTarget.Service(ServiceTarget.registrationPath(input.channel))
}

// ---------------------------------------------------------------------------------------------------------------
// Views

const Metadata = Schema.Record(Schema.String, Schema.Unknown)

/** The session fields own.team reads (`session.list`, `session.get`, `session.create`). */
export const SessionView = Schema.Struct({
  id: Schema.String,
  parentID: optional(Schema.String),
  projectID: Schema.String,
  title: optional(Schema.String),
  agent: optional(Schema.String),
  model: optional(Model.Ref),
  location: Schema.Struct({ directory: Schema.String }),
  metadata: optional(Metadata),
  permissions: optional(Permission.Ruleset),
  outcome: optional(Schema.Literals(["succeeded", "failed", "interrupted"])),
  time: Schema.Struct({
    created: Schema.Finite,
    updated: Schema.Finite,
    idle: optional(Schema.Finite),
    archived: optional(Schema.Finite),
  }),
})
export type SessionView = typeof SessionView.Type

/**
 * An inbox item (`session.inbox.list`, `prompt`, `synthetic`); `payload.metadata` tells main requests apart. A
 * `reset` is a context reset waiting for the turn (core P-035, 06 §6.1): no work in the folder, and what is admitted
 * after it delivers after it. A synthetic with `beforeReset` (a background notice of work started before a reset that
 * still applies; core drops it once that reset is cancelled or undone) is passive and no work either: it never starts a
 * turn and rides with the next input. `time.created` (epoch ms) tells input that waits for the next prompt apart
 * (`SafePoint.runs`).
 */
export const InboxView = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  type: Schema.Literals(["user", "synthetic", "compaction", "move", "reset"]),
  delivery: Schema.Literals(["steer", "queue"]),
  payload: Schema.Struct({
    text: optional(Schema.String),
    metadata: optional(Metadata),
    beforeReset: optional(Schema.String),
  }),
  time: optional(Schema.Struct({ created: Schema.Number })),
})
export type InboxView = typeof InboxView.Type

export const PermissionView = Schema.Struct({ id: Schema.String, sessionID: optional(Schema.String) })
export const FormView = Schema.Struct({ id: Schema.String })
/** `command` names a command that holds a folder (RH-20). */
export const ShellView = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  cwd: Schema.String,
  command: optional(Schema.String),
  metadata: optional(Metadata),
})
export const PtyView = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  cwd: Schema.String,
  title: optional(Schema.String),
  command: optional(Schema.String),
})
export const EntryView = Schema.Struct({ key: Schema.String, value: Schema.Json })

/** A durable session log item (`session.log`); typed further by the code that reads it. */
export type LogItem = Readonly<Record<string, unknown>>

/** A page's cursors; the service writes an absent one as `null` (an empty message list has both `null`). */
const Cursor = Schema.Struct({
  previous: optional(Schema.NullOr(Schema.String)),
  next: optional(Schema.NullOr(Schema.String)),
})
const data = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.Struct({ data: schema })

// ---------------------------------------------------------------------------------------------------------------
// Inputs

export interface SessionRef {
  readonly sessionID: string
  /** The session's `location.directory`; sent as `location[directory]`. */
  readonly directory: string
}

export interface CreateInput {
  readonly id?: string
  readonly title?: string
  readonly agent?: string
  readonly model?: Model.Ref
  readonly directory: string
  readonly metadata?: Readonly<Record<string, Schema.Json>>
  readonly permissions?: Permission.Ruleset
}

export interface PromptInput extends SessionRef {
  readonly id?: string
  readonly text: string
  readonly metadata?: Readonly<Record<string, Schema.Json>>
  readonly delivery?: "steer" | "queue"
  readonly resume?: boolean
}

export interface SyntheticInput extends PromptInput {
  readonly description?: string
}

export interface ListQuery {
  readonly directory?: string
  readonly project?: string
  /** `null`: root sessions only. */
  readonly parentID?: string | null
  readonly limit?: number
  readonly order?: "asc" | "desc"
  readonly cursor?: string
  readonly search?: string
}

export interface Client {
  readonly session: {
    list(
      query: ListQuery,
      call?: Call,
    ): Promise<Result<{ readonly data: ReadonlyArray<SessionView>; readonly cursor: typeof Cursor.Type }>>
    get(input: SessionRef, call?: Call): Promise<Result<SessionView>>
    /** Ids of sessions whose execution runs in this process (`session.active`, does not wake Locations). */
    active(call?: Call): Promise<Result<ReadonlySet<string>>>
    create(input: CreateInput, call?: Call): Promise<Result<SessionView>>
    prompt(input: PromptInput, call?: Call): Promise<Result<InboxView>>
    synthetic(input: SyntheticInput, call?: Call): Promise<Result<InboxView>>
    /** One-off text from the session's context (the judge call, 3.4); never `ctx.generate.text`. */
    generate(input: SessionRef & { readonly prompt: string }, call?: Call): Promise<Result<string>>
    /** `true` when a running execution was interrupted. */
    interrupt(input: SessionRef & { readonly resume?: boolean }, call?: Call): Promise<Result<boolean>>
    /** Durable log items after `after` (exclusive seq), without follow (5.5 따라잡기). */
    log(input: SessionRef & { readonly after?: number }, call?: Call): Promise<Result<ReadonlyArray<LogItem>>>
    message(input: SessionRef & { readonly messageID: string }, call?: Call): Promise<Result<LogItem>>
    messages(
      input: SessionRef & { readonly limit?: number; readonly order?: "asc" | "desc"; readonly cursor?: string },
      call?: Call,
    ): Promise<Result<{ readonly data: ReadonlyArray<LogItem>; readonly cursor: typeof Cursor.Type }>>
    /**
     * Read-modify-write of the session metadata (the PATCH replaces it whole, core session.ts:76-82); `change` gets
     * the current value. Returns what was written.
     */
    metadata(
      input: SessionRef & {
        readonly change: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, Schema.Json>>
      },
      call?: Call,
    ): Promise<Result<Readonly<Record<string, Schema.Json>>>>
  }
  readonly inbox: {
    list(input: SessionRef, call?: Call): Promise<Result<ReadonlyArray<InboxView>>>
    cancel(input: SessionRef & { readonly inboxID: string }, call?: Call): Promise<Result<void>>
    update(
      input: SessionRef & { readonly inboxID: string; readonly delivery: "steer" | "queue" },
      call?: Call,
    ): Promise<Result<void>>
  }
  readonly permission: {
    list(input: SessionRef, call?: Call): Promise<Result<ReadonlyArray<typeof PermissionView.Type>>>
  }
  readonly form: {
    list(input: SessionRef, call?: Call): Promise<Result<ReadonlyArray<typeof FormView.Type>>>
  }
  readonly shell: {
    list(input: { readonly directory: string }, call?: Call): Promise<Result<ReadonlyArray<typeof ShellView.Type>>>
    /** Ends the command and removes it (`DELETE /api/shell/<id>`, RH-20: 명령 멈추고 진행). */
    remove(input: { readonly directory: string; readonly id: string }, call?: Call): Promise<Result<void>>
  }
  readonly pty: {
    list(input: { readonly directory: string }, call?: Call): Promise<Result<ReadonlyArray<typeof PtyView.Type>>>
    /** Closes the terminal (`DELETE /api/pty/<id>`, RH-20). */
    remove(input: { readonly directory: string; readonly id: string }, call?: Call): Promise<Result<void>>
  }
  readonly instructions: {
    list(input: SessionRef, call?: Call): Promise<Result<ReadonlyArray<typeof EntryView.Type>>>
    /** `PUT …/instructions/entries/<key>` (at most 256 KB). */
    put(input: SessionRef & { readonly key: string; readonly value: Schema.Json }, call?: Call): Promise<Result<void>>
    remove(input: SessionRef & { readonly key: string }, call?: Call): Promise<Result<void>>
  }
  readonly worktree: {
    /** `worktree.refresh{projectID}`: core discovers worktrees made outside it (06 §3.6 `refresh`). */
    refresh(input: { readonly projectID: string; readonly directory?: string }, call?: Call): Promise<Result<void>>
  }
  readonly location: {
    /** `location.get`: the folder's Location (loaded when it is not) and its project. */
    get(directory: string, call?: Call): Promise<Result<typeof LocationView.Type>>
    /**
     * `debug.location.evict`: the folder's cached Location services go, so its next use resolves the folder again
     * (its project and VCS, after Git 저장소로 만들기, 3.0). Running work keeps the services it holds.
     */
    evict(directory: string, call?: Call): Promise<Result<void>>
  }
}

/** The `location.get` fields own.team reads. */
export const LocationView = Schema.Struct({
  directory: Schema.String,
  project: Schema.Struct({ id: Schema.String }),
})

const DEFAULT_TIMEOUT_MS = 30_000
const GENERATE_TIMEOUT_MS = 180_000
/** Methods a request may be sent again with: they read, or repeat to the same end (an inbox change, an entry). */
const REPEATABLE: ReadonlySet<string> = new Set(["GET", "PUT", "PATCH", "DELETE"])

type Query = Readonly<Record<string, string | undefined>>

export function create(input: { readonly source: ServiceTarget.Source; readonly timeoutMs?: number }): Client {
  const send = async (
    method: string,
    path: string,
    options: {
      readonly query?: Query
      readonly directory?: string
      readonly body?: unknown
      readonly call?: Call
      /** A POST that repeats to the same end: it names what it makes (`id`), or only looks again (RH-43). */
      readonly repeat?: boolean
    },
  ): Promise<Result<Response>> => {
    const repeatable = REPEATABLE.has(method) || options.repeat === true
    const attempt = async (retry: boolean): Promise<Result<Response>> => {
      const target = await input.source.current().catch(() => undefined)
      if (!target) return fail(null, "no_service", "the own service is not reachable (no registration)")
      const url = new URL(path, target.url)
      if (options.directory !== undefined) url.searchParams.set("location[directory]", options.directory)
      for (const [key, value] of Object.entries(options.query ?? {}))
        if (value !== undefined) url.searchParams.set(key, value)
      const timeout = AbortSignal.timeout(options.call?.timeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const signal = options.call?.signal ? AbortSignal.any([options.call.signal, timeout]) : timeout
      const response = await fetch(url, {
        method,
        headers: {
          authorization: target.authorization,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        // The repeat goes on a socket of its own, never another pooled one the server may be closing too (RH-43).
        ...(retry ? {} : { keepalive: false }),
        signal,
      }).catch((error: unknown) => error)
      // A pooled keep-alive socket the server closed as idle in the same moment fails before the request reaches the
      // server (seen under load, RH-28; a server whose event loop is busy booting Locations closes it late, RH-43); a
      // request that can be repeated goes once more on a new socket.
      if (!(response instanceof Response) && retry && repeatable && !signal.aborted && stale(response))
        return attempt(false)
      if (!(response instanceof Response))
        return fail(null, "unreachable", response instanceof Error ? response.message : String(response))
      if (response.status === 401 && retry) {
        input.source.invalidate()
        await response.body?.cancel().catch(() => {})
        return attempt(false)
      }
      if (response.ok) return { ok: true, value: response }
      const body = await response.json().catch(() => undefined)
      return fail(response.status, errorType(body, response.status), errorMessage(body, response.statusText))
    }
    return attempt(true)
  }

  const json = async <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    method: string,
    path: string,
    options: Parameters<typeof send>[2],
  ): Promise<Result<S["Type"]>> => {
    const sent = await send(method, path, options)
    if (!sent.ok) return sent
    const body = await sent.value.json().catch(() => undefined)
    const decoded = Schema.decodeUnknownOption(schema)(body)
    if (Option.isNone(decoded)) return fail(sent.value.status, "invalid_response", `unexpected response from ${path}`)
    return { ok: true, value: decoded.value }
  }

  const empty = async (method: string, path: string, options: Parameters<typeof send>[2]): Promise<Result<void>> => {
    const sent = await send(method, path, options)
    if (!sent.ok) return sent
    await sent.value.body?.cancel().catch(() => {})
    return { ok: true, value: undefined }
  }

  const sessionPath = (sessionID: string, rest = "") => `/api/session/${encodeURIComponent(sessionID)}${rest}`
  const map = <A, B>(result: Result<A>, f: (value: A) => B): Result<B> =>
    result.ok ? { ok: true, value: f(result.value) } : result

  const getSession = async (ref: SessionRef, call?: Call) =>
    map(
      await json(data(SessionView), "GET", sessionPath(ref.sessionID), { directory: ref.directory, call }),
      (body) => body.data,
    )

  return {
    session: {
      list: (query, call) =>
        json(Schema.Struct({ data: Schema.Array(SessionView), cursor: Cursor }), "GET", "/api/session", {
          query: {
            directory: query.directory,
            project: query.project,
            parentID: query.parentID === null ? "null" : query.parentID,
            limit: query.limit === undefined ? undefined : String(query.limit),
            order: query.order,
            cursor: query.cursor,
            search: query.search,
          },
          call,
        }),
      get: getSession,
      active: async (call) =>
        map(
          await json(data(Schema.Record(Schema.String, Schema.Unknown)), "GET", "/api/session/active", { call }),
          (body) => new Set(Object.keys(body.data)),
        ),
      create: async (create, call) =>
        map(
          await json(data(SessionView), "POST", "/api/session", {
            directory: create.directory,
            body: {
              ...(create.id === undefined ? {} : { id: create.id }),
              ...(create.title === undefined ? {} : { title: create.title }),
              ...(create.agent === undefined ? {} : { agent: create.agent }),
              ...(create.model === undefined ? {} : { model: create.model }),
              location: { directory: create.directory },
              ...(create.metadata === undefined ? {} : { metadata: create.metadata }),
              ...(create.permissions === undefined ? {} : { permissions: create.permissions }),
            },
            call,
            // Core adopts the session a create names (`id`): a second create of it makes no second conversation.
            repeat: create.id !== undefined,
          }),
          (body) => body.data,
        ),
      prompt: async (prompt, call) =>
        map(
          await json(data(InboxView), "POST", sessionPath(prompt.sessionID, "/prompt"), {
            directory: prompt.directory,
            body: admission(prompt),
            call,
            // An inbox item id admits once: the retried payload is ignored.
            repeat: prompt.id !== undefined,
          }),
          (body) => body.data,
        ),
      synthetic: async (synthetic, call) =>
        map(
          await json(data(InboxView), "POST", sessionPath(synthetic.sessionID, "/synthetic"), {
            directory: synthetic.directory,
            body: {
              ...admission(synthetic),
              ...(synthetic.description === undefined ? {} : { description: synthetic.description }),
            },
            call,
            repeat: synthetic.id !== undefined,
          }),
          (body) => body.data,
        ),
      generate: async (generate, call) =>
        map(
          await json(
            data(Schema.Struct({ text: Schema.String })),
            "POST",
            sessionPath(generate.sessionID, "/generate"),
            {
              directory: generate.directory,
              body: { prompt: generate.prompt },
              call: { ...call, timeoutMs: call?.timeoutMs ?? GENERATE_TIMEOUT_MS },
            },
          ),
          (body) => body.data.text,
        ),
      interrupt: async (interrupt, call) =>
        map(
          await json(
            Schema.Struct({ interrupted: Schema.Boolean }),
            "POST",
            sessionPath(interrupt.sessionID, "/interrupt"),
            {
              directory: interrupt.directory,
              query: { resume: interrupt.resume === undefined ? undefined : String(interrupt.resume) },
              call,
            },
          ),
          (body) => body.interrupted,
        ),
      log: async (log, call) => {
        const sent = await send("GET", `/api/experimental/session/${encodeURIComponent(log.sessionID)}/log`, {
          directory: log.directory,
          query: { after: log.after === undefined ? undefined : String(log.after) },
          call,
        })
        if (!sent.ok) return sent
        const text = await sent.value.text().catch(() => undefined)
        if (text === undefined) return fail(sent.value.status, "invalid_response", "the session log could not be read")
        return { ok: true, value: sse(text) }
      },
      message: async (message, call) =>
        map(
          await json(
            data(Schema.Record(Schema.String, Schema.Unknown)),
            "GET",
            sessionPath(message.sessionID, `/message/${encodeURIComponent(message.messageID)}`),
            { directory: message.directory, call },
          ),
          (body) => body.data,
        ),
      messages: (messages, call) =>
        json(
          Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)), cursor: Cursor }),
          "GET",
          sessionPath(messages.sessionID, "/message"),
          {
            directory: messages.directory,
            query: {
              limit: messages.limit === undefined ? undefined : String(messages.limit),
              order: messages.order,
              cursor: messages.cursor,
            },
            call,
          },
        ),
      metadata: async (update, call) => {
        const current = await getSession(update, call)
        if (!current.ok) return current
        const next = update.change(current.value.metadata ?? {})
        const written = await empty("PATCH", sessionPath(update.sessionID), {
          directory: update.directory,
          body: { metadata: next },
          call,
        })
        return map(written, () => next)
      },
    },
    inbox: {
      list: async (ref, call) =>
        map(
          await json(data(Schema.Array(InboxView)), "GET", sessionPath(ref.sessionID, "/inbox"), {
            directory: ref.directory,
            call,
          }),
          (body) => body.data,
        ),
      cancel: (cancel, call) =>
        empty("DELETE", sessionPath(cancel.sessionID, `/inbox/${encodeURIComponent(cancel.inboxID)}`), {
          directory: cancel.directory,
          call,
        }),
      update: (update, call) =>
        empty("PATCH", sessionPath(update.sessionID, `/inbox/${encodeURIComponent(update.inboxID)}`), {
          directory: update.directory,
          body: { delivery: update.delivery },
          call,
        }),
    },
    permission: {
      list: async (ref, call) =>
        map(
          await json(data(Schema.Array(PermissionView)), "GET", sessionPath(ref.sessionID, "/permission"), {
            directory: ref.directory,
            call,
          }),
          (body) => body.data,
        ),
    },
    form: {
      list: async (ref, call) =>
        map(
          await json(data(Schema.Array(FormView)), "GET", sessionPath(ref.sessionID, "/form"), {
            directory: ref.directory,
            call,
          }),
          (body) => body.data,
        ),
    },
    shell: {
      list: async (list, call) =>
        map(
          await json(data(Schema.Array(ShellView)), "GET", "/api/shell", { directory: list.directory, call }),
          (body) => body.data,
        ),
      remove: (remove, call) =>
        empty("DELETE", `/api/shell/${encodeURIComponent(remove.id)}`, { directory: remove.directory, call }),
    },
    pty: {
      list: async (list, call) =>
        map(
          await json(data(Schema.Array(PtyView)), "GET", "/api/pty", { directory: list.directory, call }),
          (body) => body.data,
        ),
      remove: (remove, call) =>
        empty("DELETE", `/api/pty/${encodeURIComponent(remove.id)}`, { directory: remove.directory, call }),
    },
    instructions: {
      list: async (ref, call) =>
        map(
          await json(
            data(Schema.Array(EntryView)),
            "GET",
            `/api/experimental/session/${encodeURIComponent(ref.sessionID)}/instructions/entries`,
            { directory: ref.directory, call },
          ),
          (body) => body.data,
        ),
      put: (put, call) =>
        empty(
          "PUT",
          `/api/experimental/session/${encodeURIComponent(put.sessionID)}/instructions/entries/${encodeURIComponent(put.key)}`,
          { directory: put.directory, body: { value: put.value }, call },
        ),
      remove: (remove, call) =>
        empty(
          "DELETE",
          `/api/experimental/session/${encodeURIComponent(remove.sessionID)}/instructions/entries/${encodeURIComponent(remove.key)}`,
          { directory: remove.directory, call },
        ),
    },
    worktree: {
      refresh: (refresh, call) =>
        empty("POST", "/api/worktree/refresh", {
          ...(refresh.directory === undefined ? {} : { directory: refresh.directory }),
          body: { projectID: refresh.projectID },
          call,
          repeat: true,
        }),
    },
    location: {
      get: (directory, call) => json(LocationView, "GET", "/api/location", { directory, call }),
      evict: (directory, call) => empty("DELETE", "/api/debug/location", { directory, call }),
    },
  }
}

function admission(input: PromptInput) {
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    text: input.text,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    ...(input.resume === undefined ? {} : { resume: input.resume }),
  }
}

/** `data:` payloads of a server-sent event stream, each a JSON object; other lines and bad payloads are skipped. */
export function sse(text: string): ReadonlyArray<LogItem> {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .flatMap((line) => {
      const item = Option.getOrUndefined(decodeItem(line.slice(5).trim()))
      return item ? [item] : []
    })
}

const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** The socket closed under the request before an answer (ECONNRESET), not a timeout or the caller's abort. */
function stale(error: unknown) {
  if (!(error instanceof Error)) return false
  return ("code" in error && error.code === "ECONNRESET") || /socket connection was closed/i.test(error.message)
}

function fail(status: number | null, type: string, message: string) {
  return { ok: false as const, status, type, message }
}

/** The server's error tag: `{_tag}` (HttpApi errors), `{name}` (schema errors) or `{type}`. */
function errorType(body: unknown, status: number) {
  if (typeof body === "object" && body !== null) {
    const record: Readonly<Record<string, unknown>> = { ...body }
    for (const key of ["_tag", "name", "type"]) if (typeof record[key] === "string") return String(record[key])
  }
  return `http_${status}`
}

function errorMessage(body: unknown, fallback: string) {
  if (typeof body === "object" && body !== null) {
    const record: Readonly<Record<string, unknown>> = { ...body }
    if (typeof record.message === "string") return record.message
    const nested = record.data
    if (typeof nested === "object" && nested !== null) {
      const inner: Readonly<Record<string, unknown>> = { ...nested }
      if (typeof inner.message === "string") return inner.message
    }
  }
  return fallback
}
