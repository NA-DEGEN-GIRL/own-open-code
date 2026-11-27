// 곁질문 (03 §4.4.2, 02 §9.7) against the real server with own.accounts and the fake Responses provider: `/btw` opens
// the side panel and asks at once while the conversation's turn keeps running, the answer streams in as markdown and
// never enters the conversation, a follow-up continues the thread, the palette and the history list reopen it, and
// `대화에 넣기` alone puts the question and answer into the conversation (queued behind the running turn).
import { expect, test, type APIRequestContext } from "@playwright/test"
import { backend, watchErrors } from "./support"

const state = backend()
const session = { id: "" }

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  const created = await request.post("/api/session", {
    data: {
      title: "곁질문 e2e",
      model: { providerID: state.account.providerID, id: state.model },
      location: { directory: state.workspace },
    },
  })
  expect(created.ok()).toBe(true)
  const info = (await created.json()) as { id?: string; data?: { id: string } }
  session.id = info.data?.id ?? info.id ?? ""
})

test.afterAll(async ({ request }) => {
  if (session.id) await request.delete(`/api/session/${session.id}`)
})

async function texts(request: APIRequestContext) {
  const response = await request.get(`/api/session/${session.id}/message`)
  if (!response.ok()) return ""
  return JSON.stringify(await response.json())
}

test("/btw asks beside a running turn, streams markdown, and stays out of the conversation", async ({ page, request }) => {
  const errors = watchErrors(page)
  await page.goto(`/srv/local/s/${session.id}`)
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  const composer = page.locator("#own-composer-input")
  await composer.fill("[slow 15000] 웹훅 재시도 횟수를 정리해 주세요")
  await composer.press("Control+Enter")
  await expect(page.getByTestId("composer-stop")).toBeVisible()

  await composer.fill("/btw 재시도는 몇 번이야?")
  await composer.press("Control+Enter")
  const panel = page.getByTestId("side-panel")
  await expect(panel).toBeVisible()
  // The composer is free again (the /btw text went to the panel) and the main turn still runs.
  await expect(composer).toHaveValue("")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await expect(panel.getByTestId("side-turn")).toHaveCount(1)
  await expect(panel.getByText("재시도는 몇 번이야?")).toBeVisible()
  await expect(panel.getByTestId("side-answer")).toContainText("재시도는 세 번", { timeout: 15_000 })
  // Markdown, rendered like the transcript.
  await expect(panel.getByTestId("side-answer").locator("strong")).toHaveText("재시도는 세 번")
  await expect(panel.getByTestId("side-copy")).toBeVisible()
  await expect(page.getByTestId("composer-stop")).toBeVisible()

  // A follow-up in the same thread.
  await panel.getByTestId("side-input").fill("이어서 묻기: 간격은?")
  await panel.getByTestId("side-input").press("Enter")
  await expect(panel.getByTestId("side-turn")).toHaveCount(2)
  await expect(panel.getByTestId("side-answer").nth(1)).toContainText("이어진 곁질문 답이에요", { timeout: 15_000 })

  // Nothing of it reached the conversation, during or after the turn.
  expect(await texts(request)).not.toContain("재시도는 몇 번이야?")
  await panel.getByTestId("side-close").click()
  await expect(panel).toBeHidden()
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  const after = await texts(request)
  expect(after).not.toContain("재시도는 몇 번이야?")
  expect(after).not.toContain("곁질문 답이에요")
  expect(after).not.toContain("side-question")
  expect(errors.filter((error) => !/Failed to load resource|ERR_FAILED|net::/.test(error))).toEqual([])
})

test("the palette reopens the panel, the list shows the thread, and 대화에 넣기 sends it as a message", async ({
  page,
  request,
}) => {
  await page.goto(`/srv/local/s/${session.id}`)
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  await page.keyboard.press("Control+K")
  await page.keyboard.type("곁질문")
  await page.getByRole("option", { name: /곁질문/ }).first().click()
  const panel = page.getByTestId("side-panel")
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId("side-input")).toBeFocused()
  await panel.getByTestId("side-history").click()
  await expect(panel.getByTestId("side-list")).toContainText("재시도는 몇 번이야?")
  await panel.getByTestId("side-list-open").first().click()
  await expect(panel.getByTestId("side-turn")).toHaveCount(2)
  await panel.getByTestId("side-insert").first().click()
  await expect(page.getByText("대화에 넣었어요")).toBeVisible()
  await expect.poll(() => texts(request), { timeout: 30_000 }).toContain("곁질문으로 물어본 것: 재시도는 몇 번이야?")
  // Esc closes it and the composer keeps what was typed there.
  await page.locator("#own-composer-input").fill("보낼 초안")
  await panel.getByTestId("side-input").focus()
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()
  await expect(page.locator("#own-composer-input")).toHaveValue("보낼 초안")
})

test("on a phone-sized window the conversation ⋯ opens the panel as a sheet from the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 384, height: 742 })
  await page.goto(`/srv/local/s/${session.id}`)
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  await page.getByTestId("session-menu").first().click()
  await page.getByTestId("session-menu-side").click()
  const panel = page.getByTestId("side-panel")
  await expect(panel).toBeVisible()
  const box = await panel.boundingBox()
  expect(box?.x).toBe(0)
  expect(Math.round(box?.width ?? 0)).toBe(384)
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(742)
  await expect(panel.getByTestId("side-input")).toBeInViewport()
  await panel.getByTestId("side-close").click()
  await expect(panel).toBeHidden()
})