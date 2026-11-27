export * as ShellRules from "./shell-rules.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { OwnTeam } from "@own/protocol"

/**
 * The shell part of own.team's permission `evaluate` hook (06 §4.9 item 3, §10.1). core gives the hook every simple
 * command of a `shell` call as its source text (`packages/core/src/shell/parse.ts`, one resource per command with its
 * redirections). Session `ask` rules cannot do this: the last matching rule wins and own.accounts puts
 * `{shell, **, allow}` last in `full` mode.
 *
 * Lowering finds git anywhere a command starts (after `VAR=x`, `env`, `sudo`, `&`, …, as `git`, `git.exe` or a path
 * to it). Raising is strict: only a command that is exactly one of the team's commands, a V10 candidate of the
 * folder, or a read-only git query, with no redirection, pipe, substitution or chaining in its text.
 */

export interface Scope {
  /** The session works in a code-only area folder. */
  readonly codeOnly: boolean
  /** The team main or a session below it (`git merge`/`git rebase` ask: integration goes through `team_integrate`). */
  readonly main: boolean
  /** A team main or owner, a session below the main, or any session in an area folder. */
  readonly team: boolean
}

export interface Lowered {
  readonly effect: "ask" | "deny"
  /** Shown to the model (a deny becomes its `Permission.BlockedError`) and with the permission request. */
  readonly message: string
}

export const LFS_MESSAGE =
  "이 명령은 이 영역에 받지 않은 큰 파일까지 내려받을 수 있어 승인을 받아요. 필요한 큰 파일 폴더는 '큰 파일 폴더 가져오기'(team_need_paths)로 가져와요."
export const SPARSE_MESSAGE =
  "이 영역은 큰 파일 폴더를 받지 않은 가벼운 폴더라 폴더 범위를 바꾸거나 끄는 명령은 쓰지 않아요. 필요한 큰 파일 폴더는 '큰 파일 폴더 가져오기'(team_need_paths)로 가져와요."
export const TEAM_MESSAGE =
  "팀 모드에서는 작업을 지우거나, 원격 저장소에 올리거나, 작업 폴더를 바꾸는 명령은 승인을 받고 실행해요."
export const MAIN_MESSAGE =
  "팀 메인에서는 영역의 작업을 '반영하기'(team_integrate)로 반영해요. 이 명령은 승인을 받아요."

/** The strongest lowering of a `shell` call's commands: `deny` before `ask`; `undefined` when none applies. */
export function lower(resources: ReadonlyArray<string>, scope: Scope): Lowered | undefined {
  const found = resources.flatMap((resource) => {
    const lowered = classify(resource, scope)
    return lowered === undefined ? [] : [lowered]
  })
  return found.find((item) => item.effect === "deny") ?? found[0]
}

/** One command against the rules of 06 §4.9 item 3. */
export function classify(resource: string, scope: Scope): Lowered | undefined {
  const call = git(words(resource))
  if (call?.command === undefined) return undefined
  const args = call.args
  if (scope.codeOnly && call.command === "lfs" && lfsRisky(args)) return { effect: "ask", message: LFS_MESSAGE }
  if (scope.codeOnly && call.command === "sparse-checkout" && SPARSE_DENIED.has(args[0] ?? ""))
    return { effect: "deny", message: SPARSE_MESSAGE }
  if (!scope.team) return undefined
  if (scope.main && (call.command === "merge" || call.command === "rebase"))
    return { effect: "ask", message: MAIN_MESSAGE }
  return risky(call.command, args) ? { effect: "ask", message: TEAM_MESSAGE } : undefined
}

/** Whether a command may run without asking (06 §10.1): exactly one of `exact`, or a read-only git query. */
export function allowed(resource: string, exact: ReadonlyArray<ReadonlyArray<string>>) {
  if (/[|&;<>`$(){}\r\n]/.test(resource)) return false
  const list = words(resource)
  if (list.length === 0) return false
  return (
    readOnly(list) ||
    exact.some((command) => command.length === list.length && command.every((word, index) => word === list[index]))
  )
}

/** The exact commands of the team (06 §10.1): `commands.setup` and `commands.code`, each simple command of a shell string. */
export function commands(team: OwnTeam.Team): string[][] {
  return [...(team.commands.setup ? [team.commands.setup] : []), ...team.commands.code].flatMap((command) => {
    if ("argv" in command) return [[...command.argv]]
    return command.shell
      .split(/&&|\|\||[;|\r\n]/)
      .map(words)
      .filter((list) => list.length > 0)
  })
}

/**
 * The V10 candidates of a folder that need no question (06 §3.5 V10, §10.1): the `package.json` scripts `typecheck`,
 * `check`, `test`, `lint` and `build` run through the package manager of the lock file, and its install command.
 * Read again only when `package.json` changes.
 */
export async function candidates(directory: string): Promise<ReadonlyArray<ReadonlyArray<string>>> {
  const manifest = path.join(directory, "package.json")
  const stat = await fs.stat(manifest).catch(() => undefined)
  if (!stat) return []
  const cached = CANDIDATES.get(directory)
  if (cached?.mtime === stat.mtimeMs) return cached.commands
  const parsed = Option.getOrUndefined(
    decodeManifest(
      await Bun.file(manifest)
        .text()
        .catch(() => ""),
    ),
  )
  const locks = await Promise.all(
    LOCKS.map(async ([file, manager]) => ((await Bun.file(path.join(directory, file)).exists()) ? manager : undefined)),
  )
  const manager = locks.find((item) => item !== undefined)
  const scripts = Object.keys(parsed?.scripts ?? {}).filter((name) => SCRIPTS.has(name))
  const found = [
    ...scripts.map((name) => [manager ?? "npm", "run", name]),
    ...(manager === undefined ? [] : INSTALL[manager]),
  ]
  CANDIDATES.set(directory, { mtime: stat.mtimeMs, commands: found })
  return found
}

/** Words of one simple command: whitespace separates; quotes group and are removed (`\"` inside `"…"` is a quote). */
export function words(command: string): string[] {
  const result: string[] = []
  let current = ""
  let quote: string | undefined
  let started = false
  for (const [index, char] of command.split("").entries()) {
    if (quote !== undefined) {
      if (char === quote && !(quote === '"' && command[index - 1] === "\\")) quote = undefined
      else if (!(char === "\\" && quote === '"' && command[index + 1] === '"')) current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) result.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) result.push(current)
  return result
}

export interface Invocation {
  /** Options before the subcommand, with their values (`-C <dir>`, `-c <k=v>`, `--no-pager`). */
  readonly options: ReadonlyArray<string>
  readonly command: string | undefined
  readonly args: ReadonlyArray<string>
}

/** The git invocation a command starts, or `undefined`. `git-lfs <x>` reads as `git lfs <x>`. */
export function git(list: ReadonlyArray<string>): Invocation | undefined {
  const start = list.findIndex(
    (word) => !ASSIGNMENT.test(word) && !WRAPPERS.has(program(word)) && !word.startsWith("-"),
  )
  if (start < 0) return undefined
  const name = program(list[start] ?? "")
  if (name === "git-lfs") return { options: [], command: "lfs", args: list.slice(start + 1) }
  if (name !== "git") return undefined
  return invocation(list.slice(start + 1), [])
}

/** `git status|diff|log|show|rev-parse` with no option that runs or writes something (06 §10.1 읽기만 하는 git). */
export function readOnly(list: ReadonlyArray<string>) {
  if (list[0] !== "git") return false
  const call = invocation(list.slice(1), [])
  if (call.command === undefined || !READ_ONLY.has(call.command)) return false
  const options = call.options.every(
    (option, index) => option === "--no-pager" || option === "-C" || call.options[index - 1] === "-C",
  )
  return (
    options &&
    !call.args.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff")
  )
}

const READ_ONLY = new Set(["status", "diff", "log", "show", "rev-parse"])
const SPARSE_DENIED = new Set(["disable", "set", "init"])
/** Global options that take the next word as their value. */
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"])
const WRAPPERS = new Set(["&", "env", "command", "builtin", "exec", "sudo", "doas", "nohup", "time", "nice"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SCRIPTS = new Set(["typecheck", "check", "test", "lint", "build"])
const LOCKS = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
] as const
const INSTALL: Readonly<Record<(typeof LOCKS)[number][1], ReadonlyArray<ReadonlyArray<string>>>> = {
  bun: [["bun", "install"]],
  pnpm: [["pnpm", "install"]],
  yarn: [["yarn", "install"]],
  npm: [
    ["npm", "ci"],
    ["npm", "install"],
  ],
}
const CANDIDATES = new Map<
  string,
  { readonly mtime: number; readonly commands: ReadonlyArray<ReadonlyArray<string>> }
>()

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ scripts: optional(Schema.Record(Schema.String, Schema.Unknown)) })),
)

function invocation(rest: ReadonlyArray<string>, options: ReadonlyArray<string>): Invocation {
  const [first, ...tail] = rest
  if (first === undefined || !first.startsWith("-")) return { options, command: first, args: tail }
  if (VALUED.has(first)) return invocation(tail.slice(1), [...options, first, ...tail.slice(0, 1)])
  return invocation(tail, [...options, first])
}

/** `C:\Program Files\Git\cmd\git.exe` → `git`. */
function program(word: string) {
  return path.posix
    .basename(word.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/, "")
}

/** `git lfs fetch` without an include list or with `--all`, `git lfs pull`, `git lfs checkout` (4.9). */
function lfsRisky(args: ReadonlyArray<string>) {
  const [sub, ...rest] = args
  if (sub === "pull" || sub === "checkout") return true
  if (sub !== "fetch") return false
  const include = rest.some((arg) => arg === "-I" || arg === "--include" || /^(-I.|--include=)/.test(arg))
  return !include || rest.includes("--all")
}

/**
 * The commands every team session asks for (4.9): they lose work, publish, or change worktrees. `worktree list` and
 * `stash list` only read (an owner on a real model looked at the worktrees and waited for an answer, 2026-10-15).
 */
function risky(command: string, args: ReadonlyArray<string>) {
  if (command === "push" || command === "restore" || command === "clean") return true
  if (command === "worktree") return args[0] !== "list"
  if (command === "reset") return args.includes("--hard")
  if (command === "checkout")
    return args.some((arg) => arg === "--" || arg === "-f" || arg === "--force" || arg === ".")
  if (command === "stash") return args[0] !== "list"
  if (command !== "branch") return false
  const short = args.filter((arg) => /^-[A-Za-z]+$/.test(arg)).join("")
  const remove = short.includes("d") || args.includes("--delete")
  const force = short.includes("f") || args.includes("--force")
  return short.includes("D") || (remove && force)
}
