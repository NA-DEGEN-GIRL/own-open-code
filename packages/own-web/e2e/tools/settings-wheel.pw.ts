// 설정 > 스킬 and MCP 서버 under the wheel (2026-11-03 user report: at 150 % only the empty space beside the column
// scrolled the page). With this backend's skills (core's, own's, the import view's groups) the page is long; the wheel
// must scroll it over the skill rows, their `쓰는 곳` selects, the search box and the import view as well as over the
// gutter, at 100 % and at 150 % (Chromium's page zoom as a 1.5 device scale factor over a ⅔ viewport).
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { scrollTraps, wheelAt, wheelPoints } from "../support"

const TMP = process.env.OWN_WEB_TOOLS_E2E_TMP ?? ""
const state = JSON.parse(fs.readFileSync(path.join(TMP, "backend.json"), "utf8")) as { readonly session: string }

for (const zoom of [1, 1.5]) {
  test.describe(`settings wheel at ${zoom * 100} %`, () => {
    test.use({ viewport: { width: Math.round(1440 / zoom), height: Math.round(480 / zoom) }, deviceScaleFactor: zoom })

    test("스킬 and MCP 서버 scroll under the wheel over their content and their gutter", async ({ page }) => {
      await page.goto(`/srv/local/s/${state.session}`)
      await expect(page.getByTestId("transcript-body")).toBeVisible({ timeout: 60_000 })
      await page.goto("/settings/skills")
      const settings = page.getByTestId("page-settings")
      await expect(settings).toHaveAttribute("data-layout", "split")
      const content = page.getByTestId("settings-content")
      const failed: string[] = []
      for (const section of ["skills", "mcp"]) {
        await page.getByTestId(`settings-nav-${section}`).click()
        await expect(settings).toHaveAttribute("data-section", section)
        await expect(content.getByText("불러오는 중")).toHaveCount(0, { timeout: 60_000 })
        await expect.poll(() => content.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(40)
        for (const point of await wheelPoints(content, page.locator(".own-settings-body")))
          if ((await wheelAt(page, content, point)) === 0) failed.push(`${section}: ${point.name}`)
      }
      // The parts the report named: a skill row, its 쓰는 곳 select, the search box; and the embedded import view.
      await page.getByTestId("settings-nav-skills").click()
      await expect(content.getByText("불러오는 중")).toHaveCount(0, { timeout: 60_000 })
      for (const [name, target] of [
        ["skill row", content.getByTestId("settings-skills-row").first()],
        ["쓰는 곳", content.getByTestId("settings-skills-where").first()],
        ["search", content.getByTestId("settings-skills-search")],
        ["import view", content.getByTestId("skills-import")],
      ] as const) {
        if ((await target.count()) === 0) continue
        await target.scrollIntoViewIfNeeded()
        const box = (await target.boundingBox())!
        const contentBox = (await content.boundingBox())!
        const y = Math.min(
          Math.max(box.y + Math.min(box.height / 2, 12), contentBox.y + 8),
          contentBox.y + contentBox.height - 8,
        )
        const point = { x: box.x + Math.min(box.width / 2, 40), y }
        // From the target's own place in the page (scrolled into view), one notch must move the page: down, or up
        // when the target sits at the end of the page.
        const before = await content.evaluate((node) => node.scrollTop)
        const atEnd = await content.evaluate((node) => node.scrollTop >= node.scrollHeight - node.clientHeight - 1)
        await page.mouse.move(point.x, point.y)
        await page.mouse.wheel(0, atEnd ? -120 : 120)
        await expect
          .poll(() => content.evaluate((node) => node.scrollTop), { message: name, timeout: 2_000 })
          .not.toBe(before)
          .catch(() => failed.push(`skills: ${name}`))
      }
      expect(failed).toEqual([])
      // No box of the page ends the wheel's chain with nothing to scroll (the embedded import view did).
      expect(await scrollTraps(content)).toEqual([])
    })
  })
}
