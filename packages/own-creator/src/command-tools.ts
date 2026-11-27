export * as CommandTools from "./command-tools.js"

import { existsSync } from "node:fs"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Creator } from "@own/protocol/creator"
import { ProcessTree, Redact } from "@own/runtime"
import { Effect } from "effect"
import { Match } from "./match.js"
import { Safety } from "./safety.js"
import type { CreatorState } from "./state.js"

/**
 * Command tools (17 §5.2): each `tool.command` item in force is a tool `ext_<name>` that fills the template with its
 * arguments, quoted for the shell, and runs it through the harness's shell approval (`shell.authorize`, core P-019:
 * `external_directory` for a folder outside the project, then `shell` per parsed command), so the approval mode and
 * the saved `항상 허용` rules decide as for any command. Code Mode tools unless `direct`: a change then only appends to
 * the Code Mode catalog after the conversation. The command sees the service's environment without secrets, and its
 * output has token-shaped text masked.
 */

type Ctx = Pick<Context, "tool" | "shell" | "session" | "location">

export const register = (ctx: Ctx, state: CreatorState.State) =>
  ctx.tool.transform((editor) => {
    Match.items(state.list, "tool.command")
      .filter((entry) => Match.where(entry.item.when, ctx.location.directory))
      .forEach((entry) => {
        editor.add({
          name: Creator.toolName(entry.item.name),
          description: entry.item.description,
          input: inputSchema(entry.item),
          options: entry.item.direct === true ? { codemode: false } : {},
          execute: (input: unknown, call: Tool.Context) =>
            run(ctx, entry.owner.loaded.entry.id, entry.item, input, call),
        })
      })
  })

function inputSchema(item: Creator.CommandTool) {
  const params = Object.entries(item.params ?? {})
  return {
    type: "object",
    properties: Object.fromEntries(
      params.map(([name, param]) => [
        name,
        { type: param.type, description: param.description, ...(param.enum === undefined ? {} : { enum: param.enum }) },
      ]),
    ),
    required: params.filter(([, param]) => param.optional !== true).map(([name]) => name),
    additionalProperties: false,
  } as const
}

function run(ctx: Ctx, id: string, item: Creator.CommandTool, input: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const facts = yield* Match.facts(ctx, call.sessionID, call.agent)
    if (facts !== undefined && !Match.when(item.when, facts))
      return failed(`This tool is not available in this conversation (extension '${id}').`)
    const args = check(item, input)
    if (typeof args === "string") return failed(args)
    const shell = resolveShell(item.shell)
    const command = render(item.command, args, shell.kind)
    const approved = yield* ctx.shell.authorize(
      { command, cwd: path.resolve(ctx.location.directory, item.cwd ?? "."), shell: shell.path },
      call,
    )
    const done = yield* Effect.tryPromise({
      try: (signal) => execute(shell, command, approved.cwd, (item.timeoutSeconds ?? 120) * 1000, signal),
      catch: (error) => error,
    }).pipe(Effect.result)
    if (done._tag === "Failure") return failed(`The command could not start: ${String(done.failure)}`, { command })
    const output = tail(Redact.text(done.success.output), Creator.LIMITS.output)
    const status =
      done.success.stop === "timeout" ? `timed out after ${item.timeoutSeconds ?? 120}s` : `exit ${done.success.exit}`
    return {
      content: `${status}\n${output}`,
      metadata: {
        command,
        exit: done.success.exit,
        extension: id,
        truncated: output.length < done.success.output.length,
      },
    } satisfies Tool.Result
  })
}

/** The call's arguments by the item's parameters, or why they do not fit. */
export function check(item: Creator.CommandTool, input: unknown): Record<string, string | number | boolean> | string {
  const given = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const params = item.params ?? {}
  const unknown = Object.keys(given).filter((name) => !(name in params))
  if (unknown.length > 0) return `Unknown argument ${unknown.join(", ")}.`
  const entries = Object.entries(params).flatMap(
    ([name, param]): Array<[string, string | number | boolean] | string> => {
      const value = given[name]
      if (value === undefined || value === null) return param.optional === true ? [] : [`Missing argument ${name}.`]
      if (param.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
        return [`${name} must be a number.`]
      if (param.type === "boolean" && typeof value !== "boolean") return [`${name} must be true or false.`]
      if (param.type === "string" && typeof value !== "string") return [`${name} must be a string.`]
      if (typeof value === "string" && value.length > Creator.LIMITS.paramValue)
        return [`${name} is longer than ${Creator.LIMITS.paramValue} characters.`]
      if (param.enum !== undefined && !param.enum.includes(String(value)))
        return [`${name} must be one of ${param.enum.join(", ")}.`]
      return [[name, value as string | number | boolean]]
    },
  )
  const errors = entries.filter((entry): entry is string => typeof entry === "string")
  if (errors.length > 0) return errors.join(" ")
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string | number | boolean] => typeof entry !== "string"),
  )
}

export type ShellKind = "powershell" | "posix"

export interface Shell {
  readonly kind: ShellKind
  readonly path: string
  readonly args: ReadonlyArray<string>
}

/** `default` is Windows PowerShell on Windows and bash (else sh) elsewhere. */
export function resolveShell(choice: Creator.CommandTool["shell"]): Shell {
  const windows = process.platform === "win32"
  if (choice === "powershell" || (choice === undefined && windows) || (choice === "default" && windows)) {
    const system = process.env.SystemRoot ?? "C:\\Windows"
    const powershell = windows ? path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "pwsh"
    return {
      kind: "powershell",
      path: windows && existsSync(powershell) ? powershell : windows ? "powershell.exe" : "pwsh",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
    }
  }
  if (choice === "sh") return { kind: "posix", path: "sh", args: ["-c"] }
  if (windows) {
    const git = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .flatMap((root) => (root === undefined ? [] : [path.join(root, "Git", "bin", "bash.exe")]))
      .find((candidate) => existsSync(candidate))
    return { kind: "posix", path: git ?? "bash.exe", args: ["-c"] }
  }
  return { kind: "posix", path: existsSync("/bin/bash") ? "/bin/bash" : "sh", args: ["-c"] }
}

/** The template with each `{{name}}` replaced by its argument, quoted for `kind`; a missing optional one is empty. */
export function render(template: string, args: Readonly<Record<string, string | number | boolean>>, kind: ShellKind) {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g, (_, name: string) => {
    const value = args[name]
    if (value === undefined) return ""
    if (typeof value !== "string") return String(value)
    return quote(value, kind)
  })
}

export function quote(value: string, kind: ShellKind) {
  if (kind === "powershell")
    return `'${value.replaceAll("'", "''").replaceAll("\u2018", "\u2018\u2018").replaceAll("\u2019", "\u2019\u2019")}'`
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** UTF-8 output from Windows PowerShell, whose console otherwise writes the system code page. */
const POWERSHELL_PREAMBLE =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;"

async function execute(shell: Shell, command: string, cwd: string, timeoutMs: number, signal: AbortSignal) {
  const child = Bun.spawn(
    [shell.path, ...shell.args, shell.kind === "powershell" ? `${POWERSHELL_PREAMBLE}${command}` : command],
    {
      cwd,
      env: Safety.commandEnv(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...ProcessTree.SPAWN,
    },
  )
  const [stdout, stderr, ended] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    ProcessTree.exited(child, { signal, timeoutMs }),
  ])
  return { output: [stdout, stderr].filter((part) => part !== "").join("\n"), exit: ended.code, stop: ended.stop }
}

function tail(text: string, max: number) {
  return text.length <= max ? text : text.slice(text.length - max)
}

function failed(content: string, metadata: Record<string, unknown> = {}): Tool.Result {
  return { content, metadata: { ...metadata, isError: true } }
}
