export * as Home from "./home.js"

import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const DIR_NAME = "own-open-code"

/**
 * The installed version (01 §5.1): `OWN_HOME\app\current.json` `{schema, version, path, previous, updatedAt,
 * launcher}`, written atomically by the launcher (`own.ps1` Write-VersionPointer) on every install, update and
 * rollback. Readers use `app\<version>` next to the file (`path` is informational, so a moved OWN_HOME keeps
 * working). Installs of launcher 0.3.0 and earlier have an `app\current` junction instead: only its target is read
 * (from the link, never followed), because on some Windows 11 builds files under %LOCALAPPDATA% cannot be opened
 * through a junction although attribute queries succeed.
 */
export interface Installed {
  /** The version folder name (`2.0.18-own.3`); `current` for a plain `app\current` folder. */
  readonly version: string
  /** The version folder: `OWN_HOME\app\<version>`. */
  readonly dir: string
  /** `pointer`: `app\current.json`; `junction`: the target of an older launcher's `app\current`; `folder`: a plain one. */
  readonly source: "pointer" | "junction" | "folder"
  /** What `own rollback` returns to (pointer only). */
  readonly previous?: string
}

/** A version folder name a pointer may name: one path segment, no `..`, not `current`. */
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/

export function isVersionName(name: string) {
  return VERSION_NAME.test(name) && name !== "current" && !name.endsWith(".json")
}

/** `OWN_HOME\app\current.json`. */
export function pointerFile(root: string) {
  return path.join(root, "app", "current.json")
}

/** The installed version of `root`, or `undefined` (synchronous: one small file and a few stats). */
export function installed(root: string): Installed | undefined {
  const app = path.join(root, "app")
  const pointer = readPointer(pointerFile(root))
  if (pointer) {
    const dir = path.join(app, pointer.version)
    if (isFile(path.join(dir, "manifest.json")))
      return { version: pointer.version, dir, source: "pointer", previous: pointer.previous }
  }
  const legacy = path.join(app, "current")
  const link = lstat(legacy)
  if (!link) return undefined
  if (link.isSymbolicLink()) {
    const target = linkTarget(legacy)
    if (!target || !isFile(path.join(target, "manifest.json"))) return undefined
    return { version: path.basename(target), dir: target, source: "junction" }
  }
  if (link.isDirectory() && isFile(path.join(legacy, "manifest.json")))
    return { version: "current", dir: legacy, source: "folder" }
  return undefined
}

function readPointer(file: string): { version: string; previous?: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.version !== "string" || !isVersionName(record.version)) return undefined
  const previous = typeof record.previous === "string" && isVersionName(record.previous) ? record.previous : undefined
  return { version: record.version, previous }
}

/** Where a junction or symbolic link points, read from the link (never followed). */
function linkTarget(link: string) {
  try {
    const target = readlinkSync(link).replace(/^\\\\\?\\|^\\\?\?\\/, "")
    return path.resolve(path.dirname(link), target)
  } catch {
    return undefined
  }
}

function lstat(file: string) {
  try {
    return lstatSync(file)
  } catch {
    return undefined
  }
}

function isFile(file: string) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export interface ResolveInput {
  /** Plugin option `home` (02 §2.3). Wins over everything else. */
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly homedir?: string
}

/**
 * Absolute `OWN_HOME` (02 §2.3, 01 §5.1): the plugin option `home`, then the `OWN_HOME` environment variable (set by
 * the launcher for tests and dev, and also read by `own-vault.exe`), then `%LOCALAPPDATA%\own-open-code` on Windows
 * or `${XDG_DATA_HOME:-~/.local/share}/own-open-code` elsewhere. Empty values count as unset.
 */
export function resolve(input: ResolveInput = {}) {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const api = platform === "win32" ? path.win32 : path.posix
  const explicit = input.home || env.OWN_HOME
  if (explicit) return api.resolve(explicit)
  const home = input.homedir ?? os.homedir()
  if (platform === "win32") return api.join(env.LOCALAPPDATA || api.join(home, "AppData", "Local"), DIR_NAME)
  return api.join(env.XDG_DATA_HOME || api.join(home, ".local", "share"), DIR_NAME)
}

/** Every path under `OWN_HOME` that the runtime and the plugins use (01 §5.1, 02 §2.3). */
export interface Layout {
  readonly root: string
  readonly accounts: string
  readonly policy: string
  readonly ratecards: string
  readonly trust: string
  /** Provider groups' presets and new-session default models (07 §8.1). */
  readonly presets: string
  /** The Codex model metadata own-accounts fetched, one snapshot per kind (07 §4.5); a cache, never hand-edited. */
  readonly codexMeta: string
  /** Claude slot account source `{configDir, setAt}` (02 §2.3, §8.7); read by the launcher on every start. */
  readonly claudeAuth: string
  /** Login folders own made for added Claude accounts, one per account (`<id>`, 02 §8.7); never read by own. */
  readonly claudeAccounts: string
  /**
   * The Claude Agent route's folder (02 §8.10, CAG): `accounts\<id>` is each account's login folder, the
   * `CLAUDE_CONFIG_DIR` own runs Claude Code with; never read by own beyond the credentials file's existence and
   * `.claude.json`'s `oauthAccount`.
   */
  readonly claudeAgent: string
  /** Voice input settings and usage minutes (02 §3.9); its keys are vault items, never in this file. */
  readonly voice: string
  /** The MCP servers own added and the list's kept switches (03 §18.14, SM); their values are in the vault. */
  readonly mcp: string
  /**
   * This PC's records of MCP values the user sent to SSH hosts (04 §13 "MCP", MH): host and server ids and value
   * names only; each copy of the values is a vault item `mcp-send-<id>`.
   */
  readonly mcpHosts: string
  /** The skill switches and scopes (03 §19.6.1, SG): skill ids and folders only, never a skill's content. */
  readonly skillSwitches: string
  /**
   * GitHub accounts and their choices per project and conversation (16 §3, GH): names, logins and folders only; each
   * account's token is a vault item `github-<id>`.
   */
  readonly github: string
  /** 내 브라우저 사용 (BRW): the switch and the `browse` program's path; no secrets. */
  readonly browse: string
  /** 설정 > 업데이트 (05 §20, UPD): the `새 버전 확인` switch and the newest releases as last read; no secrets. */
  readonly toolUpdates: string
  readonly state: string
  readonly limits: string
  /** Session → slot index (`Sessions.Index`). */
  readonly sessions: string
  readonly locks: string
  readonly registryLock: string
  readonly vault: string
  readonly ledger: string
  readonly rollup: string
  readonly control: string
  /** Plugin log files (`own-accounts.log`, 02 §7.2): the service's own stderr is read by nobody once it runs. */
  readonly logs: string
  readonly thirdparty: string
  readonly backup: string
  /**
   * The installed version's folder (`app\<version>` from `app\current.json`, see {@link installed}), resolved when the
   * layout is made; `app\current` when nothing is installed (a path that does not exist, for messages and tests).
   */
  readonly app: string
  /** The installed version, when there is one. */
  readonly installed: Installed | undefined
  /** Default `own-vault.exe` of the installed version. */
  readonly vaultExe: string
  /** Seed copied to `ratecards.json` on first run (02 §2.4.4). */
  readonly ratecardsSeed: string
}

export function layout(root: string): Layout {
  const active = installed(root)
  const app = active?.dir ?? path.join(root, "app", "current")
  return {
    root,
    accounts: path.join(root, "accounts.json"),
    policy: path.join(root, "policy.json"),
    ratecards: path.join(root, "ratecards.json"),
    trust: path.join(root, "trust.json"),
    presets: path.join(root, "presets.json"),
    codexMeta: path.join(root, "codex-meta.json"),
    claudeAuth: path.join(root, "claude-auth.json"),
    claudeAccounts: path.join(root, "claude-accounts"),
    claudeAgent: path.join(root, "claude-agent"),
    voice: path.join(root, "voice.json"),
    mcp: path.join(root, "mcp.json"),
    mcpHosts: path.join(root, "mcp-hosts.json"),
    skillSwitches: path.join(root, "skill-switches.json"),
    github: path.join(root, "github.json"),
    browse: path.join(root, "browse.json"),
    toolUpdates: path.join(root, "tool-updates.json"),
    state: path.join(root, "state"),
    limits: path.join(root, "state", "limits.json"),
    sessions: path.join(root, "state", "sessions.json"),
    locks: path.join(root, "locks"),
    registryLock: path.join(root, "locks", "registry.lock"),
    vault: path.join(root, "vault"),
    ledger: path.join(root, "ledger"),
    rollup: path.join(root, "ledger", "rollup.json"),
    control: path.join(root, "control"),
    logs: path.join(root, "logs"),
    thirdparty: path.join(root, "thirdparty"),
    backup: path.join(root, "backup"),
    app,
    installed: active,
    vaultExe: path.join(app, "own-vault.exe"),
    ratecardsSeed: path.join(app, "templates", "ratecards.default.json"),
  }
}

/**
 * The control Location's project config (`control/opencode.json`): core's hourly housekeeping never evicts it
 * (`experimental.location_idle_timeout: false`, read per Location since upstream v2.1). It holds the process-lifetime
 * work of own's plugins (the SSH controller and its tunnels, the credential broker, the team controller's leader) but
 * no session, so core evicted it 61 minutes after it booted and that work stopped with it (real-host RH-8; core patch
 * P-037 did this until the v2.2.1 sync).
 */
export const CONTROL_CONFIG = `${JSON.stringify({ experimental: { location_idle_timeout: false } }, null, 2)}\n`

/**
 * Creates the directories the runtime writes into and the control Location's config. The vault directory is created by
 * `own-vault.exe` itself.
 */
export async function ensure(paths: Layout) {
  await Promise.all(
    [paths.state, paths.locks, paths.ledger, paths.control].map((dir) => fs.mkdir(dir, { recursive: true })),
  )
  const config = path.join(paths.control, "opencode.json")
  // Written only when it differs, so core's config watch sees no change on every start.
  if ((await fs.readFile(config, "utf8").catch(() => undefined)) !== CONTROL_CONFIG)
    await fs.writeFile(config, CONTROL_CONFIG)
}

/** `YYYY-MM` of an epoch-millisecond time in UTC, the ledger file partition (02 §7.5). */
export function month(ts: number) {
  return new Date(ts).toISOString().slice(0, 7)
}
