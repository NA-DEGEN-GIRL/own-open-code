// STUDY ONLY (branch claude-agent-study, 2026-10-31): not product code and in no test tier. Kept as the evidence of
// own/reports/claude-agent-provider-2026-10-31.md; run from the repository root as the usage line says.
// own study, live load check (own/reports/claude-agent-provider-2026-10-31.md §9.3): N conversations at once on
// upstream's Claude Agent provider, split over two account folders, through DeepSeek's Anthropic-compatible endpoint
// (own's forwarder swaps in the sealed key). Measures start-up when N start together, memory, CPU at idle and during
// a turn, the cost of re-spawning evicted conversations (resume), and the SDK's prewarmed spare. Not a test file.
//
//   OWN_CA_ROOT=C:/t/ca12 [OWN_CA_SIZES=4,8,12] bun own/scripts/claude-agent/study/load.ts
import fs from "node:fs"
import path from "node:path"

// Moved out of packages/core (2026-10-31): resolve core's modules and upstream's test helpers from packages/core.
const CORE = path.resolve(import.meta.dirname, "../../../../packages/core")
const core = (name: string) => Bun.resolveSync(name, CORE)
const CA_TEST = path.join(CORE, "test/plugin/provider/claude-agent")

const ROOT = process.env.OWN_CA_ROOT
if (!ROOT || !fs.existsSync(ROOT)) throw new Error("OWN_CA_ROOT must name an existing scratch folder")
const at = { home: "home", a: "config-a", b: "config-b", work: "work", log: "log" } as Record<string, string>
for (const key of Object.keys(at)) {
  at[key] = path.join(ROOT, at[key]!)
  fs.mkdirSync(at[key]!, { recursive: true })
}
// Account B's transcripts live with account A's (the shared-folder design), so either account resumes either one.
fs.mkdirSync(path.join(at.a!, "projects"), { recursive: true })
if (!fs.existsSync(path.join(at.b!, "projects")))
  Bun.spawnSync(["cmd", "/c", "mklink", "/J", path.join(at.b!, "projects"), path.join(at.a!, "projects")])
for (const name of Object.keys(process.env))
  // Every Claude Code and Anthropic variable of the host goes: a Claude Code session running this script hands its
  // children its user e-mail, account ids and messaging socket, and Claude Code puts the e-mail in the prompt.
  if (/^(ANTHROPIC_|CLAUDE)/.test(name)) delete process.env[name]
Object.assign(process.env, {
  HOME: at.home,
  USERPROFILE: at.home,
  CLAUDE_CONFIG_DIR: at.a,
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
})
const sdkBinary = path.resolve(
  import.meta.dirname,
  "../../../../node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
)
process.env.OPENCODE_CLAUDE_PATH = sdkBinary
const SIZES = (process.env.OWN_CA_SIZES ?? "4,8,12").split(",").map(Number)

const { Effect } = await import(core("effect"))
const { query, prewarm } = await import(core("@anthropic-ai/claude-agent-sdk"))
const { startForwarder } = await import("../../../../packages/own-harness/script/live/forwarder.ts")
const { ClaudeIO } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/io"))
const { ClaudeQueryOptions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/query-options"))
const { ClaudeSessions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/sessions"))
const { ClaudeStatus } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/status"))
const { ClaudeAgentLanguageModel } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"))
const { RequestKind } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/request-kind"))
const { TestTools } = await import(path.join(CA_TEST, "lib/tools.ts"))
const { TestSessions } = await import(path.join(CA_TEST, "lib/sessions.ts"))

const requests = { count: 0 }
const fwd = startForwarder(path.join(at.log, "forwarder.jsonl"), {}, 0, {
  allow: (route) => route === "deepseek" && ++requests.count <= 160,
  record: () => {},
})
const connection = {
  ANTHROPIC_BASE_URL: `${fwd.url}/deepseek/anthropic`,
  ANTHROPIC_AUTH_TOKEN: "placeholder-not-a-key",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
  ANTHROPIC_SMALL_FAST_MODEL: "deepseek-flash",
}
const results: Record<string, unknown> = {}
const print = (key: string, value: unknown) => {
  results[key] = value
  console.log(key, JSON.stringify(value))
}

function sample() {
  const out = Bun.spawnSync([
    "powershell",
    "-NoProfile",
    "-Command",
    "$p = Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.ExecutablePath -like '*claude-agent-study*' } | Select-Object -ExpandProperty ProcessId; " +
      "if ($p) { Get-Process -Id $p | ForEach-Object { '{0} {1} {2} {3}' -f $_.Id, $_.TotalProcessorTime.TotalSeconds, $_.WorkingSet64, $_.PrivateMemorySize64 } }; " +
      "'LOAD ' + (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
  ])
  const lines = out.stdout.toString().trim().split(/\r?\n/).filter(Boolean)
  const load = Number(lines.find((line) => line.startsWith("LOAD "))?.slice(5))
  const procs = lines
    .filter((line) => !line.startsWith("LOAD "))
    .map((line) => {
      const [pid, cpu, ws, priv] = line.split(" ").map(Number)
      return { pid: pid!, cpu: cpu!, ws: ws! / 1048576, priv: priv! / 1048576 }
    })
  return { at: Date.now(), load, procs }
}

function cpuPercent(before: ReturnType<typeof sample>, after: ReturnType<typeof sample>) {
  const seconds = (after.at - before.at) / 1000
  const used = after.procs.reduce((sum, proc) => {
    const prior = before.procs.find((item) => item.pid === proc.pid)
    return sum + (prior ? proc.cpu - prior.cpu : 0)
  }, 0)
  // Percent of one logical core, summed over the processes.
  return Math.round((used / seconds) * 1000) / 10
}

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
  }
}

async function turn(lm: any, sessionID: string, prompt: any) {
  const started = Date.now()
  const result = await lm.doStream({
    prompt,
    tools: TestTools.tools,
    headers: { [RequestKind.SESSION_HEADER]: sessionID, [RequestKind.HEADER]: "primary" },
    providerOptions: { "claude-agent": { claudeCodeAgent: "", claudeCodeInstructions: "Answer tersely." } },
  })
  let first: number | undefined
  const parts: any[] = []
  for await (const part of result.stream) {
    if (first === undefined && part.type === "text-delta") first = Date.now()
    parts.push(part)
  }
  const error = parts.find((part) => part.type === "error")
  return {
    ms: Date.now() - started,
    firstMs: (first ?? Date.now()) - started,
    text: TestSessions.text(parts),
    error: error ? String(error.error?.message ?? error.error).slice(0, 160) : undefined,
  }
}

const storages = new Map<number, ReturnType<typeof TestSessions.storage>>()

const round = (size: number, resumeOf?: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = ClaudeSessions.registry()
      yield* Effect.addFinalizer(() => registry.close())
      const storage = storages.get(resumeOf ?? size) ?? TestSessions.storage()
      storages.set(size, storage)
      const status = yield* ClaudeStatus.make(ClaudeIO.real, () => Effect.succeed(connection))
      const sessions = yield* registry.attach({ io: ClaudeIO.real, status, storage, directory: at.work })
      const context = yield* Effect.context<never>()
      const dependencies = {
        run: (request: any, signal: AbortSignal) => Effect.runPromiseWith(context)(sessions.run(request), { signal }),
      }
      // Two accounts: even conversations on folder A, odd on folder B (the junction-free case: each keeps its own).
      const accounts = [
        new ClaudeAgentLanguageModel.Model("haiku", dependencies, connection),
        new ClaudeAgentLanguageModel.Model("haiku", dependencies, { ...connection, CLAUDE_CONFIG_DIR: at.b }),
      ]
      const ids = Array.from({ length: size }, (_, index) => `load-${resumeOf ?? size}-${index}`)
      const prompts = ids.map((id, index) => TestSessions.prompt(`Reply with only the word OK${index}.`))
      const label = resumeOf === undefined ? `n${size}` : `resume-n${size}`
      if (resumeOf !== undefined) {
        // The evicted conversations come back: their next question resumes the saved transcript.
        prompts.forEach((prompt, index) => {
          prompt.push({ role: "assistant", content: [{ type: "text", text: `OK${index}` }] })
          prompt.push({ role: "user", content: [{ type: "text", text: "Again, the same word only." }] })
        })
      }
      const before = sample()
      const first = yield* Effect.promise(() =>
        Promise.all(ids.map((id, index) => turn(accounts[index % 2], id, prompts[index]))),
      )
      const afterFirst = sample()
      print(`${label}-start-together`, {
        systemLoad: before.load,
        firstToken: stats(first.map((row) => row.firstMs)),
        errors: first.filter((row) => row.error).map((row) => row.error),
        cpuDuringStartAndTurn: cpuPercent(before, afterFirst),
      })
      if (resumeOf !== undefined) return
      const idleStart = sample()
      yield* Effect.promise(() => Bun.sleep(10_000))
      const idleEnd = sample()
      print(`${label}-idle`, {
        processes: idleEnd.procs.length,
        workingSetMB: stats(idleEnd.procs.map((proc) => Math.round(proc.ws))),
        privateMB: stats(idleEnd.procs.map((proc) => Math.round(proc.priv))),
        totalWorkingSetMB: Math.round(idleEnd.procs.reduce((sum, proc) => sum + proc.ws, 0)),
        idleCpuPercentOfOneCore: cpuPercent(idleStart, idleEnd),
        systemLoad: idleEnd.load,
      })
      prompts.forEach((prompt, index) => {
        prompt.push({ role: "assistant", content: [{ type: "text", text: first[index]!.text }] })
        prompt.push({ role: "user", content: [{ type: "text", text: "Again, the same word only." }] })
      })
      const turnStart = sample()
      const second = yield* Effect.promise(() =>
        Promise.all(ids.map((id, index) => turn(accounts[index % 2], id, prompts[index]))),
      )
      const turnEnd = sample()
      print(`${label}-second-turn-together`, {
        firstToken: stats(second.map((row) => row.firstMs)),
        total: stats(second.map((row) => row.ms)),
        errors: second.filter((row) => row.error).map((row) => row.error),
        cpuPercentOfOneCore: cpuPercent(turnStart, turnEnd),
        afterTurnWorkingSetMB: Math.round(turnEnd.procs.reduce((sum, proc) => sum + proc.ws, 0)),
      })
    }),
  )

try {
  for (const size of SIZES) await Effect.runPromise(round(size))
  // Every conversation of the first size was evicted when its registry closed; bring them back.
  await Effect.runPromise(round(SIZES[0]!, SIZES[0]!))

  // The SDK's parked spare (`prewarm`, alpha): start-up done before the conversation exists, then `claim`.
  const base = { ...ClaudeQueryOptions.base({ executable: sdkBinary, io: ClaudeIO.real, connection }), model: "haiku" }
  const cold = Date.now()
  const coldQuery = query({ prompt: "Reply with only the word COLD.", options: { ...base, cwd: at.work, persistSession: false } })
  for await (const message of coldQuery) if (message.type === "result") break
  const coldMs = Date.now() - cold
  try {
    const parking = Date.now()
    const spare = await prewarm({ options: { ...base, persistSession: false } })
    const parkedMs = Date.now() - parking
    const claimed = Date.now()
    const warm = spare.claim({ prompt: "Reply with only the word WARM.", options: { cwd: at.work } })
    for await (const message of warm) if (message.type === "result") break
    print("prewarm", { coldQueryMs: coldMs, prewarmMs: parkedMs, claimToResultMs: Date.now() - claimed })
  } catch (error) {
    print("prewarm", { coldQueryMs: coldMs, error: String(error).slice(0, 200) })
  }
} finally {
  print("model-requests", requests.count)
  await fwd.stop()
  fs.writeFileSync(path.join(at.log, "results.json"), JSON.stringify(results, null, 2))
}
