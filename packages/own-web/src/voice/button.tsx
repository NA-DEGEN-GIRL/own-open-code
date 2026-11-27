// The dictation control (03 §4.6 받아쓰기, §19.10 notes): one component for the composer and both note editors. A mic
// button while idle; while recording the elapsed time, a level meter, [취소] and [완료]; while the service works a
// spinner and [취소]; on failure the reason, [다시 시도] (the same recording again) and [닫기]. The transcript goes into
// `target` at its cursor (`createInserter`: after a running IME composition), never sent. Shown only when voice input
// is on, the selected service has its key and the connection may spend minutes (`prompt`); the recognition runs on
// this PC's service with its voice key, never in the page.
//
// Push to talk: the `voice.dictate` shortcut (default Ctrl+Alt+V) records while held and transcribes on release; a short
// press starts and the next press finishes. The control whose field has focus takes the key; the composer's control
// (`shortcut: "default"`) takes it when no other dictation field is focused.
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useData } from "@/data"
import { chordLabel, useShortcut } from "@/keyboard"
import { effectiveKeymap } from "@/palette/keymap-store"
import { createDictation, transcribeOn, type Phase } from "./controller"
import { buildHint } from "./hint"
import { createInserter, type TextTarget } from "./insert"
import { startRecorder } from "./recorder"
import { loadVoice, voiceReady, voiceView } from "./store"
import { useVoiceText, type VoiceKey } from "./strings"
import "./voice.css"

export interface DictationButtonProps {
  /** The field the transcript goes into. */
  readonly target: () => TextTarget | undefined
  /** Technical words for the service; default: identifiers in the field's own text. */
  readonly hint?: () => string | Promise<string>
  /** `default`: takes the shortcut when no other dictation field has focus (the composer). */
  readonly shortcut?: "default" | "focus"
  readonly disabled?: () => boolean
  readonly testid?: string
}

/** Fields of mounted controls, so the default control leaves the shortcut to a focused note. */
const fields = new Set<() => TextTarget | undefined>()
/** A key released this soon after it started a recording was a tap: the recording keeps going until the next press. */
const TAP_MS = 400

export function DictationButton(props: DictationButtonProps) {
  const data = useData()
  const text = useVoiceText()
  const rpc = () => data.local().own.rpc
  const ready = () => voiceReady(voiceView(), rpc()) && !props.disabled?.()
  const inserter = createInserter(props.target)
  const dictation = createDictation({
    start: (options) => startRecorder(options),
    maxMs: () => (voiceView()?.limits.maxSeconds ?? 180) * 1000,
    insert: (value) => inserter.insert(value),
    transcribe: async (recording, signal) =>
      transcribeOn(rpc(), recording, {
        maxBytes: voiceView()?.limits.maxAudioBytes ?? recording.blob.size,
        // A hint is only help: a failing one never holds the recognition back.
        hint: await Promise.resolve()
          .then(() => props.hint?.() ?? buildHint({ names: [], texts: [props.target()?.value ?? ""] }))
          .catch(() => ""),
        signal,
      }),
  })
  const [elapsed, setElapsed] = createSignal(0)

  onMount(() => {
    fields.add(props.target)
    inserter.watch()
    void loadVoice(rpc())
    const visible = () => document.visibilityState === "visible" && void loadVoice(rpc())
    document.addEventListener("visibilitychange", visible)
    onCleanup(() => document.removeEventListener("visibilitychange", visible))
  })
  onCleanup(() => {
    fields.delete(props.target)
    dictation.cancel()
    inserter.dispose()
  })

  // The clock of the recording bar.
  createEffect(() => {
    const current = dictation.phase()
    if (current.name !== "recording") return setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - current.startedAt), 250)
    onCleanup(() => clearInterval(timer))
  })
  // "넣었습니다" and the like stay for a moment.
  createEffect(() => {
    if (!dictation.outcome()) return
    const timer = setTimeout(() => dictation.clearOutcome(), 2_500)
    onCleanup(() => clearTimeout(timer))
  })

  const focused = () => {
    const active = document.activeElement
    return !!active && active === props.target()
  }
  const otherFocused = () => [...fields].some((field) => field !== props.target && field() === document.activeElement)
  useShortcut(
    "voice.dictate",
    (event) => {
      if ("repeat" in event && event.repeat) return
      const current = dictation.phase().name
      if (current === "recording") return void dictation.done()
      if (current !== "idle" && current !== "error") return
      void dictation.start()
      const pressed = Date.now()
      const code = event.code
      const release = (up: KeyboardEvent) => {
        if (up.code !== code && !/^(Control|Alt|Meta|Shift)/.test(up.code)) return
        window.removeEventListener("keyup", release, true)
        // Held: push to talk ends with the key. Tapped: the recording goes on until the next press.
        if (Date.now() - pressed >= TAP_MS) void dictation.done()
      }
      window.addEventListener("keyup", release, true)
    },
    { when: () => ready() && (props.shortcut === "default" ? !otherFocused() : focused()) },
  )

  const keys = () =>
    effectiveKeymap()
      ["voice.dictate"].chords.map((chord) => chordLabel(chord))
      .join(", ") || "—"
  const clock = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }
  const problem = (current: Extract<Phase, { name: "error" }>) => {
    const max = current.params.max
    const params =
      max === undefined
        ? undefined
        : { max: current.problem === "too_long" ? clock(max * 1000) : `${Math.round(max / 1024 / 1024)} MB` }
    return text(`own.voice.problem.${current.problem}` as VoiceKey, params)
  }
  const failed = () => {
    const current = dictation.phase()
    return current.name === "error" ? current : undefined
  }

  return (
    <Show when={ready() || dictation.phase().name !== "idle"}>
      <span class="own-vc" data-testid={props.testid ?? "voice"} data-phase={dictation.phase().name}>
        <Show when={dictation.phase().name === "idle" || dictation.phase().name === "starting"}>
          <button
            type="button"
            class="own-vc-mic"
            data-testid="voice-start"
            aria-label={text("own.voice.button")}
            title={text("own.voice.buttonHint", { keys: keys() })}
            disabled={dictation.phase().name === "starting"}
            // Keep the field's selection: the transcript goes where the cursor was.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => dictation.toggle()}
          >
            <MicIcon />
          </button>
        </Show>
        <Show when={dictation.phase().name === "recording"}>
          <span class="own-vc-live" role="group" aria-label={text("own.voice.recording")}>
            <span class="own-vc-dot" aria-hidden="true" />
            <span class="own-vc-time" aria-live="off">
              {text("own.voice.elapsed", {
                time: clock(elapsed()),
                max: clock((voiceView()?.limits.maxSeconds ?? 180) * 1000),
              })}
            </span>
            <span
              class="own-vc-meter"
              role="meter"
              aria-label={text("own.voice.level")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(dictation.level() * 100)}
            >
              <span style={{ width: `${Math.round(dictation.level() * 100)}%` }} />
            </span>
            <button
              type="button"
              class="own-vc-btn"
              data-testid="voice-cancel"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => dictation.cancel()}
            >
              {text("own.voice.cancel")}
            </button>
            <button
              type="button"
              class="own-vc-btn"
              data-variant="primary"
              data-testid="voice-done"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void dictation.done()}
            >
              {text("own.voice.done")}
            </button>
          </span>
        </Show>
        <Show when={dictation.phase().name === "transcribing"}>
          <span class="own-vc-live" role="status">
            <span class="own-vc-spin" aria-hidden="true" />
            <span>{text("own.voice.transcribing")}</span>
            <button type="button" class="own-vc-btn" data-testid="voice-cancel" onClick={() => dictation.cancel()}>
              {text("own.voice.cancel")}
            </button>
          </span>
        </Show>
        <Show when={failed()}>
          {(current) => (
            <span class="own-vc-live own-vc-error">
              <span role="alert" data-testid="voice-error" data-problem={current().problem}>
                {problem(current())}
              </span>
              <button
                type="button"
                class="own-vc-btn"
                data-testid="voice-retry"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => dictation.retry()}
              >
                {text("own.voice.retry")}
              </button>
              <button
                type="button"
                class="own-vc-btn"
                aria-label={text("own.voice.dismiss")}
                data-testid="voice-dismiss"
                onClick={() => dictation.dismiss()}
              >
                ×
              </button>
            </span>
          )}
        </Show>
        <Show when={dictation.outcome()}>
          {(outcome) => (
            <span class="own-vc-note" role="status" data-testid="voice-outcome">
              {text(
                outcome() === "deferred"
                  ? "own.voice.waitingIme"
                  : outcome() === "nothing"
                    ? "own.voice.nothing"
                    : "own.voice.inserted",
              )}
            </span>
          )}
        </Show>
      </span>
    </Show>
  )
}

function MicIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    >
      <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
      <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" stroke-linecap="round" />
    </svg>
  )
}
