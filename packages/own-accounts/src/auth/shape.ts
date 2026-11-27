export * as Shape from "./shape.js"

import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Switch } from "@own/protocol"

/**
 * The deterministic request transform of own slots (02 §4.3 D1, D2): the same pure function of (stored history,
 * target Ref, static registry data) for the `context`, `compaction` and `generate` hooks. No time, randomness,
 * attempt number, account label or limit value goes in, so every attempt of a step produces the same bytes.
 */

export type SystemPart = SessionContext["system"][number]
export type Message = SessionContext["messages"][number]
export type Part = Message["content"][number]

/**
 * Request options the Sign in with ChatGPT route rejects with `subscription_sharing_unsupported_capability` (02 §3.2c):
 * the generation fields and Responses options it does not accept (`max_output_tokens`, `temperature`, `top_p`,
 * `top_logprobs`, `metadata`, `safety_identifier`, `truncation`, `max_tool_calls`). `prompt_cache_key` is not an
 * option of this hook and is never touched.
 */
export const SHARING_UNSUPPORTED: ReadonlyArray<string> = [
  "maxTokens",
  "temperature",
  "topP",
  "topLogprobs",
  "metadata",
  "safetyIdentifier",
  "truncation",
  "maxToolCalls",
]

/** Drops {@link SHARING_UNSUPPORTED} from a token-sharing request's options; returns the keys it removed. */
export function stripSharingOptions(options: Record<string, unknown>) {
  const removed = SHARING_UNSUPPORTED.filter((key) => options[key] !== undefined)
  for (const key of SHARING_UNSUPPORTED) delete options[key]
  return removed
}

/**
 * The Sign in with ChatGPT route accepts only some Responses input items (02 §3.2c "입력 항목"): text, image and file
 * messages, item references, compaction summaries, reasoning, `web_search_call`, function and custom tool calls and
 * programmatic tool calling. Anything else answers `subscription_sharing_unsupported_capability` (`param: "input"`).
 *
 * A same-model variant change leaves a per-message effort marker in the history (`core/src/session/runner/
 * to-llm-message.ts` modelSwitched), and OpenAI Responses lowers it to a `configuration_update` item for GPT-6 and later
 * (`ai/src/protocols/open-responses.ts` lowerMessages), which this route refuses. siwc requests drop the markers, so a
 * variant change takes the path of every route without effort updates: `reasoning.effort` is the current variant's
 * (`ai/src/effort-updates.ts` resolveEffortUpdates). A pure function of the history: a history without a variant change
 * keeps its bytes, and every request after one has the same prefix.
 */
export function withoutEffortUpdates(messages: ReadonlyArray<Message>) {
  return messages.filter((message) => !isEffortUpdate(message))
}

/** A per-message effort marker, as `ai/src/effort-updates.ts` `effortUpdate` reads one (not a package export). */
function isEffortUpdate(message: Message) {
  return message.role === "system" && message.content.length === 1 && message.content[0]?.type === "effort"
}

/** Image types Ollama's `/v1/chat/completions` decodes from a data URL (`openai/openai.go` `decodeImageURL`). */
const OLLAMA_IMAGES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"])

/**
 * A compat slot on Ollama (02 §3.3): its OpenAI-compatible API refuses any other image (a GIF), and the stored image
 * would fail every later request of the session. Such an image becomes the note core gives a model that cannot read
 * it, as core does for xAI (`unsupportedMedia`, `core/src/session/model-request.ts`). A pure function of the history:
 * messages without such an image keep their bytes. Returns `messages` itself when nothing changes.
 */
export function ollamaImages(messages: Message[]): Message[] {
  const unreadable = (mime: string) => mime.toLowerCase().startsWith("image/") && !OLLAMA_IMAGES.has(mime.toLowerCase())
  const note = (name: string | undefined, mime: string) =>
    `ERROR: Cannot read ${name ? `"${name}"` : "image"} (this model does not support ${mime} input). Inform the user.`
  const changed = messages.map((message) => {
    const content = message.content.map((part): Part => {
      if (part.type === "media" && unreadable(part.media.mediaType))
        return { type: "text", text: note(part.filename, part.media.mediaType) }
      if (part.type !== "tool-result" || part.result.type !== "content") return part
      const result = part.result
      const value = result.value.map((item) =>
        item.type === "file" && unreadable(item.mime)
          ? { type: "text" as const, text: note(item.name, item.mime) }
          : item,
      )
      return value.every((item, index) => item === result.value[index])
        ? part
        : { ...part, result: { ...result, value } }
    })
    return content.every((part, index) => part === message.content[index]) ? message : rebuild(message, content, false)
  })
  return changed.every((message, index) => message === messages[index]) ? messages : changed
}

/** First line of the built-in Identity block (`core/src/plugin/identity.ts:9-16`). */
export const IDENTITY_HEADER = "# Your Model\n"
const PROVIDER_LINE = "- Provider ID: "

export type IdentityResult = "normalized" | "already" | "missing"

/**
 * D9: rewrites the `- Provider ID:` line of the Identity block to the slot-neutral value (`canonical`), so two slots of
 * one cache domain share the system prefix. The block is found by content, not position, so another plugin that
 * reorders `system` does not change the result. `missing` means the block or its line changed shape (alert
 * `identity_format_changed`); nothing is modified then.
 */
export function normalizeIdentity(system: SystemPart[], providerID: string, canonical: string): IdentityResult {
  const index = system.findIndex((part) => part.text.startsWith(IDENTITY_HEADER))
  const part = system[index]
  if (!part) return "missing"
  const lines = part.text.split("\n")
  const line = lines.indexOf(PROVIDER_LINE + providerID)
  if (line < 0) return lines.includes(PROVIDER_LINE + canonical) ? "already" : "missing"
  system[index] = {
    ...part,
    text: lines.map((item, at) => (at === line ? PROVIDER_LINE + canonical : item)).join("\n"),
  }
  return "normalized"
}

/**
 * Applies the session's strip rules for the target slot (02 §4.4): provider-bound state of every message up to and
 * including `dropBefore` (the newest message of the request that failed) is dropped, the way core already drops it
 * for turns of another provider (`core/src/session/runner/to-llm-message.ts:153-206`): encrypted reasoning and
 * signatures leave readable reasoning text only, `item.id` drops part and message `providerMetadata`. Messages after
 * `dropBefore` (the new credential's turns) are never touched. A rule whose message is no longer in the request (it
 * was compacted away) does nothing. Returns whether anything changed; `messages` is edited in place.
 */
export function applyStrip(messages: Message[], rules: ReadonlyArray<Switch.StripRule>, providerID: string) {
  const cut = Math.max(
    -1,
    ...rules
      .filter((rule) => rule.providerID === providerID)
      .map((rule) => messages.findIndex((message) => message.id === rule.dropBefore)),
  )
  if (cut < 0) return false
  const kinds = new Set(rules.filter((rule) => rule.providerID === providerID).flatMap((rule) => rule.kinds))
  const items = kinds.has("item.id")
  // Reasoning metadata holds the encrypted content, the signature and the item id alike.
  const reasoning = items || kinds.has("reasoning.encrypted") || kinds.has("thinking.signature")
  const changed = messages.slice(0, cut + 1).map((message, index) => {
    const content = message.content.flatMap((part) => stripPart(part, reasoning, items))
    const dropMessage = items && "providerMetadata" in message && message.providerMetadata !== undefined
    if (
      !dropMessage &&
      content.length === message.content.length &&
      content.every((part, at) => part === message.content[at])
    )
      return false
    messages[index] = rebuild(message, content, dropMessage)
    return true
  })
  return changed.some(Boolean)
}

/** The id of the newest message that has one: the `dropBefore` of a rule created from this request's failure. */
export function newestMessageID(messages: ReadonlyArray<Message>) {
  return messages.findLast((message) => message.id !== undefined)?.id
}

/** Error text of provider-bound state from another credential or org (02 §4.4 step 1). */
export const STRIP_PATTERNS: ReadonlyArray<RegExp> = [
  /invalid_encrypted_content/i,
  /could not be verified/i,
  /could not be decrypted/i,
  /organization_id/i,
  /not issued to this caller/i,
  /Invalid signature in thinking block/i,
]

export function stripPattern(text: string) {
  return STRIP_PATTERNS.find((pattern) => pattern.test(text))?.source
}

/** Anthropic breakpoint budget per request (`ai/src/cache-policy.ts:24`). */
export const BREAKPOINT_CAP = 4

/**
 * Manual 5-minute cache hints (02 §4.5): `targets` are message positions `{index, part}`; the tail is added last.
 * Auto policy fills the remaining budget (tools, system) afterwards. Parts that already carry a hint are skipped, and
 * nothing beyond the four-breakpoint budget is added. Returns the number of hints added.
 */
export function addHints(
  system: SystemPart[],
  messages: Message[],
  targets: ReadonlyArray<
    | { readonly type: "system"; readonly index: number }
    | { readonly type: "message"; readonly index: number; readonly part?: number }
  >,
) {
  const budget = { remaining: BREAKPOINT_CAP - countHints(system, messages) }
  return targets.filter((target) => {
    if (budget.remaining <= 0) return false
    if (target.type === "system") {
      const part = system[target.index]
      if (!part || part.cache) return false
      system[target.index] = { ...part, cache: hint() }
      budget.remaining -= 1
      return true
    }
    const message = messages[target.index]
    if (!message || message.content.length === 0) return false
    const at = target.part ?? markIndex(message)
    const part = message.content[at]
    if (!part || ("cache" in part && part.cache)) return false
    messages[target.index] = rebuild(
      message,
      message.content.map((item, index) => (index === at ? ({ ...item, cache: hint() } as Part) : item)),
      false,
    )
    budget.remaining -= 1
    return true
  }).length
}

/** Index of the conversation tail: the last message that is not only a reasoning-effort update. */
export function tailIndex(messages: ReadonlyArray<Message>) {
  return messages.findLastIndex((message) => !message.content.every((part) => part.type === "effort"))
}

/** `markMessageAt` of the core cache policy: the last text part, else the last part (`cache-policy.ts:90-112`). */
function markIndex(message: Message) {
  const text = message.content.findLastIndex((part) => part.type === "text")
  return text >= 0 ? text : message.content.length - 1
}

function countHints(system: ReadonlyArray<SystemPart>, messages: ReadonlyArray<Message>) {
  return (
    system.filter((part) => part.cache !== undefined).length +
    messages.reduce(
      (count, message) => count + message.content.filter((part) => "cache" in part && part.cache).length,
      0,
    )
  )
}

function stripPart(part: Part, reasoning: boolean, items: boolean): Part[] {
  if (part.type === "reasoning" && reasoning && (part.providerMetadata !== undefined || part.encrypted !== undefined)) {
    if (part.text.length === 0) return []
    return [{ type: "reasoning", text: part.text, ...(part.cache ? { cache: part.cache } : {}) }]
  }
  if (
    items &&
    (part.type === "text" || part.type === "tool-call" || part.type === "tool-result") &&
    part.providerMetadata !== undefined
  ) {
    const { providerMetadata: _dropped, ...rest } = part
    return [rest]
  }
  return [part]
}

/** A plain copy of `message` with new content. Core re-makes every hook message (`Message.make` in `model-request.ts`). */
function rebuild(message: Message, content: Part[], dropMetadata: boolean): Message {
  // Only user and assistant messages carry provider metadata since @opencode/ai split Message by role (v2.2.6).
  const providerMetadata = "providerMetadata" in message ? message.providerMetadata : undefined
  // SAFETY: each role's message is a schema class whose instance type is its fields; core turns this plain copy back
  // into a `Message` with `Message.make` right after the hooks (`unsupportedParts`, `core/src/session/model-request.ts`).
  return {
    ...(message.id === undefined ? {} : { id: message.id }),
    role: message.role,
    ...(dropMetadata || providerMetadata === undefined ? {} : { providerMetadata }),
    content,
  } as Message
}

// The core lowering turns a plain `{type}` into its `CacheHint` class when the request is built (schema class fields).
function hint() {
  // SAFETY: structurally a 5-minute `CacheHint` (no `ttlSeconds`); decoded into the class by `Message.make`/`LLM.request`.
  return { type: "ephemeral" } as NonNullable<SystemPart["cache"]>
}
