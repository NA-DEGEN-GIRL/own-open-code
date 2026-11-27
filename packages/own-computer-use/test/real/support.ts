// Support of the opt-in real-desktop suite (desktop.test.ts, OWN_CU_REAL=1): runs the fixture window (a PowerShell
// WinForms script run by the system powershell.exe, so nothing is compiled), reads its event lines, finds a prebuilt
// own-cu-helper.exe for the helper variant, and decodes PNG captures.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { inflateSync } from "node:zlib"
import type { Geometry } from "../../src/core/geometry.js"

export const ENABLED = process.env.OWN_CU_REAL === "1"

// <repo>/packages/own-computer-use/test/real
const ROOT = path.resolve(import.meta.dir, "../../../..")
const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

/**
 * The helper exe for the `driver: "helper"` variant: `OWN_CU_HELPER_EXE`, else the local build
 * `own/native/own-cu-helper/target/own-cu-helper.exe`. The suite never builds it (a fresh unsigned exe is what Smart App
 * Control may block); `problem` says why the variant is skipped, including a start that Windows refused.
 */
export function helperExe(): { readonly exe: string; readonly problem?: string } {
  const exe =
    process.env.OWN_CU_HELPER_EXE ?? path.join(ROOT, "own", "native", "own-cu-helper", "target", "own-cu-helper.exe")
  if (!existsSync(exe))
    return { exe, problem: `${exe} does not exist (build it with own/native/own-cu-helper/build.ps1)` }
  const probe = spawnSync(exe, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 })
  if (probe.error !== undefined)
    return {
      exe,
      problem: `${exe} could not start: ${probe.error.message} (Smart App Control or another policy may block it)`,
    }
  if (probe.status !== 0) return { exe, problem: `${exe} --version exited with ${probe.status}` }
  return { exe }
}

export interface Layout {
  readonly event: "ready" | "rects"
  readonly hwnd: string
  readonly pid: number
  readonly title: string
  /** Physical screen rectangles; the controls' are their client areas. */
  readonly window: Geometry.Rect
  readonly textbox: Geometry.Rect
  readonly password: Geometry.Rect
  readonly button: Geometry.Rect
  readonly panel: Geometry.Rect
  readonly dpi: number
  readonly screens: ReadonlyArray<{ readonly bounds: Geometry.Rect; readonly primary: boolean }>
}

/** One line of the fixture, stamped with its arrival time (`performance.now()`). */
export type Event = { readonly at: number } & (
  | Layout
  | {
      readonly event: "mouse"
      readonly target: string
      readonly button: string
      readonly x: number
      readonly y: number
    }
  | { readonly event: "click"; readonly target: string; readonly x: number; readonly y: number }
  | { readonly event: "text"; readonly text: string }
  /** The password field changed; only its length is reported. */
  | { readonly event: "password"; readonly length: number }
  | {
      readonly event: "key"
      readonly vk: number
      readonly ctrl: boolean
      readonly alt: boolean
      readonly shift: boolean
    }
  | { readonly event: "wheel"; readonly axis: "v" | "h"; readonly delta: number; readonly target: string }
  | { readonly event: "scrolled"; readonly value: number }
  | { readonly event: "focus"; readonly target: string }
  | { readonly event: "activated" | "deactivated" }
)

export type Of<K extends Event["event"]> = Extract<Event, { readonly event: K }>

/** A guard for one kind of fixture event, optionally narrowed further. */
export const is =
  <K extends Event["event"]>(kind: K, test: (event: Of<K>) => boolean = () => true) =>
  (event: Event): event is Of<K> =>
    event.event === kind && test(event as Of<K>)

export type Fixture = Awaited<ReturnType<typeof startFixture>>

/** Starts the fixture window at a physical position and waits for its layout. */
export async function startFixture(title: string, at: Geometry.Point) {
  const child = Bun.spawn(
    [
      POWERSHELL,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dir, "fixture", "fixture.ps1"),
      title,
      String(at.x),
      String(at.y),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  )
  const events: Array<Event> = []
  void (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    const state = { rest: "" }
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const lines = (state.rest + decoder.decode(chunk.value, { stream: true })).split("\n")
      state.rest = lines.pop() ?? ""
      const now = performance.now()
      events.push(...lines.filter((line) => line.trim() !== "").map((line) => ({ ...JSON.parse(line), at: now })))
    }
  })()

  /** Waits until `check` returns a value for the events after `after` (an index into `events`); fails naming what was seen. */
  const until = async <A>(
    label: string,
    check: (seen: ReadonlyArray<Event>) => A | undefined,
    options: { readonly after?: number; readonly timeoutMs?: number } = {},
  ): Promise<A> => {
    const deadline = performance.now() + (options.timeoutMs ?? 5_000)
    while (performance.now() < deadline) {
      const value = check(events.slice(options.after ?? 0))
      if (value !== undefined) return value
      if (child.exitCode !== null) break
      await Bun.sleep(5)
    }
    const seen = JSON.stringify(events.slice(options.after ?? 0).slice(-12), (key, value) =>
      key === "at" ? undefined : value,
    )
    throw new Error(`the fixture did not report ${label}; it reported ${seen}`)
  }

  /** The first event after `after` that `match` accepts. */
  const waitFor = <E extends Event>(
    label: string,
    match: (event: Event) => event is E,
    options: { readonly after?: number; readonly timeoutMs?: number } = {},
  ) => until(label, (seen) => seen.find(match), options)

  const send = (command: string) => {
    child.stdin.write(`${command}\n`)
    void child.stdin.flush()
  }

  const layout = await waitFor("its layout", (event): event is Event & Layout => event.event === "ready", {
    timeoutMs: 15_000,
  })
  return {
    pid: child.pid,
    layout,
    events,
    /** Index for `waitFor({after})`: only events from now on. */
    mark: () => events.length,
    until,
    waitFor,
    send,
    /** stdin EOF ends the fixture; it is killed if it lingers. */
    close: async () => {
      if (child.exitCode !== null) return
      child.stdin.end()
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)])
      if (!exited) child.kill()
      await child.exited
    },
  }
}

export interface Image {
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly pixels: Uint8Array
}

/** Decodes an 8-bit RGB or RGBA PNG (what System.Drawing writes for 24/32 bpp bitmaps). */
export function decodePng(bytes: Uint8Array): Image {
  const buffer = Buffer.from(bytes)
  const chunks = { idat: [] as Array<Buffer>, width: 0, height: 0, depth: 0, type: 0 }
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset)
    const kind = buffer.toString("ascii", offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (kind === "IHDR") {
      chunks.width = data.readUInt32BE(0)
      chunks.height = data.readUInt32BE(4)
      chunks.depth = data[8]!
      chunks.type = data[9]!
    }
    if (kind === "IDAT") chunks.idat.push(data)
    offset += 12 + length
  }
  if (chunks.depth !== 8 || (chunks.type !== 2 && chunks.type !== 6))
    throw new Error(`unsupported PNG: depth ${chunks.depth}, colour type ${chunks.type}`)
  const channels = chunks.type === 6 ? 4 : 3
  const stride = chunks.width * channels
  const raw = inflateSync(Buffer.concat(chunks.idat))
  const pixels = new Uint8Array(stride * chunks.height)
  for (let row = 0; row < chunks.height; row++) {
    const filter = raw[row * (stride + 1)]!
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? pixels[row * stride + index - channels]! : 0
      const up = row > 0 ? pixels[(row - 1) * stride + index]! : 0
      const corner = row > 0 && index >= channels ? pixels[(row - 1) * stride + index - channels]! : 0
      pixels[row * stride + index] = (line[index]! + predict(filter, left, up, corner)) & 0xff
    }
  }
  return { width: chunks.width, height: chunks.height, channels, pixels }
}

function predict(filter: number, left: number, up: number, corner: number) {
  if (filter === 1) return left
  if (filter === 2) return up
  if (filter === 3) return Math.floor((left + up) / 2)
  if (filter === 4) {
    const estimate = left + up - corner
    const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)]
    if (distances[0]! <= distances[1]! && distances[0]! <= distances[2]!) return left
    return distances[1]! <= distances[2]! ? up : corner
  }
  return 0
}

/** Mean RGB of the 3x3 block around an image pixel. */
export function colorAt(image: Image, point: Geometry.Point) {
  const samples = [-1, 0, 1].flatMap((dy) =>
    [-1, 0, 1].map((dx) => {
      const x = Math.min(image.width - 1, Math.max(0, point.x + dx))
      const y = Math.min(image.height - 1, Math.max(0, point.y + dy))
      const at = (y * image.width + x) * image.channels
      return [image.pixels[at]!, image.pixels[at + 1]!, image.pixels[at + 2]!]
    }),
  )
  return [0, 1, 2].map((channel) => Math.round(samples.reduce((sum, item) => sum + item[channel]!, 0) / samples.length))
}

/** Largest channel difference between two colours. */
export function distance(left: ReadonlyArray<number>, right: ReadonlyArray<number>) {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index]!)))
}

export function center(rect: Geometry.Rect): Geometry.Point {
  return { x: rect.x + Math.floor(rect.width / 2), y: rect.y + Math.floor(rect.height / 2) }
}
