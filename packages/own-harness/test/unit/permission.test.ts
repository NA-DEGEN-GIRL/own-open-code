import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { HarnessPermission } from "../../src/permission.js"

describe("HarnessPermission.assert", () => {
  test("asks upstream's permission.assert with the call's session, agent and source", async () => {
    const asked: unknown[] = []
    const ctx = {
      permission: { assert: (input: unknown) => Effect.sync(() => void asked.push(input)) },
    } as unknown as Pick<Context, "permission">
    const call = {
      sessionID: "ses_a",
      agent: "explore",
      messageID: "msg_1",
      id: "call_1",
      progress: () => Effect.void,
    } as never
    await Effect.runPromise(
      HarnessPermission.assert(ctx, { action: "edit", resources: ["a.ts"], save: ["*"], metadata: { diff: "" } }, call),
    )
    expect(asked).toEqual([
      {
        action: "edit",
        resources: ["a.ts"],
        save: ["*"],
        metadata: { diff: "" },
        sessionID: "ses_a",
        // Without the agent, agent rules (read-only mode, explore) would not apply.
        agent: "explore",
        source: { type: "tool", messageID: "msg_1", id: "call_1" },
      },
    ])
  })
})
