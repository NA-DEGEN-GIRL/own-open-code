// Owner conversation rotation and 메인 새 대화 (06 §6.1, §6.2, §6.4, §6.5, 07 P-D8; TG9 at plugin level): only at
// semantic boundaries (`fresh`, the user's action, account changes), at a safe point, a warm handoff turn on the old
// owner or a program handoff, the new owner from the handoff, the registry swap, the old conversation archived and out
// of the team, and no rotation or compaction by size anywhere in own.team. A fake core on 127.0.0.1, fake own.accounts
// answers and a manual clock; nothing real is reached.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Outbox } from "../../src/dispatch/dispatch.js"
import { MsgID } from "../../src/dispatch/msg-id.js"
import type { Hub } from "../../src/hub.js"
import { Undo } from "../../src/ops/undo.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Rotation } from "../../src/sessions/rotate.js"
import { SafePoint } from "../../src/sessions/safe-point.js"
import { Tools } from "../../src/tools/index.js"
import { MainTools } from "../../src/tools/main.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { Permissions } from "../../src/tools/permissions.js"
import { manual } from "../support/clock.js"
import {
  MAIN_SESSION,
  OLD_OWNER,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  context,
  controller,
  team,
} from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"
import { temp } from "../fixtures/repo.js"

setDefaultTimeout(30_000)

// ---------------------------------------------------------------------------------------------------------------
// A fake core behind the self-HTTP routes: sessions, the active set, inboxes, permissions, instruction entries and
// metadata. Routes are added per session id (the fake service matches exact paths).

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
  readonly payload: { readonly text?: string; readonly metadata?: Readonly<Record<string, unknown>> }
  readonly time?: { readonly created: number }
}

function fakeCore(service: FakeService) {
  const active = new Set<string>()
  const views = new Map<string, ReturnType<typeof session>>()
  const inbox = new Map<string, Item[]>()
  const entries = new Map<string, Map<string, unknown>>()
  const messages = new Map<string, unknown[]>()
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  service.routes.set("GET /api/session", (request) =>
    Response.json({
      data: [...views.values()].filter(
        (view) => view.location.directory === request.query.directory && !("parentID" in view),
      ),
      cursor: {},
    }),
  )
  const add = (input: Parameters<typeof session>[0]) => {
    const id = input.id
    const base = `/api/session/${id}`
    views.set(id, session(input))
    entries.set(id, new Map())
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
      }
      inbox.set(id, [...items, item])
      service.routes.set(`DELETE ${base}/inbox/${body.id}`, () => {
        inbox.set(
          id,
          (inbox.get(id) ?? []).filter((kept) => kept.id !== body.id),
        )
        return new Response(null, { status: 204 })
      })
      return Response.json({ data: item })
    }
    service.routes.set(`GET ${base}`, () => Response.json({ data: views.get(id) }))
    service.routes.set(`PATCH ${base}`, (request) => {
      const view = views.get(id)
      if (view) views.set(id, { ...view, metadata: decodePatch(request.body).metadata })
      return new Response(null, { status: 204 })
    })
    service.routes.set(`GET ${base}/inbox`, () => Response.json({ data: inbox.get(id) ?? [] }))
    service.routes.set(`GET ${base}/permission`, () => Response.json({ data: [] }))
    service.routes.set(`GET ${base}/message`, () => Response.json({ data: messages.get(id) ?? [], cursor: {} }))
    service.routes.set(`POST ${base}/synthetic`, admit("synthetic"))
    service.routes.set(`POST ${base}/prompt`, admit("user"))
    service.routes.set(`GET /api/experimental/session/${id}/log`, () => new Response(""))
    service.routes.set(`GET /api/experimental/session/${id}/instructions/entries`, () =>
      Response.json({ data: [...(entries.get(id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF])
      service.routes.set(`PUT /api/experimental/session/${id}/instructions/entries/${key}`, (request) => {
        entries.get(id)?.set(key, decodeEntry(request.body).value)
        return new Response(null, { status: 204 })
      })
  }
  service.routes.set("POST /api/session", (request) => {
    const body = decodeCreate(request.body)
    if (!views.has(body.id))
      add({
        id: body.id,
        directory: body.location.directory,
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      })
    return Response.json({ data: views.get(body.id) })
  })
  /** What was admitted to a session (`synthetic` or `prompt`), in order. */
  const admitted = (id: string, kind: "synthetic" | "prompt") =>
    service.requests
      .filter((request) => request.method === "POST" && request.path === `/api/session/${id}/${kind}`)
      .map((request) => decodeAdmission(request.body))
  const created = () =>
    service.requests.filter((request) => request.method === "POST" && request.path === "/api/session")
  return { active, views, inbox, entries, messages, add, admitted, created }
}

function event(type: string, data: Readonly<Record<string, unknown>>): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return { id: `evt_${type}_${Math.random()}`, created: 1, type, data } as never
}

async function until(check: () => boolean | Promise<boolean>, ms = 30_000) {
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
const AREA_PRESET = Preset.ID.create()
const OLD_PRESET = Preset.ID.create()
const MAIN_PRESET = Preset.ID.create()
const TEAM_CONTEXT: Preset.Team = { teamID: TEAM_ID, role: "owner", accounts: [], pinned: [] }
const TEAM_MAIN = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-team", providerID: "openai", variant: "high" })
const CHILD = SessionID.make("ses_child000000000000000000001")
const HANDOFF = Tools.DEFINITIONS.find((item) => item.name === "handoff")!

function binding(presetID: Preset.ID) {
  return { presetID, group: "codex", revision: 0, appliedAt: 0, entryHash: null, team: TEAM_CONTEXT }
}

/** own.accounts: one ChatGPT account; the old owner's mode is `full`, the main's `read-only`. */
function accounts(world: World, input: { readonly blocked?: boolean }) {
  const modes = new Map<string, string>([
    [OWNER_SESSION, "full"],
    [MAIN_SESSION, "read-only"],
  ])
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", (call) => ({
    groups: [{ group: (call as { readonly group: string }).group, defaultModel: null }],
  }))
  world.accounts.set("session.approval.get", (call) => ({
    mode: modes.get((call as { readonly sessionID: string }).sessionID) ?? "ask",
  }))
  world.accounts.set("session.approval.set", (call) => ({
    mode: (call as { readonly mode: string }).mode,
    patched: [(call as { readonly sessionID: string }).sessionID],
  }))
  world.accounts.set("session.preset.get", (call) => {
    const sessionID = (call as { readonly sessionID: string }).sessionID
    const presetID = sessionID === OWNER_SESSION ? OLD_PRESET : sessionID === MAIN_SESSION ? MAIN_PRESET : undefined
    return presetID === undefined
      ? { binding: null, preset: null }
      : { binding: binding(presetID), preset: { id: presetID } }
  })
  world.accounts.set("session.preset.apply", () => ({
    binding: {},
    resolution: null,
    entry: "written",
    dryRun: false,
  }))
  world.accounts.set("switch.state", () =>
    input.blocked ? { state: "BLOCKED", reason: "all_exhausted", nextResetAt: null } : { state: "STEADY" },
  )
}

async function setup(input: { readonly area?: (base: OwnTeam.Area) => OwnTeam.Area; readonly blocked?: boolean } = {}) {
  const box = temp("own-team-rotate-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folder = path.join(box.root, "home-team", "ui")
  for (const dir of [home, folder]) fs.mkdirSync(dir, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const core = fakeCore(service)
  core.add({ id: MAIN_SESSION, directory: home, model: TEAM_MAIN, metadata: { "own.team": { role: "main" } } })
  core.add({
    id: OWNER_SESSION,
    directory: folder,
    model: TEAM_MAIN,
    metadata: { "own.team": { role: "owner", teamID: TEAM_ID, areaID: UI }, "user.note": "kept" },
  })
  // The owner conversation has worked: it gets a handoff turn.
  core.messages.set(OWNER_SESSION, [
    { id: "msg_answer", type: "assistant", content: [{ type: "text", text: "정렬을 고쳤습니다." }] },
  ])
  const world = new World()
  accounts(world, input)
  const clock = manual()
  const h = controller(world, {
    directory: home,
    clock,
    source: service.source,
    features: { teamContext: () => ({ get: async () => TEAM_CONTEXT, push: async () => {} }) },
  })
  cleanups.push(() => h.close())
  const base: OwnTeam.Area = {
    ...area({ slug: "ui", directory: folder }),
    name: "인벤토리 화면",
    goal: "정렬 버그와 UI",
    preset: AREA_PRESET,
  }
  const record = input.area ? input.area(base) : base
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(record)
  })
  const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: h.services.log })
  // SAFETY (test): every handler takes its method's input and `{signal, error}`.
  const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
  const rpc = (method: string, call: unknown) =>
    loose[method]!(call, {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
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
  /** The op once it stopped running. */
  const settled = async (opID: string) => {
    await until(async () => (await h.services.journal.find(opID))?.state !== "running")
    return (await h.services.journal.find(opID))!
  }
  const owner = async () => (await h.services.registry.areas.get(TEAM_ID, UI))!.owner
  return { ...h, clock, home, folder, core, service, world, record, rpc, turn, settled, owner }
}

type Harness = Awaited<ReturnType<typeof setup>>

function calls(h: Harness, method: string) {
  return h.world.calls.filter((call) => call.method === method).map((call) => call.input)
}

function opID(result: unknown) {
  return Schema.decodeUnknownSync(Schema.Struct({ opID: OwnTeam.OpID }))(result).opID
}

/**
 * own.harness' notice of a harness switch, admitted at `at` without a wake (`resume: false`): it goes with the
 * session's next prompt and starts no run (RH-15).
 */
function switched(sessionID: string, at: number): Item {
  return {
    id: `msg_switch_${sessionID}`,
    sessionID,
    type: "synthetic",
    delivery: "steer",
    payload: { text: "Harness: codex → pi", metadata: { "own.harness": { switch: { from: "codex", to: "pi" } } } },
    time: { created: at },
  }
}

/** Nothing in own.team asks an LLM for a handoff or compacts a conversation. */
function quiet(h: Harness) {
  expect(h.service.requests.some((request) => /\/(generate|compact)$/.test(request.path))).toBe(false)
}

// ---------------------------------------------------------------------------------------------------------------

describe("owner rotation (06 §6.2)", () => {
  test("새 대화로 이어가기: warm handoff turn, the new owner from it, registry swap, the old conversation archived", async () => {
    const h = await setup()
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1)
    const [asked] = h.core.admitted(OWNER_SESSION, "synthetic")
    expect(asked?.id).toBe(MsgID.of(id, "handoff", OWNER_SESSION))
    expect(asked?.text.split("\n")[0]).toBe('<team-request kind="handoff" area="인벤토리 화면">')
    expect(asked?.text).toContain("team_handoff{text}")
    expect(asked?.text).toMatch(/첫 줄: # 인계: 인벤토리 화면 \(\d{4}-\d{2}-\d{2}, 담당 대화 #2\)/)
    expect(asked?.text.endsWith("</team-request>")).toBe(true)
    expect(asked?.metadata).toEqual({
      source: OwnTeam.PROMPT_SOURCE,
      [OwnTeam.REQUEST_META]: { kind: "handoff", opID: id },
    })
    expect(asked?.delivery).toBe("queue")
    // Main requests made meanwhile wait for the rotation.
    expect(
      await h.services
        .features()
        .admit.dispatch({ teamID: TEAM_ID, areaID: UI, text: "다음 일", from: "main", kind: "task" }),
    ).toMatchObject({ state: "waiting", why: "maintaining" })

    const document = "# 인계: 인벤토리 화면 (2026-10-02, 담당 대화 #2)\n## 남은 것\n- 정렬 테스트"
    await h.turn(OWNER_SESSION, async () => {
      // 6.2: the old owner's reports in the rotation window are accepted.
      expect(
        await h.services.features().events.report({
          teamID: TEAM_ID,
          areaID: UI,
          sessionID: OWNER_SESSION,
          kind: "progress",
          text: "인계를 쓰는 중",
        }),
      ).toMatchObject({ ok: true })
      expect(await HANDOFF.execute(h.services, OWNER_SESSION, { text: document })).toMatchObject({ ok: true })
    })
    const op = await h.settled(id)
    expect(op).toMatchObject({ kind: "rotate", by: "user", areaID: UI, state: "done" })
    expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
      [Rotation.KIND.begin, "done"],
      [Rotation.KIND.handoff, "done"],
      [Rotation.KIND.owner, "done"],
      [Rotation.KIND.swap, "done"],
      [Rotation.KIND.archive, "done"],
    ])
    expect(op.summary?.lines).toEqual([{ kind: "area", areaID: UI, change: "rotated" }])

    // Registry: the new id is the one written ahead, the old one is in `previous`.
    const owner = await h.owner()
    const next = owner.sessionID!
    expect(owner).toEqual({
      sessionID: next,
      previous: [
        { sessionID: OLD_OWNER, endedAt: 0, why: "user" },
        { sessionID: OWNER_SESSION, endedAt: h.clock.now(), why: "user" },
      ],
      attached: true,
    })
    const [create] = h.core.created()
    expect(create?.body).toEqual({
      id: next,
      title: "인벤토리 화면 · 담당",
      model: TEAM_MAIN,
      location: { directory: h.folder },
      metadata: { "own.team": { role: "owner", teamID: TEAM_ID, areaID: UI } },
      permissions: Permissions.rules("owner").map((rule) => ({ ...rule })),
    })
    // The old owner's approval mode, never computer use; the area preset with the team, ultra off.
    expect(calls(h, "session.approval.set")).toEqual([{ sessionID: next, mode: "full" }])
    expect(calls(h, "session.preset.apply")).toEqual([
      { sessionID: next, presetID: AREA_PRESET, team: TEAM_CONTEXT },
      { sessionID: OWNER_SESSION, presetID: OLD_PRESET, team: null },
    ])
    expect(calls(h, "session.ultra.set")).toEqual([])
    // 02 §4.8: a new owner conversation starts at Standard; the old owner's speed is not copied.
    expect(calls(h, "session.speed.set")).toEqual([])
    expect(h.core.entries.get(next)?.get(RoleInstructions.HANDOFF)).toBe(document)
    expect(String(h.core.entries.get(next)?.get(RoleInstructions.OWNER))).toContain("인벤토리 화면")
    // The old conversation: archived (other metadata kept), permissions untouched.
    expect(h.core.views.get(OWNER_SESSION)?.metadata).toEqual({
      "own.team": { role: "owner", teamID: TEAM_ID, areaID: UI },
      "user.note": "kept",
      [Undo.ARCHIVED]: true,
    })
    const patches = h.service.requests.filter((request) => request.method === "PATCH")
    expect(patches.map((request) => Object.keys(request.body as object))).toEqual([["metadata"]])
    expect(
      h.published.find((item) => item.name === "notice" && item.data.kind === "rotation.done")?.data,
    ).toMatchObject({ teamID: TEAM_ID, areaID: UI, data: { sessionID: next, previous: OWNER_SESSION, reason: "user" } })

    // After the swap the old owner's team tools are refused.
    expect(await OwnerTools.check(h.services, OWNER_SESSION)).toEqual({ ok: false, text: OwnerTools.PREVIOUS_OWNER })
    expect(
      await h.services.features().events.report({
        teamID: TEAM_ID,
        areaID: UI,
        sessionID: OWNER_SESSION,
        kind: "done",
        text: "늦은 보고",
      }),
    ).toMatchObject({ ok: false, message: OwnerTools.PREVIOUS_OWNER })
    // The waiting main request goes to the new owner.
    await until(() => h.core.admitted(next, "prompt").length === 1)
    expect(h.core.admitted(OWNER_SESSION, "prompt")).toHaveLength(0)
    quiet(h)
  })

  test("team_dispatch fresh: the rotation runs before the request, a program handoff without team_handoff", async () => {
    const h = await setup()
    const sent = await h.services.features().admit.dispatch({
      teamID: TEAM_ID,
      areaID: UI,
      text: "관련 없는 새 일",
      fresh: true,
      from: "main",
      kind: "task",
    })
    expect(sent).toMatchObject({ state: "waiting", why: "maintaining" })
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")
    expect(op).toMatchObject({ by: "main", areaID: UI, state: "running" })
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1)
    expect(h.core.admitted(OWNER_SESSION, "prompt")).toHaveLength(0)

    // The handoff turn ends without team_handoff: the program writes the document.
    await h.turn(OWNER_SESSION)
    expect(await h.settled(op!.id)).toMatchObject({ state: "done" })
    const owner = await h.owner()
    const next = owner.sessionID!
    expect(owner.previous.at(-1)).toMatchObject({ sessionID: OWNER_SESSION, why: "fresh" })
    const record = await h.services.registry.areas.get(TEAM_ID, UI)
    const document = fs.readFileSync(record!.handoff!.file, "utf8")
    expect(document.startsWith("# 인계: 인벤토리 화면 (")).toBe(true)
    expect(document).toContain("프로그램이 만든 인계 문서")
    // The old conversation's last answer, read only.
    expect(document).toContain("> 정렬을 고쳤습니다.")
    expect(h.core.entries.get(next)?.get(RoleInstructions.HANDOFF)).toBe(document)

    await until(() => h.core.admitted(next, "prompt").length === 1)
    expect(h.core.admitted(next, "prompt")[0]?.metadata).toMatchObject({
      [OwnTeam.DISPATCH_META]: { from: "main", areaID: UI },
      source: OwnTeam.PROMPT_SOURCE,
    })
    expect(h.core.admitted(OWNER_SESSION, "prompt")).toHaveLength(0)
    // One rotation for the request.
    expect((await h.services.journal.list(TEAM_ID)).filter((item) => item.kind === "rotate")).toHaveLength(1)
    quiet(h)
  })

  test("a controller stopped during the handoff turn: the next one asks with the same id and makes one owner", async () => {
    const h = await setup()
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1)
    await h.close()
    const next = controller(h.world, {
      directory: h.home,
      clock: h.clock,
      source: h.service.source,
      features: { teamContext: () => ({ get: async () => TEAM_CONTEXT, push: async () => {} }) },
    })
    cleanups.push(() => next.close())
    // TI-11: the resumed step observes again and asks again; core keeps the first admission.
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 2)
    expect(new Set(h.core.admitted(OWNER_SESSION, "synthetic").map((item) => item.id))).toEqual(
      new Set([MsgID.of(id, "handoff", OWNER_SESSION)]),
    )
    expect(h.core.inbox.get(OWNER_SESSION)).toHaveLength(1)
    await h.turn(
      OWNER_SESSION,
      async () => {
        expect(await HANDOFF.execute(next.services, OWNER_SESSION, { text: "# 인계: 인벤토리 화면" })).toMatchObject({
          ok: true,
        })
      },
      next.controller.hub,
    )
    await until(async () => (await next.services.journal.find(id))?.state === "done")
    expect(h.core.created()).toHaveLength(1)
    const owner = (await next.services.registry.areas.get(TEAM_ID, UI))!.owner
    expect(owner.sessionID).toBe(
      Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(h.core.created()[0]?.body).id,
    )
    expect(owner.pending).toBeUndefined()
  })

  test("a BLOCKED old account gets no handoff turn: the program writes the handoff", async () => {
    const h = await setup({ blocked: true })
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    expect(calls(h, "switch.state")).toContainEqual({ sessionID: OWNER_SESSION })
    const record = await h.services.registry.areas.get(TEAM_ID, UI)
    expect(fs.readFileSync(record!.handoff!.file, "utf8")).toContain("프로그램이 만든 인계 문서")
    expect((await h.owner()).previous.at(-1)).toMatchObject({ sessionID: OWNER_SESSION, why: "user" })
    quiet(h)
  })

  test("a rotation after 담당 대화 바꾸기: the seat's model, the owner note and the unfinished release stay with the seat", async () => {
    const seat = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-seat", providerID: "openai" })
    const stuck = SessionID.make("ses_stuck000000000000000000001")
    const h = await setup({ blocked: true })
    // The old seat cannot be reached for now: it stays listed.
    h.core.add({ id: stuck, directory: h.folder, model: TEAM_MAIN })
    h.world.sessions.set(stuck, { id: stuck, directory: h.folder, permissions: [] })
    h.service.routes.set(`GET /api/experimental/session/${stuck}/instructions/entries`, () =>
      Response.json({ _tag: "Unavailable", message: "down" }, { status: 503 }),
    )
    // What a move leaves: the conversation's own model as the area's, the old seat in `previous` and to release.
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({
        ...h.record,
        main: { model: seat, chosenBy: "adopted" },
        owner: {
          sessionID: OWNER_SESSION,
          previous: [{ sessionID: stuck, endedAt: 5, why: "seat" }],
          attached: true,
          note: "화면 정렬을 맡은 대화",
          release: [stuck],
        },
      }),
    )
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    const owner = await h.owner()
    expect(owner).toEqual({
      sessionID: owner.sessionID,
      previous: [
        { sessionID: stuck, endedAt: 5, why: "seat" },
        { sessionID: OWNER_SESSION, endedAt: h.clock.now(), why: "user" },
      ],
      attached: true,
      note: "화면 정렬을 맡은 대화",
      release: [stuck],
    })
    expect(owner.sessionID).not.toBe(OWNER_SESSION)
    expect(h.core.created().map((request) => decodeCreate(request.body).model)).toEqual([seat])
    // The conversation a move seated is archived like any rotated owner.
    expect(h.core.views.get(OWNER_SESSION)?.metadata?.[Undo.ARCHIVED]).toBe(true)
    // Once it answers, the next sweep takes the old seat off the list.
    h.service.routes.set(`GET /api/experimental/session/${stuck}/instructions/entries`, () =>
      Response.json({ data: [] }),
    )
    await h.services.features().seat.sweep({ teamID: TEAM_ID, areaID: UI })
    expect((await h.owner()).release).toBeUndefined()
    quiet(h)
  })

  test("a context reset waiting in the old owner's queue: no handoff turn behind it, the program writes it", async () => {
    const h = await setup()
    h.core.inbox.set(OWNER_SESSION, [
      { id: "msg_reset", sessionID: OWNER_SESSION, type: "reset", delivery: "queue", payload: {} },
    ])
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    const record = await h.services.registry.areas.get(TEAM_ID, UI)
    expect(fs.readFileSync(record!.handoff!.file, "utf8")).toContain("프로그램이 만든 인계 문서")
    quiet(h)
  })

  test("a program handoff (stop, the R4 exception) never asks the old conversation", async () => {
    const h = await setup()
    const started = await h.services
      .features()
      .rotate.request({ teamID: TEAM_ID, areaID: UI, reason: "r4", handoff: "program", by: "auto" })
    if (!started.ok) throw new Error(started.message)
    expect(await h.settled(started.opID)).toMatchObject({ state: "done" })
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    expect((await h.owner()).previous.at(-1)).toMatchObject({ sessionID: OWNER_SESSION, why: "r4" })
  })

  test("an owner conversation without a message yet gets no handoff turn (a fresh first request)", async () => {
    const h = await setup()
    h.core.messages.set(OWNER_SESSION, [])
    const sent = await h.services.features().admit.dispatch({
      teamID: TEAM_ID,
      areaID: UI,
      text: "첫 일",
      fresh: true,
      from: "main",
      kind: "task",
    })
    expect(sent).toMatchObject({ state: "waiting", why: "maintaining" })
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")
    expect(await h.settled(op!.id)).toMatchObject({ state: "done" })
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    const next = (await h.owner()).sessionID!
    await until(() => h.core.admitted(next, "prompt").length === 1)
    quiet(h)
  })

  test("a harness switch notice that waits for the next prompt holds no fresh first request back (RH-15)", async () => {
    const h = await setup()
    h.core.messages.set(OWNER_SESSION, [])
    const notice = switched(OWNER_SESSION, h.clock.now())
    h.core.inbox.set(OWNER_SESSION, [notice])
    h.clock.advance(SafePoint.WAKE_MS)
    const sent = await h.services.features().admit.dispatch({
      teamID: TEAM_ID,
      areaID: UI,
      text: "첫 일",
      fresh: true,
      from: "main",
      kind: "task",
    })
    expect(sent).toMatchObject({ state: "waiting", why: "maintaining" })
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")
    expect(await h.settled(op!.id)).toMatchObject({ state: "done" })
    const next = (await h.owner()).sessionID!
    await until(() => h.core.admitted(next, "prompt").length === 1)
    // The notice stays with the old conversation (6.2: what is there stays there); nothing delivered it.
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([notice])
    quiet(h)
  })

  test("a run that ends before it takes the handoff request withdraws it; the program writes the handoff", async () => {
    const h = await setup()
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1)
    const request = MsgID.of(id, "handoff", OWNER_SESSION)
    // The run fails (a limit, a broken provider) before the request was delivered.
    h.controller.hub.receive(
      event("session.execution.failed", { sessionID: OWNER_SESSION, error: { message: "upstream" } }),
    )
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(
      h.service.requests.some(
        (item) => item.method === "DELETE" && item.path === `/api/session/${OWNER_SESSION}/inbox/${request}`,
      ),
    ).toBe(true)
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([])
    const record = await h.services.registry.areas.get(TEAM_ID, UI)
    expect(fs.readFileSync(record!.handoff!.file, "utf8")).toContain("프로그램이 만든 인계 문서")
  })

  test("it starts at the area's safe point: a working owner first finishes, a queued item first goes", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await Bun.sleep(50)
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    expect((await h.services.journal.find(id))?.steps[0]?.state).toBe("pending")

    // The owner's run ends, but an item the user queued is still in its inbox (8.4: not a safe point).
    h.core.inbox.set(OWNER_SESSION, [
      { id: "msg_user", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: { text: "사용자 입력" } },
    ])
    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await Bun.sleep(50)
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    // The item went without an event this test sends: the periodic look finds the safe point.
    h.core.inbox.set(OWNER_SESSION, [])
    h.clock.advance(Rotation.RECHECK_MS)
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1)
    await h.turn(OWNER_SESSION)
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    // The user's input stayed in the old conversation; nothing moved it.
    expect(h.core.admitted(OWNER_SESSION, "prompt")).toHaveLength(0)
  })

  test("Main 멈춤: an automatic rotation is skipped whole; the user's rotation runs", async () => {
    const h = await setup({ area: (base) => ({ ...base, paused: "user" }) })
    const automatic = await h.services
      .features()
      .rotate.request({ teamID: TEAM_ID, areaID: UI, reason: "fresh", handoff: "warm", by: "main" })
    if (!automatic.ok) throw new Error(automatic.message)
    const skipped = await h.settled(automatic.opID)
    expect(skipped.state).toBe("done")
    expect(skipped.steps.every((step) => step.state === "skipped")).toBe(true)
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    expect(h.core.created()).toHaveLength(0)

    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1)
    await h.turn(OWNER_SESSION)
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect((await h.owner()).sessionID).not.toBe(OWNER_SESSION)
    // Main 멈춤 stays on: requests keep waiting for the user.
    expect((await h.services.registry.areas.get(TEAM_ID, UI))?.paused).toBe("user")
  })

  test("direct work (2026-11-14): an automatic rotation is skipped with its own note; the user's rotation runs", async () => {
    const h = await setup({ area: (base) => ({ ...base, directWork: { since: 1, at: 2 } }) })
    const automatic = await h.services
      .features()
      .rotate.request({ teamID: TEAM_ID, areaID: UI, reason: "fresh", handoff: "warm", by: "main" })
    if (!automatic.ok) throw new Error(automatic.message)
    const skipped = await h.settled(automatic.opID)
    expect(skipped.state).toBe("done")
    expect(skipped.steps.every((step) => step.state === "skipped")).toBe(true)
    expect(JSON.stringify(skipped.steps)).toContain("직접 작업 중이라 자동으로 새 대화로 이어가지 않았어요")
    expect(h.core.created()).toHaveLength(0)

    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1)
    await h.turn(OWNER_SESSION)
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect((await h.owner()).sessionID).not.toBe(OWNER_SESSION)
  })

  test("an automatic rotation is not started again within a minute of a failed one; the user's is", async () => {
    const h = await setup()
    h.service.routes.set("POST /api/session", () => Response.json({ _tag: "Boom", message: "down" }, { status: 500 }))
    const request = (by: "main" | "user") =>
      h.services.features().rotate.request({
        teamID: TEAM_ID,
        areaID: UI,
        reason: by === "main" ? "fresh" : "user",
        handoff: "program",
        by,
      })
    const first = await request("main")
    if (!first.ok) throw new Error(first.message)
    expect(await h.settled(first.opID)).toMatchObject({ state: "failed" })
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
    expect(await request("main")).toMatchObject({
      ok: false,
      error: "busy",
      data: { teamID: TEAM_ID, opID: first.opID, kind: "rotate" },
    })
    const user = await request("user")
    if (!user.ok) throw new Error(user.message)
    await h.settled(user.opID)
    h.clock.advance(Rotation.RETRY_MS)
    expect(await request("main")).toMatchObject({ ok: true })
  })

  test("refusals: unknown area, broken area, no owner yet, team off, another op running", async () => {
    const h = await setup()
    expect(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: "ar_none" })).toMatchObject({
      type: "not_found",
      data: { what: "area" },
    })
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({ ...h.record, state: "broken", broken: { why: "missing", at: 0 } }),
    )
    expect(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI })).toMatchObject({
      type: "broken",
      data: { areaID: UI, why: "missing" },
    })
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({ ...h.record, owner: { sessionID: null, previous: [], attached: true } }),
    )
    expect(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI })).toMatchObject({
      type: "not_found",
      data: { what: "session" },
    })
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put(h.record))

    // A rotation waits for a working owner; a second one meanwhile is `busy`.
    h.core.active.add(OWNER_SESSION)
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    expect(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI })).toMatchObject({
      type: "busy",
      data: { opID: id, kind: "rotate" },
    })
    expect(await h.rpc("main.rotate", { teamID: TEAM_ID })).toMatchObject({ type: "busy" })

    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.teams.get(TEAM_ID)
      if (current) await h.services.registry.teams.put({ ...current, state: "off" })
    })
    expect(await h.rpc("main.rotate", { teamID: TEAM_ID })).toMatchObject({ type: "team_off" })
    expect(await h.rpc("main.rotate", { teamID: "tm_ffffffffffff" })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
  })

  test("done and progress reports never rotate", async () => {
    const h = await setup()
    for (const kind of ["progress", "done"] as const)
      expect(
        await h.services.features().events.report({
          teamID: TEAM_ID,
          areaID: UI,
          sessionID: OWNER_SESSION,
          kind,
          text: "끝",
        }),
      ).toMatchObject({ ok: true })
    await Bun.sleep(20)
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
  })
})

describe("에이전트 방식 across new conversations (2026-10-26)", () => {
  const PI = { id: "pi", v: 1, prompt: "own" }
  const named = (h: Harness, sessionID: string, value: unknown) => {
    const view = h.core.views.get(sessionID)
    if (view) h.core.views.set(sessionID, { ...view, metadata: { ...view.metadata, "own.harness": value } })
  }

  test("the new owner keeps the old owner's 에이전트 방식; an old owner that names none leaves it to the service", async () => {
    const h = await setup()
    named(h, OWNER_SESSION, PI)
    const started = await h.services
      .features()
      .rotate.request({ teamID: TEAM_ID, areaID: UI, reason: "user", handoff: "program", by: "user" })
    if (!started.ok) throw new Error(started.message)
    expect(await h.settled(started.opID)).toMatchObject({ state: "done" })
    const first = (await h.owner()).sessionID!
    expect(h.core.created().at(-1)?.body).toMatchObject({ id: first, metadata: { "own.harness": PI } })
    // The new owner itself named it (it was made so): the next rotation keeps it again.
    const again = await h.services
      .features()
      .rotate.request({ teamID: TEAM_ID, areaID: UI, reason: "user", handoff: "program", by: "user" })
    if (!again.ok) throw new Error(again.message)
    expect(await h.settled(again.opID)).toMatchObject({ state: "done" })
    expect(h.core.created().at(-1)?.body).toMatchObject({ metadata: { "own.harness": PI } })

    const plain = await setup()
    const other = await plain.services
      .features()
      .rotate.request({ teamID: TEAM_ID, areaID: UI, reason: "user", handoff: "program", by: "user" })
    if (!other.ok) throw new Error(other.message)
    expect(await plain.settled(other.opID)).toMatchObject({ state: "done" })
    expect(JSON.stringify(plain.core.created().at(-1)?.body)).not.toContain("own.harness")
  })

  test("메인 새 대화 does not wait for a harness switch notice in the main's queue (RH-15)", async () => {
    const h = await setup()
    h.core.inbox.set(MAIN_SESSION, [switched(MAIN_SESSION, h.clock.now())])
    h.clock.advance(SafePoint.WAKE_MS)
    const op = await h.settled(opID(await h.rpc("main.rotate", { teamID: TEAM_ID })))
    expect(op).toMatchObject({ state: "done" })
    expect((await h.services.registry.teams.get(TEAM_ID))?.main.previous).toEqual([MAIN_SESSION])
  })

  test("메인 새 대화 keeps the old main's 에이전트 방식", async () => {
    const h = await setup()
    named(h, MAIN_SESSION, { id: "codex", v: 1 })
    const op = await h.settled(opID(await h.rpc("main.rotate", { teamID: TEAM_ID })))
    expect(op).toMatchObject({ state: "done" })
    expect(h.core.created().at(-1)?.body).toMatchObject({ metadata: { "own.harness": { id: "codex", v: 1 } } })
  })
})

describe("메인 새 대화 (06 §6.5)", () => {
  test("waits for the main's tree, then a new main on the same Ref and preset, the swap and the old main archived", async () => {
    const h = await setup()
    h.core.add({ id: CHILD, directory: h.home, parentID: MAIN_SESSION })
    h.core.active.add(CHILD)
    const id = opID(await h.rpc("main.rotate", { teamID: TEAM_ID }))
    await Bun.sleep(50)
    // A subagent of the main still works.
    expect(h.core.created()).toHaveLength(0)
    h.core.active.delete(CHILD)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: CHILD }))
    const op = await h.settled(id)
    expect(op).toMatchObject({ kind: "rotate", by: "user", state: "done" })
    expect(op.areaID).toBeUndefined()

    const team = await h.services.registry.teams.get(TEAM_ID)
    const next = team!.main.sessionID
    expect(next).not.toBe(MAIN_SESSION)
    expect(team?.main.previous).toEqual([MAIN_SESSION])
    expect(h.core.created()[0]?.body).toEqual({
      id: next,
      title: "팀 메인",
      model: TEAM_MAIN,
      location: { directory: h.home },
      metadata: { "own.team": { role: "main", teamID: TEAM_ID } },
      permissions: Permissions.rules("main").map((rule) => ({ ...rule })),
    })
    expect(calls(h, "session.approval.set")).toEqual([{ sessionID: next, mode: "read-only" }])
    expect(calls(h, "session.preset.apply")).toEqual([
      { sessionID: next, presetID: MAIN_PRESET, team: TEAM_CONTEXT },
      { sessionID: MAIN_SESSION, presetID: MAIN_PRESET, team: null },
    ])
    expect(h.core.entries.get(next)?.get(RoleInstructions.MAIN)).toBe(
      RoleInstructions.main({ team: team!, blocks: {} }),
    )
    expect(h.core.views.get(MAIN_SESSION)?.metadata).toMatchObject({ [Undo.ARCHIVED]: true })
    expect(h.published.some((item) => item.name === "team.changed")).toBe(true)
    const notice = h.published.find((item) => item.name === "notice" && item.data.kind === "rotation.done")
    expect(notice?.data).toMatchObject({ teamID: TEAM_ID, data: { sessionID: next, previous: MAIN_SESSION } })
    expect(notice?.data).not.toHaveProperty("areaID")
    expect(await MainTools.check(h.services, MAIN_SESSION)).toEqual({ ok: false, text: MainTools.PREVIOUS_MAIN })
    expect(await MainTools.check(h.services, next)).toMatchObject({ ok: true })
    // The owners stay as they were.
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
    quiet(h)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// 07 P-D8, U6: no size- or token-based rotation and no compaction call anywhere in own-team src.

// ---------------------------------------------------------------------------------------------------------------
// RH-20: a rotation never holds the team's op slot for good, and passes over no parked input

/** A queue item admitted `ago` ms before now; `type: user` is what the user typed. */
function parkedItem(
  h: Harness,
  input: {
    readonly id: string
    readonly type?: string
    readonly ago: number
    readonly metadata?: Record<string, unknown>
  },
): Item {
  const item: Item = {
    id: input.id,
    sessionID: OWNER_SESSION,
    type: input.type ?? "user",
    delivery: "queue",
    payload: { text: "정렬 마저 해 줘", ...(input.metadata === undefined ? {} : { metadata: input.metadata }) },
    time: { created: h.clock.now() - input.ago },
  }
  h.service.routes.set(`DELETE /api/session/${OWNER_SESSION}/inbox/${input.id}`, () => {
    h.core.inbox.set(
      OWNER_SESSION,
      (h.core.inbox.get(OWNER_SESSION) ?? []).filter((kept) => kept.id !== input.id),
    )
    return new Response(null, { status: 204 })
  })
  return item
}

/** `POST …/interrupt` of `sessionID` stops its run; the calls are recorded with their `resume`. */
function interrupts(h: Harness, sessionID: string) {
  const calls: Array<string | undefined> = []
  h.service.routes.set(`POST /api/session/${sessionID}/interrupt`, (request) => {
    calls.push(request.query.resume)
    h.core.active.delete(sessionID)
    return Response.json({ interrupted: true })
  })
  return calls
}

/** Running shells of the area folder, its Location alive (a safe point reads shells only then). */
function shells(h: Harness) {
  const running: Array<{
    id: string
    status: string
    cwd: string
    command: string
    metadata: Record<string, unknown>
  }> = []
  h.service.routes.set("GET /api/shell", () => Response.json({ data: running }))
  h.service.routes.set("GET /api/pty", () => Response.json({ data: [] }))
  h.service.routes.set(`GET /api/session/${OWNER_SESSION}/form`, () => Response.json({ data: [] }))
  const detach = h.controller.attach({
    ctx: context(h.world, { directory: h.folder }).ctx,
    directory: h.folder,
    control: false,
    leader: () => false,
  })
  cleanups.push(detach)
  return {
    running,
    add: (id: string, command: string) => {
      running.push({ id, status: "running", cwd: h.folder, command, metadata: { sessionID: OWNER_SESSION } })
      h.service.routes.set(`DELETE /api/shell/${id}`, () => {
        running.splice(
          running.findIndex((shell) => shell.id === id),
          1,
        )
        return new Response(null, { status: 204 })
      })
    },
  }
}

/** The op's step `kind` once it records a wait with `detail`. */
async function waitOf(h: Harness, opID: string, kind: string, detail: string) {
  await until(async () => {
    const step = (await h.services.journal.find(opID))?.steps.find((item) => item.kind === kind)
    return step?.wait?.detail === detail
  }, 30_000)
  return (await h.services.journal.find(opID))!.steps.find((item) => item.kind === kind)!
}

describe("RH-20: parked input, bounded handoff turns, commands left running, cancel", () => {
  test("input the user parked in the old owner's queue makes it the program's handoff; it stays there and is counted", async () => {
    const h = await setup()
    const prompt = parkedItem(h, { id: "msg_user_parked", ago: 60_000 })
    h.core.inbox.set(OWNER_SESSION, [prompt])
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    // No warm turn: core would run the stopped prompt first, in the conversation being replaced.
    expect(h.core.admitted(OWNER_SESSION, "synthetic")).toHaveLength(0)
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([prompt])
    const record = await h.services.registry.areas.get(TEAM_ID, UI)
    const document = fs.readFileSync(record!.handoff!.file, "utf8")
    expect(document).toContain("프로그램이 만든 인계 문서")
    expect(document).toContain("## 지난 대화에 남은 입력")
    expect(h.published.find((item) => item.name === "notice" && item.data.kind === "rotation.done")).toMatchObject({
      data: {
        text: "인벤토리 화면: 새 대화로 이어졌어요. 지난 대화에 보내지 않은 입력 1개가 남아 있어요.",
        data: { parked: 1 },
      },
    })
    quiet(h)
  })

  test("a main request sent to the old owner but never taken goes back to the outbox and to the new owner", async () => {
    const h = await setup()
    const dispatchID = OwnTeam.DispatchID.create()
    const msgID = MsgID.dispatch(dispatchID, OWNER_SESSION)
    await h.services.write(TEAM_ID, () =>
      h.services.registry.dispatches.put({
        id: dispatchID,
        teamID: TEAM_ID,
        areaID: UI,
        seq: 0,
        from: "main",
        kind: "task",
        text: "정렬 고치기",
        state: "sent",
        createdAt: h.clock.now() - 120_000,
        sentTo: { sessionID: OWNER_SESSION, msgID, at: h.clock.now() - 120_000 },
      }),
    )
    h.core.inbox.set(OWNER_SESSION, [
      parkedItem(h, {
        id: msgID,
        ago: 120_000,
        metadata: { [OwnTeam.DISPATCH_META]: { id: dispatchID, from: "main", teamID: TEAM_ID, areaID: UI } },
      }),
    ])
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([])
    const next = (await h.owner()).sessionID!
    // The op's end sends it again, to the new owner, with the new owner's message id.
    await until(() => h.core.admitted(next, "prompt").length === 1, 30_000)
    expect(h.core.admitted(next, "prompt")[0]?.id).toBe(MsgID.dispatch(dispatchID, next))
    await until(
      async () => (await h.services.registry.dispatches.find(TEAM_ID, dispatchID))?.sentTo?.sessionID === next,
    )
  })

  test("a notice parked in the old owner's queue rides with the warm handoff turn", async () => {
    const h = await setup()
    h.core.inbox.set(OWNER_SESSION, [switched(OWNER_SESSION, h.clock.now() - 60_000)])
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1, 30_000)
    await h.turn(OWNER_SESSION, async () => {
      await HANDOFF.execute(h.services, OWNER_SESSION, { text: "# 인계: 인벤토리 화면" })
    })
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect((await h.services.journal.find(id))!.steps[1]).toMatchObject({ note: "담당이 인계 메모를 썼어요" })
  })

  test("a handoff request nothing takes (no wake: a staged revert, a lost end event) is withdrawn after 10 s", async () => {
    const h = await setup()
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1, 30_000)
    // The fake core wakes nobody: the request sits in the queue of an owner that does not run.
    await waitOf(h, id, Rotation.KIND.handoff, "queued")
    h.clock.advance(Rotation.RECHECK_MS)
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([])
    expect((await h.services.journal.find(id))!.steps[1]).toMatchObject({ note: "이 앱이 인계 메모를 썼어요" })
  })

  test("a handoff turn that runs past 15 minutes is stopped (resume: false) and the program writes the handoff", async () => {
    const h = await setup()
    const stops = interrupts(h, OWNER_SESSION)
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1, 30_000)
    // The owner takes the request and keeps running (a long build, an approval nobody gives).
    h.core.inbox.set(OWNER_SESSION, [])
    h.core.active.add(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.started", { sessionID: OWNER_SESSION }))
    const waiting = await waitOf(h, id, Rotation.KIND.handoff, "running")
    expect(waiting.wait?.text).toBe("담당 대화가 인계 메모를 쓰는 중이에요(1분째)")
    h.clock.advance(Rotation.HANDOFF_MS)
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(stops).toEqual(["false"])
    expect((await h.services.journal.find(id))!.steps[1]).toMatchObject({ note: "이 앱이 인계 메모를 썼어요" })
  })

  test("a handoff turn the user typed into waits on past 15 minutes, and 바로 진행 stops it", async () => {
    const h = await setup()
    const stops = interrupts(h, OWNER_SESSION)
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(() => h.core.admitted(OWNER_SESSION, "synthetic").length === 1, 30_000)
    h.core.inbox.set(OWNER_SESSION, [])
    h.core.active.add(OWNER_SESSION)
    h.core.messages.set(OWNER_SESSION, [
      { id: "msg_typed", type: "user", text: "잠깐, 이것도 해 줘", time: { created: h.clock.now() + 1 } },
    ])
    h.controller.hub.receive(event("session.execution.started", { sessionID: OWNER_SESSION }))
    await waitOf(h, id, Rotation.KIND.handoff, "running")
    h.clock.advance(Rotation.HANDOFF_MS)
    const typed = await waitOf(h, id, Rotation.KIND.handoff, "typed")
    expect(typed.wait?.actions).toEqual(["cancel", "force"])
    expect(stops).toEqual([])
    expect(await h.rpc("op.force", { opID: id })).toMatchObject({ op: { id } })
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(stops).toEqual(["false"])
  })

  test("an automatic fresh rotation held only by a command left running goes to the current owner after 5 minutes", async () => {
    const h = await setup()
    const running = shells(h)
    running.add("sh_dev", "bun run dev")
    const sent = await h.services.features().admit.dispatch({
      teamID: TEAM_ID,
      areaID: UI,
      text: "새 일",
      fresh: true,
      from: "main",
      kind: "task",
    })
    expect(sent).toMatchObject({ state: "waiting", why: "maintaining" })
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")!
    const begin = await waitOf(h, op.id, Rotation.KIND.begin, "shell")
    expect(begin.wait).toMatchObject({
      why: "safe-point",
      text: "인벤토리 화면: 실행 중인 명령이 끝나기를 기다려요: 'bun run dev'",
      shells: [{ id: "sh_dev", command: "bun run dev", kind: "shell" }],
    })
    h.clock.advance(Rotation.BACKGROUND_MS)
    h.clock.advance(Rotation.RECHECK_MS)
    const ended = await h.settled(op.id)
    expect(ended.steps.map((step) => step.state)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped"])
    // The request went to the current owner as a plain request; the dev server keeps running.
    await until(() => h.core.admitted(OWNER_SESSION, "prompt").length === 1, 30_000)
    expect(running.running).toHaveLength(1)
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
  })

  test("a user's rotation offers 명령 멈추고 진행: the command stops and the rotation goes on", async () => {
    const h = await setup()
    h.core.messages.set(OWNER_SESSION, [])
    const running = shells(h)
    running.add("sh_watch", "bun test --watch")
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    const begin = await waitOf(h, id, Rotation.KIND.begin, "shell")
    expect(begin.wait?.actions).toEqual(["cancel", "force", "stop-shell"])
    expect(await h.rpc("op.force", { opID: id, action: "stop-shell" })).toMatchObject({ op: { id } })
    expect(await h.settled(id)).toMatchObject({ state: "done" })
    expect(running.running).toEqual([])
    expect((await h.owner()).previous.at(-1)).toMatchObject({ sessionID: OWNER_SESSION, why: "user" })
  })

  test("RH-32: a rotation that waits for a working owner offers only 취소; 바로 진행 is refused and nothing moves", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    const begin = await waitOf(h, id, Rotation.KIND.begin, "session")
    expect(begin.wait?.actions).toEqual(["cancel"])
    expect(await h.rpc("op.force", { opID: id })).toMatchObject({ type: "unsupported" })
    expect(await h.rpc("op.force", { opID: id, action: "stop-shell" })).toMatchObject({ type: "unsupported" })
    // Queued input that starts a run (young) holds it the same way.
    h.core.inbox.set(OWNER_SESSION, [parkedItem(h, { id: "msg_young_user", ago: 0 })])
    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    expect((await waitOf(h, id, Rotation.KIND.begin, "inbox")).wait?.actions).toEqual(["cancel"])
    expect(await h.rpc("op.force", { opID: id })).toMatchObject({ type: "unsupported" })
    expect((await h.services.journal.find(id))?.state).toBe("running")
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
    expect(h.core.created()).toHaveLength(0)
    expect(await h.rpc("op.cancel", { opID: id })).toMatchObject({ op: { state: "cancelled" } })
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
  })

  test("RH-41: before its first look answers, a rotation's safe-point wait offers only 취소", async () => {
    const h = await setup()
    // The safe point reads the owner's queue first: that read hangs until released.
    const route = `GET /api/session/${OWNER_SESSION}/inbox`
    const read = h.service.routes.get(route)!
    const gate = Promise.withResolvers<void>()
    h.service.routes.set(route, async (request) => {
      await gate.promise
      return read(request)
    })
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await until(async () => {
      const step = (await h.services.journal.find(id))?.steps.find((item) => item.kind === Rotation.KIND.begin)
      return step?.wait !== undefined
    }, 30_000)
    const begin = (await h.services.journal.find(id))!.steps.find((item) => item.kind === Rotation.KIND.begin)!
    expect(begin.wait).toMatchObject({ why: "safe-point", actions: ["cancel"] })
    expect(await h.rpc("op.force", { opID: id })).toMatchObject({ type: "unsupported" })
    expect(await h.rpc("op.cancel", { opID: id })).toMatchObject({ op: { state: "cancelled" } })
    gate.resolve()
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
  })

  test("a cancelled fresh rotation sends its request to the current owner as a plain request", async () => {
    const h = await setup()
    // Input just admitted to the owner: the rotation waits for it.
    h.core.inbox.set(OWNER_SESSION, [parkedItem(h, { id: "msg_young", type: "synthetic", ago: 0 })])
    const sent = await h.services.features().admit.dispatch({
      teamID: TEAM_ID,
      areaID: UI,
      text: "새 일",
      fresh: true,
      from: "main",
      kind: "task",
    })
    expect(sent).toMatchObject({ state: "waiting", why: "maintaining" })
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")!
    await waitOf(h, op.id, Rotation.KIND.begin, "inbox")
    expect(await h.rpc("op.cancel", { opID: op.id })).toMatchObject({ op: { state: "cancelled" } })
    await until(() => h.core.admitted(OWNER_SESSION, "prompt").length === 1, 30_000)
    expect((await h.owner()).sessionID).toBe(OWNER_SESSION)
    const dispatch = (await h.services.registry.dispatches.list(TEAM_ID, UI))[0]
    expect(dispatch?.fresh).toBeUndefined()
  })

  test("a notice still young at the first look passes on the 30 s look (the safe point is not stuck on it)", async () => {
    const h = await setup()
    h.core.messages.set(OWNER_SESSION, [])
    h.core.inbox.set(OWNER_SESSION, [switched(OWNER_SESSION, h.clock.now())])
    const id = opID(await h.rpc("area.rotate", { teamID: TEAM_ID, areaID: UI }))
    await waitOf(h, id, Rotation.KIND.begin, "inbox")
    h.clock.advance(Rotation.RECHECK_MS)
    expect(await h.settled(id)).toMatchObject({ state: "done" })
  })

  test("RH-35: 메인 새 대화 leaves input the user parked in the old main's queue there and counts it", async () => {
    const h = await setup()
    h.core.inbox.set(MAIN_SESSION, [
      { ...parkedItem(h, { id: "msg_main_parked", ago: 60_000 }), sessionID: MAIN_SESSION },
    ])
    expect(await h.settled(opID(await h.rpc("main.rotate", { teamID: TEAM_ID })))).toMatchObject({ state: "done" })
    const done = h.published.flatMap((item) =>
      item.name === "notice" && item.data.kind === "rotation.done" ? [item.data] : [],
    )
    expect(done).toEqual([
      expect.objectContaining({
        text: "팀 메인이 새 대화로 이어졌어요. 지난 대화에 보내지 않은 입력 1개가 남아 있어요.",
        data: expect.objectContaining({ previous: MAIN_SESSION, parked: 1 }),
      }),
    ])
    expect(h.core.inbox.get(MAIN_SESSION)?.map((item) => item.id)).toEqual(["msg_main_parked"])
  })

  test("메인 새 대화 gives up after 30 minutes of a working main; nothing changed, area requests never waited for it", async () => {
    const h = await setup()
    h.core.active.add(MAIN_SESSION)
    const id = opID(await h.rpc("main.rotate", { teamID: TEAM_ID }))
    const idle = await waitOf(h, id, Rotation.KIND.mainIdle, "session")
    expect(idle.wait?.text).toBe("팀 메인이 일하는 중이라 기다려요")
    const op = (await h.services.journal.find(id))!
    expect(Outbox.maintaining(op, UI, h.services.steps)).toBe(false)
    h.clock.advance(Rotation.MAIN_IDLE_MS)
    expect(await h.settled(id)).toMatchObject({ state: "failed" })
    expect((await h.services.journal.find(id))!.steps[0]).toMatchObject({
      state: "failed",
      note: "팀 메인이 계속 일하는 중이라 새 대화로 바꾸지 못했어요",
    })
    expect(h.core.created()).toHaveLength(0)
    expect((await h.services.registry.teams.get(TEAM_ID))?.main.sessionID).toBe(MAIN_SESSION)
  })
})

const SRC = path.join(import.meta.dir, "..", "..", "src")

function sources() {
  return fs
    .readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name)
      return { file: path.relative(SRC, file).split(path.sep).join("/"), code: code(fs.readFileSync(file, "utf8")) }
    })
}

/** The source without comments (block comments, and `//` comments that follow a space or start a line). */
function code(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1")
}

describe("no rotation or compaction by size (07 P-D8, U6)", () => {
  const files = sources()

  test("own-team never calls or configures compaction", () => {
    expect(files.length).toBeGreaterThan(50)
    const offending = files.filter((item) =>
      [/\bcompact\s*\(/i, /["'`/]compact["'`/?]/, /session\.compact\b/, /compaction\.set/, /triggerTokens/].some(
        (pattern) => pattern.test(item.code),
      ),
    )
    expect(offending.map((item) => item.file)).toEqual([])
  })

  test("rotations start only from semantic boundaries, never from a size or a token count", () => {
    const callers = files.filter((item) => /\.rotate\.(request|main)\(|Rotation\.(steps|mainSteps)\(/.test(item.code))
    expect(callers.map((item) => item.file)).toContain("dispatch/dispatch.ts")
    expect(callers.map((item) => item.file)).toContain("rpc/rotate.ts")
    for (const item of [...callers, ...files.filter((entry) => entry.file === "sessions/rotate.ts")]) {
      expect({
        file: item.file,
        sized: /\b\w*[tT]okens\b|usage\.|limit\.(context|input)|contextWindow/.test(item.code),
      }).toEqual({ file: item.file, sized: false })
      for (const reason of item.code.matchAll(/\breason:\s*"([^"]+)"/g))
        expect(Schema.is(OwnTeam.RotationReason)(reason[1])).toBe(true)
    }
    // Reports and integration never rotate (done/ready/integrate keep the conversation, 6.1, 5.5).
    for (const file of [
      "report/events.ts",
      "report/fold.ts",
      "report/digest.ts",
      "report/wake.ts",
      "tools/report.ts",
      "tools/integrate.ts",
    ])
      expect({ file, rotates: /\brotat/i.test(files.find((item) => item.file === file)?.code ?? "") }).toEqual({
        file,
        rotates: false,
      })
    // No team setting holds a window, compaction or rotation value.
    expect(Object.keys(OwnTeam.Policy.fields).filter((key) => /rotat|compact|token|window/i.test(key))).toEqual([])
  })
})
