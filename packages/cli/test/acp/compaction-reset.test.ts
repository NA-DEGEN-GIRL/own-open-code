// OWN-PATCH(P-035) begin
// A context reset (P-035) is stored as a completed compaction with reason `reset`; an ACP client gets no compaction
// for it on session/load, while a real compaction still replays.
import { expect, test } from "bun:test"
import { SessionMessage } from "@opencode/schema/session-message"
import { DateTime } from "effect"
import { ACPCompaction } from "../../src/acp/compaction"

const completed = (reason: SessionMessage.CompactionCompleted["reason"]) =>
  SessionMessage.CompactionCompleted.make({
    id: SessionMessage.ID.make("msg_reset_marker"),
    type: "compaction",
    status: "completed",
    reason,
    summary: reason === "reset" ? "" : "Summary",
    time: { created: DateTime.makeUnsafe(0) },
  })

test("replays no compaction for a context reset marker", () => {
  expect(ACPCompaction.replay(completed("reset"), true)).toBeUndefined()
  expect(ACPCompaction.replay(completed("reset"), false)).toBeUndefined()
  expect(ACPCompaction.replay(completed("manual"), true)).toBeDefined()
})
// OWN-PATCH(P-035) end
