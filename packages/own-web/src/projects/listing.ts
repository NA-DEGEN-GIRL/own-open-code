// What both folder pickers browse with (03 §18.3 this PC's own picker, 04 §17.4 an SSH host's): own.accounts
// `folderPicker.list` of the server's own service, which marks folders its user cannot open, leaves out folders that are
// never a project (`lost+found` at a mount point, Windows' system folders at a drive root) and says why a folder cannot
// be listed; and `folderPicker.create` for `새 폴더`. An older service (or a connection without the `prompt` scope)
// lists with core's `fs.list` as before: names only, and no `새 폴더`. Lazy with the pickers; the words are
// picker-strings.ts.
import { OwnRpcError, type ServerRuntime } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import type { I18nParams } from "@/i18n"
import type { PickerKey } from "./picker-strings"

export type ListEntry = OwnOutput<"folderPicker.list">["entries"][number]

export interface Listing {
  /** The folder listed, as the service resolved it (`~` expanded). */
  readonly path: string
  readonly entries: readonly ListEntry[]
  /** Folders left out of the list (still reachable by typing their path). */
  readonly hidden: number
}

/** Why a folder could not be listed (own-protocol `ConversationFolder.ListProblem`). */
export type ListProblem = "relative" | "missing" | "not_folder" | "denied" | "failed"

/** Why `새 폴더` made nothing (own-protocol `ConversationFolder.CreateProblem`). */
export type CreateProblem = "name" | "exists" | "relative" | "missing" | "not_folder" | "denied" | "failed"

export class ListFailure extends Error {
  constructor(
    readonly reason: ListProblem,
    readonly path: string,
    readonly owner?: string,
  ) {
    super(`folder list failed: ${reason}`)
  }
}

export class CreateFailure extends Error {
  constructor(
    readonly reason: CreateProblem | "unsupported",
    readonly path: string,
  ) {
    super(`folder create failed: ${reason}`)
  }
}

/** Services that answered `rpc.method_not_found`: they keep core's listing and offer no `새 폴더`. */
const older = new WeakSet<object>()

/** The folders inside `directory` on the runtime's service; `fallback` is core's listing of names for an older one. */
export async function browseFolders(
  runtime: Pick<ServerRuntime, "rpc">,
  directory: string,
  fallback: () => Promise<readonly string[]>,
): Promise<Listing> {
  if (!own(runtime)) return core(directory, fallback)
  const view = await runtime.rpc.call("folderPicker.list", { path: directory }).catch((error: unknown) => {
    if (error instanceof OwnRpcError && error.type === "rpc.method_not_found") {
      older.add(runtime)
      return undefined
    }
    if (error instanceof OwnRpcError && error.type === "folder_list_unavailable") {
      // SAFETY: own.accounts declares this error's data (`{reason, path, owner?}`) and encodes it with that schema.
      const data = error.data as { reason: ListProblem; path: string; owner?: string }
      throw new ListFailure(data.reason, data.path, data.owner)
    }
    // Any other failure (a plugin that did not load, a dropped request): core's listing this time.
    return undefined
  })
  if (!view) return core(directory, fallback)
  return {
    path: view.path,
    entries: [...view.entries].sort((a, b) => collator.compare(a.name, b.name)),
    hidden: view.hidden,
  }
}

/** `새 폴더` is offered: the service has it (as far as a listing told) and this connection may make folders. */
export function canCreate(runtime: Pick<ServerRuntime, "rpc">) {
  return own(runtime) && runtime.rpc.allowed("folderPicker.create")
}

/** Makes `name` inside `parent` on the runtime's service and answers its path. */
export async function createFolder(runtime: Pick<ServerRuntime, "rpc">, parent: string, name: string) {
  const made = await runtime.rpc.call("folderPicker.create", { parent, name }).catch((error: unknown) => {
    if (error instanceof OwnRpcError && error.type === "rpc.method_not_found") {
      older.add(runtime)
      throw new CreateFailure("unsupported", parent)
    }
    if (error instanceof OwnRpcError && error.type === "folder_create_unavailable") {
      // SAFETY: own.accounts declares this error's data (`{reason, path}`) and encodes it with that schema.
      const data = error.data as { reason: CreateProblem; path: string }
      throw new CreateFailure(data.reason, data.path)
    }
    throw new CreateFailure("failed", parent)
  })
  return made.path
}

/** The picker's line for a listing that failed. */
export function listFailureText(text: (key: PickerKey, params?: I18nParams) => string, error: unknown) {
  if (!(error instanceof ListFailure)) return text("own.picker.list.failed")
  if (error.reason === "denied")
    return error.owner ? text("own.picker.list.denied", { owner: error.owner }) : text("own.picker.list.deniedNoOwner")
  if (error.reason === "missing") return text("own.picker.list.missing", { path: error.path })
  if (error.reason === "not_folder") return text("own.picker.list.not_folder", { path: error.path })
  if (error.reason === "relative") return text("own.picker.list.relative")
  return text("own.picker.list.failed")
}

/** The tooltip of a folder the service user cannot open. */
export function lockedText(text: (key: PickerKey, params?: I18nParams) => string, entry: ListEntry) {
  return entry.owner ? text("own.picker.locked", { owner: entry.owner }) : text("own.picker.lockedNoOwner")
}

/** The picker's line for a `새 폴더` that made nothing. */
export function createFailureText(text: (key: PickerKey, params?: I18nParams) => string, error: unknown) {
  // SAFETY: every reason has its key in the catalogs (picker-strings.ts).
  if (error instanceof CreateFailure) return text(`own.picker.create.${error.reason}` as PickerKey)
  return text("own.picker.create.failed")
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

function own(runtime: Pick<ServerRuntime, "rpc">) {
  return !older.has(runtime) && runtime.rpc.allowed("folderPicker.list")
}

async function core(directory: string, fallback: () => Promise<readonly string[]>): Promise<Listing> {
  const names = await fallback().catch(() => {
    throw new ListFailure("failed", directory)
  })
  return { path: directory, entries: names.map((name) => ({ name, locked: false })), hidden: 0 }
}
