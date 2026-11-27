// Bug 2 (2026-10-18), end to end on this PC: the Claude account chosen for a conversation (`plugin.claudeAuth.session.set`,
// `default.set`) is the one the bundled plugin signs with, across switching back and forth, subagents and new
// conversations. own's ClaudeAccounts module binds the session (its `http.request` hook), then the real patched
// plugin's own `http.request` hook signs, and own's `http.response` hook sees the answer. CR (2026-10-26): the same
// pair with expired logins and a fake OAuth token endpoint: every account refreshes, fails and recovers the same way,
// and own's log (`own-accounts.log`) says so without a token. Fake login folders and tokens only; no request leaves the
// process.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Account, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { ClaudeAccounts } from "../../src/claude/accounts.js"
import { ClaudeLogin } from "../../src/claude/login.js"
import type { Module } from "../../src/module.js"
import type { Modules } from "../../src/modules.js"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { copy, login, source } from "../support/claude-auth-bundle.js"
import { testDeps } from "../support/deps.js"
import { ok, recordEvents, until } from "../plugins/support.js"

const from = source()
// Each test copies the bundle and loads it; the first one also loads own-accounts.
setDefaultTimeout(30_000)
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-binding-")))
const KEYS = ["USERPROFILE", "HOME", "CLAUDE_CONFIG_DIR", "PATH", "Path"] as const
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
const realFetch = globalThis.fetch
const TWO = Account.ID.make("acc_01J9CLAUDETWO0000000000000")
/** The token endpoint the patched plugin refreshes at (Claude Code's own). */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
/** The fake token endpoint: how often it was asked, and its answer to a refresh token. */
const endpoint = {
  calls: 0,
  answer: (_refresh: string): Response => new Response("{}", { status: 500 }),
}

beforeAll(() => {
  process.env.USERPROFILE = path.join(root, "profile")
  process.env.HOME = path.join(root, "profile")
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "no-login")
  process.env.PATH = path.join(root, "no-bin")
  process.env.Path = path.join(root, "no-bin")
  // SAFETY: the plugin calls the global `fetch` for its token endpoint; this file answers it and refuses anything else.
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "127.0.0.1") return realFetch(input, init)
      if (url.href !== TOKEN_URL) throw new Error(`test: unexpected request to ${url.origin}`)
      endpoint.calls++
      const body: unknown = JSON.parse(String(init?.body ?? "{}"))
      return endpoint.answer(
        typeof body === "object" && body !== null && "refresh_token" in body ? String(body.refresh_token) : "",
      )
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

type Hook = (event: Record<string, unknown>) => Promise<void> | void

/**
 * AC-01 (account 1) and AC-02 on the real bundle. `own`: account 1 on a login folder of its own (`own 전용 로그인으로
 * 바꾸기` moved it, as the user's AC-01), else on the profile's `.claude` (Claude Code's own, read only). `expired`:
 * both logins' access tokens expired (the refresh token still there).
 */
async function world(options: { readonly own?: boolean; readonly expired?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(root, "home-"))
  const expiresAt = options.expired ? Date.now() - 3_600_000 : undefined
  const one = login(path.join(home, options.own ? "cl01" : ".claude"), {
    token: "fake-access-cl01",
    refresh: "fake-refresh-cl01",
    expiresAt,
    email: "one@example.test",
    uuid: "uuid-1",
  })
  const two = login(path.join(home, "two"), {
    token: "fake-access-cl02",
    refresh: "fake-refresh-cl02",
    expiresAt,
    email: "two@example.test",
    uuid: "uuid-2",
  })
  const storage = new Map<string, unknown>()
  const parents = new Map<string, string>()
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async (input: { readonly prefix: string }) => ({
        entries: [...storage.entries()]
          .filter((entry) => entry[0].startsWith(input.prefix))
          .map((entry) => ({ key: entry[0], value: entry[1] })),
      }),
    },
    session: {
      get: async (input: { readonly sessionID: string }) => ({
        id: input.sessionID,
        parentID: parents.get(input.sessionID),
      }),
    },
    integration: { connection: { active: async () => ({ type: "credential", id: "cred_1" }) } },
  }
  const logFile = path.join(home, "logs", "own-accounts.log")
  const test = await testDeps({ ctx, control: true, leader: true, logFile })
  // The module compares expiries with its clock: the real time, as the plugin's.
  test.clock.advance(Date.now() - test.clock.now())
  const events = recordEvents(test.deps)
  const bundle = copy(root, from!)
  const info = await ClaudeBundle.read(bundle.dir)
  if (info?.state !== "patched") throw new Error("the copied bundle does not verify")
  const holder: { registry: Registry.File } = {
    registry: {
      ...Store.emptyRegistry(),
      claudeSlot: {
        accountID: "acc_claude_slot",
        label: "AC-01",
        shortLabel: "C",
        color: "orange",
        ...(options.own ? { configDir: one } : {}),
      },
      claudeAccounts: [
        {
          accountID: TWO,
          key: ClaudeLogin.key(two),
          configDir: two,
          label: "AC-02",
          shortLabel: "C2",
          color: "amber",
          managed: true,
          addedAt: "2026-10-18T00:00:00Z",
        },
      ],
    },
  }
  const alerts: Telemetry.AlertInput[] = []
  const peers: Module.Peers = () =>
    // SAFETY: the claude module uses only these members of its peers.
    ({
      plugins: {
        claudeSlot: () => ({ detected: true, version: info.version, integrity: info.integrity, verified: true }),
        bundleSettled: async () => info,
        claudeOrder: () => "ok",
      },
      slots: {
        snapshot: () => holder.registry,
        mutate: async (change: (current: Registry.File) => Registry.File | undefined) => {
          holder.registry = change(holder.registry) ?? holder.registry
          return holder.registry
        },
      },
      telemetry: { alert: (input: Telemetry.AlertInput) => alerts.push(input) },
    }) as unknown as Modules.All
  const claude = ClaudeAccounts.make(test.deps, peers, { userHome: home, login: ClaudeLogin.defaults(home) })
  await claude.start()
  // The plugin core loaded: its setup with a fake host, its hooks kept.
  const hooks = new Map<string, Hook>()
  const plugin = (await import(bundle.entry)) as { default: { setup: (context: unknown) => Promise<unknown> } }
  await plugin.default.setup({
    integration: {
      transform: async (callback: (draft: unknown) => void) =>
        callback({ update: () => {}, method: { update: () => {} } }),
      connection: {
        active: async () => ({ type: "credential", id: "cred_1" }),
        resolve: async () => ({
          type: "oauth",
          methodID: "claude-code",
          access: "connection-token",
          refresh: "connection-refresh",
          expires: Date.now() + 3_600_000,
          metadata: { "opencode-claude-auth/claude-code-oauth": "v1", source: "file" },
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
  })
  /**
   * One request as core runs the hooks: own-accounts' `http.request` (binds), then the plugin's (signs, or throws when
   * it has no token), the answer and own-accounts' `http.response`.
   */
  const send = async (sessionID: string) => {
    const event = {
      sessionID,
      agent: "build",
      kind: "context",
      model: { providerID: "anthropic", id: "claude-fake" },
      request: new Request("http://127.0.0.1:9/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-fake", max_tokens: 8, messages: [] }),
      }),
    }
    const accountID = await claude.onHttpRequest(event as unknown as Parameters<typeof claude.onHttpRequest>[0])
    await hooks.get("http.request")!(event)
    const prepared = event.request
    await claude.onHttpResponse({ ...event, request: prepared, response: new Response("{}") } as unknown as Parameters<
      typeof claude.onHttpResponse
    >[0])
    return {
      accountID,
      token: prepared.headers.get("authorization")?.replace(/^Bearer /, ""),
      signer: claude.signer(prepared),
    }
  }
  const views = () =>
    claude.views({ verified: true, version: info.version }, { windows: () => [], summary: () => ({ worst: null }) })
  return {
    claude,
    clock: test.clock,
    folders: { one, two },
    parents,
    alerts,
    events,
    logFile,
    send,
    views,
    stateDir: ClaudeBundle.stateDir(test.deps.runtime.layout.thirdparty),
    async [Symbol.asyncDispose]() {
      await claude.stop()
      await test[Symbol.asyncDispose]()
    },
  }
}

/** The refusal's words of a request the plugin did not send (`""` when it was sent). */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  )

describe.skipIf(!from)("the chosen Claude account signs (bug 2)", () => {
  test("own's list names both accounts with own's labels; the plugin holds both logins", async () => {
    await using w = await world()
    const list = JSON.parse(fs.readFileSync(path.join(w.stateDir, ClaudeBundle.ACCOUNTS_FILE), "utf8"))
    expect(list.accounts.map((item: { label: string }) => item.label)).toEqual(["AC-01", "AC-02"])
    expect((await w.send("ses_first")).token).toBe("fake-access-cl01")
  })

  test("choosing AC-02 for a conversation signs with AC-02; back and forth follows each choice", async () => {
    await using w = await world()
    expect(await w.send("ses_root")).toEqual({
      accountID: Account.ID.claudeSlot,
      token: "fake-access-cl01",
      signer: Account.ID.claudeSlot,
    })
    expect((await w.send("ses_other")).token).toBe("fake-access-cl01")
    await ok(w.claude.sessionSet, { sessionID: "ses_root" as never, accountID: TWO })
    expect(await w.send("ses_root")).toEqual({ accountID: TWO, token: "fake-access-cl02", signer: TWO })
    expect(await ok(w.claude.sessionGet, { sessionID: "ses_root" as never })).toEqual({ accountID: TWO, bound: true })
    await ok(w.claude.sessionSet, { sessionID: "ses_root" as never, accountID: Account.ID.claudeSlot })
    expect((await w.send("ses_root")).token).toBe("fake-access-cl01")
    await ok(w.claude.sessionSet, { sessionID: "ses_root" as never, accountID: TWO })
    expect((await w.send("ses_root")).token).toBe("fake-access-cl02")
    // A subagent of that conversation runs on its root's account.
    w.parents.set("ses_child", "ses_root")
    expect(await w.send("ses_child")).toEqual({ accountID: TWO, token: "fake-access-cl02", signer: TWO })
    // Another conversation keeps its own account; a new one starts on the account chosen last (02 §8.7).
    expect((await w.send("ses_other")).token).toBe("fake-access-cl01")
    expect((await w.send("ses_later")).token).toBe("fake-access-cl02")
  })

  test("a new conversation starts on the account chosen last (default.set)", async () => {
    await using w = await world()
    await ok(w.claude.defaultSet, { accountID: TWO })
    expect((await w.send("ses_new")).token).toBe("fake-access-cl02")
    await ok(w.claude.defaultSet, { accountID: Account.ID.claudeSlot })
    expect((await w.send("ses_new")).token).toBe("fake-access-cl02")
    expect((await w.send("ses_newer")).token).toBe("fake-access-cl01")
  })
})

// CR (2026-10-26), the user's question "why does AC-01 behave differently from AC-02 and AC-03": it does not. Account 1
// on a login folder of its own (the user's AC-01 after `own 전용 로그인으로 바꾸기`) and an added account take the same
// refresh, get the same refusal, show the same card and recover the same way.
describe.skipIf(!from)("every own login refreshes the same way (CR)", () => {
  const ids = [Account.ID.claudeSlot, TWO] as const
  const sessions = ["ses_one", "ses_two"] as const
  /** Binds the two conversations to AC-01 and AC-02. */
  const bind = async (w: Awaited<ReturnType<typeof world>>) => {
    await ok(w.claude.sessionSet, { sessionID: "ses_two" as never, accountID: TWO })
    await ok(w.claude.sessionSet, { sessionID: "ses_one" as never, accountID: Account.ID.claudeSlot })
  }
  const refreshOf = (w: Awaited<ReturnType<typeof world>>) =>
    w.views().map((view) => ({ id: view.id, status: view.status, refresh: view.claude?.refresh }))

  test("expired but never refreshed: ready, the first request refreshes it (not an error)", async () => {
    await using w = await world({ own: true, expired: true })
    expect(refreshOf(w)).toEqual(ids.map((id) => ({ id, status: "ready", refresh: { state: "due" } })))
  })

  test("a 429: the same transient refusal for AC-01 and AC-02, the same card, and no first-request notice", async () => {
    await using w = await world({ own: true, expired: true })
    await bind(w)
    endpoint.calls = 0
    endpoint.answer = () =>
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }), {
        status: 429,
        headers: { "retry-after": "50" },
      })
    const words = await Promise.all(sessions.map((sessionID) => refusal(w.send(sessionID))))
    const pattern = (label: string) =>
      new RegExp(
        `^Claude 로그인 서버가 로그인 새로 고침을 잠시 막았어요\\(HTTP 429 rate_limit_error\\) · \\d+초 뒤 다음 요청에서 다시 새로 고쳐요\\. Claude 계정 ${label}의 요청은 보내지 않았어요\\.$`,
      )
    expect(words[0]).toMatch(pattern("AC-01"))
    expect(words[1]).toMatch(pattern("AC-02"))
    expect(endpoint.calls).toBe(2)
    await until(() => refreshOf(w).every((view) => view.refresh?.state === "retrying"))
    for (const view of refreshOf(w))
      expect(view).toMatchObject({
        status: "ready",
        refresh: { state: "retrying", status: 429, error: "rate_limit_error" },
      })
    // Nothing was sent, so neither account had its first request.
    expect(w.alerts.filter((alert) => alert.code === "claude_first_request")).toEqual([])
  })

  test("a 400: the same terminal refusal with no wait, both cards ask for 다시 로그인; a new login recovers both", async () => {
    await using w = await world({ own: true, expired: true })
    await bind(w)
    endpoint.calls = 0
    endpoint.answer = (refresh) =>
      refresh.startsWith("fake-refresh-cl0")
        ? new Response(
            JSON.stringify({ error: "invalid_grant", error_description: `Refresh token ${refresh} revoked` }),
            {
              status: 400,
            },
          )
        : new Response("{}", { status: 500 })
    const started = Date.now()
    const words = await Promise.all(sessions.map((sessionID) => refusal(w.send(sessionID))))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(words).toEqual(
      ["AC-01", "AC-02"].map(
        (label) =>
          `Claude 계정 ${label}의 로그인을 새로 고치지 못했어요(HTTP 400 invalid_grant) · own-open-code의 계정 화면에서 그 계정의 [다시 로그인]을 누르세요. 요청은 보내지 않았어요.`,
      ),
    )
    expect(endpoint.calls).toBe(2)
    await until(() => refreshOf(w).every((view) => view.status === "needs_reauth"))
    for (const view of refreshOf(w))
      expect(view).toMatchObject({ refresh: { state: "failed", status: 400, error: "invalid_grant" } })
    expect(ids.map((id) => w.claude.usable(id))).toEqual([false, false])
    // The leader told the clients (their accounts page reads the list again).
    expect(
      w.events
        .filter((event) => event.name === "account.status" && event.payload.reason === "claude_refresh")
        .map((event) => [event.payload.accountID, event.payload.status])
        .filter((entry) => entry[1] === "needs_reauth")
        .sort(),
    ).toEqual(ids.map((id) => [id, "needs_reauth"]).sort())
    // `다시 로그인` writes a new login into each folder: the next look clears the failure, before any request.
    await Bun.sleep(20)
    login(w.folders.one, { token: "fake-access-cl01-new", refresh: "fake-refresh-new-1" })
    login(w.folders.two, { token: "fake-access-cl02-new", refresh: "fake-refresh-new-2" })
    w.clock.advance(15_000)
    await until(() => refreshOf(w).every((view) => view.status === "ready" && view.refresh === undefined))
    expect((await w.send("ses_one")).token).toBe("fake-access-cl01-new")
    expect((await w.send("ses_two")).token).toBe("fake-access-cl02-new")
    // Their first requests are the ones that were sent.
    expect(w.alerts.filter((alert) => alert.code === "claude_first_request").map((alert) => alert.accountID)).toEqual([
      ...ids,
    ])
  })

  test("own's log has every refresh, started, ok and failed, with what the endpoint said and never a token", async () => {
    await using w = await world({ own: true, expired: true })
    await bind(w)
    const answers = [
      () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Refresh token fake-refresh-cl01 is not valid" }),
          { status: 400 },
        ),
      () =>
        new Response(
          JSON.stringify({
            access_token: "fake-access-cl02-rotated",
            refresh_token: "fake-refresh-cl02-rotated",
            expires_in: 36_000,
          }),
          { status: 200 },
        ),
    ]
    endpoint.answer = () => answers.shift()!()
    expect(await refusal(w.send("ses_one"))).toContain("(HTTP 400 invalid_grant)")
    expect((await w.send("ses_two")).token).toBe("fake-access-cl02-rotated")
    const read = () => (fs.existsSync(w.logFile) ? fs.readFileSync(w.logFile, "utf8") : "")
    const lines = () =>
      read()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) =>
          ["claude_refresh_started", "claude_refresh_ok", "claude_refresh_failed"].includes(String(line.msg)),
        )
    await until(() => lines().length >= 4)
    expect(lines().map((line) => [line.scope, line.msg, line.accountID, line.label])).toEqual([
      ["own.accounts.claude", "claude_refresh_started", Account.ID.claudeSlot, "AC-01"],
      ["own.accounts.claude", "claude_refresh_failed", Account.ID.claudeSlot, "AC-01"],
      ["own.accounts.claude", "claude_refresh_started", TWO, "AC-02"],
      ["own.accounts.claude", "claude_refresh_ok", TWO, "AC-02"],
    ])
    expect(lines()[1]).toMatchObject({
      level: "warn",
      trigger: "expiry",
      kind: "terminal",
      status: 400,
      error: "invalid_grant",
      description: "Refresh token [token] is not valid",
    })
    expect(lines()[3]).toMatchObject({ level: "info", rotated: true })
    // No fake token of either account, before or after the rotation, is anywhere in the file.
    expect(read()).not.toMatch(/fake-(access|refresh)-cl0/)
  })
})
