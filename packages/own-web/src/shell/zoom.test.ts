// Window zoom in own-web (03 §4.2.1, 05 §7.9): the state behind the title bar's indicator, its bubble and 설정 > 일반
// `화면 크기` (zoom-state.ts) over a host zoom that behaves like main's (one kept factor, Chrome's levels from
// own-desktop src/shared/zoom.ts, each change announced before the request is answered), and where the UI is mounted.
// The components themselves run in the real shell (own-desktop scripts/zoom-level.ts).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { clampZoom, stepZoom, ZOOM_LEVELS } from "../../../own-desktop/src/shared/zoom"
import type { HostZoom } from "@/host/types"
import { createZoomState, zoomPercent, zoomState } from "./zoom-state"

// The bubble's flash in these tests. The checks sit a quarter of it before or after a close, so 40 ms left 10 ms of
// timer slack, which the parallel unit run used up (RL18: `flash` read as `closed` once, 80 ms into the test).
const FLASH = 240
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** One kept factor like main's (src/main/zoom.ts): every set and step is announced, then answered. */
function hostZoom(start = 1) {
  const listeners = new Set<(factor: number) => void>()
  let kept = start
  const announce = (factor: number) => {
    kept = factor
    listeners.forEach((listener) => listener(kept))
    return kept
  }
  const zoom: HostZoom = {
    levels: ZOOM_LEVELS,
    get: async () => kept,
    set: async (factor) => announce(clampZoom(factor)),
    step: async (direction) => announce(stepZoom(kept, direction)),
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { zoom, announce }
}

describe("zoom state (zoom-state.ts)", () => {
  test("the percent the indicator and the control show", () => {
    expect(zoomPercent(1)).toBe("100%")
    expect(zoomPercent(1.1000000000000003)).toBe("110%")
    expect(zoomPercent(2 / 3)).toBe("67%")
    expect(zoomPercent(0.5)).toBe("50%")
  })

  test("starts from the kept factor and follows every announced change", async () => {
    const host = hostZoom(1.25)
    const state = createZoomState(host.zoom, { flashMs: FLASH })
    expect(state.factor()).toBe(1)
    await wait(0)
    expect(state.factor()).toBe(1.25)
    expect(state.atDefault()).toBe(false)
    host.announce(1.0000000000000002)
    expect(state.atDefault()).toBe(true)
    host.announce(2)
    expect([state.atMax(), state.atMin()]).toEqual([true, false])
    host.announce(0.5)
    expect([state.atMax(), state.atMin()]).toEqual([false, true])
  })

  test("keys, Ctrl+wheel and other windows flash the bubble, which closes by itself", async () => {
    const host = hostZoom()
    const state = createZoomState(host.zoom, { flashMs: FLASH })
    state.step("in")
    await wait(0)
    expect(state.factor()).toBe(1.1)
    expect(state.bubble()).toBe("flash")
    // Ctrl+wheel or another window: main's announcement alone.
    await wait(FLASH / 2)
    host.announce(1.25)
    await wait(FLASH * 0.75)
    expect(state.bubble()).toBe("flash")
    await wait(FLASH)
    expect(state.bubble()).toBe("closed")
    // At an end the factor stays, and the bubble still says so (like a browser's).
    host.announce(2)
    await wait(FLASH * 2)
    state.step("in")
    await wait(0)
    expect(state.factor()).toBe(2)
    expect(state.bubble()).toBe("flash")
    // Ctrl+0 shows 100 % briefly too, then the indicator is gone.
    state.reset()
    await wait(0)
    expect([state.factor(), state.bubble(), state.atDefault()]).toEqual([1, "flash", true])
  })

  test("the settings row's quiet changes do not flash it; a hidden page never flashes", async () => {
    const host = hostZoom()
    const state = createZoomState(host.zoom, { flashMs: FLASH })
    state.step("out", { quiet: true })
    await wait(0)
    expect([state.factor(), state.bubble()]).toEqual([0.9, "closed"])
    state.reset({ quiet: true })
    await wait(0)
    expect([state.factor(), state.bubble()]).toEqual([1, "closed"])
    // The quiet request is answered: the next change flashes again.
    host.announce(1.1)
    expect(state.bubble()).toBe("flash")

    let visible = false
    const hidden = createZoomState(hostZoom().zoom, { flashMs: FLASH, visible: () => visible })
    hidden.step("in")
    await wait(0)
    expect([hidden.factor(), hidden.bubble()]).toEqual([1.1, "closed"])
    visible = true
    hidden.step("in")
    await wait(0)
    expect(hidden.bubble()).toBe("flash")
  })

  test("opened from the indicator it stays until closed; the pointer or the focus holds a flash", async () => {
    const host = hostZoom(1.1)
    const state = createZoomState(host.zoom, { flashMs: FLASH })
    state.open()
    state.step("in")
    await wait(FLASH * 2)
    expect([state.factor(), state.bubble()]).toEqual([1.25, "open"])
    state.close()
    expect(state.bubble()).toBe("closed")

    host.announce(1.5)
    state.hold(true) // pointer in
    state.hold(true) // focus in
    await wait(FLASH * 2)
    expect(state.bubble()).toBe("flash")
    state.hold(false) // pointer out, focus still in
    await wait(FLASH * 2)
    expect(state.bubble()).toBe("flash")
    state.hold(false)
    await wait(FLASH * 2)
    expect(state.bubble()).toBe("closed")
  })

  test("one state per host zoom in a window: the indicator and the settings row share it", () => {
    const { zoom } = hostZoom()
    expect(zoomState(zoom)).toBe(zoomState(zoom))
    expect(zoomState(hostZoom().zoom)).not.toBe(zoomState(zoom))
  })
})

describe("where the zoom UI is (sources)", () => {
  const read = (file: string) => Bun.file(path.join(import.meta.dir, "..", file)).text()

  test("the zoom keys and the indicator come with host.window.zoom only, after the header and the panel", async () => {
    const layer = await read("shell/zoom.tsx")
    expect(layer).toContain("const zoom = useHost().window?.zoom\n  if (!zoom) return null")
    for (const id of ["zoom.in", "zoom.out", "zoom.reset"]) expect(layer).toContain(`useShortcut("${id}"`)
    expect(await read("shell/shortcuts.tsx")).not.toContain('useShortcut("zoom.')
    const shell = await read("shell/app-shell.tsx")
    // Electron's drag area follows document order: the pill's no-drag after the header's and the panel head's drag.
    expect(shell.indexOf("<ZoomLayer />")).toBeGreaterThan(shell.indexOf("<WorkPanel />"))
    expect(shell.indexOf("<ZoomLayer />")).toBeGreaterThan(shell.indexOf("<SessionHeader />"))
  })

  test("the band rows keep the indicator's place free through --own-wco-right", async () => {
    const tokens = await read("styles/tokens.css")
    expect(tokens).toContain("--own-wco-right: calc(var(--own-wco-buttons) + var(--own-wco-zoom, 0px));")
    const css = await read("shell/zoom.css")
    expect(css).toMatch(/:root\[data-own-zoomed\] \{\s*--own-wco-zoom: 52px;/)
    expect(css).toMatch(/\.own-zoom-pill \{[^}]*width: 52px;[^}]*-webkit-app-region: no-drag;/s)
  })

  test("설정 > 일반 has `화면 크기` (quiet); 데스크톱 앱 no longer has a zoom row", async () => {
    const sections = await read("settings/sections.tsx")
    const general = sections.slice(sections.indexOf("export function GeneralSettings"))
    expect(general.slice(0, general.indexOf("\n}\n"))).toContain("<ZoomSetting />")
    expect(sections).toContain('<ZoomControl state={zoomState(zoom)} quiet testid="settings-zoom" />')
    const desktop = sections.slice(sections.indexOf("export function DesktopSettings"))
    expect(desktop.slice(0, desktop.indexOf("\n}\n"))).not.toMatch(/zoom/i)
  })
})
