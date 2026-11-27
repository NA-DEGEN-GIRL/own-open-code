// Discoverability entry points (03 §4.3.1) over a real TeamStore, the real event bus and a fake own.team client:
// - the project row's `팀` button: the team view for a team that is on, `팀 모드 켜기` where it can start, a "Git
//   저장소에서만" explanation for a project that is not a Git repository, and nothing where this connection cannot
//   enable (no `enable` feature, a device without `admin`) or before the project list and own.team's health answered;
// - the `⑂` button: the worktree menu for a Git project, the explanation otherwise, nothing for a device without
//   `prompt` or a project with a team on; its items (each worktree, new worktree, move only for this project's root
//   conversation);
// - the menu additions of the project and session `⋯`, the first-run hints' `닫기`, the settings entry points and the
//   palette words; the catalog has English for every key.
// Solid components do not render under `bun test` (JSX compiles for React here); their wiring is checked in the source,
// and e2e renders them.
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { createRoot } from "solid-js"
import type { ServerRuntime } from "@/data"
import { createEventBus } from "@/data/events"
import { TEAM_SCOPE, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import type { MenuItem } from "@/servers/menu"
import { createTeamStore } from "@/team/store"
import { loadWorktrees } from "@/worktree/state"
import { joinGroups, projectMenuExtras, sessionMenuExtras, worktreeMenuItems, type MenuContext } from "./menus"
import { hintsClosed, notGitNote, setHintsClosed, teamEntry, worktreeEntry } from "./model"
import { discoverEn, discoverKo, discoverText } from "./strings"

const TEAM = "tm_0123456789ab"
const HOME = "D:/demo/space-game"
const GIT = "prj_git"
const PLAIN = "prj_plain"
const TEAMED = "prj_team"

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

const team = Schema.decodeUnknownSync(OwnTeam.Team)({
  id: TEAM,
  projectID: TEAMED,
  commonDir: "D:/demo/shop/.git",
  target: "main",
  state: "on",
  rev: 7,
  home: { directory: "D:/demo/shop", linked: true, chosenBy: "session" },
  main: { sessionID: "ses_main", previous: [] },
  worktreeRoot: "D:/demo/shop-team",
  heavy: { dirs: [], measuredAt: null, forcedBytes: 0 },
  shared: [],
  commands: { setup: null, code: [], assets: [] },
  env: { symlinkFix: "none", bunCache: "same-volume", lfs: "unused" },
  external: [],
  policy: OwnTeam.POLICY,
  patterns: [],
})

/** A TeamStore over a fake own.team: `features` from health, `allowed` the connection's scopes, one team on. */
function store(
  input: { features?: readonly string[]; allowed?: (method: TeamMethod) => boolean; teams?: boolean } = {},
) {
  const bus = createEventBus()
  const answers: Partial<Record<TeamMethod, () => unknown>> = {
    health: () => ({ version: "2.0.24-own.2", buildId: "b1", guard: "ok", features: input.features ?? ["enable"] }),
    "team.list": () => ({
      teams:
        input.teams === false ? [] : [{ id: TEAM, projectID: TEAMED, home: "D:/demo/shop", state: "on", areas: 0 }],
    }),
    "team.get": () => ({ team, areas: [], waiting: {}, op: null, pending: [] }),
  }
  const rpc: TeamRpc = {
    allowed: input.allowed ?? (() => true),
    scope: (method) => TEAM_SCOPE[method],
    // SAFETY: every answer above has its method's output shape.
    call: async (method) => answers[method]?.() as never,
  }
  const root = createRoot((dispose) => ({ dispose, store: createTeamStore({ rpc, bus, reloadMs: 1 }) }))
  cleanups.push(() => {
    root.store.dispose()
    root.dispose()
    bus.dispose()
  })
  return root.store
}

interface Fixture {
  readonly projects?: Record<string, { readonly canonical: string; readonly vcs?: string }>
  readonly sessions?: Record<string, { readonly projectID: string; readonly parentID?: string }>
  readonly prompt?: boolean
  readonly worktrees?: ReadonlyArray<{ readonly directory: string }>
}

const PROJECTS: NonNullable<Fixture["projects"]> = {
  [GIT]: { canonical: HOME, vcs: "git" },
  [PLAIN]: { canonical: "D:/demo/notes" },
  [TEAMED]: { canonical: "D:/demo/shop", vcs: "git" },
}

function runtime(teamStore: ReturnType<typeof store>, fixture: Fixture = {}) {
  const projects = fixture.projects ?? PROJECTS
  const sessions = fixture.sessions ?? {}
  // SAFETY: the discover rules read only the team store, the project and session data, the worktree list and scopes.
  return {
    key: "local",
    team: teamStore,
    rpc: {
      can: (scope: string) => scope !== "prompt" || fixture.prompt !== false,
      // No default conversation folder on this fake service (03 §5.1): an older build.
      allowed: () => false,
    },
    connection: { status: () => "connected" },
    own: { on: () => () => undefined },
    data: {
      project: { get: (id: string) => projects[id] },
      session: { get: (id: string) => sessions[id] },
      location: { vcs: { info: () => undefined } },
    },
    sessions: { state: { sessions: {}, projects: {} } },
    bus: { on: () => () => undefined },
    client: () => ({ worktree: { list: async () => fixture.worktrees ?? [] } }),
  } as unknown as ServerRuntime
}

const labels = (items: readonly MenuItem[]) =>
  items.map((item) => (item === "separator" ? "—" : "note" in item ? `note:${item.note}` : item.label))

const context = (current: ServerRuntime, projectID: string, sessionID?: string): MenuContext => ({
  runtime: current,
  serverKey: "local",
  projectID,
  locale: "ko",
  navigate: () => undefined,
  ...(sessionID ? { sessionID } : {}),
})

describe("the project row's team button (03 §4.3.1)", () => {
  test("a team that is on, team mode that can start, a project that is not a Git repository", async () => {
    const teams = store()
    await teams.resync()
    const current = runtime(teams)
    expect(teamEntry(current, { projectID: TEAMED, directory: "D:/demo/shop" })).toEqual({ kind: "view" })
    expect(teamEntry(current, { projectID: GIT, directory: HOME })).toEqual({ kind: "enable", directory: HOME })
    expect(teamEntry(current, { projectID: PLAIN, directory: "D:/demo/notes" })).toEqual({ kind: "notGit" })
  })

  test("nothing before the project list or own.team's health, without `enable`, or on a device without `admin`", async () => {
    const before = store()
    expect(teamEntry(runtime(before), { projectID: PLAIN, directory: "D:/demo/notes" })).toBeUndefined()

    const teams = store({ teams: false })
    await teams.resync()
    expect(teamEntry(runtime(teams, { projects: {} }), { projectID: GIT, directory: HOME })).toBeUndefined()

    const old = store({ features: ["pause"], teams: false })
    await old.resync()
    expect(teamEntry(runtime(old), { projectID: PLAIN, directory: "D:/demo/notes" })).toBeUndefined()
    expect(teamEntry(runtime(old), { projectID: GIT, directory: HOME })).toBeUndefined()

    const phone = store({ allowed: (method) => TEAM_SCOPE[method] === "read" })
    await phone.resync()
    expect(teamEntry(runtime(phone), { projectID: PLAIN, directory: "D:/demo/notes" })).toBeUndefined()
    expect(teamEntry(runtime(phone), { projectID: GIT, directory: HOME })).toBeUndefined()
    // Viewing a team needs no scope.
    expect(teamEntry(runtime(phone), { projectID: TEAMED, directory: "D:/demo/shop" })).toEqual({ kind: "view" })
  })
})

describe("the project row's `⑂` button (03 §4.3.1, 19.3)", () => {
  test("the menu for a Git project, the explanation for the others, nothing for a team or a device without prompt", async () => {
    const teams = store()
    await teams.resync()
    const current = runtime(teams)
    expect(worktreeEntry(current, GIT)).toBe("menu")
    expect(worktreeEntry(current, PLAIN)).toBe("notGit")
    expect(worktreeEntry(current, TEAMED)).toBeUndefined()
    expect(worktreeEntry(current, "prj_unknown")).toBeUndefined()
    expect(worktreeEntry(runtime(teams, { prompt: false }), GIT)).toBeUndefined()
    expect(worktreeEntry(runtime(teams, { prompt: false }), PLAIN)).toBeUndefined()
  })

  test("each worktree, a new worktree, and moving only this project's root conversation", async () => {
    const teams = store({ teams: false })
    await teams.resync()
    const current = runtime(teams, {
      worktrees: [{ directory: HOME }, { directory: "D:/demo/space-game-wt/calm-otter" }],
      sessions: {
        ses_here: { projectID: GIT },
        ses_child: { projectID: GIT, parentID: "ses_here" },
        ses_other: { projectID: PLAIN },
      },
    })
    expect(labels(worktreeMenuItems(context(current, GIT)))).toEqual([
      `note:${discoverKo["own.discover.worktree.about"]}`,
      "note:작업 폴더를 읽는 중…",
      "—",
      "새 작업 폴더에서 새 대화",
    ])
    loadWorktrees(current, "local", GIT)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(labels(worktreeMenuItems(context(current, GIT, "ses_here")))).toEqual([
      `note:${discoverKo["own.discover.worktree.about"]}`,
      "⑂ calm-otter에서 새 대화",
      "—",
      "새 작업 폴더에서 새 대화",
      "다른 작업 폴더로 옮기기…",
    ])
    expect(labels(worktreeMenuItems(context(current, GIT, "ses_child")))).not.toContain("다른 작업 폴더로 옮기기…")
    expect(labels(worktreeMenuItems(context(current, GIT, "ses_other")))).not.toContain("다른 작업 폴더로 옮기기…")
  })

  test("no worktree yet says so", async () => {
    const teams = store({ teams: false })
    await teams.resync()
    const current = runtime(teams, { projects: { prj_empty: { canonical: "D:/demo/empty", vcs: "git" } } })
    loadWorktrees(current, "local", "prj_empty")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(labels(worktreeMenuItems(context(current, "prj_empty")))).toContain("note:아직 작업 폴더가 없어요")
  })
})

describe("the `⋯` additions (03 §4.3.1)", () => {
  test("not Git: one note naming what is missing; Git outside a team: a new session in a new worktree", async () => {
    const teams = store()
    await teams.resync()
    const current = runtime(teams, {
      sessions: { ses_plain: { projectID: PLAIN }, ses_sub: { projectID: PLAIN, parentID: "ses_plain" } },
    })
    expect(notGitNote(current, { projectID: PLAIN, directory: "D:/demo/notes" })).toBe("own.discover.notGit.both")
    expect(labels(projectMenuExtras(context(current, PLAIN), "D:/demo/notes"))).toEqual([
      `note:${discoverKo["own.discover.notGit.both"]}`,
    ])
    expect(labels(projectMenuExtras(context(current, GIT), HOME))).toEqual(["새 작업 폴더에서 새 대화"])
    expect(projectMenuExtras(context(current, TEAMED), "D:/demo/shop")).toEqual([])
    expect(labels(sessionMenuExtras(current, "local", "ko", "ses_plain"))).toEqual([
      "—",
      `note:${discoverKo["own.discover.notGit.both"]}`,
    ])
    expect(sessionMenuExtras(current, "local", "ko", "ses_sub")).toEqual([])
  })

  test("the note names only what this connection could otherwise do", async () => {
    const old = store({ features: [], teams: false })
    await old.resync()
    expect(notGitNote(runtime(old), { projectID: PLAIN, directory: "D:/demo/notes" })).toBe(
      "own.discover.notGit.worktree",
    )
    const teams = store()
    await teams.resync()
    expect(notGitNote(runtime(teams, { prompt: false }), { projectID: PLAIN, directory: "D:/demo/notes" })).toBe(
      "own.discover.notGit.team",
    )
    expect(
      notGitNote(runtime(old, { prompt: false }), { projectID: PLAIN, directory: "D:/demo/notes" }),
    ).toBeUndefined()
  })

  test("groups are separated only between groups that have items", () => {
    const a: MenuItem = { label: "a", onSelect: () => undefined }
    const b: MenuItem = { note: "b" }
    expect(labels(joinGroups([a], [], [b]))).toEqual(["a", "—", "note:b"])
    expect(labels(joinGroups([], [b]))).toEqual(["note:b"])
    expect(joinGroups([], [])).toEqual([])
  })
})

describe("first-run hints (03 §4.3.1)", () => {
  test("`안내 닫기` is remembered in this browser profile and the palette brings them back", () => {
    setHintsClosed(false)
    expect(hintsClosed()).toBe(false)
    setHintsClosed(true)
    expect(hintsClosed()).toBe(true)
    expect(localStorage.getItem("own.web.discover.hints")).toBe("closed")
    setHintsClosed(false)
    expect(localStorage.getItem("own.web.discover.hints")).toBeNull()
  })
})

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, "..", file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("wiring (03 §4.3.1)", () => {
  test("settings: a labelled footer button, a header button on every screen, Ctrl+, and `설정 열기` in the palette", async () => {
    const sidebar = await code("sidebar/index.tsx")
    expect(sidebar).toContain('data-testid="sidebar-settings"')
    expect(sidebar).toMatch(/<Icon name="gear" \/>\s*\{i18n\.t\("own\.nav\.settings"\)\}/)
    const header = await code("shell/header.tsx")
    expect(header).toContain("<SettingsButton />")
    // Not inside a route-dependent <Show>: the header button is there on every screen.
    expect(
      header.slice(
        header.lastIndexOf("<Show", header.indexOf("<SettingsButton />")),
        header.indexOf("<SettingsButton />"),
      ),
    ).toContain("</Show>")
    expect(await code("shell/shortcuts.tsx")).toContain('useShortcut("settings.open"')
    const builtin = await code("palette/builtin.ts")
    expect(builtin).toContain('id: "settings.open"')
    expect(builtin).toContain('shortcut: "settings.open"')
  })

  test("설정, 한도 and 계정 toggle their page (2026-10-18): pressed while it is open, the same button closes it", async () => {
    const sidebar = await code("sidebar/index.tsx")
    for (const [id, route, pressed] of [
      ["sidebar-settings", '{ name: "settings", section: "general", list: true }', 'route().name === "settings"'],
      ["sidebar-limits", '{ name: "limits" }', 'route().name === "limits"'],
      ["sidebar-accounts", '{ name: "accounts" }', 'route().name === "accounts" || route().name === "accountsAdd"'],
    ] as const) {
      const button = sidebar.slice(sidebar.lastIndexOf("<button", sidebar.indexOf(`data-testid="${id}"`)))
      const open = button.slice(0, button.indexOf("</button>"))
      expect(open).toContain(`aria-pressed={${pressed}}`)
      expect(open).toContain(`onClick={() => shell.togglePage(${route})}`)
    }
    const header = await code("discover/settings-button.tsx")
    expect(header).toContain('aria-pressed={router.route().name === "settings"}')
    expect(header).toContain('shell.togglePage({ name: "settings", section: "general", list: true })')
    const context = await code("shell/context.tsx")
    const toggle = context.slice(context.indexOf("function togglePage("), context.indexOf("router.navigate(page)"))
    expect(toggle).toContain("return returnToWorkspace()")
  })

  test("the project row mounts the quick actions; the menus add the notes; the empty screen shows the hints", async () => {
    expect(await code("sidebar/rows.tsx")).toContain("<ProjectActions")
    expect(await code("sidebar/project-menu.tsx")).toContain("projectMenuExtras(context, props.directory)")
    expect(await code("shell/session-menu.tsx")).toContain(
      "...sessionMenuExtras(runtime, serverKey, i18n.locale(), sessionID)",
    )
    expect(await code("shell/pane.tsx")).toContain("<DiscoverHints serverKey={props.serverKey} />")
  })

  test("palette: Korean words on the team and worktree commands, `팀 보기`, the not-Git explanations", async () => {
    const palette = await code("shell/palette-commands.tsx")
    for (const word of ['"팀 모드"', '"작업 폴더"', '"워크트리"']) expect(palette).toContain(word)
    for (const id of ['"team.view"', '"team.notGit"', '"worktree.notGit"', '"discover.hints"'])
      expect(palette).toContain(`id: ${id}`)
  })

  test("the new components hold no Korean text of their own: all copy comes from discover/strings.ts", async () => {
    for (const file of [
      "discover/project-actions.tsx",
      "discover/hints.tsx",
      "discover/settings-button.tsx",
      "discover/menus.ts",
      "discover/model.ts",
    ])
      expect((await code(file)).match(/[\uAC00-\uD7A3]+/g) ?? [], file).toEqual([])
  })
})

describe("catalog", () => {
  const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted()

  test("English for every key, with the same placeholders", () => {
    const english = discoverEn as Record<string, string | undefined>
    for (const [key, value] of Object.entries(discoverKo)) {
      expect(english[key], key).toBeDefined()
      expect(params(english[key]!), key).toEqual(params(value))
    }
  })

  test("Korean particles follow the project name", () => {
    expect(discoverText.text("ko", "own.discover.hints.notGit", { project: "notes" })).toStartWith("notes는 ")
    expect(discoverText.text("ko", "own.discover.hints.notGit", { project: "메모장" })).toStartWith("메모장은 ")
  })
})
