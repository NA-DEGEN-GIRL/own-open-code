// Accounts · limits · settings (03 §4.7.1, §5.4, §5.5, §5.7, §5.8) in Edge. Flows that the e2e backend supports run
// against the real server with own.accounts (fake OpenAI provider, account "Alpha"); flows that need an old-app
// profile, a ChatGPT login, the Claude plugin or specific limit windows mock the `own.accounts` RPC in the page
// (03 §16.5 "계정 추가(모의 RPC), Codex 가져오기(모의 RPC)"). Every test leaves the backend as it found it.
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()
const [first] = state.sessions
// Mocked times are relative to the start of each test: the relative labels ("1시간 5분 후 리셋", "방금") round to the
// minute, and the file runs for minutes, so one module-level clock drifts past a minute boundary before the late tests.
let NOW = Date.now()
test.beforeEach(() => {
  NOW = Date.now()
})

/** A method's output, or `undefined` to let the real server answer. */
type Handler = (input: Record<string, unknown>) => object | undefined

/** Answers one `own.accounts` method in the page with a fixed output or a handler of the call's input. */
async function mock(page: Page, method: string, answer: object | Handler) {
  const escaped = method.replaceAll(".", "\\.")
  await page.route(new RegExp(`/api/rpc/own\\.accounts/${escaped}(\\?|$)`), async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as { input?: Record<string, unknown> }
    const result = typeof answer === "function" ? (answer as Handler)(body.input ?? {}) : answer
    if (result === undefined) return route.continue()
    return route.fulfill({ json: { output: result } })
  })
}

function windowOf(patch: Record<string, unknown>) {
  return {
    accountID: state.account.id,
    providerID: state.account.providerID,
    scope: "account",
    kind: "rolling_quota",
    status: "ok",
    confidence: "live",
    source: "header",
    observedAt: NOW - 30_000,
    ...patch,
  }
}

// The e2e backend reads the real old-app control center by default (`codexImportRoot` unset); never let a test reach
// it: every page answers `accounts.import.codex.list` itself unless a test mocks it differently.
test.beforeEach(async ({ page }) => {
  await mock(page, "accounts.import.codex.list", { available: false, sources: [] })
})

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test.describe("계정·한도 tab (4.7.1)", () => {
  test("this-session card and grouped account rows with expandable details (real server)", async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(`/srv/local/s/${first!.id}`)
    const tab = page.getByTestId("tab-accounts")
    await expect(tab).toBeVisible()
    // `이 대화 · GPT-5.5`: the catalog display name, matched without case so the model id works too; the account is
    // the highlighted row below, tagged `이 대화` (UX 2026-10-26).
    await expect(tab.getByTestId("session-binding")).toContainText(
      new RegExp(`^이 대화\\s*·\\s*${state.model.replaceAll(".", "\\.")}`, "i"),
    )
    await expect(tab.getByTestId("session-binding")).not.toContainText("@")
    const row = tab.locator(`[data-testid=account-row][data-account-id="${state.account.id}"]`)
    await expect(row).toHaveAttribute("data-current", "")
    await expect(row.getByTestId("account-row-this")).toHaveText("이 대화")
    await expect(tab.getByTestId("account-row-this")).toHaveCount(1)
    await expect(row.locator(".own-arow-head")).toContainText("API")
    await expect(row.locator(".own-arow-head")).toContainText("실행 중 0")
    await row.getByTestId("account-row-toggle").click()
    await expect(row.getByTestId("account-row-toggle")).toHaveAttribute("aria-expanded", "true")
    const more = row.getByTestId("account-row-more")
    await expect(more).toContainText("자동 압축: 모델 한도 · 창의 85%")
    await expect(more).toContainText("키 ")
    await expect(more.getByRole("link", { name: first!.title })).toBeVisible()
    await expect(tab.getByTestId("link-limits")).toHaveAttribute("href", "/limits")
    await expect(tab.getByTestId("link-accounts")).toHaveAttribute("href", "/accounts")
    await page.screenshot({ path: test.info().outputPath("accounts-panel.png") })
    expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
  })

  test("limit bars carry source, confidence and reset; stale fades, estimates hatch, unknown draws no bar", async ({
    page,
  }) => {
    await mock(page, "quota.snapshot", {
      windows: [
        windowOf({
          id: "codex.primary",
          label: "5시간",
          usedPercent: 84,
          resetAt: NOW + 65 * 60_000,
          status: "warning",
        }),
        windowOf({
          id: "codex.secondary",
          label: "주간",
          usedPercent: 61,
          resetAt: NOW + 3 * 86_400_000,
          observedAt: NOW - 40 * 60_000,
          confidence: "stale",
        }),
        windowOf({ id: "codex.tertiary", label: "7일", usedPercent: 20, confidence: "estimated", source: "estimate" }),
        windowOf({ id: "or.key_limit", label: "키 한도", kind: "balance", confidence: "unknown" }),
        windowOf({
          id: "api.budget_month",
          label: "이번 달 예산",
          kind: "budget",
          usedPercent: 23.1,
          remaining: 76.9,
          limit: 100,
          unit: "USD",
          source: "ledger",
          resetAt: NOW + 5 * 86_400_000,
        }),
      ],
    })
    await page.goto(`/srv/local/s/${first!.id}`)
    const row = page.getByTestId("tab-accounts").locator(`[data-account-id="${state.account.id}"]`)
    // Defaults of 설정 > 일반 > 한도 표시: remaining, folded (the two tightest windows, the first one's reset after it).
    const summary = row.getByTestId("limit-summary")
    await expect(summary).toHaveAttribute("data-density", "simple")
    const line = summary.getByTestId("limit-summary-line")
    await expect(line.locator('[data-window="codex.primary"]')).toHaveText("5시간 남음 16%")
    await expect(line.locator('[data-window="codex.primary"]')).toHaveAttribute("data-tone", "warn")
    // The reset goes with its window, faint and in parentheses (UX 2026-10-26).
    await expect(line.locator('[data-role="reset"]')).toHaveText("(1시간 5분 후 리셋)")
    await expect(line.locator(".own-lsum-group").first()).toHaveText("5시간 남음 16% (1시간 5분 후 리셋)")
    await expect(line.locator('[data-window="codex.secondary"]')).toHaveText("주간 남음 39%")
    await expect(line).toHaveAttribute(
      "title",
      /5시간 남음 16% · 1시간 5분 후 리셋\n주간 남음 39% · \S (오전|오후) \d{1,2}:\d\d 리셋/,
    )
    await expect(row.getByTestId("limit-row")).toHaveCount(0)
    // Unfolding shows every bar; the bar starts full and shrinks (16 % left); the reset gives the clock time.
    await summary.getByTestId("limit-summary-toggle").click()
    await expect(summary.getByTestId("limit-summary-toggle")).toHaveAttribute("aria-expanded", "true")
    const five = row.locator('.own-mrow[data-window="codex.primary"]')
    await expect(five).toContainText("남음 16%")
    // Past 22:55 the reset is tomorrow: the clock then names its weekday (03 §7.2).
    await expect(five.getByTestId("limit-reset")).toHaveText(/^1시간 5분 후 리셋 \((\S+ )?(오전|오후) \d{1,2}:\d\d\)$/)
    await expect(five.getByTestId("conf-live")).toHaveText("실측 · 방금")
    await expect(five.getByTestId("conf-live")).toHaveAttribute(
      "title",
      /^\d{4}-\d\d-\d\d \(.\) (오전|오후) \d{1,2}:\d\d 관측$/,
    )
    await expect(five.getByTestId("limit-reset")).toHaveAttribute(
      "title",
      /^\d{4}-\d\d-\d\d \(.\) (오전|오후) \d{1,2}:\d\d 리셋$/,
    )
    await expect(five.getByRole("meter")).toHaveAttribute("data-tone", "warn")
    await expect(five.getByRole("meter")).toHaveAttribute("aria-valuenow", "16")
    await expect(five.getByRole("meter")).toHaveAttribute(
      "aria-valuetext",
      /5시간 한도 16% 남음, 1시간 5분 후 리셋, 방금 관측/,
    )
    const weekly = row.locator('.own-mrow[data-window="codex.secondary"]')
    await expect(weekly.getByTestId("conf-stale")).toHaveText("오래됨 · 40분 전")
    await expect(weekly.getByRole("meter")).toHaveAttribute("data-faded", "")
    await expect(row.getByTestId("limit-row")).toHaveCount(5)
    // `자세히` for lists starts unfolded with every window; `쓴 양` writes the used share.
    await page.evaluate(() =>
      localStorage.setItem("own.web.limits.display", JSON.stringify({ mode: "used", density: { lists: "detailed" } })),
    )
    await page.reload()
    await expect(row.getByTestId("limit-summary-toggle")).toHaveAttribute("aria-expanded", "true")
    await expect(row.getByTestId("limit-row")).toHaveCount(5)
    await expect(row.locator('.own-mrow[data-window="codex.primary"]')).toContainText("사용 84%")
    await expect(row.locator('.own-mrow[data-window="codex.primary"]').getByRole("meter")).toHaveAttribute(
      "aria-valuetext",
      /5시간 한도 84% 사용, 1시간 5분 후 리셋, 방금 관측/,
    )
    await page.evaluate(() => localStorage.removeItem("own.web.limits.display"))
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${state.account.id}"]`)
    await card.getByTestId("limit-summary-toggle").click()
    await expect(card.locator('[data-window="codex.tertiary"]').getByRole("meter")).toHaveAttribute("data-hatched", "")
    await expect(card.locator('[data-window="codex.tertiary"]').getByTestId("conf-estimated")).toHaveText("추정")
    await expect(card.locator('.own-mrow[data-window="or.key_limit"]')).toContainText("— 알 수 없음")
    await expect(card.locator('.own-mrow[data-window="or.key_limit"]').getByRole("meter")).toHaveCount(0)
    const budget = card.locator('.own-mrow[data-window="api.budget_month"]')
    await expect(budget).toContainText("$23.10 / 예산 $100")
    await expect(budget.getByTestId("conf-local")).toHaveText("로컬 집계")
    await expect(budget.getByTestId("conf-local")).toHaveAttribute(
      "title",
      "다른 기기나 앱에서 쓴 양은 포함되지 않아요",
    )
    // The tag names the lead of these windows (LV 2026-10-25), not the real server's list, which has none of them.
    await expect(card.getByTestId("account-status")).toHaveText("주의 · 5시간 남음 16%")
  })

  test("the limits summary folds the card, the tab, the dashboard and the switcher row; click or keyboard unfolds it (LV)", async ({
    page,
  }) => {
    // A Claude account's windows as `Unified.parse` makes them from anthropics/claude-code#12829 plus the `7d_oi`
    // bucket and the extra-usage state: the claim names the 5 hours while the week is far tighter.
    const claude = (patch: Record<string, unknown>) =>
      windowOf({ providerID: "anthropic", meta: { representative: "five_hour" }, ...patch })
    await mock(page, "quota.snapshot", {
      windows: [
        claude({ id: "claude.5h", label: "5시간", windowMinutes: 300, usedPercent: 1.84, resetAt: NOW + 65 * 60_000 }),
        claude({
          id: "claude.7d",
          label: "주간",
          windowMinutes: 10_080,
          usedPercent: 73.71,
          resetAt: NOW + 2 * 86_400_000,
        }),
        claude({
          id: "claude.7d_oi",
          label: "주간 · Fable",
          windowMinutes: 10_080,
          usedPercent: 31,
          resetAt: NOW + 2 * 86_400_000,
        }),
        claude({
          id: "claude.overage",
          kind: "spend_cap",
          label: "추가 사용량",
          status: "exhausted",
          meta: { representative: "five_hour", disabledReason: "org_level_disabled" },
        }),
      ],
    })
    await page.goto(`/srv/local/s/${first!.id}`)
    const row = page.getByTestId("tab-accounts").locator(`[data-account-id="${state.account.id}"]`)
    const tab = row.getByTestId("limit-summary")
    // The session runs a GPT model: the Fable bucket limits Fable only, so it takes no place in the line (unfolded it
    // does, with its model in the label).
    const folded = /^주간 남음 26% \(\S (오전|오후) \d{1,2}:\d\d 리셋\) · 5시간 남음 98% 모든 한도 보기$/
    await expect(tab.getByTestId("limit-summary-toggle")).toHaveAccessibleName(folded)
    await expect(tab.getByTestId("limit-summary-toggle")).toHaveAttribute("aria-expanded", "false")
    await expect(tab.getByTestId("limit-summary-body")).toHaveCount(0)
    // Keyboard: Enter on the focused toggle unfolds, Space folds again.
    await tab.getByTestId("limit-summary-toggle").focus()
    await page.keyboard.press("Enter")
    await expect(tab.getByTestId("limit-summary-toggle")).toHaveAttribute("aria-expanded", "true")
    // Unfolded, the head keeps the tightest value alone and says how to fold it; the rows show the rest.
    await expect(tab.getByTestId("limit-summary-toggle")).toHaveAccessibleName("주간 남음 26% 한도 접기")
    await expect(tab.getByTestId("limit-summary-line").locator(".own-lsum-part")).toHaveText(["주간 남음 26%"])
    const body = tab.getByTestId("limit-summary-body")
    await expect(tab.getByTestId("limit-summary-toggle")).toHaveAttribute(
      "aria-controls",
      (await body.getAttribute("id"))!,
    )
    await expect(body.locator(".own-mrow .own-mrow-label")).toHaveText(["5시간", "주간", "주간 · Fable", "추가 사용량"])
    await expect(body.locator('.own-mrow[data-window="claude.5h"]')).toContainText("남음 98%")
    await expect(body.locator('.own-mrow[data-window="claude.5h"] [data-testid=limit-reset]')).toHaveText(
      /^1시간 5분 후 리셋 \((\S+ )?(오전|오후) \d{1,2}:\d\d\)$/,
    )
    await expect(body.locator('.own-mrow[data-window="claude.7d"] [data-testid=limit-reset]')).toHaveText(
      /^2일 후 리셋 \(\S+ (오전|오후) \d{1,2}:\d\d\)$/,
    )
    const overage = body.locator('.own-mrow[data-window="claude.overage"]')
    await expect(overage.getByTestId("limit-state")).toHaveText("차단")
    await expect(overage.getByTestId("limit-note")).toHaveText("꺼져 있어요")
    await expect(overage.getByTestId("limit-note")).toHaveAttribute(
      "title",
      "overage-disabled-reason: org_level_disabled",
    )
    await expect(overage.getByTestId("conf-live")).toBeVisible()
    await page.screenshot({ path: test.info().outputPath("limits-summary-tab.png") })
    await page.keyboard.press("Space")
    await expect(tab.getByTestId("limit-summary-toggle")).toHaveAttribute("aria-expanded", "false")
    await expect(tab.getByTestId("limit-summary-body")).toHaveCount(0)
    // The row's head opens its details without the bars again.
    await row.getByTestId("account-row-toggle").click()
    await expect(row.getByTestId("account-row-more")).toBeVisible()
    await expect(row.getByTestId("account-row-more").getByTestId("limit-row")).toHaveCount(0)

    // The switcher row shows the same folded line, not a button (a listbox option), every window on hover.
    await page.locator("#own-composer-input").focus()
    await page.keyboard.press("Control+Period")
    const option = page
      .getByTestId("switcher")
      .locator(`[data-testid=switcher-account][data-account-id="${state.account.id}"]`)
    const switcherLine = option.getByTestId("switcher-limits")
    await expect(switcherLine.locator(".own-lsum-group")).toHaveText([
      /^주간 남음 26% \(\S (오전|오후) \d{1,2}:\d\d 리셋\)$/,
      "5시간 남음 98%",
    ])
    await expect(switcherLine).toHaveAttribute("title", /^5시간 남음 98% · 1시간 5분 후 리셋\n주간 남음 26% ·/)
    await expect(option.getByRole("button")).toHaveCount(0)
    await page.keyboard.press("Escape")

    // The 계정 card and the dashboard card fold the same way; the card unfolds on click.
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${state.account.id}"]`)
    await expect(card.getByTestId("limit-summary-toggle")).toHaveAccessibleName(folded)
    await expect(card.getByTestId("limit-row")).toHaveCount(0)
    await card.getByTestId("limit-summary-toggle").click()
    await expect(card.getByTestId("limit-row")).toHaveCount(4)
    await expect(card.locator('.own-mrow[data-window="claude.7d_oi"]')).toContainText("남음 69%")
    await page.screenshot({ path: test.info().outputPath("limits-summary-card.png") })
    await page.goto("/limits")
    const dashboard = page.locator(`[data-testid=limits-card][data-account-id="${state.account.id}"]`)
    await expect(dashboard.getByTestId("limit-summary-toggle")).toHaveAccessibleName(folded)
    await expect(page.getByTestId("limits-summary")).toContainText(
      `가장 빠듯한 한도: ${state.account.label} 주간 남음 26%`,
    )
    // A phone: folded and unfolded, nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 })
    await dashboard.getByTestId("limit-summary-toggle").click()
    await expect(dashboard.getByTestId("limit-row")).toHaveCount(4)
    await expect.poll(() => noHorizontalScroll(page)).toBe(true)
  })

  test("a Claude account without a five-hour window (verified Ultra, 02 §7.1.2): the week alone on every surface", async ({
    page,
  }) => {
    // What the store keeps once an answer came without the `5h-*` family: the week and the extra-usage state only.
    const claude = (patch: Record<string, unknown>) =>
      windowOf({ providerID: "anthropic", meta: { representative: "seven_day" }, ...patch })
    await mock(page, "quota.snapshot", {
      windows: [
        claude({
          id: "claude.7d",
          label: "주간",
          windowMinutes: 10_080,
          usedPercent: 73.71,
          resetAt: NOW + 2 * 86_400_000,
        }),
        claude({ id: "claude.overage", kind: "spend_cap", label: "추가 사용량", status: "exhausted" }),
      ],
    })
    await page.route(/\/api\/rpc\/own\.accounts\/accounts\.list(\?|$)/, async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as { output: { accounts: { id: string }[] } }
      body.output.accounts = body.output.accounts.map((account) =>
        account.id === state.account.id ? { ...account, lastUsedAt: Date.now() } : account,
      )
      await route.fulfill({ response, json: body })
    })
    const id = state.account.id
    await page.goto(`/srv/local/s/${first!.id}`)
    // 사용 중 계정 and the composer: the week, and no five-hour place left empty.
    const inUse = page.getByTestId("accounts-in-use").locator(`[data-account-id="${id}"]`)
    await expect(inUse.locator(".own-glance-item").first()).toHaveAttribute("data-window", "claude.7d")
    await expect(inUse.locator('[data-window="claude.5h"]')).toHaveCount(0)
    await expect(inUse).not.toContainText("5시간")
    await expect(page.getByTestId("composer-limit").locator("[data-window]").first()).toHaveAttribute(
      "data-window",
      "claude.7d",
    )
    await expect(page.getByTestId("composer-limit")).not.toContainText("5시간")
    // The 계정·한도 tab: folded, the week alone; unfolded, its rows without a five-hour bar.
    const tab = page.getByTestId("tab-accounts").locator(`[data-account-id="${id}"]`).getByTestId("limit-summary")
    await expect(tab.getByTestId("limit-summary-toggle")).toHaveAccessibleName(
      /^주간 남음 26% \(\S (오전|오후) \d{1,2}:\d\d 리셋\) 모든 한도 보기$/,
    )
    await tab.getByTestId("limit-summary-toggle").click()
    await expect(tab.locator(".own-mrow .own-mrow-label")).toHaveText(["주간", "추가 사용량"])
    await expect(tab.getByRole("meter")).toHaveCount(1)
    await expect(tab).not.toContainText("5시간")
    // The switcher row, the 계정 card and the dashboard alike.
    await page.locator("#own-composer-input").focus()
    await page.keyboard.press("Control+Period")
    const option = page.getByTestId("switcher").locator(`[data-testid=switcher-account][data-account-id="${id}"]`)
    await expect(option.getByTestId("switcher-limits").locator(".own-lsum-group")).toHaveText([
      /^주간 남음 26% \(\S (오전|오후) \d{1,2}:\d\d 리셋\)$/,
    ])
    await expect(option.getByTestId("switcher-limits")).not.toHaveAttribute("title", /5시간/)
    await page.keyboard.press("Escape")
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${id}"]`)
    await card.getByTestId("limit-summary-toggle").click()
    await expect(card.getByTestId("limit-row")).toHaveCount(2)
    await expect(card.locator('.own-mrow[data-window="claude.5h"]')).toHaveCount(0)
    await expect(card.getByTestId("account-status")).not.toContainText("5시간")
    await page.goto("/limits")
    const dashboard = page.locator(`[data-testid=limits-card][data-account-id="${id}"]`)
    await expect(dashboard.locator("[data-testid=limit-summary-line] [data-window]")).toHaveCount(1)
    // (Its usage trend's `5시간` is a range of the ledger's tokens, not a limit.)
    await expect(dashboard.getByTestId("limit-summary")).not.toContainText("5시간")
    await page.screenshot({ path: test.info().outputPath("limits-no-five-hours.png") })
  })

  test("every surface leads with the same window: sidebar, composer, switcher row, tab, card, dashboard (LV)", async ({
    page,
  }) => {
    // Five fixtures, each read on three pages.
    test.setTimeout(240_000)
    // The fixture set of src/limits/lead.test.ts on this session's account; the session runs a GPT model.
    const claude = (patch: Record<string, unknown>) => windowOf({ providerID: "anthropic", ...patch })
    const sets = [
      {
        name: "the week the claim does not name",
        lead: "claude.7d",
        label: "주간",
        value: "남음 26%",
        bar: true,
        windows: [
          claude({ id: "claude.5h", label: "5시간", usedPercent: 1.84, resetAt: NOW + 65 * 60_000 }),
          claude({ id: "claude.7d", label: "주간", usedPercent: 73.71, resetAt: NOW + 2 * 86_400_000 }),
        ],
      },
      {
        name: "an exhausted 5 hours known only by its state",
        lead: "claude.5h",
        label: "5시간",
        value: "차단",
        bar: true,
        windows: [
          claude({ id: "claude.5h", label: "5시간", status: "exhausted", resetAt: NOW + 65 * 60_000 }),
          claude({ id: "claude.7d", label: "주간", usedPercent: 40 }),
        ],
      },
      {
        name: "a used-up Fable week on a GPT session",
        lead: "claude.7d",
        label: "주간",
        value: "남음 27%",
        bar: true,
        windows: [
          claude({ id: "claude.5h", label: "5시간", usedPercent: 23 }),
          claude({ id: "claude.7d", label: "주간", usedPercent: 73 }),
          claude({ id: "claude.7d_oi", label: "주간 · Fable", usedPercent: 102, status: "exhausted" }),
        ],
      },
      {
        name: "a balance before a roomy budget",
        lead: "ds.balance",
        label: "잔액",
        value: "$7.42",
        bar: false,
        windows: [
          windowOf({
            id: "api.budget_month",
            kind: "budget",
            label: "이번 달 예산",
            usedPercent: 0,
            remaining: 5,
            limit: 5,
            unit: "USD",
            source: "ledger",
          }),
          windowOf({ id: "ds.balance", kind: "balance", label: "잔액", remaining: 7.42, unit: "USD", source: "poll" }),
        ],
      },
      {
        name: "Codex with a nearly spent per-minute window",
        lead: "codex.primary",
        label: "5시간",
        value: "남음 16%",
        bar: true,
        windows: [
          windowOf({
            id: "codex.primary",
            label: "5시간",
            usedPercent: 84,
            status: "warning",
            resetAt: NOW + 65 * 60_000,
          }),
          windowOf({ id: "codex.secondary", label: "주간", usedPercent: 61 }),
          windowOf({ id: "oai.requests", kind: "rate", label: "분당 요청", usedPercent: 99 }),
        ],
      },
    ]
    let windows: object[] = []
    await mock(page, "quota.snapshot", () => ({ windows }))
    // The account counts as used just now, so the sidebar's 사용 중 계정 lists it.
    await page.route(/\/api\/rpc\/own\.accounts\/accounts\.list(\?|$)/, async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as { output: { accounts: { id: string }[] } }
      body.output.accounts = body.output.accounts.map((account) =>
        account.id === state.account.id ? { ...account, lastUsedAt: Date.now() } : account,
      )
      await route.fulfill({ response, json: body })
    })
    const id = state.account.id
    const lead = (scope: Locator) => scope.locator("[data-window]").first()
    for (const set of sets) {
      windows = set.windows
      await page.goto(`/srv/local/s/${first!.id}`)
      const glance = page.getByTestId("accounts-in-use").locator(`[data-account-id="${id}"] .own-glance-item`).first()
      await expect(glance, set.name).toHaveAttribute("data-window", set.lead)
      await expect(lead(page.getByTestId("composer-limit")), set.name).toHaveAttribute("data-window", set.lead)
      // A window known only as blocked draws an empty bar; a balance has no bar, its amount alone.
      await expect(page.getByTestId("composer-limit").locator(".own-glance-value"), set.name).toHaveText(set.value)
      await expect(page.getByTestId("composer-limit").locator(".own-glance-bar"), set.name).toHaveCount(set.bar ? 1 : 0)
      const tab = page.getByTestId("tab-accounts").locator(`[data-account-id="${id}"] [data-testid=limit-summary-line]`)
      await expect(lead(tab), set.name).toHaveAttribute("data-window", set.lead)
      await expect(lead(tab), set.name).toHaveText(`${set.label} ${set.value}`)
      await page.locator("#own-composer-input").focus()
      await page.keyboard.press("Control+Period")
      const row = page.getByTestId("switcher").locator(`[data-testid=switcher-account][data-account-id="${id}"]`)
      await expect(lead(row.getByTestId("switcher-limits")), set.name).toHaveAttribute("data-window", set.lead)
      await page.keyboard.press("Escape")
      await page.goto("/accounts")
      const card = page.locator(`[data-testid=account-card][data-account-id="${id}"] [data-testid=limit-summary-line]`)
      await expect(lead(card), set.name).toHaveAttribute("data-window", set.lead)
      await page.goto("/limits")
      const dashboard = page.locator(
        `[data-testid=limits-card][data-account-id="${id}"] [data-testid=limit-summary-line]`,
      )
      await expect(lead(dashboard), set.name).toHaveAttribute("data-window", set.lead)
      await expect(page.getByTestId("limits-summary"), set.name).toContainText(
        `가장 빠듯한 한도: ${state.account.label} ${set.label} ${set.value}`,
      )
    }
  })

  test("session auto-compaction: range check, save earlier, then follow the account again (5.8.5)", async ({
    page,
  }) => {
    await page.goto(`/srv/local/s/${first!.id}`)
    const card = page.getByTestId("session-card")
    await expect(card.getByTestId("context-bar")).toBeVisible()
    await expect(card.getByTestId("context-trigger")).toContainText("자동 압축")
    await card.getByTestId("session-compaction-open").click()
    const dialog = page.getByTestId("session-compaction-dialog")
    await expect(dialog).toBeVisible()
    await dialog.getByTestId("session-compaction-earlier").check()
    const input = dialog.getByTestId("session-compaction-input")
    const hint = await dialog.locator(".own-field-hint").textContent()
    await input.fill("1,000")
    await expect(dialog.getByRole("alert").first()).toContainText("보다 작게 둘 수 없어요")
    await expect(dialog.getByTestId("session-compaction-save")).toBeDisabled()
    await input.fill("99,000,000")
    await expect(dialog.getByRole("alert").first()).toContainText("보다 늦게 둘 수 없어요")
    await input.fill(hint!.split("–")[0]!.trim())
    await dialog.getByTestId("session-compaction-save").click()
    await expect(dialog).toBeHidden()
    // The caption names the conversation's own point; no line of its own repeats it (UX 2026-10-26).
    await expect(card.getByTestId("context-trigger")).toHaveText(/^자동 압축 \S+ \(이 대화\)$/)
    await expect(card).not.toContainText("이 대화:")
    await card.getByTestId("session-compaction-open").click()
    await page.getByTestId("session-compaction-follow").check()
    await page.getByTestId("session-compaction-save").click()
    await expect(card.getByTestId("context-trigger")).not.toContainText("이 대화")
  })
})

test.describe("사용 중 계정, 이 대화 and the pills fit their room (UX 2026-10-26)", () => {
  const DENSITIES = ["detailed", "simple", "minimal"] as const
  const density = (page: Page, value: (typeof DENSITIES)[number]) =>
    page.evaluate(
      (lists) =>
        localStorage.setItem("own.web.limits.display", JSON.stringify({ mode: "remaining", density: { lists } })),
      value,
    )

  /**
   * Every `·`-separated line on the page (`.own-seps`: the limits summaries and the 이 대화 card's facts): the group
   * that starts each line sits one separator to the left of the clipping box, so its `·` is cut off. Returns the text of
   * every group that starts a line with its separator showing.
   */
  const leadingSeparators = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".own-seps")].flatMap((line) => {
        if (line.getClientRects().length === 0) return []
        if (getComputedStyle(line).overflow !== "hidden") return ["(not clipped)"]
        const box = line.getBoundingClientRect()
        const items = [...line.querySelectorAll<HTMLElement>(":scope > .own-seps-in > *")]
        return items.flatMap((item, index) => {
          const rect = item.getBoundingClientRect()
          const previous = items[index - 1]?.getBoundingClientRect()
          const startsLine = !previous || Math.round(previous.top) !== Math.round(rect.top)
          return startsLine && rect.left > box.left - 4 ? [item.textContent ?? ""] : []
        })
      }),
    )

  test("사용 중 계정: the names keep their room at every density; at 자세히 every bar starts at one x", async ({
    page,
  }) => {
    // Two widths, three densities, a reload each.
    test.setTimeout(240_000)
    // A second account in use with a long name, a balance and a budget: the line has to give way somewhere.
    const beta = { id: "acc_e2e_beta", providerID: "own-e2e-beta", label: "업무용 ChatGPT 계정 아주 긴 이름" }
    await page.route(/\/api\/rpc\/own\.accounts\/accounts\.list(\?|$)/, async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as { output: { accounts: ({ id: string } & Record<string, unknown>)[] } }
      const alpha = body.output.accounts.find((account) => account.id === state.account.id)!
      body.output.accounts = [
        ...body.output.accounts.map((account) =>
          account.id === state.account.id ? { ...account, lastUsedAt: Date.now() } : account,
        ),
        { ...alpha, ...beta, lastUsedAt: Date.now() - 60_000 },
      ]
      await route.fulfill({ response, json: body })
    })
    await mock(page, "quota.snapshot", {
      windows: [
        windowOf({ id: "codex.primary", label: "5시간", usedPercent: 42, resetAt: NOW + 65 * 60_000 }),
        windowOf({ id: "codex.secondary", label: "주간", usedPercent: 18, resetAt: NOW + 3 * 86_400_000 }),
        windowOf({
          accountID: beta.id,
          providerID: beta.providerID,
          id: "ds.balance",
          kind: "balance",
          label: "잔액",
          remaining: 7.42,
          unit: "USD",
          source: "poll",
        }),
        windowOf({
          accountID: beta.id,
          providerID: beta.providerID,
          id: "api.budget_month",
          kind: "budget",
          label: "이번 달 예산",
          usedPercent: 92,
          remaining: 0.4,
          limit: 5,
          unit: "USD",
          status: "warning",
          source: "ledger",
        }),
      ],
    })
    await page.goto(`/srv/local/s/${first!.id}`)
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      for (const value of DENSITIES) {
        await density(page, value)
        await page.reload()
        const where = `${width} px, ${value}`
        const section = page.getByTestId("accounts-in-use")
        await expect(section.locator("button[data-account-id]"), where).toHaveCount(2)
        await expect(section.locator(".own-glance").first(), where).toHaveAttribute("data-density", value)
        const layout = await section.evaluate((root) => {
          const rect = (element: Element | null | undefined) => element?.getBoundingClientRect()
          const lines = [...root.querySelectorAll<HTMLElement>("button[data-account-id]")].map((line) => {
            const name = line.querySelector<HTMLElement>("[data-testid=in-use-name]")!
            const glance = rect(line.querySelector(".own-glance"))
            const box = name.getBoundingClientRect()
            const overlap = glance
              ? box.right > glance.left + 0.5 &&
                glance.right > box.left + 0.5 &&
                box.bottom > glance.top + 0.5 &&
                glance.bottom > box.top + 0.5
              : false
            return {
              width: box.width,
              em: parseFloat(getComputedStyle(name).fontSize),
              cut: name.scrollWidth > name.clientWidth,
              overlap,
              dot: rect(line.firstElementChild)!.left,
              labels: [...line.querySelectorAll(".own-glance-label")].map((label) => label.textContent),
            }
          })
          const heading = root.querySelector("h2")!
          return {
            lines,
            heading: heading.getBoundingClientRect().left + parseFloat(getComputedStyle(heading).paddingLeft),
            icon: rect(document.querySelector("[data-testid=sidebar-settings] svg"))!.left,
            bars: [...root.querySelectorAll(".own-glance-bar, .own-glance-gap")].map((bar) => rect(bar)!.left),
          }
        })
        for (const line of layout.lines) {
          expect(line.width, where).toBeGreaterThan(0)
          // The name gives way first but keeps 7em; the windows wrap under it before that.
          if (line.cut) expect(line.width, where).toBeGreaterThanOrEqual(7 * line.em - 1)
          expect(line.overlap, where).toBe(false)
          // The heading, every dot and the footer's 설정 icon share one left edge.
          expect(Math.abs(line.dot - layout.icon), where).toBeLessThanOrEqual(1)
        }
        expect(Math.abs(layout.heading - layout.icon), where).toBeLessThanOrEqual(1)
        // Named windows at 간단히 too (`5시간 ▬ 남음 58%`); 아주 간단히 stays the ring and its number.
        expect(layout.lines[0]!.labels, where).toEqual(
          value === "detailed" ? ["5시간", "주간"] : value === "simple" ? ["5시간"] : [],
        )
        if (value !== "detailed") continue
        // 자세히: two rows per account under its name, every bar (and the balance's empty cell) at one x.
        expect(layout.bars, where).toHaveLength(4)
        for (const left of layout.bars) expect(Math.abs(left - layout.bars[0]!), where).toBeLessThanOrEqual(1)
      }
    }
    // The hover text names every window, and a click opens the 계정·한도 tab.
    const alpha = page.getByTestId("accounts-in-use").locator(`button[data-account-id="${state.account.id}"]`)
    await expect(alpha.locator(".own-glance")).toHaveAttribute("title", /5시간 남음 58%[^\n]*\n주간 남음 82%/)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator("#own-tab-files").click()
    await expect(page.locator("#own-tab-accounts")).toHaveAttribute("aria-selected", "false")
    await alpha.click()
    await expect(page.locator("#own-tab-accounts")).toHaveAttribute("aria-selected", "true")
    await expect(page.getByTestId("tab-accounts")).toBeVisible()
    await page.evaluate(() => localStorage.removeItem("own.web.limits.display"))
  })

  test("이 대화: four rows at most, and no line of the card or the summaries starts with `·`", async ({ page }) => {
    await page.goto(`/srv/local/s/${first!.id}`)
    const card = page.getByTestId("session-card")
    await expect(card.getByTestId("context-bar")).toBeVisible()
    // `이 대화 · GPT-5.5` and `전환…` on one row, the bar, the muted facts, the links.
    const switchButton = card.getByTestId("session-switch")
    const title = card.getByTestId("session-binding")
    const [titleBox, switchBox] = [await title.boundingBox(), await switchButton.boundingBox()]
    expect(Math.abs(titleBox!.y + titleBox!.height / 2 - (switchBox!.y + switchBox!.height / 2))).toBeLessThanOrEqual(2)
    await expect(card.getByTestId("context-used")).toHaveText(/^\S+ \/ \S+$/)
    await expect(card.getByTestId("cache-state")).toContainText(/^캐시 /)
    await expect(card.getByRole("button", { name: "대화 정보" })).toHaveClass(/own-link/)
    await expect(card.getByTestId("session-compaction-open")).toHaveClass(/own-link/)
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      const box = await card.boundingBox()
      expect(box!.height, `${width} px`).toBeLessThanOrEqual(160)
      expect(await leadingSeparators(page), `${width} px`).toEqual([])
    }
    // The composer's ring writes the same number as the card's bar.
    const used = (await card.getByTestId("context-used").textContent())!.split(" / ")[0]
    if (used !== "—") await expect(page.getByTestId("context-meter-used")).toHaveText(used!)
  })

  test("the pills at 1024 and 1440 px: the account stays whole; the composer's limit folds by its room, never away", async ({
    page,
  }) => {
    // Three densities, two widths, the work panel open and closed, then the new-conversation screen: a reload each.
    test.setTimeout(420_000)
    await mock(page, "quota.snapshot", {
      windows: [
        windowOf({ id: "codex.primary", label: "5시간", usedPercent: 42, resetAt: NOW + 65 * 60_000 }),
        windowOf({ id: "codex.secondary", label: "주간", usedPercent: 18, resetAt: NOW + 3 * 86_400_000 }),
      ],
    })
    /** The composer's `모델 @ 계정` parts cut for room, to the subpixel (an ellipsis shows from 1/32 px). */
    const cutParts = () =>
      page.getByTestId("composer-switcher-label").evaluate((label) =>
        [...label.querySelectorAll<HTMLElement>("[data-part]")].flatMap((part) => {
          if (getComputedStyle(part).position === "absolute") return []
          const text = document.createRange()
          text.selectNodeContents(part)
          return text.getBoundingClientRect().width > part.getBoundingClientRect().width + 0.01
            ? [part.dataset.part]
            : []
        }),
      )
    await page.goto(`/srv/local/s/${first!.id}`)
    for (const value of DENSITIES) {
      await density(page, value)
      for (const [width, open] of [
        [1024, true],
        [1024, false],
        [1440, true],
        [1440, false],
      ] as const) {
        await page.setViewportSize({ width, height: 800 })
        await page.reload()
        const toggle = page.getByTestId("panel-toggle")
        if ((await toggle.getAttribute("aria-pressed")) !== String(open)) await toggle.click()
        await expect(toggle).toHaveAttribute("aria-pressed", String(open))
        const where = `${width} px, panel ${open ? "open" : "closed"}, ${value}`
        for (const label of ["running-on", "composer-switcher-label"]) {
          const account = page.getByTestId(label).locator('[data-part="account"]')
          await expect(account, where).toHaveText(state.account.label)
          await expect(page.getByTestId(label), where).toHaveText(new RegExp(` @ ${state.account.label}$`))
          expect(await account.evaluate((part) => part.scrollWidth <= part.clientWidth), `${label}, ${where}`).toBe(
            true,
          )
        }
        // UX 2026-10-27: the limit folds by the room the toolbar has (composer/limit-fit.ts), from the density's own
        // form to the ring and its number to the ring alone, and never leaves: its spoken text stays.
        const limit = page.getByTestId("composer-limit")
        await expect(limit, where).toBeVisible()
        await expect(limit.locator(".own-glance-item"), where).toHaveCount(1)
        await expect(limit.locator(".sr-only"), where).toHaveText("5시간 58% 남음")
        const bar = page.locator(".own-cp-bar")
        await expect(bar, where).not.toHaveAttribute("data-new")
        const fold = Number((await bar.getAttribute("data-fold")) ?? 0)
        await expect(
          limit.locator(fold > 0 || value === "minimal" ? ".own-glance-ring" : ".own-glance-bar"),
          where,
        ).toBeVisible()
        await expect(limit.locator(".own-glance-value"), where).toBeVisible({ visible: fold < 3 })
        // Each step is kept only when the one before did not fit: below the floor nothing of `모델 @ 계정` is cut.
        if (fold < 3) expect(await cutParts(), where).toEqual([])
        const [glance, button] = [await limit.boundingBox(), await page.getByTestId("composer-switcher").boundingBox()]
        expect(glance!.x + glance!.width, where).toBeLessThanOrEqual(button!.x + button!.width + 0.5)
        expect(await limit.evaluate((element) => element.scrollWidth <= element.clientWidth), where).toBe(true)
      }
      // The new-conversation screen's two-row toolbar never folds it: its second row has the room.
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 800 })
        await page.goto("/")
        const where = `new conversation, ${width} px, ${value}`
        const bar = page.locator(".own-cp-bar")
        await expect(bar, where).toHaveAttribute("data-new", "")
        const limit = page.getByTestId("composer-limit")
        await expect(limit.locator(value === "minimal" ? ".own-glance-ring" : ".own-glance-bar"), where).toBeVisible()
        await expect(bar, where).not.toHaveAttribute("data-fold")
        await expect(limit.locator(".own-glance-value"), where).toBeVisible()
      }
      await page.goto(`/srv/local/s/${first!.id}`)
    }
    await page.evaluate(() => localStorage.removeItem("own.web.limits.display"))
  })
})

test.describe("accounts page (5.4)", () => {
  test("card, rename with a real Korean IME composition (12장), connection test", async ({ page }) => {
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${state.account.id}"]`)
    await expect(card.getByTestId("account-name")).toHaveText(state.account.label)
    await expect(card.getByTestId("account-identity")).toContainText("키 ")
    await expect(card.getByTestId("account-compaction")).toContainText("자동 압축: 모델 한도 · 창의 85%")
    // The e2e backend's app folder carries no bundle (02 §8.2): a restart cannot help, reinstalling would.
    await expect(page.getByTestId("claude-bundle-absent")).toContainText("이 앱 설치에 Claude 구독 플러그인이 없어요")

    await page.screenshot({ path: test.info().outputPath("accounts-page.png"), fullPage: true })
    await card.getByTestId("account-menu").click()
    await page.getByTestId("menu-rename").click()
    const input = page.getByTestId("rename-input")
    await expect(input).toBeFocused()
    await input.fill("")
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.imeSetComposition", { text: "알", selectionStart: 1, selectionEnd: 1 })
    await cdp.send("Input.imeSetComposition", { text: "알파", selectionStart: 2, selectionEnd: 2 })
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    await cdp.send("Input.insertText", { text: "알파" })
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    await expect(page.getByTestId("rename-dialog")).toBeHidden()
    await expect(card.getByTestId("account-name")).toHaveText("알파")

    await card.getByTestId("account-menu").click()
    await page.getByTestId("menu-rename").click()
    await page.getByTestId("rename-input").fill(state.account.label)
    await page.getByTestId("rename-input").press("Enter")
    await expect(card.getByTestId("account-name")).toHaveText(state.account.label)

    await card.getByTestId("account-menu").click()
    await page.getByTestId("menu-test").click()
    await expect(card.getByTestId("account-card-status")).toContainText(/확인됨 · \d+ms/)
  })

  test("add an OpenAI key (tested, key leaves the form), then remove it with the two-step plan", async ({ page }) => {
    await page.goto("/accounts")
    await page.getByTestId("open-add-account").click()
    await expect(page).toHaveURL(/\/accounts\/add$/)
    const dialog = page.getByTestId("add-account-dialog")
    await expect(dialog.getByTestId("add-type-grid")).toBeVisible()
    // The old-app card only shows when the import finds codex-multi-provider.
    await expect(dialog.locator('[data-choice="codexImport"]')).toHaveCount(0)
    await dialog.locator('[data-choice="oai"]').click()
    const form = dialog.getByTestId("api-key-form")
    await expect(form.getByTestId("key-label")).toHaveValue("OpenAI 1")
    await form.getByTestId("key-label").fill("E2E 보조 키")
    await form.getByTestId("key-secret").fill("sk-proj-ownWebE2eSecondKey0000000000000002")
    await page.screenshot({ path: test.info().outputPath("add-key.png") })
    await expect(form).toContainText("Windows 사용자로만 열리게 암호화")
    await form.getByTestId("key-submit").click()
    // 16.3: the secret leaves the form (and the DOM) as soon as it is sent.
    await expect(form.getByTestId("key-secret")).toHaveValue("")
    await expect(dialog.getByTestId("add-done")).toContainText("확인됨")
    await expect(dialog.getByTestId("add-done")).toContainText("계정이 추가되었어요. 실행 중인 대화는 바뀌지 않아요.")
    await dialog.getByTestId("add-close").click()
    await expect(page).toHaveURL(/\/accounts$/)
    const added = page.getByTestId("account-card").filter({ hasText: "E2E 보조 키" })
    await expect(added).toBeVisible()
    await expect(page.getByTestId("provider-section").filter({ hasText: "OpenAI API" })).toContainText("API · 2개")

    await added.getByTestId("account-menu").click()
    await page.getByTestId("menu-remove").click()
    const remove = page.getByTestId("remove-dialog")
    await expect(remove.getByTestId("remove-plan")).toContainText("이 계정을 쓰는 대화가 없어요.")
    await remove.getByTestId("remove-disable").check()
    await expect(remove.getByTestId("remove-plan")).toContainText("다시 켤 수 있어요")
    await remove.getByRole("radio", { name: "계정과 이 PC에 저장된 키 삭제" }).check()
    await remove.getByTestId("remove-execute").click()
    await expect(remove).toBeHidden()
    await expect(page.getByTestId("account-card").filter({ hasText: "E2E 보조 키" })).toHaveCount(0)
  })

  test("add a local model account: each model's 그림 입력 and 도구 go with the key (mocked RPC, 02 §3.3)", async ({
    page,
  }) => {
    const sent: Record<string, unknown>[] = []
    await mock(page, "accounts.add.key", (input) => {
      sent.push(input)
      return {
        account: { id: "acc_local_e2e", providerID: "own-compat-lc01", status: "ready" },
        test: { ok: true },
        sameDomainCandidates: [],
      }
    })
    await page.goto("/accounts/add")
    const dialog = page.getByTestId("add-account-dialog")
    await dialog.locator('[data-choice="compat"]').click()
    const form = dialog.getByTestId("api-key-form")
    await form.getByTestId("key-label").fill("내 PC Ollama")
    await form.getByTestId("key-secret").fill("ollama-e2e-fake-key")
    await form.getByTestId("compat-base-url").fill("http://127.0.0.1:11434/v1")
    await form.getByTestId("compat-model-id").fill("qwen2.5vl:7b")
    await form.getByTestId("compat-model-context").fill("32768")
    // Every model starts on 자동: what the server reports.
    const vision = form.locator('[data-testid=compat-capabilities][data-model="qwen2.5vl:7b"]')
    await expect(vision.getByTestId("compat-image").getByRole("radio", { name: "자동" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await expect(form).toContainText("알려 주지 않으면 그림 입력은 끔, 도구는 켬이에요.")
    await vision.getByTestId("compat-image").getByRole("radio", { name: "켬" }).click()
    await form.getByRole("button", { name: "모델 추가" }).click()
    await form.getByTestId("compat-model-id").nth(1).fill("gemma3:1b")
    await form.getByTestId("compat-model-context").nth(1).fill("8k")
    await form
      .locator('[data-testid=compat-capabilities][data-model="gemma3:1b"]')
      .getByTestId("compat-tools")
      .getByRole("radio", { name: "끔" })
      .click()
    await page.screenshot({ path: test.info().outputPath("add-compat.png") })
    await form.getByTestId("key-submit").click()
    await expect(dialog.getByTestId("add-done")).toBeVisible()
    expect(sent).toHaveLength(1)
    // Settings left on 자동 are not sent: the router follows the server for them.
    expect((sent[0]!.options as { models: unknown[] }).models).toEqual([
      { id: "qwen2.5vl:7b", contextLimit: 32_768, image: "on" },
      { id: "gemma3:1b", contextLimit: 8_000, tools: "off" },
    ])
  })

  test("a local model card shows what each model can do; 모델 기능… saves only what changed (mocked, 02 §3.3)", async ({
    page,
  }) => {
    await mock(page, "accounts.list", {
      revision: 996,
      accounts: [
        {
          id: "acc_local",
          kind: "compat",
          label: "내 PC Ollama",
          shortLabel: "내",
          color: "teal",
          providerID: "own-compat-lc01",
          billing: "metered",
          status: "ready",
          autoSwitch: true,
          thirdParty: false,
          readOnly: false,
          identity: { keyHint: "…-key" },
          connection: { type: "key", method: "api-key" },
          compat: {
            server: { family: "ollama", overflowClassified: false },
            models: [
              {
                id: "qwen2.5vl:7b",
                output: { tokens: 32_000, source: "fallback" },
                image: { on: true, setting: "auto", detected: true },
                tools: { on: true, setting: "auto", detected: true },
              },
              {
                id: "gemma3:1b",
                output: { tokens: 8_000, source: "fallback" },
                image: { on: false, setting: "auto", detected: false },
                tools: { on: false, setting: "auto", detected: false },
              },
            ],
          },
        },
      ],
    })
    const updates: Record<string, unknown>[] = []
    await mock(page, "accounts.update", (input) => {
      updates.push(input)
      return { account: { id: "acc_local" } }
    })
    await page.goto("/accounts")
    const card = page.locator('[data-testid=account-card][data-account-id="acc_local"]')
    await expect(card.getByTestId("compat-capabilities-line")).toHaveText(
      "모델 기능: qwen2.5vl:7b 그림 입력 켬(서버 값) · 도구 켬(서버 값), gemma3:1b 그림 입력 끔(서버 값) · 도구 끔(서버 값)",
    )
    await expect(card.getByTestId("compat-no-tools")).toContainText("도구가 꺼진 모델은 대화만 해요.")
    await card.getByTestId("account-menu").click()
    await page.getByTestId("menu-compat-capabilities").click()
    const dialog = page.getByTestId("compat-capabilities-dialog")
    await expect(dialog).toContainText("모델 기능 · 내 PC Ollama")
    const gemma = dialog.locator('[data-testid=compat-capabilities][data-model="gemma3:1b"]')
    await expect(gemma.getByTestId("compat-tools-detected")).toHaveText("서버: 도구를 못 써요")
    await expect(gemma.getByTestId("compat-image-detected")).toHaveText("서버: 그림을 못 봐요")
    await expect(dialog.getByTestId("compat-capabilities-save")).toBeDisabled()
    await gemma.getByTestId("compat-tools").getByRole("radio", { name: "켬" }).click()
    await page.screenshot({ path: test.info().outputPath("compat-capabilities.png") })
    await dialog.getByTestId("compat-capabilities-save").click()
    await expect(dialog).toBeHidden()
    expect(updates).toEqual([{ accountID: "acc_local", compatCapabilities: [{ id: "gemma3:1b", tools: "on" }] }])
  })

  test("add a 로컬 모델 account: server preset, API format, 서버에서 불러오기, reasoning, no key (mocked RPC, 02 §3.3a)", async ({
    page,
  }) => {
    const sent: Record<string, unknown>[] = []
    const asked: Record<string, unknown>[] = []
    await mock(page, "accounts.local.detect", (input) => {
      asked.push(input)
      return {
        ok: true,
        family: "vllm",
        latencyMs: 12,
        models: [
          {
            id: "local-flash-model-q4-0001",
            context: 1_048_576,
            reasoning: { style: "effort", levels: ["low", "high", "xhigh", "max"], default: "max" },
          },
          { id: "qwen3-8b", context: 32_768 },
        ],
      }
    })
    await mock(page, "accounts.add.key", (input) => {
      sent.push(input)
      return {
        account: { id: "acc_local_e2e", providerID: "own-compat-lm01", status: "ready" },
        test: { ok: true },
        sameDomainCandidates: [],
      }
    })
    await page.goto("/accounts/add")
    const dialog = page.getByTestId("add-account-dialog")
    const card = dialog.locator('[data-choice="local"]')
    await expect(card).toContainText("로컬 모델")
    await expect(card).toContainText("무료")
    await card.click()
    const form = dialog.getByTestId("local-model-form")
    // Ollama is the first preset: its address and format.
    await expect(form.getByTestId("local-base-url")).toHaveValue("http://127.0.0.1:11434/v1")
    await expect(form.getByTestId("local-format").getByRole("radio", { name: "Ollama" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await form.locator('[data-preset="vllm"]').click()
    await expect(form.getByTestId("local-base-url")).toHaveValue("http://127.0.0.1:8000/v1")
    await form.getByTestId("local-base-url").fill("http://localhost:64644/v1")
    await expect(form.getByTestId("local-format").getByRole("radio", { name: "OpenAI 호환" })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await form.getByTestId("local-detect").click()
    await expect(form.getByTestId("local-detect-status")).toContainText("vLLM · 모델 2개를 찾았어요.")
    const found = form.getByTestId("local-found")
    await expect(found.locator('[data-model="local-flash-model-q4-0001"]')).toContainText("추론 low·high·xhigh·max")
    await found.locator('[data-model="local-flash-model-q4-0001"] input').check()
    await found.locator('[data-model="qwen3-8b"] input').check()
    const rows = form.getByTestId("local-model-row")
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByTestId("local-model-context")).toHaveValue("1048576")
    const think = form.locator('[data-testid=local-reasoning][data-model="local-flash-model-q4-0001"]')
    await expect(think.getByTestId("local-reasoning-detected")).toHaveText(
      "서버: 단계 low · high · xhigh · max (기본 max)",
    )
    const qwen = form.locator('[data-testid=local-reasoning][data-model="qwen3-8b"]')
    await qwen.getByTestId("local-reasoning-mode").getByRole("radio", { name: "켬·끔" }).click()
    await expect(qwen).toContainText("보내는 값: chat_template_kwargs.enable_thinking")
    await page.screenshot({ path: test.info().outputPath("add-local.png") })
    await form.getByTestId("local-submit").click()
    await expect(dialog.getByTestId("add-done")).toContainText("로컬 모델을 추가했어요. 비용은 들지 않아요.")
    expect(asked).toEqual([{ baseURL: "http://localhost:64644/v1", format: "chat" }])
    expect(sent).toHaveLength(1)
    // No key: none is sent. `자동` reasoning follows the server, so only the toggle goes.
    expect(sent[0]!.key).toBeUndefined()
    expect(sent[0]!.kind).toBe("compat")
    expect(sent[0]!.options).toEqual({
      baseURL: "http://localhost:64644/v1",
      local: { format: "chat" },
      models: [
        { id: "local-flash-model-q4-0001", contextLimit: 1_048_576 },
        { id: "qwen3-8b", contextLimit: 32_768, reasoning: { style: "toggle" } },
      ],
    })
  })

  test("로컬 모델로 바꾸기 on a compat card; a local card shows its format and levels (mocked, 02 §3.3a)", async ({
    page,
  }) => {
    const capability = { on: true, setting: "auto" }
    const base = {
      kind: "compat",
      shortLabel: "L",
      color: "teal",
      status: "ready",
      autoSwitch: true,
      thirdParty: false,
      readOnly: false,
      connection: { type: "key", method: "api-key" },
    }
    await mock(page, "accounts.list", {
      revision: 995,
      accounts: [
        {
          ...base,
          id: "acc_compat",
          label: "local-flash-1",
          providerID: "own-compat-cp01",
          billing: "metered",
          identity: { keyHint: "…abcd" },
          compat: {
            server: { family: "vllm", overflowClassified: false },
            models: [{ id: "local-flash-model-q4-0001", image: capability, tools: capability }],
          },
        },
        {
          ...base,
          id: "acc_local",
          label: "집 서버",
          providerID: "own-compat-lc02",
          billing: "local",
          identity: {},
          compat: {
            server: { family: "vllm", overflowClassified: false },
            local: { format: "chat" },
            models: [
              {
                id: "local-flash-model-q4-0001",
                image: capability,
                tools: capability,
                reasoning: {
                  setting: "auto",
                  detected: { style: "effort", levels: ["low", "max"] },
                  levels: ["low", "max"],
                },
              },
            ],
          },
        },
      ],
    })
    const updates: Record<string, unknown>[] = []
    await mock(page, "accounts.update", (input) => {
      updates.push(input)
      return { account: { id: input.accountID } }
    })
    await page.goto("/accounts")
    const local = page.locator('[data-testid=account-card][data-account-id="acc_local"]')
    await expect(local.getByTestId("local-line")).toHaveText("로컬 모델 · OpenAI 호환 · 키 없음 · 비용 없음")
    await expect(local.getByTestId("local-levels")).toHaveText(
      "추론 강도: local-flash-model-q4-0001 low · max(서버 값)",
    )
    await expect(local.getByTestId("local-convert")).toHaveCount(0)
    await local.getByTestId("account-menu").click()
    await expect(page.getByRole("menuitem", { name: "예산 설정…" })).toHaveCount(0)
    await page.keyboard.press("Escape")
    const compat = page.locator('[data-testid=account-card][data-account-id="acc_compat"]')
    await expect(compat.getByTestId("local-line")).toHaveCount(0)
    await compat.getByTestId("local-convert").click()
    const convert = page.getByTestId("local-convert-dialog")
    await expect(convert).toContainText("로컬 모델로 바꾸기 · local-flash-1")
    await page.screenshot({ path: test.info().outputPath("local-convert.png") })
    await convert.getByTestId("local-convert-save").click()
    await expect(convert).toBeHidden()
    expect(updates).toEqual([{ accountID: "acc_compat", local: { format: "chat" } }])
  })

  test("Codex import: list, takeover confirm with warnings, execute, done (mocked RPC, 5.4.2)", async ({ page }) => {
    const planned: Record<string, unknown>[] = []
    await mock(page, "accounts.import.codex.list", {
      available: true,
      sources: [
        {
          profileID: "02",
          alias: "work-pro",
          importable: true,
          identity: { emailMasked: "ki***@acme.com", plan: "pro" },
          lastRefresh: new Date(NOW - 7_200_000).toISOString(),
          importedAs: null,
        },
        {
          profileID: "05",
          alias: "personal",
          importable: false,
          problem: "token_expired",
          identity: { emailMasked: "pe***@gmail.com", plan: "plus" },
          lastRefresh: new Date(NOW - 3 * 86_400_000).toISOString(),
          importedAs: null,
        },
        { profileID: "p_7f3a", alias: null, importable: false, problem: "not_chatgpt", importedAs: null },
      ],
    })
    await mock(page, "accounts.import.codex.plan", (input) => {
      planned.push(input)
      return {
        nonce: "non_e2e",
        expiresAt: NOW + 120_000,
        profileID: "02",
        alias: "work-pro",
        mode: input.mode,
        identity: { emailMasked: "ki***@acme.com", plan: "pro" },
        duplicateOf: null,
        warnings: input.mode === "takeover" ? ["takeover_supersedes_source"] : ["linked_depends_on_source"],
      }
    })
    await mock(page, "accounts.import.codex.execute", (input) => ({
      account: {
        id: "acc_codex_e2e",
        kind: "codex",
        label: input.label,
        shortLabel: "W",
        color: "violet",
        providerID: "own-codex-e2ex",
        billing: "subscription",
        status: "ready",
        autoSwitch: false,
        thirdParty: false,
        readOnly: false,
        connection: { type: "oauth", method: "codex-takeover" },
      },
      mode: "takeover",
      reauthenticated: false,
    }))
    await page.goto("/accounts")
    await page.getByTestId("open-codex-import").click()
    const dialog = page.getByTestId("codex-import-dialog")
    await expect(dialog).toContainText("ChatGPT 로그인 3개를 찾았어요.")
    const rows = dialog.getByTestId("codex-list").locator("li")
    await expect(rows.nth(1)).toContainText("토큰이 만료되었어요 — 이전 앱에서 이 프로필을 한 번 열어 갱신하세요")
    await expect(rows.nth(2)).toContainText("p_7f3a (별칭 없음)")
    await expect(rows.nth(1).getByTestId("codex-row-check")).toBeDisabled()
    await rows.nth(0).getByTestId("codex-row-check").check()
    await dialog.getByTestId("codex-mode-takeover").check()
    await dialog.getByTestId("codex-next").click()
    const confirm = dialog.getByTestId("codex-confirm")
    await expect(confirm.getByTestId("codex-confirm-title")).toHaveText("work-pro · ki***@acme.com · Pro")
    await expect(confirm).toContainText("이 앱이 처음 갱신하면 이전 앱의 이 프로필 로그인은 더 쓸 수 없게 될 수 있어요")
    await expect(confirm.getByTestId("codex-label")).toHaveValue("work-pro")
    await confirm.getByTestId("codex-execute").click()
    await expect(dialog.getByTestId("codex-done")).toContainText(
      '"work-pro" 계정을 인수했어요. 실행 중인 대화는 바뀌지 않아요.',
    )
    expect(planned[0]).toMatchObject({ profileID: "02", mode: "takeover" })
  })

  test("linked Codex login gone stale shows the banner and the takeover path (mocked, 5.4.2)", async ({ page }) => {
    await mock(page, "accounts.list", {
      revision: 999,
      accounts: [
        {
          id: "acc_linked",
          kind: "codex",
          label: "work-pro",
          shortLabel: "W",
          color: "teal",
          providerID: "own-codex-lnk1",
          billing: "subscription",
          status: "auth_failed",
          autoSwitch: false,
          thirdParty: false,
          readOnly: false,
          identity: { emailMasked: "ki***@acme.com", plan: "pro" },
          connection: {
            type: "oauth",
            method: "codex-linked",
            source: {
              app: "codex-multi-provider",
              profileID: "02",
              alias: "work-pro",
              mode: "linked",
              superseded: false,
            },
          },
        },
      ],
    })
    await page.goto("/accounts")
    const card = page.locator('[data-testid=account-card][data-account-id="acc_linked"]')
    await expect(card.getByTestId("codex-stale-banner")).toContainText(
      '"work-pro" 로그인이 만료되었고, 이전 앱이 아직 갱신하지 않았어요.',
    )
    await expect(card.getByTestId("codex-connection")).toContainText(
      '연결 · 이전 앱 프로필 "work-pro" (읽기 전용, 이전 앱이 갱신)',
    )
    await expect(card.getByTestId("account-status")).toHaveText("이전 앱 갱신 대기")
    await card.getByTestId("account-menu").click()
    await expect(page.getByTestId("menu-takeover")).toBeVisible()
  })

  test("Claude slot: built in and always on, the notice as information → import, no consent (mocked, 5.4.1)", async ({
    page,
  }) => {
    const status = { imported: false }
    // The plugin ships with the app (02 §8.2, 2026-10-18): the page never installs, patches or acknowledges.
    const refused: string[] = []
    for (const method of [
      "plugin.claudeAuth.ack",
      "plugin.claudeAuth.install.plan",
      "plugin.claudeAuth.install.execute",
      "plugin.claudeAuth.patch.plan",
      "plugin.claudeAuth.patch.execute",
    ])
      await mock(page, method, () => {
        refused.push(method)
        return {}
      })
    await mock(page, "plugin.claudeAuth.status", () => ({
      installed: true,
      version: "0.4.0-beta.5",
      integrityOk: true,
      order: "ok",
      phase: status.imported ? "ready" : "installed",
      acknowledged: null,
      connection: status.imported
        ? { type: "oauth", method: "claude-code", label: "Claude Max · na***@gmail.com" }
        : null,
      warnings: [],
      patch: { state: "patched", sha256: "a".repeat(64), loaded: true },
      bundle: { version: "0.4.0-beta.5", integrity: "sha512-x", patchSha256: "a".repeat(64), buildId: "e2e" },
    }))
    await mock(page, "plugin.claudeAuth.importSubscription", () => {
      status.imported = true
      return { ok: true, connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@gmail.com" } }
    })
    await page.goto("/accounts")
    const section = page.getByTestId("claude-section")
    await expect(section).toContainText("앱에 포함 · 항상 켜짐")
    await section.getByTestId("claude-connect").click()
    const flow = page.getByTestId("claude-flow-dialog")
    await expect(flow.getByTestId("claude-notice")).toContainText(
      "Anthropic 약관은 서드파티 앱이 Claude 구독 로그인(OAuth)을 쓰는 것을 허용하지 않습니다",
    )
    await expect(flow.getByTestId("claude-notice")).toContainText("따로 동의를 받지 않으며")
    await page.screenshot({ path: test.info().outputPath("claude-notice.png") })
    await flow.getByTestId("claude-import-run").click()
    await expect(flow).toContainText("Claude Max · na***@gmail.com (가져올 때 기준)")
    expect(refused).toEqual([])
  })

  test("Claude cards: the extra-usage line, 자세히, and what each account's responses revealed (mocked, 5.4.1(d))", async ({
    page,
  }) => {
    // claude.ai opens as a popup; a local stand-in answers it, so nothing reaches Anthropic.
    await page
      .context()
      .route(/^https:\/\/claude\.ai\//, (route) =>
        route.fulfill({ contentType: "text/html", body: "<title>stand-in</title>" }),
      )
    await mock(page, "plugin.claudeAuth.status", {
      installed: true,
      version: "0.4.0-beta.5",
      integrityOk: true,
      order: "ok",
      phase: "ready",
      acknowledged: null,
      connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@gmail.com" },
      warnings: [],
      patch: { state: "patched", sha256: "a".repeat(64), loaded: true },
      bundle: { version: "0.4.0-beta.5", integrity: "sha512-x", patchSha256: "a".repeat(64), buildId: "e2e" },
    })
    await mock(page, "plugin.claudeAuth.accounts.detect", { found: null, imported: true })
    const claudeAccount = (id: string, label: string, isDefault: boolean) => ({
      id,
      kind: "claude-sub",
      label,
      shortLabel: "C",
      color: "orange",
      providerID: "anthropic",
      billing: "subscription",
      status: "ready",
      autoSwitch: false,
      thirdParty: true,
      readOnly: true,
      connection: { type: "oauth", method: "claude-code" },
      claude: { managed: id !== "acc_claude_slot", default: isDefault, folder: "C:\\fake\\.claude", loaded: true },
      plugin: { installed: true, acknowledged: true, version: "0.4.0-beta.5" },
    })
    await mock(page, "accounts.list", {
      revision: 996,
      accounts: [
        claudeAccount("acc_claude_slot", "Claude", true),
        claudeAccount("acc_01J9CLAUDETWO0000000000000", "업무", false),
        claudeAccount("acc_01J9CLAUDETHREE00000000000", "개인", false),
      ],
    })
    const claudeWindow = (accountID: string, patch: Record<string, unknown>) => ({
      accountID,
      providerID: "anthropic",
      scope: "account",
      confidence: "live",
      source: "header",
      observedAt: NOW - 3 * 60_000,
      ...patch,
    })
    const overage = { id: "claude.overage", kind: "spend_cap", label: "추가 사용량" }
    await mock(page, "quota.snapshot", {
      windows: [
        claudeWindow("acc_claude_slot", {
          id: "claude.5h",
          kind: "rolling_quota",
          label: "5시간",
          windowMinutes: 300,
          usedPercent: 100,
          status: "exhausted",
        }),
        claudeWindow("acc_claude_slot", { ...overage, status: "ok", meta: { billing: "extra_usage" } }),
        claudeWindow("acc_01J9CLAUDETWO0000000000000", {
          ...overage,
          status: "exhausted",
          source: "error",
          meta: { billing: "rejected", disabledReason: "org_level_disabled" },
        }),
      ],
    })
    await page.goto("/accounts")
    const line =
      "Anthropic 정책(2026-04-04)으로 Claude Code 밖에서 쓰는 구독 사용은 구독 한도가 아니라 추가 사용량(종량제)으로 청구될 수 있어요. claude.ai › 설정 › 사용량에서 확인하세요."
    const slot = page.getByTestId("claude-slot-card")
    const cards = page.getByTestId("claude-account-card")
    await expect(slot.getByTestId("claude-billing-line")).toHaveText(line)
    await expect(cards).toHaveCount(2)
    for (const card of [cards.nth(0), cards.nth(1)])
      await expect(card.getByTestId("claude-billing-line")).toHaveText(line)
    // The line cannot be closed: no button in it.
    await expect(slot.getByTestId("claude-billing").getByRole("button", { name: /닫기|숨기기/ })).toHaveCount(0)

    // What each account's latest response said: moved to extra usage, refused with extra usage off, nothing.
    await expect(slot.getByTestId("claude-billing-state")).toContainText(
      "이 계정은 지금 추가 사용량으로 청구되고 있어요",
    )
    await expect(slot.getByTestId("claude-billing-state")).toContainText(/\d분 전 응답 기준/)
    const two = page.locator('[data-testid=claude-account-card][data-account-id="acc_01J9CLAUDETWO0000000000000"]')
    await expect(two.getByTestId("claude-billing-state")).toContainText(
      "추가 사용량이 꺼져 있어 거절됐어요 · claude.ai에서 켜거나 API 키를 쓰세요",
    )
    const three = page.locator('[data-testid=claude-account-card][data-account-id="acc_01J9CLAUDETHREE00000000000"]')
    await expect(three.getByTestId("claude-billing-state")).toHaveCount(0)

    // 자세히: the dates, what cannot be known, how to check, the sources.
    const more = three.getByTestId("claude-billing-more")
    await expect(more.locator("summary")).toHaveText("자세히")
    await expect(more.getByTestId("claude-billing-unknown")).toBeHidden()
    await more.locator("summary").click()
    await expect(more).toContainText("2026-01-09")
    await expect(more).toContainText("2026-02-19")
    await expect(more).toContainText("2026-04-04 낮 12시(미국 태평양 시간)부터")
    await expect(more.getByTestId("claude-billing-unknown")).toContainText("응답만으로는 알 수 없어요")
    await expect(more).toContainText("이 계정으로 짧은 메시지를 하나 보내요.")
    await expect(more).toContainText("어느 쪽인지 장담하지 않아요")
    await expect(more.getByTestId("claude-billing-sources").getByRole("button")).toHaveText([
      "Anthropic 도움말 · Manage usage credits",
      "Anthropic 도움말 · Agent SDK with your Claude plan",
      "Claude Code 문서 · Legal and compliance",
      "TechRadar (2026-04)",
      "GIGAZINE (2026-04-05)",
      "Implicator.ai (2026-04)",
      "GitHub · claude-code #45134 (2026-04-08)",
    ])
    await more.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath("claude-billing.png") })
    const usage = page.context().waitForEvent("page")
    await more.getByTestId("claude-billing-usage").click()
    const opened = await usage
    await opened.waitForURL("https://claude.ai/settings/usage")
    await opened.close()

    // A phone: the open 자세히 does not scroll the page sideways.
    await page.setViewportSize({ width: 375, height: 800 })
    await expect.poll(() => noHorizontalScroll(page)).toBe(true)
  })

  test("AC-01 on Claude Code's own login: stale on the card; `다시 로그인` explains and moves it (mocked, 02 §8.7 CS)", async ({
    page,
  }) => {
    await mock(page, "plugin.claudeAuth.status", {
      installed: true,
      version: "0.4.0-beta.5",
      integrityOk: true,
      order: "ok",
      phase: "ready",
      acknowledged: null,
      connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@gmail.com" },
      warnings: [],
      patch: { state: "patched", sha256: "a".repeat(64), loaded: true },
      bundle: { version: "0.4.0-beta.5", integrity: "sha512-x", patchSha256: "a".repeat(64), buildId: "e2e" },
    })
    await mock(page, "plugin.claudeAuth.accounts.detect", { found: null, imported: true })
    const own = "C:\\fake\\own-open-code\\claude-accounts\\acc_01J9MOVED00000000000000000"
    const server = { moved: false }
    await mock(page, "accounts.list", () => ({
      revision: server.moved ? 996 : 995,
      accounts: [
        {
          id: "acc_claude_slot",
          kind: "claude-sub",
          label: "AC-01",
          shortLabel: "C1",
          color: "teal",
          providerID: "anthropic",
          billing: "subscription",
          status: server.moved ? "ready" : "needs_reauth",
          autoSwitch: false,
          thirdParty: true,
          readOnly: true,
          connection: { type: "oauth", method: "claude-code" },
          claude: server.moved
            ? { managed: true, default: true, folder: own, loaded: true }
            : { managed: false, default: true, folder: "C:\\fake\\.claude", loaded: true, shared: true, stale: true },
          plugin: { installed: true, acknowledged: true, version: "0.4.0-beta.5" },
        },
      ],
    }))
    const plans: unknown[] = []
    await mock(page, "plugin.claudeAuth.accounts.add.plan", (input) => {
      plans.push(input)
      return { nonce: "n_move_e2e", expiresAt: NOW + 60_000, cli: "C:\\fake\\claude.exe", folder: own, move: true }
    })
    await mock(page, "plugin.claudeAuth.accounts.add.execute", { attemptID: "cla_move_e2e" })
    await mock(page, "plugin.claudeAuth.accounts.add.status", () => {
      server.moved = true
      return { state: "added", accountID: "acc_claude_slot", label: "AC-01" }
    })
    await page.goto("/accounts")
    const slot = page.getByTestId("claude-slot-card")
    await expect(slot.getByTestId("claude-shared")).toHaveAttribute("data-stale", "true")
    // The remedy is one request in Claude Code or the own login, never waiting (CS re-review e).
    await expect(slot.getByTestId("claude-shared-stale")).toContainText(
      "AC-01은 Claude Code와 같은 로그인을 쓰는데, 그 로그인이 만료돼 멈췄어요. Claude Code에서 요청을 한 번 보내면 Claude Code가 새로 고쳐서 다시 돼요.",
    )
    await expect(slot.getByTestId("claude-shared-stale")).toContainText("Claude Code에서 /login을 하세요")
    // Not the generic `다시 로그인` notice: logging in again there would keep sharing Claude Code's login.
    await expect(slot).not.toContainText("이 계정의 로그인이 없거나 만료됐어요")
    await expect(slot.getByTestId("claude-shared-move")).toHaveText("own 전용 로그인으로 바꾸기")
    await page.screenshot({ path: test.info().outputPath("claude-shared-stale.png") })
    // `다시 로그인` from the menu says why and offers the own login.
    await slot.getByTestId("claude-menu").click()
    await page.getByRole("menuitem", { name: "다시 로그인" }).click()
    const dialog = page.getByTestId("claude-account-add-dialog")
    await expect(dialog).toContainText("own 전용 로그인으로 바꾸기: AC-01")
    await expect(dialog.getByTestId("claude-account-move-body")).toContainText(
      "AC-01은 Claude Code의 로그인(C:\\fake\\.claude)을 함께 써서 이 앱이 새로 고치지 않아요.",
    )
    await expect(dialog.getByTestId("claude-account-move-body")).toContainText("Claude Code의 로그인은 건드리지 않아요")
    await dialog.getByTestId("claude-account-add-start").click()
    await expect(dialog.getByTestId("claude-account-add-status")).toContainText("own 전용 로그인으로 바꿨어요: AC-01")
    expect(plans).toEqual([{ accountID: "acc_claude_slot" }])
    await dialog.getByTestId("dialog-close").click()
    // The card reads the moved account: its own folder, nothing shared any more.
    await page.reload()
    await expect(page.getByTestId("claude-slot-card")).toBeVisible()
    await expect(page.getByTestId("claude-slot-card").getByTestId("claude-shared")).toHaveCount(0)
    // A phone: the notice and its button fit.
    server.moved = false
    await page.reload()
    await page.setViewportSize({ width: 375, height: 800 })
    await expect(page.getByTestId("claude-shared-move")).toBeVisible()
    await expect.poll(() => noHorizontalScroll(page)).toBe(true)
  })

  // Review findings 2, 4 and 6 (CS): the card says plainly that a shared login stops; the plan, not the card, decides
  // whether `다시 로그인` moves; a move signed into another Claude account changes nothing and offers a new account.
  test("AC-01 shared: the plain note, a plan without `move` is a 다시 로그인, a mismatch offers a new account (mocked, CS)", async ({
    page,
  }) => {
    await mock(page, "plugin.claudeAuth.status", {
      installed: true,
      version: "0.4.0-beta.5",
      integrityOk: true,
      order: "ok",
      phase: "ready",
      acknowledged: null,
      connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@gmail.com" },
      warnings: [],
      patch: { state: "patched", sha256: "a".repeat(64), loaded: true },
      bundle: { version: "0.4.0-beta.5", integrity: "sha512-x", patchSha256: "a".repeat(64), buildId: "e2e" },
    })
    await mock(page, "plugin.claudeAuth.accounts.detect", { found: null, imported: true })
    await mock(page, "accounts.list", {
      revision: 997,
      accounts: [
        {
          id: "acc_claude_slot",
          kind: "claude-sub",
          label: "AC-01",
          shortLabel: "C1",
          color: "teal",
          providerID: "anthropic",
          billing: "subscription",
          status: "ready",
          autoSwitch: false,
          thirdParty: true,
          readOnly: true,
          connection: { type: "oauth", method: "claude-code" },
          claude: {
            managed: false,
            default: true,
            folder: "C:\\fake\\.claude",
            loaded: true,
            shared: true,
            stale: false,
          },
          plugin: { installed: true, acknowledged: true, version: "0.4.0-beta.5" },
        },
      ],
    })
    const server = { move: false, state: "added" }
    const plans: unknown[] = []
    await mock(page, "plugin.claudeAuth.accounts.add.plan", (input) => {
      plans.push(input)
      const folder = "C:\\fake\\own-open-code\\claude-accounts\\acc_01J9PLANNED0000000000000000"
      return {
        nonce: `n_plan_${plans.length}`,
        expiresAt: NOW + 60_000,
        cli: "C:\\fake\\claude.exe",
        folder,
        ...(server.move && input.accountID !== undefined ? { move: true } : {}),
      }
    })
    await mock(page, "plugin.claudeAuth.accounts.add.execute", { attemptID: "cla_plan_e2e" })
    await mock(page, "plugin.claudeAuth.accounts.add.status", () =>
      server.state === "mismatch"
        ? { state: "mismatch", accountID: "acc_claude_slot" }
        : { state: "added", accountID: "acc_claude_slot", label: "AC-01" },
    )
    await page.goto("/accounts")
    const slot = page.getByTestId("claude-slot-card")
    await expect(slot.getByTestId("claude-shared")).toHaveAttribute("data-stale", "false")
    await expect(slot.getByTestId("claude-shared-note")).toHaveText(
      "Claude Code가 쉬고 있으면 몇 시간마다 멈춰요 · own 전용 로그인으로 바꾸면 own이 직접 갱신해요",
    )
    // The service planned a plain 다시 로그인 (no `move`): the dialog follows the plan, not the card's `shared`.
    await slot.getByTestId("claude-shared-move").click()
    const dialog = page.getByTestId("claude-account-add-dialog")
    await expect(dialog).toContainText("다시 로그인: AC-01")
    await expect(dialog.getByTestId("claude-account-move-body")).toHaveCount(0)
    await dialog.getByTestId("claude-account-add-start").click()
    await expect(dialog.getByTestId("claude-account-add-status")).toContainText("다시 로그인했어요: AC-01")
    await dialog.getByTestId("dialog-close").click()
    // A move whose login is another Claude account: nothing changes, and adding it as a new account is offered.
    server.move = true
    server.state = "mismatch"
    await slot.getByTestId("claude-shared-move").click()
    await expect(dialog).toContainText("own 전용 로그인으로 바꾸기: AC-01")
    await dialog.getByTestId("claude-account-add-start").click()
    await expect(dialog.getByTestId("claude-account-add-status")).toContainText(
      "다른 Claude 계정으로 로그인했어요 · 같은 계정으로 다시 로그인하거나 계정을 새로 추가하세요",
    )
    await page.screenshot({ path: test.info().outputPath("claude-shared-mismatch.png") })
    await dialog.getByTestId("claude-account-add-new").click()
    await expect(dialog).toContainText("Claude 계정 추가")
    await expect(dialog.getByTestId("claude-account-add-new")).toHaveCount(0)
    await expect(dialog.getByTestId("claude-account-add-start")).toBeEnabled()
    expect(plans).toEqual([{ accountID: "acc_claude_slot" }, { accountID: "acc_claude_slot" }, {}])
  })

  // CS re-review (f): any account own marks read only (a junction, a link, the account source's folder) shows the
  // same note, stale text and move as account 1, not the generic `다시 로그인` notice.
  test("an added account on a login Claude Code uses: the stale text and the move, like account 1 (mocked, CS)", async ({
    page,
  }) => {
    await mock(page, "plugin.claudeAuth.status", {
      installed: true,
      version: "0.4.0-beta.5",
      integrityOk: true,
      order: "ok",
      phase: "ready",
      acknowledged: null,
      connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@gmail.com" },
      warnings: [],
      patch: { state: "patched", sha256: "a".repeat(64), loaded: true },
      bundle: { version: "0.4.0-beta.5", integrity: "sha512-x", patchSha256: "a".repeat(64), buildId: "e2e" },
    })
    await mock(page, "plugin.claudeAuth.accounts.detect", { found: null, imported: true })
    const card = (id: string, label: string, claude: Record<string, unknown>, status: string) => ({
      id,
      kind: "claude-sub",
      label,
      shortLabel: label.slice(-2),
      color: "teal",
      providerID: "anthropic",
      billing: "subscription",
      status,
      autoSwitch: false,
      thirdParty: true,
      readOnly: true,
      connection: { type: "oauth", method: "claude-code" },
      claude,
      plugin: { installed: true, acknowledged: true, version: "0.4.0-beta.5" },
    })
    await mock(page, "accounts.list", {
      revision: 998,
      accounts: [
        card(
          "acc_claude_slot",
          "AC-01",
          { managed: true, default: true, folder: "C:\\fake\\own\\acc_1", loaded: true },
          "ready",
        ),
        card(
          "acc_01J9CLAUDELINKED0000000000",
          "AC-02",
          { managed: true, default: false, folder: "C:\\fake\\own\\acc_2", loaded: true, shared: true, stale: true },
          "needs_reauth",
        ),
      ],
    })
    const plans: unknown[] = []
    await mock(page, "plugin.claudeAuth.accounts.add.plan", (input) => {
      plans.push(input)
      return {
        nonce: "n_linked",
        expiresAt: NOW + 60_000,
        cli: "C:\\fake\\claude.exe",
        folder: "C:\\fake\\x",
        move: true,
      }
    })
    await page.goto("/accounts")
    const added = page.locator('[data-account-id="acc_01J9CLAUDELINKED0000000000"]')
    await expect(added.getByTestId("claude-shared")).toHaveAttribute("data-stale", "true")
    await expect(added.getByTestId("claude-shared-stale")).toContainText(
      "AC-02는 Claude Code와 같은 로그인을 쓰는데, 그 로그인이 만료돼 멈췄어요. Claude Code에서 요청을 한 번 보내면",
    )
    await expect(added).not.toContainText("이 계정의 로그인이 없거나 만료됐어요")
    await expect(page.getByTestId("claude-slot-card").getByTestId("claude-shared")).toHaveCount(0)
    await added.getByTestId("claude-shared-move").click()
    await expect(page.getByTestId("claude-account-add-dialog")).toContainText("own 전용 로그인으로 바꾸기: AC-02")
    expect(plans).toEqual([{ accountID: "acc_01J9CLAUDELINKED0000000000" }])
  })

  test("ChatGPT device login: code, status on return to the window, name, complete (mocked, 5.4)", async ({ page }) => {
    let phase = "pending"
    await mock(page, "accounts.add.chatgpt.start", {
      attemptID: "att_e2e",
      method: "device",
      verificationURL: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: NOW + 600_000,
    })
    await mock(page, "accounts.add.chatgpt.status", () => ({
      phase,
      identity: phase === "authorized" ? { emailMasked: "pe***@gmail.com", plan: "pro" } : undefined,
    }))
    await mock(page, "accounts.add.chatgpt.complete", (input) => ({
      account: {
        id: "acc_gpt_e2e",
        kind: "codex",
        label: input.label,
        shortLabel: "C",
        color: input.color,
        providerID: "own-codex-gpt1",
        billing: "subscription",
        status: "ready",
        autoSwitch: false,
        thirdParty: false,
        readOnly: false,
        connection: { type: "oauth", method: "chatgpt-device" },
      },
      reauthenticated: false,
    }))
    await mock(page, "accounts.add.chatgpt.cancel", {})
    await page.goto("/accounts/add")
    await page.getByTestId("add-account-dialog").locator('[data-choice="codex"]').click()
    const login = page.getByTestId("chatgpt-login")
    await expect(login).toContainText("코드로 로그인")
    await login.getByTestId("chatgpt-start").click()
    await expect(login.getByTestId("chatgpt-code")).toHaveText("ABCD-EFGH")
    phase = "authorized"
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(login.getByTestId("chatgpt-authorized")).toContainText("pe***@gmail.com · Pro 확인됨")
    await login.getByTestId("chatgpt-complete").click()
    await expect(page.getByTestId("add-done")).toContainText("계정이 추가되었어요")
  })

  test("Sign in with ChatGPT: third method, consent retry, the connected notice once (mocked, 5.4)", async ({
    page,
  }) => {
    // Two loads of the accounts page from Vite dev (hundreds of modules in a fresh context), three popups and a dozen
    // waits: about 30 s on an idle PC, past the default 60 s cap on a loaded one (MR13).
    test.setTimeout(150_000)
    await standInForOpenAI(page)
    const starts: Record<string, unknown>[] = []
    let status: object = { phase: "pending" }
    await mock(page, "accounts.add.chatgpt.start", (input) => {
      starts.push(input)
      status = { phase: "pending" }
      return {
        attemptID: `att_siwc_${starts.length}`,
        method: "siwc",
        authorizeURL: `https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=e2e${starts.length}`,
        expiresAt: NOW + 600_000,
      }
    })
    await mock(page, "accounts.add.chatgpt.status", () => status)
    await mock(page, "accounts.add.chatgpt.complete", (input) => ({
      account: {
        id: "acc_siwc_e2e",
        kind: "siwc",
        label: input.label,
        shortLabel: "S",
        color: input.color,
        providerID: "own-siwc-e2e1",
        billing: "subscription",
        status: "ready",
        autoSwitch: false,
        thirdParty: false,
        readOnly: false,
        connection: { type: "oauth", method: "chatgpt-siwc" },
      },
      reauthenticated: false,
    }))
    await mock(page, "accounts.add.chatgpt.cancel", {})
    const authorized = { phase: "authorized", identity: { emailMasked: "pe***@gmail.com", plan: "plus" } }
    const returnToWindow = () => page.evaluate(() => window.dispatchEvent(new Event("focus")))

    await page.goto("/accounts/add")
    await page.getByTestId("add-account-dialog").locator('[data-choice="codex"]').click()
    const login = page.getByTestId("chatgpt-login")
    await expect(login).toContainText("OpenAI 공식 연동 · ChatGPT 요금제 사용량으로 동작해요")
    await login.getByTestId("chatgpt-method-siwc").check()
    await page.screenshot({ path: test.info().outputPath("siwc-methods.png") })
    const authorize = page.context().waitForEvent("page")
    await login.getByTestId("chatgpt-start").click()
    await (await authorize).waitForURL(/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/)
    await expect(login.getByTestId("chatgpt-browser")).toContainText("이 앱의 요금제 사용을 허용하세요")

    // The sharing scope was not granted: a specific notice, and consent is asked only on this explicit retry, which
    // names the failed attempt so the router reuses the client ChatGPT issued to it.
    status = { phase: "failed", error: "token_sharing_not_granted" }
    await returnToWindow()
    await expect(login.getByTestId("chatgpt-error")).toContainText("ChatGPT 요금제 사용이 허용되지 않았어요")
    const again = page.context().waitForEvent("page")
    await login.getByTestId("chatgpt-consent").click()
    await again
    expect(starts).toEqual([{ method: "siwc" }, { method: "siwc", consent: true, retryOf: "att_siwc_1" }])

    status = authorized
    await returnToWindow()
    await expect(login.getByTestId("chatgpt-authorized")).toContainText("pe***@gmail.com · Plus 확인됨")
    await login.getByTestId("chatgpt-complete").click()
    const welcome = page.getByTestId("chatgpt-welcome")
    await expect(welcome).toContainText("ChatGPT 요금제로 연결됨")
    const usage = page.context().waitForEvent("page")
    await welcome.getByTestId("chatgpt-usage").click()
    await (await usage).waitForURL("https://chatgpt.com/settings/usage")
    await page.screenshot({ path: test.info().outputPath("siwc-welcome.png") })

    // A second Sign in with ChatGPT account in this browser: no welcome again. Closing navigates to the accounts page
    // on its own, and a page.goto racing it was aborted (net::ERR_ABORTED, MR13): open the dialog in the page instead,
    // which also spares a second cold load from Vite dev.
    await page.getByTestId("add-close").click()
    await expect(page).toHaveURL(/\/accounts$/)
    await page.getByTestId("open-add-account").click()
    await page.getByTestId("add-account-dialog").locator('[data-choice="codex"]').click()
    await login.getByTestId("chatgpt-method-siwc").check()
    const second = page.context().waitForEvent("page")
    await login.getByTestId("chatgpt-start").click()
    await second
    status = authorized
    await returnToWindow()
    await login.getByTestId("chatgpt-complete").click()
    await expect(page.getByTestId("add-done")).toContainText("계정이 추가되었어요")
    await expect(page.getByTestId("chatgpt-welcome")).toHaveCount(0)
  })

  test("Sign in with ChatGPT account: plan line, re-login keeps its method, removal notes revocation (mocked, 5.4)", async ({
    page,
  }) => {
    await standInForOpenAI(page)
    await mock(page, "accounts.list", {
      revision: 997,
      accounts: [
        {
          id: "acc_siwc",
          kind: "siwc",
          label: "ChatGPT Plus",
          shortLabel: "S",
          color: "green",
          providerID: "own-siwc-pln1",
          billing: "subscription",
          status: "ready",
          autoSwitch: false,
          thirdParty: false,
          readOnly: false,
          identity: { emailMasked: "pe***@gmail.com", plan: "plus" },
          connection: { type: "oauth", method: "chatgpt-siwc" },
        },
      ],
    })
    await mock(page, "accounts.remove.plan", {
      nonce: "n_siwc_e2e",
      expiresAt: NOW + 60_000,
      affectedSessions: [],
      willShredVault: true,
    })
    await page.goto("/accounts")
    await expect(page.locator('[data-testid=provider-section][data-kind="siwc"]')).toContainText("Sign in with ChatGPT")
    const card = page.locator('[data-testid=account-card][data-account-id="acc_siwc"]')
    await expect(card.getByTestId("chatgpt-plan")).toContainText("ChatGPT 요금제 사용 · 사용량 관리")
    await page.screenshot({ path: test.info().outputPath("siwc-card.png") })
    const usage = page.context().waitForEvent("page")
    await card.getByTestId("chatgpt-usage").click()
    await (await usage).waitForURL("https://chatgpt.com/settings/usage")

    await card.getByTestId("account-menu").click()
    await page.getByRole("menuitem", { name: "다시 로그인" }).click()
    const login = page.getByTestId("chatgpt-login")
    await expect(login.getByTestId("chatgpt-method-siwc")).toBeChecked()
    await expect(login.getByTestId("chatgpt-method-device")).toHaveCount(0)
    await expect(login.getByTestId("chatgpt-method-browser")).toHaveCount(0)
    await login.getByRole("button", { name: "취소" }).click()

    await card.getByTestId("account-menu").click()
    await page.getByTestId("menu-remove").click()
    await expect(page.getByTestId("remove-siwc-revoke")).toContainText("토큰을 무효로 해 달라고 요청해요")
  })

  test("Sign in with ChatGPT without limits: the 계정·한도 row, the card and the dashboard say so; a 429's own reset is a bar (mocked, 02 §7.1)", async ({
    page,
  }) => {
    const siwc = {
      id: "acc_siwc_lim",
      kind: "siwc",
      label: "ChatGPT Pro",
      shortLabel: "P",
      color: "green",
      providerID: "own-siwc-lim1",
      billing: "subscription",
      status: "ready",
      autoSwitch: false,
      thirdParty: false,
      readOnly: false,
      identity: { emailMasked: "pe***@gmail.com", plan: "pro" },
      connection: { type: "oauth", method: "chatgpt-siwc" },
    }
    await mock(page, "accounts.list", { revision: 996, accounts: [siwc] })
    const quota: { windows: object[] } = { windows: [] }
    await mock(page, "quota.snapshot", () => ({ windows: quota.windows, exhausted: [] }))
    const unreported = "아직 받은 한도 정보가 없어요 · 이 로그인 방식(토큰 공유)은 한도를 알려 주지 않는 것으로 보여요"

    await page.goto(`/srv/local/s/${first!.id}`)
    const row = page.getByTestId("tab-accounts").locator(`[data-testid=account-row][data-account-id="${siwc.id}"]`)
    await expect(row.getByTestId("limit-empty")).toContainText(unreported)
    await expect(row.getByTestId("limit-empty")).toContainText("ChatGPT 설정 > 사용량에서 확인하세요")
    await expect(row).not.toContainText("관측된 한도 없음")
    await page.screenshot({ path: test.info().outputPath("siwc-panel-empty.png") })
    await page.goto("/accounts")
    await expect(
      page.locator(`[data-testid=account-card][data-account-id="${siwc.id}"]`).getByTestId("limit-empty"),
    ).toContainText(unreported)
    await page.goto("/limits")
    await expect(
      page.locator(`[data-testid=limits-card][data-account-id="${siwc.id}"]`).getByTestId("limit-empty"),
    ).toContainText(unreported)

    // A usage limit whose 429 named its reset: the router's `siwc.usage` window, full, with that reset.
    quota.windows = [
      {
        id: "siwc.usage",
        accountID: siwc.id,
        providerID: siwc.providerID,
        scope: "account",
        kind: "rolling_quota",
        label: "사용량 한도",
        usedPercent: 100,
        resetAt: NOW + 90 * 60_000,
        status: "exhausted",
        confidence: "live",
        source: "error",
        observedAt: NOW - 30_000,
      },
    ]
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(row.getByTestId("limit-empty")).toHaveCount(0)
    await expect(row.getByTestId("limit-summary-line").locator('[data-window="siwc.usage"]')).toHaveText(
      "사용량 한도 남음 0%",
    )
    await row.getByTestId("limit-summary-toggle").click()
    const bar = row.locator('.own-mrow[data-window="siwc.usage"]')
    await expect(bar).toContainText("남음 0%")
    await expect(bar).toContainText(/1시간 \d+분 후 리셋/)
    await expect(bar.getByRole("meter")).toHaveAttribute("data-tone", "danger")
    await page.screenshot({ path: test.info().outputPath("siwc-panel-limit.png") })
  })
})

/** Authorize and usage pages open as popups; they get a local stand-in so no test ever reaches OpenAI. */
async function standInForOpenAI(page: Page) {
  await page
    .context()
    .route(/^https:\/\/(auth\.openai\.com|chatgpt\.com)\//, (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>stand-in</title>" }),
    )
}

test.describe("리셋권 (7.1.1, 02 §7.1.1)", () => {
  const DAY = 86_400_000
  /** The e2e account as a ChatGPT subscription (`codex`): same id and provider, so the sessions stay bound to it. */
  async function asCodex(page: Page) {
    await page.route(/\/api\/rpc\/own\.accounts\/accounts\.list(\?|$)/, async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as { output: { accounts: Record<string, unknown>[] } }
      const accounts = body.output.accounts.map((account) =>
        account.id === state.account.id
          ? { ...account, kind: "codex", billing: "subscription", label: "ChatGPT Pro", identity: { plan: "pro" } }
          : account,
      )
      await route.fulfill({ response, json: { ...body, output: { ...body.output, accounts } } })
    })
  }
  const creditsOf = (patch: Record<string, unknown> = {}) => ({
    accountID: state.account.id,
    providerID: state.account.providerID,
    availableCount: 2,
    applicableCount: 0,
    credits: [
      {
        id: "credit-forever",
        type: "codex_rate_limits",
        status: "available",
        grantedAt: NOW - 3 * DAY,
        title: "Full reset (Weekly + 5 hr)",
        description: "Ready to redeem",
      },
      {
        id: "credit-soon",
        type: "codex_rate_limits",
        status: "available",
        grantedAt: NOW - DAY,
        expiresAt: NOW + 8 * DAY,
      },
    ],
    observedAt: NOW - 60_000,
    source: "poll",
    ...patch,
  })
  const planWindows = (primary: number) => [
    windowOf({
      id: "codex.primary",
      label: "5시간",
      windowMinutes: 300,
      usedPercent: primary,
      status: primary >= 100 ? "exhausted" : "ok",
      resetAt: NOW + 90 * 60_000,
    }),
    windowOf({ id: "codex.secondary", label: "주간", windowMinutes: 10_080, usedPercent: 40, resetAt: NOW + 3 * DAY }),
  ]
  /** A declared RPC error as the server sends it (HTTP 400 `RpcError`). */
  async function rpcError(page: Page, method: string, answer: () => { type: string; data: object } | undefined) {
    const escaped = method.replaceAll(".", "\\.")
    await page.route(new RegExp(`/api/rpc/own\\.accounts/${escaped}(\\?|$)`), async (route) => {
      const error = answer()
      if (!error) return route.fallback()
      return route.fulfill({ status: 400, json: { _tag: "RpcError", message: error.type, ...error } })
    })
  }

  test("the count on the card, the dashboard, the switcher row and the banner; the dialog asks with 취소 focused and redeems once (mocked)", async ({
    page,
  }) => {
    await asCodex(page)
    const quota = { windows: planWindows(100), resetCredits: [creditsOf()] }
    await mock(page, "quota.snapshot", () => ({ ...quota, exhausted: [] }))
    const lists: Record<string, unknown>[] = []
    await mock(page, "quota.resetCredits.list", (input) => {
      lists.push(input)
      return { resetCredits: quota.resetCredits[0] }
    })
    const plans: Record<string, unknown>[] = []
    await mock(page, "quota.resetCredits.redeem.plan", (input) => {
      plans.push(input)
      const picked = (quota.resetCredits[0]!.credits as { id: string; title?: string; expiresAt?: number }[]).find(
        (credit) => credit.id === input.creditID,
      )
      return {
        nonce: "n_rc_e2e",
        expiresAt: NOW + 10 * 60_000,
        account: { id: state.account.id, label: "ChatGPT Pro" },
        ...(picked ? { credit: picked } : {}),
        windows: quota.windows,
      }
    })
    const executes: Record<string, unknown>[] = []
    await mock(page, "quota.resetCredits.redeem.execute", (input) => {
      executes.push(input)
      quota.resetCredits = [creditsOf({ availableCount: 1, credits: [creditsOf().credits[0]], observedAt: Date.now() })]
      quota.windows = planWindows(0)
      return { outcome: "reset", windowsReset: 2, resetCredits: quota.resetCredits[0], windows: quota.windows }
    })
    // Registered last, so it answers first: ChatGPT does not answer the first attempt.
    const failOnce = { left: 1 }
    await rpcError(page, "quota.resetCredits.redeem.execute", () => {
      if (failOnce.left === 0) return undefined
      executes.push({ failed: true })
      failOnce.left -= 1
      return { type: "limit_reset_failed", data: { reason: "timeout", retryable: true } }
    })

    // The conversation's account is out of its 5 hours and holds credits: the banner offers one.
    await page.goto(`/srv/local/s/${first!.id}`)
    const banner = page.getByTestId("limit-reached-banner")
    await expect(banner).toHaveAttribute("data-kind", "codex")
    await expect(banner).toContainText("ChatGPT Pro의 한도에 도달했어요")
    await expect(banner.getByTestId("limit-reached-credits")).toHaveText(
      "이 계정에 리셋권이 2개 있어요. 쓰면 지금 한도가 다시 차요.",
    )
    await expect(banner.getByTestId("limit-reached-use")).toHaveText("리셋권 쓰기")
    await page.screenshot({ path: test.info().outputPath("reset-credits-banner.png") })
    // The switcher row names the count after its limits line, and holds no button.
    await page.locator("#own-composer-input").focus()
    await page.keyboard.press("Control+Period")
    const option = page
      .getByTestId("switcher")
      .locator(`[data-testid=switcher-account][data-account-id="${state.account.id}"]`)
    await expect(option.getByTestId("switcher-reset-credits")).toHaveText("리셋권 2개")
    await expect(option.getByRole("button")).toHaveCount(0)
    await page.keyboard.press("Escape")

    // The card: the count, the soonest expiry, the age; the dashboard card the same.
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${state.account.id}"]`)
    const line = card.getByTestId("reset-credits")
    await expect(line.getByTestId("reset-credits-count")).toHaveText("리셋권 2개")
    await expect(line.getByTestId("reset-credits-expiry")).toHaveText(
      /^· \d{1,2}월 \d{1,2}일 (오전|오후) \d{1,2}:\d\d까지$/,
    )
    await expect(line).toContainText(/· (1분 전|방금) 확인/)
    await page.goto("/limits")
    const dashboard = page.locator(`[data-testid=limits-card][data-account-id="${state.account.id}"]`)
    await expect(dashboard.getByTestId("reset-credits-count")).toHaveText("리셋권 2개")
    await page.goto("/accounts")

    // Open, pick the credit that expires first, and cancel: 취소 has the focus, nothing is redeemed.
    await line.getByTestId("reset-credits-use").click()
    const dialog = page.getByTestId("reset-credit-dialog")
    await expect(dialog.getByRole("heading")).toHaveText("리셋권 쓰기 · ChatGPT Pro")
    const choices = dialog.getByTestId("reset-credit-option")
    await expect(choices).toHaveCount(2)
    await expect(choices.nth(0)).toHaveAttribute("data-credit-id", "credit-soon")
    await expect(choices.nth(0)).toContainText("전체 리셋")
    await expect(choices.nth(0)).toContainText("지금 사용 한도를 리셋해요")
    await expect(choices.nth(0).getByTestId("reset-credit-option-expiry")).toHaveText(
      /^\d{1,2}월 \d{1,2}일 (오전|오후) \d{1,2}:\d\d까지$/,
    )
    await expect(choices.nth(1)).toContainText("Full reset (Weekly + 5 hr)")
    await expect(choices.nth(1).getByTestId("reset-credit-option-expiry")).toHaveText("기한 없음")
    // Each choice holds its three lines (title, note, expiry) inside its own box.
    for (const index of [0, 1]) {
      const outer = await choices.nth(index).boundingBox()
      const expiry = await choices.nth(index).getByTestId("reset-credit-option-expiry").boundingBox()
      expect(expiry && outer && expiry.y + expiry.height <= outer.y + outer.height).toBe(true)
    }
    await choices.nth(0).click()
    await expect(dialog.getByTestId("reset-credit-question")).toHaveText("이 리셋권을 쓸까요?")
    const facts = dialog.getByTestId("reset-credit-facts")
    await expect(facts).toContainText("ChatGPT Pro")
    await expect(facts).toContainText("전체 리셋")
    await expect(facts.getByTestId("reset-credit-windows")).toContainText("5시간 남음 0%")
    await expect(dialog.getByTestId("reset-credit-irreversible")).toHaveText("쓰면 되돌릴 수 없어요.")
    // A window is used up, so no "아직 한도에 닿지 않았어요".
    await expect(dialog.getByTestId("reset-credit-below-limit")).toHaveCount(0)
    await expect(dialog.getByTestId("reset-credit-cancel")).toBeFocused()
    await page.screenshot({ path: test.info().outputPath("reset-credits-confirm.png") })
    // Enter on the focused 취소 closes; nothing was redeemed.
    await page.keyboard.press("Enter")
    await expect(dialog).toHaveCount(0)
    expect(executes).toEqual([])
    expect(plans).toEqual([{ accountID: state.account.id, creditID: "credit-soon" }])

    // Again, and use it: no answer first (the retry sends the same plan's nonce), then the reset.
    await line.getByTestId("reset-credits-use").click()
    await dialog.getByTestId("reset-credit-option").nth(0).click()
    await dialog.getByTestId("reset-credit-confirm").click()
    await expect(dialog.getByTestId("reset-credit-failed")).toContainText("리셋하지 못했어요")
    await expect(dialog.getByTestId("reset-credit-failed")).toContainText("같은 요청이라 리셋권이 두 번 쓰이지 않아요")
    await expect(dialog.getByTestId("reset-credit-retry")).toHaveText("다시 시도")
    await expect(dialog.getByTestId("reset-credit-close")).toHaveText("닫기")
    await dialog.getByTestId("reset-credit-retry").click()
    await expect(dialog.getByTestId("reset-credit-result")).toHaveText("한도를 리셋했어요 · 리셋권 1개 남았어요")
    expect(executes).toEqual([{ failed: true }, { nonce: "n_rc_e2e" }])
    expect(plans).toHaveLength(2)
    await dialog.getByTestId("reset-credit-close").click()
    await expect(line.getByTestId("reset-credits-count")).toHaveText("리셋권 1개")
    expect(lists.length).toBeGreaterThanOrEqual(2)
  })

  test("using the last credit keeps the result on screen in the banner and on a folded card; the limits refill at once (mocked)", async ({
    page,
  }) => {
    await asCodex(page)
    const last = () => creditsOf({ availableCount: 1, credits: [creditsOf().credits[1]] })
    const quota = { windows: planWindows(100), resetCredits: [last()] }
    await mock(page, "quota.snapshot", () => ({ ...quota, exhausted: [] }))
    await mock(page, "quota.resetCredits.list", () => ({ resetCredits: quota.resetCredits[0] }))
    await mock(page, "quota.resetCredits.redeem.plan", () => ({
      nonce: "n_rc_last",
      expiresAt: NOW + 10 * 60_000,
      account: { id: state.account.id, label: "ChatGPT Pro" },
      windows: quota.windows,
    }))
    const executes: Record<string, unknown>[] = []
    await mock(page, "quota.resetCredits.redeem.execute", (input) => {
      executes.push(input)
      // No quota.updated follows in this mock: whatever the screen shows next comes from this answer.
      const used = creditsOf({ availableCount: 0, credits: [], observedAt: Date.now() })
      return { outcome: "reset", windowsReset: 2, resetCredits: used, windows: planWindows(0) }
    })
    const redeem = async () => {
      const dialog = page.getByTestId("reset-credit-dialog")
      await dialog.getByTestId("reset-credit-option").click()
      await dialog.getByTestId("reset-credit-confirm").click()
      await expect(dialog.getByTestId("reset-credit-result")).toHaveText("한도를 리셋했어요 · 리셋권 0개 남았어요")
      return dialog
    }

    // The banner: the redeem refills its window and uses its last credit, yet it stays until the dialog closes.
    await page.goto(`/srv/local/s/${first!.id}`)
    const banner = page.getByTestId("limit-reached-banner")
    await banner.getByTestId("limit-reached-use").click()
    const dialog = await redeem()
    await expect(banner).toHaveCount(1)
    // Held open by its dialog with no credit left: no count and no second 리셋권 쓰기 behind it.
    await expect(banner.getByTestId("limit-reached-credits")).toHaveCount(0)
    await expect(banner.getByTestId("limit-reached-use")).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath("reset-credits-banner-result.png") })
    await dialog.getByTestId("reset-credit-close").click()
    await expect(dialog).toHaveCount(0)
    await expect(banner).toHaveCount(0)

    // A folded card: at 0 its line hides, the dialog with the result does not, and the limits read 100% left at once.
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${state.account.id}"]`)
    await expect(card.getByTestId("reset-credits-count")).toHaveText("리셋권 1개")
    await expect(card.getByTestId("limit-summary-toggle")).toContainText("5시간 남음 0%")
    await card.getByTestId("reset-credits-use").click()
    await redeem()
    await expect(card.getByTestId("reset-credits")).toHaveCount(0)
    await expect(card.getByTestId("limit-summary-toggle")).toContainText("5시간 남음 100%")
    await dialog.getByTestId("reset-credit-close").click()
    await expect(dialog).toHaveCount(0)
    expect(executes).toEqual([{ nonce: "n_rc_last" }, { nonce: "n_rc_last" }])
  })

  test("each answer's words, the extra question below the limit, 리셋권 없음 and 리셋권 확인 unfolded (mocked)", async ({
    page,
  }) => {
    await asCodex(page)
    const quota: { windows: object[]; resetCredits: object[] } = { windows: planWindows(30), resetCredits: [] }
    await mock(page, "quota.snapshot", () => ({ ...quota, exhausted: [] }))
    const listed = { value: creditsOf({ credits: undefined }) as Record<string, unknown> }
    await mock(page, "quota.resetCredits.list", () => ({ resetCredits: listed.value }))
    await mock(page, "quota.resetCredits.redeem.plan", (input) => ({
      nonce: `n_${String(input.creditID ?? "any")}`,
      expiresAt: NOW + 10 * 60_000,
      account: { id: state.account.id, label: "ChatGPT Pro" },
      windows: quota.windows,
    }))
    const outcomes = ["nothing_to_reset", "no_credit", "already_redeemed"]
    await mock(page, "quota.resetCredits.redeem.execute", () => {
      const outcome = outcomes.shift()
      return outcome === "already_redeemed"
        ? { outcome, windowsReset: 0, resetCredits: creditsOf({ availableCount: 0, credits: undefined }) }
        : { outcome }
    })

    // No count known yet: nothing folded; unfolded, `리셋권 확인` asks.
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${state.account.id}"]`)
    await expect(card.getByTestId("reset-credits")).toHaveCount(0)
    await card.getByTestId("limit-summary-toggle").click()
    await expect(card.getByTestId("reset-credits-check")).toHaveText("리셋권 확인")
    await card.getByTestId("reset-credits-check").click()
    await expect(card.getByTestId("reset-credits-count")).toHaveText("리셋권 2개")
    // Without the list's details there is no expiry, and the dialog offers one choice that lets ChatGPT pick: which
    // credit it takes, and so its expiry, is not known (not `기한 없음`).
    await expect(card.getByTestId("reset-credits-expiry")).toHaveCount(0)
    const dialog = page.getByTestId("reset-credit-dialog")
    const run = async () => {
      await card.getByTestId("reset-credits-use").click()
      await expect(dialog.getByTestId("reset-credit-option")).toHaveCount(1)
      await expect(dialog.getByTestId("reset-credit-option")).toContainText("전체 리셋")
      await expect(dialog.getByTestId("reset-credit-option-expiry")).toHaveText("기한 모름")
      await dialog.getByTestId("reset-credit-option").click()
      await expect(dialog.getByTestId("reset-credit-expiry")).toHaveText("기한 모름")
      // Every window below its limit: asked once more.
      await expect(dialog.getByTestId("reset-credit-below-limit")).toHaveText(
        "아직 한도에 닿지 않았어요. 그래도 쓸까요?",
      )
      await dialog.getByTestId("reset-credit-confirm").click()
      return dialog.getByTestId("reset-credit-result")
    }
    await expect(await run()).toHaveText("지금은 리셋할 한도가 없어요 · 리셋권은 그대로예요")
    await dialog.getByTestId("reset-credit-close").click()
    await expect(await run()).toHaveText("쓸 수 있는 리셋권이 없어요")
    await dialog.getByTestId("reset-credit-close").click()
    await expect(await run()).toHaveText("한도를 리셋했어요 · 리셋권 0개 남았어요")
    await dialog.getByTestId("reset-credit-close").click()
    // Zero: folded nothing, unfolded `리셋권 없음`.
    await expect(card.getByTestId("reset-credits-count")).toHaveText("리셋권 없음")
    await card.getByTestId("limit-summary-toggle").click()
    await expect(card.getByTestId("reset-credits")).toHaveCount(0)

    // A picked credit that is gone asks for a refresh, which lists again.
    quota.resetCredits = [creditsOf()]
    listed.value = creditsOf()
    outcomes.push("no_credit")
    await page.reload()
    await card.getByTestId("reset-credits-use").click()
    await dialog.getByTestId("reset-credit-option").nth(0).click()
    await dialog.getByTestId("reset-credit-confirm").click()
    await expect(dialog.getByTestId("reset-credit-result")).toHaveText(
      "그 리셋권은 더 이상 쓸 수 없어요 · 새로 고쳐 주세요",
    )
    await dialog.getByTestId("reset-credit-again").click()
    await expect(dialog.getByTestId("reset-credit-option")).toHaveCount(2)
    await page.screenshot({ path: test.info().outputPath("reset-credits-refresh.png") })
  })

  test("an unknown result asks to check again; a login not usable says why; a 401 says to sign in again; no count read after a reset is no count (mocked)", async ({
    page,
  }) => {
    await asCodex(page)
    const quota = { windows: planWindows(100), resetCredits: [creditsOf()] }
    await mock(page, "quota.snapshot", () => ({ ...quota, exhausted: [] }))
    const lists: Record<string, unknown>[] = []
    await mock(page, "quota.resetCredits.list", (input) => {
      lists.push(input)
      return { resetCredits: quota.resetCredits[0] }
    })
    const plans: Array<{ type: string; data: object } | undefined> = [
      undefined,
      undefined,
      undefined,
      { type: "credential_not_ready", data: { accountID: state.account.id, cause: "needs_reauth" } },
    ]
    await mock(page, "quota.resetCredits.redeem.plan", () => ({
      nonce: "n_rc_unknown",
      expiresAt: NOW + 10 * 60_000,
      account: { id: state.account.id, label: "ChatGPT Pro" },
      windows: quota.windows,
    }))
    await rpcError(page, "quota.resetCredits.redeem.plan", () => plans.shift())
    const executes: string[] = []
    const answers: Array<(route: Route) => Promise<void>> = [
      // The account was removed by another window meanwhile.
      (route) =>
        route.fulfill({
          status: 400,
          json: {
            _tag: "RpcError",
            message: "account_not_found",
            type: "account_not_found",
            data: { accountID: state.account.id },
          },
        }),
      // The connection to the service drops while the redeem is on its way.
      (route) => route.abort("connectionreset"),
      // ChatGPT refuses the login.
      (route) =>
        route.fulfill({
          status: 400,
          json: {
            _tag: "RpcError",
            message: "limit_reset_failed",
            type: "limit_reset_failed",
            data: { reason: "status", status: 401, retryable: true },
          },
        }),
      // Redeemed, and the read after it reported no count.
      (route) => route.fulfill({ json: { output: { outcome: "reset", windowsReset: 2, windows: planWindows(0) } } }),
    ]
    await page.route(/\/api\/rpc\/own\.accounts\/quota\.resetCredits\.redeem\.execute(\?|$)/, async (route) => {
      executes.push(route.request().method())
      const answer = answers.shift()
      return answer ? answer(route) : route.abort()
    })

    await page.goto("/accounts")
    const card = page.locator(`[data-testid=account-card][data-account-id="${state.account.id}"]`)
    const dialog = page.getByTestId("reset-credit-dialog")
    const redeem = async () => {
      await dialog.getByTestId("reset-credit-option").nth(0).click()
      await dialog.getByTestId("reset-credit-confirm").click()
    }
    await expect(card.getByTestId("reset-credits-count")).toHaveText("리셋권 2개")
    await card.getByTestId("reset-credits-use").click()

    // The account removed before the redeem went out: the service sent nothing, and the dialog says so.
    await redeem()
    await expect(dialog.getByTestId("reset-credit-result")).toHaveText(
      "계정이 지워져서 보내지 않았어요 · 리셋권은 쓰이지 않았어요",
    )
    await expect(dialog.getByTestId("reset-credit-again")).toHaveCount(0)
    await dialog.getByTestId("reset-credit-close").click()
    await card.getByTestId("reset-credits-use").click()

    // A lost answer does not say whether the credit went: check again, which lists anew.
    await redeem()
    await expect(dialog.getByTestId("reset-credit-result")).toHaveText("리셋 결과를 알 수 없어요 · 다시 확인해 주세요")
    await expect(dialog.getByTestId("reset-credit-again")).toHaveText("다시 확인")
    const before = lists.length
    await dialog.getByTestId("reset-credit-again").click()
    await expect(dialog.getByTestId("reset-credit-option")).toHaveCount(2)
    expect(lists.length).toBe(before + 1)

    // ChatGPT refused the login: sign in again, and no 다시 시도 that would be refused the same way.
    await redeem()
    await expect(dialog.getByTestId("reset-credit-failed")).toContainText(
      "ChatGPT가 이 계정의 로그인을 받지 않았어요(HTTP 401). 다시 로그인한 뒤 처음부터 해 주세요.",
    )
    await expect(dialog.getByTestId("reset-credit-retry")).toHaveCount(0)
    await dialog.getByTestId("reset-credit-close").click()

    // The login must be signed in again: the words say so, not that it is about to expire.
    await card.getByTestId("reset-credits-use").click()
    await dialog.getByTestId("reset-credit-option").nth(0).click()
    await expect(dialog.getByTestId("reset-credit-result")).toHaveText(
      "이 계정은 다시 로그인해야 해요. 계정 카드에서 다시 로그인한 뒤 해 주세요.",
    )
    await dialog.getByTestId("reset-credit-close").click()

    // Redeemed with no count read after it: the 2 from before is not shown as left; unfolded, 리셋권 확인 asks.
    await card.getByTestId("reset-credits-use").click()
    await redeem()
    await expect(dialog.getByTestId("reset-credit-result")).toHaveText("한도를 리셋했어요")
    await dialog.getByTestId("reset-credit-close").click()
    await expect(card.getByTestId("reset-credits")).toHaveCount(0)
    await card.getByTestId("limit-summary-toggle").click()
    await expect(card.getByTestId("reset-credits-check")).toHaveText("리셋권 확인")
    expect(executes).toHaveLength(4)
  })

  test("Claude: no count, the claude.ai link unfolded and on the limit banner; Sign in with ChatGPT shows nothing (mocked)", async ({
    page,
  }) => {
    await page
      .context()
      .route(/^https:\/\/claude\.ai\//, (route) =>
        route.fulfill({ contentType: "text/html", body: "<title>stand-in</title>" }),
      )
    const claude = {
      id: "acc_01J9CLAUDETWO0000000000000",
      kind: "claude-sub",
      label: "업무",
      shortLabel: "C",
      color: "orange",
      providerID: "anthropic",
      billing: "subscription",
      status: "ready",
      autoSwitch: false,
      thirdParty: true,
      readOnly: true,
      connection: { type: "oauth", method: "claude-code" },
      claude: { managed: true, default: false, folder: "C:\\fake\\.claude", loaded: true },
      plugin: { installed: true, acknowledged: true, version: "0.4.0-beta.5" },
    }
    const siwc = {
      id: "acc_siwc_rc",
      kind: "siwc",
      label: "ChatGPT Plus",
      shortLabel: "S",
      color: "green",
      providerID: "own-siwc-rc1",
      billing: "subscription",
      status: "ready",
      autoSwitch: false,
      thirdParty: false,
      readOnly: false,
      identity: { plan: "plus" },
      connection: { type: "oauth", method: "chatgpt-siwc" },
    }
    await mock(page, "plugin.claudeAuth.status", {
      installed: true,
      version: "0.4.0-beta.5",
      integrityOk: true,
      order: "ok",
      phase: "ready",
      acknowledged: null,
      connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@gmail.com" },
      warnings: [],
      patch: { state: "patched", sha256: "a".repeat(64), loaded: true },
      bundle: { version: "0.4.0-beta.5", integrity: "sha512-x", patchSha256: "a".repeat(64), buildId: "e2e" },
    })
    await mock(page, "plugin.claudeAuth.accounts.detect", { found: null, imported: true })
    await mock(page, "accounts.list", { revision: 995, accounts: [claude, siwc] })
    await mock(page, "quota.snapshot", {
      windows: [
        windowOf({
          accountID: claude.id,
          providerID: "anthropic",
          id: "claude.5h",
          label: "5시간",
          usedPercent: 100,
          status: "exhausted",
        }),
        windowOf({
          accountID: siwc.id,
          providerID: siwc.providerID,
          id: "codex.primary",
          label: "5시간",
          usedPercent: 100,
          status: "exhausted",
        }),
      ],
      // A count for a Sign in with ChatGPT account would never come from the router; even so it shows nothing.
      resetCredits: [{ ...creditsOf(), accountID: siwc.id, providerID: siwc.providerID }],
      exhausted: [],
    })
    const calls: string[] = []
    await page.route(/\/api\/rpc\/own\.accounts\/quota\.resetCredits\./, (route) => {
      calls.push(route.request().url())
      return route.abort()
    })
    await page.goto("/accounts")
    const card = page.locator(`[data-testid=claude-account-card][data-account-id="${claude.id}"]`)
    await expect(card.getByTestId("reset-credits")).toHaveCount(0)
    await expect(card.getByTestId("claude-reset-note")).toHaveCount(0)
    await card.getByTestId("limit-summary-toggle").click()
    await expect(card.getByTestId("claude-reset-note")).toHaveText(
      "Claude 리셋권은 claude.ai 설정 > 사용량에서 확인하고 쓸 수 있어요",
    )
    const usage = page.context().waitForEvent("page")
    await card.getByTestId("claude-reset-link").click()
    const opened = await usage
    await opened.waitForURL("https://claude.ai/settings/usage")
    await opened.close()
    const siwcCard = page.locator(`[data-testid=account-card][data-account-id="${siwc.id}"]`)
    await siwcCard.getByTestId("limit-summary-toggle").click()
    await expect(siwcCard.getByTestId("reset-credits")).toHaveCount(0)
    await expect(siwcCard.getByTestId("claude-reset-note")).toHaveCount(0)
    expect(calls).toEqual([])
    await page.setViewportSize({ width: 375, height: 800 })
    await expect.poll(() => noHorizontalScroll(page)).toBe(true)
  })
})

test.describe("limits dashboard (5.5)", () => {
  test("summary, cards, trend and session usage table with local-count tags (mocked usage)", async ({ page }) => {
    await mock(page, "quota.snapshot", {
      windows: [
        windowOf({
          id: "codex.primary",
          label: "5시간",
          usedPercent: 84,
          resetAt: NOW + 65 * 60_000,
          status: "warning",
        }),
      ],
    })
    await mock(page, "accounts.usage", (input) => {
      if (input.groupBy === "session")
        return {
          rows: [
            {
              key: first!.id,
              requests: 3,
              tokens: { input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 400, reasoning: 0 },
              cost: [{ unit: "USD", amount: 0.42 }],
              hitRate: 0.9,
              projectID: null,
              switchCount: 1,
              lastActivityAt: NOW - 120_000,
              accountIDs: [state.account.id],
              modelIDs: [state.model],
            },
          ],
        }
      if (input.groupBy === "day")
        return {
          rows: [
            {
              key: "2026-09-27",
              requests: 3,
              tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
              cost: [{ unit: "USD", amount: 40.3 }],
              hitRate: null,
            },
          ],
        }
      const hour = Math.floor(NOW / 3_600_000) * 3_600_000
      return {
        rows: [
          {
            key: new Date(hour).toISOString(),
            requests: 1,
            tokens: { input: 5_000, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0 },
            cost: [],
            hitRate: null,
          },
        ],
      }
    })
    await page.goto("/limits")
    const summary = page.getByTestId("limits-summary")
    await expect(summary).toContainText(`가장 빠듯한 한도: ${state.account.label} 5시간 남음 16% (1시간 5분 후 리셋)`)
    await expect(summary).toContainText("이번 달 API 지출(로컬 집계) $40.30")
    const card = page.locator(`[data-testid=limits-card][data-account-id="${state.account.id}"]`)
    await expect(card.getByTestId("usage-spark")).toContainText("최근 5시간 5k 토큰")
    await card.getByRole("radio", { name: "7일" }).click()
    await expect(card.getByTestId("usage-spark")).toContainText("최근 7일 5k 토큰")
    const table = page.getByTestId("session-usage")
    await expect(table.getByTestId("usage-row")).toHaveCount(1)
    await expect(table.getByTestId("usage-row")).toContainText(first!.title)
    await expect(table.getByTestId("usage-row")).toContainText("10k (90%)")
    await expect(table.getByTestId("usage-row")).toContainText("$0.42")
    await expect(page.getByTestId("limits-legend")).toContainText("빗금 막대 = 추정")
    await page.screenshot({ path: test.info().outputPath("limits-dashboard.png"), fullPage: true })
  })
})

test.describe("settings (5.7, 5.8.4)", () => {
  test("auto-compaction: account custom with preview, save, back to the kind default (real server)", async ({
    page,
  }) => {
    await page.goto("/settings/compaction")
    const view = page.getByTestId("settings-compaction")
    await expect(
      view.locator('[data-testid=compaction-kind-row][data-kind="ds"]').getByTestId("compaction-kind-desc"),
    ).toHaveText("창의 85%")
    const row = view.locator(`[data-testid=compaction-account-row][data-account-id="${state.account.id}"]`)
    await row.getByRole("radio", { name: "직접 정하기" }).click()
    const editor = row.getByTestId("compaction-editor")
    await editor.getByTestId("compaction-percent").fill("50")
    await expect(editor.getByTestId("compaction-preview")).toContainText(
      new RegExp(`"[^"]+ @ ${state.account.label}"는 [0-9]+k에서 압축해요`),
    )
    await page.screenshot({ path: test.info().outputPath("settings-compaction.png"), fullPage: true })
    await editor.getByTestId("compaction-save").click()
    await expect(page.getByTestId("compaction-status")).toContainText("다음 단계부터 적용돼요.")
    await expect(row).toContainText("(계정)")
    await row.getByRole("button", { name: state.account.label }).click()
    await expect(row.getByTestId("compaction-models")).toContainText("계정")
    await row.getByRole("radio", { name: "종류 기본" }).click()
    await expect(row).toContainText("(모델 한도)")
  })

  test("auto-compaction: a dryRun impact opens the impact dialog before saving (mocked impact)", async ({ page }) => {
    const calls: Record<string, unknown>[] = []
    await mock(page, "accounts.update", (input) => {
      calls.push(input)
      if (input.dryRun)
        return {
          account: { id: state.account.id },
          compactionImpact: {
            sessions: [{ sessionID: first!.id, P: 180_000, triggerTokens: 120_000, truncates: true }],
          },
        }
      return undefined
    })
    await page.goto("/settings/compaction")
    const row = page.locator(`[data-testid=compaction-account-row][data-account-id="${state.account.id}"]`)
    await row.getByRole("radio", { name: "직접 정하기" }).click()
    await row.getByTestId("compaction-percent").fill("45")
    await row.getByTestId("compaction-save").click()
    const impact = page.getByTestId("compaction-impact")
    await expect(impact).toContainText("이 설정을 적용하면 곧바로 압축되는 대화가 있어요")
    await page.screenshot({ path: test.info().outputPath("compaction-impact.png") })
    await expect(impact.getByTestId("impact-row")).toContainText(first!.title)
    await expect(impact.getByTestId("impact-row")).toContainText("요약에서 오래된 대화 일부가 빠져요")
    await expect(impact.getByTestId("impact-compact-first")).toHaveAttribute("data-variant", "primary")
    await impact.getByRole("button", { name: "취소" }).first().click()
    await expect(impact).toBeHidden()
    expect(calls.map((call) => call.dryRun)).toEqual([true])
  })

  test("project plugin approval: blocked location, plan with full hash, approve (mocked, 5.7.1)", async ({ page }) => {
    let approved = false
    const sha = "9f1c2a7be3d4c5f60718293a4b5c6d7e8f9012345678abcdef0123456789abcd"
    await mock(page, "plugin.trust.list", () => ({
      locations: [
        {
          directory: "D:\\tmp\\cloned",
          status: approved ? "ok" : "blocked_by_plugin",
          plugins: [{ id: "x", source: "local:D:\\tmp\\cloned\\.opencode\\plugins\\x.ts", sha256: sha, approved }],
        },
      ],
    }))
    await mock(page, "plugin.trust.approve.plan", {
      nonce: "non_trust",
      expiresAt: NOW + 120_000,
      directory: "D:\\tmp\\cloned",
      plugins: [{ id: "x", source: "local:D:\\tmp\\cloned\\.opencode\\plugins\\x.ts", sha256: sha }],
      warning: "",
    })
    await mock(page, "plugin.trust.approve.execute", () => {
      approved = true
      return { directory: "D:\\tmp\\cloned", status: "ok" }
    })
    await page.goto("/settings/plugins")
    const trust = page.getByTestId("project-trust")
    await expect(trust).toContainText("믿지 않는 폴더 모드로 여세요")
    await expect(trust.getByRole("button", { name: "명령 복사" })).toBeVisible()
    const location = trust.getByTestId("trust-location")
    await expect(location.getByTestId("trust-location-status")).toHaveText("차단됨 — 승인되지 않은 플러그인 1개")
    await location.getByTestId("trust-approve").click()
    const dialog = page.getByTestId("trust-approve-dialog")
    await expect(dialog.getByTestId("trust-sha")).toHaveText(sha)
    await expect(dialog).toContainText("이 앱이 보내는 인증 헤더를 볼 수 있어요")
    await dialog.getByTestId("trust-approve-run").click()
    await expect(location.getByTestId("trust-location-status")).toHaveText("허용됨")
    await expect(location.getByTestId("trust-revoke")).toBeVisible()
  })

  test("switch policy: subscription auto switching is offered disabled with its reason", async ({ page }) => {
    await page.goto("/settings/policy")
    const group = page.getByTestId("policy-sub-api")
    await expect(group.getByRole("radio", { name: "자동" })).toBeDisabled()
    await expect(page.getByTestId("settings-policy")).toContainText("약관상 한도 우회로 볼 수 있어요")
  })

  test("sections are gated by capability (web host: no 데스크톱) and shortcuts list has no conflicts", async ({
    page,
  }) => {
    await page.goto("/settings/shortcuts")
    await expect(page.getByTestId("settings-shortcuts")).toContainText("충돌 없음")
    await expect(page.getByTestId("settings-shortcuts")).toContainText("모델 @ 계정 전환기")
    await expect(page.getByRole("link", { name: "데스크톱 앱" })).toHaveCount(0)
    await page.goto("/settings/desktop")
    await expect(page.getByTestId("page-settings")).toContainText(
      "이 설정은 PC에서 바꿀 수 있어요. 서비스가 도는 PC의 앱 창에서 열어 주세요.",
    )
  })
})

test("phone width: pages and the panel tab have no horizontal scroll (4.2)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  for (const path of ["/accounts", "/limits", "/settings", "/settings/compaction", "/settings/plugins"]) {
    await page.goto(path)
    await expect(page.getByTestId("page-view")).toBeVisible()
    await page.waitForTimeout(300)
    expect(await noHorizontalScroll(page), path).toBe(true)
  }
  await page.goto(`/srv/local/s/${first!.id}`)
  await page.keyboard.press("Control+Shift+KeyU")
  await expect(page.getByTestId("tab-accounts")).toBeVisible()
  expect(await noHorizontalScroll(page)).toBe(true)
  await page.screenshot({ path: test.info().outputPath("accounts-panel-phone.png") })
})
