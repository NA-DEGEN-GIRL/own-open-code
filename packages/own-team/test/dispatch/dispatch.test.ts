// Main requests (06 §5.1, §5.7, TG7 at plugin level): one request per area at a time and only when the whole folder is
// idle, `queue` delivery with the hashed id, the envelope and `own.dispatch` metadata, FIFO re-checks on events only
// (manual clock, hub-published synthetic events), preparation (owner, role, `fresh` rotation, hold ref) and the
// restart rule (same id, the first admission wins). The own service is a fake HTTP server on 127.0.0.1.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Direct } from "../../src/dispatch/direct.js"
import { Envelope } from "../../src/dispatch/envelope.js"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Outbox } from "../../src/dispatch/dispatch.js"
import { Services } from "../../src/services.js"
import { DispatchTool } from "../../src/tools/dispatch.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { event, fakeCore, until } from "../support/core.js"
import { start } from "../support/service.js"
import { commit, f1, git, temp, write } from "../fixtures/repo.js"

// ---------------------------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const AREA = OwnTeam.AreaID.make("ar_ui")

async function setup(
  input: { readonly area?: (base: OwnTeam.Area) => OwnTeam.Area; readonly features?: Partial<Services.Factories> } = {},
) {
  const box = temp("own-team-dispatch-")
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
  const record = (input.area ?? ((base) => base))(area({ slug: "ui", directory: folder }))
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(record)
  })
  const dispatch = (text: string, extra: Partial<Services.DispatchInput> = {}) =>
    h.services.features().admit.dispatch({ teamID: TEAM_ID, areaID: AREA, text, from: "main", kind: "task", ...extra })
  const stored = async (dispatchID: string) => h.services.registry.dispatches.find(TEAM_ID, dispatchID)
  return { ...h, home, folder, service, core, world, clock, dispatch, stored }
}

describe("admission (5.1)", () => {
  test("an idle folder gets the request at once: queue delivery, hashed id, envelope, own.dispatch metadata", async () => {
    const h = await setup()
    const sent = await h.dispatch("정렬을 고치고 테스트를 더하세요", { task: "정렬 버그" })

    expect(sent).toMatchObject({ ok: true, state: "queued" })
    if (!sent.ok) return
    const prompts = h.core.prompts(OWNER_SESSION)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.query["location[directory]"]).toBe(h.folder)
    expect(prompts[0]!.body).toEqual({
      id: MsgID.dispatch(sent.dispatchID, OWNER_SESSION),
      text: Envelope.wrap({
        dispatch: { id: sent.dispatchID, from: "main", task: "정렬 버그", text: "정렬을 고치고 테스트를 더하세요" },
        area: "ui",
      }),
      metadata: {
        "own.dispatch": { id: sent.dispatchID, from: "main", teamID: TEAM_ID, areaID: AREA, task: "정렬 버그" },
        source: "own.team",
      },
      delivery: "queue",
    })
    expect(await h.stored(sent.dispatchID)).toMatchObject({
      state: "sent",
      sentTo: { sessionID: OWNER_SESSION, msgID: MsgID.dispatch(sent.dispatchID, OWNER_SESSION), at: h.clock.now() },
    })
    const outbox = h.published.filter((item) => item.name === "outbox.changed").map((item) => item.data)
    expect(outbox).toEqual([
      { teamID: TEAM_ID, areaID: AREA, waiting: 1 },
      { teamID: TEAM_ID, areaID: AREA, waiting: 0 },
    ])
  })

  test("a working owner keeps the request in the outbox until its run ends (event, no clock)", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const sent = await h.dispatch("a")
    expect(sent).toMatchObject({ ok: true, state: "waiting", why: "busy" })
    expect(h.core.prompts()).toHaveLength(0)

    h.clock.advance(60 * 60 * 1000)
    await Bun.sleep(20)
    expect(h.core.prompts()).toHaveLength(0)

    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    if (!sent.ok) return
    await until(async () => (await h.stored(sent.dispatchID))?.state === "sent")
    expect(h.core.prompts()).toHaveLength(1)
  })

  test("another conversation of the same folder (a subfolder too) blocks it; one in the main folder does not", async () => {
    const h = await setup()
    const user = "ses_user0000000000000000000001"
    const sub = "ses_user0000000000000000000002"
    const elsewhere = "ses_user0000000000000000000003"
    h.core.add(user, h.folder)
    h.core.add(sub, path.join(h.folder, "src"))
    h.core.add(elsewhere, h.home)
    h.core.active.add(elsewhere)
    h.core.active.add(sub)
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "busy" })
    h.core.active.delete(sub)
    h.core.active.add(user)
    h.controller.hub.receive(event("session.execution.failed", { sessionID: sub }))
    await Bun.sleep(30)
    expect(h.core.prompts()).toHaveLength(0)
    h.core.active.delete(user)
    h.controller.hub.receive(event("session.execution.interrupted", { sessionID: user, reason: "user" }))
    await until(() => h.core.prompts().length === 1)
  })

  test("one at a time, oldest first: the next waits while a main request is undelivered or running", async () => {
    const h = await setup()
    const first = await h.dispatch("first")
    const second = await h.dispatch("second")
    const third = await h.dispatch("third")
    expect(first).toMatchObject({ state: "queued" })
    expect(second).toMatchObject({ state: "waiting", why: "queued" })
    expect(third).toMatchObject({ state: "waiting", why: "queued" })
    expect(h.core.prompts()).toHaveLength(1)

    h.core.run(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: "ses_other000000000000000000001" }))
    await Bun.sleep(30)
    expect(h.core.prompts()).toHaveLength(1)

    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await until(() => h.core.prompts().length === 2)
    h.core.run(OWNER_SESSION)
    h.core.active.delete(OWNER_SESSION)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: OWNER_SESSION }))
    await until(() => h.core.prompts().length === 3)

    const ids = [first, second, third].map((item) => (item.ok ? MsgID.dispatch(item.dispatchID, OWNER_SESSION) : ""))
    expect(h.core.prompts().map((prompt) => prompt.body.id)).toEqual(ids)
    expect(h.core.prompts().every((prompt) => prompt.body.delivery === "queue")).toBe(true)
  })

  test("a user item in the owner's queue does not hold the request; only own.dispatch items do", async () => {
    const h = await setup()
    h.core.inbox.set(OWNER_SESSION, [
      { id: "msg_user", sessionID: OWNER_SESSION, type: "user", delivery: "queue", payload: { text: "사용자 입력" } },
    ])
    expect(await h.dispatch("a")).toMatchObject({ state: "queued" })
  })

  test("a context reset waiting in the owner's queue does not hold the request: it goes in behind it", async () => {
    const h = await setup()
    h.core.inbox.set(OWNER_SESSION, [
      { id: "msg_reset", sessionID: OWNER_SESSION, type: "reset", delivery: "queue", payload: {} },
    ])
    expect(await h.dispatch("a")).toMatchObject({ state: "queued" })
    expect(h.core.inbox.get(OWNER_SESSION)?.map((item) => item.type)).toEqual(["reset", "user"])
  })

  test("Main 멈춤, a broken area and own maintenance keep it waiting with that reason", async () => {
    const paused = await setup({ area: (base) => ({ ...base, paused: "user" }) })
    expect(await paused.dispatch("a")).toMatchObject({ state: "waiting", why: "paused" })
    const broken = await setup({
      area: (base) => ({ ...base, state: "broken", broken: { why: "missing", at: 1 } }),
    })
    expect(await broken.dispatch("a")).toMatchObject({ state: "waiting", why: "broken" })

    const h = await setup()
    const opID = OwnTeam.OpID.create()
    const op: OwnTeam.Op = {
      id: opID,
      teamID: TEAM_ID,
      kind: "paths",
      by: "user",
      state: "running",
      areaID: AREA,
      createdAt: h.clock.now(),
      steps: [],
    }
    await h.services.write(TEAM_ID, () => h.services.journal.put(op))
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "maintaining" })
    expect(paused.core.prompts().length + broken.core.prompts().length + h.core.prompts().length).toBe(0)

    // The op ends: `op.done` checks the outbox again.
    await h.services.write(TEAM_ID, () => h.services.journal.put({ ...op, state: "done" }))
    h.controller.hub.publish({
      name: "op.done",
      data: { teamID: TEAM_ID, opID, state: "done", summary: null, undoable: false, pending: 0 },
    })
    await until(() => h.core.prompts().length === 1)
  })

  test("an op of another area does not hold it; a running team-wide op does", async () => {
    const h = await setup()
    const base = { teamID: TEAM_ID, by: "user" as const, createdAt: h.clock.now(), steps: [] }
    await h.services.write(TEAM_ID, () =>
      h.services.journal.put({
        ...base,
        id: OwnTeam.OpID.create(),
        kind: "paths",
        state: "running",
        areaID: OwnTeam.AreaID.make("ar_other"),
      }),
    )
    expect(await h.dispatch("a")).toMatchObject({ state: "queued" })
    const g = await setup()
    await g.services.write(TEAM_ID, () =>
      g.services.journal.put({ ...base, id: OwnTeam.OpID.create(), kind: "team-account", state: "running" }),
    )
    expect(await g.dispatch("a")).toMatchObject({ state: "waiting", why: "maintaining" })
  })

  test("a team that is off records nothing; an unknown area is not found", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.teams.get(TEAM_ID)
      if (current) await h.services.registry.teams.put({ ...current, state: "off" })
    })
    expect(await h.dispatch("a")).toMatchObject({ ok: false, error: "team_off" })
    expect(await h.services.registry.dispatches.list(TEAM_ID)).toEqual([])
    const g = await setup()
    expect(await g.dispatch("a", { areaID: OwnTeam.AreaID.make("ar_none") })).toMatchObject({
      ok: false,
      error: "not_found",
      data: { what: "area" },
    })
  })
})

describe("before sending (5.1 step 3)", () => {
  test("a missing owner is created first and gets the request", async () => {
    const created = SessionID.make("ses_owner000000000000000000009")
    const calls: string[] = []
    const h = await setup({
      area: (base) => ({ ...base, owner: { sessionID: null, previous: [], attached: true } }),
      features: {
        owner: (services) => ({
          create: async (input) => {
            calls.push(`create ${input.areaID}`)
            await services.write(input.teamID, async () => {
              const current = await services.registry.areas.get(input.teamID, input.areaID)
              if (current)
                await services.registry.areas.put({ ...current, owner: { ...current.owner, sessionID: created } })
            })
            return { ok: true, sessionID: created }
          },
          attach: async () => Services.unsupported("adopt"),
        }),
      },
    })
    h.core.add(created, h.folder)
    const sent = await h.dispatch("a")
    expect(sent).toMatchObject({ state: "queued" })
    expect(calls).toEqual(["create ar_ui"])
    expect(h.core.prompts(created)).toHaveLength(1)
  })

  test("an owner without its role is attached first; when that is not possible the request waits", async () => {
    const calls: string[] = []
    const attachable = await setup({
      area: (base) => ({ ...base, owner: { ...base.owner, attached: false } }),
      features: {
        owner: (services) => ({
          create: async () => Services.unsupported("reorg.new"),
          attach: async (input) => {
            calls.push(`attach ${input.areaID}`)
            await services.write(input.teamID, async () => {
              const current = await services.registry.areas.get(input.teamID, input.areaID)
              if (current)
                await services.registry.areas.put({ ...current, owner: { ...current.owner, attached: true } })
            })
            return { ok: true }
          },
        }),
      },
    })
    expect(await attachable.dispatch("a")).toMatchObject({ state: "queued" })
    expect(calls).toEqual(["attach ar_ui"])

    const stub = await setup({ area: (base) => ({ ...base, owner: { ...base.owner, attached: false } }) })
    expect(await stub.dispatch("a")).toMatchObject({ state: "waiting", why: "maintaining" })
    expect(stub.core.prompts()).toHaveLength(0)
  })

  test("fresh: the owner conversation is replaced first and the new owner gets the request", async () => {
    const next = SessionID.make("ses_owner000000000000000000005")
    const requests: Array<{ reason: string; handoff: string; by: string }> = []
    const opID = OwnTeam.OpID.create()
    const h = await setup({
      features: {
        rotate: (services) => ({
          request: async (input) => {
            requests.push({ reason: input.reason, handoff: input.handoff, by: input.by })
            await services.write(input.teamID, () =>
              services.journal.put({
                id: opID,
                teamID: input.teamID,
                kind: "rotate",
                by: input.by,
                state: "running",
                areaID: input.areaID,
                createdAt: services.clock.now(),
                steps: [],
              }),
            )
            return { ok: true, opID }
          },
          main: async () => Services.unsupported("rotate"),
        }),
      },
    })
    h.core.add(next, h.folder)
    const sent = await h.dispatch("관련 없는 새 일", { fresh: true })
    expect(sent).toMatchObject({ state: "waiting", why: "maintaining" })
    expect(requests).toEqual([{ reason: "fresh", handoff: "warm", by: "main" }])
    expect(h.core.prompts()).toHaveLength(0)

    // The rotation swaps the owner and ends.
    h.clock.advance(1_000)
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, AREA)
      if (!current?.owner.sessionID) return
      await h.services.registry.areas.put({
        ...current,
        owner: {
          sessionID: next,
          previous: [
            ...current.owner.previous,
            { sessionID: current.owner.sessionID, endedAt: h.clock.now(), why: "fresh" },
          ],
          attached: true,
        },
      })
      const op = await h.services.journal.get(TEAM_ID, opID)
      if (op) await h.services.journal.put({ ...op, state: "done" })
    })
    h.controller.hub.publish({
      name: "op.done",
      data: { teamID: TEAM_ID, opID, state: "done", summary: null, undoable: false, pending: 0 },
    })
    await until(() => h.core.prompts(next).length === 1)
    expect(requests).toHaveLength(1)
    expect(h.core.prompts(OWNER_SESSION)).toHaveLength(0)
  })

  test("fresh on a build without rotation goes to the current owner", async () => {
    const h = await setup({
      features: {
        rotate: () => ({
          request: async () => Services.unsupported("rotate"),
          main: async () => Services.unsupported("rotate"),
        }),
      },
    })
    expect(await h.dispatch("a", { fresh: true })).toMatchObject({ state: "queued" })
    expect(h.core.prompts(OWNER_SESSION)).toHaveLength(1)
  })

  test("direct user talk since the last request plus uncommitted changes leave a hold ref named by the request", async () => {
    const box = temp("own-team-dispatch-git-")
    cleanups.push(() => box.dispose())
    const repo = f1(box.root)
    const folder = path.join(box.root, "home-team", "ui")
    git(repo.home, ["worktree", "add", "-q", "-b", "ui", folder])
    const gitDir = git(folder, ["rev-parse", "--absolute-git-dir"]).trim()
    const h = await setup({
      area: (base) => ({ ...base, directory: folder, gitDir, direct: { at: 1, sessionID: OWNER_SESSION } }),
    })
    h.core.add(OWNER_SESSION, folder)

    // Direct talk, but nothing uncommitted: no hold.
    const clean = await h.dispatch("first")
    expect(clean).toMatchObject({ state: "queued" })
    expect(git(folder, ["for-each-ref", "refs/own"]).trim()).toBe("")
    h.core.run(OWNER_SESSION)
    h.core.active.delete(OWNER_SESSION)

    // The user talks again after that request and leaves work.
    h.clock.advance(1_000)
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, AREA)
      if (current)
        await h.services.registry.areas.put({ ...current, direct: { at: h.clock.now(), sessionID: OWNER_SESSION } })
    })
    write(folder, { "src/app/main.ts": "export const main = 'user'\n" })
    const sent = await h.dispatch("second")
    expect(sent).toMatchObject({ state: "queued" })
    if (!sent.ok) return
    const ref = `refs/own/hold/${AREA}/${sent.dispatchID}`
    const sha = git(folder, ["rev-parse", ref]).trim()
    expect(git(folder, ["show", `${sha}:src/app/main.ts`])).toBe("export const main = 'user'\n")

    // No direct talk since the last request: no new hold, even with uncommitted work.
    h.core.run(OWNER_SESSION)
    h.core.active.delete(OWNER_SESSION)
    commit(folder, "owner work")
    write(folder, { "src/app/main.ts": "export const main = 'owner'\n" })
    expect(await h.dispatch("third")).toMatchObject({ state: "queued" })
    expect(git(folder, ["for-each-ref", "--format=%(refname)", "refs/own"]).trim()).toBe(ref)
  }, 120_000)
})

describe("restart (5.7)", () => {
  test("a request sent just before a crash is recognized in the owner's queue and not sent twice", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const waiting = await h.dispatch("a")
    if (!waiting.ok) throw new Error("not recorded")
    // The old controller sent it, then died before writing `sent`.
    const id = MsgID.dispatch(waiting.dispatchID, OWNER_SESSION)
    h.core.inbox.set(OWNER_SESSION, [
      {
        id,
        sessionID: OWNER_SESSION,
        type: "user",
        delivery: "queue",
        payload: { text: "x", metadata: { "own.dispatch": { id: waiting.dispatchID } } },
      },
    ])
    h.core.active.delete(OWNER_SESSION)
    await h.close()
    const restarted = controller(h.world, { directory: h.home, clock: h.clock, source: h.service.source })
    cleanups.push(() => restarted.close())
    await until(
      async () => (await restarted.services.registry.dispatches.find(TEAM_ID, waiting.dispatchID))?.state === "sent",
    )
    expect(h.core.prompts()).toHaveLength(0)
  })

  test("a waiting request is sent again with the same id after a restart", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    const waiting = await h.dispatch("a")
    if (!waiting.ok) throw new Error("not recorded")
    await h.close()
    h.core.active.delete(OWNER_SESSION)
    const restarted = controller(h.world, { directory: h.home, clock: h.clock, source: h.service.source })
    cleanups.push(() => restarted.close())
    await until(() => h.core.prompts().length >= 1)
    await Bun.sleep(30)
    expect(h.core.prompts().map((prompt) => prompt.body.id)).toEqual([
      MsgID.dispatch(waiting.dispatchID, OWNER_SESSION),
    ])
    // Core keeps the first admission of a reused id: a second send changes nothing in the queue.
    expect(h.core.inbox.get(OWNER_SESSION)).toHaveLength(1)
  })
})

describe("requests in a replaced conversation's queue (RH-20, 담당 대화 바꾸기)", () => {
  // A request sent to the owner and still in its queue; the owner is busy afterwards, so what goes back stays waiting.
  const queued = async () => {
    const h = await setup()
    const sent = await h.dispatch("a")
    if (!sent.ok) throw new Error("not recorded")
    await until(async () => (await h.stored(sent.dispatchID))?.state === "sent")
    h.core.active.add(OWNER_SESSION)
    const inboxID = MsgID.dispatch(sent.dispatchID, OWNER_SESSION)
    const requeue = () =>
      Outbox.requeue(h.services, { teamID: TEAM_ID, areaID: AREA, from: OWNER_SESSION, directory: h.folder })
    return { ...h, dispatchID: sent.dispatchID, inboxID, requeue }
  }
  const withdraws = (h: Awaited<ReturnType<typeof queued>>, status = 204) =>
    h.service.routes.set(`DELETE /api/session/${OWNER_SESSION}/inbox/${h.inboxID}`, () => {
      if (status === 204) h.core.inbox.set(OWNER_SESSION, [])
      return status === 204
        ? new Response(null, { status })
        : Response.json({ _tag: "Unavailable", message: "down" }, { status })
    })

  test("an untaken request goes back to waiting without its target and its queue item is withdrawn", async () => {
    const h = await queued()
    withdraws(h)
    expect(await h.requeue()).toEqual({ ok: true, count: 1, taken: 0 })
    const back = await h.stored(h.dispatchID)
    expect(back?.state).toBe("waiting")
    expect(back?.sentTo).toBeUndefined()
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([])
    // Nothing is left: a second pass is a no-op.
    expect(await h.requeue()).toEqual({ ok: true, count: 0, taken: 0 })
  })

  test("a queue that cannot be read is a failure, not an empty queue; a conversation that is gone holds nothing", async () => {
    const h = await queued()
    const list = `GET /api/session/${OWNER_SESSION}/inbox`
    h.service.routes.set(list, () => Response.json({ _tag: "Unavailable", message: "down" }, { status: 503 }))
    expect(await h.requeue()).toEqual({ ok: false, count: 0, taken: 0 })
    expect((await h.stored(h.dispatchID))?.state).toBe("sent")
    h.service.routes.delete(list)
    expect(await h.requeue()).toEqual({ ok: true, count: 0, taken: 0 })
  })

  test("an item that cannot be withdrawn is a failure, with its request already back in the outbox", async () => {
    const h = await queued()
    withdraws(h, 503)
    expect(await h.requeue()).toEqual({ ok: false, count: 1, taken: 0 })
    expect((await h.stored(h.dispatchID))?.state).toBe("waiting")
    // The item was withdrawn by someone else in between (404): that is done.
    h.service.routes.delete(`DELETE /api/session/${OWNER_SESSION}/inbox/${h.inboxID}`)
    expect(await h.requeue()).toEqual({ ok: true, count: 1, taken: 0 })
  })

  test("an item the conversation took while it was being withdrawn (404, and the message is there) stays sent to it", async () => {
    const h = await queued()
    const record = await h.stored(h.dispatchID)
    // Listed in the queue when the requeue reads it, a message of the conversation when it withdraws it.
    h.service.routes.set(`DELETE /api/session/${OWNER_SESSION}/inbox/${h.inboxID}`, () =>
      Response.json({ _tag: "NotFound", message: "delivered" }, { status: 404 }),
    )
    h.service.routes.set(`GET /api/session/${OWNER_SESSION}/message/${h.inboxID}`, () =>
      Response.json({ data: { id: h.inboxID } }),
    )
    expect(await h.requeue()).toEqual({ ok: false, count: 0, taken: 1 })
    // The request is the conversation's: it is never sent a second time, here or to whoever takes the seat.
    expect(await h.stored(h.dispatchID)).toEqual(record)
    expect(record).toMatchObject({ state: "sent", sentTo: { sessionID: OWNER_SESSION } })
  })

  test("a stale item of a request that has since gone to another conversation is withdrawn; that record is left alone", async () => {
    const h = await queued()
    withdraws(h)
    const other = SessionID.make("ses_other000000000000000000001")
    const record = await h.stored(h.dispatchID)
    if (record?.sentTo === undefined) throw new Error("not sent")
    const moved = { ...record, sentTo: { ...record.sentTo, sessionID: other } }
    await h.services.write(TEAM_ID, () => h.services.registry.dispatches.put(moved))
    expect(await h.requeue()).toEqual({ ok: true, count: 1, taken: 0 })
    expect(await h.stored(h.dispatchID)).toEqual(moved)
    expect(h.core.inbox.get(OWNER_SESSION)).toEqual([])
  })
})

describe("an area held by direct work (2026-11-14)", () => {
  const held = (since: number) => (base: OwnTeam.Area) => ({ ...base, directWork: { since, at: since } })
  const SINCE = Date.UTC(2026, 9, 2, 3, 0, 0)

  test("main requests wait (a main answer after a `blocked` too); notices and the stretch's team requests go, a sync waits", async () => {
    const h = await setup({
      area: (base) => ({ ...held(SINCE)(base), status: { kind: "blocked", at: SINCE, text: "" } }),
    })
    expect(await h.dispatch("메인의 답")).toMatchObject({ state: "waiting", why: "paused", direct: true })
    const notice = await h.dispatch("알림", { from: "team", kind: "notice" })
    expect(notice).toMatchObject({ state: "queued" })
    expect(h.core.prompts().map((prompt) => prompt.body.text)).toEqual([expect.stringContaining("알림")])
    // The notice went in and its run ended.
    h.core.inbox.set(OWNER_SESSION, [])
    expect(await h.dispatch("합쳐 주세요", { from: "team", kind: "sync" })).toMatchObject({
      state: "waiting",
      why: "paused",
      direct: true,
    })
    // A conflict of an integration the user started during the stretch goes ahead of the older waiting ones.
    h.clock.advance(1_000)
    expect(await h.dispatch("충돌을 풀어 주세요", { from: "team", kind: "conflict" })).toMatchObject({
      state: "queued",
    })
    expect(h.core.prompts()).toHaveLength(2)
    expect(await h.services.registry.dispatches.waiting(TEAM_ID, AREA)).toHaveLength(2)
  })

  test("a team request older than the stretch waits for the hand-back", async () => {
    const h = await setup({ area: held(SINCE + 1) })
    const dispatchID = OwnTeam.DispatchID.create()
    await h.services.write(TEAM_ID, () =>
      h.services.registry.dispatches.put({
        id: dispatchID,
        teamID: TEAM_ID,
        areaID: AREA,
        seq: 0,
        from: "team",
        kind: "conflict",
        text: "충돌",
        state: "waiting",
        createdAt: SINCE,
      }),
    )
    await h.services.features().admit.drain({ teamID: TEAM_ID, areaID: AREA })
    expect(await h.stored(dispatchID)).toMatchObject({ state: "waiting" })
    expect(h.core.prompts()).toHaveLength(0)
  })

  test("a conflict asked during the stretch by an integration started before it waits for the hand-back", async () => {
    const h = await setup({ area: held(SINCE) })
    h.clock.advance(1_000)
    const asked = await h.dispatch("충돌을 풀어 주세요", { from: "team", kind: "conflict", origin: SINCE - 1 })
    expect(asked).toMatchObject({ state: "waiting", why: "paused", direct: true })
    expect(h.core.prompts()).toHaveLength(0)
    if (!asked.ok) throw new Error("not dispatched")
    expect(await h.stored(asked.dispatchID)).toMatchObject({ origin: SINCE - 1 })
  })

  test("direct work that starts while the checks run is seen at the safe point: the request waits", async () => {
    const h = await setup()
    const listed = `GET /api/session/${OWNER_SESSION}/inbox`
    const original = h.service.routes.get(listed)!
    // The user's message lands while the outbox reads the owner's queue (the prompt hook's write).
    h.service.routes.set(listed, async (request) => {
      h.service.routes.set(listed, original)
      await h.services.write(TEAM_ID, async () => {
        const current = await h.services.registry.areas.get(TEAM_ID, AREA)
        if (current) await h.services.registry.areas.put(held(h.clock.now())(current))
      })
      return original(request)
    })
    expect(await h.dispatch("a")).toMatchObject({ state: "waiting", why: "paused", direct: true })
    expect(h.core.prompts()).toHaveLength(0)
  })

  test("a user message that lands while the request is being sent steers it: no direct work starts", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home, directHold: true })))
    const route = `POST /api/session/${OWNER_SESSION}/prompt`
    const original = h.service.routes.get(route)!
    // The user's message reaches the prompt hook after the safe-point re-check, before the request is recorded sent.
    h.service.routes.set(route, async (request) => {
      h.service.routes.set(route, original)
      await h.services.features().direct.note({ teamID: TEAM_ID, areaID: AREA, sessionID: OWNER_SESSION })
      return original(request)
    })
    expect(await h.dispatch("a")).toMatchObject({ state: "queued" })
    const after = await h.services.registry.areas.get(TEAM_ID, AREA)
    expect(after?.direct?.sessionID).toBe(OWNER_SESSION)
    expect(after?.directWork).toBeUndefined()
    // The mark ends with the send: the request is recorded sent and counts as served from there on (`Direct.serving`).
    h.clock.advance(Direct.FOLD_LAG_MS)
    h.core.inbox.set(OWNER_SESSION, [])
    await h.services.features().direct.note({ teamID: TEAM_ID, areaID: AREA, sessionID: OWNER_SESSION })
    expect((await h.services.registry.areas.get(TEAM_ID, AREA))?.directWork).toEqual({
      since: h.clock.now(),
      at: h.clock.now(),
    })
  })

  test("a notice the outbox is sending does not keep the owner serving", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home, directHold: true })))
    const route = `POST /api/session/${OWNER_SESSION}/prompt`
    const original = h.service.routes.get(route)!
    h.service.routes.set(route, async (request) => {
      h.service.routes.set(route, original)
      await h.services.features().direct.note({ teamID: TEAM_ID, areaID: AREA, sessionID: OWNER_SESSION })
      return original(request)
    })
    expect(await h.dispatch("알림", { from: "team", kind: "notice" })).toMatchObject({ state: "queued" })
    expect((await h.services.registry.areas.get(TEAM_ID, AREA))?.directWork).toBeDefined()
  })

  test("the wait's `since` starts again when its cause changes from Main 멈춤 to direct work", async () => {
    const h = await setup({ area: (base) => ({ ...base, paused: "user" }) })
    const created = h.clock.now()
    await h.dispatch("a")
    const waited = () => h.services.features().admit.waited!({ teamID: TEAM_ID, areaID: AREA })
    expect(await waited()).toEqual({ why: "paused", since: created })
    h.clock.advance(5_000)
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, AREA)
      if (current) await h.services.registry.areas.put({ ...held(h.clock.now())(current), paused: false })
    })
    await h.services.features().admit.drain({ teamID: TEAM_ID, areaID: AREA })
    expect(await waited()).toEqual({ why: "paused", since: h.clock.now(), cause: { direct: true } })
  })

  test("team_dispatch tells the main to say one line, or to take the area back when the user asked", async () => {
    const h = await setup({ area: held(SINCE) })
    const found = await h.services.registry.teams.get(TEAM_ID)
    if (!found) throw new Error("no team")
    const caller = { role: "main" as const, team: found, sessionID: MAIN_SESSION }
    expect(await DispatchTool.run(h.services, caller, { area: "ui", text: "버튼 색" })).toMatchObject({
      ok: true,
      state: "waiting",
      why: "paused",
      text: DispatchTool.WAITING_DIRECT("ui"),
    })
  })
})

describe("team_dispatch", () => {
  test("answers queued or waiting with the reason in plain words", async () => {
    const h = await setup()
    const found = await h.services.registry.teams.get(TEAM_ID)
    if (!found) throw new Error("no team")
    const caller = { role: "main" as const, team: found, sessionID: MAIN_SESSION }
    const first = await DispatchTool.run(h.services, caller, { area: "ui", text: "첫 요청", task: "t" })
    expect(first).toMatchObject({ ok: true, state: "queued", text: "ui: 담당 대화에 넣었습니다." })
    const second = await DispatchTool.run(h.services, caller, { area: "ar_ui", text: "둘째 요청" })
    expect(second).toMatchObject({ ok: true, state: "waiting", why: "queued" })
    expect(second.text).toContain("대기함")
    expect(await DispatchTool.run(h.services, caller, { area: "none", text: "x" })).toMatchObject({ ok: false })
  })
})
