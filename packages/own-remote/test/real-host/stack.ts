/**
 * The full local stack of the real-host phase B (and of own-web's `e2e/remote-real`): this PC's RELEASE service
 * (`app\opencode.exe`, same version and build id as the remote tarball, so the broker runs in normal mode) with
 * own-accounts (local, memory vault, fake accounts only) and own-remote (local, the real ssh.exe and the temp ssh
 * files of env.ts), the fake providers on 127.0.0.1, and an egress sink.
 *
 *   fake OpenAI-compatible chat ── 127.0.0.1:P ◀─ ssh -R 127.0.0.1:P ── host: compat slots' baseURL http://127.0.0.1:P/v1
 *   egress sink (HTTPS_PROXY)  ── 127.0.0.1:X ◀─ ssh -R 127.0.0.1:X ── host: the service's HTTPS_PROXY (phase A env)
 *
 * The sink answers every request (CONNECT or plain HTTP) with 403 and records only the request line: any https the
 * remote service tries (a real provider, a download) is visible here and never leaves the host.
 *
 * own-remote's bundle is rebuilt from source with the release's version and build id (`localPlugins()`), so fixes in
 * packages/own-remote run; own-accounts is the release bundle as is.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import {
  chatGPTAccount,
  mintChatGPTTokens,
  opencodeConfig,
  startFakeCodex,
  startFakeOpenAIChat,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type FakeCodex,
  type FakeOpenAIChat,
  type LegacyProfile,
  type OpencodeServer,
  type Responder,
} from "../../../own-accounts/test/e2e-kit"
import * as Env from "./env.js"

export const MODEL = "fake-chat"
/** Fake API keys of the PC-only accounts (never real credentials). RG10 scans the host for them. */
export const KEYS = {
  Alpha: "sk-ownRealHostAlphaFakeKey0000000000000001",
  Bravo: "sk-ownRealHostBravoFakeKey0000000000000002",
} as const
export const LEASE_MS = 10_000
export const BROKER_WAIT_MS = 2_000
export const LINKED = chatGPTAccount({ accountID: "acct-own-real-host-linked" })

type Json = Record<string, any>

export interface Sink {
  readonly port: number
  readonly lines: string[]
  close(): void
}

/** The egress sink: request line recorded, 403, closed. Never forwards anything. */
export function startSink(port: number): Promise<Sink> {
  const lines: string[] = []
  const server = net.createServer((socket) => {
    let head = ""
    socket.setEncoding("latin1")
    socket.on("data", (chunk: string) => {
      head += chunk
      const end = head.indexOf("\r\n")
      if (end < 0 && head.length < 4096) return
      lines.push(`${new Date().toISOString()} ${head.slice(0, end < 0 ? 200 : Math.min(end, 200))}`)
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
    })
    socket.on("error", () => {})
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      resolve({ port, lines, close: () => server.close() }),
    )
  })
}

/**
 * own-remote rebuilt from this tree with the release's version and build id; own-accounts copied from the release.
 * Both go where an install puts them (`<OWN_HOME>\app\<version>\plugins`, named by `app\current.json`, 01 §5.1):
 * own-accounts' project-plugin gate trusts own plugins by that root and would otherwise block credential injection in
 * every local Location.
 */
export function localPlugins() {
  const version = path.join(Env.OWN_HOME, "app", Env.VERSION)
  const dir = path.join(version, "plugins")
  fs.mkdirSync(version, { recursive: true })
  fs.copyFileSync(path.join(Env.APP, "manifest.json"), path.join(version, "manifest.json"))
  fs.writeFileSync(
    path.join(Env.OWN_HOME, "app", "current.json"),
    JSON.stringify({ schema: 1, version: Env.VERSION, path: version, previous: null, updatedAt: new Date().toISOString() }),
  )
  const manifest = JSON.parse(fs.readFileSync(path.join(Env.APP, "remote", "manifest.json"), "utf8")) as Json
  const built = spawnSync(
    process.execPath,
    [
      path.join(Env.REPO, "packages", "own-remote", "script", "bundle.ts"),
      "plugins",
      "--version",
      Env.VERSION,
      "--build-id",
      String(manifest.build_id),
      "--out",
      dir,
      "--packages",
      "own-remote",
    ],
    { encoding: "utf8", windowsHide: true },
  )
  if (built.status !== 0) throw new Error(`plugin bundle failed: ${built.stderr}`)
  fs.cpSync(path.join(Env.APP, "plugins", "own-accounts"), path.join(dir, "own-accounts"), { recursive: true })
  return { dir, buildId: String(manifest.build_id) }
}

export interface Stack {
  readonly server: OpencodeServer
  readonly chat: FakeOpenAIChat
  readonly codex: FakeCodex
  readonly sink: Sink
  readonly forwards: ReturnType<typeof Env.forwardProcess>
  readonly control: string
  readonly hostId: string
  readonly linked: LegacyProfile
  readonly serverRoot: string
  readonly config: (paths: { ownHome: string }) => unknown
  local(id: string, method: string, input?: unknown): Promise<Json>
  localRaw(id: string, method: string, input?: unknown): Promise<{ status: number; body: Json }>
  restart(): Promise<OpencodeServer>
  stop(): Promise<void>
}

export async function startStack(
  input: {
    readonly ownerTimeoutMs?: number
    readonly responder?: Responder
    /**
     * Phase D (04 §8.11): this PC's Claude subscription slot. `bundle` is the bundled claude-auth's folder (02 §8.2,
     * loaded after the own plugins, as the slot is), `upstream` the loopback fake the egress relay sends to instead of
     * api.anthropic.com.
     */
    readonly claude?: { readonly bundle: string; readonly upstream: string }
    /** Extra env of this PC's service (phase D: the fake Claude Code home, the proxy sink, a PATH without `claude`). */
    readonly env?: Readonly<Record<string, string>>
    /** More own-accounts endpoints of this PC (phase C: the fake GitHub's `github`, `githubApi`, `githubMcp`). */
    readonly endpoints?: Readonly<Record<string, string>>
    /** More ports of this PC the host reaches by an `ssh -R` of the same number (phase C: the fake GitHub). */
    readonly forward?: ReadonlyArray<number>
    /** Phase C creator items (17 §10): the release's own-creator on this PC, last, with this PC's OWN_HOME. */
    readonly creator?: boolean
  } = {},
): Promise<Stack> {
  Env.assertApproved()
  Env.prepareSshFiles()
  const ports = await Env.ports()
  const hostId = fs.readFileSync(path.join(Env.ROOT, "host-id"), "utf8").trim()
  const chat = startFakeOpenAIChat({
    port: ports.provider,
    models: [MODEL],
    credentials: { [KEYS.Alpha]: { domain: "alpha" }, [KEYS.Bravo]: { domain: "bravo" } },
    ...(input.responder ? { responder: input.responder } : {}),
  })
  const codex = startFakeCodex({ port: ports.codex, accounts: [LINKED] })
  const sink = await startSink(ports.sink)
  const forwards = Env.forwardProcess([
    "-R",
    `127.0.0.1:${ports.provider}:127.0.0.1:${ports.provider}`,
    "-R",
    `127.0.0.1:${ports.sink}:127.0.0.1:${ports.sink}`,
    ...(input.forward ?? []).flatMap((port) => ["-R", `127.0.0.1:${port}:127.0.0.1:${port}`]),
  ])
  // A linked Codex login of the old app's layout, FAKE tokens, 6 minutes left (below the 7-minute minimum, 04 §8.5).
  const legacyRoot = path.join(Env.ROOT, "legacy-control-center")
  fs.rmSync(legacyRoot, { recursive: true, force: true })
  const [linked] = await writeCodexMultiProviderProfiles(legacyRoot, [
    { id: "07", alias: "real-host-linked", tokens: mintChatGPTTokens(LINKED, Date.now(), 6 * 60_000) },
  ])
  const plugins = localPlugins()
  const serverRoot = path.join(Env.ROOT, "local-server")
  fs.mkdirSync(serverRoot, { recursive: true })
  const config = (paths: { ownHome: string }) =>
    opencodeConfig({
      providers: {},
      plugins: [
        {
          package: path.join(plugins.dir, "own-accounts"),
          options: {
            home: paths.ownHome,
            vault: "memory",
            ratecardsSeed: path.join(Env.APP, "templates", "ratecards.default.json"),
            codexImportRoot: legacyRoot,
            // Local Codex traffic (none expected) and the usage poller go to fakes/the sink, never to chatgpt.com.
            endpoints: {
              codex: codex.baseURL,
              oauthIssuer: codex.url,
              chatgpt: `http://127.0.0.1:${ports.sink}`,
              ...input.endpoints,
            },
            broker: {
              leaseMs: LEASE_MS,
              brokerWaitMs: BROKER_WAIT_MS,
              ...(input.claude ? { claudeUpstream: input.claude.upstream } : {}),
            },
          },
        },
        {
          package: path.join(plugins.dir, "own-remote"),
          options: {
            home: paths.ownHome,
            sshCommand: Env.sshCommand(),
            askpassHelper: path.join(Env.APP, "opencode.exe"),
            remoteBundles: path.join(Env.APP, "remote"),
            sshDir: Env.SSH_DIR,
            keepIntervalSeconds: 5,
            readyTimeoutMs: 60_000,
            backoffMs: [3_000, 5_000, 10_000],
            ownerTimeoutMs: input.ownerTimeoutMs ?? 600_000,
            lingerSeconds: 0,
            // The run's test root on the host (decisions RL35): never a real install's paths or port.
            remoteTest: { root: Env.hostRun().root, port: Env.hostRun().port },
            // This PC's own Tailscale is no part of the gates: while it runs, the gateway's pairing link would name the
            // tailnet's https origin instead of the loopback listener phase C pairs through (RL5).
            gateway: { tailscaleCommand: null },
          },
        },
        ...(input.claude ? [input.claude.bundle] : []),
        ...(input.creator ? [{ package: path.join(Env.APP, "plugins", "own-creator"), options: { home: paths.ownHome } }] : []),
      ],
    })
  const boot = () =>
    startOpencodeServer({
      command: [path.join(Env.APP, "opencode.exe")],
      root: serverRoot,
      env: { ...input.env, OWN_OPEN_CODE: "1" },
      startupTimeoutMs: 180_000,
      config: () => config({ ownHome: Env.OWN_HOME }),
    })
  let server = await boot()
  const control = path.join(Env.OWN_HOME, "control")
  fs.mkdirSync(control, { recursive: true })
  const localRaw = async (id: string, method: string, body: unknown = {}) => {
    const response = await server.request("POST", `/api/rpc/${id}/${method}`, {
      body: { input: body },
      query: { "location[directory]": control },
      directory: control,
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json }
  }
  const stack: Stack = {
    get server() {
      return server
    },
    chat,
    codex,
    sink,
    forwards,
    control,
    hostId,
    linked: linked!,
    serverRoot,
    config,
    localRaw,
    local: async (id, method, body = {}) => {
      const result = await localRaw(id, method, body)
      if (result.status !== 200) throw new Error(`${id}/${method}: ${result.status} ${JSON.stringify(result.body)}`)
      return result.body.output as Json
    },
    restart: async () => {
      server = await boot()
      return server
    },
    stop: async () => {
      await server.stop().catch(() => {})
      forwards.stop()
      sink.close()
      await chat.stop().catch(() => {})
      await codex.stop().catch(() => {})
    },
  }
  return stack
}

/**
 * The fake compat account `label` on this PC. own-accounts runs with the memory vault, so an account of an earlier
 * run lost its key: it gets the key back (`accounts.update{replaceKey}`) and keeps its providerID, which the host's
 * sessions of earlier runs name; otherwise it is added.
 */
export async function ensureCompat(stack: Stack, label: keyof typeof KEYS) {
  const ports = await Env.ports()
  const baseURL = `http://127.0.0.1:${ports.provider}/v1`
  const listed = (await stack.local("own.accounts", "accounts.list")).accounts as Json[]
  const existing = listed.find((account) => account.kind === "compat" && account.label === label && account.status !== "retired")
  if (existing) {
    await stack.local("own.accounts", "accounts.update", { accountID: existing.id, replaceKey: KEYS[label] })
    return existing
  }
  const added = await stack.local("own.accounts", "accounts.add.key", {
    kind: "compat",
    label,
    key: KEYS[label],
    options: { baseURL, models: [{ id: MODEL, contextLimit: 64_000 }] },
  })
  return added.account as Json
}

/** A client of the remote service: through own-remote's tunnel (resolved url) or a helper `-L` (`direct`). */
export function remoteClient(input: { url: string; token: string; direct?: string }) {
  return async (
    method: string,
    route: string,
    options: { body?: unknown; directory?: string; via?: "tunnel" | "direct" } = {},
  ) => {
    const base = options.via === "direct" ? input.direct! : input.url
    const url = new URL(route, base)
    if (route.startsWith("/api/rpc/") && options.directory) url.searchParams.set("location[directory]", options.directory)
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Basic ${btoa(`opencode:${input.token}`)}`,
        ...(options.directory ? { "x-opencode-directory": encodeURIComponent(options.directory) } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    let body: Json | undefined
    try {
      body = text ? (JSON.parse(text) as Json) : undefined
    } catch {
      body = { text }
    }
    return { status: response.status, body: body as Json }
  }
}

export async function until<T>(read: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try {
      const value = await read()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > deadline) throw new Error(`timeout${last ? `: ${String(last)}` : ""}`)
    await Bun.sleep(stepMs)
  }
}
