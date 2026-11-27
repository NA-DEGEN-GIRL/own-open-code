export * as BrowseRpc from "./browse.js"

import { OwnBrowse } from "@own/protocol"
import { Browse } from "../browse/browse.js"
import type { Deps } from "../deps.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: 내 브라우저 사용 (BRW). `browse.status` answers the setting and the `browse` program this service would run (a
 * path; it never runs the program or touches a browser). `browse.set` (`local`) writes `browse.json` and tells every
 * Location (`browse.changed`), which folds its MCP servers again when its program changed.
 */
export type Methods = "browse.status" | "browse.set"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const store = Browse.file(deps)
  const remote = deps.remote !== undefined
  return {
    "browse.status": async () => Browse.status(await store.read(), remote),
    "browse.set": async (input) => {
      const next = await store.update((current) => OwnBrowse.apply(current, input))
      deps.runtime.broadcast.emit("browse.changed", {})
      deps.log.info("browse_setting_changed", { enabled: OwnBrowse.enabled(next), command: next.command !== undefined })
      return Browse.status(next, remote)
    },
  }
}
