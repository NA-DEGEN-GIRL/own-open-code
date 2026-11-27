// 끝내기 (06 §8.1, §8.2, §8.3 TI-4/TI-5/TI-8/TI-9/TI-13, §8.8 `missing`): the `끝낼 수 있음` signal on a manual clock;
// the retire op's steps in order (merged check → outbox cancel → owner archived → retired → the removal confirm); a
// missing folder retires without a removal; an adopted area whose name is deferred keeps its HEAD commits by a keep
// ref and nothing assumes `refs/heads/<branch>`; an owner the team never attached gets only the archive mark; Main 멈춤
// and the safe point skip or refuse. Real git fixtures (F1), a fake service on 127.0.0.1, fake own.accounts answers.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Symlinks } from "../../src/assets/symlinks.js"
import { Refs } from "../../src/git/refs.js"
import { Worktree } from "../../src/git/worktree.js"
import { Undo } from "../../src/ops/undo.js"
import { Remove } from "../../src/reorg/remove.js"
import { Retire } from "../../src/reorg/retire.js"
import { Areas } from "../../src/registry/area.js"
import { Digest } from "../../src/report/digest.js"
import type { Services } from "../../src/services.js"
import { commit, f1, git, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { OWNER_SESSION, TEAM_ID, World, area, controller, team, tempHome } from "../support/context.js"
import { session, start, type FakeService } from "../support/service.js"

/** Git process starts are slow on Windows. */
const SLOW = 180_000
const DAY = 24 * 60 * 60 * 1000
/** When the fixtures' commits are made (fixed, so the 7 days run on the manual clock). */
const MADE = Date.UTC(2026, 8, 20, 9, 0, 0)

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
}, SLOW)

/** The own service: sessions with metadata, `session.active`, `worktree.refresh`. */
class Backend {
  readonly service: FakeService = start()
  readonly metadata = new Map<string, Record<string, unknown>>()
  refreshes = 0

  constructor() {
    this.service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    this.service.routes.set("POST /api/worktree/refresh", () => {
      this.refreshes++
      return new Response(null, { status: 204 })
    })
  }

  add(id: string, directory: string) {
    this.metadata.set(id, {})
    const at = `/api/session/${id}`
    this.service.routes.set(`GET ${at}`, () =>
      Response.json({ data: session({ id, directory, metadata: this.metadata.get(id) }) }),
    )
    this.service.routes.set(`PATCH ${at}`, (request) => {
      const body = Schema.decodeUnknownSync(Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) }))(
        request.body,
      )
      this.metadata.set(id, { ...body.metadata })
      return new Response(null, { status: 204 })
    })
  }
}

async function setup() {
  const root = temp("own-team-retire-")
  cleanups.push(() => root.dispose())
  const repo = f1(root.root)
  const commonDir = path.join(repo.home, ".git")
  const ownHome = await tempHome()
  cleanups.push(() => ownHome[Symbol.asyncDispose]())
  const backend = new Backend()
  cleanups.push(() => backend.service.stop())
  const world = new World()
  // own.accounts: an attached owner's binding carries the team context; `apply` records what was asked.
  world.accounts.set("session.preset.get", () => ({
    binding: {
      presetID: "builtin-codex",
      group: "codex",
      revision: 1,
      appliedAt: 0,
      entryHash: null,
      team: { teamID: TEAM_ID, role: "owner", accounts: [], pinned: [] },
    },
  }))
  world.accounts.set("session.preset.apply", () => ({}))
  const safe: { value: Services.Safe } = { value: { ok: true } }
  const clock = manual(MADE)
  const harness = controller(world, {
    directory: ownHome.root,
    clock,
    home: ownHome.root,
    source: backend.service.source,
    features: { safePoint: () => ({ check: async () => safe.value }) },
  })
  cleanups.push(() => harness.close())
  const record = team({ home: repo.home })
  await harness.services.write(TEAM_ID, () => harness.services.registry.teams.put(record))
  Retire.register(harness.services)
  return { ...harness, repo, commonDir, backend, world, safe, clock, team: record }
}

type Harness = Awaited<ReturnType<typeof setup>>

/** Commits with the fixed time {@link MADE} (author, committer and the reflog entry). */
function commitAt(directory: string, message: string) {
  const date = new Date(MADE).toISOString()
  git(directory, ["add", "-A"])
  git(directory, ["commit", "-q", "-m", message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  return git(directory, ["rev-parse", "HEAD"]).trim()
}

/** An area worktree beside the home (locked as own locks it) and its record with `owner`. */
async function makeArea(
  h: Harness,
  slug: string,
  input: { readonly owner?: OwnTeam.Owner; readonly detach?: boolean; readonly change?: Partial<OwnTeam.Area> } = {},
) {
  const areaID = Areas.id(slug)
  const directory = path.join(`${h.repo.home}-team`, slug)
  const lock = ["--lock", "--reason", Worktree.lockReason(areaID)]
  // The branch's creation is in its reflog too: dated like the commits, so the 7 days run on the manual clock.
  git(
    h.repo.home,
    ["worktree", "add", "-q", ...lock, ...(input.detach ? ["--detach", directory] : ["-b", slug, directory])],
    {
      env: { GIT_COMMITTER_DATE: new Date(MADE).toISOString() },
    },
  )
  const record: OwnTeam.Area = {
    ...area({ slug, directory }),
    gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]).trim(),
    base: { sha: h.repo.head, at: 0 },
    owner: input.owner ?? { sessionID: null, previous: [], attached: false },
    ...input.change,
  }
  await h.services.write(TEAM_ID, () => h.services.registry.areas.put(record))
  return record
}

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

async function answer(h: Harness, op: OwnTeam.Op) {
  const step = op.steps.find((item) => item.state === "needs_confirm")
  if (!step?.confirm) throw new Error("no confirm")
  return h.services.runner.confirm({ opID: op.id, stepID: step.id, choice: "do", nonce: step.confirm.nonce })
}

async function areaOf(h: Harness, areaID: OwnTeam.AreaID) {
  const found = await h.services.registry.areas.get(TEAM_ID, areaID)
  if (!found) throw new Error(`${areaID} is gone`)
  return found
}

function unreachableCommits(h: Harness) {
  return git(h.repo.home, ["fsck", "--unreachable", "--no-reflogs"])
    .split("\n")
    .filter((line) => line.startsWith("unreachable commit"))
}

describe("끝낼 수 있음 (06 §8.1)", () => {
  const facts: Retire.Facts = { commits: 2, unapplied: 0, clean: true, changedAt: MADE, now: MADE + 8 * DAY }
  const record = area({ slug: "done", directory: "D:/x/done", at: MADE })

  test("the signal: own commits, all in the target, clean, 7 days without a change", () => {
    expect(Retire.retirable(record, facts)).toBe(true)
    expect(Retire.retirable(record, { ...facts, now: MADE + 6 * DAY })).toBe(false)
    expect(Retire.retirable(record, { ...facts, commits: 0 })).toBe(false)
    expect(Retire.retirable(record, { ...facts, unapplied: 1 })).toBe(false)
    expect(Retire.retirable(record, { ...facts, clean: false })).toBe(false)
    // The conversation's status and a direct input count as changes too.
    expect(Retire.retirable({ ...record, status: { kind: "idle", at: MADE + 3 * DAY, text: "" } }, facts)).toBe(false)
    const direct = { at: MADE + 3 * DAY, sessionID: OWNER_SESSION }
    expect(Retire.retirable({ ...record, direct }, facts)).toBe(false)
    expect(Retire.retirable({ ...record, state: "retired" }, facts)).toBe(false)
    expect(Retire.retirable({ ...record, state: "broken" }, facts)).toBe(false)
    // A peer's direct input counts as the owner's does (2026-11-14: the mark may sit on the peer).
    const peer: OwnTeam.Peer = {
      key: "rev",
      sessionID: SessionID.make("ses_peer00000000000000000000001"),
      label: "리뷰어",
      role: "",
      attached: true,
      origin: "registered",
      at: MADE,
      direct: { at: MADE + 3 * DAY },
    }
    expect(Retire.retirable({ ...record, peers: [peer] }, facts)).toBe(false)
    expect(Retire.retirable({ ...record, peers: [{ ...peer, direct: { at: MADE } }] }, facts)).toBe(true)
  })

  test("a 내가 정한 영역 or one the user works in directly is a standing area: never 끝낼 수 있음 (AL-5)", () => {
    expect(Retire.retirable({ ...record, userMade: { at: MADE } }, facts)).toBe(false)
    expect(Retire.retirable({ ...record, directWork: { since: MADE, at: MADE } }, facts)).toBe(false)
    expect(Retire.retirable(record, { ...facts, now: MADE + 365 * DAY })).toBe(true)
  })

  test(
    "facts from git on a manual clock: an integrated, clean area becomes retirable after 7 days; a link copy edit or an unapplied commit stops it",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "fin")
      write(record.directory, { "src/app/fin.ts": "export const fin = 1\n" })
      const tip = commitAt(record.directory, "finished work")
      // Integrated: main fast-forwards to the area's tip.
      git(h.repo.home, ["merge", "-q", "--ff-only", "fin"])
      const applied = await Symlinks.apply({ area: record, fix: "skip-worktree" })
      if (!applied.ok) throw new Error(applied.message)
      const linked = { ...record, linkCopies: applied.linkCopies }

      const read = async (now: number) => Retire.facts({ team: h.team, area: linked, now })
      const later = await read(MADE + 8 * DAY)
      expect(later).toMatchObject({ commits: 1, unapplied: 0, clean: true })
      expect(later?.changedAt).toBe(MADE)
      expect(Retire.retirable(linked, later!)).toBe(true)
      expect(Retire.retirable(linked, (await read(MADE + 6 * DAY))!)).toBe(false)

      write(record.directory, { "README-link.md": "edited copy\n" })
      expect((await read(MADE + 8 * DAY))?.clean).toBe(false)
      write(record.directory, { "README-link.md": "# F1\n" })
      write(record.directory, { "src/app/more.ts": "export const more = 1\n" })
      commitAt(record.directory, "not integrated")
      expect(await read(MADE + 8 * DAY)).toMatchObject({ commits: 2, unapplied: 1 })
      // The signal never acts: the area is untouched.
      expect((await areaOf(h, record.id)).state).toBe("active")
      expect(await Refs.read(h.commonDir, "refs/heads/main")).toBe(tip)
    },
    SLOW,
  )
})

describe("끝내기 (06 §8.2)", () => {
  test(
    "merged check → outbox cancel → owner archived → retired → removal confirm; the branch and the conversation stay",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "work", {
        owner: { sessionID: OWNER_SESSION, previous: [], attached: true },
      })
      h.backend.add(OWNER_SESSION, record.directory)
      write(record.directory, { "src/app/work.ts": "export const work = 1\n" })
      const tip = commit(record.directory, "unapplied")
      const dispatch = await h.services.write(TEAM_ID, async () => {
        const item: OwnTeam.Dispatch = {
          id: OwnTeam.DispatchID.create(),
          teamID: TEAM_ID,
          areaID: record.id,
          seq: await h.services.registry.dispatches.next(TEAM_ID, record.id),
          from: "main",
          kind: "task",
          text: "정렬 고치기",
          state: "waiting",
          createdAt: MADE,
        }
        await h.services.registry.dispatches.put(item)
        return item
      })

      const op = await settle(h, await Retire.start(h.services, { teamID: TEAM_ID, areaIDs: [record.id], by: "user" }))
      expect(op.kind).toBe("retire")
      expect(op.state).toBe("waiting")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        [Retire.KIND.begin, "done"],
        [Retire.KIND.keep, "done"],
        [Retire.KIND.check, "done"],
        [Retire.KIND.outbox, "done"],
        [Retire.KIND.archive, "done"],
        [Retire.KIND.mark, "done"],
        [Remove.KIND, "needs_confirm"],
      ])
      expect(op.steps[2]?.note).toBe("반영하지 않은 저장 지점 1개는 기록에 남아요")
      expect(op.steps[6]?.mode).toBe("confirm")
      // The removal dialog's 남는 것 line comes from the step's args (8.2), not from its sentence.
      expect(op.steps[6]?.args).toEqual({ areaID: record.id, unapplied: 1 })
      expect(op.steps[6]?.confirm?.text).not.toContain("반영하지 않은 저장 지점")
      // The waiting request is cancelled, on the card, and in the main's next team update.
      expect(op.summary?.lines).toContainEqual({ kind: "cancelled", areaID: record.id, dispatchID: dispatch.id })
      expect((await h.services.registry.dispatches.find(TEAM_ID, dispatch.id))?.state).toBe("cancelled")
      const digest = await Digest.load(h.services.kv, TEAM_ID)
      expect(digest.entries.map((entry) => entry.text)).toContain(
        "work: 영역을 끝냈습니다 · 기다리던 메인 요청 1개를 보내지 않았습니다",
      )
      // The attached owner leaves the team context and is archived, never deleted (TI-5).
      expect(h.backend.metadata.get(OWNER_SESSION)?.[Undo.ARCHIVED]).toBe(true)
      expect(h.world.calls.filter((call) => call.method === "session.preset.apply").map((call) => call.input)).toEqual([
        { sessionID: OWNER_SESSION, presetID: "builtin-codex", team: null },
      ])
      expect(await areaOf(h, record.id)).toMatchObject({ state: "retired", status: { kind: "retired" } })
      expect(op.summary?.lines).toContainEqual({ kind: "area", areaID: record.id, change: "retired" })
      // TI-12: the lock stays until right before the removal.
      expect(git(h.repo.home, ["worktree", "list", "--porcelain"])).toContain(
        `locked ${Worktree.lockReason(record.id)}`,
      )

      const answered = await answer(h, op)
      expect(answered).toMatchObject({ ok: true, op: { state: "done" } })
      expect(fs.existsSync(record.directory)).toBe(false)
      expect(await Refs.read(h.commonDir, "refs/heads/work")).toBe(tip)
      expect(h.backend.refreshes).toBe(1)
      expect(unreachableCommits(h)).toEqual([])

      // 끝내기 again on the retired area whose folder is gone: nothing to do.
      expect(await Retire.start(h.services, { teamID: TEAM_ID, areaIDs: [record.id], by: "user" })).toMatchObject({
        ok: false,
        error: "not_found",
      })
    },
    SLOW,
  )

  test(
    "a missing folder (broken missing) retires without a removal; git's registration is left as it is",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "gone")
      fs.rmSync(record.directory, { recursive: true, force: true })
      const broken: OwnTeam.Area = {
        ...record,
        state: "broken",
        broken: { why: "missing", at: MADE },
        status: { kind: "broken", at: MADE, text: "찾을 수 없음" },
      }
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put(broken))
      const before = git(h.repo.home, ["worktree", "list", "--porcelain"])
      // TI-14: the main's or the judge's retire skips a broken area; the user's [끝내기] runs (8.8).
      expect(await Retire.plan(h.services, { team: h.team, area: broken, by: "main" })).toMatchObject({
        ok: true,
        steps: [],
        lines: [{ kind: "skipped", areaID: record.id, why: "broken" }],
      })
      h.safe.value = { ok: false, why: "permission", sessionIDs: [] }

      const op = await settle(h, await Retire.start(h.services, { teamID: TEAM_ID, areaIDs: [record.id], by: "user" }))
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => step.kind)).toEqual([
        Retire.KIND.keep,
        Retire.KIND.check,
        Retire.KIND.outbox,
        Retire.KIND.mark,
      ])
      const retired = await areaOf(h, record.id)
      expect(retired).toMatchObject({ state: "retired", status: { kind: "retired" } })
      expect(retired.broken).toBeUndefined()
      expect(git(h.repo.home, ["worktree", "list", "--porcelain"])).toBe(before)
      expect(await Refs.read(h.commonDir, "refs/heads/gone")).toBe(h.repo.head)
    },
    SLOW,
  )

  test(
    "an adopted area with a deferred name: its HEAD commits are keep-ref'd, no refs/heads/<branch> is assumed; an unattached owner gets only the mark",
    async () => {
      const h = await setup()
      const owner = SessionID.make("ses_adopted00000000000000000001")
      const record = await makeArea(h, "adopted", {
        detach: true,
        owner: { sessionID: owner, previous: [], attached: false },
        change: { origin: "adopted", branch: "planned-name", deferredName: true },
      })
      h.backend.add(owner, record.directory)
      write(record.directory, { "src/app/wip.ts": "export const wip = 1\n" })
      const sha = commit(record.directory, "detached work")
      expect(await Refs.read(h.commonDir, "refs/heads/planned-name")).toBeNull()

      const op = await settle(h, await Retire.start(h.services, { teamID: TEAM_ID, areaIDs: [record.id], by: "user" }))
      expect(op.state).toBe("waiting")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        [Retire.KIND.begin, "done"],
        [Retire.KIND.keep, "done"],
        [Retire.KIND.check, "done"],
        [Retire.KIND.outbox, "done"],
        [Retire.KIND.archive, "done"],
        [Retire.KIND.mark, "done"],
        [Remove.KIND, "needs_confirm"],
      ])
      // TI-8 first: HEAD holds the only copy of the commit.
      expect(await Refs.read(h.commonDir, `refs/own/keep/${sha}`)).toBe(sha)
      expect(op.summary?.lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${sha}`, sha })
      expect(op.steps[2]?.note).toBe("반영하지 않은 저장 지점 1개는 기록에 남아요")
      // The conversation was never the team's: the mark, and no preset binding write.
      expect(h.backend.metadata.get(owner)?.[Undo.ARCHIVED]).toBe(true)
      expect(
        h.world.calls.filter(
          (call) => call.method.startsWith("session.preset") && JSON.stringify(call.input).includes(owner),
        ),
      ).toEqual([])

      expect(await answer(h, op)).toMatchObject({ ok: true, op: { state: "done" } })
      expect(fs.existsSync(record.directory)).toBe(false)
      expect(await Refs.read(h.commonDir, "refs/heads/planned-name")).toBeNull()
      expect(unreachableCommits(h)).toEqual([])
    },
    SLOW,
  )

  test(
    "Main 멈춤 skips the main's and the judge's retire (TI-13); not at the safe point: skipped for them, the user's waits and says why (TI-9)",
    async () => {
      const h = await setup()
      const record = await makeArea(h, "paused", { change: { paused: "user" } })
      const op = await settle(h, await Retire.start(h.services, { teamID: TEAM_ID, areaIDs: [record.id], by: "main" }))
      expect(op.state).toBe("done")
      expect(op.steps).toEqual([])
      expect(op.summary?.lines).toEqual([{ kind: "skipped", item: record.id, areaID: record.id, why: "paused" }])
      expect(
        h.published.some(
          (event) => event.name === "notice" && event.data.kind === "reorg.skipped" && event.data.areaID === record.id,
        ),
      ).toBe(true)
      expect((await areaOf(h, record.id)).state).toBe("active")

      const resumed = { ...record, paused: false as const }
      h.safe.value = { ok: false, why: "session", sessionIDs: [OWNER_SESSION] }
      expect(await Retire.plan(h.services, { team: h.team, area: resumed, by: "auto" })).toMatchObject({
        ok: true,
        steps: [],
        lines: [{ kind: "skipped", why: "busy" }],
      })

      // The user's own action runs while Main 멈춤 is on; away from the safe point its first step waits and says why
      // on the card (op.progress), and nothing of the area changes meanwhile.
      const started = await Retire.start(h.services, { teamID: TEAM_ID, areaIDs: [record.id], by: "user" })
      if (!started.ok) throw new Error(started.message)
      const waiting = async () =>
        h.published.some(
          (event) =>
            event.name === "op.progress" &&
            event.data.opID === started.opID &&
            event.data.state === "pending" &&
            event.data.text.includes("영역에서 대화가 일하는 중이라 기다려요"),
        )
      const deadline = Date.now() + 60_000
      while (!(await waiting())) {
        if (Date.now() > deadline) throw new Error("the wait was never shown")
        await Bun.sleep(20)
      }
      const held = (await h.services.journal.get(TEAM_ID, started.opID))!
      expect(held.state).toBe("running")
      expect(held.steps.map((step) => [step.kind, step.state])).toEqual([
        [Retire.KIND.begin, "pending"],
        [Retire.KIND.keep, "pending"],
        [Retire.KIND.check, "pending"],
        [Retire.KIND.outbox, "pending"],
        [Retire.KIND.mark, "pending"],
        [Remove.KIND, "pending"],
      ])
      expect((await areaOf(h, record.id)).state).toBe("active")
      // The area goes quiet: the next look (every 30 s, or a folder event) lets the retirement go on.
      h.safe.value = { ok: true }
      h.clock.advance(30_000)
      const retired = await settle(h, started)
      expect(retired.state).toBe("waiting")
      expect(retired.steps.map((step) => step.state)).toEqual(["done", "done", "done", "done", "done", "needs_confirm"])
      expect((await areaOf(h, record.id)).state).toBe("retired")
      expect(fs.existsSync(record.directory)).toBe(true)
    },
    SLOW,
  )
})
