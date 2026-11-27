export * as PortProxy from "./portproxy.js"

import { spawn } from "node:child_process"

/**
 * The direct (DDNS) route to the app listener (08 §1): a Windows `netsh interface portproxy` rule the user adds in an
 * admin PowerShell, so own-open-code itself never listens beyond loopback (MG1) and no firewall prompt names
 * `opencode.exe`. Detection only reads `netsh interface portproxy show v4tov4` (no admin needed); setting up and
 * removing the rule, the firewall rule and the router forward are the user's commands.
 */

export interface Rule {
  readonly listenAddress: string
  readonly listenPort: number
  readonly connectAddress: string
  readonly connectPort: number
}

const CACHE_MS = 30_000
const TIMEOUT_MS = 4_000

/** Data rows of `show v4tov4` (`0.0.0.0  28541  127.0.0.1  28540`); localized headers are skipped. */
export function parse(text: string): Rule[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line)
    return match
      ? [{ listenAddress: match[1]!, listenPort: Number(match[2]), connectAddress: match[3]!, connectPort: Number(match[4]) }]
      : []
  })
}

/** Whether a rule forwards `directPort` (on every address or a specific one) to the app listener. */
export function forwards(rules: ReadonlyArray<Rule>, directPort: number, appPort: number) {
  return rules.some(
    (rule) =>
      rule.listenPort === directPort &&
      rule.connectPort === appPort &&
      (rule.connectAddress === "127.0.0.1" || rule.connectAddress.toLowerCase() === "localhost"),
  )
}

export function firewallRuleName(directPort: number) {
  return `Own OpenCode app access (TCP ${directPort})`
}

/** Admin PowerShell commands for the settings page (08 §3.8). The firewall rule opens the port on private networks only. */
export function setupCommands(directPort: number, appPort: number) {
  return [
    `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${directPort} connectaddress=127.0.0.1 connectport=${appPort}`,
    `New-NetFirewallRule -DisplayName "${firewallRuleName(directPort)}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${directPort} -Profile Private`,
  ]
}

export function removeCommands(directPort: number) {
  return [
    `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${directPort}`,
    `Remove-NetFirewallRule -DisplayName "${firewallRuleName(directPort)}"`,
  ]
}

export class Detector {
  readonly #command: ReadonlyArray<string> | null | undefined
  #cached: { readonly at: number; readonly value: ReadonlyArray<Rule> | null } | undefined
  #running: Promise<ReadonlyArray<Rule> | null> | undefined

  /** `command`: argv replacing `netsh interface portproxy show v4tov4` (tests); `null` turns detection off. */
  constructor(command?: ReadonlyArray<string> | null) {
    this.#command = command
  }

  /** The rules, or `null` when they could not be read (not Windows, netsh missing). */
  async rules(force = false): Promise<ReadonlyArray<Rule> | null> {
    if (!force && this.#cached && Date.now() - this.#cached.at < CACHE_MS) return this.#cached.value
    this.#running ??= this.#run().finally(() => (this.#running = undefined))
    const value = await this.#running
    this.#cached = { at: Date.now(), value }
    return value
  }

  async #run(): Promise<ReadonlyArray<Rule> | null> {
    if (this.#command === null) return null
    const argv = this.#command ?? (process.platform === "win32" ? ["netsh", "interface", "portproxy", "show", "v4tov4"] : null)
    if (!argv) return null
    const result = await run(argv)
    return result.code === 0 ? parse(result.stdout) : null
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
      if (stdout.length < 100_000) stdout += chunk
    })
    child.on("error", () => done("missing"))
    child.on("close", (code) => done(code ?? -1))
  })
}
