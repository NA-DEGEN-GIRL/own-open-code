/**
 * Integrate part 2 fixtures (06 §7.2 steps 8–9, §7.4, §7.5), on T1.03's `repo.ts`: a home (the primary worktree, `main`
 * checked out) and a code area `inv` (a linked worktree on its own branch). Steps 1–5 of 7.2 are reproduced here with
 * plain git (`merge-tree --write-tree`, `commit-tree`, create-only markers) so the tests start right before step 8; the
 * real steps are T2.07's. Repositories have local settings only; nothing outside the temp folder is written.
 */
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Advance } from "../../src/integrate/advance.js"
import { Keys } from "../../src/registry/keys.js"
import type { Services } from "../../src/services.js"
import { area, team } from "../support/context.js"
import { commit, git, head, init, write } from "./repo.js"

export const AREA = "inv"

export interface Repo {
  /** The primary worktree; `main` is checked out there. */
  readonly home: string
  readonly commonDir: string
  /** The area's linked worktree (`<root>/team/inv`) and its git dir. */
  readonly area: string
  readonly gitDir: string
  /** `main` before step 8 (B). */
  readonly base: string
  /** The area's reported candidate (C). */
  readonly source: string
}

/**
 * `main`: `README.md`, `src/app.ts`, `docs/guide.md`. The area adds `src/inventory.ts` (C). With `diverged`, `main`
 * then gets `docs/news.md`, so integrating C needs a merge commit; without it the integration is a fast-forward.
 */
export function fixture(root: string, options: { readonly diverged?: boolean } = {}): Repo {
  const home = init(path.join(root, "home"))
  write(home, { "README.md": "# advance\n", "src/app.ts": "export const app = 1\n", "docs/guide.md": "guide\n" })
  const start = commit(home, "start")
  const folder = path.join(root, "team", AREA)
  git(home, ["worktree", "add", "-q", "-b", AREA, folder, start])
  write(folder, { "src/inventory.ts": "export const inventory = 1\n" })
  const source = commit(folder, "inventory")
  if (options.diverged) write(home, { "docs/news.md": "news\n" })
  const base = options.diverged ? commit(home, "news") : start
  const commonDir = path.join(home, ".git")
  return { home, commonDir, area: folder, gitDir: path.join(commonDir, "worktrees", AREA), base, source }
}

/** 7.2 steps 3–4: K = C when B is an ancestor of C, else `merge-tree --write-tree` and `commit-tree -p B -p C`. */
export function merge(directory: string, base: string, source: string, integrationID: string) {
  const ff = Bun.spawnSync(["git", "-C", directory, "merge-base", "--is-ancestor", base, source]).exitCode === 0
  if (ff) return { candidate: source, how: "ff" as const }
  const tree = git(directory, ["merge-tree", "--write-tree", base, source]).split("\n")[0]!.trim()
  const candidate = git(directory, [
    "commit-tree",
    tree,
    "-p",
    base,
    "-p",
    source,
    "-m",
    `팀: ${AREA} 합치기 (${integrationID})`,
  ]).trim()
  return { candidate, how: "merge" as const }
}

/** 7.2 step 5: `refs/own/integrate/<ig>/{base,source,candidate}` in one create-only transaction. */
export function mark(
  directory: string,
  integrationID: string,
  oids: { base: string; source: string; candidate: string },
) {
  const [base, source, candidate] = Advance.markers(integrationID)
  git(directory, ["update-ref", "--stdin"], {
    stdin: [
      "start",
      `create ${base} ${oids.base}`,
      `create ${source} ${oids.source}`,
      `create ${candidate} ${oids.candidate}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  })
}

/** The markers that exist now, by name. */
export function markersLeft(directory: string, integrationID: string) {
  return git(directory, ["for-each-ref", "--format=%(refname)", `refs/own/integrate/${integrationID}/`])
    .split("\n")
    .filter(Boolean)
}

/** The tip of `branch` (`main` by default). */
export function tipOf(directory: string, branch = "main") {
  return git(directory, ["rev-parse", `refs/heads/${branch}`]).trim()
}

/** The team record of the fixture (`mergeLocal` as given) and the area record of `inv`. */
export function records(repo: Repo, options: { readonly mergeLocal?: OwnTeam.Policy["mergeLocal"] } = {}) {
  return {
    team: {
      ...team({ home: repo.home }),
      commonDir: repo.commonDir,
      policy: { ...OwnTeam.POLICY, directHold: false, mergeLocal: options.mergeLocal ?? "auto" },
    } satisfies OwnTeam.Team,
    area: {
      ...area({ slug: AREA, directory: repo.area }),
      gitDir: repo.gitDir,
      base: { sha: repo.base, at: 0 },
    } satisfies OwnTeam.Area,
  }
}

const encode = Schema.encodeSync(OwnTeam.Integration)

/**
 * An integration after steps 0–7 (verified, markers written) in KV, ready for step 8. `base` defaults to the fixture's
 * B; the candidate is computed from it.
 */
export async function prepare(
  services: Services.Base,
  repo: Repo,
  input: {
    readonly team: OwnTeam.Team
    readonly area: OwnTeam.Area
    readonly base?: string
    readonly newerSkipped?: number
  },
) {
  const id = OwnTeam.IntegrationID.create()
  const base = input.base ?? repo.base
  const merged = merge(repo.home, base, repo.source, id)
  mark(repo.commonDir, id, { base, source: repo.source, candidate: merged.candidate })
  const integration: OwnTeam.Integration = {
    id,
    teamID: input.team.id,
    areaID: input.area.id,
    state: "running",
    target: input.team.target,
    source: repo.source,
    base,
    candidate: merged.candidate,
    how: merged.how,
    ...(input.newerSkipped === undefined ? {} : { newerSkipped: input.newerSkipped }),
    verify: { code: { ok: true, ms: 1 }, assets: "skipped" },
    createdAt: 0,
  }
  await services.write(input.team.id, async () => {
    await services.registry.teams.put(input.team)
    await services.registry.areas.put(input.area)
    await services.kv.set(Keys.integration(input.team.id, id), Keys.toJson(encode(integration)))
  })
  return integration
}

/**
 * A stand-in for T2.07's steps 1–7 after the target moved (`Advance.Deps.restart`): B = the tip now, K made again,
 * the markers written again, the record updated. `moves` commits on `main` before it returns, so the target moves
 * again on the next look (the "moves every time" case).
 */
export function restarter(
  services: Services.Base,
  repo: Repo,
  options: { readonly moves?: boolean } = {},
): Advance.Deps["restart"] & { readonly calls: () => number } {
  const state = { calls: 0 }
  const restart = async (input: Parameters<Advance.Deps["restart"]>[0]) => {
    state.calls++
    const base = tipOf(repo.home)
    const merged = merge(repo.home, base, input.integration.source, input.integration.id)
    mark(repo.commonDir, input.integration.id, { base, source: input.integration.source, candidate: merged.candidate })
    await Advance.update(services, input.team.id, input.integration.id, (current) => ({
      ...current,
      base,
      candidate: merged.candidate,
      how: merged.how,
    }))
    if (options.moves) moveMain(repo, `move ${state.calls}`)
  }
  return Object.assign(restart, { calls: () => state.calls })
}

/**
 * Moves `main` by one commit that adds `moves/<name>.txt`: committed in the home when the home has `main` checked out
 * (only that file, other local changes stay), else made with `commit-tree` and `update-ref`, as another tool would.
 */
export function moveMain(repo: Repo, name: string) {
  const file = `moves/${name.replaceAll(" ", "-")}.txt`
  const symbolic = Bun.spawnSync(["git", "-C", repo.home, "symbolic-ref", "-q", "HEAD"], { stdout: "pipe" })
  if (symbolic.stdout.toString().trim() === "refs/heads/main") {
    write(repo.home, {
      [file]: `${name}
`,
    })
    git(repo.home, ["add", "--", file])
    git(repo.home, ["commit", "-q", "-m", name, "--", file])
    return head(repo.home)
  }
  const blob = git(repo.home, ["hash-object", "-w", "--stdin"], {
    stdin: `${name}
`,
  }).trim()
  const env = { GIT_INDEX_FILE: path.join(repo.commonDir, `own-test-index-${process.pid}`) }
  git(repo.home, ["read-tree", "refs/heads/main"], { env })
  git(repo.home, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env })
  const tree = git(repo.home, ["write-tree"], { env }).trim()
  fs.rmSync(env.GIT_INDEX_FILE, { force: true })
  const parent = tipOf(repo.home)
  const moved = git(repo.home, ["commit-tree", tree, "-p", parent, "-m", name]).trim()
  git(repo.home, ["update-ref", "refs/heads/main", moved, parent])
  return moved
}
