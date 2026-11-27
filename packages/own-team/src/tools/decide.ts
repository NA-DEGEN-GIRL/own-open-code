export * as DecideTool from "./decide.js"

import { Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import type { Services } from "../services.js"
import { MainTools } from "./main.js"

/**
 * `team_decide{title, body, areas?}` (06 §2.8, §6.6): the main records a team decision in the team records folder
 * (`decisions/NNNN-<slug>.md`, numbered like the user's 결정 적기). With `commitDecisions` on, the answer also says how
 * to commit the copy in the main folder; the program never writes there itself.
 * The description changed once in T2 when the tool became available (user decision 2026-10-03); that changes each
 * existing team session's tool catalog once.
 */

export const NAME = "decide"

export const DESCRIPTION = "Record a team decision (title, body, related areas) in the team's decision records."

export const Input = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  body: Schema.String.check(Schema.isMaxLength(65_536)),
  areas: optional(Schema.Array(Schema.String)),
})

export async function run(
  services: Services.Context,
  caller: MainTools.Caller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  const areas = await Promise.all((input.areas ?? []).map((name) => MainTools.area(services, caller.team.id, name)))
  const known = areas.filter((area) => area !== undefined)
  if (known.length !== areas.length) return { ok: false, text: MainTools.NO_AREA }
  const added = await services.features().decisions.add({
    teamID: caller.team.id,
    title: input.title,
    body: input.body,
    source: "main",
    areas: known.map((area) => area.id),
  })
  if (!added.ok) return MainTools.answer(added)
  const number = String(added.record.number).padStart(4, "0")
  return {
    ok: true,
    text: [`결정 기록 ${number}을 적었습니다: ${added.path}`, ...(added.commit ? [added.commit.instruction] : [])].join(
      "\n",
    ),
    number: added.record.number,
    file: added.record.file,
    ...(added.commit ? { commit: added.commit.path } : {}),
  }
}
