// Requests to show something in the files tab, reachable from the first chunk without loading the tab (03 §19.4):
//   - `openFile`: a file link in the conversation (markdown `openLocalFile`), a tool card's `파일 탭에서 열기` (4.5),
//     the review header's `파일 열기` (18.5) and the browser pane's `preview` event (18.17);
//   - `requestQuickOpen`: Ctrl+P (`file.open`, 03 §10) and the palette.
// The shell owns the panel and the routes, so both go out as window events it resolves (navigate to the session
// when another one is on screen, then `shell.openTab("files")`), like review/intents.ts. The request itself waits
// here until the files tab (a lazy chunk) takes it, so it survives the chunk loading.
import { createRoot, createSignal } from "solid-js"
import type { ServerKey } from "@/data"

export interface OpenFileRequest {
  readonly serverKey: ServerKey
  readonly sessionID: string
  /** As written: relative to the session folder or absolute, optionally with `:12`, `:12:3` or `#L12`. */
  readonly path: string
  /** Wins over a line suffix in `path`. */
  readonly line?: number
  /** Folder (relative to the session folder) that relative links resolve against: a markdown file's folder. */
  readonly base?: string
}

export interface QuickOpenRequest {
  readonly serverKey?: ServerKey
  readonly sessionID?: string
}

export const FILE_INTENT = "own:open-file"
export const QUICK_OPEN_INTENT = "own:quick-open"

const state = createRoot(() => {
  const [file, setFile] = createSignal<OpenFileRequest & { readonly seq: number }>()
  const [quick, setQuick] = createSignal(0)
  return { file, setFile, quick, setQuick, seq: 0 }
})

/** Shows `path` of that session in the files tab (opening the tab and navigating there first). */
export function openFile(detail: OpenFileRequest) {
  state.setFile({ ...detail, seq: ++state.seq })
  window.dispatchEvent(new CustomEvent(FILE_INTENT, { detail }))
}

/** The file request the files tab has not taken yet. */
export const pendingFile = state.file

/** Called by the files tab once it showed the request. */
export function takeFile(seq: number) {
  if (state.file()?.seq === seq) state.setFile(undefined)
}

/** Ctrl+P: opens the files tab of the session on screen with the quick open box. */
export function requestQuickOpen(detail: QuickOpenRequest = {}) {
  state.setQuick((value) => value + 1)
  window.dispatchEvent(new CustomEvent(QUICK_OPEN_INTENT, { detail }))
}

/** Increments on every quick open request; the files tab compares it with the last one it handled. */
export const quickOpenRequests = state.quick
