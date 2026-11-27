// `session.approval.set{computerUse}` (own.computer-use, 01 §10.2): the per-session consent rule of the computer-use
// tools, read-merge-write like the browser switch. Pure bundle functions, then the RPC on the fake core.
import { describe, expect, test } from "bun:test"
import { SessionApproval } from "../../src/switching/approval.js"
import { machine } from "./harness.js"
import { PROVIDERS } from "./support.js"

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const ALLOW = SessionApproval.COMPUTER_ALLOW
const PATHS = ["C:/own/vault/**"]

describe("computer use rules (pure)", () => {
  const saved = { action: "webfetch", resource: "https://example.test/*", effect: "allow" } as const

  test("on: the allow goes after every other rule, before the own bundle; the mode still reads", () => {
    const rules = SessionApproval.replace([saved], "ask", PATHS)
    const on = SessionApproval.withComputerUse(rules, "on", PATHS)
    expect(on).toEqual([saved, ALLOW, ...SessionApproval.bundle("ask", PATHS)])
    expect(SessionApproval.computerUseOf(on)).toBe("on")
    expect(SessionApproval.modeOf(on, PATHS)).toBe("ask")
    // Idempotent, survives a mode change, and composes with the browser switch.
    expect(SessionApproval.withComputerUse(on, "on", PATHS)).toEqual(on)
    const full = SessionApproval.replace(on, "full", PATHS)
    expect(SessionApproval.computerUseOf(full)).toBe("on")
    expect(SessionApproval.modeOf(full, PATHS)).toBe("full")
    const both = SessionApproval.withBrowserTool(full, "off", PATHS)
    expect(SessionApproval.computerUseOf(both)).toBe("on")
    expect(SessionApproval.browserToolOf(both)).toBe("off")
    expect(SessionApproval.modeOf(both, PATHS)).toBe("full")
  })

  test("on moves an earlier allow behind a later rule that matches computer; off removes only the allow", () => {
    const deny = { action: "comp*", resource: "*", effect: "deny" } as const
    const on = SessionApproval.withComputerUse([ALLOW, deny], "on", PATHS)
    expect(on).toEqual([deny, ALLOW])
    expect(SessionApproval.computerUseOf(on)).toBe("on")
    const off = SessionApproval.withComputerUse(on, "off", PATHS)
    expect(off).toEqual([deny])
    expect(SessionApproval.computerUseOf(off)).toBe("off")
    expect(
      SessionApproval.modeOf(
        SessionApproval.withComputerUse(SessionApproval.bundle("ask", PATHS), "off", PATHS),
        PATHS,
      ),
    ).toBe("ask")
  })

  test("on while a desktop is attached: the allow goes before the bundle and the attachment allow", () => {
    // Upstream 82bb5ff88a: the browser plugin appends `{browser, *, allow}` after the own bundle while attached.
    const ATTACH = SessionApproval.BROWSER_ATTACH_ALLOW
    const attached = [saved, ...SessionApproval.bundle("ask", PATHS), ATTACH]
    const on = SessionApproval.withComputerUse(attached, "on", PATHS)
    expect(on).toEqual([saved, ALLOW, ...SessionApproval.bundle("ask", PATHS), ATTACH])
    expect(SessionApproval.computerUseOf(on)).toBe("on")
    expect(SessionApproval.modeOf(on, PATHS)).toBe("ask")
    // Detaching (the plugin removes its allow) leaves the mode and the consent as they were.
    const detached = on.filter((rule) => rule !== on.at(-1))
    expect(SessionApproval.modeOf(detached, PATHS)).toBe("ask")
    expect(SessionApproval.computerUseOf(detached)).toBe("on")
    const off = SessionApproval.withComputerUse(on, "off", PATHS)
    expect(off).toEqual(attached)
  })

  test("state: only an exact allow as the last matching rule is on", () => {
    expect(SessionApproval.computerUseOf([])).toBe("off")
    expect(SessionApproval.computerUseOf([{ action: "*", resource: "*", effect: "allow" }])).toBe("off")
    expect(SessionApproval.computerUseOf([ALLOW, { action: "*", resource: "*", effect: "allow" }])).toBe("off")
    expect(SessionApproval.computerUseOf([ALLOW, { action: "edit", resource: "**", effect: "deny" }])).toBe("on")
    expect(SessionApproval.computerUseOf([{ action: "computer", resource: "notepad", effect: "allow" }])).toBe("off")
  })
})

describe("session.approval.set{computerUse} (RPC)", () => {
  const PARENT = "ses_parent"
  const CHILD = "ses_child"
  const LATER = "ses_later"
  type Machine = Awaited<ReturnType<typeof machine>>

  /**
   * A parent and its open child, with own.computer-use's `status` behind `ctx.rpc` (the switching harness has no RPC
   * client): `allowSubagents` as given, or a failed call as when the plugin is not loaded (`"absent"`).
   */
  async function started(allowSubagents: boolean | "absent", child: ReadonlyArray<typeof ALLOW> = []) {
    const m = await machine({
      models: { [PARENT]: A, [CHILD]: A, [LATER]: A },
      sessions: { [PARENT]: { permissions: [] }, [CHILD]: { parentID: PARENT, permissions: child } },
    })
    const calls = { status: 0 }
    const policy = { allowApps: [], denyApps: [], allowTerminals: false, allowSubagents: allowSubagents === true }
    Object.assign(m.deps.ctx, {
      rpc: () => ({
        status: async () => {
          calls.status++
          if (allowSubagents === "absent") throw new Error("Unknown RPC: own.computer")
          return { available: true, buildId: "test", version: "0.0.0", policy }
        },
      }),
    })
    await created(m, CHILD)
    return Object.assign(m, { status: calls })
  }

  async function created(m: Machine, sessionID: string) {
    await m.send("session.created", {
      sessionID,
      parentID: PARENT,
      model: A,
      projectID: "p",
      slug: "s",
      version: "2",
      location: {},
    })
    await m.flush()
  }

  for (const allowSubagents of [false, "absent"] as const)
    test(`on without allowSubagents (${allowSubagents}) writes the allow to the root only`, async () => {
      // The open child inherited an allow at creation; its session.created already removed it.
      await using m = await started(allowSubagents, [ALLOW])
      expect(m.facts.get(CHILD)?.permissions).toEqual([])
      expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({ computerUse: "off" })

      // One written meanwhile is taken away by `on` as well.
      m.facts.set(CHILD, { parentID: PARENT, permissions: [ALLOW] })
      const on = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask", computerUse: "on" })
      expect(on).toEqual({ mode: "ask", patched: [PARENT, CHILD], computerUse: "on" })
      expect(m.facts.get(PARENT)?.permissions).toContainEqual(ALLOW)
      expect(m.facts.get(CHILD)?.permissions).not.toContainEqual(ALLOW)
      expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({
        mode: "ask",
        computerUse: "on",
      })
      expect(await m.rpc("session.approval.get", { sessionID: CHILD })).toMatchObject({
        mode: "ask",
        computerUse: "off",
      })

      // Core gives a child created afterwards its parent's session rules (core session.ts:276); its session.created
      // removes exactly the computer allow and keeps the rest in order.
      const inherited = m.facts.get(PARENT)?.permissions ?? []
      m.facts.set(LATER, { parentID: PARENT, permissions: inherited })
      await created(m, LATER)
      expect(m.facts.get(LATER)?.permissions).toEqual(inherited.filter((rule) => !same(rule, ALLOW)))
      expect(m.facts.get(PARENT)?.permissions).toEqual(inherited)
    })

  test("on with allowSubagents writes the root and its open children; later children keep the allow", async () => {
    await using m = await started(true)
    const on = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask", computerUse: "on" })
    expect(on).toEqual({ mode: "ask", patched: [PARENT, CHILD], computerUse: "on" })
    for (const id of [PARENT, CHILD]) expect(m.facts.get(id)?.permissions).toContainEqual(ALLOW)

    const inherited = m.facts.get(PARENT)?.permissions ?? []
    m.facts.set(LATER, { parentID: PARENT, permissions: inherited })
    await created(m, LATER)
    expect(m.facts.get(LATER)?.permissions).toEqual(inherited)
    // Once for `on` (it has an open child), once for the later child that inherited the allow.
    expect(m.status.status).toBe(2)
  })

  test("off removes it from the session and every open child without asking own.computer", async () => {
    await using m = await started(true, [ALLOW])
    expect(m.facts.get(CHILD)?.permissions).toEqual([ALLOW])
    m.facts.set(PARENT, { permissions: [ALLOW] })
    const off = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "ask", computerUse: "off" })
    expect(off).toEqual({ mode: "ask", patched: [PARENT, CHILD], computerUse: "off" })
    for (const id of [PARENT, CHILD]) expect(m.facts.get(id)?.permissions).not.toContainEqual(ALLOW)
    expect(await m.rpc("session.approval.get", { sessionID: PARENT })).toMatchObject({
      mode: "ask",
      computerUse: "off",
    })
    // Only the child's session.created asked (it inherited the allow).
    expect(m.status.status).toBe(1)
  })

  test("without computerUse (own.team's mode writes) an existing allow is kept everywhere", async () => {
    await using m = await started(false)
    m.facts.set(PARENT, { permissions: [ALLOW] })
    m.facts.set(CHILD, { parentID: PARENT, permissions: [ALLOW] })
    const set = await m.rpc("session.approval.set", { sessionID: PARENT, mode: "full" })
    expect(set).toEqual({ mode: "full", patched: [PARENT, CHILD] })
    for (const id of [PARENT, CHILD]) expect(m.facts.get(id)?.permissions?.[0]).toEqual(ALLOW)
    expect(m.status.status).toBe(0)
  })
})

function same(
  a: { readonly action: string; readonly resource: string; readonly effect: string },
  b: { readonly action: string; readonly resource: string; readonly effect: string },
) {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}
