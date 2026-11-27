// 07 §6.2 #2, #7, PG9: what a compat server tells about itself. Fake OpenAI-compatible servers (vLLM, llama.cpp,
// LM Studio, Ollama, a router) bound to 127.0.0.1 answer the probe; every key is fake.
import { describe, expect, test } from "bun:test"
import { Account, Kind, OwnID, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { CompatProbe } from "../../src/slots/compat-probe.js"
import { Templates } from "../../src/slots/templates.js"

const KEY = { authorization: "Bearer fake-compat-key" }

interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: string
  readonly search: string
}

/**
 * A fake server on 127.0.0.1 answering `METHOD /path` routes with JSON (a value, or a function of the request);
 * everything else is a 404.
 */
function serve(routes: Readonly<Record<string, unknown>>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      seen.push({
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
        search: new URL(request.url).search,
      })
      const route = routes[`${request.method} ${path}`]
      if (route === undefined) return new Response("not found", { status: 404 })
      return Response.json(typeof route === "function" ? route(seen.at(-1)) : route)
    },
  })
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    seen,
    [Symbol.dispose]: () => void server.stop(true),
  }
}

describe("server family (07 §6.2 #2, PG9)", () => {
  test("vLLM, llama.cpp and LM Studio give themselves away in /models", async () => {
    using vllm = serve({
      "GET /v1/models": {
        object: "list",
        data: [{ id: "Qwen/Qwen3-8B", object: "model", owned_by: "vllm", max_model_len: 32_768 }],
      },
    })
    using llamacpp = serve({
      "GET /v1/models": {
        object: "list",
        data: [{ id: "qwen3.gguf", object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 40_960 } }],
      },
    })
    using lmstudio = serve({
      "GET /v1/models": { object: "list", data: [{ id: "qwen3-8b", object: "model", owned_by: "organization_owner" }] },
    })
    for (const [server, family, model, paths, window] of [
      // The answer to /models was enough; vLLM tells nothing more about a model.
      [vllm, "vllm", "Qwen/Qwen3-8B", ["/v1/models"], 32_768],
      // Then each family's native capability endpoint, which these servers do not answer.
      [llamacpp, "llamacpp", "qwen3.gguf", ["/v1/models", "/props"], 40_960],
      [lmstudio, "lmstudio", "qwen3-8b", ["/v1/models", "/api/v1/models", "/api/v0/models"], undefined],
    ] as const) {
      const result = await CompatProbe.run({ baseURL: server.baseURL, headers: KEY, models: [model] })
      expect(result).toEqual({
        family,
        contexts: new Map(window === undefined ? [] : [[model, window]]),
        outputs: new Map(),
        capabilities: new Map([[model, {}]]),
      })
      expect(server.seen.map((seen) => seen.path)).toEqual([...paths])
      // Every request carried the account's own key, to its own server.
      expect(server.seen.every((seen) => seen.authorization === KEY.authorization)).toBe(true)
    }
  })

  test("Ollama answers /api/version; num_predict of /api/show is a model's output cap", async () => {
    using ollama = serve({
      "GET /v1/models": {
        object: "list",
        data: [
          { id: "qwen3:8b", object: "model", owned_by: "library" },
          { id: "llama3.2:latest", object: "model", owned_by: "library" },
        ],
      },
      "GET /api/version": { version: "0.12.3" },
      "POST /api/show": (seen: Seen) =>
        JSON.parse(seen.body).model === "qwen3:8b"
          ? {
              parameters: 'num_ctx                        8192\nnum_predict                    4096\nstop "<|im_end|>"',
            }
          : { parameters: "num_ctx 4096\nnum_predict -1" },
    })
    const result = await CompatProbe.run({
      baseURL: ollama.baseURL,
      headers: KEY,
      models: ["qwen3:8b", "llama3.2:latest"],
    })
    // These Ollama answers carry no capabilities list (before 0.6.4): nothing reported.
    expect(result).toEqual({
      family: "ollama",
      // The Modelfile's num_ctx is the window it runs with.
      contexts: new Map([
        ["qwen3:8b", 8192],
        ["llama3.2:latest", 4096],
      ]),
      outputs: new Map([["qwen3:8b", 4096]]),
      capabilities: new Map([
        ["qwen3:8b", {}],
        ["llama3.2:latest", {}],
      ]),
    })
    expect(ollama.seen.filter((seen) => seen.path === "/api/show").map((seen) => JSON.parse(seen.body))).toEqual([
      { model: "qwen3:8b" },
      { model: "llama3.2:latest" },
    ])
  })

  test("LM Studio by its native model list when /models says nothing", async () => {
    using lmstudio = serve({
      "GET /v1/models": { object: "list", data: [{ id: "qwen3-8b", object: "model", owned_by: "lmstudio-community" }] },
      "GET /api/v1/models": {
        models: [{ type: "llm", key: "qwen3-8b", loaded_instances: [], max_context_length: 32_768 }],
      },
    })
    const result = await CompatProbe.run({ baseURL: lmstudio.baseURL, headers: KEY, models: ["qwen3-8b"] })
    expect(result?.family).toBe("lmstudio")
  })

  test("a router: other, with the output caps its /models reports for the account's models only", async () => {
    using router = serve({
      "GET /v1/models": {
        data: [
          { id: "m-out", max_output_tokens: 16_384 },
          { id: "m-completion", max_completion_tokens: 8_192 },
          { id: "m-top", top_provider: { max_completion_tokens: 4_096, context_length: 64_000 } },
          { id: "m-null", max_output_tokens: null, top_provider: null },
          { id: "m-other", max_output_tokens: 1_000 },
          { bad: "entry without an id" },
        ],
      },
    })
    const result = await CompatProbe.run({
      baseURL: `${router.baseURL}/`,
      headers: KEY,
      models: ["m-out", "m-completion", "m-top", "m-null"],
    })
    expect(result).toEqual({
      family: "other",
      contexts: new Map(),
      outputs: new Map([
        ["m-out", 16_384],
        ["m-completion", 8_192],
        ["m-top", 4_096],
      ]),
      // An unknown server says nothing about images or tools.
      capabilities: new Map(["m-out", "m-completion", "m-top", "m-null"].map((id) => [id, {}])),
    })
    expect(router.seen.map((seen) => seen.path)).toEqual(["/v1/models", "/api/version", "/api/v1/models"])
  })

  test("a server whose /models does not answer teaches nothing", async () => {
    using broken = serve({ "GET /api/version": { version: "0.12.3" } })
    expect(await CompatProbe.run({ baseURL: broken.baseURL, headers: KEY, models: ["m"] })).toBeUndefined()
    expect(await CompatProbe.run({ baseURL: "ftp://127.0.0.1/v1", headers: KEY, models: ["m"] })).toBeUndefined()
  })

  test("native API root and Modelfile parameters", () => {
    expect(CompatProbe.root("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434")
    expect(CompatProbe.root("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434")
    expect(CompatProbe.root("https://gpu.example/ollama/v1")).toBe("https://gpu.example/ollama")
    expect(CompatProbe.root("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080")
    expect(CompatProbe.root("file:///v1")).toBeUndefined()
    expect(CompatProbe.root("not a url")).toBeUndefined()
    expect(CompatProbe.modelParameter("num_ctx 8192\nnum_predict 512", "num_ctx")).toBe(8192)
    expect(CompatProbe.modelParameter("num_ctx 8192\nnum_predict 512", "num_predict")).toBe(512)
    expect(CompatProbe.modelParameter("num_predict -1", "num_predict")).toBeUndefined()
    expect(CompatProbe.modelParameter("num_ctxx 8192", "num_ctx")).toBeUndefined()
    expect(CompatProbe.modelParameter(undefined, "num_ctx")).toBeUndefined()
  })
})

describe("model capabilities (02 §3.3)", () => {
  const ollamaModels = {
    object: "list",
    data: ["qwen2.5vl:7b", "gemma3:1b", "flux:dev"].map((id) => ({ id, object: "model", owned_by: "library" })),
  }

  test("Ollama: vision and tools from /api/show capabilities; image generation is not image input", async () => {
    const capabilities: Record<string, ReadonlyArray<string>> = {
      "qwen2.5vl:7b": ["completion", "vision", "tools"],
      "gemma3:1b": ["completion"],
      "flux:dev": ["image"],
    }
    using ollama = serve({
      "GET /v1/models": ollamaModels,
      "GET /api/version": { version: "0.12.3" },
      "POST /api/show": (seen: Seen) => ({ capabilities: capabilities[JSON.parse(seen.body).model] }),
    })
    const result = await CompatProbe.run({ baseURL: ollama.baseURL, headers: KEY, models: Object.keys(capabilities) })
    expect(result?.capabilities).toEqual(
      new Map([
        // A capabilities list without `thinking`: the model does not reason (02 §3.3a).
        ["qwen2.5vl:7b", { image: true, tools: true, reasoning: null }],
        ["gemma3:1b", { image: false, tools: false, reasoning: null }],
        ["flux:dev", { image: false, tools: false, reasoning: null }],
      ]),
    )
    // One /api/show per model, with the account's own key.
    expect(ollama.seen.filter((seen) => seen.path === "/api/show").map((seen) => seen.authorization)).toEqual([
      KEY.authorization,
      KEY.authorization,
      KEY.authorization,
    ])
  })

  test("LM Studio: vision from /api/v1/models; only native tool use counts as reported", async () => {
    using lmstudio = serve({
      "GET /v1/models": {
        object: "list",
        data: ["qwen2.5-vl-7b-instruct", "qwen3-8b"].map((id) => ({
          id,
          object: "model",
          owned_by: "organization_owner",
        })),
      },
      "GET /api/v1/models": {
        models: [
          {
            type: "llm",
            key: "qwen2.5-vl-7b-instruct",
            max_context_length: 128_000,
            loaded_instances: [],
            capabilities: { vision: true, trained_for_tool_use: true, reasoning: { allowed_options: ["off"] } },
          },
          {
            type: "llm",
            key: "qwen3-8b",
            max_context_length: 32_768,
            loaded_instances: [],
            capabilities: { vision: false, trained_for_tool_use: false },
          },
          { type: "embedding", key: "nomic-embed", max_context_length: 2_048, loaded_instances: [] },
        ],
      },
    })
    const result = await CompatProbe.run({
      baseURL: lmstudio.baseURL,
      headers: KEY,
      models: ["qwen2.5-vl-7b-instruct", "qwen3-8b"],
    })
    expect(result?.capabilities).toEqual(
      new Map([
        // Reasoning `off` only: it does not reason (02 §3.3a).
        ["qwen2.5-vl-7b-instruct", { image: true, tools: true, reasoning: null }],
        // LM Studio serves tools to every model, so a model without native tool use is not reported as without tools.
        ["qwen3-8b", { image: false }],
      ]),
    )
    // Every model's vision was known: the older list was not asked.
    expect(lmstudio.seen.map((seen) => seen.path)).not.toContain("/api/v0/models")
  })

  test("LM Studio before the v1 API: type vlm and the tool_use capability of /api/v0/models", async () => {
    using lmstudio = serve({
      "GET /v1/models": {
        object: "list",
        data: ["qwen2-vl-7b-instruct", "llama-3.2-3b"].map((id) => ({
          id,
          object: "model",
          owned_by: "organization_owner",
        })),
      },
      "GET /api/v0/models": {
        object: "list",
        data: [
          {
            id: "qwen2-vl-7b-instruct",
            object: "model",
            type: "vlm",
            max_context_length: 32_768,
            capabilities: ["tool_use"],
          },
          { id: "llama-3.2-3b", object: "model", type: "llm", max_context_length: 131_072 },
        ],
      },
    })
    const result = await CompatProbe.run({
      baseURL: lmstudio.baseURL,
      headers: KEY,
      models: ["qwen2-vl-7b-instruct", "llama-3.2-3b"],
    })
    expect(result?.capabilities).toEqual(
      new Map([
        ["qwen2-vl-7b-instruct", { image: true, tools: true }],
        ["llama-3.2-3b", { image: false }],
      ]),
    )
  })

  test("llama.cpp: /props per model (vision with a projector, the chat template's tool calls), else /models", async () => {
    using llamacpp = serve({
      "GET /v1/models": {
        object: "list",
        data: [
          {
            id: "gemma-3-4b-it.gguf",
            object: "model",
            owned_by: "llamacpp",
            meta: { n_ctx_train: 131_072 },
            architecture: { input_modalities: ["text"] },
          },
        ],
      },
      "GET /props": {
        modalities: { vision: true, video: false, audio: false },
        chat_template_caps: { supports_tools: false, supports_tool_calls: false, supports_system_role: true },
      },
    })
    const result = await CompatProbe.run({ baseURL: llamacpp.baseURL, headers: KEY, models: ["gemma-3-4b-it.gguf"] })
    // /props wins over the /models entry.
    expect(result?.capabilities).toEqual(new Map([["gemma-3-4b-it.gguf", { image: true, tools: false }]]))
    // Router mode answers per model.
    expect(llamacpp.seen.find((seen) => seen.path === "/props")?.search).toBe("?model=gemma-3-4b-it.gguf")

    using older = serve({
      "GET /v1/models": {
        object: "list",
        data: [
          {
            id: "llava.gguf",
            object: "model",
            owned_by: "llamacpp",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          },
        ],
      },
    })
    const fallback = await CompatProbe.run({ baseURL: older.baseURL, headers: KEY, models: ["llava.gguf"] })
    expect(fallback?.capabilities).toEqual(new Map([["llava.gguf", { image: true }]]))
  })
})

describe("stored facts and the accounts.list view (07 §6.2 #2, #7)", () => {
  const providerID = Kind.ProviderID.from("compat", "c0mp")
  const accountID = Account.ID.make("acc_compat")

  function registry(compat?: Account.Compat): Registry.File {
    const built = Templates.fromCompat(
      [
        { id: "served", contextLimit: 64_000, outputLimit: 20_000 },
        { id: "capped", contextLimit: 8_000 },
        { id: "quiet", contextLimit: 128_000 },
      ],
      "2026-10-02T00:00:00Z",
    )
    if (!built.ok) throw new Error(built.reason)
    return {
      ...Store.emptyRegistry(),
      revision: 3,
      accounts: [
        {
          id: accountID,
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
          accounts: [accountID],
          pooling: "off",
          modelTemplate: OwnID.TemplateID.make("tpl_compat_c0mp"),
          baseURL: "http://127.0.0.1:1/v1",
        },
      },
      modelTemplates: { tpl_compat_c0mp: built.template },
    }
  }

  const outputsOf = (file: Registry.File) =>
    Object.fromEntries(file.modelTemplates.tpl_compat_c0mp!.models.map((model) => [model.id, model.limit.output]))

  /** What a server that tells nothing about images or tools (vLLM, a router) reports for the three models. */
  const silent = new Map(["served", "capped", "quiet"].map((id) => [id, {}]))
  const capabilitiesOf = (file: Registry.File) =>
    Object.fromEntries(file.modelTemplates.tpl_compat_c0mp!.models.map((model) => [model.id, model.capabilities]))
  const TEXT = { tools: true, input: ["text"], output: ["text"] }

  test("the server's value wins over the user's and the fallback, never above the window", () => {
    const before = registry({
      outputs: {
        served: { tokens: 20_000, source: "user" },
        capped: { tokens: 8_000, source: "fallback" },
        quiet: { tokens: 32_000, source: "fallback" },
      },
      server: { family: "other", overflowClassified: true },
    })
    expect(outputsOf(before)).toEqual({ served: 20_000, capped: 8_000, quiet: 32_000 })
    const after = CompatProbe.apply(before, accountID, {
      family: "vllm",
      outputs: new Map([
        ["served", 16_384],
        ["capped", 100_000],
        ["unknown-model", 4_096],
      ]),
      capabilities: silent,
    })
    if (!after) throw new Error("expected a change")
    expect(after.accounts[0]?.compat).toEqual({
      // An overflow already seen stays seen; the family is what the server said now.
      server: { family: "vllm", overflowClassified: true, reasoningRead: true },
      outputs: {
        served: { tokens: 16_384, source: "server" },
        capped: { tokens: 8_000, source: "server" },
        quiet: { tokens: 32_000, source: "fallback" },
      },
      // Read, with nothing reported: the start probe does not ask again.
      capabilities: { served: { detected: {} }, capped: { detected: {} }, quiet: { detected: {} } },
    })
    expect(outputsOf(after)).toEqual({ served: 16_384, capped: 8_000, quiet: 32_000 })
    // Nothing reported keeps every model as it registered: text in, tools on.
    expect(capabilitiesOf(after)).toEqual({ served: TEXT, capped: TEXT, quiet: TEXT })
    // Windows are never touched (R8).
    expect(after.modelTemplates.tpl_compat_c0mp!.models.map((model) => model.limit.context)).toEqual([
      64_000, 8_000, 128_000,
    ])
    expect(
      CompatProbe.apply(after, accountID, {
        family: "vllm",
        outputs: new Map([["served", 16_384]]),
        capabilities: silent,
      }),
    ).toBe(undefined)
    expect(
      CompatProbe.apply(after, "acc_other", { family: "vllm", outputs: new Map(), capabilities: new Map() }),
    ).toBeUndefined()
  })

  test("reported capabilities register; the user's settings win over them; untouched models stay byte-identical", () => {
    const before = registry({ capabilities: { capped: { tools: "on" } } })
    const read = CompatProbe.apply(before, accountID, {
      family: "ollama",
      outputs: new Map(),
      capabilities: new Map([
        ["served", { image: true, tools: true }],
        ["capped", { image: false, tools: false }],
        ["quiet", {}],
      ]),
    })
    if (!read) throw new Error("expected a change")
    expect(read.accounts[0]?.compat?.capabilities).toEqual({
      served: { detected: { image: true, tools: true } },
      // The user's `on` stays next to what the server said.
      capped: { detected: { image: false, tools: false }, tools: "on" },
      quiet: { detected: {} },
    })
    expect(capabilitiesOf(read)).toEqual({
      served: { tools: true, input: ["text", "image"], output: ["text"] },
      capped: TEXT,
      quiet: TEXT,
    })
    const pinned = before.modelTemplates.tpl_compat_c0mp!.models
    const now = read.modelTemplates.tpl_compat_c0mp!.models
    expect(now[1]).toBe(pinned[1]!)
    expect(now[2]).toBe(pinned[2]!)
    // The changed model keeps its key order (registry bytes), only its capabilities differ.
    expect(Object.keys(now[0]!)).toEqual(Object.keys(pinned[0]!))
    expect({ ...now[0], capabilities: pinned[0]!.capabilities }).toEqual(pinned[0]!)

    // accounts.update{compatCapabilities}: `auto` follows the server again, `off` overrides it, absent keeps.
    const set = CompatProbe.configure(read, accountID, [
      { id: "served", image: "off" },
      { id: "capped", tools: "auto" },
    ])
    if (!set.ok || !set.registry) throw new Error("expected a change")
    expect(set.registry.accounts[0]?.compat?.capabilities).toEqual({
      served: { detected: { image: true, tools: true }, image: "off" },
      capped: { detected: { image: false, tools: false } },
      quiet: { detected: {} },
    })
    expect(capabilitiesOf(set.registry)).toEqual({
      served: TEXT,
      capped: { tools: false, input: ["text"], output: ["text"] },
      quiet: TEXT,
    })
    expect(CompatProbe.configure(set.registry, accountID, [{ id: "served", image: "off" }])).toEqual({
      ok: true,
      registry: undefined,
    })
    expect(CompatProbe.configure(set.registry, accountID, [{ id: "nope", tools: "on" }])).toEqual({
      ok: false,
      unknown: ["nope"],
    })
  })

  test("the start probe reads an account whose server or model capabilities were never read", () => {
    const ids = ["served", "capped", "quiet"]
    const account = (compat?: Account.Compat) => registry(compat).accounts[0]!
    const server = { family: "vllm" as const, overflowClassified: false, reasoningRead: true }
    expect(CompatProbe.due(account(), ids)).toBe(true)
    // Read before 02 §3.3a: once more for the models' reasoning.
    expect(
      CompatProbe.due(account({ server: { family: "vllm", overflowClassified: false }, capabilities: {} }), []),
    ).toBe(true)
    // Read before the capability settings existed.
    expect(CompatProbe.due(account({ server }), ids)).toBe(true)
    // A setting alone is not a reading.
    expect(CompatProbe.due(account({ server, capabilities: { served: { image: "on" } } }), ids)).toBe(true)
    const read = { served: { detected: {} }, capped: { detected: { tools: true } }, quiet: { detected: {} } }
    expect(CompatProbe.due(account({ server, capabilities: read }), ids)).toBe(false)
    expect(CompatProbe.due(account({ server, capabilities: read }), [...ids, "added-later"])).toBe(true)
  })

  test("an observed overflow marks the account once; an unknown family stays other", () => {
    const marked = CompatProbe.classified(registry(), accountID)
    expect(marked?.accounts[0]?.compat?.server).toEqual({ family: "other", overflowClassified: true })
    expect(CompatProbe.classified(marked!, accountID)).toBeUndefined()
    const ollama = CompatProbe.classified(
      registry({ server: { family: "ollama", overflowClassified: false } }),
      accountID,
    )
    expect(ollama?.accounts[0]?.compat?.server).toEqual({ family: "ollama", overflowClassified: true })
  })

  test("view: outputs with their sources, a fallback for accounts that predate them, running windows passed on", () => {
    const file = registry({ outputs: { served: { tokens: 20_000, source: "user" } } })
    const models = file.modelTemplates.tpl_compat_c0mp!.models
    const window = { runtime: 8_192, needed: 27_000, status: "unverified" as const }
    const view = CompatProbe.view(file.accounts[0]!, models, (modelID) => (modelID === "quiet" ? window : undefined))
    const text = {
      image: { on: false, setting: "auto" },
      tools: { on: true, setting: "auto" },
      reasoning: { setting: "auto", levels: [] },
    } as const
    expect(view).toEqual({
      models: [
        { id: "served", output: { tokens: 20_000, source: "user" }, ...text },
        { id: "capped", output: { tokens: 8_000, source: "fallback" }, ...text },
        { id: "quiet", output: { tokens: 32_000, source: "fallback" }, localWindow: window, ...text },
      ],
    })
    const seen = registry({ server: { family: "llamacpp", overflowClassified: false } })
    expect(CompatProbe.view(seen.accounts[0]!, [], () => undefined).server).toEqual({
      family: "llamacpp",
      overflowClassified: CompatProbe.OVERFLOW_VERIFIED.has("llamacpp"),
    })
  })

  test("view: each capability as registered, with the user's setting and what the server said", () => {
    const read = CompatProbe.apply(registry({ capabilities: { capped: { image: "on", tools: "off" } } }), accountID, {
      family: "ollama",
      outputs: new Map(),
      capabilities: new Map([
        ["served", { image: true, tools: true }],
        ["capped", { image: false, tools: true }],
        ["quiet", {}],
      ]),
    })
    if (!read) throw new Error("expected a change")
    const view = CompatProbe.view(read.accounts[0]!, read.modelTemplates.tpl_compat_c0mp!.models, () => undefined)
    expect(view.models.map((model) => [model.id, model.image, model.tools])).toEqual([
      ["served", { on: true, setting: "auto", detected: true }, { on: true, setting: "auto", detected: true }],
      ["capped", { on: true, setting: "on", detected: false }, { on: false, setting: "off", detected: true }],
      ["quiet", { on: false, setting: "auto" }, { on: true, setting: "auto" }],
    ])
  })
})
