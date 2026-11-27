// The update card (05 §20.4, UPD): asks `tools.update.plan` when it opens and shows exactly what will run (the command,
// the program's path) and where the command comes from, runs it only on `실행`, then shows its output as it comes
// (`tools.update.status` from the last length, every 400 ms) and the version read again at the end. A start Windows
// refused (Smart App Control) is shown as such with the official page; nothing is retried.
//
// While it runs (UCP 2026-11-08) the card shows the time since the start and, for Claude Code's native updater, the
// size of the download so far (it prints nothing while it downloads, which looked stuck); no total is guessed. The
// update belongs to the service: closing the card leaves it running, and opening the card again (설정 > 업데이트 or the
// conversation's notice) follows it from its start. After ten minutes it says how to tell a download still moves; own
// stops it only after an hour and says so.
import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { ToolUpdates } from "@own/protocol/tool-updates"
import { errorData, errorType } from "@/accounts/errors"
import type { ServerRuntime } from "@/data"
import { useHost } from "@/host"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { TOOL_NAMES, useToolUpdatesText, type ToolUpdatesText } from "./strings"

const POLL_MS = 400

export function UpdateDialog(props: {
  readonly runtime: ServerRuntime
  readonly component: ToolUpdates.Component
  readonly onClose: () => void
  /** After the job ended (the page reads the versions again). */
  readonly onEnded?: () => void
}) {
  const text = useToolUpdatesText()
  const host = useHost()
  const call = props.runtime.rpc.call
  const name = TOOL_NAMES[props.component]
  const [plan] = createResource(() => call("tools.update.plan", { component: props.component }))
  // Reading an errored resource throws (Solid): the card reads the plan only once it arrived.
  const ready = () => (plan.state === "ready" ? plan() : undefined)
  const [job, setJob] = createSignal<ToolUpdates.Job>()
  const [output, setOutput] = createSignal("")
  const [failure, setFailure] = createSignal<string>()
  const [starting, setStarting] = createSignal(false)
  const [attached, setAttached] = createSignal(false)
  const state = { timer: undefined as ReturnType<typeof setTimeout> | undefined, closed: false }
  onCleanup(() => {
    state.closed = true
    clearTimeout(state.timer)
  })

  const follow = (current: ToolUpdates.Job) => {
    setJob(current)
    setOutput((before) => before + current.output)
    if (current.state !== "running") return props.onEnded?.()
    state.timer = setTimeout(() => {
      if (state.closed) return
      void call("tools.update.status", { id: current.id, from: current.length }).then(follow, (error: unknown) =>
        setFailure(
          // The service restarted: the job lived in its memory (the updater itself was not stopped by the window).
          errorType(error) === "tool_job_not_found"
            ? text("own.upd.error.lost")
            : text("own.upd.error.status", { error: String(error) }),
        ),
      )
    }, POLL_MS)
  }

  const run = async () => {
    const current = ready()
    if (!current || starting()) return
    setStarting(true)
    setFailure(undefined)
    const started = await call("tools.update.execute", { nonce: current.nonce }).catch((error: unknown) => {
      const type = errorType(error)
      setFailure(
        type === "tool_busy"
          ? text("own.upd.error.busy")
          : type === "nonce_invalid"
            ? text("own.upd.error.expired")
            : text("own.upd.error.other", { error: String(error) }),
      )
      return undefined
    })
    setStarting(false)
    if (started) follow(started)
  }

  // An update of this program already runs (the card was closed while it ran): follow it instead of planning another.
  const attach = async (id: string) => {
    const current = await call("tools.update.status", { id, from: 0 }).catch(() => undefined)
    if (!current || current.component !== props.component || state.closed) return
    setAttached(true)
    follow(current)
  }
  createEffect(() => {
    const id = errorType(plan.error) === "tool_busy" ? errorData<{ id: string }>(plan.error).id : undefined
    if (id) void attach(id)
  })

  const planError = () => {
    const error = plan.error as unknown
    if (!error || job()) return undefined
    const type = errorType(error)
    if (type === "tool_busy") return text("own.upd.error.busy")
    if (type === "tool_not_updatable") return text("own.upd.error.manual")
    return text("own.upd.error.other", { error: String(error) })
  }
  const ended = () => {
    const current = job()
    return current && current.state !== "running" ? current : undefined
  }

  return (
    <Dialog
      open
      title={text("own.upd.confirm.title", { name })}
      onClose={props.onClose}
      testid="tool-update-dialog"
      footer={
        <>
          <button type="button" class="own-btn" data-testid="tool-update-cancel" onClick={props.onClose}>
            {text(job() ? "own.upd.confirm.close" : "own.upd.confirm.cancel")}
          </button>
          <Show when={!job()}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              data-testid="tool-update-run"
              disabled={!ready() || starting()}
              onClick={() => void run()}
            >
              {text("own.upd.confirm.run")}
            </button>
          </Show>
        </>
      }
    >
      <div class="flex flex-col gap-2.5 text-[13px]">
        <Show when={plan.loading}>
          <p class="m-0 flex items-center gap-2 text-own-muted">
            <Spinner /> {text("own.upd.loading")}
          </p>
        </Show>
        <Show when={planError()}>{(message) => <Notice tone="danger">{message()}</Notice>}</Show>
        <Show when={ready()}>
          {(current) => (
            <>
              <p class="m-0">{text("own.upd.confirm.lead")}</p>
              <Show when={current().installed && current().latest && current().installed !== current().latest}>
                <p class="m-0 text-own-muted" data-testid="tool-update-versions">
                  {text("own.upd.confirm.versions", { installed: current().installed!, latest: current().latest! })}
                </p>
              </Show>
              <code
                class="block rounded-md border border-own-border px-2.5 py-2 font-mono text-[13px]"
                data-testid="tool-update-command"
              >
                {current().command}
              </code>
              <p class="m-0 break-all text-[12px] text-own-muted" data-testid="tool-update-argv">
                {current().argv.join(" ")}
              </p>
              <p class="m-0 text-[12px]">
                {text("own.upd.source")}:{" "}
                <button
                  type="button"
                  class="own-target border-0 bg-transparent p-0 text-own-accent-text underline"
                  data-testid="tool-update-source"
                  onClick={() => host.openExternal(current().source)}
                >
                  {current().source}
                </button>
              </p>
            </>
          )}
        </Show>
        <Show when={failure()}>{(message) => <Notice tone="danger">{message()}</Notice>}</Show>
        <Show when={job()}>
          {(current) => (
            <div class="flex flex-col gap-1.5" data-testid="tool-update-job" data-state={current().state}>
              <Show when={attached()}>
                <p class="m-0" data-testid="tool-update-attached">
                  {text("own.upd.job.attached")} <code class="font-mono">{current().command}</code>
                </p>
              </Show>
              <Show when={current().state === "running"}>
                <Progress job={current()} />
              </Show>
              <Show when={ended()}>
                {(done) => (
                  <>
                    <JobResult job={done()} />
                    <Show when={done().state !== "blocked"}>
                      <p class="m-0 text-[12px] text-own-muted" data-testid="tool-update-elapsed">
                        {took(text, done())}
                      </p>
                    </Show>
                  </>
                )}
              </Show>
              <b class="text-[12px] font-semibold">{text("own.upd.job.output")}</b>
              <pre
                class="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-own-border p-2 font-mono text-[12px]"
                data-testid="tool-update-output"
              >
                {output()}
              </pre>
            </div>
          )}
        </Show>
      </div>
    </Dialog>
  )
}

/** The running line: the download so far and the time, the note that it may take minutes, the ten-minute hint. */
function Progress(props: { readonly job: ToolUpdates.Job }) {
  const text = useToolUpdatesText()
  const line = () => {
    const job = props.job
    const elapsed = duration(text, job.elapsed)
    if (job.exitCode !== null) return text("own.upd.job.checking")
    if (job.download) return text("own.upd.job.downloading", { size: size(job.download.bytes), elapsed })
    return text("own.upd.job.running", { elapsed })
  }
  const limits = { minutes: ToolUpdates.SLOW_MS / 60_000, limit: ToolUpdates.TIMEOUT_MS / 60_000 }
  return (
    <>
      <p
        class="m-0 flex items-center gap-2 tabular-nums"
        role="status"
        data-testid="tool-update-progress"
        data-download={props.job.download ? "" : undefined}
      >
        <Spinner /> {line()}
      </p>
      <p class="m-0 text-[12px] text-own-muted" data-testid="tool-update-note">
        {text("own.upd.job.note")}
      </p>
      <Show when={props.job.elapsed >= ToolUpdates.SLOW_MS && props.job.exitCode === null}>
        <Notice tone="warn" testid="tool-update-slow">
          {text(props.job.download ? "own.upd.job.slow" : "own.upd.job.slowNoSize", limits)}
        </Notice>
      </Show>
    </>
  )
}

/** `45초`, `1분 12초`, `1시간 2분`. */
function duration(text: ToolUpdatesText, ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return text("own.upd.time.s", { s: seconds })
  if (seconds < 3600) return text("own.upd.time.ms", { m: Math.floor(seconds / 60), s: seconds % 60 })
  return text("own.upd.time.hm", { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) })
}

/** `걸린 시간 3분 2초 · 내려받은 크기 345 MB`, the size only when the native updater's download was measured. */
function took(text: ToolUpdatesText, job: ToolUpdates.Job) {
  const elapsed = duration(text, job.elapsed)
  if (!job.download) return text("own.upd.job.took", { elapsed })
  return text("own.upd.job.tookSize", { elapsed, size: size(job.download.bytes) })
}

/** Decimal megabytes like the release pages: `128 MB`, `3.1 MB`. */
function size(bytes: number) {
  const megabytes = bytes / 1_000_000
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`
}

function JobResult(props: { readonly job: ToolUpdates.Job }) {
  const text = useToolUpdatesText()
  const message = () => {
    const job = props.job
    if (job.state === "blocked") return { tone: "warn" as const, text: text("own.upd.job.blocked") }
    if (job.timedOut)
      return { tone: "danger" as const, text: text("own.upd.job.timedOut", { limit: ToolUpdates.TIMEOUT_MS / 60_000 }) }
    if (job.state === "failed")
      return { tone: "danger" as const, text: text("own.upd.job.failed", { code: job.exitCode ?? "?" }) }
    const after = job.after ?? "?"
    return {
      tone: "ok" as const,
      text: text(job.after !== null && job.after === job.before ? "own.upd.job.same" : "own.upd.job.done", { after }),
    }
  }
  return (
    <Notice tone={message().tone} testid="tool-update-result">
      {message().text}
    </Notice>
  )
}
