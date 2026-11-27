// 다른 도구의 대화, I2 이어서 하기 (09 §0 4–7, §4.5, §6 대화상자·진행·결과·숨김·들어가는 곳 4; §7.4 IG8, IG9, IG10) in
// the whole own-web app in Edge against backend.ts: the real server with own-accounts and own-import, every model call
// answered by a local fake, and the `이어가기` project's synthetic conversations (see backend.ts). One window walks, in
// this order:
//   - entry 4: the folder's empty new conversation hints the conversations not imported yet, once; `보기` opens them;
//   - the dialog's start (IG9): a Codex conversation starts on ChatGPT 01, the folder's last account, tagged `원래와
//     같은 회사`, with `원래: <모델>` and the window ratio; `추천` is a badge on ChatGPT 02 (the most usage left) and
//     never chosen for the user; every pick (ChatGPT 02, DeepSeek) plans again and stays picked; DeepSeek shows `다른
//     회사` and its send notice (IG10);
//   - a fitting conversation moves `그대로` up to `여기까지` with `원래 대화 전체도 이 앱에 저장` checked, no model request
//     reaching a fake, and opens with the header badge (its details) and the first-screen line; asked again it offers
//     `열기` / `새로 가져오기`, and `열기` opens that conversation;
//   - past a Codex remote compaction, in GPT-5.6 Cyber's window, `그대로` is the default (`전체 기록 요약` only a
//     choice): it fills across the boundary and puts the rest in a checkpoint, with no model request;
//   - a conversation that does not fit GPT-5.6 Cyber: `요약해서 이어가기` is recommended and the LLM summary runs
//     `원본 읽는 중` → `요약 중` → `대화 만드는 중` with one request, on ChatGPT 01; meanwhile a second window (IG8)
//     never shows the hidden helper in its sidebar, nor in its search (the server's search answers it), nor notifies
//     its end, while it does notify an ordinary turn end it does not look at;
//   - closing the dialog during `요약 중` leaves a toast; after a reload the reopened dialog restores the job from
//     `jobs.list`, and `취소` there leaves no session and no helper;
//   - `LLM 없이` imports the large conversation with no model request;
//   - a Claude Code conversation starts on the Claude subscription, `원래와 같은 회사`;
//   - IG1: the stores' listing (size and mtime of every file and folder) is the same as before the spec.
// The spec imports the `이어가기` conversations, so it needs a backend where they were not imported yet (with
// OWN_WEB_IMPORT_E2E_REUSE=1, a backend started anew). The main e2e/playwright.config.ts ignores this folder; without
// this suite's backend it skips.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"

/** What backend.ts wrote (the fields this spec reads). */
interface ResumeState {
  readonly inspect: string
  readonly roots: { readonly base: string }
  readonly projects: { readonly resume: { readonly id: string; readonly name: string } }
  /** `이어가기 둘러보기` (ChatGPT 02) and `이어가기 작업` (ChatGPT 01, the folder's last). */
  readonly sessions: { readonly browse: string; readonly resume: string }
  readonly resume: {
    readonly titles: { readonly small: string; readonly big: string; readonly remote: string; readonly claude: string }
    readonly turns: { readonly small: number; readonly big: number; readonly remote: number }
    readonly helperTitle: string
    readonly accounts: {
      readonly "01": { readonly id: string; readonly label: string }
      readonly "02": { readonly id: string; readonly label: string }
      /** Runs no turn: only the backend's usage poll reads its windows, about a minute after boot. */
      readonly "03": { readonly id: string; readonly label: string }
      readonly deepseek: { readonly id: string; readonly label: string }
      readonly claude: { readonly id: string }
    }
    readonly small: { readonly id: string; readonly name: string }
    readonly identity: string
  }
}

/** A model request a fake received (backend.ts `GET /requests`). */
interface ModelRequest {
  readonly identity: string | null
  readonly model: string | null
  readonly compaction: boolean
}
type Fake = "codex" | "deepseek" | "anthropic"
type Requests = { readonly [F in Fake]: ReadonlyArray<ModelRequest> }

/** The root sessions own.import made and its jobs (backend.ts `GET /sessions`). */
interface Sessions {
  readonly imported: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly sourceID: string
    readonly mode: string
    readonly checkpoint: string | null
    readonly turns: number
    readonly storedFull: boolean
  }>
  readonly helpers: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly jobs: { readonly jobs: ReadonlyArray<{ readonly jobID: string; readonly step: string }> }
}

/** Every file and folder below a root, links not followed: relative path, size, mtime, folder (IG1). */
type Listing = ReadonlyArray<readonly [string, number, number, boolean]>

declare global {
  interface Window {
    /** What the init scripts record (see {@link record} and {@link stubNotifications}). */
    __ownImportE2e?: {
      /** `data-step` of the dialog's progress, each change once. */
      readonly steps: string[]
      /** Every `data-session-id` (sidebar rows, search results) the page showed. */
      readonly sessions: string[]
      /** Every sidebar session title the page showed. */
      readonly titles: string[]
      /** The OS notifications the page asked for (their titles). */
      readonly notified: string[]
    }
  }
}

const TMP = process.env.OWN_WEB_IMPORT_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as ResumeState
/**
 * The first `새 N개` and the list's first open when this spec runs first (alone, or after import.spec stopped early):
 * own.import's Worker starts and indexes the stores, and Vite dev transforms the list's lazy chunk (import.spec.ts
 * `FIRST_COUNT`, `FIRST_LIST`).
 */
const FIRST_COUNT = 90_000
const FIRST_LIST = 60_000
/** The tests that run a summary helper's job. */
const LONG = 240_000

test.describe.configure({ mode: "serial" })

test.describe("다른 도구의 대화: 이어서 하기 (09 §4, §6, I2)", () => {
  test.skip(!TMP, "needs e2e/import/backend.ts: bun run test:e2e:import")

  const errors: string[] = []
  let before: Listing = []
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    if (!TMP) return
    before = listing(state().roots.base)
    context = await windowOf(browser, errors)
    page = await context.newPage()
  })

  test.afterAll(async () => {
    await inspect("POST", "/summary?delay=0").catch(() => undefined)
    await context?.close()
  })

  test.afterEach(() => {
    expect(errors.splice(0)).toEqual([])
  })

  test("entry 4: the folder's new conversation hints the conversations not imported yet, once; 보기 opens them", async () => {
    const s = state()
    const project = s.projects.resume.id
    await page.goto(`/srv/local/p/${project}`)
    await ready(page)
    await expect(entry(page, project)).toContainText("다른 도구의 대화 · 새 4개", { timeout: FIRST_COUNT })
    const hint = page.getByTestId("import-hint")
    await expect(hint).toContainText("이 폴더에 아직 가져오지 않은 Codex·Claude Code 대화 4개가 있어요")
    await hint.getByTestId("import-hint-open").click()
    await expect(page).toHaveURL(new RegExp(`/srv/local/p/${project}/import$`))
    await expect(page.getByTestId("import-total")).toHaveText("4개", { timeout: FIRST_LIST })
    // Once per folder and viewer: the next visit has none.
    await page.goto(`/srv/local/p/${project}`)
    await ready(page)
    await expect(entry(page, project)).toContainText("새 4개")
    await expect(hint).toHaveCount(0)
  })

  test("the start follows the tool's company; 추천 is a badge; every pick stays; DeepSeek is 다른 회사", async () => {
    const s = state()
    const accounts = s.resume.accounts
    const from = await requests()
    // 추천 holds whenever the usage poll read ChatGPT 03 (it runs no turn of its own): the dialog opens after it did,
    // on a fresh page (the fifth limits review: 03 at the fake's default 0 % took the badge about 50 s after boot).
    await expect
      .poll(async () => (await inspect("GET", "/usage-polls")) as string[], { timeout: 150_000 })
      .toContain(accounts["03"].id)
    await openDialog(page, s.projects.resume.id, s.resume.titles.small)
    const dialog = page.getByTestId("import-migrate")
    await expect(dialog.getByRole("heading", { name: "Codex 대화 이어서 하기" })).toBeVisible()
    await settled(page)
    // 09 §4.5: an account of Codex's company, the one this folder used last, never the one with the most headroom.
    await expect(account(page)).toHaveValue(accounts["01"].id)
    await expect(page.getByTestId("import-migrate-same-company")).toHaveText("원래와 같은 회사")
    await expect(page.getByTestId("import-migrate-original")).toContainText("원래: gpt-5.5")
    await expect(page.getByTestId("import-migrate-ratio")).toHaveText(/^이 모델 창의 \d+%$/)
    await expect(page.getByTestId("import-migrate-title")).toContainText(
      `${s.resume.titles.small}·${s.resume.turns.small}턴·`,
    )
    // 추천 is a badge only (IG9): on ChatGPT 02's option, while ChatGPT 01 stays chosen.
    await expect(account(page).locator(`option[value="${accounts["02"].id}"]`)).toHaveText(
      `${accounts["02"].label} · 추천`,
    )
    await expect(account(page).locator(`option[value="${accounts["01"].id}"]`)).toHaveText(accounts["01"].label)
    await expect(account(page).locator(`option[value="${accounts["03"].id}"]`)).toHaveText(accounts["03"].label)
    await expect(page.getByTestId("import-migrate-recommended")).toHaveCount(0)
    await expect(page.getByTestId("import-migrate-headroom")).toHaveCount(0)
    // It fits: 그대로 is the default, a summary is not needed, and the send notice names the first message (IG10).
    await expect(page.getByTestId("import-migrate-mode-full").locator("input")).toBeChecked()
    await expect(page.getByTestId("import-migrate-mode-summary-reason")).toHaveText("창에 들어가서 필요 없음")
    const send = page.getByTestId("import-migrate-send")
    await expect(send).toHaveAttribute("data-kind", "first")
    await expect(send).toContainText(
      new RegExp(`^첫 메시지와 함께 약 \\S+ 토큰이 ${accounts["01"].label}\\(ChatGPT\\)로 전송돼요$`),
    )
    await expect(page.getByTestId("import-migrate-cross-company")).toHaveCount(0)
    await expect(run(page)).toHaveText("가져오기")
    await expect(run(page)).toBeEnabled()

    // The user's pick: ChatGPT 02 carries its 추천 badge, and the plan keeps the pick.
    await account(page).selectOption(accounts["02"].id)
    await settled(page)
    await expect(account(page)).toHaveValue(accounts["02"].id)
    await expect(page.getByTestId("import-migrate-recommended")).toHaveText("추천")
    await expect(send).toContainText(`${accounts["02"].label}(ChatGPT)`)

    // DeepSeek: another company than Codex's, on every mode (09 §4.5, IG10).
    await account(page).selectOption(accounts.deepseek.id)
    await settled(page)
    await expect(account(page)).toHaveValue(accounts.deepseek.id)
    await expect(page.getByTestId("import-migrate-same-company")).toHaveCount(0)
    await expect(page.getByTestId("import-migrate-recommended")).toHaveCount(0)
    await expect(send).toHaveAttribute("data-kind", "first")
    await expect(send).toContainText(new RegExp(`^첫 메시지와 함께 약 \\S+ 토큰이 ${accounts.deepseek.label}`))
    await expect(page.getByTestId("import-migrate-cross-company")).toHaveText("다른 회사")
    await expect(page.getByTestId("import-migrate-original")).toContainText("원래: gpt-5.5")

    await page.getByTestId("import-migrate-cancel").click()
    await expect(dialog).toHaveCount(0)
    expect(since(from, await requests())).toEqual(NONE)
  })

  test("그대로 up to 여기까지, stored in full by default: no model request; the badge and first-screen line", async () => {
    const s = state()
    const from = await requests()
    await openDialog(page, s.projects.resume.id, s.resume.titles.small)
    await settled(page)
    const details = page.getByTestId("import-migrate-details")
    await expect(details.locator("summary")).toHaveText(
      `자세히: 여기까지(턴 ${s.resume.turns.small}), 원래 대화 전체도 이 앱에 저장 ☑, 비밀 가리기(0개)`,
    )
    await details.locator("summary").click()
    // Q3 (09 §8.2): the whole conversation is stored by default.
    await expect(page.getByTestId("import-migrate-store-full")).toBeChecked()
    const upTo = page.getByTestId("import-migrate-upto")
    await expect(upTo).toHaveValue(String(s.resume.turns.small))
    await upTo.fill("1")
    await upTo.press("Tab")
    await settled(page)
    await expect(page.getByTestId("import-migrate-title")).toContainText(`${s.resume.titles.small}·1턴·`)
    await expect(details.locator("summary")).toContainText("여기까지(턴 1)")
    await expect(page.getByTestId("import-migrate-mode-full").locator("input")).toBeChecked()
    await expect(run(page)).toHaveText("가져오기")
    await run(page).click()

    const sessionID = await openedSession(page)
    await expect(page.getByTestId("import-badge")).toHaveText("Codex에서 가져옴")
    await expect(page.getByTestId("import-first-line")).toHaveText("Codex 대화 1턴을 가져왔어요 · 그대로 이어가요")
    await expect(page.locator("#own-composer-input")).toBeFocused()
    // The imported turn is there from the first view, and the conversation is no longer new (09 §6 entry 1).
    await expect(page.getByText("테스트가 통과했습니다.", { exact: true })).toBeVisible()
    await expect(page.getByText("커밋할 것이 없습니다.", { exact: true })).toHaveCount(0)
    await expect(entry(page, s.projects.resume.id)).toContainText("새 3개")
    expect(since(from, await requests())).toEqual(NONE)
    expect((await sessions()).imported.find((item) => item.id === sessionID)).toMatchObject({
      title: s.resume.titles.small,
      mode: "full",
      checkpoint: null,
      turns: 1,
      storedFull: true,
    })

    // The badge's details (09 §4.7).
    await page.getByTestId("import-badge").click()
    const origin = page.getByTestId("import-origin")
    await expect(origin.getByRole("heading", { name: "Codex에서 가져온 대화" })).toBeVisible()
    await expect(detail(page, "원본")).toHaveText(`Codex · ${s.resume.titles.small}`)
    await expect(detail(page, "가져온 턴")).toHaveText("1")
    await expect(detail(page, "방식")).toHaveText("그대로 이어가기")
    await expect(detail(page, "이어 가는 자리")).toHaveText("처음부터 그대로")
    await expect(origin.getByTestId("import-origin-view")).toHaveText("원본 보기")
    await origin.getByTestId("dialog-close").click()
    await expect(origin).toHaveCount(0)
  })

  test("an imported conversation asks 열기 / 새로 가져오기 first; 열기 opens it", async () => {
    const s = state()
    const project = s.projects.resume.id
    await openList(page, project)
    await expect(row(page, s.resume.titles.small).getByTestId("import-tag-imported")).toHaveText("가져옴")
    // Imported conversations are not counted as new.
    await expect(entry(page, project)).toContainText("새 3개")
    await openDialog(page, project, s.resume.titles.small)
    const existing = page.getByTestId("import-migrate-existing")
    await expect(existing).toContainText("이미 가져왔어요(그대로 이어가기)")
    await expect(page.getByTestId("import-migrate-again")).toHaveText("새로 가져오기")
    await expect(run(page)).toHaveCount(0)
    const small = (await sessions()).imported.filter((item) => item.title === s.resume.titles.small)
    expect(small).toHaveLength(1)
    await page.getByTestId("import-migrate-open-existing").click()
    await expect(page).toHaveURL(new RegExp(`/srv/local/s/${small[0]?.id}$`))
    await expect(page.getByTestId("import-migrate")).toHaveCount(0)
  })

  test("past a Codex remote compaction 그대로 is the default and fills across it, with no model request", async () => {
    const s = state()
    const from = await requests()
    await openDialog(page, s.projects.resume.id, s.resume.titles.remote)
    await settled(page)
    // In GPT-5.6 Cyber's window only the newest turns fit: the rest goes into a checkpoint (09 §4.1, §4.3).
    await model(page).selectOption(s.resume.small.id)
    await settled(page)
    await expect(model(page)).toHaveValue(s.resume.small.id)
    await expect(page.getByTestId("import-migrate-title")).toContainText(`${s.resume.turns.remote}턴·약 `)
    await expect(page.getByTestId("import-migrate-title")).toContainText("Codex 압축 1번(읽을 수 없음)")
    await expect(page.getByTestId("import-migrate-mode-full").locator("input")).toBeChecked()
    await expect(page.getByTestId("import-migrate-send")).toHaveAttribute("data-kind", "first")
    // A summary of the whole history is a choice the user can make, never the default (09 §4.3).
    await page.getByTestId("import-migrate-mode-summary").click()
    await settled(page)
    await expect(page.getByTestId("import-migrate-source-llm")).toContainText("전체 기록 요약")
    await expect(run(page)).toHaveText("요약하고 가져오기")
    await page.getByTestId("import-migrate-mode-full").click()
    await settled(page)
    await expect(page.getByTestId("import-migrate-mode-full").locator("input")).toBeChecked()
    await expect(run(page)).toHaveText("가져오기")
    await run(page).click()

    const sessionID = await openedSession(page)
    await expect(page.getByTestId("import-badge")).toHaveText("Codex에서 가져옴")
    await expect(page.getByTestId("import-first-line")).toHaveText(
      `Codex 대화 ${s.resume.turns.remote}턴을 가져왔어요 · 그대로 이어가요`,
    )
    expect(since(from, await requests())).toEqual(NONE)
    expect((await sessions()).imported.find((item) => item.id === sessionID)).toMatchObject({
      mode: "full",
      checkpoint: "codex-remote",
      turns: s.resume.turns.remote,
    })
    await page.getByTestId("import-badge").click()
    await expect(detail(page, "이어 가는 자리")).toHaveText("Codex 원격 압축 대신 뽑은 사실과 요청 목록에서")
    await page.getByTestId("import-origin").getByTestId("dialog-close").click()
  })

  test("요약해서 이어가기: the LLM summary runs its three steps; the helper never shows (IG8)", async () => {
    test.setTimeout(LONG)
    const s = state()
    const accounts = s.resume.accounts
    // A second window that looks elsewhere: it records what its sidebar shows and every OS notification it asks for.
    const observer = await context.newPage()
    await observer.addInitScript(stubNotifications)
    await observer.goto(`/srv/local/s/${s.sessions.browse}`)
    await ready(observer)
    await expect(observer.getByTestId("session-row").filter({ hasText: "이어가기 작업" })).toBeVisible()
    // An ordinary turn end it does not look at is notified: the check below can see a notification.
    await inspect("POST", "/turn")
    await expect.poll(() => recorded(observer, "notified")).toContain("이어가기 작업 — 응답 완료")

    await openDialog(page, s.projects.resume.id, s.resume.titles.big)
    await settled(page)
    await expect(page.getByTestId("import-migrate-mode-full").locator("input")).toBeChecked()
    // GPT-5.6 Cyber's window is too small for it: the plan recommends a summary and keeps the pick (IG9).
    await model(page).selectOption(s.resume.small.id)
    await settled(page)
    await expect(account(page)).toHaveValue(accounts["01"].id)
    await expect(model(page)).toHaveValue(s.resume.small.id)
    const ratio = Number(/(\d+)%/.exec((await page.getByTestId("import-migrate-ratio").innerText()) ?? "")?.[1])
    expect(ratio).toBeGreaterThan(100)
    await expect(page.getByTestId("import-migrate-mode-full")).toHaveAttribute("data-off", "")
    await expect(page.getByTestId("import-migrate-mode-full-reason")).toHaveText("이 모델 창에 들어가지 않음")
    await expect(page.getByTestId("import-migrate-mode-summary").locator("input")).toBeChecked()
    await expect(page.getByTestId("import-migrate-source-llm")).toContainText("이어 갈 모델로 요약")
    await expect(page.getByTestId("import-migrate-source-llm").locator("input")).toBeChecked()
    await expect(page.getByTestId("import-migrate-source-brief")).toContainText("LLM 없이무료")
    const send = page.getByTestId("import-migrate-send")
    await expect(send).toHaveAttribute("data-kind", "now")
    await expect(send).toContainText(
      new RegExp(
        `^요약하려고 약 \\S+ 토큰이 지금 ${accounts["01"].label}\\(ChatGPT\\)로 전송되고, 첫 메시지와 함께 약 \\S+ 토큰이 ${accounts["01"].label}\\(ChatGPT\\)로 전송돼요$`,
      ),
    )
    await expect(run(page)).toHaveText("요약하고 가져오기")

    // The summary waits at the fake long enough to look at the other window meanwhile.
    await inspect("POST", "/summary?delay=15000")
    const from = await requests()
    await page.evaluate(() => window.__ownImportE2e?.steps.splice(0))
    await run(page).click()
    const progress = page.getByTestId("import-migrate-progress")
    await expect(progress).toHaveAttribute("data-step", "summarizing", { timeout: 60_000 })
    await expect(progress.locator('[aria-current="step"]')).toHaveText("요약 중")
    await expect
      .poll(async () => since(from, await requests()).codex.filter((request) => request.compaction).length, {
        timeout: 60_000,
      })
      .toBe(1)
    const helpers = (await sessions()).helpers
    expect(helpers.map((helper) => helper.title)).toEqual([s.resume.helperTitle])
    const helper = helpers[0]!.id

    // IG8: the sidebar of the other window lists the folder's conversations, never the helper; its search asks the
    // server, which answers the archived helper, and still shows none.
    await expect(observer.getByTestId("session-row").filter({ hasText: "이어가기 둘러보기" })).toBeVisible()
    const search = observer.getByTestId("sidebar-search")
    const answered = observer.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/api/session") &&
        new URL(response.url()).searchParams.get("search") === s.resume.helperTitle,
    )
    await search.fill(s.resume.helperTitle)
    expect(JSON.stringify(await (await answered).json())).toContain(helper)
    await expect(observer.getByTestId("sidebar-search-empty")).toHaveText(
      `"${s.resume.helperTitle}"와 일치하는 대화가 없어요`,
    )
    await search.fill("")

    // The summary arrives: the new conversation opens with the badge and its first-screen line.
    const sessionID = await openedSession(page, 90_000)
    await expect(page.getByTestId("import-badge")).toHaveText("Codex에서 가져옴")
    await expect(page.getByTestId("import-first-line")).toHaveText(
      `Codex 대화 ${s.resume.turns.big}턴을 가져왔어요 · 요약에서 이어가요`,
    )
    expect(await recorded(page, "steps")).toEqual(["reading", "summarizing", "importing"])
    // One request: the summary, on the target's account and model; nothing else reached a fake (07 R4).
    expect(since(from, await requests())).toEqual({
      codex: [{ identity: s.resume.identity, model: s.resume.small.id, compaction: true }],
      deepseek: [],
      anthropic: [],
    })
    const listed = await sessions()
    expect(listed.helpers).toEqual([])
    expect(listed.imported.find((item) => item.id === sessionID)).toMatchObject({
      mode: "summary",
      checkpoint: "llm",
      turns: s.resume.turns.big,
    })
    await page.getByTestId("import-badge").click()
    await expect(detail(page, "이어 가는 자리")).toHaveText("이 앱이 만든 요약에서")
    await expect(detail(page, "요약 모델")).toHaveText(s.resume.small.name)
    await page.getByTestId("import-origin").getByTestId("dialog-close").click()

    // Nothing of the helper ever reached the other window: no row, no title, no notification.
    expect(await recorded(observer, "sessions")).not.toContain(helper)
    expect(await recorded(observer, "titles")).not.toContain(s.resume.helperTitle)
    expect((await recorded(observer, "notified")).filter((title) => title.includes(s.resume.helperTitle))).toEqual([])
    await observer.close()
  })

  test("closing during 요약 중 leaves a toast; a reload restores the job; 취소 leaves no session", async () => {
    test.setTimeout(LONG)
    const s = state()
    const project = s.projects.resume.id
    const count = (await sessions()).imported.length
    // Long enough for the close, the reload and the reopened dialog; the cancel ends it first.
    await inspect("POST", "/summary?delay=120000")
    const from = await requests()
    await openDialog(page, project, s.resume.titles.big)
    await expect(page.getByTestId("import-migrate-existing")).toContainText("이미 가져왔어요(요약해서 이어가기)")
    await page.getByTestId("import-migrate-again").click()
    await settled(page)
    await model(page).selectOption(s.resume.small.id)
    await settled(page)
    await expect(run(page)).toHaveText("요약하고 가져오기")
    await run(page).click()
    await expect(page.getByTestId("import-migrate-progress")).toHaveAttribute("data-step", "summarizing", {
      timeout: 60_000,
    })
    await expect
      .poll(async () => since(from, await requests()).codex.filter((request) => request.compaction).length, {
        timeout: 60_000,
      })
      .toBe(1)

    // 닫기: the job goes on and a toast says so (09 §6 진행).
    await page.getByTestId("import-migrate-close").click()
    await expect(page.getByTestId("import-migrate")).toHaveCount(0)
    await expect(page.getByTestId("toast").filter({ hasText: s.resume.titles.big })).toContainText(
      `${s.resume.titles.big} 가져오는 중 · 요약 중`,
    )

    // A reload: the reopened dialog restores the running job from jobs.list.
    await page.reload()
    await ready(page)
    await openDialog(page, project, s.resume.titles.big)
    const progress = page.getByTestId("import-migrate-progress")
    await expect(progress).toHaveAttribute("data-step", "summarizing")
    await expect(progress.locator('[aria-current="step"]')).toHaveText("요약 중")
    await expect(page.getByTestId("import-migrate-close")).toBeVisible()

    // 취소 during 요약 중: the helper is stopped and removed, nothing is imported (09 §4.8).
    await page.getByTestId("import-migrate-job-cancel").click()
    await expect(page.getByTestId("import-migrate-note")).toHaveText(
      "가져오기를 취소했어요. 아무것도 만들지 않았어요.",
    )
    await expect(progress).toHaveCount(0)
    await expect
      .poll(async () => {
        const listed = await sessions()
        return { helpers: listed.helpers.length, jobs: listed.jobs.jobs.length, imported: listed.imported.length }
      })
      .toEqual({ helpers: 0, jobs: 0, imported: count })
    await page.getByTestId("import-migrate-cancel").click()
    await expect(page.getByTestId("import-migrate")).toHaveCount(0)
    await inspect("POST", "/summary?delay=0")
  })

  test("LLM 없이 imports the large conversation with no model request", async () => {
    const s = state()
    const from = await requests()
    await openDialog(page, s.projects.resume.id, s.resume.titles.big)
    await page.getByTestId("import-migrate-again").click()
    await settled(page)
    await model(page).selectOption(s.resume.small.id)
    await settled(page)
    await page.getByTestId("import-migrate-source-brief").click()
    await settled(page)
    await expect(page.getByTestId("import-migrate-source-brief").locator("input")).toBeChecked()
    await expect(model(page)).toHaveValue(s.resume.small.id)
    // No summary request: the notice names the first message only.
    const send = page.getByTestId("import-migrate-send")
    await expect(send).toHaveAttribute("data-kind", "first")
    await expect(send).toContainText(/^첫 메시지와 함께 약 \S+ 토큰이 /)
    await expect(run(page)).toHaveText("가져오기")
    await run(page).click()

    const sessionID = await openedSession(page)
    await expect(page.getByTestId("import-first-line")).toHaveText(
      `Codex 대화 ${s.resume.turns.big}턴을 가져왔어요 · 요약에서 이어가요`,
    )
    expect(since(from, await requests())).toEqual(NONE)
    expect((await sessions()).imported.find((item) => item.id === sessionID)).toMatchObject({
      mode: "summary",
      checkpoint: "brief",
    })
    await page.getByTestId("import-badge").click()
    await expect(detail(page, "이어 가는 자리")).toHaveText("LLM 없이 뽑은 사실과 요청 목록에서")
    await page.getByTestId("import-origin").getByTestId("dialog-close").click()
  })

  test("a Claude Code conversation starts on the Claude subscription, 원래와 같은 회사", async () => {
    const s = state()
    const from = await requests()
    await openDialog(page, s.projects.resume.id, s.resume.titles.claude)
    await expect(
      page.getByTestId("import-migrate").getByRole("heading", { name: "Claude Code 대화 이어서 하기" }),
    ).toBeVisible()
    await settled(page)
    await expect(account(page)).toHaveValue(s.resume.accounts.claude.id)
    await expect(page.getByTestId("import-migrate-same-company")).toHaveText("원래와 같은 회사")
    await expect(page.getByTestId("import-migrate-cross-company")).toHaveCount(0)
    await expect(page.getByTestId("import-migrate-send")).toContainText("(Claude)")
    await page.getByTestId("import-migrate-cancel").click()
    expect(since(from, await requests())).toEqual(NONE)
  })

  test("IG1: the stores are exactly as before the spec", () => {
    expect(listing(state().roots.base)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------------------------------------------

const NONE: Requests = { codex: [], deepseek: [], anthropic: [] }

/** A call to backend.ts's inspect server. */
async function inspect(method: "GET" | "POST", route: string) {
  const response = await fetch(new URL(route, state().inspect), { method })
  if (!response.ok) throw new Error(`inspect ${route}: ${response.status}`)
  return response.json() as Promise<unknown>
}

async function requests() {
  return (await inspect("GET", "/requests")) as Requests
}

/** The requests each fake received after `from`. */
function since(from: Requests, now: Requests): Requests {
  return {
    codex: now.codex.slice(from.codex.length),
    deepseek: now.deepseek.slice(from.deepseek.length),
    anthropic: now.anthropic.slice(from.anthropic.length),
  }
}

async function sessions() {
  return (await inspect("GET", "/sessions")) as Sessions
}

/**
 * A browser context of the spec: Korean, every page error kept in `errors` (and every failed own.accounts read: an
 * opened conversation's folder must be known to its composer), and on every page {@link record} (the dialog's steps,
 * the sidebar's rows). A read still running when a test's `goto` leaves the page fails with `Failed to fetch` as it
 * would for a user leaving it (an opened conversation reloads its preset on events, so no wait rules that out): from
 * the main frame's navigation request until the next document's DOMContentLoaded that one is not kept.
 */
async function windowOf(browser: Browser, errors: string[]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
  await context.addInitScript(record)
  context.on("page", (opened) => {
    let leaving = false
    opened.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === opened.mainFrame()) leaving = true
    })
    opened.on("domcontentloaded", () => (leaving = false))
    opened.on("pageerror", (error) => errors.push(error.message))
    opened.on("console", (message) => {
      const text = message.text()
      if (message.type() !== "error" || !text.includes("own.accounts request failed")) return
      if (leaving && text.includes("Failed to fetch")) return
      errors.push(text)
    })
  })
  return context
}

/** Records what a page shows into `window.__ownImportE2e` (runs in the page before its own scripts). */
function record() {
  const seen = {
    steps: new Array<string>(),
    sessions: new Array<string>(),
    titles: new Array<string>(),
    notified: new Array<string>(),
  }
  window.__ownImportE2e = seen
  const check = () => {
    const step = document.querySelector('[data-testid="import-migrate-progress"]')?.getAttribute("data-step")
    if (step && seen.steps.at(-1) !== step) seen.steps.push(step)
    document.querySelectorAll("[data-session-id]").forEach((element) => {
      const id = element.getAttribute("data-session-id")
      if (id && !seen.sessions.includes(id)) seen.sessions.push(id)
    })
    document.querySelectorAll('[data-testid="session-title"]').forEach((element) => {
      const title = element.textContent ?? ""
      if (!seen.titles.includes(title)) seen.titles.push(title)
    })
  }
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-step", "data-session-id"],
  })
}

/**
 * The observer window's OS notifications (03 §9): a stand-in for the HTML5 `Notification` that records each title, and
 * a window that never has the focus, so every turn end it does not show is notified.
 */
function stubNotifications() {
  class Recorded {
    static readonly permission = "granted"
    static requestPermission() {
      return Promise.resolve("granted")
    }
    onclick: (() => void) | null = null
    constructor(title: string) {
      window.__ownImportE2e?.notified.push(title)
    }
    close() {}
  }
  Object.defineProperty(window, "Notification", { value: Recorded, configurable: true, writable: true })
  Document.prototype.hasFocus = () => false
}

async function recorded(page: Page, key: "steps" | "sessions" | "titles" | "notified") {
  return page.evaluate((name) => [...(window.__ownImportE2e?.[name] ?? [])], key)
}

async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

/** Opens a project's list and waits until its scan is done. */
async function openList(page: Page, projectID: string) {
  await page.goto(`/srv/local/p/${projectID}/import`)
  await expect(page.getByTestId("import-total")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("import-scanning")).toHaveCount(0, { timeout: 60_000 })
}

/** The list row of the conversation titled `title` (titles are unique in the fixtures). */
function row(page: Page, title: string) {
  return page.getByTestId("import-row").filter({ has: page.locator(".own-import-row-title", { hasText: title }) })
}

/** The sidebar's `다른 도구의 대화 · 새 N개 ›` of a project. */
function entry(page: Page, projectID: string) {
  return page.locator(`[data-testid="import-entry"][href$="/p/${projectID}/import"]`)
}

/** The list's `이어서 하기` of a conversation: the dialog opens. */
async function openDialog(page: Page, projectID: string, title: string) {
  if (!new URL(page.url()).pathname.endsWith(`/p/${projectID}/import`)) await openList(page, projectID)
  await row(page, title).getByTestId("import-row-resume").click()
  await expect(page.getByTestId("import-migrate")).toBeVisible()
}

/** The dialog's plan matches its inputs: the mode rows are not busy and the window ratio shows. */
async function settled(page: Page) {
  await expect(page.getByTestId("import-migrate-modes")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 })
  await expect(page.getByTestId("import-migrate-ratio")).toBeVisible()
}

function account(page: Page) {
  return page.getByTestId("import-migrate-account")
}

function model(page: Page) {
  return page.getByTestId("import-migrate-model")
}

function run(page: Page) {
  return page.getByTestId("import-migrate-run")
}

/** The new conversation the dialog opened (its route), once the dialog is gone. */
async function openedSession(page: Page, timeout = 60_000) {
  await expect(page).toHaveURL(/\/srv\/local\/s\/[^/?#]+$/, { timeout })
  await expect(page.getByTestId("import-migrate")).toHaveCount(0)
  return decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "")
}

/** A value of the badge's details: the `<dd>` after the `<dt>` named `label`. */
function detail(page: Page, label: string): Locator {
  return page
    .getByTestId("import-origin-details")
    .locator("dt", { hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]")
}

function listing(root: string): Listing {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((name) => {
      const stat = fs.lstatSync(path.join(root, name))
      return [name, stat.size, stat.mtimeMs, stat.isDirectory()] as const
    })
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
