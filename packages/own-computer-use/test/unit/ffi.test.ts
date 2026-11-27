// The in-process Windows driver without a desktop: the pure Win32 data helpers its workers use, the worker source
// composition, the worker channel (timeouts, crashes, backoff, graceful close) and the driver over fake workers
// (test/fixtures/fake-worker.ts). The real workers run in test/real and in the e2e bundle check.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Stream } from "effect"
import { DriverError } from "../../src/core/errors.js"
import { FfiChannel } from "../../src/driver/windows/ffi/channel.js"
import { DesktopWorker } from "../../src/driver/windows/ffi/desktop.js"
import { Native } from "../../src/driver/windows/ffi/native.js"
import { UiaWorker } from "../../src/driver/windows/ffi/uia.js"
import { HelperTransport } from "../../src/driver/windows/transport.js"
import { WindowsDriver } from "../../src/driver/windows/driver.js"
import { workers, type Options as FakeOptions } from "../fixtures/fake-worker.js"

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

describe("native helpers", () => {
  test("UTF-16 strings round-trip with a NUL terminator; reading stops at NUL or a given length", () => {
    const text = "Local\\own-open-code 컴퓨터 😀"
    const units = Native.wide(text)
    expect(units.length).toBe(text.length + 1)
    expect(units.at(-1)).toBe(0)
    expect(Native.unwide(units)).toBe(text)
    const padded = new Uint16Array(64)
    padded.set(Native.wide("Default"))
    expect(Native.unwide(padded)).toBe("Default")
    expect(Native.unwide(Native.wide("Default"), 3)).toBe("Def")
    expect(Native.unwide(Uint16Array.from([0x41, 0x42]))).toBe("AB")
  })

  test("GUIDs are laid out like the Windows struct (Data1..3 little-endian)", () => {
    // The GDI+ PNG encoder.
    expect([...Native.guid("557CF406-1A04-11D3-9A73-0000F81EF32E")]).toEqual([
      0x06, 0xf4, 0x7c, 0x55, 0x04, 0x1a, 0xd3, 0x11, 0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e,
    ])
    expect(Native.guid("{FF48DBA4-60EF-4201-AA87-54103EEF594E}")).toEqual(
      Native.guid("ff48dba4-60ef-4201-aa87-54103eef594e"),
    )
  })

  test("RECT and POINT: rectangles become x/y/width/height, a POINT by value packs x low and y high", () => {
    expect(Native.rect(Int32Array.from([-1920, 180, 0, 1260]))).toEqual({ x: -1920, y: 180, width: 1920, height: 1080 })
    expect(Native.pointArgument({ x: -5, y: 7 })).toBe(0x00000007_fffffffbn)
    expect(Native.pointArgument({ x: 100, y: -2000 })).toBe((0xfffff830n << 32n) | 100n)
    expect(Native.pointArgument({ x: 0, y: 0 })).toBe(0n)
  })

  test("SendInput records: 40-byte INPUTs with the union at 8, keyboard and mouse fields at their offsets", () => {
    const bytes = Native.inputs([
      Native.keyRecord(0x5b, 0x5b, true, false),
      { kind: "mouse", flags: 0x0800, data: -120 },
      Native.keyRecord(0x41, 0x1e, false, true),
    ])
    expect(bytes.length).toBe(120)
    const data = view(bytes)
    // INPUT_KEYBOARD, wVk, wScan, KEYEVENTF_EXTENDEDKEY
    expect([
      data.getUint32(0, true),
      data.getUint16(8, true),
      data.getUint16(10, true),
      data.getUint32(12, true),
    ]).toEqual([1, 0x5b, 0x5b, 0x0001])
    // INPUT_MOUSE, mouseData (signed), MOUSEEVENTF_WHEEL; dx, dy, time and dwExtraInfo stay 0
    expect([data.getUint32(40, true), data.getInt32(56, true), data.getUint32(60, true)]).toEqual([0, -120, 0x0800])
    expect([data.getInt32(48, true), data.getInt32(52, true), data.getBigUint64(72, true)]).toEqual([0, 0, 0n])
    // KEYEVENTF_KEYUP
    expect([data.getUint32(80, true), data.getUint16(88, true), data.getUint32(92, true)]).toEqual([1, 0x41, 0x0002])
  })

  test("text is one down/up pair of KEYEVENTF_UNICODE per UTF-16 unit; surrogate pairs go as two units", () => {
    const records = Native.textRecords("a😀", 0x1c)
    expect(records).toEqual([
      { kind: "key", vk: 0, scan: 0x61, flags: 0x0004 },
      { kind: "key", vk: 0, scan: 0x61, flags: 0x0006 },
      { kind: "key", vk: 0, scan: 0xd83d, flags: 0x0004 },
      { kind: "key", vk: 0, scan: 0xd83d, flags: 0x0006 },
      { kind: "key", vk: 0, scan: 0xde00, flags: 0x0004 },
      { kind: "key", vk: 0, scan: 0xde00, flags: 0x0006 },
    ])
    expect(Native.textRecords("", 0x1c)).toEqual([])
  })

  test("line breaks press Return (\\n, \\r\\n once, a lone \\r) instead of sending U+000A", () => {
    const enter = [Native.keyRecord(0x0d, 0x1c, false, false), Native.keyRecord(0x0d, 0x1c, false, true)]
    const char = (unit: number) => [
      { kind: "key" as const, vk: 0, scan: unit, flags: 0x0004 },
      { kind: "key" as const, vk: 0, scan: unit, flags: 0x0006 },
    ]
    expect(Native.textRecords("x\ny", 0x1c)).toEqual([...char(0x78), ...enter, ...char(0x79)])
    expect(Native.textRecords("x\r\ny", 0x1c)).toEqual([...char(0x78), ...enter, ...char(0x79)])
    expect(Native.textRecords("\r", 0x1c)).toEqual(enter)
  })

  test("wheel notches, button flags and held-key ids", () => {
    expect(Native.wheelRecords(0, -1)).toEqual([{ kind: "mouse", flags: 0x0800, data: -120 }])
    expect(Native.wheelRecords(2, 3)).toEqual([
      { kind: "mouse", flags: 0x0800, data: 360 },
      { kind: "mouse", flags: 0x1000, data: 240 },
    ])
    expect(Native.wheelRecords(0, 0)).toEqual([])
    expect(
      (["left", "right", "middle"] as const).flatMap((button) => [
        Native.buttonFlags(button, false),
        Native.buttonFlags(button, true),
      ]),
    ).toEqual([0x02, 0x04, 0x08, 0x10, 0x20, 0x40])
    expect(Native.keyId(0x25, true)).toBe(0x125)
    expect(Native.keyId(0x41, false)).toBe(0x41)
  })

  test("a top-down 24 bpp BITMAPINFO and its 4-byte aligned stride", () => {
    const info = view(Native.bitmapInfo(1429, 804))
    expect(info.byteLength).toBe(44)
    expect([info.getUint32(0, true), info.getInt32(4, true), info.getInt32(8, true)]).toEqual([40, 1429, -804])
    expect([info.getUint16(12, true), info.getUint16(14, true), info.getUint32(16, true)]).toEqual([1, 24, 0])
    expect(Native.stride(1429)).toBe(4288)
    expect(Native.stride(3840)).toBe(11520)
    expect(Native.stride(1)).toBe(4)
  })

  test("JPEG quality EncoderParameters point at the quality inside the same buffer", () => {
    const bytes = Native.qualityParameters(new Uint8Array(48), 0x10_0000, 85)
    const data = view(bytes)
    expect(data.getUint32(0, true)).toBe(1)
    expect(bytes.slice(8, 24)).toEqual(Native.guid("1D5BE4B5-FA4A-452D-9CDD-5DB35105E7EB"))
    // NumberOfValues 1, EncoderParameterValueTypeLong, Value → address + 40
    expect([data.getUint32(24, true), data.getUint32(28, true)]).toEqual([1, 4])
    expect(data.getBigUint64(32, true)).toBe(BigInt(0x10_0000 + 40))
    expect(data.getUint32(40, true)).toBe(85)
  })

  test("MONITORINFOEXW: the monitor rectangle, the primary flag and the device name", () => {
    const bytes = new Uint8Array(104)
    const data = view(bytes)
    data.setUint32(0, 104, true)
    for (const [index, value] of [-1920, 180, 0, 1260].entries()) data.setInt32(4 + index * 4, value, true)
    data.setUint32(36, 0, true)
    new Uint16Array(bytes.buffer, 40, 32).set(Native.wide("\\\\.\\DISPLAY2"))
    expect(Native.monitorInfo(bytes)).toEqual({
      bounds: { x: -1920, y: 180, width: 1920, height: 1080 },
      primary: false,
      name: "\\\\.\\DISPLAY2",
    })
    data.setUint32(36, 1, true)
    expect(Native.monitorInfo(bytes).primary).toBe(true)
  })

  test("display ids put the primary first, then left to right and top to bottom; the layout signature ignores order", () => {
    const monitor = (handle: number, x: number, y: number, primary = false, scale = 1) => ({
      handle,
      primary,
      bounds: { x, y, width: 100, height: 100 },
      scale,
      name: `m${handle}`,
    })
    const ordered = Native.orderMonitors([
      monitor(1, 500, 0),
      monitor(2, -100, 50),
      monitor(3, 0, 0, true, 1.5),
      monitor(4, -100, -50),
    ])
    expect(ordered.map((item) => [item.id, item.handle])).toEqual([
      [0, 3],
      [1, 4],
      [2, 2],
      [3, 1],
    ])
    const a = [monitor(1, 0, 0, true), monitor(2, 100, 0)]
    expect(Native.layoutSignature(a)).toBe(Native.layoutSignature(a.toReversed()))
    expect(Native.layoutSignature(a)).not.toBe(
      Native.layoutSignature([monitor(1, 0, 0, true, 1.25), monitor(2, 100, 0)]),
    )
    expect(Native.layoutSignature(a)).not.toBe(Native.layoutSignature([monitor(1, 0, 0), monitor(2, 100, 0, true)]))
  })

  test("window ids, control type names, file names, rectangles and worker failures", () => {
    expect(Native.windowId(0x1a2b)).toBe("0x1a2b")
    expect(Native.parseWindowId("0x1A2B")).toBe(0x1a2b)
    for (const bad of ["1a2b", "0x", "0xzz", "0x12345678901234567"]) expect(Native.parseWindowId(bad)).toBeUndefined()
    expect(Native.controlTypeName(50000)).toBe("Button")
    expect(Native.controlTypeName(50004)).toBe("Edit")
    expect(Native.controlTypeName(50030)).toBe("Document")
    expect(Native.controlTypeName(50033)).toBe("Pane")
    expect(Native.controlTypeName(50040)).toBe("AppBar")
    expect(Native.controlTypeName(49999)).toBeUndefined()
    expect(Native.controlTypeName(50041)).toBeUndefined()
    expect(Native.fileName("C:\\Windows\\System32\\notepad.exe")).toBe("notepad.exe")
    expect(Native.fileName("notepad.exe")).toBe("notepad.exe")
    const display = { x: 0, y: 0, width: 100, height: 100 }
    expect(Native.contains(display, { x: 0, y: 0, width: 100, height: 100 })).toBe(true)
    expect(Native.contains(display, { x: 1, y: 0, width: 100, height: 100 })).toBe(false)
    expect(Native.contains(display, { x: 0, y: 0, width: 0, height: 10 })).toBe(false)
    expect(Native.containsPoint(display, { x: 99, y: 99 })).toBe(true)
    expect(Native.containsPoint(display, { x: 100, y: 0 })).toBe(false)
    expect(Native.failed(Native.failure("busy", "held"))).toEqual({ ok: false, error: "busy", message: "held" })
    expect(Native.failed(new Error("x"))).toEqual({ ok: false, error: "failed", message: "x" })
    expect(Native.hex(-2147467259)).toBe("0x80004005")
  })
})

describe("worker sources", () => {
  test("every Native export is a function the workers carry, followed by the entry call", () => {
    // Besides the functions, the module exports only its own namespace (the `export * as Native` self-export).
    const natives = Object.entries(Native).filter(([name]) => name !== "Native")
    expect(natives.length).toBeGreaterThan(20)
    expect(natives.every(([, value]) => typeof value === "function")).toBe(true)
    for (const make of [DesktopWorker.source, UiaWorker.source]) {
      const source = make({ version: "1.2.3" })
      for (const [name] of natives) expect(source).toContain(`function ${name}(`)
      expect(source.trimEnd()).toEndWith('({"version":"1.2.3"})')
      // Parses as a classic script body (the worker is started from this text).
      expect(() => new Function(source)).not.toThrow()
    }
  })
})

describe("worker channel", () => {
  const open: Array<FfiChannel.Channel> = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((channel) => channel.close()))
  })

  function channel(options: Partial<FfiChannel.Options> = {}, fake: FakeOptions = {}) {
    const fakes = workers(fake)
    const exits: Array<number | null> = []
    const events: Array<unknown> = []
    const value = new FfiChannel.Channel({
      name: "test worker",
      spawn: fakes.desktop,
      timeoutMs: 1_000,
      closeTimeoutMs: 200,
      accept: WindowsDriver.refusal,
      onEvent: (event) => events.push(event),
      onExit: (code) => exits.push(code),
      ...options,
    })
    open.push(value)
    return { channel: value, fakes, exits, events }
  }

  const reason = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(HelperTransport.TransportError)
    return error as HelperTransport.TransportError
  }

  test("starts lazily, sends hello first and matches concurrent answers by rid", async () => {
    const env = channel()
    expect(env.channel.running).toBe(false)
    expect(env.fakes.desktopLog).toEqual([])
    const [displays, cursor, missing] = await Promise.all([
      env.channel.request({ op: "displays" }),
      env.channel.request({ op: "cursor.get" }),
      env.channel.request({ op: "nope" }),
    ])
    expect(env.channel.running).toBe(true)
    expect(env.channel.hello).toMatchObject({ ok: true, name: "own-cu-ffi", dpiAwareness: "per_monitor_v2" })
    expect(env.fakes.desktopLog[0]?.map((message) => message.op)).toEqual(["hello", "displays", "cursor.get", "nope"])
    expect((displays.displays as Array<unknown>).length).toBe(2)
    expect(cursor).toMatchObject({ ok: true, x: 1280, y: 720 })
    expect(missing).toMatchObject({ ok: false, error: "unknown_op" })
  })

  test("event messages without rid go to onEvent", async () => {
    const env = channel()
    await env.channel.request({ op: "test.event", event: "kill_chord" })
    expect(env.events).toEqual([{ event: "kill_chord" }])
  })

  test("a timeout abandons a ready worker, reports its exit and the next request starts a new one", async () => {
    const env = channel({ timeoutMs: 100 })
    await env.channel.request({ op: "hello" })
    const error = await reason(env.channel.request({ op: "test.hang" }))
    expect(error.reason).toBe("timeout")
    expect(error.message).toBe("test worker did not answer test.hang within 100 ms")
    expect(env.channel.running).toBe(false)
    expect(env.exits).toEqual([null])
    expect(env.fakes.terminated).toEqual(["desktop:0"])
    await env.channel.request({ op: "hello" })
    expect(env.fakes.desktopLog).toHaveLength(2)
    // The abandoned worker's later end is not a second exit.
    await Bun.sleep(10)
    expect(env.exits).toEqual([null])
  })

  test("an uncaught error in the worker fails the pending request and reports the exit", async () => {
    const env = channel()
    await env.channel.request({ op: "hello" })
    const error = await reason(env.channel.request({ op: "test.crash" }))
    expect(error.reason).toBe("unavailable")
    expect(error.message).toBe("test worker failed: boom")
    expect(env.exits).toEqual([null])
    const ended = channel()
    await ended.channel.request({ op: "hello" })
    expect((await reason(ended.channel.request({ op: "test.exit", code: 7 }))).message).toBe("test worker stopped (7)")
    expect(ended.exits).toEqual([7])
  })

  test("a refused hello is a protocol failure, not an exit; repeated failures back off", async () => {
    const clock = { now: 1_000 }
    const env = channel({ now: () => clock.now }, { hello: { dpiAwareness: "system" } })
    for (const _ of [1, 2, 3]) {
      const error = await reason(env.channel.request({ op: "displays" }))
      expect(error.reason).toBe("protocol")
      expect(error.message).toContain("not Per-Monitor-V2 DPI aware (system)")
    }
    const backoff = await reason(env.channel.request({ op: "displays" }))
    expect(backoff.message).toBe("test worker is unavailable (restart backoff)")
    clock.now += 600
    expect((await reason(env.channel.request({ op: "displays" }))).reason).toBe("protocol")
    expect(env.exits).toEqual([])
  })

  test("a worker that cannot be created is unavailable and backs off", async () => {
    const clock = { now: 1_000 }
    const env = channel({
      now: () => clock.now,
      spawn: () => {
        throw new Error("no threads")
      },
    })
    for (const _ of [1, 2, 3])
      expect((await reason(env.channel.request({ op: "hello" }))).message).toBe(
        "test worker could not start: no threads",
      )
    expect((await reason(env.channel.request({ op: "hello" }))).message).toContain("backoff")
  })

  test("close and restart ask the worker to close before terminating it; no exit report", async () => {
    const env = channel()
    await env.channel.request({ op: "displays" })
    await env.channel.restart()
    expect(env.channel.running).toBe(false)
    expect(env.fakes.desktopLog[0]?.map((message) => message.op)).toEqual(["hello", "displays", "close"])
    expect(env.fakes.terminated).toEqual(["desktop:0"])
    await env.channel.request({ op: "displays" })
    await env.channel.close()
    expect(env.fakes.desktopLog[1]?.map((message) => message.op)).toEqual(["hello", "displays", "close"])
    await Bun.sleep(10)
    expect(env.exits).toEqual([])
    expect((await reason(env.channel.request({ op: "hello" }))).message).toBe("test worker is closed")
  })

  test("a worker stuck in a native call is terminated after closeTimeoutMs", async () => {
    const env = channel({}, { ignoreClose: true })
    await env.channel.request({ op: "hello" })
    const started = performance.now()
    await env.channel.close()
    expect(performance.now() - started).toBeGreaterThanOrEqual(150)
    expect(env.fakes.terminated).toEqual(["desktop:0"])
  })

  test("requestIfRunning never starts a worker", async () => {
    const env = channel()
    expect(await env.channel.requestIfRunning({ op: "release.all" })).toBeUndefined()
    expect(env.fakes.desktopLog).toEqual([])
  })
})

describe("in-process Windows driver over fake workers", () => {
  const use = <A, E>(fake: FakeOptions, body: (driver: WindowsDriver.WindowsDriver) => Effect.Effect<A, E>) => {
    const fakes = workers(fake)
    const exit = Effect.runPromiseExit(
      Effect.gen(function* () {
        const driver = yield* WindowsDriver.ffi({ timeoutMs: 1_000, spawn: { desktop: fakes.desktop, uia: fakes.uia } })
        return yield* body(driver).pipe(Effect.ensuring(driver.close))
      }),
    )
    return { fakes, exit }
  }

  test("decodes hello, displays, capture bytes, windows and focus; focus comes from the UI Automation worker", async () => {
    const run = use({}, (driver) =>
      Effect.gen(function* () {
        expect(driver.kind).toBe("windows")
        expect(driver.running()).toBe(false)
        const info = yield* driver.hello
        const displays = yield* driver.displays
        const capture = yield* driver.capture({ display: 1, width: 480, height: 270, format: "png" })
        const windows = yield* driver.windows
        const window = yield* driver.windowAt({ x: -1000, y: 500 })
        const focused = yield* driver.focused
        yield* driver.text("안녕")
        return { info, displays, capture, windows, window, focused, hello: driver.info(), running: driver.running() }
      }),
    )
    const exit = await run.exit
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
    expect(value.hello?.name).toBe("own-cu-ffi")
    expect(value.running).toBe(true)
    expect(value.displays.map((item) => item.bounds.x)).toEqual([0, -1920])
    expect(value.capture.data).toBeInstanceOf(Uint8Array)
    expect([...value.capture.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(value.windows.map((item) => item.id)).toEqual(["0x10", "0x20"])
    expect(value.window?.exe).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(value.focused).toEqual({ pid: 1000, isPassword: false, controlType: "Edit" })
    expect(run.fakes.desktopLog[0]?.map((message) => message.op)).not.toContain("focus.element")
    expect(run.fakes.uiaLog[0]?.map((message) => message.op)).toEqual(["hello", "focus.element", "close"])
    expect(run.fakes.driver.ops()).toContainEqual({ op: "text", text: "안녕" })
  })

  test("a hung UI Automation query reads as no focus, abandons only that worker and never stops computer use", async () => {
    const run = use({ uiaHang: true }, (driver) =>
      Effect.gen(function* () {
        const seen = yield* driver.events.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
        yield* driver.hello
        const started = performance.now()
        const focused = yield* driver.focused
        const waited = performance.now() - started
        const again = yield* driver.focused
        const events = yield* Fiber.interrupt(seen).pipe(Effect.as("none"))
        return { focused, waited, again, running: driver.running(), events }
      }),
    )
    const exit = await run.exit
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.focused).toBeUndefined()
    expect(exit.value.waited).toBeGreaterThanOrEqual(UiaWorker.TIMEOUT_MS - 50)
    expect(exit.value.again).toBeUndefined()
    // The desktop worker keeps running and no `exited` event was published.
    expect(exit.value.running).toBe(true)
    expect(run.fakes.terminated).toContain("uia:0")
    expect(run.fakes.uiaLog).toHaveLength(2)
  }, 15_000)

  test("UI Automation that cannot be created reads as no focus", async () => {
    const run = use({ uiaUnavailable: true }, (driver) => driver.focused)
    const exit = await run.exit
    expect(Exit.isSuccess(exit) && exit.value).toBeUndefined()
  })

  test("worker events become driver events; an unexpected end of the desktop worker is `exited`", async () => {
    const run = use({ events: ["kill_chord", "display_changed"], crash: ["cursor.get"] }, (driver) =>
      Effect.gen(function* () {
        const seen = yield* driver.events.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
        yield* Effect.yieldNow
        yield* driver.hello
        yield* Effect.sleep(20)
        // An uncaught error ends the worker (Bun ends a worker on one).
        const cursor = yield* Effect.exit(driver.cursor)
        expect(Exit.isFailure(cursor) && String(cursor.cause)).toContain("computer-use desktop worker failed: boom")
        return yield* Fiber.join(seen)
      }),
    )
    const exit = await run.exit
    expect(Exit.isSuccess(exit) && exit.value).toEqual([
      { _tag: "kill_chord" },
      { _tag: "display_changed" },
      { _tag: "exited", code: null },
    ])
  })

  test("input pressed by a worker that died is released through the next one", async () => {
    const fakes = workers({ hang: ["cursor.get"] })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const driver = yield* WindowsDriver.ffi({ timeoutMs: 200, spawn: { desktop: fakes.desktop, uia: fakes.uia } })
        yield* driver.key({ vk: 0x11 }, "down")
        yield* driver.button("left", "down")
        // The worker is abandoned with ctrl and the button still down.
        yield* Effect.exit(driver.cursor)
        expect(driver.running()).toBe(false)
        yield* driver.releaseAll
        yield* driver.close
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    const strip = (messages: ReadonlyArray<Record<string, unknown>> | undefined) =>
      (messages ?? []).map((message) => Object.fromEntries(Object.entries(message).filter(([key]) => key !== "rid")))
    expect(strip(fakes.desktopLog[1])).toEqual([
      { op: "hello" },
      { op: "mouse.button", button: "left", action: "up" },
      { op: "key", vk: 0x11, extended: false, action: "up" },
      { op: "release.all" },
      // close: nothing is held any more, only the running worker's own release
      { op: "release.all" },
      { op: "close" },
    ])
  })

  test("restart releases held input, then closes both workers without stopping computer use", async () => {
    const run = use({}, (driver) =>
      Effect.gen(function* () {
        yield* driver.button("left", "down")
        yield* driver.focused
        yield* driver.restart
        return driver.running()
      }),
    )
    const exit = await run.exit
    expect(Exit.isSuccess(exit) && exit.value).toBe(false)
    expect(run.fakes.desktopLog[0]?.map((message) => message.op)).toEqual([
      "hello",
      "mouse.button",
      "mouse.button",
      "release.all",
      "close",
    ])
    expect(run.fakes.uiaLog[0]?.map((message) => message.op)).toEqual(["hello", "focus.element", "close"])
  })

  test("a busy desktop (another driver holds the mutex) and a refused hello are driver errors", async () => {
    const busy = use({ busy: true }, (driver) => Effect.flip(driver.displays))
    const exit = await busy.exit
    expect(Exit.isSuccess(exit) && exit.value).toEqual(
      new DriverError("unavailable", "another driver holds the desktop"),
    )
    const unaware = use({ hello: { dpiAwareness: "unaware" } }, (driver) => Effect.flip(driver.hello))
    const refused = await unaware.exit
    expect(Exit.isSuccess(refused) && refused.value.reason).toBe("protocol")
    expect(Exit.isSuccess(refused) && refused.value.detail).toContain("not Per-Monitor-V2")
  })
})
