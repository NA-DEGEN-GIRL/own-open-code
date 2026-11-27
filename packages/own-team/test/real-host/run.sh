#!/usr/bin/env bash
# Real-host runner for own-team git suites (06 §11.2 실제 호스트). Opt-in: nothing runs unless OWN_REAL_HOST names the
# approved host, and `bun test` in this package never starts it.
#
#   OWN_REAL_HOST=dev-host bash packages/own-team/test/real-host/run.sh test/git/cone.test.ts [more paths...]
#   OWN_REAL_HOST=dev-host bash packages/own-team/test/real-host/run.sh t2
#   OWN_REAL_HOST=dev-host bash packages/own-team/test/real-host/run.sh t3
#
# `t2` names the T2 git suites (06 §11.3 TG5 and TG11 on dev-host, "git 절차"): the git procedures of
# test/e2e/release.e2e.test.ts and test/e2e/integrate.e2e.test.ts (their server parts skip themselves on the host:
# OWN_REAL_HOST_RUN=1 is set there and they load this workspace's packages only off the host) and the git module
# suites they rely on (cone, refs, worktree).
#
# `t3` names the T3 suites of the Linux git procedures (06 §11.3 TG12 "dev-host 일부" and TG18 Linux): removal and
# retire (8.6), split and merge with their undo, conversion, the conversation move, the WIP commit, the shared folders
# (a symlink, `chmod -R a-w`, `rm -rf <name>/` leaves the original) and remote team mode (the bundled git-lfs first on
# own's PATH, lfs-remote) on the platform it is for. These suites import effect and @own/protocol, so they are
# bundled here first (`bun build --target bun`, OWN_REAL_HOST_BUNDLE=1 does the same for given paths) and the host
# gets the bundles only.
#
# Copies src/git, test/fixtures with test/support/remove.ts (repo.ts's teardown), test/e2e/timeouts.ts (the e2e's boot
# limit, which the T2 suites import) and the given paths (relative to packages/own-team; OWN_REAL_HOST_COPY adds more,
# space separated), or the bundles, into a fresh /tmp/own-<uid>-team-<rand> on the host, runs `bun test <paths>` there
# and removes that root on every exit. Unbundled copies run without node_modules, so such a suite may import only
# bun:test, node:*, the copied files and type-only packages (src/git imports nothing else).
#
# Bun on the host: OWN_REAL_HOST_BUN, else bun on PATH, else ~/.bun/bin/bun. A host without any gets a temporary copy
# of the Linux Bun this PC's release build verified (own/.out/remote/native/runtime/bun-linux-<arch>-<this bun's
# version>.tgz, the npm @oven package build-remote.ps1 compared with the GitHub release; OWN_REAL_HOST_BUN_PACKAGE names
# another such .tgz): it is unpacked inside the temp root and goes with it. Nothing is installed.
#
# The approval's conditions, enforced here:
#   - ssh only to the approved alias, BatchMode and StrictHostKeyChecking=yes with UpdateHostKeys=no and no forwards:
#     ~/.ssh is read as the user's ssh does, never written;
#   - on the host, writes only below the temp root: TMPDIR, HOME, the XDG folders and BUN_INSTALL point inside it and
#     Bun's transpiler cache is off (it would otherwise make ~/.bun), git reads an empty global config there
#     (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM), so ~/.gitconfig is neither read nor written; no sudo, no install;
#     folders a suite made read-only (06 §4.11) get their owner's write bit back inside the temp root before it goes;
#   - model traffic: none (git suites only).
#
# Environment: OWN_REAL_HOST (required, = dev-host), OWN_REAL_HOST_SSH (ssh program; default Windows OpenSSH when
# present, else ssh), OWN_REAL_HOST_BUN (bun on the host), OWN_REAL_HOST_BUN_PACKAGE (a Linux Bun npm .tgz for a host
# without bun), OWN_REAL_HOST_BUNDLE (1: bundle the given paths), OWN_REAL_HOST_COPY (extra files or folders),
# OWN_REAL_HOST_TIMEOUT (bun test --timeout, default 900000).
set -euo pipefail

APPROVED="dev-host"
HOST="${OWN_REAL_HOST:-}"

usage() {
  echo "usage: OWN_REAL_HOST=${APPROVED} bash packages/own-team/test/real-host/run.sh <test path>... | t2 | t3" >&2
}

if [ "${HOST}" != "${APPROVED}" ]; then
  echo "real-host: opt-in only; set OWN_REAL_HOST=${APPROVED}" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  usage
  exit 2
fi
T2_SUITES=(
  test/e2e/release.e2e.test.ts
  test/e2e/integrate.e2e.test.ts
  test/git/cone.test.ts
  test/git/refs.test.ts
  test/git/worktree.test.ts
)
T3_SUITES=(
  test/reorg/remove.test.ts
  test/reorg/retire.test.ts
  test/reorg/split.test.ts
  test/reorg/merge.test.ts
  test/reorg/convert.test.ts
  test/reorg/rehome.test.ts
  test/git/wip.test.ts
  test/assets/shared.test.ts
  test/remote/env.test.ts
  test/remote/lfs.test.ts
)
BUNDLE="${OWN_REAL_HOST_BUNDLE:-0}"
if [ "$#" -eq 1 ] && [ "$1" = "t2" ]; then
  set -- "${T2_SUITES[@]}"
elif [ "$#" -eq 1 ] && [ "$1" = "t3" ]; then
  set -- "${T3_SUITES[@]}"
  BUNDLE=1
fi

PACKAGE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO="$(cd "${PACKAGE}/../.." && pwd)"
TESTS=("$@")
# A space separated list, split without glob expansion.
read -r -a EXTRA <<<"${OWN_REAL_HOST_COPY:-}"
if [ "${BUNDLE}" = "1" ]; then
  COPY=("${TESTS[@]}")
else
  COPY=(src/git test/fixtures test/support/remove.ts test/e2e/timeouts.ts "${TESTS[@]}" "${EXTRA[@]}")
fi

for item in "${COPY[@]}"; do
  case "${item}" in
    /* | *..* | -* | *\'* | "")
      echo "real-host: not a package-relative path: ${item}" >&2
      exit 2
      ;;
  esac
  if [ ! -e "${PACKAGE}/${item}" ]; then
    echo "real-host: ${item} does not exist in ${PACKAGE}" >&2
    exit 2
  fi
done

if [ -n "${OWN_REAL_HOST_SSH:-}" ]; then
  SSH="${OWN_REAL_HOST_SSH}"
elif [ -x /c/Windows/System32/OpenSSH/ssh.exe ]; then
  SSH=/c/Windows/System32/OpenSSH/ssh.exe
else
  SSH=ssh
fi
SSH_OPTIONS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UpdateHostKeys=no
  -o ClearAllForwardings=yes
  -o ConnectTimeout=15
  -T
)
TIMEOUT="${OWN_REAL_HOST_TIMEOUT:-900000}"
case "${TIMEOUT}" in
  '' | *[!0-9]*)
    echo "real-host: OWN_REAL_HOST_TIMEOUT must be a number of milliseconds" >&2
    exit 2
    ;;
esac
BUN_ON_HOST="${OWN_REAL_HOST_BUN:-}"
case "${BUN_ON_HOST}" in
  *\'*)
    echo "real-host: OWN_REAL_HOST_BUN must not contain a quote" >&2
    exit 2
    ;;
esac

remote() {
  "${SSH}" "${SSH_OPTIONS[@]}" "${HOST}" "$@"
}

LOCAL="$(mktemp -d)"
ROOT=""
cleanup() {
  rm -rf -- "${LOCAL}"
  [ -n "${ROOT}" ] || return 0
  if remote "chmod -R u+w -- '${ROOT}' 2>/dev/null; rm -rf -- '${ROOT}' && test ! -e '${ROOT}'"; then
    echo "real-host: removed ${HOST}:${ROOT}"
  else
    echo "real-host: could not remove ${HOST}:${ROOT}; remove it by hand" >&2
  fi
}
trap cleanup EXIT

# Bundles: one self-contained file per suite (effect, @own/protocol, src and fixtures inlined; bun:* stay builtins).
SOURCE="${PACKAGE}"
RUN=("${TESTS[@]}")
if [ "${BUNDLE}" = "1" ]; then
  ENTRIES=()
  for item in "${TESTS[@]}"; do ENTRIES+=("${PACKAGE}/${item}"); done
  bun build --target bun --outdir "${LOCAL}/bundle" --root "${PACKAGE}" "${ENTRIES[@]}" >/dev/null
  SOURCE="${LOCAL}/bundle"
  RUN=()
  for item in "${TESTS[@]}"; do RUN+=("${item%.ts}.js"); done
  COPY=("${RUN[@]}")
  for item in "${RUN[@]}"; do
    if [ ! -f "${SOURCE}/${item}" ]; then
      echo "real-host: bundling did not write ${item}" >&2
      exit 3
    fi
  done
fi

PROBE="$(remote 'if command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ]; then echo bun; else echo none; fi; uname -m' | tr -d '\r')"
HOST_BUN="$(printf '%s\n' "${PROBE}" | sed -n 1p)"
HOST_ARCH="$(printf '%s\n' "${PROBE}" | sed -n 2p)"
PACKAGE_TGZ=""
if [ -z "${BUN_ON_HOST}" ] && [ "${HOST_BUN}" != "bun" ]; then
  case "${HOST_ARCH}" in
    x86_64) BUN_TARGET=linux-x64-baseline ;;
    aarch64 | arm64) BUN_TARGET=linux-aarch64 ;;
    *)
      echo "real-host: no bun on the host and no Linux Bun for ${HOST_ARCH} (set OWN_REAL_HOST_BUN)" >&2
      exit 3
      ;;
  esac
  PACKAGE_TGZ="${OWN_REAL_HOST_BUN_PACKAGE:-${REPO}/own/.out/remote/native/runtime/bun-${BUN_TARGET}-$(bun --version | tr -d '\r').tgz}"
  case "${PACKAGE_TGZ}" in
    *.tgz) ;;
    *)
      echo "real-host: OWN_REAL_HOST_BUN_PACKAGE must be an npm .tgz of @oven/bun-linux-*" >&2
      exit 2
      ;;
  esac
  if [ ! -f "${PACKAGE_TGZ}" ]; then
    echo "real-host: no bun on the host and no ${PACKAGE_TGZ} (run own/scripts/build-remote.ps1 once, or set OWN_REAL_HOST_BUN; nothing is installed)" >&2
    exit 3
  fi
fi

ROOT="$(remote 'umask 077 && mktemp -d "/tmp/own-$(id -u)-team-XXXXXXXX"' | tr -d '\r')"
if ! printf '%s' "${ROOT}" | grep -Eq '^/tmp/own-[0-9]+-team-[A-Za-z0-9]{8}$'; then
  echo "real-host: unexpected temp root '${ROOT}'" >&2
  ROOT=""
  exit 3
fi

echo "real-host: ${HOST}:${ROOT} <- ${COPY[*]}"
tar -C "${SOURCE}" -cf - "${COPY[@]}" | remote "tar -xf - -C '${ROOT}'"
if [ -n "${PACKAGE_TGZ}" ]; then
  echo "real-host: ${HOST}:${ROOT}/bun <- $(basename "${PACKAGE_TGZ}") (temporary, removed with the root)"
  remote "mkdir -p '${ROOT}/bun' && tar -xzf - -C '${ROOT}/bun' package/bin/bun && chmod 700 '${ROOT}/bun/package/bin/bun'" <"${PACKAGE_TGZ}"
  BUN_ON_HOST="${ROOT}/bun/package/bin/bun"
fi

QUOTED=""
for item in "${RUN[@]}"; do
  QUOTED="${QUOTED} '${item}'"
done

remote "set -eu
cd '${ROOT}'
mkdir -p tmp home/.cache home/.config home/.local/share home/.local/state
: > gitconfig
printf '%s\n' '{ \"private\": true, \"type\": \"module\" }' > package.json
if [ -n '${BUN_ON_HOST}' ]; then BUN='${BUN_ON_HOST}'
elif command -v bun >/dev/null 2>&1; then BUN=bun
elif [ -x \"\$HOME/.bun/bin/bun\" ]; then BUN=\"\$HOME/.bun/bin/bun\"
else echo 'real-host: no bun on the host (set OWN_REAL_HOST_BUN; nothing is installed)' >&2; exit 3
fi
export TMPDIR='${ROOT}/tmp' GIT_CONFIG_GLOBAL='${ROOT}/gitconfig' GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 OWN_REAL_HOST_RUN=1
# Bun keeps a transpiler cache under \$BUN_INSTALL (default ~/.bun) and the suites resolve defaults from HOME and XDG:
# all of them point inside the root, and the cache is off.
export HOME='${ROOT}/home' BUN_INSTALL='${ROOT}/home/.bun' BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \\
  XDG_CACHE_HOME='${ROOT}/home/.cache' XDG_CONFIG_HOME='${ROOT}/home/.config' \\
  XDG_DATA_HOME='${ROOT}/home/.local/share' XDG_STATE_HOME='${ROOT}/home/.local/state'
git --version
\"\$BUN\" --version
\"\$BUN\" test --timeout ${TIMEOUT}${QUOTED}"
