import { describe, expect, test } from "bun:test"
import os from "node:os"
import { HeadTail } from "../../../src/codex/exec/buffer.js"
import { ExecManager } from "../../../src/codex/exec/manager.js"
import { ExecOutput } from "../../../src/codex/exec/output.js"

const POLICY = { mode: "tokens", limit: 10_000 } as const
const shell = ExecManager.defaultShell()
const echo = (text: string) => (shell.type === "powershell" ? `Write-Output '${text}'` : `echo ${text}`)
const sleepThenEcho = (seconds: number, text: string) =>
  shell.type === "powershell" ? `Start-Sleep -Seconds ${seconds}; Write-Output '${text}'` : `sleep ${seconds}; echo ${text}`

/** A header value: `Name: value`, or the number ending `Process exited with code N` / `… session ID N`. */
function field(text: string, name: string) {
  const line = text.split("\n").find((entry) => entry.startsWith(name))
  return line?.slice(name.length).replace(/^:? /, "")
}

describe("HeadTail buffer", () => {
  test("keeps both ends and counts the middle", () => {
    const buffer = new HeadTail.Buffer(8)
    buffer.push(new TextEncoder().encode("abcdefghijkl"))
    expect(new TextDecoder().decode(buffer.bytes())).toBe("abcdijkl")
    expect(buffer.omittedBytes).toBe(4)
    expect(new TextDecoder().decode(buffer.bytesWithOmissionMarker())).toBe("abcd\n... 4 bytes omitted ...\nijkl")
  })
})

describe("ExecOutput", () => {
  test("header lines in Codex's order", () => {
    const text = ExecOutput.text({
      chunkID: "abc123",
      wallTimeMs: 706.5,
      raw: "hello\r\n",
      omittedBytes: 0,
      originalTokenCount: 2,
      exitCode: 0,
      policy: POLICY,
    })
    expect(text).toBe("Chunk ID: abc123\nWall time: 0.7065 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\nhello\r\n")
  })

  test("long output is truncated in the middle with Codex's warning", () => {
    const raw = "x".repeat(60_000)
    const text = ExecOutput.text({ chunkID: "", wallTimeMs: 1, raw, omittedBytes: 0, originalTokenCount: 15_000, exitCode: 0, maxOutputTokens: 100, policy: POLICY })
    expect(text).toContain("Warning: truncated output (original token count: 15000)")
    expect(text).toContain("tokens truncated")
    expect(text.length).toBeLessThan(2_000)
  })
})

describe("ExecManager", () => {
  test("a short command answers its exit code and output", async () => {
    const manager = new ExecManager.Manager()
    const text = await manager.exec("ses_a", {
      command: echo("hello codex"),
      cwd: os.tmpdir(),
      shell,
      login: false,
      tty: false,
      yieldTimeMs: 10_000,
      policy: POLICY,
    })
    expect(field(text, "Process exited with code")).toBe("0")
    expect(text).toContain("hello codex")
    expect(field(text, "Chunk ID")).toMatch(/^[0-9a-f]{6}$/)
  }, 60_000)

  test("a long command yields a session id that write_stdin polls until it exits", async () => {
    const manager = new ExecManager.Manager()
    const first = await manager.exec("ses_b", {
      command: sleepThenEcho(12, "done later"),
      cwd: os.tmpdir(),
      shell,
      login: false,
      tty: false,
      yieldTimeMs: 250,
      policy: POLICY,
    })
    const id = Number(field(first, "Process running with session ID"))
    expect(id).toBeGreaterThanOrEqual(1000)
    const second = await manager.write("ses_b", { id, chars: "", yieldTimeMs: 30_000, policy: POLICY })
    expect(second).toContain("done later")
    expect(field(second, "Process exited with code")).toBe("0")
    await expect(manager.write("ses_b", { id, chars: "", yieldTimeMs: 1, policy: POLICY })).rejects.toThrow(
      `Unknown process id ${id}`,
    )
  }, 90_000)

  test("writing to a session without tty is refused; ^C ends it", async () => {
    const manager = new ExecManager.Manager()
    const first = await manager.exec("ses_c", {
      command: sleepThenEcho(60, "never"),
      cwd: os.tmpdir(),
      shell,
      login: false,
      tty: false,
      yieldTimeMs: 250,
      policy: POLICY,
    })
    const id = Number(field(first, "Process running with session ID"))
    await expect(manager.write("ses_c", { id, chars: "y\n", yieldTimeMs: 250, policy: POLICY })).rejects.toThrow(
      "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
    )
    const stopped = await manager.write("ses_c", { id, chars: "\u0003", yieldTimeMs: 5_000, policy: POLICY })
    expect(stopped).toContain("Process exited with code")
    manager.terminate()
  }, 90_000)

  test("a signal that aborts during the first collection ends the process and forgets it", async () => {
    const manager = new ExecManager.Manager()
    const cut = new AbortController()
    const started = Date.now()
    const running = manager.execResult("ses_t", {
      command: sleepThenEcho(60, "never"),
      cwd: os.tmpdir(),
      shell,
      login: false,
      tty: false,
      yieldTimeMs: 30_000,
      policy: POLICY,
      signal: cut.signal,
    })
    await Bun.sleep(1_000)
    cut.abort()
    const result = await running
    // The collection ends with the process, long before its 30 s yield.
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(result.raw).not.toContain("never")
    if (result.sessionID !== undefined)
      await expect(
        manager.write("ses_t", { id: result.sessionID, chars: "", yieldTimeMs: 250, policy: POLICY }),
      ).rejects.toThrow("Unknown process id")
    manager.terminate()
  }, 90_000)
})
