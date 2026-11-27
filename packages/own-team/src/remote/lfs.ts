export * as RemoteLfs from "./lfs.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import type { OwnTeam } from "@own/protocol"
import { Lfs } from "../git/lfs.js"
import { Git } from "../git/run.js"
import { GitVersion } from "../git/version.js"
import { Steps } from "../ops/steps.js"
import { Services } from "../services.js"
import { RemoteEnv } from "./env.js"

/**
 * `lfs-remote` (06 §3.6, §4.13): on an SSH host the bundled git-lfs becomes the LFS filter of the repository. The host
 * has no git-lfs (dev-host: no global `filter.lfs.*` either), so a checkout there quietly leaves pointer files; and a
 * filter given only through the environment (`GIT_CONFIG_COUNT`) would miss the owners' shells, whose `git add -A &&
 * git commit` would store the binaries for an integration to carry to `main` ([R-review] e9). So:
 *
 *   observe  no LFS files (`ls-files ':(attr:filter=lfs)'`): skipped. The local config already holds the bundled
 *            filter and `<tools>/git-lfs version` answers: done (a resume, TI-11).
 *   act      `<tools>/git-lfs version` answers, then the repository goes on `<OWN_HOME>/tools/git-lfs/repos` and its
 *            local `filter.lfs.*` values are kept in `own-team-lfs.*` (`Lfs.SAVED`), then `git config --local`
 *            filter.lfs.process/smudge/clean/required with the absolute path of
 *            `<OWN_HOME>/tools/git-lfs/current/git-lfs` (`current` follows an update, so the filter stays right). One
 *            write to `<common dir>/config` reaches every worktree and every shell at once; `~/.gitconfig` is never
 *            written. Then `Team.env.lfs` = `own` and the notice `lfs.installed`.
 *   verify   `git config --get filter.lfs.process` is the bundled filter and `<tools>/git-lfs version` answers.
 *
 * `lfs-restore` takes it back (enable's undo, disable): the kept values back, or unset where there were none, while
 * the filter is still own's (`Lfs.restore`), and the repository off the list. own-remote's uninstall does the same for
 * every listed repository before it removes `<OWN_HOME>/tools`, so a required filter never points at a missing tool.
 *
 * The remote own.team cannot reach SSH, so it never uploads anything: without the tool {@link plan} answers
 * `lfs_missing` (own-web uploads it through the local own-remote, `hosts.tools.ensure`, and asks again) and the step
 * fails. The step comes before any step that makes an area or an owner on the host (3.6), and until it is done `git
 * worktree add` is refused for the repository (`Git.LFS_FILTER`), so no owner shell without the filter exists.
 */

export const KIND = "lfs-remote"

/** The undo of {@link KIND} (06 §4.13). */
export const RESTORE = "lfs-restore"

/** The notice's own line (own-web words `lfs.installed` itself). */
export const INSTALLED_TEXT = "원격 호스트에 큰 파일 도구를 준비했어요"

/** Registers `lfs-remote` and `lfs-restore` once per controller (before the runner resumes an op). */
export function register(services: Services.Context) {
  if (!services.steps.get(KIND)) services.steps.register(kind())
  if (!services.steps.get(RESTORE)) services.steps.register(restoreKind())
}

/** The step for the repository whose main folder is `directory` (auto: a config write and a notice, 3.6). */
export function spec(input: { readonly directory: string }): Steps.Spec {
  return { kind: KIND, mode: "auto", args: { directory: input.directory } }
}

/** The step that puts the repository's own LFS filter back (auto: a config write). */
export function restoreSpec(input: { readonly directory: string }): Steps.Spec {
  return { id: "lfs-restore", kind: RESTORE, mode: "auto", args: { directory: input.directory } }
}

/**
 * What a remote service plans before any worktree of the repository at `directory` (enable, a new area): no step
 * without LFS files or with the bundled filter in place, the {@link spec} when only the filter is missing, and
 * `lfs_missing` while the bundled git-lfs is not on the host (`home` = OWN_HOME).
 */
export async function plan(input: {
  readonly directory: string
  readonly home: string
}): Promise<Services.Result<{ readonly steps: ReadonlyArray<Steps.Spec> }>> {
  const used = await GitVersion.usesLfs(input.directory)
  if (!used.ok) return Services.failure("not_git", used.message, { directory: input.directory })
  if (!used.used) return { ok: true, steps: [] }
  const tools = RemoteEnv.tools(input.home)
  if (Bun.which("git-lfs", { PATH: tools }) === null)
    return Services.failure("lfs_missing", `이 저장소는 큰 파일 도구를 쓰는데 ${tools}에 git-lfs가 없어요`, {
      tool: "git-lfs",
      version: null,
    })
  const configured = await Lfs.configured(input.directory, tools)
  if (!configured.ok) return Services.failure("not_git", configured.message, { directory: input.directory })
  return { ok: true, steps: configured.configured ? [] : [spec({ directory: input.directory })] }
}

// ---------------------------------------------------------------------------------------------------------------

const Args = Schema.Struct({ directory: Schema.String })

function kind(): Steps.Kind {
  return Steps.define(KIND, Args, {
    observe: async (args, input) => {
      const used = await GitVersion.usesLfs(args.directory)
      if (!used.ok) return { state: "failed", note: used.message }
      if (!used.used) return { state: "skip", note: "이 저장소는 큰 파일 도구를 쓰지 않아요" }
      const tools = RemoteEnv.tools(input.services.home)
      const configured = await Lfs.configured(args.directory, tools)
      if (!configured.ok) return { state: "failed", note: configured.message }
      if (!configured.configured) return { state: "pending" }
      const ran = await version(tools, input.signal)
      return ran.ok ? { state: "satisfied", note: `git-lfs ${ran.version}` } : { state: "failed", note: ran.message }
    },
    act: async (args, input) => {
      const home = input.services.home
      const tools = RemoteEnv.tools(home)
      const ran = await version(tools, input.signal)
      if (!ran.ok) return { ok: false, note: ran.message }
      // Listed first: an uninstall after a crash between the two still finds the repository.
      const listed = await list(home, args.directory, "add")
      if (listed !== undefined) return { ok: false, note: listed }
      const failed = await Lfs.configure(args.directory, tools, input.signal)
      if (failed !== undefined) return { ok: false, note: failed }
      await installed(input.services, input.op.teamID, ran.version)
      return { ok: true, note: `git-lfs ${ran.version}` }
    },
    verify: async (args, input) => {
      const tools = RemoteEnv.tools(input.services.home)
      const [effective, ran] = await Promise.all([
        Git.run(["config", "--get", "filter.lfs.process"], { cwd: args.directory, worktree: true }),
        version(tools, input.signal),
      ])
      const value = effective.ok ? effective.stdout.trim() : ""
      if (value !== Lfs.filter(tools)["filter.lfs.process"])
        return { ok: false, note: `filter.lfs.process가 이 앱의 git-lfs가 아니에요: ${value || "(없음)"}` }
      return ran.ok ? { ok: true, note: `git-lfs ${ran.version}` } : { ok: false, note: ran.message }
    },
  })
}

function restoreKind(): Steps.Kind {
  return Steps.define(RESTORE, Args, {
    observe: async (args, input) => {
      const found = await Lfs.restorable(args.directory, RemoteEnv.tools(input.services.home))
      if (!found.ok) return { state: "skip", note: found.message }
      return found.restorable ? { state: "pending" } : { state: "satisfied" }
    },
    act: async (args, input) => {
      const home = input.services.home
      const failed = await Lfs.restore(args.directory, RemoteEnv.tools(home), input.signal)
      if (failed !== undefined) return { ok: false, note: failed }
      const unlisted = await list(home, args.directory, "remove")
      return unlisted === undefined ? { ok: true } : { ok: false, note: unlisted }
    },
    verify: async (args, input) => {
      const found = await Lfs.restorable(args.directory, RemoteEnv.tools(input.services.home))
      return found.ok && !found.restorable
        ? { ok: true }
        : { ok: false, note: "이 앱의 큰 파일 도구 설정이 아직 남아 있어요" }
    },
  })
}

/**
 * Adds the repository of `directory` (its absolute git common dir) to {@link RemoteEnv.repos}, or removes it; why it
 * failed, or `undefined`.
 */
async function list(home: string, directory: string, change: "add" | "remove") {
  const common = await Git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: directory,
    worktree: true,
  })
  if (!common.ok) return common.message
  const repo = common.stdout.trim()
  const file = RemoteEnv.repos(home)
  const lines = (
    await Bun.file(file)
      .text()
      .catch(() => "")
  )
    .split("\n")
    .filter((line) => line !== "")
  const next = change === "add" ? [...new Set([...lines, repo])] : lines.filter((line) => line !== repo)
  if (next.length === lines.length && next.every((line, index) => line === lines[index])) return undefined
  return fs
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => Bun.write(file, next.map((line) => `${line}\n`).join("")))
    .then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
}

/** `<tools>/git-lfs version` (30 seconds): the version it prints, or why it did not answer. */
async function version(
  tools: string,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly version: string } | { readonly ok: false; readonly message: string }> {
  const exe = Bun.which("git-lfs", { PATH: tools })
  if (exe === null) return { ok: false, message: `이 호스트에 큰 파일 도구(git-lfs)가 없어요: ${tools}` }
  const proc = Bun.spawn([exe, "version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    signal: AbortSignal.any([signal, AbortSignal.timeout(Git.READ_TIMEOUT_MS)]),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const found = code === 0 ? GitVersion.parseLfs(stdout) : undefined
  if (found === undefined)
    return {
      ok: false,
      message: `큰 파일 도구의 버전을 읽지 못했어요(${exe}): ${stderr.trim() || `종료 코드 ${code}`}`,
    }
  return { ok: true, version: found }
}

/** `Team.env.lfs` = `own` (once the team record exists) and the notice `lfs.installed` (06 §4.13). */
async function installed(services: Services.Context, teamID: OwnTeam.TeamID, found: string) {
  const written = await services.write(teamID, async () => {
    const team = await services.registry.teams.get(teamID)
    if (!team || team.env.lfs === "own") return undefined
    return services.registry.teams.put({ ...team, env: { ...team.env, lfs: "own" } })
  })
  if (written) services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
  services.notices.publish({ teamID, kind: "lfs.installed", text: INSTALLED_TEXT, data: { version: found } })
}
