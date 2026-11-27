export * as ClaudeWire from "./claude-wire.js"

import { existsSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { Plugin } from "@own/protocol"

/**
 * The claude-auth exports the PC egress relay signs with (04 §8.11.5): the same plugin instance core loaded for this
 * Location, never a copy and never own code that re-implements it. The relay resolves the package from the active
 * claude-auth entry's folder (`Bun.resolveSync`), which yields the very `node_modules` file core imported through
 * `server.js`; Bun keeps one module per file, so the instance setup filled with accounts is the one returned.
 *
 * Nothing here calls the plugin's setup, refresh or authorize, or `connection.resolve`, and nothing reads a token: the
 * only look at the plugin's state is `getActiveAccount() !== null`, whose value is neither kept nor inspected. A
 * second, empty instance (another path spelling) or a missing credentials file answers `null`, and the relay then
 * refuses (`not_ready`, detail `wire`) instead of running on an empty instance.
 *
 * The patched plugin the app ships (02 §8.2, `ClaudeBundle`) adds {@link Multi}: own binds each conversation to an
 * account key before the plugin's own `http.request` hook signs, reads which account signed a request, and lists the
 * loaded accounts (key and label, never a token). The relay passes the account key as `source`, so a relayed request is
 * signed with that account only (04 §8.11.5, egress proof v2). Every import here names the stable state folder to the
 * module (`ownUseStateDir`): the bundle lives in a versioned app folder, its account list outside it, and until a
 * folder is named the plugin holds no account at all.
 */

/** One `system` block as core lowers a system part (`{type, text, cache_control?}`). */
export interface SystemBlock {
  readonly type: string
  readonly text: string
  readonly cache_control?: unknown
}

/** The three exports the relay calls; nothing else of the module is reachable through this object. */
export interface Wire {
  /** The plugin's session hook body: prepends the Claude Code identity to `system`, once. */
  readonly injectClaudeIdentity: (event: {
    readonly model: { readonly providerID: string }
    readonly system: Array<SystemBlock>
  }) => void
  /**
   * `accessToken` is `undefined`: the plugin picks the token from its own account cache. `source` is the account key
   * (patched plugin; `undefined` = the single account of an unpatched one), `options.conversationID` the conversation
   * Claude Code's session id is derived from (G7).
   */
  readonly prepareClaudeRequest: (
    request: Request,
    accessToken: undefined,
    source: string | undefined,
    options?: { readonly conversationID?: string },
  ) => Promise<Request>
  /** `send` is the plugin's transport for its own re-sends (`fetchWithRetry`), the relay's plain `fetch`. */
  readonly finishClaudeResponse: (
    request: Request,
    initial: Response,
    source: string | undefined,
    send: typeof fetch,
  ) => Promise<Response>
}

/** The patched plugin's multi-account exports (02 §8.2 step 2a). */
export interface Multi {
  readonly bindSession: (sessionID: string, accountKey: string) => void
  readonly unbindSession: (sessionID: string) => void
  /** The account key a request this plugin prepared was signed with (G4). */
  readonly accountOf: (request: Request) => string | undefined
  /**
   * Loaded accounts: key, label (Claude Code's plan and e-mail), the login's expiry (epoch ms; absent from a module
   * that does not say) and its last failed refresh (CR; absent: none, or a module that does not say); never a token.
   */
  readonly accounts: () => ReadonlyArray<{
    readonly key: string
    readonly label: string
    readonly expiresAt?: number
    readonly refresh?: RefreshFailure
  }>
  /**
   * CR (2026-10-26): `listener` hears every refresh of the module's accounts (one listener per module: the last one
   * set). A module without the export does nothing.
   */
  readonly onRefresh: (listener: (event: RefreshEvent) => void) => void
}

/**
 * An account's last failed refresh as the patched plugin keeps it (CR): `terminal` (the token endpoint's 400, 401 or
 * 403, or a dead-token code: only `다시 로그인` helps) or `transient` (429, 5xx, no answer: the next request after
 * `retryAt` tries again). `status` 0 = no answer, then `reason` says why (`network`, `timeout`, `unparsable`,
 * `no_refresh_token`); `error` = the OAuth error code.
 */
export interface RefreshFailure extends Schema.Schema.Type<typeof RefreshFailure> {}
export const RefreshFailure = Schema.Struct({
  kind: Schema.Literals(["terminal", "transient"]),
  at: Schema.Finite,
  status: Schema.Finite,
  error: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  retryAt: Schema.optionalKey(Schema.Finite),
})

/**
 * One refresh as the patched plugin tells it (CR): `started`, `ok` or `failed`, with the account key and label, what
 * started it (`expiry` or `401`) and, on a failure, what the token endpoint answered (`description` cut short, the
 * tokens it may echo replaced). Never a token.
 */
export type RefreshEvent = Schema.Schema.Type<typeof RefreshEvent>
const fields = { key: Schema.String, label: Schema.String, trigger: Schema.String }
export const RefreshEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), ...fields, expiresAt: Schema.optionalKey(Schema.Finite) }),
  Schema.Struct({
    type: Schema.Literal("ok"),
    ...fields,
    ms: Schema.Finite,
    expiresAt: Schema.Finite,
    rotated: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    ...fields,
    kind: Schema.Literals(["terminal", "transient"]),
    status: Schema.Finite,
    ms: Schema.Finite,
    error: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    retryAfterMs: Schema.optionalKey(Schema.Finite),
    retryAt: Schema.optionalKey(Schema.Finite),
  }),
])
const decodeFailure = Schema.decodeUnknownOption(RefreshFailure)
const decodeEvent = Schema.decodeUnknownOption(RefreshEvent)

export type Loaded =
  | { readonly ok: true; readonly wire: Wire; readonly multi: Multi | undefined }
  | { readonly ok: false; readonly detail: "wire" | "incompatible" }

const EXPORTS = ["injectClaudeIdentity", "prepareClaudeRequest", "finishClaudeResponse", "getActiveAccount"] as const
const MULTI_EXPORTS = ["bindSession", "unbindSession", "accountOf", "ownAccounts", "ownUseStateDir"] as const
/** The patch's capability marker (`ClaudeBundle.MARKER`). */
const MARKER = "OWN_MULTI_ACCOUNT"

/** Imports by resolved file, so every call for one install shares the module core already holds. */
const modules = new Map<string, Promise<unknown>>()

/**
 * The wire of the claude-auth plugin whose entry file (or folder) is `entry`, the local path of this Location's active
 * claude-auth plugin entry; `stateDir` is the folder of own's account list (`ClaudeBundle.stateDir`). `wire`: no entry,
 * the package does not resolve or import there, or the instance has no active account; `incompatible`: an export is
 * missing or not a function.
 */
export async function load(entry: string | undefined, stateDir: string): Promise<Loaded> {
  const module = await imported(entry, stateDir)
  if (module === undefined) return { ok: false, detail: "wire" }
  if (!compatible(module)) return { ok: false, detail: "incompatible" }
  if (module.getActiveAccount() === null) return { ok: false, detail: "wire" }
  return {
    ok: true,
    wire: {
      injectClaudeIdentity: (event) => module.injectClaudeIdentity(event),
      prepareClaudeRequest: (request, accessToken, source, options) =>
        module.prepareClaudeRequest(request, accessToken, source, options),
      finishClaudeResponse: (request, initial, source, send) =>
        module.finishClaudeResponse(request, initial, source, send),
    },
    multi: multiOf(module),
  }
}

/**
 * The patched plugin's multi-account exports on core's instance, or `undefined` when the module does not carry the
 * marker and every multi-account export (not the app's patched plugin).
 */
export async function multi(entry: string | undefined, stateDir: string): Promise<Multi | undefined> {
  const module = await imported(entry, stateDir)
  return module === undefined ? undefined : multiOf(module)
}

/**
 * The module of `entry`, told where own's account list is: `ownUseStateDir` (a no-op when it already knows), then one
 * `ownAccounts()` so the plugin reads the list now (its setup may have run before any folder was named).
 */
async function imported(entry: string | undefined, stateDir: string) {
  const file = entry === undefined ? undefined : resolve(path.extname(entry) ? path.dirname(entry) : entry)
  if (file === undefined) return undefined
  const loading = modules.get(file) ?? import(file)
  modules.set(file, loading)
  const module: unknown = await loading.catch(() => undefined)
  if (module === undefined) {
    modules.delete(file)
    return undefined
  }
  const multi = multiModule(module)
  if (multi) {
    multi.ownUseStateDir(stateDir)
    multi.ownAccounts()
  }
  return module
}

type Module = Wire & { readonly getActiveAccount: () => unknown }
interface MultiModule {
  readonly bindSession: Multi["bindSession"]
  readonly unbindSession: Multi["unbindSession"]
  readonly accountOf: (request: Request) => unknown
  readonly ownAccounts: () => ReadonlyArray<{
    readonly key: string
    readonly label: string
    readonly expiresAt?: unknown
    readonly refresh?: unknown
  }>
  readonly ownUseStateDir: (dir: string) => void
  /** CR: absent from a module before it (and from the tests' fake unless it says). */
  readonly ownOnRefresh?: unknown
}

function compatible(value: unknown): value is Module {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return EXPORTS.every((name) => typeof record[name] === "function")
}

function multiModule(value: unknown): MultiModule | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record[MARKER] !== 1 || !MULTI_EXPORTS.every((name) => typeof record[name] === "function")) return undefined
  // SAFETY: the marker and every multi-account export were checked above.
  return record as unknown as MultiModule
}

function multiOf(value: unknown): Multi | undefined {
  const module = multiModule(value)
  if (!module) return undefined
  return {
    bindSession: (sessionID, accountKey) => module.bindSession(sessionID, accountKey),
    unbindSession: (sessionID) => module.unbindSession(sessionID),
    accountOf: (request) => {
      const key = module.accountOf(request)
      return typeof key === "string" ? key : undefined
    },
    accounts: () =>
      module.ownAccounts().map((account) => {
        const refresh = Option.getOrUndefined(decodeFailure(account.refresh))
        return {
          key: account.key,
          label: account.label,
          ...(typeof account.expiresAt === "number" ? { expiresAt: account.expiresAt } : {}),
          ...(refresh === undefined ? {} : { refresh }),
        }
      }),
    onRefresh: (listener) => {
      const set = module.ownOnRefresh
      if (typeof set !== "function") return
      set((value: unknown) => {
        const event = Option.getOrUndefined(decodeEvent(value))
        if (event === undefined) return
        listener(
          event.type === "failed" && event.description !== undefined
            ? { ...event, description: event.description.slice(0, 160) }
            : event,
        )
      })
    },
  }
}

/**
 * `opencode-claude-auth-v2` resolved from the plugin folder, as core's import from `server.js` resolved it. Only a
 * present package is resolved: Bun's resolver may try to auto-install a package it cannot find, and nothing here may
 * ever download.
 */
function resolve(dir: string) {
  if (!existsSync(path.join(dir, "node_modules", Plugin.CLAUDE_AUTH_PACKAGE, "package.json"))) return undefined
  try {
    return Bun.resolveSync(Plugin.CLAUDE_AUTH_PACKAGE, dir)
  } catch {
    return undefined
  }
}
