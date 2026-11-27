// Skills against the real server (03 §19.6): the popover lists the folder's skills (project first, tags), a Korean
// search commits on the first Enter and applies on the next (palette rule, 03 §12 rule 8), `칩으로 추가` sends the skill
// with the next message (`skills[]`), and `바로 실행` (Ctrl+Enter) appends it with `session.skill` and starts the agent.
import { expect, test } from "@playwright/test"
import { compose, messages, newSession, openHarness, sessionRoute } from "./support"

test.describe.configure({ mode: "serial" })

test("the list, a Korean search, and a chip that goes with the next message", async ({ page, request }) => {
  const sessionID = await newSession(request, "스킬 e2e 칩")
  const textarea = await openHarness(page, sessionRoute(sessionID))
  await page.getByTestId("skills-button").click()
  const panel = page.getByTestId("skills-panel")
  await expect(panel).toBeVisible()
  const options = panel.getByTestId("skills-option")
  await expect(options.first()).toBeVisible()
  const ids = await options.evaluateAll((items) => items.map((item) => item.getAttribute("data-skill")))
  expect(ids.slice(0, 2)).toEqual(["release-notes", "review-guide"])
  expect(ids).toContain("opencode")
  await expect(panel.locator('[data-skill="review-guide"]')).toContainText("리뷰 체크리스트")
  await expect(panel.locator('[data-skill="review-guide"]')).toContainText("프로젝트")
  // Core's own skills are `기본 제공` (SK2-9), as in 설정 > 스킬.
  await expect(panel.locator('[data-skill="opencode"]')).toContainText("기본 제공")

  const search = page.getByTestId("skills-search")
  await search.focus()
  const ime = await compose(page, "리뷰")
  await ime.enterCommit()
  await ime.detach()
  // The committing Enter only commits.
  await expect(search).toHaveValue("리뷰")
  await expect(options).toHaveCount(1)
  await expect(page.getByTestId("mention-chip")).toHaveCount(0)
  await search.press("Enter")
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId("mention-chip")).toContainText("review-guide")
  await expect(textarea).toBeFocused()

  await textarea.pressSequentially("스킬과 함께 보냄")
  await textarea.press("Enter")
  await expect
    .poll(async () => (await messages(request, sessionID)).find((message) => message.type === "user")?.skills)
    .toEqual([expect.objectContaining({ id: "review-guide" })])
  await expect(page.getByTestId("mention-chip")).toHaveCount(0)
})

test("바로 실행 appends the skill and starts the agent; Esc closes the popover", async ({ page, request }) => {
  const sessionID = await newSession(request, "스킬 e2e 실행")
  await openHarness(page, sessionRoute(sessionID))
  await page.getByTestId("skills-button").click()
  const search = page.getByTestId("skills-search")
  await search.press("Escape")
  await expect(page.getByTestId("skills-panel")).toHaveCount(0)
  await page.getByTestId("skills-button").click()
  await search.pressSequentially("release")
  await expect(page.getByTestId("skills-option")).toHaveCount(1)
  await search.press("Control+Enter")
  await expect(page.getByText("스킬을 불러왔어요: Release notes")).toBeVisible()
  await expect
    .poll(async () => (await messages(request, sessionID)).map((message) => message.type))
    .toEqual(expect.arrayContaining(["skill", "assistant"]))
  const list = await messages(request, sessionID)
  const skill = list.findIndex((message) => message.type === "skill")
  expect(list.findIndex((message) => message.type === "assistant")).toBeGreaterThan(skill)
  await expect(page.getByTestId("mention-chip")).toHaveCount(0)
})
