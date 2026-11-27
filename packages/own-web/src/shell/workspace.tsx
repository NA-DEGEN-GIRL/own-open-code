// The workspace (03 §4.1, §4.1.1): the tab strip, the split panes (panes.tsx) and the project notebook docked left,
// right or as the main tab. `나란히` (the default) shows the panes side by side and turns 브라우저 into a button
// that opens the focused pane's browser beside it; `탭으로 보기`, and widths where the panes do not fit, show the
// focused pane with the 채팅 | 브라우저 | 노트 tabs. The notebook survives tab, mode and docking changes.
import { createEffect, createSignal, For, lazy, onCleanup, onMount, Show, Suspense, type ParentProps } from "solid-js"
import { BrowserTabBadge } from "@/browser/badge"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { useShell } from "./context"
import { Icon, InlineIcon } from "./icons"
import { browserOf, focusedChat } from "./pane-layout"
import { PaneArea } from "./panes"
import type { PanelTabProps } from "./work-panel"
import { snapNotesWidth, type NotesPlacement } from "./workspace-state"
import "./workspace.css"

const NotesPanel = lazy(() => import("@/notes/workspace"))
// 05 §8.10: windows without a pane of their own load the device viewer's dock (the hint, and the viewer on demand).
const RemoteBrowser = lazy(() => import("@/browser/remote/dock"))

/** One notebook survives tab and docking changes; the panes keep their sessions and browsers (panes.tsx). */
export function Workspace(props: ParentProps<PanelTabProps>) {
  const shell = useShell()
  const host = useHost()
  const i18n = useI18n()
  const layout = shell.workspaceLayout.read
  const [dragging, setDragging] = createSignal(false)
  const [drop, setDrop] = createSignal<NotesPlacement>()
  const [preview, setPreview] = createSignal<number>()
  const [notesMounted, setNotesMounted] = createSignal(false)
  const available = shell.workspaceWidth
  let body!: HTMLDivElement
  let stopResize: (() => void) | undefined
  onCleanup(() => stopResize?.())
  onMount(() => {
    const observer = new ResizeObserver(() => shell.setWorkspaceWidth(body.clientWidth))
    observer.observe(body)
    onCleanup(() => observer.disconnect())
  })
  const narrow = shell.narrowWorkspace
  const placement = shell.notesPlacement
  const tab = shell.workspaceTab
  const notesVisible = () => layout().notesOpen && (placement() !== "main" || tab() === "notes")
  // Native browser views sit above the DOM, so shell drawers must hide the surface as well as dim the page.
  const coveredByShell = () =>
    (shell.mode().panelMode !== "push" && shell.panelOpen()) ||
    (shell.mode().sidebarMode === "drawer" && shell.sidebarOpen())
  const width = () => snapNotesWidth(layout().notesWidth, available() || window.innerWidth)
  const split = shell.splitView
  /** The saved mode is `나란히` but the window is too narrow for the panes (03 §4.1.1 automatic fallback). */
  const fallback = () => shell.panes.mode() === "split" && !split()
  const browserOpen = () => !!browserOf(shell.paneState(), focusedChat(shell.paneState())?.id ?? "")
  createEffect(() => {
    if (layout().notesOpen) setNotesMounted(true)
  })
  const beginDrag = (event: DragEvent) => {
    event.dataTransfer?.setData("application/x-own-notes", "notes")
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    setDragging(true)
  }
  const endDrag = () => {
    setDragging(false)
    setDrop(undefined)
  }
  const openNotes = () => {
    if (notesVisible()) return shell.closeNotes()
    shell.openNotes()
    if (placement() === "main") shell.selectWorkspaceTab("notes")
  }
  const dock = (value: NotesPlacement) => {
    shell.placeNotes(value)
    endDrag()
  }
  const beginResize = (event: PointerEvent) => {
    if (event.button !== 0) return
    stopResize?.()
    event.preventDefault()
    const origin = event.clientX
    const initial = width()
    const move = (event: PointerEvent) =>
      setPreview(
        snapNotesWidth(initial + (event.clientX - origin) * (placement() === "left" ? 1 : -1), body.clientWidth),
      )
    const stop = () => {
      const next = preview()
      if (next !== undefined) shell.workspaceLayout.update({ notesWidth: next })
      setPreview(undefined)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      stopResize = undefined
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop, { once: true })
    window.addEventListener("pointercancel", stop, { once: true })
    stopResize = stop
  }
  return (
    <div class="own-workspace" hidden={!props.visible()}>
      <div class="own-workspace-tabs">
        <div role="tablist" aria-label={i18n.t("own.shell.tabs")}>
          <button
            class="own-tab"
            role="tab"
            aria-selected={tab() === "chat"}
            aria-controls="workspace-chat"
            onClick={() => shell.selectWorkspaceTab("chat")}
          >
            {i18n.t("own.shell.tab.chat")}
          </button>
          <Show when={host.capabilities.browserPane && !split()}>
            <button
              class="own-tab"
              role="tab"
              id="own-tab-browser"
              aria-selected={tab() === "browser"}
              aria-controls="workspace-browser"
              onClick={() => shell.selectWorkspaceTab("browser")}
            >
              {i18n.t("own.shell.tab.browser")}
              <BrowserTabBadge serverKey={props.serverKey} sessionID={props.sessionID} />
            </button>
          </Show>
          <Show when={layout().notesOpen && placement() === "main"}>
            <button
              class="own-tab"
              role="tab"
              aria-selected={tab() === "notes"}
              draggable
              onDragStart={beginDrag}
              onDragEnd={endDrag}
              onClick={() => shell.selectWorkspaceTab("notes")}
            >
              <InlineIcon name="notebook" class="own-workspace-tab-icon" />
              {i18n.t("own.shell.tab.notes")}
            </button>
          </Show>
        </div>
        {/* `나란히`: the focused pane's browser beside it (Ctrl+Shift+B), a button rather than a tab. */}
        <Show when={host.capabilities.browserPane && split()}>
          <button
            class="own-button own-workspace-tool"
            aria-pressed={browserOpen()}
            data-testid="workspace-browser-toggle"
            title={i18n.t(browserOpen() ? "own.pane.browserClose" : "own.pane.browserOpen")}
            onClick={() => shell.toggleBrowserView()}
          >
            <InlineIcon name="globe" class="own-workspace-tab-icon" />
            {i18n.t("own.shell.tab.browser")}
            <BrowserTabBadge serverKey={props.serverKey} sessionID={props.sessionID} />
          </button>
        </Show>
        <span class="own-workspace-tools">
          <Show when={fallback() && shell.splitCapable()}>
            <span class="own-workspace-fallback" data-testid="workspace-fallback">
              {i18n.t("own.pane.fallback")}
            </span>
          </Show>
          <Show when={split()}>
            <button
              class="own-icon-button own-workspace-mode"
              aria-label={i18n.t("own.pane.splitRight")}
              title={i18n.t("own.pane.splitRight")}
              data-testid="workspace-split"
              onClick={() => shell.splitFocused("row")}
            >
              <Icon name="splitRight" />
            </button>
          </Show>
          <Show when={shell.splitCapable() && !fallback()}>
            <button
              class="own-icon-button own-workspace-mode"
              aria-label={i18n.t(split() ? "own.pane.mode.tabs" : "own.pane.mode.split")}
              title={i18n.t(split() ? "own.pane.mode.tabs" : "own.pane.mode.split")}
              data-testid="workspace-mode"
              data-mode={split() ? "split" : "tabs"}
              onClick={() => shell.setPaneMode(split() ? "tabs" : "split")}
            >
              <Icon name={split() ? "tabs" : "splitRight"} />
            </button>
          </Show>
        </span>
        <button
          class="own-button own-workspace-note-toggle"
          draggable
          onDragStart={beginDrag}
          onDragEnd={endDrag}
          aria-pressed={notesVisible()}
          onClick={openNotes}
          data-testid="workspace-notes-toggle"
          title={i18n.t("own.shell.notes.open")}
        >
          <InlineIcon name="notebook" class="own-workspace-tab-icon" />
          {i18n.t("own.shell.tab.notes")}
        </button>
      </div>
      <div
        class="own-workspace-body"
        ref={body}
        data-notes={notesVisible() ? placement() : "closed"}
        style={{ "--own-notes-width": `${width()}px` }}
      >
        <div
          class="own-workspace-content"
          id={tab() === "browser" ? "workspace-browser" : "workspace-chat"}
          role="tabpanel"
          hidden={placement() === "main" && tab() === "notes" && notesVisible()}
        >
          <PaneArea visible={props.visible} blocked={() => dragging() || preview() !== undefined || coveredByShell()}>
            {props.children}
          </PaneArea>
        </div>
        <Show when={!host.capabilities.browserPane}>
          <Suspense>
            <RemoteBrowser serverKey={props.serverKey} sessionID={props.sessionID} visible={props.visible} />
          </Suspense>
        </Show>
        <Show when={notesMounted()}>
          <aside
            class="own-workspace-note-column"
            hidden={!notesVisible()}
            aria-label={i18n.t("own.shell.notes.dock")}
          >
            <div class="own-workspace-note-head">
              <span
                class="own-note-grip"
                draggable
                onDragStart={beginDrag}
                onDragEnd={endDrag}
                title={i18n.t("own.shell.notes.drag")}
              >
                ⠿ {i18n.t("own.shell.tab.notes")}
              </span>
              <select
                aria-label={i18n.t("own.shell.notes.placement")}
                value={placement()}
                onChange={(event) => dock(event.currentTarget.value as NotesPlacement)}
              >
                <option value="left" disabled={narrow()}>
                  {i18n.t("own.shell.notes.left")}
                </option>
                <option value="main">{i18n.t("own.shell.notes.tab")}</option>
                <option value="right" disabled={narrow()}>
                  {i18n.t("own.shell.notes.right")}
                </option>
              </select>
              <button
                class="own-icon-button"
                onClick={() => shell.closeNotes()}
                aria-label={i18n.t("own.shell.notes.close")}
              >
                ×
              </button>
            </div>
            <Show when={shell.workspaceKey()} keyed>
              {(key) => (
                <Suspense fallback={<p class="own-placeholder">{i18n.t("own.shell.loading")}</p>}>
                  <NotesPanel
                    workspaceKey={key}
                    server={shell.workspacePlace().server}
                    directory={shell.workspacePlace().directory}
                  />
                </Suspense>
              )}
            </Show>
            <Show when={placement() !== "main"}>
              <div
                class="own-notes-resize"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label={i18n.t("own.shell.notes.width")}
                aria-valuenow={width()}
                aria-valuemin={220}
                aria-valuemax={600}
                onPointerDown={beginResize}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                  event.preventDefault()
                  const direction = (event.key === "ArrowRight" ? 1 : -1) * (placement() === "left" ? 1 : -1)
                  shell.workspaceLayout.update({
                    notesWidth: snapNotesWidth(width() + direction * 20, body.clientWidth),
                  })
                }}
              />
            </Show>
          </aside>
        </Show>
        <Show when={preview() !== undefined}>
          <div class="own-notes-size-preview" data-side={placement()} style={{ width: `${preview()}px` }}>
            <span>{preview()} px</span>
          </div>
        </Show>
        <Show when={dragging()}>
          <div
            class="own-workspace-dropzones"
            data-narrow={narrow() ? "" : undefined}
            data-own-overlay
            onDragEnd={endDrag}
          >
            <For each={narrow() ? ["main" as const] : (["left", "main", "right"] as const)}>
              {(side) => (
                <div
                  class="own-workspace-drop"
                  data-active={drop() === side ? "" : undefined}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDrop(side)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    dock(side)
                  }}
                >
                  {side === "left"
                    ? i18n.t("own.shell.notes.left")
                    : side === "right"
                      ? i18n.t("own.shell.notes.right")
                      : i18n.t("own.shell.notes.tab")}
                  <small>{side === "main" ? "100%" : `${width()} px`}</small>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
