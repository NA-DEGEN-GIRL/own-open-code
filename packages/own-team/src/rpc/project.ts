export * as ProjectRpc from "./project.js"

import type { OwnTeam } from "@own/protocol"
import { GitInit } from "../git/init.js"
import type { Services } from "../services.js"
import { RpcFailure } from "./fail.js"
import type { TeamRpc } from "./handlers.js"

/**
 * Git 저장소로 만들기 (06 §3.0): `project.gitInit.plan` reads what `project.gitInit` would do; `project.gitInit` makes the
 * folder a repository (`git/init.ts`) on this service's host, the PC or the SSH host that owns the folder. Once the
 * checks passed and right before `git init`, the folder's project id is read from the service and kept in
 * `.git/opencode`, so the project stays the same
 * row with the same sessions; afterwards the folder's cached Location is dropped and read again, so the service's project
 * says `vcs: git` at once (team mode and worktrees appear). Both reads are best effort: without them core still resolves
 * the folder the next time a Location of it is made.
 */

export type Methods = "project.gitInit.plan" | "project.gitInit"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["git-init"]

export function handlers(services: Pick<Services.Context, "home" | "http">): TeamRpc.Group<Methods> {
  return {
    "project.gitInit.plan": async (input, context) => {
      const planned = await GitInit.plan({ directory: input.directory, home: services.home })
      if (!planned.ok) return RpcFailure.fail("project.gitInit.plan", context, planned)
      return planned.plan
    },
    "project.gitInit": async (input, context) => {
      const ran = await GitInit.run({
        directory: input.directory,
        home: services.home,
        ...(input.firstCommit === undefined ? {} : { firstCommit: input.firstCommit }),
        project: async () => {
          const before = await services.http.location.get(input.directory)
          return before.ok ? before.value.project.id : undefined
        },
      })
      if (!ran.ok) return RpcFailure.fail("project.gitInit", context, ran)
      await services.http.location.evict(input.directory)
      const after = await services.http.location.get(input.directory)
      return { ...ran.result, projectID: after.ok ? after.value.project.id : null }
    },
  }
}
