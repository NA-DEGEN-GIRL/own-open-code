// Transcript view cache of one window (03 §20.2 PF7, §4.1.1): every split pane keeps the views it showed, but the
// detached ones share one budget. Attached views (one per visible pane) never count and are never evicted; beyond
// `cap` detached views the least recently used one is disposed, whichever pane kept it.

export interface PooledView {
  /** Drops the view from its pane's cache and disposes it. */
  readonly evict: () => void
}

export function createViewPool(cap: number) {
  /** Least recently used first. */
  const order: PooledView[] = []
  const attached = new Set<PooledView>()
  const trim = () => {
    const detached = order.filter((view) => !attached.has(view))
    for (const view of detached.slice(0, Math.max(0, detached.length - cap))) {
      order.splice(order.indexOf(view), 1)
      view.evict()
    }
  }
  return {
    /** The view a pane shows now: most recently used, attached. */
    attach(view: PooledView) {
      const index = order.indexOf(view)
      if (index >= 0) order.splice(index, 1)
      order.push(view)
      attached.add(view)
      trim()
    },
    /** The pane shows another view (or closed): the view stays cached until the budget needs its place. */
    detach(view: PooledView) {
      if (!attached.delete(view)) return
      trim()
    },
    /** The pane itself went away (its runtime or the pane closed): its views leave the pool without a callback. */
    forget(view: PooledView) {
      attached.delete(view)
      const index = order.indexOf(view)
      if (index >= 0) order.splice(index, 1)
    },
    size: () => order.length,
    attachedCount: () => attached.size,
  }
}

export type ViewPool = ReturnType<typeof createViewPool>
