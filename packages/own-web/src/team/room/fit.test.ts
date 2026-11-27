// 팀 룸's framing (06 §9.9): for 1 to 12 areas on a phone, a tall PC panel, a wide panel and a small one, the floor, the
// seats and the labels above the heads fill 88 % of the canvas's limiting side, centred, and nothing leaves the canvas.
// The check projects with three.js's own orthographic camera, as the scene draws.
import { describe, expect, test } from "bun:test"
import { OrthographicCamera, Vector3 } from "three"
import { ANCHOR, FILL, frame, STEP_X, STEP_Z, VIEWS, type Size } from "./fit"

const CANVASES: Readonly<Record<string, Size>> = {
  phone: { width: 390, height: 700 },
  "pc panel": { width: 420, height: 720 },
  wide: { width: 1100, height: 520 },
  square: { width: 600, height: 600 },
  small: { width: 240, height: 180 },
}
const LABEL = { width: 64, height: 34 }

describe("frame", () => {
  for (const [name, canvas] of Object.entries(CANVASES))
    for (let count = 1; count <= 12; count++)
      test(`${name}: ${count} seat(s) fill the limiting side and stay inside`, () => {
        const framing = frame(count, canvas, LABEL)
        expect(framing.seats).toHaveLength(count)
        expect(framing.cols * framing.rows).toBeGreaterThanOrEqual(count)
        const box = drawn(framing, canvas)
        expect(box.left).toBeGreaterThanOrEqual(-0.5)
        expect(box.top).toBeGreaterThanOrEqual(-0.5)
        expect(box.right).toBeLessThanOrEqual(canvas.width + 0.5)
        expect(box.bottom).toBeLessThanOrEqual(canvas.height + 0.5)
        const fill = Math.max((box.right - box.left) / canvas.width, (box.bottom - box.top) / canvas.height)
        expect(fill).toBeCloseTo(FILL, 2)
        // Centred: the margins on either side match.
        expect(Math.abs(box.left - (canvas.width - box.right))).toBeLessThan(1)
        expect(Math.abs(box.top - (canvas.height - box.bottom))).toBeLessThan(1)
      })

  test("a tall canvas stacks seats in more rows than a wide one", () => {
    const tall = frame(4, CANVASES.phone!, LABEL)
    const wide = frame(4, CANVASES.wide!, LABEL)
    expect(tall.rows).toBeGreaterThan(wide.rows)
    expect(wide.cols).toBeGreaterThan(tall.cols)
  })

  test("seats keep the grid's spacing and a short last row is centred", () => {
    const framing = frame(3, CANVASES.square!, LABEL)
    expect([framing.cols, framing.rows]).toEqual([2, 2])
    expect(framing.seats).toEqual([
      { x: -STEP_X / 2, z: STEP_Z / 2 },
      { x: STEP_X / 2, z: STEP_Z / 2 },
      { x: 0, z: -STEP_Z / 2 },
    ])
  })

  test("the view from the right is kept unless a straighter one draws 20 % larger", () => {
    expect(frame(2, CANVASES.square!, LABEL).view).toBe(VIEWS[0]!)
    // Three seats in one column seen from the right run diagonally across a phone; straight on they fill it.
    const tall = frame(3, CANVASES.phone!, LABEL)
    expect(tall.cols).toBe(1)
    expect(tall.view).toBe(VIEWS[2]!)
  })
  test("a canvas too small for the labels still frames the room", () => {
    const framing = frame(2, { width: 60, height: 40 }, LABEL)
    expect(framing.scale).toBeGreaterThan(0)
    expect(Number.isFinite(framing.frustum.left)).toBe(true)
  })
})

/** The pixel box of what the scene draws: floor corners, seat bounds and each label above its anchor. */
function drawn(framing: ReturnType<typeof frame>, canvas: Size) {
  const camera = new OrthographicCamera(
    framing.frustum.left,
    framing.frustum.right,
    framing.frustum.top,
    framing.frustum.bottom,
    0.1,
    200,
  )
  camera.position.set(framing.view.x * 50, framing.view.y * 50, framing.view.z * 50)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const pixel = (point: Vector3) => {
    const ndc = point.clone().project(camera)
    return { x: ((ndc.x + 1) / 2) * canvas.width, y: ((1 - ndc.y) / 2) * canvas.height }
  }
  const half = { x: framing.floor.width / 2, z: framing.floor.depth / 2 }
  const floor = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((z) => [-0.12, 0].map((y) => pixel(new Vector3(x * half.x, y, z * half.z)))),
  )
  const seats = framing.seats.flatMap((seat) =>
    [-0.95, 0.95].flatMap((x) =>
      [0, 2].flatMap((y) => [-1, 0.9].map((z) => pixel(new Vector3(seat.x + x, y, seat.z + z)))),
    ),
  )
  const labels = framing.seats.flatMap((seat) => {
    const at = pixel(new Vector3(seat.x + ANCHOR.x, ANCHOR.y, seat.z + ANCHOR.z))
    return [
      { x: at.x - LABEL.width / 2, y: at.y - LABEL.height - 8 },
      { x: at.x + LABEL.width / 2 + 8, y: at.y },
    ]
  })
  const all = [...floor, ...seats, ...labels]
  return {
    left: Math.min(...all.map((point) => point.x)),
    right: Math.max(...all.map((point) => point.x)),
    top: Math.min(...all.map((point) => point.y)),
    bottom: Math.max(...all.map((point) => point.y)),
  }
}
