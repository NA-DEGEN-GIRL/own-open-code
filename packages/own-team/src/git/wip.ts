export * as Wip from "./wip.js"

import { Hold } from "../dispatch/hold.js"
import { Identity } from "./identity.js"
import { Refs } from "./refs.js"
import { Git } from "./run.js"

/**
 * WIP commits (06 §8.7 WIP 커밋). own does not commit the user's work by default: a step that needs a clean tree asks
 * the owner to commit (`from="team"`). Only an adopted folder without an owner conversation is the exception, and
 * only after the user chose it in a confirm. Then the commit is made with plumbing, so no hook runs and no working
 * file changes:
 *
 * ```text
 * hold  = Hold.create(scope, id)        the temporary index of 8.7 (`add -A --sparse`, every status path checked),
 *                                       kept as refs/own/hold/<scope>/<id> (TI-1: the copy exists before the branch moves)
 * T     = hold^{tree};  H = refs/heads/<branch>   the hold must sit on H (hold^1 == H), else the folder moved on
 * W     = commit-tree T -p H -m <message>          author and commit date = `at`, author own.team
 * update-ref refs/heads/<branch> W H               compare-and-swap: a branch that moved meanwhile stays untouched
 * reset -q --mixed                                 the index only, now W's tree; the working files are not touched
 * ```
 * Link copies (4.12) are never in T: their skip-worktree or assume-unchanged flag hides them from `add -A`, and a
 * folder copy is excluded, so W never turns a link into a file. `git add -A && git commit` is never used: it leaves
 * out untracked files outside the cone of a sparse folder, commits link copies as type changes, and runs hooks.
 *
 * A WIP commit is undone ({@link undo}) only while the branch is still W, with the same compare-and-swap; {@link find}
 * names W and its parent again from the op's hold ref.
 */

/** What makes a WIP commit. */
export interface Input {
  /** The folder and its recorded git dir: the identity check (4.3, TI-14) runs first. */
  readonly target: Identity.Record
  /** The branch the folder has checked out; W goes on `refs/heads/<branch>`. */
  readonly branch: string
  /** The hold ref's scope (`ar_<slug>`). */
  readonly scope: string
  /** The op id: names the hold ref and, with the message, recognizes W again after a restart. */
  readonly id: string
  /** Author and commit date in epoch milliseconds (`Op.createdAt`), so a retry makes the same commit. */
  readonly at: number
  readonly message: string
  readonly signal?: AbortSignal
}

export type Committed =
  /** W is on the branch and in the index. `created: false`: it was made before (a resumed step). */
  | {
      readonly ok: true
      readonly state: "committed"
      readonly sha: string
      readonly parent: string
      readonly created: boolean
      readonly hold: { readonly ref: string; readonly sha: string; readonly bytes: number }
    }
  /** No uncommitted work: nothing was made. */
  | { readonly ok: true; readonly state: "clean"; readonly parent: string }
  | {
      readonly ok: false
      /**
       * `identity`: not the recorded worktree; `branch`: the folder does not have the branch checked out (a detached
       * HEAD has no branch to commit on); `moved`: the branch is no longer where the copy was made; `conflict`: the
       * compare-and-swap failed, the branch is untouched; `verify`: a path is missing from the copy.
       */
      readonly error: "identity" | "branch" | "moved" | "conflict" | "git" | "verify"
      readonly message: string
    }

export type Undone =
  | { readonly ok: true; readonly state: "undone" }
  | {
      readonly ok: false
      readonly error: "identity" | "branch" | "moved" | "conflict" | "git"
      readonly message: string
    }

/** The identity W and the hold are written with (the hold's own, so no user setting is needed). */
const AUTHOR = { name: "own.team", email: "own.team@localhost" }

export async function commit(input: Input): Promise<Committed> {
  const checked = await Identity.check(input.target)
  if (!checked.ok) return { ok: false, error: "identity", message: checked.message }
  const directory = input.target.directory
  const parent = await branchHead(directory, input.branch, input.signal)
  if (!parent.ok) return parent
  const ref = Hold.ref(input.scope, input.id)
  const earlier = await made(directory, { ...input, tip: parent.sha, ref })
  if (earlier === undefined) return { ok: false, error: "git", message: `기록 이름을 읽지 못했어요: ${input.branch}` }
  if (earlier.state === "made") {
    const indexed = await index(directory, earlier.sha, input.signal)
    if (!indexed.ok) return indexed
    return {
      ok: true,
      state: "committed",
      sha: earlier.sha,
      parent: earlier.parent,
      created: false,
      hold: { ref, sha: earlier.hold, bytes: 0 },
    }
  }
  const changes = await Hold.changes(directory, input.signal)
  if (!changes.ok) return { ok: false, error: "git", message: changes.message }
  if (changes.paths.length === 0) return { ok: true, state: "clean", parent: parent.sha }
  const held = await Hold.create({
    target: input.target,
    scope: input.scope,
    id: input.id,
    at: input.at,
    links: [],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!held.ok) return { ok: false, error: held.error, message: held.message }
  const copy = await describe(directory, held.sha, input.signal)
  if (!copy) return { ok: false, error: "git", message: `변경 사본을 읽지 못했어요: ${held.ref}` }
  // An older copy (a resumed step) is used only while it still sits on the branch tip.
  if (copy.parent !== parent.sha)
    return { ok: false, error: "moved", message: `사본을 만든 뒤로 기록 이름 ${input.branch}의 기록이 바뀌었어요` }
  const date = `@${Math.floor(input.at / 1000)} +0000`
  const written = await Git.run(["commit-tree", "--no-gpg-sign", copy.tree, "-p", parent.sha, "-m", input.message], {
    cwd: directory,
    worktree: true,
    write: true,
    signal: input.signal,
    env: {
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
      GIT_COMMITTER_DATE: date,
    },
  })
  const sha = written.ok ? written.stdout.trim() : ""
  if (!written.ok || !Git.isOid(sha))
    return { ok: false, error: "git", message: `저장 지점을 만들지 못했어요: ${written.ok ? sha : written.message}` }
  const swapped = await swap(directory, { branch: input.branch, to: sha, from: parent.sha, id: input.id }, input.signal)
  if (!swapped.ok) return swapped
  const indexed = await index(directory, sha, input.signal)
  if (!indexed.ok) return indexed
  return {
    ok: true,
    state: "committed",
    sha,
    parent: parent.sha,
    created: true,
    hold: { ref: held.ref, sha: held.sha, bytes: held.bytes },
  }
}

/** Takes W back off the branch (to its parent) while the branch is still W; the working files stay as they are. */
export async function undo(input: {
  readonly target: Identity.Record
  readonly branch: string
  /** W. */
  readonly sha: string
  /** W's parent, where the branch goes back to. */
  readonly parent: string
  readonly signal?: AbortSignal
}): Promise<Undone> {
  const checked = await Identity.check(input.target)
  if (!checked.ok) return { ok: false, error: "identity", message: checked.message }
  const directory = input.target.directory
  const tip = await Refs.read(directory, `refs/heads/${input.branch}`)
  if (tip === undefined) return { ok: false, error: "git", message: `기록 이름을 읽지 못했어요: ${input.branch}` }
  if (tip === input.parent) return { ok: true, state: "undone" }
  if (tip !== input.sha)
    return {
      ok: false,
      error: "moved",
      message: `저장 지점을 넣은 뒤로 기록 이름 ${input.branch}의 기록이 바뀌었어요(지금 ${tip})`,
    }
  const swapped = await swap(
    directory,
    { branch: input.branch, to: input.parent, from: input.sha, id: "undo" },
    input.signal,
  )
  if (!swapped.ok) return swapped
  const head = await branchHead(directory, input.branch, input.signal)
  // A folder that left the branch keeps its index: only the branch moved back.
  if (!head.ok) return { ok: true, state: "undone" }
  const indexed = await index(directory, input.parent, input.signal)
  return indexed.ok ? { ok: true, state: "undone" } : indexed
}

/**
 * The WIP commit the op `id` made on `branch` (8.7), found again from its hold ref `refs/own/hold/<scope>/<id>`:
 * `made` while the branch tip is that commit (the hold's tree on the hold's parent, its message ending with the op id),
 * `undone` when the branch is back on the hold's parent, `none` without a hold ref, `moved` when the branch went on.
 */
export async function find(input: {
  readonly target: Identity.Record
  readonly branch: string
  readonly scope: string
  readonly id: string
  readonly signal?: AbortSignal
}): Promise<
  | { readonly ok: true; readonly state: "made"; readonly sha: string; readonly parent: string }
  | { readonly ok: true; readonly state: "undone" | "none" | "moved" }
  | { readonly ok: false; readonly message: string }
> {
  const directory = input.target.directory
  const [hold, tip] = await Promise.all([
    Refs.read(directory, Hold.ref(input.scope, input.id)),
    Refs.read(directory, `refs/heads/${input.branch}`),
  ])
  if (hold === undefined || tip === undefined)
    return { ok: false, message: `기록 이름을 읽지 못했어요: ${input.branch}` }
  if (hold === null) return { ok: true, state: "none" }
  const copy = await describe(directory, hold, input.signal)
  if (!copy) return { ok: false, message: `작업 ${input.id}의 변경 사본을 읽지 못했어요` }
  if (tip === copy.parent) return { ok: true, state: "undone" }
  const head = tip === null ? undefined : await describe(directory, tip, input.signal)
  if (tip === null || !head) return { ok: true, state: "moved" }
  const ours = head.parent === copy.parent && head.tree === copy.tree && head.message.endsWith(`(${input.id})`)
  return ours ? { ok: true, state: "made", sha: tip, parent: copy.parent } : { ok: true, state: "moved" }
}

/** The folder's HEAD must name `refs/heads/<branch>`; its commit. */
async function branchHead(
  directory: string,
  branch: string,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly error: "branch" | "git"; readonly message: string }
> {
  const name = `refs/heads/${branch}`
  if (!Refs.valid(name)) return { ok: false, error: "branch", message: `기록 이름으로 쓸 수 없어요: ${branch}` }
  const options = { cwd: directory, worktree: true, signal }
  const [symbolic, commit] = await Promise.all([
    Git.run(["symbolic-ref", "-q", "HEAD"], options),
    Git.run(["rev-parse", "--verify", "-q", "HEAD^{commit}"], options),
  ])
  if (!symbolic.ok || symbolic.stdout.trim() !== name)
    return { ok: false, error: "branch", message: `폴더가 기록 이름 ${branch}에 있지 않아요: ${directory}` }
  const sha = commit.ok ? commit.stdout.trim() : ""
  return Git.isOid(sha)
    ? { ok: true, sha }
    : { ok: false, error: "git", message: `폴더의 지금 위치를 읽지 못했어요: ${directory}` }
}

/**
 * A WIP commit an earlier attempt made (06 §8.5: observed, not trusted): the tip carries the message, sits on the hold's
 * parent and holds the hold's tree.
 */
async function made(
  directory: string,
  input: { readonly tip: string; readonly ref: string; readonly message: string; readonly signal?: AbortSignal },
): Promise<
  | { readonly state: "made"; readonly sha: string; readonly parent: string; readonly hold: string }
  | { readonly state: "none" }
  | undefined
> {
  const hold = await Refs.read(directory, input.ref)
  if (hold === undefined) return undefined
  if (hold === null) return { state: "none" }
  const [tip, copy] = await Promise.all([
    describe(directory, input.tip, input.signal),
    describe(directory, hold, input.signal),
  ])
  if (!tip || !copy) return undefined
  return tip.message === input.message.trim() && tip.parent === copy.parent && tip.tree === copy.tree
    ? { state: "made", sha: input.tip, parent: tip.parent, hold }
    : { state: "none" }
}

/** A commit's tree, first parent and message. */
async function describe(directory: string, sha: string, signal?: AbortSignal) {
  const shown = await Git.run(["log", "-1", "--format=%T%x00%P%x00%B", sha], {
    cwd: directory,
    worktree: true,
    signal,
  })
  if (!shown.ok) return undefined
  const [tree = "", parents = "", ...message] = shown.stdout.split("\0")
  return { tree, parent: parents.split(" ")[0] ?? "", message: message.join("\0").trim() }
}

/** `update-ref refs/heads/<branch> <to> <from>`: the old value makes it a real compare-and-swap (TI-10). */
async function swap(
  directory: string,
  input: { readonly branch: string; readonly to: string; readonly from: string; readonly id: string },
  signal?: AbortSignal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: "conflict"; readonly message: string }> {
  const moved = await Git.run(
    ["update-ref", "-m", `own.team: wip ${input.id}`, `refs/heads/${input.branch}`, input.to, input.from],
    { cwd: directory, worktree: true, write: true, signal },
  )
  return moved.ok
    ? { ok: true }
    : { ok: false, error: "conflict", message: `기록 이름을 옮기지 못했어요: ${moved.message}` }
}

/** `reset -q --mixed`: the index becomes HEAD's tree (`expected`); the working files are not touched. */
async function index(
  directory: string,
  expected: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: "git"; readonly message: string }> {
  const options = { cwd: directory, worktree: true, signal }
  const reset = await Git.run(["reset", "-q", "--mixed"], { ...options, write: true })
  if (!reset.ok)
    return { ok: false, error: "git", message: `저장 지점에 넣을 목록을 맞추지 못했어요: ${reset.message}` }
  const same = await Git.run(["diff-index", "--cached", "--quiet", expected, "--"], options)
  return same.ok
    ? { ok: true }
    : { ok: false, error: "git", message: `저장 지점에 넣을 목록이 저장 지점 ${expected}의 내용과 달라요` }
}
