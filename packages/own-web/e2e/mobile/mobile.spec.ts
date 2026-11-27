// The phone's main flows (MUX 2026-11-06, decisions MUX, manual 23장): the conversation list and a conversation, the
// composer's folded tools, the model and account sheet, the new-conversation screen, an approval card answered with a
// thumb, the running hint, settings that are changed on the PC, the app's back button (window.ownApp.back), and no
// sideways scroll. The landscape project (915x412, the tablet tier by width) checks that what a phone on its side
// shows fits the short screen.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"

interface World {
  readonly sessions: Readonly<Record<string, string>>
}

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

/** The Android app's back button: what PcActivity asks the page first (src/host/app-bridge.ts). */
const appBack = () => (window as { ownApp?: { back(): boolean } }).ownApp?.back()

/** The phone tier's projects: the Fold8's unfolded screens are the tablet tier (fold8.spec.ts), its Ultra's cover is a
    412 px phone like `phone-412`. */
const portrait = (name: string) => ["phone-360", "phone-412", "s23", "fold8-cover"].includes(name)

async function openSession(page: Page, key: string) {
  const id = world().sessions[key]!
  await page.goto(`/srv/local/s/${id}`)
  await page.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
  // The running-on pill once the accounts store answered (it names the account then). It is the phone's one model
  // control: a bound conversation's composer hides its own button (S23 pass).
  await expect(page.getByTestId("running-on").first()).not.toContainText("own-codex", { timeout: 60_000 })
}

async function box(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error("not laid out")
  return value
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
}

test.describe("phone", () => {
  test.beforeEach(({}, info) => test.skip(!portrait(info.project.name), "the phone tier (portrait widths)"))

  test("list → conversation → back; the lone 대화 tab strip is gone, 프로젝트 노트 is in ⋯", async ({ page }) => {
    await page.goto("/")
    await page.getByTestId("session-row").first().waitFor({ timeout: 60_000 })
    await noSidewaysScroll(page)
    // No keyboard shortcuts on a touch list.
    await expect(page.locator(".own-sidebar kbd").first()).toBeHidden()
    await page.getByText("적 AI 길찾기 고치기").first().tap()
    await page.getByTestId("header-back").waitFor()
    await expect(page.locator(".own-workspace-tabs")).toBeHidden()
    await expect(page.getByTestId("browser-tool-notice").first()).toBeHidden()
    await noSidewaysScroll(page)

    await page.getByTestId("session-menu").first().tap()
    await page.getByTestId("session-menu-project-notes").tap()
    await expect(page.locator(".own-workspace-tabs")).toBeVisible()
    await expect(page.locator(".own-workspace-tabs [role=tab]")).toHaveCount(2)
    await page.locator(".own-workspace-tabs [role=tab]").first().tap()

    await page.getByTestId("header-back").tap()
    await expect(page).toHaveURL(/\/$/)
    await page.getByTestId("session-row").first().waitFor()
  })

  test("composer: ⋯ puts the folded tools on their own line and 전송 stays on the first", async ({ page }) => {
    await openSession(page, "enemy")
    const send = page.getByTestId("composer-send").first()
    const more = page.getByTestId("composer-more").first()
    await expect(page.getByTestId("composer-switcher").first()).toBeHidden()
    await more.tap()
    await page.getByTestId("composer-preset-wrap").first().waitFor()
    const first = await box(more)
    const sent = await box(send)
    const preset = await box(page.getByTestId("composer-preset-wrap").first())
    expect(Math.abs(sent.y - first.y)).toBeLessThan(4)
    expect(sent.x).toBeGreaterThan(first.x)
    expect(preset.y).toBeGreaterThan(first.y + first.height - 1)
    for (const tool of await page.locator(".own-cp-bar .own-cp-tool:visible, .own-cp-send:visible").all()) {
      const size = await box(tool)
      expect(Math.round(size.height)).toBeGreaterThanOrEqual(44)
    }
  })

  test("모델 @ 계정 sheet: no keyboard on open, 44 px choices, the model list's heading on top; back closes it", async ({
    page,
  }) => {
    await openSession(page, "enemy")
    await page.getByTestId("running-on-pill").first().tap()
    const sheet = page.getByTestId("switcher")
    await expect(sheet).toHaveClass(/own-sw-sheet/)
    // The search box takes the focus only when tapped (the phone's keyboard would cover the list).
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).not.toBe("switcher-search")
    await expect(sheet.locator(".own-sw-models > .own-sw-group").first()).toBeInViewport()
    for (const choice of await sheet.locator(".own-sw-seg button").all())
      expect((await box(choice)).height).toBeGreaterThanOrEqual(44)
    // Tapping an account keeps the keyboard down too.
    await sheet.locator(".own-sw-account").nth(1).tap()
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).not.toBe("switcher-search")
    // The Android app's back button (PcActivity → window.ownApp.back()).
    expect(await page.evaluate(appBack)).toBe(true)
    await expect(sheet).toBeHidden()
    // Nothing open: back is the shell's (history, then the PC list).
    expect(await page.evaluate(appBack)).toBe(false)
  })

  test("new conversation: a way back, touch hints, the account on a line of its own", async ({ page }) => {
    await page.goto("/srv/local/new")
    await page.getByTestId("header-back").waitFor({ timeout: 60_000 })
    await expect(page.getByTestId("discover-hints-settings")).toHaveText(
      /머리줄의 톱니바퀴나 대화 목록 아래의 \[설정\]/,
    )
    const switcher = page.getByTestId("composer-switcher").first()
    await expect(switcher).toBeVisible()
    // Not cut to `C…`: the button holds its whole label.
    expect(await switcher.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    // The folder is known (the button takes its line's room with the path), then the line is measured.
    const tail = page.getByTestId("project-select").first().getByTestId("path-tail")
    await expect(tail).toContainText("Own OpenCode", { timeout: 60_000 })
    const project = await box(page.getByTestId("project-select").first())
    expect((await box(switcher)).y).toBeGreaterThan(project.y + project.height - 1)
    // `기본 대화 폴더` over the folder's path (its end where it is long), both inside the 44 px button; nothing moves.
    const line = await box(tail)
    expect(project.height).toBe(44)
    expect(line.y).toBeGreaterThan(project.y + 14)
    expect(line.y + line.height).toBeLessThanOrEqual(project.y + project.height)
    expect(line.x + line.width).toBeLessThanOrEqual(project.x + project.width)
    expect(project.x + project.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8)
    expect((await box(page.getByTestId("skills-button").first())).y).toBe(project.y)
    await noSidewaysScroll(page)
    await page.screenshot({ path: test.info().outputPath("new-conversation-folder.png") })
    // The folder picker is a native popover: the app's back closes it and stays on the screen (seen on the G7).
    await page.getByTestId("project-select").first().tap()
    await expect(page.getByTestId("project-select-menu")).toBeVisible()
    const option = page.getByTestId("project-select-no-folder")
    await expect(option.getByTestId("path-tail")).toContainText("Own OpenCode")
    const menu = await box(page.getByTestId("project-select-menu"))
    expect(menu.x + menu.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.screenshot({ path: test.info().outputPath("new-conversation-folder-menu.png") })
    expect(await page.evaluate(appBack)).toBe(true)
    await expect(page.getByTestId("project-select-menu")).toBeHidden()
    // The keyboard up (the G7 kept 471 of 816 px): the hints card gives way and `전송` stays on screen.
    const size = page.viewportSize()!
    await page.setViewportSize({ width: size.width, height: 471 })
    await expect(page.getByTestId("discover-hints")).toBeHidden()
    const send = await box(page.getByTestId("composer-send").first())
    expect(send.y + send.height).toBeLessThanOrEqual(471)
    await page.setViewportSize(size)
    await page.getByTestId("header-back").tap()
    await expect(page).toHaveURL(/\/$/)
  })

  test("a tap on 전송 before the accounts and defaults answered says it is loading (RL5-1)", async ({ page }) => {
    // Hold `presets.list` (the group defaults) and the conversation list (the folder's last model): until they answer
    // the screen has no "모델 @ 계정". RL4 found a tap in that window refused with `첫 계정을 추가하세요` although the
    // phone's PC has accounts.
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const loads = [/\/rpc\/own\.accounts\/presets\.list(\?|$)/, /\/api\/session\?/]
    for (const pattern of loads)
      await page.route(pattern, async (route) => {
        await held
        await route.continue()
      })
    await page.goto("/srv/local/new")
    const input = page.locator("#own-composer-input")
    await input.waitFor({ timeout: 60_000 })
    await input.tap()
    await input.fill("불러오는 중에 보내기")
    await page.getByTestId("composer-send").first().tap()
    await expect(page.getByTestId("toast").filter({ hasText: "계정과 모델을 불러오는 중이에요" })).toBeVisible()
    await expect(page.getByTestId("toast").filter({ hasText: "첫 계정을 추가하세요" })).toHaveCount(0)
    await expect(input).toHaveValue("불러오는 중에 보내기")
    expect(page.url()).not.toMatch(/\/s\//)
    release()
    await expect(page.getByTestId("composer-switcher").first()).toContainText("ChatGPT 01", { timeout: 60_000 })
    for (const pattern of loads) await page.unroute(pattern)
    await input.fill("")
  })

  test("a phone's new conversation starts under 묻기: the write asks, answered with a thumb", async ({ page }) => {
    await page.goto("/srv/local/new")
    const input = page.locator("#own-composer-input")
    await input.waitFor({ timeout: 60_000 })
    await expect(page.getByTestId("approval-pill")).toContainText("묻기")
    // The screen's folder and model are known first: a send before that is refused (`noTarget`: the toast `첫 계정을
    // 추가하세요`, the text stays in the box). With dist/ cached the tap came 0.3 s after the page loaded, before the
    // presets and the policy had answered and the switcher named the account (RL4).
    await expect(page.getByTestId("project-select").first()).toContainText("기본 대화 폴더", { timeout: 60_000 })
    await expect(page.getByTestId("composer-switcher").first()).toContainText("ChatGPT 01", { timeout: 60_000 })
    await input.tap()
    await input.fill("적 AI가 벽에 자꾸 부딪혀요. 고쳐 주세요")
    await page.getByTestId("composer-send").first().tap()
    await page.waitForURL(/\/s\//, { timeout: 60_000 })
    await expect(page.getByTestId("approval-pill")).toContainText("묻기", { timeout: 60_000 })
    const allow = page.getByTestId("permission-once")
    await allow.waitFor({ timeout: 120_000 })
    await noSidewaysScroll(page)
    for (const answer of [allow, page.getByTestId("permission-reject")]) {
      const size = await box(answer)
      expect(size.height).toBeGreaterThanOrEqual(44)
      expect(size.width).toBeGreaterThanOrEqual(88)
    }
    await allow.tap()
    await expect(page.getByText("경로 탐색을 고쳤어요").first()).toBeVisible({ timeout: 120_000 })
  })

  test("the approval menu: every mode from the phone, 전체 허용 after the PC's confirmation (MUX-15)", async ({ page }) => {
    await openSession(page, "menu")
    await page.getByTestId("approval-pill").tap()
    const menu = page.getByTestId("approval-menu")
    for (const mode of ["ask", "read-only", "full"]) await expect(menu.getByTestId(`approval-mode-${mode}`)).toBeEnabled()
    await expect(menu.getByTestId("approval-no-scope")).toHaveCount(0)
    // 전체 허용 asks first, with thumb-sized answers; the app's back button cancels the question, not the menu.
    await menu.getByTestId("approval-mode-full").tap()
    const confirm = menu.getByTestId("approval-confirm-full")
    await expect(confirm).toBeVisible()
    expect((await box(confirm)).height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(appBack)).toBe(true)
    await expect(menu.getByTestId("approval-confirm")).toHaveCount(0)
    await menu.getByTestId("approval-mode-full").tap()
    await menu.getByTestId("approval-confirm-full").tap()
    await expect(page.getByTestId("approval-pill")).toContainText("전체 허용", { timeout: 30_000 })
    await page.getByTestId("approval-pill").tap()
    await page.getByTestId("approval-menu").getByTestId("approval-mode-ask").tap()
    await expect(page.getByTestId("approval-pill")).toContainText("묻기", { timeout: 30_000 })
    // The toast sits under the header, not over 전송.
    const toast = page.getByTestId("toast").first()
    await toast.waitFor()
    expect((await box(toast)).y + (await box(toast)).height).toBeLessThan((await box(page.getByTestId("composer"))).y)
  })

  test("running: the hint names the buttons, not the keys", async ({ page }) => {
    await page.goto("/srv/local/new")
    const input = page.locator("#own-composer-input")
    await input.waitFor({ timeout: 60_000 })
    await input.tap()
    await input.fill("적 스폰 위치를 고쳐 줘")
    await page.getByTestId("composer-send").first().tap()
    await expect(page.getByTestId("composer-hint")).toHaveText(/멈추려면 \[중단\]/, { timeout: 60_000 })
    await expect(page.getByTestId("composer-hint")).not.toContainText("Ctrl")
    await page.getByTestId("composer-stop").first().tap()
  })

  test("settings: what is changed on the PC is named apart; 일반 has no send key on touch", async ({ page }) => {
    await page.goto("/settings")
    const pcOnly = page.getByTestId("settings-group-pc-only")
    await pcOnly.waitFor({ timeout: 60_000 })
    for (const section of ["layout", "shortcuts", "devices", "import", "creator", "updates"])
      await expect(pcOnly.getByTestId(`settings-pc-only-${section}`)).toContainText("PC에서 바꿀 수 있어요")
    await expect(pcOnly.getByTestId("settings-pc-only-creator")).toContainText("확장 (코드 플러그인 포함)")
    await expect(page.getByTestId("settings-nav-layout")).toHaveCount(0)
    await noSidewaysScroll(page)
    await page.goto("/settings/updates")
    await expect(page.getByText("이 설정은 PC에서 바꿀 수 있어요.")).toBeVisible()
    await page.goto("/settings/general")
    await page.getByTestId("settings-theme").waitFor()
    await expect(page.getByTestId("settings-send-key")).toHaveCount(0)
  })

  test("a prompt's menu: 44 px chevron and items, 이 지점으로 복원 in own words (upstream ae0fde771d)", async ({
    page,
  }) => {
    await openSession(page, "enemy")
    const prompt = page.getByTestId("transcript").locator('[data-component="user-message"]').last()
    const chevron = prompt.getByRole("button", { name: "메시지 메뉴" })
    await chevron.scrollIntoViewIfNeeded()
    const target = await box(chevron)
    expect(Math.round(Math.min(target.width, target.height))).toBeGreaterThanOrEqual(44)
    await chevron.tap()
    const items = page.getByRole("menu").getByRole("menuitem")
    await expect(items.filter({ hasText: "이 지점으로 복원" })).toHaveCount(1)
    for (const item of await items.all()) expect(Math.round((await box(item)).height)).toBeGreaterThanOrEqual(44)
    await noSidewaysScroll(page)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toHaveCount(0)
  })

  test("a code block's copy button covers the line on a solid chip", async ({ page }) => {
    await openSession(page, "enemy")
    const copy = page.locator('[data-slot="markdown-copy-button"]').last()
    await copy.scrollIntoViewIfNeeded()
    expect(await copy.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(
      /rgba\(0, 0, 0, 0\)|transparent/,
    )
  })
})

test.describe("landscape", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "landscape", "a phone on its side"))

  test("the conversation and its composer fit the short screen, nothing scrolls sideways", async ({ page }) => {
    await openSession(page, "enemy")
    await noSidewaysScroll(page)
    const composer = await box(page.getByTestId("composer"))
    expect(composer.y + composer.height).toBeLessThanOrEqual(412)
    // The transcript keeps at least a third of the height.
    expect(composer.y).toBeGreaterThan(412 / 3)
    // A handheld conversation's one model control is the header pill (S23, Fold8 passes).
    await page.getByTestId("running-on-pill").first().tap()
    const sheet = await box(page.getByTestId("switcher"))
    expect(sheet.y).toBeGreaterThanOrEqual(0)
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(412)
  })
})
