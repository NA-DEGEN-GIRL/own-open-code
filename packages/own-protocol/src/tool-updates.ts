export * as ToolUpdates from "./tool-updates.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { EpochMillis } from "./id.js"

/**
 * 설정 > 업데이트 (05 §20, UPD 2026-11-04): the programs own runs on this PC that the user installed and updates
 * outside own's release. own reads their versions, asks the official release listings for the newest one (npm's
 * registry and GitHub's releases API, no credentials, once a day, off by switch), says what a feature needs, and runs
 * an official update command only after the user's click on a card that shows that exact command. own never installs
 * one of them, never runs an installer that needs administrator rights and never changes a system setting.
 *
 * Not here (05 §20.1): the Codex CLI (own's codex harness is its own port and runs no `codex`), OS parts (OpenSSH,
 * PowerShell, tar, taskkill), Tailscale (read for the gateway only), the editor own opens files in, MCP servers the
 * user added, and what own ships itself (own-vault, own-cu-helper, Electron, the SSH-host bundle).
 */

/** The components, in the page's order. */
export const Component = Schema.Literals(["claude-code", "git", "git-lfs", "gh", "ripgrep", "github-mcp-server"]).annotate(
  { identifier: "Own.ToolUpdates.Component" },
)
export type Component = typeof Component.Type

/**
 * `current`: nothing to do. `recommended`: a feature works better on a newer one, or a newer release exists.
 * `required`: a feature refuses this version. `missing`: not found (own never installs it). `unknown`: found, but its
 * version could not be read.
 */
export const Status = Schema.Literals(["current", "recommended", "required", "missing", "unknown"]).annotate({
  identifier: "Own.ToolUpdates.Status",
})
export type Status = typeof Status.Type

/**
 * Why the status is what it is; the page words each one (05 §20.3). The first group names a {@link Threshold}'s
 * reason, the rest are general.
 */
export const Why = Schema.Literals([
  /** Claude Code below 2.1.248: core's Claude Agent refuses it (it may read user text as Claude commands). */
  "claude_verbatim",
  /** Claude Code below 2.1.257: core cannot ask it for the models' context windows and uses conservative ones. */
  "claude_context",
  /** Claude Code older than the one own's Claude Agent SDK was built with (its manifest's version). */
  "claude_sdk",
  /** Git below 2.40: team mode is refused (no `merge-tree --write-tree`). */
  "git_team",
  /** Git below 2.42: team mode makes full worktrees instead of code-only ones (no `sparse-checkout check-rules`). */
  "git_sparse",
  /** git-lfs below 3.8.1: four CVEs own's team mode can meet in others' repositories (decisions LFS-1). */
  "lfs_security",
  /** A ripgrep on PATH older than the one core downloads when there is none. */
  "rg_pinned",
  /** A newer release exists. */
  "newer",
  "not_installed",
  "unreadable",
  /** No ripgrep on PATH: core uses the copy it downloaded (pinned, checked by hash). */
  "own_copy",
]).annotate({ identifier: "Own.ToolUpdates.Why" })
export type Why = typeof Why.Type

/** A version a feature needs (`minimum`: refused below) or works better with (`recommended`), and why. */
export interface Threshold {
  readonly version: string
  readonly level: "minimum" | "recommended"
  readonly why: Why
}

/**
 * Claude Code (02 §8.10). The minimum and the context version are core's (`claude-agent/claude/probe.ts`
 * `MINIMUM_VERSION`, `CONTEXT_DISCOVERY_VERSION`); `sdk` is the Claude Code version in the manifest of the
 * `@anthropic-ai/claude-agent-sdk` core depends on. `test/tool-updates.test.ts` keeps all three equal to their sources.
 */
export const CLAUDE_CODE = { minimum: "2.1.248", context: "2.1.257", sdk: "2.1.301" } as const

/** The git-lfs own uploads to SSH hosts (own-remote `script/native.ts` `GIT_LFS`, kept equal by the same test). */
export const HOST_GIT_LFS = "3.8.1"

/** The ripgrep core downloads when PATH has none (core `ripgrep/binary.ts`, kept equal by the same test). */
export const RIPGREP_PIN = "15.1.0"

/** The github-mcp-server version whose read tools own reviewed (own-accounts `github/reads.ts`). */
export const GITHUB_MCP_REVIEWED = "2.0.3"

/** Each component's thresholds, the strictest first. */
export const THRESHOLDS: Readonly<Record<Component, ReadonlyArray<Threshold>>> = {
  "claude-code": [
    { version: CLAUDE_CODE.minimum, level: "minimum", why: "claude_verbatim" },
    { version: CLAUDE_CODE.context, level: "recommended", why: "claude_context" },
    { version: CLAUDE_CODE.sdk, level: "recommended", why: "claude_sdk" },
  ],
  git: [
    { version: "2.40", level: "minimum", why: "git_team" },
    { version: "2.42", level: "recommended", why: "git_sparse" },
  ],
  "git-lfs": [{ version: HOST_GIT_LFS, level: "recommended", why: "lfs_security" }],
  gh: [],
  ripgrep: [{ version: RIPGREP_PIN, level: "recommended", why: "rg_pinned" }],
  "github-mcp-server": [],
}

/** Where each component's newest release is read: npm's registry metadata or GitHub's latest release, no credentials. */
export const LATEST: Readonly<
  Record<Component, { readonly npm: string } | { readonly github: string }>
> = {
  "claude-code": { npm: "@anthropic-ai/claude-code" },
  git: { github: "git-for-windows/git" },
  "git-lfs": { github: "git-lfs/git-lfs" },
  gh: { github: "cli/cli" },
  ripgrep: { github: "BurntSushi/ripgrep" },
  "github-mcp-server": { github: "github/github-mcp-server" },
}

/** The newest releases are read again after this long (a day); `tools.view {refresh}` reads sooner, see {@link REFRESH_MS}. */
export const CHECK_EVERY_MS = 24 * 60 * 60_000
/** `지금 확인` reads again at most this often, so GitHub's 60 unauthenticated requests an hour are never used up. */
export const REFRESH_MS = 5 * 60_000

/**
 * How an update happens. `run`: own runs `argv` after the confirm card (`command` is what the card shows, `source`
 * the official page the command comes from). `manual`: own runs nothing and the page shows the steps: `elevation`
 * (installed for all users, the installer asks for administrator rights), `bundled` (git-lfs inside Git for Windows:
 * it changes with Git), `interactive` (the official updater asks questions in a console), `no_updater` (the
 * project has no update command), `script` (a `.cmd` launcher: run it in a terminal), `not_installed`.
 */
export const Method = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("run"),
    argv: Schema.Array(Schema.String),
    command: Schema.String,
    source: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("manual"),
    why: Schema.Literals(["elevation", "bundled", "interactive", "no_updater", "script", "not_installed"]),
    command: optional(Schema.String),
    source: Schema.String,
  }),
]).annotate({ identifier: "Own.ToolUpdates.Method" })
export type Method = typeof Method.Type

export interface Item extends Schema.Schema.Type<typeof Item> {}
export const Item = Schema.Struct({
  id: Component,
  /** The program own found; `null` = none. */
  path: Schema.NullOr(Schema.String),
  installed: Schema.NullOr(Schema.String),
  /** The newest release as last read; `null` = not read (checks off, failed, or not yet). */
  latest: Schema.NullOr(Schema.String),
  /** The strictest threshold this version misses decides `status`/`why` (see {@link status}). */
  minimum: optional(Schema.String),
  recommended: optional(Schema.String),
  status: Status,
  why: optional(Why),
  /** The version `why` is about: the missed threshold's, or own's ripgrep pin for `own_copy`. */
  threshold: optional(Schema.String),
  update: Method,
  /** github-mcp-server: the version whose read tools own reviewed (another version is judged by its hints). */
  reviewed: optional(Schema.String),
}).annotate({ identifier: "Own.ToolUpdates.Item" })

/** A local model server of a `compat` account on this PC (loopback only): its version is shown, never updated. */
export const Server = Schema.Struct({
  label: Schema.String,
  url: Schema.String,
  /** Ollama's `/api/version`; `null` when the server does not say (LM Studio, llama.cpp, vLLM) or does not answer. */
  version: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Own.ToolUpdates.Server" })
export type Server = typeof Server.Type

/**
 * The download Claude Code's native updater is writing: the release it fetches and the size of its
 * `<version>.tmp.<pid>.<ms>.<n>` file in `~/.local/share/claude/versions` so far (read once a second, never written).
 * The updater prints nothing while it downloads (UCP 2026-11-08: 2.1.282 → 2.1.319, about 345 MB, three minutes).
 */
export const Download = Schema.Struct({
  version: Schema.String,
  bytes: NonNegativeInt,
}).annotate({ identifier: "Own.ToolUpdates.Download" })
export type Download = typeof Download.Type

/** An update own ran: its command, the output so far from `from`, and the version read again after it ended. */
export const Job = Schema.Struct({
  id: Schema.String,
  component: Component,
  command: Schema.String,
  /**
   * `blocked`: Windows refused to start the program (Smart App Control, an antivirus): nothing ran. A `running` job
   * with an `exitCode` has exited and its version is being read again.
   */
  state: Schema.Literals(["running", "done", "failed", "blocked"]),
  startedAt: EpochMillis,
  endedAt: optional(EpochMillis),
  /** Milliseconds from the start to now, or to the end once it ended (the service's clock). */
  elapsed: NonNegativeInt,
  /** Absent until such a file appears, and for an install without that folder (npm): the page shows the time only. */
  download: optional(Download),
  /** own stopped it after {@link TIMEOUT_MS}; it ends `failed`. */
  timedOut: optional(Schema.Literal(true)),
  exitCode: Schema.NullOr(Schema.Int),
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
  /** The output from `from` on (stdout and stderr as they came, at most {@link OUTPUT_MAX} characters kept). */
  output: Schema.String,
  from: NonNegativeInt,
  /** The output's length so far: the next `tools.update.status` asks `from` this. */
  length: NonNegativeInt,
}).annotate({ identifier: "Own.ToolUpdates.Job" })
export type Job = typeof Job.Type

/** At most this much of an update's output is kept; older output is dropped from the front. */
export const OUTPUT_MAX = 200_000

/** After this long the card says the update is slow and how to tell a download still moves (it is never stopped). */
export const SLOW_MS = 10 * 60_000
/**
 * own stops an update that runs this long and says so (`timedOut`). A slow line still finishes: the 345 MB download
 * of 2.1.319 needs under 12 minutes at 0.5 MB/s.
 */
export const TIMEOUT_MS = 60 * 60_000

export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  /** Whether the newest releases are read (`새 버전 확인`). */
  checkLatest: Schema.Boolean,
  /** When they were last read, answered or not. */
  checkedAt: optional(EpochMillis),
  /** Components whose newest release the last read could not get. */
  failed: Schema.Array(Component),
  items: Schema.Array(Item),
  servers: Schema.Array(Server),
  /** The git-lfs own's SSH-host bundle carries ({@link HOST_GIT_LFS}). */
  hostGitLfs: Schema.String,
  /** The newest update of this service run, when there is one. */
  job: optional(Job),
}).annotate({ identifier: "Own.ToolUpdates.View" })

/** `tool-updates.json` in OWN_HOME: the switch and the newest releases as last read. */
export const File = Schema.Struct({
  version: Schema.Literal(1),
  checkLatest: Schema.Boolean,
  checkedAt: optional(EpochMillis),
  /** Components whose newest release that read could not get. */
  failed: optional(Schema.Array(Schema.String)),
  latest: Schema.Record(Schema.String, Schema.Struct({ version: Schema.String, at: EpochMillis })),
}).annotate({ identifier: "Own.ToolUpdates.File" })
export type File = typeof File.Type

export const defaults: File = { version: 1, checkLatest: true, latest: {} }

export const ViewInput = Schema.Struct({
  /** Reads the installed versions again, and the newest releases when the last read is {@link REFRESH_MS} old. */
  refresh: optional(Schema.Boolean),
})
export const SettingsInput = Schema.Struct({ checkLatest: Schema.Boolean })
export const PlanInput = Schema.Struct({ component: Component })
export const StatusInput = Schema.Struct({ id: Schema.String, from: optional(NonNegativeInt) })

/** The confirm card: exactly what runs and where the command comes from. */
export const Plan = Schema.Struct({
  component: Component,
  command: Schema.String,
  argv: Schema.Array(Schema.String),
  source: Schema.String,
  installed: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(Schema.String),
})

// ---------------------------------------------------------------------------------------------------------------
// Versions

/** A parsed version: its numbers (`2.55.0.windows.3` → 2, 55, 0, 3) and a pre-release tag (`-rc.1`). */
export interface Version {
  readonly parts: ReadonlyArray<number>
  readonly pre?: string
  readonly text: string
}

/**
 * The version in a program's `--version` line or a release tag: `2.1.282 (Claude Code)`, `git version
 * 2.55.0.windows.3`, `git-lfs/3.7.1 (GitHub; …)`, `gh version 2.101.0 (2026-09-15)`, `ripgrep 15.1.0 (rev …)`,
 * `v2.55.0.windows.1`, `github-mcp-server 2.0.3`. The first dotted number wins; Git for Windows' `.windows.N` is a
 * fourth number.
 */
export function parse(text: string): Version | undefined {
  const match = /(\d+(?:\.\d+)+)(?:\.windows\.(\d+))?(-[0-9A-Za-z.-]+)?/.exec(text)
  if (!match) return undefined
  const parts = [...match[1]!.split(".").map(Number), ...(match[2] === undefined ? [] : [Number(match[2])])]
  const pre = match[3]?.slice(1)
  return { parts, ...(pre ? { pre } : {}), text: match[0] }
}

/** Negative when `a` is older, positive when newer, 0 when equal. Missing numbers count as 0; a pre-release is older. */
export function compare(a: Version, b: Version): number {
  const length = Math.max(a.parts.length, b.parts.length)
  const diff = Array.from({ length }, (_, index) => (a.parts[index] ?? 0) - (b.parts[index] ?? 0)).find(
    (value) => value !== 0,
  )
  if (diff !== undefined) return diff
  if (a.pre === b.pre) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre < b.pre ? -1 : 1
}

/** `a` is older than `b`; `false` when either does not parse. */
export function older(a: string, b: string) {
  const left = parse(a)
  const right = parse(b)
  return left !== undefined && right !== undefined && compare(left, right) < 0
}

/**
 * The status rules (05 §20.3): no program → `missing`; an unreadable version → `unknown`; below a `minimum` →
 * `required`; below a `recommended` → `recommended` with the strictest such reason; older than the newest release →
 * `recommended` (`newer`); otherwise `current`.
 */
export function status(input: {
  readonly found: boolean
  readonly installed: string | null
  readonly latest: string | null
  readonly thresholds: ReadonlyArray<Threshold>
}): { readonly status: Status; readonly why?: Why } {
  if (!input.found) return { status: "missing", why: "not_installed" }
  const installed = input.installed === null ? undefined : parse(input.installed)
  if (!installed) return { status: "unknown", why: "unreadable" }
  const missed = input.thresholds.find((threshold) => {
    const version = parse(threshold.version)
    return version !== undefined && compare(installed, version) < 0
  })
  if (missed) return { status: missed.level === "minimum" ? "required" : "recommended", why: missed.why }
  const latest = input.latest === null ? undefined : parse(input.latest)
  if (latest && compare(installed, latest) < 0) return { status: "recommended", why: "newer" }
  return { status: "current" }
}
