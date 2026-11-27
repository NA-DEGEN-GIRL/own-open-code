// Auth module test setup: a real runtime (memory vault), the real slots module over a seeded registry, and fake peers
// for the parts other agents own: `logins.headers` is the runtime's `headersFor` (what the credentials module wraps),
// `plugins.trustStatus` is a switch, and telemetry alerts are captured (or fail, `failAlerts`). All credentials are fake.

import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import type { SessionID } from "@opencode/schema/session-id"
import type { Plugin, Registry } from "@own/protocol"
import type { SessionContext, SessionHttpResponse, SessionModelRequest } from "@opencode/plugin/promise/session"
import type { Deps } from "../../src/deps.js"
import { Hooks } from "../../src/hooks.js"
import { Modules } from "../../src/modules.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps } from "../support/deps.js"
import { memoryStorage } from "../slots/support.js"

export async function authSetup(input: { readonly registry: Registry.File }) {
  const logs: string[] = []
  const alerts: Telemetry.AlertInput[] = []
  const trust = { value: "ok" as Plugin.TrustStatus }
  const failAlerts = { value: false }
  const kv = memoryStorage()
  const t = await testDeps({
    logs,
    ctx: { storage: kv.storage, provider: { reload: async () => {}, list: async () => [] } },
  })
  await t.deps.runtime.registry.write(input.registry)
  const modules = t.modules({
    logins: (deps, peers) => ({
      ...Modules.FACTORIES.logins(deps, peers),
      headers: (account, sessionID) => deps.runtime.credentials.headersFor({ account, sessionID }),
    }),
    plugins: (deps, peers) => ({
      ...Modules.FACTORIES.plugins(deps, peers),
      trustStatus: () => trust.value,
      trustSettled: async () => trust.value,
      claudeSlot: () => ({ detected: false, version: null, integrity: null, verified: false }),
    }),
    telemetry: (deps, peers) => ({
      ...Modules.FACTORIES.telemetry(deps, peers),
      alert: (alert) => {
        if (failAlerts.value) throw new Error("alert failed")
        alerts.push(alert)
      },
    }),
  })
  await modules.slots.start()
  await modules.auth.start()
  return {
    t,
    modules,
    auth: modules.auth,
    logs,
    alerts,
    failAlerts,
    trust,
    kv,
    async [Symbol.asyncDispose]() {
      await modules.auth.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

/**
 * The session hooks `Hooks.register` adds, by name; every other registration is a no-op. Takes an {@link authSetup} or
 * any other deps and modules, e.g. a remote service's.
 */
export async function registeredHooks(s: { readonly t: { readonly deps: Deps.Deps }; readonly modules: Modules.All }) {
  const hooks = new Map<string, (event: unknown) => unknown>()
  const registration = { dispose: async () => {} }
  const none = async () => registration
  const ctx = {
    ...s.t.deps.ctx,
    provider: { transform: none },
    model: { transform: none },
    agent: { transform: none },
    skill: { transform: none },
    session: {
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        hooks.set(name, callback)
        return registration
      },
    },
    tool: { hook: none },
    permission: { hook: none },
  }
  // SAFETY: the context parts `Hooks.register` touches; only the session hooks are kept.
  await Hooks.register({ ...s.t.deps, ctx: ctx as unknown as typeof s.t.deps.ctx }, s.modules)
  return hooks
}

export function ref(providerID: string, id: string): Model.Ref {
  // SAFETY: branded ids built from test literals.
  return { providerID, id } as unknown as Model.Ref
}

export function modelRequest(sessionID: string, model: Model.Ref, headers: Record<string, string> = {}) {
  const event: SessionModelRequest = {
    sessionID: sessionID as SessionID,
    agent: "build" as Agent.ID,
    model,
    kind: "primary",
    baseURL: "https://example.invalid/v1",
    headers: { "x-session-affinity": sessionID, ...headers },
  }
  return event
}

export function context(
  sessionID: string,
  model: Model.Ref,
  input: { readonly system?: SessionContext["system"]; readonly messages?: SessionContext["messages"] } = {},
): SessionContext {
  return {
    sessionID: sessionID as SessionID,
    agent: "build" as Agent.ID,
    model,
    system: [...(input.system ?? [])],
    messages: [...(input.messages ?? [])],
    options: {},
    tools: {},
  }
}

export function httpResponse(
  sessionID: string,
  model: Model.Ref,
  input: { readonly requestHeaders?: Record<string, string>; readonly status?: number; readonly body?: string },
): SessionHttpResponse {
  return {
    sessionID: sessionID as SessionID,
    agent: "build" as Agent.ID,
    model,
    kind: "primary",
    request: new Request("https://example.invalid/v1/responses", { method: "POST", headers: input.requestHeaders }),
    response: new Response(input.body ?? "{}", { status: input.status ?? 200 }),
  }
}

type Message = SessionContext["messages"][number]

export function message(value: {
  readonly id?: string
  readonly role: Message["role"]
  readonly content: ReadonlyArray<Record<string, unknown>>
  readonly providerMetadata?: Record<string, unknown>
}): Message {
  // SAFETY: plain objects shaped like `Message`; core re-makes hook messages with `Message.make`.
  return value as unknown as Message
}
