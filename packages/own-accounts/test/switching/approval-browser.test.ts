// `session.approval.set{browserTool}` (v0.5, 03 §18.15 rule 3, 05 §8.7 plan D): the per-session switch of the
// browser tools, read-merge-write like the approval modes. Pure bundle functions, then the RPC on the fake core.
import { describe, expect, test } from "bun:test"
import { SessionApproval } from "../../src/switching/approval.js"
import { machine } from "./harness.js"
import { PROVIDERS } from "./support.js"

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const DENY = SessionApproval.BROWSER_DENY
const PATHS = ["C:/own/vault/**"]

describe("browser tool rules (pure)", () => {
  const saved = { action: "webfetch", resource: "https://example.test/*", effect: "allow" } as const

  test("off: the creation deny goes after every other rule, before the own bundle; modes still read", () => {
    const rules = SessionApproval.replace([saved, { action: "*", resource: "*", effect: "allow" }], "ask", PATHS)
    const off = SessionApproval.withBrowserTool(rules, "off", PATHS)
    expect(off.slice(0, 3)).toEqual([saved, { action: "*", resource: "*", effect: "allow" }, DENY])
    expect(off.slice(3)).toEqual([...SessionApproval.bundle("ask", PATHS)])
    expect(SessionApproval.browserToolOf(off)).toBe("off")
    expect(SessionApproval.modeOf(off, PATHS)).toBe("ask")
    // Idempotent, and a later mode change keeps it where it is.
    expect(SessionApproval.withBrowserTool(off, "off", PATHS)).toEqual(off)
    const full = SessionApproval.replace(off, "full", PATHS)
    expect(SessionApproval.browserToolOf(full)).toBe("off")
    expect(SessionApproval.modeOf(full, PATHS)).toBe("full")
  })

  test("on: removes exactly the creation deny; someone else's deny keeps the tools off", () => {
    const created = [DENY, ...SessionApproval.bundle("ask", PATHS)]
    const on = SessionApproval.withBrowserTool(created, "on", PATHS)
    expect(on).toEqual([...SessionApproval.bundle("ask", PATHS)])
    expect(SessionApproval.browserToolOf(on)).toBe("on")
    const other = { action: "brow*", resource: "*", effect: "deny" } as const
    const kept = SessionApproval.withBrowserTool([DENY, other], "on", PATHS)
    expect(kept).toEqual([other])
    expect(SessionApproval.browserToolOf(kept)).toBe("off")
  })

  test("the browser plugin's attachment allow after the own bundle keeps the mode readable", () => {
    // Upstream 82bb5ff88a: every attach appends `{browser, *, allow}` at the very end, after the own bundle.
    const ATTACH = SessionApproval.BROWSER_ATTACH_ALLOW
    for (const mode of ["read-only", "ask", "full"] as const) {
      const attached = [...SessionApproval.bundle(mode, PATHS), ATTACH]
      expect(SessionApproval.modeOf(attached, PATHS)).toBe(mode)
      // Re-registers (reload, service restart, wake) append it again.
      expect(SessionApproval.modeOf([...attached, ATTACH], PATHS)).toBe(mode)
      // A mode write moves it before the new bundle; the next attach appends another one.
      const rewritten = SessionApproval.replace(attached, "full", PATHS)
      expect(rewritten).toEqual([ATTACH, ...SessionApproval.bundle("full", PATHS)])
      expect(SessionApproval.modeOf([...rewritten, ATTACH], PATHS)).toBe("full")
    }
    // Alone it reads like no rules at all (core's default).
    expect(SessionApproval.modeOf([ATTACH], PATHS)).toBe(SessionApproval.modeOf([], PATHS))
    // Something else after the bundle still makes it custom.
    const other = { action: "webfetch", resource: "**", effect: "allow" } as const
    expect(SessionApproval.modeOf([...SessionApproval.bundle("ask", PATHS), ATTACH, other], PATHS)).toBe("custom")
  })

  test("own.harness's tool gate after the bundle keeps the mode readable; a later rule for a bundle action does not", () => {
    // A harness switch appends `{own_harness_codex, *, allow}` at the end (own-harness gate.ts `rules`).
    const gate = { action: "own_harness_codex", resource: "*", effect: "allow" } as const
    for (const mode of ["read-only", "ask", "full"] as const)
      expect(SessionApproval.modeOf([...SessionApproval.bundle(mode, PATHS), gate], PATHS)).toBe(mode)
    const shell = { action: "shell", resource: "git status*", effect: "allow" } as const
    expect(SessionApproval.modeOf([...SessionApproval.bundle("ask", PATHS), gate, shell], PATHS)).toBe("custom")
    const wildcard = { action: "*", resource: "*", effect: "allow" } as const
    expect(SessionApproval.modeOf([...SessionApproval.bundle("ask", PATHS), wildcard], PATHS)).toBe("custom")
  })

  test("off while attached: the creation deny lands before the bundle and the attachment allows are dropped", () => {
    const ATTACH = SessionApproval.BROWSER_ATTACH_ALLOW
    const saved = { action: "webfetch", resource: "https://example.test/*", effect: "allow" } as const
    const attached = [saved, ...SessionApproval.bundle("ask", PATHS), ATTACH, ATTACH]
    const off = SessionApproval.withBrowserTool(attached, "off", PATHS)
    expect(off).toEqual([saved, DENY, ...SessionApproval.bundle("ask", PATHS)])
    expect(SessionApproval.browserToolOf(off)).toBe("off")
    expect(SessionApproval.modeOf(off, PATHS)).toBe("ask")
    // `on` removes only the creation deny; the next attachment brings its own allow.
    const on = SessionApproval.withBrowserTool(off, "on", PATHS)
    expect(on).toEqual([saved, ...SessionApproval.bundle("ask", PATHS)])
    expect(SessionApproval.modeOf([...on, ATTACH], PATHS)).toBe("ask")
    // `on` while attached keeps the attachment's allow.
    expect(SessionApproval.withBrowserTool(attached, "on", PATHS)).toEqual(attached)
  })

  test("state follows core: the last rule whose action matches `browser` decides", () => {
    expect(SessionApproval.browserToolOf([])).toBe("on")
    expect(SessionApproval.browserToolOf([DENY, { action: "browser", resource: "*", effect: "allow" }])).toBe("on")
    expect(SessionApproval.browserToolOf([{ action: "*", resource: "*", effect: "deny" }])).toBe("off")
    // A resource-scoped deny keeps the tools listed.
    expect(SessionApproval.browserToolOf([{ action: "browser", resource: "https://*", effect: "deny" }])).toBe("on")
  })
})

describe("session.approval.set{browserTool} (RPC)", () => {
  const PARENT = "ses_parent"
  const CHILD = "ses_child"

  test("on removes the creation deny of the session and its unfinished children; get reports it", async () => {
    await using m = await machine({
      models: { [PARENT]: A, [CHILD]: A },
      sessions: { [PARENT]: { permissions: [DENY] }, [CHILD]: { parentID: PARENT, permissions: [DENY] } },
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
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({ browserTool: "off" })

    const on = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask", browserTool: "on" })
    expect(on).toEqual({ mode: "ask", patched: [PARENT, CHILD], browserTool: "on" })
    for (const id of [PARENT, CHILD]) {
      const rules = m.facts.get(id)?.permissions ?? []
      expect(rules).not.toContainEqual(DENY)
    }
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({ mode: "ask", browserTool: "on" })

    const off = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask", browserTool: "off" })
    expect(off).toMatchObject({ browserTool: "off" })
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({
      mode: "ask",
      browserTool: "off",
    })
  })

  test("a desktop attachment's allow after the bundle: get reads the mode, computer use can be switched", async () => {
    await using m = await machine({ models: { [PARENT]: A }, sessions: { [PARENT]: { permissions: [] } } })
    await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask" })
    // plugin-browser's attachment grant appends its allow after the own bundle (upstream 82bb5ff88a).
    const ATTACH = SessionApproval.BROWSER_ATTACH_ALLOW
    m.facts.set(PARENT, { permissions: [...(m.facts.get(PARENT)?.permissions ?? []), ATTACH] })
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({
      mode: "ask",
      browserTool: "on",
      computerUse: "off",
    })
    const on = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask", computerUse: "on" })
    expect(on).toEqual({ mode: "ask", patched: [PARENT], computerUse: "on" })
    expect(m.facts.get(PARENT)?.permissions).toContainEqual(ATTACH)
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({
      mode: "ask",
      browserTool: "on",
      computerUse: "on",
    })
  })

  test("without browserTool the creation deny is left alone and the result has no browserTool", async () => {
    await using m = await machine({ models: { [PARENT]: A }, sessions: { [PARENT]: { permissions: [DENY] } } })
    const set = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "full" })
    expect(set).toEqual({ mode: "full", patched: [PARENT] })
    expect(m.facts.get(PARENT)?.permissions?.[0]).toEqual(DENY)
  })
})
