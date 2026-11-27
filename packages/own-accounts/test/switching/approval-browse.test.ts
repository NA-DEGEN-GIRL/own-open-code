// `session.approval.set{browse}` (내 브라우저 사용, BRW): the per-conversation rule `{browse_*, *, allow}` that lists the
// `browse_*` tools again over the agent-wide deny, read-merge-write like computer use. Pure bundle functions, then the
// RPC on the fake core.
import { describe, expect, test } from "bun:test"
import { OwnBrowse } from "@own/protocol"
import { SessionApproval } from "../../src/switching/approval.js"
import { machine } from "./harness.js"
import { PROVIDERS } from "./support.js"

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const ALLOW = SessionApproval.BROWSE_ALLOW
const PATHS = ["C:/own/vault/**"]

describe("내 브라우저 사용 rules (pure)", () => {
  const saved = { action: "webfetch", resource: "https://example.test/*", effect: "allow" } as const

  test("on: the allow goes before the own bundle; the mode still reads; off removes only it", () => {
    expect(ALLOW).toEqual(OwnBrowse.ALLOW)
    const rules = SessionApproval.replace([saved], "ask", PATHS)
    const on = SessionApproval.withBrowse(rules, "on", PATHS)
    expect(on).toEqual([saved, ALLOW, ...SessionApproval.bundle("ask", PATHS)])
    expect(SessionApproval.browseOf(on)).toBe("on")
    expect(SessionApproval.modeOf(on, PATHS)).toBe("ask")
    expect(SessionApproval.withBrowse(on, "on", PATHS)).toEqual(on)
    // A mode change keeps it, and it composes with computer use and the browser pane switch.
    const full = SessionApproval.replace(on, "full", PATHS)
    expect(SessionApproval.browseOf(full)).toBe("on")
    expect(SessionApproval.modeOf(full, PATHS)).toBe("full")
    const both = SessionApproval.withBrowserTool(SessionApproval.withComputerUse(full, "on", PATHS), "off", PATHS)
    expect(SessionApproval.browseOf(both)).toBe("on")
    expect(SessionApproval.computerUseOf(both)).toBe("on")
    expect(SessionApproval.modeOf(both, PATHS)).toBe("full")
    const off = SessionApproval.withBrowse(both, "off", PATHS)
    expect(SessionApproval.browseOf(off)).toBe("off")
    expect(off).not.toContainEqual(ALLOW)
    expect(SessionApproval.modeOf(off, PATHS)).toBe("full")
    // The mode reads with an empty protected list too (the evaluate hook reads it so).
    expect(SessionApproval.modeOf(on, [])).toBe("ask")
  })

  test("state: only the exact allow as the last `browse_*` rule is on; single tools' rules are someone else's", () => {
    expect(SessionApproval.browseOf([])).toBe("off")
    expect(SessionApproval.browseOf([OwnBrowse.DENY])).toBe("off")
    expect(SessionApproval.browseOf([OwnBrowse.DENY, ALLOW])).toBe("on")
    expect(SessionApproval.browseOf([ALLOW, OwnBrowse.DENY])).toBe("off")
    expect(SessionApproval.browseOf([{ action: "*", resource: "*", effect: "allow" }])).toBe("off")
    const single = { action: "browse_eval", resource: "*", effect: "deny" } as const
    expect(SessionApproval.browseOf([ALLOW, single])).toBe("on")
    expect(SessionApproval.withBrowse([single, ALLOW], "off", PATHS)).toEqual([single])
  })
})

describe("session.approval.set{browse} (RPC)", () => {
  const PARENT = "ses_parent"
  const CHILD = "ses_child"

  test("on and off write the parent and its open child; get reads it", async () => {
    await using m = await machine({
      models: { [PARENT]: A, [CHILD]: A },
      sessions: { [PARENT]: { permissions: [] }, [CHILD]: { parentID: PARENT, permissions: [] } },
    })
    await m.send("session.created", {
      sessionID: CHILD,
      parentID: PARENT,
      model: A,
      projectID: "p",
      slug: "s",
      version: "2",
      location: {},
    })
    await m.flush()
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({ browse: "off" })
    const on = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask", browse: "on" })
    expect(on).toEqual({ mode: "ask", patched: [PARENT, CHILD], browse: "on" })
    for (const sessionID of [PARENT, CHILD]) {
      expect(m.facts.get(sessionID)?.permissions).toContainEqual(ALLOW)
      expect(await m.rpc("session.approval.get", { sessionID })).toMatchObject({ mode: "ask", browse: "on" })
    }
    // A mode change without `browse` keeps it.
    expect(await m.rpc("session.approval.set", { sessionID: PARENT, mode: "full" })).toEqual({
      mode: "full",
      patched: [PARENT, CHILD],
    })
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({ mode: "full", browse: "on" })
    const off = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "full", browse: "off" })
    expect(off).toEqual({ mode: "full", patched: [PARENT, CHILD], browse: "off" })
    expect(m.facts.get(CHILD)?.permissions).not.toContainEqual(ALLOW)
  })
})
