// 03 §18.7 메시지 복원(revert)과 파일 복원, against the real server: the `이 지점으로 복원` dialog (turn count, files
// checkbox, cold-point estimate), stage with file restore (the written file disappears), the 복원 대기 띠 (turns, files,
// 변경 보기), the rewound message back in the composer, 복원 취소 (file back, draft cleared), 복원 확정 (messages gone),
// interrupting a running turn first, the queue sweep toast, /undo and /redo.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { createSession, idle, openHarness, ops, opsState, shots } from "./support"

const EDIT = [{ action: "edit", resource: "*", effect: "allow" as const }]

test.describe.configure({ mode: "serial" })

async function turn(page: Page, text: string) {
  await ops(page, "prompt", text)
  await expect(page.getByTestId("transcript")).toContainText(text.replace(/\[[^\]]+\]\s*/, ""))
  await idle(page)
  await admitted(page)
}

/**
 * /undo picks its boundary from user messages that are no longer in the inbox (revert/model.ts `userMessages`). On a
 * loaded machine the inbox update can trail the status event; wait for it so the boundary is the one the test means.
 */
async function admitted(page: Page) {
  await expect.poll(async () => (await ops<unknown[]>(page, "pending")).length).toBe(0)
}

test("stage with files → bar → 복원 취소 → stage again → 복원 확정", async ({ page }) => {
  const errors = await openHarness(page)
  const state = opsState()
  const file = `notes/revert-${Date.now()}.txt`
  const absolute = path.join(state.gitProject, file)
  await createSession(page, "복원 테스트", { permissions: EDIT, directory: state.gitProject })
  await turn(page, `[write ${file}] 메모 파일을 만들어 줘`)
  await expect.poll(async () => (fs.existsSync(absolute) ? true : JSON.stringify(await ops(page, "tools")))).toBe(true)
  await turn(page, "두 번째 질문입니다")

  // Dialog on the first user message: one turn after it, files on by default, the cold point with an estimate.
  await page.getByTestId("ops-revert").first().click()
  const dialog = page.getByTestId("revert-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("revert-dialog-body")).toHaveText("이 메시지와 그 뒤의 턴 1개를 되감아요.")
  await expect(dialog.getByTestId("revert-files")).toBeChecked()
  await expect(dialog.getByText("파일 변경도 되돌리기")).toBeVisible()
  await expect(dialog.getByTestId("revert-note-cold")).toContainText("캐시를 다시 쌓는 지점")
  await expect(dialog.getByTestId("revert-note-switch")).toHaveCount(0)
  await page.screenshot({ path: path.join(shots(), "revert-01-dialog.png") })
  await dialog.getByTestId("revert-confirm").click()
  await expect(dialog).toHaveCount(0)

  // Staged: the bar, the file is gone, the message text is back in the composer, later rows dimmed.
  const bar = page.getByTestId("revert-bar")
  await expect(bar).toBeVisible()
  await expect(bar.getByTestId("revert-bar-text")).toHaveText(
    "복원 대기: 이 메시지 뒤 턴 1개와 파일 변경 1개를 되돌렸어요",
  )
  await expect.poll(() => fs.existsSync(absolute)).toBe(false)
  await expect(page.getByTestId("ops-input")).toHaveValue(`[write ${file}] 메모 파일을 만들어 줘`)
  await expect(page.locator("[data-reverted]").first()).toBeAttached()
  await bar.getByTestId("revert-view").click()
  await expect(bar.getByTestId("revert-files-list")).toContainText(file.split("/").pop()!)
  await page.screenshot({ path: path.join(shots(), "revert-02-staged.png") })

  // 복원 취소: the file comes back, the untouched draft is cleared, the bar goes away.
  await bar.getByTestId("revert-clear").click()
  await expect(bar).toHaveCount(0)
  await expect.poll(() => fs.existsSync(absolute)).toBe(true)
  await expect(page.getByTestId("ops-input")).toHaveValue("")
  expect(await ops(page, "revert")).toBeUndefined()

  // Stage the second turn (without files) and commit: the rewound messages are deleted for good.
  const before = await ops<{ type: string }[]>(page, "messages")
  await page.getByTestId("ops-revert").nth(1).click()
  await expect(dialog.getByTestId("revert-dialog-body")).toHaveText("이 메시지와 그 답을 되감아요.")
  await dialog.getByTestId("revert-files").uncheck()
  await dialog.getByTestId("revert-confirm").click()
  await expect(bar.getByTestId("revert-bar-text")).toHaveText(
    "복원 대기: 이 메시지 뒤 턴 0개와 파일 변경 0개를 되돌렸어요",
  )
  await bar.getByTestId("revert-commit").click()
  await expect(bar).toHaveCount(0)
  await expect.poll(async () => (await ops<{ type: string }[]>(page, "messages")).length).toBeLessThan(before.length)
  await expect(page.getByTestId("toasts")).toContainText("복원을 확정했어요")
  expect(fs.existsSync(absolute)).toBe(true)
  expect(errors).toEqual([])
})

test("a running turn is interrupted first, and queued messages are swept", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "실행 중 복원")
  await turn(page, "첫 질문")
  await ops(page, "prompt", "[slow 40] 오래 걸리는 질문")
  await expect.poll(() => ops(page, "status")).toBe("running")
  const queuedID = await ops<string>(page, "prompt", "대기열 메시지", "queue")
  await expect(page.getByTestId("queue-row")).toHaveCount(1)

  // A prompt still in the inbox cannot be a boundary: the dialog says so and cannot confirm.
  await ops(page, "openRevert", queuedID)
  const dialog = page.getByTestId("revert-dialog")
  await expect(dialog.getByTestId("revert-note-pending")).toBeVisible()
  await expect(dialog.getByTestId("revert-confirm")).toBeDisabled()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)

  // The side list holds delivered messages only: 첫 질문, then the running one.
  await expect(page.getByTestId("ops-revert")).toHaveCount(2)
  await page.getByTestId("ops-revert").nth(1).click()
  await expect(dialog.getByTestId("revert-note-running")).toHaveText("실행 중인 턴을 먼저 중단해요.")
  await expect(dialog.getByTestId("revert-note-queue")).toContainText("대기 중인 메시지 1개")
  await expect(dialog.getByTestId("revert-confirm")).toHaveText("중단하고 복원")
  await page.screenshot({ path: path.join(shots(), "revert-03-running.png") })
  await dialog.getByTestId("revert-confirm").click()
  await expect(page.getByTestId("revert-bar")).toBeVisible()
  await expect(page.getByTestId("toasts")).toContainText("대기 중이던 메시지 1개를 취소했어요")
  await expect(page.getByTestId("queue-row")).toHaveCount(0)
  await expect.poll(() => ops(page, "status")).toBe("idle")
  expect(errors).toEqual([])
})

test("/undo moves the boundary back one turn at a time, /redo forward and clears at the end", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "undo redo")
  await turn(page, "하나")
  await turn(page, "둘")
  const users = async () =>
    (await ops<{ id: string; type: string; text: string }[]>(page, "messages"))
      .filter((message) => message.type === "user")
      .toSorted((a, b) => (a.id < b.id ? -1 : 1))
  const [first, second] = await users()
  expect([first?.text, second?.text]).toEqual(["하나", "둘"])

  expect(await ops(page, "undo")).toBe(true)
  await expect
    .poll(async () => (await ops<{ messageID: string } | undefined>(page, "revert"))?.messageID)
    .toBe(second!.id)
  await expect(page.getByTestId("ops-input")).toHaveValue("둘")
  expect(await ops(page, "undo")).toBe(true)
  await expect
    .poll(async () => (await ops<{ messageID: string } | undefined>(page, "revert"))?.messageID)
    .toBe(first!.id)
  expect(await ops(page, "undo")).toBe(false)
  await expect(page.getByTestId("toasts")).toContainText("복원할 턴이 없어요")

  expect(await ops(page, "redo")).toBe(true)
  await expect
    .poll(async () => (await ops<{ messageID: string } | undefined>(page, "revert"))?.messageID)
    .toBe(second!.id)
  expect(await ops(page, "redo")).toBe(true)
  await expect.poll(() => ops(page, "revert")).toBeUndefined()
  await expect(page.getByTestId("revert-bar")).toHaveCount(0)
  expect(errors).toEqual([])
})

test("/undo on a running session asks first: the dialog opens on the last turn with 중단하고 복원", async ({
  page,
}) => {
  const errors = await openHarness(page)
  await createSession(page, "실행 중 undo")
  await turn(page, "끝난 질문")
  await ops(page, "prompt", "[slow 40] 실행 중인 질문")
  await expect.poll(() => ops(page, "status")).toBe("running")
  await admitted(page)
  expect(await ops(page, "undo")).toBe(true)
  const dialog = page.getByTestId("revert-dialog")
  await expect(dialog.getByTestId("revert-confirm")).toHaveText("중단하고 복원")
  await expect(dialog.getByTestId("revert-dialog-body")).toHaveText("이 메시지와 그 답을 되감아요.")
  await dialog.getByTestId("revert-confirm").click()
  await expect(page.getByTestId("revert-bar")).toBeVisible()
  await expect(page.getByTestId("ops-input")).toHaveValue("[slow 40] 실행 중인 질문")
  await expect.poll(() => ops(page, "status")).toBe("idle")
  expect(errors).toEqual([])
})
