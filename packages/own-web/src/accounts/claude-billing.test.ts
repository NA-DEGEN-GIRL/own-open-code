// The Claude extra-usage warning (02 §8.9, 03 §5.4.1(d), user decision CW 2026-10-19 "경고 보이고 확인하기"): the
// cards' info line and `자세히`, the billing state the router keeps on `claude.overage`, and the composer's
// first-request notice. Solid components do not render under `bun test` (see ds-balance.test.tsx); the browser e2e
// renders the card (e2e/accounts-limits.spec.ts), and the wiring is checked in this package's own source here.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { Limit } from "@own/protocol"
import type { AlertEntry } from "@/data/own-store"
import { dismissFirstRequest, firstRequestAlert } from "@/composer/claude-first"
import { billingOf, SOURCES, USAGE_URL } from "./claude-billing"
import { claudeBillingEn, claudeBillingKo, claudeBillingText } from "./claude-billing-strings"

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(file).text()).replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

const NOW = Date.UTC(2026, 9, 19, 3, 0, 0)

function overage(meta?: Limit.Window["meta"]): Limit.Window {
  return {
    id: "claude.overage",
    accountID: "acc_claude_slot",
    providerID: "anthropic",
    scope: "account",
    kind: "spend_cap",
    label: "추가 사용량",
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: NOW,
    ...(meta === undefined ? {} : { meta }),
  } as Limit.Window
}

function alert(patch: Partial<AlertEntry>): AlertEntry {
  return {
    id: "evt_1",
    at: NOW,
    code: "claude_first_request",
    severity: "warning",
    message: "이 계정의 첫 Claude 요청이에요 · 추가 사용량으로 청구될 수 있어요",
    sessionID: "ses_root",
    accountID: "acc_claude_slot",
    ...patch,
  }
}

describe("the Claude cards' info line and 자세히", () => {
  test("the decided words, verbatim, in 해요체", () => {
    const t = (key: keyof typeof claudeBillingKo) => claudeBillingText.text("ko", key)
    expect(t("own.claude.billing.line")).toBe(
      "Anthropic 정책(2026-04-04)으로 Claude Code 밖에서 쓰는 구독 사용은 구독 한도가 아니라 추가 사용량(종량제)으로 청구될 수 있어요. claude.ai › 설정 › 사용량에서 확인하세요.",
    )
    expect(t("own.claude.billing.more")).toBe("자세히")
    expect(t("own.claude.billing.extraUsage")).toBe("이 계정은 지금 추가 사용량으로 청구되고 있어요")
    expect(t("own.claude.billing.rejected")).toBe(
      "추가 사용량이 꺼져 있어 거절됐어요 · claude.ai에서 켜거나 API 키를 쓰세요",
    )
    expect(t("own.claude.first.line")).toBe("이 계정의 첫 Claude 요청이에요 · 추가 사용량으로 청구될 수 있어요")
    expect(t("own.claude.first.continue")).toBe("계속")
    expect(t("own.claude.first.cancel")).toBe("취소")
    // English exists for every key and differs from the Korean.
    for (const key of Object.keys(claudeBillingKo) as (keyof typeof claudeBillingKo)[])
      expect(claudeBillingEn[key] ?? "").not.toBe("")
  })

  test("자세히 has the dates, what cannot be known, the claude.ai check and the sources", () => {
    const ko = Object.values(claudeBillingKo).join("\n")
    for (const date of ["2026-01-09", "2026-02-19", "2026-04-04 낮 12시(미국 태평양 시간)", "2026-06-15·2026-10-07"])
      expect(ko).toContain(date)
    // Anthropic's own help says otherwise since June: the card never promises either way.
    expect(claudeBillingKo["own.claude.billing.date.help"]).toContain("어느 쪽인지 장담하지 않아요")
    expect(claudeBillingKo["own.claude.billing.know.unknown"]).toContain("응답만으로는 알 수 없어요")
    expect(claudeBillingKo["own.claude.billing.check.1"]).toContain("짧은 메시지를 하나 보내요")
    expect(claudeBillingKo["own.claude.billing.check.2"]).toContain("claude.ai › 설정 › 사용량(Settings › Usage)")
    expect(claudeBillingKo["own.claude.billing.check.2"]).toContain("결제(Billing)")
    expect(USAGE_URL).toBe("https://claude.ai/settings/usage")
    expect(SOURCES.map((source) => new URL(source.url).hostname)).toEqual([
      "support.claude.com",
      "support.claude.com",
      "code.claude.com",
      "www.techradar.com",
      "gigazine.net",
      "www.implicator.ai",
      "github.com",
    ])
  })

  test("both Claude cards carry it, the line is not dismissable, and the links go through the host", async () => {
    const notice = await code(path.join(import.meta.dir, "claude-billing-notice.tsx"))
    expect(notice).toContain('data-testid="claude-billing-line"')
    expect(notice).toContain('data-testid="claude-billing-more"')
    expect(notice).toContain("<details")
    // Nothing closes the line: no dismiss button and no stored "seen" state.
    for (const word of ["own.kit.dismiss", "localStorage", "setDismissed"]) expect(notice).not.toContain(word)
    expect(notice).toContain("host.openExternal(USAGE_URL)")
    expect(notice).toContain("host.openExternal(source.url)")
    const slot = await code(path.join(import.meta.dir, "claude-slot.tsx"))
    expect(slot).toContain('<ClaudeBillingNotice windows={own.state.quota["acc_claude_slot"]} />')
    const added = await code(path.join(import.meta.dir, "claude-accounts.tsx"))
    expect(added).toContain("<ClaudeBillingNotice windows={own.state.quota[props.account.id]} />")
  })
})

describe("the billing state on the card", () => {
  test("comes from the account's claude.overage window, and only when a response said so", () => {
    expect(billingOf(undefined)).toBeUndefined()
    expect(billingOf([])).toBeUndefined()
    expect(billingOf([overage()])).toBeUndefined()
    expect(billingOf([overage({ representative: "five_hour" })])).toBeUndefined()
    expect(billingOf([overage({ billing: "extra_usage" })])).toEqual({ state: "extra_usage", observedAt: NOW })
    expect(billingOf([overage({ billing: "rejected", disabledReason: "org_level_disabled" })])).toEqual({
      state: "rejected",
      observedAt: NOW,
    })
    // Another window's meta never counts.
    expect(billingOf([{ ...overage({ billing: "extra_usage" }), id: "claude.5h" }])).toBeUndefined()
  })
})

describe("the composer's first-request notice", () => {
  test("shows the conversation's own first-request alert until it is closed", () => {
    const alerts = [
      alert({ id: "evt_other", code: "claude_account_switched" }),
      alert({ id: "evt_elsewhere", sessionID: "ses_other" }),
      alert({ id: "evt_mine" }),
    ]
    expect(firstRequestAlert(alerts, "ses_root", new Set())?.id).toBe("evt_mine")
    expect(firstRequestAlert(alerts, "ses_root", new Set(["evt_mine"]))).toBeUndefined()
    expect(firstRequestAlert(alerts, "ses_none", new Set())).toBeUndefined()
    // Closing it in one composer closes it in every composer of the page.
    expect(firstRequestAlert(alerts, "ses_root")?.id).toBe("evt_mine")
    dismissFirstRequest("evt_mine")
    expect(firstRequestAlert(alerts, "ses_root")).toBeUndefined()
  })

  test("never holds a send: 계속 closes it, 취소 stops the running turn, and it loads lazily", async () => {
    const composer = await code(path.join(import.meta.dir, "..", "composer", "index.tsx"))
    expect(composer).toContain('import("@/accounts/claude-first-request")')
    expect(composer).not.toMatch(/^import .*@\/accounts\/claude-first-request/m)
    expect(composer).toContain("firstRequestAlert(current.own.state.alerts, id)")
    // The send path does not read it.
    const send = await code(path.join(import.meta.dir, "..", "composer", "send.ts"))
    expect(send).not.toContain("firstRequest")
    const notice = await code(path.join(import.meta.dir, "claude-first-request.tsx"))
    expect(notice).toContain('data-testid="claude-first-request-continue"')
    expect(notice).toContain('data-testid="claude-first-request-cancel"')
    expect(notice).toContain("session.interrupt({ sessionID: props.sessionID })")
    expect(notice).toContain('props.runtime.data.session.status(props.sessionID) === "running"')
  })
})
