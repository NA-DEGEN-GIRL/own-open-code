// Microphone recording for voice input (03 §4.6 받아쓰기): audio only (`getUserMedia({audio})`, never video), Opus at
// 32 kbit/s where the browser offers it (Chromium/Electron/Android WebView `audio/webm`, Firefox `audio/ogg`, Safari
// `audio/mp4`), a level for the meter from an AnalyserNode, and a hard stop at the service's limit. The recording stays
// in memory until it is sent or dropped; nothing is written anywhere.
import type { Voice } from "@own/protocol/voice"

/** Why recording could not start or finish; each has its own message (strings `own.voice.problem.*`). */
export type RecorderProblem = "denied" | "no_device" | "busy" | "insecure" | "unsupported" | "failed" | "empty"

export class RecorderError extends Error {
  override readonly name = "RecorderError"
  constructor(readonly problem: RecorderProblem) {
    super(problem)
  }
}

export interface Recording {
  readonly blob: Blob
  readonly mediaType: Voice.MediaType
  readonly durationMs: number
}

export interface Recorder {
  /** Stops and returns the recording. */
  stop(): Promise<Recording>
  /** Stops and drops the recording. */
  cancel(): void
}

export interface RecorderOptions {
  readonly maxMs: number
  /** 0–1, about 20 times a second while recording. */
  readonly onLevel?: (level: number) => void
  /** The length limit was reached; the caller stops (and sends) the recording. */
  readonly onLimit?: () => void
  readonly now?: () => number
}

/** Container types in the order they are tried; the first the browser records wins. */
export const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", "audio/mpeg"]

/** The protocol media type of a recorder's MIME type (`audio/webm;codecs=opus` → `audio/webm`). */
export function mediaTypeOf(mime: string): Voice.MediaType | undefined {
  const base = mime.split(";", 1)[0]!.trim().toLowerCase()
  if (base === "audio/webm" || base === "video/webm") return "audio/webm"
  if (base === "audio/ogg") return "audio/ogg"
  if (base === "audio/mp4" || base === "audio/x-m4a" || base === "audio/aac") return "audio/mp4"
  if (base === "audio/mpeg") return "audio/mpeg"
  if (base === "audio/wav" || base === "audio/x-wav" || base === "audio/wave") return "audio/wav"
  return undefined
}

/** A `getUserMedia` rejection as a problem the user can act on. */
export function problemOf(error: unknown): RecorderProblem {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : ""
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied"
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no_device"
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy"
  return "failed"
}

export async function startRecorder(options: RecorderOptions): Promise<Recorder> {
  const now = options.now ?? (() => performance.now())
  if (!navigator.mediaDevices?.getUserMedia)
    throw new RecorderError(globalThis.isSecureContext === false ? "insecure" : "unsupported")
  if (typeof MediaRecorder === "undefined") throw new RecorderError("unsupported")
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    .catch((error: unknown) => {
      throw new RecorderError(problemOf(error))
    })
  const release = () => stream.getTracks().forEach((track) => track.stop())
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type))
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 })
  } catch {
    release()
    throw new RecorderError("unsupported")
  }
  const chunks: Blob[] = []
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  const meter = startMeter(stream, options.onLevel)
  const started = now()
  // Chunks every second, so a recorder that dies late still leaves what it heard.
  recorder.start(1_000)
  const limit = setTimeout(() => options.onLimit?.(), options.maxMs)
  let finished = false
  const finish = () => {
    finished = true
    clearTimeout(limit)
    meter.stop()
  }
  const stopped = new Promise<void>((resolve) => recorder.addEventListener("stop", () => resolve(), { once: true }))
  return {
    async stop() {
      if (finished) throw new RecorderError("failed")
      const durationMs = Math.min(Math.round(now() - started), options.maxMs)
      finish()
      if (recorder.state !== "inactive") recorder.stop()
      await stopped
      release()
      const type = mediaTypeOf(recorder.mimeType || mimeType || chunks[0]?.type || "")
      if (!type) throw new RecorderError("unsupported")
      const blob = new Blob(chunks, { type })
      if (blob.size === 0) throw new RecorderError("empty")
      return { blob, mediaType: type, durationMs }
    },
    cancel() {
      if (finished) return
      finish()
      chunks.length = 0
      if (recorder.state !== "inactive") recorder.stop()
      release()
    },
  }
}

/** RMS of the time-domain signal, scaled so speech fills most of the bar; `stop` closes the AudioContext. */
function startMeter(stream: MediaStream, onLevel: RecorderOptions["onLevel"]) {
  const Context = globalThis.AudioContext
  if (!onLevel || !Context) return { stop: () => {} }
  const context = new Context()
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  context.createMediaStreamSource(stream).connect(analyser)
  const samples = new Uint8Array(analyser.fftSize)
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples)
    const sum = samples.reduce((total, sample) => total + ((sample - 128) / 128) ** 2, 0)
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4))
  }, 50)
  return {
    stop: () => {
      clearInterval(timer)
      onLevel(0)
      void context.close().catch(() => {})
    },
  }
}
