export * as Scripts from "./scripts.js"

import { RemoteCli } from "../vendor/remote/cli.js"

/**
 * Remote POSIX `sh` scripts (04 §5.4–§5.6, §6.1, §6.4, §7.4). Every script is sent over stdin (`sh -s`) or as the
 * `sh -c` argument of an install, never interpolated into the ssh command line, so the user's login shell (bash, zsh,
 * fish) does not reparse it. Parameters are assigned in a prelude with single-quote quoting; bodies read only those
 * variables. Bodies are wrapped in one function that runs from the last line: the shell has parsed the whole script
 * before anything runs, so a child that reads stdin (the keep part's `cat`) never eats script text.
 *
 * Output contract: a script reports only `OWN_<SCRIPT>_<KEY>=<value>` lines (plus the upstream registration block for
 * ensure). Parsers drop every other line, so profile scripts that print banners cannot inject values.
 *
 * Test seam: `OWN_REMOTE_TEST_ROOT` (empty in production) prefixes `/proc` and `/etc/machine-id`, so the fake-SSH
 * harness can run these scripts on a non-Linux POSIX shell. It is never set by own-remote.
 */

export type Params = Readonly<Record<string, string | number | undefined>>

/** `name='value'` lines. Names are fixed identifiers of this module; values are always quoted. */
export function prelude(params: Params) {
  return Object.entries(params)
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid script parameter name: ${name}`)
      const text = value === undefined ? "" : String(value)
      if (text.includes("\0")) throw new Error(`NUL in script parameter ${name}`)
      return `${name}=${RemoteCli.quote(text)}`
    })
    .join("\n")
}

/** A script is LF only: a CR makes `sh` fail with `$'\r'` errors (04 §14.4). */
function lf(text: string) {
  return text.replace(/\r\n?/g, "\n")
}

// Shared helpers (defined inside every script).
const helpers = String.raw`
own_proc="\${OWN_REMOTE_TEST_ROOT:-}/proc"
own_machine_id="\${OWN_REMOTE_TEST_ROOT:-}/etc/machine-id"
own_emit() { printf '%s_%s=%s\n' "$own_prefix" "$1" "$2"; }
own_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 | awk '{print $NF}'
  else return 1; fi
}
own_identity() {
  if [ ! -r "$own_machine_id" ]; then printf 'unavailable'; return 0; fi
  own_mid=$(cat "$own_machine_id" 2>/dev/null) || { printf 'unavailable'; return 0; }
  own_hash=$(printf '%s\0%s\0%s' "$own_mid" "$(id -u)" "$HOME" | own_sha256) || { printf 'unavailable'; return 0; }
  printf 'sha256:%s' "$own_hash"
}
# JSON string field of a small one-object file (registration, owner, service config). Values we read never contain
# quotes or backslashes (urls, versions, ids, base64url passwords).
own_json_str() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1; }
own_json_num() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -n 1; }
own_physical() { (cd "$1" 2>/dev/null && pwd -P); }
# Executable of a pid, or empty. Linux: /proc/<pid>/exe is a symlink; the test root may use a file instead.
own_exe_of() {
  readlink "$own_proc/$1/exe" 2>/dev/null && return 0
  if [ -f "$own_proc/$1/exe" ] && [ ! -L "$own_proc/$1/exe" ]; then cat "$own_proc/$1/exe" 2>/dev/null; fi
  return 0
}
own_alive() { [ -n "$1" ] && [ -d "$own_proc/$1" ]; }
# app/current -> <version>. "mv -T" replaces the link itself (plain mv would move into the linked directory).
own_set_current() {
  ln -sfn "$2" "$1/app/.current.tmp" 2>/dev/null && mv -fT "$1/app/.current.tmp" "$1/app/current" 2>/dev/null && return 0
  rm -f "$1/app/.current.tmp"
  ln -sfn "$2" "$1/app/current"
}
# Owned by us, not a symlink, mode 0700 (04 §7.4). The test root cannot express POSIX modes and skips that part.
own_safe_dir() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] || return 1
  chmod 700 "$1" 2>/dev/null
  [ -n "\${OWN_REMOTE_TEST_ROOT:-}" ] && return 0
  [ "$(ls -ld "$1" 2>/dev/null | cut -c5-10)" = "------" ]
}
# "running" only when pid alive AND exe is <home>/app/<v>/opencode AND the registration version is <v> (04 §6.1).
own_running_version() {
  own_reg="$1"; own_home_p=$(own_physical "$2")
  [ -f "$own_reg" ] || return 1
  own_pid=$(own_json_num "$own_reg" pid); own_ver=$(own_json_str "$own_reg" version)
  own_alive "$own_pid" || return 1
  own_exe=$(own_exe_of "$own_pid")
  [ -n "$own_exe" ] && [ -n "$own_ver" ] && [ -n "$own_home_p" ] || return 1
  [ "$own_exe" = "$own_home_p/app/$own_ver/opencode" ] || return 1
  printf '%s' "$own_ver"
}
own_mount_flags() {
  own_dir="$1"
  while [ ! -d "$own_dir" ] && [ "$own_dir" != / ]; do own_dir=$(dirname "$own_dir"); done
  own_opts=""
  if command -v findmnt >/dev/null 2>&1; then own_opts=$(findmnt -no OPTIONS -T "$own_dir" 2>/dev/null </dev/null); fi
  if [ -z "$own_opts" ] && [ -r /proc/mounts ]; then
    own_mp=$(df -P "$own_dir" 2>/dev/null </dev/null | awk 'NR==2{print $6}')
    [ -n "$own_mp" ] && own_opts=$(awk -v m="$own_mp" '$2==m{o=$4} END{print o}' /proc/mounts 2>/dev/null)
  fi
  case ",$own_opts," in
    *,noexec,*) printf 'noexec' ;;
    ,,) printf 'unknown' ;;
    *) printf 'exec' ;;
  esac
}
`.replaceAll("\\${", "${")

// ---------------------------------------------------------------------------------------------------------------
// inspect (04 §5.4): read-only.

export interface InspectParams {
  /** Known OWN_HOME (installRoot or the stored value); empty = `${XDG_DATA_HOME:-$HOME/.local/share}/own-open-code`. */
  readonly ownHome?: string
}

export function inspect(params: InspectParams = {}) {
  return lf(`set -u
${prelude({ OWN_P_HOME: params.ownHome })}
own_main() {
own_prefix=OWN_INSPECT
${helpers}
own_emit V 1
own_emit OS "$(uname -s 2>/dev/null </dev/null | tr '[:upper:]' '[:lower:]')"
own_emit ARCH "$(uname -m 2>/dev/null </dev/null)"
own_probe() (
${RemoteCli.probeScript})
own_target=$(own_probe </dev/null 2>/dev/null | sed -n 's/^OPENCODE_REMOTE_TARGET=//p' | tail -n 1)
own_emit TARGET "\${own_target:-unsupported}"
case "\${own_target:-}" in *-musl) own_emit LIBC musl ;; linux-*) own_emit LIBC glibc ;; *) own_emit LIBC unknown ;; esac
own_emit UID "$(id -u)"
own_emit SHELL "\${SHELL:-}"
own_emit HOME "$HOME"
own_emit HOST_IDENTITY "$(own_identity)"
own_home="\${OWN_P_HOME:-\${XDG_DATA_HOME:-$HOME/.local/share}/own-open-code}"
own_emit OWN_HOME "$own_home"
own_state="\${XDG_STATE_HOME:-$HOME/.local/state}"
own_free_dir="$own_home"
while [ ! -d "$own_free_dir" ] && [ "$own_free_dir" != / ]; do own_free_dir=$(dirname "$own_free_dir"); done
own_emit FREE_KB "$(df -Pk "$own_free_dir" 2>/dev/null </dev/null | awk 'NR==2{print $4}')"
own_installed=""
for own_d in "$own_home"/app/*/; do
  [ -f "$own_d.verified" ] || continue
  own_v=$(basename "$own_d")
  [ "$own_v" = current ] && continue
  own_installed="\${own_installed:+$own_installed,}$own_v"
done
own_emit INSTALLED "$own_installed"
own_emit CURRENT "$(readlink "$own_home/app/current" 2>/dev/null)"
own_reg="$own_state/opencode/service-own.json"
if [ -f "$own_reg" ]; then
  own_emit RUNNING_PID "$(own_json_num "$own_reg" pid)"
  if own_alive "$(own_json_num "$own_reg" pid)"; then own_emit RUNNING_PID_ALIVE 1; else own_emit RUNNING_PID_ALIVE 0; fi
  if own_rv=$(own_running_version "$own_reg" "$own_home"); then own_emit RUNNING_VERSION "$own_rv"; own_emit RUNNING_EXE_OK 1
  else own_emit RUNNING_VERSION "$(own_json_str "$own_reg" version)"; own_emit RUNNING_EXE_OK 0; fi
fi
own_emit OWNER "$(own_json_str "$own_home/run/owner.json" installId)"
own_emit OWNER_LABEL "$(own_json_str "$own_home/run/owner.json" label)"
own_up=0
if [ -x "$HOME/.opencode/bin/opencode" ] || [ -f "$own_state/opencode/service.json" ] || command -v opencode >/dev/null 2>&1; then own_up=1; fi
own_emit UPSTREAM_OPENCODE "$own_up"
if command -v sha256sum >/dev/null 2>&1; then own_emit SHA256_TOOL sha256sum
elif command -v shasum >/dev/null 2>&1; then own_emit SHA256_TOOL shasum
elif command -v openssl >/dev/null 2>&1; then own_emit SHA256_TOOL openssl
else own_emit SHA256_TOOL none; fi
if command -v tar >/dev/null 2>&1; then own_emit TAR 1; else own_emit TAR 0; fi
own_pending=""
for own_op in "$own_home"/ops/*.json; do
  [ -f "$own_op" ] || continue
  grep -q '"state":"running"' "$own_op" 2>/dev/null || continue
  own_pending="\${own_pending:+$own_pending,}$(own_json_str "$own_op" opId):$(own_json_str "$own_op" kind)"
done
own_emit OPS_PENDING "$own_pending"
own_uid=$(id -u)
own_emit LINGER "$(loginctl show-user "$own_uid" -p Linger 2>/dev/null </dev/null | sed -n 's/^Linger=//p')"
own_kup=$(cat /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf 2>/dev/null | sed -n 's/^[[:space:]]*KillUserProcesses[[:space:]]*=[[:space:]]*//p' | tail -n 1)
own_emit KILL_USER_PROCESSES "\${own_kup:-unset}"
own_emit TMP_FLAGS "$(own_mount_flags /tmp)"
own_emit OWN_HOME_FLAGS "$(own_mount_flags "$own_home")"
own_sock="$own_home/run/broker-0000000000.sock"
own_emit SOCK_PATH_LEN "\${#own_sock}"
# Shell environments (04 §5.4): only allow-listed keys leave the host; values between markers only.
own_env_mode() {
  own_label=$1; shift
  if command -v timeout >/dev/null 2>&1; then
    own_out=$(timeout 10 "$@" 'echo OWN_ENV_BEGIN; env; echo OWN_ENV_END' </dev/null 2>/dev/null) || true
  else
    own_out=$("$@" 'echo OWN_ENV_BEGIN; env; echo OWN_ENV_END' </dev/null 2>/dev/null) || true
  fi
  own_body=$(printf '%s\n' "$own_out" | sed -n '/^OWN_ENV_BEGIN$/,/^OWN_ENV_END$/p')
  if [ -z "$own_body" ]; then own_emit "ENV_\${own_label}_STATE" unavailable; return 0; fi
  own_emit "ENV_\${own_label}_STATE" ok
  printf '%s\n' "$own_body" | while IFS= read -r own_line; do
    case "$own_line" in
      HOME=*|XDG_DATA_HOME=*|XDG_STATE_HOME=*|XDG_CONFIG_HOME=*|PATH=*)
        own_emit "ENV_\${own_label}_\${own_line%%=*}" "\${own_line#*=}" ;;
    esac
  done
}
own_env_mode SHL /bin/sh -l -c
if [ -n "\${SHELL:-}" ] && [ -x "$SHELL" ]; then
  own_env_mode LOGIN "$SHELL" -l -c
  own_env_mode INTERACTIVE "$SHELL" -l -i -c
else
  own_emit ENV_LOGIN_STATE unavailable
  own_emit ENV_INTERACTIVE_STATE unavailable
fi
own_emit DONE 1
}
own_main
`)
}

// ---------------------------------------------------------------------------------------------------------------
// install (04 §5.5): upload only. Runs as `sh -c '<script>'` with the bundle (.tar.gz) on stdin.
//
// The script is the one ssh command-line argument that the remote login shell parses (the archive owns stdin), so it
// contains no single quote and no backslash: `quote()` then yields a plain '…' string that POSIX shells, zsh and fish
// all read the same way. Parameters use double quotes and a strict character set.

export interface InstallParams {
  readonly ownHome: string
  readonly version: string
  /** `sha256sum -c` lines for the bundle files: `<hex>  <relative path>`. */
  readonly sums: string
  /** Also point `app/current` at this version (first install only; an update switches later, 04 §6.4). */
  readonly setCurrent: boolean
  /** Short socket directory to create besides `run/` (04 §7.4), or empty. */
  readonly socketDir?: string
}

const SAFE_VALUE = /^[A-Za-z0-9._/+:=@%, \n-]*$/

function dq(name: string, value: string) {
  if (!SAFE_VALUE.test(value)) throw new Error(`unsafe install parameter ${name}`)
  return `${name}="${value}"`
}

export function install(params: InstallParams) {
  return lf(`set -u
umask 077
${dq("OWN_I_HOME", params.ownHome)}
${dq("OWN_I_VERSION", RemoteCli.requireVersion(params.version))}
${dq("OWN_I_SUMS", params.sums)}
${dq("OWN_I_CURRENT", params.setCurrent ? "1" : "0")}
${dq("OWN_I_SOCKDIR", params.socketDir ?? "")}
own_stage=""
own_fail() {
  echo "OWN_INSTALL=$1"
  if [ -n "\${2:-}" ]; then echo "OWN_INSTALL_DETAIL=$2"; fi
  exit 0
}
own_cleanup() { if [ -n "$own_stage" ]; then rm -rf "$own_stage"; fi; }
own_space() { grep -qiE "No space left|Disk quota exceeded" "$1" 2>/dev/null; }
own_set_current() {
  ln -sfn "$2" "$1/app/.current.tmp" 2>/dev/null && mv -fT "$1/app/.current.tmp" "$1/app/current" 2>/dev/null && return 0
  rm -f "$1/app/.current.tmp"
  ln -sfn "$2" "$1/app/current"
}
mkdir -p "$OWN_I_HOME/app" 2>/dev/null || own_fail install_failed mkdir
chmod 700 "$OWN_I_HOME" "$OWN_I_HOME/app" 2>/dev/null
own_dest="$OWN_I_HOME/app/$OWN_I_VERSION"
if [ -f "$own_dest/.verified" ]; then
  cat >/dev/null
  echo "OWN_INSTALL=present"
else
  own_stage=$(mktemp -d "$OWN_I_HOME/app/.install-XXXXXX" 2>/dev/null) || own_fail install_failed mktemp
  trap own_cleanup EXIT
  own_err="$own_stage/err"
  if ! cat > "$own_stage/bundle.tgz" 2>"$own_err"; then
    if own_space "$own_err"; then own_fail disk_full upload; fi
    own_fail install_failed upload
  fi
  mkdir "$own_stage/x"
  if ! tar -xzf "$own_stage/bundle.tgz" -C "$own_stage/x" 2>"$own_err"; then
    if own_space "$own_err"; then own_fail disk_full extract; fi
    own_fail install_failed extract
  fi
  rm -f "$own_stage/bundle.tgz"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$own_stage/x" && echo "$OWN_I_SUMS" | sha256sum -c --status) || own_fail install_failed checksum
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$own_stage/x" && echo "$OWN_I_SUMS" | shasum -a 256 -c --status) || own_fail install_failed checksum
  elif command -v openssl >/dev/null 2>&1; then
    own_bad=$(echo "$OWN_I_SUMS" | while read -r own_sum own_file; do
      if [ -z "$own_file" ]; then continue; fi
      own_got=$(openssl dgst -sha256 "$own_stage/x/$own_file" 2>/dev/null)
      if [ "\${own_got##* }" != "$own_sum" ]; then echo bad; fi
    done)
    if [ -n "$own_bad" ]; then own_fail install_failed checksum; fi
  else
    echo "OWN_INSTALL_WARN=no_sha256"
  fi
  chmod 755 "$own_stage/x/opencode" 2>/dev/null || own_fail install_failed chmod
  # Bun extracts its native modules under TMPDIR: keep them in OWN_HOME/tmp, never as /tmp/.bun-<uid>-* files.
  mkdir -p "$OWN_I_HOME/tmp" 2>/dev/null && chmod 700 "$OWN_I_HOME/tmp" 2>/dev/null
  own_out=$(TMPDIR="$OWN_I_HOME/tmp" "$own_stage/x/opencode" --version </dev/null 2>"$own_err")
  own_code=$?
  if [ "$own_code" -ne 0 ]; then
    if grep -qiE "exec format error|cannot execute binary" "$own_err" 2>/dev/null; then own_fail platform_mismatch version; fi
    if [ "$own_code" -eq 126 ]; then own_fail noexec version; fi
    own_fail install_failed "version exit $own_code"
  fi
  own_got=$(echo "$own_out" | tail -n 1)
  own_got=\${own_got##* }
  own_got=\${own_got#v}
  if [ "$own_got" != "$OWN_I_VERSION" ]; then own_fail install_failed "version $own_got"; fi
  (cd "$own_stage/x" && find . -type f | sort | while IFS= read -r own_f; do
    echo "$(wc -c < "$own_f" | tr -d " ") $own_f"
  done) > "$own_stage/x.verified" 2>/dev/null || own_fail install_failed verified
  echo "$OWN_I_SUMS" >> "$own_stage/x.verified"
  mv "$own_stage/x.verified" "$own_stage/x/.verified" || own_fail install_failed verified
  if ! mv "$own_stage/x" "$own_dest" 2>"$own_err"; then
    if own_space "$own_err"; then own_fail disk_full move; fi
    own_fail install_failed move
  fi
  echo "OWN_INSTALL=installed"
fi
if [ "$OWN_I_CURRENT" = 1 ] || [ ! -e "$OWN_I_HOME/app/current" ]; then
  own_set_current "$OWN_I_HOME" "$OWN_I_VERSION" || own_fail install_failed current
fi
mkdir -p "$OWN_I_HOME/run" "$OWN_I_HOME/tmp" "$OWN_I_HOME/control" "$OWN_I_HOME/ops" "$OWN_I_HOME/backup" 2>/dev/null
chmod 700 "$OWN_I_HOME/run" "$OWN_I_HOME/tmp" "$OWN_I_HOME/ops" "$OWN_I_HOME/backup" 2>/dev/null
if [ -n "$OWN_I_SOCKDIR" ]; then mkdir -p "$OWN_I_SOCKDIR" && chmod 700 "$OWN_I_SOCKDIR"; fi
echo "OWN_INSTALL_DONE=1"
`)
}

// ---------------------------------------------------------------------------------------------------------------
// tool (06 §4.13): a pinned static tool (git-lfs) under <OWN_HOME>/tools/<tool>/<version>/, upload only, no sudo,
// nothing outside OWN_HOME. Runs as `sh -c '<script>'` with the same quoting rules as install. Without `files` it only
// looks: `present` (after pointing `current` at the verified version) or `missing` with the free space; with `files`
// the payload on stdin is those files back to back. Either way `CURRENT` names the version `current` pointed at
// before, when the host had the tool (an update replaces only a tool the host already has, LFS-3).

export interface ToolParams {
  readonly ownHome: string
  readonly tool: string
  readonly version: string
  /** The executable among the files; `<binary> version` prints `<tool>/<version> …` on its first line. */
  readonly binary: string
  /** `sha256sum -c` lines of the files: `<hex>  <name>`. */
  readonly sums: string
  /** The files on stdin in order: each but the last is read by its size (`dd bs=1`), the last takes the rest. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly bytes: number }>
}

export function tool(params: ToolParams) {
  for (const name of [params.tool, params.binary, ...params.files.map((file) => file.name)])
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`unsafe tool file name ${name}`)
  return lf(`set -u
umask 077
${dq("OWN_T_HOME", params.ownHome)}
${dq("OWN_T_TOOL", params.tool)}
${dq("OWN_T_VERSION", params.version)}
${dq("OWN_T_BIN", params.binary)}
${dq("OWN_T_SUMS", params.sums)}
${dq("OWN_T_FILES", params.files.map((file) => `${file.name}:${file.bytes}`).join(" "))}
own_stage=""
own_fail() {
  echo "OWN_TOOL=$1"
  if [ -n "\${2:-}" ]; then echo "OWN_TOOL_DETAIL=$2"; fi
  exit 0
}
own_cleanup() { if [ -n "$own_stage" ]; then rm -rf "$own_stage"; fi; }
own_space() { grep -qiE "No space left|Disk quota exceeded" "$1" 2>/dev/null; }
# The executable in folder $1 reports this version.
own_runs() {
  own_line=$("$1/$OWN_T_BIN" version </dev/null 2>/dev/null | head -n 1)
  [ "\${own_line%% *}" = "$OWN_T_TOOL/$OWN_T_VERSION" ]
}
# current -> <version>. "mv -T" replaces the link itself (plain mv would move into the linked directory).
own_link() {
  ln -sfn "$OWN_T_VERSION" "$own_root/.current.tmp" 2>/dev/null && mv -fT "$own_root/.current.tmp" "$own_root/current" 2>/dev/null && return 0
  rm -f "$own_root/.current.tmp"
  ln -sfn "$OWN_T_VERSION" "$own_root/current"
}
own_root="$OWN_T_HOME/tools/$OWN_T_TOOL"
own_dest="$own_root/$OWN_T_VERSION"
own_current=$(readlink "$own_root/current" 2>/dev/null)
if [ -n "$own_current" ]; then echo "OWN_TOOL_CURRENT=\${own_current%/}"; fi
if [ -f "$own_dest/.verified" ] && own_runs "$own_dest"; then
  if [ -n "$OWN_T_FILES" ]; then cat >/dev/null; fi
  own_state=present
elif [ -z "$OWN_T_FILES" ]; then
  own_free="$own_root"
  while [ ! -d "$own_free" ] && [ "$own_free" != / ]; do own_free=$(dirname "$own_free"); done
  echo "OWN_TOOL_FREE_KB=$(df -Pk "$own_free" 2>/dev/null </dev/null | tail -n 1 | tr -s " " | cut -d " " -f 4)"
  echo "OWN_TOOL=missing"
  exit 0
else
  mkdir -p "$own_root" 2>/dev/null || own_fail install_failed mkdir
  chmod 700 "$OWN_T_HOME/tools" "$own_root" 2>/dev/null
  own_stage=$(mktemp -d "$own_root/.install-XXXXXX" 2>/dev/null) || own_fail install_failed mktemp
  trap own_cleanup EXIT
  own_err="$own_stage/err"
  mkdir "$own_stage/x"
  set -- $OWN_T_FILES
  while [ $# -gt 0 ]; do
    own_name=\${1%%:*}
    own_bytes=\${1##*:}
    shift
    if [ $# -gt 0 ]; then
      dd bs=1 count="$own_bytes" of="$own_stage/x/$own_name" 2>"$own_err"
    else
      cat > "$own_stage/x/$own_name" 2>"$own_err"
    fi || { if own_space "$own_err"; then own_fail disk_full upload; fi; own_fail install_failed upload; }
    [ "$(wc -c < "$own_stage/x/$own_name" | tr -d " ")" = "$own_bytes" ] || own_fail install_failed "size $own_name"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$own_stage/x" && echo "$OWN_T_SUMS" | sha256sum -c --status) || own_fail install_failed checksum
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$own_stage/x" && echo "$OWN_T_SUMS" | shasum -a 256 -c --status) || own_fail install_failed checksum
  elif command -v openssl >/dev/null 2>&1; then
    own_bad=$(echo "$OWN_T_SUMS" | while read -r own_sum own_file; do
      if [ -z "$own_file" ]; then continue; fi
      own_got=$(openssl dgst -sha256 "$own_stage/x/$own_file" 2>/dev/null)
      if [ "\${own_got##* }" != "$own_sum" ]; then echo bad; fi
    done)
    if [ -n "$own_bad" ]; then own_fail install_failed checksum; fi
  else
    echo "OWN_TOOL_WARN=no_sha256"
  fi
  chmod 755 "$own_stage/x/$OWN_T_BIN" 2>/dev/null || own_fail install_failed chmod
  own_out=$("$own_stage/x/$OWN_T_BIN" version </dev/null 2>"$own_err")
  own_code=$?
  if [ "$own_code" -ne 0 ]; then
    if grep -qiE "exec format error|cannot execute binary" "$own_err" 2>/dev/null; then own_fail platform_mismatch version; fi
    if [ "$own_code" -eq 126 ]; then own_fail noexec version; fi
    own_fail install_failed "version exit $own_code"
  fi
  own_got=$(echo "$own_out" | head -n 1)
  own_got=\${own_got%% *}
  if [ "$own_got" != "$OWN_T_TOOL/$OWN_T_VERSION" ]; then own_fail install_failed "version $own_got"; fi
  echo "$OWN_T_SUMS" > "$own_stage/x/.verified" || own_fail install_failed verified
  rm -rf "$own_dest"
  if ! mv "$own_stage/x" "$own_dest" 2>"$own_err"; then
    if own_space "$own_err"; then own_fail disk_full move; fi
    own_fail install_failed move
  fi
  own_state=uploaded
fi
own_link || own_fail install_failed current
own_runs "$own_root/current" || own_fail install_failed current
echo "OWN_TOOL_PATH=$own_root/current"
echo "OWN_TOOL_VERSION=$OWN_T_VERSION"
echo "OWN_TOOL=$own_state"
echo "OWN_TOOL_DONE=1"
`)
}

// ---------------------------------------------------------------------------------------------------------------
// ensure + keep (04 §6.1, §7.4): runs inside the tunnel session (`sh -s`), keeps it open afterwards.

export interface EnsureParams {
  readonly version: string
  readonly ownHome: string
  readonly stateDir: string
  readonly configDir: string
  readonly upstreamConfigDir: string
  /** `sha256:<hex>`, `unavailable`, or empty to skip the check (first connection before inspect recorded one). */
  readonly identity: string
  readonly installId: string
  readonly ownerJson: string
  readonly opId?: string
  readonly epoch: number
  /**
   * Directory of `broker-<epoch>.sock` (and of the Claude egress relay's `egress-<epoch>.sock`, 04 §8.11.4.2), or empty
   * when the broker forward is TCP or absent.
   */
  readonly socketDir: string
  readonly port: number
  /** `default`: write the port only when the service config has none; `force`: overwrite it. */
  readonly portMode: "default" | "force"
  /** JSON object text of the service `env` (built with JSON.stringify). */
  readonly envJson: string
  /** Full text of the managed `opencode.json` (04 §5.6). */
  readonly managedConfig: string
  readonly shellEnv: "login" | "login-interactive" | "sh"
  /** Colon-joined absolute directories to put in front of the login PATH. */
  readonly pathPrepend: string
  /** Seconds between `broker.current` checks of the keep part (default 15). */
  readonly keepInterval?: number
  /** `0` reports the state without starting a service (recover and drain checks). */
  readonly start?: boolean
}

export function ensure(params: EnsureParams) {
  return lf(`set -u
umask 077
${prelude({
  OWN_E_VERSION: RemoteCli.requireVersion(params.version),
  OWN_E_HOME: params.ownHome,
  OWN_E_STATE: params.stateDir,
  OWN_E_CONFIG: params.configDir,
  OWN_E_UPCONFIG: params.upstreamConfigDir,
  OWN_E_IDENTITY: params.identity,
  OWN_E_INSTALL_ID: params.installId,
  OWN_E_OWNER_JSON: params.ownerJson,
  OWN_E_OP_ID: params.opId,
  OWN_E_EPOCH: params.epoch,
  OWN_E_SOCKDIR: params.socketDir,
  OWN_E_PORT: params.port,
  OWN_E_PORT_MODE: params.portMode,
  OWN_E_ENV_JSON: params.envJson,
  OWN_E_MANAGED: params.managedConfig,
  OWN_E_SHELL_ENV: params.shellEnv,
  OWN_E_PATH_PREPEND: params.pathPrepend,
  OWN_E_KEEP: params.keepInterval ?? 15,
  OWN_E_START: params.start === false ? "0" : "1",
})}
own_main() {
own_prefix=OWN_ENSURE
${helpers}
own_result() { printf 'OWN_ENSURE=%s\\n' "$1"; }
own_write() { # file content: temp -> rename, only when different, 0600
  if [ -f "$1" ] && [ "$(cat "$1" 2>/dev/null)" = "$2" ]; then chmod 600 "$1" 2>/dev/null; return 0; fi
  printf '%s\\n' "$2" > "$1.own-tmp" && chmod 600 "$1.own-tmp" && mv -f "$1.own-tmp" "$1"
}
# 1. host identity: nothing is written when the alias now points at another machine.
own_id=$(own_identity)
own_emit IDENTITY "$own_id"
if [ -n "$OWN_E_IDENTITY" ] && [ "$own_id" != "$OWN_E_IDENTITY" ]; then own_result host_identity_changed; return 0; fi
# 2. owner (04 §6.8)
own_run="$OWN_E_HOME/run"
mkdir -p "$own_run" 2>/dev/null && chmod 700 "$own_run" 2>/dev/null
own_owner=$(own_json_str "$own_run/owner.json" installId)
if [ -n "$own_owner" ] && [ "$own_owner" != "$OWN_E_INSTALL_ID" ]; then
  own_emit OWNER_LABEL "$(own_json_str "$own_run/owner.json" label)"
  own_result other_owner; return 0
fi
[ -n "$own_owner" ] || own_write "$own_run/owner.json" "$OWN_E_OWNER_JSON"
# 3. unfinished operations (04 §6.4); the operation's own ensure carries its opId.
for own_op in "$OWN_E_HOME"/ops/*.json; do
  [ -f "$own_op" ] || continue
  grep -q '"state":"running"' "$own_op" 2>/dev/null || continue
  own_opid=$(own_json_str "$own_op" opId)
  [ -n "\${OWN_E_OP_ID:-}" ] && [ "$own_opid" = "$OWN_E_OP_ID" ] && continue
  own_emit OPS "$own_opid:$(own_json_str "$own_op" kind)"
  own_result ops_pending; return 0
done
# 4. service settings and managed config (04 §5.6). A non-loopback hostname set by the user stops here.
mkdir -p "$OWN_E_CONFIG" "$OWN_E_UPCONFIG" "$OWN_E_HOME/control" "$OWN_E_HOME/tmp" 2>/dev/null
chmod 700 "$OWN_E_HOME/tmp" 2>/dev/null
own_svc="$OWN_E_UPCONFIG/service-own.json"
own_host=$(own_json_str "$own_svc" hostname)
case "\${own_host:-127.0.0.1}" in
  127.0.0.1|::1|\\[::1\\]|localhost) ;;
  *) own_emit HOSTNAME "$own_host"; own_result service_not_loopback; return 0 ;;
esac
own_password=$(own_json_str "$own_svc" password)
[ -n "$own_password" ] || own_password=$(own_json_str "$OWN_E_CONFIG/service-own.json" password)
case "$own_password" in *[!A-Za-z0-9_-]*) own_emit CONFIG password; own_result config_invalid; return 0 ;; esac
own_port=$(own_json_num "$own_svc" port)
if [ "$OWN_E_PORT_MODE" = force ] || [ -z "$own_port" ]; then own_port="$OWN_E_PORT"; fi
own_cfg='{"hostname":"127.0.0.1","port":'"$own_port"
[ -n "$own_password" ] && own_cfg="$own_cfg"',"password":"'"$own_password"'"'
own_cfg="$own_cfg"',"env":'"$OWN_E_ENV_JSON"'}'
own_write "$own_svc" "$own_cfg" || { own_result config_write_failed; return 0; }
own_write "$OWN_E_CONFIG/service-own.json" "$own_cfg" || { own_result config_write_failed; return 0; }
own_write "$OWN_E_CONFIG/opencode.json" "$OWN_E_MANAGED" || { own_result config_write_failed; return 0; }
own_emit PORT "$own_port"
# 5. broker epoch (04 §6.1 step 5): never lower it, never delete this epoch's sockets (broker and Claude egress).
if ! own_safe_dir "$own_run"; then own_emit SOCKDIR unsafe; own_result run_unsafe; return 0; fi
own_cur=$(cat "$own_run/broker.current" 2>/dev/null | tr -cd '0-9')
if [ -n "$own_cur" ] && [ "$own_cur" -gt "$OWN_E_EPOCH" ]; then own_emit STALE_EPOCH "$own_cur"; own_result stale_epoch; return 0; fi
printf '%s\\n' "$OWN_E_EPOCH" > "$own_run/broker.current.tmp" && mv -f "$own_run/broker.current.tmp" "$own_run/broker.current"
for own_dir in "$own_run" "\${OWN_E_SOCKDIR:-}"; do
  [ -n "$own_dir" ] && [ -d "$own_dir" ] || continue
  for own_s in "$own_dir"/broker-*.sock "$own_dir"/egress-*.sock; do
    [ -e "$own_s" ] || continue
    own_e=$(basename "$own_s" .sock | sed 's/^[a-z]*-//' | tr -cd '0-9')
    [ -n "$own_e" ] && [ "$own_e" -lt "$OWN_E_EPOCH" ] && rm -f "$own_s"
  done
done
if [ -n "\${OWN_E_SOCKDIR:-}" ]; then
  if own_safe_dir "$OWN_E_SOCKDIR"; then own_emit SOCKDIR ok; else own_emit SOCKDIR unsafe; fi
fi
own_emit CONTROL_DIR "$OWN_E_HOME/control"
own_emit HOME "$HOME"
# 6. running? (04 §6.1 step 6)
own_reg="$OWN_E_STATE/service-own.json"
own_state=start
if own_rv=$(own_running_version "$own_reg" "$OWN_E_HOME"); then
  if [ "$own_rv" = "$OWN_E_VERSION" ]; then own_state=running; else own_state=skew; fi
elif [ -f "$own_reg" ]; then
  mv -f "$own_reg" "$own_reg.stale" 2>/dev/null
  own_emit STALE_REGISTRATION 1
fi
if [ "$own_state" = start ]; then
  if [ "$OWN_E_START" != 1 ]; then own_result stopped; return 0; fi
  own_app="$OWN_E_HOME/app/$OWN_E_VERSION"
  if [ ! -f "$own_app/.verified" ]; then own_result not_installed; return 0; fi
  OWN_APP="$own_app"; OWN_PATH_PREPEND="$OWN_E_PATH_PREPEND"; export OWN_APP OWN_PATH_PREPEND
  own_log="$own_run/start.log"
  case "$OWN_E_SHELL_ENV" in
    login-interactive) "\${SHELL:-/bin/sh}" -l -i -c 'exec /bin/sh "$OWN_APP/libexec/start.sh"' </dev/null >"$own_log" 2>&1 ;;
    sh) /bin/sh -l -c 'exec /bin/sh "$OWN_APP/libexec/start.sh"' </dev/null >"$own_log" 2>&1 ;;
    *) "\${SHELL:-/bin/sh}" -l -c 'exec /bin/sh "$OWN_APP/libexec/start.sh"' </dev/null >"$own_log" 2>&1 ;;
  esac
  own_emit START_EXIT "$?"
  chmod 600 "$own_log" 2>/dev/null
  if own_rv=$(own_running_version "$own_reg" "$OWN_E_HOME") && [ "$own_rv" = "$OWN_E_VERSION" ]; then own_state=running
  else own_result service_failed; return 0; fi
fi
# 7. registration, once, in upstream's markers (04 §6.1 step 7).
own_url=$(own_json_str "$own_reg" url)
own_emit PID "$(own_json_num "$own_reg" pid)"
own_emit VERSION "$own_rv"
printf 'OPENCODE_SSH_STATUS=%s\\n' "$own_url"
printf 'OPENCODE_SSH_REGISTRATION_BEGIN\\n'
cat "$own_reg"
printf '\\nOPENCODE_SSH_REGISTRATION_END\\n'
if [ "$own_state" = skew ]; then own_emit RUNNING_VERSION "$own_rv"; own_result version_skew
else own_result ready; fi
own_keep
}
# keep (04 §7.4): hold the session until stdin EOF or a newer epoch; remove only this epoch's sockets (the broker's and
# the Claude egress relay's, 04 §8.11.4.2).
own_keep() {
  own_sock=""
  [ -n "\${OWN_E_SOCKDIR:-}" ] && own_sock="$OWN_E_SOCKDIR/broker-$OWN_E_EPOCH.sock"
  own_cleanup() { [ -n "$own_sock" ] && rm -f "$own_sock" "$OWN_E_SOCKDIR/egress-$OWN_E_EPOCH.sock"; }
  trap 'own_cleanup; exit 0' HUP INT TERM
  exec 3<&0
  cat <&3 >/dev/null &
  own_cat=$!
  exec 0</dev/null
  own_tick=0
  while kill -0 "$own_cat" 2>/dev/null; do
    sleep 1
    own_tick=$((own_tick + 1))
    if [ "$own_tick" -ge "$OWN_E_KEEP" ]; then
      own_tick=0
      own_now=$(cat "$OWN_E_HOME/run/broker.current" 2>/dev/null | tr -cd '0-9')
      if [ -n "$own_now" ] && [ "$own_now" != "$OWN_E_EPOCH" ]; then printf 'OWN_KEEP=superseded\\n'; break; fi
    fi
  done
  kill "$own_cat" 2>/dev/null
  own_cleanup
  exit 0
}
own_main
`)
}

// ---------------------------------------------------------------------------------------------------------------
// start.sh (04 §5.2 `libexec/start.sh`, §5.6 env hygiene, §6.1 step 6). Shipped in the bundle; runs after the login
// shell has built the environment. Provider keys are removed here so tools never inherit them.

export const PROVIDER_ENV_EXACT = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const
export const PROVIDER_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENCODE_CLAUDE_AUTH_"] as const
/**
 * OpenTelemetry exporter settings of the login shell (decisions TLM): with OTEL_EXPORTER_OTLP_ENDPOINT set the service
 * sends its logs and traces there, and its children inherit the rest. start.sh removes them as the PC's launcher does.
 */
export const TELEMETRY_ENV_PREFIXES = ["OTEL_"] as const

export function isProviderEnv(name: string) {
  const upper = name.toUpperCase()
  return (
    (PROVIDER_ENV_EXACT as readonly string[]).includes(upper) ||
    PROVIDER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  )
}

export const startScript = lf(`#!/bin/sh
# own-open-code remote service start (04 §5.2, §6.1). Invoked by ensure as
#   "$SHELL" -lc 'exec /bin/sh "$OWN_APP/libexec/start.sh"'
# after the login shell has read the user's profile. Removes provider key variables (04 §5.6) and OpenTelemetry
# exporter settings, prepends OWN_PATH_PREPEND, adds the loopback to NO_PROXY, sets TMPDIR to OWN_HOME/tmp, then execs
# "opencode service start". Host env comes from the service config env.
set -u
for own_name in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do
  case "$own_name" in
    ${PROVIDER_ENV_EXACT.join("|")}) unset "$own_name" ;;
    ${PROVIDER_ENV_PREFIXES.map((prefix) => `${prefix}*`).join("|")}) unset "$own_name" ;;
    ${TELEMETRY_ENV_PREFIXES.map((prefix) => `${prefix}*`).join("|")}) unset "$own_name" ;;
  esac
done
if [ -n "\${OWN_PATH_PREPEND:-}" ]; then PATH="$OWN_PATH_PREPEND:$PATH"; export PATH; fi
# Loopback calls (the Claude relay's stub, the sink, 04 §8.11.14) never go through a user proxy.
own_np="\${NO_PROXY:-\${no_proxy:-}}"
case ",$own_np," in *,127.0.0.1,*) ;; *) own_np="\${own_np:+$own_np,}127.0.0.1" ;; esac
case ",$own_np," in *,localhost,*) ;; *) own_np="$own_np,localhost" ;; esac
NO_PROXY="$own_np"
no_proxy="$own_np"
export NO_PROXY no_proxy
own_app="\${OWN_APP:-$(cd "$(dirname "$0")/.." && pwd)}"
unset OWN_APP OWN_PATH_PREPEND
# Bun extracts its native modules under TMPDIR before the service config env applies: keep them in OWN_HOME/tmp
# (app/<version>/../..), never as /tmp/.bun-<uid>-* files. The service config env names the same directory.
own_tmp="$(cd "$own_app/../.." && pwd)/tmp"
mkdir -p "$own_tmp" 2>/dev/null && chmod 700 "$own_tmp" 2>/dev/null
TMPDIR="$own_tmp"
export TMPDIR
exec "$own_app/opencode" service start
`)

// ---------------------------------------------------------------------------------------------------------------
// ops (04 §6.4, §6.5, §6.7): short sessions of an update, drain or forget. One call runs a list of steps.

export interface OpsParams {
  readonly ownHome: string
  readonly stateDir: string
  readonly dataDir: string
  readonly configDir: string
  readonly upstreamConfigDir: string
  readonly opId: string
  readonly kind: "update" | "drain" | "forget"
  readonly from?: string
  readonly to?: string
  /** Journal JSON written before the steps (`{"opId":…,"state":"running",…}`), or empty. */
  readonly journal?: string
  readonly steps: ReadonlyArray<
    "journal" | "stop" | "backup" | "switch" | "rollback" | "done" | "gc" | "uninstall" | "status"
  >
  /** Short socket directory to remove on uninstall. */
  readonly socketDir?: string
}

export function ops(params: OpsParams) {
  return lf(`set -u
umask 077
${prelude({
  OWN_O_HOME: params.ownHome,
  OWN_O_STATE: params.stateDir,
  OWN_O_DATA: params.dataDir,
  OWN_O_CONFIG: params.configDir,
  OWN_O_UPCONFIG: params.upstreamConfigDir,
  OWN_O_OP: params.opId,
  OWN_O_KIND: params.kind,
  OWN_O_FROM: params.from === undefined ? undefined : RemoteCli.requireVersion(params.from),
  OWN_O_TO: params.to === undefined ? undefined : RemoteCli.requireVersion(params.to),
  OWN_O_JOURNAL: params.journal,
  OWN_O_STEPS: params.steps.join(" "),
  OWN_O_SOCKDIR: params.socketDir,
})}
own_main() {
own_prefix=OWN_OPS
${helpers}
own_step() { printf 'OWN_OPS_STEP=%s:%s\\n' "$1" "$2"; }
# 06 §4.13: before tools/ goes, each repository own.team gave the bundled git-lfs as its LFS filter
# (tools/git-lfs/repos) gets its own filter values back from the own-team-lfs section, or loses own's, so a required
# filter never points at a removed tool. A filter someone changed since is left as it is.
own_lfs_restore() {
  own_list="$OWN_O_HOME/tools/git-lfs/repos"
  [ -f "$own_list" ] || return 0
  while IFS= read -r own_repo || [ -n "$own_repo" ]; do
    [ -n "$own_repo" ] && [ -d "$own_repo" ] || continue
    own_cur=$(git --git-dir="$own_repo" config --local --get filter.lfs.process 2>/dev/null) || own_cur=""
    case "$own_cur" in
      *"$OWN_O_HOME/tools/"*)
        for own_k in process smudge clean required; do
          if own_v=$(git --git-dir="$own_repo" config --local --get "own-team-lfs.$own_k" 2>/dev/null); then
            git --git-dir="$own_repo" config --local "filter.lfs.$own_k" "$own_v" >/dev/null 2>&1
          else
            git --git-dir="$own_repo" config --local --unset-all "filter.lfs.$own_k" >/dev/null 2>&1
          fi
        done ;;
    esac
    git --git-dir="$own_repo" config --local --remove-section own-team-lfs >/dev/null 2>&1
    own_emit LFS_RESTORED "$own_repo"
  done < "$own_list"
}
own_journal() { # state
  [ -n "\${OWN_O_JOURNAL:-}" ] || return 0
  mkdir -p "$OWN_O_HOME/ops" && chmod 700 "$OWN_O_HOME/ops"
  printf '%s\\n' "$OWN_O_JOURNAL" | sed 's/"state":"[a-z_]*"/"state":"'"$1"'"/' > "$OWN_O_HOME/ops/$OWN_O_OP.json.tmp" \\
    && mv -f "$OWN_O_HOME/ops/$OWN_O_OP.json.tmp" "$OWN_O_HOME/ops/$OWN_O_OP.json"
}
own_reg="$OWN_O_STATE/service-own.json"
export XDG_STATE_HOME="$(dirname "$OWN_O_STATE")" XDG_CONFIG_HOME="$(dirname "$OWN_O_UPCONFIG")" XDG_DATA_HOME="$(dirname "$OWN_O_DATA")"
for own_s in $OWN_O_STEPS; do
  case "$own_s" in
    journal) own_journal running && own_step journal ok || { own_step journal fail; exit 0; } ;;
    status)
      if own_rv=$(own_running_version "$own_reg" "$OWN_O_HOME"); then own_emit RUNNING "$own_rv"; own_emit PID "$(own_json_num "$own_reg" pid)"
      else own_emit RUNNING ""; fi
      own_step status ok ;;
    stop)
      own_pid=""
      if own_rv=$(own_running_version "$own_reg" "$OWN_O_HOME"); then
        own_pid=$(own_json_num "$own_reg" pid)
        mkdir -p "$OWN_O_HOME/tmp" 2>/dev/null && chmod 700 "$OWN_O_HOME/tmp" 2>/dev/null
        TMPDIR="$OWN_O_HOME/tmp" "$OWN_O_HOME/app/$own_rv/opencode" service stop </dev/null >/dev/null 2>&1
        own_i=0
        while own_alive "$own_pid" && [ "$own_i" -lt 15 ]; do sleep 1; own_i=$((own_i + 1)); done
      fi
      if [ -n "$own_pid" ] && own_alive "$own_pid" && [ "$(own_exe_of "$own_pid")" = "$(own_physical "$OWN_O_HOME")/app/$own_rv/opencode" ]; then
        own_step stop fail; exit 0
      fi
      own_step stop ok ;;
    backup)
      own_ts=$(date +%Y%m%d%H%M%S)
      mkdir -p "$OWN_O_HOME/backup" && chmod 700 "$OWN_O_HOME/backup"
      own_ok=ok
      for own_f in "$OWN_O_DATA/opencode-own.db" "$OWN_O_DATA/opencode-own.db-wal" "$OWN_O_DATA/opencode-own.db-shm"; do
        [ -f "$own_f" ] || continue
        cp -p "$own_f" "$OWN_O_HOME/backup/$(basename "$own_f").\${OWN_O_FROM:-none}.$own_ts" || own_ok=fail
      done
      own_emit BACKUP "\${OWN_O_FROM:-none}.$own_ts"
      own_step backup "$own_ok"; [ "$own_ok" = ok ] || exit 0 ;;
    switch)
      [ -f "$OWN_O_HOME/app/$OWN_O_TO/.verified" ] || { own_step switch fail; exit 0; }
      if own_set_current "$OWN_O_HOME" "$OWN_O_TO"; then own_step switch ok; else own_step switch fail; exit 0; fi ;;
    rollback)
      if [ -n "\${OWN_O_FROM:-}" ] && [ -f "$OWN_O_HOME/app/$OWN_O_FROM/.verified" ]; then
        own_set_current "$OWN_O_HOME" "$OWN_O_FROM"
      fi
      own_journal rolled_back
      own_step rollback ok ;;
    done) own_journal done; own_step done ok ;;
    gc)
      own_keep_cur=$(readlink "$OWN_O_HOME/app/current" 2>/dev/null)
      for own_d in "$OWN_O_HOME"/app/*/; do
        own_v=$(basename "$own_d")
        case "$own_v" in current|.install-*) continue ;; esac
        [ "$own_v" = "$own_keep_cur" ] && continue
        [ -n "\${OWN_O_FROM:-}" ] && [ "$own_v" = "$OWN_O_FROM" ] && continue
        rm -rf "$OWN_O_HOME/app/$own_v"
      done
      own_step gc ok ;;
    uninstall)
      own_lfs_restore
      rm -rf "$OWN_O_HOME/app" "$OWN_O_HOME/tools" "$OWN_O_HOME/run" "$OWN_O_HOME/tmp" "$OWN_O_HOME/spool" "$OWN_O_HOME/ops" "$OWN_O_HOME/control"
      rm -f "$OWN_O_HOME/accounts.json" "$OWN_O_HOME/policy.json" "$OWN_O_HOME/ratecards.json"
      [ -n "\${OWN_O_SOCKDIR:-}" ] && rm -rf "$OWN_O_SOCKDIR"
      rm -f "$OWN_O_CONFIG/opencode.json" "$OWN_O_CONFIG/service-own.json" "$OWN_O_UPCONFIG/service-own.json"
      own_step uninstall ok ;;
  esac
done
printf 'OWN_OPS=done\\n'
}
own_main
`)
}

/** `mkdir -m 700 -p` of a short socket directory under /tmp that a reboot removed (04 §7.4). */
export function prepareSocketDir(dir: string) {
  return lf(`set -u
umask 077
${prelude({ OWN_S_DIR: dir })}
own_main() {
own_prefix=OWN_SOCKDIR
${helpers}
mkdir -p "$OWN_S_DIR" 2>/dev/null && chmod 700 "$OWN_S_DIR" 2>/dev/null
if own_safe_dir "$OWN_S_DIR"; then printf 'OWN_SOCKDIR=ok\\n'; else printf 'OWN_SOCKDIR=unsafe\\n'; fi
}
own_main
`)
}

// ---------------------------------------------------------------------------------------------------------------
// Parsers

/** `PREFIX_KEY=value` lines of a report, last value wins; other lines are dropped. */
export function parseReport(output: string, prefix: string): Map<string, string> {
  const result = new Map<string, string>()
  const head = `${prefix}_`
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(head)) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    result.set(line.slice(head.length, eq), line.slice(eq + 1))
  }
  return result
}

/** The final `PREFIX=value` line (`OWN_ENSURE=ready`, `OWN_INSTALL=installed`). */
export function parseResult(output: string, prefix: string) {
  return output
    .split(/\r?\n/)
    .findLast((line) => line.startsWith(`${prefix}=`))
    ?.slice(prefix.length + 1)
}

/** `owner.takeover.execute` (04 §6.8): this OWN_HOME becomes the owner of the remote install. */
export function writeOwner(ownHome: string, ownerJson: string) {
  return lf(`set -u
umask 077
${prelude({ OWN_W_HOME: ownHome, OWN_W_OWNER: ownerJson })}
own_main() {
mkdir -p "$OWN_W_HOME/run" && chmod 700 "$OWN_W_HOME/run"
if printf '%s\\n' "$OWN_W_OWNER" > "$OWN_W_HOME/run/owner.json.tmp" && chmod 600 "$OWN_W_HOME/run/owner.json.tmp" &&
  mv -f "$OWN_W_HOME/run/owner.json.tmp" "$OWN_W_HOME/run/owner.json"; then printf 'OWN_OWNER=ok\\n'; else printf 'OWN_OWNER=fail\\n'; fi
}
own_main
`)
}
