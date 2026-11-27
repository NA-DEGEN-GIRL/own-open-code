// "폴더 열기…" flow (03 §18.3): one controller for every entry point (sidebar button, Ctrl+O, the new-session project
// selector, the palette). The native folder dialog where the host has one — a capability of **local-server** sessions
// only (16.7 `nativeDirectoryPicker`) — otherwise the own picker (lazy chunk, `picker.tsx`) that browses with
// `fs.list` at the control location. Either way the choice becomes a Location through `GET /api/location` and the
// new-session screen of that project opens (`setNewSessionTarget` + the project route, which carries the id only).
// A caller may take the chosen folder instead (`PickOptions`): the missing-folder notice moves its session there
// (03 §8 세션 폴더 없음). Both pickers start at the service's 폴더 열기 시작 위치 (`pickerStart`): the user's folder, else
// the parent of the last opened folder, else the home folder; never wherever Windows showed its dialog last.
//
// One flow per window. Windows' folder dialog takes ~2.5 s to appear and a new Location ~1.5 s to load, and every
// entry point stays live meanwhile (repeated clicks, Ctrl+O key repeat, the palette): a trigger while a flow runs
// starts nothing. `busy()` says what the flow waits for, so the entry points show it the moment they are pressed;
// while the own picker is open, a trigger brings it forward (`attention`).
import { createSignal } from "solid-js"
import { LOCAL, type ServerKey, type ServerRuntime } from "@/data"
import type { OwnHost } from "@/host"
import type { Router } from "@/routing/router"
import { setNewSessionTarget } from "@/sidebar/target"
import { pickerStart } from "./default-folder"
import { controlOf, resolveProject, type ResolvedProject } from "./fs"
import { baseName, tooBroad } from "./path"
import { mergeRecent, openedFolders, rememberFolder } from "./recent"

/** A chosen folder goes to `onPick` instead of the new-session screen; `purpose` words the picker for it. */
export interface PickOptions {
  readonly purpose: "move"
  readonly onPick: (project: ResolvedProject, runtime: ServerRuntime) => void
}

export interface PickerRequest {
  readonly serverKey: ServerKey
  /** Opens straight on the confirmation card of this folder (a native choice that needs a second look). */
  readonly initial?: string
  readonly pick?: PickOptions
}

/** What a running flow waits for: the native dialog, then the chosen folder's Location. */
export type OpenerBusy = "dialog" | "opening"

export function createProjectOpener(input: {
  readonly host: OwnHost
  /** The runtime of a server key; the local runtime when none is given. */
  readonly runtime: (serverKey?: ServerKey) => ServerRuntime | undefined
  readonly router: Router
  /** Where a chosen folder goes; default: the new-session screen of its project. */
  readonly onStart?: (project: ResolvedProject, runtime: ServerRuntime) => void
  /** The flow failed outside the picker (the native dialog did not open); it is already reset. */
  readonly onError?: () => void
}) {
  const [dialog, setDialog] = createSignal<PickerRequest>()
  const [busy, setBusy] = createSignal<OpenerBusy>()
  const [attention, setAttention] = createSignal(0)
  let opener: HTMLElement | undefined

  function start(project: ResolvedProject, runtime: ServerRuntime, pick?: PickOptions) {
    rememberFolder(runtime.key, project)
    if (pick) return pick.onPick(project, runtime)
    if (input.onStart) return input.onStart(project, runtime)
    setNewSessionTarget({
      serverKey: runtime.key,
      projectID: project.projectID,
      directory: project.directory,
      name: baseName(project.directory),
    })
    input.router.navigate({ name: "project", serverKey: runtime.key, projectID: project.projectID })
  }

  async function native(
    runtime: ServerRuntime,
    pickDirectory: (options: { readonly defaultPath?: string }) => Promise<string | null>,
    pick?: PickOptions,
  ) {
    const recent = mergeRecent(runtime.sessions.state, openedFolders(runtime.key))
    const directory = await pickDirectory({ defaultPath: pickerStart(runtime, recent) })
    if (!directory) return
    // G15: a drive root or the home folder never becomes a Location; the card explains why.
    if (tooBroad(directory, controlOf(runtime))) return setDialog({ serverKey: runtime.key, initial: directory, pick })
    setBusy("opening")
    const project = await resolveProject(runtime.client(), directory).catch(() => undefined)
    if (!project) return setDialog({ serverKey: runtime.key, initial: directory, pick })
    start(project, runtime, pick)
  }

  function open(serverKey: ServerKey = LOCAL, pick?: PickOptions) {
    if (busy()) return
    if (dialog()) {
      setAttention((count) => count + 1)
      return
    }
    const runtime = input.runtime(serverKey)
    if (!runtime) return
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const pickDirectory = input.host.files?.pickDirectory
    // 16.7: the native dialog shows this PC's folders, so only the local server may use it.
    if (!input.host.capabilities.nativeDirectoryPicker || runtime.key !== LOCAL || !pickDirectory) {
      setDialog({ serverKey: runtime.key, pick })
      return
    }
    setBusy("dialog")
    void native(runtime, pickDirectory, pick)
      .catch(() => input.onError?.())
      .finally(() => setBusy(undefined))
  }

  return {
    dialog,
    busy,
    /** Counts triggers that arrived while the picker was open; the picker takes focus back on each. */
    attention,
    open: (serverKey?: ServerKey, pick?: PickOptions) => void open(serverKey, pick),
    /** From the picker's "이 폴더에서 새 세션" (or its `pick` wording); once per opened picker. */
    start(project: ResolvedProject) {
      const request = dialog()
      if (!request) return
      setDialog(undefined)
      const runtime = input.runtime(request.serverKey)
      if (runtime) start(project, runtime, request.pick)
    },
    close() {
      setDialog(undefined)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    },
  }
}

export type ProjectOpener = ReturnType<typeof createProjectOpener>

// Entry points without a shared import (palette, new-session selector, Ctrl+O from wherever it is registered) call
// `openProject()`; the one `<ProjectOpenerLayer />` the shell mounts owns the controller and answers.
const [active, setActive] = createSignal<ProjectOpener>()

export function registerProjectOpener(opener: ProjectOpener) {
  setActive(() => opener)
  return () => {
    if (active() === opener) setActive(undefined)
  }
}

/** Opens the folder flow; `false` when no opener is mounted. */
export function openProject(serverKey?: ServerKey, pick?: PickOptions) {
  const opener = active()
  if (!opener) return false
  opener.open(serverKey, pick)
  return true
}

/** What the window's folder flow waits for, for entry points that show it (`여는 중…`). */
export function projectOpenerBusy() {
  return active()?.busy()
}
