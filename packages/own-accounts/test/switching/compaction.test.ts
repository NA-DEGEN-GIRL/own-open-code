// The session side of auto-compaction (02 §4.7.4): `compaction.setSession`, `compaction.due` detection, the staged
// revert guard, `switch.estimate.target.compactAt`, `policy.*` compaction defaults, the runtime session index, the
// approval mode bundles (03 §18.8), and location-less plugin-host events. Fake session core, manual clock.

import { describe, expect, test } from "bun:test"
import { Compaction, Kv } from "@own/protocol"
import type { Variant } from "../../src/switching/variant.js"
import { failure, machine, type MachineInput } from "./harness.js"
import { PROVIDERS } from "./support.js"

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const B = { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol", variant: "high" }
const SID = "ses_one"

/** A session on A with two steps (P = 154k as in the machine tests). */
async function started(model: Variant.Ref = A, input: MachineInput = {}) {
  const m = await machine({ models: { [SID]: model }, ...input })
  await m.send("session.created", { sessionID: SID, model, projectID: "p", slug: "s", version: "2", location: {} })
  await m.turn(SID, model, { input: 12_000 })
  await m.turn(SID, model, { input: 3_000, read: 150_000, output: 1_000 })
  return m
}

describe("compaction.setSession (02 §4.7.4)", () => {
  test("accepts [floor, slot) only, stores the value, and the view shows both markers", async () => {
    await using m = await started()
    expect(failure(await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 50_000 }))).toMatchObject({
      type: "setting_out_of_range",
      data: { field: "triggerTokens", min: 63_000, max: 741_199 },
    })
    expect(failure(await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 741_200 }))).toMatchObject({
      type: "setting_out_of_range",
    })
    const set = await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 200_000 })
    expect(set).toEqual({
      compaction: {
        providerID: PROVIDERS.codexA,
        modelID: "gpt-5.6-sol",
        windowTokens: 872_000,
        triggerTokens: 200_000,
        slotTriggerTokens: 741_200,
        source: "session",
        sessionTriggerTokens: 200_000,
        floorTokens: 63_000,
        keepTokens: 15_000,
        auto: true,
        P: 154_000,
        remainingTokens: 46_000,
        cycle: { Z: 12_000, delta: 3_000, summary: 8_000 },
        pendingDue: null,
      },
    })
    expect(m.kv.get(Kv.compaction(SID))).toMatchObject({ triggerTokens: 200_000 })
    // The switch target sees the same threshold (T = min(T_slot, T_session)).
    const estimate = await m.rpc("switch.estimate", { sessionID: SID, target: B })
    if (failure(estimate) || !("target" in estimate)) throw new Error("estimate failed")
    expect(estimate.target.compactAt).toEqual({ windowTokens: 872_000, triggerTokens: 200_000, source: "session" })
    expect(await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: null })).toMatchObject({
      compaction: { triggerTokens: 741_200, source: "v2", sessionTriggerTokens: null },
    })
    expect(m.kv.has(Kv.compaction(SID))).toBe(false)
  })

  test("an unpinned session has no view; only null is accepted", async () => {
    await using m = await machine()
    expect(await m.rpc("compaction.setSession", { sessionID: "ses_free", triggerTokens: null })).toEqual({
      compaction: null,
    })
    expect(
      failure(await m.rpc("compaction.setSession", { sessionID: "ses_free", triggerTokens: 100_000 })),
    ).toMatchObject({ type: "setting_out_of_range", data: { field: "triggerTokens", min: null, max: null } })
  })
})

describe("compaction.due (02 §4.7.4, §9.3)", () => {
  test("once per epoch, admitted on the server, repeated once with the same inputID, answered by compaction.started", async () => {
    await using m = await started()
    // P = 154k is already above the new value: the due goes out right away.
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.flush()
    const [first] = m.events("compaction.due")
    expect(first).toMatchObject({ sessionID: SID, P: 154_000, triggerTokens: 100_000, epoch: 0 })
    expect(String(first?.inputID)).toMatch(/^msg_/)
    // The plugin admits it itself under the due's id (upstream 924c12b291): no client has to be connected.
    expect(m.calls.compact).toEqual([{ sessionID: SID, id: String(first?.inputID) }])
    expect(m.kv.get(Kv.compactionDue(SID))).toMatchObject({ inputID: first?.inputID, epoch: 0 })
    const view = await m.switching.compactionView(SID)
    expect<unknown>(view?.pendingDue).toEqual({ inputID: first?.inputID, P: 154_000, triggerTokens: 100_000 })

    // Nothing started: the next step admits it once more with the same id (the same item), then stays quiet.
    await m.turn(SID, A, { input: 2_000, read: 154_000, output: 500 })
    await m.turn(SID, A, { input: 2_000, read: 156_000, output: 500 })
    expect(m.events("compaction.due").map((event) => event.inputID)).toEqual([first?.inputID, first?.inputID])
    expect(m.calls.compact.map((call) => call.id)).toEqual([String(first?.inputID), String(first?.inputID)])

    // It ran: started clears the record, ended moves the epoch and P drops below the value.
    await m.send("session.compaction.started", {
      sessionID: SID,
      reason: "manual",
      recent: "",
      inputID: first?.inputID,
    })
    await m.flush()
    expect(m.kv.has(Kv.compactionDue(SID))).toBe(false)
    await m.send("session.compaction.ended", {
      sessionID: SID,
      reason: "manual",
      text: "summary",
      recent: "",
      tokens: { input: 0, output: 8_000, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await m.turn(SID, A, { input: 40_000, output: 500 })
    expect(m.events("compaction.due")).toHaveLength(2)

    // The next epoch may send a new one.
    await m.turn(SID, A, { input: 5_000, read: 100_000, output: 500 })
    const third = m.events("compaction.due")[2]
    expect(third).toMatchObject({ epoch: 1, triggerTokens: 100_000 })
    expect(third?.inputID).not.toBe(first?.inputID)
  })

  test("the slot threshold alone never sends a due (core compacts by itself)", async () => {
    await using m = await started()
    await m.turn(SID, A, { input: 5_000, read: 250_000, output: 500 })
    expect(m.events("compaction.due")).toEqual([])
    expect(m.calls.compact).toEqual([])
  })

  test("a context reset waiting for the turn holds the due; cancelled, it no longer does", async () => {
    await using m = await started()
    const reset = { type: "reset", payload: {}, delivery: "queue" }
    await m.send("session.inbox.enqueued", { sessionID: SID, inboxID: "msg_reset", item: reset })
    // Applied, the reset would leave nothing to compact (core settles a compaction behind it as not needed).
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.turn(SID, A, { input: 2_000, read: 154_000, output: 500 })
    expect(m.events("compaction.due")).toEqual([])
    expect(m.calls.compact).toEqual([])
    await m.send("session.inbox.cancelled", { sessionID: SID, inboxID: "msg_reset" })
    await m.turn(SID, A, { input: 2_000, read: 156_000, output: 500 })
    expect(m.events("compaction.due")).toHaveLength(1)
    expect(m.calls.compact).toHaveLength(1)
  })

  test("after a resubscribe lost a reset's delivery, the due reads the server's inbox and goes out", async () => {
    await using m = await started()
    const reset = { type: "reset", payload: {}, delivery: "queue" }
    await m.send("session.inbox.enqueued", { sessionID: SID, inboxID: "msg_reset", item: reset })
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.turn(SID, A, { input: 2_000, read: 154_000, output: 500 })
    expect(m.events("compaction.due")).toEqual([])
    // The stream fell behind and was subscribed again: the reset's `session.inbox.delivered` never arrived here, and
    // the server's inbox no longer holds it.
    m.resubscribe()
    await m.turn(SID, A, { input: 2_000, read: 156_000, output: 500 })
    expect(m.events("compaction.due")).toHaveLength(1)
    expect(m.calls.compact).toHaveLength(1)
  })

  test("after a resubscribe lost a compaction's end, the due reads the session context and goes out", async () => {
    await using m = await started()
    await m.send("session.compaction.started", { sessionID: SID, reason: "manual", recent: "" })
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.turn(SID, A, { input: 2_000, read: 154_000, output: 500 })
    expect(m.events("compaction.due")).toEqual([])
    m.resubscribe()
    // No running compaction in the context: it ended while the stream was away.
    await m.turn(SID, A, { input: 2_000, read: 156_000, output: 500 })
    expect(m.events("compaction.due")).toHaveLength(1)
  })

  test("after a resubscribe, a reset admitted while the stream was away holds the due", async () => {
    await using m = await started()
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 200_000 })
    m.inbox.set(SID, [{ id: "msg_reset", type: "reset" }])
    m.resubscribe()
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.flush()
    expect(m.events("compaction.due")).toEqual([])
    // Its delivery arrives as an event again.
    m.inbox.delete(SID)
    await m.send("session.inbox.delivered", { sessionID: SID, inboxID: "msg_reset" })
    await m.turn(SID, A, { input: 2_000, read: 156_000, output: 500 })
    expect(m.events("compaction.due")).toHaveLength(1)
  })

  test("a server read that an event overtakes is dropped, and the next check reads again", async () => {
    await using m = await started()
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 200_000 })
    m.resubscribe()
    const read = Promise.withResolvers<void>()
    m.reads.gate = read.promise
    const checked = m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.flush()
    // A reset is admitted while the inbox read is on its way, which answered before it.
    const reset = { type: "reset", payload: {}, delivery: "queue" }
    await m.send("session.inbox.enqueued", { sessionID: SID, inboxID: "msg_reset", item: reset })
    read.resolve()
    await checked
    await m.flush()
    expect(m.events("compaction.due")).toEqual([])
    m.inbox.set(SID, [{ id: "msg_reset", type: "reset" }])
    await m.turn(SID, A, { input: 2_000, read: 156_000, output: 500 })
    expect(m.events("compaction.due")).toEqual([])
  })

  test("a revert the session staged since the last event stops the admission and the event", async () => {
    await using m = await started()
    // Not seen as an event yet: only the session itself has it, right before the admission.
    m.facts.set(SID, { revert: { messageID: "msg_r" } })
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.flush()
    expect(m.calls.compact).toEqual([])
    expect(m.events("compaction.due")).toEqual([])
    expect(m.deps.runtime.sessions.get(SID)?.revertStaged).toBe(true)
    expect(m.kv.has(Kv.compactionDue(SID))).toBe(false)
  })

  test("an id already delivered (409) counts as admitted; a failed admission still tells clients", async () => {
    await using conflict = await started(A, { compact: "conflict" })
    await conflict.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await conflict.flush()
    expect(conflict.calls.compact).toHaveLength(1)
    expect(conflict.events("compaction.due")).toHaveLength(1)

    // A connected client may still run it; the next step tries once more with the same id.
    await using failing = await started(A, { compact: "fail" })
    await failing.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await failing.flush()
    const [due] = failing.events("compaction.due")
    expect(due).toMatchObject({ sessionID: SID, triggerTokens: 100_000 })
    await failing.turn(SID, A, { input: 2_000, read: 154_000, output: 500 })
    expect(failing.calls.compact.map((call) => call.id)).toEqual([String(due?.inputID), String(due?.inputID)])
  })

  test("a staged revert blocks due, compact strategies and apply; cleared re-enables them", async () => {
    await using m = await started()
    await m.send("session.revert.staged", { sessionID: SID, revert: { messageID: "msg_r" } })
    await m.flush()
    expect(m.deps.runtime.sessions.get(SID)?.revertStaged).toBe(true)
    await m.rpc("compaction.setSession", { sessionID: SID, triggerTokens: 100_000 })
    await m.turn(SID, A, { input: 2_000, read: 154_000, output: 500 })
    expect(m.events("compaction.due")).toEqual([])
    expect((await m.switching.compactionView(SID))?.pendingDue).toBeNull()

    const estimate = await m.rpc("switch.estimate", { sessionID: SID, target: B })
    if (failure(estimate) || !("options" in estimate)) throw new Error("estimate failed")
    for (const strategy of ["compact-then-switch", "switch-then-compact"])
      expect(estimate.options.find((option) => option.strategy === strategy)).toMatchObject({
        available: false,
        reason: "revert_staged",
      })
    expect(
      failure(
        await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "compact-then-switch", reason: "manual" }),
      ),
    ).toMatchObject({ type: "revert_staged", data: { sessionID: SID } })

    await m.send("session.revert.cleared", { sessionID: SID })
    await m.turn(SID, A, { input: 2_000, read: 156_000, output: 500 })
    expect(m.events("compaction.due")).toHaveLength(1)
  })

  test("after a restart the staged revert comes from the session itself", async () => {
    await using m = await machine({ models: { [SID]: A }, sessions: { [SID]: { revert: { messageID: "msg_r" } } } })
    const applied = await m.rpc("switch.apply", {
      sessionID: SID,
      target: B,
      strategy: "compact-then-switch",
      reason: "manual",
    })
    expect(failure(applied)).toMatchObject({ type: "revert_staged" })
  })
})

describe("runtime session index and locality", () => {
  test("the session's Location writes binding, busy and P", async () => {
    await using m = await started()
    const sessions = m.deps.runtime.sessions
    expect(sessions.get(SID)).toMatchObject({ providerID: PROVIDERS.codexA, modelID: "gpt-5.6-sol", P: 154_000 })
    await m.turn(SID, A, { input: 1_000 }, "open")
    expect(sessions.get(SID)?.busy).toBe(true)
    expect(sessions.counts(PROVIDERS.codexA)).toEqual({ running: 1, total: 1 })
    await m.send("session.execution.succeeded", { sessionID: SID })
    expect(sessions.get(SID)?.busy).toBe(false)
    // Another Location's session is not written here.
    await m.send("session.execution.started", { sessionID: "ses_other" }, { local: false })
    expect(sessions.get("ses_other")).toBeUndefined()
    await m.send("session.deleted", { sessionID: SID })
    expect(sessions.get(SID)).toBeUndefined()
  })

  test("a session only known from a lookup still sees its own plugin-host switch (location-less event)", async () => {
    await using m = await machine({ models: { [SID]: A } })
    // No located event: the lookup in switch.apply places the session here.
    expect(await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "now", reason: "manual" })).toMatchObject(
      { state: "SWITCHING" },
    )
    await m.flush()
    expect(m.deps.places.get(SID)).toBe(true)
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "COOLDOWN" })
    expect(m.deps.runtime.sessions.get(SID)).toMatchObject({ providerID: PROVIDERS.codexB })
  })
})

describe("policy compaction defaults (02 §9.2 policy.get/set)", () => {
  test("get carries the code constants; set checks claude-sub, ranges and keep bounds, stores byKind", async () => {
    await using m = await machine()
    const got = await m.rpc("policy.get", {})
    if (failure(got) || !("compactionDefaults" in got)) throw new Error("policy.get failed")
    expect(got.compactionDefaults).toEqual(Compaction.defaults)
    expect(got.policy.compaction).toEqual({ byKind: {}, keepTokens: 15_000 })

    expect(
      failure(
        await m.rpc("policy.set", { patch: { compaction: { byKind: { "claude-sub": { triggerPercent: 50 } } } } }),
      ),
    ).toMatchObject({ type: "policy_denied", data: { field: "compaction.byKind.claude-sub" } })
    expect(
      failure(await m.rpc("policy.set", { patch: { compaction: { byKind: { ds: { triggerPercent: 5 } } } } })),
    ).toMatchObject({
      type: "setting_out_of_range",
      data: { field: "compaction.byKind.ds.triggerPercent", min: 10, max: 90 },
    })
    expect(failure(await m.rpc("policy.set", { patch: { compaction: { keepTokens: 100 } } }))).toMatchObject({
      type: "setting_out_of_range",
      data: { field: "compaction.keepTokens", min: 4_000, max: 60_000 },
    })

    const dry = await m.rpc("policy.set", {
      patch: { compaction: { byKind: { ds: { triggerPercent: 40 } } } },
      dryRun: true,
    })
    expect(dry).toMatchObject({ compactionImpact: { sessions: [] } })
    expect((await m.deps.runtime.policy.read()).compaction).toBeUndefined()

    const set = await m.rpc("policy.set", {
      patch: { compaction: { byKind: { ds: { triggerPercent: 40 }, compat: { maxTriggerTokens: 96_000 } } } },
    })
    expect(set).toMatchObject({
      policy: { compaction: { byKind: { ds: { triggerPercent: 40 }, compat: { maxTriggerTokens: 96_000 } } } },
    })
    const cleared = await m.rpc("policy.set", { patch: { compaction: { byKind: { ds: null } } } })
    expect(cleared).toMatchObject({ policy: { compaction: { byKind: { compat: { maxTriggerTokens: 96_000 } } } } })
    // policy.json never stores keepTokens.
    expect(JSON.stringify(await m.deps.runtime.policy.read())).not.toContain("keepTokens")
  })
})

describe("session.approval (v0.4, 03 §18.8)", () => {
  const PARENT = "ses_parent"
  const CHILD = "ses_child"
  const DONE = "ses_done"

  test("set writes the parent and unfinished children, keeps other rules, puts protected denies last", async () => {
    const saved = { action: "webfetch", resource: "https://example.test/*", effect: "allow" }
    await using m = await machine({
      models: { [PARENT]: A, [CHILD]: A, [DONE]: A },
      sessions: {
        [PARENT]: { permissions: [saved] },
        [CHILD]: { parentID: PARENT },
        [DONE]: { parentID: PARENT, outcome: "succeeded" },
      },
    })
    for (const child of [CHILD, DONE])
      await m.send("session.created", {
        sessionID: child,
        parentID: PARENT,
        model: A,
        projectID: "p",
        slug: "s",
        version: "2",
        location: {},
      })
    await m.flush()
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({
      mode: "custom",
      children: { open: 1 },
    })

    const set = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "read-only" })
    expect(set).toEqual({ mode: "read-only", patched: [PARENT, CHILD] })
    const rules = m.facts.get(PARENT)?.permissions ?? []
    expect(rules[0]).toEqual(saved)
    expect(rules.slice(1, 3)).toEqual([
      { action: "edit", resource: "**", effect: "deny" },
      { action: "shell", resource: "**", effect: "deny" },
    ])
    // Tools stay listed: no "*" resource and no wildcard action anywhere in the bundle.
    expect(rules.some((rule) => rule.resource === "*" || rule.action === "*")).toBe(false)
    const home = m.deps.runtime.layout.root.replaceAll("\\", "/")
    expect(rules.slice(3)).toContainEqual({ action: "read", resource: `${home}/vault/**`, effect: "deny" })
    expect(rules.at(-1)?.effect).toBe("deny")
    expect(m.events("approval.changed")).toEqual([
      expect.objectContaining({ sessionID: PARENT, mode: "read-only", patched: [PARENT, CHILD] }),
    ])
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({ mode: "read-only" })

    // Switching modes replaces only the own bundle.
    await m.rpc("session.approval.set", { sessionID: PARENT, mode: "full" })
    const full = m.facts.get(PARENT)?.permissions ?? []
    expect(full.filter((rule) => rule.resource === "**").map((rule) => [rule.action, rule.effect])).toEqual([
      ["edit", "allow"],
      ["shell", "allow"],
      ["webfetch", "allow"],
      ["websearch", "allow"],
    ])
    expect(full[0]).toEqual(saved)
    expect(full.at(-1)?.effect).toBe("deny")
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({ mode: "full" })
    expect(m.facts.get(DONE)?.permissions).toBeUndefined()
  })
})
