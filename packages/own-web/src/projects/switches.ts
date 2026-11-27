// Switches kept per place (global first, SG 2026-10-26): own.accounts' skill switches and the MCP list's switches are
// `{directory?, enabled}` records of one key (a skill id, a server name); no `directory` is every project. The one
// that decides a project is the last that reaches it: the global one first, then the folders that hold it from the
// shallowest to the deepest (own.accounts `SkillsetFold`, `McpFold`). Pure, for the lazy settings pages and the
// Ctrl+; dialog; unit-tested with them.
import { samePath } from "./path"
import { isInside } from "@/worktree/model"

export interface Placed {
  readonly directory?: string
  readonly enabled: boolean
}

/** The records that reach `directory` (only the global one for no folder), in the order they apply. */
export function switchesReaching<T extends Placed>(items: ReadonlyArray<T>, directory: string | undefined) {
  return items
    .filter((item) => item.directory === undefined || (directory !== undefined && isInside(item.directory, directory)))
    .toSorted((a, b) => depth(a) - depth(b))
}

/** Whether a place is on without its own record (the global place inherits on). */
export function switchInherited(items: ReadonlyArray<Placed>, directory: string | undefined) {
  if (directory === undefined) return true
  return (
    switchesReaching(items, directory)
      .filter((item) => item.directory === undefined || !samePath(item.directory, directory))
      .at(-1)?.enabled ?? true
  )
}

/** Whether `directory` is on: the last record that reaches it decides; on when none does. */
export function switchEffective(items: ReadonlyArray<Placed>, directory: string | undefined) {
  return switchesReaching(items, directory).at(-1)?.enabled ?? true
}

/** The project records that differ from what their place inherits (the exceptions a page shows). */
export function switchesDiffering<T extends Placed>(items: ReadonlyArray<T>) {
  return items.flatMap((item) => {
    const directory = item.directory
    return directory !== undefined && item.enabled !== switchInherited(items, directory) ? [{ ...item, directory }] : []
  })
}

/** The record at exactly this place (`undefined` folder: the global one). */
export function switchAt<T extends Placed>(items: ReadonlyArray<T>, directory: string | undefined) {
  return items.find((item) =>
    directory === undefined
      ? item.directory === undefined
      : item.directory !== undefined && samePath(item.directory, directory),
  )
}

function depth(item: Placed) {
  return item.directory === undefined ? -1 : item.directory.length
}
