import { expect, test, type APIRequestContext } from "@playwright/test"
import { Notes } from "@own/protocol/notes"
import { backend } from "./support"

const state = backend()

async function rpc(request: APIRequestContext, method: string, input: unknown) {
  const response = await request.post(`/api/rpc/own.accounts/${method}`, {
    data: { input },
    params: { "location[directory]": state.control },
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

test("settings returns to the same chat, and workspace notebooks are kept on the PC for every device", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000)
  // The backend is shared by the suite and idea-notes moves an idea into this project's notes: start from an empty
  // notebook.
  const workspace = Notes.workspaceKey({ directory: state.workspace })
  const listed = (await rpc(page.request, "notes.list", { workspace })) as { notes?: { id: string }[] }
  for (const note of listed.notes ?? []) await rpc(page.request, "notes.remove", { workspace, id: note.id })
  await page.goto(`/srv/local/s/${state.sessions[0]!.id}`)
  await expect(page.getByTestId("header-title")).toHaveText(state.sessions[0]!.title, { timeout: 60_000 })
  const composer = page.locator("#own-composer-input")
  await composer.fill("설정에서 돌아와도 유지되는 초안")
  await page.getByTestId("sidebar-settings").click()
  await expect(page.getByTestId("page-settings")).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("return-to-chat").click()
  await expect(page).toHaveURL(new RegExp(`/srv/local/s/${state.sessions[0]!.id}$`))
  await expect(composer).toHaveValue("설정에서 돌아와도 유지되는 초안")

  // A project's notes live on this PC's service (own.accounts notes.*, 02 §9.2), not in the browser.
  await page.getByTestId("workspace-notes-toggle").click()
  const notes = page.getByTestId("workspace-notes")
  const status = notes.getByTestId("note-save-status")
  await expect(notes).toBeVisible({ timeout: 60_000 })
  await expect(notes).toHaveAttribute("data-synced", "")
  await notes.getByLabel("노트 제목").fill("작업 계획")
  await notes.getByLabel("노트 내용").fill("첫 번째 메모\n한글 입력")
  await expect(status).toHaveText("PC에 저장됨")
  await notes.getByTestId("note-add").click()
  await notes.getByLabel("노트 제목").fill("참고")
  await notes.getByLabel("노트 내용").fill("두 번째 메모")
  await expect(status).toHaveText("PC에 저장됨")
  await notes.getByRole("tab", { name: "작업 계획" }).click()
  await expect(notes.getByLabel("노트 내용")).toHaveValue("첫 번째 메모\n한글 입력")
  const stored = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => (localStorage.getItem(key) ?? "").includes("첫 번째 메모")),
  )
  expect(stored).toEqual([])

  // Another device (a browser profile of its own) reads the same notes, and its edit reaches this window.
  const device = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: "ko-KR" })
  const phone = await device.newPage()
  await phone.goto(`/srv/local/s/${state.sessions[0]!.id}`)
  await expect(phone.getByTestId("header-title")).toHaveText(state.sessions[0]!.title, { timeout: 60_000 })
  await phone.getByTestId("workspace-notes-toggle").click()
  const remote = phone.getByTestId("workspace-notes")
  await expect(remote.getByLabel("저장된 노트 열기").locator("option")).toHaveText([
    "저장된 노트 (2)",
    "작업 계획",
    "참고",
  ])
  await remote.getByLabel("저장된 노트 열기").selectOption({ label: "참고" })
  await expect(remote.getByLabel("노트 내용")).toHaveValue("두 번째 메모")
  await remote.getByLabel("노트 내용").fill("두 번째 메모\n다른 기기에서 고침")
  await expect(remote.getByTestId("note-save-status")).toHaveText("PC에 저장됨")
  await device.close()
  await notes.getByRole("tab", { name: "참고" }).click()
  await expect(notes.getByLabel("노트 내용")).toHaveValue("두 번째 메모\n다른 기기에서 고침")

  // A save the PC did not get says so, and goes out again on retry.
  await page.route("**/api/rpc/own.accounts/notes.put**", (route) => route.abort())
  await notes.getByLabel("노트 내용").fill("두 번째 메모\n연결이 끊긴 동안")
  await expect(status).toHaveText("저장 실패")
  await page.unroute("**/api/rpc/own.accounts/notes.put**")
  await notes.getByRole("button", { name: "다시 저장" }).click()
  await expect(status).toHaveText("PC에 저장됨")
  await notes.getByRole("tab", { name: "작업 계획" }).click()
  await expect(notes.getByLabel("노트 내용")).toHaveValue("첫 번째 메모\n한글 입력")

  await page.getByLabel("노트 위치").selectOption("main")
  await expect(composer).toBeHidden()
  await page.getByRole("tab", { name: "대화", exact: true }).click()
  await expect(composer).toBeVisible()
  await page.getByRole("tab", { name: "노트", exact: true }).click()
  await expect(notes.getByLabel("노트 내용")).toHaveValue("첫 번째 메모\n한글 입력")
  await page.getByLabel("노트 위치").selectOption("left")
  await expect(composer).toBeVisible()
  await expect(page.locator(".own-workspace-body")).toHaveAttribute("data-notes", "left")
  await page.getByRole("separator", { name: "노트 폭" }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("separator", { name: "노트 폭" })).toHaveAttribute("aria-valuenow", /\d+/)
  const savedWidth = await page.getByRole("separator", { name: "노트 폭" }).getAttribute("aria-valuenow")
  await page.screenshot({ path: "e2e/test-results/workspace-notes.png" })
  await page.reload()
  await expect(page.locator(".own-workspace-body")).toHaveAttribute("data-notes", "left")
  await expect(page.getByLabel("노트 내용")).toHaveValue("첫 번째 메모\n한글 입력")
  await expect(page.getByRole("separator", { name: "노트 폭" })).toHaveAttribute("aria-valuenow", savedWidth!)

  // A bottom terminal opened from the notes tab must reveal Chat, and pause again when switching away.
  await page.getByTestId("sidebar-settings").click()
  await page.getByRole("link", { name: "화면 배치", exact: true }).click()
  await page.getByRole("radio", { name: "대화 아래", exact: true }).click()
  await page.getByTestId("return-to-chat").click()
  await page.getByLabel("노트 위치").selectOption("main")
  await page.keyboard.press("Control+Backquote")
  await expect(page.getByRole("tab", { name: "대화", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("terminal-dock")).toBeVisible({ timeout: 60_000 })
  await page.getByRole("tab", { name: "노트", exact: true }).click()
  await expect(page.getByTestId("terminal-dock")).toHaveAttribute("inert", "")
  await page.keyboard.press("Control+Backquote")
  await expect(page.getByTestId("terminal-dock")).toBeVisible()
})
