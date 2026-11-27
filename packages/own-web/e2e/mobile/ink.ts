// Reading a button's picture for where its mark sits (visual polish, 2026-11-20; centre.spec.ts and browser.spec.ts):
// the ink against the button's own background, and the ink's middle against the box's.
import { expect, type Locator, type Page } from "@playwright/test"

/**
 * How far the ink of `button` sits from its box's middle, in CSS px. The ink is every pixel that differs from the
 * button's commonest colour, 3 px in from its edges (a border or a rounded corner is not the mark).
 */
export async function offset(page: Page, button: Locator) {
  await expect(button).toBeVisible()
  const picture = (await button.screenshot({ animations: "disabled", caret: "hide" })).toString("base64")
  const size = (await button.boundingBox())!
  return page.evaluate(
    async ({ picture, width }) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${picture}`)).blob())
      const canvas = new OffscreenCanvas(image.width, image.height)
      const context = canvas.getContext("2d")!
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, image.width, image.height).data
      const scale = image.width / width
      const inset = Math.round(3 * scale)
      const at = (x: number, y: number) => (y * image.width + x) * 4
      const counts = new Map<number, number>()
      for (let y = inset; y < image.height - inset; y++)
        for (let x = inset; x < image.width - inset; x++) {
          const i = at(x, y)
          const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      const background = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      const bg = [(background >> 16) & 255, (background >> 8) & 255, background & 255]
      const ink = { left: image.width, right: -1, top: image.height, bottom: -1 }
      for (let y = inset; y < image.height - inset; y++)
        for (let x = inset; x < image.width - inset; x++) {
          const i = at(x, y)
          const distance =
            Math.abs(pixels[i]! - bg[0]!) + Math.abs(pixels[i + 1]! - bg[1]!) + Math.abs(pixels[i + 2]! - bg[2]!)
          if (distance < 60) continue
          ink.left = Math.min(ink.left, x)
          ink.right = Math.max(ink.right, x + 1)
          ink.top = Math.min(ink.top, y)
          ink.bottom = Math.max(ink.bottom, y + 1)
        }
      if (ink.right < 0) return { dx: Number.NaN, dy: Number.NaN }
      return {
        dx: ((ink.left + ink.right) / 2 - image.width / 2) / scale,
        dy: ((ink.top + ink.bottom) / 2 - image.height / 2) / scale,
      }
    },
    { picture, width: size.width },
  )
}

/** The mark of `button` sits in the middle of it, within 1 px each way (soft: every mark of a test is read). */
export async function centred(page: Page, button: Locator, label: string) {
  const value = await offset(page, button)
  expect.soft(Math.abs(value.dx), `${label}: ${value.dx.toFixed(1)} px sideways`).toBeLessThanOrEqual(1)
  expect.soft(Math.abs(value.dy), `${label}: ${value.dy.toFixed(1)} px up or down`).toBeLessThanOrEqual(1)
}
