// Frame scheduling shared by the data layer and inputs (03 §12 rule 8 `nextFrame`, §20.2 R3).

/**
 * Runs `fn` once on the next animation frame. rAF stops while the tab is hidden, so a 50 ms timer races it and the
 * first to fire wins. Returns a cancel function.
 */
export function nextFrame(fn: () => void): () => void {
  let done = false
  const run = () => {
    if (done) return
    done = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    fn()
  }
  const frame = requestAnimationFrame(run)
  const timer = setTimeout(run, 50)
  return () => {
    done = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}

/**
 * Collects items and hands them to `flush` at most once per frame, in arrival order. Streaming deltas, SSE frames
 * and other bursts all reach the store in one batch per frame.
 */
export function createFrameBatcher<T>(flush: (items: T[]) => void) {
  let items: T[] = []
  let cancel: (() => void) | undefined
  const run = () => {
    cancel = undefined
    const batch = items
    items = []
    if (batch.length) flush(batch)
  }
  return {
    push(item: T) {
      items.push(item)
      cancel ??= nextFrame(run)
    },
    /** Delivers what is queued now (tests, teardown). */
    flush() {
      cancel?.()
      run()
    },
    dispose() {
      cancel?.()
      cancel = undefined
      items = []
    },
  }
}

/**
 * Coalesces keyed updates over a window: only the last value per key survives, delivered together (03 §16.4: own
 * `quota.updated`, `cache.state`, `ledger.step` are grouped at 250 ms on top of the per-frame batch).
 */
export function createKeyedCoalescer<T>(windowMs: number, flush: (items: T[]) => void) {
  const pending = new Map<string, T>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = () => {
    timer = undefined
    const items = [...pending.values()]
    pending.clear()
    if (items.length) flush(items)
  }
  return {
    push(key: string, item: T) {
      pending.delete(key)
      pending.set(key, item)
      timer ??= setTimeout(run, windowMs)
    },
    flush() {
      clearTimeout(timer)
      run()
    },
    dispose() {
      clearTimeout(timer)
      timer = undefined
      pending.clear()
    },
  }
}
