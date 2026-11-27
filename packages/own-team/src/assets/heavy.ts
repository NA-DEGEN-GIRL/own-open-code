export * as Heavy from "./heavy.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { NonNegativeInt } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { Hash } from "@own/runtime"
import { Direct } from "../dispatch/direct.js"
import { Cone } from "../git/cone.js"
import { Measure } from "../git/measure.js"
import { Porcelain } from "../git/porcelain.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import { GitVersion } from "../git/version.js"
import { JudgePrompt } from "../judge/prompt.js"
import { JudgeSchema } from "../judge/schema.js"
import { JudgeValidate } from "../judge/validate.js"
import { Steps } from "../ops/steps.js"
import { Teams } from "../registry/team.js"
import { RemoteLfs } from "../remote/lfs.js"
import { Convert } from "../reorg/convert.js"
import { Services } from "../services.js"
import { BunCache } from "./bun-cache.js"
import { Drift } from "./drift.js"
import { NeedPaths } from "./need-paths.js"
import { Release } from "./release.js"

/**
 * The team's heavy-folder list follows the project (06 §4.4, user decision 2026-10-09). Enable measures the target
 * once and the judge picks the heavy folders; a project the LLM is still building gets its assets later, and they must
 * not be copied into every worktree either. So every new commit of the target, and every commit of an area whose HEAD
 * brought heavy folders the cone drift left out (4.8), is measured again, and folders that became heavy join the list.
 *
 *   measure   `Measure.measure` of the commit (ignored folders skipped), listing folders down to four levels from
 *             the team's size limit
 *   rule      `Measure.ruleBasedHeavy` (at least 50 MB and mostly binary or LFS) plus the size limit of 4.6: the
 *             deepest listed folder whose bytes outside the rule's folders reach `askDiskBytes`, or whose missing LFS
 *             bytes reach `askDownloadBytes`. Folders already listed or undone (`heavy.light`) are not candidates
 *   judge     only when a candidate also holds code (at least {@link CODE_BYTES} not binary): one call on the team
 *             main (`session.generate`, about 5k tokens) picks how to split it (`JudgePrompt.heavy`); the answer is
 *             checked strictly (`JudgeValidate.grown`: folders of the commit inside a candidate, each at least 50 MB
 *             or a quarter of `askDiskBytes` when that is lower, together at least half of it), so repository text
 *             cannot collapse code. Without a usable answer the rule's folder stands
 *   cache     the outcome per commit and list in the team records folder (`heavy/<rev>.json`): the integration's
 *             step, `.verify`, a new area and the op after the advance share one measurement and one judge call
 *
 * The list only grows (V11: a reorganization never edits it); it shrinks only by folders gone from the target and every
 * area. When it grows, a `heavy` op (by auto, undoable) runs:
 *
 *   lfs-remote     on an SSH host whose team did not use LFS (`env.lfs` `unused`) once a folder of the team uses it:
 *                  the bundled git-lfs becomes the filter before more raw binaries are committed (4.13)
 *   heavy-grow     the merged list, `measuredAt` (a target commit), `forcedBytes`; the card's `heavy` line, the
 *                  `heavy.grew` notice and a team update line that does not wake the main
 *   heavy-areas    plans each area: a code-only area records what it held of the new folders (`cone.extra`
 *                  `grown`, so its candidates pass the 4.10 check) and drops automatic additions inside them, then the
 *                  automatic release takes them away once clean (4.7); a `plain` area without the folders converts to
 *                  code-only (nothing leaves, so no file changes and no new owner conversation); a `plain` area that
 *                  holds them (the area that made the assets) is recorded `full` with a suggestion on the card. Main
 *                  멈춤 skips the conversion with the `reorg.skipped` notice (TI-13); a later trigger tries again
 *
 * Triggers, no timer: the controller's start, the end of an op that may move the target or change areas (enable, an
 * integration, a reorganization, 팀에 넣기, an undo, 메인 폴더 바꾸기; any op when a look waited for it), the end of a
 * team session's run, and the cone drift's left-out folders ({@link Api.offer}). A target commit is measured once per
 * controller; an op runs
 * only for a growth or for areas that still need to follow the list. The `heavy` op's undo puts the list back, adds
 * the folders to `heavy.light`, converts the areas back to full folders (with the download confirm of 8.2) and undoes
 * the relabels.
 *
 * Also here: `disk.ignored` (4.11), once per area and folder when an ignored folder of an area reaches
 * `askDiskBytes` after an owner's run (weighed when a new ignored folder appeared, else at most every half hour; the
 * installs of `commands.setup` and own's links excluded; nothing is shared or deleted).
 */

export const KIND = {
  grow: "heavy-grow",
  areas: "heavy-areas",
  code: "heavy-code",
  relabel: "heavy-relabel",
  restore: "heavy-restore",
} as const

/** A candidate holds code when at least this many of its bytes are not binary: the judge splits it then. */
export const CODE_BYTES = 1024 ** 2

/** An area's ignored folders are weighed again at most this often (`disk.ignored`). */
export const IGNORED_EVERY_MS = 30 * 60 * 1000

/** What a commit adds to the team's list. */
export interface Growth {
  readonly rev: string
  /** New heavy folders (outer ones only), sorted. */
  readonly added: ReadonlyArray<string>
  /** Listed folders gone from the target and from every area (measured for the target only). */
  readonly vanished: ReadonlyArray<string>
  /** The team's list with them. */
  readonly dirs: ReadonlyArray<string>
  readonly forcedBytes: number
  /** What a full checkout of the added folders writes (the card's size). */
  readonly bytes: number
  /** The judge split a candidate that holds code. */
  readonly judged: boolean
}

export type Grown = ({ readonly ok: true } & Growth) | { readonly ok: false; readonly message: string }

export interface Api extends Services.Lifecycle {
  /** What `rev` adds to the team's list (cached per commit and list); `prune` also finds vanished folders. */
  growth(input: {
    readonly team: OwnTeam.Team
    readonly rev: string
    readonly prune?: boolean
    readonly signal?: AbortSignal
  }): Promise<Grown>
  /** Looks at the team now (a trigger); resolves when that look ended. */
  check(teamID: OwnTeam.TeamID): Promise<void>
  /** The cone drift left heavy folders of an area's HEAD collapsed (4.8): the list may grow from that commit. */
  offer(input: { readonly teamID: OwnTeam.TeamID; readonly rev: string }): void
}

export interface Options {
  /** {@link CODE_BYTES}; tests lower it. */
  readonly codeBytes?: number
}

/** Registers the step kinds once per controller (the runner resumes ops of them before the feature's resume). */
export function register(services: Services.Context) {
  kinds()
    .filter((kind) => !services.steps.get(kind.kind))
    .forEach((kind) => services.steps.register(kind))
  Convert.register(services)
  RemoteLfs.register(services)
  Release.register(services)
}

export function create(services: Services.Context, options: Options = {}): Api {
  register(services)
  const codeBytes = options.codeBytes ?? CODE_BYTES
  const state = { closed: false }
  /** One look per team at a time; a trigger meanwhile makes one more. */
  const running = new Map<string, Promise<void>>()
  const again = new Set<string>()
  /** Teams whose look found another op running: the end of any op of theirs looks again. */
  const deferred = new Set<string>()
  /** Commits measured by this controller (`<teamID>:<rev>`): one op per commit. */
  const tried = new Set<string>()
  /** Area commits drift offered, per team. */
  const offers = new Map<string, Set<string>>()
  /** Areas an op took, with the list and HEAD it took them with: a run of the area's owner clears it. */
  const attempted = new Map<string, string>()
  /** Code-only area folders that follow a list at a HEAD already: their cone is not read again for it. */
  const adapted = new Map<string, string>()
  /** Teams whose LFS filter on an SSH host needs nothing more from this controller (set, or the tool was missing). */
  const told = new Set<string>()
  /** When an area's ignored folders were last weighed and which there were, and what was announced. */
  const weighed = new Map<string, { readonly at: number; readonly listed: string }>()
  const announced = new Set<string>()
  /** `disk.ignored` checks in progress. */
  const weighings = new Set<Promise<void>>()

  const growth: Api["growth"] = (input) => cached(services, { ...input, codeBytes })

  const look = async (teamID: OwnTeam.TeamID) => {
    const team = await services.registry.teams.get(teamID)
    if (!team || team.state !== "on" || state.closed) return
    if (await services.journal.active(team.id)) {
      deferred.add(team.id)
      return
    }
    deferred.delete(team.id)
    const lfs = await lfsSteps(services, team, told)
    const grown = await next(team)
    const dirs = grown?.dirs ?? team.heavy.dirs
    const needs = await needed(services, team, dirs, { attempted, adapted })
    if (grown && grown.added.length === 0 && grown.vanished.length > 0) await prune(services, team, grown)
    const grew = grown !== undefined && grown.added.length > 0
    if (lfs.length === 0 && !grew && needs.length === 0) return
    needs.forEach((item) => attempted.set(item.areaID, item.key))
    const started = await services.runner.start({
      teamID: team.id,
      kind: "heavy",
      by: "auto",
      undo: { available: grew },
      steps: [
        ...lfs,
        ...(grew ? [growSpec(team, grown)] : []),
        ...(grew || needs.length > 0 ? [{ id: "heavy:areas", kind: KIND.areas, args: { grew } }] : []),
      ],
    })
    if (started.ok) {
      services.log.info("heavy_started", { teamID: team.id, opID: started.op.id, grew, areas: needs.length })
      return
    }
    // Another op began meanwhile: its end looks again, and this commit is measured from the cache then.
    deferred.add(team.id)
    needs.forEach((item) => attempted.delete(item.areaID))
    if (grown) tried.delete(`${team.id}:${grown.rev}`)
    if (grown && !grown.target) offers.set(team.id, new Set([...(offers.get(team.id) ?? []), grown.rev]))
  }

  /** The target's new commit first, then the area commits drift offered; each commit once. */
  const next = async (team: OwnTeam.Team): Promise<(Growth & { readonly target: boolean }) | undefined> => {
    const tip = await Refs.read(team.commonDir, `refs/heads/${team.target}`)
    const targetKey = tip ? `${team.id}:${tip}` : undefined
    if (tip && targetKey && tip !== team.heavy.measuredAt && !tried.has(targetKey)) {
      tried.add(targetKey)
      const found = await growth({ team, rev: tip, prune: true })
      if (!found.ok) services.log.warn("heavy_measure_failed", { teamID: team.id, rev: tip, message: found.message })
      if (found.ok && (found.added.length > 0 || found.vanished.length > 0)) return { ...found, target: true }
    }
    const pending = [...(offers.get(team.id) ?? [])]
    offers.delete(team.id)
    return pending.reduce<Promise<(Growth & { readonly target: boolean }) | undefined>>(async (previous, rev) => {
      const earlier = await previous
      if (earlier) {
        // One growth per op; the others wait for the next look.
        offers.set(team.id, new Set([...(offers.get(team.id) ?? []), rev]))
        return earlier
      }
      const key = `${team.id}:${rev}`
      if (tried.has(key)) return undefined
      tried.add(key)
      const grown = await growth({ team, rev })
      if (!grown.ok) services.log.warn("heavy_measure_failed", { teamID: team.id, rev, message: grown.message })
      return grown.ok && grown.added.length > 0 ? { ...grown, target: false } : undefined
    }, Promise.resolve(undefined))
  }

  const run = (teamID: OwnTeam.TeamID): Promise<void> => {
    if (state.closed) return Promise.resolve()
    const current = running.get(teamID)
    if (current) {
      again.add(teamID)
      return current
    }
    const started = look(teamID)
      .catch((error: unknown) => services.log.warn("heavy_check_failed", { teamID, error }))
      .finally(() => {
        running.delete(teamID)
        if (!again.delete(teamID)) return
        void run(teamID)
      })
    running.set(teamID, started)
    return started
  }

  /**
   * `disk.ignored` (4.11): an owner's run ended. The area's ignored folders are weighed when a new one appeared, and
   * otherwise at most every half hour (weighing walks them for up to five seconds).
   */
  const ignored = async (team: OwnTeam.Team, area: OwnTeam.Area) => {
    const now = services.clock.now()
    const listed = await Git.run(["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], {
      cwd: area.directory,
      worktree: true,
    })
    if (!listed.ok) return
    const last = weighed.get(area.directory)
    if (last !== undefined && last.listed === listed.stdout && now - last.at < IGNORED_EVERY_MS) return
    weighed.set(area.directory, { at: now, listed: listed.stdout })
    const found = await Measure.ignored(area.directory)
    if (!found.ok) return
    const own = new Set([
      ...team.shared.map((item) => Cone.normalize(item.name)),
      ...Object.keys(area.linkCopies ?? {}),
    ])
    found.rows
      .filter((row) => row.bytes > 0 && row.bytes >= team.policy.askDiskBytes)
      .filter((row) => !own.has(row.dir) && !INSTALLS.has(row.dir.split("/").at(-1) ?? ""))
      .filter((row) => !announced.has(`${area.directory}\n${row.dir}`))
      .forEach((row) => {
        announced.add(`${area.directory}\n${row.dir}`)
        services.notices.publish({
          teamID: team.id,
          areaID: area.id,
          kind: "disk.ignored",
          text: `${area.name}: 무시된 폴더가 ${NeedPaths.size(row.bytes)}${row.complete ? "" : " 넘게"} 써요(${row.dir}, 영역 폴더마다 따로 있어요)`,
          data: { dir: row.dir, bytes: row.bytes, complete: row.complete },
        })
      })
  }

  const stopRuns = services.hub.on(async (event) => {
    if (!RUN_ENDS.has(event.type) || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const found = await services.locate.session(event.data.sessionID)
    if (!found || found.team.state !== "on") return
    if (found.role === "owner" && !state.closed) {
      attempted.delete(found.area.id)
      // Tracked, so closing waits for its git and folder reads (a folder being removed is not held open).
      const weighing = ignored(found.team, found.area)
        .catch((error: unknown) => services.log.warn("heavy_ignored_failed", { areaID: found.area.id, error }))
        .finally(() => weighings.delete(weighing))
      weighings.add(weighing)
    }
    await run(found.team.id)
  })
  const stopOps = services.hub.subscribe((event) => {
    if (event.name !== "op.done" || event.data.state === "running") return
    const teamID = event.data.teamID
    void services.journal
      .get(teamID, event.data.opID)
      .then((op) => (deferred.has(teamID) || (op && MOVES.has(op.kind)) ? run(teamID) : undefined))
      .catch((error: unknown) => services.log.warn("heavy_trigger_failed", { teamID, error }))
  })

  return {
    growth,
    check: run,
    offer: (input) => {
      offers.set(input.teamID, new Set([...(offers.get(input.teamID) ?? []), input.rev]))
      void run(input.teamID)
    },
    resume: async () => {
      const teams = await services.registry.teams.list()
      await Promise.all(teams.filter((team) => team.state === "on").map((team) => run(team.id)))
    },
    close: async () => {
      state.closed = true
      stopRuns()
      stopOps()
      again.clear()
      await Promise.all([...running.values(), ...weighings])
    },
  }
}

/** The steps that undo a `heavy` op (06 §4.4 되돌리기); `undefined` when it grew nothing. */
export async function undo(
  services: Services.Context,
  input: { readonly op: OwnTeam.Op; readonly by: OwnTeam.Op["by"] },
): Promise<Services.Result<{ readonly steps: ReadonlyArray<Steps.Spec> }> | undefined> {
  const op = input.op
  const grow = op.steps.find((step) => step.kind === KIND.grow && step.state === "done")
  const args = grow === undefined ? undefined : Option.getOrUndefined(decodeGrow(grow.args))
  if (!args) return undefined
  const team = await services.registry.teams.get(op.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: op.teamID })
  const areaOf = (step: OwnTeam.Step) => Option.getOrUndefined(decodeArea(step.args))?.areaID
  const relabeled = op.steps.flatMap((step) =>
    step.kind === KIND.relabel && step.state === "done" ? Option.toArray(decodeRelabel(step.args)) : [],
  )
  const converted = op.steps.flatMap((step) => {
    const areaID = step.kind === Convert.STEP.code && step.state === "done" ? areaOf(step) : undefined
    return areaID === undefined ? [] : [areaID]
  })
  // The list after the undo: a team that had no heavy folders labels its full folders `plain` again.
  const restored = restoredDirs(team.heavy.dirs, args.added, args.previous.dirs)
  const backs = await Promise.all(
    converted.map(async (areaID): Promise<ReadonlyArray<Steps.Spec>> => {
      const area = await services.registry.areas.get(team.id, areaID)
      if (!area || area.shape !== "code") return []
      const checked = await Convert.check({ team, area, shape: "full" })
      if (!checked.ok) {
        services.log.warn("heavy_undo_convert_refused", { areaID, error: checked.error })
        return []
      }
      return [
        ...Convert.steps({ area, shape: "full", mode: checked.mode, by: input.by }).map((spec, index) => ({
          ...spec,
          id: `heavy:back:${areaID}:${index + 1}`,
        })),
        ...(restored.length === 0
          ? [{ id: `heavy:plain:${areaID}`, kind: KIND.relabel, args: { areaID, from: "full", to: "plain" } }]
          : []),
      ]
    }),
  )
  return {
    ok: true,
    steps: [
      {
        id: "heavy:restore",
        kind: KIND.restore,
        args: { added: [...args.added], previous: args.previous, relabeled: relabeled.map((item) => item.areaID) },
      },
      ...backs.flat(),
      { id: "mark", kind: "undo.mark", args: { opID: op.id } },
    ],
  }
}

/** The run ends after which an area (or the home) may have new commits. */
const RUN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/** Ops after whose end the target or the areas may need the list: enable, an integration, area changes, undo. */
const MOVES: ReadonlySet<OwnTeam.OpKind> = new Set(["enable", "integrate", "reorg", "adopt", "undo", "home"])

/** What `commands.setup` installs: 0.3 keeps installs out of the disk thresholds, so they get no `disk.ignored`. */
const INSTALLS = new Set(["node_modules", ".venv", BunCache.FOLDER])

// ---------------------------------------------------------------------------------------------------------------
// Measuring a commit

const Cache = Schema.Struct({
  stamp: Schema.String,
  rev: OwnTeam.Sha,
  added: Schema.Array(Schema.String),
  vanished: Schema.Array(Schema.String),
  dirs: Schema.Array(Schema.String),
  forcedBytes: NonNegativeInt,
  bytes: NonNegativeInt,
  judged: Schema.Boolean,
})
const decodeCache = Schema.decodeUnknownOption(Schema.fromJsonString(Cache))

/** Growths being measured, by cache file: two callers of the same commit share one measurement and one judge call. */
const MEASURING = new Map<string, Promise<Grown>>()

/** `heavy/<rev>.json` in the team records folder. */
export function cacheFile(team: Pick<OwnTeam.Team, "id" | "commonDir">, rev: string) {
  return path.join(Teams.records(team), "heavy", `${rev}.json`)
}

async function cached(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly rev: string
    readonly prune?: boolean
    readonly signal?: AbortSignal
    readonly codeBytes: number
  },
): Promise<Grown> {
  if (!Git.isOid(input.rev)) return { ok: false, message: `저장 지점이 아니에요: ${input.rev}` }
  const team = input.team
  const stamp = Hash.sha256(
    JSON.stringify({
      dirs: team.heavy.dirs,
      light: team.heavy.light ?? [],
      disk: team.policy.askDiskBytes,
      download: team.policy.askDownloadBytes,
      prune: input.prune === true,
    }),
  )
  const file = cacheFile(team, input.rev)
  const text = await Bun.file(file)
    .text()
    .catch(() => undefined)
  const found = text === undefined ? undefined : Option.getOrUndefined(decodeCache(text))
  if (found?.stamp === stamp) return { ok: true, ...found }
  const key = `${file}\n${stamp}`
  const running = MEASURING.get(key)
  if (running) return running
  const started = measure(services, input)
    .then(async (grown) => {
      if (!grown.ok) return grown
      const record = {
        stamp,
        rev: grown.rev,
        added: grown.added,
        vanished: grown.vanished,
        dirs: grown.dirs,
        forcedBytes: grown.forcedBytes,
        bytes: grown.bytes,
        judged: grown.judged,
      }
      await fs
        .mkdir(path.dirname(file), { recursive: true })
        .then(() => Bun.write(file, JSON.stringify(record)))
        .catch((error: unknown) => services.log.warn("heavy_cache_failed", { file, error }))
      return grown
    })
    .finally(() => MEASURING.delete(key))
  MEASURING.set(key, started)
  return started
}

async function measure(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly rev: string
    readonly prune?: boolean
    readonly signal?: AbortSignal
    readonly codeBytes: number
  },
): Promise<Grown> {
  const team = input.team
  const policy = team.policy
  const measured = await Measure.measure(team.home.directory, input.rev, {
    ignoredMs: 0,
    expandBytes: Math.max(1, policy.askDiskBytes),
  })
  if (!measured.ok) return measured
  const rows = new Map(measured.rows.map((row) => [row.dir, row]))
  const picks = candidates(measured.rows, team)
  const coded = picks.filter((dir) => codeBytes(rows.get(dir)) >= input.codeBytes)
  const floor = Math.min(Measure.HEAVY_BYTES, policy.askDiskBytes / 4)
  const qualifies = (dir: string) => {
    const row = rows.get(dir)
    return row !== undefined && (row.bytes >= floor || over(policy, row))
  }
  const judged =
    coded.length === 0
      ? undefined
      : await judge(services, {
          team,
          rev: input.rev,
          rows: measured.rows,
          candidates: coded,
          qualifies,
          bytes: (dir) => rows.get(dir)?.bytes ?? 0,
          signal: input.signal,
        })
  const added = outer(judged ? [...picks.filter((dir) => !coded.includes(dir)), ...judged] : picks)
  const vanished = input.prune === true ? await vanishedOf(services, team, Object.keys(measured.direct)) : []
  const dirs = outer([...team.heavy.dirs.filter((dir) => !vanished.includes(dir)), ...added])
  const inside = (dir: string) =>
    Object.entries(measured.direct)
      .filter(([folder]) => JudgeValidate.within(dir, folder))
      .reduce((sum, [, entry]) => sum + entry.bytes, 0)
  return {
    ok: true,
    rev: input.rev,
    added,
    vanished,
    dirs,
    forcedBytes: Measure.forced(measured, dirs).bytes,
    bytes: added.reduce((sum, dir) => sum + (rows.get(dir)?.bytes ?? inside(dir)), 0),
    judged: judged !== undefined,
  }
}

/**
 * The rule's candidates (06 §4.4): `Measure.ruleBasedHeavy` and the size limit, without folders the list (or its
 * undone part, `heavy.light`) already covers, and without a folder that would take an undone one back in.
 */
export function candidates(rows: ReadonlyArray<Measure.Row>, team: Pick<OwnTeam.Team, "heavy" | "policy">) {
  const light = (team.heavy.light ?? []).map(Cone.normalize)
  const known = [...team.heavy.dirs.map(Cone.normalize), ...light]
  const rule = Measure.ruleBasedHeavy(rows)
  return outer([...rule, ...sized(rows, rule, team.policy)]).filter(
    (dir) => !Cone.covers(known, dir) && !light.some((item) => JudgeValidate.within(dir, item)),
  )
}

/**
 * The size limit of 4.6 as a rule (drift's `Drift.heavy`): the deepest listed folder whose bytes outside the rule's
 * folders reach `askDiskBytes`, or whose missing LFS bytes outside them reach `askDownloadBytes`. Never the root,
 * never inside a rule folder.
 */
export function sized(rows: ReadonlyArray<Measure.Row>, rule: ReadonlyArray<string>, policy: OwnTeam.Policy) {
  const byDir = new Map(rows.map((row) => [row.dir, row]))
  const exceeds = (row: Measure.Row) => {
    const taken = rule.flatMap((dir) => {
      const inside = JudgeValidate.within(row.dir, dir) ? byDir.get(dir) : undefined
      return inside ? [inside] : []
    })
    return over(policy, {
      bytes: row.bytes - taken.reduce((sum, item) => sum + item.bytes, 0),
      lfsMissing: row.lfsMissing - taken.reduce((sum, item) => sum + item.lfsMissing, 0),
    })
  }
  const children = Map.groupBy(
    rows.filter((row) => row.dir !== ""),
    (row) => parentOf(row.dir),
  )
  return rows
    .filter((row) => row.dir !== "" && !Cone.covers(rule, row.dir) && exceeds(row))
    .filter((row) => !(children.get(row.dir) ?? []).some(exceeds))
    .map((row) => row.dir)
}

/** The 4.6 thresholds over a folder's bytes (`NeedPaths.over` for a measured row). */
function over(policy: OwnTeam.Policy, row: Pick<Measure.Row, "bytes" | "lfsMissing">) {
  return (
    (row.lfsMissing > 0 && row.lfsMissing >= policy.askDownloadBytes) ||
    (row.bytes > 0 && row.bytes >= policy.askDiskBytes)
  )
}

/** Bytes of a row that are not binary; a row whose share step 6 could not read counts its non-LFS bytes. */
function codeBytes(row: Measure.Row | undefined) {
  if (!row) return 0
  if (row.binaryRatio === null) return row.bytes - row.lfsBytes
  return row.bytes * (1 - row.binaryRatio)
}

/** The judge's split of the candidates that hold code, or `undefined` (no main, no answer, nothing usable). */
async function judge(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly rev: string
    readonly rows: ReadonlyArray<Measure.Row>
    readonly candidates: ReadonlyArray<string>
    readonly qualifies: (dir: string) => boolean
    readonly bytes: (dir: string) => number
    readonly signal?: AbortSignal
  },
) {
  const team = input.team
  const prompt = JudgePrompt.heavy({
    rev: input.rev,
    candidates: input.candidates.flatMap((dir) => {
      const row = input.rows.find((item) => item.dir === dir)
      if (!row) return []
      const inside = input.rows
        .filter((item) => item.dir !== dir && JudgeValidate.within(dir, item.dir))
        .toSorted((a, b) => b.bytes - a.bytes || a.dir.localeCompare(b.dir))
      return [{ row, inside }]
    }),
  })
  const answer = await services.http.session.generate(
    { sessionID: team.main.sessionID, directory: team.home.directory, prompt },
    input.signal === undefined ? undefined : { signal: input.signal },
  )
  if (!answer.ok) {
    services.log.warn("heavy_judge_failed", { teamID: team.id, type: answer.type })
    return undefined
  }
  const parsed = JudgeSchema.parseHeavy(answer.value)
  if (!parsed) {
    services.log.warn("heavy_judge_unreadable", { teamID: team.id })
    return undefined
  }
  const checked = JudgeValidate.grown({
    answer: parsed.heavy,
    candidates: input.candidates,
    qualifies: input.qualifies,
    bytes: input.bytes,
  })
  if (checked.rejected.length > 0)
    services.log.info("heavy_judge_rejected", { teamID: team.id, rejected: checked.rejected })
  return checked.dirs
}

/** Listed folders that are no folder of the target any more, nor of any live area's HEAD. */
async function vanishedOf(services: Services.Context, team: OwnTeam.Team, trees: ReadonlyArray<string>) {
  const present = new Set(trees)
  const gone = team.heavy.dirs.filter((dir) => !present.has(Cone.normalize(dir)))
  if (gone.length === 0) return []
  const areas = (await services.registry.areas.list(team.id)).filter(
    (area) => area.state === "active" || area.state === "broken",
  )
  const held = await Promise.all(
    areas.map(async (area) => {
      const head = await Drift.head(area)
      if (head === undefined) return gone
      const listed = await Git.run(["ls-tree", "-d", "-z", "--name-only", head, "--", ...gone], {
        cwd: team.commonDir,
        worktree: true,
        env: { GIT_LITERAL_PATHSPECS: "1" },
      })
      if (!listed.ok) return gone
      return Porcelain.fields(listed.stdout).map(Cone.normalize)
    }),
  )
  const kept = new Set(held.flat())
  return gone.filter((dir) => !kept.has(Cone.normalize(dir)))
}

/** Folders without the ones inside another listed folder, normalized and sorted. */
function outer(dirs: ReadonlyArray<string>) {
  const unique = [...new Set(dirs.map(Cone.normalize).filter(Boolean))]
  return unique.filter((dir) => !unique.some((other) => other !== dir && Cone.covers([other], dir))).toSorted()
}

/** The list an undo leaves: this growth's folders out, the folders they had taken in back. */
function restoredDirs(current: ReadonlyArray<string>, added: ReadonlyArray<string>, previous: ReadonlyArray<string>) {
  const taken = previous.filter((dir) => added.some((item) => JudgeValidate.within(item, Cone.normalize(dir))))
  return outer([...current.filter((dir) => !added.includes(Cone.normalize(dir))), ...taken])
}

function stampOf(dirs: ReadonlyArray<string>) {
  return dirs.map(Cone.normalize).toSorted().join("\n")
}

function parentOf(dir: string) {
  const slash = dir.lastIndexOf("/")
  return slash < 0 ? "" : dir.slice(0, slash)
}

/** `a/b/c` → `[a, a/b]`. */
function ancestorsOf(dir: string) {
  const parts = dir.split("/")
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))
}

/** Vanished folders leave the list without an op (nothing grew; no area changes). */
async function prune(services: Services.Context, team: OwnTeam.Team, grown: Growth) {
  const written = await services.write(team.id, async () => {
    const current = await services.registry.teams.get(team.id)
    if (!current) return undefined
    return services.registry.teams.put({
      ...current,
      heavy: {
        ...current.heavy,
        dirs: current.heavy.dirs.filter((dir) => !grown.vanished.includes(dir)),
        forcedBytes: grown.forcedBytes,
      },
    })
  })
  if (written) services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
}

// ---------------------------------------------------------------------------------------------------------------
// Planning the areas

/**
 * What a code-only area changes for the list: the parts of heavy folders its cone holds and its HEAD has (`grown`:
 * not what `need_paths` fetched, which a release handles already); the heavy folders its cone would take in although
 * HEAD does not have them yet (`wide`: a cone folder around them, `Assets` whole while only the target has
 * `Assets/Textures`; the next merge would check them out, so the cone narrows first); and its automatic additions
 * inside a heavy folder or around one of those (they would keep it in the cone on the next `set`).
 */
async function codeChange(area: OwnTeam.Area, dirs: ReadonlyArray<string>, target: string) {
  const listed = await Cone.list(area.directory)
  if (!listed.ok) return undefined
  const cone = listed.dirs.map(Cone.normalize)
  const heavy = dirs.map(Cone.normalize)
  const extra = Object.entries(area.cone.extra)
  const fetched = extra.filter(([, entry]) => entry.reason !== NeedPaths.AUTO).map(([dir]) => Cone.normalize(dir))
  const parts = heavy.flatMap((dir) => {
    if (Cone.covers(fetched, dir)) return []
    if (Cone.covers(cone, dir)) return [dir]
    return cone.filter((item) => JudgeValidate.within(dir, item) && !Cone.covers(fetched, item))
  })
  // A folder the cone would hold but HEAD does not have is not held: it comes in only through a merge, so it counts
  // once the target has it (narrowing over HEAD and the target can keep it out only then).
  const held = parts.length === 0 ? [] : await presentAt(area.directory, "HEAD", parts)
  const missing = parts.filter((dir) => !held.includes(dir))
  const wide = missing.length === 0 ? [] : await presentAt(area.directory, `refs/heads/${target}`, missing)
  const dropped = extra
    .filter(([dir, entry]) => {
      const normal = Cone.normalize(dir)
      if (entry.reason !== NeedPaths.AUTO) return false
      return (
        heavy.some((item) => Cone.covers([item], normal)) ||
        [...held, ...wide].some((item) => Cone.covers([normal], item))
      )
    })
    .map(([dir]) => dir)
  const grown = held.filter((dir) => area.cone.extra[dir]?.reason !== NeedPaths.GROWN)
  if (grown.length === 0 && dropped.length === 0 && wide.length === 0) return undefined
  return { grown, dropped, wide }
}

/**
 * The cone of a code-only area narrowed for the list (06 §4.4): the complement over HEAD's and the target's folders
 * plus `cone.extra`, set only when nothing HEAD has leaves the folder (so no file changes and nothing needs a check;
 * what the area holds of a heavy folder goes through the release, 4.7), at the extended safe point, never under Main
 * 멈춤 (TI-13), and never when `set` would delete ignored files (`Cone.endangered`).
 */
/** What the heavy step did to the cone ({@link narrow}, `nothing` when nothing grew wide), in 자세히's words. */
const NARROWED: Readonly<Record<Awaited<ReturnType<typeof narrow>> | "nothing", string>> = {
  nothing: "그대로",
  same: "그대로",
  narrowed: "좁혔어요",
  kept: "남은 파일이 있어 그대로",
  paused: "메인 멈춤이나 직접 작업 중이라 다음에",
  busy: "일하는 중이라 다음에",
  git: "Git 오류로 그대로",
}

/** What became of the release after the heavy step ({@link Release.afterHeavy}). */
const RELEASED = { started: "시작했어요", waiting: "기다려요", skipped: "할 것 없음" } as const

async function narrow(services: Services.Context, team: OwnTeam.Team, area: OwnTeam.Area) {
  if (Direct.kept(area)) return "paused"
  const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id, extended: true })
  if (!safe.ok) return "busy"
  const query = { cwd: area.directory, worktree: true }
  const [listed, next, trees] = await Promise.all([
    Cone.list(area.directory),
    Cone.compute(area.directory, "HEAD", team.heavy.dirs, Object.keys(area.cone.extra), `refs/heads/${team.target}`),
    Git.run(["ls-tree", "-r", "-d", "-z", "--name-only", "HEAD"], query),
  ])
  if (!listed.ok || !next.ok || !trees.ok) return "git"
  const current = listed.dirs.map(Cone.normalize)
  // A folder is open under a cone when it is in it, or around one of its folders (its own files are checked out).
  const opens = (cone: ReadonlyArray<string>) => {
    const parents = new Set(cone.flatMap(ancestorsOf))
    return (dir: string) => Cone.covers(cone, dir) || parents.has(dir)
  }
  const before = opens(current)
  const after = opens(next.dirs)
  const leaving = Porcelain.fields(trees.stdout)
    .map(Cone.normalize)
    .filter((dir) => before(dir) && !after(dir))
  if (leaving.length > 0) return "kept"
  if (current.toSorted().join("\n") === next.dirs.toSorted().join("\n")) return "same"
  const risky = await Cone.endangered(area.directory, next.dirs)
  if (!risky.ok || risky.dirs.length > 0) return "kept"
  const set = await Cone.set({ directory: area.directory, gitDir: area.gitDir }, next.dirs)
  return set.ok ? "narrowed" : "git"
}

/** The folders of `dirs` (none inside another) that `rev` has. */
async function presentAt(directory: string, rev: string, dirs: ReadonlyArray<string>) {
  const listed = await Git.run(["ls-tree", "-d", "-z", "--name-only", rev, "--", ...dirs], {
    cwd: directory,
    worktree: true,
    env: { GIT_LITERAL_PATHSPECS: "1" },
  })
  if (!listed.ok) return []
  const found = new Set(Porcelain.fields(listed.stdout).map(Cone.normalize))
  return dirs.filter((dir) => found.has(dir))
}

/**
 * The areas that still need to follow `dirs` (a trigger starts an op only for these), each with the key it was
 * looked at with (the list and the area's HEAD): plain areas at their extended safe point, and code-only areas whose
 * cone records differ (read once per key: `adapted`). An area an op already took with that key waits for its owner's
 * next run (`attempted`), so an op that could not finish it never repeats itself. Main 멈춤 waits (TI-13).
 */
async function needed(
  services: Services.Context,
  team: OwnTeam.Team,
  dirs: ReadonlyArray<string>,
  memory: { readonly attempted: ReadonlyMap<string, string>; readonly adapted: Map<string, string> },
): Promise<ReadonlyArray<{ readonly areaID: OwnTeam.AreaID; readonly key: string }>> {
  // Only a list that grew leaves areas behind (a team whose list never grew has nothing to follow).
  if (dirs.length === 0 || team.heavy.grownAt === undefined) return []
  const stamp = stampOf(dirs)
  const listed = (await services.registry.areas.list(team.id)).filter(
    (area) => area.state === "active" && !Direct.kept(area) && (area.shape === "code" || area.shape === "plain"),
  )
  // The key: the list, the area's HEAD and the target's tip (a merge or an integration looks again).
  const tip = (await Refs.read(team.commonDir, `refs/heads/${team.target}`)) ?? ""
  const areas = await Promise.all(
    listed.map(async (area) => ({ area, key: `${stamp}\n${(await Drift.head(area)) ?? ""}\n${tip}` })),
  )
  const open = areas.filter((item) => memory.attempted.get(item.area.id) !== item.key)
  const version = open.some((item) => item.area.shape === "plain")
    ? await GitVersion.check(team.home.directory)
    : undefined
  const found = await Promise.all(
    open.map(async (item) => {
      const area = item.area
      const take = [{ areaID: area.id, key: item.key }]
      if (area.shape === "code") {
        if (memory.adapted.get(area.directory) === item.key) return []
        if (await codeChange(area, dirs, team.target)) return take
        memory.adapted.set(area.directory, item.key)
        return []
      }
      if (!version?.ok || version.shape !== "code") return []
      const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id, extended: true })
      return safe.ok ? take : []
    }),
  )
  return found.flat()
}

/**
 * G8 (06 §4.13): on an SSH host a team that did not use LFS when it was enabled (`env.lfs` `unused`) gets the bundled
 * git-lfs as the repository's filter as soon as the home or an area uses LFS, so owners' commits store pointers, not
 * the binaries. Without the tool on the host the main is told once (own-web uploads it when an RPC answers
 * `lfs_missing`; this background look has no caller to answer).
 */
async function lfsSteps(
  services: Services.Context,
  team: OwnTeam.Team,
  told: Set<string>,
): Promise<ReadonlyArray<Steps.Spec>> {
  if (Git.tools() === undefined || team.env.lfs !== "unused" || told.has(team.id)) return []
  const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state === "active")
  const used = await [team.home.directory, ...areas.map((area) => area.directory)].reduce<Promise<string | undefined>>(
    async (previous, directory) => {
      const found = await previous
      if (found !== undefined) return found
      const checked = await GitVersion.usesLfs(directory)
      return checked.ok && checked.used ? directory : undefined
    },
    Promise.resolve(undefined),
  )
  if (used === undefined) return []
  const planned = await RemoteLfs.plan({ directory: used, home: services.home })
  if (planned.ok && planned.steps.length > 0) return planned.steps.map((spec) => ({ ...spec, id: "heavy:lfs" }))
  told.add(team.id)
  if (planned.ok) return []
  services.log.warn("heavy_lfs_missing", { teamID: team.id, error: planned.error, message: planned.message })
  await services.features().digest.add(team.id, {
    at: services.clock.now(),
    reason: "heavy",
    text: "이 저장소가 Git LFS를 쓰기 시작했지만 원격 호스트에 큰 파일 도구(git-lfs)가 없습니다. 영역을 새로 만들거나 팀 구성을 다시 보면 own이 도구를 올립니다. 그 전에 커밋한 큰 파일은 LFS가 아니라 그대로 저장됩니다",
    wake: false,
  })
  return []
}

/** The planner's step for one area; `undefined` when it has nothing to do. */
async function areaStep(
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  grew: boolean,
  version: GitVersion.Check | undefined,
): Promise<(Steps.Spec & { readonly id: string }) | undefined> {
  if (area.state !== "active") return undefined
  if (area.shape === "code")
    return (await codeChange(area, team.heavy.dirs, team.target))
      ? { id: `heavy:code:${area.id}`, kind: KIND.code, args: { areaID: area.id } }
      : undefined
  if (area.shape !== "plain" || team.heavy.dirs.length === 0) return undefined
  // Main 멈춤 or direct work on a list that did not grow now: nothing to tell, a later trigger converts it.
  if (Direct.kept(area) && !grew) return undefined
  if (!version?.ok || version.shape !== "code") return undefined
  if (await holds(team, area))
    return {
      id: `heavy:relabel:${area.id}`,
      kind: KIND.relabel,
      args: { areaID: area.id, from: "plain", to: "full" },
    }
  return { id: `heavy:convert:${area.id}`, kind: Convert.STEP.code, args: { areaID: area.id, item: KIND.areas } }
}

/** A plain area holds a heavy folder: on disk, or in its HEAD (where a conversion would take it away). */
async function holds(team: OwnTeam.Team, area: OwnTeam.Area) {
  const dirs = team.heavy.dirs.map(Cone.normalize)
  const disk = await Promise.all(
    dirs.map((dir) =>
      fs
        .stat(path.join(area.directory, ...dir.split("/")))
        .then((stat) => stat.isDirectory())
        .catch(() => false),
    ),
  )
  if (disk.some(Boolean)) return true
  const listed = await Git.run(["ls-tree", "-d", "-z", "--name-only", "HEAD", "--", ...dirs], {
    cwd: area.directory,
    worktree: true,
    env: { GIT_LITERAL_PATHSPECS: "1" },
  })
  return !listed.ok || listed.stdout.length > 0
}

// ---------------------------------------------------------------------------------------------------------------
// Step kinds

const Previous = Schema.Struct({
  dirs: Schema.Array(Schema.String),
  measuredAt: Schema.NullOr(OwnTeam.Sha),
  forcedBytes: NonNegativeInt,
})

const GrowArgs = Schema.Struct({
  rev: OwnTeam.Sha,
  /** A commit of the target (its `measuredAt`), or an area's HEAD. */
  target: Schema.Boolean,
  added: Schema.Array(Schema.String),
  vanished: Schema.Array(Schema.String),
  forcedBytes: NonNegativeInt,
  bytes: NonNegativeInt,
  previous: Previous,
})
const decodeGrow = Schema.decodeUnknownOption(GrowArgs)
const AreasArgs = Schema.Struct({ grew: Schema.Boolean })
const AreaArgs = Schema.Struct({ areaID: OwnTeam.AreaID })
const decodeArea = Schema.decodeUnknownOption(AreaArgs)
const RelabelArgs = Schema.Struct({
  areaID: OwnTeam.AreaID,
  from: Schema.Literals(["plain", "full"]),
  to: Schema.Literals(["plain", "full"]),
})
const decodeRelabel = Schema.decodeUnknownOption(RelabelArgs)
const RestoreArgs = Schema.Struct({
  added: Schema.Array(Schema.String),
  previous: Previous,
  relabeled: Schema.Array(OwnTeam.AreaID),
})

function growSpec(team: OwnTeam.Team, grown: Growth & { readonly target: boolean }): Steps.Spec {
  return {
    id: "heavy:grow",
    kind: KIND.grow,
    args: {
      rev: grown.rev,
      target: grown.target,
      added: [...grown.added],
      vanished: [...grown.vanished],
      forcedBytes: grown.forcedBytes,
      bytes: grown.bytes,
      previous: { dirs: [...team.heavy.dirs], measuredAt: team.heavy.measuredAt, forcedBytes: team.heavy.forcedBytes },
    },
  }
}

/** The list once `args` applied to `current`. */
function grownList(current: OwnTeam.Team["heavy"], args: typeof GrowArgs.Type) {
  return outer([...current.dirs.filter((dir) => !args.vanished.includes(dir)), ...args.added])
}

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.grow, GrowArgs, {
      observe: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        if (!team) return { state: "failed", note: "팀을 찾을 수 없어요" }
        return applied(team, args) ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const written = await services.write(input.op.teamID, async () => {
          const current = await services.registry.teams.get(input.op.teamID)
          if (!current) return undefined
          return services.registry.teams.put({
            ...current,
            heavy: {
              ...current.heavy,
              dirs: grownList(current.heavy, args),
              measuredAt: args.target ? args.rev : current.heavy.measuredAt,
              grownAt: args.rev,
              forcedBytes: args.forcedBytes,
            },
          })
        })
        if (!written) return { ok: false, note: "팀을 찾을 수 없어요" }
        services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
        const text = `큰 파일 폴더 ${args.added.length}개(${NeedPaths.size(args.bytes)})가 늘어 영역 폴더에 받지 않아요`
        input.summary({ kind: "heavy", dirs: [...args.added], bytes: args.bytes })
        services.notices.publish({
          teamID: written.id,
          kind: "heavy.grew",
          text,
          data: { count: args.added.length, bytes: args.bytes, dirs: args.added.join(", ") },
        })
        // The main reads it with its next team update; nothing to decide, so it does not wake.
        await services.features().digest.add(written.id, {
          at: services.clock.now(),
          reason: "heavy",
          text: `${text}: ${args.added.join(", ")}. 담당이 필요하면 team_need_paths로 가져와요`,
          wake: false,
        })
        return { ok: true, note: args.added.join(", ") }
      },
      verify: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        return team && applied(team, args) ? { ok: true } : { ok: false, note: "큰 파일 폴더 목록이 기록되지 않았어요" }
      },
    }),

    Steps.define(KIND.areas, AreasArgs, {
      observe: async (_args, input) =>
        input.op.steps.some((step) => step.id.startsWith("heavy:") && step.id.includes(":ar_"))
          ? { state: "satisfied" }
          : { state: "pending" },
      act: async (args, input) => {
        const services = input.services
        const team = await services.registry.teams.get(input.op.teamID)
        if (!team) return { ok: false, note: "팀을 찾을 수 없어요" }
        const areas = await services.registry.areas.list(team.id)
        const version = areas.some((area) => area.shape === "plain")
          ? await GitVersion.check(team.home.directory)
          : undefined
        const planned = await Promise.all(areas.map((area) => areaStep(team, area, args.grew, version)))
        const specs = planned.flatMap((spec) => (spec ? [spec] : []))
        await append(services, input.op, specs)
        return { ok: true, note: `영역 ${specs.length}개` }
      },
      verify: async () => ({ ok: true }),
    }),

    Steps.define(KIND.code, AreaArgs, {
      observe: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return { state: "skip", note: "쓰는 중인 영역이 아니에요" }
        if (found.area.shape !== "code") return { state: "satisfied" }
        return { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const found = await load(input, args.areaID)
        if (!found) return { ok: true, note: "영역을 찾을 수 없어요" }
        const change = await codeChange(found.area, found.team.heavy.dirs, found.team.target)
        if (change) {
          const at = services.clock.now()
          await NeedPaths.update(services, found.team.id, found.area.id, (current) => ({
            ...current,
            cone: {
              extra: {
                ...Object.fromEntries(
                  Object.entries(current.cone.extra).filter(([dir]) => !change.dropped.includes(dir)),
                ),
                ...Object.fromEntries(
                  change.grown.map((dir) => [
                    dir,
                    { reason: NeedPaths.GROWN, at, bytes: current.cone.extra[dir]?.bytes ?? 0 },
                  ]),
                ),
              },
              kept: current.cone.kept,
            },
          }))
        }
        // Heavy folders the cone would take in with the next merge: the cone narrows first (no file changes).
        const area = await services.registry.areas.get(found.team.id, found.area.id)
        const narrowed = change && change.wide.length > 0 && area ? await narrow(services, found.team, area) : "nothing"
        // Clean ones go at the area's next extended safe point, skipped under Main 멈춤 (4.7, TI-13).
        const released = await Release.afterHeavy(services, { teamID: found.team.id, areaID: found.area.id })
        return {
          ok: true,
          note: `늘어난 폴더 ${change?.grown.length ?? 0}개 · 빠진 폴더 ${change?.dropped.length ?? 0}개 · 가벼운 폴더 범위 ${NARROWED[narrowed]} · 큰 파일 폴더 내려놓기 ${RELEASED[released.state]}`,
        }
      },
      verify: async () => ({ ok: true }),
    }),

    Steps.define(KIND.relabel, RelabelArgs, {
      observe: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return { state: "skip", note: "쓰는 중인 영역이 아니에요" }
        if (found.area.shape === args.to) return { state: "satisfied" }
        if (found.area.shape !== args.from)
          return { state: "skip", note: `영역이 이미 ${found.area.shape === "code" ? "가벼운 폴더" : "전체 폴더"}예요` }
        return { state: "pending" }
      },
      act: async (args, input) => {
        const found = await load(input, args.areaID)
        if (!found) return { ok: true, note: "영역을 찾을 수 없어요" }
        await NeedPaths.update(input.services, found.team.id, found.area.id, (current) =>
          current.shape === args.from ? { ...current, shape: args.to } : current,
        )
        // 06 §4.4: the area that made the assets keeps them; converting it replaces its conversation, so it is only
        // suggested (the area menu's 가벼운 폴더로 바꾸기), never done silently.
        if (args.to === "full")
          input.summary({
            kind: "suggest",
            suggestion: {
              kind: "convert",
              area: found.area.id.slice("ar_".length),
              worktree: found.area.directory,
              why: "새 큰 파일 폴더가 이 폴더에 있어요. 가벼운 폴더로 바꾸면 디스크를 아껴요",
            },
          })
        return { ok: true }
      },
      verify: async (args, input) => {
        const found = await load(input, args.areaID)
        return !found || found.area.shape === args.to
          ? { ok: true }
          : { ok: false, note: "영역의 폴더 종류가 바뀌지 않았어요" }
      },
    }),

    Steps.define(KIND.restore, RestoreArgs, {
      observe: async (args, input) => {
        const team = await input.services.registry.teams.get(input.op.teamID)
        if (!team) return { state: "failed", note: "팀을 찾을 수 없어요" }
        const light = (team.heavy.light ?? []).map(Cone.normalize)
        const restored = args.added.every(
          (dir) => !team.heavy.dirs.map(Cone.normalize).includes(dir) && light.includes(dir),
        )
        return restored ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const services = input.services
        const written = await services.write(input.op.teamID, async () => {
          const current = await services.registry.teams.get(input.op.teamID)
          if (!current) return undefined
          return services.registry.teams.put({
            ...current,
            heavy: {
              ...current.heavy,
              dirs: restoredDirs(current.heavy.dirs, args.added, args.previous.dirs),
              forcedBytes: args.previous.forcedBytes,
              light: outer([...(current.heavy.light ?? []), ...args.added]),
            },
          })
        })
        if (!written) return { ok: false, note: "팀을 찾을 수 없어요" }
        services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
        // Relabels taken back, and the `grown` records of the folders that are not heavy any more.
        const grownOf = (area: OwnTeam.Area) =>
          Object.entries(area.cone.extra).flatMap(([dir, entry]) =>
            entry.reason === NeedPaths.GROWN && args.added.some((item) => Cone.covers([item], Cone.normalize(dir)))
              ? [dir]
              : [],
          )
        const relabel = (area: OwnTeam.Area) => args.relabeled.includes(area.id) && area.shape === "full"
        const areas = (await services.registry.areas.list(written.id)).filter(
          (area) => relabel(area) || grownOf(area).length > 0,
        )
        await Promise.all(
          areas.map((area) =>
            NeedPaths.update(services, written.id, area.id, (current) => {
              const grown = grownOf(current)
              return {
                ...current,
                ...(relabel(current) ? { shape: "plain" as const } : {}),
                cone: {
                  extra: Object.fromEntries(Object.entries(current.cone.extra).filter(([dir]) => !grown.includes(dir))),
                  kept: current.cone.kept,
                },
              }
            }),
          ),
        )
        return { ok: true, note: args.added.join(", ") }
      },
      verify: async () => ({ ok: true }),
    }),
  ]
}

/** The growth is in the team record: every added folder listed, every vanished one gone, the target commit recorded. */
function applied(team: OwnTeam.Team, args: typeof GrowArgs.Type) {
  const dirs = team.heavy.dirs.map(Cone.normalize)
  return (
    args.added.every((dir) => Cone.covers(dirs, dir)) &&
    args.vanished.every((dir) => !dirs.includes(Cone.normalize(dir))) &&
    (!args.target || team.heavy.measuredAt === args.rev)
  )
}

async function load(input: Steps.Input, areaID: OwnTeam.AreaID) {
  const [team, area] = await Promise.all([
    input.services.registry.teams.get(input.op.teamID),
    input.services.registry.areas.get(input.op.teamID, areaID),
  ])
  if (!team || !area || area.state !== "active") return undefined
  return { team, area }
}

/** Appends the planner's steps right after it (the end of the op), each id once. */
async function append(
  services: Services.Context,
  op: OwnTeam.Op,
  specs: ReadonlyArray<Steps.Spec & { readonly id: string }>,
) {
  if (specs.length === 0) return
  await services.write(op.teamID, async () => {
    const current = await services.journal.get(op.teamID, op.id)
    if (!current) throw new Error(`작업 기록이 없어요: ${op.id}`)
    const known = new Set(current.steps.map((step) => step.id))
    await services.journal.put({
      ...current,
      steps: [
        ...current.steps,
        ...specs
          .filter((spec) => !known.has(spec.id))
          .map((spec) => ({
            id: spec.id,
            kind: spec.kind,
            args: { ...spec.args },
            mode: spec.mode ?? ("auto" as const),
            state: "pending" as const,
          })),
      ],
    })
  })
}
