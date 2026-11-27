// Fake speech-to-text services for voice input (02 §3.9): OpenAI `POST /v1/audio/transcriptions` (multipart, plain JSON
// answer as `generate` asks it) and Deepgram `POST /v1/listen` (raw audio body). Like every fake here it records
// credentials only as `hashSecret(value)`; it also keeps the multipart fields (model, language, prompt) and the audio
// size, never the audio. Replies are queued per request; the default is a short Korean sentence.
import { hashSecret } from "./shared"

export type TranscriptionService = "openai" | "deepgram"

export interface TranscriptionCall {
  readonly service: TranscriptionService
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string[]>>
  /** `hashSecret` of the `Authorization` header (`Bearer …` or `Token …`), or undefined when absent. */
  readonly authorization?: string
  readonly contentType: string
  /** Audio bytes received (the multipart `file` or the raw body). */
  readonly audioBytes: number
  /** Multipart text fields (OpenAI); repeated names collected in order. */
  readonly fields: Readonly<Record<string, string[]>>
}

export type TranscriptionReply =
  | { readonly type: "text"; readonly text: string; readonly seconds?: number; readonly language?: string }
  | {
      readonly type: "status"
      readonly status: number
      readonly body?: string
      readonly headers?: Record<string, string>
    }
  | { readonly type: "delay"; readonly ms: number; readonly then?: TranscriptionReply }

export interface FakeTranscription {
  readonly url: string
  /** `endpoints.openai` for own-accounts (`…/v1`). */
  readonly openaiBaseURL: string
  /** `endpoints.deepgram` for own-accounts (the origin; `/v1/listen` is appended). */
  readonly deepgramBaseURL: string
  readonly calls: readonly TranscriptionCall[]
  enqueue(...replies: TranscriptionReply[]): void
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export const FAKE_TRANSCRIPT = "안녕하세요 own-web 받아쓰기 시험입니다"

export function startFakeTranscription(): FakeTranscription {
  const calls: TranscriptionCall[] = []
  const queue: TranscriptionReply[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const service: TranscriptionService | undefined =
        url.pathname === "/v1/audio/transcriptions" ? "openai" : url.pathname === "/v1/listen" ? "deepgram" : undefined
      if (!service || request.method !== "POST") return new Response("not found", { status: 404 })
      const contentType = request.headers.get("content-type") ?? ""
      const authorization = request.headers.get("authorization")
      const fields: Record<string, string[]> = {}
      let audioBytes = 0
      if (service === "openai") {
        const form = await request.formData()
        for (const [name, value] of form.entries())
          if (typeof value === "string") fields[name] = [...(fields[name] ?? []), value]
        const file: unknown = form.get("file")
        audioBytes = file instanceof Blob ? file.size : 0
      } else audioBytes = (await request.arrayBuffer()).byteLength
      const query: Record<string, string[]> = {}
      for (const [name, value] of url.searchParams.entries()) query[name] = [...(query[name] ?? []), value]
      calls.push({
        service,
        method: request.method,
        path: url.pathname,
        query,
        ...(authorization ? { authorization: hashSecret(authorization) } : {}),
        contentType,
        audioBytes,
        fields,
      })
      return answer(service, queue.shift() ?? { type: "text", text: FAKE_TRANSCRIPT, seconds: 2.5 })
    },
  })
  const url = `http://${server.hostname}:${server.port}`
  const stop = () => server.stop(true)
  return {
    url,
    openaiBaseURL: `${url}/v1`,
    deepgramBaseURL: url,
    calls,
    enqueue: (...replies) => void queue.push(...replies),
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

async function answer(service: TranscriptionService, reply: TranscriptionReply): Promise<Response> {
  if (reply.type === "delay") {
    await Bun.sleep(reply.ms)
    return answer(service, reply.then ?? { type: "text", text: FAKE_TRANSCRIPT })
  }
  if (reply.type === "status")
    return new Response(reply.body ?? JSON.stringify({ error: { message: `fake ${reply.status}` } }), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    })
  if (service === "openai")
    return Response.json({
      text: reply.text,
      ...(reply.seconds === undefined ? {} : { usage: { type: "duration", seconds: reply.seconds } }),
    })
  return Response.json({
    metadata: { request_id: "fake-request", ...(reply.seconds === undefined ? {} : { duration: reply.seconds }) },
    results: {
      channels: [
        {
          alternatives: [{ transcript: reply.text }],
          ...(reply.language ? { detected_language: reply.language } : {}),
        },
      ],
    },
  })
}
