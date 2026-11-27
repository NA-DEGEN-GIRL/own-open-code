// own's image tool on a real server (02 §9.6, decisions IM). A fake ChatGPT backend is both the conversation's model
// (ChatGPT 01, scripted) and Codex's image generation; a fake OpenAI Images API answers the user's two API keys, kept in
// own's (memory) vault. The scripted model:
// 1. loads the `imagegen` skill, edits `in.png` with Sunburst and makes a plain image with Flare saved into the
//    project: key 1 answers `insufficient_quota` and is marked, key 2 makes both, each priced in the ledger;
//    The session is in 묻기 (`ask`): the project save is asked like an edit, the image itself is not (the user's
//    decision of 2026-11-08, IM-27: an image is allowed in every mode without asking);
// 2. makes an animated GIF and an SVG with key 2 (IM-23): the next chat request shows the model the GIF's first frame
//    only and no SVG image at all; the fake Images API refuses a GIF sheet that cannot fit and an SVG without
//    `svg.model`, as OpenAI does (./openai-rules.ts, IM-31, IM-33);
// 3. once both keys are out of money, makes one more image: the Codex fallback takes the subscription with the most
//    remaining limit (03 before 01) with the backend's own model.
// No key or token appears in a tool result, a chat request, the event stream or OWN_HOME's files. The servers bind
// 127.0.0.1; every key and token is fake.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { OwnImage } from "@own/protocol"
import {
  afterToolResult,
  startFakeCodex,
  startPresetRig,
  toolOutputs,
  toolParts,
  waitUntil,
  type FakeCodex,
  type PresetRig,
  type RecordedRequest,
  type Reply,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"
import { refusal } from "./openai-rules.js"

setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 180_000

/** A 1×1 two-frame looping GIF and a small SVG, as the fake Images API answers `output_format` gif and svg. */
const GIF = Buffer.from(
  "47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c00000000010001000002024401" +
    "0021f904000a0000002c00000000010001000002024c01003b",
  "hex",
)
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>')
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082",
  "hex",
)
const ONE = { accountID: "acct-image-01", email: "one@example.test", plan: "plus" }
const THREE = { accountID: "acct-image-03", email: "three@example.test", plan: "plus" }
const MAIN = { providerID: "own-codex-pg01", id: "gpt-6-sol", variant: "high" }
const KEY1 = "sk-fake-image-key-one-0001"
const KEY2 = "sk-fake-image-key-two-0002"
const USAGE = { input_tokens: 40, output_tokens: 1056, input_tokens_details: { text_tokens: 40, image_tokens: 0 } }
const EDIT_USAGE = { input_tokens: 360, output_tokens: 1056, input_tokens_details: { text_tokens: 40, image_tokens: 320 } }

const images: {
  calls: Array<{ key: string; path: string; model?: string; format?: string }>
  broke: Set<string>
  server?: ReturnType<typeof Bun.serve>
} = { calls: [], broke: new Set([KEY1]) }
const fixture: { codex?: FakeCodex; rig?: PresetRig } = {}

beforeAll(async () => {
  images.server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      if (key !== KEY1 && key !== KEY2)
        return Response.json({ error: { type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 })
      if (request.method === "GET" && url.pathname === "/v1/models")
        return Response.json({ object: "list", data: [] }, { headers: { "openai-organization": `org-${key.slice(-4)}` } })
      const edit = url.pathname === "/v1/images/edits"
      const body = edit
        ? Object.fromEntries((await request.formData()).entries())
        : ((await request.json()) as Record<string, unknown>)
      const model = typeof body.model === "string" ? body.model : undefined
      const format = typeof body.output_format === "string" ? body.output_format : undefined
      images.calls.push({ key, path: url.pathname, ...(model ? { model } : {}), ...(format ? { format } : {}) })
      if (images.broke.has(key))
        return Response.json(
          { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } },
          { status: 429 },
        )
      const refused = refusal(body)
      if (refused) return refused
      const bytes = format === "gif" ? GIF : format === "svg" ? SVG : PNG
      return Response.json({
        created: 1,
        data: [{ b64_json: bytes.toString("base64") }],
        output_format: format ?? "png",
        usage: edit ? EDIT_USAGE : USAGE,
        ...(format === "svg" ? { svg_usage: { model: "gpt-5.5", input_tokens: 900, output_tokens: 400 } } : {}),
      })
    },
  })
  const codex = startFakeCodex({ responder: reply, images: PNG.toString("base64") })
  fixture.codex = codex
  const one = codex.login(ONE)
  const three = codex.login(THREE)
  codex.setUsage(ONE.accountID, { primary: 70 })
  codex.setUsage(THREE.accountID, { primary: 20 })
  fixture.rig = await startPresetRig({
    name: "image-flow",
    codex,
    chatgpt: [
      { id: "01", tokens: one },
      { id: "03", tokens: three },
    ],
    endpoints: { openai: `${images.server.url.origin}/v1` },
    models: [MAIN],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await fixture.codex?.stop()
  await images.server?.stop(true)
}, 60_000)

/**
 * The scripted model: a prompt's first request starts its script, and every request after a tool result takes the
 * next step. Codex slots send a turn's later requests incrementally (only the new items), so a step cannot read the
 * prompt again; requests without tools (the title) are left to the fake's default.
 */
const script: { steps: Reply[]; next: number } = { steps: [], next: 0 }

function reply(request: RecordedRequest): Reply | undefined {
  const json = request.json as { tools?: unknown[] } | undefined
  if (!Array.isArray(json?.tools) || json.tools.length === 0) return undefined
  const text = JSON.stringify(json)
  if (!afterToolResult(request) && text.includes("[imagegen]"))
    Object.assign(script, {
      next: 0,
      steps: [
        { type: "tool-call", name: "skill", input: { id: "imagegen" } },
        {
          type: "tool-call",
          name: "image_generate",
          input: {
            prompt: "Use case: precise-object-edit. Primary request: make the cube blue. Constraints: change only the color",
            model: OwnImage.SUNBURST,
            images: ["in.png"],
          },
        },
        {
          type: "tool-call",
          name: "image_generate",
          input: { prompt: "Use case: stylized-concept. Primary request: a red cube", model: OwnImage.FLARE, path: "art/plain.png" },
        },
        { type: "text", text: "이미지를 만들었어요." },
      ],
    })
  if (!afterToolResult(request) && text.includes("[formats]"))
    Object.assign(script, {
      next: 0,
      steps: [
        {
          type: "tool-call",
          name: "image_generate",
          input: { prompt: "a cube spinning once", output_format: "gif", frame_count: 4, frame_duration_ms: 100 },
        },
        { type: "tool-call", name: "image_generate", input: { prompt: "a flat circle icon", output_format: "svg" } },
        { type: "text", text: "GIF와 SVG를 만들었어요." },
      ],
    })
  if (!afterToolResult(request) && text.includes("[fallback]"))
    Object.assign(script, {
      next: 0,
      steps: [
        { type: "tool-call", name: "image_generate", input: { prompt: "a green cube", model: OwnImage.FLARE } },
        { type: "text", text: "구독으로 만들었어요." },
      ],
    })
  return script.steps[script.next++] ?? { type: "text", text: "ok" }
}

describe("own's image tool end to end (02 §9.6)", () => {
  test(
    "the skill, a Sunburst edit and a Flare image through the key chain, priced in the ledger",
    async () => {
      const rig = required(fixture.rig)
      await rig.call("accounts.add.key", { kind: "oai", label: "OpenAI 1", key: KEY1 })
      await rig.call("accounts.add.key", { kind: "oai", label: "OpenAI 2", key: KEY2 })
      await rig.call("policy.set", { patch: { imageGenerate: true } })
      const skills = await rig.call("skillset.view", {})
      expect(JSON.stringify(skills)).toContain("/builtin/own/imagegen.md")
      await Bun.write(path.join(rig.server.paths.workspace, "in.png"), PNG)

      const session = await rig.server.createSession({ model: MAIN, title: "images" })
      expect(await rig.call("session.approval.set", { sessionID: session.id, mode: "ask" })).toMatchObject({ mode: "ask" })
      const stop = approve(rig, session.id)
      await rig.server.prompt(session.id, "[imagegen] 큐브를 파랗게 바꾸고, 빨간 큐브도 하나 만들어 주세요.")
      await rig.server.waitIdle(session.id)
      stop()
      // 묻기: the project file was asked like an edit; neither image was (IM-27).
      const asked = rig.events.events.filter(
        (event) => event.type === "permission.asked" && event.data.sessionID === session.id,
      )
      expect(asked.map((event) => [event.data.action, event.data.resources])).toEqual([["edit", ["art/plain.png"]]])

      // What the turn did instead, when no image request came.
      if (images.calls.length === 0)
        throw new Error(
          `no image request: ${JSON.stringify((await rig.server.messages(session.id)).map((message) => (message as { content?: unknown }).content)).slice(0, 4000)}`,
        )
      // Key 1 had no money: asked once, marked, then left out; key 2 made both with the models the model chose.
      expect(images.calls).toEqual([
        { key: KEY1, path: "/v1/images/edits", model: OwnImage.SUNBURST },
        { key: KEY2, path: "/v1/images/edits", model: OwnImage.SUNBURST },
        { key: KEY2, path: "/v1/images/generations", model: OwnImage.FLARE },
      ])
      const parts = await toolParts(rig.server, session.id, "image_generate")
      const cards = parts.map((part) => (isRecord(part.state.metadata) ? part.state.metadata[OwnImage.CARD_KEY] : undefined))
      expect(cards).toMatchObject([
        { status: "done", model: OwnImage.SUNBURST, route: "key", account: "OpenAI 2", costUSD: OwnImage.cost(OwnImage.SUNBURST, EDIT_USAGE) },
        { status: "done", model: OwnImage.FLARE, route: "key", account: "OpenAI 2", costUSD: OwnImage.cost(OwnImage.FLARE, USAGE) },
      ])
      expect((cards[0] as OwnImage.CardData).steps.map((step) => [step.label, step.outcome])).toEqual([
        ["OpenAI 1", "failed"],
        ["OpenAI 2", "used"],
      ])
      expect((cards[1] as OwnImage.CardData).steps[0]).toMatchObject({ label: "OpenAI 1", outcome: "skipped" })
      expect(await Bun.file(path.join(rig.server.paths.workspace, "art", "plain.png")).exists()).toBe(true)
      const skill = await toolParts(rig.server, session.id, "skill")
      expect(JSON.stringify(skill[0]?.state)).toContain("Choosing the model")

      const view = await rig.call("image.get", {})
      const keys = view.keys as Array<{ label: string; exhausted?: { code: string } }>
      expect(keys.map((key) => [key.label, key.exhausted?.code])).toEqual([
        ["OpenAI 1", "insufficient_quota"],
        ["OpenAI 2", undefined],
      ])
      const lines = await ledger(rig.home)
      expect(lines.map((line) => [line.modelID, line.cost?.amount])).toEqual([
        [OwnImage.SUNBURST, OwnImage.cost(OwnImage.SUNBURST, EDIT_USAGE)],
        [OwnImage.FLARE, OwnImage.cost(OwnImage.FLARE, USAGE)],
      ])
    },
    TURN_TIMEOUT,
  )

  test(
    "an animated GIF and an SVG (IM-23): saved by their bytes, the model shown the GIF's first frame and no SVG image",
    async () => {
      const rig = required(fixture.rig)
      const codex = required(fixture.codex)
      const session = await rig.server.createSession({ model: MAIN, title: "formats" })
      const before = codex.requests.length
      const stop = approve(rig, session.id)
      await rig.server.prompt(session.id, "[formats] 도는 큐브 GIF와 원 아이콘 SVG를 만들어 주세요.")
      await rig.server.waitIdle(session.id)
      stop()
      expect(images.calls.slice(-2)).toEqual([
        { key: KEY2, path: "/v1/images/generations", model: OwnImage.FLARE, format: "gif" },
        { key: KEY2, path: "/v1/images/generations", model: OwnImage.FLARE, format: "svg" },
      ])
      const parts = await toolParts(rig.server, session.id, "image_generate")
      const cards = parts.map((part) => (isRecord(part.state.metadata) ? part.state.metadata[OwnImage.CARD_KEY] : undefined))
      expect(cards).toMatchObject([
        { status: "done", format: "gif", frames: 2, preview: `data:image/gif;base64,${GIF.toString("base64")}` },
        { status: "done", format: "svg", svgAuthor: { model: "gpt-5.5", input: 900, output: 400 } },
      ])
      const [gif, svg] = cards as OwnImage.CardData[]
      expect(await Bun.file(gif!.path!).bytes()).toEqual(new Uint8Array(GIF))
      expect(svg!.path).toEndWith(".svg")
      expect(await Bun.file(svg!.path!).text()).toBe(SVG.toString())
      // What reached the model: the GIF's first frame as an image, never the whole loop, and no SVG image.
      const sent = JSON.stringify(codex.requests.slice(before).map((request) => request.json))
      expect(sent).toContain("image/gif")
      expect(sent).not.toContain(GIF.toString("base64"))
      expect(sent).not.toContain("image/svg+xml")
      expect(sent).toContain("read the file if you need its source")
    },
    TURN_TIMEOUT,
  )

  test(
    "every key out of money: the subscription with the most remaining limit makes it with Codex's model",
    async () => {
      const rig = required(fixture.rig)
      const codex = required(fixture.codex)
      images.broke.add(KEY2)
      // Both subscriptions' limits are known (the request headers of ChatGPT 01, the poll of 03).
      await waitUntil(
        async () => {
          const view = await rig.call("image.get", {})
          const rows = view.codex as Array<{ usedPercent?: number }>
          return rows.length === 2 && rows.every((row) => row.usedPercent !== undefined)
        },
        "the subscriptions' limits were never known",
        150_000,
      )
      const session = await rig.server.createSession({ model: MAIN, title: "fallback" })
      const stop = approve(rig, session.id)
      await rig.server.prompt(session.id, "[fallback] 초록 큐브를 만들어 주세요.")
      await rig.server.waitIdle(session.id)
      stop()
      expect(codex.imageCalls.map((call) => [call.accountID, call.path])).toEqual([
        [THREE.accountID, "/backend-api/codex/images/generations"],
      ])
      expect(codex.imageCalls[0]?.body).toMatchObject({ model: OwnImage.GPT_IMAGE_2, prompt: "a green cube" })
      const parts = await toolParts(rig.server, session.id, "image_generate")
      const card = (isRecord(parts[0]?.state.metadata) ? parts[0].state.metadata[OwnImage.CARD_KEY] : undefined) as OwnImage.CardData
      expect(card).toMatchObject({ status: "done", route: "codex", model: OwnImage.GPT_IMAGE_2, account: "ChatGPT 03" })
      expect(card.steps.map((step) => [step.label, step.outcome])).toEqual([
        ["OpenAI 1", "skipped"],
        ["OpenAI 2", "failed"],
        ["ChatGPT 03", "used"],
      ])
      const last = (await ledger(rig.home)).at(-1)
      expect(last).toMatchObject({ kind: "image", modelID: OwnImage.GPT_IMAGE_2, cost: null })
    },
    TURN_TIMEOUT + 150_000,
  )

  test("no key or token in a tool result, a chat request, the event stream or OWN_HOME's files", async () => {
    const rig = required(fixture.rig)
    const codex = required(fixture.codex)
    const secrets = [KEY1, KEY2]
    const outputs = codex.requests.flatMap((request) => toolOutputs(request)).join("\n")
    const files = await everyFile(rig.home)
    for (const secret of secrets) {
      expect(outputs).not.toContain(secret)
      expect(JSON.stringify(codex.requests.map((request) => request.json))).not.toContain(secret)
      expect(rig.events.text()).not.toContain(secret)
      expect(files.filter((file) => file.text.includes(secret)).map((file) => file.path)).toEqual([])
    }
  })
})

/** Answers every approval the session asks while the turn runs (`once`). */
function approve(rig: PresetRig, sessionID: string) {
  const answered = new Set<unknown>()
  const timer = setInterval(() => {
    for (const event of rig.events.events) {
      if (event.type !== "permission.asked" || event.data.sessionID !== sessionID || answered.has(event)) continue
      answered.add(event)
      void rig.server
        .call("POST", `/api/session/${sessionID}/permission/${String(event.data.id)}/reply`, { body: { decision: "once" } })
        .catch(() => undefined)
    }
  }, 100)
  return () => clearInterval(timer)
}

async function ledger(home: string) {
  const dir = path.join(home, "ledger")
  const names = (await fs.readdir(dir)).filter((name) => name.startsWith("usage-"))
  const text = (await Promise.all(names.map((name) => Bun.file(path.join(dir, name)).text()))).join("\n")
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { kind: string; modelID: string; cost: { amount: number } | null })
    .filter((line) => line.kind === "image")
}

async function everyFile(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const file = path.join(entry.parentPath, entry.name)
        return { path: file, text: await Bun.file(file).text().catch(() => "") }
      }),
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
