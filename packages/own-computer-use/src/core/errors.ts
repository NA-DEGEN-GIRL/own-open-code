export * as Errors from "./errors.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"

/**
 * Model-facing failures. Every message starts with `[computer.<code>]` and says what to do next, like the browser
 * plugin's `[browser.*]` texts. The code survives core's re-wrapping of foreign errors by message
 * (`core/src/tool/runtime.ts`), so it is the stable part across the bundle boundary.
 */
export const Code = Schema.Literals([
  "not_enabled",
  "stopped",
  "busy",
  "app_not_allowed",
  "app_denied",
  "not_approved",
  "elevated_target",
  "password_field",
  "no_target",
  "target_changed",
  "no_stop_chord",
  "stale_screenshot",
  "no_screenshot",
  "out_of_bounds",
  "unknown_window",
  "desktop_unavailable",
  "driver_unavailable",
  "timeout",
  "action_failed",
  "blocked_key",
  "subagent",
  "subagent_model",
  "team_turn",
  "no_vision",
  "invalid_input",
  "image_too_large",
  "unsupported",
])
export type Code = typeof Code.Type

const GUIDANCE: Readonly<Record<Code, string>> = {
  not_enabled:
    "Computer use is not enabled for this session. Ask the user to turn on computer use for this session in the app; do not try to work around it.",
  stopped:
    "The user stopped computer use with the stop chord or the Stop button. Do not retry. Tell the user and wait until they reset it in Settings.",
  busy: "Another session is controlling this desktop. Wait and try again later, or ask the user which session should continue.",
  app_not_allowed:
    "This app is not on the allowed app list. Ask the user to add it in Settings or do the step themselves; do not try another way to reach it.",
  app_denied:
    "Controlling this app is never allowed (terminals, shells and IDEs with a terminal, the Run dialog and other shell dialogs, credential, UAC and security screens, password managers, system tools and this coding app itself, also in a browser). Use your other tools, such as the shell tool, or ask the user.",
  not_approved: "The user did not allow controlling this app. Do not retry; ask the user how to continue.",
  elevated_target:
    "This window runs as administrator, so input to it is blocked. Ask the user to do this step themselves.",
  password_field:
    "The focused field is a password field. Never type, paste or edit passwords or secrets; ask the user to enter it themselves.",
  no_target:
    "There is no foreground window or focused element to send input to right now (focus is changing, or the app does not report it). Take a screenshot, bring the window you need to the front (focus_window) and try again.",
  target_changed:
    "The window in front changed while the call ran, or a new window opened where your screenshot showed something else, so the rest of the input was not sent. Take a screenshot, bring the window you need to the front (focus_window) and send the remaining input in a new call.",
  no_stop_chord:
    "The stop chord Ctrl+Alt+Shift+Q could not be registered (another program, or a second running service, holds it), so input is refused: the user would have no physical way to stop you. Tell the user; it works again once that program releases the chord.",
  stale_screenshot:
    "The display layout changed after that screenshot. Call computer.screenshot again and use the coordinates of the new image.",
  no_screenshot:
    "There is no usable screenshot for these coordinates. Call computer.screenshot first; coordinates are pixels of your latest screenshot (or of the captureId you pass).",
  out_of_bounds:
    "The coordinates are outside the screenshot. Use pixel coordinates inside your latest screenshot image.",
  unknown_window: "That window no longer exists. Call computer.list_windows for current window ids.",
  desktop_unavailable:
    "The desktop takes no input: it is locked, a secure screen (UAC, lock screen, Ctrl+Alt+Del) is shown, or the remote-desktop window showing it is minimized. Ask the user to unlock it or restore that window, then take a new screenshot.",
  driver_unavailable:
    "The computer-use helper is not available. Tell the user; retrying will not help until it is restarted from Settings.",
  timeout:
    "The desktop did not respond in time. The action may have partly run: take a new screenshot to check the state before retrying.",
  action_failed: "The action failed. Take a new screenshot to check the current state before retrying.",
  blocked_key:
    "This key combination is never sent (the Run dialog and Win+X menu chords, Ctrl+Alt+Del and the stop chord are blocked). Reach the goal another way.",
  subagent: "Subagents cannot use computer tools. Return to the parent agent and let it act.",
  subagent_model:
    "A subagent may use computer tools only on the main conversation's model. Do not retry; return to the parent agent and let it act, or ask the user.",
  team_turn:
    "Computer tools are never used in a turn that a team request (own.team) started, nor by its subagents. Do not retry; tell the user that this step needs the desktop, so they can ask for it in a message of their own in that conversation.",
  no_vision:
    "This conversation's model cannot see images, so it cannot use the computer: it would act on screenshots it never sees. Do not retry. Tell the user that computer use needs a model that reads images, and that they can switch this conversation to one or turn computer use off.",
  invalid_input: "Fix the arguments and call the tool again.",
  image_too_large:
    'The screenshot could not be encoded under the size limit. Retry with quality "standard" or zoom into a smaller region.',
  unsupported: "Computer use is only available on Windows in the own-open-code desktop service.",
}

export class ComputerError extends Schema.TaggedError<ComputerError>()("ComputerError", {
  code: Code,
  detail: optional(Schema.String),
}) {
  constructor(code: Code, detail?: string) {
    super(detail === undefined ? { code } : { code, detail })
  }

  override get message() {
    return format(this.code, this.detail)
  }
}

/** `[computer.<code>] <detail>. <guidance>` */
export function format(code: Code, detail?: string) {
  const prefix = `[computer.${code}]`
  if (detail === undefined || detail === "") return `${prefix} ${GUIDANCE[code]}`
  return `${prefix} ${detail.endsWith(".") ? detail : `${detail}.`} ${GUIDANCE[code]}`
}

/** Driver-level failure (helper process, OS call). Mapped to a `ComputerError` before the model sees it. */
export class DriverError extends Schema.TaggedError<DriverError>()("DriverError", {
  reason: Schema.Literals(["unavailable", "timeout", "desktop_unavailable", "unknown_window", "protocol", "failed"]),
  detail: Schema.String,
}) {
  constructor(reason: DriverError["reason"], detail: string) {
    super({ reason, detail })
  }

  override get message() {
    return this.detail
  }
}

export function fromDriver(error: DriverError) {
  return new ComputerError(DRIVER_CODES[error.reason], error.detail)
}

const DRIVER_CODES: Readonly<Record<DriverError["reason"], Code>> = {
  unavailable: "driver_unavailable",
  timeout: "timeout",
  desktop_unavailable: "desktop_unavailable",
  unknown_window: "unknown_window",
  protocol: "driver_unavailable",
  failed: "action_failed",
}
