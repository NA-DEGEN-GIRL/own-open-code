// Shell mode module entry (03 §4.6, §10, §19.9, gap 25 part): `!` in an empty box (or Ctrl+Shift+X) switches the
// composer to shell mode; a send runs the command with `session.shell`, which records it and its output in the session
// without waking the agent; Esc/Backspace on an empty box (or Ctrl+Shift+E) leaves.
//
// Wiring (integrator, composer):
//   const shell = createShellMode({ element, draftKey: key, composing: input.composing,
//     disabled: () => child() || !shellAllowed(runtime()), changed: (text) => { drafts.set(key(), text); resize(el) } })
//   replaces `local.shellMode`: `data-shell={shell.visual()}`, placeholder `own.sendKey.placeholderShell` with the
//     send key (`own.composer.placeholderShell` on touch screens) while `shell.visual()`,
//     `planSend({ shellMode: shell.active(), … })`, the suggest `disabled` uses `shell.active()`.
//   textarea: `onInput` → after the composer's handlers `shell.input(event)`; `onKeyDown` → after `input.keydown`
//     returned false, `shell.keydown(event)` (replaces the inline Esc check); after a programmatic text change
//     (draft load, history, restore) `shell.sync()`.
//   shortcuts: `composer.shellMode` → `shell.enter()`, `composer.shellExit` → `shell.exit()`.
//   send: `runShell` uses `shellRuns(runtime).run(sessionID, command)` (a `{ok:false}` result restores the text with
//     `!`, re-enters shell mode and shows `own.shellmode.failed`), then `shell.sent()`; record the command in the
//     `shell` history list.
//   view: `<ShellRunChip runtime sessionID />` above the chips, `<ShellModeHint shell />` under the box.
export { createShellMode, type ShellMode, type ShellModeOptions } from "./controller"
export { entersShell, leavesShell, shellAllowed, shellCommand } from "./model"
export { createShellRuns, shellRuns, type ShellRun, type ShellRunResult, type ShellRuns } from "./run"
export { shellModeEn, shellModeKo, shellModeText, useShellModeText } from "./strings"
export { ShellModeHint, ShellRunChip } from "./view"
