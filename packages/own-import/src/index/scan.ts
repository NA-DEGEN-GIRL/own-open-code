export * as Scan from "./scan.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { OwnImport } from "@own/protocol/rpc-import"
import { Redact } from "@own/runtime"
import type { SelfHttp } from "../http.js"
import { ClaudeSource } from "../sources/claude.js"
import { CodexStore } from "../sources/codex.js"
import { Paths } from "../sources/paths.js"
import { CodexTranscript } from "../transcript/codex.js"
import { Transcript } from "../transcript/ir.js"
import { IndexCache } from "./cache.js"
import { Snapshot } from "./snapshot.js"

/**
 * The index of other tools' conversations and the project list built on it (09 §2.2, §2.3, §2.8, §4.7, §5.2).
 *
 * - **Project folders** ({@link projects}, IM-D3): the folders core recorded for the project (`project.list`'s
 *   canonical folder and sandboxes, `ctx.worktree.list({projectID})`) plus what `git worktree list` reports in each of
 *   them, so two clones of one root commit (one Project ID in core) and the linked worktrees of both count. A
 *   conversation belongs when one of its working folders equals or lies below one of them ({@link belongs}, by real
 *   path when both exist, 09 §2.2).
 * - **The index** ({@link create}): nothing happens at load; the first list scans every root. Codex roots go through
 *   {@link CodexStore.discover} (the state DB copy, else the rollout folders); later refreshes copy the DB again only
 *   when its size or mtime, or its `-wal`'s, changed, and otherwise list only the recent date folders. Claude Code
 *   roots are scanned folder by folder (the folders of listed projects first) with the 64 KiB lite read, whose folder
 *   membership is provisional until the confirm pass streams the whole file for its cwd values; later refreshes
 *   re-list a folder only when its mtime changed and re-read a file only when its size or mtime did. There are no
 *   file watchers (the local Codex store is about 223 GB).
 * - **The list** ({@link Service.list}): answers within 2 s ({@link BUDGET_MS}); when the scan has not finished, the
 *   rows found so far come with `scanning: true` and `index.changed` follows. Rows are newest first, 50 per page with
 *   an opaque cursor; the imported marks come from the project's root sessions (`own.import` metadata, helpers never
 *   counted, one import per `(sourceID, importedAt)` because core copies metadata into forks).
 *
 * Titles and first prompts stay in memory; `import-index.json` holds only what {@link IndexCache.Entry} allows.
 */

/** `sessions.list` answers within this long (09 §2.8, IG5). */
export const BUDGET_MS = 2_000
/** Kept back from the budget for resolving folders and building the page. */
const RESERVE_MS = 150
/** A list within this long of the last refresh reuses the index (`warm list`, IG5). */
export const REFRESH_MS = 5_000
export const PAGE = 50
const PERSIST_MS = 1_000
const EMIT_MS = 200
/** A list keeps its folders "listened to" for `index.changed` this long. */
const SUBSCRIPTION_MS = 10 * 60_000
const MAX_SUBSCRIPTIONS = 32
const PROJECT_TTL_MS = 30_000
const GIT_TIMEOUT_MS = 5_000
/** Date folders a quick Codex refresh lists: from two days before the last scan (UTC names, clock slack). */
const RECENT_DAYS = 2
const LITE_READS = 8
const HYDRATE_READS = 8
const CONFIRM_READS = 2
const CONFIRM_BATCH = 16
const DAY_MS = 86_400_000
const LIVE_MS = CodexTranscript.LIVE_MS
/** The imported marks did not come within the list's budget. */
const LATE: unique symbol = Symbol("late")

// ---------------------------------------------------------------------------------------------------------------
// Project folders (IM-D3, 09 §2.2)

export interface Project {
  readonly id: string
  /** The project's main folder: the import location of a conversation whose folder is gone (09 §2.2). */
  readonly root: string
  /** Every working folder, normalized: the recorded ones and the linked worktrees `git worktree list` reports. */
  readonly folders: ReadonlyArray<string>
}

/** The checkouts `git worktree list` reports in a folder (the main one first); none when it is not a repository. */
export type Git = (folder: string) => Promise<ReadonlyArray<string>>

export type Resolved =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly reason: "directory_unknown" | "unavailable" }

export interface ProjectsInput {
  /** `project.list` over self-HTTP; `undefined` when the service did not answer. */
  readonly list: () => Promise<ReadonlyArray<SelfHttp.ProjectView> | undefined>
  /** The folders core recorded for a project (`ctx.worktree.list({projectID})`). */
  readonly worktrees: (projectID: string) => Promise<ReadonlyArray<string>>
  readonly git?: Git
  readonly resolve?: Paths.Realpath
  readonly ttlMs?: number
}

export interface Projects {
  /** The project `directory` is a working folder of, with all its folders; cached for a short while. */
  resolve(directory: string): Promise<Resolved>
  clear(): void
}

export function projects(input: ProjectsInput): Projects {
  const ttl = input.ttlMs ?? PROJECT_TTL_MS
  const git = input.git ?? gitWorktrees
  const resolve = input.resolve ?? Paths.realpath
  const found = new Map<string, { readonly at: number; readonly value: Promise<Resolved> }>()
  const listed = new Map<string, { readonly at: number; readonly value: Promise<ReadonlyArray<string>> }>()
  const fresh = <T>(cache: Map<string, { readonly at: number; readonly value: T }>, key: string, make: () => T) => {
    const known = cache.get(key)
    if (known !== undefined && Date.now() - known.at < ttl) return known.value
    const value = make()
    cache.set(key, { at: Date.now(), value })
    return value
  }
  const worktreesOf = (folder: string) => fresh(listed, Paths.key(folder), () => git(folder).catch(() => []))
  return {
    resolve: (directory) =>
      fresh(found, Paths.key(directory), () =>
        locate(directory, input, worktreesOf, resolve).then((value) => {
          // Only a project is kept: a folder core records later, or a service that did not answer, is asked again.
          if (!value.ok) found.delete(Paths.key(directory))
          return value
        }),
      ),
    clear: () => {
      found.clear()
      listed.clear()
    },
  }
}

async function locate(
  directory: string,
  input: ProjectsInput,
  worktreesOf: (folder: string) => Promise<ReadonlyArray<string>>,
  resolve: Paths.Realpath,
): Promise<Resolved> {
  const listed = await input.list().catch(() => undefined)
  if (listed === undefined) return { ok: false, reason: "unavailable" }
  const recorded = await Promise.all(
    listed.map(async (project) => ({
      id: project.id,
      root: Paths.norm(project.canonical),
      folders: unique([
        project.canonical,
        ...project.sandboxes,
        ...(await input.worktrees(project.id).catch(() => [])),
      ]),
    })),
  )
  // Every recorded folder of a project, plus `git worktree list` in each: a clone's worktrees never show in another.
  const expand = async (project: Project): Promise<Project> => ({
    ...project,
    folders: unique([...project.folders, ...(await Promise.all(project.folders.map(worktreesOf))).flat()]),
  })
  const direct = deepest(recorded, directory, resolve)
  if (direct !== undefined) return { ok: true, project: await expand(direct) }
  const all = await Promise.all(recorded.map(expand))
  const linked = deepest(all, directory, resolve)
  return linked === undefined ? { ok: false, reason: "directory_unknown" } : { ok: true, project: linked }
}

/** The project with the deepest folder holding `directory` (a repository nested in another is its own project). */
function deepest(list: ReadonlyArray<Project>, directory: string, resolve: Paths.Realpath) {
  return list
    .map((project) => ({
      project,
      depth: project.folders
        .filter((folder) => Paths.inside(directory, folder, resolve))
        .reduce((most, folder) => Math.max(most, Paths.key(folder).length), -1),
    }))
    .filter((item) => item.depth >= 0)
    .sort((a, b) => b.depth - a.depth)[0]?.project
}

function unique(folders: ReadonlyArray<string>) {
  const seen = new Map(
    folders.filter((folder) => folder !== "").map((folder) => [Paths.key(folder), Paths.norm(folder)]),
  )
  return [...seen.values()]
}

/**
 * `git worktree list --porcelain -z` in `folder`: read-only (no optional locks, no prompt), no window, bounded by a
 * timeout. Git missing, not a repository or a timeout give none.
 */
export async function gitWorktrees(folder: string): Promise<ReadonlyArray<string>> {
  const spawned = await Promise.resolve()
    .then(() =>
      Bun.spawn(["git", "-C", Paths.native(folder), "worktree", "list", "--porcelain", "-z"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" },
      }),
    )
    .catch(() => undefined)
  if (spawned === undefined) return []
  const [stdout, code] = await Promise.all([new Response(spawned.stdout).text(), spawned.exited])
  return code === 0 ? parseWorktrees(stdout) : []
}

/** The `worktree <path>` lines of `git worktree list --porcelain -z` (NUL-terminated lines), normalized. */
export function parseWorktrees(stdout: string) {
  return stdout
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => Paths.norm(line.slice("worktree ".length)))
}

// ---------------------------------------------------------------------------------------------------------------
// Membership (09 §2.2 속함)

/** Whether one of `cwds` is one of `folders` or lies below it: by real path when both exist, else by string. */
export function belongs(cwds: ReadonlyArray<string>, folders: ReadonlyArray<string>, resolve: Paths.Realpath) {
  return cwds.some((cwd) => folders.some((folder) => Paths.inside(cwd, folder, resolve)))
}

/** `resolve` remembered per path for one pass, so thousands of rows cost one real-path lookup per folder. */
export function remember(resolve: Paths.Realpath = Paths.realpath): Paths.Realpath {
  const seen = new Map<string, string | undefined>()
  return (input) => {
    if (seen.has(input)) return seen.get(input)
    const value = resolve(input)
    seen.set(input, value)
    return value
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

/** One conversation as the index knows it. */
export interface Row {
  /** `<rootID>/<id>`. */
  readonly key: string
  readonly ref: OwnImport.SourceRef
  readonly root: Paths.Root
  /** Codex: the current rollout (absent when the state DB names a thread whose file is gone). */
  readonly rollout?: CodexStore.RolloutFile
  /** Claude Code: the conversation file, or a sub-agent conversation. */
  readonly conversation?: ClaudeSource.Conversation | ClaudeSource.Child
  /** Every working folder recorded, as the tool wrote it, first to last. */
  readonly cwds: ReadonlyArray<string>
  /** A sub-agent conversation: the source id of the conversation the list folds it under. */
  readonly parent?: string
  readonly subagent: boolean
  /** A `codex exec` run. */
  readonly exec: boolean
  readonly archived: boolean
  /** A Claude Desktop SSH session (`projects/ssh-*`): listed in scope `all` only (09 §2.2). */
  readonly otherComputer: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly versions: ReadonlyArray<string>
  readonly models: ReadonlyArray<Transcript.Model>
  /** Memory only. */
  readonly title: string
  /** Memory only. */
  readonly firstPrompt?: string
  readonly branch?: string
  readonly app?: string
  readonly compactions: number
  readonly problem?: OwnImport.Unreadable
  /** Claude Code: `cwds` come from the whole file (the confirm pass or a full parse), not the 64 KiB windows. */
  readonly confirmed: boolean
  /** The memory-only fields were read in this process (a row from `import-index.json` has none yet). */
  readonly hydrated: boolean
}

const decodeRef = Schema.decodeUnknownOption(OwnImport.SourceRef)

/** A row's `SourceRef`; `undefined` for an id that is not a path-free token (never listed). */
function refOf(kind: OwnImport.Kind, rootID: string, id: string) {
  return Option.getOrUndefined(decodeRef({ kind, rootID, id }))
}

function keyOf(rootID: string, id: string) {
  return `${rootID}/${id}`
}

/** The file a row stands for. */
export function fileOf(row: Row): (IndexCache.Stamp & { readonly path: string }) | undefined {
  return row.rollout ?? row.conversation
}

function same(a: IndexCache.Stamp | undefined, b: IndexCache.Stamp) {
  return a !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function union(a: ReadonlyArray<string>, b: ReadonlyArray<string>) {
  return [...new Set([...a, ...b])]
}

/** The import location a conversation defaults to: its last folder, or the project root when that is gone. */
export function defaultLocation(summary: Pick<OwnImport.Summary, "cwd" | "folderExists">, project: Project) {
  return summary.folderExists ? summary.cwd : project.root
}

function codexRow(root: Paths.Root, thread: CodexStore.Thread, hydrated: boolean): Row | undefined {
  const source = thread.source
  const ref = refOf("codex", root.rootID, source.id)
  if (ref === undefined) return undefined
  return {
    key: keyOf(root.rootID, source.id),
    ref,
    root,
    ...(thread.file === undefined ? {} : { rollout: thread.file }),
    cwds: source.cwds,
    ...(source.subagent && source.parentID !== undefined ? { parent: source.parentID } : {}),
    subagent: source.subagent,
    exec: thread.exec,
    archived: thread.archived,
    otherComputer: false,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    versions: source.versions,
    models: source.models,
    title: source.title,
    ...(source.firstPrompt === undefined ? {} : { firstPrompt: source.firstPrompt }),
    ...(source.branch === undefined ? {} : { branch: source.branch }),
    ...(source.app === undefined ? {} : { app: source.app }),
    compactions: 0,
    ...(thread.problem === undefined ? {} : { problem: thread.problem }),
    confirmed: true,
    hydrated,
  }
}

/** A Codex thread first seen by a quick refresh: its new rollout file and that file's head. */
function codexFresh(
  root: Paths.Root,
  file: CodexStore.RolloutFile,
  head: CodexStore.Result<CodexTranscript.Head>,
  names: ReadonlyMap<string, string>,
): Row | undefined {
  const ref = refOf("codex", root.rootID, file.threadID)
  if (ref === undefined) return undefined
  const meta = head.ok ? head.value : undefined
  return {
    key: keyOf(root.rootID, file.threadID),
    ref,
    root,
    rollout: file,
    cwds: meta?.cwd ? [meta.cwd] : [],
    ...(meta?.subagent && meta.parentID !== undefined ? { parent: meta.parentID } : {}),
    subagent: meta?.subagent ?? false,
    exec: meta?.app === "exec",
    archived: file.archived,
    otherComputer: false,
    createdAt: meta?.time ?? file.time,
    updatedAt: file.mtimeMs,
    versions: meta?.cliVersion ? [meta.cliVersion] : [],
    models: [],
    title: names.get(file.threadID) || meta?.firstPrompt || "",
    ...(meta?.firstPrompt === undefined ? {} : { firstPrompt: meta.firstPrompt }),
    ...(meta?.branch === undefined ? {} : { branch: meta.branch }),
    ...(meta?.app === undefined ? {} : { app: meta.app }),
    compactions: 0,
    ...(head.ok ? {} : { problem: head.reason }),
    confirmed: true,
    hydrated: true,
  }
}

/** A Codex row whose file changed (or got a newer rollout) in a quick refresh. */
function codexMoved(row: Row, file: CodexStore.RolloutFile, head: CodexStore.Result<CodexTranscript.Head>): Row {
  // Another file of the thread that is older than the current one (e.g. the first file of a reverted thread).
  if (row.rollout !== undefined && row.rollout.path !== file.path && row.rollout.mtimeMs > file.mtimeMs) return row
  const meta = head.ok ? head.value : undefined
  const firstPrompt = row.firstPrompt ?? meta?.firstPrompt
  const branch = row.branch ?? meta?.branch
  const app = row.app ?? meta?.app
  return {
    ...row,
    rollout: file,
    updatedAt: Math.max(row.updatedAt, file.mtimeMs),
    title: row.title || firstPrompt || "",
    ...(firstPrompt === undefined ? {} : { firstPrompt }),
    ...(branch === undefined ? {} : { branch }),
    ...(app === undefined ? {} : { app }),
    problem: head.ok ? undefined : head.reason,
    hydrated: row.hydrated || head.ok,
  }
}

/** A head from `import-index.json`: no first prompt or branch, so the row is filled in later ({@link Row.hydrated}). */
function storedHead(entry: IndexCache.Entry): CodexTranscript.Head {
  return CodexTranscript.omitUndefined({
    id: entry.id,
    time: entry.createdAt,
    cwd: entry.cwds[0],
    cliVersion: entry.versions[0],
    app: entry.exec ? "exec" : undefined,
    subagent: entry.subagent,
    parentID: entry.parent,
  })
}

function claudeRow(
  root: Paths.Root,
  conversation: ClaudeSource.Conversation,
  listed: ClaudeSource.Listed,
  previous: Row | undefined,
): Row | undefined {
  const ref = refOf("claude-code", root.rootID, conversation.id)
  if (ref === undefined) return undefined
  // Claude Code only appends: folders seen before still are in the file, and a confirmed set stays confirmed while
  // the file keeps its stamp (a row from import-index.json being filled in).
  const kept = previous !== undefined && same(previous.conversation, conversation)
  return {
    key: keyOf(root.rootID, conversation.id),
    ref,
    root,
    conversation,
    cwds: union(previous?.cwds ?? [], listed.cwds),
    subagent: false,
    exec: false,
    archived: false,
    otherComputer: listed.otherComputer,
    createdAt: listed.createdAt,
    updatedAt: listed.updatedAt,
    versions: listed.versions,
    models: listed.model === undefined ? [] : [{ id: listed.model }],
    title: listed.title,
    ...(listed.firstPrompt === undefined ? {} : { firstPrompt: listed.firstPrompt }),
    ...(listed.branch === undefined ? {} : { branch: listed.branch }),
    compactions: Math.max(listed.compactions, kept ? previous.compactions : 0),
    confirmed: kept && previous.confirmed,
    hydrated: true,
  }
}

function claudeStored(
  root: Paths.Root,
  conversation: ClaudeSource.Conversation,
  entry: IndexCache.Entry,
): Row | undefined {
  const ref = refOf("claude-code", root.rootID, conversation.id)
  if (ref === undefined) return undefined
  return {
    key: keyOf(root.rootID, conversation.id),
    ref,
    root,
    conversation,
    cwds: entry.cwds,
    subagent: false,
    exec: false,
    archived: false,
    otherComputer: conversation.folder.startsWith("ssh-"),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    versions: entry.versions,
    models: [],
    title: "",
    compactions: 0,
    confirmed: entry.confirmed ?? false,
    hydrated: false,
  }
}

/** A sub-agent conversation folded under `parent`; it belongs where its parent does. */
function claudeChild(root: Paths.Root, parent: Row, child: ClaudeSource.Child): Row | undefined {
  const ref = refOf("claude-code", root.rootID, child.id)
  if (ref === undefined) return undefined
  return {
    key: keyOf(root.rootID, child.id),
    ref,
    root,
    conversation: child,
    cwds: parent.cwds,
    parent: parent.ref.id,
    subagent: true,
    exec: false,
    archived: false,
    otherComputer: parent.otherComputer,
    createdAt: child.mtimeMs,
    updatedAt: child.mtimeMs,
    versions: parent.versions,
    models: [],
    title: child.title ?? child.agent ?? "",
    compactions: 0,
    confirmed: true,
    hydrated: true,
  }
}

/** What a change notification compares: a row's listed fields. */
function fingerprint(row: Row) {
  const file = fileOf(row)
  return JSON.stringify([
    file?.path,
    file?.size,
    file?.mtimeMs,
    row.cwds,
    row.parent,
    row.subagent,
    row.exec,
    row.archived,
    row.updatedAt,
    row.title,
    row.firstPrompt,
    row.branch,
    row.models,
    row.compactions,
    row.problem,
    row.hydrated,
  ])
}

function entryOf(row: Row): IndexCache.Entry | undefined {
  const file = row.rollout ?? (row.subagent ? undefined : row.conversation)
  if (file === undefined) return undefined
  const codex = row.ref.kind === "codex"
  return {
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    kind: row.ref.kind,
    rootID: row.root.rootID,
    id: row.ref.id,
    cwds: row.cwds.map(Paths.norm),
    ...(row.parent === undefined ? {} : { parent: row.parent }),
    subagent: row.subagent,
    ...(codex ? { exec: row.exec } : { confirmed: row.confirmed }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    versions: row.versions,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The service

export type Scope = "folder" | "all"

export interface Include {
  readonly subagents: boolean
  readonly exec: boolean
  readonly archived: boolean
}

export interface ListInput {
  readonly directory: string
  readonly scope?: Scope
  readonly include?: Include
  /** Title search (memory only). */
  readonly query?: string
  readonly cursor?: string
  /** Default {@link PAGE}; 0 answers only the counts. */
  readonly limit?: number
}

export interface ListOutput {
  readonly items: ReadonlyArray<OwnImport.Summary>
  readonly total: number
  readonly fresh: number
  readonly cursor: string | null
  readonly scanning: boolean
}

export type ListResult =
  | { readonly ok: true; readonly value: ListOutput }
  | { readonly ok: false; readonly error: "directory_unknown" | "unavailable" }

/** The file to read for a conversation: the viewer's and the search's target (`render/view.ts` `Target`). */
export type Target =
  | {
      readonly kind: "codex"
      readonly ref: OwnImport.SourceRef
      readonly root: Paths.Root
      readonly file: CodexStore.RolloutFile
    }
  | {
      readonly kind: "claude-code"
      readonly ref: OwnImport.SourceRef
      readonly root: Paths.Root
      readonly conversation: ClaudeSource.Conversation | ClaudeSource.Child
    }

/** A row's {@link Target}; `undefined` for a Codex thread the state DB names whose rollout is gone (`missing`). */
export function targetOf(row: Row): Target | undefined {
  if (row.rollout !== undefined) return { kind: "codex", ref: row.ref, root: row.root, file: row.rollout }
  if (row.conversation !== undefined && row.ref.kind === "claude-code")
    return { kind: "claude-code", ref: row.ref, root: row.root, conversation: row.conversation }
  return undefined
}

/** Where a `SourceRef` leads: its row and, when its file exists, the target to read. */
export interface Located {
  readonly row: Row
  readonly target?: Target
}

export interface Input {
  /** OWN_HOME: `state/import-index.json`, and `tmp/` for the Codex state DB copy. */
  readonly home: string
  readonly roots: () => Promise<ReadonlyArray<Paths.Root>>
  readonly http: Pick<SelfHttp.Client, "project" | "session">
  /** `ctx.worktree.list({projectID})`'s folders. */
  readonly worktrees: (projectID: string) => Promise<ReadonlyArray<string>>
  /** Publishes `index.changed` with the listed folders whose lists changed. */
  readonly emit: (directories: ReadonlyArray<string>) => void
  /** Default {@link BUDGET_MS}. */
  readonly budgetMs?: number
  /** Default {@link REFRESH_MS}. */
  readonly refreshMs?: number
  readonly persistMs?: number
  /** "Now" for `live` and the quick Codex refresh; default `Date.now`. */
  readonly now?: () => number
  readonly git?: Git
  readonly resolve?: Paths.Realpath
  /** `false`: the Codex file scan only (no state DB copy). */
  readonly snapshot?: boolean
  /** Awaited before a root is scanned; tests hold a root here to see a partial answer. */
  readonly before?: (root: Paths.Root) => Promise<void>
}

export interface Service {
  /** `sessions.list` (09 §5.2). */
  list(input: ListInput): Promise<ListResult>
  /** The project a folder belongs to (`directory_unknown` for any other folder). */
  project(directory: string): Promise<Resolved>
  /** The row of a conversation, to read it (`sessions.read`, `migrate.plan`). */
  locate(ref: OwnImport.SourceRef): Located | undefined
  /**
   * A full parse of `ref` (the viewer, a plan): exact compactions, the Claude Code folders from the whole file, and
   * the turn count and prefix hashes behind `원본에 새 턴 N개` while the file keeps its stamp.
   */
  parsed(ref: OwnImport.SourceRef, info: Transcript.Info): void
  /** The project's conversations (top-level, deduplicated, not another computer's): the folder search. */
  members(project: Project): ReadonlyArray<Row>
  /**
   * Whether a conversation is one of the project's (one of its folders, or a sub-agent's parent's): all that a read,
   * a search or a plan reaches without `scope: "all"` (09 §5.5).
   */
  member(row: Row, project: Project): boolean
  /** Top-level conversations found under a root (`sources.list` `sessions`); `undefined` until it was scanned. */
  sessions(rootID: string): number | undefined
  /**
   * Starts a refresh (or joins the running one); resolves when its rows are scanned and filled in. `full` scans the
   * roots again even inside the warm window, after the running refresh (a changed root list, `sources.configure`).
   */
  refresh(options?: { readonly full?: boolean }): Promise<void>
  /** Resolves when the refresh, the confirm pass and the index file write are done. */
  idle(): Promise<void>
  close(): Promise<void>
}

interface Subscription {
  readonly directory: string
  readonly scope: Scope
  readonly folders: ReadonlyArray<string>
  readonly member: (row: Row) => boolean
  readonly at: number
}

interface CodexState {
  /** The state DB stamp of the last full scan; `null` without a DB. */
  readonly stamp: Snapshot.Stamp | null
  scannedAt: number
  readonly files: Map<string, CodexStore.RolloutFile>
}

interface ClaudeState {
  readonly folders: Map<string, { readonly mtimeMs: number; readonly files: ReadonlyArray<ClaudeSource.Conversation> }>
}

/** What a Claude Code lite read gave, kept in memory: `listed` is absent for a file the list skips. */
interface Lite {
  readonly listed?: ClaudeSource.Listed
  readonly children: ReadonlyArray<ClaudeSource.Child>
}

interface Parsed extends IndexCache.Stamp {
  readonly turns: number
  readonly compactions: number
  /** `contentHash` of the first n turns, for the turn counts of this source's imports known when it was parsed. */
  readonly hashes: ReadonlyMap<number, string>
}

export function create(input: Input): Service {
  const now = input.now ?? Date.now
  const budget = input.budgetMs ?? BUDGET_MS
  const refreshMs = input.refreshMs ?? REFRESH_MS
  const resolve = input.resolve ?? Paths.realpath
  const tmp = path.join(input.home, "tmp")
  const finder = projects({
    list: () => input.http.project.list().then((result) => (result.ok ? result.value : undefined)),
    worktrees: input.worktrees,
    git: input.git,
    resolve,
  })

  const rows = new Map<string, Row>()
  const codex = new Map<string, CodexState>()
  const claude = new Map<string, ClaudeState>()
  const heads = IndexCache.memory<CodexTranscript.Head>()
  const lites = IndexCache.memory<Lite>()
  const parsed = new Map<string, Parsed>()
  const importTurns = new Map<string, ReadonlySet<number>>()
  const subscriptions = new Map<string, Subscription>()
  const touched: Row[] = []
  const state = {
    stored: undefined as Map<string, IndexCache.Entry> | undefined,
    work: undefined as Promise<void> | undefined,
    /** A scan or fill-in runs: `index.changed` waits for its end instead of following every folder. */
    busy: false,
    last: undefined as number | undefined,
    confirm: undefined as Promise<void> | undefined,
    persist: undefined as ReturnType<typeof setTimeout> | undefined,
    writing: Promise.resolve(),
    emit: undefined as ReturnType<typeof setTimeout> | undefined,
    emitting: new Set<string>(),
    closed: false,
    swept: undefined as Promise<void> | undefined,
    /** The last imported marks per list (a project's id, `""` for scope `all`): {@link list}'s fallback. */
    marks: new Map<string, ReadonlyMap<string, ReadonlyArray<Mark>>>(),
  }

  // --- rows and change notification ----------------------------------------------------------------------------

  const ofRoot = (rootID: string) => [...rows.values()].filter((row) => row.root.rootID === rootID)
  const childrenOf = (rootID: string, id: string) =>
    ofRoot(rootID).filter((row) => row.ref.kind === "claude-code" && row.subagent && row.parent === id)

  const put = (row: Row) => {
    const before = rows.get(row.key)
    rows.set(row.key, row)
    if (before !== undefined && fingerprint(before) === fingerprint(row)) return
    if (before !== undefined) touched.push(before)
    touched.push(row)
  }
  const remove = (key: string) => {
    const before = rows.get(key)
    if (before === undefined) return
    touched.push(before)
    rows.delete(key)
  }
  /** The listed folders whose lists the rows changed since the last flush get an `index.changed`. */
  const flush = () => {
    if (touched.length === 0) return
    const changed = touched.splice(0)
    live()
      .filter((sub) => sub.scope === "all" || changed.some(sub.member))
      .forEach((sub) => announce(sub.directory))
  }
  const announce = (directory: string) => {
    if (state.closed) return
    state.emitting.add(directory)
    schedule()
  }
  const schedule = () => {
    if (state.busy || state.closed || state.emit !== undefined || state.emitting.size === 0) return
    state.emit = setTimeout(() => {
      state.emit = undefined
      const directories = [...state.emitting]
      state.emitting.clear()
      if (directories.length > 0 && !state.closed) input.emit(directories)
    }, EMIT_MS)
  }

  // --- subscriptions: the folders lists were asked for ---------------------------------------------------------

  /** Whether a row is in the project's folders (its cwds, or a sub-agent's parent's), remembered per cwd. */
  const memberOf = (project: Project) => {
    const memo = remember(resolve)
    const known = new Map<string, boolean>()
    const inFolders = (cwd: string) => {
      const found = known.get(cwd)
      if (found !== undefined) return found
      const value = project.folders.some((folder) => Paths.inside(cwd, folder, memo))
      known.set(cwd, value)
      return value
    }
    const holds = (row: Row) => !row.otherComputer && row.cwds.some(inFolders)
    return (row: Row) => {
      if (holds(row)) return true
      const parent = row.parent === undefined ? undefined : rows.get(keyOf(row.root.rootID, row.parent))
      return row.subagent && parent !== undefined && holds(parent)
    }
  }
  const live = () => {
    const cutoff = Date.now() - SUBSCRIPTION_MS
    for (const [key, sub] of subscriptions) if (sub.at < cutoff) subscriptions.delete(key)
    return [...subscriptions.values()]
  }
  const subscribe = (directory: string, scope: Scope, project: Project) => {
    const key = `${scope}\0${Paths.key(directory)}`
    const sub: Subscription = { directory, scope, folders: project.folders, member: memberOf(project), at: Date.now() }
    subscriptions.delete(key)
    subscriptions.set(key, sub)
    while (subscriptions.size > MAX_SUBSCRIPTIONS) subscriptions.delete(subscriptions.keys().next().value ?? key)
    return sub
  }

  // --- import-index.json ---------------------------------------------------------------------------------------

  const schedulePersist = () => {
    if (state.closed || state.persist !== undefined) return
    state.persist = setTimeout(() => {
      state.persist = undefined
      void write()
    }, input.persistMs ?? PERSIST_MS)
  }
  const write = () => {
    const entries = [...rows.values()].map(entryOf).filter((entry) => entry !== undefined)
    state.writing = state.writing.then(() => IndexCache.save(input.home, entries)).catch(() => undefined)
    return state.writing
  }
  const flushPersist = async () => {
    if (state.persist !== undefined) {
      clearTimeout(state.persist)
      state.persist = undefined
      await write()
    }
    await state.writing
  }
  const stored = (file: IndexCache.Stamp & { readonly path: string }, kind: OwnImport.Kind, rootID: string) => {
    const entry = state.stored?.get(file.path)
    return entry !== undefined && entry.kind === kind && entry.rootID === rootID && same(entry, file)
      ? entry
      : undefined
  }

  // --- Codex ---------------------------------------------------------------------------------------------------

  const readHead = async (root: Paths.Root, file: CodexStore.RolloutFile) => {
    const known = heads.get(file.path, file)
    if (known !== undefined) return { ok: true as const, value: known }
    const read = await CodexStore.head(root, file)
    if (read.ok) heads.set(file.path, file, read.value)
    return read
  }

  const keepParsed = (row: Row) => {
    const known = parsed.get(row.key)
    const file = fileOf(row)
    return known !== undefined && file !== undefined && same(known, file)
      ? { ...row, compactions: known.compactions }
      : row
  }

  /** A full scan when the state DB changed (or on the first scan); else {@link quickCodex}. */
  const scanCodex = async (root: Paths.Root) => {
    const previous = codex.get(root.rootID)
    const stamp = (await Snapshot.locate(root))?.stamp ?? null
    if (previous !== undefined && sameStamp(previous.stamp, stamp)) return quickCodex(root, previous)
    // Heads from import-index.json carry no first prompt: those rows are filled in when a list wants them.
    const partial = new Set<string>()
    const found = await CodexStore.discover(root, {
      tmp,
      now: now(),
      snapshot: input.snapshot,
      cached: (file) => {
        const known = heads.get(file.path, file)
        if (known !== undefined) return known
        const entry = stored(file, "codex", root.rootID)
        if (entry === undefined) return undefined
        partial.add(file.path)
        return storedHead(entry)
      },
    })
    found.heads.forEach((item) => heads.set(item.file.path, item.file, item.head))
    codex.set(root.rootID, { stamp, scannedAt: now(), files: new Map(found.files.map((file) => [file.path, file])) })
    const next = found.threads
      .map((thread) => codexRow(root, thread, thread.file === undefined || !partial.has(thread.file.path)))
      .filter((row) => row !== undefined)
    const keys = new Set(next.map((row) => row.key))
    ofRoot(root.rootID)
      .filter((row) => !keys.has(row.key))
      .forEach((row) => remove(row.key))
    next.forEach((row) => put(keepParsed(row)))
    flush()
  }

  /** The state DB did not change: only the recent date folders are listed, and changed rollouts read again. */
  const quickCodex = async (root: Paths.Root, previous: CodexState) => {
    const since = new Date(previous.scannedAt - RECENT_DAYS * DAY_MS).toISOString().slice(0, 10)
    const recent = await CodexStore.files(root, { since, archived: false })
    previous.scannedAt = now()
    const changed = recent
      .filter((file) => !same(previous.files.get(file.path), file))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    if (changed.length === 0) return
    const names = await CodexStore.names(root)
    for (const file of changed) {
      previous.files.set(file.path, file)
      const head = await readHead(root, file)
      const existing = rows.get(keyOf(root.rootID, file.threadID))
      const row = existing === undefined ? codexFresh(root, file, head, names) : codexMoved(existing, file, head)
      if (row !== undefined) put(row)
    }
    flush()
  }

  // --- Claude Code ---------------------------------------------------------------------------------------------

  const readLite = async (root: Paths.Root, conversation: ClaudeSource.Conversation): Promise<Lite | undefined> => {
    const known = lites.get(conversation.path, conversation)
    if (known !== undefined) return known
    const read = await ClaudeSource.lite(root, conversation, now()).catch(() => undefined)
    // Unreadable now (locked, gone): no folders to judge it by; it is read again next time.
    if (read === undefined || !read.ok) return undefined
    const children = read.value === undefined ? [] : await ClaudeSource.children(root, conversation)
    const value: Lite = { ...(read.value === undefined ? {} : { listed: read.value }), children }
    lites.set(conversation.path, conversation, value)
    return value
  }

  /** The rows of one conversation from a lite read; children it no longer has are removed. */
  const applyLite = (
    root: Paths.Root,
    conversation: ClaudeSource.Conversation,
    lite: Lite | undefined,
    previous: Row | undefined,
  ) => {
    const before = childrenOf(root.rootID, conversation.id)
    const top = lite?.listed === undefined ? undefined : claudeRow(root, conversation, lite.listed, previous)
    if (top === undefined) {
      remove(keyOf(root.rootID, conversation.id))
      before.forEach((row) => remove(row.key))
      return
    }
    put(top)
    const kids = (lite?.children ?? []).map((child) => claudeChild(root, top, child)).filter((row) => row !== undefined)
    const keep = new Set(kids.map((row) => row.key))
    before.filter((row) => !keep.has(row.key)).forEach((row) => remove(row.key))
    kids.forEach(put)
  }

  /** An unchanged file keeps its row; a file known from import-index.json gets a row without reading it. */
  const conversationRows = async (root: Paths.Root, conversation: ClaudeSource.Conversation) => {
    const previous = rows.get(keyOf(root.rootID, conversation.id))
    if (previous !== undefined && same(previous.conversation, conversation)) return
    const known = lites.get(conversation.path, conversation)
    const entry =
      known === undefined && previous === undefined ? stored(conversation, "claude-code", root.rootID) : undefined
    const row = entry === undefined ? undefined : claudeStored(root, conversation, entry)
    if (row !== undefined) return put(row)
    applyLite(root, conversation, known ?? (await readLite(root, conversation)), previous)
  }

  /** Folder by folder, the listed projects' candidate folders first; an unchanged folder is not listed again. */
  const scanClaude = async (root: Paths.Root) => {
    const found = await ClaudeSource.folders(root)
    const previous = claude.get(root.rootID) ?? { folders: new Map() }
    claude.set(root.rootID, previous)
    const folders = found.ok ? found.value : []
    const names = new Set(folders.map((folder) => folder.name))
    ofRoot(root.rootID)
      .filter((row) => row.conversation === undefined || !names.has(row.conversation.folder))
      .forEach((row) => remove(row.key))
    ;[...previous.folders.keys()].filter((name) => !names.has(name)).forEach((name) => previous.folders.delete(name))
    const asked = live().flatMap((sub) => sub.folders)
    const first = (folder: ClaudeSource.Folder) => asked.some((item) => Paths.claudeCandidate(folder.name, item))
    const ordered = folders.toSorted((a, b) => Number(first(b)) - Number(first(a)) || b.mtimeMs - a.mtimeMs)
    for (const folder of ordered) {
      if (state.closed) return
      const known = previous.folders.get(folder.name)
      const conversations =
        known !== undefined && known.mtimeMs === folder.mtimeMs
          ? await restat(root, known.files)
          : await ClaudeSource.conversations(root, folder.name).then((result) => (result.ok ? result.value : []))
      previous.folders.set(folder.name, { mtimeMs: folder.mtimeMs, files: conversations })
      const ids = new Set(conversations.map((conversation) => conversation.id))
      ofRoot(root.rootID)
        .filter((row) => !row.subagent && row.conversation?.folder === folder.name && !ids.has(row.ref.id))
        .forEach((row) => {
          remove(row.key)
          childrenOf(root.rootID, row.ref.id).forEach((child) => remove(child.key))
        })
      await mapLimit(conversations, LITE_READS, (conversation) => conversationRows(root, conversation))
    }
    flush()
  }

  // --- filling rows in, and the confirm pass -------------------------------------------------------------------

  /** Reads what a row from import-index.json lacks (the head, the lite read); always leaves it filled in. */
  const hydrate = async (row: Row) => {
    if (row.rollout !== undefined) {
      const file = row.rollout
      const head = await readHead(row.root, file)
      const current = rows.get(row.key)
      if (current === undefined || current.rollout?.path !== file.path) return
      put({ ...codexMoved(current, file, head), hydrated: true })
      return
    }
    const conversation = row.conversation
    if (conversation === undefined || row.subagent) return put({ ...row, hydrated: true })
    const lite = await readLite(row.root, conversation)
    const current = rows.get(row.key)
    if (current === undefined || !same(current.conversation, conversation)) return
    if (lite === undefined) return put({ ...current, problem: "locked", hydrated: true })
    applyLite(row.root, conversation, lite, current)
  }

  /** Fills in the rows a live list shows (its folders, or everything for scope `all`), newest first. */
  const hydrateWanted = async (): Promise<void> => {
    const subs = live()
    const pending = [...rows.values()]
      .filter((row) => !row.hydrated && subs.some((sub) => sub.scope === "all" || sub.member(row)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (pending.length === 0 || state.closed) return
    await mapLimit(pending, HYDRATE_READS, (row) => hydrate(row).catch(() => put({ ...row, hydrated: true })))
    flush()
    return hydrateWanted()
  }

  /** Streams a Claude Code file for its cwd values (09 §2.3 확정); a membership it adds is announced. */
  const confirmRow = async (row: Row) => {
    const conversation = row.conversation
    if (conversation === undefined) return
    const read = await ClaudeSource.confirm(row.root, conversation).catch(() => undefined)
    const current = rows.get(row.key)
    if (current === undefined || !same(current.conversation, conversation)) return
    if (read === undefined || !read.ok) return put({ ...current, confirmed: true })
    put({
      ...current,
      cwds: union(current.cwds, read.value.cwds),
      compactions: read.value.compactions,
      confirmed: true,
    })
  }

  const confirmAll = async (): Promise<void> => {
    const pending = [...rows.values()]
      .filter((row) => row.ref.kind === "claude-code" && !row.subagent && !row.confirmed)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    if (pending.length === 0 || state.closed) return
    for (const chunk of chunks(pending, CONFIRM_BATCH)) {
      if (state.closed) return
      await mapLimit(chunk, CONFIRM_READS, confirmRow)
      flush()
      schedulePersist()
    }
    return confirmAll()
  }

  // --- refresh -------------------------------------------------------------------------------------------------

  const scanAll = async () => {
    state.stored ??= await IndexCache.load(input.home)
    // Copies of the Codex state DB a terminated Worker or a killed service left behind (IG10).
    state.swept ??= Snapshot.sweep(tmp)
    // A root `sources.list` shows as `path_denied` (a network share, a never-open folder) is never read (09 §2.1).
    const roots = (await input.roots()).filter((root) => !Paths.denied(root))
    const ids = new Set(roots.map((root) => root.rootID))
    ;[...rows.values()].filter((row) => !ids.has(row.root.rootID)).forEach((row) => remove(row.key))
    ;[...codex.keys()].filter((id) => !ids.has(id)).forEach((id) => codex.delete(id))
    ;[...claude.keys()].filter((id) => !ids.has(id)).forEach((id) => claude.delete(id))
    await Promise.all(
      roots.map(async (root) => {
        await input.before?.(root)
        if (state.closed) return
        await (root.kind === "codex" ? scanCodex(root) : scanClaude(root)).catch(() => undefined)
      }),
    )
  }

  const refresh = (options: { readonly full?: boolean } = {}): Promise<void> => {
    if (state.work !== undefined) return options.full ? state.work.then(() => refresh(options)) : state.work
    const quick = !options.full && state.last !== undefined && Date.now() - state.last < refreshMs
    state.busy = true
    state.work = (quick ? hydrateWanted() : scanAll().then(hydrateWanted))
      .catch(() => undefined)
      .then(() => {
        if (!quick) state.last = Date.now()
        state.busy = false
        flush()
        schedule()
        schedulePersist()
        state.confirm ??= confirmAll()
          .catch(() => undefined)
          .finally(() => {
            state.confirm = undefined
          })
      })
      .finally(() => {
        state.work = undefined
      })
    return state.work
  }

  // --- the list ------------------------------------------------------------------------------------------------

  const imports = async (scope: Scope, project: Project) => {
    const listed = await input.http.session.all(
      scope === "all" ? { parentID: null } : { project: project.id, parentID: null },
    )
    return listed.ok ? marks(listed.value) : undefined
  }

  /** A row's imports; a source fully parsed in this process whose first turns still hash the same has grown. */
  const importedOf = (row: Row, found: ReadonlyMap<string, ReadonlyArray<Mark>>): OwnImport.Imported[] => {
    const list = found.get(`${row.ref.kind}/${row.ref.id}`) ?? []
    if (list.length > 0) importTurns.set(row.key, new Set(list.map((mark) => mark.turns)))
    const file = fileOf(row)
    const known = parsed.get(row.key)
    const full = known !== undefined && file !== undefined && same(known, file) ? known : undefined
    return list.map((mark) => {
      const grown = full !== undefined && full.turns > mark.turns && full.hashes.get(mark.turns) === mark.contentHash
      return {
        sessionID: mark.sessionID,
        mode: mark.mode,
        importedAt: mark.importedAt,
        ...(grown ? { newTurns: full.turns - mark.turns } : {}),
      }
    })
  }

  const compactionsOf = (row: Row) => {
    const known = parsed.get(row.key)
    const file = fileOf(row)
    return known !== undefined && file !== undefined && same(known, file) ? known.compactions : row.compactions
  }

  const list = async (request: ListInput): Promise<ListResult> => {
    const started = Date.now()
    const scope = request.scope ?? "folder"
    const resolved = await finder.resolve(request.directory)
    if (!resolved.ok) return { ok: false, error: resolved.reason }
    const sub = subscribe(request.directory, scope, resolved.project)
    const marked = imports(scope, resolved.project)
    const work = refresh()
    const progress = { done: false }
    const done = work.then(() => {
      progress.done = true
    })
    const left = () => Math.max(0, budget - RESERVE_MS - (Date.now() - started))
    await Promise.race([done, Bun.sleep(left())])
    // The marks page through the root sessions: past the budget the last ones of this list stand in, and the new ones
    // announce `index.changed` only when they differ, so a slow session list neither holds the answer nor makes the
    // screen ask again and again.
    const key = scope === "all" ? "" : resolved.project.id
    const found = await Promise.race([marked, Bun.sleep(left()).then((): typeof LATE => LATE)])
    if (found === undefined) return { ok: false, error: "unavailable" }
    const used = found === LATE ? (state.marks.get(key) ?? new Map<string, ReadonlyArray<Mark>>()) : found
    state.marks.set(key, used)
    if (found === LATE)
      void marked.then((value) => {
        if (value === undefined) return
        state.marks.set(key, value)
        if (JSON.stringify([...value]) !== JSON.stringify([...used])) announce(request.directory)
      })
    const output = page(request, scope, sub, used, progress.done)
    // A partial answer is owed an `index.changed` when the scan ends, even when nothing changed.
    if (output.scanning) void done.then(() => announce(request.directory))
    return { ok: true, value: output }
  }

  const page = (
    request: ListInput,
    scope: Scope,
    sub: Subscription,
    found: ReadonlyMap<string, ReadonlyArray<Mark>>,
    done: boolean,
  ): ListOutput => {
    const all = dedupe([...rows.values()])
    const byKey = new Map(all.map((row) => [row.key, row]))
    const include = request.include ?? { subagents: false, exec: false, archived: false }
    const shown = (row: Row) =>
      (include.subagents || !row.subagent) && (include.exec || !row.exec) && (include.archived || !row.archived)
    const visible = (scope === "all" ? all : all.filter(sub.member)).filter(shown)
    const query = request.query?.normalize("NFC").toLowerCase()
    // The title as the row shows it: a query that only matched inside a secret finds nothing (as `Search.find`).
    const matched =
      query === undefined
        ? visible
        : visible.filter((row) => Redact.named(row.title).text.normalize("NFC").toLowerCase().includes(query))
    const fresh = all
      .filter((row) => sub.member(row) && !row.subagent && !row.exec && !row.archived && row.problem === undefined)
      .filter((row) => importedOf(row, found).length === 0).length
    const sorted = order(matched, scope, byKey)
    const after = decodeCursor(request.cursor)
    const start = after === undefined ? 0 : sorted.findIndex((item) => compare(item.sort, after) > 0)
    const from = start === -1 ? sorted.length : start
    const limit = request.limit ?? PAGE
    const slice = sorted.slice(from, from + limit)
    const exists = remember(resolve)
    const time = now()
    const counts = children(all)
    return {
      items: slice.map((item) =>
        summary(item.row, {
          now: time,
          exists: (cwd) => exists(cwd) !== undefined,
          imported: importedOf(item.row, found),
          children: counts.get(item.row.key) ?? 0,
          compactions: compactionsOf(item.row),
        }),
      ),
      total: matched.length,
      fresh,
      cursor: limit > 0 && from + limit < sorted.length ? encodeCursor(slice.at(-1)?.sort ?? []) : null,
      scanning: !done || visible.some((row) => !row.hydrated),
    }
  }

  return {
    list,
    project: (directory) => finder.resolve(directory),
    locate: (ref) => {
      const row = rows.get(keyOf(ref.rootID, ref.id))
      if (row === undefined || row.ref.kind !== ref.kind) return undefined
      const target = targetOf(row)
      return { row, ...(target === undefined ? {} : { target }) }
    },
    parsed: (ref, info) => {
      const row = rows.get(keyOf(ref.rootID, ref.id))
      const file = row === undefined ? undefined : fileOf(row)
      if (row === undefined || file === undefined || info.source.bytes !== file.size) return
      const turns = info.turns.length
      const counts = [...(importTurns.get(row.key) ?? [])].filter((count) => count <= turns)
      parsed.set(row.key, {
        size: file.size,
        mtimeMs: file.mtimeMs,
        turns,
        compactions: info.checkpoints.length,
        hashes: new Map(counts.map((count) => [count, Transcript.contentHash(info.turns.slice(0, count))])),
      })
      const top = row.ref.kind === "claude-code" && !row.subagent
      put({
        ...row,
        compactions: info.checkpoints.length,
        ...(top ? { cwds: union(row.cwds, info.source.cwds), confirmed: true } : {}),
      })
      flush()
      schedulePersist()
    },
    members: (project) => {
      const member = memberOf(project)
      return dedupe([...rows.values()]).filter((row) => !row.subagent && member(row))
    },
    member: (row, project) => memberOf(project)(row),
    sessions: (rootID) =>
      codex.has(rootID) || claude.has(rootID) ? ofRoot(rootID).filter((row) => !row.subagent).length : undefined,
    refresh,
    idle: async () => {
      await state.work
      await state.confirm
      await state.swept
      await flushPersist()
    },
    close: async () => {
      state.closed = true
      if (state.emit !== undefined) clearTimeout(state.emit)
      state.emit = undefined
      await state.work
      await state.confirm
      await state.swept
      await flushPersist()
    },
  }
}

function sameStamp(a: Snapshot.Stamp | null, b: Snapshot.Stamp | null) {
  if (a === null || b === null) return a === b
  return same(a.db, b.db) && (a.wal === null || b.wal === null ? a.wal === b.wal : same(a.wal, b.wal))
}

/** Restats the known files of an unchanged folder; vanished ones drop out. */
async function restat(root: Paths.Root, files: ReadonlyArray<ClaudeSource.Conversation>) {
  const stated = await mapLimit(files, LITE_READS * 4, async (conversation) => {
    const stat = await Paths.stat(root, conversation.path)
    return stat.ok && stat.value.file ? [{ ...conversation, size: stat.value.size, mtimeMs: stat.value.mtimeMs }] : []
  })
  return stated.flat()
}

/** One row per conversation across roots: the latest activity wins, then the larger file, else the earlier root. */
function dedupe(list: ReadonlyArray<Row>) {
  const best = list.reduce((found, row) => {
    const id = `${row.ref.kind}/${row.ref.id}`
    const known = found.get(id)
    const better =
      known === undefined ||
      row.updatedAt > known.updatedAt ||
      (row.updatedAt === known.updatedAt && (fileOf(row)?.size ?? 0) > (fileOf(known)?.size ?? 0))
    if (better) found.set(id, row)
    return found
  }, new Map<string, Row>())
  return list.filter((row) => best.get(`${row.ref.kind}/${row.ref.id}`) === row)
}

/** Sub-agent rows per parent row key. */
function children(list: ReadonlyArray<Row>) {
  return list.reduce((counts, row) => {
    if (!row.subagent || row.parent === undefined) return counts
    const key = keyOf(row.root.rootID, row.parent)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map<string, number>())
}

// ---------------------------------------------------------------------------------------------------------------
// Order and cursor

type SortKey = ReadonlyArray<number | string>

/**
 * Newest first. In scope `all` the rows are grouped by their last folder, the group with the newest row first. A
 * sub-agent row whose parent is listed follows its parent, so a page never separates them.
 */
function order(list: ReadonlyArray<Row>, scope: Scope, byKey: ReadonlyMap<string, Row>) {
  const listed = new Set(list.map((row) => row.key))
  const group = (row: Row) => Paths.key(row.cwds.at(-1) ?? "")
  const newest = list.reduce((found, row) => {
    const key = group(row)
    found.set(key, Math.max(found.get(key) ?? Number.NEGATIVE_INFINITY, row.updatedAt))
    return found
  }, new Map<string, number>())
  const base = (row: Row): SortKey =>
    scope === "all"
      ? [-(newest.get(group(row)) ?? row.updatedAt), group(row), -row.updatedAt, row.key]
      : [-row.updatedAt, row.key]
  const parentOf = (row: Row) => {
    const key = row.subagent && row.parent !== undefined ? keyOf(row.root.rootID, row.parent) : undefined
    return key !== undefined && listed.has(key) ? byKey.get(key) : undefined
  }
  return list
    .map((row) => {
      const parent = parentOf(row)
      const sort: SortKey = parent === undefined ? [...base(row), 0] : [...base(parent), 1, -row.updatedAt, row.key]
      return { row, sort }
    })
    .sort((a, b) => compare(a.sort, b.sort))
}

function compare(a: SortKey, b: SortKey): number {
  const index = a.findIndex((value, at) => value !== b[at])
  if (index === -1) return a.length - b.length
  const left = a[index]
  const right = b[index]
  if (right === undefined) return 1
  if (typeof left === "number" && typeof right === "number") return left - right
  return String(left) < String(right) ? -1 : 1
}

const decodeSortKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.Finite, Schema.String]))),
)

/** The sort key of a page's last row: the next page starts after it even when rows were added meanwhile. */
function encodeCursor(sort: SortKey) {
  return Buffer.from(JSON.stringify(sort)).toString("base64url")
}

/** An unusable cursor starts from the first page. */
function decodeCursor(cursor: string | undefined): SortKey | undefined {
  if (cursor === undefined) return undefined
  return Option.getOrUndefined(decodeSortKey(Buffer.from(cursor, "base64url").toString("utf8")))
}

// ---------------------------------------------------------------------------------------------------------------
// Imported marks (09 §4.7 알아보기)

export interface Mark {
  readonly sessionID: SelfHttp.SessionView["id"]
  readonly mode: OwnImport.Mode
  readonly importedAt: number
  readonly turns: number
  readonly contentHash: string
  readonly created: number
}

/**
 * The imports among `sessions` by `<kind>/<sourceID>`, newest first. Helpers are never imports. Core copies metadata
 * into forks, so one import is one `(sourceID, importedAt)`: its oldest session.
 */
export function marks(sessions: ReadonlyArray<SelfHttp.SessionView>): Map<string, Mark[]> {
  const imports = sessions.flatMap((session) => {
    const meta = OwnImport.decodeMetadata(session.metadata)
    if (meta === undefined || OwnImport.isHelper(meta)) return []
    const mark: Mark = {
      sessionID: session.id,
      mode: meta.mode,
      importedAt: meta.importedAt,
      turns: meta.turns,
      contentHash: meta.contentHash,
      created: session.time.created,
    }
    return [{ key: `${meta.kind}/${meta.sourceID}`, mark }]
  })
  const oldest = imports.reduce((found, item) => {
    const id = `${item.key}\0${item.mark.importedAt}`
    const known = found.get(id)
    if (known === undefined || item.mark.created < known.mark.created) found.set(id, item)
    return found
  }, new Map<string, (typeof imports)[number]>())
  return [...oldest.values()].reduce((found, item) => {
    found.set(
      item.key,
      [...(found.get(item.key) ?? []), item.mark].sort((a, b) => b.importedAt - a.importedAt),
    )
    return found
  }, new Map<string, Mark[]>())
}

// ---------------------------------------------------------------------------------------------------------------
// Summary

/**
 * One list row (`OwnImport.Summary`): the list's and the viewer header's. The title and the first prompt are
 * conversation text a `read` device sees (09 §5.5), so a secret in them shows as `[redacted:<label>]`.
 */
export function summary(
  row: Row,
  context: {
    readonly now: number
    readonly exists: (cwd: string) => boolean
    readonly imported: ReadonlyArray<OwnImport.Imported>
    readonly children: number
    readonly compactions: number
  },
): OwnImport.Summary {
  const cwd = row.cwds.at(-1) ?? ""
  const file = fileOf(row)
  const parent = row.parent === undefined ? undefined : refOf(row.ref.kind, row.root.rootID, row.parent)
  return {
    ref: row.ref,
    title: Redact.named(row.title).text,
    ...(row.firstPrompt === undefined ? {} : { firstPrompt: Redact.named(row.firstPrompt).text }),
    app: row.app ?? null,
    cwd,
    folderExists: cwd !== "" && context.exists(cwd),
    ...(row.branch === undefined || row.branch === "" ? {} : { branch: row.branch }),
    models: row.models
      .filter((model) => model.id !== "")
      .map((model) => (model.provider ? { provider: model.provider, id: model.id } : { id: model.id })),
    versions: [...row.versions],
    createdAt: Math.max(0, row.createdAt),
    updatedAt: Math.max(0, row.updatedAt),
    compactions: context.compactions,
    subagents: context.children,
    live: file !== undefined && context.now - file.mtimeMs < LIVE_MS,
    imported: [...context.imported],
    readable: row.problem === undefined,
    ...(row.problem === undefined ? {} : { problem: row.problem }),
    ...(parent === undefined ? {} : { parent }),
    archived: row.archived,
    otherComputer: row.otherComputer,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** Runs `run` over `items` with at most `size` at once, keeping the order of the results. */
async function mapLimit<T, R>(items: ReadonlyArray<T>, size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  const cursor = { next: 0 }
  const worker = async () => {
    while (cursor.next < items.length) {
      const index = cursor.next++
      results[index] = await run(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
  return results
}

function chunks<T>(items: ReadonlyArray<T>, size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}
