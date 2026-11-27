import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { Policy } from "../../src/core/policy.js"
import { ToolSchema } from "../../src/core/schema.js"

const config: Policy.Config = {
  allowApps: [],
  denyApps: [],
  allowTerminals: false,
  allowSubagents: false,
  approval: "session",
}

const window = (exe: string, extra: Partial<Policy.WindowInfo> = {}): Policy.WindowInfo => ({
  id: "0x10",
  pid: 42,
  exe,
  title: "Untitled",
  className: "Window",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  elevated: false,
  minimized: false,
  cloaked: false,
  ...extra,
})

const evaluate = (input: Partial<Policy.Input> & { readonly target?: Policy.WindowInfo }) =>
  Policy.evaluate({ kind: "pointer", subagent: false, grants: [], config, ...input })

describe("policy", () => {
  test("ordinary apps are allowed once the session is enabled", () => {
    expect(evaluate({ target: window("notepad.exe") })).toEqual({ _tag: "Allow" })
    expect(evaluate({ target: window("chrome.exe"), kind: "text", focus: { pid: 42, isPassword: false } })).toEqual({
      _tag: "Allow",
    })
  })

  test.each(["Code.exe", "Cursor.exe", "Windsurf.exe", "devenv.exe", "idea64.exe", "Code - Insiders.exe"])(
    "IDE %s counts as a terminal (its integrated terminal runs commands)",
    (exe) => {
      expect(evaluate({ target: window(exe) })).toMatchObject({ _tag: "Deny", code: "app_denied" })
      expect(evaluate({ target: window(exe), config: { ...config, allowTerminals: true } })).toEqual({ _tag: "Allow" })
    },
  )

  test("the Run dialog and other shell dialogs are denied; other explorer windows are not", () => {
    const run = window("C:\\Windows\\explorer.exe", { className: "#32770", title: "실행" })
    expect(evaluate({ target: run })).toEqual({ _tag: "Deny", code: "app_denied", app: "explorer (shell dialog)" })
    expect(
      evaluate({ target: run, config: { ...config, allowTerminals: true, allowApps: ["explorer"] } }),
    ).toMatchObject({
      code: "app_denied",
    })
    expect(evaluate({ target: window("explorer.exe", { className: "CabinetWClass" }) })).toEqual({ _tag: "Allow" })
    // An app's own file dialog is a #32770 too, but not explorer's.
    expect(evaluate({ target: window("notepad.exe", { className: "#32770" }) })).toEqual({ _tag: "Allow" })
  })

  test.each(["StartMenuExperienceHost.exe", "SearchHost.exe", "SearchApp.exe", "SearchUI.exe"])(
    "Start and its search box (%s) get no input: typing a name and Return runs it",
    (exe) => {
      const focus = { pid: 42, isPassword: false }
      for (const kind of ["pointer", "keys", "text"] as const)
        expect(evaluate({ target: window(exe), kind, focus })).toMatchObject({ _tag: "Deny", code: "app_denied" })
      // Not a terminal: allowTerminals and an allow list do not lift it.
      const loose = { ...config, allowTerminals: true, allowApps: [exe] }
      expect(evaluate({ target: window(exe), kind: "text", focus, config: loose })).toMatchObject({ _tag: "Deny" })
    },
  )

  test("own-web is this app in any browser or app window", () => {
    // Real frame titles: an installed app window, Chrome, Edge with one and with several tabs, Firefox (em dash).
    for (const [exe, title] of [
      ["msedge.exe", "own-open-code"],
      ["chrome.exe", "own-open-code - Google Chrome"],
      ["chrome.exe", " own-open-code - Google Chrome "],
      ["chrome.exe", "own-open-code - Work - Google Chrome"],
      ["msedge.exe", "own-open-code - Microsoft Edge"],
      ["msedge.exe", "own-open-code - Personal - Microsoft Edge"],
      ["msedge.exe", "own-open-code and 1 more page - Personal - Microsoft Edge"],
      ["msedge.exe", "own-open-code and 2 more pages - Personal - Microsoft Edge"],
      ["firefox.exe", "own-open-code — Mozilla Firefox"],
      ["firefox.exe", "own-open-code — Mozilla Firefox Private Browsing"],
    ] as const) {
      const app = exe.replace(/\.exe$/, "")
      expect(evaluate({ target: window(exe, { title }) })).toEqual({
        _tag: "Deny",
        code: "app_denied",
        app: `${app} (own-open-code)`,
      })
    }
    for (const title of ["GitHub - own-open-code", "own-open-code-docs - Google Chrome", "my own-open-code notes"])
      expect(evaluate({ target: window("chrome.exe", { title }) })).toEqual({ _tag: "Allow" })
  })

  test.each([
    "cmd.exe",
    "powershell.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "pwsh.exe",
    "WindowsTerminal.exe",
    "OpenConsole.exe",
    "conhost.exe",
    "wsl.exe",
    "bash.exe",
    "mintty.exe",
  ])("terminal %s is denied unless terminals are allowed", (exe) => {
    expect(evaluate({ target: window(exe) })).toMatchObject({ _tag: "Deny", code: "app_denied" })
    expect(evaluate({ target: window(exe), config: { ...config, allowTerminals: true } })).toEqual({ _tag: "Allow" })
  })

  test.each([
    "own-desktop.exe",
    "opencode.exe",
    "own-cu-helper.exe",
    "claude.exe",
    "ChatGPT.exe",
    "codex.exe",
    "Codex.ControlCenter.exe",
    "consent.exe",
    "CredentialUIBroker.exe",
    "LogonUI.exe",
    "SecHealthUI.exe",
    "regedit.exe",
    "mmc.exe",
    "Taskmgr.exe",
    "KeePassXC.exe",
    "1Password.exe",
    "Bitwarden.exe",
  ])("%s is always denied, even when allow-listed and with terminals allowed", (exe) => {
    const permissive = { ...config, allowApps: [exe], allowTerminals: true }
    expect(evaluate({ target: window(exe), config: permissive })).toMatchObject({ _tag: "Deny", code: "app_denied" })
    expect(evaluate({ target: window(exe), config: permissive, grants: [Policy.appName(exe)] })).toMatchObject({
      _tag: "Deny",
      code: "app_denied",
    })
  })

  test("UWP frames are judged by the hosted app; the frame host itself and an unattributed frame are denied", () => {
    const frame = (exe: string) => window(exe, { className: "ApplicationFrameWindow", title: "Windows 보안" })
    // What the helper reports for a frame whose CoreWindow child it resolved.
    expect(evaluate({ target: frame("SecHealthUI.exe") })).toEqual({
      _tag: "Deny",
      code: "app_denied",
      app: "sechealthui",
    })
    const calculator = { ...config, allowApps: ["CalculatorApp"] }
    expect(evaluate({ target: frame("CalculatorApp.exe"), config: calculator })).toEqual({ _tag: "Allow" })
    expect(evaluate({ target: frame("SystemSettings.exe"), config: calculator })).toMatchObject({
      code: "app_not_allowed",
    })
    // A suspended or minimized app's frame has no CoreWindow child: no exe.
    expect(evaluate({ target: frame("") })).toEqual({ _tag: "Deny", code: "app_denied", app: "unknown app" })
    // The host never stands for every UWP app, not even when allow-listed, granted or asked about.
    const host = frame("C:\\Windows\\System32\\ApplicationFrameHost.exe")
    expect(
      evaluate({
        target: host,
        config: { ...config, allowApps: ["ApplicationFrameHost"], approval: "question" },
        grants: ["applicationframehost"],
      }),
    ).toEqual({ _tag: "Deny", code: "app_denied", app: "applicationframehost" })
  })

  test("app names match case-insensitively with or without .exe and a path", () => {
    expect(Policy.appName("C:\\Program Files\\App\\Notepad.EXE")).toBe("notepad")
    expect(Policy.appName("notepad")).toBe("notepad")
    expect(Policy.appName("/usr/bin/foo.exe")).toBe("foo")
    expect(evaluate({ target: window("NOTEPAD.EXE"), config: { ...config, denyApps: ["notepad"] } })).toMatchObject({
      _tag: "Deny",
      code: "app_denied",
      app: "notepad",
    })
    expect(evaluate({ target: window("Notepad.exe"), config: { ...config, allowApps: ["NOTEPAD"] } })).toEqual({
      _tag: "Allow",
    })
  })

  test("deny wins over allow", () => {
    expect(
      evaluate({
        target: window("chrome.exe"),
        config: { ...config, allowApps: ["chrome"], denyApps: ["chrome.exe"] },
      }),
    ).toMatchObject({ _tag: "Deny", code: "app_denied" })
    expect(evaluate({ target: window("cmd.exe"), config: { ...config, allowApps: ["cmd"] } })).toMatchObject({
      _tag: "Deny",
      code: "app_denied",
    })
  })

  test("an unknown process image is denied", () => {
    expect(evaluate({ target: window("") })).toMatchObject({ _tag: "Deny", code: "app_denied" })
  })

  test("elevated targets are refused explicitly", () => {
    expect(evaluate({ target: window("notepad.exe", { elevated: true }) })).toMatchObject({
      _tag: "Deny",
      code: "elevated_target",
      app: "notepad",
    })
  })

  test("text (and pastes, which classify as text) into a password field is refused; navigation keys and clicks are not", () => {
    const focus = { pid: 42, isPassword: true }
    expect(evaluate({ target: window("chrome.exe"), focus, kind: "text" })).toMatchObject({ code: "password_field" })
    expect(evaluate({ target: window("chrome.exe"), focus, kind: "keys" })).toEqual({ _tag: "Allow" })
    expect(evaluate({ target: window("chrome.exe"), focus, kind: "pointer" })).toEqual({ _tag: "Allow" })
    expect(evaluate({ target: window("chrome.exe"), focus: { ...focus, isPassword: false }, kind: "text" })).toEqual({
      _tag: "Allow",
    })
  })

  test("subagents are denied for every action unless allowed", () => {
    expect(evaluate({ subagent: true, kind: "observe" })).toEqual({ _tag: "Deny", code: "subagent" })
    expect(evaluate({ subagent: true, target: window("notepad.exe") })).toEqual({ _tag: "Deny", code: "subagent" })
    expect(
      evaluate({ subagent: true, target: window("notepad.exe"), config: { ...config, allowSubagents: true } }),
    ).toEqual({
      _tag: "Allow",
    })
  })

  test("question mode asks once per app; grants and the allow list skip the question", () => {
    const question = { ...config, approval: "question" as const }
    expect(evaluate({ target: window("Notepad.exe"), config: question })).toEqual({
      _tag: "NeedsApproval",
      app: "notepad",
    })
    expect(evaluate({ target: window("Notepad.exe"), config: question, grants: ["notepad"] })).toEqual({
      _tag: "Allow",
    })
    expect(evaluate({ target: window("Notepad.exe"), config: { ...question, allowApps: ["notepad.exe"] } })).toEqual({
      _tag: "Allow",
    })
    // Denials come before the question: the user is never asked about a denied app.
    expect(evaluate({ target: window("cmd.exe"), config: question })).toMatchObject({
      _tag: "Deny",
      code: "app_denied",
    })
  })

  test("a non-empty allow list is exclusive in session mode", () => {
    const listed = { ...config, allowApps: ["chrome"] }
    expect(evaluate({ target: window("chrome.exe"), config: listed })).toEqual({ _tag: "Allow" })
    expect(evaluate({ target: window("notepad.exe"), config: listed })).toEqual({
      _tag: "Deny",
      code: "app_not_allowed",
      app: "notepad",
    })
  })

  test("observing and hovering ignore the target", () => {
    expect(evaluate({ kind: "observe", target: window("cmd.exe") })).toEqual({ _tag: "Allow" })
    expect(evaluate({ kind: "move", target: window("consent.exe") })).toEqual({ _tag: "Allow" })
  })

  test("input without a target window, or text without a known focused element, is refused (fail closed)", () => {
    expect(evaluate({ kind: "pointer" })).toEqual({ _tag: "Deny", code: "no_target" })
    expect(evaluate({ kind: "keys" })).toEqual({ _tag: "Deny", code: "no_target" })
    expect(evaluate({ kind: "text" })).toEqual({ _tag: "Deny", code: "no_target" })
    // The focused element could be a password field.
    expect(evaluate({ kind: "text", target: window("notepad.exe") })).toEqual({
      _tag: "Deny",
      code: "no_target",
      app: "notepad",
    })
    expect(evaluate({ kind: "keys", target: window("notepad.exe") })).toEqual({ _tag: "Allow" })
  })

  test("kindOf classifies every action", () => {
    const kind = (name: ToolSchema.Name, input: unknown) =>
      Policy.kindOf(Result.getOrThrow(ToolSchema.decode(name, input)))
    expect(kind("screenshot", {})).toBe("observe")
    expect(kind("zoom", { region: [0, 0, 1, 1] })).toBe("observe")
    expect(kind("cursor_position", {})).toBe("observe")
    expect(kind("list_windows", {})).toBe("observe")
    expect(kind("wait", { duration: 1 })).toBe("observe")
    expect(kind("mouse_move", { coordinate: [1, 1] })).toBe("move")
    expect(kind("left_click", {})).toBe("pointer")
    expect(kind("left_click_drag", { start_coordinate: [1, 1], coordinate: [2, 2] })).toBe("pointer")
    expect(kind("left_mouse_down", {})).toBe("pointer")
    expect(kind("scroll", { scroll_direction: "up", scroll_amount: 1 })).toBe("pointer")
    expect(kind("focus_window", { windowId: "0x1" })).toBe("pointer")
    expect(kind("type", { text: "x" })).toBe("text")
    expect(kind("key", { text: "Tab Tab Return" })).toBe("keys")
    expect(kind("key", { text: "shift+Tab Escape" })).toBe("keys")
    expect(kind("key", { text: "Tab a" })).toBe("text")
    // Shortcuts can paste (ctrl+v, shift+Insert) or open a panel that does (super+v): text for the password rule.
    expect(kind("key", { text: "ctrl+c" })).toBe("text")
    expect(kind("key", { text: "ctrl+v" })).toBe("text")
    expect(kind("key", { text: "shift+Insert" })).toBe("text")
    expect(kind("key", { text: "super+v" })).toBe("text")
    expect(kind("hold_key", { text: "shift", duration: 1 })).toBe("keys")
    expect(kind("hold_key", { text: "x", duration: 1 })).toBe("text")
  })

  test("visible excludes minimized, cloaked and empty windows", () => {
    expect(Policy.visible(window("a.exe"))).toBe(true)
    expect(Policy.visible(window("a.exe", { minimized: true }))).toBe(false)
    expect(Policy.visible(window("a.exe", { cloaked: true }))).toBe(false)
    expect(Policy.visible(window("a.exe", { bounds: { x: 0, y: 0, width: 0, height: 10 } }))).toBe(false)
  })
})
