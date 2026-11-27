// The protected tail of the approval bundles after the list changed (PP-4): a session whose rules end with the denies an
// earlier list wrote (a linked account, a moved config folder or database, an older build) keeps its mode, is never
// rewritten by a read, and a mode change replaces that tail with the current one; the browser and computer switches
// step over it. A custom set keeps its rules. Pure bundle functions; the RPC path is approval-webfetch.test.ts.
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import { Registry } from "@own/protocol"
import { Schema } from "effect"
import { SessionApproval } from "../../src/switching/approval.js"

/** The list an earlier write placed: an old app's profiles that are no longer linked. */
const OLD = ["C:/own/vault/**", "D:/old-app/profiles/**"]
/** The list now: the profiles gone, the registry files there. */
const NOW = ["C:/own/vault/**", "C:/own/*.json"]
const pairs = (paths: ReadonlyArray<string>): Permission.Rule[] =>
  paths.flatMap((resource) => [
    { action: "read", resource, effect: "deny" },
    { action: "edit", resource, effect: "deny" },
  ])
const MODES = ["read-only", "ask", "full"] as const
const SAVED: Permission.Rule = { action: "shell", resource: "git status *", effect: "allow" }
const GATE: Permission.Rule = { action: "own_harness_codex", resource: "*", effect: "allow" }

describe("a protected tail from an earlier list", () => {
  test("still reads as its mode, legacy web bundles included", () => {
    for (const mode of MODES) {
      const rules = [SAVED, ...SessionApproval.bundle(mode, OLD), GATE]
      expect(SessionApproval.modeOf(rules, NOW)).toBe(mode)
      expect(SessionApproval.legacyWeb(rules, NOW)).toBe(false)
      // A shorter current list too (an account unlinked).
      expect(SessionApproval.modeOf(SessionApproval.bundle(mode, NOW), OLD)).toBe(mode)
    }
    const beforeSearch = SessionApproval.bundle("ask", OLD).filter((rule) => rule.action !== "websearch")
    expect(SessionApproval.modeOf(beforeSearch, NOW)).toBe("ask")
    expect(SessionApproval.legacyWeb(beforeSearch, NOW)).toBe(true)
  })

  test("a mode change writes the current tail in place of the old one; everything else keeps its order", () => {
    const rules = [SAVED, ...SessionApproval.bundle("ask", OLD), GATE]
    const written = SessionApproval.replace(rules, "full", NOW)
    expect(written).toEqual([SAVED, GATE, ...SessionApproval.bundle("full", NOW)])
    expect(SessionApproval.modeOf(written, NOW)).toBe("full")
    // The same mode again is the same write (no churn beyond the tail).
    expect(SessionApproval.replace(written, "full", NOW)).toEqual(written)
  })

  test("the browser and computer switches insert before the old tail and the mode still reads", () => {
    const rules = SessionApproval.bundle("full", OLD)
    // Before the whole own tail (the mode rules and the old denies), which stays as it was.
    const computer = SessionApproval.withComputerUse([SAVED, ...rules], "on", NOW)
    expect(computer).toEqual([SAVED, SessionApproval.COMPUTER_ALLOW, ...rules])
    expect(rules.slice(4)).toEqual(pairs(OLD))
    expect(SessionApproval.computerUseOf(computer)).toBe("on")
    expect(SessionApproval.modeOf(computer, NOW)).toBe("full")
    const browser = SessionApproval.withBrowserTool([SAVED, ...rules], "off", NOW)
    expect(browser).toEqual([SAVED, SessionApproval.BROWSER_DENY, ...rules])
    expect(SessionApproval.browserToolOf(browser)).toBe("off")
    expect(SessionApproval.modeOf(browser, NOW)).toBe("full")
  })

  test("not a tail: no protected denies, a changed bundle, or a lone user deny (custom stays custom)", () => {
    expect(SessionApproval.modeOf(SessionApproval.bundle("full", []), NOW)).toBe("custom")
    const changed = [
      ...SessionApproval.bundle("full", OLD),
      { action: "edit", resource: "**", effect: "allow" } as const,
    ]
    expect(SessionApproval.modeOf(changed, NOW)).toBe("custom")
    const lone = [
      ...SessionApproval.bundle("ask", []),
      { action: "read", resource: "C:/secret/**", effect: "deny" } as const,
    ]
    expect(SessionApproval.modeOf(lone, NOW)).toBe("custom")
    // A custom set's deny pairs are not dropped by a mode change (only the current list's denies are).
    expect(SessionApproval.replace(changed, "ask", NOW)).toEqual([
      ...pairs(["D:/old-app/profiles/**"]),
      ...SessionApproval.bundle("ask", NOW),
    ])
  })

  test("a deny pair the user put after own's tail is not own's: the rules stay custom and a mode change keeps it", () => {
    const mine = pairs(["D:/private/**"])
    const full = SessionApproval.bundle("full", NOW)
    for (const list of [NOW, OLD]) {
      const rules = [...SessionApproval.bundle("ask", list), ...mine]
      expect(SessionApproval.modeOf(rules, NOW)).toBe("custom")
      expect(SessionApproval.replace(rules, "full", NOW).slice(-(mine.length + full.length))).toEqual([
        ...mine,
        ...full,
      ])
    }
    // Pairs without own's vault first are not a tail either.
    expect(SessionApproval.modeOf([...SessionApproval.bundle("ask", []), ...pairs(["C:/own/*.json"])], NOW)).toBe(
      "custom",
    )
  })

  test("protectedPaths keeps its list and order (no session gets another tail from this change)", () => {
    const input = {
      home: "C:\\own",
      userHome: "C:\\Users\\me",
      configDir: "C:\\cfg",
      database: "C:\\data\\opencode-own.db",
      claudeConfigDir: "C:\\Users\\me\\.claude",
      registry: Schema.decodeUnknownSync(Registry.File)({
        schemaVersion: Registry.SCHEMA_VERSION,
        revision: 0,
        cacheDomains: {},
        quotaDomains: {},
        accounts: [],
        slots: {},
        modelTemplates: {},
      }),
    }
    expect(SessionApproval.protectedPaths(input)).toEqual([
      "C:/own/vault/**",
      "C:/own/*.json",
      "C:/cfg/*.json*",
      "C:/data/opencode-own.db*",
      "C:/Users/me/.claude/.credentials.json",
    ])
    expect(SessionApproval.ownPlaces(input).map((place) => place.place)).toEqual([
      "vault",
      "files",
      "config",
      "database",
      "claude",
      "claude-config",
    ])
  })

  test("the database is protected where core puts it, also without OPENCODE_DB (the installed app)", () => {
    const registry = Schema.decodeUnknownSync(Registry.File)({
      schemaVersion: Registry.SCHEMA_VERSION,
      revision: 0,
      cacheDomains: {},
      quotaDomains: {},
      accounts: [],
      slots: {},
      modelTemplates: {},
    })
    const database = (env: Record<string, string>) =>
      SessionApproval.protectedInput({ home: "C:\\own", userHome: "C:\\Users\\me", env, registry }).database
    expect(database({})).toBe(path.join("C:\\Users\\me", ".local", "share", "opencode", "opencode"))
    expect(database({ XDG_DATA_HOME: "D:\\xdg" })).toBe(path.join("D:\\xdg", "opencode", "opencode"))
    expect(database({ OPENCODE_DB: "C:\\data\\opencode-own.db" })).toBe(path.resolve("C:\\data\\opencode-own.db"))
    expect(database({ OPENCODE_DB: "other.db" })).toBe(
      path.resolve(path.join("C:\\Users\\me", ".local", "share", "opencode"), "other.db"),
    )
    expect(database({ OPENCODE_DB: ":memory:" })).toBeUndefined()
    const patterns = SessionApproval.protectedPaths(
      SessionApproval.protectedInput({ home: "C:\\own", userHome: "C:\\Users\\me", env: {}, registry }),
    )
    expect(patterns).toContain(`${path.join("C:\\Users\\me", ".local", "share", "opencode", "opencode").replaceAll("\\", "/")}*`)
  })
})
