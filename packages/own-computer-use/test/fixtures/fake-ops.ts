// The helper protocol's ops (src/driver/windows/protocol.ts) answered from a FakeDriver desktop, shared by the stdio fake
// helper (fake-helper.ts) and the in-process fake workers (fake-worker.ts). Never touches the real desktop.
import { Effect, Exit } from "effect"
import { DriverError } from "../../src/core/errors.js"
import type { FakeDriver } from "../../src/driver/fake.js"

// Requests exactly as the driver under test sent them; the fakes trust their own client and skip decoding.
export type Message = Record<string, any>

/** Ops that fail with `desktop_unavailable` while the fake desktop takes no input (locked, minimized RDP window). */
export const NEEDS_INPUT = new Set([
  "capture",
  "cursor.get",
  "mouse.move",
  "mouse.button",
  "mouse.wheel",
  "key",
  "text",
  "window.focus",
  "focus.element",
])

async function run<A>(effect: Effect.Effect<A, DriverError>, map: (value: A) => Message) {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return { ok: true, ...map(exit.value) }
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  if (error instanceof DriverError) {
    const code = error.reason === "unknown_window" || error.reason === "desktop_unavailable" ? error.reason : "failed"
    return { ok: false, error: code, message: error.detail }
  }
  return { ok: false, error: "failed", message: "unexpected failure" }
}

const empty = () => ({})

/**
 * The answer to a protocol op other than `hello`, or `undefined` for anything else. `data` encodes a capture's bytes
 * (base64 for the helper's JSON lines, the bytes themselves for a worker).
 */
export function answer(driver: FakeDriver.FakeDriver, message: Message, data: (bytes: Uint8Array) => unknown) {
  switch (message.op) {
    case "displays":
      return run(driver.displays, (displays) => ({ displays }))
    case "capture":
      return run(
        driver.capture({
          display: message.display,
          width: message.width,
          height: message.height,
          format: message.format,
          ...(message.region === undefined ? {} : { region: message.region }),
          ...(message.quality === undefined ? {} : { quality: message.quality }),
        }),
        (capture) => ({
          mime: capture.mime,
          data: data(capture.data),
          width: capture.width,
          height: capture.height,
          ...(capture.cursor === undefined ? {} : { cursor: capture.cursor }),
        }),
      )
    case "cursor.get":
      return run(driver.cursor, (point) => point)
    case "mouse.move":
      return run(driver.move({ x: message.x, y: message.y }), empty)
    case "mouse.button":
      return run(driver.button(message.button, message.action), empty)
    case "mouse.wheel":
      return run(driver.wheel({ dx: message.dx, dy: message.dy }), empty)
    case "key":
      return run(driver.key({ vk: message.vk, extended: message.extended }, message.action), empty)
    case "text":
      return run(driver.text(message.text), empty)
    case "window.at":
      return run(driver.windowAt({ x: message.x, y: message.y }), (window) => ({ window: window ?? null }))
    case "window.foreground":
      return run(driver.foreground, (window) => ({ window: window ?? null }))
    case "windows.list":
      return run(driver.windows, (windows) => ({ windows }))
    case "window.focus":
      return run(driver.focus(message.id), empty)
    case "focus.element":
      return run(driver.focused, (focus) => ({ focus: focus ?? null }))
    case "release.all":
      return run(driver.releaseAll, empty)
    case "indicator":
      return run(driver.indicator({ on: message.on }), empty)
    default:
      return undefined
  }
}
