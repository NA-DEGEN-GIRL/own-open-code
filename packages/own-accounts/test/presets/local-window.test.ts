// 07 §6.2 #8, PG9 (implementation): the running window of a local LLM server. A fake Ollama (`/api/ps`, `/api/tags`,
// `/api/show`) binds 127.0.0.1; nothing here talks to a real server.
import { describe, expect, test } from "bun:test"
import { Account, Kind, OwnID, type Registry } from "@own/protocol"
import { OwnImport } from "@own/protocol/rpc-import"
import { Store } from "@own/runtime"
import { Clock } from "../../src/clock.js"
import { Logger } from "../../src/logger.js"
import { Modules } from "../../src/modules.js"
import { LocalWindow } from "../../src/presets/local-window.js"
import { Templates } from "../../src/slots/templates.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { sessionEvent, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"
import { catalogModel, fakeEditor, memoryStorage, rpcContext } from "../slots/support.js"

/** 02 §6.4 default `Z` (12k) + core's default `keep` (15k). */
const NEEDED = 27_000

interface Model {
  readonly name: string
  readonly digest: string
  readonly parameters?: string
  /** Loaded with this running window (`/api/ps`). */
  readonly loaded?: number
}

/** A fake Ollama on 127.0.0.1; `models` can change between polls, `down` makes every route fail. */
function ollama(models: Model[]) {
  const state = { models, down: false }
  const shows: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (state.down) return new Response("down", { status: 503 })
      if (path === "/api/ps")
        return Response.json({
          models: state.models.flatMap((model) =>
            model.loaded === undefined
              ? []
              : [{ name: model.name, model: model.name, size: 1, digest: model.digest, context_length: model.loaded }],
          ),
        })
      if (path === "/api/tags")
        return Response.json({ models: state.models.map((model) => ({ name: model.name, digest: model.digest })) })
      if (path === "/api/show" && request.method === "POST") {
        const name: string = (await request.json()).model
        shows.push(name)
        const found = state.models.find((model) => model.name === name || model.name === `${name}:latest`)
        return found ? Response.json({ parameters: found.parameters ?? "" }) : new Response("missing", { status: 404 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, state, shows, [Symbol.dispose]: () => void server.stop(true) }
}

function tracker(
  targets: () => ReadonlyArray<LocalWindow.Target>,
  options: { readonly env?: number; readonly clock?: Clock.Clock } = {},
) {
  const alerts: Telemetry.AlertInput[] = []
  const local = LocalWindow.create({
    clock: options.clock ?? Clock.manual(),
    log: Logger.silent,
    targets,
    keep: () => 15_000,
    alert: (alert) => alerts.push(alert),
    ...(options.env === undefined ? {} : { ollamaContextLength: options.env }),
  })
  return { local, alerts }
}

const ollamaTarget = (baseURL: string, models: LocalWindow.Target["models"]): LocalWindow.Target => ({
  providerID: "ollama",
  source: { type: "ollama", baseURL, headers: async () => ({}) },
  models,
})

const model = (id: string, tools = true) => ({ id, tools, window: 131_072 })

describe("what a request needs (07 §6.2 #8)", () => {
  test("system and tools (median first step, never below 12k) plus core keep", () => {
    expect(LocalWindow.needed([], 15_000)).toBe(NEEDED)
    expect(LocalWindow.needed([8_000, 9_000], 15_000)).toBe(NEEDED)
    expect(LocalWindow.needed([20_000, 30_000, 25_000], 15_000)).toBe(40_000)
    expect(LocalWindow.needed([20_000, 30_000, 25_000], 20_000)).toBe(45_000)
  })

  test("verified only when the running window holds it", () => {
    expect(LocalWindow.judge(null, NEEDED)).toEqual({ runtime: null, needed: NEEDED, status: "unknown" })
    expect(LocalWindow.judge(8_192, NEEDED)).toEqual({ runtime: 8_192, needed: NEEDED, status: "unverified" })
    expect(LocalWindow.judge(NEEDED, NEEDED).status).toBe("verified")
  })

  test("first steps of new sessions raise it; later steps and unknown sessions do not", () => {
    const { local } = tracker(() => [{ providerID: "lmstudio", source: { type: "registered" }, models: [model("m")] }])
    const created = (sessionID: string) => sessionEvent("session.created", { sessionID })
    const ended = (sessionID: string, input: number) =>
      sessionEvent("session.step.ended", {
        sessionID,
        tokens: { input, output: 10, reasoning: 0, cache: { read: 5_000, write: 0 } },
      })
    local.observe(created("ses_a"))
    local.observe(ended("ses_a", 30_000))
    local.observe(ended("ses_a", 90_000))
    local.observe(ended("ses_unknown", 90_000))
    expect(local.get("lmstudio", "m")?.needed).toBe(35_000 + 15_000)
  })

  test("an own.import session (an imported conversation or a helper) teaches nothing (09 §4.2, IG7)", () => {
    const { local } = tracker(() => [{ providerID: "lmstudio", source: { type: "registered" }, models: [model("m")] }])
    const created = (sessionID: string, metadata?: Record<string, unknown>) =>
      sessionEvent("session.created", { sessionID, ...(metadata ? { metadata } : {}) })
    const ended = (sessionID: string, input: number) =>
      sessionEvent("session.step.ended", {
        sessionID,
        tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    // Its first step carries the imported history, up to a whole window.
    local.observe(created("ses_import", { [OwnImport.META_KEY]: { v: 1, kind: "codex", sourceID: "thread-fixture" } }))
    local.observe(ended("ses_import", 120_000))
    local.observe(created("ses_helper", { [OwnImport.META_KEY]: { v: 1, helper: true, jobID: "job_01TESTJOB0" } }))
    local.observe(ended("ses_helper", 110_000))
    expect(local.get("lmstudio", "m")?.needed).toBe(NEEDED)
    // Other metadata does not matter; a normal session still teaches.
    local.observe(created("ses_team", { "own.team": { role: "area" } }))
    local.observe(ended("ses_team", 30_000))
    expect(local.get("lmstudio", "m")?.needed).toBe(30_000 + 15_000)
  })
})

describe("Ollama's running window (07 §6.2 #8, PG9)", () => {
  test("loaded window from /api/ps, else num_ctx, else OLLAMA_CONTEXT_LENGTH; the registered window stays", async () => {
    using server = ollama([
      { name: "loaded:8b", digest: "d1", loaded: 8_192, parameters: "num_ctx 65536" },
      { name: "big:latest", digest: "d2", parameters: "num_ctx 65536\nstop x" },
      { name: "plain:latest", digest: "d3" },
      { name: "chat:latest", digest: "d4" },
    ])
    const models = [model("loaded:8b"), model("big"), model("plain"), model("chat", false)]
    const { local, alerts } = tracker(() => [ollamaTarget(server.baseURL, models)], { env: 40_960 })
    expect(local.get("ollama", "big")).toEqual({ runtime: null, needed: NEEDED, status: "unknown" })
    await local.poll()
    expect(local.get("ollama", "loaded:8b")).toEqual({ runtime: 8_192, needed: NEEDED, status: "unverified" })
    expect(local.get("ollama", "big")).toEqual({ runtime: 65_536, needed: NEEDED, status: "verified" })
    expect(local.get("ollama", "plain")).toEqual({ runtime: 40_960, needed: NEEDED, status: "verified" })
    expect(local.get("ollama", "missing")).toBeUndefined()
    expect(local.get("own-codex-abcd", "gpt-6-sol")).toBeUndefined()
    // R8: nothing here changes the window the model is registered with.
    expect(models[0]?.window).toBe(131_072)
    expect(alerts).toEqual([
      expect.objectContaining({ code: "local_window_unverified", severity: "info", subject: "ollama/loaded:8b" }),
    ])
    expect(alerts[0]?.message).toContain("8,192")
    expect(alerts[0]?.message).toContain("OLLAMA_CONTEXT_LENGTH")
  })

  test("once per model; /api/show again only when a digest changes", async () => {
    using server = ollama([
      { name: "small:latest", digest: "d1", parameters: "num_ctx 4096" },
      { name: "other:latest", digest: "d2", parameters: "num_ctx 4096" },
    ])
    const { local, alerts } = tracker(() => [ollamaTarget(server.baseURL, [model("small"), model("other")])])
    await local.poll()
    await local.poll()
    expect(server.shows.toSorted()).toEqual(["other", "small"])
    expect(alerts.map((alert) => alert.subject)).toEqual(["ollama/small", "ollama/other"])
    server.state.models = [
      { name: "small:latest", digest: "d1-new", parameters: "num_ctx 32768" },
      { name: "other:latest", digest: "d2", parameters: "num_ctx 4096" },
    ]
    await local.poll()
    expect(server.shows.toSorted()).toEqual(["other", "small", "small"])
    expect(local.get("ollama", "small")?.status).toBe("verified")
    expect(alerts).toHaveLength(2)
  })

  test("unknown while nothing reports it; a server that was never read raises nothing", async () => {
    using server = ollama([{ name: "plain:latest", digest: "d1" }])
    // `[::]` never answers (the fake listens on 127.0.0.1 only) and never leaves this PC.
    const unread = ollamaTarget(server.baseURL.replace("127.0.0.1", "[::]"), [model("plain")])
    const { local, alerts } = tracker(() => [
      { ...unread, providerID: "own-compat-r3mt" },
      ollamaTarget(server.baseURL, [model("plain")]),
    ])
    await local.poll()
    expect(local.get("ollama", "plain")).toEqual({ runtime: null, needed: NEEDED, status: "unknown" })
    expect(local.get("own-compat-r3mt", "plain")?.status).toBe("unknown")
    expect(alerts.map((alert) => alert.subject)).toEqual(["ollama/plain"])
    expect(alerts[0]?.message).toContain("확인하지 못해")
  })

  test("OLLAMA_CONTEXT_LENGTH of this process counts only for a server on this PC", () => {
    expect(LocalWindow.onThisPC("http://127.0.0.1:11434")).toBe(true)
    expect(LocalWindow.onThisPC("http://localhost:11434")).toBe(true)
    expect(LocalWindow.onThisPC("http://[::1]:11434")).toBe(true)
    expect(LocalWindow.onThisPC("http://192.168.0.20:11434")).toBe(false)
    expect(LocalWindow.onThisPC("https://gpu-box.lan/ollama")).toBe(false)
  })

  test("a server that stops answering keeps its last reading", async () => {
    using server = ollama([{ name: "big:latest", digest: "d1", loaded: 65_536 }])
    const { local } = tracker(() => [ollamaTarget(server.baseURL, [model("big")])])
    await local.poll()
    server.state.down = true
    await local.poll()
    expect(local.get("ollama", "big")?.runtime).toBe(65_536)
  })

  test("LM Studio's registered window is its loaded one", async () => {
    const { local, alerts } = tracker(() => [
      {
        providerID: "lmstudio",
        source: { type: "registered" },
        models: [model("big"), { ...model("small"), window: 4_096 }],
      },
    ])
    expect(local.get("lmstudio", "big")?.status).toBe("verified")
    expect(local.get("lmstudio", "small")).toEqual({ runtime: 4_096, needed: NEEDED, status: "unverified" })
    await local.poll()
    expect(alerts.map((alert) => alert.subject)).toEqual(["lmstudio/small"])
  })

  test("polls on the discovery cadence until stopped", async () => {
    using server = ollama([{ name: "big:latest", digest: "d1", loaded: 65_536 }])
    const clock = Clock.manual()
    const reads = { count: 0 }
    const { local } = tracker(
      () => {
        reads.count += 1
        return [ollamaTarget(server.baseURL, [model("big")])]
      },
      { clock },
    )
    local.start()
    await until(() => local.get("ollama", "big")?.runtime === 65_536)
    server.state.models = [{ name: "big:latest", digest: "d1", loaded: 8_192 }]
    clock.advance(LocalWindow.INTERVAL_MS)
    await until(() => local.get("ollama", "big")?.runtime === 8_192)
    await local.stop()
    expect(clock.pending()).toBe(0)
    expect(reads.count).toBeGreaterThan(0)
  })
})

describe("slots.localWindow and accounts.list (07 §6.2 #8)", () => {
  async function setup(registry?: Registry.File) {
    const alerts: Telemetry.AlertInput[] = []
    const t = await testDeps({
      control: true,
      ctx: { provider: { reload: async () => {}, list: async () => [] }, storage: memoryStorage().storage },
    })
    if (registry) await t.deps.runtime.registry.write(registry)
    const modules = t.modules({
      telemetry: (deps, peers) => ({
        ...Modules.FACTORIES.telemetry(deps, peers),
        alert: (alert) => alerts.push(alert),
      }),
      logins: (deps, peers) => ({
        ...Modules.FACTORIES.logins(deps, peers),
        headers: async () => ({
          ok: true,
          headers: { authorization: "Bearer fake-local-key" },
          hash: "fakehash",
          expiresAt: null,
          source: "vault",
        }),
      }),
    })
    await modules.slots.start()
    return {
      t,
      slots: modules.slots,
      alerts,
      async [Symbol.asyncDispose]() {
        await modules.slots.stop()
        await t[Symbol.asyncDispose]()
      },
    }
  }

  test("the discovered ollama provider, read on the control Location's cadence", async () => {
    using server = ollama([
      { name: "qwen3:8b", digest: "d1", loaded: 8_192 },
      { name: "qwen3:32b", digest: "d2", parameters: "num_ctx 40960" },
    ])
    await using s = await setup()
    const { editor } = fakeEditor({
      ollama: {
        info: { activation: "enabled", settings: { baseURL: server.baseURL, apiKey: "" } },
        models: [
          catalogModel("ollama", "qwen3:8b", { limit: { context: 40_960, output: 32_000 } }),
          catalogModel("ollama", "qwen3:32b", { limit: { context: 40_960, output: 32_000 } }),
        ],
      },
      lmstudio: {
        info: { activation: "enabled", settings: { baseURL: "http://127.0.0.1:1/v1" } },
        models: [catalogModel("lmstudio", "qwen3-8b", { limit: { context: 4_096, output: 4_096 } })],
      },
    })
    s.slots.transformProviders(editor)
    expect(s.slots.localWindow("lmstudio", "qwen3-8b")?.status).toBe("unverified")
    expect(s.slots.localWindow("ollama", "qwen3:8b")?.status).toBe("unknown")
    s.t.clock.advance(LocalWindow.INTERVAL_MS)
    // Each model's reading lands on its own: a loaded one from /api/ps, the other after its /api/show.
    await until(
      () =>
        s.slots.localWindow("ollama", "qwen3:8b")?.runtime === 8_192 &&
        s.slots.localWindow("ollama", "qwen3:32b")?.runtime !== null,
    )
    expect(s.slots.localWindow("ollama", "qwen3:32b")).toEqual({ runtime: 40_960, needed: NEEDED, status: "verified" })
    expect(s.slots.localWindow("own-codex-abcd", "gpt-6-sol")).toBeUndefined()
    await until(() => s.alerts.length >= 2)
    expect(s.alerts.map((alert) => alert.subject).toSorted()).toEqual(["lmstudio/qwen3-8b", "ollama/qwen3:8b"])
  })

  test("a compat account on Ollama shows each model's running window in accounts.list", async () => {
    using server = ollama([{ name: "qwen3:8b", digest: "d1", loaded: 8_192 }])
    const providerID = Kind.ProviderID.from("compat", "0llm")
    const built = Templates.fromCompat([{ id: "qwen3:8b", contextLimit: 40_960 }], "2026-10-02T00:00:00Z")
    if (!built.ok) throw new Error(built.reason)
    await using s = await setup({
      ...Store.emptyRegistry(),
      revision: 1,
      accounts: [
        {
          id: Account.ID.make("acc_0llm"),
          kind: "compat",
          label: "ollama",
          shortLabel: "O",
          color: "teal",
          providerID,
          cacheDomain: OwnID.CacheDomainID.make("cd_0llm"),
          quotaDomain: OwnID.QuotaDomainID.make("qd_0llm"),
          billing: "metered",
          identity: {},
          autoSwitch: true,
          status: "ready",
          compat: { server: { family: "ollama", overflowClassified: false } },
        },
      ],
      slots: {
        [providerID]: {
          kind: "compat",
          accounts: [Account.ID.make("acc_0llm")],
          pooling: "off",
          modelTemplate: OwnID.TemplateID.make("tpl_compat_0llm"),
          baseURL: server.baseURL,
        },
      },
      modelTemplates: { tpl_compat_0llm: built.template },
    })
    await until(() => s.slots.localWindow(providerID, "qwen3:8b")?.runtime === 8_192)
    const listed = await s.slots.list({}, rpcContext<"accounts.list">())
    if (!("accounts" in listed)) throw new Error("list failed")
    expect(listed.accounts[0]?.compat).toEqual({
      server: { family: "ollama", overflowClassified: false },
      models: [
        {
          id: "qwen3:8b",
          output: { tokens: 32_000, source: "fallback" },
          localWindow: { runtime: 8_192, needed: NEEDED, status: "unverified" },
          // 02 §3.3: nothing set or reported yet: text in, tools on.
          image: { on: false, setting: "auto" },
          tools: { on: true, setting: "auto" },
          // 02 §3.3a: no reasoning reported yet, no effort levels.
          reasoning: { setting: "auto", levels: [] },
        },
      ],
    })
    await until(() => s.alerts.length >= 1)
    expect(s.alerts[0]).toMatchObject({ code: "local_window_unverified", accountID: "acc_0llm" })
  })
})
