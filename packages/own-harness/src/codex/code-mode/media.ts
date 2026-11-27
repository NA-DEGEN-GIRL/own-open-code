// Ports the `image`, `audio`, and `generatedImage` output normalization of codex-rs/code-mode-runtime/src/runtime/
// value.rs and callbacks.rs, the PCM WAV duration probe of runtime/audio.rs, and the duration-based estimate of
// codex-rs/utils/audio (`estimate_audio_token_count`, WAV only here). Errors are thrown as plain strings, as Codex's
// `throw_type_error` does, so a program `catch (e)` receives the message itself.
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1.
export * as CodeModeMedia from "./media.js"

import { Buffer } from "node:buffer"
import { Truncate } from "../truncate/index.js"

export type ImageDetail = "auto" | "low" | "high" | "original"

export type MediaItem =
  | { type: "text"; text: string }
  /** `name` (own): the file name an image a kept plugin tool returned had, so that plugin's hooks still find it. */
  | { type: "image"; image_url: string; detail?: ImageDetail; name?: string }
  | { type: "audio"; audio_url: string }

/**
 * What the program-side helper observed about its argument, read in the interpreter so property access follows
 * program semantics: a string, a non-array object (its URL field, `detail` field, and `JSON.stringify` form), or
 * anything else.
 */
export type Media =
  | { readonly kind: "string"; readonly value: string }
  | {
      readonly kind: "object"
      readonly fieldType: string
      readonly field?: string
      readonly detailType: string
      readonly detail?: string
      readonly json?: string
    }
  | { readonly kind: "other" }

export const DEFAULT_IMAGE_DETAIL: ImageDetail = "high"

const IMAGE_HELPER_EXPECTS_MESSAGE =
  "image expects a non-empty image URL string, an object with image_url and optional detail, or a raw MCP image block"
const AUDIO_HELPER_EXPECTS_MESSAGE =
  "audio expects a non-empty audio URL string, an object with audio_url, or a raw MCP audio block"
const REMOTE_IMAGE_URL_ERROR =
  "Tool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead"
const INVALID_IMAGE_URL_ERROR = "Tool call failed: invalid image output. Pass a base64 data URI instead"
const INVALID_AUDIO_URL_ERROR = "Tool call failed: invalid audio output. Pass a base64 data URI instead"
const CODEX_IMAGE_DETAIL_META_KEY = "codex/imageDetail"
const DETAILS: ReadonlyArray<string> = ["auto", "low", "high", "original"]
const MAX_PROMPT_AUDIO_INPUT_BYTES = 50 * 1024 * 1024
const AUDIO_TOKENS_PER_SECOND = 10

/** `normalize_output_image`: `detailOverride` is the helper's second argument, already checked to be a string. */
export function image(media: Media, detailOverride: string | undefined): MediaItem {
  const [imageUrl, embedded] = imageSource(media)
  if (imageUrl === "") throw IMAGE_HELPER_EXPECTS_MESSAGE
  const scheme = urlScheme(imageUrl)
  if (scheme === undefined) throw INVALID_IMAGE_URL_ERROR
  if (scheme === "http" || scheme === "https") throw REMOTE_IMAGE_URL_ERROR
  if (scheme !== "data") throw INVALID_IMAGE_URL_ERROR
  const detail = (detailOverride ?? embedded)?.toLowerCase() ?? DEFAULT_IMAGE_DETAIL
  if (!DETAILS.includes(detail)) throw "image detail must be one of: auto, low, high, original"
  return { type: "image", image_url: imageUrl, detail: detail as ImageDetail }
}

/** `normalize_output_audio`, including the replacement text for PCM WAV clips shorter than 25 ms. */
export function audio(media: Media): MediaItem {
  const audioUrl = audioSource(media)
  if (audioUrl === "") throw AUDIO_HELPER_EXPECTS_MESSAGE
  if (urlScheme(audioUrl) !== "data") throw INVALID_AUDIO_URL_ERROR
  // Tiny tool-generated clips cannot be encoded reliably by audio models.
  const duration = wavDurationSeconds(audioUrl)
  if (duration !== undefined && duration < 0.025) {
    return { type: "text", text: "Audio output omitted because the clip is shorter than 25 ms; use a longer clip." }
  }
  return { type: "audio", audio_url: audioUrl }
}

/** `generated_image_callback`: the image item, then the optional `output_hint` as a text item. */
export function generatedImage(
  isObject: boolean,
  hintType: string,
  hint: string | undefined,
  media: Media,
): ReadonlyArray<MediaItem> {
  if (!isObject) throw "generatedImage expects an image generation result object"
  if (hintType !== "undefined" && hint === undefined) throw "generatedImage output_hint must be a string when provided"
  const item = image(media, undefined)
  return hint === undefined ? [item] : [item, { type: "text", text: hint }]
}

/** `estimate_audio_token_count`: ten tokens per second of PCM WAV audio, else the URL's approximate token count. */
export function estimateAudioTokenCount(audioUrl: string) {
  const duration = wavDurationSeconds(audioUrl)
  return duration === undefined ? Truncate.approxTokenCount(audioUrl) : Math.ceil(duration * AUDIO_TOKENS_PER_SECOND)
}

function imageSource(media: Media): [string, string | undefined] {
  if (media.kind === "string") return [media.value, undefined]
  if (media.kind === "other") throw IMAGE_HELPER_EXPECTS_MESSAGE
  if (media.fieldType !== "undefined") {
    if (media.field === undefined) throw IMAGE_HELPER_EXPECTS_MESSAGE
    if (media.detailType === "undefined" || media.detailType === "null") return [media.field, undefined]
    if (media.detail === undefined) throw "image detail must be a string when provided"
    return [media.field, media.detail]
  }
  const block = mcpBlock(media.json, "image", IMAGE_HELPER_EXPECTS_MESSAGE)
  const meta = block._meta
  const detail =
    typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)[CODEX_IMAGE_DETAIL_META_KEY]
      : undefined
  return [mcpDataUrl(block, "image"), typeof detail === "string" && DETAILS.includes(detail) ? detail : undefined]
}

function audioSource(media: Media) {
  if (media.kind === "string") return media.value
  if (media.kind === "other") throw AUDIO_HELPER_EXPECTS_MESSAGE
  if (media.fieldType !== "undefined") {
    if (media.field === undefined) throw AUDIO_HELPER_EXPECTS_MESSAGE
    return media.field
  }
  return mcpDataUrl(mcpBlock(media.json, "audio", AUDIO_HELPER_EXPECTS_MESSAGE), "audio")
}

function mcpBlock(json: string | undefined, kind: "image" | "audio", expects: string) {
  const block: unknown = json === undefined ? undefined : JSON.parse(json)
  if (typeof block !== "object" || block === null || Array.isArray(block)) throw expects
  const fields = block as Record<string, unknown>
  if (typeof fields.type !== "string") throw expects
  if (fields.type !== kind) throw `${kind} only accepts MCP ${kind} blocks, got "${fields.type}"`
  return fields
}

function mcpDataUrl(block: Record<string, unknown>, kind: "image" | "audio") {
  const data = block.data
  if (typeof data !== "string" || data === "") throw `${kind} expected MCP ${kind} data`
  if (data.toLowerCase().startsWith("data:")) return data
  const mimeType = [block.mimeType, block.mime_type].find((value) => value !== undefined)
  return `data:${typeof mimeType === "string" && mimeType !== "" ? mimeType : "application/octet-stream"};base64,${data}`
}

/** The lower-cased text before the first `:`, or `undefined` without one. */
function urlScheme(url: string) {
  const colon = url.indexOf(":")
  return colon === -1 ? undefined : url.slice(0, colon).toLowerCase()
}

/** `wav_duration_seconds`: the playing time of a base64 PCM or float WAV data URL, or `undefined` for anything else. */
export function wavDurationSeconds(audioUrl: string): number | undefined {
  const comma = audioUrl.indexOf(",")
  if (comma === -1) return undefined
  const base64 = audioUrl
    .slice(0, comma)
    .split(";")
    .slice(1)
    .some((part) => part.toLowerCase() === "base64")
  const payload = audioUrl.slice(comma + 1)
  if (!base64 || payload.length > Math.ceil(MAX_PROMPT_AUDIO_INPUT_BYTES / 3) * 4) return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) return undefined
  const bytes = Buffer.from(payload, "base64")
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") {
    return undefined
  }
  return wavChunks(bytes, 12, undefined)
}

function wavChunks(
  bytes: Buffer,
  offset: number,
  format: { sampleRate: number; blockAlign: number } | undefined,
): number | undefined {
  if (bytes.length - offset < 8) return undefined
  const id = bytes.toString("latin1", offset, offset + 4)
  const size = bytes.readUInt32LE(offset + 4)
  // Streaming WAV headers can declare more data than the file contains.
  const chunk = bytes.subarray(offset + 8, Math.min(offset + 8 + size, bytes.length))
  if (id === "data")
    return format === undefined ? undefined : Math.floor(chunk.length / format.blockAlign) / format.sampleRate
  const next = id === "fmt " ? wavFormat(chunk) : format
  if (id === "fmt " && next === undefined) return undefined
  const nextOffset = offset + 8 + size + (size % 2)
  if (nextOffset > bytes.length) return undefined
  return wavChunks(bytes, nextOffset, next)
}

const PCM_SUBTYPE_TAIL = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]

function wavFormat(chunk: Buffer) {
  if (chunk.length < 14) return undefined
  const declared = chunk.readUInt16LE(0)
  // WAVE_FORMAT_EXTENSIBLE stores the encoding in a subtype GUID.
  const extensible = declared === 0xfffe
  if (extensible && (chunk.length < 40 || !PCM_SUBTYPE_TAIL.every((byte, index) => chunk[26 + index] === byte))) {
    return undefined
  }
  const encoding = extensible ? chunk.readUInt16LE(24) : declared
  if (encoding !== 1 && encoding !== 3) return undefined
  const sampleRate = chunk.readUInt32LE(4)
  const blockAlign = chunk.readUInt16LE(12)
  if (sampleRate === 0 || blockAlign === 0) return undefined
  return { sampleRate, blockAlign }
}
