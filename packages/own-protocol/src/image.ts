export * as OwnImage from "./image.js"

import { Schema, SchemaTransformation } from "effect"
import { optional } from "@opencode/schema/schema"
import { AccountID } from "./account-id.js"
import { EpochMillis } from "./id.js"

/**
 * own's image tool (02 §9.6, 설명서 10.17 이미지 만들기, decisions IM): images through the user's OpenAI API key accounts
 * (`oai`), tried in the user's order, then through ChatGPT subscription accounts' Codex image generation when every key
 * is used up. The model family, the default quality and size, the key chain and the Codex fallback live in
 * `policy.json` under `image`; the keys never leave the vault (own-accounts asks OpenAI itself with `logins.headers`).
 * Pure: own-web reads the families, prices and texts from here.
 */

/** own's image tool (02 §9.6): its name, and the permission action every call asks (the model is the resource). */
export const TOOL = "image_generate"

/** GPT Image 2.6 Flare: the fastest, the everyday default. */
export const FLARE = "gpt-image-2.6-flare"
/** GPT Image 2.6 Sunburst: the most capable for precise edits and high-fidelity work. */
export const SUNBURST = "gpt-image-2.6-sunburst"
/** What Codex's own image tool sends (`codex-rs/ext/image-generation` `IMAGE_MODEL`), and the Codex backend's model. */
export const GPT_IMAGE_2 = "gpt-image-2"

/**
 * Which models the API keys use (설정 > 이미지 만들기 > `모델 (API 키)`, decisions IM-15):
 * - `auto` (recommended, the default): the conversation's model picks GPT Image 2.6 Flare or Sunburst for each image;
 * - `flare`, `sunburst` (GPT Image 2.6), `gpt-image-2`: that model only; the tool takes no model then.
 * The Codex fallback always uses the Codex backend's own model, whatever this says.
 */
export const Family = Schema.Literals(["auto", "flare", "sunburst", "gpt-image-2"]).annotate({
  identifier: "Own.Image.Family",
})
export type Family = typeof Family.Type

export const FAMILIES: ReadonlyArray<Family> = ["auto", "flare", "sunburst", "gpt-image-2"]

/**
 * A family as `policy.json` may hold it (IM-16). `auto`, `flare` and `sunburst` meant GPT Image 2.5 until 2026-11-06
 * and mean 2.6 under the same names; the retired `gpt-image-1.5` still decodes, as `gpt-image-2`, so an older file stays
 * readable. The store writes the new value back with the next change to `policy.json`.
 */
export const StoredFamily = Schema.Literals([...FAMILIES, "gpt-image-1.5"]).pipe(
  Schema.decodeTo(
    Family,
    SchemaTransformation.transform({
      decode: (family) => (family === "gpt-image-1.5" ? GPT_IMAGE_2 : family),
      encode: (family) => family,
    }),
  ),
)

/** The models a family lets the tool use, the default first. */
export function models(family: Family): ReadonlyArray<string> {
  if (family === "auto") return [FLARE, SUNBURST]
  if (family === "flare") return [FLARE]
  if (family === "sunburst") return [SUNBURST]
  return [GPT_IMAGE_2]
}

/** The model a call without `model` uses. */
export function defaultModel(family: Family) {
  return models(family)[0]!
}

/** Whether the conversation's model chooses the model per image (only `auto`). */
export function chooses(family: Family) {
  return models(family).length > 1
}

/** OpenAI's `quality`; `auto` lets OpenAI choose. `low` is the cheapest. */
export const Quality = Schema.Literals(["auto", "low", "medium", "high"]).annotate({ identifier: "Own.Image.Quality" })
export type Quality = typeof Quality.Type

/**
 * OpenAI's `complexity` (GPT Image 2.6, IM-17): how much the model plans before it renders, apart from `quality`.
 * Omitted, OpenAI uses the model's own default. The tool takes it per call; there is no stored default.
 */
export const Complexity = Schema.Literals(["low", "medium", "high"]).annotate({ identifier: "Own.Image.Complexity" })
export type Complexity = typeof Complexity.Type

/** Whether a model takes {@link Complexity}: the GPT Image 2.6 models. */
export function takesComplexity(model: string) {
  return model === FLARE || model === SUNBURST
}

/**
 * OpenAI's `output_format` (IM-21): the file the Images API returns. `png` is the default and the only one a
 * subscription makes (the Codex fallback sends no format). GPT Image 2.6 also makes an animated `gif` (generations and
 * edits) and an `svg` (generations only, one image, written by an authoring model from a reference image; static vector
 * content without scripts, external resources or embedded raster images). OpenAI says SVG needs project access and GIF
 * the model's GIF preview; a key without it is refused by OpenAI, nothing is guessed here.
 */
export const Format = Schema.Literals(["png", "jpeg", "webp", "gif", "svg"]).annotate({ identifier: "Own.Image.Format" })
export type Format = typeof Format.Type

export const FORMATS: ReadonlyArray<Format> = ["png", "jpeg", "webp", "gif", "svg"]

/** The formats a model takes: every GPT Image model the raster three, GPT Image 2.6 also `gif` and `svg`. */
export function formats(model: string): ReadonlyArray<Format> {
  return takesComplexity(model) ? FORMATS : ["png", "jpeg", "webp"]
}

/** The formats every model of a family takes: what the tool offers (as {@link Complexity}, IM-17). */
export function familyFormats(family: Family): ReadonlyArray<Format> {
  return FORMATS.filter((format) => models(family).every((model) => formats(model).includes(format)))
}

/** The file extension and MIME type of each format. */
export const EXTENSION: Readonly<Record<Format, string>> = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
  gif: ".gif",
  svg: ".svg",
}
export const MIME: Readonly<Record<Format, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
}

/**
 * An animated GIF's `frame_count` and `frame_duration_ms` (developers.openai.com/api/docs/guides/image-generation,
 * read 2026-11-08): 2 to 16 frames (OpenAI's default 9), 20 to 2000 ms a frame (default 200, rounded to 10 ms). Only
 * with `output_format: "gif"`.
 */
export const GIF_FRAMES = { min: 2, max: 16, default: 9 } as const
export const GIF_FRAME_MS = { min: 20, max: 2000, default: 200 } as const

/**
 * The limits of one image OpenAI renders (the guide's custom sizes): at most 3840 px a side, 655,360 to 8,294,400
 * pixels. A GIF's `size` is one frame, but OpenAI renders every frame on one sheet that must keep these limits
 * (IM-31): a GIF of 3 frames at 1024x1024 was refused live ("No supported sheet fits 3 GIF frames at size
 * '1024x1024'. Invalid size '4096x2048'").
 */
export const SHEET_LIMITS = { maxEdge: 3840, minPixels: 655_360, maxPixels: 8_294_400 } as const

/**
 * The sheet grids (columns, rows) OpenAI tries for a GIF's frame count, as its refusals named them (probed 2026-11-09
 * without a paid image, IM-31; not in the docs): 2-8 frames 4x2 or 2x4, 9 frames 3x3, 10-12 frames 4x3, 3x4 or 4x4,
 * 13-16 frames 4x4.
 */
export function gifSheets(frames: number): ReadonlyArray<readonly [number, number]> {
  if (frames <= 8) return [[4, 2], [2, 4]]
  if (frames === 9) return [[3, 3]]
  if (frames <= 12) return [[4, 3], [3, 4], [4, 4]]
  return [[4, 4]]
}

/** Whether frames of this size fit one of the frame count's sheets within {@link SHEET_LIMITS}. */
export function gifFits(width: number, height: number, frames: number) {
  return gifSheets(frames).some(([columns, rows]) => {
    const pixels = columns * width * rows * height
    return (
      Math.max(columns * width, rows * height) <= SHEET_LIMITS.maxEdge &&
      pixels >= SHEET_LIMITS.minPixels &&
      pixels <= SHEET_LIMITS.maxPixels
    )
  })
}

/**
 * The frame size own sends for a GIF (IM-32): `auto` stays `auto` (OpenAI picks a frame that fits); a fixed size
 * becomes the largest frame of the same shape, no larger than asked and both sides multiples of 16, that fits the frame
 * count. A square: 960x960 for 2-9 frames, 816x816 for 10-12, 720x720 for 13-16; 3:2 1200x800, 1152x768, 1008x672,
 * 864x576 (2:3 turned).
 */
export function gifSize(size: Size, frames: number): Size | `${number}x${number}` {
  if (size === "auto") return size
  const [width, height] = size.split("x").map(Number) as [number, number]
  const steps = divisor(width / 16, height / 16)
  const unit = { width: width / steps, height: height / steps }
  const fitting = Array.from({ length: steps }, (_, index) => steps - index).find((step) =>
    gifFits(unit.width * step, unit.height * step, frames),
  )
  return fitting === undefined ? "auto" : `${unit.width * fitting}x${unit.height * fitting}`
}

function divisor(a: number, b: number): number {
  return b === 0 ? a : divisor(b, a % b)
}

/**
 * The model that writes an SVG from OpenAI's reference image (`svg.model`, IM-33). OpenAI's reference makes `svg.model`
 * required "when SVG model selection is enabled", and an SVG request without it was refused live ("SVG generation
 * requires 'svg.model'"); the docs name no author model and no default. GPT-6 Luna is the cheapest current GPT-6 model
 * on the pricing page, and it wrote a clean live SVG of a cube for $0.0008 (IM-36).
 */
export const SVG_AUTHOR = "gpt-6-luna"

/** The SVG author's text rates in USD per 1M tokens (developers.openai.com/api/docs/pricing, Standard, 2026-11-09). */
export const AUTHOR_RATES: Readonly<Record<string, { readonly input: number; readonly cached: number; readonly output: number }>> = {
  [SVG_AUTHOR]: { input: 0.1, cached: 0.01, output: 0.5 },
}

/**
 * The USD of an SVG's authoring tokens, or `undefined` for an author without a card. OpenAI names the author per answer
 * (a dated snapshot counts as its model). `svg_usage` has no cached split, so every input token counts at the input
 * rate; reasoning counts as output, whether OpenAI reports it inside `output_tokens` or beside it (`total_tokens`).
 */
export function authorCost(usage: SvgUsage) {
  const id = Object.keys(AUTHOR_RATES).find((model) => usage.model === model || usage.model.startsWith(`${model}-20`))
  if (id === undefined) return undefined
  const rate = AUTHOR_RATES[id]!
  const output = Math.max(usage.output, (usage.total ?? 0) - usage.input)
  return Math.round(usage.input * rate.input + output * rate.output) / 1_000_000
}

/**
 * Whether a model takes `markup` (a transparent PNG annotation layer the size of the first input image, on
 * `/images/edits` only, never with a mask): GPT Image 2.5 and 2.6 by OpenAI's guide, so of own's models the 2.6 ones
 * (IM-22). The Codex fallback never takes it.
 */
export function takesMarkup(model: string) {
  return takesComplexity(model)
}

/** The most pixels OpenAI takes in the first input image and in the annotation layer, each (16,777,216). */
export const MARKUP_MAX_PIXELS = 16_777_216

/** OpenAI's `size`; `auto` lets OpenAI choose. The three fixed sizes every GPT Image model takes. */
export const Size = Schema.Literals(["auto", "1024x1024", "1536x1024", "1024x1536"]).annotate({
  identifier: "Own.Image.Size",
})
export type Size = typeof Size.Type

/**
 * `policy.json` `image`. Every field is optional: {@link resolve} fills the defaults.
 * - `useKeys`: the quick switch `API 키 쓰기` (default on). Off, the chain asks no API key at all and goes straight to
 *   the subscriptions (IM-12), whatever each key's own switch says.
 * - `keyOrder`: the user's order of OpenAI API key accounts; accounts it does not name follow in registry order.
 * - `keyOff`: keys the chain leaves out (each key's own switch, separate from a used-up mark).
 * - `codexFallback`: when every key is used up, make the image with a ChatGPT subscription (default on, decisions
 *   IM-3). `codexOff`: subscription accounts it leaves out; the others are tried from the most remaining limit.
 */
export interface Setting extends Schema.Schema.Type<typeof Setting> {}
export const Setting = Schema.Struct({
  family: optional(StoredFamily),
  quality: optional(Quality),
  size: optional(Size),
  useKeys: optional(Schema.Boolean),
  keyOrder: optional(Schema.Array(AccountID)),
  keyOff: optional(Schema.Array(AccountID)),
  codexFallback: optional(Schema.Boolean),
  codexOff: optional(Schema.Array(AccountID)),
}).annotate({ identifier: "Own.Image.Setting" })

export interface Resolved {
  readonly family: Family
  readonly quality: Quality
  readonly size: Size
  readonly useKeys: boolean
  readonly keyOrder: ReadonlyArray<AccountID>
  readonly keyOff: ReadonlyArray<AccountID>
  readonly codexFallback: boolean
  readonly codexOff: ReadonlyArray<AccountID>
}

export const DEFAULTS: Resolved = {
  family: "auto",
  quality: "auto",
  size: "auto",
  useKeys: true,
  keyOrder: [],
  keyOff: [],
  codexFallback: true,
  codexOff: [],
}

export function resolve(setting: Setting | undefined): Resolved {
  return { ...DEFAULTS, ...setting }
}

/** The stored setting with a patch: the given fields replace the stored ones. */
export function apply(stored: Setting | undefined, patch: Setting): Setting {
  return { ...stored, ...patch }
}

/** The ids in `order` first (those still listed), then every other listed id in its own order. */
export function ordered<T extends { readonly id: string }>(items: ReadonlyArray<T>, order: ReadonlyArray<string>) {
  const named = order.flatMap((id) => items.filter((item) => item.id === id))
  return [...named, ...items.filter((item) => !order.includes(item.id))]
}

/**
 * Prices in USD per 1M tokens, from OpenAI's pricing page (developers.openai.com/api/docs/pricing, read 2026-11-06;
 * decisions IM-5, IM-18). GPT Image 2.6 Flare, 2.6 Sunburst and GPT Image 2 cost the same per token. Only the models
 * the families offer have a card: a ledger line keeps the cost computed when the image was made, so the retired 2.5
 * and 1.5 models need none. The bundled models.dev snapshot lacks these image output prices, so own keeps its own card.
 */
export interface Rate {
  readonly textIn: number
  readonly textCached: number
  readonly imageIn: number
  readonly imageCached: number
  readonly imageOut: number
}

export const RATES: Readonly<Record<string, Rate>> = {
  [FLARE]: { textIn: 5, textCached: 1.25, imageIn: 8, imageCached: 2, imageOut: 30 },
  [SUNBURST]: { textIn: 5, textCached: 1.25, imageIn: 8, imageCached: 2, imageOut: 30 },
  [GPT_IMAGE_2]: { textIn: 5, textCached: 1.25, imageIn: 8, imageCached: 2, imageOut: 30 },
}

export const RATES_SOURCE = "https://developers.openai.com/api/docs/pricing (2026-11-06)"

/** The Images API's `usage` (generations and edits). */
export interface Usage extends Schema.Schema.Type<typeof Usage> {}
export const Usage = Schema.Struct({
  input_tokens: optional(Schema.Number),
  output_tokens: optional(Schema.Number),
  input_tokens_details: optional(
    Schema.Struct({
      text_tokens: optional(Schema.Number),
      image_tokens: optional(Schema.Number),
      cached_tokens: optional(Schema.Number),
      cached_tokens_details: optional(
        Schema.Struct({ text_tokens: optional(Schema.Number), image_tokens: optional(Schema.Number) }),
      ),
    }),
  ),
}).annotate({ identifier: "Own.Image.Usage" })

/** The token counts a ledger line keeps: input (text and image), the cached part, output. */
export function tokens(usage: Usage) {
  const details = usage.input_tokens_details
  const text = details?.text_tokens ?? 0
  const image = details?.image_tokens ?? 0
  const input = usage.input_tokens ?? text + image
  return { input, cached: Math.min(details?.cached_tokens ?? cachedOf(usage).total, input), output: usage.output_tokens ?? 0 }
}

/**
 * The USD cost of one call, or `undefined` for a model without a card. Cached input counts at the cached price of its
 * kind: OpenAI splits it in `cached_tokens_details` when it reports it; a bare `cached_tokens` is taken as image tokens
 * first (an edit's images are the large repeated part), then text.
 */
export function cost(modelID: string, usage: Usage) {
  const rate = RATES[modelID]
  if (!rate) return undefined
  const details = usage.input_tokens_details
  const text = details?.text_tokens ?? 0
  const image = details?.image_tokens ?? Math.max(0, (usage.input_tokens ?? 0) - text)
  const cached = cachedOf(usage)
  const imageCached = Math.min(image, cached.image)
  const textCached = Math.min(text, cached.text + (cached.image - imageCached))
  const amount =
    (text - textCached) * rate.textIn +
    textCached * rate.textCached +
    (image - imageCached) * rate.imageIn +
    imageCached * rate.imageCached +
    (usage.output_tokens ?? 0) * rate.imageOut
  return Math.round(amount) / 1_000_000
}

function cachedOf(usage: Usage) {
  const details = usage.input_tokens_details
  const split = details?.cached_tokens_details
  if (split) {
    const text = split.text_tokens ?? 0
    const image = split.image_tokens ?? 0
    return { text, image, total: text + image }
  }
  const total = details?.cached_tokens ?? 0
  return { text: 0, image: total, total }
}

/**
 * How an Images API refusal moves the chain (02 §9.6):
 * - `quota`: the key's money or quota is used up (`insufficient_quota`, `billing_hard_limit_reached`,
 *   `billing_not_active`, a 429 that names a quota): marked used up for {@link COOLDOWN_MS}, then the next key.
 * - `rate`: a plain rate limit (429 otherwise), `server`: 5xx or a lost connection: the same key again after a wait.
 * - `auth`: 401; `access`: 403 or 404 (an organization not verified for GPT Image, a model the key cannot use): next key.
 * - `refused`: anything else (a prompt the safety system refused, a bad request): no other key would answer otherwise.
 */
export type Failure = "quota" | "rate" | "server" | "auth" | "access" | "refused"

const QUOTA_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_not_active"])

export function classify(status: number, body: unknown): Failure {
  const error = errorOf(body)
  if (QUOTA_CODES.has(error.code ?? "") || QUOTA_CODES.has(error.type ?? "")) return "quota"
  if (status === 429) return /quota|billing/i.test(`${error.code ?? ""} ${error.type ?? ""}`) ? "quota" : "rate"
  if (status === 401) return "auth"
  if (status === 403 || status === 404) return "access"
  if (status >= 500 || status === 408) return "server"
  return "refused"
}

/** The `error.code`/`type`/`message` of an OpenAI error body, as far as they are strings. */
export function errorOf(body: unknown): { readonly code?: string; readonly type?: string; readonly message?: string } {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof error !== "object" || error === null) return {}
  const record = error as Record<string, unknown>
  const text = (value: unknown) => (typeof value === "string" ? value : undefined)
  return { code: text(record.code), type: text(record.type), message: text(record.message) }
}

/** How long a key found used up is skipped, unless the user clears it (`image.clear`) or it answers again. */
export const COOLDOWN_MS = 6 * 60 * 60_000

/** A key found used up: the code OpenAI answered and when. Kept in own-accounts' storage, never a guess. */
export interface Exhausted extends Schema.Schema.Type<typeof Exhausted> {}
export const Exhausted = Schema.Struct({
  code: Schema.String,
  at: EpochMillis,
  until: EpochMillis,
}).annotate({ identifier: "Own.Image.Exhausted" })

/** `image.get`: the setting, the key chain and the subscription accounts as the tool would try them now. */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  setting: Schema.Struct({
    family: Family,
    quality: Quality,
    size: Size,
    useKeys: Schema.Boolean,
    codexFallback: Schema.Boolean,
  }),
  /** Every OpenAI API key account in chain order; `on: false` for one the chain leaves out. */
  keys: Schema.Array(
    Schema.Struct({
      accountID: AccountID,
      label: Schema.String,
      on: Schema.Boolean,
      ready: Schema.Boolean,
      exhausted: optional(Exhausted),
    }),
  ),
  /** Every ChatGPT subscription account, from the most remaining limit; `on: false` for one left out. */
  codex: Schema.Array(
    Schema.Struct({
      accountID: AccountID,
      label: Schema.String,
      on: Schema.Boolean,
      ready: Schema.Boolean,
      /** The tightest window's used share, when known. */
      usedPercent: optional(Schema.Number),
      exhausted: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "Own.Image.View" })

export const ClearInput = Schema.Struct({ accountID: AccountID }).annotate({ identifier: "Own.Image.ClearInput" })

/**
 * One account the tool tried or skipped, in order, as the result card lists it (`steps`). `why` is the reason in the
 * user's language, `outcome` the machine reading.
 */
export interface Step {
  readonly route: "key" | "codex"
  readonly accountID: string
  readonly label: string
  readonly outcome: "used" | "skipped" | "failed"
  readonly why?: string
}

/**
 * The result card's data (`metadata.ownImage` of the tool part). `unavailable`: no source could make the image (every
 * key and subscription off, used up, at its limit or failing; IM-13), `steps` names each with its reason.
 */
export interface CardData {
  readonly status: "done" | "unavailable" | "failed"
  readonly model?: string
  readonly route?: "key" | "codex"
  readonly account?: string
  readonly costUSD?: number
  readonly path?: string
  /** The format of the bytes saved (sniffed, IM-23); absent on cards from before 2026-11-08 (PNG, JPEG or WebP). */
  readonly format?: Format
  /** The format the call asked for, only when the bytes came back in another one (said, never hidden: IM-23). */
  readonly asked?: Format
  /** An animated GIF's frame count. */
  readonly frames?: number
  /**
   * What own-web shows for a GIF or an SVG (IM-23): the whole animation or the SVG as a base64 `data:` URI. The result's
   * file part carries only the GIF's first frame (a still every chat model takes) and no SVG at all (no chat model takes
   * SVG as an image, and one in the history would fail every later request), so the card cannot show those from the
   * file part. own-web draws it only as an `<img>`, never as markup in the page.
   */
  readonly preview?: string
  /**
   * A GIF's frame size when own sent another than asked (IM-32): `from` the size asked (or the user's default), `to` the
   * largest frame of that shape that fits the frame count on OpenAI's sheet.
   */
  readonly resized?: { readonly from: string; readonly to: string }
  /**
   * An SVG's authoring tokens (`svg_usage`). With `costUSD` (an author on {@link AUTHOR_RATES}) that cost is inside the
   * card's `costUSD`; without it they are billed at the author's rates and not in `costUSD` (IM-24, IM-34).
   */
  readonly svgAuthor?: SvgUsage
  readonly steps: ReadonlyArray<Step>
}

/** The Images API's `svg_usage`: the authoring model and its tokens, apart from the reference image's `usage`. */
export interface SvgUsage {
  readonly model: string
  readonly input: number
  readonly output: number
  /** `reasoning_tokens` and `total_tokens`, when OpenAI reports them. */
  readonly reasoning?: number
  readonly total?: number
  /** The authoring's USD ({@link authorCost}), when the author has a card. */
  readonly costUSD?: number
}

/** The tool part's metadata key own-web reads. */
export const CARD_KEY = "ownImage"
