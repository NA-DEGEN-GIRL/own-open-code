/**
 * Real-host gates (04 §20.3) against ONE approved SSH host. Opt-in: every suite here is skipped unless
 * `OWN_REAL_HOST=<alias>` names the approved host by one of its aliases (`APPROVED`); nothing runs in a normal `bun test`.
 *
 * Rules the helpers enforce (they are the approval's conditions, not preferences):
 *   - ssh only to the approved alias, always with a temp config (`-F <ROOT>\dot-ssh\config`) whose
 *     `UserKnownHostsFile` is a temp file: the user's `~/.ssh/config` and `known_hosts` are never written. Manual
 *     helper commands trust a read-only copy of the user's known_hosts taken at setup; the controller under test starts
 *     from an EMPTY temp known_hosts (the RG5 host key flow writes into it).
 *   - on the host, writes only under the install paths of 04 §5.3 and `/tmp/own-<uid>*`; `cleanupHost()` removes all of
 *     them and the suite compares a before/after listing.
 *   - model traffic only to fakes on this PC, exposed to the host by an `ssh -R` bound to the host's 127.0.0.1.
 *   - `~/.gitconfig` is never written: the listings carry its sha256 and the cleanup suite compares them (06 TG17).
 * State shared by the phases (OWN_HOME, ports, the temp ssh files) lives in `ROOT` (%TEMP%\own-real-host) until the
 * cleanup suite removes it.
 *
 * Phases: a-transport (install, tunnel), b-stack (broker, accounts), c-team (06 TG17: own.team in the remote service,
 * git-lfs, gateway, 07 PG2 on the remote), d-claude (04 RG18: the Claude slot through this PC's egress relay, a fake
 * claude-auth and a fake Anthropic upstream only), e-live (opt-in twice, real models), f-browser (05 §8.6),
 * h-folders (03 §5.1, §18.3: the host's default conversation folder and folder picker), z-cleanup. The release is
 * `OWN_REAL_HOST_RELEASE` (its version read from `app\manifest.json` unless `OWN_REAL_HOST_VERSION` is given) or the
 * build of `OWN_REAL_HOST_VERSION` (default: the T3 exit build) under own\.out\build; c-team needs its remote artifacts
 * with own-team and the pinned git-lfs (`build-remote.ps1`). Every phase after a-transport needs its install and host
 * record (e-live too, which starts its own local stack); z-cleanup removes both.
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

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
 * Evidence kept across runs, one folder per host: its `before.txt` is the listing z-cleanup restores the host to, so
 * another host's listing must never be read here (build-host keeps the original folder name).
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

/** Runs a POSIX script on the approved host (`sh -s`, script on stdin). */
export function hostSh(script: string, timeoutMs = 120_000): Promise<ShellResult> {
  assertApproved()
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
    child.stdin.end(script.replace(/\r\n?/g, "\n"))
  })
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
 * RG4's drop without FIN: freezes the per-connection sshd process of our user that carries the tunnel's keep part.
 * The keep part is the "sh -s" with a "cat" child (a helper's own "sh -s" has none). Its session process is `sshd` up
 * to OpenSSH 9.7 and `sshd-session` from 9.8 (lab runs 10.2), whose parent is the privileged root half. On a shared
 * host more than one candidate stops nothing, and only a process of our own uid is ever stopped.
 */
export const FREEZE_KEEP_SCRIPT = String.raw`set -u
keeps=""
for p in $(ps -u "$(id -u)" -o pid=,args= | awk '$2=="sh" && $3=="-s" && NF==3 {print $1}'); do
  [ "$p" = "$$" ] && continue
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
kill -STOP "$pid" && echo STOPPED=1
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
 * The listing compared before and after the run: top-level entries of the XDG roots and HOME, every own/opencode
 * path the install may create, /tmp/own-* (`== /tmp ours`: only our namespace `/tmp/own-<uid>` and
 * `/tmp/own-<uid>-*`) and the `~/.gitconfig` hash. Metadata only.
 */
export const SNAPSHOT_SCRIPT = String.raw`set -u
echo "== host"; ${HOST_SCRIPT}
echo "== gitconfig"; ${GITCONFIG_SCRIPT}
for d in "$HOME/.local/share" "$HOME/.config" "$HOME/.local/state" "$HOME/.cache" "$HOME"; do
  echo "== ls $d"; ls -A1 "$d" 2>&1 | sort
done
for d in "$HOME/.local/share/opencode" "$HOME/.local/state/opencode" "$HOME/.config/opencode" "$HOME/.cache/opencode" \
         "$HOME/.local/share/own-open-code" "$HOME/.config/own-open-code" "$HOME/.local/state/own-open-code" "$HOME/.own-r"; do
  echo "== find $d"; if [ -e "$d" ]; then find "$d" -maxdepth 2 | sort | head -100; else echo ABSENT; fi
done
echo "== /tmp own-*"; ls -A1 /tmp 2>/dev/null | grep -E '^own-' || echo none
echo "== /tmp ours"; ls -A1 /tmp 2>/dev/null | grep -E "^own-$(id -u)(-|$)" || echo none
echo "== /tmp .bun-uid"; ls -A1 /tmp 2>/dev/null | grep -E "^\.bun-$(id -u)-" || echo none
echo "== processes under our install"; ps -u "$(id -u)" -o pid=,args= | grep -E 'own-open-code|opencode' | grep -v grep || echo none
`

/** Remove everything the suites installed on the host (04 §5.3 paths only), then list what is left. */
export const CLEANUP_SCRIPT = String.raw`set -u
own_home="$HOME/.local/share/own-open-code"
# Stop our service: only a pid whose executable is inside our install.
for f in "$HOME/.local/state/opencode/service-own.json" "$HOME/.local/state/opencode/service-own.json.stale"; do
  [ -f "$f" ] || continue
  pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$f" | head -n 1)
  [ -n "$pid" ] || continue
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
  case "$exe" in "$own_home"/app/*/opencode) kill -CONT "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; echo "STOPPED=$pid" ;; esac
done
sleep 2
for pid in $(ps -u "$(id -u)" -o pid=); do
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
  case "$exe" in "$own_home"/app/*/opencode) kill -CONT "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; echo "KILLED=$pid" ;; esac
done
rm -rf "$own_home" "$HOME/.config/own-open-code" "$HOME/.local/state/own-open-code"
# Directories the own-channel service created (absent before the run, see the before listing).
rm -rf "$HOME/.local/share/opencode" "$HOME/.local/state/opencode" "$HOME/.config/opencode" "$HOME/.cache/opencode"
# Our /tmp namespace only: /tmp/own-<uid> (the socket fallback) and /tmp/own-<uid>-* (team roots, the -rh-* projects).
# The team suites' fixture roots may hold folders a test made read-only (06 §4.11 chmod -R a-w): owner write back first,
# on our own temp roots only (chmod -R never follows a link).
for d in /tmp/own-"$(id -u)" /tmp/own-"$(id -u)"-*; do [ -e "$d" ] && [ -O "$d" ] && { chmod -R u+w "$d" 2>/dev/null; rm -rf "$d"; }; done
# Native modules an install run without TMPDIR extracted under /tmp (opencode --version, service start/stop): our
# files only, never a directory or a link.
own_bun=0
for f in /tmp/.bun-"$(id -u)"-*; do
  [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ] || continue
  rm -f "$f" && own_bun=$((own_bun + 1))
done
echo "BUN_TMP_REMOVED=$own_bun"
echo CLEANUP_DONE=1
`

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
