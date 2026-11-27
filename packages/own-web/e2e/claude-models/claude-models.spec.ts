// The model @ account sheet's Claude rows (decisions CAM, 2.2.6-own.20; 03 §5.2, 02 §8.10.5) in Edge against
// backend.ts: a Claude Agent account whose fake Claude Code reports each alias's model, window and Fast as Claude Code
// 2.1.329 does, the Claude subscription slot and an Anthropic API key.
//   - Claude Agent rows name the model each alias runs (`Opus · Opus 5.5`, core P-060) and every row, Fable too, has
//     the window Claude Code reported; the footer of the selection says the same window as its row.
//   - 속도: Fast where Claude Code offers it (Opus, Fable) with its usage-credit price, the model note elsewhere; the
//     cost line of a plan says so instead of `비용 알 수 없음`, and no `요율을 몰라` note.
//   - 목록에서 숨기기 on the picked row of each account kind: the row leaves the list at once, the toast and
//     `숨긴 모델 1개` bring it back.
//   - A Fast turn: Claude Code's `fastMode` flag goes on before the turn (the fake's log) and the turn ran Fast.
//   - The sheet at 384 px on a touch screen: the hide button stays whole (the layout audit) and a tap hides.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { readLog } from "../../../own-team/test/e2e/fake-claude"
import { ALLOWED } from "../ui-audit/allowlist"
import { Audit } from "../ui-audit/audit"

interface State {
  readonly control: string
  readonly ownHome: string
  readonly workspace: string
  readonly sessions: { readonly agent: string; readonly claude: string; readonly key: string }
  readonly accounts: { readonly agent: string; readonly claude: string; readonly key: string }
}

const TMP = process.env.OWN_WEB_CLAUDE_MODELS_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as State
const agentFolder = () => path.join(state().ownHome, "claude-agent", "accounts", state().accounts.agent)

test.describe.configure({ mode: "serial" })

test.describe("Claude rows of the model @ account sheet (CAM)", () => {
  test.skip(!TMP, "needs e2e/claude-models/backend.ts: bun run test:e2e:claude-models")

  // Every test starts with nothing hidden.
  test.beforeEach(async () => {
    await rpc("policy.set", { patch: { hiddenModels: [] } })
  })

  test("Claude Agent: the model each alias runs, one window for every row and the footer, Fable included", async ({
    page,
  }) => {
    await openSheet(page, state().sessions.agent)
    const rows = page.getByTestId("switcher-model")
    await expect(rows).toHaveCount(4)
    const names = (await rows.locator(".own-sw-model-label").allInnerTexts()).map((text) => text.trim())
    expect(names).toEqual(["Opus · Opus 5.5", "Fable · Fable 5.2", "Sonnet · Sonnet 5.5", "Haiku · Haiku 5.5"])
    for (const text of await rows.locator(".own-sw-meta").allInnerTexts())
      expect(text).toContain("창 1M · 자동 압축 850k")
    await expect(page.getByTestId("switcher-model-version-later")).toHaveCount(0)
    for (const id of ["sonnet", "fable"]) {
      await row(page, id).click()
      await expect(page.getByTestId("switcher-estimate")).toContainText("창 1M · 자동 압축 850k (모델 한도)")
    }
    // The server's view says the same for the account (`accounts.list`), the source of the rows.
    const list = (await rpc("accounts.list", {})) as {
      accounts: ReadonlyArray<{
        id: string
        compaction?: { effective: ReadonlyArray<{ modelID: string; windowTokens: number }> }
      }>
    }
    const agent = list.accounts.find((item) => item.id === state().accounts.agent)
    expect(agent?.compaction?.effective.map((item) => [item.modelID, item.windowTokens]).sort()).toEqual([
      ["fable", 1_000_000],
      ["haiku", 1_000_000],
      ["opus", 1_000_000],
      ["sonnet", 1_000_000],
    ])
  })

  test("Claude Agent: Fast on Opus and Fable at the usage-credit price, the model note on Sonnet, a plan's cost line", async ({
    page,
  }) => {
    await openSheet(page, state().sessions.agent)
    const speed = page.getByTestId("switcher-speed")
    await expect(speed.locator('button[data-speed="fast"]')).toContainText("$8/$40")
    await row(page, "fable").click()
    await expect(speed.locator('button[data-speed="fast"]')).toBeVisible()
    await row(page, "sonnet").click()
    await expect(speed.locator('button[data-speed="fast"]')).toHaveCount(0)
    await expect(page.getByTestId("switcher-speed-note")).toHaveText(
      "이 계정과 모델에는 지금 Fast가 없어요(요금제·모델 목록에 없음)",
    )
    await expect(page.getByTestId("switcher-options")).not.toContainText("이 앱이 이 모델 회사의 요청을 다루지 않아")
    await expect(page.getByTestId("switcher-estimate")).not.toContainText("요율을 몰라")
    await expect(page.getByTestId("switcher-estimate")).not.toContainText("비용 알 수 없음")
  })

  for (const kind of ["agent", "claude", "key"] as const)
    test(`목록에서 숨기기 on the picked row leaves the list at once and comes back (${kind})`, async ({ page }) => {
      await openSheet(page, state().sessions[kind])
      const rows = page.getByTestId("switcher-model")
      const before = await rows.count()
      // Pick the second row, then hide that very row (the user's case: nothing seemed to happen).
      const target = rows.nth(1)
      const id = (await target.getAttribute("id"))!
      await target.click()
      await expect(target).toHaveAttribute("aria-selected", "true")
      await target.getByTestId("switcher-model-hide").click()
      await expect(page.locator(`[id="${id}"]`)).toHaveCount(0)
      await expect(rows).toHaveCount(before - 1)
      // The neighbour is picked instead, so the sheet stays usable.
      await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true")
      await expect(page.getByTestId("toasts")).toContainText("목록에서 숨겼어요")
      const toggle = page.getByTestId("switcher-hidden-models")
      await expect(toggle).toHaveText(/숨긴 모델 1개/)
      await toggle.click()
      const back = page.locator(`[id="${id}"]`)
      await expect(back.getByTestId("switcher-model-hidden")).toHaveText("숨김")
      await back.getByTestId("switcher-model-hide").click()
      await expect(back.getByTestId("switcher-model-hidden")).toHaveCount(0)
      await expect
        .poll(
          async () =>
            ((await rpc("policy.get", {})) as { policy: { hiddenModels?: unknown[] } }).policy.hiddenModels ?? [],
        )
        .toEqual([])
    })

  test("a Fast turn on Claude Agent turns Claude Code's fastMode on before the turn and runs Fast", async ({
    page,
  }) => {
    const sessionID = state().sessions.agent
    await rpc("session.speed.set", { sessionID, speed: "fast", consent: true }, state().workspace)
    await page.goto(`/srv/local/s/${sessionID}`)
    await ready(page)
    const box = page.locator("#own-composer-input")
    await box.fill("Fast로 한 번 답해 주세요")
    await box.press("Control+Enter")
    await expect
      .poll(() =>
        readLog(agentFolder()).some(
          (line) =>
            line.kind === "in" &&
            (line.message?.request as { subtype?: string; settings?: { fastMode?: boolean } } | undefined)?.settings
              ?.fastMode === true,
        ),
      )
      .toBe(true)
    await expect
      .poll(
        async () =>
          ((await rpc("session.speed.get", { sessionID }, state().workspace)) as { served?: { served: string } }).served
            ?.served,
        {
          timeout: 60_000,
        },
      )
      .toBe("fast")
    await rpc("session.speed.set", { sessionID, speed: "standard" }, state().workspace)
  })

  test("the sheet on a 384 px touch screen: the hide button stays whole and a tap hides the row", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 384, height: 742 },
      deviceScaleFactor: 2.8125,
      hasTouch: true,
      isMobile: true,
      locale: "ko-KR",
    })
    const page = await context.newPage()
    await openSheet(page, state().sessions.claude)
    const audit = new Audit(test.info(), 384, ALLOWED, undefined, new Set())
    await audit.check(page, "switcher claude rows", page.getByTestId("switcher"))
    const defects = audit.findings.filter(
      (item) => !item.allowed && item.element.includes("switcher-model") && item.kind !== "ellipsis",
    )
    expect(defects).toEqual([])
    const rows = page.getByTestId("switcher-model")
    const hide = rows.nth(1).getByTestId("switcher-model-hide")
    const box = (await hide.boundingBox())!
    const sheet = (await page.getByTestId("switcher").boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width)
    expect(box.height).toBeGreaterThanOrEqual(44)
    const id = (await rows.nth(1).getAttribute("id"))!
    await hide.tap()
    await expect(page.locator(`[id="${id}"]`)).toHaveCount(0)
    await context.close()
  })
})

async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

async function openSheet(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  await ready(page)
  // A phone's bound conversation has the header's pill as its one model control (S23); elsewhere the composer's button.
  const pill = page.getByTestId("running-on-pill").first()
  const button = page.getByTestId("composer-switcher")
  await expect(button.or(pill).first()).toBeVisible({ timeout: 60_000 })
  const more = page.getByTestId("composer-more")
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true") await more.click()
  await ((await button.isVisible()) ? button.click() : pill.tap())
  await expect(page.getByTestId("switcher-model").first()).toBeVisible()
}

function row(page: Page, modelID: string) {
  return page.locator(`[id="own-sw-m-${modelID}"]`)
}

async function rpc(method: string, input: unknown, directory = state().control) {
  const response = await fetch(
    `${process.env.OWN_WEB_CLAUDE_MODELS_E2E_BASE ?? `http://127.0.0.1:${process.env.OWN_WEB_CLAUDE_MODELS_E2E_PORT ?? 5793}`}/api/rpc/own.accounts/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) },
  )
  const body = (await response.json()) as { output?: unknown }
  if (!response.ok) throw new Error(`own.accounts ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}
