export * as PathsOp from "./paths.js"

import type { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../assets/need-paths.js"
import { Release } from "../assets/release.js"
import { Services } from "../services.js"
import { Journal } from "./journal.js"

/**
 * 큰 파일 폴더 가져오기 / 내려놓기 (06 §4.6–4.7) as one `paths` op: a `paths-add` step (a confirm when the fetch is over
 * the team's thresholds) and/or a `paths-release` step (at the extended safe point; folders with work in them stay).
 * The `area.paths` RPC (by the user) and `team_area{action: "paths"}` (by the main, or by the user after a plan, 06
 * §2.9) start it here. The step kinds are registered by `rpc/paths.ts` while the plugin sets up.
 */

export async function start(
  services: Services.Context,
  input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly add?: ReadonlyArray<string>
    readonly release?: ReadonlyArray<string>
    readonly reason?: string
    readonly by: OwnTeam.Op["by"]
  },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const team = await services.registry.teams.get(input.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: input.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const area = await services.registry.areas.get(team.id, input.areaID)
  if (!area || area.state === "retired")
    return Services.failure("not_found", "영역을 찾을 수 없어요", { what: "area", id: input.areaID })
  if (area.state === "broken")
    return Services.failure("broken", "the area folder is not its worktree", {
      areaID: area.id,
      why: area.broken?.why ?? "identity",
    })
  const add = NeedPaths.validate(input.add ?? [])
  if (!add.ok) return Services.failure("path_forbidden", "not a folder name", { path: add.path, why: "invalid" })
  const release = NeedPaths.validate(input.release ?? [])
  if (!release.ok)
    return Services.failure("path_forbidden", "not a folder name", { path: release.path, why: "invalid" })
  if (add.dirs.length + release.dirs.length === 0)
    return Services.failure("path_forbidden", "no folder given", { path: "", why: "invalid" })
  if (add.dirs.length > 0 && area.shape === "code" && team.env.lfs === "missing")
    return Services.failure("lfs_missing", "git-lfs is not installed", { tool: "git-lfs", version: null })

  const confirm = add.dirs.length > 0 && area.shape === "code" && (await over(team, area, add.dirs))
  const started = await services.runner.start({
    teamID: team.id,
    kind: "paths",
    by: input.by,
    areaID: area.id,
    steps: [
      ...(add.dirs.length === 0
        ? []
        : [
            NeedPaths.spec({
              areaID: area.id,
              dirs: add.dirs,
              reason: input.reason ?? "user",
              notify: false,
              confirm,
            }),
          ]),
      ...(release.dirs.length === 0 ? [] : [Release.spec({ areaID: area.id, dirs: release.dirs })]),
    ],
  })
  if (!started.ok) return Services.failure("busy", "another op of the team is running", Journal.busy(started.op))
  return { ok: true, opID: started.op.id }
}

/** Whether fetching `dirs` waits for the user (06 §4.6 step 2); a folder the count cannot read decides nothing. */
async function over(team: OwnTeam.Team, area: OwnTeam.Area, dirs: ReadonlyArray<string>) {
  const remaining = await NeedPaths.remaining(area.directory, dirs)
  if (!remaining.ok || remaining.dirs.length === 0) return false
  const counted = await NeedPaths.count(area.directory, remaining.dirs, remaining.cone)
  return counted.ok && NeedPaths.over(team.policy, counted)
}
