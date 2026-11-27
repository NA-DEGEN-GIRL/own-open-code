// Releasing large-file folders (06 §4.7, TG5 parts on Windows): only at the extended safe point (checked before any
// git command and again right before `set`), only folders whose status prints nothing (modified, staged, untracked
// and ignored files all count), every leaving folder checked, link copies compared with their recorded hash, kept
// folders recorded with the reason and announced once, ignored files never deleted, nothing else in the folder
// touched. The automatic releases (after `done`, an integration's area sync, a rotation) run as by:auto `paths` ops
// at the area's next extended safe point, skip Main 멈춤 (TI-13) and keep what was added automatically. A broken area
// gets no git command (TI-14, TG10). F2 fixture and a fake own service; fake values only.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../../src/assets/need-paths.js"
import { Release } from "../../src/assets/release.js"
import { Cone } from "../../src/git/cone.js"
import { Worktree } from "../../src/git/worktree.js"
import type { Hub } from "../../src/hub.js"
import { PathsRpc } from "../../src/rpc/paths.js"
import type { Services } from "../../src/services.js"
import { F2_HEAVY, F2_LFS, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { git, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { OWNER_SESSION, TEAM_ID, World, area, context, controller, team } from "../support/context.js"
import { session, start } from "../support/service.js"

const SLOW = 180_000
const CONE = ["-dash", "Assets/Scripts", "docs", "src"]

describe.skipIf(!lfsAvailable)("F2: releasing large-file folders (06 §4.7)", () => {
  const box = temp()
  const repo = f2(path.join(box.root, "f2"))
  const world = new World()
  /** The extended safe point: `now`, and `on(n)` runs at the n-th check of a release (`calls` counts them). */
  const safe = {
    now: true,
    calls: 0,
    on: undefined as ((call: number) => void) | undefined,
    /** Holds a check after it read `now`, as the real check's git queries do on a loaded PC. */
    hold: undefined as Promise<void> | undefined,
  }
  const h = controller(world, {
    directory: box.root,
    clock: manual(),
    features: {
      safePoint: () => ({
        check: async () => {
          safe.calls += 1
          safe.on?.(safe.calls)
          const now = safe.now
          await safe.hold
          return now ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }
        },
      }),
    },
  })
  afterAll(async () => {
    await h.close()
    box.dispose()
  })
  afterEach(() => {
    safe.now = true
    safe.calls = 0
    safe.on = undefined
    safe.hold = undefined
  })
  const heavyTeam: OwnTeam.Team = {
    ...team({ home: repo.home }),
    heavy: { dirs: [...F2_HEAVY], measuredAt: repo.head, forcedBytes: 0 },
    env: { symlinkFix: "none", bunCache: "unused", lfs: "system" },
  }
  // Ignored files for the 4.7 "무시된 파일" case: the common dir's exclude applies to every worktree.
  fs.appendFileSync(path.join(repo.home, ".git", "info", "exclude"), "*.tmp\n.worktrees/\n")

  /** A code-only area with `fetched` added through `need_paths` (and `auto` added automatically). */
  async function makeArea(
    slug: string,
    fetched: ReadonlyArray<string>,
    options: { readonly auto?: ReadonlyArray<string>; readonly directory?: string } = {},
  ) {
    const directory = options.directory ?? path.join(box.root, "team", slug)
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
    const fetch = async (dirs: ReadonlyArray<string>, reason: string) => {
      if (dirs.length === 0) return
      const listed = await Cone.list(directory)
      if (!listed.ok) throw new Error(listed.message)
      const counted = await NeedPaths.count(directory, dirs, listed.dirs)
      if (!counted.ok) throw new Error(counted.message)
      const applied = await NeedPaths.apply(h.services, {
        area: (await h.services.registry.areas.get(TEAM_ID, record.id))!,
        dirs,
        reason,
        counted,
        clean: true,
      })
      if (!applied.ok) throw new Error(applied.message)
    }
    await fetch(fetched, "test")
    await fetch(options.auto ?? [], NeedPaths.AUTO)
    return (await h.services.registry.areas.get(TEAM_ID, record.id))!
  }

  const current = async (record: OwnTeam.Area) => (await h.services.registry.areas.get(TEAM_ID, record.id))!
  const cone = async (record: OwnTeam.Area) => {
    const listed = await Cone.list(record.directory)
    if (!listed.ok) throw new Error(listed.message)
    return listed.dirs.toSorted()
  }
  const file = (record: OwnTeam.Area, name: string) => path.join(record.directory, ...name.split("/"))
  const release = async (record: OwnTeam.Area, dirs: ReadonlyArray<string>) =>
    Release.user(h.services, { team: heavyTeam, area: await current(record), dirs })
  const kept = (areaID: string) =>
    h.published.filter(
      (event) => event.name === "notice" && event.data.kind === "paths.kept" && event.data.areaID === areaID,
    )
  const target = (record: OwnTeam.Area) => ({ teamID: TEAM_ID, areaID: record.id })
  const setPaused = (record: OwnTeam.Area, paused: OwnTeam.Paused) =>
    h.services.write(TEAM_ID, async () => h.services.registry.areas.put({ ...(await current(record)), paused }))
  /** The op an automatic release started, once it ended. */
  const settled = async (opID: OwnTeam.OpID) => {
    await h.services.runner.settled(opID)
    return (await h.services.journal.get(TEAM_ID, opID))!
  }

  test(
    "a clean folder leaves the cone: its files go, cone.extra forgets it, everything else stays",
    async () => {
      const record = await makeArea("clean", ["Assets/Textures"])
      write(record.directory, { "src/app/wip.ts": "work in progress\n" })
      expect(fs.existsSync(file(record, "Assets/Textures/rock.png"))).toBe(true)
      const released = await release(record, ["Assets/Textures"])
      expect(released).toEqual({ ok: true, released: ["Assets/Textures"], kept: {} })
      expect(await cone(record)).toEqual(CONE)
      expect(fs.existsSync(file(record, "Assets/Textures"))).toBe(false)
      expect(fs.readFileSync(file(record, "src/app/wip.ts"), "utf8")).toBe("work in progress\n")
      expect(fs.statSync(file(record, "src/icons/logo.png")).size).toBe(F2_LFS["src/icons/logo.png"])
      expect((await current(record)).cone).toEqual({ extra: {}, kept: {} })
      expect(kept(record.id)).toEqual([])
      // The extended safe point is checked before any git command and again right before `set`.
      expect(safe.calls).toBe(2)
    },
    SLOW,
  )

  test(
    "untracked, ignored or modified files keep a folder; the other leaving folder still goes (TG5)",
    async () => {
      const record = await makeArea("dirty", ["Assets/Textures", "Assets/Audio", "Content"])
      write(record.directory, {
        "Assets/Textures/new.png": "agent work",
        "Content/cache.tmp": "ignored",
      })
      fs.appendFileSync(file(record, "Assets/Audio/music.wav"), "changed")
      const released = await release(record, ["Assets/Textures", "Assets/Audio", "Content"])
      expect(released).toEqual({
        ok: true,
        released: [],
        kept: { "Assets/Textures": "dirty", "Assets/Audio": "dirty", Content: "dirty" },
      })
      expect(fs.readFileSync(file(record, "Assets/Textures/new.png"), "utf8")).toBe("agent work")
      expect(fs.readFileSync(file(record, "Content/cache.tmp"), "utf8")).toBe("ignored")
      expect(await cone(record)).toEqual([...CONE, "Assets/Audio", "Assets/Textures", "Content"].toSorted())
      expect(kept(record.id)).toHaveLength(1)

      // The ignored file goes away by hand; that folder is clean now and leaves alone.
      fs.rmSync(file(record, "Content/cache.tmp"))
      const second = await release(record, ["Content", "Assets/Textures"])
      expect(second).toEqual({ ok: true, released: ["Content"], kept: { "Assets/Textures": "dirty" } })
      expect(fs.existsSync(file(record, "Content"))).toBe(false)
      expect(fs.readFileSync(file(record, "Assets/Textures/new.png"), "utf8")).toBe("agent work")
      const after = await current(record)
      expect(Object.keys(after.cone.extra).toSorted()).toEqual(["Assets/Audio", "Assets/Textures"])
      expect(after.cone.kept).toEqual({ "Assets/Textures": "dirty", "Assets/Audio": "dirty" })
    },
    SLOW,
  )

  test(
    "a staged new file keeps its folder; two clean leaving folders go together",
    async () => {
      const record = await makeArea("staged", ["Assets/Textures", "Assets/Audio", "Content"])
      write(record.directory, { "Content/added.txt": "staged work\n" })
      git(record.directory, ["add", "--sparse", "Content/added.txt"])
      const released = await release(record, ["Assets/Textures", "Assets/Audio", "Content"])
      expect(released).toEqual({ ok: true, released: ["Assets/Textures", "Assets/Audio"], kept: { Content: "dirty" } })
      expect(await cone(record)).toEqual([...CONE, "Content"].toSorted())
      expect(fs.existsSync(file(record, "Assets/Textures"))).toBe(false)
      expect(fs.existsSync(file(record, "Assets/Audio"))).toBe(false)
      expect(fs.readFileSync(file(record, "Content/added.txt"), "utf8")).toBe("staged work\n")
      expect(git(record.directory, ["diff", "--cached", "--name-only"]).trim()).toBe("Content/added.txt")
      expect((await current(record)).cone.kept).toEqual({ Content: "dirty" })
    },
    SLOW,
  )

  test(
    "an ignored file made between the check and `set` stops the release; nothing is deleted (TG5)",
    async () => {
      const record = await makeArea("between", ["Assets/Textures", "Assets/Audio"])
      // The second safe-point check runs right before the second status: something writes meanwhile.
      safe.on = (call) => {
        if (call === 2) write(record.directory, { "Assets/Audio/render.tmp": "made meanwhile" })
      }
      const released = await release(record, ["Assets/Textures", "Assets/Audio"])
      expect(released).toEqual({
        ok: true,
        released: [],
        kept: { "Assets/Textures": "changed", "Assets/Audio": "changed" },
      })
      expect(fs.readFileSync(file(record, "Assets/Audio/render.tmp"), "utf8")).toBe("made meanwhile")
      expect(fs.existsSync(file(record, "Assets/Textures/rock.png"))).toBe(true)
      expect(await cone(record)).toEqual([...CONE, "Assets/Audio", "Assets/Textures"].toSorted())
      expect(kept(record.id)).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "a collapsed folder holding only ignored files: `set` would delete them, so nothing is released (T1 review)",
    async () => {
      const record = await makeArea("endangered", ["Assets/Textures"])
      write(record.directory, { "Content/build.tmp": "build output" })
      const released = await release(record, ["Assets/Textures"])
      expect(released).toMatchObject({ ok: false, error: "kept" })
      expect(fs.readFileSync(file(record, "Content/build.tmp"), "utf8")).toBe("build output")
      expect(fs.existsSync(file(record, "Assets/Textures/rock.png"))).toBe(true)
      expect(await cone(record)).toEqual([...CONE, "Assets/Textures"].toSorted())
      expect(Object.keys((await current(record)).cone.extra)).toEqual(["Assets/Textures"])
    },
    SLOW,
  )

  test(
    "a link copy that differs from its recorded hash keeps the folder (4.12)",
    async () => {
      const record = await makeArea("links", ["Assets/Textures"])
      const recorded = git(record.directory, ["hash-object", "Assets/Textures/rock.png"]).trim()
      await h.services.write(TEAM_ID, async () =>
        h.services.registry.areas.put({
          ...(await current(record)),
          linkCopies: { "Assets/Textures/rock.png": recorded.replace(/^./, recorded[0] === "a" ? "b" : "a") },
        }),
      )
      expect(await release(record, ["Assets/Textures"])).toEqual({
        ok: true,
        released: [],
        kept: { "Assets/Textures": "link-copy" },
      })
      expect(fs.existsSync(file(record, "Assets/Textures/rock.png"))).toBe(true)
    },
    SLOW,
  )

  test(
    "not at the extended safe point: nothing changes, the folder is kept as busy and announced",
    async () => {
      const record = await makeArea("busy", ["Assets/Textures"])
      safe.now = false
      const released = await release(record, ["Assets/Textures"])
      expect(released).toEqual({ ok: true, released: [], kept: { "Assets/Textures": "busy" } })
      expect(fs.existsSync(file(record, "Assets/Textures/tree.png"))).toBe(true)
      expect(kept(record.id)).toHaveLength(1)
      expect(safe.calls).toBe(1)
    },
    SLOW,
  )

  test(
    "area.paths{release} runs as a user op with a released summary line",
    async () => {
      const record = await makeArea("rpc", ["Assets/Audio"])
      // SAFETY (test): the handler takes its method's input and `{signal, error}`.
      const loose = PathsRpc.handlers(h.services) as unknown as Record<
        string,
        (input: unknown, context: unknown) => Promise<unknown>
      >
      const started = (await loose["area.paths"]!(
        { teamID: TEAM_ID, areaID: record.id, release: ["Assets/Audio"] },
        {
          signal: new AbortController().signal,
          error: (type: string, message: string, data: unknown) => ({ type, message, data }),
        },
      )) as { readonly opID: OwnTeam.OpID }
      await h.services.runner.settled(started.opID)
      expect(await h.services.journal.get(TEAM_ID, started.opID)).toMatchObject({
        kind: "paths",
        by: "user",
        state: "done",
        summary: {
          lines: [
            { kind: "paths", change: "released", dirs: ["Assets/Audio"], bytes: F2_LFS["Assets/Audio/music.wav"] },
          ],
        },
      })
      expect(await cone(record)).toEqual(CONE)
      await settle(h.services)
    },
    SLOW,
  )

  test(
    "after done: a by:auto paths op releases what need_paths fetched and keeps what was added automatically",
    async () => {
      const record = await makeArea("done", ["Assets/Textures"], { auto: ["Assets/Audio"] })
      const attempt = await Release.onDone(h.services, target(record))
      if (attempt.state !== "started") throw new Error(JSON.stringify(attempt))
      const op = await settled(attempt.opID)
      expect(op).toMatchObject({
        kind: "paths",
        by: "auto",
        areaID: record.id,
        state: "done",
        steps: [{ kind: Release.AUTO_STEP, args: { trigger: "done" }, state: "done" }],
        summary: {
          lines: [
            {
              kind: "paths",
              change: "released",
              dirs: ["Assets/Textures"],
              bytes: F2_LFS["Assets/Textures/rock.png"] + F2_LFS["Assets/Textures/tree.png"],
            },
          ],
        },
      })
      expect(await cone(record)).toEqual([...CONE, "Assets/Audio"].toSorted())
      expect(fs.existsSync(file(record, "Assets/Textures"))).toBe(false)
      expect(fs.statSync(file(record, "Assets/Audio/music.wav")).size).toBe(F2_LFS["Assets/Audio/music.wav"])
      expect(Object.keys((await current(record)).cone.extra)).toEqual(["Assets/Audio"])
      // Nothing fetched is left: the next trigger has nothing to do.
      expect(await Release.afterRotate(h.services, target(record))).toEqual({ state: "skipped", why: "nothing" })
    },
    SLOW,
  )

  test(
    "done in the middle of a turn: the release waits for the extended safe point, then runs once (TG5)",
    async () => {
      const record = await makeArea("midturn", ["Assets/Textures"])
      safe.now = false
      expect(await Release.onDone(h.services, target(record))).toEqual({ state: "waiting", why: "busy" })
      expect(await h.services.journal.active(TEAM_ID)).toBeUndefined()
      // Another run of the folder ends while it is still busy: still waiting, nothing touched.
      h.controller.hub.receive(ended())
      await Bun.sleep(200)
      expect(await h.services.journal.active(TEAM_ID)).toBeUndefined()
      expect(fs.existsSync(file(record, "Assets/Textures/rock.png"))).toBe(true)
      safe.now = true
      h.controller.hub.receive(ended())
      const op = await until(async () =>
        (await h.services.journal.list(TEAM_ID)).find(
          (item) => item.areaID === record.id && item.by === "auto" && item.state === "done",
        ),
      )
      expect(op.steps).toMatchObject([{ kind: Release.AUTO_STEP, args: { trigger: "done" }, state: "done" }])
      expect(await cone(record)).toEqual(CONE)
      const ops = (await h.services.journal.list(TEAM_ID)).filter((item) => item.areaID === record.id)
      expect(ops.filter((item) => item.by === "auto")).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "a run that ends while a try is still reading the folder: the release is tried once more after that try",
    async () => {
      const record = await makeArea("late", ["Assets/Textures"])
      const gate = Promise.withResolvers<void>()
      safe.now = false
      safe.hold = gate.promise
      const first = Release.onDone(h.services, target(record))
      // The first check saw the folder busy and has not answered yet.
      await until(async () => (safe.calls === 1 ? true : undefined))
      safe.now = true
      safe.hold = undefined
      // The only run of the folder ends now: no later event wakes the release.
      h.controller.hub.receive(ended())
      await Bun.sleep(50)
      expect(safe.calls).toBe(1)
      gate.resolve()
      const attempt = await first
      if (attempt.state !== "started") throw new Error(JSON.stringify(attempt))
      const op = await settled(attempt.opID)
      expect(op).toMatchObject({ by: "auto", areaID: record.id, state: "done" })
      expect(await cone(record)).toEqual(CONE)
    },
    SLOW,
  )

  test(
    "after an integration: while the team runs another op the release waits, and starts when that op ends",
    async () => {
      const record = await makeArea("integrate", ["Assets/Textures"])
      // An op of the team that waits for a confirm (a fetch over the thresholds).
      const asked = await NeedPaths.ask(h.services, {
        team: heavyTeam,
        area: await current(record),
        dirs: ["Content"],
        reason: "x",
        notify: false,
        by: "user",
      })
      if (!asked.ok) throw new Error("busy")
      await h.services.runner.settled(asked.op.id)
      expect(await Release.afterIntegrate(h.services, target(record))).toEqual({ state: "waiting", why: "op" })
      const step = (await h.services.journal.get(TEAM_ID, asked.op.id))!.steps[0]!
      await h.services.runner.confirm({
        opID: asked.op.id,
        stepID: step.id,
        choice: "skip",
        nonce: step.confirm!.nonce,
      })
      const op = await until(async () =>
        (await h.services.journal.list(TEAM_ID)).find(
          (item) => item.areaID === record.id && item.by === "auto" && item.state === "done",
        ),
      )
      expect(op.steps).toMatchObject([{ kind: Release.AUTO_STEP, args: { trigger: "integrate" } }])
      expect(await cone(record)).toEqual(CONE)
    },
    SLOW,
  )

  test(
    "Main 멈춤 skips the automatic releases (TI-13); the user's release still runs",
    async () => {
      const record = await makeArea("paused", ["Assets/Textures", "Assets/Audio"])
      await setPaused(record, "user")
      expect(await Release.onDone(h.services, target(record))).toEqual({ state: "skipped", why: "paused" })
      expect(await Release.afterRotate(h.services, target(record))).toEqual({ state: "skipped", why: "paused" })
      expect(await h.services.journal.active(TEAM_ID)).toBeUndefined()
      expect(await cone(record)).toEqual([...CONE, "Assets/Audio", "Assets/Textures"].toSorted())
      // An automatic release step that finds Main 멈춤 on when it runs is skipped as well.
      Release.register(h.services)
      const started = await h.services.runner.start({
        teamID: TEAM_ID,
        kind: "paths",
        by: "auto",
        areaID: record.id,
        steps: [Release.auto({ areaID: record.id, trigger: "rotate" })],
      })
      if (!started.ok) throw new Error("busy")
      expect(await settled(started.op.id)).toMatchObject({ state: "done", steps: [{ state: "skipped" }] })
      expect(await cone(record)).toEqual([...CONE, "Assets/Audio", "Assets/Textures"].toSorted())
      expect(await release(record, ["Assets/Audio"])).toEqual({ ok: true, released: ["Assets/Audio"], kept: {} })
      await setPaused(record, false)
    },
    SLOW,
  )

  test(
    "TI-14, TG10: a broken area and a nested area without its .git get no release; the home is unchanged",
    async () => {
      const broken = await makeArea("broken", ["Assets/Textures"])
      await h.services.write(TEAM_ID, async () =>
        h.services.registry.areas.put({ ...(await current(broken)), state: "broken" }),
      )
      expect(await Release.onDone(h.services, target(broken))).toEqual({ state: "skipped", why: "inactive" })
      expect(await release(broken, ["Assets/Textures"])).toMatchObject({ ok: false, error: "broken" })
      expect(safe.calls).toBe(0)
      expect(fs.existsSync(file(broken, "Assets/Textures/rock.png"))).toBe(true)

      const nested = await makeArea("nested", ["Assets/Textures"], {
        directory: path.join(repo.home, ".worktrees", "nested"),
      })
      fs.rmSync(path.join(nested.directory, ".git"))
      const before = git(repo.home, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])
      expect(await release(nested, ["Assets/Textures"])).toMatchObject({ ok: false, error: "broken" })
      expect(fs.existsSync(file(nested, "Assets/Textures/rock.png"))).toBe(true)
      expect(Bun.spawnSync(["git", "-C", repo.home, "config", "--get", "core.sparseCheckout"]).exitCode).not.toBe(0)
      expect(git(repo.home, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(before)
      expect(fs.existsSync(path.join(repo.home, "Content", "map.bin"))).toBe(true)
    },
    SLOW,
  )
})

// The real safe point over a fake own service: a running pty of the area's live Location means it is not at the
// extended safe point (8.4), so neither release runs a git command.
describe("a pty in the area folder", () => {
  const box = temp("own-team-release-pty-")
  const service = start()
  afterAll(async () => {
    await service.stop()
    box.dispose()
  })

  test("the user's release keeps the folders as busy and an automatic one waits", async () => {
    const home = init(path.join(box.root, "home"))
    const folder = path.join(box.root, "home-team", "ui")
    fs.mkdirSync(path.join(folder, ".git"), { recursive: true })
    const ptys = [{ id: "pty_1", status: "running", cwd: folder }]
    service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    service.routes.set("GET /api/session", () => Response.json({ data: [], cursor: {} }))
    service.routes.set("GET /api/shell", () => Response.json({ data: [] }))
    service.routes.set("GET /api/pty", () => Response.json({ data: ptys }))
    for (const route of ["inbox", "permission", "form"])
      service.routes.set(`GET /api/session/${OWNER_SESSION}/${route}`, () => Response.json({ data: [] }))
    service.routes.set(`GET /api/session/${OWNER_SESSION}`, () =>
      Response.json({ data: session({ id: OWNER_SESSION, directory: folder }) }),
    )
    const world = new World()
    const h = controller(world, { directory: home, clock: manual(), source: service.source })
    const record: OwnTeam.Area = {
      ...area({ slug: "ui", directory: folder }),
      shape: "code",
      cone: { extra: { Assets: { reason: "test", at: 0, bytes: 1 } }, kept: {} },
    }
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team({ home }))
      await h.services.registry.areas.put(record)
    })
    // The area folder's Location is up, so its ptys are read.
    const detach = h.controller.attach({
      ctx: context(world, { directory: folder }).ctx,
      directory: folder,
      control: false,
      leader: () => false,
    })
    expect(
      await h.services.features().safePoint.check({ teamID: TEAM_ID, areaID: record.id, extended: true }),
    ).toMatchObject({ ok: false, why: "pty" })
    expect(await Release.user(h.services, { team: team({ home }), area: record, dirs: ["Assets"] })).toEqual({
      ok: true,
      released: [],
      kept: { Assets: "busy" },
    })
    expect((await h.services.registry.areas.get(TEAM_ID, record.id))?.cone.kept).toEqual({ Assets: "busy" })
    expect(await Release.onDone(h.services, { teamID: TEAM_ID, areaID: record.id })).toEqual({
      state: "waiting",
      why: "busy",
    })
    expect(await h.services.journal.active(TEAM_ID)).toBeUndefined()
    detach()
    await h.close()
  })
})

/** Lets background op runs finish before the fixture folder goes away. */
async function settle(services: Services.Context) {
  const op = await services.journal.active(TEAM_ID)
  if (op) await services.runner.settled(op.id)
}

function ended(): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return {
    id: `evt_${crypto.randomUUID()}`,
    created: 1,
    type: "session.execution.succeeded",
    data: { sessionID: OWNER_SESSION },
  } as never
}

async function until<T>(find: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = await find()
    if (found !== undefined) return found
    await Bun.sleep(20)
  }
  throw new Error("condition not reached")
}
