// 원격 PC 전용 build (own/reports/win-arm64-2026-11-06.md): the renderer choice, the tray, the packaging switch, the
// remote-client page's words and the build wiring. The device run (own/scripts/test/win-arm64-device.ts) covers the
// rest on the ARM64 machine.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { errorText, ERROR_TEXT, expiryText, sasText, STATE_TEXT } from "../src/client/strings"
import { CLIENT_TRAY_MENU, TRAY_MENU } from "../src/main/quit-model"
import { clientRenderer, movedRoot, selectRenderer } from "../src/main/renderer-root"

const base = { webRoot: "W", fallbackRoot: "F", rpcHash: "aaaaaaaaaaaaaaaa" }

describe("renderer of the client build", () => {
  test("always the shell's own page, whatever is installed", () => {
    expect(clientRenderer("F")).toEqual({ root: "F", source: { source: "fallback", reason: "missing" } })
  })
  test("never follows a later install (only an installed UI moves)", () => {
    const source = clientRenderer("F").source
    expect(movedRoot({ source, current: "F", installedWeb: "W2", webIndexExists: () => true })).toBeUndefined()
  })
  test("the full shell's choice is untouched", () => {
    const choice = selectRenderer({
      ...base,
      webIndexExists: true,
      manifest: { version: "v", rpcHash: "aaaaaaaaaaaaaaaa" },
    })
    expect(choice.source.source).toBe("installed")
  })
  test("own-shell picks it only under the build constant", async () => {
    const shell = await Bun.file(path.join(import.meta.dir, "../src/main/own-shell.ts")).text()
    expect(shell).toMatch(/clientOnly\s*\?\s*clientRenderer\(/)
  })
})

describe("tray of the client build", () => {
  test("one plain quit, no service wording", () => {
    expect(CLIENT_TRAY_MENU).toEqual([
      { label: "열기", action: "open" },
      { separator: true },
      { label: "종료", action: "quitApp" },
    ])
    expect(JSON.stringify(CLIENT_TRAY_MENU)).not.toContain("서비스")
    // The full shell keeps its menu.
    expect(TRAY_MENU.map((item) => ("action" in item ? item.action : "-"))).toEqual(["open", "-", "quitApp", "quitAll"])
  })
})

// The first import loads electron-builder and upstream's config: tens of seconds on a cold transpiler cache.
const IMPORT_TIMEOUT = 180_000

describe("packaging switch (OWN_DESKTOP_CLIENT_ONLY)", () => {
  test(
    "client build: own artifact name, never a payload",
    async () => {
      const { isClientOnly, ownBuilderConfig } = await import("../electron-builder.config")
      expect(isClientOnly({ OWN_DESKTOP_CLIENT_ONLY: "1" })).toBe(true)
      expect(isClientOnly({ OWN_DESKTOP_CLIENT_ONLY: "true" })).toBe(false)
      const config = ownBuilderConfig({ OWN_DESKTOP_CLIENT_ONLY: "1" })
      expect(config.artifactName).toBe("own-desktop-client-${version}-${os}-${arch}.${ext}")
      expect(config.extraResources).toEqual([])
      expect(config.appId).toBe("dev.own.opencode.desktop")
      expect(config.publish).toBeNull()
      expect(config.protocols).toEqual([])
    },
    IMPORT_TIMEOUT,
  )
  test(
    "a payload with the client switch is refused",
    async () => {
      const { ownBuilderConfig } = await import("../electron-builder.config")
      const root = mkdtempSync(path.join(os.tmpdir(), "own-client-config-"))
      try {
        mkdirSync(path.join(root, "app"), { recursive: true })
        mkdirSync(path.join(root, "bin"), { recursive: true })
        writeFileSync(path.join(root, "app", "manifest.json"), "{}")
        writeFileSync(path.join(root, "bin", "own.ps1"), "")
        expect(() => ownBuilderConfig({ OWN_DESKTOP_CLIENT_ONLY: "1", OWN_DESKTOP_PAYLOAD: root })).toThrow(
          "shell-only installer",
        )
        // The full build is unchanged.
        expect(ownBuilderConfig({ OWN_DESKTOP_PAYLOAD: root }).artifactName).toBe(
          "own-desktop-${version}-${os}-${arch}.${ext}",
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    IMPORT_TIMEOUT,
  )
})

describe("remote-client page words", () => {
  test("every pairing error code has a sentence; only failed carries its detail", () => {
    for (const code of Object.keys(ERROR_TEXT) as (keyof typeof ERROR_TEXT)[])
      expect(errorText(code).length).toBeGreaterThan(5)
    expect(errorText("failed", "ECONNRESET")).toBe("연결하지 못했어요 (ECONNRESET).")
    expect(errorText("expired", "secret detail")).not.toContain("secret")
  })
  test("states, confirmation number and expiry", () => {
    expect(Object.keys(STATE_TEXT).sort()).toEqual(["checking", "connected", "reauth", "unreachable"])
    expect(sasText("4821", "집 PC")).toContain("4821")
    expect(expiryText(0)).toBe("")
    expect(expiryText(Date.UTC(2026, 10, 13, 12))).toContain("까지")
  })
})

describe("build wiring", () => {
  const read = (file: string) => Bun.file(path.join(import.meta.dir, "..", file)).text()
  test("vite: the client page replaces the fallback page only under OWN_DESKTOP_CLIENT_ONLY=1", async () => {
    const config = await read("electron.vite.config.ts")
    expect(config).toContain('process.env.OWN_DESKTOP_CLIENT_ONLY === "1"')
    expect(config).toContain('"import.meta.env.OWN_CLIENT_ONLY"')
    expect(config).toContain('CLIENT_ONLY ? "src/client" : "src/fallback"')
  })
  test("the page uses only window.own.remotePcs (no upstream IPC, no service)", async () => {
    const page = await read("src/client/main.ts")
    expect(page).toContain("own?.remotePcs")
    expect(page).not.toContain("window.electron")
    expect(page).not.toMatch(/fetch\(/)
    const html = await read("src/client/index.html")
    for (const id of ["client-link", "client-connect", "client-sas", "client-status", "client-pcs"])
      expect(html).toContain(`data-testid="${id}"`)
  })
  test("main: the client switch is a build constant", async () => {
    expect(await read("src/main/client-only.ts")).toContain('import.meta.env.OWN_CLIENT_ONLY === "1"')
    expect(await read("src/main/service/background-service-own.ts")).toMatch(
      /if \(clientOnly\) return yield\* Effect\.fail/,
    )
  })
})
