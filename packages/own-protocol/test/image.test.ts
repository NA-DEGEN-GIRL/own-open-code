// own's image tool's pure part (02 §9.6, decisions IM): the families and their models, the defaults, the key order, the
// rate card (OpenAI's price list of 2026-11-06) and how an Images API refusal moves the chain.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OwnImage } from "../src/image.js"
import { Policy } from "../src/policy.js"
import { Preserve } from "../src/preserve.js"

describe("OwnImage", () => {
  test("families (IM-15): 2.6 auto lets the model choose Flare (default) or Sunburst; the others fix one model", () => {
    expect(OwnImage.FAMILIES).toEqual(["auto", "flare", "sunburst", "gpt-image-2"])
    expect(OwnImage.models("auto")).toEqual(["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"])
    expect(OwnImage.defaultModel("auto")).toBe(OwnImage.FLARE)
    expect(OwnImage.chooses("auto")).toBe(true)
    for (const family of ["flare", "sunburst", "gpt-image-2"] as const) {
      expect(OwnImage.models(family)).toHaveLength(1)
      expect(OwnImage.chooses(family)).toBe(false)
    }
    expect(OwnImage.defaultModel("flare")).toBe("gpt-image-2.6-flare")
    expect(OwnImage.defaultModel("sunburst")).toBe("gpt-image-2.6-sunburst")
    expect(OwnImage.defaultModel("gpt-image-2")).toBe("gpt-image-2")
    expect(Schema.decodeUnknownOption(OwnImage.Family)("gpt-image-1.5")._tag).toBe("None")
    // Complexity (IM-17): the 2.6 models only.
    expect([OwnImage.FLARE, OwnImage.SUNBURST, OwnImage.GPT_IMAGE_2, "gpt-image-2.5-flare"].map(OwnImage.takesComplexity)).toEqual([
      true,
      true,
      false,
      false,
    ])
  })

  test("a stored setting migrates (IM-16): 2.5 names stay and mean 2.6, gpt-image-1.5 reads and writes as gpt-image-2", () => {
    const decode = Schema.decodeUnknownSync(OwnImage.Setting)
    for (const family of ["auto", "flare", "sunburst", "gpt-image-2"] as const) expect(decode({ family }).family).toBe(family)
    expect(decode({ family: "gpt-image-1.5", quality: "low" })).toEqual({ family: "gpt-image-2", quality: "low" })
    expect(OwnImage.defaultModel(OwnImage.resolve(decode({ family: "gpt-image-1.5" })).family)).toBe("gpt-image-2")
    expect(Schema.decodeUnknownOption(OwnImage.Setting)({ family: "gpt-image-3" })._tag).toBe("None")
    // policy.json as the store reads and rewrites it: the old value comes back as gpt-image-2, other keys kept.
    const file = { ...(Schema.encodeSync(Policy.File)(Policy.defaults) as object), image: { family: "gpt-image-1.5", size: "1024x1024" } }
    expect((Preserve.roundTrip(Policy.File, file) as { image?: unknown }).image).toEqual({ family: "gpt-image-2", size: "1024x1024" })
    // A patch naming the retired family (an older window) stores gpt-image-2 as well.
    expect(Schema.decodeUnknownSync(Policy.Patch)({ image: { family: "gpt-image-1.5" } }).image).toEqual({ family: "gpt-image-2" })
  })

  test("defaults: auto, OpenAI's quality and size, every key, the Codex fallback on (IM-3)", () => {
    expect(OwnImage.resolve(undefined)).toEqual({
      family: "auto",
      quality: "auto",
      size: "auto",
      useKeys: true,
      keyOrder: [],
      keyOff: [],
      codexFallback: true,
      codexOff: [],
    })
    expect(OwnImage.apply({ family: "flare", quality: "low" }, { quality: "high" })).toEqual({
      family: "flare",
      quality: "high",
    })
  })

  test("the user's key order first, then every other key in its own order", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }]
    expect(OwnImage.ordered(items, ["c", "gone", "a"]).map((item) => item.id)).toEqual(["c", "a", "b"])
  })

  test("the rate card (IM-18): $5 text in ($1.25 cached), $8 image in ($2 cached), $30 image out; only offered models", () => {
    expect(OwnImage.RATES[OwnImage.FLARE]).toEqual({ textIn: 5, textCached: 1.25, imageIn: 8, imageCached: 2, imageOut: 30 })
    expect(OwnImage.RATES[OwnImage.SUNBURST]).toEqual(OwnImage.RATES[OwnImage.FLARE])
    expect(OwnImage.RATES[OwnImage.GPT_IMAGE_2]).toEqual(OwnImage.RATES[OwnImage.FLARE])
    expect(Object.keys(OwnImage.RATES).toSorted()).toEqual(["gpt-image-2", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"])
    expect(OwnImage.RATES_SOURCE).toBe("https://developers.openai.com/api/docs/pricing (2026-11-06)")
    // A plain image: 50 text tokens in, 1,056 image tokens out.
    expect(OwnImage.cost(OwnImage.FLARE, { input_tokens: 50, output_tokens: 1056, input_tokens_details: { text_tokens: 50, image_tokens: 0 } })).toBeCloseTo(
      (50 * 5 + 1056 * 30) / 1e6,
      9,
    )
    // An edit with cached input split by OpenAI: each kind at its cached price.
    const edit = {
      input_tokens: 1300,
      output_tokens: 1000,
      input_tokens_details: {
        text_tokens: 100,
        image_tokens: 1200,
        cached_tokens: 1000,
        cached_tokens_details: { text_tokens: 0, image_tokens: 1000 },
      },
    }
    expect(OwnImage.cost(OwnImage.SUNBURST, edit)).toBeCloseTo((100 * 5 + 200 * 8 + 1000 * 2 + 1000 * 30) / 1e6, 9)
    // A bare cached count is taken as image tokens first.
    const bare = { ...edit, input_tokens_details: { text_tokens: 100, image_tokens: 1200, cached_tokens: 1000 } }
    expect(OwnImage.cost(OwnImage.SUNBURST, bare)).toBeCloseTo(OwnImage.cost(OwnImage.SUNBURST, edit)!, 9)
    expect(OwnImage.tokens(edit)).toEqual({ input: 1300, cached: 1000, output: 1000 })
    expect(OwnImage.cost("dall-e-3", edit)).toBeUndefined()
  })

  test("refusals: money or quota moves to the next key, a plain 429 and 5xx retry, a refused prompt stops", () => {
    const body = (code: string, type = "invalid_request_error") => ({ error: { code, type, message: "m" } })
    expect(OwnImage.classify(429, body("insufficient_quota", "insufficient_quota"))).toBe("quota")
    expect(OwnImage.classify(400, body("billing_hard_limit_reached"))).toBe("quota")
    expect(OwnImage.classify(429, { error: { type: "insufficient_quota" } })).toBe("quota")
    expect(OwnImage.classify(429, body("rate_limit_exceeded", "requests"))).toBe("rate")
    expect(OwnImage.classify(429, undefined)).toBe("rate")
    expect(OwnImage.classify(503, undefined)).toBe("server")
    expect(OwnImage.classify(401, body("invalid_api_key"))).toBe("auth")
    expect(OwnImage.classify(403, body("organization_not_verified"))).toBe("access")
    expect(OwnImage.classify(404, body("model_not_found"))).toBe("access")
    expect(OwnImage.classify(400, body("moderation_blocked"))).toBe("refused")
  })
})

describe("OwnImage formats and markup (IM-21, IM-22)", () => {
  test("GPT Image 2.6 makes gif and svg too; gpt-image-2 the raster three; a family offers what all its models take", () => {
    expect(OwnImage.formats(OwnImage.FLARE)).toEqual(["png", "jpeg", "webp", "gif", "svg"])
    expect(OwnImage.formats(OwnImage.SUNBURST)).toEqual(OwnImage.FORMATS)
    expect(OwnImage.formats(OwnImage.GPT_IMAGE_2)).toEqual(["png", "jpeg", "webp"])
    expect(OwnImage.familyFormats("auto")).toEqual(OwnImage.FORMATS)
    expect(OwnImage.familyFormats("flare")).toEqual(OwnImage.FORMATS)
    expect(OwnImage.familyFormats("gpt-image-2")).toEqual(["png", "jpeg", "webp"])
    expect(Schema.decodeUnknownSync(OwnImage.Format)("gif")).toBe("gif")
    expect(() => Schema.decodeUnknownSync(OwnImage.Format)("bmp")).toThrow()
  })

  test("each format's extension and MIME; OpenAI's GIF limits; markup for the 2.6 models only", () => {
    expect(OwnImage.FORMATS.map((format) => [OwnImage.EXTENSION[format], OwnImage.MIME[format]])).toEqual([
      [".png", "image/png"],
      [".jpg", "image/jpeg"],
      [".webp", "image/webp"],
      [".gif", "image/gif"],
      [".svg", "image/svg+xml"],
    ])
    expect(OwnImage.GIF_FRAMES).toEqual({ min: 2, max: 16, default: 9 })
    expect(OwnImage.GIF_FRAME_MS).toEqual({ min: 20, max: 2000, default: 200 })
    expect(OwnImage.MARKUP_MAX_PIXELS).toBe(4096 * 4096)
    expect([OwnImage.FLARE, OwnImage.SUNBURST, OwnImage.GPT_IMAGE_2].map(OwnImage.takesMarkup)).toEqual([true, true, false])
  })
})

describe("OwnImage GIF sheets and the SVG author (IM-31..IM-34)", () => {
  test("the sheet grids per frame count, as OpenAI's refusals named them", () => {
    expect(OwnImage.gifSheets(2)).toEqual([[4, 2], [2, 4]])
    expect(OwnImage.gifSheets(8)).toEqual([[4, 2], [2, 4]])
    expect(OwnImage.gifSheets(9)).toEqual([[3, 3]])
    expect(OwnImage.gifSheets(12)).toEqual([[4, 3], [3, 4], [4, 4]])
    expect(OwnImage.gifSheets(16)).toEqual([[4, 4]])
  })

  test("what fits: OpenAI's live refusals and the sizes it took (2026-11-09)", () => {
    // Refused: the 3-frame 1024 sheet is 4096 wide; 9 frames at 1024 make 3072x3072, past 8,294,400 pixels.
    expect(OwnImage.gifFits(1024, 1024, 3)).toBe(false)
    expect(OwnImage.gifFits(1024, 1024, 9)).toBe(false)
    expect(OwnImage.gifFits(976, 976, 9)).toBe(false)
    expect(OwnImage.gifFits(832, 832, 12)).toBe(false)
    expect(OwnImage.gifFits(736, 736, 16)).toBe(false)
    expect(OwnImage.gifFits(256, 256, 2)).toBe(false)
    // Taken.
    for (const [width, height, frames] of [
      [960, 960, 2],
      [960, 960, 9],
      [816, 816, 12],
      [720, 720, 16],
      [1200, 800, 8],
      [1152, 768, 9],
      [1008, 672, 12],
      [864, 576, 16],
      [800, 1200, 8],
    ] as const)
      expect(OwnImage.gifFits(width, height, frames)).toBe(true)
  })

  test("a GIF's frame size: auto stays, a fixed size becomes the largest frame of its shape that fits", () => {
    expect(OwnImage.gifSize("auto", 3)).toBe("auto")
    expect([2, 8, 9, 10, 12, 13, 16].map((frames) => OwnImage.gifSize("1024x1024", frames))).toEqual([
      "960x960",
      "960x960",
      "960x960",
      "816x816",
      "816x816",
      "720x720",
      "720x720",
    ])
    expect([3, 9, 11, 14].map((frames) => OwnImage.gifSize("1536x1024", frames))).toEqual(["1200x800", "1152x768", "1008x672", "864x576"])
    expect([3, 9, 11, 14].map((frames) => OwnImage.gifSize("1024x1536", frames))).toEqual(["800x1200", "768x1152", "672x1008", "576x864"])
  })

  test("the SVG author and its price: a dated snapshot counts, an unknown author stays unpriced", () => {
    expect(OwnImage.SVG_AUTHOR).toBe("gpt-6-luna")
    expect(OwnImage.authorCost({ model: "gpt-6-luna", input: 1000, output: 2000 })).toBeCloseTo((1000 * 0.1 + 2000 * 0.5) / 1e6, 10)
    // Reasoning beside output_tokens: total minus input counts as output.
    expect(OwnImage.authorCost({ model: "gpt-6-luna-2026-09-22", input: 1000, output: 2000, total: 5000 })).toBeCloseTo(
      (1000 * 0.1 + 4000 * 0.5) / 1e6,
      10,
    )
    expect(OwnImage.authorCost({ model: "gpt-5.5", input: 1000, output: 2000 })).toBeUndefined()
    expect(OwnImage.authorCost({ model: "gpt-6-lunatic", input: 1, output: 1 })).toBeUndefined()
  })
})
