// The `codex` harness's tools: Codex's exec_command, write_stdin, apply_patch, view_image and request_user_input
// (codex-rs/core/src/tools/handlers, rust-v0.162.1) as own plugin tools. Their definitions are the bytes Codex sends
// (codex-data/tools.<platform>.json, captured by script/codex-golden.ts). They ask own's permissions through P-019
// (`shell` for commands, `edit` with a diff for patches), so approval modes and approval cards work as for core tools.
// In read-only mode, which refuses every command, and in ask mode, which asks before each, exec_command answers simple
// reads itself under `read` rules, without an approval card (read-only.ts, 10 §3.10). Failures Codex reports to the
// model as text (`RespondToModel`) are answered as text too.
export * as CodexTools from "./tools.js"

import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect } from "effect"
import TOOLS_WIN32 from "../../codex-data/tools.win32.json" with { type: "json" }
import { Gate } from "../gate.js"
import { HarnessPermission } from "../permission.js"
import { ApplyPatch } from "./apply-patch/index.js"
import { Catalog } from "./catalog.js"
import { ExecLive } from "./exec/live.js"
import { ExecManager } from "./exec/manager.js"
import { HeadTail } from "./exec/buffer.js"
import { ExecOutput } from "./exec/output.js"
import { Fragments } from "./fragments.js"
import { Platform } from "./platform.js"
import { McpResources } from "./mcp-resources.js"
import { CodexReadOnly } from "./read-only.js"

type Ctx = Pick<Context, "tool" | "session" | "permission" | "shell" | "location">

interface Definition {
  readonly type: string
  readonly name?: string
  readonly description?: string
  readonly parameters?: Record<string, unknown>
}

/** Core tools Codex has no counterpart for or replaces with its own (exec_command, apply_patch, request_user_input). */
export const REPLACED = ["shell", "patch", "edit", "write", "read", "glob", "grep", "question", "skill", "webfetch"]

/** Codex's tool definitions for this OS (the Windows capture, without its Windows parts elsewhere). */
export const DEFINITIONS: ReadonlyArray<Definition> = Platform.value(TOOLS_WIN32.tools as ReadonlyArray<Definition>)

export function definition(name: string) {
  const found = DEFINITIONS.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`codex-data has no tool ${name}`)
  return found
}

/** apply_patch is a freeform tool in Codex; as a function tool its patch travels in `input` (P-020 sends it freeform). */
const APPLY_PATCH_INPUT = {
  type: "object",
  properties: { input: { type: "string", description: "The entire contents of the apply_patch command" } },
  required: ["input"],
  additionalProperties: false,
}

const VIEW_IMAGE_UNSUPPORTED = "view_image is not allowed because you do not support image inputs"
const VIEW_IMAGE_INVALID = "unable to process image: invalid or unsupported image data"
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

export const register = (ctx: Ctx, manager: ExecManager.Manager) =>
  Effect.gen(function* () {
    const borrowed: { question?: Tool.Info<any, any> } = {}
    const add = (
      name: string,
      input: unknown,
      execute: (raw: unknown, tool: Tool.Context) => Effect.Effect<Tool.Result, Tool.Error>,
    ) => {
      const spec = definition(name)
      return {
        name,
        description: spec.description ?? "",
        input: input as Record<string, unknown>,
        options: { codemode: false, permission: Gate.ACTION },
        execute,
      }
    }
    yield* ctx.tool.transform((editor) => {
      borrowed.question = editor.get("question")
      editor.add(
        add("exec_command", definition("exec_command").parameters, (raw, tool) => exec(ctx, manager, raw, tool)),
      )
      editor.add(
        add("write_stdin", definition("write_stdin").parameters, (raw, tool) => write(ctx, manager, raw, tool)),
      )
      editor.add(
        add("apply_patch", APPLY_PATCH_INPUT, (raw, tool) =>
          patch(ctx, String((raw as { input: string }).input), ctx.location.directory, tool),
        ),
      )
      editor.add(add("view_image", definition("view_image").parameters, (raw, tool) => viewImage(ctx, raw, tool)))
      editor.add(
        add("request_user_input", definition("request_user_input").parameters, (raw, tool) =>
          ask(ctx, borrowed.question, raw, tool),
        ),
      )
      // Codex's MCP resource tools; the request lists them only while MCP servers are configured (request.ts).
      McpResources.NAMES.forEach((name) =>
        editor.add({
          name,
          description: McpResources.DEFINITIONS[name]!.description,
          input: McpResources.DEFINITIONS[name]!.parameters as Record<string, unknown>,
          options: { codemode: false, permission: Gate.ACTION },
          execute: (raw: unknown, tool: Tool.Context) =>
            McpResources.run(ctx, name, raw, tool).pipe(Effect.map((outcome) => text(outcome.text))),
        }),
      )
      // Codex's hosted web search: the request hook sends Codex's definition (P-023) and the provider runs it.
      editor.add({
        name: "web_search",
        description: "Search the web. The model provider runs this tool.",
        input: { type: "object", properties: {} },
        options: { codemode: false, permission: Gate.ACTION },
        execute: () => Effect.succeed(text("web_search runs on the model provider and is not available here.")),
      })
    })
  })

/** Codex's hosted `web_search` definition (codex-data/tools.<platform>.json). */
export const WEB_SEARCH = DEFINITIONS.find((entry) => entry.type === "web_search")

const text = (content: string, metadata: Record<string, unknown> = {}): Tool.Result => ({
  content,
  metadata: { ...metadata, truncated: true },
})

/**
 * The session's model in the catalog (truncation policy, image input), own's approval mode, and whether exec_command
 * answers reads itself (read-only and ask, and a no-shell role such as `explore` in every mode,
 * CodexReadOnly.answers). A failed lookup serves nothing but such a role's reads.
 */
const sessionState = (ctx: Pick<Context, "session">, tool: Pick<Tool.Context, "sessionID" | "agent">) =>
  ctx.session.get({ sessionID: tool.sessionID }).pipe(
    Effect.map((info) => ({
      model: Catalog.lookup(info.model?.id ?? ""),
      mode: Fragments.mode(info.permissions, tool.agent),
      reads: CodexReadOnly.answers(info.permissions, tool.agent),
    })),
    Effect.orElseSucceed(() => ({
      model: Catalog.lookup(""),
      mode: Fragments.mode(undefined, tool.agent),
      reads: CodexReadOnly.answers(undefined, tool.agent),
    })),
  )

export interface ExecArgs {
  readonly cmd: string
  readonly workdir?: string
  readonly shell?: string
  readonly login?: boolean
  readonly tty?: boolean
  readonly yield_time_ms?: number
  readonly max_output_tokens?: number
  readonly sandbox_permissions?: string
  readonly justification?: string
}

/** What an exec_command call came to: a process result, or a text Codex answers instead (an error, an intercepted patch). */
export type ExecOutcome =
  | { readonly kind: "result"; readonly result: ExecOutput.Result }
  | { readonly kind: "text"; readonly text: string; readonly metadata?: Record<string, unknown> }

/**
 * exec_command without formatting, shared by the Direct tool and Code Mode's nested `tools.exec_command`. `terminated`
 * (nested calls only) ends the process when it aborts during the first collection (ExecManager `ExecRequest.signal`).
 */
export function runExec(
  ctx: Ctx,
  manager: ExecManager.Manager,
  args: ExecArgs,
  tool: Tool.Context,
  terminated?: AbortSignal,
) {
  return Effect.gen(function* () {
    if (args.justification !== undefined && args.sandbox_permissions === undefined)
      return {
        kind: "text",
        text: '`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.',
      } satisfies ExecOutcome
    const cwd = args.workdir ? path.resolve(ctx.location.directory, args.workdir) : ctx.location.directory
    const heredoc = ApplyPatch.extractHeredocPatch(args.cmd)
    if (heredoc !== undefined) {
      // Codex intercepts `apply_patch <<'EOF'` scripts and wraps the patch result in an exec result.
      const result = yield* patch(ctx, heredoc.patch, heredoc.workdir ? path.resolve(cwd, heredoc.workdir) : cwd, tool)
      return {
        kind: "text",
        text: `Wall time: 0.0000 seconds\nOutput:\n${result.content}`,
        metadata: result.metadata,
      } satisfies ExecOutcome
    }
    const shell = ExecManager.resolveShell(args.shell)
    const state = yield* sessionState(ctx, tool)
    const read = state.reads ? CodexReadOnly.parse(args.cmd, shell.type) : undefined
    const started = Date.now()
    const done = read === undefined ? undefined : yield* CodexReadOnly.run(ctx, read, { cwd, tool })
    if (done !== undefined) {
      // Collected like a process's output (1 MiB head and tail), then formatted as a finished command.
      const collected = new HeadTail.Buffer()
      collected.push(new TextEncoder().encode(done.output))
      const result: ExecOutput.Result = {
        chunkID: ExecOutput.chunkID(),
        wallTimeMs: Date.now() - started,
        raw: new TextDecoder().decode(collected.bytesWithOmissionMarker()),
        omittedBytes: collected.omittedBytes,
        originalTokenCount: Math.ceil(collected.totalBytes / 4),
        exitCode: done.exitCode,
        maxOutputTokens: args.max_output_tokens,
        policy: state.model.truncation_policy,
      }
      return { kind: "result", result } satisfies ExecOutcome
    }
    const approval = yield* ctx.shell.authorize({ command: args.cmd, cwd, shell: shell.path }, tool).pipe(
      Effect.map((approved) => ({ ok: true as const, cwd: approved.cwd })),
      // A read-only session or a no-shell role tells the model what it can still do instead of a bare rule deny. A
      // declined card (with or without a note), a deny in ask mode and other failures stay as they are.
      Effect.catch((error) =>
        state.reads && state.mode === "read-only" && CodexReadOnly.blocked(error)
          ? Effect.succeed({ ok: false as const, reason: error.message })
          : Effect.fail(error),
      ),
    )
    if (!approval.ok)
      return { kind: "text", text: CodexReadOnly.refused(approval.reason, tool.agent) } satisfies ExecOutcome
    // The card shows the output while the command runs; the model gets the collection's result alone.
    return yield* ExecLive.watch(tool.progress, { command: args.cmd }, (onOutput) =>
      Effect.tryPromise({
        try: () =>
          manager.execResult(tool.sessionID, {
            command: args.cmd,
            cwd: approval.cwd,
            shell,
            login: args.login ?? true,
            tty: args.tty ?? false,
            yieldTimeMs: args.yield_time_ms ?? 10_000,
            maxOutputTokens: args.max_output_tokens,
            policy: state.model.truncation_policy,
            onOutput,
            signal: terminated,
          }),
        catch: (error) => error,
      }),
    ).pipe(
      Effect.map((result): ExecOutcome => ({ kind: "result", result })),
      Effect.catch((error) =>
        Effect.succeed<ExecOutcome>({
          kind: "text",
          text: `exec_command failed: CreateProcess { message: ${JSON.stringify(error instanceof Error ? error.message : String(error))} }`,
        }),
      ),
    )
  })
}

function exec(ctx: Ctx, manager: ExecManager.Manager, raw: unknown, tool: Tool.Context) {
  return Effect.gen(function* () {
    const args = raw as ExecArgs
    const outcome = yield* runExec(ctx, manager, args, tool)
    if (outcome.kind === "text") return text(outcome.text, { ...outcome.metadata, command: args.cmd })
    // The shell card marks a non-zero `exit` as failed (session-ui `currentToolFailed`).
    const exit = outcome.result.exitCode
    return text(ExecOutput.text(outcome.result), { command: args.cmd, ...(exit === undefined ? {} : { exit }) })
  })
}

export interface WriteArgs {
  readonly session_id: number
  readonly chars?: string
  readonly yield_time_ms?: number
  readonly max_output_tokens?: number
}

/**
 * write_stdin without formatting, shared by the Direct tool and Code Mode's nested `tools.write_stdin`. Read-only mode
 * starts no process, so any process it finds was started before the switch: it gets no input, and its output is not
 * read either.
 */
export function runWrite(
  ctx: Pick<Context, "session">,
  manager: ExecManager.Manager,
  args: WriteArgs,
  tool: Tool.Context,
) {
  return Effect.gen(function* () {
    const state = yield* sessionState(ctx, tool)
    if (state.mode === "read-only")
      return {
        kind: "text",
        text: "write_stdin failed: in read-only approval mode own sends no input to processes started before the switch and reads none of their output",
      } satisfies ExecOutcome
    return yield* ExecLive.watch(tool.progress, { session: args.session_id }, (onOutput) =>
      Effect.tryPromise({
        try: () =>
          manager.writeResult(tool.sessionID, {
            id: args.session_id,
            chars: args.chars ?? "",
            yieldTimeMs: args.yield_time_ms ?? 250,
            maxOutputTokens: args.max_output_tokens,
            policy: state.model.truncation_policy,
            onOutput,
          }),
        catch: (error) => error,
      }),
    ).pipe(
      Effect.map((result): ExecOutcome => ({ kind: "result", result })),
      Effect.catch((error) =>
        Effect.succeed<ExecOutcome>({
          kind: "text",
          text: `write_stdin failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      ),
    )
  })
}

function write(ctx: Ctx, manager: ExecManager.Manager, raw: unknown, tool: Tool.Context) {
  return Effect.gen(function* () {
    const args = raw as WriteArgs
    const outcome = yield* runWrite(ctx, manager, args, tool)
    return text(outcome.kind === "text" ? outcome.text : ExecOutput.text(outcome.result), { session: args.session_id })
  })
}

/**
 * apply_patch: Codex's verification (parse and derive every change), one `edit` permission with the diff for the
 * approval card (external paths ask `external_directory` first), then the patch. Success and failure texts are
 * Codex's, wrapped like its one-shot exec output.
 */
export function patch(ctx: Pick<Context, "permission">, input: string, cwd: string, tool: Tool.Context) {
  return Effect.gen(function* () {
    const started = Date.now()
    const derived = yield* Effect.tryPromise({
      try: () => ApplyPatch.derivePatch(input, cwd),
      catch: (error) => error,
    }).pipe(
      Effect.map((changes) => ({ ok: true as const, changes })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: errorText(error) })),
    )
    if (!derived.ok) return text(`apply_patch verification failed: ${derived.message}`)
    const touched = derived.changes.flatMap((change) =>
      change.kind === "update" && change.movePath !== undefined ? [change.path, change.movePath] : [change.path],
    )
    const resolved = yield* ctx.permission.paths({ paths: touched, kind: "file" }, tool)
    const resource = (absolute: string) =>
      resolved.find((entry) => entry.absolute === path.resolve(absolute))?.resource ?? absolute
    const files = derived.changes.map((change) => fileDiff(change, resource))
    yield* HarnessPermission.assert(
      ctx,
      {
        action: "edit",
        resources: [...new Set(touched.map(resource))],
        save: ["*"],
        metadata: {
          filepath: files.map((file) => file.file).join(", "),
          diff: files.map((file) => `${file.patch}\n`).join(""),
          files,
        },
      },
      tool,
    )
    const applied = yield* Effect.tryPromise({
      try: () => ApplyPatch.applyPatch(input, cwd),
      catch: (error) => error,
    }).pipe(
      Effect.map((result) => ({ ok: true as const, text: result.text })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: errorText(error) })),
    )
    const seconds = Math.round((Date.now() - started) / 100) / 10
    if (!applied.ok)
      return text(`Exit code: 1\nWall time: ${seconds} seconds\nOutput:\n${applied.message}\n`, { files })
    return text(`Exit code: 0\nWall time: ${seconds} seconds\nOutput:\n${applied.text}`, { files })
  })
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** The approval card's and the patch renderer's file entry (`FileDiff.Info`). */
function fileDiff(change: ApplyPatch.DerivedChange, resource: (absolute: string) => string) {
  const before = change.kind === "add" ? "" : change.oldContent
  const after = change.kind === "delete" ? "" : change.newContent
  const file = resource(change.kind === "update" && change.movePath !== undefined ? change.movePath : change.path)
  const counts = diffLines(before, after).reduce(
    (sum, part) => ({
      additions: sum.additions + (part.added ? (part.count ?? 0) : 0),
      deletions: sum.deletions + (part.removed ? (part.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return {
    file,
    patch: createTwoFilesPatch(file, file, before, after),
    ...counts,
    status: change.kind === "add" ? "added" : change.kind === "delete" ? "deleted" : "modified",
  }
}

/**
 * view_image, shared by the Direct tool and Code Mode's nested `tools.view_image`. The image is a file read like any
 * other: `read` is asked at its path and its real path (protected paths stay denied), `external_directory` outside.
 */
export function viewImage(ctx: Pick<Context, "session" | "location" | "permission">, raw: unknown, tool: Tool.Context) {
  return Effect.gen(function* () {
    const args = raw as { readonly path: string; readonly detail?: string }
    const model = (yield* sessionState(ctx, tool)).model
    if (model.known && !model.input_modalities?.includes("image")) return text(VIEW_IMAGE_UNSUPPORTED)
    if (args.detail !== undefined && args.detail !== "high" && args.detail !== "original")
      return text(
        `view_image.detail only supports \`high\` or \`original\`; omit \`detail\` for default high resized behavior, got \`${args.detail}\``,
      )
    const file = path.resolve(ctx.location.directory, args.path)
    const [checked] = yield* CodexReadOnly.readable(ctx, [file], "file", tool)
    const real = checked!.real
    const info = real === undefined ? undefined : yield* Effect.promise(() => stat(real).catch(() => undefined))
    if (real === undefined || info === undefined)
      return text(`unable to locate image at \`${file}\`: No such file or directory (os error 2)`)
    if (!info.isFile()) return text(`image path \`${file}\` is not a file`)
    const bytes = yield* Effect.tryPromise(() => readFile(real)).pipe(Effect.option)
    if (bytes._tag === "None") return text(`unable to read image at \`${file}\`: permission denied`)
    const mime = IMAGE_TYPES[path.extname(file).toLowerCase()]
    if (mime === undefined) return text(VIEW_IMAGE_INVALID)
    return {
      content: [
        {
          type: "file" as const,
          mime,
          uri: `data:${mime};base64,${bytes.value.toString("base64")}`,
          name: path.basename(file),
        },
      ],
      metadata: { path: file, truncated: true },
    }
  })
}

interface QuestionArgs {
  readonly questions: ReadonlyArray<{
    readonly id: string
    readonly header: string
    readonly question: string
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description: string }>
  }>
}

/**
 * request_user_input: Codex offers it only in Plan mode (own's plan agent); elsewhere it answers Codex's refusal. The
 * questions go through core's question tool (borrowed), and the answers come back as Codex's JSON.
 */
function ask(ctx: Ctx, question: Tool.Info<any, any> | undefined, raw: unknown, tool: Tool.Context) {
  return Effect.gen(function* () {
    const args = raw as QuestionArgs
    if (tool.agent !== "plan") return text("request_user_input is unavailable in Default mode")
    const info = yield* ctx.session.get({ sessionID: tool.sessionID }).pipe(Effect.option)
    if (info._tag === "Some" && info.value.parentID !== undefined)
      return text("request_user_input can only be used by the root thread")
    if (args.questions.some((entry) => (entry.options ?? []).length === 0))
      return text("request_user_input requires non-empty options for every question")
    if (question === undefined) return text("request_user_input was cancelled before receiving a response")
    const result = yield* question.execute(
      {
        questions: args.questions.map((entry) => ({
          question: entry.question,
          header: entry.header,
          options: (entry.options ?? []).map((option) => ({ label: option.label, description: option.description })),
        })),
      },
      tool,
    )
    const answers = (
      (result.output as { answers?: ReadonlyArray<ReadonlyArray<string>> } | undefined)?.answers ?? []
    ).map((entry) => [...entry])
    const response = {
      answers: Object.fromEntries(args.questions.map((entry, index) => [entry.id, { answers: answers[index] ?? [] }])),
    }
    return { content: JSON.stringify(response), metadata: { answers, truncated: true } }
  })
}
