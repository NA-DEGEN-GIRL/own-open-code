export * as Endpoints from "./endpoints.js"

import type { Options } from "./options.js"

export type Name = keyof Options.EndpointOverrides

/**
 * Production endpoints (02 §3.2, §3.3, §3.6, §7.1, §9.2 web search services; 07 §4.5 the npm registry of the Codex
 * version check; 03 §18.14 the MCP Registry of 찾아서 설치).
 */
export const DEFAULTS: Readonly<Record<Name, string>> = {
  codex: "https://chatgpt.com/backend-api/codex",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  oauthIssuer: "https://auth.openai.com",
  chatgpt: "https://chatgpt.com/backend-api",
  deepgram: "https://api.deepgram.com",
  npmRegistry: "https://registry.npmjs.org",
  mcpRegistry: "https://registry.modelcontextprotocol.io",
  brave: "https://api.search.brave.com/res/v1",
  // Core's keyless web search services, asked by own with the user's key (src/websearch/keyed.ts): core's own URLs.
  exa: "https://mcp.exa.ai/mcp",
  firecrawl: "https://mcp.firecrawl.dev/v2/mcp",
  parallel: "https://search.parallel.ai/mcp",
  tavily: "https://api.tavily.com/search",
  tinyfish: "https://agent.tinyfish.ai/mcp",
  // The GitHub connection (16, GH): github.com's web root, its REST API and GitHub's hosted MCP server.
  github: "https://github.com",
  githubApi: "https://api.github.com",
  githubMcp: "https://api.githubcopilot.com/mcp/",
}

export interface Endpoints {
  /** Effective URL of every endpoint (override or default). */
  readonly url: Readonly<Record<Name, string>>
  /**
   * Overridden endpoints only. A slot writes `settings.baseURL` from here for kinds whose production slot omits it
   * (02 §3.6 "나머지: 생략"); codex always writes `url.codex`, compat always its user base URL.
   */
  readonly overrides: Readonly<Partial<Record<Name, string>>>
}

export function resolve(overrides: Options.EndpointOverrides = {}): Endpoints {
  const given: Partial<Record<Name, string>> = Object.fromEntries(
    Object.entries(overrides).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  // The Codex backend lives under the ChatGPT backend root (`…/backend-api/codex`): a moved Codex endpoint (a test
  // fake) moves the root too, so the `wham/usage` poll never leaves for chatgpt.com on its own.
  const chatgpt = given.chatgpt ?? given.codex?.replace(/\/codex\/?$/, "")
  return { url: { ...DEFAULTS, ...given, ...(chatgpt === undefined ? {} : { chatgpt }) }, overrides: given }
}
