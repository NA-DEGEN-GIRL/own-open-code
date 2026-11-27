export * as WorktreeRpc from "./worktree.js"

import type { Deps } from "../deps.js"
import { Location } from "../location.js"
import { WorktreeInspect } from "../worktree/inspect.js"
import type { RpcTypes } from "./types.js"

/** Owner: WORKTREE (06 §10.4 #5, TG13). Stateless: it reads Git and the folder, so it needs no module. */
export type Methods = "worktree.inspect"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  return {
    "worktree.inspect": async (input, context) => {
      // Only folders the server already has as this project's checkouts and worktrees (core's worktree table, which
      // the cleanup removes from): a paired `read` device cannot point Git or the walk at any other folder.
      const known = await deps.ctx.worktree.list({ projectID: input.projectID }).then(
        (rows) => rows.map((row) => row.directory),
        () => [],
      )
      const unknown = [input.root, input.directory].find((folder) => !known.some((row) => Location.same(row, folder)))
      if (unknown !== undefined)
        return context.error("not_found", "not a worktree of this project", { directory: unknown })
      return WorktreeInspect.inspect(input, { signal: context.signal }).then(
        (result) =>
          result.ok ? result.inspection : context.error(result.error, result.message, { directory: result.directory }),
        // Git missing or a spawn failure: a declared error, so the dialog fails closed with its retry.
        (error: unknown) => context.error("internal_error", error instanceof Error ? error.message : String(error), {}),
      )
    },
  }
}
