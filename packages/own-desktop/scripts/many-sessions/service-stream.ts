// The service alone under many concurrent streams (no UI): N sessions in A folders (Locations), K of them streaming
// at R deltas/s from the fake provider (its own process), one SSE subscriber like the UI's. Records the service's CPU
// and memory, its answer time for a cheap request while it streams, how many text-delta events reach a subscriber,
// and how far behind the provider they arrive (the drain lag after the provider finished). Fake credentials only.
//
//   bun scripts/many-sessions/service-stream.ts [--service source|source-full|release] [--app <release app dir>]
//        [--n 20] [--areas 4] [--rate 50] [--seconds 60] [--turns 10] [--service-profile] [--env NAME=VALUE …]
//        [--label service-stream] [--out <dir>]
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { summarize } from "../../../own-web/e2e/performance/metrics"
import { cpuBetween, startProcSampler } from "./proc"
import { addAccount, providerProcess, sessionImporter, startBenchService, type ServiceMode } from "./service"

const args = parseArgs({
  options: {
    service: { type: "string", default: "release" },
    app: { type: "string" },
    n: { type: "string", default: "20" },
    areas: { type: "string", default: "4" },
    rate: { type: "string", default: "50" },
    seconds: { type: "string", default: "60" },
    turns: { type: "string", default: "10" },
    "service-profile": { type: "boolean", default: false },
    env: { type: "string", multiple: true },
    label: { type: "string", default: "service-stream" },
    out: { type: "string" },
  },
}).values
const N = Number(args.n)
const AREAS = Number(args.areas)
const RATE = Number(args.rate)
const SECONDS = Number(args.seconds)
const MODEL = "gpt-5.5"
const env = Object.fromEntries(
  (args.env ?? []).map((item) => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]),
)
const outDir = path.resolve(args.out ?? path.join(os.tmpdir(), "own-many-sessions"))
mkdirSync(outDir, { recursive: true })
const log = (message: string) => console.error(`[service-stream ${new Date().toISOString().slice(11, 19)}] ${message}`)
const root = path.join(os.tmpdir(), `own-svc-${randomBytes(3).toString("hex")}`)
const heapFile = path.join(root, "service-heap.jsonl")
mkdirSync(root, { recursive: true })

const provider = await providerProcess(MODEL)
const started = await startBenchService({
  mode: args.service as ServiceMode,
  app: args.app ? path.resolve(args.app) : undefined,
  root,
  heapFile,
  providerBaseURL: provider.baseURL,
  env,
})
const service = started.service
const proc = startProcSampler()
const report: Record<string, unknown> = {
  label: args.label,
  date: new Date().toISOString(),
  config: { service: args.service, n: N, areas: AREAS, rate: RATE, seconds: SECONDS, turns: Number(args.turns), env },
}
const sample = () => proc.sample({ service: [service.pid] })
const gcHeap = async () => {
  writeFileSync(`${heapFile}.gc`, "1")
  for (let waited = 0; waited < 15_000 && existsSync(`${heapFile}.gc`); waited += 250) await Bun.sleep(250)
  await Bun.sleep(1_200)
  const lines = readFileSync(heapFile, "utf8").trim().split("\n")
  const last = JSON.parse(lines.findLast((line) => line.includes('"gc":true')) ?? lines.at(-1)!) as Record<
    string,
    number
  >
  const mb = (value: number) => Math.round((value / 1024 ** 2) * 10) / 10
  const memory = await sample()
  return {
    heapMB: mb(last.heapSize!),
    rssMB: mb(last.rss!),
    locations: last.locations,
    privateMB: memory.roles.service?.privateBytes ?? null,
  }
}
try {
  const model = await addAccount(service, started.control, MODEL)
  const importSession = await sessionImporter(service, model)
  const areas = Array.from({ length: AREAS }, (_, index) =>
    path.join(service.paths.workspace, `area-${String(index + 1).padStart(2, "0")}`),
  )
  areas.forEach((dir) => mkdirSync(dir, { recursive: true }))
  const base = Date.UTC(2026, 8, 1)
  const sessions = []
  for (let index = 0; index < N; index++)
    sessions.push(
      await importSession(
        `W${index}`,
        `작업 ${index + 1}`,
        Number(args.turns),
        base + index * 3_600_000,
        areas[index % AREAS]!,
      ),
    )
  const activation: number[] = []
  for (const directory of areas) {
    const from = Date.now()
    for (let attempt = 0; attempt < 120 && !(await service.request("GET", "/api/model", { directory })).ok; attempt++)
      await Bun.sleep(250)
    activation.push(Date.now() - from)
  }
  report.activationMs = activation
  await Bun.sleep(3_000)
  const idleBefore = await sample()
  await Bun.sleep(20_000)
  report.idle = { cpu: cpuBetween(idleBefore, await sample()), memory: await gcHeap() }
  log(`idle: ${JSON.stringify(report.idle)}`)

  // One subscriber on the public feed, like the UI: text-delta events and characters per session, last arrival.
  const feed = new AbortController()
  const delivered = new Map<string, { events: number; chars: number; last: number; first?: number }>()
  const counts = { frames: 0, bytes: 0 }
  const reading = (async () => {
    const response = await fetch(new URL("/api/event", service.url), {
      headers: { authorization: service.authorization },
      signal: feed.signal,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      pending += decoder.decode(chunk.value, { stream: true })
      const frames = pending.split("\n\n")
      pending = frames.pop() ?? ""
      for (const frame of frames) {
        counts.frames++
        counts.bytes += frame.length + 2
        if (!frame.includes('"session.text.delta"')) continue
        const event = JSON.parse(frame.slice(frame.indexOf("{"))) as { data: { sessionID: string; delta?: string } }
        const entry = delivered.get(event.data.sessionID) ?? { events: 0, chars: 0, last: 0 }
        entry.events++
        entry.chars += event.data.delta?.length ?? 0
        entry.last = Date.now()
        entry.first ??= Date.now()
        delivered.set(event.data.sessionID, entry)
      }
    }
  })().catch(() => undefined)

  const run = randomBytes(3).toString("hex")
  for (const [index, target] of sessions.entries())
    await fetch(`${provider.url}/__bench/stream`, {
      method: "POST",
      body: JSON.stringify({
        marker: `OWNBM-${run}-${index}`,
        deltas: RATE * SECONDS,
        rate: RATE,
        tag: target.tag,
        startMarker: `OWNB-${target.tag}-8001-R`,
        doneMarker: `OWNB-${target.tag}-8002-R`,
      }),
    })
  const pings: number[] = []
  let pinging = true
  const pinger = (async () => {
    while (pinging) {
      const from = performance.now()
      await service.request("GET", "/api/info").catch(() => undefined)
      pings.push(performance.now() - from)
      await Bun.sleep(500)
    }
  })()
  const promptedAt = Date.now()
  const streamBefore = await sample()
  await Promise.all(
    sessions.map((target, index) =>
      service.call("POST", `/api/session/${target.id}/prompt`, {
        body: { text: `동시 스트리밍 측정 OWNBM-${run}-${index}` },
        directory: target.directory,
      }),
    ),
  )
  if (args["service-profile"]) writeFileSync(`${heapFile}.prof`, String(Math.min(30_000, SECONDS * 500)))
  type ProviderState = { streams: { marker: string; sent: number; startedAt?: number; finishedAt?: number }[] }
  const state = async () =>
    ((await (await fetch(`${provider.url}/__bench/state`)).json()) as ProviderState).streams.filter((item) =>
      item.marker.startsWith(`OWNBM-${run}`),
    )
  while (
    (await state()).filter((item) => item.finishedAt).length < N &&
    Date.now() - promptedAt < (SECONDS + 300) * 1_000
  )
    await Bun.sleep(1_000)
  const providerDone = Date.now()
  const streamAfter = await sample()
  // Drain: until every session's text deltas stopped arriving for 3 s (or 5 minutes).
  while (Date.now() - providerDone < 300_000) {
    const last = Math.max(0, ...[...delivered.values()].map((item) => item.last))
    if (last && Date.now() - last > 3_000) break
    await Bun.sleep(500)
  }
  const drained = Math.max(0, ...[...delivered.values()].map((item) => item.last))
  pinging = false
  await pinger
  const streams = await state()
  report.stream = {
    providerSeconds: Math.round((providerDone - promptedAt) / 100) / 10,
    firstDeltaMs: summarize([...delivered.values()].flatMap((item) => (item.first ? [item.first - promptedAt] : []))),
    drainLagMs: Math.max(0, drained - providerDone),
    cpu: cpuBetween(streamBefore, streamAfter),
    pingMs: summarize(pings),
    feed: {
      frames: counts.frames,
      kb: Math.round(counts.bytes / 1024),
      deltaEventsPerStreamPerS: summarize(
        [...delivered.values()].map(
          (item) => item.events / Math.max(1, (item.last - (item.first ?? item.last)) / 1000),
        ),
      ),
      deliveredSessions: delivered.size,
    },
    provider: { streams: streams.length, finished: streams.filter((item) => item.finishedAt).length },
    memory: await gcHeap(),
  }
  if (args["service-profile"]) {
    const file = `${heapFile}.prof.json`
    for (let waited = 0; waited < 60_000 && !existsSync(file); waited += 500) await Bun.sleep(500)
    if (existsSync(file)) {
      writeFileSync(path.join(outDir, `${args.label}-service.prof.json`), readFileSync(file))
      ;(report.stream as Record<string, unknown>).profile = JSON.parse(readFileSync(file, "utf8"))
    }
  }
  log(`stream: ${JSON.stringify({ ...(report.stream as Record<string, unknown>), profile: undefined })}`)
  const afterBefore = await sample()
  await Bun.sleep(20_000)
  report.after = { cpu: cpuBetween(afterBefore, await sample()), memory: await gcHeap() }
  feed.abort()
  await reading
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)
  log(String(report.error))
} finally {
  await proc.stop()
  await service.stop().catch(() => undefined)
  provider.stop()
  await removeTree(root)
  const file = path.join(outDir, `${args.label}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2))
  log(`report: ${file}`)
}
