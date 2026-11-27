import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { Schema } from "effect"
import { Ledger, Limit } from "@own/protocol"
import { LastResponse, LedgerWriter, Limits, Redact } from "../src/index.js"
import { CODEX_ID, clock, fakeJwt, tmpdir } from "./fixture.js"

const SESSION = "ses_2f7c0a1b2c3d4e5f6a7b8c9d0e"

function usageLine(ts: number, messageID = "msg_1"): Ledger.Line {
  return Schema.decodeUnknownSync(Ledger.Line)({
    v: 1,
    ts,
    sessionID: SESSION,
    messageID,
    kind: "primary",
    accountID: CODEX_ID,
    providerID: "own-codex-7k2m",
    modelID: "gpt-5.5",
    variant: "high",
    credentialRef: null,
    transport: "websocket",
    switchEpoch: 3,
    compactionEpoch: 1,
    tokens: { input: 2890, cacheRead: 149120, cacheWrite: 0, cacheWrite1h: null, output: 812, reasoning: 1204 },
    P: 152010,
    hit: 0.981,
    cost: { unit: "credits", amount: 2.39, source: "ratecard" },
    costUSDOpenCode: 0,
    coldExpected: null,
  })
}

describe("LedgerWriter", () => {
  test("appends one JSONL line per event id, even for duplicate deliveries", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    const line = usageLine(time.now())
    const outcomes = await Promise.all([
      writer.usage("evt_1", line),
      writer.usage("evt_1", line),
      writer.usage("evt_2", line),
    ])
    expect(outcomes).toEqual(["written", "duplicate", "written"])
    const text = await fs.readFile(writer.file("usage", "2026-09"), "utf8")
    expect(
      text
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row).eid),
    ).toEqual(["evt_1", "evt_2"])
    expect(JSON.parse(text.split("\n")[0] ?? "")).toEqual({ eid: "evt_1", ...line })
    expect(await writer.usageOf("2026-09")).toEqual([
      { eid: "evt_1", line },
      { eid: "evt_2", line },
    ])
  })

  test("a restarted writer learns the ids already in the file", async () => {
    await using dir = await tmpdir()
    const time = clock()
    await new LedgerWriter.Writer({ dir: dir.path, now: time.now }).usage("evt_1", usageLine(time.now()))
    const restarted = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    expect(await restarted.usage("evt_1", usageLine(time.now()))).toBe("duplicate")
    expect(await restarted.usage("evt_3", usageLine(time.now()))).toBe("written")
  })

  test("partitions by the UTC month of the line and skips a torn last line when reading", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    await writer.usage("evt_sep", usageLine(Date.UTC(2026, 8, 30, 23, 59)))
    await writer.usage("evt_oct", usageLine(Date.UTC(2026, 9, 1, 0, 0)))
    expect((await fs.readdir(dir.path)).sort()).toEqual(["usage-2026-09.jsonl", "usage-2026-10.jsonl"])
    await fs.appendFile(writer.file("usage", "2026-09"), '{"eid":"evt_torn","v":1')
    expect((await writer.usageOf("2026-09")).map((entry) => entry.eid)).toEqual(["evt_sep"])
  })

  test("events are redacted and de-duplicated", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    const jwt = fakeJwt({ sub: "fake" })
    const event = {
      eid: "evt_login",
      type: "login",
      accountID: CODEX_ID,
      data: { method: "chatgpt-device", response: { access_token: "opaque", note: `id ${jwt}` } },
    }
    expect(await writer.event(event)).toBe("written")
    expect(await writer.event(event)).toBe("duplicate")
    const text = await fs.readFile(writer.file("events", "2026-09"), "utf8")
    expect(text).not.toContain("opaque")
    expect(text).not.toContain(jwt)
    expect(await writer.eventsOf("2026-09")).toEqual([
      {
        v: 1,
        eid: "evt_login",
        ts: time.now(),
        type: "login",
        accountID: CODEX_ID,
        data: {
          method: "chatgpt-device",
          response: { access_token: Redact.marker("opaque"), note: `id ${Redact.marker(jwt)}` },
        },
      },
    ])
  })

  test("maintain gzips past months, merges late lines, and deletes files older than 12 months", async () => {
    await using dir = await tmpdir()
    const time = clock(Date.UTC(2026, 9, 5))
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    await writer.usage("evt_old", usageLine(Date.UTC(2025, 8, 3)))
    await writer.usage("evt_keep", usageLine(Date.UTC(2025, 9, 3)))
    await writer.usage("evt_sep", usageLine(Date.UTC(2026, 8, 3)))
    await writer.usage("evt_now", usageLine(Date.UTC(2026, 9, 3)))
    expect(await writer.maintain()).toEqual({
      compressed: ["usage-2025-10.jsonl", "usage-2026-09.jsonl"],
      removed: ["usage-2025-09.jsonl"],
    })
    expect((await fs.readdir(dir.path)).sort()).toEqual([
      "usage-2025-10.jsonl.gz",
      "usage-2026-09.jsonl.gz",
      "usage-2026-10.jsonl",
    ])
    await writer.usage("evt_late", usageLine(Date.UTC(2026, 8, 30)))
    await writer.usage("evt_sep", usageLine(Date.UTC(2026, 8, 3)))
    await writer.maintain()
    const gz = gunzipSync(await fs.readFile(path.join(dir.path, "usage-2026-09.jsonl.gz"))).toString("utf8")
    expect(
      gz
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row).eid),
    ).toEqual(["evt_sep", "evt_late"])
    expect((await writer.usageOf("2026-09")).map((entry) => entry.eid)).toEqual(["evt_sep", "evt_late"])
  })

  test("usageOf reads a heavy month in slices, in file order, de-duplicated by eid", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    // Large enough that the decode outweighs the file reads around it on any machine.
    const count = 20_000
    const rows = Array.from({ length: count }, (_, index) =>
      JSON.stringify({ eid: `evt_${index}`, ...usageLine(time.now() - index) }),
    )
    // A duplicate in a later slice and a line with an eid but no valid line, whose eid still counts as taken.
    const text = [...rows, rows[3], '{"eid":"evt_bad","v":2}', JSON.stringify({ eid: "evt_bad", ...usageLine(1) })]
    await fs.writeFile(writer.file("usage", "2026-09"), `${text.join("\n")}\n`)
    // The file reads alone give the loop a turn too, so the check is the longest stretch without one: one pass over
    // every line would be most of the read, slices keep each stretch near SLICE_MS.
    const started = performance.now()
    const turns = [started]
    const reading = { done: false }
    const turn = () => {
      turns.push(performance.now())
      if (!reading.done) setImmediate(turn)
    }
    setImmediate(turn)
    const entries = await writer.usageOf("2026-09")
    reading.done = true
    const finished = performance.now()
    const gaps = [...turns.slice(1), finished].map((at, index) => at - (turns[index] ?? at))
    expect(Math.max(...gaps)).toBeLessThan((finished - started) / 2)
    expect(entries.map((entry) => entry.eid)).toEqual(Array.from({ length: count }, (_, index) => `evt_${index}`))
    expect(entries[count - 1]).toEqual({ eid: `evt_${count - 1}`, line: usageLine(time.now() - count + 1) })
  })

  test("usageSorted keeps the recent months decoded for the process and current on every append", async () => {
    await using dir = await tmpdir()
    const time = clock(Date.UTC(2026, 9, 5))
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    await writer.usage("evt_b", usageLine(Date.UTC(2026, 9, 2)))
    await writer.usage("evt_a", usageLine(Date.UTC(2026, 9, 3)))
    await writer.usage("evt_c", usageLine(Date.UTC(2026, 9, 2)))
    await writer.usage("evt_sep", usageLine(Date.UTC(2026, 8, 3)))
    expect((await writer.usageSorted("2026-10")).map((entry) => entry.eid)).toEqual(["evt_b", "evt_c", "evt_a"])
    expect((await writer.usageSorted("2026-09")).map((entry) => entry.eid)).toEqual(["evt_sep"])

    // Served from memory: a line written around the writer is not seen, appends through it are (in order).
    await fs.appendFile(writer.file("usage", "2026-10"), `${JSON.stringify({ eid: "evt_outside", ...usageLine(1) })}\n`)
    await writer.usage("evt_late", usageLine(Date.UTC(2026, 9, 1)))
    await writer.usage("evt_now", usageLine(Date.UTC(2026, 9, 5)))
    await writer.usage("evt_now", usageLine(Date.UTC(2026, 9, 5)))
    const october = await writer.usageSorted("2026-10")
    expect(october.map((entry) => entry.eid)).toEqual(["evt_late", "evt_b", "evt_c", "evt_a", "evt_now"])
    // Callers get a snapshot.
    await writer.usage("evt_next", usageLine(Date.UTC(2026, 9, 6)))
    expect(october).toHaveLength(5)

    // Gzipping the previous month moves its lines but keeps them.
    await writer.usage("evt_sep_late", usageLine(Date.UTC(2026, 8, 30)))
    expect(await writer.maintain()).toEqual({ compressed: ["usage-2026-09.jsonl"], removed: [] })
    expect((await writer.usageSorted("2026-09")).map((entry) => entry.eid)).toEqual(["evt_sep", "evt_sep_late"])
    const fresh = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    expect(await fresh.usageSorted("2026-09")).toEqual(await writer.usageSorted("2026-09"))

    // A month that is no longer recent is read from the files again.
    time.set(Date.UTC(2026, 11, 1))
    expect((await writer.usageSorted("2026-10")).map((entry) => entry.eid)).toEqual([
      "evt_outside",
      "evt_late",
      "evt_b",
      "evt_c",
      "evt_a",
      "evt_now",
      "evt_next",
    ])
  })

  // Three rounds over a 20k-line archive can pass the 5 s default on a loaded machine.
  test("a read that runs while maintain gzips the month repeats lines at worst, never loses them", async () => {
    await using dir = await tmpdir()
    const time = clock(Date.UTC(2026, 9, 5))
    // A large `.gz` keeps the read busy while maintain appends the plain file to it and deletes the plain file.
    const old = Array.from({ length: 20_000 }, (_, index) =>
      JSON.stringify({ eid: `evt_old_${index}`, ...usageLine(Date.UTC(2026, 8, 1) + index) }),
    )
    const packed = gzipSync(`${old.join("\n")}\n`)
    for (const round of [1, 2, 3]) {
      const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
      await fs.writeFile(`${writer.file("usage", "2026-09")}.gz`, packed)
      await writer.usage(`evt_new_${round}`, usageLine(Date.UTC(2026, 8, 20)))
      const [read] = await Promise.all([writer.usageOf("2026-09"), writer.maintain()])
      expect(read).toHaveLength(old.length + 1)
      expect(read.at(-1)?.eid).toBe(`evt_new_${round}`)
    }
  }, 30_000)

  test("a failed first read of a recent month is not kept", async () => {
    await using dir = await tmpdir()
    const time = clock(Date.UTC(2026, 9, 5))
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    await writer.usage("evt_plain", usageLine(Date.UTC(2026, 8, 20)))
    // Something that cannot be read where the month's `.gz` belongs: the month cannot be known in full.
    const gz = `${writer.file("usage", "2026-09")}.gz`
    await fs.mkdir(gz)
    expect(await writer.usageSorted("2026-09")).toEqual([])
    await fs.rm(gz, { recursive: true })
    await fs.writeFile(gz, gzipSync(`${JSON.stringify({ eid: "evt_packed", ...usageLine(Date.UTC(2026, 8, 2)) })}\n`))
    expect((await writer.usageSorted("2026-09")).map((entry) => entry.eid)).toEqual(["evt_packed", "evt_plain"])
  })

  test("an unreadable older month reads as empty instead of failing its caller", async () => {
    await using dir = await tmpdir()
    const time = clock(Date.UTC(2026, 9, 5))
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    // 2026-03 is outside the recent months, so it is read on every call (the step-end path reads old months too).
    await fs.mkdir(`${writer.file("usage", "2026-03")}.gz`, { recursive: true })
    await fs.mkdir(`${writer.file("events", "2026-03")}.gz`, { recursive: true })
    expect(await writer.usageSorted("2026-03")).toEqual([])
    expect(await writer.usageOf("2026-03")).toEqual([])
    expect(await writer.eventsOf("2026-03")).toEqual([])
  })

  test("concurrent first reads of a month share one decode", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const writer = new LedgerWriter.Writer({ dir: dir.path, now: time.now })
    await writer.usage("evt_1", usageLine(time.now()))
    const [first, second] = await Promise.all([writer.usageSorted("2026-09"), writer.usageSorted("2026-09")])
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first[0]?.line).toBe(second[0]?.line)
  })
})

describe("LastResponse", () => {
  test("keeps limit headers only, truncates and redacts bodies, and expires after 30 s", () => {
    const time = clock()
    const store = new LastResponse.Store({ now: time.now })
    const jwt = fakeJwt({ sub: "fake" })
    const capture = store.record(SESSION, {
      providerID: "own-codex-7k2m",
      status: 429,
      headers: new Headers({
        "x-codex-primary-used-percent": "100",
        "retry-after": "30",
        authorization: "Bearer should-never-be-kept",
        "set-cookie": "a=b",
        "content-length": "12",
      }),
      bodyHead: `{"error":"usage_limit_reached","echo":"${jwt}"}${"x".repeat(5000)}`,
      authHash8: "abcd1234",
    })
    expect(capture.headers).toEqual({ "x-codex-primary-used-percent": "100", "retry-after": "30" })
    expect(capture.bodyHead).toContain("usage_limit_reached")
    expect(capture.bodyHead).not.toContain(jwt)
    expect(capture.bodyHead?.length).toBeLessThanOrEqual(LastResponse.BODY_HEAD_CHARS)
    expect(store.get(SESSION)).toBe(capture)
    time.advance(LastResponse.TTL_MS + 1)
    expect(store.get(SESSION)).toBeUndefined()
  })

  test("remembers injected auth hashes per session and provider", () => {
    const time = clock()
    const store = new LastResponse.Store({ now: time.now })
    store.recordInjected(SESSION, "own-codex-7k2m", "11111111")
    store.recordInjected(SESSION, "own-anth-w3p8", "22222222")
    expect(store.injected(SESSION, "own-codex-7k2m")).toBe("11111111")
    store.clear(SESSION)
    expect(store.injected(SESSION, "own-anth-w3p8")).toBeUndefined()
    store.recordInjected(SESSION, "own-codex-7k2m", "33333333")
    time.advance(LastResponse.INJECTED_TTL_MS + 1)
    expect(store.injected(SESSION, "own-codex-7k2m")).toBeUndefined()
    store.sweep()
    expect(store.size).toEqual({ captures: 0, injected: 0 })
  })
})

describe("Limits", () => {
  const window = (patch: Partial<Limit.Window> = {}): Limit.Window =>
    Schema.decodeUnknownSync(Limit.Window)({
      id: "codex.primary",
      accountID: CODEX_ID,
      providerID: "own-codex-7k2m",
      scope: "account",
      kind: "rolling_quota",
      label: "5시간",
      windowMinutes: 300,
      usedPercent: 40,
      resetAt: Date.UTC(2026, 8, 27, 5, 0),
      status: "ok",
      confidence: "live",
      source: "header",
      observedAt: Date.UTC(2026, 8, 27, 3, 0),
      ...patch,
    })

  test("freshness bands and the estimated reset", () => {
    const base = window()
    expect(Limits.freshen(base, base.observedAt + 60_000).confidence).toBe("live")
    expect(Limits.freshen(base, base.observedAt + 10 * 60_000).confidence).toBe("recent")
    expect(Limits.freshen(base, base.observedAt + 20 * 60_000).confidence).toBe("stale")
    expect(Limits.freshen(base, (base.resetAt ?? 0) + 1)).toMatchObject({
      usedPercent: 0,
      status: "ok",
      confidence: "estimated",
    })
  })

  test("merges by newest observation and reports only significant changes", () => {
    const time = clock()
    const store = new Limits.Store({ file: "unused", now: time.now })
    expect(store.upsert([window()])).toHaveLength(1)
    expect(store.upsert([window({ usedPercent: 40.5, observedAt: time.now() + 1 })])).toEqual([])
    expect(store.upsert([window({ usedPercent: 42, observedAt: time.now() + 2 })])).toHaveLength(1)
    expect(store.upsert([window({ usedPercent: 10, observedAt: time.now() - 1 })])).toEqual([])
    expect(
      store.upsert([window({ status: "exhausted", usedPercent: 100, observedAt: time.now() + 3, source: "error" })]),
    ).toHaveLength(1)
    expect(store.list({ accountID: CODEX_ID }).map((item) => item.usedPercent)).toEqual([100])
    store.remove(CODEX_ID)
    expect(store.list()).toEqual([])
  })

  test("drop forgets one window of an account, the budget of an account that lost it (LV)", () => {
    const time = clock()
    const store = new Limits.Store({ file: "unused", now: time.now })
    store.upsert([window(), window({ id: "api.budget_month", kind: "budget", label: "이번 달 예산", usedPercent: 92 })])
    expect(store.drop(CODEX_ID, "api.budget_month")).toBe(true)
    expect(store.drop(CODEX_ID, "api.budget_month")).toBe(false)
    expect(store.list({ accountID: CODEX_ID }).map((item) => item.id)).toEqual(["codex.primary"])
  })

  test("exhaustion lasts until its time or a success clears it", () => {
    const time = clock()
    const store = new Limits.Store({ file: "unused", now: time.now })
    const exhaustion = {
      accountID: CODEX_ID,
      windowId: "codex.primary",
      until: time.now() + 60_000,
      class: "hard" as const,
    }
    store.exhaust(Schema.decodeUnknownSync(Limit.Exhaustion)(exhaustion))
    expect(store.exhaustion(CODEX_ID)).toMatchObject({ class: "hard" })
    expect(store.exhaustions()).toEqual([exhaustion])
    time.advance(60_000)
    expect(store.exhaustions()).toEqual([])
    expect(store.exhaustion(CODEX_ID)).toBeUndefined()
    store.exhaust(Schema.decodeUnknownSync(Limit.Exhaustion)({ ...exhaustion, until: time.now() + 60_000 }))
    // A success from before the exhaustion was recorded (a ledger line written late) keeps it; a later one clears it.
    const recorded = time.now()
    time.advance(1_000)
    store.clearExhaustion(CODEX_ID, recorded - 1)
    expect(store.exhaustion(CODEX_ID)).toMatchObject({ class: "hard" })
    store.clearExhaustion(CODEX_ID, recorded)
    expect(store.exhaustion(CODEX_ID)).toBeUndefined()
    store.exhaust(Schema.decodeUnknownSync(Limit.Exhaustion)({ ...exhaustion, until: time.now() + 60_000 }))
    store.clearExhaustion(CODEX_ID)
    expect(store.exhaustion(CODEX_ID)).toBeUndefined()
  })

  test("a model bucket's exhaustion holds back its model family only, beside the account-wide one (LV)", () => {
    const time = clock()
    const store = new Limits.Store({ file: "unused", now: time.now })
    const claude = "acc_claude_slot"
    const record = (windowId: string | null, minutes: number) =>
      Schema.decodeUnknownSync(Limit.Exhaustion)({
        accountID: claude,
        windowId,
        until: time.now() + minutes * 60_000,
        class: "hard",
      })
    // A used-up Opus week for 5 days: Opus waits, Sonnet and a model-less question do not.
    store.exhaust(record("claude.7d_opus", 5 * 24 * 60))
    expect(store.exhaustion(claude, "claude-opus-5-5")).toMatchObject({ windowId: "claude.7d_opus" })
    expect(store.exhaustion(claude, "claude-sonnet-4-5")).toBeUndefined()
    expect(store.exhaustion(claude)).toBeUndefined()
    // The 5 hours run out too: their record does not replace the bucket's, and Opus waits for the later one.
    store.exhaust(record("claude.5h", 120))
    expect(store.exhaustion(claude, "claude-sonnet-4-5")).toMatchObject({ windowId: "claude.5h" })
    expect(store.exhaustion(claude, "claude-opus-5-5")).toMatchObject({ windowId: "claude.7d_opus" })
    expect(store.exhaustions().map((item) => item.windowId)).toEqual(["claude.7d_opus", "claude.5h"])
    // A Sonnet success ends the account-wide record only; an Opus success the bucket's too.
    store.clearExhaustion(claude, undefined, "claude-sonnet-4-5")
    expect(store.exhaustion(claude, "claude-sonnet-4-5")).toBeUndefined()
    expect(store.exhaustion(claude, "claude-opus-5-5")).toMatchObject({ windowId: "claude.7d_opus" })
    store.clearExhaustion(claude, undefined, "claude-opus-5-5")
    expect(store.exhaustions()).toEqual([])
    store.exhaust(record("claude.7d_oi", 15))
    store.remove(claude)
    expect(store.exhaustions()).toEqual([])
  })

  test("saves state/limits.json only when dirty and loads it back", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const file = path.join(dir.path, "state", "limits.json")
    const store = new Limits.Store({ file, now: time.now })
    expect(await store.save()).toBe(false)
    store.upsert([window()])
    expect(await store.save()).toBe(true)
    expect(await store.save()).toBe(false)
    const snapshot = Schema.decodeUnknownSync(Limit.SnapshotFile)(JSON.parse(await fs.readFile(file, "utf8")))
    expect(snapshot.windows).toEqual([window()])
    const reloaded = new Limits.Store({ file, now: time.now })
    expect(await reloaded.load()).toBe(true)
    expect(reloaded.list()).toHaveLength(1)
    await fs.writeFile(file, "{broken")
    expect(await new Limits.Store({ file, now: time.now }).load()).toBe(false)
  })

  const credits = (patch: Partial<Limit.ResetCredits> = {}): Limit.ResetCredits =>
    Schema.decodeUnknownSync(Limit.ResetCredits)({
      accountID: CODEX_ID,
      providerID: "own-codex-7k2m",
      availableCount: 2,
      applicableCount: 0,
      observedAt: Date.UTC(2026, 9, 26, 3, 0),
      source: "poll",
      ...patch,
    })

  test("reset credits (02 §7.1.1): newest wins, a count read keeps the listed credits while the count stays", () => {
    const time = clock()
    const store = new Limits.Store({ file: "unused", now: time.now })
    const at = Date.UTC(2026, 9, 26, 3, 0)
    const listed = [
      { id: "credit-1", type: "codex_rate_limits", status: "available" as const, grantedAt: at - 86_400_000 },
      { id: "credit-2", type: "codex_rate_limits", status: "available" as const, grantedAt: at, expiresAt: at + 1e9 },
    ]
    expect(store.upsertCredits(credits())).toBe(true)
    // Same numbers, newer: not announced again, but the age moves.
    expect(store.upsertCredits(credits({ observedAt: at + 60_000 }))).toBe(false)
    expect(store.credits({ accountID: CODEX_ID })[0]?.observedAt).toBe(at + 60_000)
    // The dialog's details read brings the credits: announced.
    expect(store.upsertCredits(credits({ observedAt: at + 120_000, credits: listed }))).toBe(true)
    // A later count-only read with the same count keeps them; an older observation loses.
    expect(store.upsertCredits(credits({ observedAt: at + 180_000 }))).toBe(false)
    expect(store.credits()[0]?.credits?.map((item) => item.id)).toEqual(["credit-1", "credit-2"])
    expect(store.upsertCredits(credits({ observedAt: at, availableCount: 9 }))).toBe(false)
    // One redeemed: the count moves and the old list goes.
    expect(store.upsertCredits(credits({ observedAt: at + 240_000, availableCount: 1 }))).toBe(true)
    expect(store.credits()[0]).toMatchObject({ availableCount: 1 })
    expect(store.credits()[0]?.credits).toBeUndefined()
    // Not a window: nothing in the window list, and removal forgets it.
    expect(store.list()).toEqual([])
    store.remove(CODEX_ID)
    expect(store.credits()).toEqual([])
  })

  test("reset credit counts are saved in state/limits.json and loaded back; older files have none", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const file = path.join(dir.path, "state", "limits.json")
    const store = new Limits.Store({ file, now: time.now })
    store.upsertCredits(credits())
    expect(await store.save()).toBe(true)
    const snapshot = Schema.decodeUnknownSync(Limit.SnapshotFile)(JSON.parse(await fs.readFile(file, "utf8")))
    expect(snapshot).toMatchObject({ schemaVersion: 1, windows: [], resetCredits: [credits()] })
    const reloaded = new Limits.Store({ file, now: time.now })
    expect(await reloaded.load()).toBe(true)
    expect(reloaded.credits()).toEqual([credits()])
    expect(await reloaded.save()).toBe(false)
    // A file of a build before reset credits: no `resetCredits` key at all.
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, savedAt: time.now(), windows: [window()] }))
    const older = new Limits.Store({ file, now: time.now })
    expect(await older.load()).toBe(true)
    expect(older.credits()).toEqual([])
    store.upsert([window()])
    await store.save()
    expect(JSON.parse(await fs.readFile(file, "utf8")).resetCredits).toHaveLength(1)
  })
})
