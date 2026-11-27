import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { inspect } from "node:util"
import { CodexSource, Hash, SecretCache } from "../src/index.js"
import { ACCOUNT_A, ACCOUNT_B, chatgptTokens, clock, controlCenter, tmpdir, writeAuth } from "./fixture.js"

describe("SecretCache", () => {
  type Item = { readonly generation: number; readonly value: string }
  type Miss = { readonly ok: false; readonly problem: string }

  test("loads once per account for concurrent readers and caches until the TTL", async () => {
    const time = clock()
    const cache = new SecretCache.Cache<Item, Miss>({ ttlSeconds: 600, now: time.now })
    let loads = 0
    const loader = async () => {
      loads += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ok: true as const, value: { generation: 1, value: "fake" } }
    }
    const results = await Promise.all(Array.from({ length: 5 }, () => cache.read("acc_a", loader)))
    expect(results.every((result) => result.ok)).toBe(true)
    expect(loads).toBe(1)
    await cache.read("acc_a", loader)
    expect(loads).toBe(1)
    expect(cache.keys()).toEqual(["acc_a:1"])
    time.advance(600_000)
    await cache.read("acc_a", loader)
    expect(loads).toBe(2)
  })

  test("never replaces a newer generation, and a slow load returns the newer value", async () => {
    const cache = new SecretCache.Cache<Item, Miss>()
    const slow = cache.read("acc_a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: true, value: { generation: 1, value: "old" } }
    })
    cache.set("acc_a", { generation: 2, value: "refreshed" })
    expect(await slow).toEqual({ ok: true, value: { generation: 2, value: "refreshed" } })
    expect(cache.set("acc_a", { generation: 1, value: "old" })).toBe(false)
    expect(cache.get("acc_a")?.value).toBe("refreshed")
    cache.evict("acc_a")
    expect(cache.get("acc_a")).toBeUndefined()
  })

  test("evict cancels a load under way: it caches nothing and later readers start a new load", async () => {
    const cache = new SecretCache.Cache<Item, Miss>()
    const loads: string[] = []
    const loader = (value: string) => async () => {
      loads.push(value)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ok: true as const, value: { generation: 1, value } }
    }
    const stale = cache.read("acc_a", loader("removed"))
    cache.evict("acc_a")
    const fresh = cache.read("acc_a", loader("current"))
    expect(await stale).toEqual({ ok: true, value: { generation: 1, value: "removed" } })
    expect(await fresh).toEqual({ ok: true, value: { generation: 1, value: "current" } })
    expect(loads).toEqual(["removed", "current"])
    expect(cache.get("acc_a")?.value).toBe("current")
    cache.evict("acc_a")
    expect(cache.keys()).toEqual([])
    // A secret stored while a load runs (`replaceKey`: evict, then set) is what that load's callers get.
    const replaced = cache.read("acc_b", loader("old"))
    cache.evict("acc_b")
    cache.set("acc_b", { generation: 2, value: "new" })
    expect(await replaced).toEqual({ ok: true, value: { generation: 2, value: "new" } })
    expect(cache.get("acc_b")?.value).toBe("new")
  })

  test("TTL 0 disables caching but keeps loads single-flight; failures are not cached", async () => {
    const cache = new SecretCache.Cache<Item, Miss>({ ttlSeconds: 0 })
    let loads = 0
    const loader = async () => {
      loads += 1
      return { ok: true as const, value: { generation: 1, value: "fake" } }
    }
    await Promise.all([cache.read("acc_a", loader), cache.read("acc_a", loader)])
    await cache.read("acc_a", loader)
    expect(loads).toBe(2)
    const failing = new SecretCache.Cache<Item, Miss>()
    expect(await failing.read("acc_b", async () => ({ ok: false, problem: "not_found" }))).toEqual({
      ok: false,
      problem: "not_found",
    })
    expect(failing.keys()).toEqual([])
  })
})

describe("CodexSource.read / inspect / list", () => {
  test("parses a source without exposing token values", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const tokens = chatgptTokens(ACCOUNT_A, time.now() + 3_600_000)
    const authPath = path.join(dir.path, "auth.json")
    await writeAuth(authPath, tokens)
    const result = await CodexSource.read(authPath, { now: time.now() })
    if (!result.ok) throw new Error(result.problem)
    expect(result.snapshot.summary).toMatchObject({
      identity: {
        chatgptAccountId: ACCOUNT_A.accountId,
        sub: ACCOUNT_A.sub,
        emailMasked: "al***@example.test",
        plan: "plus",
        fingerprint: Hash.fingerprint(ACCOUNT_A.accountId, ACCOUNT_A.sub),
      },
      expiresAt: Math.floor((time.now() + 3_600_000) / 1000) * 1000,
      lastRefresh: "2026-09-26T10:11:12.123456789Z",
    })
    expect(result.snapshot.secret.access()).toBe(tokens.accessToken)
    const printed = JSON.stringify(result) + inspect(result, { depth: 10 })
    for (const value of [tokens.accessToken, tokens.refreshToken, tokens.idToken]) expect(printed).not.toContain(value)
    expect(CodexSource.parseLastRefresh("2026-09-26T10:11:12.123456789Z")).toBe(Date.UTC(2026, 8, 26, 10, 11, 12, 123))
    expect(CodexSource.parseLastRefresh("nope")).toBeUndefined()
  })

  test("classifies unusable sources", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "auth.json")
    const tokens = chatgptTokens(ACCOUNT_A, Date.now() + 3_600_000)
    const body = {
      auth_mode: "chatgpt",
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: ACCOUNT_A.accountId,
      },
    }
    const cases: Array<[unknown, CodexSource.Problem]> = [
      [undefined, "unreadable"],
      ["{torn", "parse_failed"],
      [{ auth_mode: "apikey", OPENAI_API_KEY: "sk-fake" }, "not_chatgpt"],
      [{ auth_mode: "chatgpt", tokens: null }, "missing_tokens"],
      [{ ...body, tokens: { ...body.tokens, account_id: ACCOUNT_B.accountId } }, "account_mismatch"],
      [{ ...body, tokens: { ...body.tokens, access_token: "opaque" } }, "parse_failed"],
    ]
    for (const [content, problem] of cases) {
      await fs.rm(file, { force: true })
      if (content !== undefined)
        await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
      expect(await CodexSource.read(file)).toEqual({ ok: false, problem })
    }
    await fs.writeFile(file, JSON.stringify(body))
    expect(await CodexSource.read(file, { expected: { accountId: ACCOUNT_B.accountId } })).toEqual({
      ok: false,
      problem: "account_mismatch",
    })
    // Same ChatGPT account id (e.g. a Business workspace) but another user: the C5 fingerprint differs.
    const colleague = Hash.fingerprint(ACCOUNT_A.accountId, "auth0|fake-user-c")
    expect(
      await CodexSource.read(file, { expected: { accountId: ACCOUNT_A.accountId, fingerprint: colleague } }),
    ).toEqual({ ok: false, problem: "account_mismatch" })
    const own = Hash.fingerprint(ACCOUNT_A.accountId, ACCOUNT_A.sub)
    expect((await CodexSource.read(file, { expected: { accountId: ACCOUNT_A.accountId, fingerprint: own } })).ok).toBe(
      true,
    )
    // Logins written by older Codex CLI builds have no auth_mode; they are ChatGPT logins unless an API key is set.
    const { auth_mode: _, ...legacy } = body
    await fs.writeFile(file, JSON.stringify(legacy))
    expect((await CodexSource.read(file)).ok).toBe(true)
    await fs.writeFile(file, JSON.stringify({ ...legacy, OPENAI_API_KEY: "sk-fake" }))
    expect(await CodexSource.read(file)).toEqual({ ok: false, problem: "not_chatgpt" })
    await fs.writeFile(file, "x".repeat(CodexSource.MAX_BYTES + 1))
    expect(await CodexSource.read(file)).toEqual({ ok: false, problem: "unreadable" })
  })

  test("lists control-center profiles with aliases, skipping unsafe ids", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const root = path.join(dir.path, "control-center")
    await controlCenter(root, [
      {
        id: "a1a1a1a1-0000-4000-8000-000000000001",
        alias: "personal",
        tokens: chatgptTokens(ACCOUNT_A, time.now() + 60_000),
      },
      { id: "b2b2b2b2-0000-4000-8000-000000000002", alias: null, tokens: chatgptTokens(ACCOUNT_B, time.now() - 1) },
      { id: "no-login", alias: "empty" },
      { id: "..", alias: "escape" },
    ])
    const listed = await CodexSource.list(root, { now: time.now() })
    expect(listed.available).toBe(true)
    expect(
      listed.profiles.map((profile) => [
        profile.profileID,
        profile.alias,
        profile.inspection.ok,
        profile.inspection.ok && profile.inspection.expired,
      ]),
    ).toEqual([
      ["a1a1a1a1-0000-4000-8000-000000000001", "personal", true, false],
      ["b2b2b2b2-0000-4000-8000-000000000002", null, true, true],
      ["no-login", "empty", false, false],
    ])
    expect(listed.profiles[0]?.source).toEqual({
      app: "codex-multi-provider",
      profileID: "a1a1a1a1-0000-4000-8000-000000000001",
      alias: "personal",
      authPath: path.join(root, "profiles", "a1a1a1a1-0000-4000-8000-000000000001", "codex", "auth.json"),
    })
    expect(await CodexSource.list(path.join(dir.path, "missing"))).toEqual({ available: false, profiles: [] })
  })

  test("profileHomes reads state.json only: homes from the ids, never an auth.json (SK2)", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const root = path.join(dir.path, "control-center")
    await controlCenter(root, [
      { id: "01", alias: " work ", tokens: chatgptTokens(ACCOUNT_A, time.now() + 60_000) },
      { id: "02", alias: null },
      { id: "..", alias: "escape" },
      { id: "01", alias: "twice" },
    ])
    // A `home` the file names is ignored: the home is always `profiles\<id>\codex`.
    const state = JSON.parse((await fs.readFile(path.join(root, "state.json"), "utf8")).replace(/^\uFEFF/, ""))
    state.profiles[1].home = "C:\\elsewhere"
    await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state))
    // An unreadable auth.json (a folder in its place) would fail any read of it.
    await fs.rm(path.join(root, "profiles", "01", "codex", "auth.json"))
    await fs.mkdir(path.join(root, "profiles", "01", "codex", "auth.json"), { recursive: true })
    expect(await CodexSource.profileHomes(root)).toEqual([
      { profileID: "01", alias: "work", home: path.join(root, "profiles", "01", "codex") },
      { profileID: "02", alias: null, home: path.join(root, "profiles", "02", "codex") },
    ])
    expect(await CodexSource.profileHomes(path.join(dir.path, "missing"))).toEqual([])
    await fs.writeFile(path.join(root, "state.json"), "{not json")
    expect(await CodexSource.profileHomes(root)).toEqual([])
  })
})

describe("CodexSource.Reader (linked mode)", () => {
  async function setup(expiresIn = 3_600_000) {
    const dir = await tmpdir()
    const time = clock()
    const authPath = path.join(dir.path, "profiles", "p1", "codex", "auth.json")
    const tokens = chatgptTokens(ACCOUNT_A, time.now() + expiresIn)
    await writeAuth(authPath, tokens)
    const reader = new CodexSource.Reader(authPath, {
      now: time.now,
      expected: { accountId: ACCOUNT_A.accountId, fingerprint: Hash.fingerprint(ACCOUNT_A.accountId, ACCOUNT_A.sub) },
    })
    return { dir, time, authPath, tokens, reader }
  }

  test("re-reads only after the stat interval and when mtime or size changed", async () => {
    const { dir, time, authPath, reader, tokens } = await setup()
    await using _ = dir
    const first = await reader.usable()
    expect(first.ok && first.snapshot.secret.access()).toBe(tokens.accessToken)
    const next = chatgptTokens(ACCOUNT_A, time.now() + 7_200_000)
    await writeAuth(authPath, next)
    const throttled = await reader.usable()
    expect(throttled.ok && throttled.snapshot.secret.access()).toBe(tokens.accessToken)
    time.advance(1_000)
    const reloaded = await reader.usable()
    expect(reloaded.ok && reloaded.snapshot.secret.access()).toBe(next.accessToken)
  })

  test("never writes the source file", async () => {
    const { dir, time, authPath, reader } = await setup()
    await using _ = dir
    const before = await fs.readFile(authPath, "utf8")
    const stat = await fs.stat(authPath)
    for (const step of [0, 1_000, 1_000]) {
      time.advance(step)
      await reader.usable()
      reader.reject()
      await reader.usable()
    }
    expect(await fs.readFile(authPath, "utf8")).toBe(before)
    expect((await fs.stat(authPath)).mtimeMs).toBe(stat.mtimeMs)
    expect(await fs.readdir(path.dirname(authPath))).toEqual(["auth.json"])
  })

  test("a 401 makes the source stale until the old app writes a new token", async () => {
    const { dir, time, authPath, reader } = await setup()
    await using _ = dir
    expect((await reader.usable()).ok).toBe(true)
    reader.reject()
    expect(await reader.usable()).toMatchObject({ ok: false, reason: "stale", cause: "rejected" })
    expect(reader.status().rejected).toBe(true)
    const refreshed = chatgptTokens(ACCOUNT_A, time.now() + 3_600_000)
    await writeAuth(authPath, refreshed)
    time.advance(1_000)
    const usable = await reader.usable()
    expect(usable.ok && usable.snapshot.secret.access()).toBe(refreshed.accessToken)
  })

  test("expired tokens are stale; a refresh by the old app is picked up", async () => {
    const { dir, time, authPath, reader } = await setup(30_000)
    await using _ = dir
    expect(await reader.usable()).toMatchObject({ ok: false, reason: "stale", cause: "expired" })
    await writeAuth(authPath, chatgptTokens(ACCOUNT_A, time.now() + 3_600_000))
    time.advance(1_000)
    expect((await reader.usable()).ok).toBe(true)
  })

  test("a torn write keeps the last good tokens for a few reads, then reports the problem", async () => {
    const { dir, time, authPath, reader, tokens } = await setup()
    await using _ = dir
    await reader.usable()
    await fs.writeFile(authPath, '{"auth_mode":"chatgpt","tok')
    for (const _step of [1, 2, 3]) {
      time.advance(1_000)
      const usable = await reader.usable()
      expect(usable).toMatchObject({ ok: true, degraded: true })
      expect(usable.ok && usable.snapshot.secret.access()).toBe(tokens.accessToken)
    }
    time.advance(1_000)
    expect(await reader.usable()).toEqual({ ok: false, reason: "invalid", problem: "parse_failed" })
    await writeAuth(authPath, tokens)
    time.advance(1_000)
    expect(await reader.usable()).toMatchObject({ ok: true, degraded: false })
  })

  test("a different login in the source is refused and its tokens are dropped", async () => {
    const { dir, time, authPath, reader } = await setup()
    await using _ = dir
    await reader.usable()
    await writeAuth(authPath, chatgptTokens(ACCOUNT_B, time.now() + 3_600_000))
    time.advance(1_000)
    expect(await reader.usable()).toEqual({ ok: false, reason: "invalid", problem: "account_mismatch" })
    expect(reader.status().summary).toBeUndefined()
  })

  test("concurrent callers share one read", async () => {
    const { dir, reader } = await setup()
    await using _ = dir
    const results = await Promise.all(Array.from({ length: 10 }, () => reader.usable()))
    expect(new Set(results.map((result) => result.ok && result.snapshot)).size).toBe(1)
  })
})
