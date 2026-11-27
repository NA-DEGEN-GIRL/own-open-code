import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CompactionCache, Ledger, Policy } from "../src/index.js"

// Cache-preserving compaction (P-034) and idle compaction (02 §4.7.5, §4.7.7, CC 2026-10-24): the metadata a checkpoint
// carries, read back for the ledger and own-web, and the rule for which caches suit idle compaction.
describe("CompactionCache", () => {
  test("a checkpoint's request: core's record first, else own-accounts' refusal, with the idle trigger", () => {
    expect(CompactionCache.sentOf(undefined)).toBeUndefined()
    expect(CompactionCache.sentOf({ prefix: { request: "full" }, "own.compaction.trigger": "idle" })).toEqual({
      request: "full",
      trigger: "idle",
    })
    expect(CompactionCache.sentOf({ prefix: { request: "older", reason: "fit" } })).toEqual({
      request: "older",
      reason: "fit",
    })
    const verdict = { prefix: "older", reason: "cold", ageMs: 400_000, ttlMs: 300_000 } as const
    expect(CompactionCache.verdictOf({ [CompactionCache.CACHE_KEY]: verdict })).toEqual(verdict)
    expect(CompactionCache.sentOf({ [CompactionCache.CACHE_KEY]: verdict })).toEqual({ request: "older", reason: "cold" })
    // A record wins over the verdict; a malformed one is no record.
    expect(
      CompactionCache.sentOf({ prefix: { request: "full" }, [CompactionCache.CACHE_KEY]: { prefix: "full", reason: "warm" } }),
    ).toEqual({ request: "full" })
    expect(CompactionCache.sentOf({ prefix: { request: "most" } })).toBeUndefined()
    // A stand-in's summary came from that model's older request, which read nothing the session cached, whatever core
    // recorded for the session model's attempt (`full` when nothing was kept, CC-16); the model-free digest from none,
    // so it claims no request.
    const failed = { prefix: { request: "older", reason: "failed" } }
    const standIn = { fallback: { failed: "a/b", reason: "x", model: "c/d" } }
    expect(CompactionCache.sentOf({ ...failed, ...standIn })).toEqual({ request: "older", reason: "stand-in" })
    expect(
      CompactionCache.sentOf({ prefix: { request: "full" }, ...standIn, [CompactionCache.TRIGGER_KEY]: "idle" }),
    ).toEqual({ request: "older", reason: "stand-in", trigger: "idle" })
    expect(CompactionCache.sentOf({ ...failed, fallback: { failed: "a/b", reason: "x" } })).toBeUndefined()
    // A stand-in's checkpoint from before P-034 (no record, no verdict) claims no request either.
    expect(CompactionCache.sentOf(standIn)).toBeUndefined()
    // The second run's own reasons, and the first run's for caches that read the longest prefix.
    expect(CompactionCache.sentOf({ prefix: { request: "older", reason: "short" } })).toEqual({
      request: "older",
      reason: "short",
    })
    expect(
      CompactionCache.verdictOf({ [CompactionCache.CACHE_KEY]: { prefix: "older", reason: "longest-prefix" } }),
    ).toEqual({ prefix: "older", reason: "longest-prefix" })
    expect(CompactionCache.sentOf({ [CompactionCache.CACHE_KEY]: { prefix: "older", reason: "unmeasured" } })).toEqual({
      request: "older",
      reason: "unmeasured",
    })
  })

  test("only caches that surely end at TTL_lo suit idle compaction", () => {
    expect(CompactionCache.idleSuits({ lo: 1_800_000, hi: 1_800_000 })).toBe(true)
    expect(CompactionCache.idleSuits({ lo: 300_000, hi: 300_000 })).toBe(true)
    expect(CompactionCache.idleSuits({ lo: 300_000, hi: null })).toBe(false)
    expect(CompactionCache.idleSuits({ lo: 1_800_000, hi: 86_400_000 })).toBe(false)
    expect(CompactionCache.idleSuits({ lo: 0, hi: 0 })).toBe(false)
    expect(CompactionCache.idleSuits(undefined)).toBe(false)
  })

  test("the ledger line and policy.json carry them; both are optional", () => {
    const line = Schema.decodeUnknownSync(Ledger.Line)({
      v: 1,
      ts: 1,
      sessionID: "ses_cc",
      messageID: null,
      kind: "compaction",
      accountID: null,
      providerID: "anthropic",
      modelID: "claude-opus-5-5",
      variant: null,
      credentialRef: null,
      transport: null,
      switchEpoch: 0,
      compactionEpoch: 0,
      tokens: null,
      P: null,
      hit: null,
      cost: null,
      costUSDOpenCode: null,
      coldExpected: null,
      compaction: { request: "full", trigger: "idle" },
    })
    expect(line.compaction).toEqual({ request: "full", trigger: "idle" })
    expect(Schema.decodeUnknownSync(Policy.PolicyCompaction)({ byKind: {}, idle: { enabled: true } }).idle).toEqual({
      enabled: true,
    })
    expect(() => Schema.decodeUnknownSync(Policy.PolicyCompaction)({ byKind: {}, idle: { enabled: true, minTokens: 0 } })).toThrow()
  })
})
