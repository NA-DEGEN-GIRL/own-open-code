export * as Budget from "./budget.js"

import type { SessionContext } from "@opencode/plugin/effect/session"
import type { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { ComputerError } from "./errors.js"

type Message = SessionContext["messages"][number]
type Part = Message["content"][number]

/** File `name` prefix of every screenshot this plugin returns; pruning touches nothing else. */
export const IMAGE_PREFIX = "own-computer-use/"

export interface History {
  /** Screenshots always kept, newest first. */
  readonly keep: number
  /** Older screenshots are removed this many at a time. */
  readonly batch: number
}

/**
 * Replaces all but the newest screenshots of this plugin with a short text, in batches: with N screenshots the oldest
 * `floor((N - keep) / batch) * batch` go. Between batch boundaries the request prefix stays byte-identical, so the
 * provider prompt cache survives all but every `batch`-th screenshot; requests carry between `keep` and
 * `keep + batch - 1` screenshots. Direct results and Code Mode `execute` results (which re-attach inner images with
 * their names) are both covered; user images and other plugins' files are never touched. Idempotent. `messages` is
 * edited in place (core rebuilds plain message copies with `Message.make` after the hooks). Returns how many images
 * were removed.
 */
export function pruneScreenshots(messages: Array<Message>, history: History, prefix = IMAGE_PREFIX) {
  const cutoff = Math.max(0, Math.floor((count(messages, prefix) - history.keep) / history.batch) * history.batch)
  if (cutoff === 0) return 0
  const state = { remaining: cutoff }
  messages.forEach((message, index) => {
    if (state.remaining === 0) return
    const content = message.content.map((part) => {
      if (
        state.remaining === 0 ||
        owned(part, prefix).length === 0 ||
        part.type !== "tool-result" ||
        part.result.type !== "content"
      )
        return part
      return {
        ...part,
        result: {
          ...part.result,
          value: part.result.value.map((item) => {
            if (state.remaining === 0 || !isScreenshot(item, prefix)) return item
            state.remaining -= 1
            return { type: "text" as const, text: placeholder(item.name ?? "") }
          }),
        },
      }
    })
    if (content.some((part, at) => part !== message.content[at])) messages[index] = { ...message, content } as Message
  })
  return cutoff
}

/** How many of this plugin's screenshots `messages` still carry. */
export function count(messages: ReadonlyArray<Message>, prefix = IMAGE_PREFIX) {
  return messages.reduce(
    (total, message) => total + message.content.reduce((sum, part) => sum + owned(part, prefix).length, 0),
    0,
  )
}

export function placeholder(name: string) {
  const id = name.slice(name.lastIndexOf("/") + 1).replace(/\.[a-z]+$/i, "")
  return `[Earlier computer-use screenshot ${id} removed; take a new screenshot if needed.]`
}

function owned(part: Part, prefix: string) {
  if (part.type !== "tool-result" || part.result.type !== "content") return []
  return part.result.value.filter((item) => isScreenshot(item, prefix))
}

function isScreenshot(item: Tool.Content, prefix: string): item is Tool.FileContent {
  return item.type === "file" && item.mime.startsWith("image/") && item.name?.startsWith(prefix) === true
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding ladder

export type Encoding = { readonly format: "png" } | { readonly format: "jpeg"; readonly quality: number }

/** Lossless first (exact text rendering), then JPEG of falling quality until the image fits. */
export const LADDER: ReadonlyArray<Encoding> = [
  { format: "png" },
  { format: "jpeg", quality: 85 },
  { format: "jpeg", quality: 75 },
  { format: "jpeg", quality: 60 },
]

export function ladder(format: "auto" | "png") {
  return format === "png" ? LADDER.slice(0, 1) : LADDER
}

/**
 * What this plugin's images in one model request may take together, counted like core counts them (data URI bytes).
 * Core replaces the oldest images of a request once all of them pass 25 MiB (`IMAGE_BYTES_TRIGGER` in
 * `core/src/session/model-request.ts`); that cut would move with every new screenshot (losing the prompt cache) and
 * leave fewer than `keep`. The 5 MiB below core's trigger are left for the user's own images.
 */
export const REQUEST_BYTES = 20 * 1024 * 1024

/**
 * The base64 limit of one screenshot or zoom: `maxBase64Bytes`, lowered so the most a request carries after pruning
 * (`keep + batch - 1` images, data URI prefix included) stays within {@link REQUEST_BYTES}. About 1.43 MiB with the
 * default history (8, 7); larger images take the JPEG steps of the ladder.
 */
export function imageLimit(maxBase64Bytes: number, history: History) {
  const share = Math.floor(REQUEST_BYTES / (history.keep + history.batch - 1)) - "data:image/jpeg;base64,".length
  return Math.min(maxBase64Bytes, share)
}

export function base64Length(bytes: number) {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Captures with each encoding of the ladder until the base64 form fits `maxBase64Bytes`. Staying under the limit (and
 * under core's 5 MiB) means core passes the image through unchanged. Fails with `image_too_large` otherwise.
 */
export function encodeWithin<C extends { readonly data: Uint8Array }, E, R>(
  input: { readonly format: "auto" | "png"; readonly maxBase64Bytes: number },
  capture: (encoding: Encoding) => Effect.Effect<C, E, R>,
) {
  return Effect.gen(function* () {
    const sizes: Array<number> = []
    for (const encoding of ladder(input.format)) {
      const result = yield* capture(encoding)
      if (base64Length(result.data.byteLength) <= input.maxBase64Bytes) return { capture: result, encoding }
      sizes.push(base64Length(result.data.byteLength))
    }
    return yield* new ComputerError(
      "image_too_large",
      `The screenshot needs ${Math.min(...sizes)} base64 bytes; the limit is ${input.maxBase64Bytes}`,
    )
  })
}
