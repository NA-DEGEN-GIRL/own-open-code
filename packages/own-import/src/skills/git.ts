export * as SkillGit from "./git.js"

import { OwnImport } from "@own/protocol/rpc-import"
import { ServiceTarget } from "@own/runtime"

/**
 * `git` for `URL로 설치` (09 §9.5), only on the user's request: a blob-less, depth-1 clone (`--filter=blob:none
 * --no-checkout`) gives the commit and the tree without file content; `checkout <commit> -- <paths>` then fetches just
 * the named files (the manifests for the preview, the chosen skills for the install). Every run is an argument array
 * without a shell, with a hidden window and a timeout; credential helpers and prompts are off (a private repository
 * fails instead of asking), LFS smudging is skipped, symlinks are checked out as plain files, and Git for Windows' file
 * system cache, line-end conversion and background maintenance are off.
 */

/** The repository to read, normalized from the user's input. */
export interface Repo {
  readonly url: string
  readonly ref?: string
  readonly folder?: string
}

/**
 * `https:` URLs (`http:` only to a loopback host) without user info; `owner/repo` means GitHub. A GitHub
 * `/tree/<ref>/<folder>` or `/blob/<ref>/<file>` link gives the ref and the folder (the file's folder); the input's own
 * `ref` and `folder` win. A query or fragment is dropped. `undefined` when it is none of these (`url_invalid`).
 */
export function parseRepo(input: OwnImport.SkillRepo): Repo | undefined {
  const text = input.url.trim()
  const parsed = URL.parse(/^[\w.-]+\/[\w.-]+$/.test(text) ? `https://github.com/${text}` : text)
  if (parsed === null || parsed.username !== "" || parsed.password !== "") return undefined
  const loopback = parsed.hostname === "localhost" || ServiceTarget.isLoopback(parsed.hostname)
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback))) return undefined
  const segments = parsed.pathname.split("/").filter((part) => part !== "")
  const github = parsed.hostname.toLowerCase() === "github.com" && segments.length >= 2
  const link = github && (segments[2] === "tree" || segments[2] === "blob") && segments.length >= 4
  const linked = link ? segments.slice(4) : []
  const folderOfLink = segments[2] === "blob" ? linked.slice(0, -1) : linked
  const url = github
    ? `https://github.com/${segments[0]}/${segments[1].replace(/\.git$/i, "")}.git`
    : `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`
  const ref = input.ref ?? (link ? segments[3] : undefined)
  const folder = input.folder ?? (folderOfLink.length > 0 ? folderOfLink.join("/") : undefined)
  if (ref !== undefined && !validRef(ref)) return undefined
  const cleaned = folder === undefined ? undefined : cleanFolder(folder)
  if (cleaned === null) return undefined
  return { url, ...(ref === undefined ? {} : { ref }), ...(cleaned === undefined ? {} : { folder: cleaned }) }
}

/** A branch or tag name git accepts and no option or path trick: no `..`, no leading `-`, no spaces or control. */
function validRef(ref: string) {
  return (
    /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..") && !/(^|\/)\.|\.lock$|\/$/.test(ref)
  )
}

/** A `/`-separated folder of the repository; `undefined` for the root, `null` when it leaves the repository. */
function cleanFolder(folder: string) {
  const decoded = decode(folder)
  if (decoded === undefined) return null
  const parts = decoded.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.some((part) => part === ".." || part.includes("\\") || part.includes("\0"))) return null
  return parts.length === 0 ? undefined : parts.join("/")
}

/** `decodeURIComponent`, `undefined` for a malformed escape. */
function decode(text: string) {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Running git

export type Failure = OwnImport.FetchProblem

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: Failure }

export interface Output {
  readonly code: number
  readonly stdout: Uint8Array
  readonly stderr: string
}

/** Runs `git <args>`; tests replace it to count runs. `undefined` when git could not be started. */
export type Runner = (
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string
    readonly stdin?: string
    readonly timeout: number
    /** Allows plain `http:` (a loopback repository, {@link parseRepo}); otherwise only `https:`. */
    readonly http?: boolean
  },
) => Promise<Output | undefined>

/** The settings every run gets ahead of its arguments (09 §9.5). */
const SETTINGS = [
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
  "-c",
  "core.symlinks=false",
  // Git for Windows turns the file system cache on system-wide; it keeps the object folder's listing from before the
  // checkout's lazy fetch, so the fetched blobs are not seen ("unable to read sha1 file").
  "-c",
  "core.fscache=false",
  // The repository's bytes, not CRLF copies (Git for Windows sets autocrlf system-wide): a skill's scripts also go to
  // Linux hosts (04 §13).
  "-c",
  "core.autocrlf=false",
  // No background maintenance in a temp clone that is removed right after.
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "core.longpaths=true",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "--literal-pathspecs",
]

export const CLONE_MS = 120_000
export const RUN_MS = 60_000

export const run: Runner = async (args, options) => {
  // Starting git is the one step that can throw (no git on PATH); everything after is a result.
  const spawned = (() => {
    try {
      const http = options.http === true ? ["-c", "protocol.http.allow=always"] : []
      return Bun.spawn(["git", ...SETTINGS, ...http, ...args], {
        cwd: options.cwd,
        stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        timeout: options.timeout,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      })
    } catch {
      return undefined
    }
  })()
  if (spawned === undefined) return undefined
  const [stdout, stderr, code] = await Promise.all([
    new Response(spawned.stdout).bytes(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ])
  return { code: spawned.signalCode === null ? code : -1, stdout, stderr }
}

/** Why a failed run failed, from git's message (English; the service runs git without a locale override). */
function reason(output: Output | undefined): Failure {
  if (output === undefined) return "git_missing"
  if (output.code === -1) return "timeout"
  const text = output.stderr.toLowerCase()
  if (/could not resolve host|failed to connect|connection refused|couldn't connect|timed out|network/.test(text))
    return "unreachable"
  if (
    /not found|does not exist|could not read username|authentication failed|remote branch .* not found|couldn't find remote ref|invalid refspec|403|401/.test(
      text,
    )
  )
    return "not_found"
  return "other"
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/**
 * A blob-less, depth-1 clone of `repo` (its ref, else the default branch) into the empty folder `into`, and its commit.
 * A server that ignores the filter would have sent every file, so that is `no_partial_clone` (the caller removes it).
 */
export async function clone(git: Runner, repo: Repo, into: string): Promise<Result<string>> {
  const cloned = await git(
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      ...(repo.ref === undefined ? [] : ["--branch", repo.ref]),
      "--",
      repo.url,
      into,
    ],
    { timeout: CLONE_MS, http: plain(repo) },
  )
  if (cloned === undefined || cloned.code !== 0) return { ok: false, reason: reason(cloned) }
  if (/filtering not recognized by server/i.test(cloned.stderr)) return { ok: false, reason: "no_partial_clone" }
  const head = await git(["rev-parse", "HEAD"], { cwd: into, timeout: RUN_MS })
  if (head === undefined || head.code !== 0) return { ok: false, reason: reason(head) }
  return { ok: true, value: text(head.stdout).trim() }
}

export interface Entry {
  /** `100644`, `100755`, `120000` (a link), `160000` (a submodule). */
  readonly mode: string
  readonly type: "blob" | "tree" | "commit"
  /** `/`-separated, from the repository root. */
  readonly path: string
}

/** Past this many entries a repository's tree is `too_large` for a preview. */
export const MAX_TREE = 100_000

/** Every file of `commit`'s tree (names and modes only: nothing is downloaded). */
export async function tree(git: Runner, folder: string, commit: string): Promise<Result<ReadonlyArray<Entry>>> {
  const listed = await git(["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: folder, timeout: RUN_MS })
  if (listed === undefined || listed.code !== 0) return { ok: false, reason: reason(listed) }
  const entries = text(listed.stdout)
    .split("\0")
    .filter((line) => line !== "")
    .flatMap((line): Entry[] => {
      const match = /^(\d{6}) (blob|tree|commit) [0-9a-f]+\t(.+)$/s.exec(line)
      if (match === null) return []
      // SAFETY: the regex accepts only these three types.
      return [{ mode: match[1], type: match[2] as Entry["type"], path: match[3] }]
    })
  if (entries.length > MAX_TREE) return { ok: false, reason: "too_large" }
  return { ok: true, value: entries }
}

/** Downloads and writes just `paths` at `commit` into the clone's working folder (one batch fetch). */
export async function checkout(
  git: Runner,
  repo: Repo,
  folder: string,
  commit: string,
  paths: ReadonlyArray<string>,
): Promise<Result<void>> {
  if (paths.length === 0) return { ok: true, value: undefined }
  const done = await git(["checkout", commit, "--pathspec-from-file=-", "--pathspec-file-nul"], {
    cwd: folder,
    stdin: `${paths.join("\0")}\0`,
    timeout: CLONE_MS,
    http: plain(repo),
  })
  if (done === undefined || done.code !== 0) return { ok: false, reason: reason(done) }
  return { ok: true, value: undefined }
}

/** The commit `ref` (else the default branch) points at now, without cloning (`업데이트 확인`). */
export async function remoteCommit(git: Runner, repo: Repo): Promise<Result<string>> {
  const listed = await git(["ls-remote", "--", repo.url, repo.ref ?? "HEAD"], { timeout: RUN_MS, http: plain(repo) })
  if (listed === undefined || listed.code !== 0) return { ok: false, reason: reason(listed) }
  const lines = text(listed.stdout)
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length === 2)
  const wanted =
    repo.ref === undefined ? ["HEAD"] : [`refs/heads/${repo.ref}`, `refs/tags/${repo.ref}^{}`, `refs/tags/${repo.ref}`]
  const found = wanted.flatMap((name) => lines.filter((parts) => parts[1].trim() === name)).at(0)
  return found === undefined ? { ok: false, reason: "not_found" } : { ok: true, value: found[0].trim() }
}

/** A loopback `http:` repository ({@link parseRepo} allows no other). */
function plain(repo: Repo) {
  return repo.url.startsWith("http:")
}
