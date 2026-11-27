// OWN-PATCH(P-044) begin
export * as ClaudePool from "./pool.js"

// own (report §9.3, 02 §8.10.12): a cap on the live claude processes of this service. A new process takes a free slot;
// at the cap the process idle longest is closed first (its transcript and record stay, so the conversation resumes it
// later); a process that is mid-turn or waits for tool results (a subagent, a permission question, a question tool) is
// never closed. When every process is protected the start waits, in order of arrival, and the waiting is reported; a
// start that unblocks a parent waiting for its subagents goes first, once ahead of each start it passes (CAG-45).
// Side calls (titles, generate, compaction, the login check, an idle account's usage read) never take a conversation's
// slot: they have a bound of their own (as many as the cap), are never closed and end on their own (CAG-46).
//
// A start may go over the cap only to break a deadlock (CAG-35, CAG-43): every live process waits for a tool that can
// wait for another conversation (a subagent, a question; `stuck`), all of them for `settle` (3 s) already, so nothing
// can free a slot, and one of them may wait for this start, directly or through a conversation on another provider the
// pool cannot see. Then one start with a parent goes, and the next only once it waits too. Over-cap processes stop at
// twice the cap; beyond it only a start that unblocks its waiting parent goes (one live subagent per waiting parent),
// so a chain of subagents can always take its next step while siblings wait. New settings apply at once (`recheck`).
import { Deferred, Effect } from "effect"

export const DEFAULT_CAP = 8
// How long every live process must have waited on another conversation before a start goes over the cap.
export const SETTLE_MS = 3_000

export interface Status {
  // Live processes, side calls included.
  readonly live: number
  readonly cap: number
  // Conversations waiting for a slot, oldest first.
  readonly waiting: ReadonlyArray<{ readonly sessionID?: string; readonly since: number }>
  // Processes started over the cap to break a deadlock.
  readonly over: number
}

export interface Member {
  readonly sessionID?: string
  // A side call: a bound of its own, never closed by the pool.
  readonly side: boolean
  // The parent of a subagent's conversation.
  readonly parentID?: string
}

export interface Options<M extends Member> {
  readonly cap: () => number
  // Mid-turn, or waiting for tool results: never closed.
  readonly busy: (member: M) => boolean
  // Since when the member's process waits for a tool that can wait for another conversation (a subagent, a question);
  // undefined while it does not.
  readonly stuck: (member: M) => number | undefined
  // The parent of the member's conversation has a live process waiting for its subagents.
  readonly parentWaits: (member: M) => boolean
  // Closes the member's process; it calls `release` once the process is gone.
  readonly evict: (member: M) => Effect.Effect<void>
  readonly report: (status: Status, queued?: M) => void
  // A spare process waiting for a new conversation: closed before any conversation's.
  readonly spare?: (member: M) => boolean
  readonly settle?: number
}

interface Waiter<M> {
  readonly member: M
  readonly since: number
  readonly granted: Deferred.Deferred<void>
  // A start that unblocks a waiting parent went ahead of this one: the next goes in order of arrival.
  passed?: boolean
}

export function make<M extends Member>(options: Options<M>) {
  const live = new Map<M, number>()
  const queue: Waiter<M>[] = []
  const sides = new Set<M>()
  const sideQueue: Waiter<M>[] = []
  const evicting = new Set<M>()
  // Starts granted over the cap that are still live.
  const over = new Set<M>()
  const settle = options.settle ?? SETTLE_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const cap = () => Math.max(1, Math.floor(options.cap()))
  const status = (): Status => ({
    live: live.size + sides.size,
    cap: cap(),
    waiting: queue.map((waiter) => ({ sessionID: waiter.member.sessionID, since: waiter.since })),
    // Counted from the live set every time: one that left, or a cap raised since, leaves no stale count.
    over: Math.min(over.size, Math.max(0, live.size - cap())),
  })

  // The processes the pool may close: spares first, then the one idle longest.
  const idle = () => {
    const spare = (member: M) => (options.spare?.(member) ? 0 : 1)
    return [...live.entries()]
      .filter(([member]) => !evicting.has(member) && !options.busy(member))
      .sort((left, right) => spare(left[0]) - spare(right[0]) || left[1] - right[1])
      .map(([member]) => member)
  }

  // A start whose parent waits for its subagents with none of them live: without it the parent cannot go on.
  const unblocks = (member: M) =>
    member.parentID !== undefined &&
    options.parentWaits(member) &&
    ![...live.keys()].some((other) => other.parentID === member.parentID)

  // The next start for a free slot: in order of arrival, except that one unblocking a waiting parent goes first, once
  // ahead of each start it passes.
  const pick = () => {
    const urgent = queue.find((waiter) => unblocks(waiter.member))
    if (!urgent) return queue[0]!
    return queue.slice(0, queue.indexOf(urgent)).some((waiter) => waiter.passed) ? queue[0]! : urgent
  }

  // When every live process has waited on another conversation since: the latest of those times; else undefined.
  const stuckSince = () => {
    const times = [...live.keys()].map((member) => options.stuck(member))
    if (times.some((time) => time === undefined)) return undefined
    return Math.max(...(times as number[]))
  }

  const close = (member: M) => {
    evicting.add(member)
    Effect.runFork(options.evict(member).pipe(Effect.ensuring(Effect.sync(() => release(member)))))
  }

  const grant = (waiter: Waiter<M>) => {
    const index = queue.indexOf(waiter)
    for (const before of queue.slice(0, index)) before.passed = true
    queue.splice(index, 1)
    live.set(waiter.member, Date.now())
    Deferred.doneUnsafe(waiter.granted, Effect.void)
  }

  // Grants slots while it can: a free slot, else the least recently used idle process is closed (one at a time), else
  // a start over the cap when the pool is stuck (see above).
  const pump = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    while (queue.length > 0) {
      if (live.size < cap()) {
        grant(pick())
        continue
      }
      if (evicting.size > 0) break
      const victim = idle()[0]
      if (victim) {
        close(victim)
        break
      }
      const since = stuckSince()
      if (since === undefined) break
      const left = since + settle - Date.now()
      if (left > 0) {
        // Checked again then: a process that went on, or one that started waiting since, moves the time.
        timer = setTimeout(pump, left)
        break
      }
      const child =
        queue.find((waiter) => unblocks(waiter.member)) ??
        (live.size < 2 * cap() ? queue.find((waiter) => waiter.member.parentID !== undefined) : undefined)
      if (!child) break
      over.add(child.member)
      grant(child)
    }
    options.report(status())
  }

  const serveSides = () => {
    while (sideQueue.length > 0 && sides.size < cap()) {
      const waiter = sideQueue.shift()!
      sides.add(waiter.member)
      Deferred.doneUnsafe(waiter.granted, Effect.void)
    }
  }

  const release = (member: M) => {
    if (sides.delete(member)) {
      serveSides()
      options.report(status())
      return
    }
    const held = live.delete(member)
    evicting.delete(member)
    over.delete(member)
    if (held) pump()
  }

  // Conversations' processes beyond the cap that are not closing yet.
  const beyond = () => [...live.keys()].filter((member) => !evicting.has(member)).length - cap()

  // The settings changed: a higher cap grants waiting starts at once, a lower one closes the idle processes beyond it
  // now. A protected one is never closed: it goes once it is idle (`changed`).
  const recheck = () => {
    // A close can finish at once and grant a waiting start, so the count is taken again before each one.
    for (const member of idle()) if (beyond() > 0 && live.has(member) && !evicting.has(member)) close(member)
    serveSides()
    pump()
  }

  const wait = (waiters: Waiter<M>[], member: M) =>
    Effect.gen(function* () {
      const waiter: Waiter<M> = { member, since: Date.now(), granted: Deferred.makeUnsafe<void>() }
      waiters.push(waiter)
      if (!member.side) {
        options.report(status(), member)
        pump()
      }
      yield* Deferred.await(waiter.granted).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            // Granted in the same moment: give the slot back.
            else if (live.has(member) || sides.has(member)) release(member)
            options.report(status())
          }),
        ),
      )
    })

  const acquire = Effect.fn("ClaudePool.acquire")(function* (member: M) {
    if (live.has(member) || sides.has(member)) return
    if (member.side) {
      if (sideQueue.length > 0 || sides.size >= cap()) return yield* wait(sideQueue, member)
      sides.add(member)
      options.report(status())
      return
    }
    if (queue.length === 0 && live.size < cap()) {
      live.set(member, Date.now())
      options.report(status())
      return
    }
    yield* wait(queue, member)
  })

  return {
    acquire,
    release,
    // A member's state changed (it parked, or its turn ended): a waiting start may go now, and an idle process beyond
    // the cap (one granted over it, or one a lowered cap found busy) closes.
    changed: () => {
      if (queue.length > 0 || beyond() > 0) recheck()
    },
    recheck,
    // The member was used now (least recently used order).
    touch: (member: M) => {
      if (live.has(member)) live.set(member, Date.now())
    },
    // A spare's slot goes to the conversation that claims it (the count stays).
    transfer: (from: M, to: M) => {
      if (!live.delete(from)) return false
      live.set(to, Date.now())
      return true
    },
    // A free slot right now, without waiting or closing anything (for a spare).
    free: () => queue.length === 0 && live.size < cap(),
    // Takes a slot only when one is free.
    take: (member: M) => {
      if (queue.length > 0 || live.size >= cap()) return false
      live.set(member, Date.now())
      options.report(status())
      return true
    },
    // Live processes, side calls included.
    live: () => live.size + sides.size,
    cap,
    status,
  }
}
// OWN-PATCH(P-044) end
