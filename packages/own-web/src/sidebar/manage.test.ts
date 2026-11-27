// Session delete, project archive and project removal (03 §19.11a) over a fake client: the project's sessions from
// every `session.list` page (no subagents, no own.import helpers), deletes a few at a time with a gone session
// counted as deleted, the archive's guard that keeps what another device unarchived, project archive and restore
// with the `own.archivedWithProject` mark (other metadata kept, failed writes rolled back, sessions archived on their
// own left alone), and the team rules (06 TI-5). The dialogs and menus run against the real server in
// e2e/session-ux/manage.pw.ts.
import { describe, expect, test } from "bun:test"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { IMPORT_META } from "@/data/import-rpc"
import type { ServerRuntime } from "@/data"
import { createOwnFlags, PROJECT_ARCHIVE_KEY } from "./flags"
import { archiveProject, deleteSessions, projectSessions, projectTeam, teamHeld } from "./manage"

type Metadata = Record<string, unknown>

function info(id: string, metadata: Metadata = {}, extra: Partial<SessionInfo> = {}) {
  // SAFETY: the code under test reads `id`, `parentID` and `metadata` only.
  return { id, projectID: "prj_1", metadata, ...extra } as unknown as SessionInfo
}

function notFound() {
  const error = new Error("gone")
  error.name = "SessionNotFoundError"
  return error
}

/** A server with sessions by id; `fail` makes `remove` / `update` of those ids throw. */
function server(input: {
  readonly sessions: SessionInfo[]
  readonly page?: number
  readonly fail?: ReadonlySet<string>
}) {
  const sessions = new Map(input.sessions.map((item) => [item.id, item]))
  const calls: Array<{ readonly method: string; readonly input: Record<string, unknown> }> = []
  let active = 0
  let peak = 0
  const page = input.page ?? 100
  const session = {
    async list(query: Record<string, unknown>) {
      calls.push({ method: "list", input: query })
      const all = [...sessions.values()]
      const start = typeof query.cursor === "string" ? Number(query.cursor) : 0
      const data = all.slice(start, start + page)
      return { data, cursor: { next: start + page < all.length ? String(start + page) : undefined } }
    },
    async get(query: { sessionID: string }) {
      calls.push({ method: "get", input: query })
      const found = sessions.get(query.sessionID)
      if (!found) throw notFound()
      return found
    },
    async update(query: { sessionID: string; metadata: Metadata }) {
      calls.push({ method: "update", input: query })
      if (input.fail?.has(query.sessionID)) throw new Error("write refused")
      const found = sessions.get(query.sessionID)!
      // SAFETY: the written metadata is plain JSON, as the real server keeps it.
      sessions.set(query.sessionID, { ...found, metadata: query.metadata } as SessionInfo)
      return sessions.get(query.sessionID)
    },
    async remove(query: { sessionID: string }) {
      calls.push({ method: "remove", input: query })
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      if (input.fail?.has(query.sessionID)) throw new Error("busy elsewhere")
      if (!sessions.delete(query.sessionID)) throw notFound()
    },
  }
  // SAFETY: the fake answers the four session methods manage.ts and flags.ts call, in their shapes.
  const client = { session } as unknown as OpenCodeClient
  return { client, sessions, calls, peak: () => peak }
}

function flagStore(client: OpenCodeClient) {
  localStorage.clear()
  return createOwnFlags({ serverKey: "manage", bus: createEventBus(), client: () => client })
}

describe("project sessions", () => {
  test("every page of the project's root sessions, without subagents or own.import's hidden helpers", async () => {
    const fake = server({
      page: 2,
      sessions: [
        info("a"),
        info("b", { "own.archived": 5 }),
        info("child", {}, { parentID: "a" }),
        info("helper", { [IMPORT_META.session]: { helper: true } }),
        info("c"),
      ],
    })
    const found = await projectSessions(fake.client, "prj_1")
    expect(found.map((item) => item.id)).toEqual(["a", "b", "c"])
    const lists = fake.calls.filter((call) => call.method === "list").map((call) => call.input)
    expect(lists).toEqual([
      { project: "prj_1", parentID: null, limit: 200, order: "desc", cursor: undefined },
      { project: "prj_1", parentID: null, limit: 200, order: "desc", cursor: "2" },
      { project: "prj_1", parentID: null, limit: 200, order: "desc", cursor: "4" },
    ])
  })
})

describe("delete", () => {
  test("deletes two at a time; a gone session counts as deleted; failures carry the reason; progress counts", async () => {
    const fake = server({ sessions: [info("a"), info("b"), info("c"), info("d")], fail: new Set(["c"]) })
    const progress: number[] = []
    const result = await deleteSessions(fake.client, ["a", "b", "c", "d", "gone"], {
      progress: (value) => progress.push(value),
    })
    expect(result.deleted.toSorted()).toEqual(["a", "b", "d", "gone"])
    expect(result.failed).toEqual([{ id: "c", reason: "busy elsewhere" }])
    expect(result.skipped).toEqual([])
    expect(progress).toEqual([1, 2, 3, 4, 5])
    expect(fake.peak()).toBe(2)
    expect([...fake.sessions.keys()]).toEqual(["c"])
    // No read first outside the archive.
    expect(fake.calls.some((call) => call.method === "get")).toBe(false)
  })

  test("from the archive: a session another device unarchived meanwhile is kept, not deleted", async () => {
    const fake = server({ sessions: [info("old", { "own.archived": 3 }), info("back", { "other.key": 1 })] })
    const result = await deleteSessions(fake.client, ["old", "back"], { archivedOnly: true })
    expect(result.deleted).toEqual(["old"])
    expect(result.skipped).toEqual(["back"])
    expect([...fake.sessions.keys()]).toEqual(["back"])
  })
})

describe("project archive", () => {
  test("archives the project's sessions with one stamp and the project mark, keeping other keys and earlier archives", async () => {
    const fake = server({
      sessions: [info("a", { "other.host": { x: 1 }, "own.pinned": 4 }), info("b"), info("own", { "own.archived": 7 })],
    })
    await createRoot(async (dispose) => {
      const flags = flagStore(fake.client)
      const result = await archiveProject(fake.client, flags, "prj_1", true)
      expect(result).toEqual({ total: 2, failed: [] })
      const a = fake.sessions.get("a")!.metadata as Metadata
      expect(a["other.host"]).toEqual({ x: 1 })
      expect(a["own.pinned"]).toBe(4)
      expect(typeof a["own.archived"]).toBe("number")
      expect(a[PROJECT_ARCHIVE_KEY]).toBe(a["own.archived"])
      // The session archived on its own was not written and carries no project mark.
      expect(fake.sessions.get("own")!.metadata).toEqual({ "own.archived": 7 })
      expect(flags.archived("a") && flags.projectArchived("a")).toBe(true)
      expect(flags.archived("own") || flags.projectArchived("own")).toBe(false)

      // Restore takes back exactly the marked sessions and drops both keys.
      flags.ingest("own", { "own.archived": 7 })
      const restored = await archiveProject(fake.client, flags, "prj_1", false)
      expect(restored).toEqual({ total: 2, failed: [] })
      expect(fake.sessions.get("a")!.metadata).toEqual({ "other.host": { x: 1 }, "own.pinned": 4 })
      expect(fake.sessions.get("b")!.metadata).toEqual({})
      expect(fake.sessions.get("own")!.metadata).toEqual({ "own.archived": 7 })
      expect(flags.archived("a") || flags.projectArchived("a")).toBe(false)
      expect(flags.archived("own")).toBe(true)
      flags.dispose()
      dispose()
    })
  })

  test("a failed write puts that session back and is reported; the others stay archived", async () => {
    const fake = server({ sessions: [info("a"), info("b")], fail: new Set(["b"]) })
    await createRoot(async (dispose) => {
      const flags = flagStore(fake.client)
      const result = await archiveProject(fake.client, flags, "prj_1", true)
      expect(result).toEqual({ total: 2, failed: ["b"] })
      expect(flags.archived("a")).toBe(true)
      expect(flags.archived("b") || flags.projectArchived("b")).toBe(false)
      flags.dispose()
      dispose()
    })
  })
})

describe("team rules (06 TI-5)", () => {
  function runtime(input: {
    readonly load: string
    readonly teams?: ReadonlyArray<{ readonly id: string; readonly projectID: string }>
    readonly list?: ReadonlyArray<{ readonly id: string; readonly projectID: string; readonly state: string }>
    readonly places?: Record<string, { readonly previous: boolean }>
  }) {
    // SAFETY: projectTeam and teamHeld read `team.state.load`, `team.state.list`, `teamsOfProject` and `placeOf`.
    return {
      team: {
        state: { load: input.load, list: input.list ?? [] },
        teamsOfProject: (projectID: string) =>
          (input.teams ?? []).filter((item) => item.projectID === projectID).map((item) => ({ team: item })),
        placeOf: (sessionID: string) => input.places?.[sessionID],
      },
    } as unknown as Pick<ServerRuntime, "team">
  }

  test("a project waits for own.team's registry (Git only) and is blocked while a team is on", () => {
    expect(projectTeam(runtime({ load: "loading" }), "prj_1", true)).toEqual({ kind: "unknown" })
    expect(projectTeam(runtime({ load: "unavailable" }), "prj_1", true)).toEqual({ kind: "unknown" })
    expect(projectTeam(runtime({ load: "idle" }), "prj_1", false)).toEqual({ kind: "off" })
    expect(projectTeam(runtime({ load: "missing" }), "prj_1", true)).toEqual({ kind: "off" })
    expect(projectTeam(runtime({ load: "ready" }), "prj_1", true)).toEqual({ kind: "off" })
    expect(projectTeam(runtime({ load: "ready", teams: [{ id: "tm_a", projectID: "prj_1" }] }), "prj_1", true)).toEqual(
      { kind: "on", teamID: "tm_a" },
    )
    // A team that is on but whose records did not load still counts.
    expect(
      projectTeam(runtime({ load: "ready", list: [{ id: "tm_b", projectID: "prj_1", state: "on" }] }), "prj_1", true),
    ).toEqual({ kind: "on", teamID: "tm_b" })
    expect(
      projectTeam(runtime({ load: "ready", list: [{ id: "tm_b", projectID: "prj_1", state: "off" }] }), "prj_1", true),
    ).toEqual({ kind: "off" })
  })

  test("a team's current main, owner or peer is held; an earlier one (지난 대화) is an ordinary conversation", () => {
    const current = runtime({ load: "ready", places: { main: { previous: false }, old: { previous: true } } })
    expect(teamHeld(current, "main")).toBe(true)
    expect(teamHeld(current, "old")).toBe(false)
    expect(teamHeld(current, "other")).toBe(false)
  })
})
