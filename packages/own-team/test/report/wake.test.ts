// Waking the main (06 §5.6, TG8 unit level): a `session.synthetic` team update after a 30 s debounce with id
// `msgID(teamID, "wake", seq)`, metadata `own.team.update` and source `own.team`, delivery `queue`; at most one
// undelivered in the main inbox; past 12 an hour updates wait (and the user is told); timers come back from KV after
// a restart; a replaced main gets the next number; nothing goes while the team is off.

import { afterAll, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { OwnTeam } from "@own/protocol"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Talk } from "../../src/dispatch/talk.js"
import type { Hub } from "../../src/hub.js"
import { Digest } from "../../src/report/digest.js"
import { Fold } from "../../src/report/fold.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OWNER_SESSION, TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { type FakeService, type Recorded, start } from "../support/service.js"

const services: FakeService[] = []
const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
afterAll(async () => {
  for (const service of services) await service.stop()
  for (const home of homes) await home[Symbol.asyncDispose]()
})

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0)
const AREA = OwnTeam.AreaID.make("ar_inventory")
const NEW_MAIN = SessionID.make("ses_main0000000000000000000002")

interface Item {
  readonly id: string
  readonly sessionID: string
  readonly type: "synthetic" | "reset"
  readonly delivery: "queue"
  readonly payload: { readonly text?: string; readonly metadata?: Readonly<Record<string, unknown>> }
}

/** Inboxes and `session.synthetic` of the own service, with switches to fail them. */
class Core {
  readonly inboxes = new Map<string, Item[]>()
  readonly synthetic: Recorded[] = []
  failInbox = false

  constructor(readonly service: FakeService) {
    for (const id of [MAIN_SESSION, NEW_MAIN, OWNER_SESSION]) this.session(id)
  }

  session(id: string) {
    this.inboxes.set(id, [])
    this.service.routes.set(`GET /api/session/${id}/inbox`, () =>
      this.failInbox
        ? Response.json({ _tag: "Unavailable", message: "down" }, { status: 503 })
        : Response.json({ data: this.inboxes.get(id) ?? [] }),
    )
    this.service.routes.set(`POST /api/session/${id}/synthetic`, (request) => {
      this.synthetic.push(request)
      // SAFETY (test): own.team sends a JSON object body.
      const body = request.body as { id: string; text: string; metadata?: Record<string, unknown> }
      const inbox = this.inboxes.get(id) ?? []
      const existing = inbox.find((item) => item.id === body.id)
      if (existing) return Response.json({ data: existing })
      const item: Item = {
        id: body.id,
        sessionID: id,
        type: "synthetic",
        delivery: "queue",
        payload: { text: body.text, ...(body.metadata ? { metadata: body.metadata } : {}) },
      }
      this.inboxes.set(id, [...inbox, item])
      return Response.json({ data: item })
    })
  }

  /** The main took the update into its conversation, without own.team seeing the event. */
  take(id: string) {
    this.inboxes.set(id, [])
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
      return new Core(service)
    })()
  const harness = controller(world, { directory: home.root, clock, source: core.service.source })
  if (!input.world)
    await harness.services.write(TEAM_ID, async () => {
      await harness.services.registry.teams.put(team({ home: home.root }))
      await harness.services.registry.areas.put(area({ slug: "inventory", directory: `${home.root}-team/inventory` }))
    })
  // Lets the wake plan its timer (it reads KV) or a fired send finish, before the clock moves again.
  const flush = async () => {
    await harness.services.write(TEAM_ID, async () => {})
    await Bun.sleep(20)
    await harness.services.write(TEAM_ID, async () => {})
  }
  await harness.controller.resume()
  const add = async (reason: Fold.Reason, at = clock.now()) => {
    await harness.services.features().digest.add(TEAM_ID, Fold.entry({ at, reason, text: "", areaID: AREA }))
    await flush()
  }
  const advance = async (ms: number) => {
    clock.advance(ms)
    await flush()
  }
  return { world, clock, core, flush, add, advance, home: home.root, ...harness }
}

const body = (recorded: Recorded | undefined) =>
  // SAFETY (test): own.team sends a JSON object body.
  recorded?.body as { id: string; text: string; delivery: string; metadata: Record<string, unknown> } | undefined

describe("a team update (06 §5.6)", () => {
  test("ready wakes the main once, 30 s later, with the update message", async () => {
    const h = await setup()
    await h.add("ready")
    await h.advance(29_999)
    expect(h.core.synthetic).toHaveLength(0)
    await h.advance(1)
    expect(h.core.synthetic).toHaveLength(1)
    const sent = h.core.synthetic[0]
    expect(sent?.query["location[directory]"]).toBe(h.home)
    expect(body(sent)).toMatchObject({
      id: MsgID.of(TEAM_ID, "wake", 1),
      delivery: "queue",
      metadata: { [OwnTeam.UPDATE_META]: { seq: 1, reasons: ["ready"] }, source: OwnTeam.PROMPT_SOURCE },
    })
    const text = body(sent)?.text ?? ""
    expect(text.startsWith('<team-update seq="1" reason="ready">\n')).toBe(true)
    expect(text.endsWith("\n</team-update>")).toBe(true)
    expect(Digest.tokens(text)).toBeLessThanOrEqual(Digest.MAX_TOKENS)
    expect(await Digest.load(h.services.kv, TEAM_ID)).toMatchObject({
      seq: 1,
      entries: [],
      pending: { seq: 1, sent: true, sessionID: MAIN_SESSION },
    })
    await h.advance(60 * 60_000)
    expect(h.core.synthetic).toHaveLength(1)
    await h.close()
  })

  test("area messages never wake the main; the next update carries their lines and marks them told (06 §5.8)", async () => {
    const h = await setup()
    await Talk.log(h.services, TEAM_ID, `'인벤토리 화면' → '세이브 v3 담당' 물음: "count?"`)
    await h.advance(10 * 60_000)
    expect(h.core.synthetic).toHaveLength(0)
    await h.add("ready")
    await h.advance(30_000)
    expect(body(h.core.synthetic[0])?.text).toContain(`영역 메시지 1건:\n  · `)
    const talk = await Talk.load(h.services.kv, TEAM_ID)
    expect(Talk.untold(talk)).toEqual([])
    expect(talk.told).toBe(0)
    await h.close()
  })

  test("a moved seat never wakes the main; the next update carries its line", async () => {
    const h = await setup()
    await h.services.features().digest.add(
      TEAM_ID,
      Fold.entry({
        at: h.clock.now(),
        reason: "seated",
        text: "'인벤토리' 영역의 담당이 바뀌었습니다.",
        areaID: AREA,
      }),
    )
    await h.flush()
    await h.advance(10 * 60_000)
    expect(h.core.synthetic).toHaveLength(0)
    await h.add("ready")
    await h.advance(30_000)
    expect(h.core.synthetic).toHaveLength(1)
    expect(body(h.core.synthetic[0])?.text).toContain("'인벤토리' 영역의 담당이 바뀌었습니다.")
    expect(body(h.core.synthetic[0])?.metadata[OwnTeam.UPDATE_META]).toEqual({ seq: 1, reasons: ["ready"] })
    await h.close()
  })

  test("waking events within the debounce go together; folds alone never wake the main", async () => {
    const h = await setup()
    await h.add("progress")
    await h.add("done")
    await h.add("unreported")
    await h.advance(10 * 60_000)
    expect(h.core.synthetic).toHaveLength(0)
    await h.add("failed")
    await h.advance(20_000)
    await h.add("blocked")
    await h.advance(20_000)
    expect(h.core.synthetic).toHaveLength(0)
    await h.add("failed")
    await h.advance(30_000)
    expect(h.core.synthetic.map((item) => body(item)?.metadata[OwnTeam.UPDATE_META])).toEqual([
      { seq: 1, reasons: ["failed", "blocked"] },
    ])
    await h.close()
  })

  test("at most one undelivered in the main inbox: the next waits for delivery, seen live or on a later look", async () => {
    const h = await setup()
    await h.add("ready")
    await h.advance(30_000)
    await h.add("blocked")
    await h.advance(Fold.CHECK_MS)
    // Still undelivered at the look: nothing new goes in.
    expect(h.core.synthetic).toHaveLength(1)
    expect((await Digest.load(h.services.kv, TEAM_ID)).pending?.checked).toBe(h.clock.now())
    // Delivered without own.team seeing the event: the next look finds it gone and sends the next update.
    h.core.take(MAIN_SESSION)
    await h.advance(Fold.CHECK_MS)
    expect(h.core.synthetic.map((item) => body(item)?.id)).toEqual([
      MsgID.of(TEAM_ID, "wake", 1),
      MsgID.of(TEAM_ID, "wake", 2),
    ])
    expect(body(h.core.synthetic[1])?.metadata[OwnTeam.UPDATE_META]).toEqual({ seq: 2, reasons: ["blocked"] })
    await h.close()
  })

  test("another team update already in the main inbox holds a new one back", async () => {
    const h = await setup()
    h.core.inboxes.set(MAIN_SESSION, [
      {
        id: "msg_older",
        sessionID: MAIN_SESSION,
        type: "synthetic",
        delivery: "queue",
        payload: { text: "<team-update>", metadata: { [OwnTeam.UPDATE_META]: { seq: 9, reasons: ["ready"] } } },
      },
    ])
    await h.add("ready")
    await h.advance(30_000)
    expect(h.core.synthetic).toHaveLength(0)
    h.core.take(MAIN_SESSION)
    await h.advance(Fold.CHECK_MS)
    expect(h.core.synthetic).toHaveLength(1)
    await h.close()
  })

  test("a context reset waiting in the main inbox does not hold the update: it goes in behind it (06 §6.1)", async () => {
    const h = await setup()
    h.core.inboxes.set(MAIN_SESSION, [
      { id: "msg_reset", sessionID: MAIN_SESSION, type: "reset", delivery: "queue", payload: {} },
    ])
    await h.add("ready")
    await h.advance(30_000)
    expect(h.core.synthetic).toHaveLength(1)
    expect(h.core.inboxes.get(MAIN_SESSION)?.map((item) => item.type)).toEqual(["reset", "synthetic"])
    await h.close()
  })

  test("past 12 an hour the update waits for the window, the hold shows in team_status, and the user is told", async () => {
    const h = await setup()
    const notices: Hub.Outgoing[] = []
    h.services.hub.subscribe((event) => {
      if (event.name === "notice") notices.push(event)
    })
    const sends = Array.from({ length: Fold.PER_HOUR }, (_, index) => T0 - 50 * 60_000 + index * 60_000)
    await h.services.write(TEAM_ID, async () =>
      Digest.save(h.services.kv, { ...(await Digest.load(h.services.kv, TEAM_ID)), seq: 12, sent: sends }),
    )
    await h.add("ready")
    await h.advance(30_000)
    expect(h.core.synthetic).toHaveLength(0)
    const until = T0 + 10 * 60_000
    expect((await Digest.load(h.services.kv, TEAM_ID)).limited).toEqual({ until })
    const status = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(status).toContain(`팀 소식이 한 시간에 12번을 넘어 ${Talk.clock(until)}까지 모아 둡니다`)
    expect(notices).toMatchObject([{ name: "notice", data: { kind: "wake.limited", data: { until } } }])
    await h.advance(until - h.clock.now() - 1)
    expect(h.core.synthetic).toHaveLength(0)
    await h.advance(1)
    expect(h.core.synthetic.map((item) => body(item)?.id)).toEqual([MsgID.of(TEAM_ID, "wake", 13)])
    expect((await Digest.load(h.services.kv, TEAM_ID)).limited).toBeNull()
    expect(notices).toHaveLength(1)
    await h.close()
  })
})

describe("restarts and changes", () => {
  test("timers come back from the KV digest when a controller acquires (06 §2.6 (c))", async () => {
    const clock = manual(T0)
    const first = await setup({ clock })
    await first.add("blocked")
    await first.advance(10_000)
    await first.close()
    const second = await setup({ world: first.world, core: first.core, clock })
    await second.controller.resume()
    await second.advance(19_999)
    expect(first.core.synthetic).toHaveLength(0)
    await second.advance(1)
    expect(first.core.synthetic.map((item) => body(item)?.id)).toEqual([MsgID.of(TEAM_ID, "wake", 1)])
    await second.close()
  })

  test("a failed inbox read or send is tried again after RETRY_MS", async () => {
    const h = await setup()
    h.core.failInbox = true
    await h.add("ready")
    await h.advance(30_000)
    expect(h.core.synthetic).toHaveLength(0)
    h.core.failInbox = false
    await h.advance(Fold.RETRY_MS)
    expect(h.core.synthetic).toHaveLength(1)
    await h.close()
  })

  test("a replaced main gets the next update with the next number; the old one is never sent to it", async () => {
    const h = await setup()
    await h.add("ready")
    await h.advance(30_000)
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.teams.get(TEAM_ID)
      if (current)
        await h.services.registry.teams.put({
          ...current,
          main: { sessionID: NEW_MAIN, previous: [MAIN_SESSION] },
        })
    })
    await h.add("blocked")
    await h.advance(Fold.CHECK_MS)
    expect(h.core.synthetic.map((item) => [item.path, body(item)?.id])).toEqual([
      [`/api/session/${MAIN_SESSION}/synthetic`, MsgID.of(TEAM_ID, "wake", 1)],
      [`/api/session/${NEW_MAIN}/synthetic`, MsgID.of(TEAM_ID, "wake", 2)],
    ])
    await h.close()
  })

  test("nothing wakes while the team is off", async () => {
    const h = await setup()
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.teams.get(TEAM_ID)
      if (current) await h.services.registry.teams.put({ ...current, state: "off" })
    })
    await h.add("failed")
    await h.advance(10 * 60_000)
    expect(h.core.synthetic).toHaveLength(0)
    await h.close()
  })
})

describe("direct work (직접 작업, 2026-11-14)", () => {
  /** Holds the area by direct work; `request`: a main request went to the owner just now (it serves it). */
  async function hold(h: Awaited<ReturnType<typeof setup>>, request = false) {
    await h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, AREA)
      if (current) await h.services.registry.areas.put({ ...current, directWork: { since: T0, at: h.clock.now() } })
      if (!request) return
      const id = OwnTeam.DispatchID.create()
      await h.services.registry.dispatches.put({
        id,
        teamID: TEAM_ID,
        areaID: AREA,
        seq: 1,
        from: "main",
        kind: "task",
        text: "일",
        state: "sent",
        sentTo: {
          sessionID: OWNER_SESSION,
          msgID: SessionMessage.ID.make(MsgID.dispatch(id, OWNER_SESSION)),
          at: h.clock.now(),
        },
        createdAt: h.clock.now(),
      })
    })
  }

  const blocked = (h: Awaited<ReturnType<typeof setup>>) =>
    h.services.features().events.report({
      teamID: TEAM_ID,
      areaID: AREA,
      sessionID: OWNER_SESSION,
      kind: "blocked",
      text: "결정 필요",
    })

  test("a blocked of a held area serving no request wakes nobody; the hand-back does, with it", async () => {
    const h = await setup()
    await hold(h)
    expect(await blocked(h)).toMatchObject({ ok: true })
    await h.flush()
    await h.advance(10 * 60_000)
    expect(h.core.synthetic).toHaveLength(0)
    await h.add("handed")
    await h.advance(30_000)
    expect(h.core.synthetic).toHaveLength(1)
    expect(body(h.core.synthetic[0])?.metadata[OwnTeam.UPDATE_META]).toEqual({ seq: 1, reasons: ["handed"] })
    await h.close()
  })

  test("a blocked of a held area whose owner serves a main request wakes as ever", async () => {
    const h = await setup()
    await hold(h, true)
    expect(await blocked(h)).toMatchObject({ ok: true })
    await h.flush()
    await h.advance(30_000)
    expect(h.core.synthetic).toHaveLength(1)
    expect(body(h.core.synthetic[0])?.metadata[OwnTeam.UPDATE_META]).toEqual({ seq: 1, reasons: ["blocked"] })
    await h.close()
  })

  test("a relay wakes while held; the main taking the area back does not", async () => {
    const h = await setup()
    await hold(h)
    await h.add("taken")
    await h.advance(10 * 60_000)
    expect(h.core.synthetic).toHaveLength(0)
    await h.add("relay")
    await h.advance(30_000)
    expect(body(h.core.synthetic[0])?.metadata[OwnTeam.UPDATE_META]).toEqual({ seq: 1, reasons: ["relay"] })
    await h.close()
  })
})
