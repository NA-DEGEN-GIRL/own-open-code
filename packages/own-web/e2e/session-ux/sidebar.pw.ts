// 03 §19.11 against the real server: date groups (오늘/어제/이번 주/이전), pin and archive in the own metadata namespace
// (`own.pinned` / `own.archived`, read-modify-write so other keys survive), the `고정됨` group, the `보관함` view, the row
// `⋯` menu by mouse and keyboard, the undo toast, session-id search from a pasted link, and flags cleared on fork
// (01 §17.1 #27).
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { bucketOf, dayMarks } from "../../src/sidebar/model"
import { createSession, openHarness, shots, turn, ux, uxState } from "./support"

test.describe.configure({ mode: "serial" })

const list = (page: Page) => page.getByTestId("session-list")
const row = (page: Page, id: string) => list(page).locator(`[data-testid="session-row"][data-session-id="${id}"]`)
const menuButton = (page: Page, id: string) => row(page, id).locator("xpath=..").getByTestId("row-menu-button")

async function menu(page: Page, id: string, item: "row-pin" | "row-archive" | "row-copy-id") {
  await row(page, id).hover()
  await menuButton(page, id).click()
  await expect(page.getByTestId("row-menu")).toBeVisible()
  await page.getByTestId("row-menu").getByTestId(item).click()
  await expect(page.getByTestId("row-menu")).toBeHidden()
}

async function metadata(page: Page, id: string) {
  return ux<Record<string, unknown>>(page, "metadata", id)
}

/** Titles, date headers (`# …`), the pinned group (`# 고정됨`) and project headers (`@`) of the local list, in order. */
async function listing(page: Page) {
  return list(page)
    .locator(
      '[data-testid="date-row"], [data-testid="session-title"], [data-testid="pinned-group"], [data-testid="project-row"]',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const kind = node.getAttribute("data-testid")
        if (kind === "date-row") return `# ${node.textContent?.trim()}`
        if (kind === "pinned-group") return "# 고정됨"
        if (kind === "project-row") return "@"
        return node.textContent?.trim() ?? ""
      }),
    )
}

/** Titles listed in the 고정됨 group. */
async function pinnedTitles(page: Page) {
  const items = await listing(page)
  const start = items.indexOf("# 고정됨")
  if (start < 0) return []
  const end = items.indexOf("@", start)
  return items.slice(start + 1, end < 0 ? undefined : end)
}

test("date groups: seeded sessions sit under 오늘 / 어제 / 이번 주 / 이전 in their project (19.11)", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const state = uxState()
  for (const seed of state.seeded) await expect(row(page, seed.id)).toBeVisible()
  const labels = { today: "오늘", yesterday: "어제", week: "이번 주", older: "이전" } as const
  const marks = dayMarks(Date.now())
  // Other suites' sessions may be listed too (they are today's): each seed sits under its own day's header.
  const items = (await listing(page)).filter((item) => item !== "@")
  const headerOf = (title: string) => items.slice(0, items.indexOf(title)).findLast((item) => item.startsWith("# "))
  for (const seed of state.seeded) expect(headerOf(seed.title)).toBe(`# ${labels[bucketOf(seed.updated, marks)]}`)
  const headers = items.filter((item) => item.startsWith("# "))
  expect(headers).toEqual([...new Set(headers)])
  expect(headers.indexOf("# 오늘")).toBe(0)
  expect(headers.at(-1)).toBe("# 이전")
  expect(errors).toEqual([])
})

test("pin: ⋯ → 고정 moves the row into 고정됨, written as own.pinned; survives reloads and a cleared cache", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "고정 테스트")
  await expect(row(page, id)).toBeVisible()
  // Another host's key must survive the read-modify-write (PATCH replaces the whole metadata object).
  await page.evaluate(
    ([sessionID]) =>
      fetch(`/api/session/${sessionID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: { "other.host": { keep: true } } }),
      }),
    [id],
  )
  await menu(page, id, "row-pin")
  await expect(page.getByTestId("pinned-group")).toContainText("고정됨")
  expect(await pinnedTitles(page)).toEqual(["고정 테스트"])
  await expect.poll(async () => typeof (await metadata(page, id))["own.pinned"]).toBe("number")
  expect((await metadata(page, id))["other.host"]).toEqual({ keep: true })

  await page.reload()
  await expect(page.getByTestId("pinned-group")).toBeVisible()
  expect(await pinnedTitles(page)).toEqual(["고정 테스트"])

  // A browser without the local cache learns the flag from the server (connect scan).
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("own.web.sidebar.flags.")) localStorage.removeItem(key)
  })
  await page.reload()
  await expect(page.getByTestId("pinned-group")).toBeVisible()

  // The group folds like a project; unpinning puts the row back into its project.
  await page.getByTestId("pinned-group").click()
  await expect(row(page, id)).toHaveCount(0)
  await page.getByTestId("pinned-group").click()
  await menu(page, id, "row-pin")
  await expect(page.getByTestId("pinned-group")).toHaveCount(0)
  await expect.poll(async () => (await metadata(page, id))["own.pinned"]).toBeUndefined()
  expect((await metadata(page, id))["other.host"]).toEqual({ keep: true })
  expect(errors).toEqual([])
})

test("archive: the row leaves the list with an undo toast; 보관함 lists it; 보관 해제; search tags it", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "보관 테스트")
  await expect(row(page, id)).toBeVisible()

  await menu(page, id, "row-archive")
  await expect(row(page, id)).toHaveCount(0)
  const toast = page.getByTestId("toast").filter({ hasText: '"보관 테스트" 대화를 보관했어요' })
  await expect(toast).toBeVisible()
  await expect.poll(async () => typeof (await metadata(page, id))["own.archived"]).toBe("number")
  await toast.getByRole("button", { name: "보관 취소" }).click()
  await expect(row(page, id)).toBeVisible()
  await expect.poll(async () => (await metadata(page, id))["own.archived"]).toBeUndefined()

  await menu(page, id, "row-archive")
  await expect(row(page, id)).toHaveCount(0)
  await page.getByTestId("archive-toggle").click()
  await expect(page.getByTestId("archive-toggle")).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("archive-header")).toContainText("보관함 · 1")
  await expect(row(page, id)).toBeVisible()
  await page.screenshot({ path: path.join(shots(), "sidebar-archive-dark.png") })

  // In the archive the menu offers 보관 해제 (no 고정).
  await row(page, id).hover()
  await menuButton(page, id).click()
  await expect(page.getByTestId("row-menu").getByTestId("row-pin")).toHaveCount(0)
  await expect(page.getByTestId("row-menu").getByTestId("row-archive")).toHaveText("보관 해제")
  await page.getByTestId("row-menu").getByTestId("row-archive").click()
  await expect(page.getByTestId("archive-empty")).toHaveText("보관한 대화가 없어요")
  await page.getByTestId("archive-back").click()
  await expect(row(page, id)).toBeVisible()

  // Searching finds archived sessions too, tagged.
  await menu(page, id, "row-archive")
  await page.getByTestId("sidebar-search").fill("보관 테스트")
  await expect(row(page, id)).toBeVisible()
  await expect(row(page, id).getByTestId("archived-tag")).toHaveText("보관됨")
  await page.getByTestId("sidebar-search").press("Escape")
  await expect(row(page, id)).toHaveCount(0)
  expect(errors).toEqual([])
})

test("keyboard: Shift+F10 on a row opens its menu, arrows move, Esc closes and gives focus back (11)", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "키보드 메뉴")
  await row(page, id).focus()
  await page.keyboard.press("Shift+F10")
  const popup = page.getByTestId("row-menu")
  await expect(popup).toBeVisible()
  // The first item is 분할해서 열기 where the window can split (03 §4.1.1).
  await expect(popup.getByTestId("row-open-beside")).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(popup.getByTestId("row-pin")).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(popup.getByTestId("row-archive")).toBeFocused()
  await page.keyboard.press("End")
  await expect(popup.getByTestId("row-delete")).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(popup.getByTestId("row-copy-id")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(popup).toBeHidden()
  await expect(row(page, id)).toBeFocused()
  // Right click opens the same menu instead of the browser's.
  await row(page, id).click({ button: "right" })
  await expect(popup).toBeVisible()
  await page.keyboard.press("Escape")
  expect(errors).toEqual([])
})

test("fork: the fork of a pinned, archived session starts with neither flag (01 §17.1 #27)", async ({ page }) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "포크 원본")
  await turn(page, "포크할 대화입니다")
  await menu(page, id, "row-pin")
  await menu(page, id, "row-archive")
  await expect
    .poll(async () => Object.keys(await metadata(page, id)).toSorted())
    .toEqual(["own.archived", "own.pinned"])
  const fork = await ux<string>(page, "fork", id)
  // Forks copy the parent's metadata; the sidebar clears the copied flags as soon as `session.forked` arrives.
  await expect.poll(async () => Object.keys(await metadata(page, fork)), { timeout: 15_000 }).toEqual([])
  expect(Object.keys(await metadata(page, id)).toSorted()).toEqual(["own.archived", "own.pinned"])
  await page.reload()
  await expect(row(page, fork)).toBeVisible()
  expect(await pinnedTitles(page)).not.toContain(await ux<string>(page, "title", fork))
  await expect(row(page, id)).toHaveCount(0)
  // Put the original back (clears both flags; the other keys stay untouched).
  await page.evaluate(
    ([sessionID]) =>
      fetch(`/api/session/${sessionID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      }),
    [id],
  )
  await expect(row(page, id)).toBeVisible()
  expect(errors).toEqual([])
})

test("session id search: a pasted id or link finds the session (19.11)", async ({ page }) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "아이디로 찾기")
  const search = page.getByTestId("sidebar-search")
  await search.fill(`http://127.0.0.1:5173/srv/local/s/${id}`)
  await expect(list(page).getByTestId("session-row")).toHaveCount(1)
  await expect(row(page, id)).toBeVisible()
  await search.fill(id)
  await expect(list(page).getByTestId("session-row")).toHaveCount(1)
  await search.press("Escape")
  expect(errors).toEqual([])
})

test("screenshots: 고정됨 and the row menu in dark (default) and light", async ({ page }) => {
  await openHarness(page)
  const id = await createSession(page, "스크린샷 고정")
  await menu(page, id, "row-pin")
  for (const scheme of ["dark", "light"] as const) {
    await ux(page, "setScheme", scheme)
    await expect.poll(() => ux(page, "scheme")).toBe(scheme)
    await row(page, id).hover()
    await menuButton(page, id).click()
    await expect(page.getByTestId("row-menu")).toBeVisible()
    await page.screenshot({ path: path.join(shots(), `sidebar-menu-${scheme}.png`) })
    await page.keyboard.press("Escape")
  }
  await ux(page, "setScheme", "dark")
  await menu(page, id, "row-pin")
})
