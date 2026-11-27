// Preset gate refusal (07 §5.4 거절 경로, §7.3, PG1) in Edge against the real server: the scripted model calls the
// `subagent` tool with another account's model (`[preset-reject]`), the own-accounts gate refuses it, core answers the
// LLM with the tool failure `Unknown agent: own-preset: …`, and the transcript draws the neutral chip instead of
// session-ui's failure card. The turn goes on (the model answers after reading the failure): not a session error.
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { idle, openHarness, shots, wt, wtState } from "./support"

test.describe.configure({ mode: "serial" })

let sessionID = ""

async function localSession(page: Page, title: string) {
  await wt(page, "home")
  await expect(page.getByTestId("worktree-select")).toContainText("프로젝트 폴더")
  await page.getByTestId("wt-new-input").fill(title)
  await page.getByTestId("wt-create").click()
  await expect(page.getByTestId("wt-header")).toContainText(title, { timeout: 60_000 })
  const id = (await wt<string>(page, "current"))!
  await idle(page, id)
  return id
}

async function expectChip(page: Page) {
  const chip = page.getByTestId("subagent-preset-rejected")
  await expect(chip).toHaveCount(1)
  await expect(chip).toBeVisible()
  await expect(chip).toContainText(`하위 에이전트 요청을 막았어요: ${wtState().rejectedModel}`)
  // The gate's sentence (written for the LLM) is the tooltip; it sends the LLM to the user, never to a file.
  await expect(chip.locator("[title]")).toHaveAttribute("title", /^model not in this preset\..*Ask the user/)
  // No failure card and no raw core failure text anywhere in the transcript.
  await expect(page.locator('[data-kind="tool-error-card"]')).toHaveCount(0)
  await expect(page.getByText("Unknown agent")).toHaveCount(0)
  return chip
}

test("[preset-reject]: the refused subagent call is the neutral chip, not a failure card (dark)", async ({ page }) => {
  const errors = await openHarness(page)
  sessionID = await localSession(page, "프리셋 거절")
  const input = page.getByTestId("wt-input")
  await input.fill("[preset-reject] 다른 계정으로 리뷰를 맡겨 줘")
  await input.press("Enter")
  await expect(page.getByTestId("subagent-preset-rejected")).toBeVisible({ timeout: 45_000 })
  await idle(page, sessionID)
  // The refusal reached the LLM as a tool result: it answered after reading it, and the turn ended normally.
  await expect(page.getByTestId("transcript-body").getByText("도구 실행을 마쳤습니다.", { exact: true })).toBeVisible()
  expect(await wt<{ name: string; status: string }[]>(page, "tools", sessionID)).toEqual([
    expect.objectContaining({ name: "subagent", status: "error" }),
  ])
  const chip = await expectChip(page)
  await chip.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(shots(), "preset-rejected-dark.png") })
  expect(errors).toEqual([])
})

test("the chip after a reload, light scheme (the refusal is read back from the stored tool failure)", async ({
  page,
}) => {
  expect(sessionID).not.toBe("")
  const errors = await openHarness(page, "?scheme=light")
  await wt(page, "open", sessionID)
  await expect(page.getByTestId("wt-header")).toContainText("프리셋 거절")
  await expect(page.getByTestId("subagent-preset-rejected")).toBeVisible({ timeout: 30_000 })
  const chip = await expectChip(page)
  await chip.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(shots(), "preset-rejected-light.png") })
  expect(errors).toEqual([])
})
