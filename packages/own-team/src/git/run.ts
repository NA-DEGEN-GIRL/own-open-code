export * as Git from "./run.js"

import path from "node:path"

/**
 * The one way own.team runs git (06 §4.3). `Bun.spawn` with an argument array, never a shell: Git Bash would turn a
 * cone path starting with `/` into `C:/Program Files/Git/…` and break `file://` URLs (MSYS path conversion). Every
 * call starts with {@link CONFIG}; folder lists go through `--stdin` ({@link lines}) so a name starting with `-` is
 * never read as an option.
 *
 * In a remote service (06 §4.13) the process also has a tools folder ({@link useTools}): the bundled git-lfs, first on
 * the `PATH` of every call, so `git lfs fetch`, `git lfs push` and a pre-push hook find it before the service restart
 * that gives it to the shells (04 §6.4); and `worktree add` waits for the repository's LFS filter ({@link LFS_FILTER}).
 */

/** Prefixed to every call (06 §4.3). */
export const CONFIG = ["-c", "core.quotepath=false", "-c", "advice.sparseIndexExpanded=false"] as const

/** 06 §4.3: queries get 30 seconds, write steps 10 minutes. */
export const READ_TIMEOUT_MS = 30_000
export const WRITE_TIMEOUT_MS = 600_000

export interface Options {
  /** `git -C <cwd>`; a native absolute path. Omitted only by commands that need no repository (`git version`). */
  readonly cwd?: string
  /**
   * A step that changes refs, the index, configuration or files: 10 minutes and optional locks allowed. Queries
   * (the default) get 30 seconds and `GIT_OPTIONAL_LOCKS=0`, so a `status` never rewrites the index.
   */
  readonly write?: boolean
  /**
   * A call about one worktree: `GIT_CEILING_DIRECTORIES=<parent of cwd>`. Without its `.git` file, `git -C <dir>`
   * would quietly open the repository around the folder, such as the home a nested area sits in (06 §4.3, [R-review] e3).
   */
  readonly worktree?: boolean
  /** Written to stdin; see {@link lines}. Without it stdin is closed. */
  readonly stdin?: string
  /** Applied last (for example `GIT_INDEX_FILE` of a hold ref, 06 §8.7). */
  readonly env?: Readonly<Record<string, string>>
  /** Overrides the 30 second or 10 minute default. */
  readonly timeout?: number
  readonly signal?: AbortSignal
  /** git's process id once spawned (a GitHub login's holder, 16 §8.6). */
  readonly onSpawn?: (pid: number) => void
}

export type Result<T = string> =
  | { readonly ok: true; readonly stdout: T; readonly stderr: string }
  | {
      readonly ok: false
      /**
       * `exit`: git failed; `timeout`: killed after the time limit; `aborted`: killed by the caller's signal;
       * `refused`: never started (bad path or OID, or a worktree of an LFS repository before its filter, {@link
       * LFS_FILTER}).
       */
      readonly reason: "exit" | "timeout" | "aborted" | "refused"
      readonly code: number | null
      readonly stdout: string
      readonly stderr: string
      readonly message: string
    }

export function run(args: readonly string[], options: Options = {}): Promise<Result> {
  return spawn(args, options, (stdout) => new Response(stdout).text())
}

/** Like {@link run}, with stdout as bytes (`cat-file --batch`). */
export function bytes(args: readonly string[], options: Options = {}): Promise<Result<Uint8Array>> {
  return spawn(args, options, async (stdout) => new Uint8Array(await new Response(stdout).arrayBuffer()))
}

/** `--stdin` input: one entry per line, each terminated (git reads the last line only when it ends). */
export function lines(entries: readonly string[]) {
  return entries.map((entry) => `${entry}\n`).join("")
}

/** `-z --stdin` input. */
export function nul(entries: readonly string[]) {
  return entries.map((entry) => `${entry}\0`).join("")
}

/** A full object name: SHA-1 (40) or SHA-256 (64) lowercase hex. */
export function isOid(value: string) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

/**
 * A native absolute path: `X:\…` or `X:/…` on Windows (Git Bash's `/d/…` and UNC paths are refused), `/…` elsewhere.
 * own never sends any other spelling to git (06 §4.3).
 */
export function isNative(value: string) {
  if (WINDOWS) return /^[A-Za-z]:[\\/]/.test(value)
  return value.startsWith("/")
}

/**
 * The tools folder of a remote service (06 §4.13: `<OWN_HOME>/tools/git-lfs/current`, `remote/env.ts`), or
 * `undefined` on this PC.
 */
export function tools() {
  return TOOLS.at(-1)?.dir
}

/**
 * Sets {@link tools} for every git call of this process (each plugin instance of a remote service does, all with the
 * same folder); returns the function that takes this setting off again.
 */
export function useTools(dir: string) {
  const entry = { dir }
  TOOLS.push(entry)
  return () => {
    const index = TOOLS.indexOf(entry)
    if (index >= 0) TOOLS.splice(index, 1)
  }
}

/**
 * Why a `worktree add` is refused in a remote service while the repository uses Git LFS and no `filter.lfs.process`
 * is configured: its checkout would leave pointer files, and a `git add -A` in that folder would commit the binaries
 * in their place ([R-review] e9). The `lfs-remote` step configures the filter first (06 §3.6, §4.13).
 */
export const LFS_FILTER = "저장소가 큰 파일 도구를 쓰는데 이 원격 호스트에는 아직 설정되지 않았어요"

/** The environment of one call; exported so its rules are tested as written. */
export function environment(
  options: Pick<Options, "cwd" | "write" | "worktree" | "env">,
): Record<string, string | undefined> {
  // A GIT_DIR or GIT_WORK_TREE inherited from a hook would override discovery and the ceiling below.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED.has(key.toUpperCase())))
  return {
    ...inherited,
    ...toolsFirst(inherited),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    ...(options.write ? {} : { GIT_OPTIONAL_LOCKS: "0" }),
    ...(options.worktree && options.cwd ? { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(options.cwd)) } : {}),
    ...options.env,
  }
}

/** Why a call is refused before it starts, or `undefined`. */
export function refusal(args: readonly string[], options: Pick<Options, "cwd" | "stdin">) {
  if (options.cwd !== undefined && !isNative(options.cwd)) return `이 PC의 절대 경로가 아니에요: ${options.cwd}`
  const at = subcommand(args)
  if (args[at] !== "update-ref") return undefined
  return updateRefRefusal(args.slice(at + 1), options.stdin)
}

const WINDOWS = process.platform === "win32"

/** The remote tools folders in use, newest last ({@link useTools}). */
const TOOLS: Array<{ readonly dir: string }> = []

/** Variables that pick another repository, index or worktree than the `-C` folder. */
const INHERITED = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
])

async function spawn<T>(
  args: readonly string[],
  options: Options,
  read: (stdout: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<Result<T>> {
  const refused = refusal(args, options) ?? (await lfsRefusal(args, options))
  if (refused !== undefined)
    return { ok: false, reason: "refused", code: null, stdout: "", stderr: "", message: refused }
  const timer = AbortSignal.timeout(options.timeout ?? (options.write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS))
  const proc = Bun.spawn(["git", ...CONFIG, ...(options.cwd === undefined ? [] : ["-C", options.cwd]), ...args], {
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    signal: options.signal ? AbortSignal.any([options.signal, timer]) : timer,
    env: environment(options),
  })
  options.onSpawn?.(proc.pid)
  // Read both pipes while git runs (a full pipe would block it); `catch` because they are abandoned after a kill.
  const output = read(proc.stdout).catch(() => undefined)
  const errors = new Response(proc.stderr).text().catch(() => "")
  const code = await proc.exited
  // A killed git's children (a shell alias, git-lfs) can hold the pipes open; do not wait for them.
  if (timer.aborted)
    return {
      ok: false,
      reason: "timeout",
      code,
      stdout: "",
      stderr: "",
      message: `git ${args[0]} 명령이 시간 안에 끝나지 않았어요`,
    }
  if (options.signal?.aborted)
    return { ok: false, reason: "aborted", code, stdout: "", stderr: "", message: `git ${args[0]} 명령을 멈췄어요` }
  const [stdout, stderr] = await Promise.all([output, errors])
  if (code === 0 && stdout !== undefined) return { ok: true, stdout, stderr }
  const text = typeof stdout === "string" ? stdout : ""
  return {
    ok: false,
    reason: "exit",
    code,
    stdout: text,
    stderr,
    message: stderr.trim() || `git ${args[0]} 명령이 오류로 끝났어요(종료 코드 ${code})`,
  }
}

/** The subcommand's index: the first argument that is neither an option nor the value of `-c`/`-C`. */
function subcommand(args: readonly string[]) {
  return args.findIndex((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c" && args[index - 1] !== "-C")
}

/** `PATH` (`Path` on Windows) with {@link tools} first; nothing on this PC. */
function toolsFirst(env: Readonly<Record<string, string | undefined>>) {
  const dir = tools()
  if (dir === undefined) return {}
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
  const rest = env[key]
  return { [key]: rest ? `${dir}${path.delimiter}${rest}` : dir }
}

/**
 * {@link LFS_FILTER} in a remote service: a `worktree add` while no `filter.lfs.process` is configured and the
 * repository has LFS files. Whatever cannot be read refuses (fails closed). The filter is read first, so a configured
 * repository costs one `git config`.
 */
async function lfsRefusal(args: readonly string[], options: Pick<Options, "cwd" | "worktree" | "signal">) {
  if (tools() === undefined || options.cwd === undefined) return undefined
  const at = subcommand(args)
  if (args[at] !== "worktree" || args[at + 1] !== "add") return undefined
  const query = { cwd: options.cwd, worktree: options.worktree, signal: options.signal }
  const filter = await run(["config", "--get", "filter.lfs.process"], query)
  if (filter.ok && filter.stdout.trim() !== "") return undefined
  const used = await run(["ls-files", "-z", "--", ":(attr:filter=lfs)"], query)
  if (!used.ok) return `저장소가 큰 파일 도구를 쓰는지 알 수 없어요: ${used.message}`
  return used.stdout === "" ? undefined : LFS_FILTER
}

/**
 * 06 §4.3: every OID given to `update-ref` is a full hex name. An empty variable once turned
 * `update-ref <ref> $c $base` into "set <ref> to base" ([R-lazy]). Covers the argument form and `--stdin` lines.
 */
function updateRefRefusal(rest: readonly string[], stdin: string | undefined) {
  if (rest.includes("--stdin")) {
    if (rest.includes("-z")) return "update-ref -z는 쓰지 않아요"
    const bad = (stdin ?? "")
      .split("\n")
      .filter(Boolean)
      .find((line) => !stdinLineValid(line))
    return bad === undefined ? undefined : `update-ref --stdin에 맞지 않는 줄이 있어요: ${bad}`
  }
  const parsed = rest.reduce(
    (state, arg) => {
      if (state.skip) return { ...state, skip: false }
      if (arg === "-m") return { ...state, skip: true }
      if (arg === "-d") return { ...state, remove: true }
      if (arg.startsWith("-")) return state
      return { ...state, positional: [...state.positional, arg] }
    },
    { skip: false, remove: false, positional: [] as string[] },
  )
  const oids = parsed.positional.slice(1)
  const expected = parsed.remove ? oids.length <= 1 : oids.length >= 1 && oids.length <= 2
  if (!expected || parsed.positional.length === 0) return "update-ref에 맞지 않는 인자가 있어요"
  const bad = oids.find((oid) => !isOid(oid))
  return bad === undefined ? undefined : `update-ref에 저장 지점의 전체 이름이 아닌 값이 있어요: "${bad}"`
}

/** `create <ref> <new>`, `update <ref> <new> [<old>]`, `delete|verify <ref> [<old>]`, and the transaction verbs. */
function stdinLineValid(line: string) {
  const [verb, ...fields] = line.split(" ")
  if (["start", "prepare", "commit", "abort"].includes(verb ?? "")) return fields.length === 0
  if (verb === "option") return fields.length === 1
  const counts: Record<string, readonly [number, number]> = {
    create: [2, 2],
    update: [2, 3],
    delete: [1, 2],
    verify: [1, 2],
  }
  const range = counts[verb ?? ""]
  if (!range || fields.length < range[0] || fields.length > range[1]) return false
  return fields.slice(1).every(isOid)
}
