// Live check of side questions (곁질문, 02 §9.7, report own/reports/side-question-2026-11-22.md §3): does a side question
// read the conversation's prompt cache on each route the user has, under each harness, idle and during a running turn,
// and does it stay out of the conversation? Source-booted servers with own.accounts (seeded ChatGPT 01/02, Anthropic and
// DeepSeek slots pointing at the live forwarder) and own.harness, plus config providers for the OpenAI API key
// (`openai-live`) and the Claude Agent route (`claude-agent`, the SDK's bundled claude on the forwarder's Anthropic key).
// Each case: a conversation with two coding prompts, a side question when idle, a follow-up in its thread, then a third
// prompt and a side question while that turn runs. Usage comes from core (the side turn's tokens) and the session's
// steps; the request bodies (`OWN_LIVE_BODIES`, HTTP only) show how far the side request repeats the last primary one.
//
//   bun script/live/side-cache.ts [--arms auto,none] [--cases chatgpt01-codex,...] [--out <dir>] [--omo]
//
// Arms: `auto` (own's default, the tools offered as in the conversation; ChatGPT slots on their WebSocket) and `none`
// (`OWN_SIDE_TOOL_CHOICE=none`; ChatGPT over HTTP, so its bodies can be compared). At most --cap model requests per route
// family (default 80). Credentials stay in the forwarder process; every spawned process gets an environment without
// Claude Code's or Anthropic's variables. Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { REPO_ROOT, type OpencodeServer } from "../../../own-accounts/test/e2e-kit"
import { CHATGPT, SLOT, startTeamFakes, startTeamServer, type TeamServer } from "../../../own-team/test/e2e/harness.ts"
import { hasAnthropic, hasOpenai } from "./credentials.js"
import { TASKS } from "./tasks.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-side"))
const BODIES = path.join(OUT, "bodies")
fs.mkdirSync(BODIES, { recursive: true })
process.env.OWN_LIVE_BODIES = BODIES
const { startForwarder } = await import("./forwarder.js")

const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
] as const

const ROUTES = {
  chatgpt01: { providerID: SLOT["01"], id: "gpt-6.1-sol", variant: "low", family: "chatgpt" },
  anthropic: { providerID: SLOT.anthropic, id: "claude-haiku-4-5", family: "anthropic" },
  deepseek: { providerID: SLOT.deepseek, id: "deepseek-v4-pro", variant: "low", family: "deepseek" },
  openai: { providerID: "openai-live", id: "gpt-5.5", family: "openai" },
  agent: { providerID: "claude-agent", id: "haiku", family: "anthropic" },
} as const
type Route = keyof typeof ROUTES

const CASES = {
  "chatgpt01-codex": { route: "chatgpt01", harness: "codex" },
  // ChatGPT 02 is approved but the live kit's credentials know only 01's profile; both are the same route.
  "chatgpt01-pi": { route: "chatgpt01", harness: "pi" },
  "anthropic-opencode": { route: "anthropic", harness: "opencode" },
  "anthropic-claudecode": { route: "anthropic", harness: "claude-code" },
  "deepseek-dsh": { route: "deepseek", harness: "dsh" },
  "deepseek-omo": { route: "deepseek", harness: "omo" },
  "openai-codex": { route: "openai", harness: "codex" },
  "agent-claudecode": { route: "agent", harness: "claude-code" },
} as const satisfies Record<string, { route: Route; harness: string }>
type CaseName = keyof typeof CASES

const QUESTIONS = {
  idle: "In one sentence: which files did you create or change so far, and why?",
  follow: "And which of them would you test first? One short sentence.",
  running: "Quick side question: what is the very first thing you did in this conversation? One sentence.",
}

const arms = (option("arms") ?? "auto,none").split(",") as Array<"auto" | "none">
const OMO = args.includes("--omo")
const cases = (option("cases") ?? Object.keys(CASES).join(","))
  .split(",")
  .map((name) => {
    if (!(name in CASES)) throw new Error(`unknown case ${name}`)
    return name as CaseName
  })
  .filter((name) => CASES[name].harness !== "omo" || OMO)
  .filter((name) => CASES[name].route !== "openai" || hasOpenai())
  .filter((name) => !["anthropic", "agent"].includes(CASES[name].route) || hasAnthropic())
const CAP = Number(option("cap") ?? 80)

const sent = new Map<string, number>()
const family = (route: string) => (route.startsWith("chatgpt") ? "chatgpt" : route)
const forwarder = startForwarder(path.join(OUT, "forwarder.jsonl"), { [CHATGPT["01"].accountID]: "01" }, 0, {
  allow: (route) => {
    const count = (sent.get(family(route)) ?? 0) + 1
    sent.set(family(route), count)
    return count <= CAP
  },
  record: (entry) => fs.appendFileSync(path.join(OUT, "usage.jsonl"), JSON.stringify(entry) + "\n"),
})
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))
log({ step: "start", out: OUT, arms, cases })

const servers: Array<{ readonly arm: "auto" | "none"; readonly team: TeamServer; readonly stopFakes: () => Promise<void> }> =
  []
const directories = new Set<string>()
try {
  for (const arm of arms) servers.push(await boot(arm))
  const replies = answerPermissions()
  const results = await Promise.all(
    servers.flatMap((server) =>
      cases.map((name) =>
        runCase(server.arm, server.team, name).catch((error: unknown) => ({ arm: server.arm, case: name, error: String(error) })),
      ),
    ),
  )
  replies.stop()
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, sent: Object.fromEntries(sent) }, null, 2))
  console.table(
    results.flatMap((result) =>
      "error" in result
        ? [{ arm: result.arm, case: result.case, what: `error: ${result.error.slice(0, 140)}` }]
        : result.rows.map((row) => ({ arm: result.arm, case: result.case, ...row })),
    ),
  )
  log({ step: "end", sent: Object.fromEntries(sent) })
} finally {
  for (const server of servers) {
    fs.writeFileSync(path.join(OUT, `server-${server.arm}.log`), server.team.server.logs())
    await server.team.stop()
    await server.stopFakes()
  }
  await forwarder.stop()
}

async function boot(arm: "auto" | "none") {
  const fakes = startTeamFakes()
  const team = await startTeamServer({
    name: `side-${arm}`,
    project: "none",
    team: false,
    // own-accounts enables the Claude Agent provider only on an account's folder: the harness seeds one (a login file
    // the real claude cannot use, so it signs with the provider's key, which the forwarder replaces).
    claudeAgent: true,
    fakes,
    codexTransport: arm === "auto" ? "websocket" : "http",
    keepTemp: true,
    env: { ...cleanEnv(), OWN_SIDE_TOOL_CHOICE: arm },
    accountsOptions: {
      endpoints: {
        codex: `${forwarder.url}/chatgpt-team`,
        anthropic: `${forwarder.url}/anthropic/v1`,
        deepseek: `${forwarder.url}/deepseek/v1`,
        oauthIssuer: fakes.codex.url,
        chatgpt: `${fakes.codex.url}/backend-api`,
        openai: `${fakes.codex.url}/v1`,
        xai: `${fakes.codex.url}/v1`,
        openrouter: `${fakes.codex.url}/v1`,
        deepgram: fakes.codex.url,
      },
      ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
    },
    config: {
      providers: {
        "openai-live": {
          name: "OpenAI (API key)",
          canonical: "openai",
          package: "@opencode/ai/providers/openai",
          settings: { baseURL: `${forwarder.url}/openai/v1`, apiKey: "forwarded" },
          models: { "gpt-5.5": { name: "gpt-5.5" } },
        },
        "claude-agent": {
          name: "Claude Agent",
          settings: {
            baseURL: `${forwarder.url}/anthropic`,
            apiKey: "sk-ant-placeholder-not-a-key",
          },
          models: { haiku: { name: "Haiku" } },
        },
      },
    },
    plugins: [
      { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
      ...(OMO ? [{ package: path.join(REPO_ROOT, "packages/own-omo"), options: {} }] : []),
    ],
  })
  const wanted = [...new Set(cases.map((name) => CASES[name].route))].map((route) => ({
    providerID: ROUTES[route].providerID,
    id: ROUTES[route].id,
  }))
  await team.server.waitForModels(wanted, 240_000)
  log({ step: "booted", arm, root: team.root, url: team.server.url })
  return { arm, team, stopFakes: () => fakes.stop() }
}

/** This process's environment without Claude Code's or Anthropic's variables, and the SDK's bundled claude. */
function cleanEnv(): Record<string, string | undefined> {
  const core = path.join(REPO_ROOT, "packages/core")
  const sdk = path.dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", core))
  const binary = path.join(
    path.dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk-win32-x64/package.json", sdk)),
    "claude.exe",
  )
  if (!fs.existsSync(binary)) throw new Error(`no bundled claude at ${binary}`)
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((name) => /^(CLAUDE|ANTHROPIC)/i.test(name))
        .map((name) => [name, undefined]),
    ),
    OPENCODE_CLAUDE_PATH: binary,
  }
}

type Tokens = { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number }

async function runCase(arm: "auto" | "none", team: TeamServer, name: CaseName) {
  const spec = CASES[name]
  const route = ROUTES[spec.route]
  const server = team.server
  const directory = path.join(team.root, "ws", name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: `side-${name}`, type: "module" }, null, 2))
  fs.writeFileSync(path.join(directory, "AGENTS.md"), "Use Bun. Keep the code small and typed.\n")
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  directories.add(directory)
  const model = { providerID: route.providerID, id: route.id, ...("variant" in route ? { variant: route.variant } : {}) }
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `side ${arm} ${name}`,
      model,
      location: { directory },
      permissions: FULL,
      metadata: { [OwnHarness.META_KEY]: { id: spec.harness, v: 1 } },
    },
    directory,
  })) as { data: { id: string } }
  const sessionID = created.data.id
  await team.accounts("session.approval.set", { sessionID, mode: "full" }, directory)
  const say = (entry: Record<string, unknown>) => log({ arm, case: name, ...entry })
  say({ step: "session", sessionID, model })

  await server.prompt(sessionID, TASKS.merge)
  await idle(server, sessionID)
  await server.prompt(sessionID, TASKS.subtract)
  await idle(server, sessionID)
  const steps = async () => primarySteps(await history(server, sessionID, directory))
  const beforeIdle = (await steps()).at(-1)
  const idleSide = await side(team, sessionID, directory, QUESTIONS.idle)
  const follow = await side(team, sessionID, directory, QUESTIONS.follow, idleSide.threadID)
  say({ step: "idle side", idle: idleSide.turn.status, follow: follow.turn.status })

  // A side question while a turn runs: asked once the turn's first step has ended, answered before the turn ends.
  const count = (await steps()).length
  const turnStarted = Date.now()
  await server.prompt(sessionID, TASKS.cli)
  const deadline = Date.now() + 240_000
  while ((await steps()).length <= count && Date.now() < deadline) await Bun.sleep(1_000)
  const busy = await sessionBusy(server, sessionID, directory)
  const lastBeforeRunning = (await steps()).at(-1)
  const sideAsked = Date.now()
  const runningSide = await side(team, sessionID, directory, QUESTIONS.running)
  const sideEnded = Date.now()
  const stillBusy = await sessionBusy(server, sessionID, directory)
  await idle(server, sessionID)
  const turnEnded = Date.now()
  // The side answer overlapped the turn when it ended before the turn went idle.
  const overlap = sideEnded < turnEnded
  const timing = { askedAfter: (sideAsked - turnStarted) / 1000, answered: (sideEnded - sideAsked) / 1000, turnEndedAfter: (turnEnded - turnStarted) / 1000 }
  say({ step: "running side", overlap, timing, busyWhenAsked: busy, busyWhenAnswered: stillBusy, status: runningSide.turn.status })

  const messages = await history(server, sessionID, directory)
  fs.writeFileSync(path.join(OUT, `history-${arm}-${name}.json`), JSON.stringify(messages, null, 2))
  const text = JSON.stringify(messages)
  const leaked = [...Object.values(QUESTIONS), "<side-question>", idleSide.turn.answer.slice(0, 60)].filter(
    (needle) => needle.trim() !== "" && text.includes(needle),
  )
  const prefix = comparePrefix(sessionID, directory)
  const row = (what: string, tokens: Tokens | undefined, extra: Record<string, unknown> = {}) => ({
    what,
    "in/read/write/out": tokens ? `${tokens.input}/${tokens.cacheRead}/${tokens.cacheWrite}/${tokens.output}` : "",
    share: tokens ? share(tokens) : null,
    ...extra,
  })
  return {
    arm,
    case: name,
    sessionID,
    leaked,
    prefix,
    rows: [
      row("last step before idle side", beforeIdle),
      row("side (idle)", idleSide.turn.tokens, { status: idleSide.turn.status, finish: idleSide.turn.finish }),
      row("side follow-up", follow.turn.tokens, { status: follow.turn.status, finish: follow.turn.finish }),
      row("last step before running side", lastBeforeRunning),
      row("side (turn running)", runningSide.turn.tokens, {
        status: runningSide.turn.status,
        finish: runningSide.turn.finish,
        overlap,
        timing: `asked +${timing.askedAfter}s, ${timing.answered}s, turn ${timing.turnEndedAfter}s`,
      }),
      { what: "history", leaked: leaked.length === 0 ? "none" : leaked.join(" | "), prefix: JSON.stringify(prefix) },
    ],
  }
}

async function side(team: TeamServer, sessionID: string, directory: string, question: string, threadID?: string) {
  const asked = (await team.accounts(
    "side.ask",
    { sessionID, question, ...(threadID ? { threadID } : {}) },
    directory,
  )) as unknown as { thread: { id: string } }
  const id = asked.thread.id
  const deadline = Date.now() + 300_000
  for (;;) {
    const got = (await team.accounts("side.get", { sessionID, threadID: id }, directory)) as unknown as {
      thread: { turns: Array<{ status: string; answer: string; finish?: string; tokens?: Tokens; error?: string }> }
    }
    const turn = got.thread.turns.at(-1)!
    if (turn.status !== "running" || Date.now() > deadline) return { threadID: id, turn }
    await Bun.sleep(500)
  }
}

async function sessionBusy(server: OpencodeServer, sessionID: string, directory: string) {
  const status = (await server.call("GET", `/api/session/${sessionID}`, { directory }).catch(() => undefined)) as
    | { data?: { status?: string } }
    | undefined
  const messages = await history(server, sessionID, directory)
  const open = messages.some(
    (message) => message.type === "assistant" && (message.time as { completed?: number } | undefined)?.completed === undefined,
  )
  return open || status?.data?.status === "running"
}

function primarySteps(messages: ReadonlyArray<Record<string, unknown>>): Tokens[] {
  return messages
    .filter((message) => message.type === "assistant" && (message.time as { completed?: number })?.completed !== undefined)
    .map((message) => {
      const tokens = message.tokens as
        | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
        | undefined
      return {
        input: tokens?.input ?? 0,
        cacheRead: tokens?.cache?.read ?? 0,
        cacheWrite: tokens?.cache?.write ?? 0,
        output: (tokens?.output ?? 0) + (tokens?.reasoning ?? 0),
      }
    })
}

function share(tokens: Tokens) {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return prompt === 0 ? null : Math.round((tokens.cacheRead / prompt) * 1000) / 10
}

/**
 * The side requests' bodies against the primary request sent just before each (HTTP routes; a WebSocket frame carries
 * only what is new): same system/instructions, same tools, same tool choice, and how many leading messages agree.
 */
function comparePrefix(sessionID: string, directory: string) {
  const needle = JSON.stringify(directory).slice(1, -1)
  const bodies = fs
    .readdirSync(BODIES)
    .filter((file) => !file.includes("websocket") && !file.includes("refused"))
    .toSorted()
    .map((file) => ({ file, text: fs.readFileSync(path.join(BODIES, file), "utf8") }))
    .filter((body) => body.text.includes(needle) || body.text.includes(sessionID))
  return bodies.flatMap((body, index): Array<Record<string, unknown>> => {
    if (!body.text.includes("<side-question>")) return []
    const before = bodies
      .slice(0, index)
      .reverse()
      .find((item) => !item.text.includes("<side-question>"))
    if (!before) return [{ side: body.file, primary: null }]
    const a = JSON.parse(before.text) as Record<string, unknown>
    const b = JSON.parse(body.text) as Record<string, unknown>
    const items = (value: Record<string, unknown>) =>
      (value.input ?? value.messages ?? []) as ReadonlyArray<unknown>
    const left = items(a)
    const right = items(b)
    const same = left.findIndex((item, at) => JSON.stringify(item) !== JSON.stringify(right[at]))
    return [
      {
        side: body.file,
        primary: before.file,
        system: JSON.stringify(a.instructions ?? a.system) === JSON.stringify(b.instructions ?? b.system),
        tools: JSON.stringify(a.tools) === JSON.stringify(b.tools),
        toolChoice: [a.tool_choice ?? null, b.tool_choice ?? null],
        cacheKey: a.prompt_cache_key === b.prompt_cache_key,
        items: `${same === -1 ? left.length : same}/${left.length} (side ${right.length})`,
      },
    ]
  })
}

function answerPermissions() {
  const state = { stopped: false }
  const tick = async () => {
    for (const server of servers.map((item) => item.team.server))
      for (const directory of directories) {
        const asked = (await server
          .call("GET", "/api/permission/request", { directory })
          .catch(() => ({ data: [] }))) as { data: Array<{ id: string; sessionID: string }> }
        for (const request of asked.data)
          await server
            .call("POST", `/api/session/${request.sessionID}/permission/${request.id}/reply`, { body: { decision: "once" } })
            .catch(() => undefined)
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
