// STUDY ONLY (branch claude-agent-study, 2026-10-31): not product code and in no test tier. Kept as the evidence of
// own/reports/claude-agent-provider-2026-10-31.md; run from the repository root as the usage line says.
// own study, live (own/reports/claude-agent-provider-2026-10-31.md §12–§13): (A) a transcript own derives from
// OpenCode history (NativeTranscript, with another model's tool call) is resumed by the real `claude` through the
// provider's registry, and the request Claude Code sends carries real tool_use/tool_result blocks; (B) the same history
// without it goes as upstream's `<conversation-checkpoint>` text; (C) what Claude Code reports about plan limits when
// the API answers with Anthropic's unified rate-limit headers (synthetic values added by a local proxy). DeepSeek's
// Anthropic-compatible endpoint answers, through own's forwarder. Not a test file.
//
//   OWN_CA_ROOT=C:/t/ca13 bun own/scripts/claude-agent/study/native-live.ts
import fs from "node:fs"
import path from "node:path"

// Moved out of packages/core (2026-10-31): resolve core's modules and upstream's test helpers from packages/core.
const CORE = path.resolve(import.meta.dirname, "../../../../packages/core")
const core = (name: string) => Bun.resolveSync(name, CORE)
const CA_TEST = path.join(CORE, "test/plugin/provider/claude-agent")

const ROOT = process.env.OWN_CA_ROOT
if (!ROOT || !fs.existsSync(ROOT)) throw new Error("OWN_CA_ROOT must name an existing scratch folder")
const at = { home: "home", a: "config-a", work: "work", log: "log", bodies: "bodies" } as Record<string, string>
for (const key of Object.keys(at)) {
  at[key] = path.join(ROOT, at[key]!)
  fs.mkdirSync(at[key]!, { recursive: true })
}
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
  OWN_LIVE_BODIES: at.bodies,
})
const sdkBinary = path.resolve(
  import.meta.dirname,
  "../../../../node_modules/.bun/@anthropic-ai+claude-agent-sdk-win32-x64@0.3.301/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
)
process.env.OPENCODE_CLAUDE_PATH = sdkBinary

const { Effect } = await import(core("effect"))
const { query, getSessionMessages } = await import(core("@anthropic-ai/claude-agent-sdk"))
const { startForwarder } = await import("../../../../packages/own-harness/script/live/forwarder.ts")
const { ClaudeIO } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/io"))
const { ClaudeQueryOptions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/query-options"))
const { ClaudeSessions } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/sessions"))
const { ClaudeStatus } = await import(core("@opencode/core/plugin/provider/claude-agent/claude/status"))
const { ClaudeAgentLanguageModel } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/claude-agent-language-model"))
const { RequestKind } = await import(core("@opencode/core/plugin/provider/claude-agent/language-model/request-kind"))
const { NativeTranscript } = await import("./native-transcript.ts")
const { TestTools } = await import(path.join(CA_TEST, "lib/tools.ts"))
const { TestSessions } = await import(path.join(CA_TEST, "lib/sessions.ts"))

const requests = { count: 0 }
const fwd = startForwarder(path.join(at.log!, "forwarder.jsonl"), {}, 0, {
  allow: (route) => route === "deepseek" && ++requests.count <= 20,
  record: () => {},
})
// A local proxy in front of the forwarder that adds Anthropic's unified rate-limit headers, as a subscription's answer
// carries them (names as own's Unified.parse reads them, values made up). It touches no account.
const reset5h = Math.floor(Date.now() / 1000) + 3600
const reset7d = Math.floor(Date.now() / 1000) + 5 * 86400
const UNIFIED: Record<string, string> = {
  "anthropic-ratelimit-unified-status": "allowed_warning",
  "anthropic-ratelimit-unified-reset": String(reset5h),
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-5h-status": "allowed_warning",
  "anthropic-ratelimit-unified-5h-utilization": "0.87",
  "anthropic-ratelimit-unified-5h-reset": String(reset5h),
  "anthropic-ratelimit-unified-5h-surpassed-threshold": "0.85",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.41",
  "anthropic-ratelimit-unified-7d-reset": String(reset7d),
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
}
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const upstream = await fetch(fwd.url + url.pathname + url.search, { method: request.method, headers: request.headers, body })
    const headers = new Headers(upstream.headers)
    if (url.pathname.endsWith("/messages")) for (const [name, value] of Object.entries(UNIFIED)) headers.set(name, value)
    headers.delete("content-encoding")
    headers.delete("content-length")
    return new Response(upstream.body, { status: upstream.status, headers })
  },
})
const base = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
  ANTHROPIC_SMALL_FAST_MODEL: "deepseek-flash",
  ANTHROPIC_AUTH_TOKEN: "placeholder-not-a-key",
}
const direct = { ...base, ANTHROPIC_BASE_URL: `${fwd.url}/deepseek/anthropic` }
const limited = { ...base, ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}/deepseek/anthropic` }
const results: Record<string, unknown> = {}
const print = (key: string, value: unknown) => {
  results[key] = value
  console.log(key, JSON.stringify(value))
}

// OpenCode's history as another model (GPT, say) wrote it: one lookup call and its result.
const history: any[] = [
  { role: "system", content: "S" },
  { role: "user", content: [{ type: "text", text: "Look up key a and keep the marker in mind." }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Another model's thinking." },
      { type: "text", text: "Looking it up." },
      { type: "tool-call", toolCallId: "call_gpt_1", toolName: "lookup", input: { key: "a" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call_gpt_1", toolName: "lookup", output: { type: "text", value: "LILAC-HERON" } }],
  },
  { role: "assistant", content: [{ type: "text", text: "Noted." }] },
]
const question = {
  role: "user",
  content: [
    {
      type: "text",
      text: "Earlier in this conversation a tool was called. Answer exactly as tool|key|value with the tool's name, the key it was given and the value it returned.",
    },
  ],
}

function lastBody() {
  const files = fs.readdirSync(at.bodies!).filter((file) => file.endsWith("-deepseek.json")).sort()
  const body = JSON.parse(fs.readFileSync(path.join(at.bodies!, files.at(-1)!), "utf8"))
  const shape = (body.messages as any[]).map((message) => ({
    role: message.role,
    blocks: (typeof message.content === "string" ? [{ type: "string" }] : message.content).map((block: any) =>
      block.type === "tool_use"
        ? `tool_use ${block.id} ${block.name} ${JSON.stringify(block.input)}`
        : block.type === "tool_result"
          ? `tool_result ${block.tool_use_id}`
          : block.type === "text"
            ? `text ${JSON.stringify(block.text.slice(0, 60))}`
            : block.type,
    ),
  }))
  const raw = JSON.stringify(body)
  return { shape, checkpointText: raw.includes("conversation-checkpoint"), hostEmail: raw.includes("@gmail.com") }
}

try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = ClaudeSessions.registry()
        yield* Effect.addFinalizer(() => registry.close())
        const storage = TestSessions.storage()
        const status = yield* ClaudeStatus.make(ClaudeIO.real, () => Effect.succeed(direct))
        const sessions = yield* registry.attach({ io: ClaudeIO.real, status, storage, directory: at.work! })
        const context = yield* Effect.context<never>()
        const lm = new ClaudeAgentLanguageModel.Model(
          "haiku",
          { run: (request: any, signal: AbortSignal) => Effect.runPromiseWith(context)(sessions.run(request), { signal }) },
          direct,
        )
        const ask = async (sessionID: string) => {
          const result = await lm.doStream({
            prompt: [...history, question],
            tools: TestTools.tools,
            headers: { [RequestKind.SESSION_HEADER]: sessionID, [RequestKind.HEADER]: "primary" },
            providerOptions: { "claude-agent": { claudeCodeAgent: "", claudeCodeInstructions: "" } },
          })
          const parts: any[] = []
          for await (const part of result.stream) parts.push(part)
          return TestSessions.text(parts).trim()
        }

        // A: own derives the transcript and its record from OpenCode history, then the provider resumes it.
        const sessionId = crypto.randomUUID()
        const built = NativeTranscript.build({ sessionId, cwd: at.work!, version: "2.1.301", prompt: history, tools: TestTools.tools })
        yield* Effect.promise(() => NativeTranscript.write(at.a!, at.work!, sessionId, built.entries))
        yield* storage.set("sessions/native-1", { claudeSessionID: sessionId, history: built.history })
        const read = yield* Effect.promise(() => getSessionMessages(sessionId))
        print("A-sdk-reads-derived-transcript", { messages: read.length, types: read.map((message) => message.type) })
        print("A-answer", yield* Effect.promise(() => ask("native-1")))
        print("A-request", lastBody())

        // B: the same history with no record goes as upstream's checkpoint text.
        print("B-answer", yield* Effect.promise(() => ask("text-1")))
        print("B-request", lastBody())
      }),
    ),
  )

  // C: plan-limit messages, with the unified headers on every Messages answer.
  const stop = Promise.withResolvers<void>()
  const limitedQuery = query({
    prompt: (async function* () {
      yield { type: "user" as const, message: { role: "user" as const, content: "Reply with only OK." }, parent_tool_use_id: null }
      await stop.promise
    })(),
    options: {
      ...ClaudeQueryOptions.base({ executable: sdkBinary, io: ClaudeIO.real, connection: limited }),
      model: "haiku",
      cwd: at.work,
      persistSession: false,
    },
  })
  const seen: string[] = []
  const limits: unknown[] = []
  // Read by hand: leaving a for-await loop would close the query before the usage control below.
  while (true) {
    const next = await limitedQuery.next()
    if (next.done) break
    const message = next.value
    seen.push(message.type === "system" ? `system/${(message as any).subtype}` : message.type)
    if (message.type === "rate_limit_event") limits.push((message as any).rate_limit_info)
    if (message.type === "result") break
  }
  print("C-message-types", [...new Set(seen)])
  print("C-rate-limit-events", limits)
  const usage = await limitedQuery
    .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    .catch((error: unknown) => ({ error: String(error).slice(0, 200) }))
  print("C-usage-control", usage)
  stop.resolve()
  limitedQuery.close()
} finally {
  print("model-requests", requests.count)
  proxy.stop(true)
  await fwd.stop()
  fs.writeFileSync(path.join(at.log!, "results.json"), JSON.stringify(results, null, 2))
}
