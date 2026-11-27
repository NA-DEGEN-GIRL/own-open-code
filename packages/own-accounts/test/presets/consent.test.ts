// What the user allows a root beyond its preset (07 §2.6 이번 메시지만 늘리기, §5.4 돈 4): the per-message raise of the
// current user message in KV `presetUsage` (the message and counts the gate uses: the session context's last user
// message and `runtime.reservations`), and per-conversation paid-use consent in KV `presetConsent`, refused for an
// account whose monthly budget is used up. Real slots, telemetry (budget windows from the ledger) and presets over the
// 2026-10-01 fixture registry; every account is fake.

import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Account, Kv, Ledger, OwnAccounts, Preset } from "@own/protocol"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import { failure, memoryStorage, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { CODEX_A, DEEPSEEK_KEY, DS, OPENAI_KEY, registry } from "./fixtures/catalog-2026-10-01.js"
import { messagesOver } from "../support/session-messages.js"

const WORKSPACE = process.platform === "win32" ? "C:\\work\\consent" : "/work/consent"
const decodeUsage = Schema.decodeUnknownSync(Preset.Usage)
const decodeConsent = Schema.decodeUnknownSync(Preset.Consent)

const stops: Array<() => unknown> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

/** Real slots, telemetry and presets; DeepSeek has a $1 budget with $2 spent this month, the OpenAI key $50 unspent. */
async function rig() {
  const kv = memoryStorage()
  /** The root's context as core returns it (`ctx.session.context`): the gate's current user message is the last one. */
  const context: Array<{ readonly id: string; readonly type: "user" | "synthetic" | "assistant" }> = []
  const t = await testDeps({
    directory: WORKSPACE,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }) },
      storage: kv.storage,
      session: {
        get: async (request: { readonly sessionID: string }) => ({
          id: request.sessionID,
          model: { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" },
          location: { directory: WORKSPACE },
        }),
        context: async () => context,
        messages: messagesOver(() => context),
      },
    },
  })
  stops.push(() => t[Symbol.asyncDispose]())
  const deps = t.deps
  const base = await registry()
  const budgets: Readonly<Record<string, number>> = { [DEEPSEEK_KEY]: 1, [OPENAI_KEY]: 50 }
  await deps.runtime.registry.write({
    ...base,
    accounts: base.accounts.map((account) =>
      account.id in budgets ? { ...account, budget: { monthlyUSD: budgets[account.id] ?? 0 } } : account,
    ),
  })
  await deps.runtime.ledger.usage(
    "eid_spent",
    Schema.decodeUnknownSync(Ledger.Line)({
      v: 1,
      ts: deps.clock.now(),
      sessionID: "ses_elsewhere",
      messageID: null,
      kind: "primary",
      accountID: DEEPSEEK_KEY,
      providerID: DS,
      modelID: "deepseek-flash",
      variant: null,
      credentialRef: null,
      transport: null,
      switchEpoch: 0,
      compactionEpoch: 0,
      tokens: null,
      P: null,
      hit: null,
      cost: { amount: 2, unit: "USD", source: "ratecard" },
      costUSDOpenCode: null,
      coldExpected: null,
    }),
  )
  const modules = Modules.create(deps)
  await modules.slots.start()
  await modules.presets.start()
  stops.push(async () => {
    await modules.presets.stop()
    await modules.slots.stop()
  })
  const send = (type: string, data: Record<string, unknown>, local = true) => {
    // SAFETY: tests build the event envelope by hand; `type` and `data` follow the OpenCode event schema.
    const event = { id: "evt_x", type, location: { directory: WORKSPACE }, data } as unknown as Module.OpenCodeEvent
    return modules.presets.onEvent?.(event, { local })
  }
  const call = <N extends "session.preset.raiseOnce" | "session.preset.consent" | "session.preset.get">(
    name: N,
    value: unknown,
  ) => {
    // SAFETY: the method's input schema decodes to the handler's input type.
    const schema = OwnAccounts.Definition.methods[name].input as unknown as Schema.Codec<RpcTypes.Input<N>, unknown>
    const handler = {
      "session.preset.raiseOnce": modules.presets.raiseOnce,
      "session.preset.consent": modules.presets.consent,
      "session.preset.get": modules.presets.sessionGet,
    }[name] as unknown as (input: RpcTypes.Input<N>, context: RpcTypes.Context<N>) => Promise<unknown>
    return handler(Schema.decodeUnknownSync(schema)(value), rpcContext<N>())
  }
  return { deps, kv, modules, context, send, call }
}

/** core's failure text for a subagent call the gate declined. */
const declined = (rejection: Preset.Rejection) => ({
  type: "unknown",
  message: `Unknown agent: ${Preset.rejection(rejection)}`,
})

describe("session.preset.raiseOnce (07 §2.6)", () => {
  test("raises the current user message to what it asked for, and only that message", async () => {
    const r = await rig()
    expect(failure(await r.call("session.preset.raiseOnce", { sessionID: "ses_root" }))).toMatchObject({
      type: "internal_error",
    })
    await r.kv.storage.set(Kv.presetUsage("ses_root"), { perSession: 9 })
    r.context.push({ id: "msg_first", type: "user" }, { id: "msg_answer", type: "assistant" })
    // The gate let six subagents through for this message, then declined two over its per-message cap; one call over
    // the concurrent cap and an unrelated failure do not count.
    const wide = { concurrent: 64, perMessage: 64, perSession: 500 }
    for (const index of [1, 2, 3, 4, 5, 6])
      r.deps.runtime.reservations.take({ root: "ses_root", parent: "ses_root", message: "msg_first" }, wide)
    for (const error of [
      declined({ reason: "caps", cap: "perMessage", max: 6 }),
      declined({ reason: "caps", cap: "perMessage", max: 6 }),
      declined({ reason: "caps", cap: "concurrent", max: 3 }),
      { type: "unknown", message: "Unknown agent: nobody" },
    ])
      await r.send("session.tool.failed", {
        sessionID: "ses_root",
        callID: "c",
        tool: "subagent",
        error,
        executed: false,
      })
    expect(await r.call("session.preset.get", { sessionID: "ses_root" })).toMatchObject({
      caps: Preset.CAPS,
      counts: { running: 6, message: 6, session: 9 },
    })

    expect(await r.call("session.preset.raiseOnce", { sessionID: "ses_root" })).toEqual({ perMessage: 8 })
    expect<unknown>(decodeUsage(r.kv.values.get(Kv.presetUsage("ses_root")))).toEqual({
      perSession: 9,
      raise: { messageID: "msg_first", perMessage: 8 },
    })
    expect(await r.call("session.preset.get", { sessionID: "ses_root" })).toMatchObject({
      caps: { ...Preset.CAPS, perMessage: 8 },
    })
    expect(await r.call("session.preset.raiseOnce", { sessionID: "ses_root", perMessage: 20 })).toEqual({
      perMessage: 20,
    })

    // The next user message starts over: the raise was for the last one, and nothing was started for this one.
    r.context.push({ id: "msg_second", type: "user" })
    expect(await r.call("session.preset.get", { sessionID: "ses_root" })).toMatchObject({
      caps: Preset.CAPS,
      counts: { message: 0 },
    })
    expect(await r.call("session.preset.raiseOnce", { sessionID: "ses_root" })).toEqual({ perMessage: 6 })
  })

  test("rejections in another Location's sessions are not counted here", async () => {
    const r = await rig()
    r.context.push({ id: "msg_first", type: "user" })
    r.deps.runtime.reservations.take({ root: "ses_root", parent: "ses_root", message: "msg_first" }, Preset.CAPS)
    const error = declined({ reason: "caps", cap: "perMessage", max: 1 })
    await r.send("session.tool.failed", { sessionID: "ses_root", callID: "c", tool: "subagent", error }, false)
    expect(await r.call("session.preset.raiseOnce", { sessionID: "ses_root" })).toEqual({ perMessage: 6 })
  })
})

describe("session.preset.consent (07 §5.4 step 4)", () => {
  test("stores this conversation's answer per account; a used-up budget cannot be allowed", async () => {
    const r = await rig()
    expect(
      failure(await r.call("session.preset.consent", { sessionID: "ses_root", accountID: "acc_none", allow: true })),
    ).toMatchObject({ type: "account_not_found", data: { accountID: "acc_none" } })
    expect(
      failure(await r.call("session.preset.consent", { sessionID: "ses_root", accountID: DEEPSEEK_KEY, allow: true })),
    ).toMatchObject({ type: "preset_budget_exhausted", data: { accountID: DEEPSEEK_KEY } })
    expect(r.kv.values.has(Kv.presetConsent("ses_root"))).toBe(false)

    expect(
      await r.call("session.preset.consent", { sessionID: "ses_root", accountID: DEEPSEEK_KEY, allow: false }),
    ).toEqual({ accountID: DEEPSEEK_KEY, allow: false })
    expect(
      await r.call("session.preset.consent", { sessionID: "ses_root", accountID: OPENAI_KEY, allow: true }),
    ).toEqual({ accountID: OPENAI_KEY, allow: true })
    const at = r.deps.clock.now()
    expect<unknown>(decodeConsent(r.kv.values.get(Kv.presetConsent("ses_root")))).toEqual({
      accounts: { [DEEPSEEK_KEY]: { allow: false, at }, [OPENAI_KEY]: { allow: true, at } },
    })
    // Another conversation knows nothing of it; the Claude slot is an account too.
    expect(r.kv.values.has(Kv.presetConsent("ses_other"))).toBe(false)
    expect(
      await r.call("session.preset.consent", { sessionID: "ses_other", accountID: Account.ID.claudeSlot, allow: true }),
    ).toEqual({ accountID: Account.ID.claudeSlot, allow: true })
  })
})
