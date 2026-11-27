// Live check of own's image tool through a real OpenAI API key (02 §9.6, decisions IM-21..IM-28, IM-31..IM-36): a
// plain PNG, an animated GIF (its frames lowered to 960x960 to fit OpenAI's sheet), an SVG (with its author model) and a
// markup-guided edit with GPT Image 2.6 Flare at low quality and 1024x1024, through own's `image_generate` on a real
// server.
//
// A source server runs own-accounts (own-accounts' e2e kit, a fresh temp root) with one OpenAI API key account whose key
// is a placeholder. Its Images API endpoint is a local proxy here. First a dry pass: the proxy answers every call itself
// (fake images) and keeps each request body, and those bodies are checked for personal data (an e-mail, the Windows user
// name, a home path) before anything goes out. Then the live pass: the proxy sends each call to the live forwarder's
// `/openai/v1/...` route, which puts in the key the user stored with `set-key.ps1 -Provider openai` (DPAPI) and
// forwards to api.openai.com. The conversation's model is a local fake that calls `image_generate` once per prompt.
// Each call's USD comes from the answer's `usage` (OwnImage.cost; an SVG's authoring tokens are logged apart), and a call
// whose estimate passes $0.50 is not sent: the proxy refuses it and the run stops there.
//
//   bun script/live/image-api.ts --out C:/t/if2/live [--dry] [--keep] [--only png,gif,svg,markup]
//
// Without the stored key the dry pass still runs and the live pass is skipped with the command to store the key.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { OwnImage } from "@own/protocol"
import { ImageFormat } from "../../../own-accounts/src/image/format.js"
import {
  openAIResponsesProvider,
  startFakeCodex,
  startFakeOpenAIResponses,
  startPresetRig,
  toolParts,
  type RecordedRequest,
  type Reply,
} from "../../../own-accounts/test/e2e-kit"
import { refusal } from "../../../own-accounts/test/image/openai-rules.js"
import { hasOpenai, OPENAI_KEY_PATH } from "./credentials.js"

const args = process.argv.slice(2)
const out = path.resolve(args[args.indexOf("--out") + 1] ?? "C:/t/if2/live")
const dry = args.includes("--dry")
const keep = args.includes("--keep")
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : undefined
fs.mkdirSync(out, { recursive: true })
const bodies = path.join(out, "bodies")
fs.mkdirSync(bodies, { recursive: true })
process.env.OWN_LIVE_BODIES = bodies
const { startForwarder } = await import("./forwarder.js")

/** One call may cost at most this much (the user's cap); a call estimated above it is not sent. */
const CALL_CAP_USD = 0.5
const CHAT = { providerID: "fake-chat", id: "gpt-fake" }
const STEPS = ["png", "gif", "svg", "markup"] as const
type Step = (typeof STEPS)[number]
const INPUTS: Readonly<Record<Step, Record<string, unknown>>> = {
  png: { prompt: "A small flat icon of a red cube on a plain white background.", model: OwnImage.FLARE, path: "live/cube.png" },
  gif: {
    prompt:
      "A small flat red cube on a plain white background turns a quarter turn and back. Same camera in every frame; the last frame returns to the first pose.",
    model: OwnImage.FLARE,
    output_format: "gif",
    frame_count: 3,
    frame_duration_ms: 200,
  },
  svg: {
    prompt: "A simple flat icon of a red cube: two shades of red, bold even strokes, no background, no text.",
    model: OwnImage.FLARE,
    output_format: "svg",
  },
  markup: {
    prompt:
      "Recolor the cube inside the red circle to solid blue. Keep its shape and the background unchanged. Remove the red circle from the result.",
    model: OwnImage.FLARE,
    images: ["live/cube.png"],
    markup: "live/markup.png",
    complexity: "low",
  },
}

const note = (entry: Record<string, unknown>) => {
  const line = { at: new Date().toISOString(), ...entry }
  fs.appendFileSync(path.join(out, "run.jsonl"), `${JSON.stringify(line)}\n`)
  console.log(JSON.stringify(line))
}

const forwarder = startForwarder(path.join(out, "forwarder.jsonl"))
const state: { mode: "dry" | "live"; costs: number[]; stopped?: string; recorded: Array<{ path: string; text: string }> } = {
  mode: "dry",
  costs: [],
  recorded: [],
}

// The Images API as own-accounts sees it: answered here in the dry pass, forwarded in the live pass.
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/v1/models")
      return Response.json({ object: "list", data: [{ id: OwnImage.FLARE, object: "model" }] })
    if (request.method !== "POST" || !/^\/v1\/images\/(generations|edits)$/.test(url.pathname))
      return new Response("not served", { status: 404 })
    const raw = await request.arrayBuffer()
    const type = request.headers.get("content-type") ?? ""
    const fields = await readable(raw, type)
    state.recorded.push({ path: url.pathname, text: fields.text })
    const format = String(fields.values.output_format ?? "png")
    // The dry pass refuses what OpenAI refuses (a GIF sheet that cannot fit, an SVG without `svg.model`; IM-31, IM-33).
    if (state.mode === "dry") return refusal(fields.values) ?? Response.json(fake(format))
    const estimate = estimateUSD(fields.values, url.pathname)
    if (estimate > CALL_CAP_USD) {
      state.stopped = `estimated $${estimate.toFixed(3)} > $${CALL_CAP_USD}`
      note({ step: "budget", refused: url.pathname, format, estimate })
      return Response.json({ error: { type: "budget", code: "live_budget", message: "live test cap" } }, { status: 400 })
    }
    const upstream = await fetch(`${forwarder.url}/openai${url.pathname}`, {
      method: "POST",
      headers: { "content-type": type, authorization: "Bearer placeholder" },
      body: raw,
    })
    const text = await upstream.text()
    const json = (() => {
      try {
        return JSON.parse(text) as { usage?: OwnImage.Usage; svg_usage?: Record<string, unknown>; error?: unknown }
      } catch {
        return undefined
      }
    })()
    const author = svgAuthor(json?.svg_usage)
    const image = json?.usage ? OwnImage.cost(String(fields.values.model), json.usage) : undefined
    const usd = image === undefined ? undefined : image + (author ? (OwnImage.authorCost(author) ?? 0) : 0)
    if (usd !== undefined) state.costs.push(usd)
    note({
      step: "openai",
      path: url.pathname,
      format,
      status: upstream.status,
      usd,
      usage: json?.usage,
      svgUsage: json?.svg_usage,
      ...(author ? { svgAuthorUSD: OwnImage.authorCost(author) ?? "unpriced" } : {}),
      sent: { size: fields.values.size, frame_count: fields.values.frame_count, svg: fields.values.svg },
      ...(upstream.ok ? {} : { error: json?.error ?? text.slice(0, 400) }),
    })
    if (usd !== undefined && usd > CALL_CAP_USD) state.stopped = `a call cost $${usd.toFixed(3)}`
    return new Response(text, { status: upstream.status, headers: { "content-type": "application/json" } })
  },
})

function svgAuthor(usage: Record<string, unknown> | undefined): OwnImage.SvgUsage | undefined {
  if (!usage) return undefined
  const count = (value: unknown) => (typeof value === "number" ? value : undefined)
  const total = count(usage.total_tokens)
  return {
    model: String(usage.model ?? ""),
    input: count(usage.input_tokens) ?? 0,
    output: count(usage.output_tokens) ?? 0,
    ...(total === undefined ? {} : { total }),
  }
}

/** The last measured PNG's cost scaled for what is asked: GIF frames, an SVG's authoring, an edit's input image. */
function estimateUSD(values: Record<string, unknown>, endpoint: string) {
  const base = state.costs[0] ?? 0.05
  const frames = values.output_format === "gif" ? Number(values.frame_count ?? OwnImage.GIF_FRAMES.default) : 1
  const svg = values.output_format === "svg" ? 0.1 : 0
  const edit = endpoint.endsWith("/edits") ? 0.05 : 0
  return base * frames * 2 + svg + edit
}

async function readable(raw: ArrayBuffer, type: string) {
  if (type.includes("json")) {
    const text = new TextDecoder().decode(raw)
    return { text, values: JSON.parse(text) as Record<string, unknown> }
  }
  const form = await new Response(raw, { headers: { "content-type": type } }).formData()
  const values: Record<string, unknown> = {}
  const listed: string[] = []
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") values[name] = value
    else listed.push(`${name}=${(value as File).name} (${(value as File).type}, ${(value as File).size} B)`)
  }
  return { text: JSON.stringify({ ...values, files: listed }), values }
}

function fake(format: string) {
  const bytes = format === "svg" ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') : png(1024, 1024, false)
  return {
    created: 1,
    data: [{ b64_json: bytes.toString("base64") }],
    output_format: format === "svg" ? "svg" : "png",
    usage: { input_tokens: 10, output_tokens: 10, input_tokens_details: { text_tokens: 10, image_tokens: 0 } },
  }
}

/** A PNG: white RGB, or with `ring` a transparent RGBA layer with a red ring around the middle. */
function png(width: number, height: number, ring: boolean) {
  const channels = ring ? 4 : 3
  const rows = Buffer.alloc(height * (1 + width * channels), ring ? 0 : 255)
  const radius = Math.min(width, height) * 0.3
  if (ring)
    for (let y = 0; y < height; y++) {
      rows[y * (1 + width * channels)] = 0
      for (let x = 0; x < width; x++) {
        const distance = Math.hypot(x - width / 2, y - height / 2)
        if (Math.abs(distance - radius) > Math.max(4, width / 128)) continue
        rows.set([230, 20, 20, 255], y * (1 + width * channels) + 1 + x * channels)
      }
    }
  else for (let y = 0; y < height; y++) rows[y * (1 + width * channels)] = 0
  const chunk = (kind: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data])
    const result = Buffer.alloc(12 + data.length)
    result.writeUInt32BE(data.length, 0)
    body.copy(result, 4)
    result.writeUInt32BE(Bun.hash.crc32(body) >>> 0, 8 + data.length)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = ring ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ])
}

const codex = startFakeCodex()
const chat = startFakeOpenAIResponses({ models: [CHAT.id], responder: reply })

function reply(request: RecordedRequest): Reply {
  const json = request.json as { tools?: unknown[]; input?: unknown[] } | undefined
  if (!Array.isArray(json?.tools) || json.tools.length === 0) return { type: "text", text: "이미지" }
  const items = Array.isArray(json.input) ? json.input : []
  const last = items.at(-1) as { type?: string } | undefined
  if (last?.type === "function_call_output") return { type: "text", text: "만들었어요." }
  const text = JSON.stringify(items.findLast((item) => (item as { role?: string }).role === "user") ?? {})
  const step = STEPS.find((name) => text.includes(`[${name}]`))
  return step ? { type: "tool-call", name: "image_generate", input: INPUTS[step] } : { type: "text", text: "?" }
}

const started = Date.now()
const rig = await startPresetRig({
  name: "live-image-api",
  codex,
  chatgpt: [],
  endpoints: { openai: `${proxy.url.origin}/v1` },
  config: { providers: { [CHAT.providerID]: openAIResponsesProvider(chat, { apiKey: "fake-chat-key", models: [CHAT.id] }) } },
  models: [CHAT],
}).catch(async (error: unknown) => {
  await Promise.all([forwarder.stop(), proxy.stop(true), codex.stop(), chat.stop()])
  throw error
})

async function pass(mode: "dry" | "live") {
  state.mode = mode
  const session = await rig.server.createSession({ model: CHAT, title: `image ${mode}` })
  await rig.call("session.approval.set", { sessionID: session.id, mode: "full" })
  const results: Array<Record<string, unknown>> = []
  for (const step of STEPS.filter((name) => only === undefined || only.includes(name))) {
    if (state.stopped) {
      note({ step: "skipped", mode, image: step, why: state.stopped })
      continue
    }
    if (step === "markup") {
      // The layer the size of the PNG made first: transparent, a red ring around the middle.
      const base = path.join(rig.server.paths.workspace, "live", "cube.png")
      const size = fs.existsSync(base) ? ImageFormat.dimensions(new Uint8Array(fs.readFileSync(base))) : undefined
      if (!size) {
        note({ step: "skipped", mode, image: step, why: "no live/cube.png to mark" })
        continue
      }
      fs.writeFileSync(path.join(rig.server.paths.workspace, "live", "markup.png"), png(size.width, size.height, true))
    }
    const begin = Date.now()
    await rig.server.prompt(session.id, `[${step}] 이미지를 만들어 주세요.`)
    await rig.server.waitIdle(session.id)
    const parts = await toolParts(rig.server, session.id, "image_generate")
    const part = parts.at(-1)?.state as { status?: string; metadata?: Record<string, unknown>; error?: unknown } | undefined
    const card = part?.metadata?.[OwnImage.CARD_KEY] as OwnImage.CardData | undefined
    const saved = card?.path && fs.existsSync(card.path) ? fs.readFileSync(card.path) : undefined
    if (mode === "live" && card?.path && saved) fs.copyFileSync(card.path, path.join(out, path.basename(card.path)))
    const result = {
      step: "image",
      mode,
      image: step,
      ms: Date.now() - begin,
      status: part?.status,
      error: part?.error,
      model: card?.model,
      format: card?.format,
      asked: card?.asked,
      frames: card?.frames,
      costUSD: card?.costUSD,
      svgAuthor: card?.svgAuthor,
      resized: card?.resized,
      savedBytes: saved?.length,
      sniffed: saved ? ImageFormat.sniff(new Uint8Array(saved)) : undefined,
      size: saved ? ImageFormat.dimensions(new Uint8Array(saved)) : undefined,
    }
    results.push(result)
    note(result)
  }
  return results
}

try {
  note({ step: "server", ms: Date.now() - started, home: rig.home })
  await rig.call("accounts.add.key", { kind: "oai", label: "OpenAI live", key: "sk-placeholder-live-image-0000" })
  await rig.call("policy.set", {
    patch: { imageGenerate: true, image: { quality: "low", size: "1024x1024", codexFallback: false } },
  })
  await pass("dry")
  // Before anything goes out: what own sent, checked for this PC's identity.
  const user = os.userInfo()
  const needles = [user.username, path.basename(user.homedir), user.homedir, "C:\\\\Users", "C:/Users", "/Users/"].filter(
    (item) => item.length >= 4,
  )
  const personal = state.recorded.flatMap((body) => [
    ...(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(body.text) ? [`${body.path}: an e-mail`] : []),
    ...needles.filter((needle) => body.text.toLowerCase().includes(needle.toLowerCase())).map(() => `${body.path}: the user name or a home path`),
  ])
  note({ step: "dry-bodies", count: state.recorded.length, keys: state.recorded.map((body) => Object.keys(JSON.parse(body.text)).sort()), personal })
  fs.writeFileSync(path.join(out, "dry-bodies.json"), JSON.stringify(state.recorded.map((body) => ({ path: body.path, body: JSON.parse(body.text) })), null, 2))
  if (personal.length > 0) throw new Error(`a request body held personal data: ${personal.join("; ")}`)
  if (dry) note({ step: "live", skipped: "--dry" })
  else if (!hasOpenai())
    note({
      step: "live",
      skipped: `no OpenAI key at ${OPENAI_KEY_PATH}`,
      store: "powershell -NoProfile -ExecutionPolicy Bypass -File packages/own-harness/script/live/set-key.ps1 -Provider openai",
    })
  else {
    state.recorded = []
    await pass("live")
    note({ step: "total", usd: state.costs.reduce((sum, usd) => sum + usd, 0), calls: state.costs.length })
  }
} finally {
  if (!keep) await rig.stop()
  await Promise.all([forwarder.stop(), proxy.stop(true), codex.stop(), chat.stop()])
  note({ step: "done", ms: Date.now() - started })
}
