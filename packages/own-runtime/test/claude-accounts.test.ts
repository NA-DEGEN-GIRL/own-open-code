import { describe, expect, test } from "bun:test"
import { ClaudeAccounts } from "../src/claude-accounts.js"

describe("ClaudeAccounts.Attribution (02 §8.5, §8.8, G4)", () => {
  test("asks every installed resolver until one knows the request; removal stops asking it", () => {
    const attribution = new ClaudeAccounts.Attribution()
    const known = new Request("http://127.0.0.1/a")
    const other = new Request("http://127.0.0.1/b")
    expect(attribution.accountOf(known)).toBeUndefined()
    const off = attribution.install((request) => (request === known ? "acc_two" : undefined))
    attribution.install((request) => (request === other ? "acc_claude_slot" : undefined))
    expect(attribution.accountOf(known)).toBe("acc_two")
    expect(attribution.accountOf(other)).toBe("acc_claude_slot")
    off()
    expect(attribution.accountOf(known)).toBeUndefined()
  })

  test("remembers the last signing account per session, bounded, most recent kept", () => {
    const attribution = new ClaudeAccounts.Attribution()
    attribution.remember("ses_a", "acc_one")
    attribution.remember("ses_a", "acc_two")
    expect(attribution.lastOf("ses_a")).toBe("acc_two")
    for (let index = 0; index < ClaudeAccounts.MAX_SESSIONS; index++) attribution.remember(`ses_${index}`, "acc_x")
    expect(attribution.lastOf("ses_a")).toBeUndefined()
    expect(attribution.lastOf(`ses_${ClaudeAccounts.MAX_SESSIONS - 1}`)).toBe("acc_x")
  })

  test("a switch mark is used once", () => {
    const attribution = new ClaudeAccounts.Attribution()
    expect(attribution.takeSwitched("ses_a")).toBe(false)
    attribution.markSwitched("ses_a")
    expect(attribution.takeSwitched("ses_a")).toBe(true)
    expect(attribution.takeSwitched("ses_a")).toBe(false)
  })
})
