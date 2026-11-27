export * as WorktreeChatTools from "./tools.js"

import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Result, Schema, SchemaIssue, type JsonSchema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Git } from "../git/run.js"
import type { Log } from "../log.js"
import type { Services } from "../services.js"
import { WorktreeChats } from "./chats.js"
import { WorktreeChatIntegrate } from "./integrate.js"

/**
 * The worktree conversation tools (06 §13.3), namespace `worktree` (core names them `worktree_<name>`), Code Mode
 * tools like the team's: the request's tool definitions keep only Code Mode's `execute` (Codex's `exec` nests them as
 * `tools.worktree__<name>`), so every harness reaches them the same way and the cached prefix keeps its tools; the
 * catalog changes once for existing conversations (one instruction delta). Visible in every conversation; a subagent
 * is refused. `start` is pinned, so it is always listed in the catalog. Inputs are plain JSON Schema (a bundle's Effect
 * schemas cannot run in the host) and are decoded again here.
 */

export const NAMESPACE = "worktree"

/**
 * Kept short: the Code Mode catalog shows the namespace description whole and each tool's first line, within one
 * inline budget for every tool of the conversation (2,000 tokens, core `codemode/catalog.ts`); past it the catalog turns
 * partial for every conversation (TG16 found that with the first, longer texts).
 */
export const DESCRIPTION =
  "To work in a worktree, start a new conversation there (start; several run in parallel); you are told when each ends. Then send, integrate (asks the user first), cleanup. move only when the user asks to move this conversation."

const Task = Schema.Struct({
  name: Schema.String.annotate({ description: "kebab-case; the folder and branch name" }),
  task: Schema.String.annotate({ description: "self-contained brief: goal, context, what done means" }),
  title: Schema.optional(Schema.String),
})

const StartInput = Schema.Struct({
  tasks: Schema.Array(Task).check(Schema.isMinLength(1), Schema.isMaxLength(WorktreeChats.MAX_TASKS)),
  base: Schema.optional(Schema.String),
})

const SendInput = Schema.Struct({ session: Schema.String, message: Schema.String })

const IntegrateInput = Schema.Struct({ session: Schema.String, undo: Schema.optional(Schema.Boolean) })

const CleanupInput = Schema.Struct({ session: Schema.String, delete_branch: Schema.optional(Schema.Boolean) })

const MoveInput = Schema.Struct({ name: Schema.String, base: Schema.optional(Schema.String) })

/** The answer is its text (the catalog shows `Promise<string>`). */
const OUTPUT: JsonSchema.JsonSchema = { type: "string" }

type Ctx = Pick<Plugin.Context, "tool" | "worktree" | "location" | "permission" | "session">
type Reply = { readonly ok: boolean; readonly text: string; readonly [key: string]: unknown }

interface Definition {
  readonly name: string
  readonly description: string
  readonly input: JsonSchema.JsonSchema
  readonly pinned: boolean
  readonly execute: (raw: unknown, call: ToolContext) => Promise<Reply>
}

function tool<S extends Schema.ConstraintDecoder<unknown>>(input: {
  readonly name: string
  readonly description: string
  readonly schema: S
  readonly pinned?: boolean
  readonly run: (value: S["Type"], call: ToolContext) => Promise<Reply>
}): Definition {
  const decode = Schema.decodeUnknownResult(input.schema)
  return {
    name: input.name,
    description: input.description,
    input: Schema.toJsonSchemaDocument(input.schema, { onExcessProperty: "error" }).schema,
    pinned: input.pinned ?? false,
    execute: async (raw, call) => {
      const decoded = decode(raw)
      if (Result.isFailure(decoded))
        return { ok: false, text: `입력이 올바르지 않아요: ${SchemaIssue.makeFormatterDefault()(decoded.failure.issue)}` }
      return input.run(decoded.success, call)
    },
  }
}

export function definitions(services: Services.Context, ctx: Ctx): ReadonlyArray<Definition> {
  return [
    tool({
      name: "start",
      description:
        "New worktree + branch + conversation per task (this one's model, harness, approval); the brief is its first message.",
      schema: StartInput,
      pinned: true,
      run: async (value, call) => {
        if (!(await services.ready(WRITE_WAIT_MS))) return busy()
        return WorktreeChats.start(services, ctx, { parentID: call.sessionID, tasks: value.tasks, base: value.base })
      },
    }),
    tool({
      name: "status",
      description:
        "The worktree conversations you started: state, branch, folder, start of the last answer.",
      schema: Schema.Struct({}),
      run: async (_value, call) => {
        const listed = await WorktreeChats.list(services, call.sessionID)
        if (listed.items.length === 0) return { ok: true, text: "이 대화가 시작한 작업 폴더 대화가 없어요." }
        return {
          ok: true,
          text: listed.items
            .map(
              (item) =>
                `- ${item.title} [${item.state}] 대화 ${item.sessionID}, 브랜치 ${item.branch} → ${item.base.branch ?? item.base.commit.slice(0, 12)}, 폴더 ${item.directory}${item.summary ? `\n  마지막 답: ${item.summary.slice(0, 300)}` : ""}`,
            )
            .join("\n"),
        }
      },
    }),
    tool({
      name: "send",
      description:
        "Send a follow-up to a worktree conversation you started; you are told when it ends.",
      schema: SendInput,
      run: async (value, call) => {
        if (!(await services.ready(WRITE_WAIT_MS))) return busy()
        const owned = await WorktreeChatIntegrate.owned(services, call.sessionID, value.session, false)
        if (!owned.ok) return owned
        const sent = await services.http.session.prompt({
          sessionID: owned.record.sessionID,
          directory: owned.record.directory,
          text: `[원래 대화에서] ${value.message}`,
          metadata: { [OwnTeam.WORKTREE_CHAT_META]: { from: call.sessionID } },
        })
        if (!sent.ok) return { ok: false, text: `보내지 못했어요: ${sent.message}` }
        return { ok: true, text: `"${owned.record.title}"에 보냈어요.` }
      },
    }),
    tool({
      name: "integrate",
      description:
        "Merge its branch into the base branch after the user approves (never pushes); undo: true reverts it.",
      schema: IntegrateInput,
      run: async (value, call) => {
        if (!(await services.ready(WRITE_WAIT_MS))) return busy()
        return WorktreeChatIntegrate.integrate(services, ctx, call, value)
      },
    }),
    tool({
      name: "cleanup",
      description:
        "Remove its worktree after asking the user; never with uncommitted changes. The branch stays unless delete_branch.",
      schema: CleanupInput,
      run: async (value, call) => {
        if (!(await services.ready(WRITE_WAIT_MS))) return busy()
        return WorktreeChatIntegrate.cleanup(services, ctx, call, {
          session: value.session,
          deleteBranch: value.delete_branch,
        })
      },
    }),
    tool({
      name: "move",
      description:
        "Only if the user asks: move THIS conversation into a new worktree and branch.",
      schema: MoveInput,
      run: async (value, call) => move(services, ctx, call, value),
    }),
  ]
}

const WRITE_WAIT_MS = 10_000

function busy(): Reply {
  return { ok: false, text: "다른 프로세스가 own 서비스를 잡고 있어 지금은 기록할 수 없어요. 잠시 뒤 다시 하세요." }
}

async function move(
  services: Services.Context,
  ctx: Ctx,
  call: ToolContext,
  value: { readonly name: string; readonly base?: string },
): Promise<Reply> {
  const session = await services.http.session.get({ sessionID: call.sessionID, directory: ctx.location.directory })
  if (!session.ok) return { ok: false, text: `이 대화를 읽지 못했어요: ${session.message}` }
  if (session.value.parentID !== undefined) return { ok: false, text: "하위 에이전트는 옮길 수 없어요." }
  const base = await WorktreeChats.baseOf(session.value.location.directory, value.base)
  if (!base.ok) return { ok: false, text: base.text }
  const name = WorktreeChats.slug(value.name)
  const created = await ctx.worktree
    .create({ projectID: ctx.location.project.id, name, branch: base.commit })
    .then((result) => ({ ok: true as const, directory: result.directory }))
    .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error) }))
  if (!created.ok) return { ok: false, text: `작업 폴더를 만들지 못했어요: ${created.message}` }
  const branch = await WorktreeChats.freeBranch(created.directory, name)
  const switched = await Git.run(["switch", "-c", branch], { cwd: created.directory, worktree: true, write: true })
  if (!switched.ok) return { ok: false, text: `브랜치를 만들지 못했어요: ${switched.message}` }
  await ctx.session.move({ sessionID: call.sessionID, directory: created.directory, delivery: "steer" })
  return {
    ok: true,
    text: `작업 폴더 ${created.directory}(브랜치 ${branch})를 만들었어요. 이 대화는 다음 단계부터 그 폴더에서 일해요: 같은 execute 안에서 그 폴더에 기대는 일을 하지 마세요.`,
  }
}

/** Registers the namespace and the tools in this Location; returns the registration. */
export function register(input: { readonly ctx: Ctx; readonly services: Services.Context; readonly log: Log.Logger }) {
  const tools = definitions(input.services, input.ctx)
  return input.ctx.tool.transform((editor) => {
    editor.namespace({ name: NAMESPACE, description: DESCRIPTION })
    for (const definition of tools)
      editor.add({
        name: definition.name,
        description: definition.description,
        input: definition.input,
        output: OUTPUT,
        options: { namespace: NAMESPACE, codemode: true, pinned: definition.pinned },
        execute: async (raw: unknown, call) => {
          const reply = await definition.execute(raw, call).catch((error: unknown) => {
            // A user's rejection of the approval ends the step: rethrown, as core's own tools do.
            if (rejection(error)) throw error
            input.log.warn("worktree_tool_failed", { tool: definition.name, error })
            return { ok: false, text: `작업 폴더 도구를 실행하지 못했어요: ${error instanceof Error ? error.message : String(error)}` }
          })
          return { output: reply.text, content: reply.text }
        },
      })
  })
}

/** A permission denial or rejection from `ctx.permission.assert` (core's Permission errors and `Tool.Error`). */
function rejection(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const tag = "_tag" in error ? error._tag : undefined
  return typeof tag === "string" && (tag.startsWith("Permission.") || tag === "Tool.Error")
}
