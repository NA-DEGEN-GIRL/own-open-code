// 영역 묶기 A + B → A (06 §8.2, §7.2 steps 1-5, §7.4, §8.7, TG12 merge items) on git fixtures: ff and true merge
// through integrate/merge.ts (K dated at the op), the conflict request to A, the commit request to a dirty B, the WIP
// confirm of an adopted B without a conversation, a B without a branch yet, B's handoff on A's owner, the outbox moving
// in order with `movedFrom`, B archived and retired with its branch kept, and the undo (only while A is still at K).
// Temp repositories, a fake loopback service and fake own.accounts answers only.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Merge } from "../../src/integrate/merge.js"
import type { Steps } from "../../src/ops/steps.js"
import { Undo } from "../../src/ops/undo.js"
import { AreaMerge } from "../../src/reorg/merge.js"
import { Remove } from "../../src/reorg/remove.js"
import { AreaSplit } from "../../src/reorg/split.js"
import { commit, git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"
import { removeTree } from "../support/remove.js"
import { session, start } from "../support/service.js"

const box = temp("own-team-merge-")
// Removing many fixture repositories takes a while on Windows, and a git process that just ended may still hold one.
afterAll(() => removeTree(box.root, 20, 250), 120_000)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Git-heavy tests: Windows process starts are slow on a busy machine. */
const SLOW = 240_000

const INTO_OWNER = SessionID.make("ses_into0000000000000000000001")
const FROM_OWNER = SessionID.make("ses_from0000000000000000000001")
const ANSWER = { type: "assistant", content: [{ type: "text", text: "api 작업을 마쳤습니다" }] }

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

/** A home on `main` (README, src, docs) and the folders of `ui` (A) and `api` (B) next to it. */
function repository(name: string) {
  const home = init(path.join(box.root, name, "home"))
  write(home, { "README.md": "# merge\n", "src/app.ts": "export const app = 1\n", "docs/guide.md": "guide\n" })
  const base = commit(home, "base")
  const record = team({ home })
  const add = (slug: string, owner: SessionID | null, options: { readonly detach?: boolean } = {}) => {
    const directory = path.join(record.worktreeRoot, slug)
    git(
      home,
      options.detach
        ? ["worktree", "add", "-q", "--detach", directory, base]
        : ["worktree", "add", "-q", "-b", slug, directory, base],
    )
    const gitDir = git(directory, ["rev-parse", "--absolute-git-dir"]).trim()
    const made: OwnTeam.Area = {
      ...area({ slug, directory }),
      gitDir,
      branch: slug,
      base: { sha: base, at: 0 },
      owner: { sessionID: owner, previous: [], attached: owner !== null },
    }
    return made
  }
  return { home, base, team: record, add }
}

/** Commits `files` in the checkout and returns the new HEAD. */
function save(dir: string, files: Readonly<Record<string, string>>, message: string) {
  write(dir, files)
  return commit(dir, message)
}

function tip(home: string, branch: string) {
  return git(home, ["rev-parse", `refs/heads/${branch}`]).trim()
}

function request(areaID: OwnTeam.AreaID, seq: number, text: string): OwnTeam.Dispatch {
  return {
    id: OwnTeam.DispatchID.create(),
    teamID: TEAM_ID,
    areaID,
    seq,
    from: "main",
    kind: "task",
    text,
    state: "waiting",
    // Within the 7 days sent requests are kept (the manual clock starts 2026-10-02 03:00 UTC).
    createdAt: Date.UTC(2026, 9, 2, 2, 0, 0),
  }
}

/** A fake service: sessions with metadata, messages, instruction entries and handoff requests (synthetic). */
function sessions() {
  const service = start()
  cleanups.push(() => service.stop())
  const metadata = new Map<string, Readonly<Record<string, unknown>>>()
  const entries = new Map<string, Map<string, unknown>>()
  const synthetic: Array<{ readonly sessionID: string; readonly text: string; readonly metadata: unknown }> = []
  /** What the owner does in its handoff turn (the test plays the model). */
  const turn = { run: async (_sessionID: string) => {} }
  const add = (id: string, directory: string, messages: ReadonlyArray<unknown> = []) => {
    metadata.set(id, {})
    entries.set(id, new Map())
    service.routes.set(`GET /api/session/${id}`, () =>
      Response.json({ data: session({ id, directory, metadata: metadata.get(id) ?? {} }) }),
    )
    service.routes.set(`PATCH /api/session/${id}`, (request) => {
      metadata.set(id, (request.body as { readonly metadata: Readonly<Record<string, unknown>> }).metadata)
      return new Response(null, { status: 204 })
    })
    service.routes.set(`GET /api/session/${id}/message`, () => Response.json({ data: messages, cursor: {} }))
    service.routes.set(`GET /api/session/${id}/inbox`, () => Response.json({ data: [] }))
    service.routes.set(`GET /api/experimental/session/${id}/instructions/entries`, () =>
      Response.json({ data: [...(entries.get(id) ?? [])].map(([key, value]) => ({ key, value })) }),
    )
    service.routes.set(`POST /api/session/${id}/synthetic`, async (request) => {
      const body = request.body as { readonly id: string; readonly text: string; readonly metadata: unknown }
      synthetic.push({ sessionID: id, text: body.text, metadata: body.metadata })
      await turn.run(id)
      return Response.json({
        data: { id: body.id, sessionID: id, type: "synthetic", delivery: "queue", payload: { text: body.text } },
      })
    })
  }
  /** Lets the session hold the instruction entry `key`. */
  const key = (id: string, name: string) => {
    const at = `/api/experimental/session/${id}/instructions/entries/${name}`
    service.routes.set(`PUT ${at}`, (request) => {
      entries.get(id)?.set(name, (request.body as { readonly value: unknown }).value)
      return new Response(null, { status: 204 })
    })
    service.routes.set(`DELETE ${at}`, () => {
      entries.get(id)?.delete(name)
      return new Response(null, { status: 204 })
    })
  }
  return { service, add, key, metadata, entries, synthetic, turn }
}

/** Stands in for the `retire-remove` executor (`reorg/remove.ts`): asks, removes nothing. */
const removal: Steps.Kind = {
  kind: Remove.KIND,
  observe: async () => ({ state: "pending" }),
  act: async () => ({ ok: true }),
  verify: async () => ({ ok: true }),
  prepare: async () => ({ text: "remove the folder", manifest: "fake" }),
}

async function harness(input: { readonly team: OwnTeam.Team; readonly areas: ReadonlyArray<OwnTeam.Area> }) {
  const world = new World()
  const binding = { presetID: "builtin:codex", team: { teamID: TEAM_ID, role: "owner", accounts: [], pinned: [] } }
  world.accounts.set("session.preset.get", () => ({ preset: null, binding }))
  world.accounts.set("session.preset.apply", () => ({ binding: {}, resolution: null, entry: "written", dryRun: false }))
  const fake = sessions()
  const clock = manual()
  const safe = { ok: true }
  const pushes: string[] = []
  const h = controller(world, {
    directory: input.team.home.directory,
    clock,
    source: fake.service.source,
    features: {
      safePoint: () => ({
        check: async () => (safe.ok ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }),
      }),
      teamContext: () => ({
        get: async () => null,
        push: async (teamID) => {
          pushes.push(teamID)
        },
      }),
    },
  })
  cleanups.push(() => h.close())
  AreaMerge.register(h.services)
  if (!h.services.steps.get(Remove.KIND)) h.services.steps.register(removal)
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(input.team)
    await Promise.all(input.areas.map((item) => h.services.registry.areas.put(item)))
  })
  return { ...h, world, clock, fake, safe, pushes }
}

type Harness = Awaited<ReturnType<typeof harness>>

async function planned(h: Harness, into: OwnTeam.Area, from: OwnTeam.Area) {
  const made = await AreaMerge.plan(h.services, {
    team: (await h.services.registry.teams.get(TEAM_ID))!,
    into: into.id,
    from: from.id,
  })
  if (!made.ok) throw new Error(`${made.error}: ${made.message}`)
  return made
}

async function started(
  h: Harness,
  plan: AreaMerge.Planned,
  by: OwnTeam.Op["by"] = "user",
  kind: OwnTeam.OpKind = "reorg",
) {
  const op = await h.services.runner.start({
    teamID: TEAM_ID,
    kind,
    by,
    areaID: plan.areaID,
    steps: plan.steps,
    undo: { available: kind === "reorg" },
  })
  if (!op.ok) throw new Error("busy")
  return op.op.id
}

async function finished(h: Harness, opID: string) {
  await h.services.runner.settled(opID)
  const op = await h.services.journal.get(TEAM_ID, opID)
  if (!op) throw new Error("op is gone")
  return op
}

async function run(h: Harness, plan: AreaMerge.Planned, by: OwnTeam.Op["by"] = "user") {
  return finished(h, await started(h, plan, by))
}

/** Answers the op's pending confirm. */
async function confirm(h: Harness, op: OwnTeam.Op, choice: "do" | "skip") {
  const step = op.steps.find((item) => item.state === "needs_confirm")
  if (!step?.confirm) throw new Error("no confirm")
  const answered = await h.services.runner.confirm({ opID: op.id, stepID: step.id, choice, nonce: step.confirm.nonce })
  if (!answered.ok) throw new Error(answered.message)
  return answered.op
}

async function areaOf(h: Harness, areaID: OwnTeam.AreaID) {
  const found = await h.services.registry.areas.get(TEAM_ID, areaID)
  if (!found) throw new Error(`no area ${areaID}`)
  return found
}

function markers(home: string, opID: string, from: OwnTeam.AreaID) {
  const names = Merge.refs(AreaMerge.markerID(opID, from))
  return [names.base, names.source, names.candidate].map((ref) =>
    git(home, ["for-each-ref", "--format=%(objectname)", ref]).trim(),
  )
}

/** The kinds' observe on the op's steps as they are recorded now (TI-11: after a restart, observing comes first). */
async function observed(h: Harness, op: OwnTeam.Op) {
  return Promise.all(
    op.steps.map(async (step) => {
      const kind = h.services.steps.get(step.kind)
      if (!kind) throw new Error(`unknown kind ${step.kind}`)
      const result = await kind.observe({
        services: h.services,
        op,
        step,
        confirmed: false,
        signal: new AbortController().signal,
        summary: () => {},
        cancelled: () => false,
        waiting: () => {},
      })
      return [step.kind, result.state] as const
    }),
  )
}

/** Waits (real time) until `check` holds. */
async function until(check: () => boolean, ms = 60_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

/** A merged pair `ui` + `api` → `ui` (ff), with requests waiting in both outboxes; the removal is not answered yet. */
async function merged(name: string) {
  const r = repository(name)
  const into = r.add("ui", INTO_OWNER)
  const from = r.add("api", FROM_OWNER)
  const source = save(from.directory, { "src/api.ts": "export const api = 1\n" }, "api")
  const own = request(into.id, 0, "ui의 일")
  const first = request(from.id, 0, "api 첫 요청")
  const second = request(from.id, 1, "api 둘째 요청")
  const sent: OwnTeam.Dispatch = { ...request(from.id, 2, "api 보낸 요청"), state: "sent" }
  const h = await harness({ team: r.team, areas: [into, from] })
  h.fake.add(INTO_OWNER, into.directory)
  h.fake.add(FROM_OWNER, from.directory)
  h.fake.key(INTO_OWNER, AreaMerge.entryKey(from.id))
  await h.services.write(TEAM_ID, () =>
    Promise.all([own, first, second, sent].map((item) => h.services.registry.dispatches.put(item))),
  )
  const op = await run(h, await planned(h, into, from))
  return { r, h, into, from, source, own, first, second, sent, op }
}

// ---------------------------------------------------------------------------------------------------------------

describe("영역 묶기 (06 §8.2)", () => {
  test(
    "ff: A moves to B's tip; B's handoff on A's owner; B's requests move in order; B archived and retired, its branch kept; the folder waits for a confirm",
    async () => {
      const r = repository("ff")
      const into = r.add("ui", INTO_OWNER)
      const from = r.add("api", FROM_OWNER)
      const source = save(from.directory, { "src/api.ts": "export const api = 1\n" }, "api")
      const own = request(into.id, 0, "ui의 일")
      const first = request(from.id, 0, "api 첫 요청")
      const second = request(from.id, 1, "api 둘째 요청")
      const sent: OwnTeam.Dispatch = { ...request(from.id, 2, "api 보낸 요청"), state: "sent" }
      const h = await harness({ team: r.team, areas: [into, from] })
      h.fake.add(INTO_OWNER, into.directory)
      h.fake.add(FROM_OWNER, from.directory, [ANSWER])
      h.fake.key(INTO_OWNER, AreaMerge.entryKey(from.id))
      h.fake.service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
      // B's owner writes its handoff in the turn (team_handoff).
      h.fake.turn.run = async () => {
        const written = await h.services
          .features()
          .handoff.write({ teamID: TEAM_ID, areaID: from.id, text: "# 인계: api\n## 목표\napi 정리", by: "owner" })
        if (!written.ok) throw new Error(written.message)
      }
      await h.services.write(TEAM_ID, () =>
        Promise.all([own, first, second, sent].map((item) => h.services.registry.dispatches.put(item))),
      )

      const plan = await planned(h, into, from)
      expect(plan.wip).toBe(false)
      expect(plan.steps.map((step) => [step.kind, step.mode ?? "auto"])).toEqual([
        ["merge-begin", "auto"],
        ["merge-into", "auto"],
        ["merge-handoff", "auto"],
        ["merge-attach", "auto"],
        ["outbox-migrate", "auto"],
        ["merge-archive", "auto"],
        ["merge-retire", "auto"],
        ["retire-remove", "confirm"],
      ])
      const op = await run(h, plan)

      expect(op.state).toBe("waiting")
      expect(op.steps.map((step) => step.state)).toEqual([
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
        "done",
        "needs_confirm",
      ])
      // git: A fast-forwarded in its folder, B's branch stays, the merge is recorded for the undo.
      expect(tip(r.home, "ui")).toBe(source)
      expect(head(into.directory)).toBe(source)
      expect(fs.readFileSync(path.join(into.directory, "src/api.ts"), "utf8")).toBe("export const api = 1\n")
      expect(tip(r.home, "api")).toBe(source)
      expect(markers(r.home, op.id, from.id)).toEqual([r.base, source, source])
      // B's owner had its handoff turn; its document is A's owner's entry.
      expect(h.fake.synthetic).toHaveLength(1)
      expect(h.fake.synthetic[0]?.sessionID).toBe(FROM_OWNER)
      expect(h.fake.synthetic[0]?.text).toContain("'ui' 영역에 묶습니다")
      expect(h.fake.synthetic[0]?.metadata).toMatchObject({
        source: OwnTeam.PROMPT_SOURCE,
        [OwnTeam.REQUEST_META]: { kind: "handoff", opID: op.id },
      })
      const attached = h.fake.entries.get(INTO_OWNER)?.get(AreaMerge.entryKey(from.id))
      expect(attached).toContain("# 묶은 영역의 인계: api")
      expect(attached).toContain("api 정리")
      // B leaves the team: archived, its binding's team context cleared, retired.
      expect(h.fake.metadata.get(FROM_OWNER)).toEqual({ [Undo.ARCHIVED]: true })
      expect(h.world.calls).toContainEqual({
        method: "session.preset.apply",
        input: { sessionID: FROM_OWNER, presetID: "builtin:codex", team: null },
      })
      expect(await areaOf(h, from.id)).toMatchObject({ state: "retired", status: { kind: "retired" } })
      expect((await areaOf(h, into.id)).state).toBe("active")
      // The outbox: A's own request first, then B's in their order, marked; the sent one stays with B.
      const waiting = await h.services.registry.dispatches.waiting(TEAM_ID, into.id)
      expect(waiting.map((item) => [item.id, item.seq, item.movedFrom])).toEqual([
        [own.id, 0, undefined],
        [first.id, 1, from.id],
        [second.id, 2, from.id],
      ])
      expect(await h.services.registry.dispatches.waiting(TEAM_ID, from.id)).toEqual([])
      expect((await h.services.registry.dispatches.list(TEAM_ID, from.id)).map((item) => item.id)).toEqual([sent.id])
      // The card and the folder removal.
      expect(op.summary?.lines).toContainEqual({ kind: "area", areaID: into.id, change: "merged", from: from.id })
      expect(op.steps.at(-1)).toMatchObject({ kind: "retire-remove", mode: "confirm", args: { areaID: from.id } })
    },
    SLOW,
  )

  test(
    "true merge: K = commit-tree of merge-tree, parents A_old and C, dated at the op; A's local work stays with a hold ref; completed steps observe as done",
    async () => {
      const r = repository("true")
      const into = r.add("ui", INTO_OWNER)
      const from = r.add("api", FROM_OWNER)
      const old = save(into.directory, { "docs/ui.md": "ui\n" }, "ui work")
      const source = save(from.directory, { "src/api.ts": "export const api = 1\n" }, "api work")
      write(into.directory, { "notes.txt": "local notes\n" })
      const h = await harness({ team: r.team, areas: [into, from] })
      h.fake.add(INTO_OWNER, into.directory)
      h.fake.add(FROM_OWNER, from.directory)
      h.fake.key(INTO_OWNER, AreaMerge.entryKey(from.id))

      const op = await run(h, await planned(h, into, from))

      expect(op.state).toBe("waiting")
      const k = head(into.directory)
      expect(tip(r.home, "ui")).toBe(k)
      expect(git(r.home, ["rev-list", "--parents", "-n", "1", k]).trim().split(" ")).toEqual([k, old, source])
      expect(git(r.home, ["log", "-1", "--format=%ct|%s", k]).trim()).toBe(
        `${Math.floor(op.createdAt / 1000)}|팀: 'api' 영역을 'ui'에 묶기 (${op.id})`,
      )
      expect(markers(r.home, op.id, from.id)).toEqual([old, source, k])
      // TI-1: A's uncommitted work was copied before A moved, and it is still there.
      expect(fs.readFileSync(path.join(into.directory, "notes.txt"), "utf8")).toBe("local notes\n")
      const hold = `refs/own/hold/${into.id}/${op.id}`
      expect(git(r.home, ["show", `${hold}:notes.txt`])).toBe("local notes\n")
      expect(op.summary?.lines).toContainEqual(expect.objectContaining({ kind: "ref", ref: hold }))
      // B's owner had no conversation yet: a program handoff, no turn.
      expect(h.fake.synthetic).toEqual([])
      expect(h.fake.entries.get(INTO_OWNER)?.get(AreaMerge.entryKey(from.id))).toContain("프로그램이 만든 인계 문서")
      // Re-running a completed step does nothing: each observes as satisfied (the confirm is still asked).
      expect(await observed(h, op)).toEqual([
        ["merge-begin", "satisfied"],
        ["merge-into", "satisfied"],
        ["merge-handoff", "satisfied"],
        ["merge-attach", "satisfied"],
        ["outbox-migrate", "satisfied"],
        ["merge-archive", "satisfied"],
        ["merge-retire", "satisfied"],
        ["retire-remove", "pending"],
      ])
    },
    SLOW,
  )

  test(
    "a conflict stops the merge and queues a from=team conflict request to A; nothing else changes",
    async () => {
      const r = repository("conflict")
      const into = r.add("ui", INTO_OWNER)
      const from = r.add("api", FROM_OWNER)
      const old = save(into.directory, { "README.md": "# ui version\n" }, "ui readme")
      save(from.directory, { "README.md": "# api version\n" }, "api readme")
      const h = await harness({ team: r.team, areas: [into, from] })
      h.fake.add(INTO_OWNER, into.directory)
      h.fake.add(FROM_OWNER, from.directory)

      const op = await run(h, await planned(h, into, from))

      expect(op.state).toBe("failed")
      expect(op.steps[1]).toMatchObject({ kind: "merge-into", state: "failed" })
      expect(op.steps[1]?.note).toContain("겹친 변경 1개가 있어 담당에게 정리를 부탁했어요: README.md")
      expect(op.steps.slice(2).every((step) => step.state === "pending")).toBe(true)
      expect(tip(r.home, "ui")).toBe(old)
      expect(git(r.home, ["for-each-ref", "refs/own"]).trim()).toBe("")
      const asked = await h.services.registry.dispatches.waiting(TEAM_ID, into.id)
      // Its origin is the op's start: A held by direct work since then would not let it in (`Direct.pass`).
      expect(asked).toEqual([expect.objectContaining({ from: "team", kind: "conflict", origin: op.createdAt })])
      expect(asked[0]?.text).toContain("README.md")
      expect((await areaOf(h, from.id)).state).toBe("active")
      expect(h.fake.metadata.get(FROM_OWNER)).toEqual({})
    },
    SLOW,
  )

  test(
    "B dirty with an owner: '변경을 커밋해 주세요' is a turn of B's owner and the merge waits for it (8.7); committed, it goes through",
    async () => {
      const r = repository("asked")
      const into = r.add("ui", INTO_OWNER)
      const from = r.add("api", FROM_OWNER)
      write(from.directory, { "src/half.ts": "half done\n" })
      const h = await harness({ team: r.team, areas: [into, from] })
      h.fake.add(INTO_OWNER, into.directory)
      h.fake.add(FROM_OWNER, from.directory)
      h.fake.key(INTO_OWNER, AreaMerge.entryKey(from.id))
      h.fake.service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
      // B's owner commits in its turn (the test plays the model).
      const committed: string[] = []
      h.fake.turn.run = async () => {
        committed.push(commit(from.directory, "half done"))
      }

      const op = await run(h, await planned(h, into, from))

      expect(op.state).toBe("waiting")
      expect(op.steps[0]).toMatchObject({ kind: "merge-begin", state: "done" })
      expect(h.fake.synthetic.map((item) => item.sessionID)).toEqual([FROM_OWNER])
      expect(h.fake.synthetic[0]?.text).toContain("변경을 커밋해 주세요")
      expect(h.fake.synthetic[0]?.text).toContain("src/half.ts")
      expect(h.fake.synthetic[0]?.metadata).toMatchObject({
        source: OwnTeam.PROMPT_SOURCE,
        [OwnTeam.REQUEST_META]: { kind: "commit", opID: op.id },
      })
      // It waited on the card, and no outbox request was left behind.
      expect(
        h.published.some(
          (event) =>
            event.name === "op.progress" &&
            event.data.opID === op.id &&
            event.data.state === "pending" &&
            event.data.text.includes("저장 지점에 넣는 중이에요") &&
            event.data.wait?.why === "turn",
        ),
      ).toBe(true)
      expect(await h.services.registry.dispatches.waiting(TEAM_ID, from.id)).toEqual([])
      expect(tip(r.home, "ui")).toBe(committed[0])

      // A turn that ends without the commit stops the merge with the reason; nothing moved.
      const r2 = repository("declined")
      const into2 = r2.add("ui", INTO_OWNER)
      const from2 = r2.add("api", FROM_OWNER)
      write(from2.directory, { "src/half.ts": "not mine\n" })
      const h2 = await harness({ team: r2.team, areas: [into2, from2] })
      h2.fake.add(INTO_OWNER, into2.directory)
      h2.fake.add(FROM_OWNER, from2.directory)
      h2.fake.service.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
      const stopped = await run(h2, await planned(h2, into2, from2))
      expect(stopped.state).toBe("failed")
      expect(stopped.steps[0]?.note).toContain("저장 지점에 넣지 않았어요")
      expect(tip(r2.home, "ui")).toBe(r2.base)
      expect(git(r2.home, ["for-each-ref", "refs/own"]).trim()).toBe("")
    },
    SLOW,
  )

  test(
    "B dirty with an owner that cannot take a turn now (out of its limit): the request waits in B's outbox, the merge stops",
    async () => {
      const r = repository("dirty")
      const into = r.add("ui", INTO_OWNER)
      const from = r.add("api", FROM_OWNER)
      write(from.directory, { "src/half.ts": "half done\n" })
      const h = await harness({ team: r.team, areas: [into, from] })
      h.fake.add(INTO_OWNER, into.directory)
      h.fake.add(FROM_OWNER, from.directory)
      h.fake.key(INTO_OWNER, AreaMerge.entryKey(from.id))
      h.world.accounts.set("switch.state", () => ({
        state: "BLOCKED",
        reason: "all_exhausted",
        nextResetAt: Date.UTC(2026, 9, 3),
      }))

      const op = await run(h, await planned(h, into, from))

      expect(op.state).toBe("failed")
      expect(op.steps[0]).toMatchObject({ kind: "merge-begin", state: "failed" })
      expect(op.steps[0]?.note).toContain("저장 지점에 넣어 달라고 했어요")
      const asked = await h.services.registry.dispatches.waiting(TEAM_ID, from.id)
      expect(asked).toEqual([expect.objectContaining({ from: "team", kind: "task", task: AreaMerge.COMMIT_TASK })])
      expect(asked[0]?.text).toContain("변경을 커밋해 주세요")
      expect(asked[0]?.text).toContain("src/half.ts")
      expect(tip(r.home, "ui")).toBe(r.base)
      expect(git(r.home, ["for-each-ref", "refs/own"]).trim()).toBe("")

      // The owner commits; the merge applied again goes through.
      const source = commit(from.directory, "half done")
      h.world.accounts.delete("switch.state")
      const again = await run(h, await planned(h, into, from))
      expect(again.state).toBe("waiting")
      expect(tip(r.home, "ui")).toBe(source)
      // The request about B's folder is cancelled with the merge, never moved to A.
      expect(await h.services.registry.dispatches.waiting(TEAM_ID, into.id)).toEqual([])
      expect(again.summary?.lines).toContainEqual({ kind: "cancelled", areaID: from.id, dispatchID: asked[0]?.id })
    },
    SLOW,
  )

  test(
    "an adopted B without a conversation: only a WIP confirm, and the WIP commit is made only after it",
    async () => {
      const r = repository("wip")
      const into = r.add("ui", INTO_OWNER)
      const from: OwnTeam.Area = { ...r.add("api", null), origin: "adopted" }
      const source = save(from.directory, { "src/api.ts": "export const api = 1\n" }, "api")
      write(from.directory, { "src/api.ts": "export const api = 2\n", "src/new.ts": "new\n" })
      const h = await harness({ team: r.team, areas: [into, from] })
      h.fake.add(INTO_OWNER, into.directory)

      const plan = await planned(h, into, from)
      expect(plan).toMatchObject({
        wip: true,
        areaID: from.id,
        steps: [{ kind: "wip-commit", mode: "confirm", args: { into: into.id, from: from.id } }],
      })
      const asked = await run(h, plan)
      expect(asked.state).toBe("waiting")
      expect(asked.steps[0]?.confirm?.text).toContain("아직 저장 지점에 넣지 않은 변경 2개")
      // Nothing before the confirm.
      expect(tip(r.home, "api")).toBe(source)
      expect(git(r.home, ["for-each-ref", "refs/own"]).trim()).toBe("")

      const done = await confirm(h, asked, "do")
      expect(done.state).toBe("done")
      const wip = tip(r.home, "api")
      expect(git(r.home, ["rev-parse", `${wip}^`]).trim()).toBe(source)
      expect(git(r.home, ["show", `${wip}:src/new.ts`])).toBe("new\n")
      expect(git(from.directory, ["status", "--porcelain"])).toBe("")
      expect(fs.readFileSync(path.join(from.directory, "src/api.ts"), "utf8")).toBe("export const api = 2\n")
      expect(git(r.home, ["rev-parse", `refs/own/hold/${from.id}/${asked.id}^{tree}`]).trim()).toBe(
        git(r.home, ["rev-parse", `${wip}^{tree}`]).trim(),
      )
      // B is clean now: the merge itself is planned.
      expect((await planned(h, into, from)).wip).toBe(false)

      // The WIP commit op shows 되돌리기 (a done wip-commit reverses), and its undo is the CAS back to W's parent.
      expect(done.undo?.available).toBe(true)
      const back = AreaMerge.wipUndo(done)
      expect(back).toEqual([{ kind: AreaMerge.KIND.wipUndo, args: { areaID: from.id, origin: asked.id } }])
      const undone = await h.services.runner.start({ teamID: TEAM_ID, kind: "undo", by: "user", steps: back })
      if (!undone.ok) throw new Error("busy")
      expect((await finished(h, undone.op.id)).state).toBe("done")
      expect(tip(r.home, "api")).toBe(source)
      expect(fs.readFileSync(path.join(from.directory, "src/api.ts"), "utf8")).toBe("export const api = 2\n")
      expect(git(from.directory, ["status", "--porcelain"])).toContain("src/new.ts")
      // Run again, it changes nothing: the branch is back on W's parent.
      const again = await h.services.runner.start({ teamID: TEAM_ID, kind: "undo", by: "user", steps: back })
      if (!again.ok) throw new Error("busy")
      expect((await finished(h, again.op.id)).state).toBe("done")
      expect(tip(r.home, "api")).toBe(source)
    },
    SLOW,
  )

  test(
    "B without a branch yet (deferredName) merges from its HEAD: its commits are kept first (TI-8), no branch is made",
    async () => {
      const r = repository("detached")
      const into = r.add("ui", INTO_OWNER)
      const from: OwnTeam.Area = {
        ...r.add("api", FROM_OWNER, { detach: true }),
        origin: "adopted",
        deferredName: true,
      }
      const source = save(from.directory, { "src/api.ts": "export const api = 1\n" }, "detached work")
      const h = await harness({ team: r.team, areas: [into, from] })
      h.fake.add(INTO_OWNER, into.directory)
      h.fake.add(FROM_OWNER, from.directory)
      h.fake.key(INTO_OWNER, AreaMerge.entryKey(from.id))

      const op = await run(h, await planned(h, into, from))

      expect(op.state).toBe("waiting")
      expect(tip(r.home, "ui")).toBe(source)
      expect(git(r.home, ["rev-parse", `refs/own/keep/${source}`]).trim()).toBe(source)
      expect(git(r.home, ["for-each-ref", "refs/heads/api"]).trim()).toBe("")
      expect(op.summary?.lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${source}`, sha: source })
    },
    SLOW,
  )

  test(
    "planning: a code-only A gets the cone drift and link-fix steps; refusals before anything runs",
    async () => {
      const r = repository("plan")
      const into: OwnTeam.Area = { ...r.add("ui", INTO_OWNER), shape: "code" }
      const from = r.add("api", FROM_OWNER)
      const linked: OwnTeam.Team = { ...r.team, env: { ...r.team.env, symlinkFix: "skip-worktree" } }
      const h = await harness({ team: linked, areas: [into, from] })

      const plan = await planned(h, into, from)
      expect(plan.steps.slice(0, 4).map((step) => [step.kind, step.args])).toEqual([
        ["merge-begin", { into: into.id, from: from.id }],
        ["merge-into", { into: into.id, from: from.id }],
        ["drift", { areaID: into.id }],
        ["link-fix", { areaID: into.id }],
      ])
      const refuse = (input: { readonly into: OwnTeam.AreaID; readonly from: OwnTeam.AreaID }) =>
        AreaMerge.plan(h.services, { team: linked, ...input })
      expect(await refuse({ into: into.id, from: into.id })).toMatchObject({ ok: false, error: "invalid_proposal" })
      expect(await refuse({ into: into.id, from: OwnTeam.AreaID.make("ar_nowhere") })).toMatchObject({
        ok: false,
        error: "not_found",
      })
      // A changed link copy in an adopted folder without a conversation: no WIP commit can take it.
      const adopted: OwnTeam.Area = {
        ...from,
        origin: "adopted",
        owner: { sessionID: null, previous: [], attached: false },
        linkCopies: { "docs/guide.md": "0".repeat(40) },
      }
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put(adopted))
      expect(await refuse({ into: into.id, from: from.id })).toMatchObject({
        ok: false,
        error: "dirty",
        data: { count: 1, paths: ["docs/guide.md"] },
      })
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...into, deferredName: true }))
      expect(await refuse({ into: into.id, from: from.id })).toMatchObject({ ok: false, error: "invalid_proposal" })
    },
    SLOW,
  )

  test(
    "Main 멈춤 on A: a merge of the main stops at its start (TI-13) and nothing moves",
    async () => {
      const r = repository("paused")
      const into: OwnTeam.Area = { ...r.add("ui", INTO_OWNER), paused: "user" }
      const from = r.add("api", FROM_OWNER)
      save(from.directory, { "src/api.ts": "export const api = 1\n" }, "api")
      const h = await harness({ team: r.team, areas: [into, from] })

      const op = await run(h, await planned(h, into, from), "main")

      expect(op.state).toBe("failed")
      expect(op.steps[0]?.note).toContain("메인 멈춤")
      expect(tip(r.home, "ui")).toBe(r.base)
      expect((await areaOf(h, from.id)).state).toBe("active")
    },
    SLOW,
  )

  test(
    "an adopted B the team is not attached to: a program handoff only, no turn on its account; only the archive mark",
    async () => {
      const r = repository("unattached")
      const into = r.add("ui", INTO_OWNER)
      const from: OwnTeam.Area = {
        ...r.add("api", FROM_OWNER),
        origin: "adopted",
        owner: { sessionID: FROM_OWNER, previous: [], attached: false },
      }
      save(from.directory, { "src/api.ts": "export const api = 1\n" }, "api")
      const h = await harness({ team: r.team, areas: [into, from] })
      h.world.accounts.set("session.preset.get", () => ({ preset: null, binding: { presetID: "builtin:codex" } }))
      h.fake.add(INTO_OWNER, into.directory)
      h.fake.add(FROM_OWNER, from.directory, [ANSWER])
      h.fake.key(INTO_OWNER, AreaMerge.entryKey(from.id))

      const op = await run(h, await planned(h, into, from))

      expect(op.state).toBe("waiting")
      expect(h.fake.synthetic).toEqual([])
      const attached = h.fake.entries.get(INTO_OWNER)?.get(AreaMerge.entryKey(from.id))
      expect(attached).toContain("사용자가 팀 밖에서 쓰던 대화를 받아들여")
      expect(attached).toContain("api 작업을 마쳤습니다")
      expect(h.fake.metadata.get(FROM_OWNER)).toEqual({ [Undo.ARCHIVED]: true })
      expect(h.world.calls.some((call) => call.method === "session.preset.apply")).toBe(false)
    },
    SLOW,
  )
})

describe("영역 묶기 되돌리기 (06 §8.2, §7.4)", () => {
  test(
    "A still at K: reset --keep A_old at its safe point, a commit made meanwhile kept; B registered again; the moved requests back to B",
    async () => {
      const s = await merged("undo")
      const done = await confirm(s.h, s.op, "skip")
      expect(done.state).toBe("done")

      const undone = await AreaMerge.undo(s.h.services, done)
      if (!undone.ok) throw new Error(undone.message)
      expect(undone.steps.map((step) => step.kind)).toEqual(["merge-undo", "merge-undo-area", "outbox-migrate"])
      s.h.safe.ok = false
      const opID = await started(s.h, { areaID: s.into.id, steps: undone.steps, wip: false }, "user", "undo")
      await until(() => s.h.clock.pending() > 0)
      // The user commits on A while the undo waits for A's safe point.
      const late = save(s.into.directory, { "docs/late.md": "late\n" }, "late")
      expect(tip(s.r.home, "ui")).toBe(late)
      s.h.safe.ok = true
      s.h.clock.advance(AreaSplit.RECHECK_MS)
      const op = await finished(s.h, opID)

      expect(op.state).toBe("done")
      expect(tip(s.r.home, "ui")).toBe(s.r.base)
      expect(head(s.into.directory)).toBe(s.r.base)
      expect(fs.existsSync(path.join(s.into.directory, "src/api.ts"))).toBe(false)
      expect(git(s.r.home, ["rev-parse", `refs/own/keep/${late}`]).trim()).toBe(late)
      expect(op.summary?.lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${late}`, sha: late })
      expect(s.h.published.some((event) => event.name === "notice" && event.data.kind === "undo.kept")).toBe(true)
      // B is back: active, its owner not archived, the team context pushed again; its branch never moved.
      expect((await areaOf(s.h, s.from.id)).state).toBe("active")
      expect(s.h.fake.metadata.get(FROM_OWNER)).toEqual({})
      expect(s.h.pushes).toContain(TEAM_ID)
      expect(tip(s.r.home, "api")).toBe(s.source)
      // The moved requests go back to B in their order, without the mark; A keeps its own.
      expect((await s.h.services.registry.dispatches.waiting(TEAM_ID, s.into.id)).map((item) => item.id)).toEqual([
        s.own.id,
      ])
      const back = await s.h.services.registry.dispatches.waiting(TEAM_ID, s.from.id)
      expect(back.map((item) => [item.id, item.movedFrom])).toEqual([
        [s.first.id, undefined],
        [s.second.id, undefined],
      ])
      // B's document left A's owner, and the markers are gone.
      expect(s.h.fake.entries.get(INTO_OWNER)?.has(AreaMerge.entryKey(s.from.id))).toBe(false)
      expect(markers(s.r.home, s.op.id, s.from.id)).toEqual(["", "", ""])
    },
    SLOW,
  )

  test(
    "A moved on after the merge: no undo, only 'B 다시 만들기' is left, and nothing changes",
    async () => {
      const s = await merged("moved")
      const done = await confirm(s.h, s.op, "skip")
      const later = save(s.into.directory, { "docs/later.md": "later\n" }, "later")

      const undone = await AreaMerge.undo(s.h.services, done)

      expect(undone).toMatchObject({
        ok: false,
        error: "conflict",
        data: { ref: "refs/heads/ui", expected: s.source, actual: later },
      })
      if (undone.ok) return
      expect(undone.message).toContain("B 다시 만들기")
      expect(tip(s.r.home, "ui")).toBe(later)
      expect((await areaOf(s.h, s.from.id)).state).toBe("retired")
      expect(markers(s.r.home, s.op.id, s.from.id)).toEqual([s.r.base, s.source, s.source])
    },
    SLOW,
  )
})
