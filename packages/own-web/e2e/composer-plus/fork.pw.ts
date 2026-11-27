// Fork and manual compaction against the real server (03 §19.12, 02 §5.9(e), 01 §17.1 #27): `이 메시지에서 포크…`
// lists the user messages newest first with the cache note; forking before a message copies only the history before
// it, puts that message into the new session's composer and clears the pin flag the fork inherited; `포크` copies
// everything. `지금 압축` and `/compact` show `압축 중…` until the compaction ends; a refused compaction shows the
// failure banner with the server's reason, `다시 시도` and `닫기`.
import { expect, test, type Page } from "@playwright/test"
import { backend, messages, newSession, openHarness, sessionInfo, sessionRoute } from "./support"

test.describe.configure({ mode: "serial" })

const routeSession = (page: Page) =>
  page.evaluate(() => {
    const route = window.__composerPlus!.route()
    return route.name === "session" ? route.sessionID : undefined
  })

test("fork from a message: the history before it, the message back in the composer, the pin flag cleared", async ({
  page,
  request,
}) => {
  const parent = await newSession(request, "포크 e2e", ["첫 질문입니다", "두 번째 질문"])
  const pinned = await request.patch(`/api/session/${parent}`, {
    data: { metadata: { "own.pinned": true, "own.note": "메모" } },
  })
  expect(pinned.ok()).toBe(true)
  const textarea = await openHarness(page, sessionRoute(parent))
  await page.getByTestId("menu-forkFrom").click()
  const dialog = page.getByTestId("fork-dialog")
  await expect(dialog).toBeVisible()
  const rows = dialog.getByTestId("fork-option")
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("두 번째 질문")
  await expect(rows.first()).toHaveAttribute("aria-selected", "true")
  await expect(dialog.getByTestId("fork-note-cache")).toContainText("캐시 키를 물려받아요")
  const search = page.getByTestId("fork-search")
  await expect(search).toBeFocused()
  await search.press("ArrowDown")
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true")
  await search.press("ArrowUp")
  await search.press("Enter")
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => routeSession(page)).not.toBe(parent)
  const forked = (await routeSession(page))!
  await expect(textarea).toHaveValue("두 번째 질문")
  await expect(page.getByText("포크했어요 · 원 대화는 그대로예요")).toBeVisible()

  const info = await sessionInfo(request, forked)
  expect(info.fork?.sessionID).toBe(parent)
  await expect.poll(async () => (await sessionInfo(request, forked)).metadata ?? {}).toEqual({ "own.note": "메모" })
  expect((await sessionInfo(request, parent)).metadata?.["own.pinned"]).toBe(true)
  const users = (await messages(request, forked)).filter((message) => message.type === "user")
  expect(users.map((message) => message.text)).toEqual(["첫 질문입니다"])
  expect((await messages(request, parent)).filter((message) => message.type === "user").length).toBe(2)
})

test("포크 copies the whole history and opens the fork", async ({ page, request }) => {
  const parent = await newSession(request, "포크 e2e 전체", ["하나", "둘"])
  const textarea = await openHarness(page, sessionRoute(parent))
  await page.getByTestId("menu-fork").click()
  await expect.poll(() => routeSession(page)).not.toBe(parent)
  const forked = (await routeSession(page))!
  await expect(textarea).toHaveValue("")
  await expect
    .poll(async () => (await messages(request, forked)).filter((message) => message.type === "user").length)
    .toBe(2)
  // `전체 복제` in the dialog is the same.
  await page.getByTestId("menu-forkFrom").click()
  await page.getByTestId("fork-all").click()
  await expect.poll(() => routeSession(page)).not.toBe(forked)
  expect((await sessionInfo(request, (await routeSession(page))!)).fork?.sessionID).toBe(forked)
})

test("/compact and 지금 압축 show 압축 중… until the compaction ends; the server's refusal shows its reason", async ({
  page,
  request,
}) => {
  const sessionID = await newSession(request, "압축 e2e", ["첫 질문입니다"])
  const textarea = await openHarness(page, sessionRoute(sessionID))
  const status = page.getByTestId("compaction-status")
  const compactions = async () =>
    (await messages(request, sessionID)).filter(
      (message) => message.type === "compaction" && message.status !== "failed",
    ).length
  await textarea.pressSequentially("/compact")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect(status).toBeVisible()
  await expect(status).toHaveAttribute("data-phase", "running")
  await expect(status).toContainText("압축 중…")
  await expect(status).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(compactions).toBe(1)

  // Nothing new since: core refuses, the banner says why.
  await page.getByTestId("menu-compact").click()
  const banner = page.getByTestId("compaction-failed")
  await expect(banner).toContainText("Nothing to compact yet")
  await banner.getByTestId("compaction-dismiss").click()
  await expect(banner).toHaveCount(0)

  await textarea.pressSequentially("다음 질문")
  await textarea.press("Enter")
  await expect
    .poll(async () => (await messages(request, sessionID)).filter((m) => m.type === "assistant").length)
    .toBe(2)
  await request.post(`/api/experimental/session/${sessionID}/wait`)
  await page.getByTestId("menu-compact").click()
  await expect(status).toContainText("압축 중…")
  await expect(status).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(compactions).toBe(2)
})

test("a refused compaction shows the failure banner with the reason, retry and dismiss", async ({ page, request }) => {
  const sessionID = await newSession(request, "압축 실패 e2e", [`${backend().failMark} 질문입니다`])
  await openHarness(page, sessionRoute(sessionID))
  await page.getByTestId("menu-compact").click()
  const banner = page.getByTestId("compaction-failed")
  await expect(banner).toBeVisible()
  await expect(banner).toHaveAttribute("role", "alert")
  await expect(banner).toContainText("압축하지 못했어요")
  await expect(banner).toContainText("fake: compaction refused")
  await banner.getByTestId("compaction-retry").click()
  await expect
    .poll(async () => (await messages(request, sessionID)).filter((message) => message.type === "compaction").length)
    .toBe(2)
  await expect(banner).toContainText("fake: compaction refused")
  await expect(banner).toBeVisible()
  await banner.getByTestId("compaction-dismiss").click()
  await expect(banner).toHaveCount(0)
})
