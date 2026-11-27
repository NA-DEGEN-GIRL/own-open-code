// The README's pictures, by demo world. `main` runs on the manual's main world, `team` on its team world, `remote` on
// own-web's remote e2e backend (a fake `ssh`, Git Bash plays the host) and `pane` on the main world inside the desktop
// shell, whose window stays off the screen.
import path from "node:path"
import { bootReadmePane, paneCapture, panePage, type PaneState } from "./pane"
import { dismissToasts, OVERSAMPLE, panel, send, tid, type Ctx, type Endpoints, type Lang, type Shot } from "./lib"
import { privacyProblems, type Page } from "../manual/lib/browser"
import type { WorldPaths } from "../manual/lib/privacy"
import { checkoutTmp, start, type World } from "../manual/lib/world"
import { mainPaths, type MainState } from "../manual/shots/main"
import { remotePaths, type RemoteState } from "../manual/shots/remote"

export interface Group {
  readonly name: string
  boot(lang: Lang): Promise<World<Endpoints>>
  paths(state: never): WorldPaths
  readonly shots: ReadonlyArray<Shot<never>>
}

type Main = Ctx<MainState>
const main = (id: string, run: (ctx: Main) => Promise<void>): Shot<MainState> => ({ id, run })

/** The README's own ports (each world uses its port and the next one): `OWN_README_PORT` when they are taken. */
const BASE = Number(process.env.OWN_README_PORT ?? 7421)
const PORTS = { main: BASE, team: BASE + 10, remote: BASE + 20, pane: BASE + 30 } as const

const bootMain = (name: "main" | "team", lang: Lang) =>
  start<MainState>(
    `readme-${name}-${lang}`,
    {
      script: "e2e/manual/backend.ts",
      env: {
        OWN_MANUAL_WORLD: "main",
        OWN_MANUAL_PORT: String(PORTS[name]),
        OWN_MANUAL_TEAM: name === "team" ? "1" : "0",
        OWN_MANUAL_LANG: lang,
      },
      ready: "OWN_MANUAL_READY",
    },
    mainPaths,
  )

async function hero(ctx: Main, scheme: "dark" | "light") {
  const page = await ctx.session(ctx.state.sessions.enemy!, { scheme, width: 1400, height: 860 })
  await panel(page, "accounts")
  await dismissToasts(page)
  await page.mouse.move(700, 20)
  await ctx.shoot(page, scheme === "dark" ? "hero" : "hero-light")
}

const MAIN: ReadonlyArray<Shot<MainState>> = [
  main("hero", (ctx) => hero(ctx, "dark")),
  main("hero-light", (ctx) => hero(ctx, "light")),
  // Early: the demo provider forgets its cache after five minutes, and the panel shows how much of it was read.
  main("side-question", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, undefined)
    await send(page, ctx.say("/btw A* 말고 다른 방법도 있어?", "/btw Is there another way instead of A*?"))
    const side = tid(page, "side-panel")
    await side.waitFor()
    await tid(side, "side-answer").waitFor({ timeout: 60_000 })
    await tid(side, "side-copy").first().waitFor({ timeout: 60_000 })
    await page.waitForTimeout(800)
    await ctx.shoot(page, "side-question")
  }),
  main("switcher", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, undefined)
    await page.keyboard.press("Control+.")
    const box = tid(page, "switcher")
    await box.waitFor()
    await page.waitForTimeout(1200)
    await ctx.shoot(page, "switcher", { clip: box, pad: 0 })
  }),
  main("limits", async (ctx) => {
    const page = await ctx.page({ path: "/limits" })
    await panel(page, undefined)
    await dismissToasts(page)
    await ctx.shoot(page, "limits")
  }),
  main("harness", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.fresh!)
    await panel(page, undefined)
    await tid(page, "harness-pill").click()
    const menu = tid(page, "harness-menu")
    await menu.waitFor()
    await page.waitForTimeout(600)
    await ctx.shoot(page, "harness", { clip: menu, pad: 0 })
  }),
  main("approvals", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.fresh!)
    await panel(page, undefined)
    await ctx.rpc("own.accounts", "session.approval.set", { sessionID: ctx.state.sessions.fresh!, mode: "ask" }, ctx.state.project)
    await page.waitForTimeout(1200)
    await tid(page, "approval-pill").click()
    const menu = tid(page, "approval-menu")
    await menu.waitFor()
    await page.waitForTimeout(600)
    await ctx.shoot(page, "approvals", { clip: menu, pad: 0 })
  }),
  main("context", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.log!)
    await panel(page, undefined)
    await tid(page, "context-meter").first().click()
    const popover = tid(page, "context-meter-popover")
    await popover.waitFor()
    await page.waitForTimeout(600)
    await ctx.shoot(page, "context", { clip: popover, pad: 0 })
  }),
  main("worktrees", async (ctx) => {
    const model = await ctx.api("GET", `/api/session/${ctx.state.sessions.fresh!}`)
    const info = (model.data ?? model) as { model?: unknown }
    const created = await ctx.api("POST", "/api/session", {
      title: ctx.say("적 스폰 방식 비교", "Compare enemy spawns"),
      model: info.model,
      location: { directory: ctx.state.project },
    })
    const id = ((created.data ?? created) as { id: string }).id
    await ctx.rpc("own.accounts", "session.approval.set", { sessionID: id, mode: "ask" }, ctx.state.project)
    const page = await ctx.session(id)
    await panel(page, undefined)
    await send(
      page,
      ctx.say(
        "적이 생기는 방식을 두 가지 방법을 각각 작업 폴더에서 만들어 봐 줘",
        "Build the enemy spawns both ways, each in its own worktree",
      ),
    )
    await page.locator('[data-testid=worktree-chat-row][data-state="done"]').first().waitFor({ timeout: 180_000 })
    await page.waitForTimeout(6000)
    await dismissToasts(page)
    await ctx.shoot(page, "worktrees")
  }),
  main("phone", async (ctx) => {
    const phone = { phone: true, width: 384, height: 800 }
    const list = await ctx.page({ ...phone, path: "/" })
    await list.waitForTimeout(2500)
    const chat = await ctx.page({ ...phone, path: `/srv/local/s/${ctx.state.sessions.enemy!}` })
    await answered(ctx, chat)
    await devices(ctx, "phone", [list, chat])
  }),
  main("fold", async (ctx) => {
    const path = `/srv/local/s/${ctx.state.sessions.enemy!}`
    const fold = await ctx.page({ phone: true, width: 932, height: 623, path })
    await answered(ctx, fold)
    await devices(ctx, "fold", [fold])
  }),
]

/** The conversation's last answer is on screen. */
async function answered(ctx: Ctx<MainState>, page: Page) {
  await page.getByText(ctx.say("길이 없으면(완전히 막힘)", "With no path at all")).first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(2500)
}

/** Several device screens beside each other in plain frames, on a transparent ground. */
async function devices(ctx: Ctx<Endpoints>, id: string, pages: ReadonlyArray<Page>) {
  const pictures = await Promise.all(
    pages.map(async (page) => {
      await dismissToasts(page)
      const problems = await privacyProblems(page)
      if (problems.length > 0) throw new Error(`${id}: personal data on screen: ${problems.join(" / ")}`)
      return (await page.screenshot({ type: "png", caret: "hide", animations: "disabled" })).toString("base64")
    }),
  )
  const context = await ctx.browser.newContext({
    viewport: { width: 1980, height: 1300 },
    deviceScaleFactor: OVERSAMPLE,
  })
  const page = await context.newPage()
  await page.setContent(
    `<style>body{margin:0;background:transparent}main{display:inline-flex;gap:36px;padding:8px;align-items:flex-start}
img{display:block;height:${pages[0]!.viewportSize()!.height * 1.5}px;border-radius:26px;border:8px solid #3a3d44;box-sizing:border-box}</style>
<main>${pictures.map((item) => `<img src="data:image/png;base64,${item}">`).join("")}</main>`,
  )
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())))
  const png = await page.locator("main").screenshot({ type: "png", omitBackground: true })
  await context.close()
  await ctx.save(id, png)
}

const TEAM: ReadonlyArray<Shot<MainState>> = [
  main("team", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await panel(page, undefined)
    await tid(page, "project-row").filter({ hasText: "space-game" }).first().getByTestId("project-menu").click()
    await tid(page, "project-menu-team-enable").click()
    const dialog = tid(page, "team-enable")
    await dialog.waitFor()
    await tid(dialog, "team-enable-submit").click()
    await page
      .locator('[data-testid="team-card"][data-kind="enable"][data-state="done"]')
      .first()
      .waitFor({ timeout: 420_000 })
    await page.waitForTimeout(2000)
    await send(
      page,
      ctx.say(
        "세 영역에 일을 나눠 맡겨 줘. 화면은 HUD, 게임 로직은 적 이동, 네트워크는 로비.",
        "Split this between the three areas: Interface the HUD, Game logic the enemy movement, Network the lobby.",
      ),
    )
    const deadline = Date.now() + 300_000
    const core = page
      .locator('[data-testid="area-row"]')
      .filter({ hasText: ctx.say("게임 로직", "Game logic") })
      .first()
    while (!(await core.getByTestId("area-status").filter({ hasText: /반영 준비됨|Ready/i }).isVisible())) {
      if (Date.now() > deadline) throw new Error("the second area never got ready")
      const allow = tid(page, "team-request-allow").first()
      if (await allow.isVisible()) await allow.click()
      await page.waitForTimeout(1500)
    }
    await dismissToasts(page)
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "team")
  }),
]

const REMOTE: ReadonlyArray<Shot<RemoteState>> = [
  {
    id: "remote",
    async run(ctx) {
      const page = await ctx.page()
      await panel(page, undefined)
      await tid(page, "remote-add").click()
      const dialog = tid(page, "remote-add-dialog")
      await dialog.locator('[data-testid="remote-alias"][data-alias="devbox"]').click()
      await tid(dialog, "remote-add-check").click()
      const prompt = tid(page, "remote-prompt")
      await prompt.locator('[data-kind="hostKey"]').waitFor({ timeout: 90_000 })
      await tid(prompt, "prompt-trust").click()
      const plan = tid(dialog, "remote-install-plan")
      await plan.waitFor({ timeout: 120_000 })
      await tid(plan, "remote-install").click()
      await tid(dialog, "remote-done").waitFor({ timeout: 240_000 })
      await tid(dialog, "remote-open-folder").click()
      const picker = tid(page, "remote-picker")
      await picker.waitFor()
      await picker.locator('[data-testid="remote-picker-entry"][data-name="work"]').dblclick()
      await picker.locator('[data-testid="remote-picker-entry"][data-name="example-game"]').click()
      await tid(picker, "remote-picker-choose").click()
      await tid(tid(picker, "remote-picker-confirm"), "remote-picker-start").click()
      await tid(page, "server-badge").waitFor({ timeout: 60_000 })
      await send(page, ctx.say("이 서버에서 프로젝트 구조를 알려 줘", "Describe this project on the server"))
      await tid(page, "transcript").getByText("README.md").first().waitFor({ timeout: 120_000 })
      await panel(page, undefined)
      await dismissToasts(page)
      await page.waitForTimeout(1500)
      await ctx.shoot(page, "remote")
    },
  },
]

const PANE: ReadonlyArray<Shot<PaneState>> = [
  {
    id: "browser",
    async run(ctx) {
      const page = await panePage(ctx.state, ctx.lang)
      await tid(page, "sidebar-new-session").click()
      await send(
        page,
        ctx.say("점수판 페이지를 열고 '새 게임'을 눌러 줘", "Open the scoreboard page and press New game"),
      )
      await paneCapture(ctx, page, "browser")
    },
  },
]

export const GROUPS: ReadonlyArray<Group> = [
  { name: "main", boot: (lang) => bootMain("main", lang), paths: mainPaths, shots: MAIN },
  { name: "team", boot: (lang) => bootMain("team", lang), paths: mainPaths, shots: TEAM },
  {
    name: "remote",
    boot: (lang) =>
      start<RemoteState>(
        `readme-remote-${lang}`,
        {
          script: "e2e/remote/backend.ts",
          env: { OWN_WEB_E2E_REMOTE_PORT: String(PORTS.remote), OWN_WEB_E2E_REMOTE_DEMO: lang },
          ready: "OWN_WEB_E2E_REMOTE_READY",
          file: path.join(checkoutTmp("own-web-e2e-remote"), "backend.json"),
        },
        remotePaths,
      ),
    paths: remotePaths,
    shots: REMOTE,
  },
  { name: "pane", boot: (lang) => bootReadmePane(lang, PORTS.pane), paths: mainPaths, shots: PANE },
]
