// Safe points (06 §8.4): the checks that never wake a Location first (active sessions placed in the folder, the
// owner's inbox, permission requests, other own work, a git operation in progress), then forms and running shells,
// and for the extended safe point ptys, only when that folder's Location is already alive. The own service is a fake
// HTTP server on 127.0.0.1.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { SafePoint } from "../../src/sessions/safe-point.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OWNER_SESSION, TEAM_ID, World, area, context, controller, team } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"
import { init, temp } from "../fixtures/repo.js"

// A fake core behind the self-HTTP routes own.team reads for a safe point; routes are added per session id.
function fakeCore(service: FakeService) {
  const active = new Set<string>()
  const sessions = new Map<string, string>()
  const inbox = new Map<string, unknown[]>()
  const permissions = new Map<string, unknown[]>()
  const forms = new Map<string, unknown[]>()
  const shells: Array<{
    id: string
    status: string
    cwd: string
    command?: string
    metadata?: Record<string, unknown>
  }> = []
  const ptys: Array<{ id: string; status: string; cwd: string }> = []
  service.routes.set("GET /api/session/active", () =>
    Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) }),
  )
  service.routes.set("GET /api/session", (request) =>
    Response.json({
      data: [...sessions]
        .filter(([, directory]) => directory === request.query.directory)
        .map(([id, directory]) => session({ id, directory })),
      cursor: {},
    }),
  )
  service.routes.set("GET /api/shell", () => Response.json({ data: shells }))
  service.routes.set("GET /api/pty", () => Response.json({ data: ptys }))
  const add = (id: string, directory: string) => {
    sessions.set(id, directory)
    service.routes.set(`GET /api/session/${id}`, () => Response.json({ data: session({ id, directory }) }))
    service.routes.set(`GET /api/session/${id}/inbox`, () => Response.json({ data: inbox.get(id) ?? [] }))
    service.routes.set(`GET /api/session/${id}/permission`, () => Response.json({ data: permissions.get(id) ?? [] }))
    service.routes.set(`GET /api/session/${id}/form`, () => Response.json({ data: forms.get(id) ?? [] }))
  }
  const asked = (prefix: string) => service.requests.filter((request) => request.path.startsWith(prefix)).length
  return { active, inbox, permissions, forms, shells, ptys, add, asked }
}

function item(id: string, sessionID: string) {
  return { id, sessionID, type: "synthetic", delivery: "queue", payload: { text: "x" } }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_ui")
const USER = SessionID.make("ses_user0000000000000000000001")

async function setup() {
  const box = temp("own-team-safe-")
  cleanups.push(() => box.dispose())
  const home = init(path.join(box.root, "home"))
  const folder = path.join(box.root, "home-team", "ui")
  fs.mkdirSync(path.join(folder, ".git"), { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const core = fakeCore(service)
  core.add(OWNER_SESSION, folder)
  core.add(MAIN_SESSION, home)
  core.add(USER, folder)
  const world = new World()
  const clock = manual()
  const h = controller(world, { directory: home, clock, source: service.source })
  cleanups.push(() => h.close())
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(area({ slug: "ui", directory: folder }))
  })
  const check = (input: { readonly areaID?: OwnTeam.AreaID; readonly extended?: boolean } = { areaID: UI }) =>
    h.services.features().safePoint.check({ teamID: TEAM_ID, ...input })
  /** The area folder's Location comes up (an own.team instance there). */
  const alive = () => {
    const detach = h.controller.attach({
      ctx: context(world, { directory: folder }).ctx,
      directory: folder,
      control: false,
      leader: () => false,
    })
    cleanups.push(detach)
  }
  return { ...h, clock, service, home, folder, core, check, alive }
}

describe("Location-free checks", () => {
  test("an idle folder whose Location is down is safe without asking for forms, shells or ptys", async () => {
    const h = await setup()
    expect(await h.check({ areaID: UI, extended: true })).toEqual({ ok: true })
    expect(h.core.asked("/api/shell") + h.core.asked("/api/pty")).toBe(0)
    expect(h.core.asked(`/api/session/${OWNER_SESSION}/form`)).toBe(0)
  })

  test("in order: a working session of the folder, the owner's inbox, a permission request, own work, git", async () => {
    const h = await setup()
    h.core.active.add(USER)
    h.core.inbox.set(OWNER_SESSION, [item("msg_x", OWNER_SESSION)])
    h.core.permissions.set(USER, [{ id: "per_x", sessionID: USER }])
    fs.writeFileSync(path.join(h.folder, ".git", "MERGE_HEAD"), "x")
    expect(await h.check()).toEqual({ ok: false, why: "session", sessionIDs: [USER] })
    h.core.active.delete(USER)
    expect(await h.check()).toEqual({ ok: false, why: "inbox", sessionIDs: [OWNER_SESSION] })
    h.core.inbox.delete(OWNER_SESSION)
    expect(await h.check()).toEqual({ ok: false, why: "permission", sessionIDs: [USER] })
    h.core.permissions.delete(USER)
    const during = SafePoint.during(h.services, { teamID: TEAM_ID, areaID: UI }, async () => h.check())
    expect(await during).toEqual({ ok: false, why: "own", sessionIDs: [] })
    expect(await h.check()).toEqual({ ok: false, why: "git", sessionIDs: [] })
    fs.rmSync(path.join(h.folder, ".git", "MERGE_HEAD"))
    expect(await h.check()).toEqual({ ok: true })
  })

  test("a context reset waiting in the owner's queue is no work in the folder (06 §6.1)", async () => {
    const h = await setup()
    const reset = { id: "msg_reset", sessionID: OWNER_SESSION, type: "reset", delivery: "queue", payload: {} }
    h.core.inbox.set(OWNER_SESSION, [reset])
    expect(await h.check()).toEqual({ ok: true })
    h.core.inbox.set(OWNER_SESSION, [reset, item("msg_after", OWNER_SESSION)])
    expect(await h.check()).toEqual({ ok: false, why: "inbox", sessionIDs: [OWNER_SESSION] })
    // A background notice of work started before a reset that still applies is passive: it starts no turn (core P-035).
    const notice = {
      id: "msg_notice",
      sessionID: OWNER_SESSION,
      type: "synthetic",
      delivery: "steer",
      payload: { text: "<shell>old job</shell>", beforeReset: "msg_reset" },
    }
    h.core.inbox.set(OWNER_SESSION, [notice])
    expect(await h.check()).toEqual({ ok: true })
    // Once that reset is cancelled or undone, core drops `beforeReset`: an ordinary notice is work.
    h.core.inbox.set(OWNER_SESSION, [{ ...notice, payload: { text: "<shell>old job</shell>" } }])
    expect(await h.check()).toEqual({ ok: false, why: "inbox", sessionIDs: [OWNER_SESSION] })
  })

  test("input that waits for the next prompt is no work: a harness switch notice admitted without a wake (RH-15)", async () => {
    const h = await setup()
    // own.harness' notice of a harness switch (`resume: false`): it goes with the next prompt and starts no run.
    const notice = {
      id: "msg_switch",
      sessionID: OWNER_SESSION,
      type: "synthetic",
      delivery: "steer",
      payload: { text: "Harness: codex → pi", metadata: { "own.harness": { switch: { from: "codex", to: "pi" } } } },
      time: { created: h.clock.now() },
    }
    h.core.inbox.set(OWNER_SESSION, [notice])
    h.core.inbox.set(MAIN_SESSION, [{ ...notice, id: "msg_main", sessionID: MAIN_SESSION }])
    // Just admitted, input may still start its run: work.
    expect(await h.check()).toEqual({ ok: false, why: "inbox", sessionIDs: [OWNER_SESSION] })
    expect(await h.check({})).toEqual({ ok: false, why: "inbox", sessionIDs: [MAIN_SESSION] })
    // Its admission did not start a run: it waits for the prompt that waits for this safe point.
    h.clock.advance(SafePoint.WAKE_MS)
    expect(await h.check()).toEqual({ ok: true })
    expect(await h.check({})).toEqual({ ok: true })
    // A running owner is still work, whatever its queue holds.
    h.core.active.add(OWNER_SESSION)
    expect(await h.check()).toEqual({ ok: false, why: "session", sessionIDs: [OWNER_SESSION] })
  })

  test("own-omo's notice for the next prompt is no work either, and no input a handoff must keep (15 §3.10)", async () => {
    const h = await setup()
    // omo's `noReply` prompt (a background task ended while others still run): own-omo admits it without a wake.
    const notice = {
      id: "msg_omo",
      sessionID: OWNER_SESSION,
      type: "synthetic" as const,
      delivery: "queue" as const,
      payload: {
        text: "[BACKGROUND TASK COMPLETED]",
        description: "omo 알림",
        metadata: { source: "own.omo" },
        background: true,
      },
      time: { created: h.clock.now() },
    }
    h.core.inbox.set(OWNER_SESSION, [notice])
    expect(await h.check()).toEqual({ ok: false, why: "inbox", sessionIDs: [OWNER_SESSION] })
    h.clock.advance(SafePoint.WAKE_MS)
    expect(await h.check()).toEqual({ ok: true })
    expect(SafePoint.work(notice)).toBe(false)
  })

  test("the queues are read before session.active: input woken between the two reads finds its session active (RH-20)", async () => {
    const h = await setup()
    // A prompt the user's stop parked a minute ago: on its own, no work (it waits for the next prompt).
    const parked = {
      id: "msg_parked",
      sessionID: OWNER_SESSION,
      type: "user",
      delivery: "queue",
      payload: { text: "정렬 마저" },
      time: { created: h.clock.now() - 60_000 },
    }
    h.core.inbox.set(OWNER_SESSION, [parked])
    expect(await h.check()).toEqual({ ok: true })
    // Main 멈춤 off (`Pause.wake`), 지금 보내기 or a revert wakes it right while the safe point reads: by the time
    // `session.active` is read, the owner runs.
    h.service.routes.set(`GET /api/session/${OWNER_SESSION}/inbox`, () => {
      h.core.active.add(OWNER_SESSION)
      return Response.json({ data: [parked] })
    })
    expect(await h.check()).toEqual({ ok: false, why: "session", sessionIDs: [OWNER_SESSION] })
  })

  test("a conversation named in `also` (the one 담당 대화 바꾸기 seats) counts with its queue: young input holds, parked input does not", async () => {
    const h = await setup()
    const also = () =>
      h.services.features().safePoint.check({ teamID: TEAM_ID, areaID: UI, also: [USER, OWNER_SESSION] })
    h.core.inbox.set(USER, [{ ...item("msg_typed", USER), type: "user", time: { created: h.clock.now() } }])
    // Any other conversation of the folder counts by its run, not by its queue.
    expect(await h.check()).toEqual({ ok: true })
    expect(await also()).toEqual({ ok: false, why: "inbox", sessionIDs: [USER] })
    // Its admission started no run: it waits for the next prompt.
    h.clock.advance(SafePoint.WAKE_MS)
    const before = h.core.asked(`/api/session/${OWNER_SESSION}/inbox`)
    expect(await also()).toEqual({ ok: true })
    // The owner named again is read once.
    expect(h.core.asked(`/api/session/${OWNER_SESSION}/inbox`) - before).toBe(1)
    h.core.active.add(USER)
    expect(await also()).toEqual({ ok: false, why: "session", sessionIDs: [USER] })
  })

  test("an admission time ahead of the clock (a wall clock stepped back) is parked, not work for good (RH-20)", async () => {
    const h = await setup()
    h.core.inbox.set(OWNER_SESSION, [
      { ...item("msg_future", OWNER_SESSION), time: { created: h.clock.now() + 3_600_000 } },
    ])
    expect(await h.check()).toEqual({ ok: true })
    h.clock.advance(60_000)
    expect(await h.check()).toEqual({ ok: true })
  })

  test("a working session elsewhere, or of another area's folder, does not count", async () => {
    const h = await setup()
    const elsewhere = SessionID.make("ses_user0000000000000000000002")
    h.core.add(elsewhere, h.home)
    h.core.active.add(elsewhere)
    h.core.active.add(MAIN_SESSION)
    expect(await h.check()).toEqual({ ok: true })
    expect(await h.check({})).toMatchObject({ ok: false, why: "session" })
  })

  test("the home: the main's inbox and the home's own git state", async () => {
    const h = await setup()
    expect(await h.check({})).toEqual({ ok: true })
    h.core.inbox.set(MAIN_SESSION, [item("msg_update", MAIN_SESSION)])
    expect(await h.check({})).toEqual({ ok: false, why: "inbox", sessionIDs: [MAIN_SESSION] })
    h.core.inbox.delete(MAIN_SESSION)
    fs.mkdirSync(path.join(h.home, ".git", "rebase-merge"))
    expect(await h.check({})).toMatchObject({ ok: false, why: "git" })
  })

  test("an answer the service cannot give is not safe; an unknown area is not safe", async () => {
    const h = await setup()
    h.service.routes.delete("GET /api/session/active")
    expect(await h.check()).toMatchObject({ ok: false, why: "session" })
    expect(await h.check({ areaID: OwnTeam.AreaID.make("ar_none") })).toMatchObject({ ok: false, why: "own" })
  })
})

describe("when the folder's Location is alive", () => {
  test("pending forms and running shells count, named with their commands (RH-20); ptys only for the extended safe point", async () => {
    const h = await setup()
    h.alive()
    h.core.forms.set(USER, [{ id: "frm_x" }])
    expect(await h.check()).toEqual({ ok: false, why: "form", sessionIDs: [USER] })
    h.core.forms.delete(USER)
    h.core.shells.push({
      id: "sh_x",
      status: "running",
      cwd: h.folder,
      command: "bun run dev",
      metadata: { sessionID: OWNER_SESSION },
    })
    expect(await h.check()).toEqual({
      ok: false,
      why: "shell",
      sessionIDs: [OWNER_SESSION],
      shells: [{ id: "sh_x", command: "bun run dev", kind: "shell", sessionID: OWNER_SESSION, directory: h.folder }],
    })
    h.core.shells[0]!.status = "exited"
    h.core.ptys.push({ id: "pty_x", status: "running", cwd: h.folder })
    expect(await h.check()).toEqual({ ok: true })
    expect(await h.check({ areaID: UI, extended: true })).toEqual({
      ok: false,
      why: "pty",
      sessionIDs: [],
      shells: [{ id: "pty_x", command: "", kind: "pty", directory: h.folder }],
    })
    h.core.ptys[0]!.status = "exited"
    expect(await h.check({ areaID: UI, extended: true })).toEqual({ ok: true })
  })
})
