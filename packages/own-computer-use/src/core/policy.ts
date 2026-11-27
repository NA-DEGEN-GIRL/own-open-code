export * as Policy from "./policy.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import type { Code } from "./errors.js"
import { Keys } from "./keys.js"
import type { ToolSchema } from "./schema.js"

export const WindowInfo = Schema.Struct({
  /** HWND as reported by the helper (e.g. `0x1a2b`); the model's `windowId`. */
  id: Schema.String,
  pid: NonNegativeInt,
  /** Image file name, e.g. `notepad.exe`; empty when the process could not be queried (always denied). */
  exe: Schema.String,
  title: Schema.String,
  className: Schema.String,
  /** Physical pixels; minimized windows report Windows' parking position. */
  bounds: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int }),
  displayId: optional(NonNegativeInt),
  /** The process token is elevated; UIPI drops our input, so it is refused with an explicit error. */
  elevated: Schema.Boolean,
  minimized: Schema.Boolean,
  cloaked: Schema.Boolean,
})
export type WindowInfo = typeof WindowInfo.Type

export const FocusInfo = Schema.Struct({
  pid: NonNegativeInt,
  /** UI Automation `IsPassword` of the focused element. */
  isPassword: Schema.Boolean,
  controlType: optional(Schema.String),
})
export type FocusInfo = typeof FocusInfo.Type

/**
 * What an action does to its target:
 * - `observe`: screenshots, window list, cursor position, waiting — no target.
 * - `move`: moving the cursor only; hovering is harmless (the gate checks a move that drags a held button as `pointer`).
 * - `pointer`: clicks, drags, scrolls, button presses and focusing a window — checked against the window under the point.
 * - `keys`: keys that only move between or out of fields (`Keys.navigates`) — checked against the foreground window.
 * - `text`: every other key and typed text, since a shortcut can paste — also checked against the focused element,
 *   refused in a password field.
 */
export type Kind = "observe" | "move" | "pointer" | "keys" | "text"

export interface Config {
  /** Apps usable without asking. In `session` approval mode a non-empty list is exclusive. */
  readonly allowApps: ReadonlyArray<string>
  /** Extra denied apps; deny always wins over allow. */
  readonly denyApps: ReadonlyArray<string>
  /** Lifts only the terminal part of the built-in deny list. */
  readonly allowTerminals: boolean
  readonly allowSubagents: boolean
  /** `session`: enabling computer use for the session is the consent. `question`: ask once per app and session. */
  readonly approval: "session" | "question"
}

export interface Input {
  readonly kind: Kind
  /** The window that receives the action; `undefined` when the helper reports none (refused, see `evaluate`). */
  readonly target?: WindowInfo
  /** The focused element, for `text`; `undefined` when UI Automation reports none (refused for `text`). */
  readonly focus?: FocusInfo
  /** The calling session has a parent. */
  readonly subagent: boolean
  /** Apps the user approved for this session (normalized names). */
  readonly grants: ReadonlyArray<string>
  readonly config: Config
}

export type Decision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly code: Code; readonly app?: string }
  | { readonly _tag: "NeedsApproval"; readonly app: string }

/**
 * Terminals, and IDEs whose integrated terminal (or task runner) runs commands just the same. `allowTerminals` lifts
 * the whole list.
 */
export const TERMINALS: ReadonlyArray<string> = [
  "cmd",
  "powershell",
  "powershell_ise",
  "pwsh",
  "windowsterminal",
  "wt",
  "openconsole",
  "conhost",
  "wsl",
  "wslhost",
  "bash",
  "sh",
  "mintty",
  "git-bash",
  "alacritty",
  "wezterm-gui",
  "conemu",
  "conemu64",
  "tabby",
  "hyper",
  // IDEs with an integrated terminal
  "code",
  "code - insiders",
  "codium",
  "vscodium",
  "cursor",
  "windsurf",
  "devenv",
  "idea64",
  "pycharm64",
  "webstorm64",
  "rider64",
  "clion64",
  "goland64",
  "phpstorm64",
  "rubymine64",
  "rustrover64",
  "datagrip64",
  "fleet",
  "zed",
]

/**
 * Apps the agent may never drive: they would let it approve its own permissions (this app), run commands outside the
 * shell tool's rules (terminals), or touch credentials and security settings.
 */
export const BUILTIN_DENY: ReadonlyArray<string> = [
  // this app and its helpers
  "own-desktop",
  "opencode",
  "own-vault",
  "own-cu-helper",
  // Other agent apps: they run commands and show approval buttons for their own tools, so driving one would let the
  // agent approve itself (the rule lcu and the Codex app apply). Claude (the desktop app and Claude Code), the
  // ChatGPT app with Codex, Codex itself and the user's Codex manager.
  "claude",
  "chatgpt",
  "codex",
  "codex.controlcenter",
  // The UWP frame host. The helper reports the app a frame hosts instead (an empty exe when it cannot tell), so this
  // name never stands for every UWP app at once in an allow list or a session grant.
  "applicationframehost",
  // Start and its search box run any program or command typed into them (`cmd`, Return), like the Run dialog.
  // Windows 10 hosts the search box in SearchApp (earlier SearchUI).
  "startmenuexperiencehost",
  "searchhost",
  "searchapp",
  "searchui",
  // credential, UAC and security UI
  "consent",
  "credentialuibroker",
  "logonui",
  "lockapp",
  "sechealthui",
  "securityhealthtray",
  "useraccountcontrolsettings",
  // system administration
  "regedit",
  "regedt32",
  "mmc",
  "taskmgr",
  "msconfig",
  // password managers
  "1password",
  "bitwarden",
  "keepass",
  "keepassxc",
  "dashlane",
  "lastpass",
  "nordpass",
  "roboform",
  "enpass",
  "keeperpasswordmanager",
]

/**
 * own-web's document title (`packages/own-web/index.html`): a browser or app window showing it is this app, which can
 * approve its own permissions and turn computer use on, so it is denied like `own-desktop`.
 */
export const OWN_WEB_TITLE = "own-open-code"

export function evaluate(input: Input): Decision {
  if (input.subagent && !input.config.allowSubagents) return { _tag: "Deny", code: "subagent" }
  if (input.kind === "observe" || input.kind === "move") return { _tag: "Allow" }
  // No window under the point or in front (activation is changing): refuse rather than send input blindly.
  if (input.target === undefined) return { _tag: "Deny", code: "no_target" }
  const app = appName(input.target.exe)
  if (app === "") return { _tag: "Deny", code: "app_denied", app: "unknown app" }
  if (denied(app, input.config)) return { _tag: "Deny", code: "app_denied", app }
  // The Run dialog (and the shell's other dialogs) run commands outside the shell tool's rules.
  if (app === "explorer" && input.target.className === "#32770")
    return { _tag: "Deny", code: "app_denied", app: "explorer (shell dialog)" }
  if (ownWeb(input.target.title)) return { _tag: "Deny", code: "app_denied", app: `${app} (${OWN_WEB_TITLE})` }
  if (input.target.elevated) return { _tag: "Deny", code: "elevated_target", app }
  // An unknown focused element could be a password field.
  if (input.kind === "text" && input.focus === undefined) return { _tag: "Deny", code: "no_target", app }
  if (input.kind === "text" && input.focus?.isPassword) return { _tag: "Deny", code: "password_field", app }
  if (input.config.allowApps.some((item) => appName(item) === app) || input.grants.includes(app))
    return { _tag: "Allow" }
  if (input.config.approval === "question") return { _tag: "NeedsApproval", app }
  if (input.config.allowApps.length > 0) return { _tag: "Deny", code: "app_not_allowed", app }
  return { _tag: "Allow" }
}

/** `C:\Windows\System32\Notepad.EXE` → `notepad`. Configured names may omit `.exe`. */
export function appName(exe: string) {
  return (exe.split(/[\\/]/).pop() ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "")
}

/** The policy kind of a normalized action. */
export function kindOf(action: ToolSchema.Action): Kind {
  switch (action._tag) {
    case "screenshot":
    case "zoom":
    case "cursor_position":
    case "list_windows":
    case "wait":
      return "observe"
    case "move":
      return "move"
    case "click":
    case "drag":
    case "button":
    case "scroll":
    case "focus_window":
      return "pointer"
    case "type":
      return "text"
    case "key":
      return action.chords.every(Keys.navigates) ? "keys" : "text"
    case "hold_key":
      return Keys.navigates(action.chord) ? "keys" : "text"
  }
}

/**
 * A window title of own-web: exactly its title, or its title followed by a space and whatever the browser adds
 * (`own-open-code - Google Chrome`, `own-open-code — Mozilla Firefox`, Edge's `own-open-code and 2 more pages - …`).
 */
function ownWeb(title: string) {
  const trimmed = title.trim()
  return trimmed === OWN_WEB_TITLE || trimmed.startsWith(`${OWN_WEB_TITLE} `)
}

function denied(app: string, config: Config) {
  if (config.denyApps.some((item) => appName(item) === app)) return true
  if (TERMINALS.includes(app)) return !config.allowTerminals
  return BUILTIN_DENY.includes(app)
}

/** Whether a window is on screen: not minimized, not cloaked (other virtual desktop, suspended UWP) and not empty. */
export function visible(window: WindowInfo) {
  return !window.minimized && !window.cloaked && window.bounds.width > 0 && window.bounds.height > 0
}
