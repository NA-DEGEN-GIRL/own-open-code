// Real-host phase D (04 §20.3 RG18, §8.11, design appendix B "B12"; scenarios D1–D13, not the user decisions D1–D3 of
// 8.11.16): the Claude subscription slot of a remote session through this PC's egress relay, on the phase A host.
//
//   host core ─▶ remote own-accounts stub ─▶ egress-<epoch>.sock ─ sshd -R ─▶ ssh.exe ─▶ PC relay 127.0.0.1:E_h
//     ─▶ this PC's claude-auth (FAKE Claude Code login) ─▶ the FAKE Anthropic upstream below (127.0.0.1 here)
//
// B12 setup: this PC's release service (stack.ts) loads the release's bundled claude-auth (02 §8.2: `app\plugins\
// claude-auth`, copied where an install puts it, `<OWN_HOME>\app\<version>\plugins\claude-auth`; for a release before
// the bundle the fake fixture of own-accounts' tests stands in and the wire equivalence is B2's), a FAKE Claude Code home (`CLAUDE_CONFIG_DIR`, `USERPROFILE`, `HOME`, the
// refresh lock dir, all under the temp root, fake tokens only), `HTTPS_PROXY` to a recording 403 sink on this PC (so any
// claude.ai or api.anthropic.com call shows) and a PATH without `claude`. `broker.claudeUpstream` points the relay at
// this suite's scripted Anthropic; the host keeps the phase A env (its https goes to the phase sink). No real Claude
// account, token or endpoint is used. Opt-in: OWN_REAL_HOST=dev-host; run after a, b, c and before z-cleanup.
//
//   D1  two steps with a tool call: the host runs the tool; every step is signed on the PC (win32, fake bearer,
//       identity and billing), no x-own-* or x-api-key upstream, no sink line on either side
//   D2  hygiene (RG10 style): no fake token or credential JSON on the host; no `anthropic` connection there (no
//       conflict); no claude-auth marker in the host's plugins. Checked again at the end with /tmp/.bun-<uid>-*
//   D3  a 5-minute stream cancelled after 10 s: the upstream sees the close within 5 s, nothing in flight on the PC
//   D4  a 6-minute stream (20 with OWN_REAL_HOST_D4_LONG_MS=1200000) with a ping every 15 s (and a text delta every
//       4 min: P-018 fails a stream without output progress for 300 s), a stream with 4 min 30 s of silence, a 5 MiB body with an image: all complete (and a
//       4 MiB answer down)
//   D5  ssh.exe killed mid-stream: the upstream closes within 60 s; the step whose output started fails, its tool is
//       not run twice; a turn during the break never reaches the upstream; after reconnecting, a new epoch and no old
//       egress socket
//   D6  switched off on the PC: the stream in flight ends, the next request is refused at once; scope `only` without
//       the slot refuses with host_scope
//   D7  same-uid requests to the egress socket (no MAC, random MAC) and to the stub port: all 401, upstream 0, broker up
//   D8  one 401, the credentials file already holds token2: the plugin adopts it and succeeds; no refresh on the sink,
//       no `claude` process
//   D9  401 every time: needs_reauth for 60 s; at most one forced refresh reaches the PC sink, none from the host
//   D10 429 with unified 5h `rejected`, retry-after 3600: the turn stops at once; claude.5h exhausted with origin =
//       host; the earlier steps' ledger lines and an exhaustion event on the PC
//   D11 Fast with the PC's consent (and `recordOn:"local"` without it): speed and the fast beta upstream
//   D12 a Claude main with two Claude subagents at once: both streams go through the relay concurrently and finish
//   D13 TCP mode: the egress runs on `egressTcpPort` and the MAC is enforced there too
//   D14 two Claude accounts (02 §8.7, 04 §8.11.18): on the bundled plugin (patched at build time), a second FAKE
//       login registered as `Claude 계정 추가` leaves it; a host conversation bound to
//       the second account is signed with its token only (proof v2), account 1's conversations keep theirs, the PC
//       attributes ledger lines and limit windows to the signing account, and v1 or forged v2 proofs are 401 `mac`
//
// D1–D13 run with the slot's own account only: account 1's folder is the FAKE Claude Code home (`claude-auth.json`, as
// the patched plugin reads own's account list, not CLAUDE_CONFIG_DIR). Nothing is acknowledged for the slot on this PC
// (the plugin ships with the app); the remote consent names the bundle's pin.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { unifiedHeaders } from "../../../own-accounts/test/e2e-kit/fakes/anthropic"
import { writeFakeClaudeAuth } from "../../../own-accounts/test/support/fake-claude-auth.js"
import { Notice } from "../../../own-accounts/src/plugins/notice.js"
import * as Env from "./env.js"
import * as Stack from "./stack.js"

const run = Env.heavyHost ? describe : describe.skip
const CLIENT = "real-host-d"
/** FAKE Claude Code login (never real credentials); D2 scans the host for each value. */
const TOKEN1 = "sk-ant-oat01-ownRealHostFakeAccessToken0000000001"
const TOKEN2 = "sk-ant-oat01-ownRealHostFakeAccessToken0000000002"
const REFRESH = "sk-ant-ort01-ownRealHostFakeRefreshToken000000001"
/** D14: the second Claude account's FAKE login and its own id (as `Claude 계정 추가` makes one). */
const TOKEN3 = "sk-ant-oat01-ownRealHostFakeAccessToken0000000003"
const SECOND = "acc_01J9E2EREALHOSTSECOND00000"
const FAKES = [TOKEN1, TOKEN2, TOKEN3, REFRESH]
const PREFERRED_MODEL = "claude-haiku-4-5"
const BIG = 4 * 1024 * 1024
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const BILLING = "x-anthropic-billing-header"
const TITLE = "You name conversations so the user can find them later"
const PING_MS = 15_000
/**
 * D4-LONG's length. 6 min by default: past P-018's 300 s progress watchdog only thanks to the 240 s text delta, and past
 * Bun's 5-minute fetch limit with a delta between. `OWN_REAL_HOST_D4_LONG_MS=1200000` runs the full 20 minutes: when the
 * relay, egress or broker code of own-remote or own-accounts, or core P-018, changed since the last full pass, and once a
 * week (a cutoff between 6 and 20 min, such as a 10-minute tunnel idle limit, shows only there);
 * `bun own/scripts/test/d4-due.ts` says whether it is due (own/handoff/RELEASE.md). 1,200 s of every release chain
 * before 2026-10-29 (test-speed).
 */
const LONG_MS = Number(process.env.OWN_REAL_HOST_D4_LONG_MS ?? 6 * 60_000)
const SILENT_MS = 270_000
/** D4-LONG's stream as the upstream wrote it (bytes, SSE events, the longest pause), for the evidence. */
const d4Meter = { bytes: 0, events: 0, at: 0, longestGapMs: 0 }
/**
 * D4-LONG's output progress: core fails a model stream with no output progress for 300 s (P-018, `http.progressTimeout`;
 * pings are keepalives, not progress), so the long stream sends a short text delta every 4 minutes.
 */
const PROGRESS_MS = 240_000
const MARKERS = [
  "[D1]",
  "[D3]",
  "[D4-LONG]",
  "[D4-SILENT]",
  "[D4-IMAGE]",
  "[D4-BIG-OUT]",
  "[D5]",
  "[D5-DURING]",
  "[D5-AFTER]",
  "[D6]",
  "[D6-AFTER]",
  "[D6-SCOPE]",
  "[D6-BACK]",
  "[D7-AFTER]",
  "[D8-WARM]",
  "[D8]",
  "[D9]",
  "[D9-HOLD]",
  "[D9-AFTER]",
  "[D10]",
  "[D11]",
  "[D12]",
  "[D12-CHILD-A]",
  "[D12-CHILD-B]",
  "[D13]",
  "[D14-ONE]",
  "[D14-TWO]",
  "[D14-MAIN]",
] as const

type Json = Record<string, any>

interface Seen {
  readonly at: number
  readonly path: string
  readonly marker: string | null
  readonly title: boolean
  readonly size: number
  readonly model: string | null
  readonly authorization: string | null
  readonly os: string | null
  readonly agent: string | null
  readonly beta: string | null
  readonly egress: string | null
  readonly apiKey: string | null
  readonly parent: string | null
  readonly speed: string | null
  readonly identity: boolean
  readonly billing: boolean
  readonly image: boolean
  readonly toolResult: boolean
}

/** The text of the last user message that has text, and whether the very last message carries a tool result. */
function lastUser(body: Json) {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Json[]
  const blocks = (message: Json): Json[] =>
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : []
  const last = messages.at(-1)
  const toolResult = last !== undefined && blocks(last).some((block) => block.type === "tool_result")
  const withText = messages.findLast(
    (message) => message.role === "user" && blocks(message).some((block) => block.type === "text"),
  )
  const text = withText
    ? blocks(withText)
        .filter((block) => block.type === "text")
        .map((block) => String(block.text))
        .join("\n")
    : ""
  return { text, toolResult }
}

/** The marker written last in `text` (a failed turn's prompt may share a request with the next one). */
function markerOf(text: string) {
  return (
    MARKERS.map((marker) => ({ marker, at: text.lastIndexOf(marker) }))
      .filter((item) => item.at >= 0)
      .toSorted((a, b) => b.at - a.at || b.marker.length - a.marker.length)[0]?.marker ?? null
  )
}

const encoder = new TextEncoder()
const sseEvent = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const messageStart = (model: string, speed: string | null) =>
  sseEvent("message_start", {
    type: "message_start",
    message: {
      id: `msg_rh_${Math.random().toString(36).slice(2, 10)}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 120,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...(speed ? { speed } : {}),
      },
    },
  })
const textStart = () =>
  sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
const textDelta = (text: string) =>
  sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
const textEnd = () => [
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
  sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 20 },
  }),
  sseEvent("message_stop", { type: "message_stop" }),
]

/** A streamed text answer of `chunks` deltas (pulled one by one: the relay's backpressure reaches this generator). */
function textStream(model: string, speed: string | null, chunks: () => Generator<string>) {
  const parts = chunks()
  const state = { started: false }
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!state.started) {
        state.started = true
        controller.enqueue(messageStart(model, speed))
        controller.enqueue(textStart())
        return
      }
      const next = parts.next()
      if (!next.done) return controller.enqueue(textDelta(next.value))
      for (const event of textEnd()) controller.enqueue(event)
      controller.close()
    },
  })
}

/**
 * A timed stream: `message_start`, then a `ping` every `pingMs` until `totalMs`, with `silentMs` of nothing after the
 * first ping; `output` (if any) is sent as text right away (the step's output has started); with `progressMs`, a short
 * text delta goes out with the first ping after each `progressMs`; it ends with `finalText`, or never (`totalMs`
 * Infinity). `onClose` runs once when the stream ends or the request is aborted.
 */
function timedStream(input: {
  readonly model: string
  readonly signal: AbortSignal
  readonly pingMs?: number
  readonly totalMs: number
  readonly silentMs?: number
  readonly progressMs?: number
  readonly output?: string
  readonly finalText?: string
  readonly delayMs?: number
  readonly onAbort?: () => void
  readonly onClose?: () => void
  /** D4's numbers: what the upstream wrote into the relay and its longest pause between two writes. */
  readonly meter?: { bytes: number; events: number; at: number; longestGapMs: number }
}) {
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const closed = { value: false }
  const finish = () => {
    if (closed.value) return
    closed.value = true
    timers.forEach((timer) => clearTimeout(timer))
    input.onClose?.()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (bytes: Uint8Array) => {
        if (closed.value) return
        controller.enqueue(bytes)
        const meter = input.meter
        if (!meter) return
        const now = Date.now()
        if (meter.at > 0) meter.longestGapMs = Math.max(meter.longestGapMs, now - meter.at)
        meter.at = now
        meter.bytes += bytes.byteLength
        meter.events += 1
      }
      input.signal.addEventListener("abort", () => {
        if (!closed.value) input.onAbort?.()
        finish()
      })
      send(messageStart(input.model, null))
      send(sseEvent("ping", { type: "ping" }))
      const text = { open: input.output !== undefined, progressAt: Date.now() }
      if (input.output !== undefined) {
        send(textStart())
        send(textDelta(input.output))
      }
      const started = Date.now()
      const silence = input.silentMs ?? 0
      const tick = () => {
        if (closed.value) return
        const elapsed = Date.now() - started
        if (elapsed >= input.totalMs) {
          if (!text.open) send(textStart())
          send(textDelta(input.finalText ?? "done"))
          for (const event of textEnd()) send(event)
          finish()
          controller.close()
          return
        }
        send(sseEvent("ping", { type: "ping" }))
        if (input.progressMs !== undefined && Date.now() - text.progressAt >= input.progressMs) {
          if (!text.open) send(textStart())
          text.open = true
          text.progressAt = Date.now()
          send(textDelta(". "))
        }
        timers.push(setTimeout(tick, Math.min(input.pingMs ?? PING_MS, input.totalMs - elapsed)))
      }
      timers.push(setTimeout(tick, silence > 0 ? silence : Math.min(input.pingMs ?? PING_MS, input.totalMs)))
    },
    cancel() {
      finish()
    },
  })
}

/** One assistant message of tool calls (`calls` in parallel, indices 0..n-1). */
function toolUseStream(model: string, calls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(messageStart(model, null))
      calls.forEach((call, index) => {
        controller.enqueue(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: `toolu_rh_${Date.now()}_${index}`, name: call.name, input: {} },
          }),
        )
        controller.enqueue(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
          }),
        )
        controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }))
      })
      controller.enqueue(
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 30 },
        }),
      )
      controller.enqueue(sseEvent("message_stop", { type: "message_stop" }))
      controller.close()
    },
  })
}

/**
 * The FAKE Anthropic upstream of this PC's relay, scripted by the marker of the last user text. It records what reached
 * it (header values that matter, body facts, never bodies) and answers with SSE, timed or hanging streams, 401 or 429.
 */
function startUpstream(project: () => string) {
  const seen: Seen[] = []
  const aborted: Array<{ readonly marker: string | null; readonly at: number }> = []
  const closed: Array<{ readonly marker: string | null; readonly at: number }> = []
  const children = { active: 0, max: 0 }
  const allowed = () => {
    const now = Math.floor(Date.now() / 1000)
    return unifiedHeaders({
      status: "allowed",
      fiveHourUtilization: 0.21,
      sevenDayUtilization: 0.07,
      fiveHourReset: now + 3 * 3600,
      sevenDayReset: now + 4 * 86_400,
    })
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const raw = await request.text()
      const body = (() => {
        try {
          return JSON.parse(raw) as Json
        } catch {
          return {} as Json
        }
      })()
      const user = lastUser(body)
      const system = (Array.isArray(body.system) ? body.system : [{ text: String(body.system ?? "") }])
        .map((block: Json) => String(block.text ?? ""))
        .join("\n")
      const entry: Seen = {
        at: Date.now(),
        path: url.pathname + url.search,
        marker: markerOf(user.text),
        title: system.includes(TITLE),
        size: Buffer.byteLength(raw),
        model: typeof body.model === "string" ? body.model : null,
        authorization: request.headers.get("authorization"),
        os: request.headers.get("x-stainless-os"),
        agent: request.headers.get("user-agent"),
        beta: request.headers.get("anthropic-beta"),
        egress: [...request.headers.keys()].filter((name) => name.startsWith("x-own-")).join(",") || null,
        apiKey: request.headers.get("x-api-key"),
        parent: request.headers.get("x-parent-session-id"),
        speed: typeof body.speed === "string" ? body.speed : null,
        identity: system.includes(IDENTITY),
        billing: system.includes(BILLING),
        image: raw.includes('"type":"image"'),
        toolResult: user.toolResult,
      }
      seen.push(entry)
      const model = entry.model ?? "claude-fake"
      const tool = (pattern: RegExp) =>
        ((Array.isArray(body.tools) ? body.tools : []) as Json[])
          .map((item) => String(item.name))
          .find((name) => pattern.test(name)) ?? "unknown"
      const sse = (stream: ReadableStream<Uint8Array>) =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream", "request-id": `req_rh_${seen.length}`, ...allowed() },
        })
      const text = (value: string) =>
        sse(
          textStream(model, entry.speed, function* () {
            yield value
          }),
        )
      const timed = (options: Omit<Parameters<typeof timedStream>[0], "model" | "signal" | "onAbort" | "onClose">) =>
        sse(
          timedStream({
            ...options,
            model,
            signal: request.signal,
            onAbort: () => aborted.push({ marker: entry.marker, at: Date.now() }),
            onClose: () => closed.push({ marker: entry.marker, at: Date.now() }),
          }),
        )
      const shell = (command: string) =>
        sse(toolUseStream(model, [{ name: tool(/^(mcp_)?(shell|bash)$/i), input: { command } }]))
      if (entry.title) return text("D title")
      switch (entry.marker) {
        case "[D1]":
          return entry.toolResult ? text("d1 done [D1]") : shell(`echo d1-tool-ran >> ${project()}/d1.txt`)
        case "[D3]":
        case "[D6]":
          return timed({ totalMs: 5 * 60_000, finalText: "should have been cancelled" })
        case "[D4-LONG]":
          return timed({
            totalMs: LONG_MS,
            progressMs: PROGRESS_MS,
            finalText: "long stream done [D4-LONG]",
            meter: d4Meter,
          })
        case "[D4-SILENT]":
          return timed({ totalMs: SILENT_MS + 1_000, silentMs: SILENT_MS, finalText: "silence done [D4-SILENT]" })
        case "[D4-IMAGE]":
          return entry.toolResult
            ? text(`image received ${entry.size} bytes [D4-IMAGE]`)
            : sse(toolUseStream(model, [{ name: tool(/^(mcp_)?read$/i), input: { path: `${project()}/big.png` } }]))
        case "[D4-BIG-OUT]":
          return sse(
            textStream(model, null, function* () {
              yield "BIGOUT-START "
              const chunk = "x".repeat(64 * 1024)
              for (let sent = 0; sent < BIG; sent += chunk.length) yield chunk
              yield " BIGOUT-END"
            }),
          )
        case "[D5]":
          return entry.toolResult
            ? timed({ totalMs: Number.POSITIVE_INFINITY, output: "partial d5 output, the tunnel breaks now" })
            : shell(`echo d5-tool-ran >> ${project()}/d5.txt`)
        case "[D8]":
          return entry.authorization === `Bearer ${TOKEN1}`
            ? Response.json(
                { type: "error", error: { type: "authentication_error", message: "token expired (fake)" } },
                { status: 401 },
              )
            : text("d8 recovered [D8]")
        case "[D9]":
          return Response.json(
            { type: "error", error: { type: "authentication_error", message: "invalid bearer (fake)" } },
            { status: 401 },
          )
        case "[D10]": {
          const now = Math.floor(Date.now() / 1000)
          return Response.json(
            {
              type: "error",
              error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." },
            },
            {
              status: 429,
              headers: {
                "retry-after": "3600",
                ...unifiedHeaders({
                  status: "rejected",
                  fiveHourUtilization: 1,
                  sevenDayUtilization: 0.3,
                  fiveHourReset: now + 120,
                  sevenDayReset: now + 4 * 86_400,
                  representativeClaim: "five_hour",
                }),
              },
            },
          )
        }
        case "[D12]":
          return entry.toolResult
            ? text("parent done [D12]")
            : sse(
                toolUseStream(model, [
                  {
                    name: tool(/^(mcp_)?subagent$/i),
                    input: {
                      agent: "general",
                      description: "relay child a",
                      prompt: "[D12-CHILD-A] answer in one line",
                    },
                  },
                  {
                    name: tool(/^(mcp_)?subagent$/i),
                    input: {
                      agent: "general",
                      description: "relay child b",
                      prompt: "[D12-CHILD-B] answer in one line",
                    },
                  },
                ]),
              )
        case "[D12-CHILD-A]":
        case "[D12-CHILD-B]": {
          // The parent's report rounds (upstream #63209) quote the child's answer, so they carry the marker too.
          if (entry.parent === null) return text(`parent noted ${entry.marker}`)
          children.active++
          children.max = Math.max(children.max, children.active)
          return sse(
            timedStream({
              model,
              signal: request.signal,
              totalMs: 8_000,
              pingMs: 1_000,
              finalText: `child done ${entry.marker}`,
              onClose: () => {
                children.active--
              },
            }),
          )
        }
        default:
          return text(`relayed answer ${entry.marker ?? "default"}`)
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, aborted, closed, children, stop: () => server.stop(true) }
}

/**
 * The bundled claude-auth where an install puts it (`dir`): the release's own (02 §8.2, `own-bundle.json` names its pin),
 * else the fake fixture, its "credentials file" read from the fake Claude Code home on every reload (D8) (B12).
 */
function installBundle(dir: string, credentials: string) {
  fs.rmSync(dir, { recursive: true, force: true })
  const release = path.join(Env.APP, "plugins", "claude-auth")
  const record = path.join(release, "own-bundle.json")
  if (fs.existsSync(record)) {
    fs.cpSync(release, dir, { recursive: true })
    const bundle = JSON.parse(fs.readFileSync(record, "utf8")) as Json
    return { kind: "bundle" as const, pin: { version: String(bundle.version), integrity: String(bundle.integrity) } }
  }
  const pin = { version: "0.4.0-fake.rh", integrity: "sha512-b3duLXJlYWwtaG9zdC1mYWtl" }
  writeFakeClaudeAuth(dir, {
    ...pin,
    account: { source: "file", token: TOKEN1 },
    credentialsFile: path.join(credentials, ".credentials.json"),
  })
  return { kind: "fake-fixture" as const, pin }
}

run(`real host ${Env.ALIAS}: the Claude slot through this PC's egress relay (phase D, RG18)`, () => {
  const state = {} as {
    upstream: ReturnType<typeof startUpstream>
    pcSink: Stack.Sink
    stack: Stack.Stack
    bundle: ReturnType<typeof installBundle>
    claudeDir: string
    /** The bundle's patch manifest hash (`own-bundle.json`; the fake fixture's for a release before the bundle). */
    patchSha256?: string
    uid: string
    project: string
    resolved: Json
    model: string
    main: string
    token: string
    outputs: string[]
    bunBefore: string[]
    direct?: ReturnType<typeof Env.forwardProcess>
    /** While set, every remote call goes through this suite's own `-L` (D5: the tunnel is down). */
    directURL?: string
  }
  state.outputs = []

  const local = (method: string, input: unknown = {}) => state.stack.local(OwnAccounts.ID, method, input)
  /** own-remote's log of this PC's release service (`OWN_HOME\logs\own-remote.log`), one record per line. */
  const remoteLog = () => {
    const file = path.join(Env.OWN_HOME, "logs", "own-remote.log")
    if (!fs.existsSync(file)) return [] as Json[]
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Json)
  }
  const host = async () => {
    const listed = await state.stack.local("own.remote", "hosts.list")
    return (listed.hosts as Json[]).find((item) => item.id === state.stack.hostId)!
  }
  const connect = async () => {
    await state.stack.local("own.remote", "connect", { hostId: state.stack.hostId, clientId: CLIENT })
    const view = await Stack.until(
      async () => {
        const current = await host()
        return current.stage === "ready" || current.paused ? current : undefined
      },
      240_000,
      500,
    )
    state.resolved = await state.stack.local("own.remote", "resolve", { hostId: state.stack.hostId })
    return view
  }
  const remote = async (
    method: string,
    route: string,
    options: { body?: unknown; directory?: string; via?: "tunnel" | "direct"; direct?: string } = {},
  ) => {
    const direct = options.direct ?? state.directURL
    const client = Stack.remoteClient({ url: state.resolved.url, token: state.resolved.token, direct })
    const result = await client(method, route, {
      directory: state.project,
      ...(direct ? { via: "direct" as const } : {}),
      ...options,
    })
    state.outputs.push(JSON.stringify(result.body ?? null))
    return result
  }
  const remoteRpc = (method: string, input: unknown, directory: string = state.project) =>
    remote("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, { body: { input }, directory })
  const remoteHealth = async () =>
    (await remoteRpc("health", {}, state.resolved.controlDir)).body?.output as Json | undefined
  const remoteClaude = async () => (await remoteHealth())?.claudeSlot as Json | undefined
  const session = async (title: string, model = state.model) => {
    const created = await remote("POST", "/api/session", {
      // The Claude slot's relay is under test, not a harness: the scripted upstream calls `shell` and `task` as
      // OpenCode 기본 names them, and a new remote session would start on Codex 방식 (own.harness's default).
      body: {
        title,
        model: { providerID: "anthropic", id: model },
        location: { directory: state.project },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value("opencode") },
      },
    })
    if (created.status !== 200) throw new Error(`session: ${created.status} ${JSON.stringify(created.body)}`)
    return created.body.data.id as string
  }
  const prompt = async (sessionID: string, text: string) => {
    const admitted = await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text } })
    if (admitted.status !== 200) throw new Error(`prompt: ${admitted.status} ${JSON.stringify(admitted.body)}`)
  }
  /**
   * Waits until the session is idle; `false` after `timeoutMs` (a stuck turn fails the scenario's own assertions, with
   * its messages in the evidence, instead of the whole run).
   */
  const waitIdle = async (sessionID: string, timeoutMs = 240_000) => {
    const response = await fetch(
      new URL(`/api/experimental/session/${sessionID}/wait`, state.directURL ?? state.resolved.url),
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`opencode:${state.resolved.token}`)}`,
          "x-opencode-directory": encodeURIComponent(state.project),
        },
        signal: AbortSignal.timeout(timeoutMs),
        // Bun's fetch has a 5-minute limit of its own; D4 waits up to 20 minutes.
        timeout: false,
      },
    ).catch(() => undefined)
    if (!response) return false
    await response.text()
    return true
  }
  /**
   * Answers the session's permission requests with `once` until stopped (the D1/D5 shell calls ask in the host's
   * default approval mode); what it answered goes to the evidence.
   */
  const approvals: Json[] = []
  const startApprover = (sessionID: string) => {
    const stopped = { value: false }
    const loop = (async () => {
      while (!stopped.value) {
        const listed = await remote("GET", `/api/session/${sessionID}/permission`).catch(() => undefined)
        for (const request of (listed?.body?.data ?? []) as Json[]) {
          approvals.push({ sessionID, action: request.action, resources: request.resources })
          await remote("POST", `/api/session/${sessionID}/permission/${request.id}/reply`, {
            body: { decision: "once" },
          }).catch(() => undefined)
        }
        await Bun.sleep(500)
      }
    })()
    return async () => {
      stopped.value = true
      await loop
    }
  }
  const messages = async (sessionID: string) =>
    ((await remote("GET", `/api/session/${sessionID}/message`)).body?.data ?? []) as Json[]
  const interrupt = (sessionID: string) => remote("POST", `/api/session/${sessionID}/interrupt`, { body: {} })
  const seenWith = (marker: string, from = 0) =>
    state.upstream.seen.slice(from).filter((item) => item.marker === marker && !item.title)
  const inflightZero = () =>
    Stack.until(async () => ((await host()).broker.claude.inflight === 0 ? true : undefined), 60_000, 500)
  const claudeLines = (lines: ReadonlyArray<string>) =>
    lines.filter((line) => /claude\.ai|anthropic\.com|claude\.com/i.test(line))
  /** The ssh.exe tunnel of the host (a child of this PC's service with -R forwards): its pid and the -R specs. */
  const tunnel = () => {
    const listed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='ssh.exe' AND ParentProcessId=${state.stack.server.pid}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout
    const line = listed
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => / -R /.test(` ${item.split("\t")[1] ?? ""} `))
    if (!line) return undefined
    const [pid, command] = line.split("\t") as [string, string]
    const tokens = command.split(/\s+/)
    const remotes = tokens.flatMap((token, index) =>
      token === "-R" && tokens[index + 1] ? [tokens[index + 1]!.replace(/^"|"$/g, "")] : [],
    )
    return { pid: Number(pid), remotes }
  }
  const egressSocket = () => {
    const spec = tunnel()?.remotes.find((item) => /\/egress-\d+\.sock:/.test(item))
    if (!spec) return undefined
    const socket = spec.slice(0, spec.indexOf(".sock:") + ".sock".length)
    return { socket, epoch: Number(/egress-(\d+)\.sock$/.exec(socket)![1]) }
  }
  /** `claude` processes this suite could have started (children of this PC's service or naming the temp root). */
  const claudeProcesses = () =>
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'claude*' -and ($_.ParentProcessId -eq ${state.stack.server.pid} -or $_.CommandLine -like '*own-real-host*') } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim()
  const hostsFile = () => path.join(Env.OWN_HOME, "remote", "hosts.json")
  const record = () =>
    (JSON.parse(fs.readFileSync(hostsFile(), "utf8")).hosts as Json[]).find((item) => item.id === state.stack.hostId)!
  const patchBroker = (broker: Json) => {
    const file = JSON.parse(fs.readFileSync(hostsFile(), "utf8")) as Json
    for (const item of file.hosts as Json[])
      if (item.id === state.stack.hostId) item.broker = { ...item.broker, ...broker }
    fs.writeFileSync(hostsFile(), JSON.stringify(file, null, 2))
  }
  /**
   * Stops this PC's service, rewrites the host's broker record (and whatever `edit` writes while it is stopped), starts
   * the service again and reconnects.
   */
  const restartWith = async (broker: Json, edit?: () => void) => {
    await state.stack.local("own.remote", "disconnect", { hostId: state.stack.hostId }).catch(() => undefined)
    await state.stack.server.stop()
    patchBroker(broker)
    edit?.()
    await state.stack.restart()
    await Stack.until(async () => (await state.stack.localRaw("own.remote", "hosts.list")).status === 200, 120_000, 500)
    await Stack.until(async () => (await local("plugin.claudeAuth.status")).installed, 60_000, 500)
    return connect()
  }
  const enabledOnHost = () =>
    Stack.until(async () => ((await remoteClaude())?.state === "enabled" ? true : undefined), 120_000, 1_000)
  const writeCredentials = (accessToken: string, dir = state.claudeDir) =>
    fs.writeFileSync(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          refreshToken: REFRESH,
          expiresAt: Date.now() + 8 * 3_600_000,
          scopes: ["user:inference", "user:profile"],
          subscriptionType: "max",
        },
      }),
    )
  /** `curl` on the host: `<status> <x-own-egress-error>` of one request (`target` = `--unix-socket <path>` or a URL base). */
  const curlScript = (lines: ReadonlyArray<string>) => String.raw`set -u
command -v curl >/dev/null 2>&1 || { echo NO_CURL=1; exit 0; }
r() {
  curl -sS --max-time 20 $1 -o /dev/null -D - -X "$2" "$3" -H 'content-type: application/json' ${"$"}{4:+-H "$4"} \
    --data '{"model":"x","max_tokens":1,"messages":[]}' 2>&1 | tr -d '\r' |
    awk 'NR==1{code=$2} tolower($1)=="x-own-egress-error:"{err=$2} END{print code" "err}'
}
${lines.join("\n")}`
  const hygieneScript = () => String.raw`set -u
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
roots="$HOME/.local/share/own-open-code $HOME/.config/own-open-code $HOME/.local/state/own-open-code $HOME/.config/opencode $HOME/.local/state/opencode $HOME/.local/share/opencode $HOME/.cache/opencode"
# A credentials file's key, quoted as JSON writes it: since upstream v2.2 the opencode binary bundles the Claude Agent
# SDK, whose code reads the bare name (RL6).
for needle in ${FAKES.map((value) => `'${value}'`).join(" ")} '"claudeAiOauth"'; do
  c=$(grep -rlaF -- "$needle" $roots /tmp/own-$(id -u)* 2>/dev/null | wc -l)
  e=$(tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -cF -- "$needle")
  a=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -cF -- "$needle")
  p=$(ps -eo args | grep -v grep | grep -cF -- "$needle")
  echo "HITS=$c/$e/$a/$p"
done
echo "MARKER_BILLING=$(grep -rlaF -- 'x-anthropic-billing-header' "$HOME/.local/share/own-open-code/app/current/plugins" 2>/dev/null | wc -l)"
echo "MARKER_SALT=$(grep -rlaF -- '59cf53e54c78' "$HOME/.local/share/own-open-code/app/current/plugins" 2>/dev/null | wc -l)"
echo "PLUGINS=$(ls "$HOME/.local/share/own-open-code/app/current/plugins" | tr '\n' ' ')"
echo "CLAUDE_AUTH_PATHS=$(find "$HOME/.local/share/own-open-code" "$HOME/.local/share/opencode" -iname '*claude-auth*' 2>/dev/null | wc -l)"
echo "CLAUDE_ACCOUNT_FILES=$(ls "$HOME"/.local/share/opencode/claude-* 2>/dev/null | wc -l)"
# Only our service's descendants count: other programs of the user on this host run their own claude -p.
n=0; for c in $(pgrep -f 'claude -p' 2>/dev/null); do q=$c; while [ -n "$q" ] && [ "$q" -gt 1 ]; do [ "$q" = "$pid" ] && { n=$((n+1)); break; }; q=$(ps -o ppid= -p "$q" 2>/dev/null | tr -d ' '); done; done
echo "CLAUDE_P=$n"
echo "SERVICE_TMPDIR=$(tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | sed -n 's/^TMPDIR=//p')"
echo "== /tmp .bun-uid"; ls -A1 /tmp 2>/dev/null | grep -E "^\.bun-$(id -u)-" || echo none`
  const hygiene = async (name: string) => {
    const result = await Env.hostSh(hygieneScript())
    const values = Env.kv(result.stdout)
    const hits = result.stdout.split("\n").filter((line) => line.startsWith("HITS="))
    const health = await remoteHealth()
    const bunNow = Env.section(result.stdout, "== /tmp .bun-uid").filter((line) => line !== "none")
    Env.evidence(`${name}.json`, {
      hits,
      values: Object.fromEntries(values),
      conflict: health?.claudeSlot,
      bunBefore: state.bunBefore,
      bunNow,
    })
    expect(hits).toEqual([...FAKES, "claudeAiOauth"].map(() => "HITS=0/0/0/0"))
    expect(values.get("MARKER_BILLING")).toBe("0")
    expect(values.get("MARKER_SALT")).toBe("0")
    expect(values.get("PLUGINS")!.trim().split(" ").sort()).toEqual([
      "own-accounts",
      "own-creator",
      "own-harness",
      "own-omo",
      "own-remote",
      "own-team",
      "own-telemetry",
    ])
    expect(values.get("CLAUDE_AUTH_PATHS")).toBe("0")
    expect(values.get("CLAUDE_ACCOUNT_FILES")).toBe("0")
    expect(values.get("CLAUDE_P")).toBe("0")
    expect(values.get("SERVICE_TMPDIR")).toMatch(/\/own-open-code\/tmp$/)
    // No `anthropic` connection or claude-auth in the host's Location: no conflict (04 §8.11.5).
    expect(health?.claudeSlot?.conflict).toBe(false)
    for (const output of state.outputs) for (const value of FAKES) expect(output).not.toContain(value)
    return { bunNow }
  }

  beforeAll(async () => {
    state.uid = Env.kv((await Env.hostSh("echo UID=$(id -u)")).stdout).get("UID")!
    state.project = `/tmp/own-${state.uid}-rh-claude`
    state.upstream = startUpstream(() => state.project)
    state.pcSink = await Stack.startSink(await Env.freeLocalPort(40_000, 49_999))
    // The FAKE Claude Code home of this PC's service (B12): every path the plugin may read or write is in the temp root.
    const fakeHome = path.join(Env.ROOT, "fake-home")
    state.claudeDir = path.join(Env.ROOT, "fake-claude")
    const lockDir = path.join(Env.ROOT, "fake-claude-lock")
    for (const dir of [fakeHome, state.claudeDir, lockDir]) {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
    }
    state.token = TOKEN1
    writeCredentials(TOKEN1)
    // No `claude` CLI for the plugin's fallback: PATH without any folder that has one.
    const cleanPath = (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(
        (dir) =>
          dir &&
          !["claude.exe", "claude.cmd", "claude.ps1", "claude.bat", "claude"].some((name) =>
            fs.existsSync(path.join(dir, name)),
          ),
      )
      .join(path.delimiter)
    const where = spawnSync("where.exe", ["claude"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PATH: cleanPath },
    })
    expect(where.stdout.trim()).toBe("")
    const bundle = path.join(Env.OWN_HOME, "app", Env.VERSION, "plugins", "claude-auth")
    state.bundle = installBundle(bundle, state.claudeDir)
    Env.evidence("d-setup.json", { bundle: state.bundle, whereClaude: where.status })
    // Account 1's folder is the FAKE Claude Code home, as `계정 소스` names it: the patched plugin signs with the folders
    // of own's account list only.
    fs.writeFileSync(
      path.join(Env.OWN_HOME, "claude-auth.json"),
      JSON.stringify({ configDir: state.claudeDir, setAt: new Date().toISOString() }),
    )
    // The release templates where an install puts them (`app\<version>\templates`: the rate card seed).
    fs.cpSync(path.join(Env.APP, "templates"), path.join(Env.OWN_HOME, "app", Env.VERSION, "templates"), {
      recursive: true,
    })
    state.stack = await Stack.startStack({
      claude: { bundle, upstream: state.upstream.url },
      env: {
        USERPROFILE: fakeHome,
        CLAUDE_CONFIG_DIR: state.claudeDir,
        OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR: lockDir,
        // https only: own-remote's tunnel endpoints are plain http on 127.0.k.2, which NO_PROXY cannot list as a range.
        HTTPS_PROXY: `http://127.0.0.1:${state.pcSink.port}`,
        https_proxy: `http://127.0.0.1:${state.pcSink.port}`,
        NO_PROXY: "127.0.0.1,localhost,::1",
        no_proxy: "127.0.0.1,localhost,::1",
        PATH: cleanPath,
      },
    })
    // The host project, with a 4 MiB PNG of noise (no compression gain) for D4.
    const made = await Env.hostSh(String.raw`set -u
umask 077; rm -rf "${state.project}"; mkdir -p "${state.project}" && printf '# real-host claude project\n' > "${state.project}/README.md"
python3 - "${state.project}/big.png" <<'PY'
import os, struct, sys, zlib
w, h = 1200, 1166
raw = b"".join(b"\x00" + os.urandom(w * 3) for _ in range(h))
def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 0)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY
echo "PNG=$(stat -c %s "${state.project}/big.png")"; echo OK=1`)
    expect(Env.kv(made.stdout).get("OK")).toBe("1")
    expect(Number(Env.kv(made.stdout).get("PNG"))).toBeGreaterThan(4 * 1024 * 1024)
    const before = fs.readFileSync(path.join(Env.EVIDENCE, "before.txt"), "utf8")
    state.bunBefore = Env.section(before, "== /tmp .bun-uid").filter((line) => line !== "none")

    // The PC's slot: the bundle loaded (no consent, 02 §8.2), Claude Code's (fake) login imported, the remote notice
    // accepted with the bundle's pin, the host switched on.
    const slot = await Stack.until(
      async () => {
        const status = await local("plugin.claudeAuth.status")
        return status.installed ? status : undefined
      },
      120_000,
      500,
    )
    state.patchSha256 = (slot.patch?.sha256 as string | null) ?? undefined
    Env.evidence("d-slot.json", { patch: slot.patch, warnings: slot.warnings })
    const imported =
      state.bundle.kind === "bundle"
        ? // The bundled plugin's own exports load in the background since upstream v2.4.0 (#63814): until they did, the
          // import answers plugin_not_installed although the status already names the plugin.
          await Stack.until(
            async () => {
              const result = await state.stack.localRaw(OwnAccounts.ID, "plugin.claudeAuth.importSubscription", {})
              if (result.status === 200) return result.body.output
              if (JSON.stringify(result.body).includes("plugin_not_installed")) return undefined
              throw new Error(`importSubscription: ${result.status} ${JSON.stringify(result.body)}`)
            },
            120_000,
            500,
          )
        : await state.stack.server
            .request("POST", "/api/credential", {
              body: {
                integrationID: "anthropic",
                label: "Claude Max · real-host@example.test",
                value: {
                  type: "oauth",
                  methodID: "claude-code",
                  refresh: "fake-refresh",
                  access: "fake-access",
                  expires: 0,
                },
              },
            })
            .then((response) => ({ ok: response.status === 200 }))
    Env.evidence("d-import.json", { imported, pcSink: state.pcSink.lines })
    expect(imported.ok).toBe(true)
    await local("plugin.claudeAuth.remote.ack", { ...state.bundle.pin, noticeHash: Notice.REMOTE_HASH })
    expect(await local("plugin.claudeAuth.remote.set", { hostId: state.stack.hostId, enabled: true })).toEqual({
      hostId: state.stack.hostId,
      enabled: true,
      state: "enabled",
    })
    const view = await connect()
    expect(view.stage).toBe("ready")
    await enabledOnHost()
    const models = await Stack.until(
      async () => {
        const listed = await remote("GET", "/api/model")
        const list = ((listed.body?.data ?? []) as Json[]).filter((model) => model.providerID === "anthropic")
        return list.length > 0 ? list : undefined
      },
      120_000,
      1_000,
    )
    state.model = models.some((model) => model.id === PREFERRED_MODEL) ? PREFERRED_MODEL : models[0]!.id
    const egress = egressSocket()
    const stat = egress
      ? await Env.hostSh(
          `stat -c 'TYPE=%F' "${egress.socket}"; stat -c 'MODE=%a' "${egress.socket}"; stat -c 'DIR=%a' "$(dirname "${egress.socket}")"`,
        )
      : undefined
    Env.evidence("d-connect.json", {
      remotes: tunnel()?.remotes,
      egress,
      stat: stat?.stdout,
      claude: (await host()).broker.claude,
      model: state.model,
    })
    expect(tunnel()?.remotes).toHaveLength(2)
    expect(Env.kv(stat!.stdout).get("TYPE")).toBe("socket")
    expect(Env.kv(stat!.stdout).get("MODE")).toBe("600")
    expect(Env.kv(stat!.stdout).get("DIR")).toBe("700")
    state.main = await session("relay main")
  }, 900_000)

  afterAll(async () => {
    Env.evidence(
      "d-upstream.json",
      (state.upstream?.seen ?? []).map((item) => ({
        ...item,
        authorization: [TOKEN1, TOKEN2, TOKEN3].reduce(
          (value, token, index) => (value === `Bearer ${token}` ? `Bearer <fake token${index + 1}>` : value),
          item.authorization,
        ),
      })),
    )
    Env.evidence("d-upstream-closed.json", {
      aborted: state.upstream?.aborted ?? [],
      closed: state.upstream?.closed ?? [],
      children: state.upstream?.children,
    })
    Env.evidence("d-pc-sink.txt", state.pcSink?.lines.join("\n") ?? "")
    state.direct?.stop()
    if (state.stack) {
      Env.evidence("d-host-sink.txt", state.stack.sink.lines.join("\n"))
      await state.stack.local("own.remote", "disconnect", { hostId: state.stack.hostId }).catch(() => undefined)
      fs.writeFileSync(path.join(Env.EVIDENCE, "d-local-server.log"), state.stack.server.logs())
      await state.stack.stop()
    }
    state.pcSink?.close()
    state.upstream?.stop()
  }, 120_000)

  test("D1: two steps with a tool call on the host; every step signed on the PC; nothing on either sink", async () => {
    const from = state.upstream.seen.length
    const sinks = { pc: state.pcSink.lines.length, host: state.stack.sink.lines.length }
    const stopApprover = startApprover(state.main)
    await prompt(state.main, "[D1] run the tool, then answer")
    const idle = await waitIdle(state.main, 180_000)
    await stopApprover()
    const list = await messages(state.main)
    if (!idle)
      Env.evidence("d1-stuck.json", { list: list.slice(0, 6), seen: state.upstream.seen.slice(from), approvals })
    expect(idle).toBe(true)
    const steps = seenWith("[D1]", from)
    const file = await Env.hostSh(
      `cat "${state.project}/d1.txt" 2>/dev/null; echo "LINES=$(wc -l < "${state.project}/d1.txt" 2>/dev/null)"`,
    )
    const ledger = await Stack.until(
      async () => {
        const result = await local("ledger.session", { sessionID: state.main, server: state.stack.hostId })
        return (result.steps as Json[]).length >= 2 ? (result.steps as Json[]) : undefined
      },
      60_000,
      1_000,
    )
    Env.evidence("d1-two-steps.json", {
      approvals,
      steps: steps.map((item) => ({ ...item, authorization: item.authorization === `Bearer ${state.token}` })),
      tool: file.stdout,
      ledger,
      pcSink: state.pcSink.lines.slice(sinks.pc),
      hostSink: state.stack.sink.lines.slice(sinks.host),
    })
    expect(steps).toHaveLength(2)
    expect(steps.map((item) => item.toolResult)).toEqual([false, true])
    for (const step of steps) {
      expect(step.path).toBe("/v1/messages?beta=true")
      expect(step.authorization).toBe(`Bearer ${state.token}`)
      expect(step.os).toBe("win32")
      expect(step.agent).toStartWith("claude-cli/")
      expect(step.identity).toBe(true)
      if (state.bundle.kind === "bundle") expect(step.billing).toBe(true)
      expect(step.egress).toBeNull()
      expect(step.apiKey).toBeNull()
    }
    expect(Env.kv(file.stdout).get("LINES")).toBe("1")
    expect(JSON.stringify(list)).toContain("d1 done [D1]")
    expect(JSON.stringify(list)).toContain('"shell"')
    expect(ledger.every((line) => line.accountID === "acc_claude_slot" && line.server === state.stack.hostId)).toBe(
      true,
    )
    expect(state.pcSink.lines.slice(sinks.pc)).toEqual([])
    expect(state.stack.sink.lines.slice(sinks.host)).toEqual([])
  }, 300_000)

  test("D2: hygiene: no fake token or credential JSON on the host, no anthropic connection there, no claude-auth marker", async () => {
    await hygiene("d2-hygiene")
  }, 180_000)

  test("D3: a 5-minute stream cancelled after 10 s: the upstream sees the close within 5 s; nothing in flight on the PC", async () => {
    const sessionID = await session("relay cancel")
    const aborted = state.upstream.aborted.length
    const from = state.upstream.seen.length
    await prompt(sessionID, "[D3] a long answer")
    await Stack.until(() => seenWith("[D3]", from).length > 0, 60_000, 250)
    await Bun.sleep(10_000)
    const at = Date.now()
    expect((await interrupt(sessionID)).status).toBe(200)
    const closed = await Stack.until(() => state.upstream.aborted[aborted], 20_000, 100)
    await inflightZero()
    Env.evidence("d3-cancel.json", { closeMs: closed.at - at })
    expect(closed.at - at).toBeLessThan(5_000)
  }, 180_000)

  test(
    "D4: a long stream (6 or 20 min) with 15 s pings, 4 min 30 s of silence and a 5 MiB body with an image all complete",
    async () => {
      const long = await session("relay 20 minutes")
      const silent = await session("relay silence")
      const image = await session("relay image")
      const big = await session("relay big answer")
      const from = state.upstream.seen.length
      const before = await host()
      const logLines = remoteLog().length
      const started = Date.now()
      /** Polls (no request held open for 20 minutes) until the session has `count` idle marks and the newest is one. */
      const untilIdle = (sessionID: string, count: number, timeoutMs: number) =>
        Stack.until(
          async () => {
            const list = await messages(sessionID)
            return list[0]?.type === "idle" && list.filter((message) => message.type === "idle").length >= count
              ? true
              : undefined
          },
          timeoutMs,
          5_000,
        )
      await prompt(long, "[D4-LONG] stream for a long while")
      await prompt(silent, "[D4-SILENT] stay silent for a while")
      await prompt(big, "[D4-BIG-OUT] send the long answer")
      const done: Record<string, number> = {}
      await Promise.all([
        untilIdle(long, 1, LONG_MS + 600_000).then(() => (done.long = Date.now() - started)),
        untilIdle(silent, 1, 900_000).then(() => (done.silent = Date.now() - started)),
        untilIdle(big, 1, 600_000).then(async () => {
          done.big = Date.now() - started
          // The image goes into the conversation that holds the 4 MiB answer: one request of more than 5 MiB with it.
          await prompt(image, "[D4-BIG-OUT] send the long answer")
          await untilIdle(image, 1, 600_000)
          await prompt(image, "[D4-IMAGE] look at big.png")
          await untilIdle(image, 2, 600_000)
          done.image = Date.now() - started
        }),
      ])
      const lists = {
        long: await messages(long),
        silent: await messages(silent),
        image: await messages(image),
        big: await messages(big),
      }
      const uploads = seenWith("[D4-IMAGE]", from)
      const bigText = JSON.stringify(lists.big)
      const after = await host()
      // The tunnel's own record of the stream: no reconnect (the same epoch, no tunnel end in own-remote's log) and no
      // broker spool gap, while ssh's keepalive (every 4 s) ran under 15 s pings and 4 min 30 s of model silence.
      const tunnelEnds = remoteLog()
        .slice(logLines)
        .filter((line) => line.msg === "tunnel_ended" || line.msg === "link_silent")
      Env.evidence("d4-long.json", {
        doneMs: done,
        longMs: LONG_MS,
        longStream: d4Meter,
        epoch: { before: before.epoch, after: after.epoch },
        brokerGaps: { before: (before.broker as Json).gaps, after: (after.broker as Json).gaps },
        tunnelEnds,
        longAttempts: seenWith("[D4-LONG]", from).length,
        image: uploads.map((item) => ({ size: item.size, image: item.image, toolResult: item.toolResult })),
        bigAnswer: { start: bigText.indexOf("BIGOUT-START"), end: bigText.indexOf("BIGOUT-END") },
        last: Object.fromEntries(Object.entries(lists).map(([name, list]) => [name, list[0]])),
      })
      expect(JSON.stringify(lists.long)).toContain("long stream done [D4-LONG]")
      // One attempt: the stream's output progress keeps P-018 from cutting it and retrying.
      expect(seenWith("[D4-LONG]", from)).toHaveLength(1)
      expect(done.long).toBeGreaterThanOrEqual(LONG_MS)
      expect(JSON.stringify(lists.silent)).toContain("silence done [D4-SILENT]")
      expect(done.silent).toBeGreaterThanOrEqual(SILENT_MS)
      const withImage = uploads.find((item) => item.toolResult && item.image)
      expect(withImage).toBeDefined()
      expect(withImage!.size).toBeGreaterThanOrEqual(5 * 1024 * 1024)
      expect(JSON.stringify(lists.image)).toContain("image received")
      expect(bigText.indexOf("BIGOUT-END") - bigText.indexOf("BIGOUT-START")).toBeGreaterThanOrEqual(BIG)
      expect(after.epoch).toBe(before.epoch)
      expect(tunnelEnds).toEqual([])
    },
    LONG_MS + 900_000,
  )

  test("D5: ssh.exe killed mid-stream: upstream closed, the started step fails without a second tool run; a turn in the break never reaches the upstream; new epoch after", async () => {
    const sessionID = await session("relay tunnel break")
    const old = await host()
    // This suite's own -L to the remote service (like a TUI on the host): it stays up while the tunnel is broken.
    const localPort = await Env.freeLocalPort(40_000, 49_999)
    state.direct = Env.forwardProcess(["-L", `127.0.0.1:${localPort}:127.0.0.1:${record().remotePort}`])
    const direct = `http://127.0.0.1:${localPort}`
    await Stack.until(
      async () =>
        (
          await fetch(`${direct}/api/info`, {
            headers: { authorization: `Basic ${btoa(`opencode:${state.resolved.token}`)}` },
          }).catch(() => undefined)
        )?.ok,
      30_000,
      500,
    )
    const aborted = state.upstream.aborted.length
    const from = state.upstream.seen.length
    const stopApprover = startApprover(sessionID)
    await prompt(sessionID, "[D5] run the tool, then stream")
    await Stack.until(() => seenWith("[D5]", from).some((item) => item.toolResult), 120_000, 250)
    await stopApprover()
    await Bun.sleep(2_000)
    const forwards = tunnel()
    expect(forwards).toBeDefined()
    const killed = Date.now()
    spawnSync("taskkill", ["/PID", String(forwards!.pid), "/F"], { windowsHide: true })
    // Keep the host away from this PC for the break (no automatic reconnect).
    await state.stack.local("own.remote", "disconnect", { hostId: state.stack.hostId }).catch(() => undefined)
    state.directURL = direct
    const closed = await Stack.until(() => state.upstream.aborted[aborted], 90_000, 250)
    // The step whose output had started is recorded as failed with its partial output (core may then try a
    // continuation step, which waits for the broker like any request in the break).
    const failed = await Stack.until(
      async () => {
        const list = await messages(sessionID)
        const step = list.find(
          (message) =>
            message.type === "assistant" && JSON.stringify(message.content ?? []).includes("partial d5 output"),
        )
        return step?.finish === "error" ? list : undefined
      },
      90_000,
      1_000,
    )
    // A turn during the break: the host has no relay, its request never reaches the upstream.
    const during = await session("relay during the break")
    const duringFrom = state.upstream.seen.length
    await prompt(during, "[D5-DURING] while the tunnel is down")
    await Bun.sleep(15_000)
    const duringUpstream = seenWith("[D5-DURING]", duringFrom).length
    await interrupt(during)
    await interrupt(sessionID)
    const shellRuns = (await messages(sessionID))
      .flatMap((message) => (Array.isArray(message.content) ? (message.content as Json[]) : []))
      .filter((part) => part.type === "tool" && part.name === "shell").length
    state.directURL = undefined
    state.direct.stop()
    state.direct = undefined
    const view = await connect()
    await enabledOnHost()
    const sockets = await Env.hostSh(
      `ls -1 "$(dirname "${egressSocket()!.socket}")" | grep -E '^egress-.*\\.sock$' || true`,
    )
    const tool = await Env.hostSh(`echo "LINES=$(wc -l < "${state.project}/d5.txt" 2>/dev/null)"`)
    const next = state.upstream.seen.length
    await prompt(state.main, "[D5-AFTER] after the reconnect")
    await waitIdle(state.main)
    Env.evidence("d5-tunnel-break.json", {
      abortMs: closed.at - killed,
      failed: failed.slice(0, 4),
      shellRuns,
      duringUpstream,
      oldEpoch: old.epoch,
      newEpoch: view.epoch,
      sockets: sockets.stdout,
      tool: tool.stdout,
      after: seenWith("[D5-AFTER]", next).length,
    })
    expect(closed.at - killed).toBeLessThan(60_000)
    expect(shellRuns).toBe(1)
    expect(seenWith("[D5]", from).filter((item) => item.toolResult)).toHaveLength(1)
    expect(Env.kv(tool.stdout).get("LINES")).toBe("1")
    expect(duringUpstream).toBe(0)
    expect(view.epoch).toBeGreaterThan(old.epoch)
    expect(sockets.stdout.trim().split(/\s+/)).toEqual([`egress-${view.epoch}.sock`])
    expect(seenWith("[D5-AFTER]", next)).toHaveLength(1)
  }, 600_000)

  test("D6: switched off on the PC: the stream in flight ends, the next request is refused at once; scope only → host_scope", async () => {
    const sessionID = await session("relay switch off")
    const aborted = state.upstream.aborted.length
    const from = state.upstream.seen.length
    await prompt(sessionID, "[D6] a long answer")
    await Stack.until(() => seenWith("[D6]", from).length > 0, 60_000, 250)
    await Bun.sleep(2_000)
    const at = Date.now()
    expect(await local("plugin.claudeAuth.remote.set", { hostId: state.stack.hostId, enabled: false })).toMatchObject({
      state: "off",
    })
    const closed = await Stack.until(() => state.upstream.aborted[aborted], 20_000, 100)
    await Stack.until(async () => ((await remoteClaude())?.state === "off" ? true : undefined), 60_000, 500)
    await interrupt(sessionID)
    const next = state.upstream.seen.length
    const started = Date.now()
    await prompt(state.main, "[D6-AFTER] after the switch-off")
    await waitIdle(state.main)
    const refusedMs = Date.now() - started
    const off = await messages(state.main)
    // On again, then an `only` scope without the Claude slot: host_scope.
    await local("plugin.claudeAuth.remote.set", { hostId: state.stack.hostId, enabled: true })
    await enabledOnHost()
    const others = ((await local("accounts.list")).accounts as Json[])
      .filter((account) => account.id !== "acc_claude_slot")
      .map((account) => account.id)
    await state.stack.local("own.remote", "hosts.update", {
      hostId: state.stack.hostId,
      accounts: { mode: "only", ids: others.slice(0, 1) },
    })
    try {
      const scoped = await Stack.until(
        async () => ((await remoteClaude())?.state === "host_scope" ? (await host()).broker.claude : undefined),
        120_000,
        1_000,
      )
      const scopedSession = state.main
      const scopeFrom = state.upstream.seen.length
      await prompt(scopedSession, "[D6-SCOPE] outside the scope")
      await waitIdle(scopedSession)
      const scopedList = await messages(scopedSession)
      Env.evidence("d6-off.json", {
        abortMs: closed.at - at,
        refusedMs,
        off: off.slice(0, 3),
        scoped,
        scopedList: scopedList.slice(0, 3),
        upstreamAfterOff: state.upstream.seen.length - next,
      })
      expect(closed.at - at).toBeLessThan(15_000)
      expect(seenWith("[D6-AFTER]", next)).toHaveLength(0)
      expect(off[0]).toMatchObject({ type: "idle", outcome: "failed" })
      expect(refusedMs).toBeLessThan(30_000)
      expect(scoped.state).toBe("host_scope")
      expect(seenWith("[D6-SCOPE]", scopeFrom)).toHaveLength(0)
      expect(scopedList[0]).toMatchObject({ type: "idle", outcome: "failed" })
    } finally {
      await state.stack.local("own.remote", "hosts.update", { hostId: state.stack.hostId, accounts: { mode: "all" } })
      await enabledOnHost()
    }
    const back = state.upstream.seen.length
    await prompt(state.main, "[D6-BACK] in scope again")
    await waitIdle(state.main)
    expect(seenWith("[D6-BACK]", back)).toHaveLength(1)
  }, 600_000)

  test("D7: same-uid requests to the egress socket (no MAC, random MAC) and to the stub port: all 401, upstream 0, broker up", async () => {
    const egress = egressSocket()!
    const from = state.upstream.seen.length
    const random = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
    const probe = await Env.hostSh(
      curlScript([
        `s="--unix-socket ${egress.socket}"`,
        `echo "NONE=$(r "$s" POST 'http://localhost/v1/messages?beta=true')"`,
        `echo "RANDOM=$(r "$s" POST 'http://localhost/v1/messages?beta=true' 'x-own-egress: v1.${egress.epoch}.${Math.floor(Math.random() * 1e6) + 5000}.${random}')"`,
        `echo "EPOCH=$(r "$s" POST 'http://localhost/v1/messages?beta=true' 'x-own-egress: v1.${egress.epoch + 1000}.8.${random}')"`,
        `echo "PATH404=$(r "$s" POST 'http://localhost/v1/complete')"`,
        // The stub: a loopback listener of the remote service other than its API port; a request without MAC reaches the PC.
        String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)`,
        String.raw`api=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)`,
        String.raw`for port in $(ss -Htlnp 2>/dev/null | grep "pid=$pid," | awk '{print $4}' | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p'); do`,
        `  [ "$port" = "$api" ] && continue`,
        `  echo "STUB_$port=$(r "" POST "http://127.0.0.1:$port/v1/messages?beta=true")"`,
        `done`,
      ]),
    )
    const result = Env.kv(probe.stdout)
    const stubs = [...result.entries()].filter(([key]) => key.startsWith("STUB_"))
    const afterProbe = state.upstream.seen.length
    const view = await host()
    await prompt(state.main, "[D7-AFTER] after the probes")
    await waitIdle(state.main)
    Env.evidence("d7-mac.json", { probe: probe.stdout, stderr: probe.stderr, broker: view.broker })
    expect(result.get("NO_CURL")).toBeUndefined()
    expect(result.get("NONE")).toBe("401 mac")
    expect(result.get("RANDOM")).toBe("401 mac")
    expect(result.get("EPOCH")).toBe("401 mac")
    expect(result.get("PATH404")).toBe("404 bad_request")
    expect(stubs.some(([, value]) => value === "401 mac")).toBe(true)
    expect(afterProbe).toBe(from)
    expect(view.broker.state).toBe("connected")
    expect(seenWith("[D7-AFTER]", afterProbe)).toHaveLength(1)
  }, 300_000)

  test("D8: one 401 while the credentials file already holds token2: the plugin adopts it and succeeds; no refresh, no claude process", async () => {
    // The plugin keeps what it read for 30 s from the read that filled its cache (CREDENTIAL_CACHE_TTL_MS), not from
    // the last use. Whether D8's first call still carried token1 depended on how long D5-D7 took (2.4.1-own.2: about
    // 31 s, so the plugin read token2 at once). Let any earlier fill go stale, fill it again with token1, then change
    // the file.
    await Bun.sleep(31_000)
    const warm = await session("relay cache warm-up")
    await prompt(warm, "[D8-WARM] token1 into the plugin's cache")
    await waitIdle(warm)
    expect(seenWith("[D8-WARM]").map((item) => item.authorization)).toEqual([`Bearer ${TOKEN1}`])
    writeCredentials(TOKEN2)
    const sessionID = await session("relay 401 once")
    const from = state.upstream.seen.length
    const pcSink = state.pcSink.lines.length
    await prompt(sessionID, "[D8] the token changed meanwhile")
    await waitIdle(sessionID)
    const list = await messages(sessionID)
    const calls = seenWith("[D8]", from)
    const processes = claudeProcesses()
    Env.evidence("d8-401-once.json", {
      calls: calls.map((item) =>
        item.authorization === `Bearer ${TOKEN1}`
          ? "token1"
          : item.authorization === `Bearer ${TOKEN2}`
            ? "token2"
            : "other",
      ),
      pcSink: state.pcSink.lines.slice(pcSink),
      processes,
      last: list[0],
    })
    expect(calls.map((item) => item.authorization)).toEqual([`Bearer ${TOKEN1}`, `Bearer ${TOKEN2}`])
    expect(JSON.stringify(list)).toContain("d8 recovered [D8]")
    expect(claudeLines(state.pcSink.lines.slice(pcSink))).toEqual([])
    expect(processes).toBe("")
    state.token = TOKEN2
  }, 300_000)

  test("D9: 401 every time: needs_reauth for 60 s; at most one forced refresh on the PC sink, none from the host", async () => {
    const failing = await session("relay 401")
    const from = state.upstream.seen.length
    const sinks = { pc: state.pcSink.lines.length, host: state.stack.sink.lines.length }
    await prompt(failing, "[D9] this login is refused")
    await waitIdle(failing)
    const held = await host()
    const holdSession = await session("relay during the hold")
    const during = state.upstream.seen.length
    await prompt(holdSession, "[D9-HOLD] while held")
    await waitIdle(holdSession)
    const lists = { failed: await messages(failing), held: await messages(holdSession) }
    const refreshes = claudeLines(state.pcSink.lines.slice(sinks.pc))
    Env.evidence("d9-401.json", {
      upstream401: seenWith("[D9]", from).length,
      upstreamDuringHold: seenWith("[D9-HOLD]", during).length,
      claude: held.broker.claude,
      pcSink: state.pcSink.lines.slice(sinks.pc),
      hostSink: state.stack.sink.lines.slice(sinks.host),
      processes: claudeProcesses(),
      failed: lists.failed[0],
      refused: lists.held[0],
    })
    expect(lists.failed[0]).toMatchObject({ type: "idle", outcome: "failed" })
    expect(held.broker.claude.lastError).toBe("needs_reauth")
    expect(held.broker.claude.holdUntil).toBeGreaterThan(Date.now())
    expect(seenWith("[D9-HOLD]", during)).toHaveLength(0)
    expect(lists.held[0]).toMatchObject({ type: "idle", outcome: "failed" })
    expect(refreshes.length).toBeLessThanOrEqual(1)
    expect(claudeLines(state.stack.sink.lines.slice(sinks.host))).toEqual([])
    await Bun.sleep(Math.max(0, held.broker.claude.holdUntil - Date.now()) + 2_000)
    const later = state.upstream.seen.length
    await prompt(state.main, "[D9-AFTER] the hold is over")
    await waitIdle(state.main)
    expect(seenWith("[D9-AFTER]", later)).toHaveLength(1)
    expect((await host()).broker.claude.holdUntil).toBeNull()
  }, 400_000)

  test("D10: 429 with unified 5h rejected and retry-after 3600: the turn stops at once; claude.5h exhausted (origin = host); ledger and exhaustion event on the PC", async () => {
    const sessionID = await session("relay 429")
    const from = state.upstream.seen.length
    const started = Date.now()
    await prompt(sessionID, "[D10] over the limit")
    await waitIdle(sessionID)
    const tookMs = Date.now() - started
    const list = await messages(sessionID)
    const snapshot = await local("quota.snapshot", {})
    const windows = (snapshot.windows as Json[]).filter((window) => window.origin === state.stack.hostId)
    const steps = (await local("ledger.session", { sessionID: state.main, server: state.stack.hostId })).steps as Json[]
    const events = await Stack.until(
      () => {
        const found = ledgerFiles(Env.OWN_HOME)
          .flatMap((file) => fs.readFileSync(file, "utf8").split(/\r?\n/))
          .filter((line) => /exhaust/i.test(line) && line.includes(state.stack.hostId))
        return found.length > 0 ? found : undefined
      },
      60_000,
      1_000,
    ).catch(() => [] as string[])
    Env.evidence("d10-429.json", {
      upstream: seenWith("[D10]", from).length,
      tookMs,
      last: list[0],
      windows,
      exhausted: snapshot.exhausted,
      events,
    })
    expect(seenWith("[D10]", from)).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: "idle", outcome: "failed" })
    expect(tookMs).toBeLessThan(60_000)
    expect(windows.find((window) => window.id === "claude.5h")).toMatchObject({
      status: "exhausted",
      accountID: "acc_claude_slot",
    })
    expect(steps.some((line) => line.accountID === "acc_claude_slot" && line.server === state.stack.hostId)).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  }, 300_000)

  test("D11: Fast: without the PC's consent recordOn local; with it the relayed request carries speed and the fast beta", async () => {
    const candidates = ((await remote("GET", "/api/model")).body?.data as Json[])
      .filter((model) => model.providerID === "anthropic")
      .toSorted((a, b) => Number(/opus/.test(b.id)) - Number(/opus/.test(a.id)))
      .slice(0, 12)
    const found = await (async () => {
      for (const model of candidates) {
        const sessionID = await session(`relay fast ${model.id}`, model.id)
        const view = (await remoteRpc("session.speed.get", { sessionID })).body?.output as Json | undefined
        if ((view?.offers ?? []).some((offer: Json) => offer.choice === "fast"))
          return { sessionID, model: model.id, view }
      }
      return undefined
    })()
    expect(found).toBeDefined()
    const refused = await remoteRpc("session.speed.set", { sessionID: found!.sessionID, speed: "fast" })
    await local("plugin.claudeAuth.fastAck")
    const set = await Stack.until(
      async () => {
        const result = await remoteRpc("session.speed.set", { sessionID: found!.sessionID, speed: "fast" })
        return result.status === 200 ? result.body.output : undefined
      },
      30_000,
      1_000,
    )
    const from = state.upstream.seen.length
    await prompt(found!.sessionID, "[D11] quickly please")
    await waitIdle(found!.sessionID)
    const call = seenWith("[D11]", from)[0]
    Env.evidence("d11-fast.json", {
      model: found!.model,
      refused: refused.body,
      set,
      call: call && { speed: call.speed, beta: call.beta, model: call.model },
    })
    expect(refused.body).toMatchObject({ type: "speed_consent_required", data: { recordOn: "local" } })
    expect(set).toMatchObject({ view: { choice: "fast" } })
    expect(call?.speed).toBe("fast")
    expect(call?.beta ?? "").toContain("fast-mode-2026-02-01")
  }, 300_000)

  test("D12: a Claude main with two Claude subagents at once: both streams go through the relay concurrently and finish", async () => {
    const sessionID = await session("relay two subagents")
    const from = state.upstream.seen.length
    await prompt(sessionID, "[D12] delegate to two subagents")
    await waitIdle(sessionID, 400_000)
    // Subagents run in the background since upstream v2.3.0 (#63382): their answers reach the parent later, as reports.
    const reported = async () => {
      const text = JSON.stringify(await messages(sessionID))
      return text.includes("child done [D12-CHILD-A]") && text.includes("child done [D12-CHILD-B]")
    }
    const deadline = Date.now() + 300_000
    while (!(await reported()) && Date.now() < deadline) await Bun.sleep(1000)
    await waitIdle(sessionID, 400_000)
    const marked = [...seenWith("[D12-CHILD-A]", from), ...seenWith("[D12-CHILD-B]", from)]
    // Requests without a parent header are the parent's report rounds, not the children.
    const children = marked.filter((item) => item.parent !== null)
    const list = await messages(sessionID)
    Env.evidence("d12-subagents.json", {
      children: children.map((item) => ({
        marker: item.marker,
        parent: item.parent,
        at: item.at,
        signed: item.authorization === `Bearer ${state.token}`,
      })),
      reportRounds: marked.length - children.length,
      maxConcurrent: state.upstream.children.max,
      last: list[0],
    })
    expect(children.map((item) => item.marker).sort()).toEqual(["[D12-CHILD-A]", "[D12-CHILD-B]"])
    for (const child of children) {
      expect(child.parent).toBe(sessionID)
      expect(child.authorization).toBe(`Bearer ${state.token}`)
    }
    expect(state.upstream.children.max).toBe(2)
    expect(JSON.stringify(list)).toContain("parent done [D12]")
    expect(JSON.stringify(list)).toContain("child done [D12-CHILD-A]")
    expect(JSON.stringify(list)).toContain("child done [D12-CHILD-B]")
  }, 900_000)

  test("D13: TCP mode: the egress runs on egressTcpPort, the relay works there and the MAC is enforced", async () => {
    try {
      const view = await restartWith({ mode: "tcp", tcpPort: null, egressTcpPort: null })
      expect(view.stage).toBe("ready")
      const broker = record().broker as Json
      const forwards = tunnel()
      await enabledOnHost()
      const listening = await Env.hostSh(
        `ss -Htln | awk '{print $4}' | grep -E ':(${broker.tcpPort}|${broker.egressTcpPort})$' | sort`,
      )
      const probe = await Env.hostSh(
        curlScript([`echo "TCP_NONE=$(r "" POST 'http://127.0.0.1:${broker.egressTcpPort}/v1/messages?beta=true')"`]),
      )
      const from = state.upstream.seen.length
      await prompt(state.main, "[D13] over tcp")
      await waitIdle(state.main)
      Env.evidence("d13-tcp.json", {
        broker,
        remotes: forwards?.remotes,
        listening: listening.stdout,
        probe: probe.stdout,
      })
      expect(broker.mode).toBe("tcp")
      expect(typeof broker.egressTcpPort).toBe("number")
      expect(broker.egressTcpPort).not.toBe(broker.tcpPort)
      expect(forwards?.remotes).toEqual([
        expect.stringMatching(new RegExp(`^127\\.0\\.0\\.1:${broker.tcpPort}:127\\.0\\.0\\.1:\\d+$`)),
        expect.stringMatching(new RegExp(`^127\\.0\\.0\\.1:${broker.egressTcpPort}:127\\.0\\.0\\.1:\\d+$`)),
      ])
      expect(listening.stdout.trim().split(/\s+/).sort()).toEqual(
        [`127.0.0.1:${broker.tcpPort}`, `127.0.0.1:${broker.egressTcpPort}`].sort(),
      )
      expect(Env.kv(probe.stdout).get("TCP_NONE")).toBe("401 mac")
      expect(seenWith("[D13]", from)).toHaveLength(1)
    } finally {
      // Back to the socket mode (a rerun of the suite starts from it).
      await restartWith({ mode: "socket", tcpPort: null, egressTcpPort: null })
      await enabledOnHost()
    }
  }, 600_000)

  test("D14: two Claude accounts (proof v2): the patched plugin signs a host conversation on the second account with that account only; account 1 keeps its own; forged or v1 proofs 401", async () => {
    expect(state.bundle.kind).toBe("bundle")
    expect(state.patchSha256).toBeDefined()
    // The bundle is patched at build time (02 §8.2): nothing to apply. A second FAKE Claude Code login, registered the
    // way `Claude 계정 추가` leaves it (`accounts.json`, written while the service is stopped); account 1's folder stays
    // the one `claude-auth.json` names (the patched plugin reads own's account list, not CLAUDE_CONFIG_DIR).
    const before = await local("plugin.claudeAuth.status")
    const secondDir = path.join(Env.ROOT, "fake-claude-2")
    fs.rmSync(secondDir, { recursive: true, force: true })
    fs.mkdirSync(secondDir, { recursive: true })
    writeCredentials(TOKEN3, secondDir)
    const view = await restartWith({}, () => {
      fs.writeFileSync(
        path.join(Env.OWN_HOME, "claude-auth.json"),
        JSON.stringify({ configDir: state.claudeDir, setAt: new Date().toISOString() }),
      )
      const registry = JSON.parse(fs.readFileSync(path.join(Env.OWN_HOME, "accounts.json"), "utf8")) as Json
      registry.claudeAccounts = [
        {
          accountID: SECOND,
          key: path.resolve(secondDir).toLowerCase(),
          configDir: secondDir,
          label: "둘째",
          shortLabel: "C2",
          color: "amber",
          managed: false,
          addedAt: new Date().toISOString(),
        },
      ]
      fs.writeFileSync(path.join(Env.OWN_HOME, "accounts.json"), JSON.stringify(registry, null, 2))
    })
    expect(view.stage).toBe("ready")
    const patched = await Stack.until(
      async () => {
        const status = await local("plugin.claudeAuth.status")
        return status.patch?.state === "patched" && status.patch?.loaded === true ? status : undefined
      },
      120_000,
      1_000,
    )
    const listFile = path.join(Env.OWN_HOME, "thirdparty", "claude-auth", "claude-accounts.json")
    const list = await Stack.until(
      async () => {
        const parsed = fs.existsSync(listFile) ? (JSON.parse(fs.readFileSync(listFile, "utf8")) as Json) : undefined
        return parsed && (parsed.accounts as Json[]).length === 2 ? parsed : undefined
      },
      60_000,
      1_000,
    )
    const claudeViews = ((await local("accounts.list")).accounts as Json[]).filter((item) => item.kind === "claude-sub")
    await enabledOnHost()

    // The proof covers the account: a v2 proof naming the second account with a forged MAC and a v1 proof are refused.
    const egress = egressSocket()!
    const forged = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
    const beforeProbe = state.upstream.seen.length
    const probe = await Env.hostSh(
      curlScript([
        `s="--unix-socket ${egress.socket}"`,
        `echo "V2_FORGED=$(r "$s" POST 'http://localhost/v1/messages?beta=true' 'x-own-egress: v2.${egress.epoch}.${Math.floor(Math.random() * 1e6) + 7000}.${SECOND}.${forged}')"`,
        `echo "V1=$(r "$s" POST 'http://localhost/v1/messages?beta=true' 'x-own-egress: v1.${egress.epoch}.${Math.floor(Math.random() * 1e6) + 9000}.${forged}')"`,
      ]),
    )
    const afterProbe = state.upstream.seen.length

    // Conversations: a new one on the default (account 1), one bound to the second account on the host, and the main.
    const one = await session("relay account one")
    const two = await session("relay account two")
    const bound = await Stack.until(
      async () => {
        const result = await remoteRpc("plugin.claudeAuth.session.set", { sessionID: two, accountID: SECOND })
        return result.status === 200 ? (result.body.output as Json) : undefined
      },
      120_000,
      1_000,
    )
    const from = state.upstream.seen.length
    await prompt(one, "[D14-ONE] on the first account")
    await waitIdle(one)
    await prompt(two, "[D14-TWO] on the second account")
    await waitIdle(two)
    await prompt(state.main, "[D14-MAIN] the main conversation keeps its account")
    await waitIdle(state.main)
    const accountOf = async (sessionID: string) =>
      ((await remoteRpc("plugin.claudeAuth.session.get", { sessionID })).body?.output as Json | undefined)?.accountID
    const bindings = { one: await accountOf(one), two: await accountOf(two), main: await accountOf(state.main) }
    const calls = {
      one: seenWith("[D14-ONE]", from),
      two: seenWith("[D14-TWO]", from),
      main: seenWith("[D14-MAIN]", from),
    }
    const ledger = (sessionID: string) =>
      Stack.until(
        async () => {
          const steps = (await local("ledger.session", { sessionID, server: state.stack.hostId })).steps as Json[]
          return steps.length > 0 ? steps : undefined
        },
        60_000,
        1_000,
      )
    const steps = { one: await ledger(one), two: await ledger(two) }
    const windows = ((await local("quota.snapshot", {})).windows as Json[]).filter(
      (window) => window.origin === state.stack.hostId,
    )
    const signed = (items: ReadonlyArray<Seen>) =>
      items.map((item) => {
        const index = [TOKEN1, TOKEN2, TOKEN3].findIndex((token) => item.authorization === `Bearer ${token}`)
        return index < 0 ? "other" : `token${index + 1}`
      })
    Env.evidence("d14-accounts.json", {
      before: before.patch,
      patched: { patch: patched.patch, warnings: patched.warnings, bundle: patched.bundle },
      listFile: {
        accounts: (list.accounts as Json[]).length,
        defaultIsAccount1: list.default === path.resolve(state.claudeDir).toLowerCase(),
      },
      views: claudeViews.map((item) => ({
        id: item.id,
        status: item.status,
        default: item.claude?.default,
        loaded: item.claude?.loaded,
      })),
      probe: probe.stdout,
      upstreamDuringProbe: afterProbe - beforeProbe,
      bound,
      bindings,
      signedBy: { one: signed(calls.one), two: signed(calls.two), main: signed(calls.main) },
      calls: Object.fromEntries(
        Object.entries(calls).map(([key, items]) => [
          key,
          items.map((item) => ({
            os: item.os,
            identity: item.identity,
            billing: item.billing,
            egress: item.egress,
            apiKey: item.apiKey,
          })),
        ]),
      ),
      ledger: { one: steps.one.map((line) => line.accountID), two: steps.two.map((line) => line.accountID) },
      windows: windows.map((window) => ({ id: window.id, accountID: window.accountID, status: window.status })),
    })
    expect(before.patch).toMatchObject({ state: "patched", loaded: true })
    expect(patched.patch).toMatchObject({ state: "patched", loaded: true, sha256: state.patchSha256! })
    expect(patched.bundle).toMatchObject(state.bundle.pin)
    expect((list.accounts as Json[]).map((item) => item.key).sort()).toEqual(
      [path.resolve(state.claudeDir).toLowerCase(), path.resolve(secondDir).toLowerCase()].sort(),
    )
    expect(claudeViews.map((item) => item.id).sort()).toEqual(["acc_claude_slot", SECOND].sort())
    expect(claudeViews.every((item) => item.claude?.loaded === true)).toBe(true)
    expect(Env.kv(probe.stdout).get("NO_CURL")).toBeUndefined()
    expect(Env.kv(probe.stdout).get("V2_FORGED")).toBe("401 mac")
    expect(Env.kv(probe.stdout).get("V1")).toBe("401 mac")
    expect(afterProbe).toBe(beforeProbe)
    expect(bound.accountID).toBe(SECOND)
    expect(bindings).toEqual({ one: "acc_claude_slot", two: SECOND, main: "acc_claude_slot" })
    expect(calls.one.map((item) => item.authorization)).toEqual([`Bearer ${state.token}`])
    expect(calls.two.map((item) => item.authorization)).toEqual([`Bearer ${TOKEN3}`])
    expect(calls.main.map((item) => item.authorization)).toEqual([`Bearer ${state.token}`])
    for (const item of [...calls.one, ...calls.two, ...calls.main])
      expect(item).toMatchObject({ os: "win32", identity: true, billing: true, egress: null, apiKey: null })
    expect(steps.one.every((line) => line.accountID === "acc_claude_slot" && line.server === state.stack.hostId)).toBe(
      true,
    )
    expect(steps.two.every((line) => line.accountID === SECOND && line.server === state.stack.hostId)).toBe(true)
    expect(windows.some((window) => window.accountID === SECOND)).toBe(true)
  }, 900_000)

  test("D2 again at the end: hygiene after every scenario, and no new /tmp/.bun-<uid>-* since the before listing", async () => {
    const result = await hygiene("d2-hygiene-end")
    // TMPDIR=<OWN_HOME>/tmp for every own Bun run: nothing new under /tmp.
    expect(result.bunNow.filter((entry) => !state.bunBefore.includes(entry))).toEqual([])
    for (const value of FAKES) expect(state.stack.server.logs()).not.toContain(value)
  }, 180_000)
})

/** `*.jsonl` files under the PC's OWN_HOME (the events ledger among them). */
function ledgerFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) return entry.name === "thirdparty" ? [] : ledgerFiles(file)
    return entry.name.endsWith(".jsonl") ? [file] : []
  })
}
