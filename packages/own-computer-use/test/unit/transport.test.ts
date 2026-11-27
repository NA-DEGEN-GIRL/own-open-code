// The helper transport and the Windows driver against test/fixtures/fake-helper.ts (a Bun script speaking the wire
// protocol from FakeDriver state), started through the `command` override. No real helper and no desktop access.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Fiber, Stream } from "effect"
import { DriverError, Errors } from "../../src/core/errors.js"
import { HelperTransport } from "../../src/driver/windows/transport.js"
import { WindowsDriver } from "../../src/driver/windows/driver.js"

const FAKE = path.join(import.meta.dir, "..", "fixtures", "fake-helper.ts")
const helper = (...args: string[]) => [process.execPath, FAKE, ...args]

const open: Array<HelperTransport.Transport> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((transport) => transport.close()))
})

function transport(options: Partial<HelperTransport.Options> = {}) {
  const exits: Array<number | null> = []
  const events: Array<unknown> = []
  const value = new HelperTransport.Transport({
    command: helper(),
    timeoutMs: 5_000,
    accept: WindowsDriver.refusal,
    onEvent: (event) => events.push(event),
    onExit: (code) => exits.push(code),
    ...options,
  })
  open.push(value)
  return { transport: value, exits, events }
}

const reason = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  )
  expect(error).toBeInstanceOf(HelperTransport.TransportError)
  return error as HelperTransport.TransportError
}

describe("helper transport", () => {
  test("starts lazily, checks hello first and matches concurrent answers by rid", async () => {
    const env = transport()
    expect(env.transport.running).toBe(false)
    const [displays, cursor, missing] = await Promise.all([
      env.transport.request({ op: "displays" }),
      env.transport.request({ op: "cursor.get" }),
      env.transport.request({ op: "nope" }),
    ])
    expect(env.transport.running).toBe(true)
    expect(env.transport.hello).toMatchObject({ ok: true, protocol: 1, dpiAwareness: "per_monitor_v2" })
    expect((displays.displays as Array<unknown>).length).toBe(2)
    expect(cursor).toMatchObject({ ok: true, x: 1280, y: 720 })
    expect(missing).toMatchObject({ ok: false, error: "unknown_op" })
  }, 20_000)

  test("passes unsolicited event lines to onEvent and resolves an answer without rid to the oldest request", async () => {
    const env = transport()
    await env.transport.request({ op: "test.event", event: "kill_chord" })
    expect(env.events).toEqual([{ event: "kill_chord" }])
    expect(await env.transport.request({ op: "test.norid" })).toMatchObject({ ok: true, norid: true })
  }, 20_000)

  test("an oversized line kills the helper, reports the exit, and the next request starts a fresh one", async () => {
    const env = transport({ maxLineBytes: 2_000 })
    const first = (await env.transport.request({ op: "hello" })).pid
    const error = await reason(env.transport.request({ op: "test.big", bytes: 10_000 }))
    expect(error.reason).toBe("protocol")
    expect(error.message).toContain("over 2000 bytes")
    expect(env.transport.running).toBe(false)
    expect(env.exits).toEqual([null])
    const second = (await env.transport.request({ op: "hello" })).pid
    expect(second).not.toBe(first)
  }, 20_000)

  test("a timeout kills a ready helper and reports its exit; the next request starts a new one", async () => {
    const env = transport({ timeoutMs: 2_000 })
    const first = (await env.transport.request({ op: "hello" })).pid
    const error = await reason(env.transport.request({ op: "test.hang" }))
    expect(error.reason).toBe("timeout")
    expect(error.message).toContain("did not answer test.hang within 2000 ms")
    expect(env.exits).toEqual([null])
    expect((await env.transport.request({ op: "hello" })).pid).not.toBe(first)
  }, 30_000)

  test("repeated start failures back off until the clock passes the retry time", async () => {
    const clock = { now: 1_000 }
    const env = transport({ command: helper("--protocol", "9"), now: () => clock.now })
    for (const _ of [1, 2, 3]) expect((await reason(env.transport.request({ op: "hello" }))).reason).toBe("protocol")
    const backoff = await reason(env.transport.request({ op: "hello" }))
    expect(backoff.reason).toBe("unavailable")
    expect(backoff.message).toContain("backoff")
    clock.now += 600
    expect((await reason(env.transport.request({ op: "hello" }))).reason).toBe("protocol")
    expect(env.exits).toEqual([])
  }, 30_000)

  test("a helper that exits on its own fails the pending request and reports its exit code", async () => {
    const env = transport()
    await env.transport.request({ op: "hello" })
    const error = await reason(env.transport.request({ op: "test.exit", code: 7 }))
    expect(error.reason).toBe("unavailable")
    expect(env.exits).toEqual([7])
  }, 20_000)

  test("a refused hello fails the request with protocol and is not an exit of a ready helper", async () => {
    const wrongProtocol = transport({ command: helper("--protocol", "2") })
    const protocol = await reason(wrongProtocol.transport.request({ op: "displays" }))
    expect(protocol.reason).toBe("protocol")
    expect(protocol.message).toContain("protocol 2, not 1")
    expect(wrongProtocol.exits).toEqual([])
    const unaware = transport({ command: helper("--dpi", "system") })
    const dpi = await reason(unaware.transport.request({ op: "displays" }))
    expect(dpi.message).toContain("not Per-Monitor-V2")
  }, 20_000)

  test("a start that fails inside spawn itself is unavailable and backs off", async () => {
    // Bun throws from spawn for some failures instead of emitting `error`: an empty file name here, EUNKNOWN when Smart
    // App Control blocks the unsigned helper (seen on the real desktop).
    const clock = { now: 1_000 }
    const env = transport({ command: [""], now: () => clock.now })
    for (const _ of [1, 2, 3]) {
      const error = await reason(env.transport.request({ op: "hello" }))
      expect(error.reason).toBe("unavailable")
      expect(error.message).toStartWith("computer-use helper could not start:")
    }
    expect((await reason(env.transport.request({ op: "hello" }))).message).toContain("backoff")
    expect(env.exits).toEqual([])
  })

  test("a missing executable is unavailable", async () => {
    const env = transport({ command: [path.join(os.tmpdir(), "own-cu-helper-missing", "own-cu-helper.exe")] })
    expect((await reason(env.transport.request({ op: "hello" }))).reason).toBe("unavailable")
    expect(env.exits).toEqual([])
  }, 20_000)

  test("close and restart send stdin EOF and wait (the helper releases held input on EOF); no exit report", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "own-cu-transport-"))
    try {
      const log = path.join(dir, "helper.log")
      const env = transport({ command: helper("--log", log) })
      const first = (await env.transport.request({ op: "hello" })).pid
      await env.transport.restart()
      expect(env.transport.running).toBe(false)
      // The helper saw EOF and exited on its own: a kill first would have skipped its release of held input.
      expect(readFileSync(log, "utf8")).toContain("eof")
      const second = (await env.transport.request({ op: "hello" })).pid
      expect(second).not.toBe(first)
      expect(env.exits).toEqual([])
      await env.transport.close()
      expect(readFileSync(log, "utf8")).toContain("eof")
      expect(env.exits).toEqual([])
      expect((await reason(env.transport.request({ op: "hello" }))).message).toContain("closed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test("input requests in the wire shape the driver sends reach the helper in order", async () => {
    const env = transport()
    for (const message of [
      { op: "mouse.move", x: -5, y: 7 },
      { op: "mouse.button", button: "left", action: "down" },
      { op: "mouse.wheel", dx: 0, dy: -1 },
      { op: "key", vk: 0x41, extended: false, action: "down" },
      { op: "text", text: "한글" },
      { op: "release.all" },
    ])
      expect(await env.transport.request(message)).toMatchObject({ ok: true })
    expect((await env.transport.request({ op: "test.ops" })).ops).toEqual([
      { op: "move", x: -5, y: 7 },
      { op: "button", button: "left", action: "down" },
      { op: "wheel", dx: 0, dy: -1 },
      { op: "key", vk: 0x41, action: "down" },
      { op: "text", text: "한글" },
      { op: "release_all", keys: [0x41], buttons: ["left"] },
    ])
  }, 20_000)

  test("requestIfRunning never starts a helper", async () => {
    const env = transport()
    expect(await env.transport.requestIfRunning({ op: "release.all" })).toBeUndefined()
    expect(env.transport.running).toBe(false)
  })
})

describe("Windows driver over the fake helper", () => {
  const withDriver = <A, E>(body: (driver: WindowsDriver.WindowsDriver) => Effect.Effect<A, E>) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const driver = yield* WindowsDriver.helper({ command: helper(), timeoutMs: 5_000 })
        return yield* body(driver).pipe(Effect.ensuring(driver.close))
      }),
    )

  test("decodes displays, captures, windows and focus; input reaches the helper", async () => {
    const exit = await withDriver((driver) =>
      Effect.gen(function* () {
        expect(driver.running()).toBe(false)
        yield* driver.releaseAll
        expect(driver.running()).toBe(false)
        const info = yield* driver.hello
        const displays = yield* driver.displays
        const capture = yield* driver.capture({ display: 1, width: 480, height: 270, format: "png" })
        const window = yield* driver.windowAt({ x: -1000, y: 500 })
        const foreground = yield* driver.foreground
        const focused = yield* driver.focused
        yield* driver.move({ x: 10, y: 20 })
        yield* driver.key({ vk: 0x41 }, "down")
        yield* driver.key({ vk: 0x41 }, "up")
        yield* driver.text("안녕")
        const unknown = yield* Effect.exit(driver.focus("0xdead"))
        return { info, displays, capture, window, foreground, focused, unknown, hello: driver.info() }
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    const value = exit.value
    expect(value.info).toEqual({
      version: "fake",
      protocol: 1,
      dpiAwareness: "per_monitor_v2",
      interactive: true,
      inputDesktop: true,
      killChord: true,
    })
    expect(value.hello?.name).toBe("own-cu-helper")
    expect(value.displays.map((item) => item.bounds.x)).toEqual([0, -1920])
    expect(value.capture.mime).toBe("image/png")
    expect([...value.capture.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(new DataView(value.capture.data.buffer, value.capture.data.byteOffset).getUint32(16)).toBe(480)
    expect(value.window?.exe).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(value.foreground?.id).toBe("0x10")
    expect(value.focused).toEqual({ pid: 1000, isPassword: false })
    expect(Exit.isFailure(value.unknown) && String(value.unknown.cause)).toContain("window 0xdead does not exist")
  }, 20_000)

  test("helper events become driver events; an unexpected exit is `exited`", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* WindowsDriver.helper({
          command: helper("--events", "kill_chord,display_changed", "--exit-on", "cursor.get"),
          timeoutMs: 5_000,
        })
        const seen = yield* driver.events.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow
        yield* driver.hello
        const cursor = yield* Effect.exit(driver.cursor)
        expect(Exit.isFailure(cursor)).toBe(true)
        const collected = yield* Fiber.join(seen)
        yield* driver.close
        return collected
      }),
    )
    expect(events).toEqual([{ _tag: "kill_chord" }, { _tag: "display_changed" }, { _tag: "exited", code: 5 }])
  }, 20_000)

  test("a desktop that takes no input fails captures and input with desktop_unavailable; windows still list", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const driver = yield* WindowsDriver.helper({ command: helper("--no-input"), timeoutMs: 5_000 })
        const info = yield* driver.hello
        const failures = yield* Effect.forEach(
          [
            driver.cursor,
            driver.capture({ display: 0, width: 100, height: 100, format: "png" }),
            driver.text("x"),
            driver.focused,
          ],
          (effect) => Effect.flip(effect),
        )
        const windows = yield* driver.windows
        yield* driver.close
        return { info, failures, windows }
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.info.inputDesktop).toBe(false)
    expect(exit.value.failures.map((error) => error.reason)).toEqual([
      "desktop_unavailable",
      "desktop_unavailable",
      "desktop_unavailable",
      "desktop_unavailable",
    ])
    // What the model is told: the minimized remote-desktop case is named, so the user knows what to restore.
    expect(Errors.fromDriver(exit.value.failures[0]!).message).toStartWith("[computer.desktop_unavailable]")
    expect(Errors.fromDriver(exit.value.failures[0]!).message).toContain("remote-desktop")
    expect(exit.value.windows.length).toBeGreaterThan(0)
  }, 20_000)

  test("a helper without the stop chord says so; a later hello is what info() reports", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const driver = yield* WindowsDriver.helper({ command: helper("--no-chord"), timeoutMs: 5_000 })
        const info = yield* driver.hello
        const stored = driver.info()
        yield* driver.close
        return { info, stored }
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.info.killChord).toBe(false)
    expect(exit.value.stored?.killChord).toBe(false)
  }, 20_000)

  test("input pressed by a helper that died is released through the next one", async () => {
    // Windows keeps injected keys and buttons down when the injecting process dies, so the driver sends explicit ups
    // for what it pressed (here ctrl and the left button) through a fresh helper, then release.all.
    const dir = mkdtempSync(path.join(os.tmpdir(), "own-cu-orphan-"))
    try {
      const log = path.join(dir, "helper.log")
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const driver = yield* WindowsDriver.helper({
            command: helper("--exit-on", "cursor.get", "--log", log),
            timeoutMs: 5_000,
          })
          yield* driver.key({ vk: 0x11 }, "down")
          yield* driver.button("left", "down")
          // The helper dies with ctrl and the button still down.
          yield* Effect.exit(driver.cursor)
          expect(driver.running()).toBe(false)
          yield* driver.releaseAll
          yield* driver.close
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      const requests = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => Object.fromEntries(Object.entries(JSON.parse(line)).filter(([key]) => key !== "rid")))
      const second = requests.findLastIndex((request) => request.op === "hello")
      expect(second).toBeGreaterThan(0)
      expect(requests.slice(second + 1)).toEqual([
        { op: "mouse.button", button: "left", action: "up" },
        { op: "key", vk: 0x11, extended: false, action: "up" },
        { op: "release.all" },
        // close: nothing is held any more, only the running helper's own release
        { op: "release.all" },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test("restart releases held input before it stops the helper", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "own-cu-restart-"))
    try {
      const log = path.join(dir, "helper.log")
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const driver = yield* WindowsDriver.helper({ command: helper("--log", log), timeoutMs: 5_000 })
          yield* driver.button("left", "down")
          yield* driver.restart
          expect(driver.running()).toBe(false)
          yield* driver.close
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      const lines = readFileSync(log, "utf8").split("\n")
      expect(lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).op)).toEqual([
        "hello",
        "mouse.button",
        "mouse.button",
        "release.all",
      ])
      expect(lines).toContain("eof")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  test("helper error codes map to driver errors", async () => {
    const exit = await withDriver((driver) => driver.focus("0x999"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const error = exit.cause.reasons.find((item) => item._tag === "Fail")
    expect(error?._tag === "Fail" && error.error).toEqual(
      new DriverError("unknown_window", "window 0x999 does not exist"),
    )
  }, 20_000)
})

describe("helper command line", () => {
  test("command and exePath win; a source run falls back to the local build", () => {
    expect(WindowsDriver.command({ command: ["a", "b"], exePath: "x.exe" })).toEqual(["a", "b"])
    expect(WindowsDriver.command({ exePath: "C:\\x\\own-cu-helper.exe" })).toEqual(["C:\\x\\own-cu-helper.exe"])
    const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-home-"))
    try {
      const source = path.resolve(import.meta.dir, "../../src/driver/windows/driver.ts")
      expect(WindowsDriver.command({ home }, source)).toEqual([
        path.resolve(import.meta.dir, "../../../../own/native/own-cu-helper/target/own-cu-helper.exe"),
      ])
      // A bundle never guesses a repository path.
      const bundle = path.join(home, "app", "2.0.18-own.4", "plugins", "own-computer-use", "index.js")
      expect(WindowsDriver.command({ home }, bundle)).toEqual([path.join(home, "app", "current", "own-cu-helper.exe")])
      // The installed version's helper (app\current.json) wins over the source build.
      const app = path.join(home, "app", "2.0.18-own.4")
      mkdirSync(app, { recursive: true })
      writeFileSync(path.join(app, "manifest.json"), "{}")
      writeFileSync(path.join(app, "own-cu-helper.exe"), "")
      writeFileSync(
        path.join(home, "app", "current.json"),
        JSON.stringify({
          schema: 1,
          version: "2.0.18-own.4",
          path: app,
          previous: null,
          updatedAt: "2026-10-01T00:00:00Z",
        }),
      )
      expect(WindowsDriver.command({ home }, source)).toEqual([path.join(app, "own-cu-helper.exe")])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("hello refusals name the reason", () => {
    const hello = { ok: true, name: "own-cu-helper", version: "1", protocol: 1, interactive: true, inputDesktop: true }
    expect(WindowsDriver.refusal({ ...hello, dpiAwareness: "per_monitor_v2" })).toBeUndefined()
    expect(WindowsDriver.refusal({ ...hello, protocol: 2, dpiAwareness: "per_monitor_v2" })).toContain("protocol 2")
    expect(WindowsDriver.refusal({ ...hello, dpiAwareness: "unaware" })).toContain("Per-Monitor-V2")
    expect(WindowsDriver.refusal({ ok: false, error: "busy" })).toContain("malformed")
  })
})
