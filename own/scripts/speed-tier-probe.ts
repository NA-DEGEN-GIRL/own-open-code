// Speed tier live probe (02 §4.8, own/reports/speed-live-checks.md 4): whether an account really serves the speed its
// model list offers, e.g. a Sign in with ChatGPT account whose catalog names Ultrafast for gpt-6.1-sol while every
// response said `service_tier: "default"` (2026-10-10). Run it yourself: each speed is one short real request on that
// account, billed by its plan (Fast about ×2.5 and Ultrafast about ×8 of the included usage, a few hundred tokens).
//
//   bun own/scripts/speed-tier-probe.ts --provider own-siwc-uhgdr8 --model gpt-6.1-sol
//       The plan only: the account's offers for the model (`session.speed.get` of a new, empty session) and the
//       requests it would send. Creates that one empty session, sends nothing to a provider.
//   bun own/scripts/speed-tier-probe.ts --provider own-siwc-uhgdr8 --model gpt-6.1-sol --yes [--speeds ultrafast,fast]
//       For each speed (default ultrafast,fast, then standard as the baseline): a new session on the model in
//       --directory (default a temporary folder), `session.speed.set`, one prompt (`Reply with exactly: OK`, twice
//       for a faster speed so a passing downgrade shows), then per step the ledger's requested and served tier and
//       the output rate (output and reasoning tokens over the step's time). Ultrafast should run several times faster
//       than standard; a served `default` at standard's rate means the account does not get that speed.
//   options: --channel own (service registration), --directory DIR
//
// Everything goes through this PC's own service on 127.0.0.1, like own-web: the script never sees a provider token.
// The service password (from `service-<channel>.json`, read through @own/runtime ServiceTarget) is used only as HTTP
// Basic to that loopback URL and every printed line is checked for it. The probe sessions stay in the session list
// (title `speed probe …`); delete them there when done. Exit: 0 done, 1 failed, 64 usage error.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { ServiceTarget } from "../../packages/own-runtime/src/index"

const USAGE =
  "usage: bun own/scripts/speed-tier-probe.ts --provider ID --model ID [--yes] [--speeds ultrafast,fast] [--directory DIR] [--channel own]"
const SPEEDS = ["ultrafast", "fast"] as const
const PROMPT = "Reply with exactly: OK"
const WAIT_MS = 5 * 60_000

const args = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    yes: { type: "boolean" },
    speeds: { type: "string" },
    directory: { type: "string" },
    channel: { type: "string" },
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
  if (!args.provider || !args.model) return usage("--provider and --model are required")
  const speeds = (args.speeds ?? SPEEDS.join(",")).split(",").map((item) => item.trim())
  if (speeds.some((item) => !SPEEDS.some((known) => known === item))) return usage("--speeds takes ultrafast and fast")
  const service = await new ServiceTarget.Service(ServiceTarget.registrationPath(args.channel ?? "own")).current()
  if (!service) {
    console.error("The own service is not running (no service registration). Start it with `own start`.")
    return 1
  }
  const directory = args.directory ?? path.join(os.tmpdir(), "own-speed-probe")
  await fs.mkdir(directory, { recursive: true })
  const client = connect(service, directory)
  const model = { providerID: args.provider, id: args.model }
  const print = client.print

  const first = await client.session(model, "speed probe (plan)")
  const view = record(await client.rpc("session.speed.get", { sessionID: first }))
  const offers = Array.isArray(view.offers) ? view.offers.map(record) : []
  print(`${model.providerID}/${model.id}: ${offers.length} faster speed(s) offered`)
  offers.forEach((offer) =>
    print(
      `  ${offer.choice} · tier ${offer.tier} · ${offer.basis} · ${offer.status}${offer.reason ? ` (${offer.reason})` : ""}`,
    ),
  )
  const planned = [...speeds, "standard"]
  print(
    `Plan: ${planned.map((speed) => `${speed} ×${speed === "standard" ? 1 : 2}`).join(", ")} — one short prompt each`,
  )
  if (!args.yes) {
    print("Nothing was sent to a provider. Add --yes to run the plan (it spends plan usage).")
    return 0
  }

  const rows = await planned.reduce<Promise<string[]>>(async (done, speed) => {
    const lines = await done
    const sessionID = speed === planned[0] ? first : await client.session(model, `speed probe ${speed}`)
    const set = await client
      .rpc("session.speed.set", { sessionID, speed })
      .then(() => undefined)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    if (set) return [...lines, `${speed}: not set (${set})`]
    await [1, ...(speed === "standard" ? [] : [2])].reduce(async (previous) => {
      await previous
      await client.http("POST", `/api/session/${sessionID}/prompt`, { text: PROMPT })
      await client.http("POST", `/api/experimental/session/${sessionID}/wait`)
    }, Promise.resolve())
    return [...lines, ...(await steps(client, sessionID, speed))]
  }, Promise.resolve([]))
  rows.forEach(print)
  return 0
}

/** Each step of a probe session: the ledger's tiers and the output rate of its assistant message. */
async function steps(client: ReturnType<typeof connect>, sessionID: string, speed: string) {
  const deadline = Date.now() + WAIT_MS
  const ledger = async (): Promise<Record<string, unknown>[]> => {
    const lines = record(await client.rpc("ledger.session", { sessionID })).steps
    const found = Array.isArray(lines) ? lines.map(record) : []
    if (found.length > 0 || Date.now() > deadline) return found
    await Bun.sleep(500)
    return ledger()
  }
  const lines = await ledger()
  const list = record(await client.http("GET", `/api/session/${sessionID}/message`)).data
  const messages = (Array.isArray(list) ? list.map(record) : []).filter((item) => item.type === "assistant")
  return lines.map((line, index) => {
    const tiers = record(line.speed)
    const message = messages[index]
    const time = record(message?.time)
    const tokens = record(message?.tokens)
    const seconds = (Number(time.completed) - Number(time.created)) / 1000
    const output = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0)
    const rate = seconds > 0 ? `${Math.round(output / seconds)} tok/s` : "?"
    return `${speed} step ${index + 1}: requested ${tiers.requested ?? "-"} · served ${tiers.served ?? "-"} · ${output} tokens in ${seconds.toFixed(1)} s (${rate})`
  })
}

/** The loopback service: RPC, HTTP and a print that never shows the credential. */
function connect(service: ServiceTarget.Target, directory: string) {
  const encoded = service.authorization.replace(/^Basic\s+/i, "")
  const password = Buffer.from(encoded, "base64")
    .toString("utf8")
    .replace(/^opencode:/, "")
  const secrets = [service.authorization, encoded, password].filter((item) => item.length >= 8)
  const print = (line: string) =>
    console.log(secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), line))
  const http = async (method: string, route: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(new URL(route, service.url), {
      method,
      headers: {
        authorization: service.authorization,
        "x-opencode-directory": encodeURIComponent(directory),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(WAIT_MS),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : undefined
  }
  return {
    print,
    http,
    rpc: async (method: string, input: unknown) =>
      record(await http("POST", `/api/rpc/own.accounts/${method}`, { input })).output,
    session: async (model: { readonly providerID: string; readonly id: string }, title: string) => {
      const created = record(record(await http("POST", "/api/session", { title, model, location: { directory } })).data)
      if (typeof created.id !== "string") throw new Error("session.create returned no id")
      return created.id
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function usage(message: string) {
  console.error(`${message}\n${USAGE}`)
  return 64
}
