// 반영하기 (06 §7, §9.7; TG20's T2 surfaces) in the whole own-web app in Edge against backend.ts. Its `calc` project
// gets one new area, `입력 정리`, and `bun run check` (a script that waits four seconds) as the team's check command.
// Each integration starts from the area menu's `이 영역 반영하기` after a save point the test makes in the area folder,
// as a user working there would. One PC window:
//   - the card above the team main: `입력 정리 반영하는 중 · 검사 1/1`, then `… 프로젝트 본 코드에 반영했어요` with
//     `[되돌리기] [원격 저장소에 올리기…] [검토 요청 올리기…]` and 자세히; the project's main code moved; the same card above
//     the owner's conversation; 되돌리기 puts it back;
//   - a change in the main folder that overlaps: the card waits with `[다시 반영]`, which applies it once the change is
//     put away;
//   - 반영하기 전에 묻기 on: the confirm waits in the card, the confirm dialog's focus starts on 두기, Escape closes it,
//     반영하기 applies; meanwhile a paired phone at 375 px (the backend's gateway stand-in) sees the waiting card with
//     the PC to answer on, then the applied one without 되돌리기 and with where to upload instead;
//   - 팀 모드 끄기, and no forbidden word, placeholder or page error anywhere these screens showed.
// Runs after team.spec.ts (playwright.config.ts); without this suite's backend it skips.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { areaMenuItem, enableTeam } from "./flows"

interface IntegrateState {
  readonly device: string
  readonly pc: string
  readonly control: string
  readonly t2: {
    readonly integrate: { readonly home: string; readonly seed: string }
  }
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as IntegrateState
const calc = () => state().t2.integrate
const NAME = "입력 정리"

/** 06 §9.1, word for word (team.spec.ts checks T1's screens the same way). */
const FORBIDDEN = [
  "worktree",
  "branch",
  "브랜치",
  "commit",
  "커밋",
  "merge",
  "머지",
  "rebase",
  "stash",
  "sparse",
  "LFS",
  "HEAD",
  "checkout",
  "push",
  "PR",
  "캐시",
  "환경 변수",
  "의존성",
  "보류",
]
const ALSO = ["홈 폴더", "이 PC", "this PC"]
const PLACEHOLDER = /\{\w+\}/

/** Upper-case ASCII words match as whole words with their case; other ASCII words anywhere, any case. */
function hits(text: string, word: string) {
  if (/^[A-Z]+$/.test(word)) return new RegExp(`\\b${word}\\b`).test(text)
  if (/^[a-z ]+$/.test(word)) return text.toLowerCase().includes(word)
  return text.includes(word)
}

/** Every text these screens showed, checked as it is read and once more at the end. */
const seen: string[] = []

/** The area folders inside the main folder (06 §4.12 프로젝트 안) are data: `.worktrees\<slug>`. */
const FOLDERS = /\.worktrees(?=[\\/])/g

async function words(locator: Locator) {
  const texts = (await locator.allInnerTexts()).map((text) => text.replace(FOLDERS, ""))
  for (const text of texts) {
    seen.push(text)
    expect(
      FORBIDDEN.concat(ALSO).filter((word) => hits(text, word)),
      text,
    ).toEqual([])
    expect(text, text).not.toMatch(PLACEHOLDER)
  }
  return texts.join("\n")
}

test.describe.configure({ mode: "serial" })

test.describe("반영하기 (06 §7, §9.7, TG20)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []
  const ids = { team: "", main: "", owner: "", folder: "", base: "" }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    // A failed run leaves no team on for the next spec.
    if (page) await off(page, calc().home)
    await context?.close()
  })

  test("팀 모드 켜기 on calc: one new area with the team's check command", async () => {
    await open(page, calc().seed)
    await menu(page, "session-menu", "session-menu-team-enable")
    await enableTeam(page)
    await expect.poll(() => current(page), { timeout: 120_000 }).not.toBe(calc().seed)
    ids.main = current(page)
    ids.team = await teamOf(page, calc().home)
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 90_000 })
    await expect(card.getByTestId("team-card-line").filter({ hasText: "영역 1개:" })).toHaveText(`영역 1개: ${NAME}.`)
    await expect(area(page).getByTestId("area-status")).toHaveText("쉬는 중", { timeout: 60_000 })
    const view = await rpc(page, "own.team", "team.get", { directory: calc().home })
    const found = (view.areas as ReadonlyArray<{ directory: string; owner: { sessionID: string | null } }>)[0]!
    ids.folder = found.directory
    ids.owner = found.owner.sessionID!
    ids.base = git(calc().home, ["rev-parse", "main"])
    expect(git(ids.folder, ["status", "--porcelain"])).toBe("")
  })

  test("이 영역 반영하기: the check runs on the card, the main code moves, the owner sees it; 되돌리기 puts it back", async () => {
    const saved = save(ids.folder, { "src/view.ts": "export const view = 2\n" }, "입력 화면 정리")
    await areaMenu(page, "area-menu-integrate")
    await expect(page.getByTestId("toasts")).toContainText(`${NAME} 반영하는 중`)

    const card = integration(page)
    await expect(card.getByTestId("team-integration-title")).toHaveText(`${NAME} 반영하는 중 · 검사 1/1`, {
      timeout: 60_000,
    })
    await words(card)
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-integration-title")).toHaveText(
      `${NAME} 작업을 프로젝트 본 코드에 반영했어요`,
    )
    await expect(card.getByTestId("team-integration-undo")).toHaveText("되돌리기")
    await expect(card.getByTestId("team-integration-push")).toHaveText("원격 저장소에 올리기…")
    await expect(card.getByTestId("team-integration-push-pr")).toHaveText("검토 요청 올리기…")
    await card.getByTestId("team-integration-details-toggle").click()
    const details = card.getByTestId("team-integration-details")
    await expect(details).toContainText(`검증한 것: 후보 ${saved.slice(0, 7)}`)
    await expect(details).toContainText("코드 검사 통과")
    await words(card)
    expect(git(calc().home, ["rev-parse", "main"])).toBe(saved)
    expect(fs.readFileSync(path.join(calc().home, "src/view.ts"), "utf8")).toBe("export const view = 2\n")

    // The owner's conversation shows the area's latest integration (9.7), as this window heard it: from the list,
    // without loading the page again.
    await row(page, ids.owner).click()
    await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${ids.owner}"]`)).toBeVisible()
    const shown = page.getByTestId("owner-integration").getByTestId("team-integration")
    await expect(shown).toHaveAttribute("data-state", "done")
    await expect(shown.getByTestId("team-integration-title")).toHaveText(
      `${NAME} 작업을 프로젝트 본 코드에 반영했어요`,
    )
    await words(shown)
    await row(page, ids.main).click()
    await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${ids.main}"]`)).toBeVisible()

    await integration(page).getByTestId("team-integration-undo").click()
    await expect(integration(page)).toHaveAttribute("data-state", "undone", { timeout: 60_000 })
    await expect(integration(page).getByTestId("team-integration-title")).toHaveText(`${NAME} 반영을 되돌렸어요`)
    await expect.poll(() => git(calc().home, ["rev-parse", "main"]), { timeout: 30_000 }).toBe(ids.base)
    await words(integration(page))
  })

  test("a change in the main folder that overlaps: the card waits with 다시 반영, which applies once it is put away", async () => {
    const saved = save(
      ids.folder,
      { "src/add.ts": "export const add = (a: number, b: number) => b + a\n" },
      "더하기 정리",
    )
    fs.writeFileSync(path.join(calc().home, "src/add.ts"), "export const add = (a: number, b: number) => a + b + 0\n")
    await areaMenu(page, "area-menu-integrate")
    const card = integration(page)
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 120_000 })
    // The waiting line; a muted line under it names what goes in without a ready report (7.1, both save points).
    const line = card.getByTestId("team-integration-line").filter({ hasText: "겹쳐요" })
    await expect(card.getByTestId("team-integration-line").filter({ hasText: "더하기 정리" })).toHaveText(
      "반영 준비 알림 없이 넣는 저장 지점 2개: 더하기 정리 · 입력 화면 정리",
    )
    await expect(line).toHaveText(
      "메인 폴더(calc)에서 아직 저장 지점에 넣지 않은 파일 1개와 겹쳐요. 그 변경을 저장 지점에 넣거나 되돌린 뒤 '다시 반영'을 누르세요",
    )
    const retry = card.getByTestId("team-integration-retry")
    await expect(retry).toHaveText("다시 반영")
    await card.getByTestId("team-integration-details-toggle").click()
    await expect(card.getByTestId("team-integration-details")).toContainText("src/add.ts")
    await words(card.getByTestId("team-integration-title"))
    await words(line)
    // The main folder keeps the user's change while it waits.
    expect(git(calc().home, ["rev-parse", "main"])).toBe(ids.base)

    git(calc().home, ["restore", "src/add.ts"])
    await retry.click()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-integration-title")).toHaveText(
      `${NAME} 작업을 프로젝트 본 코드에 반영했어요`,
    )
    expect(git(calc().home, ["rev-parse", "main"])).toBe(saved)
    ids.base = saved
  })

  test("반영하기 전에 묻기: the confirm waits in the card, focus on 두기; a phone at 375 px only sees it", async ({
    browser,
  }) => {
    await rpc(page, "own.team", "settings.set", { teamID: ids.team, patch: { policy: { mergeLocal: "ask" } } })
    const saved = save(ids.folder, { "README.md": "# calc\n\n입력 화면\n" }, "설명 고침")
    await areaMenu(page, "area-menu-integrate")
    const card = integration(page)
    const confirm = card.getByTestId("team-integration-confirm")
    await expect(confirm).toHaveText("반영하기", { timeout: 120_000 })
    await expect(card.getByTestId("team-integration-confirms")).toContainText(NAME)
    await words(card.getByTestId("team-integration-confirms"))
    // Nothing moves before the answer.
    expect(git(calc().home, ["rev-parse", "main"])).toBe(ids.base)

    // A paired phone (06 §9.8): the waiting card names the PC to answer on; once applied, no 되돌리기 and no upload,
    // only where to do it.
    await phone(browser, async (device) => {
      await open(device, ids.main)
      const shown = integration(device)
      await expect(shown.getByTestId("team-integration-confirms")).toContainText(`${state().pc}에서 확인하세요`)
      await expect(shown.getByTestId("team-integration-confirm")).toHaveCount(0)
      await words(shown)
      await noSideScroll(device)

      await confirm.click()
      const dialog = page.getByTestId("team-confirm")
      await expect(dialog).toHaveAttribute("role", "alertdialog")
      await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
      await expect(dialog.getByTestId("team-confirm-keep")).toHaveText("두기")
      await expect(dialog.getByTestId("team-confirm-do")).toHaveText("반영하기")
      await words(dialog)
      await page.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
      await expect(confirm).toBeFocused()

      await page.keyboard.press("Enter")
      await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
      await dialog.getByTestId("team-confirm-do").click()
      await expect(dialog).toHaveCount(0)
      await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
      await expect.poll(() => git(calc().home, ["rev-parse", "main"]), { timeout: 30_000 }).toBe(saved)

      await expect(shown).toHaveAttribute("data-state", "done", { timeout: 60_000 })
      await expect(shown.getByTestId("team-integration-undo")).toHaveCount(0)
      await expect(shown.getByTestId("team-integration-push")).toHaveCount(0)
      await expect(shown.getByTestId("team-integration-line")).toContainText([`${state().pc}에서 확인하세요`])
      await words(shown)
      const box = await shown.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(375)
      await noSideScroll(device)
    })
    await rpc(page, "own.team", "settings.set", { teamID: ids.team, patch: { policy: { mergeLocal: "auto" } } })
  })

  test("팀 모드 끄기; nothing showed a forbidden word or a placeholder; no page error", async () => {
    await projectMenu(page, calc().home, "project-menu-team-disable")
    const dialog = page.getByTestId("team-disable")
    await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused()
    await dialog.getByTestId("team-disable-keep").click()
    await expect(page.getByTestId("toasts")).toContainText("팀 모드를 껐어요", { timeout: 60_000 })
    expect(await teamsOn(page, calc().home)).toEqual([])

    expect(seen.length).toBeGreaterThan(5)
    const text = seen.join("\n")
    expect(FORBIDDEN.concat(ALSO).filter((word) => hits(text, word))).toEqual([])
    expect(text).not.toMatch(PLACEHOLDER)
    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** A conversation's row in the list: a click opens it in place (the window keeps what it heard). */
function row(page: Page, sessionID: string) {
  return page.locator(`[data-testid="session-row"][data-session-id="${sessionID}"]`)
}

/** The newest integration card above the team main (newest first). */
function integration(page: Page) {
  return page.getByTestId("team-integration").first()
}

/** A save point in the area folder, as the user working there makes one; returns its sha. */
function save(folder: string, files: Readonly<Record<string, string>>, message: string) {
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content)
  git(folder, ["add", "-A"])
  git(folder, ["commit", "-q", "-m", message])
  return git(folder, ["rev-parse", "HEAD"])
}

async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

async function open(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  await ready(page)
  // A project's first page load also compiles the transcript chunk in Vite dev: give it the connection's minute.
  await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)).toBeVisible({
    timeout: 60_000,
  })
}

/** The conversation on screen (`/srv/local/s/<id>`). */
function current(page: Page) {
  return new URL(page.url()).pathname.split("/").at(-1)!
}

/** Opens a `HostMenu` and picks an item. */
async function menu(page: Page, button: string, item: string) {
  await page.getByTestId(button).first().click()
  await page.getByTestId(item).click()
}

/** The project menu of the project whose main folder is `home` (the list also holds the other suites' projects). */
async function projectMenu(page: Page, home: string, item: string) {
  await page
    .getByTestId("project-row")
    .filter({ hasText: path.basename(home) })
    .getByTestId("project-menu")
    .click()
  await page.getByTestId(item).click()
}

function area(page: Page) {
  return page.getByTestId("area-row").filter({
    has: page.getByTestId("area-label").filter({ hasText: new RegExp(`^${NAME} · `) }),
  })
}

/** The area's menu by right click on its row, then an item. */
async function areaMenu(page: Page, item: string) {
  await area(page).click({ button: "right" })
  await areaMenuItem(page.getByTestId("area-menu"), item)
}

/** An RPC through the page's API path (the dev proxy adds the server's auth) at the control location. */
async function rpc(page: Page, id: string, method: string, input: unknown) {
  const response = await page.request.post(
    `/api/rpc/${id}/${method}?location%5Bdirectory%5D=${encodeURIComponent(state().control)}`,
    { data: { input } },
  )
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`${id} ${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

/** The teams that are on in the project whose main folder is `home`. */
async function teamsOn(page: Page, home: string) {
  const output = await rpc(page, "own.team", "team.list", {})
  return (output.teams as ReadonlyArray<{ readonly id: string; readonly state: string; readonly home: string }>)
    .filter((item) => item.state === "on" && same(item.home, home))
    .map((item) => item.id)
}

async function teamOf(page: Page, home: string) {
  await expect.poll(async () => (await teamsOn(page, home)).length).toBe(1)
  return (await teamsOn(page, home))[0]!
}

/** Turns off every team still on in `home`'s project (a failed run's leftovers), keeping its folders. */
async function off(page: Page, home: string) {
  for (const teamID of await teamsOn(page, home).catch(() => []))
    await rpc(page, "own.team", "disable", { teamID }).catch(() => undefined)
  await expect.poll(async () => (await teamsOn(page, home)).length, { timeout: 60_000 }).toBe(0)
}

function same(a: string, b: string) {
  const normal = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  return normal(a) === normal(b)
}

/** Git in a fixture folder of the backend (its repositories carry their own local settings). */
function git(cwd: string, args: readonly string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()
}

async function noSideScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0)
}

/** A paired phone (375 px, touch) on the backend's gateway stand-in: own-web runs its mobile host there. */
async function phone(browser: Browser, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({
    baseURL: state().device,
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "ko-KR",
  })
  const device = await context.newPage()
  const failures: string[] = []
  device.on("pageerror", (error) => failures.push(error.message))
  try {
    await run(device)
    expect(failures).toEqual([])
  } finally {
    await context.close()
  }
}
