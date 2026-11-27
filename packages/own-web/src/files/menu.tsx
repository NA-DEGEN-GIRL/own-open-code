// File actions (03 §19.5 "파일 `⋯`"): 에디터에서 열기, 탐색기에서 보기 (only where the host can, editor.ts), 트리에서
// 보기, 경로 복사. One menu per files tab, opened from the viewer's `⋯` button or a tree row's context menu (right
// click, Shift+F10, the Menu key). A folder row has one only where the host can open it: 탐색기에서 열기, 경로 복사.
// A top-layer popover: Esc and outside clicks close it, focus returns to the opener.
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { showToast } from "@/switcher/toast"
import type { FilesController } from "./controller"
import { isAbsolute } from "./paths"
import { useFilesText } from "./strings"

export interface MenuRequest {
  readonly path: string
  readonly line?: number
  /** A folder row of the tree. */
  readonly folder?: boolean
  /** Viewport point (context menu) or the opener's rect (button). */
  readonly at: { readonly x: number; readonly y: number }
  readonly opener?: HTMLElement
}

type Item =
  | { readonly id: string; readonly label: string; readonly run: () => void }
  | { readonly id: string; readonly label: string; readonly href: string }

export function FileMenu(props: {
  readonly controller: FilesController
  readonly request: MenuRequest | undefined
  readonly onClose: () => void
  readonly onRevealInTree: (path: string) => void
}) {
  const text = useFilesText()
  const [menu, setMenu] = createSignal<HTMLDivElement>()
  const failed = (error: unknown) =>
    showToast({
      message: text("own.files.openFailed", { message: error instanceof Error ? error.message : String(error) }),
      tone: "danger",
    })

  const items = (request: MenuRequest): Item[] => {
    const controller = props.controller
    const actions = controller.actions()
    const url = controller.editorUrl(request.path, request.line)
    const editor: Item[] =
      actions.open?.kind === "app"
        ? [
            {
              id: "editor",
              label: text("own.files.openInEditor"),
              run: () => void controller.openInEditor(request.path).catch(failed),
            },
          ]
        : url
          ? [{ id: "editor", label: text("own.files.openInEditor"), href: url }]
          : []
    const reveal: Item[] = actions.reveal
      ? [
          {
            id: "reveal",
            label: text(request.folder ? "own.files.openFolder" : "own.files.reveal"),
            run: () => void controller.reveal(request.path).catch(failed),
          },
        ]
      : []
    const tree: Item[] = isAbsolute(request.path)
      ? []
      : [{ id: "tree", label: text("own.files.revealInTree"), run: () => props.onRevealInTree(request.path) }]
    const copy: Item = {
      id: "copy",
      label: text("own.files.copyPath"),
      run: () =>
        void navigator.clipboard
          .writeText(controller.absolute(request.path))
          .then(() => showToast({ message: text("own.files.copied") }))
          .catch(failed),
    }
    if (request.folder) return [...reveal, copy]
    return [...editor, ...reveal, ...tree, copy]
  }

  createEffect(
    on([() => props.request, menu], ([request, element]) => {
      if (!request || !element) return
      element.showPopover()
      const width = element.offsetWidth
      const height = element.offsetHeight
      element.style.left = `${Math.max(8, Math.min(request.at.x, innerWidth - width - 8))}px`
      element.style.top = `${Math.max(8, Math.min(request.at.y, innerHeight - height - 8))}px`
      element.querySelector<HTMLElement>("[role=menuitem]")?.focus()
    }),
  )

  const close = (restore: boolean) => {
    const opener = props.request?.opener
    menu()?.hidePopover()
    props.onClose()
    if (restore) opener?.focus()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return
    const entries = [...(menu()?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])]
    const index = entries.indexOf(document.activeElement as HTMLElement)
    const move = (next: number) => {
      event.preventDefault()
      entries[(next + entries.length) % entries.length]?.focus()
    }
    if (event.code === "ArrowDown") return move(index + 1)
    if (event.code === "ArrowUp") return move(index - 1)
    if (event.code === "Home") return move(0)
    if (event.code === "End") return move(entries.length - 1)
    if (event.code === "Escape") {
      // The popover closes itself; keep the key from also closing the drawer around the panel.
      event.stopPropagation()
      event.preventDefault()
      close(true)
    }
    if (event.code === "Tab") close(false)
  }

  return (
    <Show when={props.request}>
      {(request) => (
        <div
          ref={setMenu}
          popover="auto"
          role="menu"
          aria-label={text("own.files.more")}
          class="own-files-menu"
          data-testid="files-menu"
          onKeyDown={onKeyDown}
          onToggle={(event) => {
            // Light dismiss (outside click); `close` has already cleared the request otherwise.
            if (event.newState === "closed" && props.request) props.onClose()
          }}
        >
          <For each={items(request())}>
            {(item) =>
              "href" in item ? (
                <a role="menuitem" tabIndex={-1} href={item.href} data-action={item.id} onClick={() => close(false)}>
                  {item.label}
                </a>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  data-action={item.id}
                  onClick={() => {
                    close(item.id !== "tree")
                    item.run()
                  }}
                >
                  {item.label}
                </button>
              )
            }
          </For>
        </div>
      )}
    </Show>
  )
}
