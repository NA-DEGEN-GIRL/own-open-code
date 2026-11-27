// Undoing an integration (06 §7.4, TG11 undo items): only while the target is still K when asked (else the main
// decides: `conflict`, delegate); no checkout -> `update-ref` CAS back to B; the home holding the target ->
// `reset --keep B` at its safe point, waiting while it is not; a commit made between the confirm and the reset ->
// `refs/own/keep/<ORIG_HEAD>` and an `undo.kept` notice; a git operation in progress -> it waits. RH-20: the undo
// waits outside its op (`Integration.undoing`), so the team's op slot is free meanwhile, and the controller's 30 s
// look starts it again once the wait is over; RH-31: meanwhile no other integration moves the target. Temp fixture
// repositories and fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Advance } from "../../src/integrate/advance.js"
import { IntegrateOp } from "../../src/integrate/op.js"
import { IntegrateUndo } from "../../src/integrate/undo.js"
import { Keys } from "../../src/registry/keys.js"
import { moveMain, prepare, records, fixture, restarter, tipOf } from "../fixtures/advance.js"
import { git, head, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller } from "../support/context.js"

const SLOW = 120_000

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fixture whose integration already advanced (`home`: the home keeps `main` checked out; else it leaves it). */
async function integrated(options: { readonly home: boolean }) {
  const box = temp("own-team-undo-")
  const repo = fixture(box.root, { diverged: true })
  if (!options.home) git(repo.home, ["switch", "-q", "-c", "elsewhere"])
  const clock = manual()
  const h = controller(new World(), { directory: box.root, clock })
  cleanups.push(async () => {
    await h.close()
    box.dispose()
  })
  const state: { safe: boolean; looks: number; onLook?: () => Promise<void> } = { safe: true, looks: 0 }
  const safePoint: Advance.Deps["safePoint"] = async () => {
    state.looks++
    await state.onLook?.()
    return state.safe ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }
  }
  const deps: Advance.Deps = { safePoint, restart: restarter(h.services, repo), onAdvanced: async () => {} }
  const made = records(repo)
  const integration = await prepare(h.services, repo, made)
  const signal = new AbortController().signal
  const advanced = await Advance.run(h.services, deps, { teamID: TEAM_ID, integrationID: integration.id, signal })
  if (advanced.state !== "advanced") throw new Error(JSON.stringify(advanced))
  const after = await Advance.after(h.services, deps, {
    teamID: TEAM_ID,
    integrationID: integration.id,
    signal,
    summary: () => {},
  })
  if (!after.ok) throw new Error(after.message)
  IntegrateUndo.register(h.services, { safePoint })
  state.looks = 0
  return { box, repo, clock, h, state, integration, candidate: integration.candidate!, area: made.area }
}

type Integrated = Awaited<ReturnType<typeof integrated>>

async function record(s: Integrated) {
  return (await Advance.get(s.h.services, TEAM_ID, s.integration.id))!
}

async function op(s: Integrated, opID: string) {
  await s.h.services.runner.settled(opID)
  return (await s.h.services.journal.find(opID))!
}

/** Waits (real time) until `check` holds. */
async function until(check: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

const encode = Schema.encodeSync(OwnTeam.Integration)

/** Another integration of the area: as steps 0-7 left it (`running`), or waiting for the home to be idle. */
async function another(s: Integrated, state: "running" | "waiting") {
  const made = await prepare(s.h.services, s.repo, records(s.repo))
  const next: OwnTeam.Integration =
    state === "waiting" ? { ...made, state, waiting: { why: "in-use", directory: s.repo.home } } : made
  await s.h.services.kv.set(Keys.integration(TEAM_ID, made.id), Keys.toJson(encode(next)))
  return next
}

function notices(s: Integrated, kind: OwnTeam.NoticeKind) {
  return s.h.published.flatMap((event) => (event.name === "notice" && event.data.kind === kind ? [event.data] : []))
}

describe("integration.undo (06 §7.4)", () => {
  test(
    "no folder has the target: CAS back to B; the integration is undone by that op",
    async () => {
      const s = await integrated({ home: false })
      expect(tipOf(s.repo.home)).toBe(s.candidate)
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      const done = await op(s, started.opID)
      expect(done).toMatchObject({ kind: "undo", by: "user", state: "done", areaID: s.area.id })
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(await record(s)).toMatchObject({ state: "undone", undone: { opID: started.opID } })
      // Undone once: a second undo is refused.
      const again = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      expect(again.ok).toBe(false)
    },
    SLOW,
  )

  test(
    "the home has the target: reset --keep B at its safe point, waiting while it is not; other changes stay",
    async () => {
      const s = await integrated({ home: true })
      expect(head(s.repo.home)).toBe(s.candidate)
      write(s.repo.home, { "notes.txt": "the user's notes\n", "README.md": "# edited\n" })
      s.state.safe = false
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      // RH-20: its op ends while the undo waits; the integration keeps the wait and the team's op slot is free.
      const first = await op(s, started.opID)
      expect(first.state).toBe("done")
      expect(first.steps[0]?.note).toBe(IntegrateUndo.WAITS)
      expect((await record(s)).undoing).toMatchObject({ why: "in-use", by: "user" })
      expect(await s.h.services.journal.active(TEAM_ID)).toBeUndefined()
      expect(tipOf(s.repo.home)).toBe(s.candidate)
      expect(notices(s, "integration.waiting")).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ why: "in-use", action: "undo" }) }),
      ])

      s.state.safe = true
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await until(async () => (await record(s)).state === "undone")
      const done = await op(s, (await record(s)).undone!.opID)
      expect(done.state).toBe("done")
      expect((await record(s)).undoing).toBeUndefined()
      expect(head(s.repo.home)).toBe(s.repo.base)
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(fs.existsSync(path.join(s.repo.home, "src/inventory.ts"))).toBe(false)
      expect(fs.readFileSync(path.join(s.repo.home, "notes.txt"), "utf8")).toBe("the user's notes\n")
      expect(fs.readFileSync(path.join(s.repo.home, "README.md"), "utf8")).toBe("# edited\n")
      expect((await record(s)).state).toBe("undone")
      expect(await s.h.services.notices.open(TEAM_ID)).toEqual([])
    },
    SLOW,
  )

  test(
    "a commit made between the confirm and the reset is kept in refs/own/keep with a notice",
    async () => {
      const s = await integrated({ home: true })
      s.state.safe = false
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      await op(s, started.opID)
      // The user commits on the target in the home while the undo waits.
      write(s.repo.home, { "docs/late.md": "late\n" })
      git(s.repo.home, ["add", "docs/late.md"])
      git(s.repo.home, ["commit", "-q", "-m", "late"])
      const late = head(s.repo.home)

      s.state.safe = true
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await until(async () => (await record(s)).state === "undone")
      const done = await op(s, (await record(s)).undone!.opID)
      expect(done.state).toBe("done")
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(git(s.repo.home, ["rev-parse", `refs/own/keep/${late}`]).trim()).toBe(late)
      expect(done.summary?.lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${late}`, sha: late })
      expect(notices(s, "undo.kept")).toEqual([
        expect.objectContaining({ areaID: s.area.id, data: { ref: `refs/own/keep/${late}`, sha: late } }),
      ])
    },
    SLOW,
  )

  test(
    "the target moved past K: the undo is handed to the main (conflict, delegate), nothing changes",
    async () => {
      const s = await integrated({ home: false })
      const moved = moveMain(s.repo, "later work")
      const planned = await IntegrateUndo.plan(s.h.services, s.integration.id)
      expect(planned).toMatchObject({
        ok: false,
        delegate: true,
        failure: { error: "conflict", data: { ref: "refs/heads/main", expected: s.candidate, actual: moved } },
      })
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      expect(started).toMatchObject({ ok: false, error: "conflict" })
      expect(tipOf(s.repo.home)).toBe(moved)
      expect((await record(s)).state).toBe("done")
    },
    SLOW,
  )

  test(
    "a git operation in progress on the target makes the undo wait until it ends",
    async () => {
      const s = await integrated({ home: true })
      const stopped = Bun.spawnSync(
        ["git", "-C", s.repo.home, "rebase", "--force-rebase", "--exec", "exit 1", "HEAD~1"],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(stopped.exitCode).not.toBe(0)
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      await op(s, started.opID)
      expect(notices(s, "integration.waiting")).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ why: "in-progress", action: "undo" }) }),
      ])
      expect(tipOf(s.repo.home)).toBe(s.candidate)
      expect(s.state.looks).toBe(0)
      // Looked at again without an op while the operation stays.
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await Bun.sleep(500)
      expect((await s.h.services.journal.list(TEAM_ID)).filter((item) => item.kind === "undo")).toHaveLength(1)

      git(s.repo.home, ["rebase", "--abort"])
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await until(async () => (await record(s)).state === "undone")
      const done = await op(s, (await record(s)).undone!.opID)
      expect(done.state).toBe("done")
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(head(s.repo.home)).toBe(s.repo.base)
    },
    SLOW,
  )

  test(
    "RH-31: while an undo waits outside its op, no other integration starts or goes on to move the target",
    async () => {
      const s = await integrated({ home: true })
      s.state.safe = false
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      await op(s, started.opID)
      expect((await record(s)).undoing).toMatchObject({ why: "in-use" })
      // Another area's integration whose steps 0-6 ran in an op of their own (onward goes on with 7-9), and one that
      // waits for its folder (retried when the main wakes, by area.integrate and every 30 s).
      const onward = await another(s, "running")
      const waiting = await another(s, "waiting")
      await s.h.services.write(TEAM_ID, () =>
        s.h.services.journal.put({
          id: OwnTeam.OpID.create(),
          teamID: TEAM_ID,
          kind: "integrate",
          by: "main",
          state: "done",
          areaID: s.area.id,
          createdAt: s.clock.now(),
          steps: [
            {
              id: "start",
              kind: IntegrateOp.KIND.start,
              args: { integrationID: onward.id },
              mode: "auto",
              state: "done",
            },
          ],
        }),
      )
      const refused = { ok: false, error: "busy", data: { opID: started.opID, kind: "undo" } }
      expect(await IntegrateOp.plan(s.h.services, { teamID: TEAM_ID, areaID: s.area.id, tip: true })).toMatchObject(
        refused,
      )
      await s.h.services.features().integrate.retry(TEAM_ID)
      // `start` also goes on with the integration whose next op is still to start, then retries the waiting one.
      expect(
        await s.h.services.features().integrate.start({ teamID: TEAM_ID, areaID: s.area.id, by: "main" }),
      ).toMatchObject(refused)
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await Bun.sleep(500)
      expect((await s.h.services.journal.list(TEAM_ID)).filter((item) => item.state !== "done")).toEqual([])
      expect((await s.h.services.journal.list(TEAM_ID)).map((item) => item.kind)).toEqual(["undo", "integrate"])
      expect(tipOf(s.repo.home)).toBe(s.candidate)

      // Once the undo ran, nothing holds the others back.
      await s.h.services.kv.remove(Keys.integration(TEAM_ID, onward.id))
      await s.h.services.kv.remove(Keys.integration(TEAM_ID, waiting.id))
      s.state.safe = true
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await until(async () => (await record(s)).state === "undone")
      await op(s, (await record(s)).undone!.opID)
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(await IntegrateOp.undoWaits(s.h.services, TEAM_ID, s.integration.target)).toBeUndefined()
    },
    SLOW,
  )

  test(
    "RH-42: 되돌리기 취소 drops the undo that waits, nothing moves, and the integration it held goes on",
    async () => {
      const s = await integrated({ home: true })
      s.state.safe = false
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      await op(s, started.opID)
      expect((await record(s)).undoing).toMatchObject({ why: "in-use" })
      expect((await s.h.services.notices.open(TEAM_ID)).map((notice) => notice.kind)).toEqual(["integration.waiting"])
      // Another area's integration waits for the home too: the undo holds it back (RH-31).
      const held = await another(s, "waiting")
      await s.h.services.features().integrate.retry(TEAM_ID)
      expect((await s.h.services.journal.list(TEAM_ID)).map((item) => item.kind)).toEqual(["undo"])

      const cancelled = await s.h.services.features().integrate.undoCancel({ integrationID: s.integration.id })
      expect(cancelled).toMatchObject({ ok: true, integration: { id: s.integration.id, state: "done" } })
      expect((await record(s)).undoing).toBeUndefined()
      expect(await s.h.services.notices.open(TEAM_ID)).toEqual([])
      expect(tipOf(s.repo.home)).toBe(s.candidate)
      // The held integration goes on at once, and the controller's look starts no undo any more.
      await until(async () =>
        (await s.h.services.journal.list(TEAM_ID)).some(
          (item) => item.kind === "integrate" && item.steps.some((step) => step.args.integrationID === held.id),
        ),
      )
      await s.h.services.kv.remove(Keys.integration(TEAM_ID, held.id))
      s.state.safe = true
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await Bun.sleep(500)
      expect((await s.h.services.journal.list(TEAM_ID)).filter((item) => item.kind === "undo")).toHaveLength(1)
      expect((await record(s)).state).toBe("done")
      expect(await s.h.services.features().integrate.undoCancel({ integrationID: s.integration.id })).toMatchObject({
        ok: false,
        error: "not_found",
      })
    },
    SLOW,
  )

  test(
    "RH-42: a restart the controller had decided on skips itself once cancelled; the undo's own op makes it busy",
    async () => {
      const s = await integrated({ home: true })
      s.state.safe = false
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      await op(s, started.opID)
      const waiting = await record(s)
      // While an undo op of it is in the journal (running), 취소 is that op's.
      const running: OwnTeam.Op = {
        id: OwnTeam.OpID.create(),
        teamID: TEAM_ID,
        kind: "undo",
        by: "user",
        state: "running",
        areaID: s.area.id,
        createdAt: s.clock.now(),
        steps: [
          {
            id: "undo",
            kind: IntegrateUndo.STEP,
            args: { integrationID: s.integration.id },
            mode: "auto",
            state: "pending",
          },
        ],
      }
      await s.h.services.write(TEAM_ID, () => s.h.services.journal.put(running))
      expect(await s.h.services.features().integrate.undoCancel({ integrationID: s.integration.id })).toMatchObject({
        ok: false,
        error: "busy",
      })
      await s.h.services.write(TEAM_ID, () => s.h.services.journal.put({ ...running, state: "cancelled" }))
      expect(await s.h.services.features().integrate.undoCancel({ integrationID: s.integration.id })).toMatchObject({
        ok: true,
      })
      // The controller had decided to go on (the folder freed) before the cancel landed: its op does nothing.
      s.state.safe = true
      const again = await IntegrateUndo.again(s.h.services, { integration: waiting, by: "user", waited: true })
      if (!again.ok) throw new Error(again.message)
      expect((await op(s, again.opID)).steps[0]).toMatchObject({ state: "skipped", note: IntegrateUndo.CANCELLED })
      expect(tipOf(s.repo.home)).toBe(s.candidate)
      expect(head(s.repo.home)).toBe(s.candidate)
      expect((await record(s)).state).toBe("done")
    },
    SLOW,
  )

  test(
    "RH-42: a cancel that lands while the controller's look finds a new reason opens no waiting notice again",
    async () => {
      const s = await integrated({ home: true })
      s.state.safe = false
      const started = await IntegrateUndo.start(s.h.services, { integrationID: s.integration.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      await op(s, started.opID)
      expect((await record(s)).undoing).toMatchObject({ why: "in-use" })
      expect(notices(s, "integration.waiting")).toHaveLength(1)
      // The next look finds another reason (a change of the user's over a file the integration brought), and the user
      // cancels the undo after that look read the record and before it records the new reason.
      write(s.repo.home, { "src/inventory.ts": "the user's edit\n" })
      const cancelled: Array<unknown> = []
      s.state.onLook = async () => {
        s.state.onLook = undefined
        cancelled.push(await s.h.services.features().integrate.undoCancel({ integrationID: s.integration.id }))
      }
      s.state.safe = true
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await until(() => cancelled.length === 1)
      await Bun.sleep(500)
      expect(cancelled[0]).toMatchObject({ ok: true })
      expect((await record(s)).undoing).toBeUndefined()
      expect(await s.h.services.notices.open(TEAM_ID)).toEqual([])
      expect(notices(s, "integration.waiting")).toHaveLength(1)
      s.clock.advance(IntegrateUndo.RECHECK_MS)
      await Bun.sleep(500)
      expect((await s.h.services.journal.list(TEAM_ID)).filter((item) => item.kind === "undo")).toHaveLength(1)
      expect((await record(s)).state).toBe("done")
      expect(tipOf(s.repo.home)).toBe(s.candidate)
    },
    SLOW,
  )

  test(
    "unknown or never-advanced integrations are refused before any op starts",
    async () => {
      const s = await integrated({ home: false })
      const missing = await IntegrateUndo.plan(s.h.services, "ig_01J00000000000000000000000")
      expect(missing).toMatchObject({ ok: false, delegate: false, failure: { error: "not_found" } })
      expect(await s.h.services.journal.list(TEAM_ID)).toEqual([])
    },
    SLOW,
  )
})
