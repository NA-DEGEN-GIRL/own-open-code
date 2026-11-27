import fs from "node:fs"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import { checkoutTmp } from "./gateway/support"

export interface BackendState {
  readonly dev: string
  readonly preview: string | null
  readonly control: string
  readonly workspace: string
  readonly account: { readonly id: string; readonly providerID: string; readonly label: string }
  readonly model: string
  readonly sessions: readonly { readonly id: string; readonly title: string }[]
}

/** Written by e2e/backend.ts once the server, fakes and Vite are up. */
export function backend(): BackendState {
  return JSON.parse(fs.readFileSync(path.join(checkoutTmp("own-web-e2e"), "backend.json"), "utf8")) as BackendState
}

/** Collects console errors and CSP violations for the lifetime of the page. */
export function watchErrors(page: Page) {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

/**
 * `보내는 키` before every load of this page (03 §4.6; src/composer/send-key.ts `SEND_KEY_STORAGE`). The default is
 * `Ctrl+Enter로 보내기`; a test about sending with Enter sets `enter`.
 */
export async function useSendKey(page: Page, mode: "enter" | "modEnter") {
  await page.addInitScript((value) => localStorage.setItem("own.web.composer.sendKey.v2", value), mode)
}

/**
 * How a marker's pill lays out its styles/seps.css line (merge round 7): whether it has one, how many lines it wrapped
 * to, the lines whose first part shows its `·` (inside the clipping box; none should), and the empty room between the
 * widest line and the box's end (none worth a pixel once the pill is fitted, transcript/seps-fit.ts).
 */
export function sepsLines(marker: Locator) {
  return marker.evaluate((node) => {
    const seps = node.querySelector<HTMLElement>(".own-marker-pill > .own-seps")
    const inner = seps?.firstElementChild
    if (!seps || !inner) return { seps: false, lines: 0, dotted: [] as string[], blank: 0 }
    const box = seps.getBoundingClientRect()
    const parts = Array.from(inner.children)
      .map((part) => ({ part, rect: part.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 0)
    // Flex lines keep the parts' order: a part left of the one before it starts a line.
    const starts = parts.filter((item, index) => index > 0 && item.rect.left < parts[index - 1]!.rect.left)
    const dotted = starts.flatMap((item) =>
      getComputedStyle(item.part, "::before").content === '"·"' && item.rect.left >= box.left - 1
        ? [item.part.textContent ?? ""]
        : [],
    )
    const right = Math.max(...parts.map((item) => item.rect.right))
    return { seps: true, lines: starts.length + 1, dotted, blank: box.right - right }
  })
}

/**
 * Where a wheel over a page lands (2026-11-03, 설정 > 스킬 at 150 %: the report was that only the empty space beside
 * the column scrolled): the points of `scroller` that a wheel must scroll, at its top, middle and bottom, over the start,
 * the middle and the end of its content column `column`, and over the gutter after the column when there is one.
 */
export async function wheelPoints(scroller: Locator, column: Locator) {
  const box = (await scroller.boundingBox())!
  const body = (await column.boundingBox())!
  const rows = [box.y + Math.min(60, box.height / 4), box.y + box.height / 2, box.y + box.height - 24]
  const columns = [
    ["column start", body.x + 24],
    ["column middle", body.x + body.width / 2],
    ["column end", body.x + body.width - 24],
  ] as const
  const gutter = box.x + box.width - (body.x + body.width) > 40
  return rows.flatMap((y, row) =>
    [...columns, ...(gutter ? [["gutter", (body.x + body.width + box.x + box.width) / 2] as const] : [])].map(
      ([name, x]) => ({ name: `${name}, row ${row + 1}`, x, y }),
    ),
  )
}

/** One wheel notch down at a point; the scroller starts at its top. Answers how far it scrolled. */
export async function wheelAt(page: Page, scroller: Locator, point: { readonly x: number; readonly y: number }) {
  await scroller.evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }))
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, 120)
  // The wheel scrolls on the compositor; give it the frames to land.
  for (let frame = 0; frame < 20; frame++) {
    const top = await scroller.evaluate((node) => node.scrollTop)
    if (top > 0) return top
    await page.waitForTimeout(25)
  }
  return scroller.evaluate((node) => node.scrollTop)
}

/**
 * Boxes inside `scroller` that end the wheel's scroll chain with nothing of their own to scroll: a scroll container
 * with `overscroll-behavior` other than `auto` whose content fits it. Over one of them the wheel scrolls neither it nor
 * the page (설정 > 스킬's embedded import view, 2026-11-03). Each as `tag.class [testid]`.
 */
export function scrollTraps(scroller: Locator) {
  return scroller.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>("*")).flatMap((node) => {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      const container = /auto|scroll/.test(style.overflowY)
      const fits = node.scrollHeight <= node.clientHeight + 1
      if (!container || !fits || style.overscrollBehaviorY === "auto" || box.width === 0 || box.height === 0) return []
      return [`${node.tagName.toLowerCase()}.${node.classList[0] ?? ""} [${node.dataset.testid ?? ""}]`]
    }),
  )
}
