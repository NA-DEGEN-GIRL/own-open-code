// Codex model metadata (07 §4.5): the Codex CLI's files on this PC, read only, and the backend layer that fetches the
// Codex model list with a codex slot's token. The backend is a fake on 127.0.0.1, the token and the ChatGPT account are
// made up, and every Codex home is a fixture folder: no test reads this PC's `.codex` or reaches a real server.

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Account, CodexModels, Compaction, type Registry } from "@own/protocol"
import { Hash } from "@own/runtime"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import { Registration } from "../../src/slots/registration.js"
import { Templates } from "../../src/slots/templates.js"
import { StoreWatch } from "../../src/slots/watch.js"
import { Modules } from "../../src/modules.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { recordEvents } from "../credentials/support.js"
import { testDeps } from "../support/deps.js"
import { catalogModel, fakeEditor, memoryStorage, registryWith, rpcContext } from "./support.js"

async function codexHome(files: Readonly<Record<string, string>>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-codex-meta-"))
  await Promise.all(Object.entries(files).map(([name, text]) => fs.writeFile(path.join(dir, name), text)))
  return { dir, [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }) }
}

/** `config.toml` as the user's Codex CLI writes it (fake values; 07 Appendix A). */
const CONFIG = [
  'model = "gpt-6-astra"',
  'model_reasoning_effort = "high"',
  'approval_policy = "on-request"',
  "",
  "[agents]",
  "max_concurrent_threads_per_session = 64",
  "",
  "[profiles.fast]",
  'model = "gpt-6-luna"',
  "",
].join("\n")

/** `models_cache.json` of Codex 0.157.0, shortened; one entry of another shape. */
const CACHE = JSON.stringify({
  fetched_at: "2026-10-01T00:00:00Z",
  etag: 'W/"fake"',
  client_version: "0.157.0",
  models: [
    {
      slug: "gpt-6-astra",
      priority: 1,
      default_reasoning_level: "medium",
      context_window: 272_000,
      max_context_window: 872_000,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    },
    { slug: "gpt-6-luna", priority: 3, default_reasoning_level: null, context_window: 272_000 },
    { slug: 42, priority: "first" },
  ],
})

/** The backend's list (07 Appendix A, the newer bundle): eight rows and one malformed row. */
const FIXTURE = await Bun.file(path.join(import.meta.dir, "fixture", "codex-models.json")).text()

describe("CodexMeta: this PC's Codex files (read only)", () => {
  test("config.toml gives only model and effort; models_cache.json becomes a pc-cache snapshot", async () => {
    await using home = await codexHome({ "config.toml": CONFIG, "models_cache.json": CACHE })
    expect(await CodexMeta.readConfig(home.dir)).toEqual({ model: "gpt-6-astra", effort: "high" })
    const cache = await CodexMeta.readCache(home.dir)
    expect(cache).toMatchObject({
      source: "pc-cache",
      fetchedAt: Date.parse("2026-10-01T00:00:00Z"),
      etag: 'W/"fake"',
      clientVersion: "0.157.0",
    })
    expect(cache?.models.map((model) => [model.slug, model.priority, model.max_context_window])).toEqual([
      ["gpt-6-astra", 1, 872_000],
      ["gpt-6-luna", 3, undefined],
    ])
  })

  test("missing or malformed files read as empty", async () => {
    await using empty = await codexHome({})
    expect(await CodexMeta.readConfig(empty.dir)).toEqual({})
    expect(await CodexMeta.readCache(empty.dir)).toBeUndefined()
    expect(await CodexMeta.readCache(path.join(empty.dir, "absent"))).toBeUndefined()
    await using broken = await codexHome({ "config.toml": 'model = "gpt-6-astra', "models_cache.json": "{ not json" })
    expect(await CodexMeta.readConfig(broken.dir)).toEqual({})
    expect(await CodexMeta.readCache(broken.dir)).toBeUndefined()
    expect(CodexMeta.parseConfig("model = 5")).toEqual({})
  })

  test("the home is the option, else CODEX_HOME, else ~/.codex (resolved, never read here)", () => {
    expect(CodexMeta.home("D:/fixture/codex", { CODEX_HOME: "D:/other" })).toBe("D:/fixture/codex")
    expect(CodexMeta.home(undefined, { CODEX_HOME: "D:/other" })).toBe("D:/other")
    expect(CodexMeta.home(undefined, {})).toBe(path.join(os.homedir(), ".codex"))
  })
})

interface Seen {
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/**
 * A fake Codex backend on 127.0.0.1 under `/backend-api/codex`: answers queued replies in order, else the standing
 * answer (`answer`), else 404.
 */
function backend() {
  const seen: Seen[] = []
  const replies: Array<(request: Request) => Response | Promise<Response>> = []
  const standing: { reply?: (request: Request) => Response } = {}
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(request.headers.entries()) })
      return (replies.shift() ?? standing.reply ?? (() => new Response("not found", { status: 404 })))(request)
    },
  })
  return {
    seen,
    replies,
    answer: (reply: (request: Request) => Response) => {
      standing.reply = reply
    },
    baseURL: `http://127.0.0.1:${server.port}/backend-api/codex`,
    list: (etag = 'W/"v1"', body = FIXTURE) =>
      replies.push(() => new Response(body, { headers: { etag, "content-type": "application/json" } })),
    stop: () => server.stop(true),
  }
}

/** The fake ChatGPT login of the codex slot (made-up values). */
const LOGIN = { accountID: "acct-meta-fixture", access: "fake-access-token-meta", email: "meta@example.test" }

/** One ready codex account; its token is in the in-memory vault. */
const CODEX = {
  kind: "codex",
  label: "ChatGPT 01",
  slug: "meta",
  identity: { chatgptAccountId: LOGIN.accountID },
} as const

/** The logged fetch failures (`codex_meta_fetch_failed`): their reason and HTTP status. */
function failures(logs: ReadonlyArray<string>) {
  return logs
    .map((line) => JSON.parse(line) as { readonly msg: string; readonly reason?: string; readonly status?: number })
    .filter((line) => line.msg === "codex_meta_fetch_failed")
    .map((line) => ({ reason: line.reason, status: line.status }))
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

/** Real slots, logins and Codex metadata modules on a temp OWN_HOME, the backend endpoint on the fake. */
async function setup(
  input: {
    readonly registry?: Registry.File
    readonly codex?: Readonly<Record<string, string>>
    readonly token?: boolean
    readonly control?: boolean
    readonly stored?: CodexModels.File
    /** The npm registry root of the Codex version check (CA); without it the check never runs. */
    readonly npmRegistry?: string
    /** How long the fake access token lives (default an hour); the CA tests move the clock by days. */
    readonly tokenMs?: number
  } = {},
) {
  const server = backend()
  const logs: string[] = []
  const reloads: number[] = []
  const t = await testDeps({
    ctx: {
      provider: { reload: async () => void reloads.push(1), list: async () => [] },
      storage: memoryStorage().storage,
    },
    control: input.control ?? true,
    logs,
    options: {
      endpoints: {
        codex: server.baseURL,
        ...(input.npmRegistry === undefined ? {} : { npmRegistry: input.npmRegistry }),
      },
    },
  })
  const home = t.deps.options.codexHome ?? ""
  await fs.mkdir(home, { recursive: true })
  await Promise.all(Object.entries(input.codex ?? {}).map(([name, text]) => fs.writeFile(path.join(home, name), text)))
  await t.deps.runtime.registry.write(input.registry ?? (await registryWith([CODEX])))
  if (input.stored) await CodexMeta.file(t.deps.runtime.layout).write(input.stored)
  if (input.token !== false)
    await t.deps.runtime.credentials.store("acc_meta", {
      type: "oauth",
      access: LOGIN.access,
      refresh: "fake-refresh-token-meta",
      expiresAt: t.clock.now() + (input.tokenMs ?? 3_600_000),
    })
  const alerts: Telemetry.AlertInput[] = []
  const modules = t.modules({
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
  })
  await modules.slots.start()
  const started = { value: false }
  return {
    t,
    deps: t.deps,
    server,
    logs,
    reloads,
    alerts,
    modules,
    meta: modules.codexMeta,
    start: async () => {
      started.value = true
      await modules.codexMeta.start()
    },
    snapshot: () => CodexMeta.snapshot(t.deps),
    stored: async () => (await Bun.file(t.deps.runtime.layout.codexMeta).json()) as CodexModels.File,
    async [Symbol.asyncDispose]() {
      if (started.value) await modules.codexMeta.stop()
      await modules.slots.stop()
      await server.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

const SOL_61 = catalogModel("openai", "gpt-6.1-sol", { limit: { context: 1_050_000, input: 922_000, output: 128_000 } })

describe("CodexMeta: the backend layer (07 §4.5)", () => {
  test("the endpoint and client_version are one constant block", () => {
    // The release the codex harness is pinned to (own/ledger/codex-pin.json, rust-v0.171.0).
    expect(CodexMeta.BACKEND).toEqual({
      path: "/models",
      clientVersion: "0.171.0",
      sessionID: "own-accounts:codex-meta",
      timeoutMs: 20_000,
    })
  })

  test("start fetches with the codex slot's token; 200 and its etag land in OWN_HOME/codex-meta.json", async () => {
    await using s = await setup()
    s.server.list('W/"v1"')
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    expect(s.server.seen).toHaveLength(1)
    const request = s.server.seen[0]
    expect(request?.path).toBe(`/backend-api/codex${CodexMeta.BACKEND.path}?client_version=0.171.0`)
    expect(request?.headers.authorization).toBe(`Bearer ${LOGIN.access}`)
    expect(request?.headers["chatgpt-account-id"]).toBe(LOGIN.accountID)
    expect(request?.headers["if-none-match"]).toBeUndefined()

    const stored = (await s.stored()).kinds.codex
    expect(stored).toMatchObject({
      source: "backend",
      fetchedAt: s.t.clock.now(),
      etag: 'W/"v1"',
      clientVersion: CodexMeta.BACKEND.clientVersion,
    })
    // Eight usable rows; the malformed one is left out, and so is every field own does not read.
    expect(stored?.models.map((model) => model.slug)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ])
    expect(Object.keys(stored?.models[0] ?? {})).not.toContain("display_name")
    expect(Object.keys(stored?.models[0] ?? {})).not.toContain("base_instructions")

    // The fold reads the snapshot from memory: gpt-6.1-sol's 872k (741,200) instead of the catalog's 922k (783,700),
    // and it is no longer unverified; providers were reloaded for it.
    expect(CodexMeta.current()?.etag).toBe('W/"v1"')
    expect(Registration.threshold("codex", {}, SOL_61, {})).toMatchObject({
      windowTokens: 872_000,
      triggerTokens: 741_200,
    })
    expect(Templates.unverifiedCodex(s.modules.slots.snapshot())).not.toContain("gpt-6.1-sol")
    expect(s.reloads.length).toBeGreaterThan(0)
    // No token, ChatGPT account id or e-mail is logged.
    const logged = s.logs.join("\n")
    expect(logged).toContain("codex_meta_fetched")
    for (const secret of [LOGIN.access, LOGIN.accountID, LOGIN.email, "fake-refresh-token-meta"])
      expect(logged).not.toContain(secret)
  })

  test("If-None-Match with the stored etag; a 304 keeps the data", async () => {
    await using s = await setup()
    s.server.list('W/"v1"')
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    const before = await s.stored()
    s.server.replies.push(() => new Response(null, { status: 304 }))
    expect(await s.meta.refresh()).toBe("not-modified")
    expect(s.server.seen.at(-1)?.headers["if-none-match"]).toBe('W/"v1"')
    expect(await s.stored()).toEqual(before)
    expect((await s.snapshot())?.etag).toBe('W/"v1"')
  })

  test("T4: a snapshot stored without the rows marker is fetched in full once, then stored with it", async () => {
    // Stored by an older build: its rows lost Codex's description when decoded, so its etag is not sent back.
    const rows = JSON.parse(FIXTURE).models.slice(0, 2)
    await using s = await setup({
      stored: {
        version: 1,
        kinds: { codex: { source: "backend", fetchedAt: 1, etag: 'W/"old"', clientVersion: "0.157.0", models: rows } },
      },
    })
    s.server.list('W/"v2"')
    await s.start()
    await until(async () => (await s.snapshot())?.etag === 'W/"v2"')
    expect(s.server.seen[0]?.headers["if-none-match"]).toBeUndefined()
    const stored = (await s.stored()).kinds.codex
    expect(stored?.rows).toBe(CodexModels.ROWS)
    expect(stored?.models[0]?.description).toBe("Fixture row (07 Appendix A, the newer bundle).")
    // Marked now: the next refresh sends the etag, also when the backend sends no description at all.
    s.server.replies.push(() => new Response(null, { status: 304 }))
    expect(await s.meta.refresh()).toBe("not-modified")
    expect(s.server.seen.at(-1)?.headers["if-none-match"]).toBe('W/"v2"')
    const bare = JSON.stringify({
      models: JSON.parse(FIXTURE).models.map((row: Record<string, unknown>) => ({ ...row, description: undefined })),
    })
    s.server.list('W/"v3"', bare)
    expect(await s.meta.refresh()).toBe("updated")
    s.server.replies.push(() => new Response(null, { status: 304 }))
    expect(await s.meta.refresh()).toBe("not-modified")
    expect(s.server.seen.at(-1)?.headers["if-none-match"]).toBe('W/"v3"')
  })

  test("401, 5xx and a network failure keep the last value and say so once per reason", async () => {
    await using s = await setup()
    s.server.list('W/"v1"')
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    const before = await s.stored()
    s.server.replies.push(() => new Response("{}", { status: 401 }))
    expect(await s.meta.refresh()).toBe("failed")
    s.server.replies.push(() => new Response("upstream", { status: 503 }))
    expect(await s.meta.refresh()).toBe("failed")
    expect(await s.stored()).toEqual(before)
    expect((await s.snapshot())?.etag).toBe('W/"v1"')
    expect(failures(s.logs)).toEqual([
      { reason: "status", status: 401 },
      { reason: "status", status: 503 },
    ])
    // Logged, not alerted, until the endpoint is verified live (⚠PG7 (나)).
    expect(s.alerts.filter((alert) => alert.code === "codex_meta_unavailable")).toEqual([])
    // The account is not marked as failing for it: the endpoint's answer says nothing about the token (⚠PG7).
    expect(s.modules.slots.account("acc_meta")?.status).toBe("ready")
    await s.server.stop()
    expect(await s.meta.refresh()).toBe("failed")
    expect((await s.snapshot())?.etag).toBe('W/"v1"')
  })

  test("a timeout keeps the last value (fetchList)", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(2_000)
        return new Response(FIXTURE)
      },
    })
    const result = await CodexMeta.fetchList({
      baseURL: `http://127.0.0.1:${server.port}/backend-api/codex`,
      headers: { authorization: "Bearer fake" },
      clientVersion: CodexMeta.BACKEND.clientVersion,
      now: 1,
      timeoutMs: 50,
    })
    await server.stop(true)
    expect(result).toEqual({ type: "failed", reason: "timeout" })
  })

  test("a malformed body is ignored: not JSON, no model list, an empty list", async () => {
    await using s = await setup()
    s.server.list('W/"v1"')
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    const before = await s.stored()
    for (const body of ["<html>", JSON.stringify({ data: [] }), JSON.stringify({ models: [] })]) {
      s.server.list('W/"v2"', body)
      expect(await s.meta.refresh()).toBe("failed")
    }
    expect(await s.stored()).toEqual(before)
    expect(failures(s.logs)).toEqual(Array.from({ length: 3 }, () => ({ reason: "malformed", status: 200 })))
  })

  test("no ready codex slot: no request, the PC's models_cache.json is the snapshot", async () => {
    await using s = await setup({
      registry: await registryWith([{ ...CODEX, status: "needs_reauth" }]),
      codex: { "models_cache.json": CACHE },
    })
    await s.start()
    expect(await s.meta.refresh()).toBe("no-slot")
    expect(s.server.seen).toEqual([])
    expect((await s.snapshot())?.source).toBe("pc-cache")
    expect((await CodexMeta.hints(s.deps)).models).toEqual([
      { slug: "gpt-6-astra", priority: 1, defaultEffort: "medium" },
      { slug: "gpt-6-luna", priority: 3 },
    ])
    // A ready slot whose token is gone fetches nothing either.
    await using u = await setup({ token: false })
    await u.start()
    expect(await u.meta.refresh()).toBe("no-slot")
    expect(u.server.seen).toEqual([])
  })

  test("a fetched snapshot wins over the PC cache until it is replaced", async () => {
    await using s = await setup({ codex: { "models_cache.json": CACHE } })
    expect((await s.snapshot())?.source).toBe("pc-cache")
    s.server.list('W/"v1"')
    expect(await s.meta.refresh()).toBe("updated")
    expect((await s.snapshot())?.source).toBe("backend")
    expect((await CodexMeta.hints(s.deps)).models?.[0]).toEqual({
      slug: "gpt-6.1-sol",
      priority: 1,
      defaultEffort: "low",
    })
  })

  test("nothing at all: no snapshot, and every consumer's no-metadata rule", async () => {
    await using s = await setup({ registry: await registryWith([]) })
    await s.start()
    expect(await s.snapshot()).toBeUndefined()
    expect(CodexMeta.current()).toBeUndefined()
    expect(await CodexMeta.hints(s.deps)).toEqual({ models: [] })
    // Outside the stand-in list the catalog window stays, unverified (07 §6.2 #4).
    expect(Templates.codexLimit(SOL_61)).toBeUndefined()
    expect(Registration.threshold("codex", {}, SOL_61, {})).toMatchObject({ triggerTokens: 783_700 })
  })

  test("refresh on start and on accounts.update{refreshCatalog}; a non-control Location never fetches", async () => {
    await using s = await setup()
    s.server.list('W/"v1"')
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    expect(s.server.seen).toHaveLength(1)
    s.server.replies.push(() => new Response(null, { status: 304 }))
    const updated = await s.modules.slots.update(
      { accountID: Account.ID.make("acc_meta"), refreshCatalog: true },
      rpcContext(),
    )
    expect(updated).toHaveProperty("account")
    await until(() => s.server.seen.length === 2)
    expect(s.server.seen[1]?.headers["if-none-match"]).toBe('W/"v1"')
    // Another account change (a label) captures no catalog: no fetch.
    await s.modules.slots.update({ accountID: Account.ID.make("acc_meta"), label: "ChatGPT 1" }, rpcContext())
    await Bun.sleep(50)
    expect(s.server.seen).toHaveLength(2)

    await using other = await setup({ control: false })
    other.server.list('W/"v1"')
    await other.start()
    await Bun.sleep(50)
    expect(other.server.seen).toEqual([])
  })

  test("effort_update_drift once per model where the metadata and own's upstream mirror disagree", async () => {
    await using s = await setup()
    // Upstream's rule covers GPT-6 and later (91b9bc52a4), so every row of the fixture agrees with own's mirror; this
    // list has gpt-5.5 claim updates the mirror denies. A row that says nothing never drifts.
    const fixture = JSON.parse(FIXTURE) as { models: Array<{ slug: string }> }
    const models = fixture.models.map((row) =>
      row.slug === "gpt-5.5" ? { ...row, supports_reasoning_effort_updates: true } : row,
    )
    s.server.list('W/"v1"', JSON.stringify({ ...fixture, models }))
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    const drift = () => s.alerts.filter((alert) => alert.code === "effort_update_drift")
    expect(drift().map((alert) => alert.subject)).toEqual(["gpt-5.5"])
    s.server.list('W/"v2"')
    expect(await s.meta.refresh()).toBe("updated")
    s.deps.runtime.broadcast.emit("store.changed", { store: "codex-meta", origin: "external" })
    await Bun.sleep(20)
    expect(drift()).toHaveLength(1)
  })

  test("another instance's write is taken on store.changed{codex-meta}; the watcher reports outside writes", async () => {
    await using s = await setup({ registry: await registryWith([]) })
    await s.start()
    expect(await s.snapshot()).toBeUndefined()
    const reloads = s.reloads.length
    const rows = JSON.parse(FIXTURE).models.slice(0, 1)
    const written: CodexModels.File = {
      version: 1,
      kinds: { codex: { source: "backend", fetchedAt: 1, etag: 'W/"x"', clientVersion: "0.157.0", models: rows } },
    }
    const seen: string[] = []
    const off = s.deps.runtime.broadcast.on("store.changed", (payload) =>
      seen.push(`${payload.store}:${payload.origin}`),
    )
    // Another process writes the file: the store watcher (slots) broadcasts it once it settled.
    await Bun.write(s.deps.runtime.layout.codexMeta, JSON.stringify(written))
    await until(() => {
      s.t.clock.advance(StoreWatch.DEBOUNCE_MS)
      return seen.includes("codex-meta:external")
    })
    off()
    await until(async () => (await s.snapshot())?.etag === 'W/"x"')
    expect(s.reloads.length).toBeGreaterThan(reloads)
    // The fold reads it from memory.
    expect(Templates.limit("codex", SOL_61).input).toBe(872_000)
  })
})

describe("CodexMeta with the fold (07 §6.2 #4, PG6)", () => {
  test("Templates read the stored snapshot through the default parameter; siwc never does", async () => {
    await using s = await setup({
      stored: {
        version: 1,
        kinds: {
          codex: {
            source: "backend",
            fetchedAt: 1,
            models: [{ slug: "gpt-6.1-sol", max_context_window: 872_000 }],
          },
        },
      },
      registry: await registryWith([]),
    })
    await s.start()
    expect(Templates.limit("codex", SOL_61)).toEqual({ context: 1_000_000, input: 872_000, output: 128_000 })
    expect(Templates.limit("siwc", SOL_61)).toEqual(SOL_61.limit)
    expect(
      Compaction.resolve(Compaction.chain({ kind: "codex", modelID: "gpt-6.1-sol" }), Templates.limit("codex", SOL_61)),
    ).toMatchObject({ triggerTokens: 741_200 })
  })
})

/** A server on 127.0.0.1 that takes every request and never answers it: a stalled network path. */
function stalled() {
  const seen: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push(new URL(request.url).pathname)
      return new Promise<Response>(() => {})
    },
  })
  return { seen, url: `http://127.0.0.1:${server.port}`, [Symbol.asyncDispose]: () => server.stop(true) }
}

/** Resolves to `done` when `work` settles within `ms`, else `waiting`. */
function within(work: Promise<unknown>, ms = 2_000) {
  return Promise.race([work.then(() => "done" as const), Bun.sleep(ms).then(() => "waiting" as const)])
}

describe("CodexMeta never holds up the model list (plugin setup and the provider fold)", () => {
  /** Fetched before: gpt-6.1-sol's Codex window, unlike the catalog's 922k and the stand-in list's 872k. */
  const STORED: CodexModels.File = {
    version: 1,
    kinds: {
      codex: { source: "backend", fetchedAt: 1, models: [{ slug: "gpt-6.1-sol", max_context_window: 800_000 }] },
    },
  }

  for (const stall of ["the npm registry", "the Codex model list"] as const)
    test(`${stall} never answering: start resolves at once and the fold registers the stored snapshot`, async () => {
      await using network = stalled()
      await using s = await setup({
        stored: STORED,
        ...(stall === "the npm registry" ? { npmRegistry: network.url } : {}),
      })
      const seen = stall === "the npm registry" ? network.seen : s.server.seen
      if (stall === "the Codex model list") s.server.replies.push(() => new Promise<Response>(() => {}))
      // Module start is what plugin setup, and with it every `GET /api/model` (server `awaitPlugins`), waits for.
      expect(await within(s.start())).toBe("done")
      await until(() => seen.length > 0)
      expect(CodexMeta.current()?.models).toEqual(STORED.kinds.codex?.models)
      const fold = fakeEditor({ openai: { models: [SOL_61] } })
      s.modules.slots.transformProviders(fold.editor)
      expect(fold.records.get("own-codex-meta")?.models.get("gpt-6.1-sol")?.limit.context).toBe(928_000)
      expect(s.modules.slots.model("own-codex-meta", "gpt-6.1-sol")?.limit).toEqual({
        context: 928_000,
        input: 800_000,
        output: 128_000,
      })
      // Still unanswered; stopping cancels it instead of waiting for its timeout.
      expect(seen).toHaveLength(1)
      expect(await within(s.meta.stop())).toBe("done")
    })
})

describe("CodexMeta: each account's own list (02 §4.8)", () => {
  /** A second ChatGPT login (made-up values) whose plan lists only Fast. */
  const SECOND = { accountID: "acct-meta-second", access: "fake-access-token-meta-2" }
  const listFor = (accountID: string | null) =>
    JSON.stringify({
      models: [
        {
          slug: "gpt-6-astra",
          max_context_window: 872_000,
          service_tiers:
            accountID === SECOND.accountID
              ? [{ id: "priority", name: "Fast" }]
              : [
                  { id: "priority", name: "Fast", description: "2x speed, increased usage" },
                  { id: "ultrafast", name: "Ultrafast" },
                ],
        },
      ],
    })

  test("every codex account is asked with its own token and etag; a list read again lifts its refused tiers", async () => {
    await using s = await setup({
      registry: await registryWith([
        CODEX,
        { kind: "codex", label: "ChatGPT 02", slug: "meta2", identity: { chatgptAccountId: SECOND.accountID } },
      ]),
    })
    await s.t.deps.runtime.credentials.store("acc_meta2", {
      type: "oauth",
      access: SECOND.access,
      refresh: "fake-refresh-token-meta-2",
      expiresAt: s.t.clock.now() + 3_600_000,
    })
    const answer = (request: Request) => {
      const account = request.headers.get("chatgpt-account-id")
      return new Response(listFor(account), {
        headers: { etag: account === SECOND.accountID ? 'W/"two"' : 'W/"one"', "content-type": "application/json" },
      })
    }
    s.server.replies.push(answer, answer)
    s.deps.runtime.speed.mark("acc_meta2", "gpt-6-astra", {
      tier: "ultrafast",
      status: "unavailable",
      reason: "status_400",
    })
    s.deps.runtime.speed.mark("acc_meta2", "gpt-6-astra", {
      tier: "priority",
      status: "cooldown",
      reason: "status_429",
      until: s.t.clock.now() + 60_000,
    })
    await s.start()
    await until(
      async () =>
        (await Bun.file(s.deps.runtime.layout.codexMeta).exists()) &&
        Object.keys((await s.stored()).accounts ?? {}).length === 2,
    )
    const stored = await s.stored()
    // The kind snapshot stays the first account's; each account keeps its own list and etag.
    expect(stored.kinds.codex?.etag).toBe('W/"one"')
    expect(stored.accounts?.acc_meta?.etag).toBe('W/"one"')
    expect(stored.accounts?.acc_meta2?.etag).toBe('W/"two"')
    const tiers = async (accountID: string) =>
      (await CodexMeta.accountModel(s.deps, accountID, "gpt-6-astra"))?.service_tiers?.map((tier) => tier.id)
    expect(await tiers("acc_meta")).toEqual(["priority", "ultrafast"])
    expect(await tiers("acc_meta2")).toEqual(["priority"])
    // The refusal is lifted by the new list; a cooldown runs on.
    expect(s.deps.runtime.speed.marks("acc_meta2", "gpt-6-astra").map((mark) => mark.status)).toEqual(["cooldown"])
    // Each account's token went to its own request; none is logged.
    const accounts = s.server.seen.map((request) => request.headers["chatgpt-account-id"]).sort()
    expect(accounts).toEqual([LOGIN.accountID, SECOND.accountID].sort())
    expect(s.logs.join("\n")).not.toContain(SECOND.access)

    // The next refresh sends each account's own etag.
    const notModified = () => new Response(null, { status: 304 })
    s.server.replies.push(notModified, notModified)
    expect(await s.meta.refresh()).toBe("not-modified")
    const etags = s.server.seen
      .slice(-2)
      .map((request) => [request.headers["chatgpt-account-id"], request.headers["if-none-match"]])
      .sort()
    expect(etags).toEqual(
      [
        [LOGIN.accountID, 'W/"one"'],
        [SECOND.accountID, 'W/"two"'],
      ].sort(),
    )
  })
})

/**
 * A fake npm registry on 127.0.0.1 (CA): queued replies first, else `@openai/codex`'s `latest` manifest with
 * `latest.version`, shaped like the live one (2026-10-19) and shortened; own reads only `version`.
 */
function fakeRegistry(version = "0.172.0") {
  const seen: Seen[] = []
  const replies: Array<() => Response> = []
  const latest = { version }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(request.headers.entries()) })
      const queued = replies.shift()
      if (queued) return queued()
      if (url.pathname !== CodexMeta.LATEST.path) return new Response("not found", { status: 404 })
      return Response.json({
        name: "@openai/codex",
        version: latest.version,
        license: "Apache-2.0",
        dist: { tarball: "https://registry.example.test/codex.tgz" },
      })
    },
  })
  return {
    seen,
    replies,
    latest,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    [Symbol.asyncDispose]: () => server.stop(true),
  }
}

/** The fixture's rows, the malformed one left out. */
const LISTED: ReadonlyArray<Record<string, unknown>> = JSON.parse(FIXTURE).models.filter(
  (row: Record<string, unknown>) => typeof row.slug === "string",
)
/**
 * A model the backend lists from Codex 0.172.0 on (made up), with every harness value own handles; its slug extends a
 * slug of the harness's bundled catalog (`gpt-6.1-sol`), so own knows it.
 */
const NEWER = {
  slug: "gpt-6.1-sol-next",
  display_name: "GPT-6.1 Sol Next",
  visibility: "list",
  minimal_client_version: "0.172.0",
  priority: 1,
  max_context_window: 900_000,
  default_reasoning_level: "low",
  shell_type: "shell_command",
  apply_patch_tool_type: "freeform",
  truncation_policy: { mode: "tokens", limit: 10_000 },
}
/** From 0.172.0 on too, with an apply_patch tool own's Codex harness does not have: left out and counted. */
const UNKNOWN = {
  slug: "gpt-7-preview",
  display_name: "GPT-7 Preview",
  visibility: "list",
  minimal_client_version: "0.172.0",
  priority: 2,
  apply_patch_tool_type: "json_patch",
}
/**
 * From 0.172.0 on too, a model the bundled catalog does not know, whose served row the harness can run: kept, not
 * counted, its harness row taken (10 §6.14).
 */
const RUNTIME = {
  ...NEWER,
  slug: "gpt-6.9-sol",
  display_name: "GPT-6.9 Sol",
  priority: 3,
  model_messages: { instructions_template: "You are Codex. (fixture)" },
}
/** The same, but with a web search provider the harness does not reproduce: left out and counted with that field. */
const UNCATALOGUED = { ...RUNTIME, slug: "gpt-6.9-nova", display_name: "GPT-6.9 Nova", priority: 4, web_search_provider: "search_mcp" }
/**
 * A retired model the backend still lists at every version: no longer in the bundled catalog, but an older model, not
 * one own does not know yet, so its row stays (its upgrade hint and window) and is not counted.
 */
const RETIRED = {
  slug: "gpt-5.4",
  display_name: "GPT-5.4",
  visibility: "list",
  priority: 9,
  max_context_window: 272_000,
  upgrade: { model: "gpt-6-sol", retirement_at: null },
}
/** Hidden from every Codex client: never counted, whatever it holds. */
const HIDDEN = { slug: "gpt-reserve", visibility: "hide", minimal_client_version: "0.172.0", shell_type: "pty_v2" }

/**
 * The backend's gating as the live one does it: only the rows whose `minimal_client_version` the asking
 * `client_version` reaches, with one etag per version (a 304 for it).
 */
function gated(request: Request) {
  const asked = new URL(request.url).searchParams.get("client_version") ?? "0.0.0"
  const etag = `W/"list-${asked}"`
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 })
  const models = [...LISTED, RETIRED, NEWER, UNKNOWN, RUNTIME, UNCATALOGUED, HIDDEN].filter(
    (row: Record<string, unknown>) =>
      typeof row.minimal_client_version !== "string" || Bun.semver.order(row.minimal_client_version, asked) <= 0,
  )
  return Response.json({ models }, { headers: { etag } })
}

const DAY = CodexMeta.LATEST.everyMs
const BUILD = CodexMeta.BACKEND.clientVersion
const asked = (request: Seen | undefined) =>
  request && new URL(request.path, "http://backend.test").searchParams.get("client_version")
const slugs = (snapshot: CodexModels.Snapshot | undefined) => snapshot?.models.map((model) => model.slug) ?? []
/** The log lines of one message. */
const logged = (logs: ReadonlyArray<string>, msg: string) =>
  logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg)

describe("CodexMeta: the newest Codex release (07 §4.5, CA)", () => {
  test("release() is Codex's whole version; clientVersion() never asks lower, and off asks as this build", () => {
    expect(CodexMeta.release("0.165.0")).toBe("0.165.0")
    // The `latest` tag carrying a pre-release is asked as `client_version_to_whole()` asks.
    expect(CodexMeta.release("0.172.0-alpha.3")).toBe("0.172.0")
    expect(CodexMeta.release("1.0.0+build.7")).toBe("1.0.0")
    for (const value of ["0.165", "v0.165.0", "latest", "", "0.165.0.1", "1.2.x", undefined])
      expect(CodexMeta.release(value)).toBeUndefined()
    expect(CodexMeta.newer("0.165.0", "0.164.0")).toBe(true)
    expect(CodexMeta.newer("0.164.10", "0.164.9")).toBe(true)
    expect(CodexMeta.newer("1.0.0", "0.999.999")).toBe(true)
    expect(CodexMeta.newer("0.164.0", "0.164.0")).toBe(false)
    expect(CodexMeta.newer("0.163.9", "0.164.0")).toBe(false)
    expect(CodexMeta.clientVersion(undefined)).toBe(BUILD)
    expect(CodexMeta.clientVersion({ latest: { version: "0.172.0", fetchedAt: 1 } })).toBe("0.172.0")
    expect(CodexMeta.clientVersion({ latest: { version: "0.163.0", fetchedAt: 1 } })).toBe(BUILD)
    expect(CodexMeta.clientVersion({ latest: { version: "0.172.0", fetchedAt: 1 }, autoVersion: false })).toBe(BUILD)
    expect(CodexMeta.clientVersion({ latest: { version: "0.172.0", fetchedAt: 1 }, autoVersion: true })).toBe("0.172.0")
  })

  test("the registry read: one GET of the latest manifest with accept and a fixed user-agent, nothing of the user", async () => {
    await using registry = fakeRegistry("0.172.0-alpha.1")
    expect(await CodexMeta.fetchLatest({ registry: `${registry.url}/` })).toEqual({ type: "ok", version: "0.172.0" })
    expect(registry.seen.map((request) => request.path)).toEqual(["/@openai/codex/latest"])
    const headers = registry.seen[0]?.headers ?? {}
    expect(headers["user-agent"]).toBe(CodexMeta.LATEST.userAgent)
    expect(CodexMeta.LATEST.userAgent).toStartWith("own-open-code/")
    expect(headers.accept).toBe("application/json")
    for (const name of ["authorization", "cookie", "chatgpt-account-id", "session-id", "originator"])
      expect(headers[name]).toBeUndefined()
    registry.replies.push(
      () => new Response("{}", { status: 503 }),
      () => Response.json({ version: "next" }),
      () => new Response("<html>"),
    )
    expect(await CodexMeta.fetchLatest({ registry: registry.url })).toEqual({
      type: "failed",
      reason: "status",
      status: 503,
    })
    for (const _ of [1, 2])
      expect(await CodexMeta.fetchLatest({ registry: registry.url })).toEqual({
        type: "failed",
        reason: "malformed",
        status: 200,
      })
    const slow = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(2_000)
        return Response.json({ version: "0.170.0" })
      },
    })
    const timedOut = await CodexMeta.fetchLatest({ registry: `http://127.0.0.1:${slow.port}`, timeoutMs: 50 })
    await slow.stop(true)
    expect(timedOut).toEqual({ type: "failed", reason: "timeout" })
  })

  test("a start reads the newest release first and asks as it: a model gated at that version appears", async () => {
    await using registry = fakeRegistry("0.172.0")
    await using s = await setup({ npmRegistry: registry.url })
    const events = recordEvents(s.deps)
    s.server.answer(gated)
    await s.start()
    await until(async () => (await s.snapshot())?.clientVersion === "0.172.0")
    expect(registry.seen).toHaveLength(1)
    expect(s.server.seen.map(asked)).toEqual(["0.172.0"])
    const snapshot = await s.snapshot()
    // The new model's row is there, with its own window; the one own cannot run and the one its Codex catalog does not
    // know are left out and counted; the hidden one is neither kept nor counted. A retired model's row stays uncounted.
    expect(slugs(snapshot)).toContain(NEWER.slug)
    expect(CodexMeta.current()?.models.find((model) => model.slug === RETIRED.slug)?.upgrade?.model).toBe("gpt-6-sol")
    expect(CodexMeta.current()?.models.find((model) => model.slug === NEWER.slug)?.max_context_window).toBe(900_000)
    expect(slugs(snapshot)).not.toContain("gpt-7-preview")
    expect(slugs(snapshot)).not.toContain(UNCATALOGUED.slug)
    // The new model whose row the harness can run is kept, with its harness row on the shared list (10 §6.14).
    expect(slugs(snapshot)).toContain(RUNTIME.slug)
    expect(snapshot?.harness?.map((row) => row.slug)).toContain(RUNTIME.slug)
    expect(s.meta.rows().rows?.find((row) => row.slug === RUNTIME.slug)?.model_messages.instructions_template).toBe(
      "You are Codex. (fixture)",
    )
    expect(s.meta.rows(s.meta.rows().revision)).toEqual({ revision: s.meta.rows().revision })
    expect(slugs(snapshot)).not.toContain("gpt-reserve")
    expect(snapshot?.rejected).toBe(2)
    const stored = await s.stored()
    expect(stored.latest).toEqual({ version: "0.172.0", fetchedAt: s.t.clock.now() })
    expect(stored.kinds.codex).toMatchObject({ clientVersion: "0.172.0", rows: CodexModels.ROWS, rejected: 2 })
    const view = {
      autoVersion: true,
      version: "0.172.0",
      build: BUILD,
      latest: { version: "0.172.0", fetchedAt: s.t.clock.now() },
      fetchedAt: s.t.clock.now(),
      rejected: 2,
      accounts: { acc_meta: 2 },
      left: [
        { slug: "gpt-7-preview", field: "apply_patch_tool_type", value: '"json_patch"' },
        { slug: "gpt-6.9-nova", field: "web_search_provider", value: '"search_mcp"' },
      ],
      accountLeft: {
        acc_meta: [
          { slug: "gpt-7-preview", field: "apply_patch_tool_type", value: '"json_patch"' },
          { slug: "gpt-6.9-nova", field: "web_search_provider", value: '"search_mcp"' },
        ],
      },
      borrowed: [],
    }
    expect(s.meta.view()).toEqual(view)
    // `codexModels.changed` follows: the release read, then the list.
    await until(() => events.some((event) => event.name === "codexModels.changed" && event.payload.view !== undefined))
    expect(events.filter((event) => event.name === "codexModels.changed").at(-1)?.payload).toMatchObject({ view })
    expect(logged(s.logs, "codex_version_checked")).toEqual([
      expect.objectContaining({ latest: "0.172.0", clientVersion: "0.172.0" }),
    ])
  })

  test("a release older than this build's is stored but never asked", async () => {
    await using registry = fakeRegistry("0.163.0")
    await using s = await setup({ npmRegistry: registry.url })
    s.server.answer(gated)
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    expect((await s.stored()).latest?.version).toBe("0.163.0")
    expect(s.server.seen.map(asked)).toEqual([BUILD])
    expect(slugs(await s.snapshot())).not.toContain(NEWER.slug)
    expect((await s.snapshot())?.rejected).toBe(0)
    expect(s.meta.view()).toMatchObject({ version: BUILD, latest: { version: "0.163.0" }, rejected: 0 })
  })

  test("at most once a day: nothing within the day; a day later a new release asks every list again in full", async () => {
    await using registry = fakeRegistry(BUILD)
    await using s = await setup({ npmRegistry: registry.url, tokenMs: 30 * DAY })
    s.server.answer(gated)
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    expect(registry.seen).toHaveLength(1)
    // A refresh within the day (a new template, a login) asks the lists with their etag and reads no release.
    expect(await s.meta.refresh()).toBe("not-modified")
    expect(s.server.seen.at(-1)?.headers["if-none-match"]).toBe(`W/"list-${BUILD}"`)
    s.t.clock.advance(DAY / 2)
    await Bun.sleep(30)
    expect(registry.seen).toHaveLength(1)
    // A new release: a day after the read the timer reads it and asks every list as it, without the old etag.
    registry.latest.version = "0.172.0"
    const before = s.server.seen.length
    s.t.clock.advance(DAY / 2)
    await until(async () => (await s.snapshot())?.clientVersion === "0.172.0")
    expect(registry.seen).toHaveLength(2)
    const again = s.server.seen.slice(before)
    expect(again.map(asked)).toEqual(["0.172.0"])
    expect(again[0]?.headers["if-none-match"]).toBeUndefined()
    expect(slugs(await s.snapshot())).toContain(NEWER.slug)
    // The day after, the same release: read once more, and no list is asked.
    await until(() => logged(s.logs, "codex_meta_fetched").length === 2)
    await Bun.sleep(50)
    const lists = s.server.seen.length
    s.t.clock.advance(DAY)
    await until(() => registry.seen.length === 3)
    await Bun.sleep(50)
    expect(s.server.seen).toHaveLength(lists)
  })

  test("a failed read keeps the last release and is not tried again within the day", async () => {
    await using registry = fakeRegistry("0.170.0")
    await using s = await setup({
      npmRegistry: registry.url,
      stored: { version: 1, kinds: {}, latest: { version: "0.172.0", fetchedAt: 0 } },
    })
    registry.replies.push(() => new Response("{}", { status: 503 }))
    s.server.answer(gated)
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    expect(registry.seen).toHaveLength(1)
    expect(s.server.seen.map(asked)).toEqual(["0.172.0"])
    expect((await s.stored()).latest).toEqual({ version: "0.172.0", fetchedAt: 0 })
    expect(logged(s.logs, "codex_version_check_failed")).toEqual([
      expect.objectContaining({ reason: "status", status: 503 }),
    ])
    // The stored release is old, but this service tried today: a refresh asks the lists only.
    expect(await s.meta.refresh()).toBe("not-modified")
    expect(registry.seen).toHaveLength(1)
  })

  test("a start with a release read less than a day ago reads nothing and asks as it", async () => {
    await using registry = fakeRegistry("0.170.0")
    await using s = await setup({ npmRegistry: registry.url })
    await CodexMeta.file(s.deps.runtime.layout).write({
      version: 1,
      kinds: {},
      latest: { version: "0.172.0", fetchedAt: s.t.clock.now() - 60_000 },
    })
    s.server.answer(gated)
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    expect(registry.seen).toEqual([])
    expect(s.server.seen.map(asked)).toEqual(["0.172.0"])
  })

  test("off: this build's version only and no read; on again: the newest release, every list asked again", async () => {
    await using registry = fakeRegistry("0.172.0")
    await using s = await setup({ npmRegistry: registry.url, tokenMs: 30 * DAY })
    const events = recordEvents(s.deps)
    s.server.answer(gated)
    await s.start()
    await until(async () => (await s.snapshot())?.clientVersion === "0.172.0")
    const off = await s.meta.setAutoVersion(false)
    expect(off).toMatchObject({ autoVersion: false, version: BUILD, latest: { version: "0.172.0" } })
    expect((await s.stored()).autoVersion).toBe(false)
    // Every list again as this build asks: the newer model is gone, nothing is left out.
    await until(async () => (await s.snapshot())?.clientVersion === BUILD)
    expect(s.server.seen.at(-1)?.headers["if-none-match"]).toBeUndefined()
    expect(slugs(await s.snapshot())).not.toContain(NEWER.slug)
    expect(s.meta.view()).toMatchObject({ autoVersion: false, version: BUILD, rejected: 0, accounts: { acc_meta: 0 } })
    // No read while off, days later too.
    s.t.clock.advance(2 * DAY)
    await Bun.sleep(50)
    expect(registry.seen).toHaveLength(1)
    // On again: the stored release (two days old now) is read first, then the lists are asked as it.
    expect((await s.meta.setAutoVersion(true)).autoVersion).toBe(true)
    expect((await s.stored()).autoVersion).toBe(true)
    await until(async () => (await s.snapshot())?.clientVersion === "0.172.0")
    expect(registry.seen).toHaveLength(2)
    expect(slugs(await s.snapshot())).toContain(NEWER.slug)
    // Every window and device hears each change.
    await until(() => {
      const last = events.filter((event) => event.name === "codexModels.changed").at(-1)?.payload.view
      return Hash.stable(last ?? null) === Hash.stable(s.meta.view())
    })
    const views = events
      .filter((event) => event.name === "codexModels.changed")
      .map((event) => event.payload.view as CodexModels.View)
    expect(views.some((view) => !view.autoVersion && view.version === BUILD)).toBe(true)
  })

  test("without a ready ChatGPT account the registry is never read", async () => {
    await using registry = fakeRegistry()
    await using s = await setup({
      npmRegistry: registry.url,
      registry: await registryWith([{ ...CODEX, status: "needs_reauth" }]),
    })
    await s.start()
    expect(await s.meta.refresh()).toBe("no-slot")
    s.t.clock.advance(3 * DAY)
    await Bun.sleep(50)
    expect(registry.seen).toEqual([])
    expect(s.meta.view()).toEqual({
      autoVersion: true,
      version: BUILD,
      build: BUILD,
      rejected: 0,
      accounts: {},
      left: [],
      accountLeft: {},
      borrowed: [],
    })
    expect(s.meta.rows()).toEqual({ revision: "none", rows: [] })
  })

  test("test endpoints without a registry override never read the registry", async () => {
    await using s = await setup()
    s.server.answer(gated)
    await s.start()
    await until(async () => (await s.snapshot())?.source === "backend")
    s.t.clock.advance(3 * DAY)
    await Bun.sleep(30)
    expect(s.server.seen.map(asked)).toEqual([BUILD])
    expect(logged(s.logs, "codex_version_checked")).toEqual([])
    expect(logged(s.logs, "codex_version_check_failed")).toEqual([])
    expect(s.meta.view().latest).toBeUndefined()
  })
})
