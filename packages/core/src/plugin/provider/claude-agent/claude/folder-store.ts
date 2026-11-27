// OWN-PATCH(P-045) begin
export * as FolderStore from "./folder-store.js"

import fs from "node:fs/promises"
// OWN-PATCH(P-043) begin
import { realpathSync } from "node:fs"
// OWN-PATCH(P-043) end
import path from "node:path"
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeIO } from "./io.js"
// OWN-PATCH(P-043) begin
import { ClaudeObserver } from "./observer.js"
import { ClaudeSDK } from "./sdk.js"
// OWN-PATCH(P-043) end

// The SDK's session helpers (getSessionInfo, getSessionMessages, forkSession, deleteSession) read the transcripts of
// the service's own CLAUDE_CONFIG_DIR, resolved once. own runs claude with an account folder the provider settings name,
// so the helpers get this store instead: the transcripts of that folder, laid out as Claude Code writes them
// (`projects/<sanitized directory>/<session>.jsonl`, the SDK's projectKey), so a fork lands where `--resume` reads.
export function make(configDir: string): SessionStore {
  const root = path.join(configDir, "projects")
  const file = (key: SessionKey) =>
    key.subpath
      ? path.join(root, key.projectKey, key.sessionId, `${key.subpath}.jsonl`)
      : path.join(root, key.projectKey, `${key.sessionId}.jsonl`)
  return {
    append: async (key, entries) => {
      // OWN-PATCH(P-043) begin
      // Written in the checked shared folder itself, never through the account's link (CAG-42).
      const real = await writable(configDir, key.projectKey)
      const target = path.join(real, path.relative(root, file(key)))
      await place(configDir, real, target)
      await fs.appendFile(target, entries.map((entry) => JSON.stringify(entry) + "\n").join(""))
      // OWN-PATCH(P-043) end
    },
    load: async (key) => {
      const text = await fs.readFile(file(key), "utf8").catch(() => undefined)
      if (text === undefined) return null
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line): SessionStoreEntry => JSON.parse(line))
    },
    listSessions: async (projectKey) => {
      const folder = path.join(root, projectKey)
      const names = await fs.readdir(folder).catch((): string[] => [])
      const sessions = await Promise.all(
        names
          .filter((name) => name.endsWith(".jsonl"))
          .map(async (name) => ({
            sessionId: name.slice(0, -".jsonl".length),
            mtime: Math.trunc((await fs.stat(path.join(folder, name))).mtimeMs),
          })),
      )
      return sessions
    },
    delete: async (key) => {
      // OWN-PATCH(P-043) begin
      if (!SESSION_ID.test(key.sessionId))
        throw new Error(`Claude Agent removes transcripts by session id only: ${key.sessionId}`)
      const real = await writable(configDir, key.projectKey)
      await fs.rm(path.join(real, path.relative(root, file(key))), { force: true })
      if (!key.subpath) await fs.rm(path.join(real, key.projectKey, key.sessionId), { recursive: true, force: true })
      // OWN-PATCH(P-043) end
    },
  }
}

// The options for an SDK session helper: this folder's store. Without a folder the SDK would read the service's own
// CLAUDE_CONFIG_DIR (another route's login, or the user's ~/.claude), so the helper fails closed instead.
export function options(folder: ClaudeIO.Folder | undefined) {
  if (!folder) throw new Error("Claude Agent has no account folder for this conversation's transcript.")
  return { dir: folder.directory, sessionStore: make(folder.configDir) }
}
// OWN-PATCH(P-045) end

// OWN-PATCH(P-043) begin
// The SDK's project folder name for a working directory (its projectKey): the real path with every character that is
// not a letter or digit a dash, a long one cut at 200 and given a hash, where `--resume` and the helpers look.
export function projectKey(directory: string) {
  const resolved = path.resolve(directory)
  const real = (() => {
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  })()
  const key = real.replace(/[^a-zA-Z0-9]/g, "-")
  if (key.length <= 200) return key
  let hash = 0
  for (const char of real) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

// own writes and checks the transcripts of its account folders itself (P-043): the chain claude resumes (read by the
// SDK's own helper, so own sees what `--resume` sees), raw appends in claude's layout, and every transcript of a folder.
export const transcripts: ClaudeIO.Transcripts = {
  chain: async (sessionID, folder) => {
    const store = make(folder.configDir)
    const lines = await store.load({ projectKey: projectKey(folder.directory), sessionId: sessionID })
    if (lines === null) return undefined
    const { getSessionMessages } = await ClaudeSDK.load()
    // The lines already read, so the chain and the times below come from one read of the file.
    const messages = await getSessionMessages(sessionID, {
      dir: folder.directory,
      sessionStore: { ...store, load: async () => lines },
    })
    const timestamps = new Map<string, string>()
    for (const line of lines) {
      const entry = line as { readonly uuid?: unknown; readonly timestamp?: unknown }
      if (typeof entry.uuid === "string" && typeof entry.timestamp === "string") timestamps.set(entry.uuid, entry.timestamp)
    }
    return { messages, timestamps }
  },
  write: async (sessionID, folder, entries, replace) => {
    const store = make(folder.configDir)
    const key = { projectKey: projectKey(folder.directory), sessionId: sessionID }
    if (replace) await store.delete?.(key)
    await store.append(key, entries as SessionStoreEntry[])
  },
  list: async (configDir) => {
    const root = await writable(configDir)
    const folders = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const found = await Promise.all(
      folders
        .filter((folder) => folder.isDirectory())
        .map(async (folder) => {
          const names = await fs.readdir(path.join(root, folder.name)).catch((): string[] => [])
          return Promise.all(
            names
              // A session id is a uuid: a name like `.jsonl` or `...jsonl` would name the folder itself (CAG-34).
              .filter((name) => name.endsWith(".jsonl") && SESSION_ID.test(name.slice(0, -".jsonl".length)))
              .map(async (name) => ({
                projectKey: folder.name,
                sessionID: name.slice(0, -".jsonl".length),
                mtime: (await fs.stat(path.join(root, folder.name, name)).catch(() => undefined))?.mtimeMs ?? Date.now(),
              })),
          )
        }),
    )
    return found.flat()
  },
  discard: (configDir, project, sessionID) =>
    make(configDir).delete?.({ projectKey: project, sessionId: sessionID }) ?? Promise.resolve(),
}

// own (CAG-34, CAG-42): an account folder's `projects` is a junction to the shared transcript folder own-accounts
// manages, and own writes and removes transcripts only in that folder, a real one, so a `projects` that points
// elsewhere (a junction to ~/.claude/projects made by hand, say) never has own write or delete there. own-accounts names
// the folder by its checked real path, so a junction anywhere on its way (`<OWN_HOME>\claude-agent` itself, say) makes
// its real path differ and is refused too, as is a project folder that is a link. Reads stay open.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The shared folder's real path once the account folder's `projects` is that folder; refuses (in Korean) otherwise. */
async function writable(configDir: string, projectKey?: string) {
  const link = path.join(configDir, "projects")
  const shared = ClaudeObserver.shared()
  if (!shared) throw refuse(link, "own이 함께 쓰는 대화 기록 폴더를 알려 주지 않았어요")
  const [real, mine] = await Promise.all([
    fs.realpath(shared).catch(() => undefined),
    fs.realpath(link).catch(() => undefined),
  ])
  if (!real || same(real) !== same(path.resolve(shared)))
    throw refuse(link, `${shared}가 진짜 폴더가 아니에요(링크나 정션을 거쳐요)`)
  if (!mine || same(mine) !== same(real)) throw refuse(link, `함께 쓰는 대화 기록 폴더 ${shared}가 아니에요`)
  if (projectKey === undefined) return real
  const project = path.join(real, projectKey)
  const [found, resolved] = await Promise.all([
    fs.lstat(project).catch(() => undefined),
    fs.realpath(project).catch(() => undefined),
  ])
  if (found && (found.isSymbolicLink() || !found.isDirectory() || !resolved || same(resolved) !== same(project)))
    throw refuse(link, `${projectKey}가 진짜 폴더가 아니에요`)
  return real
}

// A transcript is appended only as one plain file in real folders: each folder below the shared one is made one level
// at a time and must lie where it is (a session folder that is a junction would take the append elsewhere), and the
// file must be neither a link nor a file that also has another name elsewhere (a hard link), whose other name the
// append would change too (CAG-44).
async function place(configDir: string, real: string, file: string) {
  const link = path.join(configDir, "projects")
  const parts = path.relative(real, path.dirname(file)).split(path.sep)
  for (const at of parts.map((_, index) => path.join(real, ...parts.slice(0, index + 1)))) {
    await fs.mkdir(at).catch(() => undefined)
    const [found, resolved] = await Promise.all([
      fs.lstat(at).catch(() => undefined),
      fs.realpath(at).catch(() => undefined),
    ])
    if (!found?.isDirectory() || found.isSymbolicLink() || !resolved || same(resolved) !== same(at))
      throw refuse(link, `${at}가 진짜 폴더가 아니에요`)
  }
  const found = await fs.lstat(file).catch(() => undefined)
  if (found && (found.isSymbolicLink() || !found.isFile() || found.nlink > 1))
    throw refuse(link, `${file}가 링크이거나 다른 곳에도 이름이 있는 파일(하드 링크)이에요`)
}

function refuse(link: string, why: string) {
  return new Error(`Claude Agent가 ${link}의 대화 기록을 바꾸지 않았어요: ${why}. 그 링크를 고친 뒤 다시 시도하세요.`)
}

function same(folder: string) {
  return process.platform === "win32" ? folder.toLowerCase() : folder
}
// OWN-PATCH(P-043) end
