// Work panel `파일` tab (03 §19.4, §4.7), a lazy chunk (20.2 R5) composed with the session-ui pieces by
// src/adapter/files.tsx (see kit.ts). Narrow panel (the usual 380–420 px), top to bottom:
//
//   [≡] [⌕ 파일 이름으로 찾기 (Ctrl+P)                 ] [⟳]
//   ▸ src                                   ← virtualized tree (38 % of the height while a file is open)
//     router.ts
//   [router.ts ✕][README.md ✕]              ← open tabs of this session
//   src/router.ts · 2.1 KB   [미리보기|원본] [↗] [⋯]  ← session-ui SessionFilePanelV2 toolbar
//   viewer
//
// From 640 px the tree becomes the frame's sidebar. Content follows the session on screen; the tree is per folder.
// While the tab is hidden nothing is fetched and the size observer is off (4.7 "숨긴 탭은 렌더링 작업을 멈춘다").
import "./files.css"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { I18nProvider } from "@opencode/ui/context/i18n"
import { createEffect, createSignal, on, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { uiI18nSource } from "@/adapter/ui-i18n"
import type { ServerKey } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import type { PanelTab } from "@/shell/context"
import type { PanelTabProps } from "@/shell/work-panel"
import { createFilesController, type FilesController } from "./controller"
import { FilesIcon } from "./icons"
import { quickOpenRequests } from "./intents"
import type { FilesKit } from "./kit"
import { FileMenu, type MenuRequest } from "./menu"
import { QuickOpen } from "./quick-open"
import { useFilesText } from "./strings"
import { TabStrip } from "./tab-strip"
import { TreeView } from "./tree-view"
import { FileView, type ViewMode } from "./viewer"

/** From this width the tree sits beside the viewer. */
const SIDE_BY_SIDE = 640

/** The tab module the work panel loads (`LOADERS.files`), built from the session-ui kit by src/adapter/files.tsx. */
export function createFilesTab(kit: FilesKit) {
  return function FilesTab(props: PanelTabProps & { readonly tab?: PanelTab }) {
    return <FilesPanel kit={kit} serverKey={props.serverKey} sessionID={props.sessionID} visible={props.visible} />
  }
}

/** Quick open requests handled by any files panel of this window (the panel stays mounted once opened). */
const handled = { quick: 0 }

export function FilesPanel(props: {
  readonly kit: FilesKit
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}) {
  const i18n = useI18n()
  const text = useFilesText()
  const controller = createFilesController(props)
  return (
    <I18nProvider value={uiI18nSource(i18n.locale)}>
      <DialogProvider>
        <Show
          when={props.sessionID()}
          fallback={
            <p class="own-files-state" data-testid="tab-files">
              {text("own.files.noSession")}
            </p>
          }
        >
          <FilesBody kit={props.kit} controller={controller} visible={props.visible} />
        </Show>
      </DialogProvider>
    </I18nProvider>
  )
}

function FilesBody(props: {
  readonly kit: FilesKit
  readonly controller: FilesController
  readonly visible: () => boolean
}) {
  const host = useHost()
  const text = useFilesText()
  const controller = props.controller
  const [root, setRoot] = createSignal<HTMLElement>()
  const [view, setView] = createStore({
    width: 0,
    treeOpen: true,
    quickOpen: false,
    menu: undefined as MenuRequest | undefined,
    modes: {} as Record<string, ViewMode | undefined>,
  })
  const wide = () => view.width >= SIDE_BY_SIDE
  const rowHeight = () => (host.capabilities.touch ? 36 : 26)
  const active = () => controller.active()

  createEffect(() => {
    const element = root()
    if (!props.visible() || !element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) setView("width", entry.contentRect.width)
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  // Ctrl+P (intents.ts): the request that arrived before this chunk loaded counts too.
  createEffect(
    on(quickOpenRequests, (seq) => {
      if (seq <= handled.quick) return
      handled.quick = seq
      if (controller.directory()) setView("quickOpen", true)
    }),
  )

  const openMenu = (path: string, at: MenuRequest["at"], opener?: HTMLElement, folder = false) => {
    const tab = untrack(active)
    setView("menu", { path, at, opener, folder, line: tab?.path === path ? tab.line : undefined })
  }
  const revealInTree = (path: string) => {
    setView("treeOpen", true)
    void controller.tree()?.reveal(path)
    requestAnimationFrame(() => root()?.querySelector<HTMLElement>("[data-testid=files-tree]")?.focus())
  }

  const tree = (): JSX.Element => (
    <Show when={controller.tree()}>
      {(current) => (
        <TreeView
          tree={current()}
          active={active()?.path}
          rowHeight={rowHeight()}
          onOpen={(path) => void controller.open(path)}
          onMenu={openMenu}
          folderMenu={controller.actions().reveal}
        />
      )}
    </Show>
  )

  return (
    <div
      ref={setRoot}
      class="own-files"
      data-testid="tab-files"
      data-layout={wide() ? "side" : "stack"}
      data-file={active() ? "" : undefined}
    >
      <div class="own-files-bar">
        <button
          type="button"
          class="own-icon-button"
          aria-label={view.treeOpen ? text("own.files.treeHide") : text("own.files.treeShow")}
          title={view.treeOpen ? text("own.files.treeHide") : text("own.files.treeShow")}
          aria-pressed={view.treeOpen}
          data-testid="files-tree-toggle"
          onClick={() => setView("treeOpen", !view.treeOpen)}
        >
          <FilesIcon name="tree" />
        </button>
        <button
          type="button"
          class="own-files-find"
          aria-haspopup="dialog"
          aria-expanded={view.quickOpen}
          data-testid="files-quick-button"
          onClick={() => setView("quickOpen", true)}
        >
          <FilesIcon name="search" />
          <span>{text("own.files.quickOpen")}</span>
          <kbd>Ctrl+P</kbd>
        </button>
        <button
          type="button"
          class="own-icon-button"
          aria-label={text("own.files.refresh")}
          title={text("own.files.refresh")}
          aria-busy={controller.refreshing()}
          data-testid="files-refresh"
          onClick={() => controller.refresh()}
        >
          <FilesIcon name="refresh" />
        </button>
      </div>
      <Show when={!wide() && view.treeOpen}>
        <div class="own-files-tree-pane">{tree()}</div>
      </Show>
      <Show when={(controller.tabs()?.tabs.length ?? 0) > 0}>
        <TabStrip
          tabs={controller.tabs()!.tabs}
          active={active()?.path}
          onActivate={controller.activate}
          onClose={controller.close}
          onMove={controller.move}
        />
      </Show>
      <div class="own-files-main">
        <Show
          when={active()}
          fallback={
            <props.kit.Frame
              sidebar={wide() && view.treeOpen ? <div class="own-files-side">{tree()}</div> : undefined}
              toolbar={false}
            >
              <p class="own-files-state" data-testid="files-empty">
                {text("own.files.empty")}
              </p>
            </props.kit.Frame>
          }
        >
          {(tab) => (
            <FileView
              kit={props.kit}
              controller={controller}
              tab={tab()}
              sidebar={wide() && view.treeOpen ? <div class="own-files-side">{tree()}</div> : undefined}
              mode={view.modes[tab().path] ?? "preview"}
              onMode={(mode) => setView("modes", tab().path, mode)}
              onMenu={(opener) => {
                const rect = opener.getBoundingClientRect()
                openMenu(tab().path, { x: rect.right - 200, y: rect.bottom + 4 }, opener)
              }}
            />
          )}
        </Show>
      </div>
      <FileMenu
        controller={controller}
        request={view.menu}
        onClose={() => setView("menu", undefined)}
        onRevealInTree={revealInTree}
      />
      <Show when={view.quickOpen}>
        {/* Out of the panel: a transformed drawer would otherwise be the fixed box's containing block. */}
        <Portal>
          <QuickOpen
            controller={controller}
            onOpen={(path, line) => void controller.open(path, { line })}
            onClose={() => setView("quickOpen", false)}
          />
        </Portal>
      </Show>
    </div>
  )
}
