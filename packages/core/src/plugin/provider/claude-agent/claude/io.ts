export * as ClaudeIO from "./io.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-043) begin
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-043) end
// OWN-PATCH(P-044) begin
import type { SpareProcess } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-044) end
import { which } from "../../../../util/which.js"
import { ClaudeFork } from "./fork.js"
// OWN-PATCH(P-045) begin
import { FolderStore } from "./folder-store.js"
// OWN-PATCH(P-045) end
import { ClaudeSDK } from "./sdk.js"
// OWN-PATCH(P-051) begin
import { execFile } from "node:child_process"
import { statSync } from "node:fs"
import type { ClaudeProbe } from "./probe.js"
// OWN-PATCH(P-051) end
// OWN-PATCH(P-052) begin
import { ClaudeObserver } from "./observer.js"
import { ClaudeRelay } from "./relay.js"
// OWN-PATCH(P-052) end

// OWN-PATCH(P-045) begin
// The account folder a process ran with (its CLAUDE_CONFIG_DIR) and the directory it ran in. The SDK's session helpers
// read the service's own CLAUDE_CONFIG_DIR once, so with a folder they use a store over that folder's transcripts.
export interface Folder {
  readonly configDir: string
  readonly directory: string
}
// OWN-PATCH(P-045) end

// Everything that reaches outside opencode. Tests swap it for a fake `claude`.
export interface Interface {
  // Undefined uses the SDK's own spawn
  readonly spawn?: Options["spawnClaudeCodeProcess"]
  readonly which: () => string | undefined
  // Before our isolation settings
  readonly env: () => Record<string, string | undefined>
  // OWN-PATCH(P-045) begin
  // The real binary runs only with an account folder the provider settings name (own's Claude Agent route).
  readonly requiresFolder?: boolean
  readonly sessionExists: (sessionID: string, folder?: Folder) => Promise<boolean>
  readonly fork: (sessionID: string, messageID: string, folder?: Folder) => Promise<ClaudeFork.Result | undefined>
  readonly remove: (sessionID: string, folder?: Folder) => Promise<void>
  // OWN-PATCH(P-045) end
  // OWN-PATCH(P-043) begin
  // own writes the history claude has not seen as a transcript it resumes (02 §8.10.11). Without this the provider
  // sends that history as one `<conversation-checkpoint>` text, as upstream does.
  readonly transcripts?: Transcripts
  // OWN-PATCH(P-043) end
  // OWN-PATCH(P-044) begin
  // A spare claude for new conversations (the SDK's prewarm, alpha); without it there are no spares.
  readonly prewarm?: (options: Options) => Promise<SpareProcess>
  // OWN-PATCH(P-044) end
  // OWN-PATCH(P-051) begin
  // A binary's `--version`, for a Claude Code that leaves the version out of its initialize reply.
  readonly version?: ClaudeProbe.ReadVersion
  // OWN-PATCH(P-051) end
  // OWN-PATCH(P-052) begin
  // On an SSH host (ClaudeRelay): a conversation's process first waits for a slot of the PC's pool, and its spawn then
  // goes to that slot. Without it a start spawns at once.
  readonly admit?: (
    member: { readonly sessionID?: string; readonly parentID?: string; readonly side: boolean },
    folder: { readonly configDir: string; readonly directory: string },
    signal?: AbortSignal,
  ) => Promise<{ readonly spawn: NonNullable<Options["spawnClaudeCodeProcess"]>; readonly release: () => void }>
  // Appended to the system prompt (a host's claude runs on the PC, whose folder and platform it reports).
  readonly note?: string
  // OWN-PATCH(P-052) end
}

// OWN-PATCH(P-043) begin
export interface Chain {
  // The user and assistant messages claude would resume, oldest first (the SDK's getSessionMessages).
  readonly messages: ReadonlyArray<SessionMessage>
  readonly timestamps: ReadonlyMap<string, string>
}

export interface Transcripts {
  // Undefined when the session's file is gone.
  readonly chain: (sessionID: string, folder: Folder) => Promise<Chain | undefined>
  // Appends entries in claude's layout; `replace` empties the file first.
  readonly write: (sessionID: string, folder: Folder, entries: readonly object[], replace: boolean) => Promise<void>
  // Every transcript under a folder's `projects`, with its project folder name and modification time.
  readonly list: (
    configDir: string,
  ) => Promise<ReadonlyArray<{ readonly projectKey: string; readonly sessionID: string; readonly mtime: number }>>
  readonly discard: (configDir: string, projectKey: string, sessionID: string) => Promise<void>
}
// OWN-PATCH(P-043) end

// OWN-PATCH(P-042) begin
// own: claude gets an allow-list of the service's environment, never all of it. A Claude Code terminal hands its
// children its user e-mail, account ids and messaging socket (CLAUDE_CODE_*), Claude Code puts that e-mail in the
// prompt, and the service's CLAUDE_CONFIG_DIR belongs to another login. The account folder comes from the provider
// settings (P-045).
const ENV_ALLOW = new Set(
  [
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ].map((name) => name.toUpperCase()),
)

export function allowed(source: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const picked = Object.entries(source).filter(
    (entry) => entry[1] !== undefined && ENV_ALLOW.has(entry[0].toUpperCase()),
  )
  return {
    ...Object.fromEntries(picked),
    // Windows' process start (libuv, in Node and Bun alike) copies USERNAME, USERDOMAIN and LOGONSERVER from this
    // process into a child environment that lacks them; an empty value keeps them out.
    USERNAME: "",
    USERDOMAIN: "",
    LOGONSERVER: "",
    COMPUTERNAME: "",
    DISABLE_AUTOUPDATER: "1",
    ...QUIET,
  }
}

// Claude Code's telemetry, error reports, remote feature flags, feedback upload and surveys (decisions TLM). Not
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: in 2.1.3xx it also skips the subscription's model bootstrap, the quota
// probe and the update check the update card runs, which the route uses.
export const QUIET = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DO_NOT_TRACK: "1",
  DISABLE_GROWTHBOOK: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
} as const
// OWN-PATCH(P-042) end

// OWN-PATCH(P-052) begin
export const local: Interface = {
  // OWN-PATCH(P-052) end
  which: () => process.env.OPENCODE_CLAUDE_PATH || which("claude") || undefined,
  // OWN-PATCH(P-042) begin
  env: () => allowed(process.env),
  // OWN-PATCH(P-042) end
  // OWN-PATCH(P-045) begin
  // A folder reaches the SDK's session helpers through FolderStore (one transcript store for every account folder),
  // never through upstream's per-folder worker (claude-folder-worker.ts).
  requiresFolder: true,
  sessionExists: async (sessionID, folder) => {
    const { getSessionInfo } = await ClaudeSDK.load()
    return (await getSessionInfo(sessionID, FolderStore.options(folder))) !== undefined
  },
  fork: async (sessionID, messageID, folder) => ClaudeFork.create(sessionID, messageID, FolderStore.options(folder)),
  remove: async (sessionID, folder) => {
    const { deleteSession } = await ClaudeSDK.load()
    await deleteSession(sessionID, FolderStore.options(folder))
  },
  // OWN-PATCH(P-045) end
  // OWN-PATCH(P-043) begin
  transcripts: FolderStore.transcripts,
  // OWN-PATCH(P-043) end
  // OWN-PATCH(P-044) begin
  prewarm: async (options) => {
    const { prewarm } = await ClaudeSDK.load()
    return prewarm({ options })
  },
  // OWN-PATCH(P-044) end
  // OWN-PATCH(P-051) begin
  version: readVersion,
  // OWN-PATCH(P-051) end
}

// OWN-PATCH(P-052) begin
// The provider's IO: this machine's claude, or on an SSH host whose own-accounts named a relay (the observer channel's
// `relay`, 02 §8.10.13) the PC's. Read at every use, so a relay named after the provider started applies at once.
const relayed = new WeakMap<ClaudeRelay.Transport, Interface>()
const current = () => {
  const transport = ClaudeObserver.relay()
  if (!transport) return local
  const known = relayed.get(transport)
  if (known) return known
  const made = ClaudeRelay.io(transport)
  relayed.set(transport, made)
  return made
}

export const real: Interface = {
  which: () => current().which(),
  env: () => current().env(),
  get requiresFolder() {
    return current().requiresFolder
  },
  get spawn() {
    return current().spawn
  },
  get admit() {
    return current().admit
  },
  get note() {
    return current().note
  },
  sessionExists: (sessionID, folder) => current().sessionExists(sessionID, folder),
  fork: (sessionID, messageID, folder) => current().fork(sessionID, messageID, folder),
  remove: (sessionID, folder) => current().remove(sessionID, folder),
  transcripts: {
    chain: (sessionID, folder) => current().transcripts!.chain(sessionID, folder),
    write: (sessionID, folder, entries, replace) => current().transcripts!.write(sessionID, folder, entries, replace),
    list: (configDir) => current().transcripts!.list(configDir),
    discard: (configDir, projectKey, sessionID) => current().transcripts!.discard(configDir, projectKey, sessionID),
  },
  get prewarm() {
    return current().prewarm
  },
  get version() {
    return current().version
  },
}
// OWN-PATCH(P-052) end

// OWN-PATCH(P-051) begin
// One `--version` per binary file (path, size and time): an update replaces the file and is read again. A failed read
// is not kept, so the next start tries again.
const versions = new Map<string, Promise<string | undefined>>()

function readVersion(executable: string, env: Readonly<Record<string, string | undefined>>) {
  const stat = statSync(executable, { throwIfNoEntry: false })
  const key = JSON.stringify([executable, stat?.size, stat?.mtimeMs])
  const known = versions.get(key)
  if (known) return known
  const read = new Promise<string | undefined>((resolve) => {
    execFile(
      executable,
      ["--version"],
      {
        env: Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined)),
        timeout: 15_000,
        windowsHide: true,
      },
      // `2.1.282 (Claude Code)`
      (error, stdout) => resolve(error ? undefined : /\b(\d+\.\d+\.\d+[^\s()]*)/.exec(String(stdout))?.[1]),
    )
  })
  versions.set(key, read)
  void read.then((version) => {
    if (!version) versions.delete(key)
  })
  return read
}
// OWN-PATCH(P-051) end

// OWN-PATCH(P-045) begin
// The SDK's session helpers for upstream's per-folder worker (claude-folder-worker.ts, a CLI build entry). own's IO
// reaches a folder through FolderStore and never starts that worker.
export const helpers = {
  fork: (sessionID: string, messageID: string) => ClaudeFork.create(sessionID, messageID),
  remove: async (sessionID: string) => {
    const { deleteSession } = await ClaudeSDK.load()
    await deleteSession(sessionID)
  },
}
// OWN-PATCH(P-045) end
