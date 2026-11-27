export * as Paths from "./paths.js"

import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp, { type FileHandle } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodexSource, Fsx, Store } from "@own/runtime"
import { Schema } from "effect"
import type { Options } from "../options.js"

/**
 * Where own.import reads (09 §2.1, §2.2, IM-D2): the roots, the one allowlist function, Windows path matching and the
 * only file operations on other tools' folders. Every read, stat and listing of a root goes through {@link check}:
 * the path must match its kind's read pattern, must not be on the never-open list, and its real path (junctions
 * resolved) must stay inside the root's real path. Files are opened read-only, with the sharing Bun always grants on
 * Windows (read, write and delete), and are never held between calls: {@link withFile} closes the handle before it
 * resolves, so a tool can still delete or replace the file while own reads it (delete-pending until the handle
 * closes). Clients never pass a path; they pass a `SourceRef` that the index resolves to one of these files.
 */

// ---------------------------------------------------------------------------------------------------------------
// Windows paths (09 §2.2)

/**
 * The form two paths are compared in: a `file://` URI decoded, `/` turned into `\`, the extended-length prefix
 * removed (`\\?\C:\…` → `C:\…`, `\\?\UNC\server\share` → `\\server\share`), repeated separators collapsed, `.` and
 * `..` resolved, no trailing separator except on a drive root, Unicode NFC. The case is kept; {@link key} lowers it
 * for comparison (NTFS ignores case by default).
 */
export function norm(input: string) {
  const slashed = fromFileUri(input).replaceAll("/", "\\")
  const plain = /^\\\\\?\\unc\\/i.test(slashed)
    ? `\\\\${slashed.slice(8)}`
    : /^\\\\[?.]\\/.test(slashed)
      ? slashed.slice(4)
      : slashed
  const unc = /^\\\\[^\\]/.test(plain)
  const drive = unc ? null : /^([A-Za-z]:)(.*)$/.exec(plain)
  const rooted = unc || drive !== null || plain.startsWith("\\")
  const rest = unc ? plain.slice(2) : (drive?.[2] ?? plain)
  const segments = rest.split("\\").reduce<string[]>((out, segment) => {
    if (segment === "" || segment === ".") return out
    // Never above a drive root or a UNC share (its first two segments); a relative path keeps its leading `..`.
    if (segment === ".." && out.length > (unc ? 2 : 0) && out.at(-1) !== "..") return out.slice(0, -1)
    if (segment === ".." && rooted) return out
    return [...out, segment]
  }, [])
  const body = segments.join("\\")
  const joined = unc ? `\\\\${body}` : drive ? `${drive[1]}\\${body}` : rooted ? `\\${body}` : body
  return joined.normalize("NFC")
}

/** {@link norm} lower-cased: the comparison key of a path. */
export function key(input: string) {
  return norm(input).toLowerCase()
}

/** A path as the file system of this platform takes it: {@link norm} on Windows, unchanged elsewhere. */
export function native(input: string) {
  return process.platform === "win32" ? norm(input) : input
}

export type Realpath = (input: string) => string | undefined

/** `fs.realpathSync.native`, or `undefined` when the path does not exist. */
export const realpath: Realpath = (input) => {
  // The only way to ask the sync API whether a path resolves; every failure means "use the string".
  try {
    return fs.realpathSync.native(native(input))
  } catch {
    return undefined
  }
}

/** Whether two paths are the same folder or file: by real path when both exist (junctions, `subst`, 8.3 names). */
export function same(a: string, b: string, resolve: Realpath = realpath) {
  const left = resolve(a)
  const right = resolve(b)
  if (left !== undefined && right !== undefined) return key(left) === key(right)
  return key(a) === key(b)
}

/** Whether `child` is `parent` or lies below it, by real path when both exist, else by normalized string. */
export function inside(child: string, parent: string, resolve: Realpath = realpath) {
  const left = resolve(child)
  const right = resolve(parent)
  if (left !== undefined && right !== undefined) return within(key(left), key(right))
  return within(key(child), key(parent))
}

function within(child: string, parent: string) {
  return child === parent || child.startsWith(parent.endsWith("\\") ? parent : `${parent}\\`)
}

/**
 * Decodes a `file://` URI: `file:///C:/a%20b` and `file://localhost/C:/a%20b` → `C:/a b`, `file://server/share` →
 * `//server/share`.
 */
function fromFileUri(input: string) {
  if (!/^file:\/\//i.test(input)) return input
  const rest = decodePercent(input.slice(7)).replace(/^localhost(?=\/)/i, "")
  if (!rest.startsWith("/")) return `//${rest}`
  return /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest
}

/** Percent-escapes as UTF-8; a malformed sequence becomes U+FFFD instead of failing. */
function decodePercent(text: string) {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    new TextDecoder().decode(Uint8Array.from(run.slice(1).split("%"), (hex) => Number.parseInt(hex, 16))),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Claude Code project folders (09 §2.2)

/**
 * Whether a `projects\<folder>` may hold conversations of `cwd`. Claude Code names the folder after its cwd with every
 * non-alphanumeric character turned into `-` and, over 200 characters, a hash suffix (SDK `_sanitize_path`, MIT).
 * Different paths collide and the suffix differs between runtimes, so this only picks candidates: membership is always
 * decided by the cwd recorded in the file.
 */
export function claudeCandidate(folder: string, cwd: string) {
  const name = folder.toLowerCase()
  return [cwd, norm(cwd)]
    .flatMap((form) => [form.normalize("NFC"), form.normalize("NFD")])
    .map((form) => form.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase())
    .some((sanitized) =>
      sanitized.length <= CLAUDE_FOLDER_MAX
        ? name === sanitized
        : name.startsWith(`${sanitized.slice(0, CLAUDE_FOLDER_MAX)}-`),
    )
}

const CLAUDE_FOLDER_MAX = 200

// ---------------------------------------------------------------------------------------------------------------
// Roots (09 §1.1 IM-D1, §2.1)

export const Kind = Schema.Literals(["codex", "claude-code"])
export type Kind = typeof Kind.Type

/**
 * How a root came to be: the plugin option, `$CODEX_HOME`/`$CLAUDE_CONFIG_DIR`, the profile folder, added, or (skills
 * only, SK2) a codex-multi-provider account home found through its `state.json` ({@link profileRoots}).
 */
export type Origin = "option" | "env" | "default" | "added" | "profile"

export interface Root {
  /** Stable while the root is configured: derived from the kind and the normalized folder, never a path. */
  readonly rootID: string
  readonly kind: Kind
  /** The root folder, normalized ({@link norm}). */
  readonly directory: string
  readonly label: string
  /** One of `import-sources.json`'s extra roots. */
  readonly added: boolean
  readonly origin: Origin
  /** The codex-multi-provider account this root is the home of (SK2). */
  readonly account?: { readonly id: string; readonly alias: string | null }
  /**
   * Where the links of one skill may lead for purpose `skill` (SK2, {@link Reach}); absent: only the root's own skill
   * area, as before.
   */
  readonly reach?: Reach
  /**
   * The root is one skill folder core loads (a project's or own's own skill, `skills.detail`): purpose `skill` reaches
   * every file below it but the never-open names, and nothing outside it.
   */
  readonly whole?: boolean
}

/**
 * What the links of a found skill may reach besides its root's skill area (SK2, 09 §2.1): real-path {@link key}s.
 * `allowed`: the folders core already loads skills from, the other roots' skill areas and the targets the user
 * approved; `blocked`: never, even below an allowed folder (OWN_HOME, `.ssh` and the like, the Windows folder);
 * `roots`: every root's real path, whose files outside its skill area stay closed whatever is allowed.
 */
export interface Reach {
  readonly allowed: ReadonlyArray<string>
  readonly blocked: ReadonlyArray<string>
  readonly roots: ReadonlyArray<{ readonly kind: Kind; readonly real: string }>
}

/** A root added in 설정 > 다른 도구 > `찾을 곳 더하기` (`sources.configure`). */
export const ExtraRoot = Schema.Struct({ kind: Kind, directory: Schema.NonEmptyString })
export type ExtraRoot = typeof ExtraRoot.Type

/** `OWN_HOME/state/import-sources.json`: only the added roots, never anything read from them. */
export const SourcesFile = Schema.Struct({ schemaVersion: Schema.Literal(1), extraRoots: Schema.Array(ExtraRoot) })
export type SourcesFile = typeof SourcesFile.Type

/** The store of `import-sources.json` under `home`: read and written atomically through own-runtime. */
export function sources(home: string) {
  return new Store.JsonFile({
    file: path.join(home, "state", "import-sources.json"),
    schema: SourcesFile,
    fallback: (): SourcesFile => ({ schemaVersion: 1, extraRoots: [] }),
  })
}

export interface RootsInput {
  readonly options: Options.Info
  readonly env?: Readonly<Record<string, string | undefined>>
  /** `%USERPROFILE%`; default `os.homedir()`. */
  readonly homedir?: string
}

const NAMES: Record<Kind, string> = { codex: "Codex", "claude-code": "Claude Code" }

/**
 * The default roots, without I/O: per kind the plugin option `roots` when given (even empty), else the environment
 * variable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), else the folder under the user profile (`.codex`, `.claude`).
 */
export function defaults(input: RootsInput): Root[] {
  const env = input.env ?? process.env
  const profile = input.homedir ?? os.homedir()
  const pick = (kind: Kind, option: ReadonlyArray<string> | undefined, variable: string, folder: string) => {
    if (option !== undefined) return option.map((directory) => root(kind, directory, "option"))
    const fromEnv = env[variable]
    if (fromEnv) return [root(kind, fromEnv, "env")]
    return [root(kind, path.join(profile, folder), "default")]
  }
  return unique([
    ...pick("codex", input.options.roots?.codex, "CODEX_HOME", ".codex"),
    ...pick("claude-code", input.options.roots?.claude, "CLAUDE_CONFIG_DIR", ".claude"),
  ])
}

/** {@link defaults} plus the added roots of `import-sources.json` (an unusable file adds none and is never rewritten). */
export async function roots(input: RootsInput & { readonly file: ReturnType<typeof sources> }): Promise<Root[]> {
  const stored = await input.file.read().catch(() => undefined)
  const added = (stored?.extraRoots ?? []).map((extra) => root(extra.kind, extra.directory, "added"))
  return unique([...defaults(input), ...added])
}

/**
 * The codex-multi-provider control center whose account homes the skills list reads (SK2, 09 §9.1): the option
 * `controlCenter` (`null`: none), else the app's default folder, but only while Codex's root is the default one (no
 * `roots.codex` option): tests and source runs set their roots and so never reach this PC's control center.
 */
export function controlCenter(options: Options.Info) {
  if (options.controlCenter !== undefined) return options.controlCenter ?? undefined
  return options.roots?.codex === undefined ? CodexSource.DEFAULT_CONTROL_CENTER : undefined
}

/**
 * The account homes of a control center as Codex roots (`origin: "profile"`, labelled with the alias), from its
 * `state.json` only (`CodexSource.profileHomes`: no `auth.json` is opened). Skills only: the session import does not
 * read them (its auto-discovery is I3, 09 §1.3).
 */
export async function profileRoots(center: string | undefined): Promise<Root[]> {
  if (center === undefined) return []
  const homes = await CodexSource.profileHomes(center)
  return homes.map((home) => ({
    ...root("codex", home.home, "profile"),
    label: `Codex · ${home.alias ?? home.profileID}`,
    account: { id: home.profileID, alias: home.alias },
  }))
}

/**
 * The roots the skills list reads (09 §9.1): {@link roots} and the account homes ({@link profileRoots}) after them. An
 * added root that is an account home keeps its place and gets the account.
 */
export async function skillRoots(input: RootsInput & { readonly file: ReturnType<typeof sources> }) {
  const [base, profiles] = await Promise.all([roots(input), profileRoots(controlCenter(input.options))])
  const known = new Map(profiles.map((item) => [item.rootID, item]))
  const tagged = base.map((item) => {
    const profile = known.get(item.rootID)
    return profile?.account === undefined ? item : { ...item, account: profile.account }
  })
  return unique([...tagged, ...profiles])
}

/** Replaces the added roots (normalized, without repeats) and returns what was stored. */
export async function configure(file: ReturnType<typeof sources>, extraRoots: ReadonlyArray<ExtraRoot>) {
  const next = unique(extraRoots.map((extra) => root(extra.kind, extra.directory, "added"))).map((item) => ({
    kind: item.kind,
    directory: item.directory,
  }))
  const written = await file.write({ schemaVersion: 1, extraRoots: next })
  return written.extraRoots
}

export function rootID(kind: Kind, directory: string) {
  const digest = createHash("sha256")
    .update(`${kind}\0${key(directory)}`)
    .digest("hex")
    .slice(0, 12)
  return `${kind === "codex" ? "codex" : "claude"}-${digest}`
}

function root(kind: Kind, directory: string, origin: Origin): Root {
  const normalized = norm(directory)
  const label = origin === "env" || origin === "default" ? NAMES[kind] : `${NAMES[kind]} · ${normalized}`
  return { rootID: rootID(kind, normalized), kind, directory: normalized, label, added: origin === "added", origin }
}

/** The first root of each (kind, folder): defaults win over added ones. */
function unique(list: ReadonlyArray<Root>) {
  return list.filter((item, index) => list.findIndex((other) => other.rootID === item.rootID) === index)
}

/** Why a root cannot be used (`sources.list`, `sources.configure`). */
export type Problem = "missing" | "unreadable" | "path_denied"

/**
 * `path_denied` for a relative path, a network share, or a folder own never reads (its last segment is a never-open
 * folder of that kind, e.g. `.claude\file-history`); `missing` when there is no such folder; `unreadable` when it
 * cannot be stat'ed. One stat, nothing opened.
 */
export async function problem(item: Pick<Root, "kind" | "directory">): Promise<Problem | undefined> {
  if (denied(item)) return "path_denied"
  const stat = await fsp.stat(native(item.directory)).catch((error: unknown) => Fsx.code(error) ?? "EIO")
  if (typeof stat === "string") return stat === "ENOENT" || stat === "ENOTDIR" ? "missing" : "unreadable"
  if (!stat.isDirectory()) return "missing"
  return undefined
}

/**
 * A root own never reads (09 §2.1), without I/O: a relative path, a network share (`\\server\share`, also through
 * `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or a hand-edited `import-sources.json`), or a never-open folder as its last segment.
 * {@link problem} reports it, the index skips the root and {@link check} refuses its files.
 */
export function denied(item: Pick<Root, "kind" | "directory" | "whole">) {
  const directory = norm(item.directory)
  const absolute = process.platform === "win32" ? /^[A-Za-z]:\\/.test(directory) : path.posix.isAbsolute(item.directory)
  const last = directory.split("\\").at(-1)?.toLowerCase() ?? ""
  return !absolute || (item.whole !== true && NEVER_FOLDERS[item.kind].has(last))
}

/** Whether a folder (a project or a conversation's cwd, not a root) exists: one stat, nothing opened. */
export function folderExists(directory: string) {
  return fsp.stat(native(directory)).then(
    (stat) => stat.isDirectory(),
    () => false,
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The allowlist (09 §2.1)

/**
 * `read`: conversation files; `copy`: the Codex state DB and its `-wal`, only to copy them (2.3); `list`: folders;
 * `skill`: files and folders of the skill areas (09 §9.1): `skills\**` of either kind and Claude Code's
 * `plugins\cache\**` and `plugins\marketplaces\**`.
 */
export type Purpose = "read" | "copy" | "list" | "skill"

export type Denied = "path_denied" | "missing"

export type Checked =
  | { readonly ok: true; readonly path: string; readonly real: string }
  | { readonly ok: false; readonly reason: Denied }

/**
 * The one allowlist function. The root must not be {@link denied}; `file` must lie below it and match the kind's pattern
 * for `purpose`, and must not be on the never-open list; the same holds for its real path below the root's real path,
 * so a junction or a link cannot lead out of the root or onto a never-open file under an allowed name. A path that
 * does not exist is `missing`. `resolve` is injected by tests (`subst` drives).
 */
export function check(item: Root, file: string, purpose: Purpose, resolve: Realpath = realpath): Checked {
  if (denied(item) || !allowed(item, relative(key(file), key(item.directory)), purpose))
    return { ok: false, reason: "path_denied" }
  const rootReal = resolve === realpath ? rootRealpath(item.directory) : resolve(item.directory)
  const fileReal = resolve(file)
  if (rootReal === undefined || fileReal === undefined) return { ok: false, reason: "missing" }
  if (allowed(item, relative(key(fileReal), key(rootReal)), purpose)) return { ok: true, path: native(file), real: fileReal }
  // A link of a found skill (SK2): its target only where the skill's reach allows, never onto a never-open name.
  if (purpose === "skill" && item.reach !== undefined && reachable(item.reach, fileReal))
    return { ok: true, path: native(file), real: fileReal }
  return { ok: false, reason: "path_denied" }
}

/** {@link permitted}, or for a {@link Root.whole} root anything below it but the never-open names (purpose `skill`). */
function allowed(item: Root, rel: ReadonlyArray<string> | undefined, purpose: Purpose) {
  if (item.whole) return purpose === "skill" && rel !== undefined && !neverName(rel.at(-1) ?? "", "skill")
  return permitted(item.kind, rel, purpose)
}

/**
 * Whether a link may lead to `real` (SK2): below an allowed folder, not below a blocked one, not into a root outside
 * its skill area, and not a never-open name.
 */
export function reachable(reach: Reach, real: string) {
  const target = key(real)
  if (neverName(target.split("\\").at(-1) ?? "", "skill")) return false
  if (reach.blocked.some((folder) => within(target, folder))) return false
  if (reach.roots.some((root) => within(target, root.real) && !permitted(root.kind, relative(target, root.real), "skill")))
    return false
  return reach.allowed.some((folder) => within(target, folder))
}

/** Whether `real` lies in the skill area of one of `reach`'s roots (a link between two roots' skills). */
export function inSkillArea(reach: Pick<Reach, "roots">, real: string) {
  const target = key(real)
  return reach.roots.some((root) => within(target, root.real) && permitted(root.kind, relative(target, root.real), "skill"))
}

/** The real-path {@link key} of a folder (resolved when it exists), for a {@link Reach}. */
export function realKey(folder: string) {
  return key(realpath(folder) ?? folder)
}

/**
 * Real paths of roots by {@link key}, resolved once per process: a cold index checks thousands of files, and resolving
 * the root again for each blocked the Worker for seconds (IG5). Only found roots are kept, so a root created later is
 * still found. A stale entry can only refuse (each file's real path is resolved anew and must lie inside it).
 */
const rootReals = new Map<string, string>()

function rootRealpath(directory: string) {
  const known = rootReals.get(key(directory))
  if (known !== undefined) return known
  const real = realpath(directory)
  if (real !== undefined) rootReals.set(key(directory), real)
  return real
}

/** Path segments of `file` below `root` (lower-cased), `[]` for the root itself, `undefined` outside it. */
function relative(file: string, root: string) {
  if (file === root) return []
  if (!within(file, root)) return undefined
  return file.slice(root.endsWith("\\") ? root.length : root.length + 1).split("\\")
}

function permitted(kind: Kind, rel: ReadonlyArray<string> | undefined, purpose: Purpose) {
  if (rel === undefined || never(kind, rel, purpose)) return false
  if (purpose === "skill") return skillArea(kind, rel)
  if (purpose === "list") return kind === "codex" ? codexFolder(rel) : claudeFolder(rel)
  if (purpose === "copy") return kind === "codex" && rel.length === 1 && /^state_\d+\.sqlite(-wal)?$/.test(rel[0])
  return kind === "codex" ? codexFile(rel) : claudeFile(rel)
}

/** Folders own never reads, by kind: as a root's last segment they make the root `path_denied`. */
const NEVER_FOLDERS: Record<Kind, ReadonlySet<string>> = {
  codex: new Set(["thread-writer-locks", "sqlite"]),
  "claude-code": new Set(["sessions", "file-history", "shell-snapshots", "memory"]),
}

/**
 * Never opened, whatever the purpose. Codex: `auth.json`, `config.toml`, `history.jsonl` (an I3 candidate),
 * `thread_history_1.sqlite` (its internal cache), `sqlite\codex-dev.db`, `state_*.sqlite-shm`, `*.lock` and
 * `thread-writer-locks\` (I3 stats it at most). Claude Code: `.credentials.json`, `sessions\` and `history.jsonl` (I3
 * candidates), `file-history\`, `shell-snapshots\`, `projects\*\memory\`. Anywhere: credential-looking names.
 */
function never(kind: Kind, rel: ReadonlyArray<string>, purpose: Purpose) {
  if (neverName(rel.at(-1) ?? "", purpose)) return true
  if (kind === "codex")
    return (
      ["auth.json", "config.toml", "history.jsonl", "thread-writer-locks", "sqlite"].includes(rel[0]) ||
      rel[0]?.startsWith("thread_history_") === true
    )
  return (
    [".credentials.json", "sessions", "history.jsonl", "file-history", "shell-snapshots"].includes(rel[0]) ||
    (rel[0] === "projects" && rel[2] === "memory")
  )
}

/** `skills` and below; for Claude Code also `plugins\cache` and `plugins\marketplaces` and below (09 §9.1). */
function skillArea(kind: Kind, rel: ReadonlyArray<string>) {
  if (rel[0] === "skills") return true
  return kind === "claude-code" && rel[0] === "plugins" && (rel[1] === "cache" || rel[1] === "marketplaces")
}

/**
 * A name the allowlist never opens wherever it lies: logins, keys, lock files and SQLite shared memory. Inside a skill
 * (purpose `skill`, SK2) a lock file is the skill's own content (`uv.lock`, `Cargo.lock`, `yarn.lock`) and is copied.
 */
export function neverName(name: string, purpose?: Purpose) {
  const last = name.toLowerCase()
  if (purpose === "skill" && last.endsWith(".lock")) return false
  return last === "auth.json" || last === ".credentials.json" || /\.(key|pem|lock)$/.test(last) || last.endsWith("-shm")
}

const ROLLOUT = /^rollout-.+\.jsonl(\.zst)?$/
const YEAR = /^\d{4}$/
const TWO = /^\d{2}$/

/** `sessions\YYYY\MM\DD\rollout-*.jsonl[.zst]`, `archived_sessions\rollout-*`, `session_index.jsonl`. */
function codexFile(rel: ReadonlyArray<string>) {
  if (rel.length === 1) return rel[0] === "session_index.jsonl"
  if (rel.length === 2) return rel[0] === "archived_sessions" && ROLLOUT.test(rel[1])
  return (
    rel.length === 5 &&
    rel[0] === "sessions" &&
    YEAR.test(rel[1]) &&
    TWO.test(rel[2]) &&
    TWO.test(rel[3]) &&
    ROLLOUT.test(rel[4])
  )
}

/** The root (to find `state_*.sqlite`), `sessions` down to the day folders, `archived_sessions`. */
function codexFolder(rel: ReadonlyArray<string>) {
  if (rel.length === 0) return true
  if (rel[0] === "archived_sessions") return rel.length === 1
  return (
    rel[0] === "sessions" &&
    rel.length <= 4 &&
    rel.slice(1).every((part, index) => (index === 0 ? YEAR : TWO).test(part))
  )
}

/**
 * `projects\<folder>\*.jsonl`; of a conversation's own folder `custom-title.json`, `tool-results\*` (opened only
 * when the viewer asks) and `subagents\**\agent-*.jsonl` with `*.meta.json`.
 */
function claudeFile(rel: ReadonlyArray<string>) {
  if (rel[0] !== "projects") return false
  if (rel.length === 3) return rel[2].endsWith(".jsonl")
  if (rel.length === 4) return rel[3] === "custom-title.json"
  if (rel[3] === "tool-results") return rel.length === 5
  const last = rel.at(-1) ?? ""
  return rel[3] === "subagents" && rel.length >= 5 && (/^agent-.+\.jsonl$/.test(last) || last.endsWith(".meta.json"))
}

/** `projects`, its folders, a conversation's folder, its `subagents\**` and `tool-results`. */
function claudeFolder(rel: ReadonlyArray<string>) {
  if (rel[0] !== "projects") return false
  if (rel.length <= 3) return true
  return rel[3] === "subagents" || (rel[3] === "tool-results" && rel.length === 4)
}

// ---------------------------------------------------------------------------------------------------------------
// File operations: the only reads of a root

/**
 * The most a full parse reads of one conversation, in decoded bytes (09 §2.8, IG4): every turn of it stays in memory,
 * tool output and image data included, and crosses to the service thread once more, in the service's own process.
 * Past it the conversation is `source_unreadable{too_large}`: a Claude Code file for its viewer and its import, a
 * Codex rollout (its `history_base` prefix included) for its import; the Codex viewer streams any size.
 */
export const PARSE_BYTES = 512 * 1024 * 1024

export type Failure = Denied | "locked"

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: Failure }

/** What the allowlist was asked, for the read-only guard of the tests (IG1). Production has no listener. */
export interface Report {
  readonly op: "open" | "stat" | "list"
  readonly purpose: Purpose
  readonly path: string
  /** The real path that was opened, stat'ed or listed; absent when refused. */
  readonly real?: string
  readonly reason?: Denied
}

const listeners = new Set<(report: Report) => void>()

/** Calls `listener` with every allowlist decision of this module instance; returns the unsubscribe function. */
export function observe(listener: (report: Report) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function allow(item: Root, file: string, purpose: Purpose, op: Report["op"]) {
  const checked = check(item, file, purpose)
  const report: Report = checked.ok
    ? { op, purpose, path: file, real: checked.real }
    : { op, purpose, path: file, reason: checked.reason }
  listeners.forEach((listener) => listener(report))
  return checked
}

/**
 * Opens an allowed file read-only, runs `use` and closes the handle before resolving, so no handle outlives the
 * call. Bun opens files on Windows with read, write and delete sharing: the tool can keep writing, compress and delete
 * or replace the file meanwhile, and a delete completes when the handle closes.
 */
export async function withFile<T>(
  item: Root,
  file: string,
  purpose: "read" | "copy" | "skill",
  use: (handle: FileHandle) => Promise<T>,
): Promise<Result<T>> {
  const checked = allow(item, file, purpose, "open")
  if (!checked.ok) return checked
  const handle = await fsp.open(checked.real, "r").catch((error: unknown) => failure(error))
  if (typeof handle === "string") return { ok: false, reason: handle }
  return use(handle)
    .then((value) => ({ ok: true as const, value }))
    .finally(() => handle.close())
}

/** The bytes of `[start, start + length)` (default: to the end of the file). Only for files known to be small. */
export function read(
  item: Root,
  file: string,
  range: { readonly start?: number; readonly length?: number } = {},
  purpose: "read" | "skill" = "read",
) {
  return withFile(item, file, purpose, async (handle) => {
    const start = range.start ?? 0
    const length = range.length ?? Math.max(0, (await handle.stat()).size - start)
    const buffer = Buffer.alloc(length)
    return buffer.subarray(0, (await handle.read(buffer, 0, length, start)).bytesRead)
  })
}

/** Chunks of an open handle from `start` to `end` (exclusive, default: the end as it grows), for streamed parsing. */
export async function* chunks(
  handle: FileHandle,
  range: { readonly start?: number; readonly end?: number; readonly size?: number } = {},
): AsyncGenerator<Uint8Array> {
  const size = range.size ?? 1 << 20
  const end = range.end ?? Number.POSITIVE_INFINITY
  const step = async (position: number): Promise<Uint8Array | undefined> => {
    const want = Math.min(size, end - position)
    if (want <= 0) return undefined
    const buffer = Buffer.alloc(want)
    const read = await handle.read(buffer, 0, want, position)
    return read.bytesRead === 0 ? undefined : buffer.subarray(0, read.bytesRead)
  }
  for (let position = range.start ?? 0; ; ) {
    const chunk = await step(position)
    if (chunk === undefined) return
    yield chunk
    position += chunk.length
  }
}

export interface Stat {
  readonly size: number
  readonly mtimeMs: number
  readonly file: boolean
  readonly directory: boolean
}

/** Size and time of an allowed file or folder, without opening it. */
export async function stat(item: Root, file: string, purpose: Purpose = "read"): Promise<Result<Stat>> {
  const checked = allow(item, file, purpose, "stat")
  if (!checked.ok) return checked
  const value = await fsp.stat(checked.real).catch((error: unknown) => failure(error))
  if (typeof value === "string") return { ok: false, reason: value }
  return {
    ok: true,
    value: { size: value.size, mtimeMs: value.mtimeMs, file: value.isFile(), directory: value.isDirectory() },
  }
}

export interface Entry {
  readonly name: string
  readonly kind: "file" | "directory" | "link" | "other"
}

/** The entries of an allowed folder; a junction or link is `link` and is checked again when it is read. */
export async function list(
  item: Root,
  directory: string,
  purpose: "list" | "skill" = "list",
): Promise<Result<ReadonlyArray<Entry>>> {
  const checked = allow(item, directory, purpose, "list")
  if (!checked.ok) return checked
  const entries = await fsp.readdir(checked.real, { withFileTypes: true }).catch((error: unknown) => failure(error))
  if (typeof entries === "string") return { ok: false, reason: entries }
  return {
    ok: true,
    value: entries.map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    })),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Links of a skill (SK2, 09 §9.3): where one points, without opening or listing what it points to

export type LinkScope = "inside" | "known" | "outside"
export type LinkRefusal = "broken" | "special" | "network" | "denied"

export type LinkClass =
  | {
      readonly ok: true
      /** The target's real path. */
      readonly real: string
      readonly kind: "folder" | "file"
      readonly scope: LinkScope
    }
  | { readonly ok: false; readonly reason: LinkRefusal; readonly target: string }

/**
 * Where a link (symbolic link or junction) in `item`'s skill area leads: its raw target (`readlink`, the link's own
 * entry), then the target's real path, judged before anything of it is touched: a network place (refused before it is
 * resolved, so an unreachable share cannot block), a never-open name, a blocked folder or a root's files outside its
 * skill area are refused; only then one stat tells a folder, a file or something else (`special`). `inside`: the
 * root's skill area or another root's; `known`: below one of `known` (folders core loads skills from); else
 * `outside`. Uses `item.reach` for the blocked folders and the roots.
 */
export async function classifyLink(
  item: Root,
  link: string,
  known: ReadonlyArray<string>,
  resolve: Realpath = realpath,
): Promise<LinkClass> {
  if (denied(item) || !allowed(item, relative(key(link), key(item.directory)), "skill"))
    return { ok: false, reason: "denied", target: "" }
  const raw = await fsp.readlink(native(link)).catch(() => undefined)
  const shown = raw === undefined ? "" : norm(path.resolve(path.dirname(native(link)), raw))
  if (remote(shown)) return { ok: false, reason: "network", target: shown }
  const real = resolve(link)
  if (real === undefined) return { ok: false, reason: "broken", target: shown }
  const target = norm(real)
  if (remote(target)) return { ok: false, reason: "network", target }
  const rootReal = rootRealpath(item.directory)
  const own = rootReal !== undefined && allowed(item, relative(key(target), key(rootReal)), "skill")
  const reach = item.reach ?? { allowed: [], blocked: [], roots: [] }
  const scope: LinkScope =
    own || inSkillArea(reach, target) ? "inside" : known.some((folder) => within(key(target), folder)) ? "known" : "outside"
  if (!own && !reachable({ ...reach, allowed: [key(target)] }, target)) return { ok: false, reason: "denied", target }
  const stat = await fsp.stat(target).catch(() => undefined)
  const report: Report = { op: "stat", purpose: "skill", path: link, real: target }
  listeners.forEach((listener) => listener(report))
  if (stat === undefined) return { ok: false, reason: "broken", target }
  if (!stat.isDirectory() && !stat.isFile()) return { ok: false, reason: "special", target }
  return { ok: true, real: target, kind: stat.isDirectory() ? "folder" : "file", scope }
}

/** A share (`\\server\share`), or on Windows anything that is not a drive path. */
function remote(target: string) {
  if (target === "") return false
  if (/^\\\\/.test(target)) return true
  return process.platform === "win32" && !/^[A-Za-z]:\\/.test(target)
}

function failure(error: unknown): Failure {
  const code = Fsx.code(error)
  if (code === "ENOENT" || code === "ENOTDIR") return "missing"
  if (code === "EISDIR") return "path_denied"
  return "locked"
}
