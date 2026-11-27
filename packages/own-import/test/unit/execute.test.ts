import { describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import type { SelfHttp } from "../../src/http.js"
import { Execute } from "../../src/migrate/execute.js"
import type { Fill } from "../../src/migrate/fill.js"
import type { Helper } from "../../src/migrate/helper.js"
import { Store } from "../../src/render/store.js"
import { Brief } from "../../src/transcript/brief.js"
import { Transcript } from "../../src/transcript/ir.js"

/**
 * The migration job (09 §4.4, §4.8, §5.2; IG8 and IG9 unit) against an in-memory service: one job at a time, the
 * source read again and its planned turns checked, the summary in the helper session (removed before the final
 * import), the final import of the chosen mode, cancel before and after the final import, failures without retries or
 * another account, and the activation cleanup sparing the running job. Conversations are synthetic IR (09 §7.3).
 */

const DIRECTORY = "C:\\work\\proj"
const T0 = Date.UTC(2026, 9, 8, 9)
const NOW = T0 + 7_200_000
const TARGET = { providerID: "own-codex-1", id: "gpt-6" }
const SUMMARIZER = { providerID: "own-codex-1", id: "gpt-6-mini" }
const TOKENS = { input: 9_000, output: 700, reasoning: 0, cache: { read: 0, write: 0 } }
const REF = Schema.decodeUnknownSync(OwnImport.SourceRef)({
  kind: "codex",
  rootID: "codex-0123456789ab",
  id: "019a0000-0000-7000-8000-000000000001",
})

const decode = Schema.decodeUnknownSync(SessionTransfer.Data)
const encode = Schema.encodeSync(SessionTransfer.Data)

// ---------------------------------------------------------------------------------------------------------------
// Synthetic conversations

function turn(index: number, request = `request ${index}`): Transcript.Turn {
  const at = T0 + index * 100
  return {
    index,
    time: at,
    user: { text: request, images: [] },
    steps: [
      {
        type: "tool",
        name: "exec_command",
        input: { cmd: `bun test ${index}` },
        output: { text: "3 pass", error: false },
        exit: 0,
        time: at + 1,
      },
      { type: "text", text: `answer ${index}`, time: at + 2, model: "gpt-5.5" },
    ],
    end: "completed",
  }
}

function transcript(
  turns: ReadonlyArray<Transcript.Turn>,
  checkpoints: ReadonlyArray<Transcript.Checkpoint> = [],
): Transcript.Info {
  return {
    source: {
      kind: "codex",
      id: REF.id,
      rootID: REF.rootID,
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
    turns: [...turns],
    checkpoints: [...checkpoints],
    children: [],
    dropped: {},
  }
}

const FOUR = transcript([turn(0), turn(1), turn(2), turn(3)])
const FOREIGN: Transcript.Checkpoint = {
  at: { turn: 1, step: 1, source: { ordinal: 7 } },
  kind: "foreign",
  summary: "The tool's summary up to 1.1.",
  recent: [{ role: "user", text: "request 1" }],
}

const NONE: Execute.Run = { mode: "full", boundary: { type: "none" } }
const LLM: Execute.Run = { mode: "summary", source: "llm", tail: { turn: 2 } }

/** The plan's order for `info` (all of its turns). */
function order(info: Transcript.Info, run: Execute.Run, more: Partial<Execute.Order> = {}): Execute.Order {
  return {
    ref: REF,
    location: DIRECTORY,
    projectID: "prj_fixture",
    turns: info.turns.length,
    contentHash: Transcript.contentHash(info.turns),
    run,
    target: TARGET,
    images: false,
    storeFull: true,
    redact: true,
    ...more,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The in-memory service: import, a followed session log, a session's compaction messages, the session list and
// ctx.session

type End = { readonly type: string; readonly data: Readonly<Record<string, unknown>> }

const decodeCompaction = Schema.decodeUnknownSync(SessionMessage.Compaction)

/** The kept messages' text core rebuilds from a compaction's `metadata.keepID` (`SessionRecentText`, history). */
const KEPT = "[User]: request 1"

/**
 * The compaction message core projects for a settled compaction: what `end: "messages"` reads. Since upstream v2.1 a
 * completed one stores where its kept messages start (`metadata.keepID`), not their text.
 */
const projected = (end: End) =>
  decodeCompaction({
    id: "msg_helpersummary0000000000001",
    type: "compaction",
    time: { created: NOW },
    ...end.data,
    status: end.type === "session.compaction.ended" ? "completed" : "failed",
    summary: end.data.text,
    ...(end.type === "session.compaction.ended" ? { metadata: { keepID: "msg_kept00000000000000000001" } } : {}),
  })

const ENDED: End = {
  type: "session.compaction.ended",
  data: {
    reason: "manual",
    model: SUMMARIZER,
    text: "S: what happened before",
    cost: 0.12,
    tokens: TOKENS,
  },
}

function memory(options: { readonly importDelay?: number; readonly unreachable?: boolean } = {}) {
  const imports: SessionTransfer.Data[] = []
  const logs = new Map<string, SelfHttp.LogItem[]>()
  const compactions = new Map<string, SessionMessage.Compaction[]>()
  // The sessions whose log was followed.
  const followed: string[] = []
  const wakers = new Map<string, Set<() => void>>()
  const listed: SelfHttp.SessionView[] = []
  const timeline: string[] = []
  const compacted: SessionID[] = []

  const wake = (sessionID: string) => wakers.get(sessionID)?.forEach((resume) => resume())
  const push = (sessionID: string, type: string, data: Readonly<Record<string, unknown>> = {}) => {
    const list = logs.get(sessionID)
    if (list === undefined) return
    list.push({ type, data: { sessionID, ...data }, durable: { aggregateID: sessionID, seq: list.length, version: 1 } })
    wake(sessionID)
  }
  const wait = (sessionID: string, signal?: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted) return resolve(false)
      const set = wakers.get(sessionID) ?? new Set<() => void>()
      wakers.set(sessionID, set)
      const resume = () => {
        set.delete(resume)
        resolve(true)
      }
      set.add(resume)
      signal?.addEventListener("abort", () => {
        set.delete(resume)
        resolve(false)
      })
    })

  type LogInput = Parameters<SelfHttp.Client["session"]["log"]>[0]
  const follow = async (
    input: LogInput,
    signal: AbortSignal | undefined,
    after: number,
    items: SelfHttp.LogItem[],
  ): Promise<SelfHttp.Result<SelfHttp.Log>> => {
    const list = logs.get(input.sessionID)
    if (list === undefined)
      return items.length === 0
        ? { ok: false, status: 404, type: "SessionNotFoundError", message: "Session not found" }
        : { ok: true, value: { items, cursor: after, interrupted: true } }
    // An item's seq is its index in the list.
    const fresh = list.slice(after + 1)
    const stop = fresh.findIndex((item) => {
      items.push(item)
      return input.visit?.(item) === false
    })
    const cursor = after + (stop < 0 ? fresh.length : stop + 1)
    if (stop >= 0 || !input.follow) return { ok: true, value: { items, cursor } }
    if (!(await wait(input.sessionID, signal))) return { ok: true, value: { items, cursor, interrupted: true } }
    return follow(input, signal, cursor, items)
  }

  const http: Execute.Input["http"] = {
    session: {
      import: async (input) => {
        const marked = OwnImport.decodeMetadata(input.data.info.metadata)
        timeline.push(marked !== undefined && OwnImport.isHelper(marked) ? "import helper" : "import final")
        if (options.importDelay) await Bun.sleep(options.importDelay)
        if (options.unreachable) return { ok: false, status: null, type: "unreachable", message: "no service" }
        imports.push(input.data)
        logs.set(input.data.info.id, [])
        compactions.set(input.data.info.id, [])
        push(input.data.info.id, "session.created")
        const view: SelfHttp.SessionView = {
          id: input.data.info.id,
          projectID: input.data.info.projectID,
          location: { directory: input.directory },
          ...(input.data.info.metadata === undefined ? {} : { metadata: input.data.info.metadata }),
          time: { created: T0, updated: NOW },
        }
        listed.push(view)
        return { ok: true, value: view }
      },
      log: (input, call) => {
        followed.push(input.sessionID)
        return follow(input, call?.signal, input.after ?? -1, [])
      },
      all: async () => ({ ok: true, value: listed.filter((view) => logs.has(view.id)) }),
    },
    message: {
      compactions: async (ref) => {
        const list = compactions.get(ref.sessionID)
        if (list === undefined || !logs.has(ref.sessionID))
          return { ok: false, status: 404, type: "SessionNotFoundError", message: "Session not found" }
        return { ok: true, value: list.toReversed() }
      },
      // H's context starts with its newest compaction, whose kept text core rebuilds into `metadata.recent`.
      context: async (ref) => ({
        ok: true,
        value: (compactions.get(ref.sessionID) ?? [])
          .toReversed()
          .slice(0, 1)
          .map((message) =>
            message.metadata?.keepID === undefined ? message : { ...message, metadata: { recent: KEPT } },
          ),
      }),
    },
  }

  /** `ctx.session`: `compact` starts core's compaction, which ends with `end` (or is held when `undefined`). */
  const sessions = (end: () => End | undefined): Helper.Sessions => ({
    compact: async (sessionID) => {
      timeline.push("compact")
      compacted.push(sessionID)
      setTimeout(() => {
        push(sessionID, "session.compaction.started", { reason: "manual", recent: "" })
        const value = end()
        if (value === undefined) return
        settle(sessionID, value)
      }, 5)
      return true
    },
    interrupt: async () => {
      timeline.push("interrupt")
      return true
    },
    remove: async (sessionID) => {
      timeline.push("remove")
      const known = logs.delete(sessionID)
      wake(sessionID)
      return known
    },
  })

  /** Core settles a compaction: its end in the log and its projected compaction message. */
  const settle = (sessionID: string, value: End) => {
    push(sessionID, value.type, value.data)
    compactions.get(sessionID)?.push(projected(value))
  }

  return { http, imports, logs, followed, listed, timeline, compacted, push, settle, sessions }
}

type Memory = ReturnType<typeof memory>

function service(
  store: Memory,
  more: {
    readonly end?: () => End | undefined
    readonly read?: Execute.Input["read"]
    readonly source?: () => Transcript.Info
    /** How the helper reads the summary's end (`Execute.Input.end`). */
    readonly summaryEnd?: Helper.End
  } = {},
) {
  const events: Execute.Event[] = []
  const jobs = Execute.create({
    http: store.http,
    sessions: store.sessions(more.end ?? (() => ENDED)),
    read: more.read ?? (async () => ({ ok: true, transcript: more.source?.() ?? FOUR })),
    emit: (event) => {
      events.push(event)
    },
    now: () => NOW,
    ...(more.summaryEnd === undefined ? {} : { end: more.summaryEnd }),
  })
  const steps = () => events.flatMap((event) => (event.name === "job.progress" ? [event.data.step] : []))
  const finished = () => events.flatMap((event) => (event.name === "job.finished" ? [event.data] : []))
  return { jobs, events, steps, finished }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

function started(result: Execute.Started) {
  if (!result.ok) throw new Error(`job_busy ${result.jobID}`)
  return result.jobID
}

/** The final import's expected body: the stored shape for the same session id and import time. */
function expected(data: SessionTransfer.Data, info: Transcript.Info, boundary: Fill.Boundary, upToTurn: number) {
  return encode(
    decode(
      Store.build({
        transcript: info,
        upToTurn,
        boundary,
        target: TARGET,
        images: false,
        full: true,
        redact: true,
        sessionID: data.info.id,
        projectID: "prj_fixture",
        location: { directory: DIRECTORY },
        importedAt: NOW,
      }).data,
    ),
  )
}

const metadataOf = (data: SessionTransfer.Data) => OwnImport.decodeMetadata(data.info.metadata)

// ---------------------------------------------------------------------------------------------------------------

describe("migrate.execute (09 §4.4 최종 가져오기, §5.2)", () => {
  test("full: reading → importing, one new session in the planned shape; jobs.list shows the job while it runs", async () => {
    const store = memory()
    const run = service(store)
    const jobID = started(run.jobs.start(order(FOUR, NONE)))
    expect(run.jobs.running()).toBe(jobID)
    expect(run.jobs.list()).toEqual([{ jobID, ref: REF, step: "reading", startedAt: NOW }])
    await run.jobs.idle()
    expect(run.steps()).toEqual(["reading", "importing"])
    expect(store.imports).toHaveLength(1)
    const data = store.imports[0]
    expect(run.finished()).toEqual([{ jobID, outcome: "succeeded", sessionID: data.info.id }])
    expect(encode(data)).toEqual(expected(data, FOUR, { type: "none" }, 3))
    expect<unknown>(data.info.model).toEqual(TARGET)
    expect(data.info.time.archived).toBeUndefined()
    expect(metadataOf(data)).toMatchObject({ mode: "full", checkpoint: null, turns: 4, importedAt: NOW })
    expect(store.timeline).toEqual(["import final"])
    expect(run.jobs.list()).toEqual([])
    expect(run.jobs.running()).toBeUndefined()
  })

  test("a source that grew by appending imports only the planned turns", async () => {
    const store = memory()
    const grown = transcript([...FOUR.turns, turn(4)])
    const run = service(store, { source: () => grown })
    started(run.jobs.start(order(FOUR, NONE)))
    await run.jobs.idle()
    const data = store.imports[0]
    expect(metadataOf(data)).toMatchObject({ turns: 4, contentHash: Transcript.contentHash(FOUR.turns) })
    expect(data.messages.some((message) => message.type === "user" && message.text === "request 4")).toBe(false)
    expect(encode(data)).toEqual(expected(data, grown, { type: "none" }, 3))
  })

  test("a rewritten or shortened source is source_changed and nothing is imported", async () => {
    const changed = [
      transcript([turn(0), turn(1), turn(2, "request 2, rewritten"), turn(3)]),
      transcript([turn(0), turn(1), turn(2)]),
    ]
    for (const source of changed) {
      const store = memory()
      const run = service(store, { source: () => source })
      const jobID = started(run.jobs.start(order(FOUR, NONE)))
      await run.jobs.idle()
      expect(run.finished()).toEqual([
        { jobID, outcome: "failed", error: { type: "source_changed", message: expect.any(String) } },
      ])
      expect(store.imports).toEqual([])
    }
  })

  test("a vanished or unreadable source ends the job with its error", async () => {
    const reads: ReadonlyArray<Execute.Read> = [
      { ok: false, error: "source_not_found" },
      { ok: false, error: "source_unreadable", reason: "decode_failed" },
    ]
    const ends = []
    for (const read of reads) {
      const store = memory()
      const run = service(store, { read: async () => read })
      started(run.jobs.start(order(FOUR, NONE)))
      await run.jobs.idle()
      ends.push(run.finished()[0]?.error)
      expect(store.imports).toEqual([])
    }
    expect(ends).toEqual([
      { type: "source_not_found", message: expect.any(String) },
      { type: "source_unreadable", message: expect.stringContaining("decode_failed") },
    ])
  })

  test("one job per service: job_busy names the running job; the next starts once it ended", async () => {
    const store = memory()
    const gate = Promise.withResolvers<void>()
    const run = service(store, {
      read: async () => {
        await gate.promise
        return { ok: true, transcript: FOUR }
      },
    })
    const first = started(run.jobs.start(order(FOUR, NONE)))
    expect(run.jobs.start(order(FOUR, NONE))).toEqual({ ok: false, error: "job_busy", jobID: first })
    expect(run.jobs.running()).toBe(first)
    gate.resolve()
    await run.jobs.idle()
    const second = started(run.jobs.start(order(FOUR, NONE)))
    expect(second).not.toBe(first)
    await run.jobs.idle()
    expect(run.finished().map((item) => [item.jobID, item.outcome])).toEqual([
      [first, "succeeded"],
      [second, "succeeded"],
    ])
  })

  test("the planned source checkpoint stands; one the tool added after the planned part changes nothing", async () => {
    const store = memory()
    const info = transcript(FOUR.turns, [FOREIGN])
    const later = transcript(
      [...FOUR.turns, turn(4)],
      [FOREIGN, { ...FOREIGN, at: { turn: 3, step: 2, source: { ordinal: 20 } }, summary: "later" }],
    )
    const run = service(store, { source: () => later })
    started(run.jobs.start(order(info, { mode: "full", boundary: { type: "source", checkpoint: FOREIGN } })))
    await run.jobs.idle()
    const data = store.imports[0]
    expect(encode(data)).toEqual(expected(data, later, { type: "source", checkpoint: FOREIGN }, 3))
    expect(
      data.messages.flatMap((message) =>
        message.type === "compaction" && message.status === "completed" ? [message.summary] : [],
      ),
    ).toEqual(["The tool's summary up to 1.1."])
    expect(metadataOf(data)).toMatchObject({ mode: "full", checkpoint: "foreign", turns: 4 })
    expect(run.steps()).toEqual(["reading", "importing"])
  })

  test("brief and codex-remote boundaries import without a helper", async () => {
    const remote: Transcript.Checkpoint = {
      at: { turn: 1, step: 2, source: { ordinal: 9 } },
      kind: "codex-remote",
      recent: [{ role: "user", text: "request 1" }],
    }
    const cases: ReadonlyArray<readonly [Transcript.Info, Fill.Boundary, "full" | "summary", string]> = [
      [FOUR, { type: "brief", at: { turn: 2 } }, "summary", "brief"],
      [transcript(FOUR.turns, [remote]), { type: "remote", at: { turn: 2 } }, "full", "codex-remote"],
    ]
    for (const [info, boundary, mode, checkpoint] of cases) {
      const planned: Execute.Run = mode === "full" ? { mode, boundary } : { mode: "summary", source: "brief", boundary }
      const store = memory()
      const run = service(store, { source: () => info })
      started(run.jobs.start(order(info, planned)))
      await run.jobs.idle()
      const data = store.imports[0]
      expect(encode(data)).toEqual(expected(data, info, boundary, 3))
      expect(metadataOf(data)).toMatchObject({ mode, checkpoint, tailFromTurn: 2 })
      expect(run.steps()).toEqual(["reading", "importing"])
      expect(store.timeline).toEqual(["import final"])
    }
  })

  test("an unreachable service ends the job with service_unreachable", async () => {
    const store = memory({ unreachable: true })
    const run = service(store)
    started(run.jobs.start(order(FOUR, NONE)))
    await run.jobs.idle()
    expect(run.finished()[0]).toMatchObject({ outcome: "failed", error: { type: "service_unreachable" } })
  })
})

describe("the LLM summary in the helper session (09 §4.4, IG8)", () => {
  test("reading → summarizing (the helper named) → importing; the summary is the manual checkpoint; the helper is gone first", async () => {
    const store = memory()
    // Core's compaction is held until the test has looked at the running job.
    const run = service(store, { end: () => undefined })
    const jobID = started(run.jobs.start(order(FOUR, LLM)))
    await until(() => store.compacted.length === 1)
    const helperID = store.compacted[0]
    expect(run.jobs.list()).toEqual([{ jobID, ref: REF, step: "summarizing", startedAt: NOW, sessionID: helperID }])
    const helper = store.imports[0]
    expect(helper.info).toMatchObject({ id: helperID, model: TARGET })
    expect(encode(helper).info.time.archived).toBe(NOW)
    expect(metadataOf(helper)).toEqual({ v: 1, helper: true, jobID })
    store.settle(helperID, ENDED)
    await run.jobs.idle()

    expect(run.events.filter((event) => event.name === "job.progress").map((event) => event.data)).toEqual([
      { jobID, step: "reading" },
      { jobID, step: "summarizing", helperSessionID: helperID },
      { jobID, step: "importing" },
    ])
    expect(store.timeline).toEqual(["import helper", "compact", "interrupt", "remove", "import final"])
    expect(store.logs.has(helperID)).toBe(false)
    const data = store.imports[1]
    expect(run.finished()).toEqual([{ jobID, outcome: "succeeded", sessionID: data.info.id }])
    const summary = {
      text: "S: what happened before",
      recent: "[User]: request 1",
      model: SUMMARIZER,
      cost: 0.12,
      tokens: TOKENS,
    }
    expect(encode(data)).toEqual(expected(data, FOUR, { type: "llm", at: { turn: 2 }, summary }, 3))
    const checkpoint = encode(data).messages.find((message) => message.type === "compaction")
    expect(checkpoint).toMatchObject({
      status: "completed",
      reason: "manual",
      metadata: { recent: KEPT },
      model: SUMMARIZER,
      cost: 0.12,
      tokens: TOKENS,
    })
    expect(checkpoint?.type === "compaction" && checkpoint.status === "completed" && checkpoint.summary).toStartWith(
      `S: what happened before\n\n${Brief.HEADER}`,
    )
    expect(metadataOf(data)).toMatchObject({
      mode: "summary",
      checkpoint: "llm",
      summarizer: SUMMARIZER,
      tailFromTurn: 2,
    })
  })

  test("a failed summary ends the job: nothing imported, compacted once, never another account (IG9)", async () => {
    const store = memory()
    const failed: End = {
      type: "session.compaction.failed",
      data: { reason: "manual", error: { type: "provider.rate-limit", message: "usage limit reached", status: 429 } },
    }
    const run = service(store, { end: () => failed })
    const jobID = started(run.jobs.start(order(FOUR, LLM)))
    await run.jobs.idle()
    expect(run.finished()).toEqual([
      {
        jobID,
        outcome: "failed",
        error: { type: "summary_failed", cause: "exhausted", message: expect.stringContaining("exhausted") },
      },
    ])
    expect(store.timeline).toEqual(["import helper", "compact", "interrupt", "remove"])
    expect<unknown>(store.imports.map((data) => data.info.model)).toEqual([TARGET])
    expect(store.logs.size).toBe(0)
    expect(run.jobs.running()).toBeUndefined()
  })

  test("end messages (the service's way): the summary comes from the helper's compaction messages, its log is never followed", async () => {
    const store = memory()
    const run = service(store, { summaryEnd: "messages" })
    const jobID = started(run.jobs.start(order(FOUR, LLM)))
    await run.jobs.idle()
    const data = store.imports[1]
    expect(run.finished()).toEqual([{ jobID, outcome: "succeeded", sessionID: data.info.id }])
    expect(metadataOf(data)).toMatchObject({ mode: "summary", checkpoint: "llm", summarizer: SUMMARIZER })
    const checkpoint = encode(data).messages.find((message) => message.type === "compaction")
    expect(checkpoint).toMatchObject({ status: "completed", metadata: { recent: KEPT }, cost: 0.12, tokens: TOKENS })
    expect(store.timeline).toEqual(["import helper", "compact", "interrupt", "remove", "import final"])
    expect(store.followed).toEqual([])
  })

  test("end messages: a failed compaction message ends the job with its cause", async () => {
    const store = memory()
    const failed: End = {
      type: "session.compaction.failed",
      data: { reason: "manual", error: { type: "provider.auth", message: "token expired", status: 401 } },
    }
    const run = service(store, { end: () => failed, summaryEnd: "messages" })
    const jobID = started(run.jobs.start(order(FOUR, LLM)))
    await run.jobs.idle()
    expect(run.finished()).toEqual([
      {
        jobID,
        outcome: "failed",
        error: { type: "summary_failed", cause: "needs_reauth", message: expect.stringContaining("needs_reauth") },
      },
    ])
    expect(store.timeline).toEqual(["import helper", "compact", "interrupt", "remove"])
    expect(store.followed).toEqual([])
  })
})

describe("migrate.cancel (09 §4.8)", () => {
  test("before the final import: the helper is interrupted and removed and nothing is left", async () => {
    const store = memory()
    const run = service(store, { end: () => undefined })
    const jobID = started(run.jobs.start(order(FOUR, LLM)))
    await until(() => store.compacted.length === 1)
    expect(await run.jobs.cancel(jobID)).toEqual({ ok: true, cancelled: true })
    expect(run.finished()).toEqual([{ jobID, outcome: "cancelled" }])
    expect(store.timeline).toEqual(["import helper", "compact", "interrupt", "remove"])
    expect(store.logs.size).toBe(0)
    expect(store.imports).toHaveLength(1)
    expect(run.jobs.list()).toEqual([])
  })

  test("while reading: the read is aborted", async () => {
    const store = memory()
    const run = service(store, {
      read: (_ref, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ ok: false, error: "source_not_found" })),
        ),
    })
    const jobID = started(run.jobs.start(order(FOUR, NONE)))
    expect(await run.jobs.cancel(jobID)).toEqual({ ok: true, cancelled: true })
    expect(run.finished()).toEqual([{ jobID, outcome: "cancelled" }])
    expect(store.timeline).toEqual([])
  })

  test("once the final import was sent: cancelled false, and the job succeeds", async () => {
    const store = memory({ importDelay: 100 })
    const run = service(store)
    const jobID = started(run.jobs.start(order(FOUR, NONE)))
    await until(() => run.steps().includes("importing"))
    expect(await run.jobs.cancel(jobID)).toEqual({ ok: true, cancelled: false })
    await run.jobs.idle()
    expect(run.finished()[0]).toMatchObject({ jobID, outcome: "succeeded" })
  })

  test("an unknown or finished job is job_not_found", async () => {
    const store = memory()
    const run = service(store)
    expect(await run.jobs.cancel("job_unknown")).toEqual({ ok: false, error: "job_not_found" })
    const jobID = started(run.jobs.start(order(FOUR, NONE)))
    await run.jobs.idle()
    expect(await run.jobs.cancel(jobID)).toEqual({ ok: false, error: "job_not_found" })
  })

  test("close cancels the running job", async () => {
    const store = memory()
    const run = service(store, { end: () => undefined })
    const jobID = started(run.jobs.start(order(FOUR, LLM)))
    await until(() => store.compacted.length === 1)
    await run.jobs.close()
    expect(run.finished()).toEqual([{ jobID, outcome: "cancelled" }])
    expect(store.logs.size).toBe(0)
  })
})

describe("cleanupHelpers (09 §4.4 남은 보조 세션 정리)", () => {
  test("removes a helper a restart left, spares the running job's", async () => {
    const store = memory()
    const old: SelfHttp.SessionView = {
      id: SessionID.make("ses_helperold00000000000001"),
      projectID: "prj_fixture",
      location: { directory: DIRECTORY },
      metadata: { "own.import": { v: 1, helper: true, jobID: "job_old1" } },
      time: { created: T0, updated: T0, archived: T0 },
    }
    store.listed.push(old)
    store.logs.set(old.id, [])
    const run = service(store, { end: () => undefined })
    const jobID = started(run.jobs.start(order(FOUR, LLM)))
    await until(() => store.compacted.length === 1)
    const running = store.compacted[0]
    expect(await run.jobs.cleanupHelpers()).toEqual({ ok: true, found: 1, removed: 1 })
    expect(store.logs.has(old.id)).toBe(false)
    expect(store.logs.has(running)).toBe(true)
    expect(run.jobs.running()).toBe(jobID)
    await run.jobs.cancel(jobID)
    expect(await run.jobs.cleanupHelpers()).toEqual({ ok: true, found: 0, removed: 0 })
  })
})
