// Integrate part 2, moving the target (06 §7.2 steps 8–9, TI-10, TG11 advance items): the target moved -> steps 1–7
// again, at most 3 times; the home holding the target -> `merge --ff-only K` at its safe point (overlapping local
// changes wait with the paths, others stay); a rebase from the target or a checkout outside the team waits and never
// gets `update-ref`; no checkout -> `update-ref` CAS; `mergeLocal: "ask"` -> a confirm step; then the area sync (HEAD
// still C -> ff, else a `from="team"` `kind="sync"` request, Main 멈춤 skips it) and the integrate markers removed.
// Temp fixture repositories and fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Identity } from "../../src/git/identity.js"
import { Advance } from "../../src/integrate/advance.js"
import { IntegrateOp } from "../../src/integrate/op.js"
import type { Services } from "../../src/services.js"
import { type Repo, markersLeft, moveMain, prepare, records, fixture, restarter, tipOf } from "../fixtures/advance.js"
import { git, head, status, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, controller } from "../support/context.js"

const SLOW = 120_000

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A controller on a fixture repository; `admit` records sync requests instead of sending them. */
function setup(options: { readonly diverged?: boolean; readonly mergeLocal?: OwnTeam.Policy["mergeLocal"] } = {}) {
  const box = temp("own-team-advance-")
  const repo = fixture(box.root, options)
  const clock = manual()
  const requests: Services.DispatchInput[] = []
  const entries: Services.DigestEntry[] = []
  const h = controller(new World(), {
    directory: box.root,
    clock,
    features: {
      digest: () => ({
        add: async (_teamID, entry) => {
          entries.push(entry)
        },
        render: async () => "",
      }),
      admit: () => ({
        dispatch: async (input) => {
          requests.push(input)
          return { ok: true, dispatchID: OwnTeam.DispatchID.create(), state: "waiting", why: "busy" }
        },
        message: async () => ({ ok: true, guard: "limit" }),
        drain: async () => {},
        list: async () => ({ ok: true, items: [] }),
        cancel: async () => ({ ok: true }),
        cancelAll: async () => [],
      }),
    },
  })
  cleanups.push(async () => {
    await h.close()
    box.dispose()
  })
  const state = { safe: true }
  const advanced: Array<Parameters<Advance.Deps["onAdvanced"]>[0]> = []
  const restart = restarter(h.services, repo)
  const deps: Advance.Deps = {
    safePoint: async () => (state.safe ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }),
    restart,
    onAdvanced: async (input) => {
      advanced.push(input)
    },
  }
  const made = records(repo, { mergeLocal: options.mergeLocal })
  return { box, repo, clock, h, requests, entries, state, advanced, restart, deps, team: made.team, area: made.area }
}

type Setup = ReturnType<typeof setup>

const signal = () => new AbortController().signal

async function current(s: Setup, integrationID: string) {
  const found = await Advance.get(s.h.services, TEAM_ID, integrationID)
  if (!found) throw new Error("integration gone")
  return found
}

/** Step 8 then step 9, as the auto op runs them. */
async function integrate(s: Setup, integration: OwnTeam.Integration, deps: Advance.Deps = s.deps) {
  const advanced = await Advance.run(s.h.services, deps, {
    teamID: TEAM_ID,
    integrationID: integration.id,
    signal: signal(),
  })
  const lines: OwnTeam.SummaryLine[] = []
  const after =
    advanced.state === "advanced"
      ? await Advance.after(s.h.services, deps, {
          teamID: TEAM_ID,
          integrationID: integration.id,
          signal: signal(),
          summary: (line) => lines.push(line),
        })
      : undefined
  return { advanced, after, lines, record: await current(s, integration.id) }
}

/**
 * Makes `git status` fail in `directory` while every other git call there still works: a staged submodule entry whose
 * `.git` file points nowhere (`fatal: not a git repository`). A fast-forward merge there still succeeds.
 */
function breakStatus(directory: string) {
  git(directory, ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},broken-sub`])
  write(directory, { "broken-sub/.git": "gitdir: ../nowhere\n" })
  expect(Bun.spawnSync(["git", "-C", directory, "status", "--porcelain=v2"]).exitCode).not.toBe(0)
}

/** Switches the home to another branch, so no folder has `main` checked out. */
function leaveMain(repo: Repo) {
  git(repo.home, ["switch", "-q", "-c", "elsewhere"])
}

function notices(s: Setup, kind: OwnTeam.NoticeKind) {
  return s.h.published.flatMap((event) => (event.name === "notice" && event.data.kind === kind ? [event.data] : []))
}

describe("the target moved (7.2 step 8)", () => {
  test(
    "steps 1–7 run again against the new tip, then the target advances by CAS",
    async () => {
      const s = setup({ diverged: true })
      leaveMain(s.repo)
      const integration = await prepare(s.h.services, s.repo, s)
      const moved = moveMain(s.repo, "meanwhile")
      const result = await integrate(s, integration)
      expect(s.restart.calls()).toBe(1)
      expect(result.advanced).toEqual({ state: "advanced", how: "update-ref", observed: false })
      expect(result.record.base).toBe(moved)
      expect(tipOf(s.repo.home)).toBe(result.record.candidate!)
      expect(git(s.repo.home, ["rev-parse", `${result.record.candidate}^1`]).trim()).toBe(moved)
      expect(result.record.state).toBe("done")
    },
    SLOW,
  )

  test(
    "a target that moves every time fails after 3 restarts (moved), and its markers go",
    async () => {
      const s = setup({ diverged: true })
      leaveMain(s.repo)
      const integration = await prepare(s.h.services, s.repo, s)
      moveMain(s.repo, "first")
      const moving = restarter(s.h.services, s.repo, { moves: true })
      const result = await integrate(s, integration, { ...s.deps, restart: moving })
      expect(moving.calls()).toBe(Advance.MAX_RESTARTS)
      expect(result.advanced).toMatchObject({ state: "failed", failure: "moved" })
      expect(result.record).toMatchObject({ state: "failed", failure: "moved" })
      expect(result.record.advanced).toBeUndefined()
      expect(tipOf(s.repo.home)).not.toBe(result.record.candidate)
      expect(markersLeft(s.repo.commonDir, integration.id)).toEqual([])
      // 7.2 step 8 "그다음 실패 보고": the main's next team update gets the failure line and is woken.
      expect(s.entries).toEqual([
        expect.objectContaining({ reason: "integration-failed", wake: true, areaID: s.area.id }),
      ])
      expect(s.entries[0]!.text).toContain(s.area.name)
    },
    SLOW,
  )
})

describe("the home has the target checked out (W)", () => {
  test(
    "local changes that overlap K's wait with the paths; nothing is lost or moved",
    async () => {
      const s = setup()
      const integration = await prepare(s.h.services, s.repo, s)
      // K adds src/inventory.ts: an untracked file there would be overwritten, so git refuses.
      write(s.repo.home, { "src/inventory.ts": "the user's own file\n" })
      const result = await integrate(s, integration)
      expect(result.advanced).toEqual({
        state: "waiting",
        waiting: { why: "dirty", directory: expect.any(String), paths: ["src/inventory.ts"] },
      })
      expect(result.record.state).toBe("waiting")
      expect(Identity.same(result.record.waiting!.directory, s.repo.home)).toBe(true)
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(fs.readFileSync(path.join(s.repo.home, "src/inventory.ts"), "utf8")).toBe("the user's own file\n")
      expect(notices(s, "integration.waiting")).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ why: "dirty", count: 1 }) }),
      ])
      expect((await s.h.services.notices.open(TEAM_ID)).map((notice) => notice.id)).toEqual([integration.id])

      // 다시 반영 after the user moved the file away: it advances and the open notice goes.
      fs.rmSync(path.join(s.repo.home, "src/inventory.ts"))
      const retried = await integrate(s, integration)
      expect(retried.advanced).toMatchObject({ state: "advanced", how: "ff-in-worktree" })
      expect(retried.record.waiting).toBeUndefined()
      expect(await s.h.services.notices.open(TEAM_ID)).toEqual([])
    },
    SLOW,
  )

  test(
    "changes elsewhere stay: merge --ff-only K moves the home, its HEAD and the target are K",
    async () => {
      const s = setup()
      const integration = await prepare(s.h.services, s.repo, s)
      write(s.repo.home, { "docs/guide.md": "edited by the user\n", "notes.txt": "untracked\n" })
      const result = await integrate(s, integration)
      expect(result.advanced).toMatchObject({ state: "advanced", how: "ff-in-worktree", observed: false })
      expect(Identity.same(result.record.advanced!.directory!, s.repo.home)).toBe(true)
      expect(head(s.repo.home)).toBe(integration.candidate!)
      expect(tipOf(s.repo.home)).toBe(integration.candidate!)
      expect(fs.readFileSync(path.join(s.repo.home, "docs/guide.md"), "utf8")).toBe("edited by the user\n")
      expect(fs.readFileSync(path.join(s.repo.home, "notes.txt"), "utf8")).toBe("untracked\n")
      expect(fs.existsSync(path.join(s.repo.home, "src/inventory.ts"))).toBe(true)
      // Only the user's own changes remain: the integration left no staged reversal behind.
      expect(status(s.repo.home).split("\0").filter(Boolean).toSorted()).toEqual([" M docs/guide.md", "?? notes.txt"])
    },
    SLOW,
  )

  test(
    "an overlap check git cannot answer waits (in-use); the fast-forward never runs",
    async () => {
      const s = setup()
      const integration = await prepare(s.h.services, s.repo, s)
      breakStatus(s.repo.home)
      const result = await integrate(s, integration)
      expect(result.advanced).toMatchObject({ state: "waiting", waiting: { why: "in-use" } })
      expect(head(s.repo.home)).toBe(s.repo.base)
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(s.entries).toEqual([])
    },
    SLOW,
  )

  test(
    "not at the home's safe point: it waits (in-use) without touching git",
    async () => {
      const s = setup()
      const integration = await prepare(s.h.services, s.repo, s)
      s.state.safe = false
      const result = await integrate(s, integration)
      expect(result.advanced).toMatchObject({ state: "waiting", waiting: { why: "in-use" } })
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
    },
    SLOW,
  )

  test(
    "a rebase of the target stopped in the home: it waits (in-progress), never update-ref",
    async () => {
      const s = setup({ diverged: true })
      const integration = await prepare(s.h.services, s.repo, s)
      const stopped = Bun.spawnSync(
        ["git", "-C", s.repo.home, "rebase", "--force-rebase", "--exec", "exit 1", "HEAD~1"],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(stopped.exitCode).not.toBe(0)
      expect(fs.existsSync(path.join(s.repo.commonDir, "rebase-merge"))).toBe(true)
      const result = await integrate(s, integration)
      expect(result.advanced).toMatchObject({ state: "waiting", waiting: { why: "in-progress" } })
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      git(s.repo.home, ["rebase", "--abort"])
    },
    SLOW,
  )

  test(
    "a checkout of the target outside the team waits with a notice (TI-6)",
    async () => {
      const s = setup()
      // The team's home is another worktree; the primary checkout (which has main) is not the team's.
      const home2 = path.join(s.box.root, "home2")
      git(s.repo.home, ["worktree", "add", "-q", "-b", "work", home2, s.repo.base])
      const team: OwnTeam.Team = { ...s.team, home: { ...s.team.home, directory: home2, linked: true } }
      const integration = await prepare(s.h.services, s.repo, { ...s, team })
      const result = await integrate(s, integration)
      expect(result.advanced).toMatchObject({ state: "waiting", waiting: { why: "outside" } })
      expect(Identity.same(result.record.waiting!.directory, s.repo.home)).toBe(true)
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      expect(notices(s, "integration.waiting")).toEqual([
        expect.objectContaining({
          areaID: s.area.id,
          text: expect.stringContaining("팀 밖의"),
          data: expect.objectContaining({ why: "outside" }),
        }),
      ])
    },
    SLOW,
  )
})

describe("no folder has the target (update-ref CAS)", () => {
  test(
    "the CAS refuses a stale old value; with the right one the target moves to K",
    async () => {
      const s = setup({ diverged: true })
      leaveMain(s.repo)
      const integration = await prepare(s.h.services, s.repo, s)
      const stale = await Advance.swap({
        directory: s.repo.commonDir,
        target: "main",
        to: integration.candidate!,
        from: s.repo.source,
        integrationID: integration.id,
      })
      expect(stale.ok).toBe(false)
      expect(tipOf(s.repo.home)).toBe(s.repo.base)
      const result = await integrate(s, integration)
      expect(result.advanced).toEqual({ state: "advanced", how: "update-ref", observed: false })
      expect(tipOf(s.repo.home)).toBe(integration.candidate!)
      expect(s.restart.calls()).toBe(0)
      // The home kept its own branch; nothing was checked out for the integration.
      expect(git(s.repo.home, ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/elsewhere")
    },
    SLOW,
  )

  test(
    "a resumed step finds the target already at K and records it without moving it again",
    async () => {
      const s = setup({ diverged: true })
      leaveMain(s.repo)
      const integration = await prepare(s.h.services, s.repo, s)
      git(s.repo.home, ["update-ref", "refs/heads/main", integration.candidate!, s.repo.base])
      const result = await integrate(s, integration)
      expect(result.advanced).toEqual({ state: "advanced", how: "update-ref", observed: true })
      expect(result.record.state).toBe("done")
    },
    SLOW,
  )
})

describe("after the advance (7.2 step 9)", () => {
  test(
    "an area still at C is moved to K at its safe point; markers go; the card line and onAdvanced follow",
    async () => {
      const s = setup({ diverged: true })
      const integration = await prepare(s.h.services, s.repo, { ...s, newerSkipped: 2 })
      const result = await integrate(s, integration)
      expect(result.after).toEqual({ ok: true, synced: "ff" })
      expect(head(s.repo.area)).toBe(integration.candidate!)
      expect(s.requests).toEqual([])
      expect(markersLeft(s.repo.commonDir, integration.id)).toEqual([])
      expect(result.record.state).toBe("done")
      expect(result.lines).toEqual([
        { kind: "integrated", areaID: s.area.id, integrationID: integration.id, newerSkipped: 2 },
      ])
      expect(s.advanced.map((item) => item.integration.id)).toEqual([integration.id])
      expect(s.h.published.some((event) => event.name === "integration.changed" && event.data.state === "done")).toBe(
        true,
      )
    },
    SLOW,
  )

  test(
    "an area that moved past C gets a from=team sync request instead",
    async () => {
      const s = setup({ diverged: true })
      const integration = await prepare(s.h.services, s.repo, s)
      write(s.repo.area, { "src/more.ts": "export const more = 1\n" })
      git(s.repo.area, ["add", "-A"])
      git(s.repo.area, ["commit", "-q", "-m", "after ready"])
      const owned = head(s.repo.area)
      const result = await integrate(s, integration)
      expect(result.after).toEqual({ ok: true, synced: "request" })
      expect(head(s.repo.area)).toBe(owned)
      expect(s.requests).toEqual([
        { teamID: TEAM_ID, areaID: s.area.id, from: "team", kind: "sync", text: Advance.syncText("main") },
      ])
    },
    SLOW,
  )

  test(
    "an area whose overlap check git cannot answer gets the sync request; its folder is not fast-forwarded",
    async () => {
      const s = setup({ diverged: true })
      const integration = await prepare(s.h.services, s.repo, s)
      breakStatus(s.repo.area)
      const result = await integrate(s, integration)
      expect(result.after).toEqual({ ok: true, synced: "request" })
      expect(head(s.repo.area)).toBe(s.repo.source)
      expect(s.requests).toEqual([
        { teamID: TEAM_ID, areaID: s.area.id, from: "team", kind: "sync", text: Advance.syncText("main") },
      ])
    },
    SLOW,
  )

  test(
    "Main 멈춤 leaves the area as it is (TI-13); an ff integration has nothing to sync",
    async () => {
      const paused = setup({ diverged: true })
      const integration = await prepare(paused.h.services, paused.repo, {
        ...paused,
        area: { ...paused.area, paused: "user" },
      })
      const result = await integrate(paused, integration)
      expect(result.after).toEqual({ ok: true, synced: "paused" })
      expect(head(paused.repo.area)).toBe(paused.repo.source)
      expect(paused.requests).toEqual([])

      const ff = setup()
      const plain = await prepare(ff.h.services, ff.repo, ff)
      expect(plain.how).toBe("ff")
      expect((await integrate(ff, plain)).after).toEqual({ ok: true, synced: "none" })
      expect(markersLeft(ff.repo.commonDir, plain.id)).toEqual([])
    },
    SLOW,
  )
})

describe("an area held by direct work (2026-11-14)", () => {
  test(
    "is not fast-forwarded under the user; its owner gets the sync request, which waits for the hand-back",
    async () => {
      const s = setup({ diverged: true })
      const integration = await prepare(s.h.services, s.repo, {
        ...s,
        area: { ...s.area, directWork: { since: 1, at: 1 } },
      })
      const result = await integrate(s, integration)
      expect(result.after).toEqual({ ok: true, synced: "request" })
      expect(head(s.repo.area)).toBe(s.repo.source)
      expect(s.requests).toEqual([
        { teamID: TEAM_ID, areaID: s.area.id, from: "team", kind: "sync", text: Advance.syncText("main") },
      ])
    },
    SLOW,
  )

  test(
    "a waiting integration started before the stretch is not tried again while held; the hand-back tries it",
    async () => {
      const s = setup({ diverged: true })
      const since = s.clock.now()
      const integration = await prepare(s.h.services, s.repo, {
        ...s,
        area: { ...s.area, directWork: { since, at: since } },
      })
      await IntegrateOp.update(s.h.services, TEAM_ID, integration.id, (current) => ({
        ...current,
        state: "waiting",
        waiting: { why: "in-use", directory: s.repo.home },
      }))
      const integrations = async () =>
        (await s.h.services.journal.list(TEAM_ID)).filter((op) => op.kind === "integrate")
      await s.h.services.features().integrate.retry(TEAM_ID)
      expect(await integrations()).toEqual([])
      expect(
        await s.h.services.features().direct.end({ teamID: TEAM_ID, areaID: s.area.id, why: "handed" }),
      ).toMatchObject({
        waiting: 0,
      })
      const started = await integrations()
      expect(started).toHaveLength(1)
      await s.h.services.runner.settled(started[0]!.id)
    },
    SLOW,
  )
})

describe("as op steps (mergeLocal)", () => {
  async function start(s: Setup, integration: OwnTeam.Integration) {
    Advance.register(s.h.services, s.deps)
    const started = await s.h.services.runner.start({
      teamID: TEAM_ID,
      kind: "integrate",
      by: "main",
      areaID: s.area.id,
      steps: Advance.steps({ integrationID: integration.id, mergeLocal: s.team.policy.mergeLocal }),
    })
    if (!started.ok) throw new Error("busy")
    await s.h.services.runner.settled(started.op.id)
    return (await s.h.services.journal.find(started.op.id))!
  }

  test(
    "auto advances without asking and syncs the area",
    async () => {
      const s = setup({ diverged: true })
      const integration = await prepare(s.h.services, s.repo, s)
      const op = await start(s, integration)
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => [step.kind, step.mode, step.state])).toEqual([
        [Advance.STEP, "auto", "done"],
        [Advance.AFTER, "auto", "done"],
      ])
      expect(op.summary?.lines).toEqual([
        { kind: "integrated", areaID: s.area.id, integrationID: integration.id, newerSkipped: 0 },
      ])
      expect(tipOf(s.repo.home)).toBe(integration.candidate!)
      expect((await current(s, integration.id)).state).toBe("done")
    },
    SLOW,
  )

  test(
    "ask turns the advance into a 10-minute confirm; nothing moves until op.confirm, which then also syncs",
    async () => {
      const s = setup({ diverged: true, mergeLocal: "ask" })
      const integration = await prepare(s.h.services, s.repo, s)
      const op = await start(s, integration)
      expect(op.state).toBe("waiting")
      const step = op.steps[0]!
      expect(op.steps).toHaveLength(1)
      expect(step).toMatchObject({ kind: Advance.STEP, mode: "confirm", state: "needs_confirm" })
      expect(step.confirm?.expiresAt).toBe(s.clock.now() + 10 * 60 * 1000)
      expect(step.confirm?.text).toContain(`'${s.area.name}'`)
      expect(s.h.published.some((event) => event.name === "op.confirm" && event.data.opID === op.id)).toBe(true)
      expect(tipOf(s.repo.home)).toBe(s.repo.base)

      const confirmed = await s.h.services.runner.confirm({
        opID: op.id,
        stepID: step.id,
        choice: "do",
        nonce: step.confirm!.nonce,
      })
      expect(confirmed.ok).toBe(true)
      expect(tipOf(s.repo.home)).toBe(integration.candidate!)
      expect(head(s.repo.area)).toBe(integration.candidate!)
      expect((await current(s, integration.id)).state).toBe("done")
      expect(markersLeft(s.repo.commonDir, integration.id)).toEqual([])
      expect((await s.h.services.journal.find(op.id))?.state).toBe("done")
    },
    SLOW,
  )
})
