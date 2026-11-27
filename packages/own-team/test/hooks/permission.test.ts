// own.team's permission `evaluate` hook at plugin level (06 §4.9, §10.1, TG6; 07 §2.4, PG10 own.team side): the hook
// as the plugin registers it tightens only. An incoming deny is never changed (own.accounts' read-only deny of an
// `explore` subagent stays, even for a command that needs no question); lowering reaches every session of an area
// folder and the main's tree in `ask` and `full` alike; raising reaches only the registered main and owner ids while
// the team's `autoAllow` is on. The F2 part checks the heavy-folder deny and the hook's p95 (≤ 50 ms).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import { Guard } from "../../src/assets/guard.js"
import { ShellRules } from "../../src/assets/shell-rules.js"
import { Worktree } from "../../src/git/worktree.js"
import type { Services } from "../../src/services.js"
import { Singleton } from "../../src/singleton.js"
import { F2_HEAVY, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { temp } from "../fixtures/repo.js"
import {
  MAIN_SESSION,
  OLD_OWNER,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area as areaRecord,
  boot,
  buildId,
  managedEnv,
  team as teamRecord,
  tempHome,
} from "../support/context.js"

const SLOW = 180_000
const CHILD = SessionID.make("ses_child000000000000000000001")
const PLAIN_OWNER = SessionID.make("ses_plainowner000000000000001")
const STRANGER = SessionID.make("ses_stranger00000000000000001")

const restore = managedEnv()
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  restore()
})

type Evaluate = (event: PermissionEvaluation) => Promise<void>

async function booted(directory: string) {
  const home = await tempHome()
  const world = new World()
  const id = buildId("permission")
  const fake = await boot(world, {
    directory,
    options: { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" },
  })
  cleanups.push(async () => {
    await fake.cleanup()
    await home[Symbol.asyncDispose]()
  })
  const services = Singleton.peek(id)!.controller.services
  // SAFETY (test): the fake keeps each registered hook callback; this one takes a permission evaluation.
  const evaluate = fake.hooks.get("permission.evaluate")![0] as unknown as Evaluate
  return { world, services, evaluate }
}

function event(
  sessionID: SessionID,
  action: string,
  resources: ReadonlyArray<string>,
  effect: PermissionEvaluation["effect"],
): PermissionEvaluation {
  return { sessionID, action, resources, effect }
}

describe("shell rules through the registered hook", () => {
  const box = temp()
  afterAll(() => box.dispose())
  const homeDir = path.join(box.root, "home")
  const codeDir = path.join(box.root, "home-team", "code-area")
  const plainDir = path.join(box.root, "home-team", "plain-area")
  const elsewhere = path.join(box.root, "elsewhere")
  for (const dir of [homeDir, codeDir, plainDir, elsewhere]) fs.mkdirSync(dir, { recursive: true })
  const team: OwnTeam.Team = {
    ...teamRecord({ home: homeDir }),
    heavy: { dirs: [...F2_HEAVY], measuredAt: null, forcedBytes: 0 },
    commands: {
      setup: { shell: "bun install && bun run build" },
      code: [{ argv: ["bun", "run", "typecheck"] }],
      assets: [],
    },
  }
  const code: OwnTeam.Area = { ...areaRecord({ slug: "code-area", directory: codeDir }), shape: "code" }
  const plain: OwnTeam.Area = {
    ...areaRecord({ slug: "plain-area", directory: plainDir }),
    owner: { sessionID: PLAIN_OWNER, previous: [], attached: true },
  }
  const state: { evaluate?: Evaluate; services?: Services.Context } = {}

  beforeAll(async () => {
    const h = await booted(homeDir)
    for (const [id, directory] of [
      [OWNER_SESSION, codeDir],
      [CHILD, codeDir],
      [OLD_OWNER, codeDir],
      [PLAIN_OWNER, plainDir],
      [MAIN_SESSION, homeDir],
      [STRANGER, elsewhere],
    ] as const)
      h.world.sessions.set(id, { id, directory, permissions: [] })
    state.evaluate = h.evaluate
    state.services = h.services
  })

  /** The effect (and message) the hook leaves for one shell command line split into its simple commands. */
  async function shell(sessionID: SessionID, resources: ReadonlyArray<string>, effect: PermissionEvaluation["effect"]) {
    const item = event(sessionID, "shell", resources, effect)
    await state.evaluate!(item)
    return { effect: item.effect, message: item.message }
  }
  const put = (record: OwnTeam.Team) => state.services!.write(TEAM_ID, () => state.services!.registry.teams.put(record))

  test("no team, a team that is off, and sessions outside the team stay as they are", async () => {
    expect(await shell(OWNER_SESSION, ["git push"], "allow")).toEqual({ effect: "allow", message: undefined })
    await state.services!.write(TEAM_ID, async () => {
      await state.services!.registry.teams.put({ ...team, state: "off" })
      await state.services!.registry.areas.put(code)
      await state.services!.registry.areas.put(plain)
    })
    expect((await shell(OWNER_SESSION, ["git push"], "allow")).effect).toBe("allow")
    await put(team)
    expect((await shell(STRANGER, ["git push"], "allow")).effect).toBe("allow")
    expect((await shell(OWNER_SESSION, ["git push"], "allow")).effect).toBe("ask")
  })

  test("an incoming deny is never changed, whatever the command (07 §2.4, PG10)", async () => {
    await put(team)
    for (const sessionID of [OWNER_SESSION, CHILD, MAIN_SESSION])
      for (const command of ["git push", "bun run typecheck", "git status", "git sparse-checkout disable"])
        expect(await shell(sessionID, [command], "deny")).toEqual({ effect: "deny", message: undefined })
  })

  test("code-only area: whole-store LFS commands ask, cone-wide sparse commands are denied (in ask and full)", async () => {
    await put(team)
    for (const effect of ["allow", "ask"] as const) {
      for (const command of [
        "git lfs pull",
        "git lfs pull -I Assets/Textures",
        "git lfs fetch",
        "git lfs fetch --all",
        "git lfs fetch origin main",
        "git lfs checkout",
        "git-lfs pull",
      ])
        expect(await shell(CHILD, [command], effect)).toEqual({ effect: "ask", message: ShellRules.LFS_MESSAGE })
      for (const command of ["git sparse-checkout disable", "git sparse-checkout set src", "git sparse-checkout init"])
        expect(await shell(CHILD, [command], effect)).toEqual({ effect: "deny", message: ShellRules.SPARSE_MESSAGE })
    }
    expect((await shell(CHILD, ['git lfs fetch -I "Assets/Textures/**"'], "allow")).effect).toBe("allow")
    expect((await shell(CHILD, ["git lfs fetch --include=Content/**"], "allow")).effect).toBe("allow")
    expect((await shell(CHILD, ["git sparse-checkout list"], "allow")).effect).toBe("allow")
    // A full folder area has every file already.
    expect((await shell(PLAIN_OWNER, ["git lfs pull"], "allow")).effect).toBe("allow")
    expect((await shell(PLAIN_OWNER, ["git sparse-checkout disable"], "allow")).effect).toBe("allow")
  })

  test("every team session asks for commands that lose work, publish or change worktrees", async () => {
    await put(team)
    const risky = [
      "git push origin main",
      "git worktree remove ../x",
      "git worktree add ../y",
      "git worktree prune",
      "git branch -D old",
      "git branch --delete --force old",
      "git branch -df old",
      "git reset --hard HEAD~1",
      "git checkout -- src/app/main.ts",
      "git checkout .",
      "git restore src/app/main.ts",
      "git clean -fdx",
      "git stash",
      "git stash pop",
      "FOO=1 git push",
      '"C:\\Program Files\\Git\\cmd\\git.exe" push',
      "git -C ../other push",
      "sudo git clean -n",
      "& git push",
    ]
    for (const sessionID of [OWNER_SESSION, CHILD, OLD_OWNER, PLAIN_OWNER, MAIN_SESSION])
      for (const command of risky)
        expect(await shell(sessionID, [command], "allow")).toEqual({ effect: "ask", message: ShellRules.TEAM_MESSAGE })
    for (const command of [
      "git stash list",
      "git worktree list",
      "git worktree list --porcelain",
      "git branch -d merged",
      "git reset --soft HEAD~1",
      "git checkout main",
      "git commit -am wip",
      "echo git push",
    ])
      expect((await shell(OWNER_SESSION, [command], "allow")).effect).toBe("allow")
    // The command line is one call: any risky part asks.
    expect((await shell(OWNER_SESSION, ["bun run typecheck", "git push"], "allow")).effect).toBe("ask")
  })

  test("the main also asks for merge and rebase; an owner merging the target into its area does not", async () => {
    await put(team)
    for (const command of ["git merge feature", "git rebase main"])
      expect(await shell(MAIN_SESSION, [command], "allow")).toEqual({ effect: "ask", message: ShellRules.MAIN_MESSAGE })
    expect((await shell(OWNER_SESSION, ["git merge main"], "allow")).effect).toBe("allow")
  })

  test("commands that need no question are raised for the registered main and owner only (06 §10.1)", async () => {
    await put(team)
    const raised = [
      "bun run typecheck",
      "bun install",
      "bun run build",
      "git status",
      "git status --short",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git show HEAD:src/app/main.ts",
      "git rev-parse HEAD",
      "git -C sub status",
      "git --no-pager log",
    ]
    for (const sessionID of [OWNER_SESSION, MAIN_SESSION])
      for (const command of raised) expect((await shell(sessionID, [command], "ask")).effect).toBe("allow")
    expect((await shell(OWNER_SESSION, ["bun install", "bun run build"], "ask")).effect).toBe("allow")
    for (const command of [
      "bun run typecheck --watch",
      "git status > out.txt",
      "git -c core.fsmonitor=x status",
      "git diff --output=patch.txt",
      "git log | head",
      "bun run typecheck && rm -rf dist",
      "rm -rf dist",
      "bun run dev",
    ])
      expect((await shell(OWNER_SESSION, [command], "ask")).effect).toBe("ask")
    // Subagents, replaced owners and sessions outside the registry are never raised.
    for (const sessionID of [CHILD, OLD_OWNER, STRANGER])
      expect((await shell(sessionID, ["bun run typecheck"], "ask")).effect).toBe("ask")
    // A mix with one command outside the list stays ask.
    expect((await shell(OWNER_SESSION, ["git status", "bun run dev"], "ask")).effect).toBe("ask")
    // An ask another own hook wrote with its reason (own.accounts' protected paths, PP) is not raised.
    const reasoned = { ...event(OWNER_SESSION, "shell", ["git status"], "ask"), message: "protected path" }
    await state.evaluate!(reasoned)
    expect([reasoned.effect, reasoned.message]).toEqual(["ask", "protected path"])
    // Policy `autoAllow` off: nothing is raised; lowering still applies.
    await put({ ...team, policy: { ...team.policy, autoAllow: false } })
    expect((await shell(OWNER_SESSION, ["bun run typecheck"], "ask")).effect).toBe("ask")
    expect((await shell(OWNER_SESSION, ["git push"], "allow")).effect).toBe("ask")
    await put(team)
  })

  test("the area folder's V10 candidates: package.json scripts through the lock file's manager, and its install", async () => {
    await put({ ...team, commands: { setup: null, code: [], assets: [] } })
    fs.writeFileSync(
      path.join(codeDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test", lint: "oxlint", dev: "vite" } }),
    )
    fs.writeFileSync(path.join(codeDir, "bun.lock"), "{}")
    for (const command of ["bun run test", "bun run lint", "bun install"])
      expect((await shell(OWNER_SESSION, [command], "ask")).effect).toBe("allow")
    for (const command of ["bun run dev", "npm run test", "bun run typecheck"])
      expect((await shell(OWNER_SESSION, [command], "ask")).effect).toBe("ask")
    await put(team)
  })

  test("actions other than edit and shell are left alone", async () => {
    await put(team)
    const read = event(CHILD, "read", ["Content/map.bin"], "allow")
    await state.evaluate!(read)
    expect(read.effect).toBe("allow")
  })
})

describe.skipIf(!lfsAvailable)("F2: heavy-folder deny through the hook and its p95", () => {
  const box = temp()
  afterAll(() => box.dispose())
  const repo = f2(path.join(box.root, "f2"))
  const directory = path.join(box.root, "f2-team", "area")
  const state: { evaluate?: Evaluate } = {}

  beforeAll(async () => {
    const created = await Worktree.create(
      {
        home: repo.home,
        directory,
        branch: "area",
        base: repo.head,
        areaID: "ar_area",
        shape: "code",
        cone: ["-dash", "Assets/Scripts", "docs", "src"],
        heavy: [...F2_HEAVY],
      },
      { askDownloadBytes: Number.POSITIVE_INFINITY },
    )
    if (!created.ok || created.state !== "ready") throw new Error(JSON.stringify(created))
    const h = await booted(repo.home)
    const team: OwnTeam.Team = {
      ...teamRecord({ home: repo.home }),
      heavy: { dirs: [...F2_HEAVY], measuredAt: repo.head, forcedBytes: 0 },
      commands: { setup: null, code: [{ argv: ["bun", "run", "typecheck"] }], assets: [] },
    }
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team)
      await h.services.registry.areas.put({
        ...areaRecord({ slug: "area", directory }),
        shape: "code",
        gitDir: created.gitDir,
      })
    })
    for (const id of [OWNER_SESSION, CHILD]) h.world.sessions.set(id, { id, directory, permissions: [] })
    state.evaluate = h.evaluate
  }, SLOW)

  test(
    "a write into a heavy folder outside the cone is denied with the message; the cone and new folders pass",
    async () => {
      for (const sessionID of [OWNER_SESSION, CHILD])
        for (const effect of ["allow", "ask"] as const) {
          const denied = event(sessionID, "edit", ["Assets/Textures/rock.png"], effect)
          await state.evaluate!(denied)
          expect(denied).toMatchObject({ effect: "deny", message: Guard.message("Assets/Textures") })
          const passed = event(sessionID, "edit", ["src/app/main.ts", "newpkg/a.ts"], effect)
          await state.evaluate!(passed)
          expect(passed.effect).toBe(effect)
        }
      const incoming = event(CHILD, "edit", ["src/app/main.ts"], "deny")
      await state.evaluate!(incoming)
      expect(incoming).toEqual(event(CHILD, "edit", ["src/app/main.ts"], "deny"))
    },
    SLOW,
  )

  // A wall-clock check that a loaded PC can fail: opt-in like TG6's (`bun run test:perf`, OWN_TEAM_PERF=1).
  test.skipIf(process.env.OWN_TEAM_PERF !== "1")(
    "p95 of the hook is at most 50 ms (no git process on the hot path)",
    async () => {
      const cases = [
        () => event(CHILD, "edit", ["src/app/main.ts"], "ask"),
        () => event(CHILD, "edit", ["Assets/Textures/rock.png"], "allow"),
        () => event(OWNER_SESSION, "shell", ["git push"], "allow"),
        () => event(OWNER_SESSION, "shell", ["bun run typecheck"], "ask"),
        () => event(CHILD, "shell", ["git lfs pull"], "allow"),
      ]
      // Warm-up: the first call lists the cone once.
      for (const make of cases) await state.evaluate!(make())
      const times: number[] = []
      for (let round = 0; round < 40; round++)
        for (const make of cases) {
          const started = performance.now()
          await state.evaluate!(make())
          times.push(performance.now() - started)
        }
      const sorted = times.toSorted((a, b) => a - b)
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!
      expect(p95).toBeLessThanOrEqual(50)
    },
    SLOW,
  )
})
