// The switch state machine (02 §5.3, §5.4, §5.9) driven through its events, hooks, timers and RPC handlers, with
// a fake session core and a manual clock.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session"
import { Provider } from "@opencode/schema/provider"
import { Account, Kv, Policy, Preset, Registry } from "@own/protocol"
import { Observe } from "../../../own-telemetry/src/observe.js"
import type { Variant } from "../../src/switching/variant.js"
import { failure, machine, type MachineInput } from "./harness.js"
import { PROVIDERS, registry } from "./support.js"

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const B = { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol", variant: "high" }
const OA = { providerID: PROVIDERS.oaiA, id: "gpt-5.5", variant: "high" }
const OB = { providerID: PROVIDERS.oaiB, id: "gpt-5.5", variant: "high" }
const SID = "ses_one"
const MINUTE = 60_000

async function started(model: Variant.Ref = A, input: MachineInput = {}) {
  const m = await machine({ models: { [SID]: model }, ...input })
  await m.send("session.created", { sessionID: SID, model, projectID: "p", slug: "s", version: "2", location: {} })
  await m.turn(SID, model, { input: 12_000 })
  await m.turn(SID, model, { input: 3_000, read: 150_000, output: 1_000 })
  return m
}

describe("manual switch (02 §5.9(a))", () => {
  test("estimate plans; apply on an idle session waits, switches, and cools down after model.selected", async () => {
    await using m = await started()
    const estimate = await m.rpc("switch.estimate", { sessionID: SID, target: B })
    if (failure(estimate) || !("estimateID" in estimate)) throw new Error("estimate failed")
    expect(estimate.context).toEqual({ P: 154_000, Z: 12_000, units: { source: "credits", target: "credits" } })
    expect(estimate.options.map((option) => option.strategy)).toEqual([
      "now",
      "compact-then-switch",
      "switch-then-compact",
      "cold-point",
      "new-session",
      "fork",
    ])
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({
      state: "PLANNED",
      estimateID: estimate.estimateID,
      target: B,
    })

    const applied = await m.rpc("switch.apply", {
      sessionID: SID,
      estimateID: estimate.estimateID,
      target: B,
      strategy: "now",
      reason: "manual",
    })
    expect(applied).toMatchObject({ state: "SWITCHING" })
    expect(m.calls.wait).toEqual([SID])
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
    await m.flush()

    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "COOLDOWN", requestsLeft: 20 })
    expect(m.events("binding.changed")).toEqual([
      expect.objectContaining({ model: B, previous: A, reason: "manual", external: false, accountID: "acc_codexB" }),
    ])
    const recorded = m.events("switch.recorded")
    expect(recorded).toEqual([
      expect.objectContaining({
        from: A,
        to: B,
        strategy: "now",
        reason: "manual",
        estimate: { lo: 13.77, hi: 13.77, unit: "credits" },
      }),
    ])
    expect(m.events("switch.state").map((event) => event.state)).toEqual(["PLANNED", "SWITCHING", "COOLDOWN"])
    expect(m.kv.get(Kv.switchState(SID))).toMatchObject({ state: "COOLDOWN" })
    expect(m.kv.get(Kv.home(SID))).toMatchObject({ providerID: PROVIDERS.codexA, pinned: false })
    expect(m.switching.coldExpected(SID, PROVIDERS.codexB)).toBe(154_000)

    // The first step on B closes the undo window and records the actual cold part.
    await m.turn(SID, B, { input: 150_000, write: 0, output: 500 })
    expect(m.events("switch.recorded")[1]).toMatchObject({ actual: { cold: 15, unit: "credits" } })
    expect(m.alerts).toEqual([])
    expect(failure(await m.rpc("switch.undo", { sessionID: SID }))?.type).toBe("undo_window_closed")
  })

  test("undo before the first step returns to the previous Ref without a cooldown", async () => {
    await using m = await started()
    await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "now", reason: "manual" })
    await m.flush()
    expect(await m.rpc("switch.undo", { sessionID: SID })).toEqual({ state: "STEADY" })
    await m.flush()
    expect(m.calls.switchModel.map((call) => call.model)).toEqual([B, A])
    expect(m.events("binding.changed").map((event) => event.reason)).toEqual(["manual", "undo"])
    expect(await m.rpc("switch.state", { sessionID: SID })).toEqual({ state: "STEADY", slot: PROVIDERS.codexA })
    expect(m.kv.has(Kv.switchState(SID))).toBe(false)
  })

  test("the same Ref is a no-op", async () => {
    await using m = await started()
    expect(await m.rpc("switch.apply", { sessionID: SID, target: A, strategy: "now", reason: "manual" })).toMatchObject(
      {
        state: "STEADY",
      },
    )
    expect(m.calls.switchModel).toEqual([])
  })

  test("a busy session waits (WAIT_SAFE); the prompt hook queues follow-ups; the turn end applies it", async () => {
    await using m = await started()
    await m.send("session.execution.started", { sessionID: SID })
    expect(m.switching.isBusy(SID)).toBe(true)
    expect(await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "now", reason: "manual" })).toMatchObject(
      {
        state: "WAIT_SAFE",
      },
    )
    expect(await m.prompt(SID)).toBe("queue")
    expect(m.calls.switchModel).toEqual([])
    await m.send("session.execution.succeeded", { sessionID: SID })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "COOLDOWN" })
    expect(await m.prompt(SID)).toBe("steer")
  })

  test("SWITCHING without model.selected within 30 s becomes FAILED", async () => {
    await using m = await machine({ models: { [SID]: A }, confirm: false })
    await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "now", reason: "manual" })
    m.clock.advance(31_000)
    await m.flush()
    expect(await m.rpc("switch.state", { sessionID: SID })).toEqual({
      state: "FAILED",
      error: "model_selected_timeout",
    })
  })

  test("an external model change is recorded, not blocked, and clears a pending plan", async () => {
    await using m = await started()
    await m.rpc("switch.estimate", { sessionID: SID, target: B })
    m.models.set(SID, OA)
    await m.send("session.model.selected", { sessionID: SID, model: OA, previous: A })
    await m.flush()
    expect(m.events("binding.changed")).toEqual([
      expect.objectContaining({ model: OA, previous: A, reason: "external", external: true, accountID: "acc_oaiA" }),
    ])
    expect(await m.rpc("switch.state", { sessionID: SID })).toEqual({ state: "STEADY", slot: PROVIDERS.oaiA })
  })

  test("a location-less event counts only for sessions this instance follows", async () => {
    await using m = await started()
    await m.send("session.model.selected", { sessionID: "ses_elsewhere", model: B, previous: A }, { located: false })
    await m.send("session.model.selected", { sessionID: SID, model: OA, previous: A }, { located: false })
    await m.send("session.model.selected", { sessionID: "ses_remote", model: B, previous: A }, { local: false })
    await m.flush()
    expect(m.events("binding.changed").map((event) => event.sessionID)).toEqual([SID])
  })

  test("estimates expire after 5 minutes; PLANNED falls back to the rest state", async () => {
    await using m = await started()
    const estimate = await m.rpc("switch.estimate", { sessionID: SID, target: B })
    if (failure(estimate) || !("estimateID" in estimate)) throw new Error("estimate failed")
    expect(
      failure(
        await m.rpc("switch.apply", {
          sessionID: SID,
          estimateID: "est_UNKNOWN",
          target: B,
          strategy: "now",
          reason: "manual",
        }),
      )?.type,
    ).toBe("estimate_expired")
    m.clock.advance(5 * MINUTE + 1)
    await m.flush()
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "STEADY" })
    const late = await m.rpc("switch.apply", {
      sessionID: SID,
      estimateID: estimate.estimateID,
      target: B,
      strategy: "now",
      reason: "manual",
    })
    expect(failure(late)).toMatchObject({ type: "estimate_expired", data: { estimateID: estimate.estimateID } })
  })

  test("cooldown ends after 30 minutes and 20 requests, whichever is later", async () => {
    await using m = await started()
    await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "now", reason: "manual" })
    await m.flush()
    m.clock.advance(31 * MINUTE)
    await m.flush()
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "COOLDOWN" })
    for (const _ of Array.from({ length: 20 })) await m.turn(SID, B, { input: 1_000, read: 150_000 })
    expect(await m.rpc("switch.state", { sessionID: SID })).toEqual({ state: "STEADY", slot: PROVIDERS.codexB })
  })
})

describe("compaction and scheduled switches (02 §5.9(b)(c)(d))", () => {
  test("compact-then-switch compacts on the server and switches after compaction.ended", async () => {
    await using m = await started()
    const applied = await m.rpc("switch.apply", {
      sessionID: SID,
      target: B,
      strategy: "compact-then-switch",
      reason: "manual",
    })
    // No client is needed: the plugin admits the compaction itself and asks no client to.
    expect(applied).toMatchObject({ state: "COMPACTING" })
    expect(applied).not.toHaveProperty("clientAction")
    expect(m.calls.compact).toEqual([{ sessionID: SID }])
    await m.send("session.compaction.started", { sessionID: SID, reason: "manual", recent: "" })
    expect(await m.prompt(SID)).toBe("queue")
    await m.send("session.compaction.ended", {
      sessionID: SID,
      reason: "manual",
      text: "summary",
      recent: "",
      tokens: { input: 0, output: 8_000, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
    expect(m.events("switch.recorded")[0]).toMatchObject({ strategy: "compact-then-switch", to: B })
  })

  test("compact-then-switch gives up after 10 minutes or on compaction.failed: PLANNED and an alert", async () => {
    await using m = await started()
    await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "compact-then-switch", reason: "manual" })
    m.clock.advance(10 * MINUTE + 1)
    await m.flush()
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "PLANNED", target: B })
    expect(m.alerts.map((alert) => alert.code)).toEqual(["compaction_failed"])

    await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "compact-then-switch", reason: "manual" })
    await m.send("session.compaction.failed", { sessionID: SID, reason: "manual", error: { type: "x", message: "x" } })
    await m.flush()
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "PLANNED" })
    expect(m.alerts.map((alert) => alert.code)).toEqual(["compaction_failed", "compaction_failed"])
  })

  for (const order of ["compaction, then reset", "reset, then compaction"] as const)
    test(`compact-then-switch switches at a context reset that settles its compaction as not needed (${order})`, async () => {
      await using m = await started()
      const reset = { type: "reset", payload: {}, delivery: "queue" }
      const enqueue = () => m.send("session.inbox.enqueued", { sessionID: SID, inboxID: "msg_reset", item: reset })
      // A reset already waiting for the turn: the compaction waits behind it.
      if (order === "reset, then compaction") await enqueue()
      await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "compact-then-switch", reason: "manual" })
      if (order === "compaction, then reset") await enqueue()
      // The reset applies (a stop, or the turn's end) and core cancels the compaction still pending (11 §7.2).
      await m.send("session.inbox.delivered", { sessionID: SID, inboxID: "msg_reset" })
      await m.send("session.inbox.cancelled", { sessionID: SID, inboxID: "msg_compaction" })
      await m.flush()
      expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
      expect(m.alerts).toEqual([])
    })

  test("compact-then-switch whose compaction cannot be admitted goes back to PLANNED with an alert", async () => {
    await using m = await started(A, { compact: "fail" })
    const applied = await m.rpc("switch.apply", {
      sessionID: SID,
      target: B,
      strategy: "compact-then-switch",
      reason: "manual",
    })
    expect(applied).toMatchObject({ state: "PLANNED" })
    expect(m.alerts.map((alert) => alert.code)).toEqual(["compaction_failed"])
    expect(m.calls.switchModel).toEqual([])
  })

  test("switch-then-compact switches first, then compacts on the server", async () => {
    await using m = await started()
    const applied = await m.rpc("switch.apply", {
      sessionID: SID,
      target: B,
      strategy: "switch-then-compact",
      reason: "hard",
    })
    expect(applied).toMatchObject({ state: "SWITCHING" })
    expect(applied).not.toHaveProperty("clientAction")
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
    expect(m.calls.compact).toEqual([{ sessionID: SID }])
  })

  test("a switch-then-compact that waited for the turn to end compacts once it switched", async () => {
    await using m = await started()
    await m.turn(SID, A, { input: 1_000, read: 154_000 }, "open")
    expect(
      await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "switch-then-compact", reason: "manual" }),
    ).toMatchObject({ state: "WAIT_SAFE" })
    expect(m.calls.compact).toEqual([])
    await m.send("session.execution.succeeded", { sessionID: SID })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
    expect(m.calls.compact).toEqual([{ sessionID: SID }])
  })

  test("cold point (either): 60 idle minutes for codex (uncertain), a user message restarts the clock", async () => {
    await using m = await started()
    const scheduled = await m.rpc("switch.schedule", { sessionID: SID, target: B, trigger: "either" })
    expect(scheduled).toMatchObject({ state: "SCHEDULED", trigger: "either", idleMinutes: 60, uncertain: true })
    expect(m.events("switch.scheduled")).toEqual([expect.objectContaining({ target: B, idleMinutes: 60 })])
    m.clock.advance(59 * MINUTE)
    await m.prompt(SID, "still here")
    await m.flush()
    m.clock.advance(59 * MINUTE)
    await m.flush()
    expect(m.calls.switchModel).toEqual([])
    m.clock.advance(2 * MINUTE)
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
    expect(m.events("switch.recorded")[0]).toMatchObject({ strategy: "cold-point" })
  })

  test("cold point (compaction): the next compaction.ended applies it; the deadline re-plans", async () => {
    await using m = await started()
    const first = await m.rpc("switch.schedule", { sessionID: SID, target: B, trigger: "compaction" })
    expect(first).toMatchObject({ deadline: m.clock.now() + 120 * MINUTE })
    await m.send("session.compaction.ended", { sessionID: SID, reason: "auto", text: "", recent: "" })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])

    await using other = await started()
    await other.rpc("switch.schedule", { sessionID: SID, target: B, trigger: "compaction", deadlineMinutes: 45 })
    other.clock.advance(46 * MINUTE)
    await other.flush()
    expect(await other.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "PLANNED", target: B })
  })

  test("a deadline shorter than the idle time is invalid_schedule", async () => {
    await using m = await started()
    const result = await m.rpc("switch.schedule", {
      sessionID: SID,
      target: B,
      trigger: "idle_ttl",
      idleMinutes: 60,
      deadlineMinutes: 30,
    })
    expect(failure(result)).toMatchObject({ type: "invalid_schedule", data: { idleMinutes: 60, deadlineMinutes: 30 } })
  })

  test("cancel drops WAIT_SAFE and SCHEDULED with their timers", async () => {
    await using m = await started()
    await m.rpc("switch.schedule", { sessionID: SID, target: B, trigger: "either" })
    const timers = m.clock.pending()
    expect(await m.rpc("switch.cancel", { sessionID: SID })).toEqual({ state: "STEADY" })
    expect(m.clock.pending()).toBeLessThan(timers)
    m.clock.advance(200 * MINUTE)
    await m.flush()
    expect(m.calls.switchModel).toEqual([])
  })
})

describe("client actions and delegation (02 §5.9(e)(f))", () => {
  test("fork and new-session return client actions, then record DELEGATED with the child", async () => {
    await using m = await started()
    expect(
      await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "fork", reason: "manual" }),
    ).toMatchObject({
      clientAction: { type: "fork", sessionID: SID, target: B },
    })
    expect(
      await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "new-session", reason: "manual" }),
    ).toMatchObject({ clientAction: { type: "create-session", sessionID: SID, target: B } })
    const delegated = await m.rpc("switch.apply", {
      sessionID: SID,
      target: B,
      strategy: "new-session",
      reason: "manual",
      childSessionID: "ses_child",
    })
    expect(delegated).toEqual({ state: "DELEGATED", detail: { state: "DELEGATED", childSessionID: "ses_child" } })
    expect(m.events("switch.state").map((event) => event.state)).toContain("DELEGATED")
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "STEADY" })
    expect(m.kv.get(Kv.home("ses_child"))).toMatchObject({ providerID: PROVIDERS.codexB })
    expect(m.calls.switchModel).toEqual([])
  })
})

describe("automatic triggers (02 §5.9(g), §5.10)", () => {
  test("API → API with autoSwitch on both switches at the turn end and suggests continuing", async () => {
    await using m = await started(OA)
    await m.retry(SID, OA, {
      class: "hard",
      accountID: Account.ID.make("acc_oaiA"),
      until: m.clock.now() + 60 * MINUTE,
    })
    await m.turn(SID, OA, { input: 100 }, "failed")
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: OB }])
    expect(m.events("switch.recorded")[0]).toMatchObject({ reason: "hard", to: OB })
    expect(m.events("switch.suggested")).toEqual([
      expect.objectContaining({
        reason: "hard",
        continue: true,
        candidates: expect.arrayContaining([expect.objectContaining({ providerID: OB.providerID })]),
      }),
    ])
  })

  test("a subscription never leaves automatically: PLANNED with a suggestion", async () => {
    await using m = await started(A)
    await m.retry(SID, A, { class: "hard" })
    await m.turn(SID, A, { input: 100 }, "failed")
    expect(m.calls.switchModel).toEqual([])
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({
      state: "PLANNED",
      target: B,
      reason: "hard",
    })
    expect(m.events("switch.suggested")[0]).toMatchObject({ reason: "hard", continue: true })
  })

  test("a target without the session's model is offered its group's default, not the slot's old default", async () => {
    await using m = await started(A)
    // The `oai` group default with its effort (07 §2.2); the registry still carries `slots[].defaultModel` with
    // `high`, which is no longer read.
    const defaultModel = Schema.decodeUnknownSync(Preset.DefaultModel)({
      id: "gpt-5.5",
      variant: "low",
      source: "user",
    })
    await m.deps.runtime.presets.write({ version: 1, groups: { oai: { defaultModel } } })
    m.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "local" })
    await m.flush()
    await m.retry(SID, A, { class: "hard" })
    await m.turn(SID, A, { input: 100 }, "failed")
    const suggested = m.events("switch.suggested")[0]?.candidates
    const target = (providerID: string) =>
      Array.isArray(suggested) ? suggested.find((item) => item.providerID === providerID)?.target : undefined
    expect(target(PROVIDERS.oaiA)).toEqual({ providerID: PROVIDERS.oaiA, id: "gpt-5.5", variant: "low" })
    expect(target(PROVIDERS.codexB)).toEqual(B)
  })

  test("planning never decides or writes a group default: without one the target's first model", async () => {
    await using m = await started(A)
    await m.retry(SID, A, { class: "hard" })
    await m.turn(SID, A, { input: 100 }, "failed")
    const suggested = m.events("switch.suggested")[0]?.candidates
    const target = Array.isArray(suggested)
      ? suggested.find((item) => item.providerID === PROVIDERS.oaiA)?.target
      : undefined
    expect(target).toEqual({ providerID: PROVIDERS.oaiA, id: "gpt-5.5" })
    expect(await Bun.file(m.deps.runtime.layout.presets).exists()).toBe(false)
  })

  test("with every other account exhausted the session is BLOCKED; waitReset prompts at the reset", async () => {
    await using m = await started(A)
    const until = m.clock.now() + 90 * MINUTE
    for (const id of ["acc_codexB", "acc_oaiA", "acc_oaiB"])
      m.deps.runtime.limits.exhaust({ accountID: Account.ID.make(id), windowId: null, until, class: "hard" })
    await m.retry(SID, A, { class: "hard", until })
    await m.turn(SID, A, { input: 100 }, "failed")
    expect(await m.rpc("switch.state", { sessionID: SID })).toEqual({
      state: "BLOCKED",
      reason: "all_exhausted",
      nextResetAt: until,
    })

    const waiting = await m.rpc("switch.waitReset", { sessionID: SID, message: "계속해" })
    if (failure(waiting) || !("resumeAt" in waiting)) throw new Error("waitReset failed")
    expect(waiting.resumeAt).toBeGreaterThanOrEqual(until + MINUTE)
    expect(waiting.resumeAt).toBeLessThanOrEqual(until + 3 * MINUTE)
    m.clock.advance(waiting.resumeAt - m.clock.now() + 1)
    await m.flush()
    // The source marks the prompt as own-accounts', not the user's (06 §10.4 #2).
    expect<unknown>(m.calls.prompt).toEqual([{ sessionID: SID, text: "계속해", metadata: { source: "own.accounts" } }])
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "STEADY" })
  })

  test("waitReset waits for what holds this model back: a Sonnet session not for the Opus week (LV)", async () => {
    for (const [model, wait] of [
      ["claude-sonnet-4-5", 2 * 60 * MINUTE],
      ["claude-opus-5-5", 5 * 24 * 60 * MINUTE],
    ] as const) {
      await using m = await started({ providerID: "anthropic", id: model })
      const at = m.clock.now()
      const exhausted = (id: string, resetAt: number) => ({
        id,
        accountID: Account.ID.claudeSlot,
        providerID: Provider.ID.anthropic,
        scope: "account" as const,
        kind: "rolling_quota" as const,
        label: id,
        status: "exhausted" as const,
        confidence: "live" as const,
        source: "header" as const,
        observedAt: at,
        resetAt,
      })
      // The tree's Claude account: its 5 hours are out for every model, its Opus week for Opus only.
      m.deps.runtime.limits.upsert([
        exhausted("claude.5h", at + 2 * 60 * MINUTE),
        exhausted("claude.7d_opus", at + 5 * 24 * 60 * MINUTE),
      ])
      const waiting = await m.rpc("switch.waitReset", { sessionID: SID, message: "계속" })
      if (failure(waiting) || !("resumeAt" in waiting)) throw new Error("waitReset failed")
      expect(waiting.resumeAt).toBeGreaterThanOrEqual(at + wait + MINUTE)
      expect(waiting.resumeAt).toBeLessThanOrEqual(at + wait + 3 * MINUTE)
    }
  })

  test("a used-up Opus week, recorded by the real retry hooks, waits for that week; Sonnet on the account does not (LV)", async () => {
    const OPUS = { providerID: "anthropic", id: "claude-opus-5-5" }
    const SONNET = { providerID: "anthropic", id: "claude-sonnet-4-5" }
    const OTHER = "ses_sonnet"
    await using m = await started(OPUS, { models: { [SID]: OPUS, [OTHER]: SONNET } })
    await m.send("session.created", {
      sessionID: OTHER,
      model: SONNET,
      projectID: "p",
      slug: "t",
      version: "2",
      location: {},
    })
    await m.turn(OTHER, SONNET, { input: 12_000 })
    // own-telemetry as the plugin runs it: the refused answer is observed, then core asks the retry hook.
    const observe = Observe.create({ runtime: m.deps.runtime, now: m.clock.now, log: { warn: () => {} } })
    const reset = Math.floor(m.clock.now() / 1000) + 5 * 24 * 3_600
    const unified = (values: Record<string, string>) =>
      Object.fromEntries(Object.entries(values).map(([name, value]) => [`anthropic-ratelimit-unified-${name}`, value]))
    await m.turn(SID, OPUS, { input: 100 }, "open")
    // SAFETY: hook events built from plain values, as core hands them to the plugin.
    await observe.onHttpResponse({
      sessionID: SID,
      agent: "build",
      model: OPUS,
      kind: "primary",
      request: new Request("http://fake.local/v1/messages", { method: "POST" }),
      response: new Response("{}", {
        status: 429,
        headers: unified({
          status: "rejected",
          reset: String(reset),
          "representative-claim": "seven_day_opus",
          "5h-status": "allowed",
          "5h-utilization": "0.12",
          "7d-status": "allowed",
          "7d-utilization": "0.44",
        }),
      }),
    } as unknown as SessionHttpResponse)
    const retry = {
      sessionID: SID,
      agent: "build",
      model: OPUS,
      error: { type: "provider.rate-limit", message: "rate limited", status: 429 },
      attempt: 1,
      decision: { retry: true, delay: 2_000 },
    } as unknown as SessionRetry
    await observe.onRetry(retry)
    expect(retry.decision).toEqual({ retry: false })
    await m.send("session.execution.failed", { sessionID: SID, error: { type: "provider", message: "usage limit" } })
    await m.flush()
    const waiting = await m.rpc("switch.waitReset", { sessionID: SID, message: "계속" })
    if (failure(waiting) || !("resumeAt" in waiting)) throw new Error("waitReset failed")
    // The Opus week's reset (plus the record's and the wait's jitter), not the 15-minute backoff.
    expect(waiting.resumeAt).toBeGreaterThan(reset * 1000 + MINUTE)
    expect(waiting.resumeAt).toBeLessThanOrEqual(reset * 1000 + 6 * MINUTE)
    // The Sonnet session on the same account is not held back: nothing to wait for, and no switch state of its own.
    expect(await m.rpc("switch.state", { sessionID: OTHER })).toMatchObject({ state: "STEADY" })
    expect(failure(await m.rpc("switch.waitReset", { sessionID: OTHER, message: "계속" }))?.message).toBe(
      "no_reset_known",
    )
  })

  test("waitReset reads the tree's Claude account as bindings do: a non-default one after a restart (LV)", async () => {
    const TWO = Account.ID.make("acc_01J9CLAUDETWO0000000000000")
    // After a restart the sync peek knows no binding yet and answers the default account; the binding says TWO.
    await using m = await started(
      { providerID: "anthropic", id: "claude-sonnet-4-5" },
      { claudeAccounts: { accountOf: async () => TWO, peek: () => Account.ID.claudeSlot } },
    )
    const at = m.clock.now()
    m.deps.runtime.limits.upsert([
      {
        id: "claude.5h",
        accountID: TWO,
        providerID: Provider.ID.anthropic,
        scope: "account",
        kind: "rolling_quota",
        label: "5시간",
        status: "exhausted",
        confidence: "live",
        source: "header",
        observedAt: at,
        resetAt: at + 2 * 60 * MINUTE,
      },
    ])
    const waiting = await m.rpc("switch.waitReset", { sessionID: SID, message: "계속" })
    if (failure(waiting) || !("resumeAt" in waiting)) throw new Error("waitReset failed")
    expect(waiting.resumeAt).toBeGreaterThanOrEqual(at + 2 * 60 * MINUTE + MINUTE)
    expect(waiting.resumeAt).toBeLessThanOrEqual(at + 2 * 60 * MINUTE + 3 * MINUTE)
  })

  test("repeated automatic switches open the breaker (flap alert) and later triggers only suggest", async () => {
    await using m = await started(OA)
    // Realistic sizes: the cold-sum rule compares cold tokens with 3·P, so a tiny P would trip it at once.
    const failing = { input: 1_000, read: 152_000 }
    await m.retry(SID, OA, { class: "hard" })
    await m.turn(SID, OA, failing, "failed")
    await m.turn(SID, OB, { input: 153_000 })
    await m.retry(SID, OB, { class: "hard" })
    await m.turn(SID, OB, failing, "failed")
    expect(m.calls.switchModel.map((call) => call.model)).toEqual([OB, OA])
    expect(m.alerts.map((alert) => alert.code)).toEqual(["flap"])
    await m.turn(SID, OA, { input: 1_000, read: 152_000 })
    await m.retry(SID, OA, { class: "auth" })
    await m.turn(SID, OA, failing, "failed")
    expect(m.calls.switchModel).toHaveLength(2)
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "PLANNED", reason: "auth" })
  })

  test("own-telemetry's exhaustion of the Claude slot (runtime broadcast) plans a suggestion, never a switch", async () => {
    const claude = { providerID: "anthropic", id: "claude-opus-5-5" }
    await using m = await started(claude)
    m.deps.runtime.broadcast.emit("exhausted", {
      exhaustion: {
        accountID: Account.ID.claudeSlot,
        windowId: "claude.5h",
        until: m.clock.now() + MINUTE,
        class: "hard",
      },
      providerID: "anthropic",
      sessionID: SID,
    })
    await m.flush()
    expect(m.calls.switchModel).toEqual([])
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "PLANNED", reason: "hard" })
    expect(m.events("switch.suggested")[0]).toMatchObject({ reason: "hard", continue: true })
    // A session this instance does not follow is not its business.
    m.deps.runtime.broadcast.emit("exhausted", {
      exhaustion: { accountID: Account.ID.claudeSlot, windowId: null, until: 1, class: "hard" },
      providerID: "anthropic",
      sessionID: "ses_other",
    })
    await m.flush()
    expect(m.events("switch.suggested")).toHaveLength(1)
  })

  test("review finding 4 (2026-10-11): another Claude account's exhaustion is not the session's", async () => {
    const claude = { providerID: "anthropic", id: "claude-opus-5-5" }
    await using m = await started(claude)
    // The session's tree runs on account 1; an exhaustion of the account it left (02 §8.8) plans nothing.
    m.deps.runtime.broadcast.emit("exhausted", {
      exhaustion: {
        accountID: Account.ID.make("acc_01J9CLAUDETWO0000000000000"),
        windowId: "claude.5h",
        until: m.clock.now() + MINUTE,
        class: "hard",
      },
      providerID: "anthropic",
      sessionID: SID,
    })
    await m.flush()
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "STEADY" })
    expect(m.events("switch.suggested")).toEqual([])
  })

  test("a trigger for a provider the session left, or not an own slot, is ignored", async () => {
    await using m = await started(OA)
    await m.retry(SID, { providerID: "openai", id: "gpt-5.5" }, { class: "hard" })
    await m.turn(SID, OA, { input: 100 }, "failed")
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "STEADY" })
  })
})

describe("admission gate AC-P26 (02 §5.3 method 2)", () => {
  const pending = { state: "WAIT_SAFE", target: B, strategy: "now", reason: "manual" } as const
  const remote = { ses_one: process.platform === "win32" ? "D:\\elsewhere" : "/elsewhere" }

  test("before AC-P26 the prompt hook never switches an idle session", async () => {
    await using m = await machine({
      models: { [SID]: A },
      kv: [[Kv.switchState(SID), pending]],
      locations: remote,
    })
    await m.flush()
    expect(await m.prompt(SID)).toBe("steer")
    expect(m.calls.switchModel).toEqual([])
  })

  test("after AC-P26 an idle session with a pending switch switches before admission", async () => {
    await using m = await machine({
      gates: { admissionSwitch: true },
      models: { [SID]: A },
      kv: [[Kv.switchState(SID), pending]],
      locations: remote,
    })
    await m.flush()
    expect(await m.prompt(SID)).toBe("steer")
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
  })
})

describe("restart (02 §5.4 재시작 뒤 다시 평가)", () => {
  test("a local WAIT_SAFE is applied; a remote Location's state is left alone", async () => {
    await using m = await machine({
      models: { [SID]: A, ses_two: A },
      kv: [
        [Kv.switchState(SID), { state: "WAIT_SAFE", target: B, strategy: "now", reason: "manual" }],
        [Kv.switchState("ses_two"), { state: "WAIT_SAFE", target: B, strategy: "now", reason: "manual" }],
      ],
      locations: { ses_two: process.platform === "win32" ? "D:\\elsewhere" : "/elsewhere" },
    })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: SID, model: B }])
  })

  test("a waitReset whose time passed during the restart asks instead of prompting", async () => {
    await using m = await machine({
      models: { [SID]: A },
      kv: [
        [
          Kv.switchState(SID),
          { state: "BLOCKED", reason: "all_exhausted", nextResetAt: 1, waitReset: { resumeAt: 2, message: "계속" } },
        ],
      ],
    })
    await m.flush()
    expect(m.calls.prompt).toEqual([])
    expect(m.events("switch.suggested")).toEqual([expect.objectContaining({ reason: "reset_passed", continue: true })])
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "STEADY" })
  })

  test("SWITCHING whose Ref already took effect cools down", async () => {
    await using m = await machine({
      models: { [SID]: B },
      kv: [[Kv.switchState(SID), { state: "SWITCHING", target: B, issuedAt: 1 }]],
    })
    await m.flush()
    expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "COOLDOWN" })
  })
})

describe("policy.json written by an older build (PG6, 07 §6.2 #9–#11)", () => {
  test("the leader drops the retired advice thresholds and defaults.global once at start", async () => {
    const old = {
      ...Policy.defaults,
      thresholds: {
        ...Policy.defaults.thresholds,
        compactAdviceUsedPercent: 85,
        compactMinTokens: 40_000,
        compactAfterSwitchMinTokens: 120_000,
        newSessionAdviceTokens: 150_000,
        unknownTtlIdleMinutes: 45,
      },
      defaults: { byKind: { codex: "acc_codexB" }, global: { providerID: PROVIDERS.oaiA, id: "gpt-5.5" } },
      futureField: { kept: true },
    }
    await using m = await machine({ policy: old })
    const written = await Bun.file(m.deps.runtime.layout.policy).json()
    expect(Object.keys(written.thresholds)).not.toContain("compactAdviceUsedPercent")
    expect(Object.keys(written.thresholds)).not.toContain("compactMinTokens")
    expect(Object.keys(written.thresholds)).not.toContain("compactAfterSwitchMinTokens")
    expect(Object.keys(written.thresholds)).not.toContain("newSessionAdviceTokens")
    expect(written.thresholds.unknownTtlIdleMinutes).toBe(45)
    expect(written.thresholds.confirm).toEqual(Policy.defaults.thresholds.confirm)
    expect(written.defaults).toEqual({ byKind: { codex: "acc_codexB" } })
    // A field of a later build survives, like every store write.
    expect(written.futureField).toEqual({ kept: true })
  })

  test("CAG-5: a stored automatic Claude-to-Claude switch is turned off once at start, with the notice pending", async () => {
    const stored = { ...Policy.defaults, autoSwitch: { ...Policy.defaults.autoSwitch, claudeToClaude: "auto" } }
    await using m = await machine({ policy: stored })
    const written = await Bun.file(m.deps.runtime.layout.policy).json()
    expect(written.autoSwitch.claudeToClaude).toBe("off")
    expect(written.migrated.claudeToClaudeOff).toMatchObject({ changed: true })
    expect(written.migrated.claudeToClaudeOff.noticed).toBeUndefined()
    const got = (await m.rpc("policy.get", {})) as unknown as { policy: Policy.File }
    expect(got.policy.migrated?.claudeToClaudeOff?.changed).toBe(true)
  })

  test("a clean policy.json is left untouched", async () => {
    const text = `${JSON.stringify(Policy.defaults)}\n`
    await using m = await machine({ policy: Policy.defaults })
    expect(await Bun.file(m.deps.runtime.layout.policy).text()).toBe(text)
  })
})

describe("targets, bindings and settings", () => {
  test("estimate errors: unknown own slot, retired, misconfigured, exhausted; apply BLOCKED and needs_reauth", async () => {
    const base = registry()
    const decode = Schema.decodeUnknownSync(Registry.File)
    const edited = decode({
      ...Schema.encodeSync(Registry.File)(base),
      accounts: Schema.encodeSync(Registry.File)(base).accounts.map((account) =>
        account.id === "acc_codexB"
          ? { ...account, status: "retired" }
          : account.id === "acc_oaiA"
            ? { ...account, status: "misconfigured" }
            : account.id === "acc_oaiB"
              ? { ...account, status: "needs_reauth" }
              : account,
      ),
    })
    await using m = await machine({ registry: edited, models: { [SID]: A } })
    const estimate = (target: { readonly providerID: string; readonly id: string }) =>
      m.rpc("switch.estimate", { sessionID: SID, target })
    expect(failure(await estimate({ providerID: "own-codex-zzzz", id: "gpt-5.6-sol" }))?.type).toBe("account_not_found")
    expect(failure(await estimate(B))).toMatchObject({ type: "no_eligible_target", data: { reasons: ["retired"] } })
    expect(failure(await estimate(OA))).toMatchObject({
      type: "slot_misconfigured",
      data: { problems: ["misconfigured"] },
    })
    expect(failure(await estimate({ providerID: PROVIDERS.codexA, id: "gpt-9" }))).toMatchObject({
      type: "slot_misconfigured",
      data: { problems: ["model_not_found"] },
    })
    expect(
      failure(await m.rpc("switch.apply", { sessionID: SID, target: OB, strategy: "now", reason: "manual" })),
    ).toMatchObject({
      type: "needs_reauth",
      data: { accountID: "acc_oaiB" },
    })
  })

  test("an exhausted target is no_eligible_target for estimate and BLOCKED for apply", async () => {
    await using m = await started()
    const until = m.clock.now() + 30 * MINUTE
    m.deps.runtime.limits.exhaust({
      accountID: Account.ID.make("acc_codexB"),
      windowId: "codex.primary",
      until,
      class: "hard",
    })
    expect(failure(await m.rpc("switch.estimate", { sessionID: SID, target: B }))).toMatchObject({
      type: "no_eligible_target",
      data: { reasons: ["exhausted"] },
    })
    expect(await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "now", reason: "manual" })).toEqual({
      state: "BLOCKED",
      detail: { state: "BLOCKED", reason: "target_exhausted", nextResetAt: until },
    })
  })

  test("session.binding resolves the account, builtin/thirdParty flags, home and switch state", async () => {
    await using m = await started()
    m.models.set("ses_builtin", { providerID: "openai", id: "gpt-5.5" })
    m.models.set("ses_claude", { providerID: "anthropic", id: "claude-opus-5-5" })
    const result = await m.rpc("session.binding", { sessionIDs: [SID, "ses_builtin", "ses_claude", "ses_none"] })
    if (failure(result) || !("bindings" in result)) throw new Error("binding failed")
    expect(result.bindings).toEqual([
      {
        sessionID: SID,
        model: A,
        accountID: "acc_codexA",
        builtin: false,
        thirdParty: false,
        home: PROVIDERS.codexA,
        switch: { state: "STEADY" },
      },
      {
        sessionID: "ses_builtin",
        model: { providerID: "openai", id: "gpt-5.5" },
        accountID: null,
        builtin: true,
        thirdParty: false,
        home: null,
        switch: { state: "STEADY" },
      },
      {
        sessionID: "ses_claude",
        model: { providerID: "anthropic", id: "claude-opus-5-5" },
        accountID: "acc_claude_slot",
        builtin: false,
        thirdParty: true,
        home: null,
        switch: { state: "STEADY" },
      },
      {
        sessionID: "ses_none",
        model: null,
        accountID: null,
        builtin: false,
        thirdParty: false,
        home: null,
        switch: { state: "STEADY" },
      },
    ])
  })

  test("a Claude Agent conversation is bound to its tree's account, never a built-in provider (02 §8.10)", async () => {
    // The composer showed `◌ 기본 claude-agent · 전역 계정 ⚠` with its effort greyed and no preset button: the binding
    // called every provider that is not an own slot or `anthropic` built-in, the Claude Agent route included.
    await using m = await started(A, {
      claudeAgent: {
        accountOf: async (sessionID) => (sessionID === "ses_agent" ? Account.ID.make("acc_agent1") : undefined),
      },
    })
    m.models.set("ses_agent", { providerID: "claude-agent", id: "claude-opus-5-5", variant: "high" })
    m.models.set("ses_gone", { providerID: "claude-agent", id: "claude-opus-5-5" })
    const result = await m.rpc("session.binding", { sessionIDs: ["ses_agent", "ses_gone"] })
    if (failure(result) || !("bindings" in result)) throw new Error("binding failed")
    expect(result.bindings.map((item) => [item.sessionID, item.accountID, item.builtin, item.thirdParty])).toEqual([
      ["ses_agent", "acc_agent1", false, false],
      // Without a Claude Agent account the provider does run on global credentials: the warning stays.
      ["ses_gone", null, true, false],
    ])
  })

  test("a session created without a model is pinned to the model the user configured", async () => {
    await using m = await machine({
      defaultModel: { providerID: PROVIDERS.oaiA, id: "gpt-5.5" },
      available: [{ providerID: PROVIDERS.codexA, id: "gpt-5.6-sol" }],
    })
    await m.send("session.created", { sessionID: "ses_new", projectID: "p", slug: "s", version: "2", location: {} })
    await m.flush()
    expect(m.calls.switchModel).toEqual([
      { sessionID: "ses_new", model: { providerID: PROVIDERS.oaiA, id: "gpt-5.5" } },
    ])
    expect(m.events("binding.changed")).toEqual([
      expect.objectContaining({ reason: "pin", external: false, previous: null }),
    ])
    expect(await m.rpc("switch.state", { sessionID: "ses_new" })).toEqual({ state: "STEADY" })
  })

  test("without a configured model, the session gets its group's default on the new-session account (07 §2.2)", async () => {
    // Core's default is only the first available model: nothing was configured.
    const first = { providerID: PROVIDERS.oaiA, id: "gpt-5.5" }
    await using m = await machine({ defaultModel: first, available: [first] })
    // The most recent top-level session ran on ChatGPT B; a child session on another account does not count.
    m.deps.runtime.sessions.update("ses_old", { parentID: null, providerID: PROVIDERS.codexB, modelID: "gpt-5.6-sol" })
    m.deps.runtime.sessions.update("ses_child", { parentID: "ses_old", providerID: PROVIDERS.oaiB, modelID: "gpt-5.5" })
    await m.send("session.created", { sessionID: "ses_new", projectID: "p", slug: "s", version: "2", location: {} })
    await m.flush()
    // The ChatGPT group's `auto` default (no Codex files, no prices: the newest, then the id), decided once.
    expect(m.calls.switchModel).toEqual([
      { sessionID: "ses_new", model: { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol" } },
    ])
    // Decided in memory for this session; the leader writes it when provider reloads settle (no fold here).
    expect<unknown>(m.presets.known("codex")).toEqual({ id: "gpt-5.6-sol", source: "auto", basis: "family-price" })
    expect(await Bun.file(m.deps.runtime.layout.presets).exists()).toBe(false)
  })

  test("a configured model whose account cannot serve now yields to the account rule (07 §2.2)", async () => {
    const first = { providerID: PROVIDERS.oaiA, id: "gpt-5.5" }
    const configured = { providerID: PROVIDERS.codexA, id: "gpt-5.6-terra" }
    await using m = await machine({ defaultModel: configured, available: [first, configured] })
    m.deps.runtime.limits.exhaust({
      accountID: Account.ID.make("acc_codexA"),
      windowId: null,
      until: m.clock.now() + 60 * MINUTE,
      class: "hard",
    })
    // The most recent session ran on the exhausted account too: the first account that can serve starts it.
    m.deps.runtime.sessions.update("ses_old", { parentID: null, providerID: PROVIDERS.codexA, modelID: "gpt-5.6-sol" })
    await m.send("session.created", { sessionID: "ses_new", projectID: "p", slug: "s", version: "2", location: {} })
    await m.flush()
    expect(m.calls.switchModel).toEqual([
      { sessionID: "ses_new", model: { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol" } },
    ])
  })

  test("the kind's default account wins, and a user default with its effort is used as is (07 §2.2)", async () => {
    const first = { providerID: PROVIDERS.oaiA, id: "gpt-5.5" }
    await using m = await machine({ defaultModel: first, available: [first] })
    await m.rpc("policy.set", { patch: { defaults: { byKind: { codex: "acc_codexA" } } } })
    await m.deps.runtime.presets.write({
      version: 1,
      groups: {
        codex: {
          defaultModel: Schema.decodeUnknownSync(Preset.DefaultModel)({
            id: "gpt-5.6-terra",
            variant: "high",
            source: "user",
          }),
        },
      },
    })
    m.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "local" })
    m.deps.runtime.sessions.update("ses_old", { parentID: null, providerID: PROVIDERS.codexB, modelID: "gpt-5.6-sol" })
    await m.send("session.created", { sessionID: "ses_new", projectID: "p", slug: "s", version: "2", location: {} })
    await m.flush()
    expect(m.calls.switchModel).toEqual([
      { sessionID: "ses_new", model: { providerID: PROVIDERS.codexA, id: "gpt-5.6-terra", variant: "high" } },
    ])
  })

  test("without sessions, the first ready account in order starts the session", async () => {
    const first = { providerID: PROVIDERS.oaiB, id: "gpt-5.5" }
    await using m = await machine({ defaultModel: first, available: [first] })
    await m.send("session.created", { sessionID: "ses_new", projectID: "p", slug: "s", version: "2", location: {} })
    await m.flush()
    expect(m.calls.switchModel).toEqual([
      { sessionID: "ses_new", model: { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol" } },
    ])
  })

  test("a first step far from the prediction raises estimator_drift", async () => {
    await using m = await started()
    await m.rpc("switch.apply", { sessionID: SID, target: B, strategy: "now", reason: "manual" })
    await m.flush()
    await m.turn(SID, B, { input: 60_000 })
    expect(m.alerts.map((alert) => alert.code)).toEqual(["estimator_drift"])
  })

  test("setConfirmOverride writes and clears the session KV", async () => {
    await using m = await started()
    expect(await m.rpc("switch.setConfirmOverride", { sessionID: SID, silentBelowTokens: 100_000 })).toEqual({
      silentBelowTokens: 100_000,
    })
    expect(m.kv.get(Kv.confirmOverride(SID))).toEqual({ silentBelowTokens: 100_000 })
    expect(await m.rpc("switch.setConfirmOverride", { sessionID: SID, silentBelowTokens: null })).toEqual({
      silentBelowTokens: null,
    })
    expect(m.kv.has(Kv.confirmOverride(SID))).toBe(false)
  })

  test("policy.set denies automatic subscription rotation and stores allowed patches", async () => {
    await using m = await started()
    const seen: string[] = []
    const stop = m.deps.runtime.broadcast.on("store.changed", (payload) => void seen.push(payload.store))
    expect(failure(await m.rpc("policy.set", { patch: { autoSwitch: { subscriptionToApi: "auto" } } }))).toMatchObject({
      type: "policy_denied",
      data: { field: "autoSwitch.subscriptionToApi" },
    })
    const set = await m.rpc("policy.set", { patch: { hysteresis: { cooldownMinutes: 5 }, horizonRequests: 12 } })
    expect(set).toMatchObject({
      policy: { hysteresis: { cooldownMinutes: 5, cooldownRequests: 20 }, horizonRequests: 12 },
    })
    expect((await m.deps.runtime.policy.read()).horizonRequests).toBe(12)
    expect(await m.rpc("policy.get", {})).toMatchObject({ policy: { horizonRequests: 12 } })
    expect(seen).toEqual(["policy"])
    stop()
    expect(Policy.defaults.horizonRequests).toBe(20)
  })
})
