// Screenshots of every state at the widths people use, to look at (03 §4.3). Geometry is asserted in sections.pw.ts;
// here only that nothing is cut off sideways and the bottom zone is where it belongs.
import { expect, test, type Page } from "@playwright/test"
import { open, resetLists, section, shot } from "./support"

const SIZES = [
  { width: 1440, height: 900, touch: false },
  { width: 1024, height: 768, touch: false },
  { width: 840, height: 900, touch: true },
  { width: 600, height: 800, touch: true },
  { width: 412, height: 915, touch: true },
  { width: 360, height: 780, touch: true },
] as const

async function reveal(page: Page) {
  const app = page.getByTestId("app")
  const mode = await app.getAttribute("data-sidebar-mode")
  if (mode === "drawer" && (await app.getAttribute("data-sidebar")) === "closed")
    await page.getByTestId("sidebar-toggle").first().click()
  await page.waitForTimeout(300)
}

for (const size of SIZES)
  for (const theme of ["dark", "light"] as const)
    test(`${size.width} ${theme}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        locale: "ko-KR",
        ...(size.touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
      })
      const page = await context.newPage()
      await resetLists(page)
      const name = (state: string) => `${size.width}-${theme}-${state}`
      const sidebar = page.getByTestId("sidebar")
      const extra = theme === "light" ? "&light" : ""

      await open(page, `hosts=ubuntu&pcs${extra}`)
      await reveal(page)
      await shot(sidebar, name("1-open"))
      const bottom = await page.getByTestId("sidebar-settings").boundingBox()

      for (const key of ["local", "h-ubuntu"]) await section(page, key).getByTestId("server-toggle").click()
      await shot(sidebar, name("2-collapsed"))
      expect((await page.getByTestId("sidebar-settings").boundingBox())!.y).toBe(bottom!.y)
      for (const key of ["local", "h-ubuntu"]) await section(page, key).getByTestId("server-toggle").click()

      await page.getByTestId("sidebar-scroll").evaluate((element) => element.scrollTo(0, 260))
      await page.waitForTimeout(100)
      await shot(sidebar, name("3-scrolled"))

      await open(page, `hosts=ubuntu,nas,work,empty&pcs${extra}`)
      await reveal(page)
      await section(page, "local").getByTestId("server-toggle").click()
      await section(page, "h-ubuntu").getByTestId("server-toggle").click()
      await shot(sidebar, name("4-states"))
      await page.getByTestId("sidebar-search").fill("스크립트")
      await expect(section(page, "h-ubuntu").getByTestId("session-row").first()).toBeVisible()
      await page.waitForTimeout(600)
      await shot(sidebar, name("5-search"))

      expect(
        await page.getByTestId("sidebar-scroll").evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBe(0)
      await page.getByTestId("sidebar-search").press("Escape")
      await page.getByTestId("archive-toggle").click()
      await shot(sidebar, name("6-archive"))
      await page.getByTestId("archive-back").click()
      await page.setViewportSize({ width: size.width, height: 400 })
      await page.waitForTimeout(200)
      await shot(sidebar, name("7-low"))
      await context.close()
    })
