// The cone follows HEAD (06 §4.8): after a merge brings a new top-level folder, the folders of the complement cone the
// current cone does not hold are weighed and the light ones added (`cone.extra` `auto`), heavy ones stay collapsed, no
// add runs while a collapsed folder holds only ignored files, and an area that is not its worktree gets no git
// command (TI-14, TG10: the home around a nested area stays as it is). HEAD is read from the git dir like
// `rev-parse HEAD`. F2 fixture and plain fixture repositories; every value is fake.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Drift } from "../../src/assets/drift.js"
import { NeedPaths } from "../../src/assets/need-paths.js"
import { Cone } from "../../src/git/cone.js"
import { Measure } from "../../src/git/measure.js"
import { Worktree } from "../../src/git/worktree.js"
import type { Hub } from "../../src/hub.js"
import { F2_HEAVY, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { commit, git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"

const SLOW = 180_000
const CONE = ["-dash", "Assets/Scripts", "docs", "src"]

describe("Drift.head reads HEAD like rev-parse", () => {
  const box = temp()
  afterAll(() => box.dispose())

  test("a branch (loose and packed), a linked worktree and a detached HEAD", async () => {
    const repo = init(path.join(box.root, "repo"))
    write(repo, { "a.txt": "a\n" })
    commit(repo, "one")
    const linked = path.join(box.root, "linked")
    git(repo, ["worktree", "add", "-q", "-b", "side", linked])
    const same = async (directory: string) =>
      expect(await Drift.head({ directory, gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]).trim() })).toBe(
        head(directory),
      )
    await same(repo)
    await same(linked)
    write(linked, { "b.txt": "b\n" })
    commit(linked, "two")
    await same(linked)
    git(repo, ["pack-refs", "--all"])
    expect(fs.existsSync(path.join(repo, ".git", "refs", "heads", "side"))).toBe(false)
    await same(linked)
    await same(repo)
    git(linked, ["checkout", "-q", "--detach", "HEAD~1"])
    await same(linked)
    const none = path.join(box.root, "none")
    expect(await Drift.head({ directory: none, gitDir: none })).toBeUndefined()
  })
})

describe("Drift.heavy: the 4.6 thresholds and the 3.4 rule", () => {
  const counted = (bytes: number, lfsBytes: number, missing = 0): NeedPaths.Count => ({
    files: 1,
    bytes,
    lfsBytes,
    missing: { objects: [], count: missing > 0 ? 1 : 0, bytes: missing },
    per: {},
  })
  const MB = 1024 ** 2

  test("over a threshold, or 50 MB and mostly LFS or binary; code stays light", () => {
    const policy = OwnTeam.POLICY
    expect(Drift.heavy(policy, counted(10 * MB, 10 * MB), 0)).toBe(false)
    expect(Drift.heavy(policy, counted(60 * MB, 40 * MB), 0)).toBe(true)
    expect(Drift.heavy(policy, counted(60 * MB, 0), 50 * MB)).toBe(true)
    expect(Drift.heavy(policy, counted(60 * MB, 0), 10 * MB)).toBe(false)
    expect(Drift.heavy(policy, counted(policy.askDiskBytes, 0), 0)).toBe(true)
    expect(Drift.heavy(policy, counted(MB, MB, policy.askDownloadBytes), 0)).toBe(true)
    expect(Measure.HEAVY_BYTES).toBe(50 * MB)
  })
})

describe.skipIf(!lfsAvailable)("F2: the cone follows HEAD (06 §4.8)", () => {
  const box = temp()
  const repo = f2(path.join(box.root, "f2"))
  const world = new World()
  const safe = { now: true }
  const h = controller(world, {
    directory: box.root,
    clock: manual(),
    features: {
      safePoint: () => ({
        check: async () => (safe.now ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }),
      }),
    },
  })
  afterAll(async () => {
    await h.close()
    box.dispose()
  })
  // A new folder of at least 10 kB waits for the user, so it counts as heavy here (4.6 step 2).
  const heavyTeam: OwnTeam.Team = {
    ...team({ home: repo.home }),
    heavy: { dirs: [...F2_HEAVY], measuredAt: repo.head, forcedBytes: 0 },
    env: { symlinkFix: "none", bunCache: "unused", lfs: "system" },
    policy: { ...OwnTeam.POLICY, askDiskBytes: 10_000 },
  }
  fs.appendFileSync(path.join(repo.home, ".git", "info", "exclude"), ".worktrees/\n")

  /** The target gains `tools/` (code) and `Movies/` (an LFS file over the disk threshold) on `main`. */
  const grown = (() => {
    write(repo.home, {
      "tools/build.ts": "export const build = 1\n",
      "Movies/clip.bin": crypto.getRandomValues(new Uint8Array(20_000)),
    })
    return commit(repo.home, "tools and movies")
  })()

  async function makeArea(slug: string, directory = path.join(box.root, "team", slug)) {
    const created = await Worktree.create(
      {
        home: repo.home,
        directory,
        branch: slug,
        base: repo.head,
        areaID: `ar_${slug}`,
        shape: "code",
        cone: CONE,
        heavy: [...F2_HEAVY],
      },
      { askDownloadBytes: Number.POSITIVE_INFINITY },
    )
    if (!created.ok || created.state !== "ready") throw new Error(JSON.stringify(created))
    const record: OwnTeam.Area = { ...area({ slug, directory }), shape: "code", gitDir: created.gitDir }
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(heavyTeam)
      await h.services.registry.areas.put(record)
    })
    return record
  }
  const current = async (record: OwnTeam.Area) => (await h.services.registry.areas.get(TEAM_ID, record.id))!
  const cone = async (record: OwnTeam.Area) => {
    const listed = await Cone.list(record.directory)
    if (!listed.ok) throw new Error(listed.message)
    return listed.dirs.toSorted()
  }
  const file = (record: OwnTeam.Area, name: string) => path.join(record.directory, ...name.split("/"))
  const check = async (record: OwnTeam.Area) =>
    Drift.check(h.services, { team: heavyTeam, area: await current(record) })

  test(
    "a merge that brings a light and a heavy top-level folder: the light one is added as auto, the heavy stays out",
    async () => {
      const record = await makeArea("merge")
      expect(await check(record)).toEqual({ ok: true, added: [], heavy: [] })
      git(record.directory, ["merge", "-q", "--ff-only", "main"])
      expect(head(record.directory)).toBe(grown)
      // git leaves the new folders collapsed and the status clean ([R-lazy] A/wt-m).
      expect(fs.existsSync(file(record, "tools"))).toBe(false)
      expect(git(record.directory, ["status", "--porcelain=v2", "-z"])).toBe("")
      expect(await check(record)).toEqual({ ok: true, added: ["tools"], heavy: ["Movies"] })
      expect(await cone(record)).toEqual([...CONE, "tools"].toSorted())
      expect(fs.readFileSync(file(record, "tools/build.ts"), "utf8")).toBe("export const build = 1\n")
      expect(fs.existsSync(file(record, "Movies"))).toBe(false)
      const extra = (await current(record)).cone.extra
      expect(Object.keys(extra)).toEqual(["tools"])
      expect(extra["tools"]).toMatchObject({ reason: NeedPaths.AUTO })
      // The same HEAD again: nothing to weigh or add.
      expect(await check(record)).toEqual({ ok: true, added: [], heavy: [] })
      expect(git(record.directory, ["status", "--porcelain=v2", "-z"])).toBe("")
    },
    SLOW,
  )

  test(
    "a collapsed folder that holds only ignored files keeps the cone as it is: the add answers kept",
    async () => {
      const record = await makeArea("ignored")
      write(record.directory, { ".gitignore": "*.cache\n", "Content/out.cache": "build output" })
      git(record.directory, ["merge", "-q", "--ff-only", "main"])
      expect(await check(record)).toMatchObject({ ok: false, error: "kept" })
      expect(fs.readFileSync(file(record, "Content/out.cache"), "utf8")).toBe("build output")
      expect(await cone(record)).toEqual(CONE)
      expect((await current(record)).cone.extra).toEqual({})
      // Once the file is gone, the next check (the HEAD was not recorded as checked) adds the folder.
      fs.rmSync(file(record, "Content"), { recursive: true })
      expect(await check(record)).toEqual({ ok: true, added: ["tools"], heavy: ["Movies"] })
    },
    SLOW,
  )

  test(
    "TI-14, TG10: a broken area and a nested area without its .git get no git command; the home is unchanged",
    async () => {
      const broken = await makeArea("broken")
      git(broken.directory, ["merge", "-q", "--ff-only", "main"])
      expect(
        await Drift.check(h.services, { team: heavyTeam, area: { ...(await current(broken)), state: "broken" } }),
      ).toMatchObject({ ok: false, error: "broken" })
      expect(await cone(broken)).toEqual(CONE)

      const nested = await makeArea("nested", path.join(repo.home, ".worktrees", "nested"))
      git(nested.directory, ["merge", "-q", "--ff-only", "main"])
      fs.rmSync(path.join(nested.directory, ".git"))
      const before = git(repo.home, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])
      expect(await check(nested)).toMatchObject({ ok: false, error: "broken", broken: "identity" })
      expect((await current(nested)).cone.extra).toEqual({})
      // The home never became sparse and lost nothing.
      const sparse = Bun.spawnSync(["git", "-C", repo.home, "config", "--get", "core.sparseCheckout"])
      expect(sparse.exitCode).not.toBe(0)
      expect(git(repo.home, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(before)
      expect(fs.existsSync(path.join(repo.home, "Content", "map.bin"))).toBe(true)
    },
    SLOW,
  )

  test(
    "the feature: a run that ends re-checks an area whose HEAD moved, only at its safe point",
    async () => {
      const record = await makeArea("sweep")
      const feature = Drift.create(h.services)
      expect(h.services.steps.get(Drift.STEP)).toBeDefined()
      await feature.resume?.()
      git(record.directory, ["merge", "-q", "--ff-only", "main"])
      safe.now = false
      h.controller.hub.receive(ended())
      await Bun.sleep(300)
      expect(await cone(record)).toEqual(CONE)
      safe.now = true
      h.controller.hub.receive(ended())
      // Only a check records the folder; the test called none.
      await until(async () => (await current(record)).cone.extra["tools"]?.reason === NeedPaths.AUTO)
      expect(await cone(record)).toEqual([...CONE, "tools"].toSorted())
      // A check while one runs shares its result; once it ended, the same HEAD has nothing left to add.
      await feature.check({ teamID: TEAM_ID, areaID: record.id })
      expect(await feature.check({ teamID: TEAM_ID, areaID: record.id })).toEqual({ ok: true, added: [], heavy: [] })
      await feature.close?.()
    },
    SLOW,
  )

  test(
    "the drift step of an op adds the folders; a plain area has nothing to follow",
    async () => {
      const record = await makeArea("step")
      git(record.directory, ["merge", "-q", "--ff-only", "main"])
      Drift.register(h.services)
      const started = await h.services.runner.start({
        teamID: TEAM_ID,
        kind: "integrate",
        by: "main",
        areaID: record.id,
        steps: [Drift.spec({ areaID: record.id })],
      })
      if (!started.ok) throw new Error("busy")
      await h.services.runner.settled(started.op.id)
      expect(await h.services.journal.get(TEAM_ID, started.op.id)).toMatchObject({
        state: "done",
        steps: [{ kind: Drift.STEP, state: "done" }],
      })
      expect(await cone(record)).toEqual([...CONE, "tools"].toSorted())
      expect(
        await Drift.check(h.services, { team: heavyTeam, area: { ...(await current(record)), shape: "plain" } }),
      ).toEqual({ ok: true, added: [], heavy: [] })
    },
    SLOW,
  )
})

function ended(): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return {
    id: `evt_${crypto.randomUUID()}`,
    created: 1,
    type: "session.execution.succeeded",
    data: { sessionID: "ses_owner000000000000000000001" },
  } as never
}

async function until(check: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(20)
  }
}
