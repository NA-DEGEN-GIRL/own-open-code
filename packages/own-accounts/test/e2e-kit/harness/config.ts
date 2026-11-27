import type { FakeProvider } from "../fakes/fake-server"

/** A config-level model entry (`providers.<id>.models.<modelID>`), see `@opencode/schema/config/provider`. */
export type ModelEntry = Readonly<Record<string, unknown>>

export interface ProviderInput {
  /** Credential sent by the provider package (`settings.apiKey`). Use fake values only. */
  readonly apiKey?: string
  readonly name?: string
  /** Model ids, or a map of model id to config entry overrides. */
  readonly models: readonly string[] | Readonly<Record<string, ModelEntry>>
  readonly headers?: Readonly<Record<string, string>>
  /** Merged into `settings` (e.g. `transport`, `timeout`). */
  readonly settings?: Readonly<Record<string, unknown>>
}

/**
 * Builds a `providers.<id>` config entry for a native `@opencode/ai` package pointed at a fake.
 * Config providers are what the smoke test uses; own-accounts slots are registered by the plugin
 * instead (01 §8.2) and only need the fake's `baseURL`.
 */
export function providerConfig(fake: FakeProvider, packageName: string, input: ProviderInput) {
  return {
    name: input.name ?? `Fake ${fake.name}`,
    package: packageName,
    settings: {
      baseURL: fake.baseURL,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...input.settings,
    },
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    models: Array.isArray(input.models)
      ? Object.fromEntries(input.models.map((id) => [id, { name: id }]))
      : input.models,
  }
}

export const openAIResponsesProvider = (fake: FakeProvider, input: ProviderInput) =>
  providerConfig(fake, "@opencode/ai/providers/openai", input)

export const anthropicProvider = (fake: FakeProvider, input: ProviderInput) =>
  providerConfig(fake, "@opencode/ai/providers/anthropic", input)

/** DeepSeek native package (OpenAI chat completions with `prompt_cache_hit_tokens`). */
export const deepseekProvider = (fake: FakeProvider, input: ProviderInput) =>
  providerConfig(fake, "@opencode/ai/providers/deepseek", input)

export const openAICompatibleProvider = (fake: FakeProvider, input: ProviderInput) =>
  providerConfig(fake, "@opencode/ai/providers/openai-compatible", input)

/**
 * A static Codex (ChatGPT) provider for tests that do not load own-accounts: the access token is the
 * API key and the account header is fixed, mirroring what own-accounts injects per request.
 */
export function codexProvider(
  fake: FakeProvider,
  input: Omit<ProviderInput, "apiKey"> & {
    readonly accessToken: string
    readonly accountID: string
    readonly transport?: "http" | "websocket"
  },
) {
  return providerConfig(fake, "@opencode/ai/providers/openai", {
    ...input,
    apiKey: input.accessToken,
    headers: {
      originator: "opencode",
      "chatgpt-account-id": input.accountID,
      ...input.headers,
    },
    settings: { transport: input.transport ?? "http", ...input.settings },
  })
}

/**
 * Minimal opencode config: providers, optional ordered plugins and default model. Updates and sharing
 * are disabled so a test server never reaches the network on its own.
 */
export function opencodeConfig(input: {
  readonly providers: Readonly<Record<string, unknown>>
  readonly plugins?: readonly (string | { readonly package: string; readonly options?: Record<string, unknown> })[]
  readonly model?: string
  readonly extra?: Readonly<Record<string, unknown>>
}) {
  return {
    update: "disable",
    share: "disabled",
    // own's services list none of core's automation, image or video tools (own-accounts' fold: Policy.AUTOMATION_TOOLS,
    // IMAGE_GENERATE_TOOL, VIDEO_GENERATE_TOOL; decisions MR18); a kit server without own-accounts matches that. A test
    // of the fold turns core's tools back on through `extra`.
    automations: false,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.plugins === undefined ? {} : { plugins: input.plugins }),
    providers: input.providers,
    ...input.extra,
    experimental: { image_generate: false, video_generate: false, ...experimentalOf(input.extra) },
    // own's services keep core's background compaction off (CoreConfig.ensureBackgroundOff, MR18-8).
    compaction: { background: false, ...compactionOf(input.extra) },
  }
}

function experimentalOf(extra: Readonly<Record<string, unknown>> | undefined) {
  const value = extra?.experimental
  return typeof value === "object" && value !== null ? value : {}
}

function compactionOf(extra: Readonly<Record<string, unknown>> | undefined) {
  const value = extra?.compaction
  return typeof value === "object" && value !== null ? value : {}
}
