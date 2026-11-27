// TG11 합치기 without the `.assets` items (06 §7, §11.3; `.assets` checks are T3): integrations on a real server, and the
// git line itself on this host's git.
//
// - Server (F1 with a `typecheck` script as the team's code check, a bare `file://` remote, three code areas): a
//   fast-forward the main asks for; a candidate with a newer commit after it (left out); a merge commit with a new
//   top-level folder (the verify folder takes it into its cone) and the area sync; the target moving while the checks
//   run (steps 1–7 again); a conflict (the owner gets the `conflict` request, the target stays); the home's uncommitted
//   changes that overlap (waits, nothing moves) and that do not (they stay); a rebase in progress in the home (waits,
//   no `update-ref`); the target checked out in a folder outside the team (waits); undo while the user commits on the
//   target (keep ref); the push plan (nothing goes up without the confirm, a wrong nonce is refused); `mergeLocal: ask`.
// - Server (F2, LFS, code-only areas): an LFS pointer conflict found without a smudge or a download, and a candidate
//   with a new top-level folder checked in the code-only verify folder.
// - Git procedure (also on dev-host through `test/real-host/run.sh`, 06 §11.2): merge-tree with the attributes of B,
//   commit-tree, the create-only marker transaction, compare-and-swap, `merge --ff-only` in a code-only folder and
//   `reset --keep`, with local changes that do and do not overlap.
//
// Verdicts come from durable state: integration records and ops in KV, refs and files in git, the bare remote. Fake
// credentials only; every listener binds 127.0.0.1. Run from a path without '#'. On the real host
// (`OWN_REAL_HOST_RUN=1`) only the git procedure runs: the server parts load this workspace's packages lazily.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { OwnTeam } from "@own/protocol"
import { Refs } from "../../src/git/refs.js"
import type { F2 } from "../fixtures/lfs-repo.js"
import { commit, f1, git, head, init, temp, write } from "../fixtures/repo.js"
import type {
  active,
  dispatches,
  enableTeam,
  integrations,
  mainRequests,
  messages,
  notices,
  opEnd,
  ops,
  startTeamServer,
  TeamServer,
  until,
  waitValue,
} from "./harness.js"
import type { sparse } from "./inspect.js"
import { BOOT_TIMEOUT } from "./timeouts.js"

/** On the real host (06 §11.2) only the git procedure runs. */
const HOST = process.env.OWN_REAL_HOST_RUN === "1"
const STEP_TIMEOUT = 300_000

/** The team's code check (`bun run typecheck`): waits until the epoch ms in `slow.txt`, fails while `fail.txt` exists. */
const CHECK_SOURCE = [
  'import fs from "node:fs"',
  'const until = fs.existsSync("slow.txt") ? Number(fs.readFileSync("slow.txt", "utf8")) : 0',
  "await Bun.sleep(Math.max(0, until - Date.now()))",
  'if (fs.existsSync("fail.txt")) {',
  '  console.error("e2e check failed")',
  "  process.exit(1)",
  "}",
  'console.log("e2e check passed")',
  "",
].join("\n")

describe("TG11 git procedure: the integration line on this host's git (06 §7.2–7.4)", () => {
  test("merge-tree with B's attributes, commit-tree, the marker transaction, compare-and-swap", async () => {
    const box = temp("own-team-ig-git-")
    try {
      const repo = line(box.root)
      const merged = attempt(repo.home, [
        `--attr-source=${repo.base}`,
        "merge-tree",
        "--write-tree",
        "-z",
        "--name-only",
        repo.base,
        repo.source,
      ])
      expect(merged.code).toBe(0)
      const tree = merged.stdout.split("\0")[0] ?? ""
      const candidate = git(repo.home, [
        "commit-tree",
        tree,
        "-p",
        repo.base,
        "-p",
        repo.source,
        "-m",
        "팀: inv 합치기 (ig_procedure)",
      ]).trim()
      expect(parents(repo.home, candidate)).toEqual([repo.base, repo.source])
      // Nothing was checked out: the home is still at B with a clean status.
      expect(head(repo.home)).toBe(repo.base)
      expect(git(repo.home, ["status", "--porcelain"])).toBe("")

      // 7.2 step 5: create-only, all or nothing; the same values again count as done (resume).
      const marks = markers("ig_procedure", { base: repo.base, source: repo.source, candidate })
      expect(await Refs.createAll(repo.home, marks)).toEqual({ ok: true, created: true })
      expect(await Refs.createAll(repo.home, marks)).toEqual({ ok: true, created: false })
      const other = [
        { ref: "refs/own/integrate/ig_other/base", oid: repo.base },
        { ref: "refs/own/integrate/ig_procedure/candidate", oid: repo.start },
      ]
      expect((await Refs.createAll(repo.home, other)).ok).toBe(false)
      expect(await Refs.read(repo.home, "refs/own/integrate/ig_other/base")).toBeNull()
      expect(await Refs.read(repo.home, "refs/own/integrate/ig_procedure/candidate")).toBe(candidate)

      // A conflict is exit 1 with the path; still nothing checked out.
      write(repo.area, { "docs/guide.md": "area guide\n" })
      const conflicting = commit(repo.area, "guide in the area")
      write(repo.home, { "docs/guide.md": "main guide\n" })
      const moved = commit(repo.home, "guide on main")
      const conflict = attempt(repo.home, [
        `--attr-source=${moved}`,
        "merge-tree",
        "--write-tree",
        "-z",
        "--name-only",
        moved,
        conflicting,
      ])
      expect(conflict.code).toBe(1)
      expect(conflict.stdout.split("\0")).toContain("docs/guide.md")
      expect(head(repo.home)).toBe(moved)

      // Compare-and-swap on a branch no folder has checked out: a wrong old value changes nothing.
      git(repo.home, ["branch", "target", repo.base])
      expect(attempt(repo.home, ["update-ref", "refs/heads/target", candidate, repo.start]).code).not.toBe(0)
      expect(git(repo.home, ["rev-parse", "refs/heads/target"]).trim()).toBe(repo.base)
      expect(attempt(repo.home, ["update-ref", "refs/heads/target", candidate, repo.base]).code).toBe(0)
      expect(git(repo.home, ["rev-parse", "refs/heads/target"]).trim()).toBe(candidate)
    } finally {
      box.dispose()
    }
  })

  test("merge --ff-only and reset --keep in a code-only folder keep local changes that do not overlap", () => {
    const box = temp("own-team-ig-ff-")
    try {
      const repo = line(box.root)
      const candidate = repo.source
      const folder = codeOnly(repo.home, path.join(box.root, "team", "w"), "w", repo.start)
      expect(fs.existsSync(path.join(folder, "Assets", "big.bin"))).toBe(false)
      write(folder, { "docs/guide.md": "local guide\n" })
      expect(attempt(folder, ["merge", "--ff-only", "--no-autostash", candidate]).code).toBe(0)
      expect(head(folder)).toBe(candidate)
      expect(fs.readFileSync(path.join(folder, "docs", "guide.md"), "utf8")).toBe("local guide\n")
      expect(fs.existsSync(path.join(folder, "src", "inventory.ts"))).toBe(true)
      expect(fs.existsSync(path.join(folder, "Assets", "big.bin"))).toBe(false)

      // An untracked file at a path K brings: a full folder's fast-forward stops and nothing is lost.
      const full = path.join(box.root, "team", "full")
      git(repo.home, ["worktree", "add", "-q", "-b", "full", full, repo.start])
      write(full, { "src/inventory.ts": "local work\n" })
      expect(attempt(full, ["merge", "--ff-only", "--no-autostash", candidate]).code).not.toBe(0)
      expect(head(full)).toBe(repo.start)
      expect(fs.readFileSync(path.join(full, "src", "inventory.ts"), "utf8")).toBe("local work\n")
      // A code-only folder's fast-forward wrote over such a file with exit 0 (Git 2.55, 2026-10-03), so own checks
      // the overlap before it (`integrate/advance.ts`); what this host's git does is printed for the gate record.
      const other = codeOnly(repo.home, path.join(box.root, "team", "w2"), "w2", repo.start)
      write(other, { "src/inventory.ts": "local work\n" })
      const sparse = attempt(other, ["merge", "--ff-only", "--no-autostash", candidate])
      const kept = fs.readFileSync(path.join(other, "src", "inventory.ts"), "utf8") === "local work\n"
      console.log(
        `[TG11 record] git ff-only over an untracked file in a code-only folder: exit ${sparse.code}, kept ${kept}`,
      )

      // 7.4: reset --keep back to B keeps a change that does not overlap, refuses one that does.
      expect(attempt(folder, ["reset", "-q", "--keep", repo.start]).code).toBe(0)
      expect(head(folder)).toBe(repo.start)
      expect(fs.readFileSync(path.join(folder, "docs", "guide.md"), "utf8")).toBe("local guide\n")
      expect(attempt(folder, ["merge", "-q", "--ff-only", "--no-autostash", candidate]).code).toBe(0)
      write(folder, { "src/inventory.ts": "edited after the integration\n" })
      expect(attempt(folder, ["reset", "-q", "--keep", repo.start]).code).not.toBe(0)
      expect(head(folder)).toBe(candidate)
      expect(fs.readFileSync(path.join(folder, "src", "inventory.ts"), "utf8")).toBe("edited after the integration\n")
    } finally {
      box.dispose()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Server

interface Kit {
  readonly active: typeof active
  readonly messages: typeof messages
  readonly dispatches: typeof dispatches
  readonly enableTeam: typeof enableTeam
  readonly integrations: typeof integrations
  readonly mainRequests: typeof mainRequests
  readonly notices: typeof notices
  readonly opEnd: typeof opEnd
  readonly ops: typeof ops
  readonly sparse: typeof sparse
  readonly startTeamServer: typeof startTeamServer
  readonly until: typeof until
  readonly waitValue: typeof waitValue
}

/** The server side of this file, loaded only off the real host (it needs this workspace's packages). */
async function kit(): Promise<Kit> {
  const {
    active,
    messages,
    dispatches,
    enableTeam,
    integrations,
    mainRequests,
    notices,
    opEnd,
    ops,
    startTeamServer,
    until,
    waitValue,
  } = await import("./harness.js")
  const { sparse } = await import("./inspect.js")
  return {
    active,
    messages,
    dispatches,
    enableTeam,
    integrations,
    mainRequests,
    notices,
    opEnd,
    ops,
    sparse,
    startTeamServer,
    until,
    waitValue,
  }
}

interface Team {
  readonly kit: Kit
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly home: string
  readonly worktreeRoot: string
  readonly areas: ReadonlyArray<OwnTeam.AreaID>
}

describe.skipIf(HOST)("TG11 integrations on a real server (F1, three areas, a bare remote)", () => {
  const state: { team?: Team; origin?: string; done?: OwnTeam.IntegrationID; last?: OwnTeam.Integration } = {}

  beforeAll(async () => {
    const tools = await kit()
    const server = await tools.startTeamServer({
      name: "integrate",
      project: (root) => {
        const built = checked(root)
        state.origin = built.origin
        return built.home
      },
    })
    const viewed = await server.createSession({ title: "켠 대화" })
    const enabled = await tools.enableTeam(server, { hint: "[propose-areas 3 +check]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    expect(team.commands.code).toHaveLength(1)
    state.team = {
      kit: tools,
      server,
      teamID: team.id,
      main: team.main.sessionID,
      home: required(server.project),
      worktreeRoot: team.worktreeRoot,
      areas: enabled.view.areas.map((area) => area.id),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "a fast-forward the main asks for: the target becomes the candidate in the home, the markers go",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 0)
      write(area.directory, { "src/a1.ts": "export const a1 = 1\n" })
      const source = commit(area.directory, "a1")
      expect(await ready(team, 0)).toBe(source)
      const base = tip(team.home)
      const done = await byMain(team, 0)
      expect(done.op.by).toBe("main")
      expect(done.integration).toMatchObject({
        state: "done",
        how: "ff",
        base,
        source,
        candidate: source,
        advanced: { how: "ff-in-worktree" },
        verify: { code: { ok: true }, assets: "skipped" },
      })
      expect(tip(team.home)).toBe(source)
      expect(head(team.home)).toBe(source)
      expect(fs.existsSync(path.join(team.home, "src", "a1.ts"))).toBe(true)
      expect(markersOf(team.home, done.integration.id)).toEqual([])
      expect(done.op.summary?.lines).toContainEqual(
        expect.objectContaining({ kind: "integrated", integrationID: done.integration.id }),
      )
      expect((await areaOf(team, 0)).candidate).toBeUndefined()
    },
    STEP_TIMEOUT,
  )

  test(
    "the main keeps working after its integrate: it waits (in-use), then goes in by itself once the main is idle",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 0)
      const areaID = required(team.areas[0])
      write(area.directory, { "src/a2.ts": "export const a2 = 1\n" })
      const source = commit(area.directory, "a2")
      // The report's text reaches the main in its team update: `[slow]` makes that woken turn long, as a real main's is.
      await team.server.turn(
        required(area.owner.sessionID ?? undefined),
        "[report ready 합칠 준비가 됐습니다 [slow 40000]]",
      )
      expect(required((await areaOf(team, 0)).candidate).sha).toBe(source)
      const latest = () => team.kit.integrations(db(team), team.teamID).findLast((item) => item.areaID === areaID)
      // A real main goes on after the call (live team test, 2026-10-14); a sub-agent that answers 20 s late keeps working
      // in the home, so step 8 meets the home in use. Since upstream v2.3.0 (#63382) the sub-agent runs in the
      // background: the main's turn ends at once while its child still works there, and the integration reaches step 8
      // after the turn.
      await team.server.turn(team.main, `[integrate ${areaID.slice("ar_".length)}] [subagent general [slow 20000]]`)
      await team.kit.until(async () => latest()?.state !== "running", "the integration never reached step 8", 60_000)
      expect(latest()).toMatchObject({ source, state: "waiting", waiting: { why: "in-use" } })
      // The update's wake retries it while that woken turn runs, so it waits again; nobody asks after that. The recheck
      // finds the home at its safe point once the main is idle.
      const seen = (await updatesOf(team)).length
      await team.kit.until(async () => latest()?.state === "done", "the waiting integration never went in", 180_000)
      expect(tip(team.home)).toBe(source)
      expect((await areaOf(team, 0)).candidate).toBeUndefined()
      // The main started it and was told the result comes with its next update, and no other area waits: that update
      // still wakes it, so it can say what went in (2026-10-18).
      await team.kit.until(
        async () => (await updatesOf(team)).slice(seen).some((reasons) => reasons.includes("integrated")),
        "the main never heard that its integration went in",
        120_000,
      )
    },
    STEP_TIMEOUT,
  )

  test(
    "one area goes in while another's reported work waits: the main is woken to integrate the next one",
    async () => {
      const team = required(state.team)
      for (const index of [1, 2]) {
        const area = await areaOf(team, index)
        write(area.directory, { [`src/w${index}.ts`]: `export const w${index} = 1\n` })
        commit(area.directory, `w${index}`)
        await ready(team, index)
      }
      const updates = () => updatesOf(team)
      // The ready reports' own update reaches the main first; only the integration can wake it after that.
      await team.kit.until(
        async () =>
          (await updates()).some((reasons) => reasons.includes("ready")) &&
          !(await team.kit.active(team.server)).has(team.main),
        "the ready update never reached the main",
        120_000,
      )
      const seen = (await updates()).length
      // The second ready report can wake the main once more, and the home is in use while it runs: the integration
      // then waits (in-use, rechecked every 30 s) and goes in by itself (2026-10-17, loaded PC).
      await goesIn(team, 1)
      await team.kit.until(
        async () => (await updates()).slice(seen).some((reasons) => reasons.includes("integrated")),
        "the integration did not wake the main",
        120_000,
      )
      // The woken main runs in the home now, so this one can wait for it the same way.
      await goesIn(team, 2)
    },
    // Four waits of 120-180 s each: on a loaded PC two in-use rechecks (30 s each) alone took the old 300 s (2.2.6-own.15).
    2 * STEP_TIMEOUT,
  )

  test(
    "a commit after `ready` stays out: the reported candidate goes in, newerSkipped 1",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 0)
      write(area.directory, { "src/b1.ts": "export const b1 = 1\n" })
      const source = commit(area.directory, "b1")
      expect(await ready(team, 0)).toBe(source)
      write(area.directory, { "src/b2.ts": "export const b2 = 1\n" })
      commit(area.directory, "b2 after ready")
      const done = await goesIn(team, 0)
      // The two areas before went in, so the target moved past this area's base: the candidate merges `source`.
      expect(done).toMatchObject({ state: "done", source, newerSkipped: 1 })
      expect(tip(team.home)).toBe(required(done.candidate))
      expect(git(team.home, ["ls-tree", "--name-only", "main", "src/b1.ts"]).trim()).toBe("src/b1.ts")
      expect(git(team.home, ["ls-tree", "--name-only", "main", "src/b2.ts"]).trim()).toBe("")
      state.done = done.id
    },
    STEP_TIMEOUT,
  )

  test(
    "a merge commit K = (B, C) with a new top-level folder: verified in the verify folder, the area synced to K",
    async () => {
      const team = required(state.team)
      write(team.home, { "docs/news.md": "news\n" })
      const base = commit(team.home, "news on main")
      const area = await areaOf(team, 1)
      write(area.directory, { "src/a2.ts": "export const a2 = 1\n", "newtop/x.ts": "export const x = 1\n" })
      const source = commit(area.directory, "a2 and newtop")
      await ready(team, 1)
      const done = await byMain(team, 1)
      const integration = done.integration
      expect(integration).toMatchObject({ state: "done", how: "merge", base, source })
      const candidate = required(integration.candidate)
      expect(parents(team.home, candidate)).toEqual([base, source])
      expect(git(team.home, ["log", "-1", "--format=%s", candidate]).trim()).toBe(
        `팀: ${area.name} 합치기 (${integration.id})`,
      )
      expect(tip(team.home)).toBe(candidate)
      expect(integration.verify.cone).toEqual({ ok: true, missing: [] })
      const verify = path.join(team.worktreeRoot, ".verify")
      expect(head(verify)).toBe(candidate)
      expect(fs.existsSync(path.join(verify, "newtop", "x.ts"))).toBe(true)
      // The area's HEAD was still C: it follows K at its safe point (7.2 step 9).
      await team.kit.until(async () => head(area.directory) === candidate, "the area never followed K", STEP_TIMEOUT)
    },
    STEP_TIMEOUT,
  )

  test(
    "the target moves while the checks run: steps 1–7 again against the new tip, K on top of it",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 2)
      write(area.directory, { "slow.txt": String(Date.now() + 20_000), "src/a3.ts": "export const a3 = 1\n" })
      const source = commit(area.directory, "a3, slow checks")
      await ready(team, 2)
      const started = await team.server.team("area.integrate", { teamID: team.teamID, areaID: area.id })
      await team.kit.waitValue(
        async () => {
          const record = await igOf(team, started.integrationID)
          return record.state === "running" && record.checks !== undefined ? record : undefined
        },
        "the checks never started",
        STEP_TIMEOUT,
      )
      write(team.home, { "moves/m1.txt": "moved\n" })
      const moved = commit(team.home, "the target moves")
      await team.kit.opEnd(team.server, started.opID, { waiting: true, timeoutMs: STEP_TIMEOUT })
      // The `ready` report wakes the main 30 s later; on a loaded PC the 20 s checks and the second pass end after
      // that, so step 8 meets the home in use and the integration goes in by itself once the main is idle.
      await team.kit.until(
        async () => (await igOf(team, started.integrationID)).state === "done",
        "area 2's integration never went in",
        180_000,
      )
      const integration = await igOf(team, started.integrationID)
      expect(integration).toMatchObject({ state: "done", how: "merge", base: moved, source })
      const candidate = required(integration.candidate)
      expect(parents(team.home, candidate)).toEqual([moved, source])
      expect(tip(team.home)).toBe(candidate)
    },
    STEP_TIMEOUT,
  )

  test(
    "a conflict: the owner gets the `conflict` request, the target stays",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 0)
      write(area.directory, { "README.md": "# F1 area\n" })
      await commitAndReady(team, 0, "readme in the area")
      write(team.home, { "README.md": "# F1 main\n" })
      const base = commit(team.home, "readme on main")
      const owner = required(area.owner.sessionID ?? undefined)
      const requests = (await team.kit.mainRequests(team.server, owner)).length
      const done = await byMain(team, 0)
      expect(done.integration).toMatchObject({ state: "conflict", base })
      expect(done.integration.conflicts).toContain("README.md")
      expect(tip(team.home)).toBe(base)
      const sent = team.kit
        .dispatches(db(team), team.teamID)
        .filter((item) => item.areaID === area.id && item.kind === "conflict")
      expect(sent.map((item) => item.from)).toEqual(["team"])
      await team.kit.until(
        async () =>
          (await team.kit.mainRequests(team.server, owner)).length > requests &&
          !(await team.kit.active(team.server)).has(owner),
        "the owner never got the conflict request",
        STEP_TIMEOUT,
      )
      // The owner sorts it out in its folder (here: the test, keeping the area's text).
      git(area.directory, ["merge", "-q", "-X", "ours", "-m", "main in the area", "main"])
    },
    STEP_TIMEOUT,
  )

  test(
    "the home's overlapping change makes it wait (nothing moves); a change that does not overlap stays",
    async () => {
      const team = required(state.team)
      await ready(team, 0)
      const base = tip(team.home)
      write(team.home, { "README.md": "# F1 local edit\n" })
      const waiting = await byUser(team, 0)
      expect(waiting.integration).toMatchObject({ state: "waiting", waiting: { why: "dirty" } })
      expect(waiting.integration.waiting?.paths).toContain("README.md")
      expect(tip(team.home)).toBe(base)
      expect(fs.readFileSync(path.join(team.home, "README.md"), "utf8")).toBe("# F1 local edit\n")
      expect(team.kit.notices(team.server, "integration.waiting").length).toBeGreaterThan(0)

      git(team.home, ["checkout", "-q", "--", "README.md"])
      write(team.home, { "docs/guide.md": "guide with a local edit\n" })
      // The retry goes in at once, or after the home's in-use wait (goesIn).
      const retried = await goesIn(team, 0)
      expect(retried.id).toBe(waiting.integration.id)
      expect(retried).toMatchObject({ state: "done", advanced: { how: "ff-in-worktree" } })
      expect(tip(team.home)).toBe(required(retried.candidate))
      expect(fs.readFileSync(path.join(team.home, "README.md"), "utf8")).toBe("# F1 area\n")
      expect(fs.readFileSync(path.join(team.home, "docs", "guide.md"), "utf8")).toBe("guide with a local edit\n")
      git(team.home, ["checkout", "-q", "--", "docs/guide.md"])
      state.done = retried.id
    },
    STEP_TIMEOUT,
  )

  test(
    "a rebase in progress in the home: it waits and the target is not moved; after the abort it goes in",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 1)
      write(area.directory, { "src/c2.ts": "export const c2 = 1\n" })
      await commitAndReady(team, 1, "c2")
      write(team.home, { "README.md": "# F1 rebase main\n" })
      const ahead = commit(team.home, "readme before the rebase")
      sideCommit(team.home, "side", `${ahead}~1`, "README.md", "# F1 side\n")
      expect(attempt(team.home, ["rebase", "side"]).code).not.toBe(0)
      expect(fs.existsSync(gitPath(team.home, "rebase-merge"))).toBe(true)
      const waiting = await byUser(team, 1)
      expect(waiting.integration).toMatchObject({ state: "waiting", waiting: { why: "in-progress" } })
      expect(tip(team.home)).toBe(ahead)

      git(team.home, ["rebase", "--abort"])
      expect(head(team.home)).toBe(ahead)
      const retried = await goesIn(team, 1)
      expect(retried).toMatchObject({ state: "done" })
      expect(tip(team.home)).toBe(required(retried.candidate))
      git(team.home, ["branch", "-q", "-D", "side"])
    },
    STEP_TIMEOUT,
  )

  test(
    "the target checked out in a folder outside the team: it waits; with no folder holding it, update-ref",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 2)
      write(area.directory, { "src/d3.ts": "export const d3 = 1\n" })
      await commitAndReady(team, 2, "d3")
      const outside = path.join(team.server.root, "outside-main")
      git(team.home, ["switch", "-q", "-c", "parking"])
      git(team.home, ["worktree", "add", "-q", outside, "main"])
      const base = tip(team.home)
      const waiting = await byUser(team, 2)
      expect(waiting.integration).toMatchObject({ state: "waiting", waiting: { why: "outside" } })
      expect(same(required(waiting.integration.waiting).directory, outside)).toBe(true)
      expect(tip(team.home)).toBe(base)

      git(team.home, ["worktree", "remove", outside])
      const retried = await goesIn(team, 2)
      expect(retried).toMatchObject({ state: "done", advanced: { how: "update-ref" } })
      const candidate = required(retried.candidate)
      expect(tip(team.home)).toBe(candidate)
      git(team.home, ["switch", "-q", "main"])
      git(team.home, ["branch", "-q", "-D", "parking"])
      expect(head(team.home)).toBe(candidate)
      state.last = retried
    },
    STEP_TIMEOUT,
  )

  test(
    "undo while the user commits on the target: the target goes back to B, the user's commit is kept in a ref",
    async () => {
      const team = required(state.team)
      const integration = required(state.last)
      // The main works for a while, so the home is not at its safe point and the undo waits.
      await team.server.server.prompt(team.main, "[slow 8000]")
      await team.kit.until(async () => (await team.kit.active(team.server)).has(team.main), "the main never started")
      const started = await team.server.team("integration.undo", { integrationID: integration.id })
      write(team.home, { "notes/user.md": "the user's own commit\n" })
      const user = commit(team.home, "the user's commit")
      await team.server.server.waitIdle(team.main)
      // RH-20: an undo that waits does so outside its op (the op ends and frees the team's slot) and runs at its next
      // look (every 30 s) once the main is idle.
      const op = await team.kit.opEnd(team.server, started.opID, { timeoutMs: STEP_TIMEOUT })
      expect(op.state).toBe("done")
      await team.kit.until(
        async () => (await igOf(team, integration.id)).state === "undone",
        "the undo never ran after the main went idle",
        180_000,
      )
      expect((await igOf(team, integration.id)).undoing).toBeUndefined()
      expect(tip(team.home)).toBe(required(integration.base))
      expect(git(team.home, ["rev-parse", `refs/own/keep/${user}`]).trim()).toBe(user)
      expect(team.kit.notices(team.server, "undo.kept").length).toBeGreaterThan(0)
    },
    STEP_TIMEOUT,
  )

  test(
    "push: the plan shows the remote and the command and pushes nothing; a wrong nonce is refused; the confirm pushes",
    async () => {
      const team = required(state.team)
      const origin = required(state.origin)
      const before = git(origin, ["rev-parse", "refs/heads/main"]).trim()
      const plan = await team.server.team("integration.push.plan", { integrationID: required(state.done) })
      expect(plan).toMatchObject({ remote: "origin", ref: "main" })
      expect(plan.commands).toContain("git push origin main")
      expect(git(origin, ["rev-parse", "refs/heads/main"]).trim()).toBe(before)
      const wrong = `${plan.nonce.slice(0, -1)}${plan.nonce.endsWith("0") ? "1" : "0"}`
      expect(await team.server.rpc("own.team", "integration.push.execute", { nonce: wrong })).toMatchObject({
        status: 400,
        type: "nonce_invalid",
      })
      expect(git(origin, ["rev-parse", "refs/heads/main"]).trim()).toBe(before)
      const started = await team.server.team("integration.push.execute", { nonce: plan.nonce })
      const op = await team.kit.opEnd(team.server, started.opID)
      expect(op.state).toBe("done")
      expect(git(origin, ["rev-parse", "refs/heads/main"]).trim()).toBe(tip(team.home))
      expect(op.summary?.lines.some((line) => line.kind === "pushed")).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "mergeLocal ask: the advance waits for the confirm, then the target moves",
    async () => {
      const team = required(state.team)
      await team.server.team("settings.set", { teamID: team.teamID, patch: { policy: { mergeLocal: "ask" } } })
      const area = await areaOf(team, 1)
      write(area.directory, { "src/e2.ts": "export const e2 = 1\n" })
      await commitAndReady(team, 1, "e2")
      const base = tip(team.home)
      const started = await team.server.team("area.integrate", { teamID: team.teamID, areaID: area.id })
      const waiting = await team.kit.opEnd(team.server, started.opID, { waiting: true, timeoutMs: STEP_TIMEOUT })
      expect(waiting.state).toBe("waiting")
      expect(tip(team.home)).toBe(base)
      const view = await team.server.team("team.get", { directory: team.home })
      const confirm = required(view.pending.find((item) => item.opID === started.opID))
      await team.server.team("op.confirm", {
        opID: started.opID,
        stepID: confirm.stepID,
        choice: "do",
        nonce: confirm.nonce,
      })
      const op = await team.kit.opEnd(team.server, started.opID, { timeoutMs: STEP_TIMEOUT })
      expect(op.state).toBe("done")
      const integration = await igOf(team, started.integrationID)
      expect(integration.state).toBe("done")
      expect(tip(team.home)).toBe(required(integration.candidate))
      await team.server.team("settings.set", { teamID: team.teamID, patch: { policy: { mergeLocal: "auto" } } })
    },
    STEP_TIMEOUT,
  )

  test(
    "team_decide: the main's decision is recorded (6.6), nothing is written in the main folder",
    async () => {
      const team = required(state.team)
      const before = git(team.home, ["status", "--porcelain", "--untracked-files=all"])
      await team.server.turn(team.main, "[decide 반영은 메인이 정합니다]")
      const listed = await team.server.team("decisions.list", { teamID: team.teamID })
      expect(listed.items.map((item) => [item.title, item.source])).toContainEqual(["반영은 메인이 정합니다", "main"])
      expect(git(team.home, ["status", "--porcelain", "--untracked-files=all"])).toBe(before)
    },
    STEP_TIMEOUT,
  )
})

describe.skipIf(HOST || !lfs())("TG11 on F2 (LFS, code-only): a pointer conflict and a new top-level folder", () => {
  const state: { team?: Team; repo?: F2 } = {}

  beforeAll(async () => {
    const tools = await kit()
    const { F2_HEAVY, f2 } = await import("../fixtures/lfs-repo.js")
    const server = await tools.startTeamServer({
      name: "integrate-lfs",
      project: (root) => {
        state.repo = f2(root)
        return withCheck(state.repo.home)
      },
    })
    const viewed = await server.createSession({ title: "켠 대화" })
    const enabled = await tools.enableTeam(server, {
      hint: `[propose-areas 2 +check +heavy=${F2_HEAVY.join(",")}]`,
      sessionID: viewed,
    })
    const team = required(enabled.view.team ?? undefined)
    state.team = {
      kit: tools,
      server,
      teamID: team.id,
      main: team.main.sessionID,
      home: required(server.project),
      worktreeRoot: team.worktreeRoot,
      areas: enabled.view.areas.map((area) => area.id),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "two LFS pointers that conflict: a conflict without a smudge or a download, the target stays",
    async () => {
      const team = required(state.team)
      const repo = required(state.repo)
      const area = await areaOf(team, 0)
      expect(area.shape).toBe("code")
      write(area.directory, { "src/icons/logo.png": crypto.getRandomValues(new Uint8Array(3_000)) })
      await commitAndReady(team, 0, "logo in the area")
      write(team.home, {
        "src/icons/logo.png": crypto.getRandomValues(new Uint8Array(3_000)),
        "docs/news.md": "news from main\n",
      })
      const base = commit(team.home, "logo and news on main")
      const objects = repo.objects()
      const done = await byMain(team, 0)
      expect(done.integration).toMatchObject({ state: "conflict", base })
      expect(done.integration.conflicts).toContain("src/icons/logo.png")
      expect(tip(team.home)).toBe(base)
      expect(repo.objects()).toBe(objects)
    },
    STEP_TIMEOUT,
  )

  test(
    "a candidate that adds a top-level folder: the code-only verify folder takes it into its cone first; an untracked " +
      "file where K brings one keeps the area off the fast-forward (the owner gets the sync request)",
    async () => {
      const team = required(state.team)
      const area = await areaOf(team, 1)
      // A new top-level folder is outside the code-only cone until it is added (own's write guard does it for tools).
      git(area.directory, ["sparse-checkout", "add", "newtop"])
      write(area.directory, { "newtop/x.ts": "export const x = 1\n" })
      const source = await commitAndReady(team, 1, "newtop")
      // The owner's own notes where main added a file: git's fast-forward in this code-only folder would overwrite them.
      write(area.directory, { "docs/news.md": "the owner's notes\n" })
      const done = await byMain(team, 1)
      expect(done.integration).toMatchObject({ state: "done", how: "merge", source })
      const synced = team.kit
        .dispatches(db(team), team.teamID)
        .filter((item) => item.areaID === area.id && item.kind === "sync")
      expect(synced.map((item) => item.from)).toEqual(["team"])
      expect(head(area.directory)).toBe(source)
      expect(fs.readFileSync(path.join(area.directory, "docs", "news.md"), "utf8")).toBe("the owner's notes\n")
      expect(done.integration.verify.cone).toEqual({ ok: true, missing: [] })
      const verify = path.join(team.worktreeRoot, ".verify")
      const cone = team.kit.sparse(verify)
      expect(cone).toMatchObject({ enabled: true, cone: true })
      expect(cone.list).toContain("newtop")
      expect(cone.list).not.toContain("Assets/Textures")
      expect(fs.existsSync(path.join(verify, "newtop", "x.ts"))).toBe(true)
      expect(tip(team.home)).toBe(required(done.integration.candidate))
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** The team's code check in `home`: a `typecheck` script (`bun check.ts`) and a `bun.lock`, committed. */
function withCheck(home: string) {
  write(home, {
    "package.json": `${JSON.stringify({ name: "e2e", scripts: { typecheck: "bun check.ts" } }, null, 2)}\n`,
    "bun.lock": "{}\n",
    "check.ts": CHECK_SOURCE,
  })
  commit(home, "checks")
  return home
}

/** F1 with the team's code check (`typecheck` = `bun check.ts`, a `bun.lock`) and a bare `file://` remote. */
function checked(root: string) {
  const home = withCheck(f1(root).home)
  const origin = init(path.join(root, "origin.git"), { bare: true })
  git(home, ["remote", "add", "origin", pathToFileURL(origin).href])
  git(home, ["push", "-q", "origin", "main"])
  return { home, origin }
}

async function areaOf(team: Team, index: number) {
  const view = await team.server.team("team.get", { directory: team.home })
  return required(view.areas.find((area) => area.id === team.areas[index]))
}

/** The owner reports `ready` (7.1); returns the candidate own recorded. */
async function ready(team: Team, index: number) {
  const area = await areaOf(team, index)
  await team.server.turn(required(area.owner.sessionID ?? undefined), "[report ready 합칠 준비가 됐습니다]")
  return required((await areaOf(team, index)).candidate).sha
}

async function commitAndReady(team: Team, index: number, message: string) {
  const area = await areaOf(team, index)
  const source = commit(area.directory, message)
  expect(await ready(team, index)).toBe(source)
  return source
}

/** `[integrate area-n]` from the team main; the op and its integration once the op ended. */
async function byMain(team: Team, index: number) {
  const areaID = required(team.areas[index])
  const before = new Set(team.kit.ops(db(team), team.teamID).map((op) => op.id))
  await team.server.turn(team.main, `[integrate ${areaID.slice("ar_".length)}]`)
  const started = required(
    team.kit
      .ops(db(team), team.teamID)
      .find((op) => op.kind === "integrate" && op.areaID === areaID && !before.has(op.id)),
  )
  const op = await team.kit.opEnd(team.server, started.id, { waiting: true, timeoutMs: STEP_TIMEOUT })
  const integration = required(team.kit.integrations(db(team), team.teamID).findLast((item) => item.areaID === areaID))
  return { op, integration }
}

/** The user's `area.integrate` (also the retry of a waiting integration); the op and its integration once it ended. */
async function byUser(team: Team, index: number) {
  const started = await team.server.team("area.integrate", {
    teamID: team.teamID,
    areaID: required(team.areas[index]),
  })
  const op = await team.kit.opEnd(team.server, started.opID, { waiting: true, timeoutMs: STEP_TIMEOUT })
  return { op, integration: await igOf(team, started.integrationID) }
}

/** The user's integration of area `index`, done at once or after waiting for the home (in-use); its final record. */
async function goesIn(team: Team, index: number) {
  const started = await byUser(team, index)
  await team.kit.until(
    async () => (await igOf(team, started.integration.id)).state === "done",
    `area ${index}'s integration never went in`,
    180_000,
  )
  // The op that waited for the home ends a moment after its integration is done; the next area's integrate before
  // that is refused as `busy` (2.2.6-own.15 release tier).
  await team.kit.opEnd(team.server, started.op.id, { timeoutMs: 60_000 })
  return igOf(team, started.integration.id)
}

/** The main's team updates (`OwnTeam.UPDATE_META`), their reasons, oldest first. */
async function updatesOf(team: Team) {
  return (await team.kit.messages(team.server, team.main)).flatMap((message): Array<ReadonlyArray<string>> => {
    const update = (message.metadata as Record<string, unknown> | undefined)?.["own.team.update"]
    return message.type === "synthetic" && update ? [(update as { reasons?: ReadonlyArray<string> }).reasons ?? []] : []
  })
}

async function igOf(team: Team, integrationID: OwnTeam.IntegrationID) {
  return (await team.server.team("integration.get", { integrationID })).integration
}

function db(team: Team) {
  return team.server.server.paths.database
}

/** The target's tip (`main`). */
function tip(directory: string) {
  return git(directory, ["rev-parse", "refs/heads/main"]).trim()
}

function parents(directory: string, oid: string) {
  return git(directory, ["rev-list", "--parents", "-n", "1", oid]).trim().split(" ").slice(1)
}

function markersOf(directory: string, integrationID: string) {
  return git(directory, ["for-each-ref", "--format=%(refname)", `refs/own/integrate/${integrationID}/`])
    .split("\n")
    .filter(Boolean)
}

function markers(
  integrationID: string,
  oids: { readonly base: string; readonly source: string; readonly candidate: string },
) {
  return [
    { ref: `refs/own/integrate/${integrationID}/base`, oid: oids.base },
    { ref: `refs/own/integrate/${integrationID}/source`, oid: oids.source },
    { ref: `refs/own/integrate/${integrationID}/candidate`, oid: oids.candidate },
  ]
}

/** A path inside the folder's git dir (`rev-parse --git-path`). */
function gitPath(directory: string, name: string) {
  return path.resolve(directory, git(directory, ["rev-parse", "--git-path", name]).trim())
}

/** A commit on `branch` (made from `from`) that sets `file`, written with plumbing: no folder is touched. */
function sideCommit(directory: string, branch: string, from: string, file: string, content: string) {
  const blob = git(directory, ["hash-object", "-w", "--stdin"], { stdin: content }).trim()
  const env = { GIT_INDEX_FILE: gitPath(directory, `own-e2e-index-${process.pid}`) }
  git(directory, ["read-tree", from], { env })
  git(directory, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env })
  const tree = git(directory, ["write-tree"], { env }).trim()
  fs.rmSync(env.GIT_INDEX_FILE, { force: true })
  const made = git(directory, ["commit-tree", tree, "-p", from, "-m", `${branch}: ${file}`]).trim()
  git(directory, ["branch", "-q", branch, made])
  return made
}

/** The 7.2 fixture: B (`main`) and the area's C (`inv`) diverged; `Assets/` stands for a heavy folder. */
function line(root: string) {
  const home = init(path.join(root, "home"))
  write(home, {
    "README.md": "# line\n",
    "src/app.ts": "export const app = 1\n",
    "docs/guide.md": "guide\n",
    "Assets/big.bin": "x".repeat(4_096),
  })
  const start = commit(home, "start")
  const area = path.join(root, "team", "inv")
  git(home, ["worktree", "add", "-q", "-b", "inv", area, start])
  write(area, { "src/inventory.ts": "export const inventory = 1\n" })
  const source = commit(area, "inventory")
  write(home, { "docs/news.md": "news\n" })
  const base = commit(home, "news")
  return { home, area, start, source, base }
}

/** A code-only linked worktree (cone `src`, `docs`; `Assets/` left out) on a new branch at `at`. */
function codeOnly(home: string, directory: string, branch: string, at: string) {
  git(home, ["worktree", "add", "-q", "--no-checkout", "-b", branch, directory, at])
  git(directory, ["sparse-checkout", "set", "--cone", "src", "docs"])
  git(directory, ["reset", "-q", "--hard"])
  return directory
}

/** git without throwing: the exit code and stdout. */
function attempt(cwd: string, args: ReadonlyArray<string>) {
  const result = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

/** Two native paths name the same folder (case-insensitive on Windows, any separator). */
function same(a: string, b: string) {
  const normal = (value: string) => {
    const resolved = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normal(a) === normal(b)
}

/** git-lfs is installed (F2 needs it; dev-host has none, 06 §4.13). */
function lfs() {
  return Bun.spawnSync(["git", "lfs", "version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
