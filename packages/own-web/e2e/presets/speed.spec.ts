// 속도 (02 §4.8, 03 §4.6) through the real composer and the real switcher popover, in Edge against this suite's
// backend.ts (the real server with own-accounts, one fake Codex backend for ChatGPT 01 and 02, a metered DeepSeek):
//   - the new-conversation screen: DeepSeek greys the control with its reason, ChatGPT 01 offers Fast, and Fast picked
//     there is set on the new session before its first prompt (the 2026-10-10 review: the pick was lost when the
//     composer navigated, because leaving the screen released the target's offers);
//   - the switcher's 속도 row, in view under both columns: a speed-only apply on the same model, and a model change with
//     a speed, which switches first and sets the speed once the session runs on the new main (the review: apply read
//     the popover's request after closing it, so neither happened);
//   - the effort button reads `기본` for own-web's `default` variant.
// The requests are read off the page's network: `session.speed.set` must carry the new session's id.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test"

interface PresetsState {
  readonly workspace: string
}

const TMP = process.env.OWN_WEB_PRESETS_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as PresetsState

test.describe.configure({ mode: "serial" })

test.describe("speed in the composer and the switcher (02 §4.8)", () => {
  test.skip(!TMP, "needs e2e/presets/backend.ts: bun run test:e2e:presets")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []
  const calls: Array<{ readonly method: string; readonly input: Record<string, unknown> }> = []
  let sessionID = ""

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("request", (request: Request) => {
      const method = request.url().match(/\/api\/rpc\/own\.accounts\/([^?]+)/)?.[1]
      if (!method) return
      const body = request.postDataJSON() as { readonly input?: Record<string, unknown> } | null
      calls.push({ method, input: body?.input ?? {} })
    })
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test("a new conversation: DeepSeek greys the speed, ChatGPT 01 offers Fast, and Fast is set before the first prompt", async () => {
    await page.goto("/")
    await ready(page)
    await unfold(page)
    const speed = page.getByTestId("composer-speed")
    await pick(page, "DeepSeek")
    await expect(page.getByTestId("switcher-speed")).toContainText("이 계정 종류에는 빠른 속도가 없어요")
    await page.getByTestId("switcher-apply").click()
    await expect(speed).toBeDisabled()
    await expect(page.getByTestId("composer-speed-wrap")).toHaveAttribute(
      "title",
      "이 계정 종류에는 빠른 속도가 없어요",
    )

    await pick(page, "ChatGPT 01")
    await expect(page.getByTestId("switcher-speed").locator('button[data-speed="fast"]')).toBeEnabled()
    await page.getByTestId("switcher-apply").click()
    await expect(speed).toBeEnabled()
    await expect(page.getByTestId("composer-variant")).toHaveText(/^기본/)
    await speed.click()
    await page.getByTestId("composer-speed-menu").locator('[data-speed="fast"]').click()
    await expect(speed).toHaveText(/Fast/)

    const box = page.locator("#own-composer-input")
    await box.fill("속도를 확인하는 첫 메시지")
    await box.press("Control+Enter")
    await page.waitForURL(/\/s\/ses_/)
    sessionID = page.url().match(/\/s\/(ses_[A-Za-z0-9]+)/)![1]!
    await expect.poll(() => sets(sessionID)).toEqual([{ sessionID, speed: "fast" }])
    await expect(speed).toHaveText(/Fast/)
    const view = await accounts(page, "session.speed.get", { sessionID }, state().workspace)
    expect([view.choice, view.effective]).toEqual(["fast", "fast"])
    await idle(page, sessionID)
  })

  test("the switcher's 속도 row on the same model: in view, and applying sets the speed", async () => {
    await page.getByTestId("composer-switcher").click()
    const row = page.getByTestId("switcher-speed")
    await expect(row).toBeInViewport()
    await expect(page.getByTestId("switcher-options")).toContainText("추론 강도")
    await row.locator('button[data-speed="standard"]').click()
    await page.getByTestId("switcher-apply").click()
    await expect.poll(() => sets(sessionID).at(-1)).toEqual({ sessionID, speed: "standard" })
    await expect(page.getByTestId("composer-speed")).toHaveText(/표준/)
  })

  test("the switcher with another model and a speed: the switch first, then the speed on the new main", async () => {
    await pick(page, "ChatGPT 02")
    await page.getByTestId("switcher-speed").locator('button[data-speed="fast"]').click()
    await page.getByTestId("switcher-apply").click()
    // A switch over its thresholds asks first; a faster speed with an open cost asks too.
    const confirm = page.getByTestId("switch-dialog-confirm")
    if (await confirm.isVisible().catch(() => false)) await confirm.click()
    await expect
      .poll(() => calls.some((call) => call.method === "switch.apply" && call.input.sessionID === sessionID))
      .toBe(true)
    await expect(page.getByTestId("composer-switcher-label")).toContainText("ChatGPT 02")
    await expect(page.getByTestId("speed-cost-dialog")).toBeVisible()
    await page.getByTestId("speed-confirm").click()
    await expect.poll(() => sets(sessionID).at(-1)).toEqual({ sessionID, speed: "fast" })
    await expect(page.getByTestId("composer-speed")).toHaveText(/Fast/)
    expect(errors).toEqual([])
  })

  /** The applied (not dry) `session.speed.set` calls for a session. */
  function sets(id: string) {
    return calls
      .filter((call) => call.method === "session.speed.set" && call.input.sessionID === id && !call.input.dryRun)
      .map((call) => call.input)
  }
})

// ---------------------------------------------------------------------------------------------------------------

async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

/** With the sidebar and the work panel open the composer folds its tools behind ⋯ (03 §4.6): unfold them. */
async function unfold(page: Page) {
  await expect(page.getByTestId("composer-switcher")).toBeVisible({ timeout: 60_000 })
  const more = page.getByTestId("composer-more")
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true") await more.click()
}

/** Opens the switcher from the composer and highlights an account. */
async function pick(page: Page, account: string) {
  await page.getByTestId("composer-switcher").click()
  await page.getByTestId("switcher-account").filter({ hasText: account }).first().click()
  await expect(page.getByTestId("switcher-speed")).toBeVisible()
}

/** The session's newest message is its `idle` marker: the turn ended. */
async function idle(page: Page, sessionID: string) {
  const query = `location%5Bdirectory%5D=${encodeURIComponent(state().workspace)}`
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/session/${sessionID}/message?limit=1&${query}`)
        const body = (await response.json()) as { readonly data?: ReadonlyArray<{ readonly type: string }> }
        return body.data?.[0]?.type
      },
      { timeout: 90_000 },
    )
    .toBe("idle")
}

/** An own.accounts RPC through the page's API path (the dev proxy adds the auth). */
async function accounts(page: Page, method: string, input: unknown, directory: string) {
  const response = await page.request.post(
    `/api/rpc/own.accounts/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    { data: { input } },
  )
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`own.accounts ${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}
