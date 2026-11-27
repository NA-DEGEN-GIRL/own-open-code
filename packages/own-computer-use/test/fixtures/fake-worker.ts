// In-process stand-ins for the in-process driver's worker threads (src/driver/windows/ffi/desktop.ts and uia.ts): `Spawn`
// functions whose ports answer the same messages from a FakeDriver desktop, asynchronously like a real worker, and
// record what they were sent. Never touches the real desktop. Test-only ops: test.hang (never answers), test.crash
// (an uncaught error: `error`, then `exit(1)`), test.exit {code}, test.event {event} (an unsolicited message).
import { Effect } from "effect"
import { FakeDriver } from "../../src/driver/fake.js"
import type { FfiChannel } from "../../src/driver/windows/ffi/channel.js"
import { NEEDS_INPUT, answer, type Message } from "./fake-ops.js"

export interface Options {
  /** Overrides of the desktop worker's hello answer (`protocol`, `dpiAwareness`, `killChord`, …). */
  readonly hello?: Message
  /** Answer every op but `hello` and `close` with `busy`, like a second driver without the desktop mutex. */
  readonly busy?: boolean
  readonly noInput?: boolean
  /** Events sent right after the first hello of each desktop worker. */
  readonly events?: ReadonlyArray<string>
  /** Desktop worker ops that never get an answer. */
  readonly hang?: ReadonlyArray<string>
  /** Desktop worker ops that crash the worker like `test.crash`. */
  readonly crash?: ReadonlyArray<string>
  /** The UI Automation worker never answers `focus.element`. */
  readonly uiaHang?: boolean
  /** The UI Automation worker's hello says UI Automation could not be created. */
  readonly uiaUnavailable?: boolean
  /** Workers ignore `close` (stuck in a native call), so only `terminate` ends them. */
  readonly ignoreClose?: boolean
}

export interface Workers {
  readonly driver: FakeDriver.FakeDriver
  readonly desktop: FfiChannel.Spawn
  readonly uia: FfiChannel.Spawn
  /** Every message each desktop worker received, by worker (0 = the first started). */
  readonly desktopLog: Array<Array<Message>>
  readonly uiaLog: Array<Array<Message>>
  /** Workers that were terminated, by kind and index. */
  readonly terminated: Array<string>
}

export function workers(options: Options = {}): Workers {
  const driver = Effect.runSync(
    FakeDriver.make({
      displays: FakeDriver.DISPLAYS.dual,
      windows: [
        {
          id: "0x10",
          exe: "C:\\Windows\\notepad.exe",
          title: "notes.txt - Notepad",
          bounds: { x: 100, y: 100, width: 800, height: 600 },
          focus: { isPassword: false, controlType: "Edit" },
        },
        {
          id: "0x20",
          exe: "C:\\Windows\\System32\\cmd.exe",
          title: "Command Prompt",
          bounds: { x: -1800, y: 300, width: 900, height: 500 },
        },
      ],
      foreground: "0x10",
    }),
  )
  const desktopLog: Array<Array<Message>> = []
  const uiaLog: Array<Array<Message>> = []
  const terminated: Array<string> = []

  const port = (
    kind: "desktop" | "uia",
    handlers: FfiChannel.Handlers,
    respond: (message: Message, emit: (value: Message) => void) => Promise<Message | undefined>,
    crashes: ReadonlyArray<string> = [],
  ): FfiChannel.Port => {
    const log = kind === "desktop" ? desktopLog : uiaLog
    const index = log.length
    const received: Array<Message> = []
    log.push(received)
    const state = { ended: false, queue: Promise.resolve() }
    const emit = (value: Message) => {
      if (!state.ended) handlers.message(value)
    }
    const end = (code: number) => {
      if (state.ended) return
      state.ended = true
      handlers.exit(code)
    }
    return {
      post: (message) => {
        if (state.ended) return
        const request = message as Message
        received.push(request)
        // Answers in order and never synchronously, like a worker thread.
        state.queue = state.queue.then(async () => {
          await Bun.sleep(0)
          if (state.ended) return
          if (request.op === "close" && options.ignoreClose) return
          if (request.op === "test.crash" || crashes.includes(request.op)) {
            state.ended = true
            handlers.error("boom")
            handlers.exit(1)
            return
          }
          if (request.op === "test.exit") return end(request.code)
          const reply = await respond(request, emit)
          if (reply !== undefined) emit({ ...reply, rid: request.rid })
        })
      },
      terminate: () => {
        if (state.ended) return
        terminated.push(`${kind}:${index}`)
        // Bun reports a terminated worker's end later, as a `close` event.
        void Bun.sleep(1).then(() => end(0))
      },
    }
  }

  const desktop: FfiChannel.Spawn = (handlers) => {
    const hellos = { count: 0 }
    return port(
      "desktop",
      handlers,
      async (message, emit) => {
        if (message.op === "hello") {
          if (hellos.count++ === 0)
            setTimeout(() => {
              for (const event of options.events ?? []) emit({ event })
            }, 0)
          return {
            ok: true,
            name: "own-cu-ffi",
            version: "fake",
            protocol: 1,
            dpiAwareness: "per_monitor_v2",
            interactive: true,
            inputDesktop: !options.noInput,
            pid: process.pid,
            killChord: true,
            ...options.hello,
          }
        }
        if (message.op === "close") return { ok: true }
        if (options.hang?.includes(message.op) || message.op === "test.hang") return undefined
        if (message.op === "test.event") {
          emit({ event: message.event })
          return { ok: true }
        }
        if (options.busy) return { ok: false, error: "busy", message: "another driver holds the desktop" }
        if (options.noInput && NEEDS_INPUT.has(message.op))
          return { ok: false, error: "desktop_unavailable", message: "the desktop is not taking input" }
        if (message.op === "focus.element")
          return { ok: false, error: "unknown_op", message: "unknown op focus.element" }
        return (
          (await answer(driver, message, (bytes) => bytes)) ?? {
            ok: false,
            error: "unknown_op",
            message: `unknown op ${message.op}`,
          }
        )
      },
      options.crash,
    )
  }

  const uia: FfiChannel.Spawn = (handlers) =>
    port("uia", handlers, async (message) => {
      if (message.op === "hello")
        return { ok: true, name: "own-cu-uia", version: "fake", protocol: 1, automation: !options.uiaUnavailable }
      if (message.op === "close") return { ok: true }
      if (message.op === "focus.element" && options.uiaHang) return undefined
      return answer(driver, message, (bytes) => bytes)
    })

  return { driver, desktop, uia, desktopLog, uiaLog, terminated }
}
