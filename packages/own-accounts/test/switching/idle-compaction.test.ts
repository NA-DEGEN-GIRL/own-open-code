// Idle compaction before the cache expires (02 §4.7.7, CC 2026-10-24): an opt-in that admits one compaction per cold
// point epoch `leadSeconds` before `TTL_lo` after the last primary request started, only while every gate holds. Fake
// session core and telemetry, manual clock.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import { Home } from "@own/runtime"
import { CompactionCache, Kv } from "@own/protocol"
import { IdleCompaction } from "../../src/switching/idle-compaction.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import type { Variant } from "../../src/switching/variant.js"
import { machine, type MachineInput } from "./harness.js"
import { PROVIDERS } from "./support.js"

// Several fake modules per test: more than Bun's 5 s default under load.
setDefaultTimeout(60_000)

const OAI = { providerID: PROVIDERS.oaiA, id: "gpt-5.5", variant: "high" }
const CODEX = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const SID = "ses_idle"
const TTL = 30 * 60_000
const LEAD = CompactionCache.IDLE.leadSeconds * 1000

/** A session with one 150k turn; telemetry reports that turn's request start and a 30-minute cache. */
async function idleSession(
  options: {
    readonly model?: Variant.Ref
    readonly enabled?: boolean
    readonly ttl?: { readonly lo: number; readonly hi: number | null }
    readonly input?: MachineInput
    readonly tokens?: number
  } = {},
) {
  const model = options.model ?? OAI
  const holder: { startedAt: number; moved: boolean } = { startedAt: 0, moved: false }
  const primaryCache: Telemetry.Api["primaryCache"] = async () => ({
    model: Schema.decodeUnknownSync(Model.Ref)(model),
    providerID: model.providerID,
    kind: model.providerID === PROVIDERS.codexA ? "codex" : "oai",
    startedAt: holder.startedAt,
    ttl: options.ttl ?? { lo: TTL, hi: TTL },
    moved: holder.moved,
  })
  const logs: string[] = []
  const m = await machine({ models: { [SID]: model }, telemetry: { primaryCache }, logs, ...options.input })
  if (options.enabled ?? true) await m.rpc("policy.set", { patch: { compaction: { idle: { enabled: true } } } })
  await m.send("session.created", { sessionID: SID, model, projectID: "p", slug: "s", version: "2", location: {} })
  holder.startedAt = m.clock.now()
  await m.turn(SID, model, { input: 10_000, read: (options.tokens ?? 150_000) - 10_000 })
  /** The idle compaction outcomes the module logged. */
  const outcomes = () =>
    logs.flatMap((line) => {
      const entry = JSON.parse(line) as { readonly msg?: string; readonly outcome?: string }
      return entry.msg === "idle_compaction" ? [String(entry.outcome)] : []
    })
  return { m, holder, outcomes }
}

/** Advances the clock to `at` after the turn's request start and lets queued work run. */
async function until(m: Awaited<ReturnType<typeof idleSession>>["m"], startedAt: number, at: number) {
  m.clock.advance(startedAt + at - m.clock.now())
  await m.flush()
}

describe("idle compaction (02 §4.7.7)", () => {
  test("fires once, lead seconds before TTL_lo after the request start, admits under its own id, and logs it", async () => {
    const { m, holder, outcomes } = await idleSession()
    await using _ = m
    await until(m, holder.startedAt, TTL - LEAD - 1)
    expect(m.calls.compact).toEqual([])
    await until(m, holder.startedAt, TTL - LEAD)
    expect(m.calls.compact).toHaveLength(1)
    const record = m.kv.get(Kv.idleCompaction(SID)) as {
      readonly inputID: string
      readonly epoch: number
      readonly deadline: number
    }
    expect(m.calls.compact[0]).toEqual({ sessionID: SID, id: record.inputID })
    expect([record.epoch, record.deadline]).toEqual([0, holder.startedAt + TTL])
    // The compaction hook finds it by the running compaction core delivered (CC-16), not by the events.
    expect(await m.switching.idleCompaction(SID)).toBeUndefined()
    m.delivered.set(SID, record.inputID)
    expect(await m.switching.idleCompaction(SID)).toEqual({})
    await m.send("session.compaction.started", { sessionID: SID, reason: "manual", recent: "", inputID: record.inputID })
    await m.send("session.compaction.failed", { sessionID: SID, reason: "manual", error: { type: "x", message: "x" } })
    m.delivered.delete(SID)
    expect(await m.switching.idleCompaction(SID)).toBeUndefined()
    await m.deps.runtime.ledger.flush()
    const events = await m.deps.runtime.ledger.eventsOf(Home.month(m.clock.now()))
    expect(events.filter((event) => event.type === "compaction.idle")).toMatchObject([
      { sessionID: SID, data: { outcome: "admitted", ttlMs: TTL, P: 150_000 } },
    ])

    // A failed one is not tried again in the same epoch.
    holder.startedAt = m.clock.now()
    await m.turn(SID, OAI, { input: 10_000, read: 140_000 })
    await until(m, holder.startedAt, TTL - LEAD)
    expect(m.calls.compact).toHaveLength(1)
    expect(outcomes()).toEqual(["admitted", "epoch"])
  })

  // SL-8: the session's tree moved to another Claude account after its last request; that account has none of the
  // cache, so there is nothing to keep warm.
  test("a Claude account switch since the last request skips it: the next account's cache is empty", async () => {
    const before = await idleSession()
    before.holder.moved = true
    await until(before.m, before.holder.startedAt, TTL - LEAD)
    expect(before.m.calls.compact).toEqual([])
    expect(before.outcomes()).toEqual(["account"])
    await before.m[Symbol.asyncDispose]()

    // Moved before the turn ended: no timer at all.
    const after = await idleSession()
    after.holder.moved = true
    after.holder.startedAt = after.m.clock.now()
    await after.m.turn(SID, OAI, { input: 10_000, read: 140_000 })
    await until(after.m, after.holder.startedAt, TTL)
    expect(after.m.calls.compact).toEqual([])
    expect(after.outcomes()).toEqual([])
    await after.m[Symbol.asyncDispose]()
  })

  test("off by default", async () => {
    const { m, holder } = await idleSession({ enabled: false })
    await using _ = m
    await until(m, holder.startedAt, TTL)
    expect(m.calls.compact).toEqual([])
  })

  test("a new request, a pending inbox item or permission, a small context and a short absence skip it", async () => {
    const small = await idleSession({ tokens: 60_000 })
    await until(small.m, small.holder.startedAt, TTL - LEAD)
    expect(small.m.calls.compact).toEqual([])
    expect(small.outcomes()).toEqual(["small"])
    await small.m[Symbol.asyncDispose]()

    const pending = await idleSession()
    await pending.m.send("session.inbox.enqueued", { sessionID: SID, inboxID: "msg_queued", item: {} })
    await pending.m.send("permission.asked", { sessionID: SID, id: "per_1" })
    await pending.m.send("session.inbox.delivered", { sessionID: SID, inboxID: "msg_queued" })
    await until(pending.m, pending.holder.startedAt, TTL - LEAD)
    expect(pending.m.calls.compact).toEqual([])
    expect(pending.outcomes()).toEqual(["pending"])
    await pending.m[Symbol.asyncDispose]()

    // The user came back: the next step cancels the timer, and its own end arms a new one.
    const back = await idleSession()
    await until(back.m, back.holder.startedAt, 10 * 60_000)
    await back.m.send("session.execution.started", { sessionID: SID })
    await until(back.m, back.holder.startedAt, TTL - LEAD)
    expect(back.m.calls.compact).toEqual([])
    expect(back.outcomes()).toEqual([])
    await back.m[Symbol.asyncDispose]()

    // A laptop that slept past the deadline wakes to a cold cache: nothing to save.
    const slept = await idleSession()
    await until(slept.m, slept.holder.startedAt, 2 * TTL)
    expect(slept.m.calls.compact).toEqual([])
    expect(slept.outcomes()).toEqual(["expired"])
    await slept.m[Symbol.asyncDispose]()

    // 5-minute caches never leave the 20 minutes away that the gate asks for.
    const short = await idleSession({ ttl: { lo: 300_000, hi: 300_000 } })
    await until(short.m, short.holder.startedAt, 300_000 - LEAD)
    expect(short.m.calls.compact).toEqual([])
    expect(short.outcomes()).toEqual(["away"])
    await short.m[Symbol.asyncDispose]()
  })

  test("a context reset leaves the size unmeasured until a step measures it, so it skips as small (11 §7)", async () => {
    const { m, holder, outcomes } = await idleSession()
    await using _ = m
    const item = { type: "reset", payload: {}, delivery: "queue" }
    await m.send("session.inbox.enqueued", { sessionID: SID, inboxID: "msg_reset", item })
    await m.send("session.execution.started", { sessionID: SID })
    await m.send("session.inbox.delivered", { sessionID: SID, inboxID: "msg_reset" })
    await m.send("session.execution.succeeded", { sessionID: SID })
    await until(m, holder.startedAt, TTL - LEAD)
    expect(m.calls.compact).toEqual([])
    expect(outcomes()).toEqual(["small"])
  })

  test("ChatGPT, caches without a sure end, child, team and imported sessions, and staged reverts are left alone", async () => {
    const cases = [
      [await idleSession({ model: CODEX }), []],
      [await idleSession({ ttl: { lo: TTL, hi: null } }), []],
      [await idleSession({ input: { sessions: { [SID]: { parentID: "ses_parent" } } } }), ["session"]],
      [await idleSession({ input: { sessions: { [SID]: { metadata: { "own.team": { role: "main" } } } } } }), ["session"]],
      [await idleSession({ input: { sessions: { [SID]: { metadata: { "own.import": { source: "codex" } } } } } }), ["session"]],
    ] as const
    for (const [item, outcomes] of cases) {
      await until(item.m, item.holder.startedAt, TTL - LEAD)
      expect(item.m.calls.compact).toEqual([])
      expect(item.outcomes()).toEqual([...outcomes])
      await item.m[Symbol.asyncDispose]()
    }
    const staged = await idleSession({ input: { sessions: { [SID]: { revert: { messageID: "msg_1" } } } } })
    await using _ = staged.m
    await until(staged.m, staged.holder.startedAt, TTL - LEAD)
    expect(staged.m.calls.compact).toEqual([])
    expect(await staged.m.switching.idleCompaction(SID)).toBeUndefined()
    expect(staged.outcomes()).toEqual(["revert_staged"])
  })

  test("a screen that shows the session holds it back while away detection is on", async () => {
    const shown = await idleSession()
    // The user reads the long answer: the client reports the session about once a minute, the last 5 minutes ago.
    await until(shown.m, shown.holder.startedAt, TTL - LEAD - 5 * 60_000)
    expect(await shown.m.rpc("session.presence", { sessionID: SID })).toEqual({})
    await until(shown.m, shown.holder.startedAt, TTL - LEAD)
    expect(shown.m.calls.compact).toEqual([])
    expect(shown.outcomes()).toEqual(["present"])
    await shown.m[Symbol.asyncDispose]()

    // Hidden for `hiddenMinutes` (10): away.
    const hidden = await idleSession()
    await until(hidden.m, hidden.holder.startedAt, TTL - LEAD - 11 * 60_000)
    await hidden.m.rpc("session.presence", { sessionID: SID })
    await until(hidden.m, hidden.holder.startedAt, TTL - LEAD)
    expect(hidden.m.calls.compact).toHaveLength(1)
    await hidden.m[Symbol.asyncDispose]()

    // Away detection off: only the idle time counts.
    const off = await idleSession()
    await using _ = off.m
    await off.m.rpc("policy.set", { patch: { awayDetect: { enabled: false } } })
    await until(off.m, off.holder.startedAt, TTL - LEAD - 60_000)
    await off.m.rpc("session.presence", { sessionID: SID })
    await until(off.m, off.holder.startedAt, TTL - LEAD)
    expect(off.m.calls.compact).toHaveLength(1)
  })

  test("a busy subagent skips it", async () => {
    const { m, holder, outcomes } = await idleSession()
    await using _ = m
    m.deps.runtime.sessions.update("ses_child", { parentID: SID, busy: true })
    await until(m, holder.startedAt, TTL - LEAD)
    expect(m.calls.compact).toEqual([])
    expect(outcomes()).toEqual(["children"])
  })
})

describe("idle compaction's tag (02 §4.7.7, CC-16)", () => {
  test("the running compaction in the session's history decides, whatever order the events come in", async () => {
    const { m, holder } = await idleSession()
    await using _ = m
    await until(m, holder.startedAt, TTL - LEAD)
    const record = m.kv.get(Kv.idleCompaction(SID)) as { readonly inputID: string }
    // A user's `/compact` raced it and delivered first; its started event has not reached the module yet.
    m.delivered.set(SID, "msg_users_compact")
    expect(await m.switching.idleCompaction(SID)).toBeUndefined()
    m.delivered.set(SID, record.inputID)
    expect(await m.switching.idleCompaction(SID)).toEqual({})
  })

  test("after a restart, the item this epoch's record names is still tagged when it delivers", async () => {
    const record = { epoch: 0, inputID: "msg_idle_before_restart", at: 1, deadline: Date.UTC(2100, 0, 1) }
    const restarted = await idleSession({ enabled: false, input: { kv: [[Kv.idleCompaction(SID), record]] } })
    await using _ = restarted.m
    expect(await restarted.m.switching.idleCompaction(SID)).toBeUndefined()
    restarted.m.delivered.set(SID, record.inputID)
    expect(await restarted.m.switching.idleCompaction(SID)).toEqual({})
    // Another `/compact` is the user's own.
    restarted.m.delivered.set(SID, "msg_users_compact")
    expect(await restarted.m.switching.idleCompaction(SID)).toBeUndefined()
  })

  test("an item that delivers after its deadline or after the user came back is dropped, not run", async () => {
    // Delivered only after the cache cooled (a restart between admission and delivery, say).
    const late = await idleSession()
    await until(late.m, late.holder.startedAt, TTL - LEAD)
    const lateRecord = late.m.kv.get(Kv.idleCompaction(SID)) as { readonly inputID: string }
    late.m.clock.advance(LEAD)
    late.m.delivered.set(SID, lateRecord.inputID)
    expect(await late.m.switching.idleCompaction(SID)).toEqual({ drop: IdleCompaction.DROPPED.late })
    expect(late.outcomes()).toEqual(["admitted", "late"])
    await late.m.deps.runtime.ledger.flush()
    const events = await late.m.deps.runtime.ledger.eventsOf(Home.month(late.m.clock.now()))
    expect(events.filter((event) => event.type === "compaction.idle").map((event) => event.data?.outcome)).toEqual([
      "admitted",
      "late",
    ])
    await late.m[Symbol.asyncDispose]()

    // The user sent a prompt, which woke the runner: the pending idle item would deliver first.
    const prompted = await idleSession()
    await until(prompted.m, prompted.holder.startedAt, TTL - LEAD)
    const promptedRecord = prompted.m.kv.get(Kv.idleCompaction(SID)) as { readonly inputID: string }
    prompted.m.clock.advance(1_000)
    await prompted.m.prompt(SID)
    prompted.m.delivered.set(SID, promptedRecord.inputID)
    expect(await prompted.m.switching.idleCompaction(SID)).toEqual({ drop: IdleCompaction.DROPPED.returned })
    await prompted.m[Symbol.asyncDispose]()

    // A screen shows the session again (away detection on).
    const shown = await idleSession()
    await using _ = shown.m
    await until(shown.m, shown.holder.startedAt, TTL - LEAD)
    const shownRecord = shown.m.kv.get(Kv.idleCompaction(SID)) as { readonly inputID: string }
    shown.m.clock.advance(1_000)
    await shown.m.rpc("session.presence", { sessionID: SID })
    shown.m.delivered.set(SID, shownRecord.inputID)
    expect(await shown.m.switching.idleCompaction(SID)).toEqual({ drop: IdleCompaction.DROPPED.returned })
    expect(shown.outcomes()).toEqual(["admitted", "returned"])
  })
})

describe("policy.compaction.idle", () => {
  test("fields merge into the stored value and policy.get reports them", async () => {
    const { m } = await idleSession()
    await using _ = m
    await m.rpc("policy.set", { patch: { compaction: { idle: { minTokens: 200_000 } } } })
    expect(await m.rpc("policy.get", {})).toMatchObject({
      policy: { compaction: { idle: { enabled: true, minTokens: 200_000 } } },
    })
    await m.rpc("policy.set", { patch: { compaction: { idle: { enabled: false } } } })
    expect(await m.rpc("policy.get", {})).toMatchObject({
      policy: { compaction: { idle: { enabled: false, minTokens: 200_000 } } },
    })
  })
})
