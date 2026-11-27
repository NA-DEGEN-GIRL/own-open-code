export * as Execute from "./execute.js"

import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { OwnImport } from "@own/protocol/rpc-import"
import { Option, Schema } from "effect"
import type { SelfHttp } from "../http.js"
import { Store } from "../render/store.js"
import { Transcript } from "../transcript/ir.js"
import type { Fill } from "./fill.js"
import { Helper } from "./helper.js"

/**
 * `migrate.execute`, `migrate.cancel` and `jobs.list` (09 §4.4, §4.8, §5.2): the one migration job of the service.
 * A job reads the conversation again and checks that the planned turns are unchanged (`reading`), lets core summarize
 * the older part in the hidden helper session when the plan chose an LLM summary (`summarizing`, {@link Helper}), and
 * imports the stored shape of the chosen mode as one new session (`importing`). Progress and the end are `job.*`
 * events without conversation content. Nothing is retried and no other account is ever asked (07 R4, IG9): a failure
 * ends the job and the dialog offers the alternatives.
 *
 * The service lives in the process singleton (one job per service, 09 §4.8); `emit` is called with the events the
 * control-location instance publishes (02 §9.1).
 */

type ModelRef = typeof Model.Ref.Encoded

/**
 * The row a plan's nonce runs (09 §4.4 최종 가져오기 모양): `full` and the LLM-free summary carry their boundary as
 * the plan computed it; an LLM summary carries where its tail starts, and its boundary is made once the helper
 * session returned the summary.
 */
export type Run =
  | { readonly mode: "full"; readonly boundary: Fill.Boundary }
  | { readonly mode: "summary"; readonly source: "brief"; readonly boundary: Fill.Boundary }
  | { readonly mode: "summary"; readonly source: "llm"; readonly tail: Fill.Cut }

/** What a plan's nonce runs (`migrate.plan` keeps it until `migrate.execute`, 09 §4.8). */
export interface Order {
  readonly ref: OwnImport.SourceRef
  /** The new session's folder (`Plan.location.directory`); the helper session goes there too. */
  readonly location: string
  /** The project of `location`; core sets it from the location, the stored shape still names one. */
  readonly projectID: string
  /** Planned turns (`Plan.turns`): only this prefix is imported, also when the source grew since. */
  readonly turns: number
  /** `Transcript.contentHash` of the planned turns (09 §4.8). */
  readonly contentHash: string
  readonly run: Run
  /** `info.model` of the new session and of the helper (09 §4.5). */
  readonly target: ModelRef
  /** The target takes images. */
  readonly images: boolean
  /** `원래 대화 전체도 own에 저장`. */
  readonly storeFull: boolean
  readonly redact: boolean
}

/** A full read of the conversation (the Worker's parse); aborted by a cancel. `internal_error`: the Worker failed. */
export type Read =
  | { readonly ok: true; readonly transcript: Transcript.Info }
  | { readonly ok: false; readonly error: "source_not_found" | "internal_error" }
  | { readonly ok: false; readonly error: "source_unreadable"; readonly reason: OwnImport.Unreadable }

export interface Progress {
  readonly jobID: OwnImport.JobID
  readonly step: OwnImport.JobStep
  readonly helperSessionID?: SessionID
}

export interface Finished {
  readonly jobID: OwnImport.JobID
  readonly outcome: "succeeded" | "failed" | "cancelled"
  readonly sessionID?: SessionID
  readonly error?: OwnImport.JobError
}

/** `rpc.own.import.job.*` without the envelope (`eventId`, `origin`). */
export type Event =
  | { readonly name: "job.progress"; readonly data: Progress }
  | { readonly name: "job.finished"; readonly data: Finished }

export interface Input {
  readonly http: Helper.Http & { readonly session: Pick<SelfHttp.Client["session"], "all"> }
  readonly sessions: Helper.Sessions
  readonly read: (ref: OwnImport.SourceRef, signal: AbortSignal) => Promise<Read>
  readonly emit: (event: Event) => void
  /** Default `Date.now`. */
  readonly now?: () => number
  /** Per read of the followed helper log (default `Helper.FOLLOW_MS`). */
  readonly followMs?: number
  /** How a summary's end is read (`Helper.SummarizeInput.end`). */
  readonly end?: Helper.End
}

export type Started =
  | { readonly ok: true; readonly jobID: OwnImport.JobID }
  | { readonly ok: false; readonly error: "job_busy"; readonly jobID: OwnImport.JobID }

export type Cancelled =
  | { readonly ok: true; readonly cancelled: boolean }
  | { readonly ok: false; readonly error: "job_not_found" }

export interface Service {
  /**
   * Starts a job and answers its id at once; the steps follow as events. `job_busy` while another one runs, so
   * `migrate.execute` asks {@link running} before it takes the nonce.
   */
  start(order: Order): Started
  /**
   * Before the final import: stops the job, interrupts and removes the helper, and answers once nothing is left. Once
   * the final import was sent: `cancelled: false` (one commit, the session is there or not, 09 §4.8).
   */
  cancel(jobID: string): Promise<Cancelled>
  /** `jobs.list`: the running job, so a reopened dialog restores its progress (09 §6). */
  list(): ReadonlyArray<OwnImport.Job>
  running(): OwnImport.JobID | undefined
  /** Resolves when no job runs. */
  idle(): Promise<void>
  /** `Helper.cleanup`, sparing the running job's helper; once after activation on the control instance. */
  cleanupHelpers(): Promise<Helper.Cleaned>
  /** Cancels the running job (the singleton's close). */
  close(): Promise<void>
}

interface Job {
  readonly jobID: OwnImport.JobID
  readonly ref: OwnImport.SourceRef
  readonly startedAt: number
  readonly abort: AbortController
  step: OwnImport.JobStep
  /** The helper while `summarizing`, the new session while `importing`. */
  sessionID?: SessionID
  /** The final import was sent. */
  importing: boolean
  cancelled: boolean
  /** Set by `start` right after the job is created, before anything can await it. */
  done?: Promise<Finished>
}

type Outcome = Omit<Finished, "jobID">

const CANCELLED: Outcome = { outcome: "cancelled" }

export function create(input: Input): Service {
  const now = input.now ?? Date.now
  const state: { current?: Job } = {}

  const progress = (job: Job, step: OwnImport.JobStep, sessionID?: SessionID) => {
    job.step = step
    job.sessionID = sessionID
    input.emit({
      name: "job.progress",
      data: { jobID: job.jobID, step, ...(step === "summarizing" && sessionID ? { helperSessionID: sessionID } : {}) },
    })
  }

  const execute = async (job: Job, order: Order): Promise<Outcome> => {
    progress(job, "reading")
    const read = await input.read(order.ref, job.abort.signal)
    if (job.cancelled) return CANCELLED
    if (!read.ok) return read.error === "source_unreadable" ? unreadable(read.reason) : failed(read.error)
    if (!unchanged(read.transcript, order)) return failed("source_changed")
    const run = order.run
    const boundary =
      run.mode === "summary" && run.source === "llm"
        ? await summary(job, order, read.transcript, run.tail)
        : run.boundary
    if (job.cancelled) return CANCELLED
    if ("outcome" in boundary) return boundary
    const sessionID = SessionID.create()
    const data = Option.getOrUndefined(
      decodeTransfer(
        Store.build({
          transcript: read.transcript,
          upToTurn: order.turns - 1,
          boundary,
          target: order.target,
          images: order.images,
          full: order.storeFull,
          redact: order.redact,
          sessionID,
          projectID: order.projectID,
          location: { directory: order.location },
          importedAt: now(),
        }).data,
      ),
    )
    if (data === undefined) return failed("internal_error")
    // From here a cancel answers `cancelled: false`: the import is one commit (09 §4.8).
    job.importing = true
    progress(job, "importing", sessionID)
    const imported = await input.http.session.import(
      { directory: order.location, data },
      { timeoutMs: Helper.IMPORT_MS },
    )
    if (!imported.ok) return failed(imported.status === null ? "service_unreachable" : "internal_error")
    return { outcome: "succeeded", sessionID }
  }

  /** The LLM summary in the helper session (09 §4.4), as the boundary of the final import. */
  const summary = async (
    job: Job,
    order: Order,
    transcript: Transcript.Info,
    at: Fill.Cut,
  ): Promise<Fill.Boundary | Outcome> => {
    const helperID = SessionID.create()
    progress(job, "summarizing", helperID)
    const summarized = await Helper.summarize({
      http: input.http,
      sessions: input.sessions,
      transcript,
      upToTurn: order.turns - 1,
      tail: at,
      target: order.target,
      jobID: job.jobID,
      sessionID: helperID,
      projectID: order.projectID,
      directory: order.location,
      redact: order.redact,
      now: now(),
      signal: job.abort.signal,
      ...(input.followMs === undefined ? {} : { followMs: input.followMs }),
      ...(input.end === undefined ? {} : { end: input.end }),
    })
    if (summarized.ok) return { type: "llm", at, summary: summarized.summary }
    if (summarized.error === "cancelled") return CANCELLED
    if (summarized.error === "summary_failed") return failed("summary_failed", summarized.cause)
    return failed(summarized.error)
  }

  const start = (order: Order): Started => {
    const busy = state.current
    if (busy !== undefined) return { ok: false, error: "job_busy", jobID: busy.jobID }
    const job: Job = {
      jobID: OwnImport.JobID.create(),
      ref: order.ref,
      startedAt: now(),
      abort: new AbortController(),
      step: "reading",
      importing: false,
      cancelled: false,
    }
    state.current = job
    job.done = execute(job, order)
      .catch(() => (job.cancelled && !job.importing ? CANCELLED : failed("internal_error")))
      .then((outcome) => {
        const finished: Finished = { jobID: job.jobID, ...outcome }
        // Free before the event, so a listener can start the next job right away.
        if (state.current === job) state.current = undefined
        input.emit({ name: "job.finished", data: finished })
        return finished
      })
    return { ok: true, jobID: job.jobID }
  }

  const cancel = async (jobID: string): Promise<Cancelled> => {
    const job = state.current
    if (job === undefined || job.jobID !== jobID) return { ok: false, error: "job_not_found" }
    if (job.importing) return { ok: true, cancelled: false }
    job.cancelled = true
    job.abort.abort()
    const finished = await job.done
    return { ok: true, cancelled: finished?.outcome === "cancelled" }
  }

  return {
    start,
    cancel,
    list: () => {
      const job = state.current
      if (job === undefined) return []
      return [
        {
          jobID: job.jobID,
          ref: job.ref,
          step: job.step,
          startedAt: job.startedAt,
          ...(job.sessionID === undefined ? {} : { sessionID: job.sessionID }),
        },
      ]
    },
    running: () => state.current?.jobID,
    idle: async () => {
      await state.current?.done
    },
    cleanupHelpers: () => Helper.cleanup({ http: input.http, sessions: input.sessions, keep: state.current?.jobID }),
    close: async () => {
      const job = state.current
      if (job !== undefined) await cancel(job.jobID)
    },
  }
}

/**
 * The planned turns are still there and hash the same (09 §4.8): turns appended since are fine, the import takes only
 * the planned ones. The plan's boundary stays as it was planned, so a checkpoint the tool added after the planned part
 * changes nothing.
 */
function unchanged(transcript: Transcript.Info, order: Order) {
  const turns = transcript.turns.slice(0, order.turns)
  return turns.length === order.turns && Transcript.contentHash(turns) === order.contentHash
}

const decodeTransfer = Schema.decodeUnknownOption(SessionTransfer.Data)

/** Fixed English: a job's error never carries conversation content, paths or provider messages. */
const MESSAGE: Record<OwnImport.JobError["type"], string> = {
  source_not_found: "The conversation is no longer there.",
  source_unreadable: "The conversation could not be read.",
  source_changed: "The conversation was rewritten after the plan. Plan again.",
  target_unavailable: "The target model cannot take the conversation.",
  summary_failed: "The summary failed. Nothing was imported.",
  service_unreachable: "The own service did not answer.",
  internal_error: "The import failed.",
}

function failed(type: OwnImport.JobError["type"], cause?: OwnImport.SummaryFailure): Outcome {
  return {
    outcome: "failed",
    error: {
      type,
      message: cause === undefined ? MESSAGE[type] : `${MESSAGE[type]} (${cause})`,
      ...(cause === undefined ? {} : { cause }),
    },
  }
}

function unreadable(reason: OwnImport.Unreadable): Outcome {
  return {
    outcome: "failed",
    error: { type: "source_unreadable", message: `${MESSAGE.source_unreadable} (${reason})` },
  }
}
