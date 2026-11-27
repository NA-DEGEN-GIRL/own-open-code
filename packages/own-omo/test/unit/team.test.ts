// omo in own.team's sessions (15 §3.10): a top-level session with the metadata `own.team` (a team main, owner or peer
// own.team made) or one that got own.team's input (an adopted owner) is a team session, children never are; omo's todo
// continuation gets no `session.idle` of a team session, while every other event and every other session still reach
// it. The enforcer here stands in for omo's.
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Effect } from "effect"
import { OmoSessions } from "../../src/host/session.js"
import type { V1Event } from "../../src/omo-runtime.js"
import { Runtime } from "../../src/runtime.js"

const TEAM = { [OwnTeam.SESSION_META]: { role: "owner", teamID: "tm_1", areaID: "ar_a" } }

function cache(sessions: Record<string, { metadata?: Record<string, unknown>; parentID?: string }>) {
  const reads: Array<string> = []
  // SAFETY: the fake implements the session read the cache makes.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const ctx = {
    location: { directory: "/w" },
    session: {
      get: (input: { sessionID: string }) => {
        reads.push(input.sessionID)
        const info = sessions[input.sessionID]
        return info === undefined
          ? Effect.fail(new Error("not found"))
          : Effect.succeed({ location: { directory: "/w" }, ...info })
      },
    },
  } as unknown as Pick<Context, "session" | "location">
  return { cache: new OmoSessions.Cache(ctx), reads }
}

describe("team sessions (15 §3.10)", () => {
  test("a top-level session with own.team's metadata is one, its children and other sessions are not", async () => {
    expect(OmoSessions.isTeam({ metadata: TEAM })).toBe(true)
    expect(OmoSessions.isTeam({ metadata: TEAM, parentID: "ses_parent" as never })).toBe(false)
    expect(OmoSessions.isTeam({ metadata: { "own.harness": { id: "omo", v: 1 } } })).toBe(false)
    expect(OmoSessions.isTeam({})).toBe(false)
  })

  test("own.team's input marks a session; other input does not", () => {
    const item = (type: "user" | "synthetic", source: string) =>
      ({ type, delivery: "queue", payload: { text: "x", metadata: { source } } }) as never
    expect(OmoSessions.fromTeam(item("user", OwnTeam.PROMPT_SOURCE))).toBe(true)
    expect(OmoSessions.fromTeam(item("synthetic", OwnTeam.PROMPT_SOURCE))).toBe(true)
    expect(OmoSessions.fromTeam(item("synthetic", "own.omo"))).toBe(false)
    expect(OmoSessions.fromTeam({ type: "reset", delivery: "queue", payload: {} } as never)).toBe(false)
  })

  test("the cache reads the metadata once, keeps own.team's input over a metadata change and forgets it with the session", async () => {
    const { cache: sessions, reads } = cache({ ses_main: { metadata: TEAM }, ses_adopted: {} })
    expect(await sessions.isTeam("ses_main")).toBe(true)
    expect(await sessions.isTeam("ses_main")).toBe(true)
    expect(reads).toEqual(["ses_main"])
    expect(await sessions.isTeam("ses_adopted")).toBe(false)
    sessions.join("ses_adopted")
    expect(await sessions.isTeam("ses_adopted")).toBe(true)
    sessions.forget("ses_adopted")
    expect(await sessions.isTeam("ses_adopted")).toBe(true)
    sessions.drop("ses_adopted")
    expect(await sessions.isTeam("ses_adopted")).toBe(false)
    // Not created yet: not remembered.
    expect(await sessions.isTeam("ses_later")).toBe(false)
    expect(await sessions.isTeam("ses_later")).toBe(false)
    expect(reads.filter((id) => id === "ses_later")).toHaveLength(2)
  })

  test("omo's todo continuation gets no session.idle of a team session; everything else still reaches it", async () => {
    const seen: Array<string> = []
    const enforcer = {
      handler: async (input: { readonly event: V1Event }) =>
        void seen.push(`${input.event.type} ${String(input.event.properties?.sessionID)}`),
      cancelAllCountdowns: () => {},
    }
    const other = { event: async () => {} }
    const hooks = Runtime.outsideTeams(
      { todoContinuationEnforcer: enforcer, keywordDetector: other },
      async (id) => id === "ses_team",
    )
    expect(hooks.keywordDetector).toBe(other)
    expect(hooks.todoContinuationEnforcer).toMatchObject({ cancelAllCountdowns: enforcer.cancelAllCountdowns })
    const handle = hooks.todoContinuationEnforcer!.handler
    await handle({ event: { type: "session.idle", properties: { sessionID: "ses_team" } } })
    await handle({ event: { type: "session.idle", properties: { sessionID: "ses_solo" } } })
    await handle({ event: { type: "session.error", properties: { sessionID: "ses_team" } } })
    expect(seen).toEqual(["session.idle ses_solo", "session.error ses_team"])
    expect(Runtime.outsideTeams({ todoContinuationEnforcer: null }, async () => true)).toEqual({
      todoContinuationEnforcer: null,
    })
  })
})
