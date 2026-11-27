// `!` shell mode decisions (03 §4.6, §10, §19.9), pure so they are unit-tested as tables. Behavior follows upstream
// `composer/suggestions/machine.ts`: a `!` typed into an empty box switches the box to shell mode and is consumed
// (the placeholder then says what happens); Esc or Backspace on an empty box leaves; after a send the box is back in
// prompt mode. A text that still starts with `!` (pasted, or `!!`) is a shell command too (composer/send.ts `planSend`).
import type { ServerRuntime } from "@/data"

/** The input that turns shell mode on: exactly `!` in a box that was empty. */
export function entersShell(value: string, active: boolean) {
  return !active && value === "!"
}

/** Esc or Backspace on an empty box leave shell mode (03 §10 "나가기 Esc(빈 입력일 때)"). */
export function leavesShell(code: string, value: string, active: boolean) {
  return active && value === "" && (code === "Escape" || code === "Backspace")
}

/** The command a send runs, or `undefined` when the text is a prompt (or an empty command). */
export function shellCommand(text: string, active: boolean) {
  const body = active ? text : text.startsWith("!") ? text.slice(1) : undefined
  const command = body?.trim()
  return command ? command : undefined
}

/**
 * Whether this connection may run shell commands. 05 §13.5 puts `session.shell` under the device scope `terminal`,
 * which `HostConnection.scopes` cannot carry yet (they are `own.accounts` scopes), so a gateway device never gets
 * shell mode; PC windows (injected or cookie auth) and SSH servers opened from this PC do, with the `prompt` scope.
 */
export function shellAllowed(runtime: Pick<ServerRuntime, "rpc" | "entry"> | undefined) {
  if (!runtime) return false
  return runtime.rpc.can("prompt") && runtime.entry()?.auth !== "device"
}
