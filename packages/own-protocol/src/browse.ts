export * as OwnBrowse from "./browse.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/**
 * 내 브라우저 사용 (browse, decisions BRW): the user's real Chromium browser (their tabs, logins and extensions) as tools,
 * through OpenCode's Browse (`anomalyco/browse`, MIT): a native `browse` program the user installs, whose `browse mcp`
 * is a stdio MCP server, and a Chromium extension that pairs with it and runs its commands through `chrome.debugger`.
 * own never installs either: the user installs the extension from the Chrome Web Store and the program from
 * opencode.ai, then turns this on in 설정 > 내 브라우저 사용. Off by default.
 *
 * own-accounts adds the MCP server `browse` to this PC's Locations while it is on and the program is found, so core
 * names its tools `browse_<tool>` (`McpTool.name`), and gates them like computer use: every agent carries the agent-wide
 * {@link DENY}, so no conversation lists them until the user turns them on for that conversation
 * (`session.approval.set{browse}`, the session rule {@link ALLOW}). The approval mode then decides each call by its
 * {@link kind}: `전체 허용` runs every call, `묻기` asks before an action and runs reads, `읽기 전용` refuses actions.
 * Pure: own-web reads the tool kinds, links and texts from here.
 */

/** The MCP server's name in core's config; core's tool and permission names start with {@link PREFIX}. */
export const SERVER = "browse"
/** `McpTool.name("browse", tool)`: core's namespace `browse` and `_`. */
export const PREFIX = `${SERVER}_`
/** The permission action pattern of every browse tool. */
export const ACTIONS = `${PREFIX}*`

/** Agent-wide: keeps every browse tool out of the catalog until a conversation turns them on. */
export const DENY = { action: ACTIONS, resource: "*", effect: "deny" } as const
/** The session rule `on` writes (before the own bundle); only this exact rule as the last `browse_*` rule reads `on`. */
export const ALLOW = { action: ACTIONS, resource: "*", effect: "allow" } as const

/** The Chrome Web Store listing of the extension (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium). */
export const STORE_URL = "https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg"
/** The product page with the install commands. */
export const PRODUCT_URL = "https://opencode.ai/product/browse"
/** The source (MIT). */
export const SOURCE_URL = "https://github.com/anomalyco/browse"

/**
 * Tools that only look: the relay's state, the agent's own tabs' outline, screenshots, console and network capture,
 * waiting. Everything else acts in the browser (opens or closes tabs, navigates, clicks, types, runs page JavaScript,
 * records, changes settings, asks the user for a handoff) and is an action. A tool this list does not know is an
 * action (fail closed), so a new Browse tool asks until it is classified here.
 */
export const READS: ReadonlyArray<string> = [
  "status",
  "snapshot",
  "screenshot",
  "screenshot_diff",
  "console",
  "network",
  "wait_for",
]

export type Kind = "read" | "act"

/**
 * The kind of one call: `tool` without the prefix, `input` the call's arguments. `tabs` only lists with
 * `action: "list"` (or none, its default); its `new` and `close` act.
 */
export function kind(tool: string, input: unknown): Kind {
  if (READS.includes(tool)) return "read"
  if (tool !== "tabs") return "act"
  const action = typeof input === "object" && input !== null ? (input as { action?: unknown }).action : undefined
  return action === undefined || action === "list" ? "read" : "act"
}

/** The tool of a permission action (`browse_click` → `click`), or `undefined` when it is not a browse tool. */
export function toolOf(action: string) {
  return action.startsWith(PREFIX) && action.length > PREFIX.length ? action.slice(PREFIX.length) : undefined
}

/**
 * The setting (`OWN_HOME\browse.json`, written only by `browse.set`, a `local` method): `enabled` adds the server
 * (absent: off); `command` is the `browse` program to run, when it is not where the install script puts it
 * (`%USERPROFILE%\.local\bin\browse.exe`, `~/.local/bin/browse`) or on PATH. In `browse.set` the given fields replace
 * the stored ones, and an empty `command` forgets the stored path.
 */
export const Setting = Schema.Struct({
  enabled: optional(Schema.Boolean),
  command: optional(Schema.String),
}).annotate({ identifier: "Own.Browse.Setting" })
export type Setting = typeof Setting.Type

/** `OWN_HOMErowse.json`. */
export const File = Schema.Struct({ version: Schema.Literal(1), ...Setting.fields }).annotate({
  identifier: "Own.Browse.File",
})
export type File = typeof File.Type

/** The setting after a `browse.set`: the given fields replace the stored ones; an empty `command` forgets it. */
export function apply(current: Setting, patch: Setting): File {
  const enabled = patch.enabled ?? current.enabled
  const command = (patch.command ?? current.command)?.trim()
  return { version: 1, ...(enabled === undefined ? {} : { enabled }), ...(command ? { command } : {}) }
}

/** Whether the user turned browse on. */
export function enabled(setting: Setting | undefined) {
  return setting?.enabled === true
}

/**
 * Where the program was found: `setting` (the path the user gave), `install` (the install script's place), `path`
 * (on PATH), or `missing` (none of these; with a `command` the given path is not there).
 */
export const Source = Schema.Literals(["setting", "install", "path", "missing"]).annotate({
  identifier: "Own.Browse.Source",
})
export type Source = typeof Source.Type

/** `browse.status`: the setting and the program this PC's service would run (never runs it). */
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  source: Source,
  /** The program that runs, when found. */
  command: optional(Schema.String),
  /** The user gave a path (then only that path counts). */
  given: Schema.Boolean,
  /** Whether conversations of this service get the tools now: on, found, and not an SSH host's service. */
  active: Schema.Boolean,
}).annotate({ identifier: "Own.Browse.Status" })
export type Status = typeof Status.Type
