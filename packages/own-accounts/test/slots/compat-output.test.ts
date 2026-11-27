// 07 §6.2 #7 (compat output caps: server value, else the user's, else 32k shown as 모름) and #2 (the overflow
// warning drops once own saw core classify an overflow from the account's server). Fake servers bind 127.0.0.1;
// keys are fake.
import { describe, expect, test } from "bun:test"
import { Account, Kind, OwnID, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { Modules } from "../../src/modules.js"
import { Templates } from "../../src/slots/templates.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { sessionEvent, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"
import { failure, fakeEditor, memoryStorage, rpcContext } from "./support.js"

const AUTH = { authorization: "Bearer fake-compat-key" }
/** `accounts.list` capabilities of a model nobody set and no server reported (02 §3.3). */
const TEXT_VIEW = {
  image: { on: false, setting: "auto" },
  tools: { on: true, setting: "auto" },
  reasoning: { setting: "auto", levels: [] },
} as const
const SESSION = "ses_0123456789abcdefABCDEFGHIJ"

/** An OpenAI-compatible router on 127.0.0.1 that reports an output cap for `reported` only. */
function router() {
  const seen: Array<string | null> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/v1/models") return new Response("not found", { status: 404 })
      seen.push(request.headers.get("authorization"))
      return Response.json({ data: [{ id: "reported", max_completion_tokens: 12_000 }, { id: "typed" }] })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, seen, [Symbol.dispose]: () => void server.stop(true) }
}

async function setup(input: { readonly registry?: Registry.File; readonly control?: boolean } = {}) {
  const alerts: Telemetry.AlertInput[] = []
  const t = await testDeps({
    control: input.control ?? false,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      storage: memoryStorage().storage,
    },
  })
  if (input.registry) await t.deps.runtime.registry.write(input.registry)
  const modules = t.modules({
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
    logins: (deps, peers) => ({
      ...Modules.FACTORIES.logins(deps, peers),
      headers: async () => ({ ok: true, headers: AUTH, hash: "fakehash", expiresAt: null, source: "vault" }),
    }),
  })
  await modules.slots.start()
  return {
    t,
    slots: modules.slots,
    alerts,
    view: async (accountID: string) => {
      const listed = await modules.slots.list({}, rpcContext<"accounts.list">())
      if (!("accounts" in listed)) throw new Error("list failed")
      return listed.accounts.find((account) => account.id === accountID)
    },
    async [Symbol.asyncDispose]() {
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

function compatRegistry(baseURL: string, compat?: Account.Compat): Registry.File {
  const providerID = Kind.ProviderID.from("compat", "c0mp")
  const built = Templates.fromCompat([{ id: "local", contextLimit: 64_000 }], "2026-10-01T00:00:00Z")
  if (!built.ok) throw new Error(built.reason)
  return {
    ...Store.emptyRegistry(),
    revision: 1,
    cacheDomains: { cd_c0mp: { kind: "compat", scope: "api_key", poolingVerified: false } },
    quotaDomains: { qd_c0mp: { kind: "compat", scope: "api_key" } },
    accounts: [
      {
        id: Account.ID.make("acc_c0mp"),
        kind: "compat",
        label: "local",
        shortLabel: "L",
        color: "teal",
        providerID,
        cacheDomain: OwnID.CacheDomainID.make("cd_c0mp"),
        quotaDomain: OwnID.QuotaDomainID.make("qd_c0mp"),
        billing: "metered",
        identity: {},
        autoSwitch: true,
        status: "ready",
        ...(compat ? { compat } : {}),
      },
    ],
    slots: {
      [providerID]: {
        kind: "compat",
        accounts: [Account.ID.make("acc_c0mp")],
        pooling: "off",
        modelTemplate: OwnID.TemplateID.make("tpl_compat_c0mp"),
        baseURL,
      },
    },
    modelTemplates: { tpl_compat_c0mp: built.template },
  }
}

describe("compat output caps (07 §6.2 #7)", () => {
  test("the user's value or the 32k fallback, never above the window", () => {
    expect(Templates.compatOutput({ id: "m", contextLimit: 128_000, outputLimit: 16_384 })).toEqual({
      tokens: 16_384,
      source: "user",
    })
    expect(Templates.compatOutput({ id: "m", contextLimit: 8_000, outputLimit: 16_384 })).toEqual({
      tokens: 8_000,
      source: "user",
    })
    expect(Templates.compatOutput({ id: "m", contextLimit: 128_000 })).toEqual({ tokens: 32_000, source: "fallback" })
    expect(Templates.compatOutput({ id: "m", contextLimit: 4_096 })).toEqual({ tokens: 4_096, source: "fallback" })
    const built = Templates.fromCompat(
      [
        { id: "typed", contextLimit: 128_000, outputLimit: 16_384 },
        { id: "unknown", contextLimit: 128_000 },
      ],
      "2026-10-02T00:00:00Z",
    )
    if (!built.ok) throw new Error(built.reason)
    expect(built.template.models.map((model) => model.limit)).toEqual([
      { context: 128_000, output: 16_384 },
      { context: 128_000, output: 32_000 },
    ])
  })

  test("a new compat account: user and fallback first, then what its server reports", async () => {
    using server = router()
    await using s = await setup()
    const created = await s.slots.createAccount({
      id: Account.ID.make("acc_new"),
      kind: "compat",
      label: "router",
      identity: { keyHint: "sk-…fake" },
      cacheDomain: { scope: "api_key" },
      quotaDomain: { scope: "api_key" },
      baseURL: server.baseURL,
      compatModels: [
        { id: "reported", contextLimit: 100_000, outputLimit: 20_000 },
        { id: "typed", contextLimit: 100_000, outputLimit: 16_000 },
        { id: "unknown", contextLimit: 100_000 },
      ],
    })
    if (!created.ok) throw new Error(created.reason)
    // The account record carries the sources from the start (the probe runs in the background).
    expect(s.slots.snapshot().accounts.find((item) => item.id === "acc_new")?.compat?.outputs).toEqual({
      reported: { tokens: 20_000, source: "user" },
      typed: { tokens: 16_000, source: "user" },
      unknown: { tokens: 32_000, source: "fallback" },
    })
    await s.slots.probeCompat("acc_new")
    await until(() => s.slots.snapshot().accounts.find((item) => item.id === "acc_new")?.compat?.server !== undefined)
    const view = await s.view("acc_new")
    expect(view?.compat).toEqual({
      server: { family: "other", overflowClassified: false },
      // A router says nothing about images or tools: text in, tools on, as before.
      models: [
        { id: "reported", output: { tokens: 12_000, source: "server" }, ...TEXT_VIEW },
        { id: "typed", output: { tokens: 16_000, source: "user" }, ...TEXT_VIEW },
        { id: "unknown", output: { tokens: 32_000, source: "fallback" }, ...TEXT_VIEW },
      ],
    })
    // The registered models use the same caps.
    expect(
      Object.fromEntries(s.slots.models(created.account.providerID).map((model) => [model.id, model.limit.output])),
    ).toEqual({ reported: 12_000, typed: 16_000, unknown: 32_000 })
    const { editor, records } = fakeEditor()
    s.slots.transformProviders(editor)
    expect(
      [...(records.get(created.account.providerID)?.models.values() ?? [])].map((model) => model.limit.output),
    ).toEqual([12_000, 16_000, 32_000])
    // Only the account's own key went to its own server.
    expect(new Set(server.seen)).toEqual(new Set([AUTH.authorization]))
  })

  test("other kinds carry no compat view; a compat account from before T1 shows its cap as fallback", async () => {
    await using s = await setup({ registry: compatRegistry("http://127.0.0.1:1/v1") })
    const view = await s.view("acc_c0mp")
    expect(view?.compat).toEqual({
      models: [{ id: "local", output: { tokens: 32_000, source: "fallback" }, ...TEXT_VIEW }],
    })
  })

  test("the control Location asks the server of a compat account that has no server facts yet", async () => {
    using server = router()
    await using s = await setup({ registry: compatRegistry(server.baseURL), control: true })
    await until(() => s.slots.snapshot().accounts[0]?.compat?.server !== undefined)
    expect(s.slots.snapshot().accounts[0]?.compat?.server).toEqual({
      family: "other",
      overflowClassified: false,
      reasoningRead: true,
    })
  })
})

describe("compat model capabilities (02 §3.3)", () => {
  /** A fake Ollama on 127.0.0.1: `/api/show` lists each model's capabilities. */
  function ollama(capabilities: Readonly<Record<string, ReadonlyArray<string>>>) {
    const seen: Array<string | null> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seen.push(request.headers.get("authorization"))
        const path = new URL(request.url).pathname
        if (path === "/v1/models")
          return Response.json({ data: Object.keys(capabilities).map((id) => ({ id, owned_by: "library" })) })
        if (path === "/api/version") return Response.json({ version: "0.12.3" })
        if (path === "/api/show" && request.method === "POST") {
          const body = (await request.json()) as { model: string }
          return Response.json({ capabilities: capabilities[body.model] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    return { baseURL: `http://127.0.0.1:${server.port}/v1`, seen, [Symbol.dispose]: () => void server.stop(true) }
  }

  const VISION = { tools: true, input: ["text", "image"], output: ["text"] }
  const TEXT = { tools: true, input: ["text"], output: ["text"] }
  const capabilitiesOf = (s: Awaited<ReturnType<typeof setup>>, providerID: string) =>
    Object.fromEntries(s.slots.models(providerID).map((model) => [model.id, model.capabilities]))

  test("the add form's settings, then what Ollama reports, register through the fold; later changes too", async () => {
    using server = ollama({
      "qwen2.5vl:7b": ["completion", "vision", "tools"],
      "gemma3:1b": ["completion"],
      "llava:7b": ["completion", "vision"],
    })
    await using s = await setup()
    const created = await s.slots.createAccount({
      id: Account.ID.make("acc_local"),
      kind: "compat",
      label: "Ollama",
      identity: { keyHint: "sk-…fake" },
      cacheDomain: { scope: "api_key" },
      quotaDomain: { scope: "api_key" },
      baseURL: server.baseURL,
      compatModels: [
        { id: "qwen2.5vl:7b", contextLimit: 32_768 },
        { id: "gemma3:1b", contextLimit: 32_768, image: "auto", tools: "auto" },
        { id: "llava:7b", contextLimit: 4_096, image: "off", tools: "on" },
      ],
    })
    if (!created.ok) throw new Error(created.reason)
    const providerID = created.account.providerID
    // Before the server answers: the settings only (models left on auto store none).
    expect(created.account.compat?.capabilities).toEqual({ "llava:7b": { image: "off", tools: "on" } })
    expect(capabilitiesOf(s, providerID)).toEqual({ "qwen2.5vl:7b": TEXT, "gemma3:1b": TEXT, "llava:7b": TEXT })

    await s.slots.probeCompat("acc_local")
    await until(() => s.slots.account("acc_local")?.compat?.server !== undefined)
    expect(capabilitiesOf(s, providerID)).toEqual({
      "qwen2.5vl:7b": VISION,
      // Ollama refuses tools to a model without the capability, so its tool definitions are not sent.
      "gemma3:1b": { tools: false, input: ["text"], output: ["text"] },
      // The user's settings win over what the server said.
      "llava:7b": TEXT,
    })
    const { editor, records } = fakeEditor()
    s.slots.transformProviders(editor)
    expect(
      Object.fromEntries(
        [...(records.get(providerID)?.models.values() ?? [])].map((model) => [model.id, model.capabilities]),
      ),
    ).toEqual(capabilitiesOf(s, providerID))
    expect((await s.view("acc_local"))?.compat?.models.map((model) => [model.id, model.image, model.tools])).toEqual([
      ["qwen2.5vl:7b", { on: true, setting: "auto", detected: true }, { on: true, setting: "auto", detected: true }],
      ["gemma3:1b", { on: false, setting: "auto", detected: false }, { on: false, setting: "auto", detected: false }],
      ["llava:7b", { on: false, setting: "off", detected: true }, { on: true, setting: "on", detected: false }],
    ])

    // Changed later on the account card (accounts.update{compatCapabilities}).
    const updated = await s.slots.update(
      {
        accountID: Account.ID.make("acc_local"),
        compatCapabilities: [
          { id: "llava:7b", image: "auto", tools: "auto" },
          { id: "gemma3:1b", tools: "on" },
        ],
      },
      rpcContext<"accounts.update">(),
    )
    expect(failure(updated)).toBeUndefined()
    expect(capabilitiesOf(s, providerID)).toEqual({
      "qwen2.5vl:7b": VISION,
      "gemma3:1b": TEXT,
      "llava:7b": { tools: false, input: ["text", "image"], output: ["text"] },
    })
    const unknown = failure(
      await s.slots.update(
        { accountID: Account.ID.make("acc_local"), compatCapabilities: [{ id: "nope", image: "on" }] },
        rpcContext<"accounts.update">(),
      ),
    )
    expect(unknown).toMatchObject({ type: "policy_denied", data: { field: "compatCapabilities" } })
    // Only the account's own key went to its own server.
    expect(new Set(server.seen)).toEqual(new Set([AUTH.authorization]))
  })

  test("other kinds refuse compatCapabilities", async () => {
    await using s = await setup()
    const created = await s.slots.createAccount({
      id: Account.ID.make("acc_ds"),
      kind: "ds",
      label: "DeepSeek",
      identity: { keyHint: "sk-…fake" },
      cacheDomain: { scope: "api_key" },
      quotaDomain: { scope: "api_key" },
    })
    if (!created.ok) throw new Error(created.reason)
    const denied = failure(
      await s.slots.update(
        { accountID: Account.ID.make("acc_ds"), compatCapabilities: [{ id: "deepseek-chat", image: "on" }] },
        rpcContext<"accounts.update">(),
      ),
    )
    expect(denied).toMatchObject({ type: "policy_denied", data: { field: "compatCapabilities" } })
  })

  test("the control Location reads an account whose server was read before the capability settings", async () => {
    using server = ollama({ local: ["completion", "vision", "tools"] })
    const registry = compatRegistry(server.baseURL, { server: { family: "ollama", overflowClassified: false } })
    await using s = await setup({ registry, control: true })
    await until(() => s.slots.account("acc_c0mp")?.compat?.capabilities !== undefined)
    expect(s.slots.account("acc_c0mp")?.compat?.capabilities).toEqual({
      local: { detected: { image: true, tools: true, reasoning: null } },
    })
    expect(capabilitiesOf(s, Kind.ProviderID.from("compat", "c0mp"))).toEqual({ local: VISION })
  })
})

describe("observed overflow classification (07 §6.2 #2, PG9)", () => {
  const providerID = Kind.ProviderID.from("compat", "c0mp")

  const compaction = (reason: "auto" | "manual") =>
    sessionEvent("session.compaction.started", { sessionID: SESSION, reason, recent: "" })
  const stepFailed = () =>
    sessionEvent("session.step.failed", {
      sessionID: SESSION,
      assistantMessageID: "msg_0123456789abcdef",
      error: { type: "provider.invalid-request", message: "bad request" },
    })
  const classified = (s: Awaited<ReturnType<typeof setup>>) =>
    s.slots.snapshot().accounts[0]?.compat?.server?.overflowClassified

  test("an automatic compaction right after the server's error: core recovered, the warning goes", async () => {
    await using s = await setup({
      registry: compatRegistry("http://127.0.0.1:1/v1", { server: { family: "vllm", overflowClassified: false } }),
    })
    s.t.deps.runtime.lastResponse.record(SESSION, { providerID, status: 400, bodyHead: "maximum context length" })
    await s.slots.onEvent?.(compaction("auto"), { local: true })
    expect(classified(s)).toBe(true)
    expect((await s.view("acc_c0mp"))?.compat?.server).toEqual({ family: "vllm", overflowClassified: true })
  })

  test("not after a settled step, a scheduled retry, a manual compaction, a success or another Location", async () => {
    await using s = await setup({ registry: compatRegistry("http://127.0.0.1:1/v1") })
    const record = (status: number) => s.t.deps.runtime.lastResponse.record(SESSION, { providerID, status })
    record(400)
    await s.slots.onEvent?.(stepFailed(), { local: true })
    await s.slots.onEvent?.(compaction("auto"), { local: true })
    record(400)
    await s.slots.onEvent?.(
      sessionEvent("session.retry.scheduled", {
        sessionID: SESSION,
        assistantMessageID: "msg_0123456789abcdef",
        attempt: 1,
        at: 0,
      }),
      { local: true },
    )
    await s.slots.onEvent?.(compaction("auto"), { local: true })
    record(400)
    await s.slots.onEvent?.(compaction("manual"), { local: true })
    await s.slots.onEvent?.(compaction("auto"), { local: false })
    record(200)
    await s.slots.onEvent?.(compaction("auto"), { local: true })
    expect(classified(s)).toBeUndefined()
    // A non-compat provider's error never marks a compat account.
    s.t.deps.runtime.lastResponse.record(SESSION, { providerID: "own-ds-abcd", status: 400 })
    await s.slots.onEvent?.(compaction("auto"), { local: true })
    expect(classified(s)).toBeUndefined()
  })
})
