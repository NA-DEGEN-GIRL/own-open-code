// How the sidebar lists a server's projects and the servers themselves (03 §4.3 "순서와 고정"). Pure: no Solid, no DOM;
// unit-tested in arrange.test.ts.

/** A server's project list as its service keeps it (own.accounts `projectList.*`). */
export interface ProjectListView {
  readonly pinned: readonly string[]
  /** The unpinned projects in the user's order; `null`: the default order. */
  readonly order: readonly string[] | null
  readonly orderedAt: number | null
}

/**
 * Pinned projects first, in the user's order; then the rest. In the default order that is the order they came in
 * (newest conversation first) with `leading` (the default conversation folder) first. Once the user arranged them: the
 * projects used since then that the user has not placed yet (a folder just opened), the placed ones, then older ones
 * that were not loaded at the time.
 */
export function arrangeProjects(
  ids: readonly string[],
  input: {
    readonly leading?: string
    readonly list?: ProjectListView
    /** When the project's newest listed conversation was last active. */
    readonly updated: (projectID: string) => number
  },
): readonly string[] {
  const first = input.leading
  const base = first !== undefined && ids.includes(first) ? [first, ...ids.filter((id) => id !== first)] : ids
  const list = input.list
  if (!list || (!list.pinned.length && !list.order)) return base
  const pinned = list.pinned.filter((id) => base.includes(id))
  const rest = base.filter((id) => !pinned.includes(id))
  const order = list.order
  if (!order) return [...pinned, ...rest]
  const fresh = (id: string) => input.updated(id) > (list.orderedAt ?? 0)
  const unplaced = rest.filter((id) => !order.includes(id))
  return [
    ...pinned,
    ...unplaced.filter(fresh),
    ...order.filter((id) => rest.includes(id)),
    ...unplaced.filter((id) => !fresh(id)),
  ]
}

/** `keys` in the stored order; ones it does not name keep their own order after it. */
export function arrangeKeys(keys: readonly string[], stored: readonly string[]): readonly string[] {
  return [...stored.filter((key) => keys.includes(key)), ...keys.filter((key) => !stored.includes(key))]
}

/**
 * `shown` with `id` at `index`, as a whole order to store: what the stored order names and the list does not show now
 * (a project whose conversations are all archived, a host that is away) stays after what came before it.
 */
export function placed(shown: readonly string[], stored: readonly string[], id: string, index: number) {
  const next = shown.filter((item) => item !== id)
  next.splice(index, 0, id)
  stored.forEach((item, at) => {
    if (next.includes(item)) return
    next.splice(at === 0 ? 0 : next.indexOf(stored[at - 1]!) + 1, 0, item)
  })
  return next
}
