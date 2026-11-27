// Tray and quit (05 §7.3) without Electron: the close decision, the tray icon sizes, tooltip and menu, 완전 종료's dialog
// for each kind of service, the launcher's stop command and the start hold. scripts/tray-quit.ts runs the real shell.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  closeAction,
  closeOutcome,
  fullQuitPrompt,
  stopFailedPrompt,
  TRAY_HINT,
  TRAY_MENU,
  trayIconSize,
  trayIconSource,
  trayToolTip,
} from "../src/main/quit-model"
import {
  holdStarts,
  launcherCommand,
  STOP_TIMEOUT_MS,
  startsHeld,
  stopResult,
  type LauncherResult,
} from "../src/main/service/launcher"

const read = (file: string) => Bun.file(path.join(import.meta.dir, file)).text()

describe("the window's X (05 §7.3)", () => {
  const window = { action: "tray" as const, main: true, visible: true, otherVisibleMain: false }

  test("stored close action: only `quit` quits; anything else is the default, 트레이로 숨기기", () => {
    expect(closeAction("quit")).toBe("quit")
    for (const value of ["tray", undefined, null, "Quit", 1, {}]) expect(closeAction(value)).toBe("tray")
  })

  test("the last visible app window hides to the tray, minimized ones too (they are visible)", () => {
    expect(closeOutcome(window)).toBe("hide")
  })

  test("closes: 앱 종료 chosen, another app window still shown, a remote PC or preview window, a hidden window", () => {
    expect(closeOutcome({ ...window, action: "quit" })).toBe("close")
    expect(closeOutcome({ ...window, otherVisibleMain: true })).toBe("close")
    expect(closeOutcome({ ...window, main: false })).toBe("close")
    // A WM_CLOSE to a window already in the tray is not the user's X (Restart Manager, taskkill without /f).
    expect(closeOutcome({ ...window, visible: false })).toBe("close")
  })

  test("windows-own.ts: quit and sign-out pass first, then the tray, then the browser close guard", async () => {
    const source = await read("../src/main/windows-own.ts")
    const close = source.slice(source.indexOf('win.on("close"'), source.indexOf('contents.on("will-prevent-unload"'))
    const order = ["if (quitting || confirmed) return", "if (hidesToTray(win))", "if (!guards.get(contents)) return"]
    const at = order.map((line) => close.indexOf(line))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // Windows sign-out reaches windows as session-end without before-quit: both set `quitting`.
    expect(source).toContain('win.on("session-end", quit)')
    expect(source).toContain('app.on("before-quit", quit)')
  })
})

describe("tray icon (05 §7.3)", () => {
  test("exact pixels per display scale, 100–200 % and beyond; nonsense scales are 100 %", () => {
    expect([1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(trayIconSize)).toEqual([16, 20, 24, 28, 32, 40, 48])
    expect([0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(trayIconSize)).toEqual([16, 16, 16, 16])
  })

  test("scaled down from the smallest icon PNG at least that size", () => {
    expect([16, 20, 24, 28, 32].map(trayIconSource)).toEqual(Array(5).fill("32x32.png"))
    expect([40, 48, 64].map(trayIconSource)).toEqual(Array(3).fill("64x64.png"))
    expect(trayIconSource(96)).toBe("icon.png")
  })

  test("tooltip: product, then the service state and the running conversations", () => {
    expect(trayToolTip()).toBe("Own OpenCode")
    expect(trayToolTip({ running: false })).toBe("Own OpenCode\n서비스 꺼짐")
    expect(trayToolTip({ running: true })).toBe("Own OpenCode\n서비스 실행 중")
    expect(trayToolTip({ running: true, active: 0 })).toBe("Own OpenCode\n서비스 실행 중")
    expect(trayToolTip({ running: true, active: 2 })).toBe("Own OpenCode\n서비스 실행 중 · 대화 2개 진행 중")
    // Windows cuts tooltips at 127 characters.
    expect(trayToolTip({ running: true, active: 999 }).length).toBeLessThan(128)
  })

  test("menu: 열기, separator, 앱 종료 with its hint, 완전 종료… (asks)", () => {
    expect(TRAY_MENU).toEqual([
      { label: "열기", action: "open" },
      { separator: true },
      { label: "앱 종료 (서비스는 계속 실행)", action: "quitApp" },
      { label: "완전 종료…", action: "quitAll" },
    ])
  })

  test("the one-time hint says where the icon is and how to quit; a Windows balloon holds 255 characters", () => {
    expect(TRAY_HINT).toContain("트레이")
    expect(TRAY_HINT).toContain("완전 종료")
    expect(TRAY_HINT.length).toBeLessThan(256)
  })

  test("quit.ts: click and double-click open, the menu's items call the quit paths, the tray goes at will-quit", async () => {
    const source = await read("../src/main/quit.ts")
    expect(source).toContain('created.on("click", open)')
    expect(source).toContain('created.on("double-click", open)')
    expect(source).toContain("const actions = { open, quitApp, quitAll: () => void quitAll() }")
    expect(source).toContain("created.destroy()")
    const desktop = await read("../src/main/desktop.ts")
    expect(desktop).toMatch(
      /Effect\.acquireRelease\(\s*Effect\.sync\(\(\) => wireTray\(lifecycle\.createWindow\)\),\s*\(dispose\) =>/,
    )
  })
})

describe("완전 종료 (05 §7.3)", () => {
  const own = {
    channel: "own" as const,
    running: true,
    version: "2.0.24-own.0",
    installed: "2.0.24-own.0",
    remote: false,
  }

  test("no service: nothing to stop or ask, the app just quits", () => {
    expect(fullQuitPrompt({ ...own, running: false, active: 3, remote: true })).toEqual({ kind: "quit" })
  })

  test("the installed release's service: 완전 종료, 앱만 종료, 취소 (default), naming what stops", () => {
    const prompt = fullQuitPrompt({ ...own, active: 2, remote: true })
    expect(prompt).toMatchObject({
      kind: "ask",
      type: "warning",
      message: "완전 종료할까요?",
      buttons: ["완전 종료", "앱만 종료", "취소"],
      choices: ["all", "app", "cancel"],
      cancelId: 2,
    })
    if (prompt.kind !== "ask") throw new Error("expected a dialog")
    expect(prompt.detail.split("\n")).toEqual([
      "앱과 이 PC의 백그라운드 서비스를 모두 꺼요.",
      "· 실행 중인 대화 2개가 멈춰요. 다음에 앱을 열면 이어서 돌지만 캐시는 새로 쌓여요.",
      "· 휴대폰과 다른 PC의 연결이 끊겨요.",
      "서비스는 두고 앱만 끄려면 [앱만 종료]를 누르세요.",
    ])
  })

  test("no running conversation and no remote access: only what the button does; uncounted: a hedged line", () => {
    const quiet = fullQuitPrompt({ ...own, active: 0 })
    expect(quiet.kind === "ask" && quiet.detail.split("\n")).toEqual([
      "앱과 이 PC의 백그라운드 서비스를 모두 꺼요.",
      "서비스는 두고 앱만 끄려면 [앱만 종료]를 누르세요.",
    ])
    const unknown = fullQuitPrompt({ ...own })
    expect(unknown.kind === "ask" && unknown.detail).toContain("실행 중인 대화가 있으면 멈춰요")
  })

  test("services this app does not stop: development, missing launcher, another version; only 앱만 종료 or 취소", () => {
    const cases = [
      fullQuitPrompt({ ...own, channel: "local" }),
      fullQuitPrompt({ ...own, missingLauncher: "C:\\own\\bin\\own.ps1" }),
      fullQuitPrompt({ ...own, version: "2.0.18-own.3" }),
    ]
    for (const prompt of cases)
      expect(prompt).toMatchObject({
        kind: "ask",
        type: "info",
        buttons: ["앱만 종료", "취소"],
        choices: ["app", "cancel"],
        cancelId: 1,
      })
    expect(cases.map((prompt) => prompt.kind === "ask" && prompt.message)).toEqual([
      "개발 서비스는 끄지 않아요",
      "서비스를 끌 수 없어요",
      "이 서비스는 끄지 않아요",
    ])
    expect(cases[1]!.kind === "ask" && cases[1]!.detail).toContain("C:\\own\\bin\\own.ps1")
    expect(cases[2]!.kind === "ask" && cases[2]!.detail).toContain("own stop")
    // An unknown version on either side is not a mismatch (like serviceStatus().managed).
    expect(fullQuitPrompt({ ...own, installed: undefined, active: 0 })).toMatchObject({ message: "완전 종료할까요?" })
  })

  test("a failed stop: the reason, then 앱만 종료 or 취소", () => {
    expect(stopFailedPrompt("런처가 오류로 끝났어요(종료 코드 1)")).toEqual({
      type: "error",
      message: "서비스를 끄지 못했어요",
      detail: "런처가 오류로 끝났어요(종료 코드 1)\n앱만 끄거나 취소할 수 있어요.",
      buttons: ["앱만 종료", "취소"],
      choices: ["app", "cancel"],
      cancelId: 1,
    })
  })
})

describe("the service's own stop path (05 §7.3, 01 §5.3)", () => {
  const result = (code: number | null, stderr = "", timedOut = false): LauncherResult => ({
    code,
    stderr,
    stdout: "",
    timedOut,
  })

  test("`own.ps1 stop --force` through powershell.exe, like every launcher run", () => {
    const command = launcherCommand({ launcher: "D:\\own\\bin\\own.ps1" }, "stop", ["--force"], {
      SystemRoot: "C:\\Windows",
    })
    expect(command).toEqual({
      file: path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "D:\\own\\bin\\own.ps1",
        "stop",
        "--force",
      ],
    })
    expect(STOP_TIMEOUT_MS).toBe(60_000)
  })

  test("results: 0 ok; anything else carries the reason and the stderr tail", () => {
    expect(stopResult(result(0))).toEqual({ ok: true })
    expect(stopResult(result(1, "own: opencode service stop failed (exit 1)"))).toEqual({
      ok: false,
      detail: "런처가 오류로 끝났어요(종료 코드 1)\nown: opencode service stop failed (exit 1)",
    })
    expect(stopResult(result(null, "", true))).toEqual({ ok: false, detail: "런처가 시간 안에 끝나지 않았어요" })
  })

  test("while 완전 종료 holds starts, a reconnect starts nothing", async () => {
    expect(startsHeld()).toBe(false)
    holdStarts(true)
    expect(startsHeld()).toBe(true)
    holdStarts(false)
    expect(startsHeld()).toBe(false)
    const service = await read("../src/main/service/background-service-own.ts")
    const run = service.slice(service.indexOf("exclusive(async () => {"), service.indexOf("runLauncher(command"))
    expect(run).toContain('if (startsHeld()) return { kind: "held" as const }')
  })
})

describe("window.own.app (05 §7.3)", () => {
  test("its own channels; the preload passes only `app`/`all` and `tray`/`quit`", async () => {
    const { OwnIpc } = await import("../src/preload/own-api")
    expect(OwnIpc.appQuit).toBe("own:app.quit")
    expect(OwnIpc.appCloseAction).toBe("own:app.close-action")
    const preload = await read("../src/preload/index.ts")
    expect(preload).toContain(
      'quit: (mode) => ipcRenderer.invoke(OwnIpc.appQuit, { mode: mode === "all" ? "all" : "app" })',
    )
    expect(preload).toContain('{ action: action === "quit" ? "quit" : "tray" }')
    const shell = await read("../src/main/own-shell.ts")
    expect(shell).toMatch(
      /ipcMain\.handle\(OwnIpc\.appQuit, async \(event, input: unknown\) => \{\s*fromRenderer\(event\)/,
    )
    expect(shell).toMatch(
      /ipcMain\.handle\(OwnIpc\.appCloseAction, async \(event, input: unknown\) => \{\s*fromRenderer\(event\)/,
    )
  })
})

describe("automated runs of the development shell (scripts/tray-quit.ts)", () => {
  test("off the screen, gone with the run, and 완전 종료 answered from a file: never in a packaged build", async () => {
    const shell = await read("../src/main/own-shell.ts")
    expect(shell).toContain("if (!app.isPackaged && Number.isInteger(run) && run > 0) {")
    expect(shell).toContain("win.setPosition(-32000, -32000)")
    expect(shell).toContain("win.setSkipTaskbar(true)")
    expect(shell).toContain("app.exit(0)")
    const quit = await read("../src/main/quit.ts")
    expect(quit).toContain("if (app.isPackaged || !process.env.OWN_DESKTOP_TEST_RUN || !file) return undefined")
  })
})
