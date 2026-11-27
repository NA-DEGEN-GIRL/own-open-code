// 팀에 넣기 / 빼기 on a project in progress (06 §9.3, §9.4, §8.2, §8.8, §10.1; TG20's T2 surfaces) in the whole own-web
// app in Edge against backend.ts. Its `shop` project has three work folders under `.worktrees`, each with a
// conversation: `cl-perf` on ChatGPT 02, `cl-review` on DeepSeek with the preset `검토 묶음`, both of which its judge
// adopts, and `cl-x` on Anthropic with four changes not in a save point, which the judge leaves out. One PC window:
//   - 팀 모드 켜기 from the conversation menu: the summary card names the adopted areas and how their conversations
//     go on, the main line with the team account, `cl-review: DeepSeek 그대로` and its preset, the team's R4 line of
//     `cl-perf` with [이 영역 빼기], and the folder left out with [팀에 넣기];
//   - the team view: the adopted area rows (`폴더 · 부제 · 담당`, `모델: …`, `프리셋: …`), `팀에 넣지 않은 작업 폴더 1`
//     whose [팀에 넣기] opens it, the folder row's [팀에 넣기], then the `팀에 넣었어요` card with
//     `cl-x: Anthropic 그대로` (and no preset line: it keeps its group's ★);
//   - a paired phone at 375 px (the backend's gateway stand-in): the team view and the area menu without 팀에 넣기 and
//     팀에서 빼기, which need the PC's admin scope;
//   - [이 영역 빼기] on the R4 line, and 팀에서 빼기 from the area menu with its confirm (focus on 취소);
//   - 팀 모드 끄기, and no forbidden word, placeholder or page error anywhere these screens showed.
// Runs after team.spec.ts (playwright.config.ts); without this suite's backend it skips.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { areaMenuItem, enableTeam } from "./flows"

interface AdoptState {
  readonly device: string
  readonly control: string
  readonly models: Readonly<Record<"02", { readonly providerID: string }>>
  readonly t2: {
    readonly adopt: {
      readonly home: string
      readonly seed: string
      readonly folders: Readonly<Record<"perf" | "review" | "left", string>>
      readonly sessions: Readonly<Record<"perf" | "review" | "left", string>>
    }
  }
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as AdoptState
const shop = () => state().t2.adopt

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

/**
 * The project's own folder names are the user's data, not copy: area rows show a folder's path from the main folder
 * (9.4 `.worktrees\cl-cu`), so the fixture's `.worktrees` is taken out before the check.
 */
const DATA = /\.worktrees(?=[\\/])/g

/** Every text these screens showed (without {@link DATA}), checked as it is read and once more at the end. */
const seen: string[] = []

async function words(locator: Locator) {
  const texts = (await locator.allInnerTexts()).map((text) => text.replace(DATA, ""))
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

test.describe("팀에 넣기 / 빼기 (06 §9.3, §8.2, TG20)", () => {
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
    // A failed run leaves no team on for the next spec.
    if (page) await off(page, shop().home)
    await context?.close()
  })

  test("팀 모드 켜기 on a project in progress: adopted areas, the R4 line and the folder left out", async () => {
    await open(page, shop().seed)
    await menu(page, "session-menu", "session-menu-team-enable")
    await enableTeam(page)
    await expect.poll(() => current(page), { timeout: 120_000 }).not.toBe(shop().seed)
    await expect.poll(async () => (await teamsOn(page, shop().home)).length).toBe(1)
    await expect(page.getByTestId("team-pill")).toHaveText("팀 메인 · 영역 2개")

    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 60_000 })
    await expect(card.locator("h3")).toHaveText("팀 모드를 켰어요")
    const lines = card.getByTestId("team-card-line")
    await expect(lines.filter({ hasText: "영역 2개:" })).toHaveText(
      "영역 2개: cl-perf · cl-review. 지금 있는 작업 폴더를 그대로 써요.",
    )
    await expect(
      lines.filter({ hasText: "기존 대화는 그대로 두고, 메인이 일을 맡길 때 담당 역할을 붙여요." }),
    ).toHaveCount(1)
    const main = lines.filter({ hasText: "메인과 새 영역:" })
    await expect(main).toContainText("@ ChatGPT 01, 프리셋 '평소대로'. 받아들인 영역은 각 대화 그대로")

    // 9.3: the R4 line of the conversation on another ChatGPT account, with [이 영역 빼기].
    const r4 = lines.filter({ hasText: "cl-perf 대화는" })
    await expect(r4).toContainText(
      "cl-perf 대화는 ChatGPT 02를 써요. 메인이 일을 맡길 때 ChatGPT 01로 새 대화에서 이어 가요",
    )
    await expect(r4.getByTestId("team-card-unadopt")).toHaveText("이 영역 빼기")
    // The area that keeps another company's account and a preset that is not its group's ★; the R4 one follows the team.
    await expect(lines.filter({ hasText: "cl-review: DeepSeek 그대로" })).toHaveCount(1)
    await expect(lines.filter({ hasText: "cl-review: 프리셋 '검토 묶음' 그대로" })).toHaveCount(1)
    await expect(lines.filter({ hasText: /^cl-perf: / })).toHaveCount(0)
    // V13: the active folder the judge left out, with what makes it active.
    const left = lines.filter({ hasText: "팀에 넣지 않은 작업 폴더:" })
    await expect(left).toContainText("팀에 넣지 않은 작업 폴더: cl-x(저장 지점에 넣지 않은 변경 4개)")
    await expect(left.getByTestId("team-card-adopt")).toHaveText("팀에 넣기")
    await expect(lines.filter({ hasText: "지금 있는 작업 폴더 두 개를 받아들입니다." })).toHaveAttribute(
      "data-tone",
      "muted",
    )
    await words(card)

    // Nothing in the folders changed: each is still on its own record with its work.
    expect(git(shop().folders.perf, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("cl-perf")
    expect(git(shop().folders.left, ["status", "--porcelain"]).split("\n").filter(Boolean)).toHaveLength(4)
  })

  test("a paired phone at 375 px: the team view without 팀에 넣기, the area menu without 팀에서 빼기", async ({
    browser,
  }) => {
    await phone(browser, async (device) => {
      // On a phone the list is its own screen (03 §4.2).
      await device.goto("/")
      await ready(device)
      const row = area(device, "cl-perf")
      await expect(row).toBeVisible()
      const box = await row.boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(375)
      await expect(device.getByTestId("team-outside-row")).toContainText("팀에 넣지 않은 작업 폴더 1")
      await expect(device.getByTestId("team-outside-adopt")).toHaveCount(0)
      await words(device.getByTestId("area-row"))
      await row.click({ button: "right" })
      const panel = device.getByTestId("area-menu")
      await expect(panel.getByTestId("area-menu-open")).toBeVisible()
      await expect(panel.getByTestId("area-menu-unadopt")).toHaveCount(0)
      const menuBox = await panel.boundingBox()
      expect(menuBox!.x).toBeGreaterThanOrEqual(0)
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(375)
      await words(panel.getByRole("menu"))
      await device.keyboard.press("Escape")
      await noSideScroll(device)
    })
  })

  test("the team view: adopted area rows, 팀에 넣지 않은 작업 폴더 with 팀에 넣기, and the 팀에 넣었어요 card", async () => {
    const perf = area(page, "cl-perf")
    await expect(perf.getByTestId("area-label")).toHaveText("cl-perf · 성능 조정 · 담당")
    await expect(perf.getByTestId("area-line")).toHaveText(/^\.worktrees[\\/]cl-perf · 모델: 팀과 같게$/)
    await expect(perf.getByTestId("area-preset")).toHaveText("· 프리셋: 평소대로")
    const review = area(page, "cl-review")
    await expect(review.getByTestId("area-label")).toHaveText("cl-review · 결제 검토 · 담당")
    await expect(review.getByTestId("area-line")).toHaveText(/^\.worktrees[\\/]cl-review · 모델: .*DeepSeek/)
    await expect(review.getByTestId("area-preset")).toHaveText("· 프리셋: 검토 묶음")
    // The owners are the folders' own conversations, untouched (3.7).
    for (const title of ["성능 대화", "검토 대화"])
      await expect(page.getByTestId("session-row").filter({ hasText: title })).toBeVisible()
    await words(page.getByTestId("area-row"))

    // 8.8: the folder the team could take in, folded with [팀에 넣기], which opens the group.
    const outside = page.getByTestId("team-outside-row")
    await expect(outside).toContainText("팀에 넣지 않은 작업 폴더 1")
    const offer = page.getByTestId("team-outside-adopt")
    await expect(offer).toHaveText("팀에 넣기")
    await words(outside)
    await offer.click()
    await expect(offer).toHaveCount(0)
    const folder = page.getByTestId("worktree-row").filter({ hasText: "cl-x" })
    await expect(folder).toBeVisible()
    await expect(page.getByTestId("session-row").filter({ hasText: "실험 대화" })).toBeVisible()
    await folder.getByTestId("worktree-team-adopt").click()
    await expect(page.getByTestId("toasts")).toContainText("cl-x 폴더를 팀에 넣는 중…")

    const card = page.locator('[data-testid="team-card"][data-kind="adopt"]').first()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 90_000 })
    await expect(card.locator("h3")).toHaveText("팀에 넣었어요")
    const lines = card.getByTestId("team-card-line")
    await expect(lines.filter({ hasText: "'cl-x' 영역은 지금 있는 작업 폴더를 그대로 써요" })).toHaveCount(1)
    await expect(lines.filter({ hasText: "cl-x: Anthropic 그대로" })).toHaveCount(1)
    // Its preset is its own group's ★, so no preset line (9.3).
    await expect(lines.filter({ hasText: "cl-x: 프리셋" })).toHaveCount(0)
    await words(card)
    await expect(area(page, "cl-x").getByTestId("area-label")).toContainText("cl-x")
    await expect(page.getByTestId("worktree-row").filter({ hasText: "cl-x" })).toHaveCount(0, { timeout: 30_000 })
    expect(await areaNames(page)).toEqual(["cl-perf", "cl-review", "cl-x"])
  })

  test("[이 영역 빼기] on the R4 line, and 팀에서 빼기 from the area menu with its confirm", async () => {
    const enabled = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await enabled.getByTestId("team-card-unadopt").click()
    const out = page.locator('[data-testid="team-card"][data-kind="unadopt"]').first()
    await expect(out).toHaveAttribute("data-state", "done", { timeout: 90_000 })
    await expect(out.locator("h3")).toHaveText("팀에서 뺐어요")
    await expect(out.getByTestId("team-card-line")).toContainText(["'cl-perf' 영역을 팀에서 뺐어요"])
    await words(out)
    await expect(area(page, "cl-perf")).toHaveCount(0)
    // The folder, its record and its conversation stay (8.2), the conversation on its own account as before.
    expect(git(shop().folders.perf, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("cl-perf")
    const kept = await page.request.get(`/api/session/${shop().sessions.perf}`)
    expect(kept.ok()).toBe(true)
    expect(((await kept.json()) as { data: { model: { providerID: string } } }).data.model.providerID).toBe(
      state().models["02"].providerID,
    )

    // From the area menu: the confirm in the popover, focus on 취소.
    await areaMenu(page, "cl-x", "area-menu-unadopt")
    const panel = page.getByTestId("area-unadopt")
    await expect(panel).toContainText("'cl-x' 영역을 팀에서 뺄까요?")
    await expect(panel).toContainText("폴더, 기록 이름과 대화는 그대로 둬요. 기다리던 메인 요청은 보내지 않아요.")
    await expect(panel.getByRole("button", { name: "취소" })).toBeFocused()
    await words(panel)
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("area-menu")).toHaveCount(0)
    await expect(area(page, "cl-x")).toHaveCount(1)

    await areaMenu(page, "cl-x", "area-menu-unadopt")
    await page.getByTestId("area-unadopt-confirm").click()
    await expect(page.getByTestId("toasts")).toContainText("'cl-x' 영역을 팀에서 빼는 중…")
    await expect(area(page, "cl-x")).toHaveCount(0, { timeout: 90_000 })
    expect(await areaNames(page)).toEqual(["cl-review"])
    await expect(page.getByTestId("team-pill")).toHaveText("팀 메인 · 영역 1개")
  })

  test("팀 모드 끄기 keeps the folders; nothing showed a forbidden word or a placeholder; no page error", async () => {
    await projectMenu(page, shop().home, "project-menu-team-disable")
    const dialog = page.getByTestId("team-disable")
    await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused()
    await words(dialog)
    await dialog.getByTestId("team-disable-keep").click()
    await expect(page.getByTestId("toasts")).toContainText("팀 모드를 껐어요", { timeout: 60_000 })
    await expect(page.getByTestId("area-row")).toHaveCount(0)
    expect(await teamsOn(page, shop().home)).toEqual([])
    for (const folder of Object.values(shop().folders)) expect(fs.existsSync(folder)).toBe(true)

    expect(seen.length).toBeGreaterThan(10)
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

function area(page: Page, name: string) {
  return page.getByTestId("area-row").filter({
    has: page.getByTestId("area-label").filter({ hasText: new RegExp(`^${name} · `) }),
  })
}

async function areaNames(page: Page) {
  const labels = await page.getByTestId("area-row").getByTestId("area-label").allInnerTexts()
  return labels.map((label) => label.split(" · ")[0]).toSorted()
}

/** An area's menu by right click on its row, then an item. */
async function areaMenu(page: Page, name: string, item: string) {
  await area(page, name).click({ button: "right" })
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
