export * as AreaCreate from "./area-create.js"

import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { Model } from "@opencode/schema/model"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { OwnTeam, Preset } from "@own/protocol"
import { ProcessTree } from "@own/runtime"
import { BunCache } from "../assets/bun-cache.js"
import { Shared } from "../assets/shared.js"
import { Symlinks } from "../assets/symlinks.js"
import { Cone } from "../git/cone.js"
import { Home } from "../git/home.js"
import { Identity } from "../git/identity.js"
import { Lfs } from "../git/lfs.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { GitVersion } from "../git/version.js"
import { Worktree } from "../git/worktree.js"
import { JudgeValidate } from "../judge/validate.js"
import { Areas } from "../registry/area.js"
import { Teams } from "../registry/team.js"
import { RemoteLfs } from "../remote/lfs.js"
import { MainSession } from "../sessions/main.js"
import { TeamContext } from "../sessions/team-context.js"
import { Services } from "../services.js"
import { TeamHome } from "./home.js"
import { Steps } from "./steps.js"

/**
 * New areas (06 §3.6, §4.5, §8.2 새 영역) and area renames (8.2 이름 바꾸기, registry only): the step kinds of the T1
 * structural actions, registered in `create`, and `plan`, which turns one new area into op steps.
 *
 *   branch-create    `update-ref refs/heads/<name> <base> 0000…` (create-only; at the base already = done)
 *   worktree-create  the 4.5 procedure (`git/worktree.ts`: `worktree add --no-checkout --lock --reason
 *                    "own.team area:<id>"`, the cone of `code` areas, LFS fetch, `read-tree -mu HEAD`, checks), then
 *                    `worktree.refresh{projectID}` (4.5 step 7) through self-HTTP and the link copies when the home
 *                    keeps its links as copies (4.5 step 8, 4.12 `Symlinks.apply`; `team.env.symlinkFix`)
 *   area-record      the registry record: `main` absent (`팀과 같게`) or the model the user chose (영역 만들기,
 *                    2026-10-26, `chosenBy: "user"`), `preset` = the ★ of that model's group (10.1, read when planning,
 *                    so a team main without a model stops the plan before anything is made), `userMade` when the user
 *                    set the area up, status `preparing` while a setup command is to come, `linkCopies` = what the
 *                    copies hash to now (`Symlinks.apply` again: copies that equal their targets are only recorded)
 *   link-shared      the team's shared folders linked into the new folder (4.11, `assets/shared.ts`), when the team
 *                    has any; right after the record (the step reads it), before the owner starts
 *   owner-create     the owner session (`sessions/owner.ts`), on the 에이전트 방식 the user chose (2026-10-26)
 *   setup-run        `commands.setup` in the area folder with `BunCache.env` (own's Bun cache on the worktrees' volume,
 *                    4.12); its exit code and output go to `<common dir>/own/team/<teamID>/ops/<opID>/<stepID>.{exit,log}`,
 *                    so a restarted controller observes the result instead of running it again (06 §2.6 (d)); status
 *                    `준비 중(설치 약 N분)`
 *   area-rename      the area's name (and subtitle) in the registry, and since 2026-11-17 the role and the user-made
 *                    mark a rename that reuses the area carries (a new role reaches the owner at once); the step keeps
 *                    what was there before (for an undo)
 *
 * On an SSH host (`Git.tools()`, 4.13) the plan starts with `lfs-remote` while the repository's LFS filter is not the
 * bundled git-lfs, and answers `lfs_missing` while the tool is not on the host (`RemoteLfs.plan`).
 *
 * The folder is `<worktreeRoot>/<name>` and the branch `<name>`, where `name` is the slug or, when the area id, the
 * branch or a non-empty folder is taken, `<slug>-2`, `-3`, … (V6, 4.5). `plain` (no sparse checkout) without heavy
 * folders or on Git 2.40-2.41; the heavy folders are the team's list grown by those of the base commit (06 §4.4, so
 * assets that came after enable stay out of a new area at once). A `#` in the root or a folder inside another worktree
 * is `path_forbidden` (4.12, 8.6), except the one a `<home>/.worktrees` root sits in (프로젝트 안, 2026-10-27): there
 * `worktree-create` first puts `/.worktrees/` in `info/exclude` (`TeamHome.exclude`) and own's `.gitignore` in the root
 * (`Home.ignore`, 2026-10-27: core's snapshots read no `info/exclude`), and a linked holder the main
 * folder moved off is locked first (`team.lock`, `own: nested worktrees inside`).
 * Large downloads are never automatic (V11): heavy folders an area `needs` are left to `team_need_paths` when their
 * missing large files reach `askDownloadBytes`, and an area whose own cone alone reaches it is refused.
 * A model the user chose for the area (`main`) is checked against the team's R4 when planning, with the new area as one
 * more holder (`TeamContext.breaks`, as `area.main` checks it): another subscription of a team company refuses the item.
 *
 * Callers put the `setup-run` steps after every other step ({@link order}), so one area's install never holds back
 * the next area's folder and owner.
 */

export const KIND = {
  branch: "branch-create",
  worktree: "worktree-create",
  record: "area-record",
  owner: "owner-create",
  setup: "setup-run",
  rename: "area-rename",
} as const

/** A setup command gets at most this long (06 §2.6: long child processes are op steps). */
export const SETUP_TIMEOUT_MS = 30 * 60 * 1000

/** `준비 중(설치 약 N분)` when no earlier setup run of the team says better. */
const SETUP_MINUTES = 3

/** The reason recorded for heavy folders an area got at its creation (`cone.extra`, 06 §2.4). */
const NEEDS_REASON = "영역을 만들 때 필요"

export function create(services: Services.Context): Services.AreaCreate {
  // A reorganization that recorded a new area or renamed one can be undone (06 §8.2, `Steps.Kind.reverses`).
  for (const kind of kinds())
    services.steps.register(kind.kind === KIND.record || kind.kind === KIND.rename ? { ...kind, reverses: true } : kind)
  // `link-fix` applies an area's copies again after a sync or a cone change (4.12); registered with the area kinds.
  Symlinks.register(services)
  // The other kinds a plan has: `link-shared` (4.11) and, on an SSH host, `lfs-remote` (4.13); each once.
  Shared.register(services)
  RemoteLfs.register(services)
  return { plan: (input) => plan(services, input) }
}

/** The `setup-run` steps last, every other step in its order. */
export function order(steps: ReadonlyArray<Steps.Spec>) {
  return [...steps.filter((step) => step.kind !== KIND.setup), ...steps.filter((step) => step.kind === KIND.setup)]
}

/**
 * 영역 만들기's `만들 곳` (`area.create.check`, 06 §9.4, 2026-10-27): the folder and record name {@link plan} gives a new
 * area of `slug` now (V6, {@link free}), and what held the name asked for when it is another. The name is the V-rules'
 * (`JudgeValidate.slugify`: `fresh-` is `fresh`, `a--b` is `a-b`), since the proposal reaches the plan through them.
 * Reads only.
 */
export async function check(
  services: Services.Context,
  input: { readonly teamID: string; readonly slug: string },
): Promise<Services.Result<{ readonly slug: string; readonly directory: string; readonly taken?: Taken }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  if (team.worktreeRoot.includes("#"))
    return Services.failure("path_forbidden", `영역 폴더 위치에 '#'이 있어요: ${team.worktreeRoot}`, {
      path: team.worktreeRoot,
      why: "hash",
    })
  const slug = JudgeValidate.slugify(input.slug)
  if (!slug)
    return Services.failure("invalid_proposal", `영역 이름으로 쓸 수 없어요: '${input.slug}'`, {
      rejected: [{ item: input.slug, why: `영역 이름으로 쓸 수 없어요: '${input.slug}'` }],
    })
  const name = await free(services, team, slug)
  if (!name.ok) return name
  return {
    ok: true,
    slug: name.name,
    directory: path.join(team.worktreeRoot, name.name),
    ...(name.taken === undefined ? {} : { taken: name.taken }),
  }
}

/** What holds a name V6 passes over (4.5): an area of the team (a finished one too), a branch, a non-empty folder. */
type Taken = "area" | "branch" | "folder"

/** Writes an area record and announces it (`area.changed`); inside the team's mutex (`Services.Base.write`). */
export async function save(services: Services.Context, area: OwnTeam.Area) {
  const rev = await services.registry.areas.put(area)
  if (rev === undefined) return
  services.hub.publish({
    name: "area.changed",
    data: { teamID: area.teamID, areaID: area.id, rev, status: area.status, paused: area.paused },
  })
}

async function plan(
  services: Services.Context,
  input: Services.AreaPlan,
): Promise<Services.Result<{ readonly areaID: OwnTeam.AreaID; readonly steps: ReadonlyArray<Steps.Spec> }>> {
  const team = input.team
  const home = team.home.directory
  if (team.worktreeRoot.includes("#"))
    return Services.failure("path_forbidden", `영역 폴더 위치에 '#'이 있어요: ${team.worktreeRoot}`, {
      path: team.worktreeRoot,
      why: "hash",
    })
  if (!Schema.is(OwnTeam.Slug)(input.slug))
    return Services.failure("path_forbidden", `영역 이름으로 쓸 수 없어요: ${input.slug}`, {
      path: input.slug,
      why: "invalid",
    })
  const version = await GitVersion.check(home)
  if (!version.ok) return refused(version, home)
  const listed = await Worktree.list(home)
  if (!listed.ok) return Services.failure("not_git", listed.message, { directory: home })
  const name = await free(services, team, input.slug)
  if (!name.ok) return name
  const directory = path.join(team.worktreeRoot, name.name)
  // 4.12 (2026-10-27): a root inside the main folder (`<home>/.worktrees`) nests areas there on purpose; any other
  // worktree around the new folder refuses it, since removing that one would take the area along (8.6).
  const holder = Home.holder(team.worktreeRoot)
  const around = listed.worktrees.filter((item) => Identity.inside(item.path, directory))
  const outer = around.filter((item) => holder === undefined || !Identity.same(item.path, holder))
  if (outer.length > 0)
    return Services.failure("path_forbidden", `다른 작업 폴더 안이에요: ${directory}`, {
      path: directory,
      why: "nested",
    })
  // The main folder moved off the folder that holds the root (team.home): that linked worktree keeps a lock while it
  // holds areas (TI-12), as the outer folder of an adopted nested area does (3.7).
  const unguarded = around.find(
    (item) => item !== listed.worktrees[0] && !Identity.same(item.path, home) && item.locked === undefined,
  )
  const base = await baseOf(services, team, input.from)
  if (!base.ok) return base
  const heavy = await heavyAt(services, team, base.sha)
  const shape = heavy.length > 0 && version.shape === "code" ? "code" : "plain"
  const needs = shape === "code" ? wanted(heavy, input.needs ?? []) : []
  const cone = await coneOf({ team, heavy, base: base.sha, shape, needs })
  if (!cone.ok) return cone
  const preset = await presetOf(services, team, input.main)
  if (!preset.ok) return preset
  // 4.13: on an SSH host the repository's LFS filter is the bundled git-lfs before a folder is made (a repository that
  // started using LFS after enable included); without the tool nothing is planned.
  const remote = Git.tools() === undefined ? undefined : await RemoteLfs.plan({ directory: home, home: services.home })
  if (remote && !remote.ok) return remote
  const areaID = Areas.id(name.name)
  if (input.main) {
    const fits = await r4(services, { team, areaID, main: input.main, presetID: preset.presetID })
    if (!fits.ok) return fits
  }
  return {
    ok: true,
    areaID,
    steps: [
      ...(remote?.steps ?? []),
      ...(unguarded === undefined
        ? []
        : [{ kind: TeamHome.LOCK, args: { directory: unguarded.path, reason: TeamHome.NESTED } }]),
      { kind: KIND.branch, args: { areaID, home, branch: name.name, base: base.sha } },
      {
        kind: KIND.worktree,
        args: {
          areaID,
          home,
          directory,
          branch: name.name,
          base: base.sha,
          shape,
          cone: cone.dirs,
          heavy: [...heavy],
          projectID: team.projectID,
        },
      },
      {
        kind: KIND.record,
        args: {
          areaID,
          name: input.name,
          goal: input.goal ?? "",
          directory,
          branch: name.name,
          base: base.sha,
          shape,
          extra: cone.extra,
          preset: preset.presetID,
          setup: team.commands.setup !== null,
          ...(version.reason === undefined ? {} : { oldGit: version.version.text }),
          ...(input.main === undefined ? {} : { main: input.main }),
          ...(input.userMade ? { userMade: true } : {}),
        },
      },
      // 4.11: the team's shared folders linked in once the folder is recorded, before its owner starts.
      ...(team.shared.some((record) => record.protect !== "none") ? [Shared.linkSpec({ areaID })] : []),
      { kind: KIND.owner, args: { areaID, ...(input.harness === undefined ? {} : { harness: input.harness }) } },
      ...(team.commands.setup === null ? [] : [{ kind: KIND.setup, args: { areaID } }]),
    ],
  }
}

/**
 * The first of `<slug>`, `<slug>-2`, … that no area id, branch or non-empty folder uses (V6, 4.5), and what held `slug`
 * itself when it is another.
 */
async function free(
  services: Services.Context,
  team: OwnTeam.Team,
  slug: string,
): Promise<Services.Result<{ readonly name: string; readonly taken?: Taken }>> {
  const used = new Set<string>((await services.registry.areas.list(team.id)).map((area) => area.id))
  const candidate = (index: number) => {
    if (index === 0) return slug
    const suffix = `-${index + 1}`
    return `${slug.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`
  }
  const search = async (
    index: number,
    taken?: Taken,
  ): Promise<Services.Result<{ readonly name: string; readonly taken?: Taken }>> => {
    if (index >= 20)
      return Services.failure("invalid_proposal", `쓸 수 있는 이름이 없어요: ${slug}`, {
        rejected: [{ item: slug, why: "같은 이름이 너무 많아요" }],
      })
    const name = candidate(index)
    if (used.has(`ar_${name}`)) return search(index + 1, taken ?? "area")
    const branch = await Refs.read(team.home.directory, `refs/heads/${name}`)
    if (branch === undefined)
      return Services.failure("not_git", `기록 이름 목록을 읽지 못했어요: ${team.home.directory}`, {
        directory: team.home.directory,
      })
    if (branch !== null) return search(index + 1, taken ?? "branch")
    const folder = path.join(team.worktreeRoot, name)
    if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) return search(index + 1, taken ?? "folder")
    return { ok: true, name, ...(taken === undefined ? {} : { taken }) }
  }
  return search(0)
}

/**
 * The commit a new branch starts at: the target's tip, or another area's (`from`: its slug or branch). A finished
 * area's branch stays (8.2), so a new area may start there too (다시 만들기, 8.2, 8.8); a live area of that name comes
 * first. An area whose branch is gone (`branch-gone`, 8.8) or not made yet (`deferredName`) refuses the item.
 */
async function baseOf(
  services: Services.Context,
  team: OwnTeam.Team,
  from: string | undefined,
): Promise<Services.Result<{ readonly sha: string }>> {
  const target = from === undefined || from === "main" || from === team.target
  const named = (item: OwnTeam.Area) => item.id === `ar_${from}` || item.branch === from
  const areas = target ? [] : await services.registry.areas.list(team.id)
  const area = areas.find((item) => item.state !== "retired" && named(item)) ?? areas.find(named)
  if (!target && !area) return Services.failure("not_found", `영역이 없어요: ${from}`, { what: "area", id: from })
  const ref = `refs/heads/${area?.branch ?? team.target}`
  const sha = await Refs.read(team.home.directory, ref)
  if (sha === null && area)
    return Services.failure("invalid_proposal", `기록이 없어요: ${ref}`, {
      rejected: [{ item: area.id, why: `'${area.name}'의 기록을 찾을 수 없어 그 기록으로 만들 수 없어요` }],
    })
  if (!sha) return Services.failure("internal_error", `기록을 읽지 못했어요: ${ref}`, {})
  return { ok: true, sha }
}

/**
 * A new area's preset (10.1): the ★ of the group of its area main, which is the model the user chose (영역 만들기) or
 * `팀과 같게` = the team main's current Ref. Read before anything is made, so a team main without a model or a preset
 * group stops the plan, not a half-made area.
 */
async function presetOf(
  services: Services.Context,
  team: OwnTeam.Team,
  main: Model.Ref | undefined,
): Promise<Services.Result<{ readonly presetID: Preset.ID }>> {
  const model = main ?? (await services.features().main.model(team.id))
  if (!model) return Services.failure("internal_error", "팀 메인의 모델을 알 수 없어요", {})
  const kind = await MainSession.group(services, model)
  if (!kind) return Services.failure("internal_error", `이 회사의 프리셋 묶음이 없어요: ${model.providerID}`, {})
  return { ok: true, presetID: await MainSession.star(services, kind) }
}

/** The refusal of a model that would be another subscription of a company the team has (06 §10.1 팀 전체 R4). */
export const SAME_COMPANY = "같은 회사의 다른 구독 계정은 팀에 넣을 수 없어요"

/**
 * Team R4 (06 §10.1) for a new area on a model the user chose: the team's holders plus the new area (its model and its
 * preset), judged as `area.main` judges a change (`TeamContext.breaks`). A team whose accounts cannot be read refuses
 * the item too (the closed side, U5).
 */
async function r4(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly areaID: OwnTeam.AreaID
    readonly main: Model.Ref
    readonly presetID: Preset.ID
  },
): Promise<Services.Result> {
  const refuse = (why: string) => Services.failure("invalid_proposal", why, { rejected: [{ item: input.areaID, why }] })
  const snapshot = await TeamContext.load(services, input.team.id)
  if (!snapshot) return refuse("계정 정보를 읽지 못해 이 모델로 영역을 만들 수 없어요")
  const holder: TeamContext.Holder = {
    areaID: input.areaID,
    ref: input.main,
    account: snapshot.account(input.main.providerID),
    preset: snapshot.preset(input.presetID),
  }
  const next = { ...snapshot.state, holders: [...snapshot.state.holders, holder] }
  return TeamContext.breaks(snapshot.state, next) === undefined ? { ok: true } : refuse(SAME_COMPANY)
}

/**
 * The heavy list a new area is made by (06 §4.4 G7): the team's list, grown by the heavy folders its base commit has
 * that the list does not (a project whose assets came after enable). Without that, a team without heavy folders made
 * every new area a full checkout of them, or refused it once their download reached `askDownloadBytes`. The team's
 * list itself is written by the `heavy` op that follows (`assets/heavy.ts`), which shares this measurement.
 */
async function heavyAt(services: Services.Context, team: OwnTeam.Team, base: string) {
  if (base === team.heavy.measuredAt) return team.heavy.dirs
  const grown = await services.features().heavy.growth({ team, rev: base })
  return grown.ok ? grown.dirs : team.heavy.dirs
}

/** Heavy folders an area asks for: inside a heavy folder, written as a repository folder (no `..`, `/` or `-` lead). */
function wanted(heavy: ReadonlyArray<string>, needs: ReadonlyArray<string>) {
  const valid = needs
    .filter(
      (dir) => !dir.startsWith("/") && !dir.startsWith("-") && !dir.replaceAll("\\", "/").split("/").includes(".."),
    )
    .map(Cone.normalize)
    .filter((dir) => dir !== "" && Cone.covers(heavy, dir))
  return [...new Set(valid)]
}

/**
 * The creation cone (`code`: the complement of the heavy folders plus `needs`) and the missing large files it would
 * download (4.5 step 3). `needs` that reach `askDownloadBytes` are left out (fetched later with a confirm, 4.6); a cone
 * that reaches it without them is refused (V11). `extra`: the needs kept, with their missing bytes.
 */
async function coneOf(input: {
  readonly team: OwnTeam.Team
  /** The heavy list the area is made by ({@link heavyAt}). */
  readonly heavy: ReadonlyArray<string>
  readonly base: string
  readonly shape: "code" | "plain"
  readonly needs: ReadonlyArray<string>
}): Promise<
  Services.Result<{ readonly dirs: ReadonlyArray<string>; readonly extra: Readonly<Record<string, number>> }>
> {
  const home = input.team.home.directory
  const compute = async (needs: ReadonlyArray<string>) => {
    if (input.shape === "plain") return { ok: true as const, dirs: [] as string[] }
    return Cone.compute(home, input.base, input.heavy, needs)
  }
  const download = async (dirs: ReadonlyArray<string>) => {
    if (input.team.env.lfs === "unused") return { ok: true as const, count: 0, bytes: 0, objects: [] }
    return Lfs.missing(home, input.base, input.shape === "plain" ? () => true : Cone.matcher(dirs))
  }
  const limit = input.team.policy.askDownloadBytes
  const full = await compute(input.needs)
  if (!full.ok) return Services.failure("internal_error", full.message, {})
  const missing = await download(full.dirs)
  if (!missing.ok) return Services.failure("internal_error", missing.message, {})
  if (missing.count === 0 || missing.bytes < limit)
    return { ok: true, dirs: full.dirs, extra: bytesOf(input.needs, missing.objects) }
  if (input.needs.length === 0) return tooLarge(missing.bytes)
  const lean = await compute([])
  if (!lean.ok) return Services.failure("internal_error", lean.message, {})
  const rest = await download(lean.dirs)
  if (!rest.ok) return Services.failure("internal_error", rest.message, {})
  if (rest.count > 0 && rest.bytes >= limit) return tooLarge(rest.bytes)
  return { ok: true, dirs: lean.dirs, extra: {} }
}

function bytesOf(needs: ReadonlyArray<string>, objects: ReadonlyArray<Lfs.Item>) {
  return Object.fromEntries(
    needs.map((dir) => [
      dir,
      objects
        .filter((item) => item.paths.some((file) => file.startsWith(`${dir}/`)))
        .reduce((sum, item) => sum + item.size, 0),
    ]),
  )
}

function tooLarge(bytes: number) {
  const why = `큰 파일 내려받기(${Math.ceil(bytes / 1024 ** 2)} MB)는 확인이 필요해요`
  return Services.failure("invalid_proposal", why, { rejected: [{ item: "download", why }] })
}

function refused(check: Extract<GitVersion.Check, { ok: false }>, home: string): Services.Failure {
  if (check.error === "git_too_old")
    return Services.failure("git_too_old", check.message, {
      version: /Git (\S+)/.exec(check.message)?.[1] ?? "unknown",
      minimum: `${GitVersion.MINIMUM.major}.${GitVersion.MINIMUM.minor}`,
    })
  if (check.error === "lfs_missing")
    return Services.failure("lfs_missing", check.message, { tool: "git-lfs", version: null })
  return Services.failure("not_git", check.message, { directory: home })
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const BranchArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  home: Schema.String,
  branch: Schema.String,
  base: OwnTeam.Sha,
})

const WorktreeArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  home: Schema.String,
  directory: Schema.String,
  branch: Schema.String,
  base: OwnTeam.Sha,
  shape: Schema.Literals(["code", "plain"]),
  cone: Schema.Array(Schema.String),
  heavy: Schema.Array(Schema.String),
  projectID: Schema.String,
})

const RecordArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  name: Schema.String,
  goal: Schema.String,
  directory: Schema.String,
  branch: Schema.String,
  base: OwnTeam.Sha,
  shape: Schema.Literals(["code", "plain"]),
  extra: Schema.Record(Schema.String, NonNegativeInt),
  preset: Preset.ID,
  setup: Schema.Boolean,
  oldGit: optional(Schema.String),
  /** 영역 만들기 (2026-10-26): the area's own model, chosen by the user. */
  main: optional(Model.Ref),
  /** 영역 만들기: the user set the area up (`Area.userMade`). */
  userMade: optional(Schema.Literal(true)),
})

const AreaArgs = Schema.Struct({ areaID: OwnTeam.AreaID })
/** The first owner's 에이전트 방식 the user chose (영역 만들기, 2026-10-26); absent = the service's default. */
const OwnerArgs = Schema.Struct({ areaID: OwnTeam.AreaID, harness: optional(OwnTeam.Harness) })

const RenameArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  name: Schema.String,
  /** Absent: unchanged; `null`: removed. */
  subtitle: optional(Schema.NullOr(Schema.String)),
  /** The area's whole new role (2026-11-17, a rename that reuses the area); absent: unchanged. */
  goal: optional(Schema.String),
  /** The user-made mark: `true` sets it (its first time stays), `false` removes it (an undo); absent: unchanged. */
  userMade: optional(Schema.Boolean),
  /**
   * What it was before, for an undo (8.2 이름 바꾸기 되돌리기: 이전 이름); the role and the mark since 2026-11-17 (an older
   * step has neither: its undo names the area back only).
   */
  previous: Schema.Struct({
    name: Schema.String,
    subtitle: Schema.NullOr(Schema.String),
    goal: optional(Schema.String),
    userMade: optional(Schema.Boolean),
  }),
})

/** `<stepID>.exit` of a setup run. */
const Exit = Schema.Struct({ code: Schema.NullOr(Schema.Finite), ms: Schema.Finite, at: Schema.Finite })
const decodeExit = Schema.decodeUnknownOption(Schema.fromJsonString(Exit))

const DONE: Steps.Outcome = { ok: true }

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.branch, BranchArgs, {
      observe: async (args) => {
        const current = await Refs.read(args.home, `refs/heads/${args.branch}`)
        if (current === undefined) return { state: "failed", note: `기록 이름을 읽지 못했어요: ${args.branch}` }
        if (current === null) return { state: "pending" }
        if (current === args.base) return { state: "satisfied" }
        return { state: "failed", note: `기록 이름이 이미 다른 저장 지점(${current})에 있어요: ${args.branch}` }
      },
      act: async (args) => {
        const created = await Refs.create(
          args.home,
          { ref: `refs/heads/${args.branch}`, oid: args.base },
          "own.team: new area",
        )
        return created.ok ? DONE : { ok: false, note: created.message }
      },
      verify: async (args) =>
        (await Refs.read(args.home, `refs/heads/${args.branch}`)) === args.base
          ? DONE
          : { ok: false, note: `기록 이름이 ${args.base}에 있지 않아요: ${args.branch}` },
    }),

    // Worktree.create observes first and resumes a half-made worktree (TI-11), so observing here adds nothing.
    Steps.define(KIND.worktree, WorktreeArgs, {
      observe: async () => ({ state: "pending" }),
      act: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        // 4.12: a folder inside the main folder's `.worktrees` is ignored there first (a no-op once the line is in),
        // also for listings through another Git folder (own's `.gitignore` in the root, 2026-10-27).
        if (team) await TeamHome.exclude(team)
        if (team) await Home.ignore(team.worktreeRoot)
        const created = await Worktree.create(
          {
            home: args.home,
            directory: args.directory,
            branch: args.branch,
            base: args.base,
            areaID: args.areaID,
            shape: args.shape,
            cone: args.cone,
            heavy: args.heavy,
          },
          { askDownloadBytes: team?.policy.askDownloadBytes ?? OwnTeam.POLICY.askDownloadBytes, signal: input.signal },
        )
        if (!created.ok) return { ok: false, note: `${created.step}단계: ${created.message}` }
        if (created.state === "confirm")
          return { ok: false, note: `내려받을 큰 파일(${created.missing.bytes}바이트)은 확인이 필요해요` }
        const refreshed = await input.services.http.worktree.refresh(
          { projectID: args.projectID, directory: args.home },
          { signal: input.signal },
        )
        const linked = await links(args, team?.env.symlinkFix ?? "none", input.signal)
        const notes = [
          // The worktree is made and locked; core lists it at the next refresh (enable refreshes again at its end).
          ...(refreshed.ok ? [] : [`작업 폴더 목록을 새로 읽지 못했어요: ${refreshed.message}`]),
          ...(linked.ok ? [] : [`바로 가기 파일 사본을 맞추지 못했어요: ${linked.message}`]),
        ]
        return notes.length === 0 ? DONE : { ok: true, note: notes.join("; ") }
      },
      verify: async () => DONE,
    }),

    Steps.define(KIND.record, RecordArgs, {
      observe: async (args, input) => {
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area) return { state: "pending" }
        if (Identity.same(area.directory, args.directory)) return { state: "satisfied" }
        return { state: "failed", note: `${args.areaID} 영역은 다른 폴더에 있어요` }
      },
      act: async (args, input) => {
        const services = input.services
        const identity = await Identity.observe(args.directory)
        if (!identity.ok) return { ok: false, note: identity.message }
        const team = await services.registry.teams.get(input.op.teamID)
        const linked = await links(args, team?.env.symlinkFix ?? "none", input.signal)
        const now = services.clock.now()
        const area: OwnTeam.Area = {
          id: args.areaID,
          teamID: input.op.teamID,
          name: args.name,
          goal: args.goal,
          origin: "created",
          state: "active",
          branch: args.branch,
          gitDir: identity.gitDir,
          base: { sha: args.base, at: now },
          directory: args.directory,
          shape: args.shape,
          cone: {
            extra: Object.fromEntries(
              Object.entries(args.extra).map(([dir, bytes]) => [dir, { reason: NEEDS_REASON, at: now, bytes }]),
            ),
            kept: {},
          },
          owner: { sessionID: null, previous: [], attached: true },
          ...(args.main === undefined ? {} : { main: { model: args.main, chosenBy: "user" as const } }),
          preset: args.preset,
          paused: false,
          status: args.setup ? { kind: "preparing", at: now, text: "준비 중" } : { kind: "idle", at: now, text: "" },
          handoff: null,
          ...(linked.ok && Object.keys(linked.linkCopies).length > 0 ? { linkCopies: { ...linked.linkCopies } } : {}),
          ...(args.userMade ? { userMade: { at: now } } : {}),
        }
        await services.write(input.op.teamID, () => save(services, area))
        // The new area is one more holder of the team's R4 (its main and preset): the team main and the owners made
        // before bind the grown context; this area's owner gets it when `owner-create` makes it.
        await services
          .features()
          .teamContext.push(input.op.teamID)
          .catch((error: unknown) => services.log.warn("team_context_push_failed", { teamID: input.op.teamID, error }))
        input.summary({ kind: "area", areaID: args.areaID, change: "created" })
        if (args.oldGit !== undefined) input.summary({ kind: "old-git", version: args.oldGit })
        return DONE
      },
      verify: async (args, input) =>
        (await input.services.registry.areas.get(input.op.teamID, args.areaID))
          ? DONE
          : { ok: false, note: `${args.areaID} 영역이 기록되지 않았어요` },
    }),

    Steps.define(KIND.owner, OwnerArgs, {
      observe: async (args, input) => {
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area) return { state: "failed", note: `${args.areaID} 영역이 팀 기록에 없어요` }
        return area.owner.sessionID === null ? { state: "pending" } : { state: "satisfied" }
      },
      act: async (args, input) => {
        const created = await input.services.features().owner.create({
          teamID: input.op.teamID,
          areaID: args.areaID,
          ...(args.harness === undefined ? {} : { harness: args.harness }),
          signal: input.signal,
        })
        return created.ok ? DONE : { ok: false, note: created.message }
      },
      verify: async (args, input) =>
        (await input.services.registry.areas.get(input.op.teamID, args.areaID))?.owner.sessionID
          ? DONE
          : { ok: false, note: `${args.areaID} 영역에 담당 대화가 없어요` },
    }),

    Steps.define(KIND.setup, AreaArgs, {
      observe: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        if (!team || !area) return { state: "failed", note: `${args.areaID} 영역이 팀 기록에 없어요` }
        if (team.commands.setup === null) return { state: "skip", note: "준비 명령이 없어요" }
        const exit = await readExit(setupFiles(team, input).exit)
        if (exit && area.status.kind !== "preparing")
          return { state: "satisfied", note: `종료 코드 ${exit.code ?? "없음"}` }
        return { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const team = await services.registry.teams.get(input.op.teamID)
        const area = await services.registry.areas.get(input.op.teamID, args.areaID)
        if (!team?.commands.setup || !area) return { ok: false, note: `${args.areaID} 영역에 준비 명령이 없어요` }
        const files = setupFiles(team, input)
        const exit = (await readExit(files.exit)) ?? (await runSetup(team, area, team.commands.setup, files, input))
        // Stopped with the controller: the op stays running and the next controller runs it again.
        if (!exit) return { ok: false, note: "준비 명령이 멈췄어요" }
        const now = services.clock.now()
        await update(services, area, (current) =>
          current.status.kind === "preparing"
            ? {
                ...current,
                status:
                  exit.code === 0
                    ? { kind: "idle", at: now, text: "" }
                    : { kind: "failed", at: now, text: `준비 명령이 실패했어요(종료 코드 ${exit.code ?? "없음"})` },
              }
            : undefined,
        )
        return { ok: true, note: `종료 코드 ${exit.code ?? "없음"}` }
      },
      verify: async (_args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        return team && (await readExit(setupFiles(team, input).exit)) ? DONE : { ok: false, note: "종료 코드가 없어요" }
      },
    }),

    Steps.define(KIND.rename, RenameArgs, {
      observe: async (args, input) => {
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area || area.state === "retired") return { state: "failed", note: `영역이 아니에요: ${args.areaID}` }
        return renamed(area, args) ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        if (!area) return { ok: false, note: `영역이 아니에요: ${args.areaID}` }
        const now = input.services.clock.now()
        await update(input.services, area, (current) => {
          const { userMade, ...rest } = current
          const mark = args.userMade === undefined ? userMade : args.userMade ? (userMade ?? { at: now }) : undefined
          return {
            ...rest,
            name: args.name,
            ...(args.subtitle === undefined ? {} : { subtitle: args.subtitle ?? undefined }),
            ...(args.goal === undefined ? {} : { goal: args.goal }),
            ...(mark === undefined ? {} : { userMade: mark }),
          }
        })
        // A new role reaches an attached owner at once, as 역할 바꾸기 does (`AreaEditRpc.edit`); one not attached yet
        // gets it with its first main request.
        if (args.goal !== undefined && args.goal !== area.goal) {
          const refreshed = await input.services.features().owner.refresh?.({ teamID: area.teamID, areaID: area.id })
          if (refreshed && !refreshed.ok)
            input.services.log.warn("area_role_refresh_failed", {
              teamID: area.teamID,
              areaID: area.id,
              message: refreshed.message,
            })
        }
        input.summary({ kind: "area", areaID: args.areaID, change: "renamed" })
        return DONE
      },
      verify: async (args, input) => {
        const area = await input.services.registry.areas.get(input.op.teamID, args.areaID)
        return area && renamed(area, args) ? DONE : { ok: false, note: `${args.areaID} 영역의 이름이 바뀌지 않았어요` }
      },
    }),
  ]
}

/**
 * A new area's link copies (06 §4.5 step 8, §4.12) when the home keeps its links as copies (`team.env.symlinkFix`);
 * nothing otherwise. Applied again, copies that already equal their targets are only flagged and recorded.
 */
async function links(
  args: { readonly directory: string; readonly shape: "code" | "plain" },
  fix: Symlinks.Fix,
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly linkCopies: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string }
> {
  if (Symlinks.flag(args.shape, fix) === undefined) return { ok: true, linkCopies: {} }
  const identity = await Identity.observe(args.directory)
  if (!identity.ok) return { ok: false, message: identity.message }
  const applied = await Symlinks.apply({
    area: { directory: args.directory, gitDir: identity.gitDir, shape: args.shape },
    fix,
    signal,
  })
  return applied.ok ? { ok: true, linkCopies: applied.linkCopies } : { ok: false, message: applied.message }
}

function renamed(area: OwnTeam.Area, args: typeof RenameArgs.Type) {
  if (area.name !== args.name) return false
  if (args.goal !== undefined && area.goal !== args.goal) return false
  if (args.userMade !== undefined && (area.userMade !== undefined) !== args.userMade) return false
  return args.subtitle === undefined || (area.subtitle ?? null) === args.subtitle
}

/** Read-modify-write of one area in the team's mutex; `change` returns `undefined` to leave it as it is. */
function update(
  services: Services.Context,
  area: OwnTeam.Area,
  change: (current: OwnTeam.Area) => OwnTeam.Area | undefined,
) {
  return services.write(area.teamID, async () => {
    const current = await services.registry.areas.get(area.teamID, area.id)
    const next = current && change(current)
    if (next) await save(services, next)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Setup command (06 §4.5 step 9, §2.6 (d))

/** `<records>/ops/<opID>/<stepID>.{log,exit}`; step ids like `area:ui:5` are written with `_` (no `:` on Windows). */
function setupFiles(team: OwnTeam.Team, input: Steps.Input) {
  const folder = path.join(Teams.records(team), "ops", input.op.id)
  const name = input.step.id.replace(/[^A-Za-z0-9._-]/g, "_")
  return { folder, log: path.join(folder, `${name}.log`), exit: path.join(folder, `${name}.exit`) }
}

async function readExit(file: string) {
  const text = await Bun.file(file)
    .text()
    .catch(() => undefined)
  return text === undefined ? undefined : Option.getOrUndefined(decodeExit(text))
}

/**
 * Runs the setup command in the area folder (`argv` without a shell; `shell` like core runs `commands.start`: `bash
 * -lc` on Linux, `cmd.exe /d /s /c` on Windows), its output into `<stepID>.log`, then writes `<stepID>.exit`. The
 * controller's signal or {@link SETUP_TIMEOUT_MS} ends the command's whole process tree (`ProcessTree`); a timeout adds
 * `[timed out after N min]` to the log. `undefined` when the controller stopped it (nothing is written, so the next
 * controller runs it again).
 */
async function runSetup(
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  command: OwnTeam.Command,
  files: ReturnType<typeof setupFiles>,
  input: Steps.Input,
) {
  const services = input.services
  const minutes = await estimate(team)
  const now = services.clock.now()
  await update(services, area, (current) =>
    current.status.kind === "preparing"
      ? {
          ...current,
          status: { kind: "preparing", at: now, text: `준비 중(설치 약 ${minutes}분)`, until: now + minutes * 60_000 },
        }
      : undefined,
  )
  await fs.promises.mkdir(files.folder, { recursive: true })
  const output = fs.openSync(files.log, "w")
  const started = performance.now()
  const windows = process.platform === "win32"
  // A command that cannot start (not installed, folder gone) is a failed run with the reason in its log.
  const ended = await Promise.resolve()
    .then(() =>
      ProcessTree.exited(
        Bun.spawn(
          "argv" in command
            ? [...command.argv]
            : windows
              ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${command.shell}"`]
              : ["bash", "-lc", command.shell],
          {
            ...ProcessTree.SPAWN,
            cwd: area.directory,
            // 4.12: own's Bun cache on the worktrees' volume, for this install only (never a user setting).
            env: { ...process.env, ...BunCache.env(team) },
            stdin: "ignore",
            stdout: output,
            stderr: output,
            windowsVerbatimArguments: windows && "shell" in command,
          },
        ),
        { signal: input.signal, timeoutMs: SETUP_TIMEOUT_MS },
      ),
    )
    .catch((error: unknown) => {
      fs.writeSync(output, `${error instanceof Error ? error.message : String(error)}\n`)
      return { code: null, stop: undefined }
    })
  if (ended.stop === "timeout") fs.writeSync(output, `\n[timed out after ${SETUP_TIMEOUT_MS / 60_000} min]\n`)
  fs.closeSync(output)
  if (input.signal.aborted) return undefined
  const exit = { code: ended.code, ms: Math.round(performance.now() - started), at: services.clock.now() }
  await Bun.write(files.exit, JSON.stringify(exit))
  return exit
}

/** Minutes the team's last setup run took (rounded up), else {@link SETUP_MINUTES}. */
async function estimate(team: OwnTeam.Team) {
  const folder = path.join(Teams.records(team), "ops")
  const names = await fs.promises.readdir(folder, { recursive: true }).catch(() => [] as string[])
  const runs = await Promise.all(
    names.filter((name) => name.endsWith(".exit")).map((name) => readExit(path.join(folder, name))),
  )
  const last = runs
    .filter((run) => run !== undefined)
    .toSorted((a, b) => b.at - a.at)
    .at(0)
  return last ? Math.max(1, Math.ceil(last.ms / 60_000)) : SETUP_MINUTES
}
