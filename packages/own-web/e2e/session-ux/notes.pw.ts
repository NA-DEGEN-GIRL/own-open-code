// 03 §19.10 conversation memo (`대화 메모`) against the real server and the fake model: a UI-only note lives in `own.note` metadata and
// never reaches model input; `모델에게도 보이기` writes the `own.note` instruction entry, which core appends at the next
// step boundary — the previous request stays an exact prefix of the next one (01 §17.1 #26, R8); turning it off is
// announced the same way. Korean input goes through a real CDP composition, Ctrl+Enter saves after committing it.
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { createSession, modelRequests, openHarness, shots, turn, ux, type ModelRequest } from "./support"

test.describe.configure({ mode: "serial" })

const dialog = (page: Page) => page.getByTestId("notes-dialog")

async function openNotes(page: Page) {
  await page.getByTestId("ux-notes").click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByTestId("notes-input")).toBeEnabled()
}

async function compose(page: Page, text: string) {
  const cdp = await page.context().newCDPSession(page)
  for (let length = 1; length <= text.length; length++)
    await cdp.send("Input.imeSetComposition", {
      text: text.slice(0, length),
      selectionStart: length,
      selectionEnd: length,
    })
  return cdp
}

const serialized = (request: ModelRequest | undefined) => JSON.stringify(request?.input ?? [])

/** The previous request is an exact prefix of the next one (same instructions, same leading input items). */
function expectPrefix(before: ModelRequest, after: ModelRequest) {
  expect(after.instructions).toEqual(before.instructions)
  expect(after.input.length).toBeGreaterThan(before.input.length)
  expect(after.input.slice(0, before.input.length)).toEqual(before.input)
}

test("UI-only note: typed with Korean IME, saved with Ctrl+Enter into own.note, never in model input", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "노트 테스트")
  await turn(page, "첫 질문입니다")
  await openNotes(page)
  const input = dialog(page).getByTestId("notes-input")
  await expect(dialog(page)).toContainText("UI 전용 · 모델에게 보이지 않고 캐시에 영향이 없어요")
  await input.click()
  const cdp = await compose(page, "결제메모")
  // Ctrl+Enter mid-composition commits first (rule 6), then saves once.
  await page.keyboard.press("Control+Enter")
  await expect(dialog(page).getByTestId("notes-status")).toHaveText("저장했어요")
  await cdp.detach()
  await expect(input).toHaveValue("결제메모")
  await expect.poll(async () => (await ux<Record<string, unknown>>(page, "metadata", id))["own.note"]).toBe("결제메모")
  expect(await ux<{ key: string }[]>(page, "entries", id)).toEqual([])

  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
  await turn(page, "두 번째 질문입니다")
  const requests = await modelRequests(page)
  expect(serialized(requests.at(-1))).toContain("두 번째 질문입니다")
  expect(requests.some((request) => serialized(request).includes("결제메모"))).toBe(false)
  expect(errors).toEqual([])
})

test("모델에게도 보이기: an appended instruction entry — the prefix stays; off is announced, prefix still intact", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "보이는 노트")
  await turn(page, "첫 질문입니다")
  await openNotes(page)
  const input = dialog(page).getByTestId("notes-input")
  await input.fill("배포 전에 결제 로그를 확인할 것")
  await dialog(page).getByTestId("notes-model-toggle").check()
  await expect(dialog(page).getByTestId("notes-pending")).toHaveText("다음 요청에서 이 메모가 대화 끝에 더해져요")
  await page.screenshot({ path: path.join(shots(), "notes-visible-dark.png") })
  await dialog(page).getByTestId("notes-save").click()
  await expect(dialog(page).getByTestId("notes-status")).toHaveText("다음 요청에서 이 메모가 대화 끝에 더해져요")
  await expect(dialog(page).getByTestId("notes-visible-tag")).toHaveText("모델에게 보임")
  await expect
    .poll(() => ux<{ key: string; value: unknown }[]>(page, "entries", id))
    .toEqual([{ key: "own.note", value: "배포 전에 결제 로그를 확인할 것" }])
  expect((await ux<Record<string, unknown>>(page, "metadata", id))["own.note"]).toBe("배포 전에 결제 로그를 확인할 것")

  const before = (await modelRequests(page)).at(-1)!
  await turn(page, "두 번째 질문입니다", id)
  const after = (await modelRequests(page)).at(-1)!
  expectPrefix(before, after)
  const added = JSON.stringify(after.input.slice(before.input.length))
  expect(added).toContain("배포 전에 결제 로그를 확인할 것")
  expect(added).toContain("두 번째 질문입니다")
  expect(serialized(before)).not.toContain("배포 전에 결제 로그를 확인할 것")

  // Off again: the entry is removed and the model is told, still only at the end.
  await dialog(page).getByTestId("notes-model-toggle").uncheck()
  await expect(dialog(page).getByTestId("notes-pending")).toHaveText(
    "다음 요청에서 이 메모가 더는 적용되지 않는다고 모델에게 알려요",
  )
  await dialog(page).getByTestId("notes-save").click()
  await expect.poll(() => ux<unknown[]>(page, "entries", id)).toEqual([])
  expect((await ux<Record<string, unknown>>(page, "metadata", id))["own.note"]).toBe("배포 전에 결제 로그를 확인할 것")
  await turn(page, "세 번째 질문입니다", id)
  const last = (await modelRequests(page)).at(-1)!
  expectPrefix(after, last)
  expect(JSON.stringify(last.input.slice(after.input.length))).toContain("no longer applies")
  expect(errors).toEqual([])
})

test("an unsaved draft survives closing; 변경 취소 restores the saved note; an empty note clears the key", async ({
  page,
}) => {
  const errors = await openHarness(page)
  const id = await createSession(page, "초안 노트")
  await openNotes(page)
  const input = dialog(page).getByTestId("notes-input")
  await input.fill("저장한 노트")
  await dialog(page).getByTestId("notes-save").click()
  await expect(dialog(page).getByTestId("notes-status")).toHaveText("저장했어요")
  await input.fill("저장 안 한 초안")
  await dialog(page).getByTestId("dialog-close").click()
  await openNotes(page)
  await expect(input).toHaveValue("저장 안 한 초안")
  await expect(dialog(page).getByTestId("notes-save")).toBeEnabled()
  await dialog(page).getByTestId("notes-revert").click()
  await expect(input).toHaveValue("저장한 노트")
  await expect(dialog(page).getByTestId("notes-save")).toBeDisabled()
  await input.fill("")
  await dialog(page).getByTestId("notes-save").click()
  await expect.poll(async () => "own.note" in (await ux<Record<string, unknown>>(page, "metadata", id))).toBe(false)
  for (const scheme of ["light", "dark"] as const) {
    await ux(page, "setScheme", scheme)
    await input.fill("테마 확인용 노트")
    await dialog(page).getByTestId("notes-model-toggle").check()
    await page.screenshot({ path: path.join(shots(), `notes-${scheme}.png`) })
  }
  await dialog(page).getByTestId("notes-revert").click()
  expect(errors).toEqual([])
})
