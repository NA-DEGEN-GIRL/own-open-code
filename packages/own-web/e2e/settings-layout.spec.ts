// Settings shell layout (03 §5.7) against the real server. A conversation is opened first: its lazy transcript
// stylesheet carries a second Tailwind root whose base utilities once beat the settings page's `tablet:` variants,
// which stacked the section list above the page at every width.
import { expect, test, type Locator, type Page } from "@playwright/test"
import { backend, scrollTraps, wheelAt, wheelPoints } from "./support"

const state = backend()
const [first] = state.sessions

async function openSettingsFromConversation(page: Page) {
  await page.goto(`/srv/local/s/${first!.id}`)
  await expect(page.getByTestId("transcript-body")).toBeVisible()
  await page.getByTestId("sidebar-settings").click()
  await expect(page).toHaveURL(/\/settings$/)
}

test.describe("settings layout", () => {
  test("1280 px: the section list sits beside the page and stays put while the page scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openSettingsFromConversation(page)
    const settings = page.getByTestId("page-settings")
    await expect(settings).toHaveAttribute("data-layout", "split")
    const nav = page.getByTestId("settings-nav")
    const content = page.getByTestId("settings-content")
    // `/settings` on a wide column is the first section, beside the list.
    await expect(settings).toHaveAttribute("data-section", "general")
    await expect(nav.getByRole("link", { name: "일반", exact: true })).toHaveAttribute("aria-current", "page")

    await nav.getByRole("link", { name: "프리셋", exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/presets$/)
    await expect(page.getByTestId("settings-presets")).toBeVisible()
    await expect(nav.getByRole("link", { name: "프리셋", exact: true })).toHaveAttribute("aria-current", "page")
    const navBox = (await nav.boundingBox())!
    const contentBox = (await content.boundingBox())!
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(contentBox.x + 1)
    expect(Math.abs(navBox.y - contentBox.y)).toBeLessThan(2)
    await expect(page.getByTestId("settings-accounts-link")).toBeVisible()

    // A long page scrolls in its own column; the list does not move.
    await nav.getByRole("link", { name: "단축키", exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/shortcuts$/)
    await expect.poll(() => content.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
    await content.evaluate((node) => (node.scrollTop = node.scrollHeight))
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    expect((await nav.boundingBox())!.y).toBe(navBox.y)
    await expect(nav.getByRole("link", { name: "일반", exact: true })).toBeInViewport()
    // The next section starts at its top.
    await nav.getByRole("link", { name: "화면 배치", exact: true }).click()
    await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBe(0)

    // Keyboard: the arrows move between sections across the groups, Enter opens one.
    await nav.getByRole("link", { name: "화면 배치", exact: true }).focus()
    await page.keyboard.press("ArrowDown")
    await expect(nav.getByRole("link", { name: "단축키", exact: true })).toBeFocused()
    await nav.getByRole("link", { name: "음성 입력", exact: true }).focus()
    await page.keyboard.press("ArrowDown")
    await expect(page.getByTestId("settings-accounts-link")).toBeFocused()
    await page.keyboard.press("End")
    await expect(page.getByTestId("settings-manual-link")).toBeFocused()
    await page.keyboard.press("Home")
    await expect(nav.getByRole("link", { name: "일반", exact: true })).toBeFocused()
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("Enter")
    // Up from the first wraps to 설명서, then the last section (업데이트 since UPD, 2026-11-04).
    await expect(page).toHaveURL(/\/settings\/updates$/)
    // Beside a page the hint is the link's tooltip, not part of its name.
    await expect(nav.getByRole("link", { name: "자동 전환", exact: true })).toHaveAttribute("title", /자동 전환/)
  })

  test("375 px: the list drills down into a page and back", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/settings")
    const settings = page.getByTestId("page-settings")
    await expect(settings).toHaveAttribute("data-layout", "stacked")
    await expect(settings).toHaveAttribute("data-view", "list")
    await expect(page.getByTestId("settings-content")).toHaveCount(0)
    const nav = page.getByTestId("settings-nav")
    await expect(nav.getByRole("link", { name: "컴퓨터 사용 (실험)", exact: true })).toBeAttached()
    await expect(nav.locator("[aria-current]")).toHaveCount(0)

    await nav.getByRole("link", { name: "프리셋", exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/presets$/)
    await expect(settings).toHaveAttribute("data-view", "page")
    await expect(page.getByTestId("settings-nav")).toHaveCount(0)
    await expect(page.getByTestId("settings-presets")).toBeVisible()
    await expect(page.getByRole("heading", { name: "프리셋", level: 1 })).toBeFocused()
    const box = (await page.getByTestId("settings-content").boundingBox())!
    expect(box.width).toBeLessThanOrEqual(375)

    await page.getByTestId("settings-back").click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(settings).toHaveAttribute("data-view", "list")
    await expect(page.getByTestId("settings-nav-presets")).toBeFocused()
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/presets$/)
    await expect(page.getByTestId("settings-presets")).toBeVisible()

    // A deep link opens the page with its way back to the list.
    await page.goto("/settings/compaction")
    await expect(settings).toHaveAttribute("data-view", "page")
    await expect(page.getByTestId("settings-back")).toBeVisible()
  })
})

test.describe("settings groups, hints and pages (03 §5.7)", () => {
  test("375 px: the list shows its five groups, each page with a hint, 계정 → first in 모델·계정", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/settings")
    const nav = page.getByTestId("settings-nav")
    for (const group of ["basic", "models", "agent", "connect", "advanced"])
      await expect(page.getByTestId(`settings-group-${group}`)).toBeAttached()
    await expect(page.getByTestId("settings-group-basic")).toContainText("기본")
    const models = page.getByTestId("settings-group-models")
    await expect(models.locator(".own-settings-link").first()).toHaveAttribute("data-testid", "settings-accounts-link")
    await expect(page.getByTestId("settings-group-connect").getByTestId("settings-nav-devices")).toBeVisible()
    await expect(page.getByTestId("settings-group-advanced").getByTestId("settings-nav-import")).toBeAttached()
    // Merge round 11 (MR14): 고급 holds 확장 after 다른 도구의 대화 (CRM-9) and 업데이트 last (UPD).
    await expect(page.getByTestId("settings-group-advanced").locator('[data-testid^="settings-nav-"]')).toHaveText([
      /플러그인/,
      /다른 도구의 대화/,
      /확장/,
      /업데이트/,
    ])
    // Every page link shows its hint under the label; the name stays the label alone.
    const links = nav.locator('[data-testid^="settings-nav-"]')
    const count = await links.count()
    for (let index = 0; index < count; index++)
      await expect(links.nth(index).locator(".own-settings-hint")).not.toBeEmpty()
    await expect(nav.getByRole("link", { name: "휴대폰·다른 PC", exact: true })).toBeVisible()
    await page.screenshot({ path: "e2e/test-results/settings-list-375.png", fullPage: true })
  })

  test("1440 px: the 웹 검색 options keep their label on one line", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/srv/local/s/${first!.id}`)
    await page.goto("/settings/websearch")
    const options = page.locator('button.own-rq-option[data-testid^="settings-websearch-"]')
    await expect(options.first()).toBeVisible()
    const count = await options.count()
    for (let index = 0; index < count; index++) {
      const label = (await options.nth(index).locator(".own-rq-option-main > span").first().boundingBox())!
      expect(label.height).toBeLessThan(40)
      expect(label.width).toBeGreaterThan(80)
    }
  })

  test("휴대폰·다른 PC on a service without remote access shows only the unavailable line", async ({ page }) => {
    await page.goto("/settings/devices")
    await expect(page.getByText("이 서비스에는 휴대폰·다른 PC 연결 기능이 없어요.")).toBeVisible()
    await expect(page.getByTestId("settings-content")).not.toContainText(/rpc\./)
  })

  test("에이전트 방식 and 자동 압축 on a service without own.harness say so plainly, never the RPC error", async ({
    page,
  }) => {
    // This backend loads own.accounts and own.telemetry only: every own.harness call answers `rpc.unavailable`.
    await page.goto("/settings/harness")
    const problem = page.getByTestId("settings-harness").getByTestId("prompt-problem")
    await expect(problem).toHaveText("이 서비스에서는 지시문을 볼 수 없어요.")
    await expect(problem.getByRole("button")).toHaveCount(0)
    await page.goto("/settings/compaction")
    const fallback = page.getByTestId("compaction-fallback-settings")
    await expect(fallback.getByTestId("compaction-fallback-unavailable")).toHaveText(
      "이 서비스에서는 대체 모델을 정할 수 없어요.",
    )
    await expect(fallback.getByTestId("compaction-fallback-list")).toBeHidden()
    await expect(fallback.getByTestId("compaction-fallback-mode")).toBeHidden()
    await expect(fallback.getByTestId("compaction-fallback-retry")).toHaveCount(0)
    await expect(page.getByTestId("settings-content")).not.toContainText(/RPC is unavailable|rpc\./)
  })

  test("스킬 on a service without own.import still loads, and 일반 opens right after it (MR13)", async ({ page }) => {
    // skills.list answers `rpc.unavailable` here: its copies only mark rows, so neither the page nor the import view
    // waits for them or breaks on the error (before, both pages stayed on 불러오는 중).
    await page.goto("/settings/skills")
    const content = page.getByTestId("settings-content")
    await expect(page.getByTestId("settings-skills-import")).toBeVisible()
    await expect(content.getByText("불러오는 중")).toHaveCount(0, { timeout: 45_000 })
    await page.getByTestId("settings-nav-general").click()
    await expect(page.getByTestId("page-settings")).toHaveAttribute("data-section", "general")
    await expect(content.getByText("불러오는 중")).toHaveCount(0, { timeout: 15_000 })
    await expect(content).not.toContainText(/RPC is unavailable|rpc\./)
  })

  test("서비스 상태 says what it is for and folds the troubleshooting details", async ({ page }) => {
    await page.goto("/settings/server")
    await expect(page.getByTestId("settings-server")).toContainText("문제가 있을 때만 보면 돼요")
    const details = page.getByTestId("settings-server-troubleshoot")
    await expect(details).not.toHaveAttribute("open")
    await expect(details.getByRole("button", { name: "성능 진단 복사" })).toBeHidden()
    await details.locator("summary").click()
    await expect(details.getByRole("button", { name: "성능 진단 복사" })).toBeVisible()
  })
})

// 03 §4.2 phone tier (P2-15): a page (계정, 한도, 설정 …) has no pills, so back · title · bulb, cog and ? share one row
// about the header's height; a conversation keeps its second row for the pills. `← 설정` stays on a section.
test.describe("phone page header (03 §4.2)", () => {
  test("375 px: a page's header is one row, a conversation's keeps two", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    for (const [url, title] of [
      ["/accounts", "계정"],
      ["/limits", "한도"],
      ["/settings", "설정"],
      ["/settings/general", "설정"],
    ] as const) {
      await page.goto(url)
      await expect(page.getByTestId("header-title")).toHaveText(title)
      await expect(page.getByTestId("header-settings")).toBeVisible()
      expect({ url, ...(await headerRows(page)) }).toEqual({ url, rows: 1, oneRowHigh: true })
    }
    await expect(page.getByTestId("settings-back")).toBeVisible()
    await page.goto(`/srv/local/s/${first!.id}`)
    await expect(page.getByTestId("running-on")).toBeVisible()
    expect((await headerRows(page)).rows).toBe(2)
  })
})

// 03 §4.2.2 (P2-11): a switch is a 36×20 track with its thumb inside a transparent button. A fine pointer sees the
// switch exactly as before (the button is the track); a coarse one gets a 44×44 hit box with the track centred in it.
test.describe("switches (03 §4.2.2)", () => {
  test("1440 px, fine pointer: 36×20, the thumb moves across, the accent when on", async ({ page }) => {
    await page.goto("/settings/import")
    const toggle = page.getByTestId("settings-import-sidebar")
    await expect(toggle).toHaveAttribute("role", "switch")
    await expect(toggle).toHaveAccessibleName("사이드바에 보이기")
    if ((await toggle.getAttribute("aria-checked")) === "true") await flip(toggle, "false")
    const off = await geometry(toggle)
    await flip(toggle, "true")
    const on = await geometry(toggle)
    expect(off).toMatchObject({
      button: [36, 20],
      track: [36, 20],
      hit: [0, 0],
      thumbLeft: 3,
      thumbTop: 3,
      accent: false,
    })
    expect(on).toMatchObject({
      button: [36, 20],
      track: [36, 20],
      hit: [0, 0],
      thumbLeft: 19,
      thumbTop: 3,
      accent: true,
    })
    await flip(toggle, "false")
  })

  test.describe("coarse pointer", () => {
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

    test("375 px: a 36×20 pill with its thumb centred in a 44×44 hit box; the page header keeps 44 px targets", async ({
      page,
    }) => {
      await page.goto("/settings/import")
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
      const toggle = page.getByTestId("settings-import-sidebar")
      await toggle.scrollIntoViewIfNeeded()
      const view = await geometry(toggle)
      expect(view.button[0]).toBeGreaterThanOrEqual(44)
      expect(view.button[1]).toBeGreaterThanOrEqual(44)
      expect({ track: view.track, centred: view.centred, thumbTop: view.thumbTop }).toEqual({
        track: [36, 20],
        centred: true,
        thumbTop: 3,
      })
      const checked = await toggle.getAttribute("aria-checked")
      await toggle.tap()
      await expect(toggle).not.toHaveAttribute("aria-checked", checked ?? "")
      await toggle.tap()
      await expect(toggle).toHaveAttribute("aria-checked", checked ?? "")
      expect(await headerRows(page)).toEqual({ rows: 1, oneRowHigh: true })
      const small = await page.getByTestId("header").evaluate((header) =>
        Array.from(header.querySelectorAll<HTMLElement>("button, a[href]")).flatMap((node) => {
          const box = node.getBoundingClientRect()
          return box.width > 0 && (box.width < 44 || box.height < 44) ? [node.dataset.testid ?? node.className] : []
        }),
      )
      expect(small).toEqual([])
    })
  })
})

/** How many rows the header's visible items take, and whether it is about one header high. */
async function headerRows(page: Page) {
  return page.getByTestId("header").evaluate((header) => {
    const middles = Array.from(header.children).flatMap((child) => {
      const box = child.getBoundingClientRect()
      return box.width > 0 && box.height > 0 ? [box.top + box.height / 2] : []
    })
    const rows = middles
      .toSorted((a, b) => a - b)
      .filter((middle, index, sorted) => index === 0 || middle - sorted[index - 1]! > 6).length
    const row = parseFloat(getComputedStyle(header).getPropertyValue("--own-header-h"))
    return { rows, oneRowHigh: header.getBoundingClientRect().height <= row + 1 }
  })
}

/** Clicks `toggle` until it says `checked`, and lets the thumb's 150 ms move end. */
async function flip(toggle: Locator, checked: "true" | "false") {
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", checked)
  await toggle.page().waitForTimeout(300)
}

/** The switch's button, track and thumb boxes (rounded), and whether the track shows the accent. */
async function geometry(toggle: Locator) {
  return toggle.evaluate((button) => {
    const track = button.querySelector(".own-switch-track")!
    const thumb = button.querySelector(".own-switch-thumb")!
    const [outer, inner, knob] = [button, track, thumb].map((node) => node.getBoundingClientRect())
    const probe = document.createElement("span")
    probe.style.background = "var(--own-accent)"
    document.body.append(probe)
    const accent = getComputedStyle(probe).backgroundColor
    probe.remove()
    return {
      button: [Math.round(outer!.width), Math.round(outer!.height)],
      track: [Math.round(inner!.width), Math.round(inner!.height)],
      /** How much larger the hit box is than the track. */
      hit: [Math.round(outer!.width - inner!.width), Math.round(outer!.height - inner!.height)],
      centred:
        Math.abs(outer!.left + outer!.width / 2 - (inner!.left + inner!.width / 2)) <= 0.5 &&
        Math.abs(outer!.top + outer!.height / 2 - (inner!.top + inner!.height / 2)) <= 0.5,
      thumbLeft: Math.round(knob!.left - inner!.left),
      thumbTop: Math.round(knob!.top - inner!.top),
      accent: getComputedStyle(track).backgroundColor === accent,
    }
  })
}

// 2026-11-03 (user report, 설정 > 스킬 at 150 %): the wheel must scroll a page wherever the pointer is over it: the
// column with the settings, its start and end, and the empty gutter beside it, at 100 % and at 150 % (the desktop's
// window zoom is Chromium's page zoom, which a 1.5 device scale factor over a ⅔ viewport reproduces). The window is
// short so that these pages overflow (SSH 원격 호스트 is one line on this backend: the scroll-trap check below and the
// tools suite cover the rest); the section list keeps its own scrolling and does not move the page.
for (const zoom of [1, 1.5]) {
  test.describe(`settings wheel at ${zoom * 100} %`, () => {
    test.use({ viewport: { width: Math.round(1440 / zoom), height: Math.round(320 / zoom) }, deviceScaleFactor: zoom })

    test("the wheel scrolls each page over its content and its gutter; the section list scrolls itself", async ({
      page,
    }) => {
      test.setTimeout(180_000)
      await page.goto("/settings/general")
      const settings = page.getByTestId("page-settings")
      await expect(settings).toHaveAttribute("data-layout", "split")
      const content = page.getByTestId("settings-content")
      const failed: string[] = []
      for (const section of ["general", "compaction", "mcp", "shortcuts", "presets"]) {
        await page.getByTestId(`settings-nav-${section}`).click()
        await expect(settings).toHaveAttribute("data-section", section)
        // A lazy page loads first; MCP 서버 waits for the server's MCP status, which took past 15 s while the
        // release tier ran two suites at once (2026-11-20). The same budget as the scroll-trap check below.
        await expect(content.getByText("불러오는 중")).toHaveCount(0, { timeout: 45_000 })
        await expect.poll(() => content.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(40)
        for (const point of await wheelPoints(content, page.locator(".own-settings-body")))
          if ((await wheelAt(page, content, point)) === 0) failed.push(`${section}: ${point.name}`)
      }
      expect(failed).toEqual([])

      // The list scrolls on its own and leaves the page where it was.
      const nav = page.getByTestId("settings-nav")
      await expect.poll(() => nav.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
      await content.evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }))
      const navBox = (await nav.boundingBox())!
      expect(
        await wheelAt(page, nav, { x: navBox.x + navBox.width / 2, y: navBox.y + navBox.height / 2 }),
      ).toBeGreaterThan(0)
      expect(await content.evaluate((node) => node.scrollTop)).toBe(0)

      // 계정 is a page of its own (the shell's page view scrolls), centred with gutters on both sides.
      await page.goto("/accounts")
      const view = page.getByTestId("page-view")
      await expect(page.getByTestId("page-accounts")).toBeVisible()
      await expect.poll(() => view.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(40)
      for (const point of await wheelPoints(view, page.getByTestId("page-accounts")))
        if ((await wheelAt(page, view, point)) === 0) failed.push(`accounts: ${point.name}`)
      expect(failed).toEqual([])
    })
  })
}

// The class of the 2026-11-03 bug on every page: no box inside a settings page may end the wheel's scroll chain with
// nothing of its own to scroll (`overscroll-behavior: contain` on a scroll box whose content fits).
test("no settings page holds a box that stops the wheel without scrolling", async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto("/settings/general")
  const settings = page.getByTestId("page-settings")
  const content = page.getByTestId("settings-content")
  await expect(page.getByTestId("settings-nav-general")).toBeVisible()
  const sections = await page
    .getByTestId("settings-nav")
    .locator('[data-testid^="settings-nav-"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("data-testid")!.slice("settings-nav-".length)))
  expect(sections.length).toBeGreaterThan(10)
  const traps: string[] = []
  for (const section of sections) {
    await page.getByTestId(`settings-nav-${section}`).click()
    await expect(settings).toHaveAttribute("data-section", section)
    // A lazy page loads first. Every page settles on this backend, 스킬 without own.import too (MR13).
    await expect(content.getByText("불러오는 중")).toHaveCount(0, { timeout: 45_000 })
    traps.push(...(await scrollTraps(content)).map((trap) => `${section}: ${trap}`))
  }
  expect(traps).toEqual([])
})
