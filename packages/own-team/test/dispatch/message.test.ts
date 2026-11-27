// Area-to-area messages (06 §5.8, 2026-10-16) at plugin level: `team_message` asks, replies, notes and watches between
// two areas (and an area peer) through the outbox rule, the loop guards, the receiver's log settling an ask (its reply
// or its last answer, else a notice), the notes after the next request's envelope, the notices of a cancelled ask and
// of a watch, Main 멈춤, and what the main and an owner read in team_status. A fake core on 127.0.0.1 (local model:
// no account is reached), a manual clock; nothing real is reached.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Talk } from "../../src/dispatch/talk.js"
import { Digest } from "../../src/report/digest.js"
import { Fold } from "../../src/report/fold.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { MessageTool } from "../../src/tools/message.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { StatusTool } from "../../src/tools/status.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { durable, event, fakeCore, until } from "../support/core.js"
import { start } from "../support/service.js"
import { temp } from "../fixtures/repo.js"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_ui")
const SAVE = OwnTeam.AreaID.make("ar_save")
const SAVE_OWNER = SessionID.make("ses_save0000000000000000000001")
const REVIEWER = SessionID.make("ses_review000000000000000000001")

async function setup(
  input: {
    readonly ui?: (base: OwnTeam.Area) => OwnTeam.Area
    readonly save?: (base: OwnTeam.Area) => OwnTeam.Area
  } = {},
) {
  const box = temp("own-team-message-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folders = { ui: path.join(box.root, "home-team", "ui"), save: path.join(box.root, "home-team", "save") }
  for (const folder of [home, folders.ui, folders.save]) fs.mkdirSync(folder, { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const core = fakeCore(service)
  core.add(MAIN_SESSION, home)
  core.add(OWNER_SESSION, folders.ui)
  core.add(SAVE_OWNER, folders.save)
  core.add(REVIEWER, folders.save)
  const world = new World()
  const clock = manual()
  const h = controller(world, { directory: home, clock, source: service.source })
  cleanups.push(() => h.close())
  const ui = (input.ui ?? ((base) => base))({ ...area({ slug: "ui", directory: folders.ui }), name: "인벤토리 화면" })
  const reviewer: OwnTeam.Peer = {
    key: "reviewer",
    sessionID: REVIEWER,
    label: "리뷰어",
    role: "",
    attached: true,
    origin: "created",
    at: 0,
  }
  const save = (input.save ?? ((base) => base))({
    ...area({ slug: "save", directory: folders.save }),
    name: "세이브 v3",
    owner: { sessionID: SAVE_OWNER, previous: [], attached: true },
    peers: [reviewer],
  })
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home }))
    await h.services.registry.areas.put(ui)
    await h.services.registry.areas.put(save)
  })
  /** The registry's caller for a session (owner or peer), as the tools get it. */
  const caller = async (sessionID: string) => {
    const judged = OwnerTools.judgeArea(await h.services.locate.session(sessionID))
    if (!judged.ok) throw new Error(judged.text)
    return judged.caller
  }
  const message = async (sessionID: string, value: typeof MessageTool.Input.Type) =>
    MessageTool.run(h.services, await caller(sessionID), value)
  const talk = () => Talk.load(h.services.kv, TEAM_ID)
  const digest = () => Digest.load(h.services.kv, TEAM_ID)
  const stored = (dispatchID: string) => h.services.registry.dispatches.find(TEAM_ID, dispatchID)
  /** Changes an area record (the write section). */
  const change = (areaID: OwnTeam.AreaID, update: (current: OwnTeam.Area) => OwnTeam.Area) =>
    h.services.write(TEAM_ID, async () => {
      const current = await h.services.registry.areas.get(TEAM_ID, areaID)
      if (current) await h.services.registry.areas.put(update(current))
    })
  return { ...h, home, folders, service, core, world, clock, caller, message, talk, digest, stored, change }
}

type Harness = Awaited<ReturnType<typeof setup>>

/** `sessionID`'s log says the ask was delivered there, then its run ended with `end` (its seq after the delivery). */
function took(h: Harness, sessionID: string, askID: string, end: string, data: Readonly<Record<string, unknown>> = {}) {
  h.core.inbox.set(sessionID, [])
  h.controller.hub.receive(
    durable(sessionID, 10, "session.inbox.delivered", { inboxID: MsgID.dispatch(askID, sessionID) }),
  )
  h.controller.hub.receive(durable(sessionID, 11, end, data))
}

describe("ask and reply (06 §5.8)", () => {
  test("an ask to an idle area goes in at once: queue delivery, hashed id, area envelope and own.dispatch metadata", async () => {
    const h = await setup()
    const sent = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "ItemStack.count를 바꾸나요?" })
    expect(sent).toMatchObject({ ok: true, state: "queued" })
    expect(sent.text).toBe(
      "세이브 v3 담당: 물음을 보냈습니다. 답은 새 차례로 옵니다. 기다리는 동안 할 수 있는 일을 하거나 이 차례를 마치세요.",
    )
    const id = String(sent.messageID)
    const prompts = h.core.prompts(SAVE_OWNER)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.body).toEqual({
      id: MsgID.dispatch(id, SAVE_OWNER),
      text: `<dispatch from="area" sender="인벤토리 화면" kind="ask" id="${id}" area="세이브 v3">\nItemStack.count를 바꾸나요?\n</dispatch>`,
      metadata: {
        "own.dispatch": {
          id,
          from: "area",
          teamID: TEAM_ID,
          areaID: SAVE,
          kind: "ask",
          sender: { areaID: UI, area: "인벤토리 화면" },
        },
        source: "own.team",
      },
      delivery: "queue",
    })
    // The main is not woken; its next update carries an audit line.
    expect(Fold.due(await h.digest())).toBeUndefined()
    expect(Talk.untold(await h.talk()).map((line) => line.text)).toEqual([
      `'인벤토리 화면' → '세이브 v3 담당' 물음: "ItemStack.count를 바꾸나요?"`,
    ])
    const update = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(update).toContain(`영역 메시지 1건:\n  · `)
    expect(
      update
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .every((line) => !line.includes("물음")),
    ).toBe(true)
  })

  test("the reply goes back by the ask's id, once; a reply to another conversation's ask is refused", async () => {
    const h = await setup()
    const asked = await h.message(OWNER_SESSION, { kind: "ask", to: "save", member: "리뷰어", text: "리뷰해 줄래요?" })
    expect(asked).toMatchObject({ ok: true, state: "queued" })
    expect(h.core.prompts(REVIEWER)[0]!.body.text.split("\n")[0]).toContain(
      'to="reviewer" sender="인벤토리 화면" kind="ask"',
    )
    const id = String(asked.messageID)
    expect(await h.message(SAVE_OWNER, { kind: "reply", id, text: "x" })).toMatchObject({ ok: false, state: "refused" })
    const replied = await h.message(REVIEWER, { kind: "reply", id, text: "좋아요, 고칠 곳 둘" })
    expect(replied).toMatchObject({ ok: true, state: "queued", text: "인벤토리 화면 담당: 답을 보냈습니다." })
    const back = h.core.prompts(OWNER_SESSION)
    expect(back).toHaveLength(1)
    expect(back[0]!.body.text.split("\n")[0]).toBe(
      `<dispatch from="area" sender="세이브 v3 동료 리뷰어" kind="reply" reply="${id}" id="${String(replied.messageID)}" area="인벤토리 화면">`,
    )
    expect((await h.talk()).open).toEqual([])
    const twice = await h.message(REVIEWER, { kind: "reply", id, text: "하나 더" })
    expect(twice).toMatchObject({ ok: false, state: "refused", why: "answered" })
  })

  test("an ask waits like a main request; a reply passes the asker's own Main 멈춤, never 모두 멈추기", async () => {
    const h = await setup({ save: (base) => ({ ...base, paused: "user" }) })
    const waiting = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "물음" })
    expect(waiting).toMatchObject({ ok: true, state: "waiting", why: "paused" })
    expect(h.core.prompts(SAVE_OWNER)).toHaveLength(0)

    // The asker's area is paused by the user, yet the reply it asked for goes in.
    const p = await setup({ ui: (base) => ({ ...base, paused: "user" }) })
    const ask = await p.message(OWNER_SESSION, { kind: "ask", to: "save", member: "reviewer", text: "둘째" })
    expect(ask).toMatchObject({ state: "queued" })
    // A main request that waits under the switch stays behind the reply.
    const main = await p.services.features().admit.dispatch({
      teamID: TEAM_ID,
      areaID: UI,
      text: "메인 요청",
      from: "main",
      kind: "task",
    })
    expect(main).toMatchObject({ state: "waiting", why: "paused" })
    const replied = await p.message(REVIEWER, { kind: "reply", id: String(ask.messageID), text: "답" })
    expect(replied).toMatchObject({ state: "queued" })
    expect(p.core.prompts(OWNER_SESSION).map((prompt) => prompt.body.text)).toHaveLength(1)
    expect(p.core.prompts(OWNER_SESSION)[0]!.body.text).toContain('kind="reply"')

    const all = await setup({ ui: (base) => ({ ...base, paused: "all" }) })
    const asked = await all.message(OWNER_SESSION, { kind: "ask", to: "save", text: "물음" })
    expect(asked.text).toContain("모두 멈춤이라 답은 다시 시작한 뒤에")
    const held = await all.message(SAVE_OWNER, { kind: "reply", id: String(asked.messageID), text: "답" })
    expect(held).toMatchObject({ state: "waiting", why: "paused" })
    expect(all.core.prompts(OWNER_SESSION)).toHaveLength(0)
  })

  test("an ask to an idle area the user works with directly waits, and says so (2026-11-14)", async () => {
    const h = await setup({ save: (base) => ({ ...base, directWork: { since: 0, at: 0 } }) })
    const waiting = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "물음" })
    expect(waiting).toMatchObject({ ok: true, state: "waiting", why: "paused" })
    expect(waiting.text).toContain("상대 영역이 사용자와 직접 작업 중이라 기다립니다.")
    expect(waiting.text).not.toContain("메인 멈춤")
    expect(h.core.prompts(SAVE_OWNER)).toHaveLength(0)
  })

  test("parallel asks of one Code Mode run: only the first passes G2", async () => {
    const h = await setup()
    h.core.active.add(SAVE_OWNER)
    const both = await Promise.all([
      h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "하나" }),
      h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "둘" }),
    ])
    expect(both.map((item) => item.state).toSorted()).toEqual(["refused", "waiting"])
    const held = both.find((item) => item.state === "refused")
    expect(held).toMatchObject({ why: "open" })
    expect(held?.text).toContain("세이브 v3 담당에게 보낸 앞선 물음이 아직 열려 있습니다")
    expect((await h.services.registry.dispatches.waiting(TEAM_ID, SAVE)).length).toBe(1)
  })

  test("a conversation's tenth ask in an hour is its last: the next is refused with why limit; another conversation still asks", async () => {
    const h = await setup()
    // Every ask goes to a different conversation pair: the reviewer and the owner, from both sides, then settled.
    const asks = await Array.from({ length: Talk.ASKS_PER_HOUR }).reduce<Promise<string[]>>(async (previous) => {
      const done = await previous
      h.core.active.add(SAVE_OWNER)
      const sent = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: `물음 ${done.length}` })
      expect(sent.state).toBe("waiting")
      // Cancelled by the user: the pair is free again (and the asker gets a notice).
      await h.services
        .features()
        .admit.cancel({ teamID: TEAM_ID, areaID: SAVE, dispatchID: OwnTeam.DispatchID.make(String(sent.messageID)) })
      return [...done, String(sent.messageID)]
    }, Promise.resolve([]))
    expect(asks).toHaveLength(Talk.ASKS_PER_HOUR)
    const over = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "하나 더" })
    expect(over).toMatchObject({ ok: false, state: "refused", why: "limit" })
    expect(over.text).toContain(`이 대화의 물음이 지난 한 시간에 ${Talk.ASKS_PER_HOUR}개에 닿아`)
    // One conversation's limit is its own: the main is not woken, and another conversation still asks.
    expect((await h.digest()).entries.filter((item) => item.reason === "area-limit")).toEqual([])
    expect(await h.message(SAVE_OWNER, { kind: "ask", to: "ui", text: "다른 대화의 물음" })).toMatchObject({ ok: true })
  })

  test("the team's fortieth ask in an hour is the last: the next is refused with why team-limit and wakes the main once", async () => {
    const h = await setup()
    // Forty asks of other conversations this hour, settled long ago (the user's 지우기).
    await h.services.write(TEAM_ID, async () => {
      for (const index of Array.from({ length: Talk.ASKS_PER_HOUR_TEAM }, (_, at) => at))
        await h.services.registry.dispatches.put({
          id: OwnTeam.DispatchID.create(),
          teamID: TEAM_ID,
          areaID: UI,
          seq: index,
          from: "area",
          kind: "ask",
          text: `물음 ${index}`,
          sender: { areaID: OwnTeam.AreaID.make(`ar_gone${index % 5}`), area: `떠난 영역 ${index % 5}` },
          state: "cancelled",
          createdAt: h.clock.now(),
        })
    })
    const over = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "하나 더" })
    expect(over).toMatchObject({ ok: false, state: "refused", why: "team-limit" })
    expect(over.text).toContain(`팀의 물음이 지난 한 시간에 ${Talk.ASKS_PER_HOUR_TEAM}개에 닿아`)
    const limits = (await h.digest()).entries.filter((item) => item.reason === "area-limit")
    expect(limits).toHaveLength(1)
    expect(limits[0]).toMatchObject({ wake: true })
    expect(limits[0]?.text).toContain(`팀의 한 시간 상한(${Talk.ASKS_PER_HOUR_TEAM}개)`)
    // Within the hour, a second hit does not wake the main again; the 할 일 item names what to do.
    await h.message(OWNER_SESSION, { kind: "ask", to: "save", member: "reviewer", text: "또" })
    expect((await h.digest()).entries.filter((item) => item.reason === "area-limit")).toHaveLength(1)
    const text = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(text).toContain("영역 메시지 상한 → 주고받은 영역에 할 일을 정해 보내거나 사용자에게 알리기")
    // A reply is never held by the limit.
    const asked = (await h.services.registry.dispatches.list(TEAM_ID)).find((item) => item.kind === "ask")
    if (!asked) throw new Error("no ask")
    expect(
      Talk.guard({
        dispatches: await h.services.registry.dispatches.list(TEAM_ID),
        state: await h.talk(),
        message: { kind: "reply", areaID: UI, sender: { areaID: SAVE, area: "세이브 v3" }, replyTo: asked.id },
        now: h.clock.now(),
      }),
    ).toBeUndefined()
  })
})

describe("the receiver's run ends (06 §5.8)", () => {
  test("without a reply its last answer goes back as the reply; an interrupted run sends the asker a notice", async () => {
    const h = await setup()
    const asked = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "count 이름?" })
    const id = String(asked.messageID)
    h.core.messages.set(SAVE_OWNER, [
      { id: "msg_answer", type: "assistant", content: [{ type: "text", text: "count는 그대로 둡니다." }] },
      { id: MsgID.dispatch(id, SAVE_OWNER), type: "user", text: "…" },
      { id: "msg_old", type: "assistant", content: [{ type: "text", text: "예전 답" }] },
    ])
    took(h, SAVE_OWNER, id, "session.execution.succeeded")
    await until(() => h.core.prompts(OWNER_SESSION).length === 1)
    const reply = h.core.prompts(OWNER_SESSION)[0]!.body.text
    expect(reply).toContain(`kind="reply" reply="${id}"`)
    expect(OwnTeamText.unwrap(reply)).toBe("count는 그대로 둡니다.")
    expect(Talk.untold(await h.talk()).at(-1)?.text).toContain("답(그 차례의 마지막 답)")

    const g = await setup()
    const second = await g.message(OWNER_SESSION, { kind: "ask", to: "save", text: "다른 물음" })
    took(g, SAVE_OWNER, String(second.messageID), "session.execution.interrupted", { reason: "user" })
    await until(() => g.core.prompts(OWNER_SESSION).length === 1)
    const notice = g.core.prompts(OWNER_SESSION)[0]!.body
    expect(notice.text.split("\n")[0]).toContain('<dispatch from="team" kind="notice"')
    expect(OwnTeamText.unwrap(notice.text)).toContain("세이브 v3 담당: 물음에 답하지 않고 차례를 마쳤습니다")
    expect(notice.metadata?.["own.dispatch"]).toMatchObject({ from: "team", kind: "notice" })
  })

  test("a last answer over 20,000 characters goes back cut, with a marker saying so", async () => {
    const h = await setup()
    const asked = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "전체 목록?" })
    const id = String(asked.messageID)
    h.core.messages.set(SAVE_OWNER, [
      { id: "msg_answer", type: "assistant", content: [{ type: "text", text: "가".repeat(Talk.REPLY_MAX + 5) }] },
      { id: MsgID.dispatch(id, SAVE_OWNER), type: "user", text: "…" },
    ])
    took(h, SAVE_OWNER, id, "session.execution.succeeded")
    await until(() => h.core.prompts(OWNER_SESSION).length === 1)
    const reply = OwnTeamText.unwrap(h.core.prompts(OWNER_SESSION)[0]!.body.text)
    expect(reply.startsWith("가".repeat(Talk.REPLY_MAX))).toBe(true)
    expect(reply.endsWith("(이후 생략: 전체 20,005자 중 앞부분입니다. 나머지가 필요하면 다시 물으세요)")).toBe(true)
  })

  test("a replied ask sends nothing more; a run that failed at once after the delivery settles it too", async () => {
    const h = await setup()
    const asked = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "물음" })
    const id = String(asked.messageID)
    await h.message(SAVE_OWNER, { kind: "reply", id, text: "답" })
    h.core.inbox.set(OWNER_SESSION, [])
    took(h, SAVE_OWNER, id, "session.execution.succeeded")
    await Bun.sleep(100)
    expect(h.core.prompts(OWNER_SESSION)).toHaveLength(1)

    const g = await setup()
    const second = await g.message(OWNER_SESSION, { kind: "ask", to: "save", text: "물음" })
    took(g, SAVE_OWNER, String(second.messageID), "session.execution.failed", { error: { message: "400" } })
    await until(async () => (await g.talk()).open.length === 0)
    await until(() => g.core.prompts(OWNER_SESSION).length === 1)
  })

  test("an owner that waits for its own ask's answer owes no report: no 끝났지만 보고 없음", async () => {
    const h = await setup()
    const main = await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: UI, text: "일", from: "main", kind: "task" })
    if (!main.ok) throw new Error("not sent")
    const metadata = { [OwnTeam.DISPATCH_META]: { id: main.dispatchID, from: "main", teamID: TEAM_ID, areaID: UI } }
    const inboxID = MsgID.dispatch(main.dispatchID, OWNER_SESSION)
    h.core.inbox.set(OWNER_SESSION, [])
    h.controller.hub.receive(
      durable(OWNER_SESSION, 1, "session.inbox.enqueued", { inboxID, item: { payload: { metadata } } }),
    )
    h.controller.hub.receive(durable(OWNER_SESSION, 2, "session.inbox.delivered", { inboxID }))
    await until(async () => Fold.area(await h.digest(), UI).received?.dispatchID === main.dispatchID)
    h.core.active.add(SAVE_OWNER)
    await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "물어볼 것" })
    h.controller.hub.receive(durable(OWNER_SESSION, 3, "session.execution.succeeded"))
    await Bun.sleep(100)
    expect((await h.digest()).entries.some((item) => item.reason === "unreported")).toBe(false)
  })
})

describe("never create, attach or rotate (06 §5.8)", () => {
  test("an area whose owner is not attached refuses at once; one that became so refuses at send and the asker hears", async () => {
    const h = await setup({ save: (base) => ({ ...base, owner: { ...base.owner, attached: false } }) })
    const refused = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "x" })
    expect(refused).toMatchObject({ ok: false, state: "refused" })
    expect(refused.text).toBe(
      '세이브 v3 담당: 아직 팀 메인의 첫 요청을 받지 않아 영역 메시지를 받을 수 없습니다. 필요하면 team_report(kind:"blocked")로 메인에게 알리세요.',
    )
    expect(await h.services.registry.dispatches.list(TEAM_ID)).toEqual([])

    const g = await setup()
    g.core.active.add(SAVE_OWNER)
    const waiting = await g.message(OWNER_SESSION, { kind: "ask", to: "save", text: "기다릴 물음" })
    expect(waiting).toMatchObject({ state: "waiting", why: "busy" })
    await g.change(SAVE, (current) => ({ ...current, owner: { ...current.owner, attached: false } }))
    g.core.active.delete(SAVE_OWNER)
    g.controller.hub.receive(event("session.execution.succeeded", { sessionID: SAVE_OWNER }))
    await until(async () => (await g.stored(String(waiting.messageID)))?.state === "cancelled")
    expect(g.core.prompts(SAVE_OWNER)).toHaveLength(0)
    await until(() => g.core.prompts(OWNER_SESSION).length === 1)
    expect(OwnTeamText.unwrap(g.core.prompts(OWNER_SESSION)[0]!.body.text)).toContain("전해지지 않고 지워졌습니다")
    expect(Talk.untold(await g.talk()).at(-1)?.text).toContain("그 대화가 아직 팀에 붙지 않았습니다")
    // The main is not woken for it.
    expect(Fold.due(await g.digest())).toBeUndefined()
  })

  test("the user's 지우기 of a waiting ask tells the asker once", async () => {
    const h = await setup()
    h.core.active.add(SAVE_OWNER)
    const waiting = await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "지울 물음" })
    const cancelled = await h.services.features().admit.cancel({
      teamID: TEAM_ID,
      areaID: SAVE,
      dispatchID: OwnTeam.DispatchID.make(String(waiting.messageID)),
    })
    expect(cancelled).toEqual({ ok: true })
    await until(() => h.core.prompts(OWNER_SESSION).length === 1)
    expect((await h.talk()).open).toEqual([])
    await Bun.sleep(50)
    expect(h.core.prompts(OWNER_SESSION)).toHaveLength(1)
  })
})

describe("notes and watches (06 §5.8)", () => {
  test("a note waits for the next request to that conversation, goes after its envelope and leaves once it went in", async () => {
    const h = await setup()
    const noted = await h.message(OWNER_SESSION, { kind: "note", to: "save", text: "가격 표시는 내일 바뀝니다" })
    expect(noted).toMatchObject({ ok: true, state: "held" })
    expect(noted.text).toBe("세이브 v3 담당: 쪽지를 남겼습니다. 그 대화를 깨우지 않고 다음 요청과 함께 갑니다.")
    expect(
      await h.message(OWNER_SESSION, { kind: "note", to: "save", text: "가격 표시는 내일 바뀝니다" }),
    ).toMatchObject({
      text: "세이브 v3 담당: 같은 쪽지가 이미 남아 있습니다.",
    })
    expect(h.core.prompts(SAVE_OWNER)).toHaveLength(0)
    const listed = await h.services.features().admit.list({ teamID: TEAM_ID, areaID: SAVE })
    expect(listed.ok && listed.notes?.map((note) => note.text)).toEqual(["가격 표시는 내일 바뀝니다"])

    // The next main request's send fails once: the note stays and goes with the resend.
    h.core.failing.add(SAVE_OWNER)
    const main = await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: SAVE, text: "저장 고치기", from: "main", kind: "task" })
    expect(main).toMatchObject({ state: "waiting", why: "busy" })
    if (!main.ok) return
    expect((await h.stored(main.dispatchID))?.notes).toHaveLength(1)
    expect((await h.talk()).notes).toHaveLength(1)
    h.core.failing.delete(SAVE_OWNER)
    h.controller.hub.receive(event("session.execution.succeeded", { sessionID: SAVE_OWNER }))
    await until(async () => (await h.stored(main.dispatchID))?.state === "sent")
    const text = h.core.prompts(SAVE_OWNER).at(-1)!.body.text
    expect(OwnTeamText.unwrap(text)).toBe("저장 고치기")
    expect(OwnTeamText.notes(text)).toHaveLength(1)
    expect(OwnTeamText.notes(text)[0]).toMatch(
      /^인벤토리 화면\(\d{4}-\d\d-\d\d \d\d:\d\d\): 가격 표시는 내일 바뀝니다$/,
    )
    expect((await h.talk()).notes).toEqual([])
    // A note over 1,000 characters is refused.
    expect(
      await h.message(OWNER_SESSION, { kind: "note", to: "save", text: "가".repeat(Talk.NOTE_MAX + 1) }),
    ).toMatchObject({ ok: false })
  })

  test("a sixth note for one conversation pushes out its oldest, and the sender is told so", async () => {
    const h = await setup()
    const notes = await Array.from({ length: Talk.NOTES_PER_TARGET }, (_, index) => index).reduce<
      Promise<ReadonlyArray<string>>
    >(async (previous, index) => {
      const done = await previous
      const noted = await h.message(OWNER_SESSION, { kind: "note", to: "save", text: `쪽지 ${index}` })
      return [...done, noted.text]
    }, Promise.resolve([]))
    expect(notes.every((text) => !text.includes("밀려났습니다"))).toBe(true)
    const sixth = await h.message(OWNER_SESSION, { kind: "note", to: "save", text: "쪽지 5" })
    expect(sixth.text).toBe(
      "세이브 v3 담당: 쪽지를 남겼습니다. 그 대화를 깨우지 않고 다음 요청과 함께 갑니다. 받는 쪽에 쪽지가 5개라 가장 오래된 쪽지가 밀려났습니다.",
    )
    expect((await h.talk()).notes.map((note) => note.text)).toEqual(["쪽지 1", "쪽지 2", "쪽지 3", "쪽지 4", "쪽지 5"])
  })

  test("a watch fires one notice when the area reports ready, never again; one already ready answers at once", async () => {
    const h = await setup()
    const set = await h.message(OWNER_SESSION, {
      kind: "watch",
      to: "save",
      on: "ready",
      text: "그때 저장 형식을 맞춘다",
    })
    expect(set).toMatchObject({ ok: true, state: "held" })
    expect(await h.message(OWNER_SESSION, { kind: "watch", to: "save", text: "x" })).toMatchObject({ ok: false })
    expect(await h.message(OWNER_SESSION, { kind: "watch", to: "ui", on: "ready", text: "x" })).toMatchObject({
      ok: false,
      text: "자기 영역은 지켜보지 않습니다.",
    })
    await Talk.fire(h.services, { teamID: TEAM_ID, areaID: SAVE, on: "ready" })
    await until(() => h.core.prompts(OWNER_SESSION).length === 1)
    const notice = OwnTeamText.unwrap(h.core.prompts(OWNER_SESSION)[0]!.body.text)
    expect(notice).toContain("세이브 v3 영역이 반영 준비를 마쳤습니다")
    expect(notice).toContain('지켜보며 남긴 글: "그때 저장 형식을 맞춘다"')
    await Talk.fire(h.services, { teamID: TEAM_ID, areaID: SAVE, on: "ready" })
    await Bun.sleep(50)
    expect(h.core.prompts(OWNER_SESSION)).toHaveLength(1)

    await h.change(SAVE, (current) => ({
      ...current,
      status: { kind: "ready", at: 1, text: "" },
      candidate: { sha: "b".repeat(40), at: 1, text: "준비" },
    }))
    expect(await h.message(OWNER_SESSION, { kind: "watch", to: "save", on: "ready", text: "x" })).toMatchObject({
      ok: true,
      state: "done",
    })
  })
})

describe("what the main and the owners read (06 §5.8)", () => {
  test("an owner's team_status lists the other areas, its asks, watches and held notes; no line counts as an area", async () => {
    const h = await setup()
    await h.change(SAVE, (current) => ({ ...current, goal: "세이브 형식 v3" }))
    h.core.active.add(SAVE_OWNER)
    await h.message(OWNER_SESSION, { kind: "ask", to: "save", text: "count 이름?" })
    await h.message(OWNER_SESSION, { kind: "watch", to: "save", on: "integrated", text: "그 뒤에 맞춘다" })
    await h.message(SAVE_OWNER, { kind: "note", to: "ui", text: "내일 형식이 바뀝니다" })
    const status = await StatusTool.run(h.services, await h.caller(OWNER_SESSION), {})
    const lines = status.text.split("\n")
    expect(lines).toContain("다른 영역:")
    // Its status word is whatever the area's is (the controller's catch-up saw its owner run: 작업 중).
    expect(lines.find((line) => line.startsWith("  · 세이브 v3(save)"))).toMatch(
      /^ {2}· 세이브 v3\(save\) · [^·]+ · 줄기 save · 역할 "세이브 형식 v3" · 동료 리뷰어\(reviewer\)$/,
    )
    expect(lines.find((line) => line.startsWith("보낸 물음:"))).toBe(
      '보낸 물음: 세이브 v3 담당 "count 이름?" · 대기함에서 기다림',
    )
    expect(lines.find((line) => line.startsWith("지켜보는 영역:"))).toMatch(
      /^지켜보는 영역: 세이브 v3 반영\(\d{4}-\d\d-\d\d \d\d:\d\d까지\)$/,
    )
    expect(lines.find((line) => line.startsWith("받은 쪽지"))).toMatch(
      /^받은 쪽지 1개\(다음 요청과 함께 감\): 세이브 v3\(\d{4}-\d\d-\d\d \d\d:\d\d\) "내일 형식이 바뀝니다"$/,
    )
    const added = lines.slice(lines.indexOf("다른 영역:"))
    expect(added.map(OwnTeamText.countOf).filter((kind) => kind !== undefined)).toEqual([])
    // The main's view counts the waiting ask apart from main requests (the role quote, 2026-10-26, comes before).
    const main = await h.services.features().digest.render({ teamID: TEAM_ID })
    expect(main).toMatch(/- 세이브 v3: [^·\n]+ · (?:역할 "[^"\n]*" · )?영역 메시지 1개 기다림/)
    expect(main).not.toContain("맡긴 일")
  })
})

describe("role texts (06 §6.2, §5.8)", () => {
  test("an attached owner and peer get the current role once per controller, before their next request goes", async () => {
    const h = await setup()
    await h.message(OWNER_SESSION, { kind: "note", to: "save", text: "쪽지" })
    await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: SAVE, text: "하나", from: "main", kind: "task" })
    const owner = h.core.entries.get(SAVE_OWNER)?.get(RoleInstructions.OWNER)
    expect(String(owner)).toContain('<dispatch from="area" sender="…" kind="ask">')
    expect(String(owner)).toContain('team_message{kind:"reply"')
    // The folder path comes from `os.tmpdir()`; the fixed-fixture bounds are in `sessions/instructions.test.ts`.
    expect(String(owner).length).toBeLessThan(3_000)
    h.core.inbox.set(SAVE_OWNER, [])
    await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: SAVE, text: "둘", from: "main", kind: "task" })
    expect(h.core.puts(SAVE_OWNER)).toHaveLength(1)

    h.core.inbox.set(SAVE_OWNER, [])
    await h.services
      .features()
      .admit.dispatch({ teamID: TEAM_ID, areaID: SAVE, to: "reviewer", text: "셋", from: "main", kind: "task" })
    const peer = String(h.core.entries.get(REVIEWER)?.get(RoleInstructions.PEER))
    expect(peer).toContain('<dispatch from="area" to="reviewer" sender="…" kind="ask">')
    // The folder path comes from `os.tmpdir()`; the fixed-fixture bounds are in `sessions/instructions.test.ts`.
    expect(peer.length).toBeLessThan(3_000)
    // An area renamed since: the next controller writes the new name once.
    expect(String(owner)).toContain("세이브 v3")
  })
})
