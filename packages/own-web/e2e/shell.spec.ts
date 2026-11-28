// Shell and data layer against the real server with own.accounts (dev proxy path, 03 §16.2).
import { expect, test, type Page } from "@playwright/test"
import { backend, watchErrors } from "./support"
import { emulateWindowControls, WINDOW_BUTTONS } from "./ui-audit/audit"

const state = backend()
const [first, second] = state.sessions

test.describe("shell on the real server", () => {
  test("session list comes from the server, then from IndexedDB before the server answers", async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto("/")
    const list = page.getByTestId("session-list")
    for (const session of state.sessions) await expect(list.getByText(session.title)).toBeVisible()
    await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
    await expect(page.getByTestId("header-title")).toHaveText("새 대화")

    // PF1 marks exist and the snapshot was persisted when idle.
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName("own:sessions-fresh").length)).toBe(1)
    const visible = await page.evaluate(() => performance.getEntriesByName("own:sessions-visible")[0]?.startTime)
    expect(visible).toBeGreaterThan(0)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const open = indexedDB.open("own-web")
              open.onsuccess = () => {
                const get = open.result.transaction("session-list").objectStore("session-list").get("local")
                get.onsuccess = () => resolve(get.result?.sessions?.length ?? 0)
                get.onerror = () => resolve(-1)
              }
              open.onerror = () => resolve(-1)
            }),
        ),
      )
      // Other specs of this config (composer, requests) create sessions on the same backend before this one runs.
      .toBeGreaterThanOrEqual(state.sessions.length)

    // Reload with the server unreachable: the cached list still paints (stale-while-revalidate).
    await page.route("**/api/**", (route) => route.abort())
    await page.reload()
    await expect(page.getByTestId("sidebar-cached")).toBeVisible()
    for (const session of state.sessions) await expect(list.getByText(session.title)).toBeVisible()
    const cachedAt = await page.evaluate(() => performance.getEntriesByName("own:sessions-visible")[0]?.startTime)
    console.log(`PF1 (dev, cached list, server blocked): own:sessions-visible at ${cachedAt?.toFixed(0)} ms`)
    await page.unroute("**/api/**")
    expect(errors.filter((error) => !/Failed to load resource|ERR_FAILED|net::/.test(error))).toEqual([])
  })

  test("opening a session shows its binding from own.accounts (control + session locations)", async ({ page }) => {
    await page.goto("/")
    await page.getByTestId("session-list").getByText(first!.title).click()
    await expect(page).toHaveURL(new RegExp(`/srv/local/s/${first!.id}$`))
    await expect(page.getByTestId("header-title")).toHaveText(first!.title)
    // The pill shows the catalog display name (GPT-5.5), not the model id.
    await expect(page.getByTestId("running-on")).toContainText(`GPT-5.5 @ ${state.account.label}`)
    // Short form redirects to the server-keyed route.
    await page.goto(`/s/${second!.id}`)
    await expect(page).toHaveURL(new RegExp(`/srv/local/s/${second!.id}$`))
    await expect(page.getByTestId("header-title")).toHaveText(second!.title)
  })

  test("work panel: toggle, tab shortcuts, lazy 계정·한도 tab with the account", async ({ page }) => {
    await page.goto(`/srv/local/s/${first!.id}`)
    const app = page.getByTestId("app")
    await expect(app).toHaveAttribute("data-tier", "wide")
    await expect(app).toHaveAttribute("data-panel", "open")
    // The panel's open state is kept per conversation: toggling before the conversation is on screen wrote it for the
    // home view, and the conversation's own state opened the panel again (2026-10-17, loaded PC).
    await expect(page.getByTestId("header-title")).toHaveText(first!.title)
    await page.keyboard.press("Control+Alt+KeyB")
    await expect(app).toHaveAttribute("data-panel", "closed")
    await expect(page.getByTestId("panel")).toHaveAttribute("inert", "")
    await page.keyboard.press("Control+Shift+KeyU")
    await expect(app).toHaveAttribute("data-panel", "open")
    await expect(page.getByTestId("panel")).not.toHaveAttribute("inert")
    await expect(page.getByRole("tab", { name: "계정·한도" })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByTestId("tab-accounts").getByText(state.account.label, { exact: true }).first()).toBeVisible()
    await page.keyboard.press("Control+Shift+KeyR")
    await expect(page.getByRole("tab", { name: "리뷰" })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByTestId("tab-review")).toBeVisible()
    // The accounts tab stays mounted while hidden.
    await expect(page.getByTestId("tab-accounts")).toBeHidden()
    await expect(page.getByTestId("tab-accounts")).toHaveCount(1)
    // No browser tab without the capability (web host).
    await expect(page.getByRole("tab", { name: "브라우저" })).toHaveCount(0)
    await page.screenshot({ path: "e2e/test-results/shell-wide.png" })
  })

  test("pages load lazily and keep the session view mounted", async ({ page }) => {
    await page.goto(`/srv/local/s/${first!.id}`)
    const composer = page.locator("#own-composer-input")
    await composer.fill("초안 유지")
    await page.goto("/accounts")
    await expect(page.getByTestId("page-accounts").getByText(state.account.label)).toBeVisible()
    await page.getByTestId("sidebar-settings").click()
    await expect(page.getByTestId("page-settings")).toHaveAttribute("data-section", "general")
    await page.getByTestId("sidebar-limits").click()
    await expect(page.getByTestId("page-limits")).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId("page-settings")).toBeVisible()
  })

  test("theme: dark by default on a light system, toggle cycles dark → light → system, the preload keeps the choice", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" })
    await page.goto("/")
    const toggle = page.getByTestId("theme-toggle")
    const html = page.locator("html")
    await expect(toggle).toHaveAttribute("data-scheme", "dark")
    await expect(html).toHaveAttribute("data-color-scheme", "dark")
    expect(await page.evaluate(() => localStorage.getItem("opencode-color-scheme"))).toBe("dark")
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).not.toBe("rgb(255, 255, 255)")
    await page.screenshot({ path: "e2e/test-results/shell-dark.png" })
    await toggle.click()
    await expect(toggle).toHaveAttribute("data-scheme", "light")
    await expect(html).toHaveAttribute("data-color-scheme", "light")
    // A stored light choice survives the reload (the preload and the seed leave it alone).
    await page.reload()
    await expect(html).toHaveAttribute("data-color-scheme", "light")
    await expect(toggle).toHaveAttribute("data-scheme", "light")
    await toggle.click()
    await expect(toggle).toHaveAttribute("data-scheme", "system")
    await expect(html).toHaveAttribute("data-color-scheme", "light")
    await page.reload()
    await expect(toggle).toHaveAttribute("data-scheme", "system")
    await toggle.click()
    await expect(toggle).toHaveAttribute("data-scheme", "dark")
    await expect(html).toHaveAttribute("data-color-scheme", "dark")
  })

  test("a dropped event stream shows the reconnect strip, then the reconnected flash (03 §8)", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
    await page.route("**/api/event", (route) => route.abort())
    // `online` makes @opencode/client drop the live stream and reconnect at once.
    await page.evaluate(() => window.dispatchEvent(new Event("online")))
    await expect(page.getByTestId("banner-offline")).toContainText("연결이 끊겼어요")
    await expect(page.locator("#own-composer-input")).toBeVisible()
    await page.unroute("**/api/event")
    await expect(page.getByTestId("banner-reconnected")).toHaveText("다시 연결됨 · 동기화했어요", { timeout: 20_000 })
    await expect(page.getByTestId("banner-reconnected")).toBeHidden({ timeout: 5_000 })
  })

  test("Ctrl+B toggles the sidebar, but not while typing in the composer (03 §10)", async ({ page }) => {
    await page.goto(`/srv/local/s/${first!.id}`)
    const app = page.getByTestId("app")
    await page.getByTestId("header-title").click()
    await page.keyboard.press("Control+KeyB")
    await expect(app).toHaveAttribute("data-sidebar", "closed")
    await expect(page.getByTestId("sidebar")).toHaveAttribute("inert", "")
    await page.keyboard.press("Control+KeyB")
    await expect(app).toHaveAttribute("data-sidebar", "open")
    await page.locator("#own-composer-input").focus()
    await page.keyboard.press("Control+KeyB")
    await expect(app).toHaveAttribute("data-sidebar", "open")
  })

  test("a Ctrl+B pressed while an opened conversation still loads stays once its folder is known (03 §4.1.1, §10)", async ({
    page,
  }) => {
    // A slow first load: the session reads answer only after the shortcut, so the folder on screen is not known yet.
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const reads = (url: URL) => url.pathname.startsWith("/api/session")
    await page.route(reads, async (route) => {
      await held
      await route.continue()
    })
    await page.goto(`/srv/local/s/${first!.id}`)
    const app = page.getByTestId("app")
    await page.getByTestId("header-title").click()
    await page.keyboard.press("Control+KeyB")
    await expect(app).toHaveAttribute("data-sidebar", "closed")
    release()
    await expect(page.getByTestId("header-title")).toHaveText(first!.title)
    await expect(page.getByTestId("session-list").getByText(first!.title)).toBeAttached()
    await expect(app).toHaveAttribute("data-sidebar", "closed")
    await expect(page.getByTestId("sidebar")).toHaveAttribute("inert", "")
    // It is that folder's layout now: a reload with the reads answering at once keeps the sidebar closed.
    await page.unroute(reads)
    await page.reload()
    await expect(page.getByTestId("header-title")).toHaveText(first!.title)
    await expect(app).toHaveAttribute("data-sidebar", "closed")
  })
})

test.describe("responsive tiers (03 §4.2)", () => {
  const tiers = [
    { width: 1440, tier: "wide", panelMode: "push" },
    { width: 1280, tier: "desk", panelMode: "push" },
    { width: 1100, tier: "compact", panelMode: "drawer" },
    { width: 800, tier: "tablet", panelMode: "sheet" },
    { width: 375, tier: "phone", panelMode: "fullscreen" },
  ] as const

  test("tiers switch by CSS only: the composer element and its text survive", async ({ page }) => {
    await page.goto(`/srv/local/s/${first!.id}`)
    const composer = page.locator("#own-composer-input")
    await composer.fill("한글 입력 유지")
    const marker = await composer.evaluate((element) => {
      ;(element as HTMLTextAreaElement & { __mark?: number }).__mark = 42
      return 42
    })
    for (const item of tiers) {
      await page.setViewportSize({ width: item.width, height: 800 })
      const app = page.getByTestId("app")
      await expect(app).toHaveAttribute("data-tier", item.tier)
      await expect(app).toHaveAttribute("data-panel-mode", item.panelMode)
      expect(await composer.evaluate((element) => (element as HTMLTextAreaElement & { __mark?: number }).__mark)).toBe(
        marker,
      )
      await expect(composer).toHaveValue("한글 입력 유지")
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      expect(overflow).toBe(false)
      await page.screenshot({ path: `e2e/test-results/tier-${item.tier}.png` })
    }
  })

  test("tablet: the sidebar is a drawer, inert while closed; phone: list screen on home", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 })
    await page.goto(`/srv/local/s/${first!.id}`)
    const app = page.getByTestId("app")
    await expect(app).toHaveAttribute("data-sidebar", "closed")
    await expect(page.getByTestId("sidebar")).toHaveAttribute("inert", "")
    await page.getByTestId("sidebar-toggle").click()
    await expect(app).toHaveAttribute("data-sidebar", "open")
    await expect(page.getByTestId("scrim")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(app).toHaveAttribute("data-sidebar", "closed")

    await page.setViewportSize({ width: 375, height: 760 })
    await page.goto("/")
    await expect(app).toHaveAttribute("data-phone-view", "list")
    await expect(page.getByTestId("main")).toHaveAttribute("inert", "")
    await page.getByTestId("session-list").getByText(first!.title).click()
    await expect(app).toHaveAttribute("data-phone-view", "session")
    await expect(page.getByTestId("sidebar")).toHaveAttribute("inert", "")
    await page.getByRole("button", { name: "뒤로" }).click()
    await expect(app).toHaveAttribute("data-phone-view", "list")
  })

  test("tier variants still apply after a conversation loaded the transcript's own Tailwind root", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("transcript-body")).toBeVisible()
    // That root re-emits `px-4` and `grid-cols-1` in its `utilities` layer; own-web's `tablet:` variants must still win.
    await page.getByTestId("sidebar-accounts").click()
    await expect(page.getByTestId("page-accounts")).toHaveCSS("padding-left", "28px")
    await page.getByTestId("sidebar-limits").click()
    await expect(page.getByTestId("page-limits")).toHaveCSS("padding-left", "28px")
    await page.getByTestId("sidebar-settings").click()
    await page.getByTestId("settings-nav-policy").click()
    const grid = page.getByTestId("settings-policy").locator('[class*="tablet:grid-cols-2"]').first()
    await expect
      .poll(() => grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length))
      .toBe(2)
    await page.setViewportSize({ width: 375, height: 812 })
    await expect(page.getByTestId("page-settings")).toHaveAttribute("data-layout", "stacked")
    await expect
      .poll(() => grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length))
      .toBe(1)
  })
})

// 03 §4.3.1: settings, team mode and worktrees are found without knowing where they live. This backend has no own-team
// and its project is not a Git repository, the case where team mode and worktrees used to show nothing at all.
test.describe("discoverability (03 §4.3.1)", () => {
  test("settings: labelled in the sidebar, a header button on every screen, Ctrl+, and `설정 열기`", async ({
    page,
  }) => {
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("sidebar-settings")).toHaveText("설정")
    await expect(page.getByTestId("sidebar-settings")).toHaveAttribute("title", "설정 열기 (Ctrl+,)")
    // The sidebar folded: the header still has it.
    await page.getByTestId("sidebar-toggle").click()
    await expect(page.getByTestId("app")).toHaveAttribute("data-sidebar", "closed")
    await page.getByTestId("header-settings").click()
    await expect(page.getByTestId("page-settings")).toHaveAttribute("data-section", "general")
    await expect(page.getByTestId("header-settings")).toHaveAttribute("aria-pressed", "true")
    await page.goto(`/srv/local/s/${first!.id}`)
    await page.locator("#own-composer-input").click()
    await page.keyboard.press("Control+Comma")
    await expect(page.getByTestId("page-settings")).toHaveAttribute("data-section", "general")
    await page.goto(`/srv/local/s/${first!.id}`)
    await page.keyboard.press("Control+KeyK")
    await expect(page.getByTestId("palette-input")).toBeFocused()
    await page.keyboard.type("환경설정")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("page-settings")).toHaveAttribute("data-section", "general")
  })

  test("a project that is not a Git repository says why it has no worktrees, in the row, the menu and the palette", async ({
    page,
  }) => {
    await page.goto("/")
    const row = page.getByTestId("project-row").first()
    await row.hover()
    const worktree = row.getByTestId("project-worktree-button")
    await expect(worktree).toBeVisible()
    await expect(worktree).toHaveAttribute("data-state", "not-git")
    await worktree.click({ force: true })
    await expect(page.getByTestId("toast").last()).toContainText("Git 저장소인 프로젝트에서만")
    // No own-team on this server: no team button and no team words in the note.
    await expect(row.getByTestId("project-team-button")).toHaveCount(0)
    await row.hover()
    await row.getByTestId("project-menu").click()
    await expect(page.getByTestId("menu-not-git")).toHaveText(
      "작업 폴더는 Git 저장소인 프로젝트에서만 만들 수 있어요. 이 폴더를 Git 저장소로 만들면 쓸 수 있어요.",
    )
    await page.keyboard.press("Escape")
    await row.getByTestId("project-new-session").click()
    await page.keyboard.press("Control+KeyK")
    await expect(page.getByTestId("palette-input")).toBeFocused()
    await page.keyboard.type("작업 폴더")
    await expect(page.getByRole("option", { name: /새 작업 폴더에서 새 대화 \(Git 저장소에서만\)/ })).toBeVisible()
    await page.keyboard.press("Escape")
  })

  test("the user manual opens in the app, offline, at a chapter from the hints and the settings pages", async ({
    page,
  }) => {
    await page.goto("/")
    await page.getByTestId("header-manual").click()
    const viewer = page.getByTestId("manual-viewer")
    await expect(viewer).toBeVisible()
    await expect(page.frameLocator('[data-testid="manual-frame"]').locator("#ch17")).toBeAttached()
    await page.getByTestId("manual-close").click()
    await expect(viewer).toHaveCount(0)
    // A chapter from the palette is an anchor of the page (the team hint's `설명서 17장` needs own-team, absent here).
    await page.keyboard.press("Control+KeyK")
    await expect(page.getByTestId("palette-input")).toBeFocused()
    await page.keyboard.type("설명서: 단축키")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("manual-frame")).toHaveAttribute("src", /#ch91$/)
    await page.getByTestId("manual-close").click()
    // 설정 > 음성 입력 links 받아쓰기; the settings list has 설명서.
    await page.goto("/settings/voice")
    await page.getByTestId("manual-link").click()
    await expect(page.getByTestId("manual-frame")).toHaveAttribute("src", /#ch10-10$/)
    await page.getByTestId("manual-close").click()
    await page.getByTestId("settings-manual-link").click()
    await expect(page.getByTestId("manual-viewer")).toBeVisible()
    await page.getByTestId("manual-close").click()
    await page.keyboard.press("Control+KeyK")
    await expect(page.getByTestId("palette-input")).toBeFocused()
    await page.keyboard.type("도움말")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("manual-viewer")).toBeVisible()
  })

  test("first-run hints: closed once, back from the palette", async ({ page }) => {
    await page.goto("/")
    const hints = page.getByTestId("discover-hints")
    await expect(hints).toBeVisible()
    await expect(hints.getByTestId("discover-hints-worktree")).toBeVisible()
    await expect(hints.getByTestId("discover-hints-settings")).toContainText("Ctrl+,")
    await hints.getByTestId("discover-hints-close").click()
    await expect(hints).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId("transcript")).toBeVisible()
    await expect(page.getByTestId("discover-hints")).toHaveCount(0)
    await page.keyboard.press("Control+KeyK")
    await expect(page.getByTestId("palette-input")).toBeFocused()
    await page.keyboard.type("처음 안내")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("discover-hints")).toBeVisible()
  })
})

// 03 §4.3.1 (P2-14): on desktop and tablet the new-conversation screen's line (centred, muted), the 알아 두면 좋은 것
// card and the composer are one column at the composer's width, centred in the pane; the phone keeps its layout.
test.describe("the new-conversation screen (03 §4.3.1)", () => {
  for (const width of [1440, 1024])
    test(`${width} px: the line, the hints and the composer are one centred column, with the hints closed too`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto("/")
      await expect(page.getByTestId("discover-hints")).toBeVisible()
      await expect(page.getByTestId("transcript").locator(".own-placeholder")).toHaveText(
        "대화를 고르거나 새 대화를 시작하세요.",
      )
      await expect(async () => expect(await homeColumn(page, true)).toEqual(CENTRED)).toPass({ timeout: 10_000 })
      await page.screenshot({ path: `e2e/test-results/home-${width}.png` })
      await page.getByTestId("discover-hints-close").click()
      await expect(page.getByTestId("discover-hints")).toHaveCount(0)
      await expect(async () => expect(await homeColumn(page, false)).toEqual(CENTRED)).toPass({ timeout: 10_000 })
    })

  test("375 px: the phone's new-conversation screen keeps its layout", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/")
    await page.getByTestId("project-row").first().getByTestId("project-new-session").click()
    await expect(page).toHaveURL(/\/srv\/local\/p\//)
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-home", "")
    const line = page.getByTestId("transcript").locator(".own-placeholder")
    await expect(line).toHaveText("대화를 고르거나 새 대화를 시작하세요.")
    await expect(line).not.toHaveCSS("text-align", "center")
  })
})

/** An account renamed to the longest name 계정 > 이름 바꾸기 takes (80 characters, accounts/account-dialogs.tsx). */
const LONG_ACCOUNT = "ChatGPT 회사 공용 계정 ".repeat(5).slice(0, 80)
const CENTRED = { home: true, centredText: true, middle: true, notAtTop: true, oneColumn: true, hints: true }

/**
 * Where the new-conversation screen's line, hints card and composer sit in their pane: the group's middle within 10 %
 * of the pane's height of the pane's middle, the line well below the pane's top, centred over the composer, and the
 * card (when `hints`) between them at the composer box's width.
 */
async function homeColumn(page: import("@playwright/test").Page, hints: boolean) {
  return page.getByTestId("session-view").evaluate((pane, withHints) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect()
    const area = pane.getBoundingClientRect()
    const line = pane.querySelector('[data-testid="transcript"] > .own-placeholder')
    const lineBox = rect(line)
    const card = rect(pane.querySelector('[data-testid="discover-hints"]'))
    const composer = rect(pane.querySelector('[data-testid="composer"]'))
    const box = rect(pane.querySelector('[data-testid="composer"] .own-cp-box'))
    if (!line || !lineBox || !composer || !box) return { missing: true }
    const near = (a: number, b: number) => Math.abs(a - b) <= 1.5
    return {
      home: pane.hasAttribute("data-home"),
      centredText: getComputedStyle(line).textAlign === "center",
      middle: Math.abs((lineBox.top + composer.bottom) / 2 - (area.top + area.bottom) / 2) <= area.height * 0.1,
      notAtTop: lineBox.top - area.top > area.height * 0.15,
      oneColumn: near((lineBox.left + lineBox.right) / 2, (box.left + box.right) / 2),
      hints: withHints
        ? card !== undefined &&
          near(card.left, box.left) &&
          near(card.right, box.right) &&
          card.top >= lineBox.bottom - 1 &&
          card.bottom <= box.top + 1
        : card === undefined,
    }
  }, hints)
}

/** Visible direct children of the header that overlap another one (zero-size items are ignored). */
async function headerOverlaps(page: import("@playwright/test").Page) {
  return page.getByTestId("header").evaluate((node) => {
    const boxes = Array.from(node.children).flatMap((child) => {
      const box = child.getBoundingClientRect()
      return box.width > 0 && box.height > 0
        ? [{ box, name: child.getAttribute("data-testid") ?? child.className.split(" ")[0] ?? child.tagName }]
        : []
    })
    return boxes.flatMap((a, index) =>
      boxes
        .slice(index + 1)
        .filter(
          (b) =>
            a.box.left < b.box.right - 0.5 &&
            b.box.left < a.box.right - 0.5 &&
            a.box.top < b.box.bottom - 0.5 &&
            b.box.top < a.box.bottom - 0.5,
        )
        .map((b) => `${a.name} / ${b.name}`),
    )
  })
}

/**
 * Stand-ins for what this backend has not (no team, no computer use), in the markup of the real components: a short
 * title, a Claude model and account, the team main's pill (shell/header.tsx TeamPill, its first words apart) and with
 * `chip` the computer-use chip with its Stop button (computer/index.tsx ComputerChip), each where the header puts it.
 */
function teamMainStandIns(header: HTMLElement, chip: boolean) {
  // Applied again by `standInFit`: the pills of an earlier attempt go first (the plain conversation has neither).
  header.querySelectorAll('[data-testid="team-pill"], [data-testid="computer-chip"]').forEach((node) => node.remove())
  const title = header.querySelector<HTMLElement>('[data-testid="header-title"]')!
  const label = header.querySelector<HTMLElement>('[data-testid="running-on"]')!
  title.textContent = "팀 메인"
  label.querySelector('[data-part="model"]')!.textContent = "Claude Sonnet 4.5"
  label.querySelector('[data-part="account"]')!.textContent = "Claude 구독"
  const make = (html: string) => {
    const box = document.createElement("template")
    box.innerHTML = html.trim()
    return box.content.firstElementChild!
  }
  title.after(
    make(`<button type="button" data-testid="team-pill" data-kind="main" aria-label="팀 메인 · 영역 3개"
      title="팀 메인 · 영역 3개"
      class="own-target inline-flex h-7 shrink-0 items-center rounded-full border border-own-border px-2.5 text-[12px] text-own-muted hover:bg-own-hover">
      <span class="max-w-[14rem] truncate"><span class="own-give-lead">팀 메인 · </span>영역 3개</span></button>`),
  )
  if (!chip) return
  header.querySelector(".own-sw-pill-wrap")!.after(
    make(`<span data-testid="computer-chip" data-state="on"
      class="inline-flex h-7 shrink-0 items-center rounded-full border text-[12px] data-[state=on]:border-own-border data-[state=on]:text-own-muted">
      <button type="button" data-testid="computer-chip-open" aria-label="컴퓨터 사용" aria-haspopup="dialog"
      class="own-target inline-flex h-full items-center gap-1.5 rounded-full px-2.5 hover:bg-own-hover"><span
      aria-hidden="true" class="own-give-full size-1.5 rounded-full bg-current"></span><span
      class="own-give-full max-w-[12rem] truncate">컴퓨터 사용</span><svg viewBox="0 0 24 24" aria-hidden="true"
      class="own-give-short" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" style="flex: none"><path
      d="M3.5 5.5h17v11h-17zM8 20h8M12 16.5V20M9.5 8l5 2-2.1.8-.8 2.1z"></path></svg></button><button type="button"
      data-testid="computer-stop" aria-label="멈추기"
      class="own-target mr-0.5 inline-flex h-6 items-center rounded-full px-2 font-semibold text-own-danger hover:bg-own-hover"><span
      class="own-give-full">멈추기</span><span aria-hidden="true"
      class="own-give-short size-2 rounded-[2px] bg-current"></span></button></span>`),
  )
}

/** A fresh page on the first conversation at `width` px with the sidebar and the work panel open. */
async function openWithBothPanels(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/srv/local/s/${first!.id}`)
  const app = page.getByTestId("app")
  // The account's name too, not only the model: the pill names the provider until the accounts store answers, and
  // that later render put back the label a test had replaced with its stand-ins (`GPT-5.5 @ Alpha` where the
  // 80-character account was written, once under the release tier's load, S23 pass).
  await expect(page.getByTestId("running-on")).toContainText("GPT-5.5 @ Alpha")
  if ((await app.getAttribute("data-sidebar")) !== "open") await page.getByTestId("sidebar-toggle").click()
  if ((await app.getAttribute("data-panel")) !== "open") await page.getByTestId("panel-toggle").click()
  await expect(app).toHaveAttribute("data-sidebar", "open")
  await expect(app).toHaveAttribute("data-panel", "open")
}

/**
 * The stand-ins applied and measured. The pill draws its label again on a late render (an accounts or catalog read
 * landing after the page's first one: `GPT-5.5 @ Alpha` came back over the stand-ins in the release tier's full runs,
 * RL34-T), so the stand-ins go on again until a measurement saw them.
 */
async function standInFit(page: Page, apply: () => Promise<unknown>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await apply()
    const fit = await teamHeaderFit(page)
    if (fit.label.startsWith("Claude Sonnet 4.5")) return fit
  }
  throw new Error("the header's stand-ins never held through a measurement")
}

/**
 * The header once its give-way fit has run (shell/header-fit.ts measures a frame after a change): the steps it took,
 * the title against its text, how much of the model and the account is cut, how far anything runs past the header's
 * content box, and what of it lies under the desktop shell's window buttons when they are emulated.
 */
async function teamHeaderFit(page: Page) {
  return page.getByTestId("header").evaluate(async (header, band) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const title = header.querySelector<HTMLElement>('[data-testid="header-title"]')!
    const label = header.querySelector<HTMLElement>('[data-testid="running-on"]')!
    const cut = (node: HTMLElement) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      return range.getBoundingClientRect().width - node.getBoundingClientRect().width
    }
    const text = document.createRange()
    text.selectNodeContents(title)
    const end = header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight)
    const buttons = { left: window.innerWidth - band.right, bottom: band.height }
    const wco = document.documentElement.hasAttribute("data-wco-visible")
    const account = label.querySelector<HTMLElement>('[data-part="account"]')!
    return {
      give: header.dataset.give ?? "",
      title: title.getBoundingClientRect().width,
      // The text's own width (a box wider than its text has that box's `scrollWidth`).
      full: text.getBoundingClientRect().width,
      model: cut(label.querySelector<HTMLElement>('[data-part="model"]')!),
      account: cut(account),
      // At its own cap (14em) a longer account counts as whole (composer/limit-fit.ts `cut`).
      accountCapped: account.getBoundingClientRect().width + 0.5 >= parseFloat(getComputedStyle(account).maxWidth),
      titleTip: title.getAttribute("title"),
      labelTip: label.getAttribute("title"),
      label: label.textContent,
      overflow: header.scrollWidth - header.clientWidth,
      past: Math.max(0, ...Array.from(header.children, (child) => child.getBoundingClientRect().right - end)),
      underButtons: wco
        ? Array.from(header.querySelectorAll<HTMLElement>("*")).flatMap((node) => {
            const box = node.getBoundingClientRect()
            return box.width > 0 && box.height > 0 && box.right > buttons.left && box.top < buttons.bottom
              ? [node.dataset.testid ?? node.tagName]
              : []
          })
        : [],
    }
  }, WINDOW_BUTTONS)
}

test.describe("header, composer and pages fit (03 §4.4, §4.6, §5.7)", () => {
  test("1440 px with the sidebar and the work panel open: nothing overlaps, the title keeps its room, 전송 stays on the toolbar line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "open")
    await expect(page.getByTestId("running-on")).toContainText("GPT-5.5")
    expect((await page.getByTestId("header-title").boundingBox())!.width).toBeGreaterThanOrEqual(80)
    expect(await headerOverlaps(page)).toEqual([])
    // UX 2026-10-27: at 1366–1440 px the title keeps about seven characters (7.5rem) and the pill's account stays
    // whole, its model shortening first; the approval pill keeps its mark, its mode in its name and tooltip.
    for (const width of [1440, 1366]) {
      await page.setViewportSize({ width, height: 900 })
      const app = page.getByTestId("app")
      if ((await app.getAttribute("data-panel")) !== "open") await page.getByTestId("panel-toggle").click()
      await expect(app).toHaveAttribute("data-panel", "open")
      const fit = await page.getByTestId("header").evaluate((header) => {
        const title = header.querySelector<HTMLElement>('[data-testid="header-title"]')!
        const account = header.querySelector<HTMLElement>('[data-testid="running-on"] [data-part="account"]')!
        const text = document.createRange()
        text.selectNodeContents(account)
        const style = getComputedStyle(header)
        return {
          header: header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          title: title.getBoundingClientRect().width,
          full: title.scrollWidth,
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          cut: text.getBoundingClientRect().width - account.getBoundingClientRect().width,
        }
      })
      const where = `${width} px, a ${Math.round(fit.header)} px header`
      expect(fit.title, where).toBeGreaterThanOrEqual(Math.min(7.5 * fit.rem, fit.full) - 1)
      expect(fit.cut, where).toBeLessThanOrEqual(0.01)
      expect(await headerOverlaps(page), where).toEqual([])
      const approval = page.getByTestId("approval-pill")
      await expect(approval, where).toHaveAccessibleName(/^승인 모드: \S/)
      await expect(approval, where).toHaveAttribute("title", /^승인 모드: \S/)
      // The approval pill's text goes from a header of 819 px down (shell.css).
      if (fit.header <= 819 && (await approval.getAttribute("data-mode")) !== "full")
        await expect(approval.locator(":scope > span").last(), where).toBeHidden()
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    // The composer folds by its own width (about 700 px here), in two steps: 추론 강도 and 프리셋 stay, 울트라 and 속도
    // sit behind ⋯, and 전송 shares the switcher's line.
    await expect(page.getByTestId("composer-more")).toBeVisible()
    await expect(page.getByTestId("composer-variant")).toBeVisible()
    await expect(page.getByTestId("composer-preset-wrap")).toBeVisible()
    await expect(page.getByTestId("composer-ultra-wrap")).toBeHidden()
    await expect(page.getByTestId("composer-speed-wrap")).toBeHidden()
    const send = (await page.getByTestId("composer-send").boundingBox())!
    const switcher = (await page.getByTestId("composer-switcher").boundingBox())!
    expect(Math.abs(send.y + send.height / 2 - (switcher.y + switcher.height / 2))).toBeLessThanOrEqual(4)
    await page.screenshot({ path: "e2e/test-results/header-1440-panel.png" })
  })

  // Merge round 7: the title's 7.5rem floor kept blank room after a short title, so a team main's pill read
  // `Cla… @ Claude 구…` at 1366–1440 px with the sidebar and the work panel open (decisions MR7-12). At 1366 px the
  // account was still about 8 px short, until the team pill could drop its `팀 메인 ·` for room (MR7-17).
  test("1366 and 1440 px, a short title, a Claude account and a team main's pill: the title is whole with no room after it, the account whole", async ({
    page,
  }) => {
    for (const width of [1440, 1366]) {
      await openWithBothPanels(page, width)
      const fit = await standInFit(page, () => page.getByTestId("header").evaluate(teamMainStandIns, false))
      const where = `${width} px: ${JSON.stringify(fit)}`
      // The short title is whole, and while the pill gives anything up the title has no room after its text (its
      // floor was 7.5rem, about 120 px, after a 47 px title).
      expect(fit.title, where).toBeGreaterThanOrEqual(fit.full - 1)
      expect((fit.model > 0.01 || fit.account > 0.01) && fit.title > fit.full + 1, where).toBe(false)
      expect(fit.account, where).toBeLessThanOrEqual(0.01)
      expect(await headerOverlaps(page), where).toEqual([])
    }
  })

  // MR7-17: a team main with computer use on gave the running-on pill nothing at 1440 px with the sidebar and the work
  // panel open (the pill 20 px, its dot alone) and ran 7 px past the header at 1366 px: the computer-use chip alone was
  // 152 px. The header now gives way in order (shell/header-fit.ts): the cache text (already hidden under 1100 px),
  // the chip folded to its icon (멈추기 to a mark), the team pill without its first words, the approval pill's mark
  // (already so under 820 px), the 에이전트 방식 pill's icon, the Git chip, the title's floor (5rem, then 3em), and the
  // Stop mark last, only when that makes the account whole; the model shortens before the account. In the desktop
  // shell's band (window buttons emulated).
  test("1366 and 1440 px, a team main with the computer-use chip, both panels open: items give way in order, the account is whole, nothing under the window buttons", async ({
    page,
  }) => {
    await emulateWindowControls(page)
    for (const width of [1440, 1366]) {
      await openWithBothPanels(page, width)
      const header = page.getByTestId("header")
      // A plain conversation has the room: nothing gives way.
      expect((await teamHeaderFit(page)).give, `${width} px, plain`).toBe("")
      const fit = await standInFit(page, () => header.evaluate(teamMainStandIns, true))
      const where = `${width} px: ${JSON.stringify(fit)}`
      expect(fit.account, where).toBeLessThanOrEqual(0.01)
      expect(fit.title, where).toBeGreaterThanOrEqual(fit.full - 1)
      expect(fit.overflow, where).toBeLessThanOrEqual(0)
      expect(fit.past, where).toBeLessThanOrEqual(0.5)
      expect(fit.underButtons, where).toEqual([])
      expect(await headerOverlaps(page), where).toEqual([])
      // The order: the chip first, each later step only with the ones before it.
      const steps = ["cache", "computer", "team", "approval", "harness", "git", "title", "title-min", "stop"]
      const given = fit.give.split(" ")
      expect(given, where).toEqual(steps.slice(0, given.length))
      expect(given, where).toContain("computer")
      const chip = header.getByTestId("computer-chip")
      await expect(chip.locator(".own-give-full").last(), where).toBeHidden()
      await expect(chip.locator("svg.own-give-short"), where).toBeVisible()
      await expect(header.getByTestId("team-pill").locator(".own-give-lead"), where).toBeVisible({
        visible: !given.includes("team"),
      })
      await expect(header.getByTestId("computer-stop"), where).toBeVisible({ visible: !given.includes("stop") })
      // Shortened, the title and `모델 @ 계정` have their whole text as their tooltip (the model shortens first).
      expect(fit.titleTip, where).toBe(fit.full > fit.title + 0.01 ? "팀 메인" : null)
      expect(fit.labelTip, where).toBe(fit.model > 0.01 ? fit.label : null)
      await header.screenshot({ path: `e2e/test-results/header-team-computer-${width}.png` })
    }
    // An account renamed to its 80-character limit, which even the Stop mark's room does not make whole: the kill
    // switch wins, so every step but the Stop mark's is taken and the account takes the ellipsis, its whole name in
    // the pill's name and tooltip. The title, shortened too, has its whole text as its tooltip.
    for (const width of [1366, 1280]) {
      await openWithBothPanels(page, width)
      const header = page.getByTestId("header")
      const fit = await standInFit(page, async () => {
        await header.evaluate(teamMainStandIns, true)
        await header.evaluate((node, name) => {
          node.querySelector('[data-testid="running-on"] [data-part="account"]')!.textContent = name
          node.querySelector('[data-testid="header-title"]')!.textContent = "장바구니 결제 흐름 성능 개선과 리뷰 반영"
        }, LONG_ACCOUNT)
      })
      const where = `${width} px, an 80-character account: ${JSON.stringify(fit)}`
      expect(fit.give, where).toBe("cache computer team approval harness git title title-min")
      expect(fit.account > 0.01 && !fit.accountCapped, where).toBe(true)
      await expect(header.getByTestId("computer-stop"), where).toBeVisible()
      await expect(header.getByTestId("computer-stop"), where).toHaveAccessibleName("멈추기")
      await expect(header.getByTestId("running-on-pill"), where).toHaveAccessibleName(new RegExp(` @ ${LONG_ACCOUNT}`))
      expect(fit.labelTip, where).toBe(`Claude Sonnet 4.5 @ ${LONG_ACCOUNT}`)
      expect(fit.titleTip, where).toBe("장바구니 결제 흐름 성능 개선과 리뷰 반영")
      expect(fit.overflow, where).toBeLessThanOrEqual(0)
      expect(fit.past, where).toBeLessThanOrEqual(0.5)
      expect(fit.underButtons, where).toEqual([])
      expect(await headerOverlaps(page), where).toEqual([])
    }
    // A conversation with computer use on and no team pill (a plain one, or a team main before its pill arrives), at
    // 1280 px with an account longer than its 14em cap: dropping the Stop mark would leave the name cut anyway, so
    // the kill switch stays and the account takes the ellipsis.
    await openWithBothPanels(page, 1280)
    {
      const header = page.getByTestId("header")
      const fit = await standInFit(page, async () => {
        await header.evaluate(teamMainStandIns, true)
        await header.evaluate((node) => {
          node.querySelectorAll('[data-testid="team-pill"]').forEach((pill) => pill.remove())
          node.querySelector('[data-testid="running-on"] [data-part="account"]')!.textContent =
            "디자인팀 공용 ChatGPT Pro 계정"
          node.querySelector('[data-testid="header-title"]')!.textContent = "장바구니 결제 흐름 성능 개선과 리뷰 반영"
        })
      })
      const where = `1280 px, the chip without a team pill, a 22-character account: ${JSON.stringify(fit)}`
      expect(fit.give.split(" "), where).not.toContain("stop")
      await expect(header.getByTestId("computer-stop"), where).toBeVisible()
      expect(fit.labelTip, where).toBe("Claude Sonnet 4.5 @ 디자인팀 공용 ChatGPT Pro 계정")
      expect(fit.overflow, where).toBeLessThanOrEqual(0)
    }
    // The phone's header has its second row: nothing gives way there.
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("running-on")).toBeVisible()
    await page.getByTestId("header").evaluate(teamMainStandIns, true)
    expect((await teamHeaderFit(page)).give, "375 px").toBe("")
    await expect(page.getByTestId("computer-stop").locator(".own-give-full")).toBeVisible()
  })

  test("1440 px, sidebar and work panel open, one more pill (a team main's 팀 메인 · 영역 n개): the header never runs under the panel", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "open")
    await expect(page.getByTestId("running-on")).toContainText("GPT-5.5")
    // A stand-in with the team pill's classes (shell/header.tsx TeamPill): the title is at its minimum, so the
    // running-on pill has to give the rest. With a shrink factor below 1 it gave only that share and ⋯ went under
    // the panel (UX merge 2026-10-27, the team suite's session ⋯ clicks).
    // Stand-ins go in until the title is at its minimum, the point where the pill must give way: one more stand-in no
    // longer narrows it. (Its `min-width` is a `calc-size()`, never more than the title itself, merge round 7, so the
    // floor is not read from the computed style.)
    const added = await page.getByTestId("header-title").evaluate((title) => {
      const texts = ["팀 메인 · 영역 2개", "+3", "+3", "+3", "+3", "+3"]
      let placed = 0
      for (const text of texts) {
        const before = title.getBoundingClientRect().width
        const pill = document.createElement("span")
        pill.className =
          "own-target inline-flex h-7 shrink-0 items-center rounded-full border border-own-border px-2.5 text-[12px]"
        pill.dataset.testid = "e2e-crowd"
        pill.textContent = text
        title.after(pill)
        placed++
        if (before - title.getBoundingClientRect().width < 0.5) return { placed, atMinimum: true }
      }
      return { placed, atMinimum: false }
    })
    expect(added.atMinimum).toBe(true)
    const fit = await page.getByTestId("header").evaluate((header) => ({
      right: header.getBoundingClientRect().right,
      scroll: header.scrollWidth - header.clientWidth,
      menu: header.querySelector('[data-testid="session-menu"]')!.getBoundingClientRect().right,
      toggle: header.querySelector('[data-testid="panel-toggle"]')!.getBoundingClientRect().right,
    }))
    expect(fit.scroll).toBeLessThanOrEqual(0)
    expect(fit.menu).toBeLessThanOrEqual(fit.right)
    expect(fit.toggle).toBeLessThanOrEqual(fit.right)
    await page.getByTestId("session-menu").click({ trial: true })
    expect(await headerOverlaps(page)).toEqual([])
  })

  test("1024 px without the work panel: the composer has room and does not fold", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 })
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("app")).toHaveAttribute("data-panel", "closed")
    await expect(page.getByTestId("composer-send")).toBeVisible()
    await expect(page.getByTestId("composer-more")).toBeHidden()
    expect(await headerOverlaps(page)).toEqual([])
  })

  test("1024, 1152 and 1280 px, the work panel open or closed: the title keeps about eight characters, the cache text goes first", async ({
    page,
  }) => {
    for (const width of [1024, 1152, 1280])
      for (const panel of ["closed", "open"] as const) {
        await page.setViewportSize({ width, height: 800 })
        await page.goto(`/srv/local/s/${first!.id}`)
        const app = page.getByTestId("app")
        await expect(page.getByTestId("running-on")).toContainText("GPT-5.5")
        if (
          (await app.getAttribute("data-sidebar-mode")) === "column" &&
          (await app.getAttribute("data-sidebar")) !== "open"
        )
          await page.getByTestId("sidebar-toggle").click()
        if ((await app.getAttribute("data-panel")) !== panel) await page.getByTestId("panel-toggle").click()
        await expect(app).toHaveAttribute("data-panel", panel)
        const fit = await page.getByTestId("header").evaluate((header) => {
          const title = header.querySelector<HTMLElement>('[data-testid="header-title"]')!
          return {
            width: header.getBoundingClientRect().width,
            shown: title.clientWidth,
            full: title.scrollWidth,
            em: parseFloat(getComputedStyle(title).fontSize),
            give: header.dataset.give ?? "",
            cache: Array.from(header.querySelectorAll(".own-sw-pill-cache")).map(
              (node) => getComputedStyle(node).display,
            ),
          }
        })
        // The whole title, or at least eight Korean characters (one em each) before the ellipsis.
        expect({ width, panel, room: Math.min(fit.full, 8 * fit.em) <= fit.shown + 1 }).toEqual({
          width,
          panel,
          room: true,
        })
        if (fit.width <= 1099) expect(fit.cache.filter((display) => display !== "none")).toEqual([])
        // A plain conversation has the room: nothing of the give-way order (shell/header-fit.ts) is taken.
        expect({ width, panel, give: fit.give }).toEqual({ width, panel, give: "" })
        expect(await headerOverlaps(page)).toEqual([])
      }
  })

  test("375 px: a conversation's header is two rows at most; the new-conversation screen keeps the 에이전트 방식 pill", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`/srv/local/s/${first!.id}`)
    const header = page.getByTestId("header")
    await expect(page.getByTestId("running-on")).toBeVisible()
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(96)
    await expect(page.getByTestId("harness-pill")).toBeHidden()
    // The phone's composer is below the second fold step: 추론 강도 and 프리셋 sit behind ⋯ too.
    await expect(page.getByTestId("composer-variant")).toBeHidden()
    await expect(page.getByTestId("composer-preset-wrap")).toBeHidden()
    await expect(page.getByTestId("composer-more")).toBeVisible()
    // The phone's new-conversation screen (a project) keeps the pill: it is the only place for the one-time pick.
    await page.goto("/")
    await page.getByTestId("project-row").first().getByTestId("project-new-session").click()
    await expect(page).toHaveURL(/\/srv\/local\/p\//)
    await expect(page.getByTestId("harness-pill")).toBeVisible()
    await page.goto("/settings/general")
    await expect(page.getByTestId("return-to-chat")).toBeHidden()
  })

  test("session ⋯ › 에이전트 방식 바꾸기… opens the menu where the header pill is hidden, and gives focus back", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("harness-pill")).toBeHidden()
    await page.getByTestId("session-menu").click()
    await page.getByTestId("session-menu-harness").click()
    const menu = page.getByTestId("harness-menu")
    await expect(menu).toHaveAttribute("data-placed", "true")
    await expect(menu.getByTestId("harness-codex")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId("session-menu")).toBeFocused()
  })

  test("pages hide the work panel and give it back; Ctrl+P on a page returns to the conversation's files tab", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/srv/local/s/${first!.id}`)
    const app = page.getByTestId("app")
    await expect(app).toHaveAttribute("data-panel", "open")
    await page.getByTestId("header-settings").click()
    await expect(page.getByTestId("page-settings")).toBeVisible()
    await expect(app).toHaveAttribute("data-panel", "closed")
    await expect(page.getByTestId("panel")).toHaveAttribute("inert", "")
    await expect(page.getByTestId("panel-toggle")).toHaveCount(0)
    await page.getByTestId("return-to-chat").click()
    await expect(page).toHaveURL(new RegExp(`/srv/local/s/${first!.id}$`))
    await expect(app).toHaveAttribute("data-panel", "open")
    await page.getByTestId("header-settings").click()
    await expect(page.getByTestId("page-settings")).toBeVisible()
    await page.keyboard.press("Control+KeyP")
    await expect(page).toHaveURL(new RegExp(`/srv/local/s/${first!.id}$`))
    await expect(app).toHaveAttribute("data-panel", "open")
    await expect(page.getByRole("tab", { name: "파일" })).toHaveAttribute("aria-selected", "true")
  })

  test("설정, 한도 and 계정 open their page and close it again (mouse, Enter, Space); aria-pressed follows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/srv/local/s/${first!.id}`)
    const conversation = new RegExp(`/srv/local/s/${first!.id}$`)
    const pages = [
      { button: "sidebar-settings", page: "page-settings" },
      { button: "sidebar-limits", page: "page-limits" },
      { button: "sidebar-accounts", page: "page-accounts" },
      { button: "header-settings", page: "page-settings" },
    ]
    for (const item of pages) {
      const button = page.getByTestId(item.button)
      await expect(button).toHaveAttribute("aria-pressed", "false")
      await button.click()
      await expect(page.getByTestId(item.page)).toBeVisible()
      await expect(button).toHaveAttribute("aria-pressed", "true")
      await button.click()
      await expect(page).toHaveURL(conversation)
      await expect(page.getByTestId(item.page)).toHaveCount(0)
      await expect(button).toHaveAttribute("aria-pressed", "false")
    }
    // Keyboard: Enter opens, Space closes; the focus stays on the button.
    const limits = page.getByTestId("sidebar-limits")
    await limits.focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("page-limits")).toBeVisible()
    await expect(limits).toBeFocused()
    await page.keyboard.press("Space")
    await expect(page).toHaveURL(conversation)
    await expect(limits).toHaveAttribute("aria-pressed", "false")
    // Another page's button switches pages instead of closing: 한도 → 계정 → 계정 again back to the conversation.
    await limits.click()
    await page.getByTestId("sidebar-accounts").click()
    await expect(page.getByTestId("page-accounts")).toBeVisible()
    await expect(limits).toHaveAttribute("aria-pressed", "false")
    await page.getByTestId("sidebar-accounts").click()
    await expect(page).toHaveURL(conversation)
  })

  test("a running conversation's 에이전트 방식 menu says why it is locked, takes focus and closes with Escape", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/")
    await page.getByTestId("project-row").first().getByTestId("project-new-session").click()
    const composer = page.locator("#own-composer-input")
    await composer.fill("[slow 20000] 천천히 답해 주세요")
    await composer.press("Control+Enter")
    await expect(page).toHaveURL(/\/srv\/local\/s\//)
    await expect(page.getByTestId("composer-stop")).toBeVisible()
    const pill = page.getByTestId("harness-pill")
    await pill.click()
    const menu = page.getByTestId("harness-menu")
    await expect(menu.getByTestId("harness-menu-blocked")).toHaveText(
      "지금 실행 중이라 바꿀 수 없어요. 응답이 끝나면 다시 열어 주세요.",
    )
    for (const id of ["codex", "pi", "opencode"]) await expect(menu.getByTestId(`harness-${id}`)).toBeDisabled()
    // Every row is locked, so the menu itself has the focus and Escape closes it.
    await expect(menu).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(pill).toBeFocused()
    await page.getByTestId("composer-stop").click()
    await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  })
})
