// Area owner sessions (06 §6.2 step 3, §10.1, TG9/TG15/TG16 creation part): the new id goes to `owner.pending` before
// `session.create` (a retry adopts it), the model is the area main or the team main's current Ref (`팀과 같게`), the
// owner's team allows only, approval mode without `computerUse`, `session.preset.apply{area.preset, team}`, the role
// (and handoff) entries, then the registry. Fake loopback service and own.accounts answers; nothing real is reached.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { TeamSettings } from "../../src/ops/settings.js"
import { Keys } from "../../src/registry/keys.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Permissions } from "../../src/tools/permissions.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, MODEL, TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { type FakeService, type Recorded, session, start } from "../support/service.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
const services: FakeService[] = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})

const AREA_PRESET = Preset.ID.create()
const STAR = Preset.ID.create()
const TEAM: Preset.Team = { teamID: TEAM_ID, role: "owner", accounts: [], pinned: [] }
const TEAM_MAIN = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-team", providerID: "openai", variant: "high" })
const CLAUDE = Schema.decodeUnknownSync(Model.Ref)({ id: "claude-x", providerID: "anthropic" })

interface Body {
  readonly id: string
  readonly title?: string
  readonly model?: unknown
  readonly location: { readonly directory: string }
  readonly permissions?: ReadonlyArray<{ readonly action: string }>
  readonly metadata?: Readonly<Record<string, unknown>>
}

function sessions(service: FakeService, onCreate: (body: Body) => void = () => {}) {
  const entries = new Map<string, Map<string, unknown>>()
  const add = (input: Parameters<typeof session>[0]) => {
    const view = session(input)
    entries.set(input.id, new Map())
    service.routes.set(`GET /api/session/${input.id}`, () => Response.json({ data: view }))
    service.routes.set(`GET /api/experimental/session/${input.id}/instructions/entries`, () =>
      Response.json({ data: [...(entries.get(input.id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF])
      service.routes.set(`PUT /api/experimental/session/${input.id}/instructions/entries/${key}`, (request) => {
        entries.get(input.id)?.set(key, (request.body as { readonly value: unknown }).value)
        return new Response(null, { status: 204 })
      })
    return view
  }
  service.routes.set("POST /api/session", (request) => {
    const body = request.body as Body
    onCreate(body)
    if (entries.has(body.id)) return service.routes.get(`GET /api/session/${body.id}`)!(request)
    return Response.json({
      data: add({
        id: body.id,
        directory: body.location.directory,
        ...(body.model === undefined ? {} : { model: body.model as typeof MODEL }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      }),
    })
  })
  return { entries, add }
}

/** One ChatGPT account (`codex`, provider `openai`) and the Claude slot (`claude-sub`, provider `anthropic`). */
function accounts(world: World, refuse: ReadonlyMap<string, string> = new Map()) {
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [
      { id: "acc_01", kind: "codex", providerID: "openai" },
      { id: "claude-sub", kind: "claude-sub", providerID: "anthropic" },
    ],
  }))
  world.accounts.set("presets.list", (call) => {
    const group = (call as { readonly group: string }).group
    return { groups: [{ group, defaultModel: null, ...(group === "codex" ? { star: STAR } : {}) }] }
  })
  world.accounts.set("session.approval.set", (call) => {
    const set = call as { readonly sessionID: string; readonly mode: string }
    return { mode: set.mode, patched: [set.sessionID] }
  })
  world.accounts.set("session.preset.apply", (call) => {
    const type = refuse.get((call as { readonly presetID: string }).presetID)
    if (type) throw { type, message: type, data: {} }
    return { binding: {}, resolution: null, entry: "written", dryRun: false }
  })
}

async function setup(
  input: {
    readonly owner?: OwnTeam.Owner
    readonly main?: OwnTeam.Area["main"]
    readonly refuse?: ReadonlyMap<string, string>
    readonly onCreate?: (body: Body) => void
  } = {},
) {
  const home = await tempHome()
  homes.push(home)
  const service = start()
  services.push(service)
  const world = new World()
  accounts(world, input.refuse)
  const store = sessions(service, input.onCreate)
  const harness = controller(world, {
    directory: home.root,
    clock: manual(),
    source: service.source,
    features: { teamContext: () => ({ get: async () => TEAM, push: async () => {} }) },
  })
  const record: OwnTeam.Area = {
    ...area({ slug: "inventory-ui", directory: path.join(`${home.root}-team`, "inventory-ui") }),
    name: "인벤토리 화면",
    goal: "정렬 버그와 UI",
    preset: AREA_PRESET,
    owner: input.owner ?? { sessionID: null, previous: [], attached: true },
    ...(input.main === undefined ? {} : { main: input.main }),
  }
  await harness.services.write(TEAM_ID, async () => {
    await harness.services.registry.teams.put(team({ home: home.root }))
    await harness.services.registry.areas.put(record)
  })
  store.add({ id: MAIN_SESSION, directory: home.root, model: TEAM_MAIN })
  // A main made by this build already has the current role text (`main.resume` writes it only to older mains).
  store.entries
    .get(MAIN_SESSION)
    ?.set(RoleInstructions.MAIN, RoleInstructions.main({ team: team({ home: home.root }), blocks: {} }))
  return { ...harness, home: home.root, world, service, store, record }
}

const created = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((request) => request.method === "POST" && request.path === "/api/session")

async function stored(h: Awaited<ReturnType<typeof setup>>) {
  const value = h.world.kv.get(Keys.area(TEAM_ID, h.record.id))
  return Schema.decodeUnknownSync(OwnTeam.Area)(value)
}

describe("owner.create", () => {
  test("write-ahead id, the team main's Ref, owner allows and metadata, approval, area preset with team, role", async () => {
    const pendingAtCreate: Array<string | undefined> = []
    const h: Awaited<ReturnType<typeof setup>> = await setup({
      onCreate: () => {
        const value = h.world.kv.get(Keys.area(TEAM_ID, "ar_inventory-ui"))
        pendingAtCreate.push(Schema.decodeUnknownSync(OwnTeam.Area)(value).owner.pending)
      },
    })
    const result = await h.services.features().owner.create({ teamID: TEAM_ID, areaID: h.record.id })
    if (!result.ok) throw new Error(result.message)
    // 6.2 step 3: the id was in the registry before session.create ran.
    expect(pendingAtCreate).toEqual([result.sessionID])

    const [create] = created(h.service.requests)
    expect(create?.query["location[directory]"]).toBe(h.record.directory)
    expect(create?.body).toEqual({
      id: result.sessionID,
      title: "인벤토리 화면 · 담당",
      model: TEAM_MAIN,
      location: { directory: h.record.directory },
      metadata: { "own.team": { role: "owner", teamID: TEAM_ID, areaID: h.record.id } },
      permissions: Permissions.rules("owner").map((rule) => ({ ...rule })),
    })
    expect((create?.body as Body).permissions?.some((rule) => rule.action === "computer")).toBe(false)

    const approval = h.world.calls.find((call) => call.method === "session.approval.set")
    expect(approval?.input).toEqual({ sessionID: result.sessionID, mode: "ask" })
    expect(h.world.calls.find((call) => call.method === "session.preset.apply")?.input).toEqual({
      sessionID: result.sessionID,
      presetID: AREA_PRESET,
      team: TEAM,
    })
    const role = h.store.entries.get(result.sessionID)?.get(RoleInstructions.OWNER)
    expect(role).toBe(RoleInstructions.owner({ team: team({ home: h.home }), area: h.record, blocks: {} }))
    expect(String(role)).toContain("인벤토리 화면")
    expect(String(role)).toContain("정렬 버그와 UI")
    expect(h.store.entries.get(result.sessionID)?.has(RoleInstructions.HANDOFF)).toBe(false)

    // A first owner: the registry names it, `pending` is cleared, and the change is announced.
    const after = await stored(h)
    expect(after.owner).toEqual({ sessionID: result.sessionID, previous: [], attached: true })
    expect(after.preset).toBe(AREA_PRESET)
    expect(h.published.some((event) => event.name === "area.changed")).toBe(true)
    await h.close()
  })

  test("the area main's model, the caller's approval mode and the handoff entry", async () => {
    const h = await setup({ main: { model: CLAUDE, chosenBy: "user" } })
    const result = await h.services.features().owner.create({
      teamID: TEAM_ID,
      areaID: h.record.id,
      approval: "read-only",
      handoff: "# 인계: 인벤토리 화면\n## 남은 것\n- 정렬 테스트",
    })
    if (!result.ok) throw new Error(result.message)
    expect((created(h.service.requests)[0]?.body as Body).model).toEqual(CLAUDE)
    expect(h.world.calls.find((call) => call.method === "session.approval.set")?.input).toEqual({
      sessionID: result.sessionID,
      mode: "read-only",
    })
    expect(h.store.entries.get(result.sessionID)?.get(RoleInstructions.HANDOFF)).toContain("## 남은 것")
    // A caller's model wins over both.
    const other = await setup()
    const chosen = await other.services
      .features()
      .owner.create({ teamID: TEAM_ID, areaID: other.record.id, model: MODEL })
    if (!chosen.ok) throw new Error(chosen.message)
    expect((created(other.service.requests)[0]?.body as Body).model).toEqual(MODEL)
    await h.close()
    await other.close()
  })

  test("a pending id from an interrupted attempt is adopted, not replaced", async () => {
    const pending = SessionID.make("ses_owner0000000000000000000pending")
    const h = await setup({ owner: { sessionID: null, pending, previous: [], attached: true } })
    // The interrupted attempt got as far as the role entry.
    h.store.add({ id: pending, directory: h.record.directory, model: TEAM_MAIN })
    h.store.entries
      .get(pending)
      ?.set(
        RoleInstructions.OWNER,
        RoleInstructions.owner({ team: team({ home: h.home }), area: h.record, blocks: {} }),
      )
    const result = await h.services.features().owner.create({ teamID: TEAM_ID, areaID: h.record.id })
    expect(result).toEqual({ ok: true, sessionID: pending })
    expect((created(h.service.requests)[0]?.body as Body).id).toBe(pending)
    expect((await stored(h)).owner).toEqual({ sessionID: pending, previous: [], attached: true })
    // The equal role entry is not written again.
    expect(h.service.requests.filter((request) => request.method === "PUT")).toHaveLength(0)
    await h.close()
  })

  test("a rotation (the area still has an owner) keeps `pending` for the swap", async () => {
    const current = SessionID.make("ses_owner000000000000000000current")
    const h = await setup({ owner: { sessionID: current, previous: [], attached: true } })
    const result = await h.services.features().owner.create({ teamID: TEAM_ID, areaID: h.record.id })
    if (!result.ok) throw new Error(result.message)
    expect(result.sessionID).not.toBe(current)
    expect((await stored(h)).owner).toEqual({
      sessionID: current,
      pending: result.sessionID,
      previous: [],
      attached: true,
    })
    await h.close()
  })

  test("the owner note and what 담당 대화 바꾸기 still has to release stay through the first owner and a rotation's new id", async () => {
    const pending = SessionID.make("ses_owner0000000000000000000pending")
    const current = SessionID.make("ses_owner000000000000000000current")
    const released = SessionID.make("ses_owner00000000000000000released")
    const kept = { note: "화면 정렬을 맡은 대화", release: [released] }
    // The released conversation is there but answers nothing yet, so a sweep in between leaves it listed.
    const seated = async (owner: OwnTeam.Owner) => {
      const h = await setup()
      h.world.sessions.set(released, { id: released, directory: h.record.directory, permissions: [] })
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...h.record, owner }))
      return h
    }
    const first = await seated({ sessionID: null, pending, previous: [], attached: true, ...kept })
    const made = await first.services.features().owner.create({ teamID: TEAM_ID, areaID: first.record.id })
    expect(made).toEqual({ ok: true, sessionID: pending })
    expect((await stored(first)).owner).toEqual({ sessionID: pending, previous: [], attached: true, ...kept })
    const rotating = await seated({ sessionID: current, previous: [], attached: true, ...kept })
    const next = await rotating.services.features().owner.create({ teamID: TEAM_ID, areaID: rotating.record.id })
    if (!next.ok) throw new Error(next.message)
    expect((await stored(rotating)).owner).toEqual({
      sessionID: current,
      pending: next.sessionID,
      previous: [],
      attached: true,
      ...kept,
    })
    await first.close()
    await rotating.close()
  })

  test("an area preset of another group becomes the group's ★; a team R4 refusal binds 평소대로 and keeps it", async () => {
    const wrong = await setup({ refuse: new Map([[AREA_PRESET, "preset_wrong_group"]]) })
    const moved = await wrong.services.features().owner.create({ teamID: TEAM_ID, areaID: wrong.record.id })
    if (!moved.ok) throw new Error(moved.message)
    expect(
      wrong.world.calls.filter((call) => call.method === "session.preset.apply").map((call) => call.input),
    ).toMatchObject([{ presetID: AREA_PRESET }, { presetID: STAR }])
    expect((await stored(wrong)).preset).toBe(STAR)
    await wrong.close()

    const r4 = await setup({
      refuse: new Map([
        [AREA_PRESET, "same_company_subscription"],
        [STAR, "same_company_subscription"],
      ]),
    })
    const bound = await r4.services.features().owner.create({ teamID: TEAM_ID, areaID: r4.record.id })
    if (!bound.ok) throw new Error(bound.message)
    expect(
      r4.world.calls.filter((call) => call.method === "session.preset.apply").map((call) => call.input),
    ).toMatchObject([{ presetID: AREA_PRESET }, { presetID: STAR }, { presetID: Preset.builtinID("codex") }])
    expect((await stored(r4)).preset).toBe(AREA_PRESET)
    await r4.close()
  })

  test("refusals: unknown team or area, a broken area, an unknown team main model", async () => {
    const h = await setup()
    const features = h.services.features()
    expect(
      await features.owner.create({ teamID: OwnTeam.TeamID.make("tm_000000000000"), areaID: h.record.id }),
    ).toMatchObject({
      ok: false,
      error: "not_found",
      data: { what: "team" },
    })
    expect(await features.owner.create({ teamID: TEAM_ID, areaID: OwnTeam.AreaID.make("ar_nothing") })).toMatchObject({
      ok: false,
      error: "not_found",
      data: { what: "area" },
    })
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({ ...h.record, state: "broken", broken: { why: "missing", at: 0 } }),
    )
    expect(await features.owner.create({ teamID: TEAM_ID, areaID: h.record.id })).toMatchObject({
      ok: false,
      error: "broken",
      data: { why: "missing" },
    })
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put(h.record))
    h.service.routes.delete(`GET /api/session/${MAIN_SESSION}`)
    expect(await features.owner.create({ teamID: TEAM_ID, areaID: h.record.id })).toMatchObject({
      ok: false,
      error: "internal_error",
    })
    expect(created(h.service.requests)).toHaveLength(0)
    await h.close()
  })
})

describe("owner.role after a settings save (2026-11-14)", () => {
  test("once per controller; owner.stale brings it up again once, with the settings and the owner block of now", async () => {
    const current = SessionID.make("ses_owner000000000000000000current")
    const h = await setup({ owner: { sessionID: current, previous: [], attached: true } })
    h.store.add({ id: current, directory: h.record.directory, model: TEAM_MAIN })
    const puts = () =>
      h.service.requests.filter((request) => request.method === "PUT" && request.path.includes(current)).length
    const text = () => String(h.store.entries.get(current)?.get(RoleInstructions.OWNER))
    const role = () => h.services.features().owner.role?.({ teamID: TEAM_ID, areaID: h.record.id })
    await role()
    await role()
    expect(puts()).toBe(1)
    expect(text()).toContain("역할: 정렬 버그와 UI")
    // The shared fixture writes `directHold: false`: no hold sentence yet.
    expect(text()).not.toContain("'직접 작업'이 된다")

    expect(await TeamSettings.write(h.services, TEAM_ID, { policy: { directHold: true } })).toMatchObject({ ok: true })
    await role()
    await role()
    expect(puts()).toBe(2)
    expect(text()).toContain("- 사용자가 이 대화에 말하면 이 영역은 '직접 작업'이 된다.")

    await TeamSettings.write(h.services, TEAM_ID, { instructions: { owner: "- 보고는 영어로 한다." } })
    await role()
    expect(puts()).toBe(3)
    expect(text()).toEndWith(`${RoleInstructions.GUARD}
- 보고는 영어로 한다.`)

    // The peer block and the main block are not the owner's: nothing to write.
    await TeamSettings.write(h.services, TEAM_ID, { instructions: { peer: "- 짧게 답한다.", main: "- 짧게 답한다." } })
    await role()
    expect(puts()).toBe(3)
    // An area edit writes it at once through refresh, and counts as up to date.
    expect(await h.services.features().owner.refresh?.({ teamID: TEAM_ID, areaID: h.record.id })).toEqual({ ok: true })
    await role()
    expect(puts()).toBe(3)
    await h.close()
  })
})

describe("the owner role passes the main's work on (06 §5.5, 2026-10-16)", () => {
  test("it names relay and what only the team main can do", () => {
    const role = RoleInstructions.owner({
      team: { target: "main", policy: OwnTeam.POLICY },
      area: { name: "화면", goal: "", directory: "D:/w/ui", branch: "ui", shape: "plain" },
      blocks: {},
    })
    expect(role).toContain('team_report(kind:"relay", text:"<사용자 말 그대로>")')
    expect(role).toContain("새 영역, 나누기, 묶기, 영역 끝내기, 팀에서 빼기, 대화 옮기기, 다른 영역에 맡길 일")
    expect(role).toContain("팀 메인 대화에서 묻는다고 알린다")
  })
})
