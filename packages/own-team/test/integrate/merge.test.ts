// Integrate part 1, the git steps and the op (06 §7.1-§7.3, 4.10 last bullet, TG11 merge items): already merged, ff,
// divergent (merge-tree --write-tree -z --name-only with --attr-source=<B>, K with parents B and C and the message
// `팀: <영역 이름> 합치기 (<ig>)`), conflicts (the first to the owner, a second wakes the main), LFS pointers without a
// smudge, a candidate that left the branch, newerSkipped, a missing candidate, one integration per team, the
// integrate refs in one transaction, and the start check (tracked files, link copies, a stopped git operation). Git
// fixtures in temp folders, fake features, no network.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { IntegrateOp } from "../../src/integrate/op.js"
import { Merge } from "../../src/integrate/merge.js"
import { Refs } from "../../src/git/refs.js"
import type { Services } from "../../src/services.js"
import { AREA, failingLfsFilters, integrate, plumb, pointer, save } from "../fixtures/integrate.js"
import { git, head, init, temp } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller } from "../support/context.js"

/** Git-heavy tests: Windows process starts are slow on a busy machine. */
const SLOW = 180_000

const box = temp("own-team-merge-")
afterAll(() => box.dispose())

/** A fresh fixture per test, each in its own folder. */
const fixtures = { next: 0 }
function fixture() {
  return integrate(path.join(box.root, `f${fixtures.next++}`))
}

const AT = Date.UTC(2026, 9, 2, 3, 0, 0)
const IG = "ig_01JABCDEFGHJKMNPQRSTVWXYZ0"

describe("Merge: the git steps (06 §7.2 steps 1-5)", () => {
  test(
    "already merged: C in B ends at step 2; B behind C is a fast-forward to C",
    async () => {
      const fx = fixture()
      const area = save(fx.area.directory, { "src/area.ts": "area\n" })
      expect(
        await Merge.compute({ repo: fx.team.commonDir, base: area, source: fx.base, message: "m", at: AT }),
      ).toEqual({ ok: true, how: "merged" })
      expect(
        await Merge.compute({ repo: fx.team.commonDir, base: fx.base, source: area, message: "m", at: AT }),
      ).toEqual({ ok: true, how: "ff", candidate: area })
      expect(await Merge.tip(fx.team.commonDir, "main")).toEqual({ ok: true, sha: fx.base })
      expect(await Merge.tip(fx.team.commonDir, "nothing-here")).toEqual({ ok: true, sha: null })
    },
    SLOW,
  )

  test(
    "divergent: K = commit-tree of the merge tree, parents B and C, the team message, dated by the integration",
    async () => {
      const fx = fixture()
      const source = save(fx.area.directory, { "src/area.ts": "area\n" })
      const base = save(fx.home, { "docs/main.md": "main\n" })
      const message = Merge.message("인벤토리\n화면", IG)
      expect(message).toBe(`팀: 인벤토리 화면 합치기 (${IG})`)
      const merged = await Merge.compute({ repo: fx.team.commonDir, base, source, message, at: AT })
      if (!merged.ok || merged.how !== "merge") throw new Error(JSON.stringify(merged))
      expect(git(fx.home, ["rev-list", "--parents", "-n", "1", merged.candidate]).trim().split(" ").slice(1)).toEqual([
        base,
        source,
      ])
      expect(git(fx.home, ["log", "-1", "--format=%B", merged.candidate]).trim()).toBe(message)
      expect(git(fx.home, ["log", "-1", "--format=%at %ct", merged.candidate]).trim()).toBe(`${AT / 1000} ${AT / 1000}`)
      expect(git(fx.home, ["ls-tree", "-r", "--name-only", merged.candidate]).split("\n")).toEqual(
        expect.arrayContaining(["src/area.ts", "docs/main.md"]),
      )
      // Made again after a restart: the same commit (TI-11).
      expect(await Merge.compute({ repo: fx.team.commonDir, base, source, message, at: AT })).toEqual(merged)
      // Nothing outside the object store changed: the target, the home and the area are as they were.
      expect(head(fx.home)).toBe(base)
      expect(git(fx.home, ["status", "--porcelain"])).toBe("")
      expect(head(fx.area.directory)).toBe(source)
    },
    SLOW,
  )

  test(
    "merge attributes come from B (--attr-source), not from the files a folder has on disk",
    async () => {
      const fx = fixture()
      save(fx.home, { "notes.txt": "a\n" })
      const start = head(fx.home)
      git(fx.area.directory, ["merge", "-q", "--ff-only", start])
      const source = save(fx.area.directory, { "notes.txt": "a\narea\n" })
      const base = save(fx.home, { ".gitattributes": "notes.txt merge=union\n", "notes.txt": "a\nmain\n" })
      const merged = await Merge.compute({ repo: fx.team.commonDir, base, source, message: "m", at: AT })
      if (!merged.ok || merged.how !== "merge") throw new Error(JSON.stringify(merged))
      expect(git(fx.home, ["cat-file", "-p", `${merged.candidate}:notes.txt`])).toBe("a\nmain\narea\n")
      // Without --attr-source the git dir has no attributes and the same merge conflicts.
      const plain = Bun.spawnSync(
        ["git", "-C", fx.team.commonDir, "merge-tree", "--write-tree", "--no-messages", base, source],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(plain.exitCode).toBe(1)
    },
    SLOW,
  )

  test(
    "conflict: exit 1 gives each conflicted path once and makes no commit",
    async () => {
      const fx = fixture()
      const source = save(fx.area.directory, { "src/app.ts": "export const app = 'area'\n", "src/new.ts": "x\n" })
      const base = save(fx.home, { "src/app.ts": "export const app = 'main'\n" })
      expect(await Merge.compute({ repo: fx.team.commonDir, base, source, message: "m", at: AT })).toEqual({
        ok: true,
        how: "conflict",
        paths: ["src/app.ts"],
      })
    },
    SLOW,
  )

  test(
    "LFS pointers conflict as content without a smudge (filters that would fail, no git-lfs, no network)",
    async () => {
      const repo = init(path.join(box.root, "lfs"), { bare: true })
      failingLfsFilters(repo)
      const attributes = "*.bin filter=lfs diff=lfs merge=lfs -text\n"
      const start = plumb(
        repo,
        "main",
        { ".gitattributes": attributes, "big/data.bin": pointer("0", 10) },
        { from: emptyCommit(repo) },
      )
      const base = plumb(repo, "main", { "big/data.bin": pointer("1", 11) })
      const source = plumb(repo, "area", { "big/data.bin": pointer("2", 12) }, { from: start })
      expect(await Merge.compute({ repo, base, source, message: "m", at: AT })).toEqual({
        ok: true,
        how: "conflict",
        paths: ["big/data.bin"],
      })
    },
    SLOW,
  )

  test(
    "7.1: a candidate on the branch counts the commits after it; one that left the branch is rewritten",
    async () => {
      const fx = fixture()
      const repo = fx.team.commonDir
      const candidate = save(fx.area.directory, { "src/a.ts": "a\n" })
      expect(await Merge.placed({ repo, branch: AREA, source: candidate })).toEqual({
        ok: true,
        state: "on-branch",
        newerSkipped: 0,
      })
      save(fx.area.directory, { "src/b.ts": "b\n" })
      save(fx.area.directory, { "src/c.ts": "c\n" })
      expect(await Merge.placed({ repo, branch: AREA, source: candidate })).toEqual({
        ok: true,
        state: "on-branch",
        newerSkipped: 2,
      })
      git(fx.area.directory, ["reset", "-q", "--hard", fx.base])
      save(fx.area.directory, { "src/other.ts": "other\n" })
      expect(await Merge.placed({ repo, branch: AREA, source: candidate })).toEqual({ ok: true, state: "rewritten" })
      expect(await Merge.placed({ repo, branch: AREA, source: "f".repeat(40) })).toEqual({
        ok: true,
        state: "rewritten",
      })
      expect(await Merge.subjects({ repo, base: fx.base, head: head(fx.area.directory) })).toEqual({
        ok: true,
        subjects: ["change"],
      })
    },
    SLOW,
  )

  test(
    "4.10: deletions in heavy folders, and changes outside the fetched ones, are found",
    async () => {
      const fx = fixture()
      const source = save(fx.area.directory, { "assets/textures/rock.bin": "rock 2\n", "src/x.ts": "x\n" })
      fs.rmSync(path.join(fx.area.directory, "assets", "audio", "music.bin"))
      const candidate = save(fx.area.directory, {})
      const repo = fx.team.commonDir
      expect(
        await Merge.heavy({ repo, base: fx.base, candidate, heavy: ["assets/textures", "assets/audio"], extra: [] }),
      ).toEqual({ ok: true, deleted: ["assets/audio/music.bin"], outside: ["assets/textures/rock.bin"] })
      expect(
        await Merge.heavy({
          repo,
          base: fx.base,
          candidate: source,
          heavy: ["assets/textures", "assets/audio"],
          extra: ["assets/textures"],
        }),
      ).toEqual({ ok: true, deleted: [], outside: [] })
    },
    SLOW,
  )

  test(
    "integrate refs: three in one transaction, done again on resume, none written next to a clashing one",
    async () => {
      const fx = fixture()
      const source = save(fx.area.directory, { "src/area.ts": "area\n" })
      const marks = { repo: fx.team.commonDir, integrationID: IG, base: fx.base, source, candidate: source }
      expect(await Merge.marked(marks)).toBe(false)
      expect(await Merge.mark(marks)).toEqual({ ok: true, created: true })
      expect(await Merge.marked(marks)).toBe(true)
      expect(await Merge.mark(marks)).toEqual({ ok: true, created: false })
      const names = Merge.refs(IG)
      expect(await Refs.read(fx.home, names.base)).toBe(fx.base)

      const other = { ...marks, integrationID: "ig_01JABCDEFGHJKMNPQRSTVWXYZ1" }
      const clash = Merge.refs(other.integrationID)
      expect(await Refs.create(fx.home, { ref: clash.candidate, oid: fx.base })).toMatchObject({ ok: true })
      expect(await Merge.mark(other)).toMatchObject({ ok: false, error: "exists" })
      expect(await Refs.read(fx.home, clash.base)).toBeNull()
      expect(await Refs.read(fx.home, clash.source)).toBeNull()
    },
    SLOW,
  )
})

describe("IntegrateOp: start rules and steps 0-7 (06 §7.1-§7.3)", () => {
  const world = new World()
  const requests: Services.DispatchInput[] = []
  const entries: Services.DigestEntry[] = []
  const h = controller(world, {
    directory: box.root,
    clock: manual(),
    features: {
      admit: () => ({
        dispatch: async (input) => {
          requests.push(input)
          return { ok: true, dispatchID: OwnTeam.DispatchID.create(), state: "queued" }
        },
        message: async () => ({ ok: true, guard: "limit" }),
        drain: async () => {},
        list: async () => ({ ok: true, items: [] }),
        cancel: async () => ({ ok: true }),
        cancelAll: async () => [],
      }),
      digest: () => ({
        add: async (_teamID, entry) => {
          entries.push(entry)
        },
        render: async () => "",
      }),
    },
  })
  IntegrateOp.register(h.services)
  // A confirm step that keeps an op waiting (active) for the busy rule.
  h.services.steps.register({
    kind: "test-hold",
    observe: async () => ({ state: "pending" }),
    act: async () => ({ ok: true }),
    verify: async () => ({ ok: true }),
  })
  afterAll(() => h.close())

  async function setup(change: (fx: ReturnType<typeof fixture>) => Partial<OwnTeam.Area> = () => ({})) {
    const fx = fixture()
    requests.splice(0)
    entries.splice(0)
    const area = { ...fx.area, ...change(fx) }
    await h.services.write(TEAM_ID, async () => {
      await clear(h.services)
      await h.services.registry.teams.put(fx.team)
      await h.services.registry.areas.put(area)
    })
    return { fx, area }
  }

  async function ready(area: OwnTeam.Area, sha: string) {
    const next = { ...area, candidate: { sha, at: AT, text: "ready" } }
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put(next))
    return next
  }

  /** Plans and runs steps 0-7; returns the plan, the op and the integration record. */
  async function run(area: OwnTeam.Area, input: { readonly tip?: boolean; readonly by?: OwnTeam.Op["by"] } = {}) {
    const planned = await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id, tip: input.tip })
    if (!planned.ok) throw new Error(planned.message)
    const started = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "integrate",
      by: input.by ?? "main",
      areaID: area.id,
      steps: planned.steps,
    })
    if (!started.ok) throw new Error("busy")
    await h.services.runner.settled(started.op.id)
    const op = await h.services.journal.get(TEAM_ID, started.op.id)
    const record = await IntegrateOp.get(h.services, TEAM_ID, planned.integrationID)
    return { planned, op: op!, record: record! }
  }

  test(
    "the start check: a changed tracked file, a changed link copy or a stopped merge blocks it (no op, no record)",
    async () => {
      const { fx, area } = await setup()
      const candidate = await ready(area, save(fx.area.directory, { "src/area.ts": "area\n" }))
      fs.writeFileSync(path.join(fx.area.directory, "src", "app.ts"), "edited\n")
      fs.writeFileSync(path.join(fx.area.directory, "untracked.txt"), "not counted\n")
      expect(await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })).toMatchObject({
        ok: false,
        error: "dirty",
        data: { count: 1, paths: ["src/app.ts"] },
      })
      git(fx.area.directory, ["checkout", "--", "src/app.ts"])

      const linked = { ...candidate, linkCopies: { "README.md": "0".repeat(40) } }
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put(linked))
      expect(await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })).toMatchObject({
        ok: false,
        error: "dirty",
        data: { paths: ["README.md"] },
      })
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put(candidate))

      fs.writeFileSync(path.join(fx.area.gitDir, "MERGE_HEAD"), `${fx.base}\n`)
      expect(await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })).toMatchObject({
        ok: false,
        error: "not_safe_point",
        data: { areaID: area.id, why: "git" },
      })
      fs.rmSync(path.join(fx.area.gitDir, "MERGE_HEAD"))
      expect(await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })).toMatchObject({ ok: true })
      expect(await IntegrateOp.list(h.services, TEAM_ID)).toEqual([])
    },
    SLOW,
  )

  test(
    "a missing candidate: refused for the main; the user's menu takes the tip and shows what goes in",
    async () => {
      const { fx, area } = await setup()
      const tip = save(fx.area.directory, { "src/one.ts": "1\n" }, "첫 변경")
      save(fx.area.directory, { "src/two.ts": "2\n" }, "둘째 변경")
      expect(await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })).toMatchObject({
        ok: false,
        error: "not_found",
        data: { what: "integration" },
      })
      const planned = await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id, tip: true })
      if (!planned.ok) throw new Error(planned.message)
      expect(planned.source).toBe(head(fx.area.directory))
      expect(planned.source).not.toBe(tip)
      expect(planned.subjects).toEqual(["둘째 변경", "첫 변경"])
      expect(planned.steps.map((step) => step.kind)).toEqual([
        "integrate-start",
        "integrate-merge",
        "integrate-refs",
        "integrate-heavy",
        "integrate-verify",
        "integrate-assets",
      ])
      // The record keeps them, so the card shows what goes in (7.1 "들어갈 커밋 제목을 보인다").
      const ran = await run(area, { tip: true, by: "user" })
      expect(ran.record.subjects).toEqual(["둘째 변경", "첫 변경"])
    },
    SLOW,
  )

  test(
    "a fast-forward runs steps 0-7: record, B, K = C, refs; no checks to run, assets skipped; target untouched",
    async () => {
      const { fx, area } = await setup()
      const source = save(fx.area.directory, { "src/area.ts": "area\n" })
      const { op, record } = await run(await ready(area, source))
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "skipped", "done"])
      expect(record).toMatchObject({
        state: "running",
        areaID: area.id,
        target: "main",
        source,
        base: fx.base,
        candidate: source,
        how: "ff",
        verify: { assets: "skipped" },
      })
      expect(
        await Merge.marked({
          repo: fx.team.commonDir,
          integrationID: record.id,
          base: fx.base,
          source,
          candidate: source,
        }),
      ).toBe(true)
      expect(git(fx.home, ["rev-parse", "main"]).trim()).toBe(fx.base)
      expect(
        h.published.some((event) => event.name === "integration.changed" && event.data.integrationID === record.id),
      ).toBe(true)
    },
    SLOW,
  )

  test(
    "one integration per team: an active op answers busy",
    async () => {
      const { fx, area } = await setup()
      await ready(area, save(fx.area.directory, { "src/area.ts": "area\n" }))
      const held = await h.services.runner.start({
        teamID: TEAM_ID,
        kind: "integrate",
        by: "user",
        steps: [{ kind: "test-hold", mode: "confirm" }],
      })
      if (!held.ok) throw new Error("busy")
      expect(await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })).toMatchObject({
        ok: false,
        error: "busy",
        data: { opID: held.op.id, kind: "integrate" },
      })
    },
    SLOW,
  )

  test(
    "C left the branch: the owner is asked for ready again, the stale candidate goes, the op fails (rewritten)",
    async () => {
      const { fx, area } = await setup()
      const old = save(fx.area.directory, { "src/area.ts": "area\n" })
      const marked = await ready(area, old)
      const planned = await IntegrateOp.plan(h.services, { teamID: TEAM_ID, areaID: area.id })
      if (!planned.ok) throw new Error(planned.message)
      git(fx.area.directory, ["reset", "-q", "--hard", fx.base])
      save(fx.area.directory, { "src/rewritten.ts": "again\n" })
      const started = await h.services.runner.start({
        teamID: TEAM_ID,
        kind: "integrate",
        by: "main",
        areaID: marked.id,
        steps: planned.steps,
      })
      if (!started.ok) throw new Error("busy")
      await h.services.runner.settled(started.op.id)
      const op = await h.services.journal.get(TEAM_ID, started.op.id)
      expect(op?.state).toBe("failed")
      expect(op?.steps.map((step) => step.state)).toEqual([
        "failed",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
      ])
      expect(await IntegrateOp.get(h.services, TEAM_ID, planned.integrationID)).toMatchObject({
        state: "failed",
        failure: "rewritten",
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ areaID: area.id, from: "team", kind: "task" })
      expect(requests[0]?.text).toContain('team_report(kind:"ready")')
      expect((await h.services.registry.areas.get(TEAM_ID, area.id))?.candidate).toBeUndefined()
      expect(entries).toEqual([expect.objectContaining({ wake: false })])
    },
    SLOW,
  )

  test(
    "newerSkipped: commits after the candidate stay out and are counted",
    async () => {
      const { fx, area } = await setup()
      const source = save(fx.area.directory, { "src/ready.ts": "ready\n" })
      save(fx.area.directory, { "src/later.ts": "later\n" })
      const { record, op } = await run(await ready(area, source))
      expect(record).toMatchObject({ newerSkipped: 1, candidate: source, how: "ff" })
      expect(op.steps[0]?.note).toBe("그 뒤 저장 지점 1개는 넣지 않았어요")
    },
    SLOW,
  )

  test(
    "already merged: the integration ends done at step 2, the later steps skip, the main is not woken",
    async () => {
      const { fx, area } = await setup()
      const source = save(fx.area.directory, { "src/area.ts": "area\n" })
      git(fx.home, ["merge", "-q", "--ff-only", source])
      const { op, record } = await run(await ready(area, source))
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => step.state)).toEqual(["done", "done", "skipped", "skipped", "skipped", "skipped"])
      expect(record).toMatchObject({ state: "done" })
      expect(record.candidate).toBeUndefined()
      expect(entries).toEqual([expect.objectContaining({ reason: "integrated", wake: false })])
      expect(OwnTeamText.countOf(`- ${entries[0]?.text}`)).toBe("integrated")
    },
    SLOW,
  )

  test(
    "conflicts: the first goes to the owner as a conflict request; a second one fails and wakes the main",
    async () => {
      const { fx, area } = await setup()
      const first = save(fx.area.directory, { "src/app.ts": "export const app = 'area'\n" })
      save(fx.home, { "src/app.ts": "export const app = 'main'\n" })
      const one = await run(await ready(area, first))
      expect(one.op.state).toBe("done")
      expect(one.op.steps.map((step) => step.state)).toEqual([
        "done",
        "done",
        "skipped",
        "skipped",
        "skipped",
        "skipped",
      ])
      expect(one.record).toMatchObject({ state: "conflict", conflicts: ["src/app.ts"] })
      // Its origin is the integration's start (`Direct.pass` lets it into a held area only when that is in the stretch).
      expect(requests).toEqual([
        expect.objectContaining({ from: "team", kind: "conflict", areaID: area.id, origin: one.record.createdAt }),
      ])
      expect(requests[0]?.text).toContain("src/app.ts")
      expect(entries).toEqual([expect.objectContaining({ reason: "conflict", wake: false })])
      expect(OwnTeamText.countOf(`- ${entries[0]?.text}`)).toBe("busy")
      expect(await Refs.read(fx.home, Merge.refs(one.record.id).candidate)).toBeNull()

      requests.splice(0)
      entries.splice(0)
      const second = save(fx.area.directory, { "src/app.ts": "export const app = 'area 2'\n" })
      const two = await run(await ready(area, second))
      expect(two.op.state).toBe("failed")
      expect(two.record).toMatchObject({ state: "failed", failure: "conflict", conflicts: ["src/app.ts"] })
      expect(requests).toEqual([])
      expect(entries).toEqual([expect.objectContaining({ reason: "integration-failed", wake: true })])
      expect(OwnTeamText.countOf(`- ${entries[0]?.text}`)).toBe("failed")
    },
    SLOW,
  )

  test(
    "4.10: a code-only area whose candidate deletes a heavy-folder file stops before the refs; the owner is told",
    async () => {
      const { fx, area } = await setup(() => ({ shape: "code" }))
      await h.services.write(TEAM_ID, () =>
        h.services.registry.teams.put({
          ...fx.team,
          heavy: { dirs: ["assets/audio"], measuredAt: fx.base, forcedBytes: 0 },
        }),
      )
      fs.rmSync(path.join(fx.area.directory, "assets", "audio", "music.bin"))
      const source = save(fx.area.directory, {})
      const { op, record } = await run(await ready(area, source))
      expect(op.state).toBe("failed")
      expect(record).toMatchObject({ state: "failed", failure: "heavy" })
      expect(await Refs.read(fx.home, Merge.refs(record.id).candidate)).toBeNull()
      expect(requests).toEqual([expect.objectContaining({ from: "team", kind: "task" })])
      expect(requests[0]?.text).toContain("assets/audio/music.bin")
    },
    SLOW,
  )

  test(
    "restart (7.2 step 8 '1부터 다시'): the target moved, steps 1-7 run again against its new tip",
    async () => {
      const { fx, area } = await setup()
      const source = save(fx.area.directory, { "src/area.ts": "area\n" })
      const first = await run(await ready(area, source))
      expect(first.record).toMatchObject({ base: fx.base, candidate: source, how: "ff" })
      // The advance step found the target moved: it removes the old refs and restarts.
      const moved = save(fx.home, { "docs/later.md": "later\n" })
      const names = Merge.refs(first.record.id)
      await Promise.all(
        [
          { ref: names.base, oid: fx.base },
          { ref: names.source, oid: source },
          { ref: names.candidate, oid: source },
        ].map((item) => Refs.removeIf(fx.home, item)),
      )
      await IntegrateOp.restart(h.services, {
        team: fx.team,
        integration: first.record,
        signal: new AbortController().signal,
      })
      const again = await IntegrateOp.get(h.services, TEAM_ID, first.record.id)
      if (!again?.candidate) throw new Error(JSON.stringify(again))
      expect(again).toMatchObject({
        id: first.record.id,
        state: "running",
        source,
        base: moved,
        how: "merge",
        verify: { assets: "skipped" },
        createdAt: first.record.createdAt,
      })
      expect(git(fx.home, ["rev-list", "--parents", "-n", "1", again.candidate]).trim().split(" ").slice(1)).toEqual([
        moved,
        source,
      ])
      expect(
        await Merge.marked({
          repo: fx.team.commonDir,
          integrationID: again.id,
          base: moved,
          source,
          candidate: again.candidate,
        }),
      ).toBe(true)
    },
    SLOW,
  )
})

/** Removes the team's records a previous test left (each test has its own fixture). */
async function clear(services: Services.Context) {
  const keys = await Promise.all(
    ["op:", "ig:", "area:"].map(async (prefix) =>
      (await services.kv.scan(`${prefix}${TEAM_ID}:`)).map((entry) => entry.key),
    ),
  )
  await Promise.all(keys.flat().map((key) => services.kv.remove(key)))
}

/** A root commit with an empty tree. */
function emptyCommit(repo: string) {
  const tree = git(repo, ["hash-object", "-t", "tree", "-w", "--stdin"], { stdin: "" }).trim()
  return git(repo, ["commit-tree", tree, "-m", "root"]).trim()
}
