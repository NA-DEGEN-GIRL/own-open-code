export * as UiaWorker from "./uia.js"

import type { FFITypeOrString, Pointer } from "bun:ffi"
import { Result, Schema } from "effect"
import { FfiChannel } from "./channel.js"
import type { DesktopWorker } from "./desktop.js"
import { controlTypeName, failed, failure, guid, hex } from "./native.js"

/**
 * The UI Automation worker of the in-process Windows driver: a second Bun worker thread that answers only
 * `focus.element` (the focused element's process, control type and IsPassword, for the password-field rule). A UI
 * Automation provider in another app can hang, so this runs apart from the desktop worker: a hung query never stalls
 * input, and the driver abandons this worker after `TIMEOUT_MS` and starts a fresh one for the next query. COM through
 * `bun:ffi`: CoInitializeEx (MTA), CoCreateInstance(CUIAutomation) → IUIAutomation, then vtable calls
 * (GetFocusedElement, get_CurrentProcessId, get_CurrentControlType, get_CurrentIsPassword, Release). Started from
 * source text like the desktop worker (desktop.ts), so `main` may use only its parameter, globals, `bun:ffi` and the
 * `Native` functions.
 */

/** Like the helper's `focus.element`: an answer later than this counts as no answer (the gate then types nothing). */
export const TIMEOUT_MS = 3_000

/** `hello.name` of the UI Automation worker. */
export const NAME = "own-cu-uia"

export function source(config: DesktopWorker.Config) {
  return FfiChannel.script(main, config)
}

const Hello = Schema.Struct({ ok: Schema.Literal(true), name: Schema.Literal(NAME), automation: Schema.Boolean })

/** Why a UI Automation worker's `hello` is refused (UI Automation could not be created), or `undefined`. */
export function refusal(hello: unknown) {
  return Result.match(Schema.decodeUnknownResult(Hello)(hello), {
    onFailure: () => "computer-use UI Automation worker sent a malformed hello",
    onSuccess: (value) => (value.automation ? undefined : "UI Automation is not available (CoCreateInstance failed)"),
  })
}

type Request = { readonly rid: number; readonly op: "hello" | "focus.element" | "close" }

async function main(config: DesktopWorker.Config) {
  const worker = start(config)
  self.onmessage = (event: MessageEvent<Request>) => {
    void worker.then(
      (handle) => handle(event.data),
      (error: unknown) => postMessage({ ...failed(error), rid: event.data.rid }),
    )
  }

  async function start(config: DesktopWorker.Config) {
    // A computed specifier keeps a bundler from touching the import; Bun resolves it at run time.
    const ffi = (await import(String("bun:ffi"))) as DesktopWorker.Ffi
    const ole = ffi.dlopen("ole32.dll", {
      CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
      CoUninitialize: { args: [], returns: "void" },
      CoCreateInstance: { args: ["ptr", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    })
    // COINIT_MULTITHREADED: UI Automation clients belong in the MTA (no message pump needed).
    const initialized = ole.symbols.CoInitializeEx(null, 0) >= 0
    const created = new BigUint64Array(1)
    const automation =
      initialized &&
      ole.symbols.CoCreateInstance(
        // CLSID_CUIAutomation, CLSCTX_INPROC_SERVER, IID_IUIAutomation
        guid("FF48DBA4-60EF-4201-AA87-54103EEF594E"),
        null,
        1,
        guid("30CBE57D-D9D0-452A-AB13-7AC5AC4825EE"),
        created,
      ) === 0
        ? (Number(created[0]) as Pointer)
        : undefined
    const methods = new Map<number, (...args: Array<unknown>) => number>()
    // One compiled call per function pointer; every element comes from UIAutomationCore, so the pointers repeat.
    const method = (object: Pointer, index: number, args: Array<FFITypeOrString>, returns: FFITypeOrString) => {
      const pointer = ffi.read.ptr(ffi.read.ptr(object, 0), index * 8)
      const known = methods.get(pointer)
      if (known !== undefined) return known
      const compiled = ffi.CFunction({ ptr: pointer as Pointer, args, returns }) as unknown as (
        ...args: Array<unknown>
      ) => number
      methods.set(pointer, compiled)
      return compiled
    }
    const state = { closed: false }

    return (request: Request) => postMessage({ ...respond(request), rid: request.rid })

    function respond(request: Request): Record<string, unknown> {
      try {
        if (request.op === "hello")
          return {
            ok: true,
            name: "own-cu-uia",
            version: config.version,
            protocol: 1,
            automation: automation !== undefined,
          }
        if (request.op === "close") return close()
        if (automation === undefined || state.closed) throw failure("failed", "UI Automation is not available")
        return { ok: true, focus: focused(automation) }
      } catch (error) {
        return failed(error)
      }
    }

    function focused(client: Pointer) {
      const element = new BigUint64Array(1)
      // IUIAutomation::GetFocusedElement
      const result = method(client, 8, ["ptr", "ptr"], "i32")(client, element)
      if (result < 0) throw failure("failed", `GetFocusedElement failed (${hex(result)})`)
      if (element[0] === 0n) return null
      const pointer = Number(element[0]) as Pointer
      try {
        const pid = new Int32Array(1)
        const type = new Int32Array(1)
        const password = new Int32Array(1)
        // IUIAutomationElement::get_CurrentProcessId, get_CurrentControlType, get_CurrentIsPassword
        for (const [index, value] of [
          [20, pid],
          [21, type],
          [35, password],
        ] as const) {
          const read = method(pointer, index, ["ptr", "ptr"], "i32")(pointer, value)
          if (read < 0) throw failure("failed", `UI Automation property ${index} failed (${hex(read)})`)
        }
        const name = controlTypeName(type[0]!)
        return { pid: pid[0], isPassword: password[0] !== 0, ...(name === undefined ? {} : { controlType: name }) }
      } finally {
        // IUnknown::Release
        method(pointer, 2, ["ptr"], "u32")(pointer)
      }
    }

    function close() {
      if (state.closed) return { ok: true }
      state.closed = true
      if (automation !== undefined) method(automation, 2, ["ptr"], "u32")(automation)
      if (initialized) ole.symbols.CoUninitialize()
      return { ok: true }
    }
  }
}
