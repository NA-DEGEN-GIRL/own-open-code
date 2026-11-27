// 팀에 넣기 / 빼기 (06 §8.2, §3.6, §3.7; TG15 adopt registration, TG16 approval tail after unadopt): `area.adopt` locks a
// folder (and the candidate around a nested one), names nothing on a branch and registers its most recent root session
// without attaching it; `area.unadopt` cancels the area's waiting main requests (told to the main), detaches the owner,
// releases the lock (a folder holding nested worktrees keeps one) and removes only the registry record. The adopt op is
// undoable. Real git fixtures, fake service on 127.0.0.1, fake own.accounts; every value is fake.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Classify } from "../../src/git/classify.js"
import { Worktree } from "../../src/git/worktree.js"
import { Adopt } from "../../src/ops/adopt.js"
import { TeamHome } from "../../src/ops/home.js"
import { Areas } from "../../src/registry/area.js"
import { Digest } from "../../src/report/digest.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import type { Services } from "../../src/services.js"
import { Permissions } from "../../src/tools/permissions.js"
import { F4_NOW, F4_PRESETS, F4_REFS, F4Service, f4Accounts } from "../fixtures/f4-layout.js"
import { commit, f1, files, git, head, status, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { start } from "../support/service.js"

const SLOW = 180_000

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
}, SLOW)

const OUTER_OWNER = SessionID.make("ses_outer0000000000000000000001")
const COMPUTER = { action: "computer", resource: "*", effect: "allow" } as const

/**
 * F1 with two linked worktrees beside the main one: `outer` (a commit not in main) holding the nested `inner`, and
 * `spare`. The team's home is the main worktree; sessions in the home (the team main) and in `outer`.
 */
async function setup() {
  const root = temp("own-team-unadopt-")
  cleanups.push(() => root.dispose())
  const repo = f1(root.root)
  const commonDir = path.join(repo.home, ".git")
  fs.appendFileSync(path.join(commonDir, "info", "exclude"), ".worktrees/\n")
  const outer = path.join(root.root, "outer")
  git(repo.home, ["worktree", "add", "-q", "-b", "outer-work", outer, "main"])
  write(outer, { "src/outer.ts": "export const outer = 1\n" })
  commit(outer, "outer")
  const inner = path.join(outer, ".worktrees", "inner")
  git(repo.home, ["worktree", "add", "-q", "-b", "inner-work", inner, "main"])
  const spare = path.join(root.root, "spare")
  git(repo.home, ["worktree", "add", "-q", "-b", "spare-work", spare, "main"])

  const ownHome = await tempHome()
  cleanups.push(() => ownHome[Symbol.asyncDispose]())
  const fake = start()
  cleanups.push(() => fake.stop())
  const backend = new F4Service(fake)
  const world = new World()
  const models = new Map<string, Model.Ref>([
    [MAIN_SESSION, F4_REFS.team],
    [OUTER_OWNER, F4_REFS.team],
  ])
  const accounts = f4Accounts(world.accounts, models)
  backend.add({ id: MAIN_SESSION, directory: repo.home, updated: F4_NOW, model: F4_REFS.team })
  const owner = backend.add({ id: OUTER_OWNER, directory: outer, updated: F4_NOW - 60_000, model: F4_REFS.team })
  world.sessions.set(OUTER_OWNER, { id: OUTER_OWNER, directory: outer, permissions: [COMPUTER] })
  const safe: { value: Services.Safe } = { value: { ok: true } }
  const harness = controller(world, {
    directory: ownHome.root,
    clock: manual(F4_NOW),
    home: ownHome.root,
    source: fake.source,
    features: { safePoint: () => ({ check: async () => safe.value }) },
  })
  cleanups.push(() => harness.close())
  // The three folders are outside the team, as enable or reconcile lists them (`team.external`, 9.4).
  const external = [inner, outer, spare].map((directory) => ({ directory, why: "left" as const }))
  await harness.services.write(TEAM_ID, () =>
    harness.services.registry.teams.put({ ...team({ home: repo.home }), external }),
  )
  return { ...harness, repo, commonDir, outer, inner, spare, backend, fake, world, accounts, owner, safe }
}

type Harness = Awaited<ReturnType<typeof setup>>

async function settle(h: Harness, started: Services.Result<{ readonly opID: OwnTeam.OpID }>) {
  if (!started.ok) throw new Error(`${started.error}: ${started.message}`)
  const deadline = Date.now() + 120_000
  const read = () => h.services.journal.get(TEAM_ID, started.opID)
  while ((await read())?.state === "running") {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
  return (await read())!
}

/** `team.external` by folder name: what 팀에 넣기 offers (9.4). */
async function outsideList(h: Harness) {
  return (await h.services.registry.teams.get(TEAM_ID))!.external.map((item) => [
    path.basename(item.directory),
    item.why,
  ])
}

async function lockOf(commonDir: string, directory: string) {
  const held = (await TeamHome.snapshot(commonDir)) ?? {}
  return Object.entries(held).find(([where]) => Classify.same(where, directory))?.[1] ?? null
}

function snapshot(directory: string) {
  return {
    head: head(directory),
    branch: git(directory, ["branch", "--show-current"]).trim(),
    status: status(directory),
  }
}

const OUTER = Areas.id("outer")
const INNER = Areas.id("inner")

describe("팀에 넣기 (area.adopt)", () => {
  test(
    "locks the folder and the candidate around a nested one, registers the owner unattached; refusals",
    async () => {
      const h = await setup()
      const before = snapshot(h.outer)
      const inner = await settle(h, await Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory: h.inner }))
      expect(inner.state).toBe("done")
      expect(inner.kind).toBe("adopt")
      expect(inner.areaID).toBe(INNER)
      expect(inner.steps.map((step) => step.kind)).toEqual(["team.lock", "team.lock", "adopt.register"])
      expect(await lockOf(h.commonDir, h.inner)).toBe(Worktree.lockReason(INNER))
      // `outer` holds `inner`: removing it would take the area along (8.6), so it is locked for that reason.
      expect(await lockOf(h.commonDir, h.outer)).toBe(TeamHome.NESTED)
      expect(await h.services.registry.areas.get(TEAM_ID, INNER)).toMatchObject({
        name: "inner",
        origin: "adopted",
        branch: "inner-work",
        owner: { sessionID: null, attached: false },
        preset: F4_PRESETS.star.id,
      })
      expect(inner.summary?.lines).toEqual([{ kind: "area", areaID: INNER, change: "adopted" }])
      // An area is no longer offered under 팀에 넣기 (8.2), before any reconcile.
      expect(await outsideList(h)).toEqual([
        ["outer", "left"],
        ["spare", "left"],
      ])

      const outer = await settle(h, await Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory: h.outer }))
      expect(outer.state).toBe("done")
      expect(await lockOf(h.commonDir, h.outer)).toBe(Worktree.lockReason(OUTER))
      expect(await h.services.registry.areas.get(TEAM_ID, OUTER)).toMatchObject({
        branch: "outer-work",
        owner: { sessionID: OUTER_OWNER, attached: false },
        main: { model: F4_REFS.team, chosenBy: "adopted" },
      })
      expect(snapshot(h.outer)).toEqual(before)
      expect(h.world.sessions.get(OUTER_OWNER)?.permissions).toEqual([COMPUTER])
      expect(await outsideList(h)).toEqual([["spare", "left"]])

      // Refusals: the home (the main worktree here), a folder already in the team, no repository, another repository.
      const refuse = (directory: string) => Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory })
      expect(await refuse(h.repo.home)).toMatchObject({ ok: false, error: "path_forbidden", data: { why: "invalid" } })
      expect(await refuse(h.outer)).toMatchObject({ ok: false, error: "path_forbidden", data: { why: "invalid" } })
      const plain = temp("own-team-unadopt-plain-")
      cleanups.push(() => plain.dispose())
      expect(await refuse(plain.root)).toMatchObject({ ok: false, error: "not_git" })
      const other = temp("own-team-unadopt-other-")
      cleanups.push(() => other.dispose())
      expect(await refuse(f1(other.root).home)).toMatchObject({ ok: false, error: "path_forbidden" })
      expect(await refuse("relative/dir")).toMatchObject({ ok: false, error: "path_forbidden" })
    },
    SLOW,
  )

  test(
    "a rebase stopped in the folder: registered with the branch it started from, no new name (3.7)",
    async () => {
      const h = await setup()
      write(h.spare, { "src/spare.ts": "export const spare = 1\n" })
      commit(h.spare, "spare")
      const stopped = Bun.spawnSync(["git", "-C", h.spare, "rebase", "--force-rebase", "--exec", "exit 1", "HEAD~1"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(stopped.exitCode).not.toBe(0)
      expect(git(h.spare, ["branch", "--show-current"]).trim()).toBe("")
      const adopted = await settle(h, await Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory: h.spare }))
      expect(adopted.state).toBe("done")
      // Nothing is named (a rebased commit only the detached HEAD holds may get a keep ref first, TI-8).
      expect(adopted.steps.map((step) => step.kind).filter((kind) => kind !== "adopt.keep")).toEqual([
        "team.lock",
        "adopt.register",
      ])
      expect(await h.services.registry.areas.get(TEAM_ID, Areas.id("spare"))).toMatchObject({ branch: "spare-work" })
      git(h.spare, ["rebase", "--abort"])
      expect(git(h.spare, ["branch", "--show-current"]).trim()).toBe("spare-work")
    },
    SLOW,
  )

  test(
    "undo of 팀에 넣기 is 빼기 of that area: unlocked, registry entry gone, folder and conversation untouched",
    async () => {
      const h = await setup()
      const adopted = await settle(h, await Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory: h.spare }))
      expect(adopted.undo).toEqual({ available: true })
      // As 빼기: refused while the area works (8.4), nothing started and the op stays undoable.
      h.safe.value = { ok: false, why: "session", sessionIDs: [] }
      expect(await h.services.features().undo.start({ opID: adopted.id, by: "user" })).toMatchObject({
        ok: false,
        error: "not_safe_point",
        data: { areaID: Areas.id("spare"), why: "session" },
      })
      expect((await h.services.journal.get(TEAM_ID, adopted.id))?.undo).toEqual({ available: true })
      h.safe.value = { ok: true }
      const undo = await settle(h, await h.services.features().undo.start({ opID: adopted.id, by: "user" }))
      expect(undo.state).toBe("done")
      expect(undo.steps.map((step) => step.kind)).toEqual([
        "adopt.outbox",
        "adopt.detach",
        "team.restore",
        "adopt.unregister",
        "undo.mark",
      ])
      expect(await lockOf(h.commonDir, h.spare)).toBeNull()
      expect(await h.services.registry.areas.get(TEAM_ID, Areas.id("spare"))).toBeUndefined()
      expect(await h.services.registry.teams.get(TEAM_ID)).toMatchObject({ state: "on" })
      expect(git(h.spare, ["branch", "--show-current"]).trim()).toBe("spare-work")
      // Offered under 팀에 넣기 again right away.
      expect(await outsideList(h)).toEqual([
        ["inner", "left"],
        ["outer", "left"],
        ["spare", "left"],
      ])
    },
    SLOW,
  )
})

describe("팀에서 빼기 (area.unadopt)", () => {
  test(
    "waiting requests cancelled and told to the main, owner detached, nested lock kept, only the record removed",
    async () => {
      const h = await setup()
      await settle(h, await Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory: h.inner }))
      await settle(h, await Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory: h.outer }))
      h.accounts.modes.set(OUTER_OWNER, "ask")
      expect(await h.services.features().owner.attach({ teamID: TEAM_ID, areaID: OUTER })).toEqual({ ok: true })
      expect(h.world.sessions.get(OUTER_OWNER)?.permissions).toEqual([...Permissions.rules("owner"), COMPUTER])
      // One after the other: each request takes the next seq of the area.
      const record = (text: string) =>
        h.services.write(TEAM_ID, async () => {
          const dispatch: OwnTeam.Dispatch = {
            id: OwnTeam.DispatchID.create(),
            teamID: TEAM_ID,
            areaID: OUTER,
            seq: await h.services.registry.dispatches.next(TEAM_ID, OUTER),
            from: "main",
            kind: "task",
            text,
            state: "waiting",
            createdAt: F4_NOW,
          }
          await h.services.registry.dispatches.put(dispatch)
          return dispatch
        })
      const waiting = [await record("정렬 고치기"), await record("테스트 더하기")]
      const before = { snapshot: snapshot(h.outer), files: files(h.outer) }

      // Not at a safe point (8.4): refused, nothing started.
      h.safe.value = { ok: false, why: "session", sessionIDs: [OUTER_OWNER] }
      expect(await Adopt.unadoptOp(h.services, { teamID: TEAM_ID, areaID: OUTER })).toMatchObject({
        ok: false,
        error: "not_safe_point",
        data: { areaID: OUTER, why: "session" },
      })
      h.safe.value = { ok: true }

      const approvals = h.world.calls.filter((call) => call.method === "session.approval.set").length
      const op = await settle(h, await Adopt.unadoptOp(h.services, { teamID: TEAM_ID, areaID: OUTER }))
      expect(op.state).toBe("done")
      expect(op.kind).toBe("unadopt")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        ["adopt.outbox", "done"],
        ["adopt.detach", "done"],
        ["team.release", "done"],
        ["adopt.unregister", "done"],
      ])
      // The waiting requests are cancelled, listed on the card and told to the main in its next team news.
      for (const dispatch of waiting) {
        expect(op.summary?.lines).toContainEqual({ kind: "cancelled", areaID: OUTER, dispatchID: dispatch.id })
        expect((await h.services.registry.dispatches.find(TEAM_ID, dispatch.id))?.state).toBe("cancelled")
      }
      const digest = await Digest.load(h.services.kv, TEAM_ID)
      expect(digest.entries.map((entry) => entry.text)).toContain(
        "outer: 팀에서 뺐습니다 · 기다리던 메인 요청 2개를 보내지 않았습니다",
      )
      expect(await h.services.features().digest.render({ teamID: TEAM_ID })).toContain("outer: 팀에서 뺐습니다")
      // The attached allows and role are gone and own.accounts' bundle is last again (TG16).
      expect(h.world.sessions.get(OUTER_OWNER)?.permissions).toEqual([COMPUTER])
      expect(h.owner.entries.has(RoleInstructions.OWNER)).toBe(false)
      expect(
        h.world.calls
          .filter((call) => call.method === "session.approval.set")
          .slice(approvals)
          .map((call) => call.input),
      ).toEqual([{ sessionID: OUTER_OWNER, mode: "ask" }])
      // `outer` holds the nested area `inner`: its lock stays with the nested reason.
      expect(await lockOf(h.commonDir, h.outer)).toBe(TeamHome.NESTED)
      expect(op.summary?.lines).toContainEqual({ kind: "lock-kept", directory: expect.any(String) })
      expect(op.summary?.lines).toContainEqual({ kind: "area", areaID: OUTER, change: "unadopted" })
      // Only the registry record went: folder, branch, conversation and the other area stay.
      expect(await h.services.registry.areas.get(TEAM_ID, OUTER)).toBeUndefined()
      expect(await h.services.registry.areas.get(TEAM_ID, INNER)).toBeDefined()
      expect({ snapshot: snapshot(h.outer), files: files(h.outer) }).toEqual(before)
      expect(h.backend.sessions.get(OUTER_OWNER)?.metadata).toEqual({})
      // Still locked for the nested area, so not offered under 팀에 넣기 (reconcile leaves own's locks out too).
      expect(await outsideList(h)).toEqual([["spare", "left"]])

      // A folder with nothing nested inside is unlocked completely.
      const last = await settle(h, await Adopt.unadoptOp(h.services, { teamID: TEAM_ID, areaID: INNER }))
      expect(last.state).toBe("done")
      expect(await lockOf(h.commonDir, h.inner)).toBeNull()
      expect(await h.services.registry.areas.list(TEAM_ID)).toEqual([])
      // Taken out of the team, it is offered under 팀에 넣기 again before the next reconcile (8.2, 8.8).
      expect(await outsideList(h)).toEqual([
        ["spare", "left"],
        ["inner", "left"],
      ])
    },
    SLOW,
  )

  test("an area own created is not taken out this way; unknown areas and a team that is off are refused", async () => {
    const h = await setup()
    const made = area({ slug: "inventory-ui", directory: path.join(h.repo.home, "..", "inventory-ui") })
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put(made))
    expect(await Adopt.unadoptOp(h.services, { teamID: TEAM_ID, areaID: made.id })).toMatchObject({
      ok: false,
      error: "unsupported",
    })
    expect(
      await Adopt.unadoptOp(h.services, { teamID: TEAM_ID, areaID: OwnTeam.AreaID.make("ar_nothing") }),
    ).toMatchObject({ ok: false, error: "not_found", data: { what: "area" } })
    await h.services.write(TEAM_ID, async () =>
      h.services.registry.teams.put({ ...(await h.services.registry.teams.get(TEAM_ID))!, state: "off" }),
    )
    expect(await Adopt.unadoptOp(h.services, { teamID: TEAM_ID, areaID: made.id })).toMatchObject({
      ok: false,
      error: "team_off",
    })
    expect(await Adopt.adoptOp(h.services, { teamID: TEAM_ID, directory: h.spare })).toMatchObject({
      ok: false,
      error: "team_off",
    })
  })
})
