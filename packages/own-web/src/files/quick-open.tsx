// Quick open (`Ctrl+P`, 03 §10 `file.open`, §19.4). One combobox over a listbox:
//   - pinned rows first: open tabs, recently opened files and the files this session changed (`session.diff`), ranked
//     locally (mentions `rank`); they cover files the server index does not know yet;
//   - then `fs.find` (type file, limit 50), already ranked by the server: on Windows fff is off by default and the
//     ripgrep index is ranked with fuzzysort (03 §18.12 decision), so the client never re-sorts it. The index is
//     rebuilt at most every 10 s, hence the note under the list. The first `fs.find` of a location builds the index
//     (seconds on a large repository): it is warmed when the box opens and the list says so while it waits.
// Korean IME (03 §12): the input is uncontrolled (never rewritten while composing), requests wait 80 ms after the last
// input and never go out mid-composition, and Enter follows the palette rule (the Enter that commits only commits).
// `name.ts:40` opens line 40.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createImeEnter } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import { rank } from "@/mentions/rank"
import type { FilesController } from "./controller"
import { basename, dirname, normalizePath } from "./paths"
import { useFilesText, type FilesKey } from "./strings"

const DEBOUNCE_MS = 80
const PINNED_LIMIT = 8
const FIND_LIMIT = 50
const INDEXING_AFTER_MS = 400

interface Row {
  readonly path: string
  readonly badge?: "open" | "recent" | "changed"
}

const BADGE: Record<NonNullable<Row["badge"]>, FilesKey> = {
  open: "own.files.badge.open",
  recent: "own.files.badge.recent",
  changed: "own.files.badge.changed",
}

/** Locations whose server index was warmed in this window. */
const warmed = new Set<string>()

export function QuickOpen(props: {
  readonly controller: FilesController
  readonly onOpen: (path: string, line?: number) => void
  readonly onClose: () => void
}) {
  const text = useFilesText()
  const controller = props.controller
  const [state, setState] = createStore({
    query: "",
    line: undefined as number | undefined,
    remote: [] as string[],
    status: "idle" as "idle" | "searching" | "indexing" | "error",
    error: "",
    active: 0,
  })
  const [changed, setChanged] = createSignal<readonly string[]>([])
  const element = { input: undefined as HTMLInputElement | undefined, root: undefined as HTMLDivElement | undefined }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const request = {
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    abort: undefined as AbortController | undefined,
    seq: 0,
  }

  const pinned = (): Row[] => {
    const tabs = controller.tabs()
    const open = (tabs?.tabs ?? []).map((tab) => tab.path)
    const recent = tabs?.recent ?? []
    const seen = new Set<string>()
    const rows = [
      ...open.map((path) => ({ path, badge: "open" as const })),
      ...recent.map((path) => ({ path, badge: "recent" as const })),
      ...changed().map((path) => ({ path, badge: "changed" as const })),
    ].filter((row) => !seen.has(row.path) && Boolean(seen.add(row.path)))
    return rank(rows, state.query, (row) => [basename(row.path), row.path], PINNED_LIMIT)
  }
  const rows = (): Row[] => {
    const top = pinned()
    const known = new Set(top.map((row) => row.path))
    return [...top, ...state.remote.filter((path) => !known.has(path)).map((path) => ({ path }))]
  }
  const optionID = (index: number) => `own-files-qo-${index}`

  onMount(() => {
    element.input?.focus()
    const runtime = controller.runtime()
    const folder = controller.directory()
    const sessionID = controller.sessionID()
    if (!runtime || !folder) return
    const key = `${runtime.key}\n${folder}`
    if (!warmed.has(key)) {
      warmed.add(key)
      void runtime
        .client()
        .file.find({ location: { directory: folder }, query: "", limit: 1 })
        .catch(() => warmed.delete(key))
    }
    if (sessionID)
      void runtime
        .client()
        .session.diff({ sessionID, context: 0 })
        .then((diffs) =>
          setChanged(diffs.filter((diff) => diff.status !== "deleted").map((diff) => normalizePath(diff.file))),
        )
        // A session without a finished turn has no diff yet: nothing to pin.
        .catch(() => undefined)
    const outside = (event: PointerEvent) => {
      if (element.root && !element.root.contains(event.target as Node)) close(false)
    }
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  })
  onCleanup(() => {
    clearTimeout(request.timer)
    request.abort?.abort()
  })

  function close(restore: boolean) {
    props.onClose()
    if (restore) previous?.focus()
  }

  function schedule() {
    clearTimeout(request.timer)
    request.timer = setTimeout(() => search(element.input?.value ?? ""), DEBOUNCE_MS)
  }

  function search(value: string): Promise<void> {
    const match = /^(.*?)(?::(\d+))?$/.exec(value.trim())
    const query = match?.[1] ?? ""
    const line = match?.[2] ? Number(match[2]) : undefined
    setState({ query, line, active: 0 })
    request.abort?.abort()
    const runtime = controller.runtime()
    const folder = controller.directory()
    if (!query || !runtime || !folder) {
      setState({ remote: [], status: "idle" })
      return Promise.resolve()
    }
    const abort = new AbortController()
    request.abort = abort
    const seq = ++request.seq
    const slow = setTimeout(() => {
      if (seq === request.seq && state.status === "searching") setState("status", "indexing")
    }, INDEXING_AFTER_MS)
    setState("status", "searching")
    return runtime
      .client()
      .file.find({ location: { directory: folder }, query, type: "file", limit: FIND_LIMIT }, { signal: abort.signal })
      .then((output) => {
        if (seq !== request.seq) return
        const paths = output.data.filter((entry) => entry.type === "file").map((entry) => normalizePath(entry.path))
        setState({ remote: paths, status: "idle" })
      })
      .catch((error: unknown) => {
        if (seq !== request.seq || abort.signal.aborted) return
        setState({ remote: [], status: "error", error: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => clearTimeout(slow))
  }

  function choose(index: number) {
    const row = rows()[index]
    if (!row) return
    props.onOpen(row.path, state.line)
    close(false)
  }

  const ime = createImeEnter({
    commitOnly: true,
    onEnter: () => {
      // The text typed last may not be searched yet: search now and open once its result landed.
      const value = element.input?.value ?? ""
      const stale = request.timer !== undefined || value.trim().replace(/:\d+$/, "") !== state.query
      clearTimeout(request.timer)
      request.timer = undefined
      void (stale ? search(value) : Promise.resolve()).then(() => choose(state.active))
    },
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (ime.keydown(event)) return
    const code = eventCode(event)
    const count = rows().length
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return close(true)
    }
    if ((code === "ArrowDown" || code === "ArrowUp") && count > 0) {
      event.preventDefault()
      const next = (state.active + (code === "ArrowDown" ? 1 : -1) + count) % count
      setState("active", next)
      document.getElementById(optionID(next))?.scrollIntoView({ block: "nearest" })
    }
  }

  const status = () => {
    if (state.status === "indexing") return text("own.files.quickOpenIndexing")
    if (state.status === "searching") return text("own.files.quickOpenSearching")
    if (state.status === "error") return text("own.files.quickOpenError", { message: state.error })
    if (!state.query) return rows().length ? undefined : text("own.files.quickOpenStart")
    return rows().length ? undefined : text("own.files.quickOpenEmpty")
  }

  return (
    <div
      ref={(root) => (element.root = root)}
      class="own-files-quick"
      role="dialog"
      aria-label={text("own.files.quickOpen")}
      data-testid="files-quick-open"
      data-own-overlay
    >
      <input
        ref={(input) => (element.input = input)}
        class="own-files-quick-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="own-files-qo-list"
        aria-autocomplete="list"
        aria-activedescendant={rows().length ? optionID(state.active) : undefined}
        aria-label={text("own.files.quickOpen")}
        placeholder={text("own.files.quickOpenPlaceholder")}
        autocomplete="off"
        spellcheck={false}
        data-testid="files-quick-input"
        onKeyDown={onKeyDown}
        onKeyUp={ime.listeners.onKeyUp}
        onCompositionStart={ime.listeners.onCompositionStart}
        onCompositionEnd={() => {
          ime.compositionend()
          schedule()
        }}
        onInput={() => {
          ime.input()
          if (!ime.composing()) schedule()
        }}
      />
      <ul
        id="own-files-qo-list"
        class="own-files-quick-list"
        role="listbox"
        aria-label={text("own.files.quickOpenResults")}
      >
        <For each={rows()}>
          {(row, index) => (
            <li
              id={optionID(index())}
              role="option"
              class="own-files-quick-row"
              aria-selected={index() === state.active}
              data-path={row.path}
              onPointerMove={() => index() !== state.active && setState("active", index())}
              onClick={() => choose(index())}
            >
              <span class="own-files-file">
                <bdi>{basename(row.path)}</bdi>
              </span>
              <span class="own-files-dir">
                <bdi>{dirname(row.path)}</bdi>
              </span>
              <Show when={row.badge}>{(badge) => <span class="own-files-badge">{text(BADGE[badge()])}</span>}</Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={status()}>
        {(message) => (
          <p class="own-files-quick-status" role="status" data-testid="files-quick-status">
            {message()}
          </p>
        )}
      </Show>
      <p class="own-files-quick-note">{text("own.files.quickOpenLate")}</p>
    </div>
  )
}
