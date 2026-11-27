// 설정 > 에이전트 방식 end to end (10 §3.11): `prompt.preview` against the request a session really sends, for each
// harness, variant and model route (OpenAI Responses, Anthropic Messages, DeepSeek chat): the base text, the generated
// parts and the harness's tools are the bytes of the captured request. Then 내 지시문: a saved text is the next
// request's base text with everything else unchanged, the default can be it, and 기본으로 되돌리기 sends 개선판 again.
// `하위 에이전트`: Pi's and DeepSeek's preview names core's `subagent` with the description the request carries (core's
// "Available subagents:" list for the session's agent), and `prompt.subagent` answers the same for OpenCode 기본.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  anthropicProvider,
  deepseekProvider,
  openAIResponsesProvider,
  opencodeConfig,
  REPO_ROOT,
  sessionInfo,
  startFakeAnthropic,
  startFakeOpenAIChat,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { CodexVariant } from "../../src/codex/variant.js"
import { DshPrompt } from "../../src/dsh/prompt.js"
import { PiPrompt } from "../../src/pi/prompt.js"

const BOOT_TIMEOUT = 180_000
const MODELS = {
  gpt: { providerID: "fake-openai", id: "gpt-5.5" },
  // Codex in Code Mode on a v1 model (Codex's catalog): no v1 agent tools, core's subagent stays.
  luna: { providerID: "fake-openai", id: "gpt-5.6-luna" },
  opus: { providerID: "fake-anthropic", id: "claude-opus-5-5" },
  sonnet: { providerID: "fake-anthropic", id: "claude-sonnet-5-5" },
  deepseek: { providerID: "fake-deepseek", id: "deepseek-v4-pro" },
} as const
type ModelKey = keyof typeof MODELS

const openai = startFakeOpenAIResponses({ models: ["gpt-5.5", "gpt-5.6-luna"] })
const anthropic = startFakeAnthropic({ models: ["claude-opus-5-5", "claude-sonnet-5-5"] })
const deepseek = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
const fakeOf = (key: ModelKey) => (key === "gpt" || key === "luna" ? openai : key === "deepseek" ? deepseek : anthropic)
let server: OpencodeServer

/** own's ask bundle with a protected deny, so exec_command answers reads (CodexReadOnly.serves), as own-accounts sets. */
const ask = () => [
  { action: "edit", resource: "**", effect: "ask" },
  { action: "shell", resource: "**", effect: "ask" },
  { action: "read", resource: `${server.paths.root.replaceAll("\\", "/")}/protected/**`, effect: "deny" },
]

beforeAll(async () => {
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-openai": {
            ...openAIResponsesProvider(openai, { apiKey: "fake-key", models: ["gpt-5.5", "gpt-5.6-luna"] }),
            canonical: "openai",
          },
          "fake-anthropic": {
            ...anthropicProvider(anthropic, { apiKey: "fake-key", models: ["claude-opus-5-5", "claude-sonnet-5-5"] }),
            canonical: "anthropic",
          },
          "fake-deepseek": {
            ...deepseekProvider(deepseek, { apiKey: "fake-key", models: ["deepseek-v4-pro"] }),
            canonical: "deepseek",
          },
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  for (let attempt = 1; ; attempt++) {
    const ready = await server.waitForModels(Object.values(MODELS), 60_000).then(
      () => true,
      () => false,
    )
    if (ready) break
    if (attempt === 5) throw new Error("models never listed")
  }
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await Promise.all([openai.stop(), anthropic.stop(), deepseek.stop()])
}, 60_000)

async function rpc<T>(method: string, input: unknown) {
  const response = await server.request("POST", `/api/rpc/${OwnHarness.ID}/${method}`, {
    body: { input },
    query: { "location[directory]": server.paths.workspace },
  })
  const body = (await response.json()) as { output?: T; type?: string }
  if (response.status !== 200) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output as T
}

async function create(key: ModelKey, harness: OwnHarness.HarnessID, prompt?: OwnHarness.PromptID) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `prompts ${harness} ${key}`,
      model: MODELS[key],
      location: { directory: server.paths.workspace },
      permissions: ask(),
      ...(prompt === undefined ? {} : { metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness, prompt) } }),
    },
  })) as { data: { id: string } }
  const deadline = Date.now() + 15_000
  // The harness's tool gate is written right after creation; the first request must list its tools.
  while (
    !JSON.stringify((await sessionInfo(server, created.data.id)).permissions ?? []).includes("own_harness") ||
    OwnHarness.bound((await sessionInfo(server, created.data.id)).metadata as Record<string, unknown>) === undefined
  ) {
    if (Date.now() > deadline) throw new Error("own.harness did not stamp the session")
    await Bun.sleep(50)
  }
  return created.data.id
}

/** Sends `text` and returns the main request that carried it, as the fake received it. */
async function send(key: ModelKey, sessionID: string, text: string) {
  const fake = fakeOf(key)
  const before = fake.requests.length
  fake.enqueue({ type: "text", text: "ok" })
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
  const bodies = fake.requests
    .slice(before)
    .flatMap((request) => (request.method === "POST" ? [request.json as Record<string, any>] : []))
  const body = bodies.findLast((entry) => toolList(entry).length > 0 && JSON.stringify(entry).includes(text))
  if (body === undefined) throw new Error(`no request carried ${text}`)
  return body
}

/** A request's tools: Responses Lite (Codex's Code Mode models) sends them in an `additional_tools` input item. */
function toolList(body: Record<string, any>): Array<Record<string, any>> {
  const extra = Array.isArray(body.input)
    ? (body.input as Array<Record<string, any>>).flatMap((item) => (item.type === "additional_tools" ? item.tools : []))
    : []
  return [...(Array.isArray(body.tools) ? body.tools : []), ...extra]
}

/** The request's instruction texts in order, and its tools by name, whatever the route. */
function sent(body: Record<string, any>) {
  const content = (value: unknown) =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap((part: Record<string, any>) => (typeof part.text === "string" ? [part.text] : []))
        : []
  const system = Array.isArray(body.system) ? body.system.flatMap((part: Record<string, any>) => [part.text]) : []
  const messages = (body.input ?? body.messages) as Array<Record<string, any>>
  const texts = [...system, ...messages.flatMap((message) => content(message.content))]
  const tools = new Map<string, string>(
    toolList(body).flatMap((tool) => {
      // Responses Lite's `functions` namespace holds the top-level tools under their own names.
      if (tool.type === "namespace")
        return (tool.tools as Array<Record<string, any>>).map((leaf) => [
          tool.name === "functions" ? leaf.name : `${tool.name}__${leaf.name}`,
          leaf.description,
        ])
      const name = tool.name ?? tool.function?.name
      return [[name, tool.description ?? tool.function?.description]]
    }),
  )
  return { texts, joined: texts.join("\n\n"), tools }
}

const withoutDate = (text: string) =>
  text
    .replace(/\n {2}<current_date>[^<]*<\/current_date>/, "")
    // dsh's time reading is taken when the request (or the preview) is made.
    .replace(/(preparing turn \d+, step \d+: )\S+/, "$1<TIME>")

function preview(harness: OwnHarness.CustomHarnessID, prompt: OwnHarness.PromptID, key: ModelKey) {
  return rpc<OwnHarness.PromptPreview>("prompt.preview", {
    harness,
    prompt,
    model: { providerID: MODELS[key].providerID, modelID: MODELS[key].id },
    mode: "ask",
    directory: server.paths.workspace,
  })
}

/** Every part of the preview is in the request; the base text leads it; the harness's tools are sent as listed. */
function expectSame(view: OwnHarness.PromptPreview, body: Record<string, any>) {
  const request = sent(body)
  // A chat route joins the system parts into one system message.
  expect(request.texts[0]!.startsWith(view.parts[0]!.text)).toBe(true)
  view.parts.forEach((part) =>
    expect([part.kind, request.texts.some((text) => withoutDate(text).includes(withoutDate(part.text)))]).toEqual([
      part.kind,
      true,
    ]),
  )
  const listed = view.tools.filter((tool) => request.tools.has(tool.name))
  // Tools behind Codex's tool search (gpt-5.5's agent tools) are not sent up front; the rest are.
  expect(listed.length).toBeGreaterThan(0)
  listed.forEach((tool) => expect([tool.name, request.tools.get(tool.name)]).toEqual([tool.name, tool.description]))
}

describe("prompt.preview is what the session sends", () => {
  const cases = [
    ...(["gpt", "opus", "sonnet", "deepseek"] as const).flatMap((key) =>
      (["reference", "own"] as const).map((prompt) => ["codex", prompt, key] as const),
    ),
    ...(["gpt", "opus"] as const).flatMap((key) =>
      (["reference", "own"] as const).map((prompt) => ["pi", prompt, key] as const),
    ),
    ...(["deepseek", "gpt"] as const).flatMap((key) =>
      (["reference", "own"] as const).map((prompt) => ["dsh", prompt, key] as const),
    ),
  ]
  for (const [harness, prompt, key] of cases)
    test(`${harness} · ${prompt} · ${MODELS[key].id}`, async () => {
      const sessionID = await create(key, harness, prompt)
      const body = await send(key, sessionID, `hi ${harness} ${prompt} ${key}`)
      const view = await preview(harness, prompt, key)
      expect(view.applied).toBe(prompt)
      expectSame(view, body)
      // Codex replaces core's subagent with its agent tools, which the tool list above compares when sent up front.
      if (harness !== "codex") {
        const description = sent(body).tools.get("subagent")
        expect(description).toContain("\n\nAvailable subagents:\n")
        expect([view.subagent?.tool?.name, view.subagent?.tool?.description]).toEqual(["subagent", description])
      }
    }, 60_000)

  test("Codex in Code Mode on a v1 model: the request keeps core's subagent, as the preview says", async () => {
    const sessionID = await create("luna", "codex", "own")
    const body = await send("luna", sessionID, "hi codex luna subagent")
    const view = await preview("codex", "own", "luna")
    const tools = sent(body).tools
    expect(tools.has("exec")).toBe(true)
    expect(tools.has("multi_agent_v1__spawn_agent")).toBe(false)
    expect(view.subagent).toMatchObject({
      kind: "core",
      agent: "build",
      opening: "You are a subagent spawned by another session.\n",
    })
    expect([view.subagent?.tool?.name, view.subagent?.tool?.description]).toEqual(["subagent", tools.get("subagent")])
  }, 60_000)

  test("prompt.subagent: what an OpenCode 기본 conversation gets, as the request carries it", async () => {
    const created = (await server.call("POST", "/api/session", {
      body: {
        title: "prompts opencode",
        model: MODELS.deepseek,
        location: { directory: server.paths.workspace },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value("opencode") },
      },
    })) as { data: { id: string } }
    const body = await send("deepseek", created.data.id, "hi opencode subagent")
    const view = await rpc<OwnHarness.PromptSubagent>("prompt.subagent", {})
    expect(view).toMatchObject({ kind: "core", agent: "build", guidance: "" })
    expect([view.tool?.name, view.tool?.description]).toEqual(["subagent", sent(body).tools.get("subagent")])
    expect(view.opening).toBe("You are a subagent spawned by another session.\n")
  }, 60_000)
})

describe("내 지시문", () => {
  test("codex: the saved text is the next request's base text, the rest stays 개선판's; reset sends 개선판 again", async () => {
    const own = await preview("codex", "own", "opus")
    const text = `CUSTOM-CODEX: answer in Korean.\n\n# Editing files\n${CodexVariant.PATCH_SLOT}`
    expect(await rpc<OwnHarness.List>("prompt.custom.set", { harness: "codex", text })).toMatchObject({
      custom: ["codex"],
    })
    const sessionID = await create("opus", "codex", "custom")
    const first = sent(await send("opus", sessionID, "hi custom one"))
    expect(first.texts[0]).toBe(`CUSTOM-CODEX: answer in Korean.\n\n# Editing files\n${CodexVariant.PATCH}`)
    own.parts.slice(1).forEach((part) => expect(first.texts.map(withoutDate)).toContain(part.text))
    const view = await preview("codex", "custom", "opus")
    expect(view.applied).toBe("custom")
    expectSame(view, await send("opus", sessionID, "hi custom two"))

    // 기본으로 되돌리기: the same session's next request carries 개선판 again.
    expect(await rpc<OwnHarness.List>("prompt.custom.set", { harness: "codex", text: null })).toMatchObject({
      custom: [],
    })
    const after = sent(await send("opus", sessionID, "hi custom three"))
    expect(after.texts[0]).toBe(CodexVariant.LEAN)
    expect((await preview("codex", "custom", "opus")).applied).toBe("own")
    // The session still names 내 지시문; it runs 개선판 until a text is saved again.
    expect(OwnHarness.promptOf((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>)).toBe(
      "custom",
    )
  }, 120_000)

  test("dsh: the saved text replaces the persona line only, with {{model}} filled in", async () => {
    await rpc("prompt.custom.set", { harness: "dsh", text: "CUSTOM-DSH: you fix bugs carefully on {{model}}." })
    try {
      const sessionID = await create("deepseek", "dsh", "custom")
      const request = sent(await send("deepseek", sessionID, "hi custom dsh"))
      expect(request.texts[0]).toStartWith(
        `${DshPrompt.IDENTITY}\n\nCUSTOM-DSH: you fix bugs carefully on deepseek-v4-pro.\n\n`,
      )
      expect(request.texts[0]).not.toContain("You are a coding agent powered by")
      expectSame(await preview("dsh", "custom", "deepseek"), await send("deepseek", sessionID, "hi custom dsh again"))
    } finally {
      await rpc("prompt.custom.set", { harness: "dsh", text: null })
    }
  }, 120_000)

  test("pi: the saved text replaces Pi's opening paragraph only; the default can be 내 지시문", async () => {
    const text = "CUSTOM-PI: you are a careful coding assistant."
    await rpc("prompt.custom.set", { harness: "pi", text })
    await rpc("defaults.set", { harness: "pi", prompt: "custom" })
    try {
      // A session that names nothing gets the stored default.
      const sessionID = await create("gpt", "pi")
      expect(OwnHarness.promptOf((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>)).toBe(
        "custom",
      )
      const request = sent(await send("gpt", sessionID, "hi custom pi"))
      expect(request.texts[0]!.startsWith(`${text}\n\n<tools>\n`)).toBe(true)
      expect(request.texts[0]).not.toContain(PiPrompt.PREAMBLE)
      expectSame(await preview("pi", "custom", "gpt"), await send("gpt", sessionID, "hi custom pi again"))
    } finally {
      await rpc("defaults.set", { harness: "codex", prompt: "own" })
      await rpc("prompt.custom.set", { harness: "pi", text: null })
    }
  }, 120_000)
})
