// Ports the model-facing shell tools: packages/shell/tool-pwsh/src/{index,render}.ts (Windows) and
// packages/shell/tool-bash/src/{index,render}.ts (elsewhere), as dsh registers them without a job registry and without
// a confining executor (`pwshTool(undefined)`, no escalation fields): `description` before `command`, an optional
// `timeoutMs` the executor clamps (default 120 s, cap 600 s, the command is killed on expiry) and `workdir` resolved
// against the session's directory. The result is stdout, a marked `[stderr]` section, truncation notices with the
// spill path, then the timeout and exit markers (`[exit code: N]`, packages/shell/shell/src/render.ts); a failing
// command is a normal result the model reads, only argument and spawn failures are errors.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshShellTool from "./shell-tool.js"

import type { DshArgs } from "./args.js"
import type { DshOutput } from "./output.js"
import type { DshShell } from "./shell.js"

/** dsh's sandbox sentence, which the tool descriptions carry even when no file sandbox confines the command. */
export const SANDBOX_SENTENCE =
  "Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way."

/** `pwshDescription(false)`: no Windows sandbox is mounted. */
export const PWSH_DESCRIPTION =
  "Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. " +
  "Each call runs in a fresh pwsh process; pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment " +
  "variables with `$env:NAME`. " +
  "Managed `$env:DSH_*` variables expose current harness environment facts. " +
  "Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. " +
  "On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. " +
  "Provide `description` before `command` in the arguments. " +
  "Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. " +
  "Do not assign to automatic variables such as `$HOME`; variable names are case-insensitive, so `$home` is the same read-only variable. " +
  SANDBOX_SENTENCE

/** `bashDescription()`. */
export const BASH_DESCRIPTION =
  "Execute a bash command (`bash -c`) and return its stdout/stderr. " +
  "Each call runs in a fresh shell; pass `workdir` instead of using `cd`. " +
  "Managed `$DSH_*` variables expose current harness environment facts. " +
  "Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. " +
  "Provide `description` before `command` in the arguments. " +
  "Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. " +
  "An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`. " +
  SANDBOX_SENTENCE

/** The tool's system-prompt section (`tool:pwsh` at `TOOL_PWSH`, `tool:bash` at `TOOL_BASH`). */
export const PWSH_SECTION =
  "Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. " +
  "On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure."
export const BASH_SECTION =
  "Check the [exit code: N] marker on every bash result; investigate failures before moving on."

const DESCRIPTION_PARAMETER = (example: string) =>
  "Clear, concise description of what this command does in active voice, " +
  '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; ' +
  `"git status" → "Show working tree status"; ${example}.`

function schema(shell: DshShell.Kind): DshArgs.ObjectSchema {
  return {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: DESCRIPTION_PARAMETER(
          shell === "pwsh"
            ? '"Get-Process" → "List running processes"'
            : '"npm install" → "Install package dependencies"',
        ),
      },
      command: {
        type: "string",
        description: shell === "pwsh" ? "The PowerShell command to execute." : "The bash command to execute.",
      },
      timeoutMs: {
        type: "number",
        description:
          "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.",
      },
      workdir: {
        type: "string",
        description:
          "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.",
      },
    },
    required: ["description", "command"],
  }
}

export const PWSH_SCHEMA = schema("pwsh")
export const BASH_SCHEMA = schema("bash")

export interface Input {
  readonly command: string
  readonly description: string
  readonly timeoutMs?: number
  readonly workdir?: string
}

export function description(shell: DshShell.Kind) {
  return shell === "pwsh" ? PWSH_DESCRIPTION : BASH_DESCRIPTION
}

export function parameters(shell: DshShell.Kind) {
  return shell === "pwsh" ? PWSH_SCHEMA : BASH_SCHEMA
}

/** `validatePwshArgs` / `validateBashArgs`: the value checks the schema cannot express, as dsh's texts. */
export function validate(input: Input) {
  if (input.command.trim().length === 0) return "invalid command: expected a non-empty string"
  if (input.description.trim().length === 0) return "invalid description: expected a non-empty string"
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0))
    return `invalid timeoutMs: expected a positive number, got ${JSON.stringify(input.timeoutMs)}`
  return undefined
}

/** `renderPwshResult` / `renderBashResult` without sandbox facts: body, then the markers, exit last. */
export function render(result: DshShell.Result) {
  const out = stream(result.stdout)
  const err = stream(result.stderr)
  const joined = err.length === 0 ? out : `${out.length > 0 && !out.endsWith("\n") ? `${out}\n` : out}[stderr]\n${err}`
  const body = joined.length === 0 ? "(no output)" : joined
  const markers = [
    ...(result.timedOut ? [`[timed out after ${result.timeoutMs}ms]`] : []),
    ...(result.signal !== null
      ? [`[killed by signal: ${result.signal}]`]
      : result.exitCode !== 0
        ? [`[exit code: ${result.exitCode}]`]
        : []),
  ]
  if (markers.length === 0) return body
  return `${body.endsWith("\n") ? body : `${body}\n`}${markers.join("\n")}`
}

function stream(output: DshOutput.Collected) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`
}
