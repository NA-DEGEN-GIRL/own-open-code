// `read-only` and `ask` approval ask before `webfetch`, which Code Mode's `fetch` asks too (decisions MR10-3), and before
// `websearch` (MR11): a URL or a search query can send data out after a prompt injection; `full` still reaches the web
// unasked. A conversation written with the bundles before either change still reads its mode, is never rewritten on a
// read, and its web requests ask through own-accounts' `evaluate` hook. Pure bundle functions, then the RPC and the
// hook on the fake core. The cards on a real server: test/switching/approval-webfetch.e2e.test.ts.
import { describe, expect, test } from "bun:test"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { Agent } from "@opencode/schema/agent"
import { SessionID } from "@opencode/schema/session-id"
import { SessionApproval } from "../../src/switching/approval.js"
import { machine } from "./harness.js"
import { PROVIDERS } from "./support.js"

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const PATHS = ["C:/own/vault/**"]
const WEB_ASK = { action: "webfetch", resource: "**", effect: "ask" } as const
const WEB_ALLOW = { action: "webfetch", resource: "**", effect: "allow" } as const
const SEARCH_ASK = { action: "websearch", resource: "**", effect: "ask" } as const
const SEARCH_ALLOW = { action: "websearch", resource: "**", effect: "allow" } as const
/** A bundle as own-accounts wrote it before MR10-3: the mode's rules without web rules, then the protected denies. */
const legacy = (mode: "read-only" | "ask", paths: ReadonlyArray<string> = PATHS) =>
  SessionApproval.bundle(mode, paths).filter((rule) => rule.action !== "webfetch" && rule.action !== "websearch")
/** A bundle as own-accounts wrote it from MR10-3 until MR11: the mode's rules without `websearch`. */
const beforeSearch = (mode: "read-only" | "ask" | "full", paths: ReadonlyArray<string> = PATHS) =>
  SessionApproval.bundle(mode, paths).filter((rule) => rule.action !== "websearch")

describe("web requests in the approval bundles (pure)", () => {
  test("read-only and ask ask before webfetch and websearch, full allows them; each still reads as its mode", () => {
    for (const mode of ["read-only", "ask"] as const) {
      expect(SessionApproval.bundle(mode, PATHS)).toContainEqual(WEB_ASK)
      expect(SessionApproval.bundle(mode, PATHS)).toContainEqual(SEARCH_ASK)
    }
    expect(SessionApproval.bundle("full", PATHS)).toContainEqual(WEB_ALLOW)
    expect(SessionApproval.bundle("full", PATHS)).toContainEqual(SEARCH_ALLOW)
    expect(SessionApproval.bundle("full", PATHS)).not.toContainEqual(WEB_ASK)
    expect(SessionApproval.bundle("full", PATHS)).not.toContainEqual(SEARCH_ASK)
    for (const mode of ["read-only", "ask", "full"] as const) {
      expect(SessionApproval.modeOf(SessionApproval.bundle(mode, PATHS), PATHS)).toBe(mode)
      expect(SessionApproval.legacyWeb(SessionApproval.bundle(mode, PATHS), PATHS)).toBe(false)
    }
    // A mode change replaces the webfetch rule with the next mode's.
    const full = SessionApproval.replace(SessionApproval.bundle("ask", PATHS), "full", PATHS)
    expect(full).toEqual([...SessionApproval.bundle("full", PATHS)])
    expect(SessionApproval.replace(full, "read-only", PATHS)).toEqual([...SessionApproval.bundle("read-only", PATHS)])
  })

  test("a bundle from before still reads as its mode and is legacy; a mode change writes the current one", () => {
    const saved = { action: "webfetch", resource: "https://example.test/*", effect: "allow" } as const
    const tool = { action: "own_harness_codex", resource: "*", effect: "allow" } as const
    for (const mode of ["read-only", "ask"] as const) {
      const old = [saved, ...legacy(mode), tool]
      expect(SessionApproval.modeOf(old, PATHS)).toBe(mode)
      expect(SessionApproval.legacyWeb(old, PATHS)).toBe(true)
      const written = SessionApproval.replace(old, mode, PATHS)
      expect(written).toEqual([saved, tool, ...SessionApproval.bundle(mode, PATHS)])
      expect(SessionApproval.legacyWeb(written, PATHS)).toBe(false)
    }
  })

  test("a bundle from before MR11 (no websearch rule) reads as its mode; only read-only and ask are legacy", () => {
    for (const mode of ["read-only", "ask"] as const) {
      const old = beforeSearch(mode)
      expect(old).toContainEqual(WEB_ASK)
      expect(SessionApproval.modeOf(old, PATHS)).toBe(mode)
      expect(SessionApproval.legacyWeb(old, PATHS)).toBe(true)
      expect(SessionApproval.replace(old, mode, PATHS)).toEqual([...SessionApproval.bundle(mode, PATHS)])
    }
    // A former full bundle reads full; the agent's rules allow web search there as before, so no hook is needed.
    expect(SessionApproval.modeOf(beforeSearch("full"), PATHS)).toBe("full")
    expect(SessionApproval.legacyWeb(beforeSearch("full"), PATHS)).toBe(false)
    expect(SessionApproval.replace(beforeSearch("full"), "full", PATHS)).toEqual([
      ...SessionApproval.bundle("full", PATHS),
    ])
  })

  test("nothing else is legacy: no bundle, or a bundle changed after it was written", () => {
    expect(SessionApproval.legacyWeb([], PATHS)).toBe(false)
    // A former bundle whose protected tail an earlier list wrote still reads as its mode (PP-4), so it is legacy too.
    expect(SessionApproval.modeOf(legacy("ask", ["C:/other/vault/**"]), PATHS)).toBe("ask")
    expect(SessionApproval.legacyWeb(legacy("ask", ["C:/other/vault/**"]), PATHS)).toBe(true)
    expect(SessionApproval.modeOf([...legacy("ask"), WEB_ALLOW], PATHS)).toBe("custom")
    expect(SessionApproval.legacyWeb([...legacy("ask"), WEB_ALLOW], PATHS)).toBe(false)
    expect(SessionApproval.modeOf([...beforeSearch("ask"), SEARCH_ALLOW], PATHS)).toBe("custom")
    expect(SessionApproval.legacyWeb([...beforeSearch("ask"), SEARCH_ALLOW], PATHS)).toBe(false)
  })

  test("savedCovers follows core's resource wildcard", () => {
    expect(SessionApproval.savedCovers("https://example.test/a", ["*"])).toBe(true)
    expect(SessionApproval.savedCovers("https://example.test/a", ["https://example.test/*"])).toBe(true)
    expect(SessionApproval.savedCovers("https://other.test/a", ["https://example.test/*"])).toBe(false)
    expect(SessionApproval.savedCovers("https://example.test/a", [])).toBe(false)
  })
})

describe("former bundles on the fake core (RPC and the evaluate hook)", () => {
  const SESSION = "ses_old"
  const event = (input: Partial<PermissionEvaluation> = {}): PermissionEvaluation => ({
    sessionID: SessionID.make(SESSION),
    action: "webfetch",
    resources: ["https://example.test/page"],
    effect: "allow",
    ...input,
  })

  test("get reads the mode without writing; the hook asks for a web request until the mode is set again", async () => {
    await using m = await machine({ models: { [SESSION]: A }, sessions: { [SESSION]: { permissions: [] } } })
    await m.rpc("session.approval.set", { sessionID: SESSION, mode: "ask" })
    const current = m.facts.get(SESSION)?.permissions ?? []
    expect(current).toContainEqual(WEB_ASK)
    // The same session as an older own-accounts left it (before MR10-3: no web rule).
    const old = current.filter((rule) => rule.action !== "webfetch" && rule.action !== "websearch")
    m.facts.set(SESSION, { permissions: old })
    const writes = m.calls.update.length

    expect(await m.rpc("session.approval.get", { sessionID: SESSION })).toMatchObject({ mode: "ask", rules: old })
    expect(m.calls.update.length).toBe(writes)

    const asked = event()
    await m.switching.webAsk(asked)
    expect(asked.effect).toBe("ask")
    const search = event({ action: "websearch", resources: ["오늘 날씨"] })
    await m.switching.webAsk(search)
    expect(search.effect).toBe("ask")
    // A saved project approval still allows it, and other actions and decisions are left alone.
    const saved = event({ saved: ["*"] })
    await m.switching.webAsk(saved)
    expect(saved.effect).toBe("allow")
    const shell = event({ action: "shell" })
    await m.switching.webAsk(shell)
    expect(shell.effect).toBe("allow")
    const denied = event({ effect: "deny" })
    await m.switching.webAsk(denied)
    expect(denied.effect).toBe("deny")

    // The next mode change writes the current bundle; nothing is legacy any more.
    await m.rpc("session.approval.set", { sessionID: SESSION, mode: "full" })
    const full = event()
    await m.switching.webAsk(full)
    expect(full.effect).toBe("allow")
  })

  test("a deny of the agent's own rules (the user's config) holds under full approval, and is no card under ask", async () => {
    await using m = await machine({ models: { [SESSION]: A }, sessions: { [SESSION]: { permissions: [] } } })
    await m.rpc("session.approval.set", { sessionID: SESSION, mode: "full" })
    // Core adds a config's `permission` to every agent; own's roles add an `ask` after it, which does not lift it.
    const agents: Record<string, ReadonlyArray<{ action: string; resource: string; effect: string }>> = {
      build: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "websearch", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "https://docs.example.test/*", effect: "allow" },
      ],
      explore: [
        { action: "webfetch", resource: "*", effect: "allow" },
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "ask" },
      ],
      // The user's own ask after their deny asks there (decisions RL2-L2): only own's role asks are skipped.
      plan: [
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "https://docs.example.test/*", effect: "ask" },
        { action: "webfetch", resource: "*", effect: "ask" },
      ],
    }
    const ctx = m.deps.ctx as unknown as { agent?: unknown }
    ctx.agent = {
      get: async (request: { readonly agentID: string }) => {
        const permissions = agents[request.agentID]
        if (!permissions) throw new Error("no such agent")
        return { data: { id: request.agentID, permissions } }
      },
    }
    const build = (input: Partial<PermissionEvaluation>) => event({ agent: Agent.ID.make("build"), ...input })
    const search = build({ action: "websearch", resources: ["오늘 날씨"] })
    await m.switching.webAsk(search)
    expect(search.effect).toBe("deny")
    const fetched = build({})
    await m.switching.webAsk(fetched)
    expect(fetched.effect).toBe("deny")
    // The user's own later allow stands, and a saved approval does not lift the deny (core's order without own).
    const docs = build({ resources: ["https://docs.example.test/page"] })
    await m.switching.webAsk(docs)
    expect(docs.effect).toBe("allow")
    const saved = build({ saved: ["*"] })
    await m.switching.webAsk(saved)
    expect(saved.effect).toBe("deny")
    // Under ask approval the bundle's ask would raise a card: the deny stays a deny.
    const asked = build({ effect: "ask" })
    await m.switching.webAsk(asked)
    expect(asked.effect).toBe("deny")
    const explore = event({ agent: Agent.ID.make("explore") })
    await m.switching.webAsk(explore)
    expect(explore.effect).toBe("deny")
    // Outside the read-only roles a trailing `{webfetch, *, ask}` is the user's own and lifts their deny, as does an
    // ask of a narrower pattern: core's order decides then (full approval allows).
    for (const resource of ["https://docs.example.test/page", "https://example.test/page"]) {
      const plan = event({ agent: Agent.ID.make("plan"), resources: [resource] })
      await m.switching.webAsk(plan)
      expect(plan.effect).toBe("allow")
    }
    // An agent that cannot be read asks.
    const unknown = event({ agent: Agent.ID.make("gone") })
    await m.switching.webAsk(unknown)
    expect(unknown.effect).toBe("ask")
  })

  test("a session the hook cannot read asks for a web request (fail closed); a saved approval still allows it", async () => {
    await using m = await machine({ models: { [SESSION]: A }, sessions: { [SESSION]: { permissions: [] } } })
    await m.rpc("session.approval.set", { sessionID: SESSION, mode: "full" })
    const session = m.deps.ctx.session as { get: (request: unknown) => Promise<unknown> }
    session.get = async () => {
      throw new Error("session store unavailable")
    }
    const asked = event()
    await m.switching.webAsk(asked)
    expect(asked.effect).toBe("ask")
    const search = event({ action: "websearch", resources: ["오늘 날씨"] })
    await m.switching.webAsk(search)
    expect(search.effect).toBe("ask")
    const saved = event({ saved: ["*"] })
    await m.switching.webAsk(saved)
    expect(saved.effect).toBe("allow")
  })

  test("a session from before MR11 asks for websearch through the hook; its rules are not rewritten", async () => {
    await using m = await machine({ models: { [SESSION]: A }, sessions: { [SESSION]: { permissions: [] } } })
    await m.rpc("session.approval.set", { sessionID: SESSION, mode: "read-only" })
    const old = (m.facts.get(SESSION)?.permissions ?? []).filter((rule) => rule.action !== "websearch")
    m.facts.set(SESSION, { permissions: old })
    const writes = m.calls.update.length
    expect(await m.rpc("session.approval.get", { sessionID: SESSION })).toMatchObject({ mode: "read-only", rules: old })
    expect(m.calls.update.length).toBe(writes)
    const search = event({ action: "websearch", resources: ["오늘 날씨"] })
    await m.switching.webAsk(search)
    expect(search.effect).toBe("ask")
    const saved = event({ action: "websearch", resources: ["오늘 날씨"], saved: ["*"] })
    await m.switching.webAsk(saved)
    expect(saved.effect).toBe("allow")
  })
})
