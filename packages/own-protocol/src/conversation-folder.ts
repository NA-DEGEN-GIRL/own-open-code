export * as ConversationFolder from "./conversation-folder.js"

import { Schema } from "effect"

/**
 * 기본 대화 폴더 (03 §5.1, 02 §9.2): the folder a conversation started without choosing a project works in. Every
 * service has its own and decides its built-in default (this PC, an SSH host, another PC); a phone asks the PC's
 * service. The user's choice is kept in that service's own-accounts KV, so every window and device agrees.
 */

/** Longest path the service accepts; Windows' long paths stay far below this. */
export const MAX_PATH = 1024

/** Folder name of the built-in default, under the documents folder (or the home folder where there is none). */
export const FOLDER_NAME = "Own OpenCode"

export const View = Schema.Struct({
  /** Absolute folder that new folderless conversations start in: the user's choice, else {@link View.defaultPath}. */
  path: Schema.String,
  /** The service's built-in default (`기본값으로` goes back to it). */
  defaultPath: Schema.String,
  /** `path` is the user's choice (`conversationFolder.set`); false: the built-in default. */
  custom: Schema.Boolean,
  /** The folder exists now. The built-in default is created on first use (`conversationFolder.ensure`). */
  exists: Schema.Boolean,
}).annotate({ identifier: "Own.ConversationFolder.View" })
export interface View extends Schema.Schema.Type<typeof View> {}

export const SetInput = Schema.Struct({
  /** An absolute folder, created now when missing; `null` goes back to the built-in default. */
  path: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PATH))),
}).annotate({ identifier: "Own.ConversationFolder.SetInput" })
export type SetInput = typeof SetInput.Type

/**
 * Why a folder cannot be the default conversation folder (`conversation_folder_unavailable`): `relative` not absolute,
 * `root` a drive or filesystem root, `home` the home folder itself, `app` inside this app's own folders (OWN_HOME with
 * the app, the vault and the control folder, or the running program's folder), `not_folder` a file, `create_failed`
 * the folder could not be created (a missing drive, no permission, Windows' controlled folder access), `not_writable`
 * a file could not be written in it.
 */
export const Problem = Schema.Literals([
  "relative",
  "root",
  "home",
  "app",
  "not_folder",
  "create_failed",
  "not_writable",
]).annotate({ identifier: "Own.ConversationFolder.Problem" })
export type Problem = typeof Problem.Type

/**
 * 폴더 열기 시작 위치 (03 §18.3): where the folder picker (`폴더 열기…`, the desktop's folder dialog and the in-app
 * picker) starts on this service. Kept with the default conversation folder in the service's KV.
 */
export const PickerView = Schema.Struct({
  /**
   * The user's start folder (absolute), or `null`: the parent of the last opened folder (the client's recent list,
   * the default conversation folder left out), else {@link PickerView.home}.
   */
  start: Schema.NullOr(Schema.String),
  /** The service user's home folder: where the picker starts before any project was opened. */
  home: Schema.String,
}).annotate({ identifier: "Own.ConversationFolder.PickerView" })
export interface PickerView extends Schema.Schema.Type<typeof PickerView> {}

export const PickerSetInput = Schema.Struct({
  /** An existing absolute folder; `null` goes back to the last opened folder's parent. */
  start: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PATH))),
}).annotate({ identifier: "Own.ConversationFolder.PickerSetInput" })
export type PickerSetInput = typeof PickerSetInput.Type

/** Why a folder cannot be the picker's start (`folder_picker_unavailable`): not absolute, missing, or a file. */
export const PickerProblem = Schema.Literals(["relative", "missing", "not_folder"]).annotate({
  identifier: "Own.ConversationFolder.PickerProblem",
})
export type PickerProblem = typeof PickerProblem.Type

/**
 * Folder name of the built-in default on Linux and other systems without a documents convention (an SSH host): in the
 * home folder, visible, lowercase, no space, so it reads and types well in a shell (`cd ~/own-chats`). A host where
 * the older default (`~/Documents/Own OpenCode`, or `~/Own OpenCode` without `~/Documents`) already exists keeps
 * that one until the user chooses another.
 */
export const LINUX_FOLDER_NAME = "own-chats"

/** Longest folder name `folderPicker.create` takes (ext4 and NTFS allow 255 bytes or characters). */
export const MAX_NAME = 255

export const ListInput = Schema.Struct({
  /** An absolute folder of the service's machine (`~` and `~/…` name the service user's home). */
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PATH)),
}).annotate({ identifier: "Own.ConversationFolder.ListInput" })
export type ListInput = typeof ListInput.Type

/** One folder of a `folderPicker.list` answer. */
export const ListEntry = Schema.Struct({
  name: Schema.String,
  /** The service user may not open it (no read or search permission), told from the same `stat`. */
  locked: Schema.Boolean,
  /** The folder's owner by name where the system says it cheaply (Linux, macOS); only on a locked folder. */
  owner: Schema.optional(Schema.String),
}).annotate({ identifier: "Own.ConversationFolder.ListEntry" })
export interface ListEntry extends Schema.Schema.Type<typeof ListEntry> {}

/**
 * 폴더 열기 (03 §18.3, 04 §17.4): the folders inside `path`, for the picker of any service (this PC in a browser or on
 * a phone, an SSH host). Folders that are never a project are left out and counted (`hidden`): `lost+found` at a
 * filesystem root or mount point, Windows' `System Volume Information`, `$Recycle.Bin`, `$WinREAgent` and `Config.Msi`
 * at a drive root. Typing such a path still lists it.
 */
export const ListView = Schema.Struct({
  /** `path` made absolute (`~` expanded, `..` resolved). */
  path: Schema.String,
  entries: Schema.Array(ListEntry),
  hidden: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "Own.ConversationFolder.ListView" })
export interface ListView extends Schema.Schema.Type<typeof ListView> {}

/**
 * Why a folder cannot be listed (`folder_list_unavailable`): `relative` not absolute, `missing` nothing there,
 * `not_folder` a file, `denied` the service user has no permission to read it (`owner` names its owner where known),
 * `failed` any other system error.
 */
export const ListProblem = Schema.Literals(["relative", "missing", "not_folder", "denied", "failed"]).annotate({
  identifier: "Own.ConversationFolder.ListProblem",
})
export type ListProblem = typeof ListProblem.Type

export const CreateInput = Schema.Struct({
  /** The folder the picker shows (absolute, `~` allowed). */
  parent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PATH)),
  /** One folder name: trimmed by the service; no `/`, `\` or NUL, not `.` or `..`, at most {@link MAX_NAME}. */
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NAME * 4)),
}).annotate({ identifier: "Own.ConversationFolder.CreateInput" })
export type CreateInput = typeof CreateInput.Type

export const CreateView = Schema.Struct({
  /** The new folder, absolute. */
  path: Schema.String,
}).annotate({ identifier: "Own.ConversationFolder.CreateView" })
export interface CreateView extends Schema.Schema.Type<typeof CreateView> {}

/**
 * Why `새 폴더` made nothing (`folder_create_unavailable`): `name` an empty or invalid name (a separator, NUL, `.`,
 * `..`, too long, on Windows `<>:"|?*` or a reserved name), `exists` something has that name already (`path` is it),
 * `relative`, `missing` or `not_folder` about the parent, `denied` no permission to write in the parent, `failed` any
 * other system error.
 */
export const CreateProblem = Schema.Literals([
  "name",
  "exists",
  "relative",
  "missing",
  "not_folder",
  "denied",
  "failed",
]).annotate({ identifier: "Own.ConversationFolder.CreateProblem" })
export type CreateProblem = typeof CreateProblem.Type
