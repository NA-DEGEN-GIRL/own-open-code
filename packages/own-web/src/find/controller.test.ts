// Find over a transcript that holds a bounded part of a long session (03 §19.13, transcript/history.ts): matches of
// messages the transcript dropped stay, matches of removed messages go, the transcript's order is kept around them,
// and message navigation at the first held turn reads one older page and moves again only when that added a turn.
import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { createRoot, createSignal } from "solid-js"
import { createSessionFind } from "./controller"

const user = (id: number, text = `찾기 ${id}`) =>
  ({ type: "user", id: `msg_${String(id).padStart(3, "0")}`, text, time: { created: id } }) as SessionMessageInfo
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
/**
 * Waits for the index's answer: the controller syncs after SYNC_DELAY (150 ms) and then queries the worker, which on
 * a loaded PC (the parallel unit run, 2026-11-20) answered after a fixed 200 ms wait had already read the old order.
 */
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await settle(20)
}

function setup(initial: readonly SessionMessageInfo[], covers?: (id: string) => boolean) {
  const root = document.createElement("div")
  root.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 500 }) as DOMRect
  document.body.append(root)
  const calls = { older: 0, revealed: [] as string[], onOlder: undefined as (() => void) | undefined }
  return createRoot((dispose) => {
    const [messages, setMessages] = createSignal(initial)
    const find = createSessionFind({
      sessionID: () => "ses_1",
      messages,
      covers,
      active: () => true,
      scroller: () => root,
      reveal: (turn) => void calls.revealed.push(turn),
      more: () => true,
      loadingOlder: () => false,
      loadOlder: async () => {
        calls.older++
        calls.onOlder?.()
      },
    })
    /** Mounts the rows of these turns, the first at the top of the view. */
    const mount = (ids: readonly string[]) => {
      root.replaceChildren(
        ...ids.map((id, index) => {
          const row = document.createElement("div")
          row.dataset.messageId = id
          row.dataset.timelineRow = "UserMessage"
          row.getBoundingClientRect = () => ({ top: 10 + index * 100, bottom: 100 + index * 100 }) as DOMRect
          return row
        }),
      )
    }
    const order = () => find.result().docs.map((doc) => doc.messageID)
    return { find, setMessages, mount, calls, order, dispose: () => (dispose(), root.remove()) }
  })
}

describe("find over a bounded transcript", () => {
  test("dropped messages stay searchable in session order; removed ones go; a moved steer keeps its place", async () => {
    // A view holds messages 4 to 6; it covers from 4 on (1 to 3 are dropped pages, not removed messages).
    const view = setup([user(1), user(2), user(3)], (id) => id >= user(4).id)
    view.find.open()
    view.find.setQuery("찾기")
    await settle()
    // The view drops 1 to 3 and holds 4, 6 and 5 (a steer delivered last moves to the end of the list).
    view.setMessages([user(4), user(6), user(5)])
    await until(() => view.order().length === 6)
    expect(view.order()).toEqual([1, 2, 3, 4, 6, 5].map((id) => user(id).id))
    // 6 is removed (a committed revert): the view covers it but no longer lists it.
    view.setMessages([user(4), user(5)])
    await until(() => view.order().length === 5)
    expect(view.order()).toEqual([1, 2, 3, 4, 5].map((id) => user(id).id))
    expect(view.find.count()).toBe(5)
    view.dispose()
  })

  test("previous message at the first held turn reads one older page, and moves only when it added a turn", async () => {
    const view = setup([user(10), user(11)])
    view.mount([user(10).id, user(11).id])
    expect(view.find.navigateTurn(-1)).toBe(true)
    await settle()
    // The read added nothing: no second read, no move.
    expect(view.calls.older).toBe(1)
    expect(view.calls.revealed).toEqual([])
    view.calls.onOlder = () => view.setMessages([user(9), user(10), user(11)])
    view.find.navigateTurn(-1)
    await settle()
    expect(view.calls.older).toBe(2)
    expect(view.calls.revealed).toEqual([user(9).id])
    view.dispose()
  })
})
