// 별칭 (`Owner.alias`, feature `owner-alias`, 2026-11-27): `area.edit{alias}` writes the user's short name on the owner
// seat (trimmed, at most 12 characters on one line, an empty one removes it, unique without case against the team's
// active area names, slugs, aliases and peer labels and keys), the seat keeps it across a rotation, the main's tools
// find the area by it (an exact id or name still wins) and the main's team update names the area `별칭 · 영역(slug)`,
// while an owner's own view, its role entry and its conversation title never carry it. Fake contexts over one world,
// the real @own/runtime on a temp OWN_HOME, a manual clock; fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Log } from "../../src/log.js"
import { OwnerAlias } from "../../src/registry/alias.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { OwnerSession } from "../../src/sessions/owner.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { MainTools } from "../../src/tools/main.js"
import { manual } from "../support/clock.js"
import { type FakeService, start } from "../support/service.js"
import {
  MAIN_SESSION,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  buildId,
  boot,
  call,
  controller,
  managedEnv,
  team,
  tempHome,
  type Registered,
} from "../support/context.js"

const restore = managedEnv()
const services: FakeService[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterAll(async () => {
  for (const service of services) await service.stop()
  for (const cleanup of cleanups.reverse()) await cleanup()
  restore()
})

const T0 = Date.UTC(2026, 10, 27, 3, 0, 0)
const UI = OwnTeam.AreaID.make("ar_ui")
const SAVE = OwnTeam.AreaID.make("ar_save")
const SAVE_OWNER = SessionID.make("ses_owner000000000000000000002")
const PEER = SessionID.make("ses_peer0000000000000000000001")

async function setup() {
  const home = await tempHome()
  cleanups.push(() => home[Symbol.asyncDispose]())
  const service = start()
  services.push(service)
  for (const id of [MAIN_SESSION, OWNER_SESSION, SAVE_OWNER, PEER]) {
    service.routes.set(`GET /api/session/${id}/inbox`, () => Response.json({ data: [] }))
    service.routes.set(`GET /api/session/${id}/message`, () => Response.json({ data: [], cursor: {} }))
  }
  const h = controller(new World(), { directory: home.root, clock: manual(T0), source: service.source })
  cleanups.push(h.close)
  const ui: OwnTeam.Area = { ...area({ slug: "ui", directory: path.join(home.root, "ui") }), name: "UI" }
  const save: OwnTeam.Area = {
    ...area({ slug: "save", directory: path.join(home.root, "save") }),
    name: "세이브",
    owner: { sessionID: SAVE_OWNER, previous: [], attached: true },
    peers: [
      { key: "reviewer", sessionID: PEER, label: "리뷰어", role: "", attached: true, origin: "registered", at: T0 },
    ],
  }
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home: home.root }))
    await h.services.registry.areas.put(ui)
    await h.services.registry.areas.put(save)
  })
  const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: Log.silent })
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const loose = handlers as unknown as Registered["handlers"]
  const edit = (input: Readonly<Record<string, unknown>>, areaID: OwnTeam.AreaID = UI) =>
    call({ definition: { methods: {} }, handlers: loose, emitted: [], disposed: false }, "area.edit", {
      teamID: TEAM_ID,
      areaID,
      ...input,
    })
  const stored = async (areaID: OwnTeam.AreaID = UI) => (await h.services.registry.areas.get(TEAM_ID, areaID))!
  return { ...h, ui, save, edit, stored }
}

describe("area.edit{alias} (별칭)", () => {
  test("health lists `owner-alias`", async () => {
    await using home = await tempHome()
    const booted = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: buildId("owner-alias"), lingerSeconds: 0, logLevel: "error" },
    })
    cleanups.push(booted.cleanup)
    const health = (await call(booted.registrations[0]!, "health", {})) as OwnTeam.Health
    expect(health.features).toContain("owner-alias")
    await booted.cleanup()
  })

  test("written on the seat, trimmed, beside the note; another edit keeps it; an empty one removes it", async () => {
    const h = await setup()
    expect(await h.edit({ alias: "  민지 " })).toMatchObject({
      area: { id: UI, owner: { sessionID: OWNER_SESSION, alias: "민지" } },
    })
    expect(await h.stored()).toEqual({ ...h.ui, owner: { ...h.ui.owner, alias: "민지" } })
    await h.edit({ note: "화면 담당", userMade: true })
    expect((await h.stored()).owner).toMatchObject({ alias: "민지", note: "화면 담당" })
    expect(await h.edit({ alias: "" })).toMatchObject({ area: { id: UI } })
    expect("alias" in (await h.stored()).owner).toBe(false)
    expect((await h.stored()).owner.note).toBe("화면 담당")
  })

  test("at most 12 characters on one line: longer, a line break or an `ar_` start is refused and nothing is written", async () => {
    const h = await setup()
    const fits = "가".repeat(OwnTeam.OWNER_ALIAS_MAX)
    expect(await h.edit({ alias: fits })).toMatchObject({ area: { owner: { alias: fits } } })
    for (const alias of [`${fits}a`, "민\n지", "민\t지", "ar_ui"])
      expect(await h.edit({ alias })).toEqual({
        type: "seat_invalid",
        message: "별칭은 줄바꿈 없이 12자 이하로 적어요",
        data: { why: "alias" },
      })
    expect((await h.stored()).owner.alias).toBe(fits)
  })

  test("unique without case: another area's name, slug or alias and any peer's label or key are taken", async () => {
    const h = await setup()
    expect(await h.edit({ alias: "Mina" }, SAVE)).toMatchObject({ area: { owner: { alias: "Mina" } } })
    for (const alias of ["세이브", "SAVE", "mina", "리뷰어", "Reviewer"])
      expect(await h.edit({ alias })).toMatchObject({ type: "seat_invalid", data: { why: "alias-taken" } })
    expect("alias" in (await h.stored()).owner).toBe(false)
    // The area's own name and slug are no clash; a retired area's names are free again.
    expect(await h.edit({ alias: "ui" })).toMatchObject({ area: { owner: { alias: "ui" } } })
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...h.save, state: "retired" }))
    expect(await h.edit({ alias: "세이브" })).toMatchObject({ area: { owner: { alias: "세이브" } } })
  })

  test("the seat keeps it across a rotation or a seat move (`OwnerSession.carried`)", () => {
    const owner: OwnTeam.Owner = { sessionID: OWNER_SESSION, previous: [], attached: true, alias: "민지", note: "n" }
    expect(OwnerSession.carried(owner)).toEqual({ alias: "민지", note: "n" })
  })
})

describe("the main's words (별칭)", () => {
  test("the main's tools find the area by its alias without case; an exact id or name wins", async () => {
    const h = await setup()
    await h.edit({ alias: "민지" })
    await h.edit({ alias: "Bo" }, SAVE)
    expect((await MainTools.area(h.services, TEAM_ID, "민지"))?.id).toBe(UI)
    expect((await MainTools.area(h.services, TEAM_ID, " bo "))?.id).toBe(SAVE)
    expect((await MainTools.area(h.services, TEAM_ID, "ui"))?.id).toBe(UI)
    expect((await MainTools.area(h.services, TEAM_ID, "세이브"))?.id).toBe(SAVE)
    expect(await MainTools.area(h.services, TEAM_ID, "지민")).toBeUndefined()
    // A newer area named like an alias is found by its name first.
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({ ...area({ slug: "bo", directory: path.join(h.ui.directory, "..", "bo") }) }),
    )
    expect((await MainTools.area(h.services, TEAM_ID, "bo"))?.id).toBe(OwnTeam.AreaID.make("ar_bo"))
  })

  test("the main's update names the area `별칭 · 영역(slug)`; an owner's own line and an area without one stay as before", async () => {
    const h = await setup()
    await h.edit({ alias: "민지" })
    const render = h.services.features().digest.render
    const main = (await render({ teamID: TEAM_ID })).split("\n")
    expect(main).toContain("- 민지 · UI(ui): 쉬는 중")
    expect(main).toContain("- 세이브: 쉬는 중")
    expect((await render({ teamID: TEAM_ID, areaID: UI })).split("\n")).toContain("- 민지 · UI(ui): 쉬는 중")
    // The owner's own view: its line has no alias; the other areas see it beside its name.
    const own = await render({ teamID: TEAM_ID, areaID: UI, viewer: {} })
    expect(own.split("\n")).toContain("- UI: 쉬는 중")
    expect(own).not.toContain("민지")
    const other = (await render({ teamID: TEAM_ID, areaID: SAVE, viewer: {} })).split("\n")
    expect(other.some((line) => line.startsWith("  · 민지 · UI(ui) · "))).toBe(true)
  })

  test("never in the owner's role entry or its title", async () => {
    const h = await setup()
    await h.edit({ alias: "민지" })
    const stored = await h.stored()
    expect(RoleInstructions.owner({ team: team({ home: h.ui.directory }), area: stored, blocks: {} })).not.toContain(
      "민지",
    )
    expect(OwnerAlias.label(stored)).toBe("민지 · UI")
    expect(OwnerAlias.label(h.ui)).toBe("UI")
  })
})
