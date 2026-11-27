export * as Merge from "./merge.js"

import { Cone } from "../git/cone.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"

/**
 * The git part of integrating an area (06 §7.1-§7.3, steps 1-5). Objects and refs only, run in the git common dir: no
 * folder is checked out, so nothing is smudged (`merge-tree --write-tree` writes no file) and neither the target
 * branch nor any worktree changes here. Merge attributes come from the target's tree (`--attr-source=<B>`), never
 * from what a sparse folder has on disk ([R-lazy], TG11).
 *
 *   1    B = rev-parse --verify refs/heads/<target>^{commit};  C = area.candidate.sha
 *   7.1  merge-base --is-ancestor C refs/heads/<area branch>    fails: the history was rewritten, ask for ready again
 *        rev-list --count C..refs/heads/<area branch>            commits after the candidate stay out (newerSkipped)
 *   2    merge-base --is-ancestor C B                            already merged
 *   3    merge-base --is-ancestor B C                            K = C (ff)
 *   4    --attr-source=<B> merge-tree --write-tree -z --name-only --no-messages B C
 *          exit 0: tree T, K = commit-tree T -p B -p C -m "팀: <영역 이름> 합치기 (<ig>)"; exit 1: conflict (7.3)
 *   5    update-ref --stdin: start / create refs/own/integrate/<ig>/{base,source,candidate} / prepare / commit
 *
 * K's author and commit dates are the integration's creation time, so making it again after a restart gives the same
 * commit (TI-11). It is not signed: a signing prompt cannot be answered from the service.
 *
 * The team update's 충돌 예상 (06 §5.6) runs step 4 over two area tips instead ({@link ahead}, {@link predict}).
 */

export type Failed = { readonly ok: false; readonly message: string }

/** The commit `refs/heads/<branch>` points at; `null` when the branch does not exist. */
export async function tip(
  repo: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly sha: string | null } | Failed> {
  if (!Refs.valid(`refs/heads/${branch}`)) return { ok: false, message: `기록 이름으로 쓸 수 없어요: ${branch}` }
  return commit(repo, `refs/heads/${branch}`, signal)
}

export type Placed =
  /** C is on the area's branch; `newerSkipped` commits came after it. */
  | { readonly ok: true; readonly state: "on-branch"; readonly newerSkipped: number }
  /** C is no longer on the branch (or gone): the owner reports `ready` again (7.1). */
  | { readonly ok: true; readonly state: "rewritten" }
  | Failed

/** 7.1: where the candidate `source` stands on the area's branch. */
export async function placed(input: {
  readonly repo: string
  readonly branch: string
  readonly source: string
  readonly signal?: AbortSignal
}): Promise<Placed> {
  const head = await tip(input.repo, input.branch, input.signal)
  if (!head.ok) return head
  if (head.sha === null) return { ok: false, message: `기록 이름이 없어요: ${input.branch}` }
  const exists = await commit(input.repo, input.source, input.signal)
  if (!exists.ok) return exists
  if (exists.sha === null) return { ok: true, state: "rewritten" }
  const on = await ancestor(input.repo, input.source, head.sha, input.signal)
  if (!on.ok) return on
  if (!on.yes) return { ok: true, state: "rewritten" }
  const newer = await Git.run(["rev-list", "--count", `${input.source}..${head.sha}`], {
    cwd: input.repo,
    worktree: true,
    signal: input.signal,
  })
  if (!newer.ok) return { ok: false, message: newer.message }
  return { ok: true, state: "on-branch", newerSkipped: Number(newer.stdout.trim()) || 0 }
}

/**
 * 7.1 without a candidate (the user's 이 영역 반영하기): the subjects of the commits `head` brings into `base`, newest
 * first, at most `limit`.
 */
export async function subjects(input: {
  readonly repo: string
  readonly base: string
  readonly head: string
  readonly limit?: number
  readonly signal?: AbortSignal
}): Promise<{ readonly ok: true; readonly subjects: string[] } | Failed> {
  const result = await Git.run(
    ["log", "-z", "--format=%s", `--max-count=${input.limit ?? 20}`, `${input.base}..${input.head}`],
    { cwd: input.repo, worktree: true, signal: input.signal },
  )
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, subjects: Porcelain.fields(result.stdout) }
}

export type Outcome =
  /** Step 2: C is already in B ("이미 합쳐져 있습니다"). */
  | { readonly ok: true; readonly how: "merged" }
  /** Step 3: B is behind C, K = C. */
  | { readonly ok: true; readonly how: "ff"; readonly candidate: string }
  /** Step 4: a merge commit K with parents B and C. */
  | { readonly ok: true; readonly how: "merge"; readonly candidate: string; readonly tree: string }
  /** 7.3: the conflicted paths, each once. */
  | { readonly ok: true; readonly how: "conflict"; readonly paths: ReadonlyArray<string> }
  | Failed

/** Steps 2-4 for B (`base`) and C (`source`); `at` dates K (epoch milliseconds). */
export async function compute(input: {
  readonly repo: string
  readonly base: string
  readonly source: string
  readonly message: string
  readonly at: number
  readonly signal?: AbortSignal
}): Promise<Outcome> {
  if (!Git.isOid(input.base) || !Git.isOid(input.source))
    return { ok: false, message: `저장 지점의 전체 이름이 아니에요: ${input.base} ${input.source}` }
  const merged = await ancestor(input.repo, input.source, input.base, input.signal)
  if (!merged.ok) return merged
  if (merged.yes) return { ok: true, how: "merged" }
  const behind = await ancestor(input.repo, input.base, input.source, input.signal)
  if (!behind.ok) return behind
  if (behind.yes) return { ok: true, how: "ff", candidate: input.source }
  const tree = await mergeTree({
    repo: input.repo,
    attrs: input.base,
    a: input.base,
    b: input.source,
    signal: input.signal,
  })
  if (!tree.ok) return tree
  if (!tree.clean) return { ok: true, how: "conflict", paths: tree.paths }
  const date = `@${Math.floor(input.at / 1000)} +0000`
  const made = await Git.run(
    ["commit-tree", "--no-gpg-sign", tree.tree, "-p", input.base, "-p", input.source, "-m", input.message],
    {
      cwd: input.repo,
      worktree: true,
      signal: input.signal,
      write: true,
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  )
  const candidate = made.ok ? made.stdout.trim() : ""
  if (!made.ok || !Git.isOid(candidate))
    return { ok: false, message: `합친 저장 지점을 만들지 못했어요: ${made.ok ? candidate : made.message}` }
  return { ok: true, how: "merge", candidate, tree: tree.tree }
}

/**
 * 06 §5.6 충돌 예상: the branches of `branches` that have commits the target lacks (`for-each-ref --no-merged`), by
 * name with their tips, and the target's commit. A branch that does not exist is left out.
 */
export async function ahead(input: {
  readonly repo: string
  readonly target: string
  readonly branches: ReadonlyArray<string>
}): Promise<{ readonly ok: true; readonly target: string; readonly tips: ReadonlyMap<string, string> } | Failed> {
  const base = await tip(input.repo, input.target)
  if (!base.ok) return base
  if (base.sha === null) return { ok: false, message: `기록 이름이 없어요: ${input.target}` }
  const refs = new Set(input.branches.map((branch) => `refs/heads/${branch}`).filter(Refs.valid))
  // Without a pattern `for-each-ref` would list every ref.
  if (refs.size === 0) return { ok: true, target: base.sha, tips: new Map() }
  const listed = await Git.run(
    ["for-each-ref", `--no-merged=${base.sha}`, "--format=%(refname)%00%(objectname)", ...refs],
    { cwd: input.repo, worktree: true },
  )
  if (!listed.ok) return { ok: false, message: listed.message }
  // A pattern also matches longer names below `<ref>/`: only the exact names count (as `Refs.read`).
  const tips = listed.stdout
    .split("\n")
    .map((line) => line.split("\0"))
    .filter((parts) => refs.has(parts[0]) && Git.isOid(parts[1] ?? ""))
    .map((parts) => [parts[0].slice("refs/heads/".length), parts[1]] as const)
  return { ok: true, target: base.sha, tips: new Map(tips) }
}

export interface Pair {
  readonly repo: string
  /** The target's commit: merge attributes come from its tree, as in step 4. */
  readonly attrs: string
  readonly a: string
  readonly b: string
}

/**
 * 06 §5.6 충돌 예상: whether integrating both area tips `a` and `b` would conflict, by step 4's merge-tree of the
 * pair. Commits never change, so the answer is kept per repository, attributes and unordered pair for the life of
 * the process (the oldest of {@link PREDICTED_MAX} goes first); a failure is asked again next time. A first run leaves
 * the merge's objects unreferenced for git's gc, as step 4 does; no ref, index or file changes.
 */
export function predict(input: Pair): Promise<Merged> {
  const key = pairKey(input)
  const known = PREDICTED.get(key)
  if (known) return known
  const [a, b] = [input.a, input.b].toSorted()
  const pending: Promise<Merged> = mergeTree({ repo: input.repo, attrs: input.attrs, a, b }).then((result) => {
    if (!result.ok && PREDICTED.get(key) === pending) PREDICTED.delete(key)
    return result
  })
  PREDICTED.set(key, pending)
  const oldest = PREDICTED.size > PREDICTED_MAX ? PREDICTED.keys().next().value : undefined
  if (oldest !== undefined) PREDICTED.delete(oldest)
  return pending
}

/** Whether {@link predict} has (or is getting) the answer for the pair, so asking costs no git run. */
export function predicted(input: Pair) {
  return PREDICTED.has(pairKey(input))
}

export const PREDICTED_MAX = 512

const PREDICTED = new Map<string, Promise<Merged>>()

function pairKey(input: Pair) {
  return [input.repo, input.attrs, ...[input.a, input.b].toSorted()].join("\0")
}

export type Merged =
  | { readonly ok: true; readonly clean: true; readonly tree: string }
  /** The conflicted paths, each once. */
  | { readonly ok: true; readonly clean: false; readonly paths: ReadonlyArray<string> }
  | Failed

/**
 * `--attr-source=<attrs> merge-tree --write-tree -z --name-only --no-messages a b`, in the git common dir: exit 0 is
 * the merged tree, exit 1 a conflict.
 */
async function mergeTree(input: Pair & { readonly signal?: AbortSignal }): Promise<Merged> {
  const result = await Git.run(
    [
      `--attr-source=${input.attrs}`,
      "merge-tree",
      "--write-tree",
      "-z",
      "--name-only",
      "--no-messages",
      input.a,
      input.b,
    ],
    { cwd: input.repo, worktree: true, signal: input.signal },
  )
  // `-z --name-only --no-messages`: the tree, then each conflicted path (a path with several stages may repeat).
  const [tree = "", ...paths] = Porcelain.fields(result.stdout)
  if (!result.ok && !(result.reason === "exit" && result.code === 1)) return { ok: false, message: result.message }
  if (!result.ok) return { ok: true, clean: false, paths: [...new Set(paths.filter(Boolean))] }
  if (!Git.isOid(tree)) return { ok: false, message: `합친 결과를 읽지 못했어요(merge-tree): ${tree}` }
  return { ok: true, clean: true, tree }
}

/** The merge commit message (7.2 step 4), on one line whatever the area's name holds. */
export function message(area: string, integrationID: string) {
  return `팀: ${area.replace(/\s+/g, " ").trim()} 합치기 (${integrationID})`
}

/**
 * 4.10 "코드 전용 영역의 후보 점검": what K changes in heavy folders compared with B. A deletion there stops the
 * integration (a tool that deleted the `.meta` files of assets missing from a code-only folder, committed by `git add
 * -A`, [R-assets] alt-arch); any other change is allowed only inside the folders the area fetched (`cone.extra`).
 */
export async function heavy(input: {
  readonly repo: string
  readonly base: string
  readonly candidate: string
  /** The team's heavy folders. */
  readonly heavy: ReadonlyArray<string>
  /** The area's fetched folders (`cone.extra` keys). */
  readonly extra: ReadonlyArray<string>
  readonly signal?: AbortSignal
}): Promise<
  { readonly ok: true; readonly deleted: ReadonlyArray<string>; readonly outside: ReadonlyArray<string> } | Failed
> {
  const dirs = input.heavy.map(Cone.normalize).filter(Boolean)
  if (dirs.length === 0) return { ok: true, deleted: [], outside: [] }
  const diff = await Git.run(
    ["diff", "--name-status", "-z", "--no-renames", input.base, input.candidate, "--", ...dirs],
    { cwd: input.repo, worktree: true, signal: input.signal, env: { GIT_LITERAL_PATHSPECS: "1" } },
  )
  if (!diff.ok) return { ok: false, message: diff.message }
  const fields = Porcelain.fields(diff.stdout)
  const changes = Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => ({
    status: fields[index * 2] ?? "",
    path: fields[index * 2 + 1] ?? "",
  }))
  return {
    ok: true,
    deleted: changes.filter((change) => change.status === "D").map((change) => change.path),
    outside: changes
      .filter((change) => change.status !== "D" && !Cone.covers(input.extra, change.path))
      .map((change) => change.path),
  }
}

/** `refs/own/integrate/<ig>/{base,source,candidate}` (06 §2.4). */
export function refs(integrationID: string) {
  const root = `refs/own/integrate/${integrationID}`
  return { base: `${root}/base`, source: `${root}/source`, candidate: `${root}/candidate` }
}

export interface Marks {
  readonly repo: string
  readonly integrationID: string
  readonly base: string
  readonly source: string
  readonly candidate: string
}

/** Step 5: the three refs in one create-only transaction; existing with the same values counts as done (resume). */
export function mark(input: Marks) {
  const names = refs(input.integrationID)
  return Refs.createAll(
    input.repo,
    [
      { ref: names.base, oid: input.base },
      { ref: names.source, oid: input.source },
      { ref: names.candidate, oid: input.candidate },
    ],
    `own.team: integrate ${input.integrationID}`,
  )
}

/** Whether the three refs hold these values; `undefined` when git could not answer. */
export async function marked(input: Marks) {
  const names = refs(input.integrationID)
  const values = await Promise.all([
    Refs.read(input.repo, names.base),
    Refs.read(input.repo, names.source),
    Refs.read(input.repo, names.candidate),
  ])
  if (values.some((value) => value === undefined)) return undefined
  return values[0] === input.base && values[1] === input.source && values[2] === input.candidate
}

/** `rev-parse -q --verify <rev>^{commit}`: the commit, or `null` when there is none. */
async function commit(
  repo: string,
  rev: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly sha: string | null } | Failed> {
  const result = await Git.run(["rev-parse", "-q", "--verify", `${rev}^{commit}`], {
    cwd: repo,
    worktree: true,
    signal,
  })
  // `-q --verify` exits 1 without output for a name that resolves to no commit.
  if (!result.ok) return result.reason === "exit" && result.code === 1 ? { ok: true, sha: null } : result
  const sha = result.stdout.trim()
  return Git.isOid(sha) ? { ok: true, sha } : { ok: false, message: `저장 지점을 읽지 못했어요(rev-parse): ${sha}` }
}

/** `merge-base --is-ancestor a b`: exit 0 is yes, 1 is no, anything else is an error (a missing object). */
async function ancestor(
  repo: string,
  a: string,
  b: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly yes: boolean } | Failed> {
  const result = await Git.run(["merge-base", "--is-ancestor", a, b], { cwd: repo, worktree: true, signal })
  if (result.ok) return { ok: true, yes: true }
  if (result.reason === "exit" && result.code === 1) return { ok: true, yes: false }
  return { ok: false, message: result.message }
}
