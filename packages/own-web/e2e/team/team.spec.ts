// Team screens (06 §9, TG20; 07 §7.4) in the whole own-web app in Edge against backend.ts: the real server with
// own-accounts, own-team and own-computer-use, fake model providers driven by own-team's directive responder. One PC
// window walks the flows in order, a 375 px device window (the backend's gateway stand-in) checks what a phone sees:
//   - turning team mode on from the conversation menu (progress toasts, the team main, the summary card), the main
//     folder's one-time banner, 되돌리기, and on again from the project menu;
//   - the team view: area rows with status words, `모델: …` and `프리셋: …` lines, account usage, header pills;
//   - `모델 바꾸기…` with the team's R4 filter (other ChatGPT accounts hidden and named), `프리셋 바꾸기…` with the preset
//     that would break R4 dimmed and why;
//   - the team view's notices (`팀 알림 n개`, 9.7): the area's rotation, the repair once a preset in use is edited to
//     break R4 (TG15, `고치기` opens that preset), a fetched large-file folder, and 닫기 by button and by Delete;
//   - Main 멈춤 from the owner's menu, the request that waits, its banner and outbox, `메인이 보냄` once it is off;
//   - 직접 작업 (2026-11-14): the user's message in the owner conversation holds the area, the main's request waits
//     with its own banner, row word and outbox reason, and 메인에게 넘기기 from the area menu lets it in;
//   - a large-file folder over the confirm threshold: the card's `[받기] [나중에]`, the device's view-only notice, the
//     folder coming in; the batched removal dialog (T3's removal confirms are laid over `team.get` here, see `removals`);
//   - the desktop lease holder (`데스크톱 사용 중`) after the team main drove the fake desktop;
//   - 375 px, keyboard-only access, 팀 모드 끄기, and no forbidden word or placeholder anywhere the team screens showed.
// The main e2e/playwright.config.ts ignores this folder; without this suite's backend it skips.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test"
import { ALLOWED } from "../ui-audit/allowlist"
import { Audit, line } from "../ui-audit/audit"
import { areaMenuItem, enableTeam } from "./flows"

interface TeamState {
  readonly dev: string
  readonly device: string
  /** The service PC's name the device view-only notices give (06 §9.8). */
  readonly pc: string
  readonly control: string
  readonly project: string
  readonly seed: string
  readonly older: string
  readonly heavy: string
  readonly presets: { readonly deepseek: string; readonly clash: string }
  readonly accounts: Readonly<Record<"01" | "02" | "03" | "deepseek" | "anthropic", string>>
  readonly models: Readonly<Record<"01" | "02" | "03" | "deepseek" | "anthropic", { readonly id: string }>>
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as TeamState

/** 06 §9.1, word for word (the catalog's unit test checks the strings; this checks what the screens showed). */
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
/** What 9.1 drops besides (the home word, "this PC": a device names the service PC). */
const ALSO = ["홈 폴더", "이 PC", "this PC"]
const PLACEHOLDER = /\{\w+\}/

/** Upper-case ASCII words match as whole words with their case; other ASCII words anywhere, any case. */
function hits(text: string, word: string) {
  if (/^[A-Z]+$/.test(word)) return new RegExp(`\\b${word}\\b`).test(text)
  if (/^[a-z ]+$/.test(word)) return text.toLowerCase().includes(word)
  return text.includes(word)
}

/** Every text a team screen showed, checked as it is read and once more at the end. */
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

test.describe("team screens (TG20)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []
  const ids = { team: "", main: "", owner: "" }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    // A failed test leaves the rest of this serial file unrun, its own 팀 모드 끄기 too: turn a team still on in F1's
    // project off here, or the T2 and T3 files (same backend) see its areas and its team beside theirs.
    if (page) await leftovers(page).catch(() => undefined)
    await context?.close()
  })

  test("팀 모드 켜기 from the conversation menu: progress, the team main, the summary card, the main folder's banner", async () => {
    await open(page, state().seed)
    await menu(page, "session-menu", "session-menu-team-enable")
    await enableTeam(page)
    const toasts = page.getByTestId("toasts")
    await expect(toasts).toContainText("프로젝트를 살펴보는 중…")
    await expect(toasts).toContainText("영역 2개를 준비하는 중…", { timeout: 60_000 })
    await expect.poll(() => current(page), { timeout: 90_000 }).not.toBe(state().seed)
    ids.main = current(page)
    ids.team = await teamID(page)

    await expect(page.getByTestId("team-pill")).toHaveText("팀 메인 · 영역 2개")
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await expect(card).toBeVisible()
    await expect(card.locator("h3")).toHaveText("팀 모드를 켰어요")
    const lines = card.getByTestId("team-card-line")
    await expect(lines.filter({ hasText: "영역 2개:" })).toContainText("화면")
    await expect(lines.filter({ hasText: "영역 2개:" })).toContainText("서버")
    await expect(lines.filter({ hasText: "모든 영역이 팀 메인(GPT-5.6 Sol · 기본)과 '평소대로'를 써요" })).toHaveCount(1)
    await expect(lines.filter({ hasText: "담당은 검사·설치 명령을 묻지 않고 실행해요" })).toContainText("바꾸기")
    await card.getByTestId("team-card-details-toggle").click()
    await expect(card.getByTestId("team-card-details")).toContainText("팀 메인 대화 만들기 · 끝남")
    await words(card)

    // The team view (06 §9.4): the project's badge, the main, then each area with its status, main and preset lines.
    await expect(page.getByTestId("project-team-badge")).toHaveText("팀")
    const main = page.getByTestId("session-row").filter({ hasText: "팀 메인" })
    // The main's default title already says 팀 메인, so the row adds no role word (sidebar/rows.tsx roleLabel).
    await expect(main).toHaveAttribute("data-team-role", "main")
    await expect(main.getByTestId("team-role")).toHaveCount(0)
    await expect(main.getByTestId("team-extra")).toContainText("프리셋 평소대로")
    await expect(main.getByTestId("account-usage")).toHaveText(/^5시간 남음 \d+%$/)
    for (const name of ["화면", "서버"]) {
      const row = area(page, name)
      await expect(row.getByTestId("area-label")).toHaveText(`${name} · 담당`)
      await expect(row.getByTestId("area-status")).toHaveText("쉬는 중")
      // 06 §4.12 (2026-10-27): new areas go inside the main folder by default, shown from there.
      await expect(row.getByTestId("area-line")).toHaveText(/^\.worktrees[\\/](web|api) · 모델: 팀과 같게$/)
      await expect(row.getByTestId("area-preset")).toHaveText("· 프리셋: 평소대로")
      await expect(row.getByTestId("area-preset")).toHaveAttribute("data-builtin", "")
    }
    await words(page.getByTestId("area-row"))

    // An older conversation of the main folder keeps its place; once, it points at the team main (9.3).
    await open(page, state().older)
    const banner = page.locator('[data-testid="team-banner"][data-kind="home"]')
    await expect(banner).toContainText("팀 모드가 켜졌어요. 일을 나눠 맡기려면 '팀 메인'에서 말하세요")
    await words(banner)
    await banner.getByRole("button", { name: "열기" }).click()
    await expect.poll(() => current(page)).toBe(ids.main)
    await open(page, state().older)
    await expect(page.getByTestId("transcript-body")).toBeVisible()
    await expect(banner).toHaveCount(0)
    await open(page, ids.main)
  })

  test("되돌리기 on the summary card turns the team off; the project menu turns it on again", async () => {
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await card.getByTestId("team-card-undo").click()
    await expect(page.getByTestId("project-team-badge")).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByTestId("area-row")).toHaveCount(0)
    await expect(page.getByTestId("team-pill")).toHaveCount(0)
    // The undo's last step takes the registry entry away (own-team ops/undo.ts `undo.registry`), after the screens,
    // which follow `team.get`, have let the team go: `team.list` can still say `on` for a moment (1 run in 3).
    await expect.poll(() => teams(page)).toEqual([])

    await open(page, state().seed)
    await menu(page, "project-menu", "project-menu-team-enable")
    // 2026-10-16: a goal goes to the judge as its hint and, once on, into the team main's composer; nothing is sent.
    // 2026-11-14: a goal over 2,000 characters says the judge reads its start; the whole goal still goes to the draft.
    const goal = `로비 화면을 새로 만들기. ${"버튼과 배경을 다시 그린다. ".repeat(200)}`.slice(0, 3_000)
    const dialog = page.getByTestId("team-enable")
    await dialog.getByTestId("team-enable-goal").fill(goal)
    await expect(dialog.getByTestId("team-enable-long")).toHaveText(
      "영역을 정할 때는 앞 2,000자만 읽어요. 전체는 팀 메인 입력창에 들어가요.",
    )
    await words(dialog)
    const enabled = page.waitForRequest((request) => request.url().includes("/rpc/own.team/enable"))
    await enableTeam(page, { goal })
    expect(((await enabled).postDataJSON() as { readonly input: { readonly hint?: string } }).input.hint).toBe(
      goal.slice(0, 2_000).trim(),
    )
    await expect.poll(() => current(page), { timeout: 90_000 }).not.toBe(state().seed)
    await expect(page.getByTestId("toasts")).toContainText("적은 내용을 팀 메인 입력창에 넣었어요")
    ids.main = current(page)
    ids.team = await teamID(page)
    await expect(page.getByTestId("team-pill")).toHaveText("팀 메인 · 영역 2개")
    await expect(page.getByTestId("area-row")).toHaveCount(2)
    await expect(page.locator('[data-testid="team-card"][data-kind="enable"]').first()).toContainText("영역 2개:")
    const box = page.locator("#own-composer-input")
    await expect(box).toHaveValue(`${goal}\n\n이 일을 팀에서 어떻게 나눌지 먼저 같이 정하자. 나누는 안을 보여 줘.`)
    // The empty team main lists what the user can say, but not over the enable draft: a click would add to it (review).
    const starter = page.getByTestId("team-starter")
    await expect(starter).toHaveCount(0)
    await box.fill("")
    await expect(starter).toBeVisible()
    await expect(starter.getByTestId("team-starter-phrase")).toHaveCount(5)
    await words(starter)
    // A phrase replaces only the phrase a click put there; typed text hides the phrases until the composer is empty.
    await starter.getByTestId("team-starter-phrase").nth(2).click()
    await expect(box).toHaveValue("팀 상태 알려 줘.")
    await starter.getByTestId("team-starter-phrase").nth(1).click()
    await expect(box).toHaveValue("지금 있는 작업 폴더를 보고 팀을 다시 짜 줘. 바꾸기 전에 먼저 보여 줘.")
    await box.press("End")
    await box.pressSequentially(" 빨리")
    await expect(starter).toHaveCount(0)
    await box.fill("")
    await expect(starter).toBeVisible()
    expect(await messageCount(page, ids.main)).toBe(0)
  })

  test("모델 바꾸기… lists only what the team's R4 allows; 프리셋 바꾸기… dims the preset that breaks it", async () => {
    await areaMenu(page, "서버", "area-menu-main")
    const switcher = page.getByTestId("switcher")
    await expect(switcher.getByTestId("switcher-team-same")).toContainText("팀과 같게")
    const accounts = switcher.getByTestId("switcher-account")
    await expect(accounts).toHaveCount(3)
    for (const label of ["ChatGPT 01", "DeepSeek", "Anthropic"])
      await expect(accounts.filter({ hasText: label })).toHaveCount(1)
    for (const label of ["ChatGPT 02", "ChatGPT 03"]) await expect(accounts.filter({ hasText: label })).toHaveCount(0)
    await expect(switcher.getByTestId("switcher-team-hidden")).toHaveText(
      "다른 ChatGPT 계정은 팀에 넣을 수 없어 목록에 없어요",
    )
    await words(switcher.getByTestId("switcher-team-hidden"))
    await accounts.filter({ hasText: "DeepSeek" }).click()
    await expect(switcher.getByTestId("switcher-estimate")).toContainText(
      "계정을 바꾸면 담당이 쉴 때 새 대화로 이어 가요",
    )
    await switcher.getByTestId("switcher-apply").click()
    await expect(page.getByTestId("toasts")).toContainText("계정을 바꾸면 담당이 쉴 때 새 대화로 이어 가요")
    await expect(area(page, "서버").getByTestId("area-line")).toContainText("모델: DeepSeek")
    // The owner idles, so the area continues in a new DeepSeek conversation right away (06 §10.1).
    await expect(page.locator('[data-testid="team-card"][data-kind="rotate"]').first()).toContainText(
      "'서버' 담당이 새 대화로 이어졌어요",
      { timeout: 60_000 },
    )
    await expect(page.getByTestId("session-row").filter({ hasText: "서버 · 담당" })).toContainText("DeepSeek")

    // The area main is DeepSeek now: its group's presets, the one pinned to ChatGPT 02 dimmed (06 §10.1).
    await areaMenu(page, "서버", "area-menu-preset")
    const panel = page.getByTestId("area-menu")
    await expect(panel).toHaveAttribute("data-panel", "preset")
    const items = panel.getByTestId("preset-menu-item")
    await expect(items.filter({ hasText: "평소대로" })).toBeEnabled()
    await expect(items.filter({ hasText: "DeepSeek 기본" })).toBeEnabled()
    const clash = items.filter({ hasText: "ChatGPT 02 리뷰" })
    await expect(clash).toBeDisabled()
    await expect(clash).toContainText("ChatGPT 02를 써서 이 팀에서 쓸 수 없어요")
    await expect(panel.getByTestId("preset-menu-note")).toHaveText(
      "비용 없음 · 바로 적용 · 이 영역의 프리셋을 바꿔요",
    )
    await words(panel)
    await items.filter({ hasText: "DeepSeek 기본" }).click()
    await expect(page.getByTestId("toasts")).toContainText("프리셋 'DeepSeek 기본' · 비용 없음 · 바로 적용")
    await expect(area(page, "서버").getByTestId("area-preset")).toHaveText("· 프리셋: DeepSeek 기본")
    await expect(area(page, "서버").getByTestId("area-preset")).not.toHaveAttribute("data-builtin", "")
    await words(area(page, "서버"))
  })

  test("the team view's notices: the rotation, a repair once a preset in use breaks R4 (고치기 opens it), 닫기", async () => {
    // Notices live in the window that heard them (06 §9.7): this page has not reloaded since the rotation above.
    const group = page.getByTestId("team-notices-row")
    const notices = page.getByTestId("team-notice")
    const rotated = notices.filter({ hasText: "'서버' 담당이 새 대화로 이어졌어요" })
    await expect(rotated).toHaveCount(1)
    await expect(rotated.getByTestId("team-notice-where")).toContainText("서버 · ")
    await expect(rotated.getByTestId("team-notice-fix")).toHaveCount(0)

    // `presets.set` does not know the team, so the edit is saved; own.team posts a repair (06 §10.1, TG15).
    const plain = {
      id: state().presets.deepseek,
      name: "DeepSeek 기본",
      group: "ds",
      delegation: "on-request",
      caps: { concurrent: 3, perMessage: 6, perSession: null },
      ultraCaps: null,
    }
    const pinned = {
      mode: "by-role",
      roles: {
        "own-review": {
          targets: [{ pin: { account: state().accounts["02"], model: state().models["02"].id } }],
          effort: "inherit",
        },
      },
    }
    await rpc(page, "own.accounts", "presets.set", { preset: { ...plain, workers: pinned } })
    const repair = page.locator('[data-testid="team-notice"][data-kind="preset.repair"]')
    await expect(repair).toHaveCount(1, { timeout: 60_000 })
    await expect(repair.getByTestId("team-notice-text")).toHaveText(
      "'DeepSeek 기본'이 ChatGPT 02를 써서 서버 리뷰를 서버 모델로 돌려요",
    )
    await expect(group).toHaveText("팀 알림 2개")
    await expect(group).toHaveClass(/font-semibold/)
    await words(notices)
    await words(group)

    // 고치기 opens the preset in the editor; nothing is saved from here.
    await repair.getByTestId("team-notice-fix").click()
    const editor = page.getByTestId("preset-editor")
    await expect(editor).toBeVisible()
    await expect(editor.getByTestId("preset-editor-name")).toHaveValue("DeepSeek 기본")
    await page.keyboard.press("Escape")
    await expect(editor).toHaveCount(0)
    await rpc(page, "own.accounts", "presets.set", { preset: { ...plain, workers: { mode: "same", roles: {} } } })

    // 닫기: the button, then Delete on the focused row.
    await repair.getByTestId("team-notice-close").click()
    await expect(repair).toHaveCount(0)
    await rotated.getByTestId("team-notice-row").focus()
    await page.keyboard.press("Delete")
    await expect(notices).toHaveCount(0)
    await expect(group).toHaveCount(0)
  })

  test("Main 멈춤 from the owner's menu holds the main's request; its banner and outbox; '메인이 보냄' once off", async () => {
    await areaMenu(page, "화면", "area-menu-open")
    await expect.poll(() => current(page)).not.toBe(ids.main)
    ids.owner = current(page)
    await expect(page.getByTestId("team-pill")).toHaveText("영역: 화면 · 담당")
    await menu(page, "session-menu", "session-menu-team-pause")
    await expect(page.getByTestId("team-pill")).toHaveText("영역: 화면 · 메인 멈춤")
    await expect(area(page, "화면").getByTestId("area-status")).toHaveText("메인 멈춤")

    await open(page, ids.main)
    await send(page, "[dispatch web 화면 정리 부탁합니다]")
    await expect(area(page, "화면").getByTestId("area-status")).toHaveText("메인 멈춤 · 요청 1개 기다림", {
      timeout: 60_000,
    })
    const owner = page.getByTestId("session-row").filter({ hasText: "화면 · 담당" })
    await expect(owner.getByTestId("team-extra")).toContainText("요청 1개 기다림")
    await words(area(page, "화면"))

    await open(page, ids.owner)
    const banner = page.locator('[data-testid="team-banner"][data-kind="paused"]')
    await expect(banner).toContainText("메인 멈춤 · 요청 1개 기다림")
    await words(banner)
    await banner.getByRole("button", { name: "보기" }).click()
    await page.getByTestId("area-menu").getByTestId("area-menu-outbox").click()
    const outbox = page.getByTestId("outbox-item")
    await expect(outbox).toHaveCount(1)
    await expect(outbox).toContainText("메인 · 할 일")
    await expect(outbox).toContainText("화면 정리 부탁합니다")
    await expect(page.getByTestId("area-menu")).toContainText("메인 멈춤이 켜져 있어 기다려요")
    await words(page.getByTestId("area-menu"))
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("area-menu")).toHaveCount(0)

    await banner.getByRole("button", { name: "메인 멈춤 끄기" }).click()
    await expect(banner).toHaveCount(0)
    const sent = page.getByTestId("dispatch-source")
    await expect(sent).toContainText("메인이 보냄", { timeout: 60_000 })
    await expect(page.getByTestId("transcript-body")).toContainText("화면 정리 부탁합니다")
    await words(sent)
    await sent.getByRole("button", { name: "원문 보기" }).click()
    await expect(sent.getByRole("button", { name: "원문 접기" })).toBeVisible()
    await expect(page.getByTestId("team-pill")).toHaveText("영역: 화면 · 담당")
    await expect(area(page, "화면").getByTestId("area-status")).not.toContainText("메인 멈춤")
  })

  test("직접 작업: the user's message in the owner conversation holds the area; the request waits; 메인에게 넘기기 lets it in", async () => {
    // 2026-11-14: the team's hold is on by default; a message the user sends in the owner conversation starts it.
    await open(page, ids.owner)
    await send(page, "버튼 색은 내가 직접 볼게")
    const status = area(page, "화면").getByTestId("area-status")
    await expect(status).toHaveText("직접 작업 중", { timeout: 60_000 })
    const banner = page.locator('[data-testid="team-banner"][data-kind="paused"]')
    // Nothing waits yet: the one-way sentence (the main's new requests do not come here until the hand-back).
    await expect(banner).toContainText(
      "이 영역에서 직접 일하는 중이에요. 메인에게 넘기기 전에는 메인의 새 요청이 이 대화에 오지 않아요",
    )
    await expect(banner.getByRole("button", { name: "메인에게 넘기기" })).toBeVisible()
    await words(banner)

    await open(page, ids.main)
    // A long request (they go whole now, 2026-11-14): the outbox clamps it to three lines with a way to open it.
    const long = `버튼 정리 부탁합니다. ${"버튼마다 여백과 색을 맞추고 눌린 모양도 확인합니다. ".repeat(40)}`.trim()
    await send(page, `[dispatch web ${long}]`)
    await expect(status).toHaveText("직접 작업 중 · 요청 1개 기다림", { timeout: 60_000 })
    await words(area(page, "화면"))

    await open(page, ids.owner)
    await expect(banner).toContainText("직접 작업 중 · 메인 요청 1개 기다림")
    await banner.getByRole("button", { name: "보기" }).click()
    await page.getByTestId("area-menu").getByTestId("area-menu-outbox").click()
    await expect(page.getByTestId("outbox-item")).toContainText("버튼 정리 부탁합니다")
    const expand = page.getByTestId("outbox-item").getByTestId("outbox-expand")
    await expect(expand).toHaveText("원문 보기")
    await expect(expand).toHaveAttribute("aria-expanded", "false")
    await expand.click()
    await expect(expand).toHaveText("원문 접기")
    await expect(expand).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByTestId("outbox-item")).toContainText(long.slice(-40))
    await expect(page.getByTestId("area-menu")).toContainText("내가 직접 작업 중이라 기다려요")
    await words(page.getByTestId("area-menu"))
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("area-menu")).toHaveCount(0)

    // 메인에게 넘기기 from the area menu: the hold ends and the waiting request goes in.
    await areaMenu(page, "화면", "area-menu-handBack")
    await expect(banner).toHaveCount(0, { timeout: 60_000 })
    await expect(status).not.toContainText("직접 작업")
    await expect(page.getByTestId("transcript-body")).toContainText("버튼 정리 부탁합니다", { timeout: 60_000 })
  })

  test("every open result card shows above the team main: four renames, four cards (no cap, 2026-11-14)", async () => {
    await open(page, ids.main)
    const renamed = ["화면 1", "화면 2", "화면 3", "화면"]
    for (const name of renamed) {
      const started = await rpc(page, "own.team", "reorg.apply", {
        teamID: ids.team,
        proposal: { version: 1, ops: [{ op: "rename", area: "web", name }] },
      })
      const opID = started.opID as string
      await expect
        .poll(async () => ((await rpc(page, "own.team", "op.get", { opID })).op as { state: string }).state, {
          timeout: 60_000,
        })
        .toBe("done")
    }
    const cards = page.locator('[data-testid="team-card"][data-kind="reorg"]')
    await expect(cards).toHaveCount(4, { timeout: 30_000 })
    await expect(area(page, "화면")).toHaveCount(1)
    await words(page.getByTestId("team-cards"))
    for (const _ of renamed) await cards.first().getByTestId("team-card-close").click()
    await expect(cards).toHaveCount(0)
  })

  test("a large-file folder over the threshold waits for 받기 on the card; a device sees it view-only", async ({
    browser,
  }) => {
    await rpc(page, "own.team", "settings.set", { teamID: ids.team, patch: { policy: { askDiskBytes: 1024 } } })
    // From the owner's header pill, by keyboard (06 §9.5): the area menu, 큰 파일 폴더 가져오기….
    await open(page, ids.owner)
    await page.getByTestId("team-pill").focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("area-menu-open")).toBeFocused()
    await page.getByTestId("area-menu-paths").click()
    // 2026-11-14: up to 64 folders at a time; 65 lines say so and nothing can be fetched.
    await page.getByTestId("area-paths-dirs").fill(Array.from({ length: 65 }, (_, index) => `media/d${index}`).join("\n"))
    await page.getByTestId("area-paths-reason").fill("너무 많은 폴더")
    await expect(page.getByTestId("area-paths-over")).toHaveText("한 번에 64개까지예요(지금 65개)")
    await expect(page.getByTestId("area-paths-fetch")).toBeDisabled()
    await page.getByTestId("area-paths-dirs").fill(state().heavy)
    await expect(page.getByTestId("area-paths-over")).toHaveCount(0)
    await page.getByTestId("area-paths-reason").fill("화면 그림 확인")
    await page.getByTestId("area-paths-fetch").click()
    await expect(page.getByTestId("area-menu")).toHaveCount(0)

    await open(page, ids.main)
    const card = page.locator('[data-testid="team-card"][data-kind="paths"]').first()
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 60_000 })
    await expect(card.getByTestId("team-card-state")).toHaveText("확인을 기다려요")
    await expect(card).toContainText("확인이 필요한 것 1개")
    const confirm = card.getByTestId("team-card-confirms")
    await expect(confirm).toContainText(`화면: 큰 파일 폴더 1개(${state().heavy})를 가져올까요?`)
    await expect(confirm.getByRole("button", { name: "받기" })).toBeVisible()
    await expect(confirm.getByRole("button", { name: "나중에" })).toBeVisible()
    await words(card)

    // A gateway device (06 §9.8): the same card, no answer, the notice that names the PC that runs the service.
    await phone(browser, async (device) => {
      await open(device, ids.main)
      const shown = device.locator('[data-testid="team-card"][data-kind="paths"]').first()
      await expect(shown.getByTestId("team-card-confirms")).toContainText(`${state().pc}에서 확인하세요`)
      await expect(shown.getByRole("button", { name: "받기" })).toHaveCount(0)
      await expect(shown.getByTestId("team-card-undo")).toHaveCount(0)
      await words(shown)
      await noSideScroll(device)
    })

    await confirm.getByRole("button", { name: "받기" }).click()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 60_000 })
    await expect(card).toContainText(/화면: 큰 파일 폴더 1개\([\d.]+ ?[KM]B\)를 가져왔어요/)
    await words(card)
    // The same words as the card's line, as a notice in the team view (9.7).
    const fetched = page.locator('[data-testid="team-notice"][data-kind="paths.added"]')
    await expect(fetched.getByTestId("team-notice-text")).toHaveText(
      /^화면: 큰 파일 폴더 1개\([\d.]+ ?[KM]B\)를 가져왔어요$/,
    )
    await words(fetched)
    await fetched.getByTestId("team-notice-close").click()
    await expect(fetched).toHaveCount(0)
    await areaMenu(page, "화면", "area-menu-details")
    await expect(page.getByTestId("area-details")).toContainText("가져온 큰 파일 폴더")
    await expect(page.getByTestId("area-details")).toContainText(state().heavy)
    await page.keyboard.press("Escape")
  })

  test("the batched removal dialog: one dialog for several areas, focus on 두기, Escape, a keyboard answer", async ({
    browser,
  }) => {
    const answers = await removals(page, ids.team)
    await page.reload()
    await ready(page)
    const card = page.locator(`[data-testid="team-card"][data-kind="retire"]`)
    await expect(card).toContainText("확인이 필요한 것 2개")
    await expect(card.getByTestId("team-card-confirms")).toContainText(/끝난 영역 2개 정리\(5 ?MB\)/)
    await words(card)
    const remove = card.getByTestId("team-card-remove")
    await remove.click()

    const dialog = page.getByTestId("team-confirm")
    await expect(dialog).toHaveAttribute("role", "alertdialog")
    await expect(dialog).toHaveAttribute("data-danger", "")
    await expect(dialog.getByRole("heading")).toHaveText(/끝난 영역 2개 정리\(5 ?MB\)/)
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await expect(dialog.getByTestId("team-confirm-keep")).toHaveText("두기")
    await expect(dialog.getByTestId("team-confirm-do")).toHaveText("지우기")
    await expect(dialog.getByTestId("team-confirm-files").locator("li")).toHaveCount(2)
    await expect(dialog).toContainText("남는 것")
    await expect(dialog).toContainText("기록 이름과 대화는 남아요")
    await words(dialog)
    // Tab stays inside the dialog.
    for (let step = 0; step < 4; step++) await page.keyboard.press("Tab")
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="team-confirm"]'))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(remove).toBeFocused()
    expect(answers).toEqual([])

    await page.keyboard.press("Enter")
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(dialog).toHaveCount(0)
    expect(answers).toEqual([
      { stepID: "remove-1", choice: "skip" },
      { stepID: "remove-2", choice: "skip" },
    ])

    // On a device the dialog only shows: the notice and 닫기.
    await phone(browser, async (device) => {
      await removals(device, ids.team)
      await open(device, ids.main)
      await device.locator('[data-testid="team-card"][data-kind="retire"]').getByTestId("team-card-remove").click()
      const shown = device.getByTestId("team-confirm")
      await expect(shown.getByTestId("team-confirm-view-only")).toHaveText(`${state().pc}에서 확인하세요`)
      await expect(shown.getByTestId("team-confirm-keep")).toHaveCount(0)
      await expect(shown.getByRole("button", { name: "닫기" })).toBeFocused()
      await words(shown)
      await device.keyboard.press("Escape")
      await expect(shown).toHaveCount(0)
    })
    await page.unrouteAll({ behavior: "wait" })
    await page.reload()
    await ready(page)
    await expect(page.locator(`[data-testid="team-card"][data-kind="retire"]`)).toHaveCount(0)
  })

  test("the team view shows who holds the desktop (`데스크톱 사용 중`) after the team main drove it", async () => {
    await open(page, ids.main)
    await menu(page, "session-menu", "session-menu-computer")
    const dialog = page.getByTestId("computer-dialog")
    await dialog.getByTestId("computer-switch").click()
    await dialog.getByTestId("computer-confirm").click()
    await expect(dialog.getByTestId("computer-state")).toHaveText("켜짐")
    await dialog.getByTestId("dialog-close").click()
    await send(page, "[computer-shot] 화면을 봐 줘")
    // The lease is held while the run lasts (the backend's answer after the screenshot takes 15 s) and released when
    // it ends (computer-use CUU-1), so the tag shows during the run and goes with it.
    const main = page.getByTestId("session-row").filter({ hasText: "팀 메인" })
    await expect(main.getByTestId("desktop-tag")).toHaveText("데스크톱 사용 중", { timeout: 30_000 })
    await words(main)
    // Areas name the holder only when one of their conversations holds it.
    await expect(page.getByTestId("area-row").getByTestId("desktop-tag")).toHaveCount(0)
    await expect(page.getByTestId("transcript-body")).toContainText("화면을 확인했습니다.", { timeout: 60_000 })
    await expect(main.getByTestId("desktop-tag")).toHaveCount(0, { timeout: 30_000 })
  })

  // MR7-17: the team main's own header (its Git chip, team pill, running-on pill, computer-use chip, 에이전트 방식 and
  // approval pills and the icon buttons) left the running-on pill nothing at 1440 px with the sidebar and the work panel
  // open, and cut its account at 1366 px. It gives way in order now (shell/header-fit.ts): the computer-use chip folds
  // to its icon first, its state in its name and tooltip; the kill switch's mark is the last thing to go and still has
  // its room here (1440 px folds up to the 에이전트 방식 pill, 1366 px also lets the Git chip go).
  test("1366 and 1440 px, sidebar and work panel open: the team main's header gives way in order and keeps the account whole", async () => {
    try {
      for (const width of [1440, 1366]) {
        await page.setViewportSize({ width, height: 900 })
        await open(page, ids.main)
        const app = page.getByTestId("app")
        if ((await app.getAttribute("data-sidebar")) !== "open") await page.getByTestId("sidebar-toggle").click()
        if ((await app.getAttribute("data-panel")) !== "open") await page.getByTestId("panel-toggle").click()
        await expect(app).toHaveAttribute("data-panel", "open")
        const header = page.getByTestId("header")
        const chip = header.getByTestId("computer-chip")
        await expect(chip).toBeVisible()
        await expect(header.getByTestId("team-pill")).toBeVisible()
        await expect(header).toHaveAttribute("data-give", /^cache computer/)
        const fit = await header.evaluate(async (node) => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const account = node.querySelector<HTMLElement>('[data-testid="running-on"] [data-part="account"]')!
          const text = document.createRange()
          text.selectNodeContents(account)
          const end = node.getBoundingClientRect().right - parseFloat(getComputedStyle(node).paddingRight)
          return {
            give: node.dataset.give,
            account: text.getBoundingClientRect().width - account.getBoundingClientRect().width,
            overflow: node.scrollWidth - node.clientWidth,
            past: Math.max(0, ...Array.from(node.children, (child) => child.getBoundingClientRect().right - end)),
            items: Array.from(node.children, (child) => {
              const box = child.getBoundingClientRect()
              return `${child.getAttribute("data-testid") ?? child.className.split(" ")[0]}:${Math.round(box.width)}`
            }).filter((item) => !item.endsWith(":0")),
          }
        })
        const where = `${width} px: ${JSON.stringify(fit)}`
        expect(fit.account, where).toBeLessThanOrEqual(0.01)
        expect(fit.overflow, where).toBeLessThanOrEqual(0)
        expect(fit.past, where).toBeLessThanOrEqual(0.5)
        // Folded to its icon: the state is in its name and on the tooltip's first line.
        const opener = chip.getByTestId("computer-chip-open")
        await expect(opener.locator("svg"), where).toBeVisible()
        await expect(opener, where).toHaveAccessibleName(/^(컴퓨터 사용|PC 조작 중)/)
        await expect(opener, where).toHaveAttribute("title", /^(컴퓨터 사용|PC 조작 중)[^\n]*\n\S/)
        const stop = chip.getByTestId("computer-stop")
        await expect(stop, where).toBeVisible()
        await expect(stop, where).toHaveAccessibleName("멈추기")
        expect(fit.give, where).not.toContain("stop")
        // The team pill's short form keeps the whole text as its name.
        await expect(header.getByTestId("team-pill"), where).toHaveAccessibleName(/^팀 메인 · 영역 \d+개$/)
        await header.screenshot({ path: test.info().outputPath(`team-main-header-${width}.png`) })
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
  })

  // MR7-17's verification: with a long title the floor (7.5rem from a 640 px header) never gave way, so the account
  // was cut at 1280–1366 px with the Stop mark gone too. The title's floor now drops (5rem, then 3em: `장바…`) before
  // the kill switch's mark, which goes only once nothing else is left; at 1366–1440 px it keeps its room. The second
  // verification: a long user-renamed account dropped the Stop mark at 1280–1366 px even where that left the account
  // cut. The mark goes only when that makes the account whole; otherwise the kill switch wins and the account takes
  // the ellipsis, its whole name in the pill's name and tooltip.
  test("1280 to 1440 px, sidebar and work panel open, a long title: the title gives way before the Stop mark, which goes only when that makes the account whole", async () => {
    const steps = ["cache", "computer", "team", "approval", "harness", "git", "title", "title-min", "stop"]
    const title = "장바구니 결제 흐름 성능 개선과 리뷰 반영을 함께 하는 대화"
    // An account renamed to the 80 characters 이름 바꾸기 takes (accounts/account-dialogs.tsx), and a shorter one.
    const longest = "ChatGPT 회사 공용 계정 ".repeat(5).slice(0, 80)
    try {
      for (const width of [1440, 1366, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        await open(page, ids.main)
        const app = page.getByTestId("app")
        if ((await app.getAttribute("data-sidebar")) !== "open") await page.getByTestId("sidebar-toggle").click()
        if ((await app.getAttribute("data-panel")) !== "open") await page.getByTestId("panel-toggle").click()
        await expect(app).toHaveAttribute("data-panel", "open")
        const header = page.getByTestId("header")
        // Everything the header holds is in (the team pill follows the team registry, a moment after the rest).
        await expect(header.getByTestId("computer-chip")).toBeVisible()
        await expect(header.getByTestId("team-pill")).toBeVisible()
        await expect(header.getByTestId("git-status-chip")).toHaveCount(1)
        await expect(header).toHaveAttribute("data-give", /^cache computer/)
        // The fit runs in the frame after the title's text changes; the measure waits two.
        const fit = await header.evaluate(async (node, title) => {
          node.querySelector(".own-title-text")!.textContent = title
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const account = node.querySelector<HTMLElement>('[data-testid="running-on"] [data-part="account"]')!
          const text = document.createRange()
          text.selectNodeContents(account)
          const end = node.getBoundingClientRect().right - parseFloat(getComputedStyle(node).paddingRight)
          return {
            give: node.dataset.give ?? "",
            account: text.getBoundingClientRect().width - account.getBoundingClientRect().width,
            title: node.querySelector('[data-testid="header-title"]')!.getBoundingClientRect().width,
            overflow: node.scrollWidth - node.clientWidth,
            past: Math.max(0, ...Array.from(node.children, (child) => child.getBoundingClientRect().right - end)),
          }
        }, title)
        const where = `${width} px: ${JSON.stringify(fit)}`
        const given = fit.give.split(" ")
        expect(given, where).toEqual(steps.slice(0, given.length))
        expect(fit.account, where).toBeLessThanOrEqual(0.01)
        expect(fit.overflow, where).toBeLessThanOrEqual(0)
        expect(fit.past, where).toBeLessThanOrEqual(0.5)
        // Two characters and the ellipsis at the least (3em of the title's 14 px).
        expect(fit.title, where).toBeGreaterThanOrEqual(41)
        if (width <= 1366) expect(given, where).toContain("title")
        if (width >= 1366) {
          expect(given, where).not.toContain("stop")
          await expect(header.getByTestId("computer-stop"), where).toBeVisible()
        }
        // Shortened, the title has its whole text as its tooltip.
        await expect(header.getByTestId("header-title"), where).toHaveAttribute("title", title)
        await header.screenshot({ path: test.info().outputPath(`team-main-header-long-${width}.png`) })
        if (width > 1366) continue
        for (const name of ["ChatGPT 회사 공용 02", longest]) {
          const long = await header.evaluate(async (node, name) => {
            const label = node.querySelector<HTMLElement>('[data-testid="running-on"]')!
            const account = label.querySelector<HTMLElement>('[data-part="account"]')!
            account.textContent = name
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            const text = document.createRange()
            text.selectNodeContents(account)
            const box = account.getBoundingClientRect().width
            return {
              give: node.dataset.give ?? "",
              // Whole up to its own cap (14em), as the fit counts it (composer/limit-fit.ts `cut`).
              whole:
                text.getBoundingClientRect().width <= box + 0.01 ||
                box + 0.5 >= parseFloat(getComputedStyle(account).maxWidth),
              label: label.textContent,
              tip: label.getAttribute("title"),
            }
          }, name)
          const at = `${width} px, ${name}: ${JSON.stringify(long)}`
          const taken = long.give.split(" ")
          expect(taken, at).toEqual(steps.slice(0, taken.length))
          // The Stop mark goes only when the account is whole without it; else every step but its own is taken.
          if (taken.includes("stop")) expect(long.whole, at).toBe(true)
          if (!long.whole) expect(long.give, at).toBe(steps.slice(0, -1).join(" "))
          // `ChatGPT 회사 공용 02` is 25 px short at 1280 px with every step; the longest name at both widths.
          if (name === longest || width === 1280) {
            expect(long.whole, at).toBe(false)
            await expect(header.getByTestId("computer-stop"), at).toBeVisible()
            await expect(header.getByTestId("computer-stop"), at).toHaveAccessibleName("멈추기")
          }
          await expect(header.getByTestId("running-on-pill"), at).toHaveAccessibleName(new RegExp(` @ ${name}`))
          if (!long.whole) expect(long.tip, at).toBe(long.label)
        }
        await header.screenshot({ path: test.info().outputPath(`team-main-header-long-account-${width}.png`) })
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
  })

  test("375 px: the team main's card, the team view and the area menu fit without sideways scrolling", async () => {
    await page.setViewportSize({ width: 375, height: 812 })
    try {
      await page.goto(`/srv/local/s/${ids.main}`)
      await ready(page)
      // The work panel the wide window opened would cover the whole conversation on a phone (03 §4.2): close it.
      const panel = page.getByTestId("panel-toggle")
      await expect(panel).toBeVisible()
      if ((await panel.getAttribute("aria-pressed")) === "true") await panel.click()
      await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${ids.main}"]`)).toBeVisible()
      await expect(page.locator('[data-testid="team-card"]').first()).toBeVisible()
      await noSideScroll(page)
      const box = await page.locator('[data-testid="team-card"]').first().boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(375)

      // On a phone the list is its own screen (03 §4.2): the team view is there.
      await page.goto("/")
      await ready(page)
      const row = area(page, "화면")
      await expect(row).toBeVisible()
      const rowBox = await row.boundingBox()
      expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(375)
      await row.click({ button: "right" })
      const menuBox = await page.getByTestId("area-menu").boundingBox()
      expect(menuBox!.x).toBeGreaterThanOrEqual(0)
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(375)
      await words(page.getByTestId("area-menu").getByRole("menu"))
      await page.keyboard.press("Escape")
      await noSideScroll(page)
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
  })

  test("keyboard only: the area menu from the tree (Shift+F10) and arrows; the card's buttons; Escape returns", async () => {
    await open(page, ids.main)
    const row = area(page, "화면")
    await row.focus()
    await page.keyboard.press("Shift+F10")
    const menuPanel = page.getByTestId("area-menu")
    await expect(menuPanel.getByTestId("area-menu-open")).toBeFocused()
    // 2026-10-16: the 대화 group comes first, so 팀 메인과 상의하기… follows 담당과 대화 열기.
    await page.keyboard.press("ArrowDown")
    await expect(menuPanel.getByTestId("area-menu-discuss")).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("ArrowUp")
    await expect(menuPanel.getByTestId("area-menu-details")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menuPanel).toHaveCount(0)
    await expect(row).toBeFocused()

    // ArrowDown walks the tree from the area to its conversation; Enter opens it.
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowDown")
    await expect(page.locator(":focus")).toHaveAttribute("data-session-id", ids.owner)
    await page.keyboard.press("Enter")
    await expect.poll(() => current(page)).toBe(ids.owner)

    await open(page, ids.main)
    const details = page.locator('[data-testid="team-card"]').first().getByTestId("team-card-details-toggle")
    await details.focus()
    await page.keyboard.press("Enter")
    await expect(details).toHaveAttribute("aria-expanded", "true")
    await page.keyboard.press("Enter")
    await expect(details).toHaveAttribute("aria-expanded", "false")
  })

  test("layout audit (e2e/ui-audit): team view, area menu with its group, project menu at 1440, 1280, 375 px", async ({}, info) => {
    const violations: string[] = []
    try {
      for (const width of [1440, 1280, 375]) {
        await page.setViewportSize({ width, height: width < 600 ? 812 : 900 })
        // On a phone the list is its own screen (03 §4.2): the team view is there.
        await page.goto(width < 600 ? "/" : `/srv/local/s/${ids.main}`)
        await ready(page)
        const audit = new Audit(info, width, ALLOWED, undefined, new Set())
        await audit.check(page, "team")
        await audit.shoot(page, "team", [page.locator("body")])
        const row = area(page, "화면").first()
        const panel = page.getByTestId("area-menu")
        await audit.popup(page, "team", {
          name: "area-menu",
          open: () => row.click({ button: "right" }),
          popup: panel,
          trigger: row,
        })
        await audit.popup(page, "team", {
          name: "area-menu-structure",
          open: async () => {
            await row.click({ button: "right" })
            await panel.getByTestId("area-menu-group-structure").click()
          },
          popup: panel,
          trigger: row,
        })
        const project = page.getByTestId("project-menu").first()
        await audit.popup(page, "team", { name: "project-menu", open: () => project.click(), trigger: project })
        await audit.write(`ui-audit-${width}`)
        violations.push(...audit.violations().map(line))
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    expect(violations).toEqual([])
  })

  test("팀 모드 끄기: 그대로 두고 끄기 with the focus on 취소; the cleanup choice is there (T3)", async () => {
    await menu(page, "project-menu", "project-menu-team-disable")
    const dialog = page.getByTestId("team-disable")
    await expect(dialog).toHaveAttribute("role", "alertdialog")
    await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused()
    await expect(dialog.getByTestId("team-disable-keep")).toHaveText("그대로 두고 끄기")
    // T3's own.team has `cleanup` (t3-reorg.spec.ts answers it); this team has no finished area, so it keeps folders.
    await expect(dialog.getByTestId("team-disable-cleanup")).toHaveText("끝난 영역 정리하고 끄기")
    await expect(dialog).toContainText("대화, 작업 폴더와 기록은 그대로 둬요. 기다리던 메인 요청은 보내지 않아요.")
    await words(dialog)
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("project-team-badge")).toHaveText("팀")

    await menu(page, "project-menu", "project-menu-team-disable")
    await dialog.getByTestId("team-disable-keep").click()
    await expect(page.getByTestId("toasts")).toContainText("팀 모드를 껐어요", { timeout: 60_000 })
    await expect(page.getByTestId("project-team-badge")).toHaveCount(0)
    await expect(page.getByTestId("area-row")).toHaveCount(0)
  })

  test("nothing the team screens showed has a forbidden word or a placeholder; no page error", () => {
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
  // The suite's first page load also compiles the transcript chunk in Vite dev: give it the connection's minute.
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

function area(page: Page, name: string) {
  return page.getByTestId("area-row").filter({ has: page.getByTestId("area-label").filter({ hasText: name }) })
}

/** An area's menu by right click on its row (the Menu key and Shift+F10 do the same), then an item. */
async function areaMenu(page: Page, name: string, item: string) {
  await area(page, name).click({ button: "right" })
  await areaMenuItem(page.getByTestId("area-menu"), item)
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

/** How many messages a conversation has on the server (none: nothing was sent). */
async function messageCount(page: Page, sessionID: string) {
  const response = await page.request.get(
    `/api/session/${sessionID}/message?location%5Bdirectory%5D=${encodeURIComponent(state().control)}`,
  )
  const body = (await response.json()) as { readonly data?: ReadonlyArray<unknown> }
  return body.data?.length ?? 0
}

async function teams(page: Page) {
  const output = await rpc(page, "own.team", "team.list", {})
  return (output.teams as ReadonlyArray<{ readonly id: string; readonly state: string }>).filter(
    (item) => item.state === "on",
  )
}

async function teamID(page: Page) {
  await expect.poll(async () => (await teams(page)).length).toBe(1)
  return (await teams(page))[0]!.id
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

/**
 * Removal confirms of two finished areas, laid over `team.get` (and `op.get` / `op.confirm` of that op): T1's
 * own.team has no step that removes a folder (area retirement and its removal step come with T3), but the confirm
 * dialog that answers them ships now (06 §9.7, TG20 "확인 대화상자(묶음 정리)"). Everything else is the real service.
 * Returns the answers own-web sent.
 */
async function removals(page: Page, teamID: string) {
  const opID = "op_01JE2E0000000000000000TEAM"
  const answers: Array<{ readonly stepID: string; readonly choice: string }> = []
  const project = state().project.replaceAll("\\", "/")
  const files = [
    { path: `${project}-team/old-a/build/app.bin`, bytes: 3_000_000 },
    { path: `${project}-team/old-b/build/app.bin`, bytes: 2_000_000 },
  ]
  const steps = files.map((file, index) => ({
    id: `remove-${index + 1}`,
    kind: "retire-remove",
    args: {},
    mode: "confirm",
    state: "needs_confirm",
    confirm: {
      nonce: `e2e-removal-nonce-000${index + 1}`,
      expiresAt: Date.now() + 9 * 60_000,
      text: `끝난 영역 '옛 영역 ${index + 1}'의 폴더를 지웁니다`,
      bytes: file.bytes,
      files: [file],
    },
  }))
  const op = { id: opID, teamID, kind: "retire", by: "user", state: "waiting", createdAt: Date.now(), steps }
  const json = (route: Route, output: unknown) => route.fulfill({ json: { output } })
  const input = (route: Route) => (route.request().postDataJSON() as { input: Record<string, string> }).input
  await page.route("**/api/rpc/own.team/team.get**", async (route) => {
    const answer = await route.fetch()
    const body = (await answer.json()) as { output?: Record<string, unknown> & { team: { id: string } | null } }
    const output = body.output
    if (!output?.team || output.team.id !== teamID || output.op) return route.fulfill({ response: answer })
    const pending = steps.map((step) => ({ teamID, opID, stepID: step.id, kind: step.kind, ...step.confirm }))
    return json(route, { ...output, op, pending: [...(output.pending as unknown[]), ...pending] })
  })
  await page.route("**/api/rpc/own.team/op.get**", (route) =>
    input(route).opID === opID ? json(route, { op }) : route.continue(),
  )
  await page.route("**/api/rpc/own.team/op.confirm**", (route) => {
    const value = input(route)
    if (value.opID !== opID) return route.continue()
    answers.push({ stepID: value.stepID!, choice: value.choice! })
    return json(route, { op })
  })
  return answers
}

/** Turns off every team still on in F1's project (a failed run's leftovers), keeping its folders. */
async function leftovers(page: Page) {
  const rpc = async (method: string, input: unknown) => {
    const response = await page.request.post(
      `/api/rpc/own.team/${method}?location%5Bdirectory%5D=${encodeURIComponent(state().control)}`,
      { data: { input } },
    )
    return ((await response.json()) as { output?: Record<string, unknown> }).output ?? {}
  }
  const normal = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  const listed = (await rpc("team.list", {})).teams as ReadonlyArray<{ id: string; state: string; home: string }>
  for (const team of listed.filter((item) => item.state === "on" && normal(item.home) === normal(state().project)))
    await rpc("disable", { teamID: team.id })
}
