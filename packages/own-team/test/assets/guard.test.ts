// The lazy-asset leak guards (06 §4.9 items 1-2, TG6 plugin parts) and the session lookup the team hooks share: who a
// session is by registry id and where it works by location (subagents and replaced owners have no role; a subagent of
// the main belongs to the main's tree), the pre-write deny for heavy folders outside the cone, the pre-write add of a
// non-heavy folder, and the after-tool fix that brings a heavy folder written by a command into the cone without
// deleting anything. F2 fixture; every session and value is fake.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import { Guard } from "../../src/assets/guard.js"
import { NeedPaths } from "../../src/assets/need-paths.js"
import { Cone } from "../../src/git/cone.js"
import { Worktree } from "../../src/git/worktree.js"
import { F2_HEAVY, F2_LFS, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { git, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OLD_OWNER, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"

const SLOW = 180_000
const CONE = ["-dash", "Assets/Scripts", "docs", "src"]
const CHILD = SessionID.make("ses_child000000000000000000001")
const MAIN_CHILD = SessionID.make("ses_mainchild0000000000000001")
const GRANDCHILD = SessionID.make("ses_grandchild000000000000001")
const STRANGER = SessionID.make("ses_stranger00000000000000001")
/** Core gives every tool call its own id; the shell's before and after hooks pair by it (06 §4.8). */
const callID = () => `call_${crypto.randomUUID()}`

/** The fake context with `parentID` on `session.get` (the shared fake has no parents). */
function withParents(base: Plugin.Context, parents: ReadonlyMap<string, SessionID>): Plugin.Context {
  return new Proxy(base, {
    get: (target, key) => {
      if (key !== "session") return target[key as keyof Plugin.Context]
      return {
        ...target.session,
        get: async (input: { readonly sessionID: SessionID }) => ({
          ...(await target.session.get(input)),
          ...(parents.has(input.sessionID) ? { parentID: parents.get(input.sessionID) } : {}),
        }),
      }
    },
  })
}

describe.skipIf(!lfsAvailable)("F2: guards of a code-only area", () => {
  const box = temp()
  const repo = f2(path.join(box.root, "f2"))
  const world = new World()
  const h = controller(world, { directory: box.root, clock: manual() })
  h.detach()
  h.controller.attach({
    ctx: withParents(
      h.fake.ctx,
      new Map([
        [CHILD, OWNER_SESSION],
        [MAIN_CHILD, MAIN_SESSION],
        [GRANDCHILD, MAIN_CHILD],
      ]),
    ),
    directory: box.root,
    control: true,
    leader: () => true,
  })
  afterAll(async () => {
    await h.close()
    box.dispose()
  })
  const heavyTeam: OwnTeam.Team = {
    ...team({ home: repo.home }),
    heavy: { dirs: [...F2_HEAVY], measuredAt: repo.head, forcedBytes: 0 },
    env: { symlinkFix: "none", bunCache: "unused", lfs: "system" },
  }

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
    for (const id of [OWNER_SESSION, CHILD, OLD_OWNER]) world.sessions.set(id, { id, directory, permissions: [] })
    for (const id of [MAIN_SESSION, MAIN_CHILD, GRANDCHILD, STRANGER])
      world.sessions.set(id, { id, directory: repo.home, permissions: [] })
    return record
  }

  const current = async (record: OwnTeam.Area) => (await h.services.registry.areas.get(TEAM_ID, record.id))!
  const cone = async (record: OwnTeam.Area) => {
    const listed = await Cone.list(record.directory)
    if (!listed.ok) throw new Error(listed.message)
    return listed.dirs.toSorted()
  }
  const file = (record: OwnTeam.Area, name: string) => path.join(record.directory, ...name.split("/"))
  const added = (areaID: string) =>
    h.published.flatMap((event) =>
      event.name === "notice" && event.data.kind === "paths.added" && event.data.areaID === areaID ? [event.data] : [],
    )

  test("no team: no subject", async () => {
    expect(await Guard.subject(h.services, OWNER_SESSION)).toBeUndefined()
  })

  test(
    "subjects: roles by registry id, folders by location, the main's tree by parent",
    async () => {
      const record = await makeArea("lookup")
      expect(await Guard.subject(h.services, OWNER_SESSION)).toMatchObject({
        role: { kind: "owner", area: { id: record.id } },
        area: { id: record.id },
        directory: record.directory,
        main: false,
      })
      const child = await Guard.subject(h.services, CHILD)
      expect(child).toMatchObject({ area: { id: record.id }, main: false })
      expect(child?.role).toBeUndefined()
      expect((await Guard.subject(h.services, OLD_OWNER))?.role).toBeUndefined()
      expect(await Guard.subject(h.services, MAIN_SESSION)).toMatchObject({ role: { kind: "main" }, main: true })
      const grandchild = await Guard.subject(h.services, GRANDCHILD)
      expect(grandchild).toMatchObject({ main: true })
      expect(grandchild?.role).toBeUndefined()
      // A conversation of its own at the main folder is not the team's.
      expect(await Guard.subject(h.services, STRANGER)).toBeUndefined()
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put({ ...heavyTeam, state: "off" }))
      expect(await Guard.subject(h.services, OWNER_SESSION)).toBeUndefined()
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(heavyTeam))
    },
    SLOW,
  )

  test(
    "edit: a heavy folder outside the cone is denied with the 4.9 message; the cone, new folders and outside pass",
    async () => {
      const record = await makeArea("edit")
      const subject = (await Guard.subject(h.services, CHILD))!
      expect(await Guard.edit(subject, ["Assets/Textures/rock.png"])).toBe(Guard.message("Assets/Textures"))
      expect(Guard.message("Assets/Models")).toBe(
        "이 영역에 받지 않은 큰 파일 폴더예요: `Assets/Models`. 필요하면 먼저 team_need_paths를 부르세요.",
      )
      expect(await Guard.edit(subject, ["Content/new/map.bin", "src/app/main.ts"])).toBe(Guard.message("Content"))
      expect(await Guard.edit(subject, ["src/app/main.ts", "README.md", "Assets/banner.png"])).toBeUndefined()
      expect(await Guard.edit(subject, ["newpkg/a.ts"])).toBeUndefined()
      expect(await Guard.edit(subject, [path.join(box.root, "elsewhere", "x.ts")])).toBeUndefined()
      // Resources are relative to the session's location: from `Assets/` the same file.
      expect(
        await Guard.edit({ ...subject, directory: path.join(record.directory, "Assets") }, ["Textures/rock.png"]),
      ).toBe(Guard.message("Assets/Textures"))
      // A folder that holds only a heavy folder cannot enter the cone without it.
      const nested = { ...subject, team: { ...heavyTeam, heavy: { ...heavyTeam.heavy, dirs: ["Content/src"] } } }
      expect(await Guard.edit(nested, ["Content/new.txt"])).toBe(Guard.message("Content/src"))
      // Not code-only: nothing to guard.
      expect(
        await Guard.edit({ ...subject, area: { ...subject.area!, shape: "plain" } }, ["Content/x"]),
      ).toBeUndefined()
      // In the cone after a fetch.
      const counted = await NeedPaths.count(record.directory, ["Assets/Textures"], CONE)
      if (!counted.ok) throw new Error(counted.message)
      await NeedPaths.apply(h.services, {
        area: record,
        dirs: ["Assets/Textures"],
        reason: "x",
        counted,
        clean: true,
      })
      expect(await Guard.edit(subject, ["Assets/Textures/rock.png"])).toBeUndefined()
    },
    SLOW,
  )

  test(
    "before: a write into a new folder outside the cone adds its narrowest folder; heavy and in-cone targets do not",
    async () => {
      const record = await makeArea("before")
      const call = (tool: string, input: unknown) =>
        Guard.before(h.services, { tool, sessionID: CHILD, id: callID(), input })
      await call("write", { path: "newpkg/sub/a.ts", content: "x" })
      await call("edit", { path: "Assets/Textures/rock.png", oldString: "a", newString: "b" })
      await call("write", { path: "src/app/other.ts", content: "x" })
      await call("patch", {
        patchText:
          "*** Begin Patch\n*** Add File: tools2/b.ts\n+x\n*** Update File: src/app/main.ts\n@@\n*** End Patch\n",
      })
      // The codex harness's apply_patch: freeform text, or {input}.
      await call("apply_patch", "*** Begin Patch\n*** Add File: tools3/c.ts\n+x\n*** End Patch\n")
      await call("apply_patch", { input: "*** Begin Patch\n*** Add File: tools4/d.ts\n+x\n*** End Patch\n" })
      await call("shell", { command: "echo" })
      await call("exec_command", { cmd: "echo" })
      // The dsh harness's write and edit name the file `file_path`; its shell is `pwsh` on Windows.
      await call("write", { file_path: "tools5/e.ts", content: "x" })
      await call("pwsh", { description: "d", command: "echo" })
      await call("write", { nonsense: true })
      expect(await cone(record)).toEqual([...CONE, "newpkg/sub", "tools2", "tools3", "tools4", "tools5"].toSorted())
      const extra = (await current(record)).cone.extra
      expect(Object.keys(extra).toSorted()).toEqual(["newpkg/sub", "tools2", "tools3", "tools4", "tools5"])
      expect(extra["tools2"]?.reason).toBe(NeedPaths.AUTO)
      expect(fs.existsSync(file(record, "Assets/Textures"))).toBe(false)
    },
    SLOW,
  )

  test(
    "after: a file a command wrote into a heavy folder is brought in at its narrowest folder; the rest folds back",
    async () => {
      const record = await makeArea("after")
      await Guard.after(h.services, { tool: "shell", sessionID: CHILD, id: callID() })
      expect(added(record.id)).toEqual([])
      write(record.directory, { "Assets/Textures/ui/new.png": "agent work" })
      await Guard.after(h.services, { tool: "read", sessionID: CHILD, id: callID() })
      expect(await cone(record)).toEqual(CONE)
      await Guard.after(h.services, { tool: "shell", sessionID: CHILD, id: callID() })
      expect(await cone(record)).toEqual([...CONE, "Assets/Textures/ui"].toSorted())
      expect(fs.readFileSync(file(record, "Assets/Textures/ui/new.png"), "utf8")).toBe("agent work")
      // Cone mode checks out the files around a cone folder: the heavy folder's own files come with it.
      expect(fs.statSync(file(record, "Assets/Textures/rock.png")).size).toBe(F2_LFS["Assets/Textures/rock.png"])
      expect(fs.existsSync(file(record, "Assets/Audio"))).toBe(false)
      expect((await current(record)).cone.extra["Assets/Textures/ui"]?.reason).toBe(NeedPaths.AUTO)
      expect(added(record.id)).toHaveLength(1)
      expect(added(record.id)[0]?.text).toBe(`${record.name}: ${Guard.FIXED_TEXT}`)
    },
    SLOW,
  )

  test(
    "after: a clean tracked file written out of the cone (an `lfs checkout`) folds back; nothing is added",
    async () => {
      const record = await makeArea("folds")
      write(record.directory, { "Content/map.bin": git(record.directory, ["show", "HEAD:Content/map.bin"]) })
      await Guard.after(h.services, { tool: "shell", sessionID: CHILD, id: callID() })
      expect(fs.existsSync(file(record, "Content/map.bin"))).toBe(false)
      expect(await cone(record)).toEqual(CONE)
      expect(added(record.id)).toEqual([])
      expect(git(record.directory, ["status", "--porcelain=v2", "-z"])).toBe("")
    },
    SLOW,
  )

  test(
    "after: over the thresholds the files stay and a confirm waits; nothing is folded back meanwhile",
    async () => {
      const record = await makeArea("confirm")
      await h.services.write(TEAM_ID, () =>
        h.services.registry.teams.put({ ...heavyTeam, policy: { ...heavyTeam.policy, askDiskBytes: 1 } }),
      )
      write(record.directory, { "Content/new.bin": "agent work" })
      await Guard.after(h.services, { tool: "write", sessionID: CHILD, id: callID() })
      const op = await h.services.journal.active(TEAM_ID)
      if (!op) throw new Error("no paths op")
      await h.services.runner.settled(op.id)
      expect(await h.services.journal.get(TEAM_ID, op.id)).toMatchObject({
        kind: "paths",
        by: "auto",
        state: "waiting",
        steps: [{ kind: NeedPaths.STEP, mode: "confirm", args: { dirs: ["Content"], reason: NeedPaths.AUTO } }],
      })
      expect(fs.readFileSync(file(record, "Content/new.bin"), "utf8")).toBe("agent work")
      expect(await cone(record)).toEqual(CONE)
      const step = (await h.services.journal.get(TEAM_ID, op.id))!.steps[0]!
      await h.services.runner.confirm({ opID: op.id, stepID: step.id, choice: "skip", nonce: step.confirm!.nonce })
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(heavyTeam))
    },
    SLOW,
  )

  test(
    "an ignored-only stray left for the user's confirm survives a later pre-write add and a fetch",
    async () => {
      const record = await makeArea("ignored")
      // Before the controller holds its lock the guards change no cone at all (the registry write would wait).
      await Guard.before(
        { ...h.services, started: () => false },
        { tool: "write", sessionID: CHILD, id: callID(), input: { path: "early/b.ts", content: "x" } },
      )
      expect(await cone(record)).toEqual(CONE)
      await h.services.write(TEAM_ID, () =>
        h.services.registry.teams.put({ ...heavyTeam, policy: { ...heavyTeam.policy, askDiskBytes: 1 } }),
      )
      // Build output a command left in a heavy folder, ignored by the project.
      write(record.directory, { ".gitignore": "*.cache\n", "Content/out.cache": "build output" })
      await Guard.after(h.services, { tool: "shell", sessionID: CHILD, id: callID() })
      const op = await h.services.journal.active(TEAM_ID)
      if (!op) throw new Error("no paths op")
      await h.services.runner.settled(op.id)
      expect(await h.services.journal.get(TEAM_ID, op.id)).toMatchObject({ kind: "paths", state: "waiting" })
      // git deletes a collapsed folder that holds only ignored files on any cone change: the pre-write add of a new
      // folder does not run meanwhile, nor does a fetch the owner asks for.
      await Guard.before(h.services, {
        tool: "write",
        sessionID: CHILD,
        id: callID(),
        input: { path: "newpkg/a.ts", content: "x" },
      })
      const counted = await NeedPaths.count(record.directory, ["Assets/Audio"], CONE)
      if (!counted.ok) throw new Error(counted.message)
      const fetched = await NeedPaths.apply(h.services, {
        area: record,
        dirs: ["Assets/Audio"],
        reason: "x",
        counted,
        clean: true,
      })
      expect(fetched).toMatchObject({ ok: false, error: "kept" })
      expect(fs.readFileSync(file(record, "Content/out.cache"), "utf8")).toBe("build output")
      expect(await cone(record)).toEqual(CONE)
      const step = (await h.services.journal.get(TEAM_ID, op.id))!.steps[0]!
      await h.services.runner.confirm({ opID: op.id, stepID: step.id, choice: "skip", nonce: step.confirm!.nonce })
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(heavyTeam))
    },
    SLOW,
  )
})
