export * as Journal from "./journal.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import type { Log } from "../log.js"
import { Keys } from "../registry/keys.js"
import { Confirm } from "./confirm.js"

/**
 * Op records (KV `op:<teamID>:<opID>`, 06 §2.4, §8.5): the ordered steps, their arguments and the user's confirms,
 * never an event log (TI-11). git and core stay the source of facts; the runner observes them again on resume.
 * A team has at most one active op (`running` or `waiting`). Ops are found by their own keys, not through the team
 * records: an undone enable removes its team record but keeps the op records (06 §3.8).
 */

export const ACTIVE: ReadonlySet<OwnTeam.OpState> = new Set(["running", "waiting"])

export interface Store {
  get(teamID: string, opID: string): Promise<OwnTeam.Op | undefined>
  /** An op by id alone (`op.get`, `op.confirm`): looked up among every op record. */
  find(opID: string): Promise<OwnTeam.Op | undefined>
  /** The team's ops, oldest first (op ids are ULIDs). */
  list(teamID: string): Promise<ReadonlyArray<OwnTeam.Op>>
  /** The team's running or waiting op (the newest, if a crash ever left two). */
  active(teamID: string): Promise<OwnTeam.Op | undefined>
  /** Every running op of every team (resumed when the controller starts, 06 §8.5). */
  running(): Promise<ReadonlyArray<OwnTeam.Op>>
  /** Every running or waiting op of every team (RH-20: answers given while busy are applied on resume). */
  open(): Promise<ReadonlyArray<OwnTeam.Op>>
  /** Inside the team's mutex. */
  put(op: OwnTeam.Op): Promise<void>
}

const decode = Schema.decodeUnknownOption(OwnTeam.Op)
const encode = Schema.encodeSync(OwnTeam.Op)

export function create(kv: Keys.Store, log: Log.Logger): Store {
  const read = (value: unknown, key: string) => {
    const op = Option.getOrUndefined(decode(value))
    if (op === undefined && value !== undefined) log.warn("op_record_invalid", { key })
    return op
  }
  /** Every team's ops when `teamID` is left out. */
  const list = async (teamID?: string) =>
    (await kv.scan(Keys.prefix.ops(teamID))).flatMap((entry) => {
      const op = read(entry.value, entry.key)
      return op ? [op] : []
    })
  return {
    get: async (teamID, opID) => read(await kv.get(Keys.op(teamID, opID)), Keys.op(teamID, opID)),
    find: async (opID) => (await list()).find((op) => op.id === opID),
    list,
    active: async (teamID) => (await list(teamID)).findLast((op) => ACTIVE.has(op.state)),
    running: async () => (await list()).filter((op) => op.state === "running"),
    open: async () => (await list()).filter((op) => ACTIVE.has(op.state)),
    put: (op) => kv.set(Keys.op(op.teamID, op.id), Keys.toJson(encode(op))),
  }
}

/**
 * The `busy` error's data for the team's active op (RH-20): what it waits for and since when, so the one refused can
 * say why (an op that waits only for the user's confirms, or a step that waits), nothing while it acts.
 */
export function busy(op: OwnTeam.Op) {
  const base = { teamID: op.teamID, opID: op.id, kind: op.kind }
  const confirms = op.steps.flatMap((step) =>
    step.state === "needs_confirm" && step.confirm ? [step.confirm.expiresAt - Confirm.TTL_MS] : [],
  )
  if (op.state === "waiting" && confirms.length > 0)
    return { ...base, waitingFor: "confirm" as const, since: Math.min(...confirms) }
  const waiting = op.steps.find((step) => step.state === "pending" && step.wait !== undefined)?.wait
  return waiting ? { ...base, waitingFor: "wait" as const, since: waiting.since } : base
}
