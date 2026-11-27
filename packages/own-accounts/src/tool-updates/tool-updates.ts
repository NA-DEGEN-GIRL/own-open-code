export * as ToolUpdatesModule from "./tool-updates.js"

import fs from "node:fs/promises"
import path from "node:path"
import { OwnGitHub, OwnID, Registry, ToolUpdates } from "@own/protocol"
import { Store } from "@own/runtime"
import { ClaudeQuiet } from "../claude-agent/quiet.js"
import { Nonces } from "../nonces.js"
import type { Deps } from "../deps.js"
import type { RpcTypes } from "../rpc/types.js"
import { GitHubStore } from "../github/store.js"

/**
 * 설정 > 업데이트 (05 §20, UPD 2026-11-04). own finds the programs it runs on this PC that the user installed (the way
 * the features that run them find them), reads their versions with `--version` in a short allow-listed environment,
 * reads the newest releases from npm's registry and GitHub's releases API (no credentials, at most once a day, never
 * when `새 버전 확인` is off) and keeps them in `tool-updates.json`. An update runs only after `tools.update.plan` showed
 * the exact command and its source and the user confirmed it (`execute` with the plan's nonce), one at a time, never
 * through a shell and never an installer that needs administrator rights: those, and programs without an updater,
 * get manual steps instead. A program Windows refuses to start (Smart App Control) ends the job as `blocked`; own
 * never works around that. The update belongs to the service, not to a window: closing the card leaves it running and
 * the card opened again follows it. While Claude Code's native updater downloads (it prints nothing then) the job
 * carries the size of its temporary file, read once a second (UCP 2026-11-08).
 */
export interface Api {
  readonly view: RpcTypes.Handler<"tools.view">
  readonly settings: RpcTypes.Handler<"tools.settings.set">
  readonly plan: RpcTypes.Handler<"tools.update.plan">
  readonly execute: RpcTypes.Handler<"tools.update.execute">
  readonly status: RpcTypes.Handler<"tools.update.status">
}

/** A started update: its output as it comes, its exit code at the end. */
export interface Process {
  readonly exited: Promise<number>
  readonly kill: () => void
}

/** What the module asks of the PC; tests give fakes, so no test ever runs a real program or an update. */
export interface System {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly which: (name: string) => string | null
  readonly exists: (file: string) => Promise<boolean>
  /** A short command's output (stdout then stderr), `undefined` when it does not start, fails or times out. */
  readonly read: (argv: ReadonlyArray<string>, env: Readonly<Record<string, string>>) => Promise<string | undefined>
  /** Starts an update; throws when the program cannot be started (blocked, missing). */
  readonly start: (
    argv: ReadonlyArray<string>,
    env: Readonly<Record<string, string>>,
    output: (text: string) => void,
  ) => Process
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  /** A folder's files with their sizes, read only; empty when the folder is missing or unreadable. */
  readonly list: (folder: string) => Promise<ReadonlyArray<{ readonly name: string; readonly size: number }>>
}

/** A `--version` that takes longer is given up (Claude Code's first start can take a few seconds). */
export const VERSION_TIMEOUT_MS = 15_000
/** The native updater's temporary file is measured this often while an update of Claude Code runs. */
export const PROBE_MS = 1_000
/** A release listing that does not answer within this is a failed read. */
export const FETCH_TIMEOUT_MS = 10_000
/** A local model server's version is asked this long. */
export const SERVER_TIMEOUT_MS = 2_000
/** Installed versions are read again after this long, or on `refresh`. */
export const INSTALLED_TTL_MS = 60_000

/** The official pages the commands and manual steps come from (05 §20.4). */
export const SOURCES = {
  claudeCode: "https://docs.claude.com/en/docs/claude-code/setup",
  gitForWindows: "https://gitforwindows.org/",
  git: "https://git-scm.com/downloads",
  gitLfs: "https://github.com/git-lfs/git-lfs/releases/latest",
  gh: "https://github.com/cli/cli#installation",
  ripgrep: "https://github.com/BurntSushi/ripgrep/releases/latest",
  githubMcp: "https://github.com/github/github-mcp-server/releases/latest",
} as const

export function create(deps: Deps, system: System = production()): Api {
  const log = deps.log.child("tool-updates")
  const file = new Store.JsonFile({
    file: deps.runtime.layout.toolUpdates,
    schema: ToolUpdates.File,
    fallback: (): ToolUpdates.File => ToolUpdates.defaults,
  })
  const nonces = new Nonces.Scope<typeof ToolUpdates.Plan.Type>(deps.clock)
  const env = environment(system.env)
  const state = {
    found: undefined as { readonly at: number; readonly list: ReadonlyArray<Found> } | undefined,
    checking: undefined as Promise<void> | undefined,
    job: undefined as Running | undefined,
  }
  /** Each listing is read only through its own override, or the real one when nothing at all is overridden (tests). */
  const listing = (name: "npmRegistry" | "githubApi") =>
    deps.endpoints.overrides[name] ??
    (Object.keys(deps.endpoints.overrides).length === 0 ? deps.endpoints.url[name] : undefined)

  const located = async (refresh: boolean) => {
    const now = deps.clock.now()
    if (!refresh && state.found && now - state.found.at < INSTALLED_TTL_MS) return state.found.list
    const github = await GitHubStore.file(deps)
      .read()
      .catch(() => undefined)
    const list = await locate(system, env, github?.settings.server, github?.catalog?.server)
    state.found = { at: now, list }
    return list
  }

  /** Reads the newest release of every component found, keeps what answered; a failed read keeps the last one. */
  const check = (list: ReadonlyArray<Found>) => {
    if (state.checking) return state.checking
    const run = async () => {
      const wanted = list.filter((item) => item.path !== null || item.installed !== null)
      const answers = await Promise.all(
        wanted.map(async (item) => ({ id: item.id, version: await latestOf(item.id, system, listing) })),
      )
      const at = deps.clock.now()
      const failed = answers.filter((answer) => answer.version === undefined).map((answer) => answer.id)
      if (failed.length > 0) log.info("tool_latest_failed", { components: failed })
      await file.update((current) => ({
        ...current,
        checkedAt: at,
        failed,
        latest: {
          ...current.latest,
          ...Object.fromEntries(
            answers.flatMap((answer) => (answer.version ? [[answer.id, { version: answer.version, at }]] : [])),
          ),
        },
      }))
    }
    state.checking = run().finally(() => {
      state.checking = undefined
    })
    return state.checking
  }

  const view = async (refresh: boolean): Promise<ToolUpdates.View> => {
    const list = await located(refresh)
    const current = await file.read()
    const age = current.checkedAt === undefined ? Infinity : deps.clock.now() - current.checkedAt
    const due = age >= (refresh ? ToolUpdates.REFRESH_MS : ToolUpdates.CHECK_EVERY_MS)
    if (current.checkLatest && due) await check(list)
    const stored = current.checkLatest && due ? await file.read() : current
    const servers = await localServers(deps, system)
    return {
      checkLatest: stored.checkLatest,
      ...(stored.checkedAt === undefined ? {} : { checkedAt: stored.checkedAt }),
      failed: stored.checkLatest ? (stored.failed ?? []).filter(isComponent) : [],
      items: list.map((item) => itemOf(item, stored.checkLatest ? (stored.latest[item.id]?.version ?? null) : null)),
      servers,
      hostGitLfs: ToolUpdates.HOST_GIT_LFS,
      ...(state.job ? { job: snapshot(state.job, 0, deps.clock.now()) } : {}),
    }
  }

  const finish = async (job: Running, exitCode: number | null, outcome: "done" | "failed" | "blocked") => {
    const list = await located(true)
    const after = list.find((item) => item.id === job.component)?.installed ?? null
    job.after = after
    job.exitCode = exitCode
    job.endedAt = deps.clock.now()
    job.state = outcome
    log.info("tool_update_ended", {
      component: job.component,
      outcome,
      exitCode,
      before: job.before,
      after,
      elapsed: job.endedAt - job.startedAt,
      ...(job.download ? { download: job.download } : {}),
      ...(job.timedOut ? { timedOut: true } : {}),
    })
  }

  /**
   * Measures the download of Claude Code's native updater: a `<version>.tmp.*` file in its versions folder that was
   * not there at the start (never one a failed earlier run left), else the finished `<version>` file once the
   * temporary one was renamed. An npm install has no such file, so its job has no `download`.
   */
  const measure = async (job: Running, folder: string) => {
    const files = await system.list(folder)
    const fresh = files.filter((file) => file.name.includes(".tmp.") && !job.existing.has(file.name))
    const growing = fresh.reduce<(typeof fresh)[number] | undefined>(
      (largest, file) => (largest && largest.size >= file.size ? largest : file),
      undefined,
    )
    if (growing) {
      job.download = { version: growing.name.slice(0, growing.name.indexOf(".tmp.")), bytes: growing.size }
      return
    }
    const known = job.download
    const done = known && files.find((file) => file.name === known.version)
    if (known && done && done.size > known.bytes) job.download = { version: known.version, bytes: done.size }
  }

  /** Measures once a second until the returned stop, which measures a last time. */
  const watch = async (job: Running) => {
    const folder = job.component === "claude-code" ? claudeVersions(env) : undefined
    if (!folder) return async () => {}
    job.existing = new Set((await system.list(folder)).map((file) => file.name))
    const probe = { cancel: () => {}, stopped: false }
    const next = () => {
      if (probe.stopped) return
      probe.cancel = deps.clock.schedule(PROBE_MS, () => void measure(job, folder).finally(next))
    }
    next()
    return async () => {
      probe.stopped = true
      probe.cancel()
      await measure(job, folder)
    }
  }

  return {
    view: (input, context) =>
      view(input.refresh === true).catch((error: unknown) => {
        log.error("tool_view_failed", { error })
        return context.error("internal_error", "tool versions cannot be read", {})
      }),

    settings: async (input) => {
      await file.update((current) => ({ ...current, checkLatest: input.checkLatest }))
      return view(false)
    },

    plan: async (input, context) => {
      if (state.job?.state === "running")
        return context.error("tool_busy", "another update is running", { id: state.job.id })
      const list = await located(true)
      const item = list.find((entry) => entry.id === input.component)
      const found = item ? itemOf(item, null) : undefined
      if (!item || !found || found.update.type !== "run")
        return context.error("tool_not_updatable", `${input.component} is updated by hand`, {
          component: input.component,
          reason: found?.status === "missing" ? "missing" : "manual",
        })
      const latest = (await file.read()).latest[item.id]?.version ?? null
      const plan = {
        component: item.id,
        command: found.update.command,
        argv: found.update.argv,
        source: found.update.source,
        installed: item.installed,
        latest,
      }
      return { ...nonces.issue(plan), ...plan }
    },

    execute: async (input, context) => {
      if (state.job?.state === "running")
        return context.error("tool_busy", "another update is running", { id: state.job.id })
      const plan = nonces.consume(input.nonce)
      if (!plan) return context.error("nonce_invalid", "the update plan expired or was used", {})
      const job: Running = {
        id: OwnID.Nonce.create(),
        component: plan.component,
        command: plan.command,
        state: "running",
        startedAt: deps.clock.now(),
        endedAt: undefined,
        exitCode: null,
        before: plan.installed,
        after: null,
        output: "",
        dropped: 0,
        existing: new Set(),
        download: undefined,
        timedOut: false,
      }
      state.job = job
      log.info("tool_update_started", { component: job.component, command: job.command })
      const append = (text: string) => {
        const output = job.output + text
        const cut = Math.max(0, output.length - ToolUpdates.OUTPUT_MAX)
        job.output = output.slice(cut)
        job.dropped += cut
      }
      const unwatch = await watch(job)
      const started = startSafely(system, plan.argv, env, append)
      if (!started.ok) {
        await unwatch()
        append(`${started.message}\n`)
        await finish(job, null, "blocked")
        return snapshot(job, 0, deps.clock.now())
      }
      // Never a silent stop: the job says `timedOut` and the card words it. A slow download finishes long before.
      const cancelTimeout = deps.clock.schedule(ToolUpdates.TIMEOUT_MS, () => {
        job.timedOut = true
        log.warn("tool_update_timeout", { component: job.component, elapsed: deps.clock.now() - job.startedAt })
        started.process.kill()
      })
      const ended = async (code: number | null) => {
        cancelTimeout()
        // `running` with an exit code while the version is read again (a new Claude Code's first start is slow).
        job.exitCode = code
        await unwatch()
        await finish(job, code, code === 0 && !job.timedOut ? "done" : "failed")
      }
      void started.process.exited
        .then(ended, () => ended(null))
        .catch((error: unknown) => {
          log.error("tool_update_unfinished", { component: job.component, error })
          job.state = "failed"
        })
      return snapshot(job, 0, deps.clock.now())
    },

    status: async (input, context) => {
      const job = state.job
      if (!job || job.id !== input.id) return context.error("tool_job_not_found", "no such update", { id: input.id })
      return snapshot(job, input.from ?? 0, deps.clock.now())
    },
  }
}

/** A component as found on this PC. */
interface Found {
  readonly id: ToolUpdates.Component
  readonly path: string | null
  readonly installed: string | null
  readonly update: ToolUpdates.Method
  /** ripgrep without one on PATH: core's own pinned copy runs. */
  readonly ownCopy?: true
}

interface Running {
  readonly id: string
  readonly component: ToolUpdates.Component
  readonly command: string
  state: ToolUpdates.Job["state"]
  readonly startedAt: number
  endedAt: number | undefined
  exitCode: number | null
  readonly before: string | null
  after: string | null
  output: string
  /** Characters dropped from the front ({@link ToolUpdates.OUTPUT_MAX}). */
  dropped: number
  /** The versions folder's names at the start: a temporary file an earlier run left there is not this download. */
  existing: ReadonlySet<string>
  download: ToolUpdates.Download | undefined
  timedOut: boolean
}

function snapshot(job: Running, from: number, now: number): ToolUpdates.Job {
  const start = Math.max(0, from - job.dropped)
  return {
    id: job.id,
    component: job.component,
    command: job.command,
    state: job.state,
    startedAt: job.startedAt,
    ...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
    elapsed: Math.max(0, (job.endedAt ?? now) - job.startedAt),
    ...(job.download ? { download: job.download } : {}),
    ...(job.timedOut ? { timedOut: true as const } : {}),
    exitCode: job.exitCode,
    before: job.before,
    after: job.after,
    output: job.output.slice(start),
    from: job.dropped + start,
    length: job.dropped + job.output.length,
  }
}

function itemOf(found: Found, latest: string | null): ToolUpdates.Item {
  const thresholds = ToolUpdates.THRESHOLDS[found.id]
  const judged = found.ownCopy
    ? { status: "current" as const, why: "own_copy" as const }
    : ToolUpdates.status({ found: found.path !== null || found.installed !== null, installed: found.installed, latest, thresholds })
  const threshold = found.ownCopy
    ? ToolUpdates.RIPGREP_PIN
    : thresholds.find((entry) => entry.why === judged.why)?.version
  const minimum = thresholds.find((threshold) => threshold.level === "minimum")?.version
  const recommended = thresholds.findLast((threshold) => threshold.level === "recommended")?.version
  return {
    id: found.id,
    path: found.path,
    installed: found.installed,
    latest,
    ...(minimum ? { minimum } : {}),
    ...(recommended ? { recommended } : {}),
    status: judged.status,
    ...(judged.why ? { why: judged.why } : {}),
    ...(threshold ? { threshold } : {}),
    update: found.update,
    ...(found.id === "github-mcp-server" ? { reviewed: ToolUpdates.GITHUB_MCP_REVIEWED } : {}),
  }
}

function isComponent(value: string): value is ToolUpdates.Component {
  return (ToolUpdates.Component.literals as ReadonlyArray<string>).includes(value)
}

function startSafely(
  system: System,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  output: (text: string) => void,
) {
  // A program Windows refuses (Smart App Control, an antivirus) fails to spawn: that is reported, never worked around.
  try {
    return { ok: true as const, process: system.start(argv, env, output) }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Finds every component the way the feature that runs it does (05 §20.1): Claude Code as core's Claude Agent
 * provider (`OPENCODE_CLAUDE_PATH`, else `claude` on PATH) and then the native install the login window uses, Git and
 * gh on PATH (own-team), git-lfs on PATH or inside Git for Windows (read through `git lfs version`, like own-team),
 * ripgrep on PATH (core and the dsh harness prefer it to core's download), and github-mcp-server only when 설정 >
 * GitHub runs a local one (its version from the last tool check's `serverInfo`, else `--version`).
 */
export async function locate(
  system: System,
  env: Readonly<Record<string, string>>,
  server?: OwnGitHub.Server,
  serverInfo?: string,
): Promise<ReadonlyArray<Found>> {
  const exe = (name: string) => (system.platform === "win32" ? `${name}.exe` : name)
  const home = system.env.USERPROFILE ?? system.env.HOME
  const native = home ? path.join(home, ".local", "bin", exe("claude")) : undefined
  const claude =
    system.env.OPENCODE_CLAUDE_PATH ||
    system.which("claude") ||
    (native && (await system.exists(native)) ? native : null)
  const git = system.which("git")
  const gitRoot = git ? gitInstall(git) : undefined
  const lfsCandidates = [
    system.which("git-lfs"),
    ...(git ? [path.join(path.dirname(git), exe("git-lfs"))] : []),
    // Git for Windows' own copy: `mingw64\bin` up to 2.55, `ucrt64\bin` from 2.56.
    ...(gitRoot ? ["mingw64", "ucrt64", "usr"].map((folder) => path.join(gitRoot, folder, "bin", exe("git-lfs"))) : []),
  ].filter((candidate): candidate is string => candidate !== null)
  const lfs = await firstExisting(system, lfsCandidates)
  const gh = system.which("gh")
  const rg = system.which("rg")
  const read = (argv: ReadonlyArray<string>) => system.read(argv, env).then((output) => version(output))
  const [claudeVersion, gitVersion, lfsVersion, ghVersion, rgVersion] = await Promise.all([
    claude ? read([claude, "--version"]) : null,
    git ? read([git, "--version"]) : null,
    git ? read([git, "lfs", "version"]) : lfs ? read([lfs, "version"]) : null,
    gh ? read([gh, "--version"]) : null,
    rg ? read([rg, "--version"]) : null,
  ])
  const shielded = (file: string) => protectedPath(file, system.env)
  const items: Array<Found> = [
    { id: "claude-code", path: claude, installed: claudeVersion, update: claudeMethod(claude, shielded) },
    { id: "git", path: git, installed: gitVersion, update: gitMethod(git, system.platform, shielded) },
    {
      id: "git-lfs",
      path: lfs ?? null,
      installed: lfsVersion,
      update: lfsMethod(lfs ?? null, lfsVersion, gitRoot, shielded),
    },
    {
      id: "gh",
      path: gh,
      installed: ghVersion,
      update: gh
        ? { type: "manual", why: shielded(gh) ? "elevation" : "no_updater", command: "winget upgrade --id GitHub.cli -e", source: SOURCES.gh }
        : { type: "manual", why: "not_installed", source: SOURCES.gh },
    },
    rg
      ? { id: "ripgrep", path: rg, installed: rgVersion, update: { type: "manual", why: "no_updater", source: SOURCES.ripgrep } }
      : {
          id: "ripgrep",
          path: null,
          installed: null,
          ownCopy: true,
          update: { type: "manual", why: "not_installed", source: SOURCES.ripgrep },
        },
  ]
  if (server?.type !== "local") return items
  const command = path.isAbsolute(server.command) ? server.command : (system.which(server.command) ?? server.command)
  const reported = serverInfo?.startsWith("github-mcp-server ") ? version(serverInfo) : null
  const mcpVersion =
    reported ?? (/github-mcp-server(\.exe)?$/i.test(command) ? await read([command, "--version"]) : null)
  return [
    ...items,
    {
      id: "github-mcp-server",
      path: command,
      installed: mcpVersion,
      update: { type: "manual", why: "no_updater", source: SOURCES.githubMcp },
    },
  ]
}

/**
 * Where Claude Code's native installer keeps its releases (`~/.local/share/claude/versions`, under `%USERPROFILE%` on
 * Windows) in the environment the update runs with.
 */
export function claudeVersions(env: Readonly<Record<string, string | undefined>>) {
  const home = env.USERPROFILE ?? env.HOME
  return home ? path.join(home, ".local", "share", "claude", "versions") : undefined
}

function claudeMethod(claude: string | null, shielded: (file: string) => boolean): ToolUpdates.Method {
  if (!claude) return { type: "manual", why: "not_installed", source: SOURCES.claudeCode }
  if (shielded(claude)) return { type: "manual", why: "elevation", command: "claude update", source: SOURCES.claudeCode }
  // A `.cmd` launcher (an npm install) cannot start without a shell, and own starts no shell: the user runs it.
  if (/\.(cmd|bat|ps1)$/i.test(claude))
    return { type: "manual", why: "script", command: "claude update", source: SOURCES.claudeCode }
  return { type: "run", argv: [claude, "update"], command: "claude update", source: SOURCES.claudeCode }
}

function gitMethod(git: string | null, platform: NodeJS.Platform, shielded: (file: string) => boolean): ToolUpdates.Method {
  if (!git) return { type: "manual", why: "not_installed", source: platform === "win32" ? SOURCES.gitForWindows : SOURCES.git }
  if (platform !== "win32") return { type: "manual", why: "no_updater", source: SOURCES.git }
  // Git for Windows' updater asks before it installs, and an install for all users needs administrator rights.
  return {
    type: "manual",
    why: shielded(git) ? "elevation" : "interactive",
    command: "git update-git-for-windows",
    source: SOURCES.gitForWindows,
  }
}

function lfsMethod(
  lfs: string | null,
  installed: string | null,
  gitRoot: string | undefined,
  shielded: (file: string) => boolean,
): ToolUpdates.Method {
  if (!lfs && installed === null) return { type: "manual", why: "not_installed", source: SOURCES.gitLfs }
  if (lfs && gitRoot && inside(lfs, gitRoot))
    return { type: "manual", why: "bundled", command: "git update-git-for-windows", source: SOURCES.gitForWindows }
  return { type: "manual", why: lfs && shielded(lfs) ? "elevation" : "no_updater", source: SOURCES.gitLfs }
}

/** Git for Windows' folder from its `cmd\git.exe`, `bin\git.exe`, `mingw64\bin\git.exe` or `ucrt64\bin\git.exe`. */
function gitInstall(git: string) {
  const parent = path.dirname(git)
  const name = path.basename(parent).toLowerCase()
  if (name === "cmd" || name === "bin") {
    const up = path.dirname(parent)
    return ["mingw64", "ucrt64"].includes(path.basename(up).toLowerCase()) ? path.dirname(up) : up
  }
  return undefined
}

function inside(file: string, folder: string) {
  const relative = path.relative(folder.toLowerCase(), file.toLowerCase())
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** Installed for all users (Program Files, Windows): its installer needs administrator rights, so own runs none. */
export function protectedPath(file: string, env: Readonly<Record<string, string | undefined>>) {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.SystemRoot, env.windir].filter(
    (root): root is string => !!root,
  )
  return roots.some((root) => inside(file, root))
}

async function firstExisting(system: System, files: ReadonlyArray<string>): Promise<string | undefined> {
  const [first, ...rest] = files
  if (first === undefined) return undefined
  return (await system.exists(first)) ? first : firstExisting(system, rest)
}

function version(output: string | undefined) {
  return output === undefined ? null : (ToolUpdates.parse(output)?.text ?? null)
}

/** The newest release's version from its listing, `undefined` when the listing is off or does not answer. */
async function latestOf(
  id: ToolUpdates.Component,
  system: System,
  listing: (name: "npmRegistry" | "githubApi") => string | undefined,
): Promise<string | undefined> {
  const source = ToolUpdates.LATEST[id]
  const npm = "npm" in source
  const root = listing(npm ? "npmRegistry" : "githubApi")
  if (root === undefined) return undefined
  const url = npm
    ? `${root.replace(/\/$/, "")}/-/package/${source.npm}/dist-tags`
    : `${root.replace(/\/$/, "")}/repos/${source.github}/releases/latest`
  const headers: Record<string, string> = npm
    ? { accept: "application/json" }
    : { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "own-open-code" }
  const answer = await system
    .fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)
  const raw = npm ? (answer as { latest?: unknown } | undefined)?.latest : (answer as { tag_name?: unknown } | undefined)?.tag_name
  return typeof raw === "string" ? ToolUpdates.parse(raw)?.text : undefined
}

/** The `compat` accounts on this PC's loopback and the version Ollama reports; never a credential sent. */
async function localServers(deps: Deps, system: System): Promise<ReadonlyArray<ToolUpdates.Server>> {
  const registry = await deps.runtime.registry.read().catch(() => undefined)
  if (!registry) return []
  const slots = Object.values(registry.slots).filter(
    (slot): slot is Registry.Slot & { baseURL: string } => slot.kind === "compat" && !slot.retired && !!slot.baseURL,
  )
  const local = slots.flatMap((slot) => {
    const url = URL.parse(slot.baseURL)
    if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return []
    const account = registry.accounts.find((entry) => entry.id === slot.accounts[0])
    return [{ label: account?.label ?? url.host, origin: url.origin }]
  })
  return Promise.all(
    local.map(async (server) => {
      const answer = await system
        .fetch(`${server.origin}/api/version`, { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) })
        .then((response) => (response.ok ? response.json() : undefined))
        .catch(() => undefined)
      const reported = (answer as { version?: unknown } | undefined)?.version
      return { label: server.label, url: server.origin, version: typeof reported === "string" ? reported : null }
    }),
  )
}

/**
 * The environment of a `--version` and an update: the system variables a Windows program needs and nothing of the
 * service's own (`ANTHROPIC_*`, `CLAUDE_*`, `OPENCODE_*`, own's variables, the service password, user and PC names).
 * Claude Code's telemetry and error reports stay off here too (decisions TLM); its updater does not, since
 * `claude update` is the update.
 */
export function environment(source: Readonly<Record<string, string | undefined>>) {
  const keep = new Set(ENV_ALLOW.map((name) => name.toUpperCase()))
  return Object.fromEntries([
    ...Object.entries(source).flatMap(([name, value]) =>
      value !== undefined && keep.has(name.toUpperCase()) ? [[name, value] as const] : [],
    ),
    ...Object.entries(ClaudeQuiet.ANONYMOUS),
    ...Object.entries(ClaudeQuiet.FLAGS),
  ])
}

const ENV_ALLOW = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "LC_ALL",
]

/** The real PC: Bun's PATH lookup, `Bun.spawn` without a shell, `fetch`. */
export function production(): System {
  return {
    platform: process.platform,
    env: process.env,
    which: (name) => Bun.which(name),
    exists: (file) =>
      fs.stat(file).then(
        (info) => info.isFile(),
        () => false,
      ),
    read: async (argv, env) => {
      const child = spawnQuiet(argv, env)
      if (!child) return undefined
      const timer = setTimeout(() => child.kill(), VERSION_TIMEOUT_MS)
      timer.unref?.()
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      return code === 0 ? `${stdout}\n${stderr}` : undefined
    },
    start: (argv, env, output) => {
      const child = Bun.spawn([...argv], {
        env: { ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder()
        for await (const chunk of stream) output(decoder.decode(chunk, { stream: true }))
        output(decoder.decode())
      }
      const pumped = Promise.all([pump(child.stdout), pump(child.stderr)])
      return { exited: pumped.then(() => child.exited), kill: () => child.kill() }
    },
    fetch: (url, init) => fetch(url, init),
    list: async (folder) => {
      const names = await fs.readdir(folder).catch(() => [])
      const files = await Promise.all(
        names.map((name) =>
          fs.stat(path.join(folder, name)).then(
            (info) => (info.isFile() ? [{ name, size: info.size }] : []),
            () => [],
          ),
        ),
      )
      return files.flat()
    },
  }
}

function spawnQuiet(argv: ReadonlyArray<string>, env: Readonly<Record<string, string>>) {
  // A program that cannot start (missing, refused by Windows) has no version.
  try {
    return Bun.spawn([...argv], { env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  } catch {
    return undefined
  }
}
