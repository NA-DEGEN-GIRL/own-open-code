export * as Hooks from "./index.js"

import type { Plugin } from "@opencode/plugin"
import type { Log } from "../log.js"
import type { Services } from "../services.js"
import { PermissionHook } from "./permission.js"
import { PromptHook } from "./prompt.js"
import { ToolHook } from "./tool.js"

/**
 * own.team's hooks (06 §2.6): the session `prompt` hook (direct user talk, information only), the permission
 * `evaluate` hook (tighten only) and the tool `execute.before`/`execute.after` hooks. No provider transform and no
 * `model.request` hook. A hook never throws: a failure is logged and the event passes unchanged.
 */
export async function register(input: {
  readonly ctx: Pick<Plugin.Context, "session" | "permission" | "tool">
  readonly services: Services.Context
  readonly log: Log.Logger
}) {
  const prompt = PromptHook.create(input.services)
  const permission = PermissionHook.create(input.services)
  const tool = ToolHook.create(input.services)
  const guard = (hook: string, run: () => Promise<void>) =>
    run().catch((error: unknown) => input.log.warn("hook_failed", { hook, error }))
  const registrations = await Promise.all([
    input.ctx.session.hook("prompt", (event) => guard("prompt", () => prompt(event))),
    input.ctx.permission.hook("evaluate", (event) => guard("evaluate", () => permission(event))),
    input.ctx.tool.hook("execute.before", (event) => guard("execute.before", () => tool.before(event))),
    input.ctx.tool.hook("execute.after", (event) => guard("execute.after", () => tool.after(event))),
  ])
  return async () => {
    await Promise.all(registrations.map((registration) => registration.dispose()))
  }
}
