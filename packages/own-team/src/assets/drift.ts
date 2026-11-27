export * as Drift from "./drift.js"

import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Cone } from "../git/cone.js"
import { Identity } from "../git/identity.js"
import { Measure } from "../git/measure.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import type { Steps } from "../ops/steps.js"
import type { Services } from "../services.js"
import { NeedPaths } from "./need-paths.js"

/**
 * Following HEAD with the cone (06 §4.8). A folder another area added at the top level does not enter this area's
 * cone when its HEAD moves (a merge of the target leaves `tools/` collapsed, and `status` stays clean). So whenever
 * the area's HEAD moved, the complement cone is computed again at the new HEAD; each folder of it the current cone
 * does not hold is weighed, and the ones that are not heavy are added (`sparse-checkout add`, `cone.extra` `auto`, so
 * a later release keeps them, 4.7). It only adds, so Main 멈춤 does not stop it (TI-13); an area that fails the
 * identity check is left alone (TI-14), and no add runs while a collapsed folder holds only ignored files
 * (`Cone.endangered`, through {@link NeedPaths.apply}).
 *
 * A new folder is heavy when adding it would wait for the user (4.6 step 2: missing LFS bytes or disk over the
 * team's thresholds), or under the rule-based measure of 3.4: at least 50 MB and mostly binary or LFS
 * (`Measure.qualifies`). A heavy folder stays collapsed; `team_need_paths` fetches it like any other. Such folders
 * feed the team's heavy list (06 §4.4, `assets/heavy.ts` `offer`: the area's HEAD is measured and the list may grow),
 * and until it has grown the write guard treats them as heavy as well ({@link left}).
 *
 * Noticed in three ways: the shell tool's `execute.after` compares HEAD with the value before the call (`Guard.after`),
 * every run that ends in the team re-checks areas whose HEAD changed at their safe point ({@link create}), and the
 * integration's area sync calls {@link check} (7.2 step 9). HEAD is read from the git dir's files ({@link head}), and
 * the last HEAD checked per area is kept in memory, so an unchanged area costs a few file reads.
 */

/** The step kind of a cone check inside an op (an integration's area sync, 7.2 step 9). */
export const STEP = "drift"

export type Checked =
  | {
      readonly ok: true
      /** Folders added to the cone (`cone.extra` `auto`). */
      readonly added: ReadonlyArray<string>
      /** New folders left collapsed because they are heavy. */
      readonly heavy: ReadonlyArray<string>
    }
  | {
      readonly ok: false
      /**
       * `broken`: the area is not active, or its folder is not its worktree (TI-14), and no git command ran on it;
       * `kept`: an add would delete ignored files in a collapsed folder; `network`: missing LFS objects could not be
       * fetched; `git`: git failed.
       */
      readonly error: "broken" | "kept" | "network" | "git"
      readonly broken?: OwnTeam.BrokenReason
      readonly message: string
    }

/** The drift feature (06 §4.8): checks by id, and the re-check at safe points after runs end. */
export interface Api extends Services.Lifecycle {
  check(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly signal?: AbortSignal
  }): Promise<Checked>
}

/**
 * The feature: registers the `drift` step kind and, after every run that ends (and on resume), checks each active
 * code-only area whose HEAD moved since its last check, at its safe point (8.4) so no owner's git command races the
 * add. An area that is not at its safe point is checked after a later run.
 */
export function create(services: Services.Context): Api {
  register(services)
  const sweep = async () => {
    const teams = await services.registry.teams.list()
    await Promise.all(
      teams
        .filter((team) => team.state === "on")
        .map(async (team) => {
          const areas = await services.registry.areas.list(team.id)
          await Promise.all(
            areas
              .filter((area) => area.state === "active" && area.shape === "code")
              .map(async (area) => {
                if (CHECKED.get(area.directory) === stamp(team, await head(area))) return
                const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id })
                if (!safe.ok) return
                const checked = await check(services, { team, area })
                if (!checked.ok) services.log.warn("drift_failed", { areaID: area.id, error: checked.error })
              }),
          )
        }),
    )
  }
  const stop = services.hub.on(async (event) => {
    if (ENDS.has(event.type)) await sweep()
  })
  return {
    check: async (input) => {
      const [team, area] = await Promise.all([
        services.registry.teams.get(input.teamID),
        services.registry.areas.get(input.teamID, input.areaID),
      ])
      if (!team || !area) return { ok: false, error: "broken", message: "팀이나 영역을 찾을 수 없어요" }
      return check(services, { team, area, ...(input.signal === undefined ? {} : { signal: input.signal }) })
    },
    resume: sweep,
    close: async () => stop(),
  }
}

/**
 * 06 §4.8 for one area: adds the new folders of the complement cone at HEAD that are not heavy. Checks that run at
 * once for the same folder share one run; a HEAD already checked with the same heavy list answers at once.
 */
export function check(
  services: Services.Context,
  input: { readonly team: OwnTeam.Team; readonly area: OwnTeam.Area; readonly signal?: AbortSignal },
): Promise<Checked> {
  const running = RUNNING.get(input.area.directory)
  if (running) return running
  const started = follow(services, input).finally(() => RUNNING.delete(input.area.directory))
  RUNNING.set(input.area.directory, started)
  return started
}

/**
 * `rev-parse HEAD` of a worktree read from its git dir: `HEAD`, then the branch's loose ref or `packed-refs` in the
 * common dir. No process starts, so the tool hooks keep their 50 ms (a git start alone costs about that on Windows);
 * git answers only when the files do not (a ref store without loose refs). `undefined` when nothing can be read.
 */
export async function head(area: Identity.Record): Promise<string | undefined> {
  const text = await read(path.join(area.gitDir, "HEAD"))
  if (text === undefined || !text.startsWith("ref: ")) return text
  const ref = text.slice("ref: ".length)
  const common = path.resolve(area.gitDir, (await read(path.join(area.gitDir, "commondir"))) ?? ".")
  const loose = await read(path.join(common, ...ref.split("/")))
  if (loose !== undefined) return loose
  const packed = (await read(path.join(common, "packed-refs")))?.split("\n").find((line) => line.endsWith(` ${ref}`))
  if (packed !== undefined) return packed.slice(0, packed.indexOf(" "))
  const resolved = await Git.run(["rev-parse", "--verify", "-q", "HEAD"], { cwd: area.directory, worktree: true })
  return resolved.ok ? resolved.stdout.trim() : undefined
}

/**
 * Whether a new folder is heavy (06 §4.8 "무겁지 않은 것"): adding it would wait for the user's confirm (4.6 step 2),
 * or it is at least 50 MB and mostly binary or LFS (the rule of `Measure.qualifies`, 3.4). `binary` is the bytes of
 * its non-LFS binary files.
 */
export function heavy(policy: OwnTeam.Policy, counted: NeedPaths.Count, binary: number) {
  if (NeedPaths.over(policy, counted)) return true
  if (counted.bytes < Measure.HEAVY_BYTES) return false
  return counted.lfsBytes * 2 >= counted.bytes || counted.lfsBytes + binary >= counted.bytes * Measure.BINARY_RATIO
}

/**
 * The new folders the last check of the area folder left collapsed because they are heavy (06 §4.4): the write guard
 * refuses writes into them like into a listed heavy folder until the team's list has grown over them (kept in memory;
 * after a restart the next check finds them again).
 */
export function left(directory: string): ReadonlyArray<string> {
  return LEFT.get(directory) ?? []
}

/** A `drift` step for the area (by any op: it only adds, TI-13). */
export function spec(input: { readonly areaID: OwnTeam.AreaID }): Steps.Spec {
  return { kind: STEP, mode: "auto", args: { areaID: input.areaID } }
}

/** Registers the `drift` step kind once per controller. */
export function register(services: Services.Context) {
  if (!services.steps.get(STEP)) services.steps.register(KIND)
}

/** Events after which an area may be at its safe point again (a run ended). */
const ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
/** The last HEAD (and heavy list) checked per area folder. */
const CHECKED = new Map<string, string>()
/** The heavy new folders the last check left collapsed, per area folder ({@link left}). */
const LEFT = new Map<string, ReadonlyArray<string>>()
const RUNNING = new Map<string, Promise<Checked>>()
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"

async function follow(
  services: Services.Context,
  input: { readonly team: OwnTeam.Team; readonly area: OwnTeam.Area; readonly signal?: AbortSignal },
): Promise<Checked> {
  const area = input.area
  // TI-14: no git command for an area that is not active (a broken one stays as the reconcile left it).
  if (area.state !== "active")
    return {
      ok: false,
      error: "broken",
      message: area.state === "broken" ? "영역이 멈춰 있어요" : "영역을 끝내는 중이거나 끝냈어요",
    }
  if (area.shape !== "code") return { ok: true, added: [], heavy: [] }
  const at = await head(area)
  const key = stamp(input.team, at)
  if (CHECKED.get(area.directory) === key) return { ok: true, added: [], heavy: [] }
  const identity = await Identity.check(area)
  if (!identity.ok) return { ok: false, error: "broken", broken: identity.broken, message: identity.message }
  const listed = await Cone.list(area.directory)
  if (!listed.ok) return { ok: false, error: "git", message: listed.message }
  const current = listed.dirs.map(Cone.normalize)
  // Over HEAD's and the target's folders (06 §4.4): a cone folder whose part became heavy on the target is not taken
  // whole again. Only folders HEAD has are added.
  const [next, own] = await Promise.all([
    Cone.compute(area.directory, "HEAD", input.team.heavy.dirs, [], `refs/heads/${input.team.target}`),
    Cone.compute(area.directory, "HEAD", input.team.heavy.dirs),
  ])
  if (!next.ok) return { ok: false, error: "git", message: next.message }
  if (!own.ok) return { ok: false, error: "git", message: own.message }
  const fresh = next.dirs.filter((dir) => !Cone.covers(current, dir) && Cone.covers(own.dirs, dir))
  const weighed = await Promise.all(
    fresh.map(async (dir) => {
      const counted = await NeedPaths.count(area.directory, [dir], current)
      if (!counted.ok) return { ok: false as const, dir, message: counted.message }
      const binary = await binaryBytes(area.directory, dir, counted, at)
      return { ok: true as const, dir, heavy: heavy(input.team.policy, counted, binary) }
    }),
  )
  const failed = weighed.find((item) => !item.ok)
  if (failed && !failed.ok) return { ok: false, error: "git", message: failed.message }
  const left = weighed.filter((item) => item.ok && item.heavy).map((item) => item.dir)
  const light = weighed.filter((item) => item.ok && !item.heavy).map((item) => item.dir)
  LEFT.set(area.directory, left)
  if (left.length > 0) {
    services.log.info("drift_heavy_left", { areaID: area.id, dirs: left })
    // 06 §4.4: the folders the area's HEAD brought may join the team's list (measured at that commit).
    if (at !== undefined) services.features().heavy.offer({ teamID: input.team.id, rev: at })
  }
  if (light.length === 0) {
    CHECKED.set(area.directory, key)
    return { ok: true, added: [], heavy: left }
  }
  const counted = await NeedPaths.count(area.directory, light, current)
  if (!counted.ok) return { ok: false, error: "git", message: counted.message }
  const applied = await NeedPaths.apply(services, {
    area,
    dirs: light,
    reason: NeedPaths.AUTO,
    counted,
    clean: false,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
  if (!applied.ok)
    return {
      ok: false,
      error: applied.error,
      ...(applied.broken === undefined ? {} : { broken: applied.broken }),
      message: applied.message,
    }
  CHECKED.set(area.directory, key)
  services.log.info("drift_added", { areaID: area.id, dirs: light, bytes: applied.bytes })
  return { ok: true, added: light, heavy: left }
}

function stamp(team: OwnTeam.Team, at: string | undefined) {
  return `${at ?? ""}\n${team.heavy.dirs.join("\n")}`
}

/**
 * The bytes of the non-LFS binary files below `dir` (3.4 step 6, `diff --numstat` of the empty tree): only for a
 * folder of at least 50 MB that is not mostly LFS already, the one case where the answer changes {@link heavy}.
 */
async function binaryBytes(directory: string, dir: string, counted: NeedPaths.Count, at: string | undefined) {
  if (counted.bytes < Measure.HEAVY_BYTES || counted.lfsBytes * 2 >= counted.bytes) return 0
  const query = { cwd: directory, worktree: true, env: { GIT_LITERAL_PATHSPECS: "1" } }
  const [numstat, sizes] = await Promise.all([
    Git.run(
      [
        "-c",
        `core.bigFileThreshold=${Measure.BIG_FILE_BYTES}`,
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-textconv",
        "--no-ext-diff",
        at?.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1,
        "HEAD",
        "--",
        dir,
      ],
      query,
    ),
    Git.run(["ls-tree", "-r", "-z", "--format=%(objectsize)%x09%(path)", "HEAD", "--", dir], query),
  ])
  if (!numstat.ok || !sizes.ok) return 0
  // `<added> TAB <deleted> TAB <path> NUL`; a binary file has `-` for both counts.
  const binary = new Set(
    Porcelain.fields(numstat.stdout)
      .filter((line) => line.startsWith("-\t-\t"))
      .map((line) => line.slice(4)),
  )
  return Porcelain.fields(sizes.stdout).reduce((sum, line) => {
    const tab = line.indexOf("\t")
    return binary.has(line.slice(tab + 1)) ? sum + Number(line.slice(0, tab)) : sum
  }, 0)
}

async function read(file: string) {
  const text = await Bun.file(file)
    .text()
    .catch(() => undefined)
  const trimmed = text?.trim()
  return trimmed ? trimmed : undefined
}

const Args = Schema.Struct({ areaID: OwnTeam.AreaID })
const decodeArgs = Schema.decodeUnknownOption(Args)

/**
 * The `drift` step: the area's cone follows its HEAD. A broken or vanished area is skipped (no git call); an area
 * that fails the identity check fails the step (TI-14 stops the op). A cone that could not grow is only noted: the
 * next HEAD change or safe point tries again.
 */
const KIND: Steps.Kind = {
  kind: STEP,
  observe: async (input) => {
    const found = await load(input)
    if (!found.ok) return found.observed
    if (found.area.shape !== "code") return { state: "satisfied", note: "영역에 모든 폴더가 있어요" }
    return { state: "pending" }
  },
  act: async (input) => {
    const found = await load(input)
    if (!found.ok) return { ok: true, note: "영역을 찾을 수 없어요" }
    const checked = await check(input.services, { team: found.team, area: found.area, signal: input.signal })
    if (!checked.ok && checked.error === "broken") return { ok: false, note: checked.message }
    if (!checked.ok) return { ok: true, note: `가벼운 폴더 범위를 넓히지 못했어요: ${checked.message}` }
    return { ok: true, note: `더한 폴더 ${checked.added.length}개 · 큰 파일 폴더 ${checked.heavy.length}개` }
  },
  verify: async () => ({ ok: true }),
}

async function load(input: Steps.Input) {
  const args = Option.getOrUndefined(decodeArgs(input.step.args))
  if (!args) return { ok: false as const, observed: { state: "failed" as const, note: "단계 정보가 맞지 않아요" } }
  const [team, area] = await Promise.all([
    input.services.registry.teams.get(input.op.teamID),
    input.services.registry.areas.get(input.op.teamID, args.areaID),
  ])
  if (!team || !area || area.state !== "active")
    return { ok: false as const, observed: { state: "skip" as const, note: "쓰는 중인 영역이 아니에요" } }
  return { ok: true as const, team, area }
}
