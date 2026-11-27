// Git 저장소로 만들기 (03 §4.3.1, 06 §3.0) in the whole own-web app in Edge against backend.ts. Its `bios-mod` project
// is not a Git repository: the dimmed `[팀]` button opens the why and `Git 저장소로 만들기…`; the dialog shows the
// folder, what happens, the proposed .gitignore with what it leaves out, the files the first commit takes and the
// binary image left out unless picked; the first commit is made on `main` by the service (the files on disk prove it),
// `[팀]` lights up at once and the dialog offers `팀 모드 켜기…`. The project keeps its id (the same row, the same
// conversation). The conversation `⋯` of `rom-notes` offers the same under its note (2026-10-26, GI): the user looked
// there and found only the note. Without this suite's backend it skips.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type BrowserContext, type Page } from "@playwright/test"

interface Plain {
  readonly home: string
  readonly seed: string
}

interface GitInitState {
  readonly t3: { readonly gitInit: Plain; readonly gitMenu: Plain }
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as GitInitState
const plain = () => state().t3.gitInit
const notes = () => state().t3.gitMenu

test.describe.configure({ mode: "serial" })

test.describe("Git 저장소로 만들기 (06 §3.0)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test("the dimmed [팀] button opens the dialog; the first commit leaves the binary image out", async () => {
    const home = plain().home
    expect(fs.existsSync(path.join(home, ".git"))).toBe(false)
    await page.goto(`/srv/local/s/${plain().seed}`)
    await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
    // RH-51: the conversation first. While a page loads, its requests take every connection the browser opens to this
    // origin (six): a dialog opened then waited for its chunk and its `project.gitInit.plan` behind them (13 s, 23 s,
    // or not within 30 s, while a fresh backend still booted the listed folders' Locations; backend.ts boots them now).
    await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${plain().seed}"]`)).toBeVisible({
      timeout: 60_000,
    })
    const row = page.getByTestId("project-row").filter({ hasText: path.basename(home) })
    const team = row.getByTestId("project-team-button")
    await expect(team).toHaveAttribute("data-state", "not-git")
    // The button shows on hover only (this route is a conversation, not the project). In the full suite the other
    // workers' projects fill the sidebar above this one and their updates move the row from under the pointer, so
    // hover again until the click lands.
    await expect(async () => {
      await row.hover()
      await team.click({ timeout: 5_000 })
    }).toPass({ timeout: 60_000 })
    await expect(page.getByRole("menu").getByText("팀 모드는 Git 저장소인 프로젝트에서만")).toBeVisible()
    await page.getByTestId("project-git-init").click()

    const dialog = page.getByTestId("git-init")
    await expect(dialog).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
    await expect(dialog.getByTestId("git-init-folder")).toHaveText(home)
    await expect(dialog.getByTestId("git-init-what")).toContainText("기본 브랜치를 main으로 정해요")
    await expect(dialog.getByTestId("git-init-what")).toContainText("파일은 바꾸지 않아요")
    await expect(dialog.getByTestId("git-init-gitignore").locator("input")).toBeChecked()
    await expect(dialog.getByTestId("git-init-gitignore-leaves")).toContainText("파일 1개")
    // README, patch.c and the image; the image is left out by default: 2 files.
    await expect(dialog.getByTestId("git-init-summary")).toContainText("커밋할 파일 2개")
    const image = dialog.getByTestId("git-init-flagged-item").filter({ hasText: "bios/BOARD.CAP" })
    await expect(image.locator("input")).not.toBeChecked()
    await expect(dialog.getByTestId("git-init-flagged-note")).toContainText("Git LFS")
    if (await dialog.getByTestId("git-init-identity").isVisible()) {
      await expect(dialog.getByTestId("git-init-confirm")).toBeDisabled()
      await dialog.getByTestId("git-init-name").fill("E2E 사용자")
      await dialog.getByTestId("git-init-email").fill("e2e@example.invalid")
    }
    await expect(dialog.getByTestId("git-init-confirm")).toHaveText("만들고 첫 커밋하기")
    await dialog.getByTestId("git-init-confirm").click()

    await expect(dialog).toHaveAttribute("data-state", "done", { timeout: 60_000 })
    await expect(dialog.getByTestId("git-init-done")).toContainText("브랜치 main, 첫 커밋")
    await expect(dialog.getByTestId("git-init-done")).toContainText("커밋에서 뺀 1개는 폴더에 그대로 있어요")
    await expect(dialog.getByTestId("git-init-enable-team")).toBeVisible()

    const git = (...args: string[]) => spawnSync("git", ["-C", home, ...args], { encoding: "utf8" }).stdout.trim()
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([
      ".gitignore",
      "README.md",
      "src/patch.c",
    ])
    expect(fs.statSync(path.join(home, "bios", "BOARD.CAP")).size).toBe(1536 * 1024)

    await dialog.getByTestId("git-init-close").click()
    await expect(dialog).toHaveCount(0)
    // `[팀]` lights up at once (the project list was read again), on the same row and conversation.
    await row.hover()
    await expect(row.getByTestId("project-team-button")).not.toHaveAttribute("data-state", "not-git")
    await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${plain().seed}"]`)).toBeVisible()
    expect(errors).toEqual([])
  })

  test("the conversation ⋯ of a folder that is not a Git repository offers it under its note", async () => {
    const home = notes().home
    expect(fs.existsSync(path.join(home, ".git"))).toBe(false)
    await page.goto(`/srv/local/s/${notes().seed}`)
    await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
    await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${notes().seed}"]`)).toBeVisible({
      timeout: 60_000,
    })
    await page.getByTestId("session-menu").click()
    await expect(page.getByTestId("session-menu-not-git")).toHaveText(
      "팀 모드와 작업 폴더는 Git 저장소인 프로젝트에서만 쓸 수 있어요.",
    )
    await expect(page.getByTestId("session-menu-team-enable")).toHaveCount(0)
    await page.getByTestId("session-menu-git-init").click()

    const dialog = page.getByTestId("git-init")
    await expect(dialog).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
    await expect(dialog.getByTestId("git-init-folder")).toHaveText(home)
    await expect(dialog.getByTestId("git-init-summary")).toContainText("커밋할 파일 2개")
    if (await dialog.getByTestId("git-init-identity").isVisible()) {
      await dialog.getByTestId("git-init-name").fill("E2E 사용자")
      await dialog.getByTestId("git-init-email").fill("e2e@example.invalid")
    }
    await expect(dialog.getByTestId("git-init-confirm")).toHaveText("만들고 첫 커밋하기")
    await dialog.getByTestId("git-init-confirm").click()
    await expect(dialog).toHaveAttribute("data-state", "done", { timeout: 60_000 })
    await expect(dialog.getByTestId("git-init-done")).toContainText("브랜치 main, 첫 커밋")
    await expect(dialog.getByTestId("git-init-enable-team")).toBeVisible()

    const git = (...args: string[]) => spawnSync("git", ["-C", home, ...args], { encoding: "utf8" }).stdout.trim()
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n").sort()).toEqual([
      ".gitignore",
      "README.md",
      "notes/fan-curve.txt",
    ])

    // The same conversation's `⋯` now has `팀 모드 켜기` and no note (team mode is not turned on here).
    await dialog.getByTestId("git-init-close").click()
    await expect(dialog).toHaveCount(0)
    await page.getByTestId("session-menu").click()
    await expect(page.getByTestId("session-menu-team-enable")).toBeVisible()
    await expect(page.getByTestId("session-menu-not-git")).toHaveCount(0)
    await expect(page.getByTestId("session-menu-git-init")).toHaveCount(0)
    await page.keyboard.press("Escape")
    expect(errors).toEqual([])
  })
})
