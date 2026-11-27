// Module-level harness of the switching state machine: a real runtime (memory vault, temp OWN_HOME) from
// `test/support/deps.ts`, a fake session core (model per session, `wait`, `switchModel` that publishes
// `session.model.selected` asynchronously like the event stream, `prompt`), an in-memory KV, fake slots and
// telemetry peers, and the RPC handlers of `src/rpc/switch.ts`. Every credential is fake.

import { Schema } from "effect"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { SessionPrompt, SessionRetry } from "@opencode/plugin/promise/session"
import { Account, Compaction, Kind, OwnAccounts, type Registry } from "@own/protocol"
import type { Auth } from "../../src/auth/auth.js"
import type { ClaudeAccounts } from "../../src/claude/accounts.js"
import type { ClaudeAgent } from "../../src/claude-agent/agent.js"
import { Events } from "../../src/events.js"
import type { Module } from "../../src/module.js"
import type { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { Presets } from "../../src/presets/presets.js"
import { Resets } from "../../src/resets.js"
import { SwitchRpc } from "../../src/rpc/switch.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { CoreConfig } from "../../src/slots/core-config.js"
import { Registration } from "../../src/slots/registration.js"
import type { Slots } from "../../src/slots/slots.js"
import { Templates } from "../../src/slots/templates.js"
import type { SwitchInbox } from "../../src/switching/inbox.js"
import { Switching } from "../../src/switching/switching.js"
import { Variant } from "../../src/switching/variant.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps } from "../support/deps.js"
import { noClaudeAgent, partial, registry as defaultRegistry, seedCards } from "./support.js"

export const WORKSPACE = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo"

const ERROR = Symbol("rpc.error")

export interface RpcFailure {
  readonly [ERROR]: true
  readonly type: string
  readonly message: string
  readonly data: unknown
}

export function failure(value: unknown): RpcFailure | undefined {
  return typeof value === "object" && value !== null && ERROR in value ? (value as RpcFailure) : undefined
}

/** Output types without brands and literal unions, so tests compare them with plain object literals. */
export type Loose<T> = T extends string
  ? string
  : T extends number | boolean | null | undefined
    ? T
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<Loose<U>>
      : T extends object
        ? { readonly [K in keyof T]: Loose<T[K]> }
        : T

export interface Emitted {
  readonly name: string
  readonly payload: Record<string, unknown>
}

export interface MachineInput {
  readonly gates?: Switching.Gates
  readonly registry?: Registry.File
  /** `false`: `switchModel` succeeds but never publishes `model.selected` (SWITCHING timeout tests). */
  readonly confirm?: boolean
  /** Session → directory for `session.get`; default {@link WORKSPACE}. */
  readonly locations?: Readonly<Record<string, string>>
  /** Pre-filled KV (restart tests). */
  readonly kv?: ReadonlyArray<readonly [string, Schema.Json]>
  readonly models?: Readonly<Record<string, Variant.Ref>>
  /** Core's default model (`ctx.model.default`). */
  readonly defaultModel?: Variant.Ref
  /** Core's available models in order (`ctx.model.list`); the default is configured when it is not the first. */
  readonly available?: ReadonlyArray<Variant.Ref>
  /** Extra `Session.Info` facts per session (`session.get`); `permissions` also receive `session.update` writes. */
  readonly sessions?: Readonly<Record<string, SessionFacts>>
  /** `policy.json` as an earlier build wrote it, before the module starts (migration tests). */
  readonly policy?: unknown
  /**
   * How `session.compact` answers: admits the item (default), throws core's 409 conflict (the id was already
   * delivered), or fails.
   */
  readonly compact?: "admit" | "conflict" | "fail"
  /** The Claude slot as the plugins module reports it; default: not installed. */
  readonly claude?: Plugins.ClaudeSlot
  /** The claude module's account lookups; default: one Claude account (the slot's own) that every tree runs on. */
  readonly claudeAccounts?: Partial<ClaudeAccounts.Api>
  /** The Claude Agent module's members; default: no route account (`noClaudeAgent`). */
  readonly claudeAgent?: Partial<ClaudeAgent.Api>
  /**
   * own.team's ops as its `op.get` answers them (`ctx.rpc` own.team, the `teamOp` check); an unknown id is
   * `not_found`. Without it no own.team is loaded.
   */
  /** Receives the module's log lines. */
  readonly logs?: string[]
  /** More telemetry members than the alert sink (idle compaction reads the primary request's cache). */
  readonly telemetry?: Partial<Telemetry.Api>
  readonly teamOps?: ReadonlyArray<{
    readonly id: string
    readonly teamID: string
    readonly kind: string
    readonly state: string
  }>
}

export interface SessionFacts {
  readonly parentID?: string
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly revert?: { readonly messageID: string }
  readonly permissions?: ReadonlyArray<{ readonly action: string; readonly resource: string; readonly effect: string }>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export async function machine(input: MachineInput = {}) {
  const kv = new Map<string, Schema.Json>(input.kv ?? [])
  const models = new Map<string, Variant.Ref>(Object.entries(input.models ?? {}))
  const facts = new Map<string, SessionFacts>(Object.entries(input.sessions ?? {}))
  /**
   * The `/compact` item core delivered and runs now, per session: `session.context` shows it as the running compaction
   * message, as core projects it before the compaction hooks run.
   */
  const delivered = new Map<string, string>()
  /** A session's context as `session.context` answers it when set (a delivered reset's marker comes first, 11 §7). */
  const history = new Map<string, ReadonlyArray<Readonly<Record<string, unknown>>>>()
  /** A session's pending inbox as the service's `session.inbox.list` answers it (empty when unset). */
  const inbox = new Map<string, ReadonlyArray<SwitchInbox.Item>>()
  /** Holds the next inbox read until the test answers it (a read racing an event). */
  const reads: { gate?: Promise<void> } = {}
  const calls = {
    wait: [] as string[],
    switchModel: [] as Array<{ readonly sessionID: string; readonly model: Variant.Ref }>,
    prompt: [] as Array<{ readonly sessionID: string; readonly text: string }>,
    update: [] as Array<{ readonly sessionID: string; readonly permissions?: SessionFacts["permissions"] }>,
    compact: [] as Array<{ readonly sessionID: string; readonly id?: string }>,
  }
  const emitted: Emitted[] = []
  const alerts: Telemetry.AlertInput[] = []
  const counter = { event: 0 }
  const holder: { switching?: Switching.Api; now?: () => number; places?: Events.Places } = {}

  /**
   * Feeds one event to the module with `meta.local` computed like the dispatcher (`Events.Places`). `located: false`
   * drops the location envelope, as core does for events published through the plugin host
   * (`ctx.session.switchModel`); such an event is local only when the session is already placed here.
   */
  // The dispatcher's reset tracker (events.ts), whose lookup reads the session context below.
  const resets = new Resets.Tracker(
    Resets.contextLookup(
      async (sessionID) =>
        // SAFETY (test): the fake context holds the message fields the lookup and the estimate read.
        ctx.session.context({ sessionID }) as never,
    ),
  )
  const send = async (
    type: string,
    data: Record<string, unknown>,
    options: { readonly local?: boolean; readonly located?: boolean } = {},
  ) => {
    const located = options.located ?? true
    // SAFETY: tests build the event envelope by hand; `type` and `data` follow the OpenCode event schema.
    const event = {
      id: `evt_${++counter.event}`,
      created: holder.now?.() ?? Date.now(),
      type,
      durable: { aggregateID: String(data.sessionID ?? ""), seq: counter.event, version: 1 },
      ...(located ? { location: { directory: WORKSPACE } } : {}),
      data,
    } as unknown as Module.OpenCodeEvent
    const local = options.local ?? holder.places?.observe(event, WORKSPACE).local ?? located
    const reset = local ? await resets.observe(event) : undefined
    return holder.switching?.onEvent?.(event, { local, ...(reset === undefined ? {} : { reset }) })
  }

  const ctx = {
    storage: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: Schema.Json) => {
        kv.set(key, value)
      },
      remove: async (key: string) => {
        kv.delete(key)
      },
      scan: async (options: { readonly prefix: string }) => ({
        entries: [...kv.entries()]
          .filter((entry) => entry[0].startsWith(options.prefix))
          .map((entry) => ({ key: entry[0], value: entry[1] })),
      }),
    },
    session: {
      get: async (request: { readonly sessionID: string }) => ({
        id: request.sessionID,
        model: models.get(request.sessionID),
        location: { directory: input.locations?.[request.sessionID] ?? WORKSPACE },
        ...facts.get(request.sessionID),
      }),
      update: async (request: { readonly sessionID: string; readonly permissions?: SessionFacts["permissions"] }) => {
        calls.update.push(request)
        facts.set(request.sessionID, { ...facts.get(request.sessionID), permissions: request.permissions })
      },
      wait: async (request: { readonly sessionID: string }) => {
        calls.wait.push(request.sessionID)
      },
      switchModel: async (request: { readonly sessionID: string; readonly model: Variant.Ref }) => {
        calls.switchModel.push(request)
        const previous = models.get(request.sessionID)
        if (Variant.same(previous, request.model)) return
        models.set(request.sessionID, request.model)
        if (input.confirm === false) return
        setTimeout(() => {
          // Like core: a switch through the plugin host publishes without a location envelope.
          void send(
            "session.model.selected",
            { sessionID: request.sessionID, model: request.model, ...(previous ? { previous } : {}) },
            { located: false },
          )
        }, 0)
      },
      prompt: async (request: { readonly sessionID: string; readonly text: string }) => {
        calls.prompt.push(request)
        return { id: "msg_prompt" }
      },
      compact: async (request: { readonly sessionID: string; readonly id?: string }) => {
        calls.compact.push(request)
        // Shaped like core's tagged errors as the plugin host rejects with them.
        if (input.compact === "conflict")
          throw Object.assign(new Error("conflict"), { _tag: "Session.CompactionConflictError" })
        if (input.compact === "fail") throw new Error("compact failed")
        return { id: request.id ?? "msg_compact", sessionID: request.sessionID, type: "compaction" }
      },
      context: async (request: { readonly sessionID: string }) => {
        const recorded = history.get(request.sessionID)
        if (recorded) return recorded
        const running = delivered.get(request.sessionID)
        return running === undefined ? [] : [{ id: running, type: "compaction", status: "running" }]
      },
    },
    model: {
      list: async () => ({ location: { directory: WORKSPACE }, data: input.available ?? [] }),
      default: async () => ({ location: { directory: WORKSPACE }, data: input.defaultModel ?? null }),
    },
    ...(input.teamOps === undefined ? {} : { rpc: teamRpc(input.teamOps) }),
  }

  const t = await testDeps({ ctx, directory: WORKSPACE, ...(input.logs ? { logs: input.logs } : {}) })
  holder.now = t.clock.now
  holder.places = t.deps.places
  await t.deps.runtime.registry.write(input.registry ?? defaultRegistry())
  await t.deps.runtime.ratecards.write(await seedCards())
  if (input.policy !== undefined) await Bun.write(t.deps.runtime.layout.policy, `${JSON.stringify(input.policy)}\n`)
  const file = await t.deps.runtime.registry.read()

  const slotInfo = (providerID: string): Slots.SlotInfo | undefined => {
    const account = file.accounts.find((item) => item.providerID === providerID && item.status !== "retired")
    const slot = file.slots[providerID]
    const parsed = Kind.ProviderID.parse(providerID)
    if (!account || !slot || !parsed) return undefined
    return {
      providerID: account.providerID,
      kind: parsed.kind,
      account,
      slot,
      canonical: Kind.meta[parsed.kind].canonical,
      retired: slot.retired === true,
    }
  }
  // Slot models and thresholds exactly as the slots module resolves them without a fold (pinned values, Codex windows;
  // registry settings, kind constants, v2 for the rest).
  const model = (providerID: string, modelID: string) => {
    // Any slot, retired ones included, like the slots module.
    const slot = file.slots[providerID]
    const pinned = slot && file.modelTemplates[slot.modelTemplate]?.models.find((item) => item.id === modelID)
    return slot && pinned && Templates.live(slot.kind, pinned, new Map())
  }
  const compaction = (providerID: string, modelID: string, window?: number) => {
    const info = slotInfo(providerID)
    const resolved = model(providerID, modelID)
    if (info && resolved) return Registration.threshold(info.kind, info.account, resolved, {})
    return window === undefined
      ? undefined
      : Compaction.resolve(Compaction.chain({ kind: "claude-sub", modelID }), { context: window })
  }
  const slots = partial<Slots.Api>("slots", {
    snapshot: () => file,
    slot: slotInfo,
    account: (accountID) => file.accounts.find((item) => item.id === accountID),
    model,
    models: (providerID) => {
      const slot = file.slots[providerID]
      const models = slot ? (file.modelTemplates[slot.modelTemplate]?.models ?? []) : []
      return slot ? models.map((item) => Templates.live(slot.kind, item, new Map())) : []
    },
    catalog: async () => [],
    compaction,
    core: () => CoreConfig.DEFAULTS,
    refreshCore: async () => CoreConfig.DEFAULTS,
    windows: () => new Map(),
    impact: () => ({ sessions: [] }),
  })
  const telemetry = partial<Telemetry.Api>("telemetry", {
    alert: (alert) => void alerts.push(alert),
    refreshCacheState: () => {},
    ...input.telemetry,
  })
  const plugins = partial<Plugins.Api>("plugins", {
    claudeSlot: () => input.claude ?? { detected: false, version: null, integrity: null, verified: false },
  })
  const auth = partial<Auth.Api>("auth", { toolsetChangedAt: () => undefined })
  // 02 §8.7: one Claude account (the slot's own) unless a test says otherwise.
  // One Claude account (the slot's own): every tree runs on it.
  const claude = partial<ClaudeAccounts.Api>("claude", {
    accountOf: async () => Account.ID.claudeSlot,
    peek: () => Account.ID.claudeSlot,
    list: () => [],
    // R4's lookup reads a Claude account id as the slot (PF 2026-11-03); none besides the slot's own here.
    entry: () => undefined,
    ...input.claudeAccounts,
  })
  // The real group defaults over the fake slots (07 §2.2); `presets.json` lives in the temp OWN_HOME.
  const presets = Presets.create(t.deps, () => peers)
  const claudeAgent = noClaudeAgent(input.claudeAgent)
  const peers: Modules.All = partial<Modules.All>("modules", {
    slots,
    telemetry,
    plugins,
    presets,
    auth,
    claude,
    claudeAgent,
  })
  const switching = Switching.createWith(t.deps, () => peers, input.gates ?? Switching.GATES, {
    inbox: async (sessionID) => {
      const gate = reads.gate
      reads.gate = undefined
      await gate
      return inbox.get(sessionID) ?? []
    },
  })
  holder.switching = switching
  await presets.start()
  t.deps.emitter.bind(
    partial<RpcRegistration<RpcTypes.Definition>>("registration", {
      events: {
        emit: async (...args) => {
          const [name, payload] = args
          emitted.push({ name, payload: payload as Record<string, unknown> })
        },
      },
    }),
  )
  await switching.start()

  const handlers = SwitchRpc.handlers(partial<Modules.All>("modules", { switching }))
  const context = {
    signal: new AbortController().signal,
    error: (type: string, message: string, data?: unknown) => ({ [ERROR]: true, type, message, data }),
  }

  /** Calls one handler of `src/rpc/switch.ts` with its input decoded by the protocol schema. */
  async function rpc<N extends SwitchRpc.Methods>(
    name: N,
    value: unknown,
  ): Promise<Loose<RpcTypes.Output<N>> | RpcFailure> {
    const schema = OwnAccounts.Definition.methods[name].input as unknown as Schema.Codec<RpcTypes.Input<N>, unknown>
    const decoded = Schema.decodeUnknownSync(schema)(value)
    // SAFETY: the fake context mirrors `RpcCallContext` (`signal`, `error` returning a tagged failure).
    const handler = handlers[name] as unknown as (
      input: RpcTypes.Input<N>,
      context: unknown,
    ) => Promise<Loose<RpcTypes.Output<N>> | RpcFailure>
    return handler(decoded, context)
  }

  /** Lets queued session work and the fake stream's timers run. */
  async function flush(rounds = 20) {
    for (const _ of Array.from({ length: rounds })) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  /** A turn: execution started, one step on `model` with the given tokens, execution ended. */
  async function turn(
    sessionID: string,
    model: Variant.Ref,
    tokens: { readonly input: number; readonly read?: number; readonly write?: number; readonly output?: number },
    end: "succeeded" | "failed" | "interrupted" | "open" = "succeeded",
  ) {
    const messageID = `msg_${++counter.event}`
    await send("session.execution.started", { sessionID })
    await send("session.step.started", {
      sessionID,
      assistantMessageID: messageID,
      agent: "build",
      model,
      started: t.clock.now(),
    })
    await send("session.step.ended", {
      sessionID,
      assistantMessageID: messageID,
      finish: "stop",
      cost: 0,
      tokens: {
        input: tokens.input,
        output: tokens.output ?? 0,
        reasoning: 0,
        cache: { read: tokens.read ?? 0, write: tokens.write ?? 0 },
      },
    })
    if (end !== "open")
      await send(
        `session.execution.${end}`,
        end === "failed"
          ? { sessionID, error: { type: "provider", message: "usage limit" } }
          : end === "interrupted"
            ? { sessionID, reason: "user" }
            : { sessionID },
      )
    await flush()
  }

  const prompt = async (sessionID: string, text = "next", delivery: "steer" | "queue" = "steer") => {
    // SAFETY: a minimal prompt admission as the session `prompt` hook delivers it.
    const event = { sessionID, messageID: "msg_x", prompt: { text }, delivery } as unknown as SessionPrompt
    await switching.onPrompt(event)
    return event.delivery
  }

  const retry = async (sessionID: string, model: Variant.Ref, verdict: Telemetry.Verdict) => {
    // SAFETY: a minimal retry event; switching reads only `sessionID` and `model`.
    const event = {
      sessionID,
      agent: "build",
      model,
      error: {},
      attempt: 1,
      decision: { retry: true, delay: 0 },
    } as unknown as SessionRetry
    await switching.onRetry(event, verdict)
  }

  return {
    ...t,
    kv,
    models,
    facts,
    delivered,
    history,
    inbox,
    reads,
    /** The event stream was subscribed again after events were lost (events.ts). */
    resubscribe: () => switching.onResubscribe?.(),
    calls,
    emitted,
    alerts,
    switching,
    presets,
    registry: file,
    send,
    rpc,
    flush,
    turn,
    prompt,
    retry,
    events: (name: string) => emitted.filter((item) => item.name === name).map((item) => item.payload),
    async [Symbol.asyncDispose]() {
      await switching.stop()
      await presets.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

/** `ctx.rpc` with own.team's `op.get` over fixed ops (other RPCs: absent). */
function teamRpc(ops: NonNullable<MachineInput["teamOps"]>) {
  return (definition: { readonly id: string }) =>
    definition.id === "own.team"
      ? {
          "op.get": async (request: { readonly opID: string }) => {
            const op = ops.find((item) => item.id === request.opID)
            if (!op) throw new Error(`own.team: op ${request.opID} not found`)
            return { op: { ...op, by: "user", createdAt: 0, steps: [] } }
          },
        }
      : {}
}
