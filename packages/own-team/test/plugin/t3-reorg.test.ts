// The T3 wiring of reorganizations (06 §2.7, §3.8, §8.1–8.6; TG12 at plugin level): `reorg.apply` of each action
// (새 영역, 이름 바꾸기, 나누기, 묶기, 변환, 대화 옮기기, 끝내기) reaches `op.done` through the RPC groups, with each removal
// asked first; `op.undo` reverses a split, a conversion and a merge; `disable{cleanup}` asks every removal of the
// finished areas at once (an expired nonce or a changed list is asked again with a new nonce and list) and then turns
// the team off; `team.get` shows `끝낼 수 있음` 7 days after an area's last change; the main requests a retirement did not
// send and the actions skipped for their area reach the main's team update within 2k tokens; `reorg.propose` answers;
// `health.features` lists the T3 features. Fake plugin contexts over one world, the real runtime on a temp OWN_HOME, a
// manual clock, real git fixtures in temp folders and a fake own service on 127.0.0.1; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam, Preset } from "@own/protocol"
import { Controller } from "../../src/controller.js"
import { Worktree } from "../../src/git/worktree.js"
import type { Hub } from "../../src/hub.js"
import { Log } from "../../src/log.js"
import { Disable } from "../../src/ops/disable.js"
import { ReorgOps } from "../../src/ops/reorg.js"
import { Areas } from "../../src/registry/area.js"
import { Digest } from "../../src/report/digest.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { Services } from "../../src/services.js"
import { git, init, temp, write } from "../fixtures/repo.js"
import { manual, type Manual } from "../support/clock.js"
import { MAIN_SESSION, MODEL, TEAM_ID, World, area, buildId, call, context, team } from "../support/context.js"
import { removeTree } from "../support/remove.js"
import { type FakeService, session, start } from "../support/service.js"

/** Git process starts are slow on Windows. */
const SLOW = 600_000
const DAY = 24 * 60 * 60 * 1000
/** When the fixtures' commits are made (fixed, so the 7 days of 끝낼 수 있음 run on the manual clock). */
const MADE = Date.UTC(2026, 8, 20, 9, 0, 0)
const STAR = Preset.ID.create()

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The own service: conversations (location, metadata, an empty history), session create, moves, the judge call. */
class Backend {
  readonly service: FakeService = start()
  readonly sessions = new Map<string, { directory: string; metadata: Record<string, unknown> }>()
  readonly moves: Array<{ readonly sessionID: string; readonly directory: string }> = []
  /** What the team main's `session.generate` answers (팀 구성 다시 보기). */
  answer = JSON.stringify({ version: 1, notes: "지금 구성이 알맞습니다" })

  constructor() {
    const routes = this.service.routes
    routes.set("GET /api/session/active", () => Response.json({ data: {} }))
    routes.set("GET /api/session", () =>
      Response.json({
        data: [...this.sessions].map(([id, stored]) => session({ id, directory: stored.directory })),
        cursor: {},
      }),
    )
    routes.set("POST /api/worktree/refresh", () => new Response(null, { status: 204 }))
    routes.set("GET /api/shell", () => Response.json({ data: [] }))
    routes.set("GET /api/pty", () => Response.json({ data: [] }))
  }

  add(id: string, directory: string) {
    const stored = { directory, metadata: {} as Record<string, unknown> }
    this.sessions.set(id, stored)
    const at = `/api/session/${id}`
    const routes = this.service.routes
    routes.set(`GET ${at}`, () =>
      Response.json({ data: session({ id, directory: stored.directory, metadata: stored.metadata }) }),
    )
    routes.set(`PATCH ${at}`, (request) => {
      stored.metadata = { ...Schema.decodeUnknownSync(Patch)(request.body).metadata }
      return new Response(null, { status: 204 })
    })
    routes.set(`GET ${at}/inbox`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/permission`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/form`, () => Response.json({ data: [] }))
    routes.set(`GET ${at}/message`, () => Response.json({ data: [], cursor: {} }))
    routes.set(`GET /api/experimental/session/${id}/instructions/entries`, () => Response.json({ data: [] }))
    routes.set(`POST ${at}/generate`, () => Response.json({ data: { text: this.answer } }))
    return stored
  }

  /** core's `session.move` of an idle conversation: its location changes. */
  move(input: { readonly sessionID: string; readonly directory: string }) {
    this.moves.push({ sessionID: input.sessionID, directory: input.directory })
    const stored = this.sessions.get(input.sessionID)
    if (stored) stored.directory = input.directory
  }
}

const Patch = Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.Unknown) })
const Started = Schema.Struct({ opID: OwnTeam.OpID })
const Answered = Schema.Struct({ op: Schema.Struct({ id: OwnTeam.OpID }) })

/** Commits everything in `directory` dated {@link MADE} (author, committer and the reflog entry). */
function commitAt(directory: string, message: string) {
  const date = new Date(MADE).toISOString()
  git(directory, ["add", "-A"])
  git(directory, ["commit", "-q", "-m", message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
  return git(directory, ["rev-parse", "HEAD"]).trim()
}

interface AreaOptions {
  /** An owner conversation (registered without the team attached, so no LLM turn is ever asked of it). */
  readonly owner?: boolean
  /** A commit of its own (dated {@link MADE}). */
  readonly commit?: boolean
  /** That commit merged into `main`. */
  readonly merged?: boolean
  readonly shape?: OwnTeam.Area["shape"]
  readonly paused?: OwnTeam.Area["paused"]
}

async function setup(input: { readonly clock?: Manual } = {}) {
  const box = temp("own-team-t3-reorg-")
  cleanups.push(box.dispose)
  const home = init(path.join(box.root, "home"))
  write(home, {
    ".gitignore": "node_modules/\n",
    "README.md": "# t3\n",
    "src/app.ts": "export const app = 1\n",
    "assets/textures/rock.bin": "rock\n",
  })
  const base = commitAt(home, "base")
  const record: OwnTeam.Team = {
    ...team({ home }),
    heavy: { dirs: ["assets"], measuredAt: base, forcedBytes: 0 },
  }
  const backend = new Backend()
  cleanups.push(() => backend.service.stop())
  backend.add(MAIN_SESSION, home)
  const world = new World()
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [{ group: "codex", defaultModel: null, star: STAR }] }))
  world.accounts.set("session.preset.get", () => ({ binding: null }))
  world.accounts.set("session.preset.apply", () => ({}))
  /** Areas away from their safe point (8.4). */
  const busy = new Set<string>()
  /** Owner conversations the fake owner feature made. */
  const owners: string[] = []
  const features: Partial<Services.Factories> = {
    safePoint: () => ({
      check: async (check) =>
        busy.has(check.areaID ?? "") ? { ok: false, why: "session", sessionIDs: [] } : { ok: true },
    }),
    main: () => ({
      create: async () => Services.failure("internal_error", "not in this test", {}),
      model: async () => MODEL,
    }),
    // The owner of a new area: a conversation in its folder, recorded as the owner (sessions/owner.ts aside).
    owner: (services) => ({
      create: async (made) => {
        const found = await services.registry.areas.get(made.teamID, made.areaID)
        if (!found) return Services.failure("not_found", "no area", { what: "area", id: made.areaID })
        const sessionID = SessionID.create()
        backend.add(sessionID, found.directory)
        owners.push(sessionID)
        await services.write(made.teamID, async () => {
          const current = await services.registry.areas.get(made.teamID, made.areaID)
          if (current)
            await services.registry.areas.put({
              ...current,
              owner: { ...current.owner, sessionID, attached: true },
            })
        })
        return { ok: true, sessionID }
      },
      attach: async () => ({ ok: true }),
    }),
  }
  const clock = input.clock ?? manual(MADE)
  const own = temp("own-team-t3-home-")
  cleanups.push(own.dispose)
  const base0 = context(world, { directory: home }).ctx
  // The control instance moves a conversation the way core's `session.move` does (the test context has no `move`).
  const ctx: Plugin.Context = {
    ...base0,
    session: {
      ...base0.session,
      move: async (moved: { readonly sessionID: string; readonly directory: string }) => backend.move(moved),
    },
  } as Plugin.Context
  const controller = new Controller.Service({
    buildId: buildId("t3-reorg"),
    home: own.root,
    log: Log.silent,
    clock,
    source: backend.service.source,
    features,
  })
  const detach = controller.attach({ ctx, directory: home, control: true, leader: () => true })
  const published: Hub.Outgoing[] = []
  controller.hub.subscribe((event) => published.push(event))
  controller.start()
  cleanups.push(async () => {
    detach()
    await controller.close()
  })
  const services = controller.services
  // The plugin's RPC groups: they register the integrate and reorganization step kinds while it sets up.
  const handlers = TeamRpc.create({ services, leader: () => true, log: Log.silent })
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const registered = { definition: { methods: {} }, handlers, emitted: [], disposed: false } as never
  const rpc = (method: string, request: unknown) => call(registered, method, request)
  await services.write(TEAM_ID, () => services.registry.teams.put(record))

  const makeArea = async (slug: string, options: AreaOptions = {}) => {
    const areaID = Areas.id(slug)
    const directory = path.join(record.worktreeRoot, slug)
    const date = new Date(MADE).toISOString()
    git(home, ["worktree", "add", "-q", "--lock", "--reason", Worktree.lockReason(areaID), "-b", slug, directory], {
      env: { GIT_COMMITTER_DATE: date },
    })
    if (options.commit) {
      write(directory, { [`src/${slug}.ts`]: `export const ${slug.replace(/-/g, "_")} = 1\n` })
      commitAt(directory, slug)
    }
    if (options.merged) git(home, ["merge", "-q", "--no-ff", "--no-edit", slug], { env: { GIT_COMMITTER_DATE: date } })
    const owner = options.owner ? SessionID.create() : null
    if (owner !== null) backend.add(owner, directory)
    const made: OwnTeam.Area = {
      ...area({ slug, directory }),
      // Put in the team (팀에 넣기): only areas own made count against the area limit (V5).
      origin: "adopted",
      gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]).trim(),
      base: { sha: base, at: 0 },
      shape: options.shape ?? "plain",
      preset: STAR,
      owner: { sessionID: owner, previous: [], attached: false },
      paused: options.paused ?? false,
    }
    await services.write(TEAM_ID, () => services.registry.areas.put(made))
    return made
  }

  /** `reorg.apply{teamID, proposal}` (by the user): the op it started. */
  const apply = async (proposal: Omit<OwnTeam.Proposal, "version">) => {
    const answer = await rpc("reorg.apply", { teamID: TEAM_ID, proposal: { version: 1, ...proposal } })
    return started(answer)
  }

  /**
   * Waits (real time) until the op stops running; then answers each confirm with `choice` until it ends (a confirm
   * asked again, after its nonce expired, is answered with its new nonce).
   */
  const finish = async (opID: string, choice: "do" | "skip" | "none" = "do"): Promise<OwnTeam.Op> => {
    const op = await settled(opID)
    if (op.state !== "waiting" || choice === "none") return op
    const step = op.steps.find((item) => item.state === "needs_confirm")
    if (!step) return op
    const answered = await rpc("op.confirm", { opID, stepID: step.id, choice, nonce: step.confirm?.nonce })
    if (!Schema.is(Answered)(answered)) expect(answered).toMatchObject({ type: "nonce_invalid" })
    return finish(opID, choice)
  }

  const settled = async (opID: string) => {
    const deadline = Date.now() + 240_000
    for (;;) {
      const op = await services.journal.find(opID)
      if (op && op.state !== "running") return op
      if (Date.now() > deadline) throw new Error(`op ${opID} still runs`)
      await Bun.sleep(25)
    }
  }

  return {
    home,
    base,
    record,
    backend,
    world,
    busy,
    owners,
    clock,
    controller,
    services,
    published,
    rpc,
    makeArea,
    apply,
    finish,
    settled,
    areaOf: async (slug: string) => services.registry.areas.get(TEAM_ID, Areas.id(slug)),
  }
}

function started(answer: unknown) {
  const found = Schema.decodeUnknownOption(Started)(answer)
  if (found._tag === "None") throw new Error(`no op started: ${JSON.stringify(answer)}`)
  return found.value.opID
}

/** The worktree list entry of `directory` (its lock), or `undefined`. */
function listed(home: string, directory: string) {
  const output = git(home, ["worktree", "list", "--porcelain"])
  const block = output.split("\n\n").find((item) => item.startsWith(`worktree ${directory.replaceAll("\\", "/")}`))
  return block
}

describe("reorg.apply: each action reaches op.done (06 §8.2)", () => {
  test(
    "new, rename, split, merge (removal asked), convert, move and retire (removal asked), by the user",
    async () => {
      const h = await setup()
      const ui = await h.makeArea("ui", { owner: true, commit: true })
      const api = await h.makeArea("api", { owner: true, commit: true, merged: true })
      await h.makeArea("lab", { shape: "full" })
      const user = SessionID.create()
      h.backend.add(user, h.home)

      const made = await h.finish(await h.apply({ ops: [{ op: "new", slug: "docs", name: "문서" }] }))
      expect(made).toMatchObject({ kind: "reorg", by: "user", state: "done" })
      const docs = await h.areaOf("docs")
      expect(docs).toMatchObject({ state: "active", origin: "created", name: "문서" })
      expect(docs?.owner.sessionID).not.toBeNull()
      expect(fs.existsSync(docs!.directory)).toBe(true)

      const renamed = await h.finish(await h.apply({ ops: [{ op: "rename", area: "docs", name: "문서 작업" }] }))
      expect(renamed.state).toBe("done")
      expect((await h.areaOf("docs"))?.name).toBe("문서 작업")

      const split = await h.finish(
        await h.apply({ ops: [{ op: "split", area: "ui", slug: "ui-two", name: "화면 둘" }] }),
      )
      expect(split.state).toBe("done")
      const two = await h.areaOf("ui-two")
      expect(two).toMatchObject({ state: "active", preset: ui.preset })
      expect(git(h.home, ["rev-parse", "refs/heads/ui-two"]).trim()).toBe(
        git(h.home, ["rev-parse", "refs/heads/ui"]).trim(),
      )

      // 묶기: B's folder goes only after the user's answer (V11); its branch stays.
      const merged = await h.apply({ ops: [{ op: "merge", area: "ui", from: "ui-two" }] })
      const asked = await h.finish(merged, "none")
      expect(asked.state).toBe("waiting")
      expect(asked.steps.filter((step) => step.state === "needs_confirm").map((step) => step.kind)).toEqual([
        "retire-remove",
      ])
      expect(fs.existsSync(two!.directory)).toBe(true)
      const mergedDone = await h.finish(merged)
      expect(mergedDone.state).toBe("done")
      expect((await h.areaOf("ui-two"))?.state).toBe("retired")
      expect(fs.existsSync(two!.directory)).toBe(false)
      expect(git(h.home, ["branch", "--list", "ui-two"]).trim()).not.toBe("")

      const converted = await h.finish(await h.apply({ ops: [{ op: "convert", area: "lab", shape: "code" }] }))
      expect(converted.state).toBe("done")
      expect((await h.areaOf("lab"))?.shape).toBe("code")

      const moved = await h.finish(await h.apply({ ops: [{ op: "move", sessionID: user, area: "docs" }] }))
      expect(moved.state).toBe("done")
      expect(h.backend.moves).toEqual([{ sessionID: user, directory: docs!.directory }])
      expect(h.backend.sessions.get(user)?.metadata[OwnTeam.MOVED_META]).toMatchObject({ to: docs!.directory })

      const retired = await h.apply({ ops: [{ op: "retire", area: "api" }] })
      expect((await h.finish(retired, "none")).steps.find((step) => step.kind === "retire-remove")?.state).toBe(
        "needs_confirm",
      )
      expect((await h.finish(retired)).state).toBe("done")
      expect((await h.areaOf("api"))?.state).toBe("retired")
      expect(fs.existsSync(api.directory)).toBe(false)
      expect(listed(h.home, api.directory)).toBeUndefined()
      // Every op announced its end.
      const ends = h.published.flatMap((event) => (event.name === "op.done" ? [event.data.opID] : []))
      for (const opID of [made.id, renamed.id, split.id, mergedDone.id, converted.id, moved.id, retired])
        expect(ends).toContain(opID)
    },
    SLOW,
  )

  test(
    "op.undo of a reorganization: a split by retiring the new area, a conversion by converting back, a merge",
    async () => {
      const h = await setup()
      await h.makeArea("ui", { owner: true, commit: true })
      const b = await h.makeArea("save", { owner: true, commit: true })
      await h.makeArea("lab", { shape: "full" })

      const split = await h.finish(
        await h.apply({ ops: [{ op: "split", area: "ui", slug: "ui-two", name: "화면 둘" }] }),
      )
      const two = await h.areaOf("ui-two")
      const undoSplit = await h.finish(started(await h.rpc("op.undo", { opID: split.id })))
      expect(undoSplit).toMatchObject({ kind: "undo", state: "done" })
      expect((await h.areaOf("ui-two"))?.state).toBe("retired")
      expect(fs.existsSync(two!.directory)).toBe(false)
      // An undo is done once.
      expect(await h.rpc("op.undo", { opID: split.id })).toMatchObject({ type: "unsupported" })

      const converted = await h.finish(await h.apply({ ops: [{ op: "convert", area: "lab", shape: "code" }] }))
      expect((await h.areaOf("lab"))?.shape).toBe("code")
      // code → full writes the heavy folders: it asks first, and the conversion waits behind the ask.
      const back = started(await h.rpc("op.undo", { opID: converted.id }))
      expect((await h.finish(back, "none")).steps.map((step) => [step.kind, step.state])).toEqual([
        ["convert-confirm", "needs_confirm"],
        ["convert-to-full", "pending"],
        ["undo.mark", "pending"],
      ])
      expect((await h.finish(back)).state).toBe("done")
      expect((await h.areaOf("lab"))?.shape).toBe("full")

      // 묶기 with 두기 for B's folder: the undo puts A back at A_old and registers B again.
      const before = git(h.home, ["rev-parse", "refs/heads/ui"]).trim()
      const merged = await h.finish(await h.apply({ ops: [{ op: "merge", area: "ui", from: "save" }] }), "skip")
      expect(merged.state).toBe("done")
      expect(git(h.home, ["rev-parse", "refs/heads/ui"]).trim()).not.toBe(before)
      expect((await h.areaOf("save"))?.state).toBe("retired")
      const unmerged = await h.finish(started(await h.rpc("op.undo", { opID: merged.id })))
      expect(unmerged.state).toBe("done")
      expect(git(h.home, ["rev-parse", "refs/heads/ui"]).trim()).toBe(before)
      expect((await h.areaOf("save"))?.state).toBe("active")
      expect(fs.existsSync(b.directory)).toBe(true)
    },
    SLOW,
  )

  test(
    "다시 만들기 (8.2, 8.8): a missing folder's area and a merged B whose undo is gone come back from their branches",
    async () => {
      const h = await setup()
      const ui = await h.makeArea("ui", { owner: true, commit: true })
      await h.makeArea("save", { owner: true, commit: true })
      const lost = await h.makeArea("lost", { commit: true })
      // `lost`'s folder is gone (8.8 찾을 수 없음): the record stops, the branch stays.
      await removeTree(lost.directory, 20, 250)
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({
          ...lost,
          state: "broken",
          broken: { why: "missing", at: MADE },
          status: { kind: "broken", at: MADE, text: "" },
        }),
      )
      const lostTip = git(h.home, ["rev-parse", "refs/heads/lost"]).trim()

      const again = await h.finish(
        await h.apply({ ops: [{ op: "new", slug: "lost", name: lost.name, goal: "다시", from: "lost" }] }),
      )
      expect(again).toMatchObject({ kind: "reorg", by: "user", state: "done" })
      const remade = await h.areaOf("lost-2")
      expect(remade).toMatchObject({ state: "active", origin: "created", name: lost.name, branch: "lost-2" })
      expect(remade?.owner.sessionID).not.toBeNull()
      expect(git(h.home, ["rev-parse", "refs/heads/lost-2"]).trim()).toBe(lostTip)
      expect(fs.existsSync(path.join(remade!.directory, "src/lost.ts"))).toBe(true)
      // The old record stays until the user ends it (끝내기); its branch is untouched.
      expect((await h.areaOf("lost"))?.state).toBe("broken")
      expect(git(h.home, ["rev-parse", "refs/heads/lost"]).trim()).toBe(lostTip)

      // 묶기 (두기 for B's folder), then A moves on: the undo answers conflict and only 다시 만들기 of B is left.
      const merged = await h.finish(await h.apply({ ops: [{ op: "merge", area: "ui", from: "save" }] }), "skip")
      expect(merged.state).toBe("done")
      const saveTip = git(h.home, ["rev-parse", "refs/heads/save"]).trim()
      write(ui.directory, { "src/later.ts": "export const later = 1\n" })
      commitAt(ui.directory, "later")
      expect(await h.rpc("op.undo", { opID: merged.id })).toMatchObject({ type: "conflict" })
      const back = await h.finish(await h.apply({ ops: [{ op: "new", slug: "save", name: "save", from: "save" }] }))
      expect(back.state).toBe("done")
      expect(await h.areaOf("save-2")).toMatchObject({ state: "active", branch: "save-2" })
      expect(git(h.home, ["rev-parse", "refs/heads/save-2"]).trim()).toBe(saveTip)
      expect((await h.areaOf("save"))?.state).toBe("retired")
      // A new area's undo removes it while untouched; the old records stay as they were.
      expect((await h.finish(started(await h.rpc("op.undo", { opID: back.id })))).state).toBe("done")
      expect(await h.areaOf("save-2")).toBeUndefined()
      expect((await h.areaOf("save"))?.state).toBe("retired")
    },
    SLOW,
  )
})

describe("끝난 영역 정리하고 끄기 (06 §3.8)", () => {
  test(
    "one op asks every removal at once; an expired nonce and a changed list are asked again; then the team goes off",
    async () => {
      const h = await setup()
      const done = await h.makeArea("done", { owner: true, commit: true, merged: true })
      const shipped = await h.makeArea("shipped", { commit: true, merged: true })
      const open = await h.makeArea("open", { owner: true, commit: true })

      const opID = started(await h.rpc("disable", { teamID: TEAM_ID, cleanup: true }))
      const waiting = await h.finish(opID, "none")
      expect(waiting).toMatchObject({ kind: "disable", state: "waiting" })
      expect(waiting.steps[0]?.kind).toBe("disable.cleanup")
      const got = (await h.rpc("team.get", { directory: h.home })) as { readonly pending: OwnTeam.Confirm[] }
      // One bundled dialog: both removals wait together, each bound to its own list.
      expect(got.pending.map((item) => [item.kind, item.stepID])).toEqual([
        ["retire-remove", `retire:${done.id}:remove`],
        ["retire-remove", `retire:${shipped.id}:remove`],
      ])
      expect(got.pending.every((item) => item.manifest !== undefined)).toBe(true)

      // An expired nonce: refused, and the confirm is asked again with a new nonce.
      const first = got.pending[0]!
      h.clock.advance(11 * 60 * 1000)
      expect(await h.rpc("op.confirm", { opID, stepID: first.stepID, choice: "do", nonce: first.nonce })).toMatchObject(
        { type: "nonce_invalid" },
      )
      const renewed = (await h.services.journal.find(opID))!.steps.find((step) => step.id === first.stepID)!
      expect(renewed.confirm?.nonce).not.toBe(first.nonce)
      expect(renewed.confirm?.manifest).toBe(first.manifest)

      // The list changed after it was shown: asked again with the new list; nothing is deleted.
      write(done.directory, { "node_modules/late/index.js": "late\n" })
      expect(
        await h.rpc("op.confirm", { opID, stepID: first.stepID, choice: "do", nonce: renewed.confirm?.nonce }),
      ).toMatchObject({ type: "nonce_invalid" })
      const relisted = (await h.services.journal.find(opID))!.steps.find((step) => step.id === first.stepID)!
      expect(relisted.confirm?.manifest).not.toBe(first.manifest)
      expect(relisted.confirm?.files?.some((file) => file.path.includes("node_modules"))).toBe(true)
      expect(fs.existsSync(done.directory)).toBe(true)

      const ended = await h.finish(opID)
      expect(ended.state).toBe("done")
      expect(fs.existsSync(done.directory)).toBe(false)
      expect(fs.existsSync(shipped.directory)).toBe(false)
      expect((await h.areaOf("done"))?.state).toBe("retired")
      // Then the disable op turns the team off; the unfinished area stays, its lock released.
      const deadline = Date.now() + 120_000
      while ((await h.services.registry.teams.get(TEAM_ID))?.state !== "off") {
        if (Date.now() > deadline) throw new Error("the team stayed on")
        await Bun.sleep(25)
      }
      const ops = await h.services.journal.list(TEAM_ID)
      expect(ops.at(-1)).toMatchObject({ kind: "disable" })
      await h.settled(ops.at(-1)!.id)
      expect((await h.areaOf("open"))?.state).toBe("active")
      expect(fs.existsSync(open.directory)).toBe(true)
      expect(listed(h.home, open.directory)).not.toContain("locked")
    },
    SLOW,
  )

  test(
    "`areas` (a voice plan's list, 06 §2.9) retires only the finished areas it names",
    async () => {
      const h = await setup()
      const done = await h.makeArea("done", { owner: true, commit: true, merged: true })
      const shipped = await h.makeArea("shipped", { commit: true, merged: true })
      await h.makeArea("open", { owner: true, commit: true })
      const team = (await h.services.registry.teams.get(TEAM_ID))!
      expect((await Disable.finished(h.services, team)).map((item) => item.id)).toEqual([done.id, shipped.id])

      const started = await Disable.start(h.services, { teamID: TEAM_ID, cleanup: true, areas: [done.id] })
      if (!started.ok) throw new Error(started.message)
      const waiting = await h.finish(started.opID, "none")
      expect(waiting.steps[0]).toMatchObject({ kind: "disable.cleanup", args: { areaIDs: [done.id] } })
      expect(waiting.steps.filter((step) => step.state === "needs_confirm").map((step) => step.id)).toEqual([
        `retire:${done.id}:remove`,
      ])
      expect((await h.finish(started.opID)).state).toBe("done")
      expect((await h.areaOf("done"))?.state).toBe("retired")
      expect((await h.areaOf("shipped"))?.state).toBe("active")
      expect(fs.existsSync(shipped.directory)).toBe(true)
    },
    SLOW,
  )
})

describe("removals at plugin level (06 §8.2, §8.6, §3.8)", () => {
  test(
    "끝내기 of an area with unapplied save points carries the count in its removal step (the dialog's 남는 것 line)",
    async () => {
      const h = await setup()
      const open = await h.makeArea("open", { owner: true, commit: true })
      const opID = await h.apply({ ops: [{ op: "retire", area: "open" }] })
      const waiting = await h.finish(opID, "none")
      expect(waiting.state).toBe("waiting")
      const removal = waiting.steps.find((step) => step.kind === "retire-remove")
      expect(removal).toMatchObject({ state: "needs_confirm", args: { areaID: open.id, unapplied: 1 } })
      expect(removal?.confirm?.text).not.toContain("반영하지 않은 저장 지점")
      const got = (await h.rpc("team.get", { directory: h.home })) as { readonly op: OwnTeam.Op | null }
      expect(got.op?.steps.find((step) => step.kind === "retire-remove")?.args).toEqual({
        areaID: open.id,
        unapplied: 1,
      })
    },
    SLOW,
  )

  test(
    "끝난 영역 정리하고 끄기 where one folder cannot go now: the other removal is still answered, then the team goes off",
    async () => {
      const h = await setup()
      const held = await h.makeArea("held", { owner: true, commit: true, merged: true })
      const shipped = await h.makeArea("shipped", { commit: true, merged: true })
      const opID = started(await h.rpc("disable", { teamID: TEAM_ID, cleanup: true }))
      const waiting = await h.finish(opID, "none")
      expect(waiting.state).toBe("waiting")
      // Something works in the first folder when its removal is answered (TI-3 (c)): that removal fails alone.
      h.busy.add(held.id)
      const step = (id: OwnTeam.AreaID) => waiting.steps.find((item) => item.id === `retire:${id}:remove`)!
      const first = await h.rpc("op.confirm", {
        opID,
        stepID: step(held.id).id,
        choice: "do",
        nonce: step(held.id).confirm?.nonce,
      })
      expect(first).toMatchObject({ op: { state: "waiting" } })
      // The other removal is still asked with its own nonce, and goes.
      const second = await h.rpc("op.confirm", {
        opID,
        stepID: step(shipped.id).id,
        choice: "do",
        nonce: step(shipped.id).confirm?.nonce,
      })
      expect(second).toMatchObject({ op: { state: "failed" } })
      const ended = (await h.services.journal.find(opID))!
      expect(ended.steps.find((item) => item.id === `retire:${held.id}:remove`)?.state).toBe("failed")
      expect(fs.existsSync(held.directory)).toBe(true)
      expect(fs.existsSync(shipped.directory)).toBe(false)
      // The cleanup ended: the team goes off; the folder left keeps no own lock (removable by hand).
      const deadline = Date.now() + 120_000
      while ((await h.services.registry.teams.get(TEAM_ID))?.state !== "off") {
        if (Date.now() > deadline) throw new Error("the team stayed on")
        await Bun.sleep(25)
      }
      const disabled = (await h.services.journal.list(TEAM_ID)).at(-1)!
      await h.settled(disabled.id)
      expect(listed(h.home, held.directory)).not.toContain("locked")
      // own's check folders are released with the areas (9.7 how to undo `.assets`).
      expect(disabled.steps.map((item) => item.id)).toEqual(
        expect.arrayContaining(["release:verify", "release:assets"]),
      )
    },
    SLOW,
  )
})

describe("끝낼 수 있음 (06 §8.1)", () => {
  test(
    "team.get shows an integrated, clean area as retirable 7 days after its last change (facts read again daily)",
    async () => {
      const h = await setup()
      const done = await h.makeArea("done", { owner: true, commit: true, merged: true })
      await h.makeArea("open", { owner: true, commit: true })
      await h.controller.resume()
      const view = async () =>
        ((await h.rpc("team.get", { directory: h.home })) as { readonly areas: OwnTeam.AreaView[] }).areas
      expect((await view()).every((item) => item.retirable === undefined)).toBe(true)

      h.clock.advance(6 * DAY)
      await Bun.sleep(50)
      expect((await view()).every((item) => item.retirable === undefined)).toBe(true)

      h.clock.advance(DAY + 60 * 60 * 1000)
      const deadline = Date.now() + 60_000
      for (;;) {
        const areas = await view()
        if (areas.some((item) => item.retirable !== undefined)) {
          expect(areas.find((item) => item.id === done.id)?.retirable).toEqual({ since: MADE })
          expect(areas.find((item) => item.id === Areas.id("open"))?.retirable).toBeUndefined()
          break
        }
        if (Date.now() > deadline) throw new Error("not retirable")
        await Bun.sleep(25)
      }
      // A signal only: nothing was retired.
      expect((await h.areaOf("done"))?.state).toBe("active")
      expect(fs.existsSync(done.directory)).toBe(true)
    },
    SLOW,
  )
})

describe("the main's team update after a reorganization (06 §5.6, §8.1, §8.2)", () => {
  test(
    "unsent main requests of a retirement and actions skipped for their area are folded in, within 2k tokens",
    async () => {
      const h = await setup()
      // Under Main 멈춤 its requests wait (5.3); the user's 끝내기 goes on (TI-13).
      const done = await h.makeArea("done", { owner: true, commit: true, merged: true, paused: "user" })
      await h.makeArea("held", { owner: true, commit: true, paused: "user" })
      const now = h.clock.now()
      const requests = ["정렬을 고치세요", "테스트를 더하세요"].map(
        (text, seq): OwnTeam.Dispatch => ({
          id: OwnTeam.DispatchID.create(),
          teamID: TEAM_ID,
          areaID: done.id,
          seq,
          from: "main",
          kind: "task",
          text,
          ...(seq === 0 ? { task: "정렬" } : {}),
          state: "waiting",
          createdAt: now,
        }),
      )
      await h.services.write(TEAM_ID, async () => {
        for (const item of requests) await h.services.registry.dispatches.put(item)
      })

      // The main's 끝내기 of a paused area is skipped (TI-13); the user's 끝내기 of `done` cancels its requests.
      const skipped = await ReorgOps.apply(h.services, {
        teamID: TEAM_ID,
        proposal: { version: 1, ops: [{ op: "retire", area: "held" }] },
        by: "main",
      })
      if (!skipped.ok) throw new Error(skipped.message)
      await h.finish(skipped.op.id)
      await h.finish(await h.apply({ ops: [{ op: "retire", area: "done" }] }))

      const text = await h.services.features().digest.render({ teamID: TEAM_ID })
      expect(text).toContain("정리에서 건너뛴 영역: 'held'(메인 멈춤)")
      expect(text).toContain("보내지 않은 메인 요청 2개: 'done' \"정렬\", 'done' \"테스트를 더하세요\"")
      expect(text).toContain("done: 영역을 끝냈습니다 · 기다리던 메인 요청 2개를 보내지 않았습니다")
      expect(Digest.tokens(text)).toBeLessThanOrEqual(Digest.MAX_TOKENS)
      // Folded, never a wake-up (5.6).
      expect(h.backend.service.requests.some((item) => item.path.endsWith("/synthetic"))).toBe(false)
    },
    SLOW,
  )
})

describe("the T3 groups (06 §2.7)", () => {
  test("reorg.propose answers a stored proposal and health lists the T3 features", async () => {
    const h = await setup()
    await h.makeArea("ui", { owner: true, commit: true })
    const proposed = (await h.rpc("reorg.propose", { teamID: TEAM_ID, hint: "구성을 다시 보세요" })) as {
      readonly proposalID: string
      readonly proposal: OwnTeam.Proposal
      readonly plan: OwnTeam.Plan
    }
    expect(proposed.proposalID).toMatch(/^rp_/)
    expect(proposed.proposal.notes).toBe("지금 구성이 알맞습니다")
    expect(await ReorgOps.stored(h.services, TEAM_ID, proposed.proposalID)).toEqual(proposed.proposal)
    const health = (await h.rpc("health", {})) as OwnTeam.Health
    expect(health.features).toEqual(
      expect.arrayContaining([
        "reorg.new",
        "reorg.rename",
        "reorg.split",
        "reorg.merge",
        "reorg.retire",
        "reorg.convert",
        "reorg.move",
        "cleanup",
        "assets",
        "shared",
      ]),
    )
    expect(new Set(health.features).size).toBe(health.features.length)
  })
})
