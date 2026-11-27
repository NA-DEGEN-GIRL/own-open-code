// A transcript view's older pages (03 §20.2, the 2026-11 huge-session bench). The store (`createData`) keeps the
// session's newest messages: the first read, a leading turn's pages and what streams in. Pages older than those are
// this view's own: read by cursor in both directions, dropped once they are far from the window (`keep`) and read again
// when the user comes back, so scrolling to any depth holds a bounded number of messages. The store kept every page it
// read (about 25 KB per message: a renderer near its 4 GB limit after some 150k messages).
//
// The pages and the store's messages form one sequence while they meet (`joined`): the page read first ends right
// before the store's first message. Moving far up drops the newest pages, so the view then shows pages that end
// before the store's messages begin (`detached`); reading newer pages joins them again where a page reaches a message
// the store holds.
//
// Pages are snapshots: a live event for a message only they hold (a background shell, a subagent's progress) reads
// that message again (`refresh`), and a committed revert cuts them (`cut`).
import type {
  MessageListInput,
  SessionMessageInfo,
  SessionMessagesResponse,
  ToolContent,
} from "@opencode/client/promise"
import { batch, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"

/** Messages per page read. */
export const PAGE = 20
/** Bridge reads after a jump: a few larger reads from the newest message, then the view returns to the tail. */
const BRIDGE = [1, 5, 25]
/** Live events for page-only messages are gathered this long before the messages are read again. */
const REFRESH = 400

export type HistoryRead = (input: Omit<MessageListInput, "sessionID">) => Promise<SessionMessagesResponse>

interface Page {
  /** Oldest first. */
  readonly messages: readonly SessionMessageInfo[]
  /** Reads the messages before this page; unset at the start of the session. */
  readonly older?: string
  /** Reads the messages after it; unset where the store's messages follow, or where it was cut at them. */
  readonly newer?: string
}

/** A page this view read, and the cursor that reads it again (unset until a neighbour's cursor is known). */
interface Entry {
  readonly first: string
  last: string
  count: number
  via?: string
}

export function createHistory(input: {
  readonly read: HistoryRead
  /** Reads one message again (a live event changed it). */
  readonly get: (messageID: string) => Promise<SessionMessageInfo>
  /** The store's messages of the session: its newest, oldest first. */
  readonly tail: Accessor<readonly SessionMessageInfo[]>
  /** The store holds the message. */
  readonly held: (messageID: string) => boolean
  /** The store has older messages than it holds. */
  readonly tailMore: Accessor<boolean>
}) {
  const [pages, setPages] = createSignal<readonly Page[]>([])
  /**
   * The store's message right after the newest page, while the two meet; `""` when the pages end the session and the
   * store holds nothing (a revert committed before its first message): what streams in next follows them.
   */
  const [join, setJoin] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  /** No message is older than the store's (an empty first read). */
  const [start, setStart] = createSignal(false)
  /** The pages this view read, by their first message (a page read again replaces its entry). */
  const entries = new Map<string, Entry>()
  /** The page right before the store's first message, kept across a reset: climbing again reads only it. */
  let crossing: { readonly first: string; readonly entry: Entry } | undefined
  /** Bumped by `reset`, `around` and `stop`: a read that started before them is dropped. */
  let epoch = 0
  const stale = new Set<string>()
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(refreshTimer))

  const joined = () => {
    const at = join()
    return at === "" || (at !== undefined && input.held(at))
  }
  const detached = () => pages().length > 0 && !joined()
  const loaded = createMemo(() => pages().flatMap((page) => page.messages))
  /** What the view shows from: the pages and the store's messages while they meet, else the pages alone. */
  const source = createMemo<readonly SessionMessageInfo[]>(() => {
    const tail = input.tail()
    const older = loaded()
    if (older.length === 0) return tail
    if (!joined()) return older
    // The store may have read further back since (a leading turn, the fork dialog): it keeps those.
    return [...older.filter((message) => !input.held(message.id)), ...tail]
  })
  /** Every message the view holds: the source, and the store's messages too while the pages do not meet them. */
  const all = createMemo(() => (detached() ? [...loaded(), ...input.tail()] : source()))

  async function run(read: () => Promise<SessionMessagesResponse>) {
    setLoading(true)
    return read()
      .then((response) => ({ ...response, data: response.data.map(lean) }))
      .catch((error: unknown) => void console.warn("[own-web] transcript page read failed", error))
      .finally(() => setLoading(false))
  }

  function record(messages: readonly SessionMessageInfo[], via: string | undefined) {
    const first = messages[0]
    const last = messages.at(-1)
    if (!first || !last) return undefined
    const known = entries.get(first.id)
    // The same page read again keeps the cursor that reads it (a cursor reads `count` messages).
    const kept = known?.count === messages.length ? known.via : undefined
    const entry = Object.assign(known ?? { first: first.id }, { last: last.id, count: messages.length, via: via ?? kept })
    entries.set(first.id, entry)
    return entry
  }

  function page(response: SessionMessagesResponse, messages: readonly SessionMessageInfo[], limit: number): Page {
    return {
      messages,
      // A short page reached the start; the server still names a cursor, which would read nothing.
      ...(response.data.length < limit || !response.cursor.next ? {} : { older: response.cursor.next }),
      ...(response.cursor.previous ? { newer: response.cursor.previous } : {}),
    }
  }

  /**
   * The page right before the store's first message. Read by its own cursor once a climb found it (the page before it
   * named it); else the newest messages again plus PAGE older ones, in one read (the store keeps no cursor for us).
   */
  async function cross() {
    const first = input.tail()[0]
    if (start() || !input.tailMore()) return
    const token = epoch
    const known = first && crossing?.first === first.id ? crossing.entry : undefined
    if (known?.via) {
      const response = await run(() => input.read({ cursor: known.via, limit: known.count }))
      const messages = response?.data.toReversed() ?? []
      if (!response || token !== epoch || pages().length > 0 || !input.held(first!.id)) return
      if (messages.at(-1)?.id === known.last) return place(page(response, messages, known.count), first!.id)
    }
    const limit = (first ? input.tail().length : 0) + PAGE
    const response = await run(() => input.read({ order: "desc", limit }))
    if (!response || token !== epoch || pages().length > 0 || (first && !input.held(first.id))) return
    const at = first ? response.data.findIndex((message) => message.id === first.id) : -1
    // Messages arrived during the read and pushed it past the read's end: the next scroll asks again.
    if (first && at < 0) return
    const messages = response.data.slice(at + 1).toReversed()
    if (messages.length === 0) return void setStart(true)
    // Its cursor is known once the page before it is read (its `newer`).
    const entry = record(messages, undefined)
    if (first && entry) crossing = { first: first.id, entry }
    place(page(response, messages, limit), first?.id ?? "")
  }

  /** The crossing page alone: its `newer` would read the store's messages, which the view has. */
  function place(crossed: Page, at: string) {
    batch(() => {
      setPages([{ messages: crossed.messages, ...(crossed.older ? { older: crossed.older } : {}) }])
      setJoin(at)
    })
  }

  async function older() {
    if (loading()) return
    const head = pages()[0]
    if (!head) return cross()
    const cursor = head.older
    if (!cursor) return
    const response = await run(() => input.read({ cursor, limit: PAGE }))
    if (!response || pages()[0]?.older !== cursor) return
    const messages = response.data.toReversed()
    if (messages.length === 0)
      return void setPages(([current, ...rest]) => [
        { messages: current!.messages, ...(current!.newer ? { newer: current!.newer } : {}) },
        ...rest,
      ])
    record(messages, cursor)
    // This read's `previous` reads the page after it again, whatever cursor read that one.
    const next = entries.get(head.messages[0]?.id ?? "")
    if (next && !next.via && response.cursor.previous) {
      next.via = response.cursor.previous
      next.count = head.messages.length
    }
    setPages((list) => [page(response, messages, PAGE), ...list])
  }

  /** Reads the messages after the newest page until they meet the store's. */
  async function newer() {
    if (loading() || joined()) return
    const last = pages().at(-1)
    const newest = last?.messages.at(-1)
    if (!last || !newest) return
    const cursor = last.newer
    if (!cursor) return bridge(newest.id)
    const response = await run(() => input.read({ cursor, limit: PAGE }))
    if (!response || pages().at(-1)?.newer !== cursor) return
    append(response, response.data.toReversed(), cursor)
  }

  /**
   * After the store read its newest messages again (a reconnect), or past a page that was cut where it met them, no
   * cursor reads on from the newest page: the newest messages are read until the read reaches that page.
   */
  async function bridge(newestID: string) {
    const token = epoch
    for (const size of BRIDGE) {
      const response = await run(() => input.read({ order: "desc", limit: input.tail().length + PAGE * size }))
      if (!response || token !== epoch || pages().at(-1)?.messages.at(-1)?.id !== newestID) return
      const at = response.data.findIndex((message) => message.id === newestID)
      if (at >= 0) return append(response, response.data.slice(0, at).toReversed(), undefined)
      if (response.data.length < input.tail().length + PAGE * size) break
    }
    // Too far behind: the view starts again from the store's messages.
    reset()
  }

  /**
   * Adds what came after the newest page, up to the first message the store holds (they meet there). A bridge read
   * (no `via`) extends the newest page instead: its cursors name messages outside what it adds.
   */
  function append(response: SessionMessagesResponse, after: readonly SessionMessageInfo[], via: string | undefined) {
    const at = after.findIndex((message) => input.held(message.id))
    const messages = at < 0 ? after : after.slice(0, at)
    // Nothing newer and none of it held: the store's first message comes next.
    const meets = at >= 0 ? after[at]!.id : after.length === 0 ? input.tail()[0]?.id : undefined
    record(messages, via)
    const last = pages().at(-1)!
    const added: Page =
      via === undefined
        ? { messages: [...last.messages, ...messages], ...(last.older ? { older: last.older } : {}) }
        : {
            messages,
            ...(response.cursor.next ? { older: response.cursor.next } : {}),
            // Cut where the store's messages begin: its `previous` would skip the rest.
            ...(at < 0 && response.cursor.previous ? { newer: response.cursor.previous } : {}),
          }
    batch(() => {
      if (messages.length > 0) setPages((list) => (via === undefined ? [...list.slice(0, -1), added] : [...list, added]))
      if (meets) setJoin(meets)
    })
  }

  /**
   * Brings a message this view has read back (find, message navigation): from the store when it holds it, else the
   * page it was on, read again alone. False when it cannot be read again, or when a later reset or `around` came first.
   */
  async function around(messageID: string) {
    const token = ++epoch
    if (input.held(messageID)) {
      if (joined() || pages().length === 0) return true
      reset()
      return true
    }
    if (loaded().some((message) => message.id === messageID)) return true
    const entry = [...entries.values()].findLast(
      (item) => item.via !== undefined && item.first <= messageID && messageID <= item.last,
    )
    const via = entry?.via
    if (!entry || !via) return false
    const response = await run(() => input.read({ cursor: via, limit: entry.count }))
    if (!response || token !== epoch) return false
    const messages = response.data.toReversed()
    if (!messages.some((message) => message.id === messageID)) return false
    batch(() => {
      setPages([page(response, messages, entry.count)])
      setJoin(undefined)
    })
    return true
  }

  /** Drops the pages outside `[from, to)` of `source()`; the store's messages stay. */
  function keep(from: number, to: number) {
    const list = pages()
    let end = 0
    const kept = list.filter((item) => {
      const begin = end
      end += item.messages.length
      return end > from && begin < to
    })
    if (kept.length === list.length) return
    batch(() => {
      if (kept.at(-1) !== list.at(-1)) setJoin(undefined)
      setPages(kept)
    })
  }

  /**
   * A revert committed at `to` deleted every message from it on. The store cut its list there; when it held nothing
   * older (its list is empty now), the pages are cut too and end the session, so they meet what streams in next.
   */
  function cut(to: string) {
    const first = input.tail()[0]
    if (first && first.id < to) return
    entries.forEach((entry, key) => {
      if (key >= to) return void entries.delete(key)
      if (entry.last < to) return
      entry.last = loaded().findLast((message) => message.id < to)?.id ?? entry.first
      entry.via = undefined
    })
    if (crossing && crossing.first >= to) crossing = undefined
    const list = pages().flatMap((item) => {
      const messages = item.messages.filter((message) => message.id < to)
      if (messages.length === item.messages.length) return [item]
      return messages.length ? [{ messages, ...(item.older ? { older: item.older } : {}) }] : []
    })
    epoch++
    batch(() => {
      setPages(list)
      setJoin(list.length ? "" : undefined)
    })
    // Nothing left to show: read the newest messages that remain.
    if (list.length === 0 && input.tail().length === 0) void cross()
  }

  /** A live event changed a message: read it again when only the pages hold it (`match` picks it). */
  function refresh(match: (message: SessionMessageInfo) => boolean) {
    const target = loaded().find((message) => match(message) && !input.held(message.id))
    if (!target) return
    stale.add(target.id)
    refreshTimer ??= setTimeout(flush, REFRESH)
  }

  function flush() {
    refreshTimer = undefined
    const ids = [...stale]
    stale.clear()
    ids.forEach((messageID) =>
      input
        .get(messageID)
        .then((fresh) => {
          const message = lean(fresh)
          setPages((list) =>
            list.map((item) =>
              item.messages.some((old) => old.id === messageID)
                ? { ...item, messages: item.messages.map((old) => (old.id === messageID ? message : old)) }
                : item,
            ),
          )
        })
        .catch((error: unknown) => console.warn("[own-web] transcript message read failed", error)),
    )
  }

  function reset() {
    epoch++
    batch(() => {
      setPages([])
      setJoin(undefined)
      setStart(false)
    })
  }

  return {
    source,
    /** The pages' messages (without the store's). */
    loaded,
    /** Every message the view holds, oldest first (a gap lies between the pages and the store's while detached). */
    all,
    loading,
    /** Older messages exist that the view has not read. */
    more: () => {
      const head = pages()[0]
      return head ? head.older !== undefined : !start() && input.tailMore()
    },
    /** The pages end before the store's messages begin: newer messages are read before the tail shows. */
    detached,
    /** Messages the view does not hold lie between this message and the newest (the pages do not meet the store's). */
    gapAfter: (messageID: string) => detached() && messageID <= (loaded().at(-1)?.id ?? ""),
    /**
     * The view would hold this message if it still existed: within its pages, or from the store's first message on
     * (from the pages' first while they meet). Message ids sort in session order.
     */
    covers: (messageID: string) => {
      const older = loaded()
      const head = older[0]
      if (head && messageID >= head.id && (joined() || messageID <= older.at(-1)!.id)) return true
      const first = input.tail()[0]
      return first !== undefined && messageID >= first.id
    },
    /** Changes when a reset or `around` drops what was read before it. */
    mark: () => epoch,
    /** Drops the reads in flight (the user jumped to the newest message). */
    stop: () => void epoch++,
    older,
    newer,
    around,
    keep,
    cut,
    refresh,
    reset,
  }
}

export type TranscriptHistory = ReturnType<typeof createHistory>

/**
 * A message without its tool results' inline file bytes, as the store keeps it (client `omitToolFileData`): a server
 * without core P-055 sends them in every page. The URI is built from `mime`, since a slice of the original keeps the
 * whole payload alive; a message that has none keeps its identity.
 */
function lean(message: SessionMessageInfo): SessionMessageInfo {
  if (message.type !== "assistant" || !message.content.some(heavy)) return message
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "tool" && "content" in part.state && part.state.content && heavy(part)
        ? { ...part, state: { ...part.state, content: part.state.content.map(omit) as typeof part.state.content } }
        : part,
    ),
  }
}

function heavy(part: Extract<SessionMessageInfo, { type: "assistant" }>["content"][number]) {
  return (
    part.type === "tool" &&
    "content" in part.state &&
    !!part.state.content?.some((item) => item.type === "file" && item.uri.startsWith("data:") && !item.uri.endsWith(","))
  )
}

function omit(item: ToolContent): ToolContent {
  return item.type === "file" && item.uri.startsWith("data:") ? { ...item, uri: `data:${item.mime};base64,` } : item
}
