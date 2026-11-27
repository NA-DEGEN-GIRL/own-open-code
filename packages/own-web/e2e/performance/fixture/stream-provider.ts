// Paced OpenAI Responses fake for the streaming benchmarks (03 §20.1 PF4: "초당 200 delta 스트리밍"). The e2e-kit
// fake sends a whole answer as one delta; this one splits it into N `response.output_text.delta` events delivered at
// a fixed rate (several per tick when the timer is coarse, so the average rate holds on Windows).
//
// Only loopback. Fake credentials only: any non-empty Bearer key is accepted and never recorded.
// Control (bench only): `POST /__bench/stream {marker, deltas, rate, startMarker, doneMarker}` arms the next model request whose
// input contains `marker`; `GET /__bench/state` reports progress. Other model requests get a one-word answer.
import { streamFragments } from "./history"

export interface StreamPlan {
  /** Text that identifies the prompt this plan answers (the bench puts it in the prompt). */
  readonly marker: string
  readonly deltas: number
  /** Deltas per second. */
  readonly rate: number
  readonly startMarker: string
  readonly doneMarker: string
  /** Fixture tag whose markers the answer repeats in every section (`streamFragments`). */
  readonly tag?: string
}

export interface StreamRecord {
  readonly marker: string
  readonly deltas: number
  readonly rate: number
  sent: number
  startedAt?: number
  finishedAt?: number
}

export function startStreamProvider(options: { readonly models: readonly string[] }) {
  const plans: StreamPlan[] = []
  const streams: StreamRecord[] = []
  const counters = { requests: 0, modelRequests: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      counters.requests++
      const url = new URL(request.url)
      if (url.pathname === "/__bench/stream" && request.method === "POST") {
        const plan = (await request.json()) as StreamPlan
        plans.push(plan)
        return Response.json({ ok: true })
      }
      if (url.pathname === "/__bench/state") return Response.json({ ...counters, pending: plans.length, streams })
      if (!/^Bearer \S+/.test(request.headers.get("authorization") ?? ""))
        return Response.json(
          { error: { message: "Incorrect API key provided.", type: "invalid_request_error" } },
          { status: 401 },
        )
      if (request.method === "GET" && url.pathname === "/v1/models")
        return Response.json({
          object: "list",
          data: options.models.map((id) => ({ id, object: "model", owned_by: "fake" })),
        })
      if (request.method !== "POST" || url.pathname !== "/v1/responses")
        return Response.json({ error: { message: "Not found", type: "invalid_request_error" } }, { status: 404 })
      counters.modelRequests++
      const body = await request.text()
      const model = (JSON.parse(body) as { model?: string }).model ?? options.models[0]!
      const index = plans.findIndex((plan) => body.includes(plan.marker))
      const plan = index >= 0 ? plans.splice(index, 1)[0] : undefined
      if (!plan) return respond(model, ["ok"], undefined)
      const record: StreamRecord = { marker: plan.marker, deltas: plan.deltas, rate: plan.rate, sent: 0 }
      streams.push(record)
      return respond(model, streamFragments(plan.deltas, plan.startMarker, plan.doneMarker, plan.tag), record)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}

function respond(model: string, fragments: readonly string[], record: StreamRecord | undefined) {
  const encoder = new TextEncoder()
  const id = `msg_fake_${Date.now().toString(36)}`
  const text = fragments.join("")
  const created = { id: `resp_${id}`, object: "response", status: "in_progress", model, output: [], usage: null }
  const part = { type: "output_text", text, annotations: [], logprobs: [] }
  const item = { id, type: "message", status: "completed", role: "assistant", content: [part] }
  const sequence = { value: 0 }
  const frame = (event: Record<string, unknown>) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence.value++ })}\n\n`
  const head = [
    { type: "response.created", response: created },
    { type: "response.in_progress", response: created },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    {
      type: "response.content_part.added",
      item_id: id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: "" },
    },
  ]
  const tail = [
    { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text, logprobs: [] },
    { type: "response.content_part.done", item_id: id, output_index: 0, content_index: 0, part },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...created,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 2_000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: Math.max(1, Math.ceil(text.length / 4)),
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2_000 + Math.ceil(text.length / 4),
        },
      },
    },
  ]
  const delta = (value: string) =>
    frame({
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: value,
      logprobs: [],
    })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(head.map(frame).join("")))
      const started = performance.now()
      if (record) record.startedAt = Date.now()
      let sent = 0
      while (sent < fragments.length) {
        // Deliver whatever is due by now; a coarse timer sends several deltas per tick at the same average rate.
        const due = record
          ? Math.min(fragments.length, Math.floor(((performance.now() - started) * record.rate) / 1000) + 1)
          : fragments.length
        if (due > sent) {
          controller.enqueue(encoder.encode(fragments.slice(sent, due).map(delta).join("")))
          sent = due
          if (record) record.sent = sent
        }
        if (sent < fragments.length) await Bun.sleep(4)
      }
      controller.enqueue(encoder.encode(tail.map(frame).join("")))
      if (record) record.finishedAt = Date.now()
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-request-id": id },
  })
}
