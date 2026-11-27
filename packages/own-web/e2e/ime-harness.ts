// Binds the real IME helper to a textarea (composer rules) and an input (switcher/palette `commitOnly` rules) and
// records what they send, so Playwright can replay the 03 §12 event orders in Edge.
import { clearNextFrame, createImeEnter } from "@/ime/ime-enter"

type Log = { sent: string[]; applied: string[]; events: string[] }
const log: Log = { sent: [], applied: [], events: [] }
Object.assign(window, { __ime: log })

const composer = document.getElementById("composer") as HTMLTextAreaElement
const search = document.getElementById("search") as HTMLInputElement

bind(composer, false, () => {
  if (!composer.value.trim()) return
  log.sent.push(composer.value)
  clearNextFrame(composer)
})
bind(search, true, () => log.applied.push(search.value))

function bind(element: HTMLElement, commitOnly: boolean, onEnter: () => void) {
  const ime = createImeEnter({ onEnter, commitOnly })
  element.addEventListener("keydown", (event) => {
    log.events.push(`${element.id}:keydown:${event.key}:${event.keyCode}:${event.isComposing}`)
    ime.listeners.onKeyDown(event)
  })
  element.addEventListener("keyup", (event) => ime.listeners.onKeyUp(event))
  element.addEventListener("compositionstart", () => {
    log.events.push(`${element.id}:compositionstart`)
    ime.listeners.onCompositionStart()
  })
  element.addEventListener("compositionend", () => {
    log.events.push(`${element.id}:compositionend`)
    ime.listeners.onCompositionEnd()
  })
  element.addEventListener("input", () => ime.listeners.onInput())
}
