// Session header running menu (03 §4.4; upstream 3a861ff8b0, b9db2f6915, ae57dd0cf5): `작업 중 2 ▾` after the title
// while the session's subagents or background shells run; in a subagent the list is its parent's work (`그 밖에 작업 중
// 1`) with the viewed one marked. A row opens its subagent, the shell's output (터미널처럼, 19.7) or, for a subagent
// still starting, the parent where it will appear; Delete (or ✕) stops it — `session.interrupt` of the child, or
// `DELETE /api/shell/:id` at the shell's location — on connections that may prompt. Foreground shells stay out: the
// transcript shows them. The menu closes before it navigates (ae57dd0cf5). Same popover behavior as `HostMenu`
// (top layer, light dismiss, Esc, arrow keys, focus on the first row).
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { createBackground, shellDirectory } from "./data"
import { openShellOutput } from "./host"
import { runningItems, runningLabel, shortLabel, type RunningItem } from "./model"
import { useBackgroundText } from "./strings"

export function RunningMenu(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const router = useRouter()
  const text = useBackgroundText()
  const id = createUniqueId()
  const runtime = () => data.get(props.serverKey())
  /** The session whose work is listed: this one, or its parent inside a subagent. */
  const owner = () => {
    const current = runtime()
    const sessionID = props.sessionID()
    if (!current || !sessionID) return undefined
    return (
      current.data.session.get(sessionID)?.parentID ?? current.sessions.state.sessions[sessionID]?.parentID ?? sessionID
    )
  }
  const child = () => owner() !== undefined && owner() !== props.sessionID()
  const background = createBackground({ runtime, serverKey: props.serverKey, sessionID: owner })
  const items = createMemo(() => {
    const current = runtime()
    if (!current) return []
    return runningItems(background.blocking(), background.tasks(), (sessionID) =>
      sessionID ? current.data.session.get(sessionID)?.agent : undefined,
    )
  })
  const label = () => {
    const value = runningLabel(items(), props.sessionID(), child())
    return value ? text(value.key, { n: value.count }) : undefined
  }
  const viewing = (item: RunningItem) => !!item.sessionID && item.sessionID === props.sessionID()
  // A subagent can be interrupted once its child session exists.
  const stoppable = (item: RunningItem) => background.canAct() && (item.kind === "shell" || !!item.sessionID)

  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement
  const rows = () => [...popover.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
  const place = () => {
    const rect = button.getBoundingClientRect()
    const width = popover.offsetWidth
    popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`
    popover.style.top = `${rect.bottom + 4}px`
  }
  const hide = () => {
    if (popover.matches(":popover-open")) popover.hidePopover()
  }

  function go(item: RunningItem) {
    const current = owner()
    hide()
    if (!current || viewing(item)) return
    if (item.sessionID)
      return router.navigate({ name: "session", serverKey: props.serverKey(), sessionID: item.sessionID })
    if (item.kind === "shell") {
      const rt = runtime()
      return openShellOutput({
        serverKey: props.serverKey(),
        shellID: item.target,
        label: item.label ?? item.target,
        sessionID: current,
        directory: rt ? shellDirectory(rt, item.target, current) : undefined,
      })
    }
    // A subagent still starting lives in its parent's transcript.
    if (current !== props.sessionID())
      router.navigate({ name: "session", serverKey: props.serverKey(), sessionID: current })
  }

  async function stop(item: RunningItem) {
    const task = item.kind === "shell" ? item.target : item.sessionID
    if (!task || !stoppable(item)) return
    await background.stop({ id: task, kind: item.kind, label: item.label ?? task }).catch((error: unknown) =>
      showToast({
        tone: "danger",
        message: text("own.background.running.stopFailed", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }),
    )
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") return event.stopPropagation()
    const list = rows()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.code === "ArrowDown"
        ? (index + 1) % list.length
        : event.code === "ArrowUp"
          ? (index - 1 + list.length) % list.length
          : event.code === "Home"
            ? 0
            : event.code === "End"
              ? list.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    list[next]?.focus()
  }

  return (
    <Show when={label()}>
      {(value) => (
        <>
          <button
            ref={button}
            type="button"
            class="own-run-trigger own-target"
            aria-haspopup="menu"
            aria-expanded={open()}
            aria-controls={id}
            popovertarget={id}
            data-testid="running-menu"
          >
            <span class="own-run-mark" aria-hidden="true" />
            <span>{value()}</span>
            <span aria-hidden="true">▾</span>
          </button>
          <div
            ref={popover}
            id={id}
            popover="auto"
            role="menu"
            aria-label={text("own.background.running.menu")}
            class="own-run-menu"
            style={{ position: "fixed", inset: "auto" }}
            data-testid="running-menu-list"
            onToggle={(event) => {
              const opened = event.newState === "open"
              setOpen(opened)
              if (!opened) return
              place()
              rows()[0]?.focus()
            }}
            onKeyDown={onKeyDown}
          >
            <Show when={open()}>
              <For each={items()}>
                {(item) => (
                  <div class="own-run-row" role="none" data-kind={item.kind}>
                    <button
                      type="button"
                      role="menuitem"
                      class="own-run-item"
                      aria-current={viewing(item) ? "page" : undefined}
                      aria-keyshortcuts={stoppable(item) ? "Delete" : undefined}
                      data-testid="running-item"
                      data-key={item.key}
                      onClick={() => go(item)}
                      onKeyDown={(event) => {
                        if ((event.key !== "Delete" && event.key !== "Backspace") || !stoppable(item)) return
                        event.preventDefault()
                        void stop(item)
                      }}
                    >
                      <span class="own-run-kind-icon" data-kind={item.kind} aria-hidden="true">
                        {item.kind === "shell" ? "›_" : "●"}
                      </span>
                      <span class="own-run-kind">
                        {item.kind === "shell"
                          ? text("own.background.kind.shell")
                          : item.agent
                            ? `${item.agent[0]!.toUpperCase()}${item.agent.slice(1)}`
                            : text("own.background.running.subagent")}
                      </span>
                      <span class="own-run-label" title={item.label}>
                        {shortLabel(item.label ?? "", 56)}
                      </span>
                      <Show when={viewing(item)}>
                        <span class="own-run-here">{text("own.background.running.here")}</span>
                      </Show>
                    </button>
                    <Show when={stoppable(item)}>
                      {/* Pointer only: the row's Delete key does the same from the keyboard. */}
                      <button
                        type="button"
                        class="own-run-stop"
                        tabIndex={-1}
                        aria-label={text(
                          item.kind === "shell"
                            ? "own.background.running.stopShell"
                            : "own.background.running.stopSubagent",
                        )}
                        title={text(
                          item.kind === "shell"
                            ? "own.background.running.stopShell"
                            : "own.background.running.stopSubagent",
                        )}
                        data-testid="running-stop"
                        onClick={(event) => {
                          event.stopPropagation()
                          void stop(item)
                        }}
                      >
                        ×
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </>
      )}
    </Show>
  )
}
