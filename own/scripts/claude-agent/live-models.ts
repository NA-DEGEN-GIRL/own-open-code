// Live check of what the Claude Agent route's models are (decisions CAM, 2.2.6-own.18): which concrete model each of
// Claude Code's aliases resolves to, the context window Claude Code reports for it, and whether it offers Fast.
//
//   OWN_CA_ROOT=C:/t/cam-N bun own/scripts/claude-agent/live-models.ts            (the scratch folder: new and empty)
//   OWN_CA_CLAUDE=<claude.exe>   another Claude Code than the Agent SDK's bundled one (e.g. the PC's own install)
//   OWN_CA_LIVE=1                also one short turn per alias on the Anthropic API key, through own's live forwarder
//
// 1. The login check own's provider runs (core ClaudeProbe.run, P-051): no prompt, no model call, an empty scratch
//    account folder (no login) and a local base URL that refuses every request, so nothing leaves the PC.
// 2. With OWN_CA_LIVE=1: privacy capture first (one turn against a local gate that records the body and refuses it;
//    the body is searched for e-mail addresses, this Windows user's name, the computer name and user profile paths),
//    then the same check and one short turn per alias on the API key that only the forwarder holds, through own's
//    provider path (core's sessions with P-060), and one Fast turn on a model Claude Code offers Fast for. Each turn's
//    result reports the model that ran (`modelUsage` keys), its `contextWindow` and `fast_mode_state`, as the
//    observer channel carries them to own-accounts.
// Never a Claude subscription folder, never the user's ~/.claude; claude's whole environment is built here.
// Prints results only: no body, key or personal value is ever printed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = process.env.OWN_CA_ROOT
if (!ROOT || !fs.existsSync(ROOT) || fs.readdirSync(ROOT).length > 0)
  throw new Error("OWN_CA_ROOT must name an existing, empty scratch folder")
const REPO = path.resolve(import.meta.dirname, "../../..")
const CORE = path.join(REPO, "packages/core")
const core = (name: string) => Bun.resolveSync(name, CORE)
const at = {
  home: path.join(ROOT, "home"),
  config: path.join(ROOT, "home", "own", "claude-agent", "accounts", "acc_models"),
  work: path.join(ROOT, "work"),
  tmp: path.join(ROOT, "tmp"),
  bodies: path.join(ROOT, "bodies"),
  log: path.join(ROOT, "log"),
}
for (const dir of Object.values(at)) fs.mkdirSync(dir, { recursive: true })
process.env.OWN_LIVE_BODIES = at.bodies

const system = process.env.SystemRoot ?? "C:\\Windows"
const isolated: Record<string, string> = {
  SystemRoot: system,
  windir: system,
  SystemDrive: process.env.SystemDrive ?? "C:",
  ComSpec: path.join(system, "System32", "cmd.exe"),
  PATH: [path.join(system, "System32"), system, path.join(system, "System32", "Wbem")].join(";"),
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  OS: "Windows_NT",
  PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE ?? "AMD64",
  NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS ?? "4",
  HOME: at.home,
  USERPROFILE: at.home,
  APPDATA: path.join(at.home, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(at.home, "AppData", "Local"),
  TEMP: at.tmp,
  TMP: at.tmp,
  DISABLE_AUTOUPDATER: "1",
}
const binary =
  process.env.OWN_CA_CLAUDE ||
  path.join(
    REPO,
    "node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
  )

const { Effect } = await import(core("effect"))
const { ClaudeIO } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/io"))
const { ClaudeProbe } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/probe"))
const { ClaudeQueryOptions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/query-options"))

const io = { ...ClaudeIO.real, which: () => binary, env: () => ClaudeIO.allowed(isolated) }
const results: Record<string, unknown> = { binary: path.basename(path.dirname(binary)) + "/" + path.basename(binary) }
const print = (key: string, value: unknown) => {
  results[key] = value
  console.log(key, JSON.stringify(value))
  fs.writeFileSync(path.join(at.log, "results.json"), JSON.stringify(results, null, 2))
}

function privacy(body: string) {
  const user = os.userInfo().username
  const computer = os.hostname()
  const emails = [...body.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
    .map((match) => match[0].toLowerCase())
    .filter((email) => email !== "noreply@anthropic.com")
  const lower = body.toLowerCase()
  const findings = [
    ...(emails.length > 0 ? ["email"] : []),
    ...(user.length > 2 && lower.includes(user.toLowerCase()) ? ["user-name"] : []),
    ...(computer.length > 2 && lower.includes(computer.toLowerCase()) ? ["computer-name"] : []),
    ...(lower.includes(os.homedir().toLowerCase()) ||
    lower.includes(os.homedir().replaceAll("\\", "\\\\").toLowerCase())
      ? ["home"]
      : []),
  ]
  return { clean: findings.length === 0, findings }
}

/** A local gate: records each POST body and refuses it, so a request never leaves the PC. */
function gate() {
  const bodies: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") bodies.push(await request.text())
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "own live check: refused" } },
        { status: 400 },
      )
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, bodies, stop: () => server.stop(true) }
}

const probe = (connection: Record<string, string>) =>
  Effect.runPromise(ClaudeProbe.run(ClaudeQueryOptions.base({ executable: binary, io, connection })))

const describe = (result: Awaited<ReturnType<typeof probe>>) => ({
  version: result.version,
  models: result.models.map((model: Record<string, unknown>) => ({
    value: model.value,
    resolvedModel: model.resolvedModel,
    displayName: model.displayName,
    description: model.description,
    contextWindow: model.contextWindow,
    supportsFastMode: model.supportsFastMode,
    efforts: model.supportedEffortLevels,
  })),
})

// 1. The login check, offline.
const offline = gate()
const base = {
  ...ClaudeQueryOptions.connectionEnv({ settings: { configDir: at.config } }),
  ANTHROPIC_BASE_URL: offline.url,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
}
print("probe-offline", describe(await probe(base)))
print("offline-requests", offline.bodies.length)
offline.stop()

if (process.env.OWN_CA_LIVE === "1") await live()

async function live() {
  const { ClaudeObserver } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/observer"))
  const { ClaudeSessions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/sessions"))
  const { ClaudeStatus } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/status"))
  const { ClaudeAgentLanguageModel } = await import(
    core("@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model")
  )
  const { RequestKind } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/request-kind"))
  const { TestSessions } = await import(path.join(CORE, "test/plugin/provider/claude-agent/lib/sessions.ts"))
  const storage = TestSessions.storage()
  const seen: Array<Record<string, unknown>> = []
  const listener = (observation: Record<string, unknown>) => {
    if (observation.windows || observation.fast) seen.push(observation)
  }
  ClaudeObserver.channel().listeners.add(listener)

  // One turn through own's provider path (core's sessions, P-045's folder, P-060's Fast): what the turn reported.
  const turn = (connection: Record<string, string>, model: string, fast: boolean, session: string) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = ClaudeSessions.registry()
          yield* Effect.addFinalizer(() => registry.close())
          const status = yield* ClaudeStatus.make(io, () => Effect.succeed(connection))
          const sessions = yield* registry.attach({ io, status, storage, directory: at.work })
          const context = yield* Effect.context<never>()
          const lm = new ClaudeAgentLanguageModel.Model(
            model,
            {
              run: (request: any, signal: AbortSignal) =>
                Effect.runPromiseWith(context)(sessions.run(request), { signal }),
            },
            connection,
          )
          const before = seen.length
          const result = yield* Effect.promise(() =>
            lm.doStream({
              prompt: TestSessions.prompt("Reply with the single word OK."),
              headers: { [RequestKind.SESSION_HEADER]: session, [RequestKind.HEADER]: "primary" },
              providerOptions: {
                "claude-agent": {
                  claudeCodeAgent: "You are a terse assistant.",
                  claudeCodeInstructions: "",
                  ...(fast ? { fastMode: true } : {}),
                },
              },
            }),
          )
          const parts: any[] = []
          yield* Effect.promise(async () => {
            for await (const part of result.stream) parts.push(part)
          })
          const error = parts.find((part) => part.type === "error")
          return {
            text: TestSessions.text(parts).slice(0, 20),
            ...(error ? { error: String(error.error?.message ?? error.error).slice(0, 200) } : {}),
            reported: seen.slice(before).map((item) => ({
              ...(item.windows ? { windows: item.windows } : {}),
              ...(item.fast ? { fast: item.fast } : {}),
            })),
          }
        }),
      ),
    )

  const capture = gate()
  await turn(
    { ...base, ANTHROPIC_BASE_URL: capture.url, ANTHROPIC_AUTH_TOKEN: "placeholder-not-a-key" },
    "haiku",
    false,
    "own-capture",
  )
  capture.stop()
  const check = capture.bodies.find((body) => body.includes('"messages"'))
  const clean = check === undefined ? { clean: false, findings: ["no-request-captured"] } : privacy(check)
  print("privacy-capture", { requests: capture.bodies.length, ...clean })
  if (!clean.clean) {
    console.log("privacy check failed: the live part does not run")
    process.exit(1)
  }

  const { startForwarder } = await import(path.join(REPO, "packages/own-harness/script/live/forwarder.ts"))
  const requests = { count: 0 }
  const fwd = startForwarder(path.join(at.log, "forwarder.jsonl"), {}, 0, {
    allow: (route: string) => route === "anthropic" && ++requests.count <= 40,
    record: () => {},
  })
  const keyed = {
    ...ClaudeQueryOptions.connectionEnv({ settings: { configDir: at.config } }),
    ANTHROPIC_BASE_URL: `${fwd.url}/anthropic`,
    ANTHROPIC_API_KEY: "placeholder-the-forwarder-holds-the-key",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
  try {
    const checked = describe(await probe(keyed))
    print("probe-api-key", checked)
    const aliases = checked.models
      .map((item: { value: string }) => item.value)
      .filter((value: string) => value !== "default")
    for (const model of aliases) print(`turn-${model}`, await turn(keyed, model, false, `own-live-${model}`))
    // Fast on a model Claude Code offers it for (P-060's `fastMode` flag before the turn).
    const fastModel = checked.models.find(
      (item: { supportsFastMode?: boolean; value: string }) => item.supportsFastMode && item.value !== "default",
    )
    if (fastModel) print(`turn-${fastModel.value}-fast`, await turn(keyed, fastModel.value, true, `own-live-fast`))
  } finally {
    ClaudeObserver.channel().listeners.delete(listener)
    print("model-requests", requests.count)
    await fwd.stop()
    const bodies = fs.readdirSync(at.bodies).map((name) => privacy(fs.readFileSync(path.join(at.bodies, name), "utf8")))
    print("privacy-live", {
      bodies: bodies.length,
      clean: bodies.every((item) => item.clean),
      findings: [...new Set(bodies.flatMap((item) => item.findings))],
    })
  }
}
