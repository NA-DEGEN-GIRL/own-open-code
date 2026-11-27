// A stand-in for own-cu-helper.exe speaking the wire protocol (src/driver/windows/protocol.ts) over stdin/stdout,
// backed by a FakeDriver desktop. Started by the transport tests through the `command` override; never touches the
// real desktop. Arguments: `--protocol <n>` and `--dpi <awareness>` change the hello answer, `--events a,b` sends
// those event lines right after hello, `--exit-on <op>` exits with code 5 when that op arrives, `--log <file>` appends
// every request as a JSON line and "eof" when stdin closes, `--no-input` answers like the real helper on a desktop that
// takes no input (locked, or a minimized remote-desktop window): hello says so and captures, input and the cursor fail
// with desktop_unavailable. `--no-chord` reports the stop chord as not registered. Test-only ops: test.hang (never
// answers), test.big {bytes} (one oversized line), test.exit {code}, test.event {event} (an unsolicited line),
// test.norid (answers without rid), test.ops (op log).
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Effect } from "effect"
import { FakeDriver } from "../../src/driver/fake.js"
import { NEEDS_INPUT, answer, type Message } from "./fake-ops.js"

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}

const driver = Effect.runSync(
  FakeDriver.make({
    displays: FakeDriver.DISPLAYS.dual,
    windows: [
      {
        id: "0x10",
        exe: "C:\\Windows\\notepad.exe",
        title: "notes.txt - Notepad",
        bounds: { x: 100, y: 100, width: 800, height: 600 },
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

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)

const NO_INPUT = process.argv.includes("--no-input")

async function handle(message: Message): Promise<Message | undefined> {
  if (NO_INPUT && NEEDS_INPUT.has(message.op))
    return { ok: false, error: "desktop_unavailable", message: "the desktop is not taking input" }
  switch (message.op) {
    case "hello":
      return {
        ok: true,
        name: "own-cu-helper",
        version: "fake",
        protocol: Number(arg("protocol") ?? 1),
        dpiAwareness: arg("dpi") ?? "per_monitor_v2",
        interactive: true,
        inputDesktop: !NO_INPUT,
        pid: process.pid,
        killChord: !process.argv.includes("--no-chord"),
      }
    case "test.hang":
      return undefined
    case "test.big":
      process.stdout.write(`${JSON.stringify({ ok: true, rid: message.rid, data: "x".repeat(message.bytes) })}\n`)
      return undefined
    case "test.exit":
      process.exit(message.code ?? 3)
      return undefined
    case "test.event":
      write({ event: message.event })
      return { ok: true }
    case "test.norid":
      write({ ok: true, norid: true })
      return undefined
    case "test.ops":
      return { ok: true, ops: driver.ops() }
    default:
      return (
        (await answer(driver, message, (bytes) => Buffer.from(bytes).toString("base64"))) ?? {
          ok: false,
          error: "unknown_op",
          message: `unknown op ${message.op}`,
        }
      )
  }
}

// Answers in request order, like the real helper.
let queue = Promise.resolve()
let hellos = 0
const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  if (line.trim() === "") return
  const message = JSON.parse(line) as Message
  const log = arg("log")
  if (log !== undefined) appendFileSync(log, `${line}\n`)
  if (message.op === arg("exit-on")) process.exit(5)
  queue = queue.then(async () => {
    const reply = await handle(message)
    if (reply !== undefined) write({ ...reply, rid: message.rid })
    if (message.op === "hello" && hellos++ === 0)
      for (const event of (arg("events") ?? "").split(",").filter(Boolean)) write({ event })
  })
})
lines.on("close", () => {
  const log = arg("log")
  if (log !== undefined) appendFileSync(log, "eof\n")
  void queue.then(() => process.exit(0))
})
