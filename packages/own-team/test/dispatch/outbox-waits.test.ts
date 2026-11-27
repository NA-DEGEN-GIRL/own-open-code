// RH-20 (06 §5.1, §5.3): an outbox wait that no event ends is looked at again on a timer, the main hears of a failure
// once, a `fresh` request whose new conversation failed twice goes as a plain request, `outbox.list` says why, since
// when and what holds it, a request nothing took is steered once, own maintenance counts only what still acts on the
// area, and Main 멈춤 off wakes a parked prompt behind a notice. A fake core on 127.0.0.1 and a manual clock.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Admit } from "../../src/dispatch/admit.js"
import { Outbox } from "../../src/dispatch/dispatch.js"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Digest } from "../../src/report/digest.js"
import { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { fakeCore, until } from "../support/core.js"
import { start } from "../support/service.js"
import { temp } from "../fixtures/repo.js"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const AREA = OwnTeam.AreaID.make("ar_ui")

async function setup(input: { readonly features?: Partial<Services.Factories> } = {}) {
  const box = temp("own-team-outbox-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folder = path.join(box.root, "home-team", "ui")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(folder, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const core = fakeCore(service)
  core.add(OWNER_SESSION, folder)
  core.add(MAIN_SESSION, home)
  const world = new World()
  const clock = manual()
  const h = controller(world, {
    directory: home,
    clock,
    source: service.source,
    ...(input.features === undefined ? {} : { features: input.features }),
  })
  cleanups.push(() => h.close())
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(area({ slug: "ui", directory: folder }))
  })
  // The start's resumes (each drains every outbox) end before a test sends, so only the wait under test steps it.
  await h.controller.resume()
  const dispatch = (text: string, extra: Partial<Services.DispatchInput> = {}) =>
    h.services.features().admit.dispatch({ teamID: TEAM_ID, areaID: AREA, text, from: "main", kind: "task", ...extra })
  /** The steers own.team asked of a queue item (`PATCH …/inbox/<id>`). */
  const steers = () =>
    service.requests.filter((request) => request.method === "PATCH" && request.path.includes("/inbox/"))
  const entries = async () => (await Digest.load(h.services.kv, TEAM_ID)).entries
  return { ...h, home, folder, service, core, world, clock, dispatch, steers, entries }
}

describe("a wait no event ends (RH-20)", () => {
  test("a send that failed is tried again on a timer; outbox.list says why, since when and what holds it", async () => {
    const h = await setup()
    h.core.failing.add(OWNER_SESSION)
    const sent = await h.dispatch("정렬 고치기")
    expect(sent).toMatchObject({ ok: true, state: "waiting", why: "busy" })
    if (!sent.ok) return
    const listed = await h.services.features().admit.list({ teamID: TEAM_ID, areaID: AREA })
    expect(listed).toMatchObject({
      ok: true,
      why: "busy",
      since: h.clock.now(),
      cause: { at: h.clock.now(), retryAt: h.clock.now() + Admit.RETRY_MS },
    })
    if (!listed.ok) return
    expect(listed.cause?.failure).toContain("보내지 못했어요")
    // The main hears of it once, in a waking team update.
    expect((await h.entries()).filter((entry) => entry.reason === "request-failed")).toHaveLength(1)
    h.core.failing.delete(OWNER_SESSION)
    h.clock.advance(Admit.RETRY_MS)
    await until(
      async () => (await h.services.registry.dispatches.find(TEAM_ID, sent.dispatchID))?.state === "sent",
      30_000,
    )
    expect(h.core.prompts(OWNER_SESSION)).toHaveLength(2)
  })

  test("a fresh request whose new conversation failed twice goes to the current owner as a plain request", async () => {
    const calls = { rotations: 0 }
    const h = await setup({
      features: {
        rotate: (services) => {
          services.steps.register({
            kind: "test.rotate-fails",
            observe: async () => ({ state: "pending" }),
            act: async () => ({ ok: false, note: "담당 대화를 만들지 못했어요(시간 초과)" }),
            verify: async () => ({ ok: true }),
          })
          return {
            request: async (input) => {
              calls.rotations++
              const started = await services.runner.start({
                teamID: input.teamID,
                kind: "rotate",
                by: input.by,
                areaID: input.areaID,
                steps: [{ kind: "test.rotate-fails" }],
              })
              return started.ok
                ? { ok: true, opID: started.op.id }
                : Services.failure("busy", "busy", { teamID: input.teamID, opID: started.op.id, kind: started.op.kind })
            },
            main: async () => Services.unsupported("main.rotate"),
          }
        },
      },
    })
    const sent = await h.dispatch("새 일", { fresh: true })
    expect(sent).toMatchObject({ ok: true, state: "waiting", why: "maintaining" })
    if (!sent.ok) return
    await until(() => h.core.prompts(OWNER_SESSION).length === 1, 30_000)
    expect(calls.rotations).toBe(Outbox.FRESH_FAILURES)
    expect((await h.services.registry.dispatches.find(TEAM_ID, sent.dispatchID))?.fresh).toBeUndefined()
    const told = (await h.entries()).filter((entry) => entry.reason === "request-failed").map((entry) => entry.text)
    expect(told.filter((text) => text.includes("새 대화로 바꾸지 못했어요(담당 대화를 만들지 못했어요"))).toHaveLength(
      2,
    )
    expect(told.some((text) => text.includes("새 대화 없이 지금 담당 대화에 보냅니다"))).toBe(true)
  })

  test("a main request still queued for an idle owner 10 s after its admission is steered once", async () => {
    const h = await setup()
    const dispatchID = OwnTeam.DispatchID.create()
    const msgID = MsgID.dispatch(dispatchID, OWNER_SESSION)
    h.service.routes.set(
      `PATCH /api/session/${OWNER_SESSION}/inbox/${msgID}`,
      () => new Response(null, { status: 204 }),
    )
    h.core.inbox.set(OWNER_SESSION, [
      {
        id: msgID,
        sessionID: OWNER_SESSION,
        type: "user",
        delivery: "queue",
        payload: { text: "앞 요청", metadata: { [OwnTeam.DISPATCH_META]: { id: dispatchID } } },
        time: { created: h.clock.now() - 60_000 },
      },
    ])
    expect(await h.dispatch("다음 요청")).toMatchObject({ state: "waiting", why: "queued" })
    await until(() => h.steers().length === 1, 30_000)
    expect(h.steers()[0]?.body).toEqual({ delivery: "steer" })
    await h.services.features().admit.drain({ teamID: TEAM_ID, areaID: AREA })
    expect(h.steers()).toHaveLength(1)
  })
})

describe("own maintenance counts what still acts on the area (RH-20)", () => {
  test("a failed step and a confirm that holds nothing back do not hold the area's requests; a holding confirm does", async () => {
    const h = await setup()
    h.services.steps.register({
      kind: "test.ask",
      observe: async () => ({ state: "pending" }),
      act: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
    })
    h.services.steps.register({
      kind: "test.hold",
      holds: true,
      observe: async () => ({ state: "pending" }),
      act: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
    })
    const op = (steps: OwnTeam.Op["steps"], extra: Partial<OwnTeam.Op> = {}): OwnTeam.Op => ({
      id: OwnTeam.OpID.create(),
      teamID: TEAM_ID,
      kind: "reorg",
      by: "user",
      state: "waiting",
      createdAt: h.clock.now(),
      steps,
      ...extra,
    })
    const step = (
      kind: string,
      state: OwnTeam.StepState,
      args: Record<string, unknown> = { areaID: AREA },
    ): OwnTeam.Step => ({
      id: `s_${kind}_${state}`,
      kind,
      args,
      mode: state === "needs_confirm" ? "confirm" : "auto",
      state,
    })
    const steps = h.services.steps
    expect(Outbox.maintaining(op([step("test.ask", "failed"), step("test.ask", "needs_confirm")]), AREA, steps)).toBe(
      false,
    )
    expect(Outbox.maintaining(op([step("test.hold", "needs_confirm")]), AREA, steps)).toBe(true)
    // An op of the area that still runs maintains it; a team-wide 메인 새 대화 never does.
    expect(Outbox.maintaining(op([], { state: "running", areaID: AREA }), AREA, steps)).toBe(true)
    expect(
      Outbox.maintaining(
        op([step("rotate.main-idle", "pending", { from: MAIN_SESSION })], { state: "running", kind: "rotate" }),
        AREA,
        steps,
      ),
    ).toBe(false)
    expect(Outbox.maintaining(op([], { state: "running", kind: "team-account" }), AREA, steps)).toBe(true)
  })
})

describe("Main 멈춤 off (RH-20)", () => {
  test("a notice waiting in the idle queue does not hide the parked prompt behind it: the prompt is woken", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, AREA)
      if (current) await h.services.registry.areas.put({ ...current, paused: "user" })
    })
    h.service.routes.set(
      `PATCH /api/session/${OWNER_SESSION}/inbox/msg_prompt`,
      () => new Response(null, { status: 204 }),
    )
    h.core.inbox.set(OWNER_SESSION, [
      {
        id: "msg_notice",
        sessionID: OWNER_SESSION,
        type: "synthetic",
        delivery: "steer",
        payload: { text: "Harness: codex → pi", metadata: { "own.harness": { switch: {} } } },
      },
      { id: "msg_prompt", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: { text: "멈춘 일" } },
    ])
    expect(await h.services.features().pause.area({ teamID: TEAM_ID, areaID: AREA, on: false })).toMatchObject({
      ok: true,
    })
    await until(() => h.steers().length === 1, 30_000)
    expect(h.steers()[0]?.path).toBe(`/api/session/${OWNER_SESSION}/inbox/msg_prompt`)
  })
})
