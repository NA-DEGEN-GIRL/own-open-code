export * as Helper from "./helper.js"

import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import type { SessionID } from "@opencode/schema/session-id"
import type { SessionMessage } from "@opencode/schema/session-message"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { TokenUsage } from "@opencode/schema/token-usage"
import { OwnImport } from "@own/protocol/rpc-import"
import { Effect, Exit, Option, Schema } from "effect"
import type { SelfHttp } from "../http.js"
import { Store } from "../render/store.js"
import type { Transcript } from "../transcript/ir.js"
import type { Fill } from "./fill.js"

/**
 * The hidden helper session of an LLM summary (09 §4.4, IM-D7): own.import imports the part before the tail as a
 * session H (archived, metadata `own.import = {v: 1, helper: true, jobID}`, model = the target), admits one manual
 * compaction with `ctx.session.compact`, waits until that compaction ends or fails, reads
 * `{summary, recent, model, cost, tokens}` and removes H with `ctx.session.remove` whatever happened. Since upstream v2.1
 * the compaction stores only where its kept messages start; their text comes from H's context, where core rebuilds it. The service
 * watches H's compaction messages ({@link POLL_MS}, `end: "messages"`): its session log route yields no durable event
 * unless the service keeps them (`events.persist`, which the CLI never turns on), so a followed log would never see
 * the end there; other callers follow the log. Core runs the summary exactly like an ordinary manual compaction
 * (template, budget, its own retry policy, usage records); own.import never retries it and never moves it to another
 * account (07 R4, IG9). {@link cleanup} removes the helpers a restart left behind (09 §4.4 남은 보조 세션 정리).
 */

/** One read of the followed helper log; a read that runs out resumes from its cursor. */
export const FOLLOW_MS = 5 * 60_000
/** How often H's compaction messages are read while its summary runs. */
export const POLL_MS = 1_000
/** How long H may show no compaction of its own after the admission before the summary counts as failed. */
export const ADMIT_MS = 2 * 60_000
/**
 * The longest a summary may run after its admission (a provider stream that hangs, a compaction core never settles)
 * before it counts as failed (`summary_failed{other}`): the job's `finally` then stops and removes H, and other
 * imports stop answering `job_busy`. Far above a real summary of one request.
 */
export const SUMMARY_MS = 30 * 60_000
/** An import request: the body can be tens of MiB (09 §2.8 ⚠IG5). */
export const IMPORT_MS = 10 * 60_000

type ModelRef = typeof Model.Ref.Encoded

/** What the helper needs of `ctx.session` (09 §5.1: compact and remove go through the plugin API, not self-HTTP). */
export interface Sessions {
  /** Admits one manual compaction (`POST /api/session/:id/compact`); `false` when it was refused. */
  readonly compact: (sessionID: SessionID) => Promise<boolean>
  /** Stops what runs in the session without resuming it; a no-op for an idle session. */
  readonly interrupt: (sessionID: SessionID) => Promise<boolean>
  readonly remove: (sessionID: SessionID) => Promise<boolean>
}

/** {@link Sessions} over the Effect plugin API's `ctx.session`: a failure, a defect or a throw answers `false`. */
export function sessions(session: Pick<SessionDomain, "compact" | "interrupt" | "remove">): Sessions {
  const done = (effect: () => Effect.Effect<unknown, unknown>) =>
    Effect.runPromiseExit(Effect.suspend(effect)).then(Exit.isSuccess)
  return {
    compact: (sessionID) => done(() => session.compact({ sessionID })),
    interrupt: (sessionID) => done(() => session.interrupt({ sessionID, resume: false })),
    remove: (sessionID) => done(() => session.remove({ sessionID })),
  }
}

/** What the helper needs of self-HTTP; with `message` it watches H's compaction messages, else its log. */
export interface Http {
  readonly session: Pick<SelfHttp.Client["session"], "import" | "log">
  readonly message?: Pick<SelfHttp.Client["message"], "compactions" | "context">
}

export interface SummarizeInput {
  readonly http: Http
  readonly sessions: Sessions
  readonly transcript: Transcript.Info
  /** The last planned turn (0-based). */
  readonly upToTurn: number
  /** Where the tail kept as it is starts; the summary covers what comes before it (09 §4.3). */
  readonly tail: Fill.Cut
  /**
   * H's model: the target (09 §4.5). When `agents.compaction.model` is configured core summarizes with that model
   * instead; the plan showed it (`summarizer_overridden`). Also the summary's model when the log does not name one.
   */
  readonly target: ModelRef
  readonly jobID: OwnImport.JobID
  /** H, chosen by the job so `job.progress` and `jobs.list` can name it before the import. */
  readonly sessionID: SessionID
  /** Core takes the project from the location; the stored shape still names one. */
  readonly projectID: string
  /** The import location: H goes there too, so core's `keep` and `buffer` are the final session's (01 R16). */
  readonly directory: string
  readonly redact: boolean
  /** `time.archived` of H. */
  readonly now: number
  /** A cancel: H is stopped and removed and the answer is `cancelled`. */
  readonly signal: AbortSignal
  /** Default {@link FOLLOW_MS}. */
  readonly followMs?: number
  /**
   * How the end of H's compaction is read: `messages` watches H's compaction messages ({@link POLL_MS}), the only way
   * that sees it on a service that keeps no durable events (the CLI never sets `events.persist`); default: H's
   * followed session log.
   */
  readonly end?: End
}

/** See {@link SummarizeInput.end}. */
export type End = "log" | "messages"

export type Summarized =
  | { readonly ok: true; readonly summary: Fill.Summary }
  | { readonly ok: false; readonly error: "cancelled" | "service_unreachable" | "internal_error" }
  | { readonly ok: false; readonly error: "summary_failed"; readonly cause: OwnImport.SummaryFailure }

/**
 * Runs one summary in H (09 §4.4 steps 1–3). H is interrupted and removed in every outcome, also when its import
 * failed or was cancelled half way (a session that does not exist makes those calls fail quietly).
 */
export async function summarize(input: SummarizeInput): Promise<Summarized> {
  const data = Option.getOrUndefined(
    decodeTransfer(
      Store.helper({
        transcript: input.transcript,
        upToTurn: input.upToTurn,
        tail: input.tail,
        model: input.target,
        jobID: input.jobID,
        sessionID: input.sessionID,
        projectID: input.projectID,
        location: { directory: input.directory },
        archivedAt: input.now,
        redact: input.redact,
      }).data,
    ),
  )
  if (data === undefined) return { ok: false, error: "internal_error" }
  return run(input, data).finally(async () => {
    await input.sessions.interrupt(input.sessionID)
    await input.sessions.remove(input.sessionID)
  })
}

const CANCELLED: Summarized = { ok: false, error: "cancelled" }

async function run(input: SummarizeInput, data: SessionTransfer.Data): Promise<Summarized> {
  // The import is not aborted by a cancel: it settles, so the removal afterwards never races a late commit.
  const imported = await input.http.session.import({ directory: input.directory, data }, { timeoutMs: IMPORT_MS })
  if (input.signal.aborted) return CANCELLED
  if (!imported.ok) return { ok: false, error: imported.status === null ? "service_unreachable" : "internal_error" }
  const admitted = await input.sessions.compact(input.sessionID)
  if (input.signal.aborted) return CANCELLED
  if (!admitted) return failed("other")
  const message = input.http.message
  const since = Date.now()
  // The compactions H was imported with (a tool's checkpoint before the tail) are not this summary.
  const known = new Set(data.messages.flatMap((item) => (item.type === "compaction" ? [item.id] : [])))
  const summarized =
    input.end !== "messages" || message === undefined
      ? await follow(input, since)
      : await watch(input, message.compactions, known, since)
  if (!summarized.ok || summarized.summary.recent !== "" || message === undefined) return summarized
  return { ok: true, summary: { ...summarized.summary, recent: await keptText(input, message.context, known) } }
}

/** The kept messages' text core rebuilds on the compaction H's context now starts with; empty when it keeps none. */
async function keptText(
  input: SummarizeInput,
  read: SelfHttp.Client["message"]["context"],
  known: ReadonlySet<string>,
) {
  const context = await read({ sessionID: input.sessionID, directory: input.directory }, { signal: input.signal })
  const first = context.ok ? context.value[0] : undefined
  if (first?.type !== "compaction" || first.status !== "completed" || known.has(first.id)) return ""
  const recent = first.metadata?.recent
  return typeof recent === "string" ? recent : ""
}

/**
 * Reads H's compaction messages every {@link POLL_MS} until the one this admission made completed or failed. One
 * that never appears within {@link ADMIT_MS}, or never settles within {@link SUMMARY_MS}, ends the summary as failed;
 * H gone (the activation cleanup removed it) is `interrupted`.
 */
async function watch(
  input: SummarizeInput,
  read: SelfHttp.Client["message"]["compactions"],
  known: ReadonlySet<string>,
  admitted: number,
): Promise<Summarized> {
  const listed = await read({ sessionID: input.sessionID, directory: input.directory }, { signal: input.signal })
  if (input.signal.aborted) return CANCELLED
  if (!listed.ok) {
    if (listed.status === null) return { ok: false, error: "service_unreachable" }
    return failed(listed.status === 404 ? "interrupted" : "other")
  }
  const own = listed.value.find((message) => !known.has(message.id))
  const ended = own === undefined ? undefined : settle(ending(own), input.target)
  if (ended !== undefined) return ended
  if (own === undefined && Date.now() - admitted > ADMIT_MS) return failed("other")
  if (Date.now() - admitted > SUMMARY_MS) return failed("other")
  await Bun.sleep(POLL_MS)
  if (input.signal.aborted) return CANCELLED
  return watch(input, read, known, admitted)
}

/** A settled compaction message as the log item that would have ended it; a running one ends nothing. */
function ending(message: SessionMessage.Compaction): SelfHttp.LogItem {
  if (message.status === "completed")
    return {
      type: "session.compaction.ended",
      data: {
        text: message.summary,
        // Written by a service before upstream v2.1; later ones keep only `metadata.keepID` (see keptText).
        recent: typeof message.metadata?.recent === "string" ? message.metadata.recent : "",
        ...(message.model === undefined ? {} : { model: message.model }),
        ...(message.cost === undefined ? {} : { cost: message.cost }),
        ...(message.tokens === undefined ? {} : { tokens: message.tokens }),
      },
    }
  if (message.status === "failed") return { type: "session.compaction.failed", data: { error: message.error } }
  return { type: "session.compaction.running" }
}

/**
 * Follows H's log from its start until the compaction settles (H is new, so the first end is this summary's). A read
 * that runs out of time resumes from its cursor until {@link SUMMARY_MS} passed since the admission; a log the service
 * closed by itself means it is going away.
 */
async function follow(input: SummarizeInput, admitted: number, after?: number): Promise<Summarized> {
  const seen: { end?: Summarized } = {}
  const log = await input.http.session.log(
    {
      sessionID: input.sessionID,
      directory: input.directory,
      follow: true,
      ...(after === undefined ? {} : { after }),
      visit: (item) => {
        seen.end = settle(item, input.target)
        return seen.end === undefined
      },
    },
    { signal: input.signal, timeoutMs: input.followMs ?? FOLLOW_MS },
  )
  if (seen.end !== undefined) return seen.end
  if (input.signal.aborted) return CANCELLED
  if (!log.ok) {
    if (log.status === null) return { ok: false, error: "service_unreachable" }
    // H is gone (removed elsewhere, e.g. by the activation cleanup).
    return failed(log.status === 404 ? "interrupted" : "other")
  }
  if (!log.value.interrupted) return failed("interrupted")
  if (Date.now() - admitted > SUMMARY_MS) return failed("other")
  return follow(input, admitted, log.value.cursor ?? after)
}

const Failure = Schema.Struct({ type: Schema.String, message: Schema.String, status: optional(Schema.Finite) })
type Failure = typeof Failure.Type

/** The log items that end the wait; anything else is skipped. */
const Terminal = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.compaction.ended"),
    data: Schema.Struct({
      text: Schema.String,
      // Before upstream v2.1 only.
      recent: optional(Schema.String),
      model: optional(Model.Ref),
      cost: optional(Schema.Finite),
      tokens: optional(TokenUsage.Info),
    }),
  }),
  Schema.Struct({
    type: Schema.Literals(["session.compaction.failed", "session.execution.failed"]),
    data: Schema.Struct({ error: Failure }),
  }),
  Schema.Struct({
    type: Schema.Literals(["session.execution.succeeded", "session.execution.interrupted", "session.deleted"]),
  }),
])
const decodeTerminal = Schema.decodeUnknownOption(Terminal)
const decodeTransfer = Schema.decodeUnknownOption(SessionTransfer.Data)

function settle(item: SelfHttp.LogItem, target: ModelRef): Summarized | undefined {
  const event = Option.getOrUndefined(decodeTerminal(item))
  if (event === undefined) return undefined
  switch (event.type) {
    case "session.compaction.ended":
      // A native compaction answers provider context without summary text; the plan refuses such a summarizer.
      if (event.data.text.trim() === "") return failed("other")
      return {
        ok: true,
        summary: {
          text: event.data.text,
          recent: event.data.recent ?? "",
          model: event.data.model ?? target,
          ...(event.data.cost === undefined ? {} : { cost: event.data.cost }),
          ...(event.data.tokens === undefined ? {} : { tokens: event.data.tokens }),
        },
      }
    case "session.compaction.failed":
    case "session.execution.failed":
      return failed(cause(event.data.error))
    // The run ended without settling the compaction.
    case "session.execution.succeeded":
      return failed("other")
    default:
      return failed("interrupted")
  }
}

function failed(cause: OwnImport.SummaryFailure): Summarized {
  return { ok: false, error: "summary_failed", cause }
}

/** Context-overflow wording of providers (`maximum context length`, `prompt is too long`, `exceeds the context`). */
const OVERFLOW = /context (?:length|window)|too long|too large|maximum context|exceeds the context/i

/**
 * Why a summary failed (09 §4.8), from core's session error: usage used up or rate limited after core's own retries
 * (`exhausted`), a login to renew (`needs_reauth`), still too large after core's shrinking (`overflow`), stopped
 * (`interrupted`), or anything else.
 */
export function cause(error: Pick<Failure, "type" | "message" | "status">): OwnImport.SummaryFailure {
  if (error.type === "provider.quota" || error.type === "provider.rate-limit") return "exhausted"
  if (error.type === "provider.auth") return "needs_reauth"
  if (error.type === "aborted" || error.type === "compaction.interrupted") return "interrupted"
  // Core's own "cannot be reduced further" end of its shrink steps (`compaction.ts`).
  if (error.type === "compaction.failed" && /cannot be reduced/i.test(error.message)) return "overflow"
  if (error.type === "provider.invalid-request" && (error.status === 413 || OVERFLOW.test(error.message)))
    return "overflow"
  return "other"
}

export interface CleanupInput {
  readonly http: { readonly session: Pick<SelfHttp.Client["session"], "all"> }
  readonly sessions: Sessions
  /** The running job: its helper is left alone. */
  readonly keep?: string
}

export type Cleaned =
  | { readonly ok: true; readonly found: number; readonly removed: number }
  | { readonly ok: false; readonly error: "service_unreachable" | "internal_error" }

/**
 * Removes the helpers nothing waits for (09 §4.4 남은 보조 세션 정리): core resumes a claimed session after a restart,
 * so a helper whose job died with the service could summarize again. Lists every root session (archived ones too),
 * keeps those whose metadata decodes as a helper (never an imported session), then interrupts and removes each.
 * Idempotent: a second run finds nothing.
 */
export async function cleanup(input: CleanupInput): Promise<Cleaned> {
  const listed = await input.http.session.all({ parentID: null })
  if (!listed.ok) return { ok: false, error: listed.status === null ? "service_unreachable" : "internal_error" }
  const helpers = listed.value.filter((session) => {
    const value = OwnImport.decodeMetadata(session.metadata)
    return value !== undefined && OwnImport.isHelper(value) && value.jobID !== input.keep
  })
  const removed = await Promise.all(
    helpers.map(async (session) => {
      await input.sessions.interrupt(session.id)
      return input.sessions.remove(session.id)
    }),
  )
  return { ok: true, found: helpers.length, removed: removed.filter(Boolean).length }
}
