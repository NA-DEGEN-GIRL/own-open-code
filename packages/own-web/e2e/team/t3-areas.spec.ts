// 사용자가 정하는 영역 (06 §2.4, §2.9 V-b (5), §9.4, 2026-10-26) in the whole own-web app in Edge against backend.ts.
// Its `quest` project (a small game) is turned on without areas; the user then sets three up by hand in the
// `영역 만들기` dialog, from the team view's row and from the project menu: 몬스터 에셋 and 시뮬레이션 with a role
// template and a folder and record name of their own (own.team names the folder it would make: `main-2` for the name
// of the project's own record, 2026-10-27), 아이템 에셋 on a model picked through the switcher (the team's R4
// filter, 팀과 같게 on top). The team main sends a request to one; the area menu changes a role (`역할 바꾸기…`) and
// shows `내가 정한 영역`. The main then proposes to merge 아이템 에셋 into 몬스터 에셋: the answer is a plan and
// nothing changes until the user's next message agrees; the merge then runs as the user's (by `user`), its folder
// removal asks in the card, and 아이템 에셋 is finished. Last, `health` answers as an older own.team without
// `area-edit` (2026-10-27): 영역 만들기 is the basic dialog (name, role, a new folder) that says why the rest is missing,
// and its area carries no mark. No forbidden word, placeholder or page error anywhere.
// Runs after the T1 and T2 specs (playwright.config.ts); without this suite's backend it skips.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { areaMenuItem, enableTeam } from "./flows"

interface AreasState {
  readonly control: string
  readonly models: Readonly<Record<string, { readonly providerID: string; readonly id: string }>>
  readonly t3: { readonly areas: { readonly home: string; readonly seed: string } }
}

interface AreaInfo {
  readonly id: string
  readonly name: string
  readonly goal: string
  readonly state: string
  readonly directory: string
  readonly userMade?: { readonly at: number }
  readonly main?: { readonly model: { readonly providerID: string }; readonly chosenBy: string }
  readonly owner: { readonly sessionID: string | null }
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as AreasState
const quest = () => state().t3.areas

/** 06 §9.1, word for word. */
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

function hits(text: string, word: string) {
  if (/^[A-Z]+$/.test(word)) return new RegExp(`\\b${word}\\b`).test(text)
  if (/^[a-z ]+$/.test(word)) return text.toLowerCase().includes(word)
  return text.includes(word)
}

/**
 * The folder and record names the user typed are the user's data, not copy; so is the folder the areas are made in
 * (`.worktrees`, 06 §4.12 프로젝트 안).
 */
const DATA = /monster-assets|item-assets|sim\b|\.worktrees(?=[\\/])/g

async function words(locator: Locator) {
  for (const text of (await locator.allInnerTexts()).map((item) => item.replace(DATA, ""))) {
    expect(
      FORBIDDEN.concat(ALSO).filter((word) => hits(text, word)),
      text,
    ).toEqual([])
    expect(text, text).not.toMatch(PLACEHOLDER)
  }
}

const MERGE = { version: 1, ops: [{ op: "merge", area: "monster-assets", from: "item-assets" }] }

const SLUG_INVALID = "영문 소문자, 숫자, -로 32자까지 써 주세요. 처음과 끝에는 -를 쓰지 않고, -를 두 개 잇지 않아요"

test.describe.configure({ mode: "serial" })

test.describe("사용자가 정하는 영역 (06 §9.4, 2026-10-26)", () => {
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
    if (page) await off(page, quest().home)
    await context?.close()
  })

  test("팀 모드 켜기 on quest makes no area; the team view offers 영역 만들기…", async () => {
    await open(page, quest().seed)
    await page.getByTestId("session-menu").first().click()
    await page.getByTestId("session-menu-team-enable").click()
    await enableTeam(page)
    ids.team = await teamOf(page, quest().home)
    await expect.poll(async () => ((await view(page)).team as { readonly main?: unknown } | null)?.main).toBeTruthy()
    ids.main = ((await view(page)).team as { readonly main: { readonly sessionID: string } }).main.sessionID
    await expect.poll(() => current(page), { timeout: 60_000 }).toBe(ids.main)
    const row = page.getByTestId("team-create-row")
    await expect(row).toHaveText("영역 만들기…")
    await words(row)
  })

  test("영역 만들기 from the row: a template role, an own folder and record name checked as it is typed", async () => {
    await page.getByTestId("team-create-row").click()
    const dialog = page.getByTestId("team-create-area")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId("team-create-area-name")).toBeFocused()
    await expect(dialog.getByTestId("team-create-area-submit")).toBeDisabled()
    await dialog.getByTestId("team-create-area-name").fill("몬스터 에셋")
    // A Korean name gives the record name `area` until the user writes one.
    await expect(dialog.getByTestId("team-create-area-slug")).toHaveValue("area")
    // 2026-11-14: a role is up to 1,000 characters; one more is refused as typed, never cut.
    const role = dialog.getByTestId("team-create-area-role")
    const left = dialog.getByTestId("team-create-area-role-left")
    await role.fill("가".repeat(1_001))
    await expect(left).toHaveText("1자 넘었어요")
    await expect(dialog.getByTestId("team-create-area-submit")).toBeDisabled()
    await role.fill("가".repeat(1_000))
    await expect(left).toHaveText("0자 남음")
    await expect(dialog.getByTestId("team-create-area-submit")).toBeEnabled()
    await dialog.getByTestId("team-role-template").filter({ hasText: "에셋 담당" }).click()
    await expect(role).toHaveValue(/^그림·소리·모델 같은 에셋을 만들고 고쳐요/)
    await dialog.getByTestId("team-create-area-slug").fill("Monster Assets")
    await expect(dialog.getByTestId("team-create-area-slug-note")).toHaveText(SLUG_INVALID)
    await expect(dialog.getByTestId("team-create-area-submit")).toBeDisabled()
    // 2026-10-27: a name own.team would change (a trailing - here) is refused as typed.
    await dialog.getByTestId("team-create-area-slug").fill("monster-")
    await expect(dialog.getByTestId("team-create-area-slug-note")).toHaveText(SLUG_INVALID)
    await expect(dialog.getByTestId("team-create-area-submit")).toBeDisabled()
    // 2026-10-27: own.team names the folder it would make (`area.create.check`); the project's record `main` is taken.
    await dialog.getByTestId("team-create-area-slug").fill("main")
    await expect(dialog.getByTestId("team-create-area-where")).toHaveText(
      /^만들 곳: .*quest[\\/]\.worktrees[\\/]main-2$/,
    )
    await expect(dialog.getByTestId("team-create-area-where-note")).toHaveText(
      "같은 기록 이름이 있어서 'main-2'로 만들어요",
    )
    await words(dialog)
    await dialog.getByTestId("team-create-area-slug").fill("monster-assets")
    await expect(dialog.getByTestId("team-create-area-where-note")).toHaveCount(0)
    // 06 §4.12 (2026-10-27): the team was turned on with its area folders inside the project.
    await expect(dialog.getByTestId("team-create-area-where")).toHaveText(
      /^만들 곳: .*quest[\\/]\.worktrees[\\/]monster-assets$/,
    )
    await expect(dialog.getByTestId("team-create-area-model")).toHaveText("팀과 같게")
    await words(dialog)
    const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
    await dialog.getByTestId("team-create-area-submit").click()
    const sent = (await applied).request().postDataJSON() as { readonly input: { readonly proposal: unknown } }
    expect(sent.input.proposal).toEqual({
      version: 1,
      ops: [
        {
          op: "new",
          slug: "monster-assets",
          name: "몬스터 에셋",
          goal: expect.stringMatching(/^그림·소리·모델 같은 에셋을/),
          userMade: true,
        },
      ],
    })
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("toasts")).toContainText("'몬스터 에셋' 영역을 만드는 중이에요")
    await settled(page)
    const row = area(page, "몬스터 에셋")
    await expect(row.getByTestId("area-user-made")).toHaveText("내가 정한 영역 ·", { timeout: 60_000 })
    await expect(row.getByTestId("area-line")).toHaveText(/^\.worktrees[\\/]monster-assets · 모델: 팀과 같게$/)
    await words(row)
    const made = await areaNamed(page, "몬스터 에셋")
    expect(same(made.directory, path.join(quest().home, ".worktrees", "monster-assets"))).toBe(true)
    // `.worktrees/` is ignored through the repository's own exclude file, never `.gitignore`.
    expect(fs.readFileSync(path.join(quest().home, ".git", "info", "exclude"), "utf8")).toContain("/.worktrees/")
    expect(fs.existsSync(path.join(quest().home, ".gitignore"))).toBe(false)
  })

  test("영역 만들기 from the project menu: the model through the switcher, the team's R4 filter on", async () => {
    await page
      .getByTestId("project-row")
      .filter({ hasText: path.basename(quest().home) })
      .getByTestId("project-menu")
      .click()
    await page.getByTestId("project-menu-team-create-area").click()
    const dialog = page.getByTestId("team-create-area")
    await dialog.getByTestId("team-create-area-name").fill("아이템 에셋")
    await dialog.getByTestId("team-create-area-role").fill("무기와 물약 아이콘을 만들어요")
    await dialog.getByTestId("team-create-area-slug").fill("item-assets")
    await dialog.getByTestId("team-create-area-model-pick").click()
    const switcher = page.getByTestId("switcher")
    await expect(switcher).toBeVisible()
    await expect(dialog).toBeHidden()
    await expect(switcher.getByTestId("switcher-team-same")).toContainText("팀과 같게")
    const accounts = switcher.getByTestId("switcher-account")
    for (const label of ["ChatGPT 02", "ChatGPT 03"]) await expect(accounts.filter({ hasText: label })).toHaveCount(0)
    await expect(switcher.getByTestId("switcher-team-hidden")).toHaveText(
      "다른 ChatGPT 계정은 팀에 넣을 수 없어 목록에 없어요",
    )
    await accounts.filter({ hasText: "Anthropic" }).click()
    await expect(switcher.getByTestId("switcher-apply")).toHaveText("고르기")
    await words(switcher.getByTestId("switcher-cost"))
    await switcher.getByTestId("switcher-apply").click()
    await expect(switcher).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId("team-create-area-model")).toContainText("Anthropic")
    await words(dialog)
    await dialog.getByTestId("team-create-area-submit").click()
    await expect(dialog).toHaveCount(0)
    await settled(page)
    const item = await areaNamed(page, "아이템 에셋")
    expect(item.userMade?.at).toBeGreaterThan(0)
    expect(item.main).toMatchObject({ chosenBy: "user" })
    expect(item.main?.model.providerID).toBe(state().models.anthropic?.providerID)
    // 몬스터 에셋 follows the team (팀과 같게).
    expect((await areaNamed(page, "몬스터 에셋")).main).toBeUndefined()
  })

  test("시뮬레이션 from the row; the team main sends a request to 몬스터 에셋", async () => {
    await page.getByTestId("team-create-row").click()
    const dialog = page.getByTestId("team-create-area")
    await dialog.getByTestId("team-create-area-name").fill("시뮬레이션")
    await dialog.getByTestId("team-role-template").filter({ hasText: "시뮬레이션 담당" }).click()
    await dialog.getByTestId("team-create-area-slug").fill("sim")
    await dialog.getByTestId("team-create-area-submit").click()
    await expect(dialog).toHaveCount(0)
    await settled(page)
    await expect(area(page, "시뮬레이션")).toBeVisible({ timeout: 60_000 })

    const monsters = await areaNamed(page, "몬스터 에셋")
    await open(page, ids.main)
    await send(page, "[dispatch monster-assets 몬스터 그림 세 장을 그려 줘]")
    await open(page, monsters.owner.sessionID!)
    const sent = page.getByTestId("dispatch-source")
    await expect(sent).toContainText("메인이 보냄", { timeout: 90_000 })
    await expect(page.getByTestId("transcript-body")).toContainText("몬스터 그림 세 장을 그려 줘")
    await words(sent)
  })

  test("a rotation that waits says on its card which step, why and since when; 취소 ends it (RH-20)", async () => {
    const sim = await areaNamed(page, "시뮬레이션")
    // The owner works on a slow request, so 새 대화로 이어가기 waits for the area's safe point.
    await open(page, ids.main)
    await send(page, "[dispatch sim [slow 45000] 오래 걸리는 시뮬레이션]")
    await expect
      .poll(async () => (await areaNamed(page, "시뮬레이션")).owner.sessionID, { timeout: 60_000 })
      .not.toBeNull()
    const owner = (await areaNamed(page, "시뮬레이션")).owner.sessionID!
    await expect
      .poll(
        async () => (await page.request.get("/api/session/active")).json().then((body) => Object.keys(body.data ?? {})),
        {
          timeout: 90_000,
        },
      )
      .toContain(owner)
    const started = await rpc(page, "own.team", "area.rotate", { teamID: ids.team, areaID: sim.id })
    const card = page.getByTestId("team-card").filter({ has: page.getByTestId("team-card-wait") })
    await expect(card.getByTestId("team-card-wait-text")).toContainText("영역에서 대화가 일하는 중이라 기다려요", {
      timeout: 60_000,
    })
    await expect(card.getByTestId("team-card-wait")).toContainText("단계 1/5")
    await expect(card.getByTestId("team-card-wait-since")).toContainText("분째")
    await expect(card.getByTestId("team-card-wait-open")).toBeVisible()
    await words(card)
    await card.getByTestId("team-card-wait-cancel").click()
    await expect(page.getByTestId("toasts")).toContainText("작업을 취소했어요")
    await expect
      .poll(async () => (await rpc(page, "own.team", "op.get", { opID: started.opID })).op, { timeout: 60_000 })
      .toMatchObject({ state: "cancelled" })
    await expect(page.getByTestId("team-card-wait")).toHaveCount(0)
    // Nothing was replaced; the slow turn ends on its own.
    expect((await areaNamed(page, "시뮬레이션")).owner.sessionID).toBe(owner)
    await expect
      .poll(
        async () => (await page.request.get("/api/session/active")).json().then((body) => Object.keys(body.data ?? {})),
        {
          timeout: 120_000,
        },
      )
      .not.toContain(owner)
  })

  test("역할 바꾸기… writes the role; the menu marks an area the user set up", async () => {
    await area(page, "시뮬레이션").click({ button: "right" })
    const menu = page.getByTestId("area-menu")
    await expect(menu.getByTestId("area-menu-user-made")).toHaveText("내가 정한 영역")
    await expect(menu.getByTestId("area-menu-userMade")).toHaveAttribute("aria-checked", "true")
    await words(menu)
    await areaMenuItem(menu, "area-menu-role")
    const panel = menu.getByTestId("area-role")
    await expect(panel.getByTestId("area-role-text")).toHaveValue(/^정한 시드와 기준값으로/)
    // 2026-11-14: 1,001 characters are refused with what is over; 1,000 are saved whole (no silent cut).
    await panel.getByTestId("area-role-text").fill("나".repeat(1_001))
    await expect(panel.getByTestId("area-role-left")).toHaveText("1자 넘었어요")
    await expect(panel.getByTestId("area-role-save")).toBeDisabled()
    await panel.getByTestId("area-role-text").fill("나".repeat(1_000))
    await expect(panel.getByTestId("area-role-left")).toHaveText("0자 남음")
    // The screen reloads the team after the area's change event (250 ms later); the panel reads the role it opens with.
    const reloaded = page.waitForResponse(
      async (response) =>
        response.url().includes("/rpc/own.team/team.get") && (await response.text()).includes("나".repeat(1_000)),
    )
    await panel.getByTestId("area-role-save").click()
    // A saved role closes the menu.
    await expect(menu).toHaveCount(0)
    await expect.poll(async () => (await areaNamed(page, "시뮬레이션")).goal).toBe("나".repeat(1_000))
    await reloaded
    await area(page, "시뮬레이션").click({ button: "right" })
    await areaMenuItem(menu, "area-menu-role")
    await expect(panel.getByTestId("area-role-text")).toHaveValue("나".repeat(1_000))
    await panel.getByTestId("area-role-text").fill("밸런스 시뮬레이션을 시드 7로 돌리고 결과를 견줘요")
    await words(panel)
    await panel.getByTestId("area-role-save").click()
    await expect(page.getByTestId("toasts")).toContainText("'시뮬레이션' 영역의 역할을 바꿨어요")
    await expect
      .poll(async () => (await areaNamed(page, "시뮬레이션")).goal)
      .toBe("밸런스 시뮬레이션을 시드 7로 돌리고 결과를 견줘요")
  })

  test("the main's merge of two areas the user set up is a plan; it runs as the user's once the user agrees", async () => {
    // Two turns, the merge and its folder removal: longer than one screen's test.
    test.setTimeout(600_000)
    await open(page, ids.main)
    const before = await areasOf(page)
    await turn(page, `[voice reorganize ${JSON.stringify({ proposal: MERGE })}]`)
    // A plan only: nothing started, both areas still there.
    expect((await view(page)).op ?? null).toBeNull()
    expect((await areasOf(page)).map((item) => [item.name, item.state])).toEqual(
      before.map((item) => [item.name, item.state]),
    )
    await turn(page, `좋아, 묶어 줘 [voice reorganize ${JSON.stringify({ proposal: MERGE })} +token=last]`)
    await expect
      .poll(async () => ((await view(page)).op as { readonly by?: string } | null)?.by ?? "none", { timeout: 60_000 })
      .toBe("user")
    const card = page.locator('[data-testid="team-card"][data-kind="reorg"]').first()
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 120_000 })
    await card.getByTestId("team-card-remove").click()
    const dialog = page.getByTestId("team-confirm")
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await dialog.getByTestId("team-confirm-do").click()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-card-line").filter({ hasText: "묶었어요" })).toHaveText(
      "'아이템 에셋'을 '몬스터 에셋'에 묶었어요",
    )
    await words(card)
    await expect.poll(async () => (await areaNamed(page, "아이템 에셋")).state).toBe("retired")
    expect((await areaNamed(page, "몬스터 에셋")).state).toBe("active")
    expect(errors).toEqual([])
  })

  test("an older own.team without `area-edit` gets the basic 영역 만들기: name, role, a new folder, and why", async () => {
    // `health` as a remote own.team released before `area-edit` answers it: it makes areas (`reorg.new`) but would
    // drop an area's model, 에이전트 방식 and mark.
    const older = (url: URL) => url.pathname.endsWith("/rpc/own.team/health")
    await page.route(older, async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as { readonly output: { readonly features: readonly string[] } }
      const features = body.output.features.filter((feature) => feature !== "area-edit")
      await route.fulfill({ response, json: { ...body, output: { ...body.output, features } } })
    })
    try {
      await open(page, ids.main)
      await page.getByTestId("team-create-row").click()
      const dialog = page.getByTestId("team-create-area")
      await expect(dialog.getByTestId("team-create-area-lead")).toHaveText(
        "영역을 직접 만들어요. 이 서버의 팀 기능이 이전 버전이라 이름, 역할, 새 작업 폴더만 정해요. 모델, 에이전트 방식, 있는 작업 폴더와 '내가 정한 영역' 표시는 서버의 앱을 업데이트하면 쓸 수 있어요",
      )
      for (const missing of ["folder", "model", "harness"])
        await expect(dialog.getByTestId(`team-create-area-${missing}`)).toHaveCount(0)
      await dialog.getByTestId("team-create-area-name").fill("레벨")
      await dialog.getByTestId("team-create-area-role").fill("레벨 배치를 만들어요")
      await dialog.getByTestId("team-create-area-slug").fill("levels")
      await expect(dialog.getByTestId("team-create-area-where")).toHaveText(
        /^만들 곳: .*quest[\\/]\.worktrees[\\/]levels$/,
      )
      await words(dialog)
      const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
      await dialog.getByTestId("team-create-area-submit").click()
      const sent = (await applied).request().postDataJSON() as { readonly input: { readonly proposal: unknown } }
      expect(sent.input.proposal).toEqual({
        version: 1,
        ops: [{ op: "new", slug: "levels", name: "레벨", goal: "레벨 배치를 만들어요" }],
      })
      await expect(dialog).toHaveCount(0)
      await settled(page)
      await expect(area(page, "레벨")).toBeVisible({ timeout: 60_000 })
      await expect(area(page, "레벨").getByTestId("area-user-made")).toHaveCount(0)
      const levels = await areaNamed(page, "레벨")
      expect(levels.userMade).toBeUndefined()
      expect(levels.goal).toBe("레벨 배치를 만들어요")
      expect(errors).toEqual([])
    } finally {
      await page.unroute(older)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------

async function open(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
  await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)).toBeVisible({
    timeout: 60_000,
  })
}

function current(page: Page) {
  return new URL(page.url()).pathname.split("/").at(-1)!
}

function area(page: Page, name: string) {
  return page.getByTestId("area-row").filter({
    has: page.getByTestId("area-label").filter({ hasText: new RegExp(`^${name} · `) }),
  })
}

/** Types into the real composer and sends; waits until the service took the message and the composer is idle. */
async function send(page: Page, text: string) {
  const box = page.locator("#own-composer-input")
  await box.click()
  await box.fill(text)
  // The composer is empty and idle before the service has the message: wait for the prompt's answer, or a `goto` right
  // after aborts the request and the turn never starts (merge round 7).
  const prompted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(new URL(response.url()).pathname),
    { timeout: 90_000 },
  )
  await box.press("Control+Enter")
  expect((await prompted).ok()).toBe(true)
  await expect(box).toHaveValue("")
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 90_000 })
}

/**
 * {@link send}, then waits for the directive responder's answer of that turn. A voice plan is approved only by the
 * user's next message that opens a turn (06 §2.9); a message sent while the plan's turn still runs is steered into it.
 */
async function turn(page: Page, text: string) {
  await send(page, text)
  // The answer after this message (the transcript renders only part of a long conversation, so nothing is counted).
  const sent = page.getByTestId("transcript-body").getByText(text, { exact: true }).last()
  const answer = sent.locator(`xpath=following::*[normalize-space(text())="${DONE}"]`).first()
  // An applied reorganization answers once its folders and owners are made (up to 90 s, tools/reorganize.ts).
  await expect(answer).toBeVisible({ timeout: 180_000 })
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 90_000 })
}

/** The directive responder's answer at the end of a turn (own-team test/e2e/directives.ts). */
const DONE = "지시를 마쳤습니다."

async function rpc(page: Page, id: string, method: string, input: unknown) {
  const response = await page.request.post(
    `/api/rpc/${id}/${method}?location%5Bdirectory%5D=${encodeURIComponent(state().control)}`,
    { data: { input } },
  )
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`${id} ${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

function view(page: Page) {
  return rpc(page, "own.team", "team.get", { directory: quest().home })
}

async function areasOf(page: Page) {
  return (await view(page)).areas as ReadonlyArray<AreaInfo>
}

async function areaNamed(page: Page, name: string) {
  const found = (await areasOf(page)).find((item) => item.name === name)
  if (!found) throw new Error(`no area ${name}`)
  return found
}

/** The team's op ended (no op runs or waits). */
async function settled(page: Page) {
  await expect.poll(async () => (await view(page)).op ?? null, { timeout: 120_000 }).toBeNull()
}

async function teamsOn(page: Page, home: string) {
  const output = await rpc(page, "own.team", "team.list", {})
  return (output.teams as ReadonlyArray<{ readonly id: string; readonly state: string; readonly home: string }>)
    .filter((item) => item.state === "on" && same(item.home, home))
    .map((item) => item.id)
}

async function teamOf(page: Page, home: string) {
  await expect.poll(async () => (await teamsOn(page, home)).length, { timeout: 60_000 }).toBe(1)
  return (await teamsOn(page, home))[0]!
}

/** Turns off every team still on in `home`'s project, answering a waiting confirm 두기 first. */
async function off(page: Page, home: string) {
  const pending = await rpc(page, "own.team", "team.get", { directory: home }).then(
    (output) => (output.pending ?? []) as ReadonlyArray<Readonly<Record<string, string>>>,
    () => [],
  )
  for (const confirm of pending)
    await rpc(page, "own.team", "op.confirm", {
      opID: confirm.opID,
      stepID: confirm.stepID,
      choice: "skip",
      nonce: confirm.nonce,
    }).catch(() => undefined)
  for (const teamID of await teamsOn(page, home).catch(() => [])) {
    await expect
      .poll(async () => (await rpc(page, "own.team", "team.get", { directory: home })).op ?? null, { timeout: 60_000 })
      .toBeNull()
      .catch(() => undefined)
    await rpc(page, "own.team", "disable", { teamID }).catch(() => undefined)
  }
  await expect.poll(async () => (await teamsOn(page, home)).length, { timeout: 60_000 }).toBe(0)
}

function same(a: string, b: string) {
  const normal = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  return normal(a) === normal(b)
}
