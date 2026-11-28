// Test support for the telemetry module: fake peers (slots, plugins, logins), a Map-backed KV with `scan`, a
// recording emitter registration, RPC call helper and OpenCode event builders. Every credential here is fake.

import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { SessionHttpResponse, SessionRetry, SessionWebSocketReceive } from "@opencode/plugin/promise/session"
import { Schema } from "effect"
import type { Credentials } from "@own/runtime"
import { Account, Kind, type Ledger, Registry } from "@own/protocol"
import type { Emitter } from "../../src/emitter.js"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import type { Slots } from "../../src/slots/slots.js"
import { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps, type TestDepsInput } from "../support/deps.js"

export const CODEX = "own-codex-tst1"
export const CODEX_ACCOUNT = "acc_01TESTCODEX00000000000000"
export const ANTH = "own-anth-tst2"
export const ANTH_ACCOUNT = "acc_01TESTANTH000000000000000"
export const ANTH2 = "own-anth-tst3"
export const ANTH2_ACCOUNT = "acc_01TESTANTH200000000000000"
export const DS = "own-ds-tst4"
export const DS_ACCOUNT = "acc_01TESTDS00000000000000000"
export const SIWC = "own-siwc-tst5"
export const SIWC_ACCOUNT = "acc_01TESTSIWC000000000000000"
export const SESSION = "ses_telemetry_test_1"
export const OTHER_SESSION = "ses_telemetry_test_2"

const decodeAccount = Schema.decodeUnknownSync(Account.Info)
const decodeRegistry = Schema.decodeUnknownSync(Registry.File)

export interface AccountSeed {
  readonly id: string
  readonly kind: Kind.Own
  readonly providerID: string
  readonly quotaDomain?: string
  readonly billing?: Account.Billing
  readonly budget?: number
  readonly pollBalance?: boolean
  readonly credential?: unknown
  readonly workspaceId?: string
  /** A `codex` login's ChatGPT account (`chatgpt-account-id` of its requests). */
  readonly chatgptAccountId?: string
  /** Default `ready`. */
  readonly status?: Account.Status
}

export function account(seed: AccountSeed): Account.Info {
  return decodeAccount({
    id: seed.id,
    kind: seed.kind,
    label: `${seed.kind} test`,
    shortLabel: seed.kind,
    color: "teal",
    providerID: seed.providerID,
    cacheDomain: `cd_${seed.id.slice(4).toLowerCase()}`,
    quotaDomain: seed.quotaDomain ?? `qd_${seed.id.slice(4).toLowerCase()}`,
    billing: seed.billing ?? Kind.meta[seed.kind].billing,
    identity: {
      ...(seed.workspaceId ? { workspaceId: seed.workspaceId } : {}),
      ...(seed.chatgptAccountId ? { chatgptAccountId: seed.chatgptAccountId } : {}),
    },
    autoSwitch: false,
    status: seed.status ?? "ready",
    ...(seed.budget === undefined ? {} : { budget: { monthlyUSD: seed.budget } }),
    ...(seed.pollBalance === undefined ? {} : { pollBalance: seed.pollBalance }),
    ...(seed.credential === undefined ? {} : { credential: seed.credential }),
  })
}

export const DEFAULT_SEEDS: ReadonlyArray<AccountSeed> = [
  { id: CODEX_ACCOUNT, kind: "codex", providerID: CODEX },
  { id: ANTH_ACCOUNT, kind: "anth", providerID: ANTH, quotaDomain: "qd_org_shared", budget: 10 },
  { id: ANTH2_ACCOUNT, kind: "anth", providerID: ANTH2, quotaDomain: "qd_org_shared" },
  // No pollBalance: a clock advance past Poller.TICK_MS must not fetch the real DeepSeek endpoint with a fake key.
  { id: DS_ACCOUNT, kind: "ds", providerID: DS },
]

export function registry(seeds: ReadonlyArray<AccountSeed> = DEFAULT_SEEDS): Registry.File {
  const accounts = seeds.map(account)
  return decodeRegistry({
    schemaVersion: 1,
    revision: 1,
    cacheDomains: Object.fromEntries(
      accounts.map((item) => [item.cacheDomain, { kind: item.kind, scope: "api_key", poolingVerified: false }]),
    ),
    quotaDomains: Object.fromEntries(accounts.map((item) => [item.quotaDomain, { kind: item.kind, scope: "api_key" }])),
    accounts,
    slots: Object.fromEntries(
      accounts.map((item) => [
        item.providerID,
        {
          kind: item.kind,
          accounts: [item.id],
          pooling: "off",
          modelTemplate: `tpl_${item.kind}`,
          ...(item.kind === "codex" ? { transport: "websocket" } : {}),
        },
      ]),
    ),
    modelTemplates: {},
  })
}

/** A slots peer backed by a fixed registry. */
export function fakeSlots(file: Registry.File) {
  return (deps: Parameters<Modules.Factories["slots"]>[0], peers: Module.Peers): Slots.Api => {
    const real = Modules.FACTORIES.slots(deps, peers)
    const slot = (providerID: string): Slots.SlotInfo | undefined => {
      const info = file.slots[providerID as keyof typeof file.slots]
      const owner = file.accounts.find((item) => item.providerID === providerID)
      if (!info || !owner) return undefined
      return {
        providerID: owner.providerID,
        kind: owner.kind,
        account: owner,
        slot: info,
        canonical: Kind.meta[owner.kind].canonical,
        retired: false,
      }
    }
    return {
      ...real,
      start: async () => {},
      slot,
      account: (accountID) => file.accounts.find((item) => item.id === accountID),
      snapshot: () => file,
      // No fold runs here, so a slot model keeps its pinned price.
      model: (providerID, modelID) => {
        const info = slot(providerID)
        return info && file.modelTemplates[info.slot.modelTemplate]?.models.find((model) => model.id === modelID)
      },
    }
  }
}

export interface LoginCalls {
  readonly unauthorized: string[]
  readonly headers: string[]
  /** `<accountID>:<reason>` of every `logins.rejected`. */
  readonly rejected: string[]
  /** Every `logins.accepted` (RS): a success of an account its registry shows `auth_failed`. */
  readonly accepted: string[]
  /** Every `logins.refused` (RS): a second refusal of an account's credential. */
  readonly refused: string[]
}

export function fakeLogins(
  calls: LoginCalls,
  auth: Readonly<Record<string, string>> = { authorization: "Bearer fake-key" },
) {
  return (deps: Parameters<Modules.Factories["logins"]>[0], peers: Module.Peers) => ({
    ...Modules.FACTORIES.logins(deps, peers),
    headers: async (item: Account.Info): Promise<Credentials.Auth> => {
      calls.headers.push(item.id)
      return { ok: true, headers: auth, hash: "fakehash", expiresAt: null, source: "vault" }
    },
    unauthorized: (item: Account.Info) => {
      calls.unauthorized.push(item.id)
    },
    rejected: async (item: Account.Info, reason: string) => {
      calls.rejected.push(`${item.id}:${reason}`)
    },
    accepted: async (item: Account.Info) => {
      calls.accepted.push(item.id)
    },
    refused: async (item: Account.Info) => {
      calls.refused.push(item.id)
    },
  })
}

export function fakePlugins(detected: boolean) {
  return (deps: Parameters<Modules.Factories["plugins"]>[0], peers: Module.Peers) => ({
    ...Modules.FACTORIES.plugins(deps, peers),
    claudeSlot: () => ({ detected, version: null, integrity: null, verified: detected }),
  })
}

/** Map-backed `ctx.storage` with prefix scans, like the host KV. */
export function memoryStorage() {
  const map = new Map<string, Schema.Json>()
  return {
    map,
    get: async (key: string) => map.get(key),
    set: async (key: string, value: Schema.Json) => {
      map.set(key, value)
    },
    remove: async (key: string) => {
      map.delete(key)
    },
    scan: async (options: { readonly prefix: string; readonly after?: string; readonly limit?: number }) => {
      const keys = [...map.keys()]
        .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
        .sort()
      const page = keys.slice(0, options.limit ?? 100)
      return {
        entries: page.map((key) => ({ key, value: map.get(key) ?? null })),
        ...(keys.length > page.length ? { next: page.at(-1) } : {}),
      }
    },
  }
}

export interface Emitted {
  readonly name: string
  readonly data: Readonly<Record<string, unknown>>
}

export function recordEvents(emitter: Emitter.Publisher) {
  const events: Emitted[] = []
  const registration = {
    events: {
      emit: async (name: string, data: Readonly<Record<string, unknown>>) => {
        events.push({ name, data })
      },
    },
  }
  // SAFETY: tests only need `events.emit`; the rest of the registration is never touched.
  emitter.bind(registration as unknown as RpcRegistration<RpcTypes.Definition>)
  return events
}

export interface Setup extends TestDepsInput {
  readonly registry?: Registry.File
  readonly claudeSlot?: boolean
  /** Other fake peers, e.g. the speed module's (02 §4.8). */
  readonly peers?: Partial<Modules.Factories>
}

/** Telemetry with real runtime (memory vault, manual clock) and fake peers. Dispose with `await using`. */
export async function setup(input: Setup = {}) {
  const storage = memoryStorage()
  const test = await testDeps({ ...input, ctx: { storage, ...input.ctx } })
  const calls: LoginCalls = { unauthorized: [], headers: [], rejected: [], accepted: [], refused: [] }
  const modules = test.modules({
    slots: fakeSlots(input.registry ?? registry()),
    logins: fakeLogins(calls),
    plugins: fakePlugins(input.claudeSlot ?? false),
    ...input.peers,
  })
  const events = recordEvents(test.deps.emitter)
  await modules.slots.start()
  const telemetry = modules.telemetry
  await telemetry.start()
  return {
    ...test,
    storage,
    calls,
    events,
    modules,
    telemetry,
    emitted: (name: string) => events.filter((event) => event.name === name),
    async [Symbol.asyncDispose]() {
      await telemetry.stop()
      await test[Symbol.asyncDispose]()
    },
  }
}

type Failure = { readonly ok: false; readonly type: string; readonly message: string; readonly data: unknown }
/** A handler result without its declared-error branch (no success output has both `type` and `message`). */
type Success<R> = Exclude<R, { readonly type: string; readonly message: string }>

/**
 * Calls a handler-shaped function with a recording context; `error` results come back as `{ ok: false }`. Inputs
 * are plain test values (ids unbranded), so they are not type-checked against the method schema here.
 */
export async function call<I, R>(
  handler: (input: I, context: never) => Promise<R>,
  input: unknown,
): Promise<{ readonly ok: true; readonly output: Success<R> } | Failure> {
  const failure = Symbol("failure")
  const context = {
    signal: new AbortController().signal,
    error: (type: string, message: string, data: unknown) => ({ [failure]: true, type, message, data }),
  }
  // SAFETY: the test context builds plain failure records instead of the host's branded handler errors; inputs are
  // plain values of the method's input shape.
  const result: unknown = await handler(input as I, context as never)
  if (typeof result === "object" && result !== null && failure in result) {
    const error = result as unknown as { readonly type: string; readonly message: string; readonly data: unknown }
    return { ok: false, type: error.type, message: error.message, data: error.data }
  }
  return { ok: true, output: result as Success<R> }
}

export async function ok<I, R>(handler: (input: I, context: never) => Promise<R>, input: unknown) {
  const result = await call(handler, input)
  if (!result.ok) throw new Error(`expected success, got ${result.type}: ${result.message}`)
  return result.output
}

// ---------------------------------------------------------------------------------------------------------------
// OpenCode events (encoded, as `ctx.event.subscribe` delivers them)

let sequence = 0

export interface EventInput {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
  readonly at: number
  readonly directory: string
  readonly id?: string
}

export function event(input: EventInput): Module.OpenCodeEvent {
  const id = input.id ?? `evt_test_${String(++sequence).padStart(8, "0")}`
  // SAFETY: test events carry the fields the module reads; the full server envelope is not needed.
  return {
    id,
    type: input.type,
    created: input.at,
    durable: { aggregateID: String(input.data.sessionID), seq: sequence, version: 1 },
    location: { directory: input.directory },
    data: input.data,
  } as unknown as Module.OpenCodeEvent
}

export interface Usage {
  readonly input: number
  readonly output?: number
  readonly reasoning?: number
  readonly read?: number
  readonly write?: number
}

export function tokens(usage: Usage) {
  return {
    input: usage.input,
    output: usage.output ?? 100,
    reasoning: usage.reasoning ?? 0,
    cache: { read: usage.read ?? 0, write: usage.write ?? 0 },
  }
}

/** `session.step.started` + `session.step.ended` for one step. */
export function step(input: {
  readonly sessionID?: string
  readonly providerID: string
  readonly modelID?: string
  readonly variant?: string
  readonly messageID: string
  readonly at: number
  readonly directory: string
  readonly usage: Usage
  readonly cost?: number
  readonly endedID?: string
}) {
  const sessionID = input.sessionID ?? SESSION
  const model = {
    providerID: input.providerID,
    id: input.modelID ?? "gpt-5.5",
    ...(input.variant ? { variant: input.variant } : {}),
  }
  return [
    event({
      type: "session.step.started",
      at: input.at,
      directory: input.directory,
      data: { sessionID, assistantMessageID: input.messageID, agent: "build", model, started: input.at },
    }),
    event({
      type: "session.step.ended",
      at: input.at + 1_000,
      directory: input.directory,
      ...(input.endedID ? { id: input.endedID } : {}),
      data: {
        sessionID,
        assistantMessageID: input.messageID,
        finish: "stop",
        cost: input.cost ?? 0,
        tokens: tokens(input.usage),
      },
    }),
  ]
}

export function modelSelected(input: {
  readonly sessionID?: string
  readonly providerID: string
  readonly previous?: string
  readonly at: number
  readonly directory: string
}) {
  return event({
    type: "session.model.selected",
    at: input.at,
    directory: input.directory,
    data: {
      sessionID: input.sessionID ?? SESSION,
      model: { providerID: input.providerID, id: "gpt-5.5" },
      ...(input.previous ? { previous: { providerID: input.previous, id: "gpt-5.5" } } : {}),
    },
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Hook events

const decodeSession = Schema.decodeUnknownSync(Schema.String)

export function httpEvent(input: {
  readonly providerID: string
  readonly response: Response
  readonly kind?: "primary" | "compaction" | "title" | "generate"
  readonly sessionID?: string
  readonly modelID?: string
}): SessionHttpResponse {
  // SAFETY: hook events are built from plain values; the ids are branded strings at runtime.
  return {
    sessionID: decodeSession(input.sessionID ?? SESSION),
    agent: "build",
    model: { providerID: input.providerID, id: input.modelID ?? "gpt-5.5" },
    kind: input.kind ?? "primary",
    request: new Request("http://fake.local/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer fake-access-token" },
    }),
    response: input.response,
  } as unknown as SessionHttpResponse
}

export function wsEvent(input: { readonly providerID: string; readonly frame: string; readonly sessionID?: string }) {
  // SAFETY: as in `httpEvent`.
  return {
    sessionID: input.sessionID ?? SESSION,
    agent: "build",
    model: { providerID: input.providerID, id: "gpt-5.5" },
    kind: "primary",
    frame: input.frame,
  } as unknown as SessionWebSocketReceive
}

export function retryEvent(input: {
  readonly providerID: string
  readonly status?: number
  readonly type?: string
  readonly message?: string
  readonly sessionID?: string
  /** The provider's response body that upstream keeps on the session error (`response.body`, c14a1f5acf). */
  readonly body?: string
}): SessionRetry {
  // SAFETY: as in `httpEvent`.
  return {
    sessionID: input.sessionID ?? SESSION,
    agent: "build",
    model: { providerID: input.providerID, id: "gpt-5.5" },
    error: {
      type: input.type ?? "provider.rate-limit",
      message: input.message ?? "rate limited",
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.body === undefined ? {} : { response: { body: input.body } }),
    },
    attempt: 2,
    decision: { retry: true, delay: 2_000 },
  } as unknown as SessionRetry
}

export type Line = Ledger.Line
export { Telemetry }
