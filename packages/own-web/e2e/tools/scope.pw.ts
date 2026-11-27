// Skills and MCP servers global first (SG 2026-10-26; 03 §18.14, §19.6.1) end to end on backend.ts's server, with a
// second project B (a folder of this suite's temp folder with a conversation in it):
// - 설정 > 스킬: `모든 프로젝트` lists the skills of own's skills folder (put there by hand before this change, no
//   switch file: they stay on everywhere) without a project; `프로젝트별 설정` shows the chosen project's groups;
// - off for project A only: gone from A's skills (core's `GET /api/skill`), still in B's; the `모든 프로젝트` row names
//   A; `되돌리기` brings it back;
// - the global switch: off everywhere, then on in A only; the toast's `되돌리기`;
// - the ✦ 스킬 popover: `끄기` takes a skill out of this project, the folded group turns it back on;
// - import for every project (the default: A and B list it) and for one project only (`가져올 스킬을 쓸 곳`: the copy
//   is A's only); `지우기…` clears its scope;
// - MCP: a server own added runs in A and B; its global switch, the Ctrl+; dialog's tags of a project and `되돌리기`.
// Review fixes (SG-18…SG-21, 2026-10-26):
// - a switch from a second window: the first window's `@` list of A and of B (both read before) drops the skill, and
//   offers it again once it is on again;
// - a scope holds the skills nested in its folder, a flat `<id>.md` skill is scoped by its file (`쓰는 곳`);
// - `이 프로젝트만` with `바꾸기` keeps the replacing copy in this project, `모든 프로젝트` clears a scope a deleted
//   folder left behind, and the page lists such scopes with `설정 지우기`.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

const TMP = process.env.OWN_WEB_TOOLS_E2E_TMP ?? ""
const state = JSON.parse(fs.readFileSync(path.join(TMP, "backend.json"), "utf8")) as {
  readonly control: string
  readonly project: string
  readonly session: string
  readonly bun: string
  readonly script: string
  readonly skillsDir: string
  readonly home: string
}
/** Project B: its own folder with one conversation, so it is a project of the picker too. */
const B = path.join(TMP, "project-b")
const base = (directory: string) => path.basename(directory)
/** A SKILL.md (or flat `<id>.md`) as own-import's fixtures write it (they need Bun; the spec runs in Node). */
const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow the steps.\n`
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(TMP, "shots", `${name}.png`), fullPage: true })

async function rpc(request: APIRequestContext, method: string, input: unknown) {
  const response = await request.post(`/api/rpc/own.accounts/${method}`, {
    data: { input },
    params: { "location[directory]": state.control },
  })
  expect(response.status(), method).toBe(200)
  return ((await response.json()) as { output: unknown }).output
}

async function importRpc(request: APIRequestContext, method: string, input: unknown) {
  const response = await request.post(`/api/rpc/own.import/${method}`, {
    data: { input },
    params: { "location[directory]": state.control },
  })
  expect(response.status(), method).toBe(200)
  return ((await response.json()) as { output: unknown }).output
}

/** The skill ids core lists in a project. */
async function listed(request: APIRequestContext, directory: string) {
  const response = await request.get("/api/skill", { params: { "location[directory]": directory } })
  if (!response.ok()) return []
  return ((await response.json()) as { data: { id: string }[] }).data.map((skill) => skill.id)
}

/** Core's MCP servers in a project: name → status. */
async function core(request: APIRequestContext, directory: string) {
  const response = await request.get("/api/mcp", { params: { "location[directory]": directory } })
  const body = (await response.json()) as { data: { name: string; status: { status: string } }[] }
  return Object.fromEntries(body.data.map((item) => [item.name, item.status.status]))
}

/** Every switch and scope deleted (each test starts from none). */
async function reset(request: APIRequestContext) {
  const view = (await rpc(request, "skillset.view", {})) as {
    switches: { id: string; directory?: string }[]
    scopes: { folder: string }[]
  }
  if (view.switches.length + view.scopes.length === 0) return
  await rpc(request, "skillset.switch", {
    changes: view.switches.map((item) => ({ ...item, enabled: null })),
    scopes: view.scopes.map((item) => ({ folder: item.folder, directory: null })),
  })
}

/** The scopes own.accounts keeps. */
async function scopes(request: APIRequestContext) {
  return ((await rpc(request, "skillset.view", {})) as { scopes: { folder: string; directory: string }[] }).scopes
}

/**
 * Both projects' Locations open and warm: a skill folder that appears while a Location is still starting can be listed
 * there for a moment before the fold takes it away (SG-22), and a page would keep that list.
 */
async function warm(request: APIRequestContext) {
  for (const directory of [state.project, B]) await expect.poll(() => listed(request, directory)).toContain("glossary")
}

/** Every switch and scope deleted, and own-import's copy of release-notes removed. */
async function removeCopy(request: APIRequestContext) {
  await reset(request)
  const copies = (await importRpc(request, "skills.list", {})) as { imports: { id: string }[] }
  if (copies.imports.some((item) => item.id === "release-notes"))
    await importRpc(request, "skills.remove", { id: "release-notes" })
  await expect.poll(() => listed(request, state.project)).not.toContain("release-notes")
}

/** Picks a project in a page's project picker (its options are numbered; the newest project is B). */
async function pick(page: Page, testid: string, directory: string) {
  const select = page.getByTestId(testid)
  await expect(select.locator("option", { hasText: directory }).first()).toBeAttached({ timeout: 60_000 })
  const labels = await select.locator("option").allTextContents()
  await select.selectOption(String(labels.findIndex((label) => label.endsWith(directory))))
  await expect(select.locator("option:checked")).toContainText(directory)
}

/** 설정 > 스킬 on project A. */
async function skillsPage(page: Page) {
  await page.goto("/settings/skills")
  await pick(page, "skills-project", state.project)
}

const allRow = (page: Page, id: string) =>
  page.getByTestId("settings-skills-all").locator(`[data-testid=settings-skills-row][data-skill="${id}"]`)

test.describe.configure({ mode: "serial" })

const made: { session?: string } = {}

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(B, { recursive: true })
  const response = await request.post("/api/session", {
    data: { title: "프로젝트 B", location: { directory: B } },
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { data?: { id?: string }; id?: string }
  made.session = body.data?.id ?? body.id
  await reset(request)
})

test.afterAll(async ({ request }) => {
  await reset(request)
  // B's conversation goes, so the other files' pages start on A again (the newest project).
  if (made.session) await request.delete(`/api/session/${made.session}`)
})

test("설정 > 스킬: 모든 프로젝트 without a project, then the chosen project's groups", async ({ page, request }) => {
  await page.goto("/settings/skills")
  const skills = page.getByTestId("settings-skills")
  await expect(skills).toContainText("이 앱에 넣은 스킬은 모든 프로젝트에서 써요.")
  // own's skills folder from before this change (no switch file): every project uses them, the switch is on.
  for (const id of ["translate", "glossary"]) {
    await expect(allRow(page, id)).toHaveAttribute("data-group", "global", { timeout: 60_000 })
    await expect(allRow(page, id).getByTestId("settings-skills-toggle-all")).toHaveAttribute("aria-checked", "true")
    await expect(allRow(page, id).getByTestId("settings-skills-toggle-all")).toHaveAccessibleName(
      `${id} 모든 프로젝트에서 쓰기`,
    )
  }
  // A Location lists core's built-ins first and the folders' skills a moment later.
  for (const directory of [state.project, B])
    await expect.poll(() => listed(request, directory)).toEqual(expect.arrayContaining(["translate", "glossary"]))
  await expect(skills.getByTestId("settings-skills-cache")).toContainText("캐시를 처음부터 다시 써요")
  const project = skills.getByTestId("settings-skills-project")
  await pick(page, "skills-project", state.project)
  await expect(project.getByTestId("settings-skills-exceptions-group")).toContainText("이 프로젝트의 예외 · 0")
  await expect(project.getByTestId("settings-skills-own-group")).toBeVisible()
  await expect(project.getByTestId("settings-skills-everyone-group")).toContainText("모든 프로젝트 스킬 ·")
  await shot(page, "sg-1-skills")
})

test("off in project A only: gone in A, still in B; the row names A; 되돌리기 brings it back", async ({
  page,
  request,
}) => {
  await skillsPage(page)
  const project = page.getByTestId("settings-skills-project")
  const everyone = project.getByTestId("settings-skills-everyone-group")
  await everyone.locator("summary").click()
  const row = everyone.locator('[data-testid=settings-skills-row][data-skill="translate"]')
  const toggle = row.getByTestId("settings-skills-toggle-here")
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await expect(toggle).toHaveAccessibleName("translate 이 프로젝트에서 쓰기")
  await toggle.click()
  await expect(page.getByText("translate 스킬을 이 프로젝트에서 껐어요.")).toBeVisible()
  await expect.poll(() => listed(request, state.project)).not.toContain("translate")
  expect(await listed(request, B)).toContain("translate")
  await expect(toggle).toHaveAttribute("aria-checked", "false")
  await expect(allRow(page, "translate").getByTestId("settings-skills-exceptions")).toHaveText(
    `${base(state.project)}에서 꺼 둠`,
  )
  const exception = project
    .getByTestId("settings-skills-exceptions-group")
    .locator('[data-testid=settings-skills-row][data-skill="translate"]')
  await expect(exception.getByTestId("settings-skills-exception-tag")).toHaveText("이 프로젝트에서 꺼 둠")
  await shot(page, "sg-2-off-here")
  await exception.getByTestId("settings-skills-revert").click()
  await expect.poll(() => listed(request, state.project)).toContain("translate")
  await expect(allRow(page, "translate").getByTestId("settings-skills-exceptions")).toHaveCount(0)
  // B's exception: its name in the line picks B below.
  await rpc(request, "skillset.switch", { changes: [{ id: "translate", directory: B, enabled: false }] })
  const line = allRow(page, "translate").getByTestId("settings-skills-exceptions")
  await expect(line).toHaveText(`${base(B)}에서 꺼 둠`)
  await line.getByRole("button", { name: base(B) }).click()
  await expect(project.getByTestId("skills-project").locator("option:checked")).toContainText(B)
  await expect(
    project
      .getByTestId("settings-skills-exceptions-group")
      .locator('[data-testid=settings-skills-row][data-skill="translate"]'),
  ).toBeVisible()
  await reset(request)
})

test("the global switch: off everywhere, on only in A; the toast's 되돌리기", async ({ page, request }) => {
  await skillsPage(page)
  const toggle = allRow(page, "glossary").getByTestId("settings-skills-toggle-all")
  await toggle.click()
  await expect(page.getByText("glossary 스킬을 모든 프로젝트에서 껐어요.")).toBeVisible()
  await expect(allRow(page, "glossary").getByTestId("settings-skills-off-all")).toHaveText("모든 프로젝트에서 꺼 둠")
  await expect.poll(() => listed(request, state.project)).not.toContain("glossary")
  await expect.poll(() => listed(request, B)).not.toContain("glossary")
  const everyone = page.getByTestId("settings-skills-project").getByTestId("settings-skills-everyone-group")
  await everyone.locator("summary").click()
  const here = everyone
    .locator('[data-testid=settings-skills-row][data-skill="glossary"]')
    .getByTestId("settings-skills-toggle-here")
  await expect(here).toHaveAttribute("aria-checked", "false")
  await here.click()
  const toast = page.getByTestId("toast").filter({ hasText: "glossary 스킬을 이 프로젝트에서 켰어요." })
  await expect(toast).toBeVisible()
  await expect.poll(() => listed(request, state.project)).toContain("glossary")
  expect(await listed(request, B)).not.toContain("glossary")
  await expect(allRow(page, "glossary").getByTestId("settings-skills-exceptions")).toHaveText(
    `${base(state.project)}에서만 켬`,
  )
  await shot(page, "sg-3-only-here")
  await toast.getByRole("button", { name: "되돌리기" }).click()
  await expect.poll(() => listed(request, state.project)).not.toContain("glossary")
  await reset(request)
  await expect.poll(() => listed(request, B)).toContain("glossary")
})

test("the popover: 끄기 takes a skill out of this project; the off group turns it back on", async ({
  page,
  request,
}) => {
  await page.goto(`/srv/local/s/${state.session}`)
  await page.locator("#own-composer-input").waitFor()
  await page.getByTestId("skills-button").click()
  const panel = page.getByTestId("skills-panel")
  const option = panel.locator('[data-testid=skills-option][data-skill="glossary"]')
  await expect(option).toBeVisible()
  const off = panel
    .locator(".own-sk-optrow")
    .filter({ has: page.locator('[data-testid=skills-option][data-skill="glossary"]') })
    .getByTestId("skills-option-off")
  await expect(off).toHaveAttribute("title", "이 프로젝트에서 끄기")
  await off.click()
  await expect(page.getByText("glossary 스킬을 이 프로젝트에서 껐어요.")).toBeVisible()
  await expect(option).toHaveCount(0)
  const group = panel.getByTestId("skills-off-group")
  await expect(group.locator("summary")).toHaveText("이 프로젝트에서 끈 스킬 · 1")
  await group.locator("summary").click()
  const row = group.locator('[data-testid=skills-off-row][data-skill="glossary"]')
  await expect(row).toContainText("이 프로젝트에서 끔")
  await shot(page, "sg-4-popover")
  expect(await listed(request, B)).toContain("glossary")
  await row.getByTestId("skills-off-on").click()
  await expect(page.getByText("glossary 스킬을 이 프로젝트에서 켰어요.")).toBeVisible()
  await expect(option).toBeVisible()
  await expect(panel.getByTestId("skills-off-group")).toHaveCount(0)
  await reset(request)
})

test("import for every project (the default), then for one project only; 지우기… clears its scope", async ({
  page,
  request,
}) => {
  await skillsPage(page)
  const view = page.getByTestId("settings-skills-import").getByTestId("skills-import")
  const target = view.getByTestId("skills-import-target")
  await expect(target).toBeVisible({ timeout: 60_000 })
  await expect(target.locator("option")).toHaveText(["모든 프로젝트", `이 프로젝트만 (${base(state.project)})`])
  await expect(target).toHaveValue("all")
  const found = view.locator('[data-testid=skills-import-row][data-skill="release-notes"]')
  // Installed once, used everywhere: A and B list it, no scope is stored.
  await found.getByTestId("skills-import-use").click()
  await expect(page.getByText("모든 프로젝트에서 쓰게 가져왔어요: release-notes")).toBeVisible()
  for (const directory of [state.project, B])
    await expect.poll(() => listed(request, directory)).toContain("release-notes")
  expect(((await rpc(request, "skillset.view", {})) as { scopes: unknown[] }).scopes).toEqual([])
  await allRow(page, "release-notes").getByTestId("settings-skills-remove").click()
  await page.getByTestId("settings-skills-remove-confirm").click()
  await expect(page.getByText("release-notes 스킬을 지웠어요.")).toBeVisible()
  await expect.poll(() => listed(request, state.project)).not.toContain("release-notes")
  // For A only.
  await target.selectOption("here")
  await found.getByTestId("skills-import-use").click()
  await expect(page.getByText(`${base(state.project)} 프로젝트에서만 쓰게 가져왔어요: release-notes`)).toBeVisible()
  await expect.poll(() => listed(request, state.project)).toContain("release-notes")
  expect(await listed(request, B)).not.toContain("release-notes")
  const scoped = (await rpc(request, "skillset.view", {})) as { scopes: { folder: string; directory: string }[] }
  expect(scoped.scopes).toEqual([{ folder: path.join(state.skillsDir, "release-notes"), directory: state.project }])
  const own = page
    .getByTestId("settings-skills-own-group")
    .locator('[data-testid=settings-skills-row][data-skill="release-notes"]')
  await expect(own.getByTestId("settings-skills-scope-tag")).toHaveText("이 프로젝트만")
  // Not in the `모든 프로젝트` list: it is A's.
  await expect(allRow(page, "release-notes")).toHaveCount(0)
  await shot(page, "sg-5-import-here")
  // The first removal's toast (5 s) gone first: on a fast run it was still there, and two matched (merge round 7).
  await expect(page.getByText("release-notes 스킬을 지웠어요.")).toHaveCount(0)
  await own.getByTestId("settings-skills-remove").click()
  await page.getByTestId("settings-skills-remove-confirm").click()
  await expect(page.getByText("release-notes 스킬을 지웠어요.")).toBeVisible()
  await expect.poll(async () => ((await rpc(request, "skillset.view", {})) as { scopes: unknown[] }).scopes).toEqual([])
  await expect.poll(() => listed(request, state.project)).not.toContain("release-notes")
})

test("a switch from a second window: the first window's @ lists of A and B drop the skill and offer it again", async ({
  page,
  request,
}) => {
  const composer = page.locator("#own-composer-input")
  /** Opens the `@` list on `@glos`: glossary is offered or not (`picture`: a shot of the list), then it is cleared. */
  const mention = async (offered: boolean, picture?: string) => {
    await composer.click()
    await composer.pressSequentially("@glos")
    const list = page.getByTestId("suggest-list")
    await expect(list).toBeVisible()
    const option = list.locator('[data-testid=suggest-option][data-id="skill:glossary"]')
    if (offered) await expect(option).toBeVisible()
    else await expect(option).toHaveCount(0)
    if (picture) await shot(page, picture)
    await composer.press("Escape")
    await composer.press("Control+a")
    await composer.press("Backspace")
  }
  /** Another conversation in this window (the sidebar, no reload: the window keeps the lists it read). */
  const open = async (sessionID: string) => {
    await page.locator(`[data-testid="session-row"][data-session-id="${sessionID}"]`).first().click()
    await expect(page).toHaveURL(new RegExp(sessionID))
    await composer.waitFor()
  }
  await page.goto(`/srv/local/s/${state.session}`)
  await composer.waitFor()
  await mention(true)
  await open(made.session!)
  await mention(true)
  // The second window switches glossary off in every project.
  const other = await page.context().newPage()
  await skillsPage(other)
  const toggle = allRow(other, "glossary").getByTestId("settings-skills-toggle-all")
  await toggle.click()
  await expect(other.getByText("glossary 스킬을 모든 프로젝트에서 껐어요.")).toBeVisible()
  for (const directory of [state.project, B])
    await expect.poll(() => listed(request, directory)).not.toContain("glossary")
  // Back to the first window (a headless background tab gets no animation frames, so clicks there can stall).
  await page.bringToFront()
  await mention(false)
  await open(state.session)
  await mention(false, "sg-8-mention-off")
  // On again: offered again in both.
  await other.bringToFront()
  await toggle.click()
  await expect(other.getByText("glossary 스킬을 모든 프로젝트에서 켰어요.")).toBeVisible()
  for (const directory of [state.project, B]) await expect.poll(() => listed(request, directory)).toContain("glossary")
  await page.bringToFront()
  await mention(true)
  await open(made.session!)
  await mention(true)
  await other.close()
  await reset(request)
})

test("a scope holds its skill folder, where core finds no nested skill; a flat skill's 쓰는 곳 names its file", async ({
  page,
  request,
}) => {
  const pack = path.join(state.skillsDir, "pack")
  const files = {
    [path.join(pack, "SKILL.md")]: skillMd("pack", "묶음 스킬"),
    [path.join(pack, "inner", "SKILL.md")]: skillMd("inner", "묶음 안의 스킬"),
    [path.join(state.skillsDir, "flat-one.md")]: skillMd("flat-one", "파일 하나인 스킬"),
    [path.join(state.skillsDir, "flat-two.md")]: skillMd("flat-two", "파일 하나인 다른 스킬"),
  }
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  try {
    const all = ["pack", "flat-one", "flat-two"]
    for (const directory of [state.project, B])
      await expect.poll(() => listed(request, directory)).toEqual(expect.arrayContaining(all))
    // Since upstream v2.2 (#55597) a folder with a SKILL.md is one skill and core searches nothing inside it.
    for (const directory of [state.project, B]) expect(await listed(request, directory)).not.toContain("inner")
    await rpc(request, "skillset.switch", { changes: [], scopes: [{ folder: pack, directory: state.project }] })
    await expect.poll(() => listed(request, B)).not.toContain("pack")
    expect(await listed(request, state.project)).toContain("pack")
    // A flat skill's `쓰는 곳` keeps that file in A; the other flat skill of the folder stays everywhere.
    await skillsPage(page)
    await expect(allRow(page, "inner")).toHaveCount(0)
    const where = allRow(page, "flat-one").getByTestId("settings-skills-where")
    await where.selectOption("1")
    await expect(page.getByText(`flat-one 스킬을 ${base(state.project)} 프로젝트에서만 써요.`)).toBeVisible()
    expect(await scopes(request)).toEqual([
      { folder: pack, directory: state.project },
      { folder: path.join(state.skillsDir, "flat-one.md"), directory: state.project },
    ])
    await expect.poll(() => listed(request, B)).not.toContain("flat-one")
    expect(await listed(request, B)).toEqual(expect.arrayContaining(["flat-two", "glossary", "translate"]))
    const own = page.getByTestId("settings-skills-own-group")
    for (const id of ["pack", "flat-one"])
      await expect(
        own.locator(`[data-testid=settings-skills-row][data-skill="${id}"]`).getByTestId("settings-skills-scope-tag"),
      ).toHaveText("이 프로젝트만")
  } finally {
    await reset(request)
    fs.rmSync(pack, { recursive: true, force: true })
    for (const name of ["flat-one.md", "flat-two.md"]) fs.rmSync(path.join(state.skillsDir, name), { force: true })
  }
  await expect.poll(() => listed(request, state.project)).not.toContain("pack")
})

test("이 프로젝트만 with 바꾸기 keeps the replacing copy in this project; the toast says so", async ({
  page,
  request,
}) => {
  // Another release-notes with other content, in Codex account 01's home (no project loads it).
  const second = path.join(state.home, "control-center", "profiles", "01", "codex", "skills", "release-notes")
  fs.mkdirSync(second, { recursive: true })
  fs.writeFileSync(path.join(second, "SKILL.md"), skillMd("release-notes", "릴리스 노트를 다른 방식으로 씁니다"))
  const folder = path.join(state.skillsDir, "release-notes")
  const view = page.getByTestId("settings-skills-import").getByTestId("skills-import")
  const target = view.getByTestId("skills-import-target")
  const rows = view.locator('[data-testid=skills-import-row][data-skill="release-notes"]')
  try {
    await warm(request)
    // For B only.
    await page.goto("/settings/skills")
    await pick(page, "skills-project", B)
    await expect(target).toBeVisible({ timeout: 60_000 })
    await target.selectOption("here")
    await rows.filter({ hasText: "commit log" }).getByTestId("skills-import-use").click()
    await expect(page.getByText(`${base(B)} 프로젝트에서만 쓰게 가져왔어요: release-notes`)).toBeVisible()
    expect(await scopes(request)).toEqual([{ folder, directory: B }])
    // In A the other copy asks for another name or `바꾸기`; this project only. Asking moves no place: B's copy keeps
    // its scope throughout (before, the refused copy placed it in A until the refusal put it back).
    await pick(page, "skills-project", state.project)
    await target.selectOption("here")
    const row = rows.filter({ hasText: "다른 방식" })
    const switches: string[] = []
    const onRequest = (sent: { url(): string; postData(): string | null }) => {
      if (sent.url().includes("/own.accounts/skillset.switch")) switches.push(sent.postData() ?? "")
    }
    page.on("request", onRequest)
    await row.getByTestId("skills-import-use").click()
    await expect(row.getByTestId("skills-import-replace")).toBeVisible()
    page.off("request", onRequest)
    expect(switches).toEqual([])
    expect(await scopes(request)).toEqual([{ folder, directory: B }])
    await row.getByTestId("skills-import-replace").click()
    await expect.poll(() => scopes(request)).toEqual([{ folder, directory: state.project }])
    await expect(page.getByText(`${base(state.project)} 프로젝트에서만 쓰게 바꿨어요: release-notes`)).toBeVisible()
    await expect.poll(() => listed(request, state.project)).toContain("release-notes")
    await expect.poll(() => listed(request, B)).not.toContain("release-notes")
    await shot(page, "sg-9-replace-here")
  } finally {
    fs.rmSync(second, { recursive: true, force: true })
    await removeCopy(request)
  }
})

test("a scope a deleted folder left: 모든 프로젝트 clears it; the page lists such scopes with 설정 지우기", async ({
  page,
  request,
}) => {
  const folder = path.join(state.skillsDir, "release-notes")
  const view = page.getByTestId("settings-skills-import").getByTestId("skills-import")
  const target = view.getByTestId("skills-import-target")
  try {
    await warm(request)
    // The copy's folder was deleted by hand while it was kept in A.
    expect(fs.existsSync(folder)).toBe(false)
    await rpc(request, "skillset.switch", { changes: [], scopes: [{ folder, directory: state.project }] })
    await skillsPage(page)
    await expect(target).toBeVisible({ timeout: 60_000 })
    await expect(target).toHaveValue("all")
    await view
      .locator('[data-testid=skills-import-row][data-skill="release-notes"]')
      .filter({ hasText: "commit log" })
      .getByTestId("skills-import-use")
      .click()
    // A copy for every project clears it, so B lists the copy too.
    await expect.poll(() => scopes(request)).toEqual([])
    await expect(page.getByText("모든 프로젝트에서 쓰게 가져왔어요: release-notes")).toBeVisible()
    for (const directory of [state.project, B])
      await expect.poll(() => listed(request, directory)).toContain("release-notes")

    // A scope of no skill is listed with `설정 지우기`, which has `되돌리기`.
    const gone = path.join(state.skillsDir, "gone-skill")
    await rpc(request, "skillset.switch", { changes: [], scopes: [{ folder: gone, directory: B }] })
    const orphan = page.getByTestId("settings-skills-orphan")
    await expect(orphan).toContainText("이 폴더에는 지금 스킬이 없어요.")
    await expect(orphan).toContainText(`${base(B)} 프로젝트만`)
    await expect(orphan).toContainText(gone)
    await orphan.scrollIntoViewIfNeeded()
    await shot(page, "sg-10-orphan")
    await orphan.getByTestId("settings-skills-orphan-clear").click()
    const toast = page.getByTestId("toast").filter({ hasText: "남아 있던 쓰는 곳 설정을 지웠어요." })
    await expect(toast).toBeVisible()
    await expect(orphan).toHaveCount(0)
    expect(await scopes(request)).toEqual([])
    await toast.getByRole("button", { name: "되돌리기" }).click()
    await expect.poll(() => scopes(request)).toEqual([{ folder: gone, directory: B }])
    await expect(orphan).toHaveCount(1)
  } finally {
    await removeCopy(request)
  }
})

test("MCP: the global switch, then a project's tags and 되돌리기 in the Ctrl+; dialog", async ({ page, request }) => {
  const saved = (await rpc(request, "mcp.save", {
    name: "fake-everywhere",
    scope: { type: "global" },
    transport: { type: "local", command: state.bun, args: [state.script, "lookup"], env: [] },
  })) as { servers: { id: string; name: string }[] }
  const id = saved.servers.find((server) => server.name === "fake-everywhere")!.id
  await page.goto("/settings/mcp")
  await pick(page, "mcp-project", state.project)
  const global = page.getByTestId("mcp-global").locator('[data-testid=mcp-global-row][data-name="fake-everywhere"]')
  await expect(global).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("mcp-project-note")).toHaveText(
    "서버는 프로젝트마다 따로 실행돼요. 상태와 로그인은 프로젝트마다 달라요.",
  )
  // Added once, used everywhere.
  for (const directory of [state.project, B])
    await expect.poll(() => core(request, directory)).toMatchObject({ "fake-everywhere": "connected" })
  await global.getByTestId("mcp-global-toggle").click()
  await expect(page.getByText("fake-everywhere 서버를 모든 프로젝트에서 껐어요.")).toBeVisible()
  await expect(global.getByTestId("mcp-global-off")).toHaveText("모든 프로젝트에서 꺼 둠")
  await expect.poll(() => core(request, state.project)).toMatchObject({ "fake-everywhere": "disabled" })
  await expect.poll(() => core(request, B)).toMatchObject({ "fake-everywhere": "disabled" })
  await shot(page, "sg-6-mcp-global")

  await page.goto(`/srv/local/s/${state.session}`)
  await page.locator("#own-composer-input").waitFor()
  await page.keyboard.press("Control+Semicolon")
  const dialog = page.getByTestId("mcp-dialog")
  await expect(dialog.getByTestId("mcp-dialog-note")).toHaveText(
    "스위치는 이 프로젝트에만 적용돼요. 모든 프로젝트 설정은 [설정에서 관리]에서 해요.",
  )
  const row = dialog.locator('[data-testid=mcp-row][data-name="fake-everywhere"]')
  await expect(row.getByTestId("mcp-tag")).toHaveText("모든 프로젝트에서 꺼 둠")
  await expect(row.getByTestId("mcp-revert")).toHaveCount(0)
  await row.getByTestId("mcp-toggle").click()
  await expect(row.getByTestId("mcp-tag")).toHaveText("이 프로젝트에서만 켬")
  await expect(row).toHaveAttribute("data-status", "connected")
  expect(await core(request, B)).toMatchObject({ "fake-everywhere": "disabled" })
  await shot(page, "sg-7-mcp-dialog")
  await row.getByTestId("mcp-revert").click()
  await expect(row.getByTestId("mcp-tag")).toHaveText("모든 프로젝트에서 꺼 둠")
  await expect(row).toHaveAttribute("data-status", "disabled")
  await page.keyboard.press("Escape")
  await rpc(request, "mcp.remove", { id })
})
