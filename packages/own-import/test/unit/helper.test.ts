import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { OwnImport } from "@own/protocol/rpc-import"
import { ServiceTarget } from "@own/runtime"
import { Effect, Schema } from "effect"
import { SelfHttp } from "../../src/http.js"
import { Helper } from "../../src/migrate/helper.js"
import { Store } from "../../src/render/store.js"
import type { Transcript } from "../../src/transcript/ir.js"

/**
 * The hidden helper session (09 §4.4, IG8 unit) against a fake loopback service: H is imported archived with the
 * helper metadata, the target model and the chosen folder; one manual compaction is admitted and never repeated; the
 * followed log or H's compaction messages (`end: "messages"`) give the summary or the cause of the failure; H is
 * interrupted and removed in every outcome; the activation cleanup removes leftover helpers only. Conversations are
 * synthetic IR built here (09 §7.3).
 */

const PASSWORD = "fake-own-import-service-password"
const DIRECTORY = "C:\\work\\proj"
const T0 = Date.UTC(2026, 9, 8, 9)
const NOW = T0 + 7_200_000
const TARGET = { providerID: "own-codex-1", id: "gpt-6" }
const SUMMARIZER = { providerID: "own-codex-1", id: "gpt-6-mini" }
const JOB = OwnImport.JobID.make("job_0123456789helper")
const TOKENS = { input: 9_000, output: 700, reasoning: 0, cache: { read: 0, write: 0 } }

type Item = Readonly<Record<string, unknown>>

const decodeImported = Schema.decodeUnknownSync(
  Schema.Struct({
    info: Schema.Record(Schema.String, Schema.Unknown),
    messages: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

// ---------------------------------------------------------------------------------------------------------------
// A synthetic conversation: four turns with a tool call each and a foreign checkpoint inside turn 1

function turn(index: number): Transcript.Turn {
  const at = T0 + index * 100
  return {
    index,
    time: at,
    user: { text: `request ${index}`, images: [] },
    steps: [
      {
        type: "tool",
        name: "exec_command",
        input: { cmd: "bun test" },
        output: { text: "3 pass", error: false },
        exit: 0,
        time: at + 1,
      },
      { type: "text", text: `answer ${index}`, time: at + 2, model: "gpt-5.5" },
    ],
    end: "completed",
  }
}

const TRANSCRIPT: Transcript.Info = {
  source: {
    kind: "codex",
    id: "019a0000-0000-7000-8000-000000000001",
    rootID: "codex-0123456789ab",
    path: "C:\\fixture\\codex\\sessions\\2026\\10\\08\\rollout-x.jsonl",
    versions: ["0.153.0"],
    cwds: [DIRECTORY],
    title: "설치기 정리",
    models: [{ provider: "openai", id: "gpt-5.5" }],
    createdAt: T0,
    updatedAt: T0 + 99_000,
    bytes: 4096,
    subagent: false,
    live: false,
  },
  turns: [turn(0), turn(1), turn(2), turn(3)],
  checkpoints: [
    {
      at: { turn: 1, step: 1, source: { ordinal: 7 } },
      kind: "foreign",
      summary: "The tool's summary up to 1.1.",
      recent: [{ role: "user", text: "request 1" }],
    },
  ],
  children: [],
  dropped: {},
}

// ---------------------------------------------------------------------------------------------------------------
// The fake service: import, a followed session log (server-sent events), a session's compaction messages and the
// session list

interface Seen {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly body?: unknown
}

const servers: Array<{ stop(): void }> = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop())
})

function fake(options: { readonly importDelay?: number; readonly importStatus?: number } = {}) {
  const requests: Seen[] = []
  const timeline: string[] = []
  const logs = new Map<string, Item[]>()
  const live = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()
  // A session's compaction messages, oldest first: the ones it was imported with, then core's (replaced by id).
  const compactions = new Map<string, Item[]>()
  const listed: Item[] = []
  const encoder = new TextEncoder()
  const frame = (item: Item) => encoder.encode(`data: ${JSON.stringify(item)}\n\n`)

  const push = (sessionID: string, type: string, data: Item = {}) => {
    const list = logs.get(sessionID)
    if (list === undefined) return
    const item = {
      id: `evt_${sessionID}_${list.length}`,
      type,
      created: NOW,
      data: { sessionID, ...data },
      durable: { aggregateID: sessionID, seq: list.length, version: 1 },
    }
    list.push(item)
    live.get(sessionID)?.forEach((controller) => controller.enqueue(frame(item)))
  }

  const log = (sessionID: string, url: URL) => {
    const list = logs.get(sessionID)
    if (list === undefined)
      return Response.json({ _tag: "SessionNotFoundError", message: "Session not found" }, { status: 404 })
    const after = Number(url.searchParams.get("after") ?? "-1")
    const follow = url.searchParams.get("follow") === "true"
    const holder: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // An item's seq is its index in the list.
          list.slice(after + 1).forEach((item) => controller.enqueue(frame(item)))
          controller.enqueue(frame({ type: "log.synced", aggregateID: sessionID, seq: list.length - 1 }))
          if (!follow) return controller.close()
          holder.controller = controller
          live.set(sessionID, (live.get(sessionID) ?? new Set()).add(controller))
        },
        cancel() {
          if (holder.controller) live.get(sessionID)?.delete(holder.controller)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...(text === "" ? {} : { body: JSON.parse(text) }),
      })
      if (request.headers.get("authorization") !== ServiceTarget.basic(PASSWORD))
        return Response.json({ _tag: "UnauthorizedError", message: "no" }, { status: 401 })
      if (request.method === "POST" && url.pathname === "/api/experimental/session/import") {
        timeline.push("import")
        if (options.importDelay) await Bun.sleep(options.importDelay)
        if (options.importStatus)
          return Response.json({ _tag: "BadRequest", message: "no" }, { status: options.importStatus })
        const body = decodeImported(JSON.parse(text))
        const id = String(body.info.id)
        logs.set(id, [])
        // The checkpoints H was imported with: never this summary's end.
        compactions.set(
          id,
          body.messages.filter((message) => message.type === "compaction"),
        )
        push(id, "session.created", { metadata: body.info.metadata })
        timeline.push("imported")
        return Response.json({ data: body.info })
      }
      const match = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(url.pathname)
      if (request.method === "GET" && match) return log(match[1], url)
      const messages = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
      if (request.method === "GET" && messages) {
        const list = compactions.get(messages[1])
        if (list === undefined)
          return Response.json({ _tag: "SessionNotFoundError", message: "Session not found" }, { status: 404 })
        return Response.json({ data: list.toReversed() })
      }
      // H's context starts with its newest compaction, whose kept text core rebuilds into `metadata.recent`.
      const context = /^\/api\/session\/([^/]+)\/context$/.exec(url.pathname)
      if (request.method === "GET" && context) {
        const newest = compactions.get(context[1])?.at(-1)
        if (newest === undefined) return Response.json({ data: [] })
        const keepID = (newest.metadata as { keepID?: string } | undefined)?.keepID
        return Response.json({ data: [keepID === undefined ? newest : { ...newest, metadata: { recent: KEPT } }] })
      }
      if (request.method === "GET" && url.pathname === "/api/session")
        return Response.json({ data: listed.filter((item) => logs.has(String(item.id))), cursor: {} })
      return Response.json({ _tag: "NotFound", message: "no route" }, { status: 404 })
    },
  })
  servers.push({ stop: () => server.stop(true) })
  const drop = (sessionID: string) => {
    push(sessionID, "session.deleted")
    logs.delete(sessionID)
    compactions.delete(sessionID)
  }
  /** Adds core's compaction message to the session, or replaces the one with its id. */
  const compacted = (sessionID: string, message: Item) => {
    const list = compactions.get(sessionID)
    if (list === undefined) return
    const at = list.findIndex((item) => item.id === message.id)
    // A new id goes at the end: deleting past the end removes nothing.
    list.splice(at < 0 ? list.length : at, 1, message)
  }
  return {
    requests,
    timeline,
    logs,
    listed,
    push,
    drop,
    compacted,
    client: SelfHttp.create({
      source: SelfHttp.source({
        service: { url: `http://127.0.0.1:${server.port}`, password: PASSWORD },
        channel: "local",
      }),
    }),
  }
}

type Service = ReturnType<typeof fake>

/** `ctx.session` as `Helper.Sessions`: records every call; `compact` runs the script (the core compaction). */
function sessions(service: Service, script: (sessionID: string) => void, admit = true) {
  const calls: Array<readonly [string, string]> = []
  const record = (name: string, sessionID: string) => {
    calls.push([name, sessionID])
    service.timeline.push(name)
  }
  const value: Helper.Sessions = {
    compact: async (sessionID) => {
      record("compact", sessionID)
      if (admit) script(sessionID)
      return admit
    },
    interrupt: async (sessionID) => {
      record("interrupt", sessionID)
      return true
    },
    remove: async (sessionID) => {
      record("remove", sessionID)
      const known = service.logs.has(sessionID)
      if (known) service.drop(sessionID)
      return known
    },
  }
  return { value, calls }
}

/** Core's compaction of H: started, then ended or failed a little later (the log is followed live). */
function compaction(service: Service, end: { readonly type: string; readonly data: Item } | undefined, delay = 30) {
  return (sessionID: string) => {
    setTimeout(() => {
      service.push(sessionID, "session.execution.started")
      service.push(sessionID, "session.compaction.started", { reason: "manual", recent: "" })
      if (end === undefined) return
      setTimeout(() => service.push(sessionID, end.type, end.data), delay)
    }, 5)
  }
}

/**
 * Core's compaction of H as its compaction message (`end: "messages"`): running after `start` ms, then settled as
 * `end` (completed or failed) `delay` ms later; held running when `end` is `undefined`.
 */
function compactionMessage(service: Service, end: Item | undefined, delay = 30, start = 5) {
  return (sessionID: string) => {
    const base = { id: "msg_helpersummary0000000000001", type: "compaction", reason: "manual", time: { created: NOW } }
    setTimeout(() => {
      service.compacted(sessionID, { ...base, status: "running", summary: "", recent: "" })
      if (end === undefined) return
      setTimeout(() => service.compacted(sessionID, { ...base, ...end }), delay)
    }, start)
  }
}

/** The kept messages' text core rebuilds from a compaction's `metadata.keepID` (`SessionRecentText`, history). */
const KEPT = "[User]: request 2"

/** A completed compaction as core stores it since upstream v2.1: where its kept messages start, not their text. */
const COMPLETED = {
  status: "completed",
  model: SUMMARIZER,
  summary: "S: what happened before",
  metadata: { keepID: "msg_kept00000000000000000001" },
  cost: 0.12,
  tokens: TOKENS,
}

const ENDED = {
  type: "session.compaction.ended",
  data: {
    reason: "manual",
    model: SUMMARIZER,
    text: "S: what happened before",
    recent: "[User]: request 2",
    cost: 0.12,
    tokens: TOKENS,
  },
}

function input(
  service: Service,
  calls: Helper.Sessions,
  more: Partial<Helper.SummarizeInput> = {},
): Helper.SummarizeInput {
  return {
    http: service.client,
    sessions: calls,
    transcript: TRANSCRIPT,
    upToTurn: 3,
    tail: { turn: 3 },
    target: TARGET,
    jobID: JOB,
    sessionID: SessionID.make("ses_helper000000000000000001"),
    projectID: "prj_fixture",
    directory: DIRECTORY,
    redact: true,
    now: NOW,
    signal: new AbortController().signal,
    ...more,
  }
}

const HELPER = "ses_helper000000000000000001"

describe("summarize (09 §4.4, IG8)", () => {
  test("H: archived, helper metadata, the target, the chosen folder and the IMP.14 helper content; one compaction; the summary; H removed", async () => {
    const service = fake()
    const fakeSessions = sessions(service, (id) => compaction(service, ENDED)(id))
    const result = await Helper.summarize(input(service, fakeSessions.value))
    expect(result).toEqual({
      ok: true,
      summary: { text: ENDED.data.text, recent: ENDED.data.recent, model: SUMMARIZER, cost: 0.12, tokens: TOKENS },
    })
    const sent = service.requests.find((request) => request.path === "/api/experimental/session/import")
    expect(sent?.query).toEqual({ "location[directory]": DIRECTORY })
    const expected = Schema.encodeSync(SessionTransfer.Data)(
      Schema.decodeUnknownSync(SessionTransfer.Data)(
        Store.helper({
          transcript: TRANSCRIPT,
          upToTurn: 3,
          tail: { turn: 3 },
          model: TARGET,
          jobID: JOB,
          sessionID: HELPER,
          projectID: "prj_fixture",
          location: { directory: DIRECTORY },
          archivedAt: NOW,
          redact: true,
        }).data,
      ),
    )
    expect(sent?.body).toEqual({ ...expected, location: { directory: DIRECTORY } })
    expect(sent?.body).toMatchObject({
      info: {
        id: HELPER,
        model: TARGET,
        time: { archived: NOW },
        metadata: { "own.import": { v: 1, helper: true, jobID: JOB } },
      },
    })
    // The last foreign checkpoint before the tail opens H (09 §4.4 1).
    expect(expected.messages[0]).toMatchObject({ type: "compaction", summary: "The tool's summary up to 1.1." })
    const follow = service.requests.find((request) => request.path.endsWith("/log"))
    expect(follow?.query).toEqual({ follow: "true", "location[directory]": DIRECTORY })
    expect(fakeSessions.calls).toEqual([
      ["compact", HELPER],
      ["interrupt", HELPER],
      ["remove", HELPER],
    ])
    expect(service.logs.has(HELPER)).toBe(false)
  })

  test("without a model in the log the target is the summary's model", async () => {
    const service = fake()
    const ended = { type: ENDED.type, data: { reason: "manual", text: "S", recent: "" } }
    const fakeSessions = sessions(service, (id) => compaction(service, ended)(id))
    expect(await Helper.summarize(input(service, fakeSessions.value))).toEqual({
      ok: true,
      summary: { text: "S", recent: "", model: TARGET },
    })
  })

  test("a failed compaction is summary_failed with its cause: compacted once, never again, nothing else asked (IG9)", async () => {
    const service = fake()
    const failed = {
      type: "session.compaction.failed",
      data: { reason: "manual", error: { type: "provider.quota", message: "usage limit reached", status: 429 } },
    }
    const fakeSessions = sessions(service, (id) => compaction(service, failed)(id))
    expect(await Helper.summarize(input(service, fakeSessions.value))).toEqual({
      ok: false,
      error: "summary_failed",
      cause: "exhausted",
    })
    expect(fakeSessions.calls.filter((call) => call[0] === "compact")).toHaveLength(1)
    expect(fakeSessions.calls.at(-1)).toEqual(["remove", HELPER])
    expect(service.requests.filter((request) => request.path === "/api/experimental/session/import")).toHaveLength(1)
  })

  test("a run that ends without settling the compaction ends the wait with its cause", async () => {
    const cases: ReadonlyArray<readonly [{ readonly type: string; readonly data: Item }, OwnImport.SummaryFailure]> = [
      [
        { type: "session.execution.failed", data: { error: { type: "provider.auth", message: "expired" } } },
        "needs_reauth",
      ],
      [{ type: "session.execution.interrupted", data: { reason: "shutdown" } }, "interrupted"],
      [{ type: "session.execution.succeeded", data: {} }, "other"],
      // A native compaction answers provider context and no summary text.
      [{ type: ENDED.type, data: { reason: "manual", text: "", recent: "", providerContext: {} } }, "other"],
    ]
    for (const [end, cause] of cases) {
      const service = fake()
      const fakeSessions = sessions(service, (id) => compaction(service, end)(id))
      expect(await Helper.summarize(input(service, fakeSessions.value))).toEqual({
        ok: false,
        error: "summary_failed",
        cause,
      })
      expect(fakeSessions.calls.at(-1)).toEqual(["remove", HELPER])
    }
  })

  test("a followed read that runs out of time reads on from its cursor", async () => {
    const service = fake()
    const fakeSessions = sessions(service, (id) => compaction(service, ENDED, 700)(id))
    const result = await Helper.summarize(input(service, fakeSessions.value, { followMs: 250 }))
    expect(result.ok).toBe(true)
    const reads = service.requests.filter((request) => request.path.endsWith("/log"))
    expect(reads.length).toBeGreaterThan(1)
    expect(reads[0]?.query.after).toBeUndefined()
    expect(Number(reads[1]?.query.after)).toBeGreaterThanOrEqual(0)
  })

  test("a refused compaction, a refused import and H gone from the log", async () => {
    const refused = fake()
    const notAdmitted = sessions(refused, () => undefined, false)
    expect(await Helper.summarize(input(refused, notAdmitted.value))).toEqual({
      ok: false,
      error: "summary_failed",
      cause: "other",
    })
    expect(notAdmitted.calls.map((call) => call[0])).toEqual(["compact", "interrupt", "remove"])

    const rejected = fake({ importStatus: 400 })
    const never = sessions(rejected, () => undefined)
    expect(await Helper.summarize(input(rejected, never.value))).toEqual({ ok: false, error: "internal_error" })
    expect(never.calls.map((call) => call[0])).toEqual(["interrupt", "remove"])

    const gone = fake()
    const removedElsewhere = sessions(gone, (id) => gone.drop(id))
    expect(await Helper.summarize(input(gone, removedElsewhere.value))).toEqual({
      ok: false,
      error: "summary_failed",
      cause: "interrupted",
    })
  })

  test("an unreachable service is service_unreachable; H's removal is still asked", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const url = `http://127.0.0.1:${closed.port}`
    closed.stop(true)
    const service = fake()
    const fakeSessions = sessions(service, () => undefined)
    const client = SelfHttp.create({
      source: SelfHttp.source({ service: { url, password: PASSWORD }, channel: "local" }),
    })
    expect(await Helper.summarize(input(service, fakeSessions.value, { http: client }))).toEqual({
      ok: false,
      error: "service_unreachable",
    })
    expect(fakeSessions.calls.map((call) => call[0])).toEqual(["interrupt", "remove"])
  })
})

describe("the compaction messages (end: messages, the service's way)", () => {
  const reads = (service: Service) =>
    service.requests.filter((request) => request.path === `/api/session/${HELPER}/message`)

  test("H's own compaction gives the summary, never the checkpoint H was imported with; the log is not followed", async () => {
    const service = fake()
    // Core's compaction shows up only after the first read, which sees the imported checkpoint alone.
    const fakeSessions = sessions(service, (id) => compactionMessage(service, COMPLETED, 30, 300)(id))
    expect(await Helper.summarize(input(service, fakeSessions.value, { end: "messages" }))).toEqual({
      ok: true,
      summary: { text: COMPLETED.summary, recent: KEPT, model: SUMMARIZER, cost: 0.12, tokens: TOKENS },
    })
    // The kept text comes from H's context, where core rebuilds it.
    expect(service.requests.some((request) => request.path === `/api/session/${HELPER}/context`)).toBe(true)
    // H opened with the tool's checkpoint (a completed compaction) before core's own appeared.
    const sent = service.requests.find((request) => request.path === "/api/experimental/session/import")
    expect(sent?.body).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ type: "compaction", status: "completed" })]),
    })
    expect(reads(service).length).toBeGreaterThan(1)
    expect(reads(service)[0]?.query).toEqual({
      type: "compaction",
      order: "desc",
      limit: "20",
      "location[directory]": DIRECTORY,
    })
    expect(service.requests.some((request) => request.path.endsWith("/log"))).toBe(false)
    expect(fakeSessions.calls).toEqual([
      ["compact", HELPER],
      ["interrupt", HELPER],
      ["remove", HELPER],
    ])
  })

  test("without a model the target is the summary's model; a running compaction is read again until it settles", async () => {
    const service = fake()
    const settled = { status: "completed", summary: "S", recent: "" }
    const fakeSessions = sessions(service, (id) => compactionMessage(service, settled, Helper.POLL_MS + 200)(id))
    expect(await Helper.summarize(input(service, fakeSessions.value, { end: "messages" }))).toEqual({
      ok: true,
      summary: { text: "S", recent: "", model: TARGET },
    })
    expect(reads(service).length).toBeGreaterThan(1)
  })

  test("a failed compaction is summary_failed with its cause, compacted once (IG9); empty summary text is other", async () => {
    const cases: ReadonlyArray<readonly [Item, OwnImport.SummaryFailure]> = [
      [
        { status: "failed", error: { type: "provider.quota", message: "usage limit reached", status: 429 } },
        "exhausted",
      ],
      [{ status: "failed", error: { type: "provider.auth", message: "expired", status: 401 } }, "needs_reauth"],
      [{ status: "failed", error: { type: "compaction.interrupted", message: "interrupted" } }, "interrupted"],
      // A native compaction keeps provider context and no summary text.
      [{ status: "completed", summary: "", recent: "" }, "other"],
    ]
    for (const [end, cause] of cases) {
      const service = fake()
      const fakeSessions = sessions(service, (id) => compactionMessage(service, end)(id))
      expect(await Helper.summarize(input(service, fakeSessions.value, { end: "messages" }))).toEqual({
        ok: false,
        error: "summary_failed",
        cause,
      })
      expect(fakeSessions.calls.filter((call) => call[0] === "compact")).toHaveLength(1)
      expect(fakeSessions.calls.at(-1)).toEqual(["remove", HELPER])
    }
  })

  test("H gone (404, the activation cleanup removed it) is interrupted", async () => {
    const service = fake()
    const fakeSessions = sessions(service, (id) => service.drop(id))
    expect(await Helper.summarize(input(service, fakeSessions.value, { end: "messages" }))).toEqual({
      ok: false,
      error: "summary_failed",
      cause: "interrupted",
    })
  })

  test("no compaction of H's own within ADMIT_MS of the admission fails the summary as other", async () => {
    const service = fake()
    // Core admitted the compaction but never starts it; the clock jumps past the admission window after the first read.
    const fakeSessions = sessions(service, () => {
      setTimeout(() => setSystemTime(new Date(Date.now() + Helper.ADMIT_MS + 60_000)), 50)
    })
    try {
      expect(await Helper.summarize(input(service, fakeSessions.value, { end: "messages" }))).toEqual({
        ok: false,
        error: "summary_failed",
        cause: "other",
      })
    } finally {
      setSystemTime()
    }
    expect(fakeSessions.calls.map((call) => call[0])).toEqual(["compact", "interrupt", "remove"])
  })

  test("a compaction of H's own that never settles fails as other after SUMMARY_MS, and H goes", async () => {
    const service = fake()
    // Core started the summary but never settles it; the clock jumps past the summary's deadline after a read.
    const fakeSessions = sessions(service, (id) => {
      compactionMessage(service, undefined)(id)
      setTimeout(() => setSystemTime(new Date(Date.now() + Helper.SUMMARY_MS + 60_000)), 50)
    })
    try {
      expect(await Helper.summarize(input(service, fakeSessions.value, { end: "messages" }))).toEqual({
        ok: false,
        error: "summary_failed",
        cause: "other",
      })
    } finally {
      setSystemTime()
    }
    expect(fakeSessions.calls.map((call) => call[0])).toEqual(["compact", "interrupt", "remove"])
  })

  test("a cancel while it reads: H is interrupted and removed and the answer is cancelled", async () => {
    const service = fake()
    const abort = new AbortController()
    const fakeSessions = sessions(service, (id) => {
      compactionMessage(service, undefined)(id)
      setTimeout(() => abort.abort(), 100)
    })
    const begun = Date.now()
    expect(
      await Helper.summarize(input(service, fakeSessions.value, { end: "messages", signal: abort.signal })),
    ).toEqual({ ok: false, error: "cancelled" })
    expect(Date.now() - begun).toBeLessThan(5_000)
    expect(fakeSessions.calls).toEqual([
      ["compact", HELPER],
      ["interrupt", HELPER],
      ["remove", HELPER],
    ])
    expect(service.logs.has(HELPER)).toBe(false)
  })
})

describe("cancel (09 §4.8)", () => {
  test("while the compaction runs: H is interrupted and removed and the answer is cancelled", async () => {
    const service = fake()
    const abort = new AbortController()
    const fakeSessions = sessions(service, (id) => {
      compaction(service, undefined)(id)
      setTimeout(() => abort.abort(), 100)
    })
    const begun = Date.now()
    expect(await Helper.summarize(input(service, fakeSessions.value, { signal: abort.signal }))).toEqual({
      ok: false,
      error: "cancelled",
    })
    expect(Date.now() - begun).toBeLessThan(5_000)
    expect(fakeSessions.calls).toEqual([
      ["compact", HELPER],
      ["interrupt", HELPER],
      ["remove", HELPER],
    ])
    expect(service.logs.has(HELPER)).toBe(false)
  })

  test("during the import: the import settles, nothing is compacted, then H is removed", async () => {
    const service = fake({ importDelay: 200 })
    const abort = new AbortController()
    const fakeSessions = sessions(service, (id) => compaction(service, ENDED)(id))
    setTimeout(() => abort.abort(), 50)
    expect(await Helper.summarize(input(service, fakeSessions.value, { signal: abort.signal }))).toEqual({
      ok: false,
      error: "cancelled",
    })
    expect(service.timeline).toEqual(["import", "imported", "interrupt", "remove"])
    expect(service.logs.has(HELPER)).toBe(false)
  })
})

describe("cause (09 §4.8 summary_failed)", () => {
  test("core's session errors map to the declared causes", () => {
    const table: ReadonlyArray<readonly [Parameters<typeof Helper.cause>[0], OwnImport.SummaryFailure]> = [
      [{ type: "provider.quota", message: "quota" }, "exhausted"],
      [{ type: "provider.rate-limit", message: "usage limit reached", status: 429 }, "exhausted"],
      [{ type: "provider.auth", message: "token expired", status: 401 }, "needs_reauth"],
      [{ type: "aborted", message: "Compaction cancelled" }, "interrupted"],
      [{ type: "compaction.interrupted", message: "Compaction was interrupted" }, "interrupted"],
      [
        {
          type: "compaction.failed",
          message: "The compaction request cannot be reduced further without losing the latest exchange or checkpoint",
        },
        "overflow",
      ],
      [
        { type: "provider.invalid-request", message: "maximum context length is 272000 tokens", status: 400 },
        "overflow",
      ],
      [{ type: "provider.invalid-request", message: "payload", status: 413 }, "overflow"],
      [{ type: "provider.invalid-request", message: "unknown parameter", status: 400 }, "other"],
      [{ type: "compaction.failed", message: "Error: boom" }, "other"],
      [{ type: "provider.transport", message: "socket hang up" }, "other"],
      [{ type: "unknown", message: "?" }, "other"],
    ]
    for (const [error, cause] of table) expect([error.type, Helper.cause(error)]).toEqual([error.type, cause])
  })
})

describe("cleanup (09 §4.4 남은 보조 세션 정리)", () => {
  const view = (id: string, metadata?: Item, archived?: number) => ({
    id,
    projectID: "prj_fixture",
    location: { directory: DIRECTORY },
    time: { created: T0, updated: T0, ...(archived === undefined ? {} : { archived }) },
    ...(metadata === undefined ? {} : { metadata }),
  })
  const imported = {
    v: 1,
    kind: "codex",
    sourceID: "019a0000-0000-7000-8000-000000000001",
    root: "codex-0123456789ab",
    path: "C:\\fixture\\rollout-x.jsonl",
    title: "t",
    cwd: DIRECTORY,
    models: [],
    versions: [],
    sourceUpdatedAt: T0,
    sourceBytes: 1,
    turns: 1,
    contentHash: "0".repeat(64),
    mode: "full",
    checkpoint: null,
    storedFull: true,
    redactions: 0,
    dropped: {},
    importedAt: T0,
  }

  test("removes the helpers (archived ones too) and nothing else; spares the running job's; idempotent", async () => {
    const service = fake()
    const rows = [
      view("ses_helperold00000000000001", { "own.import": { v: 1, helper: true, jobID: "job_old1" } }, T0),
      view("ses_helperold00000000000002", { "own.import": { v: 1, helper: true, jobID: "job_old2" } }),
      view("ses_helperrun00000000000001", { "own.import": { v: 1, helper: true, jobID: "job_running" } }, T0),
      view("ses_imported000000000000001", { "own.import": imported }),
      view("ses_plain00000000000000001"),
      // Marked, but not a helper's shape: never removed.
      view("ses_odd0000000000000000001", { "own.import": { v: 1, helper: true } }),
    ]
    rows.forEach((row) => {
      service.listed.push(row)
      service.logs.set(row.id, [])
    })
    const fakeSessions = sessions(service, () => undefined)
    expect(await Helper.cleanup({ http: service.client, sessions: fakeSessions.value, keep: "job_running" })).toEqual({
      ok: true,
      found: 2,
      removed: 2,
    })
    expect(fakeSessions.calls.toSorted()).toEqual([
      ["interrupt", "ses_helperold00000000000001"],
      ["interrupt", "ses_helperold00000000000002"],
      ["remove", "ses_helperold00000000000001"],
      ["remove", "ses_helperold00000000000002"],
    ])
    expect(service.requests.find((request) => request.path === "/api/session")?.query).toMatchObject({
      parentID: "null",
    })
    expect(await Helper.cleanup({ http: service.client, sessions: fakeSessions.value, keep: "job_running" })).toEqual({
      ok: true,
      found: 0,
      removed: 0,
    })
  })

  test("an unreachable service removes nothing", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const url = `http://127.0.0.1:${closed.port}`
    closed.stop(true)
    const client = SelfHttp.create({
      source: SelfHttp.source({ service: { url, password: PASSWORD }, channel: "local" }),
    })
    const service = fake()
    const fakeSessions = sessions(service, () => undefined)
    expect(await Helper.cleanup({ http: client, sessions: fakeSessions.value })).toEqual({
      ok: false,
      error: "service_unreachable",
    })
    expect(fakeSessions.calls).toEqual([])
  })
})

describe("sessions over ctx.session", () => {
  test("success is true; a failure, a defect or a throw is false; interrupt never resumes", async () => {
    const seen: unknown[] = []
    const admitted = Schema.decodeUnknownSync(SessionInbox.Compaction)({
      id: "msg_0000000000000000000000001",
      sessionID: HELPER,
      time: { created: NOW },
      type: "compaction",
      payload: {},
      delivery: "steer",
    })
    const adapter = Helper.sessions({
      compact: (request) => {
        seen.push(["compact", request])
        return request.sessionID === HELPER ? Effect.succeed(admitted) : Effect.fail(new Error("conflict"))
      },
      interrupt: (request) => {
        seen.push(["interrupt", request])
        return Effect.succeed({ interrupted: true })
      },
      remove: (request) => {
        if (request.sessionID === HELPER) return Effect.die("defect")
        throw new Error("thrown")
      },
    })
    const other = SessionID.make("ses_other00000000000000001")
    expect(await adapter.compact(SessionID.make(HELPER))).toBe(true)
    expect(await adapter.compact(other)).toBe(false)
    expect(await adapter.interrupt(SessionID.make(HELPER))).toBe(true)
    expect(await adapter.remove(SessionID.make(HELPER))).toBe(false)
    expect(await adapter.remove(other)).toBe(false)
    expect(seen).toEqual([
      ["compact", { sessionID: HELPER }],
      ["compact", { sessionID: other }],
      ["interrupt", { sessionID: HELPER, resume: false }],
    ])
  })
})
