// Main 멈춤 (06 §5.3, TG7 at plugin level): the area switch, the owner's stop button turning it on, turning it off
// (the parked queue's first item becomes `steer`, then the outbox sends), 모두 멈추기 / 다시 시작, which leaves areas the
// user paused alone. The own service is a fake HTTP server on 127.0.0.1; events are published on the hub.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import type { Hub } from "../../src/hub.js"
import { Digest } from "../../src/report/digest.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { manual } from "../support/clock.js"
import { OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"
import { temp } from "../fixtures/repo.js"

// A fake core behind the self-HTTP routes: sessions, the active set, inboxes, inbox updates and interrupts.
const decodePrompt = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)
const decodeUpdate = Schema.decodeUnknownSync(Schema.Struct({ delivery: Schema.Literals(["steer", "queue"]) }))

interface Item {
  readonly id: string
  readonly sessionID: string
  readonly type: "user" | "synthetic" | "reset"
  delivery: "steer" | "queue"
  readonly payload: {
    readonly text?: string
    readonly metadata?: Readonly<Record<string, unknown>>
    readonly beforeReset?: string
  }
}

function fakeCore(service: FakeService) {
  const active = new Set<string>()
  const inbox = new Map<string, Item[]>()
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  const queue = (id: string, item: Item) => {
    inbox.set(id, [...(inbox.get(id) ?? []), item])
    // A steer wakes the stopped session: it takes its queue and runs.
    service.routes.set(`PATCH /api/session/${id}/inbox/${item.id}`, (request) => {
      item.delivery = decodeUpdate(request.body).delivery
      if (item.delivery === "steer") {
        inbox.set(id, [])
        active.add(id)
      }
      return new Response(null, { status: 204 })
    })
  }
  const add = (id: string, directory: string) => {
    service.routes.set(`GET /api/session/${id}`, () => Response.json({ data: session({ id, directory }) }))
    service.routes.set(`GET /api/session/${id}/inbox`, () => Response.json({ data: inbox.get(id) ?? [] }))
    service.routes.set(`POST /api/session/${id}/prompt`, (request) => {
      const body = decodePrompt(request.body)
      const item: Item = { id: body.id, sessionID: id, type: "user", delivery: "queue", payload: { text: body.text } }
      queue(id, item)
      return Response.json({ data: item })
    })
    service.routes.set(`POST /api/session/${id}/interrupt`, () => {
      const interrupted = active.delete(id)
      return Response.json({ interrupted })
    })
  }
  const calls = (method: string, suffix: string) =>
    service.requests.filter((request) => request.method === method && request.path.endsWith(suffix))
  return { active, inbox, add, queue, calls }
}

function event(type: string, data: Readonly<Record<string, unknown>>): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return { id: `evt_${type}_${Math.random()}`, created: 1, type, data } as never
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_ui")
const DOCS = OwnTeam.AreaID.make("ar_docs")
const API = OwnTeam.AreaID.make("ar_api")
const DOCS_OWNER = SessionID.make("ses_owner000000000000000000002")
const API_OWNER = SessionID.make("ses_owner000000000000000000003")

async function setup() {
  const box = temp("own-team-pause-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folders = {
    ui: path.join(box.root, "t", "ui"),
    docs: path.join(box.root, "t", "docs"),
    api: path.join(box.root, "t", "api"),
  }
  for (const dir of [home, ...Object.values(folders)]) fs.mkdirSync(dir, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const core = fakeCore(service)
  core.add(OWNER_SESSION, folders.ui)
  core.add(DOCS_OWNER, folders.docs)
  core.add(API_OWNER, folders.api)
  const world = new World()
  const clock = manual()
  // The main's wakes are recorded (a held area's hand-back wakes it).
  const wakes: string[] = []
  const h = controller(world, {
    directory: home,
    clock,
    source: service.source,
    features: { wake: () => ({ request: (teamID) => wakes.push(teamID) }) },
  })
  cleanups.push(() => h.close())
  const withOwner = (slug: string, directory: string, sessionID: SessionID) => {
    const base = area({ slug, directory })
    return { ...base, owner: { ...base.owner, sessionID } }
  }
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(area({ slug: "ui", directory: folders.ui }))
    await h.services.registry.areas.put(withOwner("docs", folders.docs, DOCS_OWNER))
    await h.services.registry.areas.put(withOwner("api", folders.api, API_OWNER))
  })
  const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: h.services.log })
  // SAFETY (test): every handler takes its method's input and `{signal, error}`.
  const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
  const rpc = (method: string, input: unknown) =>
    loose[method]!(input, {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    })
  const paused = async (areaID: OwnTeam.AreaID) => (await h.services.registry.areas.get(TEAM_ID, areaID))?.paused
  const dispatch = (areaID: OwnTeam.AreaID, text: string) =>
    h.services.features().admit.dispatch({ teamID: TEAM_ID, areaID, text, from: "main", kind: "task" })
  /** The user works with `areaID` directly since `since` (a held stretch). */
  const hold = (areaID: OwnTeam.AreaID, since = clock.now()) =>
    h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, areaID)
      if (current) await h.services.registry.areas.put({ ...current, directWork: { since, at: since } })
    })
  const held = async (areaID: OwnTeam.AreaID) => (await h.services.registry.areas.get(TEAM_ID, areaID))?.directWork
  const entries = async () => (await Digest.load(h.services.kv, TEAM_ID)).entries
  return { ...h, clock, core, rpc, paused, dispatch, wakes, hold, held, entries }
}

describe("area.pause", () => {
  test("on: requests wait (paused); off: the parked first item becomes steer, then the outbox sends", async () => {
    const h = await setup()
    const on = await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: true })
    expect(on).toMatchObject({ area: { id: UI, paused: "user" } })
    expect(h.published.find((item) => item.name === "area.changed")?.data).toMatchObject({
      teamID: TEAM_ID,
      areaID: UI,
      paused: "user",
    })
    expect(await h.dispatch(UI, "while paused")).toMatchObject({ state: "waiting", why: "paused" })
    expect(h.core.calls("POST", "/prompt")).toHaveLength(0)

    // What the stop left in the owner's queue: a user item and a later one.
    h.core.queue(OWNER_SESSION, { id: "msg_a", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: {} })
    h.core.queue(OWNER_SESSION, { id: "msg_b", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: {} })
    const off = await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: false })
    expect(off).toMatchObject({ area: { id: UI, paused: false } })
    const patches = h.core.calls("PATCH", "")
    expect(patches.map((request) => [request.path, request.body])).toEqual([
      [`/api/session/${OWNER_SESSION}/inbox/msg_a`, { delivery: "steer" }],
    ])
    // The woken owner works, so the request still waits; it goes when the run ends.
    expect(h.core.calls("POST", "/prompt")).toHaveLength(0)
    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await until(() => h.core.calls("POST", "/prompt").length === 1)
  })

  test("off: a context reset ahead of the parked item stays queued and the item behind it is steered (06 §6.1)", async () => {
    const h = await setup()
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: true })
    h.core.queue(OWNER_SESSION, {
      id: "msg_r",
      sessionID: OWNER_SESSION,
      type: "reset",
      delivery: "queue",
      payload: {},
    })
    // A passive notice of work started before the reset rides with the item; it is never the one woken.
    h.core.queue(OWNER_SESSION, {
      id: "msg_n",
      sessionID: OWNER_SESSION,
      type: "synthetic",
      delivery: "steer",
      payload: { text: "old job", beforeReset: "msg_r" },
    })
    h.core.queue(OWNER_SESSION, { id: "msg_a", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: {} })
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: false })
    expect(h.core.calls("PATCH", "").map((request) => [request.path, request.body])).toEqual([
      [`/api/session/${OWNER_SESSION}/inbox/msg_a`, { delivery: "steer" }],
    ])
  })

  test("off without a parked queue sends the waiting request at once; a working owner is never steered", async () => {
    const h = await setup()
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: true })
    await h.dispatch(UI, "x")
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: false })
    await until(() => h.core.calls("POST", "/prompt").length === 1)

    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: DOCS, on: true })
    h.core.active.add(DOCS_OWNER)
    h.core.queue(DOCS_OWNER, { id: "msg_c", sessionID: DOCS_OWNER, type: "user", delivery: "queue", payload: {} })
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: DOCS, on: false })
    expect(h.core.calls("PATCH", "")).toHaveLength(0)
  })

  test("unknown areas are not found; a team that is off answers team_off", async () => {
    const h = await setup()
    expect(await h.rpc("area.pause", { teamID: TEAM_ID, areaID: "ar_none", on: true })).toMatchObject({
      type: "not_found",
      data: { what: "area" },
    })
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.teams.get(TEAM_ID)
      if (current) await h.services.registry.teams.put({ ...current, state: "off" })
    })
    expect(await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: true })).toMatchObject({ type: "team_off" })
    expect(await h.rpc("team.pause", { teamID: TEAM_ID, on: true })).toMatchObject({ type: "team_off" })
  })
})

describe("the stop button (interrupted{reason: user})", () => {
  test("turns Main 멈춤 on for the owner's area, and the waiting request does not start the owner again", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    await h.dispatch(UI, "next")
    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: OWNER_SESSION, reason: "user" }))
    await until(async () => (await h.paused(UI)) === "user")
    await Bun.sleep(30)
    expect(h.core.calls("POST", "/prompt")).toHaveLength(0)
  })

  test("other reasons, and the stop of another conversation in the folder, leave it off and the outbox moves", async () => {
    const h = await setup()
    const user = "ses_user0000000000000000000001"
    h.core.add(user, path.join((await h.services.registry.areas.get(TEAM_ID, UI))!.directory))
    h.core.active.add(OWNER_SESSION)
    await h.dispatch(UI, "next")
    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: OWNER_SESSION, reason: "shutdown" }))
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: user, reason: "user" }))
    await until(() => h.core.calls("POST", "/prompt").length === 1)
    expect(await h.paused(UI)).toBe(false)
  })

  test("an interrupt while an own op runs on the area is that op's, not the user's", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, () =>
      h.services.journal.put({
        id: OwnTeam.OpID.create(),
        teamID: TEAM_ID,
        kind: "team-account",
        by: "user",
        state: "running",
        createdAt: h.clock.now(),
        steps: [],
      }),
    )
    await h.services.features().pause.stopped({ teamID: TEAM_ID, areaID: UI, sessionID: OWNER_SESSION })
    expect(await h.paused(UI)).toBe(false)
  })

  test("a stop while 담당 대화 바꾸기 holds the area changes nothing, the wait included; another area's stop still counts (C1)", async () => {
    const h = await setup()
    const target = SessionID.make("ses_target00000000000000000001")
    const args = { areaID: UI, from: OWNER_SESSION, to: target }
    await h.services.write(TEAM_ID, () =>
      h.services.journal.put({
        id: OwnTeam.OpID.create(),
        teamID: TEAM_ID,
        kind: "seat",
        by: "user",
        state: "running",
        areaID: UI,
        createdAt: h.clock.now(),
        steps: [
          {
            id: "s1",
            kind: "seat.wait",
            args,
            mode: "auto",
            state: "pending",
            wait: { why: "safe-point", detail: "session", text: "ui: 대화가 일하고 있어요", since: h.clock.now() },
          },
          { id: "s2", kind: "seat.swap", args, mode: "auto", state: "pending" },
        ],
      }),
    )
    // The user stops the old seat so that the move can go on: that is no Main 멈춤.
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: OWNER_SESSION, reason: "user" }))
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: target, reason: "user" }))
    await h.services.features().pause.stopped({ teamID: TEAM_ID, areaID: UI, sessionID: OWNER_SESSION })
    await Bun.sleep(30)
    expect(await h.paused(UI)).toBe(false)
    // The op holds its own area only.
    await h.services.features().pause.stopped({ teamID: TEAM_ID, areaID: DOCS, sessionID: DOCS_OWNER })
    expect(await h.paused(DOCS)).toBe("user")
  })

  test("only the area's current owner counts", async () => {
    const h = await setup()
    await h.services.features().pause.stopped({ teamID: TEAM_ID, areaID: UI, sessionID: DOCS_OWNER })
    expect(await h.paused(UI)).toBe(false)
    await h.services.features().pause.stopped({ teamID: TEAM_ID, areaID: UI, sessionID: OWNER_SESSION })
    expect(await h.paused(UI)).toBe("user")
  })
})

describe("team.pause (모두 멈추기 / 다시 시작)", () => {
  test("on: the owner of an area under direct work keeps its run (the user's own); its peers and others stop", async () => {
    const h = await setup()
    await h.hold(UI)
    h.core.active.add(OWNER_SESSION)
    h.core.active.add(DOCS_OWNER)
    await h.rpc("team.pause", { teamID: TEAM_ID, on: true })
    expect(h.core.calls("POST", "/interrupt").map((request) => request.path)).toEqual([
      `/api/session/${DOCS_OWNER}/interrupt`,
    ])
    expect(await h.held(UI)).toBeDefined()
  })

  test("on: 'all' where it was off, working owners interrupted; off: only 'all' areas resume", async () => {
    const h = await setup()
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: DOCS, on: true })
    h.core.active.add(OWNER_SESSION)
    h.core.active.add(DOCS_OWNER)

    const on = await h.rpc("team.pause", { teamID: TEAM_ID, on: true })
    expect(on).toMatchObject({ team: { id: TEAM_ID } })
    expect([await h.paused(UI), await h.paused(DOCS), await h.paused(API)]).toEqual(["all", "user", "all"])
    // Every working owner stops; the idle one is not touched (its Location is not woken).
    expect(
      h.core
        .calls("POST", "/interrupt")
        .map((request) => request.path)
        .toSorted(),
    ).toEqual([`/api/session/${OWNER_SESSION}/interrupt`, `/api/session/${DOCS_OWNER}/interrupt`].toSorted())
    // Own's interrupts arrive as `user`; Main 멈춤 is already on, so nothing changes.
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: OWNER_SESSION, reason: "user" }))
    await Bun.sleep(30)
    expect(await h.paused(UI)).toBe("all")

    expect(await h.dispatch(API, "waits")).toMatchObject({ state: "waiting", why: "paused" })
    await h.rpc("team.pause", { teamID: TEAM_ID, on: false })
    expect([await h.paused(UI), await h.paused(DOCS), await h.paused(API)]).toEqual([false, "user", false])
    await until(() => h.core.calls("POST", `/api/session/${API_OWNER}/prompt`).length === 1)
  })
})

describe("direct work and the switches (2026-11-14)", () => {
  test("the user's stop in a held area does not turn Main 멈춤 on", async () => {
    const h = await setup()
    await h.hold(UI)
    await h.services.features().pause.stopped({ teamID: TEAM_ID, areaID: UI, sessionID: OWNER_SESSION })
    expect(await h.paused(UI)).toBe(false)
    expect(await h.held(UI)).toBeDefined()
  })

  test("메인에게 넘기기 (Main 멈춤 off) ends it: a waking `handed` entry, the parked item woken, the request goes", async () => {
    const h = await setup()
    await h.hold(UI)
    expect(await h.dispatch(UI, "기다리는 일")).toMatchObject({ state: "waiting", why: "paused", direct: true })
    h.core.queue(OWNER_SESSION, { id: "msg_a", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: {} })
    h.clock.advance(60_000)
    const off = await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: false })
    expect(off).toMatchObject({ area: { id: UI, paused: false } })
    expect(await h.held(UI)).toBeUndefined()
    const entry = (await h.entries()).at(-1)
    expect(entry).toMatchObject({ reason: "handed", areaID: UI, wake: true })
    expect(entry?.text).toStartWith("사용자가 직접 작업을 마치고 넘김(")
    expect(entry?.text).toContain('전문: team_status{area:"ui"}')
    expect(entry?.text).toContain("그동안 보고 없음")
    expect(h.wakes).toContain(TEAM_ID)
    // The parked item is steered (it wakes the owner); the request goes once that run ends.
    expect(h.core.calls("PATCH", "").map((request) => request.path)).toEqual([
      `/api/session/${OWNER_SESSION}/inbox/msg_a`,
    ])
    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await until(() => h.core.calls("POST", `/api/session/${OWNER_SESSION}/prompt`).length === 1)
    // Nothing held: off again changes nothing and writes no second entry.
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: false })
    expect((await h.entries()).filter((item) => item.reason === "handed")).toHaveLength(1)
  })

  test("paused and held: the main's approved plan ends it as `taken` (no wake), and Main 멈춤 goes off", async () => {
    const h = await setup()
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: true })
    await h.hold(UI)
    // `taken` is the main's internal flag (its `team_area resume` plan), not on the wire.
    await h.services.features().pause.area({ teamID: TEAM_ID, areaID: UI, on: false, taken: true })
    expect(await h.paused(UI)).toBe(false)
    expect(await h.held(UI)).toBeUndefined()
    const entry = (await h.entries()).at(-1)
    expect(entry).toMatchObject({ reason: "taken", wake: false })
    expect(entry?.text).toStartWith("메인이 넘겨받음(")
  })

  test("다시 시작 does not wake a held area's parked queue and keeps its direct work; 모두 멈추기 keeps it too", async () => {
    const h = await setup()
    await h.hold(UI)
    await h.rpc("team.pause", { teamID: TEAM_ID, on: true })
    expect(await h.paused(UI)).toBe("all")
    expect(await h.held(UI)).toBeDefined()
    h.core.queue(OWNER_SESSION, { id: "msg_a", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: {} })
    h.core.queue(DOCS_OWNER, { id: "msg_d", sessionID: DOCS_OWNER, type: "user", delivery: "queue", payload: {} })
    await h.rpc("team.pause", { teamID: TEAM_ID, on: false })
    expect(await h.paused(UI)).toBe(false)
    expect(await h.held(UI)).toBeDefined()
    expect(h.core.calls("PATCH", "").map((request) => request.path)).toEqual([`/api/session/${DOCS_OWNER}/inbox/msg_d`])
    expect(await h.entries()).toEqual([])
    // Under 모두 멈추기 the area was kept, not held; 메인에게 넘기기 then ends the direct work too.
    await h.rpc("team.pause", { teamID: TEAM_ID, on: true })
    await h.rpc("area.pause", { teamID: TEAM_ID, areaID: UI, on: false })
    expect(await h.held(UI)).toBeUndefined()
    expect(await h.paused(UI)).toBe(false)
  })

  test("the hold switched off (`sweep`) hands every held area back, each with its entry", async () => {
    const h = await setup()
    await h.hold(UI)
    await h.hold(DOCS)
    await h.services.features().direct.sweep(TEAM_ID)
    expect([await h.held(UI), await h.held(DOCS), await h.held(API)]).toEqual([undefined, undefined, undefined])
    // One after another, in the registry's order.
    expect((await h.entries()).map((item) => [item.reason, item.areaID])).toEqual([
      ["handed", DOCS],
      ["handed", UI],
    ])
  })
})
