// Settings 팀, 결정 적기 and 새 영역 (06 §9.8, §6.6, §8.8, §9.4; TG20's T2 surfaces) in the whole own-web app in Edge
// against backend.ts. Its `memo` project starts with no area. One PC window:
//   - settings 팀 from the project menu: every row saves at once (`settings.set`) and nothing says it waits for a later
//     version any more: 반영하기 전에 묻기, 영역과 직접 일할 때 (the hold switch and who tells the main, 2026-11-14),
//     the commands owners run without asking and their switch, the confirm thresholds, 결정 기록을 프로젝트에 남기기,
//     and other tools' path patterns; there is no 영역 수 기본 상한 row any more (no area limit);
//   - 고급 > 팀 지시문 (2026-11-14): the main's 일하는 방식 block saved and reset, counted as it is sent (Windows line
//     breaks once), a breaker line and an over-long block refused; only the screen copy is scanned for words;
//   - 결정 적기 from the project menu: focus on the title, Enter to the details, Ctrl+Enter writes record 1, and the
//     dialog then lists it (with the copy note while 결정 기록을 프로젝트에 남기기 is on);
//   - 새 작업 폴더 on the new-session screen of a project with a team on is 새 영역: a name and what it is for make an
//     area (its result card above the team main, its row in the team view), and plain 새 워크트리 is not offered;
//   - 375 px: the PC's settings page, and a paired phone (the backend's gateway stand-in) that sees the values with
//     the view-only notice that names the PC;
//   - 팀 모드 끄기, and no forbidden word, placeholder or page error anywhere these screens showed.
// Runs after team.spec.ts (playwright.config.ts); without this suite's backend it skips.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { enableTeam } from "./flows"

interface SettingsState {
  readonly device: string
  readonly pc: string
  readonly control: string
  readonly t2: { readonly settings: { readonly home: string; readonly seed: string } }
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as SettingsState
const memo = () => state().t2.settings
const MiB = 1024 ** 2
const DECISION = { title: "검색 결과는 서버에서 거른다", body: "화면에서 거르면 느려서 서버에서 거르기로 했다." }
const AREA = { name: "검색 기록", goal: "검색 기록 정리" }

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

test.describe("settings 팀, 결정 적기, 새 영역 (06 §9.8, §6.6, §8.8, TG20)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []
  const ids = { team: "", main: "" }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    // A failed run leaves no team on for the next spec.
    if (page) await off(page, memo().home)
    await context?.close()
  })

  test("팀 모드 켜기 on memo, its area folders beside the project (프로젝트 옆 폴더): no area yet", async () => {
    await open(page, memo().seed)
    await menu(page, "session-menu", "session-menu-team-enable")
    await enableTeam(page, { root: "beside" })
    await expect.poll(() => current(page), { timeout: 120_000 }).not.toBe(memo().seed)
    ids.main = current(page)
    ids.team = await teamOf(page, memo().home)
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 60_000 })
    await expect(card.getByTestId("team-card-line").first()).toHaveText("메인에게 할 일을 말하면 영역을 나눠 맡겨요.")
    await expect(page.getByTestId("team-pill")).toHaveText("팀 메인 · 영역 0개")
  })

  test("settings 팀: every row saves at once", async () => {
    await projectMenu(page, memo().home, "project-menu-team-settings")
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/settings/team/local/${ids.team}`)
    const form = page.getByTestId("settings-team-form")
    await expect(form).toBeVisible()
    await expect(page.getByTestId("settings-team-project")).toHaveText("memo")
    // 06 §4.12 (2026-10-27): where the team keeps its area folders, chosen when it was turned on; shown only.
    const root = page.getByTestId("settings-team-area-root")
    await expect(root).toContainText("프로젝트 옆 폴더")
    await expect(root).toContainText(/memo-team$/)
    // T2 applies every row: no `다음 버전부터 적용돼요` tag is left.
    await expect(page.getByTestId("settings-team")).not.toContainText("다음 버전부터 적용돼요")
    const status = page.getByTestId("settings-team-status")

    const ask = page.getByTestId("settings-team-merge-ask")
    await expect(ask).toHaveAttribute("aria-checked", "false")
    await ask.click()
    await expect(ask).toHaveAttribute("aria-checked", "true")
    await expect(status).toHaveText("저장했어요")
    expect((await settings(page)).policy.mergeLocal).toBe("ask")

    // 2026-11-14: no area limit, so no 영역 수 기본 상한 row.
    await expect(page.getByTestId("settings-team-max-areas")).toHaveCount(0)

    // 영역과 직접 일할 때: the hold switch (on by default) and who tells the main about direct work.
    const direct = page.getByTestId("settings-team-direct")
    await expect(direct).toContainText("영역과 직접 일할 때")
    const hold = page.getByTestId("settings-team-direct-hold")
    await expect(hold).toHaveAttribute("aria-checked", "true")
    await hold.click()
    await expect(hold).toHaveAttribute("aria-checked", "false")
    await expect.poll(async () => (await settings(page)).policy.directHold).toBe(false)
    await hold.click()
    await expect(hold).toHaveAttribute("aria-checked", "true")
    await expect.poll(async () => (await settings(page)).policy.directHold).toBe(true)
    const tell = page.getByTestId("settings-team-direct-tell")
    await expect(tell.locator('[data-value="judge"]')).toHaveAttribute("aria-checked", "true")
    await tell.locator('[data-value="always"]').click()
    await expect.poll(async () => (await settings(page)).policy.directTell).toBe("always")
    await tell.locator('[data-value="judge"]').click()
    await expect.poll(async () => (await settings(page)).policy.directTell).toBe("judge")
    await words(direct)

    // By keyboard: Space on the focused switch.
    const commit = page.getByTestId("settings-team-commit-decisions")
    await commit.focus()
    await page.keyboard.press("Space")
    await expect(commit).toHaveAttribute("aria-checked", "true")
    await expect.poll(async () => (await settings(page)).policy.commitDecisions).toBe(true)

    const download = page.getByTestId("settings-team-ask-download")
    await expect(download).toHaveValue("500")
    await download.fill("750")
    await download.press("Enter")
    await expect.poll(async () => (await settings(page)).policy.askDownloadBytes).toBe(750 * MiB)
    const disk = page.getByTestId("settings-team-ask-disk")
    await disk.fill("abc")
    await expect(page.getByTestId("settings-team-form").getByRole("alert")).toHaveCount(1)
    await disk.fill("2")
    await disk.blur()
    await expect(page.getByTestId("settings-team-form").getByRole("alert")).toHaveCount(0)

    const allow = page.getByTestId("settings-team-auto-allow")
    await allow.click()
    await expect(page.getByTestId("settings-team-auto-allow-off")).toHaveText("묻지 않고 실행하지 않기")
    await expect.poll(async () => (await settings(page)).policy.autoAllow).toBe(false)
    await allow.click()
    await expect(page.getByTestId("settings-team-auto-allow-off")).toHaveCount(0)
    await expect.poll(async () => (await settings(page)).policy.autoAllow).toBe(true)

    await page.getByTestId("settings-team-pattern-input").fill("tools/*/wt")
    await page.getByTestId("settings-team-pattern-add").click()
    await expect(page.getByTestId("settings-team-pattern")).toHaveCount(1)
    await expect(page.getByTestId("settings-team-pattern")).toContainText("tools/*/wt")
    await expect.poll(async () => (await settings(page)).patterns).toEqual(["tools/*/wt"])
    await page.getByTestId("settings-team-pattern").getByRole("button", { name: "지우기" }).click()
    await expect(page.getByTestId("settings-team-pattern")).toHaveCount(0)
    await expect.poll(async () => (await settings(page)).patterns).toEqual([])
    await words(page.getByTestId("settings-team"))

    // What was saved is what a new read shows.
    await page.reload()
    await expect(page.getByTestId("settings-team-merge-ask")).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("settings-team-commit-decisions")).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("settings-team-ask-download")).toHaveValue("750")
  })

  test("팀 지시문: edit 일하는 방식, counted as sent; a breaker line and an over-long block are refused; reset", async () => {
    await page.goto(`/settings/team/local/${ids.team}`)
    await expect(page.getByTestId("settings-team-form")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("settings-team-instructions-state")).toContainText("기본")
    await page.getByTestId("settings-team-instructions-open").click()
    await expect(page.getByTestId("settings-team-instructions")).toBeVisible()
    // The screen copy only (three elements share the id): the program's text and the block are the models' and may
    // name git steps the screens never do.
    const ui = page.getByTestId("settings-team-instructions-ui")
    await expect(ui).toHaveCount(3)
    await words(ui)
    const badge = page.getByTestId("settings-team-instructions-badge")
    await expect(badge).toHaveText("기본")
    const tabs = page.getByTestId("settings-team-instructions-tabs")
    await expect(tabs.locator('[data-value="main"]')).toHaveAttribute("aria-checked", "true")
    const block = page.getByTestId("settings-team-instructions-block")
    const count = page.getByTestId("settings-team-instructions-count")
    const save = page.getByTestId("settings-team-instructions-save")
    const error = page.getByTestId("settings-team-instructions-error")
    const standard = (await settings(page)).instructions?.main.standard ?? ""
    await expect(block).toHaveValue(standard)
    await expect(save).toBeDisabled()

    // The count is of the text as it is sent, trimmed. (A browser textarea already turns CRLF into LF, so the CRLF
    // rule itself is covered by the unit test of `normalize`, settings/team-instructions.test.ts.)
    const edited = "- 보고는 짧게 한다.\n- 막히면 바로 묻는다."
    await block.fill("- 보고는 짧게 한다.\r\n- 막히면 바로 묻는다.\r\n")
    await expect(count).toHaveText(`${edited.length} / 2,000자`)
    // A line that starts like the harness's own markers is refused here.
    await block.fill("- 보고는 짧게 한다.\n</context>")
    await expect(error).toHaveText("'</context>', '<context key=', 'Today's date:'로 시작하는 줄은 쓸 수 없어요.")
    await expect(save).toBeDisabled()
    // Over 2,000 characters: refused with how far over, never cut.
    await block.fill("가".repeat(2_001))
    await expect(error).toHaveText("2,000자를 1자 넘었어요")
    await expect(save).toBeDisabled()
    await words(ui)

    await block.fill(edited)
    await expect(error).toHaveCount(0)
    await save.click()
    await expect.poll(async () => (await settings(page)).instructions?.main.custom).toBe(edited)
    await expect(badge).toHaveText("고쳐 씀")
    // The other roles keep their defaults.
    await tabs.locator('[data-value="owner"]').click()
    await expect(badge).toHaveText("기본")
    await expect(page.getByTestId("settings-team-instructions-reset")).toHaveCount(0)
    await words(ui)
    await tabs.locator('[data-value="main"]').click()

    // 기본으로 되돌리기 asks once.
    await page.getByTestId("settings-team-instructions-reset").click()
    await expect(page.getByTestId("settings-team-instructions-reset-ask")).toContainText(
      "일하는 방식을 기본 글로 되돌릴까요?",
    )
    await words(ui)
    await page.getByTestId("settings-team-instructions-reset-do").click()
    await expect.poll(async () => (await settings(page)).instructions?.main.custom).toBeUndefined()
    await expect(badge).toHaveText("기본")
    await expect(block).toHaveValue(standard)
    await page.getByTestId("settings-team-instructions-back").click()
    await expect(page.getByTestId("settings-team-form")).toBeVisible()
  })

  test("결정 적기 writes record 1 and lists it, with the copy note while records are kept in the project", async () => {
    await open(page, ids.main)
    await projectMenu(page, memo().home, "project-menu-team-decide")
    const dialog = page.getByTestId("team-decide")
    await expect(dialog.getByTestId("team-decide-title")).toBeFocused()
    await expect(dialog.getByTestId("team-decide-copy")).toHaveText(
      "'결정 기록을 프로젝트에 남기기'가 켜져 있어 메인이 사본을 프로젝트에 남겨요",
    )
    await expect(dialog.getByTestId("team-decide-list")).toContainText("아직 결정 기록이 없어요")
    await expect(dialog.getByTestId("team-decide-save")).toBeDisabled()
    await words(dialog)
    await page.keyboard.type(DECISION.title)
    await page.keyboard.press("Enter")
    await expect(dialog.getByTestId("team-decide-body")).toBeFocused()
    await page.keyboard.type(DECISION.body)
    await page.keyboard.press("Control+Enter")
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("toasts")).toContainText("결정 기록 1번을 적었어요")
    const listed = await rpc(page, "own.team", "decisions.list", { teamID: ids.team })
    expect(listed.items).toEqual([expect.objectContaining({ number: 1, title: DECISION.title, source: "user" })])

    await projectMenu(page, memo().home, "project-menu-team-decide")
    await expect(dialog.getByTestId("team-decide-list")).toContainText(`1. ${DECISION.title} · 사용자가 적음`)
    await words(dialog)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  })

  test("새 작업 폴더 in a team project is 새 영역: 영역 만들기 with a name and its role makes an area", async () => {
    await page
      .getByTestId("project-row")
      .filter({ hasText: path.basename(memo().home) })
      .getByTestId("project-new-session")
      .click()
    const select = page.getByTestId("worktree-select")
    // A team project's own checkout is 메인 폴더, where the team main works (03 §14.1, 06 §9.1).
    await expect(select).toContainText("메인 폴더")
    await select.click()
    const pop = page.getByTestId("worktree-popover")
    await expect(pop.getByTestId("worktree-picker")).toBeVisible()
    await expect(pop.getByTestId("worktree-option-local")).toContainText("메인 폴더")
    const option = pop.getByTestId("worktree-option-new-area")
    await expect(option).toHaveText("새 영역")
    await expect(pop.getByTestId("worktree-option-new")).toHaveCount(0)
    // 2026-10-26: 새 영역 closes the picker and opens 영역 만들기 (team/create-area.tsx).
    await option.click()
    await expect(pop).toBeHidden()
    const form = page.getByTestId("team-create-area")
    await expect(form.getByTestId("team-create-area-submit")).toBeDisabled()
    await form.getByTestId("team-create-area-name").fill(AREA.name)
    await form.getByTestId("team-create-area-role").fill(AREA.goal)
    await words(form)
    await form.getByTestId("team-create-area-submit").click()
    await expect(page.getByTestId("toasts")).toContainText(`'${AREA.name}' 영역을 만드는 중이에요`)
    await expect(form).toHaveCount(0)

    await open(page, ids.main)
    const card = page.locator('[data-testid="team-card"][data-kind="reorg"]').first()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.locator("h3")).toHaveText("팀 구성을 바꿨어요")
    await expect(
      card.getByTestId("team-card-line").filter({ hasText: `'${AREA.name}' 영역을 만들었어요` }),
    ).toHaveCount(1)
    await words(card)
    // A name without Latin letters or digits gives the folder the name `area` (view-model.ts `newAreaProposal`).
    const row = page.getByTestId("area-row").filter({
      has: page.getByTestId("area-label").filter({ hasText: `${AREA.name} · 담당` }),
    })
    await expect(row.getByTestId("area-line")).toHaveText(/^memo-team[\\/]area · 모델: 팀과 같게$/, { timeout: 60_000 })
    await words(row)
    await expect(page.getByTestId("team-pill")).toHaveText("팀 메인 · 영역 1개")
  })

  test("375 px: the PC's settings page fits; a paired phone sees the values and where to change them", async ({
    browser,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    try {
      await page.goto(`/settings/team/local/${ids.team}`)
      await expect(page.getByTestId("settings-team-form")).toBeVisible({ timeout: 60_000 })
      await noSideScroll(page)
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    await phone(browser, async (device) => {
      await device.goto("/settings/team")
      const form = device.getByTestId("settings-team-form")
      await expect(form).toBeVisible({ timeout: 60_000 })
      await expect(device.getByTestId("settings-team-view-only")).toHaveText(`${state().pc}에서 바꾸세요`)
      await expect(device.getByTestId("settings-team-merge-ask")).toHaveText("켜짐")
      await expect(device.getByTestId("settings-team-merge-ask")).not.toHaveAttribute("role", "switch")
      await expect(device.getByTestId("settings-team-pattern-input")).toHaveCount(0)
      await expect(device.getByTestId("settings-team-direct-hold")).toHaveText("켜짐")
      await expect(device.getByTestId("settings-team-direct-tell")).toHaveText("담당이 판단")
      await words(device.getByTestId("settings-team"))
      // 팀 지시문 opens read-only: the block shows, nothing saves.
      await device.getByTestId("settings-team-instructions-open").click()
      await expect(device.getByTestId("settings-team-instructions-block")).toHaveAttribute("readonly", "")
      await expect(device.getByTestId("settings-team-instructions-save")).toHaveCount(0)
      await words(device.getByTestId("settings-team-instructions-ui"))
      await noSideScroll(device)
    })
  })

  test("팀 모드 끄기; nothing showed a forbidden word or a placeholder; no page error", async () => {
    await open(page, ids.main)
    await projectMenu(page, memo().home, "project-menu-team-disable")
    const dialog = page.getByTestId("team-disable")
    await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused()
    await dialog.getByTestId("team-disable-keep").click()
    await expect(page.getByTestId("toasts")).toContainText("팀 모드를 껐어요", { timeout: 60_000 })
    expect(await teamsOn(page, memo().home)).toEqual([])

    expect(seen.length).toBeGreaterThan(5)
    const text = seen.join("\n")
    expect(FORBIDDEN.concat(ALSO).filter((word) => hits(text, word))).toEqual([])
    expect(text).not.toMatch(PLACEHOLDER)
    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

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

interface Saved {
  readonly policy: {
    readonly mergeLocal: string
    readonly commitDecisions: boolean
    readonly autoAllow: boolean
    readonly askDownloadBytes: number
    readonly directHold?: boolean
    readonly directTell?: string
  }
  readonly patterns: readonly string[]
  readonly instructions?: Readonly<
    Record<"main" | "owner" | "peer", { readonly standard: string; readonly custom?: string }>
  >
}

/** What the service holds now (`settings.get`). */
async function settings(page: Page) {
  const teamID = (await teamsOn(page, memo().home))[0]
  return (await rpc(page, "own.team", "settings.get", { teamID })) as unknown as Saved
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
