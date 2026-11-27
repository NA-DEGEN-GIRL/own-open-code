export * as History from "./history.js"

import { Message, type ToolCallPart, type ToolResultPart } from "@opencode/ai/effect"
import { Registry } from "./registry.js"

/**
 * Past tool calls under the tool names of `target` (10 §3.7): a `shell` call another harness made becomes `target`'s
 * shell tool, a `patch` call its patch tool, and their results follow by call id. Calls to any other tool, calls whose
 * input does not have the source tool's shape, provider-executed and namespaced calls stay as they are.
 *
 * A pure function of the history and the target, so a request built again from the same history has the same bytes
 * (02 §4.3 D1). Unchanged messages are returned as the same objects; a history that never used another harness's tools
 * comes back unchanged, which keeps the `opencode` harness's requests as upstream builds them.
 */
export function translate(messages: ReadonlyArray<Message>, target: Registry.Harness): Array<Message> {
  const renamed = new Map<string, string>()
  return messages.map((message) => {
    // Tool calls and results sit in assistant and tool messages only (@opencode/ai narrows content by role).
    if (message.role === "tool") {
      const content = message.content.map((part) => result(part, renamed))
      if (content.every((part, index) => part === message.content[index])) return message
      return Message.make({ ...message, content })
    }
    if (message.role !== "assistant") return message
    const content = message.content.map((part) =>
      part.type === "tool-result" ? result(part, renamed) : part.type === "tool-call" ? call(part, target, renamed) : part,
    )
    if (content.every((part, index) => part === message.content[index])) return message
    return Message.make({ ...message, content })
  })
}

function result(part: ToolResultPart, renamed: Map<string, string>): ToolResultPart {
  const name = renamed.get(part.id)
  return name === undefined ? part : { ...part, name }
}

function call(part: ToolCallPart, target: Registry.Harness, renamed: Map<string, string>): ToolCallPart {
  if (part.providerExecuted === true || part.namespace !== undefined) return part
  const converted = convert(part.name, part.input, target)
  if (converted === undefined) return part
  renamed.set(part.id, converted.name)
  return { ...part, name: converted.name, input: converted.input }
}

function convert(name: string, input: unknown, target: Registry.Harness) {
  return (["shell", "patch"] as const)
    .map((kind) => {
      const form = target.tools[kind]
      // A target without this action's tool (pi has no patch tool) leaves the call as it is.
      if (form === undefined || name === form.name) return undefined
      const source = Registry.ALL.map((harness) => harness.tools[kind]).find((other) => other?.name === name)
      const action = source?.read(input)
      if (action === undefined) return undefined
      // SAFETY: `source` and `form` are the same kind's forms, so the action read by one is the other's to write.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return { name: form.name, input: (form.write as (value: Registry.Action) => unknown)(action) }
    })
    .find((value) => value !== undefined)
}
