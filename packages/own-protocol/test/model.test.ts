import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Cache, Estimate, Kv, Ledger, Limit, OwnID, Switch } from "../src/index.js"
import { cacheState, estimate, ledgerLine, limitWindow, roundTrip, SESSION, SESSION_2 } from "./fixtures.js"

const target = { providerID: "own-codex-p1q2", id: "gpt-5.5", variant: "high" }

describe("limits", () => {
  test("LimitWindow round-trips and validates its enums (02 §7.3)", () => {
    expect(roundTrip(Limit.Window, limitWindow)).toEqual(limitWindow)
    const claude = {
      ...limitWindow,
      id: "claude.5h",
      accountID: "acc_claude_slot",
      providerID: "anthropic",
      meta: { representative: "five_hour" },
    }
    expect(roundTrip(Limit.Window, claude)).toEqual(claude)
    expect(() => Schema.decodeUnknownSync(Limit.Window)({ ...limitWindow, confidence: "fresh" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Limit.Window)({ ...limitWindow, usedPercent: -1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Limit.Window)({ ...limitWindow, unit: "EUR" })).toThrow()
  })

  test("codex may report more than 100% when exhausted", () => {
    const over = { ...limitWindow, usedPercent: 104.5, status: "exhausted" }
    expect(roundTrip(Limit.Window, over)).toEqual(over)
  })

  test("the snapshot file and exhaustion records decode", () => {
    const file = { schemaVersion: 1, savedAt: 1790001234567, windows: [limitWindow] }
    expect(roundTrip(Limit.SnapshotFile, file)).toEqual(file)
    const exhaustion = {
      accountID: limitWindow.accountID,
      windowId: "codex.primary",
      until: 1790003060000,
      class: "hard",
    }
    expect(roundTrip(Limit.Exhaustion, exhaustion)).toEqual(exhaustion)
    const coded = { ...exhaustion, windowId: null, reason: "subscription_sharing_usage_limit_exceeded" }
    expect(roundTrip(Limit.Exhaustion, coded)).toEqual(coded)
  })
})

describe("ledger", () => {
  test("decodes the 02 §7.5 line and encodes it back unchanged", () => {
    expect(roundTrip(Ledger.Line, ledgerLine)).toEqual(ledgerLine)
  })

  test("generate lines carry no tokens, and a line without account is allowed", () => {
    const generate = { ...ledgerLine, kind: "generate", tokens: null, cost: null, accountID: null, P: null, hit: null }
    expect(roundTrip(Ledger.Line, generate)).toEqual(generate)
    expect(() => Schema.decodeUnknownSync(Ledger.Line)({ ...ledgerLine, kind: "stream" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Ledger.Line)({ ...ledgerLine, v: 2 })).toThrow()
    expect(() => Schema.decodeUnknownSync(Ledger.Line)({ ...ledgerLine, sessionID: "msg_1" })).toThrow()
  })

  test("usage rows carry totals and session-only fields", () => {
    const row = {
      key: SESSION,
      requests: 12,
      tokens: { input: 10, cacheRead: 20, cacheWrite: 0, output: 5, reasoning: 1 },
      cost: [{ unit: "credits", amount: 3.5 }],
      hitRate: 0.9,
      projectID: "prj_1",
      switchCount: 2,
      lastActivityAt: 1790001234567,
      accountIDs: [ledgerLine.accountID],
      modelIDs: ["gpt-5.5"],
    }
    expect(roundTrip(Ledger.UsageRow, row)).toEqual(row)
  })
})

describe("estimate", () => {
  test("decodes the 02 §9.2 switch.estimate example and encodes it back unchanged", () => {
    expect(roundTrip(Estimate.Result, estimate)).toEqual(estimate)
    const result = Schema.decodeUnknownSync(Estimate.Result)(estimate)
    expect(result.options.filter((option) => option.recommended).map((option) => option.strategy)).toEqual([
      "compact-then-switch",
    ])
    expect(result.options.find((option) => option.strategy === "fork")?.display).toBe("secondary")
  })

  test("unknown rates produce delta null with rate_unknown", () => {
    const option = {
      strategy: "new-session",
      available: false,
      reason: "rate_unknown",
      delta: null,
      display: "primary",
    }
    expect(roundTrip(Estimate.Option, option)).toEqual(option)
    expect(() => Schema.decodeUnknownSync(Estimate.Option)({ ...option, reason: "because" })).toThrow()
  })

  test("delta is a {lo, hi, unit} range and variantOnly has closed reasons", () => {
    expect(roundTrip(Estimate.Delta, { lo: 0, hi: 10.8, unit: "percent" })).toEqual({
      lo: 0,
      hi: 10.8,
      unit: "percent",
    })
    expect(() => Schema.decodeUnknownSync(Estimate.Delta)({ lo: 1, hi: 2 })).toThrow()
    const variantOnly = { ...estimate, variantOnly: { preservesCache: true, reason: "message_effort_update" } }
    expect(roundTrip(Estimate.Result, variantOnly)).toEqual(variantOnly)
    expect(() =>
      Schema.decodeUnknownSync(Estimate.Result)({ ...estimate, variantOnly: { preservesCache: true, reason: "x" } }),
    ).toThrow()
  })

  test("candidates rank switch targets", () => {
    const candidate = {
      providerID: "own-oai-q9x1",
      score: 0.4,
      deltaNow: { lo: 0.1, hi: 0.3, unit: "USD" },
      perRequest: 0.01,
      headroom: 0.7,
    }
    expect(roundTrip(Estimate.Candidate, candidate)).toEqual(candidate)
  })
})

describe("switch state machine", () => {
  const states = [
    { state: "STEADY" },
    { state: "STEADY", slot: "own-codex-7k2m" },
    {
      state: "PLANNED",
      estimateID: estimate.estimateID,
      target,
      options: estimate.options,
      reason: "manual",
      expiresAt: 1790001600000,
    },
    { state: "WAIT_SAFE", target, strategy: "now", reason: "hard" },
    { state: "COMPACTING", target, requestedAt: 1790001300000, timeout: 600000 },
    {
      state: "SCHEDULED",
      target,
      trigger: "either",
      idleMinutes: 60,
      uncertain: true,
      deadline: 1790008500000,
    },
    { state: "SWITCHING", target, issuedAt: 1790001300000 },
    { state: "COOLDOWN", until: 1790003100000, requestsLeft: 20 },
    { state: "BLOCKED", reason: "all_exhausted", nextResetAt: null },
    {
      state: "BLOCKED",
      reason: "all_exhausted",
      nextResetAt: 1790004000000,
      waitReset: { resumeAt: 1790004120000, message: "계속" },
    },
    { state: "DELEGATED", childSessionID: SESSION_2 },
    { state: "FAILED", error: "model.selected not confirmed within 30s" },
  ]

  test("every 02 §5.4 state round-trips", () => {
    for (const state of states) expect(roundTrip(Switch.State, state)).toEqual(state)
    expect(new Set(states.map((state) => state.state))).toEqual(new Set(Switch.StateName.literals))
  })

  test("state fields are required per state", () => {
    expect(() => Schema.decodeUnknownSync(Switch.State)({ state: "WAIT_SAFE", target })).toThrow()
    expect(() => Schema.decodeUnknownSync(Switch.State)({ state: "IDLE" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Switch.State)({ state: "SCHEDULED", target, trigger: "later" })).toThrow()
  })

  test("the tagged union matches every state", () => {
    const name = (value: Switch.State) =>
      Switch.State.match(value, {
        STEADY: () => "steady",
        PLANNED: (planned) => planned.estimateID,
        WAIT_SAFE: (wait) => wait.strategy,
        COMPACTING: () => "compacting",
        SCHEDULED: (scheduled) => scheduled.trigger,
        SWITCHING: () => "switching",
        COOLDOWN: (cooldown) => String(cooldown.requestsLeft),
        BLOCKED: (blocked) => blocked.reason,
        DELEGATED: (delegated) => delegated.childSessionID,
        FAILED: (failed) => failed.error,
      })
    expect(name(Schema.decodeUnknownSync(Switch.State)(states[3]))).toBe("now")
  })

  test("apply results carry a client action (02 §9.2)", () => {
    const compacting = { state: "COMPACTING", clientAction: { type: "compact", sessionID: SESSION } }
    expect(roundTrip(Switch.ApplyResult, compacting)).toEqual(compacting)
    const blocked = {
      state: "BLOCKED",
      detail: { state: "BLOCKED", reason: "all_exhausted", nextResetAt: 1790004000000 },
    }
    expect(roundTrip(Switch.ApplyResult, blocked)).toEqual(blocked)
    const actions = [
      { type: "compact", sessionID: SESSION },
      { type: "fork", sessionID: SESSION, target },
      { type: "create-session", sessionID: SESSION, target },
      { type: "restart-service" },
    ]
    for (const action of actions) expect(roundTrip(Switch.ClientAction, action)).toEqual(action)
    expect(() => Schema.decodeUnknownSync(Switch.ClientAction)({ type: "reload" })).toThrow()
  })

  test("session KV values decode", () => {
    const home = { providerID: "own-codex-7k2m", pinned: true, since: 1790001000000 }
    expect(roundTrip(Switch.Home, home)).toEqual(home)
    const strip = {
      providerID: "own-anth-w3p8",
      dropBefore: "msg_0123",
      kinds: ["reasoning.encrypted", "thinking.signature", "item.id"],
      until: "next-compaction",
    }
    expect(roundTrip(Switch.StripRule, strip)).toEqual(strip)
    expect(roundTrip(Switch.ConfirmOverride, { silentBelowTokens: 100000 })).toEqual({ silentBelowTokens: 100000 })
    const entry = {
      lastReqAt: 1790001200000,
      L: 150000,
      epoch: 1,
      modelID: "gpt-5.5",
      variant: "high",
      watermark: { messageID: "msg_0123", partIndex: 2 },
      blocksSince: 3,
      messageEndsSince: 1,
      imageTrimEpoch: 0,
    }
    expect(roundTrip(Cache.Entry, entry)).toEqual(entry)
  })

  test("KV keys follow 02 §2.4.6", () => {
    expect(Kv.switchState(SESSION)).toBe(`sess:${SESSION}:switch`)
    expect(Kv.ttlMode(SESSION, "own-anth-w3p8")).toBe(`sess:${SESSION}:ttlMode:own-anth-w3p8`)
    expect(Kv.cache(SESSION, "own-anth-w3p8")).toBe(`sess:${SESSION}:cache:own-anth-w3p8`)
    expect(Kv.confirmOverride(SESSION).startsWith(Kv.sessionPrefix(SESSION))).toBe(true)
  })

  // SL-8: each Claude account has its own prompt cache, so `anthropic` entries are kept per account.
  test("cache entries of the Claude accounts are keyed by account, every other provider by the provider", () => {
    const rest = (key: string) => key.slice(`${Kv.sessionPrefix(SESSION)}cache:`.length)
    const claude = Kv.cache(SESSION, "anthropic", Cache.keyAccount("anthropic", "acc_01CL03"))
    expect(claude).toBe(`sess:${SESSION}:cache:anthropic@acc_01CL03`)
    expect(Kv.cacheSlot(rest(claude))).toEqual({ providerID: "anthropic", accountID: "acc_01CL03" })
    expect(Kv.cacheSlot(rest(Kv.cache(SESSION, "own-codex-ab12")))).toEqual({ providerID: "own-codex-ab12" })
    expect(Cache.keyAccount("own-codex-ab12", "acc_01CODEX")).toBeUndefined()
    expect(Cache.keyAccount("anthropic", null)).toBeUndefined()
    expect(Kv.cache(SESSION, "anthropic", Cache.keyAccount("anthropic", null))).toBe(`sess:${SESSION}:cache:anthropic`)
  })
})

describe("cache state", () => {
  test("decodes the 02 §9.2 cache.state example and encodes it back unchanged", () => {
    expect(roundTrip(Cache.Snapshot, cacheState)).toEqual(cacheState)
    expect(() =>
      Schema.decodeUnknownSync(Cache.Snapshot)({ ...cacheState, slots: [{ ...cacheState.slots[1], state: "hot" }] }),
    ).toThrow()
  })
})

describe("generated ids", () => {
  test("ulid-based ids match their schemas", () => {
    expect(OwnID.ulid()).toMatch(OwnID.ULID_PATTERN)
    expect(OwnID.ulid(0)).toStartWith("0000000000")
    expect(Schema.is(OwnID.EventID)(OwnID.EventID.create())).toBe(true)
    expect(OwnID.EstimateID.create()).toStartWith("est_")
    expect(OwnID.AttemptID.create()).toStartWith("att_")
    expect(OwnID.Nonce.create()).not.toBe(OwnID.Nonce.create())
    expect(Schema.is(OwnID.IsoDateTime)(new Date(1790001234567).toISOString())).toBe(true)
    expect(Schema.is(OwnID.IsoDateTime)("2026-09-26")).toBe(false)
  })

  test("ulid time prefixes sort by time", () => {
    expect(OwnID.ulid(1790001234567).slice(0, 10) < OwnID.ulid(1790001234568).slice(0, 10)).toBe(true)
  })
})
