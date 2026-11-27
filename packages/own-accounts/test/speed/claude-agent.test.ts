// The Claude Agent route's speed (decisions CAM-6): Claude Code says which model takes its Fast mode (core P-060's
// model list on the observer channel), Fast needs the same usage-credit consent as the Claude slot, a Fast request asks
// for it with the provider option `fastMode`, and Claude Code's answer in the turn's result marks what was served or why
// it ran Standard (usage credits off: unavailable; its Fast rate limit: a cooldown).
import { describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { Account, Kv, type Registry } from "@own/protocol"
import { failure, rpcContext } from "../slots/support.js"
import { contextEvent, speedSetup } from "./support.js"

const ROOT = "ses_agent_root"
const sid = (id: string) => SessionID.make(id)
const ACCOUNT = {
  accountID: Account.ID.make("acc_agent"),
  configDir: "C:\\fake\\own\\claude-agent\\accounts\\acc_agent",
  label: null,
  shortLabel: "CA",
  color: "orange",
  addedAt: "2026-11-22T00:00:00Z",
} as unknown as Registry.ClaudeAgentAccount
const MODELS = [
  {
    id: "opus",
    name: "Opus · Opus 5.5",
    resolvedModel: "claude-opus-5-5",
    contextWindow: 1_000_000,
    supportsFastMode: true,
  },
  { id: "sonnet", name: "Sonnet · Sonnet 5.5", resolvedModel: "claude-sonnet-5-5", contextWindow: 1_000_000 },
]

const setup = (models = MODELS) => speedSetup({ claudeAgent: { account: () => ACCOUNT, models: () => models } })

async function viewOf(s: Awaited<ReturnType<typeof setup>>, sessionID: string) {
  const value = await s.speed.get({ sessionID: sid(sessionID) }, rpcContext())
  if (!("offers" in value)) throw new Error(`session.speed.get failed: ${JSON.stringify(value)}`)
  return value
}

describe("Speed: the Claude Agent route (CAM-6)", () => {
  test("Fast where Claude Code offers it, at the catalog's Fast price of the model the alias runs; none elsewhere", async () => {
    await using s = await setup()
    s.session(ROOT, "claude-agent", "opus")
    expect(await viewOf(s, ROOT)).toMatchObject({
      consent: "needed",
      offers: [
        {
          choice: "fast",
          tier: "fast",
          wire: "speed",
          basis: "account",
          status: "available",
          billing: { type: "extra", input: 8, output: 40 },
        },
      ],
    })
    s.session("ses_sonnet", "claude-agent", "sonnet")
    expect(await viewOf(s, "ses_sonnet")).toMatchObject({ offers: [], none: "model" })
    // Without a Claude Agent account own does not run the route: the provider's own note.
    await using none = await speedSetup({ claudeAgent: { account: () => undefined, models: () => MODELS } })
    none.session(ROOT, "claude-agent", "opus")
    expect(await viewOf(none, ROOT)).toMatchObject({ offers: [], none: "provider" })
  })

  test("Fast needs the usage-credit consent; then a request asks Claude Code's Fast mode and its answer is served", async () => {
    await using s = await setup()
    s.session(ROOT, "claude-agent", "opus")
    expect(failure(await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext()))).toMatchObject({
      type: "speed_consent_required",
    })
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast", consent: true }, rpcContext())
    expect(s.kv.values.has(Kv.ackClaudeFast)).toBe(true)
    const event = contextEvent(ROOT, "claude-agent", "opus")
    await s.speed.onRequestShape(event, "context")
    expect(event.options).toEqual({ fastMode: true })
    s.speed.claudeAgentFast(ROOT, { model: "opus", requested: true, state: "on" })
    expect((await viewOf(s, ROOT)).served).toMatchObject({ requested: "fast", served: "fast", downgraded: false })
    // Generate requests (titles) keep Standard; another Location's answer for a session it never sent changes nothing.
    const title = contextEvent(ROOT, "claude-agent", "opus")
    await s.speed.onRequestShape(title, "generate")
    expect(title.options).toEqual({})
    s.speed.claudeAgentFast("ses_elsewhere", { model: "opus", requested: true, state: "off", reason: "free" })
    expect((await viewOf(s, ROOT)).offers[0]?.status).toBe("available")
  })

  test("usage credits off marks Fast unavailable and the next request goes Standard; a rate limit is a cooldown", async () => {
    await using s = await setup()
    s.session(ROOT, "claude-agent", "opus")
    await s.speed.set({ sessionID: sid(ROOT), speed: "fast", consent: true }, rpcContext())
    await s.speed.onRequestShape(contextEvent(ROOT, "claude-agent", "opus"), "context")
    s.speed.claudeAgentFast(ROOT, { model: "opus", requested: true, state: "off", reason: "extra_usage_disabled" })
    await s.settle()
    expect((await viewOf(s, ROOT)).offers[0]).toMatchObject({ status: "unavailable", reason: "extra_usage_disabled" })
    const next = contextEvent(ROOT, "claude-agent", "opus")
    await s.speed.onRequestShape(next, "context")
    expect(next.options).toEqual({})
    expect(s.changes()).toContainEqual([ROOT, "fallback", "standard"])

    await using t = await setup()
    t.session(ROOT, "claude-agent", "opus")
    await t.speed.set({ sessionID: sid(ROOT), speed: "fast", consent: true }, rpcContext())
    await t.speed.onRequestShape(contextEvent(ROOT, "claude-agent", "opus"), "context")
    t.speed.claudeAgentFast(ROOT, { model: "opus", requested: true, state: "cooldown" })
    expect((await viewOf(t, ROOT)).offers[0]).toMatchObject({ status: "cooldown", until: expect.any(Number) })
  })
})
