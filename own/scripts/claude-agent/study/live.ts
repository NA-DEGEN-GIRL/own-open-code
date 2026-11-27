// STUDY ONLY (branch claude-agent-study, 2026-10-31): not product code and in no test tier. Kept as the evidence of
// own/reports/claude-agent-provider-2026-10-31.md; run from the repository root as the usage line says.
// own study, live (own/reports/claude-agent-provider-2026-10-31.md §7): upstream's Claude Agent provider driving the
// real `claude` (the SDK's bundled claude.exe) with the Anthropic API key of own's live kit. Not a test file.
//
//   OWN_CA_ROOT=C:/t/ca9 [OWN_CA_ROUTE=deepseek] bun own/scripts/claude-agent/study/live.ts
//
// OWN_CA_ROUTE=deepseek points Claude Code at DeepSeek's Anthropic-compatible endpoint (api.deepseek.com/anthropic)
// through the same forwarder, with Claude Code's `haiku` alias mapped to deepseek-flash: the process model, tool loop,
// latency and memory are Claude Code's either way, while the model is not Claude.
//
// Everything Claude Code reads or writes stays under OWN_CA_ROOT: HOME, USERPROFILE and CLAUDE_CONFIG_DIR point there
// (also for this process, whose SDK session helpers read CLAUDE_CONFIG_DIR), and the key never reaches it: Claude Code
// gets a placeholder and ANTHROPIC_BASE_URL at own's local forwarder, which swaps in the sealed key per request
// (own-harness script/live/forwarder.ts). A meter caps the run at 16 model requests. Prints timings, usage, memory.
import fs from "node:fs"
import path from "node:path"

// Moved out of packages/core (2026-10-31): resolve core's modules and upstream's test helpers from packages/core.
const CORE = path.resolve(import.meta.dirname, "../../../../packages/core")
const core = (name: string) => Bun.resolveSync(name, CORE)
const CA_TEST = path.join(CORE, "test/plugin/provider/claude-agent")

const ROOT = process.env.OWN_CA_ROOT
if (!ROOT || !fs.existsSync(ROOT)) throw new Error("OWN_CA_ROOT must name an existing scratch folder")
const dirs = { home: "home", a: "config-a", b: "config-b", work: "work", log: "log" }
const at = Object.fromEntries(Object.entries(dirs).map(([key, name]) => [key, path.join(ROOT, name)])) as typeof dirs
for (const dir of Object.values(at)) fs.mkdirSync(dir, { recursive: true })
for (const name of Object.keys(process.env))
  // Every Claude Code and Anthropic variable of the host goes: a Claude Code session running this script hands its
  // children its user e-mail, account ids and messaging socket, and Claude Code puts the e-mail in the prompt.
  if (/^(ANTHROPIC_|CLAUDE)/.test(name)) delete process.env[name]
process.env.HOME = at.home
process.env.USERPROFILE = at.home
process.env.CLAUDE_CONFIG_DIR = at.a
process.env.DISABLE_AUTOUPDATER = "1"
process.env.DISABLE_TELEMETRY = "1"
process.env.DISABLE_ERROR_REPORTING = "1"
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
const sdkBinary = path.resolve(
  import.meta.dirname,
  "../../../../node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
)
process.env.OPENCODE_CLAUDE_PATH = sdkBinary

const { Effect } = await import(core("effect"))
const { startForwarder } = await import("../../../../packages/own-harness/script/live/forwarder.ts")
const { ClaudeIO } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/io"))
const { ClaudeProbe } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/probe"))
const { ClaudeQueryOptions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/query-options"))
const { ClaudeSessions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/sessions"))
const { ClaudeStatus } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/status"))
const { ClaudeAgentLanguageModel } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"))
const { RequestKind } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/request-kind"))
const { TestTools } = await import(path.join(CA_TEST, "lib/tools.ts"))
const { TestSessions } = await import(path.join(CA_TEST, "lib/sessions.ts"))

const ROUTE = process.env.OWN_CA_ROUTE === "deepseek" ? "deepseek" : "anthropic"
const requests = { count: 0 }
const fwd = startForwarder(path.join(at.log, "forwarder.jsonl"), {}, 0, {
  allow: (route) => route === ROUTE && ++requests.count <= 16,
  record: () => {},
})
const connection: Record<string, string> =
  ROUTE === "deepseek"
    ? {
        ANTHROPIC_BASE_URL: `${fwd.url}/deepseek/anthropic`,
        ANTHROPIC_AUTH_TOKEN: "placeholder-not-a-key",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
        ANTHROPIC_SMALL_FAST_MODEL: "deepseek-flash",
      }
    : { ANTHROPIC_BASE_URL: `${fwd.url}/anthropic`, ANTHROPIC_API_KEY: "sk-ant-placeholder-not-a-key" }
const results: Record<string, unknown> = { binary: sdkBinary }
const print = (key: string, value: unknown) => {
  results[key] = value
  console.log(key, JSON.stringify(value))
}

function claudeProcesses() {
  const out = Bun.spawnSync([
    "powershell",
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.ExecutablePath -like '*claude-agent-study*' } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.WorkingSetSize }",
  ])
  return out.stdout
    .toString()
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, bytes] = line.split(" ")
      return { pid: Number(pid), mb: Math.round(Number(bytes) / 1024 / 1024) }
    })
}

try {
  const { query } = await import(core("@anthropic-ai/claude-agent-sdk"))
  const bare = Date.now()
  const stop = Promise.withResolvers<void>()
  const started = query({
    prompt: (async function* () {
      await stop.promise
    })(),
    options: { ...ClaudeQueryOptions.base({ executable: sdkBinary, io: ClaudeIO.real, connection }), persistSession: false },
  })
  await started.initializationResult()
  print("startup-bare", { ms: Date.now() - bare })
  stop.resolve()
  started.close()

  const probeStart = Date.now()
  const probe = await Effect.runPromise(
    ClaudeProbe.run(ClaudeQueryOptions.base({ executable: sdkBinary, io: ClaudeIO.real, connection })),
  )
  print("probe", {
    ms: Date.now() - probeStart,
    version: probe.version,
    account: { apiKeySource: probe.account.apiKeySource, apiProvider: probe.account.apiProvider },
    models: probe.models.map((model) => ({ id: model.value, contextWindow: model.contextWindow })),
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const status = yield* ClaudeStatus.make(ClaudeIO.real, () => Effect.succeed(connection))
        const sessions = yield* registry.attach({
          io: ClaudeIO.real,
          status,
          storage: TestSessions.storage(),
          directory: at.work,
        })
        const context = yield* Effect.context<never>()
        const dependencies = {
          run: (request: any, signal: AbortSignal) => Effect.runPromiseWith(context)(sessions.run(request), { signal }),
        }
        const model = (env: Record<string, string>) => new ClaudeAgentLanguageModel.Model("haiku", dependencies, env)
        const onA = model(connection)

        const step = async (
          lm: InstanceType<typeof ClaudeAgentLanguageModel.Model>,
          prompt: any,
          kind: "primary" | "generate" | "title" = "primary",
          tools = TestTools.tools,
        ) => {
          const started = Date.now()
          const result = await lm.doStream({
            prompt,
            tools: kind === "title" ? undefined : tools,
            headers: { [RequestKind.SESSION_HEADER]: "own-live-1", [RequestKind.HEADER]: kind },
            providerOptions: { "claude-agent": { claudeCodeAgent: "", claudeCodeInstructions: "Answer tersely." } },
          })
          let first: number | undefined
          const parts: any[] = []
          for await (const part of result.stream) {
            if (first === undefined && (part.type === "text-delta" || part.type === "tool-call")) first = Date.now()
            parts.push(part)
          }
          const error = parts.find((part) => part.type === "error")
          const finish = parts.findLast((part) => part.type === "finish")
          return {
            parts,
            row: {
              kind,
              ms: Date.now() - started,
              firstMs: first === undefined ? undefined : first - started,
              text: TestSessions.text(parts).slice(0, 80),
              calls: parts.filter((part) => part.type === "tool-call").map((part) => part.toolName),
              usage: finish?.usage?.inputTokens,
              output: finish?.usage?.outputTokens?.total,
              error: error ? String(error.error?.message ?? error.error).slice(0, 300) : undefined,
            },
          }
        }

        // Turn 1: a tool call parked in Claude, run here, and its result fed back to the same Claude turn.
        const prompt = TestSessions.prompt(
          "Call lookup once with key a. After the result, reply only with the marker it returned.",
        )
        const one = yield* Effect.promise(() => step(onA, prompt))
        print("turn1-tool", one.row)
        TestTools.append(prompt, one.parts, TestTools.output)
        const oneB = yield* Effect.promise(() => step(onA, prompt))
        print("turn1-continuation", oneB.row)
        prompt.push({ role: "assistant", content: [{ type: "text", text: TestSessions.text(oneB.parts) }] })
        prompt.push({ role: "user", content: [{ type: "text", text: "What was the marker? Reply only with it." }] })
        const two = yield* Effect.promise(() => step(onA, prompt))
        print("turn2-same-process", two.row)
        print("processes-after-turn2", claudeProcesses())

        // Side calls: a branch (`generate`, a forked copy of this chat) and a title (utility prompt), each its own process.
        const ask = [...prompt]
        ask.push({ role: "assistant", content: [{ type: "text", text: TestSessions.text(two.parts) }] })
        ask.push({ role: "user", content: [{ type: "text", text: "In one word: was a tool used? yes or no." }] })
        print("generate-branch", (yield* Effect.promise(() => step(onA, ask, "generate"))).row)
        print("title", (yield* Effect.promise(() => step(onA, TestSessions.prompt("Title: fix the parser"), "title"))).row)

        // An account switch as one registry would see it: the same chat, a new CLAUDE_CONFIG_DIR (account B).
        prompt.push({ role: "assistant", content: [{ type: "text", text: TestSessions.text(two.parts) }] })
        prompt.push({ role: "user", content: [{ type: "text", text: "Repeat the marker once more." }] })
        // OWN_CA_JUNCTION=1: account B's `projects` folder is a junction to account A's, so both see every transcript.
        if (process.env.OWN_CA_JUNCTION === "1") {
          const made = Bun.spawnSync(["cmd", "/c", "mklink", "/J", path.join(at.b, "projects"), path.join(at.a, "projects")])
          print("junction", { exit: made.exitCode })
        }
        const onB = model({ ...connection, CLAUDE_CONFIG_DIR: at.b })
        const attempt = (label: string) =>
          Effect.promise(() =>
            step(onB, prompt).then(
              (result) => print(label, result.row),
              (error) => print(label, { error: String(error?.message ?? error).slice(0, 200) }),
            ),
          )
        yield* attempt("switch-to-config-b")
        if (process.env.OWN_CA_JUNCTION === "1") return
        // The fix own would need: put the transcript where account B's claude looks, then resume again.
        const projects = path.join(at.a, "projects")
        for (const file of fs.readdirSync(projects, { recursive: true }).map(String).filter((file) => file.endsWith(".jsonl"))) {
          fs.mkdirSync(path.dirname(path.join(at.b, "projects", file)), { recursive: true })
          fs.copyFileSync(path.join(projects, file), path.join(at.b, "projects", file))
        }
        yield* attempt("switch-after-copying-transcript")
        print("transcripts", {
          a: fs.readdirSync(path.join(at.a, "projects"), { recursive: true }).filter((file) => String(file).endsWith(".jsonl")),
          b: fs.existsSync(path.join(at.b, "projects"))
            ? fs.readdirSync(path.join(at.b, "projects"), { recursive: true }).filter((file) => String(file).endsWith(".jsonl"))
            : [],
        })
        print("processes-end", claudeProcesses())
      }),
    ),
  )
} finally {
  print("model-requests", requests.count)
  await fwd.stop()
  fs.writeFileSync(path.join(at.log, "results.json"), JSON.stringify(results, null, 2))
}
