// An adopted owner gets the team at its first main request and loses it when the area leaves (06 §3.7, §2.8, §8.2;
// TG16 adopted delta 1 and the approval tail): `Permissions.write` writes exactly the owner's team allows by
// read-merge-write, then own.accounts `session.approval.set{mode}` with the mode the session had (`custom` skipped,
// never `computerUse`); the role entry is not written again when it holds the same text; the area preset goes on with
// the team context only when the binding differs; detach is the inverse. Fake service on 127.0.0.1, fake values.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { Keys } from "../../src/registry/keys.js"
import { OwnerSession } from "../../src/sessions/owner.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Permissions } from "../../src/tools/permissions.js"
import { F4_NOW, F4_PRESETS, F4_REFS, F4Service, f4Accounts } from "../fixtures/f4-layout.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { type FakeService, start } from "../support/service.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
const services: FakeService[] = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})

const OWNER = SessionID.make("ses_adopted00000000000000000001")
const TEAM: Preset.Team = {
  teamID: TEAM_ID,
  role: "owner",
  accounts: [Account.ID.make("acc_chatgpt01")],
  pinned: [],
}
const COMPUTER = { action: "computer", resource: "*", effect: "allow" } as const
const READ = { action: "read", resource: "*", effect: "ask" } as const

async function setup(input: { readonly preset?: Preset.ID; readonly owner?: SessionID | null } = {}) {
  const home = await tempHome()
  homes.push(home)
  const fake = start()
  services.push(fake)
  const backend = new F4Service(fake)
  const world = new World()
  const models = new Map<string, Model.Ref>([[OWNER, F4_REFS.team]])
  const accounts = f4Accounts(world.accounts, models)
  const directory = path.join(home.root, ".worktrees", "cl-cu")
  const stored = backend.add({ id: OWNER, directory, updated: F4_NOW, model: F4_REFS.team })
  world.sessions.set(OWNER, { id: OWNER, directory, permissions: [COMPUTER, READ] })
  const harness = controller(world, {
    directory: home.root,
    clock: manual(F4_NOW),
    source: fake.source,
    features: { teamContext: () => ({ get: async () => TEAM, push: async () => {} }) },
  })
  const record: OwnTeam.Area = {
    ...area({ slug: "cl-cu", directory }),
    origin: "adopted",
    owner: { sessionID: input.owner === undefined ? OWNER : input.owner, previous: [], attached: false },
    main: { model: F4_REFS.team, chosenBy: "adopted" },
    preset: input.preset ?? F4_PRESETS.review.id,
  }
  await harness.services.write(TEAM_ID, async () => {
    await harness.services.registry.teams.put(team({ home: home.root }))
    await harness.services.registry.areas.put(record)
  })
  return { ...harness, world, fake, backend, accounts, stored, record }
}

type Harness = Awaited<ReturnType<typeof setup>>

const target = (h: Harness) => ({ teamID: TEAM_ID, areaID: h.record.id })

async function stored(h: Harness) {
  return Schema.decodeUnknownSync(OwnTeam.Area)(h.world.kv.get(Keys.area(TEAM_ID, h.record.id)))
}

function calls(h: Harness, method: string) {
  return h.world.calls.filter((call) => call.method === method).map((call) => call.input)
}

/** Requests that change the owner conversation through the service. */
function writes(h: Harness) {
  return h.fake.requests
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.path}`)
}

describe("owner.attach (06 §3.7)", () => {
  test("team allows by read-merge-write, approval with the mode it had, the role, the preset with the team", async () => {
    const h = await setup()
    h.accounts.modes.set(OWNER, "full")
    expect(await h.services.features().owner.attach(target(h))).toEqual({ ok: true })
    // Exactly the owner's team allows in front; the user's rules, the computer allow included, stay after them.
    expect(h.world.sessions.get(OWNER)?.permissions).toEqual([...Permissions.rules("owner"), COMPUTER, READ])
    // own.accounts puts its bundle back last, with the mode read before the write and never `computerUse`.
    expect(calls(h, "session.approval.set")).toEqual([{ sessionID: OWNER, mode: "full" }])
    const order = h.world.calls.map((call) => call.method)
    expect(order.indexOf("session.approval.get")).toBeLessThan(order.indexOf("session.approval.set"))
    expect(h.stored.entries.get(RoleInstructions.OWNER)).toBe(
      RoleInstructions.owner({ team: team({ home: "" }), area: h.record, blocks: {} }),
    )
    expect(calls(h, "session.preset.apply")).toEqual([{ sessionID: OWNER, presetID: F4_PRESETS.review.id, team: TEAM }])
    expect((await stored(h)).owner).toEqual({ sessionID: OWNER, previous: [], attached: true })
    expect(h.published.some((event) => event.name === "area.changed")).toBe(true)

    // Attached already: a second call changes nothing.
    const before = { calls: h.world.calls.length, requests: writes(h).length }
    expect(await h.services.features().owner.attach(target(h))).toEqual({ ok: true })
    expect(h.world.calls.length).toBe(before.calls)
    expect(writes(h)).toHaveLength(before.requests)
    await h.close()
  })

  test("`custom` mode is not set again; an equal role entry and a binding that holds the preset are not rewritten", async () => {
    const h = await setup()
    h.accounts.modes.set(OWNER, "custom")
    h.stored.entries.set(
      RoleInstructions.OWNER,
      RoleInstructions.owner({ team: team({ home: "" }), area: h.record, blocks: {} }),
    )
    h.accounts.bindings.set(OWNER, { presetID: F4_PRESETS.review.id, group: "codex", team: TEAM })
    expect(await h.services.features().owner.attach(target(h))).toEqual({ ok: true })
    expect(h.world.sessions.get(OWNER)?.permissions).toEqual([...Permissions.rules("owner"), COMPUTER, READ])
    expect(calls(h, "session.approval.set")).toEqual([])
    expect(calls(h, "session.preset.apply")).toEqual([])
    expect(writes(h)).toEqual([])
    expect((await stored(h)).owner.attached).toBe(true)
    await h.close()
  })

  test("an area preset of another group: the group's ★ is bound and recorded", async () => {
    const h = await setup({ preset: Preset.builtinID("claude-sub") })
    expect(await h.services.features().owner.attach(target(h))).toEqual({ ok: true })
    expect(calls(h, "session.preset.apply")).toMatchObject([
      { presetID: Preset.builtinID("claude-sub") },
      { presetID: F4_PRESETS.star.id, team: TEAM },
    ])
    expect((await stored(h)).preset).toBe(F4_PRESETS.star.id)
    await h.close()
  })

  test("refusals: no owner conversation, a broken area, an unknown area", async () => {
    const empty = await setup({ owner: null })
    expect(await empty.services.features().owner.attach(target(empty))).toMatchObject({
      ok: false,
      error: "not_found",
      data: { what: "session" },
    })
    await empty.close()
    const h = await setup()
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({ ...h.record, state: "broken", broken: { why: "identity", at: 0 } }),
    )
    expect(await h.services.features().owner.attach(target(h))).toMatchObject({
      ok: false,
      error: "broken",
      data: { why: "identity" },
    })
    expect(
      await h.services.features().owner.attach({ teamID: TEAM_ID, areaID: OwnTeam.AreaID.make("ar_nothing") }),
    ).toMatchObject({ ok: false, error: "not_found", data: { what: "area" } })
    expect(h.world.sessions.get(OWNER)?.permissions).toEqual([COMPUTER, READ])
    await h.close()
  })
})

describe("OwnerSession.detach (06 §8.2 빼기, §3.8)", () => {
  test("the inverse of attach: allows out (Permissions.merge(current, null)), approval again, role out, team context cleared", async () => {
    const h = await setup()
    h.accounts.modes.set(OWNER, "full")
    expect(await h.services.features().owner.attach(target(h))).toEqual({ ok: true })
    const approvals = calls(h, "session.approval.set").length
    expect(await OwnerSession.detach(h.services, target(h))).toEqual({ ok: true })
    expect(h.world.sessions.get(OWNER)?.permissions).toEqual(Permissions.merge([COMPUTER, READ], null))
    expect(h.world.sessions.get(OWNER)?.permissions).toEqual([COMPUTER, READ])
    // The approval tail again (TG16): the bundle is last after the team rules went.
    expect(calls(h, "session.approval.set").slice(approvals)).toEqual([{ sessionID: OWNER, mode: "full" }])
    expect(h.stored.entries.has(RoleInstructions.OWNER)).toBe(false)
    expect(calls(h, "session.preset.apply").at(-1)).toEqual({
      sessionID: OWNER,
      presetID: F4_PRESETS.review.id,
      team: null,
    })
    expect(h.accounts.bindings.get(OWNER)).toEqual({ presetID: F4_PRESETS.review.id, group: "codex" })
    expect((await stored(h)).owner.attached).toBe(false)
    await h.close()
  })

  test("a conversation that was never attached is not written to", async () => {
    const h = await setup()
    expect(await OwnerSession.detach(h.services, target(h))).toEqual({ ok: true })
    expect(h.world.sessions.get(OWNER)?.permissions).toEqual([COMPUTER, READ])
    expect(calls(h, "session.approval.set")).toEqual([])
    expect(calls(h, "session.preset.apply")).toEqual([])
    expect(writes(h)).toEqual([])
    await h.close()
  })
})
