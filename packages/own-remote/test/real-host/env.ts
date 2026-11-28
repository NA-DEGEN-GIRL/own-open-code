/**
 * Real-host gates (04 §20.3) against ONE approved SSH host. Opt-in: every suite here is skipped unless
 * `OWN_REAL_HOST=<alias>` names the approved host by one of its aliases (`APPROVED`); nothing runs in a normal `bun test`.
 *
 * Rules the helpers enforce (they are the approval's conditions, not preferences):
 *   - ssh only to the approved alias, always with a temp config (`-F <ROOT>\dot-ssh\config`) whose
 *     `UserKnownHostsFile` is a temp file: the user's `~/.ssh/config` and `known_hosts` are never written. Manual
 *     helper commands trust a read-only copy of the user's known_hosts taken at setup; the controller under test starts
 *     from an EMPTY temp known_hosts (the RG5 host key flow writes into it).
 *   - on the host, writes only under the run's test root `$HOME/own-realhost-test/<runId>` (decisions RL35; see
 *     {@link ensureHostRun}): the remote install and its XDG roots, registration, port and every fixture live there,
 *     never on a real install's paths (`~/.local/share/own-open-code`, `~/.config/opencode`, …), which the guard
 *     (isolate.ts) fingerprints before and after every phase. z-cleanup removes only the roots the runs recorded.
 *   - model traffic only to fakes on this PC, exposed to the host by an `ssh -R` bound to the host's 127.0.0.1.
 *   - `~/.gitconfig` is never written: the listings carry its sha256 and the cleanup suite compares them (06 TG17).
 * State shared by the phases (OWN_HOME, ports, the temp ssh files) lives in `ROOT` (%TEMP%\own-real-host) until the
 * cleanup suite removes it.
 *
 * Phases: a-transport (install, tunnel), b-stack (broker, accounts), c-team (06 TG17: own.team in the remote service,
 * git-lfs, gateway, 07 PG2 on the remote), d-claude (04 RG18: the Claude slot through this PC's egress relay, a fake
 * claude-auth and a fake Anthropic upstream only), e-live (opt-in twice, real models), f-browser (05 §8.6),
 * h-folders (03 §5.1, §18.3: the host's default conversation folder and folder picker), i-mcp-hosts, z-cleanup; each
 * inside isolate.ts' guard. The release is
 * `OWN_REAL_HOST_RELEASE` (its version read from `app\manifest.json` unless `OWN_REAL_HOST_VERSION` is given) or the
 * build of `OWN_REAL_HOST_VERSION` (default: the T3 exit build) under own\.out\build; c-team needs its remote artifacts
 * with own-team and the pinned git-lfs (`build-remote.ps1`). Every phase after a-transport needs its install and host
 * record (e-live too, which starts its own local stack); z-cleanup removes both.
 */
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { RemoteModel } from "../../src/remote/model.js"

/**
 * The approved hosts, each under the aliases of its block in the user's ssh config. build-host
 * (`Host build-host dev-host`): approved as dev-host (T3) and again as build-host (2026-10-14, phase E).
 * lab (user dev, shared with other logged-in users): approved by the owner on 2026-11-14 for the light phases only
 * (Z, A, B, C) while build-host is upgraded.
 */
const SERVER = ["dev-host", "build-host"]
const ALIASES = [...SERVER, "lab"]
export const ALIAS = process.env.OWN_REAL_HOST ?? ""
export const APPROVED = ALIASES.includes(ALIAS) ? ALIAS : "dev-host"
export const enabled = process.platform === "win32" && ALIASES.includes(ALIAS)
/** Phase D's long streams, phase E's real models and the heap snapshot run only on build-host, never on hp. */
export const heavyHost = enabled && SERVER.includes(ALIAS)
export const SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe"
export const REPO = path.resolve(import.meta.dir, "../../../..")
const GIVEN_RELEASE = process.env.OWN_REAL_HOST_RELEASE
export const VERSION =
  process.env.OWN_REAL_HOST_VERSION ??
  (GIVEN_RELEASE === undefined
    ? "2.0.18-own.7"
    : (JSON.parse(fs.readFileSync(path.join(GIVEN_RELEASE, "app", "manifest.json"), "utf8")) as { version: string })
        .version)
export const RELEASE = GIVEN_RELEASE ?? path.join(REPO, "own", ".out", "build", VERSION)
export const APP = path.join(RELEASE, "app")
export const ROOT = path.join(os.tmpdir(), "own-real-host")
export const OWN_HOME = path.join(ROOT, "own-home")
export const SSH_DIR = path.join(ROOT, "dot-ssh")
export const SSH_CONFIG = path.join(SSH_DIR, "config")
/** Known hosts of the code under test (starts empty; written only by ssh.exe after "trust"). */
export const KNOWN_HOSTS = path.join(ROOT, "known_hosts")
/** Read-only copy of the user's known_hosts, for the helper commands. */
export const KNOWN_HOSTS_COPY = path.join(ROOT, "known_hosts.user-copy")
/**
 * Evidence kept across runs, one folder per host: its `runs.json` names the test roots made on that host, which only
 * that host's z-cleanup may remove, so another host's record must never be read here (build-host keeps the
 * original folder name).
 */
export const EVIDENCE = path.join(ROOT, SERVER.includes(ALIAS) || ALIAS === "" ? "evidence" : `evidence-${ALIAS}`)

/** The ssh argv prefix of the code under test: the real ssh.exe with the temp config. */
export const sshCommand = () => [SSH, "-F", SSH_CONFIG]

export function assertApproved() {
  if (!enabled) throw new Error(`real-host suites need OWN_REAL_HOST=${APPROVED} on Windows`)
}

/** `ssh -G <alias>` of the user's own config (no connection) → the temp config's block. */
export function prepareSshFiles() {
  assertApproved()
  fs.mkdirSync(SSH_DIR, { recursive: true })
  fs.mkdirSync(EVIDENCE, { recursive: true })
  // The code under test's known_hosts starts empty; z-cleanup removes it and keeps the config.
  if (!fs.existsSync(KNOWN_HOSTS)) fs.writeFileSync(KNOWN_HOSTS, "")
  if (fs.existsSync(SSH_CONFIG)) return
  const resolved = spawnSync(SSH, ["-G", APPROVED], { encoding: "utf8", windowsHide: true })
  if (resolved.status !== 0) throw new Error(`ssh -G failed: ${resolved.stderr}`)
  const value = (key: string) =>
    resolved.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${key} `))
      .map((line) => line.slice(key.length + 1))
  const identity = value("identityfile")
  fs.writeFileSync(
    SSH_CONFIG,
    [
      `Host ${APPROVED}`,
      `  HostName ${value("hostname")[0]}`,
      `  User ${value("user")[0]}`,
      `  Port ${value("port")[0]}`,
      ...identity.map((file) => `  IdentityFile ${file}`),
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${KNOWN_HOSTS}`,
      `  GlobalKnownHostsFile ${path.join(SSH_DIR, "global_known_hosts.empty")}`,
      "",
    ].join("\n"),
  )
  fs.writeFileSync(path.join(SSH_DIR, "global_known_hosts.empty"), "")
  if (!fs.existsSync(KNOWN_HOSTS)) fs.writeFileSync(KNOWN_HOSTS, "")
  fs.copyFileSync(path.join(os.homedir(), ".ssh", "known_hosts"), KNOWN_HOSTS_COPY)
}

/** Base argv of the helper commands: trusted by the user's known_hosts (copy), never prompting, no forwards. */
function helperArgs(extra: string[] = []) {
  return [
    "-F",
    SSH_CONFIG,
    "-o",
    `UserKnownHostsFile=${KNOWN_HOSTS_COPY}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    ...extra,
  ]
}

export interface ShellResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs a POSIX script on the approved host (`sh -s`, script on stdin). Once phase A made the run's test root (decisions
 * RL35), every script starts with {@link runPrelude}: `$OWN_RH_ROOT`, the root's XDG values and TMPDIR, `rh_kill` and
 * `rh_bin`. A script that names the root before there is one fails here instead of running on the real paths.
 */
export function hostSh(script: string, timeoutMs = 120_000): Promise<ShellResult> {
  assertApproved()
  const run = readHostRun()
  if (!run && /\$\{?(OWN_RH_ROOT|OWN_RH_RUN|XDG_)|\brh_(kill|bin|session)\b/.test(script))
    throw new Error("this host script needs the run's test root, which phase A makes (no run.json)")
  const text = run ? `${runPrelude(run)}\n${script}` : script
  return new Promise((resolve) => {
    const child = spawn(SSH, [...helperArgs(["-o", "ClearAllForwardings=yes", "-T"]), APPROVED, "sh -s"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text))
    child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(text.replace(/\r\n?/g, "\n"))
  })
}

/**
 * Runs a POSIX script given as the ssh command (parsed by the account's login shell) with `input` on stdin, after the
 * run's prelude: for uploads (phase I's tarball). Same temp config and trust as {@link hostSh}.
 */
export function hostCommand(script: string, input: Buffer, timeoutMs = 300_000): Promise<ShellResult> {
  assertApproved()
  const text = `${runPrelude(hostRun())}\n${script}`
  return new Promise((resolve) => {
    const child = spawn(SSH, [...helperArgs(["-o", "ClearAllForwardings=yes", "-T"]), APPROVED, text], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The run's test root on the host (decisions RL35). The 2.4.1-own.6 chain installed into, and cleaned up, the paths a
// real app install uses, and its cleanup removed the user's real host install. Now every phase installs, runs and
// writes only under `$HOME/own-realhost-test/<runId>`: own-remote's `remoteTest` option puts the remote install, its
// XDG data/config/state/cache roots and its registration there and gives the service its own port, and the phases'
// fixtures live in `<root>/tmp`. z-cleanup removes only the roots the runs recorded (`runs.json`), never anything else.

/** The directory under the host's HOME that holds the runs' roots. */
export const TEST_BASE = "own-realhost-test"
const RUN_ID = /^r[0-9a-f]{8}$/
/** The current run (removed with ROOT by z-cleanup). */
export const RUN_FILE = path.join(ROOT, "run.json")
/** Every run root made on this host and not yet removed, kept with the evidence across runs (z-cleanup reads it). */
export const RUNS_FILE = path.join(EVIDENCE, "runs.json")

export interface HostRun {
  readonly runId: string
  /** The host account's HOME and `user@hostname` when the run was made. */
  readonly home: string
  readonly host: string
  /** `<home>/own-realhost-test/<runId>`. */
  readonly root: string
  /** The run's remote service port: free on the host and never the channel default of a real install. */
  readonly port: number
  readonly created: string
}

/** Fails unless `run` names a root of the shape this suite makes: `<home>/own-realhost-test/r<8 hex>`. */
export function assertRunShape(run: HostRun) {
  if (!RUN_ID.test(run.runId)) throw new Error(`run id ${JSON.stringify(run.runId)} is not one this suite makes`)
  if (!/^\/[A-Za-z0-9._/-]+$/.test(run.home) || run.home.includes("/../") || run.home.endsWith("/.."))
    throw new Error(`run home ${JSON.stringify(run.home)} is not a plain absolute path`)
  const root = `${run.home.replace(/\/+$/, "")}/${TEST_BASE}/${run.runId}`
  if (run.root !== root) throw new Error(`run root ${JSON.stringify(run.root)} is not ${root}`)
  return run
}

export function readHostRun(): HostRun | undefined {
  if (!fs.existsSync(RUN_FILE)) return undefined
  return assertRunShape(JSON.parse(fs.readFileSync(RUN_FILE, "utf8")) as HostRun)
}

export function readRuns(): HostRun[] {
  if (!fs.existsSync(RUNS_FILE)) return []
  return (JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")) as HostRun[]).map(assertRunShape)
}

export function writeRuns(runs: ReadonlyArray<HostRun>) {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2))
}

/** The current run; fails when there is none (phase A makes it). */
export function hostRun() {
  const run = readHostRun()
  if (!run) throw new Error(`no run's test root on the host: run phase A first (${RUN_FILE} is missing)`)
  return run
}

/**
 * The current run, made when there is none: a new root `$HOME/own-realhost-test/r<8 hex>` with its XDG folders, `tmp`,
 * `bin` and a marker naming the run, recorded in `runs.json` before it is made (so a cleanup always knows it).
 */
export async function ensureHostRun() {
  const existing = readHostRun()
  if (existing) return existing
  const facts = kv((await hostSh(String.raw`echo "HOME=$HOME"; echo "HOST=$(id -un)@$(hostname)"`)).stdout)
  const pick = await freeOnBoth()
  const port = await (async () => {
    for (;;) {
      const candidate = await pick()
      if (candidate !== RemoteModel.defaultPort()) return candidate
    }
  })()
  const runId = `r${randomBytes(4).toString("hex")}`
  const home = facts.get("HOME") ?? ""
  const run = assertRunShape({
    runId,
    home,
    host: facts.get("HOST") ?? "",
    root: `${home.replace(/\/+$/, "")}/${TEST_BASE}/${runId}`,
    port,
    created: new Date().toISOString(),
  })
  writeRuns([...readRuns(), run])
  // `mkdir` (no -p) of the run root itself: an existing path is never adopted.
  const made = await hostSh(String.raw`set -eu
umask 077
mkdir -p "$HOME/${TEST_BASE}"
mkdir '${run.root}'
cd '${run.root}'
[ "$(pwd -P)" = '${run.root}' ]
mkdir data config state cache tmp bin
printf '%s\n' '${run.runId}' > .own-realhost-run
echo MADE=1`)
  if (!made.stdout.includes("MADE=1")) throw new Error(`making the run root failed: ${made.stderr.trim()}`)
  fs.writeFileSync(RUN_FILE, JSON.stringify(run, null, 2))
  return run
}

/**
 * The lines every host script starts with during a run: the root, its XDG values and TMPDIR (exported, so whatever
 * a script starts resolves its paths inside the root), `rh_kill [-SIG] <pid>…` (signals only a process whose executable
 * lies inside the root; anything else is refused and named), `rh_session -SIG <pid>` (RG4's frozen tunnel session, see
 * {@link FREEZE_KEEP_SCRIPT}) and `rh_bin <program>` (a copy of a system program in `<root>/bin`, for stand-ins a
 * phase starts and later stops with rh_kill).
 */
export function runPrelude(run: HostRun) {
  return String.raw`OWN_RH_ROOT='${run.root}'; OWN_RH_RUN='${run.runId}'; export OWN_RH_ROOT OWN_RH_RUN
export XDG_DATA_HOME="$OWN_RH_ROOT/data" XDG_CONFIG_HOME="$OWN_RH_ROOT/config" XDG_STATE_HOME="$OWN_RH_ROOT/state" XDG_CACHE_HOME="$OWN_RH_ROOT/cache" TMPDIR="$OWN_RH_ROOT/tmp"
rh_kill() {
  rh_sig=-TERM; case "$1" in -*) rh_sig=$1; shift ;; esac
  for rh_p in "$@"; do
    rh_e=$(readlink "/proc/$rh_p/exe" 2>/dev/null) || continue
    case "$rh_e" in "$OWN_RH_ROOT"/*) kill "$rh_sig" "$rh_p" 2>/dev/null ;; *) echo "RH_REFUSED=$rh_p:$rh_e" >&2 ;; esac
  done
  return 0
}
rh_start() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f 20; }
rh_session() {
  rh_sig=$1; rh_s=$2
  case "$(cat "/proc/$rh_s/comm" 2>/dev/null)" in sshd|sshd-session) ;; *) echo "RH_REFUSED=$rh_s:not-sshd" >&2; return 1 ;; esac
  [ "$(stat -c %u "/proc/$rh_s" 2>/dev/null)" = "$(id -u)" ] || { echo "RH_REFUSED=$rh_s:uid" >&2; return 1; }
  # A session verified when it was frozen (same pid and start time): its keep part may have ended since.
  grep -qxF "$rh_s $(rh_start "$rh_s")" "$OWN_RH_ROOT/tmp/rh-sessions" 2>/dev/null && { kill "$rh_sig" "$rh_s"; return $?; }
  for rh_c in $(ps --ppid "$rh_s" -o pid=); do
    for rh_g in "$rh_c" $(ps --ppid "$rh_c" -o pid=); do
      tr '\0' '\n' < "/proc/$rh_g/environ" 2>/dev/null | grep -qxF "XDG_STATE_HOME=$OWN_RH_ROOT/state" && { kill "$rh_sig" "$rh_s"; return $?; }
    done
  done
  echo "RH_REFUSED=$rh_s:not-this-run" >&2; return 1
}
rh_bin() { [ -x "$OWN_RH_ROOT/bin/$1" ] || cp "$(command -v "$1")" "$OWN_RH_ROOT/bin/$1"; printf '%s' "$OWN_RH_ROOT/bin/$1"; }`
}

/** `KEY=value` lines of a helper script's output. */
export function kv(output: string) {
  const map = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf("=")
    if (eq > 0 && /^[A-Z0-9_]+$/.test(line.slice(0, eq))) map.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return map
}

/**
 * A long-lived helper ssh with forwards only (`-N`): the fake providers and the egress sink reach the host this way.
 * Independent of the controller's tunnel, so killing that tunnel leaves this one up.
 */
export function forwardProcess(forwards: string[]) {
  assertApproved()
  const child = spawn(
    SSH,
    [
      ...helperArgs(["-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-N", "-T"]),
      ...forwards,
      APPROVED,
    ],
    { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
  )
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr = (stderr + text).slice(-8192)))
  return { child, stderr: () => stderr, stop: () => child.kill() }
}

/** A port free on this PC's 127.0.0.1 (the fakes bind the same number the host's -R listens on). */
export async function freeLocalPort(low = 30_000, high = 39_999) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = low + Math.floor(Math.random() * (high - low))
    const ok = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once("error", () => resolve(false))
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error("no free local port")
}

/** Ports fixed for the whole run (the remote service's env names the egress sink port before it first starts). */
export async function ports(): Promise<{ readonly provider: number; readonly sink: number; readonly codex: number }> {
  const file = path.join(ROOT, "ports.json")
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
  const pick = await freeOnBoth()
  const chosen = { provider: await pick(), sink: await pick(), codex: await pick() }
  fs.writeFileSync(file, JSON.stringify(chosen))
  return chosen
}

/**
 * A picker of ports free on this PC's 127.0.0.1 and not listening on the host, for a fake this PC serves that the host
 * reaches by an `ssh -R` of the same number (phase C's fake GitHub, whose LFS actions name its own address). It never
 * picks a port `ports.json` holds for the run (their forwards may not be up yet) or one it picked before. A host it
 * cannot read fails: an empty list would call every port free there.
 */
export async function freeOnBoth(listing: () => Promise<ShellResult> = () => hostSh("ss -Htln")) {
  const listening = await listing()
  if (listening.code !== 0)
    throw new Error(`freeOnBoth: ss on the host failed (exit ${listening.code}): ${listening.stderr.trim()}`)
  const file = path.join(ROOT, "ports.json")
  const reserved: ReadonlyArray<number> = fs.existsSync(file)
    ? Object.values(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>)
    : []
  // `State Recv-Q Send-Q Local:Port Peer:Port …`: the local address is the fourth column.
  const busy = new Set([
    ...reserved,
    ...listening.stdout
      .split("\n")
      .map((line) => Number(line.trim().split(/\s+/)[3]?.split(":").at(-1)))
      .filter(Number.isFinite),
  ])
  return async () => {
    for (;;) {
      const port = await freeLocalPort()
      if (busy.has(port)) continue
      busy.add(port)
      return port
    }
  }
}

export function evidence(name: string, value: unknown) {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  fs.writeFileSync(path.join(EVIDENCE, name), typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

/**
 * sha256 of the user's `~/.gitconfig` (`ABSENT` without one): read only, never written by own (06 §4.13, TG17). The
 * listings carry it as the `== gitconfig` section.
 */
export const GITCONFIG_SCRIPT = String.raw`if [ -f "$HOME/.gitconfig" ]; then sha256sum < "$HOME/.gitconfig" | cut -d " " -f 1; else echo ABSENT; fi`

/** The account and machine a listing was taken on (`== host`). */
export const HOST_SCRIPT = String.raw`echo "$(id -un)@$(hostname)"`

/**
 * Fails unless a before listing was taken on the host this run reaches: z-cleanup removes whole the directories that
 * listing shows absent, so another machine's listing could remove the user's own folders there. Listings written
 * before the `== host` section existed name no host and are accepted.
 */
export async function assertListingHost(listing: string, read: () => Promise<ShellResult> = () => hostSh(HOST_SCRIPT)) {
  const recorded = section(listing, "== host")[0]
  if (recorded === undefined) return
  const current = await read()
  if (current.code !== 0) throw new Error(`reading the host's name failed (exit ${current.code}): ${current.stderr.trim()}`)
  if (current.stdout.trim() !== recorded)
    throw new Error(`the before listing in ${EVIDENCE} was taken on ${recorded}, not on ${current.stdout.trim()}`)
}

/**
 * RG4's drop without FIN: freezes the per-connection sshd process of our user that carries this run's tunnel keep part
 * (its environment names the run's root). The one signal outside the root (decisions RL35): `rh_session` stops only an
 * sshd session process of our uid whose child carries the run's root, so a real app's session is never touched.
 * The keep part is the "sh -s" with a "cat" child (a helper's own "sh -s" has none). Its session process is `sshd` up
 * to OpenSSH 9.7 and `sshd-session` from 9.8 (lab runs 10.2), whose parent is the privileged root half. On a shared
 * host more than one candidate stops nothing, and only a process of our own uid is ever stopped.
 */
export const FREEZE_KEEP_SCRIPT = String.raw`set -u
keeps=""
for p in $(ps -u "$(id -u)" -o pid=,args= | awk '$2=="sh" && $3=="-s" && NF==3 {print $1}'); do
  [ "$p" = "$$" ] && continue
  # Only this run's keep part: its environment carries the run's root (own-remote's remoteTest command prefix). A real
  # app's keep part of the same account (the user may be connected meanwhile) never matches.
  tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -qxF "XDG_STATE_HOME=$OWN_RH_ROOT/state" || continue
  ps --ppid "$p" -o comm= | grep -qx cat && keeps="$keeps $p"
done
set -- $keeps
[ $# -eq 1 ] || { echo "KEEPS=$#"; exit 0; }
keep=$1
echo "KEEP=$keep"
pid=$(ps -o ppid= -p "$keep" | tr -d ' ')
case "$(cat /proc/$pid/comm)" in sshd|sshd-session) ;; *) pid=$(ps -o ppid= -p "$pid" | tr -d ' ') ;; esac
comm=$(cat /proc/$pid/comm)
case "$comm" in sshd|sshd-session) ;; *) echo "NO_SSHD=$comm"; exit 0 ;; esac
[ "$(stat -c %u /proc/$pid)" = "$(id -u)" ] || { echo "NOT_OURS=$pid"; exit 0; }
echo "SSHD=$pid"; echo "COMM=$comm"; echo "UID=$(stat -c %u /proc/$pid)"
echo "CHILDREN=$(ps --ppid "$pid" -o pid= | tr '\n' ' ')"
rh_session -STOP "$pid" && echo "$pid $(rh_start "$pid")" >> "$OWN_RH_ROOT/tmp/rh-sessions" && echo STOPPED=1
`

/**
 * Runs {@link FREEZE_KEEP_SCRIPT} once the host has exactly one of our keep shells. The session a test just replaced
 * (a disconnect, then a connect) can take a few seconds to leave the host; while both are there the script stops
 * nothing (`KEEPS=2`, the 2.4.1-own.3 chain's RG4). Answers the last run's output.
 */
export async function freezeKeep() {
  const deadline = Date.now() + 30_000
  for (;;) {
    const result = await hostSh(FREEZE_KEEP_SCRIPT)
    if (!/^KEEPS=/m.test(result.stdout) || Date.now() > deadline) return result
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** The lines of one `== <header>` section of a listing. */
export function section(listing: string, header: string) {
  const lines = listing.split(/\r?\n/)
  const start = lines.findIndex((line) => line === header)
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && line.startsWith("== "))
  return lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean)
}

/**
 * The remote artifacts' git-lfs entry for `target` (`remote\manifest.json` `tools.git-lfs`, 06 §4.13), or `undefined`
 * when the release was built without it.
 */
export function releaseLfs(target = "linux-x64-baseline") {
  const file = path.join(APP, "remote", "manifest.json")
  if (!fs.existsSync(file)) return undefined
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
    readonly tools?: {
      readonly "git-lfs"?: {
        readonly version: string
        readonly targets: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>
      }
    }
  }
  const lfs = manifest.tools?.["git-lfs"]
  const entry = lfs?.targets[target]
  return lfs && entry ? { version: lfs.version, sha256: entry.sha256, bytes: entry.bytes } : undefined
}
