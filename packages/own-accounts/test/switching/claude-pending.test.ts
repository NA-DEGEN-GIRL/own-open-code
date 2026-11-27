// SL-17 (2026-10-27): the switcher moves a ChatGPT conversation's tree to the chosen Claude account
// (`plugin.claudeAuth.session.set`) before it asks for the switch, and the conversation's binding names the ChatGPT
// account until the switch lands. The pending switch record (`switch.state`, `session.binding.switch`) and the estimate
// name the Claude account the switch lands on, so every pending surface can name it. Fake session core, manual clock.

import { expect, test } from "bun:test"
import { Account } from "@own/protocol"
import { failure, machine } from "./harness.js"
import { PROVIDERS } from "./support.js"

const CODEX = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const CODEX_B = { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol", variant: "high" }
const CLAUDE = { providerID: "anthropic", id: "claude-opus-5-5" }
const CL01 = Account.ID.make("acc_01CLAUDEONE000000000000000")
const CL02 = Account.ID.make("acc_01CLAUDETWO000000000000000")
const CL03 = Account.ID.make("acc_01CLAUDETHREE0000000000000")
const SID = "ses_claude_pending"

/** A ChatGPT conversation whose tree the switcher bound to AC-03; the plugin's sync lookup still says AC-01. */
async function onChatGpt() {
  const listed = new Set<string>([CL01, CL02, CL03])
  const m = await machine({
    models: { [SID]: CODEX },
    claude: { detected: true, version: "1.0.0", integrity: null, verified: true },
    claudeAccounts: {
      accountOf: async () => CL03,
      peek: () => CL01,
      // SAFETY: the planner only asks whether the account is listed.
      entry: (accountID) => (listed.has(accountID) ? ({ accountID } as never) : undefined),
    },
  })
  await m.send("session.created", {
    sessionID: SID,
    model: CODEX,
    projectID: "p",
    slug: "s",
    version: "2",
    location: {},
  })
  await m.turn(SID, CODEX, { input: 12_000 })
  await m.turn(SID, CODEX, { input: 3_000, read: 150_000, output: 1_000 })
  return m
}

test("a pending switch to Claude names the Claude account the tree runs on", async () => {
  await using m = await onChatGpt()
  await m.send("session.execution.started", { sessionID: SID })
  const waiting = await m.rpc("switch.apply", { sessionID: SID, target: CLAUDE, strategy: "now", reason: "manual" })
  expect(waiting).toMatchObject({ state: "WAIT_SAFE", detail: { state: "WAIT_SAFE", target: CLAUDE, accountID: CL03 } })
  expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "WAIT_SAFE", accountID: CL03 })
  // The binding read the sidebar falls back to carries the record too; its own account is still the ChatGPT one.
  const bound = await m.rpc("session.binding", { sessionIDs: [SID] })
  if (failure(bound) || !("bindings" in bound)) throw new Error("binding failed")
  expect(bound.bindings[0]).toMatchObject({ accountID: "acc_codexA", switch: { state: "WAIT_SAFE", accountID: CL03 } })
  expect(m.events("switch.state").at(-1)).toMatchObject({ detail: { state: "WAIT_SAFE", accountID: CL03 } })

  await m.rpc("switch.cancel", { sessionID: SID })
  const scheduled = await m.rpc("switch.schedule", { sessionID: SID, target: CLAUDE, trigger: "either" })
  expect(failure(scheduled)).toBeUndefined()
  expect(await m.rpc("switch.state", { sessionID: SID })).toMatchObject({ state: "SCHEDULED", accountID: CL03 })

  await m.rpc("switch.cancel", { sessionID: SID })
  const compacting = await m.rpc("switch.apply", {
    sessionID: SID,
    target: CLAUDE,
    strategy: "compact-then-switch",
    reason: "manual",
  })
  expect(compacting).toMatchObject({ state: "COMPACTING", detail: { accountID: CL03 } })

  // Another company's switch is one account: no Claude account named.
  await m.rpc("switch.cancel", { sessionID: SID })
  const codex = await m.rpc("switch.apply", { sessionID: SID, target: CODEX_B, strategy: "now", reason: "manual" })
  expect(codex).toMatchObject({ state: "WAIT_SAFE" })
  expect(await m.rpc("switch.state", { sessionID: SID })).not.toHaveProperty("accountID")
})

test("the estimate names the Claude account its target runs on", async () => {
  await using m = await onChatGpt()
  const target = async (accountID?: string) => {
    const estimate = await m.rpc("switch.estimate", {
      sessionID: SID,
      target: CLAUDE,
      ...(accountID === undefined ? {} : { accountID }),
    })
    if (failure(estimate) || !("target" in estimate)) throw new Error("estimate failed")
    return estimate.target
  }
  // A switcher row of another Claude account names that account; without one, the account the tree runs on.
  expect((await target(CL02)).accountID).toBe(CL02)
  expect((await target()).accountID).toBe(CL03)
  const codex = await m.rpc("switch.estimate", { sessionID: SID, target: CODEX_B })
  if (failure(codex) || !("target" in codex)) throw new Error("estimate failed")
  expect(codex.target).not.toHaveProperty("accountID")
})
