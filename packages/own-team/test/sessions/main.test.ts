// The team main session (06 §3.6 step 2, §6.3, §10.1, TG15/TG16 creation part): `session.create` at the home with the
// enabling conversation's Ref, the main's team allows only (delta 0) and the own.team metadata, then own.accounts
// `session.approval.set` (never `computerUse`), `session.preset.apply{group ★, team}` and the role entry, skipped when
// equal. Fake loopback service, fake own.accounts answers, manual clock; nothing reaches a real account.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { MainSession } from "../../src/sessions/main.js"
import { Permissions } from "../../src/tools/permissions.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, MODEL, TEAM_ID, World, controller, team, tempHome } from "../support/context.js"
import { type FakeService, type Recorded, session, start } from "../support/service.js"

const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
const services: FakeService[] = []
afterAll(async () => {
  for (const home of homes) await home[Symbol.asyncDispose]()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})

const STAR = Preset.ID.create()
const TEAM: Preset.Team = { teamID: TEAM_ID, role: "main", accounts: [], pinned: [] }
const OTHER = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-other", providerID: "openai", variant: "high" })

interface Body {
  readonly id: string
  readonly title?: string
  readonly model?: unknown
  readonly location: { readonly directory: string }
  readonly permissions?: ReadonlyArray<{ readonly action: string }>
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Sessions of the fake service: create adopts an existing id, get reads it, instruction entries are kept per session. */
function sessions(service: FakeService) {
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

/** own.accounts as the fake RPC answers it: one ChatGPT account (`codex` group) on provider `openai`. */
function accounts(world: World, input: { readonly star?: Preset.ID; readonly refuse?: ReadonlySet<string> } = {}) {
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", () => ({
    groups: [{ group: "codex", defaultModel: null, ...(input.star === undefined ? {} : { star: input.star }) }],
  }))
  world.accounts.set("session.approval.set", (call) => {
    const set = call as { readonly sessionID: string; readonly mode: string }
    return { mode: set.mode, patched: [set.sessionID] }
  })
  world.accounts.set("session.preset.apply", (call) => {
    const apply = call as { readonly presetID: string }
    if (input.refuse?.has(apply.presetID))
      throw { type: "same_company_subscription", message: "team R4", data: { accountID: "acc_02" } }
    return { binding: {}, resolution: null, entry: "written", dryRun: false }
  })
}

async function setup(
  input: {
    readonly star?: Preset.ID
    readonly refuse?: ReadonlySet<string>
    readonly team?: Preset.Team | null
  } = {},
) {
  const home = await tempHome()
  homes.push(home)
  const service = start()
  services.push(service)
  const world = new World()
  accounts(world, input)
  const store = sessions(service)
  const harness = controller(world, {
    directory: home.root,
    clock: manual(),
    source: service.source,
    ...(input.team === undefined
      ? {}
      : { features: { teamContext: () => ({ get: async () => input.team ?? null, push: async () => {} }) } }),
  })
  return { ...harness, home: home.root, world, service, store }
}

const created = (requests: ReadonlyArray<Recorded>) =>
  requests.filter((request) => request.method === "POST" && request.path === "/api/session")
const puts = (requests: ReadonlyArray<Recorded>) => requests.filter((request) => request.method === "PUT")

describe("main.create", () => {
  test("session.create with the main's allows and metadata, then approval, ★ preset with the team, role entry", async () => {
    const h = await setup({ star: STAR, team: TEAM })
    const sessionID = SessionID.make("ses_teammain000000000000000001")
    const result = await h.services.features().main.create({
      teamID: TEAM_ID,
      directory: h.home,
      sessionID,
      model: MODEL,
    })
    expect(result).toEqual({ ok: true, sessionID })

    const [create] = created(h.service.requests)
    expect(create?.query["location[directory]"]).toBe(h.home)
    expect(create?.body).toEqual({
      id: sessionID,
      title: "팀 메인",
      model: MODEL,
      location: { directory: h.home },
      metadata: { "own.team": { role: "main", teamID: TEAM_ID } },
      permissions: Permissions.rules("main").map((rule) => ({ ...rule })),
    })
    // Exactly team.main + team.member allows: no computer allow, no approval bundle (own-accounts writes that).
    expect((create?.body as Body).permissions?.map((rule) => rule.action)).toEqual(["team.main", "team.member"])

    // Order: approval, then the preset, then the role entry; never computerUse, never the enabling session's preset.
    expect(h.world.calls.map((call) => call.method)).toEqual([
      "session.approval.set",
      "accounts.list",
      "presets.list",
      "session.preset.apply",
    ])
    expect(h.world.calls[0]?.input).toEqual({ sessionID, mode: "ask" })
    expect(h.world.calls[3]?.input).toEqual({ sessionID, presetID: STAR, team: TEAM })
    expect(puts(h.service.requests)).toHaveLength(1)
    // No team record yet (enable makes the main before it writes the team): the defaults, so direct work holds.
    const role = RoleInstructions.main({ team: { policy: OwnTeam.POLICY }, blocks: {} })
    expect(h.store.entries.get(sessionID)?.get(RoleInstructions.MAIN)).toBe(role)
    expect(role).toContain("'직접 작업 중'인 영역")
    expect(role.length).toBeLessThan(2_700)
    await h.close()
  })

  test("a retry adopts the session and does not write an equal role entry again", async () => {
    const h = await setup({ star: STAR })
    const sessionID = SessionID.make("ses_teammain000000000000000002")
    const input = { teamID: TEAM_ID, directory: h.home, sessionID, model: MODEL, approval: "full" as const }
    expect(await h.services.features().main.create(input)).toEqual({ ok: true, sessionID })
    expect(await h.services.features().main.create(input)).toEqual({ ok: true, sessionID })
    expect(created(h.service.requests)).toHaveLength(2)
    expect(h.store.entries.size).toBe(1)
    expect(puts(h.service.requests)).toHaveLength(1)
    const approvals = h.world.calls.filter((call) => call.method === "session.approval.set")
    expect(approvals.map((call) => call.input)).toEqual([
      { sessionID, mode: "full" },
      { sessionID, mode: "full" },
    ])
    // No team context yet (T1.25 fills it): the binding gets no `team`.
    expect(h.world.calls.find((call) => call.method === "session.preset.apply")?.input).toEqual({
      sessionID,
      presetID: STAR,
    })
    await h.close()
  })

  test("without a ★ the group's 평소대로; a team R4 refusal of the ★ falls back to 평소대로", async () => {
    const plain = await setup()
    const first = SessionID.make("ses_teammain000000000000000003")
    await plain.services
      .features()
      .main.create({ teamID: TEAM_ID, directory: plain.home, sessionID: first, model: MODEL })
    expect(plain.world.calls.find((call) => call.method === "session.preset.apply")?.input).toEqual({
      sessionID: first,
      presetID: Preset.builtinID("codex"),
    })
    await plain.close()

    const refused = await setup({ star: STAR, refuse: new Set([STAR]) })
    const second = SessionID.make("ses_teammain000000000000000004")
    expect(
      await refused.services
        .features()
        .main.create({ teamID: TEAM_ID, directory: refused.home, sessionID: second, model: MODEL }),
    ).toEqual({ ok: true, sessionID: second })
    expect(
      refused.world.calls.filter((call) => call.method === "session.preset.apply").map((call) => call.input),
    ).toEqual([
      { sessionID: second, presetID: STAR },
      { sessionID: second, presetID: Preset.builtinID("codex") },
    ])
    await refused.close()
  })

  test("a model outside every preset group gets no binding; an id used in another folder is refused", async () => {
    const h = await setup({ star: STAR })
    const local = Schema.decodeUnknownSync(Model.Ref)({ id: "m", providerID: "builtin-provider" })
    const sessionID = SessionID.make("ses_teammain000000000000000005")
    expect(
      await h.services.features().main.create({ teamID: TEAM_ID, directory: h.home, sessionID, model: local }),
    ).toEqual({ ok: true, sessionID })
    expect(h.world.calls.some((call) => call.method === "session.preset.apply")).toBe(false)

    const elsewhere = SessionID.make("ses_teammain000000000000000006")
    h.store.add({ id: elsewhere, directory: `${h.home}-other`, model: MODEL })
    const refused = await h.services
      .features()
      .main.create({ teamID: TEAM_ID, directory: h.home, sessionID: elsewhere, model: MODEL })
    expect(refused).toMatchObject({ ok: false, error: "internal_error" })
    await h.close()
  })

  test("own.accounts down: the approval write fails the creation (the op step retries it)", async () => {
    const h = await setup({ star: STAR })
    h.world.accounts.delete("session.approval.set")
    const sessionID = SessionID.make("ses_teammain000000000000000007")
    expect(
      await h.services.features().main.create({ teamID: TEAM_ID, directory: h.home, sessionID, model: MODEL }),
    ).toMatchObject({ ok: false, error: "internal_error" })
    expect(puts(h.service.requests)).toHaveLength(0)
    await h.close()
  })
})

describe("main.resume", () => {
  test("writes the current role text once to the main of a team that is on; an equal one and an off team get nothing", async () => {
    const h = await setup()
    // The controller's own start resume ends first (no team yet).
    await h.controller.resume()
    const off = { ...team({ home: h.home }), id: OwnTeam.TeamID.make("tm_0123456789ac"), state: "off" as const }
    const second = SessionID.make("ses_main0000000000000000000002")
    h.store.add({ id: MAIN_SESSION, directory: h.home })
    h.store.add({ id: second, directory: h.home })
    // The text a main made before the voice actions got.
    h.store.entries.get(MAIN_SESSION)?.set(RoleInstructions.MAIN, "# 팀 메인 역할 (own.team)\n옛 글")
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home })))
    await h.services.write(off.id, () =>
      h.services.registry.teams.put({ ...off, main: { sessionID: second, previous: [] } }),
    )
    // Every attach resumes as well: the overlapping resumes write it once.
    await Promise.all([h.services.features().main.resume?.(), h.controller.resume()])
    const role = RoleInstructions.main({ team: team({ home: h.home }), blocks: {} })
    expect(h.store.entries.get(MAIN_SESSION)?.get(RoleInstructions.MAIN)).toBe(role)
    expect(h.store.entries.get(second)?.size).toBe(0)
    expect(puts(h.service.requests)).toHaveLength(1)
    // Once per controller: a later resume writes nothing (and the hash check would skip it anyway).
    await h.controller.resume()
    expect(puts(h.service.requests)).toHaveLength(1)
    expect(role).toContain("team_area·team_control")
    expect(role).toContain("token을 붙여 다시 부른다")
    expect(role.length).toBeLessThan(2_700)
    await h.close()
  })

  test("main.refresh writes the text again once after resume when the settings changed it; equal is skipped", async () => {
    const h = await setup()
    await h.controller.resume()
    h.store.add({ id: MAIN_SESSION, directory: h.home })
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home })))
    await h.services.features().main.resume?.()
    expect(puts(h.service.requests)).toHaveLength(1)
    // Unchanged settings: `put` finds the same text.
    expect(await h.services.features().main.refresh?.({ teamID: TEAM_ID })).toEqual({ ok: true })
    expect(puts(h.service.requests)).toHaveLength(1)
    // directHold on and a main block: resume has marked the main already, refresh writes it anyway, once.
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home, directHold: true })))
    await h.services.kv.set(`instructions:${TEAM_ID}`, { main: "- 보고는 짧게 한다." })
    expect(await h.services.features().main.refresh?.({ teamID: TEAM_ID })).toEqual({ ok: true })
    await h.services.features().main.resume?.()
    expect(puts(h.service.requests)).toHaveLength(2)
    const role = h.store.entries.get(MAIN_SESSION)?.get(RoleInstructions.MAIN)
    expect(role).toBe(
      RoleInstructions.main({
        team: team({ home: h.home, directHold: true }),
        blocks: { main: "- 보고는 짧게 한다." },
      }),
    )
    expect(String(role)).toEndWith(`${RoleInstructions.GUARD}
- 보고는 짧게 한다.`)
    await h.close()
  })

  test("the 2026-10-16 role: talk the split over with a preview, relayed requests, the folders outside the team", () => {
    const role = RoleInstructions.main({ team: { policy: OwnTeam.POLICY }, blocks: {} })
    expect(role).toContain("- 묻지 말고 한다(나누는 방법을 상의할 때는 아래 줄을 따른다).")
    expect(role).toContain("team_reorganize{proposal, preview:true}")
    expect(role).toContain("사용자가 '알아서 해'라고 하면 묻지 않고 한다")
    expect(role).toContain("team_status의 '팀 밖 작업 폴더'")
    expect(role).toContain("팀 소식의 '사용자 부탁'은")
    expect(role).toContain("이 대화에서 사용자의 답을 받는다")
    // The area's account·model·effort is its 모델 (03 §14 glossary), as on the screen.
    expect(role).toContain("영역 모델(계정·모델·추론 강도)")
    expect(role).not.toContain("영역 메인")
    expect(role.length).toBeLessThan(2_700)
  })

  test("the 2026-11-14 role: scope edits, standing areas, the role that fits first, no area limit", () => {
    const role = RoleInstructions.main({ team: { policy: OwnTeam.POLICY }, blocks: {} })
    expect(role).toContain('team_area{action:"role", area, role}')
    expect(role).toContain("new·rename에 userMade:true")
    // 2026-11-17 (L12): an area kept as it is gets the mark from team_area{keep}; a rename that reuses one names its role.
    expect(role).toContain('그대로면 team_area{action:"keep"}')
    expect(role).toContain("다른 일로 이름을 바꾸면 goal에 새 역할도")
    expect(role).toContain("새 일은 먼저 역할이 맞는 영역에 맡긴다")
    expect(role).not.toContain("상한")
    expect(role.length).toBeLessThan(2_700)
    const off = RoleInstructions.main({ team: { policy: { ...OwnTeam.POLICY, directHold: false } }, blocks: {} })
    expect(off).toContain("'사용자가 직접 대화함'이 있는 영역에는")
    expect(off).not.toContain("직접 작업 중")
    expect(off.length).toBeLessThan(role.length)
  })
})

describe("main.model", () => {
  test("reads the team main session's current Ref (what 팀과 같게 follows)", async () => {
    const h = await setup()
    expect(await h.services.features().main.model(TEAM_ID)).toBeUndefined()
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home })))
    h.store.add({ id: MAIN_SESSION, directory: h.home, model: OTHER })
    expect(await h.services.features().main.model(TEAM_ID)).toEqual(OTHER)
    await h.close()
  })
})

describe("helpers", () => {
  test("group of a model and the group's ★", async () => {
    const h = await setup({ star: STAR })
    expect(await MainSession.group(h.services, MODEL)).toBe("codex")
    expect(
      await MainSession.group(h.services, Schema.decodeUnknownSync(Model.Ref)({ id: "x", providerID: "ollama" })),
    ).toBe("local:ollama")
    expect(await MainSession.star(h.services, "codex")).toBe(STAR)
    expect(await MainSession.star(h.services, "claude-sub")).toBe(Preset.builtinID("claude-sub"))
    expect(OwnTeam.SESSION_META).toBe("own.team")
    await h.close()
  })
})
