// The device viewer's place in the workspace (05 §8.10), mounted by shell/workspace.tsx in every window without a
// browser pane of its own and loaded after the first paint. Small on purpose; the viewer itself (view.tsx, its
// strings and styles) is a further chunk, fetched when the user opens it.
//  - On a paired device it follows the agent's browser calls of every server it sees, this PC's and its SSH hosts'
//    (activity.ts, the trackers the desktop window gets from attach.tsx), so the viewer shows `에이전트가 조작 중` and
//    knows a takeover.
//  - While the agent is using the browser in the conversation on screen, a hint over the conversation's corner
//    (`브라우저 사용 중 · 보기`) opens the viewer.
//  - `shell.browserView()` (the conversation `⋯` > 브라우저, the hint): the viewer, in this same spot of the workspace
//    body. Its stylesheet makes that spot a layer over the conversation below 840 px and a column beside it from
//    there, so folding and unfolding a phone never remounts it.
import "./dock.css"
import { createEffect, createMemo, createRoot, lazy, on, onCleanup, Show, Suspense, untrack } from "solid-js"
import { useData, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { useShell } from "@/shell/context"
import type { PanelTabProps } from "@/shell/work-panel"
import { createBrowserActivity } from "../activity"
import { browserPhase, setWindowActivity } from "../registry"
import { ENTRY_TEXT, viewerHost } from "./menu"

const RemoteBrowserView = lazy(() => import("./view"))

/** One server's tracker in the window's registry; returns what takes it out again. */
function track(runtime: ServerRuntime) {
  return createRoot((dispose) => {
    const tracker = createBrowserActivity({
      bus: runtime.bus,
      turnRunning: (sessionID) => runtime.data.session.status(sessionID) === "running",
    })
    setWindowActivity(runtime.key, tracker)
    onCleanup(() => {
      setWindowActivity(runtime.key, undefined)
      tracker.dispose()
    })
    return dispose
  })
}

export default function RemoteBrowserDock(props: PanelTabProps) {
  const data = useData()
  const shell = useShell()
  const i18n = useI18n()
  const device = createMemo(() => viewerHost({ data, shell }))

  createEffect(() => {
    if (!device()) return
    const trackers = new Map<string, () => void>()
    createEffect(() => {
      const runtimes = data.servers.list().flatMap((server) => {
        const runtime = data.get(server.key)
        return runtime ? [runtime] : []
      })
      for (const runtime of runtimes)
        if (!trackers.has(runtime.key))
          trackers.set(
            runtime.key,
            untrack(() => track(runtime)),
          )
      for (const [key, stop] of trackers)
        if (!runtimes.some((runtime) => runtime.key === key)) {
          stop()
          trackers.delete(key)
        }
    })
    onCleanup(() => {
      trackers.forEach((stop) => stop())
      trackers.clear()
    })
  })
  // The view belongs to the window that opened it: a host that stops being a device (never, in practice) closes it.
  createEffect(() => {
    if (!device()) shell.setBrowserView(false)
  })
  // While the browser has the conversation list's column the list is a drawer (shell/context.tsx `mode`): one left
  // open must not come back open the next time, and opening the browser starts with it closed.
  createEffect(on(shell.browserView, () => shell.closeOverlays(), { defer: true }))

  return (
    <>
      <Show
        when={
          device() &&
          !shell.browserView() &&
          props.visible() &&
          browserPhase(props.serverKey(), props.sessionID()) === "operating"
        }
      >
        <button
          type="button"
          class="own-rb-hint"
          data-testid="remote-browser-hint"
          onClick={() => shell.setBrowserView(true)}
        >
          <span aria-hidden="true">●</span>
          {ENTRY_TEXT[i18n.locale()].using}
        </button>
      </Show>
      <Show when={shell.browserView()}>
        <Suspense>
          <RemoteBrowserView
            serverKey={props.serverKey}
            sessionID={props.sessionID}
            visible={props.visible}
            onClose={() => shell.setBrowserView(false)}
          />
        </Suspense>
      </Show>
    </>
  )
}
