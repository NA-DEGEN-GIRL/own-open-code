// The skills import's sources, duplicates, search, detail and link consent end to end (SK2, 2026-10-24; 03 §19.6.1,
// 09 §9.2–§9.4), on backend.ts's server with the design fixture of ./skills.ts:
// - the head names every place looked in (the default homes, the codex-multi-provider accounts by alias, the one that
//   shares the default's skills folder) and links to 설정 > 다른 도구;
// - identical copies are one row (`3곳에서 찾음`), the copy of the same content Claude Code's folder has is `이미 쓰는
//   중 (Claude Code (기본))`, the other pdf is `내용이 다름` with its version; bundled skills hide behind `기본 제공도
//   보기`; removed and half-installed folders never show;
// - the search and the filters;
// - `상세 보기`: the frontmatter, the files, the hash, a hostile body rendered without its script, its event handler or
//   its remote image; 설정 > 스킬's own rows too (places by content, own-import's copy with its source);
// - a link inside the skills area is copied as files; one outside waits for its checkbox, then reads and imports;
// - the palette's `스킬 가져오기…` while the page is open, the popover's `설정에서 스킬 관리`, and a 375 px window;
// - 2026-10-25 (the round-2 review): every remote picture of a body held back and counted, nothing reaching the
//   suite's probe host until `원격 그림 보기`, then without a referrer; bodies that froze or overflowed the parser shown
//   as their text with the page responsive; the same content own's skills folder holds by hand in use, under another
//   id said so; accounts and folders of one name labelled apart.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"

const TMP = process.env.OWN_WEB_TOOLS_E2E_TMP ?? ""
const state = JSON.parse(fs.readFileSync(path.join(TMP, "backend.json"), "utf8")) as {
  readonly control: string
  readonly project: string
  readonly session: string
  readonly skillsDir: string
  readonly home: string
  readonly elsewhere: string
  readonly probe: string
}
/** The remote pictures of the `pictures` skill's body (./skills.ts `PICTURES`; Playwright runs in Node, so not imported). */
const PICTURES = 8
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(TMP, "shots", `${name}.png`), fullPage: true })

test.describe.configure({ mode: "serial" })

/** 설정 > 스킬's import view, its list read. */
async function importView(page: Page) {
  await page.goto("/settings/skills")
  const view = page.getByTestId("settings-skills-import").getByTestId("skills-import")
  await expect(view.getByTestId("skills-import-row").first()).toBeVisible({ timeout: 60_000 })
  return view
}

const rows = (view: Locator, skill: string) => view.locator(`[data-testid=skills-import-row][data-skill="${skill}"]`)

/** Removes every copy own-import made (each test starts from none). */
async function clean(page: Page) {
  const listed = (await page.request
    .post("/api/rpc/own.import/skills.list", { data: { input: {} }, params: { "location[directory]": state.control } })
    .then((response) => response.json())) as { output: { imports: { id: string }[] } }
  for (const copy of listed.output.imports)
    await page.request.post("/api/rpc/own.import/skills.remove", {
      data: { input: { id: copy.id } },
      params: { "location[directory]": state.control },
    })
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  await clean(page)
  await page.close()
})

test("places: every root by name, the shared account, a way to add a place", async ({ page }) => {
  const view = await importView(page)
  const places = view.getByTestId("skills-import-places")
  await expect(places).toContainText("찾아본 곳")
  await expect(places.locator(".own-sk-imp-place-name")).toHaveText([
    "Codex (기본 폴더)",
    "Codex · 계정 work",
    "Codex · 계정 side",
    "Codex · 계정 03",
    "Claude Code (기본)",
  ])
  await expect(places.getByTestId("skills-import-place").filter({ hasText: "계정 03" })).toContainText(
    "Codex (기본 폴더)의 스킬 폴더를 같이 써요",
  )
  await shot(page, "sk2-1-places")
  await places.getByTestId("skills-import-add-place").click()
  await expect(page).toHaveURL(/\/settings\/import$/)
})

test("dedup: one row per identical skill, the copy in use, other content marked, bundled hidden", async ({ page }) => {
  const view = await importView(page)
  const pdf = rows(view, "pdf")
  // Codex's three identical copies, the other one, and Claude Code's own.
  await expect(pdf).toHaveCount(3)
  const same = pdf.and(page.locator("[data-places='3']"))
  await expect(same).toHaveCount(1)
  await expect(same.getByTestId("skills-import-status")).toHaveText("이미 쓰는 중 (Claude Code (기본))")
  await expect(same.getByTestId("skills-import-use")).toHaveCount(0)
  await same.getByTestId("skills-import-places-list").locator("summary").click()
  await expect(same.getByTestId("skills-import-place-row")).toHaveCount(3)
  await expect(same.getByTestId("skills-import-places-list")).toContainText("Codex · 계정 work")
  const other = pdf.filter({ hasText: "버전 2.0.0" })
  await expect(other.getByTestId("skills-import-differs")).toHaveText("내용이 다름")
  await expect(other.getByTestId("skills-import-status")).toHaveText("가져올 수 있음")
  // `.trash` and `.staging` hold no skills to show; bundled ones wait behind the toggle.
  for (const skill of ["old-notes", "half", "skill-creator", "imagegen"]) await expect(rows(view, skill)).toHaveCount(0)
  await expect(view.getByTestId("skills-import-hidden")).toHaveText("기본 제공 2개 숨김")
  await view.getByTestId("skills-import-builtins").check()
  await expect(rows(view, "skill-creator")).toHaveAttribute("data-places", "2")
  await expect(rows(view, "imagegen")).toHaveCount(1)
  await shot(page, "sk2-2-dedup")
})

test("search and filters", async ({ page }) => {
  const view = await importView(page)
  const search = view.getByTestId("skills-import-search")
  await search.fill("side")
  await expect(view.getByTestId("skills-import-row")).toHaveCount(1)
  await expect(view.getByTestId("skills-import-row")).toContainText("버전 2.0.0")
  await search.fill("브랜드")
  await expect(view.getByTestId("skills-import-row")).toHaveCount(1)
  await search.fill("없는 스킬")
  await expect(view.getByTestId("skills-import-nomatch")).toBeVisible()
  await search.fill("")
  await view.getByTestId("skills-import-filter-differs").click()
  await expect(view.getByTestId("skills-import-row")).toHaveCount(2)
  await view.getByTestId("skills-import-filter-present").click()
  await expect(rows(view, "pdf")).toHaveCount(2)
  await expect(rows(view, "release-notes")).toHaveCount(0)
  await view.getByTestId("skills-import-filter-available").click()
  await expect(rows(view, "release-notes")).toHaveCount(1)
  await view.getByTestId("skills-import-filter-all").click()
  await view.getByTestId("skills-import-source").selectOption({ label: "Codex · 계정 side" })
  await expect(view.getByTestId("skills-import-row")).toHaveCount(1)
})

test("detail: frontmatter, files, hash; a hostile body renders without script, handler or remote image", async ({
  page,
}) => {
  const view = await importView(page)
  await rows(view, "hostile").getByTestId("skills-import-detail-open").click()
  const detail = view.getByTestId("skill-detail")
  await expect(detail.getByTestId("skill-detail-name")).toHaveText("hostile")
  const front = detail.getByTestId("skill-detail-frontmatter")
  for (const value of ["version", "0.9.1", "allowed-tools", "Read, Grep"]) await expect(front).toContainText(value)
  const markdown = detail.getByTestId("skill-detail-markdown")
  await expect(markdown.locator("h1")).toHaveText("위험한 본문")
  await expect(markdown.locator("script, iframe, [onerror]")).toHaveCount(0)
  await expect(markdown.locator("img")).toHaveCount(0)
  await expect(markdown.locator("a")).toHaveAttribute("rel", "noopener noreferrer nofollow")
  await expect(markdown.locator("pre")).toContainText("echo $ARGUMENTS")
  await expect(detail).toContainText("원격 그림 1개를 가렸어요")
  expect(await page.evaluate(() => (window as { __skillHacked?: number }).__skillHacked)).toBeUndefined()
  await expect(detail.getByTestId("skill-detail-files")).toContainText("SKILL.md")
  await expect(detail.getByTestId("skill-detail-hash")).toHaveText(/[0-9a-f]{64}/)
  await shot(page, "sk2-3-detail")
  // Remote images only when asked; never with a referrer.
  await detail.getByTestId("skill-detail-images").click()
  await expect(markdown.locator("img")).toHaveAttribute("referrerpolicy", "no-referrer")
  await view.getByTestId("skills-import-detail-back").click()
  await expect(rows(view, "hostile")).toBeVisible()
})

test("links: inside the skills area copied as files; outside only after its checkbox", async ({ page }) => {
  const view = await importView(page)
  // The junction onto `_common\brand` is the same folder: one place, the link a second way to it.
  const brand = rows(view, "brand")
  await expect(brand).toHaveCount(1)
  await expect(brand).toHaveAttribute("data-places", "2")
  const assets = rows(view, "3d-assets")
  await expect(assets.getByTestId("skills-import-status")).toHaveText("링크 확인 필요")
  await expect(assets.getByTestId("skills-import-link")).toContainText(path.join(state.elsewhere, "3d-assets"))
  await expect(assets).not.toContainText("3D 에셋을 만듭니다")
  await expect(assets.getByTestId("skills-import-use")).toHaveCount(0)
  await shot(page, "sk2-4-link-waiting")
  await assets.getByTestId("skills-import-link-approve").check()
  // Read again through the approved link: its description, its files, importable.
  await expect(assets).toContainText("3D 에셋을 만듭니다")
  await expect(assets.getByTestId("skills-import-status")).toHaveText("가져올 수 있음")
  await assets.getByTestId("skills-import-use").click()
  await expect(page.getByText("모든 프로젝트에서 쓰게 가져왔어요: 3d-assets")).toBeVisible()
  const copy = path.join(state.skillsDir, "3d-assets")
  expect(fs.readFileSync(path.join(copy, "models", "cube.obj"), "utf8")).toBe("v 0 0 0\n")
  expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false)
  await brand.getByTestId("skills-import-use").click()
  await expect(page.getByText("모든 프로젝트에서 쓰게 가져왔어요: brand")).toBeVisible()
  expect(fs.lstatSync(path.join(state.skillsDir, "brand")).isSymbolicLink()).toBe(false)
  // The account homes' auth.json files were never touched.
  expect(fs.readFileSync(path.join(state.home, "control-center", "profiles", "01", "codex", "auth.json"), "utf8")).toBe(
    '{"sentinel":"fake"}\n',
  )
})

test("설정 > 스킬 rows: 상세 보기 with every place by content; own-import's copy with its source", async ({ page }) => {
  await page.goto("/settings/skills")
  const list = page.getByTestId("settings-skills-all")
  const claudePdf = list.locator('[data-testid=settings-skills-row][data-skill="pdf"]')
  await expect(claudePdf).toBeVisible({ timeout: 60_000 })
  await claudePdf.getByTestId("settings-skills-detail").click()
  const dialog = page.getByTestId("settings-skills-detail-dialog")
  const places = dialog.getByTestId("skill-detail-places")
  await expect(places).toContainText("Codex (기본 폴더)", { timeout: 30_000 })
  await expect(places).toContainText("Codex · 계정 work")
  await expect(places).not.toContainText("Codex · 계정 side")
  await expect(dialog.getByTestId("skill-detail-hash")).toHaveText(/[0-9a-f]{64}/)
  await dialog.getByTestId("dialog-close").click()
  const copy = list.locator('[data-testid=settings-skills-row][data-skill="3d-assets"]')
  await expect(copy).toHaveAttribute("data-group", "imported", { timeout: 30_000 })
  await copy.getByTestId("settings-skills-detail").click()
  await expect(dialog.getByTestId("skill-detail-source")).toHaveText("원본과 같아요")
  await expect(dialog.getByTestId("skill-detail-imported")).toContainText("3d-assets")
  await shot(page, "sk2-5-settings-detail")
  await dialog.getByTestId("dialog-close").click()
})

test("the palette's 스킬 가져오기… works while the page is open; the popover links to 설정 > 스킬", async ({ page }) => {
  // A short window, so the import section starts out of sight and only the intent brings it in (at 1440×900 it was in
  // sight already and the test proved nothing).
  await page.setViewportSize({ width: 1280, height: 480 })
  await page.goto("/settings/skills")
  await expect(page.getByTestId("settings-skills-import").getByTestId("skills-import")).toBeAttached({
    timeout: 60_000,
  })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByTestId("settings-skills").scrollIntoViewIfNeeded()
  await expect(page.getByTestId("settings-skills-import")).not.toBeInViewport()
  await page.keyboard.press("Control+KeyK")
  await expect(page.getByTestId("palette-input")).toBeFocused()
  await page.keyboard.type("스킬 가져오기")
  await expect(page.getByRole("option", { name: /스킬 가져오기/ }).first()).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("settings-skills-import")).toBeInViewport()

  await page.goto(`/srv/local/s/${state.session}`)
  await page.locator("#own-composer-input").waitFor()
  await page.getByTestId("skills-button").click()
  await page.getByTestId("skills-panel").getByTestId("skills-manage").click()
  await expect(page).toHaveURL(/\/settings\/skills$/)
  await expect(page.getByTestId("skills-panel")).toHaveCount(0)
})

test("remote pictures in every form are held back and counted; asked for, they load without a referrer", async ({
  page,
}) => {
  const probe = async (method = "GET") =>
    (
      (await (await page.request.fetch(`${state.probe}/__probe`, { method })).json()) as {
        hits: { path: string; referer: string | null }[]
      }
    ).hits
  await probe("DELETE")
  const view = await importView(page)
  await rows(view, "pictures").getByTestId("skills-import-detail-open").click()
  const detail = view.getByTestId("skill-detail")
  const markdown = detail.getByTestId("skill-detail-markdown")
  await expect(markdown.locator("h1")).toHaveText("그림 시험")
  // The image, both table backgrounds, the srcset, the video poster, the SVG image and use, the style's url().
  await expect(detail).toContainText(`원격 그림 ${PICTURES}개를 가렸어요`)
  await expect(markdown.locator("img")).toHaveCount(0)
  expect(
    await markdown.evaluate((box) =>
      [...box.querySelectorAll("*")].flatMap((node) =>
        node
          .getAttributeNames()
          .filter((name) => !(node.localName === "a" && name === "href"))
          .filter((name) => /^(?:background|poster|srcset|src|href|xlink:href|style)$/.test(name))
          .map((name) => `${node.localName}[${name}]`),
      ),
    ),
  ).toEqual([])
  // Nothing reached the probe host while the pictures are held (a background loads without being in view).
  await page.waitForTimeout(1_500)
  expect(await probe()).toEqual([])
  await shot(page, "sk3-1-pictures-held")
  await detail.getByTestId("skill-detail-images").click()
  await expect(markdown.locator("img")).toHaveCount(PICTURES)
  for (const image of await markdown.locator("img").all()) {
    await expect(image).toHaveAttribute("referrerpolicy", "no-referrer")
    await image.scrollIntoViewIfNeeded()
  }
  await expect
    .poll(async () => new Set((await probe()).map((hit) => hit.path)).size, { timeout: 20_000 })
    .toBe(PICTURES)
  expect((await probe()).filter((hit) => hit.referer !== null)).toEqual([])
  await view.getByTestId("skills-import-detail-back").click()
})

test("bodies that froze or overflowed the parser show as their text, and the page stays responsive", async ({
  page,
}) => {
  const view = await importView(page)
  for (const [skill, text] of [
    ["quotes", "> > > "],
    ["stars", "*a *a *a "],
  ] as const) {
    // A long task on the main thread shows as a late tick of this interval.
    await page.evaluate(() => {
      const probe = window as { __gap?: number; __timer?: ReturnType<typeof setInterval> }
      const state = { last: performance.now() }
      probe.__gap = 0
      probe.__timer = setInterval(() => {
        const now = performance.now()
        probe.__gap = Math.max(probe.__gap ?? 0, now - state.last)
        state.last = now
      }, 50)
    })
    await rows(view, skill).getByTestId("skills-import-detail-open").click()
    const detail = view.getByTestId("skill-detail")
    await expect(detail.getByTestId("skill-detail-name")).toHaveText(skill)
    await expect(detail.getByTestId("skill-detail-raw")).toBeVisible({ timeout: 30_000 })
    await expect(detail.getByTestId("skill-detail-raw")).toContainText(text)
    await expect(detail.getByTestId("skill-detail-raw-note")).toHaveText("본문을 꾸며 보여 줄 수 없어 글 그대로 보여요")
    await expect(detail.getByTestId("skill-detail-files")).toContainText("SKILL.md")
    const gap = await page.evaluate(() => {
      const probe = window as { __gap?: number; __timer?: ReturnType<typeof setInterval> }
      clearInterval(probe.__timer)
      return probe.__gap ?? 0
    })
    expect(gap).toBeLessThan(2_000)
    if (skill === "stars") await shot(page, "sk3-2-raw-body")
    await view.getByTestId("skills-import-detail-back").click()
  }
})

test("the same content own's skills folder holds by hand is in use; under another id it says which", async ({
  page,
}) => {
  const view = await importView(page)
  const glossary = rows(view, "glossary")
  await expect(glossary.getByTestId("skills-import-status")).toHaveText("이미 쓰는 중 (전역)")
  await expect(glossary.getByTestId("skills-import-use")).toHaveCount(0)
  const translate = rows(view, "translate-tool")
  await expect(translate.getByTestId("skills-import-status")).toHaveText("이미 쓰는 중")
  await expect(translate.getByTestId("skills-import-same-as")).toHaveText("같은 내용이 translate로 이미 있어요")
  await expect(translate.getByTestId("skills-import-use")).toHaveCount(0)
  await shot(page, "sk3-3-same-content")
})

test("375 px: the import view and the detail fit the window", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const view = await importView(page)
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(await overflow()).toBeLessThanOrEqual(0)
  await rows(view, "hostile").getByTestId("skills-import-detail-open").click()
  await expect(view.getByTestId("skill-detail-markdown")).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
  await shot(page, "sk2-6-narrow-detail")
})
