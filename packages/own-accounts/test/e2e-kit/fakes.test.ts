import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodexSource } from "@own/runtime"
import { startFakeAnthropic } from "./fakes/anthropic"
import { startFakeCodex } from "./fakes/codex"
import { startFakeGitHub } from "./fakes/github"
import type { FakeProvider } from "./fakes/fake-server"
import { startFakeOpenAIChat } from "./fakes/openai-chat"
import { startFakeOpenAIResponses } from "./fakes/openai-responses"
import { PromptCache } from "./fakes/prompt-cache"
import { hashSecret, isRecord, manualClock, parseJson, parseSse, stringField } from "./fakes/shared"
import { decodeJwtClaims, AUTH_CLAIM } from "./fixtures/chatgpt-tokens"
import { updateCodexMultiProviderAuth, writeCodexMultiProviderProfiles } from "./fixtures/codex-multi-provider"

// Bun's WebSocket client accepts handshake headers; the DOM typings in scope do not know that overload.
const HeaderWebSocket = WebSocket as unknown as new (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket

const started: FakeProvider[] = []
const track = <T extends FakeProvider>(fake: T) => {
  started.push(fake)
  return fake
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((fake) => fake.stop()))
})

// A long shared prefix so every provider's minimum cacheable size is exceeded.
const PREFIX = "You are a careful assistant. ".repeat(400)

describe("PromptCache", () => {
  test("prefix mode hits whole blocks of an identical prefix and expires after the TTL", () => {
    const clock = manualClock()
    const cache = new PromptCache({ blockTokens: 16, minTokens: 32, ttlMs: 60_000, clock })
    const first = cache.prefix("a", PREFIX + "one")
    const second = cache.prefix("a", PREFIX + "two")
    const otherDomain = cache.prefix("b", PREFIX + "two")
    clock.advance(61_000)
    const expired = cache.prefix("a", PREFIX + "two")

    expect(first.cachedTokens).toBe(0)
    expect(second.cachedTokens).toBeGreaterThan(0)
    expect(second.cachedTokens % 16).toBe(0)
    expect(second.cachedTokens).toBeLessThanOrEqual(Math.ceil(PREFIX.length / 4))
    expect(otherDomain.cachedTokens).toBe(0)
    expect(expired.cachedTokens).toBe(0)
  })

  test("breakpoint mode writes at breakpoints and reads the longest cached prefix", () => {
    const cache = new PromptCache({ minTokens: 10 })
    const blocks = [{ text: PREFIX, breakpoint: "5m" as const }, { text: "question one" }]
    const write = cache.breakpoints("a", blocks)
    const read = cache.breakpoints("a", [blocks[0], { text: "question two" }])

    expect(write.cachedTokens).toBe(0)
    expect(write.written5m).toBe(Math.ceil(PREFIX.length / 4))
    expect(read.cachedTokens).toBe(Math.ceil(PREFIX.length / 4))
    expect(read.writtenTokens).toBe(0)
  })
})

describe("fake OpenAI Responses", () => {
  test("rejects missing credentials and streams usage with cached tokens", async () => {
    const fake = track(startFakeOpenAIResponses({ cache: { minTokens: 64, blockTokens: 32 } }))
    const unauthenticated = await fetch(`${fake.baseURL}/responses`, { method: "POST", body: "{}" })
    const first = await responses(fake.baseURL, "key-a", "model-x", "hello")
    const second = await responses(fake.baseURL, "key-a", "model-x", "hello again")
    const otherKey = await responses(fake.baseURL, "key-b", "model-x", "hello again")

    expect(unauthenticated.status).toBe(401)
    expect(usage(first).input_tokens_details?.cached_tokens).toBe(0)
    expect(Number(usage(second).input_tokens_details?.cached_tokens)).toBeGreaterThan(0)
    expect(usage(otherKey).input_tokens_details?.cached_tokens).toBe(0)
    expect(fake.requests.map((request) => request.status)).toEqual([401, 200, 200, 200])
    expect(fake.requests[1].headers.authorization).toBe(hashSecret("Bearer key-a"))
    expect(fake.requests[1].body).toContain("hello")
    expect(fake.requests[1].responseHeaders["x-ratelimit-remaining-requests"]).toBeDefined()
  })

  test("credentials in one org share its cache; unknown keys are rejected", async () => {
    const fake = track(
      startFakeOpenAIResponses({
        cache: { minTokens: 64, blockTokens: 32 },
        credentials: { "key-a": { domain: "org-1" }, "key-b": { domain: "org-1" } },
      }),
    )
    await responses(fake.baseURL, "key-a", "model-x", "hello")
    const shared = await responses(fake.baseURL, "key-b", "model-x", "hello")
    const unknown = await fetch(`${fake.baseURL}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer key-c" },
      body: "{}",
    })

    expect(Number(usage(shared).input_tokens_details?.cached_tokens)).toBeGreaterThan(0)
    expect(fake.requests[1].responseHeaders["openai-organization"]).toBe("org-1")
    expect(unknown.status).toBe(401)
  })

  test("serves queued replies: tool calls, errors and stream failures", async () => {
    const fake = track(startFakeOpenAIResponses())
    fake.enqueue(
      { type: "tool-call", name: "read", input: { path: "a.txt" }, id: "call_1" },
      { type: "error", status: 500, body: { error: { message: "boom" } } },
      { type: "stream-error", error: { code: "server_error", message: "failed" } },
    )
    const tool = await responses(fake.baseURL, "key", "m", "x")
    const failed = await fetch(`${fake.baseURL}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer key" },
      body: JSON.stringify({ model: "m", input: [], stream: true }),
    })
    const broken = await responses(fake.baseURL, "key", "m", "x")

    expect(tool.find((event) => event.type === "response.output_item.done")?.item).toMatchObject({
      type: "function_call",
      name: "read",
      call_id: "call_1",
      arguments: JSON.stringify({ path: "a.txt" }),
    })
    expect(failed.status).toBe(500)
    expect(broken.at(-1)?.type).toBe("response.failed")
  })

  test("rejected requests do not warm the cache", async () => {
    const fake = track(startFakeOpenAIResponses({ cache: { minTokens: 64, blockTokens: 32 } }))
    fake.enqueue({ type: "error", status: 503, body: { error: { message: "overloaded" } } })
    await responses(fake.baseURL, "key", "m", "same")
    const retry = await responses(fake.baseURL, "key", "m", "same")
    const again = await responses(fake.baseURL, "key", "m", "same")

    expect(usage(retry).input_tokens_details?.cached_tokens).toBe(0)
    expect(Number(usage(again).input_tokens_details?.cached_tokens)).toBeGreaterThan(0)
  })

  test("decodes a zstd body like the ChatGPT routes; an undecodable one answers 400", async () => {
    const fake = track(startFakeOpenAIResponses())
    const json = JSON.stringify({ model: "m", input: [{ role: "user", content: PREFIX }], stream: true })
    const zstd = await fetch(`${fake.baseURL}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer key", "content-type": "application/json", "content-encoding": "zstd" },
      body: new Uint8Array(Bun.zstdCompressSync(json)),
    })
    await zstd.text()
    const corrupt = await fetch(`${fake.baseURL}/responses`, {
      method: "POST",
      headers: { authorization: "Bearer key", "content-encoding": "zstd" },
      body: json,
    })

    expect(zstd.status).toBe(200)
    expect(fake.requests[0]).toMatchObject({ body: json, json: { model: "m" }, model: "m" })
    expect(fake.requests[0].headers["content-encoding"]).toBe("zstd")
    expect(Number(fake.requests[0].wireBytes)).toBeLessThan(json.length)
    expect(corrupt.status).toBe(400)
    expect(fake.requests[1]).toMatchObject({ status: 400, body: "", wireBytes: json.length })
  })
})

describe("fake Codex", () => {
  test("serves usage headers per account, keeps the cache across refreshes and exhausts at 100%", async () => {
    const fake = track(startFakeCodex({ cache: { minTokens: 64, blockTokens: 32 }, usagePerRequest: { primary: 40 } }))
    const tokens = fake.login({ accountID: "acct-1", plan: "pro" })
    const first = await codex(fake.baseURL, tokens.accessToken, "acct-1")
    const refreshed = fake.refresh(tokens.refreshToken)
    if (refreshed.type !== "ok") throw new Error("refresh failed")
    const second = await codex(fake.baseURL, refreshed.tokens.accessToken, "acct-1")
    const third = await codex(fake.baseURL, refreshed.tokens.accessToken, "acct-1")
    const exhausted = await codex(fake.baseURL, refreshed.tokens.accessToken, "acct-1")

    expect(first.response.headers.get("x-codex-primary-used-percent")).toBe("40")
    expect(first.response.headers.get("x-codex-primary-window-minutes")).toBe("300")
    expect(second.response.headers.get("x-codex-primary-used-percent")).toBe("80")
    expect(Number(usage(second.events).input_tokens_details?.cached_tokens)).toBeGreaterThan(0)
    expect(third.response.headers.get("x-codex-primary-used-percent")).toBe("100")
    expect(exhausted.response.status).toBe(429)
    expect(exhausted.body).toMatchObject({ error: { type: "usage_limit_reached", plan_type: "pro" } })
    expect(fake.requests.every((request) => request.identity === "codex:acct-1")).toBe(true)
    expect(fake.refreshCount("acct-1")).toBe(1)
  })

  test("OAuth refresh rotates tokens once and revokes the family on reuse", async () => {
    const fake = track(startFakeCodex())
    const tokens = fake.login({ accountID: "acct-2" })
    const rotate = (refreshToken: string) =>
      fetch(fake.tokenURL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "x" }),
      })
    const ok = await rotate(tokens.refreshToken)
    const next = await ok.json()
    const reused = await rotate(tokens.refreshToken)
    const afterReuse = await codex(fake.baseURL, isRecord(next) ? String(next.access_token) : "", "acct-2")

    expect(ok.status).toBe(200)
    expect(isRecord(next) && decodeJwtClaims(String(next.access_token))[AUTH_CLAIM]).toMatchObject({
      chatgpt_account_id: "acct-2",
    })
    expect(reused.status).toBe(401)
    expect(await reused.json()).toMatchObject({ error: { code: "refresh_token_reused" } })
    expect(afterReuse.response.status).toBe(401)
    expect(
      fake.requests.filter((request) => request.path === "/oauth/token").map((request) => request.body),
    ).not.toContain(tokens.refreshToken)
  })

  test("rejects a token used with another account header", async () => {
    const fake = track(startFakeCodex())
    const tokens = fake.login({ accountID: "acct-3" })
    const mismatch = await codex(fake.baseURL, tokens.accessToken, "acct-other")
    expect(mismatch.response.status).toBe(403)
  })

  test("streams a WebSocket turn after a codex.rate_limits frame", async () => {
    const fake = track(startFakeCodex())
    const tokens = fake.login({ accountID: "acct-ws" })
    const socket = new HeaderWebSocket(fake.websocketURL, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, "chatgpt-account-id": "acct-ws" },
    })
    const frames: Record<string, unknown>[] = []
    const done = Promise.withResolvers<void>()
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data))
      frames.push(frame)
      if (frame.type === "response.completed") done.resolve()
    })
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "response.create", model: "gpt-fake", input: [], instructions: "hi" })),
    )
    await done.promise
    socket.close()

    // The real backend's first frames (live, 2026-10-18) and its tier answers: `auto`, then `default`.
    expect(frames[0]).toMatchObject({
      type: "codex.rate_limits",
      rate_limits: { allowed: true, limit_reached: false, primary: { window_minutes: 300 } },
      additional_rate_limits: null,
    })
    expect(frames[1]).toMatchObject({ type: "codex.response.metadata" })
    expect(frames.map((frame) => frame.type)).toContain("response.output_text.delta")
    const tier = (type: string) => (frames.find((frame) => frame.type === type)?.response as { service_tier?: string })
    expect([tier("response.created")?.service_tier, tier("response.completed")?.service_tier]).toEqual([
      "auto",
      "default",
    ])
    expect(fake.requests.map((request) => [request.transport, request.method])).toEqual([
      ["websocket", "GET"],
      ["websocket", "WS"],
    ])
  })
})

describe("fake Anthropic", () => {
  test("caches at cache_control breakpoints and reports read/creation tokens", async () => {
    const fake = track(startFakeAnthropic({ cache: { minTokens: 64 } }))
    const first = await messages(fake.baseURL, "sk-ant-fake", [
      { type: "text", text: PREFIX, cache_control: { type: "ephemeral" } },
    ])
    const second = await messages(fake.baseURL, "sk-ant-fake", [
      { type: "text", text: PREFIX, cache_control: { type: "ephemeral" } },
    ])
    const start = (events: Record<string, unknown>[]) => {
      const message = events.find((event) => event.type === "message_start")?.message
      return isRecord(message) && isRecord(message.usage) ? message.usage : {}
    }

    const written = Number(start(first.events).cache_creation_input_tokens)
    expect(written).toBeGreaterThanOrEqual(Math.ceil(PREFIX.length / 4))
    expect(start(first.events)).toMatchObject({
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: written, ephemeral_1h_input_tokens: 0 },
    })
    expect(start(second.events)).toMatchObject({ cache_read_input_tokens: written, cache_creation_input_tokens: 0 })
    expect(first.response.headers.get("anthropic-ratelimit-requests-remaining")).toBeDefined()
  })

  test("rejects invalid breakpoint layouts like the API", async () => {
    const fake = track(startFakeAnthropic())
    const block = (ttl: string) => ({ type: "text", text: "x", cache_control: { type: "ephemeral", ttl } })
    const tooMany = await messages(fake.baseURL, "k", [block("5m"), block("5m"), block("5m"), block("5m"), block("5m")])
    const misordered = await messages(fake.baseURL, "k", [block("5m"), block("1h")])

    expect(tooMany.response.status).toBe(400)
    expect(misordered.response.status).toBe(400)
  })

  test("reports unified subscription limits and rejects when exhausted", async () => {
    const fake = track(startFakeAnthropic())
    const reset = Math.floor(Date.now() / 1000) + 3600
    fake.setUnified(hashSecret("oauth-token"), {
      status: "rejected",
      fiveHourUtilization: 1,
      sevenDayUtilization: 0.4,
      fiveHourReset: reset,
      sevenDayReset: reset,
    })
    const rejected = await fetch(`${fake.baseURL}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer oauth-token", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-fake",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(rejected.status).toBe(429)
    expect(rejected.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected")
    expect(rejected.headers.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.4")
  })
})

describe("fake OpenAI-compatible chat (DeepSeek dialect)", () => {
  test("reports prompt_cache_hit_tokens and serves the balance endpoint", async () => {
    const fake = track(startFakeOpenAIChat())
    const body = {
      model: "deepseek-fake",
      stream: true,
      messages: [
        { role: "system", content: PREFIX },
        { role: "user", content: "hi" },
      ],
    }
    const call = async () =>
      parseSse(
        await (
          await fetch(`${fake.baseURL}/chat/completions`, {
            method: "POST",
            headers: { authorization: "Bearer ds-key" },
            body: JSON.stringify(body),
          })
        ).text(),
      )
    const usageOf = (events: Awaited<ReturnType<typeof call>>) => {
      const last = events
        .map((event) => event.data)
        .filter(isRecord)
        .at(-1)
      return isRecord(last?.usage) ? last.usage : {}
    }
    const first = usageOf(await call())
    const second = usageOf(await call())
    fake.setBalance(hashSecret("ds-key"), { available: false, currency: "USD", total: "0.00" })
    const balance = await (
      await fetch(`${fake.url}/user/balance`, { headers: { authorization: "Bearer ds-key" } })
    ).json()

    expect(first.prompt_cache_hit_tokens).toBe(0)
    expect(Number(second.prompt_cache_hit_tokens)).toBeGreaterThan(0)
    expect(Number(second.prompt_cache_hit_tokens) % 64).toBe(0)
    expect(second.prompt_cache_miss_tokens).toBe(Number(second.prompt_tokens) - Number(second.prompt_cache_hit_tokens))
    expect(balance).toMatchObject({ is_available: false, balance_infos: [{ total_balance: "0.00" }] })
  })
})

describe("fake GitHub's git smart HTTP (repos)", () => {
  test("a push and a clone go through git http-backend as the token's login; another repository stays empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-fake-github-"))
    const token = "ghp_fakeKitSmartHttp00000000000000000Kt01"
    const repos = path.join(root, "repos")
    // Asynchronous: the fake answers in this process, so a blocking spawn would wait on itself.
    const git = async (cwd: string, ...args: string[]) => {
      const child = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(root, "none"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { code, out: `${out}${err}` }
    }
    await fs.mkdir(path.join(repos, "octo"), { recursive: true })
    expect((await git(root, "init", "-q", "--bare", path.join(repos, "octo", "hello.git"))).code).toBe(0)
    const github = startFakeGitHub({ accounts: { [token]: { login: "octo-work" } }, repos })
    try {
      const origin = `http://octo-work:${token}@127.0.0.1:${new URL(github.url).port}/octo/hello.git`
      const work = path.join(root, "work")
      expect((await git(root, "init", "-q", work)).code).toBe(0)
      expect((await git(work, "commit", "-q", "--allow-empty", "-m", "first")).code).toBe(0)
      const pushed = await git(work, "push", origin, "HEAD:refs/heads/main")
      expect(`${pushed.code} ${pushed.out}`).toStartWith("0")
      const head = (await git(work, "rev-parse", "HEAD")).out.trim()
      expect(
        (await git(root, "--git-dir", path.join(repos, "octo", "hello.git"), "rev-parse", "main")).out.trim(),
      ).toBe(head)
      const cloned = await git(root, "clone", "-q", "-b", "main", origin, path.join(root, "clone"))
      expect(`${cloned.code} ${cloned.out}`).toStartWith("0")
      expect((await git(path.join(root, "clone"), "rev-parse", "HEAD")).out.trim()).toBe(head)
      expect(github.git.map((item) => [item.login, item.service])).toContainEqual(["octo-work", "git-receive-pack"])
      // Without the repository the old empty advertisement answers.
      const empty = await git(root, "ls-remote", origin.replace("hello.git", "other.git"))
      expect(empty).toEqual({ code: 0, out: "" })
    } finally {
      github.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("wire faults (P1-9b)", () => {
  test("reset: the connection resets before any header; the next reply streams normally", async () => {
    const fake = track(startFakeOpenAIResponses())
    fake.enqueue({ type: "reset" }, { type: "text", text: "after reset" })
    const reset = await responsesCall(fake.baseURL).then(
      () => undefined,
      (error: unknown) => error,
    )
    const next = await responses(fake.baseURL, "key", "m", "x")

    expect(reset).toMatchObject({ code: "ECONNRESET" })
    expect(next.at(-1)?.type).toBe("response.completed")
    expect(fake.requests.map((request) => [request.status, request.fault])).toEqual([
      [0, "reset"],
      [200, undefined],
    ])
  })

  test("drop: the stream breaks behind the n-th text delta, or right behind a tool-call delta", async () => {
    const fake = track(startFakeOpenAIResponses())
    fake.enqueue(
      { type: "drop", reply: { type: "text", text: "aaaa bbbb cccc", deltas: 3 }, after: 2 },
      { type: "drop", reply: { type: "tool-call", name: "read", input: { path: "a.txt" } }, after: 1 },
    )
    const text = await broken(await responsesCall(fake.baseURL))
    const tool = await broken(await responsesCall(fake.baseURL))

    expect(text.error).toMatchObject({ code: "ECONNRESET" })
    const deltas = text.events.filter((event) => event.type === "response.output_text.delta")
    expect(deltas.map((event) => event.delta)).toEqual(["aaaa ", "bbbb "])
    expect(tool.error).toMatchObject({ code: "ECONNRESET" })
    expect(tool.events.at(-1)?.type).toBe("response.function_call_arguments.delta")
    expect(fake.requests.map((request) => [request.status, request.fault])).toEqual([
      [200, "drop"],
      [200, "drop"],
    ])
  })

  test("drop with `until`: the sent events arrive while the reset waits for the gate", async () => {
    const fake = track(startFakeOpenAIResponses())
    const gate = Promise.withResolvers<void>()
    fake.enqueue({
      type: "drop",
      reply: { type: "tool-call", name: "read", input: { path: "a.txt" } },
      after: 1,
      until: () => gate.promise,
    })
    const response = await responsesCall(fake.baseURL)
    if (!response.body) throw new Error("no body")
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    const received: string[] = []
    const delta = () =>
      events(received.join("")).some((event) => event.type === "response.function_call_arguments.delta")
    // The gate is still held here, so the tool-call delta must reach the client before the reset.
    const sent = async (): Promise<void> => {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("the stream ended before the tool-call delta")
      received.push(chunk.value)
      if (!delta()) return sent()
    }
    await sent()
    const rest = reader.read().then(
      (chunk) => ({ chunk }),
      (error: unknown) => ({ error }),
    )
    // Six times the fixed pause: without the gate the reset would have arrived by now.
    const early = await Promise.race([rest, Bun.sleep(300).then(() => "held" as const)])
    gate.resolve()

    expect(early).toBe("held")
    expect(await rest).toMatchObject({ error: { code: "ECONNRESET" } })
    expect(events(received.join("")).at(-1)?.type).toBe("response.function_call_arguments.delta")
  })

  test("eof and malformed on chat: no finish chunk and no [DONE], or one chunk that is not JSON", async () => {
    const fake = track(startFakeOpenAIChat())
    fake.enqueue(
      { type: "eof", reply: { type: "text", text: "cut short" } },
      { type: "malformed", reply: { type: "tool-call", name: "read", input: { path: "a.txt" } }, after: 0 },
    )
    const eof = await broken(await chatCall(fake.baseURL))
    const malformed = await chatCall(fake.baseURL).then((response) => response.text())
    const data = parseSse(malformed).map((event) => event.data)

    expect(eof.error).toBeUndefined()
    expect(eof.raw).toContain("cut short")
    expect(eof.raw).not.toContain('"finish_reason":"stop"')
    expect(eof.raw).not.toContain("[DONE]")
    // The tool-call chunk arrives cut in half; the finish chunk and [DONE] still follow.
    expect(data.filter((item) => typeof item === "string" && item !== "[DONE]")).toHaveLength(1)
    expect(data.at(-1)).toBe("[DONE]")
  })

  test("Codex WebSocket: reset, drop, eof, a close frame mid-response and a malformed frame", async () => {
    const fake = track(startFakeCodex())
    const tokens = fake.login({ accountID: "acct-wire" })
    const answer = { type: "text", text: "alpha beta", deltas: 2 } as const
    fake.enqueue(
      { type: "reset" },
      { type: "drop", reply: answer, after: 1 },
      { type: "eof", reply: answer },
      { type: "ws-close", reply: answer, after: 1 },
      { type: "malformed", reply: answer, after: 1 },
    )
    const turn = () => codexSocket(fake.websocketURL, tokens.accessToken, "acct-wire")
    const reset = await turn()
    const drop = await turn()
    const eof = await turn()
    const close = await turn()
    const malformed = await turn()
    const types = (frames: readonly string[]) => frames.map((frame) => stringField(parseJson(frame), "type"))

    expect(reset).toMatchObject({ frames: [], code: 1006 })
    expect(types(drop.frames)).toEqual([
      "codex.rate_limits",
      "codex.response.metadata",
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
    ])
    expect(drop.code).toBe(1006)
    expect(types(eof.frames)).not.toContain("response.completed")
    expect(types(eof.frames)).toContain("response.output_item.done")
    expect(eof.code).toBe(1000)
    expect(types(close.frames).at(-1)).toBe("response.output_text.delta")
    expect(close.code).toBe(1011)
    expect(malformed.frames.filter((frame) => parseJson(frame) === undefined)).toHaveLength(1)
    expect(types(malformed.frames).at(-1)).toBe("response.completed")
    expect(fake.requests.filter((request) => request.method === "WS").map((request) => request.fault)).toEqual([
      "reset",
      "drop",
      "eof",
      "ws-close",
      "malformed",
    ])
  })

  test("delayed-listen: this request resets, connections are refused, then the next reply is served", async () => {
    const fake = track(startFakeOpenAIChat())
    fake.enqueue({ type: "delayed-listen", ms: 400 }, { type: "text", text: "listening again" })
    const first = await chatCall(fake.baseURL).then(
      () => undefined,
      (error: unknown) => error,
    )
    const refused = await chatCall(fake.baseURL).then(
      () => undefined,
      (error: unknown) => error,
    )
    await Bun.sleep(600)
    const after = await chatCall(fake.baseURL).then((response) => response.text())

    expect(first).toMatchObject({ code: "ECONNRESET" })
    // Bun 1.4.4 names a refused connection as Node does (1.4.2 said `ConnectionRefused`).
    expect(refused).toMatchObject({ code: "ECONNREFUSED" })
    expect(after).toContain("listening again")
    expect(fake.requests.map((request) => [request.status, request.fault])).toEqual([
      [0, "delayed-listen"],
      [200, undefined],
    ])
  })

  test("faults a fake does not simulate answer 501: every fault on anthropic, ws-close over HTTP", async () => {
    const anthropic = track(startFakeAnthropic())
    const chat = track(startFakeOpenAIChat())
    anthropic.enqueue({ type: "reset" }, { type: "text", text: "unchanged" })
    chat.enqueue({ type: "ws-close", reply: { type: "text", text: "x" }, after: 0 })
    const unsupported = await messages(anthropic.baseURL, "k", [])
    const next = await messages(anthropic.baseURL, "k", [])
    const overHttp = await chatCall(chat.baseURL)

    expect(unsupported.response.status).toBe(501)
    expect(JSON.stringify(next.events)).toContain("unchanged")
    expect(overHttp.status).toBe(501)
    expect(anthropic.requests.map((request) => [request.status, request.fault])).toEqual([
      [501, undefined],
      [200, undefined],
    ])
  })
})

describe("codex-multi-provider fixture", () => {
  test("writes the old app's profile layout and rewrites auth.json atomically", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-legacy-"))
    const fake = track(startFakeCodex())
    const [profile] = await writeCodexMultiProviderProfiles(root, [
      { alias: "work", tokens: fake.login({ accountID: "acct-legacy" }) },
    ])
    const state = await Bun.file(path.join(root, "state.json")).json()
    const before = await Bun.file(profile.authPath).json()
    const refreshed = fake.refresh(before.tokens.refresh_token)
    if (refreshed.type !== "ok") throw new Error("refresh failed")
    await updateCodexMultiProviderAuth(profile, refreshed.tokens)
    const after = await Bun.file(profile.authPath).json()
    await fs.rm(root, { recursive: true, force: true })

    expect(state.profiles).toEqual([expect.objectContaining({ id: profile.id, alias: "work", auth_mode: "chatgpt" })])
    expect(before).toMatchObject({ auth_mode: "chatgpt", tokens: { account_id: "acct-legacy" } })
    expect(after.tokens.access_token).toBe(refreshed.tokens.accessToken)
    expect(after.tokens.refresh_token).not.toBe(before.tokens.refresh_token)
  })

  test("the fixture layout is what @own/runtime imports, and a linked reader rides out a torn in-place write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-legacy-"))
    const fake = track(startFakeCodex())
    const [profile] = await writeCodexMultiProviderProfiles(root, [
      { alias: "work", tokens: fake.login({ accountID: "acct-legacy" }) },
    ])
    const listed = await CodexSource.list(root)
    expect(listed.available).toBe(true)
    expect(listed.profiles.map((item) => [item.profileID, item.alias, item.inspection.ok])).toEqual([
      [profile.id, "work", true],
    ])
    const found = listed.profiles[0]
    if (!found?.inspection.ok) throw new Error("profile expected")
    expect(found.source.authPath).toBe(profile.authPath)
    expect(found.inspection.summary.identity.chatgptAccountId).toBe("acct-legacy")

    let now = Date.now()
    const reader = new CodexSource.Reader(profile.authPath, {
      now: () => now,
      expected: { accountId: "acct-legacy", fingerprint: found.inspection.summary.identity.fingerprint },
    })
    const first = await reader.usable()
    if (!first.ok) throw new Error("usable source expected")
    const before = await Bun.file(profile.authPath).json()
    const refreshed = fake.refresh(before.tokens.refresh_token)
    if (refreshed.type !== "ok") throw new Error("refresh failed")
    // Codex CLI truncates and rewrites auth.json in place: the reader keeps the last good tokens meanwhile.
    await updateCodexMultiProviderAuth(profile, refreshed.tokens, new Date(), { torn: true })
    now += 1_000
    expect(await reader.usable()).toMatchObject({ ok: true, degraded: true })
    await updateCodexMultiProviderAuth(profile, refreshed.tokens)
    now += 1_000
    const next = await reader.usable()
    await fs.rm(root, { recursive: true, force: true })
    expect(next.ok && next.snapshot.secret.access()).toBe(refreshed.tokens.accessToken)
    expect(next.ok && next.degraded).toBe(false)
  })
})

async function responses(baseURL: string, key: string, model: string, text: string) {
  const response = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      instructions: PREFIX,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
    }),
  })
  return events(await response.text())
}

async function codex(baseURL: string, accessToken: string, accountID: string) {
  const response = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "chatgpt-account-id": accountID },
    body: JSON.stringify({ model: "gpt-fake", stream: true, store: false, instructions: PREFIX, input: [] }),
  })
  const text = await response.text()
  return {
    response,
    events: response.ok ? events(text) : [],
    body: response.ok ? undefined : JSON.parse(text),
  }
}

async function messages(baseURL: string, key: string, system: readonly Record<string, unknown>[]) {
  const response = await fetch(`${baseURL}/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-fake",
      max_tokens: 64,
      stream: true,
      system,
      messages: [{ role: "user", content: "hi" }],
    }),
  })
  return { response, events: response.ok ? events(await response.text()) : [] }
}

function responsesCall(baseURL: string) {
  return fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: { authorization: "Bearer key" },
    body: JSON.stringify({ model: "m", input: [], stream: true }),
  })
}

function chatCall(baseURL: string) {
  return fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer ds-key" },
    body: JSON.stringify({ model: "deepseek-fake", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
}

/** Reads a streamed body until it ends or breaks: the SSE events received before, the raw text, and the error. */
async function broken(response: Response) {
  if (!response.body) throw new Error("no body")
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const received: string[] = []
  const read = async (): Promise<undefined> => {
    const chunk = await reader.read()
    if (chunk.done) return undefined
    received.push(chunk.value)
    return read()
  }
  const error = await read().then(
    () => undefined,
    (failure: unknown) => failure,
  )
  return { events: events(received.join("")), raw: received.join(""), error }
}

/** One Codex WebSocket turn: the frames received until the socket closed, and its close code. */
async function codexSocket(url: string, accessToken: string, accountID: string) {
  const socket = new HeaderWebSocket(url, {
    headers: { authorization: `Bearer ${accessToken}`, "chatgpt-account-id": accountID },
  })
  const frames: string[] = []
  const closed = Promise.withResolvers<number>()
  socket.addEventListener("message", (message) => {
    frames.push(String(message.data))
    // A complete turn keeps the socket open for the next one; end it here.
    if (String(message.data).includes('"type":"response.completed"')) socket.close(1000)
  })
  socket.addEventListener("close", (event) => closed.resolve(event.code))
  socket.addEventListener("open", () =>
    socket.send(JSON.stringify({ type: "response.create", model: "gpt-fake", input: [], instructions: "hi" })),
  )
  return { frames, code: await closed.promise }
}

function events(text: string) {
  return parseSse(text)
    .map((event) => event.data)
    .filter(isRecord)
}

function usage(stream: readonly Record<string, unknown>[]) {
  const completed = stream.find((event) => event.type === "response.completed")?.response
  const value = isRecord(completed) && isRecord(completed.usage) ? completed.usage : {}
  return value as { input_tokens_details?: { cached_tokens?: number } }
}
