import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"
import { OwnImport } from "@own/protocol/rpc-import"
import { View } from "../../src/render/view.js"
import { ImportWorker } from "../../src/worker.js"
import { rollout, T0, threadId } from "../fixtures/codex.js"
import { codexRollout, fixture, stateDb, type Fixture } from "../fixtures/make.js"
import {
  call,
  decoded,
  record,
  startImportServer,
  writeClaude,
  writeCodex,
  type ImportOutput,
  type ImportServer,
} from "../e2e/support.js"

/**
 * IG5 and IG4 performance (09 §7.4), opt-in: `bun run test:perf` (`OWN_IMPORT_PERF=1`) on an idle PC. Synthetic data
 * only (test/fixtures). The results go to `own/.out/import-perf/ig5-<time>.json` (gitignored).
 *
 * - **Index** (through the real server, own-team's harness with own-import): 3,500 Codex rollouts (a state DB naming
 *   them, date folders over about 18 months) and 1,300 Claude Code files over 40 folders, most of them in the project's
 *   two clones. The first `sessions.list` answers within 2 s (the Worker's start included, `scanning` allowed), the
 *   cold index is complete within 5 s, a warm list answers within 300 ms, and `health` round trips stay at p95 <= 50 ms
 *   while the scan runs (the service event loop's lag, the scan being on the Worker).
 * - **A ~1 GB-decompressed `.zst`** (in-process service, the viewer's numbers are only visible here): the first page
 *   within 500 ms; the outline's completion and the jump to the last turn are measured and recorded (their targets
 *   follow the measurement, 09 §2.8 ⚠IG5); the LRU stays within 64 MiB.
 */

const ENABLED = process.env.OWN_IMPORT_PERF === "1"
const RUN = 900_000
const ROLLOUTS = 3_500
const CLAUDE_FILES = 1_300
const CLAUDE_FOLDERS = 40
/** About 1 GB of decoded JSONL: turns of four records, one with a 256 KiB tool output. */
const BIG_TURNS = 4_000
const BIG_OUTPUT = 256 * 1024
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..")
const OUT = path.join(REPO_ROOT, "own", ".out", "import-perf")

const results: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  bun: Bun.version,
  platform: `${process.platform} ${os.release()}`,
  cpus: os.cpus().length,
}
const state = {} as { fixture: Fixture; run: ImportServer }

describe.skipIf(!ENABLED)("IG5 performance (opt-in)", () => {
  beforeAll(async () => {
    state.fixture = await fixture()
    state.run = await startImportServer({
      name: "import-perf",
      roots: { codex: [state.fixture.codex], claude: [state.fixture.claude] },
    })
  }, RUN)

  afterAll(async () => {
    fs.mkdirSync(OUT, { recursive: true })
    await Bun.write(
      path.join(OUT, `ig5-${new Date().toISOString().replaceAll(":", "-")}.json`),
      `${JSON.stringify({ ...results, finishedAt: new Date().toISOString() }, null, 2)}\n`,
    )
    await state.run?.server.stop()
    await state.fixture?.cleanup()
  }, RUN)

  test(
    "3,500 rollouts and 1,300 Claude Code files: first answer, cold index, warm list, event-loop lag",
    async () => {
      const item = state.fixture
      const p = state.run.projects
      const server = state.run.server
      const folders = [p.first, p.sub, p.firstWorktree, p.second, p.secondWorktree, p.elsewhere]
      const generated = performance.now()
      const files = await batches(ROLLOUTS, (n) =>
        writeCodex(item.codex, n + 1, folders[n % folders.length], `질문 ${n}`, {
          at: T0 - n * 4 * 3_600_000,
        }),
      )
      stateDb(item.codex, {
        keepOpen: false,
        threads: files.map((file, n) => ({
          id: threadId(n + 1),
          rollout_path: file,
          cwd: folders[n % folders.length],
          title: `대화 ${n}`,
          model: "gpt-5.5",
          created_at_ms: T0 - n * 4 * 3_600_000,
          updated_at_ms: T0 - n * 4 * 3_600_000 + 60_000,
        })),
      })
      await batches(CLAUDE_FILES, (n) =>
        writeClaude(
          item.claude,
          `0b9e2a4c-6a7d-4c4e-9d1e-${n.toString(16).padStart(12, "0")}`,
          n % CLAUDE_FOLDERS < 24
            ? path.join(folders[n % 5], `pkg-${n % CLAUDE_FOLDERS}`)
            : path.join(p.elsewhere, `${n % CLAUDE_FOLDERS}`),
          `Claude 질문 ${n}`,
        ),
      )
      results.generateMs = Math.round(performance.now() - generated)
      await record(server, p.first)
      await record(server, p.second)

      const pings: number[] = []
      const pinging = { on: true }
      const pinger = (async () => {
        while (pinging.on) {
          const sent = performance.now()
          await server.rpc(OwnImport.ID, "health", {})
          pings.push(performance.now() - sent)
          await Bun.sleep(25)
        }
      })()
      const started = performance.now()
      const first = await call(server, "sessions.list", { directory: p.first })
      const firstMs = performance.now() - started
      const cold = await (async function poll(): Promise<number> {
        const listed = await call(server, "sessions.list", { directory: p.first, limit: 0 })
        if (!listed.scanning) return performance.now() - started
        if (performance.now() - started > 120_000) throw new Error("the index did not complete in two minutes")
        await Bun.sleep(100)
        return poll()
      })()
      pinging.on = false
      await pinger
      const warm = await timed(5, () => call(server, "sessions.list", { directory: p.first }))
      // Past the warm window a list refreshes again (the DB unchanged: the recent date folders and Claude's mtimes).
      await Bun.sleep(5_500)
      const refreshed = await timed(1, () => call(server, "sessions.list", { directory: p.first }))
      const total = (await call(server, "sessions.list", { directory: p.first, limit: 0 })).total
      results.index = {
        rollouts: ROLLOUTS,
        claudeFiles: CLAUDE_FILES,
        listed: total,
        firstMs: Math.round(firstMs),
        firstScanning: first.scanning,
        firstItems: first.items.length,
        coldMs: Math.round(cold),
        warmMs: warm,
        refreshedMs: refreshed,
        health: {
          count: pings.length,
          p50: percentile(pings, 0.5),
          p95: percentile(pings, 0.95),
          max: Math.max(...pings),
        },
      }
      expect(total).toBeGreaterThan(0)
      expect(firstMs).toBeLessThanOrEqual(2_000)
      expect(cold).toBeLessThanOrEqual(5_000)
      expect(Math.max(...warm)).toBeLessThanOrEqual(300)
      expect(percentile(pings, 0.95)).toBeLessThanOrEqual(50)
    },
    RUN,
  )

  test(
    "a ~1 GB-decompressed .zst: first page, outline completion, last-turn and middle jumps, LRU",
    async () => {
      const item = state.fixture
      const root = await item.folder("big-codex")
      const home = await item.folder("big-home")
      const written = performance.now()
      const file = await writeBig(root, state.run.projects.first)
      results.bigWriteMs = Math.round(performance.now() - written)
      const settings: ImportWorker.Settings = {
        options: { home, roots: { codex: [root], claude: [] }, service: state.run.server.service.importOption },
        channel: "local",
      }
      // A service with its index built, nothing read yet.
      const viewer = async () => {
        const service = ImportWorker.create({ home, worktrees: async () => [], emit: () => {} })
        const run = <M extends ImportWorker.Method>(method: M, input: unknown) =>
          service.call(method, input, settings, new AbortController().signal).then((answer) => decoded(method, answer))
        const sources = await run("sources.list", {})
        await service.idle()
        return { service, run, ref: { kind: "codex", rootID: sources.roots[0]?.rootID, id: threadId(9_001) } }
      }
      const view = await viewer()
      const rss = process.memoryUsage().rss
      const opened = performance.now()
      const page = await view.run("sessions.read", {
        ref: view.ref,
        directory: state.run.projects.first,
        from: 0,
        count: 20,
      })
      const firstPageMs = performance.now() - opened
      const outline = await (async function poll(): Promise<ImportOutput<"sessions.read">> {
        const read = await view.run("sessions.read", {
          ref: view.ref,
          directory: state.run.projects.first,
          from: 0,
          count: 1,
        })
        if (read.outlineComplete) return read
        await Bun.sleep(200)
        return poll()
      })()
      const outlineMs = performance.now() - opened
      const last = outline.outline.turns.length - 1
      const jumped = performance.now()
      const tail = await view.run("sessions.read", {
        ref: view.ref,
        directory: state.run.projects.first,
        from: last,
        count: 1,
      })
      const lastTurnMs = performance.now() - jumped
      // A turn the LRU let go: decoded again from the start, the lines before it skipped unparsed (09 §2.8).
      const middled = performance.now()
      await view.run("sessions.read", {
        ref: view.ref,
        directory: state.run.projects.first,
        from: BIG_TURNS / 2,
        count: 1,
      })
      const middleTurnMs = performance.now() - middled
      const stats = view.service.stats()
      const grown = process.memoryUsage().rss - rss
      await view.service.close()
      // Opened and sent to the last turn at once, before any outline: the whole stream is decoded first.
      const cold = await viewer()
      const coldJumped = performance.now()
      await cold.run("sessions.read", {
        ref: cold.ref,
        directory: state.run.projects.first,
        from: BIG_TURNS - 1,
        count: 1,
      })
      const lastTurnColdMs = performance.now() - coldJumped
      await cold.service.close()
      results.zst = {
        compressedBytes: fs.statSync(file).size,
        turns: outline.outline.turns.length,
        firstPageMs: Math.round(firstPageMs),
        firstPageMessages: page.messages.length,
        firstPageOutlineComplete: page.outlineComplete,
        outlineMs: Math.round(outlineMs),
        lastTurnMs: Math.round(lastTurnMs),
        lastTurnMessages: tail.messages.length,
        middleTurnMs: Math.round(middleTurnMs),
        lastTurnColdMs: Math.round(lastTurnColdMs),
        lru: stats,
        lruBudget: View.LRU_BYTES,
        rssGrowthMb: Math.round(grown / 1_048_576),
      }
      expect(outline.outline.turns.length).toBe(BIG_TURNS)
      expect(tail.messages.length).toBeGreaterThan(0)
      expect(firstPageMs).toBeLessThanOrEqual(500)
      expect(stats.bytes).toBeLessThanOrEqual(View.LRU_BYTES)
    },
    RUN,
  )
})

/** Runs `make(0..count-1)` 64 at a time and keeps the order. */
async function batches<T>(count: number, make: (n: number) => Promise<T>) {
  const chunks = Array.from({ length: Math.ceil(count / 64) }, (_, index) =>
    Array.from({ length: Math.min(64, count - index * 64) }, (_, offset) => index * 64 + offset),
  )
  return chunks.reduce<Promise<T[]>>(
    async (done, chunk) => [...(await done), ...(await Promise.all(chunk.map(make)))],
    Promise.resolve([]),
  )
}

/** `times` sequential runs of `run`, each in milliseconds. */
async function timed(times: number, run: () => Promise<unknown>) {
  return Array.from({ length: times }).reduce<Promise<number[]>>(async (done) => {
    const list = await done
    const started = performance.now()
    await run()
    return [...list, Math.round(performance.now() - started)]
  }, Promise.resolve([]))
}

function percentile(values: ReadonlyArray<number>, rank: number) {
  const sorted = values.toSorted((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(rank * sorted.length))] ?? 0)
}

/**
 * A Codex rollout of {@link BIG_TURNS} turns written through zstd as it is generated (never whole in memory): each
 * turn is a user request, a shell call, its {@link BIG_OUTPUT} output and an answer, about 1 GB decoded.
 */
async function writeBig(root: string, cwd: string) {
  const file = codexRollout(root, { id: threadId(9_001), at: T0, zst: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const filler = "lorem ipsum dolor sit amet, consectetur adipiscing elit 0123456789 ".repeat(BIG_OUTPUT / 64)
  async function* lines() {
    yield `${rollout({ start: T0 })
      .meta({ id: threadId(9_001), cwd })
      .lines()
      .join("\n")}\n`
    for (let turn = 0; turn < BIG_TURNS; turn++)
      yield `${rollout({ start: T0 + turn * 4_000, firstOrdinal: 1 + turn * 4 })
        .user(`질문 ${turn}`)
        .call("shell", { command: ["bun", "test"] }, `call_big_${turn}`)
        .output(`call_big_${turn}`, `${turn} ${filler.slice(0, BIG_OUTPUT)}`)
        .assistant(`답변 ${turn}`)
        .lines()
        .join("\n")}\n`
  }
  await pipeline(lines(), zlib.createZstdCompress(), fs.createWriteStream(file))
  return file
}
