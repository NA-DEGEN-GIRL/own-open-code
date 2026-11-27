// The heavy-folder list follows the project (06 §4.4, user decision 2026-10-09): the rule's candidates (3.4 and the
// size limit of 4.6), the judge's split checked strictly, nesting, the cache per commit, and the `heavy` op on a real
// repository: a plain team whose assets came after enable (scenario (a)), a committed non-LFS output folder that a
// code-only area held (scenario (b): `grown`, the candidate check, the automatic release), Main 멈춤, the undo with its
// download confirm and `heavy.light`, `disk.ignored` for a large ignored cache (scenario (c)), and a new area of a plain
// team made code-only at once (G7). Thresholds are lowered through the team policy and the feature's options; fixture
// repositories in temp folders, a fake own service on 127.0.0.1, fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Heavy } from "../../src/assets/heavy.js"
import { NeedPaths } from "../../src/assets/need-paths.js"
import { Cone } from "../../src/git/cone.js"
import type { Measure } from "../../src/git/measure.js"
import { Worktree } from "../../src/git/worktree.js"
import type { Hub } from "../../src/hub.js"
import { Merge } from "../../src/integrate/merge.js"
import { JudgePrompt } from "../../src/judge/prompt.js"
import { JudgeSchema } from "../../src/judge/schema.js"
import { JudgeValidate } from "../../src/judge/validate.js"
import { commit, git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, MODEL, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { session, start } from "../support/service.js"

const SLOW = 240_000
const MiB = 1024 ** 2
const GiB = 1024 ** 3

function row(dir: string, extra: Partial<Measure.Row> = {}): Measure.Row {
  return {
    dir,
    depth: dir === "" ? 0 : dir.split("/").length,
    files: 1,
    gitBytes: 0,
    lfsBytes: 0,
    lfsMissing: 0,
    bytes: 0,
    bigFiles: 0,
    binaryRatio: 0,
    extensions: [],
    ...extra,
  }
}

const POLICY: OwnTeam.Policy = OwnTeam.POLICY

describe("candidates: the 3.4 rule and the size limit of 4.6 (pure)", () => {
  const rows = [
    row("", { bytes: 9 * GiB }),
    row("Assets", { bytes: 5 * GiB, lfsBytes: 5 * GiB - 3 * MiB, binaryRatio: null }),
    row("Assets/Textures", { bytes: 5 * GiB - 3 * MiB, lfsBytes: 5 * GiB - 3 * MiB, binaryRatio: 1 }),
    row("Assets/Scripts", { bytes: 3 * MiB, binaryRatio: 0 }),
    row("sim", { bytes: 3 * GiB + MiB, binaryRatio: 0 }),
    row("sim/output", { bytes: 3 * GiB, binaryRatio: 0 }),
    row("sim/output/run1", { bytes: GiB, binaryRatio: 0 }),
    row("sim/output/run2", { bytes: GiB, binaryRatio: 0 }),
    row("sim/output/run3", { bytes: GiB, binaryRatio: 0 }),
    row("sim/src", { bytes: MiB, binaryRatio: 0 }),
    row("src", { bytes: 10 * MiB, binaryRatio: 0 }),
  ]

  test("binary folders by the rule, text data by the size limit at its deepest; never the root or code", () => {
    const plain: Pick<OwnTeam.Team, "heavy" | "policy"> = {
      heavy: { dirs: [], measuredAt: null, forcedBytes: 0 },
      policy: POLICY,
    }
    expect(Heavy.candidates(rows, plain)).toEqual(["Assets/Textures", "sim/output"])
    // The size limit counts only bytes outside the rule's folders: Assets is not over it once Textures is out.
    expect(Heavy.sized(rows, ["Assets/Textures"], POLICY)).toEqual(["sim/output"])
    // Missing LFS bytes over the download limit count too.
    const missing = [row("models", { bytes: 600 * MiB, lfsBytes: 600 * MiB, lfsMissing: 600 * MiB, binaryRatio: 1 })]
    expect(Heavy.sized(missing, [], POLICY)).toEqual(["models"])
  })

  test("folders the list or its undone part covers are no candidates; nothing takes an undone folder back in", () => {
    const listed = {
      heavy: { dirs: ["Assets/Textures"], measuredAt: null, forcedBytes: 0, light: ["sim/output"] },
      policy: POLICY,
    }
    expect(Heavy.candidates(rows, listed)).toEqual([])
    const undone = { ...listed, heavy: { ...listed.heavy, dirs: [], light: ["sim/output/run1"] } }
    expect(Heavy.candidates(rows, undone)).toEqual(["Assets/Textures"])
  })
})

describe("JudgeValidate.grown: the judge only splits, strictly (pure)", () => {
  const sizes: Readonly<Record<string, number>> = {
    data: 3 * GiB,
    "data/a": 1500 * MiB,
    "data/b": 1400 * MiB,
    "data/scripts": 2 * MiB,
    src: 5 * MiB,
  }
  const bytes = (dir: string) => sizes[dir] ?? 0
  const qualifies = (dir: string) => bytes(dir) >= 50 * MiB

  test("folders inside a candidate that are large on their own replace it; code and outside folders never", () => {
    const checked = JudgeValidate.grown({
      answer: [{ dir: "data/a" }, { dir: "data/b" }, { dir: "data/scripts" }, { dir: "src" }, { dir: "../x" }],
      candidates: ["data"],
      qualifies,
      bytes,
    })
    expect(checked.dirs).toEqual(["data/a", "data/b"])
    expect(checked.rejected.map((item) => item.item).toSorted()).toEqual(["heavy/2", "heavy/3", "heavy/4"])
  })

  test("a split that leaves most of the candidate in, or no usable answer, keeps the rule's folder", () => {
    // 1.5 of 3 GB is not half: the rule's folder stands; with data/b it is.
    expect(
      JudgeValidate.grown({ answer: [{ dir: "data/a" }], candidates: ["data"], qualifies: () => true, bytes }).dirs,
    ).toEqual(["data"])
    expect(
      JudgeValidate.grown({
        answer: [{ dir: "data/a" }, { dir: "data/b" }],
        candidates: ["data"],
        qualifies: () => true,
        bytes,
      }).dirs,
    ).toEqual(["data/a", "data/b"])
    const thin = JudgeValidate.grown({
      answer: [{ dir: "data/scripts" }],
      candidates: ["data"],
      qualifies: () => true,
      bytes,
    })
    expect(thin.dirs).toEqual(["data"])
    expect(thin.rejected).toEqual([{ item: "data", why: expect.any(String) }])
    expect(JudgeValidate.grown({ answer: [], candidates: ["data"], qualifies, bytes }).dirs).toEqual(["data"])
  })

  test("the prompt lists the candidates and what is inside them; the answer is read leniently", () => {
    const prompt = JudgePrompt.heavy({
      rev: "a".repeat(40),
      candidates: [{ row: row("data", { bytes: 3 * GiB }), inside: [row("data/a", { bytes: 1500 * MiB })] }],
    })
    expect(prompt).toContain("후보 data/ |")
    expect(prompt).toContain("- data/a/ |")
    expect(JudgePrompt.estimate(prompt)).toBeLessThanOrEqual(JudgePrompt.HEAVY_TOKENS)
    expect(JudgeSchema.parseHeavy('네:\n{ "version": 1, "heavy": [{ "dir": "data/a" }] }')).toEqual({
      heavy: [{ dir: "data/a" }],
    })
    expect(JudgeSchema.parseHeavy("모르겠습니다")).toBeUndefined()
  })
})

/** A blob git calls binary (a NUL byte first), `bytes` long. */
function binary(bytes: number, seed: number) {
  return Uint8Array.from({ length: bytes }, (_, index) => (index === 0 ? 0 : (index * 31 + seed * 101) % 256))
}

/** Text of `bytes` characters. */
function text(bytes: number, seed: number) {
  return `${seed},`.repeat(Math.ceil(bytes / `${seed},`.length)).slice(0, bytes)
}

const ASSETS = {
  "Assets/Textures.meta": "fileFormatVersion: 2\n",
  "Assets/Textures/rock.bin": binary(12_000, 1),
  "Assets/Textures/tree.bin": binary(12_000, 2),
  "Assets/Textures/bush.bin": binary(12_000, 3),
  "Assets/Scripts/Player.cs": "public class Player {}\n",
} as const

describe("the `heavy` op on a plain team whose assets came later (06 §4.4 (a), G1, G7, Main 멈춤, undo)", () => {
  const box = temp("own-team-heavy-")
  const home = init(path.join(box.root, "home"))
  // `Assets/` is there from the start (a script), the textures come later inside it.
  write(home, {
    "README.md": "# game\n",
    "src/main.ts": "export const main = 1\n",
    "Assets/Scripts/Main.cs": "public class Main {}\n",
  })
  const base = commit(home, "base")
  fs.appendFileSync(path.join(home, ".git", "info", "exclude"), ".worktrees/\n")
  const service = start()
  const world = new World()
  // What a new area's plan reads first (10.1): the team main's model and its group's ★.
  service.routes.set(`GET /api/session/${MAIN_SESSION}`, () =>
    Response.json({ data: session({ id: MAIN_SESSION, directory: home, model: MODEL }) }),
  )
  world.accounts.set("accounts.list", () => ({
    revision: 1,
    accounts: [{ id: "acc_01", kind: "codex", providerID: MODEL.providerID }],
  }))
  world.accounts.set("presets.list", () => ({ groups: [] }))
  const safe = { now: true }
  const h = controller(world, {
    directory: box.root,
    clock: manual(),
    source: service.source,
    features: {
      safePoint: () => ({
        check: async () => (safe.now ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }),
      }),
    },
  })
  afterAll(async () => {
    await h.close()
    await service.stop()
    box.dispose()
  })
  const plainTeam: OwnTeam.Team = {
    ...team({ home }),
    heavy: { dirs: [], measuredAt: base, forcedBytes: 0 },
    policy: { ...OwnTeam.POLICY, askDiskBytes: 20_000 },
  }

  async function makeArea(slug: string, input: { readonly paused?: OwnTeam.Paused } = {}) {
    const directory = path.join(box.root, "team", slug)
    const created = await Worktree.create(
      {
        home,
        directory,
        branch: slug,
        base,
        areaID: `ar_${slug}`,
        shape: "plain",
        cone: [],
        heavy: [],
      },
      { askDownloadBytes: Number.POSITIVE_INFINITY },
    )
    if (!created.ok || created.state !== "ready") throw new Error(JSON.stringify(created))
    const record: OwnTeam.Area = {
      ...area({ slug, directory }),
      shape: "plain",
      gitDir: created.gitDir,
      paused: input.paused ?? false,
    }
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put(record))
    return record
  }
  const current = async (id: OwnTeam.AreaID) => {
    const found = await h.services.registry.areas.get(TEAM_ID, id)
    if (!found) throw new Error(`no area ${id}`)
    return found
  }
  const teamNow = async () => {
    const found = await h.services.registry.teams.get(TEAM_ID)
    if (!found) throw new Error("no team")
    return found
  }
  const heavyOps = async () => (await h.services.journal.list(TEAM_ID)).filter((op) => op.kind === "heavy")

  test(
    "the target gains assets: the list grows once, plain areas without them turn code-only quietly, the maker is full",
    async () => {
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(plainTeam))
      const ui = await makeArea("ui")
      const art = await makeArea("art")
      const quiet = await makeArea("quiet", { paused: "user" })
      // The art area makes the game's assets and they reach the target (as an integration would).
      write(art.directory, ASSETS)
      const made = commit(art.directory, "assets")
      git(home, ["merge", "-q", "--ff-only", "art"])
      expect(head(home)).toBe(made)

      // G7: a new area planned now is code-only at once, without the target's new heavy folder.
      const planned = await h.services
        .features()
        .areas.plan({ team: plainTeam, slug: "new", name: "새 영역", by: "main" })
      if (!planned.ok) throw new Error(planned.message)
      const worktree = planned.steps.find((step) => step.kind === "worktree-create")
      expect(worktree?.args).toMatchObject({ shape: "code", heavy: ["Assets/Textures"] })
      expect((worktree?.args?.cone as ReadonlyArray<string>).some((dir) => dir.startsWith("Assets/Textures"))).toBe(
        false,
      )

      await h.services.features().heavy.check(TEAM_ID)
      const [op] = await heavyOps()
      if (!op) throw new Error("no heavy op")
      await h.services.runner.settled(op.id)
      const ended = await h.services.journal.get(TEAM_ID, op.id)
      expect(ended).toMatchObject({ state: "done", by: "auto", undo: { available: true } })
      // Areas in registry order: art, quiet, ui.
      expect(ended?.steps.map((step) => [step.kind, step.state])).toEqual([
        [Heavy.KIND.grow, "done"],
        [Heavy.KIND.areas, "done"],
        [Heavy.KIND.relabel, "done"],
        ["convert-to-code", "skipped"],
        ["convert-to-code", "done"],
      ])
      const grown = await teamNow()
      expect(grown.heavy).toMatchObject({ dirs: ["Assets/Textures"], measuredAt: made })
      // ui: code-only, nothing left the folder, the owner stays (no rotation step), merging the target keeps it out.
      expect(await current(ui.id)).toMatchObject({ shape: "code", owner: { sessionID: OWNER_SESSION } })
      expect(git(ui.directory, ["config", "--get", "core.sparseCheckout"]).trim()).toBe("true")
      // The cone is the complement over ui's HEAD and the target together: `Assets` is not taken whole although ui's
      // HEAD has only its scripts, so the merge cannot bring the textures in.
      const narrowed = await Cone.list(ui.directory)
      expect(narrowed.ok && narrowed.dirs.toSorted()).toEqual(["Assets/Scripts", "src"])
      git(ui.directory, ["merge", "-q", "--ff-only", "main"])
      expect(await h.services.features().drift.check({ teamID: TEAM_ID, areaID: ui.id })).toMatchObject({
        ok: true,
        added: [],
      })
      expect(fs.existsSync(path.join(ui.directory, "Assets", "Textures"))).toBe(false)
      expect(fs.existsSync(path.join(ui.directory, "Assets", "Scripts", "Player.cs"))).toBe(true)
      expect(git(ui.directory, ["status", "--porcelain=v2", "-z"])).toBe("")
      // art made the assets: recorded full, never converted silently; the card suggests it.
      expect(await current(art.id)).toMatchObject({ shape: "full" })
      expect(fs.existsSync(path.join(art.directory, "Assets", "Textures", "rock.bin"))).toBe(true)
      // Main 멈춤: skipped with the existing notice, still plain.
      expect(await current(quiet.id)).toMatchObject({ shape: "plain" })
      const lines = ended?.summary?.lines ?? []
      expect(lines).toContainEqual({ kind: "heavy", dirs: ["Assets/Textures"], bytes: 36_000 })
      expect(lines).toContainEqual({ kind: "area", areaID: ui.id, change: "converted" })
      expect(lines).toContainEqual(
        expect.objectContaining({
          kind: "suggest",
          suggestion: expect.objectContaining({ kind: "convert", area: "art" }),
        }),
      )
      expect(lines).toContainEqual(expect.objectContaining({ kind: "skipped", areaID: quiet.id, why: "paused" }))
      const notices = h.published.flatMap((event) => (event.name === "notice" ? [event.data] : []))
      expect(notices).toContainEqual(
        expect.objectContaining({ kind: "heavy.grew", data: expect.objectContaining({ count: 1 }) }),
      )
      expect(notices).toContainEqual(expect.objectContaining({ kind: "reorg.skipped", areaID: quiet.id }))
      // The team update line does not wake the main.
      const digest = JSON.stringify(world.kv.get(`digest:${TEAM_ID}`))
      expect(digest).toContain("Assets/Textures")
      // One op per commit: looking again starts nothing.
      await h.services.features().heavy.check(TEAM_ID)
      expect((await heavyOps()).length).toBe(1)
      // The measurement is kept for the integration, `.verify` and new areas.
      expect(fs.existsSync(Heavy.cacheFile(grown, made))).toBe(true)
    },
    SLOW,
  )

  test(
    "undo: the list back with the folder kept out of later growths, the converted area full again after the confirm",
    async () => {
      const [op] = await heavyOps()
      if (!op) throw new Error("no heavy op")
      const started = await h.services.features().undo.start({ opID: op.id, by: "user" })
      if (!started.ok) throw new Error(started.message)
      await h.services.runner.settled(started.opID)
      const waiting = await h.services.journal.get(TEAM_ID, started.opID)
      const ask = waiting?.steps.find((step) => step.state === "needs_confirm")
      if (!ask?.confirm) throw new Error(`no confirm: ${JSON.stringify(waiting?.steps)}`)
      // The list goes back first; the conversion back waits for the download confirm (8.2).
      expect((await teamNow()).heavy).toMatchObject({ dirs: [], light: ["Assets/Textures"] })
      const answered = await h.services.runner.confirm({
        opID: started.opID,
        stepID: ask.id,
        choice: "do",
        nonce: ask.confirm.nonce,
      })
      expect(answered.ok).toBe(true)
      await until(async () => (await h.services.journal.get(TEAM_ID, started.opID))?.state === "done")
      const ui = await current(OwnTeam.AreaID.make("ar_ui"))
      expect(ui.shape).toBe("plain")
      expect(fs.existsSync(path.join(ui.directory, "Assets", "Textures", "rock.bin"))).toBe(true)
      expect((await current(OwnTeam.AreaID.make("ar_art"))).shape).toBe("plain")
      expect((await h.services.journal.get(TEAM_ID, op.id))?.undo).toMatchObject({ available: false, by: started.opID })
      // The undone folder is not a candidate again.
      const again = await h.services.features().heavy.growth({ team: await teamNow(), rev: head(home), prune: true })
      expect(again).toMatchObject({ ok: true, added: [] })
    },
    SLOW,
  )
})

describe("a code-only area held a folder that grew heavy (06 §4.4 (b): grown, the candidate check, the release)", () => {
  const box = temp("own-team-heavy-code-")
  const home = init(path.join(box.root, "home"))
  write(home, {
    "README.md": "# sim\n",
    "src/main.ts": "export const main = 1\n",
    "Content/map.bin": binary(30_000, 9),
    "sim/model.py": "print(1)\n",
    // A code folder beside the output: cone mode keeps `sim/model.py` only while a cone folder is inside `sim` (4.5).
    "sim/src/run.py": "print(2)\n",
  })
  const base = commit(home, "base")
  fs.appendFileSync(path.join(home, ".git", "info", "exclude"), ".worktrees/\n")
  const world = new World()
  const service = start()
  const h = controller(world, {
    directory: box.root,
    clock: manual(),
    source: service.source,
    features: { safePoint: () => ({ check: async () => ({ ok: true }) }) },
  })
  afterAll(async () => {
    await h.close()
    await service.stop()
    box.dispose()
  })
  const heavyTeam: OwnTeam.Team = {
    ...team({ home }),
    heavy: { dirs: ["Content"], measuredAt: base, forcedBytes: 0 },
    policy: { ...OwnTeam.POLICY, askDiskBytes: 20_000 },
  }

  async function makeArea(slug: string) {
    const directory = path.join(box.root, "team", slug)
    const created = await Worktree.create(
      {
        home,
        directory,
        branch: slug,
        base,
        areaID: `ar_${slug}`,
        shape: "code",
        cone: ["sim", "src"],
        heavy: ["Content"],
      },
      { askDownloadBytes: Number.POSITIVE_INFINITY },
    )
    if (!created.ok || created.state !== "ready") throw new Error(JSON.stringify(created))
    const record: OwnTeam.Area = {
      ...area({ slug, directory }),
      shape: "code",
      gitDir: created.gitDir,
      owner: { sessionID: SessionID.make(`ses_${slug.padEnd(26, "0")}`), previous: [], attached: true },
    }
    await h.services.write(TEAM_ID, () => h.services.registry.areas.put(record))
    return record
  }
  const current = async (id: OwnTeam.AreaID) => {
    const found = await h.services.registry.areas.get(TEAM_ID, id)
    if (!found) throw new Error(`no area ${id}`)
    return found
  }

  test(
    "the area's committed output grows heavy: recorded `grown` (its changes pass the 4.10 check), released once clean",
    async () => {
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(heavyTeam))
      const clean = await makeArea("clean")
      const busy = await makeArea("busy")
      const later = await makeArea("later")
      // The simulation writes 30 kB of committed text output on the target (scenario (b)).
      write(home, {
        "sim/output/run1.csv": text(10_000, 1),
        "sim/output/run2.csv": text(10_000, 2),
        "sim/output/run3.csv": text(10_000, 3),
      })
      const grown = commit(home, "sim output")
      git(clean.directory, ["merge", "-q", "--ff-only", "main"])
      git(busy.directory, ["merge", "-q", "--ff-only", "main"])
      // busy keeps working inside it: an untracked file there keeps the folder (4.7).
      write(busy.directory, { "sim/output/run4.csv": "wip\n" })

      await h.services.features().heavy.check(TEAM_ID)
      const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "heavy")
      if (!op) throw new Error("no heavy op")
      await h.services.runner.settled(op.id)
      expect((await h.services.registry.teams.get(TEAM_ID))?.heavy).toMatchObject({
        dirs: ["Content", "sim/output"],
        measuredAt: grown,
      })
      // The releases run as `paths` ops of their own after the heavy op.
      await until(async () => !fs.existsSync(path.join(clean.directory, "sim", "output")))
      expect(fs.existsSync(path.join(clean.directory, "sim", "model.py"))).toBe(true)
      expect(git(clean.directory, ["status", "--porcelain=v2", "-z"])).toBe("")
      await until(async () => Object.keys((await current(clean.id)).cone.extra).length === 0)
      // `sim` would leave whole (the new cone holds `sim/src` only), and it holds the owner's work: kept (4.7).
      await until(async () => (await current(busy.id)).cone.kept["sim"] === "dirty")
      const kept = await current(busy.id)
      expect(kept.cone.extra["sim/output"]).toMatchObject({ reason: NeedPaths.GROWN })
      expect(fs.readFileSync(path.join(busy.directory, "sim", "output", "run4.csv"), "utf8")).toBe("wip\n")
      // Its next candidate changes the grown folder: the 4.10 check lets it through (no false block).
      write(busy.directory, { "sim/output/run1.csv": text(10_000, 7) })
      const candidate = commit(busy.directory, "rerun")
      const checked = await Merge.heavy({
        repo: path.join(home, ".git"),
        base: grown,
        candidate,
        heavy: ["Content", "sim/output"],
        extra: Object.keys(kept.cone.extra),
      })
      expect(checked).toEqual({ ok: true, deleted: [], outside: [] })
      // Its cone still holds the folder through `sim`; the cone itself is unchanged by the record.
      const listed = await Cone.list(busy.directory)
      expect(listed.ok && listed.dirs).toEqual(["sim", "src"])
      // `later` had not merged: its cone took `sim` whole, so the next merge would have brought the output in. It
      // narrowed first (nothing of its HEAD left), and the merge keeps the output out.
      const narrowed = await Cone.list(later.directory)
      expect(narrowed.ok && narrowed.dirs).toEqual(["sim/src", "src"])
      expect(fs.existsSync(path.join(later.directory, "sim", "model.py"))).toBe(true)
      git(later.directory, ["merge", "-q", "--ff-only", "main"])
      expect(fs.existsSync(path.join(later.directory, "sim", "output"))).toBe(false)
      expect(git(later.directory, ["status", "--porcelain=v2", "-z"])).toBe("")
    },
    SLOW,
  )

  test(
    "disk.ignored (06 §4.11 (c)): a large ignored cache of an area is named once after a run; installs never",
    async () => {
      const clean = await current(OwnTeam.AreaID.make("ar_clean"))
      fs.appendFileSync(path.join(home, ".git", "info", "exclude"), "cache/\nnode_modules/\n")
      write(clean.directory, {
        "cache/a.bin": binary(15_000, 1),
        "cache/b.bin": binary(15_000, 2),
        "node_modules/x/index.js": text(30_000, 3),
      })
      h.controller.hub.receive(ended(String(clean.owner.sessionID)))
      await until(async () =>
        h.published.some((event) => event.name === "notice" && event.data.kind === "disk.ignored"),
      )
      const named = h.published.flatMap((event) =>
        event.name === "notice" && event.data.kind === "disk.ignored" ? [event.data] : [],
      )
      expect(named).toEqual([
        expect.objectContaining({ areaID: clean.id, data: expect.objectContaining({ dir: "cache", bytes: 30_000 }) }),
      ])
      // Nothing was shared or deleted.
      expect(fs.existsSync(path.join(clean.directory, "cache", "a.bin"))).toBe(true)
    },
    SLOW,
  )
})

describe("the judge splits a candidate that holds code; the main's answer is checked (06 §4.4)", () => {
  const box = temp("own-team-heavy-judge-")
  const home = init(path.join(box.root, "home"))
  write(home, { "README.md": "# data\n", "src/main.ts": "export const main = 1\n" })
  const base = commit(home, "base")
  const world = new World()
  const service = start()
  const prompts: string[] = []
  const answers: string[] = []
  service.routes.set(`POST /api/session/${MAIN_SESSION}/generate`, (request) => {
    prompts.push(String((request.body as { prompt: string }).prompt))
    return Response.json({ data: { text: answers.shift() ?? "{}" } })
  })
  const h = controller(world, {
    directory: box.root,
    clock: manual(),
    source: service.source,
    features: { heavy: (services) => Heavy.create(services, { codeBytes: 1_000 }) },
  })
  afterAll(async () => {
    await h.close()
    await service.stop()
    box.dispose()
  })
  const dataTeam: OwnTeam.Team = {
    ...team({ home }),
    heavy: { dirs: [], measuredAt: base, forcedBytes: 0 },
    policy: { ...OwnTeam.POLICY, askDiskBytes: 30_000 },
  }

  test(
    "`data` (text, no child over the limit) is split into its two halves; its scripts stay in",
    async () => {
      write(home, {
        "data/a/part1.csv": text(8_000, 1),
        "data/a/part2.csv": text(8_000, 2),
        "data/b/part1.csv": text(8_000, 3),
        "data/b/part2.csv": text(8_000, 4),
        "data/scripts/load.py": text(1_500, 5),
      })
      const rev = commit(home, "data")
      answers.push(
        JSON.stringify({
          version: 1,
          heavy: [{ dir: "data/a" }, { dir: "data/b" }, { dir: "data/scripts" }, { dir: "src" }],
        }),
      )
      const grown = await h.services.features().heavy.growth({ team: dataTeam, rev })
      expect(grown).toMatchObject({ ok: true, added: ["data/a", "data/b"], judged: true })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("후보 data/ |")
      // Cached per commit: the integration, `.verify` and the op after the advance ask no second time.
      expect(await h.services.features().heavy.growth({ team: dataTeam, rev })).toMatchObject({
        added: ["data/a", "data/b"],
      })
      expect(prompts).toHaveLength(1)
    },
    SLOW,
  )

  test(
    "an answer that would leave most of it in, or no answer, keeps the rule's folder",
    async () => {
      write(home, { "data/c/part1.csv": text(8_000, 6) })
      const rev = commit(home, "more data")
      answers.push(JSON.stringify({ version: 1, heavy: [{ dir: "data/scripts" }] }))
      expect(await h.services.features().heavy.growth({ team: dataTeam, rev })).toMatchObject({
        ok: true,
        added: ["data"],
      })
      write(home, { "data/d/part1.csv": text(8_000, 7) })
      const next = commit(home, "even more data")
      answers.push("잘 모르겠습니다")
      expect(await h.services.features().heavy.growth({ team: dataTeam, rev: next })).toMatchObject({
        ok: true,
        added: ["data"],
        judged: false,
      })
    },
    SLOW,
  )
})

function ended(sessionID: string): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return {
    id: `evt_${crypto.randomUUID()}`,
    created: 1,
    type: "session.execution.succeeded",
    data: { sessionID },
  } as never
}

async function until(check: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(25)
  }
}
