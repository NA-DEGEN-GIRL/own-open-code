// Converting an area folder (06 §8.2 전체 → 코드 전용 / 코드 전용 → 전체, §4.7, §4.12, §4.14; TG12 convert and link-copy
// area parts, TG19 record): the owner is replaced first, then at the extended safe point every leaving folder is
// checked whole (tracked changes, untracked and ignored files, the link-copy record), the link copies are re-flagged
// for the new shape, everything is checked again right before `set` (Cone.endangered included), and the folder ends
// folded with index.sparse and no type change. Ignored files make it ask first with their list and bytes (a confirm
// that holds back the rotation: 두기 replaces no owner); uncommitted work refuses it; an identity mismatch writes
// nothing; Main 멈춤 and a busy folder skip an automatic conversion; a detached HEAD's commits are kept first. code →
// full is `sparse-checkout disable` behind a confirm with the bytes and the download. A repository with ordinary blobs (no git-lfs), core.symlinks=false links made through plumbing, a fake
// own service on 127.0.0.1 and a manual clock; fake values only.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Symlinks } from "../../src/assets/symlinks.js"
import { Convert } from "../../src/reorg/convert.js"
import { Rotation } from "../../src/sessions/rotate.js"
import { Backend } from "../fixtures/reconcile.js"
import { git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"

/** Git process starts are slow on Windows. */
const SLOW = 180_000
const HEAVY = ["Assets/Textures", "Content"] as const
const CONE = ["Assets/Scripts", "docs", "src"]
/** Link entries (path → link text): three in the cone (a file, a folder, a root file), one in a heavy folder. */
const LINKS = {
  "docs/guide-link.md": "guide.md",
  "src/app/lib": "../lib",
  "README-link.md": "README.md",
  "Content/readme-link.md": "../README.md",
} as const
const IN_CONE = ["README-link.md", "docs/guide-link.md", "src/app/lib"]

describe("Convert: full ↔ code-only (06 §8.2)", () => {
  const box = temp("own-team-convert-")
  const repo = build(path.join(box.root, "repo"))
  const world = new World()
  const backend = new Backend()
  const clock = manual()
  /** The extended safe point: `now`, and `on(n)` runs at the n-th check (`calls` counts them). */
  const safe = { now: true, calls: 0, on: undefined as ((call: number) => void) | undefined }
  const h = controller(world, {
    directory: box.root,
    clock,
    source: backend.service.source,
    features: {
      safePoint: () => ({
        check: async () => {
          safe.calls += 1
          safe.on?.(safe.calls)
          return safe.now ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }
        },
      }),
      // The rotation's own parts are tested in test/sessions/rotate.test.ts: here the new owner and the handoff
      // document are written straight into the registry.
      owner: (services) => ({
        create: async (input) => {
          const sessionID = SessionID.create()
          await services.write(input.teamID, async () => {
            const current = await services.registry.areas.get(input.teamID, input.areaID)
            if (current)
              await services.registry.areas.put({ ...current, owner: { ...current.owner, pending: sessionID } })
          })
          return { ok: true, sessionID }
        },
        attach: async () => ({ ok: true }),
      }),
      handoff: (services) => ({
        write: async (input) => {
          await services.write(input.teamID, async () => {
            const current = await services.registry.areas.get(input.teamID, input.areaID)
            if (current)
              await services.registry.areas.put({
                ...current,
                handoff: { file: "handoff.md", hash: "fake-hash", at: services.clock.now() },
              })
          })
          return { ok: true, file: "handoff.md", hash: "fake-hash" }
        },
        program: async () => ({ ok: true, text: "# 인계\n" }),
        read: async () => "# 인계\n",
      }),
    },
  })
  const heavyTeam: OwnTeam.Team = {
    ...team({ home: repo.home }),
    heavy: { dirs: [...HEAVY], measuredAt: repo.head, forcedBytes: 0 },
    env: { symlinkFix: "skip-worktree", bunCache: "unused", lfs: "unused" },
  }
  afterAll(async () => {
    await h.close()
    await backend.service.stop()
    box.dispose()
  })
  afterEach(() => {
    safe.now = true
    safe.calls = 0
    safe.on = undefined
  })

  let count = 0

  /** A full linked worktree with the home's link copies (skip-worktree, recorded) and its area record. */
  async function makeArea(options: { readonly owner?: SessionID; readonly paused?: OwnTeam.Paused } = {}) {
    const slug = `full${++count}`
    const directory = path.join(box.root, "team", slug)
    git(repo.home, ["worktree", "add", "-q", "-b", slug, directory, repo.head])
    const gitDir = git(directory, ["rev-parse", "--absolute-git-dir"]).trim()
    const applied = await Symlinks.apply({ area: { directory, gitDir, shape: "full" }, fix: "skip-worktree" })
    if (!applied.ok) throw new Error(applied.message)
    const record: OwnTeam.Area = {
      ...area({ slug, directory }),
      origin: "adopted",
      shape: "full",
      gitDir,
      linkCopies: { ...applied.linkCopies },
      paused: options.paused ?? false,
      // An adopted folder: its conversation never got the team (a program handoff), or none at all.
      owner: { sessionID: options.owner ?? null, previous: [], attached: false },
    }
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(heavyTeam)
      await h.services.registry.areas.put(record)
    })
    return record
  }

  const current = async (record: OwnTeam.Area) => (await h.services.registry.areas.get(TEAM_ID, record.id))!
  const file = (record: OwnTeam.Area, name: string) => path.join(record.directory, ...name.split("/"))
  const op = async (opID: OwnTeam.OpID) => {
    await h.services.runner.settled(opID)
    return (await h.services.journal.get(TEAM_ID, opID))!
  }
  const start = async (record: OwnTeam.Area, shape: Convert.Shape, by: OwnTeam.Op["by"] = "user") => {
    const started = await Convert.start(h.services, { teamID: TEAM_ID, areaID: record.id, shape, by })
    if (!started.ok) throw new Error(`${started.error}: ${started.message}`)
    return op(started.opID)
  }
  /** An op of exactly `steps`, bypassing {@link Convert.start}'s check (what a reorganization op carries). */
  const run = async (record: OwnTeam.Area, steps: ReturnType<typeof Convert.steps>, by: OwnTeam.Op["by"] = "user") => {
    Convert.register(h.services)
    const started = await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by, areaID: record.id, steps })
    if (!started.ok) throw new Error("busy")
    return op(started.op.id)
  }
  const confirm = async (opID: OwnTeam.OpID, choice: "do" | "skip") => {
    const waiting = (await h.services.journal.get(TEAM_ID, opID))!
    const step = waiting.steps.find((item) => item.state === "needs_confirm")!
    const answered = await h.services.runner.confirm({ opID, stepID: step.id, choice, nonce: step.confirm!.nonce })
    if (!answered.ok) throw new Error(answered.message)
    return op(opID)
  }
  const stepOf = (done: OwnTeam.Op, kind: string) => done.steps.find((item) => item.kind === kind)!

  test(
    "full → code at the extended safe point: folded heavy folders, index.sparse, clean status, no type change",
    async () => {
      const record = await makeArea()
      write(record.directory, { "src/app/wip.ts": "work in progress\n" })
      expect(tags(record.directory)).toEqual(Object.fromEntries(Object.keys(LINKS).map((link) => [link, "S"])))

      const done = await start(record, "code")

      expect(done.state).toBe("done")
      // No owner conversation: nothing to replace, only the conversion.
      expect(done.steps.map((step) => step.kind)).toEqual([Convert.STEP.code])
      expect(done.summary?.lines).toContainEqual({ kind: "area", areaID: record.id, change: "converted" })
      // Checked before any git command (observe) and again right before `set`.
      expect(safe.calls).toBe(2)
      const after = await current(record)
      expect(after.shape).toBe("code")
      expect(sparse(record.directory, ["ls-files", "--sparse", "-t", "-z"]).split("\0")).toEqual(
        expect.arrayContaining(["S Assets/Textures/", "S Content/"]),
      )
      expect(git(record.directory, ["config", "--worktree", "--get", "index.sparse"]).trim()).toBe("true")
      expect(sparse(record.directory, ["sparse-checkout", "list"]).trim().split("\n")).toEqual(CONE)
      expect(sparse(record.directory, ["status", "--porcelain=v2", "-z", "--untracked-files=no"])).toBe("")
      // 0 mode 120000 → 100644 changes: add -A would stage the untracked work file only, nothing differs from HEAD.
      expect(sparse(record.directory, ["add", "-A", "--dry-run"])).toBe("add 'src/app/wip.ts'\n")
      expect(sparse(record.directory, ["diff", "--summary", "HEAD"])).toBe("")
      // The copies in the cone stay copies, now assume-unchanged; the one in the folded folder left with it.
      expect(tags(record.directory, IN_CONE)).toEqual(Object.fromEntries(IN_CONE.map((link) => [link, "h"])))
      expect(fs.readFileSync(file(record, "README-link.md"), "utf8")).toBe("# convert\n")
      expect(fs.readFileSync(file(record, "src/app/lib/util.ts"), "utf8")).toBe("export const util = 2\n")
      expect(Object.keys(after.linkCopies ?? {}).toSorted()).toEqual(IN_CONE.toSorted())
      expect(fs.existsSync(file(record, "Content"))).toBe(false)
      expect(fs.existsSync(file(record, "Assets/Textures"))).toBe(false)
      expect(fs.existsSync(file(record, "Assets/Textures.meta"))).toBe(true)
      expect(fs.readFileSync(file(record, "src/app/wip.ts"), "utf8")).toBe("work in progress\n")
    },
    SLOW,
  )

  test(
    "the owner conversation is replaced first (reason worktree), then the folder is converted",
    async () => {
      const owner = SessionID.create()
      const record = await makeArea({ owner })
      backend.add(owner, record.directory)

      const planned = Convert.steps({ area: record, shape: "code", mode: "auto", by: "user" })
      expect(planned.map((step) => step.kind)).toEqual([
        Rotation.KIND.begin,
        Rotation.KIND.handoff,
        Rotation.KIND.owner,
        Rotation.KIND.swap,
        Rotation.KIND.archive,
        Convert.STEP.code,
      ])
      // An owner that never got the team is replaced with a program handoff (T2.15).
      expect(planned[1]?.args).toMatchObject({ handoff: "program" })

      const done = await start(record, "code")

      expect(done.state).toBe("done")
      expect(done.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done", "done"])
      const after = await current(record)
      expect(after.owner.sessionID).not.toBe(owner)
      expect(after.owner.previous).toEqual([{ sessionID: owner, endedAt: clock.now(), why: "worktree" }])
      expect(after.shape).toBe("code")
      expect(done.summary?.lines).toEqual([
        { kind: "area", areaID: record.id, change: "rotated" },
        { kind: "area", areaID: record.id, change: "converted" },
      ])
    },
    SLOW,
  )

  test(
    "ignored files in a leaving folder: a confirm with their list and bytes; 두기 changes nothing, do deletes them",
    async () => {
      const record = await makeArea()
      write(record.directory, { "Content/cache.tmp": "c".repeat(1_234), "Assets/Textures/thumbs.tmp": "t".repeat(99) })

      const checked = await Convert.check({ team: heavyTeam, area: record, shape: "code" })
      expect(checked).toMatchObject({ ok: true, mode: "confirm" })
      const asked = await start(record, "code")

      expect(asked.state).toBe("waiting")
      expect(asked.steps.map((item) => [item.kind, item.mode, item.state])).toEqual([
        [Convert.ASK, "confirm", "needs_confirm"],
        [Convert.STEP.code, "auto", "pending"],
      ])
      const step = stepOf(asked, Convert.ASK)
      expect(step.confirm).toMatchObject({
        bytes: 1_333,
        files: [
          { path: "Content/cache.tmp", bytes: 1_234 },
          { path: "Assets/Textures/thumbs.tmp", bytes: 99 },
        ],
      })
      expect(step.confirm?.text).toContain("무시된 파일 2개")
      expect(step.confirm?.manifest).toBeString()

      // Asked first: nothing of the conversion ran before the answer.
      const kept = await confirm(asked.id, "skip")
      expect(stepOf(kept, Convert.STEP.code).state).toBe("skipped")
      expect((await current(record)).shape).toBe("full")
      expect(fs.existsSync(file(record, "Content/cache.tmp"))).toBe(true)
      expect(
        sparse(record.directory, ["config", "--type=bool", "--get", "core.sparseCheckout"], [0, 1]).trim(),
      ).not.toBe("true")

      const again = await start(record, "code")
      const converted = await confirm(again.id, "do")
      expect(converted.state).toBe("done")
      expect(stepOf(converted, Convert.STEP.code).note).toContain("무시된 파일 2개")
      expect((await current(record)).shape).toBe("code")
      expect(fs.existsSync(file(record, "Content"))).toBe(false)
      expect(fs.existsSync(file(record, "Assets/Textures"))).toBe(false)
    },
    SLOW,
  )

  test(
    "the ask comes before the owner's replacement: 두기 keeps the owner conversation, do replaces it, then converts",
    async () => {
      const owner = SessionID.create()
      const record = await makeArea({ owner })
      backend.add(owner, record.directory)
      write(record.directory, { "Content/cache.tmp": "c".repeat(100) })

      const asked = await start(record, "code")
      expect(asked.state).toBe("waiting")
      expect(asked.steps.map((item) => item.kind)).toEqual([
        Convert.ASK,
        Rotation.KIND.begin,
        Rotation.KIND.handoff,
        Rotation.KIND.owner,
        Rotation.KIND.swap,
        Rotation.KIND.archive,
        Convert.STEP.code,
      ])
      expect(asked.steps.slice(1).every((item) => item.state === "pending")).toBe(true)
      const declined = await confirm(asked.id, "skip")
      expect(declined.state).toBe("done")
      expect(declined.steps.every((item) => item.state === "skipped")).toBe(true)
      expect((await current(record)).owner.sessionID).toBe(owner)
      expect((await current(record)).shape).toBe("full")
      expect(fs.existsSync(file(record, "Content/cache.tmp"))).toBe(true)

      const again = await start(record, "code")
      const done = await confirm(again.id, "do")
      expect(done.state).toBe("done")
      expect((await current(record)).owner.sessionID).not.toBe(owner)
      expect((await current(record)).shape).toBe("code")
      expect(fs.existsSync(file(record, "Content"))).toBe(false)
    },
    SLOW,
  )

  test(
    "modified, staged or untracked files and a changed link copy in a leaving folder refuse it (TI-1)",
    async () => {
      const record = await makeArea()
      const refused = async () => Convert.check({ team: heavyTeam, area: await current(record), shape: "code" })

      fs.appendFileSync(file(record, "Content/notes.txt"), "changed\n")
      expect(await refused()).toMatchObject({ ok: false, error: "dirty", data: { paths: ["Content/notes.txt"] } })
      git(record.directory, ["checkout", "--", "Content/notes.txt"])

      write(record.directory, { "Content/new.txt": "agent work\n" })
      expect(await refused()).toMatchObject({ ok: false, error: "dirty", data: { paths: ["Content/new.txt"] } })
      fs.rmSync(file(record, "Content/new.txt"))

      write(record.directory, { "Assets/Textures/staged.txt": "staged\n" })
      git(record.directory, ["add", "Assets/Textures/staged.txt"])
      expect(await refused()).toMatchObject({
        ok: false,
        error: "dirty",
        data: { paths: ["Assets/Textures/staged.txt"] },
      })
      git(record.directory, ["rm", "-q", "--cached", "Assets/Textures/staged.txt"])
      fs.rmSync(file(record, "Assets/Textures/staged.txt"))

      // skip-worktree hides the edit from status; the record does not (4.12).
      write(record.directory, { "Content/readme-link.md": "my notes\n" })
      expect(sparse(record.directory, ["status", "--porcelain=v2", "-z"])).toBe("")
      expect(await refused()).toMatchObject({
        ok: false,
        error: "dirty",
        data: { paths: ["Content/readme-link.md"] },
      })

      // The step itself refuses too (an op that carries it), and touches nothing.
      fs.appendFileSync(file(record, "Content/notes.txt"), "changed again\n")
      const done = await run(record, Convert.steps({ area: record, shape: "code", mode: "auto", by: "user" }))
      expect(done.state).toBe("failed")
      expect(stepOf(done, Convert.STEP.code).note).toContain("아직 저장 지점에 넣지 않은 작업")
      expect(fs.readFileSync(file(record, "Content/notes.txt"), "utf8")).toBe("notes\nchanged again\n")
      expect(fs.readFileSync(file(record, "Content/readme-link.md"), "utf8")).toBe("my notes\n")
      expect(tags(record.directory)).toEqual(Object.fromEntries(Object.keys(LINKS).map((link) => [link, "S"])))
      expect((await current(record)).shape).toBe("full")
    },
    SLOW,
  )

  test(
    "an ignored file made between the check and `set` aborts; the flags go back, nothing is deleted",
    async () => {
      const record = await makeArea()
      // The second check is the one right before `set` (the first is the step's observe).
      safe.on = (call) => {
        if (call === 2) write(record.directory, { "Content/late.tmp": "made meanwhile\n" })
      }

      const done = await start(record, "code")

      expect(done.state).toBe("failed")
      expect(stepOf(done, Convert.STEP.code).note).toBe(Convert.CHANGED)
      expect(fs.readFileSync(file(record, "Content/late.tmp"), "utf8")).toBe("made meanwhile\n")
      expect(fs.existsSync(file(record, "Content/map.bin"))).toBe(true)
      expect(tags(record.directory)).toEqual(Object.fromEntries(Object.keys(LINKS).map((link) => [link, "S"])))
      expect((await current(record)).shape).toBe("full")
      expect(
        sparse(record.directory, ["config", "--type=bool", "--get", "core.sparseCheckout"], [0, 1]).trim(),
      ).not.toBe("true")
    },
    SLOW,
  )

  test(
    "an identity mismatch marks the area broken (identity) and writes nothing to the folder (TI-14)",
    async () => {
      const record = await makeArea()
      const other = await makeArea()
      const wrong = { ...record, gitDir: other.gitDir }
      await h.services.write(TEAM_ID, async () => h.services.registry.areas.put(wrong))
      const refused = await Convert.check({ team: heavyTeam, area: wrong, shape: "code" })
      expect(refused).toMatchObject({ ok: false, error: "broken", data: { why: "identity" } })

      const done = await run(record, Convert.steps({ area: wrong, shape: "code", mode: "auto", by: "user" }))

      expect(done.state).toBe("failed")
      const after = await current(record)
      expect(after.state).toBe("broken")
      expect(after.broken?.why).toBe("identity")
      expect(tags(record.directory)).toEqual(Object.fromEntries(Object.keys(LINKS).map((link) => [link, "S"])))
      expect(fs.existsSync(file(record, "Content/map.bin"))).toBe(true)
      expect(
        sparse(record.directory, ["config", "--type=bool", "--get", "core.sparseCheckout"], [0, 1]).trim(),
      ).not.toBe("true")
      expect(
        h.published.some(
          (event) => event.name === "notice" && event.data.kind === "area.broken" && event.data.areaID === record.id,
        ),
      ).toBe(true)
      expect(
        (await h.services.notices.open(TEAM_ID)).some((item) => item.id === `area.broken:${record.id}:identity`),
      ).toBe(true)
    },
    SLOW,
  )

  test(
    "Main 멈춤 skips an automatic conversion with its rotation (TI-13); a busy folder skips it (TI-9); a user's waits",
    async () => {
      const owner = SessionID.create()
      const paused = await makeArea({ owner, paused: "user" })
      const skipped = await start(paused, "code", "auto")
      expect(skipped.state).toBe("done")
      expect(skipped.steps.every((step) => step.state === "skipped")).toBe(true)
      expect(skipped.summary?.lines).toContainEqual({
        kind: "skipped",
        item: Convert.STEP.code,
        areaID: paused.id,
        why: "paused",
      })
      expect((await current(paused)).shape).toBe("full")
      expect((await current(paused)).owner.sessionID).toBe(owner)
      expect(
        h.published.some(
          (event) => event.name === "notice" && event.data.kind === "reorg.skipped" && event.data.areaID === paused.id,
        ),
      ).toBe(true)

      const busy = await makeArea()
      safe.now = false
      const away = await start(busy, "code", "main")
      expect(stepOf(away, Convert.STEP.code).state).toBe("skipped")
      expect(away.summary?.lines).toContainEqual({
        kind: "skipped",
        item: Convert.STEP.code,
        areaID: busy.id,
        why: "busy",
      })
      expect((await current(busy)).shape).toBe("full")

      // by:user waits for the extended safe point and says why on the card.
      const started = await Convert.start(h.services, { teamID: TEAM_ID, areaID: busy.id, shape: "code", by: "user" })
      if (!started.ok) throw new Error(started.message)
      await until(() =>
        h.published.some(
          (event) => event.name === "op.progress" && event.data.opID === started.opID && event.data.state === "pending",
        ),
      )
      expect((await h.services.journal.get(TEAM_ID, started.opID))?.state).toBe("running")
      safe.now = true
      clock.advance(Rotation.RECHECK_MS)
      const done = await op(started.opID)
      expect(done.state).toBe("done")
      expect((await current(busy)).shape).toBe("code")
    },
    SLOW,
  )

  test(
    "a detached HEAD's own commits get a keep ref before the conversion (TI-8)",
    async () => {
      const record = await makeArea()
      git(record.directory, ["checkout", "-q", "--detach"])
      write(record.directory, { "src/app/detached.ts": "export const detached = 1\n" })
      git(record.directory, ["add", "src/app/detached.ts"])
      git(record.directory, ["commit", "-q", "-m", "work on a detached HEAD"])
      const sha = head(record.directory)

      const done = await start(record, "code")

      expect(done.state).toBe("done")
      expect(git(repo.home, ["for-each-ref", "--format=%(objectname)", `refs/own/keep/${sha}`]).trim()).toBe(sha)
      expect(done.summary?.lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${sha}`, sha })
      expect(
        h.published.some(
          (event) => event.name === "notice" && event.data.kind === "detached.kept" && event.data.areaID === record.id,
        ),
      ).toBe(true)
      expect((await current(record)).shape).toBe("code")
    },
    SLOW,
  )

  test(
    "code → full: sparse-checkout disable behind a confirm with the bytes and the download; links become copies",
    async () => {
      const record = await makeArea()
      expect((await start(record, "code")).state).toBe("done")
      const code = await current(record)
      expect(await Convert.check({ team: heavyTeam, area: code, shape: "full" })).toMatchObject({
        ok: true,
        mode: "confirm",
      })

      const asked = await start(code, "full")

      expect(asked.state).toBe("waiting")
      expect(asked.steps.map((step) => [step.kind, step.state])).toEqual([
        [Convert.ASK, "needs_confirm"],
        [Convert.STEP.full, "pending"],
      ])
      const step = stepOf(asked, Convert.ASK)
      // No LFS objects are missing in this repository: nothing to download, the folders' bytes on disk.
      expect(step.confirm?.bytes).toBe(0)
      expect(step.confirm?.text).toContain("내려받기 0 B")
      expect(step.confirm?.text).toContain("디스크 ")
      expect(step.confirm?.text).toContain("큰 파일 폴더 2개")

      const done = await confirm(asked.id, "do")

      expect(done.state).toBe("done")
      expect(done.summary?.lines).toContainEqual({ kind: "area", areaID: record.id, change: "converted" })
      const after = await current(record)
      expect(after.shape).toBe("full")
      expect(
        sparse(record.directory, ["config", "--type=bool", "--get", "core.sparseCheckout"], [0, 1]).trim(),
      ).not.toBe("true")
      expect(
        sparse(record.directory, ["ls-files", "--sparse", "-z"])
          .split("\0")
          .filter((entry) => entry.endsWith("/")),
      ).toEqual([])
      expect(fs.statSync(file(record, "Content/map.bin")).size).toBe(10_000)
      expect(fs.statSync(file(record, "Assets/Textures/tree.png")).size).toBe(30_000)
      // The link in the folder that came back is a copy again, every copy with the home's flag.
      expect(fs.readFileSync(file(record, "Content/readme-link.md"), "utf8")).toBe("# convert\n")
      expect(tags(record.directory)).toEqual(Object.fromEntries(Object.keys(LINKS).map((link) => [link, "S"])))
      expect(Object.keys(after.linkCopies ?? {}).toSorted()).toEqual(Object.keys(LINKS).toSorted())
      expect(sparse(record.directory, ["status", "--porcelain=v2", "-z", "-uall"])).toBe("")
      expect(sparse(record.directory, ["add", "-A", "--dry-run"])).toBe("")
    },
    SLOW,
  )

  test(
    "undo of a conversion is the other one; check refuses what cannot be converted",
    async () => {
      const record = await makeArea()
      const toCode = await start(record, "code")
      const reversed = await Convert.undo(h.services, { op: toCode, by: "user" })
      expect(reversed).toMatchObject({ ok: true })
      if (!reversed?.ok) throw new Error("no undo")
      expect(reversed.steps).toEqual([
        { kind: Convert.ASK, mode: "confirm", args: { areaID: record.id, shape: "full" } },
        { kind: Convert.STEP.full, mode: "auto", args: { areaID: record.id } },
      ])
      expect(await Convert.undo(h.services, { op: { ...toCode, steps: [] }, by: "user" })).toBeUndefined()

      const full = await makeArea()
      expect(await Convert.check({ team: heavyTeam, area: full, shape: "full" })).toMatchObject({
        ok: false,
        error: "invalid_proposal",
      })
      expect(
        await Convert.check({
          team: { ...heavyTeam, heavy: { ...heavyTeam.heavy, dirs: [] } },
          area: full,
          shape: "code",
        }),
      ).toMatchObject({ ok: false, error: "invalid_proposal" })
      // 06 §4.4: a plain folder converts to code-only once the list grew; it holds the heavy folders here, so they
      // leave (not quiet: its owner conversation is replaced first). A plain folder never becomes "full" by a convert.
      expect(await Convert.check({ team: heavyTeam, area: { ...full, shape: "plain" }, shape: "code" })).toMatchObject({
        ok: true,
        mode: "auto",
        quiet: false,
      })
      expect(await Convert.check({ team: heavyTeam, area: { ...full, shape: "plain" }, shape: "full" })).toMatchObject({
        ok: false,
        error: "invalid_proposal",
      })
    },
    SLOW,
  )

  test(
    "[TG19 record] core's snapshot store across a conversion (emulated as core builds it, [R-adopt] snap-det)",
    async () => {
      const record = await makeArea()
      const snapshots = store(
        record.directory,
        record.gitDir,
        path.join(repo.home, ".git"),
        path.join(box.root, "snap1"),
      )
      // The last turn of the conversation that worked in the full folder.
      write(record.directory, { "src/app/main.ts": "export const main = 2\n" })
      const before = snapshots.capture()

      expect((await start(record, "code")).state).toBe("done")

      // The first turn of the new conversation: a change in the cone.
      const first = snapshots.capture()
      write(record.directory, { "src/app/main.ts": "export const main = 3\n" })
      const after = snapshots.capture()
      const turn = snapshots.diff(first, after)
      const spanning = snapshots.diff(before, after)
      console.log(`[TG19 record] convert full→code, first turn after it: ${turn.join(" | ") || "(empty)"}`)
      console.log(
        `[TG19 record] convert full→code, a range across it: ${spanning.length} paths, deleted ${spanning.filter((line) => line.startsWith("D")).length} (${spanning.slice(0, 4).join(" | ")})`,
      )
      expect(turn).toContain("M\tsrc/app/main.ts")
    },
    SLOW,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/**
 * The fixture repository: `src/`, `docs/`, `Assets/Scripts`, heavy `Assets/Textures` and `Content` (ordinary blobs),
 * the forced `Assets/Textures.meta`, and the {@link LINKS} as mode-120000 entries checked out as link files
 * (core.symlinks=false). `*.tmp` is ignored through the common `info/exclude`.
 */
function build(root: string) {
  const home = init(path.join(root, "home"))
  write(home, {
    "README.md": "# convert\n",
    "src/app/main.ts": "export const main = 1\n",
    "src/lib/util.ts": "export const util = 2\n",
    "docs/guide.md": "guide\n",
    "Assets/Scripts/player.cs": "class Player {}\n",
    "Assets/Textures.meta": "meta\n",
    "Assets/Textures/rock.png": crypto.randomBytes(20_000),
    "Assets/Textures/tree.png": crypto.randomBytes(30_000),
    "Content/map.bin": crypto.randomBytes(10_000),
    "Content/notes.txt": "notes\n",
  })
  git(home, ["add", "-A"])
  for (const [link, target] of Object.entries(LINKS)) {
    const oid = git(home, ["hash-object", "-w", "--stdin"], { stdin: target }).trim()
    git(home, ["update-index", "--add", "--cacheinfo", `120000,${oid},${link}`])
  }
  git(home, ["commit", "-q", "-m", "convert fixture"])
  git(home, ["reset", "-q", "--hard"])
  fs.appendFileSync(path.join(home, ".git", "info", "exclude"), "*.tmp\n")
  return { home, head: head(home) }
}

/** git in a sparse folder (no advice); `codes` are the exit codes that count as success. */
function sparse(directory: string, args: ReadonlyArray<string>, codes: ReadonlyArray<number> = [0]) {
  const result = Bun.spawnSync(["git", "-c", "advice.sparseIndexExpanded=false", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  if (!codes.includes(result.exitCode)) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** `ls-files -v` tags (`S` skip-worktree, `h` assume-unchanged, `s` both) of the link entries. */
function tags(directory: string, files: ReadonlyArray<string> = Object.keys(LINKS)) {
  return Object.fromEntries(
    sparse(directory, ["ls-files", "-v", "-z", "--", ...files])
      .split("\0")
      .filter(Boolean)
      .map((line) => [line.slice(2), line[0]]),
  )
}

async function until(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  if (await check()) return
  if (ms <= 0) throw new Error("timed out waiting")
  await Bun.sleep(20)
  return until(check, ms - 20)
}

/**
 * core's snapshot store of a worktree, built the way `packages/core/src/git.ts` builds it: its own git dir with the
 * repository's objects as alternates and the worktree's index copied once when it is made; a capture stages what
 * `diff-files` and `ls-files --others` list (minus what the source repository ignores) with `add --all --sparse` and
 * writes a tree. An emulation for the TG19 record only; the real server's record is the e2e suite's.
 */
function store(worktree: string, gitDir: string, commonDir: string, dir: string) {
  git(path.dirname(dir), ["init", "-q", "--bare", dir])
  git(dir, ["config", "core.bare", "false"])
  fs.mkdirSync(path.join(dir, "objects", "info"), { recursive: true })
  fs.writeFileSync(path.join(dir, "objects", "info", "alternates"), `${path.join(commonDir, "objects")}\n`)
  fs.copyFileSync(path.join(gitDir, "index"), path.join(dir, "index"))
  const repo = (args: ReadonlyArray<string>, stdin?: string) =>
    git(worktree, [`--git-dir=${dir}`, `--work-tree=${worktree}`, ...args], stdin === undefined ? {} : { stdin })
  const list = (args: ReadonlyArray<string>) => repo(args).split("\0").filter(Boolean)
  return {
    capture: () => {
      const candidates = [
        ...new Set([
          ...list(["diff-files", "--name-only", "-z", "--", "."]),
          ...list(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
        ]),
      ]
      const ignored = Bun.spawnSync(["git", "-C", worktree, "check-ignore", "--no-index", "--stdin", "-z"], {
        stdin: Buffer.from(candidates.map((item) => `${item}\0`).join("")),
        stdout: "pipe",
      })
        .stdout.toString()
        .split("\0")
        .filter(Boolean)
      const stage = candidates.filter((item) => !ignored.includes(item))
      if (stage.length > 0)
        repo(
          ["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
          stage.map((item) => `${item}\0`).join(""),
        )
      return repo(["write-tree"]).trim()
    },
    diff: (from: string, to: string) =>
      repo(["diff-tree", "-r", "--name-status", "--no-renames", from, to]).split("\n").filter(Boolean),
  }
}
