// The outbox (06 §5.2, §3.8) through RPC `own.team`: `outbox.list` with the reason it waits, `outbox.cancel`,
// `cancelAll` for disable/retire, the re-check after a cancelled queue item, pruning on resume, and the features this
// build reports. The own service is a fake HTTP server on 127.0.0.1; time is a manual clock.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Dispatches } from "../../src/registry/dispatch.js"
import type { Hub } from "../../src/hub.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import type { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import { OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"
import { temp } from "../fixtures/repo.js"

// A fake core behind the self-HTTP routes (sessions, active set, inboxes); routes are added per session id.
const decodePrompt = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

function fakeCore(service: FakeService) {
  const active = new Set<string>()
  const inbox = new Map<string, Array<Readonly<Record<string, unknown>>>>()
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  const add = (id: string, directory: string) => {
    service.routes.set(`GET /api/session/${id}`, () => Response.json({ data: session({ id, directory }) }))
    service.routes.set(`GET /api/session/${id}/inbox`, () => Response.json({ data: inbox.get(id) ?? [] }))
    service.routes.set(`POST /api/session/${id}/prompt`, (request) => {
      const body = decodePrompt(request.body)
      const item = {
        id: body.id,
        sessionID: id,
        type: "user",
        delivery: "queue",
        payload: { text: body.text, metadata: body.metadata },
      }
      inbox.set(id, [...(inbox.get(id) ?? []), item])
      return Response.json({ data: item })
    })
  }
  const prompts = () =>
    service.requests
      .filter((request) => request.method === "POST" && request.path.endsWith("/prompt"))
      .map((request) => decodePrompt(request.body))
  return { active, inbox, add, prompts }
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
const DOCS_OWNER = SessionID.make("ses_owner000000000000000000002")

async function setup() {
  const box = temp("own-team-outbox-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const ui = path.join(box.root, "home-team", "ui")
  const docs = path.join(box.root, "home-team", "docs")
  for (const dir of [home, ui, docs]) fs.mkdirSync(dir, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const core = fakeCore(service)
  core.add(OWNER_SESSION, ui)
  core.add(DOCS_OWNER, docs)
  const world = new World()
  const clock = manual()
  const h = controller(world, { directory: home, clock, source: service.source })
  cleanups.push(() => h.close())
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(area({ slug: "ui", directory: ui }))
    const second = area({ slug: "docs", directory: docs })
    await h.services.registry.areas.put({ ...second, owner: { ...second.owner, sessionID: DOCS_OWNER } })
  })
  const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: h.services.log })
  // SAFETY (test): every handler takes its method's input and `{signal, error}`.
  const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
  const rpc = (method: string, input: unknown) =>
    loose[method]!(input, {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    })
  const dispatch = (areaID: OwnTeam.AreaID, text: string) =>
    h.services.features().admit.dispatch({ teamID: TEAM_ID, areaID, text, from: "main", kind: "task" })
  return { ...h, clock, home, ui, docs, core, rpc, dispatch }
}

function ids(results: ReadonlyArray<Services.Result<{ readonly dispatchID: OwnTeam.DispatchID }>>) {
  return results.flatMap((result) => (result.ok ? [result.dispatchID] : []))
}

describe("outbox.list / outbox.cancel", () => {
  test("lists the waiting requests oldest first with the reason; a cancelled one never goes", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const [first, second] = ids([await h.dispatch(UI, "first"), await h.dispatch(UI, "second")])
    const listed = await h.rpc("outbox.list", { teamID: TEAM_ID, areaID: UI })
    expect(listed).toMatchObject({
      why: "busy",
      items: [
        { id: first, seq: 0 },
        { id: second, seq: 1 },
      ],
    })

    expect(await h.rpc("outbox.cancel", { teamID: TEAM_ID, areaID: UI, dispatchID: first })).toEqual({})
    expect(h.published.filter((item) => item.name === "outbox.changed").at(-1)?.data).toEqual({
      teamID: TEAM_ID,
      areaID: UI,
      waiting: 1,
    })
    expect(await h.rpc("outbox.cancel", { teamID: TEAM_ID, areaID: UI, dispatchID: first })).toMatchObject({
      type: "not_found",
      data: { what: "dispatch" },
    })
    expect(await h.services.registry.dispatches.find(TEAM_ID, first!)).toMatchObject({ state: "cancelled" })

    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await until(async () => (await h.services.registry.dispatches.find(TEAM_ID, second!))?.state === "sent")
    expect(h.core.prompts()).toHaveLength(1)
    expect(h.core.prompts()[0]!.metadata).toMatchObject({ "own.dispatch": { id: second } })
    expect(await h.rpc("outbox.list", { teamID: TEAM_ID, areaID: UI })).toEqual({ items: [] })
  })

  test("unknown teams and areas are not found; a team that is off cannot cancel", async () => {
    const h = await setup()
    expect(await h.rpc("outbox.list", { teamID: "tm_ffffffffffff", areaID: UI })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
    expect(await h.rpc("outbox.list", { teamID: TEAM_ID, areaID: "ar_none" })).toMatchObject({
      type: "not_found",
      data: { what: "area" },
    })
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.teams.get(TEAM_ID)
      if (current) await h.services.registry.teams.put({ ...current, state: "off" })
    })
    expect(
      await h.rpc("outbox.cancel", { teamID: TEAM_ID, areaID: UI, dispatchID: OwnTeam.DispatchID.create() }),
    ).toMatchObject({ type: "team_off" })
  })

  test("a main request the user removes from the owner's queue lets the next one go (inbox.cancelled)", async () => {
    const h = await setup()
    const [first, second] = ids([await h.dispatch(UI, "first"), await h.dispatch(UI, "second")])
    expect(await h.services.registry.dispatches.find(TEAM_ID, first!)).toMatchObject({ state: "sent" })
    expect(h.core.prompts()).toHaveLength(1)
    h.core.inbox.set(OWNER_SESSION, [])
    h.controller.hub.receive(event("session.inbox.cancelled", { sessionID: OWNER_SESSION, inboxID: "msg_x" }))
    await until(() => h.core.prompts().length === 2)
    expect(h.core.prompts()[1]!.metadata).toMatchObject({ "own.dispatch": { id: second } })
  })
})

describe("cancelAll (3.8)", () => {
  test("cancels the waiting requests of the team, or of one area, and returns them", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    h.core.active.add(DOCS_OWNER)
    const [ui1, ui2] = ids([await h.dispatch(UI, "a"), await h.dispatch(UI, "b")])
    const [docs1] = ids([await h.dispatch(DOCS, "c")])

    expect(await h.services.features().admit.cancelAll({ teamID: TEAM_ID, areaID: DOCS })).toEqual([
      { areaID: DOCS, dispatchID: docs1 },
    ])
    const all = await h.services.features().admit.cancelAll({ teamID: TEAM_ID })
    expect(all.map((item) => item.dispatchID).toSorted()).toEqual([ui1!, ui2!].toSorted())
    expect(all.every((item) => item.areaID === UI)).toBe(true)
    expect(await h.services.registry.dispatches.waiting(TEAM_ID)).toEqual([])

    h.core.active.clear()
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await Bun.sleep(40)
    expect(h.core.prompts()).toHaveLength(0)
  })
})

describe("resume", () => {
  test("drops sent and cancelled requests older than 7 days and sends what waits", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const [old] = ids([await h.dispatch(UI, "old")])
    await h.services.features().admit.cancelAll({ teamID: TEAM_ID })
    h.clock.advance(Dispatches.KEEP_MS + 1)
    const [fresh] = ids([await h.dispatch(UI, "fresh")])
    h.core.active.delete(OWNER_SESSION)
    await h.services.features().admit.resume?.()
    expect(await h.services.registry.dispatches.find(TEAM_ID, old!)).toBeUndefined()
    expect(await h.services.registry.dispatches.find(TEAM_ID, fresh!)).toMatchObject({ state: "sent" })
  })
})

describe("direct work (2026-11-14)", () => {
  /** The user works with `areaID` directly since now. */
  const hold = async (h: Awaited<ReturnType<typeof setup>>, areaID: OwnTeam.AreaID) =>
    h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, areaID)
      const since = h.clock.now()
      if (current) await h.services.registry.areas.put({ ...current, directWork: { since, at: since } })
    })

  test("a main request waits with the direct cause and no retry timer; the result says `direct`", async () => {
    const h = await setup()
    await hold(h, UI)
    const timers = h.clock.pending()
    const [first] = ids([await h.dispatch(UI, "first")])
    expect(await h.dispatch(UI, "second")).toMatchObject({ state: "waiting", why: "paused", direct: true })
    expect(h.clock.pending()).toBe(timers)
    const listed = await h.rpc("outbox.list", { teamID: TEAM_ID, areaID: UI })
    expect(listed).toMatchObject({ why: "paused", cause: { direct: true } })
    expect(JSON.stringify(listed)).not.toContain("retryAt")
    h.clock.advance(60 * 60_000)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await Bun.sleep(40)
    expect(h.core.prompts()).toHaveLength(0)
    // The other area is not held.
    expect(await h.dispatch(DOCS, "docs")).toMatchObject({ state: "queued" })
    expect(await h.services.registry.dispatches.find(TEAM_ID, first!)).toMatchObject({ state: "waiting" })
  })

  test("the hand-back releases the outbox and answers the line and the waiting count", async () => {
    const h = await setup()
    await hold(h, UI)
    await h.dispatch(UI, "first")
    h.clock.advance(1_000)
    const ended = await h.services.features().direct.end({ teamID: TEAM_ID, areaID: UI, why: "handed" })
    expect(ended?.waiting).toBe(1)
    expect(ended?.line).toStartWith("사용자가 직접 작업을 마치고 넘김(")
    await until(() => h.core.prompts().length === 1)
    expect(await h.services.features().direct.end({ teamID: TEAM_ID, areaID: UI, why: "handed" })).toBeUndefined()
  })

  test("the hold switched off (`sweep`) releases every held area", async () => {
    const h = await setup()
    await hold(h, UI)
    await hold(h, DOCS)
    await h.dispatch(UI, "ui")
    await h.dispatch(DOCS, "docs")
    expect(h.core.prompts()).toHaveLength(0)
    await h.services.features().direct.sweep(TEAM_ID)
    await until(() => h.core.prompts().length === 2)
  })
})

describe("features", () => {
  test("this build reports the outbox and Main 멈춤", () => {
    expect(TeamRpc.FEATURES).toContain("outbox")
    expect(TeamRpc.FEATURES).toContain("pause")
  })
})
