// This PC's window zoom (05 §7.9) without Electron: Chrome's levels from 50 to 200 %, the clamp every stored or
// requested factor goes through, the steps of the keys and Ctrl+wheel, and the upstream behavior the appearance
// substitute replaces. Keeping and restoring the factor across starts runs on the real shell (scripts/zoom-level.ts).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { desktopZoomLevels } from "@opencode/app/desktop-menu"
import { clampZoom, earlyZoomLevel, stepZoom, ZOOM_LEVELS } from "../src/shared/zoom"

const here = path.resolve(import.meta.dir, "..")
const desktop = path.resolve(here, "../desktop")
/** Source without line comments: the headers explain in words what the code must not do. */
const code = async (file: string) =>
  (await Bun.file(file).text())
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")

describe("zoom levels (src/shared/zoom.ts)", () => {
  test("Chrome's levels between 50 and 200 %, ascending, 100 % among them", () => {
    expect(ZOOM_LEVELS.map((level) => Math.round(level * 100))).toEqual([
      50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200,
    ])
    expect([...ZOOM_LEVELS].sort((a, b) => a - b)).toEqual([...ZOOM_LEVELS])
  })

  test("a stored or requested factor is clamped to 50–200 %; anything else is 100 %", () => {
    expect(clampZoom(1.25)).toBe(1.25)
    expect(clampZoom(1.3)).toBe(1.3)
    expect(clampZoom(0.25)).toBe(0.5)
    expect(clampZoom(3)).toBe(2)
    for (const value of [undefined, null, "1.5", Number.NaN, Number.POSITIVE_INFINITY, 0, -1, {}, [1.5]])
      expect({ value, factor: clampZoom(value) }).toEqual({ value, factor: 1 })
  })

  test("a step is the next level; the ends stay", () => {
    expect(stepZoom(1, "in")).toBe(1.1)
    expect(stepZoom(1, "out")).toBe(0.9)
    expect(stepZoom(1.1, "in")).toBe(1.25)
    expect(stepZoom(0.75, "out")).toBe(2 / 3)
    expect(stepZoom(2 / 3, "out")).toBe(0.5)
    expect(stepZoom(2, "in")).toBe(2)
    expect(stepZoom(0.5, "out")).toBe(0.5)
    // From one end to the other: every level once.
    const up = [0.5]
    while (up.at(-1)! < 2) up.push(stepZoom(up.at(-1)!, "in"))
    expect(up).toEqual([...ZOOM_LEVELS])
  })

  test("Chromium's float noise and an older build's 10 % steps land on the next level", () => {
    expect(stepZoom(1.1000000000000003, "in")).toBe(1.25)
    expect(stepZoom(1.0999999999999999, "out")).toBe(1)
    expect(stepZoom(0.6667, "out")).toBe(0.5)
    expect(stepZoom(1.3, "in")).toBe(1.5)
    expect(stepZoom(1.3, "out")).toBe(1.25)
    // Beyond the ends (never stored: main clamps first) a step lands on the end.
    expect(stepZoom(2.6, "out")).toBe(2)
    expect(stepZoom(2.6, "in")).toBe(2)
    expect(stepZoom(0.3, "in")).toBe(0.5)
  })
})

describe("upstream zoom the appearance substitute replaces (packages/desktop, read only)", () => {
  test("upstream sets every new app window to its saved level, the adopted early one too, and resets Ctrl+wheel to it", async () => {
    const appearance = await code(path.join(desktop, "src/main/windows/appearance.ts"))
    const wire = appearance.slice(appearance.indexOf("export function wireZoom"))
    expect(wire.slice(0, wire.indexOf("\n}\n"))).toContain("win.webContents.setZoomFactor(storedZoomLevel())")
    expect(wire).toContain('win.webContents.on("zoom-changed"')
    // The early window starts at that level before the renderer boots.
    const early = await code(path.join(desktop, "src/main/windows/early.ts"))
    expect(early).toContain("const zoom = storedZoomLevel()")
    expect(early).toContain("zoomFactor: zoom,")
    const defaults = await code(path.join(desktop, "src/main/windows/defaults.ts"))
    expect(defaults).toContain("const stored = getStore().get(ZOOM_LEVEL_KEY)")
    expect(defaults).toContain("return desktopZoomLevels.find((level) => level === stored) ?? 1")
    const windows = await code(path.join(desktop, "src/main/windows/index.ts"))
    // wireZoom runs for every window create() makes or adopts: after the load, outside `if (!early)`.
    expect(windows).toContain('    if (!early) loadWindow(win, "index.html")\n    wireZoom(win)\n')
    expect(windows).toContain('} from "./appearance"')
  })

  test("the substitute joins the kept factor instead, and Ctrl+wheel steps it", async () => {
    const own = await code(path.join(here, "src/overrides/appearance.ts"))
    const wire = own.slice(own.indexOf("export function wireZoom"))
    const body = wire.slice(0, wire.indexOf("\n}\n"))
    expect(body).toContain("joinZoom(win, () => updateZoom(win))")
    expect(body).toContain('stepWindowZoom(direction === "in" ? "in" : "out")')
    expect(own).not.toMatch(/setZoomFactor\(\s*1\s*\)|storedZoomLevel/)
    // Upstream's menu items and WindowSetZoomLevel set the kept factor.
    const level = own.slice(own.indexOf("export function setZoomLevel"))
    expect(level.slice(0, level.indexOf("\n}\n"))).toContain("setZoom(level)")
    const zoom = await code(path.join(here, "src/main/zoom.ts"))
    expect(zoom).toContain('win.webContents.on("did-navigate", () => apply(win, zoomFactor()))')
    expect(zoom).toContain('export const ZOOM_KEY = "ownZoomFactor"')
    // Not one of upstream's settings keys.
    expect(await Bun.file(path.join(desktop, "src/main/storage/keys.ts")).text()).not.toContain("ownZoomFactor")
  })

  test("the early window starts at the kept factor where upstream has that level, else at 100 %", async () => {
    // Upstream's levels are Chrome's from 50 % since v2.2.6, written to two decimals.
    expect(ZOOM_LEVELS.map((level) => earlyZoomLevel(level))).toEqual([...desktopZoomLevels])
    expect(earlyZoomLevel(1)).toBe(1)
    expect(earlyZoomLevel(1.25)).toBe(1.25)
    expect(earlyZoomLevel(1.1000000000000003)).toBe(1.1)
    expect(earlyZoomLevel(2 / 3)).toBe(0.67)
    expect(earlyZoomLevel(0.9)).toBe(0.9)
    for (const factor of [0.3, 1.3, 2.5]) expect(earlyZoomLevel(factor)).toBeUndefined()
    // Kept in upstream's key right before the early window reads it.
    const shell = await code(path.join(here, "src/main/own-shell.ts"))
    const prepare = shell.slice(shell.indexOf("export function prepareWindowAppearance"))
    expect(prepare.slice(0, prepare.indexOf("\n}\n"))).toContain("prepareEarlyZoom()")
    const index = await code(path.join(here, "src/main/index.ts"))
    expect(index.indexOf("prepareWindowAppearance()")).toBeGreaterThan(0)
    expect(index.indexOf("prepareWindowAppearance()")).toBeLessThan(index.indexOf("createEarlyWindow("))
    const zoom = await code(path.join(here, "src/main/zoom.ts"))
    expect(zoom).toContain("store.set(ZOOM_LEVEL_KEY, level)")
  })

  test("the zoom channels answer the renderer's own top frame only", async () => {
    const shell = await code(path.join(here, "src/main/own-shell.ts"))
    for (const channel of ["zoomGet", "zoomSet", "zoomStep"]) {
      const at = shell.indexOf(`ipcMain.handle(OwnIpc.${channel},`)
      expect(at).toBeGreaterThan(0)
      expect(shell.slice(at, shell.indexOf("})", at))).toContain("fromRenderer(event)")
    }
  })
})
