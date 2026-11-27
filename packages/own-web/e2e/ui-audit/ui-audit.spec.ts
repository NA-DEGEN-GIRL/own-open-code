// The layout audit over the app (audit.ts) at the window widths the app supports: the wide, desk and compact tiers
// and two tablet widths in the desktop shell's title bar band (emulated), and the phone (375 px) as the paired phone
// sees it (the world's gateway stand-in). At each width: the session screen and every popup it opens (the composer's
// tools, the header's pills and menus, the 압축 내용 dialog, the sidebar's project and conversation menus, the palette,
// the manual), the new-conversation screen, the accounts and limits pages and every settings section with their popups.
// Inside a dialog the sweep opened, its first folded list row is unfolded and every dialog trigger in it opened in
// turn (SM-22): 찾아서 설치's first entry with its ways to install and values, and its `추가 양식에 채우기` with the filled
// form (the registry's trust notice, value notes and forms). A desktop width fails when either was not measured (SM-24).
// Desktop-only UI (the zoom indicator and bubble, 앱 종료 / 완전 종료) needs the shell: own-desktop scripts/zoom-level.ts
// audits it with this module.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test"
import { ALLOWED } from "./allowlist"
import { Audit, emulateWindowControls, line, WINDOW_BUTTONS } from "./audit"

interface World {
  readonly dev: string
  readonly device: string
  readonly sessions: Readonly<Record<string, string>>
}

const WIDTHS = [1440, 1280, 1152, 1024, 820, 375] as const
const matched = new Set<string>()

function world(): World {
  const file = path.join(process.env.OWN_WEB_UI_AUDIT_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

test.afterAll(() => {
  const unused = ALLOWED.filter((entry) => !matched.has(entry.reason))
  if (unused.length)
    console.log(`allowlist entries no view matched:\n${unused.map((entry) => `  ${entry.selector}`).join("\n")}`)
})

for (const width of WIDTHS) {
  test(`${width} px: no wrapped, cut or covered labels in menus, popovers, pills and pages`, async ({
    browser,
  }, info) => {
    const state = world()
    const phone = width < 600
    const page = await open(browser, width, phone ? state.device : state.dev, !phone)
    const audit = new Audit(info, width, ALLOWED, phone ? undefined : WINDOW_BUTTONS, matched)
    const probed = new Set<string>()

    if (phone) {
      await page.goto("/")
      await page.getByTestId("session-row").first().waitFor({ timeout: 60_000 })
      await settle(page)
      await audit.check(page, "list")
      await audit.shoot(page, "list", [page.locator("body")])
      await sidebarMenus(page, audit, "list", probed)
      await sweep(page, audit, "list", probed)
    }

    await page.goto(`/srv/local/s/${state.sessions.enemy}`)
    await page
      .locator(`[data-testid="transcript-body"][data-session-id="${state.sessions.enemy}"]`)
      .waitFor({ timeout: 60_000 })
    await settle(page)
    await audit.check(page, "session")
    await audit.shoot(page, "session", [page.locator("body")])
    await composerTools(page, audit, "session", probed)
    for (const id of [
      "running-on-pill",
      "harness-pill",
      "approval-pill",
      "chat-view-menu",
      "header-ideas",
      "session-menu",
    ])
      await byTestId(page, audit, "session", id, probed)
    await compactions(page, audit, "session")
    await manual(page, audit, "session")
    if (!phone) await sidebarMenus(page, audit, "session", probed)
    await audit.popup(page, "session", {
      name: "palette",
      open: () => page.keyboard.press("Control+KeyK"),
    })
    await sweep(page, audit, "session", probed)

    // A conversation in a folder that is not a Git repository (`pixel-art`): its `⋯` ends with the not-Git note and,
    // where this connection may (not the phone), `Git 저장소로 만들기…` under it (03 §4.3.1, GI).
    await page.goto(`/srv/local/s/${state.sessions.pixel}`)
    await page
      .locator(`[data-testid="transcript-body"][data-session-id="${state.sessions.pixel}"]`)
      .waitFor({ timeout: 60_000 })
    await settle(page)
    await byTestId(page, audit, "session-not-git", "session-menu", probed)

    if (!phone) {
      await page.goto("/")
      await page.locator("#own-composer-input").waitFor({ timeout: 60_000 })
      await settle(page)
      await audit.check(page, "new")
      await audit.shoot(page, "new", [page.locator("body")])
      const fresh = new Set<string>()
      await composerTools(page, audit, "new", fresh)
      await sweep(page, audit, "new", fresh)
    }

    for (const route of ["/accounts", "/limits"]) {
      await page.goto(route)
      await settle(page)
      const name = route.slice(1)
      await audit.check(page, name)
      await audit.shoot(page, name, [page.locator("body")])
      await sweep(page, audit, name, probed)
    }

    await page.goto("/settings")
    await page.getByTestId("page-settings").waitFor({ timeout: 60_000 })
    await settle(page)
    await audit.check(page, "settings")
    await audit.shoot(page, "settings", [page.locator("body")])
    // The manual from 설정 too: the header hides its `?` on a narrow conversation header.
    await audit.popup(page, "settings", {
      name: "manual",
      open: () => page.getByTestId("settings-manual-link").click(),
      popup: page.getByTestId("manual-viewer"),
      close: () => page.getByTestId("manual-close").click(),
    })
    const sections = await page
      .locator('[data-testid^="settings-nav-"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("data-testid")!.slice("settings-nav-".length)))
    expect(sections.length).toBeGreaterThan(5)
    for (const section of sections) {
      // Each section is a full reload: the dev server serves about a thousand modules again, past 10 s on a busy PC,
      // so it gets the same boot wait as the other page loads above.
      await page.goto(`/settings/${section}`)
      await page.getByTestId("settings-content").waitFor({ timeout: 60_000 })
      // A lazy section (MCP 서버 among them) shows its Suspense placeholder until its modules arrive; measure the
      // section, or its popups go unswept.
      await page
        .locator('[data-testid="settings-content"] .own-settings-body > p.own-placeholder', { hasText: "불러오는 중" })
        .waitFor({ state: "detached", timeout: 60_000 })
      await settle(page, 600)
      await audit.check(page, `settings/${section}`)
      await audit.shoot(page, `settings-${section}`, [page.locator("body")])
      await sweep(page, audit, `settings/${section}`, probed)
    }

    const lines = await audit.write()
    await page.context().close()
    // The nested sweep (SM-22) must have measured 찾아서 설치's unfolded entry and the form `추가 양식에 채우기` fills at
    // every desktop width, or a change that hides them would pass unmeasured (SM-24). A screen is taken only after its
    // view was checked; the phone has no 찾아서 설치.
    if (!phone)
      expect(
        [
          ...new Set(
            audit.screens.flatMap((file) => /mcp-registry-find-(unfolded|mcp-registry-use)\.png$/.exec(file)?.[1] ?? []),
          ),
        ].toSorted(),
        lines.join("\n"),
      ).toEqual(["mcp-registry-use", "unfolded"])
    expect(audit.violations().map(line), lines.join("\n")).toEqual([])
  })
}

/** A page in a fresh context: the desktop window (with the shell's title bar band), or a phone. */
async function open(browser: Browser, width: number, baseURL: string, band: boolean) {
  const phone = width < 600
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height: phone ? 812 : 900 },
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    colorScheme: "dark",
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  if (band) await emulateWindowControls(page)
  return page
}

/** The lazy chunks, the store's first answers and the layout's next frames (the app never goes network-idle). */
async function settle(page: Page, ms = 1500) {
  await page.waitForTimeout(ms)
}

/** The composer's tools; the folded ones (03 §4.6: a narrow composer) behind `⋯` first. */
async function composerTools(page: Page, audit: Audit, view: string, probed: Set<string>) {
  // The speed control comes once the service answered the session's (or the target's) speed view; a target whose
  // account cannot answer (signed out) has none.
  await page
    .getByTestId("composer-speed-wrap")
    .waitFor({ state: "attached", timeout: 30_000 })
    .catch(() => audit.notes.push(`${audit.width} ${view} · composer-speed: no speed control`))
  const more = page.getByTestId("composer-more")
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true") await more.click()
  for (const id of [
    "composer-speed",
    "composer-switcher",
    "composer-variant",
    "composer-ultra-info",
    "composer-preset",
    "context-meter",
    "skills-button",
    "project-select",
    "worktree-select",
  ])
    await byTestId(page, audit, view, id, probed)
}

/**
 * The project menu, a conversation's menu (its `⋯` and its right click) and the server status; on a tablet width in
 * the sidebar's drawer, opened before each (Escape closes the drawer with the menu) and closed at the end.
 */
async function sidebarMenus(page: Page, audit: Audit, view: string, probed: Set<string>) {
  const app = page.getByTestId("app")
  const drawer = (await app.getAttribute("data-sidebar-mode")) === "drawer"
  const show = async () => {
    if (drawer && (await app.getAttribute("data-sidebar")) === "closed")
      await page.getByTestId("sidebar-toggle").click()
  }
  await show()
  await byTestId(page, audit, view, "project-menu", probed)
  await show()
  await byTestId(page, audit, view, "row-menu-button", probed)
  await show()
  const row = page.getByTestId("session-row").first()
  if (await row.isVisible())
    await audit.popup(page, view, {
      name: "session-row-context",
      open: () => row.click({ button: "right", noWaitAfter: true }),
      trigger: row,
    })
  await show()
  await byTestId(page, audit, view, "server-status-button", probed)
  if (drawer && (await app.getAttribute("data-sidebar")) === "open") await page.keyboard.press("Escape")
}

/** 압축 내용 (03 §4.5, UC-5): a dialog the session `⋯` opens, not a popup trigger the sweep finds. */
async function compactions(page: Page, audit: Audit, view: string) {
  const menu = page.getByTestId("session-menu").first()
  if (!(await menu.isVisible().catch(() => false))) return void audit.notes.push(`${audit.width} ${view} · no ⋯ menu`)
  await audit.popup(page, view, {
    name: "compactions-dialog",
    open: async () => {
      await menu.click({ timeout: 5_000 })
      await page.getByTestId("session-menu-compactions").click({ timeout: 5_000 })
    },
    popup: page.getByTestId("compactions-dialog"),
  })
}

/** The in-app manual (header `?`): the whole window, its bar in the title bar band. */
async function manual(page: Page, audit: Audit, view: string) {
  const button = page.getByTestId("header-manual")
  if (!(await button.isVisible())) return void audit.notes.push(`${audit.width} ${view} · manual: no ? button`)
  await audit.popup(page, view, {
    name: "manual",
    open: () => button.click(),
    popup: page.getByTestId("manual-viewer"),
    close: () => page.getByTestId("manual-close").click(),
  })
}

async function byTestId(page: Page, audit: Audit, view: string, id: string, probed: Set<string>) {
  const trigger = page.getByTestId(id).first()
  if (!(await trigger.isVisible().catch(() => false)) || (await trigger.isDisabled().catch(() => true))) return
  probed.add(id)
  await probe(page, audit, view, id, trigger, probed)
}

async function probe(page: Page, audit: Audit, view: string, name: string, trigger: Locator, probed: Set<string>) {
  // `noWaitAfter`: on the phone's list a menu button sits in its project's row link, and Playwright then waited for a
  // navigation that never came.
  await audit.popup(page, view, {
    name,
    open: () => trigger.click({ timeout: 5_000, noWaitAfter: true }),
    trigger,
    inside: (popup, at) => nested(page, audit, at, popup, probed),
  })
}

/** Every other popup trigger on screen (`aria-haspopup`), once per test id or label for the whole width. */
async function sweep(page: Page, audit: Audit, view: string, probed: Set<string>) {
  for (const key of (await page.evaluate(triggers, null)).keys) {
    if (probed.has(key)) continue
    probed.add(key)
    if ((await page.evaluate(triggers, key)).found)
      await probe(page, audit, view, key.slice(0, 40), page.locator("[data-ua-trigger]"), probed)
  }
}

/**
 * Inside a dialog the sweep opened: its first folded list row (a disclosure button in a list item, one that opens no
 * popup) unfolded and measured again, then each dialog trigger in it (`aria-haspopup="dialog"`, once per key for the
 * width), which may replace the dialog (`추가 양식에 채우기` opens the add form in place of 찾아서 설치).
 */
async function nested(page: Page, audit: Audit, view: string, popup: Locator, probed: Set<string>) {
  const dialog = await popup.evaluate((element) => element.matches('[role="dialog"], [role="alertdialog"], dialog'))
  if (!dialog) return
  const fold = popup.locator('li button[aria-expanded="false"]:not([aria-haspopup])').first()
  if (await fold.isVisible().catch(() => false)) {
    await fold.click({ timeout: 5_000 })
    await page.waitForTimeout(250)
    await audit.check(page, `${view} · unfolded`, popup)
    await audit.shoot(page, `${view}-unfolded`, [popup])
  }
  for (const key of (await popup.evaluate(dialogTriggers, null)).keys) {
    if (probed.has(`nested ${key}`)) continue
    probed.add(`nested ${key}`)
    if ((await popup.evaluate(dialogTriggers, key)).found)
      await audit.popup(page, view, {
        name: key.slice(0, 40),
        open: () => page.locator("[data-ua-nested]").click({ timeout: 5_000 }),
      })
  }
}

/** In a dialog: the keys of its visible, enabled dialog triggers; with `wanted`, marks that one `data-ua-nested`. */
function dialogTriggers(root: Element, wanted: string | null) {
  const all = [...root.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]')].filter(
    (element) => element.checkVisibility() && !element.matches(":disabled"),
  )
  const key = (element: HTMLElement) =>
    element.getAttribute("data-testid") ?? element.getAttribute("aria-label") ?? (element.textContent ?? "").trim()
  for (const element of document.querySelectorAll("[data-ua-nested]")) element.removeAttribute("data-ua-nested")
  const element = wanted === null ? undefined : all.find((candidate) => key(candidate) === wanted)
  element?.setAttribute("data-ua-nested", "")
  return { keys: [...new Set(all.map(key).filter((value) => value !== ""))], found: !!element }
}

/**
 * In the page: the keys (test id, else label, else text) of the visible, enabled popup triggers; with `wanted`, marks
 * the first trigger with that key `data-ua-trigger` and says whether there was one.
 */
function triggers(wanted: string | null) {
  const all = [
    ...document.querySelectorAll<HTMLElement>('button[aria-haspopup], [role="button"][aria-haspopup]'),
  ].filter((element) => element.checkVisibility() && !element.closest("[inert]") && !element.matches(":disabled"))
  const key = (element: HTMLElement) =>
    element.getAttribute("data-testid") ?? element.getAttribute("aria-label") ?? (element.textContent ?? "").trim()
  const keys = [...new Set(all.map(key).filter((value) => value !== ""))]
  for (const element of document.querySelectorAll("[data-ua-trigger]")) element.removeAttribute("data-ua-trigger")
  const element = wanted === null ? undefined : all.find((candidate) => key(candidate) === wanted)
  element?.setAttribute("data-ua-trigger", "")
  return { keys, found: !!element }
}
