// Substitutes keep upstream's exports (05 §4.3 "export 호환"), the protocol claim stays out (G-D2), the GUI plugin
// host runs the browser pane alone and evaluates no plugin of the service (05 §8.1), and the build plugin swaps by
// resolved path and fails when a key never matched.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { normalizeId, ownOverrides } from "../build/overrides"

const here = path.resolve(import.meta.dir, "..")
const desktop = path.resolve(here, "../desktop")
const guiPlugins = path.resolve(here, "../gui-plugins")
const read = (file: string) => Bun.file(file).text()
/** Source without line comments: the headers explain what the code must not do, in words. */
const code = async (file: string) =>
  (await read(file))
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")

/** The upstream paths electron.vite.config.ts swaps (`OVERRIDES` keys), read from its text: importing it runs upstream's config. */
async function overrideKeys() {
  const roots: Readonly<Record<string, string>> = { desktop, guiPlugins }
  const config = await code(path.join(here, "electron.vite.config.ts"))
  return [...config.matchAll(/^\s*\[path\.join\((\w+), "([^"]+)"\)\]:/gm)].map((match) =>
    path.join(roots[match[1]!]!, match[2]!),
  )
}

function exportNames(source: string) {
  return [...source.matchAll(/^export (?:async )?(?:const|function|let|class) (\w+)/gm)].map((match) => match[1]).sort()
}

describe("substitutes", () => {
  const pairs = [
    [path.join(desktop, "src/main/constants.ts"), "src/overrides/constants.ts"],
    [path.join(desktop, "src/main/lifecycle/environment.ts"), "src/overrides/environment.ts"],
    [path.join(guiPlugins, "src/main.ts"), "src/overrides/gui-plugins.ts"],
    [path.join(desktop, "src/main/plugin/manager.ts"), "src/overrides/plugin-manager.ts"],
    [path.join(desktop, "src/main/plugin/module.ts"), "src/overrides/plugin-module.ts"],
    [path.join(desktop, "src/main/ipc-handlers/files.ts"), "src/overrides/ipc-files.ts"],
    [path.join(desktop, "src/main/windows/appearance.ts"), "src/overrides/appearance.ts"],
    [path.join(guiPlugins, "src/browser/pane.ts"), "src/overrides/browser-pane.ts"],
  ] as const

  test("every substitute the build swaps in is checked here", async () => {
    expect((await overrideKeys()).toSorted()).toEqual(pairs.map(([upstream]) => upstream).toSorted())
  })

  for (const [upstream, own] of pairs)
    test(`${own} exports what ${path.relative(path.dirname(here), upstream)} exports`, async () => {
      const original = exportNames(await read(upstream))
      expect(original.length).toBeGreaterThan(0)
      expect(exportNames(await read(path.join(here, own)))).toEqual(original)
    })

  test("the own environment never claims opencode:// (upstream still does, so the override still matters)", async () => {
    expect(await read(path.join(desktop, "src/main/lifecycle/environment.ts"))).toContain(
      'setAsDefaultProtocolClient("opencode")',
    )
    const own = await code(path.join(here, "src/overrides/environment.ts"))
    expect(own).not.toMatch(/setAsDefaultProtocolClient\s*\(/)
    expect(own).not.toContain("OPENCODE_CLIENT:")
    expect(own).not.toContain("delete process.env.XDG_STATE_HOME")
  })

  test("upstream opens the folder dialog without an owner; the own handler makes it modal, one per window", async () => {
    // Upstream: no window argument, so the app window stays live and every click opens another dialog.
    expect(await code(path.join(desktop, "src/main/files/index.ts"))).toContain("dialog.showOpenDialog({")
    expect(await code(path.join(desktop, "src/main/ipc-handlers/files.ts"))).toContain(
      "FilesOpenDirectoryPicker: ({ options }) => files.openDirectoryPicker(options)",
    )
    const own = await code(path.join(here, "src/overrides/ipc-files.ts"))
    expect(own).toContain("BrowserWindow.fromWebContents(contents)")
    expect(own).toContain("dialog.showOpenDialog(owner, settings)")
    expect(own).toContain("folderDialogs.get(contents.id)")
    expect(own).not.toContain("files.openDirectoryPicker(")
  })

  test("the own identity differs from every upstream channel", async () => {
    const own = await code(path.join(here, "src/overrides/constants.ts"))
    expect(own).toContain('"dev.own.opencode.desktop"')
    expect(own).toContain('"dev.own.opencode.desktop.local"')
    expect(own).not.toContain("ai.opencode.desktop")
  })
})

describe("GUI plugins (05 §8.1): the browser pane alone, no plugin of the service", () => {
  test("upstream starts its built-ins with the window, the updater among them for packaged builds", async () => {
    expect(await read(path.join(desktop, "src/main/desktop.ts"))).toContain("yield* Effect.forkScoped(plugins.start)")
    const builtins = await read(path.join(guiPlugins, "src/main.ts"))
    for (const name of ["updater", "ssh", "wsl", "pairing"])
      expect(builtins).toContain(`${name}: { ...${name}, mainEntry: () => import("./${name}/main") }`)
    expect(await read(path.join(guiPlugins, "src/updater/main.ts"))).toContain("const enabled = build.packaged")
    const host = await read(path.join(desktop, "src/main/plugin/host.ts"))
    expect(host).toContain('import { builtins } from "@opencode/gui-plugins/main"')
    expect(host).toContain('import { createManager } from "./manager"')
    expect(host).toContain('import { evaluateMain } from "./module"')
  })

  test("upstream evaluates every listed bundle of its server in main, enabled or not; the shell substitutes both", async () => {
    const host = await code(path.join(desktop, "src/main/plugin/host.ts"))
    const listing = host.slice(host.indexOf("const readPlugin = async ("))
    const body = listing.slice(0, listing.indexOf("\n  }\n"))
    expect(body).toContain("const loaded = await evaluateMain(bundle.code)")
    expect(body).not.toContain("manager.enabled")
    // The lifecycle asks the manager before it loads or runs anything.
    expect(host).toContain("enabled: (id) => manager.enabled(id),")
    expect(await code(path.join(desktop, "src/main/plugin/lifecycle.ts"))).toContain(
      "const canRun = (id: string) => input.enabled(id) && !isQuitting(input.state())",
    )
  })

  test("the shell starts them too, and its list is upstream's browser plugin and own's explorer", async () => {
    expect(await code(path.join(here, "src/main/desktop.ts"))).toContain("yield* Effect.forkScoped(plugins.start)")
    const own = await code(path.join(here, "src/overrides/gui-plugins.ts"))
    expect(own).not.toMatch(/updater|ssh|wsl|pairing/i)
    const { builtins } = await import("../src/overrides/gui-plugins")
    // `explorer` is own's (05 §7.10, test/explorer.test.ts); of upstream's built-ins only the browser pane runs.
    expect(builtins.map((definition) => definition.id)).toEqual(["browser", "explorer"])
    expect(typeof builtins[0]?.mainEntry).toBe("function")
    // Its main entry provides the `browser.pane` Ipc own-web calls (PluginCall).
    expect(await read(path.join(guiPlugins, "src/browser/main.ts"))).toContain("ctx.provide(BrowserPane, {")
  })

  test("no plugin of the service runs: none is enabled, none is evaluated, none can be switched on", async () => {
    const { createManager } = await import("../src/overrides/plugin-manager")
    const manager = createManager(undefined as never, ["browser"])
    expect(manager.enabled("browser")).toBe(true)
    expect(manager.enabled("acme-gui")).toBe(false)
    expect(() => manager.setEnabled("acme-gui", true)).toThrow("unavailable")
    expect(() => manager.setEnabled("browser", false)).toThrow("builtin")
    const { evaluateMain } = await import("../src/overrides/plugin-module")
    const marker = "__ownDesktopBundleRan"
    await expect(evaluateMain(`globalThis.${marker} = true`)).rejects.toMatchObject({ code: "unavailable" })
    expect(marker in globalThis).toBe(false)
  })

  test("Plugin IPC answers only an app window showing the renderer; upstream no longer refuses the manager", async () => {
    const handlers = await read(path.join(desktop, "src/main/ipc-handlers/plugins.ts"))
    // Never a pane tab, 원격 PC or preview page.
    expect(handlers).toContain("!isRendererUrl(contents.getURL())")
    expect(handlers).not.toContain("app.isPackaged")
    expect(handlers).toContain("PluginEnable: ({ id }) => manage((host) => host.enable(id)),")
  })

  test("원격 PC and 모바일 미리보기 windows load no preload, so their pages never get the shell's IPC port", async () => {
    const partition = await code(path.join(here, "src/main/remote-pcs/partition.ts"))
    const prefs = partition.slice(partition.indexOf("export function pageWebPreferences"))
    expect(prefs.slice(0, prefs.indexOf("}\n"))).toContain("sandbox: true")
    expect(prefs.slice(0, prefs.indexOf("}\n"))).not.toContain("preload")
  })
})

describe("override plugin", () => {
  const from = path.join(desktop, "src/main/constants.ts")
  const to = path.join(here, "src/overrides/constants.ts")
  type Handler = (this: unknown, source: string, importer: string | undefined, options: object) => Promise<unknown>

  function setup(resolvedId: string) {
    const plugin = ownOverrides({ [from]: to })
    const hook = plugin.resolveId as { filter: { id: RegExp }; handler: Handler }
    const errors: string[] = []
    const context = {
      resolve: async () => ({ id: resolvedId }),
      error: (message: string) => {
        errors.push(message)
      },
    }
    return {
      plugin,
      hook,
      errors,
      resolve: (source: string, importer: string) => hook.handler.call(context, source, importer, {}),
      end: () => (plugin.buildEnd as (this: unknown, error?: Error) => void).call(context),
    }
  }

  test("swaps any specifier that resolves to the upstream file, case- and separator-insensitive", async () => {
    const run = setup(from.toUpperCase().replaceAll("\\", "/"))
    expect(run.hook.filter.id.test("../constants")).toBe(true)
    expect(await run.resolve("../constants", path.join(desktop, "src/main/lifecycle/configure.ts"))).toBe(to)
    run.end()
    expect(run.errors).toEqual([])
    expect(run.plugin.matched()).toEqual([normalizeId(from)])
  })

  test("leaves the replacement's own imports alone", async () => {
    const run = setup(from)
    expect(await run.resolve("./constants", to)).toBeUndefined()
  })

  test("fails the build when a key never matched (upstream renamed or moved the file)", async () => {
    const run = setup(path.join(desktop, "src/main/other.ts"))
    expect(await run.resolve("../other", path.join(desktop, "src/main/index.ts"))).toBeUndefined()
    run.end()
    expect(run.errors.join("\n")).toContain("no import resolved to")
  })
})

describe("microphone for voice input (02 §3.9, 05 §7.8): audio only, the renderer or a 원격 PC's app origin only", () => {
  test("media is granted only when every requested medium is audio", async () => {
    const { audioOnlyCheck, audioOnlyRequest } = await import("../src/main/media-permission")
    expect(audioOnlyRequest("media", ["audio"])).toBe(true)
    for (const types of [["video"], ["audio", "video"], [], undefined])
      expect({ types, ok: audioOnlyRequest("media", types) }).toEqual({ types, ok: false })
    expect(audioOnlyRequest("display-capture", ["audio"])).toBe(false)
    expect(audioOnlyRequest("geolocation", ["audio"])).toBe(false)
    expect(audioOnlyCheck("media", "audio")).toBe(true)
    for (const type of ["video", "unknown", undefined]) expect(audioOnlyCheck("media", type)).toBe(false)
    expect(audioOnlyCheck("notifications", "audio")).toBe(false)
  })

  test("upstream grants the renderer's main frame the microphone, audio only, so the shell no longer substitutes it", async () => {
    const upstream = await code(path.join(desktop, "src/main/windows/security.ts"))
    expect(upstream).toContain('const rendererPermissions = new Set(["clipboard-sanitized-write", "notifications"])')
    // Request: a renderer window's main frame (since v2.2.5 every window wired through allowRendererPermissions, one
    // handler pair per shared session), every requested medium audio.
    expect(upstream).toContain('details.mediaTypes.every((type) => type === "audio")')
    expect(upstream).toContain("allowed.has(webContents.id) &&\n          isRendererUrl(details.requestingUrl) &&")
    // Check: the same, for audio.
    expect(upstream).toContain("allowed.has(webContents.id) &&\n        isRendererUrl(details.requestingUrl) &&")
    expect(upstream).toContain('details.mediaType === "audio"')
    expect(upstream).not.toMatch(/["']video["']|display-capture|camera/)
    expect((await overrideKeys()).map((key) => path.basename(key))).not.toContain("security.ts")
  })

  test("a 원격 PC window grants it to that PC's app origin only", async () => {
    const partition = await code(path.join(here, "src/main/remote-pcs/partition.ts"))
    expect(partition).toContain(
      'audioOnlyRequest(permission, "mediaTypes" in details ? details.mediaTypes : undefined)) &&',
    )
    expect(partition).toContain("sameOrigin(details.requestingUrl, pcKey)")
    expect(partition).toContain("audioOnlyCheck(permission, details.mediaType)) && sameOrigin(origin, pcKey)")
  })
})
