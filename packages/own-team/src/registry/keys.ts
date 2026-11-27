export * as Keys from "./keys.js"

import { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"

/**
 * The own.team KV keys (06 §2.4), all in the plugin's namespace of the global core KV, so every Location instance
 * sees the same values. KV has get/set/remove/scan only, no CAS: the controller is the single writer and serializes
 * each team's writes in its mutex (`Services.Base.write`). Values are plaintext JSON, never secrets.
 *
 * Value schemas: `team` → `OwnTeam.Team`, `area` → `OwnTeam.Area`, `dispatch` → `OwnTeam.Dispatch`, `op` →
 * `OwnTeam.Op`, `ig` → `OwnTeam.Integration`, `digest` → the report fold (06 §5.5–5.6), `cursor` → the last session
 * log seq read, `decision` → `OwnTeam.DecisionRecord`, `proposal` → a stored judge proposal (kept 7 days), `notices`
 * → the team's open `OwnTeam.OpenNotice`s, `talk` → `Talk.State` (area notes, watches, open asks and the audit lines of
 * area messages, 06 §5.8), `report` → `Texts.AreaTexts` (an area's whole report and relay texts), `stretch` →
 * `Texts.Stretch` (the reports of an area's direct work), `instructions` → the team's 팀 지시문 blocks.
 */
export const team = (teamID: string) => `team:${teamID}`
export const area = (teamID: string, areaID: string) => `area:${teamID}:${areaID}`
/** `seq` is per area and zero-padded to 10 digits, so a prefix scan returns an area's requests in order. */
export const dispatch = (teamID: string, areaID: string, seq: number) =>
  `dispatch:${teamID}:${areaID}:${String(seq).padStart(10, "0")}`
export const op = (teamID: string, opID: string) => `op:${teamID}:${opID}`
export const integration = (teamID: string, integrationID: string) => `ig:${teamID}:${integrationID}`
/** Events not yet told to the main, and the last wake (06 §5.6). */
export const digest = (teamID: string) => `digest:${teamID}`
/** The last session log seq read for a main or owner session (06 §5.5 따라잡기). */
export const cursor = (sessionID: string) => `cursor:${sessionID}`
/** `number` is written with four digits (`decisions/NNNN-<slug>.md`, 06 §6.6). */
export const decision = (teamID: string, number: number) => `decision:${teamID}:${String(number).padStart(4, "0")}`
export const proposal = (teamID: string, proposalID: string) => `proposal:${teamID}:${proposalID}`
/** Notices that stay open until their state ends (`Notices.keep`, `team.get` `notices`). */
export const notices = (teamID: string) => `notices:${teamID}`
/** Area notes, watches, open asks and the audit lines of area messages (06 §5.8, `dispatch/talk.ts`). */
export const talk = (teamID: string) => `talk:${teamID}`
/**
 * An area's whole report and relay texts (2026-11-14, `report/texts.ts`): kept outside the digest, which holds their
 * excerpts, so a long text costs only its own area's value.
 */
export const report = (teamID: string, areaID: string) => `report:${teamID}:${areaID}`
/** The reports of an area's current or last direct work, whole (2026-11-14, `report/texts.ts`). */
export const stretch = (teamID: string, areaID: string) => `stretch:${teamID}:${areaID}`
/** The team's 팀 지시문: the user's 일하는 방식 block per role (2026-11-14, `sessions/instructions.ts`). */
export const instructions = (teamID: string) => `instructions:${teamID}`

/** Scan prefixes. */
export const prefix = {
  teams: "team:",
  areas: (teamID: string) => `area:${teamID}:`,
  dispatches: (teamID: string, areaID?: string) =>
    areaID === undefined ? `dispatch:${teamID}:` : `dispatch:${teamID}:${areaID}:`,
  ops: (teamID?: string) => (teamID === undefined ? "op:" : `op:${teamID}:`),
  integrations: (teamID: string) => `ig:${teamID}:`,
  decisions: (teamID: string) => `decision:${teamID}:`,
  proposals: (teamID: string) => `proposal:${teamID}:`,
  reports: (teamID: string) => `report:${teamID}:`,
  stretches: (teamID: string) => `stretch:${teamID}:`,
}

/** Every key that belongs to one team (removing a team record, 06 §3.8 되돌리기). */
export function ofTeam(teamID: string) {
  return [
    team(teamID),
    prefix.areas(teamID),
    prefix.dispatches(teamID),
    prefix.ops(teamID),
    prefix.integrations(teamID),
    digest(teamID),
    prefix.decisions(teamID),
    prefix.proposals(teamID),
    notices(teamID),
    talk(teamID),
    prefix.reports(teamID),
    prefix.stretches(teamID),
    instructions(teamID),
  ]
}

/** The KV operations own.team uses. `scan` reads every page. */
export interface Store {
  get(key: string): Promise<Schema.Json | undefined>
  set(key: string, value: Schema.Json): Promise<void>
  remove(key: string): Promise<void>
  scan(prefix: string): Promise<ReadonlyArray<{ readonly key: string; readonly value: Schema.Json }>>
}

/**
 * A store over the storage of a live plugin instance (all instances see the same KV, 06 §2.4). `storage()` answers
 * `undefined` when no instance is alive: every call then fails, and the controller resumes its work with the next
 * instance (06 §2.6 "수명의 한계" (b)).
 */
export function store(storage: () => StorageDomain | undefined): Store {
  const live = () => {
    const current = storage()
    if (!current) throw new Error("own.team: no live plugin instance for KV access")
    return current
  }
  return {
    get: (key) => live().get(key),
    set: (key, value) => live().set(key, value),
    remove: (key) => live().remove(key),
    scan: async (scanPrefix) => {
      const pages = async (after: string | undefined): Promise<Array<{ key: string; value: Schema.Json }>> => {
        const page = await live().scan({ prefix: scanPrefix, after, limit: 1_000 })
        const entries = page.entries.map((entry) => ({ key: entry.key, value: entry.value }))
        return page.next === undefined ? entries : [...entries, ...(await pages(page.next))]
      }
      return pages(undefined)
    },
  }
}

/** A value made JSON for `set` (schemas encode to plain data; this checks it and gives it the `Json` type). */
export const toJson = Schema.decodeUnknownSync(Schema.Json)
