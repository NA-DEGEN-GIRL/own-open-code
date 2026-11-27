export * as BunCache from "./bun-cache.js"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { OwnTeam } from "@own/protocol"

/**
 * The Bun install cache of the installs own runs (06 §4.12). Bun hard-links packages from its cache into
 * `node_modules`, which works only on one volume: with the cache on C: (`%USERPROFILE%\.bun\install\cache`) and the
 * worktrees on D:, every area copies its whole `node_modules` (2,482 MB, 165,661 files, `[R-map]`). own changes no user
 * or system setting: the setup commands own runs (`setup-run`) and the installs of the verify folder (7.2) get
 * {@link env}, `BUN_INSTALL_CACHE_DIR=<worktreeRoot>/.own-bun-cache`, a cache on the worktrees' volume, so the second
 * area hard-links (TG14). A `bun install` the owner runs itself keeps the user's cache; moving the user's variable is
 * only a tip in `자세히`.
 *
 * `Team.env.bunCache` (the inventory's "Bun 캐시 볼륨", 06 §3.2): `unused` when the home has no Bun lockfile,
 * `same-volume` when the user's cache already shares the worktrees' volume (nothing to add), `other-volume` otherwise.
 * Nothing here writes `process.env` or any user setting.
 */

/** The cache folder under `worktreeRoot`; `clean -fdx` of the verify folder keeps it too (7.2 step 6). */
export const FOLDER = ".own-bun-cache"

/** The variable Bun reads first for its install cache. */
export const VARIABLE = "BUN_INSTALL_CACHE_DIR"

export type Volume = OwnTeam.Team["env"]["bunCache"]

/** Lockfiles that mean the repository installs with Bun. */
const LOCKFILES = ["bun.lock", "bun.lockb"]

/** `<worktreeRoot>/.own-bun-cache`. */
export function folder(worktreeRoot: string) {
  return path.join(worktreeRoot, FOLDER)
}

/**
 * The environment own adds to the installs it runs: only `BUN_INSTALL_CACHE_DIR` and only for `other-volume`, so a
 * caller merges it over the inherited environment of that one process.
 */
export function env(team: Pick<OwnTeam.Team, "worktreeRoot" | "env">): Readonly<Record<string, string>> {
  if (team.env.bunCache !== "other-volume") return {}
  return { [VARIABLE]: folder(team.worktreeRoot) }
}

/** `Team.env.bunCache` for the home and the worktree root, with the environment the user's `bun install` sees. */
export function detect(input: {
  readonly home: string
  readonly worktreeRoot: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): Volume {
  if (!LOCKFILES.some((name) => fs.existsSync(path.join(input.home, name)))) return "unused"
  const cache = userCache(input.home, input.env ?? process.env)
  return volume(cache) === volume(input.worktreeRoot) ? "same-volume" : "other-volume"
}

/**
 * Where a `bun install` in `directory` keeps its cache, in Bun's order: `BUN_INSTALL_CACHE_DIR`, the `install.cache`
 * folder of the project's `bunfig.toml` or else the global one (`$XDG_CONFIG_HOME/.bunfig.toml`, `~/.bunfig.toml`),
 * `$BUN_INSTALL/install/cache`, `$XDG_CACHE_HOME/.bun/install/cache`, then `~/.bun/install/cache`.
 */
export function userCache(directory: string, env: Readonly<Record<string, string | undefined>>) {
  const fromEnv = env[VARIABLE]
  if (fromEnv) return path.resolve(fromEnv)
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) ?? os.homedir()
  const configured = [
    path.join(directory, "bunfig.toml"),
    ...(env.XDG_CONFIG_HOME ? [path.join(env.XDG_CONFIG_HOME, ".bunfig.toml")] : []),
    path.join(home, ".bunfig.toml"),
  ]
    .map((file) => ({ file, dir: bunfigCache(file) }))
    .find((item) => item.dir !== undefined)
  if (configured?.dir !== undefined) return expand(configured.dir, path.dirname(configured.file), home)
  if (env.BUN_INSTALL) return path.join(env.BUN_INSTALL, "install", "cache")
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, ".bun", "install", "cache")
  return path.join(home, ".bun", "install", "cache")
}

/** The volume of a path: the device of its nearest existing folder (the cache or the root may not exist yet). */
export function volume(target: string): number {
  const resolved = path.resolve(target)
  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (stat) return stat.dev
  const parent = path.dirname(resolved)
  return parent === resolved ? -1 : volume(parent)
}

/** `[install.cache] dir = "…"` or `install.cache = "…"` of a bunfig; `undefined` when absent or unreadable. */
function bunfigCache(file: string) {
  if (!fs.existsSync(file)) return undefined
  const parsed = Option.getOrUndefined(decodeBunfig(parseToml(fs.readFileSync(file, "utf8"))))
  const cache = parsed?.install?.cache
  return typeof cache === "string" ? cache : cache?.dir
}

const decodeBunfig = Schema.decodeUnknownOption(
  Schema.Struct({
    install: optional(
      Schema.Struct({
        cache: optional(Schema.Union([Schema.String, Schema.Struct({ dir: optional(Schema.String) })])),
      }),
    ),
  }),
)

/** A bunfig Bun itself cannot read sets nothing here. */
function parseToml(text: string): unknown {
  try {
    return Bun.TOML.parse(text)
  } catch {
    return undefined
  }
}

/** `~/…` from the user folder, a relative folder from the bunfig's folder. */
function expand(dir: string, base: string, home: string) {
  if (dir === "~" || dir.startsWith("~/")) return path.join(home, dir.slice(1))
  return path.resolve(base, dir)
}
