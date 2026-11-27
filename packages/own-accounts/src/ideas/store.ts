export * as IdeaStore from "./store.js"

import { Option, Schema } from "effect"
import { Ideas, Kv } from "@own/protocol"
import type { Deps } from "../deps.js"

// Idea notes (02 §9.2 "아이디어 노트") in the own-accounts KV, which core keeps in its database: one small row per idea
// under `ideas:<id>`, listed by a prefix scan. An idea is at most 2,000 characters and there are at most 1,000, so the
// board reads them all at once. The RPC boundary has already checked ids, texts and colors.

const Stored = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  color: Schema.Literals(Ideas.COLORS),
  pinned: Schema.Boolean,
  rev: Schema.Int,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
const decode = Schema.decodeUnknownOption(Stored)
const toJson = Schema.decodeUnknownSync(Schema.Json)

export type Idea = typeof Stored.Type

export type PutResult =
  | { readonly type: "ok"; readonly idea: Idea }
  | { readonly type: "conflict"; readonly current: Idea | null }
  | { readonly type: "limit" }

export type RemoveResult =
  | { readonly type: "removed"; readonly rev: number }
  | { readonly type: "missing" }
  | { readonly type: "conflict"; readonly current: Idea }

type Store = Pick<Deps, "ctx" | "runtime" | "clock">

/** Scan page size; the limit is 1,000 ideas, so a full board is two pages. */
const PAGE = 500

/** Every idea. A row this build cannot read fails the call instead of hiding the idea. */
export async function list(deps: Store): Promise<readonly Idea[]> {
  const page = async (after?: string): Promise<readonly Idea[]> => {
    const result = await deps.ctx.storage.scan({ prefix: Kv.ideasPrefix, limit: PAGE, ...(after ? { after } : {}) })
    const ideas = result.entries.map((entry) =>
      Option.getOrThrowWith(decode(entry.value), () => new Error(`idea row ${entry.key} is unreadable`)),
    )
    return result.next ? [...ideas, ...(await page(result.next))] : ideas
  }
  return page()
}

/**
 * Saves when `baseRev` is the stored revision (0: no such idea, which creates it); otherwise the stored idea comes back
 * as the conflict. Runs under the runtime's notes mutex, so the count of a create and the revision check of every save
 * never interleave with another device's save.
 */
export function put(
  deps: Store,
  input: {
    readonly id: string
    readonly text?: string
    readonly color?: Ideas.Color
    readonly pinned?: boolean
    readonly createdAt?: number
    readonly baseRev: number
  },
): Promise<PutResult> {
  return deps.runtime.notes.run(async () => {
    const current = await get(deps, input.id)
    if ((current?.rev ?? 0) !== input.baseRev) return { type: "conflict", current: current ?? null }
    if (!current && (await list(deps)).length >= Ideas.MAX) return { type: "limit" }
    const now = deps.clock.now()
    const idea: Idea = {
      id: input.id,
      text: input.text ?? current?.text ?? "",
      color: input.color ?? current?.color ?? "yellow",
      pinned: input.pinned ?? current?.pinned ?? false,
      rev: input.baseRev + 1,
      // A restored idea keeps its place; a time from the future would pin it above every new one.
      createdAt: current?.createdAt ?? Math.min(input.createdAt ?? now, now),
      updatedAt: now,
    }
    await deps.ctx.storage.set(Kv.idea(input.id), toJson(idea))
    return { type: "ok", idea }
  })
}

/** Removes an idea; with `baseRev`, only while that is the stored revision. */
export function remove(deps: Store, input: { readonly id: string; readonly baseRev?: number }): Promise<RemoveResult> {
  return deps.runtime.notes.run(async () => {
    const current = await get(deps, input.id)
    if (!current) return { type: "missing" }
    if (input.baseRev !== undefined && input.baseRev !== current.rev) return { type: "conflict", current }
    await deps.ctx.storage.remove(Kv.idea(input.id))
    return { type: "removed", rev: current.rev }
  })
}

async function get(deps: Store, id: string) {
  const stored = await deps.ctx.storage.get(Kv.idea(id))
  if (stored === undefined) return undefined
  return Option.getOrThrowWith(decode(stored), () => new Error(`idea row ${id} is unreadable`))
}
