// Group M: the main demo world (space-game, billing-service; ChatGPT 01–03, DeepSeek, Anthropic, Claude 구독).
// Shots that only look come first; the ones that change the world (switches, compaction, computer use) come last,
// in an order where each finds what it needs.
import type { Locator, Page } from "../lib/browser"
import type { Ctx, Endpoints, Shot } from "../lib/ctx"
import { mappings } from "../lib/privacy"
import { start } from "../lib/world"

export interface MainState extends Endpoints {
  readonly root: string
  readonly control: string
  readonly demo: string
  readonly home: string
  readonly project: string
  readonly projects: { readonly space: string; readonly billing: string; readonly shop: string; readonly pixel?: string }
  readonly sessions: Readonly<Record<string, string>>
  readonly presets: { readonly light: string; readonly review: string; readonly deepseek: string }
  readonly accounts: Readonly<Record<string, string>>
  /** The home of the other tools' stores (`.codex`, `.claude`; main world only), shown as the demo user's home. */
  readonly toolsHome?: string
  /** The added Claude accounts are shown as after the local patch (lib/claude.ts). */
  readonly claudePatched?: boolean
}

export const mainPaths = (state: MainState) => ({
  demo: state.demo,
  home: state.home,
  root: state.root,
  ...(state.toolsHome ? { extra: mappings({ home: state.toolsHome }) } : {}),
})

export function bootMain(team = false) {
  return start<MainState>(
    team ? "team" : "main",
    {
      script: "e2e/manual/backend.ts",
      env: {
        OWN_MANUAL_WORLD: "main",
        // A free port of your own when other checkouts capture at the same time (OWN_MANUAL_PORT and the next one).
        OWN_MANUAL_PORT: process.env.OWN_MANUAL_PORT ?? (team ? "6321" : "6301"),
        OWN_MANUAL_TEAM: team ? "1" : "0",
      },
      ready: "OWN_MANUAL_READY",
    },
    mainPaths,
  )
}

type C = Ctx<MainState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<MainState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

/** The switcher (`Ctrl+.`) of the open session. */
async function switcher(page: Page) {
  await page.keyboard.press("Control+.")
  await tid(page, "switcher").waitFor()
  return tid(page, "switcher")
}

async function pick(page: Page, account: string) {
  await page.locator(`[data-testid=switcher-account][data-account-id=${account}]`).click()
  await page.waitForTimeout(1200)
}

/** The right panel on one of its tabs. */
async function panel(page: Page, tab: "accounts" | "review" | "files" | "browser") {
  if (!(await tid(page, "panel").isVisible().catch(() => false))) await tid(page, "panel-toggle").first().click()
  await page.locator(`#own-tab-${tab}`).click()
  await page.waitForTimeout(600)
}

/** DeepSeek's answer when the prepaid balance is used up (HTTP 402). */
const INSUFFICIENT = {
  type: "error",
  status: 402,
  body: { error: { message: "Insufficient Balance", type: "unknown_error" } },
}

/** Closes the right panel (settings and pages get the whole width). */
async function closePanel(page: Page) {
  if (await tid(page, "panel").isVisible().catch(() => false)) await tid(page, "panel-toggle").first().click()
  await page.waitForTimeout(300)
}

/** A page of the app (`/accounts`, `/settings/<section>`, …) without the right panel. */
async function open(ctx: C, path: string, options: { readonly scheme?: "dark" | "light" } = {}) {
  const page = await ctx.page({ ...options, path })
  await page.waitForTimeout(1500)
  await closePanel(page)
  return page
}

/** An account card of the accounts page. */
const card = (page: Page, account: string) => page.locator(`[data-testid=account-card][data-account-id=${account}]`)

/** Types into the composer of the open session. */
async function type(page: Page, text: string) {
  const input = tid(page, "composer").locator("[contenteditable=true], textarea").first()
  await input.click()
  await input.fill(text)
}

/** Types and sends (Ctrl+Enter, the default `보내는 키`) in the open session. */
async function send(page: Page, text: string) {
  await type(page, text)
  await page.keyboard.press("Control+Enter")
}

/** Sets the open session's approval mode (`묻기`, …) from the header pill. */
async function approval(page: Page, mode: string) {
  await tid(page, "approval-pill").click()
  await tid(page, "approval-menu").getByRole("menuitemradio").filter({ hasText: mode }).first().click()
  await page.waitForTimeout(800)
  await dismissToasts(page)
}

/** Closes the toasts on screen (a confirmation of the step before the shot). */
async function dismissToasts(page: Page) {
  for (const close of await tid(page, "toast").getByRole("button", { name: /닫기|×/ }).all())
    await close.click().catch(() => undefined)
  await page.waitForTimeout(300)
}

/** The menu a `HostMenu` button opened (role menu, named like its button). */
const menu = (page: Page, name: string) => page.getByRole("menu", { name })

/** space-game's `다른 도구의 대화` list (21장), opened from its sidebar row once the scan has found all four. */
async function importList(ctx: C) {
  const page = await ctx.session(ctx.state.sessions.enemy!)
  await closePanel(page)
  const entry = tid(page, "import-entry").first()
  await entry.waitFor({ timeout: 120_000 })
  await entry.click()
  await tid(page, "page-import").waitFor()
  await tid(page, "import-total").filter({ hasText: "4개" }).waitFor({ timeout: 60_000 })
  await tid(page, "import-scanning").waitFor({ state: "detached", timeout: 60_000 }).catch(() => undefined)
  await page.waitForTimeout(800)
  return page
}

const SHOTS: ReadonlyArray<Shot<MainState>> = [
  shot("05-tour", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, "accounts")
    await ctx.shoot(page, "05-tour", {
      marks: [
        tid(page, "sidebar"),
        tid(page, "header"),
        tid(page, "transcript"),
        tid(page, "composer"),
        tid(page, "panel"),
      ],
    })
  }),
  shot("05-tour-light", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!, { scheme: "light" })
    // Without the work panel: a conversation's header drops the theme button first when it narrows (03 §4.4).
    await closePanel(page)
    await ctx.shoot(page, "05-tour-light", { marks: [tid(page, "theme-toggle")] })
  }),
  shot("06-switcher", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    // Tall enough for the whole account list above the footer.
    await page.setViewportSize({ width: 1440, height: 1300 })
    const dialog = await switcher(page)
    await pick(page, ctx.state.accounts.deepseek!)
    // A little air above and below the cost line, so its box covers that line alone.
    await page.addStyleTag({ content: "[data-testid=switcher-cost]{margin-block:10px !important}" })
    await page.waitForTimeout(300)
    await ctx.shoot(page, "06-switcher", {
      clip: dialog,
      marks: [tid(page, "switcher-cost"), page.locator(`[data-testid=switcher-account][data-account-id=acc_tm03]`)],
    })
  }),
  shot("04-approval-menu", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await tid(page, "approval-pill").click()
    const menu = tid(page, "approval-menu")
    await menu.waitFor()
    await ctx.shoot(page, "04-approval-menu", {
      clip: [menu, tid(page, "approval-pill")],
      marks: [menu.getByText("묻기", { exact: true })],
    })
  }),
  shot("14-preset-menu", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    // The composer folds these tools behind ⋯ while the work panel is open (03 §4.6).
    await closePanel(page)
    await tid(page, "composer-preset").click()
    const menu = tid(page, "preset-menu")
    await menu.waitFor()
    await ctx.shoot(page, "14-preset-menu", {
      clip: [menu, tid(page, "composer-preset")],
      marks: [menu.getByText("★ 가볍게 나눠 쓰기").first(), menu.getByText("평소대로", { exact: true }).first()],
    })
  }),
  shot("16-speed-menu", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    // The composer folds these tools behind ⋯ while the work panel is open (03 §4.6).
    await closePanel(page)
    await tid(page, "composer-speed").click()
    const menu = tid(page, "composer-speed-menu")
    await menu.waitFor()
    await ctx.shoot(page, "16-speed-menu", {
      clip: [menu, tid(page, "composer-speed")],
      marks: [menu.getByText(/Fast/).first()],
    })
  }),
  shot("13-meter", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.log!)
    await tid(page, "context-meter").click()
    const popover = tid(page, "context-meter-popover")
    await popover.waitFor()
    await ctx.shoot(page, "13-meter", {
      clip: [popover, tid(page, "context-meter")],
      marks: [popover.locator(".own-cp-pop-title"), popover.locator(".own-cp-pop-actions")],
    })
  }),
  shot("05-theme-setting", async (ctx) => {
    const page = await open(ctx, "/settings/general")
    const choices = tid(page, "settings-theme")
    await ctx.shoot(page, "05-theme-setting", {
      clip: [choices.locator("xpath=.."), tid(page, "settings-density").locator("xpath=..")],
      pad: 12,
      marks: [choices],
    })
  }),
  shot("05-mobile-layout", async (ctx) => {
    const page = await ctx.page({ phone: true })
    await page.waitForTimeout(2500)
    await ctx.shoot(page, "05-mobile-layout")
  }),
  shot("07-sidebar-rows", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    const row = tid(page, "session-row").filter({ hasText: "적 AI 길찾기 고치기" }).first()
    await ctx.shoot(page, "07-sidebar-rows", {
      clip: tid(page, "sidebar"),
      pad: 0,
      marks: [row, tid(page, "accounts-in-use")],
    })
  }),
  shot("07-turn-footer", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    const footer = tid(page, "turn-footer").first()
    await footer.locator("button.own-foot").click()
    const table = tid(footer, "step-table")
    await table.waitFor()
    await ctx.shoot(page, "07-turn-footer", {
      clip: [footer, page.getByText("적 AI가 벽을 피해 가도록").first()],
      marks: [footer.locator("button.own-foot"), table],
    })
  }),
  shot("07-limits-tab", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await page.setViewportSize({ width: 1440, height: 1500 })
    await panel(page, "accounts")
    await page.waitForTimeout(800)
    const box = tid(page, "panel")
    const row = (account: string) => box.locator(`[data-testid=account-row][data-account-id=${account}]`)
    // Each row folds its limits into one line (`간단히`, 03 §7.2); ChatGPT 01's is unfolded to show every bar.
    await tid(row("acc_tm01"), "limit-summary-toggle").click()
    await tid(row("acc_tm01"), "limit-summary-body").waitFor()
    await page.mouse.move(0, 0)
    await ctx.shoot(page, "07-limits-tab", {
      clip: [box.locator(".own-panel-head"), tid(box, "link-accounts")],
      pad: 12,
      // ChatGPT 01 unfolded, ChatGPT 02's line (getting tight), DeepSeek's balance.
      marks: [row("acc_tm01"), row("acc_tm02"), row("acc_tmds")],
    })
  }),
  shot("07-accounts-page", async (ctx) => {
    const page = await open(ctx, "/accounts")
    // ChatGPT 01's limits summary unfolded beside ChatGPT 02's folded line (03 §7.2).
    await tid(card(page, "acc_tm01"), "limit-summary-toggle").click()
    await tid(card(page, "acc_tm01"), "limit-summary-body").waitFor()
    await page.mouse.move(0, 0)
    await ctx.shoot(page, "07-accounts-page", { marks: [[card(page, "acc_tm01"), card(page, "acc_tm02")]] })
  }),
  shot("07-limits-page", async (ctx) => {
    const page = await open(ctx, "/limits")
    await ctx.shoot(page, "07-limits-page")
  }),
  shot("07-session-info", async (ctx) => {
    // The panel's `이 대화` card (the session info drawer of the plan is this card in this build): its title row
    // `이 대화 · GPT-5.5` with `전환…` (UX 2026-10-26).
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, "accounts")
    const info = tid(page, "session-card")
    await tid(info, "context-bar").waitFor()
    await ctx.shoot(page, "07-session-info", {
      clip: info,
      marks: [[tid(info, "session-binding"), tid(info, "session-switch")]],
    })
  }),
  shot("12-account-menu", async (ctx) => {
    const page = await open(ctx, "/accounts")
    const target = card(page, "acc_tm01")
    await tid(target, "account-menu").click()
    const list = page.getByRole("menu", { name: "ChatGPT 01 메뉴" })
    await list.waitFor()
    await ctx.shoot(page, "12-account-menu", {
      clip: [target, list],
      marks: [list.getByText("이 종류의 기본 계정으로").first()],
    })
  }),
  shot("12-policy", async (ctx) => {
    const page = await open(ctx, "/settings/policy")
    const row = page.getByText("구독 → 구독", { exact: true }).first()
    await ctx.shoot(page, "12-policy", {
      marks: [
        [row, page.getByText(/^제공 안 함 — /).nth(1)],
        [page.getByText("Claude 계정 사이", { exact: true }).first(), tid(page, "policy-claude-claude")],
      ],
    })
  }),
  shot("13-settings", async (ctx) => {
    const page = await open(ctx, "/settings/compaction")
    await ctx.shoot(page, "13-settings", {
      marks: [tid(page, "compaction-kind-row").first(), page.getByText(/기준은 요청 본문에 들어가지 않아/).first()],
    })
  }),
  shot("13-impact", async (ctx) => {
    const page = await open(ctx, "/settings/compaction")
    const row = page.locator(`[data-testid=compaction-account-row][data-account-id=${ctx.state.accounts["01"]}]`)
    await tid(row, "compaction-account-choice").getByText("직접 정하기", { exact: true }).click()
    const editor = tid(row, "compaction-editor")
    await editor.waitFor()
    const cap = tid(editor, "compaction-cap")
    await (await cap.evaluate((node) => node.tagName === "INPUT") ? cap : cap.locator("input")).fill("100000")
    await tid(editor, "compaction-save").click()
    const dialog = page.getByRole("dialog").filter({ has: tid(page, "impact-apply") })
    await dialog.waitFor()
    const cancel = dialog.getByRole("button", { name: "취소" })
    await ctx.shoot(page, "13-impact", {
      clip: dialog,
      marks: [[tid(dialog, "impact-apply"), tid(dialog, "impact-compact-first"), cancel]],
    })
    await cancel.click()
  }),
  shot("14-composer-row", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    const composer = tid(page, "composer")
    // In the toolbar's order: model @ account, effort, ultra (with ⓘ), speed, preset.
    await ctx.shoot(page, "14-composer-row", {
      clip: composer,
      marks: [
        tid(page, "composer-switcher"),
        tid(page, "composer-variant"),
        [tid(page, "composer-ultra"), tid(page, "composer-ultra-info")],
        tid(page, "composer-speed"),
        tid(page, "composer-preset"),
      ],
    })
  }),
  shot("14-settings-presets", async (ctx) => {
    const page = await open(ctx, "/settings/presets")
    await ctx.shoot(page, "14-settings-presets", {
      marks: [tid(page, "presets-group").first(), tid(page, "presets-row").first()],
    })
  }),
  shot("16-speed-api", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.webhook!)
    // The composer folds these tools behind ⋯ while the work panel is open (03 §4.6).
    await closePanel(page)
    await tid(page, "composer-speed").click()
    const list = tid(page, "composer-speed-menu")
    await list.waitFor()
    await ctx.shoot(page, "16-speed-api", {
      clip: [list, tid(page, "composer-speed")],
      marks: [list.getByText(/Fast/).first()],
    })
  }),
  shot("18-menu", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await tid(page, "session-menu").click()
    const list = menu(page, "대화 동작")
    await list.waitFor()
    await ctx.shoot(page, "18-menu", {
      clip: [list, tid(page, "session-menu")],
      marks: [list.getByText("이 대화에서 컴퓨터 사용…")],
    })
  }),
  shot("18-settings", async (ctx) => {
    const page = await open(ctx, "/settings/experimental")
    await page.setViewportSize({ width: 1440, height: 1400 })
    const status = tid(page, "computer-status")
    await status.waitFor()
    // The demo build's version line (a test build id) and helper line are left out: the text explains neither.
    await status.evaluate((list) => {
      for (const at of [0, 1, 4, 5]) (list.children[at] as HTMLElement | undefined)?.style.setProperty("display", "none")
    })
    await page.waitForTimeout(300)
    await ctx.shoot(page, "18-settings", {
      clip: tid(page, "computer-panel"),
      marks: [tid(page, "computer-stop-all"), page.getByText("터미널·터미널 있는 IDE").first()],
    })
  }),
  shot("21-import-entry", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    const entry = tid(page, "import-entry").first()
    await entry.waitFor({ timeout: 120_000 })
    await page.waitForTimeout(800)
    await ctx.shoot(page, "21-import-entry", {
      clip: [tid(page, "project-row").first(), entry],
      pad: 12,
      marks: [entry],
    })
  }),
  shot("21-import-list", async (ctx) => {
    const page = await importList(ctx)
    const row = tid(page, "import-row").first()
    await ctx.shoot(page, "21-import-list", {
      marks: [
        [tid(row, "import-row-title"), tid(row, "import-row-model")],
        [tid(row, "import-row-open"), tid(row, "import-row-resume")],
      ],
    })
  }),
  shot("21-import-view", async (ctx) => {
    const page = await importList(ctx)
    await tid(tid(page, "import-row").first(), "import-row-open").click()
    await tid(page, "import-viewer-band").waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "21-import-view", {
      marks: [tid(page, "import-viewer-band"), tid(page, "import-viewer-resume")],
    })
  }),
  shot("21-import-continue", async (ctx) => {
    const page = await importList(ctx)
    await page.setViewportSize({ width: 1440, height: 1300 })
    await tid(tid(page, "import-row").first(), "import-row-resume").click()
    const dialog = tid(page, "import-migrate")
    await dialog.waitFor()
    await page.locator('[data-testid=import-migrate-modes][aria-busy="false"]').waitFor({ timeout: 60_000 })
    await tid(page, "import-migrate-ratio").waitFor()
    await page.waitForTimeout(800)
    await ctx.shoot(page, "21-import-continue", {
      clip: dialog,
      marks: [
        [tid(dialog, "import-migrate-account"), tid(dialog, "import-migrate-ratio")],
        tid(dialog, "import-migrate-modes"),
        tid(dialog, "import-migrate-send"),
      ],
    })
    // 그대로 이어가기 calls no model: the new conversation opens with its header badge.
    await tid(dialog, "import-migrate-run").click()
    const badge = tid(page, "import-badge")
    await badge.waitFor({ timeout: 90_000 })
    await page.setViewportSize({ width: 1440, height: 900 })
    await closePanel(page)
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "21-import-badge", { marks: [badge, tid(page, "import-first-line")] })
  }),
  shot("20-linked-card", async (ctx) => {
    const page = await open(ctx, "/accounts")
    const target = card(page, "acc_tm01")
    await tid(target, "account-menu").click()
    const list = page.getByRole("menu", { name: "ChatGPT 01 메뉴" })
    await list.waitFor()
    await ctx.shoot(page, "20-linked-card", {
      clip: [target, list],
      marks: [tid(target, "codex-connection"), list.getByText("이 앱으로 인수…").first()],
    })
  }),
  shot("20-deepseek-card", async (ctx) => {
    const page = await open(ctx, "/accounts")
    const target = card(page, "acc_tmds")
    await ctx.shoot(page, "20-deepseek-card", {
      clip: target,
      marks: [tid(target, "ds-balance"), tid(target, "ds-balance-links")],
    })
  }),
  shot("20-ds-effort", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.level!)
    // The composer folds these tools behind ⋯ while the work panel is open (03 §4.6).
    await closePanel(page)
    await tid(page, "composer-variant").click()
    const list = page.getByRole("menu").last()
    await list.waitFor()
    await ctx.shoot(page, "20-ds-effort", {
      clip: [list, tid(page, "composer-variant")],
      marks: [list.getByText("none", { exact: true }).first()],
    })
  }),
  shot("10-palette", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await page.keyboard.press("Control+k")
    const palette = tid(page, "palette")
    await palette.waitFor()
    await tid(page, "palette-input").fill("ㅈㅎ")
    await page.waitForTimeout(600)
    await ctx.shoot(page, "10-palette", { clip: palette, marks: [tid(page, "palette-input")] })
  }),
  shot("11-limit-banner", async (ctx) => {
    // This build shows a used-up subscription as the failed turn's provider message and the 100 % chip.
    const page = await ctx.session(ctx.state.sessions.sound!)
    await closePanel(page)
    const error = page.getByText("The usage limit has been reached").last()
    await error.waitFor()
    await ctx.shoot(page, "11-limit-banner", {
      clip: [tid(page, "transcript"), tid(page, "composer")],
      pad: 0,
      marks: [error, tid(page, "composer-switcher")],
    })
  }),
  shot("23-phone-list", async (ctx) => {
    const page = await ctx.page({ phone: true })
    await page.waitForTimeout(2500)
    await ctx.shoot(page, "23-phone-list")
  }),
  shot("23-phone-chat", async (ctx) => {
    const page = await ctx.page({ phone: true })
    await page.waitForTimeout(2000)
    await page.getByText("적 AI 길찾기 고치기").first().click()
    await page.waitForTimeout(2500)
    await ctx.shoot(page, "23-phone-chat", { marks: [tid(page, "composer-switcher").first()] })
  }),
  shot("04-first-turn", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await ctx.shoot(page, "04-first-turn", { marks: [tid(page, "composer-switcher"), tid(page, "composer-send")] })
  }),
  shot("04-open-folder", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await tid(page, "sidebar-open-folder").click()
    const dialog = tid(page, "project-picker")
    await dialog.waitFor()
    // The demo's folder of projects (typed, as the field's hint says), then its listing.
    await tid(dialog, "project-path").fill(ctx.state.demo)
    await tid(dialog, "project-path").press("Enter")
    const entry = dialog.locator('[data-testid="project-entry"][data-name="space-game"]')
    await entry.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(800)
    // The picker starts in the demo's project folder. Its path field and crumbs are buttons and an input the
    // rewrite does not touch: shown as `D:\demo` for this shot only (nothing is opened, the dialog is cancelled).
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("[data-testid=project-path]")
      if (input) input.value = "D:\\demo"
      const crumbs = document.querySelector<HTMLElement>("[data-testid=project-crumbs]")
      if (crumbs) crumbs.replaceChildren(Object.assign(document.createElement("span"), { textContent: "D:\\  ›  demo" }))
      for (const root of document.querySelectorAll<HTMLElement>("[data-testid=project-root]")) root.textContent = "D:\\"
      for (const row of document.querySelectorAll<HTMLElement>("[data-testid=project-entry][data-name='.no-hooks']"))
        row.style.display = "none"
    })
    await ctx.shoot(page, "04-open-folder", {
      clip: dialog,
      marks: [entry, tid(dialog, "project-choose")],
    })
  }),
  shot("09-review", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, "review")
    await tid(page, "review-mode").selectOption("working")
    await tid(page, "review-list").waitFor({ timeout: 30_000 })
    await page.waitForTimeout(1500)
    // A comment on one line of the diff: it goes with the next message (the chip above the composer).
    await tid(page, "panel").getByText("diagonal").first().click()
    const comment = tid(page, "panel").getByPlaceholder(/컨텍스트/).first()
    await comment.fill("대각선으로 벽 모서리를 지나가는 경우도 확인해 줘")
    await tid(page, "panel").getByRole("button", { name: "댓글 달기" }).last().click()
    const chip = tid(page, "review-comment-chip").or(tid(page, "mention-chip")).first()
    await chip.waitFor()
    await dismissToasts(page)
    await ctx.shoot(page, "09-review", {
      marks: [[tid(page, "review-mode"), tid(page, "review-style")], chip],
    })
  }),
  shot("09-git-confirm", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, "review")
    await tid(page, "review-mode").selectOption("working")
    await tid(page, "review-list").waitFor({ timeout: 30_000 })
    await tid(page, "git-stage-all").click()
    const dock = tid(page, "git-dock")
    await dock.waitFor()
    await ctx.shoot(page, "09-git-confirm", { clip: [dock, tid(page, "git-bar")], marks: [tid(dock, "git-command")] })
    await page.keyboard.press("Escape")
  }),
  shot("09-files", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, "files")
    await tid(page, "files-tree").getByText("README.md", { exact: true }).click()
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "09-files")
  }),
  shot("13-session-setting", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.log!)
    await tid(page, "context-meter").click()
    await tid(page, "compact-session-settings").click()
    const dialog = tid(page, "session-compaction")
    await dialog.waitFor()
    await dialog.getByRole("radio").nth(1).check()
    const input = tid(dialog, "session-compaction-input")
    await input.fill("150000")
    await page.waitForTimeout(500)
    await ctx.shoot(page, "13-session-setting", {
      clip: dialog,
      // ② the allowed range (`입력 범위: …`), the first note under the field.
      marks: [[dialog.getByRole("radio").nth(1), input], dialog.locator(".own-cp-dlg-note").first()],
    })
  }),
  shot("14-editor", async (ctx) => {
    const page = await open(ctx, "/settings/presets")
    // ① has a line under each radio (UC 2026-10-18), so the editor scrolls: a taller window, scrolled to the last
    // line, shows `일마다 정하기` with its role rows, ② and ③ together.
    await page.setViewportSize({ width: 1440, height: 1100 })
    await tid(page, "presets-row").filter({ hasText: "리뷰는 Claude로" }).getByTestId("presets-edit").click()
    await tid(page, "preset-editor-roles").waitFor()
    await page.waitForTimeout(800)
    await tid(page, "preset-editor-resolution").scrollIntoViewIfNeeded()
    await ctx.shoot(page, "14-editor", {
      marks: [
        [
          tid(page, "preset-editor-workers").getByRole("radio", { name: "일마다 정하기" }).locator("xpath=ancestor::label[1]"),
          tid(page, "preset-editor-roles"),
        ],
        tid(page, "preset-editor-delegation"),
        tid(page, "preset-editor-resolution"),
      ],
    })
  }),
  shot("14-target-picker", async (ctx) => {
    const page = await open(ctx, "/settings/presets")
    await tid(page, "presets-row").filter({ hasText: "리뷰는 Claude로" }).getByTestId("presets-edit").click()
    await page.locator("[data-testid=preset-editor-role][data-role=own-review] [data-testid=preset-editor-change]").click()
    const dialog = page.getByRole("dialog", { name: "리뷰 대상" })
    await dialog.waitFor()
    await tid(dialog, "preset-target-paid").first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await ctx.shoot(page, "14-target-picker", {
      clip: dialog,
      marks: [tid(dialog, "preset-target-hidden").first(), tid(dialog, "preset-target-paid").first()],
    })
  }),
  shot("15-ultra-caps", async (ctx) => {
    const page = await open(ctx, "/settings/presets")
    await tid(page, "presets-ultra-change").click()
    await page.getByRole("radio", { name: "크게" }).or(page.getByRole("button", { name: "크게", exact: true })).first().click()
    await page.waitForTimeout(500)
    const section = tid(page, "presets-ultra")
    await ctx.shoot(page, "15-ultra-caps", {
      clip: section,
      marks: [section.getByText("추천", { exact: true }).first(), tid(page, "presets-ultra-large")],
    })
  }),
  shot("16-speed-dialog", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    // The composer folds these tools behind ⋯ while the work panel is open (03 §4.6).
    await closePanel(page)
    await tid(page, "composer-speed").click()
    await tid(page, "composer-speed-menu").getByText(/Fast/).first().click()
    const dialog = tid(page, "speed-cost-dialog")
    await dialog.waitFor()
    await ctx.shoot(page, "16-speed-dialog", { clip: dialog, marks: [tid(dialog, "speed-cost-line").first()] })
    await page.keyboard.press("Escape")
  }),
  shot("16-claude-consent", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.hud!)
    // The composer folds these tools behind ⋯ while the work panel is open (03 §4.6).
    await closePanel(page)
    await tid(page, "composer-speed").click()
    await tid(page, "composer-speed-menu").getByText(/Fast/).first().click()
    const dialog = tid(page, "speed-consent-dialog")
    await dialog.waitFor()
    await ctx.shoot(page, "16-claude-consent", {
      clip: dialog,
      marks: [dialog.locator("p").first(), tid(dialog, "speed-confirm")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("10-revert", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    const message = page.getByText("적 AI가 벽에 자꾸 부딪혀요").first()
    await message.hover()
    // The message's actions show on hover: the first user message, so its turn's file change is staged back too.
    await page.getByRole("button", { name: "이 지점으로 복원" }).first().click({ force: true })
    await tid(page, "revert-dialog").waitFor()
    await tid(page, "revert-confirm").click()
    const bar = tid(page, "revert-bar")
    await bar.waitFor()
    await ctx.shoot(page, "10-revert", {
      clip: [bar, tid(page, "composer")],
      marks: [[tid(bar, "revert-commit"), tid(bar, "revert-clear")]],
    })
    await tid(bar, "revert-clear").click()
    await bar.waitFor({ state: "detached" })
  }),
  shot("04-permission-dock", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.fresh!)
    await closePanel(page)
    // 묻기 for this conversation: every shell command asks first.
    await approval(page, "묻기")
    await send(page, "지금 바뀐 파일을 확인해 줘")
    const dock = tid(page, "request-dock").first()
    await dock.waitFor({ timeout: 60_000 })
    await dismissToasts(page)
    await ctx.shoot(page, "04-permission-dock", {
      clip: [dock, tid(page, "composer")],
      marks: [[tid(dock, "permission-once"), tid(dock, "permission-always"), tid(dock, "permission-reject")], tid(dock, "permission-scope")],
    })
    // 항상 허용: the rule 08-saved-rules shows.
    await tid(dock, "permission-always").click()
    await page.waitForTimeout(2000)
  }),
  shot("10-queue", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.fresh!)
    await closePanel(page)
    await send(page, "적 스폰 위치가 벽 안이 되지 않게 해 줘")
    await tid(page, "composer-stop").waitFor()
    await page.waitForTimeout(1500)
    await type(page, "스폰 간격도 2초로 늘려 줘")
    await page.keyboard.press("Control+Enter")
    await page.waitForTimeout(800)
    await type(page, "끝나면 보스 체력도 확인해 줘")
    await page.keyboard.press("Alt+Enter")
    await page.waitForTimeout(1200)
    await ctx.shoot(page, "10-queue", {
      clip: [tid(page, "queue-panel"), tid(page, "composer")],
      marks: [tid(page, "composer-hint"), tid(page, "queue-badge").first()],
    })
  }),
  shot("06-switched", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.menu!)
    await closePanel(page)
    await switcher(page)
    await pick(page, ctx.state.accounts.deepseek!)
    await tid(page, "switcher-apply").click()
    const toast = tid(page, "toast").first()
    await toast.waitFor()
    await ctx.shoot(page, "06-switched", { marks: [tid(page, "switch-marker").last(), toast] })
  }),
  shot("06-apply-cost", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.map!)
    const dialog = await switcher(page)
    await pick(page, ctx.state.accounts.anthropic!)
    await ctx.shoot(page, "06-apply-cost", {
      clip: dialog.locator(".own-sw-foot"),
      marks: [tid(page, "switcher-apply")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("11-cost-dialog-more", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.log!)
    await switcher(page)
    await pick(page, ctx.state.accounts.deepseek!)
    await tid(page, "switcher-apply").click()
    const dialog = tid(page, "switch-dialog")
    await dialog.waitFor()
    await dialog.getByText("더 보기").first().click()
    await dialog.getByText("자세히", { exact: true }).first().click()
    await page.waitForTimeout(600)
    await ctx.shoot(page, "11-cost-dialog-more", { clip: dialog, marks: [tid(dialog, "switch-option-fork")] })
  }),
  shot("11-scheduled", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.log!)
    await closePanel(page)
    await switcher(page)
    await pick(page, ctx.state.accounts.deepseek!)
    await tid(page, "switcher-apply").click()
    const dialog = tid(page, "switch-dialog")
    await tid(dialog, "switch-option-cold-point").click()
    await tid(dialog, "switch-dialog-confirm").click()
    const chip = tid(page, "pending-switch")
    await chip.waitFor()
    await ctx.shoot(page, "11-scheduled", { clip: [chip, tid(page, "composer")], marks: [chip] })
    await chip.getByRole("button", { name: "취소" }).click()
    await chip.waitFor({ state: "detached" })
  }),
  shot("11-markers", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.log!)
    await closePanel(page)
    await switcher(page)
    await pick(page, ctx.state.accounts.deepseek!)
    await tid(page, "switcher-apply").click()
    const dialog = tid(page, "switch-dialog")
    await tid(dialog, "switch-option-compact-then-switch").click()
    await tid(dialog, "switch-dialog-confirm").click()
    const marker = tid(page, "switch-marker").last()
    await marker.waitFor({ timeout: 120_000 })
    await page.waitForTimeout(1500)
    const compaction = tid(page, "compaction-marker").last()
    // Above the composer, which covers the bottom of the conversation.
    await compaction.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await page.waitForTimeout(600)
    await ctx.shoot(page, "11-markers", { clip: [compaction, marker], pad: 24, marks: [compaction, marker] })
  }),
  shot("15-ultra-on", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    // The composer folds these tools behind ⋯ while the work panel is open (03 §4.6).
    await closePanel(page)
    await tid(page, "composer-ultra").click()
    // GPT-5.5 changes its reasoning effort with ultra: the cost dialog asks once.
    const dialog = page.getByRole("dialog").filter({ hasText: "울트라 켜기" })
    await dialog.waitFor({ timeout: 15_000 })
    await page.waitForTimeout(600)
    await ctx.shoot(page, "15-ultra-cost", {
      clip: dialog,
      marks: [dialog.getByText(/^추론 강도:/).first(), dialog.getByRole("button", { name: "켜기", exact: true })],
    })
    await dialog.getByRole("button", { name: "켜기", exact: true }).click()
    await dialog.waitFor({ state: "detached", timeout: 30_000 })
    await page.waitForTimeout(2500)
    await ctx.shoot(page, "15-ultra-on", {
      clip: [tid(page, "composer-ultra-wrap"), tid(page, "composer")],
      marks: [tid(page, "composer-ultra")],
    })
  }),
  shot("18-consent", async (ctx) => {
    // A conversation with an approval mode (the seeded ones use the router's own rules, which the dialog asks to
    // replace first).
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await approval(page, "묻기")
    await tid(page, "session-menu").click()
    await tid(page, "session-menu-computer").click()
    const dialog = tid(page, "computer-dialog")
    await dialog.waitFor()
    await dialog.locator('[data-testid=computer-switch][aria-disabled="false"], [data-testid=computer-switch]:not([aria-disabled])').waitFor({ timeout: 30_000 })
    await tid(dialog, "computer-switch").click()
    await tid(dialog, "computer-confirm").waitFor()
    await ctx.shoot(page, "18-consent", {
      clip: dialog,
      marks: [
        dialog.getByText(/Ctrl\+Alt\+Shift\+Q/).first(),
        dialog.locator("li").nth(2),
        tid(dialog, "computer-confirm"),
      ],
    })
    await tid(dialog, "computer-confirm").click()
    await page.waitForTimeout(1500)
  }),
  shot("18-chip", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await send(page, "메모장 화면이 어떻게 보이는지 확인해 줘")
    const chip = tid(page, "computer-chip")
    await page.locator("[data-testid=computer-chip][data-state=active]").waitFor({ timeout: 60_000 })
    await ctx.shoot(page, "18-chip", { clip: tid(page, "header"), pad: 8, marks: [chip, tid(chip, "computer-stop")] })
  }),
  shot("18-stopped", async (ctx) => {
    const page = await open(ctx, "/settings/experimental")
    await tid(page, "computer-stop-all").click()
    const stopped = tid(page, "computer-stopped")
    await stopped.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(800)
    await ctx.shoot(page, "18-stopped", {
      clip: [stopped, tid(page, "computer-status")],
      marks: [tid(page, "computer-reset")],
    })
    await tid(page, "computer-reset").click()
    await page.waitForTimeout(1000)
  }),
  shot("12-auto-switch", async (ctx) => {
    // DeepSeek answers 402 (balance used up): API key → API key switching moves the turn to Anthropic on its own.
    await ctx.control("enqueue", { provider: "deepseek", reply: INSUFFICIENT })
    const page = await ctx.session(ctx.state.sessions.level!)
    await closePanel(page)
    await send(page, "타일 지우기 기록을 한 번만 남기도록 고쳐 줘")
    const marker = tid(page, "switch-marker").last()
    await marker.waitFor({ timeout: 90_000 })
    await page.waitForTimeout(2500)
    await marker.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await page.waitForTimeout(600)
    await ctx.shoot(page, "12-auto-switch", {
      clip: [page.getByText("Insufficient Balance").last(), marker],
      marks: [marker],
    })
  }),
  shot("20-deepseek-402", async (ctx) => {
    // With automatic switching off for DeepSeek, the conversation stops on the banner instead.
    const off = await ctx.rpc("own.accounts", "accounts.update", { accountID: ctx.state.accounts.deepseek, autoSwitch: false })
    if (off.status !== 200) throw new Error(`accounts.update: ${off.status} ${off.message}`)
    await ctx.control("enqueue", { provider: "deepseek", reply: INSUFFICIENT })
    const page = await ctx.session(ctx.state.sessions.menu!)
    await closePanel(page)
    await send(page, "버튼 글자 크기도 맞춰 줘")
    const banner = tid(page, "ds-balance-out")
    await banner.waitFor({ timeout: 60_000 })
    await ctx.shoot(page, "20-deepseek-402", { clip: [banner, tid(page, "composer")], marks: [banner] })
  }),
  shot("25-offline", async (ctx) => {
    // The service is unreachable: its event stream and API calls fail (the page stays loaded).
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await page.route(/\/api\//, (route) => route.abort("connectionrefused"))
    await page.evaluate(() => window.dispatchEvent(new Event("offline")))
    await page.reload()
    const banner = tid(page, "banner-offline")
    await banner.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "25-offline", { marks: [banner] })
  }),
  shot("11-cost-dialog", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.log!)
    await switcher(page)
    await pick(page, ctx.state.accounts.deepseek!)
    await tid(page, "switcher-apply").click()
    const dialog = tid(page, "switch-dialog")
    await dialog.waitFor()
    await ctx.shoot(page, "11-cost-dialog", {
      clip: dialog,
      marks: [tid(dialog, "switch-option-compact-then-switch"), tid(dialog, "switch-option-cold-point")],
    })
  }),
]

/**
 * Run order: the shots that show limits while the seeded observations are fresh, then the ones that only look, then
 * the ones that change the world (each finds what the earlier ones left).
 */
const ORDER = [
  "05-tour",
  "07-limits-tab",
  "07-accounts-page",
  "07-limits-page",
  "07-sidebar-rows",
  "06-switcher",
  "12-account-menu",
  "20-linked-card",
  "20-deepseek-card",
  "05-tour-light",
  "07-session-info",
  "07-turn-footer",
  "04-first-turn",
  "04-approval-menu",
  "14-composer-row",
  "14-preset-menu",
  "16-speed-menu",
  "16-speed-api",
  "20-ds-effort",
  "13-meter",
  "11-cost-dialog",
  "11-cost-dialog-more",
  "06-apply-cost",
  "13-session-setting",
  "13-settings",
  "13-impact",
  "12-policy",
  "05-theme-setting",
  "14-settings-presets",
  "14-editor",
  "14-target-picker",
  "15-ultra-caps",
  "18-menu",
  "18-settings",
  "10-palette",
  "11-limit-banner",
  "05-mobile-layout",
  "23-phone-list",
  "23-phone-chat",
  "04-open-folder",
  "09-files",
  "09-review",
  "09-git-confirm",
  "16-speed-dialog",
  "16-claude-consent",
  "10-revert",
  "04-permission-dock",
  "10-queue",
  "06-switched",
  "11-scheduled",
  "11-markers",
  "12-auto-switch",
  "20-deepseek-402",
  "15-ultra-on",
  "18-consent",
  "18-chip",
  "18-stopped",
  "25-offline",
  "21-import-entry",
  "21-import-list",
  "21-import-view",
  "21-import-continue",
]

export const MAIN: ReadonlyArray<Shot<MainState>> = SHOTS.toSorted(
  (a, b) => rank(a.id) - rank(b.id),
)

function rank(id: string) {
  const at = ORDER.indexOf(id)
  return at < 0 ? ORDER.length : at
}
