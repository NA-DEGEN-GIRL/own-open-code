// 설정 > 기기 and the PWA build pieces (05 §13.5, §13.9 M1): the QR comes from uqr's matrix, the strings exist in both
// languages, the device scopes match the protocol, the icons are real PNGs, and the manifest is installable.
import { describe, expect, test } from "bun:test"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { MANIFEST } from "@/pwa/manifest"
import { iconPng, iconSvg } from "@/pwa/vite"
import { onGateway } from "@/pwa/gateway"
import { qrPath } from "./qr"
import { DEFAULT_SCOPES, RISKY, scopeList, SCOPES, TARGET_SCOPES, toggleScope } from "./scopes"
import { pairingEn, pairingKo, pairingText } from "./strings"

describe("pairing", () => {
  test("QR of a pairing link: a square matrix, dark modules drawn as one path", () => {
    const code = qrPath("https://my-pc.tail1234.ts.net/auth/connect/AbCdEfGhIjKlMnOpQrStUv")
    expect(code.size).toBeGreaterThanOrEqual(25)
    expect((code.size - 17) % 4).toBe(0)
    expect(code.path.startsWith("M")).toBe(true)
    // The three finder patterns: the top-left module is dark.
    expect(code.path).toContain("M0 0h1v1h-1z")
  })

  test("every Korean string has an English one", () => {
    expect(Object.keys(pairingKo).filter((key) => !(key in pairingEn))).toEqual([])
  })

  test("the scope list of the form is the protocol's, 브라우저 after 터미널, each with a name and a note", () => {
    expect(OwnRemote.DEVICE_SCOPES).toEqual(["read", "prompt", "switch", "files", "terminal", "browser", "admin"])
    expect(OwnRemote.DEFAULT_DEVICE_SCOPES).toEqual(["read", "prompt", "switch"])
    expect(SCOPES).toEqual(OwnRemote.DEVICE_SCOPES)
    expect(DEFAULT_SCOPES).toEqual(OwnRemote.DEFAULT_DEVICE_SCOPES)
    for (const scope of SCOPES)
      for (const key of [`own.pairing.scope.${scope}`, `own.pairing.scope.${scope}.note`])
        for (const catalog of [pairingKo, pairingEn]) expect(Object.keys(catalog)).toContain(key)
    expect(pairingText("ko", "own.pairing.scope.browser")).toBe("브라우저")
    expect(pairingText("ko", "own.pairing.scope.browser.note")).toBe(
      "이 기기에서 대화의 앱 안 브라우저를 봐요. ‘메시지 보내기’ 권한도 있으면 직접 조작해요. 브라우저에 로그인해 둔 페이지 화면이 이 기기로 가요.",
    )
  })

  test("브라우저 (05 §8.10.2) is off for every new device and is not the lost-device warning's", () => {
    for (const scopes of [DEFAULT_SCOPES, ...Object.values(TARGET_SCOPES)]) expect(scopes).not.toContain("browser")
    expect(scopeList(new Set(DEFAULT_SCOPES))).toEqual(["read", "prompt", "switch"])
    expect(RISKY.has("browser")).toBe(false)
  })

  test("ticking 브라우저 on a device sends it with the device's other permissions untouched, in the protocol's order", () => {
    // What `devices.update{deviceId, scopes}` carries for a phone and for another PC (the terminal ticked).
    const phone = toggleScope(new Set(DEFAULT_SCOPES), "browser")
    expect(scopeList(phone)).toEqual(["read", "prompt", "switch", "browser"])
    const pc = toggleScope(new Set([...TARGET_SCOPES.desktop, "terminal", "admin"] as const), "browser")
    expect(scopeList(pc)).toEqual(["read", "prompt", "switch", "files", "terminal", "browser", "admin"])
    // Off again: only that tick goes.
    expect(scopeList(toggleScope(phone, "browser"))).toEqual(["read", "prompt", "switch"])
    expect(scopeList(toggleScope(pc, "browser"))).toEqual(["read", "prompt", "switch", "files", "terminal", "admin"])
    // The last permission cannot be unticked (a device with none is disconnected instead).
    const only = new Set(["read"] as const)
    expect(toggleScope(only, "read")).toBe(only)
  })

  test("the gateway marker decides the mobile host", () => {
    expect(onGateway()).toBe(false)
    const meta = document.createElement("meta")
    meta.name = "own-gateway"
    document.head.append(meta)
    expect(onGateway()).toBe(true)
    meta.remove()
  })
})

describe("PWA build pieces", () => {
  test("icons: PNG signature and size, SVG mark", () => {
    for (const size of [192, 512]) {
      const png = iconPng(size)
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
    }
    expect(iconSvg()).toContain("<svg")
  })

  test("manifest: standalone, dark, scope /, 192 and 512 icons, a maskable one", () => {
    expect(MANIFEST).toMatchObject({ start_url: "/", scope: "/", display: "standalone", background_color: "#080808" })
    const sizes = MANIFEST.icons.map((icon) => icon.sizes)
    expect(sizes).toContain("192x192")
    expect(sizes).toContain("512x512")
    expect(MANIFEST.icons.some((icon) => icon.purpose === "maskable")).toBe(true)
  })
})
