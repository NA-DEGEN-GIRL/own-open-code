import { describe, expect, test } from "bun:test"
import {
  isPage,
  parseRoute,
  routePath,
  routeServer,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  teamSettingsRoute,
  type Route,
} from "./routes"

describe("routes (03 §3)", () => {
  test("round-trips every route through its path", () => {
    const routes: Route[] = [
      { name: "home" },
      { name: "home", serverKey: "local" },
      { name: "home", serverKey: "my host" },
      { name: "session", serverKey: "local", sessionID: "ses_01" },
      { name: "session", serverKey: "lab", sessionID: "ses_02" },
      { name: "project", serverKey: "local", projectID: "prj_1" },
      { name: "accounts" },
      { name: "accountsAdd" },
      { name: "accountsAdd", kind: "oai" },
      { name: "limits" },
      { name: "settings", section: "general", list: true },
      { name: "settings", section: "compaction" },
      { name: "settings", section: "team" },
      { name: "settings", section: "team", team: { serverKey: "local" } },
      { name: "settings", section: "team", team: { serverKey: "local", teamID: "tm_0123456789ab" } },
      { name: "settings", section: "team", team: { serverKey: "my host", teamID: "tm_ba9876543210" } },
      { name: "settings", section: "import" },
      { name: "import", serverKey: "local", projectID: "prj_1" },
      {
        name: "import",
        serverKey: "local",
        projectID: "prj_1",
        ref: { kind: "codex", rootID: "codex-0a1b2c3d4e5f", id: "019a-thread" },
      },
      {
        name: "import",
        serverKey: "my host",
        projectID: "prj 2",
        ref: { kind: "claude-code", rootID: "claude-0a1b2c3d4e5f", id: "5f1e2d3c:agent-a1b2" },
      },
    ]
    for (const route of routes) expect(parseRoute(routePath(route)).route).toEqual(route)
  })

  test("a server's new-conversation screen without a project (5.1): `/` for this PC, `/srv/<key>/new` by name", () => {
    expect(routePath({ name: "home" })).toBe("/")
    expect(routePath({ name: "home", serverKey: "lab" })).toBe("/srv/lab/new")
    expect(parseRoute("/srv/lab/new")).toEqual({ route: { name: "home", serverKey: "lab" } })
    expect(isPage({ name: "home", serverKey: "lab" })).toBe(false)
    expect(routeServer({ name: "home" })).toBe("local")
    expect(routeServer({ name: "home", serverKey: "lab" })).toBe("lab")
    expect(routeServer({ name: "project", serverKey: "lab", projectID: "prj_1" })).toBe("lab")
    expect(routeServer({ name: "settings", section: "general" })).toBe("local")
  })

  test("/s/:id is the local short form and is rewritten", () => {
    expect(parseRoute("/s/ses_9")).toEqual({
      route: { name: "session", serverKey: "local", sessionID: "ses_9" },
      replace: "/srv/local/s/ses_9",
    })
  })

  test("unknown paths and sections fall back", () => {
    expect(parseRoute("/nope/x")).toEqual({ route: { name: "home" }, replace: "/" })
    expect(parseRoute("/settings/zzz")).toEqual({
      route: { name: "settings", section: "general" },
      replace: "/settings/general",
    })
  })

  test("/settings is the section list (03 §5.7 drill-down); a section path opens that page", () => {
    expect(parseRoute("/settings")).toEqual({ route: { name: "settings", section: "general", list: true } })
    expect(parseRoute("/settings/")).toEqual({ route: { name: "settings", section: "general", list: true } })
    expect(routePath({ name: "settings", section: "general", list: true })).toBe("/settings")
    expect(parseRoute("/settings/general")).toEqual({ route: { name: "settings", section: "general" } })
    expect(isPage({ name: "settings", section: "general", list: true })).toBe(true)
  })

  test("encodes server keys and ids", () => {
    const route: Route = { name: "session", serverKey: "my host", sessionID: "a/b" }
    expect(routePath(route)).toBe("/srv/my%20host/s/a%2Fb")
    expect(parseRoute(routePath(route)).route).toEqual(route)
  })

  test("settings groups list every section once, in the list's order; 팀 모드 (06 §9.8) is in the agent group", () => {
    expect(SETTINGS_SECTIONS).toEqual(SETTINGS_GROUPS.flatMap((group) => group.sections))
    // 03 §18.2 (WM 2026-10-19): 웹 검색 is in 모델·계정; 02 §4.9: 출력 상한 follows 자동 압축, before 웹 검색.
    // GH (2026-10-31): GitHub in 연결. CRM (2026-11-04): 확장 after 다른 도구의 대화; UPD (2026-11-04): 업데이트 last in 고급.
    // IS (2026-11-08): 이미지 만들기 has its own page after 웹 검색.
    expect(new Set(SETTINGS_SECTIONS).size).toBe(27)
    expect(SETTINGS_GROUPS.find((group) => group.id === "advanced")?.sections).toEqual(["plugins", "import", "creator", "updates"])
    expect(parseRoute("/settings/updates").route).toEqual({ name: "settings", section: "updates" })
    expect(parseRoute("/settings/creator").route).toEqual({ name: "settings", section: "creator" })
    expect(SETTINGS_GROUPS.find((group) => group.id === "models")?.sections).toEqual([
      "presets",
      "policy",
      "compaction",
      "output",
      "websearch",
      "image",
    ])
    expect(parseRoute("/settings/image").route).toEqual({ name: "settings", section: "image" })
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual(["basic", "models", "agent", "connect", "advanced"])
    expect(SETTINGS_GROUPS.find((group) => group.id === "agent")?.sections).toContain("team")
    // 10 §3.11: 에이전트 방식 (what each harness sends, 내 지시문) heads the agent group.
    expect(SETTINGS_GROUPS.find((group) => group.id === "agent")?.sections[0]).toBe("harness")
    // SM (2026-10-24): 스킬 and MCP 서버 have pages of their own right after 승인·권한.
    expect(SETTINGS_GROUPS.find((group) => group.id === "agent")?.sections).toEqual([
      "harness",
      "approval",
      "skills",
      "mcp",
      "team",
      "shell",
      "experimental",
      // BRW: 내 브라우저 사용 (실험) after 컴퓨터 사용 (실험).
      "browse",
    ])
    expect(parseRoute("/settings/browse").route).toEqual({ name: "settings", section: "browse" })
    expect(parseRoute("/settings/skills").route).toEqual({ name: "settings", section: "skills" })
    expect(SETTINGS_GROUPS.filter((group) => "accounts" in group).map((group) => group.id)).toEqual(["models"])
    expect(SETTINGS_SECTIONS).toContain("devices")
    expect(SETTINGS_SECTIONS).toContain("experimental")
    expect(parseRoute("/settings/team")).toEqual({ route: { name: "settings", section: "team" }, replace: undefined })
  })

  test("다른 도구의 대화 (09 §6) is a page under the project; a conversation is named by SourceRef tokens only", () => {
    const list: Route = { name: "import", serverKey: "local", projectID: "prj_1" }
    expect(routePath(list)).toBe("/srv/local/p/prj_1/import")
    expect(isPage(list)).toBe(true)
    expect(isPage({ ...list, ref: { kind: "codex", rootID: "codex-1", id: "t1" } })).toBe(true)
    expect(isPage({ name: "project", serverKey: "local", projectID: "prj_1" })).toBe(false)
    expect(routePath({ ...list, ref: { kind: "claude-code", rootID: "claude-1", id: "s1:agent-2" } })).toBe(
      "/srv/local/p/prj_1/import/claude-code/claude-1/s1%3Aagent-2",
    )
    // An unknown kind, a path-like part or a missing part leads to the list instead.
    for (const path of [
      "/srv/local/p/prj_1/import/cursor/r1/t1",
      "/srv/local/p/prj_1/import/codex/r1",
      "/srv/local/p/prj_1/import/codex/C%3A%5Cx/t1",
      "/srv/local/p/prj_1/import/codex/r1/..%2Fauth.json",
      `/srv/local/p/prj_1/import/codex/${"r".repeat(65)}/t1`,
    ])
      expect(parseRoute(path)).toEqual({ route: list, replace: "/srv/local/p/prj_1/import" })
    expect(parseRoute("/srv/local/p/prj_1/other").route).toEqual({ name: "home" })
  })

  test("settings 다른 도구 (09 §6) follows 플러그인", () => {
    expect(
      SETTINGS_SECTIONS.slice(SETTINGS_SECTIONS.indexOf("plugins"), SETTINGS_SECTIONS.indexOf("plugins") + 2),
    ).toEqual(["plugins", "import"])
    expect(parseRoute("/settings/import").route).toEqual({ name: "settings", section: "import" })
  })

  test("settings 팀 carries the team that openTeamSettings names, server first", () => {
    expect(routePath(teamSettingsRoute({}))).toBe("/settings/team")
    expect(teamSettingsRoute({ teamID: "tm_0123456789ab" })).toEqual({
      name: "settings",
      section: "team",
      team: { serverKey: "local", teamID: "tm_0123456789ab" },
    })
    expect(routePath(teamSettingsRoute({ serverKey: "lab", teamID: "tm_0123456789ab" }))).toBe(
      "/settings/team/lab/tm_0123456789ab",
    )
    expect(routePath(teamSettingsRoute({ serverKey: "lab" }))).toBe("/settings/team/lab")
    // Only settings 팀 takes a target; other sections keep their plain path.
    expect(routePath({ name: "settings", section: "general", team: { serverKey: "local" } })).toBe("/settings/general")
    expect(parseRoute("/settings/general/local").route).toEqual({ name: "home" })
    expect(parseRoute("/settings/team/local/tm_0123456789ab/extra").route).toEqual({ name: "home" })
  })
})
