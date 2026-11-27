// The Android app's back button and system bars (MUX 2026-11-06): what `window.ownApp` answers the shell
// (packages/own-android PcActivity, SystemBars). happy-dom lays nothing out, so each overlay says it is shown.
import { afterEach, describe, expect, test } from "bun:test"
import { back, installAppBridge, theme } from "./app-bridge"

afterEach(() => {
  document.body.replaceChildren()
  delete document.documentElement.dataset.colorScheme
  delete window.ownApp
})

/** An open overlay that closes itself on Escape, as the switcher sheet, the menus and the dialogs do. */
function overlay(role: string, closes = true) {
  const element = document.createElement("div")
  element.setAttribute("role", role)
  element.checkVisibility = () => element.isConnected
  if (closes)
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") element.remove()
    })
  document.body.append(element)
  return element
}

describe("back", () => {
  test("closes the overlay on top and answers true; with nothing open it answers false", () => {
    const menu = overlay("menu")
    const sheet = overlay("dialog")
    expect(back()).toBe(true)
    expect(sheet.isConnected).toBe(false)
    expect(menu.isConnected).toBe(true)
    expect(back()).toBe(true)
    expect(menu.isConnected).toBe(false)
    expect(back()).toBe(false)
  })

  test("Escape goes to the focused element inside the overlay, so its own key handler runs", () => {
    const sheet = overlay("dialog", false)
    const input = document.createElement("input")
    sheet.append(input)
    input.focus()
    let target: EventTarget | null = null
    sheet.addEventListener("keydown", (event) => {
      target = event.target
      if (event.key === "Escape") sheet.remove()
    })
    expect(back()).toBe(true)
    expect(target === input).toBe(true)
  })

  test("an overlay that ignores Escape leaves back to the shell instead of swallowing every press", () => {
    overlay("dialog", false)
    expect(back()).toBe(false)
  })

  test("a <dialog> that ignores the synthetic Escape is closed the way the browser would", () => {
    const dialog = document.createElement("dialog")
    dialog.setAttribute("open", "")
    dialog.checkVisibility = () => dialog.open
    document.body.append(dialog)
    expect(back()).toBe(true)
    expect(dialog.open).toBe(false)
  })

  test("with no overlay, an open drawer or overlaid work panel (the shell's scrim is up) closes through Escape first", () => {
    const app = document.createElement("div")
    app.className = "own-app"
    const scrim = document.createElement("div")
    scrim.className = "own-scrim"
    app.append(scrim)
    document.body.append(app)
    const close = (event: KeyboardEvent) => {
      if (event.code === "Escape") scrim.remove()
    }
    window.addEventListener("keydown", close)
    expect(back()).toBe(true)
    expect(scrim.isConnected).toBe(false)
    expect(back()).toBe(false)
    window.removeEventListener("keydown", close)
  })

  test("hidden overlays (closed menus stay in the DOM) are not open", () => {
    const closed = overlay("menu")
    closed.checkVisibility = () => false
    expect(back()).toBe(false)
  })
})

describe("theme", () => {
  test("names the page's scheme and its background for the system bars", () => {
    const app = document.createElement("div")
    app.className = "own-app"
    app.style.backgroundColor = "rgb(255, 255, 255)"
    document.body.append(app)
    document.documentElement.dataset.colorScheme = "light"
    expect(theme()).toEqual({ scheme: "light", background: "rgb(255, 255, 255)" })
    document.documentElement.dataset.colorScheme = "dark"
    expect(theme().scheme).toBe("dark")
  })

  test("installAppBridge puts both on window.ownApp", () => {
    installAppBridge()
    expect(window.ownApp?.back()).toBe(false)
    expect(window.ownApp?.theme().scheme).toBe("dark")
  })
})
