// SEC-1 (04 §15): the remote agent service ignores SIGUSR1, which upstream's `Heap.listen` (packages/cli/src/heap.ts)
// answers with a V8 heap snapshot in the log folder.
// - any platform: the listener swap and the debug escape hatch;
// - POSIX: a real SIGUSR1 to a child that listens like upstream;
// - opt-in G14 step on the approved host (`OWN_REAL_HOST=dev-host`, 04 §15 G14): the release CLI with this source's
//   plugin in agent mode, `kill -USR1`, no new heap file (and one with `OWN_REMOTE_ALLOW_HEAP_SIGNAL=1`).
import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { muteHeapSignal } from "../../src/index.js"
import { shortArgs } from "../../src/vendor/ssh/command.js"
import {
  APP,
  APPROVED,
  evidence,
  heavyHost,
  hostSh,
  KNOWN_HOSTS_COPY,
  kv,
  prepareSshFiles,
  SSH,
  SSH_CONFIG,
} from "../real-host/env.js"

const ENTRY = path.resolve(import.meta.dir, "../../src/index.ts")
const upstream = process.listeners("SIGUSR1")

afterEach(() => {
  process.removeAllListeners("SIGUSR1")
  for (const listener of upstream) process.on("SIGUSR1", listener)
})

describe("muteHeapSignal (agent mode)", () => {
  test("every SIGUSR1 listener gives way to one no-op, again when setup runs for another Location", () => {
    const snapshots: number[] = []
    process.on("SIGUSR1", () => snapshots.push(Date.now()))
    muteHeapSignal("linux", {})
    muteHeapSignal("linux", {})
    expect(process.listenerCount("SIGUSR1")).toBe(1)
    process.emit("SIGUSR1", "SIGUSR1")
    expect(snapshots).toEqual([])
  })

  test("OWN_REMOTE_ALLOW_HEAP_SIGNAL=1 keeps upstream's listener; Windows has no SIGUSR1 to replace", () => {
    const snapshot = () => {}
    process.on("SIGUSR1", snapshot)
    muteHeapSignal("linux", { OWN_REMOTE_ALLOW_HEAP_SIGNAL: "1" })
    muteHeapSignal("win32", {})
    expect(process.listeners("SIGUSR1")).toEqual([snapshot])
  })
})

describe.skipIf(process.platform === "win32")("a real SIGUSR1 (POSIX)", () => {
  test("a listener that writes snapshots like upstream never runs, and the process lives on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-heap-signal-"))
    try {
      const probe = path.join(dir, "probe.ts")
      fs.writeFileSync(
        probe,
        [
          `import { writeHeapSnapshot } from "node:v8"`,
          `import { muteHeapSignal } from ${JSON.stringify(pathToFileURL(ENTRY).href)}`,
          `process.on("SIGUSR1", () => writeHeapSnapshot(${JSON.stringify(dir)} + "/heap-" + process.pid + ".heapsnapshot"))`,
          `muteHeapSignal()`,
          `process.kill(process.pid, "SIGUSR1")`,
          `await Bun.sleep(1000)`,
          `console.log("ALIVE")`,
        ].join("\n"),
      )
      const run = async (allow: boolean) => {
        const child = Bun.spawn([process.execPath, probe], {
          env: { PATH: process.env.PATH ?? "", ...(allow ? { OWN_REMOTE_ALLOW_HEAP_SIGNAL: "1" } : {}) },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
        const heaps = fs.readdirSync(dir).filter((name) => name.endsWith(".heapsnapshot"))
        heaps.forEach((name) => fs.rmSync(path.join(dir, name)))
        return { code, alive: stdout.includes("ALIVE"), heaps: heaps.length }
      }
      expect(await run(false)).toEqual({ code: 0, alive: true, heaps: 0 })
      expect(await run(true)).toEqual({ code: 0, alive: true, heaps: 1 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe.skipIf(!heavyHost)(`real host ${APPROVED}: G14 heap snapshot signal`, () => {
  // The release's Linux CLI (upstream `Heap.listen` included) runs `serve` with isolated XDG roots under
  // /tmp/own-<uid>/heap-signal and this source's own-remote bundle in agent mode; everything is removed afterwards.
  test("kill -USR1 on the agent-mode service writes no heap file; the debug escape hatch still does", async () => {
    const tarball = path.join(APP, "remote", "linux-x64-baseline.tar.gz")
    if (!fs.existsSync(tarball))
      throw new Error(`${tarball} missing: set OWN_REAL_HOST_VERSION to a build with remote artifacts`)
    prepareSshFiles()
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "own-heap-signal-"))
    const prepared = kv(
      (
        await hostSh(String.raw`set -u
base="/tmp/own-$(id -u)"
echo "FRESH=$([ -e "$base" ] && echo 0 || echo 1)"
mkdir -p "$base/heap-signal/plugins/own-remote" && chmod 700 "$base" "$base/heap-signal"
echo "ROOT=$base/heap-signal"`)
      ).stdout,
    )
    const root = prepared.get("ROOT") ?? ""
    // The cleanup below runs `rm -rf` on it.
    if (!/^\/tmp\/own-\d+\/heap-signal$/.test(root)) throw new Error(`unexpected remote root: ${root}`)
    try {
      const built = await Bun.build({
        entrypoints: [ENTRY],
        outdir: local,
        naming: "index.js",
        target: "bun",
        format: "esm",
        minify: true,
      })
      expect(built.success).toBe(true)
      await upload(path.join(local, "index.js"), `${root}/plugins/own-remote/index.js`)
      await upload(tarball, `${root}/remote.tar.gz`)
      const result = await hostSh(RUN_SCRIPT.replace("@ROOT@", root), 600_000)
      evidence("g14-heap-signal.txt", result.stdout + result.stderr)
      const facts = kv(result.stdout)
      expect(facts.get("MUTE_STATUS")).toBe("200")
      expect(facts.get("MUTE_ALIVE")).toBe("1")
      expect(facts.get("MUTE_HEAP")).toBe("0")
      expect(facts.get("ALLOW_STATUS")).toBe("200")
      expect(Number(facts.get("ALLOW_HEAP"))).toBeGreaterThan(0)
    } finally {
      const removed = kv(
        (
          await hostSh(String.raw`set -u
for pid in $(ps -u "$(id -u)" -o pid=); do
  case "$(readlink "/proc/$pid/exe" 2>/dev/null)" in "${root}/opencode"*) kill -KILL "$pid" ;; esac
done
rm -rf "${root}"
[ "${prepared.get("FRESH")}" = 1 ] && rmdir "$(dirname "${root}")" 2>/dev/null
echo "LEFT=$([ -e "${root}" ] && echo 1 || echo 0)"`)
        ).stdout,
      )
      fs.rmSync(local, { recursive: true, force: true })
      expect(removed.get("LEFT")).toBe("0")
    }
  }, 1_800_000)
})

/** Streams a local file to a path on the approved host (`cat >`), trusted by the user's known_hosts copy. */
function upload(file: string, remote: string) {
  const target = {
    host: APPROVED,
    args: ["-o", `UserKnownHostsFile=${KNOWN_HOSTS_COPY}`, "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes"],
  }
  const child = spawn(SSH, ["-F", SSH_CONFIG, ...shortArgs(target), APPROVED, `cat > '${remote}'`], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"],
  })
  const stderr: string[] = []
  child.stderr.setEncoding("utf8").on("data", (text: string) => stderr.push(text))
  fs.createReadStream(file).pipe(child.stdin)
  return new Promise<void>((resolve, reject) =>
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`upload ${path.basename(file)}: ssh ${code} ${stderr.join("")}`)),
    ),
  )
}

/**
 * Two isolated `serve` runs of the release CLI with own-remote in agent mode (`OWN_REMOTE=1`): `agent.status` makes the
 * plugin load, then SIGUSR1. `MUTE_*` is the default, `ALLOW_*` the debug escape hatch (upstream's snapshot).
 */
const RUN_SCRIPT = String.raw`set -u
root="@ROOT@"
cd "$root" || exit 1
tar -xzf remote.tar.gz opencode && rm -f remote.tar.gz && chmod 700 opencode || exit 1
own_run() { # label, allow
  dir="$root/$1"
  mkdir -p "$dir/config" "$dir/work" "$dir/tmp"
  printf '{"update":"disable","share":"disabled","plugins":[{"package":"%s","options":{"mode":"agent","home":"%s"}}]}\n' \
    "$root/plugins/own-remote" "$dir/own-home" > "$dir/config/opencode.json"
  env -i PATH=/usr/bin:/bin HOME="$dir/home" TMPDIR="$dir/tmp" XDG_DATA_HOME="$dir/data" XDG_STATE_HOME="$dir/state" \
    XDG_CONFIG_HOME="$dir/xdg-config" XDG_CACHE_HOME="$dir/cache" OPENCODE_CONFIG_DIR="$dir/config" \
    OPENCODE_PASSWORD=heap-signal OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_FILEWATCHER=true \
    OPENCODE_DISABLE_PROJECT_CONFIG=true OWN_REMOTE=1 ${"$"}{2:+OWN_REMOTE_ALLOW_HEAP_SIGNAL=$2} \
    "$root/opencode" serve --hostname 127.0.0.1 --port 0 > "$dir/out.log" 2>&1 &
  pid=$!
  url=""; i=0
  while [ -z "$url" ] && [ "$i" -lt 240 ]; do
    sleep 0.5; i=$((i + 1))
    url=$(sed -n 's/.*server listening on \(http:[^ ]*\).*/\1/p' "$dir/out.log" | head -n 1)
  done
  status=""; i=0
  while [ -n "$url" ] && [ "$status" != 200 ] && [ "$i" -lt 60 ]; do
    status=$(curl -s -o /dev/null -w '%{http_code}' -u opencode:heap-signal -H 'content-type: application/json' \
      -d '{"input":{}}' "$url/api/rpc/own.remote/agent.status?location%5Bdirectory%5D=$dir/work")
    [ "$status" = 200 ] || sleep 0.5
    i=$((i + 1))
  done
  kill -USR1 "$pid" 2>/dev/null
  i=0
  while [ "$i" -lt 20 ] && [ -z "$(find "$dir" -name '*.heapsnapshot' 2>/dev/null)" ]; do sleep 0.5; i=$((i + 1)); done
  label=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  echo "${"$"}{label}_STATUS=$status"
  echo "${"$"}{label}_HEAP=$(find "$dir" -name '*.heapsnapshot' | wc -l)"
  echo "${"$"}{label}_ALIVE=$(kill -0 "$pid" 2>/dev/null && echo 1 || echo 0)"
  kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  grep -iE 'error|heap' "$dir/out.log" | head -n 5 | cut -c1-300
}
own_run mute ""
own_run allow 1
`
