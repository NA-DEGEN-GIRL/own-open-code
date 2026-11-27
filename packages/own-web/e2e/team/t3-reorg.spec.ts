// Reorganizing a team (06 §8, §9.3–§9.8; TG20's T3 screens) in the whole own-web app in Edge against backend.ts. Its
// `atelier` project gets four areas (화면, 서버, 문서, 실험) without the large-file folder `media`, the ignored `data`
// proposed as a shared folder and `bun run check` as the asset check. One PC window walks the flows in order:
//   - 켜기: the shared folder's read-only confirm waits in the card and goes through the confirm dialog with what changes
//     and how to undo it (the deny entry, its command under 자세히); a paired phone at 375 px only sees it, naming the
//     service PC; 두기 leaves the folder alone;
//   - 팀 구성 다시 보기: the main's proposal in plain words with a checkbox per item; the chosen rename runs by the user
//     (`reorg.apply{proposalID, items}`, 2026-10-27), 끝내기 of 문서 under Main 멈춤 stays unchecked and untouched, 서버
//     is suggested for 끝내기 with `[끝내기…] [무시]`;
//   - the area menu's own reorganizations, each `reorg.apply{proposal}` by the user: 나누기 by keyboard only, 대화
//     옮기기 (the moved conversation's banner), 영역 묶기 (the removal dialog: list largest first with sizes, focus on 두기,
//     Escape, 지우기), 영역 끝내기 of an area with a save point not applied (the dialog says it stays; 두기 keeps the
//     folder);
//   - 찾을 수 없음 (8.8): a new area whose folder is deleted outside the team stops `missing` once an owner's run ends;
//     its row offers `[다시 만들기] [끝내기]`; 다시 만들기 makes a new area from its record (the user's `reorg.apply`
//     `op:"new"` with `from`), 끝내기 then ends the missing one without a removal;
//   - `끝낼 수 있음` (8.1): the suggestion card above the team main with `[끝내기…] [무시]`;
//   - `.assets` (4.10): the first asset check folder asks with what it writes and how to undo it; 두기 stops the
//     integration and says why;
//   - 끝난 영역 정리하고 끄기: both finished areas in one dialog (`끝난 영역 2개 정리(…)`), then the team is off;
//   - no forbidden word, placeholder or page error anywhere these screens showed.
// Runs after the T1 and T2 specs (playwright.config.ts); without this suite's backend it skips.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { areaMenuItem, enableTeam } from "./flows"

interface ReorgState {
  readonly device: string
  readonly pc: string
  readonly control: string
  readonly t3: {
    readonly reorg: {
      readonly home: string
      readonly seed: string
      readonly older: string
      readonly shared: string
    }
  }
}

interface AreaInfo {
  readonly id: string
  readonly name: string
  readonly directory: string
  readonly branch: string
  readonly paused: unknown
  readonly state: string
  readonly owner: { readonly sessionID: string | null }
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as ReorgState
const atelier = () => state().t3.reorg
const DAY = 24 * 60 * 60 * 1000

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
 * The fixture's folder names are the user's data, not copy: removal lists show the ignored entries' names
 * (`node_modules`), which are not the screen's words; so are the area folders inside the main folder (`.worktrees\<slug>`,
 * 06 §4.12 프로젝트 안).
 */
const DATA = /node_modules|\.worktrees(?=[\\/])/g

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

test.describe("재구성, 지우기 확인, 시스템 변경 확인 (06 §8, §9.3–§9.8, TG20)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []
  const ids = { team: "", main: "" }
  /** Area folders by slug, read once the team is on (they stay where they are). */
  const dirs: Record<string, string> = {}

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    // A failed run leaves no team on for the next spec.
    if (page) await off(page, atelier().home)
    await context?.close()
  })

  test("팀 모드 켜기 on atelier: the shared folder's read-only confirm waits; a phone at 375 px only sees it; 두기", async ({
    browser,
  }) => {
    await open(page, atelier().seed)
    await menu(page, "session-menu", "session-menu-team-enable")
    await enableTeam(page)
    await expect.poll(() => current(page), { timeout: 120_000 }).not.toBe(atelier().seed)
    ids.main = current(page)
    ids.team = await teamOf(page, atelier().home)
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 120_000 })
    const lines = card.getByTestId("team-card-line")
    await expect(lines.filter({ hasText: "영역 4개:" })).toHaveText("영역 4개: 화면 · 서버 · 문서 · 실험.")
    await expect(lines.filter({ hasText: "확인이 필요한 것" })).toHaveText("확인이 필요한 것 1개")
    const confirm = card.getByTestId("team-card-confirms")
    await expect(confirm).toContainText(`'${atelier().shared}' 폴더를 모든 영역에 연결할까요?`)
    const system = card.getByTestId("team-card-system")
    await expect(system).toHaveText("확인하기…")
    await words(card)
    for (const area of await areas(page)) dirs[area.id.slice("ar_".length)] = area.directory
    expect(Object.keys(dirs).toSorted()).toEqual(["api", "docs", "lab", "ui"])
    // 나누기 makes a fifth area (V5) with nothing raised first: no area limit since 2026-11-14. The specs drive owners
    // with the user's messages, so the team's 직접 작업 hold is off (the hold has its own checks in team.spec.ts).
    await rpc(page, "own.team", "settings.set", { teamID: ids.team, patch: { policy: { directHold: false } } })

    // A paired phone (06 §9.8): the confirm opens read-only, with the PC to answer on.
    await phone(browser, async (device) => {
      await open(device, ids.main)
      const shown = device.locator('[data-testid="team-card"][data-kind="enable"]').first()
      await shown.getByTestId("team-card-system").click()
      const dialog = device.getByTestId("team-confirm")
      await expect(dialog.getByTestId("team-confirm-view-only")).toHaveText(`${state().pc}에서 확인하세요`)
      await expect(dialog.getByTestId("team-confirm-do")).toHaveCount(0)
      await expect(dialog.getByTestId("team-confirm-keep")).toHaveCount(0)
      await words(dialog)
      const box = await dialog.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(375)
      await noSideScroll(device)
      await device.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
    })

    // The PC: what changes and how to undo it, the command only under 자세히; focus starts on 두기.
    await system.click()
    const dialog = page.getByTestId("team-confirm")
    await expect(dialog).toHaveAttribute("role", "alertdialog")
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await expect(dialog.getByTestId("team-confirm-keep")).toHaveText("두기")
    await expect(dialog.getByTestId("team-confirm-do")).toHaveText("하기")
    await expect(dialog.getByTestId("team-confirm-system")).toHaveText(
      `바뀌는 설정: '${atelier().shared}' 폴더를 읽기 전용으로 바꿈(쓰기와 지우기를 막고 읽기는 그대로). 되돌리는 법: 그 폴더의 속성 > 보안 > 고급에서 이 사용자의 거부 항목을 지워요`,
    )
    await expect(dialog.getByTestId("team-confirm-steps")).toHaveCount(0)
    await words(dialog)
    await dialog.getByTestId("team-confirm-details").click()
    const steps = dialog.getByTestId("team-confirm-steps")
    await expect(steps).toContainText("공유 폴더를 읽기 전용으로 바꾸기")
    await expect(steps).toContainText(`되돌리는 명령: icacls "`)
    await expect(steps).toContainText(`${atelier().shared}" /remove:d "%USERNAME%"`)
    await dialog.getByTestId("team-confirm-keep").click()
    await expect(dialog).toHaveCount(0)
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 60_000 })
    // 두기: the folder is not shared, so nothing was linked into an area.
    expect(((await view(page)).team as { readonly shared: readonly unknown[] }).shared).toEqual([])
    for (const directory of Object.values(dirs))
      expect(fs.existsSync(path.join(directory, atelier().shared))).toBe(false)
  })

  test("팀 구성 다시 보기…: the user's hint, chosen items run as the user's; 끝내기 of a Main 멈춤 area stays unchecked", async () => {
    // 화면 and 서버 each have a save point that is in the project's main code (8.1's signal without its 7 days).
    await expect(area(page, "화면")).toHaveCount(1)
    await expect(area(page, "서버")).toHaveCount(1)
    const branches = Object.fromEntries((await areas(page)).map((item) => [item.id, item.branch]))
    save(dirs.ui!, { "src/ui.ts": "export const ui = 2\n" }, "화면 고침")
    save(dirs.api!, { "src/api.ts": "export const api = 2\n" }, "서버 고침")
    git(atelier().home, ["merge", "-q", "--no-edit", branches.ar_ui!])
    git(atelier().home, ["merge", "-q", "--no-edit", branches.ar_api!])

    await areaMenu(page, "문서", "area-menu-pause")
    await expect(area(page, "문서").getByTestId("area-status")).toHaveText("메인 멈춤", { timeout: 30_000 })

    // 2026-10-16: the dialog asks what to change first; nothing is proposed or changed before 제안 받기.
    await projectMenu(page, atelier().home, "project-menu-team-review")
    const dialog = page.getByTestId("team-review")
    await expect(dialog.getByTestId("team-review-hint")).toBeFocused()
    await words(dialog)
    // 2026-11-14: the hint shows its count; over 2,000 characters 제안 받기 waits until it is shorter.
    const count = dialog.getByTestId("team-review-hint-count")
    await expect(count).toHaveText("0 / 2,000자")
    await dialog.getByTestId("team-review-hint").fill("다".repeat(2_001))
    await expect(count).toHaveText("2,001 / 2,000자")
    await expect(dialog.getByTestId("team-review-propose")).toBeDisabled()
    await dialog.getByTestId("team-review-hint").fill("다".repeat(2_000))
    await expect(count).toHaveText("2,000 / 2,000자")
    await expect(dialog.getByTestId("team-review-propose")).toBeEnabled()
    const hint = "화면 이름을 바꾸고 끝난 영역은 정리해 줘"
    await dialog.getByTestId("team-review-hint").fill(hint)
    const proposed = page.waitForRequest((request) => request.url().includes("/rpc/own.team/reorg.propose"))
    await dialog.getByTestId("team-review-propose").click()
    expect(((await proposed).postDataJSON() as { readonly input: { readonly hint?: string } }).input.hint).toBe(hint)
    const checks = dialog.getByTestId("team-review-check")
    await expect(checks).toHaveCount(2, { timeout: 120_000 })
    const lines = dialog.getByTestId("team-review-line")
    // The rename starts checked; 끝내기 of the Main 멈춤 area is choosable but unchecked, says it cannot be undone and
    // that it waits (the particles resolved, 03 §14).
    await expect(dialog.locator('[data-testid="team-review-check"][data-item="ops/0"]')).toBeChecked()
    await expect(lines.filter({ hasText: "영역 이름을" })).toHaveText("'화면' 영역 이름을 '화면 손질'로 바꿔요")
    await expect(dialog.locator('[data-testid="team-review-check"][data-item="ops/1"]')).not.toBeChecked()
    await expect(lines.filter({ hasText: "끝내요" })).toHaveText(
      "'문서' 영역을 끝내요 · 되돌릴 수 없어요 · '문서'는 메인 멈춤 중이에요. 고르면 그 대화가 쉴 때 하고, 그 대화에 인계나 정리 요청이 갈 수 있어요",
    )
    const suggested = lines.filter({ hasText: "제안:" })
    await expect(suggested).toContainText("제안: '서버' 영역을 끝낼 수 있어요(반영 끝남)")
    await expect(suggested.getByRole("button", { name: "끝내기…" })).toBeVisible()
    await words(dialog)
    await suggested.getByRole("button", { name: "무시" }).click()
    await expect(lines.filter({ hasText: "제안:" })).toHaveCount(0)

    const apply = dialog.getByTestId("team-review-apply")
    await expect(apply).toHaveText("고른 1개 적용")
    const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
    await apply.click()
    // 2026-10-27: the chosen items of the stored proposal by id, run by the user as the judge wrote them.
    const response = await applied
    expect(response.ok(), await response.text()).toBe(true)
    const sent = response.request().postDataJSON() as {
      readonly input: { readonly proposalID?: string; readonly items?: unknown; readonly proposal?: unknown }
    }
    expect(sent.input).toEqual({
      teamID: expect.any(String),
      proposalID: expect.stringMatching(/^rp_/),
      items: ["ops/0"],
    })
    const opID = ((await response.json()) as { readonly output: { readonly opID: string } }).output.opID
    const started = (await rpc(page, "own.team", "op.get", { opID })).op as {
      readonly by: string
      readonly kind: string
    }
    expect(started).toMatchObject({ by: "user", kind: "reorg" })
    await expect(dialog.getByTestId("team-review-state")).toHaveText(
      "적용했어요. 결과와 되돌리기는 팀 메인 위의 카드에 있어요",
      { timeout: 120_000 },
    )
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    const card = page.locator('[data-testid="team-card"][data-kind="reorg"]').first()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 60_000 })
    await expect(card.locator("h3")).toHaveText("팀 구성을 바꿨어요")
    const said = card.getByTestId("team-card-line")
    await expect(said.filter({ hasText: "영역 이름을" })).toHaveText("영역 이름을 '화면 손질'로 바꿨어요")
    // Only the chosen item ran: 문서 was not touched.
    await expect(said.filter({ hasText: "메인 멈춤" })).toHaveCount(0)
    await expect(card.getByTestId("team-card-undo")).toHaveText("되돌리기")
    await words(card)
    await expect(area(page, "화면 손질")).toHaveCount(1)
    await expect(area(page, "문서")).toHaveCount(1)
  })

  test("나누기 by keyboard only: the area menu from the tree (Shift+F10), arrows, the form; reorg.apply by the user", async () => {
    const row = area(page, "화면 손질")
    await row.focus()
    await page.keyboard.press("Shift+F10")
    const popover = page.getByTestId("area-menu")
    await expect(popover.getByTestId("area-menu-open")).toBeFocused()
    // 구성 바꾸기 ▸ is folded; → opens it and moves to its first item (06 §9.4, 2026-10-16).
    const group = popover.getByTestId("area-menu-group-structure")
    for (let step = 0; step < 20 && !(await focused(group)); step++) await page.keyboard.press("ArrowDown")
    await expect(group).toBeFocused()
    await expect(group).toHaveAttribute("aria-expanded", "false")
    await page.keyboard.press("ArrowRight")
    await expect(group).toHaveAttribute("aria-expanded", "true")
    const first = popover.locator('[data-group="structure"] [role="menuitem"]:not([aria-expanded])').first()
    await expect(first).toBeFocused()
    // ← folds it onto its toggle; Enter and Space open it again and move into it, never folding it on release (review).
    for (const key of ["Enter", "Space"]) {
      await page.keyboard.press("ArrowLeft")
      await expect(group).toHaveAttribute("aria-expanded", "false")
      await expect(group).toBeFocused()
      await page.keyboard.press(key)
      await expect(group).toHaveAttribute("aria-expanded", "true")
      await expect(first).toBeFocused()
    }
    await expect(popover.locator('[data-group="danger"]')).toHaveAttribute("aria-label", "끝내기·빼기")
    const split = popover.getByTestId("area-menu-split")
    for (let step = 0; step < 20 && !(await focused(split)); step++) await page.keyboard.press("ArrowDown")
    await expect(split).toBeFocused()
    await expect(split).toHaveText("나누기…")
    await page.keyboard.press("Enter")
    await expect(popover.getByTestId("area-split-name")).toBeFocused()
    await words(popover)
    await page.keyboard.type("Mock 시안")
    await page.keyboard.press("Tab")
    await expect(popover.getByTestId("area-split-goal")).toBeFocused()
    // 2026-11-14: a role over 1,000 characters says how much is over and is not sent.
    await popover.getByTestId("area-split-goal").fill("라".repeat(1_001))
    await expect(popover.getByTestId("area-split-goal-over")).toHaveText("1자 넘었어요")
    await popover.getByTestId("area-split-goal").fill("")
    await expect(popover.getByTestId("area-split-goal-over")).toHaveCount(0)
    await expect(popover.getByTestId("area-split-goal")).toBeFocused()
    await page.keyboard.type("시안 따로 만들기")
    const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
    await page.keyboard.press("Enter")
    const opID = await byUser(page, await applied, { op: "split", area: "ar_ui", name: "Mock 시안" })

    const card = reorgCard(page)
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-card-line").filter({ hasText: "나눴어요" })).toHaveText(
      "'화면 손질'에서 'Mock 시안'을 나눴어요",
    )
    await words(card)
    await expect(area(page, "Mock 시안")).toHaveCount(1, { timeout: 30_000 })
    const made = (await areas(page)).find((item) => item.name === "Mock 시안")!
    dirs.mock = made.directory
    expect(((await rpc(page, "own.team", "op.get", { opID })).op as { readonly state: string }).state).toBe("done")
  })

  test("대화 옮기기: 예전 메모 goes on in 실험's folder, with the banner that it cannot go back before the move", async () => {
    await areaMenu(page, "실험", "area-menu-move")
    const panel = page.getByTestId("area-move")
    await expect(panel).toContainText("'실험'으로 옮길 대화")
    await words(panel)
    await panel.getByTestId("area-move-session").filter({ hasText: "예전 메모" }).click()
    const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
    await panel.getByTestId("area-move-do").click()
    await byUser(page, await applied, { op: "move", sessionID: atelier().older, area: "ar_lab" })
    await expect(reorgCard(page)).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect
      .poll(async () => same(await directoryOf(page, atelier().older), dirs.lab!), { timeout: 30_000 })
      .toBe(true)

    await open(page, atelier().older)
    const banner = page.getByTestId("team-banner").filter({ hasText: "옮기기 전" })
    await expect(banner).toContainText("이 대화는 옮기기 전 지점으로 되돌릴 수 없어요", { timeout: 30_000 })
    await words(banner)
    await open(page, ids.main)
  })

  test("영역 묶기: Mock 시안 into 화면 손질; the removal dialog lists what goes, largest first, focus on 두기; 지우기", async () => {
    write(dirs.mock!, {
      "node_modules/left-pad/index.js": "x".repeat(300 * 1024),
      "dist/app.js": "y".repeat(100 * 1024),
    })
    await areaMenu(page, "화면 손질", "area-menu-merge")
    const panel = page.getByTestId("area-merge")
    await panel.getByTestId("area-merge-peer").filter({ hasText: "Mock 시안" }).click()
    await expect(panel.getByTestId("area-merge-do")).toHaveText("'Mock 시안' 묶기")
    await words(panel)
    const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
    await panel.getByTestId("area-merge-do").click()
    await byUser(page, await applied, { op: "merge", area: "ar_ui" })

    const card = reorgCard(page)
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 120_000 })
    const remove = card.getByTestId("team-card-remove")
    await expect(remove).toHaveText("지우기")
    await expect(card.getByTestId("team-card-confirms")).toContainText("'Mock 시안' 폴더를 지울까요?")
    await words(card)
    await remove.click()
    const dialog = page.getByTestId("team-confirm")
    await expect(dialog).toHaveAttribute("role", "alertdialog")
    await expect(dialog).toHaveAttribute("data-danger", "")
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await expect(dialog.getByTestId("team-confirm-keep")).toHaveText("두기")
    await expect(dialog.getByTestId("team-confirm-do")).toHaveText("지우기")
    const files = dialog.getByTestId("team-confirm-files").locator("li")
    await expect(files).toHaveCount(2)
    await expect(files.nth(0)).toContainText("node_modules")
    await expect(files.nth(0)).toContainText(/\d+(\.\d+)? ?[kM]B/)
    await expect(files.nth(1)).toContainText("dist")
    await expect(dialog).toContainText("지워지는 것 · ")
    await expect(dialog).toContainText("기록 이름과 대화는 남아요")
    await words(dialog)
    // Escape keeps everything; the dialog opens again from the keyboard with the focus on 두기.
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(remove).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await dialog.getByTestId("team-confirm-do").click()
    await expect(dialog).toHaveCount(0)
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-card-line").filter({ hasText: "묶었어요" })).toHaveText(
      "'Mock 시안'을 '화면 손질'에 묶었어요",
    )
    await words(card)
    await expect.poll(() => fs.existsSync(dirs.mock!), { timeout: 30_000 }).toBe(false)
    // The record name stays (TI-4).
    expect(git(atelier().home, ["branch", "--list", "mock"])).toContain("mock")
    await expect(area(page, "Mock 시안")).toHaveCount(0)
  })

  test("영역 끝내기 on 문서 with a save point not applied: the dialog says it stays in the record; 두기 keeps the folder", async () => {
    save(dirs.docs!, { "docs/guide.md": "# guide\n\n고친 안내\n" }, "안내 고침")
    write(dirs.docs!, { "dist/guide.html": "z".repeat(64 * 1024) })
    await areaMenu(page, "문서", "area-menu-retire")
    const panel = page.getByTestId("area-retire")
    await expect(panel).toHaveAttribute("data-kind", "active")
    await expect(panel).toContainText("'문서' 영역을 끝낼까요?")
    await words(panel)
    const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
    await panel.getByTestId("area-retire-confirm").click()
    await byUser(page, await applied, { op: "retire", area: "ar_docs" })

    const card = reorgCard(page)
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 120_000 })
    await card.getByTestId("team-card-remove").click()
    const dialog = page.getByTestId("team-confirm")
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await expect(dialog.getByTestId("team-confirm-text")).toContainText("'문서' 폴더를 지울까요?")
    // The count comes from the removal step's `unapplied` (counted when the op was planned), on the 남는 것 line.
    await expect(dialog.getByTestId("team-confirm-unapplied")).toContainText(
      "반영하지 않은 저장 지점 1개는 기록에 남아요",
    )
    await expect(dialog.getByTestId("team-confirm-files").locator("li")).toHaveCount(1)
    await expect(dialog.getByTestId("team-confirm-files")).toContainText("dist")
    await words(dialog)
    await dialog.getByTestId("team-confirm-keep").click()
    await expect(dialog).toHaveCount(0)
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-card-line").filter({ hasText: "끝냈어요" })).toHaveText(
      "'문서' 영역을 끝냈어요",
    )
    await words(card)
    await expect(area(page, "문서")).toHaveCount(0)
    // 두기: the folder and its save point stay.
    expect(fs.existsSync(path.join(dirs.docs!, "dist", "guide.html"))).toBe(true)
    const branch = (await branchOf(page, "ar_docs")) ?? "docs"
    expect(git(atelier().home, ["log", "-1", "--format=%s", `refs/heads/${branch}`, "--"])).toBe("안내 고침")
  })

  test("찾을 수 없음 (8.8): [다시 만들기] [끝내기] on a folder gone outside the team; 다시 만들기 makes it from its record", async () => {
    // A new area 임시 with a save point of its own; then its folder goes outside the team.
    const made = (
      await rpc(page, "own.team", "reorg.apply", {
        teamID: ids.team,
        proposal: { version: 1, ops: [{ op: "new", slug: "temp", name: "임시", goal: "잠깐 쓰기" }] },
      })
    ).opID as string
    await expect
      .poll(async () => ((await rpc(page, "own.team", "op.get", { opID: made })).op as { state: string }).state, {
        timeout: 120_000,
      })
      .toBe("done")
    const temp = (await areas(page)).find((item) => item.id === "ar_temp")!
    const tip = save(temp.directory, { "src/temp.ts": "export const temp = 1\n" }, "임시 작업")
    // A git or other short-lived process the team or the server starts in the new folder holds it for a moment; on a
    // loaded PC longer than 5 s (EBUSY, 2026-10-17).
    fs.rmSync(temp.directory, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 })
    // An owner's run ends (the user talks to 실험's owner): the team follows what changed outside it (8.8).
    const lab = (await areas(page)).find((item) => item.id === "ar_lab")!
    await open(page, lab.owner.sessionID!)
    await send(page, "지금 상태를 한 줄로 알려 주세요")
    await open(page, ids.main)
    const row = page.locator('[data-testid="area-row"][data-area-id="ar_temp"]')
    await expect(row.getByTestId("area-status")).toHaveText("찾을 수 없음", { timeout: 120_000 })
    await expect(row.getByTestId("area-recreate")).toHaveText("다시 만들기")
    await expect(row.getByTestId("area-finish")).toHaveText("끝내기")
    await words(row)

    await row.getByTestId("area-recreate").click()
    const popover = page.getByTestId("area-menu")
    await expect(popover).toHaveAttribute("data-panel", "recreate")
    const panel = popover.getByTestId("area-recreate-panel")
    await expect(panel).toHaveAttribute("data-kind", "missing")
    await expect(panel).toContainText("'임시' 영역을 다시 만들까요?")
    await words(panel)
    const applied = page.waitForResponse((response) => response.url().includes("/rpc/own.team/reorg.apply"))
    await panel.getByTestId("area-recreate-confirm").click()
    const opID = await byUser(page, await applied, { op: "new", slug: "temp", from: "temp" })
    await expect
      .poll(async () => ((await rpc(page, "own.team", "op.get", { opID })).op as { state: string }).state, {
        timeout: 120_000,
      })
      .toBe("done")
    const card = reorgCard(page)
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-card-line").filter({ hasText: "만들었어요" })).toHaveText(
      "'임시' 영역을 만들었어요",
    )
    await words(card)
    // The new area carries on from the old record's last save point, in a folder of its own.
    const remade = (await areas(page)).find((item) => item.id === "ar_temp-2")!
    expect(remade).toMatchObject({ name: "임시", state: "active" })
    expect(git(atelier().home, ["rev-parse", `refs/heads/${remade.branch}`])).toBe(tip)
    expect(fs.existsSync(path.join(remade.directory, "src", "temp.ts"))).toBe(true)
    await expect(page.locator('[data-testid="area-row"][data-area-id="ar_temp-2"]')).toHaveCount(1)

    // 끝내기 on the missing one: nothing to remove, and its record name stays.
    await row.getByTestId("area-finish").click()
    const retire = page.getByTestId("area-menu").getByTestId("area-retire")
    await expect(retire).toHaveAttribute("data-kind", "missing")
    await words(retire)
    await retire.getByTestId("area-retire-confirm").click()
    await expect(row).toHaveCount(0, { timeout: 120_000 })
    expect(git(atelier().home, ["rev-parse", `refs/heads/${temp.branch}`])).toBe(tip)
  })

  test("끝낼 수 있음 (8.1): the suggestion card above the team main with [끝내기…] and [무시]", async () => {
    // The signal needs seven quiet days (8.1), which no test waits for: the service's own answer gets `retirable`
    // for 서버, whose work is all applied and clean; everything else is the real service.
    const since = Date.now() - 8 * DAY
    await page.route("**/api/rpc/own.team/team.get**", async (route) => {
      const answer = await route.fetch()
      const body = (await answer.json()) as { output?: { areas?: ReadonlyArray<Record<string, unknown>> } }
      const output = body.output
      if (!output?.areas) return route.fulfill({ response: answer })
      const areas = output.areas.map((item) => (item.id === "ar_api" ? { ...item, retirable: { since } } : item))
      return route.fulfill({ response: answer, json: { output: { ...output, areas } } })
    })
    try {
      await open(page, ids.main)
      const card = page.locator('[data-testid="team-suggestion"][data-area-id="ar_api"]')
      await expect(card).toHaveText(/제안: '서버' 영역을 끝낼 수 있어요\(모두 반영됨, 8일 동안 변경 없음\)/, {
        timeout: 60_000,
      })
      await expect(area(page, "서버").getByTestId("area-retirable")).toHaveText("끝낼 수 있음")
      await expect(card.getByTestId("team-suggestion-retire")).toHaveText("끝내기…")
      await expect(card.getByTestId("team-suggestion-ignore")).toHaveText("무시")
      await words(card)
      // 끝내기… opens the area menu at 영역 끝내기; nothing is retired until the user says so.
      await card.getByTestId("team-suggestion-retire").click()
      const popover = page.getByTestId("area-menu")
      await expect(popover).toHaveAttribute("data-panel", "retire")
      await expect(popover.getByTestId("area-retire")).toContainText("'서버' 영역을 끝낼까요?")
      await page.keyboard.press("Escape")
      await expect(popover).toHaveCount(0)
      await card.getByTestId("team-suggestion-ignore").click()
      await expect(card).toHaveCount(0)
    } finally {
      await page.unroute("**/api/rpc/own.team/team.get**")
    }
    await expect(area(page, "서버")).toHaveCount(1)
  })

  test(".assets (4.10): the first asset check folder asks what it writes and how to undo it; 두기 stops it", async () => {
    // A change in the large-file folder needs the asset check; any disk use asks first. The area is code-only: it
    // fetches `media` first (under the default limits, no confirm), as an owner would with team_need_paths, since a
    // code-only candidate may change a large-file folder only inside the folders it fetched (4.10).
    const fetched = (await rpc(page, "own.team", "area.paths", { teamID: ids.team, areaID: "ar_lab", add: ["media"] }))
      .opID as string
    await expect
      .poll(async () => ((await rpc(page, "own.team", "op.get", { opID: fetched })).op as { state: string }).state, {
        timeout: 120_000,
      })
      .toBe("done")
    await rpc(page, "own.team", "settings.set", { teamID: ids.team, patch: { policy: { askDiskBytes: 1 } } })
    save(dirs.lab!, { "media/lab-preview.bin": "엔진 확인\n" }, "실험 미리보기")
    await open(page, ids.main)

    await areaMenu(page, "실험", "area-menu-integrate")
    const card = page.getByTestId("team-integration").filter({ has: page.getByTestId("team-integration-confirm") })
    const ask = card.first().getByTestId("team-integration-confirm")
    await expect(ask).toHaveText("확인하기…", { timeout: 120_000 })
    await expect(card.first().getByTestId("team-integration-confirms")).toContainText(
      "큰 파일 검사 폴더(.assets)를 처음 만들까요?",
    )
    await words(card.first())
    // The integration ran its first steps in an op of their own; it still has one card above the team main.
    await expect(page.getByTestId("team-integration-confirm")).toHaveCount(1)
    await ask.click()
    const dialog = page.getByTestId("team-confirm")
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    await expect(dialog.getByTestId("team-confirm-system")).toHaveText(
      /^바뀌는 설정: 큰 파일 검사용 폴더 \.assets\S* 만듦\(디스크 .+\)\. 되돌리는 법: 팀 모드를 끄면 그 폴더의 잠금이 풀리고, 작업 폴더 목록에서 그 폴더를 지워요\. 그 폴더에는 사용자 작업이 없어요$/,
    )
    await words(dialog)
    await dialog.getByTestId("team-confirm-keep").click()
    await expect(dialog).toHaveCount(0)
    const failed = page.getByTestId("team-integration").first()
    await expect(failed).toHaveAttribute("data-state", "failed", { timeout: 120_000 })
    await expect(failed.getByTestId("team-integration-title")).toHaveText(
      "큰 파일 검사 폴더를 만들지 않아 반영하지 않았어요",
    )
    await words(failed)
    const team = (await view(page)).team as { readonly worktreeRoot: string }
    expect(fs.existsSync(path.join(team.worktreeRoot, ".assets"))).toBe(false)
  })

  test("끝난 영역 정리하고 끄기: both finished areas in one dialog, largest first; 지우기, then the team is off", async () => {
    write(dirs.ui!, { "node_modules/ui-kit/index.js": "u".repeat(200 * 1024) })
    write(dirs.api!, { "dist/server.js": "s".repeat(80 * 1024) })
    await projectMenu(page, atelier().home, "project-menu-team-disable")
    const ask = page.getByTestId("team-disable")
    await expect(ask.getByRole("button", { name: "취소" })).toBeFocused()
    await expect(ask.getByTestId("team-disable-cleanup")).toHaveText("끝난 영역 정리하고 끄기")
    await words(ask)
    await ask.getByTestId("team-disable-cleanup").click()
    await expect(ask).toHaveCount(0)
    await expect(page.getByTestId("toasts")).toContainText("끝난 영역의 폴더를 지울지 답하면 팀 모드를 꺼요", {
      timeout: 60_000,
    })

    const card = page.locator('[data-testid="team-card"][data-kind="disable"]').first()
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 120_000 })
    const remove = card.getByTestId("team-card-remove")
    await expect(card.getByTestId("team-card-confirms")).toContainText(/끝난 영역 2개 정리\(.+\)/)
    await words(card)
    await remove.click()
    const dialog = page.getByTestId("team-confirm")
    await expect(dialog.locator("h2")).toHaveText(/^끝난 영역 2개 정리\(.+\)$/)
    await expect(dialog.getByTestId("team-confirm-keep")).toBeFocused()
    const files = dialog.getByTestId("team-confirm-files").locator("li")
    await expect(files).toHaveCount(2)
    await expect(files.nth(0)).toContainText("node_modules")
    await expect(files.nth(1)).toContainText("dist")
    await expect(dialog.getByTestId("team-confirm-text")).toHaveCount(2)
    await words(dialog)
    await dialog.getByTestId("team-confirm-do").click()
    // The dialog closes once both answers came back, and `op.confirm` answers after the step it confirms ran (the
    // folder deleted): 15.8 s and 11.0 s at 100 % CPU (RH-51).
    await expect(dialog).toHaveCount(0, { timeout: 120_000 })
    await expect.poll(() => teamsOn(page, atelier().home), { timeout: 120_000 }).toEqual([])
    expect(fs.existsSync(dirs.ui!)).toBe(false)
    expect(fs.existsSync(dirs.api!)).toBe(false)
    // An area that was not finished keeps its folder.
    expect(fs.existsSync(dirs.lab!)).toBe(true)
  })

  test("nothing showed a forbidden word or a placeholder; no page error", () => {
    expect(seen.length).toBeGreaterThan(10)
    const text = seen.join("\n")
    expect(FORBIDDEN.concat(ALSO).filter((word) => hits(text, word))).toEqual([])
    expect(text).not.toMatch(PLACEHOLDER)
    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** The newest reorganization card above the team main (newest first). */
function reorgCard(page: Page) {
  return page.locator('[data-testid="team-card"][data-kind="reorg"]').first()
}

/**
 * The area menu's `reorg.apply` carried the user's own proposal (`{teamID, proposal}`, 2.7) with one op like `op`, and
 * the op it started is the user's; returns its id.
 */
async function byUser(
  page: Page,
  response: Awaited<ReturnType<Page["waitForResponse"]>>,
  op: Readonly<Record<string, string>>,
) {
  expect(response.ok(), await response.text()).toBe(true)
  const sent = response.request().postDataJSON() as {
    readonly input: { readonly proposal?: { readonly ops?: unknown } }
  }
  expect(sent.input.proposal?.ops).toEqual([expect.objectContaining(op)])
  const opID = ((await response.json()) as { readonly output: { readonly opID: string } }).output.opID
  const started = (await rpc(page, "own.team", "op.get", { opID })).op as { readonly by: string; readonly kind: string }
  expect(started).toMatchObject({ by: "user", kind: "reorg" })
  return opID
}

function focused(locator: Locator) {
  return locator.evaluate((element) => element === document.activeElement).catch(() => false)
}

/** A save point in an area folder, as the user working there makes one; returns its sha. */
function save(folder: string, files: Readonly<Record<string, string>>, message: string) {
  write(folder, files)
  git(folder, ["add", "-A"])
  git(folder, ["commit", "-q", "-m", message])
  return git(folder, ["rev-parse", "HEAD"])
}

/** Writes files under a folder (relative paths with `/`), making their folders. */
function write(folder: string, files: Readonly<Record<string, string>>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(folder, ...name.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

async function open(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  await ready(page)
  // A fresh server loads its first conversation slowly (the whole suite runs this spec warm, after T1 and T2).
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

/** An area's menu by right click on its row, then an item. */
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

/** `team.get` of atelier's team. */
function view(page: Page) {
  return rpc(page, "own.team", "team.get", { directory: atelier().home })
}

async function areas(page: Page) {
  return (await view(page)).areas as ReadonlyArray<AreaInfo>
}

async function branchOf(page: Page, areaID: string) {
  return (await areas(page)).find((item) => item.id === areaID)?.branch
}

/** Where a conversation works now (`session.get`). */
async function directoryOf(page: Page, sessionID: string) {
  const response = await page.request.get(`/api/session/${sessionID}`)
  const body = (await response.json()) as { readonly data?: { readonly location?: { readonly directory?: string } } }
  return body.data?.location?.directory ?? ""
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

/**
 * Turns off every team still on in `home`'s project (a failed run's leftovers), keeping its folders: a confirm that
 * still waits is answered 두기 first, so its op ends and the team can go off.
 */
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
