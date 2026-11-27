export * as WorktreeChatFeature from "./feature.js"

import { OwnTeam } from "@own/protocol"
import type { Hub } from "../hub.js"
import type { Services } from "../services.js"
import { WorktreeChats } from "./chats.js"

/**
 * The worktree conversations' follow-up (06 §13.4): core events of a started conversation move its record, and the
 * parent hears of a run that ended (its last answer; `blocked` when it starts with `BLOCKED:` / `막힘:` or the run
 * failed) and of a permission or question waiting for the user there. Notes within {@link WorktreeChats.NOTE_DELAY_MS}
 * go as one queued synthetic message (it starts an idle parent, or comes after its running turn). A run the user
 * stopped there tells the parent nothing. Subagents' runs are not the conversation's.
 */

const ENDS: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

export function create(services: Services.Context): Services.WorktreeChat {
  const log = services.log.child("worktree-chat")
  const timers = new Map<string, () => void>()
  const state = { closed: false }

  const schedule = (parentID: string) => {
    if (state.closed || timers.has(parentID)) return
    timers.set(
      parentID,
      services.clock.schedule(WorktreeChats.NOTE_DELAY_MS, () => {
        timers.delete(parentID)
        void tell(services, parentID).catch((error: unknown) => log.warn("note_failed", { parentID, error }))
      }),
    )
  }

  const stop = services.hub.on(async (event) => {
    const sessionID = sessionOf(event)
    if (sessionID === undefined) return
    if (!ENDS.has(event.type) && !STARTS.has(event.type) && !ASKS.has(event.type)) return
    const record = await WorktreeChats.find(services, sessionID)
    if (!record || record.state === "integrated" || record.state === "removed") return
    const now = services.clock.now()
    if (STARTS.has(event.type)) {
      await WorktreeChats.update(services, sessionID, (current) =>
        current.state === "working" ? current : { ...current, state: "working", updated: now },
      )
      return
    }
    if (ASKS.has(event.type)) {
      const asked = await WorktreeChats.update(services, sessionID, (current) =>
        current.asked ? current : { ...current, asked: true, askTold: false, state: "needs_user", updated: now },
      )
      if (asked) schedule(record.parentID)
      return
    }
    const user = event.type === "session.execution.interrupted" && reasonOf(event) === "user"
    const last = await WorktreeChats.lastAnswer(services, record)
    const ended = await WorktreeChats.update(services, sessionID, (current) => {
      return {
        ...current,
        asked: false,
        askTold: false,
        state: event.type === "session.execution.failed" || WorktreeChats.blocked(last) ? "blocked" : "done",
        ...(last === undefined ? {} : { last, summary: last.slice(0, WorktreeChats.SUMMARY_CHARS) }),
        ended: now,
        // The user stopped it there: nothing to tell.
        ...(user ? { told: now } : {}),
        updated: now,
      }
    })
    if (ended && !user) schedule(record.parentID)
  })

  return {
    list: (sessionID) => WorktreeChats.list(services, sessionID),
    close: async () => {
      state.closed = true
      stop()
      for (const cancel of timers.values()) cancel()
      timers.clear()
    },
  }
}

const STARTS: ReadonlySet<string> = new Set(["session.execution.started"])
const ASKS: ReadonlySet<string> = new Set(["permission.asked", "form.created"])

/** Sends the parent one note for what it has not heard yet, then marks it heard. */
async function tell(services: Services.Context, parentID: string) {
  const records = await WorktreeChats.load(services, parentID)
  const news = records.filter(
    (record) =>
      (record.ended !== undefined && (record.told === undefined || record.told < record.ended)) ||
      (record.asked === true && record.askTold !== true),
  )
  const directory = news.find((record) => record.parentDirectory !== undefined)?.parentDirectory
  if (news.length === 0 || directory === undefined) return
  const at = services.clock.now()
  const sent = await services.http.session.synthetic({
    sessionID: parentID,
    directory,
    id: WorktreeChats.noteID(parentID, at),
    text: WorktreeChats.note(news),
    metadata: { [OwnTeam.WORKTREE_CHAT_META]: { note: news.map((record) => record.sessionID) }, source: OwnTeam.PROMPT_SOURCE },
    delivery: "queue",
  })
  if (!sent.ok) {
    services.log.warn("worktree_chat_note_failed", { parentID, type: sent.type, message: sent.message })
    return
  }
  for (const record of news)
    await WorktreeChats.update(services, record.sessionID, (current) => ({
      ...current,
      ...(current.ended === undefined ? {} : { told: current.ended }),
      ...(current.asked ? { askTold: true } : {}),
    }))
}

function sessionOf(event: Hub.Incoming): string | undefined {
  const data: unknown = event.data
  if (typeof data !== "object" || data === null) return undefined
  const record: Readonly<Record<string, unknown>> = { ...data }
  if (typeof record.sessionID === "string") return record.sessionID
  const form = record.form
  if (typeof form === "object" && form !== null && "sessionID" in form && typeof form.sessionID === "string")
    return form.sessionID
  return undefined
}

function reasonOf(event: Hub.Incoming) {
  const data: unknown = event.data
  if (typeof data !== "object" || data === null || !("reason" in data)) return undefined
  return data.reason
}
