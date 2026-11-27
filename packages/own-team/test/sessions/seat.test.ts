// 담당 대화 바꾸기 (`area.seat`, `sessions/seat.ts`; 2026-11-12) at plugin level: which conversation may take an area's
// seat and why another may not, the move itself (no conversation made, no LLM turn, the old seat neither archived nor
// asked), what the incoming conversation gets and the outgoing one loses, the requests and asks of the old seat, a
// promoted peer, a re-seated previous owner, the round trip, the wait for a working conversation, a failed claim and a
// cancel taken back, the sweep of `owner.release`, and a controller that stops in the middle. A fake core on
// 127.0.0.1, F4's fake accounts and presets, a manual clock; nothing real is reached.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Talk } from "../../src/dispatch/talk.js"
import { PromptHook } from "../../src/hooks/prompt.js"
import type { Hub } from "../../src/hub.js"
import { TeamSettings } from "../../src/ops/settings.js"
import { Undo } from "../../src/ops/undo.js"
import { Keys } from "../../src/registry/keys.js"
import { Cursor } from "../../src/report/cursor.js"
import { Digest } from "../../src/report/digest.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { SafePoint } from "../../src/sessions/safe-point.js"
import { Seat } from "../../src/sessions/seat.js"
import { Permissions } from "../../src/tools/permissions.js"
import { F4_NOW, F4_PRESETS, F4_REFS, f4Accounts } from "../fixtures/f4-layout.js"
import { temp } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import {
  MAIN_SESSION,
  OLD_OWNER,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  controller,
  team,
  type Rule,
} from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"

setDefaultTimeout(30_000)

// ---------------------------------------------------------------------------------------------------------------
// A fake core: sessions with a model, a folder and the permissions the plugin API wrote, the active set, inboxes whose
// items can be withdrawn, instruction entries and each log's `log.synced` mark.

const Metadata = Schema.Record(Schema.String, Schema.Unknown)
const decodeAdmission = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    metadata: optional(Metadata),
    delivery: optional(Schema.String),
  }),
)
const decodePatch = Schema.decodeUnknownSync(Schema.Struct({ metadata: Metadata }))
const decodeEntry = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Unknown }))
const decodeOwned = Schema.decodeUnknownOption(
  Schema.Struct({ owner: Schema.Struct({ sessionID: Schema.NullOr(Schema.String) }) }),
)
const KEYS = [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF, RoleInstructions.PEER]

interface Item {
  readonly id: string
  readonly sessionID: string
  readonly type: string
  readonly delivery: string
  readonly payload: { readonly text: string; readonly metadata?: Readonly<Record<string, unknown>> }
  readonly time: { readonly created: number }
}

function fakeCore(service: FakeService, world: World, models: Map<string, Model.Ref>, now: () => number) {
  const active = new Set<string>()
  const views = new Map<string, ReturnType<typeof session>>()
  const inbox = new Map<string, Item[]>()
  const entries = new Map<string, Map<string, unknown>>()
  const synced = new Map<string, number>()
  /** Requests answered 500 while listed: `METHOD path`. */
  const failing = new Set<string>()
  const route = (
    key: string,
    answer: (
      request: Parameters<FakeService["routes"] extends Map<string, infer H> ? H : never>[0],
    ) => Response | Promise<Response>,
  ) =>
    service.routes.set(key, (request) =>
      failing.has(key) ? Response.json({ _tag: "Failed", message: "fake failure" }, { status: 500 }) : answer(request),
    )
  route("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  route("GET /api/session", (request) =>
    Response.json({
      data: [...views.values()].filter(
        (view) => view.location.directory === request.query.directory && !("parentID" in view),
      ),
      cursor: {},
    }),
  )
  const add = (input: Parameters<typeof session>[0] & { readonly model?: Model.Ref; readonly seq?: number }) => {
    const id = input.id
    const base = `/api/session/${id}`
    const entriesPath = `/api/experimental/session/${id}/instructions/entries`
    views.set(id, session(input))
    if (input.model) models.set(id, input.model)
    if (input.seq !== undefined) synced.set(id, input.seq)
    entries.set(id, new Map())
    world.sessions.set(id, { id, directory: input.directory, permissions: [] })
    const admit = (type: string) => (request: { readonly body: unknown }) => {
      const body = decodeAdmission(request.body)
      const items = inbox.get(id) ?? []
      const existing = items.find((item) => item.id === body.id)
      if (existing) return Response.json({ data: existing })
      const item: Item = {
        id: body.id,
        sessionID: id,
        type,
        delivery: body.delivery ?? "steer",
        payload: { text: body.text, ...(body.metadata === undefined ? {} : { metadata: body.metadata }) },
        // Input admitted with a wake counts as a run about to start for a while (`SafePoint.WAKE_MS`), then as parked.
        time: { created: now() },
      }
      inbox.set(id, [...items, item])
      route(`DELETE ${base}/inbox/${body.id}`, () => {
        inbox.set(
          id,
          (inbox.get(id) ?? []).filter((kept) => kept.id !== body.id),
        )
        return new Response(null, { status: 204 })
      })
      return Response.json({ data: item })
    }
    route(`GET ${base}`, () =>
      Response.json({ data: { ...views.get(id), permissions: world.sessions.get(id)?.permissions ?? [] } }),
    )
    route(`PATCH ${base}`, (request) => {
      const view = views.get(id)
      if (view) views.set(id, { ...view, metadata: decodePatch(request.body).metadata })
      return new Response(null, { status: 204 })
    })
    route(`GET ${base}/inbox`, () => Response.json({ data: inbox.get(id) ?? [] }))
    route(`GET ${base}/permission`, () => Response.json({ data: [] }))
    route(`GET ${base}/message`, () => Response.json({ data: [], cursor: {} }))
    route(`POST ${base}/synthetic`, admit("synthetic"))
    route(`POST ${base}/prompt`, admit("user"))
    route(`GET /api/experimental/session/${id}/log`, () => {
      const seq = synced.get(id)
      return new Response(
        seq === undefined ? "" : `data: ${JSON.stringify({ type: "log.synced", aggregateID: id, seq })}\n\n`,
      )
    })
    route(`GET ${entriesPath}`, () =>
      Response.json({ data: [...(entries.get(id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of KEYS) {
      route(`PUT ${entriesPath}/${key}`, (request) => {
        entries.get(id)?.set(key, decodeEntry(request.body).value)
        return new Response(null, { status: 204 })
      })
      route(`DELETE ${entriesPath}/${key}`, () => {
        entries.get(id)?.delete(key)
        return new Response(null, { status: 204 })
      })
    }
  }
  /** What was admitted to a session (`synthetic` or `prompt`), in order. */
  const admitted = (id: string, kind: "synthetic" | "prompt" = "prompt") =>
    service.requests
      .filter((request) => request.method === "POST" && request.path === `/api/session/${id}/${kind}`)
      .map((request) => decodeAdmission(request.body))
  /** Every request that changes `id` in core (not what the plugin API writes: the permissions). */
  const writes = (id: string) =>
    service.requests
      .filter((request) => request.method !== "GET" && request.path.includes(id))
      .map((request) => `${request.method} ${request.path}`)
  return { active, views, inbox, entries, failing, add, admitted, writes }
}

function event(type: string, data: Readonly<Record<string, unknown>>): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return { id: `evt_${type}_${Math.random()}`, created: 1, type, data } as never
}

async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_ui")
const API = OwnTeam.AreaID.make("ar_api")
/** A plain root conversation of the area's folder, on the team's account: the one the user picks. */
const TARGET = SessionID.make("ses_target00000000000000000001")
const REVIEWER = SessionID.make("ses_review000000000000000000001")
const RIVAL = SessionID.make("ses_rival000000000000000000001")
const BARE = SessionID.make("ses_bare0000000000000000000001")
const CHILD = SessionID.make("ses_child0000000000000000000001")
const HOME_TALK = SessionID.make("ses_home00000000000000000000001")
const API_OWNER = SessionID.make("ses_apiowner000000000000000001")
const TEAM_CONTEXT: Preset.Team = {
  teamID: TEAM_ID,
  role: "owner",
  accounts: [Account.ID.make("acc_chatgpt01")],
  pinned: [],
}
/** A rule the user gave the conversation; the team never touches it. */
const COMPUTER: Rule = { action: "computer", resource: "*", effect: "allow" }
const OWNER_RULES = Permissions.rules("owner").map((rule) => ({ ...rule }))
const TEAM_ACTIONS: ReadonlySet<string> = new Set(Object.values(Permissions.ACTIONS))
const PEER: OwnTeam.Peer = {
  key: "peer",
  sessionID: REVIEWER,
  label: "리뷰어",
  role: "변경을 읽고 위험한 곳을 짚는다",
  attached: true,
  origin: "registered",
  at: F4_NOW,
}

function boot(input: {
  readonly world: World
  readonly home: string
  readonly clock: ReturnType<typeof manual>
  readonly service: FakeService
  readonly pushes: { count: number }
}) {
  const h = controller(input.world, {
    directory: input.home,
    clock: input.clock,
    source: input.service.source,
    features: {
      teamContext: () => ({
        get: async () => TEAM_CONTEXT,
        push: async () => {
          input.pushes.count += 1
        },
      }),
    },
  })
  cleanups.push(() => h.close())
  const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: h.services.log })
  // SAFETY (test): every handler takes its method's input and `{signal, error}`.
  const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
  const rpc = (method: string, call: unknown) =>
    loose[method]!(call, {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    })
  return { ...h, rpc }
}

async function setup(input: { readonly area?: (base: OwnTeam.Area) => OwnTeam.Area } = {}) {
  const box = temp("own-team-seat-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folder = path.join(box.root, "home-team", "ui")
  const api = path.join(box.root, "home-team", "api")
  for (const dir of [home, folder, api]) fs.mkdirSync(dir, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const world = new World()
  const models = new Map<string, Model.Ref>()
  const clock = manual(F4_NOW)
  const core = fakeCore(service, world, models, clock.now)
  core.add({ id: MAIN_SESSION, directory: home, model: F4_REFS.team })
  // A main made by this build already has the current role text (`main.resume` writes it only to older mains).
  core.entries
    .get(MAIN_SESSION)
    ?.set(RoleInstructions.MAIN, RoleInstructions.main({ team: team({ home }), blocks: {} }))
  core.add({ id: OWNER_SESSION, directory: folder, model: F4_REFS.team, seq: 7 })
  core.add({ id: OLD_OWNER, directory: folder, model: F4_REFS.team, seq: 3 })
  core.add({ id: TARGET, directory: folder, model: F4_REFS.siwc, seq: 41 })
  core.add({ id: REVIEWER, directory: folder, model: F4_REFS.team, seq: 12 })
  core.add({ id: RIVAL, directory: folder, model: F4_REFS.other })
  core.add({ id: BARE, directory: folder })
  core.add({ id: CHILD, directory: folder, model: F4_REFS.team, parentID: TARGET })
  core.add({ id: HOME_TALK, directory: home, model: F4_REFS.team })
  core.add({ id: API_OWNER, directory: api, model: F4_REFS.team })
  // The seat as the team left it: the owner's allows and role entry; the user's own rule stays where it is.
  world.sessions.get(OWNER_SESSION)!.permissions = [...OWNER_RULES, COMPUTER]
  world.sessions.get(TARGET)!.permissions = [COMPUTER]
  core.entries.get(OWNER_SESSION)?.set(RoleInstructions.OWNER, "old owner role")
  core.entries.get(OWNER_SESSION)?.set(RoleInstructions.HANDOFF, "old handoff")
  const accounts = f4Accounts(world.accounts, models)
  const pushes = { count: 0 }
  const h = boot({ world, home, clock, service, pushes })
  const base: OwnTeam.Area = { ...area({ slug: "ui", directory: folder }), name: "인벤토리 화면", goal: "정렬" }
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(input.area ? input.area(base) : base)
    await h.services.registry.areas.put({
      ...area({ slug: "api", directory: api }),
      owner: { sessionID: API_OWNER, previous: [], attached: true },
    })
  })
  /** The session takes its queued items and runs `during`, then its run succeeds. */
  const turn = async (
    sessionID: string,
    during: () => Promise<void> = async () => {},
    hub: Hub.Bus = h.controller.hub,
  ) => {
    const taken = core.inbox.get(sessionID) ?? []
    core.inbox.set(sessionID, [])
    core.active.add(sessionID)
    hub.receive(event("session.execution.started", { sessionID }))
    for (const item of taken) hub.receive(event("session.inbox.delivered", { sessionID, inboxID: item.id }))
    await during()
    core.active.delete(sessionID)
    hub.receive(event("session.execution.succeeded", { sessionID }))
  }
  return { ...h, home, folder, clock, service, core, world, accounts, pushes, turn }
}

type Harness = Awaited<ReturnType<typeof setup>>
type Booted = Pick<Harness, "services" | "rpc" | "published">

const Started = Schema.Struct({ opID: OwnTeam.OpID })
const Failure = Schema.Struct({ type: Schema.String, message: Schema.String, data: Schema.Unknown })

async function seat(h: Booted, sessionID: string, areaID: OwnTeam.AreaID = UI) {
  return Schema.decodeUnknownSync(Started)(await h.rpc("area.seat", { teamID: TEAM_ID, areaID, sessionID })).opID
}

async function refused(h: Booted, sessionID: string, areaID: OwnTeam.AreaID = UI) {
  return Schema.decodeUnknownSync(Failure)(await h.rpc("area.seat", { teamID: TEAM_ID, areaID, sessionID }))
}

/** The op once it stopped running. */
async function settled(h: Booted, opID: string) {
  await until(async () => {
    const state = (await h.services.journal.find(opID))?.state
    return state !== "running" && state !== "waiting"
  })
  return (await h.services.journal.find(opID))!
}

async function stored(h: Booted, areaID: OwnTeam.AreaID = UI) {
  return (await h.services.registry.areas.get(TEAM_ID, areaID))!
}

/** The op's current step waits and a check said for what (the wait's first text is there before any check). */
async function waits(h: Booted, opID: string) {
  return (await h.services.journal.find(opID))?.steps.some((step) => step.wait?.detail !== undefined) === true
}

function stepOf(op: OwnTeam.Op, kind: string) {
  return op.steps.find((step) => step.kind === kind)
}

function teamRules(h: Harness, sessionID: string) {
  return (h.world.sessions.get(sessionID)?.permissions ?? []).filter((rule) => TEAM_ACTIONS.has(rule.action))
}

function entryKeys(h: Harness, sessionID: string) {
  return [...(h.core.entries.get(sessionID)?.keys() ?? [])].toSorted()
}

function dispatchTo(h: Booted, text: string, areaID: OwnTeam.AreaID = UI) {
  return h.services.features().admit.dispatch({ teamID: TEAM_ID, areaID, text, from: "main", kind: "task" })
}

function calls(h: Harness, method: string) {
  return h.world.calls.filter((call) => call.method === method).map((call) => call.input)
}

// ---------------------------------------------------------------------------------------------------------------

describe("which conversation may take the seat", () => {
  test("a child, the team main, the owner itself, a conversation elsewhere and one that is gone are refused with a reason", async () => {
    const h = await setup()
    expect(await refused(h, CHILD)).toEqual({
      type: "seat_invalid",
      message: Seat.INVALID.child,
      data: { why: "child" },
    })
    expect(await refused(h, MAIN_SESSION)).toEqual({
      type: "seat_invalid",
      message: Seat.INVALID.main,
      data: { why: "main" },
    })
    expect(await refused(h, OWNER_SESSION)).toEqual({
      type: "seat_invalid",
      message: Seat.INVALID.owner,
      data: { why: "owner" },
    })
    // A conversation of the home folder, and the owner of another area.
    expect(await refused(h, HOME_TALK)).toMatchObject({ type: "seat_invalid", data: { why: "elsewhere" } })
    expect(await refused(h, API_OWNER)).toMatchObject({ type: "seat_invalid", data: { why: "elsewhere" } })
    expect(await refused(h, "ses_nobody0000000000000000001")).toMatchObject({
      type: "not_found",
      data: { what: "session" },
    })
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect((await stored(h)).owner.sessionID).toBe(OWNER_SESSION)
  })

  test("another subscription of the team main's company is refused (R4), and so is a conversation without a model", async () => {
    const h = await setup()
    const rival = await refused(h, RIVAL)
    expect(rival).toMatchObject({ type: "same_company_subscription", data: { accountID: "acc_chatgpt02" } })
    expect(rival.message).toContain("같은 회사의 다른 구독 계정")
    // No fault of the program: it is said as what the user can do about it.
    expect(await refused(h, BARE)).toEqual({
      type: "seat_invalid",
      message: Seat.INVALID.account,
      data: { why: "account" },
    })
    expect(Seat.INVALID.account).toBe("이 대화의 계정을 확인할 수 없어요. 모델을 고른 뒤 다시 해 주세요")
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
  })

  test("a team that is off, an area that is ending or broken, and a team with a running op", async () => {
    const h = await setup()
    const put = (change: Partial<OwnTeam.Area>) =>
      h.services.write(TEAM_ID, async () => h.services.registry.areas.put({ ...(await stored(h)), ...change }))
    await put({ state: "retiring" })
    expect(await refused(h, TARGET)).toMatchObject({ type: "not_found", data: { what: "area" } })
    await put({ state: "broken", broken: { why: "identity", at: F4_NOW } })
    expect(await refused(h, TARGET)).toMatchObject({ type: "broken", data: { areaID: UI } })
    await put({ state: "active", broken: undefined })
    // A move that waits for the working target holds the team: a second one is `busy`.
    h.core.active.add(TARGET)
    const opID = await seat(h, TARGET)
    expect(await refused(h, OLD_OWNER)).toMatchObject({ type: "busy", data: { opID } })
    await h.rpc("op.cancel", { opID })
    expect(await settled(h, opID)).toMatchObject({ state: "cancelled" })
    await h.services.write(TEAM_ID, async () => h.services.registry.teams.put(team({ home: h.home, state: "off" })))
    expect(await refused(h, TARGET)).toMatchObject({ type: "team_off" })
  })

  test("Seat.eligible answers the conversation, its model and what the area would hold", async () => {
    const h = await setup()
    const record = await stored(h)
    const able = await Seat.eligible(h.services, team({ home: h.home }), record, TARGET)
    if (!able.ok) throw new Error(able.message)
    expect(able.ref).toEqual(F4_REFS.siwc)
    expect(able.session.id).toBe(TARGET)
    // No preset of its own: the group's built-in one is what the area takes (siwc has no ★ of its own here).
    expect(able.held.preset?.group).toBe("siwc")
  })
})

describe("the move", () => {
  test("the seat moves in one op: no conversation made, no turn run, the old seat left as a plain conversation", async () => {
    const h = await setup({ area: (base) => ({ ...base, owner: { ...base.owner, note: "화면 쪽을 맡아요" } }) })
    const opID = await seat(h, TARGET)
    const op = await settled(h, opID)
    expect(op).toMatchObject({ kind: "seat", state: "done", by: "user", areaID: UI })
    expect(op.steps.map((step) => step.kind)).toEqual(Object.values(Seat.KIND))
    expect(op.steps.every((step) => step.state === "done" || step.state === "skipped")).toBe(true)

    const record = await stored(h)
    expect(record.owner).toEqual({
      sessionID: TARGET,
      attached: true,
      previous: [
        { sessionID: OLD_OWNER, endedAt: 0, why: "user" },
        { sessionID: OWNER_SESSION, endedAt: F4_NOW, why: "seat" },
      ],
      // The user's owner note stays with the area; nothing is left to release.
      note: "화면 쪽을 맡아요",
    })
    // The area follows its seat: the conversation's model, and a preset of that model's group.
    expect(record.main).toEqual({ model: F4_REFS.siwc, chosenBy: "adopted" })
    expect(record.preset).toBe(Preset.builtinID("siwc"))
    expect(record.state).toBe("active")

    // The incoming conversation: the owner's allows before the user's own rule, the handoff note and the owner role.
    expect(h.world.sessions.get(TARGET)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
    expect(entryKeys(h, TARGET)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    expect(String(h.core.entries.get(TARGET)?.get(RoleInstructions.HANDOFF))).toContain("프로그램이 만든 인계 문서")
    expect(h.core.entries.get(TARGET)?.get(RoleInstructions.OWNER)).toEqual(
      RoleInstructions.owner({ team: team({ home: h.home }), area: record, blocks: {} }),
    )
    // Its history before the move is the user's: the log is followed from the mark.
    expect(await Cursor.get(h.services.kv, TARGET)).toBe(41)

    // The outgoing conversation: only the user's rule, no role entry; not archived, not asked anything.
    expect(h.world.sessions.get(OWNER_SESSION)?.permissions).toEqual([COMPUTER])
    expect(entryKeys(h, OWNER_SESSION)).toEqual([])
    expect(h.core.views.get(OWNER_SESSION)?.metadata?.[Undo.ARCHIVED]).toBeUndefined()
    for (const id of [OWNER_SESSION, TARGET, MAIN_SESSION]) {
      expect(h.core.admitted(id, "prompt")).toEqual([])
      expect(h.core.admitted(id, "synthetic")).toEqual([])
    }
    expect(
      h.service.requests.filter((request) => request.method === "POST" && request.path === "/api/session"),
    ).toEqual([])
    expect(h.pushes.count).toBeGreaterThan(0)

    // The main reads one line with its next update; it is not woken for it.
    const digest = await Digest.load(h.services.kv, TEAM_ID)
    const line = digest.entries.filter((entry) => entry.reason === "seated")
    expect(line).toHaveLength(1)
    expect(line[0]).toMatchObject({ areaID: UI, wake: false, key: `seat:${UI}:${TARGET}:${F4_NOW}` })
    expect(line[0]?.text).toBe(
      "'인벤토리 화면' 영역의 담당이 사용자가 고른 다른 대화로 바뀌었습니다. 요청은 전처럼 그 영역으로 보내면 됩니다.",
    )
    expect(h.published.find((item) => item.name === "notice" && item.data.kind === "seat.moved")?.data).toMatchObject({
      areaID: UI,
      text: "인벤토리 화면: 담당 대화를 바꿨어요.",
      data: { sessionID: TARGET, previous: OWNER_SESSION },
    })
    expect(op.summary?.lines).toEqual([{ kind: "area", areaID: UI, change: "seated" }])
  })

  test("a settings save between the claim and its check does not fail the move; the owner text follows later", async () => {
    const h = await setup()
    const key = `PUT /api/experimental/session/${TARGET}/instructions/entries/${RoleInstructions.OWNER}`
    const put = h.service.routes.get(key)!
    h.service.routes.set(key, async (request) => {
      const answer = await put(request)
      // The owner's text changes with this save, after the claim wrote the old one.
      const saved = await TeamSettings.write(h.services, TEAM_ID, { policy: { directHold: true, directTell: "none" } })
      expect(saved.ok).toBe(true)
      return answer
    })
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "done" })
    expect(stepOf(op, Seat.KIND.claim)?.state).toBe("done")
    const record = await stored(h)
    const before = RoleInstructions.owner({ team: team({ home: h.home }), area: record, blocks: {} })
    expect(h.core.entries.get(TARGET)?.get(RoleInstructions.OWNER)).toBe(before)
    // `owner.stale` came with the save: the next `role` writes the text of the settings now.
    await h.services.features().owner.role?.({ teamID: TEAM_ID, areaID: UI })
    const team2 = (await h.services.registry.teams.get(TEAM_ID))!
    expect(h.core.entries.get(TARGET)?.get(RoleInstructions.OWNER)).toBe(
      RoleInstructions.owner({ team: team2, area: record, blocks: {} }),
    )
    expect(h.core.entries.get(TARGET)?.get(RoleInstructions.OWNER)).not.toBe(before)
  })

  test("the next main request goes to the new seat with the team's note; the old seat is no part of the team", async () => {
    const h = await setup()
    expect(await settled(h, await seat(h, TARGET))).toMatchObject({ state: "done" })
    const sent = await dispatchTo(h, "정렬 버그를 고쳐 주세요")
    expect(sent).toMatchObject({ ok: true })
    await until(() => h.core.admitted(TARGET).length === 1)
    const prompt = h.core.admitted(TARGET)[0]!
    expect(prompt.metadata).toMatchObject({ [OwnTeam.DISPATCH_META]: { from: "main", areaID: UI } })
    expect(prompt.text).toContain("정렬 버그를 고쳐 주세요")
    // One line tells the conversation what happened to it (no roster, no message to the old seat).
    expect(prompt.text).toContain("<team-notes>")
    expect(prompt.text).toContain("'인벤토리 화면' 영역의 담당을 다른 대화에서 넘겨받았다")
    expect(prompt.text).toContain("- 팀(")
    expect(h.core.admitted(OWNER_SESSION)).toEqual([])
    expect(await h.services.locate.session(OWNER_SESSION)).toMatchObject({ role: "previous-owner" })
    expect(await h.services.locate.session(TARGET)).toMatchObject({ role: "owner" })
  })

  test("the target keeps its own preset: it is applied again only to carry the team context", async () => {
    const h = await setup()
    // A conversation on the team's account with the user's own preset.
    h.accounts.bindings.set(REVIEWER, { presetID: F4_PRESETS.review.id, group: "codex" })
    expect(await settled(h, await seat(h, REVIEWER))).toMatchObject({ state: "done" })
    const record = await stored(h)
    expect(record.preset).toBe(F4_PRESETS.review.id)
    expect(record.main).toEqual({ model: F4_REFS.team, chosenBy: "adopted" })
    const applied = calls(h, "session.preset.apply").filter(
      (call) => (call as { readonly sessionID: string }).sessionID === REVIEWER,
    )
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ presetID: F4_PRESETS.review.id, team: { teamID: TEAM_ID, role: "owner" } })
    expect(h.accounts.bindings.get(REVIEWER)?.presetID).toBe(F4_PRESETS.review.id)
  })

  test("an area without an owner gets one; nothing is left to release", async () => {
    const h = await setup({ area: (base) => ({ ...base, owner: { sessionID: null, previous: [], attached: false } }) })
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "done" })
    expect((await stored(h)).owner).toEqual({ sessionID: TARGET, attached: true, previous: [] })
    // No conversation gave the seat away: no note about answers to questions it did not ask.
    expect((await Talk.load(h.services.kv, TEAM_ID)).notes).toEqual([])
  })

  test("a conversation that held the seat before takes it again, and an archived one is shown again", async () => {
    const h = await setup()
    h.core.views.set(OLD_OWNER, { ...h.core.views.get(OLD_OWNER)!, metadata: { [Undo.ARCHIVED]: true, kept: "yes" } })
    expect(await settled(h, await seat(h, OLD_OWNER))).toMatchObject({ state: "done" })
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OLD_OWNER)
    expect(record.owner.previous).toEqual([{ sessionID: OWNER_SESSION, endedAt: F4_NOW, why: "seat" }])
    expect(h.core.views.get(OLD_OWNER)?.metadata).toEqual({ kept: "yes" })
    expect(teamRules(h, OLD_OWNER)).toEqual(OWNER_RULES)
  })

  test("there and back (A → B → A): a request neither seat took is admitted at A again under the id A's queue gave up", async () => {
    const h = await setup()
    // A request sent to A that A never took.
    const sent = await dispatchTo(h, "첫 요청")
    if (!sent.ok) throw new Error(sent.message)
    const id = MsgID.dispatch(sent.dispatchID, OWNER_SESSION)
    await until(() => h.core.admitted(OWNER_SESSION).length === 1)
    expect(h.core.inbox.get(OWNER_SESSION)?.map((item) => item.id)).toEqual([id])
    h.clock.advance(SafePoint.WAKE_MS)
    const there = await settled(h, await seat(h, TARGET))
    expect(there).toMatchObject({ state: "done" })
    expect(stepOf(there, Seat.KIND.requeue)?.note).toBe("요청 1개는 바꾼 뒤 새 담당에게 보내요")
    // A's queue gave the item up; B got the request under its own id and never took it either.
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([])
    await until(() => h.core.admitted(TARGET).length === 1)
    expect(h.core.inbox.get(TARGET)?.map((item) => item.id)).toEqual([MsgID.dispatch(sent.dispatchID, TARGET)])
    h.clock.advance(SafePoint.WAKE_MS)
    const back = await settled(h, await seat(h, OWNER_SESSION))
    expect(back).toMatchObject({ state: "done" })
    expect(stepOf(back, Seat.KIND.requeue)?.note).toBe("요청 1개는 바꾼 뒤 새 담당에게 보내요")
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OWNER_SESSION)
    expect(record.owner.previous.map((item) => item.sessionID)).toEqual([OLD_OWNER, TARGET])
    expect(record.owner.release).toBeUndefined()
    expect(record.main).toEqual({ model: F4_REFS.team, chosenBy: "adopted" })
    // B is a plain conversation again; A is the owner with its allows and role.
    expect(teamRules(h, TARGET)).toEqual([])
    expect(entryKeys(h, TARGET)).toEqual([])
    expect(h.core.inbox.get(TARGET)).toEqual([])
    expect(teamRules(h, OWNER_SESSION)).toEqual(OWNER_RULES)
    expect(entryKeys(h, OWNER_SESSION)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    // The request is admitted at A a second time under the id whose first item was withdrawn, and waits there once.
    await until(() => h.core.admitted(OWNER_SESSION).length === 2)
    expect(h.core.admitted(OWNER_SESSION).map((item) => item.id)).toEqual([id, id])
    expect(h.core.admitted(OWNER_SESSION)[1]?.text).toContain("첫 요청")
    expect(h.core.inbox.get(OWNER_SESSION)?.map((item) => item.id)).toEqual([id])
    // The record is marked `sent` once core answered the prompt, a moment after the item is in A's queue.
    await until(async () => {
      const again = (await h.services.registry.dispatches.list(TEAM_ID))[0]
      return again?.state === "sent" && again.sentTo?.sessionID === OWNER_SESSION
    })
    const dispatches = await h.services.registry.dispatches.list(TEAM_ID)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]).toMatchObject({ state: "sent", sentTo: { sessionID: OWNER_SESSION, msgID: id } })
    const seated = (await Digest.load(h.services.kv, TEAM_ID)).entries.filter((entry) => entry.reason === "seated")
    expect(seated).toHaveLength(2)
    // A takes it: one delivery, nothing sent again anywhere.
    await h.turn(OWNER_SESSION)
    await Bun.sleep(50)
    expect(h.core.admitted(OWNER_SESSION)).toHaveLength(2)
    expect(h.core.admitted(TARGET)).toHaveLength(1)
  })
})

describe("a current peer is promoted", () => {
  test("its record and peer entry go in the same move; what waited for it goes to the owner slot", async () => {
    const h = await setup({ area: (base) => ({ ...base, peers: [PEER] }) })
    h.world.sessions.get(REVIEWER)!.permissions = [...OWNER_RULES]
    h.core.entries.get(REVIEWER)?.set(RoleInstructions.PEER, "peer role")
    await Cursor.set(h.services.kv, REVIEWER, 5)
    // A main request for the peer waits behind the op (the area is maintained from the op's start).
    h.core.active.add(REVIEWER)
    const opID = await seat(h, REVIEWER)
    const waiting = await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: UI, text: "리뷰해 주세요", from: "main", kind: "task", to: "peer" })
    expect(waiting).toMatchObject({ ok: true })
    await h.turn(REVIEWER)
    expect(await settled(h, opID)).toMatchObject({ state: "done" })

    const record = await stored(h)
    expect(record.owner.sessionID).toBe(REVIEWER)
    expect(record.peers).toBeUndefined()
    expect(record.owner.previous.at(-1)).toMatchObject({ sessionID: OWNER_SESSION, why: "seat" })
    expect(entryKeys(h, REVIEWER)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    expect(teamRules(h, REVIEWER)).toEqual(OWNER_RULES)
    // A peer is followed already: its cursor is not moved to the log's end.
    expect(await Cursor.get(h.services.kv, REVIEWER)).toBe(5)
    await until(() => h.core.admitted(REVIEWER).length === 1)
    const dispatches = await h.services.registry.dispatches.list(TEAM_ID)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]?.to).toBeUndefined()
    expect(dispatches[0]).toMatchObject({ state: "sent", sentTo: { sessionID: REVIEWER } })
    expect(await h.services.locate.session(REVIEWER)).toMatchObject({ role: "owner" })
    // The main is told the peer key is gone (second pass, 2026-11-13): a `member` request to it would be refused.
    const line = (await Digest.load(h.services.kv, TEAM_ID)).entries.filter((entry) => entry.reason === "seated")
    expect(line).toHaveLength(1)
    expect(line[0]?.text).toContain("동료 리뷰어(peer)이(가) 담당이 되어 동료에서 빠졌습니다.")
  })

  test("SM-23: the promoted peer's role becomes the 담당 메모 only when the seat has none", async () => {
    const h = await setup({ area: (base) => ({ ...base, peers: [PEER] }) })
    h.world.sessions.get(REVIEWER)!.permissions = [...OWNER_RULES]
    expect(await settled(h, await seat(h, REVIEWER))).toMatchObject({ state: "done" })
    expect((await stored(h)).owner.note).toBe(PEER.role)

    const kept = await setup({
      area: (base) => ({ ...base, owner: { ...base.owner, note: "화면 쪽을 맡아요" }, peers: [PEER] }),
    })
    kept.world.sessions.get(REVIEWER)!.permissions = [...OWNER_RULES]
    expect(await settled(kept, await seat(kept, REVIEWER))).toMatchObject({ state: "done" })
    expect((await stored(kept)).owner.note).toBe("화면 쪽을 맡아요")
  })

  test("the old seat may be a peer by the time it is swept: it keeps what a peer holds", async () => {
    const h = await setup({
      area: (base) => ({
        ...base,
        owner: { ...base.owner, sessionID: TARGET, release: [OWNER_SESSION] },
        peers: [{ ...PEER, sessionID: OWNER_SESSION }],
      }),
    })
    h.core.entries.get(OWNER_SESSION)?.set(RoleInstructions.PEER, "peer role")
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    expect((await stored(h)).owner.release).toBeUndefined()
    // An attached peer keeps its allows and its peer entry; the owner entries go.
    expect(teamRules(h, OWNER_SESSION)).toEqual(OWNER_RULES)
    expect(entryKeys(h, OWNER_SESSION)).toEqual([RoleInstructions.PEER])
  })
})

describe("the wait", () => {
  test("a working target or owner is never interrupted: the move waits for both and for their queues", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const opID = await seat(h, TARGET)
    await until(() => waits(h, opID))
    expect((await stored(h)).owner.sessionID).toBe(OWNER_SESSION)
    // New main requests wait meanwhile.
    expect(await dispatchTo(h, "기다리는 요청")).toMatchObject({ state: "waiting", why: "maintaining" })
    await h.turn(OWNER_SESSION, async () => {
      h.core.active.add(TARGET)
    })
    // The owner is done; the target still works.
    await Bun.sleep(100)
    expect(await waits(h, opID)).toBe(true)
    await h.turn(TARGET)
    expect(await settled(h, opID)).toMatchObject({ state: "done" })
    expect(h.service.requests.filter((request) => request.path.endsWith("/interrupt"))).toEqual([])
    // The request that waited goes to the new seat.
    await until(() => h.core.admitted(TARGET).length === 1)
    expect(h.core.admitted(OWNER_SESSION)).toEqual([])
  })

  test("a target that stops being eligible while the move waits ends the op; nothing was changed", async () => {
    const h = await setup()
    h.core.active.add(TARGET)
    const opID = await seat(h, TARGET)
    await until(() => waits(h, opID))
    // The user switched the conversation to another subscription of the main's company.
    h.core.views.set(TARGET, { ...h.core.views.get(TARGET)!, model: F4_REFS.other })
    await h.turn(TARGET)
    const op = await settled(h, opID)
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.wait)?.note).toContain("같은 회사의 다른 구독 계정")
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OWNER_SESSION)
    expect(record.owner.release).toBeUndefined()
    expect(teamRules(h, TARGET)).toEqual([])
    expect(teamRules(h, OWNER_SESSION)).toEqual(OWNER_RULES)
  })

  test("a cancel while it waits changes nothing", async () => {
    const h = await setup()
    h.core.active.add(TARGET)
    const opID = await seat(h, TARGET)
    await until(() => waits(h, opID))
    await h.rpc("op.cancel", { opID })
    expect(await settled(h, opID)).toMatchObject({ state: "cancelled" })
    const record = await stored(h)
    expect(record.owner).toEqual(area({ slug: "ui", directory: h.folder }).owner)
    expect(h.core.writes(TARGET)).toEqual([])
    expect(h.world.sessions.get(TARGET)?.permissions).toEqual([COMPUTER])
  })
})

describe("the requests and asks of the old seat", () => {
  test("a main request the old seat never took goes back and is delivered to the new seat once", async () => {
    const h = await setup()
    await dispatchTo(h, "아직 안 읽은 요청")
    await until(() => h.core.admitted(OWNER_SESSION).length === 1)
    // Its run never began: after a while it is parked input, and the folder is at a safe point with it in the queue.
    const item = h.core.inbox.get(OWNER_SESSION)![0]!
    h.clock.advance(SafePoint.WAKE_MS)
    const opID = await seat(h, TARGET)
    const op = await settled(h, opID)
    expect(op).toMatchObject({ state: "done" })
    expect(stepOf(op, Seat.KIND.requeue)?.note).toBe("요청 1개는 바꾼 뒤 새 담당에게 보내요")
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([])
    await until(() => h.core.admitted(TARGET).length === 1)
    expect(h.core.admitted(TARGET)[0]?.text).toContain("아직 안 읽은 요청")
    expect(h.core.admitted(TARGET)[0]?.id).not.toBe(item.id)
    expect(h.core.admitted(OWNER_SESSION)).toHaveLength(1)
  })

  test("a queue that cannot be read fails the move before anything is claimed", async () => {
    const h = await setup()
    const key = `GET /api/session/${OWNER_SESSION}/inbox`
    // The safe point reads the queue; once the wait is over the requeue step cannot.
    const answer = h.service.routes.get(key)!
    h.service.routes.set(key, async (request) => {
      const op = await h.services.journal.active(TEAM_ID)
      return op && stepOf(op, Seat.KIND.wait)?.state === "done"
        ? Response.json({ _tag: "Failed" }, { status: 500 })
        : answer(request)
    })
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.wait)?.state).toBe("done")
    expect(stepOf(op, Seat.KIND.requeue)).toMatchObject({
      state: "failed",
      note: "대화에 남은 요청을 되돌리지 못했어요",
    })
    expect(stepOf(op, Seat.KIND.claim)?.state).toBe("pending")
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OWNER_SESSION)
    expect(record.owner.release).toBeUndefined()
    expect(teamRules(h, TARGET)).toEqual([])
  })

  test("an ask the old seat took and did not answer: the asker is told and no ask stays open", async () => {
    const h = await setup()
    const asked = await h.services.features().admit.message({
      teamID: TEAM_ID,
      areaID: UI,
      kind: "ask",
      sender: { areaID: API, area: "api" },
      text: "정렬 기준이 뭔가요?",
    })
    if (!asked.ok) throw new Error(asked.message)
    await until(() => h.core.admitted(OWNER_SESSION).length === 1)
    // The old seat took the ask (delivered, its run still to end) and the folder went idle without an answer.
    const taken = h.core.inbox.get(OWNER_SESSION) ?? []
    h.core.inbox.set(OWNER_SESSION, [])
    await h.services.write(TEAM_ID, async () => {
      const state = await Talk.load(h.services.kv, TEAM_ID)
      await Talk.save(h.services.kv, TEAM_ID, {
        ...state,
        open: state.open.map((item) => ({ ...item, delivered: OWNER_SESSION })),
      })
    })
    expect(taken).toHaveLength(1)
    expect((await Talk.load(h.services.kv, TEAM_ID)).open).toHaveLength(1)
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "done" })
    expect(stepOf(op, Seat.KIND.settle)?.note).toBe("답하지 못한 물음 1개를 물은 쪽에 알렸어요")
    expect((await Talk.load(h.services.kv, TEAM_ID)).open).toEqual([])
    // The asker (the other area's owner) reads that its question was not answered.
    await until(() => [...h.core.admitted(API_OWNER, "prompt"), ...h.core.admitted(API_OWNER, "synthetic")].length > 0)
    const notice = [...h.core.admitted(API_OWNER, "prompt"), ...h.core.admitted(API_OWNER, "synthetic")]
    expect(notice.some((item) => item.text.includes("정렬 기준이 뭔가요?"))).toBe(true)
  })
})

describe("what a failed or cancelled move leaves", () => {
  test("a claim that fails ends the op; the target is stripped at once, the old seat stays the owner", async () => {
    const h = await setup()
    const key = `PUT /api/experimental/session/${TARGET}/instructions/entries/${RoleInstructions.OWNER}`
    h.core.failing.add(key)
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.claim)?.state).toBe("failed")
    // The op's end sweeps what the claim listed: no allows, no handoff entry, no listing.
    await until(async () => (await stored(h)).owner.release === undefined)
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OWNER_SESSION)
    expect(record.main).toBeUndefined()
    expect(h.world.sessions.get(TARGET)?.permissions).toEqual([COMPUTER])
    expect(entryKeys(h, TARGET)).toEqual([])
    expect(teamRules(h, OWNER_SESSION)).toEqual(OWNER_RULES)
    expect(entryKeys(h, OWNER_SESSION)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    // A second try is a new op and works.
    h.core.failing.delete(key)
    expect(await settled(h, await seat(h, TARGET))).toMatchObject({ state: "done" })
    expect((await stored(h)).owner.sessionID).toBe(TARGET)
  })

  test("the same-company refusal of the preset write fails the claim with its reason", async () => {
    const h = await setup()
    const apply = h.world.accounts.get("session.preset.apply")!
    h.world.accounts.set("session.preset.apply", (call) => {
      if (
        (call as { readonly sessionID: string; readonly team?: unknown }).sessionID === TARGET &&
        (call as { readonly team?: unknown }).team
      )
        throw {
          type: "same_company_subscription",
          message: "same_company_subscription",
          data: { accountID: "acc_chatgpt02" },
        }
      return apply(call)
    })
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.claim)?.note).toContain("같은 회사의 다른 구독 계정")
    await until(async () => (await stored(h)).owner.release === undefined)
    expect((await stored(h)).owner.sessionID).toBe(OWNER_SESSION)
    expect(teamRules(h, TARGET)).toEqual([])
  })

  test("a conversation that cannot be reached stays listed in owner.release and is stripped by a later sweep", async () => {
    const h = await setup()
    const key = `GET /api/experimental/session/${OWNER_SESSION}/instructions/entries`
    h.core.failing.add(key)
    // The release never fails the op.
    expect(await settled(h, await seat(h, TARGET))).toMatchObject({ state: "done" })
    const kept = await stored(h)
    expect(kept.owner.sessionID).toBe(TARGET)
    expect(kept.owner.release).toEqual([OWNER_SESSION])
    expect(entryKeys(h, OWNER_SESSION)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    // The registry refuses its team tools whether or not it was stripped.
    expect(await h.services.locate.session(OWNER_SESSION)).toMatchObject({ role: "previous-owner" })
    h.core.failing.delete(key)
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    expect((await stored(h)).owner.release).toBeUndefined()
    expect(entryKeys(h, OWNER_SESSION)).toEqual([])
    expect(teamRules(h, OWNER_SESSION)).toEqual([])
  })
})

describe("Seat.sweep", () => {
  const listed = (ids: ReadonlyArray<SessionID>) => (base: OwnTeam.Area) => ({
    ...base,
    owner: { ...base.owner, release: [...ids] },
  })

  test("by its role now: the owner keeps everything, any other conversation loses allows, entries and team context", async () => {
    const h = await setup({ area: listed([OWNER_SESSION, TARGET, SessionID.make("ses_gone0000000000000000000001")]) })
    h.world.sessions.get(TARGET)!.permissions = [...OWNER_RULES, COMPUTER]
    h.core.entries.get(TARGET)?.set(RoleInstructions.OWNER, "role")
    h.core.entries.get(TARGET)?.set(RoleInstructions.HANDOFF, "note")
    h.accounts.bindings.set(TARGET, { presetID: Preset.builtinID("siwc"), group: "siwc", team: TEAM_CONTEXT })
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    // An owner that is listed is a swap an earlier kill left unfinished: it is finished and keeps what it holds. One
    // that is gone leaves the list.
    expect((await stored(h)).owner.release).toBeUndefined()
    expect(teamRules(h, OWNER_SESSION)).toEqual(OWNER_RULES)
    expect(entryKeys(h, OWNER_SESSION)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    expect(h.world.sessions.get(TARGET)?.permissions).toEqual([COMPUTER])
    expect(entryKeys(h, TARGET)).toEqual([])
    expect(h.accounts.bindings.get(TARGET)?.team).toBeUndefined()
    expect(h.pushes.count).toBeGreaterThan(0)
    // Twice is the same.
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    expect(h.world.sessions.get(TARGET)?.permissions).toEqual([COMPUTER])
  })

  test("a caller from outside leaves an area an op maintains alone; the op's own steps do not", async () => {
    const h = await setup()
    h.core.active.add(TARGET)
    const opID = await seat(h, TARGET)
    await until(() => waits(h, opID))
    // As between the claim and the swap: the target is listed and holds owner things without being the owner.
    await h.services.write(TEAM_ID, async () => h.services.registry.areas.put(listed([TARGET])(await stored(h))))
    h.world.sessions.get(TARGET)!.permissions = [...OWNER_RULES, COMPUTER]
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    expect((await stored(h)).owner.release).toEqual([TARGET])
    expect(teamRules(h, TARGET)).toEqual(OWNER_RULES)
    // The user writes in the listed conversation: the prompt hook sweeps, and skips the maintained area too.
    await PromptHook.record(h.services, TARGET)
    expect(teamRules(h, TARGET)).toEqual(OWNER_RULES)
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI, inside: true })
    expect((await stored(h)).owner.release).toBeUndefined()
    expect(teamRules(h, TARGET)).toEqual([])
    await h.rpc("op.cancel", { opID })
    expect(await settled(h, opID)).toMatchObject({ state: "cancelled" })
  })

  test("a prompt in a conversation still listed strips it then", async () => {
    const h = await setup({
      area: (base) => ({
        ...base,
        owner: {
          sessionID: TARGET,
          attached: true,
          previous: [{ sessionID: OWNER_SESSION, endedAt: 1, why: "seat" }],
          release: [OWNER_SESSION],
        },
      }),
    })
    await PromptHook.record(h.services, OWNER_SESSION)
    expect((await stored(h)).owner.release).toBeUndefined()
    expect(h.world.sessions.get(OWNER_SESSION)?.permissions).toEqual([COMPUTER])
    expect(entryKeys(h, OWNER_SESSION)).toEqual([])
  })
})

describe("a controller that stops in the middle", () => {
  test("stopped while the move waits: the next controller waits again and moves the seat once", async () => {
    const h = await setup()
    h.core.active.add(TARGET)
    const opID = await seat(h, TARGET)
    await until(() => waits(h, opID))
    await h.close()
    const next = boot({ world: h.world, home: h.home, clock: h.clock, service: h.service, pushes: h.pushes })
    await Bun.sleep(100)
    expect((await stored(next)).owner.sessionID).toBe(OWNER_SESSION)
    await h.turn(TARGET, async () => {}, next.controller.hub)
    expect(await settled(next, opID)).toMatchObject({ state: "done" })
    const record = await stored(next)
    expect(record.owner.sessionID).toBe(TARGET)
    expect(record.owner.previous.filter((item) => item.sessionID === OWNER_SESSION)).toHaveLength(1)
    expect(record.owner.release).toBeUndefined()
    const seated = (await Digest.load(next.services.kv, TEAM_ID)).entries.filter((entry) => entry.reason === "seated")
    expect(seated).toHaveLength(1)
  })

  test("a start-up with a seat op between its claim and its swap leaves the claimed conversation alone", async () => {
    const h = await setup()
    // The claim's last write hangs; the controller stops there.
    const key = `PUT /api/experimental/session/${TARGET}/instructions/entries/${RoleInstructions.OWNER}`
    const gate = Promise.withResolvers<void>()
    const answer = h.service.routes.get(key)!
    h.service.routes.set(key, async (request) => {
      await gate.promise
      return answer(request)
    })
    const opID = await seat(h, TARGET)
    await until(() => h.service.requests.some((request) => `${request.method} ${request.path}` === key))
    expect((await stored(h)).owner.release).toEqual([TARGET])
    const closing = h.close()
    gate.resolve()
    await closing
    h.service.routes.set(key, answer)
    const next = boot({ world: h.world, home: h.home, clock: h.clock, service: h.service, pushes: h.pushes })
    expect(await settled(next, opID)).toMatchObject({ state: "done" })
    const record = await stored(next)
    expect(record.owner.sessionID).toBe(TARGET)
    expect(record.owner.release).toBeUndefined()
    expect(h.world.sessions.get(TARGET)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
    expect(entryKeys(h, TARGET)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    expect(h.world.sessions.get(OWNER_SESSION)?.permissions).toEqual([COMPUTER])
  })
})

describe("what the review found (2026-11-13)", () => {
  /** Holds the first request for `key` until the gate opens; later ones are answered at once. */
  const hold = (h: Harness, key: string) => {
    const gate = Promise.withResolvers<void>()
    const answer = h.service.routes.get(key)!
    const seen = { count: 0 }
    h.service.routes.set(key, async (request) => {
      seen.count += 1
      if (seen.count === 1) await gate.promise
      return answer(request)
    })
    return { open: () => gate.resolve(), seen }
  }
  /** The next write of a record that `match` picks fails, as a storage that went away would. */
  const breaks = (h: Harness, match: (key: string, value: Schema.Json) => boolean) => {
    const set = h.world.kv.set.bind(h.world.kv)
    const state = { armed: true }
    h.world.kv.set = (key, value) => {
      if (state.armed && match(key, value)) {
        state.armed = false
        throw new Error("storage went away")
      }
      return set(key, value)
    }
  }
  const seatedLines = async (h: Booted) =>
    (await Digest.load(h.services.kv, TEAM_ID)).entries.filter((entry) => entry.reason === "seated")
  /** A peer about to be promoted, with a main request for it that waits behind the op. */
  const promoting = async (h: Harness) => {
    h.world.sessions.get(REVIEWER)!.permissions = [...OWNER_RULES]
    h.core.entries.get(REVIEWER)?.set(RoleInstructions.PEER, "peer role")
    h.core.active.add(REVIEWER)
    const opID = await seat(h, REVIEWER)
    const waiting = await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: UI, text: "리뷰해 주세요", from: "main", kind: "task", to: "peer" })
    if (!waiting.ok) throw new Error(waiting.message)
    return { opID, dispatchID: waiting.dispatchID }
  }

  test("a sweep from outside that began before the op is over before the claim writes: the seat is not stripped", async () => {
    // A conversation an earlier, failed move left listed with what an owner holds.
    const h = await setup({ area: (base) => ({ ...base, owner: { ...base.owner, release: [TARGET] } }) })
    h.world.sessions.get(TARGET)!.permissions = [...OWNER_RULES, COMPUTER]
    h.core.entries.get(TARGET)?.set(RoleInstructions.OWNER, "stale role")
    const key = `GET /api/experimental/session/${TARGET}/instructions/entries`
    const held = hold(h, key)
    // The sweep is in the middle of stripping the conversation when the user picks it again.
    const sweeping = h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    await until(() => held.seen.count >= 1)
    const opID = await seat(h, TARGET)
    const claim = async () => stepOf((await h.services.journal.find(opID))!, Seat.KIND.claim)?.state
    const end = Date.now() + 1_500
    while (Date.now() < end && (await claim()) !== "done") await Bun.sleep(20)
    // The claim waits for the sweep: it has written nothing the sweep could take away.
    expect(await claim()).not.toBe("done")
    held.open()
    await sweeping
    expect(await settled(h, opID)).toMatchObject({ state: "done" })
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(TARGET)
    expect(record.owner.release).toBeUndefined()
    expect(h.world.sessions.get(TARGET)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
    expect(entryKeys(h, TARGET)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    expect(h.core.entries.get(TARGET)?.get(RoleInstructions.OWNER)).toEqual(
      RoleInstructions.owner({ team: team({ home: h.home }), area: record, blocks: {} }),
    )
  })

  test("nothing tells of the move before the record says it: a swap whose record write fails moved nothing", async () => {
    const h = await setup({ area: (base) => ({ ...base, peers: [PEER] }) })
    const run = await promoting(h)
    // The swap's write of the area record is the first one that names the peer as the owner.
    breaks(
      h,
      (key, value) =>
        key === Keys.area(TEAM_ID, UI) && Option.getOrUndefined(decodeOwned(value))?.owner.sessionID === REVIEWER,
    )
    await h.turn(REVIEWER)
    const op = await settled(h, run.opID)
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.swap)?.state).toBe("failed")
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OWNER_SESSION)
    expect(record.peers).toEqual([PEER])
    // The peer's request is still the peer's, the main was told of no move and no team note was written.
    const waiting = await h.services.registry.dispatches.find(TEAM_ID, run.dispatchID)
    expect(waiting?.to).toBe("peer")
    expect(await seatedLines(h)).toEqual([])
    expect((await Talk.load(h.services.kv, TEAM_ID)).notes).toEqual([])
  })

  test("a swap that stops after its record write is finished by whoever meets it next: a promoted peer's slot, the note, the line", async () => {
    const h = await setup({ area: (base) => ({ ...base, peers: [PEER] }) })
    const run = await promoting(h)
    // The record says the seat moved; the write of the main's line, which follows it, fails.
    breaks(h, (key, value) => key === Keys.digest(TEAM_ID) && JSON.stringify(value).includes('"reason":"seated"'))
    await h.turn(REVIEWER)
    expect(await settled(h, run.opID)).toMatchObject({ state: "failed" })
    // The seat moved with the record; the sweep that follows every op does what the swap did not get to.
    await until(async () => (await stored(h)).owner.release === undefined)
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(REVIEWER)
    expect(record.owner.previous.at(-1)).toMatchObject({ sessionID: OWNER_SESSION, why: "seat" })
    expect(record.peers).toBeUndefined()
    expect(entryKeys(h, REVIEWER)).toEqual([RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted())
    expect(teamRules(h, OWNER_SESSION)).toEqual([])
    await until(() => h.core.admitted(REVIEWER).length === 1)
    const sent = await h.services.registry.dispatches.find(TEAM_ID, run.dispatchID)
    expect(sent?.to).toBeUndefined()
    expect(sent).toMatchObject({ state: "sent", sentTo: { sessionID: REVIEWER } })
    expect(h.core.admitted(REVIEWER)[0]?.text).toContain("넘겨받았다")
    expect(await seatedLines(h)).toHaveLength(1)
    // Meeting it again changes nothing.
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    expect(await seatedLines(h)).toHaveLength(1)
    // The incoming seat read the team's note once, with the request.
    expect(h.core.admitted(REVIEWER)).toHaveLength(1)
    expect(h.core.admitted(REVIEWER)[0]?.text.split("넘겨받았다")).toHaveLength(2)
  })

  test("a request the old seat takes while the move withdraws it stays the old seat's: the move ends, nothing is sent twice", async () => {
    const h = await setup()
    const sent = await dispatchTo(h, "막 받은 요청")
    if (!sent.ok) throw new Error(sent.message)
    await until(() => h.core.admitted(OWNER_SESSION).length === 1)
    const item = h.core.inbox.get(OWNER_SESSION)![0]!
    h.clock.advance(SafePoint.WAKE_MS)
    // Listed when the move reads the queue, delivered by the time it is withdrawn: core answers 404 and has the message.
    h.service.routes.set(`DELETE /api/session/${OWNER_SESSION}/inbox/${item.id}`, () => {
      h.core.inbox.set(OWNER_SESSION, [])
      h.service.routes.set(`GET /api/session/${OWNER_SESSION}/message/${item.id}`, () =>
        Response.json({ data: { id: item.id } }),
      )
      return Response.json({ _tag: "NotFound", message: "delivered" }, { status: 404 })
    })
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.requeue)).toMatchObject({
      state: "failed",
      note: "옛 담당 대화가 그사이 요청을 받았어요. 그 일이 끝난 뒤 다시 해 주세요",
    })
    expect((await stored(h)).owner.sessionID).toBe(OWNER_SESSION)
    expect(await h.services.registry.dispatches.find(TEAM_ID, sent.dispatchID)).toMatchObject({
      state: "sent",
      sentTo: { sessionID: OWNER_SESSION, msgID: item.id },
    })
    await Bun.sleep(100)
    expect(h.core.admitted(TARGET)).toEqual([])
    expect(h.core.admitted(OWNER_SESSION)).toHaveLength(1)
  })

  test("an item withdrawn by someone else while the move withdraws it (404, no message) is back in the outbox", async () => {
    const h = await setup()
    await dispatchTo(h, "누가 지운 요청")
    await until(() => h.core.admitted(OWNER_SESSION).length === 1)
    const item = h.core.inbox.get(OWNER_SESSION)![0]!
    h.clock.advance(SafePoint.WAKE_MS)
    h.service.routes.set(`DELETE /api/session/${OWNER_SESSION}/inbox/${item.id}`, () => {
      h.core.inbox.set(OWNER_SESSION, [])
      return Response.json({ _tag: "NotFound", message: "gone" }, { status: 404 })
    })
    expect(await settled(h, await seat(h, TARGET))).toMatchObject({ state: "done" })
    await until(() => h.core.admitted(TARGET).length === 1)
    expect(h.core.admitted(TARGET)[0]?.text).toContain("누가 지운 요청")
  })

  test("a request whose send was being checked when the move began goes to the new seat, not to the one that left", async () => {
    const h = await setup()
    // The send reads the owner's queue first; that read hangs while the whole move runs.
    const held = hold(h, `GET /api/session/${OWNER_SESSION}/inbox`)
    const sending = dispatchTo(h, "움직이는 사이의 요청")
    await until(() => held.seen.count >= 1)
    const opID = await seat(h, TARGET)
    await until(async () => (await stored(h)).owner.sessionID === TARGET)
    held.open()
    expect(await sending).toMatchObject({ ok: true })
    expect(await settled(h, opID)).toMatchObject({ state: "done" })
    await until(() => h.core.admitted(TARGET).length === 1)
    expect(h.core.admitted(TARGET)[0]?.text).toContain("움직이는 사이의 요청")
    expect(h.core.admitted(OWNER_SESSION)).toEqual([])
    const dispatches = await h.services.registry.dispatches.list(TEAM_ID)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]).toMatchObject({ state: "sent", sentTo: { sessionID: TARGET } })
  })

  test("a conversation that cannot be claimed costs the old seat none of its asks", async () => {
    const h = await setup()
    const asked = await h.services.features().admit.message({
      teamID: TEAM_ID,
      areaID: UI,
      kind: "ask",
      sender: { areaID: API, area: "api" },
      text: "정렬 기준이 뭔가요?",
    })
    if (!asked.ok) throw new Error(asked.message)
    await until(() => h.core.admitted(OWNER_SESSION).length === 1)
    h.core.inbox.set(OWNER_SESSION, [])
    await h.services.write(TEAM_ID, async () => {
      const state = await Talk.load(h.services.kv, TEAM_ID)
      await Talk.save(h.services.kv, TEAM_ID, {
        ...state,
        open: state.open.map((item) => ({ ...item, delivered: OWNER_SESSION })),
      })
    })
    h.core.failing.add(`PUT /api/experimental/session/${TARGET}/instructions/entries/${RoleInstructions.OWNER}`)
    const op = await settled(h, await seat(h, TARGET))
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.claim)?.state).toBe("failed")
    expect(stepOf(op, Seat.KIND.settle)?.state).toBe("pending")
    await until(async () => (await stored(h)).owner.release === undefined)
    // The old seat is still the owner and still owes its answer: the asker was told nothing.
    expect((await Talk.load(h.services.kv, TEAM_ID)).open).toHaveLength(1)
    await Bun.sleep(100)
    expect([...h.core.admitted(API_OWNER, "prompt"), ...h.core.admitted(API_OWNER, "synthetic")]).toEqual([])
  })

  test("every owner field the move does not name stays as it was", async () => {
    const h = await setup({ area: (base) => ({ ...base, owner: { ...base.owner, note: "화면 쪽을 맡아요" } }) })
    const before = (await stored(h)).owner
    expect(await settled(h, await seat(h, TARGET))).toMatchObject({ state: "done" })
    expect((await stored(h)).owner).toEqual({
      ...before,
      sessionID: TARGET,
      attached: true,
      previous: [...before.previous, { sessionID: OWNER_SESSION, endedAt: F4_NOW, why: "seat" }],
    })
  })

  test("the handoff note the incoming conversation reads is true for a conversation that was there already", async () => {
    const h = await setup()
    expect(await settled(h, await seat(h, TARGET))).toMatchObject({ state: "done" })
    const note = String(h.core.entries.get(TARGET)?.get(RoleInstructions.HANDOFF))
    expect(note).toContain("프로그램이 만든 인계 문서")
    expect(note).toContain("사용자가 이 대화를 이 영역의 담당으로 정했습니다")
    // Not a conversation that was just made.
    expect(note).not.toContain("새 담당 대화")
    expect(note).not.toContain("인계를 쓰지 않아")
  })

  test("an account that cannot be read right now is its own reason, and the move may be tried again", async () => {
    const h = await setup()
    const list = h.world.accounts.get("accounts.list")!
    h.world.accounts.set("accounts.list", () => {
      throw { type: "internal_error", message: "down" }
    })
    expect(await refused(h, TARGET)).toEqual({
      type: "seat_invalid",
      message: Seat.INVALID.unknown,
      data: { why: "unknown" },
    })
    h.world.accounts.set("accounts.list", list)
    expect(await settled(h, await seat(h, TARGET))).toMatchObject({ state: "done" })
  })
})

describe("what the second pass found (2026-11-13)", () => {
  test("a request the chosen conversation takes while the move withdraws it: the note names that conversation", async () => {
    const h = await setup({ area: (base) => ({ ...base, peers: [PEER] }) })
    h.world.sessions.get(REVIEWER)!.permissions = [...OWNER_RULES]
    const sent = await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: UI, text: "리뷰해 주세요", from: "main", kind: "task", to: "peer" })
    if (!sent.ok) throw new Error(sent.message)
    await until(() => h.core.admitted(REVIEWER).length === 1)
    const item = h.core.inbox.get(REVIEWER)![0]!
    h.clock.advance(SafePoint.WAKE_MS)
    // Listed when the move reads the peer's queue, delivered by the time it is withdrawn.
    h.service.routes.set(`DELETE /api/session/${REVIEWER}/inbox/${item.id}`, () => {
      h.core.inbox.set(REVIEWER, [])
      h.service.routes.set(`GET /api/session/${REVIEWER}/message/${item.id}`, () =>
        Response.json({ data: { id: item.id } }),
      )
      return Response.json({ _tag: "NotFound", message: "delivered" }, { status: 404 })
    })
    const op = await settled(h, await seat(h, REVIEWER))
    expect(stepOf(op, Seat.KIND.requeue)).toMatchObject({
      state: "failed",
      note: "고른 대화가 그사이 요청을 받았어요. 그 일이 끝난 뒤 다시 해 주세요",
    })
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OWNER_SESSION)
    expect(record.peers).toEqual([PEER])
  })

  test("an area that breaks while the move waits: the note says the area's name, not its id", async () => {
    const h = await setup()
    h.core.active.add(TARGET)
    const opID = await seat(h, TARGET)
    await until(() => waits(h, opID))
    await h.services.write(TEAM_ID, async () =>
      h.services.registry.areas.put({ ...(await stored(h)), state: "broken", broken: { why: "identity", at: F4_NOW } }),
    )
    await h.turn(TARGET)
    const op = await settled(h, opID)
    expect(op).toMatchObject({ state: "failed" })
    expect(stepOf(op, Seat.KIND.wait)?.note).toBe("'인벤토리 화면' 영역이 멈춰 있어요")
  })

  test("a peer made the owner and moved off the seat again may be registered as a peer again", async () => {
    const h = await setup({ area: (base) => ({ ...base, peers: [PEER] }) })
    h.world.sessions.get(REVIEWER)!.permissions = [...OWNER_RULES]
    h.core.entries.get(REVIEWER)?.set(RoleInstructions.PEER, "peer role")
    expect(await settled(h, await seat(h, REVIEWER))).toMatchObject({ state: "done" })
    h.clock.advance(SafePoint.WAKE_MS)
    expect(await settled(h, await seat(h, OWNER_SESSION))).toMatchObject({ state: "done" })
    // The way back leaves it an earlier owner (why `seat`), with nothing of the team's.
    expect((await stored(h)).owner.previous.at(-1)).toMatchObject({ sessionID: REVIEWER, why: "seat" })
    expect(await h.services.locate.session(REVIEWER)).toMatchObject({ role: "previous-owner" })
    expect(entryKeys(h, REVIEWER)).toEqual([])
    const added = await h.services
      .features()
      .peers.add({ teamID: TEAM_ID, areaID: UI, sessionID: REVIEWER, label: PEER.label, role: PEER.role })
    expect(added).toMatchObject({ ok: true, peer: { key: "peer", sessionID: REVIEWER } })
    const record = await stored(h)
    expect(record.owner.sessionID).toBe(OWNER_SESSION)
    expect(record.owner.previous.map((item) => item.sessionID)).not.toContain(REVIEWER)
    expect(record.peers?.map((item) => item.sessionID)).toEqual([REVIEWER])
    expect(await h.services.locate.session(REVIEWER)).toMatchObject({ role: "peer" })
  })
})
