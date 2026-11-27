export * as ToolUpdatesRpc from "./tool-updates.js"

import type { Deps } from "../deps.js"
import { ToolUpdatesModule } from "../tool-updates/tool-updates.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: UPD (05 §20). 설정 > 업데이트: the programs own runs on this PC that the user installs, their versions, the
 * newest releases and an update the user confirmed. Its state is `tool-updates.json` and the running update of this
 * instance (the control Location's: these methods always go there).
 */
export type Methods =
  | "tools.view"
  | "tools.settings.set"
  | "tools.update.plan"
  | "tools.update.execute"
  | "tools.update.status"

export function handlers(deps: Deps, system?: ToolUpdatesModule.System): RpcTypes.Group<Methods> {
  const tools = ToolUpdatesModule.create(deps, system)
  return {
    "tools.view": tools.view,
    "tools.settings.set": tools.settings,
    "tools.update.plan": tools.plan,
    "tools.update.execute": tools.execute,
    "tools.update.status": tools.status,
  }
}
