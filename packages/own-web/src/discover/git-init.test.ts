// `Git 저장소로 만들기` (03 §4.3.1, 06 §3.0): the dialog's rules over plans as own.team answers them (the first commit on
// by default, the proposed .gitignore on where the folder has none and forced on when there would be too many files,
// large and binary files out unless picked, the identity asked only where git has none and never made up), the request
// it sends, a failure in plain words, and where the entry shows (`local` connections of a build with `git-init`, for a
// project that is not a Git repository: the project `⋯` and, since 2026-10-26, the conversation `⋯` under its note;
// the 기본 대화 폴더 says why it stays a plain folder and offers `프로젝트 폴더 열기…` instead). Team mode's notice for a
// repository without a first save point offers it.
// Solid components do not render under `bun test`; their wiring is checked in the source, as in discover.test.ts.
import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createRoot } from "solid-js"
import type { ServerRuntime } from "@/data"
import { createEventBus } from "@/data/events"
import { OwnRpcError } from "@/data/rpc"
import { TEAM_SCOPE, type TeamMethod, type TeamRpc } from "@/data/team-rpc"
import { defaultFolder } from "@/projects/default-folder"
import type { MenuItem } from "@/servers/menu"
import { createTeamStore } from "@/team/store"
import {
  canRun,
  confirmKey,
  defaults,
  failureText,
  insideParent,
  proposalOn,
  request,
  summary,
  visibleFlagged,
  visibleLargest,
  type Choices,
} from "./git-init-model"
import { gitInitEn, gitInitKo, gitInitText, type GitInitKey } from "./git-init-strings"
import { projectMenuExtras, sessionMenuExtras } from "./menus"
import { gitInitEntry, notGitFeatureNote } from "./model"
import { discoverKo } from "./strings"

const DIR = "D:/projects/binary-assets"
const MB = 1024 * 1024

const plan: OwnTeam.GitInitPlan = {
  directory: DIR,
  state: "none",
  branch: "main",
  identity: { name: "Demo User", email: "demo@example.invalid" },
  gitignore: { exists: false, proposal: "node_modules/\n" },
  files: {
    kind: "listed",
    total: { count: 10, bytes: 40 * MB },
    proposal: { count: 3, bytes: 6 * MB },
    proposalRequired: false,
    largest: [
      { path: "bios/BOARD.CAP", bytes: 32 * MB, binary: true, ignored: false },
      { path: "node_modules/big.bin", bytes: 5 * MB, binary: true, ignored: true },
      { path: "src/main.c", bytes: 1_000, binary: false, ignored: false },
    ],
    flagged: [
      { path: "bios/BOARD.CAP", bytes: 32 * MB, binary: true, ignored: false },
      { path: "node_modules/big.bin", bytes: 5 * MB, binary: true, ignored: true },
    ],
    flaggedMore: 0,
    nested: ["tools/UEFITool/"],
  },
  limits: { largeBytes: 10 * MB, binaryBytes: MB },
}

const say = (key: GitInitKey, params?: Record<string, string | number>) => gitInitText.text("ko", key, params)
const identity = { name: "", email: "" }
const choose = (changes: Partial<Choices>): Choices => ({ ...defaults(plan), ...changes })

describe("defaults and what the first commit takes", () => {
  test("first commit on, the proposal on, nothing flagged picked; the summary leaves the flagged files out", () => {
    const choices = defaults(plan)
    expect(choices).toEqual({ commit: true, gitignore: true, include: new Set() })
    expect(proposalOn(plan, choices)).toBe(true)
    // The proposal hides what it leaves out anyway.
    expect(visibleFlagged(plan, choices).map((item) => item.path)).toEqual(["bios/BOARD.CAP"])
    expect(visibleLargest(plan, choices).map((item) => item.path)).toEqual(["bios/BOARD.CAP", "src/main.c"])
    expect(summary(plan, choices)).toEqual({ count: 9, bytes: 8 * MB })
    expect(confirmKey(plan, choices)).toBe("own.gitInit.confirmCommit")
  })

  test("picking a flagged file takes it; the proposal off takes what it would leave out, its flagged files still out", () => {
    expect(summary(plan, choose({ include: new Set(["bios/BOARD.CAP"]) }))).toEqual({ count: 10, bytes: 40 * MB })
    const off = choose({ gitignore: false })
    expect(proposalOn(plan, off)).toBe(false)
    expect(visibleFlagged(plan, off)).toHaveLength(2)
    expect(summary(plan, off)).toEqual({ count: 11, bytes: 9 * MB })
  })

  test("too many files without the proposal keep it on; a folder's own .gitignore turns the proposal off", () => {
    const required = { ...plan, files: { ...plan.files, proposalRequired: true } } as OwnTeam.GitInitPlan
    expect(proposalOn(required, { ...defaults(required), gitignore: false })).toBe(true)
    const own = { ...plan, gitignore: { exists: true, proposal: "" } }
    expect(defaults(own).gitignore).toBe(false)
    expect(proposalOn(own, { ...defaults(own), gitignore: true })).toBe(false)
  })

  test("too many files: no first commit here, only the repository", () => {
    const many: OwnTeam.GitInitPlan = { ...plan, files: { kind: "too_many", count: 50_000, limit: 20_000 } }
    expect(defaults(many).commit).toBe(false)
    expect(summary(many, defaults(many))).toBeUndefined()
    expect(confirmKey(many, defaults(many))).toBe("own.gitInit.confirm")
    expect(request(many, { ...defaults(many), commit: true })).toEqual({ directory: DIR })
  })
})

describe("the request", () => {
  test("init only, or init with the first commit: the proposal and the picked flagged files that are shown", () => {
    expect(request(plan, choose({ commit: false }))).toEqual({ directory: DIR })
    expect(request(plan, choose({ include: new Set(["bios/BOARD.CAP", "node_modules/big.bin", "nope"]) }))).toEqual({
      directory: DIR,
      firstCommit: { gitignore: true, include: ["bios/BOARD.CAP"] },
    })
  })

  test("the identity is asked and sent only where git has none, and never made up", () => {
    const anonymous = { ...plan, identity: { name: null, email: null } }
    expect(canRun(anonymous, defaults(anonymous), identity)).toBe(false)
    expect(canRun(anonymous, defaults(anonymous), { name: "나", email: "no-at" })).toBe(false)
    expect(canRun(anonymous, defaults(anonymous), { name: "a\nb", email: "a@b" })).toBe(false)
    const typed = { name: " 나 데모 ", email: "demo@example.invalid" }
    expect(canRun(anonymous, defaults(anonymous), typed)).toBe(true)
    expect(request(anonymous, defaults(anonymous), typed).firstCommit?.identity).toEqual({
      name: "나 데모",
      email: "demo@example.invalid",
    })
    // Without a first commit no identity is needed.
    expect(canRun(anonymous, { ...defaults(anonymous), commit: false }, identity)).toBe(true)
    // git has one: nothing typed is sent.
    expect(request(plan, defaults(plan), typed).firstCommit?.identity).toBeUndefined()
  })

  test("a repository without a commit: only the first commit", () => {
    const unborn = { ...plan, state: "unborn" as const }
    expect(confirmKey(unborn, defaults(unborn))).toBe("own.gitInit.confirmFirst")
    expect(canRun(unborn, { ...defaults(unborn), commit: false }, identity)).toBe(false)
    expect(canRun(unborn, defaults(unborn), identity)).toBe(true)
  })
})

describe("failures in plain words", () => {
  test("each refusal and error of the two methods", () => {
    const refused = (why: string, parent: string | null = null) =>
      new OwnRpcError("git_init_refused", "refused", { why, parent })
    expect(failureText(say, refused("inside", "D:/projects"))).toBe(
      "이 폴더는 다른 Git 저장소 안에 있어요: D:/projects. 그 저장소를 프로젝트로 여세요.",
    )
    expect(insideParent(refused("inside", "D:/projects"))).toBe("D:/projects")
    expect(insideParent(refused("system"))).toBeUndefined()
    expect(failureText(say, refused("system"))).toBe(gitInitKo["own.gitInit.refused.system"])
    expect(failureText(say, refused("exists"))).toBe(gitInitKo["own.gitInit.refused.exists"])
    expect(failureText(say, refused("busy"))).toBe(gitInitKo["own.gitInit.refused.busy"])
    expect(failureText(say, refused("too_many"))).toBe(gitInitKo["own.gitInit.refused.tooMany"])
    expect(failureText(say, new OwnRpcError("identity_missing", "x", {}))).toBe(
      gitInitKo["own.gitInit.identityMissing"],
    )
    expect(failureText(say, new OwnRpcError("git_too_old", "x", { version: "2.39.0", minimum: "2.40" }))).toBe(
      "Git 2.39.0은 너무 오래되었어요. 2.40 이상이 필요해요.",
    )
    expect(failureText(say, new OwnRpcError("git_too_old", "x", { version: "", minimum: "2.40" }))).toBe(
      gitInitKo["own.gitInit.gitMissing"],
    )
    expect(
      failureText(say, new OwnRpcError("git_failed", "x", { step: "commit", message: "pre-commit hook failed" })),
    ).toBe("Git이 실패해서 이번에 만든 것은 되돌렸어요: pre-commit hook failed")
    expect(failureText(say, new Error("offline"))).toBe("만들지 못했어요: Error: offline")
  })

  test("the default branch takes its particle", () => {
    expect(say("own.gitInit.what", { branch: "main" })).toContain("기본 브랜치를 main으로 정해요")
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Where the entry shows

const PLAIN = "prj_plain"
const GIT = "prj_git"
const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function store(input: { readonly features?: readonly string[]; readonly allowed?: (method: TeamMethod) => boolean }) {
  const bus = createEventBus()
  const answers: Partial<Record<TeamMethod, () => unknown>> = {
    health: () => ({ version: "2.0.24-own.2", buildId: "b1", guard: "ok", features: input.features ?? [] }),
    "team.list": () => ({ teams: [] }),
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

/** The service's 기본 대화 폴더 in these fakes (03 §5.1); a test passes {@link DIR} to make the plain project it. */
const FOLDER = "C:\\Users\\me\\Documents\\Own OpenCode"

/** Conversations of these fakes: a root and a subagent's in the plain project, a root in the Git one. */
const SESSIONS: Record<string, { readonly projectID: string; readonly parentID?: string }> = {
  ses_plain: { projectID: PLAIN },
  ses_sub: { projectID: PLAIN, parentID: "ses_plain" },
  ses_git: { projectID: GIT },
}

function runtime(teams: ReturnType<typeof store>, folder = FOLDER) {
  const projects: Record<string, { canonical: string; vcs?: string }> = {
    [PLAIN]: { canonical: DIR },
    [GIT]: { canonical: "D:/demo/space-game", vcs: "git" },
  }
  // SAFETY: the discover rules read only the team store, the project and session data, the scopes and the default
  // folder.
  return {
    key: "local",
    team: teams,
    rpc: {
      can: () => true,
      allowed: () => true,
      call: async () => ({ path: folder, defaultPath: folder, custom: false, exists: true }),
    },
    connection: { status: () => "connected" },
    own: { on: () => () => undefined },
    data: {
      project: { get: (id: string) => projects[id] },
      session: { get: (id: string) => SESSIONS[id] },
      location: { vcs: { info: () => undefined } },
    },
    sessions: { state: { sessions: {}, projects: {} } },
  } as unknown as ServerRuntime
}

const labels = (items: readonly MenuItem[]) =>
  items.map((item) => (item === "separator" ? "—" : "note" in item ? `note:${item.note}` : item.label))
const testids = (items: readonly MenuItem[]) => items.flatMap((item) => (item === "separator" ? [] : [item.testid]))

describe("the entry (03 §4.3.1)", () => {
  test("a project that is not a Git repository, on a connection with `local`, where own.team has `git-init`", async () => {
    const teams = store({ features: ["enable", "git-init"] })
    await teams.resync()
    const current = runtime(teams)
    expect(gitInitEntry(current, { projectID: PLAIN, directory: DIR })).toBe(DIR)
    expect(gitInitEntry(current, { projectID: GIT, directory: "D:/demo/space-game" })).toBeUndefined()
    expect(gitInitEntry(current, { projectID: "prj_unknown", directory: DIR })).toBeUndefined()
    expect(gitInitEntry(current, { projectID: PLAIN, directory: undefined })).toBeUndefined()
    const menu = projectMenuExtras(
      { runtime: current, serverKey: "local", projectID: PLAIN, locale: "ko", navigate: () => undefined },
      DIR,
    )
    expect(labels(menu)).toEqual([`note:${discoverKo["own.discover.notGit.both"]}`, "Git 저장소로 만들기…"])
  })

  test("none on a gateway device (no `local`) or a build without `git-init`; `project.gitInit*` are `local`", async () => {
    expect(TEAM_SCOPE["project.gitInit"]).toBe("local")
    expect(TEAM_SCOPE["project.gitInit.plan"]).toBe("local")
    const phone = store({ features: ["enable", "git-init"], allowed: (method) => TEAM_SCOPE[method] !== "local" })
    await phone.resync()
    expect(gitInitEntry(runtime(phone), { projectID: PLAIN, directory: DIR })).toBeUndefined()
    const old = store({ features: ["enable"] })
    await old.resync()
    expect(gitInitEntry(runtime(old), { projectID: PLAIN, directory: DIR })).toBeUndefined()
  })

  test("never for the default conversation folder: its note says why and the menu offers to open a project folder", async () => {
    const teams = store({ features: ["enable", "git-init"] })
    await teams.resync()
    const current = runtime(teams, DIR)
    await defaultFolder(current).load()
    expect(gitInitEntry(current, { projectID: PLAIN, directory: DIR })).toBeUndefined()
    const menu = projectMenuExtras(
      { runtime: current, serverKey: "local", projectID: PLAIN, locale: "ko", navigate: () => undefined },
      DIR,
    )
    expect(labels(menu)).toEqual([`note:${discoverKo["own.discover.defaultFolder.both"]}`, "프로젝트 폴더 열기…"])
    expect(testids(menu)).toEqual(["menu-not-git", "menu-open-folder"])
    // The dimmed `[팀]` and `⑂` buttons and their palette commands say the same; another folder keeps the usual words.
    expect(notGitFeatureNote(current, { projectID: PLAIN, directory: DIR }, "team")).toBe(
      "own.discover.defaultFolder.team",
    )
    expect(notGitFeatureNote(current, { projectID: PLAIN, directory: DIR }, "worktree")).toBe(
      "own.discover.defaultFolder.worktree",
    )
    expect(notGitFeatureNote(runtime(teams), { projectID: PLAIN, directory: DIR }, "team")).toBe(
      "own.discover.notGit.team",
    )
  })
})

describe("the conversation `⋯` (sessionMenuExtras, 2026-10-26)", () => {
  test("a root conversation in a folder that is not a Git repository: the note, then `Git 저장소로 만들기…`", async () => {
    const teams = store({ features: ["enable", "git-init"] })
    await teams.resync()
    const current = runtime(teams)
    const menu = sessionMenuExtras(current, "local", "ko", "ses_plain")
    expect(labels(menu)).toEqual(["—", `note:${discoverKo["own.discover.notGit.both"]}`, "Git 저장소로 만들기…"])
    expect(testids(menu)).toEqual(["session-menu-not-git", "session-menu-git-init"])
    // A subagent's conversation, a conversation in a Git project and an unknown one get nothing.
    expect(sessionMenuExtras(current, "local", "ko", "ses_sub")).toEqual([])
    expect(sessionMenuExtras(current, "local", "ko", "ses_git")).toEqual([])
    expect(sessionMenuExtras(current, "local", "ko", "ses_unknown")).toEqual([])
  })

  test("the note alone on a gateway device (no `local`) and on a build without `git-init`", async () => {
    const phone = store({ features: ["enable", "git-init"], allowed: (method) => TEAM_SCOPE[method] !== "local" })
    await phone.resync()
    expect(labels(sessionMenuExtras(runtime(phone), "local", "ko", "ses_plain"))).toEqual([
      "—",
      `note:${discoverKo["own.discover.notGit.both"]}`,
    ])
    const old = store({ features: ["enable"] })
    await old.resync()
    expect(labels(sessionMenuExtras(runtime(old), "local", "ko", "ses_plain"))).toEqual([
      "—",
      `note:${discoverKo["own.discover.notGit.both"]}`,
    ])
  })

  test("a conversation in the default conversation folder: why it stays a plain folder, and `프로젝트 폴더 열기…`", async () => {
    const teams = store({ features: ["enable", "git-init"] })
    await teams.resync()
    const current = runtime(teams, DIR)
    await defaultFolder(current).load()
    const menu = sessionMenuExtras(current, "local", "ko", "ses_plain")
    expect(labels(menu)).toEqual(["—", `note:${discoverKo["own.discover.defaultFolder.both"]}`, "프로젝트 폴더 열기…"])
    expect(testids(menu)).toEqual(["session-menu-not-git", "session-menu-open-folder"])
  })
})

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, "..", file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("wiring", () => {
  test("the dimmed buttons, the menu, the palette and the hints open the dialog; the shell mounts its host", async () => {
    const actions = await code("discover/project-actions.tsx")
    expect(actions).toContain('notGitItems("team")')
    expect(actions).toContain('notGitItems("worktree")')
    expect(actions).toContain('testid: "project"')
    expect(actions.match(/(?<!data-)state="not-git"/g)).toHaveLength(2)
    const menus = await code("discover/menus.ts")
    expect(menus).toContain("testid: `${input.testid}-git-init`")
    expect(menus).toContain('testid: "menu",')
    expect(menus).toContain('testid: "session-menu" })')
    expect(await code("shell/session-menu.tsx")).toContain(
      "...sessionMenuExtras(runtime, serverKey, i18n.locale(), sessionID)",
    )
    expect(await code("shell/palette-commands.tsx")).toContain('id: "project.gitInit"')
    expect(await code("discover/hints.tsx")).toContain('testid: "discover-hints"')
    expect(await code("shell/app-shell.tsx")).toContain("<GitInitHost />")
    // The dialog chunk loads only when asked for.
    expect(await code("discover/git-init.tsx")).toContain('lazy(() => import("./git-init-dialog"))')
  })

  test("team mode's notice for a repository without a first save point offers the dialog", async () => {
    const enable = await code("team/enable.ts")
    expect(enable).toContain('deps.text("own.team.enable.unborn")')
    expect(enable).toContain("openGitInit({\n                  serverKey: request.serverKey,\n                  directory,")
    // Started from a conversation, the dialog's `팀 모드 켜기…` starts from it again.
    expect(enable).toContain("...(request.sessionID ? { sessionID: request.sessionID } : {}),")
  })

  test("after it, the project and the folder's VCS info are read again and `팀 모드 켜기…` is offered", async () => {
    const dialog = await code("discover/git-init-dialog.tsx")
    expect(dialog).toContain("current.data.project.invalidate()")
    expect(dialog).toContain("current.data.location.syncInfo(location)")
    expect(dialog).toContain("canEnableTeam(current,")
    expect(dialog).toContain('data-testid="git-init-enable-team"')
  })

  test("no Korean text in the code: all copy comes from the catalogs", async () => {
    for (const file of [
      "discover/git-init.tsx",
      "discover/git-init-dialog.tsx",
      "discover/git-init-model.ts",
      "discover/project-actions.tsx",
      "discover/hints.tsx",
      "discover/menus.ts",
      "discover/model.ts",
    ])
      expect((await code(file)).match(/[\uAC00-\uD7A3]+/g) ?? [], file).toEqual([])
  })
})

describe("catalog", () => {
  const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted()

  test("English for every key, with the same placeholders", () => {
    expect(Object.keys(gitInitEn).toSorted()).toEqual(Object.keys(gitInitKo).toSorted())
    for (const [key, value] of Object.entries(gitInitKo))
      expect(params(gitInitEn[key as GitInitKey]), key).toEqual(params(value))
  })
})
