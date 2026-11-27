export * as ReportTool from "./report.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { Digest } from "../report/digest.js"
import { Fold } from "../report/fold.js"
import { Texts } from "../report/texts.js"
import type { Services } from "../services.js"
import { MainTools } from "./main.js"
import { OwnerTools } from "./owner.js"

/**
 * `team_report{kind, text, task?, assets?}` (06 §2.8, §5.5): an owner tells the main where its work stands. `progress`
 * and `done` are folded into the next team update (the last open `done` makes `모두 끝남`, which wakes the main);
 * `ready` refuses uncommitted tracked changes and otherwise records the branch tip as the candidate; `ready` and
 * `blocked` wake the main. `assets` (with `ready` only, T3, approved 2026-10-05) marks that candidate as needing an
 * engine run, so its integration runs the asset checks in `.assets` even when no large-file folder changed
 * (`Area.candidate.assets`, 4.10); with another kind it is ignored. Only the area's current owner (`tools/owner.ts`;
 * during a rotation the old owner until the swap) and, for every kind but `ready`, its peers.
 *
 * `relay` (06 §5.5, 2026-10-16): something the user asked in this conversation that only the team main can do (a new
 * area, a split, a join, a finish, a removal, a conversation move, work for another area) goes to the main in the
 * user's words. It is a waking digest entry (`사용자 부탁`), never a report: the area's status, its candidate and the
 * answer to its open main request stay as they are (a `blocked` would make the area 막힘 and answer the open request).
 * It counts toward the usual 30 s debounce and 12 updates an hour.
 *
 * 2026-11-14: a report or relay may hold 20,000 characters. The digest keeps an excerpt (`Fold.excerpt`, 1,000 code
 * points ending in `…` when cut); the whole text goes to KV `report:<team>:<area>` (`report/texts.ts`), which the
 * main's `team_status{area}` prints, so nothing is cut silently. A `ready` or `blocked` while the user works with the
 * area directly does not wake the main; it goes along with the hand-back (`report/events.ts`).
 */

export const NAME = "report"

export const DESCRIPTION =
  "Report your area's state to the team main: progress (a short status), done (the request is finished), ready (everything is committed and ready to integrate; refused while tracked files have uncommitted changes; add assets: true when the change needs the engine to import assets again, so the integration runs the asset checks), blocked (a decision of the main or another area is needed, or uncommitted changes you did not make are in the folder), relay (pass on, in the user's words, something the user asked in this conversation that only the team main can do: a new area, split, join, finish, removal from the team, a conversation move, or work for another area; your area's state does not change). Whether to report work the user asked you for directly follows your role text. progress and done do not wake the main; relay does; ready and blocked do unless the user is working with you directly (then they go along when the user hands the area back)."

export const Input = Schema.Struct({
  kind: Schema.Literals(["progress", "done", "ready", "blocked", "relay"]).annotate({
    description: "relay: pass on what the user asked here that only the team main can do; your state stays.",
  }),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
    description:
      "For the main: start with a one-line summary; the team update quotes only the start and the main can read the whole text. For relay, the user's words.",
  }),
  task: optional(Schema.String.check(Schema.isMaxLength(200)).annotate({ description: "The task label, if any." })),
  assets: optional(
    Schema.Boolean.annotate({
      description:
        "With ready only: true when the change needs the engine to import assets, so the integration runs the asset checks even if no large-file folder changed.",
    }),
  ),
})

/** The answer to a relay (06 §5.5). */
export const RELAYED =
  "팀 메인에게 전했습니다. 메인이 곧 읽고 처리합니다. 계획이 필요한 일이면 메인이 팀 메인 대화에서 사용자에게 묻습니다."

export const RELAY_EMPTY = "전할 사용자 말이 비어 있습니다. 사용자가 한 말을 text에 그대로 넣으세요."

export async function run(
  services: Services.Context,
  caller: OwnerTools.AreaCaller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  if (input.kind === "relay") {
    const words = input.text.trim()
    if (words === "") return { ok: false, text: RELAY_EMPTY }
    const teamID = caller.team.id
    const areaID = caller.area.id
    const at = services.clock.now()
    const peer = caller.role === "peer" ? { peer: caller.peer.key } : {}
    // One write: the digest entry with the excerpt, the whole words with the area's texts (2026-11-14).
    await services.write(teamID, async () => {
      const state = await Digest.load(services.kv, teamID)
      await Digest.save(
        services.kv,
        Fold.append(state, Fold.entry({ at, areaID, reason: "relay", text: Fold.excerpt(words), ...peer })),
      )
      const texts = await Texts.load(services.kv, services.log, teamID, areaID)
      await Texts.save(services.kv, teamID, areaID, Texts.relay(texts, { kind: "relay", text: words, at, ...peer }))
    })
    services.features().wake.request(teamID)
    return { ok: true, text: RELAYED }
  }
  // An area peer (동료) reports progress, done and blocked; integrating is the owner's (the description is the same).
  if (caller.role === "peer" && input.kind === "ready") return { ok: false, text: OwnerTools.PEER_REFUSED }
  const reported = await services.features().events.report({
    teamID: caller.team.id,
    areaID: caller.area.id,
    sessionID: caller.sessionID,
    ...(caller.role === "peer" ? { peer: caller.peer.key } : {}),
    kind: input.kind,
    text: input.text,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.kind === "ready" && input.assets === true ? { assets: true } : {}),
  })
  if (!reported.ok) return MainTools.answer(reported)
  return { ok: true, text: reported.text }
}
