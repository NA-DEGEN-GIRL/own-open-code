// `/` commands against the real server (03 §18.13): the two groups from `GET /api/command` (built-ins, a user command,
// an MCP prompt) and the client list, argument hints, server commands through `POST /session/:id/command`, and every
// client command end to end (/compact, /agent, /undo, /redo, /fork, /export, /review, /terminal, /model, /new).
import fs from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { messages, newSession, openHarness, options, sessionInfo } from "./support"

test.describe.configure({ mode: "serial" })

async function lastUser(page: Page, sessionID: string) {
  return (await messages(page.request, sessionID)).findLast((message) => message.type === "user")
}

test("the list shows server commands (built-ins, user, MCP) then client commands", async ({ page, request }) => {
  const sessionID = await newSession(request, "명령 e2e 목록")
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/")
  const list = page.getByTestId("suggest-list")
  await expect(list.locator('[data-group="server"]')).toContainText("/docs:summarize")
  const server = await list.locator('[data-group="server"] .own-sg-label').allTextContents()
  // `/goal` is core's own command since upstream v2.2 (#59437).
  expect(server).toEqual(["/init", "/review", "/docs:summarize", "/goal", "/hello"])
  await expect(list.locator('[data-id="server:docs:summarize"]')).toContainText("MCP")
  await expect(list.locator('[data-id="server:hello"]')).toContainText("사용자")
  await expect(list.locator('[data-id="server:review"]')).toContainText("[commit|branch|pr]")
  const client = await list.locator('[data-group="client"] .own-sg-label').allTextContents()
  expect(client).toEqual([
    "/new",
    "/model",
    "/agent",
    // 곁질문 (BTW, 2.2.6-own.18): a client command.
    "/btw",
    "/compact",
    "/reset-context",
    "/fork",
    "/undo",
    "/export",
    "/skills",
    "/terminal",
  ])
  await expect(list.locator('[data-id="client:undo"]')).toContainText("마지막 턴 복원(파일 포함)")
})

test("a user command: choose, see the hint, type the argument, Enter runs it on the server", async ({
  page,
  request,
}) => {
  const sessionID = await newSession(request, "명령 e2e hello")
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/hel")
  await expect(options(page).first()).toContainText("/hello")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("/hello ")
  await expect(page.getByTestId("suggest-note")).toHaveText("인자: <name>")
  await textarea.pressSequentially("세계")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect.poll(async () => (await lastUser(page, sessionID))?.text).toBe("Say hello to 세계")
  expect(await page.evaluate(() => window.__harness!.sent.at(-1))).toEqual({ text: "/hello 세계", result: "command" })
})

test("an MCP prompt and /init run as server commands", async ({ page, request }) => {
  const sessionID = await newSession(request, "명령 e2e mcp")
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/docs:summarize 릴리스 일정")
  await textarea.press("Enter")
  await expect.poll(async () => (await lastUser(page, sessionID))?.text).toBe("Summarize for the team: 릴리스")
  await textarea.pressSequentially("/init")
  await expect(options(page).first()).toContainText("/init")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("/init ")
  await textarea.press("Enter")
  await expect.poll(async () => (await lastUser(page, sessionID))?.text ?? "").toContain("AGENTS.md")
})

test("/compact from the list compacts the session", async ({ page, request }) => {
  const sessionID = await newSession(request, "명령 e2e compact", true)
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/comp")
  await expect(options(page).first()).toContainText("/compact")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect(page.getByText("압축을 요청했어요")).toBeVisible()
  await expect
    .poll(async () => (await messages(request, sessionID)).some((message) => message.type === "compaction"))
    .toBe(true)
})

test("/agent lists primary agents with the cache note and switches only the agent", async ({ page, request }) => {
  const sessionID = await newSession(request, "명령 e2e agent")
  const before = await sessionInfo(request, sessionID)
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/agent ")
  const list = page.getByTestId("suggest-list")
  await expect(list.locator('[data-group="agent-arguments"]')).toContainText("plan")
  await expect(page.getByTestId("suggest-note")).toHaveText(
    "에이전트마다 도구 권한이 달라 다음 요청에서 캐시를 새로 쓸 수 있어요",
  )
  await expect(list).not.toContainText("explore")
  await textarea.pressSequentially("pla")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect.poll(async () => (await sessionInfo(request, sessionID)).agent).toBe("plan")
  expect(JSON.stringify(((await sessionInfo(request, sessionID)) as { model?: unknown }).model)).toBe(
    JSON.stringify((before as { model?: unknown }).model),
  )
})

test("/undo stages the last turn with files and gives its text back; /redo cancels the restore", async ({
  page,
  request,
}) => {
  const sessionID = await newSession(request, "명령 e2e undo", true)
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/undo")
  await textarea.press("Enter")
  await expect.poll(async () => (await sessionInfo(request, sessionID)).revert?.messageID).toBeTruthy()
  await expect(textarea).toHaveValue("첫 질문입니다")
  await expect(page.getByText("마지막 턴을 복원했어요", { exact: false })).toBeVisible()
  await textarea.fill("")
  await textarea.pressSequentially("/red")
  await expect(options(page).first()).toContainText("/redo")
  await textarea.press("Enter")
  await expect.poll(async () => (await sessionInfo(request, sessionID)).revert).toBeUndefined()
})

test("/fork moves to the fork, /export downloads JSON, typed commands without the list work too", async ({
  page,
  request,
}) => {
  const sessionID = await newSession(request, "명령 e2e fork", true)
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  const download = page.waitForEvent("download")
  await textarea.fill("/export")
  await textarea.press("Escape")
  await textarea.press("Enter")
  const file = await download
  expect(file.suggestedFilename()).toMatch(/\.json$/)
  // Let the download finish before moving on (closing the context mid-download ends the browser).
  const exported = JSON.parse(fs.readFileSync((await file.path())!, "utf8")) as { info?: { id?: string } }
  expect(exported.info?.id).toBe(sessionID)
  await expect(textarea).toHaveValue("")
  await textarea.pressSequentially("/fork")
  await textarea.press("Enter")
  await expect.poll(async () => page.evaluate(() => JSON.stringify(window.__harness!.route()))).not.toContain(sessionID)
  const route = (await page.evaluate(() => window.__harness!.route())) as { name: string; sessionID?: string }
  expect(route.name).toBe("session")
  expect((await sessionInfo(request, route.sessionID!)).fork).toBeTruthy()
})

test("/review runs the server review, then opens the review tab; /terminal, /model, /new", async ({
  page,
  request,
}) => {
  const sessionID = await newSession(request, "명령 e2e review")
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/review")
  await textarea.press("Escape")
  await textarea.pressSequentially(" main")
  await textarea.press("Enter")
  // The box clears on the next frame (03 §12 rule 7); type again only after that.
  await expect(textarea).toHaveValue("")
  await expect.poll(async () => (await lastUser(page, sessionID))?.text ?? "").toContain("main")
  await expect.poll(async () => page.evaluate(() => window.__harness!.panel())).toEqual({ tab: "review", open: true })
  await textarea.pressSequentially("/term")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect.poll(async () => page.evaluate(() => window.__harness!.panel().tab)).toBe("terminal")
  await textarea.pressSequentially("/model")
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect.poll(async () => page.evaluate(() => window.__harness!.switcherOpen())).toBe(true)
  await textarea.focus()
  await textarea.pressSequentially("/new")
  await textarea.press("Enter")
  await expect.poll(async () => page.evaluate(() => window.__harness!.route().name)).toBe("project")
})

test("text that only looks like a command is a prompt", async ({ page, request }) => {
  const sessionID = await newSession(request, "명령 e2e 경로")
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("/tmp/build.log 봐줘")
  await textarea.press("Enter")
  await expect.poll(async () => (await lastUser(page, sessionID))?.text).toBe("/tmp/build.log 봐줘")
})
