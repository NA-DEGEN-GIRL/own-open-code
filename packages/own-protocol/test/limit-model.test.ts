// Which requests a limit window limits (LV 2026-10-24): Claude's model weekly buckets limit one model family only, and
// one without a reset stops counting once its observation is stale. own-web ranks and own-accounts switches by it.
import { describe, expect, test } from "bun:test"
import { LimitModel } from "../src/index.js"

const NOW = Date.UTC(2026, 9, 24, 6, 0, 0)
const MINUTE = 60_000

describe("LimitModel", () => {
  test("a bucket's family, a model id's family", () => {
    expect(
      ["claude.7d_oi", "claude.7d_opus", "claude.7d_sonnet", "claude.7d", "claude.5h", "codex.primary"].map(
        LimitModel.bucket,
      ),
    ).toEqual(["fable", "opus", "sonnet", undefined, undefined, undefined])
    expect(
      [
        "claude-fable-5-1",
        "anthropic/claude-opus-5-5",
        "us.anthropic.claude-sonnet-4-5-v1:0",
        "claude-3-5-sonnet-latest",
        "claude-haiku-4-5",
        "gpt-5.6-sol",
        undefined,
      ].map(LimitModel.family),
    ).toEqual(["fable", "opus", "sonnet", "sonnet", undefined, undefined, undefined])
  })

  test("an account-wide window limits every model; a bucket only its family; without a model no bucket", () => {
    expect(LimitModel.limits("claude.7d", "claude-sonnet-4-5")).toBe(true)
    expect(LimitModel.limits("claude.7d", undefined)).toBe(true)
    expect(LimitModel.limits("claude.7d_oi", "claude-fable-5-1")).toBe(true)
    expect(LimitModel.limits("claude.7d_oi", "claude-sonnet-4-5")).toBe(false)
    expect(LimitModel.limits("claude.7d_opus", "claude-opus-5-5")).toBe(true)
    expect(LimitModel.limits("claude.7d_opus", "claude-fable-5-1")).toBe(false)
    expect(LimitModel.limits("claude.7d_sonnet", undefined)).toBe(false)
  })

  test("an exhaustion record without a window or with an account-wide one holds back the account; a bucket's not", () => {
    expect([null, "claude.5h", "claude.7d", "codex.primary"].map(LimitModel.accountWide)).toEqual([true, true, true, true])
    expect(["claude.7d_oi", "claude.7d_opus", "claude.7d_sonnet"].map(LimitModel.accountWide)).toEqual([false, false, false])
  })

  test("a bucket without a reset lapses once its observation is stale (over 15 minutes); others never", () => {
    const bucket = { id: "claude.7d_oi", observedAt: NOW - 16 * MINUTE }
    expect(LimitModel.lapsed(bucket, NOW)).toBe(true)
    expect(LimitModel.lapsed({ ...bucket, observedAt: NOW - 15 * MINUTE }, NOW)).toBe(false)
    expect(LimitModel.lapsed({ ...bucket, resetAt: NOW + 86_400_000 }, NOW)).toBe(false)
    expect(LimitModel.lapsed({ ...bucket, id: "claude.7d" }, NOW)).toBe(false)
  })
})
