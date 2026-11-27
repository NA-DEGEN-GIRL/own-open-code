// The opt-in real-desktop suite (OWN_CU_REAL=1; skipped otherwise), once per Windows driver: the in-process driver
// (`driver: "windows"`, always) and own-cu-helper.exe (`driver: "helper"`, when a prebuilt exe is there and starts; the
// suite never builds one). Each drives the real driver through the input actions, the policy and the gate. Input only
// ever goes to the fixture window this suite starts (fixture/fixture.ps1, run by the system powershell.exe): before
// every input step the window under the point, or the foreground window and its focused process, must be the fixture
// (by window handle), or nothing is sent. Afterwards the cursor goes back where it was and the fixture and the driver
// are closed. Needs an unlocked desktop that takes input (a remote-desktop client window must not be minimized); the
// physical stop chord (ctrl+alt+shift+q) stops it. Prints the measurements of each driver at the end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SessionID } from "@opencode/schema/session-id"
import { Effect, Exit, Fiber, Result, Stream } from "effect"
import { Actions } from "../../src/actions.js"
import { Budget } from "../../src/core/budget.js"
import { Geometry } from "../../src/core/geometry.js"
import { Keys } from "../../src/core/keys.js"
import { KillSwitch } from "../../src/core/killswitch.js"
import { Policy } from "../../src/core/policy.js"
import type { Driver } from "../../src/driver/driver.js"
import { WindowsDriver } from "../../src/driver/windows/driver.js"
import type { Gate } from "../../src/gate.js"
import { Options } from "../../src/options.js"
import { Desktop } from "../../src/singleton.js"
import { Tools } from "../../src/tools.js"
import { ON, SESSION, context, editor } from "../unit/support.js"
import { ENABLED, center, colorAt, decodePng, distance, helperExe, is, startFixture, type Fixture } from "./support.js"

const TEXT = "Hello, own-cu! 123 안녕하세요 컴퓨터 사용 😀👍🏽"
const GATE_TEXT = "gate 확인 ✓"
const MAGENTA = [255, 0, 255]
const YELLOW = [255, 255, 0]
const CYAN = [0, 255, 255]
const WHITE = [255, 255, 255]
/** Largest per-channel difference accepted for a solid area after the bicubic downscale. */
const COLOR_TOLERANCE = 40
/** Physical pixels between where the click was sent and where the fixture saw it. */
const CLICK_TOLERANCE = 2
/** Physical pixels kept away from colour edges, so the downscale's blur never reaches a sample. */
const INSET = 12
/** Repeats of each timed capture; the median is reported. */
const RUNS = 5
const UNAVAILABLE =
  "The desktop does not take input (locked, UAC, or a minimized remote-desktop window); unlock it or restore the window and rerun OWN_CU_REAL=1"
/** The fixture runs in powershell.exe, which the built-in policy denies as a terminal. */
const FIXTURE_APP = "powershell"

interface Variant {
  readonly name: string
  readonly kind: "windows" | "helper"
  readonly make: () => Effect.Effect<WindowsDriver.WindowsDriver>
  /** Why the variant cannot run here. */
  readonly problem?: string
}

const helper = ENABLED ? helperExe() : { exe: "", problem: "OWN_CU_REAL is not set" }
const VARIANTS: ReadonlyArray<Variant> = [
  {
    name: 'in-process driver (driver: "windows")',
    kind: "windows",
    make: () => WindowsDriver.ffi({ timeoutMs: 10_000 }),
  },
  {
    name: 'own-cu-helper.exe (driver: "helper")',
    kind: "helper",
    make: () => WindowsDriver.helper({ command: [helper.exe], timeoutMs: 10_000 }),
    problem: helper.problem,
  },
]
if (ENABLED && helper.problem !== undefined) console.warn(`[own-cu-real] helper variant skipped: ${helper.problem}`)

interface Real {
  readonly dir: string
  readonly driver: WindowsDriver.WindowsDriver
  readonly killSwitch: KillSwitch.KillSwitch
  readonly displays: ReadonlyArray<Geometry.Display>
  readonly hello: Driver.Info
  readonly fixture: Fixture
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const ms = (since: number) => Math.round((performance.now() - since) * 10) / 10
const median = (values: ReadonlyArray<number>) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]

for (const variant of VARIANTS) suite(variant)

function suite(variant: Variant) {
  const measured: Record<string, unknown> = {}
  const cleanup: Array<() => unknown> = []
  const shared: { real?: Real; frame?: Geometry.Frame } = {}

  const need = () => {
    if (shared.real === undefined) throw new Error("the real-desktop setup failed; see the beforeAll error")
    return shared.real
  }
  /** The setup, provided the desktop takes input right now (a fresh hello, not the one from the setup). */
  const interactive = async () => {
    const real = need()
    if (!(await run(real.driver.hello)).inputDesktop) throw new Error(UNAVAILABLE)
    return real
  }

  describe.skipIf(!ENABLED || variant.problem !== undefined)(
    `computer use on the real desktop: ${variant.name}`,
    () => {
      beforeAll(async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "own-cu-real-"))
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
        const driver = Effect.runSync(variant.make())
        const killSwitch = Effect.runSync(KillSwitch.make())
        // The physical stop chord stops this suite like it stops the plugin.
        const watcher = Effect.runFork(
          driver.events.pipe(
            Stream.runForEach((event) => (event._tag === "kill_chord" ? killSwitch.engage("user_chord") : Effect.void)),
          ),
        )
        cleanup.push(async () => {
          const pid = driver.info()?.pid
          await run(Fiber.interrupt(watcher))
          await run(driver.close)
          // close() ends the helper with stdin EOF; make sure it is really gone. The in-process driver's pid is this
          // process, which must never be killed.
          if (variant.kind === "helper" && pid !== undefined && pid !== process.pid && alive(pid)) process.kill(pid)
        })

        const starting = performance.now()
        const hello = await run(driver.hello)
        measured.startHelloMs = ms(starting)
        const rounds = []
        for (const _ of Array.from({ length: RUNS })) {
          const again = performance.now()
          await run(driver.hello)
          rounds.push(ms(again))
        }
        measured.helloRoundTripMs = median(rounds)
        // The first start pays one-time costs (the helper's antivirus scan, the worker's bun:ffi setup); a restart shows
        // the steady-state cost.
        const first = driver.info()?.pid
        await run(driver.restart)
        const deadline = Date.now() + 2_000
        while (variant.kind === "helper" && first !== undefined && alive(first) && Date.now() < deadline)
          await Bun.sleep(10)
        const restarting = performance.now()
        await run(driver.hello)
        measured.restartHelloMs = ms(restarting)
        const displays = await run(driver.displays)
        if (hello.inputDesktop) {
          const cursor = await run(driver.cursor)
          cleanup.push(async () => {
            await Effect.runPromiseExit(driver.move(cursor))
            const after = await Effect.runPromiseExit(driver.cursor)
            measured.cursor = { saved: cursor, restored: Exit.isSuccess(after) ? after.value : "unavailable" }
          })
        }

        const primary = Geometry.primary(Geometry.layout(displays))
        if (primary === undefined) throw new Error("the driver reports no displays")
        const fixtureStart = performance.now()
        const fixture = await startFixture(`own-cu-fixture-${randomBytes(4).toString("hex")}`, {
          x: primary.bounds.x + 160,
          y: primary.bounds.y + 160,
        })
        measured.fixtureStartMs = ms(fixtureStart)
        cleanup.push(() => fixture.close())
        shared.real = { dir, driver, killSwitch, displays, hello, fixture }
      }, 180_000)

      afterAll(async () => {
        for (const step of cleanup.toReversed())
          await Promise.resolve()
            .then(step)
            .catch((error) => console.error(error))
        console.log(`[own-cu-real] ${variant.name} measurements\n${JSON.stringify(measured, null, 2)}`)
      }, 30_000)

      test("hello: protocol 1, Per-Monitor-V2, the interactive window station", () => {
        const real = need()
        measured.hello = real.hello
        expect(real.driver.kind).toBe(variant.kind)
        expect(real.hello.protocol).toBe(1)
        expect(real.hello.dpiAwareness).toBe("per_monitor_v2")
        expect(real.hello.interactive).toBe(true)
        expect(real.driver.info()?.name).toBe(variant.kind === "windows" ? "own-cu-ffi" : "own-cu-helper")
      })

      test("displays: ids 0..n-1, one primary, the same monitors the fixture sees", () => {
        const real = need()
        measured.displays = real.displays
        measured.fixtureDpi = real.fixture.layout.dpi
        expect(real.displays.map((item) => item.id)).toEqual(real.displays.map((_, index) => index))
        expect(real.displays.filter((item) => item.primary)).toHaveLength(1)
        const keys = (rects: ReadonlyArray<Geometry.Rect>) =>
          rects.map((rect) => `${rect.x},${rect.y} ${rect.width}x${rect.height}`).toSorted()
        expect(keys(real.displays.map((item) => item.bounds))).toEqual(
          keys(real.fixture.layout.screens.map((item) => item.bounds)),
        )
        expect(real.displays.find((item) => item.primary)?.bounds).toEqual(
          real.fixture.layout.screens.find((item) => item.primary)?.bounds,
        )
      })

      test("windows.list finds the fixture with its exact bounds", async () => {
        const real = need()
        const timings = []
        const listings = []
        for (const _ of Array.from({ length: RUNS })) {
          const listing = performance.now()
          listings.push(await run(real.driver.windows))
          timings.push(ms(listing))
        }
        const windows = listings.at(-1)!
        measured.windowsList = { medianMs: median(timings), count: windows.length }
        const layout = real.fixture.layout
        const window = windows.find((item) => item.id === layout.hwnd)
        expect(window).toMatchObject({
          pid: layout.pid,
          exe: "powershell.exe",
          title: layout.title,
          bounds: layout.window,
          elevated: false,
          minimized: false,
          cloaked: false,
        })
        expect(window?.displayId).toBe(Geometry.displayAt(Geometry.layout(real.displays), center(layout.window))?.id)
        expect(Policy.visible(window!)).toBe(true)
        // UWP frames (if any are open) name the hosted app, or no exe when it cannot be told; never the frame host.
        const frames = windows.filter((item) => item.className === "ApplicationFrameWindow")
        measured.uwpFrames = frames.map((item) => ({ exe: item.exe, cloaked: item.cloaked, minimized: item.minimized }))
        expect(frames.filter((item) => Policy.appName(item.exe) === "applicationframehost")).toEqual([])
      })

      test("window.at finds the fixture under each of its controls", async () => {
        const real = need()
        const layout = real.fixture.layout
        for (const rect of [layout.textbox, layout.password, layout.button, layout.panel])
          expect((await run(real.driver.windowAt(center(rect))))?.id).toBe(layout.hwnd)
      })

      test("policy: the fixture's app is a terminal; typing is allowed only with terminals lifted, and deny beats allow", async () => {
        const real = need()
        const window = (await run(real.driver.windows)).find((item) => item.id === real.fixture.layout.hwnd)!
        const config: Policy.Config = {
          allowApps: [],
          denyApps: [],
          allowTerminals: false,
          allowSubagents: false,
          approval: "session",
        }
        const input = (overrides: Partial<Policy.Config>) =>
          Policy.evaluate({
            kind: "text",
            target: window,
            focus: { pid: window.pid, isPassword: false },
            subagent: false,
            grants: [],
            config: { ...config, ...overrides },
          })
        expect(input({})).toEqual({ _tag: "Deny", code: "app_denied", app: FIXTURE_APP })
        expect(input({ allowTerminals: true })).toEqual({ _tag: "Allow" })
        expect(input({ allowTerminals: true, denyApps: [FIXTURE_APP] })).toEqual({
          _tag: "Deny",
          code: "app_denied",
          app: FIXTURE_APP,
        })
      })

      test("a screenshot of the fixture's display shows it where the frame mapping says", async () => {
        const real = await interactive()
        const layout = real.fixture.layout
        const display = Geometry.displayAt(Geometry.layout(real.displays), center(layout.window))!
        const capturing = performance.now()
        const shot = await run(
          Actions.screenshot(
            { driver: real.driver },
            { display: display.id, tier: "standard", format: "png", maxBase64Bytes: 4_500_000, captureId: "cap_real" },
          ),
        )
        const fit = Geometry.fitImage(display.bounds.width, display.bounds.height, Geometry.TIERS.standard)
        measured.screenshotStandard = {
          ms: ms(capturing),
          display: display.id,
          image: shot.frame.image,
          base64: Budget.base64Length(shot.capture.data.length),
        }
        expect(shot.frame.physical).toEqual(display.bounds)
        expect(shot.frame.image).toEqual({ width: fit.width, height: fit.height })
        const image = decodePng(shot.capture.data)
        expect({ width: image.width, height: image.height }).toEqual(shot.frame.image)
        // 24 bpp sources: RGB PNGs (colour type 2), like the helper's.
        expect(image.channels).toBe(3)

        const at = (point: Geometry.Point) => colorAt(image, Geometry.toImage(shot.frame, point)!)
        const window = layout.window
        const button = layout.button
        const samples = {
          "window top-left": [at({ x: window.x + INSET, y: window.y + INSET }), MAGENTA],
          "window bottom-right": [
            at({ x: window.x + window.width - INSET, y: window.y + window.height - INSET }),
            MAGENTA,
          ],
          "left of the button": [at({ x: button.x - INSET, y: center(button).y }), MAGENTA],
          "right of the button": [at({ x: button.x + button.width + INSET, y: center(button).y }), MAGENTA],
          "button inside its left edge": [at({ x: button.x + INSET, y: center(button).y }), YELLOW],
          "button centre": [at(center(button)), YELLOW],
          "panel centre": [at(center(layout.panel)), CYAN],
          "textbox centre": [at(center(layout.textbox)), WHITE],
        } as const
        const wrong = Object.entries(samples).filter(([, [seen, want]]) => distance(seen, want) > COLOR_TOLERANCE)
        expect(wrong.map(([name, [seen, want]]) => `${name}: saw ${seen.join(",")}, want ${want.join(",")}`)).toEqual(
          [],
        )
        shared.frame = shot.frame
      }, 30_000)

      test("capture latency: standard tier PNG and JPEG 85, and the display's native resolution", async () => {
        const real = await interactive()
        const display = Geometry.displayAt(Geometry.layout(real.displays), center(real.fixture.layout.window))!
        const fit = Geometry.fitImage(display.bounds.width, display.bounds.height, Geometry.TIERS.standard)
        const sizes = {
          standard: { width: fit.width, height: fit.height },
          native: { width: display.bounds.width, height: display.bounds.height },
        }
        const results: Record<string, unknown> = {}
        for (const [tier, size] of Object.entries(sizes))
          for (const format of ["png", "jpeg"] as const) {
            const timings = []
            const lengths = []
            for (const _ of Array.from({ length: RUNS })) {
              const capturing = performance.now()
              const capture = await run(
                real.driver.capture({
                  display: display.id,
                  ...size,
                  format,
                  ...(format === "jpeg" ? { quality: 85 } : {}),
                }),
              )
              timings.push(ms(capturing))
              lengths.push(capture.data.length)
            }
            results[`${tier} ${format}`] = {
              size: `${size.width}x${size.height}`,
              medianMs: median(timings),
              runs: timings,
              bytes: median(lengths),
            }
          }
        measured.captures = results
        expect(Object.keys(results)).toHaveLength(4)
      }, 120_000)

      test("window.focus brings the fixture to the foreground", async () => {
        await focusFixture(await interactive())
      })

      test("a click on the TextBox through screenshot coordinates lands within 2 physical px", async () => {
        const real = await interactive()
        const click = await clickThroughFrame(real, real.fixture.layout.textbox, "textbox")
        measured.clickTextbox = click.report
        expect(click.offset.x).toBeLessThanOrEqual(CLICK_TOLERANCE)
        expect(click.offset.y).toBeLessThanOrEqual(CLICK_TOLERANCE)
        const timings = []
        const focuses = []
        for (const _ of Array.from({ length: RUNS })) {
          const asking = performance.now()
          focuses.push(await run(real.driver.focused))
          timings.push(ms(asking))
        }
        measured.focusedElementMs = { first: timings[0], median: median(timings) }
        expect(focuses.at(-1)).toMatchObject({ pid: real.fixture.layout.pid, isPassword: false, controlType: "Edit" })
      })

      test("typing ASCII, Hangul and emoji reaches the TextBox exactly", async () => {
        const real = await interactive()
        await requireFixtureFocused(real)
        const mark = real.fixture.mark()
        const typing = performance.now()
        await run(Actions.type(inputs(real), TEXT))
        const typed = await real.fixture.waitFor(
          "the typed text",
          is("text", (event) => event.text === TEXT),
          { after: mark },
        )
        measured.type = { characters: Array.from(TEXT).length, actionAndArrivalMs: Math.round(typed.at - typing) }
        expect(typed.text).toBe(TEXT)
      })

      test("ctrl+a then BackSpace empties the TextBox", async () => {
        const real = await interactive()
        await requireFixtureFocused(real)
        const mark = real.fixture.mark()
        await run(Actions.keys(inputs(real), Result.getOrThrow(Keys.parse("ctrl+a BackSpace")), 1))
        await real.fixture.waitFor(
          "ctrl+a",
          is("key", (event) => event.vk === 0x41 && event.ctrl && !event.alt && !event.shift),
          { after: mark },
        )
        await real.fixture.waitFor(
          "BackSpace",
          is("key", (event) => event.vk === 0x08),
          { after: mark },
        )
        await real.fixture.waitFor(
          "an empty TextBox",
          is("text", (event) => event.text === ""),
          { after: mark },
        )
      })

      test("scrolling over the Panel delivers wheel notches", async () => {
        const real = await interactive()
        const at = center(real.fixture.layout.panel)
        await requireFixtureAt(real, at)
        const notches = (axis: "v" | "h", count: number, after: number) =>
          real.fixture.until(
            `${count} ${axis} wheel notches`,
            (seen) => {
              const deltas = seen.filter(is("wheel", (event) => event.axis === axis)).map((event) => event.delta)
              return deltas.length >= count ? deltas : undefined
            },
            { after },
          )
        const down = real.fixture.mark()
        await run(Actions.scroll(inputs(real), { at, direction: "down", amount: 3, modifiers: [] }))
        expect(await notches("v", 3, down)).toEqual([-120, -120, -120])
        const right = real.fixture.mark()
        await run(Actions.scroll(inputs(real), { at, direction: "right", amount: 2, modifiers: [] }))
        expect(await notches("h", 2, right)).toEqual([120, 120])
        measured.wheel = {
          target: real.fixture.events.slice(down).find(is("wheel"))?.target,
          panelScroll: real.fixture.events.slice(down).findLast(is("scrolled"))?.value,
        }
      })

      test("a click on the Button reports a click at the expected client point", async () => {
        const real = await interactive()
        const mark = real.fixture.mark()
        const click = await clickThroughFrame(real, real.fixture.layout.button, "button")
        const clicked = await real.fixture.waitFor("a button click", is("click"), { after: mark })
        measured.clickButton = click.report
        expect(click.offset.x).toBeLessThanOrEqual(CLICK_TOLERANCE)
        expect(click.offset.y).toBeLessThanOrEqual(CLICK_TOLERANCE)
        expect(Math.abs(clicked.x - click.event.x)).toBeLessThanOrEqual(CLICK_TOLERANCE)
        expect(Math.abs(clicked.y - click.event.y)).toBeLessThanOrEqual(CLICK_TOLERANCE)
      })

      test("UI Automation reports the password field as one", async () => {
        const real = await interactive()
        await clickThroughFrame(real, real.fixture.layout.password, "password")
        await real.fixture.waitFor(
          "the password field's focus",
          is("focus", (event) => event.target === "password"),
        )
        expect(await run(real.driver.focused)).toMatchObject({
          pid: real.fixture.layout.pid,
          isPassword: true,
          controlType: "Edit",
        })
      })

      test("the gate drives the fixture through the tools, never types into its password field, and refuses it once denied", async () => {
        const real = await interactive()
        const layout = real.fixture.layout
        // An exclusive allow list with terminals lifted (the fixture runs in powershell.exe): whatever else might get in
        // the way is refused (app_not_allowed); every step below is also checked against the fixture's window handle.
        const allowed = gate(real, { allowApps: [FIXTURE_APP], allowTerminals: true })
        const denied = gate(real, { allowApps: [FIXTURE_APP], allowTerminals: true, denyApps: [FIXTURE_APP] })
        try {
          const display = Geometry.displayAt(Geometry.layout(real.displays), center(layout.window))!
          const shot = (await allowed.ok("screenshot", { display: display.id })).output as {
            readonly width: number
            readonly height: number
          }
          const frame = {
            physical: display.bounds,
            image: { width: shot.width, height: shot.height },
            captureId: "",
            displayId: display.id,
            tier: "standard" as const,
            layoutHash: "",
            at: 0,
          }
          const target = (rect: Geometry.Rect) => {
            const point = Geometry.toImage(frame, center(rect))!
            return { image: point, physical: Geometry.toPhysical(frame, point)! }
          }
          const textbox = target(layout.textbox)
          await requireFixtureAt(real, textbox.physical)
          const clicked = real.fixture.mark()
          const clicking = performance.now()
          await allowed.ok("left_click", { coordinate: [textbox.image.x, textbox.image.y] })
          const press = await real.fixture.waitFor(
            "the gate's click",
            is("mouse", (event) => event.target === "textbox"),
            { after: clicked },
          )
          measured.gateClickMs = Math.round(press.at - clicking)
          await requireFixtureFocused(real)
          const typed = real.fixture.mark()
          await allowed.ok("type", { text: GATE_TEXT })
          await real.fixture.waitFor(
            "the gate's text",
            is("text", (event) => event.text.endsWith(GATE_TEXT)),
            { after: typed },
          )

          const password = target(layout.password)
          await requireFixtureAt(real, password.physical)
          await allowed.ok("left_click", { coordinate: [password.image.x, password.image.y] })
          await real.fixture.waitFor(
            "the password field's focus",
            is("focus", (event) => event.target === "password"),
          )
          await requireFixtureFocused(real)
          const refused = real.fixture.mark()
          expect(await allowed.error("type", { text: "not a secret" })).toStartWith("[computer.password_field]")
          expect(await denied.error("type", { text: "blocked" })).toStartWith("[computer.app_denied]")
          await Bun.sleep(500)
          expect(
            real.fixture.events.slice(refused).filter((event) => event.event === "text" || event.event === "password"),
          ).toEqual([])
        } finally {
          await allowed.close()
          await denied.close()
        }
      }, 30_000)

      function inputs(real: Real): Actions.Context {
        return { driver: real.driver, killSwitch: real.killSwitch }
      }

      /** Focuses the fixture, once more if Windows refused, else fails without touching anything. */
      async function focusFixture(real: Real) {
        const hwnd = real.fixture.layout.hwnd
        for (const attempt of [1, 2]) {
          await Effect.runPromiseExit(real.driver.focus(hwnd))
          const current = await run(real.driver.foreground)
          if (current?.id === hwnd) return
          if (attempt === 2)
            throw new Error(
              `The fixture cannot be brought to the foreground: ${describeWindow(current)} keeps the focus. Close or minimize it and rerun OWN_CU_REAL=1.`,
            )
        }
      }

      /** Keyboard input goes to the foreground window: it must be the fixture, with the fixture's element focused. */
      async function requireFixtureFocused(real: Real) {
        const current = await run(real.driver.foreground)
        if (current?.id !== real.fixture.layout.hwnd) await focusFixture(real)
        const focus = await run(real.driver.focused)
        if (focus?.pid !== real.fixture.layout.pid)
          throw new Error(`Refusing to type: the focused element belongs to pid ${focus?.pid}, not the fixture`)
      }

      /** Pointer input goes to the window under the point: it must be the fixture. */
      async function requireFixtureAt(real: Real, point: Geometry.Point) {
        const window = await run(real.driver.windowAt(point))
        if (window?.id !== real.fixture.layout.hwnd)
          throw new Error(
            `Refusing to click: (${point.x}, ${point.y}) is over ${describeWindow(window)}, not the fixture`,
          )
      }

      /**
       * Clicks the centre of `rect` the way the model does: physical → image pixel of the latest screenshot → physical
       * again (the gate's mapping), then compares where the fixture saw the press with where it was sent.
       */
      async function clickThroughFrame(real: Real, rect: Geometry.Rect, target: string) {
        const frame = shared.frame
        if (frame === undefined) throw new Error("no screenshot frame; the screenshot test failed")
        const intended = center(rect)
        const image = Geometry.toImage(frame, intended)!
        const physical = Geometry.toPhysical(frame, image)!
        await requireFixtureAt(real, physical)
        const mark = real.fixture.mark()
        const clicking = performance.now()
        await run(Actions.click(inputs(real), { at: physical, button: "left", count: 1, modifiers: [] }))
        const actionMs = ms(clicking)
        const event = await real.fixture.waitFor(
          `a press on the ${target}`,
          is("mouse", (item) => item.target === target),
          { after: mark },
        )
        const expected = { x: physical.x - rect.x, y: physical.y - rect.y }
        const offset = { x: Math.abs(event.x - expected.x), y: Math.abs(event.y - expected.y) }
        return {
          event,
          offset,
          report: {
            image,
            physical,
            mappingError: { x: physical.x - intended.x, y: physical.y - intended.y },
            seen: { x: event.x, y: event.y },
            expected,
            actionMs,
            pressArrivalMs: Math.round(event.at - clicking),
          },
        }
      }
    },
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function describeWindow(window: { readonly exe: string; readonly title: string } | undefined) {
  return window === undefined ? "no window" : `${window.exe} "${window.title}"`
}

/** The registered computer tools over a Desktop that shares the suite's driver (closing it leaves the driver open). */
function gate(real: Real, policy: Record<string, unknown>) {
  const created = Desktop.create(Options.decode({ driver: real.driver.kind, home: real.dir, policy }), {
    ...real.driver,
    close: Effect.void,
  })
  const sessions = new Map<string, Gate.SessionView>([[SESSION, { permissions: ON }]])
  const fake = editor()
  Effect.runSync(
    Effect.scoped(
      Tools.register(fake.ctx, {
        codemode: false,
        deps: {
          desktop: created.desktop,
          blocked: Result.getOrThrow(Keys.blockList([...Keys.DEFAULT_BLOCKED])),
          session: (sessionID: SessionID) => Effect.succeed(sessions.get(sessionID)),
        },
      }),
    ),
  )
  const call = (name: string, input: unknown) => {
    const tool = fake.tools.get(name)
    if (tool === undefined) throw new Error(`no tool ${name}`)
    return Effect.runPromiseExit(tool.execute(input, context(SESSION)))
  }
  return {
    ok: async (name: string, input: unknown) => {
      const exit = await call(name, input)
      if (Exit.isSuccess(exit)) return exit.value
      throw new Error(`computer.${name} failed: ${String(exit.cause)}`)
    },
    error: async (name: string, input: unknown) => {
      const exit = await call(name, input)
      if (Exit.isSuccess(exit)) throw new Error(`computer.${name} succeeded`)
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      if (failure?._tag !== "Fail") throw new Error(`computer.${name} did not fail with a Tool.Error`)
      return failure.error.message
    },
    close: () => run(created.close),
  }
}
