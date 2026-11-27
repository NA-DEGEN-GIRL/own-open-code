// First-chunk mount points of the MCP module (03 §18.14): `McpLayer` (mounted once by the shell) owns `Ctrl+;` and
// the lazy MCP dialog; `ServerStatusPopover` wraps the sidebar's server status dot and lazy-loads the server panel
// (03 §4.3 "서버 상태 팝오버"). Neither calls the server until opened.
import { createSignal, createUniqueId, lazy, onCleanup, Show, Suspense, type JSX, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import { useData } from "@/data"
import { useShortcut } from "@/keyboard"
import { activeDirectory, activeDirectoryKnown, followWorkspaceRoute } from "@/projects/active"
import { useRouter } from "@/routing/router"
import { useMcpText } from "./strings"

const McpDialog = lazy(() => import("./dialog"))
const ServerPanel = lazy(() => import("./server-panel"))

let openList: ((directory?: string) => void) | undefined

/** Opens the MCP list for a project folder (default: the one on screen); `false` when no layer is mounted. */
export function openMcpList(directory?: string) {
  if (!openList) return false
  openList(directory)
  return true
}

export function McpLayer(props: { readonly shortcut?: boolean }) {
  const data = useData()
  const router = useRouter()
  const [dialog, setDialog] = createSignal<{ readonly directory?: string }>()
  followWorkspaceRoute(router)
  const open = (directory?: string) => setDialog({ directory })
  openList = open
  onCleanup(() => {
    if (openList === open) openList = undefined
  })
  if (props.shortcut !== false) useShortcut("mcp.list", () => void open())
  // Without a folder given, the folder on screen as it becomes known: a page that just opened may not have its
  // session's folder yet, and the dialog waits for it instead of saying no project is open (SM-26).
  return (
    <Show when={dialog()}>
      {(state) => (
        <Portal>
          <Suspense>
            <McpDialog
              directory={state().directory ?? activeDirectory(data.local(), router.route())}
              pending={state().directory === undefined && !activeDirectoryKnown(data.local(), router.route())}
              onClose={() => setDialog(undefined)}
            />
          </Suspense>
        </Portal>
      )}
    </Show>
  )
}

/**
 * The sidebar footer's `● 연결됨` (read out as `이 PC · 연결됨`) as a button with the server panel popover (version, trust mode, guard,
 * MCP summary, browser tool policy, restart). Children are the trigger's content.
 */
export function ServerStatusPopover(
  props: ParentProps<{ readonly class?: string; readonly title?: string; readonly testid?: string }>,
): JSX.Element {
  const text = useMcpText()
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement
  return (
    <>
      <button
        ref={button}
        type="button"
        class={props.class}
        title={props.title}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={id}
        popovertarget={id}
        data-testid={props.testid ?? "server-status-button"}
      >
        {props.children}
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={text("own.server.title")}
        class="fixed m-0 w-[min(320px,calc(100vw-16px))] rounded-[10px] border border-own-border bg-own-raised p-3 text-own-text shadow-[var(--own-shadow-float)] [inset:auto]"
        data-testid="server-panel"
        onToggle={(event) => {
          const opened = event.newState === "open"
          setOpen(opened)
          if (!opened) return
          const rect = button.getBoundingClientRect()
          popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popover.offsetWidth - 8))}px`
          popover.style.top = `${Math.max(8, rect.top - popover.offsetHeight - 6)}px`
        }}
        onKeyDown={(event) => {
          // The popover closes itself on Esc; keep the key from also closing the drawer around it.
          if (event.code === "Escape") event.stopPropagation()
        }}
      >
        <Show when={open()}>
          <Suspense>
            <ServerPanel
              onNavigate={() => popover.hidePopover()}
              onLayout={() => {
                const rect = button.getBoundingClientRect()
                popover.style.top = `${Math.max(8, rect.top - popover.offsetHeight - 6)}px`
              }}
            />
          </Suspense>
        </Show>
      </div>
    </>
  )
}
