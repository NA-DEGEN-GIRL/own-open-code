// The desktop composer's tool row (composer-row pass, 2026-11-22): the user's desktop app with voice input on drew the
// microphone's box over `모델 @ 계정` and cut the model to `De…` and the preset to `프리셋: 평…`. With a mouse, at 1024,
// 1366 and 1920 px, in the 720–799 px composer band below its cap and under 720 px, with voice input off and on and a
// long account and preset name: no two controls overlap, none leaves the toolbar, and a label is shortened only on a
// full line. Runs on the `desktop` project only (the PC's own page).
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"

interface World {
  readonly project: string
  readonly sessions: Readonly<Record<string, string>>
  readonly presets: Readonly<Record<string, string>>
  readonly accounts: Readonly<Record<string, string>>
}

function world(): World {
  const file = path.join(process.env.OWN_WEB_MOBILE_TMP ?? "", "backend-main.json")
  if (!fs.existsSync(file)) throw new Error(`no demo world state at ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as World
}

test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "a desktop window with a mouse"))

const LONG_ACCOUNT = "local-flash-model-q4-0001 로컬 서버"
const LONG_PRESET = "평소 작업용 — 탐색은 가볍게, 리뷰는 꼼꼼하게"
/** 1024, 1366 and 1920 have the composer at its 760 px cap, 790 in the 720–799 px band below it, 760 under 720 px. */
const WIDTHS = [1024, 1366, 1920, 790, 760]

/** One own.accounts call from the PC's own page (`local` scope); the answer's `output`. */
async function rpc(page: Page, method: string, input: unknown, directory?: string) {
  const answer = await page.evaluate(
    async (call) => {
      const url = `/api/rpc/own.accounts/${call.method}?location%5Bdirectory%5D=${encodeURIComponent(call.directory)}`
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: call.input }),
      })
      return { status: response.status, body: (await response.json()) as { output?: unknown } }
    },
    { method, input, directory: directory ?? world().project },
  )
  expect(answer.status, `${method} ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body.output as Record<string, unknown>
}

/**
 * The toolbar's problems: controls whose boxes intersect, controls outside the bar, and a shortened label (the model,
 * the account below its cap, the preset) on a line that still has room.
 */
function problems(page: Page) {
  return page
    .locator(".own-cp-bar")
    .first()
    .evaluate((bar) => {
      const visible = (element: Element) =>
        element.getClientRects().length > 0 && (element as HTMLElement).checkVisibility()
      const controls = [...bar.querySelectorAll<HTMLElement>("button, label.own-cp-tool")].filter(visible)
      const name = (element: HTMLElement) => element.dataset.testid ?? element.className
      const found = controls.flatMap((one, index) =>
        controls.slice(index + 1).flatMap((other) => {
          if (one.contains(other) || other.contains(one)) return []
          const a = one.getBoundingClientRect()
          const b = other.getBoundingClientRect()
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          return x > 0.5 && y > 0.5 ? [`overlap: ${name(one)} × ${name(other)} (${x.toFixed(1)} px)`] : []
        }),
      )
      const edge = bar.getBoundingClientRect()
      const outside = controls.flatMap((control) => {
        const box = control.getBoundingClientRect()
        return box.left < edge.left - 0.5 || box.right > edge.right + 0.5 ? [`outside the bar: ${name(control)}`] : []
      })
      const style = getComputedStyle(bar)
      const inner = edge.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const gap = parseFloat(style.columnGap) || 0
      const items = [...bar.children].filter(visible)
      const cut = (part: HTMLElement) => {
        const range = document.createRange()
        range.selectNodeContents(part)
        const width = part.getBoundingClientRect().width
        if (range.getBoundingClientRect().width <= width + 0.5) return false
        const cap = parseFloat(getComputedStyle(part).maxWidth)
        return Number.isNaN(cap) || width + 0.5 < cap
      }
      const labels = [
        ...bar.querySelectorAll<HTMLElement>(
          '[data-testid="composer-switcher-label"] > [data-part="model"], [data-testid="composer-switcher-label"] > [data-part="account"], [data-testid="composer-preset"] .own-cp-tool-label',
        ),
      ].filter((part) => visible(part) && getComputedStyle(part).position !== "absolute")
      const roomy = labels.filter(cut).flatMap((part) => {
        const box = part.getBoundingClientRect()
        const line = items.filter((item) => {
          const other = item.getBoundingClientRect()
          return other.top < box.bottom && other.bottom > box.top
        })
        const used = line.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0) + gap * (line.length - 1)
        const room = inner - used
        return room > 2 ? [`shortened with ${room.toFixed(1)} px free: ${part.textContent}`] : []
      })
      return [...found, ...outside, ...roomy]
    })
}

async function composerWidth(page: Page) {
  return page
    .locator(".own-cp-box")
    .first()
    .evaluate((box) => box.clientWidth)
}

async function open(page: Page, key: string) {
  const id = world().sessions[key]!
  await page.goto(`/srv/local/s/${id}`)
  await page.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
  await expect(page.getByTestId("running-on").first()).not.toContainText("own-codex", { timeout: 60_000 })
  await page.getByTestId("composer-switcher").first().waitFor()
  await page.getByTestId("composer-preset").first().waitFor()
  await page.mouse.move(0, 0)
}

test("the composer's tools never overlap and its labels use the room before an ellipsis", async ({ page }) => {
  test.setTimeout(600_000)
  const state = world()
  await page.goto("/e2e/ime-harness.html")
  const accounts = (await rpc(page, "accounts.list", {})).accounts as ReadonlyArray<{ id: string; label: string }>
  const deepseek = accounts.find((account) => account.id === state.accounts.deepseek)!
  const saved = await rpc(page, "presets.set", {
    preset: {
      name: LONG_PRESET,
      group: "ds",
      workers: { mode: "same", roles: {} },
      delegation: "on-request",
      caps: { concurrent: 3, perMessage: 6, perSession: null },
      ultraCaps: null,
    },
  })
  const long = (saved.preset as { id: string }).id
  const seen: string[] = []
  const found: string[] = []
  try {
    await rpc(page, "accounts.update", { accountID: deepseek.id, label: LONG_ACCOUNT })
    await rpc(page, "session.preset.apply", { sessionID: state.sessions.level, presetID: long })
    for (const voice of [false, true]) {
      if (voice) {
        await rpc(page, "voice.key.set", { provider: "openai", key: "sk-test-composer-row-fake" })
        await rpc(page, "voice.set", { enabled: true, provider: "openai" })
      }
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 })
        for (const key of ["level", "enemy"]) {
          await open(page, key)
          if (voice) await page.getByTestId("voice-start").first().waitFor()
          await expect(page.getByTestId("composer-preset").first()).toContainText(key === "level" ? "평소 작업용" : "")
          // limit-fit.ts settles a frame after the toolbar's last change.
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
          const where = `${width} px, composer ${await composerWidth(page)} px, voice ${voice ? "on" : "off"}, ${key}`
          seen.push(where)
          found.push(...(await problems(page)).map((problem) => `${where}: ${problem}`))
        }
      }
    }
  } finally {
    await rpc(page, "voice.set", { enabled: false })
    await rpc(page, "session.preset.apply", { sessionID: state.sessions.level, presetID: state.presets.deepseek })
    await rpc(page, "presets.remove", { presetID: long })
    await rpc(page, "accounts.update", { accountID: deepseek.id, label: deepseek.label })
  }
  expect(found).toEqual([])
  // One window puts the composer in the 720–799 px band below its cap.
  expect(
    seen.some((where) => /composer 7[2-4]\d px/.test(where)),
    seen.join("\n"),
  ).toBe(true)
})
