// 설정 > 스킬 and MCP 서버 end to end (SM 2026-10-24; 03 §5.7, §18.14, §19.6.1), on backend.ts's server:
// - the settings list has both pages in 에이전트, right after 승인·권한;
// - MCP 서버: `＋ 서버 추가…` with the e2e kit's fake stdio server (a value the server requires, as a password field),
//   `연결 시험` lists its tools before saving; saved, core runs it (연결됨), the row says where it comes from and names
//   the value by its hint only; the row's own test keeps the tools line; the switch turns it off and on and stays so
//   after a reload (own.accounts keeps it per project); `고치기…` keeps the stored value when its field stays empty;
//   `지우기…` removes it from core and the vault; the value never shows on screen, in own's file or in an answer;
// - `다른 도구에서 가져오기…`: Codex's and Claude Code's servers by name, values by name only (a key in an address
//   as `••••`), the same server in both tools one row (`값이 달라요` with a choice of whose values), the old SSE one not
//   importable, a name a config file's server has warned about; imported, both run and say where they came from, and
//   a second look marks them `이미 있음`; a config file's value in an argument shows as `••••`;
// - `찾아서 설치…`: the fake MCP Registry's servers with publisher, version, the command that would run and the values
//   they ask for; an entry fills the add form (nothing saved before 저장), `{workspace}` must be filled, then it runs;
//   hostile entries (very long names, links, values) wrap inside the dialog and the form at every width (SM-22);
// - the Ctrl+; dialog with no server offers `＋ 서버 추가…` and `다른 도구에서 가져오기…`;
// - the palette's `MCP 서버 추가…` opens the form, `스킬 가져오기…` the skills page;
// - 스킬: the skills core loads, the import view with the fake Codex skill, `이 앱에서 쓰기` copies it (가져옴 group),
//   `지우기…` removes the copy, the original stays;
// - a phone-wide window fits both pages.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

const TMP = process.env.OWN_WEB_TOOLS_E2E_TMP ?? ""
const state = JSON.parse(fs.readFileSync(path.join(TMP, "backend.json"), "utf8")) as {
  readonly control: string
  readonly ownHome: string
  readonly project: string
  readonly session: string
  readonly bun: string
  readonly script: string
  readonly tokens: { readonly codex: string; readonly claude: string; readonly path: string }
  readonly codexConfig: string
  readonly configFile: string
  readonly registry: string
}
/** The value the added server requires (a fake): it must never come back to a page, a file or an answer. */
const TOKEN = "fake-e2e-mcp-token-0000-Qw7e"
/** A value a config file's server has in an argument (a fake). */
const CONFIG_KEY = "fake-config-key-0000-Ab9z"
/** Screenshots for a look at the pages (not compared): `<tmp>/shots`. */
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

/** Core's MCP servers in the project (`GET /api/mcp`): name → status. */
async function core(request: APIRequestContext) {
  const response = await request.get("/api/mcp", { params: { "location[directory]": state.project } })
  const body = (await response.json()) as { data: { name: string; status: { status: string } }[] }
  return Object.fromEntries(body.data.map((item) => [item.name, item.status.status]))
}

/** Removes every server own added (each test starts from none). */
async function clean(request: APIRequestContext) {
  const view = (await rpc(request, "mcp.list", {})) as { servers: { id: string }[] }
  for (const server of view.servers) await rpc(request, "mcp.remove", { id: server.id })
}

const row = (page: Page, name: string) => page.locator(`[data-testid=mcp-row][data-name="${name}"]`)

test.describe.configure({ mode: "serial" })

test("both pages sit in 에이전트 after 승인·권한", async ({ page }) => {
  await page.goto("/settings")
  const group = page.getByTestId("settings-group-agent")
  await expect(group.locator(".own-settings-link")).toHaveText([
    /에이전트 방식/,
    /승인·권한/,
    /스킬/,
    /MCP 서버/,
    /팀 모드/,
    /셸·터미널/,
    /컴퓨터 사용/,
    // 내 브라우저 사용 (BRW, 4395e5d82d).
    /내 브라우저 사용/,
  ])
  await expect(group.getByTestId("settings-nav-mcp")).toHaveAttribute("title", "외부 도구 서버 추가·가져오기·켜고 끄기")
  await group.getByTestId("settings-nav-skills").click()
  await expect(page).toHaveURL(/\/settings\/skills$/)
  await expect(page.getByTestId("settings-skills")).toBeVisible()
})

test("MCP: add a command server, see its tools, switch it off and on (kept), edit it, remove it", async ({
  page,
  request,
}) => {
  await clean(request)
  await page.goto("/settings/mcp")
  const settings = page.getByTestId("settings-mcp")
  await expect(settings.getByTestId("mcp-project").locator("option:checked")).toContainText(state.project)
  // SG: the switch is kept on this PC, so no restart note; the project section says servers run per project.
  await expect(settings.getByTestId("mcp-keeps")).toHaveCount(0)
  await expect(settings.getByTestId("mcp-project-note")).toContainText("서버는 프로젝트마다 따로 실행돼요")
  await expect(settings.getByTestId("mcp-empty")).toContainText("이 프로젝트에 MCP 서버가 없어요.")
  await settings.getByTestId("mcp-add").click()

  const editor = page.getByTestId("mcp-editor")
  await editor.getByTestId("mcp-editor-name").fill("fake-files")
  await editor.getByTestId("mcp-editor-command").fill(state.bun)
  await editor.getByTestId("mcp-editor-args").fill([state.script, "lookup", "summarize", "search"].join("\n"))
  for (const [name, value] of [
    ["FAKE_TOKEN", TOKEN],
    ["FAKE_MCP_REQUIRE", "FAKE_TOKEN"],
  ]) {
    await editor.getByTestId("mcp-editor-env-add").click()
    await editor.getByTestId("mcp-editor-env-name").last().fill(name!)
    await editor.getByTestId("mcp-editor-env-value").last().fill(value!)
  }
  await expect(editor.getByTestId("mcp-editor-env-value").first()).toHaveAttribute("type", "password")
  await editor.getByTestId("mcp-editor-test").click()
  const check = editor.getByTestId("mcp-check")
  await expect(check).toHaveAttribute("data-ok", "true")
  await expect(check).toContainText("도구 3개: lookup, summarize, search")
  await shot(page, "1-editor-tested")
  await editor.getByTestId("mcp-editor-save").click()
  await expect(editor).toBeHidden()
  await expect(page.getByText("fake-files 서버를 저장했어요.")).toBeVisible()

  // Core runs it in the project; the row says where it comes from and names the value by its hint.
  const fake = row(page, "fake-files")
  await expect(fake).toHaveAttribute("data-status", "connected")
  await expect.poll(() => core(request)).toMatchObject({ "fake-files": "connected" })
  await expect(fake.getByTestId("mcp-source")).toContainText("이 앱에서 더함 · 모든 프로젝트")
  await expect(fake.getByTestId("mcp-values")).toHaveText("환경 변수: FAKE_TOKEN …Qw7e, FAKE_MCP_REQUIRE")
  await fake.getByTestId("mcp-test").click()
  await expect(fake.getByTestId("mcp-check")).toHaveAttribute("data-tools", "3")
  await shot(page, "2-list")
  expect(await page.content()).not.toContain(TOKEN)
  expect(fs.readFileSync(path.join(state.ownHome, "mcp.json"), "utf8")).not.toContain(TOKEN)
  expect(JSON.stringify(await rpc(request, "mcp.list", {}))).not.toContain(TOKEN)

  // Off and on: kept per project, so a reload (or a restart) shows it the same.
  await fake.getByTestId("mcp-toggle").click()
  await expect(fake).toHaveAttribute("data-status", "disabled")
  await expect.poll(() => core(request)).toMatchObject({ "fake-files": "disabled" })
  const view = (await rpc(request, "mcp.list", {})) as { overrides: unknown[] }
  expect(view.overrides).toEqual([{ directory: state.project, name: "fake-files", enabled: false }])
  await page.reload()
  await expect(row(page, "fake-files")).toHaveAttribute("data-status", "disabled")
  await row(page, "fake-files").getByTestId("mcp-toggle").click()
  await expect(row(page, "fake-files")).toHaveAttribute("data-status", "connected")

  // An edit that leaves the value field empty keeps the stored value: the server still starts with it.
  await row(page, "fake-files").getByTestId("mcp-edit").click()
  await expect(editor.getByTestId("mcp-editor-env-value").first()).toHaveAttribute(
    "placeholder",
    "저장됨 …Qw7e · 비우면 그대로",
  )
  await editor.getByTestId("mcp-editor-args").fill([state.script, "lookup"].join("\n"))
  await editor.getByTestId("mcp-editor-save").click()
  await expect(editor).toBeHidden()
  await row(page, "fake-files").getByTestId("mcp-test").click()
  await expect(row(page, "fake-files").getByTestId("mcp-check")).toHaveAttribute("data-tools", "1")
  await expect(row(page, "fake-files")).toHaveAttribute("data-status", "connected")

  // Remove: gone from core, the list and the vault.
  await row(page, "fake-files").getByTestId("mcp-remove").click()
  await page.getByTestId("mcp-remove-confirm").click()
  await expect(row(page, "fake-files")).toHaveCount(0)
  await expect.poll(() => core(request)).not.toHaveProperty("fake-files")
  expect(((await rpc(request, "mcp.list", {})) as { servers: unknown[] }).servers).toEqual([])
})

test("MCP: import Codex's and Claude Code's servers; values by name only", async ({ page, request }) => {
  await clean(request)
  // A config file server with a name the import uses (off, so nothing runs it), in the server's config file; core's
  // file watcher reloads it.
  const original = fs.readFileSync(state.configFile, "utf8")
  const config = JSON.parse(original) as { mcp?: { servers?: Record<string, unknown> } }
  const notes = { type: "local", command: [state.bun, state.script, "--api-key", CONFIG_KEY], disabled: true }
  fs.writeFileSync(
    state.configFile,
    JSON.stringify({ ...config, mcp: { ...config.mcp, servers: { ...config.mcp?.servers, "claude-notes": notes } } }),
  )
  try {
    await expect.poll(() => core(request), { timeout: 60_000 }).toMatchObject({ "claude-notes": "disabled" })
    await page.goto("/settings/mcp")
    const settings = page.getByTestId("settings-mcp")
    await expect(row(page, "claude-notes").getByTestId("mcp-source")).toContainText("설정 파일")
    // A config file's value in an argument shows as •••• (and nowhere on the page).
    await expect(row(page, "claude-notes").getByTestId("mcp-definition")).toContainText("--api-key ••••")
    expect(await page.content()).not.toContain(CONFIG_KEY)
    await settings.getByTestId("mcp-import-open").click()
    const dialog = page.getByTestId("mcp-import")
    await expect(dialog.getByTestId("mcp-import-group")).toHaveCount(2)
    const codex = dialog.locator('[data-testid=mcp-import-row][data-name="codex-files"]')
    await expect(codex).toContainText(`값 1개는 키 저장소에 넣어요: FILES_TOKEN …${state.tokens.codex.slice(-4)}`)
    await expect(codex).toContainText("시간 제한처럼 이 앱이 쓰지 않는 설정은 빠져요")
    await expect(codex.getByTestId("mcp-import-pick")).toBeChecked()
    // The same server in Claude Code is the same row, not a second one; its token there is another, so the row says so
    // and offers whose values to take (by their hints).
    await expect(codex.getByTestId("mcp-import-also")).toHaveText("같은 서버가 있는 곳: Claude Code(사용자) (codex-twin)")
    await expect(dialog.locator('[data-testid=mcp-import-row][data-name="codex-twin"]')).toHaveCount(0)
    await expect(codex.getByTestId("mcp-import-differs")).toHaveText("값이 달라요")
    const place = codex.getByTestId("mcp-import-place")
    await expect(place.locator("option")).toHaveText([
      `Codex · FILES_TOKEN …${state.tokens.codex.slice(-4)}`,
      "Claude Code(사용자) (codex-twin) · FILES_TOKEN …0Xx7",
    ])
    await place.selectOption("1")
    await expect(codex.getByTestId("mcp-import-values")).toContainText("FILES_TOKEN …0Xx7")
    await place.selectOption("0")
    const sse = dialog.locator('[data-testid=mcp-import-row][data-name="old-sse"]')
    await expect(sse).toContainText("옛 SSE 방식이라 가져올 수 없어요")
    await expect(sse.getByTestId("mcp-import-pick")).toBeDisabled()
    // A key in an address is shown as ••••.
    const keyed = dialog.locator('[data-testid=mcp-import-row][data-name="api-keyed"]')
    await expect(keyed.getByTestId("mcp-import-summary")).toHaveText("http://127.0.0.1:9/api/••••/mcp")
    await keyed.getByTestId("mcp-import-pick").uncheck()
    // claude-notes would replace the config file's server of that name.
    const clash = dialog.locator('[data-testid=mcp-import-row][data-name="claude-notes"]')
    await expect(clash.getByTestId("mcp-import-clash")).toContainText("설정 파일에도 claude-notes 서버가 있어요")
    const text = (await dialog.textContent()) ?? ""
    for (const value of Object.values(state.tokens)) expect(text).not.toContain(value)
    await shot(page, "3-import")
    await expect(dialog.getByTestId("mcp-import-apply")).toHaveText("고른 2개 가져오기")
    await dialog.getByTestId("mcp-import-apply").click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText("MCP 서버 2개를 가져왔어요.")).toBeVisible()
    for (const name of ["codex-files", "claude-notes"])
      await expect(row(page, name)).toHaveAttribute("data-status", "connected")
    await expect(row(page, "codex-files").getByTestId("mcp-source")).toContainText("Codex에서 가져옴")
    await expect(row(page, "claude-notes").getByTestId("mcp-source")).toContainText("Claude Code에서 가져옴")
    expect(fs.readFileSync(path.join(state.ownHome, "mcp.json"), "utf8")).not.toContain(state.tokens.codex)
    // The other tool's file is as it was.
    expect(fs.readFileSync(state.codexConfig, "utf8")).toContain(state.tokens.codex)
    // A second look: what this app has is `이미 있음` and not picked.
    await settings.getByTestId("mcp-import-open").click()
    for (const name of ["codex-files", "claude-notes"]) {
      const item = dialog.locator(`[data-testid=mcp-import-row][data-name="${name}"]`)
      await expect(item.getByTestId("mcp-import-imported")).toHaveText("이미 있음")
      await expect(item.getByTestId("mcp-import-pick")).not.toBeChecked()
    }
    await dialog.getByTestId("dialog-close").click()
  } finally {
    fs.writeFileSync(state.configFile, original)
    await clean(request)
    await expect.poll(() => core(request), { timeout: 60_000 }).not.toHaveProperty("claude-notes")
  }
})

test("MCP: 찾아서 설치 fills the add form from the MCP Registry; it runs once saved", async ({ page, request }) => {
  await clean(request)
  await page.goto("/settings/mcp")
  await page.getByTestId("settings-mcp").getByTestId("mcp-registry-find").click()
  const dialog = page.getByTestId("mcp-registry")
  await expect(dialog.getByTestId("mcp-registry-trust")).toContainText("다른 사람이 만든 프로그램")
  await expect(dialog.getByTestId("mcp-registry-row")).toHaveCount(3)
  await dialog.getByTestId("mcp-registry-search").fill("notes")
  await dialog.getByTestId("mcp-registry-go").click()
  await expect(dialog.getByTestId("mcp-registry-row")).toHaveCount(2)
  const notes = dialog.locator('[data-testid=mcp-registry-row][data-name="io.github.demo-org/notes"]')
  await expect(notes.getByTestId("mcp-registry-meta")).toHaveText("게시자 io.github.demo-org버전 2.1.0")
  await expect(dialog.getByTestId("mcp-registry-source")).toContainText("127.0.0.1")
  await notes.getByTestId("mcp-registry-open").click()
  const details = notes.getByTestId("mcp-registry-details")
  await expect(details.getByTestId("mcp-registry-command")).toHaveText("npx -y @demo-org/notes-mcp@2.1.0 {workspace}")
  await expect(details.getByTestId("mcp-registry-values")).toContainText("NOTES_TOKEN필수비밀 값")
  await expect(details.getByTestId("mcp-registry-values")).toContainText("기본값 eu")
  await shot(page, "6-registry")
  // The remote way: the fake's own address with {workspace} to fill.
  await details.getByTestId("mcp-registry-option").nth(2).check()
  await expect(details.getByTestId("mcp-registry-command")).toHaveText(`${state.registry}/{workspace}/mcp`)
  await details.getByTestId("mcp-registry-use").click()
  const editor = page.getByTestId("mcp-editor")
  await expect(editor.getByTestId("mcp-editor-registry")).toContainText("MCP 레지스트리의 io.github.demo-org/notes 2.1.0")
  await expect(editor.getByTestId("mcp-editor-name")).toHaveValue("notes")
  await expect(editor.getByTestId("mcp-editor-url")).toHaveValue(`${state.registry}/{workspace}/mcp`)
  // Nothing is saved before 저장.
  expect(((await rpc(request, "mcp.list", {})) as { servers: unknown[] }).servers).toEqual([])
  await editor.getByTestId("mcp-editor-save").click()
  await expect(editor.getByTestId("mcp-editor-problems")).toContainText("workspace")
  await editor.getByTestId("mcp-editor-url").fill(`${state.registry}/demo/mcp`)
  await editor.getByTestId("mcp-editor-save").click()
  await expect(editor).toBeHidden()
  const added = row(page, "notes")
  await expect(added).toHaveAttribute("data-status", "connected")
  await expect(added.getByTestId("mcp-source")).toContainText("MCP 레지스트리에서 찾음")
  await expect(added.getByTestId("mcp-registry-ref")).toHaveText("io.github.demo-org/notes 2.1.0")
  await added.getByTestId("mcp-test").click()
  await expect(added.getByTestId("mcp-check")).toContainText("도구 2개: find_note, write_note")
  await clean(request)
})

test("MCP: hostile registry entries wrap inside the dialog and the filled form at every width", async ({ page }) => {
  const long = (n: number, c: string) => c.repeat(n)
  const entries = [
    {
      name: `io.github.${long(3000, "p")}/evil`,
      title: `<img src=x onerror="window.__own=1">${long(400, "T")}`,
      description: `<script>window.__own=2</script>${long(500, "D")}`,
      version: "",
      publisher: `io.github.${long(3000, "p")}`,
      repository: `https://example.test/${long(1900, "r")}`,
      status: "active",
      suggested: "evil",
      options: [
        {
          type: "package",
          registryType: "npm",
          identifier: `@x/${long(290, "i")}`,
          command: "npx",
          args: ["-y", `@x/${long(290, "i")}`, `--${long(500, "n")}`, long(900, "v")],
          env: [
            { name: '<img src=x onerror="window.__own=3">', required: true, secret: false, value: long(2000, "w") },
            { name: long(120, "E"), required: true, secret: true, description: long(500, "d"), template: long(500, "t") },
          ],
          fill: [long(90, "f")],
        },
      ],
    },
  ]
  // The service's answer with its entries replaced, as a registry the service did not clip could give them.
  await page.route(/[/]api[/]rpc[/]own[.]accounts[/]mcp[.]registry[.]search/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { output: { entries: unknown[]; nextCursor?: string } }
    await route.fulfill({ response, json: { ...body, output: { ...body.output, entries } } })
  })
  const wide = (testid: string) =>
    page.evaluate((id) => {
      const root = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
      if (!root) return ["no dialog"]
      const edge = Math.min(root.getBoundingClientRect().right, window.innerWidth)
      return [
        ...[...root.querySelectorAll<HTMLElement>("*")]
          .filter((element) => element.getBoundingClientRect().right > edge + 1)
          .map((element) => `${element.tagName.toLowerCase()}.${element.getAttribute("data-testid") ?? element.className}`),
        ...(root.scrollWidth > root.clientWidth + 1 ? [`scrollWidth ${root.scrollWidth} in ${root.clientWidth}`] : []),
      ].slice(0, 10)
    }, testid)
  for (const width of [1440, 820, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/settings/mcp")
    await page.getByTestId("settings-mcp").getByTestId("mcp-registry-find").click()
    const dialog = page.getByTestId("mcp-registry")
    const entry = dialog.getByTestId("mcp-registry-row").first()
    await entry.getByTestId("mcp-registry-open").click()
    await expect(entry.getByTestId("mcp-registry-details")).toBeVisible()
    // An entry that gives no version shows none.
    await expect(entry.getByTestId("mcp-registry-meta")).not.toContainText("버전")
    expect(await wide("mcp-registry"), `${width} registry`).toEqual([])
    await shot(page, `7-hostile-registry-${width}`)
    await entry.getByTestId("mcp-registry-use").click()
    const editor = page.getByTestId("mcp-editor")
    await expect(editor.getByTestId("mcp-editor-registry")).toBeVisible()
    expect(await wide("mcp-editor"), `${width} editor`).toEqual([])
    await shot(page, `7-hostile-editor-${width}`)
    await editor.getByTestId("dialog-close").click()
  }
  expect(await page.evaluate(() => (window as unknown as { __own?: number }).__own ?? null)).toBeNull()
})

test("the Ctrl+; dialog with no server offers to add or import one", async ({ page, request }) => {
  await clean(request)
  // SM-26: opened before the page knows its session's folder (the session and project lists held back, as on a slow
  // first load), the dialog waits for it instead of saying no project is open, then shows that project.
  const gate = { held: Promise.withResolvers<void>() }
  await page.route(/\/api\/(?:session|project)(?:[/?]|$)/, async (route) => {
    if (route.request().method() === "GET") await gate.held.promise
    // A request of a page that navigated away meanwhile is gone.
    await route.continue().catch(() => undefined)
  })
  for (const [button, opens] of [
    ["mcp-empty-add", "mcp-editor"],
    ["mcp-empty-import", "mcp-import"],
  ] as const) {
    gate.held = Promise.withResolvers<void>()
    await page.goto(`/srv/local/s/${state.session}`)
    await page.locator("#own-composer-input").waitFor()
    await page.keyboard.press("Control+Semicolon")
    const dialog = page.getByTestId("mcp-dialog")
    await expect(dialog.getByTestId("mcp-list")).toBeVisible()
    await expect(dialog.getByText("열린 프로젝트가 없어요")).toHaveCount(0)
    gate.held.resolve()
    await expect(dialog.getByTestId("mcp-empty")).toContainText("이 프로젝트에 MCP 서버가 없어요.")
    await expect(dialog.getByTestId("mcp-manage")).toBeVisible()
    await dialog.getByTestId(button).click()
    await expect(page).toHaveURL(/\/settings\/mcp$/)
    await expect(page.getByTestId(opens)).toBeVisible()
    await page.getByTestId(opens).getByTestId("dialog-close").click()
  }
})

test("palette: `MCP 서버 추가…` opens the form, `스킬 가져오기…` the skills page", async ({ page }) => {
  await page.goto(`/srv/local/s/${state.session}`)
  await page.locator("#own-composer-input").waitFor()
  await page.keyboard.press("Control+KeyK")
  await expect(page.getByTestId("palette-input")).toBeFocused()
  await page.keyboard.type("MCP 서버 추가")
  await expect(page.getByRole("option", { name: /MCP 서버 추가/ }).first()).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/settings\/mcp$/)
  await expect(page.getByTestId("mcp-editor")).toBeVisible()
  await page.getByTestId("mcp-editor").getByTestId("dialog-close").click()

  await page.goto(`/srv/local/s/${state.session}`)
  await page.locator("#own-composer-input").waitFor()
  await page.keyboard.press("Control+KeyK")
  await expect(page.getByTestId("palette-input")).toBeFocused()
  await page.keyboard.type("스킬 가져오기")
  await expect(page.getByRole("option", { name: /스킬 가져오기/ }).first()).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/settings\/skills$/)
  await expect(page.getByTestId("settings-skills-import")).toBeInViewport()
})

test("스킬: the skills in use and the import view; import a Codex skill, then remove the copy", async ({ page }) => {
  await page.goto("/settings/skills")
  const skills = page.getByTestId("settings-skills")
  await expect(skills.getByTestId("skills-project").locator("option:checked")).toContainText(state.project)
  await expect(skills.getByTestId("settings-skills-group").first()).toBeVisible()
  const found = skills.getByTestId("skills-import-row").filter({ hasText: "release-notes" })
  await expect(found).toBeVisible()
  await shot(page, "4-skills")
  await found.getByTestId("skills-import-use").click()
  await expect(page.getByText("모든 프로젝트에서 쓰게 가져왔어요: release-notes")).toBeVisible()
  const copy = skills
    .getByTestId("settings-skills-all")
    .locator('[data-testid=settings-skills-row][data-skill="release-notes"]')
  await expect(copy).toHaveAttribute("data-group", "imported")
  await copy.getByTestId("settings-skills-remove").click()
  await page.getByTestId("settings-skills-remove-confirm").click()
  await expect(page.getByText("release-notes 스킬을 지웠어요.")).toBeVisible()
  await expect(copy).toHaveCount(0)
  // The source skill is still there to import again.
  await expect(found.getByTestId("skills-import-use")).toBeVisible()
})

test("a phone-wide window fits both pages", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  for (const section of ["mcp", "skills"]) {
    await page.goto(`/settings/${section}`)
    await expect(page.getByTestId(`settings-${section}`)).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, section).toBeLessThanOrEqual(0)
    await shot(page, `5-narrow-${section}`)
  }
})
