// Open file tabs (03 §19.4 "열린 파일 탭"): a scrollable tablist, ←/→/Home/End between tabs (by `event.code`, never
// while composing), Delete or a middle click closes, Ctrl+Shift+PageUp/PageDown moves a tab. The close button is a
// sibling of the tab button so the tab stays one control for assistive technology.
import { createEffect, For, on } from "solid-js"
import { FilesIcon } from "./icons"
import { basename, dirname } from "./paths"
import type { FileTab } from "./tabs"
import { useFilesText } from "./strings"

export function TabStrip(props: {
  readonly tabs: readonly FileTab[]
  readonly active?: string
  readonly onActivate: (path: string) => void
  readonly onClose: (path: string) => void
  readonly onMove: (path: string, to: number) => void
}) {
  const text = useFilesText()
  const element = { list: undefined as HTMLDivElement | undefined }
  const tabID = (path: string) => `own-files-tab-${props.tabs.findIndex((tab) => tab.path === path)}`
  // Two open files with the same name show their folder as well.
  const label = (path: string) => {
    const name = basename(path)
    const twins = props.tabs.filter((tab) => basename(tab.path) === name).length > 1
    return twins ? `${name} — ${basename(dirname(path)) || "/"}` : name
  }

  createEffect(
    on(
      () => props.active,
      (path) => {
        if (path)
          element.list
            ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "nearest" })
      },
    ),
  )

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return
    const index = props.tabs.findIndex((tab) => tab.path === props.active)
    const at = (position: number) => props.tabs[(position + props.tabs.length) % props.tabs.length]?.path
    const go = (path: string | undefined) => {
      if (!path) return
      event.preventDefault()
      props.onActivate(path)
      queueMicrotask(() => document.getElementById(tabID(path))?.focus())
    }
    if (event.ctrlKey && event.shiftKey && (event.code === "PageUp" || event.code === "PageDown") && props.active) {
      event.preventDefault()
      props.onMove(props.active, index + (event.code === "PageUp" ? -1 : 1))
      return
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.code === "ArrowRight") return go(at(index + 1))
    if (event.code === "ArrowLeft") return go(at(index - 1))
    if (event.code === "Home") return go(at(0))
    if (event.code === "End") return go(at(props.tabs.length - 1))
    if (event.code === "Delete" && props.active) {
      event.preventDefault()
      const next = at(index + 1) === props.active ? undefined : (props.tabs[index + 1] ?? props.tabs[index - 1])?.path
      props.onClose(props.active)
      if (next) queueMicrotask(() => document.getElementById(tabID(next))?.focus())
    }
  }

  return (
    <div
      ref={(list) => (element.list = list)}
      class="own-files-tabs"
      role="tablist"
      aria-label={text("own.files.tabs")}
      data-testid="files-tabs"
      onKeyDown={onKeyDown}
    >
      <For each={props.tabs}>
        {(tab) => (
          <div class="own-files-tab" data-path={tab.path} data-active={tab.path === props.active ? "" : undefined}>
            <button
              type="button"
              role="tab"
              id={tabID(tab.path)}
              aria-selected={tab.path === props.active}
              aria-controls="own-files-view"
              tabIndex={tab.path === props.active ? 0 : -1}
              title={tab.path}
              onClick={() => props.onActivate(tab.path)}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                props.onClose(tab.path)
              }}
            >
              <bdi>{label(tab.path)}</bdi>
            </button>
            <button
              type="button"
              class="own-files-tab-close"
              tabIndex={-1}
              aria-label={text("own.files.close", { name: basename(tab.path) })}
              data-testid="files-tab-close"
              onClick={() => props.onClose(tab.path)}
            >
              <FilesIcon name="x" />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
