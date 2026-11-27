// Ports the request-series bookkeeping of packages/core/agent-loop/src/agent.ts `buildRequest`: dsh logs a
// `request/header` (model, settings and tools; the prompt travels in the history) for the first request (`initial`),
// the first after a reload (`resume`), a changed header (`change`), and a request that starts a new message series
// (`series`: the history before it was rewritten, as by a compaction), so an unavoidable prompt-cache miss carries its
// reason. own keeps no such durable record (02 §4.3: durable events stay minimal): the plugin process remembers each
// session's last primary request as hashes and writes one log line when a reason applies. Nothing reaches the model.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshSeries from "./series.js"

import { createHash } from "node:crypto"
import type { Message, SystemPart } from "@opencode/ai/effect"

export type Reason = "initial" | "resume" | "change" | "series"

export interface Print {
  readonly header: string
  readonly parts: { readonly model: string; readonly options: string; readonly tools: string }
  readonly system: string
  readonly messages: ReadonlyArray<string>
}

export interface Request {
  readonly model: string
  readonly options: unknown
  readonly tools: unknown
  readonly system: ReadonlyArray<SystemPart>
  readonly messages: ReadonlyArray<Message>
}

/** The request as hashes: its header (dsh's `canonicalHeader`), its system text and each message. */
export function print(request: Request): Print {
  const parts = {
    model: hash(request.model),
    options: hash(canonical(request.options)),
    tools: hash(canonical(request.tools)),
  }
  return {
    header: hash(canonical(parts)),
    parts,
    system: hash(request.system.map((part) => part.text).join("\n\n")),
    messages: request.messages.map((message) => hash(canonical({ role: message.role, content: message.content }))),
  }
}

/**
 * Why this request opens or continues its series, against the session's previous one (undefined: none this process
 * saw). `restored` says the history already holds model replies, which makes a first request a resume.
 */
export function compare(previous: Print | undefined, next: Print, restored: boolean) {
  if (previous === undefined) return { reason: restored ? ("resume" as const) : ("initial" as const), kept: 0 }
  const kept = next.messages.findIndex((message, index) => previous.messages[index] !== message)
  const prefix = kept < 0 ? next.messages.length : kept
  // The previous request's messages must all still lead this one: anything else rewrote the series.
  const startsSeries = previous.system !== next.system || prefix < previous.messages.length
  const changed = (Object.keys(next.parts) as Array<keyof Print["parts"]>).filter(
    (key) => previous.parts[key] !== next.parts[key],
  )
  if (previous.header !== next.header) return { reason: "change" as const, startsSeries, changed, kept: prefix }
  if (startsSeries)
    return {
      reason: "series" as const,
      startsSeries,
      changed: previous.system !== next.system ? ["system"] : [],
      kept: prefix,
    }
  return { reason: undefined, kept: prefix }
}

/** Each session's last primary request; the oldest go first. */
export class Memory {
  private readonly sessions = new Map<string, Print>()

  constructor(private readonly size = 256) {}

  /** Records `next` and answers its comparison with the session's previous request. */
  record(sessionID: string, next: Print, restored: boolean) {
    const result = compare(this.sessions.get(sessionID), next, restored)
    this.sessions.delete(sessionID)
    this.sessions.set(sessionID, next)
    if (this.sessions.size > this.size) this.sessions.delete(this.sessions.keys().next().value!)
    return result
  }

  forget(sessionID: string) {
    this.sessions.delete(sessionID)
  }
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** JSON with object keys sorted, so the same value hashes the same. */
function canonical(value: unknown): string {
  return JSON.stringify(sort(value)) ?? "null"
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
    )
  return value
}
