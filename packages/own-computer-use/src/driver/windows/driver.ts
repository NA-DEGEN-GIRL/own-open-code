export * as WindowsDriver from "./driver.js"

import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Home } from "@own/runtime"
import { Effect, PubSub, Result, Schema, Stream } from "effect"
import { Build } from "../../build.js"
import { DriverError } from "../../core/errors.js"
import type { Policy } from "../../core/policy.js"
import type { Driver } from "../driver.js"
import { FfiChannel } from "./ffi/channel.js"
import { DesktopWorker } from "./ffi/desktop.js"
import { UiaWorker } from "./ffi/uia.js"
import { HelperProtocol } from "./protocol.js"
import { HelperTransport } from "./transport.js"

/**
 * The two Windows drivers, over one protocol (protocol.ts, own/native/own-cu-helper/README.md §3):
 *
 * - `ffi` (`driver: "windows"`, the default): in-process `bun:ffi` calls on two Bun worker threads, one for the
 *   desktop (ffi/desktop.ts) and one for UI Automation (ffi/uia.ts), so nothing separate has to be built, signed or
 *   started and Smart App Control has no unsigned exe to block;
 * - `helper` (`driver: "helper"`): the `own-cu-helper.exe` child process (transport.ts), kept as a fallback.
 *
 * Every method is one protocol request (`over`). Nothing starts until the first request, so loading the plugin never
 * starts a worker or a helper. A `hello` that is not protocol 1 or not Per-Monitor-V2 aware is refused (coordinates
 * would be virtualized), and a ready desktop worker or helper that stops unexpectedly becomes an `exited` event. The
 * driver remembers which keys and buttons it sent down and not yet up: Windows keeps injected input pressed when the
 * injecting thread or process is gone, so after one was abandoned `releaseAll` sends those ups through the next one.
 */
export interface WindowsDriver extends Driver.Driver {
  readonly kind: "windows" | "helper"
  /** The desktop worker or the helper is up and answered `hello`. */
  readonly running: () => boolean
  readonly info: () => HelperProtocol.Hello | undefined
  /** Releases held input, then stops the worker or helper without an `exited` event; the next request starts anew. */
  readonly restart: Effect.Effect<void>
}

/** What `over` needs from a transport: the helper's child process and the FFI worker channel both provide it. */
export interface Link {
  readonly running: boolean
  readonly hello: Record<string, unknown> | undefined
  readonly request: (message: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>
  readonly requestIfRunning: (
    message: Readonly<Record<string, unknown>>,
  ) => Promise<Record<string, unknown> | undefined>
  readonly restart: () => Promise<void>
  readonly close: () => Promise<void>
}

export interface HelperOptions {
  readonly command: ReadonlyArray<string>
  readonly timeoutMs: number
  readonly env?: Readonly<Record<string, string>>
}

/** The `own-cu-helper.exe` driver (`driver: "helper"`). */
export const helper = (options: HelperOptions) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<Driver.Event>()
    const transport = new HelperTransport.Transport({
      command: options.command,
      timeoutMs: options.timeoutMs,
      env: options.env,
      accept: refusal,
      onEvent: (raw) => publishEvent(events, raw),
      onExit: (code) => PubSub.publishUnsafe(events, { _tag: "exited", code }),
    })
    return over({ kind: "helper", link: transport, events })
  })

export interface FfiOptions {
  /** Per-request timeout of the desktop worker; it is abandoned (and `exited` reported) after it. */
  readonly timeoutMs: number
  /** Replaces the worker threads (tests: fakes that answer the same messages). */
  readonly spawn?: { readonly desktop?: FfiChannel.Spawn; readonly uia?: FfiChannel.Spawn }
}

/**
 * The in-process driver (`driver: "windows"`). The UI Automation worker is separate so a hung provider never stalls
 * input: a query that fails or takes longer than `UiaWorker.TIMEOUT_MS` reads as no focused element (the gate then
 * refuses text, failing closed) and abandons that worker without stopping computer use.
 */
export const ffi = (options: FfiOptions) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<Driver.Event>()
    const config = { version: Build.PLUGIN_VERSION }
    const desktop = new FfiChannel.Channel({
      name: "computer-use desktop worker",
      spawn: options.spawn?.desktop ?? FfiChannel.worker(DesktopWorker.source(config)),
      timeoutMs: options.timeoutMs,
      accept: refusal,
      onEvent: (raw) => publishEvent(events, raw),
      onExit: (code) => PubSub.publishUnsafe(events, { _tag: "exited", code }),
    })
    const uia = new FfiChannel.Channel({
      name: "computer-use UI Automation worker",
      spawn: options.spawn?.uia ?? FfiChannel.worker(UiaWorker.source(config)),
      timeoutMs: UiaWorker.TIMEOUT_MS,
      accept: UiaWorker.refusal,
    })
    const focused = Effect.promise(() =>
      uia.request({ op: "focus.element" }).then(
        (response) => Result.getOrUndefined(decodeFocus(response))?.focus ?? undefined,
        () => undefined,
      ),
    )
    const base = over({ kind: "windows", link: desktop, events, focused })
    return {
      ...base,
      restart: base.restart.pipe(Effect.andThen(Effect.promise(() => uia.restart()))),
      close: base.close.pipe(Effect.andThen(Effect.promise(() => uia.close()))),
    } satisfies WindowsDriver
  })

/**
 * `Driver` over a link that speaks the protocol. `focused` replaces the link's `focus.element` (the FFI driver asks its
 * UI Automation worker instead).
 */
export function over(input: {
  readonly kind: WindowsDriver["kind"]
  readonly link: Link
  readonly events: PubSub.PubSub<Driver.Event>
  readonly focused?: Effect.Effect<Policy.FocusInfo | undefined, DriverError>
}): WindowsDriver {
  const link = input.link
  const call = <A>(op: HelperProtocol.Op, args: Readonly<Record<string, unknown>>, schema: Schema.Decoder<A>) =>
    Effect.tryPromise({ try: () => link.request({ op, ...args }), catch: fromTransport }).pipe(
      Effect.flatMap((response) => answer(op, response, schema)),
    )
  const done = (op: HelperProtocol.Op, args: Readonly<Record<string, unknown>> = {}) =>
    Effect.asVoid(call(op, args, Schema.Struct({})))
  // Sent down and not yet answered up. Counted from the moment the down is sent: an answer lost to an abandoned worker
  // or a killed helper does not prove the press did not happen.
  const held = { keys: new Map<number, boolean>(), buttons: new Set<Driver.Button>() }
  const up = async (request: Readonly<Record<string, unknown>>) =>
    (await link.request(request).catch(() => undefined))?.ok === true
  // Explicit ups in reverse press order (one is started only when something is held; one that is not running and
  // pressed nothing holds nothing), then `release.all` for whatever the running one tracked itself. What could not be
  // released stays in `held` for the next call.
  const releaseAll = Effect.promise(async () => {
    for (const button of [...held.buttons])
      if (await up({ op: "mouse.button", button, action: "up" })) held.buttons.delete(button)
    for (const [vk, extended] of [...held.keys].toReversed())
      if (await up({ op: "key", vk, extended, action: "up" })) held.keys.delete(vk)
    await link.requestIfRunning({ op: "release.all" }).catch(() => undefined)
  })

  const driver: WindowsDriver = {
    kind: input.kind,
    running: () => link.running,
    info: () => Result.getOrUndefined(decodeHello(link.hello)),
    restart: releaseAll.pipe(Effect.andThen(Effect.promise(() => link.restart()))),
    hello: Effect.map(call("hello", {}, HelperProtocol.Hello), (hello) => ({
      version: hello.version,
      protocol: hello.protocol,
      dpiAwareness: hello.dpiAwareness,
      interactive: hello.interactive,
      inputDesktop: hello.inputDesktop,
      // A helper that does not say is treated as having no stop chord.
      killChord: hello.killChord ?? false,
    })),
    displays: Effect.map(call("displays", {}, HelperProtocol.Displays), (result) => result.displays),
    capture: (request) =>
      Effect.map(call("capture", request, HelperProtocol.Capture), (result) => ({
        mime: result.mime,
        // The helper sends base64 in its JSON line; a worker transfers the bytes.
        data: typeof result.data === "string" ? new Uint8Array(Buffer.from(result.data, "base64")) : result.data,
        width: result.width,
        height: result.height,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      })),
    cursor: call("cursor.get", {}, HelperProtocol.Cursor),
    move: (point) => done("mouse.move", { x: point.x, y: point.y }),
    button: (button, action) =>
      Effect.gen(function* () {
        if (action === "down") held.buttons.add(button)
        yield* done("mouse.button", { button, action })
        if (action === "up") held.buttons.delete(button)
      }),
    wheel: (wheel) => done("mouse.wheel", { dx: wheel.dx, dy: wheel.dy }),
    key: (key, action) =>
      Effect.gen(function* () {
        if (action === "down") held.keys.set(key.vk, key.extended ?? false)
        yield* done("key", { vk: key.vk, extended: key.extended ?? false, action })
        if (action === "up") held.keys.delete(key.vk)
      }),
    text: (text) => done("text", { text }),
    windowAt: (point) =>
      Effect.map(
        call("window.at", { x: point.x, y: point.y }, HelperProtocol.Window),
        (result) => result.window ?? undefined,
      ),
    foreground: Effect.map(
      call("window.foreground", {}, HelperProtocol.Window),
      (result) => result.window ?? undefined,
    ),
    windows: Effect.map(call("windows.list", {}, HelperProtocol.Windows), (result) => result.windows),
    focus: (windowId) => done("window.focus", { id: windowId }),
    focused:
      input.focused ??
      Effect.map(call("focus.element", {}, HelperProtocol.Focus), (result) => result.focus ?? undefined),
    releaseAll,
    indicator: (indicator) =>
      Effect.promise(() =>
        link
          .requestIfRunning({
            op: "indicator",
            on: indicator.on,
            ...(indicator.text === undefined ? {} : { text: indicator.text }),
          })
          .catch(() => undefined),
      ).pipe(Effect.asVoid),
    events: Stream.fromPubSub(input.events),
    close: Effect.gen(function* () {
      yield* driver.releaseAll
      yield* Effect.promise(() => link.close())
    }),
  }
  return driver
}

/**
 * The helper command line: `helper.command` (tests), `helper.exePath`, the installed version's
 * `app\<version>\own-cu-helper.exe` (own-runtime `Home.layout`), and in a source run the local build
 * `own/native/own-cu-helper/target/own-cu-helper.exe`. A missing exe fails the first request with `driver_unavailable`.
 */
export function command(
  input: { readonly command?: ReadonlyArray<string>; readonly exePath?: string; readonly home?: string },
  here = fileURLToPath(import.meta.url),
): ReadonlyArray<string> {
  if (input.command !== undefined) return input.command
  if (input.exePath !== undefined) return [input.exePath]
  const installed = path.join(Home.layout(Home.resolve({ home: input.home })).app, Build.HELPER_EXE)
  if (existsSync(installed) || !here.endsWith(".ts")) return [installed]
  // <repo>/packages/own-computer-use/src/driver/windows/driver.ts
  return [path.resolve(path.dirname(here), "../../../../../own/native/own-cu-helper/target", Build.HELPER_EXE)]
}

const decodeEvent = Schema.decodeUnknownResult(HelperProtocol.Event)
const decodeFailure = Schema.decodeUnknownResult(HelperProtocol.Failure)
const decodeHello = Schema.decodeUnknownResult(HelperProtocol.Hello)
const decodeFocus = Schema.decodeUnknownResult(HelperProtocol.Focus)

function publishEvent(events: PubSub.PubSub<Driver.Event>, raw: unknown) {
  Result.match(decodeEvent(raw), {
    onSuccess: (event) => PubSub.publishUnsafe(events, { _tag: event.event }),
    onFailure: () => false,
  })
}

/** Why a `hello` answer (helper or desktop worker) is refused, or `undefined`. */
export function refusal(hello: unknown) {
  return Result.match(decodeHello(hello), {
    onFailure: () => "computer-use driver sent a malformed hello",
    onSuccess: (value) => {
      if (value.protocol !== HelperProtocol.PROTOCOL)
        return `computer-use driver ${value.name} speaks protocol ${value.protocol}, not ${HelperProtocol.PROTOCOL}`
      if (value.dpiAwareness !== "per_monitor_v2")
        return `computer-use driver ${value.name} is not Per-Monitor-V2 DPI aware (${value.dpiAwareness}); its coordinates would be scaled`
      return undefined
    },
  })
}

function fromTransport(error: unknown) {
  if (!(error instanceof HelperTransport.TransportError))
    return new DriverError("unavailable", error instanceof Error ? error.message : String(error))
  return new DriverError(error.reason, error.message)
}

const HELPER_CODES: Readonly<Record<HelperProtocol.ErrorCode, DriverError["reason"]>> = {
  bad_request: "protocol",
  unknown_op: "protocol",
  busy: "unavailable",
  desktop_unavailable: "desktop_unavailable",
  unknown_window: "unknown_window",
  failed: "failed",
}

function answer<A>(op: HelperProtocol.Op, response: Record<string, unknown>, schema: Schema.Decoder<A>) {
  if (response.ok !== true) return Effect.fail(failure(op, response))
  return Effect.fromResult(
    Result.mapError(
      Schema.decodeUnknownResult(schema)(response),
      () => new DriverError("protocol", `computer-use driver sent a malformed ${op} answer`),
    ),
  )
}

function failure(op: HelperProtocol.Op, response: Record<string, unknown>) {
  return Result.match(decodeFailure(response), {
    onFailure: () => new DriverError("protocol", `computer-use driver sent a malformed ${op} answer`),
    onSuccess: (value) =>
      new DriverError(
        Object.hasOwn(HELPER_CODES, value.error) ? HELPER_CODES[value.error as HelperProtocol.ErrorCode] : "failed",
        value.message ?? `${op} failed (${value.error})`,
      ),
  })
}
