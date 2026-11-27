// A transcript view's own pages (history.ts) over an in-memory server with core's cursor contract (a cursor reads
// the messages before (`next`) or after (`previous`) its message, newest first): the first page meets the store's
// newest messages, paging up and dropping far pages keeps a bounded number, newer pages join the store's messages
// again, a dropped page is read again by the cursor that read it, a reread of the store's newest messages is bridged,
// and the start of the session ends the paging. Pages are cut by a committed revert, a live event reads a page-only
// message again, reads in flight are dropped by a jump, and pages never keep tool file bytes.
import { describe, expect, test } from "bun:test"
import type { MessageListInput, SessionMessageInfo, SessionMessagesResponse } from "@opencode/client/promise"
import { createRoot, createSignal } from "solid-js"
import { createHistory, PAGE } from "./history"

const message = (index: number): SessionMessageInfo => ({
  id: `msg_${String(index).padStart(6, "0")}`,
  type: "user",
  text: `${index}번째 요청`,
  time: { created: index },
})

function setup(count: number, tailSize = 30) {
  const server = {
    messages: Array.from({ length: count }, (_, index) => message(index)),
    reads: 0,
    gets: 0,
    limits: [] as number[],
  }
  const cursor = (id: string, direction: "next" | "previous") => JSON.stringify({ id, direction })
  const read = async (input: Omit<MessageListInput, "sessionID">): Promise<SessionMessagesResponse> => {
    server.reads++
    const limit = input.limit ?? 50
    server.limits.push(limit)
    const all = server.messages
    const decoded = input.cursor ? (JSON.parse(input.cursor) as { id: string; direction: string }) : undefined
    const at = decoded ? all.findIndex((item) => item.id === decoded.id) : all.length
    const slice =
      decoded?.direction === "previous" ? all.slice(at + 1, at + 1 + limit) : all.slice(Math.max(0, at - limit), at)
    const data = slice.toReversed()
    return {
      data,
      cursor: {
        previous: data[0] ? cursor(data[0].id, "previous") : null,
        next: data.at(-1) ? cursor(data.at(-1)!.id, "next") : null,
      },
    }
  }
  return createRoot((dispose) => {
    const [tail, setTail] = createSignal<readonly SessionMessageInfo[]>(server.messages.slice(-tailSize))
    const history = createHistory({
      read,
      get: async (id) => {
        server.gets++
        return server.messages.find((item) => item.id === id)!
      },
      tail,
      held: (id) => tail().some((item) => item.id === id),
      tailMore: () => tail()[0]?.id !== server.messages[0]?.id,
    })
    const ids = () => history.source().map((item) => Number(item.id.slice(4)))
    return { server, history, tail, setTail, ids, dispose }
  })
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe("a transcript view's own pages", () => {
  test("the first page meets the store's newest messages: one read, then a page per read", async () => {
    const view = setup(1000)
    expect(view.ids()).toEqual(range(970, 1000))
    await view.history.older()
    expect(view.server.reads).toBe(1)
    expect(view.ids()).toEqual(range(950, 1000))
    expect(view.history.detached()).toBe(false)
    await view.history.older()
    await view.history.older()
    expect(view.ids()).toEqual(range(910, 1000))
    expect(view.server.reads).toBe(3)
    view.dispose()
  })

  test("paging far up keeps a bounded number of messages; newer pages read again meet the store's", async () => {
    const view = setup(5000)
    for (let page = 0; page < 200; page++) {
      await view.history.older()
      // As the transcript does: the window at the top, MARGIN-like room below it.
      view.history.keep(0, 300)
    }
    // 200 pages up: about 4,000 messages read, at most 300 (+ one page) held, none of the store's.
    expect(view.history.source().length).toBeLessThanOrEqual(300 + PAGE)
    expect(view.history.detached()).toBe(true)
    expect(view.ids()[0]).toBe(5000 - 30 - 200 * PAGE)
    expect(view.history.more()).toBe(true)
    // Back down: each read adds the next newer page until it reaches the store's first message.
    for (let page = 0; page < 300 && view.history.detached(); page++) {
      await view.history.newer()
      const length = view.history.source().length
      view.history.keep(length - 300, length)
    }
    expect(view.history.detached()).toBe(false)
    const ids = view.ids()
    expect(ids.at(-1)).toBe(4999)
    // One sequence, nothing missing or doubled where the pages meet the store's messages.
    expect(ids).toEqual(range(ids[0]!, 5000))
    view.dispose()
  })

  test("a dropped page is read again alone by the cursor that read it, and newer pages follow from it", async () => {
    const view = setup(2000)
    for (let page = 0; page < 30; page++) await view.history.older()
    const dropped = message(1500).id
    view.history.keep(0, 100)
    expect(view.history.source().some((item) => item.id === dropped)).toBe(false)
    const reads = view.server.reads
    expect(await view.history.around(dropped)).toBe(true)
    expect(view.server.reads).toBe(reads + 1)
    const ids = view.ids()
    expect(ids).toContain(1500)
    expect(ids.length).toBeLessThanOrEqual(PAGE)
    expect(ids).toEqual(range(ids[0]!, ids[0]! + ids.length))
    await view.history.newer()
    expect(view.ids()).toEqual(range(ids[0]!, ids.at(-1)! + 1 + PAGE))
    // The store's own message: the view returns to the store's messages.
    expect(await view.history.around(message(1990).id)).toBe(true)
    expect(view.ids()).toEqual(range(1970, 2000))
    // Never read by this view: not found.
    expect(await view.history.around(message(5).id)).toBe(false)
    view.dispose()
  })

  test("the first page read again: its cursor comes from the page read before it", async () => {
    const view = setup(400)
    await view.history.older()
    await view.history.older()
    // The page read first goes; it was read without a cursor of its own.
    view.history.keep(0, PAGE)
    expect(view.ids()).toEqual(range(330, 350))
    expect(await view.history.around(message(365).id)).toBe(true)
    expect(view.ids()).toEqual(range(350, 370))
    expect(await view.history.around(message(375).id)).toBe(true)
    expect(view.ids()).toEqual(range(370, 400))
    view.dispose()
  })

  test("after the store read its newest messages again, newer pages bridge to them", async () => {
    const view = setup(1000)
    for (let page = 0; page < 3; page++) await view.history.older()
    // A reconnect: 50 messages arrived meanwhile, the store holds the newest 30 again.
    view.server.messages.push(...range(1000, 1050).map(message))
    view.setTail(view.server.messages.slice(-30))
    expect(view.history.detached()).toBe(true)
    expect(view.ids()).toEqual(range(910, 970))
    await view.history.newer()
    expect(view.history.detached()).toBe(false)
    expect(view.ids()).toEqual(range(910, 1050))
    view.dispose()
  })

  test("the start of the session ends the paging", async () => {
    const view = setup(45)
    await view.history.older()
    expect(view.ids()).toEqual(range(0, 45))
    expect(view.history.more()).toBe(false)
    const reads = view.server.reads
    await view.history.older()
    expect(view.server.reads).toBe(reads)
    view.dispose()
  })

  test("a store that holds the whole session asks nothing", async () => {
    const view = setup(30)
    expect(view.history.more()).toBe(false)
    await view.history.older()
    expect(view.server.reads).toBe(0)
    expect(view.ids()).toEqual(range(0, 30))
    view.dispose()
  })

  test("a revert committed before the store's first message cuts the pages, which then meet what streams in", async () => {
    const view = setup(1000)
    for (let page = 0; page < 3; page++) await view.history.older()
    // The store's handler spliced its whole list (every message it held is from the boundary on).
    view.server.messages = view.server.messages.filter((item) => item.id < message(940).id)
    view.setTail([])
    view.history.cut(message(940).id)
    expect(view.ids()).toEqual(range(910, 940))
    expect(view.history.detached()).toBe(false)
    expect(view.history.more()).toBe(true)
    view.server.messages.push(message(2000))
    view.setTail([message(2000)])
    expect(view.ids()).toEqual([...range(910, 940), 2000])
    view.dispose()
  })

  test("a revert committed at the first page's start leaves nothing held: the newest remaining are read", async () => {
    const view = setup(1000)
    await view.history.older()
    view.server.messages = view.server.messages.filter((item) => item.id < message(950).id)
    view.setTail([])
    view.history.cut(message(950).id)
    await settle()
    expect(view.ids()).toEqual(range(930, 950))
    expect(view.history.detached()).toBe(false)
    view.dispose()
  })

  test("a revert committed under pages far up cuts them; the gap and the store's list are gone", async () => {
    const view = setup(3000)
    for (let page = 0; page < 40; page++) {
      await view.history.older()
      view.history.keep(0, 300)
    }
    expect(view.history.detached()).toBe(true)
    const first = view.ids()[0]!
    view.server.messages = view.server.messages.filter((item) => item.id < message(first + 100).id)
    view.setTail([])
    view.history.cut(message(first + 100).id)
    expect(view.ids()).toEqual(range(first, first + 100))
    expect(view.history.detached()).toBe(false)
    view.dispose()
  })

  test("while detached the view holds the store's messages too, and covers what lies in them", async () => {
    const view = setup(3000)
    for (let page = 0; page < 40; page++) {
      await view.history.older()
      view.history.keep(0, 300)
    }
    const ids = view.history.all().map((item) => Number(item.id.slice(4)))
    expect(ids.slice(-30)).toEqual(range(2970, 3000))
    expect(view.history.covers(message(2990).id)).toBe(true)
    expect(view.history.covers(message(view.ids()[0]! + 5).id)).toBe(true)
    // Between the pages and the store's messages: dropped, not removed.
    expect(view.history.covers(message(2900).id)).toBe(false)
    expect(view.history.gapAfter(message(view.ids()[0]!).id)).toBe(true)
    expect(view.history.gapAfter(message(2990).id)).toBe(false)
    view.dispose()
  })

  test("a live event for a message only the pages hold reads it again, once for a burst", async () => {
    const view = setup(1000)
    await view.history.older()
    const target = message(955)
    const changed: SessionMessageInfo = { ...target, type: "user", text: "고친 요청" }
    view.server.messages[955] = changed
    for (let event = 0; event < 5; event++) view.history.refresh((item) => item.id === target.id)
    // The store's own message is the store's to update.
    view.history.refresh((item) => item.id === message(990).id)
    await settle(500)
    expect(view.server.gets).toBe(1)
    expect(view.history.source().find((item) => item.id === target.id)).toEqual(changed)
    view.dispose()
  })

  test("a jump to the newest message drops a page read in flight; so does a later reveal", async () => {
    const view = setup(2000)
    for (let page = 0; page < 30; page++) await view.history.older()
    view.history.keep(0, 100)
    const first = view.history.around(message(1500).id)
    view.history.reset()
    expect(await first).toBe(false)
    expect(view.history.detached()).toBe(false)
    expect(view.ids()).toEqual(range(1970, 2000))
    for (let page = 0; page < 30; page++) await view.history.older()
    view.history.keep(0, 100)
    const earlier = view.history.around(message(1500).id)
    const later = view.history.around(message(1990).id)
    expect(await later).toBe(true)
    expect(await earlier).toBe(false)
    expect(view.ids()).toEqual(range(1970, 2000))
    view.dispose()
  })

  test("climbing again after a jump reads only the page before the store's messages, by its cursor", async () => {
    const view = setup(1000, 200)
    await view.history.older()
    await view.history.older()
    expect(view.server.limits).toEqual([200 + PAGE, PAGE])
    view.history.reset()
    await view.history.older()
    expect(view.server.limits.at(-1)).toBe(PAGE)
    expect(view.ids()).toEqual(range(780, 1000))
    await view.history.older()
    expect(view.ids()).toEqual(range(760, 1000))
    view.dispose()
  })

  test("pages never keep tool file bytes, whatever the server sends", async () => {
    const view = setup(100)
    const shot = {
      id: message(50).id,
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      content: [
        {
          type: "tool",
          id: "call_1",
          name: "screenshot",
          state: {
            status: "completed",
            input: {},
            content: [{ type: "file", uri: "data:image/png;base64,QUJDRA==", mime: "image/png" }],
          },
        },
      ],
      time: { created: 50 },
    } as unknown as SessionMessageInfo
    view.server.messages[50] = shot
    await view.history.older()
    const held = view.history.source().find((item) => item.id === shot.id)
    expect(JSON.stringify(held)).toContain('"uri":"data:image/png;base64,"')
    expect(JSON.stringify(held)).not.toContain("QUJDRA")
    // Messages without bytes keep their identity.
    expect(view.history.source().find((item) => item.id === message(51).id)).toBe(view.server.messages[51])
    view.dispose()
  })
})
