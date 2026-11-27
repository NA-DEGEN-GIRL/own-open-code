// ChatGPT reset credits on screen (03 §7.1.1 리셋권): what the card's line shows, the dialog's choices and its extra
// question, the result words, the copy in Korean and English, and the wiring that keeps redeeming behind the dialog
// and out of the first chunk. Solid components do not render under `bun test` (ds-balance.test.tsx); the Playwright
// test `accounts-limits.spec.ts` renders the line, the dialog and every outcome.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { Limit } from "@own/protocol"
import {
  belowLimit,
  day,
  expiryOf,
  failure,
  lineState,
  loginKey,
  notSentKey,
  options,
  outcomeKey,
  outcomeUnknown,
  reached,
  soonest,
  usable,
} from "./reset-credits-model"
import { resetCreditEn, resetCreditKo, resetCreditText } from "./reset-credits-strings"
import { CLAUDE_USAGE_URL } from "./reset-credits"

const AT = Date.UTC(2026, 9, 26, 3, 0)
const credits = (patch: Partial<Limit.ResetCredits> = {}): Limit.ResetCredits => ({
  accountID: "acc_1" as Limit.ResetCredits["accountID"],
  providerID: "own-codex-a" as Limit.ResetCredits["providerID"],
  availableCount: 2,
  observedAt: AT,
  source: "poll",
  ...patch,
})
const credit = (id: string, patch: Partial<Limit.ResetCredit> = {}): Limit.ResetCredit => ({
  id,
  type: "codex_rate_limits",
  status: "available",
  grantedAt: AT - 86_400_000,
  ...patch,
})
const window = (patch: Partial<Limit.Window>): Limit.Window =>
  ({
    id: "codex.primary",
    accountID: "acc_1",
    providerID: "own-codex-a",
    scope: "account",
    kind: "rolling_quota",
    label: "5시간",
    usedPercent: 40,
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: AT,
    ...patch,
  }) as Limit.Window

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("the card's line (7.1.1)", () => {
  test("the count whenever known; 리셋권 없음 and 리셋권 확인 only unfolded", () => {
    expect(lineState(credits(), false)).toBe("count")
    expect(lineState(credits(), true)).toBe("count")
    expect(lineState(credits({ availableCount: 0 }), false)).toBe("hidden")
    expect(lineState(credits({ availableCount: 0 }), true)).toBe("none")
    expect(lineState(undefined, false)).toBe("hidden")
    expect(lineState(undefined, true)).toBe("check")
  })

  test("the soonest expiry is known only once the credits were listed; never-expiring ones come last", () => {
    expect(soonest(credits())).toBeUndefined()
    const listed = credits({
      credits: [
        credit("forever"),
        credit("late", { expiresAt: AT + 30 * 86_400_000 }),
        credit("used", { status: "redeemed", expiresAt: AT + 1 }),
        credit("soon", { expiresAt: AT + 3 * 86_400_000 }),
      ],
    })
    expect(usable(listed).map((item) => item.id)).toEqual(["soon", "late", "forever"])
    expect(soonest(listed)).toBe(AT + 3 * 86_400_000)
    expect(day("ko", Date.UTC(2026, 10, 3, 3))).toBe("11월 3일")
    expect(day("en", Date.UTC(2026, 10, 3, 3))).toBe("Nov 3")
  })
})

describe("the dialog (7.1.1)", () => {
  test("the listed credits up to the count, or one choice that lets ChatGPT pick; none at 0", () => {
    const listed = credits({
      availableCount: 1,
      credits: [
        credit("a", { title: "Full reset (Weekly + 5 hr)", expiresAt: AT + 9 }),
        credit("b", { expiresAt: AT + 5 }),
      ],
    })
    expect(options(listed)).toEqual([{ creditID: "b", expiresAt: AT + 5 }])
    expect(
      options(credits({ availableCount: 2, credits: [credit("a", { title: "Full", description: "Ready" })] })),
    ).toEqual([{ creditID: "a", title: "Full", description: "Ready" }])
    expect(options(credits())).toEqual([{}])
    expect(options(credits({ availableCount: 0, credits: [credit("a")] }))).toEqual([])
  })

  test("an expiry is 기한 없음 only for a listed credit without one; the choice ChatGPT picks has 기한 모름", () => {
    const words = (option: Parameters<typeof expiryOf>[0]) => {
      const at = expiryOf(option)
      if (at === "unknown") return resetCreditText.text("ko", "own.rc.expiryUnknown")
      if (at === "never") return resetCreditText.text("ko", "own.rc.noExpiry")
      return at
    }
    // The count only: ChatGPT picks a credit whose expiry nobody here knows.
    expect(options(credits()).map(words)).toEqual(["기한 모름"])
    expect(
      options(credits({ credits: [credit("forever"), credit("soon", { expiresAt: AT + 5 })] })).map(words),
    ).toEqual([AT + 5, "기한 없음"])
    // The confirmation takes the plan's word for the picked credit, never for ChatGPT's pick.
    expect(expiryOf({ creditID: "a" }, AT + 9)).toBe(AT + 9)
    expect(expiryOf({}, AT + 9)).toBe("unknown")
  })

  test("a login not usable says why; a 401 says to sign in again with no 다시 시도; an unknown outcome asks to check", () => {
    const ko = (key: Parameters<typeof resetCreditText.text>[1], params?: Record<string, string | number>) =>
      resetCreditText.text("ko", key, params)
    // `expiring` also covers an expired login (poller `unready`: 10 minutes or less left; `causeOf("expired")`).
    expect(ko(loginKey("expiring"))).toContain("만료됐거나 곧 만료돼")
    expect(ko(loginKey("needs_reauth"))).toBe(
      "이 계정은 다시 로그인해야 해요. 계정 카드에서 다시 로그인한 뒤 해 주세요.",
    )
    expect(ko(loginKey("missing"))).toBe("이 계정에 저장된 로그인이 없어요. 다시 로그인한 뒤 해 주세요.")
    expect(ko(loginKey("source_stale"))).toContain("이전 앱이 이 계정의 로그인을 갱신하지 않았어요")
    // Another cause, or an older service that names none: no claim that the login is about to expire.
    for (const cause of ["unusable", undefined]) expect(ko(loginKey(cause))).not.toContain("만료")
    expect(failure(undefined)).toEqual({ key: "own.rc.failedNote", retry: true })
    expect(failure(500)).toEqual({ key: "own.rc.failedStatus", retry: true })
    expect(failure(401)).toEqual({ key: "own.rc.failedLogin", retry: false })
    expect(ko(failure(401).key)).toBe(
      "ChatGPT가 이 계정의 로그인을 받지 않았어요(HTTP 401). 다시 로그인한 뒤 처음부터 해 주세요.",
    )
    expect(ko(failure(401).key)).not.toContain("다시 시도")
    // The answer lost on its way here: the credit may be gone, so nothing says it is not.
    for (const type of ["own.rpc_failed", undefined]) expect(outcomeUnknown(type)).toBe(true)
    for (const type of ["limit_reset_failed", "nonce_invalid", "credential_not_ready"])
      expect(outcomeUnknown(type)).toBe(false)
    // Refused before the send (the account removed, an SSH host's service, a phone): nothing went, and the words say
    // so instead of 리셋 결과를 알 수 없어요.
    for (const type of ["account_not_found", "remote_managed", "own.scope_denied"]) {
      expect(outcomeUnknown(type)).toBe(false)
      expect(ko(notSentKey(type)!)).toContain("보내지 않았어요")
    }
    expect(ko("own.rc.notSentAccount")).toBe("계정이 지워져서 보내지 않았어요 · 리셋권은 쓰이지 않았어요")
    for (const type of ["limit_reset_failed", "own.rpc_failed", undefined]) expect(notSentKey(type)).toBeUndefined()
    expect(ko("own.rc.unknownResult")).toBe("리셋 결과를 알 수 없어요 · 다시 확인해 주세요")
    expect(ko("own.rc.recheck")).toBe("다시 확인")
  })

  test("아직 한도에 닿지 않았어요 only when every observed plan window is below its limit", () => {
    expect(belowLimit([window({}), window({ id: "codex.secondary", usedPercent: 99 })])).toBe(true)
    expect(belowLimit([window({}), window({ id: "codex.secondary", usedPercent: 100, status: "exhausted" })])).toBe(
      false,
    )
    expect(belowLimit([window({ usedPercent: 60, status: "exhausted" })])).toBe(false)
    // The paid credits and other accounts' windows are not plan windows; none observed is no question.
    expect(belowLimit([window({ id: "codex.credits", kind: "balance", usedPercent: undefined })])).toBe(false)
    expect(belowLimit([])).toBe(false)
    expect(reached([window({ usedPercent: 100 })])).toBe(true)
    expect(reached([window({}), window({ id: "codex.credits", kind: "balance", status: "exhausted" })])).toBe(false)
    expect(reached(undefined)).toBe(false)
  })

  test("each outcome's words", () => {
    const words = (outcome: Parameters<typeof outcomeKey>[0], picked: boolean, counted: boolean, n = 1) =>
      resetCreditText.text("ko", outcomeKey(outcome, picked, counted), { n })
    expect(words("reset", true, true)).toBe("한도를 리셋했어요 · 리셋권 1개 남았어요")
    expect(words("already_redeemed", false, true, 0)).toBe("한도를 리셋했어요 · 리셋권 0개 남았어요")
    expect(words("reset", false, false)).toBe("한도를 리셋했어요")
    expect(words("nothing_to_reset", false, true)).toBe("지금은 리셋할 한도가 없어요 · 리셋권은 그대로예요")
    expect(words("no_credit", false, true)).toBe("쓸 수 있는 리셋권이 없어요")
    expect(words("no_credit", true, true)).toBe("그 리셋권은 더 이상 쓸 수 없어요 · 새로 고쳐 주세요")
  })

  test("the brief's copy, word for word, and every key in English", () => {
    const ko = (key: keyof typeof resetCreditKo, params?: Record<string, string | number>) =>
      resetCreditText.text("ko", key, params)
    expect(ko("own.rc.count", { n: 2 })).toBe("리셋권 2개")
    expect(ko("own.rc.until", { when: "11월 3일 오후 5:00" })).toBe("11월 3일 오후 5:00까지")
    expect(ko("own.rc.none")).toBe("리셋권 없음")
    expect(ko("own.rc.check")).toBe("리셋권 확인")
    expect(ko("own.rc.use")).toBe("리셋권 쓰기")
    expect(ko("own.rc.fullReset")).toBe("전체 리셋")
    expect(ko("own.rc.fullResetNote")).toBe("지금 사용 한도를 리셋해요")
    expect(ko("own.rc.noExpiry")).toBe("기한 없음")
    expect(ko("own.rc.confirm")).toBe("이 리셋권을 쓸까요?")
    expect(ko("own.rc.irreversible")).toBe("쓰면 되돌릴 수 없어요.")
    expect(ko("own.rc.belowLimit")).toBe("아직 한도에 닿지 않았어요. 그래도 쓸까요?")
    expect(ko("own.rc.running")).toBe("리셋하는 중…")
    expect(ko("own.rc.failed")).toBe("리셋하지 못했어요")
    expect(ko("own.rc.retry")).toBe("다시 시도")
    expect(ko("own.rc.close")).toBe("닫기")
    expect(ko("own.rc.cancel")).toBe("취소")
    expect(ko("own.rc.claude")).toBe("Claude 리셋권은 claude.ai 설정 > 사용량에서 확인하고 쓸 수 있어요")
    expect(CLAUDE_USAGE_URL).toBe("https://claude.ai/settings/usage")
    expect(Object.keys(resetCreditEn).sort()).toEqual(Object.keys(resetCreditKo).sort())
    // 해요체 throughout (03 §14): no 합니다체 ending.
    for (const value of Object.values(resetCreditKo)) expect(value).not.toMatch(/습니다|합니다|십시오/)
  })
})

describe("wiring (7.1.1)", () => {
  test("only the dialog redeems: plan, then execute after the confirm button, 취소 focused", async () => {
    const dialog = await code("reset-credits-dialog.tsx")
    expect(dialog.match(/"quota\.resetCredits\.redeem\.execute"/g)).toHaveLength(1)
    expect(dialog).toContain('"quota.resetCredits.redeem.plan"')
    const cancel = dialog.slice(dialog.indexOf('data-testid="reset-credit-cancel"') - 400)
    expect(cancel).toContain("element.focus()")
    // The confirm button is the one that executes; nothing runs on mount but the list.
    expect(dialog.slice(dialog.indexOf("onMount("), dialog.indexOf("onMount(") + 40)).toContain("load()")
    for (const file of ["reset-credits.tsx", "summary.tsx", "../switcher/popover.tsx", "../shell/session-banners.tsx"])
      expect(await code(file)).not.toContain("redeem.execute")
  })

  test("the banner, the line and the dialog stay out of the first chunk", async () => {
    const banners = await code("../shell/session-banners.tsx")
    expect(banners).toContain(
      'import("@/limits/reset-credits").then((module) => ({ default: module.LimitReachedBanner }))',
    )
    expect(banners).not.toMatch(/^import .*@\/limits\/reset-credits/m)
    // The banner stays while its dialog is open, so a redeem that refills the limits never takes the result away.
    expect(banners).toContain("if (held() === account.id) return account")
    expect(banners).toContain("onDialog={(open) => setHeld(open ? account().id : undefined)}")
    expect(await code("reset-credits.tsx")).toContain('lazy(() => import("./reset-credits-dialog"))')
    // Sign in with ChatGPT has no reset credits: only `codex` lines and Claude notes.
    const summary = await code("summary.tsx")
    expect(summary).toContain('props.kind === "codex" && props.resetCredits')
    expect(summary).toContain('props.kind === "claude-sub"')
    expect(summary).not.toContain('"siwc"')
  })
})
