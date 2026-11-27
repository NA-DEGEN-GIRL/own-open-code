// 내 브라우저 사용 in own-web (BRW): the rule reading that must match own-accounts, the per-conversation switch over a
// fake own.accounts router (answers like switching.ts `approvalGet` / `approvalSet`), the status cache the `⋯` item
// reads, the links the settings page opens, the route, and the strings.
import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "@opencode/client"
import { OwnBrowse, type Approval } from "@own/protocol"
import { parseRoute, SETTINGS_GROUPS } from "@/routing/routes"
import { PRODUCT_URL, STORE_URL } from "./settings"
import { browseEn, browseKo, browseText } from "./strings"
import { browseMenuText } from "./menu-strings"
import { ACTIONS, browseOf, browseStatus, refreshBrowseStatus, rememberBrowseStatus } from "./state"
import { BrowseSwitchError, createBrowseSwitch, verdict, type BrowseRuntime } from "./switch"

const SESSION = "ses_browse_test_aaaaaaaaaaaa"
const ask: PermissionRule = { action: "edit", resource: "**", effect: "ask" }

/** A fake runtime: `session.approval.get/set` over one conversation's rules, and which methods the connection may call. */
function runtime(
  input: { readonly rules?: PermissionRule[]; readonly mode?: Approval.Mode; readonly local?: boolean } = {},
) {
  const state = { rules: [...(input.rules ?? [ask])], writes: [] as unknown[], invalidated: 0 }
  const allowed = new Set([
    "session.approval.get",
    "session.approval.set",
    "browse.status",
    ...(input.local === false ? [] : ["browse.set"]),
  ])
  const value: BrowseRuntime = {
    rpc: {
      allowed: ((method: string) => allowed.has(method)) as BrowseRuntime["rpc"]["allowed"],
      call: (async (method: string, payload: Record<string, unknown>) => {
        if (method === "session.approval.get")
          return { mode: input.mode ?? "ask", rules: state.rules, children: { open: 0 }, browse: browseOf(state.rules) }
        if (method === "session.approval.set") {
          state.writes.push(payload)
          const rest = state.rules.filter((rule) => rule.action !== ACTIONS)
          state.rules = payload.browse === "on" ? [{ ...OwnBrowse.ALLOW }, ...rest] : rest
          return { mode: payload.mode, patched: [SESSION], browse: browseOf(state.rules) }
        }
        throw new Error(`unexpected ${method}`)
      }) as BrowseRuntime["rpc"]["call"],
    },
    connection: { status: () => "connected" },
    data: {
      session: {
        invalidate: () => {
          state.invalidated += 1
        },
        sync: async () => undefined,
      },
    },
  }
  return Object.assign(value, { state })
}

describe("rules", () => {
  test("browseOf reads like own-accounts: only the exact allow as the last browse_* rule", () => {
    expect(ACTIONS).toBe(OwnBrowse.ACTIONS)
    expect(browseOf(undefined)).toBe("off")
    expect(browseOf([{ ...OwnBrowse.DENY }])).toBe("off")
    expect(browseOf([{ ...OwnBrowse.DENY }, { ...OwnBrowse.ALLOW }, ask])).toBe("on")
    expect(browseOf([{ ...OwnBrowse.ALLOW }, { ...OwnBrowse.DENY }])).toBe("off")
    expect(browseOf([{ action: "browse_*", resource: "x", effect: "allow" }])).toBe("off")
  })

  test("verdict: no answer, an older service, a custom conversation", () => {
    expect(verdict(undefined)).toEqual({ ok: false, reason: "unavailable" })
    expect(verdict({ mode: "ask", rules: [], children: { open: 0 } })).toEqual({ ok: false, reason: "unsupported" })
    expect(verdict({ mode: "custom", rules: [], children: { open: 0 }, browse: "off" })).toEqual({
      ok: false,
      reason: "custom",
    })
    expect(verdict({ mode: "full", rules: [], children: { open: 0 }, browse: "on" })).toEqual({
      ok: true,
      mode: "full",
      use: "on",
    })
  })
})

describe("switch", () => {
  test("on and off write with the current mode; a write that changes nothing is not sent", async () => {
    const r = runtime({ mode: "full" })
    const writer = createBrowseSwitch(r)
    expect(await writer.check(SESSION)).toEqual({ ok: true, mode: "full", use: "off" })
    expect(await writer.set(SESSION, "on")).toBe("on")
    expect(r.state.writes).toEqual([{ sessionID: SESSION, mode: "full", browse: "on" }])
    expect(await writer.set(SESSION, "on")).toBe("on")
    expect(r.state.writes).toHaveLength(1)
    expect(await writer.set(SESSION, "off")).toBe("off")
    expect(r.state.writes.at(-1)).toEqual({ sessionID: SESSION, mode: "full", browse: "off" })
    expect(r.state.invalidated).toBe(3)
  })

  test("another device may turn it off but not on (`browse.set` is local)", async () => {
    const r = runtime({ rules: [{ ...OwnBrowse.ALLOW }, ask], local: false })
    const writer = createBrowseSwitch(r)
    expect(writer.canTurnOn()).toBe(false)
    expect(await writer.set(SESSION, "on").catch((error: unknown) => error)).toEqual(new BrowseSwitchError("scope"))
    expect(r.state.writes).toEqual([])
    expect(await writer.set(SESSION, "off")).toBe("off")
  })

  test("a custom conversation cannot be switched", async () => {
    const writer = createBrowseSwitch(runtime({ mode: "custom" }))
    const error = await writer.set(SESSION, "on").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BrowseSwitchError)
    expect((error as BrowseSwitchError).reason).toBe("custom")
  })
})

describe("status", () => {
  test("the window remembers the last answer; a failed call keeps it", async () => {
    const status: OwnBrowse.Status = {
      enabled: true,
      source: "install",
      command: "C:/b/browse.exe",
      given: false,
      active: true,
    }
    rememberBrowseStatus(status)
    expect(browseStatus()).toEqual(status)
    const failing = { allowed: () => true, call: async () => Promise.reject(new Error("offline")) } as never
    expect(await refreshBrowseStatus(failing)).toBeUndefined()
    expect(browseStatus()).toEqual(status)
    const next = { ...status, enabled: false, active: false }
    expect(await refreshBrowseStatus({ allowed: () => true, call: async () => next } as never)).toEqual(next)
    expect(browseStatus()).toEqual(next)
    // A connection that may not read it asks nothing.
    expect(await refreshBrowseStatus({ allowed: () => false, call: async () => status } as never)).toBeUndefined()
  })

  test("the page's links are the protocol's, and the page has its route after 컴퓨터 사용", () => {
    expect(STORE_URL).toBe(OwnBrowse.STORE_URL)
    expect(PRODUCT_URL).toBe(OwnBrowse.PRODUCT_URL)
    expect(parseRoute("/settings/browse").route).toEqual({ name: "settings", section: "browse" })
    const agent: ReadonlyArray<string> = SETTINGS_GROUPS.find((group) => group.id === "agent")?.sections ?? []
    expect(agent.indexOf("browse")).toBe(agent.indexOf("experimental") + 1)
  })
})

describe("strings", () => {
  test("every key in both languages, 해요체 in Korean, the placeholders kept", () => {
    expect(Object.keys(browseEn).sort()).toEqual(Object.keys(browseKo).sort())
    for (const [key, value] of Object.entries(browseKo)) {
      expect(value).not.toMatch(/습니다|합니다|십시오/)
      const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      expect(holes(browseEn[key as keyof typeof browseEn])).toEqual(holes(value))
    }
    expect(browseText("ko", "own.browse.found.install", { path: "C:/b/browse.exe" })).toBe("찾았어요: C:/b/browse.exe")
    expect(browseMenuText("ko", "own.browse.menu")).toBe("이 대화에서 내 브라우저 사용…")
    expect(browseMenuText("en", "own.browse.menu")).toBe("Use my browser in this conversation…")
  })
})
