// File tree (03 §19.4 "트리(가상 목록)", 20.2 R2): only the visible rows exist (tanstack virtualizer, like the review
// file list), one focusable `role="tree"` with `aria-activedescendant`, keys by `event.code` and never while an IME
// composes. ↑/↓/Home/End move, → opens a folder or steps into it, ← closes it or steps to the parent, Enter/Space
// open, Shift+F10 or the Menu key opens the file menu. The row of the active tab is marked and scrolled into view.
import { createVirtualizer } from "@tanstack/solid-virtual"
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import { FilesIcon } from "./icons"
import { dirname } from "./paths"
import { useFilesText } from "./strings"
import type { Tree } from "./tree"

export function TreeView(props: {
  readonly tree: Tree
  readonly active?: string
  readonly rowHeight: number
  readonly onOpen: (path: string) => void
  readonly onMenu: (
    path: string,
    at: { readonly x: number; readonly y: number },
    opener: HTMLElement,
    folder: boolean,
  ) => void
  /** Folder rows have a menu too (the host can open them in Explorer, 19.5). */
  readonly folderMenu: boolean
}) {
  const text = useFilesText()
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  const element = { list: undefined as HTMLDivElement | undefined }
  // Set after mount: before insertion the element belongs to the template document and is never measured.
  onMount(() => setScroller(element.list))
  const rows = () => props.tree.rows()
  const [focused, setFocused] = createSignal<string>()
  const index = createMemo(() => new Map(rows().map((row, position) => [row.node.path, position])))
  const virtualizer = createVirtualizer({
    get count() {
      return rows().length
    },
    getScrollElement: () => scroller() ?? null,
    estimateSize: () => props.rowHeight,
    overscan: 10,
    get getItemKey() {
      const current = rows()
      return (position: number) => current[position]?.node.path ?? position
    },
  })
  const rowID = (path: string) => `own-files-row-${index().get(path) ?? 0}`
  const current = () => focused() ?? props.active

  // Only when the active path changes (or first appears): expanding folders does not scroll.
  createEffect(
    on(
      () => [props.active, props.active ? index().get(props.active) : undefined] as const,
      ([path, position], previous) => {
        if (!path || position === undefined || (previous?.[0] === path && previous[1] !== undefined)) return
        setFocused(path)
        virtualizer.scrollToIndex(position, { align: "auto" })
      },
    ),
  )

  const focusRow = (path: string | undefined) => {
    if (!path) return
    setFocused(path)
    const position = index().get(path)
    if (position !== undefined) virtualizer.scrollToIndex(position, { align: "auto" })
  }
  const activate = (path: string) => {
    const type = rows()[index().get(path) ?? -1]?.node.type
    if (type === "directory") return props.tree.toggle(path)
    props.onOpen(path)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return
    const list = rows()
    const path = current()
    const position = path !== undefined ? (index().get(path) ?? -1) : -1
    const row = list[position]
    const go = (next: number) => {
      event.preventDefault()
      focusRow(list[Math.max(0, Math.min(list.length - 1, next))]?.node.path)
    }
    if (event.code === "ArrowDown") return go(position + 1)
    if (event.code === "ArrowUp") return go(position < 0 ? 0 : position - 1)
    if (event.code === "Home") return go(0)
    if (event.code === "End") return go(list.length - 1)
    if (!row) return
    if (event.code === "ArrowRight" && row.node.type === "directory") {
      event.preventDefault()
      if (!props.tree.state.expanded[row.node.path]) return void props.tree.expand(row.node.path)
      return focusRow(list[position + 1]?.level === row.level + 1 ? list[position + 1]!.node.path : row.node.path)
    }
    if (event.code === "ArrowLeft") {
      event.preventDefault()
      if (row.node.type === "directory" && props.tree.state.expanded[row.node.path])
        return props.tree.collapse(row.node.path)
      return focusRow(row.level > 0 ? dirname(row.node.path) : row.node.path)
    }
    if (event.code === "Enter" || event.code === "NumpadEnter" || event.code === "Space") {
      event.preventDefault()
      return activate(row.node.path)
    }
    if ((event.code === "F10" && event.shiftKey) || event.code === "ContextMenu") {
      event.preventDefault()
      if (row.node.type !== "file" && !props.folderMenu) return
      const target = document.getElementById(rowID(row.node.path)) ?? (event.currentTarget as HTMLElement)
      const rect = target.getBoundingClientRect()
      props.onMenu(
        row.node.path,
        { x: rect.left + 24, y: rect.bottom },
        event.currentTarget as HTMLElement,
        row.node.type !== "file",
      )
    }
  }

  return (
    <div
      ref={(list) => (element.list = list)}
      class="own-files-tree"
      role="tree"
      tabIndex={0}
      aria-label={text("own.files.tree")}
      aria-activedescendant={current() !== undefined && index().has(current()!) ? rowID(current()!) : undefined}
      data-testid="files-tree"
      onKeyDown={onKeyDown}
    >
      <Show when={rows().length === 0}>
        <p class="own-files-tree-state" data-testid="files-tree-state">
          <Show
            when={props.tree.state.errors[""]}
            fallback={props.tree.state.children[""] ? text("own.files.treeEmpty") : text("own.files.treeLoading")}
          >
            {(message) => (
              <>
                <span role="alert">{text("own.files.treeError", { message: message() })}</span>{" "}
                <button type="button" class="own-files-link" onClick={() => void props.tree.load("", true)}>
                  {text("own.files.retry")}
                </button>
              </>
            )}
          </Show>
        </p>
      </Show>
      <div class="own-files-tree-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>
          {(item) => {
            const row = () => rows()[item.index]
            return (
              <Show when={row()}>
                {(entry) => {
                  const folder = () => entry().node.type === "directory"
                  const open = () => props.tree.state.expanded[entry().node.path] === true
                  return (
                    <div
                      id={rowID(entry().node.path)}
                      role="treeitem"
                      class="own-files-row"
                      aria-level={entry().level + 1}
                      aria-expanded={folder() ? open() : undefined}
                      aria-selected={entry().node.path === props.active}
                      aria-busy={folder() && props.tree.state.loading[entry().node.path] ? true : undefined}
                      data-path={entry().node.path}
                      data-type={entry().node.type}
                      data-focused={entry().node.path === current() ? "" : undefined}
                      title={entry().node.path}
                      style={{
                        transform: `translateY(${item.start}px)`,
                        height: `${props.rowHeight}px`,
                        "padding-inline-start": `${8 + entry().level * 14}px`,
                      }}
                      onClick={() => {
                        setFocused(entry().node.path)
                        activate(entry().node.path)
                      }}
                      onContextMenu={(event) => {
                        if (folder() && !props.folderMenu) return
                        event.preventDefault()
                        setFocused(entry().node.path)
                        props.onMenu(entry().node.path, { x: event.clientX, y: event.clientY }, element.list!, folder())
                      }}
                    >
                      <span class="own-files-twisty" data-open={open() ? "" : undefined}>
                        <Show when={folder()}>
                          <FilesIcon name="chevron" />
                        </Show>
                      </span>
                      <FilesIcon name={folder() ? "folder" : "file"} class="own-files-glyph" />
                      <span class="own-files-name">
                        <bdi>{entry().node.name}</bdi>
                      </span>
                    </div>
                  )
                }}
              </Show>
            )
          }}
        </For>
      </div>
    </div>
  )
}
