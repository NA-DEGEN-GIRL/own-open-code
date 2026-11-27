// own.team's tool hooks at plugin level (06 §4.9 items 1-2, TG6): `execute.before` of a write tool adds the narrowest
// folder of a non-heavy target outside the cone, `execute.after` of shell and write tools brings a heavy folder a
// command wrote into back into the cone and folds the rest, neither ever throws (a rejected promise hook would be a
// defect the model never sees), and both stay within the 50 ms p95 when there is nothing to do. F2 fixture.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../../src/assets/need-paths.js"
import { Cone } from "../../src/git/cone.js"
import { Worktree } from "../../src/git/worktree.js"
import { ToolHook } from "../../src/hooks/tool.js"
import type { Hub } from "../../src/hub.js"
import type { Services } from "../../src/services.js"
import { Singleton } from "../../src/singleton.js"
import { F2_HEAVY, F2_LFS, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { temp, write } from "../fixtures/repo.js"
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
import { until } from "../support/core.js"

const SLOW = 180_000
const CONE = ["-dash", "Assets/Scripts", "docs", "src"]
const CHILD = SessionID.make("ses_child000000000000000000001")
const STRANGER = SessionID.make("ses_stranger00000000000000001")

const restore = managedEnv()
afterAll(restore)

type Before = (event: ToolHook.Call & Readonly<Record<string, unknown>>) => Promise<void>
type After = (
  event: ToolHook.Call & { readonly status: "completed" | "error" } & Readonly<Record<string, unknown>>,
) => Promise<void>

describe.skipIf(!lfsAvailable)("F2: tool hooks of a code-only area", () => {
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
    const id = buildId("tool-hooks")
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
    const team: OwnTeam.Team = {
      ...teamRecord({ home: repo.home }),
      heavy: { dirs: [...F2_HEAVY], measuredAt: repo.head, forcedBytes: 0 },
      env: { symlinkFix: "none", bunCache: "unused", lfs: "system" },
    }
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
    world.sessions.set(STRANGER, { id: STRANGER, directory: box.root, permissions: [] })
    // SAFETY (test): the fake keeps each registered hook callback; these take tool hook events.
    state.before = fake.hooks.get("tool.execute.before")![0] as unknown as Before
    state.after = fake.hooks.get("tool.execute.after")![0] as unknown as After
  }, SLOW)

  const call = (sessionID: SessionID, tool: string, input: unknown) => ({
    tool,
    sessionID,
    agent: "build",
    messageID: "msg_test",
    id: "call_test",
    input,
  })
  const cone = async () => {
    const listed = await Cone.list(directory)
    if (!listed.ok) throw new Error(listed.message)
    return listed.dirs.toSorted()
  }
  const file = (name: string) => path.join(directory, ...name.split("/"))

  test(
    "execute.before of a write tool adds a new non-heavy folder; heavy and in-cone targets change nothing",
    async () => {
      await state.before!(call(CHILD, "write", { path: "newpkg/a.ts", content: "x" }))
      await state.before!(call(OWNER_SESSION, "edit", { path: "Content/map.bin", oldString: "a", newString: "b" }))
      await state.before!(call(OWNER_SESSION, "write", { path: "src/app/b.ts", content: "x" }))
      expect(await cone()).toEqual([...CONE, "newpkg"].toSorted())
      const area = await state.services!.registry.areas.get(TEAM_ID, "ar_area")
      expect(area?.cone.extra["newpkg"]?.reason).toBe(NeedPaths.AUTO)
    },
    SLOW,
  )

  test(
    "execute.after of a shell call brings a heavy folder written by the command back in, deleting nothing, also after the call went on at the hook's limit",
    async () => {
      write(directory, { "Assets/Audio/takes/voice.wav": "recorded by the agent" })
      // RH-50: on a loaded PC the work outlasted `ToolHook.LIMIT_MS` (30 s), the call went on, and the cone was read
      // before the work ended. The limit passes first here, on a clock the test fires: the hook returns before the
      // work's notice, and the work still ends on its own.
      const limits: Array<() => void> = []
      const hooks = ToolHook.create({
        ...state.services!,
        clock: {
          now: Date.now,
          schedule: (_ms, run) => {
            limits.push(run)
            return () => {}
          },
        },
      })
      const returned = hooks.after({ ...call(CHILD, "shell", { command: "record" }), status: "completed" })
      expect(limits).toHaveLength(1)
      limits.forEach((run) => run())
      await returned
      const added = (event: Hub.Outgoing) => event.name === "notice" && event.data.kind === "paths.added"
      expect(state.published.filter(added)).toEqual([])
      await until(() => state.published.some(added), SLOW)
      expect(await cone()).toEqual([...CONE, "Assets/Audio/takes", "newpkg"].toSorted())
      expect(fs.readFileSync(file("Assets/Audio/takes/voice.wav"), "utf8")).toBe("recorded by the agent")
      // Cone mode checks out the files around a cone folder: the heavy folder's own files come with it.
      expect(fs.statSync(file("Assets/Audio/music.wav")).size).toBe(F2_LFS["Assets/Audio/music.wav"])
      expect(fs.existsSync(file("Assets/Textures"))).toBe(false)
      expect(state.published).toContainEqual({
        name: "notice",
        data: expect.objectContaining({ kind: "paths.added", areaID: "ar_area" }),
      })
    },
    SLOW,
  )

  test(
    "the hooks never throw: other sessions, other tools, bad inputs and failed calls pass through",
    async () => {
      await state.before!(call(STRANGER, "write", { path: "Content/x.bin", content: "x" }))
      await state.before!(call(CHILD, "write", "not an object"))
      await state.before!(call(CHILD, "patch", { patchText: 42 }))
      await state.before!(call(SessionID.make("ses_unknown000000000000000001"), "edit", { path: "a" }))
      await state.after!({ ...call(CHILD, "write", {}), status: "error" })
      await state.after!({ ...call(STRANGER, "shell", {}), status: "completed" })
      expect(await cone()).toEqual([...CONE, "Assets/Audio/takes", "newpkg"].toSorted())
    },
    SLOW,
  )

  // A wall-clock check that a loaded PC can fail: opt-in like TG6's (`bun run test:perf`, OWN_TEAM_PERF=1).
  test.skipIf(process.env.OWN_TEAM_PERF !== "1")(
    "p95 of both hooks is at most 50 ms when there is nothing to do",
    async () => {
      const times: number[] = []
      const timed = async (run: () => Promise<void>) => {
        const started = performance.now()
        await run()
        times.push(performance.now() - started)
      }
      await state.before!(call(CHILD, "write", { path: "src/app/c.ts", content: "x" }))
      for (let round = 0; round < 50; round++) {
        await timed(() => state.before!(call(CHILD, "write", { path: "src/app/c.ts", content: "x" })))
        await timed(() =>
          state.before!(call(CHILD, "edit", { path: "Content/map.bin", oldString: "a", newString: "b" })),
        )
        await timed(() => state.after!({ ...call(CHILD, "shell", { command: "ls" }), status: "completed" }))
        await timed(() => state.after!({ ...call(OWNER_SESSION, "read", { path: "x" }), status: "completed" }))
      }
      const sorted = times.toSorted((a, b) => a - b)
      expect(sorted[Math.floor(sorted.length * 0.95)]!).toBeLessThanOrEqual(50)
    },
    SLOW,
  )
})
