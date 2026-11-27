// One manual screenshot (PLAN.md §6, §7): numbered orange boxes over the elements the text refers to, a crop around
// the element(s) the shot is about (2× device pixels) or the whole 1440×900 window, the privacy check, and WebP.
import fs from "node:fs/promises"
import path from "node:path"
import { privacyProblems, settle, type Browser, type Locator, type Page } from "./browser"

export const ORANGE = "#FF7A1A"
const OVERLAY = "manual-shot-overlay"

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ShotOptions {
  /** The crop: one or more elements (their union) or a box; omitted = the whole viewport. */
  readonly clip?: Locator | ReadonlyArray<Locator> | Box
  /** Space around the crop, in CSS pixels (default 16). */
  readonly pad?: number
  /** Numbered boxes, in order (①, ②, …); a box spans the union of a group. */
  readonly marks?: ReadonlyArray<Locator | ReadonlyArray<Locator>>
  /** Full-window shots are saved at CSS size (1440×900); `device` keeps 2×. */
  readonly scale?: "css" | "device"
}

export interface Saved {
  readonly id: string
  readonly file: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

export interface Shooter {
  shoot(page: Page, id: string, options?: ShotOptions): Promise<Saved>
  /** A PNG taken another way (a window capture), encoded and saved like a shot. */
  save(id: string, png: Buffer): Promise<Saved>
}

/**
 * A shooter that writes `<out>/<id>.webp`, encoding in a blank page of `browser`. `halvings`: how many times a picture is
 * halved first (a page drawn at several times the size it is saved at, own/scripts/readme).
 */
export async function shooter(browser: Browser, out: string, halvings = 0): Promise<Shooter> {
  const encoder = await (await browser.newContext()).newPage()
  await fs.mkdir(out, { recursive: true })
  return {
    async shoot(page, id, options = {}) {
      await settle(page)
      const problems = await privacyProblems(page)
      if (problems.length > 0) throw new Error(`${id}: personal data on screen:\n  ${problems.join("\n  ")}`)
      const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
      const first = options.clip === undefined ? undefined : Array.isArray(options.clip) ? options.clip[0] : options.clip
      if (first && "scrollIntoViewIfNeeded" in first) await (first as Locator).scrollIntoViewIfNeeded().catch(() => undefined)
      const clip = options.clip === undefined ? undefined : await union(options.clip)
      const pad = options.pad ?? 28
      const area = clip ? clamp(grow(clip, pad), viewport) : undefined
      const marks = await Promise.all(
        (options.marks ?? []).map(async (mark) => union(Array.isArray(mark) ? mark : [mark as Locator])),
      )
      const bounds = area ?? { x: 0, y: 0, width: viewport.width, height: viewport.height }
      await page.evaluate(overlay, { boxes: marks, orange: ORANGE, id: OVERLAY, bounds })
      await settle(page)
      const png = await page.screenshot({
        type: "png",
        ...(area ? { clip: area } : {}),
        // Crops and phone screens keep the device pixels (sharp when zoomed); a whole desktop window is saved at CSS size.
        scale: options.scale ?? (area || viewport.width < 600 ? "device" : "css"),
        animations: "disabled",
        caret: "hide",
      })
      await page.evaluate((overlayID) => document.getElementById(overlayID)?.remove(), OVERLAY)
      return save(id, png)
    },
    save,
  }

  async function save(id: string, png: Buffer): Promise<Saved> {
    const encoded = await webp(encoder, png, halvings)
    const file = path.join(out, `${id}.webp`)
    await Bun.write(file, encoded.bytes)
    return { id, file, bytes: encoded.bytes.byteLength, width: encoded.width, height: encoded.height }
  }
}

/** Draws numbered boxes on a page for a capture taken another way; returns the call that removes them. */
export async function markPage(page: Page, marks: ReadonlyArray<Locator | ReadonlyArray<Locator>>) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const boxes = await Promise.all(marks.map(async (mark) => union(Array.isArray(mark) ? mark : [mark as Locator])))
  await page.evaluate(overlay, {
    boxes,
    orange: ORANGE,
    id: OVERLAY,
    bounds: { x: 0, y: 0, width: viewport.width, height: viewport.height },
  })
  await settle(page)
  return () => page.evaluate((overlayID) => document.getElementById(overlayID)?.remove(), OVERLAY)
}

async function union(target: Locator | ReadonlyArray<Locator> | Box): Promise<Box> {
  if (!("boundingBox" in target) && !Array.isArray(target)) return target as Box
  const list = Array.isArray(target) ? target : [target as Locator]
  const boxes = await Promise.all(
    list.map(async (locator) => {
      const box = await locator.boundingBox({ timeout: 10_000 })
      if (!box) throw new Error(`no box for ${locator}`)
      return box
    }),
  )
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function grow(box: Box, pad: number): Box {
  return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }
}

function clamp(box: Box, viewport: { width: number; height: number }): Box {
  const x = Math.max(0, Math.floor(box.x))
  const y = Math.max(0, Math.floor(box.y))
  return {
    x,
    y,
    width: Math.min(viewport.width, Math.ceil(box.x + box.width)) - x,
    height: Math.min(viewport.height, Math.ceil(box.y + box.height)) - y,
  }
}

/** Draws the numbered boxes in a fixed layer above the page (no pointer events). */
function overlay(input: { boxes: Box[]; orange: string; id: string; bounds: Box }) {
  document.getElementById(input.id)?.remove()
  if (input.boxes.length === 0) return
  /**
   * Where a 22 px badge goes for a box: left of it (centered), outside its top-left, top-right or bottom-left corner,
   * or right of it — the first spot inside the shot whose five sample points land on no text and no control (so the
   * badge never hides a word or a button); the top-left corner inside the shot when none is free.
   */
  const place = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    bounds: { x: number; y: number; width: number; height: number },
    placed: ReadonlyArray<{ x: number; y: number }>,
  ) => {
    const middle = (top + bottom) / 2 - 11
    // A large box (a whole region of the window) gets its badge inside one of its corners.
    const large = (right - left > 360 && bottom - top > 120) || bottom - top > 400
    const candidates = large
      ? [
          { x: left + 6, y: top + 6 },
          { x: right - 28, y: top + 6 },
          { x: left + 6, y: bottom - 28 },
          { x: right - 28, y: bottom - 28 },
        ]
      : [
          { x: left - 28, y: middle },
          { x: left - 14, y: top - 20 },
          { x: right - 8, y: top - 20 },
          { x: left - 14, y: bottom - 2 },
          { x: right + 6, y: middle },
        ]
    const inside = (spot: { x: number; y: number }) =>
      spot.x >= bounds.x + 2 &&
      spot.y >= bounds.y + 2 &&
      spot.x + 22 <= bounds.x + bounds.width - 2 &&
      spot.y + 22 <= bounds.y + bounds.height - 2
    const CONTROL = "button, a, input, textarea, select, label, img, svg, [role=button], [role=option], [role=menuitem], [role=radio], [role=tab]"
    const busy = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      if (!hit) return false
      if (hit.closest(CONTROL)) return true
      return [...hit.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim())
    }
    const free = (spot: { x: number; y: number }) =>
      inside(spot) &&
      !placed.some((other) => Math.abs(other.x - spot.x) < 24 && Math.abs(other.y - spot.y) < 24) &&
      ![1, 11, 21].some((dx) => [1, 11, 21].some((dy) => busy(spot.x + dx, spot.y + dy)))
    return (
      candidates.find(free) ??
      (large
        ? { x: left + 6, y: top + 6 }
        : { x: Math.max(bounds.x + 2, left - 11), y: Math.max(bounds.y + 2, top - 11) })
    )
  }
  // A manual popover: the top layer, above open menus and modal dialogs (which are in the top layer themselves).
  const layer = document.createElement("div")
  layer.id = input.id
  layer.setAttribute("aria-hidden", "true")
  layer.setAttribute("popover", "manual")
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    maxWidth: "none",
    maxHeight: "none",
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "2147483647",
  })
  /** Badges already placed, so the next one does not cover them. */
  const taken: Array<{ x: number; y: number }> = []
  input.boxes.forEach((box, index) => {
    const frame = document.createElement("div")
    // 6 px around the element, kept inside the window (a sidebar or a panel touches its edges).
    const left = Math.max(2, box.x - 6)
    const top = Math.max(2, box.y - 6)
    const right = Math.min(innerWidth - 2, box.x + box.width + 6)
    const bottom = Math.min(innerHeight - 2, box.y + box.height + 6)
    Object.assign(frame.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
      border: `3px solid ${input.orange}`,
      borderRadius: "8px",
      boxSizing: "border-box",
      boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
    })
    const badge = document.createElement("div")
    badge.textContent = String(index + 1)
    const spot = place(left, top, right, bottom, input.bounds, taken)
    taken.push(spot)
    Object.assign(badge.style, {
      position: "fixed",
      left: `${spot.x}px`,
      top: `${spot.y}px`,
      width: "22px",
      height: "22px",
      borderRadius: "50%",
      background: input.orange,
      color: "#fff",
      font: "700 13px/22px 'Segoe UI', 'Malgun Gothic', sans-serif",
      textAlign: "center",
      boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
    })
    layer.append(frame, badge)
  })
  document.body.append(layer)
  layer.showPopover()
}

/** PNG → WebP in the blank page's canvas: quality 0.9, lower until the file is at most 150 KB (not below 0.6). */
async function webp(page: Page, png: Buffer, halvings: number) {
  const qualities = [0.9, 0.85, 0.8, 0.72, 0.65, 0.6]
  const result = await page.evaluate(
    async (input) => {
      const image = new Image()
      image.src = `data:image/png;base64,${input.png}`
      await image.decode()
      // Each halving averages four pixels into one (a bilinear draw at half size).
      const draw = (source: HTMLImageElement | HTMLCanvasElement, width: number, height: number) => {
        const target = document.createElement("canvas")
        target.width = width
        target.height = height
        target.getContext("2d")!.drawImage(source, 0, 0, width, height)
        return target
      }
      let canvas = draw(image, image.naturalWidth, image.naturalHeight)
      for (let step = 0; step < input.halvings; step++)
        canvas = draw(canvas, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2))
      const tries = []
      for (const quality of input.qualities) {
        const url = canvas.toDataURL("image/webp", quality)
        tries.push(url)
        if (url.length * 0.75 <= input.budget) break
      }
      return { url: tries.at(-1)!, width: canvas.width, height: canvas.height }
    },
    { png: png.toString("base64"), qualities, budget: 150 * 1024, halvings },
  )
  const bytes = Buffer.from(result.url.slice(result.url.indexOf(",") + 1), "base64")
  return { bytes, width: result.width, height: result.height }
}
