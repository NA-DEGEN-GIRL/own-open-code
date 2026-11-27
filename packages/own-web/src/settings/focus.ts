// "Open the compaction settings at this row" (03 §5.8.4: the account card's `바꾸기…`, the `⋯` menu's `자동 압축
// 설정…`, the switcher model row's `⚙` all scroll to the matching row), and "open 설정 > 프리셋 at 울트라 상한" (07 §2.9:
// the composer's ultra card). Routes carry no anchors, so each request is a tiny signal read once by the settings page.
// Kept free of UI imports so any chunk can use it cheaply.
import { createSignal } from "solid-js"

export interface CompactionFocus {
  readonly accountID?: string
  readonly modelID?: string
  readonly kind?: string
}

const [pending, setPending] = createSignal<CompactionFocus>()

export function focusCompaction(target: CompactionFocus) {
  setPending(target)
}

/** Reactive read; the settings page clears it after scrolling. */
export const compactionFocus = pending

export function clearCompactionFocus() {
  setPending(undefined)
}

const [ultraCaps, setUltraCaps] = createSignal(false)

/** 설정 > 프리셋 scrolls to `울트라 상한` once it shows (the composer's ultra card, 07 §2.9). */
export function focusUltraCaps() {
  setUltraCaps(true)
}

/** Reactive read; the presets page clears it after scrolling. */
export const ultraCapsFocus = ultraCaps

export function clearUltraCapsFocus() {
  setUltraCaps(false)
}
