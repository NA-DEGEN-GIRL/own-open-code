import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { SessionRetry, SessionWebSocketHandshake } from "@opencode/plugin/promise/session"
import { Modules } from "../../src/modules.js"
import {
  CODEX,
  DEFAULT_SEEDS,
  DS,
  OTHER_SESSION,
  SESSION,
  fakeLogins,
  fakePlugins,
  fakeSlots,
  httpEvent,
  ok,
  registry,
  retryEvent,
  setup,
  step,
  wsEvent,
} from "./support.js"

// P0-3a (02 §7.8): the opt-in wire evidence capture. Every credential here is fake.

type Setup = Awaited<ReturnType<typeof setup>>

/** Without the DeepSeek balance poll: windows move the clock past its tick and must not reach a real endpoint. */
const offline = () => setup({ registry: registry(DEFAULT_SEEDS.map((seed) => ({ ...seed, pollBalance: false }))) })

/** A response that counts its clones: the capture must not clone anything while no window runs. */
class Counted extends Response {
  clones = 0
  override clone() {
    this.clones += 1
    return super.clone()
  }
}

const LIMIT_HEADERS = {
  "content-type": "application/json",
  "x-codex-primary-used-percent": "100",
  "x-should-retry": "false",
  "retry-after": "120",
  "set-cookie": "session=fake-cookie-value",
  "x-request-id": "req_fake_1",
  "openai-processing-ms": "12",
}

const EXHAUSTED = {
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached. Your key sk-fake0123456789abcdefghij is fine.",
    plan_type: "plus",
    resets_in_seconds: 3600,
  },
}

interface Line {
  readonly [key: string]: unknown
  readonly event: string
}

async function lines(
  t: Setup,
  status: { readonly window: { readonly dir: string; readonly files: ReadonlyArray<string> } | null },
) {
  const window = status.window
  if (!window) return []
  const texts = await Promise.all(
    window.files
      .filter((file) => !file.endsWith("windows.jsonl"))
      .map((file) => fs.readFile(path.join(window.dir, ...file.split("/")), "utf8")),
  )
  return texts.flatMap((text) =>
    text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Line),
  )
}

async function summary(status: {
  readonly window: { readonly dir: string; readonly files: ReadonlyArray<string> } | null
}) {
  const window = status.window
  const file = window?.files.find((name) => name.endsWith("windows.jsonl"))
  if (!window || !file) return undefined
  const text = await fs.readFile(path.join(window.dir, ...file.split("/")), "utf8")
  return JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
}

function captureAlerts(t: Setup) {
  return t
    .emitted("alert")
    .filter((item) => item.data.code === "capture_empty")
    .map((item) => [item.data.severity, item.data.origin])
}

function sse(events: ReadonlyArray<Readonly<Record<string, unknown>>>) {
  return events.map((item) => `event: ${String(item.type)}\ndata: ${JSON.stringify(item)}\n\n`).join("")
}

describe("off by default", () => {
  test("no window: no clone, no file, an inactive status", async () => {
    await using t = await offline()
    const response = new Counted(JSON.stringify(EXHAUSTED), { status: 429, headers: LIMIT_HEADERS })
    t.telemetry.capture.onHttpResponse(httpEvent({ providerID: CODEX, response }))
    t.telemetry.capture.onWsReceive(wsEvent({ providerID: CODEX, frame: '{"type":"codex.rate_limits"}' }))
    await t.telemetry.flush()
    expect(response.clones).toBe(0)
    expect(await ok(t.telemetry.capture.status, {})).toEqual({ active: false, window: null })
    expect(await fs.readdir(path.join(t.home, "diagnostics")).catch(() => "missing")).toBe("missing")
  })
})

describe("shape mode", () => {
  test("an error response: every header name, limit values, the body's shape, tags; no credential anywhere", async () => {
    await using t = await offline()
    const started = await ok(t.telemetry.capture.start, { mode: "shape", minutes: 10 })
    expect(started.active).toBe(true)
    expect(started.window?.id).toMatch(/^cap_[0-9A-Z]{26}$/)
    t.telemetry.capture.onHttpResponse(
      httpEvent({
        providerID: CODEX,
        kind: "compaction",
        response: new Response(JSON.stringify(EXHAUSTED), { status: 429, headers: LIMIT_HEADERS }),
      }),
    )
    await t.telemetry.flush()
    const stopped = await ok(t.telemetry.capture.stop, {})
    expect(stopped.active).toBe(false)
    expect(stopped.window).toMatchObject({ end: "stopped", records: 1, dropped: 0, mode: "shape" })
    expect(stopped.window?.files).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}\/ses_telemetry_test_1\.jsonl$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}\/windows\.jsonl$/),
    ])
    const [line] = await lines(t, stopped)
    expect(line).toMatchObject({
      v: 1,
      capture: stopped.window?.id,
      event: "response",
      sessionID: SESSION,
      providerID: CODEX,
      accountKind: "codex",
      kind: "compaction",
      transport: "http",
      status: 429,
      url: "http://fake.local/v1/responses",
      names: [
        "content-type",
        "openai-processing-ms",
        "retry-after",
        "set-cookie",
        "x-codex-primary-used-percent",
        "x-request-id",
        "x-should-retry",
      ],
      authHash8: expect.stringMatching(/^[0-9a-f]{8}$/),
      body: {
        json: true,
        shape: {
          error: { type: "usage_limit_reached", message: "<str:79>", plan_type: "plus", resets_in_seconds: "<num>" },
        },
      },
    })
    expect(line.values).toEqual({
      "x-codex-primary-used-percent": "100",
      "x-should-retry": "false",
      "retry-after": "120",
      "x-request-id": "req_fake_1",
    })
    const files = await Promise.all(
      (stopped.window?.files ?? []).map((file) => fs.readFile(path.join(stopped.window?.dir ?? "", file), "utf8")),
    )
    for (const secret of ["fake-access-token", "fake-cookie-value", "sk-fake0123456789abcdefghij"])
      expect(files.join("\n")).not.toContain(secret)
  })

  test("an event stream: types counted, usage numbers kept, echoed instructions dropped", async () => {
    await using t = await offline()
    await ok(t.telemetry.capture.start, { mode: "shape" })
    const body = sse([
      { type: "response.created", response: { status: "in_progress", instructions: "secret system prompt" } },
      { type: "response.output_text.delta", delta: "hel" },
      { type: "response.output_text.delta", delta: "lo" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          instructions: "secret system prompt",
          usage: { input_tokens: 2_048, input_tokens_details: { cached_tokens: 1_024 }, output_tokens: 2 },
        },
      },
    ])
    t.telemetry.capture.onHttpResponse(
      httpEvent({
        providerID: CODEX,
        response: new Response(`${body}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream", "x-codex-primary-used-percent": "3" },
        }),
      }),
    )
    await t.telemetry.flush()
    const stopped = await ok(t.telemetry.capture.stop, {})
    const all = await lines(t, stopped)
    expect(all.map((line) => line.event)).toEqual(["response", "stream"])
    const stream = all[1]
    expect(stream).toMatchObject({
      complete: true,
      events: 4,
      types: { "response.created": 1, "response.output_text.delta": 2, "response.completed": 1 },
    })
    const shapes = stream.shapes as ReadonlyArray<Record<string, unknown>>
    // The second delta has the first one's structure; the completed event is written every time.
    expect(shapes.map((item) => item.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ])
    expect(shapes[2].shape).toEqual({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 2_048, input_tokens_details: { cached_tokens: 1_024 }, output_tokens: 2 },
      },
    })
    expect(JSON.stringify(all)).not.toContain("secret system prompt")
  })

  test("WebSocket: handshake header names, each frame structure once, watched frames every time, counts in the summary", async () => {
    await using t = await offline()
    await ok(t.telemetry.capture.start, { mode: "shape" })
    const handshake = {
      sessionID: SESSION,
      agent: "build",
      model: { providerID: CODEX, id: "gpt-5.5" },
      kind: "primary",
      url: "wss://fake.local/backend-api/codex/responses?token=fake-query-secret",
      headers: { authorization: "Bearer fake-access-token", "chatgpt-account-id": "acct-fake", "openai-beta": "x" },
    } as unknown as SessionWebSocketHandshake
    t.telemetry.capture.onWsHandshake(handshake)
    const limits = (percent: number) =>
      JSON.stringify({
        type: "codex.rate_limits",
        rate_limits: { primary: { used_percent: percent, window_minutes: 300 } },
      })
    for (const frame of [
      limits(10),
      '{"type":"response.output_text.delta","delta":"a"}',
      '{"type":"response.output_text.delta","delta":"bcd"}',
      '{"type":"response.output_text.delta","delta":"e"}',
      limits(11),
      JSON.stringify({ type: "error", status: 429, ...EXHAUSTED }),
      "not json at all",
    ])
      t.telemetry.capture.onWsReceive(wsEvent({ providerID: CODEX, frame }))
    await t.telemetry.flush()
    const stopped = await ok(t.telemetry.capture.stop, {})
    const all = await lines(t, stopped)
    expect(all[0]).toMatchObject({
      event: "handshake",
      transport: "ws",
      url: "wss://fake.local/backend-api/codex/responses",
      names: ["authorization", "chatgpt-account-id", "openai-beta"],
    })
    const frames = all.filter((line) => line.event === "frame")
    expect(frames.map((line) => line.type)).toEqual([
      "codex.rate_limits",
      "response.output_text.delta",
      "codex.rate_limits",
      "error",
    ])
    expect(frames[2].shape).toEqual({
      type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 11, window_minutes: 300 } },
    })
    expect(frames[3].shape).toMatchObject({ type: "error", status: 429, error: { type: "usage_limit_reached" } })
    const counts = (await summary(stopped))?.counts as ReadonlyArray<Record<string, unknown>>
    expect(counts).toEqual(
      expect.arrayContaining([
        { providerID: CODEX, kind: "primary", transport: "ws", type: "response.output_text.delta", count: 3 },
        { providerID: CODEX, kind: "primary", transport: "ws", type: "codex.rate_limits", count: 2 },
        { providerID: CODEX, kind: "primary", transport: "ws", type: "<not-json>", count: 1 },
      ]),
    )
    expect(JSON.stringify(all)).not.toContain("fake-query-secret")
  })

  test("retry lines carry the error type, status, verdict and decision, never the message", async () => {
    await using t = await offline()
    await ok(t.telemetry.capture.start, { mode: "shape" })
    const message = "quota exceeded for sk-fake-key"
    const event: SessionRetry = retryEvent({ providerID: DS, status: 429, message })
    event.decision = { retry: false }
    t.telemetry.capture.onRetry(event, { class: "hard" })
    await t.telemetry.flush()
    const [line] = await lines(t, await ok(t.telemetry.capture.stop, {}))
    expect(line).toMatchObject({
      event: "retry",
      providerID: DS,
      accountKind: "ds",
      kind: null,
      transport: null,
      attempt: 2,
      error: { type: "provider.rate-limit", status: 429, message: `<str:${message.length}>` },
      verdict: "hard",
      decision: "stop",
    })
  })
})

describe("hash mode", () => {
  test("keeps names, statuses and hashes but no shape and no header value", async () => {
    await using t = await offline()
    await ok(t.telemetry.capture.start, { mode: "hash" })
    t.telemetry.capture.onHttpResponse(
      httpEvent({
        providerID: CODEX,
        response: new Response(JSON.stringify(EXHAUSTED), { status: 429, headers: LIMIT_HEADERS }),
      }),
    )
    // The error line waits for the body read; a frame line is written at once.
    await t.telemetry.flush()
    t.telemetry.capture.onWsReceive(
      wsEvent({ providerID: CODEX, frame: '{"type":"codex.rate_limits","rate_limits":{}}' }),
    )
    await t.telemetry.flush()
    const all = await lines(t, await ok(t.telemetry.capture.stop, {}))
    expect(all.map((line) => line.event)).toEqual(["response", "frame"])
    expect(all[0].values).toBeUndefined()
    expect(all[0].body).toEqual({
      json: true,
      chars: expect.any(Number),
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    expect(all[0].names).toContain("x-should-retry")
    expect(all[1]).toMatchObject({ type: "codex.rate_limits", hash: expect.any(String) })
    expect(all[1].shape).toBeUndefined()
  })
})

describe("filters", () => {
  test("only the window's session and slots, and never a provider that is not an own slot", async () => {
    await using t = await offline()
    await ok(t.telemetry.capture.start, { mode: "hash", sessionID: SESSION, providerIDs: [CODEX] })
    const frame = '{"type":"codex.rate_limits"}'
    t.telemetry.capture.onWsReceive(wsEvent({ providerID: CODEX, frame }))
    t.telemetry.capture.onWsReceive(wsEvent({ providerID: CODEX, frame, sessionID: OTHER_SESSION }))
    t.telemetry.capture.onWsReceive(wsEvent({ providerID: DS, frame }))
    t.telemetry.capture.onWsReceive(wsEvent({ providerID: "openai", frame }))
    await t.telemetry.flush()
    const stopped = await ok(t.telemetry.capture.stop, {})
    expect(stopped.window).toMatchObject({ records: 1, sessionID: SESSION, providerIDs: [CODEX] })
  })

  test("a window started in the control instance records the hooks of another Location's instance", async () => {
    await using t = await offline()
    const other = Modules.create(t.deps, {
      slots: fakeSlots(registry(DEFAULT_SEEDS.map((seed) => ({ ...seed, pollBalance: false })))),
      logins: fakeLogins({ unauthorized: [], headers: [], rejected: [] }),
      plugins: fakePlugins(false),
    })
    await other.slots.start()
    await ok(t.telemetry.capture.start, { mode: "hash" })
    other.telemetry.capture.onWsReceive(wsEvent({ providerID: CODEX, frame: '{"type":"codex.rate_limits"}' }))
    await other.telemetry.flush()
    expect((await ok(t.telemetry.capture.status, {})).window?.records).toBe(1)
    // Stopping the other instance leaves the window running: it belongs to the instance that started it.
    await other.telemetry.stop()
    expect((await ok(t.telemetry.capture.status, {})).active).toBe(true)
  })
})

describe("window end", () => {
  test("capture_empty: info when nothing ran, warning when own-slot steps ran unseen", async () => {
    await using t = await offline()
    await ok(t.telemetry.capture.start, { mode: "hash" })
    await ok(t.telemetry.capture.stop, {})
    expect(captureAlerts(t)).toEqual([["info", "global"]])

    const started = await ok(t.telemetry.capture.start, { mode: "shape" })
    const directory = t.deps.location.directory
    for (const item of step({
      providerID: CODEX,
      messageID: "msg_capture_1",
      at: t.clock.now(),
      directory,
      usage: { input: 1_000 },
    }))
      await t.telemetry.onEvent?.(item, { local: true })
    await t.telemetry.flush()
    const stopped = await ok(t.telemetry.capture.stop, {})
    expect(stopped.window).toMatchObject({ id: started.window?.id, steps: 1, records: 0 })
    expect(captureAlerts(t)).toEqual([
      ["info", "global"],
      ["warning", "global"],
    ])
  })

  test("a window ends by itself after its minutes; a new start replaces a running one", async () => {
    await using t = await offline()
    const first = await ok(t.telemetry.capture.start, { mode: "hash", minutes: 5 })
    const second = await ok(t.telemetry.capture.start, { mode: "hash", minutes: 1 })
    expect(second.window?.id).not.toBe(first.window?.id)
    t.clock.advance(60_000)
    await t.telemetry.flush()
    const status = await ok(t.telemetry.capture.status, {})
    expect(status).toMatchObject({ active: false, window: { id: second.window?.id, end: "expired" } })
    // Both ended empty: one replaced, one expired.
    expect(captureAlerts(t)).toHaveLength(2)
    const windows = await summary(status)
    expect(windows).toMatchObject({ id: second.window?.id, end: "expired", records: 0 })
  })

  test("starts that overlap end the window before them: each window gets its end and its summary", async () => {
    await using t = await offline()
    const started = await Promise.all([
      ok(t.telemetry.capture.start, { mode: "hash" }),
      ok(t.telemetry.capture.start, { mode: "hash" }),
    ])
    const ids = started.map((status) => status.window?.id ?? "")
    expect(new Set(ids).size).toBe(2)
    const running = await ok(t.telemetry.capture.status, {})
    expect(running.active).toBe(true)
    expect(ids).toContain(running.window?.id ?? "none")
    const stopped = await ok(t.telemetry.capture.stop, {})
    const window = stopped.window
    const file = window?.files.find((name) => name.endsWith("windows.jsonl"))
    if (!window || !file) throw new Error("no summary file")
    const text = await fs.readFile(path.join(window.dir, ...file.split("/")), "utf8")
    const ends = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; end: string })
    expect(ends.map((item) => item.end)).toEqual(["replaced", "stopped"])
    expect(new Set(ends.map((item) => item.id))).toEqual(new Set(ids))
    expect(captureAlerts(t)).toHaveLength(2)
  })

  test("the instance that started a window ends it as shutdown when it closes, without an alert", async () => {
    await using t = await offline()
    const other = Modules.create(t.deps, {
      slots: fakeSlots(registry(DEFAULT_SEEDS.map((seed) => ({ ...seed, pollBalance: false })))),
      logins: fakeLogins({ unauthorized: [], headers: [], rejected: [] }),
      plugins: fakePlugins(false),
    })
    await ok(t.telemetry.capture.start, { mode: "hash" })
    // The plugin cleanup of the starting instance (telemetry `stop` calls it; a second close is a no-op).
    await t.telemetry.capture.close()
    expect(await ok(other.telemetry.capture.status, {})).toMatchObject({ active: false, window: { end: "shutdown" } })
    expect(captureAlerts(t)).toEqual([])
    await other.telemetry.stop()
  })
})

describe("files", () => {
  test("folders older than 7 days go when a window starts", async () => {
    await using t = await offline()
    const dir = path.join(t.home, "diagnostics", "captures")
    // The manual clock starts on 2026-09-27: 2026-09-20 is the oldest day kept.
    for (const name of ["2026-09-19", "2026-09-20", "notes"]) await fs.mkdir(path.join(dir, name), { recursive: true })
    await ok(t.telemetry.capture.start, { mode: "hash" })
    expect((await fs.readdir(dir)).sort()).toEqual(["2026-09-20", "notes"])
  })

  test.skipIf(process.platform === "win32")("files and folders are owner-only", async () => {
    await using t = await offline()
    await ok(t.telemetry.capture.start, { mode: "hash" })
    t.telemetry.capture.onWsReceive(wsEvent({ providerID: CODEX, frame: '{"type":"codex.rate_limits"}' }))
    await t.telemetry.flush()
    const stopped = await ok(t.telemetry.capture.stop, {})
    const file = path.join(stopped.window?.dir ?? "", ...(stopped.window?.files[0] ?? "").split("/"))
    expect((await fs.stat(file)).mode & 0o077).toBe(0)
    expect((await fs.stat(path.dirname(file))).mode & 0o077).toBe(0)
  })
})
