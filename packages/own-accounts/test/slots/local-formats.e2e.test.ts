// Local models on a real upstream server (02 §3.3a): one `로컬 모델` account per API format, each against a fake
// local server, added through `accounts.add.key` with `options.local`.
// - Chat Completions without a key: the server names its levels in `/models` (`reasoning_efforts`), the probe registers
//   them as effort variants, a session on a level sends `reasoning_effort` and no credential at all, and the account
//   lists as free (`billing: "local"`).
// - Responses with a key: the user's levels (`accounts.update{compatCapabilities}`) go out as `reasoning.effort` to
//   `/v1/responses`.
// - Anthropic Messages: a thinking budget per level to `/v1/messages`.
// - Ollama: `/api/show` lists `thinking`, so the model turns reasoning on and off with `reasoning_effort`.
// - `로컬 모델로 바꾸기` of a `기타 OpenAI 호환` account keeps its key and models and registers the format's variants.
// Every credential is fake.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import {
  REPO_ROOT,
  hashSecret,
  opencodeConfig,
  startFakeAnthropic,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeAnthropic,
  type FakeOpenAIChat,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const THINK = "local-flash-model-q4-0001"
const LEVELS = ["low", "high", "xhigh", "max"]
// Fake credentials only.
const KEY = "sk-e2e-local-formats-0000000000000000000001"
const COMPAT_KEY = "sk-e2e-local-formats-0000000000000000000002"

type Json = Record<string, unknown>

describe("local models: one account per API format (02 §3.3a)", () => {
  const state: {
    chat?: FakeOpenAIChat
    ollama?: FakeOpenAIChat
    responses?: FakeOpenAIResponses
    anthropic?: FakeAnthropic
    server?: OpencodeServer
    control?: string
  } = {}

  async function rpc(method: OwnAccounts.MethodName, input: unknown = {}) {
    const server = required(state.server)
    const directory =
      OwnAccounts.MethodLocation[method] === "session" ? server.paths.workspace : required(state.control)
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const body = (await response.json()) as { readonly output?: Json }
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body)}`)
    return body.output ?? {}
  }

  async function add(label: string, baseURL: string, format: string, model: string, extra: Json = {}) {
    const added = await rpc("accounts.add.key", {
      kind: "compat",
      label,
      ...extra,
      options: { baseURL, local: { format }, models: [{ id: model, contextLimit: 131_072, outputLimit: 32_000 }] },
    })
    const providerID = String((added.account as Json).providerID)
    await required(state.server).waitForModels([{ providerID, id: model }])
    return providerID
  }

  async function variantsOf(providerID: string, model: string) {
    const models = await required(state.server).models()
    const found = models.find((item) => item.providerID === providerID && item.id === model)
    return Array.isArray(found?.variants) ? found.variants.map((variant) => String((variant as Json).id)) : []
  }

  /** One prompt on the model at `variant`, then the request the fake got. */
  async function send(
    fake: { readonly requests: ReadonlyArray<{ readonly path: string }> },
    ref: Json,
    suffix: string,
  ) {
    const server = required(state.server)
    const session = await server.createSession({ model: ref as never })
    const before = fake.requests.length
    const response = await server.request("POST", `/api/session/${session.id}/prompt`, {
      body: { text: "hello", files: [] },
    })
    expect(response.status).toBe(200)
    await server.waitIdle(session.id)
    const request = fake.requests.slice(before).find((item) => item.path.endsWith(suffix))
    if (!request)
      throw new Error(
        `no ${suffix} request: ${JSON.stringify(fake.requests.slice(before).map((item) => item.path))} ${JSON.stringify(await server.messages(session.id)).slice(0, 3000)}`,
      )
    return request as unknown as { readonly json: unknown; readonly headers: Readonly<Record<string, string>> }
  }

  beforeAll(async () => {
    state.chat = startFakeOpenAIChat({
      models: [THINK, "plain"],
      modelFields: {
        [THINK]: { max_model_len: 1_048_576, reasoning_efforts: LEVELS, default_reasoning_effort: "max" },
      },
      anonymous: true,
    })
    state.ollama = startFakeOpenAIChat({
      models: ["qwen3:8b"],
      native: {
        "GET /api/version": () => ({ version: "0.12.3" }),
        "POST /api/show": () => ({ capabilities: ["completion", "tools", "thinking"], parameters: "num_ctx 32768" }),
      },
    })
    // `anonymous: true` lets a keyless local account (L9) probe and call; a keyed request still carries its key.
    state.responses = startFakeOpenAIResponses({ models: ["gpt-oss-20b"], anonymous: true })
    state.anthropic = startFakeAnthropic({ models: ["glm-local"], anonymous: true })
    const server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: { home: paths.ownHome, buildId: `e2e-local-formats-${process.pid}`, vault: "memory" },
            },
          ],
        }),
    })
    state.server = server
    const control = path.join(server.paths.ownHome, "control")
    await fs.mkdir(control, { recursive: true })
    state.control = control
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await Promise.all([state.chat?.stop(), state.ollama?.stop(), state.responses?.stop(), state.anthropic?.stop()])
  }, 60_000)

  test("the add form's server read lists the models with what the server says", async () => {
    const found = await rpc("accounts.local.detect", { baseURL: required(state.chat).baseURL, format: "chat" })
    expect(found).toMatchObject({
      ok: true,
      family: "vllm",
      models: [
        {
          id: THINK,
          context: 1_048_576,
          reasoning: { style: "effort", levels: LEVELS, default: "max" },
        },
        { id: "plain" },
      ],
    })
    const missing = await rpc("accounts.local.detect", { baseURL: "http://127.0.0.1:9/v1", format: "chat" })
    expect(missing).toMatchObject({ ok: false, models: [] })
  })

  test("Chat Completions without a key: the server's levels, reasoning_effort, no credential, free", async () => {
    const chat = required(state.chat)
    const providerID = await add("Local chat", chat.baseURL, "chat", THINK)
    await until(async () => (await variantsOf(providerID, THINK)).length > 0, 30_000)
    expect(await variantsOf(providerID, THINK)).toEqual(LEVELS)
    const request = await send(chat, { providerID, id: THINK, variant: "high" }, "/chat/completions")
    expect((request.json as Json).reasoning_effort).toBe("high")
    expect(request.headers.authorization).toBeUndefined()
    // No level picked: none sent, the server's default applies.
    const plain = await send(chat, { providerID, id: THINK }, "/chat/completions")
    expect((plain.json as Json).reasoning_effort).toBeUndefined()
    const listed = await rpc("accounts.list")
    const card = (listed.accounts as ReadonlyArray<Json>).find((item) => item.providerID === providerID)
    expect(card).toMatchObject({ billing: "local", status: "ready", compat: { local: { format: "chat" } } })
    expect((card?.identity as Json | undefined)?.keyHint).toBeUndefined()
  })

  test("Responses with a key: the user's levels go out as reasoning.effort", async () => {
    const responses = required(state.responses)
    const providerID = await add("Local responses", responses.baseURL, "responses", "gpt-oss-20b", { key: KEY })
    const accountID = await accountOf(providerID)
    await rpc("accounts.update", {
      accountID,
      compatCapabilities: [{ id: "gpt-oss-20b", reasoning: { style: "effort", levels: ["low", "medium", "high"] } }],
    })
    await until(async () => (await variantsOf(providerID, "gpt-oss-20b")).length === 3, 30_000)
    const request = await send(responses, { providerID, id: "gpt-oss-20b", variant: "low" }, "/responses")
    expect((request.json as Json).reasoning).toMatchObject({ effort: "low" })
    expect(request.headers.authorization).toBe(hashSecret(`Bearer ${KEY}`))
  })

  test("Anthropic Messages: a thinking budget per level", async () => {
    const anthropic = required(state.anthropic)
    const providerID = await add("Local anthropic", anthropic.baseURL, "anthropic", "glm-local", { key: KEY })
    const accountID = await accountOf(providerID)
    await rpc("accounts.update", {
      accountID,
      compatCapabilities: [{ id: "glm-local", reasoning: { style: "budget" } }],
    })
    await until(async () => (await variantsOf(providerID, "glm-local")).length === 3, 30_000)
    expect(await variantsOf(providerID, "glm-local")).toEqual(["none", "high", "max"])
    const request = await send(anthropic, { providerID, id: "glm-local", variant: "high" }, "/messages")
    expect((request.json as Json).thinking).toEqual({ type: "enabled", budget_tokens: 16_000 })
  })

  test("Responses without a key: no credential goes out, billing local and free (L9)", async () => {
    const responses = required(state.responses)
    const providerID = await add("Local responses keyless", responses.baseURL, "responses", "gpt-oss-20b")
    const accountID = await accountOf(providerID)
    await rpc("accounts.update", {
      accountID,
      compatCapabilities: [{ id: "gpt-oss-20b", reasoning: { style: "effort", levels: ["low", "medium", "high"] } }],
    })
    await until(async () => (await variantsOf(providerID, "gpt-oss-20b")).length === 3, 30_000)
    const request = await send(responses, { providerID, id: "gpt-oss-20b", variant: "low" }, "/responses")
    expect((request.json as Json).reasoning).toMatchObject({ effort: "low" })
    expect(request.headers.authorization).toBeUndefined()
    const card = (await rpc("accounts.list")).accounts as ReadonlyArray<Json>
    const found = card.find((item) => item.providerID === providerID)
    expect(found).toMatchObject({ billing: "local", status: "ready", compat: { local: { format: "responses" } } })
    expect((found?.identity as Json | undefined)?.keyHint).toBeUndefined()
  })

  test("Anthropic Messages without a key: no credential goes out, billing local and free (L9)", async () => {
    const anthropic = required(state.anthropic)
    const providerID = await add("Local anthropic keyless", anthropic.baseURL, "anthropic", "glm-local")
    const accountID = await accountOf(providerID)
    await rpc("accounts.update", {
      accountID,
      compatCapabilities: [{ id: "glm-local", reasoning: { style: "budget" } }],
    })
    await until(async () => (await variantsOf(providerID, "glm-local")).length === 3, 30_000)
    const request = await send(anthropic, { providerID, id: "glm-local", variant: "high" }, "/messages")
    expect((request.json as Json).thinking).toEqual({ type: "enabled", budget_tokens: 16_000 })
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers["x-api-key"]).toBeUndefined()
    const card = (await rpc("accounts.list")).accounts as ReadonlyArray<Json>
    const found = card.find((item) => item.providerID === providerID)
    expect(found).toMatchObject({ billing: "local", status: "ready", compat: { local: { format: "anthropic" } } })
    expect((found?.identity as Json | undefined)?.keyHint).toBeUndefined()
  })

  test("Ollama: a thinking model turns reasoning on and off through reasoning_effort", async () => {
    const ollama = required(state.ollama)
    const providerID = await add("Local ollama", ollama.baseURL, "ollama", "qwen3:8b", { key: KEY })
    await until(async () => (await variantsOf(providerID, "qwen3:8b")).length > 0, 30_000)
    expect(await variantsOf(providerID, "qwen3:8b")).toEqual(["none", "thinking"])
    const request = await send(ollama, { providerID, id: "qwen3:8b", variant: "none" }, "/chat/completions")
    expect((request.json as Json).reasoning_effort).toBe("none")
  })

  test("로컬 모델로 바꾸기 keeps the key and models and offers the server's levels", async () => {
    const chat = required(state.chat)
    const added = await rpc("accounts.add.key", {
      kind: "compat",
      label: "Compat",
      key: COMPAT_KEY,
      options: { baseURL: chat.baseURL, models: [{ id: THINK, contextLimit: 131_072 }] },
    })
    const providerID = String((added.account as Json).providerID)
    const accountID = String((added.account as Json).id)
    await required(state.server).waitForModels([{ providerID, id: THINK }])
    // Reasoning the server names registers for a `기타 OpenAI 호환` account too.
    await until(async () => (await variantsOf(providerID, THINK)).length > 0, 30_000)
    let card = (await rpc("accounts.list")).accounts as ReadonlyArray<Json>
    expect(card.find((item) => item.id === accountID)).toMatchObject({ billing: "metered" })
    await rpc("accounts.update", { accountID, local: { format: "chat" } })
    card = (await rpc("accounts.list")).accounts as ReadonlyArray<Json>
    expect(card.find((item) => item.id === accountID)).toMatchObject({
      billing: "local",
      identity: { keyHint: expect.any(String) },
      compat: { local: { format: "chat" } },
    })
    const request = await send(chat, { providerID, id: THINK, variant: "max" }, "/chat/completions")
    expect((request.json as Json).reasoning_effort).toBe("max")
    expect(request.headers.authorization).toBe(hashSecret(`Bearer ${COMPAT_KEY}`))
  })

  async function accountOf(providerID: string) {
    const listed = await rpc("accounts.list")
    const found = (listed.accounts as ReadonlyArray<Json>).find((item) => item.providerID === providerID)
    return String(found?.id)
  }
})

async function until(probe: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return
    await Bun.sleep(200)
  }
  throw new Error(`condition not met within ${ms}ms`)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("local formats e2e fixture was not set up")
  return value
}
