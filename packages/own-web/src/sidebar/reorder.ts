// Moving and pinning in the sidebar (03 §4.3 "순서와 고정"): projects within their server, server sections among
// themselves. A lazy chunk, loaded once the window is idle: the first chunk only reads the order (PF5).
//
// - Mouse: a header dragged 5 px. Touch and pen: a long press (a scroll or a swipe that starts sooner is the page's, and
//   a drag that has begun ends the swipe, shell/swipe.ts); a long press that does not move opens the header's `⋯`, like
//   a row's. Ctrl+Shift+↑/↓ on a focused header, and `위로 이동` / `아래로 이동` in its `⋯`, move one place.
// - While dragging, what is being ordered folds to its headers so every place is near; a line shows where it lands, the
//   list scrolls near its edges, and Esc (or another finger, or the window losing focus) puts everything back.
// - Pinned projects stay first, so a drag moves a project among the pinned ones or among the others; `고정` in the menu
//   moves it between the two. Nothing moves to another server.
// - Saved by the server's service (project-list.ts) or this browser (the sections, servers/order.ts), and said aloud.
import { type Locale } from "@/i18n"
import { LOCAL } from "@/data"
import { nextFrame } from "@/data/frame"
import { catalogText } from "@/projects/text"
import type { MenuItem } from "@/servers/menu"
import { arrangedServers, arrangeServers, serverOrder } from "@/servers/order"
import { showToast } from "@/switcher/toast"
import { placed, type ProjectListView } from "./arrange"
import type { SidebarController } from "./controller"
import { rowKey } from "./model"
import { setFolding, setReorder } from "./reorder-api"
import { sidebarText } from "./strings"

const text = catalogText(
  {
    up: "위로 이동",
    down: "아래로 이동",
    reset: "기본 순서로 되돌리기",
    moved: "{name}: {n}개 중 {at}번째로 옮겼어요",
    dragging: "{name} 옮기는 중이에요. 취소하려면 Esc를 누르세요.",
    cancelled: "옮기기를 취소했어요",
    pinned: "{name} 고정됨",
    unpinned: "{name} 고정 해제됨",
    wasReset: "기본 순서로 되돌렸어요",
    failed: "목록 순서를 저장하지 못했어요",
  },
  {
    up: "Move up",
    down: "Move down",
    reset: "Reset to the default order",
    moved: "{name} moved to {at} of {n}",
    dragging: "Moving {name}. Press Esc to cancel.",
    cancelled: "Move cancelled",
    pinned: "{name} pinned",
    unpinned: "{name} unpinned",
    wasReset: "Back to the default order",
    failed: "Could not save the order",
  },
)

const SLOP = 5
const TOUCH_SLOP = 10
const LONG_PRESS_MS = 420
const EDGE = 40
/** Up or down, not just to the side: the list that folded may have moved under a pointer that did not. */
const VERTICAL = 14

interface Press {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly item: HTMLElement
  readonly touch: boolean
  /** The long press has passed: a move drags, letting go opens the menu. */
  armed: boolean
  timer?: ReturnType<typeof setTimeout>
  drag?: ReturnType<typeof startDrag>
}

/** What can be ordered together: the ids in their order, and what putting one elsewhere does. */
interface Lane {
  readonly ids: readonly string[]
  readonly element: (id: string) => HTMLElement | null
  /** Where their headers are on screen now. */
  readonly boxes: () => readonly { readonly top: number; readonly bottom: number }[]
  readonly name: string
  readonly fold: string
  readonly move: (index: number) => void
}

export function mountReorder(input: {
  readonly scroller: HTMLElement
  readonly locale: () => Locale
  readonly controller: (serverKey: string) => SidebarController | undefined
}) {
  const { scroller } = input
  const t = (key: Parameters<typeof text>[1], params?: Parameters<typeof text>[2]) => text(input.locale(), key, params)
  const status = document.createElement("div")
  status.className = "own-sr-only"
  status.setAttribute("role", "status")
  status.dataset.testid = "sidebar-announce"
  scroller.parentElement?.append(status)
  const say = (message: string) => {
    status.textContent = message
  }

  // ---- projects

  const inArchive = (ctl: SidebarController) => ctl.archiveView() || ctl.searching()

  /** Projects of the same kind as `projectID`: the pinned ones, or the others. */
  const lane = (ctl: SidebarController, projectID: string) => {
    const pinned = ctl.pinnedProject(projectID)
    return ctl.projectIDs().filter((id) => ctl.pinnedProject(id) === pinned)
  }

  const saves = new WeakMap<object, Promise<unknown>>()

  async function save(ctl: SidebarController, patch: { pinned?: readonly string[]; order?: readonly string[] | null }) {
    const before = ctl.list.view()
    const next: ProjectListView = {
      pinned: patch.pinned ?? before.pinned,
      order: patch.order === undefined ? before.order : patch.order,
      orderedAt: patch.order === undefined ? before.orderedAt : patch.order && Date.now(),
    }
    if (ctl.list.unsupported()) return ctl.list.apply(next, true)
    ctl.list.apply(next)
    ctl.list.hold(1)
    // One at a time: the answer to the last change is the list, whatever the earlier ones answered meanwhile.
    const job = (saves.get(ctl.list) ?? Promise.resolve()).then(() =>
      ctl.runtime.rpc.call("projectList.set", patch).catch((error: unknown) => {
        console.warn("[own-web] project order was not saved", error)
      }),
    )
    saves.set(ctl.list, job)
    const saved = await job
    const last = ctl.list.hold(-1) === 0
    if (last) ctl.list.apply(saved ?? before)
    if (!saved) showToast({ message: t("failed"), tone: "danger" })
  }

  function moveProject(ctl: SidebarController, projectID: string, index: number) {
    const ids = lane(ctl, projectID)
    const list = ctl.list.view()
    const next = placed(ids, ctl.pinnedProject(projectID) ? list.pinned : (list.order ?? []), projectID, index)
    void save(ctl, ctl.pinnedProject(projectID) ? { pinned: next } : { order: next })
    say(t("moved", { name: nameOf(ctl, projectID), n: ids.length, at: index + 1 }))
  }

  function pin(ctl: SidebarController, projectID: string, on: boolean) {
    const pinned = ctl.list.view().pinned.filter((id) => id !== projectID)
    void save(ctl, { pinned: on ? [...pinned, projectID] : pinned })
    say(t(on ? "pinned" : "unpinned", { name: nameOf(ctl, projectID) }))
    focusLater(() => rowOf(ctl.serverKey, projectID))
  }

  const nameOf = (ctl: SidebarController, projectID: string) =>
    rowOf(ctl.serverKey, projectID)?.getAttribute("aria-label") ?? ctl.project(projectID).name
  const rowOf = (serverKey: string, projectID: string) =>
    sectionOf(serverKey)?.querySelector<HTMLElement>(`[data-key="${CSS.escape(rowKey.project(projectID))}"]`) ?? null
  const sectionOf = (key: string) => scroller.querySelector<HTMLElement>(`[data-server="${CSS.escape(key)}"]`)
  const headOf = (key: string) => sectionOf(key)?.querySelector<HTMLElement>('[data-reorder="server"]') ?? null

  function stepProject(ctl: SidebarController, projectID: string, delta: number) {
    const ids = lane(ctl, projectID)
    const to = ids.indexOf(projectID) + delta
    if (to < 0 || to >= ids.length) return
    moveProject(ctl, projectID, to)
    focusLater(() => rowOf(ctl.serverKey, projectID))
  }

  // ---- server sections

  function moveServer(key: string, index: number) {
    const shown = serverOrder()
    arrangeServers(placed(shown, arrangedServers(), key, index))
    say(t("moved", { name: sectionOf(key)?.getAttribute("aria-label") ?? key, n: shown.length, at: index + 1 }))
  }

  function stepServer(key: string, delta: number) {
    const shown = serverOrder()
    const to = shown.indexOf(key) + delta
    if (to < 0 || to >= shown.length) return
    moveServer(key, to)
    focusLater(() => headOf(key)?.querySelector<HTMLElement>("[data-reorder-handle]") ?? null)
  }

  /** The moved row was put elsewhere in the page, which takes focus from it. */
  function focusLater(find: () => HTMLElement | null) {
    nextFrame(() => {
      const row = find()
      row?.focus({ preventScroll: true })
      row?.scrollIntoView({ block: "nearest" })
    })
  }

  setReorder({
    projectItems(ctl, projectID, name) {
      if (inArchive(ctl) || !ctl.list.can()) return []
      const pinned = ctl.pinnedProject(projectID)
      const ids = lane(ctl, projectID)
      const at = ids.indexOf(projectID)
      const word = sidebarText(input.locale(), pinned ? "own.sidebar.unpin" : "own.sidebar.pin")
      return [
        { label: word, testid: "project-menu-pin", onSelect: () => pin(ctl, projectID, !pinned) },
        ...moves("project-menu", at, ids.length, (delta) => stepProject(ctl, projectID, delta)),
        ...(ctl.list.view().order
          ? [
              {
                label: t("reset"),
                testid: "project-menu-reset",
                onSelect: () => {
                  void save(ctl, { order: null })
                  say(t("wasReset"))
                  focusLater(() => rowOf(ctl.serverKey, projectID))
                },
              },
            ]
          : []),
      ]
    },
    serverItems(key) {
      const shown = serverOrder()
      return [
        ...moves("server-menu", shown.indexOf(key), shown.length, (delta) => stepServer(key, delta)),
        ...(arrangedServers().length
          ? [
              {
                label: t("reset"),
                testid: "server-menu-reset",
                onSelect: () => {
                  arrangeServers([])
                  say(t("wasReset"))
                  focusLater(() => headOf(key)?.querySelector<HTMLElement>("[data-reorder-handle]") ?? null)
                },
              },
            ]
          : []),
      ]
    },
  })

  function moves(testid: string, at: number, count: number, step: (delta: number) => void): MenuItem[] {
    return [
      ...(at > 0 ? [{ label: t("up"), testid: `${testid}-up`, onSelect: () => step(-1) }] : []),
      ...(at >= 0 && at < count - 1 ? [{ label: t("down"), testid: `${testid}-down`, onSelect: () => step(1) }] : []),
    ]
  }

  // ---- what is under the pointer

  function itemOf(target: EventTarget | null) {
    if (!(target instanceof Element)) return undefined
    const item = target.closest<HTMLElement>("[data-reorder]")
    if (!item || !scroller.contains(item)) return undefined
    // The header's own buttons (and the menus inside it) are theirs.
    const control = target.closest("button, a, input, [popover]")
    if (control && item.contains(control) && !control.hasAttribute("data-reorder-handle")) return undefined
    return item
  }

  function laneOf(item: HTMLElement): Lane | undefined {
    const id = item.dataset.reorderId!
    if (item.dataset.reorder === "server") {
      const ids = serverOrder()
      return {
        ids,
        element: headOf,
        boxes: () => ids.flatMap((key) => headOf(key)?.getBoundingClientRect() ?? []),
        name: sectionName(item),
        fold: "*",
        move: (index) => moveServer(id, index),
      }
    }
    const serverKey = item.closest<HTMLElement>("[data-server]")?.dataset.server ?? LOCAL
    const ctl = input.controller(serverKey)
    if (!ctl || inArchive(ctl) || !ctl.list.can()) return undefined
    const ids = lane(ctl, id)
    return {
      ids,
      element: (other) => rowOf(serverKey, other),
      // From the fixed row heights, so hundreds of projects are a sum and not as many layout reads, and the ones a
      // window leaves out of the page count too.
      boxes: () => {
        const tree = sectionOf(serverKey)?.querySelector("[role=tree]")
        if (!tree) return []
        const at = new Map<string, number>()
        ctl.keys().reduce((top, key) => {
          at.set(key, top)
          return top + ctl.height(key)
        }, tree.getBoundingClientRect().top)
        return ids.flatMap((other) => {
          const key = rowKey.project(other)
          const top = at.get(key)
          // The row's own top margin (rows.tsx).
          return top === undefined ? [] : { top: top + 6, bottom: top + ctl.height(key) }
        })
      },
      name: ctl.project(id).name,
      fold: serverKey,
      move: (index) => moveProject(ctl, id, index),
    }
  }

  const sectionName = (item: HTMLElement) =>
    item.closest("[data-server]")?.getAttribute("aria-label") ?? item.dataset.reorderId!

  // ---- pointer

  let press: Press | undefined

  function release() {
    const current = press
    press = undefined
    if (!current) return undefined
    clearTimeout(current.timer)
    current.item.removeEventListener("touchmove", touchmove)
    current.item.removeAttribute("data-armed")
    document.documentElement.removeAttribute("data-reordering")
    return current
  }

  function cancel() {
    const current = release()
    if (!current?.drag) return
    current.drag.end()
    say(t("cancelled"))
  }

  const down = (event: PointerEvent) => {
    if (press) return cancel()
    if (event.button !== 0 || !event.isPrimary) return
    const item = itemOf(event.target)
    if (!item) return
    const touch = event.pointerType !== "mouse"
    const current: Press = { id: event.pointerId, x: event.clientX, y: event.clientY, item, touch, armed: !touch }
    press = current
    if (!touch) return
    // Also on the row itself: a window that scrolls on takes it out of the page, where its touches do not bubble.
    item.addEventListener("touchmove", touchmove, { passive: false })
    current.timer = setTimeout(() => {
      current.armed = true
      item.setAttribute("data-armed", "")
      // From here on the touch is this one's: the swipe that also saw it start lets go (shell/swipe.ts).
      document.documentElement.setAttribute("data-reordering", "")
      navigator.vibrate?.(12)
    }, LONG_PRESS_MS)
  }

  const move = (event: PointerEvent) => {
    const current = press
    if (!current || event.pointerId !== current.id) return
    if (current.drag) return current.drag.to(event.clientY)
    const distance = Math.hypot(event.clientX - current.x, event.clientY - current.y)
    // Moved before the long press: a scroll or a swipe.
    if (!current.armed) return void (distance > TOUCH_SLOP && release())
    if (distance < SLOP) return
    const order = laneOf(current.item)
    if (!order || order.ids.length < 2) return void release()
    current.drag = startDrag({
      scroller,
      lane: order,
      item: current.item,
      pointerId: current.id,
      y: current.y,
      touch: current.touch,
    })
    say(t("dragging", { name: order.name }))
    current.drag.to(event.clientY)
  }

  const up = (event: PointerEvent) => {
    if (press?.id !== event.pointerId) return
    if (event.type !== "pointerup") return cancel()
    const current = release()
    if (current?.drag) return current.drag.end(true)
    // A long press in place: the header's menu, like a row's (after this pointerup, which closes open popovers).
    if (current?.touch && current.armed) setTimeout(() => openMenu(current.item), 0)
  }

  const openMenu = (item: HTMLElement) =>
    item.querySelector<HTMLButtonElement>("button[aria-haspopup=menu][popovertarget]:last-of-type")?.click()

  const keydown = (event: KeyboardEvent) => {
    if (press?.drag) {
      if (event.code !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      return cancel()
    }
    const delta = event.code === "ArrowUp" ? -1 : event.code === "ArrowDown" ? 1 : 0
    if (!delta || !event.ctrlKey || !event.shiftKey || event.altKey || event.isComposing) return
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-reorder]") : null
    if (!item || !scroller.contains(item)) return
    event.preventDefault()
    const id = item.dataset.reorderId!
    if (item.dataset.reorder === "server") return stepServer(id, delta)
    const ctl = input.controller(item.closest<HTMLElement>("[data-server]")?.dataset.server ?? LOCAL)
    if (ctl && !inArchive(ctl) && ctl.list.can()) stepProject(ctl, id, delta)
  }

  // A right click on a header opens its `⋯`, like a row's; a touch's long press is the one above.
  const contextmenu = (event: MouseEvent) => {
    const item = itemOf(event.target)
    if (!item) return
    event.preventDefault()
    if (press?.touch || (event instanceof PointerEvent && event.pointerType === "touch")) return
    setTimeout(() => openMenu(item), 0)
  }

  // Once the long press has passed the finger drags, so the list must not scroll under it.
  const touchmove = (event: TouchEvent) => {
    if (press?.armed && event.cancelable) event.preventDefault()
  }

  scroller.addEventListener("pointerdown", down)
  scroller.addEventListener("contextmenu", contextmenu)
  if (navigator.maxTouchPoints > 0) scroller.addEventListener("touchmove", touchmove, { passive: false })
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", up)
  window.addEventListener("pointercancel", up)
  window.addEventListener("keydown", keydown, true)
  window.addEventListener("blur", cancel)

  return () => {
    cancel()
    setReorder(undefined)
    status.remove()
    scroller.removeEventListener("pointerdown", down)
    scroller.removeEventListener("contextmenu", contextmenu)
    scroller.removeEventListener("touchmove", touchmove)
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", up)
    window.removeEventListener("pointercancel", up)
    window.removeEventListener("keydown", keydown, true)
    window.removeEventListener("blur", cancel)
  }
}

/** One drag: the ghost under the pointer, the line where it lands, the folded list, scrolling near the edges. */
function startDrag(input: {
  readonly scroller: HTMLElement
  readonly lane: Lane
  readonly item: HTMLElement
  readonly pointerId: number
  readonly y: number
  readonly touch: boolean
}) {
  const { scroller, lane, item } = input
  const id = item.dataset.reorderId!
  const from = lane.ids.indexOf(id)
  const box = item.getBoundingClientRect()
  const scrolled = scroller.scrollTop

  const ghost = item.cloneNode(true) as HTMLElement
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")])
    for (const name of ["id", "data-testid", "data-key", "data-reorder", "popovertarget"]) node.removeAttribute(name)
  ghost.querySelectorAll("[popover]").forEach((node) => node.remove())
  ghost.setAttribute("aria-hidden", "true")
  ghost.className += " own-drag-ghost"
  // Beside the pointer (above a finger), so the line and the rows next to it stay readable.
  ghost.style.cssText += `;left:${box.left + 14}px;top:${input.touch ? -box.height - 22 : 14}px;width:${box.width - 28}px;height:${box.height}px`
  const line = document.createElement("div")
  line.className = "own-drag-line"
  line.dataset.testid = "drag-line"
  line.hidden = true
  // Inside the app's element for its theme tokens; both are fixed, so no list clips them.
  document.body.append(ghost, line)

  setFolding(lane.fold)
  item.setAttribute("data-dragged", "")
  document.documentElement.setAttribute("data-reordering", "")
  // The dragged header stays under the pointer although the list above it folded.
  scroller.scrollTop += (lane.boxes()[from]?.top ?? box.top) - box.top
  try {
    scroller.setPointerCapture(input.pointerId)
  } catch {}

  let y = input.y
  let slot = from
  let moved = false
  let frame = requestAnimationFrame(function loop() {
    const area = scroller.getBoundingClientRect()
    const speed = y < area.top + EDGE ? y - area.top - EDGE : y > area.bottom - EDGE ? y - area.bottom + EDGE : 0
    if (speed) {
      const before = scroller.scrollTop
      scroller.scrollTop += Math.max(-14, Math.min(14, speed / 3))
      if (scroller.scrollTop !== before) draw()
    }
    frame = requestAnimationFrame(loop)
  })

  function draw() {
    ghost.style.transform = `translateY(${y}px)`
    moved ||= Math.abs(y - input.y) >= VERTICAL
    if (!moved) return void (line.hidden = true)
    const boxes = lane.boxes()
    if (boxes.length !== lane.ids.length) return
    // The number of headers whose middle is above the pointer: where the dragged one goes among the others.
    const above = boxes.filter((row) => (row.top + row.bottom) / 2 < y).length
    slot = above > from ? above - 1 : above
    const at = above < boxes.length ? boxes[above]!.top - 2 : boxes.at(-1)!.bottom + 2
    const area = scroller.getBoundingClientRect()
    line.style.cssText = `left:${area.left + 8}px;width:${area.width - 16}px;top:${Math.max(area.top, Math.min(area.bottom - 2, at)) - 1}px`
    line.hidden = slot === from
  }

  return {
    to(next: number) {
      y = next
      draw()
    },
    /** Puts the list back; `drop` moves the header to where the line was. */
    end(drop = false) {
      cancelAnimationFrame(frame)
      ghost.remove()
      line.remove()
      item.removeAttribute("data-dragged")
      try {
        scroller.releasePointerCapture(input.pointerId)
      } catch {}
      // The button's click that ends a mouse drag must not fold what was dragged.
      const swallow = (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
      }
      window.addEventListener("click", swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener("click", swallow, true), 50)
      if (drop && slot !== from) lane.move(slot)
      setFolding(undefined)
      if (!drop || slot === from) return void (scroller.scrollTop = scrolled)
      nextFrame(() => lane.element(id)?.scrollIntoView({ block: "nearest" }))
    },
  }
}
