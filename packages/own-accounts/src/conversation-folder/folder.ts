export * as ConversationFolders from "./folder.js"

import fs from "node:fs/promises"
import { Stats, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { ConversationFolder, Kv } from "@own/protocol"
import type { Deps } from "../deps.js"

// 기본 대화 폴더 (03 §5.1): the folder a conversation started without choosing a project works in. The service
// decides its built-in default; the user's choice is one KV row (`{path}`), so every window and device of this
// service agrees. The folder is created on first use (`ensure`, a new folderless conversation) or when the user
// chooses it (`set`), each time with a write check; never at service start.

const Stored = Schema.Struct({ path: Schema.String })
const decode = Schema.decodeUnknownOption(Stored)

type Store = Pick<Deps, "ctx" | "runtime" | "options" | "configDir">

export type Result =
  | { readonly type: "ok"; readonly view: ConversationFolder.View; readonly changed: boolean }
  | { readonly type: "refused"; readonly reason: ConversationFolder.Problem; readonly path: string }

/**
 * The built-in default. Windows: `%USERPROFILE%\Documents\Own OpenCode`, a plain path, never the known folder Windows
 * may redirect into OneDrive, so conversation files are not synced; macOS: `~/Documents/Own OpenCode`. Elsewhere (an
 * SSH host, 2.2.6-own.16): `~/own-chats`, visible, lowercase and without a space, so it reads and types well in a
 * shell; a host where the older default (`~/Documents/Own OpenCode`, else `~/Own OpenCode`) already exists keeps it, so
 * its conversations stay `폴더 없는 대화` and nothing moves. Not OWN_HOME: it holds the app, the vault and the control
 * folder, it goes with an uninstall, and own's protected `OWN_HOME/*.json` deny matches every JSON file below it.
 * `home` is core's (`OPENCODE_TEST_HOME`, else the OS home), so tests never touch the real one.
 */
export function builtin(input: {
  readonly home: string
  readonly platform: NodeJS.Platform
  readonly isFolder: (directory: string) => boolean
}) {
  const api = input.platform === "win32" ? path.win32 : path.posix
  const documents = api.join(input.home, "Documents", ConversationFolder.FOLDER_NAME)
  if (input.platform === "win32" || input.platform === "darwin") return documents
  const older = [documents, api.join(input.home, ConversationFolder.FOLDER_NAME)].find(input.isFolder)
  return older ?? api.join(input.home, ConversationFolder.LINUX_FOLDER_NAME)
}

/** The service's built-in default: plugin option `conversationFolder` (tests), else {@link builtin} for this OS. */
export function defaultPath(deps: Pick<Deps, "options">) {
  if (deps.options.conversationFolder) return path.resolve(deps.options.conversationFolder)
  return builtin({ home: userHome(), platform: process.platform, isFolder: isDirectory })
}

export async function view(deps: Store): Promise<ConversationFolder.View> {
  const fallback = defaultPath(deps)
  const stored = await chosen(deps)
  const current = stored ?? fallback
  return { path: current, defaultPath: fallback, custom: stored !== undefined, exists: await folderExists(current) }
}

/**
 * The user's folder (absolute, or `~/…` in the service user's home), made absolute and created with a write check, or
 * back to the built-in default (`null`). A folder equal to the default is not stored, so it follows the default if a
 * later build moves it.
 */
export async function set(deps: Store, input: string | null): Promise<Result> {
  if (input === null) {
    await deps.ctx.storage.remove(Kv.conversationFolder)
    return { type: "ok", view: await view(deps), changed: true }
  }
  const expanded = expandHome(input)
  const problem = refusal(deps, expanded)
  if (problem) return { type: "refused", reason: problem, path: input }
  const resolved = path.resolve(expanded)
  const made = await prepare(resolved)
  if (made) return { type: "refused", reason: made, path: resolved }
  if (same(resolved, defaultPath(deps))) await deps.ctx.storage.remove(Kv.conversationFolder)
  else await deps.ctx.storage.set(Kv.conversationFolder, { path: resolved })
  return { type: "ok", view: await view(deps), changed: true }
}

/** Creates the current folder when it is missing (first use). `changed`: it was created now. */
export async function ensure(deps: Store): Promise<Result> {
  const current = await view(deps)
  if (current.exists) return { type: "ok", view: current, changed: false }
  const made = await prepare(current.path)
  if (made) return { type: "refused", reason: made, path: current.path }
  return { type: "ok", view: { ...current, exists: true }, changed: true }
}

/**
 * Why `input` cannot be the default conversation folder before anything touches the disk: relative, a drive or
 * filesystem root, the home folder or a folder above it, or this app's own folders (OWN_HOME with the app, the vault
 * and the control folder; own's config folder; the running program's folder) or a folder above one of them, where
 * own's protected-path denies would not cover what the agent reads.
 */
export function refusal(
  deps: Pick<Deps, "runtime" | "configDir">,
  input: string,
): ConversationFolder.Problem | undefined {
  if (!absolute(input)) return "relative"
  const resolved = path.resolve(input)
  if (path.parse(resolved).root === resolved) return "root"
  const home = userHome()
  if (same(resolved, home) || inside(resolved, home)) return "home"
  const own = [deps.runtime.layout.root, deps.configDir, path.dirname(process.execPath)].filter(
    (directory): directory is string => !!directory,
  )
  if (own.some((directory) => same(resolved, directory) || inside(resolved, directory) || inside(directory, resolved)))
    return "app"
  return undefined
}

const StoredStart = Schema.Struct({ start: Schema.String })
const decodeStart = Schema.decodeUnknownOption(StoredStart)

export type PickerResult =
  | { readonly type: "ok"; readonly view: ConversationFolder.PickerView }
  | { readonly type: "refused"; readonly reason: ConversationFolder.PickerProblem; readonly path: string }

/**
 * 폴더 열기 시작 위치 (03 §18.3): the user's start folder of the folder picker, else `null` (clients start at the
 * parent of the last opened folder, else at `home`). A stored folder that is gone or no longer absolute reads `null`.
 */
export async function picker(deps: Pick<Deps, "ctx">): Promise<ConversationFolder.PickerView> {
  const stored = decodeStart(await deps.ctx.storage.get(Kv.folderPicker))
  const start = Option.isSome(stored) && absolute(stored.value.start) ? path.resolve(stored.value.start) : undefined
  return { start: start && (await folderExists(start)) ? start : null, home: userHome() }
}

/** An existing absolute folder (a drive root and the home folder are fine to browse from), or `null` for the rule. */
export async function setPicker(deps: Pick<Deps, "ctx">, input: string | null): Promise<PickerResult> {
  if (input === null) {
    await deps.ctx.storage.remove(Kv.folderPicker)
    return { type: "ok", view: await picker(deps) }
  }
  if (!absolute(input)) return { type: "refused", reason: "relative", path: input }
  const resolved = path.resolve(input)
  const stat = await fs.stat(resolved).catch(() => undefined)
  if (!stat) return { type: "refused", reason: "missing", path: resolved }
  if (!stat.isDirectory()) return { type: "refused", reason: "not_folder", path: resolved }
  await deps.ctx.storage.set(Kv.folderPicker, { start: resolved })
  return { type: "ok", view: await picker(deps) }
}

export type ListResult =
  | { readonly type: "ok"; readonly view: ConversationFolder.ListView }
  | {
      readonly type: "refused"
      readonly reason: ConversationFolder.ListProblem
      readonly path: string
      readonly owner?: string
    }

/**
 * 폴더 열기 (03 §18.3): the folders inside `input` (absolute or `~/…`), a symbolic link to a folder included. Each is
 * stat-ed once on the service (never one request per folder from the client), which tells a folder the service user
 * cannot open (`locked`, with its owner on Linux and macOS). Left out and counted in `hidden`: `lost+found` at a
 * filesystem root or mount point (fsck's recovery folder, readable only by root) and Windows' system folders at a
 * drive root. A listing the system refuses says why (`denied` with the owner, `missing`, `not_folder`).
 */
export async function list(input: string): Promise<ListResult> {
  const expanded = expandHome(input.trim())
  if (!absolute(expanded)) return { type: "refused", reason: "relative", path: input }
  const directory = path.resolve(expanded)
  const stat = await fs.stat(directory).catch((error: unknown) => error)
  if (!(stat instanceof Stats)) return { type: "refused", reason: systemProblem(stat), path: directory }
  if (!stat.isDirectory()) return { type: "refused", reason: "not_folder", path: directory }
  const items = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => error)
  if (!Array.isArray(items)) {
    const reason = systemProblem(items)
    const owner = reason === "denied" ? await ownerName(stat.uid) : undefined
    return { type: "refused", reason, path: directory, ...(owner ? { owner } : {}) }
  }
  const skip = await hiddenNames(
    directory,
    stat,
    items.map((item) => item.name),
  )
  const candidates = items.filter((item) => (item.isDirectory() || item.isSymbolicLink()) && !skip.has(item.name))
  const entries = await Promise.all(
    candidates.map(async (item): Promise<ConversationFolder.ListEntry | undefined> => {
      const child = await fs.stat(path.join(directory, item.name)).catch((error: unknown) => error)
      // A link to a file or a dangling link is no folder; a folder whose stat the system refuses is one we cannot open.
      if (!(child instanceof Stats))
        return item.isDirectory() && systemProblem(child) === "denied" ? { name: item.name, locked: true } : undefined
      if (!child.isDirectory()) return undefined
      if (canOpen(child)) return { name: item.name, locked: false }
      const owner = await ownerName(child.uid)
      return { name: item.name, locked: true, ...(owner ? { owner } : {}) }
    }),
  )
  return {
    type: "ok",
    view: {
      path: directory,
      entries: entries.filter((entry): entry is ConversationFolder.ListEntry => entry !== undefined),
      hidden: items.filter((item) => skip.has(item.name)).length,
    },
  }
}

export type CreateResult =
  | { readonly type: "ok"; readonly view: ConversationFolder.CreateView }
  | { readonly type: "refused"; readonly reason: ConversationFolder.CreateProblem; readonly path: string }

/**
 * `새 폴더` (03 §18.3): one new folder `name` (trimmed) inside `parent`. Never an existing one (`exists` names it, so
 * the picker can offer to open that one), never a name with a separator, NUL, `.` or `..`, or on Windows a character
 * or name Windows refuses.
 */
export async function create(input: ConversationFolder.CreateInput): Promise<CreateResult> {
  const name = input.name.trim().normalize("NFC")
  const parentInput = expandHome(input.parent.trim())
  if (!absolute(parentInput)) return { type: "refused", reason: "relative", path: input.parent }
  const parent = path.resolve(parentInput)
  if (!validName(name)) return { type: "refused", reason: "name", path: path.join(parent, name) }
  const stat = await fs.stat(parent).catch((error: unknown) => error)
  if (!(stat instanceof Stats)) return { type: "refused", reason: systemProblem(stat), path: parent }
  if (!stat.isDirectory()) return { type: "refused", reason: "not_folder", path: parent }
  const target = path.join(parent, name)
  const made = await fs.mkdir(target).then(
    () => undefined,
    (error: unknown) => error ?? new Error("mkdir failed"),
  )
  if (made === undefined) return { type: "ok", view: { path: target } }
  if (code(made) === "EEXIST") return { type: "refused", reason: "exists", path: target }
  const reason = systemProblem(made)
  return { type: "refused", reason: reason === "not_folder" ? "failed" : reason, path: target }
}

/** Windows' reserved device names, with or without an extension (`con.txt` is refused too). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

function validName(name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) return false
  if (Buffer.byteLength(name) > ConversationFolder.MAX_NAME) return false
  if (process.platform !== "win32") return true
  // Windows refuses control characters and these in a name, its reserved device names, and a trailing dot or space.
  // oxlint-disable-next-line no-control-regex
  return !/[\\<>:"|?*\u0000-\u001f]/.test(name) && !RESERVED.test(name) && !/[. ]$/.test(name)
}

/** Windows folders at a drive root that are never a project (system, recycle bin, update and installer leftovers). */
const WINDOWS_ROOT = new Set(["system volume information", "$recycle.bin", "$winreagent", "config.msi"])

/** The names {@link list} leaves out of `directory`. */
async function hiddenNames(directory: string, stat: Stats, names: readonly string[]) {
  if (process.platform === "win32") {
    if (path.parse(directory).root !== directory) return new Set<string>()
    return new Set(names.filter((name) => WINDOWS_ROOT.has(name.toLowerCase())))
  }
  if (!names.includes("lost+found")) return new Set<string>()
  // A filesystem root or a mount point: `/` itself, or its parent is on another device.
  const parent = path.dirname(directory)
  if (parent === directory) return new Set(["lost+found"])
  const above = await fs.stat(parent).catch(() => undefined)
  return above && above.dev !== stat.dev ? new Set(["lost+found"]) : new Set<string>()
}

/** The service user may list `stat`'s folder and enter it (read and search), told from its mode, owner and group. */
function canOpen(stat: Stats) {
  // Windows keeps permissions in ACLs that `stat` does not show; a folder it refuses fails its stat instead.
  if (process.platform === "win32" || !process.getuid) return true
  const uid = process.getuid()
  if (uid === 0) return true
  const member = stat.gid === process.getgid?.() || (process.getgroups?.() ?? []).includes(stat.gid)
  const bits = stat.uid === uid ? stat.mode >> 6 : member ? stat.mode >> 3 : stat.mode
  return (bits & 5) === 5
}

const users: { names?: Promise<Map<number, string>> } = {}

/** The user name of `uid` from `/etc/passwd` (read once per service), else the number; nothing on Windows. */
async function ownerName(uid: number) {
  if (process.platform === "win32") return undefined
  users.names ??= fs.readFile("/etc/passwd", "utf8").then(
    (text) =>
      new Map(
        text.split("\n").flatMap((line) => {
          const fields = line.split(":")
          const id = Number(fields[2])
          return fields[0] && fields[2] && Number.isInteger(id) ? [[id, fields[0]] as const] : []
        }),
      ),
    () => new Map<number, string>(),
  )
  return (await users.names).get(uid) ?? String(uid)
}

function code(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

/** A system error as the picker's reason: ENOENT missing, ENOTDIR not a folder, EACCES/EPERM/EROFS no permission. */
function systemProblem(error: unknown) {
  const value = code(error)
  if (value === "ENOENT") return "missing" as const
  if (value === "ENOTDIR") return "not_folder" as const
  if (value === "EACCES" || value === "EPERM" || value === "EROFS") return "denied" as const
  return "failed" as const
}

/** `~` and `~/…` (also `~\…` on Windows) in the service user's home; anything else as it is. */
function expandHome(input: string) {
  if (input === "~") return userHome()
  if (/^~[\\/]/.test(input)) return path.join(userHome(), input.slice(2))
  return input
}

async function chosen(deps: Pick<Deps, "ctx">) {
  const stored = decode(await deps.ctx.storage.get(Kv.conversationFolder))
  return Option.isSome(stored) && absolute(stored.value.path) ? path.resolve(stored.value.path) : undefined
}

/**
 * Makes `directory` exist and checks that a file can be written in it (Windows' controlled folder access can refuse
 * writes to Documents even where the folder exists). The check file is removed at once.
 */
async function prepare(directory: string): Promise<ConversationFolder.Problem | undefined> {
  const stat = await fs.stat(directory).catch(() => undefined)
  if (stat && !stat.isDirectory()) return "not_folder"
  if (!stat) {
    const created = await fs.mkdir(directory, { recursive: true }).then(
      () => true,
      () => false,
    )
    if (!created) return "create_failed"
  }
  const probe = path.join(directory, `.own-write-check-${process.pid}-${Date.now().toString(36)}`)
  const written = await fs.writeFile(probe, "", { flag: "wx" }).then(
    () => true,
    () => false,
  )
  if (!written) return "not_writable"
  await fs.rm(probe, { force: true }).catch(() => undefined)
  return undefined
}

/** Core's home folder (`Global.Path.home`): the test home when one is set, else the OS user's. */
function userHome() {
  return process.env.OPENCODE_TEST_HOME || os.homedir()
}

function absolute(input: string) {
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(input) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(input)
  return path.isAbsolute(input)
}

/** `child` is strictly below `parent`. */
function inside(parent: string, child: string) {
  const relative = path.relative(fold(parent), fold(child))
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function same(a: string, b: string) {
  return fold(path.resolve(a)) === fold(path.resolve(b))
}

/** Windows compares paths case-insensitively. */
function fold(value: string) {
  return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
}

function isDirectory(directory: string) {
  return statSync(directory, { throwIfNoEntry: false })?.isDirectory() ?? false
}

async function folderExists(directory: string) {
  return (await fs.stat(directory).catch(() => undefined))?.isDirectory() ?? false
}
