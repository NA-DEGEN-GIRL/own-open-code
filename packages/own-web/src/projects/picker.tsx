// Own folder picker (03 §18.3; the same component serves remote hosts later, 04 §17.4). Lazy chunk (R5), mounted by
// `ProjectOpenerLayer` only while open.
// - Browsing: own.accounts `folderPicker.list` (listing.ts: folders the service user cannot open are locked with the
//   reason, folders that are never a project are left out), else `fs.list` at the control location with an absolute
//   `path` (fs.ts) on an older service. The browsed folder never becomes a Location; only the chosen one does, on the
//   confirmation card. `새 폴더` (new-folder.tsx) makes a folder on the service and opens it.
// - Path box (combobox): IME rules (03 §12) through `createImeEnter`; paste an absolute path (quotes from Explorer's
//   "Copy as path" are removed) and Enter lists it; typing under the current folder filters the list; ↑/↓ move, Enter
//   opens the highlighted folder, Alt+↑ goes up. The box is never rewritten while a composition is open (rule 5).
// - Long folders (node_modules, a drive root) are windowed: fixed 32 px rows, only the visible rows plus a few are in
//   the DOM (R2), scroll position read once per frame.
// - Confirmation card: the normalized absolute path, Git state (`vcs.get`), unapproved project plugins (5.7.1), and a
//   refusal for a drive root, the home folder or the control location (01 G15) — those never reach `GET /api/location`.
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { createImeEnter, isImeKey } from "@/ime/ime-enter"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { inputSampler } from "@/perf/event-timing"
import { useRouter } from "@/routing/router"
import {
  checkProject,
  controlOf,
  gitState,
  listFolders,
  resolveProject,
  type ProjectCheck,
  type ResolvedProject,
} from "./fs"
import { browseFolders, canCreate, listFailureText, lockedText, type ListEntry } from "./listing"
import { NewFolder } from "./new-folder"
import { usePickerText } from "./picker-strings"
import {
  baseName,
  crumbs,
  filterNames,
  isAbsolutePath,
  joinPath,
  normalizeInput,
  parentPath,
  pathSep,
  rootsOf,
  samePath,
  tooBroad,
  trimSep,
} from "./path"
import { pickerStart } from "./default-folder"
import { useRecentProjects } from "./recent"
import { useProjectsText } from "./strings"

const ROW = 32
const OVERSCAN = 6
/** `~` or `~/…`: the service user's home, expanded by the service (own.accounts `folderPicker.list`). */
const HOME = /^~([\\/]|$)/

export interface ProjectPickerProps {
  readonly runtime: ServerRuntime
  /** Opens on the confirmation card of this folder (native dialog result that needs a second look). */
  readonly initial?: string
  /** `move`: the folder a session whose folder is gone continues in (03 §8); the wording follows. */
  readonly purpose?: "move"
  /** Bumped when the folder flow is triggered again while this picker is open: focus comes back here. */
  readonly attention?: () => number
  readonly onClose: () => void
  readonly onStart: (project: ResolvedProject) => void
}

interface Row {
  readonly kind: "up" | "dir"
  readonly name: string
  readonly path: string
}

interface Browse {
  path?: string
  names: string[]
  /** The folders the service user cannot open, by name. */
  locked: Record<string, ListEntry>
  hidden: number
  loading: boolean
  error?: "noControl" | "relative" | { readonly message: string }
}

interface Confirm {
  readonly directory: string
  readonly broad?: "root" | "home" | "control"
  readonly checking: boolean
  readonly project?: ResolvedProject
  readonly check?: ProjectCheck
  readonly failed?: boolean
}

export default function ProjectPicker(props: ProjectPickerProps) {
  const i18n = useI18n()
  const text = useProjectsText()
  const router = useRouter()
  const listID = createUniqueId()
  let input!: HTMLInputElement
  let viewport!: HTMLDivElement
  let startButton: HTMLButtonElement | undefined
  let backButton: HTMLButtonElement | undefined
  const pickerText = usePickerText()
  const [browse, setBrowse] = createStore<Browse>({ names: [], locked: {}, hidden: 0, loading: false })
  const [typed, setTyped] = createSignal("")
  const [active, setActive] = createSignal(-1)
  const [confirm, setConfirm] = createSignal<Confirm>()
  const [view, setView] = createStore({ top: 0, height: 320 })
  const recent = useRecentProjects(() => props.runtime)
  const control = () => controlOf(props.runtime)
  const roots = createMemo(() =>
    rootsOf([...recent().map((item) => item.directory), ...(control() ? [control()!] : [])]),
  )
  let token = 0

  /** What narrows the list: the text typed after the current folder, or a relative name. */
  const filter = createMemo(() => {
    const value = typed()
    const base = browse.path
    if (!value || !base || samePath(value, base)) return ""
    const prefix = trimSep(base)
    const withSep = prefix.endsWith(pathSep(prefix)) ? prefix : prefix + pathSep(prefix)
    if (value.toLowerCase().startsWith(withSep.toLowerCase())) return value.slice(withSep.length)
    return isAbsolutePath(value) ? "" : value
  })
  const rows = createMemo<Row[]>(() => {
    const path = browse.path
    if (!path) return []
    const parent = parentPath(path)
    const up: Row[] = parent && !filter() ? [{ kind: "up", name: "..", path: parent }] : []
    return [
      ...up,
      ...filterNames(browse.names, filter()).map((name) => ({
        kind: "dir" as const,
        name,
        path: joinPath(path, name),
      })),
    ]
  })
  const range = createMemo(() => {
    const count = rows().length
    const start = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN)
    const end = Math.min(count, Math.ceil((view.top + view.height) / ROW) + OVERSCAN)
    return { start, end }
  })
  const windowed = createMemo(() => {
    const { start, end } = range()
    return rows()
      .slice(start, end)
      .map((row, offset) => ({ row, index: start + offset }))
  })

  // A filter highlights its first match, so Enter opens it; clearing the filter clears the highlight.
  createEffect(
    on(filter, (value) => {
      const first = rows().findIndex((row) => row.kind === "dir")
      setActive(value && first >= 0 ? first : -1)
      reveal(Math.max(0, active()))
    }),
  )

  async function list(directory: string) {
    const target = normalizeInput(directory)
    const current = ++token
    const where = control()
    if (!where) {
      setBrowse({ loading: false, error: "noControl" })
      return
    }
    setBrowse({ loading: true, error: undefined })
    const before = input.value
    try {
      const listed = await browseFolders(props.runtime, target, () =>
        listFolders(props.runtime.client(), where, target),
      )
      if (current !== token) return
      // The path as typed; `~` as the service resolved it.
      const shown = HOME.test(target) ? listed.path : target
      setBrowse({
        path: shown,
        names: listed.entries.map((entry) => entry.name),
        locked: Object.fromEntries(listed.entries.filter((entry) => entry.locked).map((entry) => [entry.name, entry])),
        hidden: listed.hidden,
        loading: false,
        error: undefined,
      })
      viewport.scrollTop = 0
      setView("top", 0)
      // What the user typed while the listing was out stays and narrows the new list, so Enter opens it: a slow first
      // listing of the start folder must not replace a path typed right after the picker opened.
      if (input.value !== before) return
      setTyped("")
      setActive(-1)
      if (!ime.composing()) input.value = shown
    } catch (error) {
      if (current !== token) return
      setBrowse({ loading: false, error: { message: listFailureText(pickerText, error) } })
    }
  }

  async function choose(directory: string) {
    const target = normalizeInput(directory)
    const broad = tooBroad(target, control())
    if (broad) return showConfirm({ directory: target, broad, checking: false })
    const current = ++token
    showConfirm({ directory: target, checking: true })
    const project = await resolveProject(props.runtime.client(), target).catch(() => undefined)
    if (current !== token) return
    if (!project) return showConfirm({ directory: target, checking: false, failed: true })
    const normalized = tooBroad(project.directory, control())
    if (normalized) return showConfirm({ directory: project.directory, broad: normalized, checking: false })
    showConfirm({ directory: project.directory, project, checking: true })
    // The VCS provider of a just-loaded Location reports late (`{branch: {}}` first): its `vcs.branch.updated`
    // means the answer is ready, so ask again then. That later answer wins over the first one.
    const late: { git?: ProjectCheck["git"] } = {}
    stopGit()
    stopGit = props.runtime.bus.on("vcs.branch.updated", (event) => {
      if (event.location && !samePath(event.location.directory, project.directory)) return
      void gitState(props.runtime, project.directory).then((git) => {
        late.git = git
        setConfirm((state) =>
          state?.project === project && state.check ? { ...state, check: { ...state.check, git } } : state,
        )
      })
    })
    const check = await checkProject(props.runtime, project.directory)
    if (current !== token) return
    setConfirm((state) =>
      state?.project === project
        ? { ...state, check: { ...check, git: late.git ?? check.git }, checking: false }
        : state,
    )
  }
  let stopGit = () => {}

  /** The card replaces the list: move focus into it (the list's buttons are hidden, and Esc needs a target). */
  function showConfirm(state: Confirm) {
    setConfirm(state)
    queueMicrotask(() => (startButton && !startButton.disabled ? startButton : backButton)?.focus())
  }

  /** Enter in the path box: the highlighted folder, else the typed path (absolute, or relative to the list). */
  function go() {
    const row = rows()[active()]
    if (row) return void list(row.path)
    const value = normalizeInput(input.value)
    if (!value) return
    if (isAbsolutePath(value) || HOME.test(value)) return void (control() ? list(value) : choose(value))
    if (browse.path) return void list(joinPath(browse.path, value))
    setBrowse("error", "relative")
  }

  const ime = createImeEnter({ onEnter: go })

  function move(delta: number) {
    const count = rows().length
    if (!count) return
    const next = Math.min(count - 1, Math.max(0, active() + delta))
    setActive(next)
    reveal(next)
  }

  function reveal(index: number) {
    const top = index * ROW
    if (top < viewport.scrollTop) viewport.scrollTop = top
    else if (top + ROW > viewport.scrollTop + view.height) viewport.scrollTop = top + ROW - view.height
  }

  function onKeyDown(event: KeyboardEvent) {
    inputSampler.record(event)
    ime.keydown(event)
    if (isImeKey(event, ime.composing())) return
    if (event.code === "ArrowUp" && event.altKey) {
      event.preventDefault()
      const parent = browse.path && parentPath(browse.path)
      if (parent) void list(parent)
      return
    }
    if (event.code === "ArrowDown" || event.code === "ArrowUp") {
      event.preventDefault()
      move(event.code === "ArrowDown" ? 1 : -1)
    }
  }

  let frame = 0
  const onScroll = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      setView("top", viewport.scrollTop)
    })
  }

  /**
   * Where browsing starts (03 §18.3 폴더 열기 시작 위치): the service's start folder, else the folder that holds the
   * newest project (the default conversation folder left out), else the home folder, else a known root.
   */
  const startFolder = () => pickerStart(props.runtime, recent()) ?? roots()[0]

  onMount(() => {
    const observer = new ResizeObserver(() => setView("height", viewport.clientHeight || 320))
    observer.observe(viewport)
    onCleanup(() => observer.disconnect())
    if (props.initial) void choose(props.initial)
    else if (!control()) setBrowse("error", "noControl")
    else if (startFolder()) void list(startFolder()!)
    requestAnimationFrame(() => input.focus())
  })

  // Web fallback without a control fragment: the control location arrives with `health` (02 §9.1); start then.
  createEffect(
    on(
      control,
      (where) => {
        if (!where || browse.path || browse.loading || confirm() || browse.error !== "noControl") return
        const start = startFolder()
        if (start) void list(start)
        else setBrowse("error", undefined)
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => props.attention?.(),
      () => (confirm() ? (startButton && !startButton.disabled ? startButton : backButton) : input)?.focus(),
      { defer: true },
    ),
  )
  onCleanup(() => {
    token++
    stopGit()
    cancelAnimationFrame(frame)
  })

  const gitLine = (git: ProjectCheck["git"]) => {
    if (!git) return text("own.project.noGit")
    return git.branch ? text("own.project.git", { branch: git.branch }) : text("own.project.gitNoBranch")
  }
  const errorText = () => {
    if (browse.error === "noControl") return text("own.project.noControl")
    if (browse.error === "relative") return text("own.project.relative")
    if (typeof browse.error === "object") return browse.error.message
    return undefined
  }
  const lockedOf = (row: Row) => (row.kind === "dir" ? browse.locked[row.name] : undefined)
  const statusText = () => {
    if (browse.loading) return text("own.project.loading")
    if (!browse.path || browse.error) return undefined
    const hidden = browse.hidden ? ` · ${pickerText("own.picker.hidden", { n: browse.hidden })}` : ""
    if (!browse.names.length) return text("own.project.empty") + hidden
    if (filter() && !rows().length) return text("own.project.noMatch", { query: filter() })
    return text("own.project.count", { n: filter() ? rows().length : browse.names.length }) + hidden
  }

  return (
    <Dialog
      open
      title={text(props.purpose === "move" ? "own.project.move.title" : "own.project.title")}
      onClose={() => props.onClose()}
      testid="project-picker"
      size="wide"
    >
      {/* Keys stay in the modal: global shortcuts (Alt+↑ = previous session, Ctrl+O, …) must not fire behind it. */}
      <div
        class="flex min-h-0 flex-col gap-2"
        onKeyDown={(event) => event.code !== "Escape" && event.stopPropagation()}
      >
        <div class="flex flex-col gap-2" hidden={confirm() !== undefined}>
          <div class="flex items-center gap-2">
            <label class="own-sr-only" for={`${listID}-path`}>
              {i18n.t("own.folder.pathInput")}
            </label>
            <input
              ref={input}
              id={`${listID}-path`}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listID}
              aria-autocomplete="list"
              aria-activedescendant={active() >= 0 ? `${listID}-${active()}` : undefined}
              aria-describedby={`${listID}-hint`}
              inputmode="text"
              autocomplete="off"
              autofocus
              spellcheck={false}
              enterkeyhint="go"
              placeholder={i18n.t("own.folder.pathInput")}
              class="own-input own-mono h-9 min-w-0 flex-1"
              data-testid="project-path"
              onKeyDown={onKeyDown}
              onKeyUp={(event) => ime.keyup(event)}
              onCompositionStart={() => ime.compositionstart()}
              onCompositionEnd={() => ime.compositionend()}
              onInput={(event) => {
                ime.input()
                setTyped(event.currentTarget.value)
                inputSampler.record(event)
              }}
            />
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => go()}>
              {text("own.project.go")}
            </button>
          </div>
          <p id={`${listID}-hint`} class="m-0 text-[12px] text-own-faint">
            {text("own.project.pathHint")}
          </p>
          <Show when={browse.path}>
            {(path) => (
              <nav
                aria-label={text("own.project.crumbs")}
                class="flex flex-wrap items-center gap-0.5 text-[12.5px]"
                data-testid="project-crumbs"
              >
                <For each={crumbs(path())}>
                  {(crumb, index) => (
                    <>
                      <Show when={index() > 0}>
                        <span aria-hidden="true" class="text-own-faint">
                          ›
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="own-mono max-w-[24ch] truncate rounded px-1 py-0.5 hover:bg-own-hover aria-[current=page]:font-semibold"
                        aria-current={index() === crumbs(path()).length - 1 ? "page" : undefined}
                        title={crumb.path}
                        onClick={() => void list(crumb.path)}
                      >
                        {crumb.label}
                      </button>
                    </>
                  )}
                </For>
              </nav>
            )}
          </Show>
          <Show when={recent().length || roots().length}>
            <div class="flex flex-wrap items-center gap-1.5 text-[12px]">
              <Show when={recent().length}>
                <span class="text-own-faint">{text("own.project.recent")}</span>
                <For each={recent().slice(0, 6)}>
                  {(item) => (
                    <button
                      type="button"
                      class="max-w-[18ch] truncate rounded-md bg-own-hover px-2 py-0.5 hover:text-own-text"
                      title={item.directory}
                      data-testid="project-recent"
                      onClick={() => void choose(item.directory)}
                    >
                      {item.name}
                    </button>
                  )}
                </For>
              </Show>
              <Show when={roots().length}>
                <span class="ml-1 text-own-faint">{text("own.project.roots")}</span>
                <For each={roots()}>
                  {(root) => (
                    <button
                      type="button"
                      class="own-mono rounded-md bg-own-hover px-2 py-0.5"
                      data-testid="project-root"
                      onClick={() => void list(root)}
                    >
                      {root}
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>
          <Show when={errorText()}>
            <p class="m-0 text-[12.5px] text-own-danger" role="alert" data-testid="project-error">
              {errorText()}
            </p>
          </Show>
          <div
            ref={viewport}
            id={listID}
            role="listbox"
            aria-label={text("own.project.list")}
            aria-busy={browse.loading}
            tabindex="-1"
            class="relative h-[min(320px,42vh)] overflow-auto rounded-lg border border-own-border"
            data-testid="project-list"
            onScroll={onScroll}
          >
            <div style={{ height: `${rows().length * ROW}px` }} class="relative">
              <Index each={windowed()}>
                {(item) => (
                  <div
                    id={`${listID}-${item().index}`}
                    role="option"
                    aria-selected={active() === item().index}
                    aria-disabled={lockedOf(item().row) ? "true" : undefined}
                    class="absolute inset-x-0 flex cursor-pointer items-center gap-2 px-3 text-[13px] hover:bg-own-hover aria-selected:bg-own-accent-soft aria-selected:shadow-[inset_2px_0_0_var(--own-accent-text)] aria-disabled:text-own-faint"
                    style={{ top: `${item().index * ROW}px`, height: `${ROW}px` }}
                    title={lockedOf(item().row) ? lockedText(pickerText, lockedOf(item().row)!) : undefined}
                    data-testid={item().row.kind === "up" ? "project-up" : "project-entry"}
                    data-name={item().row.name}
                    data-locked={lockedOf(item().row) ? "" : undefined}
                    onClick={() => void list(item().row.path)}
                  >
                    <span aria-hidden="true" class="text-own-faint">
                      {item().row.kind === "up" ? "↑" : lockedOf(item().row) ? "🔒" : "▸"}
                    </span>
                    <span class="min-w-0 truncate">
                      {item().row.kind === "up" ? text("own.project.up") : item().row.name}
                    </span>
                    <Show when={lockedOf(item().row)}>
                      {(entry) => <span class="own-sr-only">{lockedText(pickerText, entry())}</span>}
                    </Show>
                  </div>
                )}
              </Index>
            </div>
          </div>
          <Show when={canCreate(props.runtime)}>
            <div class="flex">
              <NewFolder
                runtime={props.runtime}
                parent={() => (browse.loading ? undefined : browse.path)}
                onMade={(made) => void list(made).then(() => choose(made))}
                onOpen={(existing) => void list(existing).then(() => input.focus())}
                testid="project-new-folder"
              />
            </div>
          </Show>
          <div class="flex items-center gap-2">
            <p
              class="m-0 min-w-0 flex-1 truncate text-[12px] text-own-faint"
              role="status"
              data-testid="project-status"
            >
              <Show when={browse.loading}>
                <Spinner />{" "}
              </Show>
              {statusText()}
            </p>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => props.onClose()}>
              {text("own.project.cancel")}
            </button>
            <button
              type="button"
              class="own-btn own-target"
              data-size="sm"
              data-variant="primary"
              disabled={!browse.path || browse.loading}
              data-testid="project-choose"
              onClick={() => browse.path && void choose(browse.path)}
            >
              {text("own.project.choose")}
            </button>
          </div>
        </div>
        <Show when={confirm()}>
          {(state) => (
            <div class="flex flex-col gap-3" data-testid="project-confirm">
              <p class="m-0 text-[14px] font-medium">
                {text(props.purpose === "move" ? "own.project.move.confirmTitle" : "own.project.confirmTitle")}
              </p>
              <p
                class="own-mono m-0 rounded-lg bg-own-subtle px-3 py-2 text-[12.5px] break-all"
                data-testid="project-confirm-path"
              >
                {state().directory}
              </p>
              <Show
                when={!state().broad}
                fallback={
                  <Notice tone="warn" testid="project-too-broad">
                    {text(`own.project.tooBroad.${state().broad!}`)}
                  </Notice>
                }
              >
                <Show
                  when={!state().failed}
                  fallback={<Notice tone="danger">{text("own.project.resolveFailed")}</Notice>}
                >
                  <p class="m-0 text-[12.5px] text-own-muted" role="status" data-testid="project-confirm-git">
                    <Show when={state().check} fallback={text("own.project.checking")}>
                      {(check) => <>{gitLine(check().git)}</>}
                    </Show>
                  </p>
                  <Show when={state().check?.blockedPlugins}>
                    {(count) => (
                      <Notice tone="warn" testid="project-trust">
                        <p class="m-0">{text("own.project.trustBlocked", { n: count() })}</p>
                        <button
                          type="button"
                          class="own-btn mt-2"
                          data-size="sm"
                          onClick={() => {
                            props.onClose()
                            router.navigate({ name: "settings", section: "plugins" })
                          }}
                        >
                          {text("own.project.trustReview")}
                        </button>
                      </Notice>
                    )}
                  </Show>
                </Show>
              </Show>
              <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  ref={backButton}
                  type="button"
                  class="own-btn own-target"
                  data-size="sm"
                  data-testid="project-back"
                  onClick={() => {
                    token++
                    setConfirm(undefined)
                    queueMicrotask(() => input.focus())
                  }}
                >
                  {text("own.project.back")}
                </button>
                <button
                  ref={startButton}
                  type="button"
                  class="own-btn own-target"
                  data-size="sm"
                  data-variant="primary"
                  disabled={!state().project || !!state().broad}
                  data-testid="project-start"
                  title={state().project ? baseName(state().project!.directory) : undefined}
                  onClick={() => {
                    const project = state().project
                    if (project) props.onStart(project)
                  }}
                >
                  {props.purpose === "move" ? text("own.project.move.start") : i18n.t("own.folder.newSessionHere")}
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
