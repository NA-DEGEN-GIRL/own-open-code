// End-to-end test kit: fake provider servers, the upstream-server harness, and fixtures.
// See README.md in this directory for usage. The presets rig at the end is shared by test/presets/pg*.e2e.test.ts.
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { CodexModels, OwnAccounts } from "@own/protocol"
import { CodexSource, Redact, ServiceTarget } from "@own/runtime"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import { registryWith } from "../slots/support.js"
import type { FakeCodex } from "./fakes/codex"
import { isRecord, type RecordedRequest } from "./fakes/shared"
import type { ChatGPTTokens } from "./fixtures/chatgpt-tokens"
import { writeCodexMultiProviderProfiles } from "./fixtures/codex-multi-provider"
import { opencodeConfig } from "./harness/config"
import { recordServerEvents, type EventRecorder } from "./harness/events"
import { REPO_ROOT, startOpencodeServer, type ModelRef, type OpencodeServer } from "./harness/opencode-server"
import { removeTree } from "./harness/remove"

export {
  SHARING_ERROR_STATUS,
  sharingError,
  startFakeOpenAIResponses,
  type FakeOpenAIResponses,
  type FakeOpenAIResponsesOptions,
} from "./fakes/openai-responses"
export {
  startFakeCodex,
  type CodexUsage,
  type ConsumeOutcome,
  type ConsumeScript,
  type FakeCodex,
  type FakeCodexOptions,
  type FakeResetCredit,
  type RefreshResult,
} from "./fakes/codex"
export {
  CHATGPT_CLIENT_ID,
  startFakeChatGPTAuth,
  type FakeChatGPTAuth,
  type FakeChatGPTAuthOptions,
} from "./fakes/chatgpt-auth"
export {
  SHARING_REGISTRATION_CLIENT_ID,
  SHARING_RESOURCE,
  SHARING_SCOPE,
  startFakeChatGPTSharing,
  type FakeChatGPTSharing,
  type FakeChatGPTSharingOptions,
  type SharingAuthorizeOptions,
  type SharingTokens,
  type SharingUser,
} from "./fakes/chatgpt-sharing"
export {
  startFakeAnthropic,
  unifiedHeaders,
  type FakeAnthropic,
  type FakeAnthropicOptions,
  type UnifiedLimits,
} from "./fakes/anthropic"
export {
  startFakeOpenAIChat,
  type DeepSeekBalance,
  type FakeOpenAIChat,
  type FakeOpenAIChatOptions,
} from "./fakes/openai-chat"
export { waitFor, type FakeOptions, type FakeProvider } from "./fakes/fake-server"
export {
  PromptCache,
  type BreakpointUsage,
  type CacheBlock,
  type LookupOptions,
  type PromptCacheOptions,
} from "./fakes/prompt-cache"
export {
  estimateTokens,
  hashSecret,
  manualClock,
  parseSse,
  sha256,
  type AnswerReply,
  type CacheUsage,
  type Clock,
  type CredentialInfo,
  type RecordedRequest,
  type Reply,
  type Responder,
  type SseEvent,
  type StreamedReply,
  type WireFault,
} from "./fakes/shared"
export {
  CLI_ENTRY,
  E2E_TRANSPILER_CACHE,
  REPO_ROOT,
  activating,
  startOpencodeServer,
  type ConfigInput,
  type ModelRef,
  type OpencodeServer,
  type OpencodeServerOptions,
  type OpencodeServerPaths,
  type RequestOptions,
} from "./harness/opencode-server"
export {
  anthropicProvider,
  codexProvider,
  deepseekProvider,
  openAICompatibleProvider,
  openAIResponsesProvider,
  opencodeConfig,
  providerConfig,
  type ProviderInput,
} from "./harness/config"
export {
  AUTH_CLAIM,
  chatGPTAccount,
  decodeJwtClaims,
  fakeJwt,
  mintChatGPTTokens,
  type ChatGPTAccount,
  type ChatGPTTokens,
} from "./fixtures/chatgpt-tokens"
export {
  readCodexMultiProviderAuth,
  updateCodexMultiProviderAuth,
  writeCodexMultiProviderProfiles,
  type LegacyProfile,
  type LegacyProfileInput,
} from "./fixtures/codex-multi-provider"
export {
  mcpJson,
  mcpStream,
  pageOf,
  queryOf,
  SEARCH_SERVICES,
  searchesOf,
  SHARED_PAGE,
  startFakeSearchServices,
  type FakeSearchServices,
  type SearchCall,
  type SearchService,
  type SessionStep,
} from "./fakes/search-services"
export {
  FAKE_TRANSCRIPT,
  startFakeTranscription,
  type FakeTranscription,
  type TranscriptionCall,
  type TranscriptionReply,
} from "./fakes/transcription"
export { recordServerEvents, type EventRecorder, type ServerEvent } from "./harness/events"
export { removeTree } from "./harness/remove"
export {
  canSealDpapi,
  createLegacyApp,
  replaceLegacyKey,
  sealKey,
  writeLegacyDeepSeek,
  type LegacyApp,
  type Seal,
} from "./fixtures/legacy-keys"

/**
 * A local plugin directory that adds the web search service `fake-search` (`fixtures/websearch-plugin`): it answers
 * every query from memory, so a test can pick it and never reach a real search service.
 */
export const WEBSEARCH_FIXTURE_PLUGIN = path.join(import.meta.dir, "fixtures/websearch-plugin")

// ---------------------------------------------------------------------------------------------------------------
// Catalog variants (07 §8.4 PG5, PG6; fixtures/catalog-variants/README.md): the models.dev catalog a server starts
// from (`OPENCODE_MODELS_PATH`), built from the catalog the source server bundles with a few edits applied in order.

/**
 * The catalog the source server bundles: what a server with model fetching off starts from, and what the bundled
 * templates (`src/slots/templates/*.json`) were generated from, so a variant without edits changes no template.
 */
export const BUNDLED_CATALOG = path.join(REPO_ROOT, "packages/core/src/models-dev/snapshot.txt")

/** The catalog providers own's kinds copy their templates from (`Templates.SOURCE`) that the rigs use. */
export const CATALOG_PROVIDERS = ["openai", "anthropic", "deepseek"] as const

/** One catalog model with models.dev's field names (`id`, `family`, `release_date`, `limit`, `cost`, `status` …). */
export type CatalogModel = Readonly<Record<string, unknown>>

/** A models.dev catalog (`api.json`): provider id → the provider's fields and its models by id. */
export type Catalog = Readonly<
  Record<string, Readonly<Record<string, unknown>> & { readonly models: Readonly<Record<string, CatalogModel>> }>
>

/** One edit of a catalog variant (fixtures/catalog-variants/README.md). Each names an existing model or fails. */
export type CatalogEdit =
  /** A new model: a copy of `from` of the same provider under the id `add`, with `set` over it. */
  | { readonly provider: string; readonly add: string; readonly from: string; readonly set?: CatalogModel }
  /**
   * Fields of a model replaced, e.g. `status: "deprecated"`, or computed from the model for a nested field such as fewer
   * `capabilities.reasoning.effort` levels (models.dev v2, upstream v2.1).
   */
  | {
      readonly provider: string
      readonly change: string
      readonly set: CatalogModel | ((model: CatalogModel) => CatalogModel)
    }
  /** The model listed under another id with every other field kept (same family and release date). */
  | { readonly provider: string; readonly rename: string; readonly to: string }
  /** A model the catalog no longer lists. */
  | { readonly provider: string; readonly remove: string }

const bundled: { read?: Promise<unknown> } = {}

/** The bundled catalog's `providers` (a copy; the multi-MB file is parsed once per test process). */
export async function bundledCatalog(providers: ReadonlyArray<string> = CATALOG_PROVIDERS): Promise<Catalog> {
  bundled.read ??= Bun.file(BUNDLED_CATALOG).json()
  const all = await bundled.read
  return Object.fromEntries(
    providers.map((id) => {
      const provider = isRecord(all) ? all[id] : undefined
      if (!isRecord(provider) || !isRecord(provider.models)) throw new Error(`the bundled catalog has no ${id}`)
      const models = Object.fromEntries(
        Object.entries(structuredClone(provider.models)).flatMap((entry) =>
          isRecord(entry[1]) ? [[entry[0], entry[1]] as const] : [],
        ),
      )
      return [id, { ...provider, models }] as const
    }),
  )
}

/** `base` with `edits` applied in order. */
export function catalogVariant(base: Catalog, edits: ReadonlyArray<CatalogEdit>): Catalog {
  return edits.reduce<Catalog>((catalog, edit) => {
    const provider = catalog[edit.provider]
    if (!provider) throw new Error(`catalog variant: no provider ${edit.provider}`)
    return { ...catalog, [edit.provider]: { ...provider, models: edited(provider.models, edit) } }
  }, base)
}

function edited(models: Readonly<Record<string, CatalogModel>>, edit: CatalogEdit): Record<string, CatalogModel> {
  const model = (id: string) => {
    const found = models[id]
    if (!found) throw new Error(`catalog variant: no model ${edit.provider}/${id}`)
    return found
  }
  const without = (id: string) => Object.fromEntries(Object.entries(models).filter((entry) => entry[0] !== id))
  if ("add" in edit) return { ...models, [edit.add]: { ...model(edit.from), id: edit.add, ...edit.set } }
  if ("change" in edit) {
    const current = model(edit.change)
    return {
      ...models,
      [edit.change]: { ...current, ...(typeof edit.set === "function" ? edit.set(current) : edit.set) },
    }
  }
  if ("rename" in edit) return { ...without(edit.rename), [edit.to]: { ...model(edit.rename), id: edit.to } }
  // Removing an unknown model fails too, so a catalog update that already dropped it shows.
  model(edit.remove)
  return without(edit.remove)
}

/**
 * `gpt-6.1-sol` as models.dev listed it on 2026-10-01 (07 §4.1, Appendix A), which the bundled catalog and templates
 * predate: a copy of `gpt-6-sol` (family `gpt-sol`, input 922k, $2/M) released 09-29.
 */
export const GPT_61_SOL: CatalogEdit = {
  provider: "openai",
  add: "gpt-6.1-sol",
  from: "gpt-6-sol",
  set: { name: "GPT-6.1 Sol", release_date: "2026-09-29", last_updated: "2026-09-29" },
}

/** The models the bundled templates of 2026-10-01 predate ({@link PresetRigOptions.templatePredates}). */
export const PREDATED_MODELS = ["gpt-6.1-sol", "gpt-6.1-sol-fast", "gpt-6.1-sol-ultrafast", "gpt-6-astra-ultrafast"]

/** `OWN_HOME\codex-meta.json` holding `snapshot` as the `codex` kind's Codex metadata (07 §4.5). */
export function codexMetaFile(
  snapshot: CodexModels.Snapshot,
  accounts?: Readonly<Record<string, CodexModels.Snapshot>>,
): CodexModels.File {
  return { version: 1, kinds: { codex: snapshot }, ...(accounts ? { accounts } : {}) }
}

/**
 * The Codex backend's model list fixture (`test/slots/fixture/codex-models.json`: 07 Appendix A's newer bundle, every
 * value made up where the appendix has none) as a snapshot own-accounts fetched at `at`; malformed rows left out.
 */
export async function codexMetaFixture(at = Date.parse("2026-10-01T00:00:00Z")): Promise<CodexModels.Snapshot> {
  const body: unknown = await Bun.file(path.join(import.meta.dir, "../slots/fixture/codex-models.json")).json()
  const rows = CodexModels.decode(body)
  if (!rows) throw new Error("the Codex model list fixture has no models")
  return { source: "backend", fetchedAt: at, clientVersion: CodexMeta.BACKEND.clientVersion, models: rows.models }
}

// ---------------------------------------------------------------------------------------------------------------
// Presets rig (07 §8.4 PG2, PG4, PG5, PG6, PG10, PG11): own-accounts loaded from its package directory on a real
// server, with linked ChatGPT accounts (fake codex-multi-provider profiles that answer from one fake Codex backend,
// seeded into `accounts.json`), optional `siwc` accounts kept in the registry only (R4 reads their ChatGPT login;
// nothing calls them), and the service registration the `own.preset` entry writer reads (`service-local.json` under
// the server's XDG_STATE_HOME, 06 §2.6 self-HTTP). By default every RPC goes to the workspace Location: its own.accounts
// instance is the only one, so it is also the runtime leader that writes `presets.json`; with `control` the control
// Location runs too and leads, and methods are routed like a client's. A rig may start from a catalog variant
// and with Codex metadata in `OWN_HOME`, and `restart` boots the server again on the same temp root (database,
// OWN_HOME, ledger) with another catalog or metadata. Credentials are fake; the real old-app profiles and this PC's
// `.codex` are never read.

const ACCOUNTS_PACKAGE = path.join(REPO_ROOT, "packages/own-accounts")

export interface PresetRigOptions {
  /** Short name for the temp folder and the build id. */
  readonly name: string
  /** The fake ChatGPT backend every linked account answers from. */
  readonly codex: FakeCodex
  /** Linked ChatGPT accounts: kind `codex`, slug `pg<id>`, label `ChatGPT <id>`. */
  readonly chatgpt: ReadonlyArray<{ readonly id: string; readonly tokens: ChatGPTTokens }>
  /**
   * `siwc` accounts (slug, 4–8 of `[a-z0-9]`) and the ChatGPT login each records: `{of}` shares the login of that
   * linked account, a string is another login.
   */
  readonly siwc?: ReadonlyArray<{ readonly slug: string; readonly login: { readonly of: string } | string }>
  /** More own-accounts endpoints (`deepseek`, …). */
  readonly endpoints?: Readonly<Record<string, string>>
  /** More opencode config (`agents`, `small_model`, …). */
  readonly config?: Readonly<Record<string, unknown>>
  /** More local plugin directories, loaded after own-accounts (`WEBSEARCH_FIXTURE_PLUGIN`, …). */
  readonly plugins?: ReadonlyArray<string>
  /**
   * Turn core's file watcher back on (the harness turns it off), so a write to the global `opencode.jsonc` reloads the
   * config the way it does in an installed service.
   */
  readonly watchConfig?: boolean
  /**
   * `USERPROFILE` is the temp `HOME` too, so the service's `os.homedir()` on Windows (and own-accounts' protected
   * paths placed in it, 01 §13 PP) is the temp folder; without it Windows names the real home there.
   */
  readonly userProfile?: boolean
  /** Files written into the workspace before the server starts (relative path → text). */
  readonly workspaceFiles?: Readonly<Record<string, string>>
  /** Load the workspace's project config and instructions (AGENTS.md), as an installed service does. */
  readonly projectConfig?: boolean
  /** Models listed before the rig returns. */
  readonly models: ReadonlyArray<ModelRef>
  /** The catalog the server starts from (`OPENCODE_MODELS_PATH`); without it, the bundled one. */
  readonly catalog?: Catalog
  /** The Codex metadata in `OWN_HOME\codex-meta.json` at start, as if fetched before (07 §4.5); without it, none. */
  readonly codexMeta?: CodexModels.Snapshot
  /** With `codexMeta`: each account's own list (`accounts`, by account id), what its plan offers (02 §4.8). */
  readonly codexAccounts?: Readonly<Record<string, CodexModels.Snapshot>>
  /**
   * Model ids left out of the seeded templates: an install whose templates were captured before these models existed
   * (the bundled templates of 2026-10-01 lacked the GPT-6.1 Sol models and the Ultrafast modes), so the template diff
   * adds them (07 §4.4).
   */
  readonly templatePredates?: ReadonlyArray<string>
  /**
   * Boot the control Location too (`<OWN_HOME>\control`, 02 §9.1) and route like a client: global methods there,
   * session methods to the workspace (`OwnAccounts.MethodLocation`). Its instance leads the runtime and is the one that
   * writes the pinned-template diff and fetches Codex metadata (07 §4.4, §4.5). Without it every RPC goes to the
   * workspace, whose instance then leads.
   */
  readonly control?: boolean
}

/** What a {@link PresetRig.restart} changes; anything left out stays as it was. */
export interface RestartInput {
  readonly catalog?: Catalog
  /** The Codex metadata snapshot to start with; `null` removes `codex-meta.json`. */
  readonly codexMeta?: CodexModels.Snapshot | null
  /** Models listed before `restart` returns (default: the rig's `models`). */
  readonly models?: ReadonlyArray<ModelRef>
}

/** An own.accounts RPC answer: `output` on 200, else `error` (`{type, message, data?}`). */
export interface RpcAnswer {
  readonly status: number
  readonly output: Record<string, unknown>
  readonly error: Record<string, unknown> | undefined
}

/** A ledger alert line (02 §2.3). */
export interface AlertLine {
  readonly code: string
  readonly severity: string
  readonly message: string
  readonly data: Record<string, unknown>
}

export interface PresetRig extends AsyncDisposable {
  /** The running server; another one after {@link restart}. */
  readonly server: OpencodeServer
  /** The running server's event stream, subscribed before any session exists (again after {@link restart}). */
  readonly events: EventRecorder
  /** OWN_HOME. */
  readonly home: string
  /** Each seeded account by ChatGPT id (`01`) or `siwc` slug. */
  readonly accounts: Readonly<Record<string, { readonly id: string; readonly providerID: string }>>
  rpc(method: string, input?: unknown): Promise<RpcAnswer>
  /** {@link rpc} that throws unless the answer is 200. */
  call(method: string, input?: unknown): Promise<Record<string, unknown>>
  /** A value of own-accounts' plugin storage (`plugin:<id>:<key>` in the server's `kv` table). */
  kv(key: string): unknown
  /** The ledger's alert lines of one code (`OWN_HOME/ledger/events-YYYY-MM.jsonl`), across restarts. */
  alerts(code: string): Promise<ReadonlyArray<AlertLine>>
  /**
   * Writes `OWN_HOME\codex-meta.json` the way another process would (a temp file, then a rename), so a running
   * service's store watcher takes it (07 §4.5); `undefined` removes the file.
   */
  setCodexMeta(snapshot: CodexModels.Snapshot | undefined): Promise<void>
  /**
   * Stops the server and boots it again on the same temp root (database, OWN_HOME, ledger, sessions), with another
   * catalog or Codex metadata: core reads its catalog file once, so a catalog change needs a new process (PG5).
   */
  restart(input?: RestartInput): Promise<void>
  stop(): Promise<void>
}

export async function startPresetRig(options: PresetRigOptions): Promise<PresetRig> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `own-pg-${options.name}-`)))
  const home = path.join(root, "own-home")
  const legacy = path.join(root, "control-center")
  await fs.mkdir(home, { recursive: true })
  const profiles = await writeCodexMultiProviderProfiles(
    legacy,
    options.chatgpt.map((item) => ({ id: item.id, alias: `pg${item.id}`, tokens: item.tokens })),
  )
  const linked = await Promise.all(
    profiles.map(async (profile) => ({
      kind: "codex" as const,
      label: `ChatGPT ${profile.id}`,
      slug: `pg${profile.id}`,
      identity: await sourceIdentity(profile.authPath),
      credential: {
        type: "linked-codex-source" as const,
        source: {
          app: "codex-multi-provider" as const,
          profileID: profile.id,
          alias: profile.alias,
          authPath: profile.authPath,
        },
        linkedAt: "2026-10-01T00:00:00Z",
      },
    })),
  )
  const siwc = (options.siwc ?? []).map((item) => {
    const login = item.login
    const shared = typeof login === "string" ? undefined : linked.find((seed) => seed.slug === `pg${login.of}`)
    return {
      kind: "siwc" as const,
      label: `Sign in ${item.slug}`,
      slug: item.slug,
      identity: {
        fingerprint: `sha256:siwc-${item.slug}`,
        ...(typeof login === "string" ? { login } : shared ? { login: shared.identity.fingerprint } : {}),
      },
    }
  })
  const seeds = [...linked, ...siwc]
  const predates = new Set(options.templatePredates ?? [])
  const seeded = await registryWith(seeds)
  const registry = {
    ...seeded,
    modelTemplates: Object.fromEntries(
      Object.entries(seeded.modelTemplates).map(([id, template]) => [
        id,
        { ...template, models: template.models.filter((model) => !predates.has(model.id)) },
      ]),
    ),
  }
  await Bun.write(path.join(home, "accounts.json"), JSON.stringify(registry, null, 2))
  const catalogFile = path.join(root, "models-catalog.json")
  const setCodexMeta = async (snapshot: CodexModels.Snapshot | undefined) => {
    const file = path.join(home, "codex-meta.json")
    if (snapshot === undefined) return fs.rm(file, { force: true })
    await replaceFile(file, JSON.stringify(codexMetaFile(snapshot, options.codexAccounts), null, 2))
  }
  const config = opencodeConfig({
    providers: {},
    plugins: [
      {
        package: ACCOUNTS_PACKAGE,
        options: {
          home,
          buildId: `e2e-pg-${options.name}-${process.pid}`,
          vault: "memory",
          endpoints: { codex: options.codex.baseURL, oauthIssuer: options.codex.url, ...options.endpoints },
          codexImportRoot: legacy,
        },
      },
      ...(options.plugins ?? []),
    ],
    extra: options.config,
  })
  const remove = () => (process.env.OWN_E2E_KEEP === "1" ? undefined : removeTree(root))
  const control = path.join(home, "control")
  if (options.control) await fs.mkdir(control, { recursive: true })
  /** The Location a method goes to: the workspace, or with `control` the method's own (02 §9.1). */
  const directoryOf = (method: string, workspace: string) =>
    options.control &&
    Object.entries(OwnAccounts.MethodLocation).some(([name, at]) => name === method && at === "control")
      ? control
      : workspace
  const request = (server: OpencodeServer, method: string, input: unknown) => {
    const directory = directoryOf(method, server.paths.workspace)
    return server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
  }
  /** `health` on the control Location, asked again for up to 60 s while own.accounts has not registered yet. */
  const controlHealth = async (server: OpencodeServer) => {
    const deadline = Date.now() + 60_000
    while (true) {
      const response = await request(server, "health", {})
      if (response.ok || Date.now() > deadline) return response
      const text = await response.clone().text()
      if (!text.includes("rpc.unavailable")) return response
      await Bun.sleep(100)
    }
  }
  /** One server on the temp root, its service registration and its event stream; nothing left running on failure. */
  const boot = async (models: ReadonlyArray<ModelRef>, catalog: boolean) => {
    const server = await startOpencodeServer({
      root,
      env: {
        OWN_OPEN_CODE: "1",
        ...(options.watchConfig ? { OPENCODE_DISABLE_FILEWATCHER: "false" } : {}),
        ...(options.userProfile ? { USERPROFILE: path.join(root, "home") } : {}),
      },
      ...(catalog ? { models: catalogFile } : {}),
      ...(options.workspaceFiles ? { workspaceFiles: options.workspaceFiles } : {}),
      ...(options.projectConfig ? { projectConfig: true } : {}),
      config,
    })
    const started = async () => {
      // The `own.preset` entry writer reads the channel's registration file (`ServiceTarget.Service`) when it first
      // writes; the server password is new on every boot.
      const registration = ServiceTarget.registrationPath("local", {
        XDG_STATE_HOME: path.dirname(server.paths.state),
      })
      await fs.mkdir(path.dirname(registration), { recursive: true })
      await Bun.write(
        registration,
        JSON.stringify({ url: server.url, password: atob(server.authorization.slice("Basic ".length)).slice(9) }),
      )
      const events = await recordServerEvents(server)
      const settle = async () => {
        // A Location boots on its first request: the control one first, so it leads from the start. Plugins load in the
        // background (upstream v2.4.0 #63814), so `rpc.unavailable` until own.accounts registered is asked again.
        const health = options.control ? await controlHealth(server) : undefined
        if (health && !health.ok) throw new Error(`control health: HTTP ${health.status} ${await health.text()}`)
        await server.waitForModels(models)
      }
      await settle().catch(async (error: unknown) => {
        await events.close()
        throw error
      })
      return { server, events }
    }
    return started().catch(async (error: unknown) => {
      await server.stop()
      throw error
    })
  }
  if (options.catalog) await Bun.write(catalogFile, JSON.stringify(options.catalog))
  if (options.codexMeta) await setCodexMeta(options.codexMeta)
  const live = {
    catalog: options.catalog !== undefined,
    current: await boot(options.models, options.catalog !== undefined).catch(async (error: unknown) => {
      await remove()
      throw error
    }),
  }
  const rpc = async (method: string, input: unknown = {}): Promise<RpcAnswer> => {
    const response = await request(live.current.server, method, input)
    const body: unknown = await response.json()
    const record = isRecord(body) ? body : {}
    return {
      status: response.status,
      output: isRecord(record.output) ? record.output : {},
      error: response.status === 200 ? undefined : record,
    }
  }
  const halt = async () => {
    await live.current.events.close()
    await live.current.server.stop()
  }
  const rig: PresetRig = {
    get server() {
      return live.current.server
    },
    get events() {
      return live.current.events
    },
    home,
    accounts: Object.fromEntries(
      seeds.map((seed) => [
        seed.kind === "codex" ? seed.slug.slice(2) : seed.slug,
        { id: `acc_${seed.slug}`, providerID: `own-${seed.kind}-${seed.slug}` },
      ]),
    ),
    rpc,
    call: async (method, input) => {
      const answer = await rpc(method, input)
      if (answer.status !== 200) throw new Error(`${method}: HTTP ${answer.status} ${JSON.stringify(answer.error)}`)
      return answer.output
    },
    kv: (key) => pluginValue(live.current.server.paths.database, key),
    alerts: (code) => ledgerAlerts(home, code),
    setCodexMeta,
    restart: async (input = {}) => {
      await halt()
      if (input.catalog) await Bun.write(catalogFile, JSON.stringify(input.catalog))
      if (input.codexMeta !== undefined) await setCodexMeta(input.codexMeta ?? undefined)
      live.catalog ||= input.catalog !== undefined
      live.current = await boot(input.models ?? options.models, live.catalog)
    },
    stop: async () => {
      await halt()
      await remove()
    },
    [Symbol.asyncDispose]: () => rig.stop(),
  }
  return rig
}

/** The registry identity of a linked profile (`chatgptAccountId`, `fingerprint` = its ChatGPT login). */
async function sourceIdentity(authPath: string) {
  const read = await CodexSource.read(authPath)
  if (!read.ok) throw new Error(`fixture source unreadable: ${read.problem}`)
  const identity = read.snapshot.summary.identity
  if (!identity.chatgptAccountId || !identity.fingerprint) throw new Error("fixture source without identity")
  return { chatgptAccountId: identity.chatgptAccountId, fingerprint: identity.fingerprint }
}

function pluginValue(database: string, key: string): unknown {
  const db = new Database(database, { readonly: true })
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM kv WHERE key LIKE 'plugin:%'")
      .all()
    const row = rows.find((item) => item.key.endsWith(`:${key}`))
    return row === undefined ? undefined : JSON.parse(row.value)
  } finally {
    db.close()
  }
}

/** The ledger's alert lines of one code (`OWN_HOME/ledger/events-YYYY-MM.jsonl`, 02 §2.3). */
export async function ledgerAlerts(home: string, code: string): Promise<ReadonlyArray<AlertLine>> {
  const dir = path.join(home, "ledger")
  const names = await fs.readdir(dir).catch(() => [])
  const texts = await Promise.all(
    names
      .filter((name) => /^events-\d{4}-\d{2}\.jsonl$/.test(name))
      .map((name) => Bun.file(path.join(dir, name)).text()),
  )
  // The server appends while a test polls, and every append ends in "\n": only text after the last one can be a
  // half-written line, which the product reader skips too (own-runtime ledger-writer.ts). Complete lines stay strict.
  return texts
    .flatMap((text) => text.slice(0, text.lastIndexOf("\n") + 1).split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line))
    .flatMap((line) =>
      isRecord(line) && line.type === "alert" && isRecord(line.data) && line.data.code === code
        ? [{ code, severity: String(line.data.severity), message: String(line.data.message), data: line.data }]
        : [],
    )
}

/**
 * What the lines of a JSON-lines log give away (02 §7.2: own-accounts' log carries no credential and none of the user's
 * words): per line, a match of a `Redact.PATTERNS` secret, a `Bearer` value that is not a redaction marker, a
 * secret-named field (`Redact.FIELDS`) whose string value is not one, a line that is not JSON, or one of `plain` (the
 * prompts, the answers, raw secrets). Never the values themselves; `[]` when the text is clean.
 */
export function logLeaks(text: string, plain: ReadonlyArray<string> = []): string[] {
  const patterns = Redact.PATTERNS.map((item) => ({
    label: item.label,
    pattern: new RegExp(item.pattern.source, item.pattern.flags.replace("g", "")),
  }))
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line, index) => {
      const parsed = Option.getOrUndefined(decodeLine(line))
      const found = [
        ...(parsed === undefined ? ["not JSON"] : secretFields(parsed)),
        ...patterns.filter((item) => item.pattern.test(line)).map((item) => item.label),
        ...(/\bBearer\s+(?!\[redacted:)[A-Za-z0-9._~+/=-]{8,}/i.test(line) ? ["bearer value"] : []),
        ...plain.flatMap((value, position) => (line.includes(value) ? [`plain text #${position}`] : [])),
      ]
      return found.map((reason) => `line ${index + 1}: ${reason}`)
    })
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** Secret-named fields of a parsed log line whose string value is not a `Redact.marker`. */
function secretFields(value: unknown, name = ""): string[] {
  if (typeof value === "string")
    return Redact.FIELDS.has(name.toLowerCase()) && !/^\[redacted:[0-9a-f]{8}\]$/.test(value) ? [`field ${name}`] : []
  if (Array.isArray(value)) return value.flatMap((item) => secretFields(item, name))
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap((entry) => secretFields(entry[1], entry[0]))
}

/** One call of a tool as the session message API returns it. */
export interface ToolPart {
  readonly id: string
  readonly name: string
  readonly state: {
    readonly status: string
    readonly input: unknown
    readonly error?: unknown
    readonly metadata?: Readonly<Record<string, unknown>>
  }
}

/** The session's assistant messages, oldest first (the API lists the newest first). */
export async function assistantMessages(server: OpencodeServer, sessionID: string) {
  return (await server.messages(sessionID)).filter((message) => message.type === "assistant").toReversed()
}

/** The session's calls of `name`, oldest first. */
export async function toolParts(server: OpencodeServer, sessionID: string, name: string): Promise<ToolPart[]> {
  return (await assistantMessages(server, sessionID))
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter(
      (part): part is ToolPart => isRecord(part) && part.type === "tool" && part.name === name && isRecord(part.state),
    )
}

/** A tool call's error message (`state.error.message`), `""` without one. */
export function toolError(part: ToolPart) {
  const error = part.state.error
  return isRecord(error) && typeof error.message === "string" ? error.message : ""
}

/** A session as `GET /api/session/:id` returns it. */
export async function sessionInfo(server: OpencodeServer, sessionID: string): Promise<Record<string, unknown>> {
  const session = await server.call("GET", `/api/session/${sessionID}`)
  if (!isRecord(session) || !isRecord(session.data)) throw new Error(`no session ${sessionID}`)
  return session.data
}

/** The child session a subagent call ran or launched (`metadata.sessionID`), as `GET /api/session/:id` returns it. */
export async function childOf(
  server: OpencodeServer,
  part: ToolPart,
): Promise<Record<string, unknown> & { readonly id: string }> {
  const childID = part.state.metadata?.sessionID
  if (typeof childID !== "string") throw new Error(`subagent call without a child: ${JSON.stringify(part.state)}`)
  return { ...(await sessionInfo(server, childID)), id: childID }
}

/** The session's instruction entries (`GET /api/experimental/session/:id/instructions/entries`). */
export async function instructionEntries(server: OpencodeServer, sessionID: string) {
  const entries = await server.call("GET", `/api/experimental/session/${sessionID}/instructions/entries`)
  return (isRecord(entries) && Array.isArray(entries.data) ? entries.data : []).filter(isRecord)
}

/** A request's conversation items: a chat request's `messages`, else a Responses (or Codex) `input`. */
export function requestItems(request: RecordedRequest): readonly unknown[] {
  const json = request.json
  if (!isRecord(json)) return []
  if (Array.isArray(json.messages)) return json.messages
  return Array.isArray(json.input) ? json.input : []
}

/** The text of the request's last user item. */
export function lastUserText(request: RecordedRequest) {
  const user = requestItems(request).findLast((item) => isRecord(item) && item.role === "user")
  if (!isRecord(user)) return ""
  if (typeof user.content === "string") return user.content
  return (Array.isArray(user.content) ? user.content : [])
    .flatMap((part: unknown) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
}

/** Whether a request answers a tool call: its last item is a tool result (Responses or chat). */
export function afterToolResult(request: RecordedRequest) {
  const last = requestItems(request).at(-1)
  // `custom_tool_call_output`: a freeform tool's result (upstream's `patch` on models whose capabilities list freeform
  // input, v2.3.0 #61703).
  return (
    isRecord(last) &&
    (last.type === "function_call_output" || last.type === "custom_tool_call_output" || last.role === "tool")
  )
}

/** The text of every tool result in a request (`function_call_output` and `custom_tool_call_output` items, or chat `tool` messages). */
export function toolOutputs(request: RecordedRequest) {
  return requestItems(request).flatMap((item) => {
    if (
      !isRecord(item) ||
      !(item.type === "function_call_output" || item.type === "custom_tool_call_output" || item.role === "tool")
    )
      return []
    const output = item.role === "tool" ? item.content : item.output
    if (typeof output === "string") return [output]
    if (!Array.isArray(output)) return [JSON.stringify(output)]
    return [
      output
        .map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : JSON.stringify(part)))
        .join("\n"),
    ]
  })
}

/** Polls `probe` until it answers something other than `undefined` or `false`. */
export async function waitUntil<T>(probe: () => Promise<T | false | undefined>, message: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== false && value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`${message} within ${timeoutMs} ms`)
}

/** Replaces a file the way an editor saves it (a temp file, then a rename), so a file watcher sees one change. */
export async function replaceFile(file: string, text: string) {
  const temp = `${file}.${process.pid}.tmp`
  await Bun.write(temp, text)
  await fs.rename(temp, file)
}
