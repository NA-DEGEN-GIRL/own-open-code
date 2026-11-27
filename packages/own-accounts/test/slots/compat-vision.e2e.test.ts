// Local models on a real upstream server (02 §3.3): an own `compat` slot created by `accounts.add.key` against a fake
// Ollama-flavoured OpenAI-compatible server (chat completions plus `/api/version` and `/api/show`). The compat probe
// reads each model's capabilities from `/api/show`, the slot registers them, and the requests follow:
// - an image attached in own-web reaches the vision model as an `image_url` part with a data URL, and the text-only
//   model as an `Attached file:` path line (own-web's own routing, `attachments/model.ts`, decides from the registered
//   capabilities, as the composer does);
// - the model whose server reports no tool support gets no tool definitions; the others do.
// The account's key goes only to its own server. Every credential is fake.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { modelInput, promptParts, routeFor } from "../../../own-web/src/attachments/model.js"
import {
  REPO_ROOT,
  hashSecret,
  opencodeConfig,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../e2e-kit"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const ACCOUNTS = path.join(REPO_ROOT, "packages/own-accounts")
const VISION = "qwen2.5vl:7b"
const TEXT = "qwen3:8b"
const CHAT = "gemma3:1b"
/** What each model's `/api/show` lists (Ollama 0.6.4+). */
const CAPABILITIES: Readonly<Record<string, ReadonlyArray<string>>> = {
  [VISION]: ["completion", "vision", "tools"],
  [TEXT]: ["completion", "tools"],
  [CHAT]: ["completion"],
}
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
// Fake credential only.
const KEY = "sk-e2e-local-models-0000000000000000000001"

type Json = Record<string, unknown>

describe("local models: detected capabilities shape the requests (02 §3.3)", () => {
  const state: { chat?: FakeOpenAIChat; server?: OpencodeServer; control?: string; providerID?: string } = {}

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

  /** The slot's models as the server lists them now. */
  async function registered() {
    const models = await required(state.server).models()
    return new Map(models.filter((model) => model.providerID === state.providerID).map((model) => [model.id, model]))
  }

  const capabilitiesOf = (model: Json | undefined) =>
    isRecord(model?.capabilities) ? (model.capabilities as { tools: boolean; input: ReadonlyArray<string> }) : undefined

  /** One prompt as own-web's composer sends it, then the chat request it made. */
  async function send(model: string, prompt: { readonly text: string; readonly files: ReadonlyArray<object> }) {
    const server = required(state.server)
    const chat = required(state.chat)
    const session = await server.createSession({ model: { providerID: required(state.providerID), id: model } })
    const before = chat.requests.length
    const response = await server.request("POST", `/api/session/${session.id}/prompt`, { body: prompt })
    expect(response.status).toBe(200)
    await server.waitIdle(session.id)
    const request = chat.requests.slice(before).find((item) => item.path.endsWith("/chat/completions"))
    if (!request) throw new Error(`no chat request for ${model}`)
    return request
  }

  beforeAll(async () => {
    const chat = startFakeOpenAIChat({
      models: Object.keys(CAPABILITIES),
      native: {
        "GET /api/version": () => ({ version: "0.12.3" }),
        "POST /api/show": (json) => ({
          capabilities: isRecord(json) && typeof json.model === "string" ? CAPABILITIES[json.model] : undefined,
        }),
      },
    })
    state.chat = chat
    const server = await startOpencodeServer({
      env: { OWN_OPEN_CODE: "1" },
      config: (paths) =>
        opencodeConfig({
          providers: {},
          plugins: [
            {
              package: ACCOUNTS,
              options: { home: paths.ownHome, buildId: `e2e-local-models-${process.pid}`, vault: "memory" },
            },
          ],
        }),
    })
    state.server = server
    const control = path.join(server.paths.ownHome, "control")
    await fs.mkdir(control, { recursive: true })
    state.control = control
    const added = await rpc("accounts.add.key", {
      kind: "compat",
      label: "Ollama",
      key: KEY,
      options: {
        baseURL: chat.baseURL,
        models: Object.keys(CAPABILITIES).map((id) => ({ id, contextLimit: 32_768 })),
      },
    })
    const account = isRecord(added.account) ? added.account : {}
    state.providerID = String(account.providerID)
    await server.waitForModels(Object.keys(CAPABILITIES).map((id) => ({ providerID: required(state.providerID), id })))
    // The probe runs in the background after the account is added; every Location then registers what it read.
    await until(async () => capabilitiesOf((await registered()).get(VISION))?.input.includes("image") === true, 30_000)
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
    await state.chat?.stop()
  }, 60_000)

  test("the slot registers what the server reported, and the account card shows it", async () => {
    const models = await registered()
    expect(capabilitiesOf(models.get(VISION))).toMatchObject({ tools: true, input: ["text", "image"] })
    expect(capabilitiesOf(models.get(TEXT))).toMatchObject({ tools: true, input: ["text"] })
    expect(capabilitiesOf(models.get(CHAT))).toMatchObject({ tools: false, input: ["text"] })
    const listed = await rpc("accounts.list")
    const card = (listed.accounts as ReadonlyArray<Json>).find((item) => item.providerID === state.providerID)
    expect(card?.compat).toMatchObject({
      server: { family: "ollama" },
      models: [
        { id: VISION, image: { on: true, setting: "auto", detected: true } },
        { id: TEXT, image: { on: false, setting: "auto", detected: false } },
        { id: CHAT, tools: { on: false, setting: "auto", detected: false } },
      ],
    })
    // The probe's requests carried the account's own key, to its own server only.
    const probes = required(state.chat).requests.filter((item) => item.path.startsWith("/api/"))
    expect(probes.length).toBeGreaterThan(0)
    expect(new Set(probes.map((item) => item.headers.authorization))).toEqual(new Set([hashSecret(`Bearer ${KEY}`)]))
  })

  test("an attached image reaches the vision model as an image_url data URL", async () => {
    const info = (await registered()).get(VISION)
    const route = routeFor({ size: 70, mime: "image/png", input: modelInput(capabilitiesOf(info)), local: true })
    expect(route).toEqual({ kind: "inline" })
    const uri = `data:image/png;base64,${PNG}`
    const request = await send(
      VISION,
      promptParts("이 그림에 뭐가 있어?", [{ kind: "inline", name: "dot.png", mime: "image/png", uri }]),
    )
    const parts = userParts(request.json)
    expect(parts).toContainEqual({ type: "image_url", image_url: { url: uri } })
    expect(request.body).not.toContain("Attached file:")
  })

  test("the text-only model gets the image as a path line, not as an image", async () => {
    const file = path.join(required(state.server).paths.workspace, "dot.png")
    await Bun.write(file, Buffer.from(PNG, "base64"))
    const info = (await registered()).get(TEXT)
    const route = routeFor({
      size: 70,
      mime: "image/png",
      input: modelInput(capabilitiesOf(info)),
      local: true,
      nativePath: file,
    })
    expect(route).toEqual({ kind: "path", path: file, imageFallback: true })
    const prompt = promptParts("이 그림에 뭐가 있어?", [
      { kind: "path", name: "dot.png", mime: "image/png", path: file },
    ])
    const request = await send(TEXT, { text: prompt.text, files: prompt.files })
    expect(request.body).not.toContain("image_url")
    expect(JSON.stringify(userParts(request.json))).toContain(`Attached file: \`${file.replaceAll("\\", "\\\\")}\``)
  })

  test("the model without tool support chats without tool definitions; the others get them", async () => {
    const withTools = await send(TEXT, { text: "hello", files: [] })
    expect(Array.isArray(isRecord(withTools.json) ? withTools.json.tools : undefined)).toBe(true)
    expect(((withTools.json as Json).tools as ReadonlyArray<unknown>).length).toBeGreaterThan(0)
    const chatOnly = await send(CHAT, { text: "hello", files: [] })
    expect(isRecord(chatOnly.json) ? chatOnly.json.tools : undefined).toBeUndefined()
    expect(chatOnly.status).toBe(200)
  })
})

/** Every content part (or plain text) of the request's user messages. */
function userParts(json: unknown) {
  const messages = isRecord(json) && Array.isArray(json.messages) ? json.messages.filter(isRecord) : []
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content) }],
    )
}

async function until(probe: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return
    await Bun.sleep(200)
  }
  throw new Error(`condition not met within ${ms}ms`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("local models e2e fixture was not set up")
  return value
}
