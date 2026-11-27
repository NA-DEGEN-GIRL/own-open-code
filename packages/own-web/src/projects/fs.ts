// Server calls of the project open flow (03 §18.3, 01 §17.1 #3). Browsing lists folders with `fs.list` at the
// **control location** and an absolute `path` (protocol `groups/fs.ts:47-58`): the folder being browsed is never
// used as a location, because a Location loads plugins, MCP servers and a watcher for it (01 G15). Only the folder
// the user finally chooses becomes a Location, through `GET /api/location` (v2 has no "create project" API; the
// first session makes the project). Paths go into query parameters only, where the client's URLSearchParams
// encodes `#`, `%`, spaces and Hangul (tested in projects.test.ts against the real client).
import type { OpenCodeClient } from "@opencode/client"
import type { ServerRuntime } from "@/data"
import { folderNames, samePath } from "./path"

export interface ResolvedProject {
  /** Normalized by the server (drive letter case, separators; 16.3). */
  readonly directory: string
  readonly projectID: string
}

export interface ProjectCheck {
  /** `false`: not a Git repository; `{branch}` otherwise (branch may be missing on a detached HEAD). */
  readonly git: false | { readonly branch?: string }
  /** Unapproved project plugins in that Location (5.7.1); 0 when the router is not there to ask. */
  readonly blockedPlugins: number
}

export async function listFolders(client: OpenCodeClient, control: string, directory: string) {
  const output = await client.file.list({ location: { directory: control }, path: directory })
  return folderNames(output.data)
}

/** Creates (or finds) the Location of the chosen folder. */
export async function resolveProject(client: OpenCodeClient, directory: string): Promise<ResolvedProject> {
  const info = await client.location.get({ location: { directory } })
  return { directory: info.directory, projectID: info.project.id }
}

/**
 * Git state of a Location. A Location that was just loaded answers `{branch: {}}` until its VCS provider has run
 * (`packages/core/src/vcs.ts` refresh); `vcs.branch.updated` follows, so callers ask again on that event.
 */
export async function gitState(runtime: ServerRuntime, directory: string): Promise<ProjectCheck["git"]> {
  const vcs = await runtime
    .client()
    .vcs.get({ location: { directory } })
    .catch(() => undefined)
  return vcs?.data.provider ? { branch: vcs.data.branch.current } : false
}

/** Git state and project plugin approval of a resolved folder, for the confirmation card. */
export async function checkProject(runtime: ServerRuntime, directory: string): Promise<ProjectCheck> {
  const [git, trust] = await Promise.all([
    gitState(runtime, directory),
    runtime.rpc.allowed("plugin.trust.list")
      ? runtime.rpc.call("plugin.trust.list", {}).catch(() => undefined)
      : Promise.resolve(undefined),
  ])
  const location = trust?.locations.find((item) => samePath(item.directory, directory))
  return {
    git,
    blockedPlugins:
      location?.status === "blocked_by_plugin" ? location.plugins.filter((plugin) => !plugin.approved).length : 0,
  }
}

/** The control location of a runtime: the host's, else the one `health` reported (02 §9.1). */
export function controlOf(runtime: ServerRuntime) {
  return runtime.entry()?.controlDir ?? runtime.own.state.health?.controlDir ?? undefined
}
