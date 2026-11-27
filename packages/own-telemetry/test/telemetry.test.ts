import { describe, expect, test } from "bun:test"
import { ExtraUsage } from "../src/extra-usage.js"
import { Unified } from "../src/unified.js"

describe("ExtraUsage", () => {
  test("detects the extra-usage phrase case-insensitively in an error body head", () => {
    const body = JSON.stringify({ error: { message: "third-party apps now draw from your extra usage balance" } })
    expect(ExtraUsage.detect(body)).toBe(true)
    expect(ExtraUsage.detect('{"error":{"type":"rate_limit_error"}}')).toBe(false)
  })

  test("the refusals users reported (02 §8.9): personal, Team, out of extra usage with either apostrophe", () => {
    const refusal = (message: string) =>
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } })
    // anthropics/claude-code#45134 (2026-04-08), router-for-me/CLIProxyAPI#6432 (2026-10-07)
    expect(
      ExtraUsage.detect(
        refusal(
          "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.",
        ),
      ),
    ).toBe(true)
    // NousResearch/hermes-agent#48176 (a Team workspace, 2026-06-18)
    expect(
      ExtraUsage.detect(
        refusal(
          "Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin to add more and keep going.",
        ),
      ),
    ).toBe(true)
    expect(
      ExtraUsage.detect(refusal("You're out of extra usage. Add more at claude.ai/settings/usage and keep going.")),
    ).toBe(true)
    expect(ExtraUsage.detect(refusal("You\u2019re out of extra usage. Add more at claude.ai/settings/usage."))).toBe(
      true,
    )
    // The January safeguard is a sign-in refusal, not an extra-usage one.
    expect(
      ExtraUsage.detect(
        refusal(
          "This credential is only authorized for use with Claude Code and cannot be used for other API requests.",
        ),
      ),
    ).toBe(false)
  })
})

describe("Unified", () => {
  test("reads the unified status header", () => {
    expect(Unified.status(new Headers({ "anthropic-ratelimit-unified-status": "rejected" }))).toBe("rejected")
    expect(Unified.status(new Headers())).toBeUndefined()
  })
})
