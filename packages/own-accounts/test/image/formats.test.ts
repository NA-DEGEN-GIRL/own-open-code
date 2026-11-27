// GPT Image 2.6's formats and markup edits in own's image tool (02 §9.6, decisions IM-21..IM-24, IM-31..IM-34) against a fake OpenAI
// Images endpoint and a fake Codex backend on 127.0.0.1: the bytes decide the file's extension, the file part and the
// card; an animated GIF reaches the model as its first frame and the card as the loop; an SVG never reaches the model as
// an image; a markup layer goes as its own multipart file after its checks; a subscription is never asked for anything
// but a plain PNG, and never answers a GIF request with a PNG. The fake refuses what the real API refuses (./openai-rules.ts):
// a GIF sheet that cannot fit, an SVG without `svg.model`. No real OpenAI call; every key and token is fake.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import { OwnImage, type Account } from "@own/protocol"
import { ImageFormat } from "../../src/image/format.js"
import { ImageService } from "../../src/image/service.js"
import { ImageTool } from "../../src/image/tool.js"
import type { Modules } from "../../src/modules.js"
import { PolicyRules } from "../../src/switching/policy.js"
import { testDeps } from "../support/deps.js"
import { refusal } from "./openai-rules.js"

/** A 1×1 two-frame looping GIF (red, then blue, 100 ms each). */
const GIF = Buffer.from(
  "47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c00000000010001000002024401" +
    "0021f904000a0000002c00000000010001000002024c01003b",
  "hex",
)
const SVG = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- made -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 21 23 12 2 3v7l15 2-15 2z"/></svg>',
)

/** A PNG of the given size: RGBA (alpha), RGB, or RGB with a `tRNS` chunk. */
function png(width: number, height: number, kind: "rgba" | "rgb" | "trns" = "rgba") {
  const channels = kind === "rgba" ? 4 : 3
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = kind === "rgba" ? 6 : 2
  const rows = Buffer.alloc(height * (1 + width * channels))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(kind === "trns" ? [chunk("tRNS", Buffer.from([0, 0, 0, 0, 0, 0]))] : []),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", new Uint8Array()),
  ])
}

/** A JPEG's markers up to its frame header (enough for its size). */
function jpeg(width: number, height: number) {
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), frame, Buffer.from([0xff, 0xd9])])
}

type Seen = { key: string; path: string; body: Record<string, unknown>; files: Record<string, { type: string; size: number }> }
type Script = (request: Seen) => Response

const server: { url: string; seen: Seen[]; script: Script; stop?: () => void } = {
  url: "",
  seen: [],
  script: () => Response.json({}, { status: 500 }),
}

beforeAll(() => {
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      const json = (request.headers.get("content-type") ?? "").includes("json")
      const form = json ? undefined : await request.formData()
      const body = json ? ((await request.json()) as Record<string, unknown>) : {}
      const files: Seen["files"] = {}
      for (const [name, value] of form?.entries() ?? []) {
        if (typeof value === "string") body[name] = value
        else files[name] = { type: (value as Blob).type, size: (value as Blob).size }
      }
      const seen = { key, path: url.pathname, body, files }
      server.seen.push(seen)
      // What the real API refuses (a GIF sheet that cannot fit, an SVG without its author) is refused here first.
      return refusal(body) ?? server.script(seen)
    },
  })
  server.url = fake.url.origin
  server.stop = () => void fake.stop(true)
})

afterAll(() => server.stop?.())

const answer = (bytes: Uint8Array, format: string, extra: Record<string, unknown> = {}) =>
  Response.json({
    created: 1,
    data: [{ b64_json: Buffer.from(bytes).toString("base64") }],
    output_format: format,
    usage: { input_tokens: 20, output_tokens: 1000, input_tokens_details: { text_tokens: 20, image_tokens: 0 } },
    ...extra,
  })

function account(id: string, kind: "oai" | "codex", label: string) {
  return { id, kind, label, providerID: `own-${kind}-${id.slice(-4).toLowerCase()}`, status: "ready" } as unknown as Account.Info
}

const KEY = account("acc_KEY1", "oai", "OpenAI 1")
const SUB = account("acc_SUB1", "codex", "ChatGPT 01")
const SECRETS: Record<string, string> = { acc_KEY1: "sk-fake-key-one", acc_SUB1: "fake-token-01" }

async function rig(accounts: Account.Info[], setting: OwnImage.Setting = {}) {
  const asks: Array<{ action: string; resources: ReadonlyArray<string> }> = []
  const values = new Map<string, unknown>()
  const t = await testDeps({
    ctx: {
      storage: { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => void values.set(key, value) },
      permission: { assert: async (input: { action: string; resources: ReadonlyArray<string> }) => void asks.push(input) },
    },
    options: { endpoints: { openai: `${server.url}/v1`, codex: `${server.url}/backend-api/codex` } },
  })
  await t.deps.runtime.policy.update((stored) => PolicyRules.apply(stored, { image: setting }))
  const modules = {
    slots: { snapshot: () => ({ accounts }) },
    logins: {
      headers: async (item: Account.Info) => ({
        ok: true,
        headers: { authorization: `Bearer ${SECRETS[item.id]}` },
        hash: "h",
        expiresAt: null,
        source: "vault",
      }),
      unauthorized: () => undefined,
    },
    telemetry: { recordImage: async () => undefined },
  } as unknown as Modules.All
  const service = ImageService.create(t.deps, modules, { wait: async () => undefined })
  const dir = t.deps.location.directory
  const call = (input: Record<string, unknown>) =>
    ImageTool.run(t.deps, service, { prompt: "x", ...input }, {
      sessionID: "ses_formats",
      agent: "build",
      messageID: "msg_1",
      id: "call_1",
      signal: new AbortController().signal,
      progress: async () => undefined,
    } as never)
  return { t, service, call, asks, dir, [Symbol.asyncDispose]: () => t[Symbol.asyncDispose]() }
}

type Content = ReadonlyArray<{ type: string; text?: string; uri?: string; mime?: string; name?: string }>
const card = (result: { metadata?: Record<string, unknown> }) => result.metadata?.[OwnImage.CARD_KEY] as OwnImage.CardData
const parts = (result: { content?: unknown }) => result.content as Content

describe("ImageFormat (IM-23)", () => {
  test("sniffs every format by its bytes, an SVG after an XML prolog and a comment", () => {
    expect(ImageFormat.sniff(png(2, 2))).toBe("png")
    expect(ImageFormat.sniff(jpeg(4, 3))).toBe("jpeg")
    expect(ImageFormat.sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp")
    expect(ImageFormat.sniff(GIF)).toBe("gif")
    expect(ImageFormat.sniff(SVG)).toBe("svg")
    expect(ImageFormat.sniff(Buffer.from("<html><svg></svg></html>"))).toBeUndefined()
    expect(ImageFormat.sniff(Buffer.from("not an image"))).toBeUndefined()
  })

  test("reads sizes and whether a PNG can be transparent", () => {
    expect(ImageFormat.dimensions(png(30, 20))).toEqual({ width: 30, height: 20 })
    expect(ImageFormat.dimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 })
    expect(ImageFormat.dimensions(GIF)).toEqual({ width: 1, height: 1 })
    const vp8x = Buffer.alloc(30)
    vp8x.write("RIFF", 0, "latin1")
    vp8x.write("WEBPVP8X", 8, "latin1")
    vp8x.writeUIntLE(1535, 24, 3)
    vp8x.writeUIntLE(1023, 27, 3)
    expect(ImageFormat.dimensions(vp8x)).toEqual({ width: 1536, height: 1024 })
    expect(ImageFormat.pngAlpha(png(2, 2, "rgba"))).toBe(true)
    expect(ImageFormat.pngAlpha(png(2, 2, "trns"))).toBe(true)
    expect(ImageFormat.pngAlpha(png(2, 2, "rgb"))).toBe(false)
  })

  test("an animated GIF: its frame count and its first frame as a still GIF without the loop", () => {
    const read = ImageFormat.gifFrames(GIF)!
    expect(read.frames).toBe(2)
    expect(ImageFormat.sniff(read.first)).toBe("gif")
    expect(ImageFormat.gifFrames(read.first)?.frames).toBe(1)
    expect(Buffer.from(read.first).includes(Buffer.from("NETSCAPE"))).toBe(false)
    expect(ImageFormat.gifFrames(GIF.subarray(0, GIF.length - 8))).toBeUndefined()
  })
})

describe("the tool's arguments follow the family (IM-21, IM-22)", () => {
  test("2.6 families offer gif and svg, the frames and markup; gpt-image-2 the raster three only", () => {
    const auto = ImageTool.inputSchema("auto").properties as unknown as Record<string, { enum?: ReadonlyArray<string> } | undefined>
    expect(auto.output_format?.enum).toEqual(["png", "jpeg", "webp", "gif", "svg"])
    expect(auto.frame_count).toBeDefined()
    expect(auto.markup).toBeDefined()
    const fixed = ImageTool.inputSchema("gpt-image-2").properties as unknown as Record<string, { enum?: ReadonlyArray<string> } | undefined>
    expect(fixed.output_format?.enum).toEqual(["png", "jpeg", "webp"])
    expect(fixed.frame_count).toBeUndefined()
    expect(fixed.markup).toBeUndefined()
    expect(ImageTool.description("gpt-image-2")).not.toContain("gif")
    expect(ImageTool.skillDescription("auto")).toContain("GIF")
    expect(ImageTool.skillDescription("gpt-image-2")).toContain("Not for SVG")
    expect(ImageTool.modelSection("flare")).toContain("### Markup edits")
    expect(ImageTool.modelSection("gpt-image-2")).toContain("need a GPT Image 2.6 model")
  })
})

describe("GIF and SVG through an API key (IM-21, IM-23)", () => {
  test("a GIF: the frames sent, the .gif saved, the model shown its first frame, the card the whole loop", async () => {
    server.seen = []
    server.script = () => answer(GIF, "gif")
    await using r = await rig([KEY])
    const result = await r.call({ output_format: "gif", frame_count: 8, frame_duration_ms: 120 })
    expect(server.seen.map((item) => [item.path, item.body.output_format, item.body.frame_count, item.body.frame_duration_ms])).toEqual([
      ["/v1/images/generations", "gif", 8, 120],
    ])
    const data = card(result)
    expect(data).toMatchObject({ status: "done", format: "gif", frames: 2 })
    expect(data.asked).toBeUndefined()
    expect(data.path).toEndWith(".gif")
    expect(await Bun.file(data.path!).bytes()).toEqual(new Uint8Array(GIF))
    expect(data.preview).toBe(`data:image/gif;base64,${GIF.toString("base64")}`)
    const file = parts(result).find((part) => part.type === "file")!
    expect(file.mime).toBe("image/gif")
    expect(file.uri).toBe(`data:image/gif;base64,${Buffer.from(ImageFormat.gifFrames(GIF)!.first).toString("base64")}`)
    expect(parts(result)[0]?.text).toContain("Animated GIF, 2 frames")
  })

  test("an SVG: the .svg saved, no file part for the model, the card's preview and the authoring tokens", async () => {
    server.seen = []
    server.script = () => answer(SVG, "svg", { svg_usage: { model: "gpt-5.5", input_tokens: 1200, output_tokens: 800 } })
    await using r = await rig([KEY])
    const result = await r.call({ output_format: "svg", model: OwnImage.SUNBURST })
    // OpenAI refuses an SVG without its author model (IM-33); the fake refuses it too.
    expect(server.seen[0]?.body).toMatchObject({ output_format: "svg", n: 1, model: OwnImage.SUNBURST, svg: { model: OwnImage.SVG_AUTHOR } })
    const data = card(result)
    expect(data).toMatchObject({ format: "svg", svgAuthor: { model: "gpt-5.5", input: 1200, output: 800 } })
    expect(data.path).toEndWith(".svg")
    expect(data.preview).toBe(`data:image/svg+xml;base64,${SVG.toString("base64")}`)
    // The reference image's usage only: 20 text in, 1,000 out.
    expect(data.costUSD).toBeCloseTo((20 * 5 + 1000 * 30) / 1_000_000, 8)
    expect(parts(result).some((part) => part.type === "file")).toBe(false)
    const text = parts(result)[0]?.text ?? ""
    expect(text).toContain("read the file if you need its source")
    expect(text).toContain("SVG authoring by gpt-5.5: 1200 input and 800 output tokens, billed at that model's rates and not in the cost above")
  })

  test("an SVG written by the default author: its tokens priced into the cost, reasoning as output (IM-34)", async () => {
    server.script = () =>
      answer(SVG, "svg", {
        svg_usage: { model: `${OwnImage.SVG_AUTHOR}-2026-09-22`, input_tokens: 2000, output_tokens: 3000, reasoning_tokens: 1000, total_tokens: 6000 },
      })
    await using r = await rig([KEY])
    const result = await r.call({ output_format: "svg" })
    const author = (2000 * 0.1 + 4000 * 0.5) / 1_000_000
    const data = card(result)
    expect(data.svgAuthor).toEqual({ model: `${OwnImage.SVG_AUTHOR}-2026-09-22`, input: 2000, output: 3000, reasoning: 1000, total: 6000, costUSD: author })
    expect(data.costUSD).toBeCloseTo((20 * 5 + 1000 * 30) / 1_000_000 + author, 8)
    expect(parts(result)[0]?.text).toContain(`($${author.toFixed(4)}, included in the cost above)`)
  })

  test("a GIF at a fixed size: the frame lowered to the largest of its shape that fits the frame count (IM-32)", async () => {
    server.seen = []
    server.script = () => answer(GIF, "gif")
    await using r = await rig([KEY], { size: "1024x1024" })
    const result = await r.call({ output_format: "gif", frame_count: 3 })
    await r.call({ output_format: "gif" })
    await r.call({ output_format: "gif", frame_count: 16, size: "1536x1024" })
    await r.call({ output_format: "gif", frame_count: 12, size: "1024x1536" })
    await r.call({ output_format: "gif", frame_count: 4, size: "auto" })
    expect(server.seen.map((item) => [item.body.size, item.body.frame_count])).toEqual([
      ["960x960", 3],
      ["960x960", undefined],
      ["864x576", 16],
      ["672x1008", 12],
      [undefined, 4],
    ])
    expect(card(result).resized).toEqual({ from: "1024x1024", to: "960x960" })
    expect(parts(result)[0]?.text).toContain("Frames are 960x960: 1024x1024 frames do not fit 3 frames on OpenAI's GIF sheet")
    // A PNG at the same setting keeps its size.
    server.script = () => answer(png(2, 2), "png")
    expect(card(await r.call({})).resized).toBeUndefined()
    expect(server.seen.at(-1)?.body.size).toBe("1024x1024")
  })

  test("the fake refuses what OpenAI refused live: a GIF whose sheet cannot fit, an SVG without svg.model", () => {
    expect(refusal({ output_format: "gif", size: "1024x1024", frame_count: 3 })?.status).toBe(400)
    expect(refusal({ output_format: "gif", size: "1024x1024", frame_count: 9 })?.status).toBe(400)
    expect(refusal({ output_format: "gif", size: "960x960", frame_count: 9 })).toBeUndefined()
    expect(refusal({ output_format: "gif", size: "auto" })).toBeUndefined()
    expect(refusal({ output_format: "svg" })?.status).toBe(400)
    expect(refusal({ output_format: "svg", svg: { model: OwnImage.SVG_AUTHOR } })).toBeUndefined()
  })

  test("another format than asked is said, never hidden: a PNG for a GIF request is saved as .png and named", async () => {
    server.seen = []
    server.script = () => answer(png(2, 2), "png")
    await using r = await rig([KEY])
    const result = await r.call({ output_format: "gif", path: "assets/wave.gif" })
    const data = card(result)
    expect(data).toMatchObject({ format: "png", asked: "gif" })
    expect(data.path).toBe(path.join(r.dir, "assets", "wave.png"))
    expect(parts(result)[0]?.text).toContain("Asked for gif but the image came back as png")
    // Both project files were asked like an edit: the one asked for, then the one it became.
    expect(r.asks.filter((ask) => ask.action === "edit").map((ask) => ask.resources[0])).toEqual(["assets/wave.gif", "assets/wave.png"])
  })

  test("path takes the asked format's extension: logo.png with svg is asked and saved as logo.svg", async () => {
    server.script = () => answer(SVG, "svg")
    await using r = await rig([KEY])
    const result = await r.call({ output_format: "svg", path: "logo.png" })
    expect(card(result).path).toBe(path.join(r.dir, "logo.svg"))
    expect(r.asks.filter((ask) => ask.action === "edit").map((ask) => ask.resources[0])).toEqual(["logo.svg"])
    expect(r.asks.some((ask) => ask.action === ImageTool.NAME)).toBe(true)
  })

  test("jpeg and webp are forwarded; a plain call sends no output_format", async () => {
    server.seen = []
    server.script = (seen) => answer(png(2, 2), String(seen.body.output_format ?? "png"))
    await using r = await rig([KEY])
    await r.call({ output_format: "webp" })
    await r.call({})
    expect(server.seen.map((item) => item.body.output_format)).toEqual(["webp", undefined])
  })
})

describe("the argument rules, before anything is read, asked or sent (IM-21, IM-22)", () => {
  test("each wrong combination is refused with its reason and nothing is sent", async () => {
    server.seen = []
    await using r = await rig([KEY])
    await Bun.write(path.join(r.dir, "photo.png"), png(4, 4, "rgb"))
    await expect(r.call({ output_format: "png", frame_count: 4 })).rejects.toThrow("for output_format gif only")
    await expect(r.call({ output_format: "gif", frame_count: 40 })).rejects.toThrow("frame_count must be a whole number from 2 to 16")
    await expect(r.call({ output_format: "gif", frame_duration_ms: 5 })).rejects.toThrow("frame_duration_ms must be")
    await expect(r.call({ output_format: "svg", images: ["photo.png"] })).rejects.toThrow("SVG is made from the prompt alone")
    await expect(r.call({ output_format: "gif", background: "transparent" })).rejects.toThrow("needs output_format png or webp")
    await expect(r.call({ markup: "layer.png" })).rejects.toThrow("pass the image to change first in images")
    expect(server.seen).toEqual([])
    expect(r.asks).toEqual([])
  })

  test("a fixed gpt-image-2 family refuses gif, svg and markup", async () => {
    await using r = await rig([KEY], { family: "gpt-image-2" })
    await expect(r.call({ output_format: "gif" })).rejects.toThrow('output_format "gif" is not available with gpt-image-2')
    await expect(r.call({ markup: "layer.png", images: ["photo.png"] })).rejects.toThrow("markup needs a GPT Image 2.6 model")
  })
})

describe("markup edits (IM-22)", () => {
  test("the layer goes as its own multipart file next to image[]", async () => {
    server.seen = []
    server.script = () => answer(png(8, 6), "png")
    await using r = await rig([KEY])
    await Bun.write(path.join(r.dir, "photo.png"), png(8, 6, "rgb"))
    await Bun.write(path.join(r.dir, "layer.png"), png(8, 6, "rgba"))
    const result = await r.call({ images: ["photo.png"], markup: "layer.png", complexity: "low" })
    expect(card(result).status).toBe("done")
    const seen = server.seen[0]!
    expect(seen.path).toBe("/v1/images/edits")
    expect(seen.body).toMatchObject({ model: OwnImage.FLARE, complexity: "low" })
    expect(seen.files.markup).toEqual({ type: "image/png", size: png(8, 6, "rgba").length })
    expect(seen.files["image[]"]?.type).toBe("image/png")
    // Both files were read like any input image.
    expect(r.asks.filter((ask) => ask.action === "read").map((ask) => ask.resources[0])).toEqual(["photo.png", "layer.png"])
  })

  test("a flattened layer, another size or not a PNG is refused before anything is paid for", async () => {
    server.seen = []
    await using r = await rig([KEY])
    await Bun.write(path.join(r.dir, "photo.png"), png(8, 6, "rgb"))
    await Bun.write(path.join(r.dir, "flat.png"), png(8, 6, "rgb"))
    await Bun.write(path.join(r.dir, "small.png"), png(4, 3, "rgba"))
    await Bun.write(path.join(r.dir, "layer.gif"), GIF)
    await expect(r.call({ images: ["photo.png"], markup: "flat.png" })).rejects.toThrow("the PNG has no transparency")
    await expect(r.call({ images: ["photo.png"], markup: "small.png" })).rejects.toThrow("the layer is 4x3 but images[0] is 8x6")
    await expect(r.call({ images: ["photo.png"], markup: "layer.gif" })).rejects.toThrow("the annotation layer must be a PNG")
    expect(server.seen).toEqual([])
    expect(r.asks.some((ask) => ask.action === ImageTool.NAME)).toBe(false)
  })

  test("a JPEG stored turned: the layer may match it after orientation", async () => {
    server.script = () => answer(png(6, 8), "png")
    await using r = await rig([KEY])
    await Bun.write(path.join(r.dir, "photo.jpg"), jpeg(8, 6))
    await Bun.write(path.join(r.dir, "layer.png"), png(6, 8, "rgba"))
    expect(card(await r.call({ images: ["photo.jpg"], markup: "layer.png" })).status).toBe("done")
  })
})

describe("the Codex fallback makes plain PNGs only (IM-21)", () => {
  test("a GIF with only a subscription: no account, no approval, no request, and the reason", async () => {
    server.seen = []
    await using r = await rig([SUB])
    const result = await r.call({ output_format: "gif" })
    expect(card(result).status).toBe("unavailable")
    expect(card(result).steps.map((step) => step.why)).toContain("구독(Codex)으로는 GIF를 만들 수 없어요 (OpenAI API 키의 GPT Image 2.6만 돼요)")
    expect(String(result.content)).toContain("needs an OpenAI API key with GPT Image 2.6")
    expect(server.seen).toEqual([])
    expect(r.asks).toEqual([])
  })

  test("the key fails: an SVG request ends unavailable instead of a subscription's PNG", async () => {
    server.seen = []
    server.script = (seen) =>
      seen.key === SECRETS.acc_KEY1
        ? Response.json({ error: { type: "insufficient_quota", code: "insufficient_quota" } }, { status: 429 })
        : answer(png(2, 2), "png")
    await using r = await rig([KEY, SUB])
    const result = await r.call({ output_format: "svg" })
    expect(card(result).status).toBe("unavailable")
    expect(server.seen.map((item) => item.path)).toEqual(["/v1/images/generations"])
    expect(card(result).steps.at(-1)?.why).toBe("구독(Codex)으로는 SVG를 만들 수 없어요 (OpenAI API 키의 GPT Image 2.6만 돼요)")
  })

  test("a markup edit and a webp are not asked of a subscription either; a plain PNG still is", async () => {
    expect(ImageService.keyOnly({ markup: { bytes: new Uint8Array(), name: "m.png" } })).toContain("markup")
    expect(ImageService.keyOnly({ format: "webp" })).toBe("구독(Codex)으로는 PNG만 만들 수 있어요")
    expect(ImageService.keyOnly({ format: "png" })).toBeUndefined()
    expect(ImageService.keyOnly({})).toBeUndefined()
    server.seen = []
    server.script = () => answer(png(2, 2), "png")
    await using r = await rig([SUB])
    const result = await r.call({})
    expect(card(result)).toMatchObject({ status: "done", route: "codex", format: "png" })
    expect(server.seen[0]?.body.output_format).toBeUndefined()
    await fs.rm(path.dirname(card(result).path!), { recursive: true, force: true })
  })
})
