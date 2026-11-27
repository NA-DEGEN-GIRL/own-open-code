// The open `⧗ 백그라운드 n` list (03 §19.7), a lazy chunk: one row per job — kind, label, how long it has run (minute
// clock, R9), `출력 보기` (shell, 터미널처럼) or `열기 →` (subagent: its child session), and `종료`.
// Rows are keyed by id (<For> over the task objects of a keyed memo) and contain their layout (R1, R7).
import { createSignal, For, Show } from "solid-js"
import type { ServerKey } from "@/data"
import { useRouter } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { showToast } from "@/switcher/toast"
import { shellDirectory, type Background } from "./data"
import { openShellOutput } from "./host"
import { elapsedMinutes, shortLabel, type BackgroundTask } from "./model"
import { useBackgroundText } from "./strings"
import { useBackgroundViewText } from "./view-strings"
import "./view.css"

export default function BackgroundPanel(props: {
  readonly background: Background
  readonly serverKey: ServerKey
  readonly id: string
}) {
  const text = useBackgroundText()
  const view = useBackgroundViewText()
  const router = useRouter()
  const [stopping, setStopping] = createSignal<ReadonlySet<string>>(new Set())

  async function stop(task: BackgroundTask) {
    setStopping((set) => new Set(set).add(task.id))
    try {
      await props.background.stop(task)
    } catch (error) {
      showToast({
        tone: "danger",
        message: view("own.background.stopFailed", { reason: error instanceof Error ? error.message : String(error) }),
      })
    } finally {
      setStopping((set) => {
        const next = new Set(set)
        next.delete(task.id)
        return next
      })
    }
  }

  function output(task: BackgroundTask) {
    const current = props.background.target()
    openShellOutput({
      serverKey: props.serverKey,
      shellID: task.id,
      label: task.label,
      sessionID: props.id,
      directory: current ? shellDirectory(current.runtime, task.id, props.id) : undefined,
    })
  }

  const elapsed = (task: BackgroundTask) => {
    const minutes = elapsedMinutes(task.started, minuteNow())
    if (minutes === undefined) return undefined
    return minutes < 1 ? view("own.background.justStarted") : view("own.background.elapsed", { minutes })
  }

  return (
    <ul class="own-bj-list" aria-label={text("own.background.list")} data-testid="background-list">
      <For each={props.background.tasks()}>
        {(task) => (
          <li class="own-bj-item" data-kind={task.kind} data-testid="background-item" data-id={task.id}>
            <span class="own-bj-kind">
              {task.kind === "shell" ? text("own.background.kind.shell") : view("own.background.kind.subagent")}
            </span>
            <span class="own-bj-label" title={task.label}>
              {shortLabel(task.label, 72)}
            </span>
            <Show when={elapsed(task)}>{(value) => <span class="own-bj-time">{value()}</span>}</Show>
            <span class="own-bj-actions">
              <Show
                when={task.kind === "shell"}
                fallback={
                  <button
                    type="button"
                    class="own-bj-btn"
                    data-testid="background-open"
                    onClick={() => router.navigate({ name: "session", serverKey: props.serverKey, sessionID: task.id })}
                  >
                    {view("own.background.open")}
                  </button>
                }
              >
                <button
                  type="button"
                  class="own-bj-btn"
                  data-testid="background-item-output"
                  onClick={() => output(task)}
                >
                  {text("own.background.output")}
                </button>
              </Show>
              <Show when={props.background.canAct()}>
                <button
                  type="button"
                  class="own-bj-btn"
                  data-tone="danger"
                  data-testid="background-stop"
                  aria-label={view("own.background.stopNamed", { label: shortLabel(task.label, 40) })}
                  disabled={stopping().has(task.id)}
                  onClick={() => void stop(task)}
                >
                  {stopping().has(task.id) ? view("own.background.stopping") : view("own.background.stop")}
                </button>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ul>
  )
}
