export * as Registry from "./registry.js"

import { randomBytes } from "node:crypto"
import path from "node:path"
import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { Fsx, Lock } from "@own/runtime"

/**
 * Local host registry `OWN_HOME\remote\hosts.json` (04 §2, §16.2). No secrets: the remote service password, server
 * tokens and broker keys live in memory only. Remote paths are the absolute values computed from the inspect report
 * of the chosen shell mode (04 §5.3), so a reconnect (which skips inspect) uses the same paths.
 */

const AccountScope = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("all") }),
  Schema.Struct({ mode: Schema.Literal("only"), ids: Schema.Array(Schema.String) }),
])

export const RemotePaths = Schema.Struct({
  home: Schema.String,
  ownHome: Schema.String,
  /** `${XDG_CONFIG_HOME}/own-open-code` (`OPENCODE_CONFIG_DIR` of the remote service). */
  configDir: Schema.String,
  /** `${XDG_CONFIG_HOME}/opencode` (upstream service config, the env bridge). */
  upstreamConfigDir: Schema.String,
  /** `${XDG_STATE_HOME}/opencode` (registration file). */
  stateDir: Schema.String,
  /** `${XDG_DATA_HOME}/opencode` (remote session DB). */
  dataDir: Schema.String,
  /** Directory of `broker-<epoch>.sock` (04 §7.4): `<ownHome>/run` or a short directory. */
  socketDir: Schema.String,
})
export type RemotePaths = typeof RemotePaths.Type

export const Record = Schema.Struct({
  id: Schema.String,
  alias: Schema.NullOr(Schema.String),
  name: Schema.String,
  target: Schema.String,
  /** Host loopback number k (1–250): API tunnel on 127.0.k.2, dev forwards on 127.0.k.3 (04 §7.3). */
  loopback: Schema.Int,
  localPort: Schema.Int,
  /** Remote service port RP, fixed at the first ensure (04 §5.6). */
  remotePort: Schema.NullOr(Schema.Int),
  autoConnect: Schema.Boolean,
  accounts: AccountScope,
  leaseSeconds: Schema.Int,
  failClosedGraceSeconds: Schema.Int,
  tokenTtlHours: Schema.Int,
  installRoot: Schema.NullOr(Schema.String),
  /** 04 §5.6: `instructions` (hosts added since 2.2.6-own.12) reads the repository's AGENTS.md files only. */
  projectConfig: Schema.Literals(["disabled", "instructions", "trusted"]),
  shellEnv: Schema.Literals(["login", "login-interactive", "sh"]),
  env: Schema.Record(Schema.String, Schema.String),
  pathPrepend: Schema.Array(Schema.String),
  hostIdentity: Schema.NullOr(Schema.String),
  /** Highest epoch used for this host (04 §2 "epoch"). */
  epoch: Schema.Int,
  broker: Schema.Struct({
    mode: Schema.Literals(["socket", "tcp"]),
    /** Last remote TCP port that worked for the TCP fallback (04 §7.4 item 2). */
    tcpPort: Schema.NullOr(Schema.Int),
    /**
     * The Claude egress relay's remote TCP port in the TCP fallback (04 §8.11.4.2): its own random port, never
     * `tcpPort + 1`. Absent from older records.
     */
    egressTcpPort: optional(Schema.NullOr(Schema.Int)),
  }),
  remote: Schema.NullOr(RemotePaths),
  platform: Schema.NullOr(
    Schema.Struct({
      os: Schema.String,
      arch: Schema.String,
      target: Schema.NullOr(Schema.String),
      libc: Schema.NullOr(Schema.String),
    }),
  ),
  warnings: Schema.Array(Schema.String),
  /** Settings changed that need a remote restart (04 §6.4 "설정 대기"). */
  pendingSettings: Schema.Boolean,
  /** Last managed settings applied by an ensure that started the service. */
  appliedSettings: Schema.NullOr(Schema.String),
  recentFolders: Schema.Array(Schema.String),
  /** Last successful `agent.probe` settings hash; a change runs the probe again (04 §6.1 step 9). */
  probedSettings: Schema.NullOr(Schema.String),
  addedAt: Schema.Finite,
})
export type HostRecord = typeof Record.Type

export const File = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** Random id of this OWN_HOME (04 §6.8 `run/owner.json`). */
  installId: Schema.String,
  revision: Schema.Int,
  hosts: Schema.Array(Record),
})
export type HostsFile = typeof File.Type

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(File))

export const DEFAULTS = {
  autoConnect: false,
  accounts: { mode: "all" } as const,
  leaseSeconds: 900,
  failClosedGraceSeconds: 300,
  tokenTtlHours: 12,
  projectConfig: "instructions" as const,
  shellEnv: "login" as const,
}

export function newHostId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  return "h-" + Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("")
}

export function newInstallId() {
  return randomBytes(16).toString("hex")
}

/** Next epoch (04 §2): `max(previous + 1, now in Unix seconds)`, so a fresh OWN_HOME never goes back. */
export function nextEpoch(previous: number, now = Date.now()) {
  return Math.max(previous + 1, Math.floor(now / 1000))
}

export class Store {
  readonly file: string
  readonly #lock: string
  readonly #mutex = new Lock.Mutex()
  #data: HostsFile | undefined

  constructor(input: { readonly dir: string; readonly lockDir: string }) {
    this.file = path.join(input.dir, "hosts.json")
    this.#lock = path.join(input.lockDir, "remote-hosts.lock")
  }

  async load(): Promise<HostsFile> {
    if (this.#data) return this.#data
    const text = await Fsx.readText(this.file)
    if (text === undefined) {
      this.#data = { schemaVersion: 1, installId: newInstallId(), revision: 0, hosts: [] }
      await this.#write(this.#data)
      return this.#data
    }
    this.#data = decode(text)
    return this.#data
  }

  snapshot() {
    if (!this.#data) throw new Error("registry not loaded")
    return this.#data
  }

  get(id: string) {
    return this.snapshot().hosts.find((host) => host.id === id)
  }

  /** Applies `change` to a copy and writes it atomically under the cross-process lock. */
  update(change: (data: HostsFile) => HostsFile): Promise<HostsFile> {
    return this.#mutex.run(() =>
      Lock.withFile(this.#lock, async () => {
        const current = await this.load()
        const next = change(current)
        if (next === current) return current
        const written = { ...next, revision: current.revision + 1 }
        await this.#write(written)
        this.#data = written
        return written
      }),
    )
  }

  patchHost(id: string, patch: Partial<HostRecord> | ((host: HostRecord) => Partial<HostRecord>)) {
    return this.update((data) => {
      const index = data.hosts.findIndex((host) => host.id === id)
      if (index < 0) return data
      const host = data.hosts[index]!
      const next = { ...host, ...(typeof patch === "function" ? patch(host) : patch) }
      return { ...data, hosts: data.hosts.map((item, i) => (i === index ? next : item)) }
    })
  }

  async #write(data: HostsFile) {
    await Fsx.writeAtomic(this.file, JSON.stringify(data, null, 2) + "\n")
  }
}
