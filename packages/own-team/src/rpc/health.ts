export * as HealthRpc from "./health.js"

import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/schema/rpc"
import { OwnTeam, Portable } from "@own/protocol"
import { Build } from "../build.js"
import { Cone } from "../git/cone.js"
import { Identity } from "../git/identity.js"
import { Git } from "../git/run.js"
import { GitVersion } from "../git/version.js"
import { Worktree } from "../git/worktree.js"
import { RemoteEnv } from "../remote/env.js"
import type { Services } from "../services.js"
import { Log } from "../log.js"
import type { TeamRpc } from "./handlers.js"

/**
 * `health` (guard 1, build id, mode, Git and git-lfs, leadership, features) and `diagnostics` (자세히: what own sees,
 * never secrets). When guard 1 fails the plugin registers `health` only (`registerOnly`). A remote service answers
 * `mode: "remote"` with the same features; its git-lfs is the bundled one once uploaded (06 §4.13).
 */

export type Methods = "health" | "diagnostics"

export const FEATURES: ReadonlyArray<OwnTeam.Feature> = ["diagnostics"]

export interface Guard {
  readonly guard: OwnTeam.Guard
  /** Why the guard failed (logged). No secrets. */
  readonly reason?: string
}

/**
 * Guard 1 (01 §5.4, fail closed, like the other own plugins): the launcher's marker `OWN_OPEN_CODE=1` and the app
 * version this bundle was built for; `mode: "remote"` also needs `OWN_REMOTE=1` (04 §9.1).
 */
export function guard(input: {
  readonly appVersion: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly mode: "local" | "remote"
  readonly expectedVersion?: string
}): Guard {
  const expected = input.expectedVersion ?? Build.EXPECTED_APP_VERSION
  if (input.appVersion !== expected)
    return { guard: "skew", reason: `app version ${input.appVersion} does not match build ${expected}` }
  if (input.env[Build.ENV_MARKER] !== "1") return { guard: "unmanaged", reason: `${Build.ENV_MARKER}=1 is not set` }
  if (input.mode === "remote" && input.env[Build.ENV_REMOTE] !== "1")
    return { guard: "unmanaged", reason: `${Build.ENV_REMOTE}=1 is not set (mode remote)` }
  return { guard: "ok" }
}

export function handlers(deps: {
  readonly services: Services.Context
  readonly leader: () => boolean
  readonly features: ReadonlyArray<OwnTeam.Feature>
}): TeamRpc.Group<Methods> {
  return {
    health: async () => {
      const probe = await GitVersion.probe()
      const intake = deps.services.status.intake()
      return {
        version: Build.PLUGIN_VERSION,
        buildId: deps.services.buildId,
        guard: "ok" as const,
        mode: RemoteEnv.mode(),
        git: probe.git,
        lfs: probe.lfs,
        leader: deps.leader(),
        features: deps.features,
        // RH-20: the controller lock and this process's event streams.
        controller: deps.services.status.controller(),
        ...(intake === undefined ? {} : { intake }),
      }
    },
    diagnostics: async (input, context) => {
      const team = await deps.services.registry.teams.get(input.teamID)
      if (!team) return context.error("not_found", "team not found", { what: "team", id: input.teamID })
      const [probe, listed, areas] = await Promise.all([
        GitVersion.probe(),
        Worktree.list(team.home.directory),
        deps.services.registry.areas.list(team.id),
      ])
      const worktrees = listed.ok ? listed.worktrees : []
      const cones = await Promise.all(
        areas
          .filter((area) => area.state === "active" && area.shape === "code")
          .map(async (area) => {
            const cone = await Cone.list(area.directory)
            return { areaID: area.id, shape: area.shape, patterns: cone.ok ? cone.dirs : [] }
          }),
      )
      return {
        inventory: worktrees.map((entry, index) => {
          const area = areas.find((item) => Identity.same(item.directory, entry.path))
          return {
            directory: entry.path,
            head: entry.head !== undefined && Git.isOid(entry.head) ? entry.head : null,
            branch: entry.branch?.replace(/^refs\/heads\//, "") ?? null,
            locked: entry.locked ?? null,
            class: classOf(entry, index, team, area),
            nested: worktrees.some((other) => other !== entry && Identity.inside(other.path, entry.path)),
            ...(area ? { areaID: area.id } : {}),
          }
        }),
        versions: { git: probe.git, lfs: probe.lfs },
        locks: worktrees.flatMap((entry) =>
          entry.locked === undefined ? [] : [{ directory: entry.path, reason: entry.locked }],
        ),
        cones,
        lastErrors: deps.services.errors(team.id).map((entry) => ({
          at: entry.at,
          message: entry.message,
          ...(entry.opID === undefined ? {} : { opID: entry.opID }),
          ...(entry.stepID === undefined ? {} : { stepID: entry.stepID }),
        })),
        // RH-20: what own-team.log holds of this team, so a stuck step can be read without the file.
        log: Log.recent(team.id),
        controller: deps.services.status.controller(),
      }
    },
  }
}

/**
 * The basic classes of `diagnostics` (3.2 does the full classification with enable): the home, an area, a folder
 * git reports gone, a `#` path, the main worktree, else a folder that could become an area.
 */
function classOf(
  entry: { readonly path: string; readonly prunable?: string },
  index: number,
  team: OwnTeam.Team,
  area: OwnTeam.Area | undefined,
): OwnTeam.Diagnostics["inventory"][number]["class"] {
  if (Identity.same(entry.path, team.home.directory)) return "home"
  if (area) return "area"
  if (entry.prunable !== undefined) return "prunable"
  if (entry.path.includes("#")) return "hash-path"
  if (index === 0) return "primary"
  return "candidate"
}

/** `health` alone: guard 1 failed (06 §2.6). Other methods answer `rpc.method_not_found`. */
export const HealthOnly = Rpc.define({
  id: OwnTeam.ID,
  methods: { health: OwnTeam.Definition.methods.health },
  events: {},
})

export function registerOnly(
  ctx: Pick<Plugin.Context, "rpc">,
  input: { readonly guard: OwnTeam.Guard; readonly buildId: string; readonly mode: "local" | "remote" },
) {
  return ctx.rpc.register(Portable.definition(HealthOnly), {
    health: async () => ({
      version: Build.PLUGIN_VERSION,
      buildId: input.buildId,
      guard: input.guard,
      mode: input.mode,
      features: [],
    }),
  })
}
