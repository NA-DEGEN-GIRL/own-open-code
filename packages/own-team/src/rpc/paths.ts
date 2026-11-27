export * as PathsRpc from "./paths.js"

import type { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../assets/need-paths.js"
import { Release } from "../assets/release.js"
import { PathsOp } from "../ops/paths.js"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * 큰 파일 폴더 가져오기 / 내려놓기 (`area.paths`, 06 §4.6–4.7): the user's `paths` op (`ops/paths.ts`, which the voice
 * tool starts the same way), its failures as the method's declared errors.
 */

export type Methods = "area.paths"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["paths"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  // Registered here, while the plugin sets up: before the controller's first resume continues a `paths` op.
  NeedPaths.register(services)
  Release.register(services)
  return {
    "area.paths": async (input, context) => {
      const started = await PathsOp.start(services, {
        teamID: input.teamID,
        areaID: input.areaID,
        by: "user",
        ...(input.add === undefined ? {} : { add: input.add }),
        ...(input.release === undefined ? {} : { release: input.release }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      if (!started.ok) return RpcFailure.fail("area.paths", context, started)
      return { opID: started.opID }
    },
  }
}
