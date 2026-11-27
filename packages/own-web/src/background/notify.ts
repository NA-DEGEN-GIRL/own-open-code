// "백그라운드 작업 끝남" (03 §9): a toast `{label} — 끝났습니다 (exit 0) · 출력 보기` when a background shell exits,
// `{label} — 하위 에이전트가 끝났습니다 · 열기` when a backgrounded subagent's run ends; an OS notification only while
// the window is hidden. Foreground tool shells report through their tool card and never toast; shells this window
// stopped and runs the user interrupted do not either. No timers: everything reacts to events (R9).
//
// Event order: the bus calls typed handlers (`bus.on`) before createData's catch-all listener in the same frame, so
// on `shell.exited` the shell is still in `data.shell` (command, metadata, location).
import { createEffect, onCleanup } from "solid-js"
import type { DataLayer, ServerKey, ServerRuntime } from "@/data"
import type { HostNotification, OsNotifications } from "@/host/types"
import type { Locale } from "@/i18n"
import type { ToastInput } from "@/switcher/toast"
import { takeListed, takeStopped } from "./data"
import type { OutputRequest } from "./host"
import { backgroundedInHistory, shellDone, shortLabel, wasBackground } from "./model"
import type { BackgroundKey } from "./strings"

export interface BackgroundNotifierInput {
  readonly data: DataLayer
  readonly capability: OsNotifications
  readonly notify?: (input: HostNotification) => void
  readonly hidden: () => boolean
  readonly locale: () => Locale
  readonly text: (locale: Locale, key: BackgroundKey, params?: Readonly<Record<string, string | number>>) => string
  readonly toast: (input: ToastInput) => unknown
  readonly openOutput: (request: OutputRequest) => void
  readonly openSession: (serverKey: ServerKey, sessionID: string) => void
  /** The bell list (03 §9, 21.3 local `background.done` FeedItem) once a shared feed exists. */
  readonly onDone?: (item: BackgroundDone) => void
}

export interface BackgroundDone {
  readonly kind: "background.done"
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly job: "shell" | "subagent"
  readonly message: string
  readonly severity: "info" | "danger"
  readonly at: number
}

export function createBackgroundNotifier(input: BackgroundNotifierInput) {
  function announce(
    serverKey: ServerKey,
    sessionID: string,
    job: BackgroundDone["job"],
    message: string,
    toast: ToastInput,
  ) {
    input.toast(toast)
    input.onDone?.({
      kind: "background.done",
      serverKey,
      sessionID,
      job,
      message,
      severity: toast.tone === "danger" ? "danger" : "info",
      at: Date.now(),
    })
    if (!input.notify || input.capability === "none" || !input.hidden()) return
    input.notify({
      title: message,
      tag: `own:background:${serverKey}:${sessionID}`,
      onClick: () => input.openSession(serverKey, sessionID),
    })
  }

  function shellExited(
    serverKey: ServerKey,
    runtime: ServerRuntime,
    event: { readonly id: string; readonly exit?: number; readonly status: string },
  ) {
    const info = runtime.data.shell.get(event.id)
    const known = takeListed(serverKey, event.id)
    if (takeStopped(serverKey, event.id)) return
    const metadata: Readonly<Record<string, unknown>> = info?.metadata ?? (known ? { sessionID: known.sessionID } : {})
    const sessionID = typeof metadata.sessionID === "string" ? metadata.sessionID : undefined
    if (!sessionID) return
    const busy =
      runtime.data.session.status(sessionID) === "running" ||
      runtime.sessions.state.sessions[sessionID]?.status === "busy"
    const background = wasBackground({
      metadata,
      listed: !!known,
      inHistory: backgroundedInHistory(runtime.data.session.message.list(sessionID), "shell", event.id),
      sessionIdle: !busy,
    })
    if (!background) return
    const full = info?.command ?? known?.label ?? event.id
    const done = shellDone(event.status, event.exit)
    const message = input.text(input.locale(), done.key, { label: shortLabel(full), code: event.exit ?? "" })
    announce(serverKey, sessionID, "shell", message, {
      message,
      tone: done.tone,
      action: {
        label: input.text(input.locale(), "own.background.output"),
        run: () =>
          input.openOutput({
            serverKey,
            shellID: event.id,
            label: full,
            sessionID,
            directory: info?.location.directory,
          }),
      },
    })
  }

  function childEnded(serverKey: ServerKey, runtime: ServerRuntime, childID: string, failed: boolean) {
    const info = runtime.data.session.get(childID)
    const parentID = info?.parentID
    const known = takeListed(serverKey, childID)
    if (!parentID) return
    const inHistory = backgroundedInHistory(runtime.data.session.message.list(parentID), "subagent", childID)
    if (!known && !inHistory) return
    const label = shortLabel(known?.label ?? info?.title ?? childID)
    const message = input.text(
      input.locale(),
      failed ? "own.background.done.subagentFailed" : "own.background.done.subagent",
      { label },
    )
    announce(serverKey, parentID, "subagent", message, {
      message,
      tone: failed ? "danger" : "neutral",
      action: {
        label: input.text(input.locale(), "own.background.done.openChild"),
        run: () => input.openSession(serverKey, childID),
      },
    })
  }

  createEffect(() => {
    for (const entry of input.data.servers.list()) {
      const runtime = input.data.get(entry.key)
      if (!runtime) continue
      onCleanup(runtime.bus.on("shell.exited", (event) => shellExited(entry.key, runtime, event.data)))
      onCleanup(
        runtime.bus.on("session.execution.succeeded", (event) =>
          childEnded(entry.key, runtime, event.data.sessionID, false),
        ),
      )
      onCleanup(
        runtime.bus.on("session.execution.failed", (event) =>
          childEnded(entry.key, runtime, event.data.sessionID, true),
        ),
      )
    }
  })
  return { shellExited, childEnded }
}
