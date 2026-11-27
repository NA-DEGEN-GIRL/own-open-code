// 03 §19.14 설정 > 일반 > 타임라인 상세: `간단 / 보통 / 자세히` (session-ui quiet / compact / detailed), `보통` by default,
// kept per viewer, followed by other windows, keyboard-operable (radiogroup arrows).
import path from "node:path"
import { expect, test } from "@playwright/test"
import { openHarness, shots, ux } from "./support"

test.describe.configure({ mode: "serial" })

test("보통 by default; 자세히 persists across reloads and reaches other windows; arrows move", async ({
  page,
  context,
}) => {
  const errors = await openHarness(page)
  await page.evaluate(() => localStorage.removeItem("own.web.timeline.detail"))
  await page.reload()
  const group = page.getByTestId("settings-timeline-preset")
  await expect(group.getByRole("radio", { name: "보통" })).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("settings-timeline-describe")).toContainText("기본값이에요")

  await group.getByRole("radio", { name: "자세히" }).click()
  await expect(group.getByRole("radio", { name: "자세히" })).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("settings-timeline-describe")).toHaveText(
    "셸 실행과 파일 편집을 펼쳐 보이고, 나머지 도구와 생각 과정은 묶어 둬요.",
  )
  expect(await page.evaluate(() => localStorage.getItem("own.web.timeline.detail"))).toBe("detailed")
  await page.reload()
  await expect(group.getByRole("radio", { name: "자세히" })).toHaveAttribute("aria-checked", "true")

  const other = await context.newPage()
  await openHarness(other)
  const otherGroup = other.getByTestId("settings-timeline-preset")
  await expect(otherGroup.getByRole("radio", { name: "자세히" })).toHaveAttribute("aria-checked", "true")
  await otherGroup.getByRole("radio", { name: "자세히" }).focus()
  await other.keyboard.press("ArrowLeft")
  await expect(otherGroup.getByRole("radio", { name: "보통" })).toHaveAttribute("aria-checked", "true")
  await other.keyboard.press("ArrowLeft")
  await expect(otherGroup.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true")
  // The first window follows (storage event).
  await expect(group.getByRole("radio", { name: "간단" })).toHaveAttribute("aria-checked", "true")
  await other.close()

  for (const scheme of ["dark", "light"] as const) {
    await ux(page, "setScheme", scheme)
    await page
      .getByTestId("settings-timeline")
      .screenshot({ path: path.join(shots(), `timeline-setting-${scheme}.png`) })
  }
  await ux(page, "setScheme", "dark")
  await group.getByRole("radio", { name: "보통" }).click()
  expect(errors).toEqual([])
})
