// Area reconcile (06 §8.8, §4.3, TI-8, TI-13, TI-14, §8.4, §4.14): following branches, folders and identities changed
// outside own, observe-only. HEAD on another branch is followed (`branch.followed`), on another area's branch both areas
// stop (`shared-branch`), a detached HEAD's unique commits get a keep ref, a moved worktree is followed by its git dir
// and its owner conversation moves once at a safe point, a gone folder / branch / identity stops the area with an open
// `area.broken` notice (team news for identity and branch-gone) until it ends, and new worktrees outside the team are
// listed as unadopted. Every case runs twice (the second run changes nothing) and leaves files, branches, HEADs and
// cones as they were. Real git fixtures in temp folders, a fake own service on 127.0.0.1, fake values.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Refs } from "../../src/git/refs.js"
import { Steps } from "../../src/ops/steps.js"
import { Reconcile } from "../../src/reconcile/area.js"
import { git, head, write } from "../fixtures/repo.js"
import { type Fixture, OWNERS, areaID, setup, snapshot } from "../fixtures/reconcile.js"
import { TEAM_ID } from "../support/context.js"

const SLOW = 120_000

const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})

async function team() {
  const fixture = await setup()
  fixtures.push(fixture)
  return fixture
}

/** A second run finds nothing to do: no change, no notice, no write. */
async function settled(fixture: Fixture) {
  const events = fixture.published.length
  const again = await fixture.run()
  expect(again.changes).toEqual([])
  expect(again.notices).toEqual([])
  expect(fixture.published.length).toBe(events)
  return again
}

/** A path as git prints it (`/` on Windows too), by its last folder name. */
function listed(directory: string) {
  return expect.stringMatching(new RegExp(`[/\\\\]${path.basename(directory)}$`))
}

async function open(fixture: Fixture) {
  return fixture.services.notices.open(TEAM_ID)
}

describe("area reconcile (06 §8.8)", () => {
  test(
    "a team nobody changed: nothing changes and nothing is written",
    async () => {
      const fixture = await team()
      const before = snapshot(fixture)
      const rev = (await fixture.services.registry.teams.get(TEAM_ID))?.rev
      expect(await fixture.run()).toEqual({ changes: [], notices: [], unadopted: [] })
      expect((await fixture.services.registry.teams.get(TEAM_ID))?.rev).toBe(rev)
      expect(fixture.backend.moves).toEqual([])
      expect(snapshot(fixture)).toEqual(before)
    },
    SLOW,
  )

  test(
    "HEAD on another branch no area uses: the area follows it, drops its candidate and tells once",
    async () => {
      const fixture = await team()
      const ui = await fixture.area("ui")
      await fixture.services.write(TEAM_ID, async () =>
        fixture.services.registry.areas.put({ ...ui, candidate: { sha: head(fixture.folders.ui), at: 1, text: "끝" } }),
      )
      fixture.git("ui", ["switch", "-q", "-c", "ui-next"])
      const before = snapshot(fixture)

      const result = await fixture.run()
      expect(result.changes).toEqual([{ kind: "branch", areaID: areaID("ui"), from: "ui", to: "ui-next" }])
      const after = await fixture.area("ui")
      expect(after.branch).toBe("ui-next")
      expect(after.candidate).toBeUndefined()
      expect(after.state).toBe("active")
      expect(result.notices).toEqual([
        {
          teamID: TEAM_ID,
          areaID: areaID("ui"),
          kind: "branch.followed",
          text: "'ui' 영역이 다른 기록으로 바뀌어 따라갔어요",
          data: { from: "ui", branch: "ui-next" },
        },
      ])
      expect(fixture.notices().map((notice) => notice.kind)).toEqual(["branch.followed"])
      // One-shot: nothing stays open in team.get.
      expect(await open(fixture)).toEqual([])
      expect(fixture.published.some((event) => event.name === "area.changed")).toBe(true)

      await settled(fixture)
      expect(snapshot(fixture)).toEqual(before)
    },
    SLOW,
  )

  test(
    "HEAD on another area's branch: both areas stop as shared-branch, with open notices, until it ends",
    async () => {
      const fixture = await team()
      fixture.git("save", ["switch", "-q", "--detach"])
      fixture.git("ui", ["switch", "-q", "save"])
      const before = snapshot(fixture)

      const result = await fixture.run()
      // In area id order, as the registry lists them.
      expect(result.changes).toEqual([
        { kind: "broken", areaID: areaID("save"), why: "shared-branch" },
        { kind: "broken", areaID: areaID("ui"), why: "shared-branch" },
      ])
      for (const slug of ["ui", "save"]) {
        const area = await fixture.area(slug)
        expect(area.state).toBe("broken")
        expect(area.broken?.why).toBe("shared-branch")
        expect(area.status.kind).toBe("broken")
        expect(area.branch).toBe(slug)
      }
      expect(result.notices.map((notice) => [notice.kind, notice.areaID, notice.data?.why])).toEqual([
        ["area.broken", areaID("save"), "shared-branch"],
        ["area.broken", areaID("ui"), "shared-branch"],
      ])
      expect((await open(fixture)).map((notice) => [notice.kind, notice.areaID, notice.data?.why])).toEqual([
        ["area.broken", areaID("save"), "shared-branch"],
        ["area.broken", areaID("ui"), "shared-branch"],
      ])
      // Not team news (8.8: only a gone branch and a failed identity check go to the main).
      expect(fixture.news).toEqual([])
      await settled(fixture)
      expect(snapshot(fixture)).toEqual(before)

      fixture.git("ui", ["switch", "-q", "ui"])
      fixture.git("save", ["switch", "-q", "save"])
      const repaired = await fixture.run()
      expect(repaired.changes).toEqual([
        { kind: "repaired", areaID: areaID("save") },
        { kind: "repaired", areaID: areaID("ui") },
      ])
      expect(repaired.notices).toEqual([])
      expect((await fixture.area("ui")).state).toBe("active")
      expect((await fixture.area("ui")).status.kind).toBe("idle")
      expect(await open(fixture)).toEqual([])
    },
    SLOW,
  )

  test(
    "a detached HEAD with a commit no branch has: refs/own/keep/<sha> once, the area keeps its branch",
    async () => {
      const fixture = await team()
      fixture.git("ui", ["switch", "-q", "--detach"])
      write(fixture.folders.ui, { "loose.md": "loose\n" })
      fixture.git("ui", ["add", "-A"])
      fixture.git("ui", ["commit", "-q", "-m", "loose"])
      const sha = head(fixture.folders.ui)
      const before = snapshot(fixture)

      const result = await fixture.run()
      const ref = `refs/own/keep/${sha}`
      expect(result.changes).toEqual([{ kind: "kept", areaID: areaID("ui"), ref, sha }])
      expect(await Refs.read(fixture.commonDir, ref)).toBe(sha)
      expect(result.notices.map((notice) => notice.kind)).toEqual(["detached.kept"])
      const ui = await fixture.area("ui")
      expect(ui.branch).toBe("ui")
      expect(ui.state).toBe("active")

      await settled(fixture)
      expect(snapshot(fixture)).toEqual(before)
    },
    SLOW,
  )

  test(
    "a moved worktree: the folder follows its git dir; the owner moves once, at a safe point, only when its location is gone",
    async () => {
      const fixture = await team()
      const ui = path.join(fixture.root, "home-team", "ui-moved")
      const nest = path.join(fixture.home, ".worktrees", "nest-moved")
      git(fixture.home, ["worktree", "move", fixture.folders.ui, ui])
      git(fixture.home, ["worktree", "move", fixture.folders.nest, nest])
      // The user already moved the nest owner there; save's owner works in the home on purpose.
      fixture.backend.sessions.get(OWNERS.nest)!.directory = nest
      fixture.backend.sessions.get(OWNERS.save)!.directory = fixture.home
      // The ui owner is still running: not a safe point.
      fixture.backend.active.add(OWNERS.ui)
      const before = snapshot(fixture)

      const first = await fixture.run()
      expect(first.changes).toEqual([
        { kind: "directory", areaID: areaID("nest"), from: fixture.folders.nest, to: nest },
        { kind: "directory", areaID: areaID("ui"), from: fixture.folders.ui, to: ui },
      ])
      expect(first.notices.map((notice) => [notice.kind, notice.data])).toEqual([
        ["folder.followed", { from: fixture.folders.nest, directory: nest }],
        ["folder.followed", { from: fixture.folders.ui, directory: ui }],
      ])
      expect((await fixture.area("ui")).directory).toBe(ui)
      expect((await fixture.area("ui")).state).toBe("active")
      expect((await fixture.area("nest")).directory).toBe(nest)
      expect(fixture.backend.moves).toEqual([])

      fixture.backend.active.delete(OWNERS.ui)
      const second = await fixture.run()
      expect(second.changes).toEqual([
        { kind: "moved", areaID: areaID("ui"), sessionID: OWNERS.ui, from: fixture.folders.ui, to: ui },
      ])
      expect(second.notices).toEqual([])
      expect(fixture.backend.moves).toEqual([{ sessionID: OWNERS.ui, directory: ui, delivery: "queue" }])
      const moved = fixture.backend.sessions.get(OWNERS.ui)!
      expect(moved.directory).toBe(ui)
      expect(moved.metadata[OwnTeam.MOVED_META]).toEqual({
        at: fixture.services.clock.now(),
        from: fixture.folders.ui,
        to: ui,
      })

      await settled(fixture)
      expect(fixture.backend.moves).toHaveLength(1)
      expect(snapshot(fixture)).toEqual(before)
    },
    SLOW,
  )

  test(
    "a moved worktree: its attached area peers (동료) move with the owner; a peer not attached yet stays the user's",
    async () => {
      const fixture = await team()
      const attached = SessionID.make("ses_peer00000000000000000000001")
      const registered = SessionID.make("ses_peer00000000000000000000002")
      fixture.backend.add(attached, fixture.folders.ui)
      fixture.backend.add(registered, fixture.folders.ui)
      const peer = (key: string, sessionID: SessionID, on: boolean): OwnTeam.Peer => ({
        key,
        sessionID,
        label: key,
        role: "",
        attached: on,
        origin: "registered",
        at: 1,
      })
      await fixture.services.write(TEAM_ID, async () =>
        fixture.services.registry.areas.put({
          ...(await fixture.area("ui")),
          peers: [peer("sim", attached, true), peer("review", registered, false)],
        }),
      )
      const ui = path.join(fixture.root, "home-team", "ui-moved")
      git(fixture.home, ["worktree", "move", fixture.folders.ui, ui])
      // Nothing runs, so the area is at its safe point: the folder is followed and both move in the same run.
      expect((await fixture.run()).changes).toEqual([
        { kind: "directory", areaID: areaID("ui"), from: fixture.folders.ui, to: ui },
        { kind: "moved", areaID: areaID("ui"), sessionID: OWNERS.ui, from: fixture.folders.ui, to: ui },
        { kind: "moved", areaID: areaID("ui"), sessionID: attached, from: fixture.folders.ui, to: ui },
      ])
      expect(fixture.backend.moves.map((item) => item.sessionID)).toEqual([OWNERS.ui, attached])
      expect(fixture.backend.sessions.get(registered)?.directory).toBe(fixture.folders.ui)
      await settled(fixture)
      expect(fixture.backend.moves).toHaveLength(2)
    },
    SLOW,
  )

  test(
    "a move already waiting in the owner's inbox is not queued again (core's move is not idempotent)",
    async () => {
      const fixture = await team()
      const ui = path.join(fixture.root, "home-team", "ui-moved")
      git(fixture.home, ["worktree", "move", fixture.folders.ui, ui])
      fixture.backend.inbox.set(OWNERS.ui, [
        { id: "inb_move", sessionID: OWNERS.ui, type: "move", delivery: "queue", payload: {} },
      ])
      const first = await fixture.run()
      expect(first.changes).toEqual([{ kind: "directory", areaID: areaID("ui"), from: fixture.folders.ui, to: ui }])
      expect(fixture.backend.moves).toEqual([])

      // Delivered (the inbox is empty) but the conversation still points at the gone folder: moved now.
      fixture.backend.inbox.delete(OWNERS.ui)
      const second = await fixture.run()
      expect(second.changes).toEqual([
        { kind: "moved", areaID: areaID("ui"), sessionID: OWNERS.ui, from: fixture.folders.ui, to: ui },
      ])
      expect(fixture.backend.moves).toEqual([{ sessionID: OWNERS.ui, directory: ui, delivery: "queue" }])
    },
    SLOW,
  )

  test(
    "an adopted area whose naming waited for a stopped git operation is named once it ended (3.7)",
    async () => {
      const fixture = await team()
      fixture.git("save", ["switch", "-q", "--detach"])
      const tip = head(fixture.folders.save)
      // As 팀에 넣기 registers it when a cherry-pick was stopped there: the planned name, not created yet.
      const save = await fixture.area("save")
      await fixture.services.write(TEAM_ID, () =>
        fixture.services.registry.areas.put({ ...save, origin: "adopted", branch: "save-named", deferredName: true }),
      )
      const stopped = path.join(save.gitDir, "CHERRY_PICK_HEAD")
      fs.writeFileSync(stopped, `${tip}\n`)
      const waiting = await fixture.run()
      expect(waiting.changes).toEqual([])
      expect(await Refs.read(fixture.commonDir, "refs/heads/save-named")).toBeNull()
      expect((await fixture.area("save")).deferredName).toBe(true)

      fs.rmSync(stopped)
      const named = await fixture.run()
      expect(named.changes).toEqual([])
      expect(await fixture.area("save")).toMatchObject({ state: "active", branch: "save-named" })
      expect((await fixture.area("save")).deferredName).toBeUndefined()
      expect(fixture.git("save", ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/save-named")
      expect(head(fixture.folders.save)).toBe(tip)
      expect(await Refs.read(fixture.commonDir, "refs/heads/save-named")).toBe(tip)
      expect(await open(fixture)).toEqual([])
      expect(fixture.news).toEqual([])
      await settled(fixture)

      // Without the mark (a branch the user deleted later), the name is never made again: `branch-gone` as before.
      fixture.git("save", ["switch", "-q", "--detach"])
      fixture.git("save", ["branch", "-q", "-D", "save-named"])
      const gone = await fixture.run()
      expect(gone.changes).toEqual([{ kind: "broken", areaID: areaID("save"), why: "branch-gone" }])
      expect(await Refs.read(fixture.commonDir, "refs/heads/save-named")).toBeNull()
    },
    SLOW,
  )

  test(
    "overlapping runs of one team take turns: the owner of a moved folder moves once",
    async () => {
      const fixture = await team()
      const ui = path.join(fixture.root, "home-team", "ui-moved")
      git(fixture.home, ["worktree", "move", fixture.folders.ui, ui])

      const [first, second] = await Promise.all([
        fixture.run(),
        fixture.reconcile.run({ id: TEAM_ID }, { trigger: "start" }),
      ])
      expect(first.changes).toEqual([
        { kind: "directory", areaID: areaID("ui"), from: fixture.folders.ui, to: ui },
        { kind: "moved", areaID: areaID("ui"), sessionID: OWNERS.ui, from: fixture.folders.ui, to: ui },
      ])
      expect(second.changes).toEqual([])
      expect(fixture.backend.moves).toEqual([{ sessionID: OWNERS.ui, directory: ui, delivery: "queue" }])
    },
    SLOW,
  )

  test(
    "a deleted folder: broken 'missing' with an open notice; its waiting main requests stay waiting",
    async () => {
      const fixture = await team()
      const dispatch: OwnTeam.Dispatch = {
        id: OwnTeam.DispatchID.create(),
        teamID: TEAM_ID,
        areaID: areaID("save"),
        seq: 0,
        from: "main",
        kind: "task",
        text: "저장 형식을 정리해 주세요",
        state: "waiting",
        createdAt: fixture.services.clock.now(),
      }
      await fixture.services.write(TEAM_ID, () => fixture.services.registry.dispatches.put(dispatch))
      fs.rmSync(fixture.folders.save, { recursive: true, force: true })
      const before = snapshot(fixture)

      const result = await fixture.run()
      expect(result.changes).toEqual([{ kind: "broken", areaID: areaID("save"), why: "missing" }])
      expect(result.notices).toEqual([
        {
          teamID: TEAM_ID,
          areaID: areaID("save"),
          kind: "area.broken",
          text: "'save' 폴더를 찾을 수 없어요",
          data: { why: "missing" },
        },
      ])
      const save = await fixture.area("save")
      expect(save.broken).toEqual({ why: "missing", at: fixture.services.clock.now() })
      expect(save.directory).toBe(fixture.folders.save)
      expect(await open(fixture)).toEqual([
        {
          id: `area.broken:${areaID("save")}:missing`,
          at: fixture.services.clock.now(),
          areaID: areaID("save"),
          kind: "area.broken",
          text: "'save' 폴더를 찾을 수 없어요",
          data: { why: "missing" },
        },
      ])
      expect(fixture.news).toEqual([])

      const admit = fixture.services.features().admit
      await admit.drain({ teamID: TEAM_ID, areaID: areaID("save") })
      expect(await admit.list({ teamID: TEAM_ID, areaID: areaID("save") })).toEqual({
        ok: true,
        items: [dispatch],
        why: "broken",
        // RH-20: since when it waits (outbox.list).
        since: fixture.services.clock.now(),
      })
      await settled(fixture)
      expect(await fixture.services.registry.dispatches.waiting(TEAM_ID)).toEqual([dispatch])
      expect(snapshot(fixture)).toEqual(before)
    },
    SLOW,
  )

  test(
    "a deleted branch: broken 'branch-gone', the main hears it once; recreated, the broken state ends",
    async () => {
      const fixture = await team()
      const tip = head(fixture.folders.save)
      fixture.git("save", ["switch", "-q", "--detach"])
      git(fixture.home, ["branch", "-q", "-D", "save"])
      const before = snapshot(fixture)

      const result = await fixture.run()
      expect(result.changes).toEqual([
        // The detached HEAD now holds the branch's commits alone (TI-8).
        { kind: "kept", areaID: areaID("save"), ref: `refs/own/keep/${tip}`, sha: tip },
        { kind: "broken", areaID: areaID("save"), why: "branch-gone" },
      ])
      expect(result.notices.map((notice) => [notice.kind, notice.data?.why])).toEqual([
        ["detached.kept", undefined],
        ["area.broken", "branch-gone"],
      ])
      expect(fixture.news).toEqual([
        {
          at: fixture.services.clock.now(),
          areaID: areaID("save"),
          reason: "broken",
          text: "고칠 때까지 이 영역에 보내는 메인 요청은 기다립니다",
          wake: true,
        },
      ])
      expect((await open(fixture)).map((notice) => notice.id)).toEqual([`area.broken:${areaID("save")}:branch-gone`])
      await settled(fixture)
      expect(fixture.news).toHaveLength(1)
      expect(snapshot(fixture)).toEqual(before)

      git(fixture.home, ["branch", "-q", "save", tip])
      const repaired = await fixture.run()
      expect(repaired.changes).toEqual([{ kind: "repaired", areaID: areaID("save") }])
      expect((await fixture.area("save")).state).toBe("active")
      expect(await open(fixture)).toEqual([])
    },
    SLOW,
  )

  test(
    "a nested area without its .git file: broken 'identity', the main hears it, the home stays as it was",
    async () => {
      const fixture = await team()
      fs.rmSync(path.join(fixture.folders.nest, ".git"))
      const before = snapshot(fixture)
      const status = git(fixture.home, ["status", "--porcelain=v2", "--branch", "--ignored=matching"])

      const result = await fixture.run()
      expect(result.changes).toEqual([{ kind: "broken", areaID: areaID("nest"), why: "identity" }])
      expect(result.notices.map((notice) => [notice.kind, notice.data?.why])).toEqual([["area.broken", "identity"]])
      expect(fixture.news.map((entry) => [entry.areaID, entry.reason, entry.wake])).toEqual([
        [areaID("nest"), "broken", true],
      ])
      const nest = await fixture.area("nest")
      expect(nest.directory).toBe(fixture.folders.nest)
      expect(nest.state).toBe("broken")

      await settled(fixture)
      expect(git(fixture.home, ["status", "--porcelain=v2", "--branch", "--ignored=matching"])).toBe(status)
      expect(snapshot(fixture)).toEqual(before)
    },
    SLOW,
  )

  test(
    "a new worktree outside the team: listed as unadopted, recorded in team.external, announced once",
    async () => {
      const fixture = await team()
      const side = path.join(fixture.root, "side")
      const tool = path.join(fixture.root, "x", ".claude", "worktrees", "tool")
      git(fixture.home, ["worktree", "add", "-q", "-b", "side", side, "main"])
      write(side, { "side.md": "side\n" })
      git(side, ["add", "-A"])
      git(side, ["commit", "-q", "-m", "side"])
      write(side, { "draft.md": "draft\n" })
      git(fixture.home, ["worktree", "add", "-q", "--detach", tool, "main"])
      const before = snapshot(fixture)

      const result = await fixture.run()
      expect(result.unadopted).toEqual([{ kind: "unadopted", directory: listed(side), changes: 1, ahead: 1 }])
      expect(result.changes).toEqual([
        {
          kind: "external",
          added: [
            { directory: listed(side), why: "left" },
            { directory: listed(tool), why: "other-tool" },
          ],
          removed: [],
        },
      ])
      expect(result.notices).toEqual([
        { teamID: TEAM_ID, kind: "external.found", text: "팀 밖의 작업 폴더 1개를 찾았어요", data: { count: 1 } },
      ])
      // One-shot: nothing stays open in team.get.
      expect(await open(fixture)).toEqual([])
      expect((await fixture.services.registry.teams.get(TEAM_ID))?.external).toEqual([
        { directory: listed(side), why: "left" },
        { directory: listed(tool), why: "other-tool" },
      ])
      expect(fixture.published.some((event) => event.name === "team.changed")).toBe(true)

      const again = await settled(fixture)
      expect(again.unadopted).toEqual(result.unadopted)
      expect(snapshot(fixture)).toEqual(before)

      git(fixture.home, ["worktree", "remove", "--force", side])
      const removed = await fixture.run()
      expect(removed.changes).toEqual([{ kind: "external", added: [], removed: [listed(side)] }])
      expect(removed.unadopted).toEqual([])
      expect(removed.notices).toEqual([])
    },
    SLOW,
  )

  test(
    "a folder with a git operation stopped half way is observed only",
    async () => {
      const fixture = await team()
      fixture.git("ui", ["switch", "-q", "--detach"])
      write(fixture.folders.ui, { "loose.md": "loose\n" })
      fixture.git("ui", ["add", "-A"])
      fixture.git("ui", ["commit", "-q", "-m", "loose"])
      const sha = head(fixture.folders.ui)
      const gitDir = (await fixture.area("ui")).gitDir
      fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), `${sha}\n`)
      const before = snapshot(fixture)

      expect(await fixture.run()).toEqual({ changes: [], notices: [], unadopted: [] })
      expect(await Refs.read(fixture.commonDir, `refs/own/keep/${sha}`)).toBeNull()
      expect(snapshot(fixture)).toEqual(before)

      fs.rmSync(path.join(gitDir, "MERGE_HEAD"))
      expect((await fixture.run()).changes).toEqual([
        { kind: "kept", areaID: areaID("ui"), ref: `refs/own/keep/${sha}`, sha },
      ])
    },
    SLOW,
  )

  test(
    "registry records are written only inside the controller's write section",
    async () => {
      const fixture = await team()
      const depth = { inside: 0 }
      const writes: Array<{ readonly key: string; readonly inside: boolean }> = []
      const set = fixture.world.kv.set.bind(fixture.world.kv)
      fixture.world.kv.set = (key, value) => {
        if (/^(team|area):/.test(key)) writes.push({ key, inside: depth.inside > 0 })
        return set(key, value)
      }
      const services = fixture.services
      const tracked = Reconcile.create({
        ...services,
        // A registry of its own: the fixture's service registered the step kind already.
        steps: new Steps.Registry(),
        write: (teamID, section) =>
          services.write(teamID, async () => {
            depth.inside++
            return section().finally(() => depth.inside--)
          }),
      })
      fixture.git("ui", ["switch", "-q", "-c", "ui-next"])
      git(fixture.home, ["worktree", "add", "-q", "-b", "side", path.join(fixture.root, "side"), "main"])

      const result = await tracked.run({ id: TEAM_ID }, { trigger: "start" })
      expect(result.changes.map((change) => change.kind)).toEqual(["branch", "external"])
      expect(writes.length).toBeGreaterThan(0)
      expect(writes.filter((item) => !item.inside)).toEqual([])
    },
    SLOW,
  )

  test(
    "the reconcile-move step in an op: done when nothing moved, skipped away from a safe point, moves at one",
    async () => {
      const fixture = await team()
      const step = async () => {
        const started = await fixture.services.runner.start({
          teamID: TEAM_ID,
          kind: "reorg",
          by: "auto",
          steps: [{ kind: Reconcile.MOVE, args: { areaID: areaID("ui") } }],
        })
        if (!started.ok) throw new Error(`busy with ${started.op.id}`)
        await fixture.services.runner.settled(started.op.id)
        const op = await fixture.services.journal.find(started.op.id)
        return [op?.state, op?.steps[0]?.state, op?.steps[0]?.note]
      }
      expect(await step()).toEqual(["done", "done", undefined])

      const moved = path.join(fixture.root, "home-team", "ui-moved")
      git(fixture.home, ["worktree", "move", fixture.folders.ui, moved])
      fixture.backend.active.add(OWNERS.ui)
      await fixture.run()
      expect(fixture.backend.moves).toEqual([])
      // TI-9: an automatic step skips an area that is not at its safe point.
      expect(await step()).toEqual(["done", "skipped", "영역이 아직 쉬는 중이 아니에요"])
      fixture.backend.active.delete(OWNERS.ui)
      expect(await step()).toEqual(["done", "done", undefined])
      expect(fixture.backend.moves).toEqual([{ sessionID: OWNERS.ui, directory: moved, delivery: "queue" }])
      expect(fixture.backend.sessions.get(OWNERS.ui)?.metadata[OwnTeam.MOVED_META]).toMatchObject({ to: moved })
      expect((await fixture.run()).changes).toEqual([])
    },
    SLOW,
  )
})
