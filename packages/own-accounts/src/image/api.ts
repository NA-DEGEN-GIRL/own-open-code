export * as ImageApi from "./api.js"

import { Option, Schema } from "effect"
import { OwnImage } from "@own/protocol"

/**
 * The two image endpoints own's image tool asks (02 §9.6). Both take the same request:
 * - the OpenAI Images API with an API key (`<openai>/images/generations` as JSON, `<openai>/images/edits` as multipart
 *   with `image[]` and a markup edit's `markup` file), the model the family allows, and `output_format` with a GIF's
 *   `frame_count` and `frame_duration_ms` when asked, an SVG always with its author model `svg.model` (IM-21, IM-22,
 *   IM-33);
 * - the Codex backend with a ChatGPT login (`<codex>/images/generations` and `/images/edits`, JSON; an edit's images as
 *   `{image_url}` data URLs), as Codex's own image tool sends it (`codex-rs/ext/image-generation` `tool.rs`,
 *   `codex-api/src/endpoint/images.rs`): the backend's model (`gpt-image-2`), `quality` and `size` `auto` unless asked;
 *   never a format, frames or markup (Codex sends none; `ImageService` asks no subscription for them).
 * The caller passes the account's headers (`Logins.headers`): the key or token never leaves this process, is never
 * logged and never reaches a shell. No retries here (`ImageService` decides).
 */

export interface Input {
  readonly model: string
  readonly prompt: string
  readonly quality: OwnImage.Quality
  /** A fixed size, `auto`, or a GIF's frame size own fitted to its sheet (`OwnImage.gifSize`, IM-32). */
  readonly size: ReturnType<typeof OwnImage.gifSize>
  readonly background?: "transparent" | "opaque" | "auto"
  /** GPT Image 2.6's planning depth; the Codex backend is never sent one. */
  readonly complexity?: OwnImage.Complexity
  /** `output_format`; absent, OpenAI's default (PNG). The Codex backend is never sent one (IM-21). */
  readonly format?: OwnImage.Format
  /** An animated GIF's `frame_count` and `frame_duration_ms`. */
  readonly frames?: number
  readonly frameMs?: number
  /** Edit sources or references, in order. */
  readonly images: ReadonlyArray<{ readonly bytes: Uint8Array; readonly mime: string; readonly name: string }>
  /** The annotation layer over the first image (`markup`, a transparent PNG; IM-22); the Codex backend never gets one. */
  readonly markup?: { readonly bytes: Uint8Array; readonly name: string }
}

export type Answer =
  | {
      readonly ok: true
      readonly bytes: Uint8Array
      readonly format: string
      readonly usage?: OwnImage.Usage
      /** An SVG's authoring tokens (`svg_usage`), apart from `usage`. */
      readonly svgUsage?: OwnImage.SvgUsage
      readonly response: Response
    }
  | {
      readonly ok: false
      readonly failure: OwnImage.Failure
      readonly status: number
      /** OpenAI's error code or type; never the message (it may quote the request). */
      readonly code?: string
      /** Seconds the server asked to wait (`retry-after`). */
      readonly retryAfter?: number
      readonly response?: Response
    }

const Body = Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: Schema.optional(Schema.NullOr(Schema.String)) })),
  output_format: Schema.optional(Schema.String),
  usage: Schema.optional(OwnImage.Usage),
  svg_usage: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
      reasoning_tokens: Schema.optional(Schema.Number),
      total_tokens: Schema.optional(Schema.Number),
    }),
  ),
})
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Body))
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** One Images API request with an API key. */
export function openai(base: string, headers: Readonly<Record<string, string>>, input: Input, signal: AbortSignal) {
  const root = base.replace(/\/+$/, "")
  if (input.images.length === 0)
    return send(`${root}/images/generations`, { ...headers, "content-type": "application/json" }, JSON.stringify(fields(input)), signal)
  const form = new FormData()
  for (const [name, value] of Object.entries(fields(input))) form.append(name, String(value))
  for (const image of input.images) form.append("image[]", new Blob([new Uint8Array(image.bytes)], { type: image.mime }), image.name)
  if (input.markup) form.append("markup", new Blob([new Uint8Array(input.markup.bytes)], { type: "image/png" }), input.markup.name)
  return send(`${root}/images/edits`, { ...headers }, form, signal)
}

/** One Codex backend request with a ChatGPT login; the model is the backend's own. */
export function codex(base: string, headers: Readonly<Record<string, string>>, input: Input, signal: AbortSignal) {
  const root = base.replace(/\/+$/, "")
  const body = {
    prompt: input.prompt,
    background: input.background ?? "opaque",
    model: OwnImage.GPT_IMAGE_2,
    quality: input.quality,
    size: input.size,
    ...(input.images.length === 0
      ? {}
      : {
          images: input.images.map((image) => ({
            image_url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`,
          })),
        }),
  }
  const path = input.images.length === 0 ? "images/generations" : "images/edits"
  return send(`${root}/${path}`, { ...headers, "content-type": "application/json" }, JSON.stringify(body), signal)
}

function fields(input: Input) {
  return {
    model: input.model,
    prompt: input.prompt,
    n: 1,
    ...(input.quality === "auto" ? {} : { quality: input.quality }),
    ...(input.size === "auto" ? {} : { size: input.size }),
    ...(input.background === undefined ? {} : { background: input.background }),
    ...(input.complexity === undefined ? {} : { complexity: input.complexity }),
    ...(input.format === undefined ? {} : { output_format: input.format }),
    ...(input.frames === undefined ? {} : { frame_count: input.frames }),
    ...(input.frameMs === undefined ? {} : { frame_duration_ms: input.frameMs }),
    // OpenAI refuses an SVG without its author model ("SVG generation requires 'svg.model'", IM-33). Generations only:
    // the tool refuses an SVG with images, so this never meets the multipart form.
    ...(input.format === "svg" ? { svg: { model: OwnImage.SVG_AUTHOR } } : {}),
  }
}

async function send(url: string, headers: Record<string, string>, body: string | FormData, signal: AbortSignal) {
  const response = await fetch(url, { method: "POST", headers, body, signal }).catch(() => undefined)
  if (!response) return { ok: false as const, failure: "server" as const, status: 0 } satisfies Answer
  const text = await response.text().catch(() => undefined)
  if (!response.ok || text === undefined) {
    const json = text === undefined ? undefined : Option.getOrUndefined(decodeJson(text))
    const error = OwnImage.errorOf(json)
    const retryAfter = Number(response.headers.get("retry-after"))
    return {
      ok: false as const,
      failure: text === undefined ? ("server" as const) : OwnImage.classify(response.status, json),
      status: response.status,
      ...(error.code ?? error.type ? { code: error.code ?? error.type } : {}),
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
      response,
    } satisfies Answer
  }
  const parsed = Option.getOrUndefined(decodeBody(text))
  const b64 = parsed?.data[0]?.b64_json
  if (!parsed || !b64) return { ok: false as const, failure: "refused" as const, status: response.status, code: "no_image", response } satisfies Answer
  return {
    ok: true as const,
    bytes: Buffer.from(b64, "base64"),
    format: parsed.output_format ?? "png",
    ...(parsed.usage ? { usage: parsed.usage } : {}),
    ...(parsed.svg_usage
      ? {
          svgUsage: {
            model: parsed.svg_usage.model ?? "",
            input: parsed.svg_usage.input_tokens ?? 0,
            output: parsed.svg_usage.output_tokens ?? 0,
            ...(parsed.svg_usage.reasoning_tokens === undefined ? {} : { reasoning: parsed.svg_usage.reasoning_tokens }),
            ...(parsed.svg_usage.total_tokens === undefined ? {} : { total: parsed.svg_usage.total_tokens }),
          },
        }
      : {}),
    response,
  } satisfies Answer
}
