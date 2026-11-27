// WP14 (P1-3a, P1-10, P0-4; own/reports/external-repos-2026-10-05.md): what DeepSeek's chat completions API does in
// four cases own cannot model without a real key, so the rate card, mid-turn switching and D2 rest on measurements.
//   ttl       How long a prompt prefix stays cached (P1-3a). One prefix of at least 2K tokens per delay (default 0 s,
//             30 s, 2 m, 5 m, 15 m, 60 m), each sent once and re-sent that long after its first send ended, so a hit
//             at one delay never refreshes another. Records prompt_cache_hit_tokens / prompt_tokens and suggests the
//             ds rate card's ttl.warmLowerSec; a cold 0 s re-send (cache not ready yet) is noted apart. Thinking off
//             (variant none), max_tokens 16.
//   history   Whether thinking mode takes another provider's tool call the way upstream OpenAIChat lowers it for a
//             DeepSeek model (P1-10, 02 §5.9(h) mid-turn switch): an assistant tool call with reasoning_content "" and
//             content null in an earlier turn, then in the current turn, with thinking on (variant high) and one tool.
//             Two controls on the current-turn case: the none variant (the documented mitigation) and a placeholder
//             reasoning_content. Records each status and error text.
//   prealloc  Whether max_tokens is reserved in the context window (P0-4, only for D2 option B): one request of about
//             620K prompt tokens with max_tokens 393,216 (the template's output limit; together over the 1,000,000
//             window). A calibration request with the same filler and max_tokens sizes it first, and the large request
//             is sent only if that one is accepted. Costs real money, so it needs its own --prealloc flag.
//   output    Whether DeepSeek takes the output limit core sends from upstream d9987ef9c8 (min(catalog output,
//             256,000), `core/src/session/model-request.ts`) with thinking off (variant none) and on (variant high),
//             beside the template's output limit and D2's thinking-off fallback (`own-accounts/src/auth/auth.ts`), so
//             D2 knows whether to cap it (ds-output-limit-2026-10-08). Four requests of one short prompt; only with
//             --mode output.
// Every request is a streamed chat completion shaped as own sends it: the ds template's variant body and
// reasoning_effort, stream_options.include_usage (packages/ai/src/protocols/openai-chat.ts).
//
// Key: DEEPSEEK_API_KEY when set; otherwise, or with --account, the ds account's key from the vault (the installed
// version's own-vault.exe, read through the credential service own uses; the only ds account, or --account <id or
// label>). The key is never printed or written: each report is checked for it before it is written. The report
// (own/.out/ds-probe/<time>/report.{json,md}, ignored by git) is rewritten after each mode, output, history and
// prealloc first, so an interrupted ttl run (about an hour) keeps them.
//
//   bun own/scripts/ds-probe.ts                    # the plan only: requests, duration, cost; no network, no key read
//   bun own/scripts/ds-probe.ts --yes              # history, then ttl, against api.deepseek.com (user-run)
//   bun own/scripts/ds-probe.ts --yes --prealloc   # also prealloc (the plan shows its cost)
//   bun own/scripts/ds-probe.ts --self-test        # every mode against the e2e-kit openai-chat fake on 127.0.0.1
//   bun own/scripts/ds-probe.ts --yes --mode output  # only the four output limit requests
//   options: --mode <ttl,history,prealloc,output> (default ttl,history; with --prealloc also prealloc), --model <id>
//            (a ds template model, default deepseek-flash), --delays <0,30s,2m,…> (ttl), --account <id or label>,
//            --base-url <url> (default the deepseek endpoint; https://, or http:// on 127.0.0.1, localhost or [::1]
//            only, since the key goes there), --out <dir>
// Exit: 0 done (self-test: passed), 1 failed, 64 usage error.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { DS_THINKING_OFF_OUTPUT } from "../../packages/own-accounts/src/auth/auth"
import { Endpoints } from "../../packages/own-accounts/src/endpoints"
import { Templates } from "../../packages/own-accounts/src/slots/templates"
import type { Registry } from "../../packages/own-protocol/src/index"
import { Credentials, Home, Lock, Store, Vault } from "../../packages/own-runtime/src/index"

const REPO = path.resolve(import.meta.dir, "..", "..")
const MODES = ["ttl", "history", "prealloc", "output"] as const
type Mode = (typeof MODES)[number]
/** The template variant each mode sends. */
const VARIANT = {
  ttl: "none",
  history: "high",
  control: "none",
  prealloc: "low",
  output: "none",
  outputThinking: "high",
} as const
/** Filler words per ttl prefix: about 3K tokens, comfortably over the 2K the measurement needs. */
const TTL_WORDS = 3_000
const TTL_MAX_TOKENS = 16
/** Keeps a thinking reply short and its cost bounded; the status is what history records. */
const HISTORY_MAX_TOKENS = 4_096
const PREALLOC_PROMPT = 620_000
const CALIBRATION_WORDS = 20_000
/** Tokens per filler word the plan assumes before anything was measured (a cost estimate only). */
const PLAN_TOKENS_PER_WORD = 1.3
/** Output the plan allows per prealloc request: a one-word reply after some low-effort thinking. */
const PLAN_PREALLOC_OUTPUT = 2_000
/** Core's cap on the output limit it sends (`OUTPUT_TOKEN_MAX`, `core/src/session/model-request.ts`). */
const CORE_OUTPUT_MAX = 256_000
const OUTPUT_PROMPT = "Reply with exactly: OK"
/** What the plan allows the four output requests together: a short prompt each, "OK" and one short thought. */
const PLAN_OUTPUT_PROMPT = 4 * 20
const PLAN_OUTPUT_COMPLETION = 1_000
const REQUEST_TIMEOUT_MS = 5 * 60_000
const PREALLOC_TIMEOUT_MS = 20 * 60_000
/** A re-send hitting at least this share of its prompt counts as warm. */
const WARM_RATIO = 0.5

const USAGE =
  "usage: bun own/scripts/ds-probe.ts [--yes [--prealloc] | --self-test] [--mode <ttl,history,prealloc,output>] [--model <id>] [--delays <0,30s,2m,…>] [--account <id or label>] [--base-url <url>] [--out <dir>]"

// An unknown or incomplete option is a usage error.
const args = await Promise.try(
  () =>
    parseArgs({
      options: {
        yes: { type: "boolean", default: false },
        prealloc: { type: "boolean", default: false },
        "self-test": { type: "boolean", default: false },
        mode: { type: "string" },
        model: { type: "string", default: "deepseek-flash" },
        delays: { type: "string", default: "0,30s,2m,5m,15m,60m" },
        account: { type: "string" },
        "base-url": { type: "string" },
        out: { type: "string" },
      },
    }).values,
).catch((error: unknown) => usage(error instanceof Error ? error.message : String(error)))
const modes =
  modesOf(args.mode ?? (args.prealloc ? "ttl,history,prealloc" : "ttl,history")) ??
  usage(`--mode takes a comma list of ${MODES.join(", ")}`)
const delays = delaysOf(args.delays) ?? usage("--delays takes a comma list of durations such as 0,30s,2m,1h")
if (args["base-url"] !== undefined && !keySafe(args["base-url"]))
  usage("--base-url takes an https:// URL (http:// only on 127.0.0.1, localhost or [::1]): the key is sent there")
if (args.yes && !args["self-test"] && modes.includes("prealloc") && !args.prealloc)
  usage("prealloc sends about 620K prompt tokens (the plan shows the cost); add --prealloc to confirm it")

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  return process.exit(64)
}

/** Whether the key may go to `url`: https, or plain http to this machine only. */
function keySafe(url: string) {
  const parsed = URL.parse(url)
  if (!parsed) return false
  if (parsed.protocol === "https:") return true
  return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
}

function modesOf(list: string) {
  const items = list.split(",").map((item) => item.trim())
  const known = items.filter((item): item is Mode => MODES.some((mode) => mode === item))
  return known.length === items.length && known.length > 0 ? MODES.filter((mode) => known.includes(mode)) : undefined
}

/** Seconds, ascending, from `0,30s,2m,1h` (a bare number is seconds). */
function delaysOf(list: string) {
  const items = list.split(",").map((item) => /^(\d+)(s|m|h)?$/.exec(item.trim()))
  if (items.some((item) => item === null)) return undefined
  const unit: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600 }
  return items
    .flatMap((item) => (item ? [Number(item[1]) * (unit[item[2] ?? "s"] ?? 1)] : []))
    .toSorted((a, b) => a - b)
}

// ---------------------------------------------------------------------------------------------------------------

interface Setup {
  /** Chat completions base URL (`…/v1`). */
  readonly endpoint: string
  readonly model: Registry.TemplateModel
  readonly modes: ReadonlyArray<Mode>
  /** ttl delays in seconds, ascending. */
  readonly delays: ReadonlyArray<number>
  readonly rates: Rates | undefined
}

/** USD per 1M tokens at peak, from the ds rate card row of the model; off-peak multiplies by `offPeakMul`. */
interface Rates {
  readonly in: number
  readonly read: number
  readonly out: number
  readonly offPeakMul: number
}

async function setupOf(input: {
  readonly model: string
  readonly modes: ReadonlyArray<Mode>
  readonly delays: ReadonlyArray<number>
  readonly endpoint: string
}): Promise<Setup> {
  const template = await Templates.bundled("ds")
  const model = template?.models.find((item) => item.id === input.model)
  if (!model)
    throw new Error(
      `--model ${input.model} is not in the ds template (${template?.models.map((item) => item.id).join(", ")})`,
    )
  const missing = Object.values(VARIANT).filter((name) => !model.variants.some((variant) => variant.id === name))
  if (missing.length > 0) throw new Error(`the ds template's ${model.id} has no variant ${missing.join(", ")}`)
  return {
    endpoint: input.endpoint.replace(/\/+$/, ""),
    model,
    modes: input.modes,
    delays: input.delays,
    rates: await ratesOf(model.id),
  }
}

/** The ds card of `modelID` in the committed rate card seed (peak rates read 2026-10-05). */
async function ratesOf(modelID: string): Promise<Rates | undefined> {
  const file: unknown = await Bun.file(path.join(REPO, "own", "config", "ratecards.default.json")).json()
  const card = (isRecord(file) && Array.isArray(file.cards) ? file.cards.filter(isRecord) : []).find(
    (item) => isRecord(item.match) && item.match.kind === "ds" && item.match.model === modelID,
  )
  if (!card || typeof card.in !== "number" || typeof card.read !== "number" || typeof card.out !== "number")
    return undefined
  return {
    in: card.in,
    read: card.read,
    out: card.out,
    offPeakMul: typeof card.offPeakMul === "number" ? card.offPeakMul : 1,
  }
}

/** No network and no key: what --yes would send, how long it takes and what it costs. */
async function plan() {
  const setup = await setupOf({ model: args.model, modes, delays, endpoint: endpointOf() })
  const key = args.account
    ? `the vault, ds account ${args.account}`
    : process.env.DEEPSEEK_API_KEY
      ? "DEEPSEEK_API_KEY (set in this shell)"
      : "the vault, the only ds account (--account <id or label> when there are several)"
  console.log(planText(setup, key))
  console.log("Run again with --yes to send the selected modes; prealloc also needs --prealloc.")
  return 0
}

function endpointOf() {
  return args["base-url"] ?? Endpoints.DEFAULTS.deepseek
}

function planText(setup: Setup, key: string) {
  const ttlPrompt = Math.round(TTL_WORDS * PLAN_TOKENS_PER_WORD)
  const longest = setup.delays.at(-1) ?? 0
  const calibration = Math.round(CALIBRATION_WORDS * PLAN_TOKENS_PER_WORD)
  const limit = setup.model.limit
  const selected = (mode: Mode) => (setup.modes.includes(mode) ? "" : " (not selected)")
  return [
    `endpoint ${setup.endpoint}/chat/completions, model ${setup.model.modelID} (window ${count(limit.context)}, output ${count(limit.output)})`,
    `key: ${key}; never printed or written`,
    `report: own/.out/ds-probe/<time>/report.{json,md}`,
    "",
    `history${selected("history")}: 4 requests with one tool, thinking on (variant ${VARIANT.history}), max_tokens ${count(HISTORY_MAX_TOKENS)}`,
    `  prior             another provider's tool call (reasoning_content "", content null) in an earlier turn`,
    `  current           the same tool call in the current turn (mid-turn switch)`,
    `  current-none      control: current with thinking off (variant ${VARIANT.control})`,
    `  current-reasoned  control: current with a placeholder reasoning_content`,
    `  cost at most ${money(setup.rates, { miss: 4 * 400, hit: 0, completion: 4 * HISTORY_MAX_TOKENS })}`,
    `prealloc${selected("prealloc")}: needs --prealloc`,
    `  calibration       ${count(CALIBRATION_WORDS)} filler words (~${count(calibration)} tokens), max_tokens ${count(limit.output)}, variant ${VARIANT.prealloc}`,
    `  request           filler sized to ~${count(PREALLOC_PROMPT)} prompt tokens, max_tokens ${count(limit.output)}`,
    PREALLOC_PROMPT + limit.output > limit.context
      ? `                    together ${count(PREALLOC_PROMPT + limit.output)}, over the window: refused only if max_tokens is reserved`
      : `                    together ${count(PREALLOC_PROMPT + limit.output)}, inside the window: this model's limits cannot show a reservation`,
    `  cost about ${money(setup.rates, { miss: calibration + PREALLOC_PROMPT, hit: 0, completion: 2 * PLAN_PREALLOC_OUTPUT })}; a 400 costs nothing`,
    `output${selected("output")}: 4 requests of "${OUTPUT_PROMPT}"`,
    ...outputCases(setup.model).map(
      (item) => `  ${item.id.padEnd(17)} ${item.what}: max_tokens ${count(item.maxTokens)}, variant ${item.variant}`,
    ),
    `  cost about ${money(setup.rates, { miss: PLAN_OUTPUT_PROMPT, hit: 0, completion: PLAN_OUTPUT_COMPLETION })}; a 400 costs nothing`,
    `ttl${selected("ttl")}: ${2 * setup.delays.length} requests, thinking off, max_tokens ${TTL_MAX_TOKENS}`,
    `  ${setup.delays.length} prefixes of ${count(TTL_WORDS)} filler words (~${count(ttlPrompt)} tokens), each re-sent after ${setup.delays.map(label).join(", ")}`,
    `  takes about ${Math.ceil(longest / 60) + 1} minutes (keep the PC awake); cost at most ${money(setup.rates, { miss: 2 * setup.delays.length * ttlPrompt, hit: 0, completion: 2 * setup.delays.length * TTL_MAX_TOKENS })}`,
    "",
    "Peak hours are weekdays 10-13 and 15-19 KST (01-04 and 06-10 UTC); off-peak rates are the rate card's offPeakMul.",
  ].join("\n")
}

/** Sends the selected modes with the key and writes the report after each. */
async function live() {
  const setup = await setupOf({ model: args.model, modes, delays, endpoint: endpointOf() })
  const key = await keyOf()
  const out = args.out ? path.resolve(args.out) : path.join(REPO, "own", ".out", "ds-probe", stamp())
  console.log(
    `endpoint ${setup.endpoint}, model ${setup.model.modelID}, key from ${key.source}; report: ${path.join(out, "report.md")}`,
  )
  const report = await probe({
    ...setup,
    headers: key.headers,
    keySource: key.source,
    clock: { now: () => Date.now(), sleepUntil: (time) => Bun.sleep(Math.max(0, time - Date.now())) },
    log: (line) => console.log(line),
    save: (value) => write(out, value, secretsOf(key.headers)),
  })
  console.log(`\n${markdown(report)}`)
  console.log(`\nreport: ${path.join(out, "report.json")} and report.md`)
  return 0
}

// ---------------------------------------------------------------------------------------------------------------
// Key

interface Key {
  /** `authorization: Bearer <key>`; never printed or written. */
  readonly headers: Readonly<Record<string, string>>
  /** Where the key came from, without the key. */
  readonly source: string
}

async function keyOf(): Promise<Key> {
  const env = process.env.DEEPSEEK_API_KEY
  if (!args.account && env) return { headers: Credentials.keyHeaders("ds", env), source: "DEEPSEEK_API_KEY" }
  const layout = Home.layout(Home.resolve())
  return vaultKey(layout, () => Vault.spawnHelper({ exePath: layout.vaultExe, home: layout.root }), args.account)
}

/**
 * The key headers of the ds account `pick` (id or label; absent: the only one) through the credential service own
 * uses, so a vault item and a linked old-app key both work. The helper starts only once the account is known.
 */
async function vaultKey(layout: Home.Layout, transport: () => Vault.Transport, pick: string | undefined): Promise<Key> {
  const registry = await Store.accounts({ layout, mutex: new Lock.Mutex() }).read()
  const accounts = registry.accounts.filter((account) => account.kind === "ds" && account.status !== "retired")
  const account =
    pick === undefined
      ? accounts.length === 1
        ? accounts[0]
        : undefined
      : accounts.find((item) => item.id === pick || item.label === pick)
  const listed = accounts.map((item) => `${item.label} (${item.id})`).join(", ")
  if (!account && accounts.length === 0)
    throw new Error(`no ds account in ${scrub(layout.accounts)}; add one, or set DEEPSEEK_API_KEY`)
  if (!account && pick === undefined) throw new Error(`several ds accounts (${listed}); pick one with --account`)
  if (!account) throw new Error(`no ds account with the id or label ${pick} (${listed})`)
  const client = new Vault.Client(transport())
  const auth = await new Credentials.Service({ vault: client })
    .headersFor({ account, sessionID: "ds-probe" })
    .finally(() => client.close())
  if (!auth.ok)
    throw new Error(
      `no key for ${account.label} (${account.id}): ${auth.problem}; is own installed here? Otherwise set DEEPSEEK_API_KEY`,
    )
  return { headers: auth.headers, source: `the vault, ${account.label} (${account.id})` }
}

/** Every value that would reveal the key: the header values and the bare key. */
function secretsOf(headers: Readonly<Record<string, string>>) {
  return Object.values(headers).flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")])
}

// ---------------------------------------------------------------------------------------------------------------
// Probe

interface Input extends Setup {
  readonly headers: Readonly<Record<string, string>>
  readonly keySource: string
  readonly clock: {
    now(): number
    sleepUntil(time: number): Promise<void>
  }
  readonly log: (line: string) => void
  readonly save: (report: Report) => Promise<void>
}

interface Usage {
  readonly prompt: number
  readonly hit: number
  readonly miss: number
  readonly completion: number
  readonly reasoning?: number
}

/** One request as the report keeps it: never a header, never the key, the reply only cut short. */
interface Answer {
  readonly status: number | "network" | "timeout"
  readonly ms: number
  /** The provider's error message (or body), cut to 500 characters. */
  readonly error?: string
  readonly finish?: string
  readonly usage?: Usage
  /** The visible reply, cut to 200 characters. */
  readonly reply?: string
  readonly reasoningChars?: number
  readonly toolCalls?: ReadonlyArray<string>
}

interface TtlProbe {
  readonly delaySec: number
  readonly write: Answer
  /** Seconds from the end of the first send to the start of the re-send. */
  readonly idleSec?: number
  readonly read?: Answer
  /** Re-send prompt_cache_hit_tokens / prompt_tokens. */
  readonly ratio?: number
  readonly warm?: boolean
}

interface TtlReport {
  readonly words: number
  readonly probes: ReadonlyArray<TtlProbe>
  /** The longest delay up to which every measured re-send after a delay (0 s aside) was warm; absent when the shortest was cold. */
  readonly warmThroughSec?: number
  /** The shortest delay (0 s aside) whose re-send was cold. */
  readonly firstColdSec?: number
  readonly finding: string
}

interface HistoryCase {
  readonly id: string
  readonly what: string
  readonly variant: string
  readonly answer: Answer
  readonly accepted: boolean
}

interface HistoryReport {
  readonly cases: ReadonlyArray<HistoryCase>
  readonly finding: string
}

interface PreallocReport {
  readonly window: number
  readonly maxTokens: number
  readonly calibration: { readonly words: number; readonly answer: Answer }
  /** Absent when the calibration request was not accepted. */
  readonly request?: { readonly words: number; readonly estimatedPrompt: number; readonly answer: Answer }
  /** `true`: refused naming the context length; `false`: accepted over the window; absent: inconclusive. */
  readonly reserves?: boolean
  readonly finding: string
}

interface OutputCase {
  readonly id: string
  readonly what: string
  readonly variant: string
  readonly maxTokens: number
  readonly answer: Answer
  readonly accepted: boolean
}

interface OutputReport {
  readonly cases: ReadonlyArray<OutputCase>
  /**
   * The largest max_tokens accepted below the smallest refused one (none refused: the largest); absent when none was
   * accepted.
   */
  readonly acceptedMax?: number
  readonly finding: string
}

interface Report {
  readonly version: 1
  readonly at: string
  readonly endpoint: string
  readonly model: string
  readonly keySource: string
  readonly runID: string
  readonly modes: ReadonlyArray<Mode>
  readonly history?: HistoryReport
  readonly prealloc?: PreallocReport
  readonly ttl?: TtlReport
  readonly output?: OutputReport
  /** What the answered requests cost by their usage and the rate card. */
  readonly spent?: { readonly peakUSD: number; readonly offPeakUSD: number }
}

async function probe(input: Input): Promise<Report> {
  const runID = crypto.randomUUID()
  const head = {
    version: 1 as const,
    at: new Date().toISOString(),
    endpoint: input.endpoint,
    model: input.model.modelID,
    keySource: input.keySource,
    runID,
    modes: input.modes,
  }
  const sections: Sections = {}
  const report = (): Report => {
    const spent =
      input.rates &&
      costOf(
        input.rates,
        answersOf(sections).flatMap((answer) => answer.usage ?? []),
      )
    return { ...head, ...sections, ...(spent ? { spent } : {}) }
  }
  // The quick modes first, so an interrupted ttl run keeps them.
  for (const mode of (["output", "history", "prealloc", "ttl"] as const).filter((item) => input.modes.includes(item))) {
    if (mode === "output") sections.output = await output(input)
    if (mode === "history") sections.history = await history(input)
    if (mode === "prealloc") sections.prealloc = await prealloc(input, runID)
    if (mode === "ttl") sections.ttl = await ttl(input, runID)
    await input.save(report())
  }
  return report()
}

type Sections = { history?: HistoryReport; prealloc?: PreallocReport; ttl?: TtlReport; output?: OutputReport }

function answersOf(sections: Sections) {
  return [
    ...(sections.output?.cases.map((item) => item.answer) ?? []),
    ...(sections.history?.cases.map((item) => item.answer) ?? []),
    ...(sections.prealloc ? [sections.prealloc.calibration.answer] : []),
    ...(sections.prealloc?.request ? [sections.prealloc.request.answer] : []),
    ...(sections.ttl?.probes.flatMap((item) => [item.write, ...(item.read ? [item.read] : [])]) ?? []),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// ttl

async function ttl(input: Input, runID: string): Promise<TtlReport> {
  const probes = input.delays.map((delaySec, index) => ({
    delaySec,
    body: chat(input.model, VARIANT.ttl, ttlMessages(runID, index, delaySec), { max_tokens: TTL_MAX_TOKENS }),
  }))
  // First sends, the longest delay first, so the 0 s re-send follows its own first send directly.
  const written: Array<{
    readonly delaySec: number
    readonly body: unknown
    readonly write: Answer
    readonly end: number
  }> = []
  for (const item of probes.toReversed()) {
    const write = await send(input, item.body, REQUEST_TIMEOUT_MS)
    written.push({ ...item, write, end: input.clock.now() })
    input.log(`ttl ${label(item.delaySec)}: first send ${brief(write)}`)
  }
  // Re-sends in the order they fall due.
  const results: TtlProbe[] = []
  for (const item of written.toSorted((a, b) => a.end + a.delaySec * 1000 - (b.end + b.delaySec * 1000))) {
    if (item.write.status !== 200) {
      results.push({ delaySec: item.delaySec, write: item.write })
      continue
    }
    await input.clock.sleepUntil(item.end + item.delaySec * 1000)
    const start = input.clock.now()
    const read = await send(input, item.body, REQUEST_TIMEOUT_MS)
    const ratio = read.usage && read.usage.prompt > 0 ? read.usage.hit / read.usage.prompt : undefined
    results.push({
      delaySec: item.delaySec,
      write: item.write,
      idleSec: Math.round((start - item.end) / 1000),
      read,
      ...(ratio === undefined ? {} : { ratio, warm: ratio >= WARM_RATIO }),
    })
    input.log(`ttl ${label(item.delaySec)}: re-send ${brief(read)}`)
  }
  const sorted = results.toSorted((a, b) => a.delaySec - b.delaySec)
  // A 0 s re-send says whether the cache is usable at once, not how long it lasts: ttlFinding notes it apart.
  const measured = sorted.filter((item) => item.warm !== undefined && item.delaySec > 0)
  const firstCold = measured.find((item) => !item.warm)?.delaySec
  const warmThrough = measured.filter((item) => firstCold === undefined || item.delaySec < firstCold).at(-1)?.delaySec
  return {
    words: TTL_WORDS,
    probes: sorted,
    ...(warmThrough === undefined ? {} : { warmThroughSec: warmThrough }),
    ...(firstCold === undefined ? {} : { firstColdSec: firstCold }),
    finding: ttlFinding(sorted, warmThrough, firstCold),
  }
}

function ttlFinding(probes: ReadonlyArray<TtlProbe>, warmThrough: number | undefined, firstCold: number | undefined) {
  const short = probes.filter((item) => item.write.usage && item.write.usage.prompt < 2048)
  const hitOnWrite = probes.filter((item) => (item.write.usage?.hit ?? 0) > 0)
  const immediate = probes.find((item) => item.delaySec === 0)
  const notes = [
    ...(immediate?.warm === false
      ? ["The 0 s re-send was cold: the prefix was not cached yet right after its answer."]
      : []),
    ...(short.length > 0 ? [`${short.length} prefix(es) had fewer than 2,048 prompt tokens.`] : []),
    ...(hitOnWrite.length > 0
      ? [`${hitOnWrite.length} first send(s) already hit the cache, so their prefix was not new.`]
      : []),
  ]
  if (!probes.some((item) => item.warm !== undefined && item.delaySec > 0))
    return ["No re-send after a delay was measured; see the statuses.", ...notes].join(" ")
  if (warmThrough === undefined)
    return [
      `The shortest delay (${label(firstCold ?? 0)}) was already cold, so nothing supports a warm lower bound above 0.`,
      ...notes,
    ].join(" ")
  return [
    firstCold === undefined
      ? `Warm through ${label(warmThrough)}, the longest delay measured (the cold bound stays unknown; longer delays: --delays).`
      : `Warm through ${label(warmThrough)}; first cold at ${label(firstCold)}.`,
    `Suggested ttl.warmLowerSec for the ds rate card rows: ${warmThrough}.`,
    ...notes,
  ].join(" ")
}

function ttlMessages(runID: string, index: number, delaySec: number) {
  return [
    {
      role: "system",
      content: `ds-probe ${runID} ttl #${index} (${label(delaySec)}). The text below is filler for a prompt cache test; ignore it.\n\n${filler(TTL_WORDS, index + 1)}`,
    },
    { role: "user", content: "Reply with the single word OK." },
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// history

const LOOKUP_TOOL = {
  type: "function",
  function: {
    name: "lookup",
    description: "Returns the value stored under a key.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
}
const CALL = { id: "call_ds_probe_1", type: "function", function: { name: "lookup", arguments: '{"key":"alpha"}' } }
const SYSTEM = {
  role: "system",
  content: "You answer in one short sentence. Use the lookup tool to find stored values.",
}
const ASK = { role: "user", content: "Look up the value of alpha and tell me what it is." }
const RESULT = { role: "tool", tool_call_id: CALL.id, content: "alpha = 42" }
const PLACEHOLDER = "The reasoning for this step came from another model and is not available."

/**
 * Another provider's tool-call step as upstream OpenAIChat lowers it for a DeepSeek model (`lowerAssistantMessage`):
 * no reasoning parts, so `reasoning_content: ""` (requireReasoning), and `content: null` beside the tool calls.
 */
function foreignCall(reasoning: string) {
  return { role: "assistant", content: null, reasoning_content: reasoning, tool_calls: [CALL] }
}

const HISTORY_CASES = [
  {
    id: "prior",
    what: "the foreign tool call is in an earlier turn",
    variant: VARIANT.history,
    messages: [
      SYSTEM,
      ASK,
      foreignCall(""),
      RESULT,
      { role: "assistant", content: "alpha is 42.", reasoning_content: "" },
      { role: "user", content: "Thanks. Reply with the single word done." },
    ],
  },
  {
    id: "current",
    what: "the foreign tool call is in the current turn (mid-turn switch)",
    variant: VARIANT.history,
    messages: [SYSTEM, ASK, foreignCall(""), RESULT],
  },
  {
    id: "current-none",
    what: "control: current with thinking off (the none-variant mitigation)",
    variant: VARIANT.control,
    messages: [SYSTEM, ASK, foreignCall(""), RESULT],
  },
  {
    id: "current-reasoned",
    what: "control: current with a placeholder reasoning_content",
    variant: VARIANT.history,
    messages: [SYSTEM, ASK, foreignCall(PLACEHOLDER), RESULT],
  },
]

async function history(input: Input): Promise<HistoryReport> {
  const cases: HistoryCase[] = []
  for (const item of HISTORY_CASES) {
    const answer = await send(
      input,
      chat(input.model, item.variant, item.messages, { tools: [LOOKUP_TOOL], max_tokens: HISTORY_MAX_TOKENS }),
      REQUEST_TIMEOUT_MS,
    )
    cases.push({ id: item.id, what: item.what, variant: item.variant, answer, accepted: accepted(answer) })
    input.log(`history ${item.id}: ${brief(answer)}`)
  }
  return { cases, finding: historyFinding(cases) }
}

function historyFinding(cases: ReadonlyArray<HistoryCase>) {
  const of = (id: string) => cases.find((item) => item.id === id)
  const verdict = (id: string) => {
    const item = of(id)
    if (!item) return "not sent"
    return item.accepted
      ? "accepted"
      : `refused (${item.answer.status}${item.answer.error ? `: ${item.answer.error}` : ""})`
  }
  const prior = of("prior")
  const current = of("current")
  const lines = [`Earlier turn: ${verdict("prior")}. Current turn: ${verdict("current")}.`]
  if (prior?.accepted && current?.accepted)
    return [
      ...lines,
      'Thinking mode takes another provider\'s tool call with reasoning_content "" and content null in either turn: a mid-turn switch to ds needs no mitigation.',
    ].join(" ")
  if (current && !current.accepted && typeof current.answer.status === "number")
    return [
      ...lines,
      `A mid-turn switch to ds with thinking on would be refused. Mitigations: none variant ${verdict("current-none")}; placeholder reasoning_content ${verdict("current-reasoned")}.`,
      "Follow-up: model this in the openai-chat fake and ask the user for the mitigation.",
    ].join(" ")
  return [...lines, "Inconclusive; see the statuses."].join(" ")
}

// ---------------------------------------------------------------------------------------------------------------
// prealloc

async function prealloc(input: Input, runID: string): Promise<PreallocReport> {
  const window = input.model.limit.context
  const maxTokens = input.model.limit.output
  const sendFiller = (words: number, timeoutMs: number) =>
    send(
      input,
      chat(input.model, VARIANT.prealloc, preallocMessages(runID, words), { max_tokens: maxTokens }),
      timeoutMs,
    )
  const calibrationAnswer = await sendFiller(CALIBRATION_WORDS, REQUEST_TIMEOUT_MS)
  const calibration = { words: CALIBRATION_WORDS, answer: calibrationAnswer }
  input.log(`prealloc calibration: ${brief(calibrationAnswer)}`)
  const perWord =
    accepted(calibrationAnswer) && calibrationAnswer.usage ? calibrationAnswer.usage.prompt / CALIBRATION_WORDS : 0
  if (perWord <= 0)
    return {
      window,
      maxTokens,
      calibration,
      finding: `The calibration request with max_tokens ${count(maxTokens)} was not accepted (${calibrationAnswer.status}${calibrationAnswer.error ? `: ${calibrationAnswer.error}` : ""}), so the ~${count(PREALLOC_PROMPT)}-token request was not sent. An error about max_tokens means the API takes less than the template's output limit for variant ${VARIANT.prealloc}.`,
    }
  const words = Math.round(PREALLOC_PROMPT / perWord)
  const answer = await sendFiller(words, PREALLOC_TIMEOUT_MS)
  input.log(`prealloc request: ${brief(answer)}`)
  const request = { words, estimatedPrompt: Math.round(words * perWord), answer }
  const prompt = answer.usage?.prompt ?? request.estimatedPrompt
  const total = `${count(prompt)} prompt + ${count(maxTokens)} max_tokens = ${count(prompt + maxTokens)}`
  if (accepted(answer) && prompt + maxTokens > window)
    return {
      window,
      maxTokens,
      calibration,
      request,
      reserves: false,
      finding: `Accepted with ${total}, over the ${count(window)} window: DeepSeek does not reserve max_tokens in the window.`,
    }
  if (accepted(answer))
    return {
      window,
      maxTokens,
      calibration,
      request,
      finding: `Accepted, but ${total} fits the ${count(window)} window: inconclusive (the calibration was off).`,
    }
  const named = answer.status === 400 && /context (length|window)|maximum context/i.test(answer.error ?? "")
  return {
    window,
    maxTokens,
    calibration,
    request,
    ...(named ? { reserves: true } : {}),
    finding: named
      ? `Refused naming the context length (${total} by the estimate): DeepSeek counts max_tokens against the window. Then ds compaction needs minReserveTokens = max_tokens + 64k (02 §4.7.3), a capacity fact under R8.`
      : `Not accepted (${answer.status}${answer.error ? `: ${answer.error}` : ""}) without naming the context length: inconclusive.`,
  }
}

function preallocMessages(runID: string, words: number) {
  return [
    { role: "system", content: `ds-probe ${runID} prealloc. The user's text is filler for a context window test.` },
    { role: "user", content: `${filler(words, 7)}\n\nIgnore the text above. Reply with the single word OK.` },
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// output

/** Core's limit first (what a ds slot sends now), then the template's and D2's fallback to place a refusal between. */
function outputCases(model: Registry.TemplateModel) {
  const core = Math.min(model.limit.output, CORE_OUTPUT_MAX)
  return [
    { id: "core-none", what: "core's limit, thinking off", variant: VARIANT.output, maxTokens: core },
    { id: "core-thinking", what: "core's limit, thinking on", variant: VARIANT.outputThinking, maxTokens: core },
    {
      id: "template-none",
      what: "the template's output limit, thinking off",
      variant: VARIANT.output,
      maxTokens: model.limit.output,
    },
    { id: "d2-none", what: "D2's thinking-off fallback", variant: VARIANT.output, maxTokens: DS_THINKING_OFF_OUTPUT },
  ]
}

async function output(input: Input): Promise<OutputReport> {
  const cases: OutputCase[] = []
  for (const item of outputCases(input.model)) {
    const answer = await send(
      input,
      chat(input.model, item.variant, [{ role: "user", content: OUTPUT_PROMPT }], { max_tokens: item.maxTokens }),
      REQUEST_TIMEOUT_MS,
    )
    cases.push({ ...item, answer, accepted: accepted(answer) })
    input.log(`output ${item.id} (max_tokens ${count(item.maxTokens)}): ${brief(answer)}`)
  }
  // A network failure or timeout says nothing about the limit.
  const refused = Math.min(
    ...cases.filter((item) => !item.accepted && typeof item.answer.status === "number").map((item) => item.maxTokens),
  )
  const acceptedMax = Math.max(
    0,
    ...cases.filter((item) => item.accepted && item.maxTokens < refused).map((item) => item.maxTokens),
  )
  return {
    cases,
    ...(acceptedMax > 0 ? { acceptedMax } : {}),
    finding: outputFinding(cases, acceptedMax),
  }
}

function outputFinding(cases: ReadonlyArray<OutputCase>, acceptedMax: number) {
  const verdict = (item: OutputCase) =>
    `${item.id} ${count(item.maxTokens)} ${item.accepted ? "accepted" : `refused (${item.answer.status}${item.answer.error ? `: ${item.answer.error}` : ""})`}`
  const lines = [`${cases.map(verdict).join("; ")}.`]
  const core = cases.filter((item) => item.id.startsWith("core-"))
  if (core.every((item) => item.accepted))
    return [...lines, "DeepSeek takes core's output limit with thinking off and on: D2 needs no cap."].join(" ")
  if (acceptedMax === 0 || core.some((item) => typeof item.answer.status !== "number"))
    return [...lines, "Inconclusive; see the statuses."].join(" ")
  return [
    ...lines,
    `DeepSeek refuses core's output limit: cap a ds request's maxTokens at min(core's value, ${count(acceptedMax)}) in own-accounts auth shaping (D2), or at a larger limit the error names.`,
  ].join(" ")
}

// ---------------------------------------------------------------------------------------------------------------
// Wire

/** A streamed chat completion body as own sends it with the template variant `variant`. */
function chat(
  model: Registry.TemplateModel,
  variant: string,
  messages: ReadonlyArray<unknown>,
  extra: Readonly<Record<string, unknown>>,
) {
  const chosen = model.variants.find((item) => item.id === variant)
  const effort: unknown = chosen?.settings?.reasoningEffort
  return {
    model: model.modelID,
    messages,
    ...extra,
    stream: true,
    stream_options: { include_usage: true },
    ...(typeof effort === "string" ? { reasoning_effort: effort } : {}),
    ...chosen?.body,
  }
}

async function send(input: Input, body: unknown, timeoutMs: number): Promise<Answer> {
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  const timeout = AbortSignal.timeout(timeoutMs)
  const failed = () => ({ status: timeout.aborted ? ("timeout" as const) : ("network" as const), ms: ms() })
  const response = await fetch(`${input.endpoint}/chat/completions`, {
    method: "POST",
    headers: { ...input.headers, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: timeout,
  }).catch(() => undefined)
  if (!response) return failed()
  const text = await response.text().catch(() => undefined)
  if (text === undefined) return failed()
  if (!response.ok) return { status: response.status, ms: ms(), error: messageOf(await jsonOf(text)) ?? cut(text, 500) }
  const records = (
    await Promise.all(
      text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((data) => data !== "" && data !== "[DONE]")
        .map(jsonOf),
    )
  ).filter(isRecord)
  const choices = records.flatMap((record) => (Array.isArray(record.choices) ? record.choices.filter(isRecord) : []))
  const deltas = choices.map((choice) => choice.delta).filter(isRecord)
  const reply = deltas.map((delta) => (typeof delta.content === "string" ? delta.content : "")).join("")
  const reasoningChars = deltas.reduce(
    (sum, delta) => sum + (typeof delta.reasoning_content === "string" ? delta.reasoning_content.length : 0),
    0,
  )
  const toolCalls = deltas
    .flatMap((delta) => (Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : []))
    .flatMap((call) => (isRecord(call.function) && typeof call.function.name === "string" ? [call.function.name] : []))
  const finish = choices.map((choice) => choice.finish_reason).findLast((value) => typeof value === "string")
  const usage = usageOf(records.map((record) => record.usage).findLast(isRecord))
  const error = records.map((record) => record.error).findLast((value) => value !== undefined && value !== null)
  return {
    status: response.status,
    ms: ms(),
    ...(error === undefined ? {} : { error: messageOf({ error }) ?? cut(JSON.stringify(error), 500) }),
    ...(typeof finish === "string" ? { finish } : {}),
    ...(usage ? { usage } : {}),
    ...(reply === "" ? {} : { reply: cut(reply, 200) }),
    ...(reasoningChars > 0 ? { reasoningChars } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  }
}

/** `Response.json` parses without throwing into this code; anything else is undefined. */
function jsonOf(text: string): Promise<unknown> {
  return new Response(text).json().catch(() => undefined)
}

function messageOf(body: unknown) {
  if (!isRecord(body)) return undefined
  if (isRecord(body.error) && typeof body.error.message === "string") return cut(body.error.message, 500)
  return typeof body.error === "string" ? cut(body.error, 500) : undefined
}

function usageOf(value: Record<string, unknown> | undefined): Usage | undefined {
  if (!value || typeof value.prompt_tokens !== "number") return undefined
  // DeepSeek's own field first, the OpenAI-style one as a fallback.
  const cached = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details.cached_tokens : undefined
  const hit =
    typeof value.prompt_cache_hit_tokens === "number"
      ? value.prompt_cache_hit_tokens
      : typeof cached === "number"
        ? cached
        : 0
  const reasoning = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details.reasoning_tokens
    : undefined
  return {
    prompt: value.prompt_tokens,
    hit,
    miss:
      typeof value.prompt_cache_miss_tokens === "number" ? value.prompt_cache_miss_tokens : value.prompt_tokens - hit,
    completion: typeof value.completion_tokens === "number" ? value.completion_tokens : 0,
    ...(typeof reasoning === "number" ? { reasoning } : {}),
  }
}

function accepted(answer: Answer) {
  return answer.status === 200 && answer.error === undefined
}

function costOf(rates: Rates, usages: ReadonlyArray<Pick<Usage, "miss" | "hit" | "completion">>) {
  const peakUSD = usages.reduce(
    (sum, item) => sum + (item.miss * rates.in + item.hit * rates.read + item.completion * rates.out) / 1e6,
    0,
  )
  return { peakUSD, offPeakUSD: peakUSD * rates.offPeakMul }
}

/**
 * `words` words from a fixed list in a fixed order for `seed`: no randomness, so a re-send repeats the text byte for
 * byte, and common English words keep the token count close to the word count.
 */
function filler(words: number, seed: number) {
  return Array.from({ length: words }, (_, index) => WORDS[(index * index + index * 7 + seed) % WORDS.length]).join(" ")
}

const WORDS = (
  "time year people way day thing world life hand part child eye place work week case point number group problem " +
  "fact water room money story month book job word business issue side kind head house service friend power hour " +
  "game line end member law car city name team minute idea body information back parent face level office door " +
  "health person art war history party result change morning reason research girl moment air teacher force " +
  "education foot boy age policy process music market sense nation plan college interest death experience effect " +
  "class control care field development role effort rate heart drug show leader light voice wife police mind price " +
  "report decision son view relationship town road arm difference value building action model season society tax"
).split(" ")

// ---------------------------------------------------------------------------------------------------------------
// Output

async function write(dir: string, report: Report, secrets: ReadonlyArray<string>) {
  const json = `${JSON.stringify(report, null, 2)}\n`
  const md = `${markdown(report)}\n`
  // Defense in depth: nothing of the key may reach a file.
  if (secrets.some((secret) => secret !== "" && (json.includes(secret) || md.includes(secret))))
    throw new Error("the report would contain the key; nothing was written")
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(path.join(dir, "report.json"), json)
  await Bun.write(path.join(dir, "report.md"), md)
}

function markdown(report: Report) {
  const tokens = (usage: Usage | undefined) => (usage ? `${count(usage.hit)} / ${count(usage.prompt)}` : "–")
  const outcome = (answer: Answer) =>
    cell(
      answer.error ??
        [answer.reply, answer.toolCalls ? `tool ${answer.toolCalls.join(", ")}` : ""].filter(Boolean).join("; "),
    )
  return [
    `# DeepSeek probe (${report.at})`,
    "",
    `endpoint \`${report.endpoint}\`, model \`${report.model}\`, key from ${report.keySource}, run \`${report.runID}\``,
    ...(report.spent
      ? [`spent about ${usd(report.spent.peakUSD)} at peak rates, ${usd(report.spent.offPeakUSD)} off-peak`]
      : []),
    ...(report.output
      ? [
          "",
          "## Output limit (output)",
          "",
          `prompt "${OUTPUT_PROMPT}"`,
          "",
          "| case | variant | max_tokens | status | finish | completion (reasoning) | reply or error |",
          "|---|---|---|---|---|---|---|",
          ...report.output.cases.map(
            (item) =>
              `| ${item.id}: ${item.what} | ${item.variant} | ${count(item.maxTokens)} | ${item.answer.status} | ${item.answer.finish ?? "–"} | ${item.answer.usage ? `${count(item.answer.usage.completion)} (${count(item.answer.usage.reasoning ?? 0)})` : "–"} | ${outcome(item.answer)} |`,
          ),
          "",
          `Finding: ${report.output.finding}`,
        ]
      : []),
    ...(report.history
      ? [
          "",
          "## Thinking history (history)",
          "",
          "| case | variant | status | finish | completion (reasoning) | reply or error |",
          "|---|---|---|---|---|---|",
          ...report.history.cases.map(
            (item) =>
              `| ${item.id}: ${item.what} | ${item.variant} | ${item.answer.status} | ${item.answer.finish ?? "–"} | ${item.answer.usage ? `${count(item.answer.usage.completion)} (${count(item.answer.usage.reasoning ?? 0)})` : "–"} | ${outcome(item.answer)} |`,
          ),
          "",
          `Finding: ${report.history.finding}`,
        ]
      : []),
    ...(report.prealloc
      ? [
          "",
          "## Window pre-allocation (prealloc)",
          "",
          `window ${count(report.prealloc.window)}, max_tokens ${count(report.prealloc.maxTokens)}`,
          "",
          "| request | words | prompt tokens | status | ms | result |",
          "|---|---|---|---|---|---|",
          `| calibration | ${count(report.prealloc.calibration.words)} | ${report.prealloc.calibration.answer.usage ? count(report.prealloc.calibration.answer.usage.prompt) : "–"} | ${report.prealloc.calibration.answer.status} | ${report.prealloc.calibration.answer.ms} | ${outcome(report.prealloc.calibration.answer)} |`,
          ...(report.prealloc.request
            ? [
                `| request | ${count(report.prealloc.request.words)} | ${report.prealloc.request.answer.usage ? count(report.prealloc.request.answer.usage.prompt) : `~${count(report.prealloc.request.estimatedPrompt)}`} | ${report.prealloc.request.answer.status} | ${report.prealloc.request.answer.ms} | ${outcome(report.prealloc.request.answer)} |`,
              ]
            : []),
          "",
          `Finding: ${report.prealloc.finding}`,
        ]
      : []),
    ...(report.ttl
      ? [
          "",
          "## Cache warm window (ttl)",
          "",
          `${count(report.ttl.words)} filler words per prefix; warm = re-send hit at least ${WARM_RATIO * 100}% of the prompt`,
          "",
          "| delay | idle s | first send: status, hit / prompt | re-send: status, hit / prompt | ratio | warm |",
          "|---|---|---|---|---|---|",
          ...report.ttl.probes.map(
            (item) =>
              `| ${label(item.delaySec)} | ${item.idleSec ?? "–"} | ${item.write.status}, ${tokens(item.write.usage)} | ${item.read ? `${item.read.status}, ${tokens(item.read.usage)}` : "not sent"} | ${item.ratio === undefined ? "–" : item.ratio.toFixed(2)} | ${item.warm === undefined ? "–" : item.warm ? "yes" : "no"} |`,
          ),
          "",
          `Finding: ${report.ttl.finding}`,
        ]
      : []),
  ].join("\n")
}

function brief(answer: Answer) {
  const usage = answer.usage ? `, hit ${count(answer.usage.hit)} / ${count(answer.usage.prompt)} prompt tokens` : ""
  return `${answer.status}${usage}${answer.error ? ` (${answer.error})` : ""}`
}

function money(rates: Rates | undefined, tokens: Pick<Usage, "miss" | "hit" | "completion">) {
  if (!rates) return "unknown (no ds rate card row for the model)"
  const cost = costOf(rates, [tokens])
  return `${usd(cost.peakUSD)} at peak rates, ${usd(cost.offPeakUSD)} off-peak`
}

function usd(value: number) {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`
}

function count(value: number) {
  return value.toLocaleString("en-US")
}

function label(seconds: number) {
  return seconds === 0 || seconds % 60 !== 0 ? `${seconds} s` : `${seconds / 60} m`
}

function cell(text: string) {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|") || "–"
}

function cut(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

function scrub(file: string) {
  const relative = path.relative(os.homedir(), file)
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : path.join("~", relative)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test

/** The fake's cache lifetime: a 10-minute TTL makes 0 s through 5 m warm and 15 m and 60 m cold. */
const FAKE_TTL_MS = 10 * 60_000

/**
 * Every mode against the e2e-kit openai-chat fake (127.0.0.1) on a manual clock, with the key taken from a fixture
 * registry and the in-memory vault through the same code as a live run. The fake's responder stands in for the three
 * DeepSeek rules the probe looks for (its messages say "selftest"; they are not DeepSeek's): thinking with an empty
 * reasoning_content tool call in the current turn is refused, prompt + max_tokens over the window is refused while
 * `reserve` is on, and max_tokens over `outputCap` is refused once that is set. Checks the requests' shapes and
 * headers, each finding, the plan's cost line, the written report and that the key is in neither report.
 */
async function selfTest() {
  // Test code (the fake and its helpers), loaded only here: the plan and the live run never import it.
  const { startFakeOpenAIChat } = await import("../../packages/own-accounts/test/e2e-kit/fakes/openai-chat")
  const { hashSecret, manualClock } = await import("../../packages/own-accounts/test/e2e-kit/fakes/shared")
  const key = "sk-ds-probe-selftest-0123456789abcdef"
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-ds-probe-selftest-"))
  const layout = Home.layout(root)
  const accountID = "acc_01JDSPROBESELFTEST00000000"
  await Bun.write(
    layout.accounts,
    JSON.stringify({
      ...Store.emptyRegistry(),
      accounts: [
        {
          id: accountID,
          kind: "ds",
          label: "ds probe",
          shortLabel: "d",
          color: "violet",
          providerID: "own-ds-p7q2",
          cacheDomain: "cd_p7q2",
          quotaDomain: "qd_p7q2",
          billing: "prepaid",
          identity: { keyHint: "sk-…cdef" },
          autoSwitch: false,
          status: "ready",
        },
      ],
    }),
  )
  const vault = Vault.memory()
  const stored = await new Credentials.Service({ vault: new Vault.Client(vault) }).store(accountID, {
    type: "key",
    key,
  })
  const credential = await vaultKey(layout, () => vault, undefined)
  const clock = manualClock()
  const rules: { reserve: boolean; outputCap?: number } = { reserve: true }
  const setup = await setupOf({
    model: "deepseek-flash",
    modes: MODES,
    delays: [0, 30, 120, 300, 900, 3600],
    endpoint: "",
  })
  const window = setup.model.limit.context
  const fake = startFakeOpenAIChat({
    clock,
    credentials: { [key]: { domain: "ds-probe" } },
    cache: { ttlMs: FAKE_TTL_MS },
    responder(request) {
      const body = request.json
      if (!isRecord(body) || !Array.isArray(body.messages)) return undefined
      const messages: ReadonlyArray<unknown> = body.messages
      const turn = messages.slice(messages.findLastIndex((message) => isRecord(message) && message.role === "user") + 1)
      const thinking = isRecord(body.thinking) && body.thinking.type === "enabled"
      if (
        thinking &&
        turn.some(
          (message) => isRecord(message) && message.reasoning_content === "" && Array.isArray(message.tool_calls),
        )
      )
        return {
          type: "error",
          status: 400,
          body: {
            error: {
              message: "selftest: the reasoning_content of a tool call in the current turn must not be empty",
              type: "invalid_request_error",
            },
          },
        }
      if (rules.outputCap !== undefined && typeof body.max_tokens === "number" && body.max_tokens > rules.outputCap)
        return {
          type: "error",
          status: 400,
          body: {
            error: {
              message: `selftest: max_tokens must be at most ${rules.outputCap}`,
              type: "invalid_request_error",
            },
          },
        }
      const requested = (request.cache?.promptTokens ?? 0) + (typeof body.max_tokens === "number" ? body.max_tokens : 0)
      if (rules.reserve && requested > window)
        return {
          type: "error",
          status: 400,
          body: {
            error: {
              message: `selftest: This model's maximum context length is ${window} tokens. However, you requested ${requested} tokens.`,
              type: "invalid_request_error",
            },
          },
        }
      return undefined
    },
  })
  const out = path.join(root, "out")
  const input: Input = {
    ...setup,
    endpoint: fake.baseURL,
    headers: credential.headers,
    keySource: credential.source,
    clock: {
      now: () => clock.now(),
      sleepUntil: async (time) => clock.set(Math.max(clock.now(), time)),
    },
    log: () => undefined,
    save: (value) => write(out, value, secretsOf(credential.headers)),
  }
  const result = await probe(input)
  // The same prealloc against a fake that does not reserve max_tokens.
  rules.reserve = false
  const open = await prealloc(input, result.runID)
  // The same output requests against a fake that takes at most 200,000.
  rules.outputCap = 200_000
  const capped = await output(input)
  await fake.stop()
  if (args.out) await write(path.resolve(args.out), result, secretsOf(credential.headers))
  const written = {
    json: await Bun.file(path.join(out, "report.json"))
      .text()
      .catch(() => ""),
    md: await Bun.file(path.join(out, "report.md"))
      .text()
      .catch(() => ""),
  }
  const planned = planText(setup, "the vault")
  const models = fake.requests.filter((request) => request.method === "POST")
  const bodies = models.map((request) => request.json).filter(isRecord)
  const system = (body: Record<string, unknown>) => {
    const first: unknown = Array.isArray(body.messages) ? body.messages[0] : undefined
    return isRecord(first) && typeof first.content === "string" ? first.content : ""
  }
  const ttlRequests = models.filter((request) => isRecord(request.json) && system(request.json).includes(" ttl #"))
  const historyBodies = bodies.filter((body) => Array.isArray(body.tools) && body.tools.length > 0)
  const ttlReport = result.ttl
  const historyReport = result.history
  const preallocReport = result.prealloc
  const historyCase = (id: string) => historyReport?.cases.find((item) => item.id === id)
  const big = models.filter((request) => isRecord(request.json) && system(request.json).includes(" prealloc."))
  const outputBodies = bodies.filter(
    (body) =>
      Array.isArray(body.messages) &&
      body.messages.length === 1 &&
      isRecord(body.messages[0]) &&
      body.messages[0].content === OUTPUT_PROMPT,
  )
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    [
      "the vault key source read the fixture ds account's key through the credential service",
      stored.ok && credential.headers.authorization === `Bearer ${key}` && credential.source.includes(accountID),
    ],
    [
      "every model request carried the key as a bearer token",
      models.length > 0 && models.every((request) => request.headers.authorization === hashSecret(`Bearer ${key}`)),
    ],
    [
      "ttl: each prefix was sent twice, byte for byte, and was at least 2,048 tokens",
      ttlRequests.length === 12 &&
        new Set(ttlRequests.map((request) => request.bodyHash)).size === 6 &&
        (ttlReport?.probes.every((item) => (item.write.usage?.prompt ?? 0) >= 2048) ?? false),
    ],
    ["ttl: every first send was cold", ttlReport?.probes.every((item) => item.write.usage?.hit === 0) ?? false],
    [
      "ttl: warm through 5 m and cold from 15 m (fake TTL 10 m), with the idle times kept",
      ttlReport?.warmThroughSec === 300 &&
        ttlReport.firstColdSec === 900 &&
        ttlReport.probes.every((item) => item.idleSec === item.delaySec) &&
        ttlReport.finding.includes("ttl.warmLowerSec for the ds rate card rows: 300"),
    ],
    [
      "history: thinking on with one tool, except the none control",
      historyBodies.length === 4 &&
        historyBodies.every(
          (body, index) =>
            isRecord(body.thinking) &&
            body.thinking.type === (HISTORY_CASES[index]?.variant === "none" ? "disabled" : "enabled") &&
            (body.thinking.type === "disabled" || body.reasoning_effort === "high"),
        ),
    ],
    [
      'history: the foreign tool call went as content null with reasoning_content ""',
      historyBodies
        .slice(0, 2)
        .every(
          (body) =>
            Array.isArray(body.messages) &&
            body.messages.some(
              (message: unknown) =>
                isRecord(message) &&
                message.role === "assistant" &&
                message.content === null &&
                message.reasoning_content === "" &&
                Array.isArray(message.tool_calls),
            ),
        ),
    ],
    [
      "history: the earlier turn accepted, the current turn refused with its status and error text",
      historyCase("prior")?.accepted === true &&
        historyCase("current")?.accepted === false &&
        historyCase("current")?.answer.status === 400 &&
        (historyCase("current")?.answer.error?.startsWith("selftest:") ?? false),
    ],
    [
      "history: both mitigations accepted, and the finding says so",
      historyCase("current-none")?.accepted === true &&
        historyCase("current-reasoned")?.accepted === true &&
        (historyReport?.finding.includes("none variant accepted; placeholder reasoning_content accepted") ?? false),
    ],
    [
      "prealloc: a calibrated request of about 620K prompt tokens with max_tokens 393,216",
      big.length === 4 &&
        big.every((request) => isRecord(request.json) && request.json.max_tokens === 393_216) &&
        big
          .filter((request) => (request.cache?.promptTokens ?? 0) > 100_000)
          .every((request) => Math.abs((request.cache?.promptTokens ?? 0) - PREALLOC_PROMPT) < PREALLOC_PROMPT * 0.01),
    ],
    [
      "prealloc: a fake that reserves max_tokens is reported as reserving",
      preallocReport?.reserves === true && preallocReport.request?.answer.status === 400,
    ],
    [
      "prealloc: a fake that does not reserve is reported as not reserving",
      open.reserves === false && open.request?.answer.status === 200,
    ],
    [
      "output: core's 256,000 with thinking off and on, the template's 393,216 and D2's 65,536, one prompt each",
      outputBodies.length === 8 &&
        outputBodies
          .slice(0, 4)
          .every(
            (body, index) =>
              body.max_tokens === [256_000, 256_000, 393_216, DS_THINKING_OFF_OUTPUT][index] &&
              isRecord(body.thinking) &&
              body.thinking.type === (index === 1 ? "enabled" : "disabled"),
          ),
    ],
    [
      "output: a fake without a cap takes all four, and the finding says D2 needs no cap",
      (result.output?.cases.every((item) => item.accepted) ?? false) &&
        result.output?.acceptedMax === 393_216 &&
        result.output.finding.includes("D2 needs no cap"),
    ],
    [
      "output: a fake capping max_tokens at 200,000 refuses core's limit, and the finding names 65,536",
      capped.cases
        .filter((item) => !item.accepted)
        .map((item) => item.id)
        .join() === "core-none,core-thinking,template-none" &&
        capped.acceptedMax === DS_THINKING_OFF_OUTPUT &&
        capped.finding.includes("min(core's value, 65,536)"),
    ],
    [
      "the plan shows each mode's cost",
      planned.includes("prealloc") && (planned.match(/ at peak rates, /g)?.length ?? 0) === 4,
    ],
    [
      "report.json and report.md were written with every mode and the spend",
      written.json.includes('"output"') &&
        written.md.includes("## Output limit (output)") &&
        written.json.includes('"ttl"') &&
        written.json.includes('"history"') &&
        written.json.includes('"prealloc"') &&
        written.md.includes("## Cache warm window (ttl)") &&
        result.spent !== undefined,
    ],
    [
      "no key in the reports",
      [written.json, written.md, JSON.stringify(result), markdown(result)].every((text) => !text.includes(key)),
    ],
  ]
  await fs.rm(root, { recursive: true, force: true })
  for (const [name, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`)
  const passed = checks.every((check) => check[1])
  console.log(passed ? "self-test ok" : "self-test FAILED")
  return passed ? 0 : 1
}

// ---------------------------------------------------------------------------------------------------------------

// Last, so every constant above is initialized before any mode runs.
const code = await (args["self-test"] ? selfTest() : args.yes ? live() : plan()).catch((error: unknown) => {
  console.error(`ds-probe: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
process.exit(code)
