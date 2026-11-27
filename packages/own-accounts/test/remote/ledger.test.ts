// The remote ledger wrapper (04 §10.1): lines go through the runtime's single writer, only new ones reach the spool,
// and reads (including the process-wide sorted month cache) are answered by that writer.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { Ledger } from "@own/protocol"
import { LedgerWriter } from "@own/runtime"
import { RemoteLedger } from "../../src/remote/ledger.js"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

function line(ts: number) {
  return Schema.decodeUnknownSync(Ledger.Line)({
    v: 1,
    ts,
    sessionID: "ses_2f7c0a1b2c3d4e5f6a7b8c9d0e",
    messageID: "msg_1",
    kind: "primary",
    accountID: null,
    providerID: "own-codex-7k2m",
    modelID: "gpt-5.5",
    variant: null,
    credentialRef: null,
    transport: null,
    switchEpoch: 0,
    compactionEpoch: 0,
    tokens: null,
    P: null,
    hit: null,
    cost: null,
    costUSDOpenCode: null,
    coldExpected: null,
  })
}

test("appends and sorted month reads go to the runtime writer; only new lines are spooled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-remote-ledger-test-"))
  dirs.push(dir)
  const now = () => Date.UTC(2026, 8, 27)
  const inner = new LedgerWriter.Writer({ dir, now })
  const spooled: string[] = []
  const ledger = new RemoteLedger.Writer({
    inner,
    dir,
    now,
    onUsage: (eid) => spooled.push(eid),
    onEvent: () => undefined,
  })
  expect(await ledger.usageSorted("2026-09")).toEqual([])
  await ledger.usage("evt_2", line(now()))
  await ledger.usage("evt_1", line(now() - 1))
  await ledger.usage("evt_2", line(now()))
  // Another Location writing through the shared runtime writer directly.
  await inner.usage("evt_3", line(now() + 1))
  expect(spooled).toEqual(["evt_2", "evt_1"])
  expect((await ledger.usageSorted("2026-09")).map((entry) => entry.eid)).toEqual(["evt_1", "evt_2", "evt_3"])
  expect((await ledger.usageOf("2026-09")).map((entry) => entry.eid)).toEqual(["evt_2", "evt_1", "evt_3"])
})
