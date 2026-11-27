export * as Agent from "./agent.js"

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Broker } from "./protocol/broker.js"

/**
 * own-remote `mode:"agent"` (04 §3.1): the small remote-side surface. It never opens network connections and never
 * keeps the broker key: `agent.broker.arm` hands the key to the remote broker client (remote `@own/runtime`) and
 * forgets it (04 §8.3).
 */

export interface Context {
  readonly buildId: string
  readonly version: string
  /** Remote OWN_HOME (plugin option `home`). */
  readonly home: string
  readonly env?: NodeJS.ProcessEnv
}

/** The only commands `agent.probe` runs (04 §16.2 "기본 명령 목록 밖의 임의 명령은 받지 않는다"). */
export const PROBE_COMMANDS = ["git", "node", "python3", "rg"] as const

export async function realpath(input: { readonly path: string }) {
  if (!path.posix.isAbsolute(input.path) && !path.isAbsolute(input.path))
    return { realpath: null, isSymlink: false, exists: false }
  const stat = await fs.lstat(input.path).catch(() => undefined)
  if (!stat) return { realpath: null, isSymlink: false, exists: false }
  const resolved = await fs.realpath(input.path).catch(() => null)
  return { realpath: resolved, isSymlink: stat.isSymbolicLink(), exists: true }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export async function status(context: Context) {
  const client = Broker.findRemote(context.buildId)
  const remote = client?.status()
  const owner = await readJson(path.join(context.home, "run", "owner.json"))
  const mirrorFile = await readJson(path.join(context.home, "accounts.json"))
  const mirror = mirrorFile && typeof mirrorFile.mirror === "object" && mirrorFile.mirror !== null
    ? (mirrorFile.mirror as Record<string, unknown>)
    : undefined
  return {
    version: context.version,
    buildId: context.buildId,
    proto: Broker.PROTO,
    mirror: remote?.mirror ?? {
      revision: typeof mirror?.revision === "number" ? mirror.revision : null,
      fetchedAt: typeof mirror?.fetchedAt === "number" ? mirror.fetchedAt : null,
    },
    broker: remote
      ? { state: remote.state, epoch: remote.epoch, leases: remote.leases.map((lease) => ({ ...lease })) }
      : { state: "unavailable" as const, epoch: null, leases: [] },
    spool: remote?.spool ?? { backlog: 0, bytes: 0, gaps: 0 },
    owner: { installId: typeof owner?.installId === "string" ? owner.installId : null },
  }
}

export async function arm(
  context: Context,
  input: {
    readonly hostId: string
    readonly epoch: number
    readonly key: string
    readonly endpoint: { readonly socket: string } | { readonly tcpPort: number }
    /** 04 §8.11.4.2: the Claude egress relay's forward; absent from older PCs. */
    readonly egress?: { readonly socket: string } | { readonly tcpPort: number }
    readonly proto: number
  },
): Promise<{ accepted: boolean; reason?: "stale_epoch" | "key_mismatch" | "proto" | "unavailable" }> {
  if (input.proto !== Broker.PROTO && input.proto !== Broker.PROTO - 1) return { accepted: false, reason: "proto" }
  const key = Buffer.from(input.key, "base64url")
  try {
    if (key.length !== Broker.KEY_BYTES) return { accepted: false, reason: "key_mismatch" }
    if ("socket" in input.endpoint && !path.posix.isAbsolute(input.endpoint.socket))
      return { accepted: false, reason: "unavailable" }
    if (input.egress && "socket" in input.egress && !path.posix.isAbsolute(input.egress.socket))
      return { accepted: false, reason: "unavailable" }
    const client = Broker.findRemote(context.buildId)
    if (!client) return { accepted: false, reason: "unavailable" }
    // The client copies the key into its closure; ours is zeroed right after (04 §8.3).
    const result = await client.arm({
      hostId: input.hostId,
      epoch: input.epoch,
      key: new Uint8Array(key),
      endpoint: input.endpoint,
      ...(input.egress ? { egress: input.egress } : {}),
      proto: input.proto,
    })
    return result.reason ? { accepted: result.accepted, reason: result.reason } : { accepted: result.accepted }
  } finally {
    key.fill(0)
  }
}

/**
 * Tool environment check (04 §6.1 step 9): the same spawn path as the agent shell tool (`$SHELL -c <command>`,
 * `ShellSelect.args`), inheriting the service environment.
 */
export function probe(context: Context, input: { readonly commands?: ReadonlyArray<string> }) {
  const commands = input.commands ?? PROBE_COMMANDS
  if (commands.some((command) => !(PROBE_COMMANDS as readonly string[]).includes(command)))
    return Promise.resolve({ ok: false as const })
  const env = context.env ?? process.env
  const shell = env.SHELL || "/bin/sh"
  const script = [
    `for own_c in ${commands.join(" ")}; do if command -v "$own_c" >/dev/null 2>&1; then echo "OWN_PROBE_FOUND=$own_c"; else echo "OWN_PROBE_MISSING=$own_c"; fi; done`,
    `echo "OWN_PROBE_PATH=$PATH"`,
    `echo "OWN_PROBE_TMPDIR=\${TMPDIR:-}"`,
  ].join("; ")
  return new Promise<{
    ok: true
    output: { shell: string; path: string; found: Record<string, boolean>; tmpdir: string | null; exitCode: number | null }
  }>((resolve) => {
    const child = spawn(shell, ["-c", script], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
    let out = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (text: string) => {
      out = (out + text).slice(-65_536)
    })
    const timer = setTimeout(() => child.kill(), 10_000)
    const finish = (code: number | null) => {
      clearTimeout(timer)
      const found: Record<string, boolean> = {}
      let pathValue = ""
      let tmpdir: string | null = null
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith("OWN_PROBE_FOUND=")) found[line.slice(16)] = true
        else if (line.startsWith("OWN_PROBE_MISSING=")) found[line.slice(18)] = false
        else if (line.startsWith("OWN_PROBE_PATH=")) pathValue = line.slice(15)
        else if (line.startsWith("OWN_PROBE_TMPDIR=")) tmpdir = line.slice(17) || null
      }
      resolve({ ok: true, output: { shell, path: pathValue, found, tmpdir, exitCode: code } })
    }
    child.once("error", () => finish(null))
    child.once("exit", (code) => finish(code))
  })
}
