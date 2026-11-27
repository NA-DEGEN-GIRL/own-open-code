import { describe, expect, test } from "bun:test"
import { debuggingPort } from "../src/main/debug-port"

describe("a packaged test run's debugging port (own-shell.ts)", () => {
  test("takes the last port number a run passed", () => {
    expect(debuggingPort(["own-desktop.exe", "--remote-debugging-port=9333"])).toBe("9333")
    expect(debuggingPort(["x", "--remote-debugging-port=1", "--remote-debugging-port=0042"])).toBe("42")
  })

  test("takes nothing else", () => {
    expect(debuggingPort(["own-desktop.exe"])).toBeUndefined()
    expect(debuggingPort(["x", "--remote-debugging-port=abc"])).toBeUndefined()
    expect(debuggingPort(["x", "--remote-debugging-port=70000"])).toBeUndefined()
    expect(debuggingPort(["x", "--remote-debugging-port="])).toBeUndefined()
    expect(debuggingPort(["x", "--remote-debugging-pipe"])).toBeUndefined()
  })
})
