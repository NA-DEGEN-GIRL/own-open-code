export * as NeedPaths from "./need-paths.js"

import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Cone } from "../git/cone.js"
import type { Identity } from "../git/identity.js"
import { Lfs } from "../git/lfs.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import type { Steps } from "../ops/steps.js"
import type { Services } from "../services.js"

/**
 * Fetching large-file folders into a code-only area (06 §4.6): `team_need_paths{dirs, reason}`, `area.paths{add}`, the
 * pre-write add of a non-heavy folder (4.9 item 1) and the after-tool fix (4.9 item 2) all end here.
 *
 *   1  folders the cone already holds are skipped (`sparse-checkout list`, matched as `check-rules` matches a cone);
 *      what adding the rest checks out is counted at HEAD: total, LFS and missing LFS bytes, with plain git like the
 *      weighing of 4.4
 *   2  missing ≥ `askDownloadBytes` or total ≥ `askDiskBytes`: a `paths` op whose `paths-add` step waits for the user
 *   3  `lfs fetch -I <dir>/**` for the missing objects only (none missing: no network), `sparse-checkout add --stdin`,
 *      the folders are in the cone and show no tracked change, `cone.extra` records reason and bytes, the area's link
 *      copies are applied again (4.12: links inside the new folders were git's link files), notice
 *
 * A failed fetch changes nothing. A failed add leaves some files written with skip-worktree cleared, so it is undone
 * with `status` → `sparse-checkout reapply` ([R-lazy] B/wt-x). `lfs.fetchexclude` is never used (4.6).
 *
 * git deletes a folder the new cone collapses when it holds only ignored files (`Cone.endangered`): an add or the undo
 * of a failed one that would do so is not run (`kept`) while such files are on disk, so nothing the agent or the user
 * made is lost; the after-tool fix brings those folders in first, or waits for the user's confirm.
 */

/** The step kind of a fetch inside a `paths` op. */
export const STEP = "paths-add"

/** `reason` of folders added without being asked (4.7: they stay in the cone on the next `set`). */
export const AUTO = "auto"

/**
 * `reason` of a folder a code-only area held when the heavy list grew over it (06 §4.4, `assets/heavy.ts`): it was in
 * the cone already, so its changes pass the candidate check (4.10), and the automatic release takes it away once clean.
 */
export const GROWN = "grown"

/** 06 §4.6 failure text. */
export const NETWORK = "필요한 파일을 내려받지 못해 폴더를 가져오지 못했어요(네트워크)"
export const WAITING = "사용자 확인을 기다립니다. 그동안 다른 일을 하세요"
/** Why the cone stays as it is (`kept`): these folders hold ignored files that git would delete. */
export const KEPT =
  "받지 않은 폴더에 남은 파일이 지워질 수 있어 지금은 폴더를 가져오지 않았어요. 그 파일을 옮기거나 그 폴더를 먼저 가져오세요"

export interface Count {
  /** Files under the folders at HEAD. */
  readonly files: number
  /** What a checkout of the folders writes: non-LFS blobs plus the real size of LFS files. */
  readonly bytes: number
  /** Real bytes of the LFS files. */
  readonly lfsBytes: number
  /** LFS objects the shared store does not have. */
  readonly missing: Lfs.Missing
  /** {@link bytes} per folder. */
  readonly per: Readonly<Record<string, number>>
}

export type Applied =
  | { readonly ok: true; readonly added: ReadonlyArray<string>; readonly bytes: number; readonly downloaded: number }
  | {
      readonly ok: false
      /**
       * `network`: the fetch or the add failed and the add was undone; `broken`: the folder is not the area (TI-14);
       * `git`: the folders were added (and recorded) but do not check out as expected; `kept`: nothing was changed,
       * because the add would delete ignored files in folders it leaves collapsed (`Cone.endangered`).
       */
      readonly error: "network" | "broken" | "git" | "kept"
      readonly broken?: OwnTeam.BrokenReason
      readonly message: string
      /** Only the check after the add failed: the folders are in the cone and in `cone.extra`. */
      readonly recorded?: true
    }

/**
 * Folder names as `dirs` gives them, or the first refused one: `..`, a leading `/` or `-`, a drive, a line break or
 * the root (06 §4.6). Normalized to `/` separators; a folder inside another listed folder is dropped.
 */
export function validate(
  dirs: ReadonlyArray<string>,
): { readonly ok: true; readonly dirs: ReadonlyArray<string> } | { readonly ok: false; readonly path: string } {
  const bad = dirs.find(refused)
  if (bad !== undefined) return { ok: false, path: bad }
  const unique = [...new Set(dirs.map(Cone.normalize))]
  return { ok: true, dirs: unique.filter((dir) => !unique.some((other) => other !== dir && Cone.covers([other], dir))) }
}

/** Step 1: the area's cone folders and the folders of `dirs` it does not hold (neither it nor a parent is listed). */
export async function remaining(directory: string, dirs: ReadonlyArray<string>) {
  const listed = await Cone.list(directory)
  if (!listed.ok) return listed
  const cone = listed.dirs.map(Cone.normalize)
  return { ok: true as const, cone, dirs: dirs.filter((dir) => !Cone.covers(cone, dir)) }
}

/**
 * Step 1: what adding `dirs` to `cone` checks out, at HEAD and without git-lfs (06 §4.4 steps 1-4): every file below
 * the folders, and the files directly inside the folders around them that the cone does not hold yet (cone mode
 * checks out the files of every folder around a cone folder: adding `Assets/Textures/UI` also writes
 * `Assets/Textures/*.png`). Those forced files count toward the folder they lead to.
 */
export async function count(
  directory: string,
  dirs: ReadonlyArray<string>,
  cone: ReadonlyArray<string>,
): Promise<({ readonly ok: true } & Count) | { readonly ok: false; readonly message: string }> {
  if (dirs.length === 0) return { ok: true, ...EMPTY }
  const query = { cwd: directory, worktree: true }
  const around = [...new Set(dirs.flatMap(ancestors))]
  // `ls-tree HEAD -- a/ a/b/` lists the entries directly inside each folder.
  const [below, beside] = await Promise.all([
    Git.run(["ls-tree", "-r", "-z", `--format=${TREE_FORMAT}`, "HEAD", "--", ...dirs], query),
    around.length === 0
      ? undefined
      : Git.run(["ls-tree", "-z", `--format=${TREE_FORMAT}`, "HEAD", "--", ...around.map((dir) => `${dir}/`)], query),
  ])
  if (!below.ok) return { ok: false, message: below.message }
  if (beside && !beside.ok) return { ok: false, message: beside.message }
  const held = Cone.matcher(cone)
  const owner = (file: string) =>
    dirs.find((dir) => file.startsWith(`${dir}/`)) ?? dirs.find((dir) => dir.startsWith(`${parent(file)}/`))
  const blobs = [...Porcelain.fields(below.stdout), ...(beside ? Porcelain.fields(beside.stdout) : [])].flatMap(
    (line) => {
      const tab = line.indexOf("\t")
      const [mode = "", oid = "", size = ""] = line.slice(0, tab).split(" ")
      const file = line.slice(tab + 1)
      // Folders and submodules have no blob; `ls-tree` matches by prefix, so keep only files that belong to a folder.
      const dir = owner(file)
      if (mode === "040000" || mode === "160000" || dir === undefined || held(file)) return []
      return [{ mode, oid, size: Number(size), path: file, dir }]
    },
  )
  const found = await pointers(directory, blobs)
  if (!found.ok) return found
  const files = blobs.map((blob) => ({
    path: blob.path,
    dir: blob.dir,
    pointer: found.pointers.get(blob.path),
    size: blob.size,
  }))
  const missing = [
    ...Map.groupBy(
      files.flatMap((file) => (file.pointer && !file.pointer.local ? [{ ...file.pointer, path: file.path }] : [])),
      (item) => item.oid,
    ).values(),
  ].map((items) => ({ oid: items[0].oid, size: items[0].size, paths: items.map((item) => item.path) }))
  const bytes = (file: (typeof files)[number]) => file.pointer?.size ?? file.size
  return {
    ok: true,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + bytes(file), 0),
    lfsBytes: files.reduce((sum, file) => sum + (file.pointer?.size ?? 0), 0),
    missing: {
      objects: missing,
      count: missing.length,
      bytes: missing.reduce((sum, item) => sum + item.size, 0),
    },
    per: Object.fromEntries(
      dirs.map((dir) => [dir, files.filter((file) => file.dir === dir).reduce((sum, file) => sum + bytes(file), 0)]),
    ),
  }
}

/** Step 2: the fetch waits for the user (06 §4.6, §0.3 기준값). */
export function over(policy: OwnTeam.Policy, counted: Count) {
  return (
    (counted.missing.bytes > 0 && counted.missing.bytes >= policy.askDownloadBytes) ||
    (counted.bytes > 0 && counted.bytes >= policy.askDiskBytes)
  )
}

/**
 * Step 3 for folders outside the cone: fetch what is missing, add, check, record in `cone.extra`. `clean` checks that
 * the added folders show no tracked change (a fetch on request); the after-tool fix adds folders that already hold
 * the agent's files and skips it.
 */
export async function apply(
  services: Services.Context,
  input: {
    readonly area: OwnTeam.Area
    readonly dirs: ReadonlyArray<string>
    readonly reason: string
    readonly counted: Count
    readonly clean: boolean
    readonly signal?: AbortSignal
  },
): Promise<Applied> {
  const target = { directory: input.area.directory, gitDir: input.area.gitDir }
  const listed = await Cone.list(target.directory)
  if (!listed.ok) return { ok: false, error: "kept", message: listed.message }
  const risky = await Cone.endangered(target.directory, [...listed.dirs, ...input.dirs])
  if (!risky.ok) return { ok: false, error: "kept", message: risky.message }
  if (risky.dirs.length > 0) return { ok: false, error: "kept", message: `${KEPT}: ${risky.dirs.join(", ")}` }
  if (input.counted.missing.count > 0) {
    const fetched = await Lfs.fetch(
      target.directory,
      Lfs.includes(input.dirs, input.counted.missing.objects),
      input.signal,
    )
    if (!fetched.ok) return { ok: false, error: "network", message: fetched.message }
  }
  const added = await Cone.add(target, input.dirs)
  if (!added.ok && added.error === "broken")
    return { ok: false, error: "broken", broken: added.broken, message: added.message }
  if (!added.ok) {
    await restore(services, target)
    return { ok: false, error: added.error === "git" ? "network" : "git", message: added.message }
  }
  // From here the folders are in the cone, so they are recorded even when the check below finds something wrong.
  const at = services.clock.now()
  await update(services, input.area.teamID, input.area.id, (area) => ({
    ...area,
    cone: {
      extra: {
        ...area.cone.extra,
        ...Object.fromEntries(
          input.dirs.map((dir) => [dir, { reason: input.reason, at, bytes: input.counted.per[dir] ?? 0 }]),
        ),
      },
      kept: Object.fromEntries(Object.entries(area.cone.kept).filter(([dir]) => !input.dirs.includes(dir))),
    },
  }))
  const checked = await check(target.directory, input.dirs, input.clean)
  if (checked !== undefined) return { ok: false, error: "git", message: checked, recorded: true }
  // 4.12: links inside the folders that came in are git's link files until the copies are applied again. Loaded
  // here, not at the top: `symlinks.ts` imports this module, and with a static cycle between the two the leader's
  // events stopped after a Location handover (TG1 `leader.e2e`).
  const { Symlinks } = await import("./symlinks.js")
  const relinked = await Symlinks.refresh(services, {
    teamID: input.area.teamID,
    areaID: input.area.id,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!relinked.ok) services.log.warn("paths_relink_failed", { areaID: input.area.id, message: relinked.message })
  return { ok: true, added: input.dirs, bytes: input.counted.bytes, downloaded: input.counted.missing.bytes }
}

/** The `paths-add` step of a `paths` op; `confirm` waits for the user (06 §4.6 step 2). */
export function spec(input: {
  readonly areaID: OwnTeam.AreaID
  readonly dirs: ReadonlyArray<string>
  readonly reason: string
  /** Tell the area's owner with a `<team-notice>` once a confirmed fetch is done (4.6 step 2). */
  readonly notify: boolean
  readonly confirm: boolean
}): Steps.Spec {
  return {
    kind: STEP,
    mode: input.confirm ? "confirm" : "auto",
    args: { areaID: input.areaID, dirs: [...input.dirs], reason: input.reason, notify: input.notify },
  }
}

/** Starts a `paths` op whose fetch waits for the user (06 §4.6 step 2); `busy` while the team runs another op. */
export function ask(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly area: OwnTeam.Area
    readonly dirs: ReadonlyArray<string>
    readonly reason: string
    readonly notify: boolean
    readonly by: OwnTeam.Op["by"]
  },
) {
  register(services)
  return services.runner.start({
    teamID: input.team.id,
    kind: "paths",
    by: input.by,
    areaID: input.area.id,
    steps: [
      spec({ areaID: input.area.id, dirs: input.dirs, reason: input.reason, notify: input.notify, confirm: true }),
    ],
  })
}

/**
 * Registers the `paths-add` step kind once per controller. Called when the RPC handlers are made, which happens in
 * every instance's setup before the controller's first resume can run, and again before an op is started.
 */
export function register(services: Services.Context) {
  if (!services.steps.get(STEP)) services.steps.register(KIND)
}

/** The `paths.added` notice of a fetch (06 §4.6 step 3); returns its text. */
export function announce(
  services: Services.Context,
  area: OwnTeam.Area,
  applied: { readonly added: ReadonlyArray<string>; readonly bytes: number; readonly downloaded: number },
) {
  const text = `${area.name}: 큰 파일 폴더 ${applied.added.length}개(${size(applied.bytes)})를 가져왔어요`
  services.notices.publish({
    teamID: area.teamID,
    areaID: area.id,
    kind: "paths.added",
    text,
    data: { count: applied.added.length, bytes: applied.bytes, downloaded: applied.downloaded },
  })
  return text
}

/** A byte count as the cards show it (`120 MB`, `2.5 GB`). */
export function size(bytes: number) {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GB`
  if (bytes >= MiB) return `${Math.round(bytes / MiB)} MB`
  if (bytes >= KiB) return `${Math.round(bytes / KiB)} KB`
  return `${bytes} B`
}

/** Read-modify-write of an area record in the team's mutex, then `area.changed` (06 §2.4). */
export async function update(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
  areaID: OwnTeam.AreaID,
  change: (area: OwnTeam.Area) => OwnTeam.Area,
) {
  const written = await services.write(teamID, async () => {
    const current = await services.registry.areas.get(teamID, areaID)
    if (!current) return undefined
    const next = change(current)
    const rev = await services.registry.areas.put(next)
    return rev === undefined ? undefined : { area: next, rev }
  })
  if (written)
    services.hub.publish({
      name: "area.changed",
      data: { teamID, areaID, rev: written.rev, status: written.area.status, paused: written.area.paused },
    })
  return written?.area
}

/** `<team-notice>` to the area's owner (06 §4.6 step 2, `queue`, marked as own.team's). */
async function notify(services: Services.Context, area: OwnTeam.Area, text: string) {
  const sessionID = area.owner.sessionID
  if (sessionID === null) return
  const sent = await services.http.session.synthetic({
    sessionID,
    directory: area.directory,
    text: `<team-notice>${text}</team-notice>`,
    delivery: "queue",
    metadata: { source: OwnTeam.PROMPT_SOURCE },
  })
  if (!sent.ok) services.log.warn("paths_notice_failed", { areaID: area.id, type: sent.type })
}

const KiB = 1024
const MiB = 1024 ** 2
const GiB = 1024 ** 3
const TREE_FORMAT = "%(objectmode) %(objectname) %(objectsize)%x09%(path)"
const EMPTY: Count = { files: 0, bytes: 0, lfsBytes: 0, missing: { objects: [], count: 0, bytes: 0 }, per: {} }

const Args = Schema.Struct({
  areaID: OwnTeam.AreaID,
  dirs: Schema.Array(Schema.String),
  reason: Schema.String,
  notify: Schema.Boolean,
})
const decodeArgs = Schema.decodeUnknownOption(Args)

/** The `paths-add` step: observe (already in the cone), act ({@link apply}), verify (in the cone). */
const KIND: Steps.Kind = {
  kind: STEP,
  observe: async (input) => {
    const found = await load(input)
    if (!found.ok) return found.observed
    if (found.area.shape !== "code") return { state: "satisfied", note: "영역에 모든 폴더가 있어요" }
    const left = await remaining(found.area.directory, found.args.dirs)
    if (!left.ok) return { state: "failed", note: left.message }
    return left.dirs.length === 0 ? { state: "satisfied" } : { state: "pending" }
  },
  act: async (input) => {
    const found = await load(input)
    if (!found.ok) return { ok: false, note: "영역이나 팀을 찾을 수 없어요" }
    const left = await remaining(found.area.directory, found.args.dirs)
    if (!left.ok) return { ok: false, note: left.message }
    const counted = await count(found.area.directory, left.dirs, left.cone)
    if (!counted.ok) return { ok: false, note: counted.message }
    const applied = await apply(input.services, {
      area: found.area,
      dirs: left.dirs,
      reason: found.args.reason,
      counted,
      clean: found.args.reason !== AUTO,
      signal: input.signal,
    })
    if (!applied.ok) return { ok: false, note: applied.error === "network" ? NETWORK : applied.message }
    input.summary({
      kind: "paths",
      areaID: found.area.id,
      change: "added",
      dirs: [...applied.added],
      bytes: applied.bytes,
    })
    const text = announce(input.services, found.area, applied)
    if (input.confirmed && found.args.notify)
      await notify(
        input.services,
        found.area,
        `사용자가 확인해서 큰 파일 폴더 ${applied.added.length}개(${size(applied.bytes)})를 가져왔습니다: ${applied.added.join(", ")}`,
      )
    return { ok: true, note: text }
  },
  verify: async (input) => {
    const found = await load(input)
    if (!found.ok) return { ok: false, note: "영역이나 팀을 찾을 수 없어요" }
    const left = await remaining(found.area.directory, found.args.dirs)
    if (!left.ok) return { ok: false, note: left.message }
    return left.dirs.length === 0
      ? { ok: true }
      : { ok: false, note: `가벼운 폴더 범위에 없어요: ${left.dirs.join(", ")}` }
  },
  prepare: async (input) => {
    const found = await load(input)
    if (!found.ok) return { text: "큰 파일 폴더 가져오기" }
    const left = await remaining(found.area.directory, found.args.dirs)
    if (!left.ok) return { text: `${found.area.name}: 큰 파일 폴더 ${found.args.dirs.length}개를 가져올까요?` }
    const dirs = left.dirs
    const counted = await count(found.area.directory, dirs, left.cone)
    const names = dirs.length > 2 ? `${dirs.slice(0, 2).join(", ")} 외 ${dirs.length - 2}개` : dirs.join(", ")
    if (!counted.ok) return { text: `${found.area.name}: 큰 파일 폴더 ${dirs.length}개(${names})를 가져올까요?` }
    return {
      text: `${found.area.name}: 큰 파일 폴더 ${dirs.length}개(${names})를 가져올까요? 내려받기 ${size(counted.missing.bytes)}, 디스크 ${size(counted.bytes)}를 써요.`,
      bytes: counted.missing.bytes,
    }
  },
  // RH-20: an ask nobody answered within its 10 minutes gives way (두기) to the next op of the team instead of holding
  // the team's one op slot; the owner that asked hears it.
  yields: true,
  yielded: async (input) => {
    const found = await load(input)
    if (!found.ok) return
    await notify(
      input.services,
      found.area,
      `큰 파일 폴더 ${found.args.dirs.length}개(${found.args.dirs.join(", ")})는 사용자의 확인이 없어 가져오지 않았습니다. 필요하면 team_need_paths를 다시 부르세요.`,
    )
  },
}

/** The step's arguments, team and area, or what observing should answer. */
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
  return { ok: true as const, args, team, area }
}

/**
 * Undoes a failed add (06 §4.6 실패): `status` refreshes the index, `reapply` puts files outside the cone back. Not
 * while a collapsed folder holds only ignored files, which `reapply` would delete (`Cone.endangered`).
 */
async function restore(services: Services.Context, target: Identity.Record) {
  // Not a query: the refreshed index must be written, or `reapply` keeps files it cannot see are clean.
  await Git.run(["status", "--porcelain=v2", "-z"], { cwd: target.directory, worktree: true, write: true })
  const listed = await Cone.list(target.directory)
  const risky = listed.ok ? await Cone.endangered(target.directory, listed.dirs) : listed
  if (!risky.ok || risky.dirs.length > 0)
    return services.log.warn("paths_restore_kept", {
      directory: target.directory,
      dirs: risky.ok ? risky.dirs : [],
      ...(risky.ok ? {} : { message: risky.message }),
    })
  await Cone.reapply(target)
}

/** Why the added folders are not right, or `undefined`. */
async function check(directory: string, dirs: ReadonlyArray<string>, clean: boolean) {
  const left = await remaining(directory, dirs)
  if (!left.ok) return left.message
  if (left.dirs.length > 0) return `가져온 뒤에도 가벼운 폴더 범위에 없어요: ${left.dirs.join(", ")}`
  if (!clean) return undefined
  const status = await Git.run(["status", "--porcelain=v2", "-z", "--", ...dirs], {
    cwd: directory,
    worktree: true,
    env: { GIT_LITERAL_PATHSPECS: "1" },
  })
  if (!status.ok) return status.message
  const changed = Porcelain.status(status.stdout).entries.filter(
    (entry) => entry.kind !== "untracked" && entry.kind !== "ignored",
  )
  return changed.length === 0
    ? undefined
    : `가져온 뒤 바뀐 파일이 있어요: ${changed.map((entry) => entry.path).join(", ")}`
}

/** LFS pointers among `blobs` (by path) and whether the shared store has each object (06 §4.4 steps 2-4). */
async function pointers(
  directory: string,
  blobs: ReadonlyArray<{ readonly mode: string; readonly oid: string; readonly size: number; readonly path: string }>,
): Promise<
  | {
      readonly ok: true
      readonly pointers: ReadonlyMap<string, { readonly oid: string; readonly size: number; readonly local: boolean }>
    }
  | { readonly ok: false; readonly message: string }
> {
  const small = blobs.filter((blob) => blob.mode !== "120000" && blob.size <= Lfs.POINTER_MAX_BYTES)
  if (small.length === 0) return { ok: true, pointers: new Map() }
  const query = { cwd: directory, worktree: true }
  const attrs = await Git.run(["check-attr", "--source=HEAD", "-z", "--stdin", "filter"], {
    ...query,
    stdin: Git.nul(small.map((blob) => blob.path)),
  })
  if (!attrs.ok) return { ok: false, message: attrs.message }
  // `<path> NUL <attribute> NUL <value> NUL` triplets.
  const fields = Porcelain.fields(attrs.stdout)
  const tracked = new Set(
    Array.from({ length: Math.floor(fields.length / 3) }, (_, index) => fields.slice(index * 3, index * 3 + 3))
      .filter((triplet) => triplet[2] === "lfs")
      .map((triplet) => triplet[0]),
  )
  const candidates = small.filter((blob) => tracked.has(blob.path))
  if (candidates.length === 0) return { ok: true, pointers: new Map() }
  const contents = await Git.bytes(["cat-file", "--batch"], {
    ...query,
    stdin: Git.lines([...new Set(candidates.map((blob) => blob.oid))]),
  })
  if (!contents.ok) return { ok: false, message: contents.message }
  const parsed = batch(contents.stdout)
  const store = await Lfs.storage(directory)
  if (!store.ok) return store
  const local = new Set(
    (
      await Promise.all(
        [...new Set([...parsed.values()].map((pointer) => pointer.oid))].map(async (oid) =>
          (await Bun.file(Lfs.objectPath(store.dir, oid)).exists()) ? oid : undefined,
        ),
      )
    ).filter((oid) => oid !== undefined),
  )
  return {
    ok: true,
    pointers: new Map(
      candidates.flatMap((blob) => {
        const pointer = parsed.get(blob.oid)
        // An LFS path committed without LFS is an ordinary blob.
        if (!pointer) return []
        return [[blob.path, { ...pointer, local: local.has(pointer.oid) }] as const]
      }),
    ),
  }
}

/** `cat-file --batch` output read by byte counts: `<oid> blob <size>\n<content>\n`, or `<oid> missing\n`. */
function batch(output: Uint8Array) {
  const decoder = new TextDecoder()
  const parsed = new Map<string, Lfs.Pointer>()
  for (let offset = 0; offset < output.length; ) {
    const end = output.indexOf(0x0a, offset)
    if (end < 0) break
    const [oid = "", type, size] = decoder.decode(output.subarray(offset, end)).split(" ")
    if (type !== "blob") {
      offset = end + 1
      continue
    }
    const pointer = Lfs.parsePointer(decoder.decode(output.subarray(end + 1, end + 1 + Number(size))))
    if (pointer) parsed.set(oid, pointer)
    offset = end + 1 + Number(size) + 1
  }
  return parsed
}

/** `a/b/c` → `a/b`; a top-level entry → `""`. */
function parent(file: string) {
  const slash = file.lastIndexOf("/")
  return slash < 0 ? "" : file.slice(0, slash)
}

/** `a/b/c` → `[a, a/b]` (the folders around a folder, root excluded). */
function ancestors(dir: string) {
  const parts = dir.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

function refused(dir: string) {
  const normalized = Cone.normalize(dir)
  return (
    /^[/\\-]/.test(dir) ||
    normalized === "" ||
    normalized.startsWith("-") ||
    normalized.split("/").includes("..") ||
    /[\0\r\n:]/.test(dir)
  )
}
