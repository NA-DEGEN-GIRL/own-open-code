export * as Guard from "./guard.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import type { OwnTeam } from "@own/protocol"
import { Cone } from "../git/cone.js"
import type { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import type { Services } from "../services.js"
import { Drift } from "./drift.js"
import { NeedPaths } from "./need-paths.js"

/**
 * The lazy-asset leak guards of 06 §4.9 and the session lookup the team hooks share.
 *
 * 1. **Before a write** (code-only area folders): the targets of `edit`, `write` and `patch` are matched against the
 *    cone. A target in a heavy folder outside the cone is refused in the permission `evaluate` hook with a message the
 *    model sees (`Permission.BlockedError`). A non-heavy folder outside the cone is added by the tool's
 *    `execute.before` hook first (`cone.extra` `auto`); that hook never throws to refuse (since upstream 73517183b3 a
 *    rejected promise hook fails only that call with a `Tool.Error`, but the refusal belongs to the evaluate hook).
 * 2. **After a tool** (`shell` and the write tools): a heavy folder outside the cone that is on disk again means a
 *    command wrote into it. `git status` lists what is there, the narrowest folder of each changed, untracked or
 *    ignored file is added to the cone (over the thresholds: a confirm instead), then `sparse-checkout reapply` folds
 *    the rest back. Nothing the agent made is deleted, and the order (status before reapply) is kept: right after
 *    `lfs checkout` a reapply without status leaves files behind. git deletes a collapsed folder that holds only
 *    ignored files on any cone change (`Cone.endangered`), so no add or reapply runs while one is on disk.
 * 3. **HEAD moved** (06 §4.8, `shell`): `execute.before` reads the area's HEAD and `execute.after` compares it (a
 *    merge, rebase or checkout by the agent); when it moved, the cone follows it first ({@link Drift.check}: new
 *    folders of the complement that are not heavy are added). HEAD is read from the git dir's files, so no process
 *    starts for an unchanged HEAD.
 *
 * All of them skip their cone changes until this controller holds the controller lock (`Services.Base.started`): the
 * registry writes would wait for it, and core waits for the hook.
 *
 * The cone is read with `sparse-checkout list` once per change of `<git dir>/info/sparse-checkout` and matched in
 * process ({@link Cone.matcher}, the cone-mode rule `check-rules` applies), so the evaluate hook starts no process: a
 * git start costs about 70 ms on a busy Windows machine and the hook's budget is 50 ms at p95 (TG6).
 */

/** Where a session works, as the team hooks see it. Roles come from the registry's ids, never from metadata. */
export interface Subject {
  readonly sessionID: SessionID
  /** The session's current registry role; subagents and replaced conversations have none. */
  readonly role?:
    | { readonly kind: "main"; readonly team: OwnTeam.Team }
    | { readonly kind: "owner"; readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }
    /** An area peer (동료): the owner's allows, so the owner's commands that need no question too. */
    | { readonly kind: "peer"; readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }
  /** The team of the folder the session is located in (its home or an area), when that team is on. */
  readonly team?: OwnTeam.Team
  /** The area folder the session is located in. */
  readonly area?: OwnTeam.Area
  /** The session's location. */
  readonly directory?: string
  /** The team main, or a session below it. */
  readonly main: boolean
}

/**
 * The tools that run commands, by the name the model called: core's `shell`, the own harnesses' `exec_command`,
 * `write_stdin` and Code Mode `exec` (codex), `bash` (pi, and dsh outside Windows) and `pwsh` (dsh on Windows).
 */
export const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "exec_command",
  "write_stdin",
  "exec",
  "bash",
  "pwsh",
])
/**
 * The tools whose targets are checked before they write (06 §4.9 item 1, core `edit.ts`, `write.ts`, `patch.ts`, the
 * codex harness's `apply_patch`; the pi harness's `edit` and `write` take `path` like core's, the dsh harness's
 * `file_path`).
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch", "apply_patch"])
/** The tools after which a heavy folder on disk is brought in (06 §4.9 item 2). */
export const AFTER_TOOLS: ReadonlySet<string> = new Set([...SHELL_TOOLS, ...WRITE_TOOLS])

export const FIXED_TEXT = "담당이 받지 않은 폴더에 파일을 만들어서 그 폴더를 이 영역에 들였어요"

/**
 * The team-side view of a session, or `undefined` when no on team knows it: its registry role, the team folder of its
 * location, and whether it belongs to the main's tree (a subagent of the main works at the home).
 */
export async function subject(services: Services.Context, sessionID: SessionID): Promise<Subject | undefined> {
  const teams = await services.registry.teams.list()
  if (!teams.some((team) => team.state === "on")) return undefined
  const [found, info] = await Promise.all([services.locate.session(sessionID), session(services, sessionID)])
  const role =
    found?.role === "main" && found.team.state === "on"
      ? { kind: "main" as const, team: found.team }
      : found?.role === "owner" && found.team.state === "on"
        ? { kind: "owner" as const, team: found.team, area: found.area }
        : found?.role === "peer" && found.team.state === "on"
          ? { kind: "peer" as const, team: found.team, area: found.area }
          : undefined
  const place = info ? await services.locate.directory(info.directory) : undefined
  const on = place?.team.state === "on" ? place : undefined
  const area = on?.area?.state === "active" ? on.area : undefined
  const main =
    role?.kind === "main" ||
    (on !== undefined && on.area === undefined && (await below(services, info?.parentID, on.team.main.sessionID)))
  if (!role && !area && !main) return undefined
  return {
    sessionID,
    ...(role ? { role } : {}),
    ...(on ? { team: on.team } : {}),
    ...(area ? { area } : {}),
    ...(info ? { directory: info.directory } : {}),
    main,
  }
}

/** The evaluate decision for an `edit` (06 §4.9 item 1): the deny message, or `undefined` to let it pass. */
export async function edit(subject: Subject, resources: ReadonlyArray<string>) {
  const found = await code(subject)
  if (!found) return undefined
  const blocked = targets(found.area, found.directory, resources)
    .map((file) => heavy(heavyOf(found), found.cone, file))
    .find((dir) => dir !== undefined)
  return blocked === undefined ? undefined : message(blocked)
}

/** The deny text of 06 §4.9 item 1. */
export function message(dir: string) {
  return `이 영역에 받지 않은 큰 파일 폴더예요: \`${dir}\`. 필요하면 먼저 team_need_paths를 부르세요.`
}

/**
 * `execute.before` of the write tools (06 §4.9 item 1): adds the narrowest parent of each target that is outside the
 * cone and not heavy (`cone.extra` `auto`). Over the thresholds nothing is added; heavy targets are left to the
 * evaluate hook's deny.
 */
export async function before(
  services: Services.Context,
  call: { readonly tool: string; readonly sessionID: SessionID; readonly id: string; readonly input: unknown },
) {
  if (SHELL_TOOLS.has(call.tool)) return remember(services, call)
  if (!WRITE_TOOLS.has(call.tool)) return
  const files = writes(call.tool, call.input)
  if (files.length === 0) return
  if (!services.started()) return services.log.info("paths_auto_not_started", { sessionID: call.sessionID })
  const found = await code(await subject(services, call.sessionID))
  if (!found) return
  const match = Cone.matcher(found.cone)
  const dirs = narrowest(
    targets(found.area, found.directory, files)
      .filter((file) => !match(file) && heavy(heavyOf(found), found.cone, file) === undefined)
      .map(parent),
  )
  if (dirs.length === 0) return
  await serial(found.area.directory, async () => {
    const counted = await NeedPaths.count(found.area.directory, dirs, found.cone)
    if (!counted.ok) return services.log.warn("paths_auto_count_failed", { areaID: found.area.id })
    if (NeedPaths.over(found.team.policy, counted))
      return services.log.info("paths_auto_over_threshold", { areaID: found.area.id, bytes: counted.bytes })
    const applied = await NeedPaths.apply(services, {
      area: found.area,
      dirs,
      reason: NeedPaths.AUTO,
      counted,
      clean: false,
    })
    if (!applied.ok) services.log.warn("paths_auto_add_failed", { areaID: found.area.id, error: applied.error })
  })
}

/**
 * `execute.after` of `shell` and the write tools (06 §4.9 item 2, TG6): a heavy folder outside the cone found on disk
 * is brought in at its narrowest changed folders, then the rest is folded back. Nothing is deleted. When a shell call
 * moved the area's HEAD (06 §4.8), the cone follows it first.
 */
export async function after(
  services: Services.Context,
  call: { readonly tool: string; readonly sessionID: SessionID; readonly id: string },
) {
  if (!AFTER_TOOLS.has(call.tool)) return
  const key = `${call.sessionID}:${call.id}`
  const earlier = HEADS.get(key)
  HEADS.delete(key)
  if (!services.started()) return services.log.info("paths_fix_not_started", { sessionID: call.sessionID })
  const found = await code(await subject(services, call.sessionID))
  if (!found) return
  const moved = earlier !== undefined && earlier.head !== (await Drift.head(earlier.area))
  const roots = await strays(found.area.directory, found.cone, heavyOf(found))
  if (!moved && roots.length === 0) return
  await serial(found.area.directory, async () => {
    if (moved) {
      const drifted = await Drift.check(services, { team: found.team, area: found.area })
      if (!drifted.ok) services.log.warn("drift_failed", { areaID: found.area.id, error: drifted.error })
    }
    if (roots.length > 0) await fix(services, found, roots)
  })
}

type Code = {
  readonly team: OwnTeam.Team
  readonly area: OwnTeam.Area
  readonly directory: string
  readonly cone: ReadonlyArray<string>
}

const CONES = new Map<string, { readonly stamp: string; readonly dirs: ReadonlyArray<string> }>()
/** HEAD of the code-only area before each running shell call, by `<sessionID>:<call id>` (06 §4.8). */
const HEADS = new Map<string, { readonly area: Identity.Record; readonly head: string | undefined }>()
const PARENTS = new Map<SessionID, SessionID | null>()
const CHAINS = new Map<string, Promise<void>>()
/** Subagents nest a few levels at most; a longer chain is not followed. */
const DEPTH = 16

const WriteInput = Schema.Union([Schema.Struct({ path: Schema.String }), Schema.Struct({ file_path: Schema.String })])
const PatchInput = Schema.Struct({ patchText: Schema.String })
/** Codex's `apply_patch`: the patch text itself (freeform) or `{input}` (JSON form). */
const ApplyPatchInput = Schema.Union([Schema.String, Schema.Struct({ input: Schema.String })])
const decodeWrite = Schema.decodeUnknownOption(WriteInput)
const decodePatch = Schema.decodeUnknownOption(PatchInput)
const decodeApplyPatch = Schema.decodeUnknownOption(ApplyPatchInput)

/** `execute.before` of `shell`: the HEAD of the code-only area the session works in, for `execute.after`. */
async function remember(services: Services.Context, call: { readonly sessionID: SessionID; readonly id: string }) {
  if (!services.started()) return
  const area = (await subject(services, call.sessionID))?.area
  if (!area || area.shape !== "code") return
  const target = { directory: area.directory, gitDir: area.gitDir }
  HEADS.set(`${call.sessionID}:${call.id}`, { area: target, head: await Drift.head(target) })
}

/** The session's location and parent, through any live instance's plugin API. */
async function session(services: Services.Context, sessionID: SessionID) {
  const instance = services.instance()
  if (!instance) return undefined
  const info = await instance.ctx.session.get({ sessionID }).catch(() => undefined)
  if (!info) return undefined
  const parentID = info.parentID === undefined ? undefined : SessionID.make(info.parentID)
  PARENTS.set(sessionID, parentID ?? null)
  return { directory: info.location.directory, parentID }
}

/** Whether `parentID` is `mainID` or one of its ancestors is. */
async function below(services: Services.Context, parentID: SessionID | undefined, mainID: SessionID) {
  const walk = async (id: SessionID | undefined, depth: number): Promise<boolean> => {
    if (id === undefined || depth > DEPTH) return false
    if (id === mainID) return true
    const known = PARENTS.get(id)
    if (known !== undefined) return walk(known ?? undefined, depth + 1)
    return walk((await session(services, id))?.parentID, depth + 1)
  }
  return walk(parentID, 0)
}

/**
 * The heavy folders the guards protect in the area: the team's list and the new folders the cone drift left
 * collapsed there (06 §4.4 G2: until the list grows over them, a write into one would land in a collapsed folder and
 * expand the index, 4.9).
 */
function heavyOf(found: Code) {
  return [...found.team.heavy.dirs, ...Drift.left(found.area.directory)]
}

/** A code-only, active area the session is located in, with its cone; `undefined` otherwise. */
async function code(subject: Subject | undefined): Promise<Code | undefined> {
  if (!subject?.area || !subject.team || subject.directory === undefined || subject.area.shape !== "code")
    return undefined
  const cone = await coneOf(subject.area)
  if (!cone) return undefined
  return { team: subject.team, area: subject.area, directory: subject.directory, cone }
}

/** The area's cone folders, listed again only when its sparse-checkout file changed. */
async function coneOf(area: OwnTeam.Area) {
  const file = path.join(area.gitDir, "info", "sparse-checkout")
  const stat = await fs.stat(file, { bigint: true }).catch(() => undefined)
  if (!stat) return undefined
  const stamp = `${stat.mtimeNs}:${stat.size}`
  const cached = CONES.get(area.directory)
  if (cached?.stamp === stamp) return cached.dirs
  const listed = await Cone.list(area.directory)
  if (!listed.ok) return undefined
  const dirs = listed.dirs.map(Cone.normalize)
  CONES.set(area.directory, { stamp, dirs })
  return dirs
}

/** Permission resources or tool paths (relative to the session's location, or absolute) as area-relative files. */
function targets(area: OwnTeam.Area, directory: string, resources: ReadonlyArray<string>) {
  return resources.flatMap((resource) => {
    const file = path.relative(area.directory, path.resolve(directory, resource))
    if (file === "" || file === ".." || file.startsWith(`..${path.sep}`) || path.isAbsolute(file)) return []
    return [file.split(path.sep).join("/")]
  })
}

/**
 * The heavy folder a file outside the cone would write into: one that holds it, or one inside the file's folder (that
 * folder cannot enter the cone without the heavy one). `undefined` for a file the cone holds or a non-heavy one.
 */
function heavy(dirs: ReadonlyArray<string>, cone: ReadonlyArray<string>, file: string) {
  if (Cone.contains(cone, file)) return undefined
  const folder = parent(file)
  const heavy = dirs.map(Cone.normalize)
  return (
    heavy.find((dir) => file.startsWith(`${dir}/`)) ??
    heavy.find((dir) => folder !== "" && dir.startsWith(`${folder}/`))
  )
}

/**
 * The files a write tool call targets (06 §4.9: `edit`/`write` `path`, or `file_path` for the dsh harness, `patch`
 * add, update and move headers).
 */
function writes(tool: string, input: unknown) {
  if (tool !== "patch" && tool !== "apply_patch") {
    const decoded = Option.getOrUndefined(decodeWrite(input))
    if (decoded === undefined) return []
    return ["path" in decoded ? decoded.path : decoded.file_path]
  }
  const applied = tool === "apply_patch" ? Option.getOrUndefined(decodeApplyPatch(input)) : undefined
  const text =
    tool === "patch"
      ? Option.getOrUndefined(decodePatch(input))?.patchText
      : typeof applied === "string"
        ? applied
        : applied?.input
  if (text === undefined) return []
  return text.split(/\r?\n/).flatMap((line) => {
    const header = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/.exec(line.trim())
    return header?.[1] ? [header[1].trim()] : []
  })
}

/** Heavy folders (or their parts) outside the cone that hold a file on disk: what a command wrote into. */
async function strays(directory: string, cone: ReadonlyArray<string>, heavy: ReadonlyArray<string>) {
  const walk = async (dir: string): Promise<string[]> => {
    if (Cone.covers(cone, dir)) return []
    const full = path.join(directory, ...dir.split("/"))
    const entries = await fs.readdir(full, { withFileTypes: true }).catch(() => undefined)
    if (!entries) return []
    // A folder around a fetched subfolder is checked out itself (its files are in the cone); look at its subfolders.
    if (cone.some((item) => item.startsWith(`${dir}/`)))
      return (
        await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => walk(`${dir}/${entry.name}`)))
      ).flat()
    return (await holdsFile(full)) ? [dir] : []
  }
  return (await Promise.all(heavy.map(Cone.normalize).map(walk))).flat()
}

/** Whether a folder holds a file anywhere below it (an empty folder git cannot fold is not a leak). */
async function holdsFile(folder: string): Promise<boolean> {
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
  if (entries.some((entry) => !entry.isDirectory())) return true
  return entries.reduce<Promise<boolean>>(
    async (found, entry) => (await found) || holdsFile(path.join(folder, entry.name)),
    Promise.resolve(false),
  )
}

/** The after-tool fix for `roots` (06 §4.9 item 2). */
async function fix(services: Services.Context, found: Code, roots: ReadonlyArray<string>) {
  const area = found.area
  // Not a query: the refreshed index must be written, or `reapply` keeps files it cannot see are clean.
  const status = await Git.run(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--", ...roots],
    { cwd: area.directory, worktree: true, write: true, env: { GIT_LITERAL_PATHSPECS: "1" } },
  )
  if (!status.ok) return services.log.warn("paths_fix_status_failed", { areaID: area.id })
  const dirs = narrowest(
    Porcelain.status(status.stdout).entries.map((entry) =>
      entry.path.endsWith("/") ? entry.path.slice(0, -1) : parent(entry.path),
    ),
  )
  if (dirs.length > 0) {
    const counted = await NeedPaths.count(area.directory, dirs, found.cone)
    if (!counted.ok) return services.log.warn("paths_fix_count_failed", { areaID: area.id })
    if (NeedPaths.over(found.team.policy, counted)) {
      // The files stay where the agent put them until the user answers; nothing is folded back meanwhile.
      const asked = await NeedPaths.ask(services, {
        team: found.team,
        area,
        dirs,
        reason: NeedPaths.AUTO,
        notify: false,
        by: "auto",
      })
      if (!asked.ok) services.log.info("paths_fix_confirm_busy", { areaID: area.id, opID: asked.op.id })
      return
    }
    const applied = await NeedPaths.apply(services, {
      area,
      dirs,
      reason: NeedPaths.AUTO,
      counted,
      clean: false,
    })
    if (!applied.ok) {
      services.log.warn("paths_fix_add_failed", { areaID: area.id, error: applied.error, message: applied.message })
      // Only the check after the add failed (a git query that timed out on a busy PC, 2026-10-14): the folders came in
      // and are recorded, so the user is told as for a clean add.
      if (!applied.recorded) return
    }
  }
  const listed = await Cone.list(area.directory)
  const risky = listed.ok ? await Cone.endangered(area.directory, listed.dirs) : listed
  const safe = risky.ok && risky.dirs.length === 0
  if (!safe) services.log.warn("paths_fix_reapply_kept", { areaID: area.id, dirs: risky.ok ? risky.dirs : [] })
  const reapplied = safe ? await Cone.reapply({ directory: area.directory, gitDir: area.gitDir }) : undefined
  if (reapplied && !reapplied.ok)
    services.log.warn("paths_fix_reapply_failed", { areaID: area.id, error: reapplied.error })
  if (dirs.length > 0)
    services.notices.publish({
      teamID: found.team.id,
      areaID: area.id,
      kind: "paths.added",
      text: `${area.name}: ${FIXED_TEXT}`,
      data: { count: dirs.length, dirs: dirs.join(", ") },
    })
}

/** Folders without the ones inside another listed folder, without the root. */
function narrowest(dirs: ReadonlyArray<string>) {
  const unique = [...new Set(dirs.map(Cone.normalize).filter(Boolean))]
  return unique.filter((dir) => !unique.some((other) => other !== dir && Cone.covers([other], dir))).toSorted()
}

/** `a/b/c` → `a/b`; a top-level entry → `""`. */
function parent(file: string) {
  const slash = file.lastIndexOf("/")
  return slash < 0 ? "" : file.slice(0, slash)
}

/** Runs cone changes of one folder one after another (parallel tool calls of one step would race for the index). */
function serial(directory: string, work: () => Promise<void>) {
  const next = (CHAINS.get(directory) ?? Promise.resolve()).then(work, work)
  const tracked = next.catch(() => undefined)
  CHAINS.set(directory, tracked)
  void tracked.then(() => {
    if (CHAINS.get(directory) === tracked) CHAINS.delete(directory)
  })
  return next
}
