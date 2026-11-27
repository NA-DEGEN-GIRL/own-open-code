// Service memory per Location (folder), without the UI: the release `opencode.exe` (or the source server) is started
// in a temp root, then Locations are activated one by one (a session in a new folder and a model list read there) and
// after each step the service's JavaScriptCore heap after a full GC, its RSS and the process's private bytes are
// recorded. `--plugins own` loads the release's own plugin bundles like the launcher does, `--plugins none` only the
// bench's heap sampler, so the difference is what the own plugins cost per Location. Fake credentials only.
//
//   bun scripts/many-sessions/locations.ts --app <release app dir> [--plugins own|none] [--without a,b]
//        [--steps 1,2,5,10,20]
//        [--idle-seconds 20] [--env NAME=VALUE …]
//        [--label locations] [--out <dir>]
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { randomBytes } from "node:crypto"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import { startOpencodeServer } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { startStreamProvider } from "../../../own-web/e2e/performance/fixture/stream-provider"
import { RPC_HASH } from "../../src/shared/rpc-hash"
import { installUi } from "../run-kit"
import { cpuBetween, startProcSampler } from "./proc"

const args = parseArgs({
  options: {
    app: { type: "string" },
    plugins: { type: "string", default: "own" },
    without: { type: "string" },
    steps: { type: "string", default: "1,2,5,10,20" },
    label: { type: "string", default: "locations" },
    out: { type: "string" },
    "idle-seconds": { type: "string", default: "20" },
    env: { type: "string", multiple: true },
  },
}).values
const app = path.resolve(args.app ?? "")
if (!existsSync(path.join(app, "opencode.exe"))) throw new Error(`--app: no opencode.exe in ${app}`)
const steps = args.steps!.split(",").map(Number)
const IDLE = Number(args["idle-seconds"])
/** `--env NAME=VALUE` (repeatable): extra service environment, e.g. allocator settings to compare. */
const extraEnv = Object.fromEntries(
  (args.env ?? []).map((item) => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]),
)
const outDir = path.resolve(args.out ?? path.join(os.tmpdir(), "own-many-sessions"))
mkdirSync(outDir, { recursive: true })
const log = (message: string) => console.error(`[locations] ${message}`)

const root = path.join(os.tmpdir(), `own-loc-${randomBytes(3).toString("hex")}`)
const ownHome = path.join(root, "own-home")
const heapFile = path.join(root, "service-heap.jsonl")
const version = (JSON.parse(readFileSync(path.join(app, "manifest.json"), "utf8")) as { version: string }).version
const pluginsDir = path.join(ownHome, "app", version, "plugins")
const OWN = [
  "own-accounts",
  "own-remote",
  "own-team",
  "claude-auth",
  "own-telemetry",
  "own-computer-use",
  "own-import",
  "own-harness",
]
mkdirSync(path.join(pluginsDir, "own-perf-heap"), { recursive: true })
cpSync(path.join(import.meta.dir, "heap-plugin", "index.ts"), path.join(pluginsDir, "own-perf-heap", "index.ts"))
// `--without a,b`: the release set minus those bundles, to see what one plugin costs per Location in context.
const selected = args.plugins === "own" ? OWN.filter((name) => !(args.without ?? "").split(",").includes(name)) : []
if (selected.length)
  for (const name of selected) cpSync(path.join(app, "plugins", name), path.join(pluginsDir, name), { recursive: true })
installUi(ownHome, { version, hash: RPC_HASH })
const provider = startStreamProvider({ models: ["gpt-5.5"] })
const plugins = [
  ...(selected.length
    ? selected.map((name) =>
        name === "own-accounts"
          ? {
              package: path.join(pluginsDir, name),
              options: {
                home: ownHome,
                vault: "memory",
                ratecardsSeed: path.join(app, "templates", "ratecards.default.json"),
                endpoints: { openai: provider.baseURL },
                codexImportRoot: path.join(root, "legacy-control-center"),
              },
            }
          : path.join(pluginsDir, name).replaceAll("\\", "/"),
      )
    : []),
  { package: path.join(pluginsDir, "own-perf-heap"), options: { out: heapFile } },
]
const service = await startOpencodeServer({
  root,
  env: { OWN_OPEN_CODE: "1", OWN_HOME: ownHome, CLAUDE_CONFIG_DIR: path.join(root, "claude-config"), ...extraEnv },
  startupTimeoutMs: 600_000,
  command: [path.join(app, "opencode.exe")],
  config: () => opencodeConfig({ providers: {}, plugins }),
})
const proc = startProcSampler()
const report: Record<string, unknown> = {
  label: args.label,
  plugins: args.plugins,
  without: args.without ?? null,
  env: extraEnv,
  version,
  date: new Date().toISOString(),
}
const points: Record<string, unknown>[] = []
report.points = points
try {
  const gcSample = async () => {
    writeFileSync(`${heapFile}.gc`, "1")
    for (let waited = 0; waited < 15_000 && existsSync(`${heapFile}.gc`); waited += 250) await Bun.sleep(250)
    await Bun.sleep(1_200)
    const lines = readFileSync(heapFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, number>)
    const last = lines.findLast((line) => line.gc) ?? lines.at(-1)!
    const sample = await proc.sample({ service: [service.pid] })
    const mb = (value: number) => Math.round((value / 1024 ** 2) * 10) / 10
    return {
      heapMB: mb(last.heapSize!),
      extraMB: mb(last.extraMemorySize!),
      rssMB: mb(last.rss!),
      objects: last.objectCount,
      moduleLoads: last.moduleLoads,
      setups: last.setups,
      pluginLocations: last.locations,
      privateMB: sample.roles.service?.privateBytes ?? null,
      wsMB: sample.roles.service?.ws ?? null,
    }
  }
  /** The service's CPU (% of one core) over `seconds` of doing nothing. */
  const idleCpu = async (seconds: number) => {
    const before = await proc.sample({ service: [service.pid] })
    await Bun.sleep(seconds * 1_000)
    const after = await proc.sample({ service: [service.pid] })
    return cpuBetween(before, after).service ?? null
  }
  // Plugins (the heap sampler among them) load with a Location: the service's own folder is the baseline, so every
  // point counts it as one Location more than `locations`.
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await service.request("GET", "/api/model")).ok) break
    await Bun.sleep(250)
  }
  for (let waited = 0; waited < 30_000 && !existsSync(heapFile); waited += 250) await Bun.sleep(250)
  await Bun.sleep(5_000)
  points.push({ locations: 0, idleCpu: await idleCpu(IDLE), ...(await gcSample()) })
  const directories: string[] = []
  const activationMs: number[] = []
  for (const target of steps) {
    while (directories.length < target) {
      const directory = path.join(service.paths.workspace, `loc-${String(directories.length + 1).padStart(2, "0")}`)
      mkdirSync(directory, { recursive: true })
      // A model list read activates the Location (it answers 503 while its plugins activate); then one session.
      const started = Date.now()
      for (let attempt = 0; attempt < 120; attempt++) {
        const response = await service.request("GET", "/api/model", { directory })
        if (response.ok) break
        await Bun.sleep(250)
      }
      activationMs.push(Date.now() - started)
      await service.createSession({ title: `loc ${directories.length + 1}`, directory })
      directories.push(directory)
    }
    await Bun.sleep(3_000)
    const point = { locations: target, idleCpu: await idleCpu(IDLE), ...(await gcSample()) }
    points.push(point)
    log(JSON.stringify(point))
  }
  report.activationMs = activationMs
  // Every activated Location evicted (`DELETE /api/debug/location`): what an idle-Location policy would give back.
  for (const directory of directories) await service.request("DELETE", "/api/debug/location", { directory })
  await Bun.sleep(5_000)
  await gcSample()
  const evicted = { locations: "evicted", idleCpu: await idleCpu(IDLE), ...(await gcSample()) }
  points.push(evicted)
  log(JSON.stringify(evicted))
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
