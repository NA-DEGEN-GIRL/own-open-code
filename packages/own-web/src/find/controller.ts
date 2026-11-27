// Find in session and message navigation for one transcript (03 §19.13, §10 `Ctrl+F`, `Ctrl+Alt+[`/`]`).
// - The loaded messages become documents (./model); while the bar is open they go to the worker index, changed texts
//   only, at most every SYNC_DELAY while an answer streams. Queries never run on the main thread (R4, PF2).
// - A new query starts at the first match at or below the turn at the top of the view; Enter/Shift+Enter move.
// - A jump leaves the tail, asks the transcript's virtualizer to reveal the turn (`reveal`, from the transcript) or
//   seeks it through the virtual list (./highlight `seekTurn`) when no reveal was handed over, then centers the match.
// - The transcript holds a bounded part of a long session (transcript/history.ts): documents of messages it dropped
//   while the bar is open stay searchable, and a jump to one waits for the transcript to read its page again.
// - Mounted matches are highlighted with the CSS Custom Highlight API and re-painted once per frame when rows mount.
// Nothing runs while the bar is closed: no index, no observer, no work per streamed delta.
import type { SessionMessageInfo } from "@opencode/client"
import { batch, createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import {
  alignTop,
  atTop,
  centerBox,
  centered,
  clearHighlights,
  collectRanges,
  docIDs,
  leaveTail,
  paintHighlights,
  partElement,
  reach,
  topTurn,
  turnStart,
} from "./highlight"
import { documentsOf, normalizeNeedle, startAt, turnsOf, type FindDoc, type FindHit } from "./model"
import { createFindIndex, type FindIndex } from "./search-index"

/** Streaming answers change the last text many times a second; the index follows at most this often. */
const SYNC_DELAY = 150
/**
 * While typing, the count follows every keystroke but the view moves once the query rests: each jump mounts and
 * measures new rows, which would otherwise land in the frames right after the keystrokes (PF2).
 */
const JUMP_DELAY = 120

export interface FindInput {
  readonly sessionID: Accessor<string | undefined>
  readonly messages: Accessor<readonly SessionMessageInfo[]>
  /**
   * The transcript would hold this message if it still existed: an indexed message it covers but no longer lists was
   * removed (a committed revert, a cancelled queued message). Without it, everything indexed stays while the bar is open.
   */
  readonly covers?: (messageID: string) => boolean
  /** The transcript is on screen (selected, not covered by a page): shortcuts, painting and jumps. */
  readonly active: Accessor<boolean>
  /** The transcript's scroll element (the virtualizer's list root). */
  readonly scroller: () => HTMLElement | undefined
  /**
   * Brings the turn into the transcript's window; a promise while it reads a dropped page again. Without it the list is
   * sought frame by frame.
   */
  readonly reveal?: (turnID: string, partID?: string) => void | Promise<void>
  /** Stop following the tail (the transcript's `follow.unpin`). */
  readonly unpin?: () => void
  /** Older messages exist on the server (not loaded yet). */
  readonly more: Accessor<boolean>
  readonly loadingOlder: Accessor<boolean>
  readonly loadOlder: () => Promise<void>
}

interface Result {
  readonly docs: readonly FindDoc[]
  readonly ids: ReadonlySet<string>
  readonly hits: readonly FindHit[]
  readonly total: number
}

const EMPTY: Result = { docs: [], ids: new Set(), hits: [], total: 0 }

export function createSessionFind(input: FindInput) {
  const [state, setState] = createStore({
    open: false,
    /** The input's value (applied on the next frame after typing, R6). */
    query: "",
    needle: "",
    active: -1,
    searching: false,
    /** Bumped to ask the bar to focus and select its input (Ctrl+F while open). */
    focus: 0,
  })
  const [result, setResult] = createSignal<Result>(EMPTY)
  let index: FindIndex | undefined
  let synced: readonly FindDoc[] = []
  let turns: readonly string[] = []
  let turnIndex = new Map<string, number>()
  let messageIndex = new Map<string, number>()
  /** Every message indexed while the bar is open, by id (ids sort in session order), and every turn. */
  let archive = new Map<string, readonly FindDoc[]>()
  let archivedTurns = new Set<string>()
  let runs = 0
  let jumps = 0
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  let cancelMove: (() => void) | undefined
  let jumpTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    clearTimeout(jumpTimer)
    clearTimeout(syncTimer)
    cancelMove?.()
    index?.dispose()
  })

  // ---- documents: rebuilt when the messages change while the bar is open
  let shape = ""
  /** The pending sync carries a list change, not only streamed text. */
  let paged = false
  createEffect(() => {
    if (!state.open) return
    const list = input.messages()
    // Answers stream into the last message; earlier messages keep their text. Reading these subscribes to them.
    const next = `${list.length}:${list[0]?.id}`
    void fingerprint(list.at(-1))
    const changed = next !== shape
    shape = next
    // Pages the transcript reads and drops while it scrolls reach the index at most every SYNC_DELAY, not after a
    // pause (they could be gone by then); a streaming answer once it rests for SYNC_DELAY.
    paged ||= changed
    if (paged && syncTimer !== undefined) return
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => sync(), SYNC_DELAY)
  })
  createEffect(
    on(
      input.sessionID,
      () => {
        if (!untrack(() => state.open)) return
        // Another session in the same view (shell-mounted bar): search it with the same query.
        synced = []
        archive = new Map()
        archivedTurns = new Set()
        index?.dispose()
        index = undefined
        setResult(EMPTY)
        sync()
      },
      { defer: true },
    ),
  )

  function sync(rerun = true) {
    clearTimeout(syncTimer)
    syncTimer = undefined
    paged = false
    const list = untrack(input.messages)
    const current = documentsOf(list)
    const byMessage = new Map<string, FindDoc[]>()
    current.forEach((doc) => byMessage.set(doc.messageID, [...(byMessage.get(doc.messageID) ?? []), doc]))
    const listedIDs = new Set(list.map((message) => message.id))
    // Removed messages leave the index: their matches could never be revealed.
    archive.forEach((_, id) => !listedIDs.has(id) && input.covers?.(id) && archive.delete(id))
    archivedTurns.forEach((turn) => !listedIDs.has(turn) && input.covers?.(turn) && archivedTurns.delete(turn))
    list.forEach((message) => archive.set(message.id, byMessage.get(message.id) ?? []))
    const listed = turnsOf(list)
    listed.forEach((turn) => archivedTurns.add(turn))
    // Usually the transcript still holds all of it: its order as it is. Else what it dropped goes in by id between the
    // messages it holds, which keep their order (a delivered steer moves to the end).
    const whole = archive.size === list.length
    const ids = whole ? list.map((message) => message.id) : merged(list.map((message) => message.id), archive.keys())
    const docs = whole ? current : ids.flatMap((id) => archive.get(id) ?? [])
    turns = whole ? listed : merged(listed, archivedTurns.keys())
    turnIndex = new Map(turns.map((turn, at) => [turn, at]))
    messageIndex = new Map(ids.map((id, at) => [id, at]))
    index ??= createFindIndex()
    const changed = index.sync(docs)
    synced = docs
    if (rerun && (changed || result() === EMPTY) && untrack(() => state.needle)) void run("docs")
  }

  const current = () => {
    const value = result()
    const hit = value.hits[state.active]
    const doc = hit ? value.docs[hit.doc] : undefined
    return hit && doc ? { doc, occurrence: hit.occurrence } : undefined
  }

  async function run(reason: "query" | "docs") {
    const token = ++runs
    const needle = state.needle
    const docs = synced
    const previous = untrack(current)
    setState("searching", true)
    const found = await (index ??= createFindIndex()).query(needle)
    if (token !== runs || !state.open) return
    const next: Result = { docs, ids: docIDs(docs), hits: found.hits, total: found.total }
    const active =
      reason === "query" || !previous
        ? startAt(found.hits, (doc) => turnIndex.get(docs[doc]?.turn ?? "") ?? 0, viewTurn())
        : keep(next, previous)
    batch(() => {
      setResult(next)
      setState({ active, searching: false })
    })
    clearTimeout(jumpTimer)
    if (reason === "query" && active >= 0) jumpTimer = setTimeout(jump, JUMP_DELAY)
    paint()
  }

  function keep(next: Result, previous: { doc: FindDoc; occurrence: number }) {
    const at = next.hits.findIndex(
      (hit) => next.docs[hit.doc]?.id === previous.doc.id && hit.occurrence === previous.occurrence,
    )
    return at >= 0 ? at : Math.min(Math.max(state.active, 0), next.hits.length - 1)
  }

  function viewTurn() {
    const root = input.scroller()
    return root ? topTurn(root, turns) : undefined
  }

  function leave(root: HTMLElement | undefined) {
    if (input.unpin) return input.unpin()
    if (root) leaveTail(root)
  }

  /** Brings the active match into view and centers it. */
  function jump() {
    clearTimeout(jumpTimer)
    const match = current()
    const root = input.scroller()
    if (!match || !root || !input.active()) return paint()
    cancelMove?.()
    leave(root)
    const revealed = input.reveal?.(match.doc.turn, match.doc.id)
    const token = ++jumps
    if (revealed) return void revealed.then(() => token === jumps && state.open && seek(match))
    seek(match)
  }

  function seek(match: { doc: FindDoc; occurrence: number }) {
    const needle = state.needle
    const doc = match.doc
    cancelMove = reach(
      input.scroller,
      turns,
      {
        turn: doc.turn,
        find: (scroller) =>
          collectRanges(scroller, needle, result().ids, { doc: doc.id, occurrence: match.occurrence }).current[0],
        anchor: (scroller) => partElement(scroller, doc.id),
        placed: centered,
        place: (scroller, range) => {
          centerBox(scroller, range)
          paint()
        },
        within: (scroller) => direction(scroller, doc),
      },
      () => paint(),
    )
    paint()
  }

  /** Inside a mounted turn, whether the document's part lies below (1) or above (-1) the mounted parts. */
  function direction(root: HTMLElement, doc: FindDoc): -1 | 1 {
    const want = messageIndex.get(doc.messageID) ?? 0
    const seen = [
      ...root.querySelectorAll<HTMLElement>(`[data-message-id="${CSS.escape(doc.turn)}"] [data-timeline-part-id]`),
    ]
      .map((element) => messageIndex.get((element.dataset.timelinePartId ?? "").split(":", 1)[0] ?? ""))
      .filter((index) => index !== undefined)
    return seen.length && want < Math.min(...seen) ? -1 : 1
  }

  function paint() {
    const root = input.scroller()
    if (!root || !state.open || !state.needle || !input.active()) return clearHighlights()
    const match = current()
    paintHighlights(
      collectRanges(root, state.needle, result().ids, match && { doc: match.doc.id, occurrence: match.occurrence }),
    )
  }

  // Rows mount and unmount while scrolling and streaming: paint again once per frame while there is a query.
  createEffect(() => {
    if (!state.open || !state.needle || !input.active()) return
    const root = input.scroller()
    if (!root) return
    let frame = 0
    const observer = new MutationObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        paint()
      })
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    paint()
    onCleanup(() => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      clearHighlights()
    })
  })

  return {
    state,
    result,
    current,
    count: () => result().total,
    capped: () => result().total > result().hits.length,
    more: input.more,
    loadingOlder: input.loadingOlder,
    open() {
      if (state.open) return void setState("focus", (value) => value + 1)
      setState({ open: true, focus: state.focus + 1 })
      sync(false)
      if (state.needle) void run("query")
    },
    close() {
      runs++
      jumps++
      archive = new Map()
      archivedTurns = new Set()
      clearTimeout(jumpTimer)
      cancelMove?.()
      clearTimeout(syncTimer)
      syncTimer = undefined
      index?.dispose()
      index = undefined
      synced = []
      setResult(EMPTY)
      setState({ open: false, active: -1, searching: false })
      clearHighlights()
    },
    setQuery(raw: string) {
      setState("query", raw)
      const needle = normalizeNeedle(raw)
      if (needle === state.needle) return
      setState("needle", needle)
      if (needle) return void run("query")
      runs++
      setResult(EMPTY)
      setState({ active: -1, searching: false })
      clearHighlights()
    },
    /** Next (+1) or previous (-1) match, wrapping. */
    move(delta: number) {
      const hits = result().hits.length
      if (!hits) return
      setState("active", (state.active + delta + hits) % hits)
      jump()
    },
    async loadOlder() {
      if (!input.more() || input.loadingOlder()) return
      await input.loadOlder().catch(() => undefined)
      sync()
    },
    /** `Ctrl+Alt+[` / `]`: the previous or next turn's start. Returns false when there is nothing to move to. */
    navigateTurn(delta: -1 | 1, retried = false) {
      const root = input.scroller()
      const order = turnsOf(untrack(input.messages))
      if (!root || !order.length) return false
      const at = topTurn(root, order)
      const start = at === undefined ? undefined : turnStart(root, order[at]!)
      // "Previous" first returns to the start of a turn that began above the view.
      const partly =
        delta < 0 &&
        at !== undefined &&
        (!start || start.getBoundingClientRect().top < root.getBoundingClientRect().top - 4)
      const target = Math.max(0, Math.min(order.length - 1, at === undefined ? 0 : partly ? at : at + delta))
      // The first turn the transcript holds: read the page before it, then move once more if that added older ones.
      if (delta < 0 && target === at && !retried && input.more() && !input.loadingOlder()) {
        void input.loadOlder().then(() => {
          if (turnsOf(untrack(input.messages))[0] !== order[0]) this.navigateTurn(delta, true)
        })
        return true
      }
      const turn = order[target]!
      cancelMove?.()
      leave(root)
      input.reveal?.(turn)
      cancelMove = reach(input.scroller, order, {
        turn,
        find: (scroller) => turnStart(scroller, turn),
        anchor: (scroller) => turnStart(scroller, turn),
        placed: atTop,
        place: alignTop,
        within: () => -1,
      })
      return true
    },
  }
}

export type SessionFindController = ReturnType<typeof createSessionFind>

/** `held` in its order with the ids of `extra` it does not hold put in by id before the first held id above them. */
function merged(held: readonly string[], extra: Iterable<string>) {
  const listed = new Set(held)
  const rest = [...extra].filter((id) => !listed.has(id)).toSorted()
  let next = 0
  const out = held.flatMap((id) => {
    const from = next
    while (next < rest.length && rest[next]! < id) next++
    return [...rest.slice(from, next), id]
  })
  return [...out, ...rest.slice(next)]
}

function fingerprint(message: SessionMessageInfo | undefined) {
  if (!message) return 0
  if (message.type === "user") return message.text.length
  if (message.type !== "assistant") return 0
  return message.content.reduce((sum, content) => sum + (content.type === "text" ? content.text.length + 1 : 1), 0)
}
