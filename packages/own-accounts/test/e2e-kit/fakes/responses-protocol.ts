import {
  answerOf,
  cut,
  estimateTokens,
  isRecord,
  pieces,
  randomId,
  replyHeaders,
  sseResponse,
  timing,
  type AnswerReply,
  type CacheUsage,
  type Reply,
  type StreamedReply,
  type WireMarks,
} from "./shared"

/**
 * Serializes the cacheable part of a Responses request in prompt order (tools, instructions, input
 * items). Byte-identical leading items produce identical prefixes, which is what the cache compares.
 */
export function responsesPrompt(body: ResponsesBody) {
  return [
    JSON.stringify(body.tools ?? []),
    JSON.stringify(body.instructions ?? null),
    ...body.input.map((item) => JSON.stringify(item)),
  ].join("\n")
}

export type ResponsesBody = Record<string, unknown> & { readonly model: string; readonly input: readonly unknown[] }

/** Validates a streamed Responses request body; the error is the 400 message. */
export function responsesBody(json: unknown): { readonly body: ResponsesBody } | { readonly error: string } {
  if (!isRecord(json)) return { error: "Request body must be a JSON object" }
  if (typeof json.model !== "string" || json.model === "") return { error: "Missing required parameter: 'model'" }
  if (!Array.isArray(json.input)) return { error: "Missing required parameter: 'input'" }
  if (json.stream !== true) return { error: "This fake only serves streamed responses ('stream': true)" }
  return { body: { ...json, model: json.model, input: json.input } }
}

/** Builds the Responses stream events (as JSON objects carrying `type`) for one answer or stream error. */
export function responsesEvents(input: {
  readonly reply: AnswerReply | Extract<Reply, { readonly type: "stream-error" }>
  readonly model: string
  readonly usage: CacheUsage
  /** The `service_tier` the response names (02 §4.8): what was served; absent when the request asked for none. */
  readonly serviceTier?: string
  /** The one `response.created` and `response.in_progress` name instead (the Codex backend says `auto` there). */
  readonly createdTier?: string
}): Record<string, unknown>[] {
  const created = {
    id: randomId("resp"),
    object: "response",
    status: "in_progress",
    model: input.model,
    output: [],
    usage: null,
    ...(input.serviceTier === undefined ? {} : { service_tier: input.serviceTier }),
  }
  const opening = input.createdTier === undefined ? created : { ...created, service_tier: input.createdTier }
  const start = [
    { type: "response.created", response: opening },
    { type: "response.in_progress", response: opening },
  ]
  if (input.reply.type === "stream-error")
    return sequenced([
      ...start,
      { type: "response.failed", response: { ...created, status: "failed", error: input.reply.error } },
    ])
  const output = input.reply.type === "text" ? textItem(input.reply.text, input.reply.deltas) : toolItem(input.reply)
  const outputTokens =
    input.reply.type === "text"
      ? (input.reply.outputTokens ?? Math.max(1, estimateTokens(input.reply.text)))
      : Math.max(1, estimateTokens(JSON.stringify(input.reply.input)))
  return sequenced([
    ...start,
    ...output.events,
    {
      type: "response.completed",
      response: {
        ...created,
        status: "completed",
        output: [output.item],
        usage: {
          input_tokens: input.usage.promptTokens,
          input_tokens_details: { cached_tokens: input.usage.cachedTokens, cache_write_tokens: 0 },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: input.usage.promptTokens + outputTokens,
        },
      },
    },
  ])
}

/** Responses events a wire fault counts (text and arguments deltas) and leaves out (`eof`: the end of the response). */
export const RESPONSES_MARKS: WireMarks<Record<string, unknown>> = {
  delta: (event) => String(event.type).endsWith(".delta"),
  terminal: (event) => ["response.completed", "response.failed", "response.incomplete"].includes(String(event.type)),
}

/** The SSE response streaming a reply's Responses events (Codex HTTP, OpenAI Responses), broken by its wire fault. */
export function responsesSse(
  reply: StreamedReply,
  input: {
    readonly model: string
    readonly usage: CacheUsage
    readonly headers: Readonly<Record<string, string>>
    readonly serviceTier?: string
    readonly createdTier?: string
  },
) {
  const plan = cut(
    reply,
    responsesEvents({
      reply: answerOf(reply),
      model: input.model,
      usage: input.usage,
      ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      ...(input.createdTier === undefined ? {} : { createdTier: input.createdTier }),
    }),
    RESPONSES_MARKS,
  )
  return sseResponse(
    plan.events.map((event) => ({ event: String(event.type), data: event })),
    {
      headers: { ...input.headers, ...replyHeaders(reply) },
      ...timing(reply),
      corrupt: plan.corrupt,
      end: plan.end,
      until: plan.until,
    },
  )
}

function sequenced(events: readonly Record<string, unknown>[]) {
  return events.map((event, index) => ({ ...event, sequence_number: index }))
}

function textItem(text: string, deltas?: number) {
  const id = randomId("msg")
  const part = { type: "output_text", text, annotations: [], logprobs: [] }
  const item = { id, type: "message", status: "completed", role: "assistant", content: [part] }
  return {
    item,
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: id,
        output_index: 0,
        content_index: 0,
        part: { ...part, text: "" },
      },
      ...pieces(text, deltas).map((delta) => ({
        type: "response.output_text.delta",
        item_id: id,
        output_index: 0,
        content_index: 0,
        delta,
        logprobs: [],
      })),
      { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text, logprobs: [] },
      { type: "response.content_part.done", item_id: id, output_index: 0, content_index: 0, part },
      { type: "response.output_item.done", output_index: 0, item },
    ],
  }
}

function toolItem(reply: Extract<Reply, { type: "tool-call" }>) {
  if (reply.freeform !== undefined) return customToolItem(reply, reply.freeform)
  const id = randomId("fc")
  const args = JSON.stringify(reply.input)
  const item = {
    id,
    type: "function_call",
    status: "completed",
    call_id: reply.id ?? randomId("call"),
    name: reply.name,
    arguments: args,
  }
  return {
    item,
    events: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: id, output_index: 0, delta: args },
      { type: "response.function_call_arguments.done", item_id: id, output_index: 0, arguments: args },
      { type: "response.output_item.done", output_index: 0, item },
    ],
  }
}

/** A freeform (custom grammar) tool call, as OpenAI streams one: the input text arrives in deltas. */
function customToolItem(reply: Extract<Reply, { type: "tool-call" }>, input: string) {
  const id = randomId("ctc")
  const item = {
    id,
    type: "custom_tool_call",
    status: "completed",
    call_id: reply.id ?? randomId("call"),
    name: reply.name,
    input,
  }
  return {
    item,
    events: [
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: id, output_index: 0, delta: input },
      { type: "response.custom_tool_call_input.done", item_id: id, output_index: 0, input },
      { type: "response.output_item.done", output_index: 0, item },
    ],
  }
}

export function openAIError(status: number, message: string, code: string, type = "invalid_request_error") {
  return { status, body: { error: { message, type, param: null, code } } }
}
