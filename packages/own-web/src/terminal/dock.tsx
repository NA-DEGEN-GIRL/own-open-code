// Terminal under the conversation (03 §4.7.3 `터미널 위치: 대화 아래`): a horizontal panel after the composer (order:
// conversation → dock → composer → terminal, so the composer never moves), 30 % of the column by default, 160 px –
// 70 % by drag. Dragging changes only a CSS variable (R7); the height is saved per window when the drag ends.
// Tablet and phone show it as a bottom sheet whatever the setting (terminal.css). Lazy chunk like the tab.
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { createSignal, Show } from "solid-js"
import { Icon } from "@/shell/icons"
import type { PanelTabProps } from "@/shell/work-panel"
import { TerminalPanel } from "./panel"
import { useTerminalText } from "./strings"

const MIN_HEIGHT = 160
const MAX_SHARE = 0.7
const KEY_STEP = 24
const STORAGE_KEY = "own.web.terminal.dockHeight"

export interface TerminalDockProps extends PanelTabProps {
  /** Collapse button and dragging below the minimum: the shell hides the dock (Ctrl+` shows it again). */
  readonly onCollapse?: () => void
  /** Shows the dock (`Ctrl+Alt+T` while it is hidden). */
  readonly reveal?: () => void
  /** Per-window storage key suffix (`windowKey`), so two windows keep their own height. */
  readonly windowKey?: string
}

export default function TerminalDock(props: TerminalDockProps) {
  const text = useTerminalText()
  const key = () => (props.windowKey ? `${STORAGE_KEY}.${props.windowKey}` : STORAGE_KEY)
  const [height, setHeight] = createSignal(readHeight(key()))
  let root!: HTMLElement
  const max = () => Math.round((root?.parentElement?.clientHeight ?? window.innerHeight) * MAX_SHARE)
  const clamp = (value: number) => Math.round(Math.min(max(), Math.max(MIN_HEIGHT, value)))
  const save = () => {
    const value = height()
    try {
      if (value === undefined) localStorage.removeItem(key())
      else localStorage.setItem(key(), String(value))
    } catch {}
  }
  const keyboard = (event: KeyboardEvent) => {
    const delta = event.code === "ArrowUp" ? KEY_STEP : event.code === "ArrowDown" ? -KEY_STEP : 0
    if (!delta || event.isComposing) return
    event.preventDefault()
    setHeight(clamp(root.clientHeight + delta))
    save()
  }

  return (
    <section
      ref={root}
      class="own-terminal-dock"
      data-testid="terminal-dock"
      aria-label={text("own.terminal.dock")}
      inert={!props.visible()}
      style={{ "--own-terminal-dock-h": height() === undefined ? undefined : `${height()}px` }}
    >
      <ResizeHandle
        direction="vertical"
        edge="start"
        size={root?.clientHeight ?? MIN_HEIGHT}
        min={MIN_HEIGHT}
        max={max()}
        collapseThreshold={props.onCollapse ? MIN_HEIGHT / 2 : 0}
        onCollapse={props.onCollapse}
        onResize={(value) => setHeight(clamp(value))}
        onPointerDown={() => document.addEventListener("pointerup", save, { once: true })}
        role="separator"
        aria-orientation="horizontal"
        aria-label={text("own.terminal.dockResize")}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={max()}
        aria-valuenow={height() ?? undefined}
        tabIndex={0}
        onKeyDown={keyboard}
      />
      <TerminalPanel
        serverKey={props.serverKey}
        sessionID={props.sessionID}
        visible={props.visible}
        placement="dock"
        reveal={props.reveal}
        actions={
          <Show when={props.onCollapse}>
            <button
              type="button"
              class="own-icon-button"
              aria-label={text("own.terminal.dockCollapse")}
              title={text("own.terminal.dockCollapse")}
              data-testid="terminal-dock-collapse"
              onClick={() => props.onCollapse?.()}
            >
              <Icon name="x" />
            </button>
          </Show>
        }
      />
    </section>
  )
}

function readHeight(key: string) {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : undefined
  } catch {
    return undefined
  }
}
