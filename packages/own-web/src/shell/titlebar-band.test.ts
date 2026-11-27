// Title bar band geometry (03 §4.2.1, 05 §7.1) against a fake `navigator.windowControlsOverlay`.
import { afterEach, describe, expect, test } from "bun:test"
import { bandGeometry, watchBand, type TitlebarOverlay } from "./titlebar-band"

class FakeOverlay extends EventTarget implements TitlebarOverlay {
  visible = true
  rect = { x: 0, y: 0, width: 1062, height: 44 }
  getTitlebarAreaRect() {
    return this.rect as DOMRect
  }
  change(next: Partial<FakeOverlay["rect"]> & { visible?: boolean }) {
    const { visible, ...rect } = next
    if (visible !== undefined) this.visible = visible
    this.rect = { ...this.rect, ...rect }
    this.dispatchEvent(new Event("geometrychange"))
  }
}

const root = document.documentElement
const read = () => ({
  visible: root.hasAttribute("data-wco-visible"),
  right: root.style.getPropertyValue("--own-wco-band-right"),
  height: root.style.getPropertyValue("--own-wco-band-height"),
})

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
})

describe("bandGeometry", () => {
  test("buttons' area and height in CSS px; nothing while hidden (fullscreen)", () => {
    const overlay = new FakeOverlay()
    expect(bandGeometry(overlay, 1200)).toEqual({ visible: true, right: 138, height: 44 })
    // 80 %: main keeps the overlay at 44 DIP, which is 55 CSS px; the buttons' area grows in CSS px as well.
    overlay.rect = { x: 0, y: 0, width: 1327, height: 55 }
    expect(bandGeometry(overlay, 1500)).toEqual({ visible: true, right: 173, height: 55 })
    overlay.visible = false
    expect(bandGeometry(overlay, 1200)).toEqual({ visible: false, right: 0, height: 0 })
  })

  test("an empty rect before layout reserves nothing", () => {
    const overlay = new FakeOverlay()
    overlay.rect = { x: 0, y: 0, width: 0, height: 0 }
    expect(bandGeometry(overlay, 1200)).toEqual({ visible: true, right: 0, height: 0 })
  })
})

describe("watchBand", () => {
  test("mirrors the band on <html>, follows geometry, resize and zoom, clears on stop", () => {
    const overlay = new FakeOverlay()
    const view = new EventTarget() as EventTarget & { innerWidth: number }
    view.innerWidth = 1200
    const frames: (() => void)[] = []
    const zoomListeners = new Set<() => void>()
    stop = watchBand({
      overlay,
      root,
      view: view as never,
      onZoom: (listener) => {
        zoomListeners.add(listener)
        return () => zoomListeners.delete(listener)
      },
      frame: (callback) => {
        frames.push(callback)
        return () => frames.splice(frames.indexOf(callback), 1)
      },
    })
    expect(read()).toEqual({ visible: true, right: "138px", height: "44px" })

    overlay.change({ visible: false })
    expect(read()).toEqual({ visible: false, right: "0px", height: "" })
    overlay.change({ visible: true })

    // Zoom to 80 %: the new overlay size lands after main handles it, so it is read on the next frame, once.
    overlay.rect = { x: 0, y: 0, width: 1327, height: 55 }
    view.innerWidth = 1500
    zoomListeners.forEach((listener) => listener())
    view.dispatchEvent(new Event("resize"))
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(read()).toEqual({ visible: true, right: "173px", height: "55px" })

    stop()
    stop = undefined
    expect(read()).toEqual({ visible: false, right: "", height: "" })
    expect(zoomListeners.size).toBe(0)
    overlay.change({ width: 10 })
    view.dispatchEvent(new Event("resize"))
    expect(frames).toHaveLength(0)
    expect(read().visible).toBe(false)
  })

  test("a pending frame is cancelled on stop", () => {
    const overlay = new FakeOverlay()
    const view = Object.assign(new EventTarget(), { innerWidth: 1200 })
    const frames: (() => void)[] = []
    const off = watchBand({
      overlay,
      root,
      view: view as never,
      frame: (callback) => {
        frames.push(callback)
        return () => frames.splice(frames.indexOf(callback), 1)
      },
    })
    view.dispatchEvent(new Event("resize"))
    expect(frames).toHaveLength(1)
    off()
    expect(frames).toHaveLength(0)
  })

  test("an open <dialog> is mirrored as data-wco-modal (its toggle events, not a root :has())", () => {
    const overlay = new FakeOverlay()
    const view = Object.assign(new EventTarget(), { innerWidth: 1200 })
    stop = watchBand({ overlay, root, view: view as never })
    const dialog = document.createElement("dialog")
    document.body.append(dialog)
    dialog.setAttribute("open", "")
    dialog.dispatchEvent(new Event("toggle"))
    expect(root.hasAttribute("data-wco-modal")).toBe(true)
    // Another toggle (a popover, <details>) asks again: the dialog is still open.
    const details = document.createElement("details")
    document.body.append(details)
    details.dispatchEvent(new Event("toggle"))
    expect(root.hasAttribute("data-wco-modal")).toBe(true)
    details.remove()
    dialog.removeAttribute("open")
    dialog.dispatchEvent(new Event("toggle"))
    expect(root.hasAttribute("data-wco-modal")).toBe(false)
    dialog.setAttribute("open", "")
    dialog.dispatchEvent(new Event("toggle"))
    stop()
    stop = undefined
    expect(root.hasAttribute("data-wco-modal")).toBe(false)
    dialog.remove()
  })
})
