// The remote observation spool (04 §10.2): monotonic seq per stream across restarts, ack truncation, a torn last
// line, and overflow (newest limits per window kept, oldest other items dropped, one gap item).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Spool } from "../../src/remote/spool.js"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-spool-test-"))
  dirs.push(dir)
  return path.join(dir, "spool")
}

describe("Spool", () => {
  test("seq grows across reopen; ack drops the acknowledged prefix from memory and file", async () => {
    const dir = await temp()
    const spool = await Spool.Store.open({ dir })
    const a = spool.add("ledger", { eid: "a" })
    const b = spool.add("event", { eid: "b" })
    expect([a.seq, b.seq]).toEqual([1, 2])
    expect(spool.streamId).toMatch(/^[0-9a-f]{16}$/)
    await spool.flush()
    const reopened = await Spool.Store.open({ dir })
    expect(reopened.streamId).toBe(spool.streamId)
    expect(reopened.pending().map((item) => item.seq)).toEqual([1, 2])
    expect(reopened.add("ledger", { eid: "c" }).seq).toBe(3)
    await reopened.ack(2)
    expect(reopened.pending().map((item) => item.seq)).toEqual([3])
    await reopened.flush()
    const third = await Spool.Store.open({ dir })
    expect(third.pending().map((item) => item.seq)).toEqual([3])
    // A fully acknowledged spool keeps counting after a restart.
    await third.ack(3)
    await third.flush()
    const fourth = await Spool.Store.open({ dir })
    expect(fourth.pending()).toEqual([])
    expect(fourth.add("ledger", {}).seq).toBe(4)
  })

  test("a torn last line is dropped on open", async () => {
    const dir = await temp()
    const spool = await Spool.Store.open({ dir })
    spool.add("ledger", { eid: "a" })
    await spool.flush()
    await fs.appendFile(spool.file, '{"seq":2,"eventId":"x","schemaVer')
    const reopened = await Spool.Store.open({ dir })
    expect(reopened.pending().map((item) => item.seq)).toEqual([1])
    expect(reopened.add("ledger", {}).seq).toBe(2)
  })

  test("pending() is bounded like one observe.push", async () => {
    const dir = await temp()
    const spool = await Spool.Store.open({ dir })
    for (let index = 0; index < 300; index++) spool.add("ledger", { eid: `e${index}` })
    expect(spool.pending()).toHaveLength(256)
    expect(spool.pending(1000, 2_000).length).toBeLessThan(30)
    await spool.flush()
  })

  test("overflow keeps the newest limits per window, drops the oldest others and records one gap", async () => {
    const dir = await temp()
    const spool = await Spool.Store.open({ dir, limits: { items: 10 } })
    const window = (id: string, used: number) => ({ windows: [{ accountID: "acc_a", id, usedPercent: used }] })
    spool.add("limits", window("w1", 1))
    for (let index = 0; index < 5; index++) spool.add("ledger", { eid: `old${index}` })
    spool.add("limits", window("w1", 2))
    spool.add("limits", window("w2", 3))
    for (let index = 0; index < 3; index++) spool.add("ledger", { eid: `new${index}` })
    await spool.flush()
    const items = spool.pending(1000, 10_000_000)
    const types = items.map((item) => item.type)
    expect(types.filter((type) => type === "gap")).toHaveLength(1)
    const gap = items.find((item) => item.type === "gap")!
    expect(gap.payload).toMatchObject({ fromSeq: 1 })
    // The older w1 observation went, the newer w1 and w2 stayed.
    const limits = items.filter((item) => item.type === "limits").map((item) => JSON.stringify(item.payload))
    expect(limits).toEqual([JSON.stringify(window("w1", 2)), JSON.stringify(window("w2", 3))])
    expect(items.length).toBeLessThanOrEqual(10)
    expect(spool.stats().gaps).toBe(1)
    // The newest ledger items survive.
    expect(items.filter((item) => item.type === "ledger").map((item) => (item.payload as { eid: string }).eid)).toContain("new2")
    // Seqs stay ordered for the local ack.
    const seqs = items.map((item) => item.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    const reopened = await Spool.Store.open({ dir, limits: { items: 10 } })
    expect(reopened.pending(1000, 10_000_000).map((item) => item.seq)).toEqual(seqs)
  })
})
