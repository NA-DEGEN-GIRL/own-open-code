// 나누기 A → A, A2 (06 §8.2, §6.2, §10.1, TG12 split items) on git fixtures: A2's branch create-only at A's tip, its
// code-only worktree locked through AreaCreate's steps, its owner seeded from A's handoff (the owner's own document
// after a warm turn, else a program handoff) with A's area main and preset, A unchanged, TI-13 for a split of the main,
// and the undo target (A2 is retired). Temp repositories, a fake loopback service and fake own.accounts answers only.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Identity } from "../../src/git/identity.js"
import { Porcelain } from "../../src/git/porcelain.js"
import type { Steps } from "../../src/ops/steps.js"
import { AreaSplit } from "../../src/reorg/split.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { commit, files, git, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, MODEL, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { removeTree } from "../support/remove.js"
import { session, start } from "../support/service.js"

const box = temp("own-team-split-")
// Removing many fixture repositories takes a while on Windows, and a git process that just ended may still hold one.
afterAll(() => removeTree(box.root, 20, 250), 120_000)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Git-heavy tests: Windows process starts are slow on a busy machine. */
const SLOW = 240_000

const OWNER = SessionID.make("ses_split000000000000000000001")
const STAR = Preset.ID.create()
/** A's own area main and preset (not the team's), so A2's copy of them shows. */
const AREA_MODEL = Schema.decodeUnknownSync(Model.Ref)({ id: "gpt-area", providerID: "openai", variant: "high" })
const AREA_PRESET = Preset.ID.create()

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

/** A home with code and an `assets/` heavy folder, and A (`ui`, plain) with a commit of its own. */
function repository(name: string) {
  const home = init(path.join(box.root, name, "home"))
  write(home, {
    "README.md": "# split\n",
    "src/app.ts": "export const app = 1\n",
    "docs/guide.md": "guide\n",
    "assets/textures/a.bin": "a".repeat(64),
  })
  const base = commit(home, "base")
  const record: OwnTeam.Team = { ...team({ home }), heavy: { dirs: ["assets"], measuredAt: null, forcedBytes: 0 } }
  const directory = path.join(record.worktreeRoot, "ui")
  git(home, ["worktree", "add", "-q", "-b", "ui", directory, base])
  write(directory, { "src/ui.ts": "export const ui = 1\n" })
  const tip = commit(directory, "ui work")
  const gitDir = git(directory, ["rev-parse", "--absolute-git-dir"]).trim()
  const source: OwnTeam.Area = {
    ...area({ slug: "ui", directory }),
    name: "화면",
    gitDir,
    branch: "ui",
    base: { sha: base, at: 0 },
    owner: { sessionID: OWNER, previous: [], attached: true },
    main: { model: AREA_MODEL, chosenBy: "user" },
    preset: AREA_PRESET,
  }
  return { home, base, tip, team: record, source }
}

/** A fake service: session create (an existing id is adopted), sessions, entries, messages, handoff requests. */
function service() {
  const fake = start()
  cleanups.push(() => fake.stop())
  const known = new Set<string>()
  const synthetic: Array<{ readonly sessionID: string; readonly text: string }> = []
  const turn = { run: async (_sessionID: string) => {} }
  const add = (input: Parameters<typeof session>[0], messages: ReadonlyArray<unknown> = []) => {
    const view = session(input)
    known.add(input.id)
    fake.routes.set(`GET /api/session/${input.id}`, () => Response.json({ data: view }))
    fake.routes.set(`GET /api/session/${input.id}/message`, () => Response.json({ data: messages, cursor: {} }))
    fake.routes.set(`GET /api/session/${input.id}/inbox`, () => Response.json({ data: [] }))
    fake.routes.set(`GET /api/experimental/session/${input.id}/instructions/entries`, () => Response.json({ data: [] }))
    for (const key of [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF])
      fake.routes.set(
        `PUT /api/experimental/session/${input.id}/instructions/entries/${key}`,
        () => new Response(null, { status: 204 }),
      )
    fake.routes.set(`POST /api/session/${input.id}/synthetic`, async (request) => {
      const body = request.body as { readonly id: string; readonly text: string }
      synthetic.push({ sessionID: input.id, text: body.text })
      await turn.run(input.id)
      return Response.json({
        data: { id: body.id, sessionID: input.id, type: "synthetic", delivery: "queue", payload: { text: body.text } },
      })
    })
    return view
  }
  fake.routes.set("POST /api/session", (request) => {
    const body = request.body as {
      readonly id: string
      readonly location: { readonly directory: string }
      readonly model?: Model.Ref
    }
    if (known.has(body.id)) return fake.routes.get(`GET /api/session/${body.id}`)!(request)
    return Response.json({
      data: add({ id: body.id, directory: body.location.directory, model: body.model ?? MODEL }),
    })
  })
  fake.routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
  fake.routes.set("GET /api/session/active", () => Response.json({ data: {} }))
  return { fake, add, synthetic, turn }
}

async function harness(input: { readonly team: OwnTeam.Team; readonly areas: ReadonlyArray<OwnTeam.Area> }) {
  const world = new World()
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [{ group: "codex", defaultModel: null, star: STAR }] }))
  world.accounts.set("session.approval.set", (call) => ({ mode: (call as { mode: string }).mode, patched: [] }))
  world.accounts.set("session.preset.apply", () => ({ binding: {}, resolution: null, entry: "written", dryRun: false }))
  const fake = service()
  fake.add({ id: MAIN_SESSION, directory: input.team.home.directory, model: MODEL })
  const clock = manual()
  const safe = { ok: true }
  const h = controller(world, {
    directory: input.team.home.directory,
    clock,
    source: fake.fake.source,
    features: {
      safePoint: () => ({
        check: async () => (safe.ok ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }),
      }),
    },
  })
  cleanups.push(() => h.close())
  AreaSplit.register(h.services)
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(input.team)
    await Promise.all(input.areas.map((item) => h.services.registry.areas.put(item)))
  })
  return { ...h, world, clock, fake, safe }
}

type Harness = Awaited<ReturnType<typeof harness>>

async function planned(h: Harness, team: OwnTeam.Team, by: OwnTeam.Op["by"] = "user") {
  const made = await AreaSplit.plan(h.services, {
    team,
    areaID: OwnTeam.AreaID.make("ar_ui"),
    slug: "ui-review",
    name: "화면 검토",
    goal: "리뷰 반영",
    by,
  })
  if (!made.ok) throw new Error(`${made.error}: ${made.message}`)
  return made
}

async function run(
  h: Harness,
  plan: { readonly areaID: OwnTeam.AreaID; readonly steps: ReadonlyArray<Steps.Spec> },
  by: OwnTeam.Op["by"] = "user",
) {
  const started = await h.services.runner.start({
    teamID: TEAM_ID,
    kind: "reorg",
    by,
    areaID: plan.areaID,
    steps: plan.steps,
    undo: { available: true },
  })
  if (!started.ok) throw new Error("busy")
  await h.services.runner.settled(started.op.id)
  const op = await h.services.journal.get(TEAM_ID, started.op.id)
  if (!op) throw new Error("op is gone")
  return op
}

async function areaOf(h: Harness, areaID: string) {
  const found = await h.services.registry.areas.get(TEAM_ID, areaID)
  if (!found) throw new Error(`no area ${areaID}`)
  return found
}

function lockOf(home: string, directory: string) {
  return Porcelain.worktrees(git(home, ["worktree", "list", "--porcelain", "-z"])).find((item) =>
    Identity.same(item.path, directory),
  )?.locked
}

/** The text own put into the new owner's `own.team.handoff` entry. */
function handoffOf(h: Harness, sessionID: string) {
  const put = h.fake.fake.requests.find(
    (request) =>
      request.method === "PUT" &&
      request.path === `/api/experimental/session/${sessionID}/instructions/entries/${RoleInstructions.HANDOFF}`,
  )
  return (put?.body as { readonly value?: unknown } | undefined)?.value
}

// ---------------------------------------------------------------------------------------------------------------

describe("나누기 (06 §8.2)", () => {
  test(
    "A2 at A's tip, code-only and locked through AreaCreate's steps; its owner starts from A's handoff with A's area main and preset; A unchanged",
    async () => {
      const r = repository("program")
      const h = await harness({ team: r.team, areas: [r.source] })
      // A's owner runs Pi 방식: A2's owner starts on it too (2026-10-26).
      h.fake.add({
        id: OWNER,
        directory: r.source.directory,
        model: AREA_MODEL,
        metadata: { "own.harness": { id: "pi", v: 1 } },
      })
      const before = await areaOf(h, r.source.id)

      const plan = await planned(h, r.team)
      expect(plan.areaID).toBe(OwnTeam.AreaID.make("ar_ui-review"))
      expect(plan.steps.map((step) => step.kind)).toEqual([
        "split-begin",
        "split-handoff",
        "branch-create",
        "worktree-create",
        "area-record",
        "session-create",
      ])
      const op = await run(h, plan)

      expect(op.state).toBe("done")
      expect(op.steps.map((step) => step.state)).toEqual(["done", "skipped", "done", "done", "done", "done"])
      // A2's branch is new, at A's tip; its folder is code-only (no heavy folder) and own-locked.
      expect(git(r.home, ["rev-parse", "refs/heads/ui-review"]).trim()).toBe(r.tip)
      const made = await areaOf(h, plan.areaID)
      expect(made).toMatchObject({
        name: "화면 검토",
        goal: "리뷰 반영",
        shape: "code",
        branch: "ui-review",
        base: { sha: r.tip },
        main: { model: AREA_MODEL, chosenBy: "user" },
        preset: AREA_PRESET,
      })
      expect(lockOf(r.home, made.directory)).toBe("own.team area:ar_ui-review")
      expect(files(made.directory)).toEqual(["README.md", "docs/guide.md", "src/app.ts", "src/ui.ts"])
      // Its owner: on A's area main, bound to A's preset, starting from a program handoff of A.
      const owner = made.owner.sessionID
      if (owner === null) throw new Error("no owner")
      const created = h.fake.fake.requests.find(
        (request) =>
          request.method === "POST" && request.path === "/api/session" && (request.body as { id: string }).id === owner,
      )
      expect(created?.body).toMatchObject({
        title: "화면 검토 · 담당",
        model: AREA_MODEL,
        metadata: { "own.harness": { id: "pi", v: 1 } },
      })
      expect(h.world.calls).toContainEqual({
        method: "session.preset.apply",
        input: expect.objectContaining({ sessionID: owner, presetID: AREA_PRESET }),
      })
      const handoff = handoffOf(h, owner)
      expect(handoff).toContain("# 나눈 영역의 시작: 화면 검토")
      expect(handoff).toContain("'화면' 영역에서 나눈 새 영역")
      expect(handoff).toContain("프로그램이 만든 인계 문서")
      expect(h.fake.synthetic).toEqual([])
      // A is as it was: record, branch and folder.
      expect(await areaOf(h, r.source.id)).toEqual(before)
      expect(git(r.home, ["rev-parse", "refs/heads/ui"]).trim()).toBe(r.tip)
      expect(git(r.source.directory, ["rev-parse", "HEAD"]).trim()).toBe(r.tip)
      // The card, the main's next team update, and the undo target (A2 is retired).
      expect(op.summary?.lines).toContainEqual({
        kind: "area",
        areaID: plan.areaID,
        change: "split",
        from: r.source.id,
      })
      expect(AreaSplit.undone(op)).toEqual([{ areaID: plan.areaID, from: r.source.id }])
      // Re-running a completed split step does nothing: each observes as satisfied.
      const states = await Promise.all(
        op.steps
          .filter((step) => step.kind.startsWith("split-") || step.kind === "session-create")
          .map(async (step) => {
            const kind = h.services.steps.get(step.kind)!
            const observed = await kind.observe({
              services: h.services,
              op,
              step,
              confirmed: false,
              signal: new AbortController().signal,
              summary: () => {},
              cancelled: () => false,
              waiting: () => {},
            })
            return observed.state
          }),
      )
      expect(states).toEqual(["satisfied", "satisfied", "satisfied"])
    },
    SLOW,
  )

  test(
    "warm: A's owner writes its handoff in a turn (team_handoff), and A2's owner starts from that document",
    async () => {
      const r = repository("warm")
      const h = await harness({ team: r.team, areas: [r.source] })
      h.fake.add({ id: OWNER, directory: r.source.directory, model: AREA_MODEL }, [
        { type: "assistant", content: [{ type: "text", text: "화면 작업 중" }] },
      ])
      h.fake.turn.run = async () => {
        const written = await h.services.features().handoff.write({
          teamID: TEAM_ID,
          areaID: r.source.id,
          text: "# 인계: 화면\n## 남은 것\n버튼 정렬",
          by: "owner",
        })
        if (!written.ok) throw new Error(written.message)
      }

      const op = await run(h, await planned(h, r.team))

      expect(op.state).toBe("done")
      expect(op.steps[1]).toMatchObject({ kind: "split-handoff", state: "done" })
      expect(h.fake.synthetic).toHaveLength(1)
      expect(h.fake.synthetic[0]?.text).toContain("'화면 검토' 영역을 새로 나눕니다")
      const made = await areaOf(h, "ar_ui-review")
      const handoff = handoffOf(h, made.owner.sessionID!)
      expect(handoff).toContain("버튼 정렬")
      expect(handoff).not.toContain("프로그램이 만든 인계 문서")
    },
    SLOW,
  )

  test(
    "Main 멈춤 on A: a split of the main stops at its start (TI-13) and nothing is made",
    async () => {
      const r = repository("paused")
      const paused: OwnTeam.Area = { ...r.source, paused: "user" }
      const h = await harness({ team: r.team, areas: [paused] })

      const op = await run(h, await planned(h, r.team, "main"), "main")

      expect(op.state).toBe("failed")
      expect(op.steps[0]?.note).toContain("메인 멈춤")
      expect(git(r.home, ["for-each-ref", "refs/heads/ui-review"]).trim()).toBe("")
      expect(await h.services.registry.areas.get(TEAM_ID, "ar_ui-review")).toBeUndefined()
    },
    SLOW,
  )

  test(
    "refused: an area without a branch yet, a broken area, an unknown one",
    async () => {
      const r = repository("refused")
      const deferred: OwnTeam.Area = { ...r.source, deferredName: true }
      const h = await harness({ team: r.team, areas: [deferred] })
      expect(
        await AreaSplit.plan(h.services, { team: r.team, areaID: deferred.id, slug: "x", name: "x", by: "user" }),
      ).toMatchObject({ ok: false, error: "invalid_proposal" })
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...r.source, state: "broken", broken: { why: "missing", at: 1 } }),
      )
      expect(
        await AreaSplit.plan(h.services, { team: r.team, areaID: r.source.id, slug: "x", name: "x", by: "user" }),
      ).toMatchObject({ ok: false, error: "broken", data: { why: "missing" } })
      expect(
        await AreaSplit.plan(h.services, {
          team: r.team,
          areaID: OwnTeam.AreaID.make("ar_nowhere"),
          slug: "x",
          name: "x",
          by: "user",
        }),
      ).toMatchObject({ ok: false, error: "not_found" })
    },
    SLOW,
  )
})
