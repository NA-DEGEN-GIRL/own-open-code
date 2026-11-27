// `!` shell mode against the real server (03 §4.6, §10, §19.9): `!` in an empty box switches the box (dashed border,
// shell placeholder and tag) and is consumed; Enter runs the command with `session.shell`, which records it in the
// session without waking the agent (no assistant turn; its output waits in the inbox for the next message); the
// running chip shows while it runs; the box is back in prompt mode after a send; shell commands have their own ↑
// history; Esc/Backspace on the empty box leave; a pasted `!command` in prompt mode runs as a command too.
import { expect, test, type APIRequestContext } from "@playwright/test"
import { messages, newSession, openHarness, sessionRoute } from "./support"

test.describe.configure({ mode: "serial" })

async function inbox(request: APIRequestContext, sessionID: string) {
  const response = await request.get(`/api/session/${sessionID}/inbox`)
  return ((await response.json()) as { data: { type: string; payload?: { metadata?: { source?: string } } }[] }).data
}

test("`!` enters shell mode; the command is recorded without waking the agent", async ({ page, request }) => {
  const sessionID = await newSession(request, "셸 e2e")
  const textarea = await openHarness(page, sessionRoute(sessionID))
  const box = page.getByTestId("composer-box")
  await textarea.press("Shift+Digit1")
  await expect(textarea).toHaveValue("")
  await expect(box).toHaveAttribute("data-shell", "")
  await expect(page.getByTestId("shell-tag")).toBeVisible()
  await expect(textarea).toHaveAttribute("placeholder", "셸 명령 — 에이전트를 깨우지 않고 실행해요")
  await expect(page.getByTestId("shell-hint")).toBeVisible()
  // The `@`/`/` lists stay closed in shell mode.
  await textarea.pressSequentially("sleep 2")
  await textarea.press("Enter")
  await expect(page.getByTestId("shell-running")).toContainText("sleep 2")
  // Back in prompt mode right after the send (upstream `clearSubmission`).
  await expect(box).not.toHaveAttribute("data-shell", "")
  await expect(page.getByTestId("shell-running")).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => (await messages(request, sessionID)).map((message) => message.type)).toContain("shell")
  const recorded = (await messages(request, sessionID)).find((message) => message.type === "shell")
  expect(recorded?.command).toBe("sleep 2")
  // No assistant turn: the output waits in the inbox for the next message.
  await page.waitForTimeout(1_000)
  expect((await messages(request, sessionID)).some((message) => message.type === "assistant")).toBe(false)
  expect((await inbox(request, sessionID)).some((item) => item.payload?.metadata?.source === "shell")).toBe(true)
  expect(await page.evaluate(() => window.__composerPlus!.sent.at(-1))).toEqual({ text: "sleep 2", result: "shell" })
})

test("shell history, leaving with Esc/Backspace, and a `!command` typed in prompt mode", async ({ page, request }) => {
  const sessionID = await newSession(request, "셸 e2e 기록")
  const textarea = await openHarness(page, sessionRoute(sessionID))
  const box = page.getByTestId("composer-box")
  await textarea.press("Shift+Digit1")
  await textarea.pressSequentially("echo own-shell-e2e")
  await textarea.press("Enter")
  await expect.poll(() => page.evaluate(() => window.__composerPlus!.sent.at(-1)?.result)).toBe("shell")

  // Shell mode has its own ↑ list.
  await textarea.press("Shift+Digit1")
  await textarea.press("ArrowUp")
  await expect(textarea).toHaveValue("echo own-shell-e2e")
  await textarea.fill("")
  await textarea.press("Escape")
  await expect(box).not.toHaveAttribute("data-shell", "")
  await textarea.press("Control+Shift+KeyX")
  await expect(box).toHaveAttribute("data-shell", "")
  await textarea.press("Backspace")
  await expect(box).not.toHaveAttribute("data-shell", "")
  // In prompt mode ↑ shows prompts, not shell commands.
  await textarea.press("ArrowUp")
  await expect(textarea).not.toHaveValue("echo own-shell-e2e")

  // `!command` in one go (pasted): the border says shell, the send runs it.
  await textarea.fill("")
  await textarea.fill("!echo pasted-shell")
  await textarea.dispatchEvent("input")
  await expect(box).toHaveAttribute("data-shell", "")
  await textarea.press("End")
  await textarea.press("Enter")
  await expect
    .poll(async () =>
      (await messages(request, sessionID)).filter((message) => message.type === "shell").map((m) => m.command),
    )
    .toEqual(["echo own-shell-e2e", "echo pasted-shell"])
  expect((await messages(request, sessionID)).some((message) => message.type === "assistant")).toBe(false)
})
