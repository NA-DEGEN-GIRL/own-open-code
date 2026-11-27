// 팀 룸's framing (06 §9.9, 2026-11-27): where the seats go and what the camera sees, as plain numbers so it is tested
// without WebGL. The scene (./scene.ts) draws with an orthographic camera looking along the framing's view; this module
// picks the grid and the view that draw the room largest on this canvas and the frustum that fills {@link FILL} of the
// canvas's limiting side with the floor, the seats and the labels above the heads, centred. The scene calls it again on
// every resize and whenever the seats change.

/**
 * From the room toward the camera: from the front, above and a little from the right (the first, preferred), or less
 * from the right. A seat column seen from the right runs diagonally across the canvas; in a tall panel a straighter view
 * can draw it much larger, so a later view wins only when it draws at least {@link PREFER} times larger than the first.
 */
export const VIEWS = [0.3, 0.15, 0].map((x) => normalize({ x, y: 1.15, z: 1.1 }))
const PREFER = 1.2
/** The share of the canvas's limiting side the room fills, labels included. */
export const FILL = 0.88
export const STEP_X = 2.2
export const STEP_Z = 2.4
/** A seat's label hangs from this point above the head, in the seat's own coordinates. */
export const ANCHOR = { x: 0, y: 2.05, z: -0.35 }
/** What one seat can cover (desk, chair, shadow disc, the character with hair, a hat or a raised hand). */
const SEAT = { x: 0.95, back: -1, front: 0.9, top: 2 }
/** The badge (`?`, `z`, `!`) sits this many pixels above and right of a label. */
const BADGE = 8

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Framing {
  /** Each seat's position on the floor, in the order given. */
  readonly seats: ReadonlyArray<{ readonly x: number; readonly z: number }>
  readonly cols: number
  readonly rows: number
  /** The floor's size; its top is at y 0. */
  readonly floor: { readonly width: number; readonly depth: number }
  /** From the room toward the camera (one of {@link VIEWS}): the camera looks along it at the origin. */
  readonly view: Vec3
  /** The orthographic frustum, in view units around the line through the origin along {@link view}. */
  readonly frustum: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
  /** Canvas pixels per world unit. */
  readonly scale: number
}

/**
 * The framing of `count` seats on a canvas of `canvas` CSS pixels whose labels are at most `label` pixels: every grid
 * from one row to one column is tried with each view, and the one that draws largest wins (a tie keeps fewer columns;
 * another view than the first must win by {@link PREFER}).
 */
export function frame(count: number, canvas: Size, label: Size): Framing {
  const best = VIEWS.map((direction) =>
    Array.from({ length: Math.max(1, count) }, (_, index) =>
      arrange(count, index + 1, direction, canvas, label),
    ).reduce((best, next) => (next.scale > best.scale * 1.001 ? next : best)),
  )
  const first = best[0]!
  return best
    .filter((option) => option === first || option.scale > first.scale * PREFER)
    .reduce((chosen, next) => (next.scale > chosen.scale ? next : chosen))
}

function arrange(count: number, cols: number, direction: Vec3, canvas: Size, label: Size): Framing {
  const axes = axesOf(direction)
  const rows = Math.max(1, Math.ceil(count / cols))
  const seats = Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / cols)
    const inRow = Math.min(cols, count - row * cols)
    return { x: ((index % cols) - (inRow - 1) / 2) * STEP_X, z: -(row - (rows - 1) / 2) * STEP_Z }
  })
  const floor = { width: cols * STEP_X + 1.3, depth: rows * STEP_Z + 1 }
  const plain = { left: 0, right: 0, top: 0, bottom: 0 }
  const tag = { left: label.width / 2, right: label.width / 2 + BADGE, top: label.height + BADGE, bottom: 0 }
  const points = [
    ...corners(
      { x: -floor.width / 2, y: -0.12, z: -floor.depth / 2 },
      { x: floor.width / 2, y: 0, z: floor.depth / 2 },
    ),
    ...seats.flatMap((seat) =>
      corners(
        { x: seat.x - SEAT.x, y: 0, z: seat.z + SEAT.back },
        { x: seat.x + SEAT.x, y: SEAT.top, z: seat.z + SEAT.front },
      ),
    ),
  ]
    .map((point) => ({ ...project(point, axes), ...plain }))
    .concat(
      seats.map((seat) => ({
        ...project({ x: seat.x + ANCHOR.x, y: ANCHOR.y, z: seat.z + ANCHOR.z }, axes),
        ...tag,
      })),
    )
  const fits = (scale: number) =>
    span(points, scale, "x").size <= canvas.width * FILL && span(points, scale, "y").size <= canvas.height * FILL
  const scale = fits(0) ? search(fits) : bare(points, canvas)
  const x = span(points, scale, "x")
  const y = span(points, scale, "y")
  // The middle of what is drawn, labels included, goes to the middle of the canvas.
  const cx = (x.low + x.high) / 2 / scale
  const cy = (y.low + y.high) / 2 / scale
  const halfWidth = canvas.width / 2 / scale
  const halfHeight = canvas.height / 2 / scale
  return {
    seats,
    cols,
    rows,
    floor,
    view: direction,
    frustum: { left: cx - halfWidth, right: cx + halfWidth, top: cy + halfHeight, bottom: cy - halfHeight },
    scale,
  }
}

interface Point {
  readonly x: number
  readonly y: number
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** The pixel extent along one axis at `scale` pixels per unit, each point with its own margin in pixels. */
function span(points: readonly Point[], scale: number, axis: "x" | "y") {
  const low = Math.min(...points.map((point) => point[axis] * scale - (axis === "x" ? point.left : point.bottom)))
  const high = Math.max(...points.map((point) => point[axis] * scale + (axis === "x" ? point.right : point.top)))
  return { low, high, size: high - low }
}

/** The largest scale that still fits: the extent only grows with the scale. */
function search(fits: (scale: number) => boolean) {
  const range = { low: 0, high: 1 }
  while (fits(range.high) && range.high < 1e6) range.high *= 2
  for (let step = 0; step < 40; step++) {
    const middle = (range.low + range.high) / 2
    if (fits(middle)) range.low = middle
    else range.high = middle
  }
  return range.low
}

/** A canvas too small for the labels alone: the room without its labels fits instead. */
function bare(points: readonly Point[], canvas: Size) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  return Math.max(1e-3, Math.min((canvas.width * FILL) / width, (canvas.height * FILL) / height))
}

/** The screen's right and up for a camera looking along `direction`, as three.js's `lookAt` orients it. */
function axesOf(direction: Vec3) {
  const right = normalize(cross({ x: 0, y: 1, z: 0 }, direction))
  return { right, up: cross(direction, right) }
}

/** A world point in view units: right and up on the screen. */
function project(point: Vec3, axes: ReturnType<typeof axesOf>) {
  return { x: dot(point, axes.right), y: dot(point, axes.up) }
}

function corners(low: Vec3, high: Vec3) {
  return [low.x, high.x].flatMap((x) => [low.y, high.y].flatMap((y) => [low.z, high.z].map((z) => ({ x, y, z }))))
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a.x, a.y, a.z)
  return { x: a.x / length, y: a.y / length, z: a.z / length }
}
