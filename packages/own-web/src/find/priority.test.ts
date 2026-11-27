import { afterEach, describe, expect, test } from "bun:test"
import { createShortcutRegistry } from "@/keyboard"
import { claimSessionFind, installFindPriority } from "./priority"

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.innerHTML = ""
})

function press(target: Element) {
  const event = new KeyboardEvent("keydown", { code: "KeyF", key: "f", ctrlKey: true, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe("Ctrl+F priority (19.13 vs session-ui's page-wide file find)", () => {
  test("outside file viewers the claimed session find opens and the default is prevented", () => {
    const opened: string[] = []
    cleanups.push(installFindPriority(createShortcutRegistry({ mac: false })))
    // What session-ui's listener would do: it ignores events whose default was prevented.
    const sessionUi = (event: KeyboardEvent) => void (!event.defaultPrevented && opened.push("file"))
    window.addEventListener("keydown", sessionUi, { capture: true })
    cleanups.push(() => window.removeEventListener("keydown", sessionUi, { capture: true }))
    cleanups.push(claimSessionFind(() => opened.push("session")))

    const transcript = document.createElement("div")
    const viewer = document.createElement("div")
    viewer.setAttribute("data-own-file-find", "")
    const modal = document.createElement("div")
    modal.setAttribute("aria-modal", "true")
    document.body.append(transcript, viewer, modal)

    expect(press(transcript).defaultPrevented).toBe(true)
    expect(opened).toEqual(["session"])
    press(viewer)
    expect(opened).toEqual(["session", "file"])
    press(modal)
    expect(opened).toEqual(["session", "file", "file"])
  })

  test("nothing claimed (no session on screen) or a released claim leaves the key alone", () => {
    cleanups.push(installFindPriority(createShortcutRegistry({ mac: false })))
    const release = claimSessionFind(() => {
      throw new Error("released")
    })
    release()
    expect(press(document.body).defaultPrevented).toBe(false)
  })

  test("a rebound session.find key is the one taken", () => {
    const opened: string[] = []
    const registry = createShortcutRegistry({
      mac: false,
      keymap: { ...createShortcutRegistry().keymap, "session.find": { chords: ["Mod+Shift+KeyF"], scope: "global" } },
    })
    cleanups.push(installFindPriority(registry))
    cleanups.push(claimSessionFind(() => opened.push("session")))
    expect(press(document.body).defaultPrevented).toBe(false)
    expect(opened).toEqual([])
  })
})
