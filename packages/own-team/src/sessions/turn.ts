export * as OwnerTurn from "./turn.js"

import { Option, Schema } from "effect"
import type { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { MsgID } from "../dispatch/msg-id.js"
import type { Hub } from "../hub.js"
import type { Steps } from "../ops/steps.js"
import { Wait } from "../ops/wait.js"
import { SafePoint } from "./safe-point.js"

/**
 * One turn of an area's owner on an op's request (06 §6.2 step 1, §8.7): the warm handoff of a rotation or a split,
 * and a merge's commit turn. `text` goes as a queued synthetic message (metadata `source: own.team`,
 * `own.team.request{kind, opID}`; its id comes from the op, the kind and the owner, so a resend after a restart is the
 * same admission), then the step waits for that turn to end: the owner is not running and the request left its inbox.
 *
 * RH-20, so that the turn never holds the team's op slot for good:
 * - A request still queued for an owner that does not run, {@link SafePoint.WAKE_MS} after its admission, is withdrawn
 *   (`withdrawn`): nothing will take it (the owner's conversation has a staged revert, so core admitted it without a
 *   wake, or the run ended without taking it before a restart and the end event is gone). A run that ended without
 *   taking it withdraws it as before.
 * - After `deadlineMs` (and on `op.force`): a request still queued is withdrawn; a turn that took it and still runs is
 *   stopped (`interrupted`, `resume: false`) unless the user typed in that conversation after the request, in which
 *   case it waits on and says so (only `op.force` stops it then).
 * - While it waits, the step says so (`담당 대화가 인계 메모를 쓰는 중이에요(n분째)`).
 * The caller falls back on anything but `over`: the program's handoff, or the merge's own failure.
 */

/** `over`: the turn ended; `withdrawn` / `interrupted`: see above; `none`: no owner, or the request could not go. */
export type Ended = "over" | "none" | "stopped" | "withdrawn" | "interrupted"

/** A run of a session ended. */
const ENDS: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

/** Messages of the old conversation read for what the user typed after the request. */
const READ = 20

export async function request(
  input: Steps.Input,
  target: { readonly sessionID: SessionID; readonly directory: string; readonly areaID: OwnTeam.AreaID },
  turn: {
    readonly kind: string
    readonly text: string
    /** What the step says while the turn runs (`(n분째)` is added). */
    readonly label: string
    readonly deadlineMs: number
  },
): Promise<Ended> {
  const services = input.services
  const owner = target.sessionID
  const id = MsgID.of(input.op.id, turn.kind, owner)
  const ref = { sessionID: owner, directory: target.directory }
  const call = { signal: input.signal }
  const ended = { seen: false }
  const stop = services.hub.on((event) => {
    if (ENDS.has(event.type) && sessionOf(event) === owner) ended.seen = true
  })
  const sent = await services.http.session.synthetic(
    {
      ...ref,
      id,
      text: turn.text,
      metadata: { source: OwnTeam.PROMPT_SOURCE, [OwnTeam.REQUEST_META]: { kind: turn.kind, opID: input.op.id } },
      delivery: "queue",
    },
    call,
  )
  if (!sent.ok) {
    stop()
    services.log.warn("turn_request_failed", {
      teamID: input.op.teamID,
      areaID: target.areaID,
      sessionID: owner,
      kind: turn.kind,
      type: sent.type,
    })
    return "none"
  }
  const sentAt = sent.value.time?.created ?? services.clock.now()
  const withdraw = async (): Promise<boolean> => {
    const cancelled = await services.http.inbox.cancel({ ...ref, inboxID: id })
    return cancelled.ok
  }
  /** The deadline's (and `op.force`'s) way out; `undefined` when the user typed there and it is not forced. */
  const giveUp = async (forced: boolean): Promise<Ended | undefined> => {
    const inbox = await services.http.inbox.list(ref)
    const queued = inbox.ok && inbox.value.some((item) => item.id === id)
    if (queued && (await withdraw())) return "withdrawn"
    const active = await services.http.session.active()
    if (!active.ok || !active.value.has(owner)) return "over"
    if (!forced && (await typed(input, ref, sentAt))) return undefined
    const interrupted = await services.http.session.interrupt({ ...ref, resume: false })
    services.log.warn("turn_interrupted", {
      teamID: input.op.teamID,
      areaID: target.areaID,
      sessionID: owner,
      kind: turn.kind,
      ok: interrupted.ok,
      forced,
    })
    return "interrupted"
  }
  const over = await Wait.until<Ended>(input, {
    why: "turn",
    text: `${turn.label}(1분째)`,
    wakes: (event) => sessionOf(event) === owner,
    check: async (report, since) => {
      // The inbox before the active list: a run takes the request while it is active, so a request gone from the
      // inbox of a session that is not running was answered. The other way round, a run that starts between the two
      // reads looks finished (not active yet, the request already taken).
      const inbox = await services.http.inbox.list(ref, call)
      if (!inbox.ok && inbox.status !== 404) return undefined
      const active = await services.http.session.active(call)
      if (!active.ok) return undefined
      const now = services.clock.now()
      const running = active.value.has(owner)
      const item = inbox.ok ? inbox.value.find((entry) => entry.id === id) : undefined
      if (!running && item === undefined) return "over"
      if (!running && ended.seen) {
        await services.http.inbox.cancel({ ...ref, inboxID: id }, call)
        return "over"
      }
      if (!running && now - (item?.time?.created ?? sentAt) >= SafePoint.WAKE_MS)
        return (await withdraw()) ? "withdrawn" : undefined
      if (now - since >= turn.deadlineMs) {
        const given = await giveUp(false)
        if (given !== undefined) return given
        report({
          detail: "typed",
          text: `${turn.label}: 사용자가 그 대화에 입력해서 끝나기를 기다려요(${Wait.minutes(since, now)}분째)`,
          sessionIDs: [owner],
        })
        return undefined
      }
      report({
        detail: running ? "running" : "queued",
        text: `${turn.label}(${Wait.minutes(since, now)}분째)`,
        sessionIDs: [owner],
      })
      return undefined
    },
    force: { answer: async () => (await giveUp(true)) ?? "interrupted" },
  })
  stop()
  if (over !== undefined) return over
  // Cancelled (op.cancel) or closing: a request nobody took yet leaves the queue with the op it was for.
  if (input.cancelled()) await withdraw()
  return "stopped"
}

/**
 * The user typed in the conversation after the request (`type: user` without own's `source`), sent or still queued:
 * the turn is the user's too then, and only `op.force` stops it.
 */
async function typed(
  input: Steps.Input,
  ref: { readonly sessionID: SessionID; readonly directory: string },
  after: number,
) {
  const services = input.services
  const [messages, inbox] = await Promise.all([
    services.http.session.messages({ ...ref, limit: READ, order: "desc" }),
    services.http.inbox.list(ref),
  ])
  const sent = messages.ok
    ? messages.value.data.some((message) =>
        Option.match(decodeMessage(message), {
          onNone: () => false,
          onSome: (decoded) =>
            decoded.type === "user" &&
            decoded.time.created >= after &&
            decoded.metadata?.source !== OwnTeam.PROMPT_SOURCE,
        }),
      )
    : false
  const queued = inbox.ok
    ? inbox.value.some((item) => item.type === "user" && item.payload.metadata?.source !== OwnTeam.PROMPT_SOURCE)
    : false
  return sent || queued
}

const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    time: Schema.Struct({ created: Schema.Number }),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

const decodeRef = Schema.decodeUnknownOption(Schema.Struct({ sessionID: Schema.String }))

/** The session an event is about, when it names one. */
export function sessionOf(event: Hub.Incoming) {
  return Option.getOrUndefined(decodeRef(event.data))?.sessionID
}
