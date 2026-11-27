export * as RemoteEnv from "./env.js"

import path from "node:path"
import { Git } from "../git/run.js"

/**
 * Remote team mode (06 §4.13, 04 §5.3): own.team inside the own service of an SSH host. The managed config loads it in
 * full, third like here, with `{mode: "remote", home}` (an absolute OWN_HOME, 04 §5.6), and guard 1 also wants the
 * service env's `OWN_REMOTE=1` (06 §2.6). The team, its main and its owners all live in that service; self-HTTP goes
 * to the host's own service through its registration file (`<XDG_STATE_HOME or ~/.local/state>/opencode/
 * service-own.json`, `ServiceTarget.registrationPath` of the channel `own`).
 *
 * What differs is git-lfs: the host has none, so own-remote uploads a pinned static one to
 * `<OWN_HOME>/tools/git-lfs/<version>/` and points `current` at it (`hosts.tools.ensure`). own's own git calls find
 * `current` first on `PATH` at once ({@link enter}); the shells of the service get it after the restart that
 * `hosts.update{pathPrepend}` asks for (04 §6.4). Checkouts never depend on `PATH`: the `lfs-remote` step names the
 * tool by its absolute path in the repository's local filter (`remote/lfs.ts`).
 */

/** `<OWN_HOME>/tools/git-lfs/current`: the folder of the bundled git-lfs that `current` points at. */
export function tools(home: string) {
  return path.join(home, "tools", "git-lfs", "current")
}

/**
 * `<OWN_HOME>/tools/git-lfs/repos`: the git common dirs whose local LFS filter is the bundled git-lfs, one per line.
 * own-remote's uninstall puts each one's own filter values back (`Lfs.SAVED`) before it removes the tools folder.
 */
export function repos(home: string) {
  return path.join(home, "tools", "git-lfs", "repos")
}

/** Remote mode for this process's git calls (`Git.useTools`); returns the function that leaves it. */
export function enter(home: string) {
  return Git.useTools(tools(home))
}

/** `remote` while a plugin instance of this process is in remote mode (`health.mode`). */
export function mode(): "local" | "remote" {
  return Git.tools() === undefined ? "local" : "remote"
}
