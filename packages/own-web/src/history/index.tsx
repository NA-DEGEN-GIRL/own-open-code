// Composer history module (03 §19.9, gap 25 part): ↑/↓ prompt history (a list for prompts and one for `!` shell
// commands, IME-safe) and per-session draft persistence of what the text draft does not hold — mention chips and
// attachments with their bytes (IndexedDB Blobs), saved 500 ms after a change, on blur and when the page hides.
//
// Wiring (integrator, composer):
//   const history = useComposerHistory({ element, composing: input.composing, mode: () => shell.active() ? "shell"
//     : "normal", chips: suggest.chips, draftKey: key, changed: (text) => { drafts.set(key(), text); resize(el);
//     suggest.reset() } })
//   textarea keydown: `if (suggest.keydown(e)) return; if (input.keydown(e)) return; if (history.keydown(e)) return;
//     shell.keydown(e)` (the IME machine sees every key first; history takes only plain ↑/↓ outside compositions).
//   submit: `history.record(mode, { text, chips })` for prompts, server/client commands and shell commands (the
//     command without `!`), before the chips are taken (it also moves ↑ back to the newest entry).
//   useDraftPersistence({ serverKey, sessionID, draftKey: key, element, chips: suggest.chips, attachments, text: drafts })
//   optional: <HistoryPosition history={history} /> under the box (which entry is on screen).
import { createEffect, on, onCleanup, onMount, Show } from "solid-js"
import { whenIdle } from "./idb"
import type { HistoryMode } from "./model"
import { createHistoryNavigator, type HistoryNavigator, type HistoryNavigatorOptions } from "./navigator"
import { promptHistory, type PromptHistory } from "./store"
import { useHistoryText } from "./strings"
import "./history.css"

export { createDraftExtras, draftExtras, type DraftExtras, type DraftExtrasStore } from "./drafts"
export { idbStore, memoryStore, whenIdle, type KeyValueStore } from "./idb"
export { canNavigate, MAX_HISTORY, pushEntry, step, type HistoryEntry, type HistoryMode } from "./model"
export { createHistoryNavigator, type HistoryNavigator, type HistoryNavigatorOptions } from "./navigator"
export { signature, useDraftPersistence, type DraftPersistenceOptions } from "./persistence"
export { createPromptHistory, promptHistory, type PromptHistory } from "./store"
export { historyEn, historyKo, useHistoryText } from "./strings"
export { featureText, type FeatureText } from "./text"

export interface ComposerHistoryOptions extends Omit<HistoryNavigatorOptions, "history"> {
  /** The app's history unless given (tests). */
  readonly history?: PromptHistory
}

export type ComposerHistory = HistoryNavigator & {
  readonly history: PromptHistory
  /** Records a send; `mode` is `shell` for a `!` command (recorded without the `!`). */
  record(mode: HistoryMode, entry: Parameters<PromptHistory["record"]>[1]): void
}

/** The navigator bound to the app's history: loaded when idle after mount, reset per draft and per mode. */
export function useComposerHistory(options: ComposerHistoryOptions): ComposerHistory {
  const history = options.history ?? promptHistory
  const navigator = createHistoryNavigator({ ...options, history })
  onMount(() => onCleanup(whenIdle(() => void history.load(), 5_000)))
  createEffect(on([options.draftKey, options.mode], () => navigator.reset(), { defer: true }))
  return {
    ...navigator,
    history,
    record(mode, entry) {
      history.record(mode, entry)
      navigator.reset()
    },
  }
}

/** One muted line while a history entry is on screen: `기록 2/14 · ↓ 쓰던 글로`. */
export function HistoryPosition(props: { readonly history: ComposerHistory; readonly mode: () => HistoryMode }) {
  const text = useHistoryText()
  const total = () => props.history.history.entries(props.mode()).length
  return (
    <Show when={props.history.browsing()}>
      <p class="own-hs-position" role="status" data-testid="history-position">
        {text("own.history.position", { index: props.history.index() + 1, total: total() })}
        <span class="own-hs-back">{text("own.history.back")}</span>
      </p>
    </Show>
  )
}
