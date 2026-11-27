export * as NeedPathsTool from "./need-paths.js"

import { Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { NeedPaths } from "../assets/need-paths.js"
import type { Services } from "../services.js"
import type { MainTools } from "./main.js"
import type { OwnerTools } from "./owner.js"

/**
 * `team_need_paths{dirs, reason}` (06 §2.8, §4.6): an owner fetches large-file folders its code-only folder does not
 * have. Owners and area peers (동료, who share the folder). The answer is `{added, bytes, downloaded, waiting, text}`: under the team's thresholds the folders
 * are fetched now; over them a confirm waits for the user (`waiting: true`) and the owner hears back through a
 * `<team-notice>` once the user said yes.
 */

export const NAME = "need_paths"

export const DESCRIPTION =
  "Fetch large-file folders that this area's code-only folder does not have (repository-relative, '/'-separated). Large downloads wait for the user's confirm."

export const Input = Schema.Struct({
  dirs: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(OwnTeam.PATHS_MAX),
  ),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})

export async function run(
  services: Services.Context,
  caller: OwnerTools.AreaCaller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  const area = caller.area
  const validated = NeedPaths.validate(input.dirs)
  if (!validated.ok)
    return {
      ok: false,
      text: `쓸 수 없는 폴더 이름입니다: ${validated.path} (저장소 기준 경로, '..'·앞의 '/'·앞의 '-'는 쓸 수 없습니다)`,
      error: "path_forbidden",
    }
  if (area.state === "broken")
    return { ok: false, text: "이 영역의 작업 폴더를 확인할 수 없어 지금은 가져올 수 없습니다", error: "broken" }
  if (area.shape !== "code") return reply({ added: [], bytes: 0, downloaded: 0, waiting: false }, ALL)
  if (caller.team.env.lfs === "missing")
    return { ok: false, text: "이 컴퓨터에 git-lfs가 없어 큰 파일 폴더를 가져올 수 없습니다", error: "lfs_missing" }

  const remaining = await NeedPaths.remaining(area.directory, validated.dirs)
  if (!remaining.ok) return { ok: false, text: `폴더를 확인하지 못했습니다: ${remaining.message}`, error: "git" }
  if (remaining.dirs.length === 0) return reply({ added: [], bytes: 0, downloaded: 0, waiting: false }, HELD)
  const counted = await NeedPaths.count(area.directory, remaining.dirs, remaining.cone)
  if (!counted.ok) return { ok: false, text: `폴더 크기를 재지 못했습니다: ${counted.message}`, error: "git" }

  if (NeedPaths.over(caller.team.policy, counted)) {
    const asked = await NeedPaths.ask(services, {
      team: caller.team,
      area,
      dirs: remaining.dirs,
      reason: input.reason,
      // The `<team-notice>` goes to the area's owner; a peer (동료) calls again once the user said yes.
      notify: caller.role === "owner",
      by: "auto",
    })
    if (!asked.ok)
      return {
        ok: false,
        text: "다른 팀 작업이 진행 중이라 지금은 확인을 요청할 수 없습니다. 잠시 뒤 다시 부르세요",
        error: "busy",
      }
    const waiting =
      caller.role === "owner" ? NeedPaths.WAITING : `${NeedPaths.WAITING}. 사용자가 받기로 하면 다시 부르세요`
    return reply({ added: [], bytes: counted.bytes, downloaded: 0, waiting: true }, waiting)
  }

  const applied = await NeedPaths.apply(services, {
    area,
    dirs: remaining.dirs,
    reason: input.reason,
    counted,
    clean: true,
  })
  if (!applied.ok)
    return {
      ok: false,
      text: applied.error === "network" ? NeedPaths.NETWORK : `폴더를 가져오지 못했습니다: ${applied.message}`,
      error: applied.error,
    }
  const text = NeedPaths.announce(services, area, applied)
  const fetched =
    applied.downloaded > 0 ? `내려받기 ${NeedPaths.size(applied.downloaded)}` : "공유 저장소에 있어 내려받지 않았습니다"
  return reply(
    { added: applied.added, bytes: applied.bytes, downloaded: applied.downloaded, waiting: false },
    `${text}: ${applied.added.join(", ")} (${fetched})`,
  )
}

const ALL = "이 영역은 모든 폴더를 이미 가지고 있습니다"
const HELD = "요청한 폴더는 이미 이 영역에 있습니다"

function reply(
  values: {
    readonly added: ReadonlyArray<string>
    readonly bytes: number
    readonly downloaded: number
    readonly waiting: boolean
  },
  text: string,
): MainTools.Reply {
  return {
    ok: true,
    text,
    added: [...values.added],
    bytes: values.bytes,
    downloaded: values.downloaded,
    waiting: values.waiting,
  }
}
