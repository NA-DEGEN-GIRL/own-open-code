// Shots added with the 2026-10-11 manual update (the three kinds of notes and the 아이디어 노트 board, the settings
// list, the limit display setting, the chat view menu, the model picker's effort and speed strip, the ultra ⓘ card,
// skills import, `Git 저장소로 만들기`, several Claude accounts, split panes and a response that stalled; 2026-10-18 the
// composer's 보내는 키 menu). Group M, after the main world's own shots and the 2026-10-10 ones. Same demo world, fake
// accounts and folders only.
import type { Locator, Page } from "../lib/browser"
import type { Ctx, Shot } from "../lib/ctx"
import type { MainState } from "./main"

type C = Ctx<MainState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<MainState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

async function closePanel(page: Page) {
  if (await tid(page, "panel").isVisible().catch(() => false)) await tid(page, "panel-toggle").first().click()
  await page.waitForTimeout(300)
}

/** A page of the app (`/accounts`, `/settings/<section>`, …) without the right panel. */
async function open(ctx: C, path: string) {
  const page = await ctx.page({ path })
  await page.waitForTimeout(1500)
  await closePanel(page)
  return page
}

/** Types into the composer of the open session and sends it. */
async function send(page: Page, text: string) {
  const input = tid(page, "composer").locator("[contenteditable=true], textarea").first()
  await input.click()
  await input.fill(text)
  await page.keyboard.press("Control+Enter")
}

/** Ideas typed like a user does: `Ctrl+Alt+I`, the text, `Enter` (saved on the PC's service). */
const IDEAS = [
  "보스 방에 숨은 방 하나 만들기 #레벨",
  "점수판에 주간 순위 탭 #UI",
  "효과음 볼륨을 설정에서 따로 조절",
  "튜토리얼은 첫 판에만 보이게 #UI",
]

async function capture(page: Page, text: string, submit = true) {
  await page.keyboard.press("Control+Alt+i")
  const input = tid(page, "idea-capture-input")
  await input.waitFor()
  await input.fill(text)
  if (!submit) return
  await input.press("Enter")
  await tid(page, "idea-capture").waitFor({ state: "detached" }).catch(() => undefined)
  await page.waitForTimeout(400)
}

/** A session's chat panes, two by two (the window's layout as `분할해서 열기` leaves it; web build: chats only). */
function panes(sessions: ReadonlyArray<string>) {
  const leaf = (n: number) => ({
    kind: "leaf",
    id: `p${n + 1}`,
    view: "chat",
    route: { name: "session", serverKey: "local", sessionID: sessions[n] },
  })
  const row = (a: number, b: number) => ({ kind: "split", dir: "row", sizes: [0.5, 0.5], children: [leaf(a), leaf(b)] })
  return JSON.stringify({
    tree: { kind: "split", dir: "column", sizes: [0.5, 0.5], children: [row(0, 1), row(2, 3)] },
    focused: "p1",
  })
}

export const UPDATES2_MAIN: ReadonlyArray<Shot<MainState>> = [
  shot("05-settings-list", async (ctx) => {
    const page = await open(ctx, "/settings/general")
    await tid(page, "settings-nav").waitFor()
    // The sidebar's conversations, not their skeleton (a run of this shot alone comes right after the world boots).
    await tid(page, "session-row").first().waitFor({ timeout: 60_000 })
    // Tall enough for the whole list and the 설명서 link (②) under it, since 스킬 joined the 에이전트 group (SM) and
    // 이미지 만들기 the 모델·계정 group (IS).
    await page.setViewportSize({ width: 1440, height: 1100 })
    // The demo world's preset repair notice comes as a toast a moment after the page; it is not part of this picture.
    await page.waitForTimeout(2000)
    for (const close of await tid(page, "toast").getByRole("button", { name: /닫기|×/ }).all())
      await close.click().catch(() => undefined)
    await page.waitForTimeout(600)
    await ctx.shoot(page, "05-settings-list", {
      marks: [tid(page, "settings-nav"), tid(page, "settings-manual-link"), [tid(page, "header-settings"), tid(page, "header-manual")]],
    })
  }),
  shot("05-settings-phone", async (ctx) => {
    const page = await ctx.page({ phone: true, path: "/settings/general" })
    await tid(page, "settings-back").waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "05-settings-phone", { marks: [tid(page, "settings-back")] })
  }),
  // 8.6 (2026-10-19): 설정 > 웹 검색, the service in use and the list with ChatGPT first.
  shot("08-websearch-page", async (ctx) => {
    const page = await open(ctx, "/settings/websearch")
    await page.setViewportSize({ width: 1440, height: 1300 })
    const current = tid(page, "websearch-current")
    await tid(page, "websearch-now-name").waitFor()
    await tid(page, "settings-websearch-service:own-chatgpt").waitFor()
    await page.waitForTimeout(800)
    const top = await current.boundingBox()
    const bottom = await tid(page, "settings-websearch").boundingBox()
    await ctx.shoot(page, "08-websearch-page", {
      // The two sections with room for the marks at the sides only: the page lead above and the notes below sit
      // right next to them.
      clip: { x: top!.x - 16, y: top!.y, width: top!.width + 32, height: bottom!.y + bottom!.height - top!.y },
      pad: 0,
      marks: [
        tid(page, "websearch-now"),
        tid(page, "settings-websearch-service:own-chatgpt"),
        [tid(page, "settings-websearch-save"), tid(page, "settings-websearch-default")],
      ],
    })
  }),
  // 8.6 (SK 2026-10-23): a keyless service's own key: `Exa (내 키)` right under the free Exa with its price, and the
  // key entry under it with the last four characters. The fake key is removed again, so later shots see no key.
  shot("08-websearch-key", async (ctx) => {
    const page = await open(ctx, "/settings/websearch")
    await page.setViewportSize({ width: 1440, height: 1800 })
    const entry = tid(page, "settings-websearch-exa-key")
    await entry.waitFor({ timeout: 60_000 })
    await tid(page, "settings-websearch-exa-key-open").click()
    await tid(page, "settings-websearch-exa-key-input").fill("fake-exa-manual-key-1234")
    await tid(page, "settings-websearch-exa-key-save").click()
    const keyed = tid(page, "settings-websearch-service:own-exa")
    await keyed.waitFor({ timeout: 60_000 })
    await tid(page, "settings-websearch-exa-key-state").getByText("저장됨").waitFor()
    await page.waitForTimeout(800)
    const top = await tid(page, "settings-websearch-service:exa").boundingBox()
    const bottom = await entry.boundingBox()
    await ctx.shoot(page, "08-websearch-key", {
      clip: { x: top!.x - 16, y: top!.y - 8, width: top!.width + 32, height: bottom!.y + bottom!.height + 16 - top!.y },
      pad: 0,
      marks: [keyed, tid(page, "settings-websearch-exa-key-state")],
    })
    await entry.getByRole("button", { name: "지우기" }).click()
    await tid(page, "settings-websearch-exa-key-remove").click()
    await keyed.waitFor({ state: "detached", timeout: 60_000 })
  }),
  // 8.6 (MS 2026-10-19): 여러 서비스 함께, the services checked by default and what one search may cost (not saved).
  shot("08-websearch-multi", async (ctx) => {
    const page = await open(ctx, "/settings/websearch")
    await page.setViewportSize({ width: 1440, height: 1800 })
    await tid(page, "settings-websearch-mode-multi").waitFor()
    await tid(page, "websearch-now-name").waitFor()
    await tid(page, "settings-websearch-mode-multi").click()
    await tid(page, "settings-websearch-multi-own-chatgpt").waitFor()
    await page.waitForTimeout(800)
    const top = await tid(page, "settings-websearch-mode").boundingBox()
    const bottom = await tid(page, "websearch-multi-cost").boundingBox()
    await ctx.shoot(page, "08-websearch-multi", {
      clip: { x: top!.x - 16, y: top!.y, width: top!.width + 32, height: bottom!.y + bottom!.height + 8 - top!.y },
      pad: 0,
      marks: [
        tid(page, "settings-websearch-mode-multi"),
        tid(page, "settings-websearch-multi-own-chatgpt"),
        tid(page, "websearch-multi-cost"),
      ],
    })
  }),
  shot("07-limit-display", async (ctx) => {
    const page = await open(ctx, "/settings/general")
    await page.setViewportSize({ width: 1440, height: 1400 })
    const section = tid(page, "settings-limits")
    await section.waitFor()
    await section.evaluate((element) => element.scrollIntoView({ block: "start" }))
    await page.waitForTimeout(800)
    await ctx.shoot(page, "07-limit-display", {
      clip: section,
      pad: 12,
      marks: [
        tid(page, "settings-limits-mode"),
        [tid(page, "settings-limits-accounts"), tid(page, "settings-limits-lists")],
        tid(page, "settings-limits-preview"),
      ],
    })
  }),
  shot("05-view-menu", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await tid(page, "chat-view-menu").click()
    const popover = tid(page, "chat-view-popover")
    await popover.waitFor()
    await page.waitForTimeout(400)
    await ctx.shoot(page, "05-view-menu", {
      clip: [popover, tid(page, "chat-view-menu")],
      marks: [tid(page, "chat-view-menu"), tid(page, "chat-view-only"), [tid(page, "chat-view-usage"), tid(page, "chat-view-changes")]],
    })
    await page.keyboard.press("Escape")
  }),
  // 2026-10-18 보내는 키 (4.3): the `▾` beside 전송 and its two choices.
  shot("04-send-key-menu", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await tid(page, "composer-send-key").click()
    const menu = tid(page, "composer-send-key-menu")
    await menu.waitFor()
    await page.waitForTimeout(400)
    await ctx.shoot(page, "04-send-key-menu", {
      clip: [menu, tid(page, "composer-send"), tid(page, "context-meter")],
      pad: 16,
      marks: [tid(page, "composer-send-key"), menu],
    })
    await page.keyboard.press("Escape")
  }),
  shot("10-notes-compare", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    const notes = tid(page, "workspace-notes")
    if (!(await notes.isVisible().catch(() => false))) await tid(page, "workspace-notes-toggle").first().click()
    await notes.waitFor()
    await page.waitForTimeout(800)
    // ① the header's ⋯ (대화 메모 is in it), ② the project notes column, ③ the 아이디어 노트 bulb.
    await ctx.shoot(page, "10-notes-compare", {
      marks: [tid(page, "session-menu"), tid(page, "workspace-notes-head"), tid(page, "header-ideas")],
    })
  }),
  shot("10-idea-capture", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    for (const idea of IDEAS) await capture(page, idea)
    await capture(page, "적이 플레이어를 놓치면 마지막 위치로 가게 #AI", false)
    const popover = tid(page, "idea-capture")
    await page.waitForTimeout(500)
    await ctx.shoot(page, "10-idea-capture", {
      clip: popover,
      marks: [tid(page, "idea-capture-input"), tid(page, "idea-capture-save")],
    })
    await tid(page, "idea-capture-input").press("Enter")
    await page.waitForTimeout(600)
  }),
  shot("10-idea-board", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await tid(page, "header-ideas").click()
    const board = tid(page, "idea-board")
    await board.waitFor()
    await tid(board, "idea-card").first().waitFor()
    await page.waitForTimeout(600)
    // Pin one and give two their own colours, like a user sorting the board.
    const card = (text: string) => tid(board, "idea-card").filter({ hasText: text }).first()
    // The colour row keeps the menu open; `⋯` again closes it (Esc would close the board).
    const color = async (text: string, name: string) => {
      await tid(card(text), "idea-more").click()
      await tid(card(text), "idea-menu").getByRole("radio", { name }).click()
      await page.waitForTimeout(400)
      if (await tid(card(text), "idea-menu").isVisible().catch(() => false)) await tid(card(text), "idea-more").click()
      await page.waitForTimeout(300)
    }
    await color("보스 방에 숨은 방", "분홍")
    await color("효과음 볼륨", "초록")
    const pinned = card("보스 방에 숨은 방")
    if ((await tid(pinned, "idea-pin").getAttribute("aria-pressed")) !== "true") await tid(pinned, "idea-pin").click()
    await page.waitForTimeout(800)
    const first = tid(board, "idea-card").first()
    // The menu of a card on the right of the first row: it opens over empty space, not over the pinned card.
    const right = tid(board, "idea-card").nth(3)
    await tid(right, "idea-more").click()
    const menu = tid(right, "idea-menu")
    await menu.waitFor()
    await page.waitForTimeout(400)
    await ctx.shoot(page, "10-idea-board", {
      marks: [[tid(board, "idea-search")], tid(first, "idea-pin"), menu],
    })
    await page.keyboard.press("Escape")
  }),
  shot("14-switcher-strip", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await page.setViewportSize({ width: 1440, height: 1300 })
    await page.keyboard.press("Control+.")
    const dialog = tid(page, "switcher")
    await dialog.waitFor()
    const strip = tid(dialog, "switcher-options")
    await strip.waitFor()
    await page.waitForTimeout(600)
    await ctx.shoot(page, "14-switcher-strip", {
      clip: dialog,
      marks: [strip.locator(".own-sw-variants").first(), tid(strip, "switcher-speed")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("15-ultra-info", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.map!)
    await closePanel(page)
    await tid(page, "composer-ultra-info").click()
    const card = tid(page, "composer-ultra-card")
    await card.waitFor()
    await page.waitForTimeout(500)
    await ctx.shoot(page, "15-ultra-info", {
      clip: [card, tid(page, "composer-ultra-wrap")],
      marks: [[tid(page, "composer-ultra"), tid(page, "composer-ultra-info")], tid(page, "composer-ultra-caps")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("10-skills-import", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await page.setViewportSize({ width: 1440, height: 1200 })
    await tid(page, "skills-button").click()
    const panel = tid(page, "skills-panel")
    await panel.waitFor()
    await tid(panel, "skills-tab-import").click()
    await tid(panel, "skills-import-row").first().waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1000)
    const ready = tid(panel, "skills-import-row").filter({ has: page.getByTestId("skills-import-use") }).first()
    // SK2: the places looked in, the search and filters, a row's status and its places, the head's buttons.
    await ctx.shoot(page, "10-skills-import", {
      clip: panel,
      pad: 12,
      marks: [
        tid(panel, "skills-tab-import"),
        tid(panel, "skills-import-places"),
        [tid(panel, "skills-import-tools"), tid(panel, "skills-import-filters")],
        [tid(ready, "skills-import-status"), tid(ready, "skills-import-use")],
        [tid(panel, "skills-import-updates"), tid(panel, "skills-import-url")],
      ],
    })
    await page.keyboard.press("Escape")
  }),
  shot("17-not-git", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.pixel!)
    await closePanel(page)
    const row = tid(page, "project-row").filter({ hasText: "pixel-art" }).first()
    await row.hover()
    const team = tid(row, "project-team-button")
    await team.waitFor()
    await team.click()
    const item = tid(page, "project-git-init").first()
    await item.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(500)
    const menu = page.getByRole("menu").filter({ has: item }).first()
    await ctx.shoot(page, "17-not-git", {
      clip: [row, menu],
      pad: 12,
      marks: [[team, tid(row, "project-worktree-button")], item],
    })
    await item.click()
    const dialog = tid(page, "git-init")
    await page.locator('[data-testid=git-init][data-state="ready"]').waitFor({ timeout: 60_000 })
    await page.setViewportSize({ width: 1440, height: 1400 })
    await page.waitForTimeout(800)
    const marks = [
      tid(dialog, "git-init-commit"),
      [tid(dialog, "git-init-gitignore"), tid(dialog, "git-init-gitignore-leaves")],
      tid(dialog, "git-init-flagged-note"),
      [tid(dialog, "git-init-name"), tid(dialog, "git-init-email")],
    ]
    const shown = await Promise.all(
      marks.map((mark) => (Array.isArray(mark) ? mark[0]! : (mark as Locator)).isVisible().catch(() => false)),
    )
    await ctx.shoot(page, "17-git-init", {
      clip: dialog,
      marks: marks.filter((_, at) => shown[at]),
    })
    await page.keyboard.press("Escape")
  }),
  shot("20-claude-accounts", async (ctx) => {
    // Shown as after the local patch (lib/claude.ts, the main world's `claudePatched`).
    const page = await open(ctx, "/accounts")
    await page.setViewportSize({ width: 1440, height: 1600 })
    const section = tid(page, "claude-section")
    await section.waitFor()
    await tid(section, "claude-account-card").first().waitFor({ timeout: 60_000 })
    await section.evaluate((element) => element.scrollIntoView({ block: "start" }))
    await page.waitForTimeout(1000)
    await tid(section, "claude-account-add").waitFor({ timeout: 30_000 })
    await ctx.shoot(page, "20-claude-accounts", {
      clip: section,
      pad: 12,
      marks: [
        [tid(section, "claude-account-card").first(), tid(section, "claude-account-card").last()],
        tid(section, "claude-import-existing"),
        tid(section, "claude-account-add"),
      ],
    })
  }),
  shot("19-split-2x2", async (ctx) => {
    const ids = [ctx.state.sessions.enemy!, ctx.state.sessions.level!, ctx.state.sessions.hud!, ctx.state.sessions.map!]
    const page = await ctx.page({
      path: `/srv/local/s/${ids[0]}`,
      storage: { "own.web.panes.web": panes(ids) },
    })
    await closePanel(page)
    await page.locator('[data-testid=panes][data-mode="split"][data-count="4"]').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(2500)
    const pane = (n: number) => page.locator(`[data-testid=pane][data-pane-id=p${n}]`)
    await ctx.shoot(page, "19-split-2x2", {
      marks: [tid(pane(1), "pane-bar"), tid(pane(2), "pane-menu-button"), tid(page, "pane-divider").first()],
    })
  }),
  shot("26-stall-error", async (ctx) => {
    // The connection to the model breaks on every attempt: the first one and core's ten retries (about a minute and a
    // half of backing off). The turn ends with the error and `이어서`, the same as after a stream that stalls.
    for (const _ of Array.from({ length: 11 })) await ctx.control("enqueue", { provider: "codex", reply: { type: "reset" } })
    const page = await ctx.session(ctx.state.sessions.map!)
    await closePanel(page)
    await send(page, "맵 데이터를 한 번 더 확인해 줘")
    const box = tid(page, "turn-continue").last()
    await box.waitFor({ timeout: 240_000 })
    await page.waitForTimeout(1500)
    await box.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await page.waitForTimeout(600)
    await ctx.shoot(page, "26-stall-error", {
      clip: [page.getByText("맵 데이터를 한 번 더 확인해 줘").last(), box],
      marks: [box.getByRole("button", { name: "이어서" })],
    })
  }),
]
