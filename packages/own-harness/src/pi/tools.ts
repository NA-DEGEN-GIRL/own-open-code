// The `pi` harness's tools: Pi's read, bash, edit and write (read.ts, bash.ts, edit.ts, write.ts) as own plugin tools.
// They register under internal names (`pi_read`, …) because core's own `read`, `edit` and `write` keep theirs for the
// other harnesses; the pi request lists them under Pi's names and core maps the calls back (request.ts). They are
// listed only in pi sessions (`Gate.PI_ACTION`) and ask own's permissions through P-019 as core's tools do: `read` for
// reads, `edit` with the diff for edits and writes (`external_directory` first outside the Location), and the shell
// approval for commands; in read-only and ask mode, and for the `explore` role in every mode, bash answers simple reads
// itself (CodexReadOnly, 12 §3.5). Pi's failures (thrown errors, a failing command) answer the model with Pi's text as
// the result: core sends a tool error as a JSON envelope, which would change the text Pi's model reads.
export * as PiTools from "./tools.js"

import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Semaphore } from "effect"
import { GitHubBridge } from "@own/runtime"
import { CodexReadOnly } from "../codex/read-only.js"
import { Fragments } from "../codex/fragments.js"
import { Gate } from "../gate.js"
import { HarnessPermission } from "../permission.js"
import { PiArgs } from "./args.js"
import { PiBash } from "./bash.js"
import { PiEdit } from "./edit.js"
import { PiPaths } from "./paths.js"
import { PiRead } from "./read.js"
import { PiShell } from "./shell.js"
import { PiWrite } from "./write.js"

type Ctx = Pick<Context, "tool" | "session" | "permission" | "shell" | "location" | "model">

/** Pi's tool name → the name it registers under. */
export const INTERNAL: Readonly<Record<string, string>> = {
  read: "pi_read",
  bash: "pi_bash",
  edit: "pi_edit",
  write: "pi_write",
}

export const register = (ctx: Ctx) =>
  Effect.gen(function* () {
    // Pi's file mutation queue: edits and writes of one file run one at a time, other files in parallel.
    const locks = new Map<string, Semaphore.Semaphore>()
    const add = (
      name: string,
      description: string,
      schema: PiArgs.ObjectSchema,
      execute: (raw: unknown, call: Tool.Context) => Effect.Effect<Tool.Result, Tool.Error>,
    ) => ({
      name: INTERNAL[name]!,
      description,
      input: PiArgs.standard(schema),
      options: { codemode: false, permission: Gate.PI_ACTION },
      execute,
    })
    yield* ctx.tool.transform((editor) => {
      editor.add(add(PiRead.NAME, PiRead.DESCRIPTION, PiRead.SCHEMA, (raw, call) => read(ctx, raw, call)))
      editor.add(add(PiBash.NAME, PiBash.DESCRIPTION, PiBash.SCHEMA, (raw, call) => bash(ctx, raw, call)))
      editor.add(add(PiEdit.NAME, PiEdit.DESCRIPTION, PiEdit.SCHEMA, (raw, call) => edit(ctx, locks, raw, call)))
      editor.add(add(PiWrite.NAME, PiWrite.DESCRIPTION, PiWrite.SCHEMA, (raw, call) => write(ctx, locks, raw, call)))
    })
  })

function read(ctx: Ctx, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const args = PiArgs.check<PiRead.Input>(PiRead.NAME, PiRead.SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    const absolute = yield* Effect.promise(() => PiPaths.resolveReadPath(args.value.path, ctx.location.directory))
    const [target] = yield* ctx.permission.paths({ paths: [absolute], kind: "file" }, call)
    yield* HarnessPermission.assert(ctx, { action: "read", resources: [target!.resource], save: ["*"] }, call)
    const vision = yield* acceptsImages(ctx, call.sessionID)
    const done = yield* attempt((signal) => PiRead.execute(args.value, absolute, { vision, signal }))
    if (!done.ok) return failed(done.message)
    return {
      content: done.value.content.map(
        (item): Tool.Content =>
          item.type === "text"
            ? item
            : {
                type: "file",
                mime: item.mimeType,
                uri: `data:${item.mimeType};base64,${item.data}`,
                name: path.basename(absolute),
              },
      ),
      metadata: { path: absolute, truncated: done.value.details?.truncation.truncated ?? false },
    }
  })
}

function bash(ctx: Ctx, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const args = PiArgs.check<PiBash.Input>(PiBash.NAME, PiBash.SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    const command = args.value.command
    // Read-only and ask mode, and the `explore` role in every mode, answer simple reads without a process or a card
    // (12 §3.5, Codex's read-only reads of 10 §3.10 in bash's shapes).
    const state = yield* readState(ctx, call)
    const intent = state.reads ? CodexReadOnly.parse(command, "bash") : undefined
    const served =
      intent === undefined
        ? undefined
        : yield* CodexReadOnly.run(ctx, intent, { cwd: ctx.location.directory, tool: call })
    if (served !== undefined)
      return result(yield* Effect.promise(() => PiBash.answered(served.output, served.exitCode)), command)
    const shell = yield* Effect.try({ try: () => PiShell.bashConfig(), catch: (error) => error }).pipe(Effect.result)
    if (shell._tag === "Failure") return failed(message(shell.failure), { command })
    const approval = yield* ctx.shell
      .authorize({ command, cwd: ctx.location.directory, shell: shell.success.shell }, call)
      .pipe(
        Effect.map((approved) => ({ ok: true as const, cwd: approved.cwd })),
        // A refusal in read-only mode or for a no-shell role says which reads own still answers instead of a bare
        // rule deny; a declined card, a deny in ask mode and other failures stay as they are.
        Effect.catch((error) =>
          state.reads && state.mode === "read-only" && CodexReadOnly.blocked(error)
            ? Effect.succeed({ ok: false as const, reason: error.message })
            : Effect.fail(error),
        ),
      )
    if (!approval.ok) return failed(CodexReadOnly.refusedBash(approval.reason, call.agent), { command })
    const env = yield* sessionEnvironment(ctx, call.sessionID)
    // git's logins for the GitHub account the conversation uses (16 §6), when own has one for it; they end with the
    // command.
    const login = new AbortController()
    const spawned = Promise.withResolvers<number | undefined>()
    const github = yield* Effect.promise(() =>
      GitHubBridge.gitEnv(approval.cwd, { sessionID: call.sessionID, signal: login.signal, pid: spawned.promise }),
    )
    const done = yield* Effect.tryPromise({
      try: (signal) =>
        PiBash.execute(args.value, {
          cwd: approval.cwd,
          env: { ...env, ...github },
          signal,
          shell: shell.success,
          onSpawn: spawned.resolve,
        }).finally(() => {
          spawned.resolve(undefined)
          login.abort()
        }),
      catch: (error) => error,
    }).pipe(Effect.result)
    if (done._tag === "Failure") return failed(message(done.failure), { command })
    return result(done.success, command)
  })
}

/** A bash result for the model and the shell card (session-ui `shellResultFailed` marks a non-zero `exit` failed). */
function result(done: PiBash.Result, command: string) {
  return text(done.text, {
    command,
    exit: done.exitCode,
    truncated: done.truncation?.truncated ?? false,
    ...(done.fullOutputPath === undefined ? {} : { outputPath: done.fullOutputPath }),
    ...(done.isError ? { isError: true } : {}),
  })
}

/**
 * own's approval mode and whether bash answers reads itself (CodexReadOnly.answers: read-only and ask with own's
 * protected denies, and a no-shell role such as `explore` in every mode). A failed lookup serves only such a role.
 */
function readState(ctx: Pick<Context, "session">, call: Tool.Context) {
  return ctx.session.get({ sessionID: call.sessionID }).pipe(
    Effect.map((info) => ({
      mode: Fragments.mode(info.permissions, call.agent),
      reads: CodexReadOnly.answers(info.permissions, call.agent),
    })),
    Effect.orElseSucceed(() => ({
      mode: Fragments.mode(undefined, call.agent),
      reads: CodexReadOnly.answers(undefined, call.agent),
    })),
  )
}

function edit(ctx: Ctx, locks: Map<string, Semaphore.Semaphore>, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    // Core repairs the input against this tool's schema, not core `edit`'s, though the call is named `edit` (P-028).
    const args = PiArgs.check<PiEdit.Input>(PiEdit.NAME, PiEdit.SCHEMA, PiEdit.prepareArguments(raw))
    if (!args.ok) return failed(args.message)
    const absolute = PiPaths.resolveToCwd(args.value.path, ctx.location.directory)
    const [target] = yield* ctx.permission.paths({ paths: [absolute], kind: "file" }, call)
    return yield* serialized(
      locks,
      absolute,
      Effect.gen(function* () {
        const planned = yield* attempt(() => PiEdit.plan(args.value, absolute))
        if (!planned.ok) return failed(planned.message)
        const file = fileDiff(target!.resource, planned.value.baseContent, planned.value.newContent, "modified")
        yield* approveEdit(ctx, file, call)
        const done = yield* attempt(() => PiEdit.commit(args.value, absolute, planned.value))
        if (!done.ok) return failed(done.message)
        return text(done.value.text, {
          files: [file],
          diff: done.value.details.diff,
          firstChangedLine: done.value.details.firstChangedLine,
        })
      }),
    )
  })
}

function write(ctx: Ctx, locks: Map<string, Semaphore.Semaphore>, raw: unknown, call: Tool.Context) {
  return Effect.gen(function* () {
    const args = PiArgs.check<PiWrite.Input>(PiWrite.NAME, PiWrite.SCHEMA, raw)
    if (!args.ok) return failed(args.message)
    const absolute = PiPaths.resolveToCwd(args.value.path, ctx.location.directory)
    const [target] = yield* ctx.permission.paths({ paths: [absolute], kind: "file" }, call)
    return yield* serialized(
      locks,
      absolute,
      Effect.gen(function* () {
        // Pi writes without reading; the current content only feeds own's approval card and file card.
        const before = yield* Effect.promise(() => readFile(absolute, "utf-8").catch(() => undefined))
        const file = fileDiff(
          target!.resource,
          before ?? "",
          args.value.content,
          before === undefined ? "added" : "modified",
        )
        yield* approveEdit(ctx, file, call)
        const done = yield* attempt(() => PiWrite.execute(args.value, absolute))
        if (!done.ok) return failed(done.message)
        return text(done.value, { files: [file] })
      }),
    )
  })
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

/** Runs `effect` holding the file's lock (Pi's `withFileMutationQueue`, keyed by the real path). */
function serialized<A, E, R>(locks: Map<string, Semaphore.Semaphore>, file: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const key = yield* Effect.promise(() => realpath(file).catch(() => path.resolve(file)))
    const lock = locks.get(key) ?? Semaphore.makeUnsafe(1)
    locks.set(key, lock)
    return yield* lock.withPermits(1)(effect)
  })
}

/** Pi's PI_* variables for the session's model, replacing any the server inherited. */
function sessionEnvironment(ctx: Pick<Context, "session">, sessionID: Tool.Context["sessionID"]) {
  return ctx.session.get({ sessionID }).pipe(
    Effect.map((info) => info.model),
    Effect.orElseSucceed(() => undefined),
    Effect.map((model): NodeJS.ProcessEnv => {
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"].includes(key),
        ),
      )
      return {
        ...inherited,
        PI_SESSION_ID: sessionID,
        ...(model === undefined ? {} : { PI_PROVIDER: model.providerID, PI_MODEL: model.id }),
      }
    }),
  )
}

/** Whether the session's model takes images (Pi adds a note to an image it reads for a model that does not). */
function acceptsImages(ctx: Pick<Context, "session" | "model">, sessionID: Tool.Context["sessionID"]) {
  return Effect.gen(function* () {
    const info = yield* ctx.session.get({ sessionID })
    const list = yield* ctx.model.list()
    const model = list.data.find((entry) => entry.providerID === info.model?.providerID && entry.id === info.model?.id)
    return model?.capabilities.input.includes("image") ?? true
  }).pipe(Effect.orElseSucceed(() => true))
}

function attempt<A>(run: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, message: message(error) })),
  )
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function text(content: string, metadata: Record<string, unknown> = {}): Tool.Result {
  return { content, metadata: { truncated: false, ...metadata } }
}

/** A failure Pi reports to the model (`isError`), answered with Pi's text. */
function failed(content: string, metadata: Record<string, unknown> = {}) {
  return text(content, { ...metadata, isError: true })
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
