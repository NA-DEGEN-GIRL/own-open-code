// The after-tool fix through own.team's tool hooks (06 §4.8, §4.9 item 2, TG6 tool-after part): the T1 fix
// still brings a heavy folder a command wrote into back into the cone without deleting anything, and a shell call that
// moves the area's HEAD (its `execute.before` reads HEAD, its `execute.after` compares) makes the cone follow: a new
// light top-level folder is added (`cone.extra` `auto`), a heavy one stays collapsed. A call whose before hook never
// ran, or one that left HEAD where it was, changes nothing. Both hooks stay within 50 ms at p95 over 200 calls: a
// wall-clock check that a loaded PC can fail, so it is opt-in (`bun run test:perf`, OWN_TEAM_PERF=1) and run on an
// idle PC for the gate record. The hooks are `ToolHook.create`'s, as the plugin registers them, on a clock that never
// ends their wait (RH-50): the plugin's return at `ToolHook.LIMIT_MS` (30 s) while their work goes on, and on a loaded
// PC the checks after them read the cone before that work ended (31.5 s, 2026-10-31). hooks/tool.test.ts covers the
// limit and the plugin's registration.
// F2 fixture; every session and value is fake.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../../src/assets/need-paths.js"
import { Cone } from "../../src/git/cone.js"
import { Worktree } from "../../src/git/worktree.js"
import { ToolHook } from "../../src/hooks/tool.js"
import type { Hub } from "../../src/hub.js"
import type { Services } from "../../src/services.js"
import { Singleton } from "../../src/singleton.js"
import { F2_HEAVY, F2_LFS, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { commit, git, head, temp, write } from "../fixtures/repo.js"
import {
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
const CONE = ["-dash", "Assets/Scripts", "docs", "src"]
const CHILD = SessionID.make("ses_child000000000000000000001")

const restore = managedEnv()
afterAll(restore)

type Before = (event: ToolHook.Call & Readonly<Record<string, unknown>>) => Promise<void>
type After = (
  event: ToolHook.Call & { readonly status: "completed" | "error" } & Readonly<Record<string, unknown>>,
) => Promise<void>

describe.skipIf(!lfsAvailable)("F2: the after-tool fix and the HEAD-change trigger", () => {
  const box = temp()
  const repo = f2(path.join(box.root, "f2"))
  const directory = path.join(box.root, "f2-team", "area")
  const state: {
    before?: Before
    after?: After
    services?: Services.Context
    published: Hub.Outgoing[]
    cleanup?: () => Promise<void>
  } = { published: [] }
  afterAll(async () => {
    await state.cleanup?.()
    box.dispose()
  })
  // A new folder of at least 50 kB waits for the user, so it counts as heavy here (4.6 step 2); what the after-tool fix
  // brings in below stays under it.
  const team: OwnTeam.Team = {
    ...teamRecord({ home: repo.home }),
    heavy: { dirs: [...F2_HEAVY], measuredAt: repo.head, forcedBytes: 0 },
    env: { symlinkFix: "none", bunCache: "unused", lfs: "system" },
    policy: { ...OwnTeam.POLICY, askDiskBytes: 50_000 },
  }

  beforeAll(async () => {
    const created = await Worktree.create(
      {
        home: repo.home,
        directory,
        branch: "area",
        base: repo.head,
        areaID: "ar_area",
        shape: "code",
        cone: CONE,
        heavy: [...F2_HEAVY],
      },
      { askDownloadBytes: Number.POSITIVE_INFINITY },
    )
    if (!created.ok || created.state !== "ready") throw new Error(JSON.stringify(created))
    const home = await tempHome()
    const world = new World()
    const id = buildId("after-tool")
    const fake = await boot(world, {
      directory: repo.home,
      options: { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" },
    })
    state.cleanup = async () => {
      await fake.cleanup()
      await home[Symbol.asyncDispose]()
    }
    const controller = Singleton.peek(id)!.controller
    controller.hub.subscribe((event) => state.published.push(event))
    state.services = controller.services
    await state.services.write(TEAM_ID, async () => {
      await state.services!.registry.teams.put(team)
      await state.services!.registry.areas.put({
        ...areaRecord({ slug: "area", directory }),
        shape: "code",
        gitDir: created.gitDir,
      })
    })
    for (const sessionID of [OWNER_SESSION, CHILD])
      world.sessions.set(sessionID, { id: sessionID, directory, permissions: [] })
    const hooks = ToolHook.create({ ...state.services, clock: { now: Date.now, schedule: () => () => {} } })
    state.before = hooks.before
    state.after = hooks.after
  }, SLOW)

  const event = (sessionID: SessionID, tool: string, input: unknown, id = `call_${crypto.randomUUID()}`) => ({
    tool,
    sessionID,
    agent: "build",
    messageID: "msg_test",
    id,
    input,
  })
  /** A shell call through both hooks, with `command` run between them as the tool would. */
  const shell = async (sessionID: SessionID, command: () => void) => {
    const call = event(sessionID, "shell", { command: "git" })
    await state.before!(call)
    command()
    await state.after!({ ...call, status: "completed" })
  }
  const cone = async () => {
    const listed = await Cone.list(directory)
    if (!listed.ok) throw new Error(listed.message)
    return listed.dirs.toSorted()
  }
  const record = async () => (await state.services!.registry.areas.get(TEAM_ID, OwnTeam.AreaID.make("ar_area")))!
  const file = (name: string) => path.join(directory, ...name.split("/"))

  test(
    "T1 regression: a file a command wrote into a heavy folder comes in at its narrowest folder; nothing is deleted",
    async () => {
      await shell(CHILD, () => write(directory, { "Assets/Audio/takes/voice.wav": "recorded by the agent" }))
      expect(await cone()).toEqual([...CONE, "Assets/Audio/takes"].toSorted())
      expect(fs.readFileSync(file("Assets/Audio/takes/voice.wav"), "utf8")).toBe("recorded by the agent")
      expect(fs.statSync(file("Assets/Audio/music.wav")).size).toBe(F2_LFS["Assets/Audio/music.wav"])
      expect(fs.existsSync(file("Assets/Textures"))).toBe(false)
      expect(state.published).toContainEqual({
        name: "notice",
        data: expect.objectContaining({ kind: "paths.added", areaID: "ar_area" }),
      })
      expect((await record()).cone.extra["Assets/Audio/takes"]?.reason).toBe(NeedPaths.AUTO)
    },
    SLOW,
  )

  test(
    "a shell call that merges the target follows HEAD: the light new folder comes in, the heavy one stays out",
    async () => {
      write(repo.home, {
        "tools/build.ts": "export const build = 1\n",
        "Movies/clip.bin": crypto.getRandomValues(new Uint8Array(60_000)),
      })
      const grown = commit(repo.home, "tools and movies")
      // A shell call that leaves HEAD where it was changes nothing.
      await shell(OWNER_SESSION, () => {})
      expect(await cone()).toEqual([...CONE, "Assets/Audio/takes"].toSorted())
      await shell(OWNER_SESSION, () => git(directory, ["merge", "-q", "--ff-only", "main"]))
      expect(head(directory)).toBe(grown)
      expect(await cone()).toEqual([...CONE, "Assets/Audio/takes", "tools"].toSorted())
      expect(fs.readFileSync(file("tools/build.ts"), "utf8")).toBe("export const build = 1\n")
      expect(fs.existsSync(file("Movies"))).toBe(false)
      expect((await record()).cone.extra["tools"]?.reason).toBe(NeedPaths.AUTO)
      expect(git(directory, ["status", "--porcelain=v2", "-z", "--untracked-files=no"])).toBe("")
    },
    SLOW,
  )

  test(
    "HEAD moved by a call whose before hook never ran, or by a write tool: no cone change until a later shell move",
    async () => {
      write(repo.home, { "tools2/run.ts": "export const run = 1\n" })
      commit(repo.home, "tools2")
      const call = event(CHILD, "shell", { command: "git merge" })
      git(directory, ["merge", "-q", "--ff-only", "main"])
      await state.after!({ ...call, status: "completed" })
      await state.after!({ ...event(CHILD, "write", { path: "src/app/x.ts", content: "x" }), status: "completed" })
      expect(await cone()).toEqual([...CONE, "Assets/Audio/takes", "tools"].toSorted())
      write(repo.home, { "tools3/go.ts": "export const go = 1\n" })
      commit(repo.home, "tools3")
      await shell(CHILD, () => git(directory, ["merge", "-q", "--ff-only", "main"]))
      expect(await cone()).toEqual([...CONE, "Assets/Audio/takes", "tools", "tools2", "tools3"].toSorted())
    },
    SLOW,
  )

  test.skipIf(process.env.OWN_TEAM_PERF !== "1")(
    "p95 of both hooks is at most 50 ms over 200 calls when there is nothing to do (TG6)",
    async () => {
      const times: number[] = []
      const timed = async (run: () => Promise<void>) => {
        const started = performance.now()
        await run()
        times.push(performance.now() - started)
      }
      await state.before!(event(CHILD, "write", { path: "src/app/c.ts", content: "x" }))
      for (let round = 0; round < 50; round++) {
        const call = event(CHILD, "shell", { command: "ls" })
        await timed(() => state.before!(call))
        await timed(() => state.after!({ ...call, status: "completed" }))
        const edit = event(OWNER_SESSION, "write", { path: "src/app/c.ts", content: "x" })
        await timed(() => state.before!(edit))
        await timed(() => state.after!({ ...edit, status: "completed" }))
      }
      expect(times).toHaveLength(200)
      const sorted = times.toSorted((a, b) => a - b)
      const p95 = sorted[Math.floor(sorted.length * 0.95)]!
      // The gate record (own/reports/team-t2-gates.md): the value this PC measured.
      console.log(`[TG6 p95] ${p95.toFixed(1)} ms over ${times.length} hook calls`)
      expect(p95).toBeLessThanOrEqual(50)
    },
    SLOW,
  )
})
