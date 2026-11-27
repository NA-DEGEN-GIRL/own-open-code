// Ports packages/todo/tool-todo/src/index.ts: `todo_write` replaces the whole task list, as the web app's standard agent
// preset configures it (`allowParallelInProgress: true`). dsh appends the list to its session log for its UI; own keeps
// it in the tool result's metadata (the transcript shows the call), and the model reads dsh's count line.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshTodo from "./todo.js"

import type { DshArgs } from "./args.js"

export const NAME = "todo_write"

const STATUSES = ["pending", "in_progress", "completed"] as const
export type Status = (typeof STATUSES)[number]

export const DESCRIPTION =
  "Record and update a task list to plan multi-step work and show progress; skip it for trivial " +
  "single-step tasks. Add one todo per concrete step before you start. " +
  "While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. " +
  "Mark each todo `completed` as soon as it is done."

export const SCHEMA: DshArgs.ObjectSchema = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The COMPLETE task list, replacing any previous list.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string", description: "What the task is — a short imperative line." },
          status: {
            type: "string",
            description: "pending (not started) | in_progress (now) | completed (done).",
            enum: [...STATUSES],
          },
        },
        required: ["content", "status"],
      },
    },
  },
  required: ["todos"],
}

export interface Input {
  readonly todos: ReadonlyArray<{ readonly content: string; readonly status: Status }>
}

/** `toTodoList` with parallel work allowed: trimmed, non-empty, unique contents. */
export function list(input: Input) {
  const todos = input.todos.map((item) => ({ content: item.content.trim(), status: item.status }))
  if (todos.some((item) => item.content.length === 0))
    return { ok: false as const, message: "invalid todo: `content` must be a non-empty string" }
  const duplicate = todos.find((item, index) => todos.findIndex((other) => other.content === item.content) !== index)
  if (duplicate !== undefined)
    return { ok: false as const, message: `invalid todos: duplicate content ${JSON.stringify(duplicate.content)}` }
  return { ok: true as const, todos }
}

/** The model's line for an accepted list. */
export function render(todos: ReadonlyArray<{ readonly status: Status }>) {
  const count = (status: Status) => todos.filter((item) => item.status === status).length
  return `Updated todo list: ${count("pending")} pending, ${count("in_progress")} in progress, ${count("completed")} completed.`
}
