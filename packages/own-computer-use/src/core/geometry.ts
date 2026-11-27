export * as Geometry from "./geometry.js"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"

/**
 * Coordinate spaces (ARCHITECTURE.md §2):
 * - physical: device pixels of the virtual desktop. The helper is Per-Monitor-V2 aware, so every coordinate it reports
 *   or accepts is physical, and monitors left of or above the primary have negative origins.
 * - image: pixels of one returned screenshot (a `Frame`). The model only ever sees and sends image coordinates.
 */

export const Point = Schema.Struct({ x: Schema.Int, y: Schema.Int })
export type Point = typeof Point.Type

export const Rect = Schema.Struct({ x: Schema.Int, y: Schema.Int, width: NonNegativeInt, height: NonNegativeInt })
export type Rect = typeof Rect.Type

export const Display = Schema.Struct({
  /** Stable index within one layout; the model's `display` argument. */
  id: NonNegativeInt,
  primary: Schema.Boolean,
  /** Physical virtual-desktop pixels; never empty. */
  bounds: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: PositiveInt, height: PositiveInt }),
  /** DPI scale (1 = 96 dpi). Informational only: coordinates are physical either way. */
  scale: Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 8 })),
  name: optional(Schema.String),
})
export type Display = typeof Display.Type

export interface Layout {
  readonly monitors: ReadonlyArray<Display>
  /** Bounding box of every monitor. */
  readonly virtual: Rect
  /** Changes whenever a monitor is added, removed, moved, resized or rescaled; frames of another hash are stale. */
  readonly hash: string
}

export interface Size {
  readonly width: number
  readonly height: number
}

/** One returned screenshot: which physical rectangle the image shows and at what size. */
export interface Frame {
  readonly captureId: string
  readonly displayId: number
  readonly physical: Rect
  readonly image: Size
  /** The size tier it was taken at; screenshots attached to later actions reuse it, so coordinates keep their scale. */
  readonly tier: Tier
  readonly layoutHash: string
  readonly at: number
  /**
   * The windows on screen right before the capture (ids) and their apps (normalized exe names): a click on a window
   * that was not there, of an app that had none, is refused (`target_changed`). Absent when the list failed.
   */
  readonly seen?: { readonly windows: ReadonlyArray<string>; readonly apps: ReadonlyArray<string> }
}

export interface Limits {
  readonly maxLongEdge: number
  readonly maxPixels: number
}

/**
 * Image size tiers. Both stay inside core's pass-through limits (2000x2000, 5 MiB base64; `core/src/image.ts`), so core
 * never rescales a screenshot after we return it — a rescale would silently break the image→physical mapping.
 */
export const TIERS = {
  standard: { maxLongEdge: 1568, maxPixels: 1_150_000 },
  high: { maxLongEdge: 2000, maxPixels: 4_000_000 },
} as const satisfies Record<string, Limits>
export type Tier = keyof typeof TIERS

export function layout(monitors: ReadonlyArray<Display>): Layout {
  const sorted = monitors.toSorted((left, right) => left.id - right.id)
  const left = Math.min(...sorted.map((item) => item.bounds.x))
  const top = Math.min(...sorted.map((item) => item.bounds.y))
  const right = Math.max(...sorted.map((item) => item.bounds.x + item.bounds.width))
  const bottom = Math.max(...sorted.map((item) => item.bounds.y + item.bounds.height))
  return {
    monitors: sorted,
    virtual:
      sorted.length === 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: left, y: top, width: right - left, height: bottom - top },
    hash: layoutHash(sorted),
  }
}

export function layoutHash(monitors: ReadonlyArray<Display>) {
  const key = monitors
    .toSorted((left, right) => left.id - right.id)
    .map((item) => [
      item.id,
      item.primary,
      item.bounds.x,
      item.bounds.y,
      item.bounds.width,
      item.bounds.height,
      item.scale,
    ])
  return createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16)
}

export function display(value: Layout, id: number) {
  return value.monitors.find((item) => item.id === id)
}

export function primary(value: Layout) {
  return value.monitors.find((item) => item.primary) ?? value.monitors[0]
}

export function displayAt(value: Layout, point: Point) {
  return value.monitors.find((item) => contains(item.bounds, point))
}

export function contains(rect: Rect, point: Point) {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height
}

/**
 * The largest size with the source aspect ratio inside `limits`: never upscales, integer sides, and each side within
 * one pixel of the exact scaled value. The epsilon keeps an exact fit (e.g. 1568) from flooring to 1567.
 */
export function fitImage(width: number, height: number, limits: Limits) {
  const scale = Math.min(
    1,
    limits.maxLongEdge / Math.max(width, height),
    Math.sqrt(limits.maxPixels / (width * height)),
  )
  return {
    width: Math.max(1, Math.floor(width * scale + 1e-9)),
    height: Math.max(1, Math.floor(height * scale + 1e-9)),
    scale,
  }
}

/**
 * Image pixel → physical pixel (the centre of the physical area the image pixel covers), or `undefined` when the point is
 * outside the image. The result is clamped into the captured rectangle against rounding at the far edges.
 */
export function toPhysical(frame: Frame, point: Point): Point | undefined {
  if (!inside(frame.image, point)) return undefined
  const sx = frame.physical.width / frame.image.width
  const sy = frame.physical.height / frame.image.height
  return {
    x: clamp(
      frame.physical.x + Math.floor((point.x + 0.5) * sx),
      frame.physical.x,
      frame.physical.x + frame.physical.width - 1,
    ),
    y: clamp(
      frame.physical.y + Math.floor((point.y + 0.5) * sy),
      frame.physical.y,
      frame.physical.y + frame.physical.height - 1,
    ),
  }
}

/**
 * Physical pixel → image pixel of `frame`, or `undefined` when the point is outside the captured rectangle. Mapping the
 * physical pixel's centre makes `toImage(toPhysical(p))` return `p` exactly for every downscaled frame.
 */
export function toImage(frame: Frame, point: Point): Point | undefined {
  if (!contains(frame.physical, point)) return undefined
  return {
    x: Math.min(
      frame.image.width - 1,
      Math.floor(((point.x - frame.physical.x + 0.5) * frame.image.width) / frame.physical.width),
    ),
    y: Math.min(
      frame.image.height - 1,
      Math.floor(((point.y - frame.physical.y + 0.5) * frame.image.height) / frame.physical.height),
    ),
  }
}

/**
 * `[x0, y0, x1, y1]` in image pixels (exclusive far corner, so `[0, 0, width, height]` is the whole image) → the covering
 * physical rectangle, or `undefined` when the region is empty, inverted or leaves the image.
 */
export function regionToPhysical(frame: Frame, region: readonly [number, number, number, number]): Rect | undefined {
  const [x0, y0, x1, y1] = region
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > frame.image.width || y1 > frame.image.height) return undefined
  const sx = frame.physical.width / frame.image.width
  const sy = frame.physical.height / frame.image.height
  const left = Math.floor(x0 * sx)
  const top = Math.floor(y0 * sy)
  const right = Math.min(frame.physical.width, Math.ceil(x1 * sx))
  const bottom = Math.min(frame.physical.height, Math.ceil(y1 * sy))
  return { x: frame.physical.x + left, y: frame.physical.y + top, width: right - left, height: bottom - top }
}

function inside(size: Size, point: Point) {
  return point.x >= 0 && point.y >= 0 && point.x < size.width && point.y < size.height
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}
