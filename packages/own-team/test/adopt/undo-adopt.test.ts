// Undo of an enable that adopted folders (06 §3.8 되돌리기, §8.2; TG16 approval tail after undo): adopted folders are
// unlocked (a folder with nested worktrees keeps a lock), an owner the first main request attached is detached, the
// registry goes; files, branches and conversations stay as they were. An area the enable created is removed only when
// untouched, and an ignored file the user made there counts as touched (T1 review). F4 with a fake judge and a fake
// new-area step; fake service on 127.0.0.1; every value is fake.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Classify } from "../../src/git/classify.js"
import { Refs } from "../../src/git/refs.js"
import { Worktree } from "../../src/git/worktree.js"
import { TeamHome } from "../../src/ops/home.js"
import { Areas } from "../../src/registry/area.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import type { Services } from "../../src/services.js"
import { Permissions } from "../../src/tools/permissions.js"
import { F4_NOW, F4Service, f4, f4Accounts, f4Conversations } from "../fixtures/f4-layout.js"
import { files, git, head, status, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { World, controller, tempHome } from "../support/context.js"
import { start } from "../support/service.js"

const SLOW = 300_000

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
}, SLOW)

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

const AreaArgs = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  base: Schema.String,
  directory: Schema.String,
})

/** New areas as a fake of T1.14: a real locked worktree, an owner session and the record. */
function areasFeature(backend: F4Service): Services.Factories["areas"] {
  return (services) => {
    services.steps.register({
      kind: "test.area",
      observe: async (input) => {
        const args = Schema.decodeUnknownSync(AreaArgs)(input.step.args)
        return (await services.registry.areas.get(input.op.teamID, Areas.id(args.slug)))
          ? { state: "satisfied" }
          : { state: "pending" }
      },
      act: async (input) => {
        const args = Schema.decodeUnknownSync(AreaArgs)(input.step.args)
        const team = await services.registry.teams.get(input.op.teamID)
        if (!team) return { ok: false, note: "no team" }
        const areaID = Areas.id(args.slug)
        const made = await Worktree.create(
          {
            home: team.home.directory,
            directory: args.directory,
            branch: args.slug,
            base: args.base,
            areaID,
            shape: "plain",
            cone: [],
            heavy: [],
          },
          { askDownloadBytes: Number.MAX_SAFE_INTEGER },
        )
        if (!made.ok || made.state !== "ready") return { ok: false, note: "worktree" }
        const owner = SessionID.create()
        backend.add({ id: owner, directory: args.directory, updated: F4_NOW })
        await services.write(team.id, () =>
          services.registry.areas.put({
            id: areaID,
            teamID: team.id,
            name: args.name,
            goal: "",
            origin: "created",
            state: "active",
            branch: args.slug,
            gitDir: made.gitDir,
            base: { sha: args.base, at: F4_NOW },
            directory: args.directory,
            shape: "plain",
            cone: { extra: {}, kept: {} },
            owner: { sessionID: owner, previous: [], attached: true },
            preset: Preset.builtinID("codex"),
            paused: false,
            status: { kind: "idle", at: F4_NOW, text: "" },
            handoff: null,
          }),
        )
        return { ok: true }
      },
      verify: async () => ({ ok: true }),
    })
    return {
      plan: async (input) => {
        const base = await Refs.read(input.team.commonDir, `refs/heads/${input.team.target}`)
        if (!base) return { ok: false, error: "not_git", message: "no target", data: { directory: "" } }
        return {
          ok: true,
          areaID: Areas.id(input.slug),
          steps: [
            {
              kind: "test.area",
              args: {
                slug: input.slug,
                name: input.name,
                base,
                directory: path.join(input.team.worktreeRoot, input.slug),
              },
            },
          ],
        }
      },
    }
  }
}

async function setup() {
  const root = temp("own-team-undo-adopt-")
  cleanups.push(() => root.dispose())
  const repo = f4(root.root)
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
    features: { main: mainFeature(backend, models), areas: areasFeature(backend) },
  })
  cleanups.push(() => harness.close())
  return { ...harness, repo, backend, fake, world, accounts }
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

async function run(h: Harness, method: string, input: unknown, teamID?: string) {
  const answer = await rpc(h.services)(method, input)
  const opID = Schema.decodeUnknownSync(Started)(answer).opID
  const found = teamID ?? (await h.services.journal.find(opID))?.teamID
  if (!found) throw new Error(`${method}: no op`)
  const deadline = Date.now() + 240_000
  const read = () => h.services.journal.get(found, opID)
  while ((await read())?.state === "running" || (await read()) === undefined) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
  return (await read())!
}

function snapshot(directory: string) {
  return {
    head: head(directory),
    branch: git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    status: status(directory),
    files: files(directory),
  }
}

async function lockOf(commonDir: string, directory: string) {
  const held = (await TeamHome.snapshot(commonDir)) ?? {}
  return Object.entries(held).find(([where]) => Classify.same(where, directory))?.[1] ?? null
}

const CU = Areas.id("cl-cu")

describe("undo of an enable that adopted folders", () => {
  test(
    "unlocks the adopted folders (the home keeps a nested lock), detaches the attached owner, removes the registry",
    async () => {
      const h = await setup()
      const repo = h.repo
      const adopted = [repo.nested["cl-cu"], repo.nested["cl-perf"], repo.nested["cl-siwc"]]
      h.backend.answer = () =>
        JSON.stringify({
          version: 1,
          areas: [
            { slug: "cl-cu", name: "컴퓨터 사용", adopt: { worktree: repo.nested["cl-cu"] } },
            { slug: "cl-perf", name: "성능", adopt: { worktree: repo.nested["cl-perf"] } },
            { slug: "cl-siwc", name: "로그인", adopt: { worktree: repo.nested["cl-siwc"] } },
            { slug: "inventory-ui", name: "인벤토리 화면", create: { from: "main" } },
          ],
        })
      const enabled = await run(h, "enable", { directory: repo.home, sessionID: repo.sessions.home.id })
      expect(enabled.state).toBe("done")
      const teamID = enabled.teamID
      const team = (await h.services.registry.teams.get(teamID))!
      const created = (await h.services.registry.areas.get(teamID, Areas.id("inventory-ui")))!
      for (const directory of adopted) expect(await lockOf(repo.commonDir, directory)).toMatch(/^own\.team area:/)

      // The first main request to cl-cu attached its owner (06 §3.7, delta 1).
      h.accounts.modes.set(repo.sessions.cu.id, "full")
      expect(await h.services.features().owner.attach({ teamID, areaID: CU })).toEqual({ ok: true })
      expect(h.world.sessions.get(repo.sessions.cu.id)?.permissions).toEqual([
        ...Permissions.rules("owner"),
        { action: "computer", resource: "*", effect: "allow" },
      ])
      expect(h.backend.sessions.get(repo.sessions.cu.id)?.entries.has(RoleInstructions.OWNER)).toBe(true)
      expect(h.accounts.bindings.get(repo.sessions.cu.id)?.team).toBeDefined()
      // The user made an ignored file in the new area (a local install): it counts as touched.
      write(created.directory, { "node_modules/pkg/index.js": "local\n" })

      const before = Object.fromEntries(adopted.map((directory) => [directory, snapshot(directory)]))
      const calls = h.world.calls.length
      const requests = h.fake.requests.length
      const undo = await run(h, "op.undo", { opID: enabled.id }, teamID)
      expect(undo.state).toBe("done")
      expect(undo.steps.map((step) => [step.kind, step.state])).toEqual([
        ["undo.area", "done"],
        ["adopt.detach", "done"],
        ["adopt.detach", "done"],
        ["adopt.detach", "done"],
        ["undo.archive", "done"],
        ["team.restore", "done"],
        ["team.restore", "done"],
        ["team.restore", "done"],
        ["team.restore", "done"],
        ["undo.mark", "done"],
        ["undo.registry", "done"],
      ])
      expect(undo.summary?.lines).toContainEqual({ kind: "area", areaID: created.id, change: "touched" })
      expect(undo.summary?.lines?.filter((line) => line.kind === "lock-kept")).toHaveLength(1)

      // Locks: the adopted folders are free again; the home holds nested worktrees, so it keeps `own: nested …`.
      for (const directory of adopted) expect(await lockOf(repo.commonDir, directory)).toBeNull()
      expect(await lockOf(repo.commonDir, repo.home)).toBe(TeamHome.NESTED)
      // The attached owner lost exactly the team allows and its role; own.accounts' bundle is last again.
      const cu = repo.sessions.cu.id
      expect(h.world.sessions.get(cu)?.permissions).toEqual([{ action: "computer", resource: "*", effect: "allow" }])
      expect(h.backend.sessions.get(cu)?.entries.has(RoleInstructions.OWNER)).toBe(false)
      const later = h.world.calls.slice(calls)
      expect(later.filter((call) => call.method === "session.approval.set").map((call) => call.input)).toEqual([
        { sessionID: cu, mode: "full" },
      ])
      expect(h.accounts.bindings.get(cu)?.team).toBeUndefined()
      // The owners never attached got nothing; no conversation was archived or deleted but the team main.
      const quiet = [repo.sessions.perf.id, repo.sessions.siwc.id]
      expect(
        h.fake.requests
          .slice(requests)
          .filter((request) => request.method !== "GET" && quiet.some((id) => request.path.includes(id))),
      ).toEqual([])
      for (const id of [cu, ...quiet]) expect(h.backend.sessions.get(id)?.metadata).toEqual({})
      expect(h.backend.sessions.get(team.main.sessionID)?.metadata).toEqual({ "own.archived": true })
      // Files and branches of the adopted folders are as they were; the registry is gone.
      for (const directory of adopted) expect(snapshot(directory)).toEqual(before[directory]!)
      expect(await h.services.registry.teams.get(teamID)).toBeUndefined()
      expect(await h.services.registry.areas.list(teamID)).toEqual([])
      // The touched new area stays with the user's file; its lock went.
      expect(snapshot(created.directory).files).toContain("node_modules/pkg/index.js")
      expect(await lockOf(repo.commonDir, created.directory)).toBeNull()
    },
    SLOW,
  )
})
