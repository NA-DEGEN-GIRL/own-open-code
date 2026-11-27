// 담당 대화 바꾸기 and 담당 메모 in the plugin (2026-11-12): `area.seat` is registered through the portable definition
// and answers from the seat feature (which `team_control` calls the same way) with the user as its starter, returns the
// feature's failures as declared errors (`seat_invalid`, `same_company_subscription`, `busy`, `broken`, a team that is
// off) and an undeclared one as `internal_error`, and `health` lists `seat` and `owner-note`. `area.edit{note}` writes
// the owner note on the seat (trimmed, at most 1 KB, an empty one removes it) without touching the role. The move
// itself, step by step, is in `test/sessions/seat.test.ts`. Fake contexts over one world, the real @own/runtime on a
// temp OWN_HOME, a manual clock; fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { Account, OwnTeam } from "@own/protocol"
import { Log } from "../../src/log.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import {
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  boot,
  buildId,
  call,
  controller,
  managedEnv,
  team,
  tempHome,
  type Registered,
} from "../support/context.js"

const restore = managedEnv()
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  restore()
})

const UNKNOWN_TEAM = "tm_000000000000"
const UI = OwnTeam.AreaID.make("ar_ui")
const TARGET = SessionID.make("ses_target00000000000000000001")

function invoke(handlers: TeamRpc.Handlers, method: string, input: unknown) {
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const loose = handlers as unknown as Registered["handlers"]
  return call({ definition: { methods: {} }, handlers: loose, emitted: [], disposed: false }, method, input)
}

describe("area.seat in the plugin", () => {
  test("registered through the portable definition, answering from the seat feature; health lists `seat` and `owner-note`", async () => {
    await using home = await tempHome()
    const booted = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: buildId("seat-rpc"), lingerSeconds: 0, logLevel: "error" },
    })
    cleanups.push(booted.cleanup)
    const registered = booted.registrations[0]!
    expect(Object.keys(registered.definition.methods)).toContain("area.seat")
    expect(await call(registered, "area.seat", { teamID: UNKNOWN_TEAM, areaID: UI, sessionID: TARGET })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
    expect(await call(registered, "area.edit", { teamID: UNKNOWN_TEAM, areaID: UI, note: "메모" })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
    const health = (await call(registered, "health", {})) as OwnTeam.Health
    expect(health.features).toContain("seat")
    expect(health.features).toContain("owner-note")
    expect(new Set(health.features).size).toBe(health.features.length)
    await booted.cleanup()
  })

  test("the feature's failures are declared errors; an undeclared one is internal_error; success answers the op", async () => {
    const home = await tempHome()
    cleanups.push(() => home[Symbol.asyncDispose]())
    const seen: unknown[] = []
    const opID = OwnTeam.OpID.create()
    const answers: Services.Result<{ readonly opID: OwnTeam.OpID }>[] = [
      Services.failure("seat_invalid", "이 영역의 폴더에 있는 대화만 담당이 될 수 있어요", { why: "elsewhere" }),
      Services.failure("same_company_subscription", "rival", { accountID: Account.ID.make("acc_x") }),
      Services.failure("busy", "다른 작업이 진행 중이에요", { teamID: TEAM_ID, opID, kind: "rotate" }),
      Services.failure("broken", "영역 폴더의 정보가 맞지 않아요", { areaID: UI, why: "identity" }),
      Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: TEAM_ID }),
      Services.failure("not_found", "대화를 찾을 수 없어요", { what: "session", id: TARGET }),
      Services.failure("peer_invalid", "not for this method", { why: "label" }),
      { ok: true, opID },
    ]
    const h = controller(new World(), {
      directory: home.root,
      clock: manual(),
      features: {
        seat: () => ({
          request: async (input) => {
            seen.push(input)
            return answers[seen.length - 1]!
          },
          sweep: async () => {},
        }),
      },
    })
    cleanups.push(h.close)
    const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: Log.silent })
    const input = { teamID: TEAM_ID, areaID: UI, sessionID: TARGET }
    const got: unknown[] = []
    for (const _answer of answers) got.push(await invoke(handlers, "area.seat", input))
    expect(got).toMatchObject([
      { type: "seat_invalid", message: "이 영역의 폴더에 있는 대화만 담당이 될 수 있어요", data: { why: "elsewhere" } },
      { type: "same_company_subscription", data: { accountID: "acc_x" } },
      { type: "busy", data: { opID, kind: "rotate" } },
      { type: "broken", data: { areaID: UI } },
      { type: "team_off", data: { teamID: TEAM_ID } },
      { type: "not_found", data: { what: "session", id: TARGET } },
      { type: "internal_error", message: "not for this method" },
      { opID },
    ])
    // The method is the user's action, whoever the feature's other callers are.
    expect(seen).toEqual(answers.map(() => ({ ...input, by: "user" })))
  })
})

describe("area.edit{note} (담당 메모)", () => {
  async function setup() {
    const home = await tempHome()
    cleanups.push(() => home[Symbol.asyncDispose]())
    const refreshed: unknown[] = []
    const h = controller(new World(), {
      directory: home.root,
      clock: manual(),
      features: {
        owner: () => ({
          create: async () => Services.failure("internal_error", "not here", {}),
          attach: async () => ({ ok: true }),
          detach: async () => ({ ok: true }),
          refresh: async (input) => {
            refreshed.push(input)
            return { ok: true }
          },
        }),
      },
    })
    cleanups.push(h.close)
    const record = area({ slug: "ui", directory: path.join(home.root, "ui") })
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team({ home: home.root }))
      await h.services.registry.areas.put(record)
    })
    const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: Log.silent })
    const edit = (input: Readonly<Record<string, unknown>>) =>
      invoke(handlers, "area.edit", { teamID: TEAM_ID, areaID: UI, ...input })
    const stored = async () => (await h.services.registry.areas.get(TEAM_ID, UI))!
    return { ...h, record, refreshed, edit, stored }
  }

  test("it is written on the owner seat, trimmed; the role and the owner conversation are left alone; an empty one removes it", async () => {
    const h = await setup()
    expect(await h.edit({ note: "  화면 정렬을 맡은 대화\n  " })).toMatchObject({
      area: { id: UI, owner: { sessionID: OWNER_SESSION, note: "화면 정렬을 맡은 대화" } },
    })
    expect(await h.stored()).toEqual({ ...h.record, owner: { ...h.record.owner, note: "화면 정렬을 맡은 대화" } })
    // An edit of something else keeps it.
    await h.edit({ userMade: true })
    expect((await h.stored()).owner.note).toBe("화면 정렬을 맡은 대화")
    // The note is the user's label, not an instruction: the owner's role entry is not written again.
    expect(h.refreshed).toEqual([])
    expect(await h.edit({ note: "   " })).toMatchObject({ area: { id: UI } })
    expect((await h.stored()).owner).toEqual(h.record.owner)
    expect("note" in (await h.stored()).owner).toBe(false)
  })

  test("at most 1,024 characters: one more is refused with `seat_invalid` and nothing is written", async () => {
    const h = await setup()
    // Characters, as the wire counts them (before 2026-11-14 UTF-8 bytes: 342 Hangul were too many).
    const fits = "가".repeat(OwnTeam.OWNER_NOTE_MAX)
    expect(fits.length).toBe(1_024)
    expect(await h.edit({ note: fits })).toMatchObject({ area: { owner: { note: fits } } })
    expect(await h.edit({ note: `${fits}a` })).toEqual({
      type: "seat_invalid",
      message: "담당 메모는 1,024자 이하로 적어요",
      data: { why: "note" },
    })
    // Surrounding blanks do not count.
    expect(await h.edit({ note: `  ${fits}  ` })).toMatchObject({ area: { owner: { note: fits } } })
    expect((await h.stored()).owner.note).toBe(fits)
  })

  test("an area that is retired or broken takes no note", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, () =>
      h.services.registry.areas.put({ ...h.record, state: "broken", broken: { why: "identity", at: 1 } }),
    )
    expect(await h.edit({ note: "메모" })).toMatchObject({ type: "broken", data: { areaID: UI, why: "identity" } })
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...h.record, state: "retired" }))
    expect(await h.edit({ note: "메모" })).toMatchObject({ type: "not_found", data: { what: "area" } })
    expect("note" in (await h.stored()).owner).toBe(false)
  })
})
