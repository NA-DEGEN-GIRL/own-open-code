// Sign in with ChatGPT (siwc) limits live check (02 §7.1, 12장 48): which headers and stream events a real
// token-sharing response carries, so the limit parser can be confirmed. It drives this PC's own service only: a
// `shape` wire capture window (02 §7.8, `diagnostics.capture.*`) limited to the siwc slots, one message that you send
// yourself in own while it waits, then the window's lines and `quota.snapshot` for those accounts.
//
//   bun own/scripts/siwc-limits-check.ts [--minutes 10] [--account <accountID|providerID>] [--replace] [--channel own]
//       [--control DIR]
//       Starts the window, waits until a siwc response is recorded (send one short message with a Sign in with
//       ChatGPT model now), stops it and prints: every response header NAME, the values of limit-like headers only
//       (`x-codex-*`, `x-ratelimit-*`, names with limit/usage/reset/retry/quota/credit/balance, as the capture keeps
//       them: redacted, never credentials), the stream event types and the shapes of limit or error events, and the
//       limit windows the service now shows. `--replace` ends a capture window someone else is running.
//   bun own/scripts/siwc-limits-check.ts --self-test
//       The summary over synthetic capture lines (no service, no request, no cost).
//
// The service URL and password come from the service's registration file (`<XDG_STATE_HOME or ~/.local/state>/
// opencode/service-own.json`, read through @own/runtime ServiceTarget like own's plugins do). The password is used
// only as HTTP Basic to that loopback URL and is never printed: every line is checked for it before it is written.
// The capture keeps header names, limit-like values, statuses and JSON shapes (strings as lengths), never bodies,
// message text or tokens; its files stay under `<OWN_HOME>\diagnostics\captures` for 7 days like any capture.
// Exit: 0 a response was recorded (whatever it carried), 1 failed or nothing recorded, 64 usage error.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { ServiceTarget } from "../../packages/own-runtime/src/index"

const USAGE =
  "usage: bun own/scripts/siwc-limits-check.ts [--minutes N] [--account ID] [--replace] [--channel own] [--control DIR] | --self-test"
const POLL_MS = 2_000
/** After the first response line, the stream line of the same request may still be on its way. */
const SETTLE_MS = 8_000
const LIMIT_NAME = /^x-codex-|^x-ratelimit-|ratelimit|limit|usage|reset|retry|quota|credit|balance/i

const args = parseArgs({
  options: {
    minutes: { type: "string" },
    account: { type: "string" },
    replace: { type: "boolean" },
    channel: { type: "string" },
    control: { type: "string" },
    "self-test": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: false,
}).values

if (import.meta.main) process.exit(await main())

async function main(): Promise<number> {
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  if (args["self-test"]) return selfTest()
  const minutes = Number(args.minutes ?? "10")
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return usage("--minutes must be 1–60")
  const service = await new ServiceTarget.Service(ServiceTarget.registrationPath(args.channel ?? "own")).current()
  if (!service) {
    console.error("The own service is not running (no service-own.json registration). Start it with `own start`.")
    return 1
  }
  const control =
    args.control ??
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "own-open-code", "control")
  return check({ service, control, minutes, account: args.account, replace: args.replace === true })
}

async function check(input: {
  readonly service: ServiceTarget.Target
  readonly control: string
  readonly minutes: number
  readonly account?: string
  readonly replace: boolean
}) {
  const print = guarded(input.service, (line) => console.log(line))
  const rpc = async (method: string, body: unknown) => {
    const response = await fetch(
      new URL(
        `/api/rpc/own.accounts/${method}?${new URLSearchParams({ "location[directory]": input.control })}`,
        input.service.url,
      ),
      {
        method: "POST",
        headers: {
          authorization: input.service.authorization,
          "content-type": "application/json",
          "x-opencode-directory": encodeURIComponent(input.control),
        },
        body: JSON.stringify({ input: body }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    const text = await response.text()
    const json: unknown = text ? JSON.parse(text) : undefined
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${describe(json)}`)
    return field(json, "output")
  }

  const listed = list(field(await rpc("accounts.list", {}), "accounts"))
  const siwc = listed.filter(
    (account) =>
      account.kind === "siwc" &&
      account.status !== "retired" &&
      (input.account === undefined || account.id === input.account || account.providerID === input.account),
  )
  if (siwc.length === 0) {
    print(
      input.account
        ? `No Sign in with ChatGPT account ${input.account}.`
        : "No Sign in with ChatGPT account. Add one in own (계정 > ChatGPT > Sign in with ChatGPT) first.",
    )
    return 1
  }
  print(`Sign in with ChatGPT accounts: ${siwc.map((account) => `${account.id} (${account.providerID})`).join(", ")}`)

  const before = field(await rpc("diagnostics.capture.status", {}), "active")
  if (before === true && !input.replace) {
    print("A wire capture window is already running. Run again with --replace to end it and start this check.")
    return 1
  }
  const started = field(
    await rpc("diagnostics.capture.start", {
      mode: "shape",
      minutes: input.minutes,
      providerIDs: siwc.map((account) => account.providerID),
    }),
    "window",
  )
  const captureID = String(field(started, "id"))
  print(`Capture ${captureID} runs for at most ${input.minutes} min.`)
  print("Now send one short message in own with a Sign in with ChatGPT model (e.g. `hi`). Waiting…")

  const deadline = Date.now() + input.minutes * 60_000
  const lines = await (async function wait(seen: number | undefined): Promise<ReadonlyArray<CaptureLine>> {
    const window = field(await rpc("diagnostics.capture.status", {}), "window")
    const read = await readLines(String(field(window, "dir")), strings(field(window, "files")), captureID)
    const response = read.some((line) => line.event === "response")
    if (response && seen !== undefined && Date.now() - seen >= SETTLE_MS) return read
    if (Date.now() > deadline || field(window, "end") !== null) return read
    await Bun.sleep(POLL_MS)
    return wait(response ? (seen ?? Date.now()) : undefined)
  })(undefined)
  const stopped = field(await rpc("diagnostics.capture.stop", {}), "window")
  const final = await readLines(String(field(stopped, "dir")), strings(field(stopped, "files")), captureID)
  const recorded = final.length >= lines.length ? final : lines

  const summary = summarize(recorded)
  summary.forEach((line) => print(line))

  const snapshot = await rpc("quota.snapshot", { accountIDs: siwc.map((account) => account.id) })
  const windows = list(field(snapshot, "windows"))
  print("")
  print(`Limit windows the service shows for these accounts now: ${windows.length}`)
  for (const window of windows)
    print(
      `  ${window.accountID} ${window.id} "${window.label}" used=${window.usedPercent ?? "-"}% remaining=${window.remaining ?? "-"} resetAt=${typeof window.resetAt === "number" ? new Date(window.resetAt).toISOString() : "-"} status=${window.status} source=${window.source}`,
    )
  for (const item of list(field(snapshot, "exhausted")))
    print(`  exhausted: ${item.accountID} reason=${item.reason} until=${new Date(Number(item.until)).toISOString()}`)
  print("")
  print("Paste everything above (no secrets in it) into the report for 02 §7.1 / 12장 48.")
  return recorded.some((line) => line.event === "response") ? 0 : 1
}

type CaptureLine = Readonly<Record<string, unknown>>

/** The capture's lines of one window, from the day files it wrote (`windows.jsonl` is the summary, skipped). */
async function readLines(dir: string, files: ReadonlyArray<string>, captureID: string) {
  const texts = await Promise.all(
    files
      .filter((file) => !file.endsWith("windows.jsonl"))
      .map((file) => fs.readFile(path.join(dir, ...file.split("/")), "utf8").catch(() => "")),
  )
  return texts
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.trim() !== "")
    .flatMap((line): CaptureLine[] => {
      const json: unknown = JSON.parse(line)
      return isRecord(json) && json.capture === captureID ? [json] : []
    })
}

/** Readable lines: per response its status and header names, limit-like values, and the stream's event types. */
export function summarize(lines: ReadonlyArray<CaptureLine>) {
  const responses = lines.filter((line) => line.event === "response")
  if (responses.length === 0) return ["No siwc response was recorded. Was the message sent with a siwc model?"]
  const names = new Set(responses.flatMap((line) => strings(line.names)))
  const limitNames = [...names].filter((name) => LIMIT_NAME.test(name)).sort()
  const out = [
    "",
    `Responses recorded: ${responses.length}`,
    ...responses.flatMap((line) => {
      const values = isRecord(line.values) ? line.values : {}
      const limits = Object.entries(values).filter((entry) => LIMIT_NAME.test(entry[0]))
      return [
        `- ${line.kind ?? "?"} ${line.transport ?? "?"} HTTP ${line.status} ${line.url ?? ""} (${line.contentType ?? "-"})`,
        `  header names: ${strings(line.names).join(", ")}`,
        ...(limits.length === 0
          ? ["  limit-like header values: none"]
          : limits.map((entry) => `  ${entry[0]}: ${String(entry[1])}`)),
        ...(isRecord(line.body) ? [`  error body shape: ${JSON.stringify(line.body)}`] : []),
      ]
    }),
    ...lines
      .filter((line) => line.event === "stream")
      .flatMap((line) => [
        `- stream (${line.kind ?? "?"}): ${line.events} events, types ${JSON.stringify(line.types)}`,
        ...(Array.isArray(line.shapes) ? line.shapes : [])
          .filter((shape) => isRecord(shape) && /limit|rate|error|failed|usage/i.test(String(shape.type)))
          .map((shape) => `  ${JSON.stringify(shape)}`),
      ]),
    ...lines
      .filter((line) => line.event === "retry")
      .map((line) => `- retry: ${JSON.stringify(line.error)} → ${line.verdict}, ${line.decision}`),
    "",
    `x-codex-* headers: ${[...names].some((name) => name.startsWith("x-codex-")) ? "PRESENT" : "absent"}`,
    `x-ratelimit-* headers: ${[...names].some((name) => name.startsWith("x-ratelimit-")) ? "PRESENT" : "absent"}`,
    `limit-like header names: ${limitNames.length === 0 ? "none" : limitNames.join(", ")}`,
    `rate-limit stream events: ${
      lines.some(
        (line) => line.event === "stream" && Object.keys(isRecord(line.types) ? line.types : {}).some(rateEvent),
      )
        ? "PRESENT"
        : "absent"
    }`,
  ]
  return out
}

function rateEvent(type: string) {
  return /rate_limit|ratelimit|usage_limit/i.test(type)
}

function selfTest() {
  const lines: CaptureLine[] = [
    {
      capture: "cap_x",
      event: "response",
      kind: "primary",
      transport: "http",
      status: 200,
      url: "api.openai.com/v1/responses",
      contentType: "text/event-stream",
      names: ["content-type", "x-codex-primary-used-percent", "x-request-id"],
      values: { "x-codex-primary-used-percent": "12", "x-request-id": "req_1" },
    },
    {
      capture: "cap_x",
      event: "stream",
      kind: "primary",
      events: 3,
      types: { "response.created": 1, "codex.rate_limits": 1, "response.completed": 1 },
      shapes: [{ type: "codex.rate_limits", structure: "s", hash: "h" }],
    },
  ]
  const out = summarize(lines).join("\n")
  const expected = [
    "header names: content-type, x-codex-primary-used-percent, x-request-id",
    "x-codex-primary-used-percent: 12",
    "x-codex-* headers: PRESENT",
    "x-ratelimit-* headers: absent",
    "limit-like header names: x-codex-primary-used-percent",
    "rate-limit stream events: PRESENT",
  ]
  const missing = expected.filter((item) => !out.includes(item))
  const empty = summarize([]).join("\n")
  if (missing.length > 0 || !empty.includes("No siwc response")) {
    console.error(`self-test failed:\n${out}\nmissing: ${missing.join(" | ")}`)
    return 1
  }
  console.log(`${out}\n\nself-test passed`)
  return 0
}

function guarded(service: ServiceTarget.Target, print: (line: string) => void) {
  const encoded = service.authorization.replace(/^Basic\s+/i, "")
  const password = Buffer.from(encoded, "base64")
    .toString("utf8")
    .replace(/^opencode:/, "")
  const secrets = [service.authorization, encoded, password].filter((item) => item.length >= 8)
  return (line: string) => print(secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), line))
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function list(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** An RPC error's `type` and `data`. */
function describe(json: unknown) {
  if (!isRecord(json)) return ""
  return [json.type, json.data === undefined ? undefined : JSON.stringify(json.data)].filter(Boolean).join(" ")
}

function usage(message: string) {
  console.error(`${message}\n${USAGE}`)
  return 64
}
