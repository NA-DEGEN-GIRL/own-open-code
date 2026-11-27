// Live check of own's Claude Agent route (02 §8.10, decisions CAG-9): upstream's provider with own's patches (P-045
// account folder, P-039 observer, P-042 allow-list environment) driving the real `claude` (the SDK's bundled
// claude.exe) against DeepSeek's Anthropic-compatible endpoint through own's live forwarder, which swaps in the key per
// request (packages/own-harness/script/live/forwarder.ts). Never a Claude subscription, never the user's ~/.claude.
//
//   OWN_CA_ROOT=C:/t/cbN bun own/scripts/claude-agent/live.ts            (the scratch folder must exist and be empty)
//
// Isolation: claude's whole environment is built here from scratch, never from this process's: system folders, a
// system-only PATH, and HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and CLAUDE_CONFIG_DIR under OWN_CA_ROOT. Order:
//   1. Privacy capture (offline): one primary turn against a local capture server that records the request body and
//      refuses it; the body is searched for e-mail addresses, this Windows user's name, the computer name and any user
//      profile path. Only a clean body lets the live part run.
//   2. Live (at most 8 DeepSeek model requests, a meter refuses more): the login check (models, no model call), a turn
//      with a tool call run here and fed back, a follow-up after the registry closed (P-045: `--resume` of the
//      transcript in the account folder), and a compaction branch (P-045: a fork in that folder). Every live request
//      body is kept under OWN_CA_ROOT/bodies and searched the same way.
// Prints results only: no body, key or personal value is ever printed.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = process.env.OWN_CA_ROOT
if (!ROOT || !fs.existsSync(ROOT) || fs.readdirSync(ROOT).length > 0)
  throw new Error("OWN_CA_ROOT must name an existing, empty scratch folder")
const CORE = path.resolve(import.meta.dirname, "../../../packages/core")
const core = (name: string) => Bun.resolveSync(name, CORE)
const CA_TEST = path.join(CORE, "test/plugin/provider/claude-agent")
const at = {
  home: path.join(ROOT, "home"),
  config: path.join(ROOT, "home", "own", "claude-agent", "accounts", "acc_live"),
  work: path.join(ROOT, "work"),
  tmp: path.join(ROOT, "tmp"),
  bodies: path.join(ROOT, "bodies"),
  log: path.join(ROOT, "log"),
}
for (const dir of Object.values(at)) fs.mkdirSync(dir, { recursive: true })
// The forwarder writes request bodies where this variable says; read once when it loads.
process.env.OWN_LIVE_BODIES = at.bodies

const system = process.env.SystemRoot ?? "C:\\Windows"
/** claude's environment before P-042's allow-list: nothing of this process's own, no user folder. */
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
}
const sdkBinary = path.resolve(
  import.meta.dirname,
  "../../../node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
)

const { Effect } = await import(core("effect"))
const { startForwarder } = await import("../../../packages/own-harness/script/live/forwarder.ts")
const { ClaudeIO } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/io"))
const { ClaudeObserver } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/observer"))
const { ClaudeProbe } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/probe"))
const { ClaudeQueryOptions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/query-options"))
const { ClaudeSessions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/sessions"))
const { ClaudeStatus } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/status"))
const { ClaudeAgentLanguageModel } = await import(
  core("@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model")
)
const { RequestKind } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/request-kind"))
const { TestTools } = await import(path.join(CA_TEST, "lib/tools.ts"))
const { TestSessions } = await import(path.join(CA_TEST, "lib/sessions.ts"))

// The real IO (folder required, SDK helpers on the account folder's transcripts) with P-042's allow-list over the
// isolated environment instead of this process's.
const io = { ...ClaudeIO.real, which: () => sdkBinary, env: () => ClaudeIO.allowed(isolated) }
const results: Record<string, unknown> = { binary: path.basename(sdkBinary) }
const print = (key: string, value: unknown) => {
  results[key] = value
  console.log(key, JSON.stringify(value))
}

/** What a request body must not hold: e-mail addresses, this user's name, the computer's name, a user profile path. */
function privacy(body: string) {
  const user = os.userInfo().username
  const computer = process.env.COMPUTERNAME ?? ""
  // Claude Code's own prompt may name its commit trailer address; any other address is a finding.
  const emails = [...body.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
    .map((match) => match[0].toLowerCase())
    .filter((email) => email !== "noreply@anthropic.com")
  const findings = [
    ...(emails.length > 0 ? [`email(${[...new Set(emails.map((email) => email.split("@")[1]))].join(",")})`] : []),
    ...(user.length > 2 && body.toLowerCase().includes(user.toLowerCase()) ? ["user-name"] : []),
    ...(computer.length > 2 && body.toLowerCase().includes(computer.toLowerCase()) ? ["computer-name"] : []),
    ...(/[A-Za-z]:(\\\\|\\|\/)Users(\\\\|\\|\/)/i.test(body) ? ["user-profile-path"] : []),
    ...(body.includes(os.homedir()) || body.includes(os.homedir().replaceAll("\\", "\\\\")) ? ["home"] : []),
  ]
  // Every absolute Windows path in the body, for the report: they must all be under the scratch folder.
  const paths = [...new Set([...body.matchAll(/[A-Za-z]:(?:\\\\|\\|\/)[^"\s,;)]+/g)].map((match) => match[0]))]
  const outside = paths.filter(
    (item) =>
      !item
        .replaceAll("\\\\", "\\")
        .replaceAll("/", "\\")
        .toLowerCase()
        .startsWith(ROOT!.replaceAll("/", "\\").toLowerCase()),
  )
  return {
    clean: findings.length === 0 && outside.length === 0,
    findings,
    paths: paths.length,
    outside: outside.length,
  }
}

const step = (lm: any, prompt: any, kind: "primary" | "compaction" = "primary", session = "own-live-1") =>
  Effect.promise(async () => {
    const started = Date.now()
    const result = await lm.doStream({
      prompt,
      tools: TestTools.tools,
      headers: { [RequestKind.SESSION_HEADER]: session, [RequestKind.HEADER]: kind },
      providerOptions: {
        "claude-agent": { claudeCodeAgent: "You are a terse assistant.", claudeCodeInstructions: "" },
      },
    })
    const parts: any[] = []
    for await (const part of result.stream) parts.push(part)
    const error = parts.find((part) => part.type === "error")
    return {
      parts,
      row: {
        kind,
        ms: Date.now() - started,
        text: TestSessions.text(parts).slice(0, 60),
        calls: parts.filter((part) => part.type === "tool-call").map((part) => part.toolName),
        error: error ? String(error.error?.message ?? error.error).slice(0, 200) : undefined,
      },
    }
  })

const storage = TestSessions.storage()
const turns = (connection: Record<string, string>, body: (model: any) => any) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const status = yield* ClaudeStatus.make(io, () => Effect.succeed(connection))
        const sessions = yield* registry.attach({ io, status, storage, directory: at.work })
        const context = yield* Effect.context<never>()
        const model = new ClaudeAgentLanguageModel.Model(
          "haiku",
          {
            run: (request: any, signal: AbortSignal) =>
              Effect.runPromiseWith(context)(sessions.run(request), { signal }),
          },
          connection,
        )
        return yield* body(model)
      }),
    ),
  )

// 1. Privacy capture, offline.
const captured: string[] = []
const capture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "POST") captured.push(await request.text())
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "own live check: capture only" } },
      { status: 400 },
    )
  },
})
const offline = {
  ...ClaudeQueryOptions.connectionEnv({ settings: { configDir: at.config } }),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${capture.port}`,
  ANTHROPIC_AUTH_TOKEN: "placeholder-not-a-key",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
  ANTHROPIC_SMALL_FAST_MODEL: "deepseek-flash",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
}
await turns(offline, (model: any) =>
  step(
    model,
    TestSessions.prompt("Call lookup once with key a, then reply only with the marker."),
    "primary",
    "own-capture",
  ),
)
capture.stop(true)
const model = captured.find((body) => body.includes('"messages"'))
const check =
  model === undefined ? { clean: false, findings: ["no-request-captured"], paths: 0, outside: 0 } : privacy(model)
print("privacy-capture", { requests: captured.length, ...check })
fs.writeFileSync(path.join(at.log, "results.json"), JSON.stringify(results, null, 2))
if (!check.clean) {
  console.log("privacy check failed: the live part does not run")
  process.exit(1)
}

// 2. Live, through the forwarder (DeepSeek only, at most 8 model requests).
const requests = { count: 0 }
const fwd = startForwarder(path.join(at.log, "forwarder.jsonl"), {}, 0, {
  allow: (route: string) => route === "deepseek" && ++requests.count <= 8,
  record: () => {},
})
const live = { ...offline, ANTHROPIC_BASE_URL: `${fwd.url}/deepseek/anthropic` }
const observed: unknown[] = []
const listener = (observation: { rateLimit?: unknown; account?: unknown; usage?: unknown; configDir?: string }) =>
  observed.push({
    kind: observation.rateLimit ? "rate_limit" : observation.account ? "account" : "usage",
    folder: observation.configDir === at.config,
  })
ClaudeObserver.channel().listeners.add(listener)
try {
  const probe = await Effect.runPromise(
    ClaudeProbe.run(ClaudeQueryOptions.base({ executable: sdkBinary, io, connection: live })),
  )
  print("probe", { version: probe.version, models: probe.models.map((item: any) => item.value).slice(0, 6) })

  const prompt = TestSessions.prompt(
    "Call lookup once with key a. After the result, reply only with the marker it returned.",
  )
  await turns(live, (model: any) =>
    Effect.gen(function* () {
      const one = yield* step(model, prompt)
      print("turn1-tool", one.row)
      TestTools.append(prompt, one.parts, TestTools.output)
      const two = yield* step(model, prompt)
      print("turn1-after-tool", two.row)
      prompt.push({ role: "assistant", content: [{ type: "text", text: TestSessions.text(two.parts) }] })
    }),
  )
  // The registry closed, as after claude's idle exit: the next turn resumes the transcript in the account folder.
  prompt.push({ role: "user", content: [{ type: "text", text: "What was the marker? Reply only with it." }] })
  await turns(live, (model: any) =>
    Effect.gen(function* () {
      const three = yield* step(model, prompt)
      print("turn2-resumed", three.row)
      prompt.push({ role: "assistant", content: [{ type: "text", text: TestSessions.text(three.parts) }] })
      const compact = [
        ...prompt,
        { role: "user", content: [{ type: "text", text: "Summarize this conversation in one short sentence." }] },
      ]
      print("compaction-branch", (yield* step(model, compact, "compaction")).row)
    }),
  )
  const transcripts = fs
    .readdirSync(path.join(at.config, "projects"), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".jsonl"))
  print("transcripts-in-account-folder", transcripts.length)
} finally {
  ClaudeObserver.channel().listeners.delete(listener)
  print("observations", observed)
  print("model-requests", requests.count)
  await fwd.stop()
  const bodies = fs.existsSync(at.bodies) ? fs.readdirSync(at.bodies).map((name) => path.join(at.bodies, name)) : []
  const checks = bodies.map((file) => privacy(fs.readFileSync(file, "utf8")))
  print("privacy-live", {
    bodies: bodies.length,
    clean: checks.every((item) => item.clean),
    findings: [...new Set(checks.flatMap((item) => item.findings))],
    outside: checks.reduce((sum, item) => sum + item.outside, 0),
  })
  fs.writeFileSync(path.join(at.log, "results.json"), JSON.stringify(results, null, 2))
}
