// Window-wide palette state: `Ctrl+K`, a toolbar button or a module (`openPalette("…")`) open the same dialog. Kept free
// of UI imports so any chunk can open it; the dialog itself is a lazy chunk (20.2 R5) that `PaletteLayer` renders.
import { createRoot, createSignal } from "solid-js"

export interface PaletteRequest {
  /** Text put in the search box when it opens. */
  readonly query?: string
}

export interface PaletteOpen extends PaletteRequest {
  /** Where focus goes back on close (03 §11). */
  readonly opener: Element | null
  /** Changes on every open, so the dialog resets. */
  readonly seq: number
}

const state = createRoot(() => {
  const [open, setOpen] = createSignal<PaletteOpen>()
  let seq = 0
  return { open, setOpen, next: () => ++seq }
})

/** The open request, or `undefined` while closed. */
export const paletteOpen = state.open

export function openPalette(request: PaletteRequest = {}) {
  const opener = typeof document === "object" ? document.activeElement : null
  state.setOpen({ ...request, opener, seq: state.next() })
}

/** Closes and puts focus back on the element that had it (when it is still there). */
export function closePalette() {
  const open = state.open()
  if (!open) return
  state.setOpen(undefined)
  if (open.opener instanceof HTMLElement && open.opener.isConnected) open.opener.focus({ preventScroll: true })
}

export function togglePalette(request?: PaletteRequest) {
  if (state.open()) return closePalette()
  openPalette(request)
}
