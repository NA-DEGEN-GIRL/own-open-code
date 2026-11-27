import { describe, expect, test } from "bun:test"
import CODE_MODE from "../../../codex-data/code-mode.win32.json" with { type: "json" }
import TOOLS from "../../../codex-data/tools.win32.json" with { type: "json" }
import { Platform } from "../../../src/codex/platform.js"

const exec = (tools: ReadonlyArray<{ name?: string; description?: string; parameters?: any }>) =>
  tools.find((tool) => tool.name === "exec_command")!

describe("Platform", () => {
  test("Windows keeps the capture as it is", () => {
    expect(Platform.value(TOOLS.tools, true)).toBe(TOOLS.tools)
  })

  test("elsewhere exec_command has Codex's POSIX description and yield_time_ms text", () => {
    const posix = exec(Platform.value(TOOLS.tools, false))
    expect(posix.description).toBe(
      "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
    )
    expect(posix.parameters.properties.yield_time_ms.description).toBe(
      "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
    )
    expect(exec(TOOLS.tools).description).toContain("Windows safety rules:")
    // rust-v0.171.0 (#61744): `login` names PowerShell profiles only where a PowerShell environment exists.
    expect(posix.parameters.properties.login.description).toBe("Request login-shell startup. Omit to inherit.")
    expect(exec(TOOLS.tools).parameters.properties.login.description).toStartWith("Login-shell startup. In PowerShell")
  })

  test("Code Mode's exec description loses the Windows rules and keeps its blank line before the declaration", () => {
    const captured = CODE_MODE.tools[0]!.tools[0]!.description as string
    const posix = Platform.text(captured, false)
    expect(posix).not.toContain("Windows safety rules")
    expect(posix).not.toContain("Effective range on Windows")
    expect(posix).toContain(
      "### `exec_command`\nRuns a command in a PTY, returning output or a session ID for ongoing interaction.\n\nexec tool declaration:",
    )
    expect(posix).toContain("  // Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.\n")
  })
})
