export * as Activity from "./activity.js"

import type { Inventory } from "./inventory.js"

/**
 * Activity (06 §3.4), the one deterministic definition the proposal, V13 and the retire signal share: a worktree is
 * active when its HEAD has at least one commit the target does not, when it has work not in a commit (modified,
 * staged or untracked files), or when one of its root sessions was updated within the last 14 days.
 */

export const RECENT_MS = 14 * 24 * 60 * 60 * 1000

export type Input = Pick<Inventory.Worktree, "ahead" | "changes" | "sessions">

export interface Signals {
  /** Commits not in the target. */
  readonly unique: number
  /** Paths with uncommitted work (ignored files excluded). */
  readonly uncommitted: number
  /** A root session updated within {@link RECENT_MS}. */
  readonly recent: boolean
}

/** The three parts of the definition, for the card text (`저장 지점에 넣지 않은 변경 4개`). */
export function signals(worktree: Input, now = Date.now()): Signals {
  return {
    unique: worktree.ahead ?? 0,
    uncommitted: worktree.changes?.uncommitted ?? 0,
    recent: worktree.sessions.some((session) => now - session.updated <= RECENT_MS),
  }
}

export function isActive(worktree: Input, now = Date.now()) {
  const found = signals(worktree, now)
  return found.unique >= 1 || found.uncommitted > 0 || found.recent
}
