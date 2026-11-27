export * as Options from "./options.js"

import { Schema } from "effect"
import { PositiveInt, NonNegativeInt, optional } from "@opencode/schema/schema"

/**
 * Test-only endpoint overrides so E2E tests reach the fakes in `test/e2e-kit` (see its README). Production leaves
 * them unset and uses {@link Endpoints.DEFAULTS}. Provider base URLs use the same meaning as the provider package's
 * `settings.baseURL`; an overridden one is also written into the slot's static `settings.baseURL`.
 */
export const EndpointOverrides = Schema.Struct({
  /** ChatGPT Codex backend, e.g. fake `codex.baseURL` (`…/backend-api/codex`). */
  codex: optional(Schema.String),
  /** OpenAI API base (`…/v1`). */
  openai: optional(Schema.String),
  /** Anthropic API base (`…/v1`). */
  anthropic: optional(Schema.String),
  /** DeepSeek API base (`…/v1`); the balance probe uses `/user/balance` on its origin. */
  deepseek: optional(Schema.String),
  xai: optional(Schema.String),
  openrouter: optional(Schema.String),
  /** ChatGPT OAuth issuer root (device code, PKCE, `/oauth/token`), e.g. fake `codex.url`. */
  oauthIssuer: optional(Schema.String),
  /** ChatGPT web backend root for the optional `wham/usage` poller. */
  chatgpt: optional(Schema.String),
  /** Deepgram API root (voice input, 02 §3.9); `/v1/listen` is appended. OpenAI voice input uses `openai`. */
  deepgram: optional(Schema.String),
  /**
   * npm registry root of the Codex version check (07 §4.5, CA): `/@openai/codex/latest` is appended. A service given
   * any other override but not this one never checks, so no test reaches the real registry.
   */
  npmRegistry: optional(Schema.String),
  /**
   * The MCP Registry root of 설정 > MCP 서버 `찾아서 설치` (03 §18.14, SM): `/v0.1/servers` is appended. A service
   * given any other override but not this one never asks, so no test reaches the real registry.
   */
  mcpRegistry: optional(Schema.String),
  /** Brave Search API root (`…/res/v1`, the web search service `brave`, 02 §9.2); `/web/search` is appended. */
  brave: optional(Schema.String),
  /**
   * The request URLs of own's keyed variants of core's keyless web search services (`own-exa` …, 02 §9.2, SK): the
   * same URLs as core's (packages/core/src/plugin/websearch/*.ts `endpoint`), whole (nothing is appended).
   */
  exa: optional(Schema.String),
  firecrawl: optional(Schema.String),
  parallel: optional(Schema.String),
  tavily: optional(Schema.String),
  tinyfish: optional(Schema.String),
  /**
   * github.com's addresses for the GitHub connection (16, GH): its web root (the browser login's `/login/device/code`
   * and `/login/oauth/access_token`), its REST API root (`/user` …) and GitHub's hosted MCP server. A GitHub Enterprise
   * site is asked at its own address. A service given any other override but not these never asks github.com, so no
   * test reaches it.
   */
  github: optional(Schema.String),
  githubApi: optional(Schema.String),
  githubMcp: optional(Schema.String),
})
export type EndpointOverrides = typeof EndpointOverrides.Type

export const VaultOption = Schema.Union([
  /** In-process vault without encryption. Tests only: secrets live in memory and vanish on restart. */
  Schema.Literal("memory"),
  Schema.Struct({
    /**
     * Default: the installed version's (`<OWN_HOME>\app\<version>\own-vault.exe`, from app\current.json); development
     * uses `own/native/own-vault/target/release`.
     */
    exePath: optional(Schema.String),
    /** Replaces `[exePath, "--home", home]`, e.g. a fake helper. */
    command: optional(Schema.Array(Schema.String)),
    timeoutMs: optional(PositiveInt),
  }),
])
export type VaultOption = typeof VaultOption.Type

export const LogLevel = Schema.Literals(["debug", "info", "warn", "error"])
export type LogLevel = typeof LogLevel.Type

/**
 * Credential broker knobs (04 §8). Tests only: production leaves them unset and uses the host settings own-remote
 * configures (`leaseSeconds` ≥ 60 s) and the protocol defaults.
 */
export const BrokerTesting = Schema.Struct({
  /** Local: lease length instead of the host's `leaseSeconds`, so a fail-closed test does not wait minutes. */
  leaseMs: optional(PositiveInt),
  /** Local: `brokerWaitMs` sent to hosts in `ready` (default 10 s, 04 §8.6 step 4). */
  brokerWaitMs: optional(NonNegativeInt),
  /** Remote: the socket endpoint is a fake-SSH placeholder file naming a local TCP relay (Windows test harness). */
  dial: optional(Schema.Literal("placeholder")),
  /**
   * Remote: the first mirror sync of this process waits this long after the broker connected, as a slow broker does
   * under load (own-web's remote suite: a new session must wait until the host lists this PC's model, MR11-1).
   */
  mirrorDelayMs: optional(PositiveInt),
  /** Remote: `ping` interval (default 5 min). */
  pingMs: optional(PositiveInt),
  /** Remote: spool bounds (default 20 MiB, 100 000 items, 7 days). */
  spoolLimits: optional(
    Schema.Struct({ bytes: optional(PositiveInt), items: optional(PositiveInt), ageMs: optional(PositiveInt) }),
  ),
  /**
   * Local (04 §8.11.5): the Claude egress relay's upstream origin instead of `https://api.anthropic.com`, a loopback
   * fake only (`http://127.0.0.1:<port>`); anything else is ignored.
   */
  claudeUpstream: optional(Schema.String),
})
export type BrokerTesting = typeof BrokerTesting.Type

/** `ctx.options` of own-accounts (`{ "package": "<dir>", "options": { … } }` in `opencode.jsonc`). No secrets. */
export const Info = Schema.Struct({
  /**
   * `local` (default): this PC, with the vault and the local credential broker. `remote`: inside a remote service on
   * an SSH host (04 §9): no vault, registry mirrored from the local PC, credentials leased by the local broker.
   */
  mode: optional(Schema.Literals(["local", "remote"])),
  /** `OWN_HOME` (02 §2.3). Development and tests must set it. */
  home: optional(Schema.String),
  /** Overrides {@link Build.BUILD_ID}; tests give both own plugins the same value. */
  buildId: optional(Schema.String),
  vault: optional(VaultOption),
  endpoints: optional(EndpointOverrides),
  /**
   * codex-multi-provider control-center root for `accounts.import.codex.*` (02 §3.2a). Default
   * `CodexSource.DEFAULT_CONTROL_CENTER`. Tests always point it at a temp fixture, never at the real old-app profiles.
   */
  codexImportRoot: optional(Schema.String),
  /**
   * Codex CLI home whose `config.toml` and `models_cache.json` decide the ChatGPT group's `auto` new-session default
   * (07 §2.2, read only). Default `CODEX_HOME`, else `~/.codex`. Tests always point it at a fixture folder.
   */
  codexHome: optional(Schema.String),
  /**
   * The user's home whose Claude Code `.claude.json` `다른 도구에서 가져오기` reads for MCP servers (03 §18.14, SM; only
   * when the user asks). Default `%USERPROFILE%`. Tests always point it at a fixture folder.
   */
  claudeHome: optional(Schema.String),
  /**
   * The built-in default conversation folder (03 §5.1 기본 대화 폴더) instead of `<documents>\Own OpenCode`. Tests point
   * it at a temp folder; production leaves it unset.
   */
  conversationFolder: optional(Schema.String),
  /** Initial secret cache TTL until `policy.json` is read. */
  secretCacheSeconds: optional(NonNegativeInt),
  /** Seed of `ratecards.json` on first run (development: `own/config/ratecards.default.json`). */
  ratecardsSeed: optional(Schema.String),
  logLevel: optional(LogLevel),
  /** Tests only: see {@link BrokerTesting}. */
  broker: optional(BrokerTesting),
})
export type Info = typeof Info.Type

const decodeInfo = Schema.decodeUnknownSync(Info)

/** Validates `ctx.options` once at the plugin boundary. Throws with the schema issue; options never hold secrets. */
export function decode(input: unknown): Info {
  return decodeInfo(input ?? {})
}
