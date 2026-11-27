// Test support for the credentials module: fake peers (slots with a real registry file, telemetry that records
// alerts, plugins with a fixed Claude slot state) and an event recorder bound to the emitter. Only fake credentials.

import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { Kind, OwnID, type Account, type Registry } from "@own/protocol"
import { Store } from "@own/runtime"
import { ClaudeAccounts } from "../../src/claude/accounts.js"
import { Logins } from "../../src/credentials/logins.js"
import type { Deps } from "../../src/deps.js"
import type { Module } from "../../src/module.js"
import type { Modules } from "../../src/modules.js"
import { Plugins } from "../../src/plugins/plugins.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { Slots } from "../../src/slots/slots.js"
import { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps, type TestDepsInput } from "../support/deps.js"

export interface Recorded {
  readonly name: string
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * Slots with just enough behavior for credentials tests: accounts and slots are written to the real
 * `accounts.json` through the runtime store, `store.changed` is broadcast like the real module does.
 */
export function fakeSlots(options: { readonly failCreate?: string } = {}) {
  return (deps: Deps, peers: Module.Peers): Slots.Api => {
    const state = { registry: Store.emptyRegistry() }
    const mutate = async (change: (current: Registry.File) => Registry.File | undefined) => {
      const next = await deps.runtime.registry.update(change)
      const changed = next !== state.registry
      state.registry = next
      if (changed)
        deps.runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local", revision: next.revision })
      return next
    }
    const real = Slots.create(deps, peers)
    return {
      ...real,
      start: async () => {
        state.registry = await deps.runtime.registry.read()
      },
      stop: async () => {},
      slot: (providerID) => {
        const account = Store.accountFor(state.registry, providerID)
        const slot = state.registry.slots[providerID]
        const parsed = Kind.ProviderID.parse(providerID)
        if (!account || !slot || !parsed) return undefined
        return {
          providerID: account.providerID,
          kind: parsed.kind,
          account,
          slot,
          canonical: Kind.meta[parsed.kind].canonical,
          retired: slot.retired ?? false,
        }
      },
      account: (accountID) => state.registry.accounts.find((account) => account.id === accountID),
      snapshot: () => state.registry,
      mutate,
      createAccount: async (input) => {
        if (options.failCreate) return { ok: false, error: "template_unavailable", reason: options.failCreate }
        const providerID = Kind.ProviderID.create(input.kind)
        const slug = Kind.ProviderID.parse(providerID)?.slug ?? "x"
        const cacheDomain = OwnID.CacheDomainID.make(`cd_${slug}`)
        const quotaDomain = OwnID.QuotaDomainID.make(`qd_${slug}`)
        const template = OwnID.TemplateID.make(`tpl_${input.kind}_test`)
        const now = new Date(deps.clock.now()).toISOString()
        const account: Account.Info = {
          id: input.id,
          kind: input.kind,
          label: input.label,
          shortLabel: input.label.slice(0, 1),
          color: input.color ?? "indigo",
          providerID,
          cacheDomain,
          quotaDomain,
          billing: Kind.meta[input.kind].billing,
          identity: input.identity,
          autoSwitch: false,
          status: input.status ?? "ready",
          createdAt: now,
          credential: input.credential,
          ...(input.method === undefined ? {} : { method: input.method }),
        }
        await mutate((registry) => ({
          ...registry,
          cacheDomains: {
            ...registry.cacheDomains,
            [cacheDomain]: { kind: input.kind, ...input.cacheDomain, poolingVerified: false },
          },
          quotaDomains: { ...registry.quotaDomains, [quotaDomain]: { kind: input.kind, ...input.quotaDomain } },
          accounts: [...registry.accounts, account],
          slots: {
            ...registry.slots,
            [providerID]: {
              kind: input.kind,
              accounts: [input.id],
              pooling: "off",
              modelTemplate: template,
              ...(input.baseURL ? { baseURL: input.baseURL } : {}),
            },
          },
          modelTemplates: {
            ...registry.modelTemplates,
            [template]: { kind: input.kind, source: "bundled", capturedAt: now, models: [] },
          },
        }))
        return { ok: true, account }
      },
    }
  }
}

export function fakeTelemetry(alerts: Telemetry.AlertInput[]) {
  return (deps: Deps, peers: Module.Peers): Telemetry.Api => ({
    ...Telemetry.create(deps, peers),
    alert: (input) => {
      alerts.push(input)
    },
  })
}

export function fakePlugins(slot: Partial<Plugins.ClaudeSlot>) {
  return (deps: Deps, peers: Module.Peers): Plugins.Api => ({
    ...Plugins.create(deps, peers),
    claudeSlot: () => ({ detected: false, version: null, integrity: null, verified: false, ...slot }),
    trustStatus: () => "ok",
    trustSettled: async () => "ok",
  })
}

/** Binds the emitter to a recorder, so global and session events are captured instead of dropped. */
export function recordEvents(deps: Deps) {
  const events: Recorded[] = []
  const registration = {
    dispose: async () => {},
    events: {
      emit: async (...args: ReadonlyArray<unknown>) => {
        events.push({ name: String(args[0]), payload: args[1] as Readonly<Record<string, unknown>> })
      },
    },
  }
  // SAFETY: the recorder implements the only member the emitter calls (`events.emit`).
  deps.emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
  return events
}

export interface Harness extends AsyncDisposable {
  readonly deps: Deps
  readonly clock: Awaited<ReturnType<typeof testDeps>>["clock"]
  readonly home: string
  readonly modules: Modules.All
  readonly logins: Logins.Api
  readonly events: Recorded[]
  readonly alerts: Telemetry.AlertInput[]
  readonly logs: string[]
}

/**
 * A started credentials module with fake peers. Only slots and logins are started: the other real modules belong to
 * other agents and are not part of these tests.
 */
export async function harness(
  input: TestDepsInput & {
    readonly slots?: { readonly failCreate?: string }
    readonly claudeSlot?: Partial<Plugins.ClaudeSlot>
    readonly internal?: Logins.Internal
    /** Several Claude accounts (02 §8.7): the patched plugin is loaded and account 1 has this key. */
    readonly claudeKey?: string
  } = {},
): Promise<Harness> {
  const logs: string[] = []
  const alerts: Telemetry.AlertInput[] = []
  const test = await testDeps({ ...input, logs })
  const modules = test.modules({
    slots: fakeSlots(input.slots),
    telemetry: fakeTelemetry(alerts),
    plugins: fakePlugins(input.claudeSlot ?? {}),
    logins: (deps, peers) => Logins.create(deps, peers, { callbackPorts: [0], ...input.internal }),
    ...(input.claudeKey === undefined
      ? {}
      : {
          claude: (deps: Deps, peers: Module.Peers) => ({
            ...ClaudeAccounts.create(deps, peers),
            multi: () => true,
            entry: () => ({ key: input.claudeKey }) as unknown as ClaudeAccounts.Entry,
          }),
        }),
  })
  const events = recordEvents(test.deps)
  await modules.slots.start()
  await modules.logins.start()
  return {
    deps: test.deps,
    clock: test.clock,
    home: test.home,
    modules,
    logins: modules.logins,
    events,
    alerts,
    logs,
    async [Symbol.asyncDispose]() {
      await modules.logins.stop()
      await modules.slots.stop()
      await test[Symbol.asyncDispose]()
    },
  }
}

type AnyHandler = (input: never, context: never) => Promise<unknown>
type HandlerFailure = { readonly type: string; readonly message: string }

/** Calls a handler-shaped function with a recording context; `context.error(...)` results come back as `ok: false`. */
export async function call<H extends AnyHandler>(
  handler: H,
  input: Parameters<H>[0],
): Promise<
  | { readonly ok: true; readonly output: Exclude<Awaited<ReturnType<H>>, HandlerFailure> }
  | { readonly ok: false; readonly type: string; readonly message: string; readonly data: unknown }
> {
  const failure = Symbol("failure")
  const context = {
    signal: new AbortController().signal,
    error: (type: string, message: string, data: unknown) => ({ [failure]: true, type, message, data }),
  }
  // SAFETY: the test context builds plain failure records instead of the host's branded handler errors.
  const result: unknown = await handler(input as never, context as never)
  if (typeof result === "object" && result !== null && failure in result) {
    const error = result as unknown as { readonly type: string; readonly message: string; readonly data: unknown }
    return { ok: false, type: error.type, message: error.message, data: error.data }
  }
  return { ok: true, output: result as Exclude<Awaited<ReturnType<H>>, HandlerFailure> }
}

/** Polls until `probe` returns a value (real time; I/O finishes on its own). */
export async function until<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  const attempt = async (): Promise<T> => {
    const value = await probe()
    if (value !== undefined) return value
    if (performance.now() > deadline) throw new Error("until: timed out")
    await Bun.sleep(10)
    return attempt()
  }
  return attempt()
}

/**
 * One Codex model request with the headers a slot would inject (what AUTH's `model.request` does with
 * `logins.headers`). Returns the HTTP status.
 */
export async function codexRequest(baseURL: string, headers: Readonly<Record<string, string>>) {
  const response = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: [{ role: "user", content: "hi" }], stream: true }),
  })
  await response.text()
  return response.status
}

/** A clock the fakes read, pointed at each test's manual clock so token expiry agrees on both sides. */
export function sharedClock() {
  const state = { now: () => Date.now() }
  return {
    clock: { now: () => state.now() },
    follow: (clock: { readonly now: () => number }) => {
      state.now = clock.now
    },
  }
}

/** Global `account.status` payloads recorded so far. */
export function statuses(events: ReadonlyArray<Recorded>) {
  return events.filter((event) => event.name === "account.status").map((event) => event.payload)
}
