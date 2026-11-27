// own-web multi-server over own-remote's fake-SSH harness (03 §4.3, §4.4, §18.16; 04 §12, §17; RG13 on the web
// fallback's dev path). One Edge context walks the whole flow in order: the sidebar groups from the host list, the
// add-host flow (host key fingerprint → trust → install plan → install → connected), the remote folder picker (home,
// junction → realpath), a session created and answered on the remote server at /srv/<hostId>/s/<id>, the token kept
// in tab memory only, review and terminal against the remote server, disconnect/reconnect with the route and draft
// kept, a reload, the password prompt owned by one tab while another shows "다른 창에서 인증 중", server tags in the
// usage table, and removing a host. Integrated with the credential broker and own-accounts remote mode: the remote
// session answers with a PC-only account leased per request, switches account on the remote server, lands in the PC's
// usage table, survives a drain and a restart; an older install is updated with drain. No real host, no ~/.ssh, no
// known_hosts: see backend.ts.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import {
  backend,
  FAKE_KEYS,
  providerRequests,
  remoteRequests,
  setLink,
  SLOW_MARK,
  storedText,
  type RemoteBackendState,
} from "./support"

test.describe.configure({ mode: "serial" })

/** Set by playwright.config.ts (default `<tmp>/own-web-e2e-remote-<hash>/shots`). */
const SHOTS = process.env.OWN_WEB_REMOTE_SHOTS!
const LOOPBACK = /^127\.0\.([1-9]\d{0,2})\.2$/
/**
 * Waits over the fake SSH host (backend.ts), sized for this PC under the user's load (2026-11-12, decisions US6-21): a
 * Git Bash process there took up to 6 s to start, and the inspect script with its three login shells 64-91 s.
 * `SSH_STEP`: one inspect or operation script. `CONNECT`: inspect, then ensure and the tunnel. `SERVICE_START`: a
 * connect that also boots the remote server from source (52-135 s by itself, inside ensure's window, which backend.ts
 * lengthens to 300 s). Each test's limit is the config's.
 */
const SSH_STEP = 240_000
const CONNECT = 300_000
const SERVICE_START = 420_000

let state: RemoteBackendState
let context: BrowserContext
let page: Page
const pageErrors: string[] = []
/** Server access tokens seen on requests to host endpoints (decoded from the Basic header). */
const tokens = new Set<string>()
const hostOrigins = new Set<string>()
let devbox = ""
let sessionPath = ""

async function shot(target: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

function hostGroup(target: Page, name: string) {
  return target
    .locator('[data-testid="host-group"]')
    .filter({ has: target.getByTestId("host-header").getByText(name, { exact: true }) })
}

function watch(target: Page) {
  target.on("pageerror", (error) => pageErrors.push(error.message))
  target.on("request", (request) => {
    const url = new URL(request.url())
    if (!LOOPBACK.test(url.hostname)) return
    hostOrigins.add(url.origin)
    const header = request.headers()["authorization"]
    if (header?.startsWith("Basic ")) tokens.add(atob(header.slice(6)).replace(/^opencode:/, ""))
  })
}

test.beforeAll(async ({ browser }) => {
  state = backend()
  context = await browser.newContext({ locale: "ko-KR", viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  watch(page)
})

test.afterAll(async () => {
  await context?.close()
})

test("sidebar: 이 PC above the local tree, a known host listed from the list alone", async () => {
  await page.goto("/")
  await expect(page.getByTestId("server-group-local")).toContainText("이 PC")
  await expect(page.getByTestId("session-list")).toContainText(state.localSession.title)
  const far = hostGroup(page, "farbox")
  await expect(far).toHaveAttribute("data-status", "disconnected")
  await expect(far.getByTestId("host-status")).toContainText("연결 끊김")
  await expect(far.getByTestId("host-symbol")).toHaveText("○")
  await expect(page.getByTestId("remote-add")).toHaveAccessibleName("원격 호스트 추가")
  await shot(page, "01-sidebar-groups")
})

test("add host: fingerprint shown unmasked with 취소 focused, trust, install plan, install, connected", async () => {
  await page.getByTestId("remote-add").click()
  const dialog = page.getByTestId("remote-add-dialog")
  await expect(dialog).toBeVisible()
  const alias = dialog.locator('[data-testid="remote-alias"][data-alias="devbox"]')
  await expect(alias).toBeVisible()
  await expect(dialog.locator('[data-testid="remote-alias"][data-alias="farbox"]')).toContainText("추가됨")
  await alias.click()
  await dialog.getByTestId("remote-add-check").click()

  // 04 §14.2 / §17.6: the host key question is a hostKey prompt, never a hidden password field.
  const prompt = page.getByTestId("remote-prompt")
  await expect(prompt.locator('[data-kind="hostKey"]')).toBeVisible({ timeout: SSH_STEP })
  await expect(prompt.getByTestId("prompt-fingerprint")).toHaveText(state.hosts.devbox!.fingerprint)
  await expect(prompt.getByTestId("prompt-raw")).toContainText("authenticity of host")
  await expect(prompt.getByTestId("prompt-key-type")).toContainText("ED25519")
  await expect(prompt.getByTestId("prompt-input")).toHaveCount(0)
  await expect(prompt.getByTestId("prompt-cancel")).toBeFocused()
  await shot(page, "02-host-key")
  await prompt.getByTestId("prompt-trust").click()
  await expect(prompt).toHaveCount(0)

  // 04 §17.3 step 3: the plan card before anything is written.
  const plan = dialog.getByTestId("remote-install-plan")
  await expect(plan).toBeVisible({ timeout: SSH_STEP })
  await expect(plan.getByTestId("remote-install-dir")).toContainText("관리자(root) 권한이 필요 없어요")
  await expect(plan.getByTestId("remote-install-dir")).toContainText("/own-open-code/app/2.0.18-own.9")
  await expect(plan.getByTestId("remote-install-upstream")).toContainText("opencode 설치는 건드리지 않아요")
  await shot(page, "03-install-plan")
  await plan.getByTestId("remote-install").click()

  await expect(dialog.getByTestId("remote-done")).toBeVisible({ timeout: SERVICE_START })
  // 04 §5.6: a new host reads the repository's instruction files only, and the card says what each state reads.
  const project = dialog.getByTestId("remote-project-config")
  await expect(project).toContainText("프로젝트 설정: 지시 파일만 (AGENTS.md)")
  await expect(project).toHaveAttribute("data-state", "instructions")
  await expect(project.locator("li")).toHaveCount(3)
  await expect(project.locator("li").nth(1)).toContainText("저장소의 코드는 실행되지 않아요")
  await shot(page, "04-connected")
  const group = hostGroup(page, "devbox")
  await expect(group).toHaveAttribute("data-status", "ready", { timeout: 60_000 })
  await expect(group.getByTestId("host-symbol")).toHaveText("●")
  devbox = (await group.getAttribute("data-host")) ?? ""
  expect(devbox).toMatch(/^h-[a-z0-9]{6,8}$/)
})

test("remote folder picker: home listing, a junction opens as its real path, new session on the host", async () => {
  await page.getByTestId("remote-add-dialog").getByTestId("remote-open-folder").click()
  const picker = page.getByTestId("remote-picker")
  await expect(picker).toBeVisible()
  await expect(picker.getByTestId("remote-picker-path")).toHaveValue(state.hosts.devbox!.posixHome)
  // Children of the remote home; `.local` is an ancestor of the control location (04 §12.4 relative paths).
  await expect(picker.locator('[data-testid="remote-picker-entry"][data-name="work"]')).toBeVisible()
  await expect(picker.locator('[data-testid="remote-picker-entry"][data-name=".local"]')).toBeVisible()
  // A junction to work/example-game, typed as a path.
  await picker.getByTestId("remote-picker-path").fill(`${state.hosts.devbox!.posixHome}/link-game`)
  await picker.getByTestId("remote-picker-path").press("Enter")
  await expect(picker.getByTestId("remote-picker-crumbs")).toContainText("link-game")
  await picker.getByTestId("remote-picker-choose").click()
  const confirm = picker.getByTestId("remote-picker-confirm")
  await expect(confirm.getByTestId("remote-picker-symlink")).toContainText("심볼릭 링크 대신 실제 경로로 열어요")
  await expect(confirm.getByTestId("remote-picker-confirm-path")).toContainText("example-game")
  await expect(confirm.getByTestId("remote-picker-git")).toHaveText(/^Git 저장소( · .+)?$/, { timeout: 30_000 })
  await shot(page, "05-remote-picker-realpath")
  await confirm.getByTestId("remote-picker-start").click()
  await expect(page).toHaveURL(new RegExp(`/srv/${devbox}/p/`))
  await expect(page.getByTestId("server-badge")).toHaveText("devbox")

  const composer = page.locator("#own-composer-input")
  await composer.fill("원격에서 안녕")
  await composer.press("Control+Enter")
  // The new session's "모델 @ 계정" is this PC's default, but the host lists this PC's accounts only once its mirror
  // arrived (held back 20 s after the broker connected here, as under load): the composer waits for it instead of
  // creating a session whose first prompt fails with `Model unavailable` (MR11-1).
  await expect(page.getByTestId("toast").filter({ hasText: "원격 호스트가 이 PC의 계정을 받는 중이에요" })).toBeVisible()
  // The box is read-only while it waits: nothing typed now is lost when the conversation opens (MR12-5).
  await expect(composer).toHaveJSProperty("readOnly", true)
  await expect(page).toHaveURL(new RegExp(`/srv/${devbox}/s/`), { timeout: 150_000 })
  await expect(composer).toHaveJSProperty("readOnly", false)
  // The answer names the account whose key reached the provider: Alpha, which exists on this PC only (04 §8).
  await expect(page.getByTestId("transcript").getByText("Alpha 계정으로 온 답").first()).toBeVisible({
    timeout: 90_000,
  })
  sessionPath = new URL(page.url()).pathname
  const sessionID = sessionPath.split("/").at(-1)!
  const rows = hostGroup(page, "devbox").getByTestId("host-session-list")
  await expect(rows.locator(`a[href="${sessionPath}"]`)).toBeVisible({ timeout: 30_000 })
  // The header badge names the host; its hover text is user@host:path (04 §12.5).
  await page.getByTestId("server-badge").hover()
  await expect(page.getByTestId("server-badge")).toHaveAttribute("title", /example-game/)
  expect(sessionID).toBeTruthy()
  await shot(page, "06-remote-session")
})

// 03 §5.1, 04 §17.4, 2.2.6-own.16: a folderless conversation on the host in the host's own folder, chosen on the
// new-conversation screen and remembered; the folder changed in the host's settings with `~/…`; `새 폴더` on the host.
test("new conversation on the host: the server choice, the host's folder from its settings, 새 폴더 in its picker", async () => {
  const other = await context.newPage()
  watch(other)
  await other.goto("/settings/remote")
  await other.getByTestId("remote-settings-host").filter({ hasText: "devbox" }).first().click()
  const panel = other.locator(`[data-testid="remote-host-panel"][data-host="${devbox}"]`)
  const folder = panel.getByTestId("settings-default-folder")
  await expect(folder.getByTestId("settings-default-folder-default")).toBeVisible()
  await folder.getByTestId("settings-folder-change").click()
  await folder.getByTestId("settings-folder-input").fill("~/chats-e2e")
  await folder.getByTestId("settings-folder-save").click()
  await expect(folder.getByTestId("settings-default-folder-path")).toContainText("chats-e2e")
  await expect(folder.getByTestId("settings-default-folder-default")).toHaveCount(0)
  await shot(other, "06a-host-folder")
  await other.close()

  await page.goto("/")
  const choice = page.getByTestId("server-select")
  await expect(choice).toContainText("이 PC")
  // The project select names this PC's folder; the host's once the host is chosen.
  const tail = page.getByTestId("project-select").getByTestId("path-tail")
  const ownFolder = (await tail.textContent()) ?? ""
  expect(ownFolder).toContain("Own OpenCode")
  await choice.click()
  const items = page.getByTestId("server-select-item")
  // 이 PC and every host of the sidebar (oldbox, farbox and devbox here).
  await expect(items).toHaveCount((await page.getByTestId("host-group").count()) + 1)
  await expect(items.first()).toContainText("이 PC")
  await expect(items.filter({ hasText: "devbox" })).toContainText("연결됨")
  await expect(items.filter({ hasText: "farbox" })).toContainText("연결 끊김")
  // Each server's own folder; a host that is not connected has not said which.
  await expect(items.first().getByTestId("path-tail")).toHaveText(ownFolder)
  await expect(items.filter({ hasText: "devbox" }).getByTestId("path-tail")).toContainText("chats-e2e")
  await expect(items.filter({ hasText: "farbox" }).getByTestId("path-tail")).toHaveCount(0)
  await shot(page, "06b-server-choice")
  await items.filter({ hasText: "devbox" }).click()
  await expect(page).toHaveURL(new RegExp(`/srv/${devbox}/new$`))
  await expect(page.getByTestId("server-select")).toContainText("devbox")
  await expect(page.getByTestId("project-select")).toHaveAttribute("data-folderless", "")
  await expect(tail).toContainText("chats-e2e")
  await expect(page.getByTestId("project-select")).toHaveAttribute("title", /chats-e2e/)
  await shot(page, "06b-host-folder")
  const composer = page.locator("#own-composer-input")
  await composer.fill("폴더 없이 원격에서 안녕")
  await composer.press("Control+Enter")
  await expect(page).toHaveURL(new RegExp(`/srv/${devbox}/s/`), { timeout: 150_000 })
  await expect(page.getByTestId("transcript").getByText("Alpha 계정으로 온 답").first()).toBeVisible({
    timeout: 90_000,
  })
  // The host's group shows it under `폴더 없는 대화`, the folder of the host's settings.
  const group = hostGroup(page, "devbox").locator("[data-default-folder]")
  await expect(group).toBeVisible({ timeout: 30_000 })
  await expect(group).toHaveAttribute("title", /chats-e2e/)
  // Remembered: 새 대화 opens the host's screen again; 이 PC clears it.
  await page.getByTestId("sidebar-new-session").click()
  await expect(page).toHaveURL(new RegExp(`/srv/${devbox}/new$`))
  await page.getByTestId("server-select").click()
  await page.getByTestId("server-select-item").filter({ hasText: "이 PC" }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(tail).toHaveText(ownFolder)
  await page.getByTestId("sidebar-new-session").click()
  await expect(page).toHaveURL(/\/$/)

  // 새 폴더 in the host's picker: made on the host and opened on the confirmation card.
  await hostGroup(page, "devbox").getByTestId("host-menu").click()
  await page.getByTestId("host-open-folder").click()
  const picker = page.getByTestId("remote-picker")
  await expect(picker.locator('[data-testid="remote-picker-entry"][data-name="work"]')).toBeVisible()
  await picker.getByTestId("remote-picker-new-folder").click()
  await picker.getByTestId("remote-picker-new-folder-name").fill("새 폴더 e2e")
  await picker.getByTestId("remote-picker-new-folder-make").click()
  await expect(picker.getByTestId("remote-picker-confirm-path")).toContainText("새 폴더 e2e", { timeout: 30_000 })
  await picker.getByTestId("remote-picker-back").click()
  await picker.getByTestId("remote-picker-path").fill(`${state.hosts.devbox!.posixHome}`)
  await picker.getByTestId("remote-picker-path").press("Enter")
  await expect(picker.locator('[data-testid="remote-picker-entry"][data-name="새 폴더 e2e"]')).toBeVisible()
  // The same name again: refused, with the way to open the one that is there.
  await picker.getByTestId("remote-picker-new-folder").click()
  await picker.getByTestId("remote-picker-new-folder-name").fill("새 폴더 e2e")
  await picker.getByTestId("remote-picker-new-folder-make").click()
  await expect(picker.getByTestId("remote-picker-new-folder-error")).toContainText("같은 이름이 이미 있어요")
  await shot(page, "06c-new-folder-exists")
  await picker.getByTestId("remote-picker-new-folder-open-existing").click()
  await expect(picker.getByTestId("remote-picker-crumbs")).toContainText("새 폴더 e2e")
  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)
  // The tests after this one continue in the host conversation the picker test opened.
  await page.goto(sessionPath)
  await expect(page.getByTestId("running-on")).toContainText("@ Alpha", { timeout: 60_000 })
})

test("the server token stays in tab memory; remote requests carry it, never a cookie or the local password", async () => {
  expect(hostOrigins.size).toBe(1)
  expect(tokens.size).toBeGreaterThan(0)
  for (const token of tokens) expect(token).toMatch(/^\d{10}\.[A-Za-z0-9_-]{20,}$/)
  const stored = await storedText(page)
  for (const token of tokens) expect(stored).not.toContain(token)
  expect(stored).not.toContain(state.localPassword)
  // The remote side saw this origin with the token (or a PTY ticket, or a bare preflight), never a cookie.
  const seen = remoteRequests(state).filter((entry) => entry.origin === new URL(state.dev).origin)
  expect(seen.length).toBeGreaterThan(0)
  for (const entry of seen) {
    expect(entry.cookie).toBe(false)
    expect(entry.auth).not.toBe("password")
    if (entry.auth === "none") expect(entry.method).toBe("OPTIONS")
  }
})

test("the remote turn used a PC-only account through the broker; no key ever reached the host's disk", async () => {
  // 04 §8: the remote own-accounts leased Alpha's key from this PC's broker for the request; the host has no vault.
  expect(providerRequests().some((entry) => entry.account === "Alpha")).toBe(true)
  expect(providerRequests().filter((entry) => entry.account === "unknown")).toEqual([])
  const view = await hostView(devbox)
  expect(view.broker).toMatchObject({ state: "connected" })
  expect(view.broker.leasesActive).toBeGreaterThanOrEqual(1)
  expect(view.loopback).toMatch(LOOPBACK)
  // RG10 (fake host part): neither API key is anywhere under the host's home or the remote server's tree.
  const hostRoot = path.dirname(state.hosts.devbox!.home)
  expect(filesContaining(hostRoot, Object.values(FAKE_KEYS))).toEqual([])
})

test("switch account on the remote session: the remote router applies it and the next turn leases Bravo", async () => {
  await expect(page.getByTestId("running-on")).toContainText("@ Alpha", { timeout: 30_000 })
  await page.locator("#own-composer-input").focus()
  await page.keyboard.press("Control+Period")
  const switcher = page.getByTestId("switcher")
  await expect(switcher).toBeVisible()
  await switcher.getByTestId("switcher-account").filter({ hasText: "Bravo" }).click()
  await expect(switcher.getByTestId("switcher-estimate")).toContainText("@ Bravo")
  await switcher.getByTestId("switcher-apply").click()
  // A cold switch may ask for the cost choice first (03 §6.5).
  const dialog = page.getByTestId("switch-dialog")
  await expect(dialog.or(page.getByTestId("running-on").filter({ hasText: "@ Bravo" }))).toBeVisible()
  if (await dialog.isVisible()) {
    await dialog.getByTestId("switch-option-now").click()
    await dialog.getByTestId("switch-dialog-confirm").click()
    await expect(dialog).toBeHidden()
  }
  await expect(page.getByTestId("running-on")).toContainText("@ Bravo", { timeout: 30_000 })
  const before = providerRequests().length
  const composer = page.locator("#own-composer-input")
  await composer.fill("전환 뒤 질문")
  await composer.press("Control+Enter")
  await expect(page.getByTestId("transcript").getByText("Bravo 계정으로 온 답").first()).toBeVisible({
    timeout: 90_000,
  })
  expect(
    providerRequests()
      .slice(before)
      .some((entry) => entry.account === "Bravo"),
  ).toBe(true)
  await shot(page, "06b-remote-switched")
})

test("review and terminal run against the remote server", async () => {
  await page.locator("#own-tab-review").click()
  const review = page.locator("#own-tabpanel-review")
  await expect(review.getByTestId("review-mode")).toBeVisible({ timeout: 30_000 })
  await review.getByTestId("review-mode").selectOption("working")
  await expect(review.getByTestId("review-list")).toContainText("README.md", { timeout: 30_000 })

  const socket = page.waitForEvent("websocket", (ws) =>
    /^ws:\/\/127\.0\.[1-9]\d{0,2}\.2:\d+\/api\/pty\//.test(ws.url()),
  )
  await page.locator("#own-tab-terminal").click()
  const ws = await socket
  expect(new URL(ws.url()).searchParams.has("ticket")).toBe(true)
  const view = page.locator('[data-testid="terminal-view"]:visible')
  await expect(view).toHaveAttribute("data-connection", "ready", { timeout: 60_000 })
  await settleTerminal()
  await view.locator(".own-terminal-screen canvas").click()
  await page.keyboard.type("echo own-remote-pty-ok")
  await page.keyboard.press("Enter")
  await expect
    .poll(async () => (await terminalText()).split("own-remote-pty-ok").length - 1, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2)
  await shot(page, "07-remote-terminal")
  await page.locator("#own-tab-review").click()
})

test("탐색기에서 열기 on the SSH conversation: no program yet explains and leads to 설정; then the program gets the host and the remote folder", async () => {
  // A second tab on a host that can open Explorer (e2e/explorer/harness.tsx: a stand-in that only writes down what it
  // was asked; no program is ever started).
  const tab = await context.newPage()
  const calls = () =>
    tab.evaluate(() => (window as unknown as { __explorer: { calls: unknown[][] } }).__explorer.calls)
  const openMenu = async () => {
    await tab.getByTestId("session-menu").click()
    await expect(tab.locator('[data-testid^="session-menu-reset"]').first()).toBeAttached()
  }
  try {
    await tab.goto(`/e2e/explorer/harness.html?route=${encodeURIComponent(sessionPath)}`)
    await expect(tab.getByTestId("session-menu")).toBeVisible({ timeout: CONNECT })
    await expect(tab.locator("#own-composer-input")).toBeEnabled({ timeout: CONNECT })

    // The item is there before any program is chosen.
    await openMenu()
    await expect(tab.getByTestId("session-menu-explorer")).toHaveText("탐색기에서 열기")
    await tab.getByTestId("session-menu-explorer").click()
    const toast = tab.getByTestId("toast").last()
    await expect(toast).toContainText("SSH 호스트의 폴더를 열 프로그램을 아직 고르지 않았어요")
    await expect(toast).toHaveAttribute("data-tone", "neutral")
    const asked = await calls()
    expect(asked).toHaveLength(1)
    // `{host}`: the ssh config alias the host was added by. `{path}`: the conversation's folder on the host.
    expect(asked[0]!.slice(0, 2)).toEqual(["launch", "devbox"])
    const folder = String(asked[0]![2])
    expect(folder.length).toBeGreaterThan(1)
    await shot(tab, "07b-explorer-unconfigured")

    // The toast's button opens 설정 > SSH 원격 호스트, where the program is chosen.
    await toast.getByRole("button", { name: "설정 열기" }).click()
    const section = tab.getByTestId("explorer-settings")
    await expect(section).toBeVisible({ timeout: 30_000 })
    await expect(section.getByTestId("explorer-settings-program")).toHaveText("고르지 않았어요")
    await section.getByTestId("explorer-settings-pick").click()
    await expect(section.getByTestId("explorer-settings-program")).toHaveText("D:\\tools\\ssh-explorer.exe")
    await shot(tab, "07c-explorer-settings")

    // With a program the same click starts it for the same host and folder, and says nothing.
    await tab.evaluate(
      (route) =>
        (window as unknown as { __explorer: { router: { navigate(to: string): void } } }).__explorer.router.navigate(
          route,
        ),
      sessionPath,
    )
    await expect(tab.locator("#own-composer-input")).toBeEnabled({ timeout: CONNECT })
    const before = await tab.getByTestId("toast").count()
    await openMenu()
    await tab.getByTestId("session-menu-explorer").click()
    await expect.poll(async () => (await calls()).filter((call) => call[0] === "launch")).toEqual([
      ["launch", "devbox", folder],
      ["launch", "devbox", folder],
    ])
    expect(await tab.getByTestId("toast").count()).toBeLessThanOrEqual(before)
    // Never the local path: an SSH conversation's folder is not asked of Explorer.
    expect((await calls()).filter((call) => call[0] === "reveal")).toEqual([])
  } finally {
    await tab.close()
  }
})

test("disconnect keeps the route, shows the overlay and the draft; reconnect restores the session", async () => {
  const composer = page.locator("#own-composer-input")
  await composer.fill("보내지 않은 초안")
  const group = hostGroup(page, "devbox")
  await group.getByTestId("host-menu").click()
  await page.getByTestId("host-disconnect").click()
  const overlay = page.getByTestId("remote-overlay")
  await expect(overlay).toHaveAttribute("data-kind", "paused", { timeout: 30_000 })
  await expect(overlay).toContainText("연결하면 열 수 있어요")
  await expect(page).toHaveURL(sessionPath)
  await expect(group).toHaveAttribute("data-status", "disconnected")
  await expect(group.getByTestId("host-sessions")).toHaveAttribute("data-stale", "true")
  await expect(group.getByTestId("host-session-list").locator(`a[href="${sessionPath}"]`)).toBeVisible()
  await shot(page, "08-disconnected-overlay")
  await overlay.getByTestId("remote-overlay-reconnect").click()
  await expect(overlay).toHaveCount(0, { timeout: CONNECT })
  await expect(composer).toHaveValue("보내지 않은 초안")
  await expect(page).toHaveURL(sessionPath)
  await composer.fill("")
})

test("a reload keeps the remote route and attaches again", async () => {
  await page.reload()
  await expect(page).toHaveURL(sessionPath)
  await expect(page.getByTestId("transcript").getByText("Alpha 계정으로 온 답").first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByTestId("remote-overlay")).toHaveCount(0)
  await expect(page.getByTestId("server-badge")).toHaveText("devbox")
})

test("a dropped tunnel reconnects on its own: 다시 연결하는 중 over the session, then live again (04 §12.2)", async () => {
  // Kill the host's ssh (the fake one) like a network drop; the remote service keeps running (04 §6.2).
  const pidFile = path.join(state.ownHome, "remote", devbox, "tunnel.pid")
  const { pid } = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid: number }
  process.kill(pid)
  const overlay = page.getByTestId("remote-overlay")
  await expect(overlay).toHaveAttribute("data-kind", "reconnecting", { timeout: 30_000 })
  await expect(overlay).toContainText("원격 대화는 호스트에 그대로 있어요. 다시 연결하는 중…")
  await shot(page, "08b-reconnecting")
  await expect(overlay).toHaveCount(0, { timeout: CONNECT })
  await expect(page).toHaveURL(sessionPath)
  await expect(hostGroup(page, "devbox")).toHaveAttribute("data-status", "ready")
})

test("a silent link (no FIN, no RST): 다시 연결하는 중 within ssh's 12 s; the answer written meanwhile arrives once, a prompt sent into the silence comes back to the box and goes once (04 §6.3)", async () => {
  const transcript = page.getByTestId("transcript")
  const composer = page.locator("#own-composer-input")
  const overlay = page.getByTestId("remote-overlay")
  const asked = providerRequests().length
  await composer.fill(`첫 질문, ${SLOW_MARK}`)
  await composer.press("Control+Enter")
  // The host's turn is with the provider, which answers 8 s later: the link goes silent while the answer is written.
  await expect.poll(() => providerRequests().length, { timeout: 90_000 }).toBeGreaterThan(asked)
  setLink(state, "devbox", "silent")
  const silentAt = Date.now()
  await page.waitForTimeout(300)
  await composer.fill("조용한 링크 질문")
  await composer.press("Control+Enter")
  await expect(overlay).toHaveAttribute("data-kind", "reconnecting", { timeout: 30_000 })
  const noticedMs = Date.now() - silentAt
  console.log(`[remote] silent link: 다시 연결하는 중 after ${noticedMs} ms`)
  // ssh's keepalive (every 4 s, 2 unanswered) ends the tunnel at most 12 s after the last byte it received.
  expect(noticedMs).toBeLessThanOrEqual(12_000 + 4_000)
  await shot(page, "08c-silent-link")
  // The prompt never crossed the link: it is back in the box, not in the transcript.
  await expect(composer).toHaveValue("조용한 링크 질문", { timeout: 30_000 })
  // The link stays down past five reconnect failures (backoff 2 s, 5 s): the host keeps retrying (04 §6.3).
  await page.waitForTimeout(20_000)
  expect((await hostView(devbox)).paused).toBe(false)
  setLink(state, "devbox", "up")
  await expect(overlay).toHaveCount(0, { timeout: CONNECT })
  // The answer the host wrote while the link was down comes with the resync, once (exact: the live status line
  // `… 응답 완료: <answer>` repeats it for screen readers).
  await expect(transcript.getByText("Bravo 계정으로 늦게 온 답", { exact: true })).toHaveCount(1, { timeout: 60_000 })
  await expect(transcript.getByText(`첫 질문, ${SLOW_MARK}`, { exact: true })).toHaveCount(1)
  await expect(transcript.getByText("조용한 링크 질문", { exact: true })).toHaveCount(0)
  const answers = await transcript.getByText("Bravo 계정으로 온 답", { exact: true }).count()
  await composer.press("Control+Enter")
  await expect(transcript.getByText("조용한 링크 질문", { exact: true })).toHaveCount(1, { timeout: 60_000 })
  await expect(transcript.getByText("Bravo 계정으로 온 답", { exact: true })).toHaveCount(answers + 1, { timeout: 90_000 })
  await expect(transcript.getByText("Bravo 계정으로 늦게 온 답", { exact: true })).toHaveCount(1)
  await expect(hostGroup(page, "devbox")).toHaveAttribute("data-status", "ready")
})

test("drain (현재 턴이 끝나면 중지) stops the remote service; reconnect starts it again and the next turn leases again", async () => {
  const group = hostGroup(page, "devbox")
  const stopsBefore = serviceEvents("devbox", "stopped").length
  await group.getByTestId("host-menu").click()
  await page.getByTestId("host-drain").click()
  const dialog = page.getByTestId("remote-op-drain")
  await expect(dialog.getByTestId("remote-op-confirm")).toBeEnabled({ timeout: SSH_STEP })
  await dialog.getByTestId("remote-op-confirm").click()
  await expect(dialog.getByTestId("remote-op-started")).toBeVisible()
  // No turn runs, so the service stops at once (04 §6.4); the host waits for the user, the session stays routed.
  await expect.poll(() => serviceEvents("devbox", "stopped").length, { timeout: SSH_STEP }).toBeGreaterThan(stopsBefore)
  await expect(group).toHaveAttribute("data-status", "disconnected", { timeout: 60_000 })
  // The host is disconnected before the op's journal step ends, and a reconnect in between is refused as host_busy
  // (the 2026-11-21 run): wait for the op's last line.
  await expect(dialog.getByTestId("remote-op-started").getByText("원격 서비스 종료")).toBeVisible({ timeout: SSH_STEP })
  await dialog.getByTestId("dialog-close").click()
  await expect(page).toHaveURL(sessionPath)
  await expect(page.getByTestId("remote-overlay")).toBeVisible()
  await shot(page, "08c-drained")

  const startsBefore = serviceEvents("devbox", "started").length
  await group.getByTestId("host-menu").click()
  await page.getByTestId("host-reconnect").click()
  await expect(group).toHaveAttribute("data-status", "ready", { timeout: SERVICE_START })
  await expect(page.getByTestId("remote-overlay")).toHaveCount(0, { timeout: 60_000 })
  expect(serviceEvents("devbox", "started").length).toBeGreaterThan(startsBefore)
  // The restarted service was armed again (new epoch): the switched session leases Bravo.
  const before = providerRequests().length
  const answers = page.getByTestId("transcript").getByText("Bravo 계정으로 온 답")
  const shown = await answers.count()
  const composer = page.locator("#own-composer-input")
  await composer.fill("다시 시작한 뒤 질문")
  await composer.press("Control+Enter")
  await expect(page.getByTestId("transcript").getByText("다시 시작한 뒤 질문")).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => answers.count(), { timeout: 90_000 }).toBeGreaterThan(shown)
  expect(
    providerRequests()
      .slice(before)
      .some((entry) => entry.account === "Bravo"),
  ).toBe(true)
})

test("a password prompt goes to the tab that asked; another tab sees 다른 창에서 인증 중", async () => {
  const other = await context.newPage()
  watch(other)
  await other.goto("/")
  await expect(other.getByTestId("remote-add")).toBeVisible()

  await page.getByTestId("remote-add").click()
  const dialog = page.getByTestId("remote-add-dialog")
  await dialog.locator('[data-testid="remote-alias"][data-alias="pwbox"]').click()
  await dialog.getByTestId("remote-add-check").click()
  const prompt = page.getByTestId("remote-prompt")
  await expect(prompt.locator('[data-kind="password"]')).toBeVisible({ timeout: SSH_STEP })
  await expect(prompt.getByTestId("prompt-input")).toHaveAttribute("type", "password")
  await expect(prompt.getByTestId("prompt-raw")).toContainText("password")

  await expect(hostGroup(other, "pwbox").getByTestId("host-status")).toContainText("다른 창에서 인증 중이에요")
  await expect(other.getByTestId("remote-prompt")).toHaveCount(0)
  await shot(other, "09-elsewhere")

  // RG5: a reload keeps this tab the owner (its sessionStorage client id); own-remote sends the pending prompt again,
  // to this tab only.
  await page.reload()
  await expect(prompt.locator('[data-kind="password"]')).toBeVisible({ timeout: 30_000 })
  await expect(hostGroup(other, "pwbox").getByTestId("host-status")).toContainText("다른 창에서 인증 중이에요")
  await expect(other.getByTestId("remote-prompt")).toHaveCount(0)

  await prompt.getByTestId("prompt-input").fill(state.password)
  await prompt.getByTestId("prompt-submit").click()
  await expect(prompt).toHaveCount(0)
  await expect(hostGroup(page, "pwbox")).toHaveAttribute("data-status", "needsInstall", { timeout: CONNECT })
  await other.close()
  // The answer was sent once and not kept anywhere in the page.
  expect(await storedText(page)).not.toContain(state.password)
})

test("host settings: 프로젝트 설정 has three states with a line each; a change is stored and waits for a remote restart (04 §5.6)", async () => {
  const other = await context.newPage()
  watch(other)
  await other.goto("/settings/remote")
  await other.getByTestId("remote-settings-host").filter({ hasText: "devbox" }).first().click()
  const panel = other.locator(`[data-testid="remote-host-panel"][data-host="${devbox}"]`)
  const control = panel.getByTestId("remote-project-config")
  await expect(control.getByRole("radio")).toHaveText(["끔", "지시 파일만 (AGENTS.md)", "켬"])
  await expect(control.locator('[data-value="instructions"]')).toHaveAttribute("aria-checked", "true")
  const help = panel.getByTestId("remote-project-config-help")
  await expect(help.locator("li")).toHaveCount(3)
  await expect(help.locator("li[data-current]")).toContainText("지시 파일만: 저장소의 AGENTS.md만 읽어요")
  await shot(other, "10-project-states")

  // 끔: stored at once, applied by the next start of the remote service.
  await control.locator('[data-value="disabled"]').click()
  await expect(help.locator("li[data-current]")).toContainText("끔: 저장소에서 아무것도 읽지 않아요")
  await panel.getByTestId("remote-settings-save").click()
  await expect(panel.getByTestId("remote-pending")).toBeVisible()
  await expect(control.locator('[data-value="disabled"]')).toHaveAttribute("aria-checked", "true")
  // Back to the state the running service was started with: nothing is pending any more.
  await control.locator('[data-value="instructions"]').click()
  await panel.getByTestId("remote-settings-save").click()
  await expect(panel.getByTestId("remote-pending")).toHaveCount(0)
  await expect(control.locator('[data-value="instructions"]')).toHaveAttribute("aria-checked", "true")
  await other.close()
})

test("usage: remote turns land in this PC's ledger with the host (server), tagged and linked to /srv/<hostId>/s/<id>", async () => {
  // 04 §10: the remote pushed its observations through the broker; the local ledger is the one of record.
  const usage = await localRpc<{ rows: Array<{ key: string }> }>("own.accounts", "accounts.usage", {
    from: Date.now() - 24 * 60 * 60 * 1000,
    to: Date.now() + 60_000,
    groupBy: "server",
  })
  expect(usage.rows.map((row) => row.key).sort()).toEqual([devbox, "local"].sort())
  const remoteID = sessionPath.split("/").at(-1)!
  await page.goto("/limits")
  // The picker test's conversation (the new-conversation test made a second one on devbox, in its own folder).
  const remoteRow = page
    .locator(`[data-testid="usage-row"][data-server="${devbox}"]`)
    .filter({ has: page.locator(`a.own-link[href="${sessionPath}"]`) })
  await expect(remoteRow.getByTestId("server-tag")).toHaveText("devbox", { timeout: 30_000 })
  await expect(page.locator(`[data-testid="usage-row"][data-server="${devbox}"]`)).toHaveCount(2)
  await expect(remoteRow.locator("a.own-link")).toHaveAttribute("href", sessionPath)
  expect(await remoteRow.locator("a.own-link").getAttribute("title")).toBe(remoteID)
  const localRow = page.locator('[data-testid="usage-row"][data-server="local"]')
  await expect(localRow).toHaveCount(1)
  await expect(localRow.getByTestId("server-tag")).toHaveCount(0)
  await shot(page, "10-usage-server-tag")
})

test("update an older install: 업데이트 필요 → plan (from → to) → drain waits for the turn → updated and connected", async () => {
  await page.goto("/")
  const group = hostGroup(page, "oldbox")
  await expect(group).toBeVisible()
  await group.getByTestId("host-menu").click()
  await page.getByTestId("host-reconnect").click()
  // 04 §5.7: the host runs the older release; nothing is started, the update is offered.
  await expect(group).toHaveAttribute("data-status", "incompatible", { timeout: CONNECT })
  const oldbox = (await group.getAttribute("data-host")) ?? ""
  expect((await hostView(oldbox)).versions).toMatchObject({ local: state.version, remoteRunning: state.oldVersion })
  expect(serviceEvents("oldbox", "started").map((entry) => entry.version)).toEqual([state.oldVersion])
  // A turn is still running on the host (the stub service reports one active session).
  const port = registeredPort("oldbox")
  fs.writeFileSync(path.join(state.testRoot, `active-${port}.json`), JSON.stringify({ ses_busy: { type: "busy" } }))

  await group.getByTestId("host-menu").click()
  await page.getByTestId("host-update").click()
  const dialog = page.getByTestId("remote-op-update")
  // The plan inspects the host over (fake) SSH first, which took past 30 s twice on a loaded PC (update.plan still
  // pending).
  await expect(dialog.getByTestId("remote-update-versions")).toContainText(state.oldVersion, { timeout: SSH_STEP })
  await expect(dialog.getByTestId("remote-update-versions")).toContainText(state.version)
  await shot(page, "11-update-plan")
  await dialog.getByTestId("remote-op-confirm").click()
  await expect(dialog.getByTestId("remote-op-started")).toBeVisible()
  await expect(group).toHaveAttribute("data-status", "draining", { timeout: SSH_STEP })
  // Draining: nothing stopped while the turn runs.
  await page.waitForTimeout(3_000)
  expect(serviceEvents("oldbox", "stopped")).toHaveLength(0)
  fs.writeFileSync(path.join(state.testRoot, `active-${port}.json`), JSON.stringify({}))
  // own-remote's stage (the stub service has no event stream for own-web to attach to, so no "연결됨" here). The update
  // installs and starts the new release over (fake) SSH: past 120 s on this PC under load (2026-11-12).
  await expect(group).toHaveAttribute("data-stage", "ready", { timeout: CONNECT })
  expect((await hostView(oldbox)).versions).toMatchObject({
    local: state.version,
    remoteRunning: state.version,
    skew: false,
  })
  expect(serviceEvents("oldbox", "started").map((entry) => entry.version)).toEqual([state.oldVersion, state.version])
  await shot(page, "12-updated")
  await dialog.getByTestId("dialog-close").click()
})

test("remove a host: plan → confirm; its group and runtime leave the sidebar, the host is not touched", async () => {
  await page.goto("/")
  const group = hostGroup(page, "pwbox")
  await expect(group).toBeVisible()
  await group.getByTestId("host-menu").click()
  await page.getByTestId("host-remove").click()
  const dialog = page.getByTestId("remote-op-forget")
  await expect(dialog.getByTestId("remote-op-confirm")).toBeEnabled({ timeout: SSH_STEP })
  await dialog.getByTestId("remote-op-confirm").click()
  await expect(group).toHaveCount(0)
  await expect(hostGroup(page, "devbox")).toBeVisible()
  // uninstall was not chosen: nothing on the host changed.
  expect(fs.existsSync(path.join(state.hosts.pwbox!.home, "work", "example-game", "README.md"))).toBe(true)
})

test("no uncaught page errors", () => {
  expect(pageErrors).toEqual([])
})

/** own.* RPC on this PC's control location, through the dev server's /api proxy (server-side auth). */
async function localRpc<T>(id: string, method: string, input: unknown): Promise<T> {
  const url = `/api/rpc/${id}/${method}?location[directory]=${encodeURIComponent(state.control)}`
  const response = await page.request.post(url, {
    data: { input },
    headers: { "x-opencode-directory": encodeURIComponent(state.control) },
  })
  const body = (await response.json()) as { output?: T }
  if (!response.ok()) throw new Error(`${id} ${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output as T
}

async function hostView(hostId: string) {
  const list = await localRpc<{ hosts: Array<Record<string, any>> }>("own.remote", "hosts.list", {})
  const view = list.hosts.find((host) => host.id === hostId)
  if (!view) throw new Error(`host ${hostId} not listed`)
  return view
}

/** Service lifecycle events the fake host recorded for one alias (`started`/`stopped`, with the version). */
function serviceEvents(alias: string, kind: string) {
  const home = state.hosts[alias]!.home
  const file = path.join(state.testRoot, "service-events.jsonl")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((entry) => entry.kind === kind && samePath(String(entry.home ?? ""), home))
}

function samePath(a: string, b: string) {
  const norm = (value: string) =>
    value
      .replace(/^\/([a-zA-Z])\//, (_, drive: string) => `${drive}:/`)
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .toLowerCase()
  return norm(a) === norm(b)
}

/** Port of the service registered on the fake host (`service-own.json`). */
function registeredPort(alias: string) {
  const file = path.join(state.hosts[alias]!.home, ".local", "state", "opencode", "service-own.json")
  return Number(new URL(String((JSON.parse(fs.readFileSync(file, "utf8")) as { url: string }).url)).port)
}

/** Files under `root` whose bytes contain any of `needles` (the fake keys), as relative paths. */
function filesContaining(root: string, needles: readonly string[]) {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && fs.statSync(full).size < 64 * 1024 * 1024) {
        const bytes = fs.readFileSync(full)
        if (needles.some((needle) => bytes.includes(needle))) found.push(path.relative(root, full))
      }
    }
  }
  walk(root)
  return found
}

// Terminal helpers (the canvas is not readable; `출력을 텍스트로 보기` is, like e2e/terminal).
async function terminalText() {
  const button = page.getByTestId("terminal-view-text")
  await button.click()
  const text = await page.getByTestId("terminal-text").locator("pre").innerText()
  await button.click()
  return text
}

async function settleTerminal() {
  const last = { text: "" }
  await expect
    .poll(
      async () => {
        const text = await terminalText()
        const stable = text.trim() !== "" && text === last.text
        last.text = text
        return stable
      },
      { intervals: [250], timeout: 30_000 },
    )
    .toBe(true)
}
