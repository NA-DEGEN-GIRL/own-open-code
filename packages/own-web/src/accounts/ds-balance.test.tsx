// DeepSeek balance UX (03 §5.4, 02 §7.2): the platform pages the card and the banner open, the 402 reason and the
// session banner's inline copy of it (lazy, like the ChatGPT usage-limit banner), the card's `충전 · 사용량` line, and
// the words in Korean and English. The router side (DeepSeek's 402 classified as `status_402`, the 보너스 window) is
// own-accounts' own test (`test/telemetry/parsers.test.ts`); the card keeping only a live 보너스 is `kept` in
// limits.test.ts and data.test.ts. Solid components do not render under `bun test` (it compiles JSX for React, so a
// component throws "React is not defined"); the browser e2e renders them, and their wiring is checked in this
// package's own source here.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { translate, type I18nKey } from "@/i18n"
import { BALANCE_CODE, TOP_UP_URL, USAGE_URL } from "./ds-balance"

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(file).text()).replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

describe("DeepSeek balance (5.4, 02 §7.2)", () => {
  test("top-up and usage are the DeepSeek platform pages, opened through the host", async () => {
    expect(TOP_UP_URL).toBe("https://platform.deepseek.com/top_up")
    expect(USAGE_URL).toBe("https://platform.deepseek.com/usage")
    const source = await code(path.join(import.meta.dir, "ds-balance.tsx"))
    expect(source).toContain("host.openExternal(TOP_UP_URL)")
    expect(source).toContain("host.openExternal(USAGE_URL)")
    expect(source).toContain("openSwitcher({")
  })

  test("the 402 reason is the router's, and the session banner repeats it inline and loads lazily", async () => {
    // own-accounts' parsers.test.ts: DeepSeek's 402 is hard with this reason.
    expect(BALANCE_CODE).toBe("status_402")
    const banners = await code(path.join(import.meta.dir, "../shell/session-banners.tsx"))
    expect(banners).toContain(
      `account?.kind === "ds" && data.local().own.state.statusReason[account.id] === "${BALANCE_CODE}"`,
    )
    expect(banners).toContain('import("@/accounts/ds-balance").then((module) => ({ default: module.DsBalanceBanner }))')
    expect(banners).not.toMatch(/^import .*@\/accounts\/ds-balance/m)
  })

  test("a DeepSeek card shows 충전 · 사용량, and 잔액 부족 after a 402", async () => {
    const card = await code(path.join(import.meta.dir, "account-card.tsx"))
    // The DeepSeek block runs up to the next kind's block (the Anthropic organization note).
    const start = card.indexOf('<Show when={item().kind === "ds"}>')
    const line = card.slice(start, card.indexOf('<Show when={item().kind === "anth"', start))
    expect(start).toBeGreaterThan(0)
    expect(line).toContain("<DsBalanceLinks />")
    expect(line).toContain("own.state.statusReason[props.id] === BALANCE_CODE")
    expect(line).toContain('"own.ds.balanceOutShort"')
  })

  test("the words, in Korean and English", () => {
    const keys: I18nKey[] = [
      "own.ds.topUp",
      "own.ds.usage",
      "own.ds.balanceOut",
      "own.ds.balanceOutHelp",
      "own.ds.balanceOutShort",
    ]
    for (const key of keys) expect(translate("en", key)).not.toBe(translate("ko", key))
    expect(translate("ko", "own.ds.topUp")).toBe("충전")
    expect(translate("ko", "own.ds.usage")).toBe("사용량")
    expect(translate("ko", "own.ds.balanceOut", { account: "회사 DS" })).toBe("회사 DS의 DeepSeek 잔액이 부족해요")
    expect(translate("en", "own.ds.balanceOut", { account: "Work DS" })).toBe("Work DS is out of DeepSeek balance")
  })
})
