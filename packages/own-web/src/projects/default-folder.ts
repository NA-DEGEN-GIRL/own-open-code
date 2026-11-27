// 기본 대화 폴더 (03 §5.1): the folder a conversation started without choosing a project works in, as the server's
// service decides and stores it (own.accounts `conversationFolder.*`): this PC's for this PC and a phone, an SSH host's
// own for that host. One store per runtime for the window's life: the new-conversation screen, the project selector,
// the sidebar's `폴더 없는 대화` group and 설정 > 일반 read it. Read when the connection comes up (again after every
// reconnect, a service restart may change it) and when `conversationFolder.changed` says another window or device
// changed it. An older service without the methods is `unsupported`: its new conversations keep the old rule (the
// newest conversation's folder). The same store keeps 폴더 열기 시작 위치 (03 §18.3, own.accounts `folderPicker.*`):
// where the folder picker starts on that service.
import { createEffect, createRoot, on } from "solid-js"
import { createStore } from "solid-js/store"
import { OwnRpcError, type ServerRuntime } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import type { Locale } from "@/i18n"
import { parentPath, samePath } from "./path"
import { projectsText } from "./strings"

export type DefaultFolderView = OwnOutput<"conversationFolder.get">
export type FolderPickerView = OwnOutput<"folderPicker.get">

/** Why the service could not use a folder (`conversation_folder_unavailable`, own-protocol `ConversationFolder.Problem`). */
export type DefaultFolderProblem =
  | "relative"
  | "root"
  | "home"
  | "app"
  | "not_folder"
  | "create_failed"
  | "not_writable"

export type DefaultFolderRuntime = Pick<ServerRuntime, "rpc" | "connection"> & {
  readonly own: Pick<ServerRuntime["own"], "on">
}

export type DefaultFolderStore = ReturnType<typeof createDefaultFolder>

const stores = new WeakMap<object, DefaultFolderStore>()

/** The window's store of this runtime's default conversation folder, created and watched on first use. */
export function defaultFolder(runtime: DefaultFolderRuntime) {
  const existing = stores.get(runtime)
  if (existing) return existing
  const store = createRoot(() => createDefaultFolder(runtime))
  stores.set(runtime, store)
  return store
}

/** Whether `directory` is this server's default conversation folder (its current one). */
export function isDefaultFolder(runtime: DefaultFolderRuntime, directory: string | undefined) {
  const view = defaultFolder(runtime).view()
  return !!view && directory !== undefined && samePath(view.path, directory)
}

/**
 * Where the folder picker starts (03 §18.3 폴더 열기 시작 위치): the user's folder, else the parent of the last opened
 * folder (`recent`, newest first, the default conversation folder left out), else the service's home folder.
 * `undefined` before the service answered and without a recent folder: the picker's own fallback then.
 */
export function pickerStart(runtime: DefaultFolderRuntime, recent: readonly { readonly directory: string }[]) {
  const picker = defaultFolder(runtime).picker()
  if (picker?.start) return picker.start
  const last = recent.find((item) => !isDefaultFolder(runtime, item.directory))?.directory
  if (last) return parentPath(last) ?? last
  return picker?.home
}

/** The refusal of a failed `set` or `ensure`, or `undefined` for any other failure (offline, scope, internal). */
export function folderProblem(error: unknown): { reason: DefaultFolderProblem; path: string } | undefined {
  if (!(error instanceof OwnRpcError) || error.type !== "conversation_folder_unavailable") return undefined
  // SAFETY: own.accounts declares this error's data (`{reason, path}`) and encodes it with that schema.
  return error.data as { reason: DefaultFolderProblem; path: string }
}

/** The toast of a new conversation whose default folder could not be prepared (03 §5.1). */
export function defaultFolderFailure(locale: Locale, error: unknown) {
  const problem = folderProblem(error)
  if (problem?.reason === "create_failed" || problem?.reason === "not_writable" || problem?.reason === "not_folder")
    return projectsText(locale, `own.project.defaultFolder.${problem.reason}`, { path: problem.path })
  return projectsText(locale, "own.project.defaultFolder.failed")
}

function createDefaultFolder(runtime: DefaultFolderRuntime) {
  const [state, setState] = createStore<{
    view?: DefaultFolderView
    picker?: FolderPickerView
    unsupported: boolean
    answered: boolean
  }>({ unsupported: false, answered: false })
  let loading: Promise<void> | undefined
  const remember = (view: DefaultFolderView) => setState({ view, unsupported: false })
  const rememberPicker = (picker: FolderPickerView) => setState("picker", picker)
  // An older service (method_not_found) or a build that refuses it: the old rules apply there.
  const old = (error: unknown) =>
    error instanceof OwnRpcError && (error.type === "rpc.method_not_found" || error.type === "remote_managed")

  function load() {
    if (!runtime.rpc.allowed("conversationFolder.get")) {
      setState("answered", true)
      return Promise.resolve()
    }
    loading ??= Promise.all([
      runtime.rpc.call("conversationFolder.get", {}).then(remember, (error: unknown) => {
        if (old(error)) setState({ view: undefined, unsupported: true })
      }),
      runtime.rpc.call("folderPicker.get", {}).then(rememberPicker, (error: unknown) => {
        if (old(error)) setState("picker", undefined)
      }),
    ])
      .then(() => undefined)
      .finally(() => {
        loading = undefined
        setState("answered", true)
      })
    return loading
  }

  createEffect(
    on(
      () => runtime.connection.status(),
      (status) => {
        if (status === "connected") void load()
      },
    ),
  )
  runtime.own.on("conversationFolder.changed", (event) => remember(event.data.folder))
  runtime.own.on("folderPicker.changed", (event) => rememberPicker(event.data.picker))

  return {
    /** What the service answered; `undefined` until it did (or on an older service). */
    view: () => state.view,
    /** The service has not answered yet, for the first time: a moment after the first paint. */
    pending: () => !state.answered && !state.view && !state.unsupported,
    /** The service has no default conversation folder (an older build). */
    unsupported: () => state.unsupported,
    /** The picker's start as the service keeps it (`start: null`: the last opened folder's parent). */
    picker: () => state.picker,
    load,
    /** Creates the folder when it is missing (the first folderless conversation) and answers its view. */
    async ensure() {
      const view = await runtime.rpc.call("conversationFolder.ensure", {})
      remember(view)
      return view
    },
    /** The user's folder, or back to the built-in default with `null` (설정 > 일반). */
    async set(path: string | null) {
      const view = await runtime.rpc.call("conversationFolder.set", { path })
      remember(view)
      return view
    },
    /** 폴더 열기 시작 위치: an existing folder, or back to the last opened folder's parent with `null`. */
    async setStart(start: string | null) {
      const picker = await runtime.rpc.call("folderPicker.set", { start })
      rememberPicker(picker)
      return picker
    },
  }
}
