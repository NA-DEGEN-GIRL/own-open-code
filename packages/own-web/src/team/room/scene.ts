// 팀 룸's 3D scene (06 §9.9, 2026-11-27): one low-poly character per seat at a desk with a computer, built from
// primitives only (no assets, no network), in its own lazy chunk with three.js. The panel (./panel-tab.tsx) owns the
// labels, the data and when the scene may run: `setActive(false)` stops the frame loop (hidden tab, blurred window,
// hidden page), frames are capped at 30 per second and the pixel ratio at 1.5, `reducedMotion` draws one still pose
// per state, and `dispose` frees every geometry, material and the WebGL context. A lost context stops the loop and
// tells the panel, which shows its list instead. An orthographic camera frames the floor, the seats and their labels to
// fill the canvas (./fit.ts), again on every resize and whenever the seats change.
import {
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Object3D,
} from "three"
import { ANCHOR, frame, type Size } from "./fit"
import type { Look, Seat, SeatState } from "./model"

export interface Room {
  /** Draws these seats: characters are rebuilt when the areas or their looks change, else only their states. */
  update(seats: readonly Seat[]): void
  /** Runs the frame loop (true) or stops it (false). A reduced-motion room only draws when something changes. */
  setActive(active: boolean): void
  /** The canvas's CSS size or the largest label's size changed: the room is framed again (./fit.ts). */
  resize(canvas: Size, label: Size): void
  /** Where each seat's label goes, in CSS pixels of the canvas: above the character's head. */
  anchors(): ReadonlyMap<string, { readonly x: number; readonly y: number }>
  /** The area of the character at this CSS pixel of the canvas, if any. */
  pick(x: number, y: number): string | undefined
  /** Characters in the scene. */
  count(): number
  dispose(): void
}

/** Below this many milliseconds since the last drawn frame the loop skips a frame: about 30 per second. */
const FRAME_MS = 1000 / 30 - 2
const MAX_PIXEL_RATIO = 1.5
/** The camera's distance along the framing's view; an orthographic camera draws the same at any distance. */
const DISTANCE = 50

export function createRoom(
  canvas: HTMLCanvasElement,
  input: {
    readonly reducedMotion: boolean
    /** The WebGL context was lost: the loop has stopped; the panel shows its list. */
    readonly onLost: () => void
    /** Every drawn frame (the panel's `data-frames`, which the e2e test reads). */
    readonly onFrame?: (frames: number) => void
  },
): Room {
  // Throws where WebGL 2 is not available; the panel then shows its list.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
  renderer.setClearColor(0x000000, 0)
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200)
  scene.add(new HemisphereLight(0xffffff, 0x9c8c7a, 2.4))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(3, 7, 5)
  scene.add(sun)
  const kit = createKit()
  const floor = new Mesh(kit.box, kit.solid(0xe8dccb))
  scene.add(floor)
  const characters = new Map<string, Character>()
  const state = {
    canvas: { width: 1, height: 1 } as Size,
    label: { width: 0, height: 0 } as Size,
    raf: 0,
    last: 0,
    frames: 0,
    active: false,
    lost: false,
    layout: "",
  }

  const lost = (event: Event) => {
    event.preventDefault()
    state.lost = true
    stop()
    input.onLost()
  }
  canvas.addEventListener("webglcontextlost", lost)

  function draw(now: number) {
    if (state.lost) return
    const t = input.reducedMotion ? 0 : now / 1000
    characters.forEach((character) => character.pose(t, input.reducedMotion))
    renderer.render(scene, camera)
    state.frames += 1
    input.onFrame?.(state.frames)
  }

  function tick(now: number) {
    state.raf = requestAnimationFrame(tick)
    if (now - state.last < FRAME_MS) return
    state.last = now
    draw(now)
  }

  function stop() {
    if (state.raf) cancelAnimationFrame(state.raf)
    state.raf = 0
  }

  function start() {
    if (state.raf || state.lost || input.reducedMotion) return
    state.last = 0
    state.raf = requestAnimationFrame(tick)
  }

  /** A still frame where the loop does not run (reduced motion) and the room is on screen. */
  function still() {
    if (state.active && !state.raf) draw(performance.now())
  }

  function layout() {
    const seats = [...characters.values()]
    const framing = frame(seats.length, state.canvas, state.label)
    seats.forEach((character, index) => {
      const at = framing.seats[index]!
      character.group.position.set(at.x, 0, at.z)
    })
    floor.scale.set(framing.floor.width, 0.12, framing.floor.depth)
    floor.position.set(0, -0.06, 0)
    camera.position.set(framing.view.x * DISTANCE, framing.view.y * DISTANCE, framing.view.z * DISTANCE)
    camera.lookAt(0, 0, 0)
    camera.left = framing.frustum.left
    camera.right = framing.frustum.right
    camera.top = framing.frustum.top
    camera.bottom = framing.frustum.bottom
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }
  return {
    update(seats) {
      const key = seats.map((seat) => `${seat.areaID}:${JSON.stringify(seat.look)}`).join("|")
      if (key !== state.layout) {
        characters.forEach((character) => scene.remove(character.group))
        characters.forEach((character) => character.dispose())
        characters.clear()
        seats.forEach((seat) => {
          const character = createCharacter(kit, seat.look)
          character.group.userData.areaID = seat.areaID
          characters.set(seat.areaID, character)
          scene.add(character.group)
        })
        state.layout = key
        layout()
      }
      seats.forEach((seat) => characters.get(seat.areaID)?.setState(seat.state))
      still()
    },
    setActive(active) {
      state.active = active
      if (active) {
        start()
        still()
        return
      }
      stop()
    },
    resize(canvas, label) {
      state.canvas = { width: Math.max(1, canvas.width), height: Math.max(1, canvas.height) }
      state.label = label
      renderer.setSize(state.canvas.width, state.canvas.height, false)
      layout()
      if (!state.raf) still()
    },
    anchors() {
      return new Map(
        [...characters.entries()].map(([areaID, character]) => {
          const ndc = character.group.localToWorld(new Vector3(ANCHOR.x, ANCHOR.y, ANCHOR.z)).project(camera)
          return [areaID, { x: ((ndc.x + 1) / 2) * state.canvas.width, y: ((1 - ndc.y) / 2) * state.canvas.height }]
        }),
      )
    },
    pick(x, y) {
      const ray = new Raycaster()
      ray.setFromCamera(new Vector2((x / state.canvas.width) * 2 - 1, 1 - (y / state.canvas.height) * 2), camera)
      const hit = ray.intersectObjects(
        [...characters.values()].map((character) => character.group),
        true,
      )[0]
      return hit ? areaOf(hit.object) : undefined
    },
    count: () => characters.size,
    dispose() {
      stop()
      canvas.removeEventListener("webglcontextlost", lost)
      characters.forEach((character) => character.dispose())
      characters.clear()
      kit.dispose()
      renderer.dispose()
      // Frees the context now rather than at garbage collection: the Android WebView allows only a few at a time.
      if (!state.lost) renderer.forceContextLoss()
    },
  }
}

function areaOf(object: Object3D | null): string | undefined {
  if (!object) return undefined
  const areaID: unknown = object.userData.areaID
  return typeof areaID === "string" ? areaID : areaOf(object.parent)
}

/** Shared unit geometries (scaled per use) and materials by colour; disposed with the room. */
function createKit() {
  const materials = new Map<number, MeshLambertMaterial>()
  const geometries = {
    box: new BoxGeometry(1, 1, 1),
    sphere: new SphereGeometry(1, 20, 14),
    cap: new SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    capsule: new CapsuleGeometry(1, 1, 6, 14),
    cylinder: new CylinderGeometry(1, 1, 1, 18),
    cone: new ConeGeometry(1, 1, 10),
    ring: new TorusGeometry(1, 0.22, 8, 20),
    arc: new TorusGeometry(1, 0.09, 6, 20, Math.PI),
    disc: new CircleGeometry(1, 24),
  }
  return {
    ...geometries,
    solid(color: number) {
      const found = materials.get(color)
      if (found) return found
      const made = new MeshLambertMaterial({ color })
      materials.set(color, made)
      return made
    },
    dispose() {
      Object.values(geometries).forEach((geometry: BufferGeometry) => geometry.dispose())
      materials.forEach((material) => material.dispose())
      materials.clear()
    },
  }
}

type Kit = ReturnType<typeof createKit>

interface Character {
  readonly group: Group
  setState(state: SeatState): void
  pose(t: number, still: boolean): void
  dispose(): void
}

/** One seat: chair, desk, keyboard, monitor, a desk prop and the character; its own materials are the tinted ones. */
function createCharacter(kit: Kit, look: Look): Character {
  const group = new Group()
  const own = {
    body: new MeshLambertMaterial({ color: look.body }),
    skin: new MeshLambertMaterial({ color: look.skin }),
    screen: new MeshLambertMaterial({ color: 0x222222, emissive: new Color(look.glow), emissiveIntensity: 1 }),
    shadow: new MeshLambertMaterial({ color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false }),
  }
  const part = (geometry: BufferGeometry, material: MeshLambertMaterial, parent: Object3D = group) => {
    const mesh = new Mesh(geometry, material)
    parent.add(mesh)
    return mesh
  }
  const dark = kit.solid(0x3b3f4a)
  const phase = (look.body % 997) / 97

  const shadow = part(kit.disc, own.shadow)
  shadow.rotation.x = -Math.PI / 2
  shadow.scale.setScalar(0.95)
  shadow.position.set(0, 0.005, -0.05)

  // Chair behind the character.
  const seat = part(kit.box, dark)
  seat.scale.set(0.5, 0.08, 0.48)
  seat.position.set(0, 0.5, -0.5)
  const back = part(kit.box, dark)
  back.scale.set(0.52, 0.6, 0.07)
  back.position.set(0, 0.86, -0.76)
  const post = part(kit.cylinder, dark)
  post.scale.set(0.04, 0.46, 0.04)
  post.position.set(0, 0.25, -0.5)

  // Desk with a keyboard, a monitor turned toward the character and a prop.
  const wood = kit.solid(look.desk)
  const top = part(kit.box, wood)
  top.scale.set(1.5, 0.07, 0.72)
  top.position.set(0, 0.72, 0.15)
  for (const x of [-0.69, 0.69]) {
    const side = part(kit.box, wood)
    side.scale.set(0.06, 0.7, 0.66)
    side.position.set(x, 0.35, 0.15)
  }
  const keyboard = part(kit.box, kit.solid(0xe6e8ec))
  keyboard.scale.set(0.5, 0.025, 0.16)
  keyboard.position.set(0, 0.77, -0.06)
  const monitor = new Group()
  monitor.position.set(-0.4, 0, 0.4)
  monitor.rotation.y = -0.48
  group.add(monitor)
  const stand = part(kit.cylinder, dark, monitor)
  stand.scale.set(0.035, 0.26, 0.035)
  stand.position.set(0, 0.88, 0)
  const foot = part(kit.box, dark, monitor)
  foot.scale.set(0.24, 0.02, 0.14)
  foot.position.set(0, 0.765, 0)
  const casing = part(kit.box, dark, monitor)
  casing.scale.set(0.64, 0.42, 0.05)
  casing.position.set(0, 1.13, 0)
  // The screen is a little larger than the casing, so its glow shows as a rim from the camera's side too.
  const screen = part(kit.box, own.screen, monitor)
  screen.scale.set(0.68, 0.46, 0.02)
  screen.position.set(0, 1.13, -0.03)
  prop(kit, look, group)

  // The character: a big round head on a capsule, arms on shoulder pivots, a look of its own.
  const body = part(kit.capsule, own.body)
  body.scale.set(0.2, 0.22, 0.2)
  body.position.set(0, 0.92, -0.35)
  const head = new Group()
  head.position.set(0, 1.47, -0.35)
  group.add(head)
  part(kit.sphere, own.skin, head).scale.setScalar(0.25)
  const eyes = kit.solid(0x1f1f24)
  for (const x of [-0.085, 0.085]) {
    const eye = part(kit.sphere, eyes, head)
    eye.scale.set(0.032, 0.04, 0.02)
    eye.position.set(x, 0.02, 0.235)
    const cheek = part(kit.sphere, kit.solid(0xf4a3a8), head)
    cheek.scale.set(0.04, 0.025, 0.015)
    cheek.position.set(x * 1.8, -0.06, 0.2)
  }
  const smile = part(kit.arc, eyes, head)
  smile.scale.setScalar(0.045)
  smile.rotation.z = Math.PI
  smile.position.set(0, -0.06, 0.238)
  hair(kit, look, head)
  extras(kit, look, head)
  const sweat = part(kit.sphere, kit.solid(0x8fd3ff), head)
  sweat.scale.set(0.045, 0.065, 0.045)
  sweat.position.set(0.24, 0.12, 0.1)
  const arms = [-1, 1].map((side) => {
    const pivot = new Group()
    pivot.position.set(side * 0.25, 1.12, -0.35)
    group.add(pivot)
    const arm = part(kit.capsule, own.body, pivot)
    arm.scale.set(0.065, 0.2, 0.065)
    arm.position.set(0, -0.17, 0)
    const hand = part(kit.sphere, own.skin, pivot)
    hand.scale.setScalar(0.07)
    hand.position.set(0, -0.33, 0)
    return pivot
  })
  const status = { value: "idle" as SeatState }

  return {
    group,
    setState(value) {
      status.value = value
      own.body.emissive.set(value === "error" ? 0xff2a2a : 0x000000)
      own.body.emissiveIntensity = value === "error" ? 0.45 : 0
      sweat.visible = value === "error"
      own.screen.emissiveIntensity = value === "sleeping" ? 0.25 : 1
    },
    pose(t, still) {
      const at = t + phase
      const left = arms[0]!
      const right = arms[1]!
      head.rotation.set(0, 0, 0)
      body.rotation.set(0, 0, 0)
      body.scale.y = 0.22
      own.skin.emissive.set(look.glow)
      own.skin.emissiveIntensity = 0
      if (status.value === "working") {
        left.rotation.set(-1.2 + (still ? 0 : Math.sin(at * 18) * 0.18), 0, 0)
        right.rotation.set(-1.2 + (still ? 0 : Math.sin(at * 18 + Math.PI) * 0.18), 0, 0)
        head.rotation.x = 0.12 + (still ? 0 : Math.sin(at * 6) * 0.03)
        own.skin.emissiveIntensity = 0.12 + (still ? 0 : Math.sin(at * 3) * 0.04)
        own.screen.emissiveIntensity = 1 + (still ? 0 : Math.sin(at * 9) * 0.15)
        return
      }
      if (status.value === "sleeping") {
        left.rotation.set(-1.35, 0, 0.1)
        right.rotation.set(-1.35, 0, -0.1)
        head.rotation.x = 0.5
        body.scale.y = 0.22 + (still ? 0 : Math.sin(at * 1.2) * 0.008)
        return
      }
      if (status.value === "waiting") {
        left.rotation.set(-1.1, 0, 0)
        right.rotation.set(-2.85, 0, still ? 0.15 : 0.15 + Math.sin(at * 5) * 0.25)
        head.rotation.z = -0.15
        return
      }
      if (status.value === "error") {
        left.rotation.set(-0.5, 0, 0.35)
        right.rotation.set(-0.5, 0, -0.35)
        body.rotation.z = still ? 0 : Math.sin(at * 30) * 0.03
        sweat.position.y = 0.12 + (still ? 0 : Math.abs(Math.sin(at * 2)) * -0.05)
        return
      }
      left.rotation.set(-0.95, 0, 0)
      right.rotation.set(-0.95, 0, 0)
      head.rotation.y = still ? 0 : Math.sin(at * 0.5) * 0.35
      body.scale.y = 0.22 + (still ? 0 : Math.sin(at * 1.6) * 0.006)
    },
    dispose() {
      Object.values(own).forEach((material) => material.dispose())
    },
  }
}

/** Hair by style: a cap of hair, a bob that covers the back, a spiky top, or none. */
function hair(kit: Kit, look: Look, head: Group) {
  if (look.hairStyle === "bald" || look.hat !== "none") return
  const color = kit.solid(look.hair)
  const cap = new Mesh(kit.cap, color)
  cap.scale.setScalar(0.27)
  cap.rotation.x = -0.35
  head.add(cap)
  if (look.hairStyle === "bob") {
    const back = new Mesh(kit.sphere, color)
    back.scale.set(0.275, 0.24, 0.24)
    back.position.set(0, -0.02, -0.06)
    head.add(back)
  }
  if (look.hairStyle === "spiky")
    [-0.12, -0.04, 0.04, 0.12].forEach((x, index) => {
      const spike = new Mesh(kit.cone, color)
      spike.scale.set(0.06, 0.14, 0.06)
      spike.position.set(x, 0.26, -0.02)
      spike.rotation.z = -x * 2.5
      spike.rotation.x = index % 2 === 0 ? -0.2 : 0.1
      head.add(spike)
    })
}

/** A cap or a beanie, headphones, glasses. */
function extras(kit: Kit, look: Look, head: Group) {
  if (look.hat !== "none") {
    const color = kit.solid(look.hat === "cap" ? look.body : look.glow)
    const crown = new Mesh(kit.cap, color)
    crown.scale.setScalar(0.275)
    crown.rotation.x = -0.2
    head.add(crown)
    if (look.hat === "cap") {
      const brim = new Mesh(kit.box, color)
      brim.scale.set(0.3, 0.025, 0.18)
      brim.position.set(0, 0.11, 0.25)
      head.add(brim)
    }
    if (look.hat === "beanie") {
      const pom = new Mesh(kit.sphere, kit.solid(0xffffff))
      pom.scale.setScalar(0.06)
      pom.position.set(0, 0.29, -0.04)
      head.add(pom)
    }
  }
  if (look.headphones) {
    const dark = kit.solid(0x2a2d36)
    const band = new Mesh(kit.arc, dark)
    band.scale.setScalar(0.28)
    head.add(band)
    for (const x of [-0.27, 0.27]) {
      const cup = new Mesh(kit.cylinder, kit.solid(look.glow))
      cup.scale.set(0.075, 0.06, 0.075)
      cup.rotation.z = Math.PI / 2
      cup.position.set(x, 0, 0)
      head.add(cup)
    }
  }
  if (look.glasses) {
    const frame = kit.solid(0x2a2d36)
    for (const x of [-0.085, 0.085]) {
      const lens = new Mesh(kit.ring, frame)
      lens.scale.setScalar(0.055)
      lens.position.set(x, 0.02, 0.245)
      head.add(lens)
    }
    const bridge = new Mesh(kit.box, frame)
    bridge.scale.set(0.06, 0.012, 0.012)
    bridge.position.set(0, 0.03, 0.25)
    head.add(bridge)
  }
}

/** A small thing on the right of the desk: a mug, a plant, a lamp or books. */
function prop(kit: Kit, look: Look, group: Group) {
  const at = new Vector3(0.5, 0.755, 0.25)
  const add = (geometry: BufferGeometry, color: number, scale: Vector3, offset: Vector3) => {
    const mesh = new Mesh(geometry, kit.solid(color))
    mesh.scale.copy(scale)
    mesh.position.copy(at).add(offset)
    group.add(mesh)
    return mesh
  }
  if (look.prop === "mug") {
    add(kit.cylinder, 0xf5f0e6, new Vector3(0.06, 0.12, 0.06), new Vector3(0, 0.06, 0))
    add(kit.ring, 0xf5f0e6, new Vector3(0.035, 0.035, 0.035), new Vector3(0.07, 0.065, 0)).rotation.y = Math.PI / 2
  }
  if (look.prop === "plant") {
    add(kit.cylinder, 0xc8754f, new Vector3(0.07, 0.1, 0.07), new Vector3(0, 0.05, 0))
    add(kit.sphere, 0x5fae5a, new Vector3(0.11, 0.12, 0.11), new Vector3(0, 0.19, 0))
  }
  if (look.prop === "lamp") {
    add(kit.cylinder, 0x3b3f4a, new Vector3(0.07, 0.02, 0.07), new Vector3(0, 0.01, 0))
    add(kit.cylinder, 0x3b3f4a, new Vector3(0.012, 0.3, 0.012), new Vector3(0, 0.16, 0))
    add(kit.cone, look.glow, new Vector3(0.1, 0.12, 0.1), new Vector3(0, 0.34, 0))
  }
  if (look.prop === "books")
    [0xd8553f, 0x5b8def, 0xf2b84b].forEach((color, index) =>
      add(kit.box, color, new Vector3(0.24, 0.045, 0.16), new Vector3(0, 0.025 + index * 0.047, 0)).rotation.set(
        0,
        index * 0.25,
        0,
      ),
    )
}
