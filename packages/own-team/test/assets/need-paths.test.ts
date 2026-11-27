// Fetching large-file folders (06 §4.6, TG4 on Windows): `team_need_paths` and `area.paths{add}` against the F2 LFS
// fixture (a bare `file://` remote, no port): a folder whose objects are in the shared store needs no network, a
// missing one is fetched in one batch, a fetch over the thresholds waits for the confirm without downloading, and a
// failed fetch or add leaves the area as it was. Every value is a fixture; nothing reads this PC's accounts.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../../src/assets/need-paths.js"
import { Cone } from "../../src/git/cone.js"
import { Worktree } from "../../src/git/worktree.js"
import { PathsRpc } from "../../src/rpc/paths.js"
import type { Services } from "../../src/services.js"
import { NeedPathsTool } from "../../src/tools/need-paths.js"
import { F2_HEAVY, F2_LFS, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { git, temp } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { start } from "../support/service.js"

/** Git and LFS transfers: Windows process starts are slow on a busy machine. */
const SLOW = 180_000
const CONE = ["-dash", "Assets/Scripts", "docs", "src"]

describe("pure parts", () => {
  test("validate refuses '..', a leading '/', '\\' or '-', drives and the root; normalizes and drops nested folders", () => {
    for (const bad of ["../x", "a/../b", "/abs", "\\abs", "-dash", "./-dash", "C:/x", "", ".", "a\nb"])
      expect(NeedPaths.validate([bad])).toEqual({ ok: false, path: bad })
    expect(NeedPaths.validate(["Assets\\Textures\\UI", "Assets/Textures", "./docs/", "docs"])).toEqual({
      ok: true,
      dirs: ["Assets/Textures", "docs"],
    })
  })

  test("over: missing bytes at the download threshold or bytes at the disk threshold; nothing to do never asks", () => {
    const count = (missing: number, bytes: number): NeedPaths.Count => ({
      files: 1,
      bytes,
      lfsBytes: missing,
      missing: { objects: [], count: missing > 0 ? 1 : 0, bytes: missing },
      per: {},
    })
    const policy = { ...OwnTeam.POLICY, askDownloadBytes: 100, askDiskBytes: 1_000 }
    expect(NeedPaths.over(policy, count(99, 500))).toBe(false)
    expect(NeedPaths.over(policy, count(100, 500))).toBe(true)
    expect(NeedPaths.over(policy, count(0, 1_000))).toBe(true)
    expect(NeedPaths.over({ ...policy, askDownloadBytes: 0, askDiskBytes: 0 }, count(0, 0))).toBe(false)
  })

  test("team_need_paths takes up to 64 folders at once (PATHS_MAX, 2026-11-14), like area.paths", () => {
    const decode = Schema.decodeUnknownOption(NeedPathsTool.Input)
    const dirs = (count: number) => Array.from({ length: count }, (_, index) => `Assets/Part${index}`)
    expect(OwnTeam.PATHS_MAX).toBe(64)
    expect(Option.isSome(decode({ dirs: dirs(64), reason: "map data" }))).toBe(true)
    expect(Option.isNone(decode({ dirs: dirs(65), reason: "map data" }))).toBe(true)
    expect(Option.isNone(decode({ dirs: [], reason: "map data" }))).toBe(true)
  })

  test("size as the cards show it", () => {
    expect(NeedPaths.size(512)).toBe("512 B")
    expect(NeedPaths.size(120 * 1024 ** 2)).toBe("120 MB")
    expect(NeedPaths.size(2.5 * 1024 ** 3)).toBe("2.5 GB")
  })
})

describe.skipIf(!lfsAvailable)("F2: fetching large-file folders into a code-only area (TG4)", () => {
  const box = temp()
  const repo = f2(path.join(box.root, "f2"))
  const service = start()
  const world = new World()
  const clock = manual()
  const h = controller(world, { directory: box.root, clock, source: service.source })
  afterAll(async () => {
    await h.close()
    await service.stop()
    box.dispose()
  })
  const heavyTeam: OwnTeam.Team = {
    ...team({ home: repo.home }),
    heavy: { dirs: [...F2_HEAVY], measuredAt: repo.head, forcedBytes: 0 },
    env: { symlinkFix: "none", bunCache: "unused", lfs: "system" },
  }
  const synthetic: unknown[] = []
  service.routes.set(`POST /api/session/${OWNER_SESSION}/synthetic`, (request) => {
    synthetic.push(request.body)
    return Response.json({
      data: { id: "msg_1", sessionID: OWNER_SESSION, type: "synthetic", delivery: "queue", payload: {} },
    })
  })

  async function makeArea(slug: string) {
    const directory = path.join(box.root, "team", slug)
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
    world.sessions.set(OWNER_SESSION, { id: OWNER_SESSION, directory, permissions: [] })
    return record
  }

  const current = async (record: OwnTeam.Area) => (await h.services.registry.areas.get(TEAM_ID, record.id))!
  const caller = async (record: OwnTeam.Area) => ({
    role: "owner" as const,
    team: (await h.services.registry.teams.get(TEAM_ID))!,
    area: await current(record),
    sessionID: OWNER_SESSION,
  })
  const inCone = async (record: OwnTeam.Area, dir: string) => {
    const inside = await Cone.inside(record.directory, [dir])
    return inside.ok && inside.dirs.includes(dir)
  }
  const onDisk = (record: OwnTeam.Area, file: string) => fs.existsSync(path.join(record.directory, ...file.split("/")))
  const status = (record: OwnTeam.Area) => git(record.directory, ["status", "--porcelain=v2", "-z"])

  const ready = (async () => ({ main: await makeArea("inventory-ui"), spare: await makeArea("spare") }))()

  test(
    "count: files, real LFS bytes and missing bytes of the folders at HEAD, per folder",
    async () => {
      const { main } = await ready
      const counted = await NeedPaths.count(main.directory, ["Assets/Textures", "Content"], CONE)
      if (!counted.ok) throw new Error(counted.message)
      const textures = F2_LFS["Assets/Textures/rock.png"] + F2_LFS["Assets/Textures/tree.png"]
      const content = F2_LFS["Content/map.bin"] + F2_LFS["Content/src/deep.bin"]
      expect(counted).toMatchObject({ files: 4, bytes: textures + content, lfsBytes: textures + content })
      expect(counted.missing).toMatchObject({ count: 4, bytes: textures + content })
      expect(counted.per).toEqual({ "Assets/Textures": textures, Content: content })
    },
    SLOW,
  )

  test(
    "offline with missing objects: the network message, and the area, its cone and the store are unchanged",
    async () => {
      const { main } = await ready
      const objects = repo.objects()
      repo.offline()
      const reply = await NeedPathsTool.run(h.services, await caller(main), { dirs: ["Content"], reason: "map data" })
      repo.online()
      expect(reply).toMatchObject({ ok: false, text: NeedPaths.NETWORK, error: "network" })
      expect(await inCone(main, "Content")).toBe(false)
      expect(onDisk(main, "Content/map.bin")).toBe(false)
      expect(status(main)).toBe("")
      expect(repo.objects()).toBe(objects)
      expect((await current(main)).cone.extra).toEqual({})
    },
    SLOW,
  )

  test(
    "objects in the shared store: fetched offline with no download, recorded with its reason, and announced",
    async () => {
      const { main } = await ready
      git(repo.home, ["lfs", "fetch", "--include=Assets/Textures/**"])
      const objects = repo.objects()
      repo.offline()
      const reply = await NeedPathsTool.run(h.services, await caller(main), {
        dirs: ["Assets/Textures"],
        reason: "icon import settings",
      })
      repo.online()
      const bytes = F2_LFS["Assets/Textures/rock.png"] + F2_LFS["Assets/Textures/tree.png"]
      expect(reply).toMatchObject({ ok: true, added: ["Assets/Textures"], bytes, downloaded: 0, waiting: false })
      expect(repo.objects()).toBe(objects)
      expect(fs.statSync(path.join(main.directory, "Assets", "Textures", "rock.png")).size).toBe(
        F2_LFS["Assets/Textures/rock.png"],
      )
      expect(status(main)).toBe("")
      expect((await current(main)).cone.extra).toEqual({
        "Assets/Textures": { reason: "icon import settings", at: clock.now(), bytes },
      })
      expect(h.published).toContainEqual({
        name: "notice",
        data: expect.objectContaining({
          kind: "paths.added",
          areaID: main.id,
          text: `${main.name}: 큰 파일 폴더 1개(${NeedPaths.size(bytes)})를 가져왔어요`,
        }),
      })
      // Asked again: already in the cone, nothing to do.
      expect(
        await NeedPathsTool.run(h.services, await caller(main), { dirs: ["Assets/Textures"], reason: "again" }),
      ).toMatchObject({ ok: true, added: [], waiting: false })
    },
    SLOW,
  )

  test(
    "missing objects: one fetch of that folder only, then the add",
    async () => {
      const { main } = await ready
      const objects = repo.objects()
      const reply = await NeedPathsTool.run(h.services, await caller(main), { dirs: ["Assets/Audio"], reason: "mix" })
      expect(reply).toMatchObject({ ok: true, added: ["Assets/Audio"], downloaded: F2_LFS["Assets/Audio/music.wav"] })
      expect(repo.objects()).toBe(objects + 1)
      expect(onDisk(main, "Content/map.bin")).toBe(false)
      expect(status(main)).toBe("")
    },
    SLOW,
  )

  test(
    "over the threshold: a confirm and no download; confirmed: fetched and the owner hears back in its queue",
    async () => {
      const { main } = await ready
      await h.services.write(TEAM_ID, () =>
        h.services.registry.teams.put({ ...heavyTeam, policy: { ...heavyTeam.policy, askDownloadBytes: 1 } }),
      )
      const objects = repo.objects()
      const reply = await NeedPathsTool.run(h.services, await caller(main), { dirs: ["Content"], reason: "map data" })
      expect(reply).toMatchObject({ ok: true, waiting: true, added: [], text: NeedPaths.WAITING })
      const op = await h.services.journal.active(TEAM_ID)
      if (!op) throw new Error("no paths op")
      await h.services.runner.settled(op.id)
      const waiting = (await h.services.journal.get(TEAM_ID, op.id))!
      expect(waiting).toMatchObject({ kind: "paths", state: "waiting", areaID: main.id })
      const step = waiting.steps[0]!
      expect(step).toMatchObject({ kind: NeedPaths.STEP, mode: "confirm", state: "needs_confirm" })
      expect(step.confirm?.bytes).toBe(F2_LFS["Content/map.bin"] + F2_LFS["Content/src/deep.bin"])
      expect(repo.objects()).toBe(objects)
      expect(await inCone(main, "Content")).toBe(false)

      const confirmed = await h.services.runner.confirm({
        opID: op.id,
        stepID: step.id,
        choice: "do",
        nonce: step.confirm!.nonce,
      })
      expect(confirmed).toMatchObject({ ok: true, op: { state: "done" } })
      expect(repo.objects()).toBe(objects + 2)
      expect(await inCone(main, "Content")).toBe(true)
      expect((await current(main)).cone.extra.Content).toMatchObject({ reason: "map data" })
      expect(synthetic).toHaveLength(1)
      expect(synthetic[0]).toMatchObject({ delivery: "queue", metadata: { source: OwnTeam.PROMPT_SOURCE } })
      expect(String((synthetic[0] as { text: string }).text)).toStartWith("<team-notice>")
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(heavyTeam))
    },
    SLOW,
  )

  test(
    "a failed add is undone with status and reapply: the folder stays out and nothing is left on disk",
    async () => {
      const { spare } = await ready
      repo.clear()
      repo.offline()
      // Claim nothing is missing so no fetch runs: the add itself then fails on the smudge (06 §4.6 실패).
      const counted = await NeedPaths.count(spare.directory, ["Content"], CONE)
      if (!counted.ok) throw new Error(counted.message)
      const applied = await NeedPaths.apply(h.services, {
        area: spare,
        dirs: ["Content"],
        reason: "map data",
        counted: { ...counted, missing: { objects: [], count: 0, bytes: 0 } },
        clean: true,
      })
      repo.online()
      expect(applied).toMatchObject({ ok: false, error: "network" })
      expect(await inCone(spare, "Content")).toBe(false)
      expect(onDisk(spare, "Content/map.bin")).toBe(false)
      expect(status(spare)).toBe("")
      expect((await current(spare)).cone.extra).toEqual({})
    },
    SLOW,
  )

  test(
    "the tool refuses bad names and answers for areas without large-file folders",
    async () => {
      const { main } = await ready
      expect(
        await NeedPathsTool.run(h.services, await caller(main), { dirs: ["../outside"], reason: "x" }),
      ).toMatchObject({ ok: false, error: "path_forbidden" })
      const plain = { ...(await caller(main)), area: { ...(await current(main)), shape: "plain" as const } }
      expect(await NeedPathsTool.run(h.services, plain, { dirs: ["Assets/Textures"], reason: "x" })).toMatchObject({
        ok: true,
        added: [],
        waiting: false,
      })
    },
    SLOW,
  )

  describe("area.paths{add}", () => {
    const rpc = (services: Services.Context) => {
      // SAFETY (test): the handler takes its method's input and `{signal, error}`.
      const loose = PathsRpc.handlers(services) as unknown as Record<
        string,
        (input: unknown, context: unknown) => Promise<unknown>
      >
      return (input: unknown) =>
        loose["area.paths"]!(input, {
          signal: new AbortController().signal,
          error: (type: string, message: string, data: unknown) => ({ type, message, data }),
        })
    }

    test(
      "declared errors for unknown teams and areas, bad names, a team that is off and a broken area",
      async () => {
        const { spare } = await ready
        const call = rpc(h.services)
        expect(await call({ teamID: "tm_000000000000", areaID: spare.id, add: ["Content"] })).toMatchObject({
          type: "not_found",
          data: { what: "team" },
        })
        expect(await call({ teamID: TEAM_ID, areaID: "ar_nope", add: ["Content"] })).toMatchObject({
          type: "not_found",
          data: { what: "area" },
        })
        expect(await call({ teamID: TEAM_ID, areaID: spare.id, add: ["-x"] })).toMatchObject({
          type: "path_forbidden",
          data: { path: "-x", why: "invalid" },
        })
        expect(await call({ teamID: TEAM_ID, areaID: spare.id })).toMatchObject({ type: "path_forbidden" })
        await h.services.write(TEAM_ID, () => h.services.registry.teams.put({ ...heavyTeam, state: "off" }))
        expect(await call({ teamID: TEAM_ID, areaID: spare.id, add: ["Content"] })).toMatchObject({ type: "team_off" })
        await h.services.write(TEAM_ID, async () => {
          await h.services.registry.teams.put(heavyTeam)
          await h.services.registry.areas.put({ ...(await current(spare)), state: "broken" })
        })
        expect(await call({ teamID: TEAM_ID, areaID: spare.id, add: ["Content"] })).toMatchObject({
          type: "broken",
          data: { areaID: spare.id, why: "identity" },
        })
        await h.services.write(TEAM_ID, async () =>
          h.services.registry.areas.put({ ...(await current(spare)), state: "active" }),
        )
      },
      SLOW,
    )

    test(
      "a user's add is an op: done at once under the thresholds, a confirm step over them, busy while one waits",
      async () => {
        const { spare } = await ready
        const call = rpc(h.services)
        const started = (await call({ teamID: TEAM_ID, areaID: spare.id, add: ["Assets/Audio"] })) as {
          readonly opID: OwnTeam.OpID
        }
        await h.services.runner.settled(started.opID)
        expect(await h.services.journal.get(TEAM_ID, started.opID)).toMatchObject({
          kind: "paths",
          by: "user",
          state: "done",
          summary: { lines: [{ kind: "paths", change: "added", dirs: ["Assets/Audio"] }] },
        })
        expect(await inCone(spare, "Assets/Audio")).toBe(true)
        expect((await current(spare)).cone.extra["Assets/Audio"]).toMatchObject({ reason: "user" })

        await h.services.write(TEAM_ID, () =>
          h.services.registry.teams.put({ ...heavyTeam, policy: { ...heavyTeam.policy, askDiskBytes: 1 } }),
        )
        const asked = (await call({ teamID: TEAM_ID, areaID: spare.id, add: ["Content"], reason: "maps" })) as {
          readonly opID: OwnTeam.OpID
        }
        await h.services.runner.settled(asked.opID)
        expect(await h.services.journal.get(TEAM_ID, asked.opID)).toMatchObject({
          state: "waiting",
          steps: [{ kind: NeedPaths.STEP, state: "needs_confirm" }],
        })
        expect(await call({ teamID: TEAM_ID, areaID: spare.id, add: ["Assets/Textures"] })).toMatchObject({
          type: "busy",
          data: { opID: asked.opID, kind: "paths" },
        })
        await h.services.write(TEAM_ID, () => h.services.registry.teams.put(heavyTeam))
      },
      SLOW,
    )
  })
})
