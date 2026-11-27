// Speed module test setup (02 §4.8): a real runtime (memory vault), the real slots, Codex metadata and speed modules
// over a seeded registry with two Codex accounts, a Sign in with ChatGPT account, an OpenAI and an Anthropic API key.
// The fold's catalog carries the base models and their mode entries (models.dev `experimental.modes`). Telemetry
// alerts and RPC events are captured; logins answer no headers, so nothing reaches a network. Every value is made up.

import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import type { SessionID } from "@opencode/schema/session-id"
import type {
  SessionContext,
  SessionHttpRequest,
  SessionHttpResponse,
  SessionRetry,
  SessionWebSocketReceive,
} from "@opencode/plugin/promise/session"
import { Account, type CodexModels, type Ratecard } from "@own/protocol"
import type { ClaudeAccounts } from "../../src/claude/accounts.js"
import type { ClaudeAgent } from "../../src/claude-agent/agent.js"
import { Modules } from "../../src/modules.js"
import type { RemoteHost } from "../../src/remote/host.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps } from "../support/deps.js"
import { catalogModel, fakeEditor, memoryStorage, price, registryWith } from "../slots/support.js"

export const CODEX_A = "own-codex-aaaa"
export const CODEX_B = "own-codex-bbbb"
export const SIWC = "own-siwc-ssss"
export const OAI = "own-oai-oooo"
export const ANTH = "own-anth-nnnn"
export const DS = "own-ds-dddd"

const tiers = (...ids: ReadonlyArray<string>): CodexModels.Tier[] =>
  ids.map((id) => ({ id, name: id === "priority" ? "Fast" : "Ultrafast" }))

/** Each Codex account's own list (02 §4.8): A's plan offers Ultrafast on gpt-6-astra, B's only Fast. */
export const ACCOUNT_LISTS: Readonly<Record<string, CodexModels.Snapshot>> = {
  acc_aaaa: {
    source: "backend",
    fetchedAt: 1,
    models: [
      { slug: "gpt-6-astra", service_tiers: tiers("priority", "ultrafast") },
      { slug: "gpt-6-sol", service_tiers: tiers("priority") },
      { slug: "gpt-6-luna", service_tiers: [] },
    ],
  },
  acc_bbbb: {
    source: "backend",
    fetchedAt: 1,
    models: [{ slug: "gpt-6-astra", service_tiers: tiers("priority") }],
  },
}

/** Plan multiples as the seed writes them (`ratecards.json` `speed`). */
export const SPEED_CARDS: ReadonlyArray<Ratecard.SpeedCard> = [
  { match: { kind: "codex" }, tier: "priority", included: 2.5, credits: 2, source: "test", date: "2026-10-06" },
  { match: { kind: "codex" }, tier: "ultrafast", included: 8, credits: 6, source: "test", date: "2026-10-06" },
]

const mode = (providerID: string, base: string, name: string, body: Record<string, unknown>, cost: [number, number]) =>
  catalogModel(providerID, `${base}-${name}`, { modelID: Model.ID.make(base), body, cost: [price(...cost)] })

/** The fold's catalog: base models with their speed and pro modes. */
export const CATALOG = {
  openai: [
    catalogModel("openai", "gpt-6-astra", { cost: [price(10, 50)] }),
    mode("openai", "gpt-6-astra", "fast", { service_tier: "priority" }, [20, 100]),
    mode("openai", "gpt-6-astra", "ultrafast", { service_tier: "ultrafast" }, [60, 300]),
    mode("openai", "gpt-6-astra", "pro", { reasoning: { mode: "pro" } }, [10, 50]),
    catalogModel("openai", "gpt-6-sol", { cost: [price(2, 10)] }),
    mode("openai", "gpt-6-sol", "fast", { service_tier: "priority" }, [4, 20]),
  ],
  anthropic: [
    catalogModel("anthropic", "claude-opus-5-5", { cost: [price(4, 20)] }),
    mode("anthropic", "claude-opus-5-5", "fast", { speed: "fast" }, [8, 40]),
    catalogModel("anthropic", "claude-sonnet-5-5", { cost: [price(2, 10)] }),
  ],
}

export async function speedSetup(
  input: {
    readonly claude?: boolean
    /** The Claude accounts module's lookups over the real one (which Claude account a tree runs on). */
    readonly claudeAccounts?: Partial<ClaudeAccounts.Api>
    /** A remote service whose PC relays the Claude slot (04 §8.11.9): the PC's Fast consent as mirrored. */
    readonly remote?: { fast: boolean }
    /** The Claude Agent module's account and model list over the real one (CAM-6). */
    readonly claudeAgent?: Partial<ClaudeAgent.Api>
  } = {},
) {
  const kv = memoryStorage()
  const logs: string[] = []
  const alerts: Telemetry.AlertInput[] = []
  const events: Array<{ readonly name: string; readonly payload: Record<string, unknown> }> = []
  const remote = input.remote
  const t = await testDeps({
    logs,
    ctx: {
      storage: kv.storage,
      provider: { reload: async () => {}, list: async () => [] },
      // Only sessions in the runtime index exist; another one is not created yet (an optimistic create).
      session: {
        get: async () => {
          throw new Error("session not found")
        },
      },
    },
    // SAFETY: the speed module reads only `claude()` of the remote service.
    ...(remote
      ? {
          remote: {
            claude: () => ({
              state: "enabled" as const,
              fast: remote.fast,
              display: { label: null, shortLabel: "C", color: "orange" as const },
            }),
          } as unknown as RemoteHost.Api,
        }
      : {}),
  })
  await t.deps.runtime.registry.write(
    await registryWith([
      { kind: "codex", slug: "aaaa", label: "ChatGPT A" },
      { kind: "codex", slug: "bbbb", label: "ChatGPT B" },
      { kind: "siwc", slug: "ssss", label: "Sign in" },
      { kind: "oai", slug: "oooo", label: "OpenAI" },
      { kind: "anth", slug: "nnnn", label: "Anthropic" },
      { kind: "ds", slug: "dddd", label: "DeepSeek" },
    ]),
  )
  await CodexMeta.file(t.deps.runtime.layout).write({ version: 1, kinds: {}, accounts: ACCOUNT_LISTS })
  await t.deps.runtime.ratecards.write({ schemaVersion: 1, updatedAt: "2026-10-06", cards: [], speed: SPEED_CARDS })
  const claude = { detected: input.claude ?? false }
  const modules = t.modules({
    plugins: (deps, peers) => ({
      ...Modules.FACTORIES.plugins(deps, peers),
      claudeSlot: () => ({ detected: claude.detected, version: null, integrity: null, verified: claude.detected }),
    }),
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
    logins: (deps, peers) => ({
      ...Modules.FACTORIES.logins(deps, peers),
      headers: async () => ({ ok: false as const, problem: "needs_reauth" as const, detail: "test" }),
    }),
    claude: (deps, peers) => ({ ...Modules.FACTORIES.claude(deps, peers), ...input.claudeAccounts }),
    claudeAgent: (deps, peers) => ({ ...Modules.FACTORIES.claudeAgent(deps, peers), ...input.claudeAgent }),
  })
  await modules.slots.start()
  await modules.codexMeta.start()
  await modules.speed.start()
  modules.slots.transformProviders(
    fakeEditor({ openai: { models: CATALOG.openai }, anthropic: { models: CATALOG.anthropic } }).editor,
  )
  // SAFETY: the fake implements the only member the emitter uses, `events.emit`.
  const registration = {
    events: {
      emit: async (name: string, payload: Record<string, unknown>) => void events.push({ name, payload }),
    },
  }
  t.deps.emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
  return {
    t,
    kv,
    logs,
    alerts,
    events,
    claude,
    modules,
    speed: modules.speed,
    /** A session in the runtime index, as its Location's events write it. */
    session(sessionID: string, providerID: string, modelID: string, parentID: string | null = null) {
      t.deps.runtime.sessions.update(sessionID, { providerID, modelID, parentID, directory: t.home })
    },
    /** The speed events seen so far, as `[sessionID, reason, effective]`. */
    changes() {
      return events
        .filter((event) => event.name === "session.speed.changed")
        .map((event) => [event.payload.sessionID, event.payload.reason, event.payload.effective])
    },
    async settle() {
      await Bun.sleep(0)
      await Promise.resolve()
    },
    async [Symbol.asyncDispose]() {
      await modules.speed.stop()
      await modules.codexMeta.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

const scope = (sessionID: string, providerID: string, modelID: string) => ({
  sessionID: sessionID as SessionID,
  agent: "build" as Agent.ID,
  model: { providerID, id: modelID } as unknown as Model.Ref,
})

export function contextEvent(sessionID: string, providerID: string, modelID: string): SessionContext {
  return { ...scope(sessionID, providerID, modelID), system: [], messages: [], options: {}, tools: {} }
}

export function httpRequest(
  sessionID: string,
  providerID: string,
  modelID: string,
  kind: SessionHttpRequest["kind"] = "primary",
): SessionHttpRequest {
  return {
    ...scope(sessionID, providerID, modelID),
    kind,
    request: new Request("https://api.anthropic.example/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "interleaved-thinking-2025-05-14" },
      body: JSON.stringify({ model: modelID, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    }),
  }
}

export function httpResponse(
  sessionID: string,
  providerID: string,
  modelID: string,
  response: Response,
): SessionHttpResponse {
  return {
    ...scope(sessionID, providerID, modelID),
    kind: "primary",
    request: new Request("https://api.example/v1/responses", { method: "POST" }),
    response,
  }
}

export function wsReceive(
  sessionID: string,
  providerID: string,
  modelID: string,
  frame: unknown,
): SessionWebSocketReceive {
  return { ...scope(sessionID, providerID, modelID), kind: "primary", frame: JSON.stringify(frame) }
}

export function retryEvent(
  sessionID: string,
  providerID: string,
  modelID: string,
  error: { readonly type: string; readonly message: string; readonly status?: number },
): SessionRetry {
  return {
    ...scope(sessionID, providerID, modelID),
    // SAFETY: the speed module reads `type`, `message` and `status` of the session error.
    error: error as unknown as SessionRetry["error"],
    attempt: 2,
    decision: { retry: false },
  }
}

/** An SSE body whose `response.completed` names `tier`. */
export function responsesSse(tier: string) {
  return new Response(
    [
      `data: ${JSON.stringify({ type: "response.created", response: { service_tier: "priority" } })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: { service_tier: tier } })}`,
      "",
    ].join("\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

export const CLAUDE_SLOT = Account.ID.claudeSlot
