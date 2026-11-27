// PTY size sync (03 §18.6 "크기 조절은 패널 크기를 따라가고, 바뀔 때마다 PTY 크기를 알린다(rAF당 한 번)"). The view fits
// at most once per animation frame; this keeps at most one `PUT /api/pty/:id` in flight and sends only the newest
// size after it, so dragging the panel never queues a request per frame.
export interface PtySize {
  readonly cols: number
  readonly rows: number
}

export function createSizeSync(push: (size: PtySize) => Promise<void>) {
  const current: { sent?: PtySize; pending?: PtySize; inflight: boolean } = { inflight: false }

  function pump() {
    if (current.inflight || !current.pending) return
    const next = current.pending
    current.pending = undefined
    if (same(current.sent, next)) return
    current.inflight = true
    push(next).then(
      () => {
        current.sent = next
        current.inflight = false
        pump()
      },
      () => {
        current.inflight = false
        pump()
      },
    )
  }

  return {
    set(size: PtySize) {
      if (size.cols < 1 || size.rows < 1) return
      current.pending = size
      pump()
    },
    /** Last size the server confirmed. */
    sent: () => current.sent,
  }
}

function same(a: PtySize | undefined, b: PtySize) {
  return a?.cols === b.cols && a?.rows === b.rows
}
