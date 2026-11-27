export * as ClaudeAgentRpc from "./claude-agent.js"

import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/** Owner: CLAUDE AGENT (02 §8.10). */
export type Methods =
  | "claudeAgent.status"
  | "claudeAgent.setup"
  | "claudeAgent.login"
  | "claudeAgent.remove"
  | "claudeAgent.limits.refresh"
  | "claudeAgent.session.get"
  | "claudeAgent.session.set"
  | "claudeAgent.default.set"
  | "claudeAgent.pool.set"
  | "claudeAgent.folders.list"
  | "claudeAgent.folders.assign"

export function handlers(modules: Modules.All): RpcTypes.Group<Methods> {
  return {
    "claudeAgent.status": (input, context) => modules.claudeAgent.status(input, context),
    "claudeAgent.setup": (input, context) => modules.claudeAgent.setup(input, context),
    "claudeAgent.login": (input, context) => modules.claudeAgent.login(input, context),
    "claudeAgent.remove": (input, context) => modules.claudeAgent.remove(input, context),
    "claudeAgent.limits.refresh": (input, context) => modules.claudeAgent.limitsRefresh(input, context),
    "claudeAgent.session.get": (input, context) => modules.claudeAgent.sessionGet(input, context),
    "claudeAgent.session.set": (input, context) => modules.claudeAgent.sessionSet(input, context),
    "claudeAgent.default.set": (input, context) => modules.claudeAgent.defaultSet(input, context),
    "claudeAgent.pool.set": (input, context) => modules.claudeAgent.poolSet(input, context),
    "claudeAgent.folders.list": (input, context) => modules.claudeAgent.foldersList(input, context),
    "claudeAgent.folders.assign": (input, context) => modules.claudeAgent.foldersAssign(input, context),
  }
}
