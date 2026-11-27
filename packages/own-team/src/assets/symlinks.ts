export * as Symlinks from "./symlinks.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import { Worktree } from "../git/worktree.js"
import type { Steps } from "../ops/steps.js"
import type { Services } from "../services.js"
import { NeedPaths } from "./need-paths.js"

/**
 * Link copies (06 §4.12). With `core.symlinks=false` (Windows without Developer Mode) git writes a mode-120000 entry as
 * a small file holding the link's target; this user's home instead holds a copy of the target (a file, or a whole
 * folder for a folder link) marked `--skip-worktree` (FORK §11), so the repository typechecks. Areas do the same:
 *
 *   - `plain` (and `full`) areas: copies with the home's flag ({@link detect}), as the home.
 *   - `code` areas: copies with `--assume-unchanged`. sparse-checkout owns the skip-worktree bit, so a hand-set one is
 *     cleared and `add -A` would commit the copies as type changes; assume-unchanged survives `sparse-checkout
 *     add/reapply/set` and `commit -a` never picks it up ([R-lazy] S/w, [R-adopt] symrepo). Entries outside the cone
 *     are not on disk and are left alone.
 *   - A folder copy's files would be untracked files to git (and `add -A` would replace the link with them), so each
 *     folder copy gets the pattern `/<path>/` in `<common dir>/info/exclude`. It only matches a real folder at that
 *     path, so a checkout that keeps git's link file is not affected. The file is shared, so the user's home sees the
 *     line too (its own folder copy is then ignored, FORK §11) until {@link unexclude} takes it out after own removed
 *     the last other folder that holds such a copy. Writes to the file go one at a time ({@link rewrite}).
 *
 * The flags blind `status` to edits of a copy ([R-review] e1, e2), so {@link apply} records what it wrote in
 * `area.linkCopies[path]`: the blob id (`git hash-object`) of a file copy, and for a folder copy a SHA-1 over its
 * files' relative paths and blob ids. {@link dirtyCopies} compares the disk with that record and is the one link-copy
 * clean check (hold refs, release, the `ready` check; integrate, retire and conversion later). A copy that differs is
 * dirty: removal and release stop, the hold ref takes its disk content (8.7), and a new {@link apply} never overwrites
 * it. {@link apply} rewrites a copy only when it is git's link file, missing, or still exactly what own recorded (a
 * synced target then gets a fresh copy).
 *
 * Nothing here changes the cone: a link whose target is outside a code-only area's cone stays git's link file until
 * the target folder is brought in and the copies are applied again ({@link refresh}, which `NeedPaths.apply` calls
 * right after the cone widens; the `link-fix` step kind does the same as an op step).
 */

/** `Team.env.symlinkFix`: how the home keeps its links. */
export type Fix = OwnTeam.Team["env"]["symlinkFix"]

/** The index flag an area's copies carry. */
export type Flag = "skip-worktree" | "assume-unchanged"

/** Why a link got no copy. */
export type Skip =
  /** The target leaves the repository (absolute, or `..` above the root). */
  | "outside"
  /** The target is a link itself, lies inside a folder link, or holds the link (a copy would copy itself). */
  | "chain"
  /** The target is not on disk (outside a code-only area's cone, or deleted). */
  | "target-missing"
  /** Neither a file nor a folder is at the link's path (a real symlink git made): nothing to fix. */
  | "symlink"

export type Applied =
  | {
      readonly ok: true
      /** The new `area.linkCopies`. */
      readonly linkCopies: Readonly<Record<string, string>>
      /** Copies written now: new ones, and clean ones whose target changed. */
      readonly written: ReadonlyArray<string>
      /** Copies that differ from the record and from the target: left as they are and recorded as dirty. */
      readonly kept: ReadonlyArray<string>
      readonly skipped: ReadonlyArray<{ readonly path: string; readonly why: Skip }>
    }
  | {
      readonly ok: false
      /** The folder is not the recorded worktree (06 §4.3, TI-14): the caller marks the area `broken`. */
      readonly error: "broken"
      readonly broken: "missing" | "identity"
      readonly message: string
    }
  | { readonly ok: false; readonly error: "git"; readonly message: string }

/** A link copy whose disk content is not what own recorded. `gone`: nothing is at its path any more. */
export interface Dirty {
  readonly path: string
  readonly why: "changed" | "gone"
}

/** What the copies of an area record: the folder and `area.linkCopies`. */
export interface Copies {
  readonly directory: string
  readonly linkCopies?: Readonly<Record<string, string>>
}

/** The step kind that applies an area's link copies again (after a sync changed a target, or a cone change). */
export const STEP = "link-fix"

/** Marks own's lines in `info/exclude`. */
export const EXCLUDE_HEADER = "# own.team link copies (06 §4.12)"

/**
 * How the home keeps its links (06 §3.2 환경, 4.12), from the link entries on disk: `none` without any (or when the home
 * keeps git's link files), `symlinks` when git made real links, else the flag the home's copies carry.
 */
export async function detect(
  home: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly fix: Fix } | { readonly ok: false; readonly message: string }> {
  const listed = await links(home, signal)
  if (!listed.ok) return listed
  const present = (
    await Promise.all(
      listed.links.map(async (link) => {
        const stat = await fs.lstat(native(home, link.path)).catch(() => undefined)
        return stat === undefined ? [] : [{ link, symbolic: stat.isSymbolicLink() }]
      }),
    )
  ).flat()
  if (present.some((item) => item.symbolic)) return { ok: true, fix: "symlinks" }
  if (present.some((item) => skipWorktree(item.link.tag))) return { ok: true, fix: "skip-worktree" }
  if (present.some((item) => assumeUnchanged(item.link.tag))) return { ok: true, fix: "assume-unchanged" }
  return { ok: true, fix: "none" }
}

/** The flag of an area's copies; `undefined`: the area keeps its links as git writes them. */
export function flag(shape: OwnTeam.Area["shape"], fix: Fix): Flag | undefined {
  if (fix !== "skip-worktree" && fix !== "assume-unchanged") return undefined
  return shape === "code" ? "assume-unchanged" : fix
}

/**
 * Writes the area's link copies and records them (06 §3.6 `symlink-fix`, §4.12). Observe → act: the identity check
 * first (TI-14), then per link entry: a copy is written over git's link file, a missing file, or own's clean copy whose
 * target changed; a copy that already equals its target is only flagged and recorded; anything else is kept as it is
 * and recorded as dirty (the old record, or the link blob when own never wrote it). Never changes the cone.
 */
export async function apply(input: {
  readonly area: Pick<OwnTeam.Area, "directory" | "gitDir" | "shape" | "linkCopies">
  readonly fix: Fix
  readonly signal?: AbortSignal
}): Promise<Applied> {
  const previous = input.area.linkCopies ?? {}
  const wanted = flag(input.area.shape, input.fix)
  if (wanted === undefined) return { ok: true, linkCopies: previous, written: [], kept: [], skipped: [] }
  const directory = input.area.directory
  const checked = await Identity.check({ directory, gitDir: input.area.gitDir })
  if (!checked.ok) return { ok: false, error: "broken", broken: checked.broken, message: checked.message }
  const listed = await links(directory, input.signal)
  if (!listed.ok) return failed(listed.message)
  // In a code-only area the entries outside the cone carry sparse-checkout's skip-worktree bit and are not on disk.
  const scope = listed.links.filter((link) => input.area.shape !== "code" || !skipWorktree(link.tag))
  const read = await texts(
    directory,
    scope.map((link) => link.oid),
    input.signal,
  )
  if (!read.ok) return failed(read.message)
  const all = listed.links.map((link) => link.path)
  const resolved = scope.map((link) => ({ link, source: source(link.path, read.texts.get(link.oid), all) }))
  const measured = await states(
    directory,
    [
      ...new Set([
        ...Object.keys(previous),
        ...scope.map((link) => link.path),
        ...resolved.flatMap((item) => (item.source.ok ? [item.source.path] : [])),
      ]),
    ],
    input.signal,
  )
  if (!measured.ok) return failed(measured.message)
  const plans = resolved.map((item) => plan(item.link, item.source, measured.states, previous[item.link.path]))

  const writes = plans.flatMap((item) => (item.do === "write" ? [item] : []))
  const copied = await Promise.all(writes.map((item) => copy(directory, item))).catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  )
  if (typeof copied === "string") return failed(`copy: ${copied}`)

  const ours = plans.flatMap((item) => (item.do === "write" || item.do === "flag" ? [item.path] : []))
  const tags = new Map(scope.map((link) => [link.path, link.tag]))
  const marked = await mark(directory, wanted, ours, tags, input.signal)
  if (!marked.ok) return failed(marked.message)
  const folders = plans.flatMap((item) =>
    (item.do === "write" || item.do === "flag") && item.kind === "dir" ? [item.path] : [],
  )
  const excluded = await exclude(directory, folders, input.signal)
  if (!excluded.ok) return failed(excluded.message)

  const recorded = await states(directory, ours, input.signal)
  if (!recorded.ok) return failed(recorded.message)
  const kept = plans.flatMap((item) => (item.do === "keep" ? [item] : []))
  const touched = new Set([...ours, ...kept.map((item) => item.path)])
  return {
    ok: true,
    linkCopies: {
      // Earlier records of copies that are still on disk stay checked (a link the area no longer has, a skipped one).
      ...Object.fromEntries(
        Object.entries(previous).filter(([file]) => !touched.has(file) && measured.states.has(file)),
      ),
      ...Object.fromEntries(
        ours.flatMap((file) => {
          const state = recorded.states.get(file)
          return state && state.kind !== "other" ? [[file, state.hash] as const] : []
        }),
      ),
      ...Object.fromEntries(kept.map((item) => [item.path, item.record] as const)),
    },
    written: writes.map((item) => item.path),
    kept: kept.map((item) => item.path),
    skipped: plans.flatMap((item) => (item.do === "skip" ? [{ path: item.path, why: item.why }] : [])),
  }
}

/**
 * The link-copy clean check (06 §4.12): recorded copies (inside `dirs` when given) whose disk content differs from
 * `area.linkCopies`. A copy that cannot be hashed counts as changed, so a clean check never passes on a guess.
 */
export async function dirtyCopies(area: Copies, dirs?: ReadonlyArray<string>): Promise<Dirty[]> {
  const recorded = Object.entries(area.linkCopies ?? {}).filter(
    ([file]) => dirs === undefined || dirs.some((dir) => file === dir || file.startsWith(`${dir}/`)),
  )
  if (recorded.length === 0) return []
  const measured = await states(
    area.directory,
    recorded.map(([file]) => file),
  )
  if (!measured.ok) return recorded.map(([file]) => ({ path: file, why: "changed" }))
  return recorded.flatMap(([file, sha]): Dirty[] => {
    const state = measured.states.get(file)
    if (state === undefined) return [{ path: file, why: "gone" }]
    if (state.kind === "other" || state.hash !== sha) return [{ path: file, why: "changed" }]
    return []
  })
}

/** The files of copies, repository-relative: a file copy itself, a folder copy's files (a hold ref takes these). */
export async function files(directory: string, copies: ReadonlyArray<string>) {
  const shapes = await Promise.all(copies.map((copy) => shape(directory, copy)))
  return shapes.flatMap((item) => item?.files ?? [])
}

/** A `link-fix` step for the area (by:auto, so Main 멈춤 does not skip it: it only restores copies, TI-13). */
export function spec(input: { readonly areaID: OwnTeam.AreaID }): Steps.Spec {
  return { kind: STEP, mode: "auto", args: { areaID: input.areaID } }
}

/** Registers the `link-fix` step kind once per controller. */
export function register(services: Services.Context) {
  if (!services.steps.get(STEP)) services.steps.register(KIND)
}

/**
 * The area's copies applied again and recorded (4.12), right after a sync or a cone change brought new targets or new
 * links: a copy that differs from its record is kept and keeps the `link.copy.dirty` notice open. Nothing to do for an
 * area that is not active or whose home keeps its links as git writes them.
 */
export async function refresh(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly signal?: AbortSignal },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const [team, area] = await Promise.all([
    services.registry.teams.get(input.teamID),
    services.registry.areas.get(input.teamID, input.areaID),
  ])
  if (!team || !area || area.state !== "active" || flag(area.shape, team.env.symlinkFix) === undefined)
    return { ok: true }
  const applied = await apply({ area, fix: team.env.symlinkFix, signal: input.signal })
  if (!applied.ok) return applied
  await NeedPaths.update(services, team.id, area.id, (current) => ({
    ...current,
    linkCopies: { ...applied.linkCopies },
  }))
  await notice(services, area, applied.kept)
  return { ok: true }
}

// ---------------------------------------------------------------------------------------------------------------

/** A mode-120000 index entry with its `ls-files -v` tag (`S` skip-worktree, lower case assume-unchanged). */
interface Link {
  readonly path: string
  readonly oid: string
  readonly tag: string
}

/** What is at a path: a file or folder with its hash (a folder's: {@link digest}), or something else. */
type State = { readonly kind: "file" | "dir"; readonly hash: string } | { readonly kind: "other" }

type Plan =
  | { readonly path: string; readonly do: "write"; readonly from: string; readonly kind: "file" | "dir" }
  | { readonly path: string; readonly do: "flag"; readonly kind: "file" | "dir" }
  | { readonly path: string; readonly do: "keep"; readonly record: string }
  | { readonly path: string; readonly do: "skip"; readonly why: Skip }

const Args = Schema.Struct({ areaID: OwnTeam.AreaID })
const decodeArgs = Schema.decodeUnknownOption(Args)

const NOTICE = "link.copy.dirty" as const

const KIND: Steps.Kind = {
  kind: STEP,
  observe: async (input) => {
    const found = await load(input)
    if (!found.ok) return found.observed
    if (flag(found.area.shape, found.team.env.symlinkFix) === undefined)
      return { state: "satisfied", note: "메인 폴더는 바로 가기를 Git이 쓴 그대로 둬요" }
    return { state: "pending" }
  },
  act: async (input) => {
    const found = await load(input)
    if (!found.ok) return { ok: false, note: "영역이나 팀을 찾을 수 없어요" }
    const applied = await apply({ area: found.area, fix: found.team.env.symlinkFix, signal: input.signal })
    if (!applied.ok) return { ok: false, note: applied.message }
    await NeedPaths.update(input.services, found.area.teamID, found.area.id, (current) => ({
      ...current,
      linkCopies: { ...applied.linkCopies },
    }))
    await notice(input.services, found.area, applied.kept)
    return {
      ok: true,
      note: `쓴 사본 ${applied.written.length}개 · 남긴 사본 ${applied.kept.length}개 · 건너뛴 바로 가기 ${applied.skipped.length}개`,
    }
  },
  // The copies are on disk and recorded once the area holds a `linkCopies` record.
  verify: async (input) => {
    const found = await load(input)
    if (!found.ok) return { ok: true }
    return found.area.linkCopies === undefined
      ? { ok: false, note: "바로 가기 파일 사본이 기록되지 않았어요" }
      : { ok: true }
  },
}

async function load(input: Steps.Input) {
  const args = Option.getOrUndefined(decodeArgs(input.step.args))
  if (!args) return { ok: false as const, observed: { state: "failed" as const, note: "단계 정보가 맞지 않아요" } }
  const [team, area] = await Promise.all([
    input.services.registry.teams.get(input.op.teamID),
    input.services.registry.areas.get(input.op.teamID, args.areaID),
  ])
  if (!team || !area || area.state === "retired")
    return { ok: false as const, observed: { state: "skip" as const, note: "영역을 찾을 수 없어요" } }
  if (area.state === "broken")
    return { ok: false as const, observed: { state: "failed" as const, note: "영역이 멈춰 있어요" } }
  return { ok: true as const, team, area }
}

/** Keeps the area's `link.copy.dirty` notice open while copies are kept (team.get shows it after a reload). */
async function notice(services: Services.Context, area: OwnTeam.Area, kept: ReadonlyArray<string>) {
  const others = (await services.notices.open(area.teamID)).filter(
    (item) => item.kind === NOTICE && item.areaID !== area.id,
  )
  const text = `${area.name}: 바로 가기 파일 사본 ${kept.length}개가 원래 내용과 달라 그대로 뒀어요`
  const data = { count: kept.length, paths: kept.slice(0, 5).join(", ") }
  await services.notices.keep(area.teamID, NOTICE, [
    ...others,
    ...(kept.length === 0
      ? []
      : [{ id: `${NOTICE}:${area.id}`, at: services.clock.now(), areaID: area.id, kind: NOTICE, text, data }]),
  ])
  if (kept.length > 0) services.notices.publish({ teamID: area.teamID, areaID: area.id, kind: NOTICE, text, data })
}

/** One link's decision; see {@link apply}. */
function plan(
  link: Link,
  target: ReturnType<typeof source>,
  measured: ReadonlyMap<string, State>,
  recorded: string | undefined,
): Plan {
  if (!target.ok) return { path: link.path, do: "skip", why: target.why }
  const from = measured.get(target.path)
  if (from === undefined || from.kind === "other") return { path: link.path, do: "skip", why: "target-missing" }
  const here = measured.get(link.path)
  if (here === undefined) return { path: link.path, do: "write", from: target.path, kind: from.kind }
  if (here.kind === "other") return { path: link.path, do: "skip", why: "symlink" }
  if (here.hash === from.hash) return { path: link.path, do: "flag", kind: from.kind }
  // own's clean copy of an older target, or the link file git wrote: nobody's work is in it.
  if (here.hash === recorded || (here.kind === "file" && here.hash === link.oid))
    return { path: link.path, do: "write", from: target.path, kind: from.kind }
  return { path: link.path, do: "keep", record: recorded ?? link.oid }
}

/** The repository path a link points at, by its blob text; links into links and out of the repository are refused. */
function source(
  link: string,
  text: string | undefined,
  links: ReadonlyArray<string>,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly why: Skip } {
  if (text === undefined || text === "" || /[\0\r\n]/.test(text)) return { ok: false, why: "outside" }
  const target = text.replaceAll("\\", "/")
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return { ok: false, why: "outside" }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(link), target)).replace(/\/+$/, "")
  if (joined === "" || joined === "." || joined === ".." || joined.startsWith("../"))
    return { ok: false, why: "outside" }
  const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`)
  if (links.some((other) => inside(other, joined)) || inside(joined, link)) return { ok: false, why: "chain" }
  return { ok: true, path: joined }
}

/** Writes one copy: git's link file (or own's old copy) is replaced by the target's file or folder. */
async function copy(directory: string, item: Extract<Plan, { do: "write" }>) {
  const to = native(directory, item.path)
  await fs.rm(to, { recursive: true, force: true })
  await fs.mkdir(path.dirname(to), { recursive: true })
  if (item.kind === "file") return fs.copyFile(native(directory, item.from), to)
  return fs.cp(native(directory, item.from), to, { recursive: true, verbatimSymlinks: true })
}

/** Sets `wanted` on `paths` and clears the other flag where an entry carries it. */
async function mark(
  directory: string,
  wanted: Flag,
  paths: ReadonlyArray<string>,
  tags: ReadonlyMap<string, string>,
  signal?: AbortSignal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  const has = (file: string, which: Flag) => {
    const tag = tags.get(file) ?? ""
    return which === "skip-worktree" ? skipWorktree(tag) : assumeUnchanged(tag)
  }
  const other: Flag = wanted === "skip-worktree" ? "assume-unchanged" : "skip-worktree"
  const steps = [
    { args: [`--${wanted}`], paths: paths.filter((file) => !has(file, wanted)) },
    { args: [`--no-${other}`], paths: paths.filter((file) => has(file, other)) },
  ].filter((step) => step.paths.length > 0)
  const failure = await steps.reduce<Promise<string | undefined>>(async (before, step) => {
    const earlier = await before
    if (earlier !== undefined) return earlier
    const result = await Git.run(["update-index", ...step.args, "-z", "--stdin"], {
      cwd: directory,
      worktree: true,
      write: true,
      stdin: Git.nul(step.paths),
      signal,
    })
    return result.ok ? undefined : `update-index ${step.args[0]}: ${result.message}`
  }, Promise.resolve(undefined))
  return failure === undefined ? { ok: true } : { ok: false, message: failure }
}

/** Adds `/<folder>/` for each folder copy to `<common dir>/info/exclude` (once; the user's lines stay as they are). */
async function exclude(
  directory: string,
  folders: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  if (folders.length === 0) return { ok: true }
  const common = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: directory,
    worktree: true,
    signal,
  })
  if (!common.ok) return { ok: false, message: common.message }
  await rewrite(common.stdout.trim(), (text) => {
    const lines = new Set(text.split(/\r?\n/))
    const missing = folders.map(pattern).filter((line) => !lines.has(line))
    if (missing.length === 0) return undefined
    const added = [...(lines.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER]), ...missing].join("\n")
    return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${added}\n`
  })
  return { ok: true }
}

/**
 * Takes own's `/<folder>/` lines for `copies` out of `<common dir>/info/exclude` again after own removed an area
 * folder (06 §3.8, §4.12, FORK §11). The file is shared by every worktree, the user's home included, so a line stays
 * while any other worktree but the team homes still has a folder at that path: a kept, adopted or turned-off area keeps
 * its copies, and without the line their files would be untracked and `add -A` would replace the link with them. The
 * user's lines stay; own's header goes once nothing follows it.
 */
export async function unexclude(input: {
  readonly commonDir: string
  /** The removed area's recorded copies (`area.linkCopies` keys); file copies never have a line. */
  readonly copies: ReadonlyArray<string>
  /** Team homes: their copies are the user's own (FORK §11) and do not keep a line. */
  readonly homes: ReadonlyArray<string>
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  if (input.copies.length === 0) return { ok: true }
  const listed = await Worktree.list(input.commonDir)
  if (!listed.ok) return { ok: false, message: listed.message }
  const others = listed.worktrees.filter((item) => !input.homes.some((home) => Identity.same(home, item.path)))
  const held = await Promise.all(
    input.copies.map(async (copy) => {
      const folders = await Promise.all(
        others.map((item) =>
          fs.stat(native(item.path, copy)).then(
            (stat) => stat.isDirectory(),
            () => false,
          ),
        ),
      )
      return folders.some(Boolean)
    }),
  )
  const drop = new Set(input.copies.filter((_, index) => !held[index]).map(pattern))
  if (drop.size === 0) return { ok: true }
  await rewrite(input.commonDir, (text) => {
    const lines = text.split(/\r?\n/)
    const header = lines.indexOf(EXCLUDE_HEADER)
    if (header < 0) return undefined
    const kept = lines.filter((line, index) => index <= header || !drop.has(line))
    if (kept.length === lines.length) return undefined
    const rest = kept.slice(header + 1).filter((line) => line !== "")
    const result = rest.length === 0 ? kept.filter((_, index) => index !== header) : kept
    const body = result.join("\n").replace(/\n+$/, "")
    return body === "" ? "" : `${body}\n`
  })
  return { ok: true }
}

/** The writes queued per `info/exclude` file ({@link rewrite}). */
const EXCLUDES = new Map<string, Promise<void>>()

/**
 * Read-modify-write of `<commonDir>/info/exclude`, one at a time per file in this process: link copies of several
 * areas (a cone change after a shell call, the relink after an integration, a need-paths call) may write at once, and
 * a lost line would let `add -A` commit a folder copy's files. `change` returns `undefined` to leave the file alone.
 * The one writer of that file in own.team: the shared folders' lines (`assets/shared.ts`, 06 §4.11) go through it too.
 */
export function rewrite(commonDir: string, change: (text: string) => string | undefined) {
  const file = path.join(commonDir, "info", "exclude")
  const key = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file)
  const work = async () => {
    const handle = Bun.file(file)
    const next = change((await handle.exists()) ? await handle.text() : "")
    if (next !== undefined) await Bun.write(handle, next)
  }
  const run = (EXCLUDES.get(key) ?? Promise.resolve()).then(work, work)
  const tracked = run.catch(() => undefined)
  EXCLUDES.set(key, tracked)
  void tracked.then(() => {
    if (EXCLUDES.get(key) === tracked) EXCLUDES.delete(key)
  })
  return run
}

/** An exclude pattern for exactly the folder at `folder` (gitignore specials escaped). */
function pattern(folder: string) {
  return `/${folder.replace(/[\\*?[\]!#]/g, "\\$&").replace(/ $/, "\\ ")}/`
}

/** Mode-120000 entries of the index (`ls-files -s -v -z`, a query: GIT_OPTIONAL_LOCKS=0). */
async function links(
  directory: string,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly links: Link[] } | { readonly ok: false; readonly message: string }> {
  const result = await Git.run(["ls-files", "-s", "-v", "-z"], { cwd: directory, worktree: true, signal })
  if (!result.ok) return { ok: false, message: result.message }
  return {
    ok: true,
    links: Porcelain.fields(result.stdout).flatMap((line) => {
      const match = /^(\S) 120000 ([0-9a-f]{40,64}) 0\t(.+)$/s.exec(line)
      return match ? [{ tag: match[1], oid: match[2], path: match[3] }] : []
    }),
  }
}

/** The text of each link blob (`cat-file --batch`). */
async function texts(
  directory: string,
  oids: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<
  { readonly ok: true; readonly texts: Map<string, string> } | { readonly ok: false; readonly message: string }
> {
  const unique = [...new Set(oids)]
  if (unique.length === 0) return { ok: true, texts: new Map() }
  const result = await Git.bytes(["cat-file", "--batch"], {
    cwd: directory,
    worktree: true,
    stdin: Git.lines(unique),
    signal,
  })
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, texts: batch(result.stdout) }
}

/** `cat-file --batch` output read by byte counts: `<oid> blob <size>\n<content>\n`, or `<oid> missing\n`. */
function batch(output: Uint8Array) {
  const decoder = new TextDecoder()
  const read = (at: number, found: Map<string, string>): Map<string, string> => {
    const end = output.indexOf(10, at)
    if (end < 0) return found
    const [oid = "", type, size] = decoder.decode(output.subarray(at, end)).split(" ")
    if (type !== "blob") return read(end + 1, found)
    const length = Number(size)
    found.set(oid, decoder.decode(output.subarray(end + 1, end + 1 + length)))
    return read(end + 2 + length, found)
  }
  return read(0, new Map())
}

/** What is at each path; one `hash-object --stdin-paths` for every file involved. Absent paths are not in the map. */
async function states(
  directory: string,
  paths: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<
  { readonly ok: true; readonly states: Map<string, State> } | { readonly ok: false; readonly message: string }
> {
  const shapes = (await Promise.all(paths.map((item) => shape(directory, item)))).filter((item) => item !== undefined)
  const all = [...new Set(shapes.flatMap((item) => item.files))]
  const hashed = await hashes(directory, all, signal)
  if (!hashed.ok) return hashed
  const oids = new Map(all.map((file, index) => [file, hashed.oids[index] ?? ""]))
  return {
    ok: true,
    states: new Map(
      shapes.map((item): readonly [string, State] => {
        if (item.kind === "other") return [item.path, { kind: "other" }]
        if (item.kind === "file") return [item.path, { kind: "file", hash: oids.get(item.path) ?? "" }]
        return [item.path, { kind: "dir", hash: digest(item.path, item.files, oids) }]
      }),
    ),
  }
}

/** A path's kind and the files it holds (a folder's, recursively; links inside are not followed). */
async function shape(directory: string, item: string) {
  const at = native(directory, item)
  const stat = await fs.lstat(at).catch(() => undefined)
  if (stat === undefined) return undefined
  if (stat.isFile()) return { path: item, kind: "file" as const, files: [item] }
  if (!stat.isDirectory()) return { path: item, kind: "other" as const, files: [] }
  const entries = await fs.readdir(at, { recursive: true, withFileTypes: true })
  return {
    path: item,
    kind: "dir" as const,
    files: entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .toSorted(),
  }
}

/** A folder copy's record: SHA-1 over `<path inside the folder>\0<blob id>\n`, sorted. */
function digest(folder: string, inner: ReadonlyArray<string>, oids: ReadonlyMap<string, string>) {
  const hasher = new Bun.CryptoHasher("sha1")
  inner
    .map((file) => `${file.slice(folder.length + 1)}\0${oids.get(file) ?? ""}\n`)
    .toSorted()
    .forEach((line) => hasher.update(line))
  return hasher.digest("hex")
}

/** `hash-object --stdin-paths` (with the filters `add` applies by path), one id per path. */
async function hashes(directory: string, paths: ReadonlyArray<string>, signal?: AbortSignal) {
  if (paths.length === 0) return { ok: true as const, oids: [] as string[] }
  const result = await Git.run(["hash-object", "--stdin-paths"], {
    cwd: directory,
    worktree: true,
    stdin: Git.lines(paths),
    signal,
  })
  if (!result.ok) return { ok: false as const, message: result.message }
  const oids = result.stdout.split("\n").filter(Git.isOid)
  if (oids.length !== paths.length) return { ok: false as const, message: "hash-object가 낸 id 수가 맞지 않아요" }
  return { ok: true as const, oids }
}

function skipWorktree(tag: string) {
  return tag === "S" || tag === "s"
}

/** `ls-files -v` prints lower case tags for assume-unchanged entries. */
function assumeUnchanged(tag: string) {
  return tag !== tag.toUpperCase()
}

function native(directory: string, file: string) {
  return path.join(directory, ...file.split("/"))
}

function failed(message: string) {
  return { ok: false as const, error: "git" as const, message }
}
