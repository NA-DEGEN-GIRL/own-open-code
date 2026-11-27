// The real bundled claude-auth (02 §8.2: the pinned plugin, patched and bundled by own/scripts/claude-auth-bundle.ts)
// copied into temp folders, for the tests that run the plugin's own code. The source is `OWN_CLAUDE_AUTH_BUNDLE_DIR`,
// else the bundle script's default output `own/.out/claude-auth` (`bun own/scripts/claude-auth-bundle.ts --out
// own/.out/claude-auth`); a missing or unverified bundle skips the tests. A copy gets a stub `@opencode/plugin` (only
// the constructors the plugin calls) where the host would provide its own. Every account, token and login folder the
// tests use is fake and lives in a temp directory.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@own/protocol"
import { ClaudeBundle } from "../../src/plugins/bundle.js"

export const VERSION = "0.4.0-beta.5"
export const INTEGRITY =
  "sha512-dVA2AY58JxrZP3QqetevB3yebwQLVoMGyBFrPbJPDdCgJ94UEzQpK9/5Jk0Ibeyeom5mWD/HInaJgfX9O5MljA=="
export const DEFAULT_DIR = path.resolve(import.meta.dir, "..", "..", "..", "..", "own", ".out", ClaudeBundle.DIR_NAME)

/** The bundle folder when it holds this pin's bundle with every file as its record says, else `undefined`. */
export function source(): string | undefined {
  const dir = process.env.OWN_CLAUDE_AUTH_BUNDLE_DIR || DEFAULT_DIR
  const record = readJson(path.join(dir, ClaudeBundle.RECORD_FILE)) as
    | { readonly version?: string; readonly files?: Readonly<Record<string, string>> }
    | undefined
  if (record?.version !== VERSION || record.files === undefined) return undefined
  const intact = Object.entries(record.files).every(([file, hash]) => {
    const bytes = readBytes(path.join(dir, ...file.split("/")))
    return bytes !== undefined && sha256(bytes) === hash
  })
  return intact ? dir : undefined
}

/** A copy of the bundle in a new folder under `root`, with the `@opencode/plugin` stub beside it. */
export function copy(root: string, from: string) {
  const dir = fs.mkdtempSync(path.join(root, "bundle-"))
  fs.cpSync(from, dir, { recursive: true })
  const stub = path.join(dir, "node_modules", "@opencode", "plugin")
  fs.mkdirSync(stub, { recursive: true })
  fs.writeFileSync(
    path.join(stub, "package.json"),
    `${JSON.stringify({ name: "@opencode/plugin", type: "module", exports: { ".": "./index.js" } })}\n`,
  )
  fs.writeFileSync(path.join(stub, "index.js"), STUB)
  return {
    dir,
    entry: path.join(dir, "server.js"),
    module: path.join(dir, "node_modules", Plugin.CLAUDE_AUTH_PACKAGE, "dist", "index.js"),
  }
}

/** A fake Claude Code login folder: a fake credentials file and `.claude.json` with an e-mail and an account uuid. */
export function login(
  dir: string,
  input: {
    readonly token: string
    readonly refresh?: string
    readonly expiresAt?: number
    readonly email?: string
    readonly uuid?: string
    /** The login's granted scopes as Claude Code stores them (absent: none stored). */
    readonly scopes?: ReadonlyArray<string>
  },
) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: input.token,
        refreshToken: input.refresh ?? `${input.token}-refresh`,
        expiresAt: input.expiresAt ?? Date.now() + 3_600_000 * 24,
        subscriptionType: "max",
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
      },
    }),
  )
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: input.email ?? "someone@example.test", accountUuid: input.uuid ?? input.token },
    }),
  )
  return dir
}

/**
 * The account list own writes for the patched plugin, in `stateDir`; answers the account keys. `readOnly`: the folders
 * own marks as Claude Code's own login (CS). `version`: an older own's list (1, which may lack `readOnly`), else this
 * version's.
 */
export function accounts(
  stateDir: string,
  folders: ReadonlyArray<string>,
  options: {
    readonly fallback?: string | null
    readonly labels?: ReadonlyArray<string>
    readonly readOnly?: ReadonlyArray<string>
    readonly version?: number
  } = {},
) {
  const key = (folder: string) =>
    process.platform === "win32" ? path.resolve(folder).toLowerCase() : path.resolve(folder)
  const fallback = options.fallback === undefined ? (folders[0] ?? null) : options.fallback
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    path.join(stateDir, ClaudeBundle.ACCOUNTS_FILE),
    `${JSON.stringify({
      version: options.version ?? ClaudeBundle.LIST_VERSION,
      default: fallback === null ? null : key(fallback),
      accounts: folders.map((folder, index) => ({
        key: key(folder),
        configDir: folder,
        ...(options.labels?.[index] === undefined ? {} : { label: options.labels[index] }),
        ...(options.readOnly?.includes(folder) ? { readOnly: true } : {}),
      })),
    })}\n`,
  )
  return folders.map(key)
}

export function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

function readBytes(file: string) {
  try {
    return fs.readFileSync(file)
  } catch {
    return undefined
  }
}

function readJson(file: string): unknown {
  const bytes = readBytes(file)
  if (bytes === undefined) return undefined
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    return undefined
  }
}

const STUB = `// Test stub of @opencode/plugin: only what claude-auth calls at load and setup.
export const Plugin = { define: (definition) => definition }
export const Provider = { ID: { make: (value) => value } }
export const Integration = { ID: { make: (value) => value }, MethodID: { make: (value) => value } }
export const Credential = { OAuth: { make: (value) => value } }
`
