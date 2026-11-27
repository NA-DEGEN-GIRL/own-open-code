// Screenshots of the composer-plus surfaces in both color schemes (dark is the default, 03 §13): shell mode with the
// running chip and hint, the skills popover, the fork dialog, the compaction banner. Written to
// `$OWN_WEB_COMPOSER_PLUS_SHOTS` when set (review material); the test also checks the text colors are not the same as
// their backgrounds (a missing token would make them so).
import path from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { backend, newSession, openHarness, sessionRoute } from "./support"

test.describe.configure({ mode: "serial" })

const shots = process.env.OWN_WEB_COMPOSER_PLUS_SHOTS

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

/** Text and background of an element resolve to different colors. */
async function readable(locator: Locator) {
  const colors = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    let node: Element | null = element
    let background = "rgba(0, 0, 0, 0)"
    while (node && (background === "rgba(0, 0, 0, 0)" || background === "transparent")) {
      background = getComputedStyle(node).backgroundColor
      node = node.parentElement
    }
    return { color: style.color, background }
  })
  expect(colors.color).not.toBe(colors.background)
}

for (const scheme of ["dark", "light"] as const)
  test(`composer-plus surfaces in the ${scheme} scheme`, async ({ page, request }) => {
    const sessionID = await newSession(request, `화면 ${scheme}`, [`${backend().failMark} 질문입니다`])
    const textarea = await openHarness(page, sessionRoute(sessionID))
    await page.evaluate((value) => window.__composerPlus!.setScheme(value), scheme)

    await textarea.press("Shift+Digit1")
    await textarea.pressSequentially("sleep 3")
    await textarea.press("Enter")
    await expect(page.getByTestId("shell-running")).toBeVisible()
    await textarea.press("Shift+Digit1")
    await textarea.pressSequentially("git status")
    await readable(page.getByTestId("shell-running"))
    await readable(page.getByTestId("shell-hint"))
    await shot(page, `${scheme}-shell`)
    await textarea.fill("")
    await textarea.press("Escape")

    await page.getByTestId("skills-button").click()
    await expect(page.getByTestId("skills-option").first()).toBeVisible()
    await readable(page.getByTestId("skills-option").first())
    await shot(page, `${scheme}-skills`)
    await page.getByTestId("skills-search").press("Escape")

    await page.getByTestId("menu-compact").click()
    await expect(page.getByTestId("compaction-failed")).toBeVisible()
    await readable(page.getByTestId("compaction-failed"))
    await shot(page, `${scheme}-compaction-failed`)

    await page.getByTestId("menu-forkFrom").click()
    await expect(page.getByTestId("fork-option").first()).toBeVisible()
    await readable(page.getByTestId("fork-option").first())
    await readable(page.getByTestId("fork-note-cache"))
    await shot(page, `${scheme}-fork`)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("fork-dialog")).toHaveCount(0)
  })
