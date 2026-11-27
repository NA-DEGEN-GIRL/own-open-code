// The running mark (03 §7.6 `●` 실행 중, §4.4 the pill) against the real server: while a turn runs, the session's
// sidebar row and the header's model pill show the still mark (a dot in a ring, `.own-run-mark`), named
// `실행 중` for assistive technology, and the page runs no endless animation: an endless pulse or spin kept the
// compositor drawing at the display rate for as long as anything ran (own/reports/ui-perf-many-sessions-2026-10.md).
// The mark is drawn in the accent text colour and stays clear of the unread dot `•`.
import { expect, test } from "@playwright/test"
import { backend } from "./support"

const state = backend()
const session = { id: "" }

test.describe.configure({ mode: "serial" })

test.beforeAll(async ({ request }) => {
  const created = await request.post("/api/session", {
    data: {
      title: "실행 표시 e2e",
      model: { providerID: state.account.providerID, id: state.model },
      location: { directory: state.workspace },
    },
  })
  expect(created.ok()).toBe(true)
  const info = (await created.json()) as { id?: string; data?: { id: string } }
  session.id = info.data?.id ?? info.id ?? ""
})

test.afterAll(async ({ request }) => {
  if (session.id) await request.delete(`/api/session/${session.id}`)
})

test("a running session shows the still running mark in its row and the pill, and nothing animates endlessly", async ({
  page,
}, testInfo) => {
  await page.goto(`/srv/local/s/${session.id}`)
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
  const composer = page.locator("#own-composer-input")
  await expect(composer).toBeEditable()
  await composer.fill("[slow 20000] 천천히 답해 주세요")
  await composer.press("Control+Enter")
  await expect(page.getByTestId("composer-stop")).toBeVisible()

  const row = page.locator('[data-testid="session-row"]', { hasText: "실행 표시 e2e" }).first()
  const mark = row.getByTestId("status-mark")
  await expect(mark).toHaveAttribute("aria-label", "실행 중")
  await expect(mark).toHaveText("●")
  const pill = page.getByTestId("running-on-pill")
  await expect(pill).toHaveAttribute("aria-busy", "true")
  await expect(pill.getByRole("img", { name: "실행 중" })).toBeVisible()

  const drawn = await page.evaluate(() => {
    const read = (element: Element | null, pseudo?: string) => {
      if (!element) return null
      const style = getComputedStyle(element, pseudo)
      return {
        width: Math.round(Number.parseFloat(style.width)),
        height: Math.round(Number.parseFloat(style.height)),
        border: style.borderTopWidth,
        borderColor: style.borderTopColor,
        image: style.backgroundImage.startsWith("radial-gradient"),
        animation: style.animationName,
      }
    }
    const accent = document.createElement("span")
    accent.style.color = "var(--own-accent-text)"
    document.body.append(accent)
    const color = getComputedStyle(accent).color
    accent.remove()
    return {
      row: read(document.querySelector('[data-testid="session-row"] [data-testid="status-mark"].own-run-glyph'), "::before"),
      glyph: getComputedStyle(document.querySelector('[data-testid="session-row"] .own-run-glyph')!).color,
      pill: read(document.querySelector('[data-testid="running-on-pill"] .own-run-mark')),
      accent: color,
      // Endless animations anywhere on the page (the composer's own spinners included).
      endless: document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY)
        .map((animation) => (animation as CSSAnimation).animationName ?? "?"),
    }
  })
  for (const mark of [drawn.row, drawn.pill]) {
    expect(mark).not.toBeNull()
    expect(mark!.width).toBe(9)
    expect(mark!.height).toBe(9)
    // 1.5 px, snapped to whole device pixels (1 px at a scale of 1).
    expect(Number.parseFloat(mark!.border)).toBeGreaterThanOrEqual(1)
    expect(mark!.borderColor).toBe(drawn.accent)
    expect(mark!.image).toBe(true)
    expect(mark!.animation).toBe("none")
  }
  // The row's glyph stays (text, copying) but is not painted under the mark.
  expect(drawn.glyph).toBe("rgba(0, 0, 0, 0)")
  expect(drawn.endless).toEqual([])
  // For a look by eye: the row and the pill while the turn runs.
  const picture = testInfo.outputPath("running.png")
  await page.screenshot({ path: picture })
  await testInfo.attach("running-row-and-pill", { path: picture, contentType: "image/png" })

  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  await expect(row.getByTestId("status-mark")).not.toHaveAttribute("aria-label", "실행 중")
})
