// Remote folder picker (04 §12.4, §17.4). Same model as the local picker (03 §18.3), with the SSH rules:
// - Browsing is the host service's own.accounts `folderPicker.list` (projects/listing.ts, 2.2.6-own.16: folders the
//   host user cannot open are locked with their owner, `lost+found` at a mount point is left out, a refused listing
//   says why), else on an older host `fs.list` with `location[directory]` = the host's control location from
//   `resolve` (16.6) and an absolute `path`; the remote `$HOME` or the browsed folder never becomes a Location
//   (01 G15). `홈으로` only moves the list to `resolve`'s `home`; `~/…` is typed as the host's home.
// - `새 폴더` (projects/new-folder.tsx) makes a folder on the host through its service and opens it.
// - The chosen folder goes through `agent.realpath` first; a symbolic link opens as its real path with
//   `심볼릭 링크 대신 실제 경로로 엽니다: <realpath>` ([old] ssh-worktree-project-grouping-96). Only then
//   `GET /api/location` makes it a Location on the remote server.
// - `이 폴더에서 새 세션` opens the host's new-session screen; the model @ account default comes from this PC's
//   accounts allowed on the host (04 §12.4).
import { createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { createImeEnter } from "@/ime/ime-enter"
import { Dialog, Notice, Spinner } from "@/limits/kit"
import { checkProject, gitState, resolveProject, type ProjectCheck, type ResolvedProject } from "@/projects/fs"
import {
  baseName,
  crumbs,
  filterNames,
  isAbsolutePath,
  joinPath,
  normalizeInput,
  parentPath,
  samePath,
  tooBroad,
} from "@/projects/path"
import { rememberFolder, useRecentProjects } from "@/projects/recent"
import { useProjectsText } from "@/projects/strings"
import { useRouter } from "@/routing/router"
import type { RemoteStore } from "@/servers"
import { adoptLocalTarget } from "@/servers/new-chat"
import { setNewSessionTarget } from "@/sidebar/target"
import { browseFolders, canCreate, listFailureText, lockedText, type ListEntry } from "@/projects/listing"
import { NewFolder } from "@/projects/new-folder"
import { usePickerText } from "@/projects/picker-strings"
import { folderNames } from "./paths"
import { useRemoteText } from "./strings"

/** Entries rendered at once; a filter narrows longer folders (node_modules). */
const SHOWN = 400
/** One re-check of a just-made Location's Git state in case its `vcs.branch.updated` came and went unseen. */
const GIT_RECHECK_MS = 1_500
/** `~` or `~/…`: the host user's home, expanded by the host's service (own.accounts `folderPicker.list`). */
const HOME = /^~(\/|$)/

interface Confirm {
  readonly requested: string
  readonly directory: string
  readonly symlink: boolean
  readonly checking: boolean
  readonly broad?: "root" | "home" | "control"
  readonly missing?: boolean
  readonly failed?: boolean
  readonly project?: ResolvedProject
  readonly check?: ProjectCheck
}

export function RemotePicker(props: {
  readonly store: RemoteStore
  readonly hostId: string
  readonly onClose: () => void
}) {
  const text = useRemoteText()
  const projects = useProjectsText()
  const i18n = useI18n()
  const data = useData()
  const router = useRouter()
  const store = props.store
  const host = () => store.state.hosts[props.hostId]
  const runtime = () => store.runtime(props.hostId)
  const endpoint = () => store.state.endpoints[props.hostId]
  const control = () => endpoint()?.controlDir
  const recent = useRecentProjects(() => runtime())
  const [path, setPath] = createSignal<string>()
  const [entries, setEntries] = createSignal<readonly ListEntry[]>([])
  const [hidden, setHidden] = createSignal(0)
  const names = createMemo(() => entries().map((entry) => entry.name))
  const locked = createMemo(() => new Map(entries().flatMap((entry) => (entry.locked ? [[entry.name, entry]] : []))))
  const pickerText = usePickerText()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [filter, setFilter] = createSignal("")
  const [confirm, setConfirm] = createSignal<Confirm>()
  let input!: HTMLInputElement
  let token = 0

  const rows = createMemo(() => filterNames(names(), filter()).slice(0, SHOWN))

  async function list(directory: string) {
    const target = normalizeInput(directory)
    const current = runtime()
    const where = control()
    if (!current || !where) return setError(text("own.remote.picker.notConnected"))
    if (!isAbsolutePath(target) && !HOME.test(target)) return setError(projects("own.project.relative"))
    const mine = ++token
    setLoading(true)
    setError(undefined)
    try {
      const listed = await browseFolders(current, target, async () => {
        const output = await current.client().file.list({ location: { directory: where }, path: target })
        return folderNames(output.data, where, target)
      })
      if (mine !== token) return
      // The path as typed (the host's own spelling); `~` as the host's service resolved it.
      const shown = HOME.test(target) ? listed.path : target
      setPath(shown)
      setEntries(listed.entries)
      setHidden(listed.hidden)
      setFilter("")
      if (!ime.composing()) input.value = shown
    } catch (failure) {
      if (mine === token) setError(listFailureText(pickerText, failure))
    } finally {
      if (mine === token) setLoading(false)
    }
  }

  async function choose(directory: string) {
    const requested = normalizeInput(directory)
    const current = runtime()
    if (!current) return
    const mine = ++token
    setConfirm({ requested, directory: requested, symlink: false, checking: true })
    const real = await store.realpath(props.hostId, requested).catch(() => undefined)
    if (mine !== token) return
    if (!real) return setConfirm({ requested, directory: requested, symlink: false, checking: false, failed: true })
    if (!real.exists)
      return setConfirm({ requested, directory: requested, symlink: false, checking: false, missing: true })
    const directoryReal = real.realpath ?? requested
    const symlink = real.isSymlink || !samePath(directoryReal, requested)
    const broad = tooBroad(directoryReal, control())
    if (broad) return setConfirm({ requested, directory: directoryReal, symlink, checking: false, broad })
    setConfirm({ requested, directory: directoryReal, symlink, checking: true })
    // A Location that was just made answers `{branch: {}}` until its VCS provider ran; `vcs.branch.updated` follows
    // (same rule as the local picker) and that later answer wins. Listen before the Location exists, since over a
    // tunnel the event can arrive before `GET /api/location` answers; one delayed re-check covers a missed event.
    const late: { git?: ProjectCheck["git"] } = {}
    let resolved: ResolvedProject | undefined
    const recheck = () => {
      const project = resolved
      if (!project || mine !== token) return
      void gitState(current, project.directory).then((git) => {
        if (!git && late.git) return
        late.git = git
        setConfirm((state) =>
          state?.project === project && state.check ? { ...state, check: { ...state.check, git } } : state,
        )
      })
    }
    stopGit()
    const stopEvent = current.bus.on("vcs.branch.updated", (event) => {
      if (event.location && !samePath(event.location.directory, resolved?.directory ?? directoryReal)) return
      recheck()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    stopGit = () => {
      stopEvent()
      clearTimeout(timer)
    }
    const project = await resolveProject(current.client(), directoryReal).catch(() => undefined)
    if (mine !== token) return
    if (!project) return setConfirm({ requested, directory: directoryReal, symlink, checking: false, failed: true })
    resolved = project
    timer = setTimeout(recheck, GIT_RECHECK_MS)
    setConfirm({ requested, directory: project.directory, symlink, checking: true, project })
    const check = await checkProject(current, project.directory).catch(() => ({
      git: false as const,
      blockedPlugins: 0,
    }))
    if (mine !== token) return
    setConfirm((state) =>
      state?.project === project
        ? { ...state, check: { ...check, git: late.git || check.git }, checking: false }
        : state,
    )
  }
  let stopGit = () => {}
  onCleanup(() => stopGit())

  const gitLine = (git: ProjectCheck["git"]) => {
    if (!git) return projects("own.project.noGit")
    return git.branch ? projects("own.project.git", { branch: git.branch }) : projects("own.project.gitNoBranch")
  }

  function start(project: ResolvedProject) {
    rememberFolder(props.hostId, project)
    setNewSessionTarget({
      serverKey: props.hostId,
      projectID: project.projectID,
      directory: project.directory,
      name: baseName(project.directory),
    })
    // 04 §12.4: the default "모델 @ 계정" of a remote session is this PC's, among the accounts the host may use.
    adoptLocalTarget(props.hostId, data.local())
    props.onClose()
    router.navigate({ name: "project", serverKey: props.hostId, projectID: project.projectID })
  }

  function go() {
    const value = normalizeInput(input.value)
    if (!value) return
    if (isAbsolutePath(value) || HOME.test(value)) return void list(value)
    const base = path()
    if (base) return void list(joinPath(base, value))
    setError(projects("own.project.relative"))
  }

  const ime = createImeEnter({ onEnter: go })

  onMount(() => {
    const home = endpoint()?.home
    if (home) void list(home)
    else setError(text("own.remote.picker.notConnected"))
    requestAnimationFrame(() => input.focus())
  })

  return (
    <Dialog
      open
      size="wide"
      title={text("own.remote.picker.title", { host: host()?.name ?? props.hostId })}
      onClose={props.onClose}
      testid="remote-picker"
    >
      <div
        class="flex min-h-0 flex-col gap-2"
        onKeyDown={(event) => event.code !== "Escape" && event.stopPropagation()}
      >
        <div class="flex flex-col gap-2" hidden={confirm() !== undefined}>
          <div class="flex items-center gap-2">
            <input
              ref={input}
              type="text"
              aria-label={text("own.remote.picker.path")}
              placeholder={text("own.remote.picker.path")}
              class="own-input own-mono h-9 min-w-0 flex-1"
              autocomplete="off"
              spellcheck={false}
              data-testid="remote-picker-path"
              onKeyDown={(event) => void ime.keydown(event)}
              onKeyUp={(event) => ime.keyup(event)}
              onCompositionStart={() => ime.compositionstart()}
              onCompositionEnd={() => ime.compositionend()}
              onInput={(event) => {
                ime.input()
                const value = event.currentTarget.value
                const base = path()
                setFilter(base && value.startsWith(base) ? value.slice(base.length).replace(/^[\\/]+/, "") : "")
              }}
            />
            <button type="button" class="own-btn own-target" data-size="sm" onClick={go}>
              {projects("own.project.go")}
            </button>
            <button
              type="button"
              class="own-btn own-target"
              data-size="sm"
              data-testid="remote-picker-home"
              disabled={!endpoint()?.home}
              onClick={() => endpoint()?.home && void list(endpoint()!.home)}
            >
              {text("own.remote.picker.home")}
            </button>
          </div>
          <p class="m-0 text-[12px] text-own-faint">{text("own.remote.picker.hint")}</p>
          <Show when={path()}>
            {(current) => (
              <nav
                aria-label={projects("own.project.crumbs")}
                class="flex flex-wrap items-center gap-0.5 text-[12.5px]"
                data-testid="remote-picker-crumbs"
              >
                <For each={crumbs(current())}>
                  {(crumb, index) => (
                    <>
                      <Show when={index() > 0}>
                        <span aria-hidden="true" class="text-own-faint">
                          ›
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="own-mono max-w-[24ch] truncate rounded px-1 py-0.5 hover:bg-own-hover"
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
          <Show when={recent().length}>
            <div class="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span class="text-own-faint">{projects("own.project.recent")}</span>
              <For each={recent().slice(0, 6)}>
                {(item) => (
                  <button
                    type="button"
                    class="max-w-[18ch] truncate rounded-md bg-own-hover px-2 py-0.5"
                    title={item.directory}
                    data-testid="remote-picker-recent"
                    onClick={() => void choose(item.directory)}
                  >
                    {item.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={error()}>
            <p class="m-0 text-[12.5px] text-own-danger" role="alert" data-testid="remote-picker-error">
              {error()}
            </p>
          </Show>
          <div
            role="listbox"
            aria-label={projects("own.project.list")}
            aria-busy={loading()}
            class="h-[min(320px,42vh)] overflow-auto rounded-lg border border-own-border"
            data-testid="remote-picker-list"
          >
            <Show when={path() && parentPath(path()!)}>
              {(parent) => (
                <div
                  role="option"
                  aria-selected="false"
                  class="flex h-8 cursor-pointer items-center gap-2 px-3 text-[13px] hover:bg-own-hover"
                  data-testid="remote-picker-up"
                  onClick={() => void list(parent())}
                >
                  <span aria-hidden="true" class="text-own-faint">
                    ↑
                  </span>
                  {projects("own.project.up")}
                </div>
              )}
            </Show>
            <Index each={rows()}>
              {(name) => (
                <div
                  role="option"
                  aria-selected="false"
                  aria-disabled={locked().has(name()) ? "true" : undefined}
                  class="flex h-8 cursor-pointer items-center gap-2 px-3 text-[13px] hover:bg-own-hover aria-disabled:text-own-faint"
                  title={locked().has(name()) ? lockedText(pickerText, locked().get(name())!) : undefined}
                  data-testid="remote-picker-entry"
                  data-name={name()}
                  data-locked={locked().has(name()) ? "" : undefined}
                  onClick={() => path() && void list(joinPath(path()!, name()))}
                >
                  <span aria-hidden="true" class="text-own-faint">
                    {locked().has(name()) ? "🔒" : "▸"}
                  </span>
                  <span class="min-w-0 truncate">{name()}</span>
                  <Show when={locked().get(name())}>
                    {(entry) => <span class="own-sr-only">{lockedText(pickerText, entry())}</span>}
                  </Show>
                </div>
              )}
            </Index>
          </div>
          <Show when={runtime() && canCreate(runtime()!)}>
            <div class="flex">
              <NewFolder
                runtime={runtime()!}
                parent={() => (loading() ? undefined : path())}
                onMade={(made) => void list(made).then(() => choose(made))}
                onOpen={(existing) => void list(existing).then(() => input.focus())}
                testid="remote-picker-new-folder"
              />
            </div>
          </Show>
          <div class="flex items-center gap-2">
            <p
              class="m-0 min-w-0 flex-1 truncate text-[12px] text-own-faint"
              role="status"
              data-testid="remote-picker-status"
            >
              <Show when={loading()}>
                <Spinner />{" "}
              </Show>
              {loading()
                ? projects("own.project.loading")
                : path() && !names().length
                  ? projects("own.project.empty")
                  : path()
                    ? projects("own.project.count", { n: rows().length })
                    : ""}
              {!loading() && hidden() ? ` · ${pickerText("own.picker.hidden", { n: hidden() })}` : ""}
            </p>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={props.onClose}>
              {projects("own.project.cancel")}
            </button>
            <button
              type="button"
              class="own-btn own-target"
              data-size="sm"
              data-variant="primary"
              data-testid="remote-picker-choose"
              disabled={!path() || loading()}
              onClick={() => path() && void choose(path()!)}
            >
              {projects("own.project.choose")}
            </button>
          </div>
        </div>
        <Show when={confirm()}>
          {(state) => (
            <div class="flex flex-col gap-3" data-testid="remote-picker-confirm">
              <p class="m-0 text-[14px] font-medium">{projects("own.project.confirmTitle")}</p>
              <p
                class="own-mono m-0 rounded-lg bg-own-subtle px-3 py-2 text-[12.5px] break-all"
                data-testid="remote-picker-confirm-path"
              >
                {state().directory}
              </p>
              <Show when={state().symlink}>
                <Notice tone="warn" testid="remote-picker-symlink">
                  {text("own.remote.symlink", { path: state().directory })}
                </Notice>
              </Show>
              <Show when={state().missing}>
                <Notice tone="danger">{text("own.remote.picker.missing")}</Notice>
              </Show>
              <Show when={state().broad}>
                {(broad) => <Notice tone="warn">{projects(`own.project.tooBroad.${broad()}`)}</Notice>}
              </Show>
              <Show when={state().failed}>
                <Notice tone="danger">{projects("own.project.resolveFailed")}</Notice>
              </Show>
              <Show when={state().project}>
                <p class="m-0 text-[12.5px] text-own-muted" role="status" data-testid="remote-picker-git">
                  <Show when={state().check} fallback={projects("own.project.checking")}>
                    {/* A fragment keeps the line reactive: the late VCS answer replaces `check` in place. */}
                    {(check) => <>{gitLine(check().git)}</>}
                  </Show>
                </p>
              </Show>
              <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  class="own-btn own-target"
                  data-size="sm"
                  data-testid="remote-picker-back"
                  onClick={() => {
                    token++
                    setConfirm(undefined)
                    queueMicrotask(() => input.focus())
                  }}
                >
                  {projects("own.project.back")}
                </button>
                <button
                  type="button"
                  class="own-btn own-target"
                  data-size="sm"
                  data-variant="primary"
                  data-testid="remote-picker-start"
                  disabled={!state().project || !!state().broad || state().checking}
                  onClick={() => state().project && start(state().project!)}
                >
                  <Show when={state().checking}>
                    <Spinner />
                  </Show>
                  {i18n.t("own.folder.newSessionHere")}
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
