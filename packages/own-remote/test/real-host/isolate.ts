/**
 * Isolation of the real-host gates from the host account's real own install (decisions RL35). The 2.4.1-own.6 chain's
 * opening cleanup stopped the user's real host service and removed `~/.local/share/own-open-code`, `~/.config/opencode`
 * and the rest of a real app install: the gates installed into, and cleaned up, the same paths. Now:
 *
 *   - every phase installs, runs and writes only under the run's test root (env.ts `ensureHostRun`, own-remote's
 *     `remoteTest` option);
 *   - {@link phase} wraps each phase's suite in a guard: a read-only fingerprint of the real install's paths
 *     ({@link USER_PATHS}) and of the account's own/opencode processes before the phase and after it, and the phase
 *     fails loudly when the user's side changed;
 *   - z-cleanup removes only roots the runs recorded ({@link cleanupTargets}), checks every one on the host before it
 *     removes anything ({@link PRECHECK_SCRIPT}), and stops only processes whose executable lies inside such a root.
 */
import { afterAll, beforeAll, describe } from "bun:test"
import {
  TEST_BASE,
  assertRunShape,
  enabled,
  evidence,
  hostSh,
  prepareSshFiles,
  readHostRun,
  type HostRun,
} from "./env.js"

/**
 * A real install's paths on the host account, relative to HOME (04 §5.3 and the app's defaults): never stopped, written
 * or removed by a phase. `/tmp/own-<uid>` (a real install's short socket directory, 04 §7.4) is fingerprinted too.
 */
export const USER_PATHS = [
  ".local/share/own-open-code",
  ".config/own-open-code",
  ".local/state/own-open-code",
  ".local/share/opencode",
  ".local/state/opencode",
  ".config/opencode",
  ".cache/opencode",
  "own-chats",
  ".own-r",
  ".gitconfig",
] as const

/**
 * Read-only: per user path its state (`ABSENT`, `LINK <target>` or `TREE <sha256 of every entry's path, type, size and
 * mtime> <entries>` with one `TOP <hash>` per direct child, names hashed so none leaves the host), then every process of
 * the account that is not this run's (`PROC <pid> <start ticks> <0|1 own/opencode in its exe or arguments> <exe>`;
 * arguments never leave the host). This run's processes are those whose executable or working directory lies in the
 * run's root, whose environment carries the root (everything the remote service and the phases' scripts start) or
 * whose arguments name it. Without a run (the opening z-cleanup) every process of the account is listed.
 */
export function fingerprintScript(run: HostRun | undefined) {
  return String.raw`set -u
root='${run ? assertRunShape(run).root : ""}'
me=$(id -u)
echo "== host"; echo "$(id -un)@$(hostname)"
for p in ${USER_PATHS.map((entry) => `"$HOME/${entry}"`).join(" ")} "/tmp/own-$me"; do
  echo "== path $p"
  if [ -L "$p" ]; then echo "LINK $(readlink "$p")"
  elif [ -e "$p" ]; then
    echo "TREE $(find "$p" -printf '%P\t%y\t%s\t%T@\n' 2>/dev/null | LC_ALL=C sort | sha256sum | cut -c1-64) $(find "$p" 2>/dev/null | wc -l)"
    if [ -d "$p" ]; then ls -A1 "$p" 2>/dev/null | LC_ALL=C sort | while IFS= read -r n; do echo "TOP $(printf '%s' "$n" | sha256sum | cut -c1-16)"; done; fi
  else echo ABSENT; fi
done
echo "== processes"
for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  [ "$pid" = "$$" ] && continue
  [ "$(stat -c %u "$d" 2>/dev/null)" = "$me" ] || continue
  exe=$(readlink "$d/exe" 2>/dev/null) || continue
  if [ -n "$root" ]; then
    case "$exe" in "$root"/*) continue ;; esac
    tr '\0' '\n' < "$d/environ" 2>/dev/null | grep -qxF "XDG_STATE_HOME=$root/state" && continue
    # A process started with a cleared environment (env -i) that names the root in its arguments is the run's too.
    tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -qF "$root/" && continue
    case "$(readlink "$d/cwd" 2>/dev/null)" in "$root" | "$root"/*) continue ;; esac
  fi
  start=$(sed 's/.*) //' "$d/stat" 2>/dev/null | cut -d ' ' -f 20)
  [ -n "$start" ] || continue
  own=0; { printf '%s ' "$exe"; tr '\0' ' ' < "$d/cmdline" 2>/dev/null; } | grep -qiE 'own-open-code|opencode' && own=1
  echo "PROC $pid $start $own $exe"
done
echo "== end"
`.replaceAll("\\${", "${")
}

export interface PathState {
  readonly state: "absent" | "link" | "tree"
  readonly detail: string
  readonly top: ReadonlyArray<string>
}

export interface Process {
  readonly pid: number
  readonly start: string
  /** own/opencode in its executable or arguments: a real install's service, its tools, an app connection. */
  readonly own: boolean
  readonly exe: string
}

export interface Fingerprint {
  readonly host: string
  readonly paths: Readonly<Record<string, PathState>>
  readonly processes: ReadonlyArray<Process>
}

export function parseFingerprint(output: string): Fingerprint {
  const lines = output.split(/\r?\n/)
  if (!lines.includes("== end")) throw new Error("the fingerprint did not run to its end")
  const paths: Record<string, { state: PathState["state"]; detail: string; top: string[] }> = {}
  const processes: Process[] = []
  let host = ""
  let current: string | undefined
  let mode: "host" | "path" | "processes" | undefined
  for (const line of lines) {
    if (line === "== host") mode = "host"
    else if (line.startsWith("== path ")) {
      mode = "path"
      current = line.slice("== path ".length)
      paths[current] = { state: "absent", detail: "", top: [] }
    } else if (line === "== processes") mode = "processes"
    else if (line === "== end") mode = undefined
    else if (mode === "host" && line) host = line
    else if (mode === "path" && current !== undefined) {
      const entry = paths[current]!
      if (line === "ABSENT") entry.state = "absent"
      if (line.startsWith("LINK ")) Object.assign(entry, { state: "link", detail: line.slice(5) })
      if (line.startsWith("TREE ")) Object.assign(entry, { state: "tree", detail: line.slice(5) })
      if (line.startsWith("TOP ")) entry.top.push(line.slice(4))
    } else if (mode === "processes") {
      const match = /^PROC (\d+) (\d+) ([01]) (.*)$/.exec(line)
      if (match) processes.push({ pid: Number(match[1]), start: match[2]!, own: match[3] === "1", exe: match[4]! })
    }
  }
  return { host, paths, processes }
}

export interface GuardResult {
  /** Changes that fail the phase. */
  readonly problems: ReadonlyArray<string>
  /** Changes reported only (a real service of the user ran, so its own files may change). */
  readonly notes: ReadonlyArray<string>
  /** A real own/opencode process of the user ran before or after the phase. */
  readonly userService: boolean
}

/**
 * Compares two fingerprints. Always a problem: another host, a path missing or added at the top, a direct child of a
 * user path gone, or a user own/opencode process gone or replaced. A path whose contents changed is a problem too unless
 * a user own/opencode process ran before or after the phase (the user's real service writes its own files): then it is
 * a note. New user processes (the user connecting meanwhile) are notes.
 */
export function compareFingerprints(before: Fingerprint, after: Fingerprint): GuardResult {
  const problems: string[] = []
  const notes: string[] = []
  if (before.host !== after.host) problems.push(`the host changed: ${before.host} → ${after.host}`)
  const userService = [...before.processes, ...after.processes].some((process) => process.own)
  for (const [name, was] of Object.entries(before.paths)) {
    const now = after.paths[name]
    if (!now) {
      problems.push(`${name}: not in the second fingerprint`)
      continue
    }
    if (was.state !== now.state) {
      problems.push(`${name}: ${was.state} → ${now.state}`)
      continue
    }
    const gone = was.top.filter((entry) => !now.top.includes(entry))
    if (gone.length > 0) problems.push(`${name}: ${gone.length} direct entr${gone.length === 1 ? "y" : "ies"} removed`)
    if (was.detail !== now.detail) {
      const text = `${name}: contents changed (${was.detail} → ${now.detail})`
      if (userService) notes.push(text)
      else problems.push(text)
    }
  }
  const key = (process: Process) => `${process.pid}:${process.start}`
  const later = new Set(after.processes.map(key))
  for (const process of before.processes.filter((entry) => entry.own && !later.has(key(entry))))
    problems.push(`user process ${process.pid} (${process.exe}) ended during the phase`)
  const earlier = new Set(before.processes.map(key))
  for (const process of after.processes.filter((entry) => entry.own && !earlier.has(key(entry))))
    notes.push(`user process ${process.pid} (${process.exe}) started during the phase`)
  return { problems, notes, userService }
}

/** The fingerprint of the host now (read-only). */
export async function fingerprint() {
  const result = await hostSh(fingerprintScript(readHostRun()), 300_000)
  if (result.code !== 0)
    throw new Error(`the guard's fingerprint failed (exit ${result.code}): ${result.stderr.trim()}`)
  return parseFingerprint(result.stdout)
}

/**
 * A real-host phase: `body` inside a guard that fingerprints the user's side before the phase and after it (after the
 * phase's own afterAll hooks) and fails when it changed (evidence `guard-<name>.json`). Skipped unless `active` (default:
 * OWN_REAL_HOST names an approved host; phases D, E and G use {@link phaseIf} with `heavyHost`).
 */
export function phase(name: string, title: string, body: () => void, active = enabled) {
  if (!active) return describe.skip(title, body)
  describe(title, () => {
    const state = {} as { before?: Fingerprint }
    beforeAll(async () => {
      prepareSshFiles()
      state.before = await fingerprint()
      evidence(`guard-${name}-before.json`, state.before)
    }, 300_000)
    describe(name, body)
    afterAll(async () => {
      if (!state.before) throw new Error(`the guard of ${name} has no fingerprint from before the phase`)
      const after = await fingerprint()
      const result = compareFingerprints(state.before, after)
      evidence(`guard-${name}.json`, { run: readHostRun()?.runId ?? null, ...result, after })
      if (result.problems.length > 0)
        throw new Error(
          `STOP: the user's real install or processes changed during ${name}: ${result.problems.join("; ")}`,
        )
    }, 300_000)
  })
}

/** {@link phase} active only when `active` holds (phases D, E and G: `heavyHost`). */
export function phaseIf(active: boolean) {
  return (name: string, title: string, body: () => void) => phase(name, title, body, active)
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup scoping.

/**
 * The roots z-cleanup may remove: the recorded runs' roots, each of the shape this suite makes, recorded on this host
 * account. Throws (before anything is removed) for any other path or another host's run.
 */
export function cleanupTargets(runs: ReadonlyArray<HostRun>, host: string, home: string) {
  const seen = new Set<string>()
  return runs.flatMap((run) => {
    assertRunShape(run)
    if (run.host !== host) throw new Error(`run ${run.runId} was made on ${run.host}, not on ${host}`)
    if (run.home !== home) throw new Error(`run ${run.runId} names HOME ${run.home}, not ${home}`)
    if (seen.has(run.root)) return []
    seen.add(run.root)
    return [run]
  })
}

/** Fails unless `candidate` is one of the roots or lies inside one (plain absolute paths only). */
export function requireInRoots(candidate: string, roots: ReadonlyArray<string>) {
  if (!candidate.startsWith("/") || candidate.split("/").some((part) => part === ".." || part === "."))
    throw new Error(`${candidate} is not a plain absolute path`)
  const inside = roots.some((root) => candidate === root || candidate.startsWith(`${root}/`))
  if (!inside) throw new Error(`${candidate} lies outside the run's test root`)
  return candidate
}

/** Read-only: the facts z-cleanup needs about each target before it removes anything. */
export function precheckScript(targets: ReadonlyArray<HostRun>) {
  return [
    "set -u",
    ...targets.map((run) => {
      const root = requireInRoots(assertRunShape(run).root, [run.root])
      return String.raw`r='${root}'
echo "== root $r"
if [ -L "$r" ]; then echo STATE=link; elif [ -d "$r" ]; then echo STATE=dir; elif [ -e "$r" ]; then echo STATE=other; else echo STATE=absent; fi
if [ -d "$r" ] && [ ! -L "$r" ]; then
  [ -O "$r" ] && echo OWNER=ours || echo OWNER=other
  echo "MARKER=$(head -c 64 "$r/.own-realhost-run" 2>/dev/null)"
  echo "PHYS=$(cd "$r" 2>/dev/null && pwd -P)"
fi`
    }),
    "echo == end",
  ].join("\n")
}

/** The targets that exist and pass every check; throws when one exists but does not (nothing is removed then). */
export function checkPrecheck(output: string, targets: ReadonlyArray<HostRun>) {
  const blocks = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("== root ")) blocks.set(line.slice(8), (current = new Map()))
    else if (current && line.includes("="))
      current.set(line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1))
  }
  if (!output.split(/\r?\n/).includes("== end")) throw new Error("the cleanup precheck did not run to its end")
  return targets.filter((run) => {
    const facts = blocks.get(run.root)
    if (!facts) throw new Error(`the cleanup precheck did not report ${run.root}`)
    if (facts.get("STATE") === "absent") return false
    const wrong = [
      facts.get("STATE") !== "dir" && `is a ${facts.get("STATE")}`,
      facts.get("OWNER") !== "ours" && "is not owned by this account",
      facts.get("MARKER") !== run.runId && `has marker ${JSON.stringify(facts.get("MARKER"))}, not ${run.runId}`,
      facts.get("PHYS") !== run.root && `resolves to ${facts.get("PHYS")}`,
    ].filter(Boolean)
    if (wrong.length > 0) throw new Error(`refusing to remove ${run.root}: it ${wrong.join(", ")}`)
    return true
  })
}

/**
 * Removes the checked targets: for each root (checked again on the host) stops only the account's processes whose
 * executable lies inside it, then removes it; afterwards removes `~/own-realhost-test` only when it is empty. Nothing
 * else is named. Run only after {@link checkPrecheck} passed.
 */
export function cleanupScript(targets: ReadonlyArray<HostRun>) {
  return [
    "set -u",
    String.raw`rh_stop() { # <root> <signal>: the account's processes whose executable lies inside the root
  for d in /proc/[0-9]*; do
    e=$(readlink "$d/exe" 2>/dev/null) || continue
    case "$e" in "$1"/*) kill -CONT "\${d#/proc/}" 2>/dev/null; kill "$2" "\${d#/proc/}" 2>/dev/null && echo "STOPPED=\${d#/proc/}" ;; esac
  done
}`,
    ...targets.map((run) => {
      const root = requireInRoots(assertRunShape(run).root, [run.root])
      return String.raw`r='${root}'
if [ -d "$r" ] && [ ! -L "$r" ] && [ -O "$r" ] && [ "$(head -c 64 "$r/.own-realhost-run" 2>/dev/null)" = '${run.runId}' ] && [ "$(cd "$r" && pwd -P)" = "$r" ]; then
  rh_stop "$r" -TERM; sleep 2; rh_stop "$r" -KILL
  chmod -R u+w "$r" 2>/dev/null; rm -rf "$r"
  if [ -e "$r" ]; then echo "LEFT=$r"; else echo "REMOVED=$r"; fi
else echo "SKIPPED=$r"; fi`
    }),
    `rmdir "$HOME/${TEST_BASE}" 2>/dev/null; true`,
    "echo CLEANUP_DONE=1",
  ]
    .join("\n")
    .replaceAll("\\${", "${")
}
