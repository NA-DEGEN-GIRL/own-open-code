// TI-11 for 담당 대화 바꾸기 (`area.seat`, `sessions/seat.ts`; 2026-11-12): every step's result lost once (kit in
// `t3-resume/kit.ts`). The area's owner has one team request it never took; whichever step the first controller dies
// after, the second ends with the seat on the chosen conversation, the old seat a plain conversation again, and the
// request delivered to the new seat once. Then the stops that are not a lost result: the owner changed between the
// claim and the swap (the move ends as failed and its claim is taken back), a `fresh` request waiting at the release,
// and a cancel on either side of the swap. The other stops (in the wait, inside the claim's last write, a storage
// failure inside the swap, a cancel in the wait) are in `test/sessions/seat.test.ts`.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { Cursor } from "../../src/report/cursor.js"
import { Digest } from "../../src/report/digest.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { Seat } from "../../src/sessions/seat.js"
import { Permissions } from "../../src/tools/permissions.js"
import { MAIN_SESSION, MODEL, TEAM_ID, type Rule } from "../support/context.js"
import { until } from "../support/core.js"
import { session } from "../support/service.js"
import { type Booted, type Fixture, SLOW, areaOf, boot, drive, eachStep, fixture, makeArea } from "./t3-resume/kit.js"

const Started = Schema.Struct({ opID: OwnTeam.OpID })
const decodeAdmission = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, text: Schema.String, metadata: Schema.Record(Schema.String, Schema.Unknown) }),
)
const decodeEntry = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Unknown }))
const decodePatch = Schema.decodeUnknownSync(Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) }))
const KEYS = [RoleInstructions.OWNER, RoleInstructions.HANDOFF, RoleInstructions.PEER]
/** A rule the user gave a conversation; the team never touches it. */
const COMPUTER: Rule = { action: "computer", resource: "*", effect: "allow" }
const OWNER_RULES = Permissions.rules("owner").map((rule) => ({ ...rule }))
/** The chosen conversation's log position when it takes the seat. */
const SEQ = 41

interface Item {
  readonly id: string
  readonly text: string
  readonly metadata: Readonly<Record<string, unknown>>
}

interface Talk {
  readonly id: SessionID
  metadata: Record<string, unknown>
  inbox: Item[]
  readonly entries: Map<string, unknown>
}

interface Run {
  readonly old: Talk
  readonly target: Talk
  dispatchID?: OwnTeam.DispatchID
}

const runs = new WeakMap<Fixture, Run>()

/**
 * A root conversation of `directory` as the seat move reads and writes it: a model, the permissions the plugin API
 * wrote, instruction entries that are kept, a queue whose items can be withdrawn and a log position.
 */
function conversation(fx: Fixture, id: SessionID, directory: string): Talk {
  const talk: Talk = { id, metadata: {}, inbox: [], entries: new Map() }
  fx.backend.add(id, directory)
  fx.world.sessions.set(id, { id, directory, permissions: [COMPUTER] })
  const at = `/api/session/${id}`
  const entries = `/api/experimental/session/${id}/instructions/entries`
  const routes = fx.backend.service.routes
  routes.set(`GET ${at}`, () =>
    Response.json({
      data: {
        ...session({ id, directory, metadata: talk.metadata }),
        model: MODEL,
        permissions: fx.world.sessions.get(id)?.permissions ?? [],
      },
    }),
  )
  routes.set(`PATCH ${at}`, (request) => {
    talk.metadata = { ...decodePatch(request.body).metadata }
    return new Response(null, { status: 204 })
  })
  routes.set(`GET ${at}/inbox`, () =>
    Response.json({
      data: talk.inbox.map((item) => ({
        id: item.id,
        sessionID: id,
        type: "user",
        delivery: "steer",
        payload: { text: item.text, metadata: item.metadata },
        time: { created: fx.clock.now() },
      })),
    }),
  )
  routes.set(`POST ${at}/prompt`, (request) => {
    const body = decodeAdmission(request.body)
    if (talk.inbox.every((item) => item.id !== body.id)) talk.inbox = [...talk.inbox, body]
    routes.set(`DELETE ${at}/inbox/${body.id}`, () => {
      talk.inbox = talk.inbox.filter((item) => item.id !== body.id)
      return new Response(null, { status: 204 })
    })
    return Response.json({
      data: { id: body.id, sessionID: id, type: "user", delivery: "steer", payload: { text: body.text } },
    })
  })
  routes.set(
    `GET /api/experimental/session/${id}/log`,
    () => new Response(`data: ${JSON.stringify({ type: "log.synced", aggregateID: id, seq: SEQ })}\n\n`),
  )
  routes.set(`GET ${entries}`, () => Response.json({ data: [...talk.entries].map(([key, value]) => ({ key, value })) }))
  for (const key of KEYS) {
    routes.set(`PUT ${entries}/${key}`, (request) => {
      talk.entries.set(key, decodeEntry(request.body).value)
      return new Response(null, { status: 204 })
    })
    routes.set(`DELETE ${entries}/${key}`, () => {
      talk.entries.delete(key)
      return new Response(null, { status: 204 })
    })
  }
  return talk
}

/** The team requests admitted to a conversation, in order (a repeated admission of one id counts each time). */
function admitted(fx: Fixture, id: string) {
  return fx.backend.service.requests
    .filter((request) => request.method === "POST" && request.path === `/api/session/${id}/prompt`)
    .map((request) => decodeAdmission(request.body))
}

/** The area, its owner as the team left it with one request it never took, and the conversation the user picks. */
async function prepare(fx: Fixture, booted: Booted) {
  const made = await makeArea(fx, booted.services, "ui", { owner: true })
  // The seat as the team left it: the owner's allows and role entries beside the user's own rule.
  const old = conversation(fx, made.owner.sessionID!, made.directory)
  fx.world.sessions.get(old.id)!.permissions = [...OWNER_RULES, COMPUTER]
  old.entries.set(RoleInstructions.OWNER, "old owner role")
  old.entries.set(RoleInstructions.HANDOFF, "old handoff")
  const target = conversation(fx, SessionID.create(), made.directory)
  const run: Run = { old, target }
  runs.set(fx, run)
  await booted.services.write(TEAM_ID, () =>
    booted.services.registry.areas.put({ ...made, owner: { ...made.owner, attached: true } }),
  )
  // A request the old seat was sent and never took.
  const sent = await booted.services
    .features()
    .admit.dispatch({ teamID: TEAM_ID, areaID: made.id, text: "정렬 버그를 고쳐 주세요", from: "main", kind: "task" })
  if (!sent.ok) throw new Error(sent.message)
  await until(() => old.inbox.length === 1, 20_000)
  run.dispatchID = (await booted.services.registry.dispatches.list(TEAM_ID))[0]?.id
}

async function start(fx: Fixture, booted: Booted) {
  const made = (await areaOf(booted.services, "ui"))!
  const answer = await booted.rpc("area.seat", { teamID: TEAM_ID, areaID: made.id, sessionID: runs.get(fx)!.target.id })
  return Schema.decodeUnknownSync(Started)(answer).opID
}

/**
 * The move on a prepared fixture, with the first controller's runner stopped right after the step at `index` (as the
 * kit stops it for a kill): the op is still `running` in the journal and nothing runs it. A cancel is only taken in
 * such a moment or while a step waits (the engine answers `busy` while a step acts), so the cancel tests take it here,
 * on that controller, before anything runs the op again.
 */
async function killedAfter(index: number) {
  const fx = await fixture()
  const first = boot(fx, index)
  await first.services.write(TEAM_ID, () => first.services.registry.teams.put(fx.record))
  await prepare(fx, first)
  const opID = await start(fx, first)
  const stopped = await drive(first, opID)
  expect({ stopped: first.state.stopped, states: stopped.steps.map((step) => step.state) }).toEqual({
    stopped: true,
    states: stopped.steps.map((_step, at) => (at <= index ? "done" : "pending")),
  })
  return { fx, first, opID, run: runs.get(fx)!, area: (await areaOf(first.services, "ui"))! }
}

async function sent(booted: Booted) {
  await until(
    async () => (await booted.services.registry.dispatches.list(TEAM_ID)).every((item) => item.state === "sent"),
    20_000,
  )
  return booted.services.registry.dispatches.list(TEAM_ID)
}

function seatedLines(booted: Booted) {
  return Digest.load(booted.services.kv, TEAM_ID).then((digest) =>
    digest.entries.filter((entry) => entry.reason === "seated"),
  )
}

describe("resume after each step (담당 대화 바꾸기, TI-11)", () => {
  eachStep("담당 대화 바꾸기: the wait, the requests, the claim, the asks, the swap and the release", 6, {
    prepare,
    start,
    check: async (fx, booted, op) => {
      const run = runs.get(fx)!
      const record = (await areaOf(booted.services, "ui"))!
      expect(op.steps.map((step) => step.kind)).toEqual(Object.values(Seat.KIND))
      // The seat moved once: the old conversation is listed once, and nothing is left to release.
      expect(record.owner).toEqual({
        sessionID: run.target.id,
        attached: true,
        previous: [{ sessionID: run.old.id, endedAt: fx.clock.now(), why: "seat" }],
      })
      expect(record.main).toEqual({ model: MODEL, chosenBy: "adopted" })
      expect(record.state).toBe("active")

      // The incoming conversation holds the owner's things once, the outgoing one only the user's rule.
      expect(fx.world.sessions.get(run.target.id)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
      expect([...run.target.entries.keys()].toSorted()).toEqual(
        [RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted(),
      )
      expect(run.target.entries.get(RoleInstructions.OWNER)).toEqual(
        RoleInstructions.owner({ team: fx.record, area: record, blocks: {} }),
      )
      expect(await Cursor.get(booted.services.kv, run.target.id)).toBe(SEQ)
      expect(fx.world.sessions.get(run.old.id)?.permissions).toEqual([COMPUTER])
      expect([...run.old.entries.keys()]).toEqual([])
      expect(run.old.metadata).toEqual({})

      // The request the old seat never took: withdrawn from it, sent to it only that first time, and delivered to
      // the new seat under one id however often the op ran.
      const dispatchID = run.dispatchID!
      const dispatches = await sent(booted)
      expect(run.target.inbox).toHaveLength(1)
      expect(run.old.inbox).toEqual([])
      expect(admitted(fx, run.old.id).map((item) => item.id)).toEqual([String(MsgID.dispatch(dispatchID, run.old.id))])
      expect(new Set(admitted(fx, run.target.id).map((item) => item.id))).toEqual(
        new Set([String(MsgID.dispatch(dispatchID, run.target.id))]),
      )
      expect(run.target.inbox[0]?.text).toContain("정렬 버그를 고쳐 주세요")
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]).toMatchObject({ id: dispatchID, state: "sent", sentTo: { sessionID: run.target.id } })

      // One line for the main, one summary line; no conversation made, no message to the main or the old seat.
      expect(await seatedLines(booted)).toHaveLength(1)
      expect(op.summary?.lines).toEqual([{ kind: "area", areaID: record.id, change: "seated" }])
      expect(fx.owners).toEqual([])
      expect(fx.backend.synthetic).toEqual([])
      expect(admitted(fx, MAIN_SESSION)).toEqual([])
    },
  })
})

describe("a kill or a cancel between the claim, the swap and the release", () => {
  test(
    "killed before the swap, and the owner changed meanwhile: the move ends as failed and the claim is taken back",
    async () => {
      const killed = await killedAfter(3)
      const run = killed.run
      // As the claim left it: listed, with the owner's things, the old seat still the owner.
      expect(killed.area.owner).toMatchObject({ sessionID: run.old.id, release: [run.target.id] })
      expect(killed.fx.world.sessions.get(run.target.id)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
      expect(run.target.entries.has(RoleInstructions.OWNER)).toBe(true)
      // Another conversation took the seat before the next start (the list of who to release stays with the seat).
      const third = conversation(killed.fx, SessionID.create(), killed.area.directory)
      killed.fx.world.sessions.get(third.id)!.permissions = [...OWNER_RULES, COMPUTER]
      await killed.first.services.write(TEAM_ID, () =>
        killed.first.services.registry.areas.put({
          ...killed.area,
          owner: {
            sessionID: third.id,
            attached: true,
            previous: [{ sessionID: run.old.id, endedAt: killed.fx.clock.now(), why: "user" }],
            release: [run.target.id],
          },
        }),
      )
      await killed.first.close()
      const second = boot(killed.fx)
      await second.controller.resume()
      const op = await drive(second, killed.opID)
      // Not a move that worked: the user reads why, and nothing says the seat was taken.
      expect(op.state).toBe("failed")
      expect(op.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "failed", "pending"])
      expect(op.steps[4]?.note).toBe("담당 대화가 그사이 바뀌었어요")
      // The sweep that follows every op takes the claim back.
      await until(async () => (await areaOf(second.services, "ui"))?.owner.release === undefined, 20_000)
      const record = (await areaOf(second.services, "ui"))!
      expect(record.owner).toEqual({
        sessionID: third.id,
        attached: true,
        previous: [{ sessionID: run.old.id, endedAt: killed.fx.clock.now(), why: "user" }],
      })
      // The chosen conversation is a plain one again; the seat's conversation was not touched.
      expect(killed.fx.world.sessions.get(run.target.id)?.permissions).toEqual([COMPUTER])
      expect([...run.target.entries.keys()]).toEqual([])
      expect(killed.fx.world.sessions.get(third.id)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
      expect(await seatedLines(second)).toEqual([])
      expect(op.summary).toBeUndefined()
      // The request that went back waits for the seat, whoever holds it: it goes to the owner there is.
      const dispatches = await sent(second)
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]).toMatchObject({ sentTo: { sessionID: third.id } })
      expect(run.target.inbox).toEqual([])
      expect(run.old.inbox).toEqual([])
      expect(third.inbox).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "killed after the swap of a promoted peer: the release still sends a waiting `fresh` request as a plain one and removes the peer entry",
    async () => {
      const fx = await fixture()
      const first = boot(fx, 4)
      await first.services.write(TEAM_ID, () => first.services.registry.teams.put(fx.record))
      await prepare(fx, first)
      const run = runs.get(fx)!
      // The chosen conversation is the area's peer.
      run.target.entries.set(RoleInstructions.PEER, "peer role")
      await first.services.write(TEAM_ID, async () => {
        const made = (await areaOf(first.services, "ui"))!
        await first.services.registry.areas.put({
          ...made,
          peers: [
            {
              key: "peer",
              sessionID: run.target.id,
              label: "리뷰어",
              role: "변경을 읽고 위험한 곳을 짚는다",
              attached: true,
              origin: "registered",
              at: fx.clock.now(),
            },
          ],
        })
      })
      const opID = await start(fx, first)
      const stopped = await drive(first, opID)
      expect(first.state.stopped).toBe(true)
      expect(stopped.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done", "pending"])
      const swapped = (await areaOf(first.services, "ui"))!
      expect(swapped.owner).toMatchObject({ sessionID: run.target.id, release: [run.old.id] })
      expect(swapped.peers).toBeUndefined()
      expect(run.target.entries.has(RoleInstructions.PEER)).toBe(true)
      // A request for a new conversation arrives while the move still holds the area.
      const fresh = await first.services.features().admit.dispatch({
        teamID: TEAM_ID,
        areaID: swapped.id,
        text: "새 대화에서 다시 살펴 주세요",
        from: "main",
        kind: "task",
        fresh: true,
      })
      expect(fresh).toMatchObject({ ok: true })
      await first.close()
      const second = boot(fx)
      await second.controller.resume()
      expect(await drive(second, opID)).toMatchObject({ state: "done" })

      const record = (await areaOf(second.services, "ui"))!
      expect(record.owner).toEqual({
        sessionID: run.target.id,
        attached: true,
        previous: [{ sessionID: run.old.id, endedAt: fx.clock.now(), why: "seat" }],
        // SM-23 (2026-11-14): the seat had no 담당 메모, so the promoted peer's role is kept as one.
        note: "변경을 읽고 위험한 곳을 짚는다",
      })
      expect([...run.target.entries.keys()].toSorted()).toEqual(
        [RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted(),
      )
      expect(fx.world.sessions.get(run.old.id)?.permissions).toEqual([COMPUTER])
      expect([...run.old.entries.keys()]).toEqual([])
      // The `fresh` request is a plain one now. It waits its turn behind the one the new seat has not taken yet.
      const dispatchID = run.dispatchID!
      await until(
        async () =>
          (await second.services.registry.dispatches.list(TEAM_ID)).some(
            (item) => item.id === dispatchID && item.state === "sent",
          ),
        20_000,
      )
      const waiting = (await second.services.registry.dispatches.list(TEAM_ID)).filter((item) => item.id !== dispatchID)
      expect(waiting).toHaveLength(1)
      expect(waiting[0]).toMatchObject({ state: "waiting", text: "새 대화에서 다시 살펴 주세요" })
      expect(waiting[0]?.fresh).toBeUndefined()
      // The conversation takes the first request; the outbox looks again, as it does on any event of the folder.
      run.target.inbox = []
      await second.services.features().admit.resume?.()
      // Both went to the conversation the user chose: none was made for the `fresh` one, and the chosen one is not
      // archived.
      const dispatches = await sent(second)
      expect(dispatches).toHaveLength(2)
      expect(dispatches.every((item) => item.fresh === undefined && item.sentTo?.sessionID === run.target.id)).toBe(
        true,
      )
      expect(run.target.inbox.map((item) => item.id)).toEqual([String(MsgID.dispatch(waiting[0]!.id, run.target.id))])
      expect(run.target.inbox[0]?.text).toContain("새 대화에서 다시 살펴 주세요")
      expect(run.target.metadata).toEqual({})
      expect(fx.owners).toEqual([])
      expect((await second.services.journal.list(TEAM_ID)).map((item) => item.kind)).toEqual(["seat"])
      const digest = await Digest.load(second.services.kv, TEAM_ID)
      expect(digest.entries.filter((entry) => entry.reason === "request-plain")).toHaveLength(1)
      expect(digest.entries.filter((entry) => entry.reason === "seated")).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "a cancel taken between the claim and the swap: the old seat stays the owner, the claim is taken back, the request returns to it once",
    async () => {
      const killed = await killedAfter(3)
      const run = killed.run
      expect(await killed.first.rpc("op.cancel", { opID: killed.opID })).toMatchObject({ op: { state: "cancelled" } })
      const op = (await killed.first.services.journal.get(TEAM_ID, killed.opID))!
      expect(op.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "skipped", "skipped"])
      const record = (await areaOf(killed.first.services, "ui"))!
      expect(record.owner).toEqual({ sessionID: run.old.id, attached: true, previous: [] })
      expect(killed.fx.world.sessions.get(run.target.id)?.permissions).toEqual([COMPUTER])
      expect([...run.target.entries.keys()]).toEqual([])
      // The old seat was never touched.
      expect(killed.fx.world.sessions.get(run.old.id)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
      expect([...run.old.entries.keys()].toSorted()).toEqual(
        [RoleInstructions.HANDOFF, RoleInstructions.OWNER].toSorted(),
      )
      expect(await seatedLines(killed.first)).toEqual([])
      // The request that went back is sent to the old seat again, under the id it had there.
      const dispatches = await sent(killed.first)
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]).toMatchObject({ sentTo: { sessionID: run.old.id } })
      expect(run.old.inbox.map((item) => item.id)).toEqual([String(MsgID.dispatch(run.dispatchID!, run.old.id))])
      expect(admitted(killed.fx, run.target.id)).toEqual([])
    },
    SLOW,
  )

  test(
    "a cancel taken between the swap and the release: the seat has moved, and what follows the move is done",
    async () => {
      const killed = await killedAfter(4)
      const run = killed.run
      expect(killed.area.owner).toMatchObject({ sessionID: run.target.id, release: [run.old.id] })
      expect(await killed.first.rpc("op.cancel", { opID: killed.opID })).toMatchObject({ op: { state: "cancelled" } })
      const record = (await areaOf(killed.first.services, "ui"))!
      expect(record.owner).toEqual({
        sessionID: run.target.id,
        attached: true,
        previous: [{ sessionID: run.old.id, endedAt: killed.fx.clock.now(), why: "seat" }],
      })
      expect(killed.fx.world.sessions.get(run.target.id)?.permissions).toEqual([...OWNER_RULES, COMPUTER])
      expect(killed.fx.world.sessions.get(run.old.id)?.permissions).toEqual([COMPUTER])
      expect([...run.old.entries.keys()]).toEqual([])
      expect(await seatedLines(killed.first)).toHaveLength(1)
      const dispatches = await sent(killed.first)
      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]).toMatchObject({ sentTo: { sessionID: run.target.id } })
      expect(run.target.inbox).toHaveLength(1)
      expect(run.old.inbox).toEqual([])
    },
    SLOW,
  )
})
