// 03 §18.10 첨부 파이프라인 against the real server: `＋` (file picker) → upload into the server's `paths.tmp` through
// `fs.write` → the prompt carries the server path; a pasted image (inline when the model reads images, else a path
// with the note — unit-tested, the fake model reads images); dropping over the main column; the 25 MiB refusal; preview
// and removal.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { createSession, idle, openHarness, ops, shots } from "./support"

test.describe.configure({ mode: "serial" })

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

type ChipView = {
  name: string
  state: string
  route: string
  ready?: { kind: "path"; path: string } | { kind: "inline"; uri: string }
}

async function pick(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent("filechooser")
  await page.getByTestId("attach-button").click()
  await (await chooser).setFiles(files)
}

test("＋ uploads to the server temp folder; the prompt carries the server path", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "첨부 업로드")
  const content = "첫 줄 로그\n두 번째 줄 #해시 %퍼센트\n"
  await pick(page, [{ name: "서버 로그 #1.txt", mimeType: "text/plain", buffer: Buffer.from(content) }])
  const chip = page.getByTestId("attachment-chip")
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveAttribute("data-state", "ready")
  await expect(chip).toHaveAttribute("data-route", "upload")
  const [view] = await ops<ChipView[]>(page, "chips")
  expect(view!.ready?.kind).toBe("path")
  const uploaded = view!.ready?.kind === "path" ? view!.ready.path : ""
  expect(uploaded.replaceAll("\\", "/")).toMatch(/\/uploads\/[0-9a-f-]{36}\/서버 로그 #1\.txt$/)
  expect(fs.readFileSync(uploaded, "utf8")).toBe(content)
  await page.screenshot({ path: path.join(shots(), "attach-01-uploaded.png") })

  await page.getByTestId("ops-input").fill("이 로그를 봐줘")
  await page.getByTestId("ops-send").click()
  await expect(chip).toHaveCount(0)
  await expect
    .poll(
      async () => (await ops<{ type: string; text: string }[]>(page, "messages")).find((m) => m.type === "user")?.text,
    )
    .toBe(`이 로그를 봐줘\nAttached file: \`${uploaded}\``)
  await idle(page)
  expect(errors).toEqual([])
})

test("a pasted image goes inline with the token note; preview, removal, and the message carries it", async ({
  page,
}) => {
  const errors = await openHarness(page)
  await createSession(page, "첨부 붙여넣기")
  // Pasted right away: the store loads the model catalog first when the model's input modalities are unknown.
  const paste = () =>
    page.evaluate((png) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], "shot.png", { type: "image/png" }))
      document
        .querySelector("#ops-input")!
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, PNG)
  await page.getByTestId("ops-input").focus()
  await paste()
  const chip = page.getByTestId("attachment-chip")
  await expect(chip).toHaveAttribute("data-state", "ready")
  await expect(chip).toHaveAttribute("data-route", "inline")
  await expect(chip.locator("img.own-at-thumb")).toBeVisible()
  await expect(page.getByTestId("attachment-image-cost")).toHaveText(
    "이미지 1장은 약 1,500 토큰으로 계산되며, 대화에 남아 이후 요청에도 들어가요.",
  )
  await expect(page.getByTestId("attachment-no-image")).toHaveCount(0)
  await page.screenshot({ path: path.join(shots(), "attach-02-pasted.png") })

  // Preview, then remove before sending.
  await chip.getByRole("button", { name: "shot.png 미리보기" }).click()
  const preview = page.getByTestId("attachment-preview")
  await expect(preview).toContainText("shot.png")
  await expect(preview).toContainText("image/png")
  await page.keyboard.press("Escape")
  await expect(preview).toHaveCount(0)
  await chip.getByRole("button", { name: "shot.png 첨부 빼기" }).click()
  await expect(chip).toHaveCount(0)

  // Paste again and send: the image reaches the message as an inline file.
  await paste()
  await expect(chip).toHaveAttribute("data-state", "ready")
  await page.getByTestId("ops-input").fill("이 화면 봐줘")
  await page.getByTestId("ops-send").click()
  type Sent = { type: string; text: string; files: { name?: string; mime: string }[] }
  const sent = async () => (await ops<Sent[]>(page, "messages")).find((message) => message.type === "user")
  await expect.poll(async () => (await sent())?.files).toEqual([{ name: "shot.png", mime: "image/png" }])
  expect((await sent())?.text).toBe("이 화면 봐줘")
  await idle(page)
  expect(errors).toEqual([])
})

test("files dropped anywhere over the main column become chips", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "첨부 끌어 놓기")
  const drag = (type: string) =>
    page.evaluate((name) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(["drop body"], "dropped.md", { type: "text/markdown" }))
      const target = document.querySelector("[data-testid='ops-main'] .ops-transcript")!
      target.dispatchEvent(new DragEvent(name, { dataTransfer: transfer, bubbles: true, cancelable: true }))
    }, type)
  await drag("dragenter")
  await drag("dragover")
  await expect(page.getByTestId("attachment-dropzone")).toBeVisible()
  await expect(page.getByTestId("attachment-dropzone")).toHaveText("여기에 놓으면 첨부해요")
  await page.screenshot({ path: path.join(shots(), "attach-03-dropzone.png") })
  await drag("drop")
  await expect(page.getByTestId("attachment-dropzone")).toHaveCount(0)
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-state", "ready")
  await expect(page.getByTestId("attachment-chip")).toContainText("dropped.md")
  expect(errors).toEqual([])
})

test("a file above 25 MiB is refused with the size in the message", async ({ page }) => {
  const errors = await openHarness(page)
  await createSession(page, "첨부 크기 제한")
  await pick(page, [{ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(26 * 1024 * 1024) }])
  await expect(page.getByTestId("toasts")).toContainText(
    "파일이 너무 커요(26MB). 한 파일에 25MB까지 올릴 수 있어요.",
  )
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0)
  expect(errors).toEqual([])
})
