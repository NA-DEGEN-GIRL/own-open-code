// Group R: SSH remote projects on own-web's remote e2e backend (packages/own-web/e2e/remote/backend.ts): a fake `ssh`
// whose "hosts" are Git Bash shells with temp homes (devbox: unknown host key, pwbox, farbox, oldbox: an older
// install), the real credential broker, and the PC's accounts `Alpha` and `Bravo` (this backend's own fake names).
// One story: add devbox (fingerprint, install plan, connected), open its project, the host settings, then oldbox's
// update plan.
import path from "node:path"
import type { Locator, Page } from "../lib/browser"
import type { Ctx, Endpoints, Shot } from "../lib/ctx"
import type { Mapping } from "../lib/privacy"
import { checkoutTmp, start } from "../lib/world"

export interface RemoteState extends Endpoints {
  readonly hosts: Readonly<Record<string, { readonly fingerprint: string; readonly home: string; readonly posixHome: string }>>
  readonly testRoot: string
  readonly serverRoot: string
  readonly ownHome: string
}

export const remotePaths = (state: RemoteState) => ({
  root: state.serverRoot,
  extra: Object.values(state.hosts).flatMap((host): Mapping[] => [
    { from: host.posixHome, to: "/home/demo" },
    { from: host.home, to: "/home/demo" },
    { from: host.home.replaceAll("\\", "/"), to: "/home/demo" },
  ]),
})

export function bootRemote() {
  return start<RemoteState>(
    "remote",
    {
      script: "e2e/remote/backend.ts",
      env: { OWN_WEB_E2E_REMOTE_PORT: "6331" },
      ready: "OWN_WEB_E2E_REMOTE_READY",
      file: path.join(checkoutTmp("own-web-e2e-remote"), "backend.json"),
    },
    remotePaths,
  )
}

type C = Ctx<RemoteState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<RemoteState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

const hostGroup = (page: Page, name: string) =>
  page.locator('[data-testid="host-group"]').filter({ has: tid(page, "host-header").getByText(name, { exact: true }) })

/** The page the story continues on (the add-host dialog stays open across its steps). */
const story: { page?: Page } = {}

async function closePanel(page: Page) {
  if (await tid(page, "panel").isVisible().catch(() => false)) await tid(page, "panel-toggle").first().click()
  await page.waitForTimeout(300)
}

export const REMOTE: ReadonlyArray<Shot<RemoteState>> = [
  shot("21-add-host", async (ctx) => {
    const page = await ctx.page({ keep: true })
    story.page = page
    await closePanel(page)
    await tid(page, "remote-add").click()
    const dialog = tid(page, "remote-add-dialog")
    await dialog.waitFor()
    const alias = dialog.locator('[data-testid="remote-alias"][data-alias="devbox"]')
    await alias.click()
    await page.waitForTimeout(500)
    await ctx.shoot(page, "21-add-host", {
      clip: dialog,
      marks: [tid(dialog, "remote-aliases"), tid(dialog, "remote-add-check")],
    })
  }),
  shot("21-hostkey", async (ctx) => {
    const page = story.page!
    const dialog = tid(page, "remote-add-dialog")
    await tid(dialog, "remote-add-check").click()
    const prompt = tid(page, "remote-prompt")
    await prompt.locator('[data-kind="hostKey"]').waitFor({ timeout: 90_000 })
    await page.waitForTimeout(500)
    await ctx.shoot(page, "21-hostkey", {
      clip: prompt,
      marks: [tid(prompt, "prompt-fingerprint"), tid(prompt, "prompt-trust")],
    })
  }),
  shot("21-install", async (ctx) => {
    const page = story.page!
    await tid(tid(page, "remote-prompt"), "prompt-trust").click()
    const dialog = tid(page, "remote-add-dialog")
    const plan = tid(dialog, "remote-install-plan")
    await plan.waitFor({ timeout: 120_000 })
    await page.waitForTimeout(500)
    await ctx.shoot(page, "21-install", {
      clip: dialog,
      marks: [tid(plan, "remote-install-dir"), tid(plan, "remote-install")],
    })
  }),
  shot("21-connected", async (ctx) => {
    const page = story.page!
    const dialog = tid(page, "remote-add-dialog")
    await tid(tid(dialog, "remote-install-plan"), "remote-install").click()
    await tid(dialog, "remote-done").waitFor({ timeout: 240_000 })
    await tid(dialog, "remote-open-folder").click()
    const picker = tid(page, "remote-picker")
    await picker.waitFor()
    const work = picker.locator('[data-testid="remote-picker-entry"][data-name="work"]')
    await work.dblclick()
    await picker.locator('[data-testid="remote-picker-entry"][data-name="example-game"]').click()
    await tid(picker, "remote-picker-choose").click()
    await tid(tid(picker, "remote-picker-confirm"), "remote-picker-start").click()
    await tid(page, "server-badge").waitFor({ timeout: 60_000 })
    const composer = page.locator("#own-composer-input")
    await composer.fill("원격 서버에서 프로젝트 구조를 알려 줘")
    await composer.press("Control+Enter")
    await page.getByTestId("transcript").getByText(/계정으로 온 답/).first().waitFor({ timeout: 120_000 })
    await closePanel(page)
    await page.waitForTimeout(1500)
    await ctx.shoot(page, "21-connected", {
      marks: [tid(hostGroup(page, "devbox"), "host-header"), tid(page, "server-badge")],
    })
  }),
  shot("21-host-status", async (ctx) => {
    const page = await ctx.page({ path: "/settings/remote" })
    await page.setViewportSize({ width: 1440, height: 2400 })
    await page.waitForTimeout(2000)
    await closePanel(page)
    const host = tid(page, "remote-settings-host").filter({ hasText: "devbox" }).first()
    if (await host.isVisible().catch(() => false)) await host.click()
    await page.waitForTimeout(1500)
    const panel = tid(page, "remote-host-panel").first()
    const scope = panel.getByText("계정 범위").first()
    await ctx.shoot(page, "21-host-status", {
      clip: panel,
      marks: [scope.locator("xpath=ancestor::*[self::section or self::fieldset or self::div][1]")],
    })
  }),
  shot("21-update", async (ctx) => {
    const page = await ctx.page()
    await closePanel(page)
    const group = hostGroup(page, "oldbox")
    await group.waitFor()
    await tid(group, "host-menu").click()
    await tid(page, "host-reconnect").click()
    await page.locator('[data-testid="host-group"][data-status="incompatible"]').first().waitFor({ timeout: 120_000 })
    await tid(group, "host-menu").click()
    await tid(page, "host-update").click()
    const dialog = tid(page, "remote-op-update")
    await tid(dialog, "remote-update-versions").waitFor({ timeout: 60_000 })
    await page.waitForTimeout(800)
    await ctx.shoot(page, "21-update", {
      clip: dialog,
      marks: [dialog.getByText("현재 턴이 끝나면 업데이트 (기본)").first()],
    })
    await page.keyboard.press("Escape")
  }),
]
