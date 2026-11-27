import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Route } from "@/routing/routes"
import { createWorkspaceLayout, rememberWorkspace, snapNotesWidth } from "./workspace-state"

describe("workspace navigation and layout", () => {
  test("settings and account pages retain the exact remote conversation", () => {
    const [route, setRoute] = createSignal<Route>({ name: "session", serverKey: "remote", sessionID: "chat" })
    const remembered = rememberWorkspace(route)
    expect(remembered()).toEqual(route())
    setRoute({ name: "settings", section: "layout" })
    expect(remembered()).toEqual({ name: "session", serverKey: "remote", sessionID: "chat" })
    setRoute({ name: "accounts" })
    expect(remembered()).toEqual({ name: "session", serverKey: "remote", sessionID: "chat" })
    setRoute({ name: "project", serverKey: "local", projectID: "next" })
    expect(remembered()).toEqual(route())
  })

  test("each workspace restores its own docking and widths after reload", () => {
    const windowKey = crypto.randomUUID()
    createRoot((dispose) => {
      const [key, setKey] = createSignal("first")
      const layout = createWorkspaceLayout(key, windowKey)
      layout.update({ notesPlacement: "left", notesOpen: true, notesWidth: 420, panelWidth: 480 })
      setKey("second")
      expect(layout.read().notesOpen).toBe(false)
      layout.update({ notesPlacement: "main", notesOpen: true, tab: "notes" })
      setKey("first")
      expect(layout.read().notesWidth).toBe(420)
      expect(layout.read().notesPlacement).toBe("left")
      dispose()
    })
    createRoot((dispose) => {
      const layout = createWorkspaceLayout(() => "second", windowKey)
      expect(layout.read().notesPlacement).toBe("main")
      expect(layout.read().tab).toBe("notes")
      dispose()
    })
  })

  test("adopt moves what changed under the key just left to the current one, once", () => {
    const windowKey = crypto.randomUUID()
    createRoot((dispose) => {
      const [key, setKey] = createSignal("route")
      const layout = createWorkspaceLayout(key, windowKey)
      layout.update({ sidebarCollapsed: true })
      layout.update({ panelWidth: 500 })
      setKey("folder")
      expect(layout.read().sidebarCollapsed).toBeUndefined()
      layout.adopt("other")
      expect(layout.read().sidebarCollapsed).toBeUndefined()
      layout.adopt("route")
      expect(layout.read()).toMatchObject({ sidebarCollapsed: true, panelWidth: 500 })
      setKey("next")
      layout.adopt("route")
      expect(layout.read().sidebarCollapsed).toBeUndefined()
      layout.flush()
      dispose()
    })
    createRoot((dispose) => {
      const layout = createWorkspaceLayout(() => "folder", windowKey)
      expect(layout.read()).toMatchObject({ sidebarCollapsed: true, panelWidth: 500 })
      dispose()
    })
  })

  test("resize snaps near useful widths and preserves space for chat", () => {
    expect(snapNotesWidth(334, 1000)).toBe(340)
    expect(snapNotesWidth(427, 1000)).toBe(420)
    expect(snapNotesWidth(600, 720)).toBeLessThanOrEqual(400)
    expect(snapNotesWidth(20, 1000)).toBe(220)
  })
})
