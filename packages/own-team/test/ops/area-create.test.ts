// New areas (06 §3.6, §4.5, §8.2 새 영역, TG2 creation part, TG3 plugin path, TG15): `AreaCreate.plan` turns one area
// into op steps (branch create-only, the code-only or plain worktree locked as `own.team area:<id>`, worktree.refresh,
// the registry record with `팀과 같게` and the group's ★, the owner, the setup command as an op step whose exit code and
// log land in the team records folder). Git fixtures in temp folders, a fake loopback service, fake own.accounts.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { OwnTeam, Preset } from "@own/protocol"
import { Home } from "../../src/git/home.js"
import { Identity } from "../../src/git/identity.js"
import { Porcelain } from "../../src/git/porcelain.js"
import { AreaCreate } from "../../src/ops/area-create.js"
import { Keys } from "../../src/registry/keys.js"
import { Teams } from "../../src/registry/team.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import type { Services } from "../../src/services.js"
import { commit, f1, files, git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, MODEL, TEAM_ID, World, controller, team } from "../support/context.js"
import { type FakeService, session, start } from "../support/service.js"

/** Git-heavy tests: Windows process starts are slow on a busy machine. */
const SLOW = 180_000

const box = temp("own-team-area-")
const services: FakeService[] = []
afterAll(() => box.dispose())
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})

const STAR = Preset.ID.create()

/** A fake service with sessions (create adopts an id, instruction entries per session) and `worktree.refresh`. */
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

function accounts(world: World) {
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: "openai" }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [{ group: "codex", defaultModel: null, star: STAR }] }))
  world.accounts.set("session.approval.set", (call) => ({ mode: (call as { mode: string }).mode, patched: [] }))
  world.accounts.set("session.preset.apply", () => ({ binding: {}, resolution: null, entry: "written", dryRun: false }))
}

interface Setup {
  readonly home: string
  readonly heavy?: ReadonlyArray<string>
  readonly setup?: OwnTeam.Command | null
  readonly root?: string
}

function harness(input: Setup) {
  const world = new World()
  accounts(world)
  const fake = fakeService()
  fake.add({ id: MAIN_SESSION, directory: input.home, model: MODEL })
  const clock = manual()
  const record: OwnTeam.Team = {
    ...team({ home: input.home }),
    commonDir: path.join(input.home, ".git"),
    worktreeRoot: input.root ?? `${input.home}-team`,
    heavy: { dirs: [...(input.heavy ?? [])], measuredAt: null, forcedBytes: 0 },
    commands: { setup: input.setup ?? null, code: [], assets: [] },
  }
  const h = controller(world, { directory: input.home, clock, source: fake.service.source })
  return { ...h, world, clock, fake, team: record }
}

async function begin(input: Setup) {
  const h = harness(input)
  await h.services.write(TEAM_ID, () => h.services.registry.teams.put(h.team))
  return h
}

/** Plans one area and runs its steps as an op to the end; `ids` names the steps like enable does (`area:<slug>:n`). */
async function make(services: Services.Context, plan: Omit<Services.AreaPlan, "by">, ids?: string) {
  const planned = await services.features().areas.plan({ ...plan, by: "user" })
  if (!planned.ok) throw new Error(`${planned.error}: ${planned.message}`)
  const started = await services.runner.start({
    teamID: TEAM_ID,
    kind: "reorg",
    by: "user",
    steps: AreaCreate.order(planned.steps).map((spec, index) =>
      ids === undefined ? spec : { ...spec, id: `${ids}:${index + 1}` },
    ),
  })
  if (!started.ok) throw new Error("busy")
  await services.runner.settled(started.op.id)
  const op = await services.journal.get(TEAM_ID, started.op.id)
  if (!op) throw new Error("op is gone")
  return { planned, op }
}

async function areaOf(services: Services.Context, areaID: string) {
  const area = await services.registry.areas.get(TEAM_ID, areaID)
  if (!area) throw new Error(`no area ${areaID}`)
  return area
}

function lockOf(home: string, directory: string) {
  return Porcelain.worktrees(git(home, ["worktree", "list", "--porcelain", "-z"])).find((item) =>
    Identity.same(item.path, directory),
  )?.locked
}

describe("plain areas (F1, no heavy folders)", () => {
  const repo = f1(path.join(box.root, "f1"))

  test(
    "branch at the target tip, locked worktree, refresh, record (팀과 같게, ★), owner on the team main's Ref",
    async () => {
      const h = await begin({ home: repo.home })
      const { planned, op } = await make(h.services, {
        team: h.team,
        slug: "inventory-ui",
        name: "인벤토리 화면",
        goal: "정렬 버그",
      })
      expect(planned.areaID).toBe(OwnTeam.AreaID.make("ar_inventory-ui"))
      expect(planned.steps.map((step) => step.kind)).toEqual([
        "branch-create",
        "worktree-create",
        "area-record",
        "owner-create",
      ])
      expect(op.state).toBe("done")
      expect(op.summary?.lines).toEqual([{ kind: "area", areaID: planned.areaID, change: "created" }])

      const directory = path.join(h.team.worktreeRoot, "inventory-ui")
      expect(git(repo.home, ["rev-parse", "refs/heads/inventory-ui"]).trim()).toBe(repo.head)
      expect(lockOf(repo.home, directory)).toBe("own.team area:ar_inventory-ui")
      expect(files(directory)).toEqual(files(repo.home))
      expect(git(directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("")

      const area = await areaOf(h.services, planned.areaID)
      expect(area).toMatchObject({
        name: "인벤토리 화면",
        goal: "정렬 버그",
        origin: "created",
        state: "active",
        branch: "inventory-ui",
        shape: "plain",
        base: { sha: repo.head },
        preset: STAR,
        paused: false,
        status: { kind: "idle" },
        handoff: null,
      })
      expect(area.main).toBeUndefined()
      expect(Identity.same(area.directory, directory)).toBe(true)
      expect(Identity.same(area.gitDir, path.join(repo.home, ".git", "worktrees", "inventory-ui"))).toBe(true)
      expect(area.owner.sessionID).not.toBeNull()
      expect(area.owner.pending).toBeUndefined()

      const refresh = h.fake.service.requests.find((request) => request.path === "/api/worktree/refresh")
      expect(refresh?.body).toEqual({ projectID: "prj_test" })
      const owner = h.fake.service.requests.find(
        (request) => request.method === "POST" && request.path === "/api/session",
      )
      expect(owner?.body).toMatchObject({ title: "인벤토리 화면 · 담당", model: MODEL, location: { directory } })
      // own.accounts calls: never computerUse.
      expect(
        h.world.calls
          .filter((call) => call.method === "session.approval.set")
          .map((call) => Object.keys(call.input as object)),
      ).toEqual([["sessionID", "mode"]])
      await h.close()
    },
    SLOW,
  )

  test(
    "a taken branch or folder gets -2; `from` starts at another area's tip; a resumed op observes, not repeats",
    async () => {
      const h = await begin({ home: repo.home })
      git(repo.home, ["branch", "docs", repo.head])
      const docs = await make(h.services, { team: h.team, slug: "docs", name: "문서" })
      expect(docs.planned.areaID).toBe(OwnTeam.AreaID.make("ar_docs-2"))
      const docsArea = await areaOf(h.services, docs.planned.areaID)
      expect(docsArea.branch).toBe("docs-2")
      expect(path.basename(docsArea.directory)).toBe("docs-2")

      // A commit in docs-2, then a new area from it.
      write(docsArea.directory, { "docs/more.md": "more\n" })
      const tip = commit(docsArea.directory, "more docs")
      const next = await make(h.services, { team: h.team, slug: "docs-review", name: "문서 검토", from: "docs-2" })
      expect((await areaOf(h.services, next.planned.areaID)).base.sha).toBe(tip)

      // The same steps again (a restart after the op was done): every step observes its effect and does nothing.
      const again = await h.services.runner.start({
        teamID: TEAM_ID,
        kind: "reorg",
        by: "user",
        steps: next.planned.steps,
      })
      if (!again.ok) throw new Error("busy")
      await h.services.runner.settled(again.op.id)
      const op = await h.services.journal.get(TEAM_ID, again.op.id)
      expect(op?.state).toBe("done")
      expect(op?.summary).toBeUndefined()
      expect(
        h.fake.service.requests.filter((request) => request.method === "POST" && request.path === "/api/session"),
      ).toHaveLength(2)
      await h.close()
    },
    SLOW,
  )

  test(
    "refusals: a '#' root, a root inside a worktree, an invalid slug, an unknown `from` area",
    async () => {
      const hash = harness({ home: repo.home, root: path.join(box.root, "#team") })
      expect(
        await hash.services.features().areas.plan({ team: hash.team, slug: "x", name: "x", by: "user" }),
      ).toMatchObject({
        ok: false,
        error: "path_forbidden",
        data: { why: "hash" },
      })
      await hash.close()
      // A root inside the main folder that is not its `.worktrees` (06 §4.12: only that one may hold areas).
      const nested = harness({ home: repo.home, root: path.join(repo.home, "areas") })
      expect(
        await nested.services.features().areas.plan({ team: nested.team, slug: "x", name: "x", by: "user" }),
      ).toMatchObject({ ok: false, error: "path_forbidden", data: { why: "nested" } })
      expect(
        await nested.services.features().areas.plan({ team: nested.team, slug: "Not A Slug", name: "x", by: "user" }),
      ).toMatchObject({ ok: false, error: "path_forbidden", data: { why: "invalid" } })
      await nested.close()
      const h = harness({ home: repo.home })
      expect(
        await h.services.features().areas.plan({ team: h.team, slug: "x", name: "x", from: "nowhere", by: "user" }),
      ).toMatchObject({ ok: false, error: "not_found", data: { what: "area" } })
      // No team main model (팀과 같게 has nothing to follow): the plan stops before anything is made.
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(h.team))
      h.fake.service.routes.delete(`GET /api/session/${MAIN_SESSION}`)
      expect(await h.services.features().areas.plan({ team: h.team, slug: "x", name: "x", by: "user" })).toMatchObject({
        ok: false,
        error: "internal_error",
      })
      expect(fs.existsSync(path.join(h.team.worktreeRoot, "x"))).toBe(false)
      expect(() => git(repo.home, ["rev-parse", "--verify", "refs/heads/x"])).toThrow()
      await h.close()
    },
    SLOW,
  )
})

describe("code-only areas (heavy folders)", () => {
  const home = init(path.join(box.root, "heavy", "home"))
  write(home, {
    "README.md": "# heavy\n",
    "src/app.ts": "export const app = 1\n",
    "docs/guide.md": "guide\n",
    "assets/textures/a.bin": "a".repeat(64),
    "assets/textures/b.bin": "b".repeat(64),
    "assets/ui/button.png": "png",
  })
  const tip = commit(home, "heavy")

  test(
    "the complement cone, heavy folders collapsed, `needs` inside heavy folders added and recorded",
    async () => {
      const h = await begin({ home, heavy: ["assets"] })
      const { planned, op } = await make(h.services, {
        team: h.team,
        slug: "ui",
        name: "UI",
        needs: ["assets/ui", "src", "../outside", "-x"],
      })
      expect(op.state).toBe("done")
      const area = await areaOf(h.services, planned.areaID)
      expect(area.shape).toBe("code")
      expect(Object.keys(area.cone.extra)).toEqual(["assets/ui"])
      expect(area.cone.extra["assets/ui"]).toMatchObject({ reason: "영역을 만들 때 필요", bytes: 0 })
      expect(git(area.directory, ["sparse-checkout", "list"]).trim().split("\n")).toEqual(["assets/ui", "docs", "src"])
      expect(files(area.directory)).toEqual(["README.md", "assets/ui/button.png", "docs/guide.md", "src/app.ts"])
      expect(git(area.directory, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
      expect(area.base.sha).toBe(tip)
      await h.close()
    },
    SLOW,
  )
})

describe("영역 만들기: the user's model, 에이전트 방식 and mark (2026-10-26)", () => {
  const repo = f1(path.join(box.root, "made"))
  const CLAUDE_STAR = Preset.ID.create()
  const CLAUDE = Schema.decodeUnknownSync(Model.Ref)({ providerID: "anthropic", id: "claude-opus", variant: "high" })
  const SECOND = Schema.decodeUnknownSync(Model.Ref)({ providerID: "openai-2", id: "gpt-test" })

  /** The team on ChatGPT 01, a Claude subscription, and another ChatGPT subscription (06 §10.1 R4). */
  function subscriptions(world: World) {
    world.accounts.set("accounts.list", () => ({
      revision: 1,
      accounts: [
        { id: "acc_01", kind: "codex", providerID: "openai", label: "ChatGPT 01", billing: "subscription" },
        { id: "acc_02", kind: "codex", providerID: "openai-2", label: "ChatGPT 02", billing: "subscription" },
        { id: "acc_c1", kind: "claude-sub", providerID: "anthropic", label: "Claude", billing: "subscription" },
      ],
    }))
    world.accounts.set("presets.list", () => ({
      groups: [
        { group: "codex", defaultModel: null, star: STAR, presets: [] },
        { group: "claude-sub", defaultModel: null, star: CLAUDE_STAR, presets: [] },
      ],
    }))
  }

  test(
    "the record holds the model (chosen by the user), its group's ★ and the mark; the owner starts on the 에이전트 방식",
    async () => {
      const h = await begin({ home: repo.home })
      subscriptions(h.world)
      const { planned, op } = await make(h.services, {
        team: h.team,
        slug: "monster-assets",
        name: "몬스터 에셋",
        goal: "몬스터 그림",
        main: CLAUDE,
        harness: { id: "pi", prompt: "own" },
        userMade: true,
      })
      expect(op.state).toBe("done")
      const area = await areaOf(h.services, planned.areaID)
      expect(area.main).toEqual({ model: CLAUDE, chosenBy: "user" })
      expect(area.preset).toBe(CLAUDE_STAR)
      expect(area.userMade?.at).toBeNumber()
      const owner = h.fake.service.requests.find(
        (request) => request.method === "POST" && request.path === "/api/session",
      )
      expect(owner?.body).toMatchObject({
        model: CLAUDE,
        metadata: { "own.harness": { id: "pi", v: 1, prompt: "own" }, "own.team": { role: "owner" } },
      })
      // Without the user's choices nothing of them is written: 팀과 같게, the team's ★, no mark, the default 방식.
      const plain = await make(h.services, { team: h.team, slug: "items", name: "아이템" })
      const item = await areaOf(h.services, plain.planned.areaID)
      expect(item.main).toBeUndefined()
      expect(item.userMade).toBeUndefined()
      expect(item.preset).toBe(STAR)
      const second = h.fake.service.requests
        .filter((request) => request.method === "POST" && request.path === "/api/session")
        .at(-1)
      expect(JSON.stringify(second?.body)).not.toContain("own.harness")
      await h.close()
    },
    SLOW,
  )

  test(
    "the team main binds the grown team context once the record is made (no area Location boots to sync it)",
    async () => {
      const h = await begin({ home: repo.home })
      subscriptions(h.world)
      h.world.accounts.set("session.preset.get", () => ({
        binding: null,
        preset: Preset.builtin("codex"),
        resolution: { main: MODEL, roles: {} },
        caps: Preset.CAPS,
        counts: { running: 0, message: 0, session: 0 },
        spend: 0,
      }))
      // The controller's start bound the main with the team as it was (no binding here, so every sync applies).
      await h.controller.resume()
      const before = h.world.calls.length
      const { op } = await make(h.services, { team: h.team, slug: "claude-side", name: "클로드 쪽", main: CLAUDE })
      expect(op.state).toBe("done")
      const applied = h.world.calls
        .slice(before)
        .filter(
          (call) =>
            call.method === "session.preset.apply" &&
            (call.input as { readonly sessionID?: string }).sessionID === MAIN_SESSION,
        )
      expect(applied.map((call) => call.input)).toEqual([
        {
          sessionID: MAIN_SESSION,
          presetID: Preset.builtinID("codex"),
          team: { teamID: TEAM_ID, role: "main", accounts: ["acc_01", "acc_c1"], pinned: [] },
        },
      ])
      await h.close()
    },
    SLOW,
  )

  test(
    "another subscription of the team main's company refuses the item when it is planned (team R4)",
    async () => {
      const h = await begin({ home: repo.home })
      subscriptions(h.world)
      const planned = await h.services
        .features()
        .areas.plan({ team: h.team, slug: "rival", name: "rival", main: SECOND, by: "user" })
      expect(planned).toMatchObject({
        ok: false,
        error: "invalid_proposal",
        data: { rejected: [{ why: AreaCreate.SAME_COMPANY }] },
      })
      // Nothing was made.
      expect(await h.services.registry.areas.list(TEAM_ID)).toEqual([])
      expect(git(repo.home, ["branch", "--list", "rival"]).trim()).toBe("")
      await h.close()
    },
    SLOW,
  )
})

describe("areas inside the main folder (프로젝트 안, 06 §4.12, 2026-10-27)", () => {
  const repo = f1(path.join(box.root, "inside"))
  const root = path.join(repo.home, ".worktrees")

  test(
    "<home>/.worktrees/<slug>: ignored through info/exclude, the home's status stays clean, the identity guards hold",
    async () => {
      const h = await begin({ home: repo.home, root })
      const homeFiles = files(repo.home)
      const { planned, op } = await make(h.services, { team: h.team, slug: "monster-assets", name: "몬스터 에셋" })
      expect(op.state).toBe("done")
      const area = await areaOf(h.services, planned.areaID)
      expect(Identity.same(area.directory, path.join(root, "monster-assets"))).toBe(true)
      expect(lockOf(repo.home, area.directory)).toBe("own.team area:ar_monster-assets")
      expect(fs.readFileSync(path.join(repo.home, ".git", "info", "exclude"), "utf8")).toContain("\n/.worktrees/\n")
      expect(git(repo.home, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
      // A second area reuses the line.
      await make(h.services, { team: h.team, slug: "item-assets", name: "아이템 에셋" })
      const exclude = fs.readFileSync(path.join(repo.home, ".git", "info", "exclude"), "utf8")
      expect(exclude.split("\n").filter((line) => line === "/.worktrees/")).toHaveLength(1)

      // 4.3: the area's `.git` file gone, git must not find the home around it.
      const index = fs.readFileSync(path.join(repo.home, ".git", "index"))
      fs.rmSync(path.join(area.directory, ".git"))
      expect(await Identity.check({ directory: area.directory, gitDir: area.gitDir })).toMatchObject({
        ok: false,
        broken: "identity",
      })
      expect(fs.readFileSync(path.join(repo.home, ".git", "index")).equals(index)).toBe(true)
      expect(files(repo.home).filter((file) => !file.startsWith(".worktrees/"))).toEqual(
        homeFiles.filter((file) => !file.startsWith(".worktrees/")),
      )
      await h.close()
    },
    SLOW,
  )

  test(
    "core's snapshot listing of the main folder skips `.worktrees` (own's `.gitignore`); the user's worktree there works",
    async () => {
      const own = f1(path.join(box.root, "inside-snapshot"))
      const where = path.join(own.home, ".worktrees")
      // The user keeps a worktree of their own there, with work not committed yet.
      const mine = path.join(where, "mine")
      git(own.home, ["worktree", "add", "-q", "-b", "mine", mine, own.head])
      write(mine, { "note.txt": "mine\n" })
      const h = await begin({ home: own.home, root: where })
      const { op } = await make(h.services, { team: h.team, slug: "monster-assets", name: "몬스터 에셋" })
      expect(op.state).toBe("done")
      // own's Bun cache for the setup commands (`BunCache.folder`, other-volume): plain files, no worktree of its own.
      write(where, Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`.own-bun-cache/pkg${i}/index.js`, "x\n"])))

      // core lists a session's untracked files through its own Git folder (packages/core/src/git.ts `listChanges`), so
      // the repository's `info/exclude` is not read there; the work tree's `.gitignore` files are.
      const snapshot = path.join(box.root, "inside-snapshot-git")
      const through = ["--git-dir", snapshot, "--work-tree", own.home]
      git(own.home, [...through, "init", "-q"])
      const listed = git(own.home, [...through, "ls-files", "--others", "--exclude-standard", "-z", "--", "."])
        .split("\0")
        .filter(Boolean)
      expect(listed.length).toBeGreaterThan(0)
      expect(listed.filter((file) => file.startsWith(".worktrees"))).toEqual([])
      expect(fs.readFileSync(path.join(where, ".gitignore"), "utf8")).toBe(Home.IGNORE_ALL)

      // The user's worktree reads no `.gitignore` above its own top: its work shows, commits and leaves it clean.
      expect(git(mine, ["status", "--porcelain", "--untracked-files=all"])).toBe("?? note.txt\n")
      git(mine, ["add", "note.txt"])
      git(mine, ["commit", "-q", "-m", "note"])
      expect(git(mine, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
      expect(git(own.home, ["status", "--porcelain", "--untracked-files=all"])).toBe("")

      // A `.gitignore` already there (the user's own `.worktrees` folder) is left as it is.
      fs.writeFileSync(path.join(where, ".gitignore"), "# mine\n")
      await Home.ignore(h.team.worktreeRoot)
      expect(fs.readFileSync(path.join(where, ".gitignore"), "utf8")).toBe("# mine\n")
      await h.close()
    },
    SLOW,
  )

  test(
    "a folder inside another worktree is still refused; the main folder that holds the root may hold it",
    async () => {
      const other = path.join(box.root, "inside-other")
      git(repo.home, ["worktree", "add", "-q", "-b", "other", other, repo.head])
      // A root inside a worktree that is not the one holding `.worktrees` (here: `<other>/x/.worktrees`'s holder is
      // `<other>/x`, not a worktree), so the new folder nests in `other`.
      const h = await begin({ home: repo.home, root: path.join(other, "x", ".worktrees") })
      const refused = await h.services.features().areas.plan({ team: h.team, slug: "z", name: "z", by: "user" })
      expect(refused).toMatchObject({ ok: false, error: "path_forbidden", data: { why: "nested" } })
      await h.close()
    },
    SLOW,
  )
})

describe("setup command (an op step, 06 §2.6 (d), §4.5 step 9)", () => {
  const repo = f1(path.join(box.root, "setup"))
  const counter = path.join(box.root, "setup-count.txt")
  const script = `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); console.log("setup ran")`

  test(
    "runs in the area folder after the owner, logs to the team records, status 준비 중(설치 약 N분) then idle",
    async () => {
      const h = await begin({ home: repo.home, setup: { argv: [process.execPath, "-e", script] } })
      const { planned, op } = await make(h.services, { team: h.team, slug: "app", name: "앱" }, "area:app")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        ["branch-create", "done"],
        ["worktree-create", "done"],
        ["area-record", "done"],
        ["owner-create", "done"],
        ["setup-run", "done"],
      ])
      const step = op.steps[4]!
      expect(step.id).toBe("area:app:5")
      const folder = path.join(Teams.records(h.team), "ops", op.id)
      expect(fs.readdirSync(folder).toSorted()).toEqual(["area_app_5.exit", "area_app_5.log"])
      expect(JSON.parse(fs.readFileSync(path.join(folder, "area_app_5.exit"), "utf8"))).toMatchObject({ code: 0 })
      expect(fs.readFileSync(path.join(folder, "area_app_5.log"), "utf8")).toContain("setup ran")
      expect(fs.readFileSync(counter, "utf8")).toBe("x")
      const statuses = h.published.flatMap((event) =>
        event.name === "area.changed" && event.data.areaID === planned.areaID ? [event.data.status] : [],
      )
      expect(statuses.map((status) => [status.kind, status.text])).toContainEqual(["preparing", "준비 중(설치 약 3분)"])
      expect(statuses.find((status) => status.text.startsWith("준비 중("))?.until).toBe(h.clock.now() + 3 * 60_000)
      expect((await areaOf(h.services, planned.areaID)).status).toMatchObject({ kind: "idle" })

      // TI-11 / 2.6 (d): a restarted controller finds the exit file and does not run the command again.
      const crashed: OwnTeam.Op = {
        ...op,
        state: "running",
        steps: op.steps.map((item) => (item.id === step.id ? { ...item, state: "pending" as const } : item)),
      }
      h.world.kv.set(Keys.op(TEAM_ID, op.id), Keys.toJson(Schema.encodeSync(OwnTeam.Op)(crashed)))
      const area = await areaOf(h.services, planned.areaID)
      await h.services.write(TEAM_ID, () =>
        h.services.registry.areas.put({ ...area, status: { kind: "preparing", at: 0, text: "준비 중" } }),
      )
      await h.close()
      const restarted = controller(h.world, { directory: repo.home, clock: h.clock, source: h.fake.service.source })
      await restarted.controller.resume()
      await restarted.services.runner.settled(op.id)
      expect((await restarted.services.journal.get(TEAM_ID, op.id))?.state).toBe("done")
      expect(fs.readFileSync(counter, "utf8")).toBe("x")
      expect((await areaOf(restarted.services, planned.areaID)).status).toMatchObject({ kind: "idle" })
      await restarted.close()
    },
    SLOW,
  )

  test(
    "a failing setup command leaves the area (status failed, exit code noted) and ends the op",
    async () => {
      const h = await begin({ home: repo.home, setup: { argv: [process.execPath, "-e", "process.exit(3)"] } })
      const { planned, op } = await make(h.services, { team: h.team, slug: "broken-setup", name: "실패" })
      expect(op.state).toBe("done")
      expect(op.steps.at(-1)).toMatchObject({ kind: "setup-run", state: "done", note: "종료 코드 3" })
      expect((await areaOf(h.services, planned.areaID)).status).toMatchObject({
        kind: "failed",
        text: "준비 명령이 실패했어요(종료 코드 3)",
      })
      expect(head(repo.home)).toBe(repo.head)
      await h.close()
    },
    SLOW,
  )

  test(
    "a setup command that cannot start is a failed run with the reason in its log",
    async () => {
      const h = await begin({ home: repo.home, setup: { argv: ["own-team-test-no-such-command"] } })
      const { planned, op } = await make(h.services, { team: h.team, slug: "no-command", name: "없는 명령" })
      expect(op.state).toBe("done")
      const step = op.steps.at(-1)!
      expect(step).toMatchObject({ kind: "setup-run", state: "done", note: "종료 코드 없음" })
      const folder = path.join(Teams.records(h.team), "ops", op.id)
      expect(fs.readFileSync(path.join(folder, `${step.id}.log`), "utf8").length).toBeGreaterThan(0)
      expect((await areaOf(h.services, planned.areaID)).status).toMatchObject({
        kind: "failed",
        text: "준비 명령이 실패했어요(종료 코드 없음)",
      })
      await h.close()
    },
    SLOW,
  )
})
