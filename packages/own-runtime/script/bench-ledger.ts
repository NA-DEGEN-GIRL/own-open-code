// Micro-benchmark of the usage-ledger read path on synthetic lines (no user data):
//   bun script/bench-ledger.ts [lines=20000]
// Prints the total ms and the longest event-loop block of a disk read (`usageOf`), of the first `usageSorted` call
// (decodes and caches the month) and of the second one (served from the process-wide cache).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LedgerWriter } from "../src/index.js"

const count = Number(process.argv[2] ?? 20_000)
const start = Date.UTC(2026, 8, 1)
const yearMonth = "2026-09"
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-bench-ledger-"))
const text = Array.from({ length: count }, (_, index) =>
  JSON.stringify({
    eid: `evt_${String(index).padStart(26, "0")}`,
    v: 1,
    ts: start + index * 1_000,
    sessionID: `ses_${String(index % 400).padStart(26, "a")}`,
    messageID: `msg_${String(index).padStart(26, "0")}`,
    kind: "primary",
    accountID: "acc_01M3KSDXJZJX2RXZK8QYK3TH06",
    providerID: "own-ds-abcdef",
    modelID: "model-x",
    variant: "default",
    credentialRef: null,
    transport: "http",
    switchEpoch: 0,
    compactionEpoch: 0,
    tokens: { input: 7828, cacheRead: 0, cacheWrite: 0, cacheWrite1h: null, output: 27, reasoning: 68 },
    P: 7828,
    hit: 0,
    cost: { unit: "USD", amount: 0.0012, source: "opencode" },
    costUSDOpenCode: 0.0012,
    coldExpected: null,
    usageSource: "event",
  }),
).join("\n")
await fs.writeFile(path.join(dir, `usage-${yearMonth}.jsonl`), `${text}\n`)

const writer = new LedgerWriter.Writer({ dir, now: () => start + count * 1_000 })
const usageOf = await measure(() => writer.usageOf(yearMonth))
const first = await measure(() => writer.usageSorted(yearMonth))
const second = await measure(() => writer.usageSorted(yearMonth))
console.log(
  JSON.stringify({
    lines: count,
    fileKB: Math.round(text.length / 1024),
    entries: usageOf.entries,
    usageOf: usageOf.timing,
    usageSortedFirst: first.timing,
    usageSortedSecond: second.timing,
  }),
)
await fs.rm(dir, { recursive: true, force: true })

// The longest gap between setImmediate ticks while `run` is pending is the longest synchronous block it caused.
async function measure(run: () => Promise<ReadonlyArray<unknown>>) {
  const ticker = { last: performance.now(), max: 0, running: true }
  const tick = () => {
    const now = performance.now()
    ticker.max = Math.max(ticker.max, now - ticker.last)
    ticker.last = now
    if (ticker.running) setImmediate(tick)
  }
  setImmediate(tick)
  await new Promise((resolve) => setImmediate(resolve))
  const begin = performance.now()
  const entries = (await run()).length
  const ms = performance.now() - begin
  await new Promise((resolve) => setImmediate(resolve))
  ticker.running = false
  return { entries, timing: { ms: Number(ms.toFixed(1)), maxBlockMs: Number(ticker.max.toFixed(1)) } }
}
