// Shots of the 2026-10-24 settings pages for skills and MCP servers (SM): 설정 > 스킬 (the skills in use and the import
// view), 설정 > MCP 서버 (a server added in the app, tested), its `서버 추가…` form, `다른 도구에서 가져오기…` and
// `찾아서 설치…`. Group M, after the 2026-10-11 shots. The demo world adds one server through own.accounts `mcp.save`,
// writes made-up MCP settings into the demo home's Codex and Claude Code files and answers 찾아서 설치 from a fake MCP
// Registry with made-up servers (e2e/manual/backend.ts); nothing is saved by these shots.
// SG (2026-10-26, skills and MCP servers global first): 설정 > 스킬's `모든 프로젝트` and `프로젝트별 설정` (one skill
// switched off in another project for the picture, then back), 설정 > MCP 서버's `모든 프로젝트` and `프로젝트별 설정`,
// and the ✦ 스킬 popover's `끄기` with the group of skills switched off in this project (switched back on after).
import type { Locator, Page } from "../lib/browser"
import type { Ctx, Shot } from "../lib/ctx"
import type { MainState } from "./main"

type C = Ctx<MainState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<MainState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

/** A settings page without the right panel. */
async function open(ctx: C, path: string) {
  const page = await ctx.page({ path })
  await page.waitForTimeout(1500)
  if (
    await tid(page, "panel")
      .isVisible()
      .catch(() => false)
  )
    await tid(page, "panel-toggle").first().click()
  await page.waitForTimeout(300)
  return page
}

export const UPDATES3_MAIN: ReadonlyArray<Shot<MainState>> = [
  shot("10-settings-skills", async (ctx) => {
    // One skill of the app off in another project (billing), so a row shows the projects that differ; put back after.
    const view = (await ctx.rpc("own.accounts", "skillset.view", {})).output as {
      readonly catalog: ReadonlyArray<{ readonly id: string; readonly path: string }>
    }
    // The demo app's own skills folder is empty: a built-in skill (switchable too) when no other is there.
    const skill = view.catalog.find((item) => !item.path.startsWith("/builtin/")) ?? view.catalog.at(-1)
    const off = { id: skill?.id ?? "", directory: ctx.state.projects.billing }
    if (skill) await ctx.rpc("own.accounts", "skillset.switch", { changes: [{ ...off, enabled: false }] })
    const page = await open(ctx, "/settings/skills")
    await page.setViewportSize({ width: 1440, height: 2200 })
    const skills = tid(page, "settings-skills")
    const everywhere = tid(skills, "settings-skills-all")
    await tid(everywhere, "settings-skills-group").first().waitFor({ timeout: 60_000 })
    await tid(skills, "skills-import-row").first().waitFor({ timeout: 60_000 })
    const project = tid(skills, "settings-skills-project")
    await tid(project, "settings-skills-own-group").waitFor({ timeout: 60_000 })
    await page.waitForTimeout(800)
    const switched = everywhere
      .locator("[data-testid=settings-skills-row]")
      .filter({ has: page.getByTestId("settings-skills-exceptions") })
      .first()
    // The page down to the import view's places (its list is the 10-skills-import picture's).
    await ctx.shoot(page, "10-settings-skills", {
      clip: [skills.locator("p").first(), everywhere, project, tid(skills, "skills-import-places")],
      pad: 16,
      marks: [
        tid(everywhere, "settings-skills-group").first().locator("span").first(),
        [tid(switched, "settings-skills-toggle-all"), tid(switched, "settings-skills-exceptions")],
        [tid(project, "skills-project"), tid(project, "settings-skills-exceptions-group")],
        // SK2: the section's one heading and the places it looked in (the view has no title of its own here).
        [tid(skills, "settings-skills-import").locator("b").first(), tid(skills, "skills-import-places")],
      ],
    })
    if (skill) await ctx.rpc("own.accounts", "skillset.switch", { changes: [{ ...off, enabled: null }] })
  }),
  // SG: the popover's `끄기` takes a skill out of this project; the folded group lists it with `켜기`.
  shot("10-skills-off", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await page.setViewportSize({ width: 1440, height: 1200 })
    await tid(page, "skills-button").click()
    const panel = tid(page, "skills-panel")
    await tid(panel, "skills-option-off").first().waitFor({ timeout: 60_000 })
    const row = panel.locator(".own-sk-optrow").nth(1)
    const id = await tid(row, "skills-option").getAttribute("data-skill")
    await tid(row, "skills-option-off").click()
    const group = tid(panel, "skills-off-group")
    await group.waitFor({ timeout: 60_000 })
    await group.locator("summary").click()
    await page.waitForTimeout(800)
    await ctx.shoot(page, "10-skills-off", {
      clip: panel,
      pad: 12,
      marks: [tid(panel, "skills-option-off").first(), group.locator("summary"), tid(group, "skills-off-on").first()],
    })
    const back = group.locator(`[data-testid=skills-off-row][data-skill="${id ?? ""}"]`)
    await tid(back, "skills-off-on").click()
    await page.waitForTimeout(500)
    await page.keyboard.press("Escape")
  }),
  // SK2 (2026-10-24): one row for the same release-notes in two places, the other one marked, a link waiting.
  shot("10-skill-places", async (ctx) => {
    const page = await open(ctx, "/settings/skills")
    await page.setViewportSize({ width: 1440, height: 1500 })
    const view = tid(tid(page, "settings-skills-import"), "skills-import")
    await tid(view, "skills-import-row").first().waitFor({ timeout: 60_000 })
    const same = view.locator('[data-testid=skills-import-row][data-skill="release-notes"][data-places="2"]')
    await same.waitFor({ timeout: 60_000 })
    await tid(same, "skills-import-places-list").locator("summary").click()
    const other = view.locator('[data-testid=skills-import-row][data-skill="release-notes"][data-places="1"]')
    const linked = view.locator('[data-testid=skills-import-row][data-skill="3d-assets"]')
    await page.waitForTimeout(600)
    await ctx.shoot(page, "10-skill-places", {
      clip: [linked, same, other],
      pad: 12,
      marks: [tid(same, "skills-import-places-list"), tid(other, "skills-import-differs"), tid(linked, "skills-import-link")],
    })
  }),
  shot("10-skill-detail", async (ctx) => {
    const page = await open(ctx, "/settings/skills")
    await page.setViewportSize({ width: 1440, height: 1600 })
    const view = tid(tid(page, "settings-skills-import"), "skills-import")
    const row = view.locator('[data-testid=skills-import-row][data-skill="release-notes"][data-places="2"]')
    await row.waitFor({ timeout: 60_000 })
    await tid(row, "skills-import-detail-open").click()
    const detail = tid(view, "skill-detail")
    await tid(detail, "skill-detail-hash").waitFor({ timeout: 60_000 })
    await page.waitForTimeout(600)
    await ctx.shoot(page, "10-skill-detail", {
      clip: tid(view, "skills-import-detail"),
      pad: 12,
      marks: [
        tid(detail, "skill-detail-places"),
        tid(detail, "skill-detail-frontmatter"),
        tid(detail, "skill-detail-body"),
        [tid(detail, "skill-detail-files"), tid(detail, "skill-detail-hash")],
      ],
    })
  }),
  shot("10-settings-mcp", async (ctx) => {
    const page = await open(ctx, "/settings/mcp")
    await page.setViewportSize({ width: 1440, height: 1400 })
    const settings = tid(page, "settings-mcp")
    const row = settings.locator('[data-testid=mcp-row][data-name="files"]')
    await row.and(page.locator('[data-status="connected"]')).waitFor({ timeout: 60_000 })
    await tid(row, "mcp-check").waitFor({ timeout: 60_000 })
    await page.waitForTimeout(800)
    await ctx.shoot(page, "10-settings-mcp", {
      clip: settings,
      pad: 16,
      marks: [
        tid(settings, "mcp-actions"),
        // SG: own's servers used everywhere with the global switch, then the project's own list.
        tid(settings, "mcp-global").locator('[data-testid=mcp-global-row][data-name="files"]'),
        [tid(settings, "mcp-project-note"), tid(settings, "mcp-project")],
        tid(row, "mcp-row-details"),
        [tid(row, "mcp-status"), tid(row, "mcp-toggle")],
      ],
    })
  }),
  shot("10-mcp-add", async (ctx) => {
    const page = await open(ctx, "/settings/mcp")
    await page.setViewportSize({ width: 1440, height: 1300 })
    await tid(page, "mcp-add").click()
    const editor = tid(page, "mcp-editor")
    await editor.waitFor()
    await tid(editor, "mcp-editor-name").fill("github")
    await tid(editor, "mcp-editor-command").fill("npx")
    await tid(editor, "mcp-editor-args").fill("-y\n@modelcontextprotocol/server-github")
    await tid(editor, "mcp-editor-env-add").click()
    await tid(editor, "mcp-editor-env-name").fill("GITHUB_PERSONAL_ACCESS_TOKEN")
    await tid(editor, "mcp-editor-env-value").fill("demo-token-for-the-manual")
    await page.waitForTimeout(500)
    await ctx.shoot(page, "10-mcp-add", {
      clip: editor,
      pad: 12,
      marks: [
        tid(editor, "mcp-editor-paste"),
        [tid(editor, "mcp-editor-scope"), tid(editor, "mcp-editor-type")],
        tid(editor, "mcp-editor-env"),
        tid(editor, "mcp-editor-test"),
      ],
    })
    await tid(editor, "dialog-close").click()
  }),
  shot("10-mcp-import", async (ctx) => {
    const page = await open(ctx, "/settings/mcp")
    await page.setViewportSize({ width: 1440, height: 1300 })
    await tid(page, "mcp-import-open").click()
    const dialog = tid(page, "mcp-import")
    await tid(dialog, "mcp-import-row").first().waitFor({ timeout: 60_000 })
    await page.waitForTimeout(800)
    const first = tid(dialog, "mcp-import-row").first()
    await ctx.shoot(page, "10-mcp-import", {
      clip: dialog,
      pad: 12,
      marks: [
        [tid(first, "mcp-import-pick"), tid(first, "mcp-import-values")],
        dialog.locator('[data-testid=mcp-import-row][data-name="old-sse"]'),
        tid(dialog, "mcp-import-apply"),
      ],
    })
    await tid(dialog, "dialog-close").click()
  }),
  shot("10-mcp-registry", async (ctx) => {
    const page = await open(ctx, "/settings/mcp")
    await page.setViewportSize({ width: 1440, height: 1500 })
    await tid(page, "mcp-registry-find").click()
    const dialog = tid(page, "mcp-registry")
    await tid(dialog, "mcp-registry-row").first().waitFor({ timeout: 60_000 })
    const notes = dialog.locator('[data-testid=mcp-registry-row][data-name="io.github.demo-org/notes"]')
    await tid(notes, "mcp-registry-open").click()
    await tid(notes, "mcp-registry-details").waitFor()
    // The demo world asks a fake registry on this PC: the picture names the real one, as an installed app shows it.
    await page.evaluate(() => {
      const source = document.querySelector('[data-testid="mcp-registry-source"]')
      if (source) source.textContent = "registry.modelcontextprotocol.io에서 찾음"
    })
    await page.waitForTimeout(500)
    await ctx.shoot(page, "10-mcp-registry", {
      clip: dialog,
      pad: 12,
      marks: [
        tid(dialog, "mcp-registry-trust"),
        tid(dialog, "mcp-registry-search"),
        [tid(notes, "mcp-registry-meta"), tid(notes, "mcp-registry-options")],
        tid(notes, "mcp-registry-option-details"),
        tid(notes, "mcp-registry-use"),
      ],
    })
    await tid(dialog, "dialog-close").click()
  }),
]
