// SL-8 (2026-10-27): the Claude accounts share `anthropic`, and each account has its own prompt cache. A switch
// estimate reads the cache of the account each side runs on (`sess:<sid>:cache:anthropic@<accountID>`): the session's
// tree account for staying, the target account for a Claude row. Fake session core and telemetry, manual clock.

import { expect, test } from "bun:test"
import { Account, Kv } from "@own/protocol"
import { failure, machine } from "./harness.js"

const CLAUDE = { providerID: "anthropic", id: "claude-opus-5-5" }
const CL01 = Account.ID.make("acc_01CLAUDEONE000000000000000")
const CL02 = Account.ID.make("acc_01CLAUDETWO000000000000000")
const CL03 = Account.ID.make("acc_01CLAUDETHREE0000000000000")
const SID = "ses_claude_cache"

/**
 * A conversation that ran its turns on AC-03 (telemetry's entry is AC-03's) and then moved to AC-01. `peek`: what the
 * plugin's sync lookup answers (default: the tree's account, as after a request).
 */
async function movedToOne(peek?: () => Account.ID) {
  const tree = { accountID: CL03 }
  const listed = new Set<string>([CL01, CL02, CL03])
  const m = await machine({
    models: { [SID]: CLAUDE },
    claude: { detected: true, version: "1.0.0", integrity: null, verified: true },
    claudeAccounts: {
      accountOf: async () => tree.accountID,
      peek: peek ?? (() => tree.accountID),
      // SAFETY: the planner only asks whether the account is listed.
      entry: (accountID) => (listed.has(accountID) ? ({ accountID } as never) : undefined),
    },
  })
  await m.send("session.created", {
    sessionID: SID,
    model: CLAUDE,
    projectID: "p",
    slug: "s",
    version: "2",
    location: {},
  })
  await m.turn(SID, CLAUDE, { input: 12_000 })
  await m.turn(SID, CLAUDE, { input: 3_000, read: 150_000, output: 1_000 })
  const entry = {
    lastReqAt: m.clock.now() - 60_000,
    L: 153_000,
    epoch: 0,
    modelID: CLAUDE.id,
    variant: null,
    watermark: { messageID: "msg_last", partIndex: 0 },
    blocksSince: 0,
    messageEndsSince: 0,
    imageTrimEpoch: 0,
    accountID: CL03,
  }
  tree.accountID = CL01
  return { m, entry }
}

async function warmTokens(m: Awaited<ReturnType<typeof machine>>, accountID?: string) {
  const estimate = await m.rpc("switch.estimate", {
    sessionID: SID,
    target: CLAUDE,
    ...(accountID === undefined ? {} : { accountID }),
  })
  if (failure(estimate) || !("inputs" in estimate)) throw new Error("estimate failed")
  return estimate.inputs.W_hi
}

test("a switch estimate to a third Claude account is cold; the account that ran the turns is warm", async () => {
  const { m, entry } = await movedToOne()
  await using _ = m
  m.kv.set(Kv.cache(SID, "anthropic", CL03), entry)
  // AC-02 never ran this conversation, and AC-01 (where the tree is now) neither.
  expect(await warmTokens(m, CL02)).toBe(0)
  expect(await warmTokens(m)).toBe(0)
  // Back to AC-03 within its lifetime: its cache still holds the conversation.
  expect(await warmTokens(m, CL03)).toBeGreaterThan(100_000)
})

test("an entry written before per-account keys counts only for the account it names", async () => {
  const { m, entry } = await movedToOne()
  await using _ = m
  m.kv.set(Kv.cache(SID, "anthropic"), entry)
  expect(await warmTokens(m, CL02)).toBe(0)
  expect(await warmTokens(m, CL03)).toBeGreaterThan(100_000)
})

// SL-17: after a restart the plugin's sync `peek` answers the default account until a request or a binding read ran.
// The estimate reads the tree's binding, so staying on the tree's account is not judged by the default's cache.
test("after a restart the estimate reads the cache of the account the tree is bound to, not the default's", async () => {
  const { m, entry } = await movedToOne(() => CL02)
  await using _ = m
  // The tree is bound to AC-01 now and that account ran the turns; AC-02 (the default) never did.
  m.kv.set(Kv.cache(SID, "anthropic", CL01), { ...entry, accountID: CL01 })
  expect(await warmTokens(m)).toBeGreaterThan(100_000)
  const estimate = await m.rpc("switch.estimate", { sessionID: SID, target: CLAUDE })
  if (failure(estimate) || !("target" in estimate)) throw new Error("estimate failed")
  expect(estimate.target.accountID).toBe(CL01)
})
