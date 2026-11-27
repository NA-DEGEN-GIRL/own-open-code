// Calls a core tool the codex harness keeps registered but leaves out of the request (CodexTools.REPLACED, core's MCP
// resource tools): from the live registry, with the input decoded by the tool's schema and the calling tool's
// context, so the core tool asks its own permissions.
export * as CoreTool from "./core-tool.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

export function call(ctx: Pick<Context, "tool">, id: string, input: object, tool: Tool.Context) {
  return Effect.gen(function* () {
    const found = (yield* ctx.tool.list()).find((entry) => entry.id === id)
    if (found === undefined) return yield* Effect.fail(new Error(`core tool ${id} is not available`))
    const decoded = Schema.isSchema(found.input) ? yield* Schema.decodeUnknownEffect(found.input)(input) : input
    return yield* found.execute(decoded, tool)
  })
}
