// The session todo list OpenCode 1 kept and OpenCode 2 has no tool for (15 §3.6): omo's continuation reads it
// (`client.session.todo`) and its agents write it with `todowrite`. The tool's description is OpenCode 1's own,
// packages/opencode/src/tool/todowrite.txt at 7feefb697f^ (sst/opencode, MIT, Copyright (c) 2025 opencode); omo's
// `todo-description-override` hook replaces it through `tool.definition` in omo sessions (hooks.ts).
export * as Todos from "./todo.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { Names } from "./names.js"

export const NAME = "todowrite"
export const REGISTERED = `${Names.TOOL_PREFIX}${NAME}`

const STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
const PRIORITIES = ["high", "medium", "low"] as const

export const Item = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.String,
  status: Schema.Literals(STATUSES),
  priority: Schema.Literals(PRIORITIES),
})
export type Item = typeof Item.Type
const List = Schema.Array(Item)
const decodeInput = Schema.decodeUnknownOption(Schema.Struct({ todos: List }))
const decodeList = Schema.decodeUnknownOption(List)

export const DESCRIPTION = `Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.

## When to use
Use proactively when:
- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)
- The work is non-trivial and benefits from planning
- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list
- New instructions arrive - capture them as todos
- You start a task - mark it \`in_progress\` (only one at a time) before working
- You finish a task - mark it \`completed\` and add any follow-ups discovered during the work

## When NOT to use
Skip when:
- The work is a single, straightforward task (or <3 trivial steps)
- The request is purely informational or conversational
- Tracking adds no organizational value

## States
- \`pending\` - not started
- \`in_progress\` - actively working (exactly ONE at a time)
- \`completed\` - finished successfully
- \`cancelled\` - no longer needed

## Rules
- Update status in real time; don't batch completions
- Mark \`completed\` only after the required work is actually done, including any required verification. Never based on intent.
- Keep exactly one \`in_progress\` while work remains
- If blocked or partial, keep it \`in_progress\` and add a follow-up todo describing the blocker
- Preserve user-provided commands verbatim (flags, args, order)
- Items should be specific and actionable; break large work into smaller steps

## Examples

Use it:
- "Add a dark mode toggle and run the tests" -> multi-step feature + explicit verification
- "Rename getCwd -> getCurrentWorkingDirectory across the repo" -> grep reveals 15 occurrences in 8 files
- "Implement registration, catalog, cart, checkout" -> multiple complex features

Skip it:
- "How do I print Hello World in Python?" -> informational
- "Add a comment to calculateTotal" -> single edit
- "Run npm install and tell me what happened" -> one command

When in doubt, use it.
`

export const SCHEMA = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The updated todo list",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional stable id of the task" },
          content: { type: "string", description: "Brief description of the task" },
          status: {
            type: "string",
            enum: [...STATUSES],
            description: "Current status of the task: pending, in_progress, completed, cancelled",
          },
          priority: { type: "string", enum: [...PRIORITIES], description: "Priority level of the task: high, medium, low" },
        },
        required: ["content", "status", "priority"],
      },
    },
  },
  required: ["todos"],
} as const

const key = (sessionID: string) => `omo/todo/${sessionID}`

export class Store {
  constructor(private readonly ctx: Pick<Context, "storage">) {}

  get(sessionID: string): Effect.Effect<ReadonlyArray<Item>> {
    return this.ctx.storage
      .get(key(sessionID))
      .pipe(Effect.map((value) => Option.getOrElse(decodeList(value), () => [] as ReadonlyArray<Item>)))
  }

  set(sessionID: string, todos: ReadonlyArray<Item>) {
    return this.ctx.storage.set(key(sessionID), todos.map((todo) => ({ ...todo })))
  }

  forget(sessionID: string) {
    return this.ctx.storage.remove(key(sessionID))
  }
}

/**
 * OpenCode 1's `todowrite` as `omo_todowrite`, listed as `todowrite` in omo sessions only (the gate action): it
 * replaces the session's list and tells omo (`todo.updated`).
 */
export function tool(
  store: Store,
  emit: (sessionID: string, todos: ReadonlyArray<Item>) => Effect.Effect<void>,
  permission: string,
): Tool.Info {
  return {
    name: REGISTERED,
    description: DESCRIPTION,
    input: standard(SCHEMA),
    options: { codemode: false, permission },
    execute: (raw, context) =>
      Effect.gen(function* () {
        const input = decodeInput(raw)
        if (Option.isNone(input))
          return yield* new Tool.Error({
            message:
              "Invalid todowrite input: `todos` must be a list of {content, status: pending|in_progress|completed|cancelled, priority: high|medium|low}",
          })
        const todos = input.value.todos
        yield* store.set(context.sessionID, todos)
        yield* emit(context.sessionID, todos)
        return {
          content: JSON.stringify(todos, null, 2),
          metadata: { title: `${todos.filter((todo) => todo.status !== "completed").length} todos`, todos },
        }
      }),
  }
}

/** A JSON Schema as a Standard Schema with JSON Schema output; the tool validates its input itself. */
export function standard(schema: object) {
  const json = (): Record<string, unknown> => structuredClone({ ...schema })
  return {
    "~standard": {
      version: 1 as const,
      vendor: "own.omo",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: json, output: json },
    },
  }
}
