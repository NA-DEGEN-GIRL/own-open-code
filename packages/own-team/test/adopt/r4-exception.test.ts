// The R4 exception of an adopted owner (06 §3.7, §6.1, §6.2, §10.1; 07 §5.1, §6.3 #9; TG9, TG15 and TG16 adopted items
// at plugin level). A team on ChatGPT 01 adopted a folder whose conversation runs on ChatGPT 02, another subscription
// of the same company: at its first main request the conversation is not attached; a `rotate` op (reason `r4`,
// program handoff) opens a new owner conversation on the team main's Ref with the area preset and the team context,
// and the request goes there. ChatGPT 02 never runs for the team: no handoff turn, no prompt, no permission or
// instruction write in that conversation, which stays the user's (archived from the team, `지난 대화`). The release
// of fetched folders follows the swap (4.7). A conversation of the team's own ChatGPT login on `siwc` (one
// subscription) and a Claude subscription conversation (another company) are attached instead. The service is a fake
// on 127.0.0.1 standing in for the e2e kit's two ChatGPT slots (F4's fake accounts, logins and presets); a manual clock.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam, Preset } from "@own/protocol"
import { Release } from "../../src/assets/release.js"
import type { Hub } from "../../src/hub.js"
import { Undo } from "../../src/ops/undo.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Rotation } from "../../src/sessions/rotate.js"
import { Services } from "../../src/services.js"
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
// and instruction entries. Routes are added per session id (the fake service matches exact paths).

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

function fakeCore(service: FakeService, models: Map<string, Model.Ref>) {
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
      data: [...views.values()].filter((view) => view.location.directory === request.query.directory),
      cursor: {},
    }),
  )
  const add = (input: Parameters<typeof session>[0] & { readonly model?: Model.Ref }) => {
    const id = input.id
    const base = `/api/session/${id}`
    const entriesPath = `/api/experimental/session/${id}/instructions/entries`
    views.set(id, session(input))
    if (input.model) models.set(id, input.model)
    entries.set(id, new Map())
    const admit = (type: "user" | "synthetic") => (request: { readonly body: unknown }) => {
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
    service.routes.set(`POST ${base}/prompt`, admit("user"))
    service.routes.set(`POST ${base}/synthetic`, admit("synthetic"))
    service.routes.set(`GET /api/experimental/session/${id}/log`, () => new Response(""))
    service.routes.set(`GET ${entriesPath}`, () =>
      Response.json({ data: [...(entries.get(id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    for (const key of [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF])
      service.routes.set(`PUT ${entriesPath}/${key}`, (request) => {
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
  /** What was admitted to a session with `kind`, in order. */
  const admitted = (id: string, kind: "prompt" | "synthetic") =>
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

// 20 s: an op that settles in a second idle took over 5 s on a loaded PC (2026-10-29, the parallel unit run).
async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture: a team whose main runs on ChatGPT 01, and one adopted folder (`cl-perf`) whose most recent conversation was
// registered as its owner without the team. `model` is that conversation's Ref.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ADOPTED = SessionID.make("ses_adopted00000000000000000002")
const PERF = OwnTeam.AreaID.make("ar_cl-perf")
const TEAM_CONTEXT: Preset.Team = {
  teamID: TEAM_ID,
  role: "owner",
  accounts: [Account.ID.make("acc_chatgpt01")],
  pinned: [],
}
const ANSWER = "성능 측정 스크립트를 고쳤습니다. 다음은 캐시 적중률을 보는 일입니다."
const COMPUTER: Rule = { action: "computer", resource: "*", effect: "allow" }

async function setup(
  input: {
    /** The adopted conversation's Ref; `null`: it has none (core's default would answer). */
    readonly model?: Model.Ref | null
    readonly area?: (base: OwnTeam.Area) => OwnTeam.Area
  } = {},
) {
  const box = temp("own-team-r4-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folder = path.join(home, ".worktrees", "cl-perf")
  for (const dir of [home, folder]) fs.mkdirSync(dir, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const models = new Map<string, Model.Ref>()
  const core = fakeCore(service, models)
  const model = input.model === null ? undefined : (input.model ?? F4_REFS.other)
  core.add({ id: MAIN_SESSION, directory: home, model: F4_REFS.team })
  core.add({ id: ADOPTED, directory: folder, ...(model ? { model } : {}), metadata: { "user.note": "kept" } })
  core.messages.set(ADOPTED, [{ id: "msg_answer", type: "assistant", content: [{ type: "text", text: ANSWER }] }])
  const world = new World()
  const accounts = f4Accounts(world.accounts, models)
  accounts.modes.set(ADOPTED, "full")
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
    },
  }
  world.sessions.set(ADOPTED, adopted)
  const clock = manual(F4_NOW)
  const features: Partial<Services.Factories> = {
    teamContext: () => ({ get: async () => TEAM_CONTEXT, push: async () => {} }),
  }
  const h = controller(world, { directory: home, clock, source: service.source, features })
  const live = { h }
  cleanups.push(() => live.h.close())
  // R4 decided at adoption (ops/adopt.ts): ChatGPT 02, no model or a provider own.accounts does not know → 팀과 같게
  // with the team main group's ★; else the conversation's.
  const own =
    model && model.providerID !== F4_REFS.other.providerID && model.providerID !== "openai" ? model : undefined
  const group = (providerID: string) =>
    providerID === "anthropic" ? "claude-sub" : providerID === "ollama" ? "local:ollama" : "siwc"
  const base: OwnTeam.Area = {
    ...area({ slug: "cl-perf", directory: folder }),
    name: "cl-perf",
    subtitle: "성능 조정",
    origin: "adopted",
    owner: { sessionID: ADOPTED, previous: [], attached: false },
    ...(own ? { main: { model: own, chosenBy: "adopted" as const } } : {}),
    preset: own ? Preset.builtinID(group(own.providerID)) : F4_PRESETS.star.id,
  }
  const record = input.area ? input.area(base) : base
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(record)
  })
  const dispatch = (text: string) =>
    live.h.services.features().admit.dispatch({ teamID: TEAM_ID, areaID: PERF, text, from: "main", kind: "task" })
  const stored = async () => (await live.h.services.registry.areas.get(TEAM_ID, PERF))!
  /** A new controller over the same world and service (a restart). */
  const restart = async () => {
    await live.h.close()
    live.h = controller(world, { directory: home, clock, source: service.source, features })
  }
  return {
    ...h,
    live,
    clock,
    home,
    folder,
    service,
    core,
    world,
    accounts,
    permissions,
    record,
    dispatch,
    stored,
    restart,
  }
}

type Harness = Awaited<ReturnType<typeof setup>>

function calls(h: Harness, method: string) {
  return h.world.calls.filter((call) => call.method === method).map((call) => call.input)
}

/** The op once it stopped running. */
async function settled(h: Harness, opID: string) {
  await until(async () => (await h.live.h.services.journal.find(opID))?.state !== "running")
  return (await h.live.h.services.journal.find(opID))!
}

/**
 * Nothing ran on the adopted conversation's account for the team: no admission (prompt, handoff turn), no generate or
 * compaction, no permission or instruction write, no switch, no preset binding with the team.
 */
function untouched(h: Harness) {
  const own = `/api/session/${ADOPTED}/`
  const entries = `/api/experimental/session/${ADOPTED}/instructions/entries/`
  expect(
    h.service.requests
      .filter(
        (request) =>
          (request.method === "POST" && request.path.startsWith(own)) ||
          (request.method === "PUT" && request.path.startsWith(entries)),
      )
      .map((request) => `${request.method} ${request.path}`),
  ).toEqual([])
  expect(h.service.requests.some((request) => /\/(generate|compact)$/.test(request.path))).toBe(false)
  expect(h.permissions.writes).toBe(0)
  expect(h.permissions.rules).toEqual([COMPUTER])
  const touching = h.world.calls.filter(
    (call) =>
      /^(switch\.apply|session\.preset\.apply|session\.approval\.set|session\.ultra\.set)$/.test(call.method) &&
      JSON.stringify(call.input).includes(ADOPTED),
  )
  expect(touching).toEqual([])
  expect(h.accounts.bindings.get(ADOPTED)?.team).toBeUndefined()
}

// ---------------------------------------------------------------------------------------------------------------

describe("the adopted R4 exception (06 §3.7, §6.2, §10.1)", () => {
  test("first main request: a new owner on the team account from a program handoff, nothing on ChatGPT 02", async () => {
    const h = await setup()
    const sent = await h.dispatch("캐시 적중률을 보세요")
    expect(sent).toMatchObject({ ok: true, state: "waiting", why: "maintaining" })
    if (!sent.ok) return

    // One `rotate` op for the area: reason r4, program handoff, started by the main's request.
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")
    expect(op).toMatchObject({ by: "main", areaID: PERF })
    expect(op?.steps.map((step) => [step.kind, step.args])).toEqual([
      [Rotation.KIND.begin, { areaID: PERF, from: ADOPTED, reason: "r4", by: "main" }],
      [Rotation.KIND.handoff, { areaID: PERF, from: ADOPTED, handoff: "program" }],
      [Rotation.KIND.owner, { areaID: PERF, from: ADOPTED }],
      [Rotation.KIND.swap, { areaID: PERF, from: ADOPTED, reason: "r4" }],
      [Rotation.KIND.archive, { sessionID: ADOPTED, directory: h.folder, areaID: PERF }],
    ])
    const done = await settled(h, op!.id)
    expect(done.state).toBe("done")
    expect(done.steps.every((step) => step.state === "done")).toBe(true)
    expect(done.summary?.lines).toEqual([{ kind: "area", areaID: PERF, change: "rotated" }])

    // The registry: the new owner (the write-ahead id), the adopted one in `previous` (지난 대화), 팀과 같게 kept.
    const after = await h.stored()
    const next = after.owner.sessionID!
    expect(next).not.toBe(ADOPTED)
    expect(after.owner).toEqual({
      sessionID: next,
      previous: [{ sessionID: ADOPTED, endedAt: h.clock.now(), why: "r4" }],
      attached: true,
    })
    expect(after.main).toBeUndefined()
    expect(after.preset).toBe(F4_PRESETS.star.id)

    // The new owner: the team main's Ref (ChatGPT 01), the owner allows, the old mode, the area preset with the team.
    expect(h.core.created().map((request) => request.body)).toEqual([
      {
        id: next,
        title: "cl-perf · 담당",
        model: F4_REFS.team,
        location: { directory: h.folder },
        metadata: { "own.team": { role: "owner", teamID: TEAM_ID, areaID: PERF } },
        permissions: Permissions.rules("owner").map((rule) => ({ ...rule })),
      },
    ])
    expect(calls(h, "session.approval.set")).toEqual([{ sessionID: next, mode: "full" }])
    expect(calls(h, "session.preset.apply")).toEqual([
      { sessionID: next, presetID: F4_PRESETS.star.id, team: TEAM_CONTEXT },
    ])
    expect(calls(h, "session.ultra.set")).toEqual([])

    // The program handoff: no LLM call, the adopted conversation's last answer read only, and the new owner starts
    // from it and its role.
    const document = fs.readFileSync(after.handoff!.file, "utf8")
    expect(document.split("\n")[0]).toMatch(/^# 인계: cl-perf \(\d{4}-\d{2}-\d{2}, 담당 대화 #1\)$/)
    expect(document).toContain("사용자가 팀 밖에서 쓰던 대화를 받아들여 새 담당 대화로 이어 갑니다")
    expect(document).toContain("(받아들인 대화라 아직 보낸 메인 요청이 없습니다)")
    expect(document).toContain("- 기다리는 메인 요청 1개는 새 담당 대화에 갑니다.")
    expect(document).toContain(`## 받아들인 대화의 마지막 답 (앞 2 KB)\n> ${ANSWER}`)
    expect(h.core.entries.get(next)?.get(RoleInstructions.HANDOFF)).toBe(document)
    expect(String(h.core.entries.get(next)?.get(RoleInstructions.OWNER))).toContain("cl-perf")

    // The adopted conversation stays the user's: archived from the team (the banner reads it), other metadata kept.
    expect(h.core.views.get(ADOPTED)?.metadata).toEqual({ "user.note": "kept", [Undo.ARCHIVED]: true })
    const notice = h.published.find((item) => item.name === "notice" && item.data.kind === "rotation.done")
    expect(notice?.data).toMatchObject({
      teamID: TEAM_ID,
      areaID: PERF,
      data: { sessionID: next, previous: ADOPTED, reason: "r4" },
    })

    // The request lands in the new owner conversation. Its record turns `sent` right after the admission answers: read
    // at once, a loaded PC still showed `waiting` (2026-10-29, the parallel unit run).
    await until(
      async () =>
        h.core.admitted(next, "prompt").length === 1 &&
        (await h.services.registry.dispatches.find(TEAM_ID, sent.dispatchID))?.state === "sent",
    )
    expect(h.core.admitted(next, "prompt")[0]?.metadata).toMatchObject({
      [OwnTeam.DISPATCH_META]: { id: sent.dispatchID, from: "main", areaID: PERF },
      source: OwnTeam.PROMPT_SOURCE,
    })
    expect(await h.services.registry.dispatches.find(TEAM_ID, sent.dispatchID)).toMatchObject({
      state: "sent",
      sentTo: { sessionID: next },
    })
    expect((await h.services.journal.list(TEAM_ID)).filter((item) => item.kind === "rotate")).toHaveLength(1)
    // ChatGPT 02: not one call for the team, before, during or after.
    untouched(h)
  })

  test("the swap releases the folders the old owner fetched: an automatic release op after the rotation (4.7)", async () => {
    const h = await setup({
      area: (base) => ({
        ...base,
        shape: "code",
        cone: { extra: { "Assets/Art": { reason: "need_paths", at: F4_NOW, bytes: 4_096 } }, kept: {} },
      }),
    })
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "maintaining" })
    const rotation = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")!
    expect(await settled(h, rotation.id)).toMatchObject({ state: "done" })
    // Once the rotation ends, the waiting request goes to the new owner. This fake core never runs it, so the item
    // would sit in that inbox and the folder would never reach its extended safe point (the release raced the outbox
    // and lost whenever the outbox sent first: it failed alone every time, 2026-10-16). The new owner's run ends here
    // as core's would; that run end is what retries the release.
    const next = (await h.stored()).owner.sessionID!
    await until(() => (h.core.inbox.get(next) ?? []).length > 0)
    h.core.inbox.set(next, [])
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: next }))
    // The release is an op of its own (by:auto), started once the area's extended safe point was checked (git queries):
    // seconds on a busy PC, so more than the helper's 5 s (it failed at 5.6 s once, 2026-10-15).
    await until(async () => (await h.services.journal.list(TEAM_ID)).some((item) => item.kind === "paths"), 30_000)
    const release = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "paths")!
    expect(release).toMatchObject({ by: "auto", areaID: PERF })
    expect(release.steps.map((step) => [step.kind, step.args])).toEqual([
      [Release.AUTO_STEP, { areaID: PERF, trigger: "rotate" }],
    ])
    expect(release.createdAt).toBeGreaterThanOrEqual(rotation.createdAt)
    untouched(h)
  })

  test("a siwc conversation of the team's own ChatGPT login is one subscription: attached, not rotated", async () => {
    const h = await setup({ model: F4_REFS.siwc })
    expect(await h.dispatch("a")).toMatchObject({ state: "queued" })
    expect(h.core.admitted(ADOPTED, "prompt")).toHaveLength(1)
    expect((await h.stored()).owner).toEqual({ sessionID: ADOPTED, previous: [], attached: true })
    expect((await h.stored()).main).toEqual({ model: F4_REFS.siwc, chosenBy: "adopted" })
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect(h.core.created()).toEqual([])
    expect((await h.stored()).handoff).toBeNull()
    expect(h.permissions.rules).toEqual([...Permissions.rules("owner"), COMPUTER])
    expect(h.core.admitted(ADOPTED, "synthetic")).toEqual([])
  })

  test("a Claude subscription conversation is another company's: attached as it is", async () => {
    const h = await setup({ model: F4_REFS.claude })
    expect(await h.dispatch("a")).toMatchObject({ state: "queued" })
    expect(h.core.admitted(ADOPTED, "prompt")).toHaveLength(1)
    expect((await h.stored()).owner.attached).toBe(true)
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect(h.core.created()).toEqual([])
  })

  test("no model, or a provider own.accounts does not know: never attached, a new owner as for R4 (U5)", async () => {
    // `openai` without an own account: upstream's own sign-in may be another ChatGPT subscription.
    const unknown = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-6-astra", providerID: "openai" })
    for (const model of [null, unknown]) {
      const h = await setup({ model })
      expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "maintaining" })
      const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")!
      expect(op.steps[0]?.args).toEqual({ areaID: PERF, from: ADOPTED, reason: "r4", by: "main" })
      expect(await settled(h, op.id)).toMatchObject({ state: "done" })
      const next = (await h.stored()).owner.sessionID!
      expect(next).not.toBe(ADOPTED)
      await until(() => h.core.admitted(next, "prompt").length === 1)
      expect(h.core.admitted(ADOPTED, "prompt")).toEqual([])
      untouched(h)
    }
  })

  test("a discovered local provider is no subscription: the conversation is kept, not rotated", async () => {
    const local = Schema.decodeUnknownSync(Model.Ref)({ id: "qwen3-coder", providerID: "ollama" })
    const h = await setup({ model: local })
    await h.dispatch("a")
    // The attach is tried with the conversation itself (this fake own.accounts binds no local group, so it stops
    // there); nothing replaces the owner.
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect(h.core.created()).toEqual([])
    expect((await h.stored()).owner.sessionID).toBe(ADOPTED)
  })

  test("Main 멈춤: the request waits with nothing rotated or attached; once it is off the rotation runs", async () => {
    const h = await setup({ area: (base) => ({ ...base, paused: "user" }) })
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "paused" })
    await Bun.sleep(30)
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect(h.core.created()).toEqual([])
    untouched(h)

    await h.services.write(TEAM_ID, async () => h.services.registry.areas.put({ ...(await h.stored()), paused: false }))
    await h.services.features().admit.drain({ teamID: TEAM_ID, areaID: PERF })
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")!
    expect(await settled(h, op.id)).toMatchObject({ state: "done" })
    const next = (await h.stored()).owner.sessionID!
    await until(() => h.core.admitted(next, "prompt").length === 1)
    untouched(h)
  })

  test("R4 that cannot be judged fails closed: nothing attached, rotated or sent until own.accounts answers", async () => {
    const h = await setup()
    const listed = h.world.accounts.get("accounts.list")!
    h.world.accounts.delete("accounts.list")
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "maintaining" })
    expect(h.services.errors(TEAM_ID).map((entry) => entry.message)).toContain(
      "r4: the adopted conversation's account could not be judged",
    )
    expect(await h.services.journal.list(TEAM_ID)).toEqual([])
    expect((await h.stored()).owner.attached).toBe(false)
    untouched(h)

    h.world.accounts.set("accounts.list", listed)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: ADOPTED }))
    await until(async () => (await h.services.journal.list(TEAM_ID)).some((item) => item.kind === "rotate"))
    const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "rotate")!
    expect(await settled(h, op.id)).toMatchObject({ state: "done" })
    untouched(h)
  })

  test("any rotation of a conversation that never got the team is a program handoff, a warm one too", async () => {
    // An area or team account change rotates with `warm`; the adopted conversation still gets no turn (U5, 6.2 (가)).
    const h = await setup()
    const started = await h.services
      .features()
      .rotate.request({ teamID: TEAM_ID, areaID: PERF, reason: "account", handoff: "warm", by: "user" })
    if (!started.ok) throw new Error(started.message)
    const op = await settled(h, started.opID)
    expect(op.state).toBe("done")
    expect(op.steps.find((step) => step.kind === Rotation.KIND.handoff)?.note).toBe("이 앱이 인계 메모를 썼어요")
    const after = await h.stored()
    expect(after.owner.previous).toEqual([{ sessionID: ADOPTED, endedAt: h.clock.now(), why: "account" }])
    expect(fs.readFileSync(after.handoff!.file, "utf8")).toContain("사용자가 팀 밖에서 쓰던 대화를 받아들여")
    untouched(h)
  })

  // The team account resume (`sessions/team-account.ts` reconcile) skips the unattached R4 owner (06 §3.7).
  test("before its first main request nothing runs for it, after a restart too", async () => {
    const h = await setup()
    await h.restart()
    await Bun.sleep(200)
    expect(await h.live.h.services.journal.list(TEAM_ID)).toEqual([])
    expect(h.core.created()).toEqual([])
    untouched(h)
  })

  test("no new rotation reason: r4 with a program handoff; the user's reasons are unchanged", () => {
    expect(OwnTeam.RotationReason.literals).toEqual(["fresh", "user", "account", "team-account", "r4", "worktree"])
    const planned = Rotation.steps({
      areaID: PERF,
      from: ADOPTED,
      directory: "x",
      reason: "r4",
      handoff: "program",
      by: "main",
    })
    expect(planned.prepare.map((step) => step.args)).toEqual([
      { areaID: PERF, from: ADOPTED, reason: "r4", by: "main" },
      { areaID: PERF, from: ADOPTED, handoff: "program" },
    ])
  })
})
