export * as Tailscale from "./tailscale.js"

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import type { OwnRemote } from "../protocol/rpc-remote.js"

/**
 * Tailscale detection (05 §13.3 안 A, 03 §21.2): read-only. Finds `tailscale.exe`, runs `tailscale status --json`,
 * `tailscale serve status --json` and `tailscale lock status --json` (all only read state), and turns the result into guidance text. own-open-code
 * never installs Tailscale, never logs in, never runs `tailscale serve` or `funnel`, and never touches the firewall:
 * exposing the gateway is the user's command.
 */

export interface Detection {
  readonly state: OwnRemote.TailscaleView["state"]
  readonly version: string | null
  readonly dnsName: string | null
  /** Proxy targets of `tailscale serve` (`http://127.0.0.1:28539`), `null` when unknown. */
  readonly proxies: ReadonlyArray<string> | null
  /** Raw TCP forwards of `tailscale serve --tcp` (08 §1 tailnet route), `null` when unknown. */
  readonly tcp?: ReadonlyArray<TcpForward> | null
  /** Tailnet Lock (`tailscale lock status --json` `Enabled`), `null` when unknown. */
  readonly lock?: "on" | "off" | null
}

export interface TcpForward {
  readonly port: number
  readonly target: string
}

const MISSING: Detection = { state: "missing", version: null, dnsName: null, proxies: null, tcp: null, lock: null }
const CACHE_MS = 30_000
const TIMEOUT_MS = 4_000

/** Candidate executables: PATH, then the default install folder. */
export function locate(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === "win32" ? ["tailscale.exe"] : ["tailscale"]
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)
  if (process.platform === "win32") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"])
      if (root) dirs.push(path.join(root, "Tailscale"))
  }
  for (const dir of dirs)
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  return undefined
}

export class Detector {
  readonly #command: ReadonlyArray<string> | null | undefined
  #cached: { readonly at: number; readonly value: Detection } | undefined
  #running: Promise<Detection> | undefined

  /** `command`: argv prefix replacing the executable (tests); `null` turns detection off (reported as missing). */
  constructor(command?: ReadonlyArray<string> | null) {
    this.#command = command
  }

  async detect(force = false): Promise<Detection> {
    if (!force && this.#cached && Date.now() - this.#cached.at < CACHE_MS) return this.#cached.value
    this.#running ??= this.#run().finally(() => (this.#running = undefined))
    const value = await this.#running
    this.#cached = { at: Date.now(), value }
    return value
  }

  async #run(): Promise<Detection> {
    if (this.#command === null) return MISSING
    const prefix = this.#command ?? (() => {
      const exe = locate()
      return exe ? [exe] : undefined
    })()
    if (!prefix || prefix.length === 0) return MISSING
    const status = await run([...prefix, "status", "--json"])
    if (status.code === "missing") return MISSING
    const parsed = parseStatus(status.stdout)
    if (!parsed) return { state: "unknown", version: null, dnsName: null, proxies: null, tcp: null, lock: null }
    if (parsed.state !== "running") return { ...parsed, proxies: null, tcp: null, lock: null }
    const [serve, lock] = await Promise.all([
      run([...prefix, "serve", "status", "--json"]),
      run([...prefix, "lock", "status", "--json"]),
    ])
    return {
      ...parsed,
      proxies: serve.code === 0 ? parseServe(serve.stdout) : null,
      tcp: serve.code === 0 ? parseTcp(serve.stdout) : null,
      lock: lock.code === 0 ? parseLock(lock.stdout) : null,
    }
  }
}

export function parseStatus(text: string): Omit<Detection, "proxies"> | undefined {
  try {
    const value = JSON.parse(text) as { BackendState?: unknown; Version?: unknown; Self?: { DNSName?: unknown } }
    const backend = typeof value.BackendState === "string" ? value.BackendState : ""
    const state: Detection["state"] =
      backend === "Running"
        ? "running"
        : backend === "NeedsLogin" || backend === "NeedsMachineAuth" || backend === "NoState"
          ? "logged_out"
          : backend === "Stopped"
            ? "stopped"
            : "unknown"
    const dns = typeof value.Self?.DNSName === "string" ? value.Self.DNSName.replace(/\.$/, "") : ""
    return {
      state,
      version: typeof value.Version === "string" ? value.Version.split("-")[0]! : null,
      dnsName: dns && /^[a-z0-9.-]+$/i.test(dns) ? dns.toLowerCase() : null,
    }
  } catch {
    return undefined
  }
}

/** Proxy targets anywhere in `tailscale serve status --json` (`Web.<host>.Handlers.<path>.Proxy`). */
export function parseServe(text: string): string[] {
  try {
    const found: string[] = []
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (typeof value !== "object" || value === null) return
      for (const [key, item] of Object.entries(value)) {
        if (key === "Proxy" && typeof item === "string") found.push(item)
        else walk(item)
      }
    }
    walk(JSON.parse(text || "{}"))
    return found
  } catch {
    return []
  }
}

/** `TCP.<port>.TCPForward` of `tailscale serve status --json` (raw TCP forwards, 08 §1). */
export function parseTcp(text: string): TcpForward[] {
  const tcp = Option.getOrUndefined(decodeServeStatus(text || "{}"))?.TCP ?? {}
  // Handler by handler: one of another shape never hides the forwards next to it.
  return Object.entries(tcp).flatMap(([port, handler]) => {
    const target = Option.getOrUndefined(decodeForward(handler))?.TCPForward
    return target !== undefined && /^\d+$/.test(port) ? [{ port: Number(port), target }] : []
  })
}

const decodeServeStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ TCP: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })),
)
const decodeForward = Schema.decodeUnknownOption(Schema.Struct({ TCPForward: Schema.String }))

/** `Enabled` of `tailscale lock status --json` (08 §2). */
export function parseLock(text: string): "on" | "off" | null {
  const status = Option.getOrUndefined(decodeLockStatus(text))
  if (!status) return null
  return status.Enabled ? "on" : "off"
}

const decodeLockStatus = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ Enabled: Schema.Boolean })))

/** Raw TCP passthrough to the app listener: Tailscale forwards bytes, the pinned TLS ends at the gateway (08 §1). */
export function tcpServeCommand(appPort: number | null) {
  return appPort === null ? null : `tailscale serve --bg --tcp=${appPort} tcp://localhost:${appPort}`
}

/** Whether a TCP forward on `appPort` targets the app listener on loopback; `null` when unknown. */
export function forwardsApp(detection: Detection, appPort: number | null): boolean | null {
  if (appPort === null || !detection.tcp) return null
  const target = new RegExp(`^(tcp://)?(127\\.0\\.0\\.1|localhost):${appPort}$`)
  return detection.tcp.some((forward) => forward.port === appPort && target.test(forward.target.trim()))
}

/** Guidance for the settings page: `https` on 443 inside the tailnet only (never `funnel`). */
export function serveCommand(port: number | null) {
  return port === null ? null : `tailscale serve --bg --https=443 http://127.0.0.1:${port}`
}

export function view(detection: Detection, port: number | null, appPort: number | null = null): OwnRemote.TailscaleView {
  return {
    lock: detection.lock ?? null,
    appServing: forwardsApp(detection, appPort),
    state: detection.state,
    version: detection.version,
    dnsName: detection.dnsName,
    serving:
      detection.proxies === null || port === null
        ? null
        : detection.proxies.some((proxy) => new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`).test(proxy.trim())),
    serveCommand: serveCommand(port),
  }
}

function run(argv: ReadonlyArray<string>): Promise<{ readonly code: number | "missing"; readonly stdout: string }> {
  return new Promise((resolve) => {
    const [command, ...args] = argv
    if (!command) return resolve({ code: "missing", stdout: "" })
    let stdout = ""
    let settled = false
    const done = (code: number | "missing") => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout })
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
    const timer = setTimeout(() => {
      child.kill()
      done(-1)
    }, TIMEOUT_MS)
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk
    })
    child.on("error", () => done("missing"))
    child.on("close", (code) => done(code ?? -1))
  })
}
