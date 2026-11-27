// Catch-up and session events (06 §5.5, §5.7, §2.6 수명의 한계 (c)): each main and owner log is folded after its
// KV cursor when the controller starts, when an instance appears and on live events; a restart neither loses nor
// repeats a wake reason. Owner runs update the area status (작업 중, 실패, 한도 대기, 답을 기다림), a received request
// without a report folds `끝났지만 보고 없음`, the last `done` makes `모두 끝남`, and a user stop turns Main 멈춤 on.

import { afterAll, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { OwnTeam } from "@own/protocol"
import { MsgID } from "../../src/dispatch/msg-id.js"
import type { Hub } from "../../src/hub.js"
import { Keys } from "../../src/registry/keys.js"
import { Cursor } from "../../src/report/cursor.js"
import { Digest } from "../../src/report/digest.js"
import { Fold } from "../../src/report/fold.js"
import { Texts } from "../../src/report/texts.js"
import { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OWNER_SESSION, TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { type FakeService, start } from "../support/service.js"

const services: FakeService[] = []
const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
afterAll(async () => {
  for (const service of services) await service.stop()
  for (const home of homes) await home[Symbol.asyncDispose]()
})

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)
const AREA = OwnTeam.AreaID.make("ar_inventory")

interface InboxItem {
  readonly id: string
  readonly sessionID: string
  readonly type: "user" | "synthetic"
  readonly delivery: "steer" | "queue"
  readonly payload: { readonly text: string; readonly metadata?: Readonly<Record<string, unknown>> }
}

/** The parts of the own service own.team reads: durable logs, inboxes, active runs, permissions, synthetic. */
class Core {
  readonly logs = new Map<string, Array<Record<string, unknown>>>()
  readonly inboxes = new Map<string, InboxItem[]>()
  readonly active = new Set<string>()
  readonly permissions = new Map<string, string[]>()
  readonly synthetic: Array<{ readonly sessionID: string; readonly body: Record<string, unknown> }> = []
  readonly reads: Array<{ readonly sessionID: string; readonly after: string | undefined }> = []
  failSynthetic = 0
  /** `false`: like the local server (core `events.persist` off), the log answers only the watermark. */
  persist = true

  constructor(readonly service: FakeService) {
    service.routes.set("GET /api/session/active", () =>
      Response.json({ data: Object.fromEntries([...this.active].map((id) => [id, { type: "running" }])) }),
    )
  }

  session(id: string) {
    this.logs.set(id, [])
    this.inboxes.set(id, [])
    this.service.routes.set(`GET /api/experimental/session/${id}/log`, (request) => {
      this.reads.push({ sessionID: id, after: request.query.after })
      const after = request.query.after === undefined ? -1 : Number(request.query.after)
      const items = this.persist ? (this.logs.get(id) ?? []).filter((item) => seqOf(item) > after) : []
      const last = (this.logs.get(id) ?? []).at(-1)
      const synced = { type: "log.synced", aggregateID: id, ...(last ? { seq: seqOf(last) } : {}) }
      return new Response([...items, synced].map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    })
    this.service.routes.set(`GET /api/session/${id}/inbox`, () => Response.json({ data: this.inboxes.get(id) ?? [] }))
    this.service.routes.set(`GET /api/session/${id}/permission`, () =>
      Response.json({
        data: (this.permissions.get(id) ?? []).map((permission) => ({ id: permission, sessionID: id })),
      }),
    )
    this.service.routes.set(`POST /api/session/${id}/synthetic`, (request) => {
      if (this.failSynthetic > 0) {
        this.failSynthetic--
        return Response.json({ _tag: "Unavailable", message: "down" }, { status: 503 })
      }
      // SAFETY (test): own.team sends a JSON object body.
      const body = request.body as Record<string, unknown>
      this.synthetic.push({ sessionID: id, body })
      const inbox = this.inboxes.get(id) ?? []
      const existing = inbox.find((item) => item.id === body.id)
      if (existing) return Response.json({ data: existing })
      const item: InboxItem = {
        id: String(body.id),
        sessionID: id,
        type: "synthetic",
        delivery: "queue",
        // SAFETY (test): the metadata own.team sends is an object.
        payload: { text: String(body.text), metadata: body.metadata as Record<string, unknown> },
      }
      this.inboxes.set(id, [...inbox, item])
      return Response.json({ data: item })
    })
  }

  /** Appends a durable event to the session's log and returns it (to publish live). */
  event(sessionID: string, type: string, data: Record<string, unknown>, created: number): Hub.Incoming {
    const log = this.logs.get(sessionID) ?? []
    const item = {
      id: `evt_${sessionID}_${log.length + 1}`,
      created,
      type,
      durable: { aggregateID: sessionID, seq: log.length + 1, version: 1 },
      data: { sessionID, ...data },
    }
    this.logs.set(sessionID, [...log, item])
    // SAFETY (test): the item has the durable event shape of `type`.
    return item as unknown as Hub.Incoming
  }

  /** A main request admitted to and delivered from the owner's inbox. */
  receive(sessionID: string, dispatchID: OwnTeam.DispatchID, at: number) {
    const inboxID = MsgID.dispatch(dispatchID, sessionID)
    this.event(
      sessionID,
      "session.inbox.enqueued",
      {
        inboxID,
        item: {
          type: "user",
          delivery: "queue",
          payload: {
            text: "<dispatch>…</dispatch>",
            metadata: {
              [OwnTeam.DISPATCH_META]: { id: dispatchID, from: "main", teamID: TEAM_ID, areaID: AREA },
              source: OwnTeam.PROMPT_SOURCE,
            },
          },
        },
      },
      at,
    )
    this.event(sessionID, "session.inbox.delivered", { inboxID }, at + 1)
    return inboxID
  }

  /** The main delivered (or the user cancelled) its pending team update. */
  deliver(sessionID: string, inboxID: string, at: number) {
    this.inboxes.set(
      sessionID,
      (this.inboxes.get(sessionID) ?? []).filter((item) => item.id !== inboxID),
    )
    return this.event(sessionID, "session.inbox.delivered", { inboxID }, at)
  }
}

function seqOf(item: Record<string, unknown>) {
  // SAFETY (test): every logged item has the durable envelope.
  return (item.durable as { seq: number }).seq
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

async function setup(
  input: { readonly world?: World; readonly core?: Core; readonly clock?: ReturnType<typeof manual> } = {},
) {
  const home = await tempHome()
  homes.push(home)
  const world = input.world ?? new World()
  const clock = input.clock ?? manual(T0)
  const core =
    input.core ??
    (() => {
      const service = start()
      services.push(service)
      const created = new Core(service)
      created.session(MAIN_SESSION)
      created.session(OWNER_SESSION)
      return created
    })()
  const stopped: Array<{ readonly teamID: string; readonly areaID: string; readonly sessionID: string }> = []
  const harness = controller(world, {
    directory: home.root,
    clock,
    source: core.service.source,
    features: {
      pause: () => ({
        area: async () => Services.unsupported("pause"),
        team: async () => Services.unsupported("pause"),
        stopped: async (stop) => {
          stopped.push(stop)
        },
      }),
    },
  })
  if (!input.world)
    await harness.services.write(TEAM_ID, async () => {
      await harness.services.registry.teams.put(team({ home: home.root }))
      await harness.services.registry.areas.put(area({ slug: "inventory", directory: `${home.root}-team/inventory` }))
    })
  const flush = async () => {
    await harness.services.write(TEAM_ID, async () => {})
    await Bun.sleep(20)
    await harness.services.write(TEAM_ID, async () => {})
  }
  // The resumes of attach and start (catch-up included) end before the test acts.
  await harness.controller.resume()
  return { world, clock, core, stopped, flush, home: home.root, ...harness }
}

type Harness = Awaited<ReturnType<typeof setup>>

const digest = (h: Harness) => Digest.load(h.services.kv, TEAM_ID)
const status = async (h: Harness) => (await h.services.registry.areas.get(TEAM_ID, AREA))?.status

/** A main request recorded as sent to the owner (what the outbox writes, 06 §5.1). */
async function sent(h: Harness, dispatchID: OwnTeam.DispatchID, at: number) {
  await h.services.write(TEAM_ID, () =>
    h.services.registry.dispatches.put({
      id: dispatchID,
      teamID: TEAM_ID,
      areaID: AREA,
      seq: 0,
      from: "main",
      kind: "task",
      text: "인벤토리 정렬",
      state: "sent",
      sentTo: {
        sessionID: OWNER_SESSION,
        msgID: SessionMessage.ID.make(MsgID.dispatch(dispatchID, OWNER_SESSION)),
        at,
      },
      createdAt: at,
    }),
  )
}

describe("catch-up after the cursor", () => {
  test("folds an owner's log once, in order, and keeps the cursor at the last seq", async () => {
    const h = await setup()
    const dispatchID = OwnTeam.DispatchID.create()
    h.core.receive(OWNER_SESSION, dispatchID, T0)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 2)
    h.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "provider down" } }, T0 + 3)
    await h.services.features().events.catchUp(TEAM_ID)
    const state = await digest(h)
    expect(state.entries.map((item) => [item.reason, item.text, item.key])).toEqual([
      ["failed", "실행 실패: provider down", `${OWNER_SESSION}:4`],
    ])
    expect(Fold.area(state, AREA).received?.dispatchID).toBe(dispatchID)
    expect(await status(h)).toMatchObject({ kind: "failed", text: "provider down", at: T0 + 3 })
    expect(await Cursor.get(h.services.kv, OWNER_SESSION)).toBe(4)

    await h.services.features().events.catchUp(TEAM_ID)
    expect((await digest(h)).entries).toHaveLength(1)
    expect(h.core.reads.filter((read) => read.sessionID === OWNER_SESSION).at(-1)?.after).toBe("4")
    await h.close()
  })

  test("a live event of an owner reads its log after the cursor (and a main's run alone does not)", async () => {
    const h = await setup()
    await h.services.features().events.catchUp(TEAM_ID)
    const reads = h.core.reads.length
    h.core.active.add(OWNER_SESSION)
    h.services.hub.receive(h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 5))
    await until(async () => (await status(h))?.kind === "busy")
    expect(await Cursor.get(h.services.kv, OWNER_SESSION)).toBe(1)
    h.services.hub.receive(h.core.event(MAIN_SESSION, "session.execution.started", {}, T0 + 6))
    await h.flush()
    expect(h.core.reads.slice(reads).map((read) => read.sessionID)).toEqual([OWNER_SESSION])
    await h.close()
  })

  test("folds live events once when the server keeps no event rows (only the log.synced watermark)", async () => {
    const h = await setup()
    h.core.persist = false
    await h.services.features().events.catchUp(TEAM_ID)
    h.core.active.add(OWNER_SESSION)
    h.services.hub.receive(h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 5))
    await until(async () => (await status(h))?.kind === "busy")
    h.core.active.delete(OWNER_SESSION)
    const failed = h.core.event(
      OWNER_SESSION,
      "session.execution.failed",
      { error: { type: "x", message: "down" } },
      T0 + 6,
    )
    h.services.hub.receive(failed)
    await until(async () => (await status(h))?.kind === "failed")
    expect((await digest(h)).entries.map((item) => [item.reason, item.key])).toEqual([["failed", `${OWNER_SESSION}:2`]])
    expect(await Cursor.get(h.services.kv, OWNER_SESSION)).toBe(2)
    // The same event again (another instance's stream) is not folded twice.
    h.services.hub.receive(failed)
    await h.flush()
    expect((await digest(h)).entries).toHaveLength(1)
    await h.close()
  })

  test("a restart loses no event and repeats no wake reason (TG8)", async () => {
    const clock = manual(T0)
    const first = await setup({ clock })
    first.core.event(OWNER_SESSION, "session.execution.started", {}, T0)
    first.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "boom" } }, T0 + 1)
    await first.services.features().events.catchUp(TEAM_ID)
    // The controller goes away before the 30 s debounce ends; nothing is sent.
    await first.close()
    expect(first.core.synthetic).toHaveLength(0)

    // While nobody listens the owner runs again and fails again.
    first.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 10_000)
    first.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "again" } }, T0 + 10_001)

    const second = await setup({ world: first.world, core: first.core, clock })
    await second.controller.resume()
    expect((await digest(second)).entries.map((item) => item.text)).toEqual(["실행 실패: boom", "실행 실패: again"])
    // Debounced from the last waking event (T0 + 10 001).
    clock.advance(30_000)
    await second.flush()
    expect(first.core.synthetic).toHaveLength(0)
    clock.advance(15_000)
    await second.flush()
    expect(first.core.synthetic).toHaveLength(1)
    const body = first.core.synthetic[0]?.body
    expect(body).toMatchObject({
      id: MsgID.of(TEAM_ID, "wake", 1),
      delivery: "queue",
      metadata: { [OwnTeam.UPDATE_META]: { seq: 1, reasons: ["failed"] }, source: OwnTeam.PROMPT_SOURCE },
    })
    await second.close()

    // A third controller has nothing left to tell: the reasons went out with update 1.
    const third = await setup({ world: first.world, core: first.core, clock })
    await third.controller.resume()
    clock.advance(10 * 60_000)
    await third.flush()
    expect(first.core.synthetic).toHaveLength(1)
    expect((await digest(third)).entries).toHaveLength(0)
    await third.close()
  })

  test("a crash between the write-ahead and the send retries the same id; core keeps the first admission", async () => {
    const clock = manual(T0)
    const first = await setup({ clock })
    first.core.failSynthetic = 1
    await first.services.features().digest.add(TEAM_ID, Fold.entry({ at: T0, reason: "ready", text: "", areaID: AREA }))
    await first.flush()
    clock.advance(30_000)
    await first.flush()
    expect((await digest(first)).pending).toMatchObject({ seq: 1, sent: false })
    await first.close()

    const second = await setup({ world: first.world, core: first.core, clock })
    await second.controller.resume()
    clock.advance(Fold.RETRY_MS)
    await second.flush()
    expect(first.core.synthetic.map((item) => item.body.id)).toEqual([MsgID.of(TEAM_ID, "wake", 1)])
    expect(first.core.inboxes.get(MAIN_SESSION)).toHaveLength(1)
    expect((await digest(second)).pending).toMatchObject({ seq: 1, sent: true })
    await second.close()
  })

  test("the main's delivered update lets the next one go (read from the main log)", async () => {
    const clock = manual(T0)
    const h = await setup({ clock })
    await h.services.features().digest.add(TEAM_ID, Fold.entry({ at: T0, reason: "ready", text: "", areaID: AREA }))
    await h.flush()
    clock.advance(30_000)
    await h.flush()
    await h.services
      .features()
      .digest.add(TEAM_ID, Fold.entry({ at: clock.now(), reason: "blocked", text: "", areaID: AREA }))
    await h.flush()
    clock.advance(60_000)
    await h.flush()
    expect(h.core.synthetic).toHaveLength(1)
    h.services.hub.receive(h.core.deliver(MAIN_SESSION, MsgID.of(TEAM_ID, "wake", 1), clock.now()))
    await until(async () => (await digest(h)).pending === null)
    await h.flush()
    clock.advance(0)
    await h.flush()
    expect(h.core.synthetic.map((item) => item.body.id)).toEqual([
      MsgID.of(TEAM_ID, "wake", 1),
      MsgID.of(TEAM_ID, "wake", 2),
    ])
    await h.close()
  })
})

describe("owner runs (06 §5.5)", () => {
  test("끝났지만 보고 없음: a received request and an idle owner without a report folds once, without waking", async () => {
    const h = await setup()
    const dispatchID = OwnTeam.DispatchID.create()
    await sent(h, dispatchID, T0)
    h.core.receive(OWNER_SESSION, dispatchID, T0)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 2)
    h.core.event(OWNER_SESSION, "session.execution.succeeded", {}, T0 + 3)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 4)
    h.core.event(OWNER_SESSION, "session.execution.succeeded", {}, T0 + 5)
    await h.services.features().events.catchUp(TEAM_ID)
    const state = await digest(h)
    expect(state.entries.map((item) => [item.reason, item.text, item.wake])).toEqual([
      ["unreported", "끝났지만 보고 없음", false],
    ])
    expect(Fold.due(state)).toBeUndefined()
    expect(await status(h)).toMatchObject({ kind: "idle" })
    await h.close()
  })

  test("모두 끝남: the last done of the batch wakes the main once the owner is idle", async () => {
    const h = await setup()
    const dispatchID = OwnTeam.DispatchID.create()
    await sent(h, dispatchID, T0)
    h.core.receive(OWNER_SESSION, dispatchID, T0)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 2)
    await h.services.features().events.catchUp(TEAM_ID)
    h.core.active.add(OWNER_SESSION)
    const reported = await h.services.features().events.report({
      teamID: TEAM_ID,
      areaID: AREA,
      sessionID: OWNER_SESSION,
      kind: "done",
      text: "정렬 고침",
    })
    expect(reported).toMatchObject({ ok: true })
    expect(Fold.reasons(await digest(h))).toEqual([])
    h.core.active.delete(OWNER_SESSION)
    h.services.hub.receive(h.core.event(OWNER_SESSION, "session.execution.succeeded", {}, T0 + 10))
    await until(async () => Fold.reasons(await digest(h)).includes("all-done"))
    const state = await digest(h)
    expect(state.entries.filter((item) => item.reason === "all-done")).toHaveLength(1)
    expect(state.allDone).toBeDefined()
    // Another idle boundary without new work is not a second 모두 끝남.
    h.services.hub.receive(h.core.event(OWNER_SESSION, "session.execution.succeeded", {}, T0 + 20))
    await until(async () => (await Cursor.get(h.services.kv, OWNER_SESSION)) === 5)
    await h.flush()
    expect((await digest(h)).entries.filter((item) => item.reason === "all-done")).toHaveLength(1)
    await h.close()
  })

  test("a failed run while own-accounts says BLOCKED is 한도 대기 and does not wake", async () => {
    const h = await setup()
    const reset = T0 + 3_600_000
    h.world.accounts.set("switch.state", () => ({ state: "BLOCKED", reason: "all_exhausted", nextResetAt: reset }))
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0)
    h.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "429" } }, T0 + 1)
    await h.services.features().events.catchUp(TEAM_ID)
    expect(await status(h)).toMatchObject({ kind: "waiting-quota", until: reset })
    expect((await digest(h)).entries).toEqual([])
    // own-accounts leaves BLOCKED: the area settles.
    h.services.hub.receive({
      id: "evt_switch",
      created: T0 + 5,
      type: `rpc.own.accounts.switch.state`,
      location: { directory: h.home },
      data: {
        eventId: "01JAX00000000000000000000A",
        origin: "global",
        sessionID: OWNER_SESSION,
        state: "STEADY",
        detail: { state: "STEADY" },
      },
      // SAFETY (test): an own.accounts RPC event as the bus carries it.
    } as unknown as Hub.Incoming)
    await until(async () => (await status(h))?.kind === "idle")
    await h.close()
  })

  test("a user stop of the owner turns Main 멈춤 on (pause.stopped); a shutdown does not", async () => {
    const h = await setup()
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0)
    h.core.event(OWNER_SESSION, "session.execution.interrupted", { reason: "shutdown" }, T0 + 1)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 2)
    h.core.event(OWNER_SESSION, "session.execution.interrupted", { reason: "user" }, T0 + 3)
    await h.services.features().events.catchUp(TEAM_ID)
    expect(h.stopped).toEqual([{ teamID: TEAM_ID, areaID: AREA, sessionID: OWNER_SESSION }])
    expect(await status(h)).toMatchObject({ kind: "idle" })
    await h.close()
  })

  test("a pending permission is 답을 기다림 live, and found again after a restart", async () => {
    const h = await setup()
    h.core.active.add(OWNER_SESSION)
    h.services.hub.receive(h.core.event(OWNER_SESSION, "session.execution.started", {}, T0))
    await until(async () => (await status(h))?.kind === "busy")
    h.core.permissions.set(OWNER_SESSION, ["per_1"])
    h.services.hub.receive({
      id: "evt_perm",
      created: T0 + 1,
      type: "permission.asked",
      data: { id: "per_1", sessionID: OWNER_SESSION, action: "bash", resources: ["git push"] },
      // SAFETY (test): an ephemeral permission event.
    } as unknown as Hub.Incoming)
    await until(async () => (await status(h))?.kind === "asking")
    h.core.permissions.delete(OWNER_SESSION)
    h.services.hub.receive({
      id: "evt_reply",
      created: T0 + 2,
      type: "permission.replied",
      data: { sessionID: OWNER_SESSION, requestID: "per_1", reply: "once" },
      // SAFETY (test): an ephemeral permission event.
    } as unknown as Hub.Incoming)
    await until(async () => (await status(h))?.kind === "busy")
    await h.close()

    // After a restart the ephemeral question is gone from the stream; the permission list still has it.
    h.core.permissions.set(OWNER_SESSION, ["per_2"])
    const again = await setup({ world: h.world, core: h.core, clock: h.clock })
    await again.controller.resume()
    expect(await status(again)).toMatchObject({ kind: "asking" })
    await again.close()
  })

  test("events of a session that is not a current main or owner are not read", async () => {
    const h = await setup()
    const stranger = SessionID.make("ses_stranger000000000000000001")
    h.core.session(stranger)
    h.services.hub.receive(
      h.core.event(stranger, "session.execution.failed", { error: { type: "x", message: "x" } }, T0),
    )
    await h.flush()
    expect(h.core.reads.filter((read) => read.sessionID === stranger)).toEqual([])
    expect(await h.services.kv.get(Keys.cursor(stranger))).toBeUndefined()
    await h.close()
  })
})

describe("direct work (직접 작업, 2026-11-14)", () => {
  /** The area held by direct work since `since`. */
  async function hold(h: Harness, since: number) {
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, AREA)
      if (current) await h.services.registry.areas.put({ ...current, directWork: { since, at: since } })
    })
  }

  test("a run that ends records the request it served (`ended`); a limit block does not", async () => {
    const h = await setup()
    const first = OwnTeam.DispatchID.create()
    h.core.receive(OWNER_SESSION, first, T0)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 2)
    h.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "provider down" } }, T0 + 3)
    await h.services.features().events.catchUp(TEAM_ID)
    expect(Fold.area(await digest(h), AREA).ended).toBe(first)
    const second = OwnTeam.DispatchID.create()
    h.core.receive(OWNER_SESSION, second, T0 + 10)
    h.core.event(OWNER_SESSION, "session.execution.succeeded", {}, T0 + 12)
    await h.services.features().events.catchUp(TEAM_ID)
    expect(Fold.area(await digest(h), AREA).ended).toBe(second)

    const g = await setup()
    g.world.accounts.set("switch.state", () => ({ state: "BLOCKED", reason: "all_exhausted", nextResetAt: T0 + 1 }))
    g.core.receive(OWNER_SESSION, first, T0)
    g.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "429" } }, T0 + 3)
    await g.services.features().events.catchUp(TEAM_ID)
    expect(Fold.area(await digest(g), AREA).ended).toBeUndefined()
    await h.close()
    await g.close()
  })

  test("a failed run of a held area that served no request is kept for the hand-back and wakes nobody", async () => {
    const h = await setup()
    await hold(h, T0 - 1_000)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0)
    h.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "provider down" } }, T0 + 1)
    await h.services.features().events.catchUp(TEAM_ID)
    const state = await digest(h)
    expect(state.entries.map((item) => [item.reason, item.wake])).toEqual([["failed", false]])
    expect(Fold.due(state)).toBeUndefined()
    expect(Fold.area(state, AREA).stretch).toMatchObject({ since: T0 - 1_000, n: 1, kinds: { failed: 1 } })
    expect((await Texts.loadStretch(h.services.kv, h.services.log, TEAM_ID, AREA))?.items).toEqual([
      { kind: "failed", text: "실행 실패: provider down", at: T0 + 1 },
    ])
    // Folded again (another instance's stream), it is kept once.
    await h.services.features().events.catchUp(TEAM_ID)
    expect((await Texts.loadStretch(h.services.kv, h.services.log, TEAM_ID, AREA))?.items).toHaveLength(1)
    // The main's line leaves the failure out while the area is held; 할 일 has nothing for it.
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(text).toContain("직접 작업 중(")
    expect(text).toContain("모아 둔 보고 1개")
    expect(text).not.toContain("실행 실패")
    expect(text).not.toContain("할 일:")
    await h.close()
  })

  test("a failed run of a held area that served a main request wakes the main as before", async () => {
    const h = await setup()
    await hold(h, T0 - 1_000)
    const dispatchID = OwnTeam.DispatchID.create()
    await sent(h, dispatchID, T0)
    h.core.receive(OWNER_SESSION, dispatchID, T0)
    h.core.event(OWNER_SESSION, "session.execution.started", {}, T0 + 2)
    h.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "provider down" } }, T0 + 3)
    await h.services.features().events.catchUp(TEAM_ID)
    const state = await digest(h)
    expect(state.entries.map((item) => [item.reason, item.wake])).toEqual([["failed", true]])
    // Still part of the stretch: the hand-back counts it.
    expect(Fold.area(state, AREA).stretch).toMatchObject({ n: 1, kinds: { failed: 1 } })
    await h.close()
  })

  test("a failed run of an area without direct work keeps no stretch", async () => {
    const h = await setup()
    h.core.event(OWNER_SESSION, "session.execution.failed", { error: { type: "x", message: "down" } }, T0 + 1)
    await h.services.features().events.catchUp(TEAM_ID)
    expect(Fold.area(await digest(h), AREA).stretch).toBeUndefined()
    expect(await Texts.loadStretch(h.services.kv, h.services.log, TEAM_ID, AREA)).toBeUndefined()
    await h.close()
  })
})
