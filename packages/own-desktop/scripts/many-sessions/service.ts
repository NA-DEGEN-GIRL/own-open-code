// The bench service of perf-many-sessions.ts and service-stream.ts: the upstream server from source (own.accounts +
// own.telemetry, or every own plugin) or a release `opencode.exe` with the release's plugin bundles, in a temp root
// on a free port, plus the bench-only heap sampler; the fake provider in its own process; one API-key account; the
// session import of the perf fixture. Fake credentials only.
import { cpSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { opencodeConfig } from "../../../own-accounts/test/e2e-kit/harness/config"
import {
  REPO_ROOT,
  startOpencodeServer,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { buildHistory, lastMarker, sessionID } from "../../../own-web/e2e/performance/fixture/history"
import { RPC_HASH } from "../../src/shared/rpc-hash"
import { installUi, shellVersion } from "../run-kit"

export type ServiceMode = "source" | "source-full" | "release"

/** own.ps1 ManagedPlugins: the release's bundles in activation order. */
export const RELEASE_PLUGINS = [
  "own-accounts",
  "own-remote",
  "own-team",
  "claude-auth",
  "own-telemetry",
  "own-computer-use",
  "own-import",
  "own-harness",
]
/** `source-full`: every own plugin from source in the same order (claude-auth, a third-party bundle, left out). */
export const SOURCE_PLUGINS = [
  "own-accounts",
  "own-remote",
  "own-team",
  "own-telemetry",
  "own-computer-use",
  "own-import",
  "own-harness",
]

/**
 * Starts the service in `<root>\svc`. The root is fixed up front (the harness's `root` option) so its OWN_HOME holds
 * the installed-app layout before boot: own.accounts trusts only plugins under `<OWN_HOME>\app\<version>\plugins`
 * (02 §4.2; any other plugin path blocks account auth in that Location), so the heap sampler and, for `release`, the
 * release's bundles are copied there, as directories like own.ps1 writes them.
 */
export async function startBenchService(input: {
  readonly mode: ServiceMode
  /** Release app folder (`…\<version>\app`) for `release`. */
  readonly app?: string
  readonly root: string
  readonly heapFile: string
  readonly providerBaseURL: string
  readonly env?: Readonly<Record<string, string>>
}) {
  const serviceRoot = path.join(input.root, "svc")
  const ownHome = path.join(serviceRoot, "own-home")
  const release = input.mode === "release" ? input.app : undefined
  const appVersion = release
    ? (JSON.parse(readFileSync(path.join(release, "manifest.json"), "utf8")) as { version: string }).version
    : shellVersion()
  const pluginsDir = path.join(ownHome, "app", appVersion, "plugins")
  mkdirSync(path.join(pluginsDir, "own-perf-heap"), { recursive: true })
  cpSync(path.join(import.meta.dir, "heap-plugin", "index.ts"), path.join(pluginsDir, "own-perf-heap", "index.ts"))
  if (release)
    for (const name of RELEASE_PLUGINS)
      cpSync(path.join(release, "plugins", name), path.join(pluginsDir, name), { recursive: true })
  installUi(ownHome, { version: appVersion, hash: RPC_HASH })
  const accountsOptions = {
    home: ownHome,
    vault: "memory",
    ratecardsSeed: release
      ? path.join(release, "templates", "ratecards.default.json")
      : path.join(REPO_ROOT, "own/config/ratecards.default.json"),
    endpoints: { openai: input.providerBaseURL },
    codexImportRoot: path.join(serviceRoot, "legacy-control-center"),
    ...(release ? {} : { buildId: `own-many-${process.pid}` }),
  }
  const heapPlugin = { package: path.join(pluginsDir, "own-perf-heap"), options: { out: input.heapFile } }
  const source = (name: string) => path.join(REPO_ROOT, "packages", name)
  const plugins = release
    ? [
        ...RELEASE_PLUGINS.map((name) =>
          name === "own-accounts"
            ? { package: path.join(pluginsDir, name), options: accountsOptions }
            : path.join(pluginsDir, name).replaceAll("\\", "/"),
        ),
        heapPlugin,
      ]
    : [
        ...(input.mode === "source-full" ? SOURCE_PLUGINS : ["own-accounts", "own-telemetry"]).map((name) =>
          name === "own-accounts"
            ? { package: source(name), options: accountsOptions }
            : { package: source(name), options: { home: ownHome } },
        ),
        heapPlugin,
      ]
  const service: OpencodeServer = await startOpencodeServer({
    root: serviceRoot,
    env: {
      OWN_OPEN_CODE: "1",
      OWN_HOME: ownHome,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      // The release's Claude plugin and own.import read the Claude config folder: an empty one in the temp root.
      CLAUDE_CONFIG_DIR: path.join(serviceRoot, "claude-config"),
      ...input.env,
    },
    startupTimeoutMs: 600_000,
    ...(release ? { command: [path.join(release, "opencode.exe")] } : {}),
    config: () => opencodeConfig({ providers: {}, plugins, extra: { compaction: { auto: false } } }),
  })
  const control = path.join(ownHome, "control")
  mkdirSync(control, { recursive: true })
  return { service, serviceRoot, ownHome, appVersion, control }
}

/** One fake OpenAI API-key account (through own.accounts RPC); resolves when its model is listed. */
export async function addAccount(service: OpencodeServer, control: string, model: string) {
  const response = await service.request("POST", "/api/rpc/own.accounts/accounts.add.key", {
    body: { input: { kind: "oai", label: "Alpha", key: "sk-proj-ownManySessionsFakeKey0000000001" } },
    query: { "location[directory]": control },
    directory: control,
  })
  const body = (await response.json()) as { output?: { account?: { providerID: string } } }
  if (!response.ok || !body.output?.account)
    throw new Error(`accounts.add.key: ${response.status} ${JSON.stringify(body)}`)
  const ref = { providerID: body.output.account.providerID, id: model }
  await service.waitForModels([ref])
  return ref
}

/** Imports perf-fixture sessions (`POST /api/experimental/session/import`, the server's own `Session.Info` shape). */
export async function sessionImporter(service: OpencodeServer, model: { providerID: string; id: string }) {
  const template = await service.createSession({ title: "template", model })
  const exported = (await service.call("GET", `/api/experimental/session/${template.id}/export`)) as {
    data: { info: Record<string, unknown> }
  }
  await service.request("DELETE", `/api/session/${template.id}`).catch(() => undefined)
  return async (tag: string, title: string, turns: number, startMs: number, directory: string) => {
    const history = buildHistory({ tag, turns, model, startMs })
    const id = sessionID(tag, startMs)
    const info: Record<string, unknown> = {
      ...exported.data.info,
      id,
      title,
      model,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: startMs, updated: startMs + turns * 60_000 },
    }
    delete info.revert
    delete info.parentID
    delete info.fork
    await service.call("POST", "/api/experimental/session/import", {
      body: { info, messages: history.messages, location: { directory } },
      directory,
    })
    return { id, tag, title, directory, last: lastMarker(tag, turns) }
  }
}

/** The paced fake provider (many-sessions/provider.ts) in its own Bun process. */
export async function providerProcess(model: string) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "provider.ts"), model], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("fake provider process ended before it was ready")
    text += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
  const ready = JSON.parse(text.slice(0, text.indexOf("\n"))) as { url: string; baseURL: string }
  return {
    ...ready,
    pid: child.pid,
    stop: () => {
      void Promise.resolve(child.stdin.end()).catch(() => undefined)
      setTimeout(() => child.kill(), 3_000).unref()
    },
  }
}
