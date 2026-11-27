// The `dsh` harness's tools: dsh's shell (`pwsh` on Windows, `bash` elsewhere), `read`, `write`, `edit`, `glob`,
// `grep` and `todo_write` as own plugin tools. They register under internal names (`dsh_read`, …) because core's
// `read`, `edit`, `write`, `glob` and `grep` keep theirs for the other harnesses; the dsh request lists them under
// dsh's names and core maps the calls back (request.ts, P-028 repairs an aliased call against the tool it runs). They
// are listed only in dsh sessions (`Gate.DSH_ACTION`) and ask own's permissions through P-019 as core's tools do:
// `read` for reads, `edit` with the diff for edits and writes (`external_directory` first outside the Location),
// `glob` and `grep` with the pattern, and the shell approval for commands. A failure answers the model with dsh's text
// (`Error: <message>`, the tool registry's `toolErrorResult`) as the result: core sends a tool error as a JSON
// envelope, which would change the text dsh's model reads.
export * as DshTools from "./tools.js"

import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Semaphore } from "effect"
import { GitHubBridge, PathForms } from "@own/runtime"
import { CoreTool } from "../codex/core-tool.js"
import { Gate } from "../gate.js"
import { HarnessPermission } from "../permission.js"
import { DshArgs } from "./args.js"
import { DshFs } from "./fs.js"
import { DshObserve } from "./observe.js"
import { DshReadable } from "./readable.js"
import { DshSearch } from "./search.js"
import { DshShell } from "./shell.js"
import { DshShellTool } from "./shell-tool.js"
import { DshTodo } from "./todo.js"

type Ctx = Pick<Context, "tool" | "permission" | "shell" | "location" | "session" | "agent" | "rpc">

/** dsh's tool name → the name it registers under. */
export const INTERNAL: Readonly<Record<string, string>> = {
  pwsh: "dsh_pwsh",
  bash: "dsh_bash",
  read: "dsh_read",
  write: "dsh_write",
  edit: "dsh_edit",
  glob: "dsh_glob",
  grep: "dsh_grep",
  todo_write: "dsh_todo_write",
}

/** dsh's tools on this platform (the base bundle mounts `tool-pwsh` on Windows only and `tool-bash` elsewhere). */
export const NAMES = [DshShell.kind(), "read", "write", "edit", "glob", "grep", DshTodo.NAME] as const

export const register = (ctx: Ctx, observed: DshObserve.State) =>
  Effect.gen(function* () {
    // dsh's per-target lock: mutations of one file run one at a time, other files in parallel.
    const locks = new Map<string, Semaphore.Semaphore>()
    const shell = DshShell.kind()
    const add = (
      name: string,
      description: string,
      schema: DshArgs.ObjectSchema,
      execute: (raw: unknown, call: Tool.Context) => Effect.Effect<Tool.Result, Tool.Error>,
    ) => ({
      name: INTERNAL[name]!,
      description,
      input: DshArgs.standard(schema),
      options: { codemode: false, permission: Gate.DSH_ACTION },
      execute,
    })
    yield* ctx.tool.transform((editor) => {
      editor.add(
        add(shell, DshShellTool.description(shell), DshShellTool.parameters(shell), (raw, call) =>
          runShell(ctx, shell, raw, call),
        ),
      )
      editor.add(add("read", DshFs.READ_DESCRIPTION, DshFs.READ_SCHEMA, (raw, call) => read(ctx, observed, raw, call)))
      editor.add(
        add("write", DshFs.WRITE_DESCRIPTION, DshFs.WRITE_SCHEMA, (raw, call) =>
          write(ctx, observed, locks, raw, call),
        ),
      )
      editor.add(
        add("edit", DshFs.EDIT_DESCRIPTION, DshFs.EDIT_SCHEMA, (raw, call) => edit(ctx, observed, locks, raw, call)),
      )
      editor.add(add("glob", DshSearch.GLOB_DESCRIPTION, DshSearch.GLOB_SCHEMA, (raw, call) => glob(ctx, raw, call)))
      editor.add(add("grep", DshSearch.GREP_DESCRIPTION, DshSearch.GREP_SCHEMA, (raw, call) => grep(ctx, raw, call)))
      editor.add(add(DshTodo.NAME, DshTodo.DESCRIPTION, DshTodo.SCHEMA, (raw) => Effect.sync(() => todo(raw))))
    })
  })

function runShell(ctx: Ctx, shell: DshShell.Kind, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const args = DshArgs.check<DshShellTool.Input>(DshShellTool.parameters(shell), raw)
    if (!args.ok) return failed(args.message)
    const invalid = DshShellTool.validate(args.value)
    if (invalid !== undefined) return failed(invalid, { command: args.value.command })
    const workdir =
      args.value.workdir === undefined
        ? ctx.location.directory
        : path.resolve(ctx.location.directory, args.value.workdir)
    const approved = yield* ctx.shell.authorize(
      {
        command: args.value.command,
        cwd: workdir,
        shell: shell === "pwsh" ? DshShell.resolvePwshPath() : "/bin/bash",
      },
      call,
    )
    // git's logins for the GitHub account the conversation uses (16 §6), when own has one for it; they end with the
    // command.
    const login = new AbortController()
    const spawned = Promise.withResolvers<number | undefined>()
    const github = yield* Effect.promise(() =>
      GitHubBridge.gitEnv(approved.cwd, { sessionID: call.sessionID, signal: login.signal, pid: spawned.promise }),
    )
    const done = yield* Effect.tryPromise({
      try: (signal) =>
        DshShell.run({
          shell,
          command: args.value.command,
          cwd: approved.cwd,
          timeoutMs: DshShell.timeout(args.value.timeoutMs),
          env: { ...DshShell.environment(shell, managed(call), process.env), ...github },
          signal,
          onSpawn: spawned.resolve,
        }).finally(() => {
          spawned.resolve(undefined)
          login.abort()
        }),
      catch: (error) => error,
    }).pipe(Effect.result)
    if (done._tag === "Failure") return failed(message(done.failure), { command: args.value.command })
    const result = done.success
    // The shell card marks a non-zero `exit` as failed (session-ui `shellResultFailed`).
    return text(DshShellTool.render(result), {
      command: args.value.command,
      description: args.value.description,
      exit: result.exitCode ?? (result.signal === null ? undefined : 1),
      truncated: result.stdout.truncated || result.stderr.truncated,
      ...(result.timedOut ? { timedOut: true } : {}),
    })
  })
}

function read(ctx: Ctx, observed: DshObserve.State, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const args = DshArgs.check<DshFs.ReadInput>(DshFs.READ_SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    const window = DshFs.readArgs(args.value)
    if (!window.ok) return failed(window.message)
    const target = yield* attempt(() => DshFs.resolve(args.value.file_path, ctx.location.directory))
    if (!target.ok) return failed(target.message)
    const [resource] = yield* ctx.permission.paths({ paths: [target.value.displayPath], kind: "file" }, call)
    yield* HarnessPermission.assert(ctx, { action: "read", resources: [resource!.resource], save: ["*"] }, call)
    const done = yield* attempt(() => DshFs.read(target.value, window))
    if (!done.ok) return failed(done.message)
    if (done.value.observation !== undefined) observed.observe(call.sessionID, target.value.key, done.value.observation)
    if (done.value.error !== undefined) return failed(done.value.error)
    return text(done.value.text!, {
      path: target.value.displayPath,
      truncated: (done.value.lines ?? 0) < (done.value.totalLines ?? 0),
    })
  })
}

function write(
  ctx: Ctx,
  observed: DshObserve.State,
  locks: Map<string, Semaphore.Semaphore>,
  raw: unknown,
  call: Tool.Context,
) {
  return Effect.gen(function* () {
    const args = DshArgs.check<DshFs.WriteInput>(DshFs.WRITE_SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    if (args.value.file_path.trim().length === 0) return failed("file_path must be a non-empty string")
    const target = yield* attempt(() => DshFs.resolve(args.value.file_path, ctx.location.directory))
    if (!target.ok) return failed(target.message)
    const [resource] = yield* ctx.permission.paths({ paths: [target.value.displayPath], kind: "file" }, call)
    return yield* serialized(
      locks,
      target.value.key,
      Effect.gen(function* () {
        const intent = observed.writeIntent(call.sessionID, target.value.key)
        const planned = yield* attempt(() => DshFs.planWrite(target.value, intent), target.value.displayPath)
        if (!planned.ok) return failed(planned.message)
        const file = fileDiff(
          resource!.resource,
          planned.value.before ?? "",
          args.value.content,
          planned.value.existed ? "modified" : "added",
        )
        yield* approveEdit(ctx, file, call)
        const done = yield* attempt(
          () => DshFs.write(target.value, args.value.content, planned.value),
          target.value.displayPath,
        )
        if (!done.ok) return failed(done.message)
        observed.observe(call.sessionID, target.value.key, { kind: "present", version: done.value.version })
        return text(done.value.text, { files: [file] })
      }),
    )
  })
}

function edit(
  ctx: Ctx,
  observed: DshObserve.State,
  locks: Map<string, Semaphore.Semaphore>,
  raw: unknown,
  call: Tool.Context,
) {
  return Effect.gen(function* () {
    const args = DshArgs.check<DshFs.EditInput>(DshFs.EDIT_SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    const invalid = DshFs.editArgs(args.value)
    if (invalid !== undefined) return failed(invalid)
    const target = yield* attempt(() => DshFs.resolve(args.value.file_path, ctx.location.directory))
    if (!target.ok) return failed(target.message)
    const [resource] = yield* ctx.permission.paths({ paths: [target.value.displayPath], kind: "file" }, call)
    return yield* serialized(
      locks,
      target.value.key,
      Effect.gen(function* () {
        const planned = yield* attempt(async () => {
          const version = observed.editIntent(call.sessionID, target.value.key, target.value.displayPath)
          return DshFs.planEdit(target.value, args.value, version)
        }, target.value.displayPath)
        if (!planned.ok) return failed(planned.message)
        const file = fileDiff(resource!.resource, planned.value.before, planned.value.after, "modified")
        yield* approveEdit(ctx, file, call)
        const done = yield* attempt(
          () => DshFs.edit(target.value, planned.value, args.value.replace_all ?? false),
          target.value.displayPath,
        )
        if (!done.ok) return failed(done.message)
        observed.observe(call.sessionID, target.value.key, { kind: "present", version: done.value.version })
        return text(done.value.text, { files: [file] })
      }),
    )
  })
}

function glob(ctx: Ctx, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const args = DshArgs.check<DshSearch.GlobInput>(DshSearch.GLOB_SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    const invalid = DshSearch.globArgs(args.value)
    if (invalid !== undefined) return failed(invalid)
    const directory = path.resolve(ctx.location.directory, args.value.path ?? ".")
    yield* ctx.permission.paths({ paths: [directory], kind: "directory" }, call)
    yield* HarnessPermission.assert(ctx, { action: "glob", resources: [args.value.pattern], save: ["*"] }, call)
    yield* provision(ctx, "glob", args.value.pattern, call)
    const ran = yield* Effect.tryPromise({
      try: (signal) => DshSearch.run("glob", DshSearch.globCommand(args.value), ctx.location.directory, signal),
      catch: (error) => error,
    }).pipe(Effect.orElseSucceed(() => ({ ok: false as const, message: "glob search failed" })))
    if (!ran.ok) return failed(ran.message)
    const found = ran.noMatches ? [] : DshSearch.globPaths(ran.stdout, ctx.location.directory)
    // own's P-031: a path whose read is denied is left out (a `.env` name is not its contents, so asking ones stay).
    const effect = yield* readEffect(ctx, call)
    const paths = found.filter((file) => effect(path.resolve(ctx.location.directory, file)) !== "deny")
    const spill =
      paths.length > DshSearch.GLOB_MAX_RESULTS
        ? yield* Effect.promise(() => DshSearch.save(call.sessionID, "glob-results.txt", paths.join("\n")))
        : undefined
    return text(DshSearch.renderGlob(paths, spill), { count: paths.length, truncated: spill !== undefined })
  })
}

function grep(ctx: Ctx, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const args = DshArgs.check<DshSearch.GrepInput>(DshSearch.GREP_SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    const invalid = DshSearch.grepArgs(args.value)
    if (invalid !== undefined) return failed(invalid)
    const searched = path.resolve(ctx.location.directory, args.value.path ?? ".")
    yield* ctx.permission.paths({ paths: [searched], kind: "directory" }, call)
    yield* HarnessPermission.assert(ctx, { action: "grep", resources: [args.value.pattern], save: ["*"] }, call)
    yield* provision(ctx, "grep", args.value.pattern, call)
    const ran = yield* Effect.tryPromise({
      try: (signal) => DshSearch.run("grep", DshSearch.grepCommand(args.value), ctx.location.directory, signal),
      catch: (error) => error,
    }).pipe(Effect.orElseSucceed(() => ({ ok: false as const, message: "grep search failed" })))
    if (!ran.ok) return failed(ran.message)
    const parsed = ran.noMatches
      ? { ok: true as const, matches: [] }
      : DshSearch.grepMatches(ran.stdout, ctx.location.directory)
    if (!parsed.ok) return failed(parsed.message)
    // own's P-031: lines only from files whose read is allowed without asking, and how many files were left out.
    const effect = yield* readEffect(ctx, call)
    const absolute = (match: DshSearch.Match) => path.resolve(ctx.location.directory, match.path)
    const matches = parsed.matches.filter((match) => effect(absolute(match)) === "allow")
    const hidden = new Set(parsed.matches.filter((match) => effect(absolute(match)) !== "allow").map(absolute)).size
    const spill =
      matches.length > DshSearch.GREP_MAX_MATCHES
        ? yield* Effect.promise(() =>
            DshSearch.save(call.sessionID, "grep-results.txt", DshSearch.grepComplete(matches)),
          )
        : undefined
    const rendered = DshSearch.renderGrep(matches, spill)
    return text(
      hidden > 0
        ? `${rendered}

${DshReadable.leftOut(hidden)}`
        : rendered,
      {
        count: matches.length,
        truncated: matches.length > DshSearch.GREP_MAX_MATCHES,
        ...(hidden > 0 ? { hidden } : {}),
      },
    )
  })
}

/**
 * dsh ships ripgrep; own runs the copy core downloads on first use (`DshSearch.ripgrep`). Until core has fetched it, one
 * call of core's own tool with the same pattern (the same permission) makes core do so. Its result and its failures are
 * not used: without ripgrep the search answers dsh's launch failure.
 */
function provision(ctx: Ctx, tool: "glob" | "grep", pattern: string, call: Tool.Context) {
  if (DshSearch.ripgrep() !== undefined) return Effect.void
  return Effect.exit(CoreTool.call(ctx, tool, { pattern, limit: 1 }, call)).pipe(Effect.asVoid)
}

function todo(raw: unknown) {
  const args = DshArgs.check<DshTodo.Input>(DshTodo.SCHEMA, raw)
  if (!args.ok) return failed(args.message)
  const listed = DshTodo.list(args.value)
  if (!listed.ok) return failed(listed.message)
  return text(DshTodo.render(listed.todos), { todos: listed.todos })
}

/**
 * `read` as the agent's and the session's rules decide it for a file (readable.ts), denied for own's protected paths
 * (own-accounts' hook, 01 §13), read once per search.
 */
function readEffect(ctx: Ctx, call: Tool.Context) {
  return Effect.gen(function* () {
    const session = yield* ctx.session.get({ sessionID: call.sessionID }).pipe(Effect.option)
    const agent = yield* ctx.agent.get({ agentID: call.agent }).pipe(Effect.option)
    const protectedPatterns = yield* DshReadable.protectedPatterns(ctx)
    const rules = [
      ...(agent._tag === "Some" ? agent.value.data.permissions : []),
      ...(session._tag === "Some" ? (session.value.permissions ?? []) : []),
    ]
    // Every spelling of the file (its real path past a link, a junction, a short name) is matched, as the hook does.
    return (file: string) =>
      PathForms.of(file).some((form) => protectedPatterns.some((pattern) => DshReadable.match(form, pattern)))
        ? ("deny" as const)
        : DshReadable.evaluate("read", DshReadable.resource(file, ctx.location.directory), rules)
  })
}

/** The managed `DSH_*` facts (packages/shell/shell-env `collect`) own has: the shell marker and the session id. */
function managed(call: Tool.Context): Record<string, string> {
  return { DSH_SESSION_ID: call.sessionID, DSH_SHELL: "1" }
}

/** One `edit` permission with the diff for the approval card, as core's edit and write tools ask. */
function approveEdit(ctx: Ctx, file: ReturnType<typeof fileDiff>, call: Tool.Context) {
  return HarnessPermission.assert(
    ctx,
    {
      action: "edit",
      resources: [file.file],
      save: ["*"],
      metadata: { filepath: file.file, diff: file.patch, files: [file] },
    },
    call,
  )
}

/** Runs `effect` holding the file's lock (dsh fs-local `withLock`, keyed by the file's identity). */
function serialized<A, E, R>(locks: Map<string, Semaphore.Semaphore>, key: string, effect: Effect.Effect<A, E, R>) {
  const lock = locks.get(key) ?? Semaphore.makeUnsafe(1)
  locks.set(key, lock)
  return lock.withPermits(1)(effect)
}

/** A promise's value, or its failure as dsh's model-facing text (`remediateFsError` with `displayPath`). */
function attempt<A>(run: () => Promise<A>, displayPath?: string) {
  return Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        message: message(displayPath === undefined ? error : DshObserve.remediate(error, displayPath)),
      }),
    ),
  )
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function text(content: string, metadata: Record<string, unknown> = {}): Tool.Result {
  return { content, metadata: { truncated: false, ...metadata } }
}

/** `toolErrorResult`: `Error: <message>`, marked as an error for own's cards. */
function failed(reason: string, metadata: Record<string, unknown> = {}) {
  return text(`Error: ${reason}`, { ...metadata, isError: true })
}

/** The approval card's and the file card's entry (`FileDiff.Info`). */
function fileDiff(file: string, before: string, after: string, status: "added" | "modified") {
  const counts = diffLines(before, after).reduce(
    (sum, part) => ({
      additions: sum.additions + (part.added ? (part.count ?? 0) : 0),
      deletions: sum.deletions + (part.removed ? (part.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return { file, patch: createTwoFilesPatch(file, file, before, after), ...counts, status }
}
