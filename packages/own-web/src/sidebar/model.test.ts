// Sidebar logic units (03 §4.3, §7.2, §7.6, §19.11, §20.2 R2): tree flattening (with the team view's folders to take
// in, 06 §8.8), date groups, search, status priority, chips, model labels, tightest window, windowing math,
// folder-picker paths.
import { describe, expect, test } from "bun:test"
import type { OwnAccounts } from "@own/protocol"
import {
  accountsInUse,
  baseName,
  bucketOf,
  chipView,
  dayMarks,
  firstStatus,
  flattenTree,
  foldKey,
  heightOf,
  isAbsolutePath,
  isFocusable,
  joinPath,
  looksLikeSessionID,
  matchesQuery,
  meterLevel,
  modelLabel,
  normalizeQuery,
  offsetsOf,
  orderFamily,
  parentPath,
  parseKey,
  pickStatus,
  rangeOf,
  rootsOf,
  rowHeights,
  rowKey,
  samePath,
  switchNote,
  type AccountLike,
  type TeamProject,
  type TreeInput,
} from "./model"

const HOUR = 60 * 60_000
// Wednesday 2026-09-23 15:00 local time.
const NOW = new Date(2026, 8, 23, 15, 0, 0).getTime()
const marks = dayMarks(NOW)

function tree(overrides: Partial<TreeInput> & { sessions: Record<string, { projectID: string; updated: number }> }) {
  const { sessions, ...rest } = overrides
  return flattenTree({
    order: Object.keys(sessions).toSorted((a, b) => sessions[b]!.updated - sessions[a]!.updated),
    session: (id) => sessions[id],
    collapsed: () => false,
    expanded: () => false,
    children: () => [],
    marks,
    more: false,
    ...rest,
  })
}

describe("date groups (19.11)", () => {
  test("today, yesterday, this week (Monday start), older", () => {
    expect(bucketOf(NOW - HOUR, marks)).toBe("today")
    expect(bucketOf(new Date(2026, 8, 22, 23, 59).getTime(), marks)).toBe("yesterday")
    expect(bucketOf(new Date(2026, 8, 21, 9, 0).getTime(), marks)).toBe("week")
    expect(bucketOf(new Date(2026, 8, 20, 23, 0).getTime(), marks)).toBe("older")
  })

  test("on Monday, Sunday is yesterday and nothing is 'this week' before today", () => {
    const monday = dayMarks(new Date(2026, 8, 21, 10, 0).getTime())
    expect(bucketOf(new Date(2026, 8, 20, 12, 0).getTime(), monday)).toBe("yesterday")
    expect(bucketOf(new Date(2026, 8, 19, 12, 0).getTime(), monday)).toBe("older")
  })
})

describe("flattenTree (4.3)", () => {
  test("groups by project in recency order, one header per project, counts", () => {
    const out = tree({
      sessions: {
        a1: { projectID: "A", updated: NOW - 1 },
        b1: { projectID: "B", updated: NOW - 2 },
        a2: { projectID: "A", updated: NOW - 3 },
      },
    })
    expect(out.keys).toEqual(["p|A", "s|a1", "s|a2", "p|B", "s|b1"])
    expect(out.counts).toEqual({ A: 2, B: 1 })
    expect(out.sessions).toBe(3)
    expect(out.positions.get("p|B")).toEqual([2, 2])
    expect(out.positions.get("s|a2")).toEqual([2, 2])
  })

  test("date headers only inside projects whose sessions span more than one day group", () => {
    const out = tree({
      sessions: {
        a1: { projectID: "A", updated: NOW - HOUR },
        a2: { projectID: "A", updated: NOW - 30 * HOUR },
        a3: { projectID: "A", updated: NOW - 20 * 24 * HOUR },
        b1: { projectID: "B", updated: NOW - 2 * HOUR },
      },
    })
    expect(out.keys).toEqual(["p|A", "d|A|today", "s|a1", "d|A|yesterday", "s|a2", "d|A|older", "s|a3", "p|B", "s|b1"])
  })

  test("19.3: worktree sessions follow the project's own under one `⑂` header per worktree", () => {
    const worktrees: Record<string, string> = { a2: "C:\\wt\\feat|x", a4: "C:\\wt\\feat|x", a3: "C:\\wt\\fix" }
    const out = tree({
      sessions: {
        a1: { projectID: "A", updated: NOW - 1 },
        a2: { projectID: "A", updated: NOW - 2 },
        a3: { projectID: "A", updated: NOW - 3 },
        a4: { projectID: "A", updated: NOW - 4 },
        a5: { projectID: "A", updated: NOW - 5 },
      },
      worktree: (id) => worktrees[id],
    })
    const feat = rowKey.worktree("A", "C:\\wt\\feat|x")
    expect(feat.split("|")).toHaveLength(3)
    expect(parseKey(feat)).toEqual({ kind: "worktree", id: "A", extra: encodeURIComponent("C:\\wt\\feat|x") })
    expect(out.keys).toEqual(["p|A", "s|a1", "s|a5", feat, "s|a2", "s|a4", rowKey.worktree("A", "C:\\wt\\fix"), "s|a3"])
    expect(out.counts.A).toBe(5)
    expect(isFocusable(feat)).toBe(false)
    // Searching lists matches flat, as before.
    expect(
      tree({ sessions: { a2: { projectID: "A", updated: NOW } }, worktree: (id) => worktrees[id], match: () => true })
        .keys,
    ).toEqual(["p|A", "s|a2"])
  })

  test("collapsed projects keep their header and count; expanded sessions list subagents", () => {
    const out = tree({
      sessions: { a1: { projectID: "A", updated: NOW }, b1: { projectID: "B", updated: NOW - 1 } },
      collapsed: (id) => id === "A",
      expanded: (id) => id === "b1",
      children: (id) =>
        id === "b1"
          ? [
              { id: "c1", level: 1 },
              { id: "c2", level: 2 },
            ]
          : [],
    })
    expect(out.keys).toEqual(["p|A", "p|B", "s|b1", "c|c1|1", "c|c2|2"])
    expect(out.counts.A).toBe(1)
  })

  test("search opens every project, drops date headers and subagents, hides empty projects", () => {
    const out = tree({
      sessions: {
        a1: { projectID: "A", updated: NOW },
        a2: { projectID: "A", updated: NOW - 40 * HOUR },
        b1: { projectID: "B", updated: NOW - 1 },
      },
      collapsed: () => true,
      expanded: () => true,
      children: () => [{ id: "c", level: 1 }],
      match: (id) => id !== "b1",
      more: true,
    })
    expect(out.keys).toEqual(["p|A", "s|a1", "s|a2"])
  })

  test("06 §8.8: folders a team could take in list under 팀에 넣지 않은 작업 폴더 with or without conversations", () => {
    const left = "D:\\own\\.worktrees\\cl-x"
    const quiet = "D:\\own\\.worktrees\\local-model"
    const outside: Record<string, string> = { t1: "D:\\tool\\wt", x1: "D:\\OWN\\.worktrees\\cl-x" }
    const team: TeamProject = {
      teams: [{ teamID: "tm_0123456789ab", main: "m1", areas: [] }],
      requests: [],
      notices: [],
      unadopted: [
        { teamID: "tm_0123456789ab", directory: left },
        { teamID: "tm_0123456789ab", directory: quiet },
      ],
      slot: (sessionID) =>
        outside[sessionID]
          ? { kind: "outside", directory: outside[sessionID] }
          : { kind: "main", teamID: "tm_0123456789ab" },
    }
    const sessions = {
      m1: { projectID: "A", updated: NOW - 1 },
      t1: { projectID: "A", updated: NOW - 2 },
      x1: { projectID: "A", updated: NOW - 3 },
    }
    const folded = tree({ sessions, team: () => team })
    expect(folded.keys).toEqual(["p|A", "s|m1", rowKey.outside("A")])
    // The two folders to take in (one with a conversation, matched without case) and another folder.
    expect(folded.counts[rowKey.outside("A")]).toBe(3)
    const open = tree({ sessions, team: () => team, expanded: (id) => id === foldKey.outside("A") })
    expect(open.keys).toEqual([
      "p|A",
      "s|m1",
      rowKey.outside("A"),
      rowKey.worktree("A", left),
      "s|x1",
      rowKey.worktree("A", quiet),
      rowKey.worktree("A", "D:\\tool\\wt"),
      "s|t1",
    ])
    // Without such folders nor conversations outside, there is no group.
    expect(tree({ sessions: { m1: sessions.m1 }, team: () => ({ ...team, unadopted: [] }) }).keys).toEqual([
      "p|A",
      "s|m1",
    ])
  })

  test("the more row closes the list when the server has older sessions", () => {
    expect(tree({ sessions: { a: { projectID: "A", updated: NOW } }, more: true }).keys.at(-1)).toBe(rowKey.more)
  })

  test("row keys round-trip", () => {
    expect(parseKey(rowKey.child("ses_1", 2))).toEqual({ kind: "child", id: "ses_1", extra: "2" })
    expect(parseKey(rowKey.date("prj", "week"))).toEqual({ kind: "date", id: "prj", extra: "week" })
    expect(parseKey(rowKey.more).kind).toBe("more")
    expect(parseKey(rowKey.import("prj"))).toEqual({ kind: "import", id: "prj", extra: undefined })
  })

  test("09 §6 entry 1: `다른 도구의 대화 · 새 N개` ends an open project with something new, never while searching", () => {
    const sessions = {
      a1: { projectID: "A", updated: NOW - 1 },
      b1: { projectID: "B", updated: NOW - 2 },
      a2: { projectID: "A", updated: NOW - 3 },
    }
    const imports = (projectID: string) => projectID === "A"
    expect(tree({ sessions, imports, more: true }).keys).toEqual([
      "p|A",
      "s|a1",
      "s|a2",
      rowKey.import("A"),
      "p|B",
      "s|b1",
      rowKey.more,
    ])
    expect(tree({ sessions, imports, collapsed: (id) => id === "A" }).keys).not.toContain(rowKey.import("A"))
    expect(tree({ sessions, imports, match: () => true }).keys).not.toContain(rowKey.import("A"))
    expect(isFocusable(rowKey.import("A"))).toBe(true)
    expect(heightOf(rowKey.import("A"), rowHeights("comfortable", false))).toBe(rowHeights("comfortable", false).child)
  })
})

describe("the default conversation folder's group (03 §5.1)", () => {
  test("is listed first, after the pinned group, wherever its newest conversation is", () => {
    const sessions = {
      a: { projectID: "prj_app", updated: NOW },
      b: { projectID: "prj_chats", updated: NOW - HOUR },
      c: { projectID: "prj_other", updated: NOW - 2 * HOUR },
    }
    expect(tree({ sessions }).keys.filter((key) => key.startsWith("p|"))).toEqual([
      "p|prj_app",
      "p|prj_chats",
      "p|prj_other",
    ])
    const leading = tree({ sessions, leading: "prj_chats" })
    expect(leading.keys.filter((key) => key.startsWith("p|"))).toEqual(["p|prj_chats", "p|prj_app", "p|prj_other"])
    expect(leading.positions.get("p|prj_chats")).toEqual([1, 3])
    expect(leading.keys.slice(0, 2)).toEqual(["p|prj_chats", "s|b"])
    // No conversation there yet: the order stays.
    expect(tree({ sessions, leading: "prj_none" }).keys.filter((key) => key.startsWith("p|"))).toEqual([
      "p|prj_app",
      "p|prj_chats",
      "p|prj_other",
    ])
  })
})

describe("orderFamily (subagents under their parent)", () => {
  test("depth-first, newest first per level, capped depth", () => {
    const info: Record<string, { parentID?: string; updated: number }> = {
      root: { updated: 0 },
      c1: { parentID: "root", updated: 1 },
      c2: { parentID: "root", updated: 2 },
      g1: { parentID: "c1", updated: 3 },
      gg: { parentID: "g1", updated: 4 },
      ggg: { parentID: "gg", updated: 5 },
    }
    expect(orderFamily("root", Object.keys(info), (id) => info[id], 3)).toEqual([
      { id: "c2", level: 1 },
      { id: "c1", level: 1 },
      { id: "g1", level: 2 },
      { id: "gg", level: 3 },
      { id: "ggg", level: 3 },
    ])
  })
})

describe("search", () => {
  test("case-insensitive, NFC-normalized title match; exact session id", () => {
    const query = normalizeQuery("  결제 ")
    expect(matchesQuery(query, "결제 웹훅 재시도", "ses_1")).toBe(true)
    // Decomposed Hangul (NFD, as pasted from macOS file names) still matches.
    expect(matchesQuery(query, "결제".normalize("NFD") + " 흐름", "ses_1")).toBe(true)
    expect(matchesQuery(normalizeQuery("RPC"), "계정 라우터 rpc 설계", "ses_1")).toBe(true)
    expect(matchesQuery(normalizeQuery("ses_abc"), "x", "ses_abc")).toBe(true)
    expect(matchesQuery(normalizeQuery("없음"), "결제", "ses_1")).toBe(false)
  })

  test("session id detection matches upstream", () => {
    expect(looksLikeSessionID("ses_01JABCDEFGHJKMNPQRSTVW")).toBe(true)
    expect(looksLikeSessionID("ses_short")).toBe(false)
    expect(looksLikeSessionID("결제 웹훅")).toBe(false)
  })
})

describe("status (7.6)", () => {
  test("priority ? > ! > ● > ◐ > ↶ > ⧗ > • > ○", () => {
    expect(pickStatus({ unread: true, running: true, waiting: true })).toBe("waiting")
    expect(pickStatus({ running: true, error: true })).toBe("error")
    expect(pickStatus({ pending: true, running: true })).toBe("running")
    expect(pickStatus({ unread: true, background: true })).toBe("background")
    expect(pickStatus({})).toBe("idle")
  })

  test("firstStatus stops at the first hit (lower checks are not read)", () => {
    const read: string[] = []
    const check = (name: string, value: boolean) => () => {
      read.push(name)
      return value
    }
    expect(
      firstStatus({
        unread: check("unread", true),
        running: check("running", true),
        waiting: check("waiting", false),
      }),
    ).toBe("running")
    expect(read).toEqual(["waiting", "running"])
  })

  test("switch notes: pending while waiting for a safe point or compacting, scheduled for cold points", () => {
    const target = { providerID: "own-oai-x", id: "gpt-5.5" }
    expect(switchNote({ state: "WAIT_SAFE", target, strategy: "now", reason: "manual" } as never)).toEqual({
      kind: "pending",
      target,
    })
    expect(switchNote({ state: "STEADY" })).toBeUndefined()
    expect(
      switchNote({
        state: "SCHEDULED",
        target,
        trigger: "either",
        idleMinutes: 60,
        uncertain: true,
        deadline: 1,
      } as never)?.kind,
    ).toBe("scheduled")
  })
})

const alpha: AccountLike = {
  id: "acc_alpha",
  providerID: "own-oai-abcd",
  label: "Alpha",
  shortLabel: "Al",
  color: "teal",
  thirdParty: false,
  status: "ready",
}

function binding(fields: Partial<OwnAccounts.Binding>): OwnAccounts.Binding {
  return {
    sessionID: "ses_1",
    model: { providerID: "own-oai-abcd", id: "gpt-5.5" },
    accountID: null,
    builtin: false,
    thirdParty: false,
    home: null,
    switch: { state: "STEADY" },
    ...fields,
  } as OwnAccounts.Binding
}

describe("chipView (1, 5.2.1)", () => {
  const base = {
    known: true,
    account: (id: string) => (id === alpha.id ? alpha : undefined),
    accountFor: (providerID: string) => (providerID === alpha.providerID ? alpha : undefined),
    accountsKnown: true,
  }

  test("router account from the binding, with a problem flag for broken credentials", () => {
    expect(chipView({ ...base, binding: binding({ accountID: "acc_alpha" as never }) })).toEqual({
      kind: "account",
      account: alpha,
      problem: false,
    })
    const broken = { ...alpha, status: "needs_reauth" as const }
    expect(
      chipView({ ...base, account: () => broken, binding: binding({ accountID: "acc_alpha" as never }) }),
    ).toMatchObject({
      problem: true,
    })
  })

  test("unpinned: binding model null, or a known session without model", () => {
    expect(chipView({ ...base, binding: binding({ model: null }) })).toEqual({ kind: "unpinned" })
    expect(chipView({ ...base, model: undefined })).toEqual({ kind: "unpinned" })
    expect(chipView({ ...base, known: false })).toEqual({ kind: "loading" })
  })

  test("built-in provider (전역 계정) from the binding or from a provider no account owns", () => {
    expect(
      chipView({ ...base, binding: binding({ builtin: true, model: { providerID: "openai", id: "gpt-5" } as never }) }),
    ).toEqual({ kind: "builtin", provider: "openai" })
    expect(chipView({ ...base, model: { providerID: "openai", id: "gpt-5" } })).toEqual({
      kind: "builtin",
      provider: "openai",
    })
  })

  test("before any account list is known, an unmatched provider is still loading (no false warning)", () => {
    expect(chipView({ ...base, accountsKnown: false, model: { providerID: "openai", id: "x" } })).toEqual({
      kind: "loading",
    })
    expect(chipView({ ...base, accountsKnown: false, model: { providerID: alpha.providerID, id: "x" } }).kind).toBe(
      "account",
    )
  })
})

describe("modelLabel", () => {
  test("catalog names win; ids become readable", () => {
    expect(modelLabel("gpt-5.6-sol", "GPT-5.6 Sol")).toBe("GPT-5.6 Sol")
    expect(modelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol")
    expect(modelLabel("gpt-5.5")).toBe("GPT-5.5")
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5")
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Claude Opus 4.1")
    expect(modelLabel("openrouter/deepseek-chat")).toBe("Deepseek Chat")
    expect(modelLabel("o4-mini")).toBe("o4 Mini")
  })
})

describe("limits (7.2)", () => {
  test("meter colors: <70 neutral, 70–90 warning, ≥90 or exhausted danger", () => {
    expect(meterLevel({ usedPercent: 69, status: "ok" })).toBe("ok")
    expect(meterLevel({ usedPercent: 70, status: "ok" })).toBe("warn")
    expect(meterLevel({ usedPercent: 90, status: "warning" })).toBe("danger")
    expect(meterLevel({ usedPercent: 10, status: "exhausted" })).toBe("danger")
  })

  test("accounts in use: last 24 h, most recent first, at most three", () => {
    const list = [
      { id: "a", lastUsedAt: NOW - HOUR, status: "ready" as const },
      { id: "b", lastUsedAt: NOW - 25 * HOUR, status: "ready" as const },
      { id: "c", lastUsedAt: NOW - 2 * HOUR, status: "ready" as const },
      { id: "d", lastUsedAt: NOW - 3 * HOUR, status: "ready" as const },
      { id: "e", lastUsedAt: NOW, status: "retired" as const },
      { id: "f", lastUsedAt: NOW - 4 * HOUR, status: "ready" as const },
    ]
    expect(accountsInUse(list, NOW).map((item) => item.id)).toEqual(["a", "c", "d"])
  })
})

describe("windowing (R2)", () => {
  test("offsets from fixed heights and the rows intersecting a viewport", () => {
    const heights = rowHeights("comfortable", false)
    const keys = ["p|A", ...Array.from({ length: 300 }, (_, index) => `s|${index}`)]
    const offsets = offsetsOf(keys.map((key) => heightOf(key, heights)))
    expect(offsets[1]).toBe(30)
    expect(offsets.at(-1)).toBe(30 + 300 * 52)
    expect(rangeOf(offsets, 0, 100)).toEqual([0, 3])
    const [start, end] = rangeOf(offsets, 30 + 52 * 100, 30 + 52 * 100 + 520)
    expect(start).toBe(101)
    expect(end).toBe(111)
    expect(rangeOf(offsets, 1e9, 1e9 + 10)[0]).toBe(keys.length - 1)
    expect(rangeOf(offsetsOf([]), 0, 100)).toEqual([0, 0])
  })

  test("compact density and coarse pointers", () => {
    expect(rowHeights("compact", false).session).toBe(32)
    expect(rowHeights("comfortable", true).project).toBe(44)
  })
})

describe("paths (18.3)", () => {
  test("Windows and POSIX parents, joins and names", () => {
    expect(parentPath("D:\\own-open-code\\packages")).toBe("D:\\own-open-code")
    expect(parentPath("D:\\own-open-code")).toBe("D:\\")
    expect(parentPath("D:\\")).toBeUndefined()
    expect(parentPath("/home/me/work/")).toBe("/home/me")
    expect(parentPath("/home")).toBe("/")
    expect(parentPath("/")).toBeUndefined()
    expect(joinPath("D:\\", "work")).toBe("D:\\work")
    expect(joinPath("D:\\work\\", "한글 폴더")).toBe("D:\\work\\한글 폴더")
    expect(joinPath("/srv", "a#b")).toBe("/srv/a#b")
    expect(baseName("..\\..\\work\\a#b\\")).toBe("a#b")
    expect(isAbsolutePath("C:\\x")).toBe(true)
    expect(isAbsolutePath("work")).toBe(false)
    expect(rootsOf(["d:\\a", "C:\\b", "D:\\c", "/x"])).toEqual(["D:\\", "C:\\", "/"])
    expect(samePath("d:\\Work\\", "D:\\work")).toBe(true)
    expect(samePath("/a/B", "/a/b")).toBe(false)
  })
})
