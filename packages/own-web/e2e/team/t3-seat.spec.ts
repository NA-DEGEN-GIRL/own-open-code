// 담당 대화 바꾸기 (06 §6.8, 2026-11-12) in the whole own-web app in Edge against backend.ts. Its `depot` project gets
// one area, `재고 화면`, whose owner conversation own.team makes. The user opens three more conversations in the area's
// folder: `새 설계` on another company's model, `다른 구독` on the team company's other subscription and `리뷰 대화`.
//   - `이 대화를 담당으로` on a row of 이 영역의 다른 대화 opens one confirm: one sentence naming the conversation and
//     what it runs on, 취소 and 바꾸기, nothing to tick;
//   - 바꾸기 while the owner works on a main request: `지금 일이 끝나면 바꿔요`, the card says what it waits for, the
//     same item on another row is dimmed with its reason; when the work ends the toast names the new owner and offers
//     the way back, `다시 <old>(으)로`, which moves the seat back;
//   - from the conversation's own menu with Main 멈춤 on: the toast says Main 멈춤 is on; the main's next request waits
//     for the chosen conversation and reaches it at 메인 멈춤 끄기; the conversation that gave the seat away says so,
//     leads to the owner (`담당 대화로 가기`) and takes the seat again (`다시 담당으로`);
//   - a conversation on the team company's other subscription is refused in plain words and nothing changes;
//   - the area menu lists `팀과 이야기하는 대화`, the owner first, each with its note on a second line; 메모 바꾸기…
//     writes the owner note; a peer (동료) takes the seat from its row there, and its confirm says it leaves the peers;
//   - a conversation the seat was moved off is offered `동료로 등록…` again, and own.team takes it (2026-11-13);
//   - 375 px: the banner and the confirm fit; the toast keeps its sentence beside a way back whose long title is cut;
//     a paired phone (the backend's gateway stand-in) reads the list and the banner without the buttons that change
//     the seat.
// No forbidden word, placeholder or page error anywhere. Runs after the T1 and T2 specs (playwright.config.ts); without
// this suite's backend it skips.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { enableTeam } from "./flows"

interface SeatState {
  readonly control: string
  readonly device: string
  readonly models: Readonly<Record<string, { readonly providerID: string; readonly id: string }>>
  readonly t3: { readonly seat: { readonly home: string; readonly seed: string; readonly area: string } }
}

interface AreaInfo {
  readonly id: string
  readonly name: string
  readonly directory: string
  readonly paused: false | string
  readonly owner: {
    readonly sessionID: string | null
    readonly previous: ReadonlyArray<{ readonly sessionID: string; readonly why: string }>
    readonly note?: string
  }
  readonly peers?: ReadonlyArray<{ readonly key: string; readonly sessionID: string; readonly label: string }>
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as SeatState
const depot = () => state().t3.seat

/** The area, and the title own.team gave its first owner conversation. */
const AREA = "재고 화면"
const FIRST = `${AREA} · 담당`
const NEXT = "새 설계"
const RIVAL = "다른 구독"
const REVIEW = "리뷰 대화"
const ROLE = "바뀐 코드를 읽고 문제를 알려요"
const NOTE = "설계와 구현을 맡아요"
const BLOCKED = "팀의 다른 작업이 끝나면 바꿀 수 있어요"
/** Longer than the twelve characters the way back keeps (team/enable.ts `BACK_NAME`). */
const LONG = "재고 화면을 처음부터 다시 그려 보는 아주 긴 이름의 대화"

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

async function words(locator: Locator) {
  for (const text of await locator.allInnerTexts()) {
    expect(
      FORBIDDEN.concat(ALSO).filter((word) => hits(text, word)),
      text,
    ).toEqual([])
    expect(text, text).not.toMatch(PLACEHOLDER)
  }
}

test.describe.configure({ mode: "serial" })

test.describe("담당 대화 바꾸기 (06 §6.8, 2026-11-12)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []
  const ids = { team: "", main: "", area: "", first: "", next: "", rival: "", review: "" }
  const seat = () => ({ teamID: ids.team, areaID: ids.area })

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    if (page) await off(page, depot().home)
    await context?.close()
  })

  test("팀 모드 켜기 on depot: one area with its owner; three more conversations in the area's folder", async () => {
    await open(page, depot().seed)
    await page.getByTestId("session-menu").first().click()
    await page.getByTestId("session-menu-team-enable").click()
    await enableTeam(page)
    ids.team = await teamOf(page, depot().home)
    await expect.poll(async () => ((await view(page)).team as { readonly main?: unknown } | null)?.main).toBeTruthy()
    ids.main = ((await view(page)).team as { readonly main: { readonly sessionID: string } }).main.sessionID
    await expect.poll(() => current(page), { timeout: 120_000 }).toBe(ids.main)
    await expect(area(page).getByTestId("area-status")).toHaveText("쉬는 중", { timeout: 120_000 })
    await settled(page)
    const made = await theArea(page)
    ids.area = made.id
    ids.first = made.owner.sessionID!
    expect(made.name).toBe(depot().area)
    ids.next = await create(page, NEXT, "deepseek", made.directory)
    ids.rival = await create(page, RIVAL, "02", made.directory)
    ids.review = await create(page, REVIEW, "01", made.directory)
    await open(page, ids.main)
    await expect(others(page)).toHaveText("이 영역의 다른 대화 3", { timeout: 60_000 })
    // The owner conversation has nothing to take.
    await open(page, ids.first)
    await page.getByTestId("session-menu").first().click()
    await expect(page.getByTestId("session-menu-export")).toBeVisible()
    await expect(page.getByTestId("session-menu-peer-seat")).toHaveCount(0)
    await page.keyboard.press("Escape")
  })

  test("이 대화를 담당으로 on a row: one sentence with the conversation and what it runs on, 취소 and 바꾸기", async () => {
    await open(page, ids.main)
    await rowMenu(page, ids.next)
    const item = page.getByTestId("row-menu").getByTestId("row-peer-seat")
    await expect(item).toHaveText("이 대화를 담당으로")
    await expect(item).not.toHaveAttribute("aria-disabled", "true")
    await words(page.getByTestId("row-menu"))
    await item.click()
    const confirm = page.getByTestId("area-seat")
    await expect(confirm.getByTestId("area-seat-line")).toHaveText(
      new RegExp(`^'${AREA}' 영역의 담당을 '${NEXT}' 대화\\(.+\\)로 바꿀까요\\?$`),
    )
    await expect(confirm.locator("p")).toHaveCount(1)
    await expect(confirm.getByRole("button")).toHaveText(["취소", "바꾸기"])
    await expect(confirm.locator("input, textarea, select")).toHaveCount(0)
    await expect(confirm.getByTestId("area-seat-do")).toBeEnabled()
    await words(confirm)
    await confirm.getByRole("button", { name: "취소" }).click()
    await expect(page.getByTestId("area-menu")).toHaveCount(0)
    expect((await theArea(page)).owner).toMatchObject({ sessionID: ids.first, previous: [] })
  })

  test("바꾸기 while the owner works: 지금 일이 끝나면 바꿔요, the other rows wait, then the toast with the way back", async () => {
    await open(page, ids.main)
    await send(page, `[dispatch stock [slow 40000] 오래 걸리는 재고 정리]`)
    await expect.poll(() => working(page), { timeout: 90_000 }).toContain(ids.first)
    await rowMenu(page, ids.next)
    await page.getByTestId("row-menu").getByTestId("row-peer-seat").click()
    await page.getByTestId("area-seat-do").click()
    await expect(page.getByTestId("area-menu")).toHaveCount(0)
    const toasts = page.getByTestId("toasts")
    await expect(toasts).toContainText("지금 일이 끝나면 바꿔요")
    await words(toasts)
    // Nothing is forced: the card says what the move waits for, and the seat is still the first conversation's.
    const card = page.getByTestId("team-card").filter({ has: page.getByTestId("team-card-wait") })
    await expect(card.getByTestId("team-card-wait-text")).toContainText("영역에서 대화가 일하는 중이라 기다려요", {
      timeout: 60_000,
    })
    await expect(card.getByTestId("team-card-wait")).toContainText("단계 1/6")
    await words(card)
    expect((await theArea(page)).owner.sessionID).toBe(ids.first)
    // Another conversation's item is dimmed with the reason while this move runs.
    await rowMenu(page, ids.review)
    const blocked = page.getByTestId("row-menu").getByTestId("row-peer-seat")
    await expect(blocked).toHaveAttribute("aria-disabled", "true")
    await expect(blocked.getByTestId("row-peer-seat-blocked")).toHaveText(BLOCKED)
    await words(page.getByTestId("row-menu"))
    // Forced: Playwright waits for an `aria-disabled` item to become enabled before it clicks.
    await blocked.click({ force: true })
    await expect(page.getByTestId("row-menu")).toBeVisible()
    await expect(page.getByTestId("area-seat")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("row-menu")).toBeHidden()

    const done = toasts.getByTestId("toast").filter({ hasText: `'${NEXT}' 대화가 이제 '${AREA}' 담당이에요` })
    await expect(done).toBeVisible({ timeout: 120_000 })
    await expect(toasts).not.toContainText("지금 일이 끝나면 바꿔요")
    await words(done)
    // The way back names the conversation that held the seat; it is a second move with that conversation.
    await done.getByRole("button", { name: `다시 ${FIRST}으로` }).click()
    const back = toasts.getByTestId("toast").filter({ hasText: `'${FIRST}' 대화가 이제 '${AREA}' 담당이에요` })
    await expect(back).toBeVisible({ timeout: 120_000 })
    await expect(back.getByRole("button", { name: `다시 ${NEXT}로` })).toBeVisible()
    await words(back)
    const owner = (await theArea(page)).owner
    expect(owner.sessionID).toBe(ids.first)
    expect(owner.previous.map((item) => [item.sessionID, item.why])).toEqual([[ids.next, "seat"]])
    await settled(page)
  })

  test("from the conversation's menu with 메인 멈춤 on: requests wait for the chosen conversation; the old seat's banner leads there and back", async () => {
    await rpc(page, "own.team", "area.pause", { ...seat(), on: true })
    await open(page, ids.next)
    // It gave the seat back a moment ago: it says so, and its menu offers the seat too.
    const left = page.locator('[data-testid="team-banner"][data-kind="seatLeft"]')
    await expect(left).toContainText("이 대화는 이제 담당이 아니에요")
    await page.getByTestId("session-menu").first().click()
    await page.getByTestId("session-menu-peer-seat").click()
    const confirm = page.getByTestId("area-seat")
    await expect(confirm.getByTestId("area-seat-line")).toContainText(`'${NEXT}' 대화`)
    await confirm.getByTestId("area-seat-do").click()
    const toasts = page.getByTestId("toasts")
    const done = toasts.getByTestId("toast").filter({ hasText: `'${NEXT}' 대화가 이제 '${AREA}' 담당이에요` })
    await expect(done).toBeVisible({ timeout: 120_000 })
    await words(done)
    // 메인 멈춤 was on before the move and stays: a second toast says so and offers the one click that turns it off;
    // so does the banner of the conversation that took the seat, before any request waits.
    const held = toasts.getByTestId("toast").filter({ hasText: `'${AREA}' 영역은 메인 멈춤이 켜져 있어요` })
    await expect(held).toContainText("끄기 전에는 메인의 요청이 새 담당에게 가지 않아요")
    await expect(held.getByRole("button", { name: "메인 멈춤 끄기" })).toBeVisible()
    await words(held)
    const quiet = page.locator('[data-testid="team-banner"][data-kind="paused"]')
    await expect(quiet).toContainText("메인 멈춤이 켜져 있어요. 끄기 전에는 메인의 요청이 이 대화에 오지 않아요")
    await expect(quiet.getByRole("button")).toHaveText(["메인 멈춤 끄기"])
    await words(quiet)
    await expect(left).toHaveCount(0)
    const moved = await theArea(page)
    expect(moved.owner.sessionID).toBe(ids.next)
    expect(moved.owner.previous.map((item) => [item.sessionID, item.why])).toEqual([[ids.first, "seat"]])
    expect(moved.paused).toBe("user")
    await settled(page)

    // The main's next request waits for the area and goes to the conversation that holds the seat now.
    await open(page, ids.main)
    await send(page, "[dispatch stock 재고 표를 정리해 줘]")
    await expect(area(page).getByTestId("area-status")).toHaveText("메인 멈춤 · 요청 1개 기다림", { timeout: 60_000 })
    await open(page, ids.next)
    const paused = page.locator('[data-testid="team-banner"][data-kind="paused"]')
    await expect(paused).toContainText("메인 멈춤 · 요청 1개 기다림")
    await paused.getByRole("button", { name: "메인 멈춤 끄기" }).click()
    await expect(paused).toHaveCount(0)
    await expect(page.getByTestId("dispatch-source")).toContainText("메인이 보냄", { timeout: 90_000 })
    await expect(page.getByTestId("transcript-body")).toContainText("재고 표를 정리해 줘")
    await expect.poll(() => working(page), { timeout: 120_000 }).not.toContain(ids.next)

    // The conversation the seat left: what happened, the way to the owner, and the seat again.
    await open(page, ids.first)
    await expect(left).toContainText("이 대화는 이제 담당이 아니에요")
    await expect(left.getByRole("button")).toHaveText(["담당 대화로 가기", "다시 담당으로"])
    await words(left)
    await left.getByTestId("team-banner-owner").click()
    await expect.poll(() => current(page)).toBe(ids.next)
    await open(page, ids.first)
    await left.getByTestId("team-banner-seat").click()
    await expect(confirm.getByTestId("area-seat-line")).toHaveText(
      new RegExp(`^'${AREA}' 영역의 담당을 '${FIRST}' 대화\\(.+\\)로 바꿀까요\\?$`),
    )
    await words(confirm)
    await confirm.getByTestId("area-seat-do").click()
    await expect(
      toasts.getByTestId("toast").filter({ hasText: `'${FIRST}' 대화가 이제 '${AREA}' 담당이에요` }),
    ).toBeVisible({ timeout: 120_000 })
    await expect(left).toHaveCount(0)
    expect((await theArea(page)).owner.sessionID).toBe(ids.first)
    await settled(page)
  })

  test("a conversation on the team company's other subscription is refused in plain words", async () => {
    await open(page, ids.main)
    await rowMenu(page, ids.rival)
    await page.getByTestId("row-menu").getByTestId("row-peer-seat").click()
    const confirm = page.getByTestId("area-seat")
    await expect(confirm.getByTestId("area-seat-line")).toContainText(`'${RIVAL}' 대화`)
    await confirm.getByTestId("area-seat-do").click()
    const refused = page.getByTestId("toasts").getByTestId("toast").filter({ hasText: "다른 구독 계정을 써요" })
    await expect(refused).toHaveText(
      /이 대화는 팀과 같은 회사의 다른 구독 계정을 써요\. 담당으로 두려면 그 대화의 계정을 바꾸세요/,
    )
    await expect(refused).toHaveAttribute("data-tone", "danger")
    await words(refused)
    await expect(page.getByTestId("toasts")).not.toContainText("지금 일이 끝나면 바꿔요")
    expect((await theArea(page)).owner.sessionID).toBe(ids.first)
    expect((await view(page)).op ?? null).toBeNull()
  })

  test("팀과 이야기하는 대화: the owner first, notes on a second line; 메모 바꾸기…; a peer takes the seat", async () => {
    await rpc(page, "own.team", "area.peer.add", { ...seat(), sessionID: ids.review, label: "리뷰어", role: ROLE })
    await open(page, ids.main)
    await area(page).click({ button: "right" })
    const menu = page.getByTestId("area-menu")
    const group = menu.getByTestId("area-menu-peers")
    await expect(group.locator("p").first()).toHaveText("팀과 이야기하는 대화")
    const talkers = group.locator('[data-testid="area-menu-owner"], [data-testid="area-menu-peer"]')
    await expect(talkers).toHaveCount(2)
    await expect(talkers.first()).toHaveAttribute("data-testid", "area-menu-owner")
    await expect(group.getByTestId("area-menu-owner-open")).toHaveText(`${FIRST}담당`)
    await expect(group.getByTestId("area-menu-owner-note")).toHaveCount(0)
    await expect(group.getByTestId("area-menu-peer-open")).toHaveText(`리뷰어동료${ROLE}`)
    await under(group.getByTestId("area-menu-peer-open"), group.getByTestId("area-menu-peer-note"))
    await expect(group.getByTestId("area-menu-peer-seat")).toHaveText("이 대화를 담당으로")
    await words(menu)

    // SM-23 (2026-11-14): with no owner note yet, the peer's role would become the note; the confirm says so.
    await group.getByTestId("area-menu-peer-seat").click()
    const kept = menu.getByTestId("area-seat")
    await expect(kept.getByTestId("area-seat-peer")).toHaveText(
      "이 대화는 동료에서 빠지고, 동료 역할 글은 담당 메모로 옮겨져요. 담당을 다시 바꿔도 동료로 돌아오지 않으니, 그때는 동료로 다시 등록하세요",
    )
    await words(kept)
    await kept.getByRole("button", { name: "취소" }).click()
    await expect(kept).toHaveCount(0)
    if ((await menu.count()) === 0) await area(page).click({ button: "right" })

    await group.getByTestId("area-menu-owner-note-edit").click()
    const form = menu.getByTestId("area-owner-note")
    await expect(form.locator("p").first()).toHaveText(`'${AREA}' 담당 메모 바꾸기`)
    await expect(form.getByTestId("area-owner-note-text")).toHaveValue("")
    await form.getByTestId("area-owner-note-text").fill(NOTE)
    await expect(form.getByTestId("area-owner-note-left")).toContainText(String(1024 - NOTE.length))
    await words(form)
    await form.getByTestId("area-owner-note-save").click()
    await expect(page.getByTestId("toasts")).toContainText(`'${AREA}' 담당 메모를 바꿨어요`)
    await expect.poll(async () => (await theArea(page)).owner.note).toBe(NOTE)

    if ((await menu.count()) === 0) await area(page).click({ button: "right" })
    await expect(group.getByTestId("area-menu-owner-note")).toHaveText(NOTE)
    await under(group.getByTestId("area-menu-owner-open"), group.getByTestId("area-menu-owner-note"))
    await group.getByTestId("area-menu-peer-seat").click()
    const confirm = menu.getByTestId("area-seat")
    await expect(confirm.getByTestId("area-seat-line")).toHaveText(
      new RegExp(`^'${AREA}' 영역의 담당을 '${REVIEW}' 대화\\(.+\\)로 바꿀까요\\?$`),
    )
    // A peer is told what the move costs it; any other conversation reads the one sentence only.
    await expect(confirm.getByTestId("area-seat-peer")).toHaveText(
      "이 대화는 동료에서 빠지고 동료 역할 글도 지워져요. 담당을 다시 바꿔도 동료로 돌아오지 않으니, 그때는 동료로 다시 등록하세요",
    )
    await words(confirm)
    await confirm.getByTestId("area-seat-do").click()
    await expect(
      page
        .getByTestId("toasts")
        .getByTestId("toast")
        .filter({ hasText: `'${REVIEW}' 대화가 이제 '${AREA}' 담당이에요` }),
    ).toBeVisible({ timeout: 120_000 })
    await settled(page)
    const promoted = await theArea(page)
    expect(promoted.owner.sessionID).toBe(ids.review)
    expect((promoted.peers ?? []).map((item) => item.sessionID)).toEqual([])
    await area(page).click({ button: "right" })
    await expect(talkers).toHaveCount(1)
    await expect(group.getByTestId("area-menu-owner-open")).toContainText(REVIEW)
    await words(menu)
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
  })

  test("a conversation the seat was moved off is offered 동료로 등록… again, and own.team takes it", async () => {
    // `새 설계` held the seat and gave it back; it is no peer and no owner now.
    await open(page, ids.next)
    await page.getByTestId("session-menu").first().click()
    await expect(page.getByTestId("session-menu-peer-register")).toHaveText("동료로 등록…")
    await expect(page.getByTestId("session-menu-peer-seat")).toHaveText("이 대화를 담당으로")
    await page.keyboard.press("Escape")
    await rpc(page, "own.team", "area.peer.add", { ...seat(), sessionID: ids.next, label: "설계", role: ROLE })
    const added = await theArea(page)
    const peer = (added.peers ?? []).find((item) => item.sessionID === ids.next)
    expect(peer?.label).toBe("설계")
    expect(added.owner.previous.map((item) => item.sessionID)).not.toContain(ids.next)
    // A peer like any other: its own items, and out again.
    await open(page, ids.next)
    await page.getByTestId("session-menu").first().click()
    await expect(page.getByTestId("session-menu-peer-edit")).toBeVisible()
    await expect(page.getByTestId("session-menu-peer-register")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await rpc(page, "own.team", "area.peer.remove", { ...seat(), key: peer!.key })
    expect((await theArea(page)).peers ?? []).toEqual([])
  })

  test("375 px: the banner, the confirm and the toast fit; a paired phone reads the list and the banner without the seat buttons", async ({
    browser,
  }) => {
    await rpc(page, "own.team", "area.edit", { ...seat(), note: NOTE })
    await rpc(page, "own.team", "area.peer.add", { ...seat(), create: { label: "테스터", role: ROLE } })
    await page.setViewportSize({ width: 375, height: 812 })
    try {
      await open(page, ids.first)
      const banner = page.locator('[data-testid="team-banner"][data-kind="seatLeft"]')
      await expect(banner.getByRole("button")).toHaveText(["담당 대화로 가기", "다시 담당으로"])
      await fits(banner)
      await banner.getByTestId("team-banner-seat").click()
      const confirm = page.getByTestId("area-seat")
      await expect(confirm.getByTestId("area-seat-line")).toContainText(`'${FIRST}' 대화`)
      await fits(page.getByTestId("area-menu"))
      await fits(confirm.getByTestId("area-seat-do"))
      await noSideScroll(page)
      await confirm.getByRole("button", { name: "취소" }).click()
      await expect(page.getByTestId("area-menu")).toHaveCount(0)

      // The toast: a long title wraps in its sentence, and the way back (the title cut to twelve characters) stays
      // narrower than the sentence beside it. There with the long title, then back so the seat is where it was.
      const long = await create(page, LONG, "deepseek", (await theArea(page)).directory)
      await open(page, long)
      await page.getByTestId("session-menu").first().click()
      await page.getByTestId("session-menu-peer-seat").click()
      await confirm.getByTestId("area-seat-do").click()
      const toasts = page.getByTestId("toasts")
      const there = toasts.getByTestId("toast").filter({ hasText: `'${LONG}' 대화가 이제 '${AREA}' 담당이에요` })
      await expect(there).toBeVisible({ timeout: 120_000 })
      await fits(there)
      await there.getByRole("button", { name: `다시 ${REVIEW}로` }).click()
      const back = toasts.getByTestId("toast").filter({ hasText: `'${REVIEW}' 대화가 이제 '${AREA}' 담당이에요` })
      await expect(back).toBeVisible({ timeout: 120_000 })
      const way = back.getByRole("button", { name: /^다시 / })
      await expect(way).toHaveText(`다시 ${LONG.slice(0, 12).trimEnd()}…로`)
      await fits(back)
      const sentence = (await back.locator("span").first().boundingBox())!
      const button = (await way.boundingBox())!
      expect(sentence.width).toBeGreaterThan(button.width)
      await words(back)
      await noSideScroll(page)
      expect((await theArea(page)).owner.sessionID).toBe(ids.review)
      await settled(page)
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    await phone(browser, async (device) => {
      // On a phone the list is its own screen (03 §4.2).
      await device.goto("/")
      await expect(device.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
      await area(device).click({ button: "right" })
      const menu = device.getByTestId("area-menu")
      const group = menu.getByTestId("area-menu-peers")
      await expect(group.locator("p").first()).toHaveText("팀과 이야기하는 대화")
      const talkers = group.locator('[data-testid="area-menu-owner"], [data-testid="area-menu-peer"]')
      await expect(talkers).toHaveCount(2)
      await expect(talkers.first()).toHaveAttribute("data-testid", "area-menu-owner")
      await expect(group.getByTestId("area-menu-owner-note")).toHaveText(NOTE)
      await expect(group.getByTestId("area-menu-peer-note")).toHaveText(ROLE)
      await under(group.getByTestId("area-menu-owner-open"), group.getByTestId("area-menu-owner-note"))
      await under(group.getByTestId("area-menu-peer-open"), group.getByTestId("area-menu-peer-note"))
      // A gateway device changes nothing here (06 §9.8).
      await expect(group.getByTestId("area-menu-owner-note-edit")).toHaveCount(0)
      await expect(group.getByTestId("area-menu-peer-seat")).toHaveCount(0)
      await fits(menu)
      await words(menu.getByRole("menu"))
      await device.keyboard.press("Escape")
      await noSideScroll(device)

      await open(device, ids.first)
      const banner = device.locator('[data-testid="team-banner"][data-kind="seatLeft"]')
      await expect(banner).toContainText("이 대화는 이제 담당이 아니에요")
      await expect(banner.getByRole("button")).toHaveText(["담당 대화로 가기"])
      await device.getByTestId("session-menu").first().click()
      await expect(device.getByTestId("session-menu-export")).toBeVisible()
      await expect(device.getByTestId("session-menu-peer-seat")).toHaveCount(0)
      await device.keyboard.press("Escape")
      await fits(banner)
      await words(banner)
      await noSideScroll(device)
    })
  })

  test("팀 모드 끄기; no page error", async () => {
    await off(page, depot().home)
    expect(await teamsOn(page, depot().home)).toEqual([])
    expect(errors).toEqual([])
  })
})

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

function area(page: Page) {
  return page.getByTestId("area-row").filter({
    has: page.getByTestId("area-label").filter({ hasText: new RegExp(`^${AREA} · `) }),
  })
}

/** `이 영역의 다른 대화 n`, folded by default. */
function others(page: Page) {
  return page.getByTestId("team-others-row").filter({ hasText: "이 영역의 다른 대화" })
}

/** Opens the `⋯` menu of a conversation's row under 이 영역의 다른 대화, unfolding the group first. */
async function rowMenu(page: Page, sessionID: string) {
  await expect(others(page)).toBeVisible({ timeout: 60_000 })
  if ((await others(page).getAttribute("aria-expanded")) !== "true") await others(page).click()
  const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionID}"]`)
  await row.hover()
  await row.locator("xpath=..").getByTestId("row-menu-button").click()
  await expect(page.getByTestId("row-menu")).toBeVisible()
}

/** A root conversation of the user's in `directory`, on one of the backend's models. */
async function create(page: Page, title: string, model: string, directory: string) {
  const created = await page.request.post("/api/session", {
    data: { title, model: state().models[model], location: { directory } },
  })
  expect(created.ok()).toBe(true)
  return ((await created.json()) as { readonly data: { readonly id: string } }).data.id
}

/** The conversations that run now. */
async function working(page: Page) {
  const body = (await (await page.request.get("/api/session/active")).json()) as { readonly data?: object }
  return Object.keys(body.data ?? {})
}

/** Types into the real composer and sends; waits until the service took the message and the composer is idle. */
async function send(page: Page, text: string) {
  const box = page.locator("#own-composer-input")
  await box.click()
  await box.fill(text)
  // The composer is empty and idle before the service has the message: wait for the prompt's answer.
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
  return rpc(page, "own.team", "team.get", { directory: depot().home })
}

/** The project's one area. */
async function theArea(page: Page) {
  const found = ((await view(page)).areas as ReadonlyArray<AreaInfo>).find((item) => item.name === AREA)
  if (!found) throw new Error(`no area ${AREA}`)
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

/** `note` is a line of its own inside `row`, under the name. */
async function under(row: Locator, note: Locator) {
  const name = (await row.locator("span").first().boundingBox())!
  const line = (await note.boundingBox())!
  const whole = (await row.boundingBox())!
  expect(line.y).toBeGreaterThanOrEqual(name.y + name.height - 1)
  expect(line.x + line.width).toBeLessThanOrEqual(whole.x + whole.width + 1)
}

/** Inside a 375 px window. */
async function fits(locator: Locator) {
  const box = (await locator.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
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
