export * as Verify from "./verify.js"

import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { Hash, ProcessTree } from "@own/runtime"
import { BunCache } from "../assets/bun-cache.js"
import { Symlinks } from "../assets/symlinks.js"
import { Cone } from "../git/cone.js"
import { Home } from "../git/home.js"
import { Identity } from "../git/identity.js"
import { Porcelain } from "../git/porcelain.js"
import { Git } from "../git/run.js"
import { GitVersion } from "../git/version.js"
import { Worktree } from "../git/worktree.js"
import { Teams } from "../registry/team.js"

/**
 * The code verify folder (06 §7.2 step 6): `<worktreeRoot>/.verify`, a worktree own keeps for itself, code-only like an
 * area (the complement cone of the heavy folders), with a detached HEAD, locked `own.team verify`, no session and no
 * user work. It stays between integrations because an install is expensive (about 2.5 GB copied per folder on this
 * PC), and it is moved to each candidate K right before the checks:
 *
 *   absent    4.5 with `--detach` at K (`Worktree.create` of a `Worktree.Detached` plan)
 *   present   identity check (TI-14) → reset --hard K → clean -fdx -e node_modules -e .own-bun-cache -e /<shared>…
 *             → the complement cone at K of the heavy list as it is once K is the target (`Input.heavy`, the
 *               integration's measurement of K, 06 §4.4: a new heavy folder stays out at its own depth, code beside it
 *               comes in), set only after `Cone.endangered` finds nothing → link copies (4.12) → every non-heavy
 *               top-level folder of K is in the cone ([R-review] e10)
 *   setup     `commands.setup` when the lockfiles at K (or the setup command) changed, with `BunCache.env` (own's cache
 *             on the worktrees' volume, 4.12)
 *   checks    `commands.code` one after another until one fails: exit code, duration, and the output's last 64 KB in
 *             `integrations/<igID>.log` of the team records folder (6.6)
 *
 * The clean runs before the cone changes, so the only ignored files `Cone.endangered` can still find are the ones the
 * clean keeps. A restarted controller continues instead of starting over (06 §2.6 (d)): `verify/<K>.json` holds each
 * command's result as soon as it ends, `verify/folder.json` the folder's identity and the K it was last prepared for.
 * A finished result for K answers without running anything (a failed one only for the integration that ran it); a
 * folder still prepared for K runs only the commands without a result. The asset check folder (`assets/verify.ts`,
 * step 7) reuses the command runner, the record and result helpers, {@link change} and {@link refused}.
 */

export const DIRECTORY = ".verify"

export const LOCK_REASON = "own.team verify"

/** The output kept per integration (6.6). */
export const TAIL_BYTES = 64 * 1024

export const COMMAND_TIMEOUT_MS = 30 * 60 * 1000

/**
 * How long a failed command's exit waits before it counts. When the service's whole process tree is ended at once (a
 * forced stop, `taskkill /T /F`), the command dies a moment before the service does and exits non-zero; recording that
 * exit would answer the resumed op with a failed check that never ran to its end (seen in TG11, 06 §11.3). After this
 * wait the service is gone too, so such a command leaves no result and runs again on resume (06 §2.6 (d)).
 */
export const FAILED_GRACE_MS = 2_000

/** Root lockfiles: a change in any of them at K runs `commands.setup` again. */
export const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
]

/** `<worktreeRoot>/.verify`. */
export function directory(team: Pick<OwnTeam.Team, "worktreeRoot">) {
  return path.join(team.worktreeRoot, DIRECTORY)
}

/** The record files in the team records folder (2.4). */
export function files(team: Pick<OwnTeam.Team, "id" | "commonDir">, integrationID: string, candidate: string) {
  const records = Teams.records(team)
  return {
    folder: path.join(records, "verify", "folder.json"),
    results: path.join(records, "verify", `${candidate}.json`),
    log: path.join(records, "integrations", `${integrationID}.log`),
  }
}

/** Whether every non-heavy top-level folder of K is in the folder's cone (`Integration.verify.cone`). */
export interface Coverage {
  readonly ok: boolean
  readonly missing: ReadonlyArray<string>
}

export interface Input {
  readonly team: OwnTeam.Team
  readonly integrationID: string
  /** K. */
  readonly candidate: string
  /**
   * The heavy list as it is once K is the target (06 §4.4, the integration's step 5½, `assets/heavy.ts`); default the
   * team's list. The folder is code-only by it, so new heavy folders of K stay out and new code folders come in.
   */
  readonly heavy?: ReadonlyArray<string>
  readonly signal?: AbortSignal
  /** Before each check: `Integration.checks` (`검사 1/2`, 9.7). */
  readonly progress?: (checks: { readonly current: number; readonly total: number }) => Promise<void>
}

export type Outcome =
  /** The checks ran, or a finished result for K answered (`reused`); `code.ok` says whether they passed. */
  | { readonly state: "done"; readonly code: OwnTeam.VerifyResult; readonly cone: Coverage; readonly reused: boolean }
  /** A non-heavy top-level folder of K is outside the cone, or changing the cone would delete ignored files. */
  | { readonly state: "cone"; readonly cone: Coverage; readonly message: string }
  /** The folder is not the verify worktree own recorded (TI-14); nothing changed in it. */
  | { readonly state: "broken"; readonly message: string }
  | { readonly state: "failed"; readonly message: string }
  /** The signal stopped it; the command it stopped has no result and runs again. */
  | { readonly state: "stopped" }

/** Moves the verify folder to K and runs the setup and the code checks there (see the module comment). */
export async function run(input: Input): Promise<Outcome> {
  const team = input.team
  const where = files(team, input.integrationID, input.candidate)
  const commands = Hash.sha256(JSON.stringify({ setup: team.commands.setup, code: team.commands.code }))
  const found = await read(where.results, decodeResults)
  const earlier = found?.commands === commands && found.candidate === input.candidate ? found : undefined
  const total = team.commands.code.length
  if (earlier && finished(earlier, total) && (earlier.integrationID === input.integrationID || result(earlier).ok))
    return { state: "done", code: result(earlier), cone: earlier.cone, reused: true }

  const folder = await prepare(input, where.folder)
  if (folder.state !== "ready") return folder
  // A folder prepared again (reset, clean) lost what earlier commands left in it: they all run again. A resumed one
  // keeps the results that passed and runs a failed command again (a failed result of another integration).
  const start: Results =
    earlier && folder.resumed
      ? {
          ...earlier,
          integrationID: input.integrationID,
          log: where.log,
          ...(earlier.setup?.code === 0 ? {} : { setup: undefined }),
          runs: earlier.runs.filter((item) => item.code === 0),
        }
      : {
          candidate: input.candidate,
          integrationID: input.integrationID,
          commands,
          log: where.log,
          cone: folder.cone,
          runs: [],
        }
  const installed = await install(input, where, folder.target.directory, start)
  if (installed.state !== "ready") return installed
  const next = async (current: Results): Promise<Results | undefined> => {
    if (finished(current, total)) return current
    const index = current.runs.length
    await input.progress?.({ current: index + 1, total })
    const ran = await execute(team.commands.code[index], {
      cwd: folder.target.directory,
      log: where.log,
      signal: input.signal,
    })
    if (!ran) return undefined
    const updated = { ...current, runs: [...current.runs, ran] }
    await save(where.results, updated)
    return next(updated)
  }
  const ended = await next(installed.results)
  if (!ended) return { state: "stopped" }
  return { state: "done", code: result(ended), cone: ended.cone, reused: false }
}

// ---------------------------------------------------------------------------------------------------------------
// Records

/** One command's result in a results file (`verify/<K>.json`, and `assets/<K>.json` of `assets/verify.ts`). */
export const Run = Schema.Struct({
  label: Schema.String,
  code: Schema.NullOr(Schema.Finite),
  ms: NonNegativeInt,
  at: Schema.Finite,
})
export type Run = typeof Run.Type

/** What {@link finished} and {@link result} read of a results file. */
export interface Runs {
  readonly setup?: Run | undefined
  readonly runs: ReadonlyArray<Run>
  readonly log: string
}

/** `verify/folder.json`. */
const Folder = Schema.Struct({
  directory: Schema.String,
  /** The identity checked before anything changes the folder (4.3). */
  gitDir: Schema.String,
  /** The K the folder was last fully prepared for (reset, clean, cone, link copies). */
  prepared: optional(OwnTeam.Sha),
  /** The lockfiles and setup command of the last setup that exited 0. */
  setup: optional(Schema.String),
  linkCopies: optional(Schema.Record(Schema.String, OwnTeam.Sha)),
})
type Folder = typeof Folder.Type

/** `verify/<K>.json`. */
const Results = Schema.Struct({
  candidate: OwnTeam.Sha,
  /** The integration that ran them: a failed result answers only that integration again. */
  integrationID: Schema.String,
  /** The setup and code commands the results belong to: other commands run again. */
  commands: Schema.String,
  log: Schema.String,
  cone: Schema.Struct({ ok: Schema.Boolean, missing: Schema.Array(Schema.String) }),
  /** The setup, when it ran for this K. */
  setup: optional(Run),
  runs: Schema.Array(Run),
})
type Results = typeof Results.Type

const decodeFolder = Schema.decodeUnknownOption(Schema.fromJsonString(Folder))
const decodeResults = Schema.decodeUnknownOption(Schema.fromJsonString(Results))

/** A record file of the team records folder; `undefined` when it is missing or does not decode. */
export async function read<T>(file: string, decode: (text: string) => Option.Option<T>) {
  const text = await Bun.file(file)
    .text()
    .catch(() => undefined)
  return text === undefined ? undefined : Option.getOrUndefined(decode(text))
}

/** Writes a record file as JSON, making its folder. */
export async function save(file: string, value: unknown) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(value))
}

/** The setup failed, a check failed, or every check has a result. */
export function finished(results: Pick<Runs, "setup" | "runs">, total: number) {
  if (results.setup !== undefined && results.setup.code !== 0) return true
  return results.runs.some((item) => item.code !== 0) || results.runs.length >= total
}

/** The run as `Integration.verify`: the first failed command, the summed duration and the log. */
export function result(results: Runs): OwnTeam.VerifyResult {
  const all = [...(results.setup ? [results.setup] : []), ...results.runs]
  const failed = all.find((item) => item.code !== 0)
  return {
    ok: failed === undefined,
    ms: all.reduce((sum, item) => sum + item.ms, 0),
    ...(failed === undefined ? {} : { failed: failed.label }),
    log: results.log,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The folder

/** Why the preparation stops. */
type Stop = Exclude<Outcome, { readonly state: "done" }>

/** A part of the preparation that went through, or why everything stops. */
type Step = { readonly state: "ready" } | Stop

type Prepared =
  | {
      readonly state: "ready"
      readonly target: Identity.Record
      readonly cone: Coverage
      /** Still prepared for K by an earlier run: nothing was reset or cleaned. */
      readonly resumed: boolean
    }
  | Stop

/** Makes or finds the verify folder and moves it to K (see the module comment). */
async function prepare(input: Input, record: string): Promise<Prepared> {
  const team = input.team
  const candidate = input.candidate
  const dir = directory(team)
  // 4.12: inside the main folder, own's `.gitignore` keeps the folder (and the setup's Bun cache) out of listings.
  await Home.ignore(team.worktreeRoot)
  const recorded = await read(record, decodeFolder)
  const known = recorded && Identity.same(recorded.directory, dir) ? recorded : undefined
  const listed = input.heavy ?? team.heavy.dirs
  const shape = await shapeOf(listed)
  const top = await topLevel(team.commonDir, candidate, input.signal)
  if (!top.ok) return { state: "failed", message: top.message }
  const heavy = shape === "code" ? [...listed] : []
  const cone = shape === "code" ? await Cone.compute(team.commonDir, candidate, heavy) : { ok: true as const, dirs: [] }
  if (!cone.ok) return { state: "failed", message: cone.message }
  const plan: Worktree.Detached = {
    detach: true,
    lockReason: LOCK_REASON,
    home: team.home.directory,
    directory: dir,
    base: candidate,
    shape,
    cone: cone.dirs,
    heavy,
    ...(known === undefined ? {} : { gitDir: known.gitDir }),
  }
  const observed = await Worktree.observe(plan)
  if (!observed.ok) return refused(observed)
  const made =
    observed.state === "populated"
      ? observed
      : await Worktree.create(plan, { askDownloadBytes: team.policy.askDownloadBytes, signal: input.signal })
  if (!made.ok) return refused(made)
  if (made.state === "confirm")
    return { state: "failed", message: `검증 폴더에 큰 파일 ${made.missing.bytes}바이트가 필요해요` }
  const target = { directory: dir, gitDir: made.gitDir }
  // A folder made now has no install and no link copies, whatever an earlier folder recorded.
  const kept = observed.state === "populated" ? known : undefined
  const identity = {
    directory: dir,
    gitDir: made.gitDir,
    ...(kept?.setup === undefined ? {} : { setup: kept.setup }),
  }
  await save(record, { ...identity, ...(kept?.linkCopies === undefined ? {} : { linkCopies: kept.linkCopies }) })

  const head = await Git.run(["rev-parse", "HEAD"], { cwd: dir, worktree: true, signal: input.signal })
  const resumed = kept?.prepared === candidate && head.ok && head.stdout.trim() === candidate
  const moved = resumed
    ? { state: "ready" as const, linkCopies: kept?.linkCopies }
    : await move(input, target, { shape, cone: cone.dirs, linkCopies: kept?.linkCopies })
  if (moved.state !== "ready") return moved
  const coverage =
    shape === "code" ? await covered(dir, top.dirs, heavy) : { ok: true as const, coverage: { ok: true, missing: [] } }
  if (!coverage.ok) return { state: "failed", message: coverage.message }
  if (!coverage.coverage.ok)
    return {
      state: "cone",
      cone: coverage.coverage,
      message: `검증 폴더 범위에 없어요: ${coverage.coverage.missing.join(", ")}`,
    }
  await save(record, {
    ...identity,
    prepared: candidate,
    ...(moved.linkCopies === undefined ? {} : { linkCopies: moved.linkCopies }),
  })
  return { state: "ready", target, cone: coverage.coverage, resumed }
}

/**
 * reset --hard K, clean, the cone and the link copies. Each git command that changes the folder runs right after the
 * identity check (TI-14); the cone changes only when it differs and `Cone.endangered` finds nothing (T1 review #12).
 */
async function move(
  input: Input,
  target: Identity.Record,
  wanted: {
    readonly shape: "code" | "plain"
    readonly cone: ReadonlyArray<string>
    readonly linkCopies: Readonly<Record<string, string>> | undefined
  },
): Promise<{ readonly state: "ready"; readonly linkCopies: Readonly<Record<string, string>> | undefined } | Stop> {
  const reset = await change(target, ["reset", "-q", "--hard", input.candidate], input.signal)
  if (reset.state !== "ready") return reset
  const keep = ["node_modules", BunCache.FOLDER, ...input.team.shared.map((item) => `/${Cone.normalize(item.name)}`)]
  const clean = await change(target, ["clean", "-fdx", ...keep.flatMap((pattern) => ["-e", pattern])], input.signal)
  if (clean.state !== "ready") return clean
  if (wanted.shape === "code") {
    const narrowed = await cone(target, wanted.cone)
    if (narrowed.state !== "ready") return narrowed
  }
  const links = await Symlinks.apply({
    area: { directory: target.directory, gitDir: target.gitDir, shape: wanted.shape, linkCopies: wanted.linkCopies },
    fix: input.team.env.symlinkFix,
    signal: input.signal,
  })
  if (!links.ok) return { state: links.error === "broken" ? "broken" : "failed", message: links.message }
  return { state: "ready", linkCopies: links.linkCopies }
}

/**
 * `sparse-checkout set` to `dirs` when the folder's cone differs, unless that would delete ignored files. A folder made
 * while the team had no heavy folders is not sparse yet (`sparse-checkout list` refuses): its cone counts as empty, so
 * the first heavy folders of the list fold it (06 §4.4).
 */
async function cone(target: Identity.Record, dirs: ReadonlyArray<string>): Promise<Step> {
  const listed = (await sparse(target.directory)) ? await Cone.list(target.directory) : { ok: true as const, dirs: [] }
  if (!listed.ok) return { state: "failed", message: listed.message }
  const wanted = dirs.map(Cone.normalize).toSorted()
  const current = listed.dirs.map(Cone.normalize).toSorted()
  if (wanted.length === current.length && wanted.every((dir, index) => dir === current[index]))
    return { state: "ready" }
  const endangered = await Cone.endangered(target.directory, wanted)
  if (!endangered.ok) return { state: "failed", message: endangered.message }
  if (endangered.dirs.length > 0)
    return {
      state: "cone",
      cone: { ok: false, missing: [] },
      message: `범위를 바꾸면 무시된 파일이 지워져요: ${endangered.dirs.join(", ")}`,
    }
  const set = await Cone.set(target, wanted)
  if (set.ok) return { state: "ready" }
  return { state: set.error === "broken" ? "broken" : "failed", message: set.message }
}

/** One git command that changes the folder, after the identity check (TI-14). */
export async function change(
  target: Identity.Record,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<{ readonly state: "ready" } | Extract<Stop, { readonly state: "broken" | "failed" | "stopped" }>> {
  const identity = await Identity.check(target)
  if (!identity.ok) return { state: "broken", message: identity.message }
  const result = await Git.run(args, { cwd: target.directory, worktree: true, write: true, signal })
  if (result.ok) return { state: "ready" }
  if (result.reason === "aborted") return { state: "stopped" }
  return { state: "failed", message: `git ${args[0]}: ${result.message}` }
}

/** A folder that is not the recorded verify worktree is left alone (`broken`); other failures are `failed`. */
export function refused(failure: {
  readonly error: Worktree.Failure
  readonly message: string
}): Extract<Stop, { readonly state: "broken" | "failed" }> {
  if (failure.error === "broken" || failure.error === "path_forbidden")
    return { state: "broken", message: failure.message }
  return { state: "failed", message: failure.message }
}

/** `code` with heavy folders on Git 2.42 or newer (`check-rules`), else a full folder (4.2), as areas are made. */
async function shapeOf(heavy: ReadonlyArray<string>): Promise<"code" | "plain"> {
  if (heavy.length === 0) return "plain"
  const version = await Git.run(["version"])
  const parsed = version.ok ? GitVersion.parse(version.stdout) : undefined
  return parsed !== undefined && GitVersion.atLeast(parsed, GitVersion.CODE_ONLY) ? "code" : "plain"
}

/** `core.sparseCheckout` is on in the folder. */
async function sparse(directory: string) {
  const result = await Git.run(["config", "--type=bool", "--get", "core.sparseCheckout"], {
    cwd: directory,
    worktree: true,
  })
  return result.ok && result.stdout.trim() === "true"
}

/** The top-level folders of `rev`. */
async function topLevel(repo: string, rev: string, signal?: AbortSignal) {
  const result = await Git.run(["ls-tree", "-d", "-z", "--name-only", rev], { cwd: repo, worktree: true, signal })
  if (!result.ok) return { ok: false as const, message: result.message }
  return { ok: true as const, dirs: Porcelain.fields(result.stdout) }
}

/** Every top-level folder of K that is neither heavy nor holds a heavy folder is entirely in the cone (`check-rules`). */
async function covered(directory: string, top: ReadonlyArray<string>, heavy: ReadonlyArray<string>) {
  const dirs = heavy.map(Cone.normalize)
  const expected = top.filter((dir) => !Cone.covers(dirs, dir) && !dirs.some((item) => item.startsWith(`${dir}/`)))
  const inside = await Cone.inside(directory, expected)
  if (!inside.ok) return { ok: false as const, message: inside.message }
  const missing = expected.filter((dir) => !inside.dirs.includes(dir))
  return { ok: true as const, coverage: { ok: missing.length === 0, missing } }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

/** `commands.setup` when the lockfiles at K or the command changed since the last setup that exited 0. */
async function install(
  input: Input,
  where: ReturnType<typeof files>,
  cwd: string,
  results: Results,
): Promise<{ readonly state: "ready"; readonly results: Results } | Stop> {
  const setup = input.team.commands.setup
  if (setup === null || results.setup !== undefined) return { state: "ready", results }
  const locks = await Git.run(["ls-tree", "-z", input.candidate, "--", ...LOCKFILES], {
    cwd: input.team.commonDir,
    worktree: true,
    signal: input.signal,
  })
  if (!locks.ok) return { state: "failed", message: locks.message }
  const hash = Hash.sha256(`${JSON.stringify(setup)}\0${locks.stdout}`)
  const record = await read(where.folder, decodeFolder)
  if (record?.setup === hash) return { state: "ready", results }
  const ran = await execute(setup, { cwd, log: where.log, env: BunCache.env(input.team), signal: input.signal })
  if (!ran) return { state: "stopped" }
  const updated = { ...results, setup: ran }
  await save(where.results, updated)
  if (ran.code === 0 && record) await save(where.folder, { ...record, setup: hash })
  return { state: "ready", results: updated }
}

/**
 * Runs one command in `cwd` and appends its output to `log`, which keeps its last {@link TAIL_BYTES}: argv without a
 * shell, or a shell string the way core runs one (`bash -lc` on Linux, `cmd.exe /d /s /c` on Windows, 06 §4.3). A
 * command that cannot start fails with the reason in the log. The signal or the time limit ({@link COMMAND_TIMEOUT_MS}
 * unless `timeoutMs`) ends the command's whole process tree (`ProcessTree`), so no build it started keeps running in
 * the folder; a command over the limit fails with `[timed out after N min]` in the log. `undefined` when the signal
 * stopped it.
 */
export async function execute(
  command: OwnTeam.Command,
  input: {
    readonly cwd: string
    readonly log: string
    readonly env?: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
    readonly timeoutMs?: number
  },
): Promise<Run | undefined> {
  const label = "argv" in command ? command.argv.join(" ") : command.shell
  const windows = process.platform === "win32"
  const limit = input.timeoutMs ?? COMMAND_TIMEOUT_MS
  await fs.promises.mkdir(path.dirname(input.log), { recursive: true })
  const output = fs.openSync(input.log, "a")
  fs.writeSync(output, `$ ${label}\n`)
  const started = performance.now()
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
            cwd: input.cwd,
            stdin: "ignore",
            stdout: output,
            stderr: output,
            windowsVerbatimArguments: windows && "shell" in command,
            ...(input.env === undefined ? {} : { env: { ...process.env, ...input.env } }),
          },
        ),
        { signal: input.signal, timeoutMs: limit },
      ),
    )
    .catch((error: unknown) => {
      fs.writeSync(output, `${error instanceof Error ? error.message : String(error)}\n`)
      return { code: null, stop: undefined }
    })
  const ms = Math.round(performance.now() - started)
  if (ended.code !== 0) await Bun.sleep(FAILED_GRACE_MS)
  const timedOut = ended.stop === "timeout" ? `\n[timed out after ${limit / 60_000} min]` : ""
  fs.writeSync(output, `${timedOut}\n[exit ${ended.code ?? "-"} · ${ms} ms]\n`)
  fs.closeSync(output)
  await tail(input.log)
  if (input.signal?.aborted) return undefined
  return { label, code: ended.code, ms, at: Date.now() }
}

/** Keeps the last {@link TAIL_BYTES} of `file`. */
async function tail(file: string) {
  const blob = Bun.file(file)
  if (blob.size <= TAIL_BYTES) return
  await Bun.write(file, await blob.slice(blob.size - TAIL_BYTES).arrayBuffer())
}

/**
 * A check result with its log's text (the log keeps its last {@link TAIL_BYTES}) in place of its path, for
 * `integration.get` and `team_status{detail}`. A log outside the team records folder `records`, or one that cannot be
 * read, is left out.
 */
export async function withLog(
  records: string | undefined,
  result: OwnTeam.VerifyResult,
): Promise<OwnTeam.VerifyResult> {
  const { log, ...rest } = result
  if (log === undefined || records === undefined || !Identity.inside(records, log)) return rest
  const text = await Bun.file(log)
    .text()
    .catch(() => undefined)
  return text === undefined ? rest : { ...rest, log: text }
}
