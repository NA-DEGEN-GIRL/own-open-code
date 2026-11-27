// A fake core behind own.team's self-HTTP routes for outbox tests (06 §5.1, §5.8): sessions with a folder and a local
// model (no subscription, so neither the R4 check nor own.accounts is reached), the active set, the inboxes with core's
// first-admission rule, each session's messages (what `session.messages` answers) and its log (only the watermark, like
// the local server), and the instruction entries. The fake service matches exact paths, so routes are added per
// session. Shared by the main request and the area message tests.

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { Hub } from "../../src/hub.js"
import { type FakeService, session } from "./service.js"

const PromptBody = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  delivery: optional(Schema.Literals(["steer", "queue"])),
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodePrompt = Schema.decodeUnknownSync(PromptBody)
const decodeEntry = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Unknown }))

export interface Item {
  readonly id: string
  readonly sessionID: string
  readonly type: "user" | "synthetic" | "reset"
  delivery: "steer" | "queue"
  readonly payload: { readonly text?: string; readonly metadata?: Readonly<Record<string, unknown>> }
  /** When core admitted it (`SafePoint.runs`); absent on the items this fake admits itself. */
  readonly time?: { readonly created: number }
}

export const LOCAL_MODEL = { id: "qwen3-coder", providerID: "ollama" }

export type FakeCore = ReturnType<typeof fakeCore>

export function fakeCore(service: FakeService) {
  const active = new Set<string>()
  const inbox = new Map<string, Item[]>()
  /** Each session's messages, newest first (`session.messages` with `order: "desc"`). */
  const messages = new Map<string, Array<Readonly<Record<string, unknown>>>>()
  const entries = new Map<string, Map<string, unknown>>()
  /** A prompt answers this status (and admits nothing) while set. */
  const failing = new Set<string>()
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  const items = (id: string) => inbox.get(id) ?? []
  const add = (id: string, directory: string, parentID?: string) => {
    const base = `/api/session/${id}`
    const entriesPath = `/api/experimental/session/${id}/instructions/entries`
    entries.set(id, new Map())
    // A local model: no subscription, so an adopted owner on it is attached as it is (06 §10.1 R4).
    service.routes.set(`GET ${base}`, () =>
      Response.json({ data: session({ id, directory, model: LOCAL_MODEL, ...(parentID ? { parentID } : {}) }) }),
    )
    service.routes.set(`GET ${base}/inbox`, () => Response.json({ data: items(id) }))
    service.routes.set(`GET ${base}/permission`, () => Response.json({ data: [] }))
    service.routes.set(`GET ${base}/message`, () => Response.json({ data: messages.get(id) ?? [], cursor: {} }))
    service.routes.set(`GET /api/experimental/session/${id}/log`, () => new Response(""))
    service.routes.set(`POST ${base}/prompt`, (request) => {
      if (failing.has(id)) return Response.json({ _tag: "Unavailable", message: "down" }, { status: 503 })
      const body = decodePrompt(request.body)
      // The first admission of an id wins (core session/inbox.ts:154-200).
      const existing = items(id).find((item) => item.id === body.id)
      const item: Item = existing ?? {
        id: body.id,
        sessionID: id,
        type: "user",
        delivery: body.delivery ?? "steer",
        payload: { text: body.text, ...(body.metadata ? { metadata: body.metadata } : {}) },
      }
      if (!existing) inbox.set(id, [...items(id), item])
      return Response.json({ data: item })
    })
    service.routes.set(`GET ${entriesPath}`, () =>
      Response.json({ data: [...(entries.get(id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of ["own.team.role", "own.team.peer.role", "own.team.main.role", "own.team.handoff"])
      service.routes.set(`PUT ${entriesPath}/${key}`, (request) => {
        entries.get(id)?.set(key, decodeEntry(request.body).value)
        return new Response(null, { status: 204 })
      })
  }
  return {
    active,
    inbox,
    messages,
    entries,
    failing,
    add,
    prompts: (id?: string) =>
      service.requests
        .filter((request) => request.method === "POST" && request.path.endsWith("/prompt"))
        .filter((request) => id === undefined || request.path === `/api/session/${id}/prompt`)
        .map((request) => ({ path: request.path, query: request.query, body: decodePrompt(request.body) })),
    /** Instruction entry writes to `id`. */
    puts: (id: string) =>
      service.requests.filter(
        (request) =>
          request.method === "PUT" && request.path.startsWith(`/api/experimental/session/${id}/instructions/entries/`),
      ),
    /** The owner takes its queue and runs. */
    run: (id: string) => {
      inbox.set(id, [])
      active.add(id)
    },
  }
}

export function event(type: string, data: Readonly<Record<string, unknown>>): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return { id: `evt_${type}_${Math.random()}`, created: 1, type, data } as never
}

/** A durable event of `sessionID`'s log, as the live stream carries it (`durable.seq`, `created`). */
export function durable(
  sessionID: string,
  seq: number,
  type: string,
  data: Readonly<Record<string, unknown>> = {},
  created = seq,
): Hub.Incoming {
  // SAFETY (test): a durable core event with the fields own.team reads.
  return {
    id: `evt_${sessionID}_${seq}`,
    created,
    type,
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: { sessionID, ...data },
  } as never
}

/**
 * Waits for `check`. 15 s by default (2026-11-13; 3 s and 5 s before): half the 30 s test timeout, so a miss still
 * fails here with its own message, and long enough for a loaded machine, where the git commands a session-end event
 * starts (reconcile, the heavy-folder check) hold the outbox's look back for seconds. The test files that keep a
 * copy of this (they bring their own fake core) wait as long.
 */
export async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}
