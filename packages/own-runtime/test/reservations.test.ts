// The presets gate's reservation map (07 §2.6 세는 법): caps checked and calls held in one synchronous step, released
// when the child shows up busy in the session index, settled by `execute.after`, taken back when the call never got a
// child. Driven through the runtime singleton's own session index; no vault, no network.

import { describe, expect, test } from "bun:test"
import { Runtime, Vault } from "../src/index.js"
import { tmpdir } from "./fixture.js"

let builds = 0

const ROOT = "ses_root"
const CAPS = { concurrent: 3, perMessage: 6, perSession: null }

async function setup() {
  const dir = await tmpdir()
  const runtime = await Runtime.acquire({
    buildId: `reservations-${process.pid}-${++builds}`,
    home: dir.path,
    vault: { transport: Vault.memory() },
  })
  runtime.sessions.update(ROOT, { busy: true })
  return {
    runtime,
    reservations: runtime.reservations,
    /** A new child call of the root for user message `message`. */
    fresh: (callID: string, message = "msg_1") => ({ root: ROOT, parent: ROOT, callID, message }),
    /** Core created the child and its execution started (`session.created`, `session.execution.started`). */
    start: (childID: string, parentID = ROOT) => {
      runtime.sessions.update(childID, { parentID })
      runtime.sessions.update(childID, { busy: true })
    },
    stop: (sessionID: string) => runtime.sessions.update(sessionID, { busy: false }),
    async [Symbol.asyncDispose]() {
      await runtime.release()
      await dir[Symbol.asyncDispose]()
    },
  }
}

describe("caps (07 §2.6)", () => {
  test("N calls of one step never pass the running cap: the check and the hold are one step", async () => {
    await using s = await setup()
    const taken = Array.from({ length: 8 }, (_, index) => s.reservations.take(s.fresh(`call_${index}`), CAPS))
    expect(taken.filter((item) => item.ok)).toHaveLength(3)
    expect(taken.slice(3)).toEqual(Array.from({ length: 5 }, () => ({ ok: false, cap: "concurrent", max: 3 })))
    // Refused calls count nowhere.
    expect(s.reservations.counts(ROOT)).toEqual({ running: 3, message: 3, session: 3, messageID: "msg_1" })
  })

  test("running = busy descendants + calls whose child has not shown up; a child showing up moves the count", async () => {
    await using s = await setup()
    expect(s.reservations.take(s.fresh("call_a"), CAPS)).toEqual({ ok: true })
    expect(s.reservations.take(s.fresh("call_b"), CAPS)).toEqual({ ok: true })
    expect(s.reservations.counts(ROOT).running).toBe(2)
    // The child of one call starts: it is counted once, as a busy child, not twice.
    s.start("ses_child_a")
    expect(s.reservations.counts(ROOT).running).toBe(2)
    // A grandchild counts toward the root too.
    s.start("ses_grandchild", "ses_child_a")
    expect(s.reservations.counts(ROOT).running).toBe(3)
    expect(s.reservations.take(s.fresh("call_c"), CAPS)).toEqual({ ok: false, cap: "concurrent", max: 3 })
    s.stop("ses_grandchild")
    s.stop("ses_child_a")
    expect(s.reservations.counts(ROOT).running).toBe(1)
    // Another root's children are not this root's.
    s.runtime.sessions.update("ses_other_root", { busy: true })
    s.start("ses_other_child", "ses_other_root")
    expect(s.reservations.counts(ROOT).running).toBe(1)
  })

  test("per message counts new children of one user message; the next message starts over", async () => {
    await using s = await setup()
    const caps = { ...CAPS, concurrent: 100 }
    for (const index of [1, 2, 3, 4, 5, 6]) expect(s.reservations.take(s.fresh(`call_${index}`), caps).ok).toBe(true)
    expect(s.reservations.take(s.fresh("call_7"), caps)).toEqual({ ok: false, cap: "perMessage", max: 6 })
    // `raiseOnce` raises the cap the gate passes for this message only.
    expect(s.reservations.take(s.fresh("call_7"), { ...caps, perMessage: 8 })).toEqual({ ok: true })
    expect(s.reservations.take(s.fresh("call_8", "msg_2"), caps)).toEqual({ ok: true })
    expect(s.reservations.counts(ROOT)).toMatchObject({ message: 1, session: 8, messageID: "msg_2" })
  })

  test("per conversation starts from the persisted count and is checked first", async () => {
    await using s = await setup()
    const caps = { ...CAPS, perSession: 10 }
    expect(s.reservations.take(s.fresh("call_a"), caps, 9)).toEqual({ ok: true })
    expect(s.reservations.take(s.fresh("call_b", "msg_2"), caps, 9)).toEqual({
      ok: false,
      cap: "perSession",
      max: 10,
    })
    // A stale persisted value never lowers the count.
    expect(s.reservations.counts(ROOT).session).toBe(10)
  })

  test("no conversation cap (the default): far past the old 100, only the running and per-message caps refuse", async () => {
    await using s = await setup()
    // 150 user messages of 6 new children each, every child done before the next message.
    for (const message of Array.from({ length: 150 }, (_, index) => `msg_${index}`)) {
      for (const index of [1, 2, 3, 4, 5, 6]) {
        const child = `ses_${message}_${index}`
        expect(s.reservations.take(s.fresh(`call_${child}`, message), { ...CAPS, concurrent: 6 }, 0)).toEqual({
          ok: true,
        })
        s.start(child)
        s.stop(child)
      }
      expect(s.reservations.take(s.fresh(`call_${message}_7`, message), { ...CAPS, concurrent: 6 })).toEqual({
        ok: false,
        cap: "perMessage",
        max: 6,
      })
    }
    expect(s.reservations.counts(ROOT).session).toBe(900)
    // A persisted count far above any old cap refuses nothing either; a cap the user set does.
    expect(s.reservations.take(s.fresh("call_late", "msg_late"), CAPS, 5000)).toEqual({ ok: true })
    expect(s.reservations.take(s.fresh("call_set", "msg_set"), { ...CAPS, perSession: 5000 })).toEqual({
      ok: false,
      cap: "perSession",
      max: 5000,
    })
  })

  test("a continued child counts only while it runs: idle -> the running cap, running already -> no cap at all", async () => {
    await using s = await setup()
    const caps = { concurrent: 2, perMessage: 1, perSession: 1 }
    s.runtime.sessions.update("ses_old", { parentID: ROOT })
    s.runtime.sessions.update("ses_older", { parentID: ROOT })
    const wake = (callID: string, child: string) => ({ root: ROOT, parent: ROOT, callID, child })
    expect(s.reservations.take(s.fresh("call_new"), caps)).toEqual({ ok: true })
    // An idle child waking needs a running slot; per message and per conversation do not count it.
    expect(s.reservations.take(wake("call_wake", "ses_old"), caps)).toEqual({ ok: true })
    expect(s.reservations.take(wake("call_wake_2", "ses_older"), caps)).toEqual({
      ok: false,
      cap: "concurrent",
      max: 2,
    })
    // The woken child shows up busy: matched by id, counted once.
    s.runtime.sessions.update("ses_old", { busy: true })
    expect(s.reservations.counts(ROOT).running).toBe(2)
    // Steering a running child adds nothing, even at the cap.
    expect(s.reservations.take(wake("call_steer", "ses_old"), caps)).toEqual({ ok: true })
    expect(s.reservations.counts(ROOT)).toMatchObject({ running: 2, message: 1, session: 1 })
  })
})

describe("settling a call", () => {
  test("a failed call whose child never ran is taken back from every count", async () => {
    await using s = await setup()
    s.reservations.take(s.fresh("call_a"), CAPS)
    expect(s.reservations.finish("call_a", { failed: true })).toMatchObject({ root: ROOT, callID: "call_a" })
    expect(s.reservations.counts(ROOT)).toEqual({ running: 0, message: 0, session: 0, messageID: "msg_1" })
    expect(s.reservations.finish("call_a", { failed: true })).toBeUndefined()
  })

  test("a failure after the child ran keeps the counts (the subagent was created)", async () => {
    await using s = await setup()
    s.reservations.take(s.fresh("call_a"), CAPS)
    s.start("ses_child")
    s.stop("ses_child")
    s.reservations.finish("call_a", { failed: true })
    expect(s.reservations.counts(ROOT)).toMatchObject({ running: 0, message: 1, session: 1 })
  })

  test("a background launch keeps counting until its child shows up busy", async () => {
    await using s = await setup()
    s.reservations.take(s.fresh("call_a", "msg_1"), CAPS)
    s.reservations.take(s.fresh("call_b", "msg_1"), CAPS)
    // `execute.after` came before the child's busy entry: still running.
    s.reservations.finish("call_b", { failed: false, launched: "ses_child_b" })
    expect(s.reservations.counts(ROOT).running).toBe(2)
    // The launched child is matched by id, not taken by the oldest call.
    s.start("ses_child_b")
    expect(s.reservations.counts(ROOT).running).toBe(2)
    s.stop("ses_child_b")
    expect(s.reservations.counts(ROOT).running).toBe(1)
    // The other call's child: the oldest held call of the root.
    s.start("ses_child_a")
    s.reservations.finish("call_a", { failed: false })
    expect(s.reservations.counts(ROOT).running).toBe(1)
    s.stop("ses_child_a")
    expect(s.reservations.counts(ROOT)).toMatchObject({ running: 0, message: 2, session: 2 })
  })

  test("the caller stopping releases what never got a child (a later hook refused it, an interrupt)", async () => {
    await using s = await setup()
    s.reservations.take(s.fresh("call_a"), CAPS)
    s.reservations.take(s.fresh("call_b"), CAPS)
    s.start("ses_child_a")
    s.stop(ROOT)
    // call_b's child never ran: taken back; call_a's child ran and still runs.
    expect(s.reservations.counts(ROOT)).toMatchObject({ running: 1, message: 1, session: 1 })
    expect(s.reservations.finish("call_a", { failed: false })).toBeUndefined()
  })

  test("a deleted root forgets its counts", async () => {
    await using s = await setup()
    s.reservations.take(s.fresh("call_a"), CAPS)
    s.runtime.sessions.remove(ROOT)
    expect(s.reservations.counts(ROOT)).toEqual({ running: 0, message: 0, session: 0 })
  })

  test("the notice and the root travel with the claim to execute.after", async () => {
    await using s = await setup()
    s.reservations.take({ ...s.fresh("call_a"), notice: "ran on the next target" }, CAPS)
    s.start("ses_child")
    expect(s.reservations.finish("call_a", { failed: false })).toMatchObject({
      root: ROOT,
      notice: "ran on the next target",
    })
  })
})
