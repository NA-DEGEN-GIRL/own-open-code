export * as Envelope from "./envelope.js"

import type { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Talk } from "./talk.js"

/**
 * The envelope of a main request (06 §5.1). The model never sees message metadata (core
 * session/runner/to-llm-message.ts:245-264), so the owner learns who asks from the envelope; the owner role
 * instruction (6.2) explains it: a request of the main (`from="main"`) or of the program (`from="team"`), and the
 * user's own words come first. The format and its escaping live in `@own/protocol/rpc-team-text`, which own-web reads
 * the envelope back with.
 *
 * ```text
 * <dispatch from="main" id="dp_01JAX…" area="인벤토리 화면" task="정렬 버그">
 * …the request…
 * </dispatch>
 * ```
 *
 * An area message (5.8) names who sent it and its kind; a reply names the ask it answers; a program notice is
 * `kind="notice"`. Notes (쪽지) held for the conversation follow in a `<team-notes>` block:
 *
 * ```text
 * <dispatch from="area" sender="세이브 v3" kind="reply" reply="dp_01JB…" id="dp_01JC…" area="인벤토리 화면">
 * count 필드는 그대로 둡니다.
 * </dispatch>
 * <team-notes>
 * - 결제 화면 동료 리뷰어(2026-10-25 14:05): 가격 표시는 내일 바뀝니다
 * </team-notes>
 * ```
 */
export function wrap(input: {
  readonly dispatch: Pick<OwnTeam.Dispatch, "id" | "from" | "task" | "text" | "to"> &
    Partial<Pick<OwnTeam.Dispatch, "kind" | "sender" | "replyTo">>
  /** The area's display name. */
  readonly area: string
  readonly notes?: ReadonlyArray<OwnTeam.AreaNote>
}) {
  const dispatch = input.dispatch
  // Only area messages and notices name their kind: main and program requests keep their envelope byte for byte.
  const kind = dispatch.from === "area" || dispatch.kind === "notice" ? dispatch.kind : undefined
  return OwnTeamText.wrap({
    from: dispatch.from,
    // A request to an area peer names it (동료); an owner's envelope stays as it was.
    ...(dispatch.to ? { to: dispatch.to } : {}),
    ...(dispatch.sender ? { sender: OwnTeamText.senderName(dispatch.sender) } : {}),
    ...(kind ? { kind } : {}),
    ...(dispatch.replyTo ? { reply: dispatch.replyTo } : {}),
    id: dispatch.id,
    area: input.area,
    ...(dispatch.task ? { task: dispatch.task } : {}),
    text: dispatch.text,
    notes: (input.notes ?? []).map((note) => ({
      from: OwnTeamText.noteFrom(note),
      at: Talk.clock(note.at),
      text: note.text,
    })),
  })
}
