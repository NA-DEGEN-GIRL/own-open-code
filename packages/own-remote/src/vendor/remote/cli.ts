// Vendored from packages/gui-plugins/src/ssh/remote-cli.ts @ dae4077a96 (MIT). See own/ledger/vendored.yaml
// own: partial copy (04 §4.3). Only `quote`, `requireVersion`, `probeScript` and the `verifyScript` check are kept.
// `installScript`, `archiveUrl`, `latestBeta`, `discoverScript` and every download or installer branch are dropped:
// own installs by upload only (04 §5.5) and never looks for `opencode` on PATH (04 §5.8).
export * as RemoteCli from "./cli.js"

import { Schema } from "effect"

export class Failure extends Schema.TaggedError<Failure>()("RemoteCliFailure", {
  code: Schema.Literals(["platform", "version", "install"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// own: `local` is not accepted. A remote install always carries a release version (`2.0.18-own.3`).
export function requireVersion(version: string) {
  if (!/^[0-9][a-zA-Z0-9.+-]*$/.test(version)) throw new Failure({ code: "version", detail: version })
  return version
}

export const probeScript = `set -eu
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in linux|darwin) ;; *) exit 2 ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) exit 2 ;; esac
target="$os-$arch"
if [ "$arch" = x64 ]; then target="$target-baseline"; fi
if [ "$os" = linux ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then target="$target-musl"; fi
fi
printf 'OPENCODE_REMOTE_TARGET=%s\\n' "$target"
`

// own: exported (upstream keeps it private) so the install script uses the same `--version` check.
export function verifyScript(command: string, version: string) {
  return `test "$(${command} --version | awk '{print $NF}' | sed 's/^v//')" = ${quote(version)}`
}
