// The pane a component renders in (03 §4.1.1). Session view modules (composer, find, switcher, docks) read it to act
// only for the focused pane: shortcuts registered inside a pane are gated by its focus (keyboard ShortcutGate), the
// composer textarea keeps the `#own-composer-input` id only in the focused pane, and lookups of "the" composer's
// controls go through `inFocusedPane`. Outside any pane (harnesses, the single-view tests) everything counts as focused.
import { createContext, useContext, type ParentProps } from "solid-js"
import { ShortcutGate } from "@/keyboard"

export interface PaneInfo {
  readonly id: string
  /** The pane the URL, the header and the keyboard follow. */
  readonly focused: () => boolean
  /** On screen (a hidden pane in tabs mode stops measuring and drops its watches). */
  readonly visible: () => boolean
}

const PaneContext = createContext<PaneInfo>()

export function PaneProvider(props: ParentProps<{ readonly value: PaneInfo }>) {
  return (
    <PaneContext.Provider value={props.value}>
      <ShortcutGate value={props.value.focused}>{props.children}</ShortcutGate>
    </PaneContext.Provider>
  )
}

export function usePane() {
  return useContext(PaneContext)
}

const always = () => true

/** Focus of the surrounding pane; `true` outside panes. */
export function usePaneFocused(): () => boolean {
  return useContext(PaneContext)?.focused ?? always
}

/** The composer textarea's id: the shared `own-composer-input` only in the focused pane (no duplicate ids). */
export function composerInputID(pane: PaneInfo | undefined) {
  return !pane || pane.focused() ? "own-composer-input" : `own-composer-input-${pane.id}`
}

/** `selector` inside the focused pane, else anywhere (one pane, harnesses). */
export function inFocusedPane<T extends Element = HTMLElement>(selector: string): T | null {
  if (typeof document !== "object") return null
  return document.querySelector<T>(`[data-pane-focused] ${selector}`) ?? document.querySelector<T>(selector)
}
