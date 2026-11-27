// 03 §19.13 find in session on the real transcript (fixture sessions, e2e/session-ux/find-harness.tsx): Ctrl+F, a
// Korean query typed through a real CDP composition, the search in a worker, the start match near the view, jumps to
// a far match through the virtualized list (2,000 messages), highlights of mounted matches (CSS Custom Highlight API),
// Enter / Shift+Enter, live updates while an answer streams, older pages on demand, Esc, message navigation
// (Ctrl+Alt+[ / ]), and input latency while the index is large (PF2).
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { pageErrors, shots } from "./support"

test.describe.configure({ mode: "serial" })

const SCROLLER = '[data-testid="transcript-body"][data-session-id="SESSION"] .scroll-view__viewport'

async function openFind(page: Page, sessionID = "ses_find", query = "") {
  const errors = pageErrors(page)
  const workers: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("find.worker")) workers.push(request.url())
  })
  await page.goto(`/e2e/session-ux/find-harness.html${query}`)
  await page.evaluate((id) => (window as unknown as { __find: { open(id: string): void } }).__find.open(id), sessionID)
  await expect(page.locator(`${SCROLLER.replace("SESSION", sessionID)} [data-message-id]`).first()).toBeVisible()
  return { errors, workers }
}

/** The active highlight: how many ranges, their text, and whether the first is inside the scroll view. */
function activeHighlight(page: Page, sessionID = "ses_find") {
  return page.evaluate(
    (selector) => {
      const highlight = CSS.highlights.get("own-find-active")
      const ranges = highlight ? ([...highlight] as Range[]) : []
      const scroller = document.querySelector<HTMLElement>(selector)
      const range = ranges[0]
      if (!range || !scroller) return { count: ranges.length, text: "", inView: false }
      const rect = range.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      return {
        count: ranges.length,
        text: range.toString(),
        inView: rect.height > 0 && rect.top >= view.top && rect.bottom <= view.bottom,
      }
    },
    SCROLLER.replace("SESSION", sessionID),
  )
}

function hitCount(page: Page) {
  return page.evaluate(() => CSS.highlights.get("own-find-hit")?.size ?? 0)
}

/** The turn (`data-message-id`) nearest the top of the scroll view. */
function topTurn(page: Page, sessionID = "ses_find") {
  return page.evaluate(
    (selector) => {
      const scroller = document.querySelector<HTMLElement>(selector)!
      const view = scroller.getBoundingClientRect()
      let best: { id: string; top: number } | undefined
      for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const rect = row.getBoundingClientRect()
        if (rect.bottom <= view.top + 8 || rect.top >= view.bottom) continue
        if (!best || rect.top < best.top) best = { id: row.dataset.messageId!, top: rect.top }
      }
      return best?.id
    },
    SCROLLER.replace("SESSION", sessionID),
  )
}

/** The row that starts `turn` sits at the top of the scroll view. */
function startAtTop(page: Page, turn: string, sessionID = "ses_find") {
  return page.evaluate(
    ([selector, id]) => {
      const scroller = document.querySelector<HTMLElement>(selector)!
      const row = scroller.querySelector<HTMLElement>(
        `[data-message-id="${id}"][data-timeline-row="UserMessage"], [data-message-id="${id}"][data-timeline-row="Shell"]`,
      )
      if (!row) return false
      const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      return offset >= 0 && offset <= 24
    },
    [SCROLLER.replace("SESSION", sessionID), turn] as const,
  )
}

test("Ctrl+F, Korean composition, worker search, far jumps through 2,000 messages, Enter / Shift+Enter, Esc", async ({
  page,
}) => {
  const { errors, workers } = await openFind(page)
  await page.getByTestId("harness-input").focus()
  await page.keyboard.press("Control+F")
  const input = page.getByTestId("find-input")
  await expect(input).toBeFocused()

  // Results follow the composition (rule 5: the input itself is never rewritten).
  const cdp = await page.context().newCDPSession(page)
  for (const text of ["ㅍ", "파", "파인", "파인애", "파인애플"])
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length })
  await expect(page.getByTestId("find-count")).toHaveText("2/2")
  // The Enter that commits the composition only commits (12 rule 8, result lists).
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await cdp.send("Input.insertText", { text: "파인애플" })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await expect(input).toHaveValue("파인애플")
  await page.waitForTimeout(150)
  await expect(page.getByTestId("find-count")).toHaveText("2/2")
  expect(workers.length).toBeGreaterThan(0)

  // Started at the match nearest the view (the tail): turn 390's answer, highlighted and in view.
  await expect.poll(() => activeHighlight(page)).toMatchObject({ count: 1, text: "파인애플", inView: true })
  await expect(page.getByTestId("find-status")).toHaveText("결과 2개 중 2번째")

  // Enter: next match wraps to turn 3, almost 2,000 messages up the virtual list.
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("find-count")).toHaveText("1/2")
  await expect.poll(() => activeHighlight(page), { timeout: 15_000 }).toMatchObject({ count: 1, inView: true })
  await expect.poll(() => topTurn(page)).toMatch(/^msg_find_0000(0|1)\d$/)
  await page.screenshot({ path: path.join(shots(), "find-far-dark.png") })

  // Shift+Enter goes back down to turn 390.
  await page.keyboard.press("Shift+Enter")
  await expect(page.getByTestId("find-count")).toHaveText("2/2")
  await expect.poll(() => activeHighlight(page), { timeout: 15_000 }).toMatchObject({ count: 1, inView: true })

  // Esc closes, clears the highlights and gives focus back.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("find-bar")).toHaveCount(0)
  expect(await hitCount(page)).toBe(0)
  expect((await activeHighlight(page)).count).toBe(0)
  await expect(page.getByTestId("harness-input")).toBeFocused()

  // Ctrl+F again reopens with the last query selected.
  await page.keyboard.press("Control+F")
  await expect(input).toHaveValue("파인애플")
  expect(
    await input.evaluate((element: HTMLInputElement) => (element.selectionEnd ?? 0) - (element.selectionStart ?? 0)),
  ).toBe(4)
  expect(errors).toEqual([])
})

test("no match, a single match, and an answer streaming in adds a match live", async ({ page }) => {
  const { errors } = await openFind(page)
  await page.keyboard.press("Control+F")
  const input = page.getByTestId("find-input")
  await input.fill("없는단어xyz")
  await expect(page.getByTestId("find-count")).toHaveText("결과 없음")
  await expect(page.getByTestId("find-next")).toBeDisabled()
  await input.fill("망고스틴")
  await expect(page.getByTestId("find-count")).toHaveText("1/1")
  await expect.poll(() => activeHighlight(page), { timeout: 15_000 }).toMatchObject({ text: "망고스틴", inView: true })
  await page.evaluate(() =>
    (
      window as unknown as { __find: { stream(input: { sessionID: string; text: string }): Promise<void> } }
    ).__find.stream({ sessionID: "ses_find", text: "새 답변에도 망고스틴 이 나옵니다" }),
  )
  // The active match stays where it was; the count grows.
  await expect(page.getByTestId("find-count")).toHaveText("1/2")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("find-count")).toHaveText("2/2")
  await expect.poll(() => activeHighlight(page), { timeout: 15_000 }).toMatchObject({ text: "망고스틴", inView: true })
  expect(errors).toEqual([])
})

test("typing stays fast while the index holds 2,000 messages (PF2 spirit)", async ({ page }) => {
  await openFind(page)
  await page.keyboard.press("Control+F")
  await expect(page.getByTestId("find-input")).toBeFocused()
  const result = await page.evaluate(async (value) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="find-input"]')!
    const processing: number[] = []
    const display: number[] = []
    const record = (event: Event) => processing.push(performance.now() - event.timeStamp)
    window.addEventListener("input", record)
    for (const char of value) {
      input.value += char
      const event = new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" })
      input.dispatchEvent(event)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      display.push(performance.now() - event.timeStamp)
    }
    window.removeEventListener("input", record)
    const p95 = (list: number[]) => list.toSorted((a, b) => a - b)[Math.ceil(list.length * 0.95) - 1]!
    return { processing: p95(processing), display: p95(display), count: processing.length }
  }, "계정 라우터 전환 비용 switch estimate 요청")
  console.log(
    `find input: processing p95 ${result.processing.toFixed(2)} ms, input → second frame p95 ${result.display.toFixed(1)} ms over ${result.count} inputs`,
  )
  expect(result.processing).toBeLessThan(16)
  expect(result.display).toBeLessThan(50)
})

test("older messages on demand: with 30 loaded, 이전 기록에서 더 찾기 pages back until the match appears", async ({
  page,
}) => {
  const { errors } = await openFind(page, "ses_find", "?limit=30")
  await page.keyboard.press("Control+F")
  await page.getByTestId("find-input").fill("파인애플")
  await expect(page.getByTestId("find-count")).toHaveText("결과 없음")
  const older = page.getByTestId("find-older")
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await page.getByTestId("find-count").textContent()) !== "결과 없음") break
    await expect(older).toBeEnabled()
    await older.click()
    await page.waitForTimeout(300)
  }
  await expect(page.getByTestId("find-count")).toHaveText("1/1")
  expect(errors).toEqual([])
})

test("read 30 at a time: matches in pages the transcript dropped while scrolling stay found and are read again", async ({
  page,
}) => {
  test.setTimeout(240_000)
  const { errors } = await openFind(page, "ses_find", "?limit=30")
  await page.keyboard.press("Control+F")
  const input = page.getByTestId("find-input")
  await input.fill("파인애플")
  await expect(page.getByTestId("find-count")).toHaveText("결과 없음")
  // Up to the first turn with the bar open: turn 390's page is read, indexed and dropped on the way (history.ts).
  const scroller = page.locator(SCROLLER.replace("SESSION", "ses_find"))
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(async () => {
    await page.mouse.wheel(0, -15_000)
    await expect(scroller.getByText(/^1번째 요청/)).toBeVisible({ timeout: 200 })
  }).toPass({ timeout: 150_000, intervals: [0] })
  await expect(page.getByTestId("find-count")).toHaveText(/\/2$/)
  // Both matches are reached: the far one through its page read again.
  const reached = new Set<string>()
  for (let press = 0; press < 2; press++) {
    await input.focus()
    await page.keyboard.press("Enter")
    await expect.poll(() => activeHighlight(page), { timeout: 20_000 }).toMatchObject({ count: 1, inView: true })
    reached.add((await topTurn(page)) ?? "")
  }
  expect(reached.size).toBe(2)
  expect(errors).toEqual([])
})

test("Ctrl+Alt+[ / ] move between turns; the find bar and highlights in light and dark", async ({ page }) => {
  const { errors } = await openFind(page)
  const start = (await topTurn(page))!
  await page.getByTestId("harness-input").focus()
  // At the tail the top turn began above the view: the first press goes to its start, the next to the turn before.
  await page.keyboard.press("Control+Alt+BracketLeft")
  await expect.poll(() => startAtTop(page, start)).toBe(true)
  await page.keyboard.press("Control+Alt+BracketLeft")
  await expect.poll(async () => ((await topTurn(page)) ?? start) < start).toBe(true)
  const previous = (await topTurn(page))!
  await expect.poll(() => startAtTop(page, previous)).toBe(true)
  await page.keyboard.press("Control+Alt+BracketRight")
  await expect.poll(() => topTurn(page)).toBe(start)
  await expect.poll(() => startAtTop(page, start)).toBe(true)

  await page.keyboard.press("Control+F")
  await page.getByTestId("find-input").fill("라우터")
  await expect(page.getByTestId("find-count")).not.toHaveText("결과 없음")
  await expect.poll(() => hitCount(page)).toBeGreaterThan(0)
  for (const scheme of ["dark", "light"] as const) {
    await page.evaluate((value) => (window as unknown as { __scheme(scheme: string): void }).__scheme(value), scheme)
    await page.screenshot({ path: path.join(shots(), `find-bar-${scheme}.png`) })
  }
  expect(errors).toEqual([])
})
