// The dictation state machine (03 §4.6 받아쓰기): idle → starting → recording → transcribing → idle, with cancel at
// every step, a hard stop at the length limit, and failures that keep the recording for a retry (resend the same
// audio) until it succeeds or is cancelled. The recorder, the service call and the insertion are passed in, so the
// machine runs under `bun test` without a microphone or a server.
import { createSignal } from "solid-js"
import type { OwnRpc } from "@/data/rpc"
import { OwnRpcError } from "@/data/rpc"
import type { Voice } from "@own/protocol/voice"
import { RecorderError, type Recorder, type RecorderOptions, type RecorderProblem, type Recording } from "./recorder"

/** Every reason the UI explains (`own.voice.problem.<problem>`). */
export type VoiceProblem =
  | RecorderProblem
  | "too_large"
  | "too_long"
  | "encoding"
  | "disabled"
  | "key_missing"
  | Voice.Failure
  | "vault"
  | "scope"
  | "offline"
  | "remote"

/** A failure of the service call, with the message parameters it needs. */
export class DictationFailure extends Error {
  override readonly name = "DictationFailure"
  constructor(
    readonly problem: VoiceProblem,
    readonly params: Readonly<Record<string, number>> = {},
  ) {
    super(problem)
  }
}

export type Phase =
  | { readonly name: "idle" }
  | { readonly name: "starting" }
  | { readonly name: "recording"; readonly startedAt: number }
  | { readonly name: "transcribing" }
  | {
      readonly name: "error"
      readonly problem: VoiceProblem
      readonly params: Readonly<Record<string, number>>
      /** `resend`: the recording is kept and goes again; `record`: retry records anew. */
      readonly retry: "resend" | "record"
    }

/** What happened to the last transcript: in the field, waiting for an IME composition, or nothing heard. */
export type Outcome = "inserted" | "deferred" | "nothing"

export interface DictationDeps {
  readonly start: (options: RecorderOptions) => Promise<Recorder>
  readonly transcribe: (recording: Recording, signal: AbortSignal) => Promise<string>
  readonly insert: (text: string) => "inserted" | "deferred" | "no_target"
  /** The service's length limit in milliseconds. */
  readonly maxMs: () => number
  readonly now?: () => number
}

export function createDictation(deps: DictationDeps) {
  const now = deps.now ?? Date.now
  const [phase, setPhase] = createSignal<Phase>({ name: "idle" })
  const [level, setLevel] = createSignal(0)
  const [outcome, setOutcome] = createSignal<Outcome>()
  let recorder: Recorder | undefined
  /** The last recording; kept after a failed send for `retry`, dropped on success, cancel and dismiss. */
  let held: Recording | undefined
  let abort: AbortController | undefined
  /** Every step checks it is still the current run: cancel and a new start invalidate older ones. */
  let run = 0

  const fail = (error: unknown, retry: "resend" | "record") => {
    setLevel(0)
    if (error instanceof DictationFailure)
      return setPhase({ name: "error", problem: error.problem, params: error.params, retry })
    if (error instanceof RecorderError) return setPhase({ name: "error", problem: error.problem, params: {}, retry })
    setPhase({ name: "error", problem: "failed", params: {}, retry })
  }

  async function start() {
    const current = phase().name
    if (current === "starting" || current === "recording" || current === "transcribing") return
    held = undefined
    setOutcome(undefined)
    const mine = ++run
    setPhase({ name: "starting" })
    const started = await deps
      .start({ maxMs: deps.maxMs(), onLevel: setLevel, onLimit: () => void done(), now })
      .catch((error: unknown) => {
        if (mine === run) fail(error, "record")
        return undefined
      })
    if (!started) return
    if (mine !== run) return started.cancel()
    recorder = started
    setPhase({ name: "recording", startedAt: now() })
  }

  /** Stops the recording and sends it. */
  async function done() {
    const current = recorder
    if (phase().name !== "recording" || !current) return
    recorder = undefined
    const mine = ++run
    setPhase({ name: "transcribing" })
    setLevel(0)
    const recording = await current.stop().catch((error: unknown) => {
      if (mine === run) fail(error, "record")
      return undefined
    })
    if (!recording || mine !== run) return
    held = recording
    await send(mine)
  }

  async function send(mine: number) {
    const recording = held
    if (!recording) return
    abort = new AbortController()
    setPhase({ name: "transcribing" })
    const text = await deps.transcribe(recording, abort.signal).then(
      (value) => value.trim(),
      (error: unknown) => {
        if (mine === run) fail(error, "resend")
        return undefined
      },
    )
    if (text === undefined || mine !== run) return
    held = undefined
    abort = undefined
    setPhase({ name: "idle" })
    if (!text) return setOutcome("nothing")
    setOutcome(deps.insert(text) === "deferred" ? "deferred" : "inserted")
  }

  function cancel() {
    run++
    recorder?.cancel()
    recorder = undefined
    abort?.abort()
    abort = undefined
    held = undefined
    setLevel(0)
    setPhase({ name: "idle" })
  }

  return {
    phase,
    level,
    outcome,
    clearOutcome: () => setOutcome(undefined),
    /** Whether a failed recording waits for `retry`. */
    holding: () => held !== undefined,
    start,
    done,
    cancel,
    retry() {
      const current = phase()
      if (current.name !== "error") return
      if (current.retry === "resend" && held) return void send(++run)
      setPhase({ name: "idle" })
      void start()
    },
    dismiss() {
      held = undefined
      setPhase({ name: "idle" })
    },
    /** The mic button and a tap of the shortcut: start, or finish a running recording. */
    toggle() {
      const current = phase().name
      if (current === "recording") return void done()
      if (current === "idle" || current === "error") void start()
    },
  }
}

export type Dictation = ReturnType<typeof createDictation>

/**
 * `voice.transcribe` on this PC's service: the recording as base64, the length the recorder measured, the hint. A
 * recording over the size limit fails here without being sent.
 */
export async function transcribeOn(
  rpc: OwnRpc,
  recording: Recording,
  input: { readonly maxBytes: number; readonly hint?: string; readonly signal: AbortSignal },
) {
  if (recording.blob.size > input.maxBytes) throw new DictationFailure("too_large", { max: input.maxBytes })
  const audio = await toBase64(recording.blob)
  const hint = input.hint?.trim()
  const output = await rpc
    .call(
      "voice.transcribe",
      { audio, mediaType: recording.mediaType, durationMs: recording.durationMs, ...(hint ? { hint } : {}) },
      { signal: input.signal },
    )
    .catch((error: unknown) => {
      throw failureOf(error)
    })
  return output.text
}

/** An RPC failure as the problem the UI explains (02 §3.9 errors, the client's scope check, a lost connection). */
export function failureOf(error: unknown): DictationFailure {
  if (error instanceof DictationFailure) return error
  // `NotConnectedError` of src/data/server (by name: this module stays out of the server runtime's import graph).
  if (error instanceof Error && error.name === "NotConnectedError") return new DictationFailure("offline")
  if (!(error instanceof OwnRpcError)) return new DictationFailure("network")
  const data = typeof error.data === "object" && error.data !== null ? (error.data as Record<string, unknown>) : {}
  const max: Record<string, number> = typeof data.max === "number" ? { max: data.max } : {}
  const reason = typeof data.reason === "string" ? data.reason : undefined
  if (error.type === "voice_unavailable")
    return new DictationFailure(reason === "disabled" ? "disabled" : "key_missing")
  if (error.type === "voice_audio_invalid")
    return new DictationFailure(
      reason === "too_large" || reason === "too_long" || reason === "encoding" || reason === "empty"
        ? reason
        : "encoding",
      max,
    )
  if (error.type === "voice_failed") return new DictationFailure(isFailure(reason) ? reason : "provider")
  if (error.type === "vault_unavailable") return new DictationFailure("vault")
  if (error.type === "remote_managed") return new DictationFailure("remote")
  if (error.type === "own.scope_denied") return new DictationFailure("scope")
  return new DictationFailure("provider")
}

const FAILURES: ReadonlySet<string> = new Set<Voice.Failure>([
  "auth",
  "rate_limited",
  "quota",
  "rejected",
  "network",
  "timeout",
  "provider",
])

function isFailure(value: string | undefined): value is Voice.Failure {
  return value !== undefined && FAILURES.has(value)
}

/** Base64 of a Blob without a data URL round trip; chunked so a large recording does not overflow the call stack. */
export async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
  return btoa(parts.join(""))
}
