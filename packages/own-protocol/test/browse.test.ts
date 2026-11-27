// 내 브라우저 사용 (BRW): the tool kinds the approval modes decide by, the permission names core gives Browse's tools,
// the setting's patch, and the scope of turning it on for a conversation.
import { describe, expect, test } from "bun:test"
import { OwnBrowse } from "../src/browse.js"
import { OwnRouting } from "../src/rpc-routing.js"

describe("OwnBrowse", () => {
  test("reads look; everything else, and any tool not listed, acts", () => {
    for (const tool of ["status", "snapshot", "screenshot", "screenshot_diff", "console", "network", "wait_for"])
      expect(OwnBrowse.kind(tool, {})).toBe("read")
    for (const tool of ["navigate", "click", "fill", "type", "press", "select", "hover", "drag", "scroll", "eval"])
      expect(OwnBrowse.kind(tool, {})).toBe("act")
    for (const tool of ["dialog", "upload", "emulate", "webmcp", "recording", "handoff", "demonstrate", "settings"])
      expect(OwnBrowse.kind(tool, {})).toBe("act")
    expect(OwnBrowse.kind("a_tool_from_a_newer_browse", {})).toBe("act")
  })

  test("tabs lists unless it opens or closes", () => {
    expect(OwnBrowse.kind("tabs", undefined)).toBe("read")
    expect(OwnBrowse.kind("tabs", {})).toBe("read")
    expect(OwnBrowse.kind("tabs", { action: "list" })).toBe("read")
    expect(OwnBrowse.kind("tabs", { action: "new", id: "work-mail" })).toBe("act")
    expect(OwnBrowse.kind("tabs", { action: "close", group: "task" })).toBe("act")
    expect(OwnBrowse.kind("tabs", "list")).toBe("read")
  })

  test("core's names: `browse_<tool>`, the rules match all of them", () => {
    expect(OwnBrowse.toolOf("browse_click")).toBe("click")
    expect(OwnBrowse.toolOf("browse_screenshot_diff")).toBe("screenshot_diff")
    expect(OwnBrowse.toolOf("browse_")).toBeUndefined()
    expect(OwnBrowse.toolOf("browser")).toBeUndefined()
    expect(OwnBrowse.toolOf("webfetch")).toBeUndefined()
    expect(OwnBrowse.DENY).toEqual({ action: "browse_*", resource: "*", effect: "deny" })
    expect(OwnBrowse.ALLOW).toEqual({ action: "browse_*", resource: "*", effect: "allow" })
  })

  test("apply: given fields replace, an empty command forgets, off by default", () => {
    expect(OwnBrowse.enabled(undefined)).toBe(false)
    expect(OwnBrowse.enabled({})).toBe(false)
    expect(OwnBrowse.apply({}, { enabled: true })).toEqual({ version: 1, enabled: true })
    expect(OwnBrowse.apply({ enabled: true }, { command: " C:/b/browse.exe " })).toEqual({
      version: 1,
      enabled: true,
      command: "C:/b/browse.exe",
    })
    expect(OwnBrowse.apply({ enabled: true, command: "C:/b/browse.exe" }, { command: "" })).toEqual({
      version: 1,
      enabled: true,
    })
    expect(OwnBrowse.apply({ enabled: true, command: "C:/b/browse.exe" }, { enabled: false })).toEqual({
      version: 1,
      enabled: false,
      command: "C:/b/browse.exe",
    })
  })

  test("scopes: turning it on for a conversation and the setting need a PC window; off and the status do not", () => {
    expect(OwnRouting.MethodScope["browse.status"]).toBe("read")
    expect(OwnRouting.MethodScope["browse.set"]).toBe("local")
    expect(OwnRouting.scopeOf("session.approval.set", { sessionID: "s", mode: "ask", browse: "on" })).toBe("local")
    expect(OwnRouting.scopeOf("session.approval.set", { sessionID: "s", mode: "ask", browse: "off" })).toBe("admin")
    expect(OwnRouting.scopeOf("session.approval.set", { sessionID: "s", mode: "ask" })).toBe("prompt")
    expect(OwnRouting.MethodLocation["browse.status"]).toBe("control")
    expect(OwnRouting.MethodLocation["browse.set"]).toBe("control")
  })
})
