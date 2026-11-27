export * as ClaudeSource from "./claude.js"

import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { ClaudeTranscript } from "../transcript/claude.js"
import type { Transcript } from "../transcript/ir.js"
import { Paths } from "./paths.js"

/**
 * Claude Code conversations on this PC (09 §2.1, §2.2, §2.3, §2.6): `<root>/projects/<folder>/<sessionId>.jsonl`,
 * the sub-agent files and `custom-title.json` in the conversation's own folder, and `tool-results/` read only when the
 * viewer asks. Every file operation goes through {@link Paths} (allowlist, read-only, no handle held between calls).
 *
 * The list reads only the first and last 64 KiB of a file (SDK `_read_session_lite`, Claude Agent SDK for Python, MIT):
 * its folder membership is provisional, because a `relocated` record or a changed cwd may lie in between, and
 * {@link confirm} scans the whole file for the cwd keys without parsing JSON. The full parse streams the file line by
 * line into {@link ClaudeTranscript.reader}. Folder names (`D---Projects-own-open-code`, over 200 characters with a
 * hash suffix) are never decoded back into paths: membership is always the cwd recorded in the file (09 §2.2).
 */

/** The lite read's window at each end of a file. */
export const LITE_BYTES = 64 * 1024
/** Longer lines are skipped and counted (`dropped.oversizedLine`, 09 §2.8). */
export const LINE_MAX = 32 * 1024 * 1024
/** The most a `tool-results` file is read for the viewer. */
export const TOOL_RESULT_MAX = 4 * 1024 * 1024

/** A top-level conversation file: `<uuid>.jsonl` (not `agent-*.jsonl`, `*.superseded-*`, `*.orphaned-*`). */
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i
const AGENT_FILE = /^agent-(.+)\.jsonl$/
/** `subagents/workflows/wf_<id>/…` nests; deeper folders are not read. */
const SUBAGENT_DEPTH = 4

const isSourceID = Schema.is(OwnImport.SourceID)

/** A folder of `projects`: one per cwd Claude Code ran in (Desktop SSH sessions: `ssh-<uuid>`). */
export interface Folder {
  readonly name: string
  readonly path: string
  readonly mtimeMs: number
  /** `projects/ssh-*`: a Claude Desktop SSH session, whose cwd is a path on another computer (09 §2.2). */
  readonly otherComputer: boolean
}

/** A conversation file. */
export interface Conversation {
  /** The session id, or `<sessionId>:<agentId>` for a sub-agent conversation (09 §5.2). */
  readonly id: string
  readonly path: string
  /** Its `projects` folder name. */
  readonly folder: string
  readonly size: number
  readonly mtimeMs: number
  /** A sub-agent conversation's session id. */
  readonly parentID?: string
}

/** A conversation as the list shows it, from the lite read (09 §2.3). */
export interface Listed extends Conversation {
  /** Every cwd seen in the first and last 64 KiB: provisional membership until {@link confirm} (09 §2.3). */
  readonly cwds: ReadonlyArray<string>
  readonly title: string
  readonly firstPrompt?: string
  readonly branch?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly versions: ReadonlyArray<string>
  /** The model of the last answer in the window. */
  readonly model?: string
  /** Compactions seen in the windows (a lower bound; {@link confirm} counts them all). */
  readonly compactions: number
  readonly otherComputer: boolean
  /** Written within the last two minutes: `진행 중일 수 있음` (09 §2.6). */
  readonly live: boolean
}

/** A sub-agent conversation (`<session>/subagents/**\/agent-<agentId>.jsonl` with its `.meta.json`). */
export interface Child extends Conversation, ClaudeTranscript.Child {
  readonly parentID: string
  /** `meta.parentAgentId`: started by another sub-agent rather than the main conversation. */
  readonly parentAgentId?: string
}

/** The folders of `<root>/projects`; a root without one has none. */
export async function folders(root: Paths.Root): Promise<Paths.Result<Folder[]>> {
  const projects = path.join(root.directory, "projects")
  const listed = await Paths.list(root, projects)
  if (!listed.ok) return listed
  const found = await Promise.all(
    listed.value
      .filter((entry) => entry.kind === "directory")
      .map(async (entry): Promise<Folder[]> => {
        const folder = path.join(projects, entry.name)
        const stat = await Paths.stat(root, folder, "list")
        if (!stat.ok) return []
        return [
          { name: entry.name, path: folder, mtimeMs: stat.value.mtimeMs, otherComputer: entry.name.startsWith("ssh-") },
        ]
      }),
  )
  return { ok: true, value: found.flat() }
}

/** The top-level conversation files of one folder, with size and mtime (the cache key, 09 §2.3). */
export async function conversations(root: Paths.Root, folder: string): Promise<Paths.Result<Conversation[]>> {
  const directory = path.join(root.directory, "projects", folder)
  const listed = await Paths.list(root, directory)
  if (!listed.ok) return listed
  const found = await Promise.all(
    listed.value
      .filter((entry) => entry.kind === "file" && SESSION_FILE.test(entry.name))
      .map(async (entry): Promise<Conversation[]> => {
        const file = path.join(directory, entry.name)
        const stat = await Paths.stat(root, file)
        if (!stat.ok || !stat.value.file) return []
        return [
          {
            id: entry.name.slice(0, -".jsonl".length),
            path: file,
            folder,
            size: stat.value.size,
            mtimeMs: stat.value.mtimeMs,
          },
        ]
      }),
  )
  return { ok: true, value: found.flat() }
}

/**
 * The list fields of a conversation from its first and last 64 KiB (09 §2.3). `undefined` for a file the list skips:
 * a sidechain-only file, or one with only metadata (no title and no human line, like the SDK).
 */
export async function lite(
  root: Paths.Root,
  conversation: Conversation,
  now = Date.now(),
): Promise<Paths.Result<Listed | undefined>> {
  const read = await Paths.withFile(root, conversation.path, "read", async (handle) => {
    const size = (await handle.stat()).size
    const head = await bytes(handle, 0, Math.min(size, LITE_BYTES))
    const from = Math.max(LITE_BYTES, size - LITE_BYTES)
    const tail = size > LITE_BYTES ? await bytes(handle, from, size - from) : new Uint8Array()
    return { head: new TextDecoder().decode(head), tail: new TextDecoder().decode(tail) }
  })
  if (!read.ok) return read
  const fields = ClaudeTranscript.lite(read.value)
  if (fields.sidechain) return { ok: true, value: undefined }
  const file = fields.titles.custom === undefined ? await customTitle(root, conversation) : undefined
  const title = ClaudeTranscript.title({ ...fields.titles, file, first: fields.firstPrompt })
  if (title === "" && fields.firstPrompt === undefined) return { ok: true, value: undefined }
  return {
    ok: true,
    value: {
      ...conversation,
      cwds: fields.cwds,
      title,
      firstPrompt: fields.firstPrompt,
      branch: fields.branch,
      createdAt: fields.createdAt ?? conversation.mtimeMs,
      updatedAt: fields.updatedAt ?? conversation.mtimeMs,
      versions: fields.versions,
      model: fields.model,
      compactions: fields.compactions,
      otherComputer: conversation.folder.startsWith("ssh-"),
      live: now - conversation.mtimeMs < ClaudeTranscript.LIVE_MS,
    },
  }
}

/** Every listed conversation of a root: each folder's files through {@link lite}; unreadable files are left out. */
export async function scan(root: Paths.Root, now = Date.now()): Promise<Paths.Result<Listed[]>> {
  const found = await folders(root)
  if (!found.ok) return found
  const listed: Listed[] = []
  for (const folder of found.value) {
    const files = await conversations(root, folder.name)
    if (!files.ok) continue
    const read = await Promise.all(files.value.map((conversation) => lite(root, conversation, now)))
    listed.push(...read.flatMap((result) => (result.ok && result.value !== undefined ? [result.value] : [])))
  }
  return { ok: true, value: listed }
}

/** What the whole file says about its folders (09 §2.3 확정). */
export interface Confirmed {
  /** Every `cwd` and `relocatedCwd` value of the file, first to last. */
  readonly cwds: ReadonlyArray<string>
  /** `compact_boundary` records in the file. */
  readonly compactions: number
}

/**
 * The confirm pass (09 §2.3): streams the whole file and collects every `"cwd":"…"` and `"relocatedCwd":"…"` value
 * as a substring, without parsing JSON, so membership no longer depends on the 64 KiB windows.
 */
export async function confirm(root: Paths.Root, conversation: Conversation): Promise<Paths.Result<Confirmed>> {
  return Paths.withFile(root, conversation.path, "read", async (handle) => {
    const cwds = new Set<string>()
    const counted = { compactions: 0 }
    for await (const line of lines(Paths.chunks(handle))) {
      if (line.type !== "line") continue
      ClaudeTranscript.cwdsOf(line.text).forEach((cwd) => cwds.add(cwd))
      if (line.text.includes('"compact_boundary"')) counted.compactions++
    }
    return { cwds: [...cwds], compactions: counted.compactions }
  })
}

/**
 * The full parse (09 §2.6): streams the file into the reader. A main conversation also lists its sub-agent files
 * (view-only child links) and reads `custom-title.json`; a sub-agent conversation takes its `meta.description` as
 * its title. A file over `limit` bytes is `too_large` without being read (09 §2.8, IG4).
 */
export async function transcript(
  root: Paths.Root,
  conversation: Conversation | Child,
  now = Date.now(),
  limit = Paths.PARSE_BYTES,
): Promise<Paths.Result<Transcript.Info> | { readonly ok: false; readonly reason: "too_large" }> {
  const parentID = conversation.parentID
  const kids = parentID === undefined ? await children(root, conversation) : []
  const named = parentID === undefined ? await customTitle(root, conversation) : childTitle(conversation)
  const read = await Paths.withFile(root, conversation.path, "read", async (handle) => {
    const stat = await handle.stat()
    if (stat.size > limit) return undefined
    const reader = ClaudeTranscript.reader({ subagent: parentID !== undefined })
    for await (const line of lines(Paths.chunks(handle))) reader.push(line)
    return reader.finish({
      id: conversation.id,
      rootID: root.rootID,
      path: conversation.path,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      now,
      ...(parentID === undefined ? {} : { parentID }),
      ...(named === undefined ? {} : { customTitle: named }),
      children: kids,
    })
  })
  if (!read.ok) return read
  return read.value === undefined ? { ok: false, reason: "too_large" } : { ok: true, value: read.value }
}

const Meta = Schema.Struct({
  agentType: optional(Schema.String),
  description: optional(Schema.String),
  toolUseId: optional(Schema.String),
  parentAgentId: optional(Schema.String),
})
const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta))

/**
 * The sub-agent conversations of a main conversation (09 §2.6 하위 에이전트): `<session>/subagents/**\/agent-*.jsonl`
 * with their `.meta.json` (type, description, the Agent call that started them). View-only links; never merged into
 * the main chain. An agent id that cannot form a `SourceID` is left out.
 */
export async function children(root: Paths.Root, conversation: Conversation): Promise<Child[]> {
  const files = await agents(root, path.join(folderOf(root, conversation), "subagents"), 0)
  const found = await Promise.all(
    files.map(async (file): Promise<Child[]> => {
      const id = `${conversation.id}:${file.agentId}`
      const stat = await Paths.stat(root, file.path)
      if (!isSourceID(id) || !stat.ok) return []
      const meta = file.meta === undefined ? undefined : await Paths.read(root, file.meta)
      const decoded = meta?.ok ? Option.getOrUndefined(decodeMeta(new TextDecoder().decode(meta.value))) : undefined
      return [
        {
          id,
          agentId: file.agentId,
          path: file.path,
          folder: conversation.folder,
          size: stat.value.size,
          mtimeMs: stat.value.mtimeMs,
          parentID: conversation.id,
          ...(decoded?.description === undefined ? {} : { title: decoded.description }),
          ...(decoded?.agentType === undefined ? {} : { agent: decoded.agentType }),
          ...(decoded?.toolUseId === undefined ? {} : { toolUseId: decoded.toolUseId }),
          ...(decoded?.parentAgentId === undefined ? {} : { parentAgentId: decoded.parentAgentId }),
        },
      ]
    }),
  )
  return found.flat().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** `agent-*.jsonl` files below `directory`, with the `.meta.json` beside each when there is one. */
async function agents(
  root: Paths.Root,
  directory: string,
  depth: number,
): Promise<Array<{ readonly path: string; readonly agentId: string; readonly meta?: string }>> {
  if (depth > SUBAGENT_DEPTH) return []
  const listed = await Paths.list(root, directory)
  if (!listed.ok) return []
  const names = new Set(listed.value.map((entry) => entry.name))
  const here = listed.value.flatMap((entry) => {
    const agentId = entry.kind === "file" ? AGENT_FILE.exec(entry.name)?.[1] : undefined
    if (agentId === undefined) return []
    const meta = `agent-${agentId}.meta.json`
    return [
      {
        path: path.join(directory, entry.name),
        agentId,
        ...(names.has(meta) ? { meta: path.join(directory, meta) } : {}),
      },
    ]
  })
  const nested = await Promise.all(
    listed.value
      .filter((entry) => entry.kind === "directory")
      .map((entry) => agents(root, path.join(directory, entry.name), depth + 1)),
  )
  return [...here, ...nested.flat()]
}

const CustomTitle = Schema.Struct({ customTitle: Schema.String })
const decodeCustomTitle = Schema.decodeUnknownOption(Schema.fromJsonString(CustomTitle))

/** `<session>/custom-title.json`'s title, when there is one. */
export async function customTitle(root: Paths.Root, conversation: Conversation) {
  const read = await Paths.read(root, path.join(folderOf(root, conversation), "custom-title.json"))
  if (!read.ok) return undefined
  const title = Option.getOrUndefined(decodeCustomTitle(new TextDecoder().decode(read.value)))?.customTitle.trim()
  return title === "" ? undefined : title
}

/**
 * A `tool-results` file of a conversation, read only when the viewer opens a `<persisted-output>` preview
 * ({@link ClaudeTranscript.persisted}): at most `limit` bytes; `bytes` is the whole file's size.
 */
export async function toolResult(
  root: Paths.Root,
  conversation: Conversation,
  name: string,
  limit = TOOL_RESULT_MAX,
): Promise<Paths.Result<{ readonly text: string; readonly bytes: number }>> {
  if (!ClaudeTranscript.FILE_NAME.test(name)) return { ok: false, reason: "path_denied" }
  return Paths.withFile(root, path.join(folderOf(root, conversation), "tool-results", name), "read", async (handle) => {
    const size = (await handle.stat()).size
    return { text: new TextDecoder().decode(await bytes(handle, 0, Math.min(size, limit))), bytes: size }
  })
}

function childTitle(conversation: Conversation | Child) {
  return "title" in conversation ? conversation.title : undefined
}

/** `<root>/projects/<folder>/<sessionId>`: the folder beside a conversation file (a sub-agent: its session's). */
function folderOf(root: Paths.Root, conversation: Conversation) {
  return path.join(root.directory, "projects", conversation.folder, conversation.parentID ?? conversation.id)
}

/** The read-only handle {@link Paths.withFile} lends (this module never imports `fs`, 09 §2.1). */
type Handle = Parameters<Parameters<typeof Paths.withFile>[3]>[0]

async function bytes(handle: Handle, position: number, length: number) {
  const buffer = Buffer.alloc(length)
  const read = await handle.read(buffer, 0, length, position)
  return buffer.subarray(0, read.bytesRead)
}

/**
 * Splits a byte stream into lines (09 §2.8): a line over `max` bytes is reported as `oversized` without keeping it,
 * and a last line without its newline as `torn` (the tool may still be writing it). `\r` before a newline is left for
 * the reader's trim.
 */
export async function* lines(chunks: AsyncIterable<Uint8Array>, max = LINE_MAX): AsyncGenerator<ClaudeTranscript.Line> {
  const decoder = new TextDecoder()
  const line = { text: "", size: 0, over: false }
  for await (const chunk of chunks) {
    for (let start = 0; start <= chunk.length; ) {
      const found = chunk.indexOf(10, start)
      const end = found === -1 ? chunk.length : found
      line.size += end - start
      line.over = line.over || line.size > max
      const piece = decoder.decode(chunk.subarray(start, end), { stream: true })
      line.text = line.over ? "" : line.text + piece
      if (found === -1) break
      // Flushed at every line end, so a cut character of a skipped line never reaches the next one.
      const rest = decoder.decode()
      yield line.over ? { type: "oversized" } : { type: "line", text: line.text + rest }
      line.text = ""
      line.size = 0
      line.over = false
      start = found + 1
    }
  }
  if (line.size > 0) yield { type: "torn" }
}
