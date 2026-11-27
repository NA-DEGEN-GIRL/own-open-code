// Context reset (core P-035, 11 §7; 02 §4.7.4): a delivered reset item and an undone reset are cold points, named
// once by the event dispatcher's tracker (`EventMeta.reset`), also for a delivery whose admission came before a
// restart (looked up in the session's context). Telemetry moves the session's cold point epoch and re-baselines every
// slot's cache state; the switching tracker leaves P unmeasured until the next step, with the fixed prefix after a
// reset and the restored size after an undo (the size before the reset plus what came after it, or the session
// history's figure), so a switch estimate never takes a restored context as empty. Fake events, manual clock.

import { describe, expect, test } from "bun:test"
import { Kv } from "@own/protocol"
import type { Module } from "../../src/module.js"
import { Resets } from "../../src/resets.js"
import { Tracker } from "../../src/switching/tracker.js"
import { failure, machine } from "../switching/harness.js"
import { PROVIDERS } from "../switching/support.js"
import { CODEX, SESSION, event, setup, step } from "./support.js"

const RESET_ID = "msg_reset_0001"

const enqueued = (at: number, directory: string, inboxID = RESET_ID, type = "reset") =>
  event({
    type: "session.inbox.enqueued",
    at,
    directory,
    data: {
      sessionID: SESSION,
      inboxID,
      item: { type, payload: type === "user" ? { text: "hi" } : {}, delivery: "queue" },
    },
  })
const delivered = (at: number, directory: string, inboxID = RESET_ID) =>
  event({ type: "session.inbox.delivered", at, directory, data: { sessionID: SESSION, inboxID } })
const undone = (at: number, directory: string) =>
  event({ type: "session.reset.undone", at, directory, data: { sessionID: SESSION, messageID: RESET_ID } })

/** The context core projects after a reset: its marker first, under the item's id. */
const marker = (id = RESET_ID) => ({ id, type: "compaction", status: "completed", reason: "reset", summary: "" })

describe("Resets.Tracker", () => {
  test("names a delivered reset item and an undo; a delivered prompt or a cancelled reset is none", async () => {
    const resets = new Resets.Tracker()
    expect(await resets.observe(enqueued(1, "/w", "msg_prompt", "user"))).toBeUndefined()
    expect(await resets.observe(delivered(2, "/w", "msg_prompt"))).toBeUndefined()
    expect(await resets.observe(enqueued(3, "/w"))).toBeUndefined()
    expect(await resets.observe(delivered(4, "/w"))).toEqual({ kind: "reset", sessionID: SESSION, resetID: RESET_ID })
    expect(await resets.observe(undone(6, "/w"))).toEqual({ kind: "undo", sessionID: SESSION, resetID: RESET_ID })
    await resets.observe(enqueued(7, "/w", "msg_reset_0002"))
    await resets.observe(
      event({
        type: "session.inbox.cancelled",
        at: 8,
        directory: "/w",
        data: { sessionID: SESSION, inboxID: "msg_reset_0002" },
      }),
    )
    expect(await resets.observe(delivered(9, "/w", "msg_reset_0002"))).toBeUndefined()
  })

  test("a delivery admitted before a restart is looked up: the context starts with its reset marker", async () => {
    const contexts: Record<string, ReadonlyArray<unknown>> = {
      [RESET_ID]: [marker(), { id: "msg_next", type: "user" }],
      msg_prompt: [{ id: "msg_prompt", type: "user" }],
    }
    const asked: string[] = []
    const lookup = Resets.contextLookup(async () => {
      const inboxID = asked.at(-1) ?? ""
      if (inboxID === "msg_fails") throw new Error("down")
      // SAFETY (test): the message fields the lookup reads.
      return (contexts[inboxID] ?? []) as never
    })
    const resets = new Resets.Tracker((sessionID, inboxID) => {
      asked.push(inboxID)
      return lookup(sessionID, inboxID)
    })
    expect(await resets.observe(delivered(1, "/w"))).toEqual({ kind: "reset", sessionID: SESSION, resetID: RESET_ID })
    expect(await resets.observe(delivered(2, "/w", "msg_prompt"))).toBeUndefined()
    expect(await resets.observe(delivered(3, "/w", "msg_fails"))).toBeUndefined()
    // An item admitted in this process needs no lookup.
    await resets.observe(enqueued(4, "/w", "msg_seen", "user"))
    expect(await resets.observe(delivered(5, "/w", "msg_seen"))).toBeUndefined()
    expect(asked).toEqual([RESET_ID, "msg_prompt", "msg_fails"])
  })
})

describe("telemetry", () => {
  test("a delivered reset and its undo each move the cold point epoch and re-baseline every slot", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const resets = new Resets.Tracker()
    const send = async (item: Module.OpenCodeEvent) => {
      const reset = await resets.observe(item)
      await t.telemetry.onEvent?.(item, { local: true, ...(reset === undefined ? {} : { reset }) })
    }
    const now = t.clock.now()
    for (const item of step({
      providerID: CODEX,
      messageID: "msg_0005",
      at: now,
      directory,
      usage: { input: 2_000, read: 8_000 },
    }))
      await send(item)
    await t.telemetry.flush()
    expect(t.storage.map.get(Kv.cache(SESSION, CODEX))).toMatchObject({
      epoch: 0,
      watermark: { messageID: "msg_0005" },
    })
    const before = t.emitted("cache.state").length

    // A prompt delivered meanwhile is no cold point.
    await send(enqueued(now + 1_000, directory, "msg_prompt", "user"))
    await send(delivered(now + 1_100, directory, "msg_prompt"))
    await send(enqueued(now + 2_000, directory))
    await send(delivered(now + 3_000, directory))
    await t.telemetry.flush()
    expect(t.storage.map.get(Kv.epoch(SESSION))).toBe(1)
    expect(t.storage.map.get(Kv.cache(SESSION, CODEX))).toMatchObject({
      watermark: null,
      blocksSince: 0,
      messageEndsSince: 0,
    })
    expect(t.emitted("cache.state").length).toBe(before + 1)

    await send(undone(now + 4_000, directory))
    await t.telemetry.flush()
    expect(t.storage.map.get(Kv.epoch(SESSION))).toBe(2)
    expect(t.emitted("cache.state").length).toBe(before + 2)
  })
})

describe("switching tracker", () => {
  test("a reset leaves the fixed prefix and its undo the restored size, unmeasured until the next step", () => {
    const tracker = new Tracker.Store()
    const at = 1_000
    const reset = { kind: "reset" as const, sessionID: SESSION, resetID: RESET_ID }
    for (const item of step({
      providerID: CODEX,
      messageID: "msg_0010",
      at,
      directory: "/w",
      usage: { input: 2_000, read: 98_000 },
    }))
      tracker.observe(item, at)
    expect(tracker.measured(SESSION)).toBe(true)
    expect(tracker.P(SESSION)).toBe(100_100)
    const epoch = tracker.epoch(SESSION)
    const Z = tracker.Z(SESSION)

    tracker.cold(reset, at + 1)
    expect(tracker.measured(SESSION)).toBe(false)
    expect(tracker.estimated(SESSION)).toBe(true)
    expect(tracker.P(SESSION)).toBe(Z)
    expect(tracker.get(SESSION)?.cleared).toBe(true)
    expect(tracker.epoch(SESSION)).toBe(epoch + 1)

    for (const item of step({
      providerID: CODEX,
      messageID: "msg_0011",
      at: at + 3,
      directory: "/w",
      usage: { input: Z + 3_000 },
    }))
      tracker.observe(item, at + 3)
    expect(tracker.P(SESSION)).toBe(Z + 3_100)
    expect(tracker.get(SESSION)?.cleared).toBe(false)

    tracker.cold({ ...reset, kind: "undo" }, at + 4)
    expect(tracker.measured(SESSION)).toBe(false)
    expect(tracker.epoch(SESSION)).toBe(epoch + 2)
    // The size before the reset plus what the conversation after it added above the fixed prefix.
    expect(tracker.P(SESSION)).toBe(100_100 + 3_100)
  })

  test("an undo of a reset it never saw has no figure until the session history gives one", () => {
    const tracker = new Tracker.Store()
    tracker.cold({ kind: "undo", sessionID: SESSION, resetID: RESET_ID }, 1)
    expect(tracker.estimated(SESSION)).toBe(false)
    tracker.estimate(SESSION, 201_000)
    expect(tracker.P(SESSION)).toBe(201_000)
  })

  test("the restored size from history: the last measured request before the marker plus the growth after it", () => {
    const assistant = (id: string, input: number, read: number, output: number) => ({
      id,
      type: "assistant",
      tokens: { input, output, reasoning: 0, cache: { read, write: 0 } },
    })
    const messages = [
      { id: "msg_1", type: "user" },
      assistant("msg_2", 2_000, 198_000, 500),
      { ...marker(), undone: 5 },
      { id: "msg_4", type: "user" },
      assistant("msg_5", 14_000, 0, 1_000),
      assistant("msg_6", 1_000, 15_000, 500),
    ]
    // SAFETY (test): the message fields the estimate reads.
    expect(Resets.restoredSize(messages as never, RESET_ID)).toBe(200_500 + (16_500 - 14_000))
    expect(Resets.restoredSize(messages.slice(2) as never, RESET_ID)).toBeUndefined()
  })
})

describe("a switch estimate right after an undo (02 §6.1)", () => {
  const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
  const B = { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol", variant: "high" }
  const SID = "ses_undo"
  const item = { type: "reset", payload: {}, delivery: "queue" }

  test("prices the restored 200k context, not an empty one", async () => {
    await using m = await machine({ models: { [SID]: A } })
    await m.send("session.created", { sessionID: SID, model: A, projectID: "p", slug: "s", version: "2", location: {} })
    await m.turn(SID, A, { input: 12_000 })
    await m.turn(SID, A, { input: 2_000, read: 198_000 })
    await m.send("session.inbox.enqueued", { sessionID: SID, inboxID: RESET_ID, item })
    await m.send("session.inbox.delivered", { sessionID: SID, inboxID: RESET_ID })
    await m.turn(SID, A, { input: 15_000, output: 1_000 })
    await m.send("session.reset.undone", { sessionID: SID, messageID: RESET_ID })
    const estimate = await m.rpc("switch.estimate", { sessionID: SID, target: B })
    if (failure(estimate) || !("estimateID" in estimate)) throw new Error("estimate failed")
    expect(estimate.context.P).toBe(200_000 + (16_000 - 12_000))
  })

  test("after a restart it sizes the restored context from the session's history", async () => {
    await using m = await machine({ models: { [SID]: A } })
    m.history.set(SID, [
      { id: "msg_1", type: "user" },
      {
        id: "msg_2",
        type: "assistant",
        tokens: { input: 2_000, output: 0, reasoning: 0, cache: { read: 198_000, write: 0 } },
      },
      { ...marker(), undone: 5 },
      { id: "msg_4", type: "user" },
      {
        id: "msg_5",
        type: "assistant",
        tokens: { input: 15_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ])
    await m.send("session.reset.undone", { sessionID: SID, messageID: RESET_ID })
    await m.flush()
    const estimate = await m.rpc("switch.estimate", { sessionID: SID, target: B })
    if (failure(estimate) || !("estimateID" in estimate)) throw new Error("estimate failed")
    expect(estimate.context.P).toBe(200_000 + (16_000 - 15_000))
  })
})
