// Enabling on a project in progress (06 §0.5, §3.6, §3.7, §10.1; TG10, TG15 adopt registration, TG16 adopted delta 0):
// F4 with per-folder conversations on ChatGPT 01, ChatGPT 02, the siwc account of ChatGPT 01's login and the Claude
// slot. The judge (or the rule-based proposal) adopts folders; own.team locks them, registers each folder's most recent
// root session as its owner without writing to that conversation, keeps the conversation's model and preset (team
// R4 aside), and changes no file, branch or folder outside the team. Fake own service on 127.0.0.1, fake own.accounts,
// real git fixtures; every value is fake.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { OwnTeam, Preset } from "@own/protocol"
import { Classify } from "../../src/git/classify.js"
import { Identity } from "../../src/git/identity.js"
import { Refs } from "../../src/git/refs.js"
import { Worktree } from "../../src/git/worktree.js"
import { TeamHome } from "../../src/ops/home.js"
import { Areas } from "../../src/registry/area.js"
import { Keys } from "../../src/registry/keys.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import type { Services } from "../../src/services.js"
import { Permissions } from "../../src/tools/permissions.js"
import {
  F4_ACCOUNTS,
  F4_NOW,
  F4_PRESETS,
  F4_REFS,
  F4Service,
  f4,
  f4Accounts,
  f4Conversations,
} from "../fixtures/f4-layout.js"
import { commit, files, git, head, status, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { World, controller, tempHome } from "../support/context.js"
import { start } from "../support/service.js"

const SLOW = 300_000

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
}, SLOW)

/** The team main as a fake: the session is made in the fake service on the given Ref; `model` reads it back. */
function mainFeature(backend: F4Service, models: Map<string, Model.Ref>): Services.Factories["main"] {
  return (services) => ({
    create: async (input) => {
      if (!backend.sessions.has(input.sessionID))
        backend.add({ id: input.sessionID, directory: input.directory, updated: F4_NOW, model: input.model })
      models.set(input.sessionID, input.model)
      return { ok: true, sessionID: input.sessionID }
    },
    model: async (teamID) => {
      const team = await services.registry.teams.get(teamID)
      return team && backend.sessions.get(team.main.sessionID)?.model
    },
  })
}

async function setup(extra: (repo: ReturnType<typeof f4>) => void = () => {}) {
  const root = temp("own-team-adopt-")
  cleanups.push(() => root.dispose())
  const repo = f4(root.root)
  extra(repo)
  const ownHome = await tempHome()
  cleanups.push(() => ownHome[Symbol.asyncDispose]())
  const fake = start()
  cleanups.push(() => fake.stop())
  const backend = new F4Service(fake)
  const world = new World()
  const models = new Map<string, Model.Ref>()
  const accounts = f4Accounts(world.accounts, models)
  for (const conversation of f4Conversations(repo)) {
    backend.add(conversation)
    models.set(conversation.id, conversation.model)
    if (conversation.presetID)
      accounts.bindings.set(conversation.id, { presetID: conversation.presetID, group: "codex" })
    // The user switched computer use on in each conversation (01 §10.2); own.team never touches it.
    world.sessions.set(conversation.id, {
      id: conversation.id,
      directory: conversation.directory,
      permissions: [{ action: "computer", resource: "*", effect: "allow" }],
    })
  }
  const harness = controller(world, {
    directory: ownHome.root,
    clock: manual(F4_NOW),
    home: ownHome.root,
    source: fake.source,
    features: { main: mainFeature(backend, models) },
  })
  cleanups.push(() => harness.close())
  return { ...harness, repo, backend, fake, world, models, accounts }
}

type Harness = Awaited<ReturnType<typeof setup>>

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

const Started = Schema.Struct({ opID: OwnTeam.OpID })

async function enable(h: Harness, input: { readonly directory: string; readonly sessionID?: string }) {
  const answer = await rpc(h.services)("enable", input)
  const started = Schema.decodeUnknownOption(Started)(answer)
  if (started._tag === "None") throw new Error(`enable failed: ${JSON.stringify(answer)}`)
  const deadline = Date.now() + 240_000
  const read = () => h.services.journal.find(started.value.opID)
  while ((await read())?.state === "running") {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
  const op = await read()
  if (!op) throw new Error("the op is gone")
  return op
}

/** What must not change in a folder: HEAD, the branch, the status and the files on disk. */
function snapshot(directory: string) {
  return {
    head: head(directory),
    branch: git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    status: status(directory),
    files: files(directory),
  }
}

async function locks(commonDir: string) {
  return (await TeamHome.snapshot(commonDir)) ?? {}
}

function lockOf(held: Readonly<Record<string, string>>, directory: string) {
  return Object.entries(held).find(([where]) => Classify.same(where, directory))?.[1] ?? null
}

/** Requests that write to a session of `ids` (anything but a read). */
function writes(h: Harness, ids: ReadonlyArray<string>) {
  return h.fake.requests.filter(
    (request) => request.method !== "GET" && ids.some((id) => request.path.includes(`/session/${id}`)),
  )
}

const AREA = {
  cu: Areas.id("cl-cu"),
  perf: Areas.id("cl-perf"),
  siwc: Areas.id("cl-siwc"),
  computerUse: Areas.id("computer-use"),
  localModel: Areas.id("local-model"),
  spike: Areas.id("spike"),
  detached: Areas.id("own-detached"),
}

describe("enable on F4 (06 §0.5, TG10)", () => {
  test(
    "the rule-based proposal adopts the three active folders: locks, owners registered, nothing else touched",
    async () => {
      const h = await setup()
      const repo = h.repo
      const adopted = [repo.nested["cl-cu"], repo.nested["cl-perf"], repo.nested["cl-siwc"]]
      const outside = [repo.primary, ...repo.claude, repo.codex, repo.hash, repo.locked, repo.detached]
      const before = Object.fromEntries([...adopted, ...outside].map((directory) => [directory, snapshot(directory)]))
      const held = await locks(repo.commonDir)
      // The judge answers nothing usable twice: the rule-based proposal (06 §3.4) adopts active named branches.
      h.backend.answer = () => "영역을 잘 모르겠습니다."
      const op = await enable(h, { directory: repo.home, sessionID: repo.sessions.home.id })
      expect(op.state).toBe("done")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        ["enable.observe", "done"],
        ["enable.main", "done"],
        ["enable.registry", "done"],
        ["enable.judge", "done"],
        ["enable.keep", "done"],
        ["team.lock", "done"],
        ["team.lock", "done"],
        ["team.lock", "done"],
        ["team.lock", "done"],
        ["adopt.register", "done"],
        ["adopt.register", "done"],
        ["adopt.register", "done"],
        ["enable.refresh", "done"],
        ["enable.finish", "done"],
      ])
      const team = (await h.services.registry.teams.get(op.teamID))!
      expect(team.home).toMatchObject({ linked: true, chosenBy: "session" })
      expect(Identity.same(team.home.directory, repo.home)).toBe(true)

      // Locks: the home (its nested folders are protected from removal, 8.6) and the three areas; nothing else moved.
      const after = await locks(repo.commonDir)
      expect(lockOf(after, repo.home)).toBe(TeamHome.reason(op.teamID))
      for (const [areaID, directory] of [
        [AREA.cu, repo.nested["cl-cu"]],
        [AREA.perf, repo.nested["cl-perf"]],
        [AREA.siwc, repo.nested["cl-siwc"]],
      ] as const)
        expect(lockOf(after, directory)).toBe(Worktree.lockReason(areaID))
      for (const directory of [...outside, repo.nested["computer-use"], repo.nested["local-model"]])
        expect(lockOf(after, directory)).toBe(lockOf(held, directory))
      // No file, branch or HEAD changed in the adopted folders or outside the team.
      for (const directory of [...adopted, ...outside]) expect(snapshot(directory)).toEqual(before[directory]!)
      // The detached folder's commits are kept (TI-8) although it stays outside the team.
      const detachedHead = head(repo.detached)
      expect(await Refs.read(repo.commonDir, `refs/own/keep/${detachedHead}`)).toBe(detachedHead)

      // The registry: folder names, owners registered but not attached, Main 멈춤 off.
      const areas = await h.services.registry.areas.list(op.teamID)
      expect(areas.map((area) => area.id)).toEqual([AREA.cu, AREA.perf, AREA.siwc])
      for (const area of areas) {
        expect(area).toMatchObject({ origin: "adopted", state: "active", paused: false, status: { kind: "idle" } })
        expect(area.owner.attached).toBe(false)
        expect(area.subtitle).toBeUndefined()
        expect(area.cone).toEqual({ extra: {}, kept: {} })
      }
      const byID = (id: OwnTeam.AreaID) => areas.find((area) => area.id === id)!
      expect(byID(AREA.cu)).toMatchObject({
        name: "cl-cu",
        branch: "own-computer-use",
        shape: "plain",
        owner: { sessionID: repo.sessions.cu.id, previous: [] },
        // ChatGPT 01, the team's account: the conversation's model and its non-★ preset stay.
        main: { model: F4_REFS.team, chosenBy: "adopted" },
        preset: F4_PRESETS.review.id,
        base: { sha: repo.base },
      })
      expect(Identity.same(byID(AREA.cu).gitDir, path.join(repo.commonDir, "worktrees", "cl-cu"))).toBe(true)
      // ChatGPT 02 is another subscription of the team's company: 팀과 같게 with the group's ★, and an R4 line.
      expect(byID(AREA.perf).main).toBeUndefined()
      expect(byID(AREA.perf)).toMatchObject({ owner: { sessionID: repo.sessions.perf.id }, preset: F4_PRESETS.star.id })
      // The siwc account of ChatGPT 01's login is the same subscription: its Ref stays.
      expect(byID(AREA.siwc)).toMatchObject({
        main: { model: F4_REFS.siwc, chosenBy: "adopted" },
        preset: Preset.builtinID("siwc"),
      })

      // The card (06 §9.3): the adopted areas, the R4 line, the active folder left out, the keep ref; no skipped item.
      const lines = op.summary?.lines ?? []
      expect(
        lines.flatMap((line) => (line.kind === "area" ? [`${line.areaID}:${line.change}`] : [])).toSorted(),
      ).toEqual([`${AREA.cu}:adopted`, `${AREA.perf}:adopted`, `${AREA.siwc}:adopted`])
      const chatgpt02 = F4_ACCOUNTS.find((account) => account.label === "ChatGPT 02")!.id
      expect(lines).toContainEqual({ kind: "r4", areaID: AREA.perf, accountID: chatgpt02 })
      const unadopted = lines.flatMap((line) => (line.kind === "unadopted" ? [line] : []))
      expect(unadopted).toHaveLength(1)
      expect(Identity.same(unadopted[0]!.directory, repo.detached)).toBe(true)
      expect(unadopted[0]).toMatchObject({ ahead: 2 })
      expect(lines).toContainEqual({ kind: "ref", ref: `refs/own/keep/${detachedHead}`, sha: detachedHead })
      expect(lines.some((line) => line.kind === "skipped")).toBe(false)
      expect(lines.some((line) => line.kind === "heavy")).toBe(false)
      // Outside the team: the main worktree, other tools' folders, the `#` path, the gone one and what was left.
      expect(team.external.some((item) => adopted.some((directory) => Identity.same(item.directory, directory)))).toBe(
        false,
      )
      expect(team.external.find((item) => Identity.same(item.directory, repo.primary))?.why).toBe("primary")
      expect(team.external.find((item) => Identity.same(item.directory, repo.codex))?.why).toBe("other-tool")
      expect(team.external.find((item) => Identity.same(item.directory, repo.detached))?.why).toBe("left")

      // TG16: the adopted conversations got nothing at enable (no instruction, permission, preset or approval write).
      const owners = [repo.sessions.cu.id, repo.sessions.perf.id, repo.sessions.siwc.id]
      expect(writes(h, owners)).toEqual([])
      const touched = h.world.calls.filter(
        (call) =>
          (call.method === "session.preset.apply" || call.method === "session.approval.set") &&
          owners.includes(Schema.decodeUnknownSync(Schema.Struct({ sessionID: Schema.String }))(call.input).sessionID),
      )
      expect(touched).toEqual([])
      for (const id of owners) {
        expect(h.world.sessions.get(id)?.permissions).toEqual([{ action: "computer", resource: "*", effect: "allow" }])
        expect(h.backend.sessions.get(id)?.entries.size).toBe(0)
      }
      // Each owner's cursor is its log's newest seq: its history before adoption is never folded into team news.
      for (const id of owners) expect(h.world.kv.get(Keys.cursor(id))).toBe(41)
      expect(h.backend.prompts).toHaveLength(2)

      // 다시 켜기 converges: the same areas, the locks again, no second judge, owners still not attached.
      git(repo.primary, ["worktree", "unlock", repo.nested["cl-perf"]])
      const again = await enable(h, { directory: repo.home })
      expect(again.state).toBe("done")
      expect(again.steps.map((step) => step.kind)).toEqual([
        "enable.observe",
        "team.lock",
        "team.lock",
        "team.lock",
        "team.lock",
        "enable.registry",
        "enable.refresh",
        "enable.finish",
      ])
      expect(h.backend.prompts).toHaveLength(2)
      expect((await h.services.registry.areas.list(op.teamID)).map((area) => [area.id, area.owner])).toEqual(
        areas.map((area) => [area.id, area.owner]),
      )
      expect(lockOf(await locks(repo.commonDir), repo.nested["cl-perf"])).toBe(Worktree.lockReason(AREA.perf))
      expect(writes(h, owners)).toEqual([])
    },
    SLOW,
  )

  test(
    "the judge's adoptions: the Claude slot kept, a folder without a conversation, a detached HEAD named, a stopped merge",
    async () => {
      const spike = { directory: "", commit: "" }
      const h = await setup((repo) => {
        spike.directory = path.join(repo.root, "own-spike")
        git(repo.primary, ["worktree", "add", "-q", "--detach", spike.directory, repo.base])
        write(spike.directory, { "spike.txt": "idea\n" })
        spike.commit = commit(spike.directory, "spike")
      })
      const repo = h.repo
      const beforeDetached = snapshot(repo.detached)
      const beforeSpike = snapshot(spike.directory)
      h.backend.answer = () =>
        JSON.stringify({
          version: 1,
          areas: [
            { slug: "computer-use", name: "컴퓨터 사용", adopt: { worktree: repo.nested["computer-use"] } },
            { slug: "local-model", name: "로컬 모델", adopt: { worktree: repo.nested["local-model"] } },
            { slug: "spike", name: "실험", goal: "아이디어 확인", adopt: { worktree: spike.directory } },
            { slug: "own-detached", name: "멈춘 합치기", adopt: { worktree: repo.detached } },
          ],
          leave: [],
        })
      const op = await enable(h, { directory: repo.home, sessionID: repo.sessions.home.id })
      expect(op.state).toBe("done")
      const areas = await h.services.registry.areas.list(op.teamID)
      const byID = (id: OwnTeam.AreaID) => areas.find((area) => area.id === id)!
      // The Claude slot is another company's subscription: kept with its own preset (평소대로 of its group).
      expect(byID(AREA.computerUse)).toMatchObject({
        name: "computer-use",
        subtitle: "컴퓨터 사용",
        main: { model: F4_REFS.claude, chosenBy: "adopted" },
        preset: Preset.builtinID("claude-sub"),
        owner: { sessionID: repo.sessions.computerUse.id, attached: false },
      })
      // No conversation: 팀과 같게 with the team group's ★; the first main request makes the owner.
      expect(byID(AREA.localModel).main).toBeUndefined()
      expect(byID(AREA.localModel)).toMatchObject({
        preset: F4_PRESETS.star.id,
        owner: { sessionID: null, attached: false },
      })
      // A detached HEAD with a commit no branch has: kept first, then named without a file change.
      expect(await Refs.read(repo.commonDir, `refs/own/keep/${spike.commit}`)).toBe(spike.commit)
      expect(byID(AREA.spike)).toMatchObject({ branch: "spike", goal: "아이디어 확인", owner: { sessionID: null } })
      expect(snapshot(spike.directory)).toEqual({ ...beforeSpike, branch: "spike" })
      expect(await Refs.read(repo.commonDir, "refs/heads/spike")).toBe(spike.commit)
      // A merge stopped half way: registered and locked only; HEAD stays detached and no branch is made.
      const named = op.steps.find((step) => step.id === "adopt:own-detached:name")
      expect(named?.state).toBe("skipped")
      expect(named?.note).toContain("진행 중인 Git 작업")
      expect(byID(AREA.detached)).toMatchObject({ branch: "own-detached", origin: "adopted", deferredName: true })
      expect(snapshot(repo.detached)).toEqual(beforeDetached)
      expect(await Refs.read(repo.commonDir, "refs/heads/own-detached")).toBeNull()
      expect(lockOf(await locks(repo.commonDir), repo.detached)).toBe(Worktree.lockReason(AREA.detached))
      // The active folders the judge left out are on the card with 팀에 넣기 (V13).
      const left = (op.summary?.lines ?? []).filter((line) => line.kind === "unadopted")
      expect(left).toHaveLength(3)
      expect(op.summary?.lines?.some((line) => line.kind === "r4")).toBe(false)
      expect(writes(h, [repo.sessions.computerUse.id])).toEqual([])
    },
    SLOW,
  )

  test(
    "an adopted conversation the team cannot judge (own.accounts unreadable) is left out, never adopted blind",
    async () => {
      const h = await setup()
      const repo = h.repo
      h.backend.answer = () => "?"
      h.world.accounts.delete("accounts.list")
      const op = await enable(h, { directory: repo.home, sessionID: repo.sessions.home.id })
      expect(op.state).toBe("done")
      expect(await h.services.registry.areas.list(op.teamID)).toEqual([])
      const lines = op.summary?.lines ?? []
      expect(
        lines.flatMap((line) => (line.kind === "skipped" ? [`${line.areaID}:${line.why}`] : [])).toSorted(),
      ).toEqual([`${AREA.cu}:invalid`, `${AREA.perf}:invalid`, `${AREA.siwc}:invalid`])
      expect(lines.filter((line) => line.kind === "unadopted")).toHaveLength(4)
      // Nothing was locked for them.
      const held = await locks(repo.commonDir)
      for (const directory of [repo.nested["cl-cu"], repo.nested["cl-perf"], repo.nested["cl-siwc"]])
        expect(lockOf(held, directory)).toBeNull()
    },
    SLOW,
  )
})

describe("team permissions after adoption", () => {
  test("the owner's rules are exactly the team allows when attached (06 §2.8)", () => {
    // What `attach` writes in front of a conversation's own rules; the computer allow stays after them.
    expect(Permissions.merge([{ action: "computer", resource: "*", effect: "allow" }], "owner")).toEqual([
      { action: "team.owner", resource: "*", effect: "allow" },
      { action: "team.member", resource: "*", effect: "allow" },
      { action: "computer", resource: "*", effect: "allow" },
    ])
  })
})
