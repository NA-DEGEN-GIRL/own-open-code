// Performance fixture backend (run by e2e/performance/playwright.config.ts, or by hand: `bun e2e/performance/backend.ts`).
// Boots the real upstream server from source with own.accounts + own.telemetry (packages/own-accounts/test/e2e-kit),
// a paced fake OpenAI Responses provider, one API-key account created through RPC, imports long sessions through
// `POST /api/experimental/session/import` (2,000 messages each, 40% with tool cards), and serves the production
// build of own-web with `vite preview` (same assets the service embeds; `/api` proxied with server-side Basic auth).
// Fake credentials only; everything lives in a temp directory that is removed on exit.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { preview } from "vite"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { REPO_ROOT, startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { buildHistory, lastMarker, sessionID, type HistoryStats } from "./fixture/history"
import { startStreamProvider } from "./fixture/stream-provider"

export const PREVIEW_PORT = Number(process.env.OWN_PERF_PREVIEW_PORT ?? 5196)
export const STATE_FILE = path.join(os.tmpdir(), "own-web-perf", "backend.json")

const MODEL = "gpt-5.5"
const FAKE_KEY = "sk-proj-ownWebPerfFakeKey00000000000000001"
const PACKAGE = path.join(REPO_ROOT, "packages/own-web")
const TURNS = Number(process.env.OWN_PERF_TURNS ?? 1_000)
const FILLERS = Number(process.env.OWN_PERF_FILLER_SESSIONS ?? 40)

/** The bundle to serve: run.ts passes a snapshot of dist/, so a concurrent rebuild cannot swap files mid-run. */
const DIST = process.env.OWN_PERF_DIST ?? path.join(PACKAGE, "dist")

if (!(await Bun.file(path.join(DIST, "index.html")).exists()))
  throw new Error(
    `own-web perf backend: no build in ${DIST}; run "bun run build" first (benchmarks use the production bundle)`,
  )

// Playwright's webServer force-kills this process on Windows (no cleanup): remove a dead previous run's temp root.
const stale = (await Bun.file(STATE_FILE)
  .json()
  .catch(() => undefined)) as { root?: string; pid?: number } | undefined
if (stale?.root?.includes("own-e2e-") && stale.pid && !alive(stale.pid))
  await fs.rm(stale.root, { recursive: true, force: true }).catch(() => undefined)

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const bootStarted = performance.now()
const provider = startStreamProvider({ models: [MODEL] })
const server = await startOpencodeServer({
  env: { OWN_OPEN_CODE: "1" },
  config: (paths) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(REPO_ROOT, "packages/own-accounts"),
          options: {
            home: paths.ownHome,
            buildId: `own-web-perf-${process.pid}`,
            vault: "memory",
            ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
            endpoints: { openai: provider.baseURL },
            // Never the real old-app control center (own.accounts' default): an empty directory in the temp root.
            codexImportRoot: path.join(paths.root, "legacy-control-center"),
          },
        },
        { package: path.join(REPO_ROOT, "packages/own-telemetry"), options: { home: paths.ownHome } },
      ],
      // The streaming session carries 2,000 messages; the benchmark measures rendering, not compaction.
      extra: { compaction: { auto: false } },
    }),
})
const serverBootMs = performance.now() - bootStarted

const control = path.join(server.paths.ownHome, "control")
await fs.mkdir(control, { recursive: true })

async function rpc(method: string, input: unknown, directory: string) {
  const response = await server.request("POST", `/api/rpc/own.accounts/${method}`, {
    body: { input },
    query: { "location[directory]": directory },
    directory,
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

const added = await rpc("accounts.add.key", { kind: "oai", label: "Alpha", key: FAKE_KEY }, control)
const account = added.account as { id: string; providerID: string }
const model = { providerID: account.providerID, id: MODEL }
await server.waitForModels([model])

// The import payload needs the server's own `Session.Info` shape (project, location): take it from an export.
const template = await server.createSession({ title: "perf template", model })
const exported = (await server.call("GET", `/api/experimental/session/${template.id}/export`)) as {
  data: { info: Record<string, unknown> }
}

type Imported = {
  readonly id: string
  readonly title: string
  readonly tag: string
  readonly turns: number
  readonly lastMarker: string
  readonly stats: HistoryStats
}

async function importSession(tag: string, title: string, turns: number, startMs: number): Promise<Imported> {
  const history = buildHistory({ tag, turns, model, startMs })
  const id = sessionID(tag, startMs)
  const info = {
    ...exported.data.info,
    id,
    title,
    model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: startMs, updated: startMs + turns * 60_000 },
  }
  delete (info as Record<string, unknown>).revert
  delete (info as Record<string, unknown>).parentID
  delete (info as Record<string, unknown>).fork
  await server.call("POST", "/api/experimental/session/import", {
    body: { info, messages: history.messages, location: { directory: server.paths.workspace } },
  })
  return { id, title, tag, turns, lastMarker: lastMarker(tag, turns), stats: history.stats }
}

const importStarted = performance.now()
const base = Date.UTC(2026, 5, 1)
const fillers = []
for (const index of Array.from({ length: FILLERS }, (_, item) => item))
  fillers.push(
    await importSession(`F${index}`, `짧은 세션 ${index + 1} · 결제 웹훅 재시도`, 3, base - (index + 1) * 86_400_000),
  )
const sessions = {
  a: await importSession("A", `긴 세션 A · 메시지 ${TURNS * 2}개`, TURNS, base),
  b: await importSession("B", `긴 세션 B · 메시지 ${TURNS * 2}개`, TURNS, base + 3_600_000),
  s: await importSession("S", `스트리밍 세션 · 메시지 ${TURNS * 2}개`, TURNS, base + 7_200_000),
  // The split-panes bench streams into these two. A turn it streamed into B or S ended their history with markers
  // the probes do not count: PF7's later repeats, switching to B, landed below B's last answer and never saw it, and
  // PF4 found no marker at S's end and measured no frames.
  t: await importSession("T", `분할 세션 T · 메시지 ${TURNS * 2}개`, TURNS, base + 10_800_000),
  u: await importSession("U", `분할 세션 U · 메시지 ${TURNS * 2}개`, TURNS, base + 14_400_000),
}
const importMs = performance.now() - importStarted
// The template only existed to learn the shape; archive-free cleanup keeps the list to the fixture.
await server.request("DELETE", `/api/session/${template.id}`).catch(() => undefined)

const password = atob(server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, { OWN_WEB_API_URL: server.url, OWN_WEB_API_PASSWORD: password })
const previewServer = await preview({
  configFile: path.join(PACKAGE, "vite.config.ts"),
  root: PACKAGE,
  preview: { port: PREVIEW_PORT, strictPort: true, host: "127.0.0.1" },
  build: { outDir: DIST },
  logLevel: "warn",
})

const state = {
  /** Temp root of the server and this pid: the next start removes the root if this process was force-killed. */
  root: server.paths.root,
  pid: process.pid,
  preview: `http://127.0.0.1:${PREVIEW_PORT}`,
  control,
  workspace: server.paths.workspace,
  account: { id: account.id, providerID: account.providerID, label: "Alpha" },
  model: MODEL,
  provider: { url: provider.url },
  sessions,
  fillers: fillers.map((item) => ({ id: item.id, title: item.title })),
  setup: {
    serverBootMs: Math.round(serverBootMs),
    importMs: Math.round(importMs),
    turns: TURNS,
    fillerSessions: FILLERS,
    transport: "vite-preview-proxy",
  },
}
await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
console.log(`OWN_WEB_PERF_READY ${JSON.stringify({ preview: state.preview, setup: state.setup })}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await Promise.allSettled([previewServer.close()])
  await server.stop()
  provider.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
// `stop` on stdin (run.ts) cleans up. Vite exits the process on stdin EOF by itself (its parent-exit listener), so an
// EOF alone skips this cleanup; the next start then removes the stale temp root.
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("stop")) void stop()
})
process.stdin.on("end", () => void stop())
process.stdin.resume()
