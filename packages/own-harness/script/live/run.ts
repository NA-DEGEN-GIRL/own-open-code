// Live harness test (own/docs/10 §4.3): a source-booted server with own.harness, real models behind the local
// forwarder (ChatGPT accounts 01 and 03, DeepSeek), and coding tasks run per harness with account and provider
// switches in between. Each step's outcome is checked by running the workspace's tests here, not by the model's word.
//
//   bun script/live/run.ts [--scenario codex,pi,opencode] [--out <dir>]            switches between steps
//   bun script/live/run.ts --steps smoke [--scenario codex]                        one word per model
//   bun script/live/run.ts --suite bugfix --scenario codex:astra01,pi:deepseek    seeded bugs, tests decide
//   bun script/live/run.ts --suite bugfix --scenario dsh:deepseek,dsh:claude      the dsh harness (13)
//   bun script/live/run.ts --suite bugfix --scenario dsh:sol01low --transport websocket   ChatGPT over the Responses WebSocket
//   bun script/live/run.ts --suite search --scenario codex:astra01                 one web search question
//   bun script/live/run.ts --suite delegate --scenario codex:claude               work given to a sub-agent
//   bun script/live/run.ts --suite explore --scenario pi:deepseek                 an explore sub-agent lists and reads
//   bun script/live/run.ts --suite pitools --scenario pi:sol01low,pi:deepseek     Pi 1.5.1's tool changes (12 §3.7): an edit
//                                                    of a mixed CRLF/LF file, a bad argument, a timeout after the shell
//                                                    exited while a background loop kept writing without a 100 ms pause
//                                                    (10 s: Git Bash can take 2–3 s to start on a loaded PC)
//   bun script/live/run.ts --suite catalog --scenario pi:claude                   own tools through `execute`
//   bun script/live/run.ts --suite computer --scenario codex:astra01,opencode:astra01   own.computer-use on its
//                                                    in-memory desktop (`driver: "fake"`, never this PC's screen):
//                                                    screenshots in tool output reach the model, input is audited
//   bun script/live/run.ts --omo --suite bugfix --scenario omo:deepseek [--ulw]     omo (원본) through own-omo (15); `--ulw`
//                                                    puts `ulw ` before the task; `--suite todos`: a todo list left open
//   bun script/live/run.ts --suite compaction-cache --arms main=D:/own-open-code,branch=. --cases haiku-warm
//                                                    compaction requests' cache share and cost per checkout (compaction-cache.ts)
//   ... --prompt own                                                               own's prompt variant (10 §3.9)
//   ... --served <models.json>                                                      own.accounts loaded with that Codex
//                                                    model list as its fetched snapshot, so own.harness runs the
//                                                    GPT models from the served rows (10 §6.14), as for a ChatGPT login
//   bun script/live/run.ts --local --suite bugfix --scenario pi:local,dsh:local   the user's local model server (02 §3.3a,
//                                                    OWN_LIVE_LOCAL_URL, default http://localhost:64644/v1, and
//                                                    OWN_LIVE_LOCAL_MODEL), straight to it: no key, nothing forwarded
//   bun script/live/run.ts --claude-agent --suite bugfix --scenario claude-code:agent,codex:agent [--dry] [--cap 40]
//                                                    upstream's Claude Agent provider (02 §8.10) running the SDK's
//                                                    bundled claude with the forwarder's Anthropic key; `--dry` refuses
//                                                    every model request at the forwarder and keeps its body
//                                                    (OWN_LIVE_BODIES) to check for personal data first; `--cap` stops
//                                                    model requests after that many
//
// Credentials stay in the forwarder process (script/live/credentials.ts); the server's config holds placeholders.
// Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { CodexModels } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  REPO_ROOT,
  opencodeConfig,
  startOpencodeServer,
  type ModelRef,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { PatchInvocation } from "../../src/codex/apply-patch/invocation.js"
import { CHATGPT_ALIASES, hasAnthropic } from "./credentials.js"
import { startForwarder } from "./forwarder.js"
import { TASKS } from "./tasks.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? process.env.OWN_LIVE_OUT ?? path.join(process.env.TEMP ?? "/tmp", "own-live"))
const SCENARIOS = (option("scenario") ?? "codex,pi,opencode").split(",")
/** The base prompt variant every session runs (10 §3.9). */
const PROMPT = option("prompt") === "own" ? "own" : "reference"
/** The ChatGPT providers' transport: HTTP, or the Responses WebSocket that own codex slots use by default. */
const TRANSPORT = option("transport") === "websocket" ? "websocket" : "http"
/**
 * own-omo loaded after own-harness (15 §1), the search plugin left out and web tools denied: the model's requests are
 * the only requests, all to the model under test. Its runtime is the source build (`bun script/bundle.ts` in
 * packages/own-omo) or OWN_OMO_RUNTIME.
 */
const OMO = args.includes("--omo")
/** omo's ultrawork keyword before the task (15 §5). */
const ULW = args.includes("--ulw")
/**
 * Upstream's Claude Agent provider (02 §8.10) on Claude Code's `opus`: the Agent SDK's bundled claude, its config folder
 * under the out dir, the forwarder's Anthropic route as its base URL with a placeholder key. Core P-042 hands claude only
 * its allow-list of the server's environment; the server itself gets no Claude Code or Anthropic variable of this one.
 */
const CLAUDE_AGENT = args.includes("--claude-agent")
/** The forwarder refuses every model request and keeps its body: what a run would send, checked before a real one. */
const DRY = args.includes("--dry")
/** At most this many model requests go out (0: no cap). */
const CAP = Number(option("cap") ?? "0")
/** A Codex model list (`GET /models` body) own.accounts starts with as its fetched snapshot (10 §6.14). */
const SERVED = option("served")
/** The user's local model server (02 §3.3a): a free OpenAI-compatible server on this PC or the local network. */
const LOCAL = args.includes("--local")
const LOCAL_URL = process.env.OWN_LIVE_LOCAL_URL ?? "http://localhost:64644/v1"
const LOCAL_MODEL = process.env.OWN_LIVE_LOCAL_MODEL ?? "local-flash-model-q4-0001"
/** Its effort levels as such a server names them (`reasoning_efforts` of its `/models`), sent as `reasoning_effort`. */
const LOCAL_LEVELS = (process.env.OWN_LIVE_LOCAL_LEVELS ?? "low,high,xhigh,max").split(",")
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
  ...(OMO
    ? [
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "websearch", resource: "*", effect: "deny" },
      ]
    : [{ action: "webfetch", resource: "**", effect: "allow" }]),
]
const GPT_LIMIT = { context: 400_000, input: 272_000, output: 128_000 }
const GPT_MODELS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.2-astra", "gpt-5.5"]

export const MODELS = {
  astra01: { providerID: "chatgpt-01", id: "gpt-6-astra", variant: "high" },
  astra03: { providerID: "chatgpt-03", id: "gpt-6-astra", variant: "high" },
  sol01: { providerID: "chatgpt-01", id: "gpt-6.1-sol", variant: "high" },
  sol03: { providerID: "chatgpt-03", id: "gpt-6.1-sol", variant: "high" },
  // Account 01's default model at its default effort (live model list 2026-10-22: priority 1, `default_reasoning_level` low).
  sol01low: { providerID: "chatgpt-01", id: "gpt-6.1-sol", variant: "low" },
  // GPT-6.2 (Codex catalog since rust-v0.169.1, 10 §6.14) at their default effort.
  sol62low01: { providerID: "chatgpt-01", id: "gpt-6.2-sol", variant: "low" },
  astra62low01: { providerID: "chatgpt-01", id: "gpt-6.2-astra", variant: "low" },
  deepseek: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "high" },
  // Only when set-key.ps1 stored an Anthropic API key.
  claude: { providerID: "anthropic-live", id: "claude-opus-5-5", variant: "high" },
  // Only with --claude-agent: Claude Code's `opus` through the Claude Agent provider, on the same key.
  agent: { providerID: "claude-agent", id: "opus" },
  // Only with --local: the user's local model at its `high` level.
  local: {
    providerID: "local-live",
    id: process.env.OWN_LIVE_LOCAL_MODEL ?? "local-flash-model-q4-0001",
    variant: "high",
  },
} satisfies Record<string, ModelRef>
const ANTHROPIC = hasAnthropic()

type Step =
  | { readonly kind: "prompt"; readonly model: ModelRef; readonly task: keyof typeof TASKS }
  | { readonly kind: "compact"; readonly model: ModelRef }

const SMOKE: ReadonlyArray<Step> = [
  { kind: "prompt", model: MODELS.astra01, task: "ping" },
  { kind: "prompt", model: MODELS.astra03, task: "ping" },
  { kind: "prompt", model: MODELS.sol01, task: "ping" },
  { kind: "prompt", model: MODELS.deepseek, task: "ping" },
  ...(ANTHROPIC ? [{ kind: "prompt" as const, model: MODELS.claude, task: "ping" as const }] : []),
]

const FULL_STEPS: ReadonlyArray<Step> = [
  { kind: "prompt", model: MODELS.astra01, task: "merge" },
  { kind: "prompt", model: MODELS.astra03, task: "subtract" },
  { kind: "compact", model: MODELS.astra03 },
  { kind: "prompt", model: MODELS.deepseek, task: "cli" },
  { kind: "prompt", model: MODELS.sol01, task: "review" },
]

/** The same tasks with Claude in the chain: GPT → Claude → compaction on Claude → DeepSeek → Claude. */
const CLAUDE_STEPS: ReadonlyArray<Step> = [
  { kind: "prompt", model: MODELS.astra01, task: "merge" },
  { kind: "prompt", model: MODELS.claude, task: "subtract" },
  { kind: "compact", model: MODELS.claude },
  { kind: "prompt", model: MODELS.deepseek, task: "cli" },
  { kind: "prompt", model: MODELS.claude, task: "review" },
]

/** Every task on DeepSeek, with a compaction in the middle: the cheap run for comparing prompt variants. */
const DEEPSEEK_ONLY: ReadonlyArray<Step> = [
  { kind: "prompt", model: MODELS.deepseek, task: "merge" },
  { kind: "prompt", model: MODELS.deepseek, task: "subtract" },
  { kind: "compact", model: MODELS.deepseek },
  { kind: "prompt", model: MODELS.deepseek, task: "cli" },
  { kind: "prompt", model: MODELS.deepseek, task: "review" },
]

/** Every task on Claude, with a compaction in the middle: Anthropic's prompt cache over one long session. */
const CLAUDE_ONLY: ReadonlyArray<Step> = [
  { kind: "prompt", model: MODELS.claude, task: "merge" },
  { kind: "prompt", model: MODELS.claude, task: "subtract" },
  { kind: "compact", model: MODELS.claude },
  { kind: "prompt", model: MODELS.claude, task: "cli" },
  { kind: "prompt", model: MODELS.claude, task: "review" },
]

const STEPS =
  option("steps") === "smoke"
    ? SMOKE
    : option("steps") === "claude"
      ? CLAUDE_STEPS
      : option("steps") === "claude-only"
        ? CLAUDE_ONLY
        : option("steps") === "deepseek-only"
          ? DEEPSEEK_ONLY
          : FULL_STEPS
const SUITE = option("suite") ?? "steps"
/** The suites of one prompt per scenario (runSingle). */
const SINGLE = ["bugfix", "search", "delegate", "catalog", "todos", "explore", "pitools", "computer"] as const
const single = (suite: string): suite is (typeof SINGLE)[number] => SINGLE.some((name) => name === suite)
const FIXTURE = path.join(import.meta.dirname, "fixtures", "bugfix")
/**
 * `pitools`' file: CRLF and LF lines and a lone CR inside a line; the edit changes `draft`, and every other byte must
 * stay (Pi 1.5.1, #8544). Not `.txt`: runSingle strips that extension from fixture files.
 */
const PI_NOTES = "title = demo\r\nstatus = draft\r\nowner = me\nnote = a\rb\nend\r\n"

interface StepResult {
  readonly scenario: string
  readonly step: number
  readonly kind: Step["kind"]
  readonly model: string
  readonly task?: string
  readonly seconds: number
  readonly tests?: { readonly pass: number; readonly fail: number; readonly ok: boolean }
  readonly testsTouched?: boolean
  readonly children?: number
  /** The sub-agents' own requests (`delegate`), which the parent's history does not hold. */
  readonly childUsage?: StepResult["usage"]
  readonly renamed?: boolean
  /** omo's todo continuation (`todos`). */
  readonly continuations?: number
  readonly todoWrites?: number
  readonly todosOpen?: number
  readonly usage: {
    readonly requests: number
    readonly input: number
    readonly cached: number
    readonly written: number
    readonly output: number
  }
  readonly tools: Readonly<Record<string, number>>
  readonly toolErrors: number
  /** Results a pi or dsh tool answered as a failure (`metadata.isError`: Pi's and dsh's own failure texts). */
  readonly failedResults: number
  /**
   * File edits as patches own intercepts (heredoc or `apply_patch` calls; a call core refused does not count) and as shell
   * commands that write files.
   */
  readonly edits: { readonly patches: number; readonly shellWrites: number }
  /** The step's first model request: uncached input, cache read and cache write tokens. */
  readonly first: { readonly input: number; readonly cached: number; readonly written: number }
  readonly errors: ReadonlyArray<string>
  readonly reply?: string
}

async function main() {
  // Its own servers: own.accounts' seeded slots per checkout instead of this file's config providers.
  if (SUITE === "compaction-cache") {
    const { compactionCache } = await import("./compaction-cache.js")
    return compactionCache(args)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const sent = { count: 0 }
  const forwarder = startForwarder(
    path.join(OUT, "forwarder.jsonl"),
    {},
    0,
    DRY || CAP > 0 ? { allow: () => !DRY && (CAP === 0 || ++sent.count <= CAP), record: () => {} } : undefined,
  )
  const server = await startOpencodeServer({
    // A cold transpile cache on a busy machine can take minutes.
    startupTimeoutMs: 480_000,
    projectConfig: true,
    keepTemp: true,
    env: {
      OWN_OPEN_CODE: "1",
      OWN_LIVE_SEARCH_URL: `${forwarder.url}/chatgpt/01/responses`,
      ...(CLAUDE_AGENT ? claudeAgentEnv() : {}),
    },
    config: (paths) => {
      if (SERVED !== undefined) servedSnapshot(paths.ownHome)
      return opencodeConfig({
        providers: {
          ...Object.fromEntries(
            CHATGPT_ALIASES.map((alias) => [
              `chatgpt-${alias}`,
              {
                name: `ChatGPT ${alias}`,
                canonical: "openai",
                package: "@opencode/ai/providers/openai",
                // Like own codex slots on the production endpoint: zstd bodies (upstream v2.0.28).
                settings: {
                  baseURL: `${forwarder.url}/chatgpt/${alias}`,
                  apiKey: "forwarded",
                  transport: TRANSPORT,
                  encoding: "zstd",
                },
                headers: { originator: "opencode", "x-codex-beta-features": "remote_compaction_v2" },
                models: Object.fromEntries(GPT_MODELS.map((id) => [id, { name: id, limit: GPT_LIMIT }])),
              },
            ]),
          ),
          deepseek: {
            name: "DeepSeek",
            canonical: "deepseek",
            package: "@opencode/ai/providers/deepseek",
            settings: { baseURL: `${forwarder.url}/deepseek`, apiKey: "forwarded" },
            models: { "deepseek-v4-pro": { name: "deepseek-v4-pro" } },
          },
          ...(ANTHROPIC
            ? {
                "anthropic-live": {
                  name: "Anthropic (API key)",
                  canonical: "anthropic",
                  package: "@opencode/ai/providers/anthropic",
                  settings: { baseURL: `${forwarder.url}/anthropic/v1`, apiKey: "forwarded" },
                  models: { "claude-opus-5-5": { name: "claude-opus-5-5" } },
                },
              }
            : {}),
          ...(LOCAL
            ? {
                "local-live": {
                  name: "Local model",
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: { baseURL: LOCAL_URL },
                  models: {
                    [LOCAL_MODEL]: {
                      name: LOCAL_MODEL,
                      limit: { context: 1_048_576, output: 32_000 },
                      variants: LOCAL_LEVELS.map((level) => ({ id: level, settings: { reasoningEffort: level } })),
                    },
                  },
                },
              }
            : {}),
          ...(CLAUDE_AGENT
            ? {
                "claude-agent": {
                  name: "Claude Agent",
                  settings: {
                    configDir: path.join(OUT, "claude-agent-config"),
                    baseURL: `${forwarder.url}/anthropic`,
                    apiKey: "sk-ant-placeholder-not-a-key",
                  },
                  models: { opus: { name: "Opus" } },
                },
              }
            : {}),
        },
        plugins: [
          ...(SERVED === undefined
            ? []
            : [
                {
                  package: path.join(REPO_ROOT, "packages/own-accounts"),
                  options: { home: paths.ownHome, buildId: `live-served-${process.pid}`, vault: "memory" },
                },
              ]),
          // own.computer-use on its in-memory desktop (`driver: "fake"`): the run never touches this PC's screen.
          ...(SUITE === "computer"
            ? [
                {
                  package: path.join(REPO_ROOT, "packages/own-computer-use"),
                  options: { home: paths.ownHome, buildId: `live-computer-${process.pid}`, driver: "fake" },
                },
              ]
            : []),
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
          ...(OMO
            ? [{ package: path.join(REPO_ROOT, "packages/own-omo"), options: {} }]
            : // core `websearch` through own-accounts' ChatGPT search request (account 01 via the forwarder).
              [{ package: path.join(import.meta.dirname, "search-plugin"), options: {} }]),
        ],
      })
    },
  })
  console.log(`server ${server.url} root ${server.paths.root}`)
  try {
    // Core answers 503 while a Location's plugins are still activating; poll again until they are.
    const wanted = Object.values(MODELS).filter(
      (model) =>
        (ANTHROPIC || model.providerID !== "anthropic-live") &&
        (CLAUDE_AGENT || model.providerID !== "claude-agent") &&
        (LOCAL || model.providerID !== "local-live"),
    )
    for (
      let attempt = 1;
      !(await server.waitForModels(wanted, 60_000).then(
        () => true,
        () => false,
      ));
      attempt++
    )
      if (attempt === 10) throw new Error("models never listed")
    fs.writeFileSync(path.join(OUT, "models.json"), JSON.stringify(await server.models(), null, 2))
    const results = (
      await Promise.all(
        SCENARIOS.map((scenario) =>
          single(SUITE) ? runSingle(server, scenario, SUITE) : runScenario(server, scenario),
        ),
      )
    ).flat()
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2))
    console.table(
      results.map((result) => ({
        scenario: result.scenario,
        step: result.step,
        model: result.model,
        task: result.task ?? result.kind,
        s: result.seconds,
        tests: result.tests
          ? `${result.tests.pass}/${result.tests.pass + result.tests.fail}${result.testsTouched ? " (tests changed!)" : ""}`
          : "",
        agents: result.children ?? "",
        renamed: result.renamed ?? "",
        tools: Object.entries(result.tools)
          .map(([name, count]) => `${name}×${count}`)
          .join(" "),
        requests: result.usage.requests,
        "in/cached/written/out": `${result.usage.input}/${result.usage.cached}/${result.usage.written}/${result.usage.output}`,
        "first in/cached/written": `${result.first.input}/${result.first.cached}/${result.first.written}`,
        "edits p/w": `${result.edits.patches}/${result.edits.shellWrites}`,
        errors: result.errors.length + result.toolErrors,
        failed: result.failedResults,
      })),
    )
  } finally {
    fs.writeFileSync(path.join(OUT, "server.log"), server.logs())
    await server.stop()
    await forwarder.stop()
  }
}

/**
 * The server's environment for the Claude Agent provider: the SDK's bundled claude (never one on PATH, which may be
 * logged in), and every Claude Code or Anthropic variable of this process dropped (a Claude Code session hands its
 * children the user's e-mail and account ids, and Claude Code puts the e-mail into the prompt).
 */
function claudeAgentEnv(): Record<string, string | undefined> {
  const core = path.join(REPO_ROOT, "packages/core")
  const sdk = path.dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", core))
  const binary = path.join(
    path.dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk-win32-x64/package.json", sdk)),
    "claude.exe",
  )
  if (!fs.existsSync(binary)) throw new Error(`no bundled claude at ${binary}`)
  fs.mkdirSync(path.join(OUT, "claude-agent-config"), { recursive: true })
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((name) => /^(CLAUDE|ANTHROPIC)/i.test(name))
        .map((name) => [name, undefined]),
    ),
    OPENCODE_CLAUDE_PATH: binary,
  }
}

async function runScenario(server: OpencodeServer, harness: string): Promise<StepResult[]> {
  const directory = path.join(server.paths.root, `ws-${harness}`)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: `live-${harness}`, type: "module" }, null, 2),
  )
  fs.writeFileSync(path.join(directory, "AGENTS.md"), "Use Bun. Keep the code small and typed.\n")
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `live ${harness}`,
      model: STEPS[0]!.model,
      location: { directory },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: { id: harness, v: 1, ...(PROMPT === "own" ? { prompt: PROMPT } : {}) } },
    },
    directory,
  })) as { data: { id: string } }
  const sessionID = created.data.id
  const results: StepResult[] = []
  for (const [index, step] of STEPS.entries()) {
    const started = Date.now()
    await server.switchModel(sessionID, step.model).catch((error: unknown) => console.error(harness, "switch", error))
    if (step.kind === "prompt") await server.prompt(sessionID, TASKS[step.task])
    if (step.kind === "compact") await server.call("POST", `/api/session/${sessionID}/compact`, { body: {}, directory })
    await idle(server, sessionID)
    const messages = (await history(server, sessionID, directory)).filter(
      (message) => ((message.time as { created?: number } | undefined)?.created ?? 0) >= started - 1_000,
    )
    fs.writeFileSync(path.join(OUT, `${harness}-${index}.json`), JSON.stringify(messages, null, 2))
    const result = {
      scenario: PROMPT === "own" ? `${harness}+own` : harness,
      step: index,
      kind: step.kind,
      model: `${step.model.providerID}/${step.model.id}`,
      ...(step.kind === "prompt" ? { task: step.task } : {}),
      seconds: Math.round((Date.now() - started) / 1000),
      ...(step.kind === "prompt" && step.task !== "ping" ? { tests: runTests(directory) } : {}),
      ...summarize(messages),
    }
    console.log(JSON.stringify(result))
    results.push(result)
  }
  return results
}

/**
 * One prompt per `harness:model`. `bugfix`: a seeded repository with failing tests; success is passing tests with
 * `test/` unchanged. `search`: an empty folder; the reply should name a version and a URL.
 */
async function runSingle(
  server: OpencodeServer,
  scenario: string,
  task: (typeof SINGLE)[number],
): Promise<StepResult[]> {
  const [harness = "codex", key = "astra01"] = scenario.split(":")
  const model = MODELS[key as keyof typeof MODELS]
  if (model === undefined) throw new Error(`unknown model key ${key}`)
  const directory = path.join(server.paths.root, `${task}-${harness}-${key}`)
  fs.mkdirSync(path.join(directory, "test"), { recursive: true })
  if (task === "bugfix" || task === "explore") fs.cpSync(FIXTURE, directory, { recursive: true })
  if (task === "search") fs.writeFileSync(path.join(directory, "test", "lib.test.ts"), "")
  if (task === "pitools") fs.writeFileSync(path.join(directory, "notes.cfg"), PI_NOTES)
  for (const file of fs
    .readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".txt")))
    fs.renameSync(path.join(directory, file), path.join(directory, file.slice(0, -".txt".length)))
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "bugfix", type: "module" }, null, 2))
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  Bun.spawnSync(["git", "add", "-A"], { cwd: directory })
  Bun.spawnSync(["git", "-c", "user.name=live", "-c", "user.email=live@example.test", "commit", "-qm", "seed"], {
    cwd: directory,
  })
  const testFile = path.join(directory, "test", "lib.test.ts")
  const before = task === "bugfix" ? fs.readFileSync(testFile, "utf8") : ""
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `${task} ${scenario}`,
      model,
      location: { directory },
      // The computer suite's conversation has computer use on (own-accounts' `session.approval.set{computerUse}` rule).
      permissions: task === "computer" ? [...FULL, { action: "computer", resource: "*", effect: "allow" }] : FULL,
      metadata: { [OwnHarness.META_KEY]: { id: harness, v: 1, ...(PROMPT === "own" ? { prompt: PROMPT } : {}) } },
    },
    directory,
  })) as { data: { id: string } }
  const sessionID = created.data.id
  const started = Date.now()
  await server.prompt(sessionID, `${ULW ? "ulw " : ""}${TASKS[task]}`)
  await settle(server, sessionID, directory)
  const messages = await history(server, sessionID, directory)
  fs.writeFileSync(path.join(OUT, `${task}-${harness}-${key}.json`), JSON.stringify(messages, null, 2))
  const result = {
    scenario: PROMPT === "own" ? `${harness}+own` : harness,
    step: 0,
    kind: "prompt" as const,
    model: `${model.providerID}/${model.id}`,
    task,
    seconds: Math.round((Date.now() - started) / 1000),
    ...(task === "bugfix"
      ? { tests: runTests(directory), testsTouched: fs.readFileSync(testFile, "utf8") !== before }
      : task === "delegate"
        ? { tests: runTests(directory), ...(await children(server, sessionID, directory)) }
        : task === "todos"
          ? { tests: runTests(directory), ...todos(messages) }
          : task === "explore"
            ? await explored(server, sessionID, directory)
            : task === "catalog"
              ? { renamed: (await title(server, sessionID, directory)) === "catalog check" }
              : task === "pitools"
                ? { piTools: piTools(messages, directory) }
                : task === "computer"
                  ? { computer: computerAudit(server.paths.ownHome, sessionID) }
                  : {}),
    ...summarize(messages),
  }
  console.log(JSON.stringify(result))
  return [result]
}

/**
 * The computer suite's outcome as the plugin's own audit log has it (`<OWN_HOME>/audit/computer-YYYY-MM.jsonl`, one
 * line per call: tool, outcome, code, target app; typed text only as its length), not the model's word.
 */
function computerAudit(ownHome: string, sessionID: string) {
  const dir = path.join(ownHome, "audit")
  const lines = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.startsWith("computer-"))
        .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n"))
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.sessionID === sessionID)
    : []
  const calls = lines.map((entry) => ({
    tool: entry.tool,
    outcome: entry.outcome,
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...(entry.target === undefined ? {} : { app: (entry.target as { app?: unknown }).app }),
    ...(entry.tool === "type" ? { args: entry.args } : {}),
  }))
  const order = ["screenshot", "list_windows", "left_click", "type", "key"]
  const done = order.every((tool) => calls.some((call) => call.tool === tool && call.outcome === "ok"))
  return { ok: done, calls }
}

/**
 * Waits until the session and its sub-agents are done. A background sub-agent (core's `subagent` with
 * `background: true`) reports to its parent when it finishes, which wakes the parent again after it went idle, so wait
 * until the parent's history stops growing with every child idle.
 */
async function settle(server: OpencodeServer, sessionID: string, directory: string) {
  let seen = -1
  for (let round = 0; round < 20; round++) {
    await idle(server, sessionID)
    for (const child of await childIDs(server, sessionID, directory)) await idle(server, child)
    await Bun.sleep(5_000)
    await idle(server, sessionID)
    const count = (await history(server, sessionID, directory)).length
    if (count === seen) return
    seen = count
  }
}

/**
 * Waits until the session is idle. The server holds the `wait` request open, and Bun's fetch gives up after 300 s, so
 * a longer step (DeepSeek's review step on 2026-10-16) waits again instead of ending the run.
 */
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

async function title(server: OpencodeServer, sessionID: string, directory: string) {
  const info = (await server.call("GET", `/api/session/${sessionID}`, { directory })) as { data: { title?: string } }
  return info.data.title
}

/**
 * The explore check (decisions SA): which agents the sub-agents ran, and every tool call they made with its status and
 * the start of its output, so a refused listing shows.
 */
async function explored(server: OpencodeServer, sessionID: string, directory: string) {
  const ids = await childIDs(server, sessionID, directory)
  const agents = await Promise.all(
    ids.map(async (id) => {
      const info = (await server.call("GET", `/api/session/${id}`, { directory })) as { data: { agent?: string } }
      return info.data.agent
    }),
  )
  const calls = (await Promise.all(ids.map((id) => history(server, id, directory))))
    .flat()
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []))
    .filter((part) => part.type === "tool")
    .map((part) => {
      const state = part.state as { status?: string; input?: unknown; output?: unknown; error?: unknown }
      return {
        name: part.name,
        status: state.status,
        input: JSON.stringify(state.input).slice(0, 120),
        output: JSON.stringify(state.output ?? state.error ?? "").slice(0, 160),
      }
    })
  return { children: ids.length, agents, calls }
}

/**
 * The `pitools` check (12 §3.7): the edited file's bytes against the one expected change, the text the bad-argument
 * read answered, and the end of the timed-out command's result.
 */
function piTools(messages: ReadonlyArray<Record<string, unknown>>, directory: string) {
  const calls = messages
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []))
    .filter((part) => part.type === "tool")
    .map((part) => {
      const state = part.state as { input?: unknown; content?: unknown; metadata?: { isError?: unknown } }
      const text = (Array.isArray(state.content) ? (state.content as Array<{ text?: unknown }>) : [])
        .flatMap((item) => (typeof item.text === "string" ? [item.text] : []))
        .join("\n")
      return { name: String(part.name), input: state.input, text, failed: state.metadata?.isError === true }
    })
  const written = fs.readFileSync(path.join(directory, "notes.cfg"), "utf8")
  return {
    crlfKept: written === PI_NOTES.replace("status = draft", "status = final"),
    written: JSON.stringify(written),
    badArgument: calls.find((call) => call.name === "read" && call.failed)?.text.slice(0, 400),
    timeout: calls
      .filter((call) => call.name === "bash")
      .map((call) => call.text.slice(-260))
      .find((text) => text.includes("timed out")),
    calls: calls.map(
      (call) => `${call.name}${call.failed ? " (failed)" : ""} ${JSON.stringify(call.input).slice(0, 160)}`,
    ),
  }
}

/** How many sub-agents `sessionID` started and what their requests used. */
async function children(server: OpencodeServer, sessionID: string, directory: string) {
  const ids = await childIDs(server, sessionID, directory)
  const messages = (await Promise.all(ids.map((id) => history(server, id, directory)))).flat()
  return { children: ids.length, childUsage: summarize(messages).usage }
}

/**
 * omo's todo continuation (15 §3.6): the synthetic messages own-omo admitted for omo (`source: own.omo`) and the todos
 * the last `todowrite` left open.
 */
function todos(messages: ReadonlyArray<Record<string, unknown>>) {
  const writes = messages
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []))
    .filter((part) => part.type === "tool" && part.name === "todowrite")
  const last =
    (writes.at(-1)?.state as { input?: { todos?: Array<{ status?: string }> } } | undefined)?.input?.todos ?? []
  return {
    continuations: messages.filter(
      (message) =>
        message.type === "synthetic" && (message.metadata as { source?: unknown } | undefined)?.source === "own.omo",
    ).length,
    todoWrites: writes.length,
    todosOpen: last.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length,
  }
}

/** Sessions created under `sessionID` (sub-agents), from the server's session list. */
async function childIDs(server: OpencodeServer, sessionID: string, directory: string) {
  const listed = (await server.call("GET", "/api/session", {
    query: { parentID: sessionID, limit: "50" },
    directory,
  })) as {
    data: Array<{ id: string }>
  }
  return listed.data.map((session) => session.id)
}

/** The session's whole message history, oldest first. */
async function history(server: OpencodeServer, sessionID: string, directory: string) {
  const pages: Array<Record<string, unknown>> = []
  let cursor: string | undefined
  do {
    const page = (await server.call("GET", `/api/session/${sessionID}/message`, {
      query: cursor === undefined ? { limit: "200", order: "asc" } : { limit: "200", cursor },
      directory,
    })) as { data: Array<Record<string, unknown>>; cursor: { next?: string } }
    pages.push(...page.data)
    cursor = page.data.length === 0 ? undefined : page.cursor.next
  } while (cursor !== undefined)
  return pages
}

function runTests(directory: string) {
  const run = Bun.spawnSync(["bun", "test"], { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 120_000 })
  const text = run.stdout.toString() + run.stderr.toString()
  const pass = Number(/(\d+) pass/.exec(text)?.[1] ?? 0)
  const fail = Number(/(\d+) fail/.exec(text)?.[1] ?? 0)
  return { pass, fail, ok: run.exitCode === 0 && pass > 0 }
}

/** Shell commands that write a file's whole text instead of patching it (seen on 2026-10-14, 10 §8 Q4). */
const SHELL_WRITE = /\b(Set-Content|Add-Content|Out-File|WriteAllText|WriteAllLines)\b|\bcat\s*>/

/** Tool calls by name, failed tool calls, edits, error messages and the last reply of the step's messages. */
function summarize(messages: ReadonlyArray<Record<string, unknown>>) {
  const parts = messages.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
  )
  const tools = parts.filter((part) => part.type === "tool")
  const state = (part: Record<string, unknown>) => (part.state ?? {}) as Record<string, unknown>
  const errors = messages.flatMap((message) => {
    const error = message.error ?? (message.type === "error" ? message : undefined)
    return error === undefined ? [] : [JSON.stringify(error).slice(0, 300)]
  })
  const texts = parts.filter((part) => part.type === "text" && typeof part.text === "string")
  const commands = tools
    .filter((part) => part.name === "exec_command")
    .map((part) => String((state(part).input as { cmd?: unknown } | undefined)?.cmd ?? ""))
  const head = messages.find((message) => message.type === "assistant")?.tokens as
    | { input?: number; cache?: { read?: number; write?: number } }
    | undefined
  const tokens = messages.reduce<{ requests: number; input: number; cached: number; written: number; output: number }>(
    (sum, message) => {
      const used = message.tokens as
        | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
        | undefined
      return {
        requests: sum.requests + (message.type === "assistant" ? 1 : 0),
        input: sum.input + (used?.input ?? 0),
        cached: sum.cached + (used?.cache?.read ?? 0),
        written: sum.written + (used?.cache?.write ?? 0),
        output: sum.output + (used?.output ?? 0) + (used?.reasoning ?? 0),
      }
    },
    { requests: 0, input: 0, cached: 0, written: 0, output: 0 },
  )
  return {
    usage: tokens,
    tools: tools.reduce<Record<string, number>>(
      (counts, part) => ({ ...counts, [String(part.name)]: (counts[String(part.name)] ?? 0) + 1 }),
      {},
    ),
    toolErrors: tools.filter((part) => state(part).status === "error").length,
    failedResults: tools.filter((part) => (state(part).metadata as { isError?: unknown } | undefined)?.isError === true)
      .length,
    edits: {
      patches:
        commands.filter((cmd) => PatchInvocation.extractHeredocPatch(cmd) !== undefined).length +
        tools.filter((part) => part.name === "apply_patch" && state(part).status !== "error").length,
      shellWrites: commands.filter((cmd) => SHELL_WRITE.test(cmd)).length,
    },
    first: { input: head?.input ?? 0, cached: head?.cache?.read ?? 0, written: head?.cache?.write ?? 0 },
    errors,
    reply: String(texts.at(-1)?.text ?? "").slice(0, 600),
  }
}

await main()

/**
 * `--served`: `OWN_HOME\codex-meta.json` with the list as a fetched `backend` snapshot (CodexModels.decode's rows,
 * harness rows and left-out reasons), so own.accounts answers own.harness's `codexModels.rows` with its served rows.
 */
function servedSnapshot(home: string) {
  const decoded = CodexModels.decode(JSON.parse(fs.readFileSync(SERVED!, "utf8")))
  if (decoded === undefined) throw new Error(`--served ${SERVED}: no model list`)
  const snapshot = {
    source: "backend" as const,
    fetchedAt: Date.now(),
    rows: CodexModels.ROWS,
    rejected: decoded.rejected,
    left: decoded.left,
    harness: decoded.harness,
    models: decoded.models,
  }
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, "codex-meta.json"), JSON.stringify({ version: 1, kinds: { codex: snapshot } }))
  console.log(`served: ${decoded.harness.length} harness rows, ${decoded.rejected} left out`)
}
