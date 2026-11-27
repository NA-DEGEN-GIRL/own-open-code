export * as DesktopWorker from "./desktop.js"

import type { CFunction, FFITypeOrString, JSCallback, Pointer, dlopen, ptr, read, toArrayBuffer } from "bun:ffi"
import { FfiChannel } from "./channel.js"
import {
  bitmapInfo,
  buttonFlags,
  contains,
  containsPoint,
  failed,
  failure,
  fileName,
  guid,
  hex,
  inputs,
  keyId,
  keyRecord,
  layoutSignature,
  monitorInfo,
  orderMonitors,
  parseWindowId,
  pointArgument,
  qualityParameters,
  rect,
  stride,
  textRecords,
  unwide,
  wheelRecords,
  wide,
  windowId,
  type InputRecord,
  type Monitor,
  type Rect,
} from "./native.js"

/**
 * The desktop worker of the in-process Windows driver: one dedicated Bun worker thread that makes every desktop call
 * through `bun:ffi` (displays, capture, input, windows, focus and the stop chord), so synchronous Win32 calls never
 * block the service's event loop, and the thread-affine state (the Per-Monitor-V2 DPI context, the desktop mutex, the
 * hotkey and its message queue) stays on one thread. It answers the helper protocol (own/native/own-cu-helper/README.md
 * §3) over `postMessage`: `{op, rid, …args}` in, `{ok, rid, …}` out in order, `{event}` lines without `rid`; a capture
 * carries its bytes (transferred) instead of base64. Behaviour follows the C# helper op by op; differences are listed
 * in ARCHITECTURE.md ("In-process driver").
 *
 * The plugin ships as one bundled file, so the worker is started from source text (`source`): `main` and the
 * `Native` helpers as text, run from a Blob URL. `main` may therefore use only its parameter, JavaScript and Bun
 * globals, `bun:ffi` (imported inside) and the `Native` functions; nothing else from this module exists in the worker.
 */

export interface Config {
  /** `hello.version`. */
  readonly version: string
}

export function source(config: Config) {
  return FfiChannel.script(main, config)
}

/** The `bun:ffi` exports the workers use (imported dynamically inside the worker). */
export interface Ffi {
  readonly dlopen: typeof dlopen
  readonly JSCallback: typeof JSCallback
  readonly CFunction: typeof CFunction
  readonly ptr: typeof ptr
  readonly read: typeof read
  readonly toArrayBuffer: typeof toArrayBuffer
}

type Button = "left" | "right" | "middle"

/** Requests as the driver sends them (`WindowsDriver.over`); the main thread is this worker's only client. */
type Request = { readonly rid: number } & (
  | { readonly op: "hello" | "displays" | "cursor.get" | "window.foreground" | "windows.list" | "release.all" }
  | { readonly op: "close" | "indicator" }
  | {
      readonly op: "capture"
      readonly display: number
      readonly region?: Rect
      readonly width: number
      readonly height: number
      readonly format: "png" | "jpeg"
      readonly quality?: number
    }
  | { readonly op: "mouse.move" | "window.at"; readonly x: number; readonly y: number }
  | { readonly op: "mouse.button"; readonly button: Button; readonly action: "down" | "up" }
  | { readonly op: "mouse.wheel"; readonly dx: number; readonly dy: number }
  | { readonly op: "key"; readonly vk: number; readonly extended?: boolean; readonly action: "down" | "up" }
  | { readonly op: "text"; readonly text: string }
  | { readonly op: "window.focus"; readonly id: string }
)

async function main(config: Config) {
  // Requests that arrive while bun:ffi loads wait for it, in order.
  const worker = start(config)
  self.onmessage = (event: MessageEvent<Request>) => {
    void worker.then(
      (handle) => handle(event.data),
      (error: unknown) => postMessage({ ...failed(error), rid: event.data.rid }),
    )
  }

  async function start(config: Config) {
    // A computed specifier keeps a bundler from touching the import; Bun resolves it at run time.
    const ffi = (await import(String("bun:ffi"))) as Ffi
    const kernel = ffi.dlopen("kernel32.dll", {
      CreateMutexW: { args: ["ptr", "i32", "ptr"], returns: "ptr" },
      WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
      ReleaseMutex: { args: ["ptr"], returns: "i32" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
      QueryFullProcessImageNameW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
      GetLastError: { args: [], returns: "u32" },
      GetCurrentThreadId: { args: [], returns: "u32" },
      GlobalLock: { args: ["ptr"], returns: "ptr" },
      GlobalUnlock: { args: ["ptr"], returns: "i32" },
    })
    const advapi = ffi.dlopen("advapi32.dll", {
      OpenProcessToken: { args: ["ptr", "u32", "ptr"], returns: "i32" },
      GetTokenInformation: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    })
    const user = ffi.dlopen("user32.dll", {
      SetThreadDpiAwarenessContext: { args: ["ptr"], returns: "ptr" },
      GetThreadDpiAwarenessContext: { args: [], returns: "ptr" },
      AreDpiAwarenessContextsEqual: { args: ["ptr", "ptr"], returns: "i32" },
      EnumDisplayMonitors: { args: ["ptr", "ptr", "ptr", "i64"], returns: "i32" },
      GetMonitorInfoW: { args: ["ptr", "ptr"], returns: "i32" },
      MonitorFromWindow: { args: ["ptr", "u32"], returns: "ptr" },
      GetCursorPos: { args: ["ptr"], returns: "i32" },
      SetCursorPos: { args: ["i32", "i32"], returns: "i32" },
      SendInput: { args: ["u32", "ptr", "i32"], returns: "u32" },
      MapVirtualKeyW: { args: ["u32", "u32"], returns: "u32" },
      WindowFromPoint: { args: ["u64"], returns: "ptr" },
      GetAncestor: { args: ["ptr", "u32"], returns: "ptr" },
      GetForegroundWindow: { args: [], returns: "ptr" },
      SetForegroundWindow: { args: ["ptr"], returns: "i32" },
      BringWindowToTop: { args: ["ptr"], returns: "i32" },
      ShowWindow: { args: ["ptr", "i32"], returns: "i32" },
      GetTopWindow: { args: ["ptr"], returns: "ptr" },
      GetWindow: { args: ["ptr", "u32"], returns: "ptr" },
      EnumChildWindows: { args: ["ptr", "ptr", "i64"], returns: "i32" },
      IsWindow: { args: ["ptr"], returns: "i32" },
      IsWindowVisible: { args: ["ptr"], returns: "i32" },
      IsIconic: { args: ["ptr"], returns: "i32" },
      GetWindowTextW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
      GetClassNameW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
      GetWindowRect: { args: ["ptr", "ptr"], returns: "i32" },
      GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
      AttachThreadInput: { args: ["u32", "u32", "i32"], returns: "i32" },
      GetProcessWindowStation: { args: [], returns: "ptr" },
      OpenInputDesktop: { args: ["u32", "i32", "u32"], returns: "ptr" },
      CloseDesktop: { args: ["ptr"], returns: "i32" },
      GetUserObjectInformationW: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
      GetDC: { args: ["ptr"], returns: "ptr" },
      ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
      RegisterHotKey: { args: ["ptr", "i32", "u32", "u32"], returns: "i32" },
      UnregisterHotKey: { args: ["ptr", "i32"], returns: "i32" },
      PeekMessageW: { args: ["ptr", "ptr", "u32", "u32", "u32"], returns: "i32" },
      TranslateMessage: { args: ["ptr"], returns: "i32" },
      DispatchMessageW: { args: ["ptr"], returns: "i64" },
    })
    const gdi = ffi.dlopen("gdi32.dll", {
      CreateCompatibleDC: { args: ["ptr"], returns: "ptr" },
      CreateDIBSection: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "u32"], returns: "ptr" },
      SelectObject: { args: ["ptr", "ptr"], returns: "ptr" },
      BitBlt: { args: ["ptr", "i32", "i32", "i32", "i32", "ptr", "i32", "i32", "u32"], returns: "i32" },
      DeleteObject: { args: ["ptr"], returns: "i32" },
      DeleteDC: { args: ["ptr"], returns: "i32" },
    })
    const shcore = ffi.dlopen("shcore.dll", {
      GetDpiForMonitor: { args: ["ptr", "i32", "ptr", "ptr"], returns: "i32" },
    })
    const dwm = ffi.dlopen("dwmapi.dll", {
      DwmGetWindowAttribute: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
    })
    const u = user.symbols
    const handle = (value: number | bigint | null) => Number(value ?? 0) as Pointer
    const out = () => new BigUint64Array(1)

    // Coordinates of this thread's calls are physical pixels only under Per-Monitor-V2; the process-wide awareness of
    // the service stays untouched. `hello` reports what the thread really got, and the driver refuses anything else.
    u.SetThreadDpiAwarenessContext(handle(-4))
    const awareness = (
      [
        [-4, "per_monitor_v2"],
        [-3, "per_monitor"],
        [-2, "system"],
        [-1, "unaware"],
      ] as const
    ).find(([context]) => u.AreDpiAwarenessContextsEqual(u.GetThreadDpiAwarenessContext(), handle(context)) !== 0)
    const dpiAwareness = awareness?.[1] ?? "unknown"

    const state = {
      // One driver drives the desktop at a time, also across a dev and a prod service (the helper's mutex).
      mutex: handle(kernel.symbols.CreateMutexW(null, 0, wide("Local\\own-open-code-computer-use"))),
      owned: false,
      hotKey: false,
      /** Pressed and not released by this worker: `keyId`s and buttons. */
      keys: new Set<number>(),
      buttons: new Set<Button>(),
      layout: undefined as string | undefined,
      imaging: undefined as ReturnType<typeof imaging> | undefined,
      closed: false,
    }
    const message = new Uint8Array(48)
    const messageView = new DataView(message.buffer)
    // A thread gets its message queue on its first USER call; the hotkey's WM_HOTKEY needs one.
    u.PeekMessageW(message, null, 0, 0, 0)
    own()
    const timers = [setInterval(pump, 50), setInterval(watchDisplays, 1_000)]
    watchDisplays()
    return (request: Request) => {
      // A stop chord pressed while the previous request ran is handled before this one.
      pump()
      const answer = respond(request)
      const transfer = "data" in answer && answer.data instanceof Uint8Array ? [answer.data.buffer] : []
      postMessage({ ...answer, rid: request.rid }, { transfer })
    }

    function respond(request: Request): Record<string, unknown> {
      try {
        return dispatch(request)
      } catch (error) {
        return failed(error)
      }
    }

    function dispatch(request: Request): Record<string, unknown> {
      if (request.op === "hello") {
        // The gate asks hello before input to see whether the stop chord works: take a free desktop and retry the
        // chord here, so both recover once another program (or service) lets go of them.
        if (own()) registerHotKey()
        return {
          ok: true,
          name: "own-cu-ffi",
          version: config.version,
          protocol: 1,
          dpiAwareness,
          interactive: objectName(u.GetProcessWindowStation()) === "WinSta0",
          inputDesktop: usable(),
          pid: process.pid,
          killChord: state.hotKey,
        }
      }
      if (request.op === "close") return close()
      if (state.closed) throw failure("failed", "the desktop worker is closed")
      if (!own()) throw failure("busy", "another own-open-code computer-use driver is driving this desktop")
      registerHotKey()
      switch (request.op) {
        case "displays": {
          const list = monitors()
          noteLayout(list)
          return {
            ok: true,
            displays: list.map((item) => ({
              id: item.id,
              primary: item.primary,
              bounds: item.bounds,
              scale: item.scale,
              name: item.name,
            })),
          }
        }
        case "capture":
          return capture(request)
        case "cursor.get": {
          const point = new Int32Array(2)
          if (u.GetCursorPos(point) === 0) throw unavailable()
          return { ok: true, x: point[0], y: point[1] }
        }
        case "mouse.move":
          requireInput()
          if (u.SetCursorPos(request.x, request.y) === 0)
            throw failure("failed", `SetCursorPos failed (${kernel.symbols.GetLastError()})`)
          return { ok: true }
        case "mouse.button":
          requireInput()
          send([{ kind: "mouse", flags: buttonFlags(request.button, request.action === "up"), data: 0 }])
          if (request.action === "down") state.buttons.add(request.button)
          if (request.action === "up") state.buttons.delete(request.button)
          return { ok: true }
        case "mouse.wheel":
          requireInput()
          send(wheelRecords(request.dx, request.dy))
          return { ok: true }
        case "key": {
          requireInput()
          const extended = request.extended ?? false
          send([keyRecord(request.vk, scan(request.vk), extended, request.action === "up")])
          if (request.action === "down") state.keys.add(keyId(request.vk, extended))
          if (request.action === "up") state.keys.delete(keyId(request.vk, extended))
          return { ok: true }
        }
        case "text":
          requireInput()
          // One SendInput call, so user input cannot interleave with the text.
          send(textRecords(request.text, scan(0x0d)))
          return { ok: true }
        case "window.at":
          return { ok: true, window: answerWindow(u.GetAncestor(u.WindowFromPoint(pointArgument(request)), 2)) }
        case "window.foreground":
          return { ok: true, window: answerWindow(u.GetForegroundWindow()) }
        case "windows.list":
          return { ok: true, windows: listWindows() }
        case "window.focus":
          focus(request.id)
          return { ok: true }
        case "release.all":
          releaseAll()
          return { ok: true }
        case "indicator":
          // Not implemented in-process (the gate does not drive it yet; ARCHITECTURE.md).
          return { ok: true }
      }
    }

    function own() {
      if (state.owned || state.closed || Number(state.mutex) === 0) return state.owned
      const result = kernel.symbols.WaitForSingleObject(state.mutex, 0)
      // WAIT_OBJECT_0, or WAIT_ABANDONED when a previous owner thread ended without releasing it.
      state.owned = result === 0 || result === 0x80
      return state.owned
    }

    function registerHotKey() {
      // ctrl+alt+shift+q with MOD_NOREPEAT, for this thread's queue (no window).
      if (!state.hotKey && !state.closed)
        state.hotKey = u.RegisterHotKey(null, 1, 0x0002 | 0x0001 | 0x0004 | 0x4000, 0x51) !== 0
    }

    // The thread's queue is polled between requests instead of blocking in GetMessage, so requests stay responsive.
    function pump() {
      if (state.closed) return
      while (u.PeekMessageW(message, null, 0, 0, 1) !== 0) {
        if (messageView.getUint32(8, true) === 0x0312 && messageView.getBigUint64(16, true) === 1n) {
          // Let go of everything at once; the driver engages the kill switch when the event arrives.
          releaseAll()
          postMessage({ event: "kill_chord" })
        }
        if (messageView.getBigUint64(0, true) !== 0n) {
          u.TranslateMessage(message)
          u.DispatchMessageW(message)
        }
      }
    }

    function watchDisplays() {
      if (!state.closed) noteLayout(monitors())
    }

    function noteLayout(list: ReadonlyArray<Monitor>) {
      const signature = layoutSignature(list)
      if (state.layout !== undefined && state.layout !== signature) postMessage({ event: "display_changed" })
      state.layout = signature
    }

    function close() {
      if (state.closed) return { ok: true }
      releaseAll()
      state.closed = true
      for (const timer of timers) clearInterval(timer)
      if (state.hotKey) u.UnregisterHotKey(null, 1)
      if (state.owned) kernel.symbols.ReleaseMutex(state.mutex)
      if (Number(state.mutex) !== 0) kernel.symbols.CloseHandle(state.mutex)
      state.hotKey = false
      state.owned = false
      state.imaging?.shutdown()
      return { ok: true }
    }

    // Never fails: releasing is best effort and must not stop the other releases.
    function releaseAll() {
      const records = [
        ...[...state.keys].map((key) => keyRecord(key & 0xff, scan(key & 0xff), (key & 0x100) !== 0, true)),
        ...[...state.buttons].map((button) => ({ kind: "mouse" as const, flags: buttonFlags(button, true), data: 0 })),
      ]
      state.keys.clear()
      state.buttons.clear()
      if (records.length > 0) u.SendInput(records.length, inputs(records), 40)
    }

    // SendInput reports how many events it inserted; UIPI (an elevated foreground window) drops input silently.
    function send(records: ReadonlyArray<InputRecord>) {
      if (records.length === 0) return
      const sent = u.SendInput(records.length, inputs(records), 40)
      if (sent !== records.length)
        throw failure(
          "failed",
          `SendInput inserted ${sent} of ${records.length} events (${kernel.symbols.GetLastError()})`,
        )
    }

    function scan(vk: number) {
      // MAPVK_VK_TO_VSC
      return u.MapVirtualKeyW(vk, 0)
    }

    function unavailable() {
      return failure(
        "desktop_unavailable",
        "the desktop is not taking input: the lock screen, UAC or Ctrl+Alt+Del is up, or the remote-desktop window showing it is minimized",
      )
    }

    function requireInput() {
      if (!usable()) throw unavailable()
    }

    // The desktop takes input and can be captured. The lock screen, UAC and Ctrl+Alt+Del move the input to Winlogon or
    // a secure desktop a normal process cannot open; a remote-desktop session whose client window is minimized keeps
    // the Default desktop but denies GetCursorPos and screen reads.
    function usable() {
      // DESKTOP_READOBJECTS
      const desktop = u.OpenInputDesktop(0, 0, 0x0001)
      if (Number(desktop ?? 0) === 0) return false
      const point = new Int32Array(2)
      const result = objectName(desktop) === "Default" && u.GetCursorPos(point) !== 0
      u.CloseDesktop(desktop)
      return result
    }

    function objectName(object: Pointer | bigint | null) {
      if (Number(object ?? 0) === 0) return ""
      const name = new Uint16Array(256)
      // UOI_NAME
      return u.GetUserObjectInformationW(object, 2, name, name.byteLength, new Uint32Array(1)) !== 0 ? unwide(name) : ""
    }

    function monitors() {
      const found: Array<Monitor> = []
      const callback = new ffi.JSCallback(
        (monitor: number) => {
          const info = new Uint8Array(104)
          new DataView(info.buffer).setUint32(0, 104, true)
          if (u.GetMonitorInfoW(handle(monitor), info) === 0) return 1
          const dpi = new Uint32Array(2)
          // MDT_EFFECTIVE_DPI
          const scale =
            shcore.symbols.GetDpiForMonitor(handle(monitor), 0, dpi, dpi.subarray(1)) === 0 ? dpi[0]! / 96 : 1
          found.push({ handle: monitor, ...monitorInfo(info), scale })
          return 1
        },
        { args: ["ptr", "ptr", "ptr", "i64"], returns: "i32" },
      )
      try {
        u.EnumDisplayMonitors(null, null, callback.ptr, 0)
      } finally {
        callback.close()
      }
      return orderMonitors(found)
    }

    function capture(request: Extract<Request, { readonly op: "capture" }>) {
      const list = monitors()
      noteLayout(list)
      const monitor = list.find((item) => item.id === request.display)
      if (monitor === undefined) throw failure("failed", `display ${request.display} does not exist`)
      const region = request.region ?? monitor.bounds
      if (!contains(monitor.bounds, region)) throw failure("failed", "capture region leaves the display")
      if (request.width < 1 || request.height < 1 || request.width > 16384 || request.height > 16384)
        throw failure("bad_request", "width and height must be 1..16384")
      requireInput()
      const data = shoot(region, request.width, request.height, request.format, request.quality ?? 85)
      const point = new Int32Array(2)
      const cursor =
        u.GetCursorPos(point) !== 0 && containsPoint(monitor.bounds, { x: point[0]!, y: point[1]! })
          ? { x: point[0], y: point[1] }
          : undefined
      return {
        ok: true,
        mime: request.format === "png" ? "image/png" : "image/jpeg",
        data,
        width: request.width,
        height: request.height,
        ...(cursor === undefined ? {} : { cursor }),
      }
    }

    // BitBlt with CAPTUREBLT (layered windows included) from the screen DC into a 24 bpp DIB section, which GDI+ then
    // reads in place (no copy) to resize and encode.
    function shoot(region: Rect, width: number, height: number, format: "png" | "jpeg", quality: number) {
      const screen = u.GetDC(null)
      if (Number(screen ?? 0) === 0) throw unreadable(0)
      const memory = gdi.symbols.CreateCompatibleDC(screen)
      const bits = out()
      const dib = gdi.symbols.CreateDIBSection(screen, bitmapInfo(region.width, region.height), 0, bits, null, 0)
      const previous = gdi.symbols.SelectObject(memory, dib)
      try {
        if (Number(dib ?? 0) === 0 || bits[0] === 0n)
          throw failure("failed", `CreateDIBSection failed for ${region.width}x${region.height}`)
        // SRCCOPY | CAPTUREBLT
        if (
          gdi.symbols.BitBlt(
            memory,
            0,
            0,
            region.width,
            region.height,
            screen,
            region.x,
            region.y,
            0x00cc0020 | 0x40000000,
          ) === 0
        )
          throw unreadable(kernel.symbols.GetLastError())
        return encode(handle(bits[0]!), region, width, height, format, quality)
      } finally {
        gdi.symbols.SelectObject(memory, previous)
        if (Number(dib ?? 0) !== 0) gdi.symbols.DeleteObject(dib)
        gdi.symbols.DeleteDC(memory)
        u.ReleaseDC(null, screen)
      }
    }

    function unreadable(code: number) {
      if (!usable()) return unavailable()
      return failure("failed", `screen capture failed (${code})`)
    }

    function encode(
      scan0: Pointer,
      region: Rect,
      width: number,
      height: number,
      format: "png" | "jpeg",
      quality: number,
    ) {
      const gp = images()
      const source = gp.bitmap(region.width, region.height, stride(region.width), scan0)
      try {
        if (width === region.width && height === region.height) return gp.save(source, format, quality)
        const target = gp.bitmap(width, height, 0, null)
        try {
          gp.draw(target, source, region, width, height)
          return gp.save(target, format, quality)
        } finally {
          gp.dispose(target)
        }
      } finally {
        gp.dispose(source)
      }
    }

    function images() {
      state.imaging = state.imaging ?? imaging()
      return state.imaging
    }

    // GDI+ (flat API) for the high-quality bicubic resize and the PNG/JPEG encoders, loaded on the first capture.
    function imaging() {
      const plus = ffi.dlopen("gdiplus.dll", {
        GdiplusStartup: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
        GdiplusShutdown: { args: ["u64"], returns: "void" },
        GdipCreateBitmapFromScan0: { args: ["i32", "i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
        GdipGetImageGraphicsContext: { args: ["ptr", "ptr"], returns: "i32" },
        GdipSetInterpolationMode: { args: ["ptr", "i32"], returns: "i32" },
        GdipSetCompositingMode: { args: ["ptr", "i32"], returns: "i32" },
        GdipSetCompositingQuality: { args: ["ptr", "i32"], returns: "i32" },
        GdipSetPixelOffsetMode: { args: ["ptr", "i32"], returns: "i32" },
        GdipSetSmoothingMode: { args: ["ptr", "i32"], returns: "i32" },
        GdipCreateImageAttributes: { args: ["ptr"], returns: "i32" },
        GdipSetImageAttributesWrapMode: { args: ["ptr", "i32", "u32", "i32"], returns: "i32" },
        GdipDisposeImageAttributes: { args: ["ptr"], returns: "i32" },
        GdipDrawImageRectRectI: {
          args: ["ptr", "ptr", "i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32", "ptr", "ptr", "ptr"],
          returns: "i32",
        },
        GdipSaveImageToStream: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
        GdipDisposeImage: { args: ["ptr"], returns: "i32" },
        GdipDeleteGraphics: { args: ["ptr"], returns: "i32" },
      })
      const ole = ffi.dlopen("ole32.dll", {
        CreateStreamOnHGlobal: { args: ["ptr", "i32", "ptr"], returns: "i32" },
        GetHGlobalFromStream: { args: ["ptr", "ptr"], returns: "i32" },
      })
      const g = plus.symbols
      const token = out()
      // GdiplusStartupInput: GdiplusVersion 1, no debug callback, background thread and external codecs kept.
      const input = new Uint8Array(24)
      new DataView(input.buffer).setUint32(0, 1, true)
      check("GdiplusStartup", g.GdiplusStartup(token, input, null))
      const encoders = {
        png: guid("557CF406-1A04-11D3-9A73-0000F81EF32E"),
        jpeg: guid("557CF401-1A04-11D3-9A73-0000F81EF32E"),
      }
      const methods = new Map<number, (...args: Array<unknown>) => number>()
      // IStream methods through its vtable; one compiled call per function pointer.
      const method = (object: Pointer, index: number, args: Array<FFITypeOrString>, returns: FFITypeOrString) => {
        const pointer = ffi.read.ptr(ffi.read.ptr(object, 0), index * 8)
        const known = methods.get(pointer)
        if (known !== undefined) return known
        const created = ffi.CFunction({ ptr: handle(pointer), args, returns }) as unknown as (
          ...args: Array<unknown>
        ) => number
        methods.set(pointer, created)
        return created
      }
      return {
        // 24 bpp RGB, over existing memory (the DIB) or GDI+'s own (`scan0` null), so the PNG encoder writes RGB like
        // the helper's bitmaps.
        bitmap: (width: number, height: number, rowBytes: number, scan0: Pointer | null) => {
          const bitmap = out()
          check(
            "GdipCreateBitmapFromScan0",
            g.GdipCreateBitmapFromScan0(width, height, rowBytes, 0x00021808, scan0, bitmap),
          )
          return handle(bitmap[0]!)
        },
        // Like the helper: SourceCopy, high-quality compositing, HighQualityBicubic, high-quality pixel offsets, no
        // smoothing, and TileFlipXY edges so the filter does not blend a dark halo into the borders.
        draw: (target: Pointer, source: Pointer, region: Rect, width: number, height: number) => {
          const graphics = out()
          const attributes = out()
          try {
            check("GdipGetImageGraphicsContext", g.GdipGetImageGraphicsContext(target, graphics))
            const context = handle(graphics[0]!)
            g.GdipSetCompositingMode(context, 1)
            g.GdipSetCompositingQuality(context, 2)
            g.GdipSetInterpolationMode(context, 7)
            g.GdipSetPixelOffsetMode(context, 2)
            g.GdipSetSmoothingMode(context, 3)
            check("GdipCreateImageAttributes", g.GdipCreateImageAttributes(attributes))
            check("GdipSetImageAttributesWrapMode", g.GdipSetImageAttributesWrapMode(handle(attributes[0]!), 3, 0, 0))
            check(
              "GdipDrawImageRectRectI",
              g.GdipDrawImageRectRectI(
                context,
                source,
                0,
                0,
                width,
                height,
                0,
                0,
                region.width,
                region.height,
                2,
                handle(attributes[0]!),
                null,
                null,
              ),
            )
          } finally {
            if (attributes[0] !== 0n) g.GdipDisposeImageAttributes(handle(attributes[0]!))
            if (graphics[0] !== 0n) g.GdipDeleteGraphics(handle(graphics[0]!))
          }
        },
        save: (image: Pointer, format: "png" | "jpeg", quality: number) => {
          const stream = out()
          checkResult("CreateStreamOnHGlobal", ole.symbols.CreateStreamOnHGlobal(null, 1, stream))
          const pointer = handle(stream[0]!)
          try {
            const parameters = format === "jpeg" ? new Uint8Array(48) : undefined
            check(
              "GdipSaveImageToStream",
              g.GdipSaveImageToStream(
                image,
                pointer,
                encoders[format],
                parameters === undefined ? null : qualityParameters(parameters, ffi.ptr(parameters), quality),
              ),
            )
            // IStream::Seek(0, STREAM_SEEK_END): the encoded length.
            const end = out()
            checkResult("IStream::Seek", method(pointer, 5, ["ptr", "i64", "u32", "ptr"], "i32")(pointer, 0, 2, end))
            const global = out()
            checkResult("GetHGlobalFromStream", ole.symbols.GetHGlobalFromStream(pointer, global))
            const memory = kernel.symbols.GlobalLock(handle(global[0]!))
            if (Number(memory ?? 0) === 0) throw failure("failed", "GlobalLock failed")
            try {
              return new Uint8Array(ffi.toArrayBuffer(handle(memory), 0, Number(end[0]))).slice()
            } finally {
              kernel.symbols.GlobalUnlock(handle(global[0]!))
            }
          } finally {
            // IUnknown::Release; the stream frees its memory (fDeleteOnRelease).
            method(pointer, 2, ["ptr"], "u32")(pointer)
          }
        },
        dispose: (image: Pointer) => {
          g.GdipDisposeImage(image)
        },
        shutdown: () => {
          g.GdiplusShutdown(token[0]!)
        },
      }
    }

    function check(name: string, status: number) {
      if (status !== 0) throw failure("failed", `${name} failed (GDI+ status ${status})`)
    }

    function checkResult(name: string, result: number) {
      if (result < 0) throw failure("failed", `${name} failed (${hex(result)})`)
    }

    // Top-level windows in z-order from the top: GetTopWindow then GW_HWNDNEXT (no callback). A window can close
    // during the walk; the cap keeps a reordering z-order from looping.
    function listWindows() {
      const lookup = newLookup()
      const windows: Array<Record<string, unknown>> = []
      const pid = new Uint32Array(1)
      for (
        let hwnd = Number(u.GetTopWindow(null) ?? 0), count = 0;
        hwnd !== 0 && count < 10_000;
        hwnd = Number(u.GetWindow(handle(hwnd), 2) ?? 0), count++
      ) {
        u.GetWindowThreadProcessId(handle(hwnd), pid)
        if (pid[0] !== process.pid && u.IsWindowVisible(handle(hwnd)) !== 0) windows.push(info(hwnd, lookup))
      }
      return windows
    }

    // This process's own windows are never reported (like the helper's own windows).
    function answerWindow(value: Pointer | bigint | null) {
      const hwnd = Number(value ?? 0)
      if (hwnd === 0) return null
      const pid = new Uint32Array(1)
      u.GetWindowThreadProcessId(handle(hwnd), pid)
      return pid[0] === process.pid ? null : info(hwnd, newLookup())
    }

    function newLookup() {
      return { monitors: monitors(), processes: new Map<number, { exe: string; elevated: boolean }>() }
    }

    function info(hwnd: number, lookup: ReturnType<typeof newLookup>) {
      const window = handle(hwnd)
      const owner = new Uint32Array(1)
      u.GetWindowThreadProcessId(window, owner)
      const host = facts(owner[0]!, lookup)
      // A UWP app's top-level window is a frame owned by ApplicationFrameHost.exe; the app runs in the process of the
      // frame's CoreWindow child, and that is the app the policy must judge. A frame without such a child (a suspended
      // or minimized app, whose CoreWindow Windows detaches) cannot be attributed: no exe, always denied.
      const hosted =
        host.exe.toLowerCase() === "applicationframehost.exe" ? hostedProcess(window, owner[0]!) : undefined
      const pid = hosted === undefined || hosted === 0 ? owner[0]! : hosted
      const app = hosted === undefined ? host : hosted === 0 ? { exe: "", elevated: true } : facts(hosted, lookup)
      const title = new Uint16Array(512)
      const titleLength = u.GetWindowTextW(window, title, title.length)
      const className = new Uint16Array(256)
      const classLength = u.GetClassNameW(window, className, className.length)
      const minimized = u.IsIconic(window) !== 0
      const monitor = minimized ? 0 : Number(u.MonitorFromWindow(window, 0) ?? 0)
      const display = lookup.monitors.find((item) => item.handle === monitor)
      const cloaked = new Int32Array(1)
      return {
        id: windowId(hwnd),
        pid,
        exe: app.exe,
        title: unwide(title, titleLength),
        className: unwide(className, classLength),
        bounds: bounds(window),
        ...(display === undefined ? {} : { displayId: display.id }),
        elevated: app.elevated,
        minimized,
        // DWMWA_CLOAKED
        cloaked: dwm.symbols.DwmGetWindowAttribute(window, 14, cloaked, 4) === 0 && cloaked[0] !== 0,
      }
    }

    // The visible frame (DWMWA_EXTENDED_FRAME_BOUNDS excludes the invisible resize borders), else the window rect.
    function bounds(window: Pointer) {
      const values = new Int32Array(4)
      if (dwm.symbols.DwmGetWindowAttribute(window, 9, values, 16) !== 0) u.GetWindowRect(window, values)
      return rect(values)
    }

    // The process of the first descendant window of a UWP frame that another process owns (its CoreWindow), or 0.
    function hostedProcess(frame: Pointer, host: number) {
      const found = { pid: 0 }
      const pid = new Uint32Array(1)
      const callback = new ffi.JSCallback(
        (child: number) => {
          u.GetWindowThreadProcessId(handle(child), pid)
          if (pid[0] === host || pid[0] === 0) return 1
          found.pid = pid[0]!
          return 0
        },
        { args: ["ptr", "i64"], returns: "i32" },
      )
      try {
        u.EnumChildWindows(frame, callback.ptr, 0)
      } finally {
        callback.close()
      }
      return found.pid
    }

    function facts(pid: number, lookup: ReturnType<typeof newLookup>) {
      const known = lookup.processes.get(pid)
      if (known !== undefined) return known
      const value = processFacts(pid)
      lookup.processes.set(pid, value)
      return value
    }

    // Fails closed: a process that cannot be queried has no exe (always denied) and one whose token cannot be read
    // counts as elevated.
    function processFacts(pid: number) {
      // PROCESS_QUERY_LIMITED_INFORMATION
      const opened = kernel.symbols.OpenProcess(0x1000, 0, pid)
      if (Number(opened ?? 0) === 0) return { exe: "", elevated: true }
      try {
        const name = new Uint16Array(1024)
        const size = new Uint32Array([name.length])
        const exe =
          kernel.symbols.QueryFullProcessImageNameW(opened, 0, name, size) !== 0 ? fileName(unwide(name, size[0])) : ""
        const token = out()
        // TOKEN_QUERY
        if (advapi.symbols.OpenProcessToken(opened, 0x0008, token) === 0) return { exe, elevated: true }
        try {
          const elevation = new Uint32Array(1)
          // TokenElevation
          const queried = advapi.symbols.GetTokenInformation(handle(token[0]!), 20, elevation, 4, new Uint32Array(1))
          return { exe, elevated: queried === 0 || elevation[0] !== 0 }
        } finally {
          kernel.symbols.CloseHandle(handle(token[0]!))
        }
      } finally {
        kernel.symbols.CloseHandle(opened)
      }
    }

    // Brings a window to the foreground. Windows refuses SetForegroundWindow to a background process unless it shares
    // the foreground thread's input state, so the second attempt attaches to that thread first (this thread has a
    // message queue, which AttachThreadInput needs).
    function focus(id: string) {
      const hwnd = parseWindowId(id)
      if (hwnd === undefined) throw failure("bad_request", "id must be a window id such as 0x1a2b")
      requireInput()
      const window = handle(hwnd)
      if (u.IsWindow(window) === 0) throw failure("unknown_window", `window ${windowId(hwnd)} does not exist`)
      // SW_RESTORE
      if (u.IsIconic(window) !== 0) u.ShowWindow(window, 9)
      u.SetForegroundWindow(window)
      if (settled(hwnd)) return
      const thread = u.GetWindowThreadProcessId(u.GetForegroundWindow(), new Uint32Array(1))
      const current = kernel.symbols.GetCurrentThreadId()
      const attached = thread !== 0 && thread !== current && u.AttachThreadInput(current, thread, 1) !== 0
      u.BringWindowToTop(window)
      u.SetForegroundWindow(window)
      if (attached) u.AttachThreadInput(current, thread, 0)
      if (!settled(hwnd)) throw failure("failed", "Windows kept another window in the foreground")
    }

    function settled(hwnd: number) {
      return Array.from({ length: 10 }).some((_, attempt) => {
        if (attempt > 0) Bun.sleepSync(20)
        return Number(u.GetForegroundWindow() ?? 0) === hwnd
      })
    }
  }
}
