// OWN-PATCH(P-019) begin
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ShellParse } from "@opencode/core/shell/parse"

const POWERSHELL = "C:/Program Files/PowerShell/7/pwsh.exe"
const asked = (command: string, shell: string) =>
  Effect.runPromise(ShellParse.approval(command, shell, "/workspace")).then((result) => result.commands)
const whole = (command: string) => ({ resource: command, save: command })

describe("ShellParse.approval", () => {
  test("a statement with no command in it is asked as a whole", async () => {
    const cases: Array<[string, string]> = [
      ["$x = 'hi'", POWERSHELL],
      ["${env:PATH} = 'C:/elsewhere'", POWERSHELL],
      ["'hi'", POWERSHELL],
      ["Set-Location src; $x = 1", POWERSHELL],
      ["X=1", "/bin/bash"],
      ["export X=1", "/bin/bash"],
      ["cd src; X=1", "/bin/bash"],
    ]
    for (const [command, shell] of cases) expect(await asked(`  ${command} `, shell)).toEqual([whole(command)])
  })

  // Upstream's scanner (v2.2.2) asks redirections, method calls and lone-CR statements itself.
  test("the scanner's commands are asked as they are", async () => {
    expect(await asked("[IO.File]::WriteAllText('x.txt', 'hi')", POWERSHELL)).toEqual([
      { resource: "[IO.File]::WriteAllText('x.txt', 'hi')", save: "[IO.File]::WriteAllText(*" },
    ])
    expect(await asked("cd src; > x.txt", "/bin/bash")).toEqual([{ resource: "> x.txt", save: "> *" }])
    expect(await asked("git status -s\rgit push", POWERSHELL)).toEqual([
      { resource: "git status -s", save: "git status *" },
      { resource: "git push", save: "git push *" },
    ])
    expect(await asked("git status && cat a", "/bin/bash")).toEqual([
      { resource: "git status", save: "git status *" },
      { resource: "cat a", save: "cat *" },
    ])
  })

  test("plain directory changes ask nothing", async () => {
    expect(await asked("cd src", "/bin/bash")).toEqual([])
    expect(await asked("Set-Location 'my dir'; cd ..", POWERSHELL)).toEqual([])
    expect(await asked("Set-Location src\r\ncd ..", POWERSHELL)).toEqual([])
    expect(await asked("  ", "/bin/bash")).toEqual([])
  })

  test("a bash command with a lone CR is refused, not run", async () => {
    const result = await Effect.runPromise(Effect.result(ShellParse.approval("cd .\rrm x", "/bin/bash", "/workspace")))
    expect(result._tag).toBe("Failure")
  })
})
// OWN-PATCH(P-019) end
