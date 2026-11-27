export * as SelfHttp from "./http.js"

import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { Account } from "@own/protocol"
import { OwnAccounts } from "@own/protocol/rpc"
import { ServiceTarget } from "@own/runtime"

/**
 * Self-HTTP to the own service (09 §5.1 이유 3, 06 §2.6): what own.import needs that the plugin API does not offer.
 * The project list (the project's recorded folders, 09 §2.2), the session list by project (archived sessions are
 * listed too, core keeps them in the list: the imported marks, 09 §4.7, and the helper cleanup, 09 §4.4), session get,
 * `experimental.session.import` (09 §4.2, §4.4), `experimental.session.log` with its cursor and a session's compaction
 * messages (the helper's end, 09 §4.4), the own.accounts RPCs `estimate.request` (09 §5.6) and `accounts.list` (the
 * plan's accounts, 09 §4.5), and what a plan reads of the import Location: its models, providers, hidden `compaction`
 * agent and branch (the plugin API's `model.list`, `provider.list` and `vcs.get` answer only for the plugin's own
 * Location). `session.compact` and `session.remove` go through `ctx.session`.
 *
 * Modelled on own-team `SessionHttp`: the target comes from an `@own/runtime` `ServiceTarget.Source` (the channel's
 * registration file in an installed build, the plugin option `service:{url, password}` in source runs and tests;
 * loopback `http:` only). Every call about a session or a folder carries `location[directory]`. A 401 re-reads the
 * source once. The password goes only into `Authorization` of these loopback requests, never into a URL, an error or a
 * log. Nothing here throws: every call answers a {@link Result}.
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      /** HTTP status, or `null` when no request was answered (no service, unreachable, timeout). */
      readonly status: number | null
      /**
       * The server's error tag (`ConflictError`, `SessionNotFoundError`, …), an RPC error's declared type
       * (`account_not_found`, …), `no_service`, `unreachable`, `invalid_request` or `invalid_response`.
       */
      readonly type: string
      readonly message: string
      /** An RPC error's declared data. */
      readonly data?: unknown
    }

export interface Call {
  readonly signal?: AbortSignal
  /** Default 30 s. */
  readonly timeoutMs?: number
}

export interface Settings {
  readonly service?: { readonly url: string; readonly password: string }
  readonly channel: string
}

/** The service of an installed build (registration file of `channel`) or the plugin option `service`. */
export function source(input: Settings): ServiceTarget.Source {
  if (input.service) return ServiceTarget.fixed(input.service)
  return new ServiceTarget.Service(ServiceTarget.registrationPath(input.channel))
}

/** The {@link source} of the latest settings, made anew only when the service option or the channel changed. */
export function following(settings: () => Settings): ServiceTarget.Source {
  const state: { key?: string; source?: ServiceTarget.Source } = {}
  const latest = () => {
    const now = settings()
    const key = JSON.stringify([now.service?.url, now.service?.password, now.channel])
    if (state.source === undefined || state.key !== key) {
      state.key = key
      state.source = source(now)
    }
    return state.source
  }
  return { current: () => latest().current(), invalidate: () => latest().invalidate() }
}

// ---------------------------------------------------------------------------------------------------------------
// Views: what own.import reads of the answers

const Metadata = Schema.Record(Schema.String, Schema.Unknown)

/** A project as `project.list` gives it: its id, its main folder and the legacy sandbox folders. */
export const ProjectView = Schema.Struct({
  id: Schema.String,
  canonical: Schema.String,
  sandboxes: Schema.Array(Schema.String),
})
export type ProjectView = typeof ProjectView.Type

/** The session fields own.import reads (`session.list`, `session.get`, `session.import`). */
export const SessionView = Schema.Struct({
  id: SessionID,
  parentID: optional(Schema.String),
  projectID: Schema.String,
  title: optional(Schema.String),
  model: optional(Model.Ref),
  location: Schema.Struct({ directory: Schema.String }),
  metadata: optional(Metadata),
  time: Schema.Struct({
    created: Schema.Finite,
    updated: Schema.Finite,
    idle: optional(Schema.Finite),
    archived: optional(Schema.Finite),
  }),
})
export type SessionView = typeof SessionView.Type

/** A durable session log item or the `log.synced` marker (`session.log`); typed further by the code that reads it. */
export type LogItem = Readonly<Record<string, unknown>>

const Cursor = Schema.Struct({
  previous: optional(Schema.NullOr(Schema.String)),
  next: optional(Schema.NullOr(Schema.String)),
})

const SessionPage = Schema.Struct({ data: Schema.Array(SessionView), cursor: Cursor })
export type SessionPage = typeof SessionPage.Type

const data = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.Struct({ data: schema })

/** The provider fields a plan reads (`settings.compaction`, `canonical`, 09 §4.5). */
const ProviderView = Schema.Struct({
  id: Provider.ID,
  canonical: optional(Provider.ID),
  settings: optional(Provider.Settings),
})

/** What a plan reads of the import Location (`Plan.Catalog`). */
export interface Catalog {
  readonly models: ReadonlyArray<Model.Info>
  readonly providers: ReadonlyArray<typeof ProviderView.Type>
  /** The hidden `compaction` agent's model, when the Location configures one (09 §4.5 실제로 요약할 모델). */
  readonly compaction?: Model.Ref
}

// ---------------------------------------------------------------------------------------------------------------
// Inputs

export interface SessionRef {
  readonly sessionID: string
  /** The session's `location.directory`; sent as `location[directory]`. */
  readonly directory: string
}

export interface ListQuery {
  readonly project?: string
  readonly directory?: string
  /** `null`: root sessions only. */
  readonly parentID?: string | null
  readonly limit?: number
  readonly order?: "asc" | "desc"
  readonly cursor?: string
}

export interface ImportInput {
  /** The folder the session goes to: the payload location (the route reads it, not the query, 09 §4.2). */
  readonly directory: string
  readonly data: SessionTransfer.Data
}

export interface LogInput extends SessionRef {
  /** The exclusive aggregate sequence to read after (a previous {@link Log.cursor}). */
  readonly after?: number
  /** Keep reading live events after the replay; the read ends when `visit` says so, `signal` aborts or it times out. */
  readonly follow?: boolean
  /** Called with each item as it arrives; `false` stops the read. */
  readonly visit?: (item: LogItem) => boolean | void
}

export interface Log {
  readonly items: ReadonlyArray<LogItem>
  /** The highest sequence read (a durable item or the `log.synced` marker): the next call's `after`. */
  readonly cursor?: number
  /** The stream broke off (a timeout, an abort, a closed connection) before it ended: read on from `cursor`. */
  readonly interrupted?: boolean
}

export type EstimateInput = {
  readonly target: Model.Ref
  readonly requests: ReadonlyArray<OwnAccounts.EstimateRequestItem>
  /** The account of `target` to price on (`migrate.plan` `accountID`); absent: own.accounts' account of the provider. */
  readonly accountID?: string
}

export interface Client {
  readonly project: {
    list(call?: Call): Promise<Result<ReadonlyArray<ProjectView>>>
  }
  readonly session: {
    /** One page of `GET /api/session`. Archived sessions are not filtered out by core. */
    list(query: ListQuery, call?: Call): Promise<Result<SessionPage>>
    /** Every page of {@link list}, following `cursor.next`, up to `max` sessions (default 10,000). */
    all(query: Omit<ListQuery, "cursor">, call?: Call & { readonly max?: number }): Promise<Result<SessionView[]>>
    get(ref: SessionRef, call?: Call): Promise<Result<SessionView>>
    /** `POST /api/experimental/session/import`; an existing id answers `ConflictError` with status 409. */
    import(input: ImportInput, call?: Call): Promise<Result<SessionView>>
    log(input: LogInput, call?: Call): Promise<Result<Log>>
  }
  readonly message: {
    /**
     * The session's compaction messages, newest first (`GET /api/session/:id/message?type=compaction`): how the helper
     * sees its summary end (09 §4.4). The projected messages are there whatever the service keeps of its event log.
     */
    compactions(ref: SessionRef, call?: Call): Promise<Result<ReadonlyArray<SessionMessage.Compaction>>>
    /**
     * The session's context as the model reads it (`GET /api/session/:id/context`): since upstream v2.1 a summary
     * compaction stores only where its kept messages start, and this is where core rebuilds their text
     * (`metadata.recent` on the compaction the context starts with).
     */
    context(ref: SessionRef, call?: Call): Promise<Result<ReadonlyArray<SessionMessage.Info>>>
  }
  readonly accounts: {
    /** own.accounts `estimate.request` at `directory`'s Location (`POST /api/rpc/own.accounts/estimate.request`). */
    estimate(
      input: EstimateInput,
      where: { readonly directory: string },
      call?: Call,
    ): Promise<Result<OwnAccounts.EstimateRequestResult>>
    /** own.accounts `accounts.list` at `directory`'s Location: the registry's accounts as the screens see them. */
    list(where: { readonly directory: string }, call?: Call): Promise<Result<ReadonlyArray<Account.View>>>
  }
  readonly location: {
    /** `GET /api/model`, `/api/provider` and `/api/agent/compaction` at `directory`'s Location. */
    catalog(directory: string, call?: Call): Promise<Result<Catalog>>
    /** `GET /api/vcs`: the folder's current branch; `undefined` when it has none. */
    branch(directory: string, call?: Call): Promise<Result<string | undefined>>
    /** `GET /api/skill`: the ids and files of the skills core loads at `directory`'s Location (SK2 `skills.detail`). */
    skills(directory: string, call?: Call): Promise<Result<ReadonlyArray<SkillView>>>
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const PAGE = 200
const MAX_SESSIONS = 10_000

type Query = Readonly<Record<string, string | undefined>>

interface Request {
  readonly query?: Query
  readonly directory?: string
  readonly body?: unknown
  readonly call?: Call
}

export function create(input: { readonly source: ServiceTarget.Source; readonly timeoutMs?: number }): Client {
  const send = async (method: string, path: string, request: Request): Promise<Result<Response>> => {
    const attempt = async (retry: boolean): Promise<Result<Response>> => {
      const target = await input.source.current().catch(() => undefined)
      if (!target) return fail(null, "no_service", "the own service is not reachable (no registration)")
      const url = new URL(path, target.url)
      if (request.directory !== undefined) url.searchParams.set("location[directory]", request.directory)
      for (const [key, value] of Object.entries(request.query ?? {}))
        if (value !== undefined) url.searchParams.set(key, value)
      const timeout = AbortSignal.timeout(request.call?.timeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const response = await fetch(url, {
        method,
        headers: {
          authorization: target.authorization,
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: request.call?.signal ? AbortSignal.any([request.call.signal, timeout]) : timeout,
      }).catch((error: unknown) => error)
      if (!(response instanceof Response))
        return fail(null, "unreachable", response instanceof Error ? response.message : "the request failed")
      if (response.status === 401 && retry) {
        input.source.invalidate()
        await response.body?.cancel().catch(() => {})
        return attempt(false)
      }
      if (response.ok) return { ok: true, value: response }
      const body = await response.json().catch(() => undefined)
      return failure(response, body)
    }
    return attempt(true)
  }

  const json = async <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    method: string,
    path: string,
    request: Request,
  ): Promise<Result<S["Type"]>> => {
    const sent = await send(method, path, request)
    if (!sent.ok) return sent
    const body = await sent.value.json().catch(() => undefined)
    const decoded = Schema.decodeUnknownOption(schema)(body)
    if (Option.isNone(decoded)) return fail(sent.value.status, "invalid_response", `unexpected response from ${path}`)
    return { ok: true, value: decoded.value }
  }

  /** An own.accounts RPC at `where`'s Location: its `output` decoded with `decode`, or the declared error. */
  const accounts = async <T>(
    decode: (body: unknown) => Option.Option<{ readonly output: T }>,
    method: string,
    input: unknown,
    where: { readonly directory: string },
    call: Call | undefined,
  ): Promise<Result<T>> => {
    const sent = await send("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      directory: where.directory,
      body: { input },
      call,
    })
    if (!sent.ok) return sent
    const decoded = decode(await sent.value.json().catch(() => undefined))
    if (Option.isNone(decoded)) return fail(sent.value.status, "invalid_response", `unexpected response from ${method}`)
    return { ok: true, value: decoded.value.output }
  }

  const list = (query: ListQuery, call?: Call) =>
    json(SessionPage, "GET", "/api/session", {
      query: {
        project: query.project,
        directory: query.directory,
        parentID: query.parentID === null ? "null" : query.parentID,
        limit: query.limit === undefined ? undefined : String(query.limit),
        order: query.order,
        cursor: query.cursor,
      },
      call,
    })

  const all = async (
    query: Omit<ListQuery, "cursor">,
    call: (Call & { readonly max?: number }) | undefined,
    found: ReadonlyArray<SessionView> = [],
    cursor?: string,
  ): Promise<Result<SessionView[]>> => {
    const page = await list({ limit: PAGE, ...query, ...(cursor === undefined ? {} : { cursor }) }, call)
    if (!page.ok) return page
    const next = [...found, ...page.value.data]
    const more = page.value.cursor.next ?? undefined
    if (more === undefined || page.value.data.length === 0 || next.length >= (call?.max ?? MAX_SESSIONS))
      return { ok: true, value: next }
    return all(query, call, next, more)
  }

  return {
    project: {
      list: (call) => json(Schema.Array(ProjectView), "GET", "/api/project", { call }),
    },
    session: {
      list,
      all: (query, call) => all(query, call),
      get: async (ref, call) =>
        map(
          await json(data(SessionView), "GET", `/api/session/${encodeURIComponent(ref.sessionID)}`, {
            directory: ref.directory,
            call,
          }),
          (body) => body.data,
        ),
      import: async (request, call) => {
        const encoded = encodeTransfer(request.data)
        if (Option.isNone(encoded))
          return fail(null, "invalid_request", "the transcript does not match SessionTransfer.Data")
        return map(
          await json(data(SessionView), "POST", "/api/experimental/session/import", {
            directory: request.directory,
            body: { ...encoded.value, location: { directory: request.directory } },
            call,
          }),
          (body) => body.data,
        )
      },
      log: async (request, call) => {
        const sent = await send("GET", `/api/experimental/session/${encodeURIComponent(request.sessionID)}/log`, {
          directory: request.directory,
          query: {
            after: request.after === undefined ? undefined : String(request.after),
            follow: request.follow ? "true" : undefined,
          },
          call,
        })
        if (!sent.ok) return sent
        const read = await events(sent.value, request.visit)
        if (read === undefined) return fail(sent.value.status, "invalid_response", "the session log could not be read")
        return { ok: true, value: read }
      },
    },
    message: {
      compactions: async (ref, call) =>
        map(
          await json(
            data(Schema.Array(SessionMessage.Compaction)),
            "GET",
            `/api/session/${encodeURIComponent(ref.sessionID)}/message`,
            { directory: ref.directory, query: { type: "compaction", order: "desc", limit: "20" }, call },
          ),
          (body) => body.data,
        ),
      context: async (ref, call) =>
        map(
          await json(
            data(Schema.Array(SessionMessage.Info)),
            "GET",
            `/api/session/${encodeURIComponent(ref.sessionID)}/context`,
            { directory: ref.directory, call },
          ),
          (body) => body.data,
        ),
    },
    accounts: {
      estimate: (request, where, call) => accounts(decodeEstimate, "estimate.request", request, where, call),
      list: async (where, call) =>
        map(await accounts(decodeAccounts, "accounts.list", {}, where, call), (output) => output.accounts),
    },
    location: {
      catalog: async (directory, call) => {
        const [models, providers, agent] = await Promise.all([
          json(data(Schema.Array(Model.Info)), "GET", "/api/model", { directory, call }),
          json(data(Schema.Array(ProviderView)), "GET", "/api/provider", { directory, call }),
          json(data(AgentView), "GET", "/api/agent/compaction", { directory, call }),
        ])
        if (!models.ok) return models
        if (!providers.ok) return providers
        // Only a Location without the hidden agent (`agent.get`'s `AgentNotFoundError`) summarizes with the session
        // model; any other failure (a moved route's plain 404 included) fails the catalog, so a plan never names the
        // target as summarizer by mistake (09 §4.5, upstream-surface `import-agent-get`).
        if (!agent.ok && agent.type !== "AgentNotFoundError") return agent
        const compaction = agent.ok ? agent.value.data.model : undefined
        return {
          ok: true,
          value: {
            models: models.value.data,
            providers: providers.value.data,
            ...(compaction === undefined ? {} : { compaction }),
          },
        }
      },
      branch: async (directory, call) =>
        map(await json(data(VcsView), "GET", "/api/vcs", { directory, call }), (body) => body.data.branch.current),
      skills: async (directory, call) =>
        map(await json(data(Schema.Array(SkillView)), "GET", "/api/skill", { directory, call }), (body) => body.data),
    },
  }
}

const decodeEstimate = Schema.decodeUnknownOption(Schema.Struct({ output: OwnAccounts.EstimateRequestResult }))
const decodeAccounts = Schema.decodeUnknownOption(
  Schema.Struct({ output: Schema.Struct({ accounts: Schema.Array(Account.View) }) }),
)
const AgentView = Schema.Struct({ model: optional(Model.Ref) })
const VcsView = Schema.Struct({ branch: Schema.Struct({ current: optional(Schema.String) }) })
/** What own.import reads of a skill core loads: its id and its file (`SKILL.md` or a flat `<id>.md`). */
export const SkillView = Schema.Struct({ id: Schema.String, path: Schema.String })
export type SkillView = typeof SkillView.Type
const encodeTransfer = Schema.encodeOption(SessionTransfer.Data)

function map<A, B>(result: Result<A>, f: (value: A) => B): Result<B> {
  return result.ok ? { ok: true, value: f(result.value) } : result
}

/**
 * Reads a server-sent event stream (`session.log`): each event's `data:` lines as one JSON object; comments, other
 * fields and payloads that are not objects are skipped. `visit` returning `false` cancels the rest of the stream. A
 * stream that breaks off keeps what was read ({@link Log.interrupted}); `undefined` when nothing could be read.
 */
async function events(response: Response, visit?: (item: LogItem) => boolean | void): Promise<Log | undefined> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { items: [] }
  const decoder = new TextDecoder()
  const state = { buffer: "", items: [] as LogItem[], cursor: undefined as number | undefined, stopped: false }
  const take = (block: string) => {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    const item = payload === "" ? undefined : Option.getOrUndefined(decodeItem(payload))
    if (item === undefined) return
    state.items.push(item)
    const seq = sequence(item)
    if (seq !== undefined) state.cursor = Math.max(state.cursor ?? seq, seq)
    if (visit?.(item) === false) state.stopped = true
  }
  // A followed log can run for minutes: read chunk by chunk, keeping only the unfinished event.
  while (!state.stopped) {
    const chunk = await reader.read().catch(() => undefined)
    // Broken off (timeout, abort, a closed connection): what was read stands, and `cursor` resumes it.
    if (chunk === undefined)
      return state.items.length === 0
        ? undefined
        : { items: state.items, ...(state.cursor === undefined ? {} : { cursor: state.cursor }), interrupted: true }
    if (chunk.done) {
      take(state.buffer + decoder.decode())
      break
    }
    state.buffer += decoder.decode(chunk.value, { stream: true })
    const blocks = state.buffer.split(/\r?\n\r?\n/)
    state.buffer = blocks.pop() ?? ""
    blocks.forEach((block) => {
      if (!state.stopped) take(block)
    })
  }
  if (state.stopped) await reader.cancel().catch(() => {})
  return { items: state.items, ...(state.cursor === undefined ? {} : { cursor: state.cursor }) }
}

const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

const Sequenced = Schema.Union([
  Schema.Struct({ durable: Schema.Struct({ seq: Schema.Int }) }),
  Schema.Struct({ seq: Schema.Int }),
])
const decodeSequenced = Schema.decodeUnknownOption(Sequenced)

/** A durable item's `durable.seq`, or the `seq` of the `log.synced` marker. */
function sequence(item: LogItem) {
  const decoded = Option.getOrUndefined(decodeSequenced(item))
  if (decoded === undefined) return undefined
  return "durable" in decoded ? decoded.durable.seq : decoded.seq
}

function fail(status: number | null, type: string, message: string) {
  return { ok: false as const, status, type, message }
}

const ErrorBody = Schema.Struct({
  _tag: optional(Schema.String),
  name: optional(Schema.String),
  type: optional(Schema.String),
  message: optional(Schema.String),
  data: optional(Schema.Unknown),
})
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)

/**
 * A failed answer: an RPC error (`RpcError`, `RpcInternalError`) by its declared `type`, any other by its tag
 * (`{_tag}` of HttpApi errors, `{name}` of schema errors, else `{type}`), else `http_<status>`.
 */
function failure(response: Response, body: unknown): Result<never> {
  const error = Option.getOrUndefined(decodeErrorBody(body))
  const rpc = error?._tag === "RpcError" || error?._tag === "RpcInternalError"
  const type = (rpc ? error?.type : (error?._tag ?? error?.name ?? error?.type)) ?? `http_${response.status}`
  const nested = Option.getOrUndefined(decodeNested(error?.data))
  const message = error?.message ?? nested?.message ?? response.statusText
  return {
    ok: false,
    status: response.status,
    type,
    message,
    ...(rpc && error?.data !== undefined ? { data: error.data } : {}),
  }
}

const decodeNested = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))
