import { describe, expect, test } from "bun:test"
import type { ConfigEntry } from "@opencode/client"
import {
  cacheEffect,
  configuredShell,
  projectOverride,
  selectedOption,
  shellKind,
  shellName,
  windowsServer,
  type ShellOption,
} from "./model"
import { shellText } from "./strings"

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const GITBASH = "C:\\Program Files\\Git\\bin\\bash.exe"
const CMD = "C:\\Windows\\system32\\cmd.exe"
const windows: ShellOption[] = [PWSH, POWERSHELL, GITBASH, CMD].map((path) => ({
  path,
  name: shellName(path),
  acceptable: true,
}))

const document = (shell: string | undefined, path?: string): ConfigEntry => ({
  type: "document",
  path,
  info: shell === undefined ? {} : { shell },
})

describe("shell names (same as core ShellSelect.name, used in the tool description)", () => {
  test("file name without extension on Windows, base name elsewhere, lower case", () => {
    expect(shellName(PWSH)).toBe("pwsh")
    expect(shellName(CMD)).toBe("cmd")
    expect(shellName(GITBASH)).toBe("bash")
    expect(shellName("C:/Tools/PWSH.EXE")).toBe("pwsh")
    expect(shellName("/usr/bin/bash")).toBe("bash")
    expect(shellName("/opt/homebrew/bin/fish")).toBe("fish")
  })

  test("kinds label Windows shells; Git Bash is bash under a Git folder", () => {
    expect(windows.map(shellKind)).toEqual(["pwsh", "powershell", "gitbash", "cmd"])
    expect(shellKind({ path: "/bin/bash" })).toBe("bash")
    expect(shellKind({ path: "/bin/zsh" })).toBe("other")
    expect(windowsServer(windows)).toBe(true)
    expect(windowsServer([{ path: "/bin/zsh" }])).toBe(false)
  })
})

describe("current value", () => {
  test("the highest-priority document that sets shell wins; directories and unset documents are skipped", () => {
    const entries: ConfigEntry[] = [
      document(PWSH, "C:\\Users\\me\\.config\\opencode\\opencode.jsonc"),
      { type: "directory", path: "C:\\Users\\me\\.config\\opencode" },
      document(undefined, "D:\\work\\app\\opencode.json"),
      document("cmd", "D:\\work\\app\\.opencode\\opencode.jsonc"),
    ]
    expect(configuredShell(entries)).toEqual({ value: "cmd", source: "D:\\work\\app\\.opencode\\opencode.jsonc" })
    expect(configuredShell([document(undefined)])).toBeUndefined()
  })

  test("a path matches its listed shell (case and slashes on Windows); a bare name resolves by name", () => {
    expect(selectedOption(windows, { value: "c:/program files/powershell/7/PWSH.exe" })?.path).toBe(PWSH)
    expect(selectedOption(windows, { value: "cmd" })?.path).toBe(CMD)
    expect(selectedOption(windows, { value: "D:\\other\\pwsh.exe" })).toBeUndefined()
    expect(selectedOption(windows, undefined)).toBeUndefined()
  })

  test("a project config outranks the global value", () => {
    const project = { value: "cmd", source: "D:\\work\\app\\.opencode\\opencode.jsonc" }
    expect(projectOverride(project, "D:\\work\\app")).toBe(true)
    expect(projectOverride(project, "d:/work/app/")).toBe(true)
    expect(projectOverride(project, "D:\\work\\application")).toBe(false)
    expect(
      projectOverride({ value: "cmd", source: "C:\\Users\\me\\.config\\opencode\\opencode.jsonc" }, "D:\\work\\app"),
    ).toBe(false)
    expect(projectOverride({ value: "/bin/zsh", source: "/home/me/app/.opencode/opencode.json" }, "/home/me/app")).toBe(
      true,
    )
  })
})

describe("cache effect (03 §19.8, open question 39)", () => {
  test("changes when the name in “using <name>” changes, same when it stays, unknown when the server picks", () => {
    const [pwsh, , bash, cmd] = windows
    expect(cacheEffect(pwsh, cmd)).toBe("changes")
    expect(cacheEffect(bash, { path: "D:\\msys64\\usr\\bin\\bash.exe", acceptable: true })).toBe("same")
    expect(cacheEffect(undefined, cmd)).toBe("unknown")
    expect(cacheEffect(pwsh, undefined)).toBe("unknown")
    expect(cacheEffect(pwsh, { path: "/usr/bin/fish", acceptable: false })).toBe("unknown")
  })

  test("the confirmation keeps 03's sentence and names the change", () => {
    expect(shellText("ko", "own.shellcfg.confirm.cache")).toBe(
      "셸 도구 설명이 바뀌어 다음 요청에서 캐시를 새로 쓸 수 있어요.",
    )
    expect(shellText("ko", "own.shellcfg.confirm.cacheChanges", { from: "pwsh", to: "cmd" })).toContain(
      "“using pwsh”가 “using cmd”로 바뀌어요",
    )
    expect(shellText("ko", "own.shellcfg.confirmTitle", { name: "Git Bash" })).toBe("Git Bash로 바꿀까요?")
    expect(shellText("en", "own.shellcfg.applied", { name: "cmd" })).toBe("Done. The next request uses cmd.")
  })
})
