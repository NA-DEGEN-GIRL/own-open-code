export * as PresetUsage from "./usage.js"

import { Option, Schema } from "effect"
import { Kv, Preset } from "@own/protocol"
import type { SessionMessagesInput } from "@opencode/plugin/promise/session"
import { SessionID } from "@opencode/schema/session-id"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { Deps } from "../deps.js"

/**
 * A root's subagent usage (07 §2.6, §8.1). The counts themselves live in the runtime's reservation map
 * (`deps.runtime.reservations`): running now, new per user message, new in the conversation. KV `presetUsage` keeps the
 * conversation count across restarts and the one message `session.preset.raiseOnce` raised.
 */

/** No user message could be found (or read): every call counts against this one key, so the cap only gets stricter. */
export const UNKNOWN_MESSAGE = ""

/** The root's KV `presetUsage`; nothing used yet when absent or unreadable. */
export async function read(deps: Deps, root: string): Promise<Preset.Usage> {
  return Option.getOrUndefined(decodeUsage(await deps.ctx.storage.get(Kv.presetUsage(root)))) ?? { perSession: 0 }
}

/**
 * Persists the conversation count. Read-merge-write: the stored `raise` stays, and a count never goes down (another
 * writer, or a call taken back, leaves the higher value).
 */
export async function record(deps: Deps, root: string, perSession: number) {
  const key = Kv.presetUsage(root)
  const stored = await read(deps, root)
  if (stored.perSession >= perSession) return
  await deps.ctx.storage.set(key, toJson(encodeUsage({ ...stored, perSession })))
}

/**
 * The root's current user message (07 §2.6 "사용자 메시지 하나"): the latest `user` message of its context, so a steered
 * or queued prompt counts from its delivery on. A context that starts with a compaction and holds no user message (a
 * mid-turn compaction) counts against that compaction. {@link UNKNOWN_MESSAGE} when the context is empty or cannot be
 * read. `session.preset.raiseOnce` raises the cap for this message.
 */
export async function message(deps: Deps, root: string): Promise<string> {
  // A few indexed reads of single rows. The context itself (every message since the last compaction, screenshots
  // included) can be hundreds of MB in a long session, and this runs on every session open and subagent call.
  const read: Read = (input) => deps.ctx.session.messages({ ...input, sessionID: SessionID.make(root) })
  return Promise.resolve()
    .then(async () => {
      const [user] = await read({ type: "user", limit: 1 })
      const start = await contextStart(read)
      if (!start) return user?.id ?? (await read({ order: "asc", limit: 1 }))[0]?.id ?? UNKNOWN_MESSAGE
      if (!user) return start.id
      const [after] = await read({ type: "user", order: "asc", cursor: { id: start.id, direction: "next" }, limit: 1 })
      return after ? user.id : start.id
    })
    .catch(() => UNKNOWN_MESSAGE)
}

type Read = (input: Omit<SessionMessagesInput, "sessionID">) => Promise<ReadonlyArray<SessionMessage.Info>>

/** The compaction the context starts at, as core's `latest` history picks it: the newest completed one not undone. */
async function contextStart(read: Read, before?: SessionMessage.ID): Promise<SessionMessage.Info | undefined> {
  const page = await read({
    type: "compaction",
    limit: COMPACTION_PAGE,
    ...(before === undefined ? {} : { cursor: { id: before, direction: "next" } }),
  })
  const found = page.find((item) => item.type === "compaction" && item.status === "completed" && !item.undone)
  if (found) return found
  const last = page.at(-1)
  return last && page.length === COMPACTION_PAGE ? contextStart(read, last.id) : undefined
}

const COMPACTION_PAGE = 4

/** The per-message cap for `message`: the cap in force, or the raise stored for that message when it is higher. */
export function perMessage(caps: Preset.Caps, usage: Preset.Usage, message: string) {
  const raise = usage.raise
  return raise !== undefined && raise.messageID === message
    ? Math.max(caps.perMessage, raise.perMessage)
    : caps.perMessage
}

/** Whether `session.preset.raiseOnce{effort}` lifted the effort ceiling for `message` (07 §2.3 `이번 메시지만 허용`). */
export function effortOnce(usage: Preset.Usage, message: string) {
  return usage.effort !== undefined && usage.effort.messageID === message
}

const decodeUsage = Schema.decodeUnknownOption(Preset.Usage)
const encodeUsage = Schema.encodeSync(Preset.Usage)
const toJson = Schema.decodeUnknownSync(Schema.Json)
