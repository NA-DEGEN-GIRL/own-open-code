// 다른 도구의 대화, I1 (09 §3, §6; §7.4 IG1, IG5, IG10) in the whole own-web app in Edge against backend.ts: the real
// server with own-accounts and own-import, whose only roots are synthetic Codex and Claude Code stores (see
// backend.ts). One window walks, in this order:
//   - the sidebar's `다른 도구의 대화 · 새 N개` once the session list was painted and the page is idle (no own.import
//     request before the paint, 03 §20.2 R8; the list and viewer modules only when opened, R5), and the row leaving
//     and coming back with 설정 > 다른 도구 > `사이드바에 보이기`;
//   - the entries: `다른 도구의 대화…` in the `⋯` menu of the non-Git project, the palette's `다른 도구의 대화 열기`;
//   - the list: first-request lines, the tags (`진행 중일 수 있음`, `폴더 없음`, `읽을 수 없음`, Q3's `N일 뒤 원본이
//     지워질 수 있음` and its tooltip), and the filters (kind, sub-agents folded under their parent, 보관됨, 자동 실행,
//     모든 폴더 grouped by folder);
//   - the viewer of the `.zst` Codex conversation: band and header, its outline `읽는 중` until complete, the Codex
//     remote compaction mid-turn with its encrypted note, Ctrl+F over tool output jumping to the turn; and of the
//     Claude Code one: its mid-turn compaction with the summary (harness wording gone) and `텍스트로 복사`;
//   - title search, and `내용까지` answering in parts (`일부만 찾음 · 계속 찾기`) with a hit opening its turn;
//   - 설정 > 다른 도구 `찾을 곳 더하기` with a third fixture root, whose conversation joins the list and the count;
//   - a 375 px window and a keyboard-only path (palette → list → search → viewer → Ctrl+F → back);
//   - PF5 (03 §20.4): the production build's initial JS holds no import screen (dist/ as it is, built when missing);
//   - IG10: no conversation text in the page's storage, OWN_HOME or `import-index.json`, no DB copy left, every
//     request to this PC's loopback; IG1: the stores' listing (size and mtime of every file and folder) is the same as
//     before the suite.
// With OWN_WEB_IMPORT_E2E_REUSE=1 the backend must not have opened the `.zst` conversation yet (the outline would be
// complete at once). The main e2e/playwright.config.ts ignores this folder; without this suite's backend it skips.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"

/** What backend.ts wrote (the fields the spec reads). */
interface ImportState {
  readonly ownHome: string
  /** `base` holds every store; `extra` is the root 설정 adds. */
  readonly roots: { readonly base: string; readonly extra: string }
  readonly folders: { readonly first: string; readonly missing: string }
  readonly projects: {
    readonly main: { readonly id: string; readonly name: string }
    readonly notGit: { readonly id: string; readonly name: string }
  }
  /** own conversations in the first and the second clone. */
  readonly sessions: { readonly first: string; readonly second: string }
  readonly titles: Readonly<
    Record<
      | "fix"
      | "zst"
      | "live"
      | "worktree"
      | "missing"
      | "long"
      | "child"
      | "archived"
      | "exec"
      | "extra"
      | "review"
      | "old"
      | "gone"
      | "memo",
      string
    >
  >
  readonly mark: string
  readonly expect: {
    readonly fresh: number
    readonly rows: number
    readonly codex: number
    readonly claude: number
    readonly notGitFresh: number
    readonly expiresIn: number
    readonly reviewDays: number
    readonly zstTurns: number
    readonly polarTurn: number
  }
}

/** Every file and folder below a root, links not followed: relative path, size, mtime, folder (IG1). */
type Listing = ReadonlyArray<readonly [string, number, number, boolean]>

const TMP = process.env.OWN_WEB_IMPORT_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as ImportState
const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
/** The import screens: lazy chunks (09 §6 문구, 03 §20.2 R5); only `import/index.tsx` and `import/store.ts` are first. */
const SCREENS = /src\/import\/(list|viewer|dialog|model|settings|strings)\.tsx?$/
/** The same modules as Vite dev serves them to the page. */
const SCREEN_MODULES = /\/src\/import\/(list|viewer|dialog|model|settings|strings)\.tsx?(\?|$)/
/**
 * The cold path behind the first `새 N개`: own.import's Worker starts and indexes the stores, and the sidebar then asks
 * one project after another. On this PC under load (2026-11-12, with another suite beside it) `health` took 3.7 s, the
 * first `sessions.list` 11.7 s and the third project's count came after the suite's 20 s.
 */
const FIRST_COUNT = 90_000
/** The list's first open: Vite dev transforms its lazy chunk then (as `openList`). */
const FIRST_LIST = 60_000

test.describe.configure({ mode: "serial" })

test.describe("다른 도구의 대화 (09 §6, I1)", () => {
  test.skip(!TMP, "needs e2e/import/backend.ts: bun run test:e2e:import")

  const seen: Seen = { errors: [], hosts: new Set(), modules: [] }
  let before: Listing = []
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    if (!TMP) return
    before = listing(state().roots.base)
    context = await windowOf(browser, seen, { width: 1440, height: 900 })
    page = await context.newPage()
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test.afterEach(() => {
    expect(seen.errors.splice(0)).toEqual([])
  })

  test("새 N개 once the list was painted and the page idle; the screens load only when opened", async () => {
    const s = state()
    await page.goto(`/srv/local/s/${s.sessions.first}`)
    await ready(page)
    const main = entry(page, s.projects.main.id)
    await expect(main).toContainText(`다른 도구의 대화 · 새 ${s.expect.fresh}개`, { timeout: FIRST_COUNT })
    await expect(main).toHaveAttribute("title", "이 폴더에서 Codex·Claude Code가 남긴, 아직 가져오지 않은 대화")
    await expect(entry(page, s.projects.notGit.id)).toContainText(`새 ${s.expect.notGitFresh}개`)
    // 03 §20.2 R8: own.import is asked only after the session list was painted (PF1 `own:sessions-visible`).
    const timing = await page.evaluate(() => ({
      painted: performance.getEntriesByName("own:sessions-visible", "mark")[0]?.startTime,
      asked: performance
        .getEntriesByType("resource")
        .filter((item) => item.name.includes("/api/rpc/own.import/"))
        .map((item) => item.startTime)
        .toSorted((a, b) => a - b)[0],
    }))
    expect(timing.painted).toBeDefined()
    expect(timing.asked).toBeGreaterThan(timing.painted ?? Number.POSITIVE_INFINITY)
    // R5: the sidebar row, the hint and the counts are first-chunk code; the list is fetched when it opens.
    expect(seen.modules.filter((url) => SCREEN_MODULES.test(url))).toEqual([])
    await main.click()
    await expect(page).toHaveURL(listPath(s.projects.main.id))
    await expect(page.getByTestId("page-import")).toBeVisible()
    await expect(page.getByTestId("import-total")).toHaveText(`${s.expect.rows}개`, { timeout: FIRST_LIST })
    expect(seen.modules.some((url) => /\/src\/import\/list\.tsx/.test(url))).toBe(true)
  })

  test("사이드바에 보이기: off hides the row (also after a reload), on brings it back", async () => {
    const s = state()
    await page.goto("/settings/import")
    await ready(page)
    const toggle = page.getByTestId("settings-import-sidebar")
    const main = entry(page, s.projects.main.id)
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await expect(main).toContainText(`새 ${s.expect.fresh}개`)
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await expect(page.getByTestId("import-entry")).toHaveCount(0)
    await page.reload()
    await ready(page)
    // own.import has answered (the project menus offer it), and still no row.
    await expect(projectRow(page, s.projects.main.name).getByTestId("project-menu")).toBeAttached()
    await expect(page.getByTestId("import-entry")).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await expect(main).toContainText(`새 ${s.expect.fresh}개`)
  })

  test("⋯ of the non-Git project offers 다른 도구의 대화… alone and opens its list", async () => {
    const s = state()
    await page.goto(`/srv/local/s/${s.sessions.first}`)
    await ready(page)
    const row = projectRow(page, s.projects.notGit.name)
    // Its place in the list is a lazy part of the sidebar.
    await expect(page.getByTestId("sidebar-announce")).toBeAttached()
    await row.hover()
    await row.getByTestId("project-menu").click()
    const item = page.getByTestId("project-menu-import")
    await expect(item).toHaveText("다른 도구의 대화…")
    // No Git, no team items (06 §9.2): besides the import item, only its place in the list
    // (03 §4.3), archiving and removing the project.
    await expect(page.getByRole("menuitem")).toHaveText([
      "다른 도구의 대화…",
      "고정",
      "위로 이동",
      "아래로 이동",
      "프로젝트 보관",
      "목록에서 빼고 대화 삭제…",
    ])
    await item.click()
    await expect(page).toHaveURL(listPath(s.projects.notGit.id))
    await expect(page.getByTestId("import-total")).toHaveText("1개")
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page)).toContainText(s.titles.memo)
  })

  test("the palette's 다른 도구의 대화 열기 opens the list of the conversation's project", async () => {
    const s = state()
    await page.goto(`/srv/local/s/${s.sessions.second}`)
    await ready(page)
    await page.keyboard.press("Control+K")
    await expect(page.getByTestId("palette")).toBeVisible()
    await page.getByTestId("palette-input").fill("다른 도구")
    const command = page.getByTestId("palette-item").filter({ hasText: "다른 도구의 대화 열기" })
    await expect(command).toHaveCount(1)
    await expect(command).toContainText(s.projects.main.name)
    await command.click()
    await expect(page).toHaveURL(listPath(s.projects.main.id))
    await expect(page.getByTestId("import-total")).toHaveText(`${s.expect.rows}개`)
  })

  test("list: first requests, tags, and the filters", async () => {
    const s = state()
    await openList(page, s.projects.main.id)
    await expect(page.getByTestId("import-total")).toHaveText(`${s.expect.rows}개`)
    await expect(rows(page)).toHaveCount(s.expect.rows)
    await expect(row(page, s.titles.fix).getByTestId("import-row-prompt")).toHaveText(`설치기를 고쳐 줘 ${s.mark}`)
    await expect(row(page, s.titles.fix).getByTestId("import-row-model")).toHaveText("원래: gpt-5.5")
    await expect(row(page, s.titles.live).getByTestId("import-tag-live")).toHaveText("진행 중일 수 있음")
    const missing = row(page, s.titles.missing)
    await expect(missing.getByTestId("import-tag-unreadable")).toHaveText("읽을 수 없음")
    await expect(missing.getByTestId("import-tag-unreadable")).toHaveAttribute("title", "원본 파일이 없어요")
    await expect(missing.getByTestId("import-row-open")).toHaveCount(0)

    await kind(page, "Claude Code")
    await expect(rows(page)).toHaveCount(s.expect.claude)
    await expect(page.locator('[data-testid="import-row"]:not([data-kind="claude-code"])')).toHaveCount(0)
    await expect(row(page, s.titles.gone).getByTestId("import-tag-folderMissing")).toHaveText("폴더 없음")
    // Q3 (09 §8.2): Claude Code's 30-day cleanup; the tag from 7 days left, earlier only the tooltip.
    await expect(row(page, s.titles.old).getByTestId("import-tag-expires")).toHaveText(
      `${s.expect.expiresIn}일 뒤 원본이 지워질 수 있음`,
    )
    const review = row(page, s.titles.review)
    await expect(review.getByTestId("import-tag-expires")).toHaveCount(0)
    await expect(review).toHaveAttribute(
      "title",
      new RegExp(`이 대화는 ${s.expect.reviewDays}일 뒤 지워질 수 있어요`),
    )
    await kind(page, "Codex")
    await expect(rows(page)).toHaveCount(s.expect.codex)
    await expect(page.locator('[data-testid="import-row"]:not([data-kind="codex"])')).toHaveCount(0)
    await kind(page, "전체")
    await expect(rows(page)).toHaveCount(s.expect.rows)

    // 하위 에이전트: the sub-agent conversation folds under its parent.
    await toggle(page, "import-filter-subagents", true)
    const fold = row(page, s.titles.fix).getByTestId("import-row-children")
    await expect(fold).toContainText("하위 에이전트 1개 보기")
    await fold.click()
    await expect(fold).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator('[data-testid="import-row"][data-child]')).toContainText(s.titles.child)
    await toggle(page, "import-filter-subagents", false)
    await expect(page.getByTestId("import-row-children")).toHaveCount(0)

    await toggle(page, "import-filter-archived", true)
    await expect(page.getByTestId("import-total")).toHaveText(`${s.expect.rows + 1}개`)
    await expect(row(page, s.titles.archived).getByTestId("import-tag-archived")).toHaveText("보관됨")
    await toggle(page, "import-filter-archived", false)
    await toggle(page, "import-filter-exec", true)
    await expect(row(page, s.titles.exec).getByTestId("import-tag-exec")).toHaveText("자동 실행")
    await toggle(page, "import-filter-exec", false)
    await expect(page.getByTestId("import-total")).toHaveText(`${s.expect.rows}개`)

    // 모든 폴더: grouped by working folder; the folder that is gone says so.
    await page.getByTestId("import-filter-scope").getByRole("radio", { name: "모든 폴더" }).click()
    await expect(page.getByTestId("import-folder").first()).toBeVisible()
    await page.getByTestId("import-list").evaluate((element) => element.scrollTo(0, element.scrollHeight))
    await expect(page.getByTestId("import-folder").filter({ hasText: s.folders.missing })).toContainText("폴더 없음")
    await page.getByTestId("import-filter-scope").getByRole("radio", { name: "이 폴더" }).click()
    await expect(page.getByTestId("import-folder")).toHaveCount(0)
  })

  test("viewer, Codex .zst: band, header, 읽는 중 → complete, remote compaction mid-turn, Ctrl+F jump", async () => {
    const s = state()
    await openList(page, s.projects.main.id)
    // The outline streams (09 §2.8): `읽는 중` and `N턴 이상` show for a moment only, so an observer marks <html> with
    // `data-e2e-outline` (`reading`, `partial`) when either was on screen before the outline completed.
    await page.evaluate(() => {
      const root = document.documentElement
      const mark = (flag: string) => {
        const flags = new Set((root.dataset.e2eOutline ?? "").split(" ").filter(Boolean)).add(flag)
        root.dataset.e2eOutline = [...flags].toSorted().join(" ")
      }
      const check = () => {
        if (document.querySelector('[data-testid="import-outline-reading"]')) mark("reading")
        const turns = document.querySelector('[data-testid="import-viewer-meta"] [data-item="turns"]')
        if (turns?.textContent?.includes("이상")) mark("partial")
      }
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await row(page, s.titles.zst).getByTestId("import-row-open").click()
    await expect(page.getByTestId("import-viewer-band")).toHaveText(
      "읽기 전용 · Codex 대화 · 원본 파일은 바꾸지 않아요",
    )
    await expect(page.getByTestId("import-viewer-title")).toHaveText(s.titles.zst)
    const meta = page.getByTestId("import-viewer-meta")
    await expect(meta.locator('[data-item="turns"]')).toHaveText(`${s.expect.zstTurns}턴`)
    await expect(page.getByTestId("import-outline-reading")).toHaveCount(0)
    await expect(page.locator("html")).toHaveAttribute("data-e2e-outline", "partial reading")
    await expect(meta.locator('[data-item="tool"]')).toHaveText("Codex 0.153.0")
    await expect(meta.locator('[data-item="model"]')).toHaveText("원래 모델 gpt-5.5")
    await expect(meta.locator('[data-item="folder"]')).toHaveText(`폴더 ${s.folders.first}`)
    await expect(meta.locator('[data-item="branch"]')).toHaveText("브랜치 main")
    await expect(meta.locator('[data-item="tokens"]')).toHaveText(/^약 \S+ 토큰$/)
    await expect(meta.locator('[data-item="compactions"]')).toHaveText("압축 1번")
    await expect(page.getByTestId("import-outline-turn").first()).toHaveText(
      `1. zst 대화: 설치기 성능을 재 줘 ${s.mark}`,
    )

    // Codex's remote compaction inside turn 2: after its request and tool call, before the answer that goes on.
    const timeline = page.getByTestId("import-viewer-timeline")
    const marker = timeline.getByTestId("import-compaction")
    await expect(marker).toHaveAttribute("data-kind", "codex-remote")
    await expect(marker).toContainText("Codex가 여기서 대화를 압축했어요")
    await expect(marker.getByTestId("import-compaction-encrypted")).toHaveText(
      "요약 내용을 읽을 수 없음(암호화) · 그 앞의 사용자 요청 2개는 남아 있음",
    )
    await marker.scrollIntoViewIfNeeded()
    await inOrder([
      timeline.getByText("느린 단계를 찾아 줘", { exact: true }),
      marker,
      timeline.getByText("압축 뒤에 이어서: 압축 해제가 가장 느립니다.", { exact: true }),
    ])

    // Ctrl+F: the whole conversation on the server, tool output included; a hit shows its turn.
    await page.getByTestId("import-viewer-title").click()
    await page.keyboard.press("Control+F")
    const find = page.getByTestId("import-viewer-find-input")
    await expect(find).toBeFocused()
    await find.fill("북극곰")
    const hit = page.getByTestId("import-viewer-hit")
    await expect(hit).toHaveCount(1)
    await expect(hit).toContainText(`${s.expect.polarTurn}번째 턴`)
    await expect(hit).toContainText("북극곰 캐시 2.1 s")
    await hit.click()
    await expect(timeline.getByText(`설치 단계 ${s.expect.polarTurn - 1}을 재 줘`, { exact: true })).toBeInViewport()
    await expect(outlineTurn(page, s.expect.polarTurn)).toHaveAttribute("aria-current", "true")
  })

  test("viewer, Claude Code: mid-turn compaction with its summary, 텍스트로 복사", async () => {
    const s = state()
    await openList(page, s.projects.main.id)
    await kind(page, "Claude Code")
    await row(page, s.titles.review).getByTestId("import-row-open").click()
    await expect(page.getByTestId("import-viewer-band")).toHaveText(
      "읽기 전용 · Claude Code 대화 · 원본 파일은 바꾸지 않아요",
    )
    const meta = page.getByTestId("import-viewer-meta")
    await expect(meta.locator('[data-item="tool"]')).toHaveText("Claude Code 2.1.288")
    await expect(meta.locator('[data-item="turns"]')).toHaveText("3턴")
    await expect(meta.locator('[data-item="compactions"]')).toHaveText("압축 1번")
    await expect(page.getByTestId("import-outline-reading")).toHaveCount(0)

    // Claude Code compacted right after a tool result: the marker sits between that result and the answer after it.
    const timeline = page.getByTestId("import-viewer-timeline")
    const marker = timeline.getByTestId("import-compaction")
    await expect(marker).toHaveAttribute("data-kind", "foreign")
    await expect(marker).toContainText("Claude Code가 여기서 대화를 압축했어요")
    await inOrder([
      timeline.getByText("문서도 고쳐 줘", { exact: true }),
      marker,
      timeline.getByText("압축 뒤에 이어서 문서를 고칩니다.", { exact: true }),
    ])
    await marker.getByRole("button", { name: "요약 보기" }).click()
    const summary = marker.locator("pre")
    await expect(summary).toContainText("Primary Request and Intent")
    // Claude Code's harness wording is gone (09 §2.6): no instruction to go on alone, no transcript path.
    await expect(summary).not.toContainText("without asking the user")
    await expect(summary).not.toContainText("read the full transcript")

    await page.getByTestId("import-viewer-copy").click()
    await expect(page.getByTestId("import-viewer-status")).toHaveText("대화를 텍스트로 복사했어요")
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain("Claude Code 대화의 읽기 전용 사본")
    expect(copied).toContain(`설치기 리팩터링을 해 줘 ${s.mark}`)
    expect(copied).toContain("압축 뒤에 이어서 문서를 고칩니다.")
  })

  test("title search, and 내용까지 answering in parts: 계속 찾기, a hit opens its turn", async () => {
    const s = state()
    await openList(page, s.projects.main.id)
    const search = page.getByTestId("import-search")
    await search.fill("설치기")
    await expect(page.getByTestId("import-total")).toHaveText("3개")
    await expect(rows(page)).toHaveCount(3)
    await search.press("Escape")
    await expect(page.getByTestId("import-total")).toHaveText(`${s.expect.rows}개`)

    // 내용까지 (09 §3): what the user and the model wrote; 130 turns hold the word, more than one answer's 100 hits.
    await toggle(page, "import-search-content", true)
    await search.fill("체크리스트")
    await expect(page.getByText("내용에서 찾은 것")).toBeVisible()
    const group = page.getByTestId("import-hits").filter({ hasText: s.titles.long })
    await expect(group.getByTestId("import-hit")).toHaveCount(3)
    const more = page.getByTestId("import-search-more")
    await expect(more).toHaveText("일부만 찾음 · 계속 찾기")
    await continueSearch(page)
    await expect(page.getByTestId("import-status-searching")).toHaveCount(0)
    await expect(page.getByTestId("import-status-none")).toHaveCount(0)
    const third = group.getByTestId("import-hit").nth(2)
    await expect(third).toContainText("3번째 턴")
    await third.click()
    await expect(page.getByTestId("import-viewer-title")).toHaveText(`${s.titles.long} ${s.mark}`)
    await expect(
      page.getByTestId("import-viewer-timeline").getByText("배포 체크리스트 3번 항목을 확인해 줘", { exact: true }),
    ).toBeInViewport()
  })

  test("설정 > 다른 도구: 찾을 곳 더하기 adds a root whose conversation joins the list", async () => {
    const s = state()
    await page.goto("/settings/import")
    await ready(page)
    const roots = page.getByTestId("settings-import-root")
    await expect(roots).toHaveCount(2)
    await expect(roots.filter({ hasText: "처음 값" })).toHaveCount(2)
    await page.getByTestId("settings-import-kind").getByRole("radio", { name: "Codex" }).click()
    await page.getByTestId("settings-import-folder").fill(s.roots.extra)
    // Right after the page's sources.list: sources.configure scans the roots again, warm window or not.
    await page.getByTestId("settings-import-add-button").click()
    await expect(page.getByTestId("settings-import-status")).toHaveText("찾는 곳을 바꿨어요")
    await expect(roots).toHaveCount(3)
    const added = roots.filter({ hasText: "더한 곳" })
    await expect(added).toContainText(s.roots.extra)
    await expect(entry(page, s.projects.main.id)).toContainText(`새 ${s.expect.fresh + 1}개`, { timeout: 60_000 })
    await openList(page, s.projects.main.id)
    await expect(row(page, s.titles.extra)).toHaveCount(1)
    await expect(page.getByTestId("import-total")).toHaveText(`${s.expect.rows + 1}개`)

    // Taken out again, so a reused backend starts the next run with its two roots.
    await page.goto("/settings/import")
    await ready(page)
    await expect(roots).toHaveCount(3)
    await roots.filter({ hasText: "더한 곳" }).getByTestId("settings-import-remove").click()
    await expect(roots).toHaveCount(2)
    await expect(entry(page, s.projects.main.id)).toContainText(`새 ${s.expect.fresh}개`, { timeout: 60_000 })
  })

  test("375 px: the list and the viewer fit the width; the outline opens on request", async ({ browser }) => {
    const s = state()
    const narrow = await windowOf(browser, seen, { width: 375, height: 812 })
    const small = await narrow.newPage()
    await openList(small, s.projects.main.id)
    await expect(small.getByTestId("import-total")).toHaveText(`${s.expect.rows}개`)
    await fitsWidth(small)
    await expect(row(small, s.titles.live).getByTestId("import-row-open")).toBeInViewport()
    await row(small, s.titles.fix).getByTestId("import-row-open").click()
    await expect(small.getByTestId("import-viewer-band")).toBeInViewport()
    await expect(small.getByTestId("import-viewer-timeline").getByText(`설치기를 고쳐 줘 ${s.mark}`)).toBeVisible()
    await expect(small.getByTestId("import-viewer-outline")).toHaveCount(0)
    await fitsWidth(small)
    const outline = small.getByTestId("import-viewer-outline-toggle")
    await expect(outline).toHaveText("개요 보기")
    await outline.click()
    await expect(small.getByTestId("import-viewer-outline")).toBeVisible()
    await fitsWidth(small)
    await narrow.close()
  })

  test("keyboard only: palette → list → title search → viewer → Ctrl+F → hit → back", async ({ browser }) => {
    const s = state()
    const keys = await windowOf(browser, seen, { width: 1440, height: 900 })
    const only = await keys.newPage()
    await only.goto(`/srv/local/s/${s.sessions.first}`)
    await ready(only)
    await expect(entry(only, s.projects.main.id)).toBeVisible()
    await only.keyboard.press("Control+K")
    await expect(only.getByTestId("palette-input")).toBeFocused()
    await only.keyboard.type("다른 도구의 대화 열기")
    await expect(only.getByTestId("palette-item").first()).toContainText("다른 도구의 대화 열기")
    await only.keyboard.press("Enter")
    await expect(only).toHaveURL(listPath(s.projects.main.id))
    await expect(only.getByTestId("import-total")).toHaveText(`${s.expect.rows}개`)
    await tabTo(only, only.getByTestId("import-search"))
    await only.keyboard.type("Claude 설치기")
    await expect(rows(only)).toHaveCount(1)
    await tabTo(only, row(only, s.titles.review).getByTestId("import-row-open"))
    await only.keyboard.press("Enter")
    await expect(only.getByTestId("import-viewer-title")).toHaveText(s.titles.review)
    await expect(only.getByTestId("import-viewer-meta").locator('[data-item="turns"]')).toHaveText("3턴")
    await only.keyboard.press("Control+F")
    await expect(only.getByTestId("import-viewer-find-input")).toBeFocused()
    await only.keyboard.type("2 pass")
    const hit = only.getByTestId("import-viewer-hit")
    await expect(hit).toHaveCount(1)
    await expect(hit).toContainText("2번째 턴")
    await tabTo(only, hit)
    await only.keyboard.press("Enter")
    await expect(outlineTurn(only, 2)).toHaveAttribute("aria-current", "true")
    await tabTo(only, only.getByTestId("import-viewer-back"), true)
    await only.keyboard.press("Enter")
    await expect(only.getByTestId("page-import")).toBeVisible()
    await keys.close()
  })

  test("PF5: the production build's initial JS stays within budget and holds no import screen", async () => {
    test.setTimeout(300_000)
    // Reads dist/ as it is; without a build, builds now. Under test:e2e:all (OWN_WEB_DIST_BUILT=1) dist/ is that run's
    // build, which the other worker's suite may be serving: never build there.
    if (process.env.OWN_WEB_DIST_BUILT !== "1" && !fs.existsSync(path.join(PACKAGE, "dist", "index.html"))) {
      const build = bun(["run", "build"])
      expect(build.status, build.stderr).toBe(0)
    }
    const size = bun(["run", "script/bundle-size.ts", "--json"])
    expect(size.status, size.stdout).toBe(0)
    const report = JSON.parse(size.stdout.trim().split("\n").at(-1)!) as {
      readonly initialJsGzip: number
      readonly desktopLeak: boolean
      readonly files: ReadonlyArray<{ readonly file: string }>
    }
    expect(report.initialJsGzip).toBeLessThanOrEqual(400 * 1024)
    expect(report.desktopLeak).toBe(false)
    const sources = report.files.flatMap((item) => {
      const map = path.join(PACKAGE, "dist", `${item.file}.map`)
      return fs.existsSync(map)
        ? (JSON.parse(fs.readFileSync(map, "utf8")) as { readonly sources: readonly string[] }).sources
        : []
    })
    expect(sources.length).toBeGreaterThan(100)
    const normalized = sources.map((source) => source.replaceAll("\\", "/"))
    // The first-chunk part is there (the entries and counts), the screens are not.
    expect(normalized.some((source) => source.endsWith("src/import/store.ts"))).toBe(true)
    expect(normalized.filter((source) => SCREENS.test(source))).toEqual([])
  })

  test("IG10: no conversation text in the page's storage, OWN_HOME or import-index.json; loopback only", async () => {
    const s = state()
    const needles = [s.mark, "북극곰", "체크리스트", s.titles.zst, s.titles.review]
    const stored = await page.evaluate(async () => [
      ...Object.entries(localStorage).flat(),
      ...Object.entries(sessionStorage).flat(),
      ...(await indexedDB.databases()).map((database) => database.name ?? ""),
    ])
    expect(needles.filter((needle) => stored.some((value) => value.includes(needle)))).toEqual([])
    const index = path.join(s.ownHome, "state", "import-index.json")
    await expect.poll(() => fs.existsSync(index), { timeout: 30_000 }).toBe(true)
    expect(containing(s.ownHome, needles)).toEqual([])
    // The Codex state DB is read through a copy that never outlives the read (09 §2.3).
    const tmp = path.join(s.ownHome, "tmp")
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((name) => name.startsWith("import-")) : []).toEqual([])
    expect([...seen.hosts]).toEqual(["127.0.0.1"])
  })

  test("IG1: the stores are exactly as before the suite", () => {
    expect(listing(state().roots.base)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------------------------------------------

interface Seen {
  /** Uncaught page errors (a test fails on any). */
  readonly errors: string[]
  /** Hosts every page of the suite sent a request to. */
  readonly hosts: Set<string>
  /** The path of every module and resource the pages fetched. */
  readonly modules: string[]
}

/**
 * A browser context of the suite: Korean, clipboard allowed (텍스트로 복사), resource timings kept beyond the default
 * 250 (Vite dev fetches hundreds of modules), and every request and page error recorded in `seen`.
 */
async function windowOf(browser: Browser, seen: Seen, viewport: { readonly width: number; readonly height: number }) {
  const context = await browser.newContext({ viewport, locale: "ko-KR" })
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await context.addInitScript(() => performance.setResourceTimingBufferSize(100_000))
  context.on("request", (request) => {
    const url = new URL(request.url())
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:") seen.hosts.add(url.hostname)
    seen.modules.push(url.pathname)
  })
  context.on("page", (opened) => opened.on("pageerror", (error) => seen.errors.push(error.message)))
  return context
}

async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

function listPath(projectID: string) {
  return new RegExp(`/srv/local/p/${projectID}/import$`)
}

/** Opens a project's list and waits until its scan is done. */
async function openList(page: Page, projectID: string) {
  await page.goto(`/srv/local/p/${projectID}/import`)
  await expect(page.getByTestId("import-total")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("import-scanning")).toHaveCount(0, { timeout: 60_000 })
}

/** The sidebar's `다른 도구의 대화 · 새 N개 ›` of a project. */
function entry(page: Page, projectID: string) {
  return page.locator(`[data-testid="import-entry"][href$="/p/${projectID}/import"]`)
}

function projectRow(page: Page, name: string) {
  return page.getByTestId("project-row").filter({ hasText: name })
}

function rows(page: Page) {
  return page.getByTestId("import-row")
}

/** The list row of the conversation titled `title` (titles are unique in the fixtures). */
function row(page: Page, title: string) {
  return rows(page).filter({ has: page.locator(".own-import-row-title", { hasText: title }) })
}

function outlineTurn(page: Page, turn: number) {
  return page.getByTestId("import-outline-turn").filter({ hasText: new RegExp(`^${turn}\\. `) })
}

async function kind(page: Page, label: string) {
  await page.getByTestId("import-filter-kind").getByRole("radio", { name: label }).click()
}

async function toggle(page: Page, testid: string, pressed: boolean) {
  const button = page.getByTestId(testid)
  await button.click()
  await expect(button).toHaveAttribute("aria-pressed", String(pressed))
}

/** `일부만 찾음 · 계속 찾기` until the content search is complete. */
async function continueSearch(page: Page, left = 5): Promise<void> {
  const more = page.getByTestId("import-search-more")
  await expect(page.getByTestId("import-status-searching")).toHaveCount(0, { timeout: 30_000 })
  if ((await more.count()) === 0) return
  if (left === 0) throw new Error("the content search never completed")
  await more.click()
  await expect(page.getByTestId("import-status-searching")).toHaveCount(0, { timeout: 30_000 })
  return continueSearch(page, left - 1)
}

/** The locators are laid out top to bottom in this order. */
async function inOrder(locators: ReadonlyArray<Locator>) {
  const tops = await Promise.all(locators.map(async (locator) => (await locator.boundingBox())?.y))
  expect(tops.every((top) => top !== undefined)).toBe(true)
  expect(tops).toEqual(tops.toSorted((a, b) => (a ?? 0) - (b ?? 0)))
}

/** Tab (or Shift+Tab) until `target` has the focus; fails after `left` presses. */
async function tabTo(page: Page, target: Locator, backward = false, left = 80): Promise<void> {
  const focused =
    (await target.count()) > 0 && (await target.first().evaluate((element) => element === document.activeElement))
  if (focused) return
  if (left === 0) throw new Error("Tab never reached the element")
  await page.keyboard.press(backward ? "Shift+Tab" : "Tab")
  return tabTo(page, target, backward, left - 1)
}

/** No horizontal scrolling at this width. */
async function fitsWidth(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(widths.scroll).toBeLessThanOrEqual(widths.client)
}

/** Bun from this package's folder; on Windows `bun` may be a `.cmd` shim, which only a shell starts. */
function bun(args: readonly string[]) {
  return spawnSync("bun", args, { cwd: PACKAGE, encoding: "utf8", shell: process.platform === "win32" })
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

/** The files below `dir` whose bytes hold one of `needles`, with the needles they hold. */
function containing(dir: string, needles: ReadonlyArray<string>) {
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).flatMap((name) => {
    const file = path.join(dir, name)
    if (!fs.lstatSync(file).isFile()) return []
    const bytes = fs.readFileSync(file)
    const hits = needles.filter((needle) => bytes.includes(Buffer.from(needle)))
    return hits.length === 0 ? [] : [{ file: name, needles: hits }]
  })
}
