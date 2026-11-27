// 앱 종료 / 완전 종료 in the app (05 §7.3): the palette's `앱` commands over a fake `host.app`, Ctrl+Q in the keymap
// and its audit, the words in Korean and English, and where the buttons and the close-action setting are wired. Solid
// components do not render under `bun test` (JSX compiles for React), so the wiring is checked in this package's
// source; the shell's own tests (own-desktop test/tray-quit.test.ts, scripts/tray-quit.ts) cover the other side.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_KEYMAP, findConflicts } from "@/keyboard/keymap"
import { auditKeymap, checkChord } from "@/palette/audit"
import { PALETTE_GROUPS } from "@/palette/registry"
import { paletteText } from "@/palette/strings"
import type { HostApp } from "@/host/types"
import { translate } from "@/i18n"
import { quitCommands } from "./index"
import { quitSettingsEn, quitSettingsKo, quitSettingsText } from "./settings-strings"
import { appQuitEn, appQuitKo, appQuitText } from "./strings"

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

function fakeApp() {
  const calls: string[] = []
  const app: HostApp = {
    quit: async (mode) => {
      calls.push(mode)
      return false
    },
    closeAction: async () => "tray",
    setCloseAction: async (action) => action,
  }
  return { app, calls }
}

describe("palette (05 §7.3)", () => {
  test("`앱` group: 앱 종료 and 완전 종료…, which carries Ctrl+Q; each asks the shell for its quit", () => {
    const { app, calls } = fakeApp()
    const commands = quitCommands(app, "ko")
    expect(
      commands.map((command) => [command.id, command.group, command.title, command.detail, command.shortcut]),
    ).toEqual([
      ["app.quit", "app", "앱 종료", "서비스는 계속 실행", undefined],
      ["app.quitAll", "app", "완전 종료…", "이 PC의 서비스도 끔", "app.quitAll"],
    ])
    commands.forEach((command) => void command.run())
    expect(calls).toEqual(["app", "all"])
    expect(PALETTE_GROUPS.at(-1)).toBe("app")
    expect(paletteText("ko", "own.palette.group.app")).toBe("앱")
    expect(paletteText("en", "own.palette.group.app")).toBe("App")
  })

  test("found by the other language and the words people type", () => {
    const [quit, all] = quitCommands(fakeApp().app, "ko")
    expect(quit!.keywords).toEqual(expect.arrayContaining(["Quit app", "quit", "exit", "끄기", "닫기"]))
    expect(all!.keywords).toEqual(expect.arrayContaining(["Quit completely…", "stop service", "서비스 끄기"]))
    const english = quitCommands(fakeApp().app, "en")
    expect(english.map((command) => command.title)).toEqual(["Quit app", "Quit completely…"])
    expect(english[0]!.keywords).toContain("앱 종료")
  })

  test("the palette's own list leaves Ctrl+Q's command to this module", async () => {
    expect(await code("../palette/builtin.ts")).toMatch(/"idea\.capture",\s*"app\.quitAll",\s*\]\)/)
  })
})

describe("Ctrl+Q (03 §10)", () => {
  test("app.quitAll is Ctrl+Q, global, without a conflict, and passes the audit on Windows and macOS", () => {
    expect(DEFAULT_KEYMAP["app.quitAll"]).toEqual({ chords: ["Mod+KeyQ"], scope: "global" })
    expect(findConflicts(DEFAULT_KEYMAP)).toEqual([])
    for (const mac of [false, true]) expect(auditKeymap(DEFAULT_KEYMAP, { mac }).issues).toEqual([])
    expect(translate("ko", "own.set.sc.app.quitAll")).toBe("완전 종료(데스크톱)")
    expect(translate("en", "own.set.sc.app.quitAll")).toBe("Quit completely (desktop)")
  })

  test("⌘Q stays the OS's quit for every other action on macOS; on Windows Ctrl+Q is free", () => {
    expect(checkChord(DEFAULT_KEYMAP, "panel.toggle", "Mod+KeyQ", { mac: true })?.kind).toBe("browser")
    expect(checkChord(DEFAULT_KEYMAP, "app.quitAll", "Mod+KeyQ", { mac: true })).toBeUndefined()
    expect(checkChord(DEFAULT_KEYMAP, "panel.toggle", "Mod+KeyQ")?.kind).toBe("conflict")
  })

  test("registered only with the shell's quit, from the shell's palette commands", async () => {
    const source = await code("index.tsx")
    expect(source).toMatch(
      /const app = host\.app\s+if \(!app\) return\s+useShortcut\("app\.quitAll", \(\) => void app\.quit\("all"\)\)/,
    )
    expect(await code("../shell/palette-commands.tsx")).toContain("useQuitCommands()")
  })
})

describe("buttons and the close action (05 §7.3, 03 §5.7)", () => {
  test("the server status popover and 설정 > 데스크톱 앱 carry the two buttons", async () => {
    expect(await code("../mcp/server-panel.tsx")).toContain("<QuitButtons")
    const settings = await code("../settings/sections.tsx")
    expect(settings).toContain("<Show when={host.app}>{(app) => <QuitSettings app={app()} />}</Show>")
    // The desktop page shows for the quit rows too; the zoom row lives in 일반 (05 §7.9), not here.
    expect(settings).toMatch(/host\.capabilities\.openInApp \|\|\s*!!host\.app/)
    expect(settings).toContain('(["tray", "quit"] as const)')
    expect(settings).toContain("<QuitButtons />")
    expect(await code("../palette/builtin.ts")).toMatch(/host\.capabilities\.openInApp \|\|\s*!!host\.app/)
  })

  test("each button asks for its quit and says what it does", async () => {
    const source = await code("index.tsx")
    expect(source).toMatch(
      /title=\{text\("own\.quit\.app\.hint"\)\}[\s\S]*onClick=\{\(\) => void app\(\)\.quit\("app"\)\}/,
    )
    expect(source).toMatch(
      /title=\{text\("own\.quit\.all\.hint"\)\}[\s\S]*onClick=\{\(\) => void app\(\)\.quit\("all"\)\}/,
    )
  })

  test("the words, in Korean and English, every key in both", () => {
    expect(Object.keys(appQuitEn).sort()).toEqual(Object.keys(appQuitKo).sort())
    expect(Object.keys(quitSettingsEn).sort()).toEqual(Object.keys(quitSettingsKo).sort())
    expect(quitSettingsText.text("ko", "own.quit.close.tray")).toBe("트레이로 숨기기")
    expect(quitSettingsText.text("ko", "own.quit.close.quit")).toBe("앱 종료")
    expect(quitSettingsText.text("ko", "own.quit.close")).toBe("창을 닫으면")
    expect(appQuitText.text("ko", "own.quit.app.hint")).toContain("서비스는 계속")
    expect(quitSettingsText.text("en", "own.quit.close.tray")).toBe("Hide in the tray")
  })
})
