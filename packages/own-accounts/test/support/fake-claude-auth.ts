// A fake of the bundled claude-auth (02 §8.2, T3 fixture `fake-claude-auth`): the folder layout the app ships
// (`server.js`, `package.json`, `own-bundle.json`, `node_modules/opencode-claude-auth-v2`) with the plugin id and the
// exports the egress relay and own's account binding call. It is written into a temp directory at test time. Its
// accounts, tokens and refreshes are a test-controlled in-memory record (`fake`): no file, keychain or network is read,
// and every token is fake.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@own/protocol"

export interface FakeClaudeAuthOptions {
  /** Exports to leave out (to test an incompatible module). */
  readonly omit?: ReadonlyArray<string>
  readonly version?: string
  readonly integrity?: string
  /**
   * The account the instance starts with, as the plugin's setup would read it (for a fake loaded by another process,
   * e.g. a test server); default none.
   */
  readonly account?: { readonly source: string; readonly token: string }
  /**
   * The patched plugin's multi-account exports (02 §8.2): the marker, `bindSession`, `accountOf`, `ownAccounts`,
   * `ownUseStateDir`; a `source` then signs with `fake.accounts[source]` only (unknown: it throws).
   */
  readonly multi?: boolean
  /** The multi-account fake's accounts at load (account key → token), for a fake loaded by another process. */
  readonly accounts?: Readonly<Record<string, string>>
  /**
   * The multi-account fake also holds every account own lists (`claude-accounts.json` in the state folder own named),
   * as if each folder had a login: for e2e and demo backends whose Claude turns use the provider's fake key, so no
   * account shows `다시 로그인`. Nothing is signed with them.
   */
  readonly holdListed?: boolean
  /**
   * The fake "credentials file" a reload adopts (`fake.stored`) is read from this Claude Code `.credentials.json` on
   * every access (`claudeAiOauth.accessToken`), for a fake loaded by a release service (real-host D8).
   */
  readonly credentialsFile?: string
  /**
   * Writes `own-bundle.json` with every file's sha256 (default), so own verifies the fake as the app's bundle
   * (`ClaudeBundle.read`, state `patched`); `false` leaves a folder that is no bundle (state `modified`).
   */
  readonly record?: boolean
  /** The record's build id (`null`: a source run's bundle). */
  readonly buildId?: string | null
}

/** The fake's pin unless a test names another (`own-bundle.json`). */
export const FAKE_BUNDLE_PIN = { version: "0.4.0-fake", integrity: "sha512-ZmFrZS1jbGF1ZGUtYXV0aA==" } as const
export const FAKE_PATCH_SHA256 = "f".repeat(64)

/** Writes the folder into `dir`; answers its entry file (`server.js`) and the package's module file. */
export function writeFakeClaudeAuth(dir: string, options: FakeClaudeAuthOptions = {}) {
  const pkg = path.join(dir, "node_modules", Plugin.CLAUDE_AUTH_PACKAGE)
  const version = options.version ?? FAKE_BUNDLE_PIN.version
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`)
  fs.writeFileSync(path.join(dir, "server.js"), `export { default } from "${Plugin.CLAUDE_AUTH_PACKAGE}"\n`)
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    `${JSON.stringify({
      name: Plugin.CLAUDE_AUTH_PACKAGE,
      version,
      type: "module",
      main: "dist/index.js",
      exports: { ".": "./dist/index.js" },
    })}\n`,
  )
  const omit = new Set(options.omit ?? [])
  const source = MODULE.split("\n// @export ")
    .map((part, index) => (index === 0 || !omit.has(part.slice(0, part.indexOf("\n"))) ? part : ""))
    .join("\n// @export ")
  const account = options.account === undefined ? "null" : JSON.stringify(options.account)
  const stored = options.account === undefined ? "null" : JSON.stringify(options.account.token)
  const storedField =
    options.credentialsFile === undefined
      ? `stored: ${stored},`
      : `get stored() { try { return JSON.parse(readFileSync(${JSON.stringify(options.credentialsFile)}, "utf8")).claudeAiOauth.accessToken } catch { return null } },\n  set stored(value) {},`
  const pristine = source
    .replace("account: null,", `account: ${account},`)
    .replace("stored: null,", storedField)
    .replace("  accounts: {},", `  accounts: ${JSON.stringify(options.accounts ?? {})},`)
    .replace("  holdListed: false,", `  holdListed: ${options.holdListed === true},`)
  // The multi-account exports go in as one text edit, as the real patch's do.
  // `omit` reaches the state-folder export too (a patched module from before the bundle).
  const multi = omit.has("ownUseStateDir") ? MULTI.slice(0, MULTI.indexOf("export function ownUseStateDir")) : MULTI
  const text = options.multi ? pristine.replace("export default {", `${multi}\nexport default {`) : pristine
  fs.writeFileSync(path.join(pkg, "dist", "index.js"), text)
  const files = [
    "server.js",
    "package.json",
    `node_modules/${Plugin.CLAUDE_AUTH_PACKAGE}/package.json`,
    `node_modules/${Plugin.CLAUDE_AUTH_PACKAGE}/dist/index.js`,
  ]
  if (options.record ?? true)
    fs.writeFileSync(
      path.join(dir, "own-bundle.json"),
      `${JSON.stringify({
        schema: 1,
        package: Plugin.CLAUDE_AUTH_PACKAGE,
        version,
        integrity: options.integrity ?? FAKE_BUNDLE_PIN.integrity,
        patchSha256: FAKE_PATCH_SHA256,
        buildId: options.buildId === undefined ? null : options.buildId,
        files: Object.fromEntries(
          files.map((file) => [file, sha256(fs.readFileSync(path.join(dir, ...file.split("/"))))]),
        ),
      })}\n`,
    )
  return { entry: path.join(dir, "server.js"), module: path.join(pkg, "dist", "index.js") }
}

function sha256(data: string | Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

/** The state record of a loaded fake (`import(module).fake`). */
export interface FakeState {
  account: { source: string; token: string } | null
  /** The token in the fake "credentials file" a reload adopts. */
  stored: string | null
  /** The fake network refresh; `null` = the refresh fails. */
  refresh: () => Promise<string | null>
  /** How often each export ran; `accounts`: the multi-account fake's `ownAccounts()` (a look of own's watch reads it). */
  readonly calls: {
    prepare: number
    finish: number
    reload: number
    forceRefresh: number
    inject: number
    accounts: number
  }
  /** Multi-account fake: account key → token, the sessions own bound, and what each prepared request was signed for. */
  accounts: Record<string, string>
  readonly bound: Record<string, string>
  readonly signed: WeakMap<Request, string>
  /** `source` and conversation of every prepare, in order. */
  readonly prepared: Array<{ readonly source: string | undefined; readonly conversationID: string | undefined }>
  /** The state folder own named (`ownUseStateDir`), or `null`. */
  stateDir: string | null
  /** {@link FakeClaudeAuthOptions.holdListed}. */
  holdListed: boolean
  /** Multi-account fake: account key → its login's expiry (epoch ms) as `ownAccounts()` reports it; default a day ahead. */
  readonly expires: Record<string, number>
  /** Multi-account fake: account key → its last failed refresh as `ownAccounts()` reports it (CR); default none. */
  readonly refreshes: Record<string, unknown>
  /** The refresh listener own set (`ownOnRefresh`, CR), or `null`: a test calls it as the plugin would. */
  listener: ((event: unknown) => void) | null
}
const MODULE = `// Fake opencode-claude-auth-v2 (own-accounts tests). Not the third-party plugin: same id and exports only.
import { readFileSync } from "node:fs"
import { join } from "node:path"
const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const BETAS = ["claude-code-20250219", "oauth-2025-04-20"]

export const fake = {
  account: null,
  stored: null,
  refresh: async () => null,
  calls: { prepare: 0, finish: 0, reload: 0, forceRefresh: 0, inject: 0, accounts: 0 },
  accounts: {},
  bound: {},
  signed: new WeakMap(),
  prepared: [],
  stateDir: null,
  holdListed: false,
  expires: {},
  refreshes: {},
  listener: null,
}

export default {
  id: "heymaaz.claude-auth-v2",
  setup: async () => {},
}

// @export getActiveAccount
export function getActiveAccount() {
  return fake.account
}

// @export injectClaudeIdentity
export function injectClaudeIdentity(event) {
  if (event.model.providerID !== "anthropic") return
  fake.calls.inject++
  if (event.system.some((part) => part.text.includes(SYSTEM_IDENTITY))) return
  event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
}

// @export prepareClaudeRequest
export async function prepareClaudeRequest(request, accessToken, source, options) {
  fake.calls.prepare++
  fake.prepared.push({ source, conversationID: options?.conversationID })
  const named = source === undefined ? undefined : fake.accounts[source]
  if (source !== undefined && Object.keys(fake.accounts).length > 0 && !named) throw new Error("unknown account")
  const token = named ?? fake.account?.token ?? accessToken
  if (!token) throw new Error("Claude subscription credentials are unavailable. Run /connect in OpenCode 2.")
  const url = new URL(request.url)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) url.searchParams.set("beta", "true")
  const headers = new Headers(request.headers)
  const incoming = (headers.get("anthropic-beta") ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  headers.set("authorization", "Bearer " + token)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", [...new Set([...BETAS, ...incoming])].join(","))
  headers.set("user-agent", "claude-cli/0.0.0-fake (external, sdk-cli)")
  headers.set("x-claude-code-session-id", "fake-session")
  if (!headers.has("x-stainless-os")) headers.set("x-stainless-os", process.platform)
  headers.delete("x-api-key")
  const body = JSON.parse(await request.clone().text())
  if (Array.isArray(body.tools)) body.tools = body.tools.map((tool) => ({ ...tool, name: "mcp_" + tool.name }))
  const prepared = new Request(url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal })
  if (source !== undefined) fake.signed.set(prepared, source)
  return prepared
}

// @export finishClaudeResponse
export async function finishClaudeResponse(request, initial, source, send = fetch) {
  fake.calls.finish++
  // Like the plugin: the prepared request's body is read again here (the first send must have used a copy).
  await request.clone().text()
  let token = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? ""
  let response = initial
  for (let attempt = 0; response.status === 401 && attempt < 2; attempt++) {
    fake.calls.reload++
    let candidate = fake.stored
    if (!candidate || candidate === token) {
      fake.calls.forceRefresh++
      candidate = await fake.refresh()
      if (candidate) fake.stored = candidate
    }
    if (!candidate || candidate === token) break
    token = candidate
    if (fake.account) fake.account.token = candidate
    const headers = new Headers(request.headers)
    headers.set("authorization", "Bearer " + token)
    response = await send(request.url, {
      method: request.method,
      headers,
      body: await request.clone().text(),
      signal: request.signal,
    })
  }
  if (response.status === 401 || !response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const reader = response.body.getReader()
  // Like the plugin's transformResponseStream: tool names lose the prefix, and the stream has no cancel.
  const body = new ReadableStream({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) return controller.close()
      controller.enqueue(encoder.encode(decoder.decode(next.value, { stream: true }).replaceAll('"name":"mcp_', '"name":"')))
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
`

const MULTI = `
export const OWN_MULTI_ACCOUNT = 1
export function bindSession(sessionID, accountKey) {
  fake.bound[sessionID] = accountKey
}
export function unbindSession(sessionID) {
  delete fake.bound[sessionID]
}
export function accountOf(request) {
  return fake.signed.get(request)
}
export function ownAccounts() {
  fake.calls.accounts++
  const keys = new Set([...Object.keys(fake.accounts), ...(fake.holdListed ? ownListed() : [])])
  return [...keys].map((key) => ({
    key,
    label: "Claude Max: " + key,
    expiresAt: fake.expires[key] ?? Date.now() + 86_400_000,
    ...(fake.refreshes[key] === undefined ? {} : { refresh: fake.refreshes[key] }),
  }))
}
export function ownOnRefresh(listener) {
  fake.listener = listener
}
function ownListed() {
  if (!fake.stateDir) return []
  try {
    return JSON.parse(readFileSync(join(fake.stateDir, "claude-accounts.json"), "utf8")).accounts.map((item) => item.key)
  } catch {
    return []
  }
}
export function ownUseStateDir(dir) {
  fake.stateDir = dir
}
`
