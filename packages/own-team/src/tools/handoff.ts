export * as HandoffTool from "./handoff.js"

import { Schema } from "effect"
import { Handoff } from "../docs/handoff.js"
import type { Services } from "../services.js"
import { MainTools } from "./main.js"
import type { OwnerTools } from "./owner.js"

/**
 * `team_handoff{text}` (06 §2.8, §6.2, §6.4): the owner writes the handoff its next conversation starts from, in the
 * team records folder (`areas/<slug>/handoff.md`; 8 KB advised, cut at 64 KB). Owners only: during a rotation the old
 * owner is still the area's owner until the registry swap (6.2 step 4), so its handoff turn can write it.
 */

export const NAME = "handoff"

export const DESCRIPTION =
  "Write the handoff document the next owner conversation of this area starts from: goal, current state, done, next steps (first), decisions, cautions, fetched large-file folders. Keep it under 8 KB; more than 64 KB is cut."

export const Input = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)).annotate({
    description: "The whole handoff document in Markdown (06 §6.4 headings).",
  }),
})

export async function run(
  services: Services.Context,
  caller: OwnerTools.Caller,
  input: typeof Input.Type,
): Promise<MainTools.Reply> {
  const written = await services.features().handoff.write({
    teamID: caller.team.id,
    areaID: caller.area.id,
    text: input.text,
    by: "owner",
  })
  if (!written.ok) return MainTools.answer(written)
  const bytes = Buffer.byteLength(input.text, "utf8")
  const text =
    bytes > Handoff.MAX_BYTES
      ? "인계 문서가 64 KB를 넘어 앞 64 KB만 저장했습니다. 8 KB 이하로 줄여 다시 쓰세요."
      : bytes > Handoff.ADVISED_BYTES
        ? "인계 문서를 저장했습니다. 권장 크기 8 KB를 넘었으니 줄일 수 있으면 줄여 다시 쓰세요."
        : "인계 문서를 저장했습니다."
  return { ok: true, text, file: written.file, hash: written.hash, bytes }
}
