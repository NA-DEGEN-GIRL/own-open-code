// Team e2e harness (06 §11.2 e2e-kit): the upstream server from source with own-accounts and own-team loaded from their
// package directories (06 §2.6 development config, own.team third after own.accounts), booted through own-accounts'
// e2e kit (imported read-only). Every model call goes to a local fake answered by the directive responder
// (`directives.ts`): one fake Codex backend with ChatGPT accounts 01, 02 and 03 (linked codex-multi-provider profiles,
// told apart by `chatgpt-account-id`), a fake DeepSeek (metered `ds` account) and a fake Anthropic (metered `anth`
// account). The team project is a temp git repository from the own-team git fixtures (F1 by default, F2 with LFS).
// With `siwc` the registry also holds Sign in with ChatGPT accounts of a seeded ChatGPT login (no credential: R4 reads
// their login, and their OpenAI endpoint is the local fake, so nothing they could send leaves this PC).
// With `claude: true` the Claude subscription slot is there too (02 §8): a fake of the bundled claude-auth (own-accounts'
// `writeFakeClaudeAuth`: the app's folder layout with its `own-bundle.json`, the plugin id and no-op hooks, nothing
// downloaded) in the app folder's `plugins\claude-auth`, fourth in the plugin order, and the `anthropic` provider
// pointed at the fake Anthropic with a fake key, so the slot's account `acc_claude_slot` (kind `claude-sub`) is listed
// and a turn on it never leaves this PC. The plugin ships with the app, so nothing is acknowledged (02 §8.2).
//
// With `claudeAgent: true` the registry holds a Claude Agent account (02 §8.10, `claudeAgents`) whose folder under
// OWN_HOME has a fake login (`.credentials.json`, which own only checks exists, and `.claude.json`'s `oauthAccount`), so
// own-accounts enables upstream's built-in `claude-agent` provider on that folder; `OPENCODE_CLAUDE_PATH` names the
// fake `claude` (`fake-claude.ts`, run by the Agent SDK with Bun), whose model steps the directive responder answers.
// Bun's own folder goes first on PATH: the SDK starts the fake as `bun <file>`, and the first `bun` on this PC's PATH
// is a `bun.cmd` shim that refuses the SDK's JSON arguments.
//
// With `importer: true` own-import loads last (09 §5.1, after own-computer-use when that is on) with the `roots` the
// test gives (fixture folders written by own-import's `test/fixtures`), and the server's CODEX_HOME and
// CLAUDE_CONFIG_DIR name empty folders of the temp root, so neither the plugin nor anything else in the server reads
// this PC's `~/.codex` or `~/.claude`. Without it nothing changes.
//
// own.team reaches the service over self-HTTP (06 §2.6) through its `service` plugin option. The service URL and
// password are only known after the boot, so the option names a loopback proxy started first that forwards each call
// with the real password once the server is up and records it (`service.calls`). own.import gets its own password for
// the same proxy. The channel's registration file (`ServiceTarget.Service`, read by own-accounts for the preset
// guidance entry) points at the same proxy.
//
// Isolation: a temp root holds OWN_HOME, the project, the fake control center and the opencode home/config/data (the
// kit points HOME, XDG_*, LOCALAPPDATA and CODEX_HOME there); credentials are fake (the seeded vault helper of
// own-accounts' tests stands in for own-vault.exe); this PC's `.codex`, old-app profiles and vault are never read.
// Every listener binds 127.0.0.1. Run from a path without '#'.

import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { Kind, OwnAccounts, OwnImport, OwnTeam, Preset } from "@own/protocol"
import { CodexSource, Hash, Home, ServiceTarget } from "@own/runtime"
import {
  anthropicProvider,
  opencodeConfig,
  recordServerEvents,
  REPO_ROOT,
  startFakeAnthropic,
  startFakeCodex,
  startFakeOpenAIChat,
  startOpencodeServer,
  writeCodexMultiProviderProfiles,
  type ChatGPTTokens,
  type EventRecorder,
  type FakeAnthropic,
  type FakeCodex,
  type FakeOpenAIChat,
  type ModelRef,
  type OpencodeServer,
  type RecordedRequest,
  type Responder,
} from "../../../own-accounts/test/e2e-kit"
import { writeFakeClaudeAuth } from "../../../own-accounts/test/support/fake-claude-auth.js"
import { MODELS_FILE, type FakeModel } from "./fake-claude.js"
import { registryWith } from "../../../own-accounts/test/slots/support.js"
import { f2 } from "../fixtures/lfs-repo.js"
import { f1 } from "../fixtures/repo.js"
import { removeTree } from "../support/remove.js"
import { responder, turn } from "./directives.js"
import { kv } from "./inspect.js"
import { BOOT_TIMEOUT } from "./timeouts.js"

export { BOOT_TIMEOUT }

export const ACCOUNTS_PACKAGE = path.join(REPO_ROOT, "packages/own-accounts")
export const TEAM_PACKAGE = path.join(REPO_ROOT, "packages/own-team")
export const COMPUTER_PACKAGE = path.join(REPO_ROOT, "packages/own-computer-use")
export const IMPORT_PACKAGE = path.join(REPO_ROOT, "packages/own-import")
/** own-accounts' stand-in for own-vault.exe: an in-memory vault seeded from a JSON file (fake keys only). */
const VAULT_HELPER = path.join(REPO_ROOT, "packages/own-accounts/test/slots-auth/fixture/seed-vault-helper.ts")

export const TURN_TIMEOUT = 120_000

/** The ChatGPT accounts of the fake Codex backend (fake ids). */
export const CHATGPT = {
  "01": { accountID: "acct-team-01", email: "one@example.test", plan: "plus" },
  "02": { accountID: "acct-team-02", email: "two@example.test", plan: "plus" },
  "03": { accountID: "acct-team-03", email: "three@example.test", plan: "plus" },
} as const
export type ChatGPT = keyof typeof CHATGPT
const CHATGPT_IDS: ReadonlyArray<ChatGPT> = ["01", "02", "03"]

/** The metered accounts and their fake API keys. */
export const DEEPSEEK = { slug: "tmds", label: "DeepSeek", key: "sk-fake-team-e2e-deepseek-0001" } as const
export const ANTHROPIC = { slug: "tman", label: "Anthropic", key: "sk-ant-fake-team-e2e-0001" } as const

/** Provider slots of the seeded accounts (02 §2.2 `own-<kind>-<slug>`). */
export const SLOT = {
  "01": Kind.ProviderID.from("codex", "tm01"),
  "02": Kind.ProviderID.from("codex", "tm02"),
  "03": Kind.ProviderID.from("codex", "tm03"),
  deepseek: Kind.ProviderID.from("ds", DEEPSEEK.slug),
  anthropic: Kind.ProviderID.from("anth", ANTHROPIC.slug),
} as const

/** One model of each slot, from own-accounts' bundled templates (Codex takes no gpt-5.5 for ChatGPT accounts since upstream v2.1). */
export const MODEL = {
  "01": { providerID: SLOT["01"], id: "gpt-5.6-sol" },
  "02": { providerID: SLOT["02"], id: "gpt-5.6-sol" },
  "03": { providerID: SLOT["03"], id: "gpt-5.6-sol" },
  deepseek: { providerID: SLOT.deepseek, id: "deepseek-flash" },
  anthropic: { providerID: SLOT.anthropic, id: "claude-sonnet-4-5" },
} as const satisfies Record<string, ModelRef>

/**
 * The Claude subscription slot (`claude: true`): its account, the `anthropic` provider's model the fake answers, and
 * the fake key the config provider sends instead of a Claude login.
 */
export const CLAUDE = {
  accountID: "acc_claude_slot",
  model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
  key: "sk-ant-fake-team-e2e-claude-slot-0001",
} as const

/**
 * The Claude Agent account (`claudeAgent: true`): its id, the login the fake folder holds, and a model the fake
 * `claude` lists (`fake-claude.ts` `MODELS`).
 */
export const CLAUDE_AGENT = {
  accountID: "acc_claude_agent",
  email: "agent@example.test",
  accountUuid: "uuid-agent",
  model: { providerID: "claude-agent", id: "haiku" },
} as const

/** The second Claude Agent account (`claudeAgent: 2`, 02 §8.10 phase 2): another login, the same Claude Code. */
export const CLAUDE_AGENT_B = {
  accountID: "acc_claude_agent_b",
  email: "agent-b@example.test",
  accountUuid: "uuid-agent-b",
} as const

/** The fake `claude` the Agent SDK runs (`claudeAgent: true`). */
export const FAKE_CLAUDE = path.join(TEAM_PACKAGE, "test", "e2e", "fake-claude.ts")

/** A Claude Agent account's folder (its `CLAUDE_CONFIG_DIR`, the first account's by default), where the route keeps it. */
export function claudeAgentFolder(ownHome: string, accountID: string = CLAUDE_AGENT.accountID) {
  return path.join(Home.layout(ownHome).claudeAgent, "accounts", accountID)
}

/** The shared transcript folder every Claude Agent account's `projects` links to (02 §8.10 phase 2). */
export function claudeAgentTranscripts(ownHome: string) {
  return path.join(Home.layout(ownHome).claudeAgent, "projects")
}

/** Registry account ids of the seeded accounts (`acc_<slug>`). */
export const ACCOUNT = {
  "01": "acc_tm01",
  "02": "acc_tm02",
  "03": "acc_tm03",
  deepseek: `acc_${DEEPSEEK.slug}`,
  anthropic: `acc_${ANTHROPIC.slug}`,
  claude: CLAUDE.accountID,
} as const

/** The model a seeded `siwc` account (`siwc` option) offers, from its bundled template. */
export function siwcModel(slug: string): ModelRef {
  return { providerID: Kind.ProviderID.from("siwc", slug), id: "gpt-5.5" }
}

/** `identity` the fake Codex attributes requests of ChatGPT account `id` to. */
export function codexIdentity(id: ChatGPT) {
  return `codex:${CHATGPT[id].accountID}`
}

// ---------------------------------------------------------------------------------------------------------------
// Fakes

export interface TeamFakes {
  readonly codex: FakeCodex
  readonly deepseek: FakeOpenAIChat
  readonly anthropic: FakeAnthropic
  /** The fake ChatGPT logins of {@link CHATGPT}. */
  readonly tokens: Readonly<Record<ChatGPT, ChatGPTTokens>>
  stop(): Promise<void>
}

/** The fake providers, answered by `responder` (default: the directive responder) when their queue is empty. */
export function startTeamFakes(options: { readonly responder?: Responder } = {}): TeamFakes {
  const respond = options.responder ?? responder()
  // Small cache blocks so short test prompts still show hits and misses (e2e kit README).
  const cache = { minTokens: 0, blockTokens: 32 }
  const codex = startFakeCodex({ cache, responder: respond })
  const deepseek = startFakeOpenAIChat({ cache, responder: respond })
  const anthropic = startFakeAnthropic({ cache, responder: respond })
  const tokens = {
    "01": codex.login(CHATGPT["01"]),
    "02": codex.login(CHATGPT["02"]),
    "03": codex.login(CHATGPT["03"]),
  }
  return {
    codex,
    deepseek,
    anthropic,
    tokens,
    stop: async () => {
      await Promise.all([codex.stop(), deepseek.stop(), anthropic.stop()])
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Self-HTTP proxy

export interface ServiceCall {
  /**
   * `own.team` or `own.import` (their `service` options) or `registration` (the channel's registration file:
   * own-accounts).
   */
  readonly caller: "own.team" | "own.import" | "registration"
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  /** The JSON request body, when there is one. */
  readonly body: unknown
  /** The service's answer; 503 while no server is up. */
  readonly status: number
}

export interface ServiceProxy {
  readonly url: string
  /** Every forwarded call, in arrival order. */
  readonly calls: ReadonlyArray<ServiceCall>
  /** own.team's `service` option. */
  readonly option: { readonly url: string; readonly password: string }
  /** own.import's `service` option (`importer: true`). */
  readonly importOption: { readonly url: string; readonly password: string }
  /** The registration file's content. */
  readonly registration: { readonly url: string; readonly password: string }
  /** Where calls go from now on; `undefined` answers 503 (between a stop and the next boot). */
  target(server: Pick<OpencodeServer, "url" | "authorization"> | undefined): void
  stop(): Promise<void>
}

/** Hop-by-hop and body-framing headers the proxy does not copy. */
const DROPPED = new Set([
  "authorization",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "content-encoding",
])

/** A loopback proxy in front of the service (see the file header); the passwords are fresh fake test values. */
export function startServiceProxy(): ServiceProxy {
  const passwords = {
    team: randomBytes(18).toString("base64url"),
    import: randomBytes(18).toString("base64url"),
    registration: randomBytes(18).toString("base64url"),
  }
  const callers = new Map<string, ServiceCall["caller"]>([
    [ServiceTarget.basic(passwords.team), "own.team"],
    [ServiceTarget.basic(passwords.import), "own.import"],
    [ServiceTarget.basic(passwords.registration), "registration"],
  ])
  const calls: ServiceCall[] = []
  const state: { target?: Pick<OpencodeServer, "url" | "authorization"> } = {}
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const caller = callers.get(request.headers.get("authorization") ?? "")
      if (!caller) return Response.json({ _tag: "Unauthorized", message: "unauthorized" }, { status: 401 })
      const url = new URL(request.url)
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      const record = (status: number) =>
        calls.push({
          caller,
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          body: body === undefined ? undefined : json(new TextDecoder().decode(body)),
          status,
        })
      const target = state.target
      if (!target) {
        record(503)
        return Response.json({ _tag: "ServiceUnavailable", message: "no server" }, { status: 503 })
      }
      const headers = new Headers(
        [...request.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase())),
      )
      headers.set("authorization", target.authorization)
      // A server killed mid-call (`restart({kill: true})`) answers nothing: own.team sees a 502, like a gateway would.
      // own.team's calls all end (no followed stream), so the answer is read whole here. Each call goes on a socket of
      // its own (RH-43): a server busy booting its Locations closes pooled keep-alive sockets late, and a call written
      // onto one fails without an answer; own.team would repeat that one itself (`SessionHttp`), but behind this hop it
      // only sees the 502. Production has no such hop: own.team calls the service directly.
      const answer = await fetch(new URL(url.pathname + url.search, target.url), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        keepalive: false,
      })
        .then(async (response) => ({ response, body: await response.arrayBuffer() }))
        .catch((error: unknown) => ({ error }))
      if ("error" in answer) {
        record(502)
        const why = isRecord(answer.error) && typeof answer.error.code === "string" ? ` (${answer.error.code})` : ""
        return Response.json({ _tag: "BadGateway", message: `the server went away${why}` }, { status: 502 })
      }
      record(answer.response.status)
      return new Response(answer.body, {
        status: answer.response.status,
        headers: [...answer.response.headers.entries()].filter((entry) => !DROPPED.has(entry[0].toLowerCase())),
      })
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  return {
    url,
    calls,
    option: { url, password: passwords.team },
    importOption: { url, password: passwords.import },
    registration: { url, password: passwords.registration },
    target: (next) => {
      state.target = next
    },
    stop: async () => {
      await server.stop(true)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Server

/** The team project: F1 (default), F2 (LFS, needs git-lfs), none, or a builder that returns the main folder. */
export type Project = "f1" | "f2" | "none" | ((root: string) => string)

export interface TeamServerOptions {
  /** Names the temp root and the build id. */
  readonly name: string
  /** Load own-team (default). `false`: the same server without it (TG16's comparison). */
  readonly team?: boolean
  /** Also load own-computer-use (sixth slot, 06 §2.6) with the in-memory desktop (`driver: "fake"`). */
  readonly computerUse?: boolean
  /** Merged over own-computer-use's options (`policy: {allowSubagents}`, …). */
  readonly computerOptions?: Readonly<Record<string, unknown>>
  /** Also load own-import, last (09 §5.1, see the file header). Needs {@link importOptions} with `roots`. */
  readonly importer?: boolean
  /** Merged over own-import's `{home, buildId, service}`. */
  readonly importOptions?: ImportOptions
  /** The own-import folder to load: its package (default) or a built bundle folder (`plugins/own-import`). */
  readonly importPackage?: string
  /** The Claude subscription slot (see the file header): a fake of the bundled claude-auth, fourth. */
  readonly claude?: boolean
  /** A Claude Agent account on the fake `claude` (see the file header); `2`: a second one too (phase 2). */
  readonly claudeAgent?: boolean | 2
  /** The models the fake `claude` lists on the Claude Agent accounts (`fake-claude.ts` `MODELS_FILE`); else its own. */
  readonly claudeAgentModels?: ReadonlyArray<FakeModel>
  /**
   * `siwc` accounts kept in the registry only (see the file header): slug `own-siwc-<slug>` and the ChatGPT account
   * whose login it shares (07 §5.4: one subscription with it).
   */
  readonly siwc?: ReadonlyArray<{ readonly slug: string; readonly of: ChatGPT }>
  /** Keep core's config watcher on: a config file edit reloads the plugins after the first changed entry (TG1). */
  readonly watchConfig?: boolean
  readonly project?: Project
  /** Shared fakes (several servers in one test); otherwise the server starts and stops its own. */
  readonly fakes?: TeamFakes
  /** Merged over the harness's plugin options. */
  readonly accountsOptions?: Readonly<Record<string, unknown>>
  /** More own-accounts endpoints (fakes of the web search services, …), merged over the harness's fakes. */
  readonly accountsEndpoints?: Readonly<Record<string, string>>
  readonly teamOptions?: Readonly<Record<string, unknown>>
  /** Extra top-level opencode config (agents, …). */
  readonly config?: Readonly<Record<string, unknown>>
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Keep the temp root after `stop()`. Also `OWN_E2E_KEEP=1`. */
  readonly keepTemp?: boolean
  /** Mirror server logs to stderr. Also `OWN_E2E_LOGS=1`. */
  readonly printLogs?: boolean
  /**
   * The seeded ChatGPT slots' transport (default: own-accounts' `websocket`). `http` for an endpoint that only proxies
   * HTTP, like the live harness test's credential forwarder (own-harness `script/live/team.ts`).
   */
  readonly codexTransport?: "http" | "websocket"
  /**
   * More plugins after the others (own-harness goes last, own-accounts `plugins/inventory.ts`); a function gets the
   * harness's `OWN_HOME` for plugins that take it (own-creator's store, MR14).
   */
  readonly plugins?: ReadonlyArray<ExtraPlugin> | ((ownHome: string) => ReadonlyArray<ExtraPlugin>)
}

export interface ExtraPlugin {
  readonly package: string
  readonly options: Readonly<Record<string, unknown>>
}

/**
 * own-import's plugin options in the harness. `roots` is required and replaces both kinds' default roots, so the plugin
 * reads only the folders a test wrote (09 §7.3); an empty list means no root of that kind.
 */
export interface ImportOptions {
  readonly roots: { readonly codex: ReadonlyArray<string>; readonly claude: ReadonlyArray<string> }
  readonly [option: string]: unknown
}

export interface SessionInput {
  /** Default ChatGPT 01. */
  readonly model?: ModelRef
  /** A title keeps core's title request away from the fakes' recordings. */
  readonly title?: string
  /** Default: the project's main folder (the server's workspace with `project: "none"`). */
  readonly directory?: string
  readonly agent?: string
  readonly permissions?: ReadonlyArray<{
    readonly action: string
    readonly resource: string
    readonly effect: "allow" | "deny" | "ask"
  }>
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** An RPC answer: `output` on 200, the declared error otherwise. */
export interface RpcResult {
  readonly status: number
  readonly output?: unknown
  readonly type?: string
  readonly message?: string
  readonly data?: unknown
}

type TeamMethods = OwnTeam.Definition["methods"]
export type TeamInput<M extends OwnTeam.MethodName> = NonNullable<
  TeamMethods[M]["input"]["~standard"]["types"]
>["input"]
export type TeamOutput<M extends OwnTeam.MethodName> = NonNullable<
  TeamMethods[M]["output"]["~standard"]["types"]
>["output"]

export interface TeamServer {
  readonly name: string
  readonly buildId: string
  /** The running server (a new process after {@link restart}). */
  readonly server: OpencodeServer
  /** The server's event stream since the last boot. */
  readonly events: EventRecorder
  readonly fakes: TeamFakes
  readonly root: string
  /** `OWN_HOME` of both plugins. */
  readonly ownHome: string
  /** own.team's control location: every own.team method goes there (06 §2.7). */
  readonly control: string
  /** The project's main folder; `undefined` with `project: "none"`. */
  readonly project: string | undefined
  readonly service: ServiceProxy
  /** Every model the harness waits for at boot. */
  readonly models: ReadonlyArray<ModelRef>
  /** The opencode config file the server reads (`opencode.jsonc`); written again at every boot. */
  readonly configFile: string
  /** The fake bundled claude-auth's folder (`claude: true`), the plugin entry of the config. */
  readonly claudeBundle: string
  /** An own.team method at the control location; throws unless 200, and decodes the output with its schema. */
  team<M extends OwnTeam.MethodName>(method: M, input: TeamInput<M>): Promise<TeamOutput<M>>
  /** An own.accounts method (default location: the control location); throws unless 200. */
  accounts(method: string, input?: unknown, directory?: string): Promise<Readonly<Record<string, unknown>>>
  /** Any RPC (default location: the control location). */
  rpc(id: string, method: string, input?: unknown, directory?: string): Promise<RpcResult>
  createSession(input?: SessionInput): Promise<string>
  /** Sends `text` and waits until the session is idle again. */
  turn(sessionID: string, text: string): Promise<void>
  /** Stops the server (`kill`: the process tree is killed, no graceful shutdown) and boots it on the same root. */
  restart(options?: { readonly kill?: boolean }): Promise<void>
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function startTeamServer(options: TeamServerOptions): Promise<TeamServer> {
  // own-import's default roots are this PC's `~/.codex` and `~/.claude`: a test that loads it names its own.
  if (options.importer && !options.importOptions)
    throw new Error("startTeamServer: `importer` needs `importOptions.roots` (fixture folders)")
  const name = options.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `own-team-e2e-${name}-`)))
  const fakes = options.fakes ?? startTeamFakes()
  const service = startServiceProxy()
  const stack = new AsyncDisposableStack()
  stack.defer(async () => {
    if (options.keepTemp ?? process.env.OWN_E2E_KEEP === "1") return
    // 15 s, not removeTree's 2 s: a server that exits gracefully leaves the processes it started (the Claude Agent
    // SDK's `claude`, its shells) to end on their own, and on a loaded PC they still held `workspace` and the XDG
    // folders after 2 s (EBUSY in the 2.2.6-own.11 release tier's claude-agent file).
    await removeTree(root, 150)
  })
  if (!options.fakes) stack.defer(() => fakes.stop())
  stack.defer(() => service.stop())

  const ownHome = path.join(root, "own-home")
  const control = Home.layout(ownHome).control
  await fs.mkdir(control, { recursive: true })
  const project = await setupProject(root, options.project ?? "f1")
  const seed = await seedAccounts(root, ownHome, fakes, options.siwc ?? [], options.codexTransport)
  if (options.claudeAgent) await seedClaudeAgent(ownHome, options.claudeAgent === 2, options.claudeAgentModels)
  const registration = ServiceTarget.registrationPath("local", { XDG_STATE_HOME: path.join(root, "xdg-state") })
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await Bun.write(registration, JSON.stringify(service.registration))

  const buildId = `e2e-team-${name}-${process.pid}`
  const claudeBundle = path.join(ownHome, "app", "current", "plugins", "claude-auth")
  if (options.claude) installClaudeBundle(claudeBundle)
  const plugins = [
    {
      package: ACCOUNTS_PACKAGE,
      options: {
        home: ownHome,
        buildId,
        vault: { command: [process.execPath, VAULT_HELPER, seed.vault] },
        endpoints: {
          codex: fakes.codex.baseURL,
          oauthIssuer: fakes.codex.url,
          // The optional usage poller's root: the fake answers 404, so nothing reaches chatgpt.com.
          chatgpt: `${fakes.codex.url}/backend-api`,
          // `siwc` slots call the OpenAI API: the local fake (it answers 404), never the real one.
          openai: `${fakes.codex.url}/v1`,
          deepseek: fakes.deepseek.baseURL,
          anthropic: fakes.anthropic.baseURL,
          ...options.accountsEndpoints,
        },
        codexImportRoot: seed.legacy,
        ...options.accountsOptions,
      },
    },
    ...(options.team === false
      ? []
      : [
          {
            package: TEAM_PACKAGE,
            options: { home: ownHome, buildId, service: service.option, ...options.teamOptions },
          },
        ]),
    // The slot after own.team (02 §8.2, 06 §2.6): a change of it never reloads own.team.
    ...(options.claude ? [claudeBundle] : []),
    ...(options.computerUse
      ? [{ package: COMPUTER_PACKAGE, options: { home: ownHome, buildId, driver: "fake", ...options.computerOptions } }]
      : []),
    // Last (09 §5.1): own-import has no hooks, so loading it reloads no other plugin.
    ...(options.importer
      ? [
          {
            package: options.importPackage ?? IMPORT_PACKAGE,
            options: { home: ownHome, buildId, service: service.importOption, ...options.importOptions },
          },
        ]
      : []),
    ...(typeof options.plugins === "function" ? options.plugins(ownHome) : (options.plugins ?? [])),
  ]
  const config = opencodeConfig({
    providers: options.claude
      ? { anthropic: anthropicProvider(fakes.anthropic, { apiKey: CLAUDE.key, models: [CLAUDE.model.id] }) }
      : {},
    plugins,
    extra: options.config,
  })
  const base = [
    MODEL["01"],
    MODEL["02"],
    MODEL["03"],
    MODEL.deepseek,
    MODEL.anthropic,
    ...(options.siwc ?? []).map((item) => siwcModel(item.slug)),
  ]
  const models = [
    ...base,
    ...(options.claude ? [CLAUDE.model] : []),
    ...(options.claudeAgent ? [CLAUDE_AGENT.model] : []),
  ]
  const catalogFile = await fixtureCatalog(root)
  const boot = async () => {
    const server = await startOpencodeServer({
      root,
      models: catalogFile,
      env: {
        OWN_OPEN_CODE: "1",
        ...(options.watchConfig ? { OPENCODE_DISABLE_FILEWATCHER: undefined } : {}),
        ...(options.claudeAgent
          ? {
              OPENCODE_CLAUDE_PATH: FAKE_CLAUDE,
              PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
            }
          : {}),
        ...options.env,
        // After `options.env`, so with own-import loaded no variable can name this PC's Codex or Claude Code store.
        ...(options.importer
          ? { CODEX_HOME: path.join(root, "codex-home"), CLAUDE_CONFIG_DIR: path.join(root, "claude-home") }
          : {}),
      },
      config,
      startupTimeoutMs: BOOT_TIMEOUT,
      ...(options.printLogs === undefined ? {} : { printLogs: options.printLogs }),
    })
    service.target(server)
    return server
  }

  const booted = await boot().catch(async (error: unknown) => {
    await stack.disposeAsync()
    throw error
  })
  const state: { server: OpencodeServer; events?: EventRecorder } = { server: booted }
  stack.defer(async () => {
    await state.events?.close()
    await state.server.stop()
    service.target(undefined)
  })

  // Plugins load in the background since upstream v2.4.0 (#63814), in every Location: a call into a Location that just
  // booted (an area's folder) answers `rpc.unavailable` until the plugin registered there, so it is asked again for up
  // to 60 s.
  const rpc = async (id: string, method: string, input: unknown = {}, directory = control): Promise<RpcResult> => {
    const deadline = Date.now() + 60_000
    while (true) {
      const result = await rpcOnce(id, method, input, directory)
      if (result.type !== "rpc.unavailable" || Date.now() > deadline) return result
      await Bun.sleep(200)
    }
  }
  const rpcOnce = async (id: string, method: string, input: unknown, directory: string): Promise<RpcResult> => {
    const send = (fresh: boolean) => {
      const target = new URL(`/api/rpc/${id}/${method}`, state.server.url)
      target.searchParams.set("location[directory]", directory)
      return fetch(target, {
        method: "POST",
        headers: {
          authorization: state.server.authorization,
          "x-opencode-directory": encodeURIComponent(directory),
          "content-type": "application/json",
        },
        body: JSON.stringify({ input }),
        ...(fresh ? { keepalive: false } : {}),
      })
    }
    // fetch reuses keep-alive sockets: one the server closed as idle in the same moment (or one of a server `restart`
    // killed, or one a restarted server busy booting its Locations closes late, RH-43) fails before the request reaches
    // a server, as ECONNRESET. That call goes once more on a socket of its own (`keepalive: false`: the pool may hold
    // another one closing the same way); a server that is really gone fails the second time too.
    const response = await send(false).catch((error: unknown) => {
      if (!reset(error)) throw error
      return send(true)
    })
    const text = await response.text()
    const body = text === "" ? {} : json(text)
    const record = isRecord(body) ? body : {}
    if (response.status === 200) return { status: 200, output: record.output }
    return {
      status: response.status,
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(record.data === undefined ? {} : { data: record.data }),
    }
  }

  const accounts = async (method: string, input: unknown = {}, directory = control) => {
    const result = await rpc(OwnAccounts.ID, method, input, directory)
    if (result.status !== 200 || !isRecord(result.output))
      throw new Error(`own.accounts ${method}: HTTP ${result.status} ${result.type ?? ""} ${result.message ?? ""}`)
    return result.output
  }

  /**
   * Whether own.import is active at the control location (`GET /api/plugin`). Its load or setup failure throws at once
   * with core's error and the server log lines of its ref (a dependency the install lacks shows up there, e.g. after a
   * merge that added one without `bun install`), instead of waiting out {@link until}.
   */
  const importActive = async () => {
    const listed = Option.getOrUndefined(
      decodePlugins(
        await state.server.call("GET", "/api/plugin", {
          query: { "location[directory]": control },
          directory: control,
        }),
      ),
    )
    const pkg = options.importPackage ?? IMPORT_PACKAGE
    const failed = listed?.data.find(
      (plugin) =>
        plugin.state.status === "failed" &&
        (plugin.id === OwnImport.ID || (plugin.source?.path !== undefined && inside(pkg, plugin.source.path))),
    )
    if (failed) {
      const ref = failed.state.ref
      const logs = ref === undefined ? [] : state.server.logs().split("\n")
      const lines = logs.filter((line) => ref !== undefined && line.includes(ref))
      throw new Error([`own.import failed to load: ${failed.state.error} (${ref ?? "no ref"})`, ...lines].join("\n"))
    }
    return listed?.data.some((plugin) => plugin.id === OwnImport.ID && plugin.state.status === "active") ?? false
  }

  /**
   * Models listed and, with own-team, its `health` answering at the control location (plugins activated); with
   * own-import, that plugin active there too. With the Claude slot, own-accounts sees the bundle loaded first (the
   * `anthropic` provider stays off until then, 02 §8.4).
   */
  /** A model wait that timed out names what the server did list. */
  const listedOnTimeout = async (error: unknown): Promise<never> => {
    const listed = await state.server.models().catch(() => [])
    const names = listed.map((model) => `${String(model.providerID)}/${String(model.id)}`)
    const errors = state.server
      .logs()
      .split(/\r?\n/)
      .filter((line) => /ERROR|WARN/.test(line))
      .slice(-15)
    const head = `${error instanceof Error ? error.message : String(error)}; listed ${names.length}: ${names.slice(0, 40).join(", ")}`
    throw new Error([head, ...errors].join(" | "))
  }
  const ready = async () => {
    // The control Location first, so own.accounts there leads from the start (as the preset rig does): plugins load in
    // the background since upstream v2.4.0 (#63814), and a workspace Location booted first waited for slots that only
    // the leader registers. own.accounts answers `rpc.unavailable` until it registered.
    await until(
      async () => (await rpc(OwnAccounts.ID, "health")).status === 200,
      "own.accounts health never answered 200",
    )
    await state.server.waitForModels(base, BOOT_TIMEOUT).catch(listedOnTimeout)
    if (options.claude) await claudeDetected(accounts)
    if (options.claudeAgent) await claudeAgentReady(accounts)
    await state.server.waitForModels(models, BOOT_TIMEOUT).catch(listedOnTimeout)
    if (options.team !== false)
      await until(async () => (await rpc(OwnTeam.ID, "health")).status === 200, "own.team health never answered 200")
    if (options.importer) await until(importActive, "own.import never became active")
  }

  await (async () => {
    state.events = await recordServerEvents(state.server)
    await ready()
  })().catch(async (error: unknown) => {
    await stack.disposeAsync()
    throw error
  })

  const stop = once(() => stack.disposeAsync())
  return {
    name,
    buildId,
    get server() {
      return state.server
    },
    get events() {
      if (!state.events) throw new Error("the event recorder is not running")
      return state.events
    },
    fakes,
    root,
    ownHome,
    control,
    project,
    service,
    models,
    configFile: path.join(root, "config", "opencode.jsonc"),
    claudeBundle,
    accounts,
    async team(method, input) {
      const result = await rpc(OwnTeam.ID, method, input)
      if (result.status !== 200)
        throw new Error(`own.team ${method}: HTTP ${result.status} ${result.type ?? ""} ${result.message ?? ""}`)
      const checked = await OwnTeam.Definition.methods[method].output["~standard"].validate(result.output)
      if (checked.issues)
        throw new Error(`own.team ${method}: the output does not decode: ${JSON.stringify(checked.issues)}`)
      return checked.value
    },
    rpc,
    async createSession(input = {}) {
      const created = await state.server.call("POST", "/api/session", {
        body: {
          title: input.title ?? "팀 e2e",
          model: input.model ?? MODEL["01"],
          location: { directory: input.directory ?? project ?? state.server.paths.workspace },
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      })
      const id = isRecord(created) && isRecord(created.data) ? created.data.id : undefined
      if (typeof id !== "string") throw new Error(`session.create returned no id: ${JSON.stringify(created)}`)
      return id
    },
    async turn(sessionID, text) {
      await state.server.prompt(sessionID, text)
      await state.server.waitIdle(sessionID)
    },
    async restart(restartOptions = {}) {
      await state.events?.close()
      state.events = undefined
      if (restartOptions.kill) await kill(state.server.pid)
      await state.server.stop()
      service.target(undefined)
      state.server = await boot()
      state.events = await recordServerEvents(state.server)
      await ready()
    },
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

/**
 * The fake of the bundled claude-auth (02 §8.2) at `dir`: own-accounts' `writeFakeClaudeAuth` with the multi-account
 * exports and a valid `own-bundle.json`, so own-accounts verifies it as the app's bundle (`patched`), holding every
 * Claude account own lists (`holdListed`). Its hooks do nothing; the slot's requests go to the fake Anthropic with the
 * provider's fake key.
 */
export function installClaudeBundle(dir: string) {
  writeFakeClaudeAuth(dir, { multi: true, holdListed: true })
}

/** Waits until own-accounts sees the bundle loaded in order (02 §8.2: no consent; the provider follows the slot). */
async function claudeDetected(
  accounts: (method: string, input?: unknown) => Promise<Readonly<Record<string, unknown>>>,
) {
  await waitValue(async () => {
    const found = await accounts("plugin.claudeAuth.status")
    return found.order === "ok" ? found : undefined
  }, "the Claude slot was never detected")
}

/**
 * Waits until own-accounts at the control location sees the Claude Agent account logged in. Asking there loads that
 * Location, whose own-accounts makes upstream's `claude-login` connection; the provider then checks the fake `claude`
 * and lists its models.
 */
async function claudeAgentReady(
  accounts: (method: string, input?: unknown) => Promise<Readonly<Record<string, unknown>>>,
) {
  await waitValue(async () => {
    const found = await accounts("claudeAgent.status")
    const listed = Array.isArray(found.accounts) ? found.accounts : []
    return listed.length > 0 &&
      listed.every((account) => typeof account === "object" && account !== null && account.loggedIn === true)
      ? found
      : undefined
  }, "the Claude Agent accounts were never logged in")
}

/** Builds the project under `<root>/project` and returns its main folder. */
async function setupProject(root: string, project: Project) {
  if (project === "none") return undefined
  const base = path.join(root, "project")
  await fs.mkdir(base, { recursive: true })
  if (project === "f1") return f1(base).home
  if (project === "f2") return f2(base).home
  return project(base)
}

/**
 * Seeds own-accounts like a user who linked three ChatGPT logins of the old app and added two API keys: the fake
 * control center with the three profiles, `accounts.json` (bundled model templates) and the vault seed of the keys.
 */
async function seedAccounts(
  root: string,
  ownHome: string,
  fakes: TeamFakes,
  siwc: NonNullable<TeamServerOptions["siwc"]>,
  transport: TeamServerOptions["codexTransport"],
) {
  const legacy = path.join(root, "control-center")
  const profiles = await writeCodexMultiProviderProfiles(
    legacy,
    CHATGPT_IDS.map((id) => ({ id, alias: `team-${id}`, tokens: fakes.tokens[id] })),
  )
  const codex = await Promise.all(
    profiles.map(async (profile, index) => ({
      kind: "codex" as const,
      label: `ChatGPT ${profile.id}`,
      slug: `tm${profile.id}`,
      identity: await sourceIdentity(profile.authPath),
      ...(transport === undefined ? {} : { transport }),
      credential: {
        type: "linked-codex-source" as const,
        source: {
          app: "codex-multi-provider" as const,
          profileID: profile.id,
          alias: profile.alias,
          authPath: profile.authPath,
        },
        linkedAt: `2026-10-0${index + 1}T00:00:00Z`,
      },
    })),
  )
  const keys = [
    { kind: "ds" as const, ...DEEPSEEK },
    { kind: "anth" as const, ...ANTHROPIC },
  ]
  const signIn = siwc.map((item) => {
    const shared = codex.find((seed) => seed.slug === `tm${item.of}`)
    return {
      kind: "siwc" as const,
      label: `ChatGPT ${item.of} 앱`,
      slug: item.slug,
      identity: {
        fingerprint: `sha256:siwc-${item.slug}`,
        ...(shared ? { login: shared.identity.fingerprint } : {}),
      },
    }
  })
  const registry = await registryWith([
    ...codex,
    ...signIn,
    ...keys.map((key) => ({
      kind: key.kind,
      label: key.label,
      slug: key.slug,
      identity: { keyHint: Hash.keyHint(key.key) },
    })),
  ])
  await Bun.write(path.join(ownHome, "accounts.json"), JSON.stringify(registry, null, 2))
  const vault = path.join(root, "vault-seed.json")
  await Bun.write(
    vault,
    JSON.stringify(
      Object.fromEntries(
        keys.map((key) => [`acc_${key.slug}`, JSON.stringify({ v: 1, type: "key", key: key.key, generation: 1 })]),
      ),
    ),
  )
  return { legacy, vault }
}

/**
 * The Claude Agent account (`claudeAgent: true`): its folder with a fake login (no token anywhere: own only checks that
 * `.credentials.json` exists, and the fake `claude` answers for itself) and its registry entry, added to the seed.
 */
async function seedClaudeAgent(ownHome: string, second: boolean, models?: ReadonlyArray<FakeModel>) {
  const seed = async (login: { readonly accountID: string; readonly email: string; readonly accountUuid: string }) => {
    const folder = claudeAgentFolder(ownHome, login.accountID)
    await fs.mkdir(folder, { recursive: true })
    if (models) await Bun.write(path.join(folder, MODELS_FILE), JSON.stringify({ models }))
    await Bun.write(path.join(folder, ".credentials.json"), JSON.stringify({ e2e: "a fake login for the fake claude" }))
    await Bun.write(
      path.join(folder, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: login.email, accountUuid: login.accountUuid } }),
    )
    return folder
  }
  const accounts = [CLAUDE_AGENT, ...(second ? [CLAUDE_AGENT_B] : [])]
  const folders = await Promise.all(accounts.map(seed))
  const file = path.join(ownHome, "accounts.json")
  const registry = await Bun.file(file).json()
  const listed = accounts.map((login, index) => ({
    accountID: login.accountID,
    configDir: folders[index],
    label: null,
    shortLabel: index === 0 ? "CA" : `CA${index + 1}`,
    color: "orange",
    addedAt: "2026-10-31T00:00:00Z",
  }))
  await Bun.write(file, JSON.stringify({ ...registry, claudeAgents: listed }, null, 2))
}

async function sourceIdentity(authPath: string) {
  const read = await CodexSource.read(authPath)
  if (!read.ok) throw new Error(`fixture source unreadable: ${read.problem}`)
  const identity = read.snapshot.summary.identity
  if (!identity.chatgptAccountId || !identity.fingerprint) throw new Error("fixture source without identity")
  return { chatgptAccountId: identity.chatgptAccountId, fingerprint: identity.fingerprint }
}

/** Ends the process tree at once (a crash between steps): no graceful shutdown, no cleanup of the plugins. */
async function kill(pid: number) {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
    return
  }
  process.kill(pid, "SIGKILL")
}

/** Re-runs `probe` every 200 ms until it is true; throws after `timeoutMs`. */
/**
 * The bundled models.dev snapshot (core's `models-dev/snapshot.txt`) with the fixtures' models kept: since upstream
 * v2.4.0 the catalog marks `gpt-5.6-sol` (openai) and `claude-sonnet-4-5` (anthropic) deprecated, core drops deprecated
 * models, and the team fixtures' slots (`MODEL`) would list none of them. Everything else is upstream's catalog.
 */
async function fixtureCatalog(root: string) {
  const catalog = (await Bun.file(path.join(REPO_ROOT, "packages/core/src/models-dev/snapshot.txt")).json()) as Record<
    string,
    { models?: Record<string, Record<string, unknown>> } | undefined
  >
  for (const [provider, id] of [
    ["openai", "gpt-5.6-sol"],
    ["anthropic", "claude-sonnet-4-5"],
  ] as const) {
    const model = catalog[provider]?.models?.[id]
    if (model) delete model.status
  }
  const file = path.join(root, "models-catalog.json")
  await Bun.write(file, JSON.stringify(catalog))
  return file
}

export async function until(probe: () => Promise<boolean>, message: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`${message} within ${timeoutMs} ms`)
    await Bun.sleep(200)
  }
}

/** Re-runs `probe` every 200 ms until it answers a value; throws after `timeoutMs`. */
export async function waitValue<T>(probe: () => Promise<T | undefined>, message: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`${message} within ${timeoutMs} ms`)
    await Bun.sleep(200)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Team helpers (durable state, 06 §11.2)

/** An op once its auto steps ended (`done`, `failed`, `cancelled`; with `waiting: true` also `waiting`). */
export async function opEnd(
  team: Pick<TeamServer, "team">,
  opID: string,
  options: { readonly timeoutMs?: number; readonly waiting?: boolean } = {},
) {
  const ended = new Set<string>(["done", "failed", "cancelled", ...(options.waiting ? ["waiting"] : [])])
  const last: { op?: OwnTeam.Op } = {}
  return waitValue(
    async () => {
      const op = (await team.team("op.get", { opID: OwnTeam.OpID.make(opID) })).op
      last.op = op
      return ended.has(op.state) ? op : undefined
    },
    `op ${opID} did not end`,
    options.timeoutMs ?? 180_000,
  ).catch((error: unknown) => {
    const steps = (last.op?.steps ?? []).map((step) => `${step.id}:${step.state}${step.note ? ` (${step.note})` : ""}`)
    throw new Error(`${error instanceof Error ? error.message : String(error)}; steps: ${steps.join(", ")}`)
  })
}

/**
 * `enable` with the judge's directive in `hint` (`[propose-areas n …]`), from the conversation `sessionID` when given,
 * and the op's end; returns the op and the team as `team.get` reads it.
 *
 * 직접 작업 (2026-11-14): a new team holds an area while the user talks in its owner conversation (`Policy.directHold`,
 * on by default), and the suites drive owners with messages the user sends there. So the team's hold is switched off
 * ({@link holdOff}) right after the enable, before the suite's first request, unless `directHold: true` keeps the
 * team's default (`direct.e2e.test.ts`, and `tools-cache.e2e.test.ts`, whose instruction counts start at creation).
 */
export async function enableTeam(
  team: TeamServer,
  input: {
    readonly hint: string
    readonly sessionID?: string
    readonly directory?: string
    readonly directHold?: boolean
  },
) {
  const directory = input.directory ?? team.project
  if (directory === undefined) throw new Error("the server has no project")
  const started = await team.team("enable", {
    directory,
    hint: input.hint,
    ...(input.sessionID === undefined ? {} : { sessionID: SessionID.make(input.sessionID) }),
  })
  // Four areas at about 25 s a worktree passed 180 s with three files at once on a loaded PC (2026-10-29); the op
  // was still moving.
  const op = await opEnd(team, started.opID, { timeoutMs: 360_000 })
  const view = await team.team("team.get", { directory })
  if (input.directHold === true || !view.team) return { opID: started.opID, op, view }
  await holdOff(team, view.team.id)
  return { opID: started.opID, op, view: await team.team("team.get", { directory }) }
}

/**
 * Switches the team's 직접 작업 hold off (`settings.set{policy:{directHold:false}}`, one instruction update in the
 * team's conversations): a user message in an owner conversation then only marks the area as before 2026-11-14.
 */
export async function holdOff(team: Pick<TeamServer, "team">, teamID: OwnTeam.TeamID) {
  await team.team("settings.set", { teamID, patch: { policy: { directHold: false } } })
}

export interface SessionRow {
  readonly id: string
  readonly parentID: string | null
  readonly directory: string
  readonly title: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly model: ModelRef | null
  /** The session's permission rules, in order. */
  readonly permission: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly created: number
}

/** Every session row of core's database (`session_v2`), oldest first; read-only beside the running server. */
export function sessionRows(database: string): ReadonlyArray<SessionRow> {
  const db = new Database(database, { readonly: true })
  db.exec("PRAGMA busy_timeout = 5000")
  const rows = db
    .query<
      {
        id: string
        parent_id: string | null
        directory: string
        title: string | null
        metadata: string | null
        model: string | null
        permission: string | null
        time_created: number
      },
      []
    >(
      "SELECT id, parent_id, directory, title, metadata, model, permission, time_created FROM session_v2 ORDER BY time_created, id",
    )
    .all()
  db.close()
  return rows.map((row) => {
    const metadata = row.metadata === null ? undefined : json(row.metadata)
    const model = row.model === null ? undefined : json(row.model)
    const permission = row.permission === null ? undefined : json(row.permission)
    return {
      id: row.id,
      parentID: row.parent_id,
      directory: row.directory,
      title: row.title,
      metadata: isRecord(metadata) ? metadata : {},
      model:
        isRecord(model) && typeof model.id === "string" && typeof model.providerID === "string" ? toRef(model) : null,
      permission: Array.isArray(permission) ? permission.filter(isRecord) : [],
      created: row.time_created,
    }
  })
}

function toRef(model: Readonly<Record<string, unknown>>): ModelRef {
  return {
    id: String(model.id),
    providerID: String(model.providerID),
    ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
  }
}

/** The `own.team` session metadata of a row (06 §2.4 display hint), if any. */
export function teamMeta(row: SessionRow) {
  const meta = row.metadata[OwnTeam.SESSION_META]
  return isRecord(meta) ? meta : undefined
}

/** A session's messages, oldest first (the API lists the newest first). */
export async function messages(team: Pick<TeamServer, "server">, sessionID: string) {
  return (await team.server.messages(sessionID)).toReversed()
}

/** The user messages of a session that carry a main request (`own.dispatch` metadata), oldest first. */
export async function mainRequests(team: Pick<TeamServer, "server">, sessionID: string) {
  return (await messages(team, sessionID)).filter(
    (message) => message.type === "user" && isRecord(message.metadata) && OwnTeam.DISPATCH_META in message.metadata,
  )
}

/** The `own.dispatch` id of a message, if it is a main request. */
export function dispatchOf(message: Readonly<Record<string, unknown>>) {
  const meta = isRecord(message.metadata) ? message.metadata[OwnTeam.DISPATCH_META] : undefined
  return isRecord(meta) && typeof meta.id === "string" ? meta.id : undefined
}

/** The team's main requests from KV (`dispatch:<teamID>:…`), in area and admission order. */
export function dispatches(database: string, teamID: string): ReadonlyArray<OwnTeam.Dispatch> {
  const decode = Schema.decodeUnknownOption(OwnTeam.Dispatch)
  return Object.entries(kv(database))
    .filter(([key]) => key.startsWith(`dispatch:${teamID}:`))
    .flatMap(([, value]) => Option.toArray(decode(value)))
}

/** The team's integrations from KV (`ig:<teamID>:…`, 06 §2.4), oldest first (their ids are ULIDs). */
export function integrations(database: string, teamID: string): ReadonlyArray<OwnTeam.Integration> {
  const decode = Schema.decodeUnknownOption(OwnTeam.Integration)
  return Object.entries(kv(database))
    .filter(([key]) => key.startsWith(`ig:${teamID}:`))
    .flatMap(([, value]) => Option.toArray(decode(value)))
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

/** The `notice` events of one kind on the recorded stream (`rpc.own.team.notice`), oldest first. */
export function notices(team: Pick<TeamServer, "events">, kind: OwnTeam.NoticeKind) {
  return team.events.events.flatMap((event) =>
    event.type === "rpc.own.team.notice" && event.data.kind === kind ? [event.data] : [],
  )
}

/** How core starts the message that brings a changed Code Mode catalog into a session's history. */
export const CATALOG_CHANGED = "The Code Mode tool catalog has changed."

/**
 * The catalog updates a model request carries, each from {@link CATALOG_CHANGED} to the next one or the end of the
 * system text. Core keeps the system prompt's catalog (the cached prefix) for the session and records a changed one as
 * a durable update message once (TG16: the adopted session's delta 1); a request that only continues after a
 * `previous_response_id` carries none.
 */
export function catalogUpdates(request: Pick<RecordedRequest, "json">): ReadonlyArray<string> {
  return turn(request)
    .system.split(CATALOG_CHANGED)
    .slice(1)
    .map((text) => text.trim())
}

/** One file of a turn's diff (`GET /api/session/:id/diff`, core's per-turn snapshot diff, 06 §4.14). */
export interface TurnFile {
  readonly file: string
  readonly status: string
}

/**
 * The diff of a session's turn: the newest user message's by default, or `from` through `to` (user message ids). Core
 * compares the turn's first and last recorded snapshots of the session's folder.
 */
export async function turnDiff(
  team: Pick<TeamServer, "server">,
  sessionID: string,
  directory: string,
  range: { readonly from?: string; readonly to?: string } = {},
): Promise<ReadonlyArray<TurnFile>> {
  const response = await team.server.request("GET", `/api/session/${sessionID}/diff`, {
    directory,
    query: {
      "location[directory]": directory,
      ...(range.from === undefined ? {} : { from: range.from }),
      ...(range.to === undefined ? {} : { to: range.to }),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`session.diff ${sessionID}: HTTP ${response.status} ${text}`)
  const body = json(text)
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : []
  return data.flatMap((item: unknown) =>
    isRecord(item) && typeof item.file === "string" ? [{ file: item.file, status: String(item.status) }] : [],
  )
}

/** The team's ops from KV (`op:<teamID>:…`), oldest first. */
export function ops(database: string, teamID: string): ReadonlyArray<OwnTeam.Op> {
  const decode = Schema.decodeUnknownOption(OwnTeam.Op)
  return Object.entries(kv(database))
    .filter(([key]) => key.startsWith(`op:${teamID}:`))
    .flatMap(([, value]) => Option.toArray(decode(value)))
    .toSorted((a, b) => a.createdAt - b.createdAt)
}

/** An own.team KV value decoded with `schema` (`team:…`, `area:…`, `op:…`). */
export function record<S extends Schema.ConstraintDecoder<unknown>>(database: string, key: string, schema: S) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(kv(database)[key]))
}

/** The sessions that run now (`GET /api/session/active`). */
export async function active(team: Pick<TeamServer, "server">): Promise<ReadonlySet<string>> {
  const body = await team.server.call("GET", "/api/session/active")
  return new Set(isRecord(body) && isRecord(body.data) ? Object.keys(body.data) : [])
}

/** The user's stop button on a session (`POST /api/session/:id/interrupt`). */
export async function interrupt(team: Pick<TeamServer, "server">, sessionID: string) {
  await team.server.call("POST", `/api/session/${sessionID}/interrupt`)
}

/** A session's pending permission requests (`GET /api/session/:id/permission`). */
export async function permissions(team: Pick<TeamServer, "server">, sessionID: string) {
  const body = await team.server.call("GET", `/api/session/${sessionID}/permission`)
  const list = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
  return list.filter(isRecord)
}

/** Answers a pending permission request (`once`, `always` or `reject`). */
export async function reply(
  team: Pick<TeamServer, "server">,
  sessionID: string,
  requestID: string,
  decision: "once" | "always" | "reject",
) {
  await team.server.call("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, { body: { decision } })
}

/** `session.inbox.enqueued` events of a session on the recorded stream, with their delivery and metadata. */
export function enqueued(team: Pick<TeamServer, "events">, sessionID: string) {
  return team.events.events.flatMap((event, index) => {
    if (event.type !== "session.inbox.enqueued" || event.data.sessionID !== sessionID) return []
    const item = isRecord(event.data.item) ? event.data.item : {}
    const payload = isRecord(item.payload) ? item.payload : {}
    return [
      {
        index,
        inboxID: String(event.data.inboxID),
        delivery: String(item.delivery),
        metadata: isRecord(payload.metadata) ? payload.metadata : {},
        text: typeof payload.text === "string" ? payload.text : "",
      },
    ]
  })
}

/**
 * A `presets.set` body (07 §8.1): `roles` maps a role to its targets in order (`{rel: "main"}` or {@link pin}), every
 * role effort `inherit`, delegation `when-useful`, the default caps.
 */
export function presetSave(name: string, group: string, roles: Readonly<Record<string, ReadonlyArray<unknown>>>) {
  return {
    name,
    group,
    workers: {
      mode: "by-role",
      roles: Object.fromEntries(Object.entries(roles).map(([role, targets]) => [role, { targets, effort: "inherit" }])),
    },
    delegation: "when-useful",
    caps: Preset.CAPS,
    ultraCaps: null,
  }
}

/** A pinned preset target: `model` on account `account` (07 §2.4). */
export function pin(account: string, model: string = MODEL["01"].id) {
  return { pin: { account, model } }
}

/** Saves a preset (`presets.set`) and returns its id. */
export async function savePreset(
  team: Pick<TeamServer, "accounts">,
  name: string,
  group: string,
  roles: Readonly<Record<string, ReadonlyArray<unknown>>>,
) {
  const saved = await team.accounts("presets.set", { preset: presetSave(name, group, roles) })
  return Schema.decodeUnknownSync(Preset.Info)(saved.preset).id
}

/** A session's preset view (`session.preset.get`) at its folder. */
export async function presetOf(team: Pick<TeamServer, "accounts">, sessionID: string, directory: string) {
  return Schema.decodeUnknownSync(Preset.SessionView)(
    await team.accounts("session.preset.get", { sessionID }, directory),
  )
}

/** own-accounts' ledger alerts of one code (`OWN_HOME/ledger/events-YYYY-MM.jsonl`, 02 §2.3), oldest first. */
export async function alerts(ownHome: string, code: string): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  const dir = path.join(ownHome, "ledger")
  const names = await fs.readdir(dir).catch(() => [])
  const texts = await Promise.all(
    names
      .filter((name) => /^events-\d{4}-\d{2}\.jsonl$/.test(name))
      .map((name) => Bun.file(path.join(dir, name)).text()),
  )
  return texts
    .flatMap((text) => text.split("\n"))
    .map((line) => json(line))
    .filter(isRecord)
    .flatMap((line) => (line.type === "alert" && isRecord(line.data) && line.data.code === code ? [line.data] : []))
}

/** The folders whose Location services the server has loaded now (`GET /api/debug/location`). */
export async function locations(team: Pick<TeamServer, "server">): Promise<ReadonlyArray<string>> {
  const listed = await team.server.call("GET", "/api/debug/location")
  return (Array.isArray(listed) ? listed : []).flatMap((item: unknown) =>
    isRecord(item) && typeof item.directory === "string" ? [item.directory] : [],
  )
}

/** Disposes a folder's Location services (`DELETE /api/debug/location`): its plugin instances end. */
export async function evict(team: Pick<TeamServer, "server">, directory: string) {
  const response = await team.server.request("DELETE", "/api/debug/location", {
    directory,
    query: { "location[directory]": directory },
  })
  if (!response.ok) throw new Error(`evict ${directory}: HTTP ${response.status} ${await response.text()}`)
}

/** Two native paths name the same folder (case-insensitive on Windows, any separator). */
export function same(a: string, b: string) {
  const normal = (value: string) => {
    const resolved = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normal(a) === normal(b)
}

// ---------------------------------------------------------------------------------------------------------------
// T3 helpers: reorganizations, confirms, shells (06 §8, §4.10, §4.11)

/** `reorg.apply{teamID, proposal: {version: 1, ops}}`: the user's own action (by `user`, 06 §2.7); the op it started. */
export async function reorganize(
  team: Pick<TeamServer, "team">,
  teamID: OwnTeam.TeamID,
  ops: ReadonlyArray<OwnTeam.ReorgOp>,
) {
  return (await team.team("reorg.apply", { teamID, proposal: { version: 1, ops } })).opID
}

/**
 * The op once its step of `kind` waits for a confirm (`needs_confirm`, 06 §8.5), with that step and its confirm; throws
 * when the op ends without asking.
 */
export async function confirmOf(
  team: Pick<TeamServer, "team">,
  opID: string,
  kind: string,
  timeoutMs = 180_000,
): Promise<{ readonly op: OwnTeam.Op; readonly step: OwnTeam.Step; readonly confirm: OwnTeam.StepConfirm }> {
  return waitValue(
    async () => {
      const op = (await team.team("op.get", { opID: OwnTeam.OpID.make(opID) })).op
      const step = op.steps.find((item) => item.kind === kind && item.state === "needs_confirm")
      if (step?.confirm) return { op, step, confirm: step.confirm }
      if (op.state !== "running" && op.state !== "waiting")
        throw new Error(`op ${opID} ended ${op.state} without asking ${kind}`)
      return undefined
    },
    `op ${opID} never asked ${kind}`,
    timeoutMs,
  )
}

/**
 * Answers a confirm step (`op.confirm`, `skip` = 두기). A removal whose list changed since it was shown, or an expired
 * nonce, answers `nonce_invalid` and the step is asked again with a new nonce (06 §8.5, §8.6).
 */
export function answer(
  team: Pick<TeamServer, "rpc">,
  opID: string,
  step: Pick<OwnTeam.Step, "id" | "confirm">,
  choice: "do" | "skip",
) {
  return team.rpc(OwnTeam.ID, "op.confirm", { opID, stepID: step.id, choice, nonce: step.confirm?.nonce })
}

/** Runs `command` as a shell of the folder (core `POST /api/shell`); a running one holds its safe point (06 §8.4). */
export async function startShell(team: Pick<TeamServer, "server">, directory: string, command: string) {
  const body = await team.server.call("POST", "/api/shell", {
    directory,
    query: { "location[directory]": directory },
    body: { command },
  })
  const id = isRecord(body) && isRecord(body.data) ? body.data.id : undefined
  if (typeof id !== "string") throw new Error(`shell.create returned no id: ${JSON.stringify(body)}`)
  return id
}

/** Ends and removes a shell of the folder (`DELETE /api/shell/:id`). */
export async function stopShell(team: Pick<TeamServer, "server">, directory: string, id: string) {
  await team.server.call("DELETE", `/api/shell/${id}`, { directory, query: { "location[directory]": directory } })
}

/** `OWN_TEAM_E2E_FULL=1` (`bun run test:e2e:full`, the release tier): the kill tests kill after every step. */
export const FULL_KILLS = process.env.OWN_TEAM_E2E_FULL === "1"

/**
 * Kills the server after each step of the op that ends (`op.progress` done) and boots it again on the same root, until
 * the op ends or waits for a confirm (TI-11: each restart resumes it); returns how many kills landed while it ran.
 * With `at`, only after the steps of those kinds unless {@link FULL_KILLS}: a boot costs 30-45 s, and the unit tests
 * resume after every step of the reorg ops (`test/plugin/t3-resume-*.test.ts`).
 */
export async function killEachStep(team: TeamServer, opID: string, at?: ReadonlySet<string>) {
  const seen = new Set<string>()
  const get = async () => (await team.team("op.get", { opID: OwnTeam.OpID.make(opID) })).op
  const loop = async (kills: number): Promise<number> => {
    const op = await get()
    if (op.state !== "running") return kills
    for (const step of op.steps) if (step.state === "done") seen.add(step.id)
    const next = await team.events
      .waitFor(
        (event) =>
          (event.type === "rpc.own.team.op.progress" &&
            event.data.opID === opID &&
            event.data.state === "done" &&
            !seen.has(String(event.data.stepID))) ||
          (event.type === "rpc.own.team.op.done" && event.data.opID === opID),
        30_000,
      )
      .catch(() => undefined)
    if (next?.type === "rpc.own.team.op.done") return kills
    if (next === undefined) return loop(kills)
    const stepID = String(next.data.stepID)
    seen.add(stepID)
    // The kind from the op read before the wait (steps an op adds as it runs are read again).
    const kind =
      op.steps.find((step) => step.id === stepID)?.kind ?? (await get()).steps.find((step) => step.id === stepID)?.kind
    if (at && !FULL_KILLS && !at.has(String(kind))) return loop(kills)
    await team.restart({ kill: true })
    return loop(kills + 1)
  }
  return loop(0)
}

function once(run: () => Promise<void>) {
  const state: { promise?: Promise<void> } = {}
  return () => {
    state.promise ??= run()
    return state.promise
  }
}

/** `text` as JSON, or `undefined` when it is not JSON. */
function json(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** The part of `GET /api/plugin` the harness reads. */
const decodePlugins = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        // `path` for a local plugin; a package that failed to load has no `id`, only this.
        source: Schema.optional(Schema.Struct({ path: Schema.optional(Schema.String) })),
        state: Schema.Struct({
          status: Schema.String,
          error: Schema.optional(Schema.String),
          ref: Schema.optional(Schema.String),
        }),
      }),
    ),
  }),
)

/** Whether `file` is `dir` or inside it. */
function inside(dir: string, file: string) {
  const relative = path.relative(dir, file)
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** fetch failed because the socket closed before an answer (`ECONNRESET`). */
function reset(error: unknown) {
  return isRecord(error) && error.code === "ECONNRESET"
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
