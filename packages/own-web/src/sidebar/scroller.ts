// The sidebar's one scroll area (03 §4.3): every server section lies in it at its natural height. Scroll position and
// sizes as signals, so a windowed tree inside it (./tree.tsx) knows which of its rows are on screen. Scroll events are
// read once per frame (R7); the sizes come from ResizeObserver, on the frame after it (what they change is laid out
// then, never inside the observer's own delivery).
import { createContext, createSignal, onCleanup, useContext } from "solid-js"

export function createScroller() {
  const [top, setTop] = createSignal(0)
  const [height, setHeight] = createSignal(typeof innerHeight === "number" ? innerHeight : 800)
  const [content, setContent] = createSignal(0)
  let element: HTMLElement | undefined
  let frame = 0
  let sizes = 0
  onCleanup(() => {
    cancelAnimationFrame(frame)
    cancelAnimationFrame(sizes)
  })
  return {
    top,
    height,
    /** The height of everything in it; changes whenever something inside moves. */
    content,
    element: () => element,
    /** `outer` scrolls, `inner` holds the sections. */
    mount(outer: HTMLElement, inner: HTMLElement) {
      element = outer
      outer.addEventListener("scroll", () => {
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          setTop(outer.scrollTop)
        })
      })
      if (typeof ResizeObserver !== "function") return
      const observer = new ResizeObserver(() => {
        if (sizes) return
        sizes = requestAnimationFrame(() => {
          sizes = 0
          if (outer.clientHeight > 0) setHeight(outer.clientHeight)
          setContent(inner.offsetHeight)
        })
      })
      observer.observe(outer)
      observer.observe(inner)
      onCleanup(() => observer.disconnect())
    },
    /** Scrolls; the signal follows at once, so a window already holds its rows on the next render. */
    to(next: number) {
      if (!element) return
      element.scrollTop = next
      setTop(element.scrollTop)
    },
  }
}

export type Scroller = ReturnType<typeof createScroller>

export const ScrollerContext = createContext<Scroller>()

export function useScroller() {
  const value = useContext(ScrollerContext)
  if (!value) throw new Error("useScroller() needs <ScrollerContext.Provider>")
  return value
}
