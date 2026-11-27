// Ports the execution and result text of packages/coding-agent/src/core/tools/bash.ts (`createShellToolDefinition`):
// stdout and stderr in one stream, the last 2000 lines or 50KB with Pi's notices and the full output kept in a temp
// file, `(no output)` for an empty result, and `Command exited with code N` (an error result) for a failing command.
// An aborted or timed-out command fails with its output and Pi's status line; a timeout after the shell itself exited
// also gives the shell's exit code and when it exited (Pi 1.5.1, #11613). Pi's streaming updates to its TUI are not
// ported.
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf; see pi-data/NOTICE.
export * as PiBash from "./bash.js"

import { Buffer } from "node:buffer"
import type { PiArgs } from "./args.js"
import { PiOutput } from "./output.js"
import { PiShell } from "./shell.js"
import { PiTruncate } from "./truncate.js"

export const NAME = "bash"

export const DESCRIPTION = `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${PiTruncate.DEFAULT_MAX_LINES} lines or ${PiTruncate.DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`

export const SCHEMA: PiArgs.ObjectSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
  },
  required: ["command"],
}

export interface Input {
  readonly command: string
  readonly timeout?: number
}

export interface Result {
  readonly text: string
  readonly isError: boolean
  readonly exitCode: number
  readonly truncation?: PiTruncate.Result
  readonly fullOutputPath?: string
}

/**
 * own's limit for a command the model gave no timeout (Pi has none). A command that never ends otherwise holds the
 * turn until the user stops it: on Windows a native program reading a Git Bash heredoc (`python - <<'EOF'`) never
 * returns (2026-10-14 live test). Ten minutes covers long builds and test runs; the model can pass a larger timeout.
 */
export const DEFAULT_TIMEOUT_SECONDS = 600

/** Runs `input.command` with Pi's bash tool semantics. Throws Pi's error texts for abort, timeout and spawn failures. */
export async function execute(
  input: Input,
  options: {
    readonly cwd: string
    readonly env?: NodeJS.ProcessEnv
    readonly signal?: AbortSignal
    readonly shell?: PiShell.Config
    readonly onSpawn?: (pid: number | undefined) => void
  },
): Promise<Result> {
  const output = new PiOutput.Accumulator("pi-bash")
  const accepting = { open: true }
  const finish = async () => {
    accepting.open = false
    output.finish()
    const snapshot = output.snapshot({ persistIfTruncated: true })
    await output.closeTempFile()
    return snapshot
  }
  const ran = await PiShell.run(input.command, options.cwd, {
    onData: (data) => {
      if (accepting.open) output.append(data)
    },
    signal: options.signal,
    timeout: input.timeout ?? DEFAULT_TIMEOUT_SECONDS,
    env: options.env,
    shell: options.shell,
    onSpawn: options.onSpawn,
  }).then(
    (result) => ({ ok: true as const, exitCode: result.exitCode }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const snapshot = await finish()
  if (!ran.ok) {
    const text = format(snapshot, output, "")
    const message = ran.error instanceof Error ? ran.error.message : String(ran.error)
    if (message === "aborted") throw new Error(status(text, "Command aborted"))
    if (message.startsWith("timeout:")) {
      const timedOut = `Command timed out after ${message.split(":")[1]} seconds`
      // Both facts matter: the command's real result, and that its background processes were still writing output
      // when the timeout hit.
      const exit = ran.error instanceof PiShell.TimeoutError ? ran.error.shellExit : undefined
      throw new Error(
        status(
          text,
          exit === undefined
            ? timedOut
            : `${timedOut}. The shell exited with code ${exit.exitCode} after ${exit.afterSeconds} seconds, but background processes it started kept writing output until the timeout.`,
        ),
      )
    }
    throw ran.error
  }
  return finished(snapshot, output, ran.exitCode)
}

/**
 * A command own answered itself without a process (read-only mode, ask mode and the `explore` role read through
 * CodexReadOnly, 12 §3): its output and exit code as Pi's bash result, with the same truncation, temp file and status
 * line as a command that ran.
 */
export async function answered(text: string, exitCode: number): Promise<Result> {
  const output = new PiOutput.Accumulator("pi-bash")
  output.append(Buffer.from(text))
  output.finish()
  const snapshot = output.snapshot({ persistIfTruncated: true })
  await output.closeTempFile()
  return finished(snapshot, output, exitCode)
}

/** A finished command's result: `(no output)` when empty, and Pi's status line (an error) for a non-zero exit. */
function finished(snapshot: PiOutput.Snapshot, output: PiOutput.Accumulator, exitCode: number): Result {
  const text = format(snapshot, output, "(no output)")
  const details = snapshot.truncation.truncated
    ? { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath }
    : {}
  if (exitCode !== 0)
    return { text: status(text, `Command exited with code ${exitCode}`), isError: true, exitCode, ...details }
  return { text, isError: false, exitCode: 0, ...details }
}

/** The output with Pi's truncation notice. */
function format(snapshot: PiOutput.Snapshot, output: PiOutput.Accumulator, empty: string) {
  const text = snapshot.content || empty
  const truncation = snapshot.truncation
  if (!truncation.truncated) return text
  const start = truncation.totalLines - truncation.outputLines + 1
  const end = truncation.totalLines
  const file = snapshot.fullOutputPath
  if (truncation.lastLinePartial)
    return `${text}\n\n[Showing last ${PiTruncate.formatSize(truncation.outputBytes)} of line ${end} (line is ${PiTruncate.formatSize(output.lastLineBytes())}). Full output: ${file}]`
  if (truncation.truncatedBy === "lines")
    return `${text}\n\n[Showing lines ${start}-${end} of ${truncation.totalLines}. Full output: ${file}]`
  return `${text}\n\n[Showing lines ${start}-${end} of ${truncation.totalLines} (${PiTruncate.formatSize(PiTruncate.DEFAULT_MAX_BYTES)} limit). Full output: ${file}]`
}

function status(text: string, line: string) {
  return `${text ? `${text}\n\n` : ""}${line}`
}
