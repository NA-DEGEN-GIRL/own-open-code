// A new conversation another screen starts with a ready first message (04 §13 "MCP", MH 2026-11-26: 설정 > MCP 서버
// `AI에게 설치 맡기기`). The message goes into the server's new-conversation draft like an idea note's `새 대화로 시작`;
// the composer of that screen then sends it by itself as soon as it knows the model and the folder (the user's default
// model and the server's new-conversation folder, as for any first message), and the session it creates carries the
// intent's metadata and rules (the install job and the allow of the host's install tool). One intent at a time, in this
// tab's memory only; a different draft by then (the user typed) is never sent for it.
import { createSignal } from "solid-js"
import { requestComposerRestore } from "@/attachments/intents"

export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export interface StartIntent {
  readonly serverKey: string
  readonly text: string
  /** Merged into the new session's metadata (its `own` object merged with the harness's). */
  readonly metadata: Readonly<Record<string, unknown>>
  /** Added to the new session's rules (before the browser policy's). */
  readonly permissions: readonly PermissionRule[]
}

const [current, setCurrent] = createSignal<StartIntent>()

/** Puts the text into the server's new-conversation draft and keeps the intent until that composer sends it. */
export function requestStart(intent: StartIntent) {
  setCurrent(intent)
  requestComposerRestore({ serverKey: intent.serverKey, sessionID: undefined, text: intent.text, attachments: [], mode: "replace" })
}

/** The intent waiting for this server's new-conversation composer, if any. */
export function pendingStart(serverKey: string) {
  const intent = current()
  return intent?.serverKey === serverKey ? intent : undefined
}

/** Takes the intent for a first message of this server with exactly its text; anything else leaves it. */
export function takeStart(serverKey: string, text: string) {
  const intent = current()
  if (!intent || intent.serverKey !== serverKey || intent.text !== text) return undefined
  setCurrent(undefined)
  return intent
}

/** Drops a waiting intent (the user left the screen or changed the draft). */
export function dropStart(serverKey: string) {
  if (current()?.serverKey === serverKey) setCurrent(undefined)
}

/** The session-create metadata with the intent's merged in (`own` objects merged, the intent's keys win). */
export function withStartMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  intent: StartIntent | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!intent) return metadata
  const base = metadata ?? {}
  const own = { ...asRecord(base.own), ...asRecord(intent.metadata.own) }
  return { ...base, ...intent.metadata, ...(Object.keys(own).length > 0 ? { own } : {}) }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
