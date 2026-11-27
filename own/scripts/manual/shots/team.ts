// Group T: team mode on the main demo world (with `shop-app` for adopting work folders). One story in order: turn it
// on in space-game (areas 화면, 게임 로직, 네트워크), hand out work, look at the team view and an owner's conversation,
// integrate 게임 로직, reorganize, then adopt shop-app's work folders. Each shot builds on the ones before it.
import type { Locator, Page } from "../lib/browser"
import type { Ctx, Shot } from "../lib/ctx"
import { bootMain, type MainState } from "./main"

export const bootTeam = () => bootMain(true)

type C = Ctx<MainState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<MainState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)


interface AreaView {
  readonly id: string
  readonly name: string
  readonly slug?: string
  readonly directory: string
  readonly owner: { readonly sessionID: string | null }
}

async function teamOf(ctx: C, directory: string) {
  const result = await ctx.rpc("own.team", "team.get", { directory }, ctx.state.control)
  if (result.status !== 200) throw new Error(`team.get: ${result.status} ${result.message}`)
  return result.output as {
    team: { id: string; main: { sessionID: string } } | null
    areas: ReadonlyArray<AreaView>
  }
}

/** The team main's conversation of space-game (asked again each time, so one shot can run on its own). */
async function teamMain(ctx: C) {
  const found = (await teamOf(ctx, ctx.state.project)).team
  if (!found) throw new Error("space-game has no team")
  return found.main.sessionID
}

async function areaOf(ctx: C, name: string) {
  const found = (await teamOf(ctx, ctx.state.project)).areas.find((area) => area.name === name)
  if (!found) throw new Error(`no area ${name}`)
  return found
}

const area = (page: Page, name: string) =>
  tid(page, "area-row").filter({ has: tid(page, "area-label").filter({ hasText: new RegExp(`^${name} · `) }) })

/** The items inside the area menu's folded `구성 바꾸기 ▸` (own-web team/view-model.ts `AREA_GROUPS`, 2026-10-16). */
const STRUCTURE = new Set(["area-menu-rename", "area-menu-split", "area-menu-merge", "area-menu-convert", "area-menu-move"])

async function areaMenu(page: Page, name: string, item?: string) {
  await area(page, name).first().click({ button: "right" })
  const menu = tid(page, "area-menu")
  await menu.waitFor()
  if (item && STRUCTURE.has(item)) {
    const group = tid(menu, "area-menu-group-structure")
    if ((await group.getAttribute("aria-expanded")) !== "true") await group.click()
  }
  if (item) await tid(menu, item).click()
  return menu
}

/** Confirms the `팀 모드 켜기…` dialog every enable entry point opens (2026-10-16); it closes before enable runs. */
async function enableDialog(page: Page) {
  const dialog = tid(page, "team-enable")
  await dialog.waitFor()
  await tid(dialog, "team-enable-submit").click()
  await dialog.waitFor({ state: "detached" })
}


async function closePanel(page: Page) {
  if (await tid(page, "panel").isVisible().catch(() => false)) await tid(page, "panel-toggle").first().click()
  await page.waitForTimeout(300)
}

async function send(page: Page, text: string) {
  const box = page.locator("#own-composer-input")
  await box.click()
  await box.fill(text)
  await box.press("Control+Enter")
}

async function projectMenu(page: Page, name: string) {
  await tid(page, "project-row").filter({ hasText: name }).first().getByTestId("project-menu").click()
}

export const TEAM: ReadonlyArray<Shot<MainState>> = [
  shot("17-enable", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await projectMenu(page, "space-game")
    const item = tid(page, "project-menu-team-enable")
    await item.waitFor()
    const list = page.getByRole("menu").filter({ has: item })
    await ctx.shoot(page, "17-enable", {
      clip: [list, tid(page, "project-row").filter({ hasText: "space-game" }).first()],
      marks: [item],
    })
    await item.click()
    // The dialog the item opens; the goal becomes the judge's hint and, once on, a draft in the team main's composer.
    const dialog = tid(page, "team-enable")
    await tid(dialog, "team-enable-goal").fill("적 AI와 로비를 손보기")
    await page.waitForTimeout(500)
    // 영역 폴더 (06 §4.12, 2026-10-27) stays on 프로젝트 안, the default.
    await ctx.shoot(page, "17-enable-dialog", {
      clip: dialog,
      marks: [tid(dialog, "team-enable-goal"), tid(dialog, "team-enable-root"), tid(dialog, "team-enable-submit")],
    })
    await enableDialog(page)
    // The judge's answer, three new folders and their conversations: a few minutes on a fresh demo.
    await page.waitForFunction((seed) => !location.pathname.endsWith(seed), ctx.state.sessions.enemy!, {
      timeout: 420_000,
    })
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await page.locator('[data-testid="team-card"][data-kind="enable"][data-state="done"]').first().waitFor({ timeout: 420_000 })
    await area(page, "네트워크").first().waitFor({ timeout: 120_000 })
    await closePanel(page)
    await page.waitForTimeout(1500)
    // The goal waits in the composer as a draft to talk the split over; nothing was sent.
    const box = page.locator("#own-composer-input")
    await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#own-composer-input")?.value ?? "") !== "")
    await ctx.shoot(page, "17-enable-summary", {
      marks: [
        tid(card, "team-card-line").filter({ hasText: /^영역 \d+개:/ }).first(),
        tid(card, "team-card-undo"),
        box,
      ],
    })
  }),
  shot("17-team-view", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    await areaMenu(page, "네트워크", "area-menu-pause")
    await area(page, "네트워크").getByTestId("area-status").filter({ hasText: "메인 멈춤" }).waitFor({ timeout: 60_000 })
    await send(page, "세 영역에 일을 나눠 맡겨 줘. 화면은 HUD, 게임 로직은 적 이동, 네트워크는 로비.")
    // 화면 works on (its answer is slow), 게임 로직 asks to edit a file, 네트워크 holds the main's request.
    const permission = tid(page, "team-request-row").first()
    await permission.waitFor({ timeout: 180_000 })
    await area(page, "네트워크").getByTestId("area-status").filter({ hasText: "요청 1개" }).waitFor({ timeout: 120_000 })
    await area(page, "화면").getByTestId("area-status").filter({ hasText: "작업 중" }).waitFor({ timeout: 120_000 })
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "17-team-view", {
      clip: tid(page, "sidebar"),
      pad: 0,
      marks: [
        [page.getByText(/^승인 기다리는 것 \d+개$/).first(), permission],
        area(page, "게임 로직").first(),
        area(page, "네트워크").first(),
        area(page, "화면").first(),
      ],
    })
    // 한 번 허용 from the team view: 게임 로직 writes its file, saves it and reports that it is ready.
    const ready = area(page, "게임 로직").getByTestId("area-status").filter({ hasText: "반영 준비됨" })
    const deadline = Date.now() + 240_000
    while (!(await ready.isVisible())) {
      if (Date.now() > deadline) throw new Error("게임 로직 never got ready")
      const allow = tid(page, "team-request-allow").first()
      if (await allow.isVisible()) await allow.click()
      await page.waitForTimeout(1500)
    }
  }),
  shot("17-owner-chat", async (ctx) => {
    const owner = (await areaOf(ctx, "게임 로직")).owner.sessionID
    if (!owner) throw new Error("게임 로직 has no owner conversation")
    const page = await ctx.session(owner)
    await closePanel(page)
    const sent = tid(page, "dispatch-source").first()
    await sent.waitFor({ timeout: 60_000 })
    await ctx.shoot(page, "17-owner-chat", {
      marks: [tid(page, "team-pill"), [sent, page.getByText("끝나면 반영 준비를 알려 주세요").first()]],
    })
  }),
  shot("17-area-menu", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    const menu = await areaMenu(page, "게임 로직")
    await ctx.shoot(page, "17-area-menu", {
      clip: menu,
      marks: [tid(menu, "area-menu-integrate"), tid(menu, "area-menu-group-structure"), tid(menu, "area-menu-retire")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("17-bigfile", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    const menu = await areaMenu(page, "화면", "area-menu-paths")
    await tid(menu, "area-paths-dirs").fill("assets")
    await tid(menu, "area-paths-reason").fill("HUD 그림 확인")
    await ctx.shoot(page, "17-bigfile", { clip: menu, marks: [tid(menu, "area-paths-dirs")] })
    await page.keyboard.press("Escape")
  }),
  shot("17-integrate-running", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    await areaMenu(page, "게임 로직", "area-menu-integrate")
    // While it runs, the toast says so; the card comes when it ends (the check takes a few seconds).
    const toast = tid(page, "toast").filter({ hasText: "반영하는 중" }).first()
    await toast.waitFor({ timeout: 60_000 })
    await ctx.shoot(page, "17-integrate-running", { clip: [toast, tid(page, "composer")], marks: [toast] })
    const card = page.locator('[data-testid="team-integration"][data-state="done"]').first()
    await card.waitFor({ timeout: 180_000 })
    await page.waitForTimeout(1000)
    await ctx.shoot(page, "17-integrate-done", {
      clip: card,
      marks: [tid(card, "team-integration-undo"), tid(card, "team-integration-push")],
    })
  }),
  shot("17-retire", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    const menu = await areaMenu(page, "게임 로직", "area-menu-retire")
    await tid(menu, "area-retire-confirm").waitFor()
    await page.waitForTimeout(500)
    await ctx.shoot(page, "17-retire-ask", { clip: menu, marks: [tid(menu, "area-retire-confirm")] })
    await tid(menu, "area-retire-confirm").click()
    // The area ends; deleting its folder waits on the card for the user's answer.
    const card = page.locator('[data-testid="team-card"][data-state="waiting"]').first()
    await card.getByRole("button", { name: "지우기" }).waitFor({ timeout: 180_000 })
    await card.getByRole("button", { name: "지우기" }).click()
    const dialog = tid(page, "team-confirm")
    await dialog.waitFor()
    await tid(dialog, "team-confirm-details").click().catch(() => undefined)
    await page.waitForTimeout(800)
    await ctx.shoot(page, "17-retire", {
      clip: dialog,
      marks: [tid(dialog, "team-confirm-text"), tid(dialog, "team-confirm-keep")],
    })
    await tid(dialog, "team-confirm-keep").click()
  }),
  shot("17-recreate", async (ctx) => {
    const target = await areaOf(ctx, "네트워크")
    await ctx.control("remove-folder", { path: target.directory })
    // own-team notices a missing folder when one of the team's owners ends a run (06 §8.8): a word to 네트워크's owner.
    if (target.owner.sessionID) {
      const owner = await ctx.session(target.owner.sessionID)
      await send(owner, "로비 화면이 안 열려요. 확인해 줄래요?")
      await owner.waitForTimeout(5000)
    }
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    const row = area(page, "네트워크").first()
    await tid(row, "area-recreate").waitFor({ timeout: 120_000 })
    await tid(row, "area-recreate").click()
    const panel = tid(page, "area-recreate-panel")
    await panel.waitFor()
    await ctx.shoot(page, "17-recreate", {
      clip: [row, panel],
      marks: [tid(row, "area-recreate"), tid(panel, "area-recreate-confirm")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("17-review-team", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    await projectMenu(page, "space-game")
    await tid(page, "project-menu-team-review").click()
    // 2026-10-16: it asks what to change first, then shows each action to choose; nothing is applied here.
    const dialog = tid(page, "team-review")
    await tid(dialog, "team-review-hint").fill("화면 이름을 바꾸고 끝난 영역은 정리해 줘")
    await tid(dialog, "team-review-propose").click()
    const check = tid(dialog, "team-review-check").first()
    await check.waitFor({ timeout: 180_000 })
    await page.waitForTimeout(1000)
    await ctx.shoot(page, "17-review-team", {
      clip: dialog,
      marks: [
        check,
        tid(dialog, "team-review-line").filter({ hasText: /^제안:/ }).first(),
        tid(dialog, "team-review-apply"),
      ],
    })
    await page.keyboard.press("Escape")
  }),
  shot("17-team-settings", async (ctx) => {
    const page = await ctx.page({ path: "/settings/team" })
    await page.waitForTimeout(2000)
    await closePanel(page)
    await ctx.shoot(page, "17-team-settings", { marks: [page.getByText("반영하기 전에 묻기").first()] })
  }),
  shot("17-phone-team", async (ctx) => {
    const page = await ctx.page({ phone: true })
    await tid(page, "area-row").first().waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "17-phone-team")
  }),
  shot("17-adopt", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.shop!)
    await closePanel(page)
    await tid(page, "session-menu").click()
    await tid(page, "session-menu-team-enable").click()
    await enableDialog(page)
    await page.waitForFunction((seed) => !location.pathname.endsWith(seed), ctx.state.sessions.shop!, {
      timeout: 420_000,
    })
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await page.locator('[data-testid="team-card"][data-kind="enable"][data-state="done"]').first().waitFor({ timeout: 420_000 })
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "17-adopt", {
      marks: [
        tid(card, "team-card-line").filter({ hasText: /^영역 \d+개:/ }).first(),
        tid(card, "team-card-line").filter({ hasText: "ChatGPT 02" }).first(),
        page.getByText(/^팀에 넣지 않은 작업 폴더/).first(),
      ],
    })
  }),
  // 사용자가 정하는 영역 (2026-10-26): the 영역 만들기 dialog filled in (not created, so the world stays as it was) and
  // the area menu's 역할 바꾸기… panel (cancelled).
  shot("17-create-area", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    await projectMenu(page, "space-game")
    await tid(page, "project-menu-team-create-area").click()
    const dialog = tid(page, "team-create-area")
    await dialog.waitFor()
    await tid(dialog, "team-create-area-name").fill("효과음")
    await tid(dialog, "team-role-template").filter({ hasText: "에셋 담당" }).click()
    await tid(dialog, "team-create-area-slug").fill("sfx")
    await tid(dialog, "team-create-area-where").waitFor()
    await page.waitForTimeout(800)
    const harness = tid(dialog, "team-create-area-harness")
    const model = tid(dialog, "team-create-area-model")
    await ctx.shoot(page, "17-create-area", {
      clip: dialog,
      marks: [
        tid(dialog, "team-create-area-name"),
        [tid(dialog, "team-create-area-role"), tid(dialog, "team-role-templates")],
        [tid(dialog, "team-create-area-slug"), tid(dialog, "team-create-area-where")],
        (await harness.count()) > 0 ? [model, harness] : model,
      ],
    })
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
  }),
  shot("17-area-role", async (ctx) => {
    const page = await ctx.session(await teamMain(ctx))
    await closePanel(page)
    const menu = await areaMenu(page, "화면", "area-menu-role")
    const panel = tid(menu, "area-role")
    await panel.waitFor()
    await tid(panel, "area-role-text").fill("HUD와 메뉴 화면을 그리고 고쳐요. 바꾼 화면은 캡처로 확인하고, 끝나면 반영 준비를 알려요")
    await page.waitForTimeout(500)
    await ctx.shoot(page, "17-area-role", {
      clip: menu,
      marks: [tid(panel, "area-role-text"), tid(panel, "area-role-save")],
    })
    await page.keyboard.press("Escape")
  }),
]
