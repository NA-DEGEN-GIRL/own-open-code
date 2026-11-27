export * as WorktreeChatRpc from "./worktree-chat.js"

import type { OwnTeam } from "@own/protocol"
import type { Services } from "../services.js"
import type { TeamRpc } from "./handlers.js"

/**
 * Worktree conversations (06 §13, 2026-11-24): `worktreeChat.list` reads a conversation's started ones (KV records
 * and core's live state) and, for a started one, its parent. Works without a team.
 */

export type Methods = "worktreeChat.list"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["worktree-chat"]

export function handlers(services: Services.Context): TeamRpc.Group<Methods> {
  return {
    "worktreeChat.list": (input) => services.features().worktreeChat.list(input.sessionID),
  }
}
