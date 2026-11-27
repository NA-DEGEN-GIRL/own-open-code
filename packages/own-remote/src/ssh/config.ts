export * as SshConfig from "./config.js"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * `~/.ssh/config` read as a file only (04 §7.5 "호스트를 나열하거나 보여 주기만 하려고 명령을 실행하지 않는다").
 * This is an approximation for display: wildcard `Host` patterns and `Match` blocks are not resolved, they only
 * turn a "no forward" answer into "maybe". The real decision before a tunnel uses `ssh -G` ({@link parseResolved}).
 */

export interface Block {
  readonly patterns: ReadonlyArray<string>
  readonly match: boolean
  readonly entries: ReadonlyArray<readonly [key: string, value: string]>
  readonly file: string
}

export interface AliasInfo {
  readonly alias: string
  readonly wildcard: boolean
  readonly forwards: "none" | "maybe" | "yes"
  readonly looseHostKey: boolean
  readonly localhostForward: boolean
  /** Other aliases on the same `Host` line (04 §19.1 `build-host dev-host`). */
  readonly siblings: ReadonlyArray<string>
}

const FORWARD_KEYS = new Set(["localforward", "remoteforward", "dynamicforward"])

/** Parses a config file and its `Include`s (at most 100 files, no recursion loops), like upstream `sshHosts`. */
export async function read(file = path.join(os.homedir(), ".ssh", "config"), seen = new Set<string>()) {
  const blocks: Block[] = []
  if (seen.has(file) || seen.size >= 100) return blocks
  seen.add(file)
  const text = await fs.readFile(file, "utf8").catch(() => "")
  let current: { patterns: string[]; match: boolean; entries: Array<[string, string]> } = {
    patterns: ["*"],
    match: false,
    entries: [],
  }
  const flush = () => {
    if (current.entries.length > 0 || current.patterns[0] !== "*")
      blocks.push({ patterns: current.patterns, match: current.match, entries: current.entries, file })
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+#.*$/, "")
    if (!line || line.startsWith("#")) continue
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const value = (match[2] ?? "").trim()
    if (key === "host") {
      flush()
      current = { patterns: value.split(/\s+/).filter(Boolean), match: false, entries: [] }
      continue
    }
    if (key === "match") {
      flush()
      current = { patterns: [], match: true, entries: [] }
      continue
    }
    if (key === "include") {
      for (const include of value.split(/\s+/).filter(Boolean)) {
        const pattern = include.startsWith("~/")
          ? path.join(os.homedir(), include.slice(2))
          : path.resolve(path.dirname(file), include)
        const dir = path.dirname(pattern)
        const regex = new RegExp(
          "^" +
            path
              .basename(pattern)
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replaceAll("*", ".*")
              .replaceAll("?", ".") +
            "$",
        )
        const names = await fs.readdir(dir).catch(() => [] as string[])
        for (const name of names.filter((item) => regex.test(item)).sort())
          blocks.push(...(await read(path.join(dir, name), seen)))
      }
      continue
    }
    current.entries.push([key, value])
  }
  flush()
  return blocks
}

function wildcard(pattern: string) {
  return /[!*?]/.test(pattern)
}

/** Aliases for `hosts.discover` (no wildcard patterns), with the display-only forward and host key flags. */
export function aliases(blocks: ReadonlyArray<Block>): AliasInfo[] {
  const result = new Map<string, AliasInfo>()
  const dynamic = blocks.some(
    (block) => (block.match || block.patterns.some(wildcard)) && block.entries.some(([key]) => FORWARD_KEYS.has(key)),
  )
  for (const block of blocks) {
    if (block.match) continue
    for (const alias of block.patterns.filter((pattern) => !wildcard(pattern))) {
      if (result.has(alias)) continue
      const entries = entriesFor(blocks, alias)
      const forwards = entries.some(([key]) => FORWARD_KEYS.has(key)) ? "yes" : dynamic ? "maybe" : "none"
      result.set(alias, {
        alias,
        wildcard: false,
        forwards,
        looseHostKey: loose(entries),
        localhostForward: entries.some(([key, value]) => key === "localforward" && localhostBind(value)),
        siblings: block.patterns.filter((item) => item !== alias && !wildcard(item)),
      })
    }
  }
  return [...result.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

/**
 * Entries that apply to `alias` in file order, first value wins per key like ssh (except multi-valued forward
 * keys). Blocks with wildcards are matched with ssh's `*`/`?`/`!` rules; `Match` blocks are skipped.
 */
export function entriesFor(blocks: ReadonlyArray<Block>, alias: string) {
  const result: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const block of blocks) {
    if (block.match || !matches(block.patterns, alias)) continue
    for (const [key, value] of block.entries) {
      if (FORWARD_KEYS.has(key) || key === "identityfile") {
        result.push([key, value])
        continue
      }
      if (seen.has(key)) continue
      seen.add(key)
      result.push([key, value])
    }
  }
  return result
}

function matches(patterns: ReadonlyArray<string>, alias: string) {
  let positive = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!")
    const body = negated ? pattern.slice(1) : pattern
    const regex = new RegExp(
      "^" +
        body
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".") +
        "$",
      "i",
    )
    if (!regex.test(alias)) continue
    if (negated) return false
    positive = true
  }
  return positive
}

function loose(entries: ReadonlyArray<readonly [string, string]>) {
  return entries.some(
    ([key, value]) =>
      (key === "stricthostkeychecking" && /^(no|off)$/i.test(value)) ||
      (key === "userknownhostsfile" && /(^|\s)\/dev\/null(\s|$)/i.test(value)),
  )
}

/** A `LocalForward` whose listen side is 127.0.0.1, localhost or unspecified (04 §19.1 `lab-7676` warning). */
export function localhostBind(value: string) {
  const listen = value.trim().split(/\s+/)[0] ?? ""
  if (/^\d+$/.test(listen)) return true
  const host = listen.startsWith("[") ? listen.slice(1, listen.indexOf("]")) : listen.slice(0, listen.lastIndexOf(":"))
  return host === "" || host === "*" || host === "127.0.0.1" || host.toLowerCase() === "localhost"
}

/** `hosts.detail` from the file (source `file`): the approximate destination and the key names only. */
export function detail(blocks: ReadonlyArray<Block>, alias: string) {
  const entries = entriesFor(blocks, alias)
  const value = (key: string) => entries.find(([name]) => name === key)?.[1]
  const hostname = value("hostname") ?? alias
  const user = value("user")
  return {
    destination: `${user ? `${user}@` : ""}${hostname}:${value("port") ?? "22"}`,
    configKeys: [...new Set(entries.map(([key]) => key))],
    forwards: entries.filter(([key]) => FORWARD_KEYS.has(key)).map(([key, item]) => `${key} ${item}`),
  }
}

export interface Resolved {
  readonly destination: string | null
  readonly forwards: ReadonlyArray<string>
  readonly forwardKinds: ReadonlyArray<"localforward" | "remoteforward" | "dynamicforward">
  readonly strictHostKeyChecking: string | null
  readonly userKnownHostsFile: string | null
  readonly keys: ReadonlyArray<string>
}

/**
 * `ssh -G <alias>` output (04 §7.5): ssh's own resolution of Host patterns, negation, Include, first-value-wins and
 * Match. Forwards found here stop the tunnel with `forward_conflict`.
 */
export function parseResolved(output: string): Resolved {
  const fields: Array<[string, string]> = []
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(" ")
    if (separator <= 0) continue
    fields.push([line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()])
  }
  const value = (key: string) => fields.find(([name]) => name === key)?.[1] ?? null
  const forwards = fields.filter(([key]) => FORWARD_KEYS.has(key))
  const hostname = value("hostname")
  const user = value("user")
  return {
    destination: hostname ? `${user ? `${user}@` : ""}${hostname}:${value("port") ?? "22"}` : null,
    forwards: forwards.map(([key, item]) => `${key} ${item}`),
    forwardKinds: [...new Set(forwards.map(([key]) => key as Resolved["forwardKinds"][number]))],
    strictHostKeyChecking: value("stricthostkeychecking"),
    userKnownHostsFile: value("userknownhostsfile"),
    keys: [...new Set(fields.map(([key]) => key))],
  }
}

/** Loose host key settings in the resolved config (04 §7.2): warn, and give the host no broker account by default. */
export function looseResolved(resolved: Resolved) {
  return (
    /^(no|off)$/i.test(resolved.strictHostKeyChecking ?? "") ||
    /(^|\s)\/dev\/null(\s|$)/i.test(resolved.userKnownHostsFile ?? "")
  )
}
