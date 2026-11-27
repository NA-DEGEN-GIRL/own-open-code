// Area peers (동료, 06 §1.2, §2.4, §2.7, §5.1; approved 2026-10-09) at plugin level: registering a conversation of the
// area's folder (only the record and its log cursor; the team R4 refuses another subscription of the team main's
// company), creating one (the owner's allows, the area preset and the peer role from the start), the first main request
// to a registered peer (attached with its allows and `own.team.peer.role`, then sent with `to` in the envelope and the
// metadata), one request at a time for the whole folder (the owner's queue holds a peer's request and the other way
// round: never two at once), the R4 check at every send (refused, cancelled, the main woken), editing and removing a
// peer, what a peer's tools may do, the direct-talk record and the lifecycle helpers. A fake core on 127.0.0.1, F4's
// fake accounts and presets, a manual clock; nothing real is reached.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, type Preset } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { PromptHook } from "../../src/hooks/prompt.js"
import type { Hub } from "../../src/hub.js"
import { TeamSettings } from "../../src/ops/settings.js"
import { Remove } from "../../src/reorg/remove.js"
import { Digest } from "../../src/report/digest.js"
import { Cursor } from "../../src/report/cursor.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Peers } from "../../src/sessions/peer.js"
import { DispatchTool } from "../../src/tools/dispatch.js"
import { IntegrateTool } from "../../src/tools/integrate.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { Permissions } from "../../src/tools/permissions.js"
import { ReportTool } from "../../src/tools/report.js"
import { F4_NOW, F4_REFS, f4Accounts } from "../fixtures/f4-layout.js"
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
  type FakeSession,
  type Rule,
} from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"

// ---------------------------------------------------------------------------------------------------------------
// A fake core: sessions with a model and a folder, the active set, inboxes, instruction entries and each log's
// `log.synced` mark. Routes are added per session id (the fake service matches exact paths).

const Metadata = Schema.Record(Schema.String, Schema.Unknown)
const decodeCreate = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    title: optional(Schema.String),
    model: optional(Model.Ref),
    location: Schema.Struct({ directory: Schema.String }),
    metadata: optional(Metadata),
    permissions: optional(
      Schema.Array(Schema.Struct({ action: Schema.String, resource: Schema.String, effect: Schema.String })),
    ),
  }),
)
const decodeAdmission = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    metadata: optional(Metadata),
    delivery: optional(Schema.String),
  }),
)
const decodeEntry = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Unknown }))
const KEYS = [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF, RoleInstructions.PEER]

interface Item {
  readonly id: string
  readonly sessionID: string
  readonly type: string
  readonly delivery: string
  readonly payload: { readonly text: string; readonly metadata?: Readonly<Record<string, unknown>> }
}

function fakeCore(service: FakeService, models: Map<string, Model.Ref>, order: string[]) {
  const active = new Set<string>()
  const views = new Map<string, ReturnType<typeof session>>()
  const inbox = new Map<string, Item[]>()
  const entries = new Map<string, Map<string, unknown>>()
  const synced = new Map<string, number>()
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  service.routes.set("GET /api/session", (request) =>
    Response.json({
      data: [...views.values()].filter(
        (view) =>
          view.location.directory === request.query.directory &&
          (request.query.parentID !== "null" || view.parentID === undefined),
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
    service.routes.set(`GET ${base}`, () => Response.json({ data: views.get(id) }))
    service.routes.set(`GET ${base}/inbox`, () => Response.json({ data: inbox.get(id) ?? [] }))
    service.routes.set(`GET ${base}/permission`, () => Response.json({ data: [] }))
    service.routes.set(`GET ${base}/message`, () => Response.json({ data: [], cursor: {} }))
    service.routes.set(`POST ${base}/prompt`, (request) => {
      const body = decodeAdmission(request.body)
      order.push(`prompt ${id}`)
      const items = inbox.get(id) ?? []
      const existing = items.find((item) => item.id === body.id)
      if (existing) return Response.json({ data: existing })
      const item: Item = {
        id: body.id,
        sessionID: id,
        type: "user",
        delivery: body.delivery ?? "steer",
        payload: { text: body.text, ...(body.metadata === undefined ? {} : { metadata: body.metadata }) },
      }
      inbox.set(id, [...items, item])
      return Response.json({ data: item })
    })
    service.routes.set(`GET /api/experimental/session/${id}/log`, () => {
      const seq = synced.get(id)
      return new Response(
        seq === undefined ? "" : `data: ${JSON.stringify({ type: "log.synced", aggregateID: id, seq })}\n\n`,
      )
    })
    service.routes.set(`GET ${entriesPath}`, () =>
      Response.json({ data: [...(entries.get(id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of KEYS) {
      service.routes.set(`PUT ${entriesPath}/${key}`, (request) => {
        order.push(`entry ${key} ${id}`)
        entries.get(id)?.set(key, decodeEntry(request.body).value)
        return new Response(null, { status: 204 })
      })
      service.routes.set(`DELETE ${entriesPath}/${key}`, () => {
        order.push(`remove ${key} ${id}`)
        entries.get(id)?.delete(key)
        return new Response(null, { status: 204 })
      })
    }
  }
  service.routes.set("POST /api/session", (request) => {
    const body = decodeCreate(request.body)
    order.push(`create ${body.id}`)
    if (!views.has(body.id))
      add({
        id: body.id,
        directory: body.location.directory,
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      })
    return Response.json({ data: views.get(body.id) })
  })
  const admitted = (id: string) =>
    service.requests
      .filter((request) => request.method === "POST" && request.path === `/api/session/${id}/prompt`)
      .map((request) => decodeAdmission(request.body))
  /** The conversation now runs on `model` (the user picked another account in it). */
  const switchTo = (id: string, model: Model.Ref) => {
    const view = views.get(id)
    if (view) views.set(id, { ...view, model })
    models.set(id, model)
  }
  return { active, views, inbox, entries, add, admitted, switchTo }
}

function event(type: string, data: Readonly<Record<string, unknown>>): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return { id: `evt_${type}_${Math.random()}`, created: 1, type, data } as never
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

// ---------------------------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_ui")
const REVIEWER = SessionID.make("ses_review000000000000000000001")
const OTHER = SessionID.make("ses_other0000000000000000000001")
const CHILD = SessionID.make("ses_child0000000000000000000001")
const HOME_TALK = SessionID.make("ses_home00000000000000000000001")
const TEAM_CONTEXT: Preset.Team = {
  teamID: TEAM_ID,
  role: "owner",
  accounts: [Account.ID.make("acc_chatgpt01")],
  pinned: [],
}
/** A rule the user gave the conversation; the team never touches it. */
const COMPUTER: Rule = { action: "computer", resource: "*", effect: "allow" }
const ROLE = "변경을 읽고 위험한 곳을 짚는다"

async function setup(input: { readonly peers?: ReadonlyArray<OwnTeam.Peer> } = {}) {
  const box = temp("own-team-peers-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folder = path.join(box.root, "home-team", "ui")
  for (const dir of [home, folder]) fs.mkdirSync(dir, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const order: string[] = []
  const models = new Map<string, Model.Ref>()
  const core = fakeCore(service, models, order)
  core.add({ id: MAIN_SESSION, directory: home, model: F4_REFS.team })
  // A main made by this build already has the current role text (`main.resume` writes it only to older mains).
  core.entries
    .get(MAIN_SESSION)
    ?.set(RoleInstructions.MAIN, RoleInstructions.main({ team: team({ home }), blocks: {} }))
  core.add({ id: OWNER_SESSION, directory: folder, model: F4_REFS.team })
  core.add({ id: OLD_OWNER, directory: folder, model: F4_REFS.team })
  core.add({ id: REVIEWER, directory: folder, model: F4_REFS.team, seq: 41 })
  core.add({ id: OTHER, directory: path.join(folder, "src"), model: F4_REFS.claude })
  core.add({ id: CHILD, directory: folder, model: F4_REFS.team, parentID: REVIEWER })
  core.add({ id: HOME_TALK, directory: home, model: F4_REFS.team })
  const world = new World()
  const accounts = f4Accounts(world.accounts, models)
  for (const [method, answer] of [...world.accounts])
    world.accounts.set(method, (call) => {
      order.push(`rpc ${method}`)
      return answer(call)
    })
  const permissions = { rules: [COMPUTER], writes: 0 }
  const reviewer: FakeSession = {
    id: REVIEWER,
    directory: folder,
    get permissions() {
      return permissions.rules
    },
    set permissions(rules) {
      permissions.rules = rules
      permissions.writes += 1
      order.push(`permissions ${REVIEWER}`)
    },
  }
  world.sessions.set(REVIEWER, reviewer)
  const clock = manual(F4_NOW)
  const h = controller(world, {
    directory: home,
    clock,
    source: service.source,
    features: { teamContext: () => ({ get: async () => TEAM_CONTEXT, push: async () => {} }) },
  })
  cleanups.push(() => h.close())
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put({
      ...area({ slug: "ui", directory: folder }),
      ...(input.peers === undefined ? {} : { peers: [...input.peers] }),
    })
  })
  const peers = h.services.features().peers
  const register = (label = "리뷰어", sessionID: SessionID = REVIEWER, role = ROLE) =>
    peers.add({ teamID: TEAM_ID, areaID: UI, sessionID, label, role })
  const dispatch = (text: string, to?: string) =>
    h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: UI, text, from: "main", kind: "task", ...(to ? { to } : {}) })
  const stored = async () => (await h.services.registry.areas.get(TEAM_ID, UI))!
  /** A conversation takes its queue, runs and finishes. */
  const turn = (sessionID: string) => {
    core.inbox.set(sessionID, [])
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID }))
  }
  const calls = (method: string) => world.calls.filter((call) => call.method === method).map((call) => call.input)
  const digest = () => Digest.load(h.services.kv, TEAM_ID)
  return {
    ...h,
    home,
    clock,
    folder,
    service,
    core,
    world,
    accounts,
    order,
    permissions,
    peers,
    register,
    dispatch,
    stored,
    turn,
    calls,
    digest,
  }
}

type Harness = Awaited<ReturnType<typeof setup>>

function entryWrites(h: Harness, sessionID: string) {
  return h.service.requests.filter(
    (request) =>
      (request.method === "PUT" || request.method === "DELETE") &&
      request.path.startsWith(`/api/experimental/session/${sessionID}/`),
  )
}

function peer(input: Partial<OwnTeam.Peer> & Pick<OwnTeam.Peer, "key" | "sessionID">): OwnTeam.Peer {
  return { label: input.key, role: "", attached: false, origin: "registered", at: F4_NOW, ...input }
}

// ---------------------------------------------------------------------------------------------------------------

describe("registering a peer (동료로 등록…)", () => {
  test("only the record and the log cursor are written; the conversation is not touched until its first request", async () => {
    const h = await setup()
    const added = await h.register()
    expect(added).toMatchObject({
      ok: true,
      peer: { key: "peer", sessionID: REVIEWER, label: "리뷰어", role: ROLE, attached: false, origin: "registered" },
    })
    expect((await h.stored()).peers).toEqual([
      {
        key: "peer",
        sessionID: REVIEWER,
        label: "리뷰어",
        role: ROLE,
        attached: false,
        origin: "registered",
        at: F4_NOW,
      },
    ])
    // Its history before the registration is the user's: the log is followed from its watermark on.
    expect(await Cursor.get(h.services.kv, REVIEWER)).toBe(41)
    expect(h.permissions.writes).toBe(0)
    expect(entryWrites(h, REVIEWER)).toEqual([])
    expect(h.calls("session.preset.apply")).toEqual([])
    expect(h.published.some((item) => item.name === "area.changed" && item.data.areaID === UI)).toBe(true)
    // The registry knows it by its id now.
    expect(await h.services.locate.session(REVIEWER)).toMatchObject({ role: "peer", peer: { key: "peer" } })
  })

  test("a subagent, the main, the owner and an earlier owner, a conversation elsewhere or one registered already are refused", async () => {
    const h = await setup()
    const why = async (sessionID: SessionID, label = "x") => {
      const result = await h.register(label, sessionID)
      return result.ok ? "ok" : result.error === "peer_invalid" ? result.data.why : result.error
    }
    expect(await why(CHILD)).toBe("child")
    expect(await why(MAIN_SESSION)).toBe("main")
    expect(await why(OWNER_SESSION)).toBe("owner")
    expect(await why(OLD_OWNER)).toBe("previous")
    expect(await why(HOME_TALK)).toBe("elsewhere")
    expect(await why(SessionID.make("ses_gone0000000000000000000001"))).toBe("not_found")
    // A conversation in a subfolder of the area's folder is the area's.
    expect(await why(OTHER, "검사")).toBe("ok")
    expect(await why(OTHER, "다른 이름")).toBe("peer")
    expect((await h.stored()).peers?.map((item) => item.key)).toEqual(["peer"])
  })

  test("a conversation the user moved the seat off may be a peer again; it is no earlier owner then", async () => {
    const h = await setup()
    const before = await h.stored()
    // REVIEWER held the seat and gave it back (담당 대화 바꾸기): listed after the rotated-out conversation.
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({
        ...before,
        owner: {
          ...before.owner,
          previous: [...before.owner.previous, { sessionID: REVIEWER, endedAt: F4_NOW, why: "seat" }],
        },
      }),
    )
    expect(await h.services.locate.session(REVIEWER)).toMatchObject({ role: "previous-owner" })
    expect(await h.register("리뷰어", REVIEWER)).toMatchObject({ ok: true, peer: { sessionID: REVIEWER } })
    const after = await h.stored()
    expect(after.owner.previous).toEqual(before.owner.previous)
    expect(after.owner.sessionID).toBe(OWNER_SESSION)
    expect(await h.services.locate.session(REVIEWER)).toMatchObject({ role: "peer", peer: { key: "peer" } })
    // The conversation a rotation ended stays refused.
    const rotated = await h.register("옛 담당", OLD_OWNER)
    expect(rotated).toMatchObject({ ok: false, error: "peer_invalid", data: { why: "previous" } })
  })

  test("labels are unique in the area, roles stay within 1,024 characters and an area has at most four peers", async () => {
    const h = await setup({
      peers: [peer({ key: "sim", label: "Sim", sessionID: SessionID.make("ses_sim00000000000000000000001") })],
    })
    const invalid = async (label: string, role = ROLE) => {
      const result = await h.register(label, REVIEWER, role)
      return result.ok ? "ok" : result.error === "peer_invalid" ? result.data.why : result.error
    }
    expect(await invalid("  sim ")).toBe("label")
    expect(await invalid("   ")).toBe("label")
    // Characters, as the wire counts them (before 2026-11-14 UTF-8 bytes: 342 Hangul were too many).
    expect(await invalid("리뷰어", "가".repeat(1_025))).toBe("role")
    expect(await invalid("Sim Two", "가".repeat(1_024))).toBe("ok")
    expect((await h.stored()).peers?.map((item) => item.key)).toEqual(["sim", "sim-two"])
    expect((await h.stored()).peers?.[1]?.role).toHaveLength(1_024)

    const full = await setup({
      peers: ["a", "b", "c", "d"].map((key, index) => peer({ key, sessionID: SessionID.make(`ses_full${index}`) })),
    })
    const over = await full.register("e")
    expect(over).toMatchObject({ ok: false, error: "peer_invalid", data: { why: "limit" } })
  })

  test("the area's direct mark of the registered conversation moves to the peer; another conversation's stays", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      const current = await h.stored()
      await h.services.registry.areas.put({ ...current, direct: { at: F4_NOW - 5_000, sessionID: REVIEWER } })
    })
    expect(await h.register()).toMatchObject({ ok: true })
    const record = await h.stored()
    expect(record.direct).toBeUndefined()
    expect(record.peers?.[0]?.direct).toEqual({ at: F4_NOW - 5_000 })

    const other = await setup()
    await other.services.write(TEAM_ID, async () => {
      const current = await other.stored()
      await other.services.registry.areas.put({ ...current, direct: { at: F4_NOW - 5_000, sessionID: OWNER_SESSION } })
    })
    expect(await other.register()).toMatchObject({ ok: true })
    expect((await other.stored()).direct).toEqual({ at: F4_NOW - 5_000, sessionID: OWNER_SESSION })
    expect((await other.stored()).peers?.[0]?.direct).toBeUndefined()
  })

  test("team R4: a conversation on another subscription of the team main's company is refused", async () => {
    const h = await setup()
    h.core.switchTo(REVIEWER, F4_REFS.other)
    expect(await h.register()).toMatchObject({
      ok: false,
      error: "same_company_subscription",
      data: { accountID: "acc_chatgpt02" },
    })
    expect((await h.stored()).peers).toBeUndefined()
  })
})

describe("creating a peer (동료 추가…)", () => {
  test("a new conversation in the folder with the owner's allows, the area preset with the team and the peer role", async () => {
    const h = await setup()
    const added = await h.peers.add({
      teamID: TEAM_ID,
      areaID: UI,
      create: { label: "시뮬레이터", role: "밸런스를 돌린다" },
    })
    if (!added.ok) throw new Error(added.message)
    expect(added.peer).toMatchObject({ key: "peer", label: "시뮬레이터", attached: true, origin: "created" })
    const created = h.service.requests.find((request) => request.method === "POST" && request.path === "/api/session")
    expect(decodeCreate(created?.body)).toMatchObject({
      id: added.peer.sessionID,
      title: "ui · 동료 시뮬레이터",
      model: F4_REFS.team,
      location: { directory: h.folder },
      permissions: [...Permissions.rules("owner")],
      metadata: { [OwnTeam.SESSION_META]: { role: "peer", teamID: TEAM_ID, areaID: UI } },
    })
    expect(h.calls("session.approval.set")).toEqual([{ sessionID: added.peer.sessionID, mode: "ask" }])
    expect(h.calls("session.preset.apply")).toEqual([
      { sessionID: added.peer.sessionID, presetID: (await h.stored()).preset, team: TEAM_CONTEXT },
    ])
    const role = String(h.core.entries.get(added.peer.sessionID)?.get(RoleInstructions.PEER))
    expect(role).toContain("동료 시뮬레이터")
    expect(role).toContain("밸런스를 돌린다")
    expect(role).toContain('to="peer"')
    expect(h.core.entries.get(added.peer.sessionID)?.has(RoleInstructions.OWNER)).toBe(false)
    expect((await h.stored()).peers).toEqual([added.peer])
  })
})

describe("a created peer's 에이전트 방식 (2026-10-26)", () => {
  test("it starts on the one of the area's owner conversation; without one the service's default", async () => {
    const h = await setup()
    const view = h.core.views.get(OWNER_SESSION)
    if (view) h.core.views.set(OWNER_SESSION, { ...view, metadata: { "own.harness": { id: "dsh", v: 1 } } })
    const added = await h.peers.add({ teamID: TEAM_ID, areaID: UI, create: { label: "시뮬레이터", role: "" } })
    if (!added.ok) throw new Error(added.message)
    const created = h.service.requests.find((request) => request.method === "POST" && request.path === "/api/session")
    expect(decodeCreate(created?.body).metadata).toEqual({
      [OwnTeam.SESSION_META]: { role: "peer", teamID: TEAM_ID, areaID: UI },
      "own.harness": { id: "dsh", v: 1 },
    })
  })
})

describe("main requests to a peer (5.1)", () => {
  test("the first one attaches a registered peer (allows and role, its own preset kept), then goes in with `to`", async () => {
    const h = await setup()
    await h.register()
    const sent = await h.dispatch("변경을 읽어 주세요", "peer")
    expect(sent).toMatchObject({ ok: true, state: "queued" })
    if (!sent.ok) return
    const writes = h.order.filter((item) => !item.startsWith("rpc ") || /approval\.set|preset\.apply/.test(item))
    expect(writes).toEqual([
      `permissions ${REVIEWER}`,
      "rpc session.approval.set",
      `entry ${RoleInstructions.PEER} ${REVIEWER}`,
      `prompt ${REVIEWER}`,
    ])
    expect(h.permissions.rules).toEqual([...Permissions.rules("owner"), COMPUTER])
    expect(h.calls("session.preset.apply")).toEqual([])
    const [prompt] = h.core.admitted(REVIEWER)
    expect(prompt?.id).toBe(MsgID.dispatch(sent.dispatchID, REVIEWER))
    expect(prompt?.delivery).toBe("queue")
    expect(prompt?.text.split("\n")[0]).toBe(`<dispatch from="main" to="peer" id="${sent.dispatchID}" area="ui">`)
    expect(prompt?.metadata).toMatchObject({
      [OwnTeam.DISPATCH_META]: { id: sent.dispatchID, from: "main", areaID: UI, to: "peer" },
      source: OwnTeam.PROMPT_SOURCE,
    })
    expect(h.core.admitted(OWNER_SESSION)).toEqual([])
    expect((await h.stored()).peers?.[0]?.attached).toBe(true)
    expect(await h.services.registry.dispatches.find(TEAM_ID, sent.dispatchID)).toMatchObject({
      to: "peer",
      sentTo: { sessionID: REVIEWER },
    })

    // The next one writes nothing more to the conversation.
    h.turn(REVIEWER)
    const writes1 = { permissions: h.permissions.writes, entries: entryWrites(h, REVIEWER).length }
    expect(await h.dispatch("하나 더", "peer")).toMatchObject({ state: "queued" })
    expect({ permissions: h.permissions.writes, entries: entryWrites(h, REVIEWER).length }).toEqual(writes1)
  })

  test("one at a time for the whole folder: the owner's queue holds the peer's request and the other way round", async () => {
    const h = await setup()
    await h.register()
    const owner = await h.dispatch("담당의 일")
    expect(owner).toMatchObject({ state: "queued" })
    const toPeer = await h.dispatch("동료의 일", "peer")
    // Never a second main request in the folder while one is undelivered (the double-send guard).
    expect(toPeer).toMatchObject({ state: "waiting", why: "queued" })
    expect(h.core.admitted(REVIEWER)).toEqual([])

    // The owner takes it and works: the folder is busy.
    h.core.inbox.set(OWNER_SESSION, [])
    h.core.active.add(OWNER_SESSION)
    h.controller.hub.receive(event("session.inbox.delivered", { sessionID: OWNER_SESSION, inboxID: "x" }))
    await Bun.sleep(30)
    expect(h.core.admitted(REVIEWER)).toEqual([])
    h.core.active.delete(OWNER_SESSION)
    h.turn(OWNER_SESSION)
    await until(() => h.core.admitted(REVIEWER).length === 1)

    // Now the peer's request waits in its queue: the owner's next one waits for it.
    expect(await h.dispatch("담당의 다음 일")).toMatchObject({ state: "waiting", why: "queued" })
    expect(h.core.admitted(OWNER_SESSION)).toHaveLength(1)
    h.turn(REVIEWER)
    await until(() => h.core.admitted(OWNER_SESSION).length === 2)
  })

  test("team R4 at every send: a peer now on another subscription of the team's company is refused and the main told", async () => {
    const h = await setup()
    await h.register()
    h.core.switchTo(REVIEWER, F4_REFS.other)
    const refused = await h.dispatch("변경을 읽어 주세요", "peer")
    expect(refused).toMatchObject({ ok: true, state: "refused" })
    if (!refused.ok) return
    expect(await h.services.registry.dispatches.find(TEAM_ID, refused.dispatchID)).toMatchObject({ state: "cancelled" })
    expect(h.core.admitted(REVIEWER)).toEqual([])
    expect(h.permissions.writes).toBe(0)
    const entries = (await h.digest()).entries.filter((item) => item.reason === "refused")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ areaID: UI, peer: "peer", wake: true })
    expect(entries[0]?.text).toContain("보내지 않았습니다")
    // The owner's requests are not held by it.
    expect(await h.dispatch("담당의 일")).toMatchObject({ state: "queued" })
  })

  test("a peer whose conversation was deleted takes no request: it is cancelled with a note and the owner's still go", async () => {
    const h = await setup()
    await h.register()
    for (const key of [...h.service.routes.keys()].filter((route) => route.includes(REVIEWER)))
      h.service.routes.delete(key)
    const gone = await h.dispatch("읽어 주세요", "peer")
    expect(gone).toMatchObject({ ok: true, state: "refused" })
    const notes = (await h.digest()).entries.filter((item) => item.peer === "peer")
    expect(notes.map((item) => [item.reason, item.wake])).toEqual([["reorganized", false]])
    expect(notes[0]?.text).toContain("없어 메인 요청")
    expect(await h.dispatch("담당의 일")).toMatchObject({ state: "queued" })
  })

  test("team_dispatch names a peer by key or label, refuses fresh with a member and lists the peers it has", async () => {
    const h = await setup()
    await h.register()
    const found = await h.services.registry.teams.get(TEAM_ID)
    if (!found) throw new Error("no team")
    const caller = { role: "main" as const, team: found, sessionID: MAIN_SESSION }
    const byLabel = await DispatchTool.run(h.services, caller, { area: "ui", text: "읽어 주세요", member: "리뷰어" })
    expect(byLabel).toMatchObject({ ok: true, state: "queued", text: "ui 동료 리뷰어: 동료 대화에 넣었습니다." })
    expect(
      await DispatchTool.run(h.services, caller, { area: "ui", text: "x", member: "peer", fresh: true }),
    ).toMatchObject({
      ok: false,
    })
    const unknown = await DispatchTool.run(h.services, caller, { area: "ui", text: "x", member: "없는 동료" })
    expect(unknown.ok).toBe(false)
    expect(unknown.text).toContain("리뷰어(peer)")
    expect(h.core.admitted(REVIEWER)).toHaveLength(1)
  })
})

describe("editing and removing a peer", () => {
  test("a new role is written to an attached peer's entry only; removing it takes the allows and role off and cancels its requests", async () => {
    const h = await setup()
    await h.register()
    // Not attached yet: an edit writes the record only.
    expect(await h.peers.edit({ teamID: TEAM_ID, areaID: UI, key: "peer", role: "보안 위주" })).toMatchObject({
      ok: true,
    })
    expect(entryWrites(h, REVIEWER)).toEqual([])
    expect(await h.dispatch("읽어 주세요", "peer")).toMatchObject({ state: "queued" })
    const before = entryWrites(h, REVIEWER).length
    expect(await h.peers.edit({ teamID: TEAM_ID, areaID: UI, key: "peer", label: "보안 리뷰어" })).toMatchObject({
      ok: true,
    })
    expect(entryWrites(h, REVIEWER)).toHaveLength(before + 1)
    expect(String(h.core.entries.get(REVIEWER)?.get(RoleInstructions.PEER))).toContain("동료 보안 리뷰어")
    expect(String(h.core.entries.get(REVIEWER)?.get(RoleInstructions.PEER))).toContain("보안 위주")

    // A request that waits for it (the owner works).
    h.core.inbox.set(REVIEWER, [])
    h.core.active.add(OWNER_SESSION)
    const waiting = await h.dispatch("하나 더", "peer")
    expect(waiting).toMatchObject({ state: "waiting", why: "busy" })
    expect(await h.peers.remove({ teamID: TEAM_ID, areaID: UI, key: "peer" })).toMatchObject({ ok: true })
    expect((await h.stored()).peers).toBeUndefined()
    expect(h.permissions.rules).toEqual([COMPUTER])
    expect(h.core.entries.get(REVIEWER)?.has(RoleInstructions.PEER)).toBe(false)
    if (!waiting.ok) return
    expect(await h.services.registry.dispatches.find(TEAM_ID, waiting.dispatchID)).toMatchObject({ state: "cancelled" })
    const notes = (await h.digest()).entries.filter((item) => item.reason === "reorganized").map((item) => item.text)
    expect(notes.some((text) => text.includes("동료에서 뺐습니다"))).toBe(true)
    expect(notes.some((text) => text.includes("보내지 않은 메인 요청 1개"))).toBe(true)
    expect(await h.services.locate.session(REVIEWER)).toBeUndefined()
    expect(await h.peers.remove({ teamID: TEAM_ID, areaID: UI, key: "peer" })).toMatchObject({ error: "not_found" })
  })

  test("detaching every attached peer (팀에서 빼기, 끄기, 되돌리기) keeps the records", async () => {
    const h = await setup()
    await h.register()
    expect(await h.dispatch("읽어 주세요", "peer")).toMatchObject({ state: "queued" })
    expect(await h.peers.detach({ teamID: TEAM_ID, areaID: UI })).toEqual({ ok: true })
    expect(h.permissions.rules).toEqual([COMPUTER])
    expect(h.core.entries.get(REVIEWER)?.has(RoleInstructions.PEER)).toBe(false)
    expect((await h.stored()).peers?.map((item) => ({ key: item.key, attached: item.attached }))).toEqual([
      { key: "peer", attached: false },
    ])
  })
})

describe("what a peer may do", () => {
  test("it reports progress, done and blocked under its own name; ready, integrating and the handoff stay the owner's", async () => {
    const h = await setup()
    await h.register()
    const found = await h.services.locate.session(REVIEWER)
    const judged = OwnerTools.judgeArea(found)
    if (!judged.ok || judged.caller.role !== "peer") throw new Error("not a peer caller")
    const caller = judged.caller
    expect(OwnerTools.judge(found)).toEqual({ ok: false, text: OwnerTools.PEER_REFUSED })
    expect(await ReportTool.run(h.services, caller, { kind: "ready", text: "다 됐습니다" })).toEqual({
      ok: false,
      text: OwnerTools.PEER_REFUSED,
    })
    expect(await IntegrateTool.run(h.services, caller, { area: "ui" })).toEqual({
      ok: false,
      text: OwnerTools.PEER_REFUSED,
    })
    expect(await ReportTool.run(h.services, caller, { kind: "done", text: "읽었습니다" })).toMatchObject({ ok: true })
    expect(await ReportTool.run(h.services, caller, { kind: "blocked", text: "결정이 필요합니다" })).toMatchObject({
      ok: true,
    })
    const state = await h.digest()
    const fold = state.areas[UI]
    expect(fold?.peers?.peer?.reports).toMatchObject({
      done: { text: "읽었습니다" },
      blocked: { text: "결정이 필요합니다" },
    })
    // The owner's side of the area is untouched: no report, no status change.
    expect(fold?.reports).toEqual({})
    expect((await h.stored()).status.kind).toBe("idle")
    expect(state.entries.filter((item) => item.peer === "peer").map((item) => [item.reason, item.wake])).toEqual([
      ["done", false],
      ["blocked", true],
    ])
    // A removed peer's later report is refused.
    await h.peers.remove({ teamID: TEAM_ID, areaID: UI, key: "peer" })
    expect(await ReportTool.run(h.services, caller, { kind: "progress", text: "x" })).toMatchObject({ ok: false })
  })

  test("typing in a peer conversation is recorded for the peer, not as the owner's area being driven by the user", async () => {
    const h = await setup()
    await h.register()
    await PromptHook.record(h.services, REVIEWER)
    const after = await h.stored()
    expect(after.direct).toBeUndefined()
    expect(after.peers?.[0]?.direct).toEqual({ at: F4_NOW })
    // Another conversation of the folder still is direct talk of the area (5.4).
    await PromptHook.record(h.services, OTHER)
    expect((await h.stored()).direct).toEqual({ at: F4_NOW, sessionID: OTHER })
  })

  test("a peer's user stop turns Main 멈춤 on like the owner's (5.3)", async () => {
    const h = await setup()
    await h.register()
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: REVIEWER, reason: "user" }))
    await until(async () => (await h.stored()).paused === "user")
  })
})

describe("lifecycle", () => {
  test("끝내기 drops the peers, a moved conversation leaves its area, and a finished area's peers are no team sessions", async () => {
    const h = await setup()
    await h.register()
    expect(Remove.retired(await h.stored(), F4_NOW).peers).toBeUndefined()
    await Peers.drop(h.services, { teamID: TEAM_ID, sessionID: REVIEWER, except: UI })
    expect((await h.stored()).peers).toHaveLength(1)
    await Peers.drop(h.services, { teamID: TEAM_ID, sessionID: REVIEWER })
    expect((await h.stored()).peers).toBeUndefined()

    await h.register()
    await h.services.write(TEAM_ID, async () =>
      h.services.registry.areas.put({ ...(await h.stored()), state: "retired" }),
    )
    expect(await h.services.locate.session(REVIEWER)).toBeUndefined()
  })

  test("the team update words each peer under its area line, never as an area of its own", async () => {
    const h = await setup()
    await h.register()
    const found = await h.services.locate.session(REVIEWER)
    const judged = OwnerTools.judgeArea(found)
    if (!judged.ok || judged.caller.role !== "peer") throw new Error("not a peer caller")
    await ReportTool.run(h.services, judged.caller, { kind: "blocked", text: "어느 쪽으로 할까요" })
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    const lines = text.split("\n")
    const index = lines.findIndex((line) => line.startsWith("- ui:"))
    expect(lines[index + 1]).toBe(`  · ${OwnTeamText.PEER} 리뷰어: 막힘 · "어느 쪽으로 할까요"`)
    expect(lines.filter((line) => OwnTeamText.countOf(line) !== undefined)).toHaveLength(1)
    expect(text).toContain("할 일: ui 동료 리뷰어: 동료의 보고를 읽고 정하기")
    // The peer's own view: its area and its line.
    const own = await h.services.features().digest.render({ teamID: TEAM_ID, areaID: UI })
    expect(own).toContain("· 동료 리뷰어: 막힘")
  })

  test("talk in a peer conversation shows on the peer's line, not as the owner's area being driven by the user", async () => {
    const h = await setup()
    await h.register()
    await PromptHook.record(h.services, REVIEWER)
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    const area = text.split("\n").find((line) => line.startsWith("- ui:"))
    expect(area).toBe("- ui: 쉬는 중")
    expect(text).toContain(`  · ${OwnTeamText.PEER} 리뷰어: 쉬는 중 · 사용자가 직접 대화함(`)
  })
})

describe("a peer's log (5.5, 5.6)", () => {
  /** A durable event of a session's log, published live. */
  const logged = (h: Harness, seq: number, type: string, data: Readonly<Record<string, unknown>>) =>
    h.controller.hub.receive({
      id: `evt_${seq}`,
      created: F4_NOW + seq,
      type,
      durable: { aggregateID: REVIEWER, seq, version: 1 },
      data: { sessionID: REVIEWER, ...data },
      // SAFETY (test): a durable core event with the fields own.team reads.
    } as never)
  /** The request admitted to and delivered from the peer's inbox, as its log says it. */
  const received = (h: Harness, dispatchID: OwnTeam.DispatchID) => {
    const inboxID = MsgID.dispatch(dispatchID, REVIEWER)
    const metadata = {
      [OwnTeam.DISPATCH_META]: { id: dispatchID, from: "main", teamID: TEAM_ID, areaID: UI, to: "peer" },
    }
    logged(h, 42, "session.inbox.enqueued", { inboxID, item: { payload: { metadata } } })
    logged(h, 43, "session.inbox.delivered", { inboxID })
    h.core.inbox.set(REVIEWER, [])
  }

  test("a run that ends without an answer is 끝났지만 보고 없음 under the peer; its done makes 모두 끝남", async () => {
    const h = await setup()
    await h.register()
    const sent = await h.dispatch("읽어 주세요", "peer")
    if (!sent.ok) throw new Error("not sent")
    received(h, sent.dispatchID)
    logged(h, 44, "session.execution.succeeded", {})
    await until(async () => (await h.digest()).entries.some((item) => item.reason === "unreported"))
    const missing = (await h.digest()).entries.find((item) => item.reason === "unreported")
    expect(missing).toMatchObject({ areaID: UI, peer: "peer", wake: false, text: "동료 리뷰어: 끝났지만 보고 없음" })
    expect((await h.digest()).areas[UI]?.peers?.peer?.received?.dispatchID).toBe(sent.dispatchID)

    const judged = OwnerTools.judgeArea(await h.services.locate.session(REVIEWER))
    if (!judged.ok || judged.caller.role !== "peer") throw new Error("not a peer caller")
    h.clock.advance(1_000)
    await ReportTool.run(h.services, judged.caller, { kind: "done", text: "다 읽었습니다" })
    logged(h, 45, "session.execution.succeeded", {})
    await until(async () => (await h.digest()).entries.some((item) => item.reason === "all-done"))
  })

  test("while the peer still works, 모두 끝남 waits even when the owner is done", async () => {
    const h = await setup()
    await h.register()
    const sent = await h.dispatch("읽어 주세요", "peer")
    if (!sent.ok) throw new Error("not sent")
    received(h, sent.dispatchID)
    h.core.active.add(REVIEWER)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await Bun.sleep(50)
    expect((await h.digest()).entries.some((item) => item.reason === "all-done")).toBe(false)
  })
})

describe("peers.role after a settings save (2026-11-14)", () => {
  test("directTell and the peer block bring an attached peer's entry up again once; directHold and the owner block do not", async () => {
    const h = await setup()
    await h.register()
    expect(await h.dispatch("변경을 읽어 주세요", "peer")).toMatchObject({ ok: true })
    const role = () => h.services.features().peers.role?.({ teamID: TEAM_ID, areaID: UI, key: "peer" })
    const text = () => String(h.core.entries.get(REVIEWER)?.get(RoleInstructions.PEER))
    await role()
    const first = entryWrites(h, REVIEWER).length
    expect(text()).toContain("메인이나 다른 영역에 영향이 있을 때")

    await TeamSettings.write(h.services, TEAM_ID, { policy: { directHold: true }, instructions: { owner: "- 짧게." } })
    await role()
    expect(entryWrites(h, REVIEWER)).toHaveLength(first)

    await TeamSettings.write(h.services, TEAM_ID, { policy: { directTell: "always" } })
    await role()
    await role()
    expect(entryWrites(h, REVIEWER)).toHaveLength(first + 1)
    expect(text()).toContain('- 사용자가 직접 시킨 일을 끝냈으면 team_report(kind:"progress")로 한두 줄 요약한다.')

    await TeamSettings.write(h.services, TEAM_ID, { instructions: { peer: "- 리뷰는 목록으로 쓴다." } })
    await role()
    expect(entryWrites(h, REVIEWER)).toHaveLength(first + 2)
    expect(text()).toEndWith(`${RoleInstructions.GUARD}
- 리뷰는 목록으로 쓴다.`)
    // Peers never start direct work: no hold sentence, and the relay names the role change as the main's.
    expect(text()).not.toContain("'직접 작업'이 된다")
    expect(text()).toContain("영역 끝내기, 영역 역할 바꾸기, 팀에서 빼기")
  })
})

describe("the peer role passes the main's work on (06 §5.5, 2026-10-16)", () => {
  test("state reports are three, and a relay goes to the team main", () => {
    const role = RoleInstructions.peer({
      team: { target: "main", policy: OwnTeam.POLICY },
      area: { name: "화면", directory: "D:/w/ui", branch: "ui", shape: "plain" },
      peer: { key: "reviewer", label: "리뷰어", role: "" },
      blocks: {},
    })
    expect(role).toContain("- 상태 보고는 셋만 쓴다:")
    expect(role).toContain('team_report(kind:"relay", text:"<사용자 말 그대로>")')
  })
})
