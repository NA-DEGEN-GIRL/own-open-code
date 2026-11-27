// Live measurement of cache-preserving compaction (CC, own/reports/cached-compaction-2026-10.md §6, results §9): the
// same conversations on servers booted from different checkouts, each with own.accounts and own.harness and the seeded
// accounts of own-team's e2e harness (`team: false`) pointing at the live forwarder, which puts in the real
// credentials: the Anthropic key from set-key.ps1, DeepSeek, ChatGPT 01 (HTTP). Every arm runs every case at once, and
// each case is one conversation: prompts from tasks.ts, waits, `/compact`. The report is per compaction: its tokens,
// cached share `read / (input + read + write)`, cost, and the request it came from (core's `prefix` record and
// own-accounts' cache verdict in the checkpoint's metadata; a checkpoint from before P-034 has neither and is the
// older-part request), plus the first request after a wait (the cold rebuild that idle compaction saves).
//
//   bun script/live/run.ts --suite compaction-cache --arms main=D:/own-open-code,branch=. --cases haiku-warm,haiku-gap
//       (an arm's checkout is relative to this one's root)
//       [--buffer 150000]  core `compaction.buffer` (a low auto threshold: the window minus this)
//       [--keep 3000]      core `compaction.keep.tokens` (the recent part's text tool outputs are capped, so a long
//                          recent part needs a small keep to start at its user message)
//       [--idle]           own-accounts idle compaction on (1 minute away, any size; a P-034 checkpoint only)
//       [--cap anthropic=4.5,deepseek=0.18] [--spend <file>]   hard caps in USD over every run sharing the spend file
//       [--gap 330] [--cold 390] [--away 360]                  waits in seconds
//
// A case may name one arm (`haiku-away@main`). Spending is counted from the responses' usage (the forwarder's meter);
// a request past a cap is refused before it leaves this PC. Cases run at once on one API key, so conversations of one
// model share the cached system and tool prefix: a wait cools only the conversation part while another one of that
// model is running. Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Ratecard } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Schema } from "effect"
import { REPO_ROOT, type OpencodeServer } from "../../../own-accounts/test/e2e-kit"
import { CHATGPT, SLOT, startTeamFakes, startTeamServer, type TeamServer } from "../../../own-team/test/e2e/harness.ts"
import { hasAnthropic } from "./credentials.js"
import { startForwarder, type Usage } from "./forwarder.js"
import { TASKS } from "./tasks.js"

const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
  { action: "webfetch", resource: "**", effect: "allow" },
] as const

const MODELS = {
  haiku: { slot: "anthropic", id: "claude-haiku-4-5" },
  sonnet: { slot: "anthropic", id: "claude-sonnet-5", variant: "low" },
  opus: { slot: "anthropic", id: "claude-opus-5-5", variant: "low" },
  deepseek: { slot: "deepseek", id: "deepseek-v4-pro", variant: "low" },
  gpt: { slot: "01", id: "gpt-6.1-sol", variant: "low" },
} as const satisfies Record<string, { slot: keyof typeof SLOT; id: string; variant?: string }>

/**
 * tasks.ts plus a long recent part for S1: `numbers` is one turn of eleven sequential tool calls with about 2.7k tokens
 * of output each (over 20 content blocks; with `--keep 3000` the kept part starts at its user message), and `count`,
 * after a wait, answers without tools. The older part then ends more than 20 blocks before the breakpoint of every
 * request of the last `TTL`.
 */
const PROMPTS = {
  ...TASKS,
  numbers:
    "Without creating or changing any files, run the shell command " +
    "`bun -e \"console.log(Array.from({ length: 900 }, (_, i) => i * 7).join(' '))\"` eleven times, " +
    "one call at a time: wait for each call's output before you start the next, never run two at once " +
    "and never combine them into one command. After the eleventh, reply with the single word done.",
  count: "How many times did you run that command? Answer with the number only. Do not use tools.",
} as const

type Step =
  | { readonly prompt: keyof typeof PROMPTS }
  | { readonly wait: "gap" | "cold" | "away" }
  | { readonly compact: true }

const CASES = {
  "haiku-warm": { model: "haiku", steps: [{ prompt: "merge" }, { prompt: "subtract" }, { compact: true }] },
  "haiku-gap": {
    model: "haiku",
    steps: [{ prompt: "merge" }, { wait: "gap" }, { prompt: "subtract" }, { compact: true }],
  },
  "haiku-cold": {
    model: "haiku",
    steps: [{ prompt: "merge" }, { prompt: "subtract" }, { wait: "cold" }, { compact: true }],
  },
  "haiku-away": {
    model: "haiku",
    steps: [{ prompt: "merge" }, { prompt: "subtract" }, { wait: "away" }, { prompt: "cli" }],
  },
  "haiku-long": {
    model: "haiku",
    steps: [{ prompt: "merge" }, { prompt: "numbers" }, { wait: "gap" }, { prompt: "count" }, { compact: true }],
  },
  "haiku-auto": {
    model: "haiku",
    steps: [{ prompt: "merge" }, { prompt: "subtract" }, { prompt: "cli" }, { prompt: "review" }],
  },
  "sonnet-warm": { model: "sonnet", steps: [{ prompt: "merge" }, { prompt: "subtract" }, { compact: true }] },
  "sonnet-gap": {
    model: "sonnet",
    steps: [{ prompt: "merge" }, { wait: "gap" }, { prompt: "subtract" }, { compact: true }],
  },
  "sonnet-long": {
    model: "sonnet",
    steps: [{ prompt: "merge" }, { prompt: "numbers" }, { wait: "gap" }, { prompt: "count" }, { compact: true }],
  },
  "opus-gap": {
    model: "opus",
    steps: [{ prompt: "merge" }, { wait: "gap" }, { prompt: "subtract" }, { compact: true }],
  },
  "opus-long": {
    model: "opus",
    steps: [{ prompt: "merge" }, { prompt: "numbers" }, { wait: "gap" }, { prompt: "count" }, { compact: true }],
  },
  "deepseek-warm": { model: "deepseek", steps: [{ prompt: "merge" }, { prompt: "subtract" }, { compact: true }] },
  "gpt-warm": { model: "gpt", steps: [{ prompt: "merge" }, { prompt: "subtract" }, { compact: true }] },
  "gpt-gap": { model: "gpt", steps: [{ prompt: "merge" }, { wait: "gap" }, { prompt: "subtract" }, { compact: true }] },
} as const satisfies Record<string, { model: keyof typeof MODELS; steps: ReadonlyArray<Step> }>
type CaseName = keyof typeof CASES

/**
 * Per 1M tokens: Anthropic list prices in USD (5-minute cache writes; an unknown Claude model at Opus 5 rates, so a
 * cap never undercounts); DeepSeek V4 Pro from own's rate card, its peak price, the card's off-peak multiplier applied
 * per request; ChatGPT in credits from the card of gpt-5.6-sol, the nearest one (gpt-6.1-sol has none).
 */
const PRICES: Readonly<
  Record<string, { unit: "USD" | "credits"; in: number; read: number; write: number; out: number }>
> = {
  "claude-haiku-4-5": { unit: "USD", in: 1, read: 0.1, write: 1.25, out: 5 },
  "claude-sonnet-5": { unit: "USD", in: 2, read: 0.2, write: 2.5, out: 10 },
  "claude-opus-5-5": { unit: "USD", in: 4, read: 0.2, write: 5, out: 20 },
  claude: { unit: "USD", in: 5, read: 0.5, write: 6.25, out: 25 },
  "deepseek-v4-pro": { unit: "USD", in: 1.32, read: 0.044, write: 0, out: 3.96 },
  "gpt-6.1-sol": { unit: "credits", in: 100, read: 10, write: 0, out: 500 },
}

export async function compactionCache(args: ReadonlyArray<string>) {
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 ? args[at + 1] : undefined
  }
  const out = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-compaction"))
  fs.mkdirSync(out, { recursive: true })
  const spendFile = path.resolve(option("spend") ?? path.join(out, "spend.jsonl"))
  const caps = Object.fromEntries(
    (option("cap") ?? "anthropic=4.5,deepseek=0.18").split(",").map((pair) => {
      const [family = "", usd = "0"] = pair.split("=")
      return [family, Number(usd)]
    }),
  )
  const waits = {
    gap: Number(option("gap") ?? 330),
    cold: Number(option("cold") ?? 390),
    away: Number(option("away") ?? 360),
  }
  const buffer = option("buffer") === undefined ? undefined : Number(option("buffer"))
  const keep = option("keep") === undefined ? undefined : Number(option("keep"))
  const idleOn = args.includes("--idle")
  const arms = (option("arms") ?? `branch=${REPO_ROOT}`).split(",").map((pair) => {
    const [name = "", repo = "."] = pair.split("=")
    return { name, repo: path.resolve(REPO_ROOT, repo) }
  })
  const cases = (option("cases") ?? "haiku-warm").split(",").map((spec) => {
    const [name = "", only] = spec.split("@")
    if (!(name in CASES)) throw new Error(`unknown case ${name}`)
    return { name: name as CaseName, only }
  })
  if (cases.some((item) => MODELS[CASES[item.name].model].slot === "anthropic") && !hasAnthropic())
    throw new Error("No Anthropic key: run script/live/set-key.ps1 first")
  const prices = await deepseekPeak(path.join(REPO_ROOT, "own/config/ratecards.default.json"))

  const spent = () =>
    fs
      .readFileSync(spendFile, { encoding: "utf8", flag: "a+" })
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { family: string; amount: number })
      .reduce<Record<string, number>>(
        (sum, line) => ({ ...sum, [line.family]: (sum[line.family] ?? 0) + line.amount }),
        {},
      )
  const familyOf = (route: string) => (route.startsWith("chatgpt") ? "chatgpt" : route)
  const forwarder = startForwarder(path.join(out, "forwarder.jsonl"), { [CHATGPT["01"].accountID]: "01" }, 0, {
    allow: (route) => {
      const family = familyOf(route)
      const cap = caps[family]
      return cap === undefined || (spent()[family] ?? 0) < cap
    },
    record: (entry) =>
      fs.appendFileSync(
        spendFile,
        JSON.stringify({
          ...entry,
          family: familyOf(entry.route),
          amount: prices(entry.model, entry.usage, Date.parse(entry.at)).amount,
        }) + "\n",
      ),
  })
  console.log(JSON.stringify({ step: "start", out, spent: spent(), caps, waits, buffer, keep, idle: idleOn, arms }))

  // One at a time: a source boot is CPU-bound. Every booted one is stopped at the end, also when a later one fails.
  const servers: Array<{ arm: string; team: TeamServer; stopFakes: () => Promise<void> }> = []
  async function boot(arm: { readonly name: string; readonly repo: string }) {
    const harness = await harnessOf(arm.repo)
    const fakes = harness.startTeamFakes()
    const team = await harness.startTeamServer({
      name: `cc-${arm.name}`,
      project: "none",
      team: false,
      fakes,
      codexTransport: "http",
      keepTemp: true,
      // Another checkout's own transpile cache would be written inside it; keep that checkout read-only.
      ...(arm.repo === REPO_ROOT
        ? {}
        : { env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(out, `bun-cache-${arm.name}`) } }),
      ...(buffer === undefined && keep === undefined
        ? {}
        : {
            config: {
              compaction: {
                ...(buffer === undefined ? {} : { buffer }),
                ...(keep === undefined ? {} : { keep: { tokens: keep } }),
              },
            },
          }),
      accountsOptions: {
        endpoints: {
          codex: `${forwarder.url}/chatgpt-team`,
          anthropic: `${forwarder.url}/anthropic/v1`,
          deepseek: `${forwarder.url}/deepseek/v1`,
          // Never a real call with the fake credentials: token refresh, usage and the rest stay on the fakes.
          oauthIssuer: fakes.codex.url,
          chatgpt: `${fakes.codex.url}/backend-api`,
          openai: `${fakes.codex.url}/v1`,
          xai: `${fakes.codex.url}/v1`,
          openrouter: `${fakes.codex.url}/v1`,
          deepgram: fakes.codex.url,
        },
        ratecardsSeed: path.join(arm.repo, "own/config/ratecards.default.json"),
      },
      plugins: [{ package: path.join(arm.repo, "packages/own-harness"), options: {} }],
    })
    const wanted = [...new Set(cases.map((item) => CASES[item.name].model))].map((key) => ({
      providerID: SLOT[MODELS[key].slot],
      id: MODELS[key].id,
    }))
    await team.server.waitForModels(wanted, 180_000)
    if (idleOn)
      await team.accounts("policy.set", {
        patch: { compaction: { idle: { enabled: true, minIdleMinutes: 1, minTokens: 1 } } },
      })
    console.log(
      JSON.stringify({ step: "booted", arm: arm.name, repo: arm.repo, root: team.root, url: team.server.url }),
    )
    servers.push({ arm: arm.name, team, stopFakes: () => fakes.stop() })
  }

  const directories = new Set<string>()
  const replies = answerPermissions(servers, directories)
  try {
    for (const arm of arms) await boot(arm)
    const results = await Promise.all(
      servers.flatMap((server) =>
        cases
          .filter((item) => item.only === undefined || item.only === server.arm)
          .map((item) =>
            runCase(server.arm, server.team, item.name, { waits, prices, directories, out }).catch(
              (error: unknown) => ({
                arm: server.arm,
                case: item.name,
                error: String(error),
              }),
            ),
          ),
      ),
    )
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ results, spent: spent() }, null, 2))
    console.table(
      results.flatMap((result) =>
        "error" in result
          ? [{ arm: result.arm, case: result.case, what: `error: ${result.error.slice(0, 120)}` }]
          : [
              ...result.compactions.map((item) => ({
                arm: result.arm,
                case: result.case,
                what: `compaction ${item.reason}`,
                path: item.path,
                "in/read/write/out": `${item.tokens.input}/${item.tokens.read}/${item.tokens.write}/${item.tokens.output}`,
                share: item.share,
                cost: item.cost,
              })),
              ...result.afterWait.map((item) => ({
                arm: result.arm,
                case: result.case,
                what: `first request of ${item.task}`,
                path: "",
                "in/read/write/out": `${item.tokens.input}/${item.tokens.read}/${item.tokens.write}/${item.tokens.output}`,
                share: item.share,
                cost: item.cost,
              })),
              { arm: result.arm, case: result.case, what: "conversation total", cost: result.total.cost },
            ],
      ),
    )
    console.log(JSON.stringify({ step: "end", spent: spent() }))
  } finally {
    replies.stop()
    for (const server of servers) {
      fs.writeFileSync(path.join(out, `server-${server.arm}.log`), server.team.server.logs())
      await server.team.stop()
      await server.stopFakes()
    }
    await forwarder.stop()
  }
}

/** The e2e harness of checkout `repo`: it boots that checkout's server and plugins (another copy of the module). */
async function harnessOf(
  repo: string,
): Promise<{ readonly startTeamServer: typeof startTeamServer; readonly startTeamFakes: typeof startTeamFakes }> {
  if (repo === REPO_ROOT) return { startTeamServer, startTeamFakes }
  return import(pathToFileURL(path.join(repo, "packages/own-team/test/e2e/harness.ts")).href)
}

type Prices = Awaited<ReturnType<typeof deepseekPeak>>

/** Prices one response at the time it was requested (DeepSeek's off-peak multiplier from own's rate card). */
async function deepseekPeak(file: string) {
  const cards = Schema.decodeUnknownSync(Ratecard.File)(await Bun.file(file).json()).cards
  const card = cards.find((item) => item.match.kind === "ds" && item.match.model === "deepseek-v4-pro")
  return (model: string | undefined, usage: Usage, at: number) => {
    const rate = PRICES[model ?? ""] ?? (model?.startsWith("claude") ? PRICES.claude : undefined)
    if (rate === undefined) return { unit: "?", amount: 0 }
    const factor = model === "deepseek-v4-pro" && card ? Ratecard.multiplier(card, at) : 1
    const amount =
      ((usage.input * rate.in + usage.read * rate.read + usage.write * rate.write + usage.output * rate.out) / 1e6) *
      factor
    return { unit: rate.unit, amount }
  }
}

async function runCase(
  arm: string,
  team: TeamServer,
  name: CaseName,
  context: {
    readonly waits: Readonly<Record<"gap" | "cold" | "away", number>>
    readonly prices: Prices
    readonly directories: Set<string>
    readonly out: string
  },
) {
  const prices = context.prices
  const spec = CASES[name]
  const model = MODELS[spec.model]
  const server = team.server
  const directory = path.join(team.root, "ws", name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: `cc-${name}`, type: "module" }, null, 2),
  )
  fs.writeFileSync(path.join(directory, "AGENTS.md"), "Use Bun. Keep the code small and typed.\n")
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  context.directories.add(directory)
  const ref = {
    providerID: SLOT[model.slot],
    id: model.id,
    ...("variant" in model ? { variant: model.variant } : {}),
  }
  const created = (await server.call("POST", "/api/session", {
    body: {
      // A title keeps core's title request out of the measurement.
      title: `cc ${arm} ${name}`,
      model: ref,
      location: { directory },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: { id: "codex", v: 1 } },
    },
    directory,
  })) as { data: { id: string } }
  const sessionID = created.data.id
  await team.accounts("session.approval.set", { sessionID, mode: "full" }, directory)
  const log = (entry: Record<string, unknown>) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), arm, case: name, ...entry }))
  log({ step: "session", sessionID, model: ref })
  const prompts: Array<{ readonly task: string; readonly afterWait: boolean; readonly at: number }> = []
  for (const [index, step] of spec.steps.entries()) {
    const started = Date.now()
    if ("prompt" in step) {
      prompts.push({ task: step.prompt, afterWait: index > 0 && "wait" in spec.steps[index - 1]!, at: started })
      await server.prompt(sessionID, PROMPTS[step.prompt])
      await idle(server, sessionID)
    }
    if ("wait" in step) await Bun.sleep(context.waits[step.wait] * 1000)
    if ("compact" in step) {
      await server.call("POST", `/api/session/${sessionID}/compact`, { body: {}, directory })
      await idle(server, sessionID)
    }
    log({ step: index, kind: Object.keys(step)[0], seconds: Math.round((Date.now() - started) / 1000) })
  }
  await Bun.sleep(2_000)
  const messages = await history(server, sessionID, directory)
  fs.writeFileSync(path.join(context.out, `history-${arm}-${name}.json`), JSON.stringify(messages, null, 2))
  const ledger = ledgerLines(team.ownHome, sessionID)
  const usageOf = (message: Record<string, unknown>) => {
    const tokens = message.tokens as
      | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      | undefined
    const usage = {
      input: tokens?.input ?? 0,
      read: tokens?.cache?.read ?? 0,
      write: tokens?.cache?.write ?? 0,
      output: (tokens?.output ?? 0) + (tokens?.reasoning ?? 0),
    }
    const id = (message.model as { id?: string } | undefined)?.id ?? model.id
    const at = (message.time as { created?: number } | undefined)?.created ?? Date.now()
    const priced = prices(id, usage, at)
    const prompt = usage.input + usage.read + usage.write
    return {
      tokens: usage,
      share: prompt === 0 ? null : Math.round((usage.read / prompt) * 1000) / 10,
      cost: `${priced.unit === "USD" ? "$" : ""}${priced.amount.toFixed(4)}${priced.unit === "credits" ? " cr" : ""}`,
      amount: priced.amount,
      at,
    }
  }
  const compactions = messages
    .filter((message) => message.type === "compaction")
    .map((message) => {
      const metadata = (message.metadata ?? {}) as Record<string, unknown>
      const record = metadata.prefix as { request?: string; reason?: string } | undefined
      const verdict = metadata["own.compaction.cache"] as
        | { prefix?: string; reason?: string; ageMs?: number }
        | undefined
      const trigger = metadata["own.compaction.trigger"] as string | undefined
      const at = (message.time as { created?: number } | undefined)?.created ?? 0
      return {
        reason: `${String(message.reason)}${trigger ? `/${trigger}` : ""}`,
        status: message.status,
        path: record?.request
          ? `${record.request}${record.reason ? ` (${record.reason})` : ""}`
          : verdict
            ? `older (${verdict.reason})`
            : "older (no hook asked)",
        verdict,
        ...usageOf(message),
        ledger: ledger
          .filter((line) => line.kind === "compaction")
          .toSorted((a, b) => Math.abs(a.ts - at) - Math.abs(b.ts - at))[0],
      }
    })
  const afterWait = prompts
    .filter((item) => item.afterWait)
    .flatMap((item) => {
      const first = messages.find(
        (message) =>
          message.type === "assistant" && ((message.time as { created?: number } | undefined)?.created ?? 0) >= item.at,
      )
      return first === undefined ? [] : [{ task: item.task, ...usageOf(first) }]
    })
  const priced = messages
    .filter((message) => message.type === "assistant" || message.type === "compaction")
    .map((message) => usageOf(message))
  const amount = priced.reduce((sum, item) => sum + item.amount, 0)
  const unit = prices(model.id, { input: 0, read: 0, write: 0, output: 0 }, 0).unit
  const total = {
    requests: messages.filter((message) => message.type === "assistant").length,
    amount,
    cost: unit === "credits" ? `${amount.toFixed(2)} cr` : `$${amount.toFixed(4)}`,
  }
  const result = { arm, case: name, sessionID, model: ref, compactions, afterWait, total }
  log({ step: "result", compactions: compactions.length, total })
  return result
}

/** The session's lines of own-accounts' ledger (`OWN_HOME/ledger/usage-*.jsonl`): `hit`, `cost`, `compaction`. */
function ledgerLines(home: string, sessionID: string) {
  const dir = path.join(home, "ledger")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((file) => /^usage-.*\.jsonl$/.test(file))
    .flatMap((file) => fs.readFileSync(path.join(dir, file), "utf8").split("\n"))
    .filter((line) => line.includes(sessionID))
    .map((line) => JSON.parse(line) as { ts: number; kind: string; hit?: number; cost?: unknown; compaction?: unknown })
}

/** Every 3 s, a pending permission ask in a case's folder is allowed once (full approval should leave none). */
function answerPermissions(servers: ReadonlyArray<{ readonly team: TeamServer }>, directories: ReadonlySet<string>) {
  const state = { stopped: false }
  const tick = async () => {
    for (const server of servers.map((item) => item.team.server))
      for (const directory of directories) {
        const asked = (await server
          .call("GET", "/api/permission/request", { directory })
          .catch(() => ({ data: [] }))) as { data: Array<{ id: string; sessionID: string; action: string }> }
        for (const request of asked.data) {
          await server
            .call("POST", `/api/session/${request.sessionID}/permission/${request.id}/reply`, {
              body: { decision: "once" },
            })
            .catch(() => undefined)
          console.log(JSON.stringify({ step: "permission", action: request.action, sessionID: request.sessionID }))
        }
      }
  }
  const loop = async () => {
    while (!state.stopped) {
      await tick().catch(() => undefined)
      await Bun.sleep(3_000)
    }
  }
  void loop()
  return { stop: () => void (state.stopped = true) }
}

/** Waits until the session is idle; Bun's fetch gives up after 300 s, so a longer step waits again (run.ts). */
async function idle(server: OpencodeServer, sessionID: string): Promise<void> {
  const timedOut = await server.waitIdle(sessionID).then(
    () => false,
    (error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") return true
      throw error
    },
  )
  if (timedOut) return idle(server, sessionID)
}

/** The session's whole message history, oldest first. */
async function history(server: OpencodeServer, sessionID: string, directory: string) {
  const pages: Array<Record<string, unknown>> = []
  const next = async (cursor: string | undefined): Promise<void> => {
    const page = (await server.call("GET", `/api/session/${sessionID}/message`, {
      query: cursor === undefined ? { limit: "200", order: "asc" } : { limit: "200", cursor },
      directory,
    })) as { data: Array<Record<string, unknown>>; cursor: { next?: string } }
    pages.push(...page.data)
    if (page.data.length > 0 && page.cursor.next !== undefined) await next(page.cursor.next)
  }
  await next(undefined)
  return pages
}
