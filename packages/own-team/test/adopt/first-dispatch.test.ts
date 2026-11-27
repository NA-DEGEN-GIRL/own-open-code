// An adopted owner at its first main request (06 §3.7, §2.8, §5.1, §6.1; TG9 and TG16 adopted items at plugin level):
// the conversation was registered without the team (`owner.attached: false`, delta 0 at adoption); the first main
// request attaches it (the team tool allows, approval tail, `own.team.role`, the area preset with the team context)
// before the request is admitted, then the request goes in with `queue` delivery. A second request writes nothing, so
// the session's tool catalog changes once (delta 1). A large adopted conversation (300k tokens) continues as it is:
// no rotation, no new conversation, no compaction (U6). A fake core on 127.0.0.1, F4's fake accounts and presets, a
// manual clock; nothing real is reached.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { MsgID } from "../../src/dispatch/msg-id.js"
import type { Hub } from "../../src/hub.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Permissions } from "../../src/tools/permissions.js"
import { F4_NOW, F4_PRESETS, F4_REFS, f4Accounts } from "../fixtures/f4-layout.js"
import { temp } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import {
  MAIN_SESSION,
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
// A fake core behind the self-HTTP routes: sessions (with their model), the active set, inboxes, messages, metadata
// and instruction entries. Routes are added per session id (the fake service matches exact paths). `order` records the
// writes that matter here, HTTP and own.accounts RPC alike, in the order they happened.

const Metadata = Schema.Record(Schema.String, Schema.Unknown)
const decodeCreate = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    model: optional(Model.Ref),
    location: Schema.Struct({ directory: Schema.String }),
    metadata: optional(Metadata),
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
const decodePatch = Schema.decodeUnknownSync(Schema.Struct({ metadata: Metadata }))
const decodeEntry = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Unknown }))

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
  /** Fields of a session view own.team never reads (its size). */
  const sizes = new Map<string, Readonly<Record<string, unknown>>>()
  const inbox = new Map<string, Item[]>()
  const entries = new Map<string, Map<string, unknown>>()
  const messages = new Map<string, unknown[]>()
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  service.routes.set("GET /api/session", (request) =>
    Response.json({
      data: [...views.values()].filter((view) => view.location.directory === request.query.directory),
      cursor: {},
    }),
  )
  const add = (
    input: Parameters<typeof session>[0] & {
      readonly model?: Model.Ref
      readonly size?: Readonly<Record<string, unknown>>
    },
  ) => {
    const id = input.id
    const base = `/api/session/${id}`
    const entriesPath = `/api/experimental/session/${id}/instructions/entries`
    views.set(id, session(input))
    if (input.size) sizes.set(id, input.size)
    if (input.model) models.set(id, input.model)
    entries.set(id, new Map())
    const admit = (kind: "prompt" | "synthetic") => (request: { readonly body: unknown }) => {
      const body = decodeAdmission(request.body)
      const type = kind === "prompt" ? "user" : "synthetic"
      order.push(`${kind} ${id}`)
      const items = inbox.get(id) ?? []
      const existing = items.find((item) => item.id === body.id)
      if (existing) return Response.json({ data: existing })
      const item: Item = {
        id: body.id,
        sessionID: id,
        type,
        delivery: body.delivery ?? "steer",
        payload: { text: body.text, ...(body.metadata === undefined ? {} : { metadata: body.metadata }) },
      }
      inbox.set(id, [...items, item])
      return Response.json({ data: item })
    }
    service.routes.set(`GET ${base}`, () => Response.json({ data: { ...views.get(id), ...sizes.get(id) } }))
    service.routes.set(`PATCH ${base}`, (request) => {
      const view = views.get(id)
      if (view) views.set(id, { ...view, metadata: decodePatch(request.body).metadata })
      return new Response(null, { status: 204 })
    })
    service.routes.set(`GET ${base}/inbox`, () => Response.json({ data: inbox.get(id) ?? [] }))
    service.routes.set(`GET ${base}/permission`, () => Response.json({ data: [] }))
    service.routes.set(`GET ${base}/message`, () => Response.json({ data: messages.get(id) ?? [], cursor: {} }))
    service.routes.set(`POST ${base}/prompt`, admit("prompt"))
    service.routes.set(`POST ${base}/synthetic`, admit("synthetic"))
    service.routes.set(`GET /api/experimental/session/${id}/log`, () => new Response(""))
    service.routes.set(`GET ${entriesPath}`, () =>
      Response.json({ data: [...(entries.get(id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF])
      service.routes.set(`PUT ${entriesPath}/${key}`, (request) => {
        order.push(`entry ${key} ${id}`)
        entries.get(id)?.set(key, decodeEntry(request.body).value)
        return new Response(null, { status: 204 })
      })
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
  /** What was admitted to a session with `kind`, in order. */
  const admitted = (id: string, kind: "prompt" | "synthetic") =>
    service.requests
      .filter((request) => request.method === "POST" && request.path === `/api/session/${id}/${kind}`)
      .map((request) => decodeAdmission(request.body))
  return { active, views, inbox, entries, messages, add, admitted }
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

// ---------------------------------------------------------------------------------------------------------------
// Fixture: a team on ChatGPT 01 and one adopted folder whose most recent conversation (ChatGPT 01 too, bound to the
// non-★ `다른 회사 리뷰` before the team existed) was registered as its owner without the team.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ADOPTED = SessionID.make("ses_adopted00000000000000000001")
const CU = OwnTeam.AreaID.make("ar_cl-cu")
const TEAM_CONTEXT: Preset.Team = {
  teamID: TEAM_ID,
  role: "owner",
  accounts: [Account.ID.make("acc_chatgpt01")],
  pinned: [],
}
/** A rule the user gave the conversation before adoption; the team never touches it. */
const COMPUTER: Rule = { action: "computer", resource: "*", effect: "allow" }

async function setup(input: { readonly size?: Readonly<Record<string, unknown>>; readonly paused?: boolean } = {}) {
  const box = temp("own-team-first-dispatch-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folder = path.join(home, ".worktrees", "cl-cu")
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
  core.add({ id: ADOPTED, directory: folder, model: F4_REFS.team, ...(input.size ? { size: input.size } : {}) })
  const world = new World()
  const accounts = f4Accounts(world.accounts, models)
  accounts.bindings.set(ADOPTED, { presetID: F4_PRESETS.review.id, group: "codex" })
  accounts.modes.set(ADOPTED, "full")
  for (const [method, answer] of [...world.accounts])
    world.accounts.set(method, (call) => {
      order.push(`rpc ${method}`)
      return answer(call)
    })
  // The adopted conversation's permissions as the plugin API reads and writes them; every write is counted.
  const permissions = { rules: [COMPUTER], writes: 0 }
  const adopted: FakeSession = {
    id: ADOPTED,
    directory: folder,
    get permissions() {
      return permissions.rules
    },
    set permissions(rules) {
      permissions.rules = rules
      permissions.writes += 1
      order.push(`permissions ${ADOPTED}`)
    },
  }
  world.sessions.set(ADOPTED, adopted)
  const clock = manual(F4_NOW)
  const h = controller(world, {
    directory: home,
    clock,
    source: service.source,
    features: { teamContext: () => ({ get: async () => TEAM_CONTEXT, push: async () => {} }) },
  })
  cleanups.push(() => h.close())
  const record: OwnTeam.Area = {
    ...area({ slug: "cl-cu", directory: folder }),
    origin: "adopted",
    owner: { sessionID: ADOPTED, previous: [], attached: false },
    main: { model: F4_REFS.team, chosenBy: "adopted" },
    preset: F4_PRESETS.review.id,
    paused: input.paused ? "user" : false,
  }
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(record)
  })
  const dispatch = (text: string) =>
    h.services.features().admit.dispatch({ teamID: TEAM_ID, areaID: CU, text, from: "main", kind: "task" })
  /** The owner takes its queue and runs; its run then succeeds. */
  const turn = () => {
    core.inbox.set(ADOPTED, [])
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: ADOPTED }))
  }
  const stored = async () => (await h.services.registry.areas.get(TEAM_ID, CU))!
  return { ...h, home, folder, service, core, world, accounts, order, permissions, record, dispatch, turn, stored }
}

type Harness = Awaited<ReturnType<typeof setup>>

function calls(h: Harness, method: string) {
  return h.world.calls.filter((call) => call.method === method).map((call) => call.input)
}

/** Writes to the adopted conversation's instruction entries. */
function entryWrites(h: Harness) {
  return h.service.requests.filter(
    (request) => request.method === "PUT" && request.path.startsWith(`/api/experimental/session/${ADOPTED}/`),
  )
}

/** Nothing in own.team made a new conversation, asked an LLM for text, or compacted one. */
function kept(h: Harness) {
  expect(h.service.requests.filter((request) => request.method === "POST" && request.path === "/api/session")).toEqual(
    [],
  )
  expect(h.service.requests.some((request) => /\/(generate|compact)$/.test(request.path))).toBe(false)
}

// ---------------------------------------------------------------------------------------------------------------

describe("an adopted owner's first main request (06 §3.7, §2.8)", () => {
  test("the team is attached before the request goes in, then queue delivery; nothing else of the conversation changes", async () => {
    const h = await setup()
    // TG16: adoption itself wrote nothing to the conversation.
    expect(h.permissions.writes).toBe(0)
    expect(entryWrites(h)).toEqual([])
    expect(calls(h, "session.preset.apply")).toEqual([])

    const sent = await h.dispatch("정렬을 고치세요")
    expect(sent).toMatchObject({ ok: true, state: "queued" })
    if (!sent.ok) return

    // Attach first (the allows, the approval tail, the role entry, the area preset with the team), then the request.
    const writes = h.order.filter((item) => !item.startsWith("rpc ") || /approval\.set|preset\.apply/.test(item))
    expect(writes).toEqual([
      `permissions ${ADOPTED}`,
      "rpc session.approval.set",
      `entry ${RoleInstructions.OWNER} ${ADOPTED}`,
      "rpc session.preset.apply",
      `prompt ${ADOPTED}`,
    ])
    expect(h.permissions.rules).toEqual([...Permissions.rules("owner"), COMPUTER])
    expect(calls(h, "session.approval.set")).toEqual([{ sessionID: ADOPTED, mode: "full" }])
    expect(String(h.core.entries.get(ADOPTED)?.get(RoleInstructions.OWNER))).toContain("cl-cu")
    expect(h.core.entries.get(ADOPTED)?.has(RoleInstructions.HANDOFF)).toBe(false)
    expect(calls(h, "session.preset.apply")).toEqual([
      { sessionID: ADOPTED, presetID: F4_PRESETS.review.id, team: TEAM_CONTEXT },
    ])

    const [prompt] = h.core.admitted(ADOPTED, "prompt")
    expect(prompt?.id).toBe(MsgID.dispatch(sent.dispatchID, ADOPTED))
    expect(prompt?.delivery).toBe("queue")
    expect(prompt?.metadata).toMatchObject({
      [OwnTeam.DISPATCH_META]: { id: sent.dispatchID, from: "main", areaID: CU },
      source: OwnTeam.PROMPT_SOURCE,
    })
    // The registry: attached; the conversation's model and preset stay the area's (10.1 adopted).
    const after = await h.stored()
    expect(after.owner).toEqual({ sessionID: ADOPTED, previous: [], attached: true })
    expect(after.main).toEqual({ model: F4_REFS.team, chosenBy: "adopted" })
    expect(after.preset).toBe(F4_PRESETS.review.id)
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect(h.core.admitted(ADOPTED, "synthetic")).toEqual([])
    kept(h)
  })

  test("a second request writes no permission, instruction entry or binding: the catalog changed once (TG16 delta 1)", async () => {
    const h = await setup()
    expect(await h.dispatch("첫 요청")).toMatchObject({ state: "queued" })
    const writes = { permissions: h.permissions.writes, entries: entryWrites(h).length, world: h.world.calls.length }
    expect(writes).toMatchObject({ permissions: 1, entries: 1 })

    const second = await h.dispatch("다음 요청")
    expect(second).toMatchObject({ state: "waiting", why: "queued" })
    h.turn()
    await until(() => h.core.admitted(ADOPTED, "prompt").length === 2)

    expect(h.permissions.writes).toBe(1)
    expect(entryWrites(h)).toHaveLength(1)
    const later = h.world.calls.slice(writes.world).map((call) => call.method)
    expect(later.filter((method) => /approval\.set|preset\.apply|ultra/.test(method))).toEqual([])
    expect(calls(h, "session.approval.set")).toHaveLength(1)
    expect(calls(h, "session.preset.apply")).toHaveLength(1)
    // The team allow went in once; nothing else of the session's rules moved.
    expect(h.permissions.rules.filter((rule) => rule.action.startsWith("team."))).toEqual([
      ...Permissions.rules("owner"),
    ])
    kept(h)
  })

  test("a 300k-token adopted conversation continues as it is: no rotation, no new conversation, no compaction (U6)", async () => {
    const h = await setup({
      size: {
        tokens: { input: 300_000, output: 12_000, reasoning: 0, cache: { read: 280_000, write: 20_000 } },
        cost: 41.5,
      },
    })
    h.core.messages.set(
      ADOPTED,
      Array.from({ length: 800 }, (_, index) => ({
        id: `msg_${index}`,
        type: "assistant",
        content: [{ type: "text", text: "x".repeat(1_000) }],
      })),
    )
    expect(await h.dispatch("이어서 하세요")).toMatchObject({ state: "queued" })
    expect(h.core.admitted(ADOPTED, "prompt")).toHaveLength(1)
    expect((await h.stored()).owner).toEqual({ sessionID: ADOPTED, previous: [], attached: true })
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    // No rotation was asked, and own.team never read the conversation's history to decide.
    expect(
      h.service.requests.filter((request) => request.method === "GET" && request.path.endsWith("/message")),
    ).toEqual([])
    kept(h)
  })

  test("Main 멈춤: the request waits and nothing is attached until it goes off", async () => {
    const h = await setup({ paused: true })
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "paused" })
    await Bun.sleep(30)
    expect(h.permissions.writes).toBe(0)
    expect(entryWrites(h)).toEqual([])
    expect(h.core.admitted(ADOPTED, "prompt")).toEqual([])
    expect((await h.stored()).owner.attached).toBe(false)

    await h.services.write(TEAM_ID, async () => h.services.registry.areas.put({ ...(await h.stored()), paused: false }))
    await h.services.features().admit.drain({ teamID: TEAM_ID, areaID: CU })
    await until(() => h.core.admitted(ADOPTED, "prompt").length === 1)
    expect(h.permissions.writes).toBe(1)
    expect((await h.stored()).owner.attached).toBe(true)
  })

  test("an attach that fails keeps the request waiting with nothing sent; the next event attaches and sends", async () => {
    const h = await setup()
    const role = `PUT /api/experimental/session/${ADOPTED}/instructions/entries/${RoleInstructions.OWNER}`
    const working = h.service.routes.get(role)!
    h.service.routes.set(role, () => Response.json({ _tag: "Boom", message: "down" }, { status: 500 }))
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "maintaining" })
    expect(h.core.admitted(ADOPTED, "prompt")).toEqual([])
    expect((await h.stored()).owner.attached).toBe(false)
    expect(h.services.errors(TEAM_ID).some((entry) => entry.message.startsWith("attach:"))).toBe(true)

    h.service.routes.set(role, working)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: ADOPTED }))
    await until(() => h.core.admitted(ADOPTED, "prompt").length === 1)
    expect((await h.stored()).owner.attached).toBe(true)
    // The allows were read-merge-written each time: still exactly one copy of the team rules.
    expect(h.permissions.rules.filter((rule) => rule.action.startsWith("team."))).toEqual([
      ...Permissions.rules("owner"),
    ])
  })
})
