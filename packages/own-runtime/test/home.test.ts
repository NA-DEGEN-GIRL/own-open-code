// The installed version (01 §5.1): app\current.json first, an older launcher's app\current junction only as a link.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Home } from "../src/home.js"

const roots: string[] = []
afterEach(() => {
  // Links first (never followed), then the rest.
  for (const root of roots.splice(0)) {
    const current = path.join(root, "app", "current")
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(current)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-home-"))
  roots.push(root)
  return root
}

function version(root: string, name: string) {
  const dir = path.join(root, "app", name)
  fs.mkdirSync(path.join(dir, "plugins", "own-accounts"), { recursive: true })
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: name, channel: "own" }))
  return dir
}

function pointer(root: string, value: unknown) {
  fs.mkdirSync(path.join(root, "app"), { recursive: true })
  fs.writeFileSync(Home.pointerFile(root), typeof value === "string" ? value : JSON.stringify(value))
}

describe("Home.installed / layout.app", () => {
  test("the pointer names app\\<version> next to it (path is informational), with previous", () => {
    const root = home()
    const dir = version(root, "2.0.18-own.3")
    version(root, "2.0.18-own.2")
    pointer(root, { schema: 1, version: "2.0.18-own.3", path: "C:\\moved\\elsewhere", previous: "2.0.18-own.2" })
    expect(Home.installed(root)).toEqual({ version: "2.0.18-own.3", dir, source: "pointer", previous: "2.0.18-own.2" })
    const layout = Home.layout(root)
    expect(layout.app).toBe(dir)
    expect(layout.vaultExe).toBe(path.join(dir, "own-vault.exe"))
    expect(layout.ratecardsSeed).toBe(path.join(dir, "templates", "ratecards.default.json"))
    expect(layout.installed?.source).toBe("pointer")
  })

  test("a UTF-8 BOM is accepted; a bad version, a path segment or a folder without manifest.json is not", () => {
    const root = home()
    const dir = version(root, "2.0.18-own.3")
    pointer(root, "\uFEFF" + JSON.stringify({ version: "2.0.18-own.3" }))
    expect(Home.installed(root)?.dir).toBe(dir)
    for (const bad of ["..", "../x", "a\\b", "current", "", "2.0.18-own.9"]) {
      pointer(root, { version: bad })
      expect(Home.installed(root)).toBeUndefined()
    }
    pointer(root, "{not json")
    expect(Home.installed(root)).toBeUndefined()
    expect(Home.layout(root).app).toBe(path.join(root, "app", "current"))
  })

  test("an older launcher's junction: its target is used directly, the link is never followed", () => {
    const root = home()
    const dir = version(root, "2.0.18-own.2")
    fs.symlinkSync(dir, path.join(root, "app", "current"), "junction")
    expect(Home.installed(root)).toEqual({ version: "2.0.18-own.2", dir, source: "junction" })
    expect(Home.layout(root).app).toBe(dir)
    // The pointer wins over the junction once written.
    const next = version(root, "2.0.18-own.3")
    pointer(root, { version: "2.0.18-own.3", previous: "2.0.18-own.2" })
    expect(Home.layout(root).app).toBe(next)
  })

  test("a junction that cannot be followed (target gone) reads as not installed, without throwing", () => {
    const root = home()
    const gone = path.join(root, "app", "gone")
    fs.mkdirSync(gone, { recursive: true })
    fs.symlinkSync(gone, path.join(root, "app", "current"), "junction")
    fs.rmSync(gone, { recursive: true })
    expect(() => fs.statSync(path.join(root, "app", "current"))).toThrow()
    expect(Home.installed(root)).toBeUndefined()
    expect(Home.layout(root).app).toBe(path.join(root, "app", "current"))
  })

  test("a plain app\\current folder with a manifest still reads (hand-made layouts)", () => {
    const root = home()
    const dir = version(root, "current")
    expect(Home.installed(root)).toEqual({ version: "current", dir, source: "folder" })
  })

  test("nothing installed", () => {
    expect(Home.installed(home())).toBeUndefined()
  })
})
