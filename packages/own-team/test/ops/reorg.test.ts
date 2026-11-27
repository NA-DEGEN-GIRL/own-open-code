// Reorganization (06 §8.1–8.2, §3.5, §2.7 `reorg.apply`, §2.8 `team_reorganize`): a proposal is one `reorg` op (by
// `user` for a proposal, `auto` for a stored judge proposal, `main` for the tool) planned by `reorg/plan.ts`; new areas
// and renames run here (the other actions in test/reorg/plan.test.ts); V4/V5/V6/V11/V12; errors team_off, not_found,
// busy, invalid_proposal, path_forbidden; `team_reorganize` answers {applied, pending, skipped, rejected} and never
// throws. Git fixtures in temp folders, a fake loopback service, fake own.accounts answers.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { OwnTeam, Preset } from "@own/protocol"
import { ReorgOps } from "../../src/ops/reorg.js"
import { Retire } from "../../src/reorg/retire.js"
import { Keys } from "../../src/registry/keys.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import type { Services } from "../../src/services.js"
import { Tools } from "../../src/tools/index.js"
import { MainTools } from "../../src/tools/main.js"
import { ReorganizeTool } from "../../src/tools/reorganize.js"
import { f1, git, temp } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, MODEL, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"

const SLOW = 180_000

const box = temp("own-team-reorg-")
const services: FakeService[] = []
afterAll(() => box.dispose())
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})

const STAR = Preset.ID.create()
const INVENTORY = OwnTeam.AreaID.make("ar_inventory-ui")
const repo = f1(path.join(box.root, "f1"))

function fakeService() {
  const service = start()
  services.push(service)
  const known = new Set<string>()
  const add = (input: Parameters<typeof session>[0]) => {
    const view = session(input)
    known.add(input.id)
    service.routes.set(`GET /api/session/${input.id}`, () => Response.json({ data: view }))
    service.routes.set(`GET /api/experimental/session/${input.id}/instructions/entries`, () =>
      Response.json({ data: [] }),
    )
    for (const key of [RoleInstructions.MAIN, RoleInstructions.OWNER, RoleInstructions.HANDOFF])
      service.routes.set(
        `PUT /api/experimental/session/${input.id}/instructions/entries/${key}`,
        () => new Response(null, { status: 204 }),
      )
    return view
  }
  service.routes.set("POST /api/session", (request) => {
    const body = request.body as { readonly id: string; readonly location: { readonly directory: string } }
    if (known.has(body.id)) return service.routes.get(`GET /api/session/${body.id}`)!(request)
    return Response.json({ data: add({ id: body.id, directory: body.location.directory, model: MODEL }) })
  })
  service.routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
  return { service, add }
}

let roots = 0

async function setup(
  input: { readonly policy?: Partial<OwnTeam.Policy>; readonly root?: string; readonly state?: "on" | "off" } = {},
) {
  const world = new World()
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [{ group: "codex", defaultModel: null, star: STAR }] }))
  world.accounts.set("session.approval.set", (call) => ({ mode: (call as { mode: string }).mode, patched: [] }))
  world.accounts.set("session.preset.apply", () => ({ binding: {}, resolution: null, entry: "written", dryRun: false }))
  const fake = fakeService()
  fake.add({ id: MAIN_SESSION, directory: repo.home, model: MODEL })
  const clock = manual()
  const h = controller(world, { directory: repo.home, clock, source: fake.service.source })
  const record: OwnTeam.Team = {
    ...team({ home: repo.home, ...(input.state === undefined ? {} : { state: input.state }) }),
    commonDir: path.join(repo.home, ".git"),
    worktreeRoot: input.root ?? path.join(box.root, `team-${++roots}`),
    policy: { ...OwnTeam.POLICY, ...input.policy },
  }
  const existing: OwnTeam.Area = {
    ...area({ slug: "inventory-ui", directory: path.join(box.root, "elsewhere", "inventory-ui") }),
    name: "인벤토리 화면",
  }
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(record)
    await h.services.registry.areas.put(existing)
  })
  return { ...h, world, clock, fake, team: record, existing }
}

function rpc(services: Services.Context) {
  const handlers = TeamRpc.create({ services, leader: () => true, log: services.log })
  // SAFETY (test): every handler takes its method's input and `{signal, error}`.
  const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
  return (method: string, input: unknown) =>
    loose[method]!(input, {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    })
}

async function finished(services: Services.Context, opID: string) {
  await services.runner.settled(opID)
  const op = await services.journal.get(TEAM_ID, opID)
  if (!op) throw new Error(`op ${opID} is gone`)
  return op
}

const reorganize = Tools.DEFINITIONS.find((definition) => definition.name === "reorganize")!

describe("reorg.apply", () => {
  test(
    "a user's proposal: a new area and a rename in one op; an area named twice skipped (V4); V6 slug and V12 name fixed",
    async () => {
      const h = await setup()
      const answer = (await rpc(h.services)("reorg.apply", {
        teamID: TEAM_ID,
        proposal: {
          version: 1,
          ops: [
            { op: "new", slug: "Docs Site!", name: `문서 사이트 ${"가".repeat(60)}`, goal: "안내서" },
            { op: "rename", area: "inventory-ui", name: "인벤토리 v2", subtitle: "정렬" },
            { op: "retire", area: "inventory-ui" },
            { op: "split", area: "inventory-ui", slug: "inv-2", name: "둘" },
          ],
          notes: "작은 정리입니다",
          suggest: [{ kind: "convert", area: "inventory-ui", why: "가벼운 폴더면 절약" }],
        },
      })) as { readonly opID: string }
      expect(answer.opID).toMatch(/^op_/)
      const op = await finished(h.services, answer.opID)
      expect(op).toMatchObject({ kind: "reorg", by: "user", state: "done" })
      expect(op.undo).toEqual({ available: true })
      expect(op.steps.map((step) => step.kind)).toEqual([
        "area-rename",
        "branch-create",
        "worktree-create",
        "area-record",
        "owner-create",
      ])
      expect(op.steps[0]?.args).toEqual({
        areaID: INVENTORY,
        name: "인벤토리 v2",
        subtitle: "정렬",
        // The role and the mark before (2026-11-17), for an undo of a rename that carries them.
        previous: { name: "인벤토리 화면", subtitle: null, goal: "", userMade: false },
      })
      expect(op.summary?.lines).toEqual([
        { kind: "notes", text: "작은 정리입니다" },
        { kind: "suggest", suggestion: { kind: "convert", area: "inventory-ui", why: "가벼운 폴더면 절약" } },
        { kind: "skipped", item: "ops/2", why: "invalid" },
        { kind: "skipped", item: "ops/3", why: "invalid" },
        { kind: "area", areaID: INVENTORY, change: "renamed" },
        { kind: "area", areaID: OwnTeam.AreaID.make("ar_docs-site"), change: "created" },
      ])
      const created = await h.services.registry.areas.get(TEAM_ID, "ar_docs-site")
      expect(created?.name).toHaveLength(40)
      expect(created).toMatchObject({ goal: "안내서", branch: "docs-site", preset: STAR, origin: "created" })
      expect(git(repo.home, ["rev-parse", "refs/heads/docs-site"]).trim()).toBe(repo.head)
      expect(await h.services.registry.areas.get(TEAM_ID, "ar_inventory-ui")).toMatchObject({
        name: "인벤토리 v2",
        subtitle: "정렬",
        state: "active",
      })
      // Nothing of the actions V4 dropped ran: no retire or split step.
      expect(op.steps.some((step) => step.kind.startsWith("retire") || step.kind.startsWith("split"))).toBe(false)

      // Removing the subtitle (`null`) and nothing else.
      const second = (await rpc(h.services)("reorg.apply", {
        teamID: TEAM_ID,
        proposal: { version: 1, ops: [{ op: "rename", area: "인벤토리 v2", name: "인벤토리 v2", subtitle: null }] },
      })) as { readonly opID: string }
      expect((await finished(h.services, second.opID)).state).toBe("done")
      expect((await h.services.registry.areas.get(TEAM_ID, "ar_inventory-ui"))?.subtitle).toBeUndefined()
      await h.close()
    },
    SLOW,
  )

  test("a stored judge proposal is applied by `auto`; a missing or expired one is not_found", async () => {
    const h = await setup()
    const proposalID = OwnTeam.ProposalID.create()
    const store = (createdAt: number) =>
      h.world.kv.set(
        Keys.proposal(TEAM_ID, proposalID),
        Keys.toJson(
          Schema.encodeSync(ReorgOps.Stored)({
            proposal: { version: 1, ops: [{ op: "rename", area: "ar_inventory-ui", name: "자동 이름" }] },
            createdAt,
          }),
        ),
      )
    store(h.clock.now())
    const answer = (await rpc(h.services)("reorg.apply", { teamID: TEAM_ID, proposalID })) as { readonly opID: string }
    const op = await finished(h.services, answer.opID)
    expect(op).toMatchObject({ by: "auto", state: "done", areaID: "ar_inventory-ui" })
    expect((await h.services.registry.areas.get(TEAM_ID, "ar_inventory-ui"))?.name).toBe("자동 이름")

    store(h.clock.now() - 8 * 86_400_000)
    expect(await rpc(h.services)("reorg.apply", { teamID: TEAM_ID, proposalID })).toMatchObject({
      type: "not_found",
      data: { what: "proposal" },
    })
    expect(
      await rpc(h.services)("reorg.apply", { teamID: TEAM_ID, proposalID: OwnTeam.ProposalID.create() }),
    ).toMatchObject({ type: "not_found" })
    await h.close()
  })

  test(
    "V4: a slug once; no area limit (V5 removed 2026-11-14, a stored maxAreas is not read); nothing left is invalid_proposal",
    async () => {
      const h = await setup({ policy: { maxAreas: 1 } })
      const answer = (await rpc(h.services)("reorg.apply", {
        teamID: TEAM_ID,
        proposal: {
          version: 1,
          ops: [
            { op: "new", slug: "alpha", name: "알파" },
            { op: "new", slug: "beta", name: "베타" },
            { op: "new", slug: "alpha", name: "알파 둘" },
          ],
        },
      })) as { readonly opID: string }
      const op = await finished(h.services, answer.opID)
      expect(op.summary?.lines).toEqual([
        { kind: "skipped", item: "ops/2", why: "invalid" },
        { kind: "area", areaID: OwnTeam.AreaID.make("ar_alpha"), change: "created" },
        { kind: "area", areaID: OwnTeam.AreaID.make("ar_beta"), change: "created" },
      ])
      expect(await h.services.registry.areas.get(TEAM_ID, "ar_beta")).toMatchObject({ origin: "created" })

      // Two created areas past the stored maxAreas: a third is still made; a proposal with nothing valid is refused.
      expect(
        await rpc(h.services)("reorg.apply", {
          teamID: TEAM_ID,
          proposal: {
            version: 1,
            ops: [
              { op: "new", slug: "!!!", name: "!!!" },
              { op: "merge", area: "a", from: "b" },
            ],
          },
        }),
      ).toMatchObject({
        type: "invalid_proposal",
        data: {
          rejected: [
            { item: "ops/0", why: "영역 이름으로 쓸 수 없어요: '!!!'" },
            { item: "ops/1", why: "'a' 영역이 없어요" },
          ],
        },
      })
      const third = (await rpc(h.services)("reorg.apply", {
        teamID: TEAM_ID,
        proposal: { version: 1, ops: [{ op: "new", slug: "gamma", name: "감마" }] },
      })) as { readonly opID: string }
      await finished(h.services, third.opID)
      expect(await h.services.registry.areas.get(TEAM_ID, "ar_gamma")).toMatchObject({ origin: "created" })
      await h.close()
    },
    SLOW,
  )

  test("errors: unknown team, team off, another op running, a '#' area root, unknown areas and bad slugs", async () => {
    const h = await setup()
    const call = rpc(h.services)
    const rename = { version: 1, ops: [{ op: "rename", area: "inventory-ui", name: "x" }] }
    expect(await call("reorg.apply", { teamID: "tm_000000000000", proposal: rename })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
    expect(
      await call("reorg.apply", {
        teamID: TEAM_ID,
        proposal: {
          version: 1,
          ops: [
            { op: "rename", area: "nowhere", name: "x" },
            { op: "new", slug: "---", name: "x" },
            { op: "new", slug: "ok", name: "x", from: "nowhere" },
          ],
          areas: [{ slug: "adopted", name: "x", adopt: { worktree: "D:/x" } }],
          heavy: [{ dir: "assets", why: "큼" }],
        },
      }),
    ).toMatchObject({
      type: "invalid_proposal",
      data: {
        rejected: [
          { item: "heavy", why: "재구성에서는 바꾸지 않아요" },
          { item: "ops/0", why: "'nowhere' 영역이 없어요" },
          { item: "ops/1" },
          { item: "ops/2", why: "'nowhere' 영역이 없어요" },
          // 팀에 넣기 by a reorganization (8.2): a folder that is not a worktree of this repository is refused (V2).
          { item: "areas/0", why: "작업 폴더 목록에 없는 폴더예요" },
        ],
      },
    })

    h.services.steps.register({
      kind: "test-wait",
      observe: async () => ({ state: "pending" }),
      act: async () => ({ ok: true }),
      verify: async () => ({ ok: true }),
      prepare: async () => ({ text: "기다림" }),
    })
    const waiting = await h.services.runner.start({
      teamID: TEAM_ID,
      kind: "retire",
      by: "user",
      steps: [{ kind: "test-wait", mode: "confirm" }],
    })
    if (!waiting.ok) throw new Error("busy")
    await h.services.runner.settled(waiting.op.id)
    expect(await call("reorg.apply", { teamID: TEAM_ID, proposal: rename })).toMatchObject({
      type: "busy",
      data: { opID: waiting.op.id, kind: "retire" },
    })
    await h.close()

    const hash = await setup({ root: path.join(box.root, "#team") })
    expect(
      await rpc(hash.services)("reorg.apply", {
        teamID: TEAM_ID,
        proposal: { version: 1, ops: [{ op: "new", slug: "x", name: "x" }] },
      }),
    ).toMatchObject({ type: "path_forbidden", data: { why: "hash" } })
    await hash.close()

    const off = await setup({ state: "off" })
    expect(await rpc(off.services)("reorg.apply", { teamID: TEAM_ID, proposal: rename })).toMatchObject({
      type: "team_off",
    })
    await off.close()
  })

  test("reorg.propose answers (wired in T3.15); health lists every reorg action", async () => {
    const h = await setup()
    expect(await rpc(h.services)("reorg.propose", { teamID: TEAM_ID })).not.toMatchObject({ type: "unsupported" })
    expect(TeamRpc.FEATURES).toEqual(
      expect.arrayContaining([
        "reorg.new",
        "reorg.rename",
        "reorg.split",
        "reorg.merge",
        "reorg.retire",
        "reorg.convert",
        "reorg.move",
      ]),
    )
    await h.close()
  })
})

describe("team_reorganize", () => {
  test(
    "the main's proposal is applied by `main` and answered with applied, pending, skipped and rejected",
    async () => {
      const h = await setup()
      const reply = await reorganize.execute(h.services, MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [
            { op: "new", slug: "tooling", name: "도구", goal: "빌드 스크립트" },
            { op: "rename", area: "inventory-ui", name: "인벤토리" },
            // A second action on the same area (a retire would make the whole proposal a voice plan, V-f).
            { op: "rename", area: "inventory-ui", name: "인벤토리 둘" },
          ],
        },
      })
      expect(reply).toMatchObject({
        ok: true,
        applied: [
          { item: "ops/1", action: "rename", area: "inventory-ui", state: "done" },
          { item: "ops/0", action: "new", area: "tooling", state: "done" },
        ],
        pending: [],
        skipped: [],
        rejected: [{ item: "ops/2", why: "같은 영역이 두 번 나와요" }],
      })
      const op = await h.services.journal.get(TEAM_ID, String(reply.opID))
      expect(op).toMatchObject({ by: "main", kind: "reorg" })
      expect((await h.services.registry.areas.get(TEAM_ID, "ar_tooling"))?.owner.sessionID).not.toBeNull()
      await h.close()
    },
    SLOW,
  )

  test(
    "an area under Main 멈춤 is skipped (TI-13) and told in `skipped`; a conversation move only becomes a suggestion",
    async () => {
      const h = await setup()
      Retire.register(h.services)
      h.services.features().reorg.register()
      await h.services.write(TEAM_ID, () => h.services.registry.areas.put({ ...h.existing, paused: "user" }))
      const reply = await reorganize.execute(h.services, MAIN_SESSION, {
        proposal: {
          version: 1,
          ops: [
            { op: "split", area: "inventory-ui", slug: "inventory-two", name: "인벤토리 둘" },
            { op: "move", sessionID: "ses_user0000000000000000000001", area: "inventory-ui" },
          ],
        },
      })
      expect(reply).toMatchObject({
        ok: false,
        applied: [],
        pending: [],
        skipped: [
          {
            item: "ops/0",
            area: "inventory-ui",
            why: "'인벤토리 화면' 영역은 메인 멈춤이라 이번 정리에서 건너뛰었어요",
          },
        ],
        rejected: [{ item: "ops/1", why: "대화 옮기기는 사용자만 해요. 카드에 제안으로 올렸어요" }],
      })
      expect(reply.text).toContain("제안 1개는 사용자에게 카드로 보였습니다")
      const op = await finished(h.services, String(reply.opID))
      expect(op).toMatchObject({ by: "main", state: "done", steps: [] })
      expect(await h.services.registry.areas.get(TEAM_ID, "ar_inventory-ui")).toMatchObject({ state: "active" })
      await h.close()
    },
    SLOW,
  )

  test("only the team main; an unreadable proposal or nothing to apply answers ok: false without throwing", async () => {
    const h = await setup()
    expect(await reorganize.execute(h.services, OWNER_SESSION, { proposal: { version: 1 } })).toEqual({
      ok: false,
      text: MainTools.MAIN_ONLY,
    })
    expect(await reorganize.execute(h.services, "ses_stranger", { proposal: { version: 1 } })).toEqual({
      ok: false,
      text: MainTools.NOT_TEAM,
    })
    const unreadable = await reorganize.execute(h.services, MAIN_SESSION, { proposal: { version: 2 } })
    expect(unreadable).toMatchObject({
      ok: false,
      applied: [],
      pending: [],
      skipped: [],
      rejected: [{ item: "proposal" }],
    })
    const nothing = await reorganize.execute(h.services, MAIN_SESSION, {
      proposal: { version: 1, ops: [{ op: "rename", area: "nowhere", name: "x" }] },
    })
    expect(nothing).toEqual({
      ok: false,
      text: "적용할 수 있는 항목이 없습니다.",
      applied: [],
      pending: [],
      skipped: [],
      rejected: [{ item: "ops/0", why: "'nowhere' 영역이 없어요" }],
    })
    expect(await h.services.journal.list(TEAM_ID)).toHaveLength(0)

    // A failure below the tool (here: no live instance for KV) is an answer too, with the four lists.
    const team = (await h.services.registry.teams.get(TEAM_ID))!
    h.detach()
    expect(
      await ReorganizeTool.run(
        h.services,
        { role: "main", team, sessionID: MAIN_SESSION },
        { proposal: { version: 1, ops: [{ op: "rename", area: "inventory-ui", name: "x" }] } },
      ),
    ).toEqual({ ok: false, text: ReorganizeTool.FAILED, applied: [], pending: [], skipped: [], rejected: [] })
    await h.close()
  })
})
