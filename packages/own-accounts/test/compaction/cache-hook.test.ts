// own-accounts' compaction hook (hooks.ts) for P-034 (CC-12): a verdict that throws is `older`, so an error never sends
// the whole history; on the second run a failing check of the kept part declines it with `error`. An idle compaction
// is tagged, and cancelled when it delivered too late (CC-16). Real modules, the session hooks captured from
// `Hooks.register`.
import { describe, expect, test } from "bun:test"
import { CompactionCache } from "@own/protocol"
import { Hooks } from "../../src/hooks.js"
import { authSetup } from "../auth/support.js"
import { registryWith } from "../slots/support.js"

async function registered() {
  const s = await authSetup({ registry: await registryWith([{ kind: "anth", label: "A", slug: "aaaa" }]) })
  const session = new Map<string, (event: unknown) => unknown>()
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
        session.set(name, callback)
        return registration
      },
    },
    tool: { hook: none },
    permission: { hook: none },
  }
  // SAFETY: the context parts `Hooks.register` touches; the session hooks are kept.
  await Hooks.register({ ...s.t.deps, ctx: ctx as unknown as typeof s.t.deps.ctx }, s.modules)
  const compaction = session.get("compaction")
  if (!compaction) throw new Error("compaction was not registered")
  return { s, compaction }
}

/** The fields the hook reads and writes of a compaction event. */
function compactionEvent(kept?: string) {
  return {
    sessionID: "ses_cache_hook",
    agent: "build",
    model: { providerID: "own-anth-aaaa", id: "claude-opus-5-5" },
    system: [],
    messages: [],
    options: {},
    tools: {},
    ...(kept === undefined ? {} : { prefix: "full" as const, kept: { messageID: kept } }),
  } as {
    sessionID: string
    prefix?: "full"
    metadata?: Record<string, unknown>
    kept?: { messageID: string }
    cancel?: string
  }
}

describe("compaction hook (P-034, CC-12)", () => {
  test("a verdict that throws is the older request; a failing kept-part check declines the whole history", async () => {
    const { s, compaction } = await registered()
    await using _ = s
    s.modules.telemetry.prefixVerdict = async () => {
      throw new Error("verdict failed")
    }
    s.modules.telemetry.recentVerdict = async () => {
      throw new Error("check failed")
    }
    const first = compactionEvent()
    await compaction(first)
    expect(CompactionCache.verdictOf(first.metadata)).toEqual({ prefix: "older", reason: "error" })
    // Core's run over the whole history names the kept start; the kept part is checked only for a full verdict.
    const kept = compactionEvent("msg_kept")
    await compaction(kept)
    expect(kept.metadata?.[CompactionCache.PREFIX_KEY]).toBeUndefined()
    s.modules.telemetry.prefixVerdict = async () => ({ prefix: "full", reason: "warm" })
    const full = compactionEvent("msg_kept")
    await compaction(full)
    expect(full.prefix).toBeUndefined()
    expect(full.metadata?.[CompactionCache.PREFIX_KEY]).toEqual({ request: "older", reason: "error" })
    expect(s.logs.filter((line) => line.includes("hook_failed")).length).toBe(3)
  })

  test("an idle compaction is tagged; one that delivered too late is cancelled before any request (CC-16)", async () => {
    const { s, compaction } = await registered()
    await using _ = s
    s.modules.switching.idleCompaction = async () => ({})
    const idle = compactionEvent()
    await compaction(idle)
    expect([idle.metadata?.[CompactionCache.TRIGGER_KEY], idle.cancel]).toEqual(["idle", undefined])
    s.modules.switching.idleCompaction = async () => ({ drop: "Dropped: late" })
    const late = compactionEvent()
    await compaction(late)
    expect([late.metadata?.[CompactionCache.TRIGGER_KEY], late.cancel]).toEqual(["idle", "Dropped: late"])
    // Core reads the cancel on its first run, the one over the whole history with its kept start.
    const kept = compactionEvent("msg_kept")
    await compaction(kept)
    expect(kept.cancel).toBe("Dropped: late")
    s.modules.switching.idleCompaction = async () => undefined
    const users = compactionEvent()
    await compaction(users)
    expect([users.metadata?.[CompactionCache.TRIGGER_KEY], users.cancel]).toEqual([undefined, undefined])
  })
})
