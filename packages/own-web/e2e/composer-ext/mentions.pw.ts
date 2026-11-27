// `@` mentions against the real server (03 §18.12, §4.6 chips, §12 IME): the grouped list from the real catalogs
// (fs.find, agents, skills, references, MCP resources), choosing into chips, `#L10-40`, a `#` folder on Windows, what
// the server stores for each part, and a real Chromium composition over CDP (the committing Enter only commits).
import { expect, test } from "@playwright/test"
import { backend, compose, messages, newSession, openHarness, options } from "./support"

test.describe.configure({ mode: "serial" })

const state = backend()
let sessionID = ""

test.beforeAll(async ({ request }) => {
  sessionID = await newSession(request, "멘션 e2e 1")
})

test("groups follow 03 §18.12: files → agents → skills → references → MCP resources", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("@")
  const list = page.getByTestId("suggest-list")
  await expect(list).toBeVisible()
  await expect(list.locator('[data-group="resources"]')).toContainText("Onboarding handbook")
  await expect(list.locator('[data-group="agents"]')).toContainText("@explore")
  await expect(list.locator('[data-group="skills"]')).toContainText("@review-guide")
  await expect(list.locator('[data-group="references"]')).toContainText("@handbook")
  // Primary agents are for /agent, not @.
  await expect(list.locator('[data-group="agents"]')).not.toContainText("@build")
  await textarea.pressSequentially("rou")
  await expect(list.locator('[data-group="files"]')).toContainText("src/router.ts")
  const groups = await list
    .locator(".own-sg-group")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-group")))
  expect(groups[0]).toBe("files")
  expect(await textarea.getAttribute("aria-activedescendant")).toBeTruthy()
  expect(errors).toEqual([])
})

test("Enter chooses a file into a chip; #L10-40 limits it; the server stores the range", async ({ page, request }) => {
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("이 줄 봐줘 @router#L10-40")
  await expect(options(page).first()).toHaveText(/src\/router\.ts#L10-40/)
  await textarea.press("Enter")
  await expect(page.getByTestId("mention-chip")).toHaveText(/src\/router\.ts#L10-40/)
  await expect(textarea).toHaveValue("이 줄 봐줘 ")
  await expect(page.getByTestId("suggest-list")).toHaveCount(0)
  await textarea.press("Enter")
  await expect(textarea).toHaveValue("")
  await expect(page.getByTestId("mention-chips")).toHaveCount(0)
  await expect
    .poll(async () => (await messages(request, sessionID)).findLast((message) => message.type === "user")?.text)
    .toBe("@src/router.ts#L10-40\n이 줄 봐줘")
  const user = (await messages(request, sessionID)).findLast((message) => message.type === "user")!
  expect(user.files?.[0]?.source?.uri).toMatch(/\/src\/router\.ts\?start=10&end=40$/)
  expect(user.files?.[0]?.name).toBe("router.ts#L10-40")
})

test("agents, skills, references and MCP resources become the matching prompt parts", async ({ page, request }) => {
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  for (const [query, label] of [
    ["@explo", "@explore"],
    ["@review-g", "@review-guide"],
    ["@handb", "@handbook"],
    ["@Onboard", "Onboarding handbook"],
  ] as const) {
    await textarea.pressSequentially(query)
    // The file search answers after the catalogs and can put a folder of the same name first (`skills/review-guide/`
    // holds the skill): pick the row by its label once the list for this query settled.
    const list = page.getByTestId("suggest-list")
    await expect(list).toHaveAttribute("data-query", query.slice(1))
    await expect(list).toHaveAttribute("aria-busy", "false")
    await options(page).filter({ hasText: label }).first().click()
    await expect(textarea).toHaveValue("")
  }
  // A folder whose name starts with `#` (own/FORK.md Windows pitfall): encoded, read by the server.
  await textarea.pressSequentially("@plan")
  await expect(options(page).first()).toContainText("#notes/plan.md")
  await textarea.press("Enter")
  await expect(page.getByTestId("mention-chip")).toHaveCount(5)
  await textarea.pressSequentially("정리해줘")
  await textarea.press("Enter")
  await expect
    .poll(async () => (await messages(request, sessionID)).findLast((message) => message.type === "user")?.text ?? "")
    .toContain("정리해줘")
  const user = (await messages(request, sessionID)).findLast((message) => message.type === "user")!
  expect(user.text).toBe(
    "@explore @review-guide @handbook @#notes/plan.md\n정리해줘\n" +
      'MCP resource "Onboarding handbook" (server: docs, uri: docs://handbook/onboarding)',
  )
  expect(user.agents?.map((agent) => agent.name)).toEqual(["explore"])
  expect(user.skills?.map((skill) => skill.id)).toEqual(["review-guide"])
  const uris = user.files?.map((file) => file.source?.uri ?? "") ?? []
  expect(uris.some((uri) => uri.endsWith("/workspace/docs"))).toBe(true)
  expect(uris.some((uri) => uri.includes("/%23notes/plan.md"))).toBe(true)
  expect(user.files?.find((file) => file.source?.uri?.endsWith("/workspace/docs"))?.mime).toBe(
    "application/x-directory",
  )
})

test("Korean IME: the list follows the composition, ↓ is not taken, the committing Enter only commits", async ({
  page,
}) => {
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("@")
  await expect(page.getByTestId("suggest-list")).toBeVisible()
  const ime = await compose(page, "라우")
  await ime.arrowDown()
  await ime.enterCommit()
  await ime.detach()
  await expect(textarea).toHaveValue("@라우")
  // Not sent, not chosen: the commit only committed (03 §12 rule 8 exception, like the switcher search).
  await expect(page.getByTestId("mention-chip")).toHaveCount(0)
  expect(await page.evaluate(() => window.__harness!.sent.length)).toBe(0)
  await expect(options(page).first()).toContainText("src/라우터.ts")
  await textarea.press("Enter")
  await expect(page.getByTestId("mention-chip")).toHaveText(/src\/라우터\.ts/)
  await expect(textarea).toHaveValue("")
})

test("Esc closes the list and keeps the text; ✕ removes a chip", async ({ page }) => {
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("@gen")
  await expect(page.getByTestId("suggest-list")).toBeVisible()
  await textarea.press("Escape")
  await expect(page.getByTestId("suggest-list")).toHaveCount(0)
  await expect(textarea).toHaveValue("@gen")
  await textarea.fill("")
  await textarea.pressSequentially("@gen")
  await options(page).filter({ hasText: "@general" }).click()
  await expect(page.getByTestId("mention-chip")).toHaveCount(1)
  await expect(textarea).toBeFocused()
  await page.getByRole("button", { name: /멘션 빼기/ }).click()
  await expect(page.getByTestId("mention-chip")).toHaveCount(0)
})

test("large workspace: fs.find answers are shown in server order within the budget", async ({ page }) => {
  const textarea = await openHarness(page, { name: "session", serverKey: "local", sessionID })
  await textarea.pressSequentially("@pkg3/mod4")
  await expect(options(page).first()).toContainText("big/pkg3/mod4")
  const labels = await options(page).allTextContents()
  expect(labels.filter((label) => label.includes("big/")).length).toBeLessThanOrEqual(20)
  expect(state.bigFiles).toBeGreaterThanOrEqual(3_000)
})
