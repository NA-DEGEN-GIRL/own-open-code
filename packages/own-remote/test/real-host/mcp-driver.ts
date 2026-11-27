// Real-host MCP driver (04 §13 "MCP", MH 2026-11-26), bundled by i-mcp-hosts.test.ts (`bun build --target bun`) and
// run ON the host by the release's own Linux service program acting as bun (`BUN_BE_BUN=1 <opencode> driver.js`), in
// an isolated test root: HOME and the XDG folders point inside it, no own service starts, the user's host service and
// config are never touched. It runs own.accounts' host-side MCP code against the real Linux environment and prints one
// `MCPH_<KEY>=<json>` line per result:
//   PROBE: `mcp.host.probe` (runtimes on PATH with versions, docker access without sudo, the program acting as bun);
//   ANALYSIS: the shared rules over real-world-shaped definitions against that probe;
//   MISSING / SENT: the tiny fixture server installed with `~/…` paths, run by the program acting as bun, first without
//   its value (exits, `exited`), then with the value the PC would send (lists its tools);
//   FOLD: the config core would get (the value present, `BUN_BE_BUN` fixed);
//   PREFETCH: the pre-fetch plans (never run here: they would download);
//   LEFT: processes of the fixture still alive afterwards (none expected).
// Argument: the fixture's path on the host. Fake values only.
import os from "node:os"
import path from "node:path"
import { McpHostRules } from "@own/protocol/mcp-host-rules"
import { McpFold } from "../../../own-accounts/src/mcp/fold.js"
import { McpHostService } from "../../../own-accounts/src/mcp/host.js"
import type { Deps } from "../../../own-accounts/src/deps.js"
import type { RemoteHost } from "../../../own-accounts/src/remote/host.js"

const SECRET = "fake-real-host-mcp-key-00000000Rh5w"
const fixture = process.argv[2] ?? ""
const print = (key: string, value: unknown) => console.log(`MCPH_${key}=${JSON.stringify(value)}`)
const sent = new Map<string, Record<string, string>>()
const mcp: RemoteHost.Mcp = {
  values: async (server) => {
    const env = sent.get(server)
    return env ? { sent: true, env, headers: {} } : { sent: false, env: {}, headers: {} }
  },
  on: () => () => {},
}
const silent = { info() {}, warn() {}, error() {}, debug() {}, child: () => silent }
// SAFETY: the host service reads only these members of its deps (layout, broadcast, log, clock, emitter).
const deps = {
  runtime: { layout: { mcp: path.join(os.homedir(), "own-mcp-test", "mcp.json") }, broadcast: { emit() {} } },
  log: silent,
  clock: { now: () => Date.now() },
  emitter: { global: async () => {} },
} as unknown as Deps
const service = McpHostService.create(deps, mcp)

const probe = await service.probe({ binaries: ["git", "github-mcp-server", "surely-not-installed-xyz"] })
print("PROBE", probe)

const local = (name: string, command: string, args: string[], env: string[] = []): McpHostRules.Source => ({
  key: `own:${name}`,
  name,
  origin: "own",
  transport: { type: "local", command, args, env },
})
const sources = [
  local("memory", "npx", ["-y", "@modelcontextprotocol/server-memory"]),
  local("fetch", "uvx", ["mcp-server-fetch"]),
  local("time", "docker", ["run", "-i", "--rm", "mcp/time"]),
  local("files", "npx", ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\demo\\projects"]),
  local("bunx", "bunx", ["tiny-mcp@1.0.0"]),
  local("gh", "github-mcp-server", ["stdio"], ["GITHUB_PERSONAL_ACCESS_TOKEN"]),
  local("win", "C:\\Tools\\win-mcp.exe", []),
]
print(
  "ANALYSIS",
  sources.map((source) => {
    const analysis = McpHostRules.analyze(source, { home: "C:\\Users\\demo", probe })
    return {
      name: source.name,
      result: analysis.result,
      runtime: analysis.runtime,
      needs: analysis.needs,
      host: McpHostRules.translate(source, analysis, { probe }) ?? null,
    }
  }),
)

// The fixture as the PC would install it: the host's program acting as bun, the fixture under `~`.
const home = os.homedir()
const relative = path.posix.relative(home, fixture)
const saved = await service.save({
  name: "tiny",
  transport: {
    type: "local",
    command: probe.ownBun?.command ?? process.execPath,
    args: [`~/${relative}`, "lookup", "summarize"],
    env: ["API_KEY"],
    fixed: { BUN_BE_BUN: "1", FAKE_MCP_REQUIRE: "API_KEY" },
  },
  pc: { key: "own:tiny", hash: "0123456789abcdef", at: Date.now() },
})
if (!saved.ok) throw new Error(saved.error.type)
const server = saved.value.servers[0]!
print("SAVED", { args: server.transport.type === "local" ? server.transport.args : [], values: server.values })
const missing = await service.test(server.id)
print("MISSING", missing.ok ? missing.value : missing.error)
sent.set(server.id, { API_KEY: SECRET })
const withValue = await service.test(server.id)
print("SENT", withValue.ok ? withValue.value : withValue.error)
const view = await service.view()
print("VIEW", { values: view.servers[0]?.values, check: view.servers[0]?.check?.ok })
const stored = await Bun.file(deps.runtime.layout.mcp).text()
const entry = (JSON.parse(stored) as { servers: Parameters<typeof McpFold.config>[0]["entry"][] }).servers[0]!
const config = McpFold.config({ entry, values: { env: { API_KEY: SECRET }, headers: {} } })
print("FOLD", {
  command: config.type === "local" ? config.command.map((part) => (part === SECRET ? "<value>" : part)) : [],
  env: config.type === "local" ? Object.keys(config.environment ?? {}).toSorted() : [],
  valueInFile: stored.includes(SECRET),
})
print("PREFETCH", {
  npx: McpHostService.prefetchPlan({ type: "local", command: "npx", args: ["-y", "@scope/x@1.2.0"], env: [] }),
  uvx: McpHostService.prefetchPlan({ type: "local", command: "uvx", args: ["mcp-server-fetch==2025.1.17"], env: [] }),
})
await Bun.sleep(500)
const ps = Bun.spawnSync(["ps", "-u", String(process.getuid?.() ?? ""), "-o", "args="])
print(
  "LEFT",
  ps.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes(path.basename(fixture)) && !line.includes("driver.js")).length,
)
