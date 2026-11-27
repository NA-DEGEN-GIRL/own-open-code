// 설정 > 확장 (17 §8.1) end to end: the section in 고급, the seeded extensions with their status, what they do and their
// cache effect, an extension's skill in 설정 > 스킬 beside own's imagegen, a version's file, turning one off and on,
// rolling back to version 1, limiting one to a project folder and back to every project, approving the allow rules of
// the other, removing it with its confirm, a generated MCP server (C2) stopped and started with its log, the code
// plugin switch (C3, off by default, with its risk text), the approval of a code plugin's version, and the page at a
// narrow width. Every change is read back from the store the service keeps (`OWN_HOME\creator\store.json`).
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

const STATE = path.join(process.env.OWN_WEB_CREATOR_E2E_TMP ?? "", "backend.json")
const state = JSON.parse(fs.readFileSync(STATE, "utf8")) as {
  readonly home: string
  readonly project: string
}

type Entry = { id: string; active: number; enabled: boolean; projects: string[]; loosen: number[]; trusted?: number[] }

function storeFile() {
  return JSON.parse(fs.readFileSync(path.join(state.home, "creator", "store.json"), "utf8")) as {
    extensions: Entry[]
    settings?: { plugins: boolean }
  }
}

function stored(id: string) {
  return storeFile().extensions.find((entry) => entry.id === id)
}

async function open(page: Page) {
  await page.goto("/settings/creator")
  const root = page.getByTestId("settings-creator")
  await expect(root.locator('[data-testid="creator-extension"]')).toHaveCount(EXTENSIONS.count)
  return root
}

const card = (page: Page, id: string) => page.locator(`[data-testid="creator-extension"][data-id="${id}"]`)

/** How many cards the page shows now (one test removes one). */
const EXTENSIONS = { count: 4 }

test("the section is in 고급 and lists what creator mode made", async ({ page }) => {
  await open(page)
  await expect(page.getByTestId("settings-nav-creator")).toHaveText(/확장/)
  const rules = card(page, "house-rules")
  await expect(rules.getByTestId("creator-extension-status")).toHaveText("켜짐")
  await expect(rules).toContainText("판 2")
  await expect(rules.getByTestId("creator-extension-effects")).toContainText("지시문 조각 style · 캐시 유지")
  await expect(rules.getByTestId("creator-extension-effects")).toContainText("명령 도구 ext_say · 캐시 유지")
  await expect(rules.getByTestId("creator-extension-scope")).toContainText("모든 프로젝트")
  await expect(card(page, "loose-fetch").getByTestId("creator-extension-loosen")).toContainText("승인을 기다려요")
})

test("설정 > 스킬 lists own's imagegen and the skill an extension made (MR14)", async ({ page }) => {
  await page.goto("/settings/skills")
  const rows = page.getByTestId("settings-skills-all").getByTestId("settings-skills-row")
  await expect(rows.and(page.locator('[data-skill="imagegen"]')).first()).toHaveAttribute("data-group", "own")
  await expect(rows.and(page.locator('[data-skill="house-style"]')).first()).toContainText("house-style")
})

test("a version's file, off and on, a rollback", async ({ page }) => {
  await open(page)
  const rules = card(page, "house-rules")
  await rules.getByTestId("creator-extension-history").locator("summary").click()
  const first = rules.locator('[data-testid="creator-extension-version"][data-n="1"]')
  await first.getByRole("button", { name: "내용 보기" }).click()
  await expect(first.locator("pre")).toContainText('"format": "own.ext/1"')
  await expect(first.locator("pre")).toContainText("Answer in one sentence.")

  await rules.getByTestId("creator-extension-enabled").click()
  await expect(rules.getByTestId("creator-extension-status")).toHaveText("꺼짐")
  await expect.poll(() => stored("house-rules")?.enabled).toBe(false)
  await rules.getByTestId("creator-extension-enabled").click()
  await expect(rules.getByTestId("creator-extension-status")).toHaveText("켜짐")

  await first.getByTestId("creator-extension-rollback").click()
  await expect(page.getByTestId("settings-creator-status")).toContainText("판 1로 되돌렸어요")
  await expect(rules).toContainText("판 1")
  await expect.poll(() => stored("house-rules")?.active).toBe(1)
  await expect(rules.locator('[data-testid="creator-extension-version"][data-n="1"]')).toContainText("지금 판")
})

test("limits an extension to a project folder and back to every project", async ({ page }) => {
  await open(page)
  const rules = card(page, "house-rules")
  await rules.getByTestId("creator-extension-folder").fill("relative/folder")
  await rules.getByTestId("creator-extension-folder-add").click()
  await expect(rules).toContainText("전체 경로를 넣어요.")
  await rules.getByTestId("creator-extension-folder").fill(state.project)
  await rules.getByTestId("creator-extension-folder-add").click()
  await expect(rules.getByTestId("creator-extension-project")).toContainText(state.project)
  await expect.poll(() => stored("house-rules")?.projects.length).toBe(1)
  await rules.getByTestId("creator-extension-scope-reset").click()
  await expect(rules.getByTestId("creator-extension-scope")).toContainText("모든 프로젝트")
  await expect.poll(() => stored("house-rules")?.projects.length).toBe(0)
})

test("approves the allow rules, then removes the extension with a confirm", async ({ page }) => {
  await open(page)
  const loose = card(page, "loose-fetch")
  await loose.getByTestId("creator-extension-loosen-button").click()
  await expect(loose.getByTestId("creator-extension-loosen")).toContainText("승인했어요")
  await expect.poll(() => stored("loose-fetch")?.loosen).toEqual([1])
  await loose.getByTestId("creator-extension-remove").click()
  await loose.getByTestId("creator-extension-remove-confirm").click()
  EXTENSIONS.count = 3
  await expect(page.locator('[data-testid="creator-extension"]')).toHaveCount(EXTENSIONS.count)
  await expect.poll(() => stored("loose-fetch")).toBeUndefined()
})

test("a generated MCP server: its kind, 멈추기 and 다시 시작, and its log", async ({ page }) => {
  await open(page)
  const words = card(page, "word-tools")
  await expect(words.getByTestId("creator-extension-kind")).toHaveText("MCP 서버")
  await expect(words.getByTestId("creator-extension-effects")).toContainText("MCP 서버 words · 캐시 유지")
  await expect(words.getByTestId("creator-extension-server")).toContainText("부를 때마다 승인 모드대로 물어요")
  await words.getByTestId("creator-extension-server-button").click()
  await expect(words.getByTestId("creator-extension-server")).toContainText("멈춰 있어요")
  await words.getByRole("button", { name: "로그 보기" }).click()
  await expect(words.getByTestId("creator-extension-log-lines")).toContainText("stage words: smoke ok")
  await expect(words.getByTestId("creator-extension-log-lines")).toContainText("stopped by the user")
  await words.getByTestId("creator-extension-server-button").click()
  await expect(words.getByTestId("creator-extension-server")).toContainText("부를 때마다")
})

test("code plugins: off by default with the risk spelled out; on, a version waits for its approval", async ({ page }) => {
  await open(page)
  const section = page.getByTestId("settings-creator-plugins")
  // MR15's wording: the plugin runs as the user, can read tokens and send them out, and own does not sandbox it.
  await expect(section.getByTestId("settings-creator-plugins-risk")).toContainText("서비스 프로세스 안에서 나(사용자)로 돌아요")
  await expect(section.getByTestId("settings-creator-plugins-risk")).toContainText("샌드박스로 막지 않아요")
  await expect(section).toContainText("꺼져 있으면")
  const pirate = card(page, "pirate")
  await expect(pirate.getByTestId("creator-extension-kind")).toHaveText("코드 플러그인")
  await expect(pirate.getByTestId("creator-extension-status")).toHaveText("코드 플러그인 꺼짐")
  await section.getByTestId("settings-creator-plugins-switch").click()
  await expect(page.getByTestId("settings-creator-status")).toContainText("코드 플러그인을 켰어요")
  await expect.poll(() => storeFile().settings?.plugins).toBe(true)
  await expect(pirate.getByTestId("creator-extension-status")).toHaveText("승인 기다림")
  await expect(pirate.getByTestId("creator-extension-trust")).toContainText("아직 꺼져 있어요")
  await pirate.getByTestId("creator-extension-trust-button").click()
  await expect(pirate.getByTestId("creator-extension-status")).toHaveText("켜짐")
  await expect.poll(() => stored("pirate")?.trusted).toEqual([1])
  await expect(pirate.getByTestId("creator-extension-trust")).toContainText("이 판을 승인했어요")
  await section.getByTestId("settings-creator-plugins-switch").click()
  await expect(pirate.getByTestId("creator-extension-status")).toHaveText("코드 플러그인 꺼짐")
  await expect.poll(() => storeFile().settings?.plugins).toBe(false)
})

test("fits a narrow window without a horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 860 })
  await page.goto("/settings/creator")
  await expect(page.locator('[data-testid="creator-extension"]').first()).toBeVisible()
  const overflow = await page
    .getByTestId("settings-creator")
    .evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
