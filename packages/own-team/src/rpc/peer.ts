export * as PeerRpc from "./peer.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"
import { RpcFailure } from "./fail.js"

/**
 * Area peers (동료, 06 §2.7, approved 2026-10-09): `area.peer.add` (동료로 등록… / 동료 추가…), `area.peer.edit` (역할
 * 바꾸기…) and `area.peer.remove` (동료에서 빼기), scope `admin` at the control location. They answer through the peers
 * feature (`sessions/peer.ts`), which a later voice tool calls the same way.
 */

export type Methods = "area.peer.add" | "area.peer.edit" | "area.peer.remove"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["peers"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "area.peer.add": async (input, context) => {
      const added = await services.features().peers.add(input)
      if (!added.ok) return RpcFailure.fail("area.peer.add", context, added)
      return { area: added.area, peer: added.peer }
    },
    "area.peer.edit": async (input, context) => {
      const edited = await services.features().peers.edit(input)
      if (!edited.ok) return RpcFailure.fail("area.peer.edit", context, edited)
      return { area: edited.area }
    },
    "area.peer.remove": async (input, context) => {
      const removed = await services.features().peers.remove(input)
      if (!removed.ok) return RpcFailure.fail("area.peer.remove", context, removed)
      return { area: removed.area }
    },
  }
}
