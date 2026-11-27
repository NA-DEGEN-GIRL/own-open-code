export * as OmoSessions from "./session.js"

import { createHash } from "node:crypto"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { SessionID } from "@opencode/schema/session-id"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Effect, Option } from "effect"

/** The harness id own-omo serves (own-protocol `OwnHarness.IDS`). */
export const HARNESS = "omo"

/** A session that runs omo: bound to the `omo` harness, in this Location (every Location's instance sees every event). */
export function isOmo(location: Context["location"], info: Pick<Session.Info, "metadata" | "location">) {
  return (
    OwnHarness.bound(info.metadata as Readonly<Record<string, unknown>> | undefined) === HARNESS &&
    info.location.directory === location.directory &&
    info.location.workspaceID === location.workspaceID
  )
}

/**
 * A top-level session own.team made for a team (06 §2.7): its main, an owner or a peer carries the metadata
 * `own.team` (children copy it, but they are never team sessions).
 */
export function isTeam(info: Pick<Session.Info, "metadata" | "parentID">) {
  return info.parentID === undefined && info.metadata?.[OwnTeam.SESSION_META] !== undefined
}

/** An admitted item own.team sent (a main request, an area message, a team update, an own.team request). */
export function fromTeam(item: SessionInbox.Item) {
  return (item.type === "user" || item.type === "synthetic") && item.payload.metadata?.source === OwnTeam.PROMPT_SOURCE
}

/**
 * Which sessions are omo's here, cached per session and forgotten when its metadata changes or it is deleted (the
 * pump calls {@link Cache.forget} and {@link Cache.drop}). Every hook and the event pump ask this first and do nothing
 * for other sessions. It also knows which omo sessions are own.team's ({@link Cache.isTeam}).
 */
export class Cache {
  private readonly known = new Map<string, Promise<boolean>>()
  private readonly teams = new Map<string, Promise<boolean>>()
  /** Sessions that got own.team's input in this process ({@link fromTeam}): an adopted owner keeps its own metadata. */
  private readonly joined = new Set<string>()

  constructor(private readonly ctx: Pick<Context, "session" | "location">) {}

  /**
   * Whether own.team runs the session (15 §3.10): its metadata says so ({@link isTeam}) or it got own.team's input in
   * this process ({@link join}).
   */
  isTeam(sessionID: string): Promise<boolean> {
    if (this.joined.has(sessionID)) return Promise.resolve(true)
    return this.remember(this.teams, sessionID, isTeam)
  }

  /** The session got own.team's input: an owner own.team adopted is a team session from now on. */
  join(sessionID: string) {
    this.joined.add(sessionID)
  }

  isOmo(sessionID: string): Promise<boolean> {
    return this.remember(this.known, sessionID, (info) => isOmo(this.ctx.location, info))
  }

  /** The session's metadata changed: both verdicts are read again (own.team's input it got still counts). */
  forget(sessionID: string) {
    this.known.delete(sessionID)
    this.teams.delete(sessionID)
  }

  /** The session is gone. */
  drop(sessionID: string) {
    this.forget(sessionID)
    this.joined.delete(sessionID)
  }

  /** `verdict` of the session, cached in `map`. A session that cannot be read (not created yet) is not remembered. */
  private remember(map: Map<string, Promise<boolean>>, sessionID: string, verdict: (info: Session.Info) => boolean) {
    const cached = map.get(sessionID)
    if (cached !== undefined) return cached
    const read: Promise<boolean> = Effect.runPromise(
      this.ctx.session.get({ sessionID: SessionID.make(sessionID) }).pipe(Effect.map(verdict), Effect.option),
    ).then((found) => {
      if (Option.isSome(found)) return found.value
      // `then` runs after the `set` below, also when the read failed at once.
      if (map.get(sessionID) === read) map.delete(sessionID)
      return false
    })
    map.set(sessionID, read)
    return read
  }
}

/**
 * The top-level omo sessions of this Location that are running, kept in the plugin's storage from
 * `session.execution.started` to the execution's end, as core keeps its execution claim (a shutdown and a crash keep
 * both). Restart recovery resumes such a run with the tools registered when its drain starts, before any hook of ours
 * runs; a mark left here makes the next plugin start start omo while it activates, which every drain waits for (15
 * §3.2). Core resumes top-level sessions only, so children are not marked.
 */
export class Busy {
  private readonly prefix: string

  constructor(private readonly ctx: Pick<Context, "storage" | "location" | "session">) {
    const location = `${ctx.location.directory}\0${ctx.location.workspaceID ?? ""}`
    this.prefix = `omo/busy/${createHash("sha256").update(location).digest("hex").slice(0, 16)}/`
  }

  mark(sessionID: string) {
    return this.ctx.session.get({ sessionID: SessionID.make(sessionID) }).pipe(
      Effect.flatMap((info) => (info.parentID === undefined ? this.ctx.storage.set(`${this.prefix}${sessionID}`, true) : Effect.void)),
      Effect.ignore,
    )
  }

  clear(sessionID: string) {
    return this.ctx.storage.remove(`${this.prefix}${sessionID}`)
  }

  /** The sessions marked running when the service last stopped, unmarked again: their resumed runs mark them anew. */
  take() {
    return this.ctx.storage.scan({ prefix: this.prefix }).pipe(
      Effect.map((result) => result.entries.map((entry) => entry.key.slice(this.prefix.length))),
      Effect.tap((ids) => Effect.forEach(ids, (id) => this.clear(id), { discard: true })),
    )
  }
}
