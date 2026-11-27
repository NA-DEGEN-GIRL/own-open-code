// Composer history and drafts against the real server (03 §19.9): ↑/↓ walk the sent prompts (empty box or caret on
// the first/last line), ↓ past the newest brings the draft back, keys of a Korean IME composition are never taken,
// the history survives a reload (IndexedDB); a session's draft keeps its text, its skill chip and a pasted image
// across a reload while another session keeps its own.
import { expect, test, type Page } from "@playwright/test"
import { compose, newSession, openHarness, pasteImage, sessionRoute } from "./support"

test.describe.configure({ mode: "serial" })

const sent = (page: Page) => page.evaluate(() => window.__composerPlus!.sent.map((item) => item.text))

test("↑/↓ walk the history, the draft comes back, IME keys are left alone, and it survives a reload", async ({
  page,
  request,
}) => {
  const sessionID = await newSession(request, "기록 e2e")
  const textarea = await openHarness(page, sessionRoute(sessionID))
  await textarea.pressSequentially("첫 번째 기록")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await textarea.pressSequentially("두 번째 기록")
  await textarea.press("Enter")
  await expect.poll(() => sent(page)).toEqual(["첫 번째 기록", "두 번째 기록"])

  await textarea.pressSequentially("쓰던 글")
  await textarea.press("ArrowUp")
  await expect(textarea).toHaveValue("두 번째 기록")
  await expect(page.getByTestId("history-position")).toContainText("기록 1/")
  await textarea.press("ArrowUp")
  await expect(textarea).toHaveValue("첫 번째 기록")
  await textarea.press("ArrowDown")
  await expect(textarea).toHaveValue("두 번째 기록")
  await textarea.press("ArrowDown")
  await expect(textarea).toHaveValue("쓰던 글")
  await expect(page.getByTestId("history-position")).toHaveCount(0)

  // A multi-line draft: ↑ on the second line moves the caret, not the history.
  await textarea.fill("")
  await textarea.pressSequentially("윗줄")
  await textarea.press("Shift+Enter")
  await textarea.pressSequentially("아랫줄")
  await textarea.press("ArrowUp")
  await expect(textarea).toHaveValue("윗줄\n아랫줄")

  // ↑ during a composition (keyCode 229) belongs to the IME.
  await textarea.fill("")
  const ime = await compose(page, "한")
  await ime.key("ArrowUp")
  await expect(textarea).toHaveValue("한")
  await ime.commit()
  await ime.detach()
  await expect(textarea).toHaveValue("한")

  await textarea.fill("")
  await page.waitForTimeout(1_200)
  await openHarness(page, sessionRoute(sessionID))
  await expect(async () => {
    await textarea.press("ArrowUp")
    await expect(textarea).toHaveValue("두 번째 기록", { timeout: 500 })
  }).toPass({ timeout: 15_000 })
})

test("a session's draft keeps its text, skill chip and pasted image across a reload", async ({ page, request }) => {
  const first = await newSession(request, "초안 e2e A")
  const second = await newSession(request, "초안 e2e B")
  const textarea = await openHarness(page, sessionRoute(first))
  await textarea.pressSequentially("쓰던 초안")
  await pasteImage(page)
  const chips = page.getByTestId("attachment-chip")
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
  await page.getByTestId("skills-button").click()
  await page.getByTestId("skills-search").pressSequentially("review")
  await page.getByTestId("skills-search").press("Enter")
  await expect(page.getByTestId("mention-chip")).toHaveCount(1)
  await expect(page.getByTestId("mention-chip")).toContainText("review-guide")

  await page.evaluate((next) => window.__composerPlus!.navigate(next), sessionRoute(second))
  await expect(textarea).toHaveValue("")
  await expect(chips).toHaveCount(0)
  await textarea.pressSequentially("B 초안")
  // Blur saves at once (03 §19.9 "blur에 저장").
  await page.locator("body").click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(300)

  await openHarness(page, sessionRoute(first))
  await expect(textarea).toHaveValue("쓰던 초안")
  await expect(page.getByTestId("mention-chip")).toContainText("review-guide")
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute("data-state", "ready")
  await page.evaluate((next) => window.__composerPlus!.navigate(next), sessionRoute(second))
  await expect(textarea).toHaveValue("B 초안")
  await expect(chips).toHaveCount(0)
  await expect(page.getByTestId("mention-chip")).toHaveCount(0)

  // Sending clears what was kept: after a reload the sent draft stays empty.
  await page.evaluate((next) => window.__composerPlus!.navigate(next), sessionRoute(first))
  await expect(chips).toHaveCount(1)
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect(chips).toHaveCount(0)
  await page.waitForTimeout(1_200)
  await openHarness(page, sessionRoute(first))
  await expect(textarea).toHaveValue("")
  await page.waitForTimeout(500)
  await expect(chips).toHaveCount(0)
  await expect(page.getByTestId("mention-chip")).toHaveCount(0)
})
