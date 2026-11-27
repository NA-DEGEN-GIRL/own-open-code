export * as Inventory from "./inventory.js"

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@own/protocol"
import { Build } from "../build.js"
import type { Deps } from "../deps.js"
import { ClaudeBundle } from "./bundle.js"

/**
 * One `ctx.plugin.list()` item of this Location, in activation order (`core/src/plugin.ts` keeps setup order):
 * `{id?, source: builtin | package{target, version?} | local{path} | sdk, features, state}`. A local `path` is the
 * configured target: a plugin directory (upstream v2.2; before, the entry file core imported) or a legacy standalone
 * file. `Trust` resolves a directory to its entry file.
 */
export type Entry = Awaited<ReturnType<Deps["ctx"]["plugin"]["list"]>>["data"][number]

export const ACCOUNTS_ID = Build.PLUGIN_ID
export const TEAM_ID = "own.team"
export const TELEMETRY_ID = "own.telemetry"
/**
 * Directory names of the own plugin bundles (`app\<version>\plugins\<name>`, or `packages\<name>` in a source run), in
 * activation order (own-import after own-computer-use, 09 §5.1; own-harness, 10 H0, then own-omo, 15, and own-creator
 * last, 17). A missing
 * name here makes that plugin untrusted, so every Location loading it is `blocked_by_plugin` (06 §10.4 #3).
 */
export const OWN_PACKAGES = [
  "own-accounts",
  "own-remote",
  "own-team",
  "own-telemetry",
  "own-computer-use",
  "own-import",
  "own-harness",
  "own-omo",
  "own-creator",
] as const

/** This Location's plugins, or `undefined` when the list cannot be read (callers then keep their last state). */
export function read(ctx: Deps["ctx"]) {
  return ctx.plugin.list().then(
    (result): ReadonlyArray<Entry> => result.data,
    () => undefined,
  )
}

export function active(entry: Entry) {
  return entry.state.status === "active"
}

export function localPath(entry: Entry) {
  return entry.source.type === "local" ? entry.source.path : undefined
}

/**
 * The list reflects the generation this instance belongs to: an active `own.accounts` entry exists. During setup the
 * inventory still describes the previous generation (or nothing), so trust decisions wait for `plugin.updated`.
 */
export function current(entries: ReadonlyArray<Entry>) {
  return entries.some((entry) => entry.id === ACCOUNTS_ID && active(entry))
}

/**
 * Whether `file` is `dir` or inside it. Windows paths compare case-insensitively, and links are resolved on both sides
 * where they can be: the host lists a plugin by its real entry path (`app\2.0.18-own.1\plugins\…`). Installs of
 * launcher 0.3.0 configured the bundles through an `app\current` junction (2.0.18-own.1 release smoke: the own
 * plugins were "untrusted" and every turn 401 until this compared real paths); since 0.4.0 the config names the
 * version folder itself and {@link ownRoots} lists version folders, so no comparison depends on following a junction.
 */
export function contains(dir: string, file: string) {
  const relative = path.relative(normalize(dir), normalize(file))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * claude-auth detection (02 §8.4): the plugin id `heymaaz.claude-auth-v2`. A plugin that failed to load is listed
 * without an id, by its configured folder, which is named `claude-auth` (the bundle `app\<version>\plugins\claude-auth`
 * or the former npm install `thirdparty\claude-auth`); an npm spec names the package.
 */
export function isClaude(entry: Entry) {
  if (entry.id === Plugin.CLAUDE_AUTH_ID) return true
  if (entry.source.type === "local")
    return !active(entry) && path.basename(folderOf(entry.source.path)).toLowerCase() === ClaudeBundle.DIR_NAME
  return entry.source.type === "package" && entry.source.target.startsWith(Plugin.CLAUDE_AUTH_PACKAGE)
}

/** The active claude-auth entry of this Location, if any. */
export function claude(entries: ReadonlyArray<Entry>) {
  return entries.find((entry) => active(entry) && isClaude(entry))
}

/** A local plugin's folder: the folder of its entry file (`…\claude-auth\server.js`), or the listed folder itself. */
export function folderOf(file: string) {
  return path.extname(file) ? path.dirname(file) : file
}

/**
 * Position of claude-auth among the active plugins: `[own.accounts, own.remote, own.team, claude-auth, own.telemetry]`
 * (02 §8.2, 06 §2.6). Before own.team, a change of its line reloads own.team and cuts own.team's running git steps.
 */
export function order(entries: ReadonlyArray<Entry>): Plugin.ClaudeAuthOrder {
  const running = entries.filter(active)
  const position = running.findIndex((entry) => isClaude(entry))
  if (position < 0) return "missing"
  const accounts = running.findIndex((entry) => entry.id === ACCOUNTS_ID)
  if (accounts >= 0 && position < accounts) return "before_own_accounts"
  const team = running.findIndex((entry) => entry.id === TEAM_ID)
  if (team >= 0 && position < team) return "before_own_team"
  const telemetry = running.findIndex((entry) => entry.id === TELEMETRY_ID)
  if (telemetry >= 0 && position > telemetry) return "after_own_telemetry"
  return "ok"
}

/** Entry file of an active own plugin, used to find its line in `opencode.jsonc`. */
export function entrypoint(entries: ReadonlyArray<Entry>, id: string) {
  const entry = entries.find((item) => item.id === id && active(item))
  return entry ? localPath(entry) : undefined
}

/** What {@link ownRoots} needs of `Home.layout` (`@own/runtime`). */
export interface AppLayout {
  readonly root: string
  /** The installed version's folder (`app\<version>` from `app\current.json`). */
  readonly app: string
  readonly installed?: { readonly previous?: string }
}

/**
 * Directories whose plugins are ours (02 §4.2 allowlist): `app\<version>\plugins\` of the installed version (from
 * `app\current.json`), of the version it replaced (`previous`: a service of it may still be the one running this
 * plugin), and of the version this bundle itself was loaded from when that is a version folder of the same OWN_HOME
 * (the running service's version, whatever the pointer says); in an unbundled source run also the sibling
 * `packages\own-*` directories of this file. All are folders own.ps1 installs; none is reached through a junction.
 */
export function ownRoots(layout: AppLayout, here = fileURLToPath(import.meta.url)) {
  const appDir = path.join(layout.root, "app")
  const roots = [path.join(layout.app, "plugins")]
  const previous = layout.installed?.previous
  if (previous) roots.push(path.join(appDir, previous, "plugins"))
  if (!here.endsWith(".ts")) {
    // <OWN_HOME>\app\<version>\plugins\own-accounts\index.js
    const plugins = path.dirname(path.dirname(here))
    if (path.basename(plugins).toLowerCase() === "plugins" && samePath(path.dirname(path.dirname(plugins)), appDir))
      roots.push(plugins)
    return unique(roots)
  }
  const packages = path.resolve(path.dirname(here), "..", "..", "..")
  return unique([...roots, ...OWN_PACKAGES.map((name) => path.join(packages, name))])
}

function samePath(a: string, b: string) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function unique(dirs: ReadonlyArray<string>) {
  return dirs.filter((dir, index) => dirs.findIndex((other) => samePath(other, dir)) === index)
}

function normalize(file: string) {
  const resolved = real(path.resolve(file))
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** The real path of `file`, or of its deepest existing ancestor joined with the rest (a plugin that failed to load). */
function real(file: string): string {
  try {
    return fs.realpathSync.native(file)
  } catch {
    const parent = path.dirname(file)
    return parent === file ? file : path.join(real(parent), path.basename(file))
  }
}
