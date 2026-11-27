// Telemetry against the e2e-kit fake Codex backend (real HTTP/SSE responses with `x-codex-*` headers, real WebSocket
// `codex.rate_limits` frames): the fake's limit headers reach `quota.snapshot`, the usage it reports becomes one
// ledger line per step with cache fields, and an exhausted window classifies as hard. The step events are built from
// the usage the fake streamed, as core would. Fake credentials only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { StreamUsage } from "../../src/telemetry/stream.js"
import { manualClock, startFakeCodex, type ChatGPTTokens, type FakeCodex } from "../e2e-kit"
import { CODEX, CODEX_ACCOUNT, SESSION, httpEvent, ok, retryEvent, setup, step, wsEvent } from "./support.js"

const ACCOUNT = "acct-telemetry-e2e"
const PROMPT = Array.from(
  { length: 40 },
  (_, index) => `line ${index}: the quick brown fox jumps over the lazy dog`,
).join("\n")

describe("telemetry with the fake Codex backend", () => {
  const state: { codex?: FakeCodex; tokens?: ChatGPTTokens } = {}

  beforeAll(() => {
    // Same start as the test deps' manual clock, so resets are in the future for both.
    state.codex = startFakeCodex({
      clock: manualClock(Date.UTC(2026, 8, 27, 3, 0, 0)),
      cache: { minTokens: 0, blockTokens: 32 },
    })
    state.tokens = state.codex.login({ accountID: ACCOUNT })
  })

  afterAll(async () => {
    await state.codex?.stop()
  })

  const request = (input: string) => {
    const codex = state.codex
    const tokens = state.tokens
    if (!codex || !tokens) throw new Error("fake not started")
    return fetch(`${codex.baseURL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "chatgpt-account-id": tokens.accountID,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        instructions: "You are a test.",
        input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
        stream: true,
      }),
    })
  }

  test("HTTP headers → quota.snapshot; streamed usage → one ledger line per step with cache fields", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const usages = []
    for (const index of [1, 2]) {
      const response = await request(PROMPT)
      expect(response.status).toBe(200)
      const hook = httpEvent({ providerID: CODEX, response })
      await t.telemetry.onHttpResponse(hook)
      // "Core" reads the original body; its usage becomes the step event.
      const usage = await StreamUsage.read(hook.response)
      if (!usage) throw new Error("no usage in the fake stream")
      usages.push(usage)
      for (const item of step({
        providerID: CODEX,
        messageID: `msg_${index}`,
        at: t.clock.now() + index * 1_000,
        directory,
        usage: { input: usage.input, read: usage.cacheRead, write: usage.cacheWrite, output: usage.output },
      }))
        await t.telemetry.onEvent?.(item, { local: true })
    }
    await t.telemetry.flush()

    const usage = state.codex?.usage(ACCOUNT)
    const windows = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).windows
    expect(windows.map((window) => [window.id, window.source])).toEqual([
      ["codex.primary", "header"],
      ["codex.secondary", "header"],
      ["codex.credits", "header"],
    ])
    expect(windows[0]).toMatchObject({ usedPercent: usage?.primary, windowMinutes: 300, label: "5시간", status: "ok" })
    expect(windows[0].resetAt).toBe(Math.floor((usage?.primaryResetAt ?? 0) / 1000) * 1000)
    expect(windows[1]).toMatchObject({ usedPercent: usage?.secondary, windowMinutes: 10_080, label: "주간" })

    const session = await ok(t.telemetry.ledgerSession, { sessionID: SESSION })
    expect(session.steps).toHaveLength(2)
    expect(session.steps.map((line) => line.messageID)).toEqual(["msg_1", "msg_2"])
    for (const [index, line] of session.steps.entries())
      expect(line).toMatchObject({
        kind: "primary",
        providerID: CODEX,
        accountID: CODEX_ACCOUNT,
        tokens: { input: usages[index].input, cacheRead: usages[index].cacheRead, cacheWrite: 0 },
        P: usages[index].input + usages[index].cacheRead,
      })
    // Same prompt twice: the fake cache hits on the second request.
    expect(session.steps[0].tokens?.cacheRead).toBe(0)
    expect(session.steps[1].tokens?.cacheRead).toBeGreaterThan(0)
    expect(session.steps[1].hit).toBeGreaterThan(0.5)
    expect(session.totals.byAccount[CODEX_ACCOUNT]?.requests).toBe(2)
  })

  test("WebSocket codex.rate_limits frames → windows; exhausted window → hard retry verdict", async () => {
    await using t = await setup()
    const codex = state.codex
    const tokens = state.tokens
    if (!codex || !tokens) throw new Error("fake not started")
    // The fake charges one point before it sends the frame.
    codex.setUsage(ACCOUNT, { primary: 98 })
    const frames = await websocketTurn(codex, tokens)
    for (const frame of frames) t.telemetry.onWsReceive(wsEvent({ providerID: CODEX, frame }))
    const primary = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).windows.find(
      (window) => window.id === "codex.primary",
    )
    expect(primary).toMatchObject({ usedPercent: 99, status: "warning", source: "ws_event" })

    // Next HTTP request: 429 usage_limit_reached with `x-codex-rate-limit-reached-type`.
    codex.setUsage(ACCOUNT, { primary: 100 })
    const response = await request("again")
    expect(response.status).toBe(429)
    await t.telemetry.onHttpResponse(httpEvent({ providerID: CODEX, response }))
    const exhausted = (await ok(t.telemetry.quotaSnapshot, { accountIDs: [CODEX_ACCOUNT] })).windows.find(
      (window) => window.id === "codex.primary",
    )
    expect(exhausted).toMatchObject({ usedPercent: 100, status: "exhausted", source: "error" })
    const retry = retryEvent({ providerID: CODEX, status: 429, message: "The usage limit has been reached" })
    const verdict = await t.telemetry.onRetry(retry)
    expect(verdict).toMatchObject({ class: "hard", accountID: CODEX_ACCOUNT })
    expect(retry.decision).toEqual({ retry: false })
    expect(verdict.until).toBeGreaterThan((exhausted?.resetAt ?? 0) + 59_000)
  })
})

/** One `response.create` over the fake's WebSocket; returns every frame received until the turn completes. */
async function websocketTurn(codex: FakeCodex, tokens: ChatGPTTokens) {
  const socket = new WebSocket(codex.websocketURL, {
    headers: { authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": tokens.accountID },
  } as unknown as string[])
  const frames: string[] = []
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          type: "response.create",
          model: "gpt-5.5",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        }),
      ),
    )
    socket.addEventListener("message", (message) => {
      const frame = String(message.data)
      frames.push(frame)
      if (frame.includes('"response.completed"') || frame.includes('"type":"error"')) resolve()
    })
    socket.addEventListener("error", () => reject(new Error("websocket failed")))
  })
  socket.close()
  return frames
}
