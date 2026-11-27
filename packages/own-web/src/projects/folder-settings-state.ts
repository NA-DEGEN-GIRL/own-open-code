// 설정 > 일반 `기본 대화 폴더` and `폴더 열기 시작 위치` (projects/folder-settings.tsx, 03 §5.1, §18.3): what the rows know
// and do over one service's folder store, apart from their drawing so unit tests drive them with a fake service and a
// fake folder dialog.
import { createSignal } from "solid-js"
import { OwnRpcError } from "@/data"
import { createStatus } from "@/limits/kit"
import type { I18nParams } from "@/i18n"
import { defaultFolder, folderProblem, pickerStart, type DefaultFolderRuntime } from "./default-folder"
import { normalizeInput, parentPath } from "./path"
import type { FolderSettingsKey } from "./folder-settings-strings"

export type FolderRow = "folder" | "start"

export function folderSettingsState(input: {
  readonly runtime: DefaultFolderRuntime
  /** The newest opened folders (`useRecentProjects`), for the start's default rule. */
  readonly recent: () => readonly { readonly directory: string }[]
  /** The native folder dialog where this window has one for this service; else `바꾸기…` opens a path box. */
  readonly pick?: (options: { readonly defaultPath?: string }) => Promise<string | null>
  readonly text: (key: FolderSettingsKey, params?: I18nParams) => string
  /** An SSH host's own folder (설정 > SSH 원격 호스트): a relative path is worded for its home (`~/…`). */
  readonly host?: boolean
}) {
  const store = defaultFolder(input.runtime)
  const [editing, setEditing] = createSignal<{ readonly row: FolderRow; readonly value: string }>()
  const [busy, setBusy] = createSignal(false)
  const status = { folder: createStatus(), start: createStatus() }
  const start = () => pickerStart(input.runtime, input.recent())

  async function save(row: FolderRow, value: string | null) {
    const target = status[row]
    target.clear()
    setBusy(true)
    const done = await (row === "folder" ? store.set(value) : store.setStart(value)).then(
      () => true,
      (error: unknown) => {
        target.error(problem(row, error))
        return false
      },
    )
    setBusy(false)
    if (!done) return false
    setEditing(undefined)
    target.ok(input.text(savedKey(row, value === null)))
    return true
  }

  function problem(row: FolderRow, error: unknown) {
    const reason = row === "folder" ? folderProblem(error)?.reason : startProblem(error)
    if (!reason) return input.text("own.project.folderSetting.failed")
    if (input.host && row === "folder" && reason === "relative")
      return input.text("own.project.folderSetting.hostProblem.relative")
    // SAFETY: the service answers only the reasons its error schema lists, and each has its key in the catalogs.
    return input.text(
      `own.project.${row === "folder" ? "folderSetting" : "startSetting"}.problem.${reason}` as FolderSettingsKey,
    )
  }

  return {
    store,
    editing,
    setEditing,
    busy,
    status,
    /** Where the folder picker starts now (the user's folder, else the last opened folder's parent, else home). */
    start,
    /** This connection may change the folders (`admin`); a phone without it reads them only. */
    editable: () => input.runtime.rpc.allowed("conversationFolder.set"),
    /** `바꾸기…`: the native dialog (opened on the folder, or where it would be created), else the path box. */
    async change(row: FolderRow) {
      const view = store.view()
      if (!view) return
      if (!input.pick) return setEditing({ row, value: row === "folder" ? view.path : (start() ?? "") })
      const from = row === "folder" ? (view.exists ? view.path : parentPath(view.path)) : start()
      const picked = await input.pick({ defaultPath: from }).catch(() => null)
      if (picked) await save(row, picked)
    },
    /** The path box's `저장`. */
    submit() {
      const current = editing()
      if (current) return save(current.row, normalizeInput(current.value))
      return Promise.resolve(false)
    },
    /** `기본값으로`. */
    reset: (row: FolderRow) => save(row, null),
  }
}

function savedKey(row: FolderRow, reset: boolean): FolderSettingsKey {
  if (row === "folder") return reset ? "own.project.folderSetting.resetDone" : "own.project.folderSetting.saved"
  return reset ? "own.project.startSetting.resetDone" : "own.project.startSetting.saved"
}

/** The refusal of a failed `folderPicker.set`, or `undefined` for any other failure. */
function startProblem(error: unknown) {
  if (!(error instanceof OwnRpcError) || error.type !== "folder_picker_unavailable") return undefined
  // SAFETY: own.accounts declares this error's data (`{reason, path}`) and encodes it with that schema.
  return (error.data as { reason: "relative" | "missing" | "not_folder" }).reason
}
