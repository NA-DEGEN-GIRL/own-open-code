// Ledger lines by message id (./ledger.ts): a footer that asked for a message before its line arrived sees the line
// once a page brings it. An id without a line is read behind one signal (a long transcript's footers ask for every
// step they show), so this checks the lookup stays reactive. Every id and account is made up.
import { describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { Ledger } from "@own/protocol"
import { createMemo, createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import { createLedgerLines } from "./ledger"

const tick = () => new Promise((resolve) => setTimeout(resolve, 60))

describe("ledger lines", () => {
  test("a lookup made before the line arrived sees it when the page comes", async () => {
    // SAFETY: the footer reads only `kind` and `messageID` here.
    const line = { kind: "primary", messageID: "msg_b", sessionID: "ses_l" } as unknown as Ledger.Line
    const pages: { steps: Ledger.Line[]; cursor?: string }[] = [{ steps: [line] }]
    const client = {
      rpc: {
        call: async (input: { method: string }) => ({
          output: input.method === "ledger.session" ? (pages.shift() ?? { steps: [] }) : {},
        }),
      },
    }
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        // SAFETY: the store only reaches `rpc.call` here.
        client: () => client as unknown as OpenCodeClient,
        routing: { control: async () => "D:\\ctl", sessionDirectory: () => "D:\\work" },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({
        rpc,
        bus,
        client: () => client as unknown as OpenCodeClient,
        sessionDirectory: () => "D:\\work",
      })
      bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      bus.flush()
      const ledger = createLedgerLines({ own, sessionID: "ses_l", ready: () => true })
      const missing = createMemo(() => ledger.line("msg_a"))
      const later = createMemo(() => ledger.line("msg_b")?.messageID)
      expect(later()).toBeUndefined()
      await tick()
      expect(later()).toBe("msg_b")
      expect(missing()).toBeUndefined()
      dispose()
    })
  })
})
