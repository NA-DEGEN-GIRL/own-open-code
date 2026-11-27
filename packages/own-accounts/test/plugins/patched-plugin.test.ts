// The bundled claude-auth (02 §8.2, guards G1–G3, G7) running its real, patched code in temp folders: several fake
// Claude Code login folders, a fake Anthropic upstream on loopback and a fake OAuth token endpoint. Every token is fake;
// no real login folder, network or Claude Code is ever reached: the user profile, `CLAUDE_CONFIG_DIR` and `PATH` point
// into a temp directory for this file, and every outbound `fetch` that is not loopback or the fake token endpoint fails
// the test. Skipped without a built bundle (`support/claude-auth-bundle.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClaudeWire } from "../../src/broker/claude-wire.js"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import { accounts, copy, login, source } from "../support/claude-auth-bundle.js"

const from = source()
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-bundle-")))
const KEYS = [
  "USERPROFILE",
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "PATH",
  "Path",
  "CLAUDE_CODE_ENTRYPOINT",
  "ANTHROPIC_CLI_VERSION",
  "ANTHROPIC_USER_AGENT",
] as const
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
const realFetch = globalThis.fetch
/** The token endpoint Claude Code itself uses with the plugin's client id (the patch's `OAUTH_TOKEN_URL`). */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const oauth = {
  calls: 0,
  bodies: [] as Array<{
    readonly type: string | null
    readonly accept: string | null
    readonly agent: string | null
    readonly body: unknown
  }>,
  answer: (_refresh: string): Response => new Response("{}", { status: 500 }),
}
const home = { dir: "" }
/** Every `claude` run the plugin started (its last-resort refresh `claude -p`): the arguments and `CLAUDE_CONFIG_DIR`. */
const CLI_LOG = path.join(root, "claude-runs.log")
const runs = () => (fs.existsSync(CLI_LOG) ? fs.readFileSync(CLI_LOG, "utf8").split(/\r?\n/).filter(Boolean) : [])

beforeAll(() => {
  home.dir = fs.mkdtempSync(path.join(root, "home-"))
  process.env.USERPROFILE = home.dir
  process.env.HOME = home.dir
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(root, "no-login-"))
  // The service runs without them (own's launcher clears `ANTHROPIC_*` and `CLAUDE_*`, 02 §8.3 I8); a Claude Code
  // session running these tests sets `CLAUDE_CODE_ENTRYPOINT`.
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  delete process.env.ANTHROPIC_CLI_VERSION
  delete process.env.ANTHROPIC_USER_AGENT
  // The plugin's last-resort refresh runs `claude -p`: PATH holds only a recorder that fails (never a real request).
  const bin = fs.mkdtempSync(path.join(root, "bin-"))
  if (process.platform === "win32")
    fs.writeFileSync(
      path.join(bin, "claude.cmd"),
      `@echo off\r\necho %*^|%CLAUDE_CONFIG_DIR%>>"${CLI_LOG}"\r\nexit /b 1\r\n`,
    )
  else
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$*|$CLAUDE_CONFIG_DIR" >> "${CLI_LOG}"\nexit 1\n`, {
      mode: 0o755,
    })
  process.env.PATH = bin
  process.env.Path = bin
  // SAFETY: the plugin calls the global `fetch` for its token endpoint; this file answers it and refuses anything else.
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "127.0.0.1") return realFetch(input, init)
      if (url.href === TOKEN_URL) {
        oauth.calls++
        const headers = new Headers(init?.headers)
        const body: unknown = JSON.parse(String(init?.body ?? "{}"))
        oauth.bodies.push({
          type: headers.get("content-type"),
          accept: headers.get("accept"),
          agent: headers.get("user-agent"),
          body,
        })
        // A slow endpoint, so concurrent callers really overlap.
        await Bun.sleep(50)
        const refresh =
          typeof body === "object" && body !== null && "refresh_token" in body ? String(body.refresh_token) : ""
        return oauth.answer(refresh)
      }
      throw new Error(`test: unexpected request to ${url.origin}`)
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

interface Seen {
  readonly token: string
  readonly session: string | null
  readonly path: string
}

/** A fake Anthropic: 401 for revoked tokens, else 200 with unified limit headers. */
function upstream(revoked: Set<string>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      await request.text()
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
      seen.push({
        token,
        session: request.headers.get("x-claude-code-session-id"),
        path: new URL(request.url).pathname,
      })
      if (revoked.has(token)) return new Response(JSON.stringify({ type: "error" }), { status: 401 })
      return new Response(JSON.stringify({ type: "message" }), {
        status: 200,
        headers: { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.1" },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

/** A fake Anthropic answering request n with `answers[n]` (then 200), recording each request's `anthropic-beta`. */
function scripted(answers: ReadonlyArray<{ readonly status: number; readonly body: unknown }>) {
  const betas: string[][] = []
  const queue = [...answers]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      await request.text()
      betas.push((request.headers.get("anthropic-beta") ?? "").split(",").filter(Boolean))
      const next = queue.shift() ?? { status: 200, body: { type: "message" } }
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, betas, stop: () => server.stop(true) }
}

/** A fake Anthropic answering 200, recording what each request carried as Anthropic would read it. */
function capture() {
  const seen: Array<{
    readonly agent: string | null
    readonly betas: ReadonlyArray<string>
    readonly text: string
    readonly body: {
      readonly system?: ReadonlyArray<Record<string, unknown>>
      readonly output_config?: Record<string, unknown>
    }
  }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const text = await request.text()
      seen.push({
        agent: request.headers.get("user-agent"),
        betas: (request.headers.get("anthropic-beta") ?? "").split(",").filter(Boolean),
        text,
        body: JSON.parse(text),
      })
      return new Response(JSON.stringify({ type: "message" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

/**
 * CW (2026-10-19): Anthropic's refusals of a request it bills to extra usage, as users reported them
 * (anthropics/claude-code#45134, router-for-me/CLIProxyAPI#6432 and #5920, NousResearch/hermes-agent#48176).
 */
const REFUSALS = [
  {
    status: 400,
    error: {
      type: "invalid_request_error",
      message:
        "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.",
    },
  },
  {
    status: 400,
    error: {
      type: "invalid_request_error",
      message:
        "Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin to add more and keep going.",
    },
  },
  {
    status: 400,
    error: {
      type: "invalid_request_error",
      message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    },
  },
  {
    status: 400,
    error: {
      type: "invalid_request_error",
      message: "You\u2019re out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    },
  },
  {
    status: 429,
    error: { type: "rate_limit_error", code: "credits_required", message: "Usage credits are required for this model" },
  },
] as const
const INTERLEAVED = "interleaved-thinking-2025-05-14"
const CONTEXT_1M = "context-1m-2025-08-07"

type Hook = (event: Record<string, unknown>) => Promise<void> | void

/** The integration context the plugin's setup reads: one imported `anthropic` connection naming `configDir`. */
function context(hooks: Map<string, Hook>, configDir: string | undefined) {
  return {
    integration: {
      transform: async (callback: (draft: unknown) => void) =>
        callback({ update: () => {}, method: { update: () => {} } }),
      connection: {
        active: async () => ({ type: "credential", id: "cred_1" }),
        // The imported connection of account 1, as `기존 로그인 가져오기` wrote it.
        resolve: async () => ({
          type: "oauth",
          methodID: "claude-code",
          access: "connection-token",
          refresh: "connection-refresh",
          expires: Date.now() + 3_600_000,
          metadata: {
            "opencode-claude-auth/claude-code-oauth": "v1",
            source: "file",
            ...(configDir === undefined ? {} : { configDir }),
          },
        }),
      },
    },
    provider: {
      transform: async (callback: (draft: unknown) => void) =>
        callback({ get: () => undefined, update: () => {}, models: { update: () => {} } }),
      reload: async () => {},
    },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
    session: {
      hook: async (kind: string, callback: Hook) => {
        hooks.set(kind, callback)
      },
    },
  }
}

/**
 * Loads a fresh copy of the bundle with a fake host and runs its setup; then own names the state folder (as
 * `ClaudeWire` does on every import) holding a list of `folders`. Answers its hooks and multi-account exports.
 */
async function plugin(
  folders: ReadonlyArray<string>,
  options: {
    readonly fallback?: string | null
    readonly labels?: ReadonlyArray<string>
    readonly readOnly?: ReadonlyArray<string>
    readonly version?: number
    readonly configure?: boolean
    /** own's home, laid out as own's (`thirdparty\claude-auth` holds the list, `claude-accounts` the own folders). */
    readonly ownHome?: string
  } = {},
) {
  const dir = copy(root, from!)
  const ownHome = options.ownHome ?? fs.mkdtempSync(path.join(root, "own-"))
  const stateDir = path.join(ownHome, "thirdparty", "claude-auth")
  const keys = accounts(stateDir, folders, options)
  const hooks = new Map<string, Hook>()
  const loaded = (await import(dir.entry)) as { default: { setup: (context: unknown) => Promise<unknown> } }
  await loaded.default.setup(context(hooks, folders[0]))
  const module = (await import(Bun.resolveSync("opencode-claude-auth-v2", dir.dir))) as Record<string, unknown>
  const multi = options.configure === false ? undefined : await ClaudeWire.multi(dir.entry, stateDir)
  if (options.configure !== false && !multi) throw new Error("the bundled module has no multi-account exports")
  return { dir, ownHome, stateDir, keys, hooks, multi: multi!, module }
}

/**
 * One request through the plugin's hooks as core sends it: `http.request`, the send, `http.response`. `body`: the
 * request body core built (default: a short message to `claude-fake`).
 */
async function send(
  hooks: Map<string, Hook>,
  url: string,
  sessionID: string,
  body: Record<string, unknown> = { model: "claude-fake", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
) {
  const event: Record<string, unknown> = {
    model: { providerID: "anthropic", id: String(body.model) },
    sessionID,
    request: new Request(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  }
  await hooks.get("http.request")!(event)
  const prepared = event.request as Request
  const initial = await fetch(prepared.clone())
  const after: Record<string, unknown> = { ...event, request: prepared, response: initial }
  await hooks.get("http.response")!(after)
  return { prepared, response: after.response as Response }
}

describe.skipIf(!from)("the bundle", () => {
  test("verifies against its record; a changed byte is modified", async () => {
    const dir = copy(root, from!)
    expect(await ClaudeBundle.read(dir.dir)).toMatchObject({ version: "0.4.0-beta.5", state: "patched" })
    fs.appendFileSync(dir.module, "\n// edited\n")
    expect((await ClaudeBundle.read(dir.dir))?.state).toBe("modified")
  })
})

describe.skipIf(!from)("the patched plugin", () => {
  test("concurrent conversations on two accounts, interleaved: each is signed with its own account only (G2)", async () => {
    const a = login(path.join(root, "acct-a"), { token: "tok-a", email: "a@example.test" })
    const b = login(path.join(root, "acct-b"), { token: "tok-b", email: "b@example.test" })
    const { hooks, multi, keys } = await plugin([a, b])
    const api = upstream(new Set())
    multi.bindSession("s-a", keys[0]!)
    multi.bindSession("s-b", keys[1]!)
    const runs = await Promise.all(
      Array.from({ length: 20 }, (_, index) => send(hooks, api.url, index % 2 === 0 ? "s-a" : "s-b")),
    )
    expect(api.seen).toHaveLength(20)
    runs.forEach((run, index) => {
      const own = index % 2 === 0 ? "tok-a" : "tok-b"
      expect(run.prepared.headers.get("authorization")).toBe(`Bearer ${own}`)
      expect(run.response.status).toBe(200)
      // G4: the request names the account that signed it.
      expect(multi.accountOf(run.prepared)).toBe(keys[index % 2]!)
    })
    expect(api.seen.filter((item) => item.token === "tok-a")).toHaveLength(10)
    expect(api.seen.some((item) => item.token === "connection-token")).toBe(false)
    expect(multi.accounts().map((item) => item.key)).toEqual(keys)
    api.stop()
  })

  test("an unbound conversation uses the default account; an unknown account or no default fails closed", async () => {
    const a = login(path.join(root, "def-a"), { token: "tok-da" })
    const b = login(path.join(root, "def-b"), { token: "tok-db" })
    const api = upstream(new Set())
    const first = await plugin([a, b], { fallback: b })
    expect((await send(first.hooks, api.url, "s-unbound")).prepared.headers.get("authorization")).toBe("Bearer tok-db")
    first.multi.bindSession("s-gone", path.join(root, "nowhere").toLowerCase())
    expect(send(first.hooks, api.url, "s-gone")).rejects.toThrow("요청을 보내지 않았습니다")
    const second = await plugin([a, b], { fallback: null })
    expect(send(second.hooks, api.url, "s-unbound")).rejects.toThrow("이 대화에 정해진 Claude 계정이 없어")
    // Nothing reached the upstream with another account's token.
    expect(api.seen.map((item) => item.token)).toEqual(["tok-db"])
    api.stop()
  })

  test("an account whose refresh fails is refused in Korean, naming own's account; it never borrows a token (G3)", async () => {
    const a = login(path.join(root, "borrow-a"), { token: "tok-ba" })
    // Expiring in 30 s: the plugin must refresh before it may use it, and the token endpoint refuses.
    const b = login(path.join(root, "borrow-b"), { token: "tok-bb", expiresAt: Date.now() + 30_000 })
    const { hooks, multi, keys } = await plugin([a, b], { labels: ["AC-01", "AC-02"] })
    const api = upstream(new Set())
    oauth.answer = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    oauth.calls = 0
    multi.bindSession("s-b", keys[1]!)
    const refused = send(hooks, api.url, "s-b")
    expect(refused).rejects.toThrow("Claude 계정 AC-02의 로그인을 새로 고치지 못했어요(HTTP 400 invalid_grant) · ")
    expect(refused).rejects.toThrow("[다시 로그인]")
    await refused.catch(() => undefined)
    expect(api.seen).toHaveLength(0)
    multi.bindSession("s-a", keys[0]!)
    expect((await send(hooks, api.url, "s-a")).prepared.headers.get("authorization")).toBe("Bearer tok-ba")
    api.stop()
  })

  // CR (2026-10-26): the token endpoint answered the plugin's refresh with HTTP 429 every time (AC-01, AC-02 and AC-03
  // alike), most likely for the runtime's default `Bun/…` User-Agent; Claude Code's own refresh from the same PC reached
  // the endpoint's validation. The refresh is now Claude Code 2.1.282's request (`dae`, sent through axios).
  test("a refresh is Claude Code's request: its endpoint, headers, JSON body, client id and the login's scopes", async () => {
    const a = login(path.join(root, "shape-a"), { token: "tok-sa", refresh: "ref-sa", expiresAt: Date.now() + 30_000 })
    const b = login(path.join(root, "shape-b"), {
      token: "tok-sb",
      refresh: "ref-sb",
      expiresAt: Date.now() + 30_000,
      scopes: ["user:inference", "user:profile"],
    })
    const { hooks, multi, keys } = await plugin([a, b])
    const api = upstream(new Set())
    oauth.calls = 0
    oauth.bodies.length = 0
    oauth.answer = (refresh) =>
      new Response(
        JSON.stringify(
          refresh === "ref-sa"
            ? {
                access_token: "tok-sa2",
                refresh_token: "ref-sa2",
                expires_in: 36_000,
                refresh_token_expires_in: 2_592_000,
                scope: "user:inference user:profile user:plugins",
              }
            : { access_token: "tok-sb2", refresh_token: "ref-sb2", expires_in: 36_000 },
        ),
        { status: 200 },
      )
    multi.bindSession("s-shape-a", keys[0]!)
    multi.bindSession("s-shape-b", keys[1]!)
    expect((await send(hooks, api.url, "s-shape-a")).prepared.headers.get("authorization")).toBe("Bearer tok-sa2")
    expect((await send(hooks, api.url, "s-shape-b")).prepared.headers.get("authorization")).toBe("Bearer tok-sb2")
    const request = (refresh: string, scope: string) => ({
      type: "application/json",
      accept: "application/json, text/plain, */*",
      agent: "axios/1.15.2",
      body: {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        scope,
      },
    })
    expect(oauth.bodies).toEqual([
      // No scopes stored: Claude Code's defaults.
      request(
        "ref-sa",
        "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
      ),
      request("ref-sb", "user:inference user:profile"),
    ])
    // Written back as Claude Code writes it: the granted scopes and the refresh token's expiry when the answer has them.
    const stored = (folder: string) =>
      JSON.parse(fs.readFileSync(path.join(folder, ".credentials.json"), "utf8")).claudeAiOauth
    expect(stored(a)).toMatchObject({
      accessToken: "tok-sa2",
      refreshToken: "ref-sa2",
      scopes: ["user:inference", "user:profile", "user:plugins"],
      subscriptionType: "max",
    })
    expect(stored(a).refreshTokenExpiresAt).toBeGreaterThan(Date.now() + 2_500_000_000)
    expect(stored(b)).toMatchObject({ refreshToken: "ref-sb2", scopes: ["user:inference", "user:profile"] })
    expect(stored(b).refreshTokenExpiresAt).toBeUndefined()
    api.stop()
  })

  test("an answer without a refresh token keeps the current one, also for the 401 path's refresh", async () => {
    const a = login(path.join(root, "keep-a"), { token: "tok-ka", refresh: "ref-keep", expiresAt: Date.now() + 30_000 })
    const { hooks, multi, keys } = await plugin([a])
    oauth.calls = 0
    oauth.bodies.length = 0
    const issued = ["tok-ka2", "tok-ka3"]
    oauth.answer = () =>
      new Response(JSON.stringify({ access_token: issued.shift(), expires_in: 36_000 }), { status: 200 })
    // The API refuses the first new token: the 401 path refreshes again with the refresh token that was kept.
    const api = upstream(new Set(["tok-ka2"]))
    multi.bindSession("s-keep", keys[0]!)
    const run = await send(hooks, api.url, "s-keep")
    expect(run.response.status).toBe(200)
    expect(oauth.bodies.map((item) => (item.body as { refresh_token: string }).refresh_token)).toEqual([
      "ref-keep",
      "ref-keep",
    ])
    expect(JSON.parse(fs.readFileSync(path.join(a, ".credentials.json"), "utf8")).claudeAiOauth).toMatchObject({
      accessToken: "tok-ka3",
      refreshToken: "ref-keep",
    })
    expect(api.seen.map((item) => item.token)).toEqual(["tok-ka2", "tok-ka3"])
    api.stop()
  })

  test("concurrent 401s of one account refresh it once and write the new token back (G3)", async () => {
    const a = login(path.join(root, "flight-a"), { token: "tok-old" })
    const b = login(path.join(root, "flight-b"), { token: "tok-other" })
    const { hooks, multi, keys } = await plugin([a, b])
    const api = upstream(new Set(["tok-old"]))
    oauth.calls = 0
    oauth.answer = (refresh) =>
      refresh === "tok-old-refresh"
        ? new Response(
            JSON.stringify({ access_token: "tok-new", refresh_token: "tok-new-refresh", expires_in: 36_000 }),
            { status: 200 },
          )
        : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    multi.bindSession("s-1", keys[0]!)
    multi.bindSession("s-2", keys[0]!)
    multi.bindSession("s-3", keys[1]!)
    const runs = await Promise.all([
      send(hooks, api.url, "s-1"),
      send(hooks, api.url, "s-2"),
      send(hooks, api.url, "s-3"),
    ])
    expect(runs.map((run) => run.response.status)).toEqual([200, 200, 200])
    expect(oauth.calls).toBe(1)
    // The rotation landed in account A's own (fake) login folder, nowhere else.
    const stored = JSON.parse(fs.readFileSync(path.join(a, ".credentials.json"), "utf8"))
    expect(stored.claudeAiOauth.accessToken).toBe("tok-new")
    expect(JSON.parse(fs.readFileSync(path.join(b, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe(
      "tok-other",
    )
    expect(api.seen.filter((item) => item.token === "tok-new")).toHaveLength(2)
    expect(api.seen.filter((item) => item.token === "tok-other")).toHaveLength(1)
    api.stop()
  })

  test("Claude Code's session id is per account and conversation (G7)", async () => {
    const a = login(path.join(root, "sid-a"), { token: "tok-sa" })
    const b = login(path.join(root, "sid-b"), { token: "tok-sb" })
    const { hooks, multi, keys } = await plugin([a, b])
    const api = upstream(new Set())
    const id = async (sessionID: string) =>
      (await send(hooks, api.url, sessionID)).prepared.headers.get("x-claude-code-session-id")
    multi.bindSession("c-1", keys[0]!)
    multi.bindSession("c-2", keys[0]!)
    const first = await id("c-1")
    expect(await id("c-1")).toBe(first)
    const other = await id("c-2")
    expect(other).not.toBe(first)
    multi.bindSession("c-1", keys[1]!)
    const moved = await id("c-1")
    expect([first, other]).not.toContain(moved)
    expect(new Set([first, other, moved]).size).toBe(3)
    api.stop()
  })

  test("a refusal for extra usage passes through as it came: no retry, no long-context beta dropped (CW)", async () => {
    const a = login(path.join(root, "refuse-a"), { token: "tok-ra" })
    const { hooks, multi, keys, module } = await plugin([a])
    const excluded = module.getExcludedBetas as (model: string, key?: string) => Set<string>
    multi.bindSession("s-refuse", keys[0]!)
    for (const refusal of REFUSALS) {
      // The same refusal again for any retry: one request in all means none was sent again.
      const answer = { status: refusal.status, body: { type: "error", error: refusal.error } }
      const api = scripted([answer, answer, answer])
      const run = await send(hooks, api.url, "s-refuse")
      expect(run.response.status).toBe(refusal.status)
      expect(await run.response.text()).toContain(refusal.error.message)
      expect(api.betas).toHaveLength(1)
      expect(api.betas[0]).toContain(INTERLEAVED)
      expect([...excluded("claude-fake", keys[0])]).toEqual([])
      api.stop()
    }
    // The conversation's next request still carries every beta.
    const next = scripted([])
    expect((await send(hooks, next.url, "s-refuse")).response.status).toBe(200)
    expect(next.betas[0]).toContain(INTERLEAVED)
    next.stop()
  })

  test("a 429 refusal is not sent again even when the account's token changed meanwhile (CW)", async () => {
    const a = login(path.join(root, "refuse-rotated"), { token: "tok-rr" })
    const { hooks, multi, keys } = await plugin([a])
    multi.bindSession("s-rotated", keys[0]!)
    const refusal = REFUSALS[4]
    const answer = { status: refusal.status, body: { type: "error", error: refusal.error } }
    const api = scripted([answer, answer, answer])
    const event: Record<string, unknown> = {
      model: { providerID: "anthropic", id: "claude-fake" },
      sessionID: "s-rotated",
      request: new Request(`${api.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-fake", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
      }),
    }
    await hooks.get("http.request")!(event)
    const prepared = event.request as Request
    const initial = await fetch(prepared.clone())
    // Claude Code rotated the login in the folder while the request was out: upstream would send it again with it.
    login(a, { token: "tok-rr2" })
    const after: Record<string, unknown> = { ...event, request: prepared, response: initial }
    await hooks.get("http.response")!(after)
    expect((after.response as Response).status).toBe(429)
    expect(api.betas).toHaveLength(1)
    api.stop()
  })

  test("a genuine long-context error still drops the long-context betas one at a time and keeps them off", async () => {
    const a = login(path.join(root, "long-a"), { token: "tok-la" })
    const { hooks, multi, keys, module } = await plugin([a])
    const excluded = module.getExcludedBetas as (model: string, key?: string) => Set<string>
    multi.bindSession("s-long", keys[0]!)
    // The shape the plugin's fallback is for (its `isLongContextError`), unchanged.
    const long = {
      status: 400,
      body: {
        type: "error",
        error: { type: "invalid_request_error", message: "Extra usage is required for long context requests." },
      },
    }
    const api = scripted([long, long])
    expect((await send(hooks, api.url, "s-long")).response.status).toBe(200)
    expect(api.betas).toHaveLength(3)
    expect(api.betas[0]).toContain(INTERLEAVED)
    expect(api.betas[2]).not.toContain(INTERLEAVED)
    expect([...excluded("claude-fake", keys[0])]).toEqual([CONTEXT_1M, INTERLEAVED])
    api.stop()
  })

  test("excluded long-context betas are kept per account", async () => {
    const a = login(path.join(root, "beta-a"), { token: "tok-ea" })
    const { module, keys } = await plugin([a])
    const get = module.getExcludedBetas as (model: string, key?: string) => Set<string>
    const add = module.addExcludedBeta as (model: string, beta: string, key?: string) => void
    add("claude-fake", "context-1m", keys[0])
    expect([...get("claude-fake", keys[0])]).toEqual(["context-1m"])
    expect([...get("claude-fake", "other-account")]).toEqual([])
    // A model switch of another account leaves this one's exclusions alone.
    get("claude-other", "other-account")
    expect([...get("claude-fake", keys[0])]).toEqual(["context-1m"])
  })

  // Bug 1 (2026-10-18): the connection credential (account 1's, as `기존 로그인 가져오기` imported it) is refreshed by
  // core whenever any Claude request resolves it; it once refreshed account 1 over the network and threw "Claude OAuth
  // refresh failed. Run `claude` …" for every account's request when account 1 could not refresh.
  test("the connection's refresh reads its account's folder only: no network, never another account's token, never a failure", async () => {
    const a = login(path.join(root, "conn-a"), { token: "tok-ca" })
    const b = login(path.join(root, "conn-b"), { token: "tok-cb" })
    const expired = login(path.join(root, "conn-expired"), { token: "tok-ce", expiresAt: Date.now() - 1_000 })
    const { module } = await plugin([a, b, expired])
    const refresh = module.refreshOAuthCredential as (
      value: unknown,
      deps: unknown,
    ) => Promise<{ access: string; expires: number }>
    const deps = module.realOAuthDeps
    const credential = (configDir: string) => ({
      type: "oauth",
      methodID: "claude-code",
      access: "stale",
      refresh: "stale-refresh",
      expires: 0,
      metadata: { "opencode-claude-auth/claude-code-oauth": "v1", source: "file", configDir },
    })
    oauth.calls = 0
    expect((await refresh(credential(a), deps)).access).toBe("tok-ca")
    expect((await refresh(credential(b), deps)).access).toBe("tok-cb")
    // An account without a usable login (gone, expired, refresh token dead): the stored value stays, due again later.
    const gone = await refresh(credential(path.join(root, "conn-gone")), deps)
    expect(gone.access).toBe("stale")
    expect(gone.expires).toBeGreaterThan(Date.now() + 30 * 60_000)
    expect((await refresh(credential(expired), deps)).access).toBe("stale")
    expect(oauth.calls).toBe(0)
  })

  test("account 1's dead login does not block a conversation on another account (bug 1)", async () => {
    const a = login(path.join(root, "dead-a"), { token: "tok-da1", expiresAt: Date.now() - 60_000 })
    const b = login(path.join(root, "dead-b"), { token: "tok-db1" })
    const { hooks, multi, keys, module } = await plugin([a, b], { labels: ["AC-01", "AC-02"] })
    const api = upstream(new Set())
    oauth.answer = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    // What core does when the stored connection credential is due: the method's refresh, before the request.
    const connection = {
      type: "oauth",
      methodID: "claude-code",
      access: "connection-token",
      refresh: "connection-refresh",
      expires: Date.now() - 1,
      metadata: { "opencode-claude-auth/claude-code-oauth": "v1", source: keys[0], configDir: a },
    }
    const refresh = module.refreshOAuthCredential as (value: unknown, deps: unknown) => Promise<unknown>
    await refresh(connection, module.realOAuthDeps)
    multi.bindSession("s-two", keys[1]!)
    expect((await send(hooks, api.url, "s-two")).prepared.headers.get("authorization")).toBe("Bearer tok-db1")
    multi.bindSession("s-one", keys[0]!)
    const ran = runs().length
    await expect(send(hooks, api.url, "s-one")).rejects.toThrow("Claude 계정 AC-01")
    // CR: no `claude -p` fallback any more (a real request, a blocked service, and Claude Code clears a dead login).
    expect(runs().length).toBe(ran)
    api.stop()
  }, 30_000)

  test("an account added to the list later is picked up without a restart; nothing reads outside the list", async () => {
    const a = login(path.join(root, "late-a"), { token: "tok-la" })
    const { stateDir, hooks, multi } = await plugin([a])
    const api = upstream(new Set())
    const b = login(path.join(root, "late-b"), { token: "tok-lb" })
    // A different size or mtime: the plugin re-reads the list at the next lookup.
    await Bun.sleep(20)
    const keys = accounts(stateDir, [a, b])
    multi.bindSession("s-late", keys[1]!)
    expect((await send(hooks, api.url, "s-late")).prepared.headers.get("authorization")).toBe("Bearer tok-lb")
    expect(multi.accounts().map((item) => item.key)).toEqual(keys)
    api.stop()
  })

  // Review finding 19: a listed account whose login could not be read at first is picked up once it has one, and an
  // account is dropped only when own's list no longer names it.
  test("a listed account without a readable login is read again; a listed account is never dropped", async () => {
    const a = login(path.join(root, "again-a"), { token: "tok-aa" })
    const b = path.join(root, "again-b")
    fs.mkdirSync(b, { recursive: true })
    const { hooks, multi, keys } = await plugin([a, b])
    const api = upstream(new Set())
    expect(multi.accounts().map((item) => item.key)).toEqual([keys[0]])
    login(b, { token: "tok-ab" })
    // A's login goes away for a moment (the CLI rewriting it): A stays an account.
    fs.rmSync(path.join(a, ".credentials.json"))
    await Bun.sleep(5_100)
    expect(
      multi
        .accounts()
        .map((item) => item.key)
        .sort(),
    ).toEqual([...keys].sort())
    multi.bindSession("s-again", keys[1]!)
    expect((await send(hooks, api.url, "s-again")).prepared.headers.get("authorization")).toBe("Bearer tok-ab")
    api.stop()
  }, 20_000)

  // 02 §8.2 (user decision 2026-10-18): the plugin is always loaded, so with no Claude account it must send nothing.
  test("before own names the state folder, or without its list, the plugin holds no account and sends nothing", async () => {
    // A Claude Code login in the (temp) user profile: the plugin must not adopt it on its own.
    login(path.join(home.dir, ".claude"), { token: "tok-profile" })
    const a = login(path.join(root, "none-a"), { token: "tok-na" })
    const { stateDir, hooks, module } = await plugin([a], { configure: false })
    const api = upstream(new Set())
    oauth.calls = 0
    const ownAccounts = module.ownAccounts as () => ReadonlyArray<{ readonly key: string }>
    expect(ownAccounts()).toEqual([])
    expect(send(hooks, api.url, "s-none")).rejects.toThrow("요청을 보내지 않았습니다")
    // Named, but the list is gone: still nothing.
    fs.rmSync(path.join(stateDir, ClaudeBundle.ACCOUNTS_FILE))
    ;(module.ownUseStateDir as (dir: string) => void)(stateDir)
    expect(ownAccounts()).toEqual([])
    const bind = module.bindSession as (sessionID: string, key: string) => void
    bind("s-listless", path.resolve(a).toLowerCase())
    expect(send(hooks, api.url, "s-listless")).rejects.toThrow("요청을 보내지 않았습니다")
    await Bun.sleep(0)
    expect(api.seen).toHaveLength(0)
    expect(oauth.calls).toBe(0)
    api.stop()
  })
})

// 2026-10-30: the plugin names Claude Code's `stable` release 2.1.308 (it named 2.1.280, before Claude Code added Sonnet
// 5.5 in 2.1.284 and Haiku 5.5 in 2.1.293), Haiku 5.5 keeps its effort, and Anthropic's refusal of a Claude Code version
// below a model's minimum is told in Korean.
describe.skipIf(!from)("the Claude Code version the plugin names", () => {
  const VERSION_TEXT = "Claude Code 2.1.308 does not support this model; version 2.1.320 or newer is required"
  const POLICY_TEXT = "Claude Code 2.1.308 is older than the minimum version required by your organization's policy"
  const REFUSED = "Anthropic이 이 요청을 거절했어요(HTTP 400 claude_code_version_too_old) · "
  const REMEDY =
    "own-open-code를 최신 버전으로 업데이트하세요. 그때까지는 다른 Claude 모델이나 Anthropic API 키 계정을 쓰세요."
  /** A request as core builds it for the Claude slot: the identity block, own's system and a first user message. */
  const request = (model: string) => ({
    model,
    max_tokens: 8,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "own system prompt", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "Fix the failing test in src/app.ts, please." }],
  })

  test("the User-Agent and the billing header's cc_version are 2.1.308; the billing header is system[0], uncached", async () => {
    const a = login(path.join(root, "ver-a"), { token: "tok-va" })
    const { hooks, multi, keys } = await plugin([a])
    const api = capture()
    multi.bindSession("s-ver", keys[0]!)
    await send(hooks, api.url, "s-ver", request("claude-sonnet-5-5"))
    expect(api.seen[0]!.agent).toBe("claude-cli/2.1.308 (external, sdk-cli)")
    expect(api.seen[0]!.body.system?.[0]).toEqual({
      type: "text",
      text: expect.stringMatching(
        /^x-anthropic-billing-header: cc_version=2\.1\.308\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/,
      ),
    })
    api.stop()
  })

  // Release note: the billing header is system[0], ahead of every cached block, so the update from 2.1.280 changes the
  // prefix of every Claude-slot conversation once: its first request after the update reads no cache (only the tools
  // before it could), and the requests after it are stable again.
  test("an update from 2.1.280 changes only system[0]: one cold request per conversation, then the same bytes again", async () => {
    const a = login(path.join(root, "ver-cold"), { token: "tok-vc" })
    const { hooks, multi, keys } = await plugin([a])
    const api = capture()
    multi.bindSession("s-cold", keys[0]!)
    const saved = process.env.ANTHROPIC_CLI_VERSION
    process.env.ANTHROPIC_CLI_VERSION = "2.1.280"
    try {
      await send(hooks, api.url, "s-cold", request("claude-opus-5-5"))
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_CLI_VERSION
      else process.env.ANTHROPIC_CLI_VERSION = saved
    }
    await send(hooks, api.url, "s-cold", request("claude-opus-5-5"))
    await send(hooks, api.url, "s-cold", request("claude-opus-5-5"))
    const [before, after, again] = api.seen
    expect(before!.agent).toBe("claude-cli/2.1.280 (external, sdk-cli)")
    expect(String(before!.body.system?.[0]?.text)).toContain("cc_version=2.1.280.")
    expect(String(after!.body.system?.[0]?.text)).toContain("cc_version=2.1.308.")
    const rest = (seen: (typeof api.seen)[number]) => ({ ...seen.body, system: seen.body.system?.slice(1) })
    expect(rest(after!)).toEqual(rest(before!))
    expect(after!.text.indexOf("cc_version=")).toBe(before!.text.indexOf("cc_version="))
    expect(again!.text).toBe(after!.text)
    api.stop()
  })

  test("effort stays for Haiku 5.5 (and Sonnet and Opus 5.5) and is removed for Haiku 4.5; none gets the effort beta", async () => {
    const a = login(path.join(root, "effort-a"), { token: "tok-ef" })
    const { hooks, multi, keys } = await plugin([a])
    const api = capture()
    multi.bindSession("s-effort", keys[0]!)
    const models = [
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ]
    for (const model of models)
      await send(hooks, api.url, "s-effort", { ...request(model), output_config: { effort: "high" } })
    expect(api.seen.map((seen) => seen.body.output_config)).toEqual([
      { effort: "high" },
      { effort: "high" },
      { effort: "high" },
      undefined,
      undefined,
    ])
    expect(api.seen.flatMap((seen) => seen.betas).filter((beta) => beta.startsWith("effort-"))).toEqual([])
    api.stop()
  })

  test("Anthropic's claude_code_version_too_old is told in Korean with its remedy; status, type and code stay", async () => {
    const a = login(path.join(root, "old-a"), { token: "tok-oa" })
    const { hooks, multi, keys } = await plugin([a])
    multi.bindSession("s-old", keys[0]!)
    const refused = async (error: Record<string, unknown>) => {
      const api = scripted([{ status: 400, body: { type: "error", error } }])
      const run = await send(hooks, api.url, "s-old", request("claude-haiku-5-5"))
      // Not sent again: every request names the same version.
      expect(api.betas).toHaveLength(1)
      api.stop()
      expect(run.response.status).toBe(400)
      return (await run.response.json()) as { readonly type: string; readonly error: Record<string, unknown> }
    }
    const code = { error_code: "claude_code_version_too_old" }
    expect(await refused({ type: "invalid_request_error", message: VERSION_TEXT, details: code })).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        details: code,
        message: `${REFUSED}앱에 든 Claude 구독 플러그인이 알리는 Claude Code 버전(2.1.308)이 이 모델이 요구하는 2.1.320보다 낮아요. ${REMEDY} (원문: ${VERSION_TEXT})`,
      },
    })
    // The organization's floor, known by its words as Claude Code knows it (no code in the answer).
    expect((await refused({ type: "invalid_request_error", message: POLICY_TEXT })).error.message).toBe(
      `${REFUSED}앱에 든 Claude 구독 플러그인이 알리는 Claude Code 버전(2.1.308)이 조직 정책이 정한 최소 버전보다 낮아요. ${REMEDY} (원문: ${POLICY_TEXT})`,
    )
    // The code with words of another shape.
    const other = await refused({ type: "invalid_request_error", message: "Update required.", details: code })
    expect(other.error.message).toBe(
      `${REFUSED}앱에 든 Claude 구독 플러그인이 알리는 Claude Code 버전(2.1.308)이 Anthropic이 요구하는 최소 버전보다 낮아요. ${REMEDY} (원문: Update required.)`,
    )
    // Any other 400 comes as it came.
    const limit = { type: "invalid_request_error", message: "max_tokens: 999999 > 128000, which is the maximum" }
    expect(await refused(limit)).toEqual({ type: "error", error: limit })
  })
})

// CS (2026-10-22): a login own's list marks `readOnly` (Claude Code's own: `%USERPROFILE%\.claude`, here the temp
// profile's, or the account source's folder) is read only. A refresh by own rotated the refresh token Claude Code held:
// whichever of the two refreshed second was logged out.
describe.skipIf(!from)("a login own marks read only (Claude Code's own)", () => {
  /** The bytes and time of a fake credentials file, to show nothing wrote it. */
  const snapshot = (folder: string) => {
    const file = path.join(folder, ".credentials.json")
    return { bytes: fs.readFileSync(file, "utf8"), mtimeMs: fs.statSync(file).mtimeMs }
  }
  /** A token endpoint that would rotate the login if anyone asked it. */
  const rotating = () => {
    oauth.calls = 0
    oauth.answer = () =>
      new Response(JSON.stringify({ access_token: "tok-rotated", refresh_token: "ref-rotated", expires_in: 36_000 }), {
        status: 200,
      })
  }
  /** What Claude Code leaves for a moment while it rewrites its credentials file. */
  const halfWritten = (folder: string) =>
    fs.writeFileSync(path.join(folder, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"tok-')

  test("an expired login there is refused in plain words: no token endpoint, no write, no `claude` run, no wait", async () => {
    // Inside the refresh window: any other account would be refreshed now.
    const cc = login(path.join(home.dir, ".claude"), {
      token: "tok-cc",
      refresh: "ref-cc",
      expiresAt: Date.now() + 30_000,
    })
    const before = snapshot(cc)
    const { hooks, multi, keys, module } = await plugin([cc], { labels: ["AC-01"], readOnly: [cc] })
    const api = upstream(new Set())
    rotating()
    const ran = runs().length
    multi.bindSession("s-cc", keys[0]!)
    const refused = send(hooks, api.url, "s-cc")
    // The remedy is one request in Claude Code (an idle Claude Code never refreshes), never waiting alone.
    expect(refused).rejects.toThrow(
      "AC-01은 Claude Code와 같은 로그인을 써요. 그 로그인이 만료됐어요. Claude Code에서 요청을 한 번 보내거나, own 전용 로그인으로 바꾸세요.",
    )
    expect(String(await refused.catch((error: unknown) => error))).not.toContain("기다리")
    expect(refused).rejects.toThrow("[own 전용 로그인으로 바꾸기]")
    // A refresh token own spent earlier may have revoked Claude Code's login too (review finding 2).
    expect(refused).rejects.toThrow("Claude Code도 로그아웃됐다면 Claude Code에서 /login을 하세요.")
    await refused.catch(() => undefined)
    // The import of the connection (기존 로그인 가져오기) reads it the same way.
    const build = module.buildOAuthCredential as (source: string, deps: unknown) => Promise<{ access: string }>
    expect((await build(keys[0]!, module.realOAuthDeps)).access).toBe("tok-cc")
    // Even asked directly, the plugin's write-back refuses Claude Code's folder.
    const deps = module.realOAuthDeps as {
      writeBackCredentials: (source: string, creds: unknown, configDir: string, prior: string) => boolean
    }
    expect(
      deps.writeBackCredentials(
        keys[0]!,
        { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 9e6 },
        cc,
        "tok-cc",
      ),
    ).toBe(false)
    expect(oauth.calls).toBe(0)
    expect(runs().length).toBe(ran)
    expect(api.seen).toHaveLength(0)
    expect(snapshot(cc)).toEqual(before)
    api.stop()
  })

  // Review finding 1: own decides (the account source's folder, a junction); the plugin compares no path of its own.
  test("own's list decides: a folder outside the profile marked read only is never refreshed or written", async () => {
    const profile = login(path.join(root, "cc-profile"), {
      token: "tok-pr",
      refresh: "ref-pr",
      expiresAt: Date.now() + 30_000,
    })
    const before = snapshot(profile)
    const { hooks, multi, keys, module } = await plugin([profile], { labels: ["AC-01"], readOnly: [profile] })
    const api = upstream(new Set())
    rotating()
    const ran = runs().length
    multi.bindSession("s-profile", keys[0]!)
    await expect(send(hooks, api.url, "s-profile")).rejects.toThrow("AC-01은 Claude Code와 같은 로그인을 써요")
    const deps = module.realOAuthDeps as {
      writeBackCredentials: (source: string, creds: unknown, configDir: string, prior: string) => boolean
    }
    expect(
      deps.writeBackCredentials(
        keys[0]!,
        { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 9e6 },
        profile,
        "tok-pr",
      ),
    ).toBe(false)
    expect(oauth.calls).toBe(0)
    expect(runs().length).toBe(ran)
    expect(snapshot(profile)).toEqual(before)
    api.stop()
  })

  test("Claude Code's refresh is picked up: by the account list without a request, then by the next request", async () => {
    const cc = login(path.join(home.dir, ".claude"), { token: "tok-cc1", expiresAt: Date.now() - 60_000 })
    const { hooks, multi, keys } = await plugin([cc], { labels: ["AC-01"], readOnly: [cc] })
    const api = upstream(new Set())
    rotating()
    multi.bindSession("s-fresh", keys[0]!)
    await expect(send(hooks, api.url, "s-fresh")).rejects.toThrow("Claude Code와 같은 로그인을 써요")
    const expiry = () => multi.accounts().find((item) => item.key === keys[0])?.expiresAt ?? 0
    expect(expiry()).toBeLessThan(Date.now())
    // Claude Code refreshes its own login (a new file time).
    await Bun.sleep(20)
    login(cc, { token: "tok-cc2", refresh: "ref-cc2" })
    const written = snapshot(cc)
    expect(expiry()).toBeGreaterThan(Date.now() + 3_600_000)
    expect((await send(hooks, api.url, "s-fresh")).prepared.headers.get("authorization")).toBe("Bearer tok-cc2")
    expect(oauth.calls).toBe(0)
    expect(snapshot(cc)).toEqual(written)
    api.stop()
  })

  // Review finding 5: Claude Code rewrites its file; a read in the middle of that does not parse.
  test("a credentials file that does not parse is read once more after a moment: Claude Code's new login is sent", async () => {
    const cc = login(path.join(home.dir, ".claude"), { token: "tok-cc-half", expiresAt: Date.now() - 60_000 })
    const { hooks, multi, keys } = await plugin([cc], { labels: ["AC-01"], readOnly: [cc] })
    const api = upstream(new Set())
    rotating()
    multi.bindSession("s-half", keys[0]!)
    halfWritten(cc)
    // Claude Code finishes its write while the plugin waits for the one re-read.
    const finishing = Bun.sleep(40).then(() => login(cc, { token: "tok-cc-whole" }))
    expect((await send(hooks, api.url, "s-half")).prepared.headers.get("authorization")).toBe("Bearer tok-cc-whole")
    await finishing
    expect(oauth.calls).toBe(0)
    api.stop()
  })

  test("a credentials file that still does not parse after the re-read is refused; nothing is refreshed or written", async () => {
    const cc = login(path.join(home.dir, ".claude"), { token: "tok-cc-broken", expiresAt: Date.now() - 60_000 })
    const { hooks, multi, keys } = await plugin([cc], { labels: ["AC-01"], readOnly: [cc] })
    const api = upstream(new Set())
    rotating()
    multi.bindSession("s-broken", keys[0]!)
    halfWritten(cc)
    const before = snapshot(cc)
    const started = Date.now()
    await expect(send(hooks, api.url, "s-broken")).rejects.toThrow("AC-01은 Claude Code와 같은 로그인을 써요")
    // One re-read after the plugin's moment (150 ms), not a wait for a refresh.
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(oauth.calls).toBe(0)
    expect(api.seen).toHaveLength(0)
    expect(snapshot(cc)).toEqual(before)
    api.stop()
  })

  test("a 401 on it reads the folder again and never refreshes it; Claude Code's new token is sent once it is there", async () => {
    const cc = login(path.join(home.dir, ".claude"), { token: "tok-cc-old" })
    const { hooks, multi, keys } = await plugin([cc], { labels: ["AC-01"], readOnly: [cc] })
    const api = upstream(new Set(["tok-cc-old"]))
    rotating()
    multi.bindSession("s-401", keys[0]!)
    expect((await send(hooks, api.url, "s-401")).response.status).toBe(401)
    expect(oauth.calls).toBe(0)
    expect(JSON.parse(fs.readFileSync(path.join(cc, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe(
      "tok-cc-old",
    )
    login(cc, { token: "tok-cc-new" })
    expect((await send(hooks, api.url, "s-401")).response.status).toBe(200)
    expect(api.seen.map((item) => item.token)).toEqual(["tok-cc-old", "tok-cc-old", "tok-cc-new"])
    expect(oauth.calls).toBe(0)
    api.stop()
  })

  test("an account in an own folder beside it still refreshes, and writes only its own folder", async () => {
    const cc = login(path.join(home.dir, ".claude"), { token: "tok-cc-side" })
    const own = login(path.join(root, "own-dedicated"), {
      token: "tok-dd",
      refresh: "ref-dd",
      expiresAt: Date.now() + 30_000,
    })
    const before = snapshot(cc)
    const { hooks, multi, keys } = await plugin([cc, own], { labels: ["AC-01", "AC-02"], readOnly: [cc] })
    const api = upstream(new Set())
    rotating()
    multi.bindSession("s-own", keys[1]!)
    multi.bindSession("s-cc-side", keys[0]!)
    expect((await send(hooks, api.url, "s-own")).prepared.headers.get("authorization")).toBe("Bearer tok-rotated")
    expect((await send(hooks, api.url, "s-cc-side")).prepared.headers.get("authorization")).toBe("Bearer tok-cc-side")
    expect(oauth.calls).toBe(1)
    expect(oauth.bodies.at(-1)?.body).toMatchObject({ refresh_token: "ref-dd" })
    expect(JSON.parse(fs.readFileSync(path.join(own, ".credentials.json"), "utf8")).claudeAiOauth).toMatchObject({
      accessToken: "tok-rotated",
      refreshToken: "ref-rotated",
    })
    expect(snapshot(cc)).toEqual(before)
    api.stop()
  })
})

// CS re-review (a, b): the plugin is never fail-open on a list that lacks own's decision. The first start after an
// update finds the list an older own wrote (`version: 1`, no `readOnly`), and the plugin may read it before own's start
// rewrote it; a list of this version may miss a link own did not see. A refresh then rotated Claude Code's login.
describe.skipIf(!from)("a list without own's read-only decision", () => {
  const snapshot = (folder: string) => {
    const file = path.join(folder, ".credentials.json")
    return { bytes: fs.readFileSync(file, "utf8"), mtimeMs: fs.statSync(file).mtimeMs }
  }
  const rotating = () => {
    oauth.calls = 0
    oauth.answer = () =>
      new Response(JSON.stringify({ access_token: "tok-rotated", refresh_token: "ref-rotated", expires_in: 36_000 }), {
        status: 200,
      })
  }
  const writeBack = (module: Record<string, unknown>, key: string, folder: string, prior: string) =>
    (
      module.realOAuthDeps as {
        writeBackCredentials: (source: string, creds: unknown, configDir: string, prior: string) => boolean
      }
    ).writeBackCredentials(key, { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 9e6 }, folder, prior)

  test("an older list naming Claude Code's folder, 30 s from expiry: no token endpoint, no write (the first start after an update)", async () => {
    const cc = login(path.join(home.dir, ".claude"), {
      token: "tok-first",
      refresh: "ref-first",
      expiresAt: Date.now() + 30_000,
    })
    const before = snapshot(cc)
    const { hooks, multi, keys, module } = await plugin([cc], { labels: ["AC-01"], version: 1 })
    const api = upstream(new Set())
    rotating()
    multi.bindSession("s-first", keys[0]!)
    await expect(send(hooks, api.url, "s-first")).rejects.toThrow("AC-01은 Claude Code와 같은 로그인을 써요")
    expect(writeBack(module, keys[0]!, cc, "tok-first")).toBe(false)
    expect(oauth.calls).toBe(0)
    expect(api.seen).toHaveLength(0)
    expect(snapshot(cc)).toEqual(before)
    api.stop()
  })

  test("a list of this version without the flag: Claude Code's folders of this process stay read only (profile, CLAUDE_CONFIG_DIR, junction, hard link)", async () => {
    const ownHome = fs.mkdtempSync(path.join(root, "own-"))
    const cc = login(path.join(home.dir, ".claude"), {
      token: "tok-pf",
      refresh: "ref-pf",
      expiresAt: Date.now() + 30_000,
    })
    const configured = login(path.join(root, "cc-config-dir"), {
      token: "tok-cfg",
      refresh: "ref-cfg",
      expiresAt: Date.now() + 30_000,
    })
    const logins = path.join(ownHome, "claude-accounts")
    fs.mkdirSync(logins, { recursive: true })
    // A junction to Claude Code's folder, and an own folder whose credentials file is a hard link of Claude Code's.
    const junction = path.join(logins, "acc_junction")
    fs.symlinkSync(cc, junction, "junction")
    const linked = path.join(logins, "acc_linked")
    fs.mkdirSync(linked)
    fs.linkSync(path.join(cc, ".credentials.json"), path.join(linked, ".credentials.json"))
    const before = { cc: snapshot(cc), configured: snapshot(configured) }
    const folders = [cc, configured, junction, linked]
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configured
    try {
      const { hooks, multi, keys, module } = await plugin(folders, {
        labels: ["AC-01", "AC-02", "AC-03", "AC-04"],
        ownHome,
      })
      const api = upstream(new Set())
      rotating()
      for (const [index, folder] of folders.entries()) {
        multi.bindSession(`s-ro-${index}`, keys[index]!)
        await expect(send(hooks, api.url, `s-ro-${index}`)).rejects.toThrow("Claude Code와 같은 로그인을 써요")
        expect(writeBack(module, keys[index]!, folder, index === 1 ? "tok-cfg" : "tok-pf")).toBe(false)
      }
      expect(oauth.calls).toBe(0)
      expect(api.seen).toHaveLength(0)
      api.stop()
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
    expect({ cc: snapshot(cc), configured: snapshot(configured) }).toEqual(before)
  })

  test("an older list: a folder own made still refreshes; any other is read only until own rewrites the list", async () => {
    const ownHome = fs.mkdtempSync(path.join(root, "own-"))
    const own = login(path.join(ownHome, "claude-accounts", "acc_own"), {
      token: "tok-own",
      refresh: "ref-own",
      expiresAt: Date.now() + 30_000,
    })
    const other = login(path.join(root, "older-other"), {
      token: "tok-other",
      refresh: "ref-other",
      expiresAt: Date.now() + 30_000,
    })
    const before = snapshot(other)
    const loaded = await plugin([own, other], { labels: ["AC-02", "AC-03"], version: 1, ownHome })
    const api = upstream(new Set())
    rotating()
    loaded.multi.bindSession("s-own", loaded.keys[0]!)
    loaded.multi.bindSession("s-other", loaded.keys[1]!)
    expect((await send(loaded.hooks, api.url, "s-own")).prepared.headers.get("authorization")).toBe(
      "Bearer tok-rotated",
    )
    expect(oauth.calls).toBe(1)
    expect(JSON.parse(fs.readFileSync(path.join(own, ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe(
      "tok-rotated",
    )
    await expect(send(loaded.hooks, api.url, "s-other")).rejects.toThrow("AC-03은 Claude Code와 같은 로그인을 써요")
    expect(oauth.calls).toBe(1)
    expect(snapshot(other)).toEqual(before)
    // own's start rewrites the list (this version, nothing read only): the other account refreshes from then on.
    await Bun.sleep(20)
    accounts(loaded.stateDir, [own, other], { labels: ["AC-02", "AC-03"] })
    expect((await send(loaded.hooks, api.url, "s-other")).prepared.headers.get("authorization")).toBe(
      "Bearer tok-rotated",
    )
    expect(oauth.calls).toBe(2)
    api.stop()
  })

  // Second review (a): no account from own's list lacks a folder, but one that did (the plugin's own paths) fell back to
  // Claude Code's folder for its refresh, write-back and `claude -p`. It is read only (fail closed).
  test("an account without a folder is read only: no token endpoint, no write, no `claude` run, no wait", async () => {
    const ownHome = fs.mkdtempSync(path.join(root, "own-"))
    const beside = login(path.join(ownHome, "claude-accounts", "acc_beside"), { token: "tok-beside" })
    const { module } = await plugin([beside], { labels: ["AC-02"], ownHome })
    // Claude Code's folder of this process, empty: there is nothing to adopt, and a write there would show.
    const configured = fs.mkdtempSync(path.join(root, "folderless-config-"))
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configured
    try {
      rotating()
      const ran = runs().length
      // Inside the refresh window: an account with a folder of its own would be refreshed now.
      const account = {
        source: "folderless",
        label: "Claude",
        credentials: { accessToken: "tok-nf", refreshToken: "ref-nf", expiresAt: Date.now() + 30_000 },
      }
      const refreshIfNeeded = module.refreshIfNeeded as (account: unknown) => Promise<unknown>
      const withBackoff = module.getCredentialsWithBackoff as (options: unknown, account: unknown) => Promise<unknown>
      expect(await refreshIfNeeded(account)).toBeNull()
      const started = Date.now()
      expect(await withBackoff({}, account)).toBeNull()
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(account.credentials.accessToken).toBe("tok-nf")
      expect(oauth.calls).toBe(0)
      expect(runs().length).toBe(ran)
      expect(fs.readdirSync(configured)).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })
})

// Review finding 2: a token endpoint that is only down for now (429, 5xx, the network past the plugin's wait) is not a
// dead login; the refusal says so instead of asking for `다시 로그인` (the dead one, `invalid_grant`, is tested above).
describe.skipIf(!from)("a refresh that fails only for now", () => {
  test("is refused as a passing problem of Claude's login server, not as an expired login", async () => {
    const own = login(path.join(root, "transient-own"), {
      token: "tok-tr",
      refresh: "ref-tr",
      expiresAt: Date.now() + 30_000,
    })
    // The plugin's 45 s wait budget, shortened for this copy (read when the module loads).
    process.env.OPENCODE_CLAUDE_AUTH_REFRESH_WAIT_MS = "200"
    const loaded = await plugin([own], { labels: ["AC-02"] }).finally(() => {
      delete process.env.OPENCODE_CLAUDE_AUTH_REFRESH_WAIT_MS
    })
    const api = upstream(new Set())
    oauth.calls = 0
    oauth.answer = () => new Response(JSON.stringify({ type: "error" }), { status: 503 })
    const ran = runs().length
    loaded.multi.bindSession("s-transient", loaded.keys[0]!)
    const message = await send(loaded.hooks, api.url, "s-transient").then(
      () => "",
      (error: unknown) => String(error),
    )
    // What the endpoint said, and when the next request refreshes again (the end of the backoff).
    expect(message).toContain("Claude 로그인 서버가 잠시 답하지 못했어요(HTTP 503) · ")
    expect(message).toMatch(/\d+초 뒤 다음 요청에서 다시 새로 고쳐요\. Claude 계정 AC-02의 요청은 보내지 않았어요\.$/)
    expect(message).not.toContain("[다시 로그인]")
    expect(message).not.toContain("만료")
    expect(oauth.calls).toBeGreaterThanOrEqual(1)
    // A passing failure never falls back to `claude -p`.
    expect(runs().length).toBe(ran)
    expect(api.seen).toHaveLength(0)
    api.stop()
  }, 30_000)
})

// CR (2026-10-26): what the token endpoint answers decides. A 400, 401 or 403 is its answer to this refresh token (a
// dead grant, a nested `invalid_request_error`, a refusal page): the request is refused at once with what it said and
// `[다시 로그인]`. A 429, a 5xx or no answer is transient: the refusal says what it was and when the next request
// refreshes again. Each try is one POST, as Claude Code sends it. own hears every refresh (`ownOnRefresh`).
describe.skipIf(!from)("what the token endpoint answered", () => {
  const error = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ type: "error", error: { type, message } }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => "",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    )
  /** The events the plugin told own (`ClaudeWire` decodes them), and whether any carries a fake token. */
  const listen = (multi: ClaudeWire.Multi) => {
    const events: ClaudeWire.RefreshEvent[] = []
    multi.onRefresh((event) => events.push(event))
    return events
  }

  test("a nested 400 is terminal: refused at once with its status and error, one POST, no wait, no `claude -p`", async () => {
    const a = login(path.join(root, "nested-a"), {
      token: "tok-na4",
      refresh: "ref-na4",
      expiresAt: Date.now() - 60_000,
    })
    const b = login(path.join(root, "nested-b"), {
      token: "tok-nb4",
      refresh: "ref-nb4",
      expiresAt: Date.now() - 60_000,
    })
    // The plugin's full 45 s wait budget: a terminal answer must not wait for it.
    const { hooks, multi, keys, module } = await plugin([a, b], { labels: ["AC-02", "AC-03"] })
    const events = listen(multi)
    const api = upstream(new Set())
    oauth.calls = 0
    oauth.answer = (refresh) =>
      refresh === "ref-na4"
        ? error(400, "invalid_request_error", "Invalid request")
        : new Response("<html><body>Forbidden</body></html>", { status: 403, headers: { "content-type": "text/html" } })
    const ran = runs().length
    multi.bindSession("s-nested", keys[0]!)
    multi.bindSession("s-html", keys[1]!)
    const started = Date.now()
    const nested = await refusal(send(hooks, api.url, "s-nested"))
    const html = await refusal(send(hooks, api.url, "s-html"))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(nested).toBe(
      "Claude 계정 AC-02의 로그인을 새로 고치지 못했어요(HTTP 400 invalid_request_error) · own-open-code의 계정 화면에서 그 계정의 [다시 로그인]을 누르세요. 요청은 보내지 않았어요.",
    )
    expect(html).toStartWith("Claude 계정 AC-03의 로그인을 새로 고치지 못했어요(HTTP 403) · ")
    expect(oauth.calls).toBe(2)
    expect(runs().length).toBe(ran)
    expect(api.seen).toHaveLength(0)
    // own sees it: the account's last refresh failed for good, and why.
    const accounts = (module.ownAccounts as () => ReadonlyArray<{ key: string; refresh?: unknown }>)()
    expect(accounts.find((item) => item.key === keys[0])?.refresh).toMatchObject({
      kind: "terminal",
      status: 400,
      error: "invalid_request_error",
    })
    expect(events.map((event) => [event.type, event.type === "failed" ? event.kind : null])).toEqual([
      ["started", null],
      ["failed", "terminal"],
      ["started", null],
      ["failed", "terminal"],
    ])
    expect(events[1]).toMatchObject({ label: "AC-02", status: 400, error: "invalid_request_error", trigger: "expiry" })
    api.stop()
  }, 120_000)

  test("a 429 is transient: its reason and when the next request refreshes again; one POST, no ladder of retries", async () => {
    const a = login(path.join(root, "limited-a"), {
      token: "tok-la4",
      refresh: "ref-la4",
      expiresAt: Date.now() - 60_000,
    })
    const { hooks, multi, keys, module } = await plugin([a], { labels: ["AC-02"] })
    const events = listen(multi)
    const api = upstream(new Set())
    oauth.calls = 0
    // Longer than the wait budget: the request is refused at once instead of waiting to fail.
    oauth.answer = () => error(429, "rate_limit_error", "Rate limited", { "retry-after": "50" })
    const ran = runs().length
    multi.bindSession("s-limited", keys[0]!)
    const started = Date.now()
    const message = await refusal(send(hooks, api.url, "s-limited"))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(message).toMatch(
      /^Claude 로그인 서버가 로그인 새로 고침을 잠시 막았어요\(HTTP 429 rate_limit_error\) · (49|50)초 뒤 다음 요청에서 다시 새로 고쳐요\. Claude 계정 AC-02의 요청은 보내지 않았어요\.$/,
    )
    expect(message).not.toContain("[다시 로그인]")
    expect(oauth.calls).toBe(1)
    // The next request inside the backoff asks nothing and says the same.
    expect(await refusal(send(hooks, api.url, "s-limited"))).toContain("(HTTP 429 rate_limit_error) · ")
    expect(oauth.calls).toBe(1)
    expect(runs().length).toBe(ran)
    const refresh = (module.ownAccounts as () => ReadonlyArray<{ key: string; refresh?: { retryAt?: number } }>)().find(
      (item) => item.key === keys[0],
    )?.refresh
    expect(refresh).toMatchObject({ kind: "transient", status: 429, error: "rate_limit_error" })
    expect(refresh?.retryAt).toBeGreaterThan(Date.now() + 40_000)
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      kind: "transient",
      status: 429,
      error: "rate_limit_error",
      retryAfterMs: 50_000,
    })
    api.stop()
  }, 120_000)

  test("a short 429 is waited out within the request: the next POST after its retry-after refreshes it", async () => {
    const a = login(path.join(root, "short-a"), {
      token: "tok-sh4",
      refresh: "ref-sh4",
      expiresAt: Date.now() - 60_000,
    })
    const { hooks, multi, keys } = await plugin([a], { labels: ["AC-02"] })
    const api = upstream(new Set())
    oauth.calls = 0
    const answers = [
      () => error(429, "rate_limit_error", "Rate limited", { "retry-after": "1" }),
      () =>
        new Response(JSON.stringify({ access_token: "tok-sh5", refresh_token: "ref-sh5", expires_in: 36_000 }), {
          status: 200,
        }),
    ]
    oauth.answer = () => answers.shift()!()
    multi.bindSession("s-short", keys[0]!)
    const started = Date.now()
    expect((await send(hooks, api.url, "s-short")).prepared.headers.get("authorization")).toBe("Bearer tok-sh5")
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(oauth.calls).toBe(2)
    api.stop()
  }, 60_000)

  test("a new login in the folder (다시 로그인) ends a failed refresh, before any request", async () => {
    const a = login(path.join(root, "again-login"), {
      token: "tok-ag4",
      refresh: "ref-ag4",
      expiresAt: Date.now() - 60_000,
    })
    const { hooks, multi, keys, module } = await plugin([a], { labels: ["AC-02"] })
    const api = upstream(new Set())
    oauth.calls = 0
    oauth.answer = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    multi.bindSession("s-again", keys[0]!)
    expect(await refusal(send(hooks, api.url, "s-again"))).toContain("(HTTP 400 invalid_grant)")
    const refresh = () =>
      (module.ownAccounts as () => ReadonlyArray<{ key: string; refresh?: unknown }>)().find(
        (item) => item.key === keys[0],
      )?.refresh
    expect(refresh()).toMatchObject({ kind: "terminal" })
    // Looking again changes nothing while the folder holds the dead login.
    expect(refresh()).toMatchObject({ kind: "terminal" })
    await Bun.sleep(20)
    login(a, { token: "tok-ag5", refresh: "ref-ag5" })
    expect(refresh()).toBeUndefined()
    expect((await send(hooks, api.url, "s-again")).prepared.headers.get("authorization")).toBe("Bearer tok-ag5")
    expect(oauth.calls).toBe(1)
    api.stop()
  })

  test("what own hears holds no token, even when the endpoint's description echoes one", async () => {
    const a = login(path.join(root, "quiet-a"), {
      token: "fake-access-quiet-4711",
      refresh: "fake-refresh-quiet-4711",
      expiresAt: Date.now() - 60_000,
    })
    const { hooks, multi, keys } = await plugin([a], { labels: ["AC-02"] })
    const events = listen(multi)
    const api = upstream(new Set())
    const answers = [
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Refresh token fake-refresh-quiet-4711 is not valid for fake-access-quiet-4711",
          }),
          { status: 400 },
        ),
      () =>
        new Response(
          JSON.stringify({
            access_token: "fake-access-quiet-4712",
            refresh_token: "fake-refresh-quiet-4712",
            expires_in: 36_000,
          }),
          { status: 200 },
        ),
    ]
    oauth.answer = () => answers.shift()!()
    multi.bindSession("s-quiet", keys[0]!)
    await refusal(send(hooks, api.url, "s-quiet"))
    expect((await send(hooks, api.url, "s-quiet")).prepared.headers.get("authorization")).toBe(
      "Bearer fake-access-quiet-4712",
    )
    expect(events.map((event) => event.type)).toEqual(["started", "failed", "started", "ok"])
    expect(events[1]).toMatchObject({ description: "Refresh token [token] is not valid for [token]" })
    expect(JSON.stringify(events)).not.toContain("fake-access-quiet")
    expect(JSON.stringify(events)).not.toContain("fake-refresh-quiet")
    api.stop()
  })
})
