// Review tab (03 §18.5, §4.7) in Edge against the real server (e2e/review/backend.ts). The harness mounts the tab
// module through the adapter composition (kit.tsx) exactly like the work panel: lazy chunk, `visible()`.
import { expect, test, type Page } from "@playwright/test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

interface ReviewBackend {
  readonly dev: string
  readonly workspace: string
  readonly inferred: string
  readonly plain: string
  readonly sessions: { readonly git: string; readonly fresh: string; readonly plain: string; readonly inferred: string }
}

const backend = (): ReviewBackend =>
  JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "own-web-review-e2e", "backend.json"), "utf8")) as ReviewBackend

async function open(page: Page, query: Record<string, string>) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`/e2e/review/harness.html?${new URLSearchParams(query)}`)
  return errors
}

const mode = (page: Page) => page.getByTestId("review-mode")
const rows = (page: Page) => page.locator("[data-testid=review-list] [role=option]")
const rowFiles = (page: Page) => rows(page).evaluateAll((items) => items.map((item) => item.getAttribute("data-file")))

/** Text of the pierre viewer (it renders into shadow roots). */
function diffText(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=review-preview] *")]
      .flatMap((element) => (element.shadowRoot ? [element.shadowRoot.textContent ?? ""] : []))
      .join("\n"),
  )
}

async function prompt(sessionID: string, directory: string, text: string) {
  const response = await fetch(`${backend().dev}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": encodeURIComponent(directory) },
    body: JSON.stringify({ text }),
  })
  expect(response.ok, await response.clone().text()).toBe(true)
}

test("right after a turn it opens on 마지막 턴; 커밋 안 된 변경 lists the working copy, large files trimmed in the worker", async ({
  page,
}) => {
  const state = backend()
  const workers: string[] = []
  page.on("worker", (worker) => workers.push(worker.url()))
  const errors = await open(page, { session: state.sessions.git })

  await expect(mode(page)).toHaveValue("lastTurn")
  await expect.poll(() => rowFiles(page)).toEqual(["src/turn.ts"])
  await expect(page.getByTestId("review-summary")).toContainText("변경 파일 1")
  await expect.poll(() => diffText(page)).toContain("written by the review e2e turn")

  await mode(page).selectOption("working")
  await expect
    .poll(() => rowFiles(page))
    .toEqual(["big/large.ts", "src/estimate.ts", "src/router.ts", "src/turn.ts", "test/router.test.ts"])
  await expect(page.getByTestId("review-summary")).toContainText("변경 파일 5")
  await expect(page.getByTestId("review-summary").locator(".own-review-stats")).toHaveAttribute(
    "aria-label",
    "추가된 줄 10, 삭제된 줄 5",
  )
  await expect(rows(page).filter({ hasText: "router.test.ts" }).locator(".own-review-status")).toHaveText(/^D/)
  await expect(rows(page).filter({ hasText: "estimate.ts" }).locator(".own-review-status")).toHaveText(/^A/)

  // The first file is the 6,000-line one: its full-context patch (~317 KB) is trimmed to hunks in the review worker.
  await expect(page.getByTestId("review-trimmed")).toBeVisible()
  await expect.poll(() => diffText(page)).toContain('value3000 = "changed"')
  expect(await diffText(page)).not.toContain("value1500 ")
  expect(workers.some((url) => url.includes("diff.worker"))).toBe(true)
  // pierre highlights in its own worker pool (20.2 R4).
  expect(workers.some((url) => url.includes("@pierre/diffs"))).toBe(true)
  expect(errors).toEqual([])
  await page.screenshot({ path: "e2e/test-results/review-working-420.png" })
})

test("file list: click and ↑/↓ drive the preview; split needs 560 px; the list folds", async ({ page }) => {
  const state = backend()
  await open(page, { session: state.sessions.git })
  await mode(page).selectOption("working")
  await rows(page).filter({ hasText: "estimate.ts" }).click()
  await expect(rows(page).filter({ hasText: "estimate.ts" })).toHaveAttribute("aria-selected", "true")
  await expect(page.locator("[data-slot=session-review-v2-file-name]")).toHaveText("estimate.ts")

  await page.getByTestId("review-list").focus()
  await page.keyboard.press("ArrowDown")
  await expect(page.locator("[data-slot=session-review-v2-file-name]")).toHaveText("router.ts")
  await expect.poll(() => diffText(page)).toContain('import { estimate } from "./estimate"')
  await page.keyboard.press("End")
  await expect(page.locator("[data-slot=session-review-v2-file-name]")).toHaveText("router.test.ts")
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("ArrowUp")
  await expect(page.locator("[data-slot=session-review-v2-file-name]")).toHaveText("router.ts")

  // 420 px panel: choosing 나란히 keeps the unified view and says why (4.7).
  const preview = page.getByTestId("review-preview")
  await expect(preview.locator("pre[data-diff-type=single]")).toBeVisible()
  await page.getByRole("radio", { name: "나란히" }).click()
  await expect(page.getByRole("radio", { name: "나란히" })).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("review-split-narrow")).toBeVisible()
  await expect(preview.locator("pre[data-diff-type=single]")).toBeVisible()
  await page.evaluate(() => window.__review.setWidth(900))
  await expect(preview.locator("pre[data-diff-type=split]")).toBeVisible()
  await expect(page.getByTestId("review-split-narrow")).toBeHidden()
  await page.screenshot({ path: "e2e/test-results/review-split-900.png" })
  await page.emulateMedia({ colorScheme: "dark" })
  await page.screenshot({ path: "e2e/test-results/review-split-900-dark.png" })
  await page.emulateMedia({ colorScheme: "light" })
  await page.getByRole("radio", { name: "한 줄로" }).click()
  await expect(preview.locator("pre[data-diff-type=single]")).toBeVisible()

  await page.getByTestId("review-list-toggle").click()
  await expect(page.getByTestId("review-list")).toBeHidden()
  await expect(page.getByTestId("review-list-toggle")).toHaveText("목록 펼치기")
  await page.getByTestId("review-list-toggle").click()
  await expect(page.getByTestId("review-list")).toBeVisible()

  // Opening the large file keeps the main thread free: trimming runs in the worker, highlighting in pierre's pool.
  await page.evaluate(() => {
    const store = { longest: 0 }
    ;(window as unknown as { __long: typeof store }).__long = store
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) store.longest = Math.max(store.longest, entry.duration)
    }).observe({ type: "longtask" })
  })
  await rows(page).filter({ hasText: "large.ts" }).click()
  await expect(page.getByTestId("review-trimmed")).toBeVisible()
  await expect.poll(() => diffText(page)).toContain('value5990 = "changed"')
  const longest = await page.evaluate(() => (window as unknown as { __long: { longest: number } }).__long.longest)
  console.log(`review: longest task while opening the 6,000-line diff: ${Math.round(longest)} ms`)
  expect(longest).toBeLessThan(200)
})

test("브랜치 대 base asks for a base when the history is ambiguous", async ({ page }) => {
  const state = backend()
  await open(page, { session: state.sessions.git })
  await mode(page).selectOption("branch")
  await expect(page.getByTestId("review-base-needed")).toHaveText("base를 고르세요")
  const base = page.getByTestId("review-base")
  await expect(base).toHaveValue("")
  await expect(base.locator("option[value=main]")).toHaveText("base: main")
  await expect(base.locator("option[value='feature/inferred']")).toHaveCount(1)
  await base.selectOption("main")
  await expect
    .poll(() => rowFiles(page))
    .toEqual([
      "big/large.ts",
      "src/estimate.ts",
      "src/feature.ts",
      "src/router.ts",
      "src/turn.ts",
      "src/util.ts",
      "test/router.test.ts",
    ])
  await expect(mode(page).locator("option[value=branch]")).toHaveText("브랜치 대 main")
})

test("an inferred base (branch created from main) is used without asking", async ({ page }) => {
  const state = backend()
  await open(page, { session: state.sessions.inferred })
  await expect(mode(page)).toHaveValue("working")
  await expect(page.getByTestId("review-empty")).toContainText("커밋 안 된 변경이 없어요")
  await mode(page).selectOption("branch")
  await expect(page.getByTestId("review-base")).toHaveValue("main")
  await expect.poll(() => rowFiles(page)).toEqual(["src/inferred.ts"])
})

test("a folder without Git offers only 마지막 턴 and 이 세션 전체, with the noVcs note and Git 저장소 만들기", async ({
  page,
}) => {
  const state = backend()
  await open(page, { session: state.sessions.plain })
  await expect(page.getByTestId("review-novcs")).toContainText(
    "이 폴더는 Git 저장소가 아니에요. 마지막 턴의 변경만 볼 수 있어요.",
  )
  await expect(mode(page)).toHaveValue("lastTurn")
  const values = () =>
    mode(page)
      .locator("option")
      .evaluateAll((items) => items.map((item) => item.getAttribute("value")))
  expect(await values()).toEqual(["lastTurn", "session"])
  await expect(page.getByTestId("review-empty")).toContainText("마지막 턴이 바꾼 파일이 없어요")

  // 18.5 (upstream 41516c78c8): `git init` in the project folder, then the Git modes appear without a reload.
  await page.getByTestId("review-git-init").click()
  await expect(page.getByTestId("review-novcs")).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(values, { timeout: 30_000 }).toContain("working")
  expect(fs.existsSync(path.join(state.plain, ".git"))).toBe(true)
})

test("lazy: the diff engine loads only when the tab opens, and a hidden tab fetches nothing", async ({ page }) => {
  const state = backend()
  const requests: string[] = []
  page.on("request", (request) => requests.push(request.url()))
  await open(page, { session: state.sessions.git, open: "0", hidden: "1" })
  // The event stream and Vite HMR stay open (no "networkidle"): wait for the harness, then a quiet second.
  await expect(page.getByTestId("panel")).toBeAttached()
  await page.waitForTimeout(1_000)
  const heavy = (url: string) => url.includes("session-review-v2") || url.includes("@pierre")
  const diffCalls = () =>
    requests.filter((url) => url.includes("/api/vcs/diff") || /\/api\/session\/[^/]+\/diff/.test(url))
  expect(requests.filter(heavy)).toEqual([])

  // Mounted while hidden (the panel keeps opened tabs mounted): the chunk loads, the server is not asked for diffs.
  await page.evaluate(() => window.__review.open())
  await expect.poll(() => requests.filter(heavy).length).toBeGreaterThan(0)
  await page.waitForTimeout(1_500)
  expect(diffCalls()).toEqual([])

  await page.evaluate(() => window.__review.setVisible(true))
  await expect.poll(() => rowFiles(page)).toEqual(["src/turn.ts"])
  expect(diffCalls()).toHaveLength(1)
})

test("turn ends: 마지막 턴 follows unless chosen, the badge waits while hidden, the footer link opens the turn", async ({
  page,
}) => {
  const state = backend()
  await open(page, { session: state.sessions.fresh })
  await expect(mode(page)).toHaveValue("working")
  await expect.poll(() => rowFiles(page)).toContain("src/turn.ts")

  // Not chosen by the user: a finished turn switches to 마지막 턴 (18.5 default "턴이 끝난 직후").
  await prompt(state.sessions.fresh, state.workspace, "REVIEW_WRITE:src/fresh-one.ts 만들기")
  await expect(mode(page)).toHaveValue("lastTurn", { timeout: 45_000 })
  await expect.poll(() => rowFiles(page)).toEqual(["src/fresh-one.ts"])
  await expect(page.getByTestId("badge")).toHaveText("")

  // Chosen by the user: the mode stays; with the tab hidden the badge counts the next turn's files.
  await mode(page).selectOption("working")
  await page.evaluate(() => window.__review.setVisible(false))
  await prompt(state.sessions.fresh, state.workspace, "REVIEW_WRITE:src/fresh-two.ts 만들기")
  await expect(page.getByTestId("badge")).toHaveText("1", { timeout: 45_000 })
  const link = page.getByTestId("review-footer-link")
  await expect(link).toHaveText("변경 1개 · 리뷰 →")
  await link.click()
  await expect(page.getByTestId("panel")).toBeVisible()
  await expect(mode(page)).toHaveValue("lastTurn")
  await expect.poll(() => rowFiles(page)).toEqual(["src/fresh-two.ts"])
  await expect(page.getByTestId("badge")).toHaveText("")

  // 이 세션 전체: the first turn through the last one.
  await mode(page).selectOption("session")
  await expect.poll(() => rowFiles(page)).toEqual(["src/fresh-one.ts", "src/fresh-two.ts"])
})
