// 07 §5.5 세션 트리 기다리기: a switch of the main to another subscription of the same company waits for the subagents
// still running on the old one (`switch.estimate.busyChildren`, `switch.apply{children}`), so one root never uses two
// ChatGPT subscriptions at once; and the child policy the switch leaves behind (02 §5.11 rule 4). Fake codex accounts
// 01 (`codexA`) and 02 (`codexB`), metered OpenAI keys, the Claude slot and a local model; every credential is fake.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Schema } from "effect"
import { Kv, Registry } from "@own/protocol"
import type { Variant } from "../../src/switching/variant.js"
import { failure, machine, type MachineInput } from "./harness.js"
import { PROVIDERS, registry } from "./support.js"

// Several turns and subagent runs per test; a loaded machine (parallel suites) needs more than the 5 s default.
setDefaultTimeout(30_000)

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const B = { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol", variant: "high" }
const OA = { providerID: PROVIDERS.oaiA, id: "gpt-5.5", variant: "high" }
const OB = { providerID: PROVIDERS.oaiB, id: "gpt-5.5", variant: "high" }
const CLAUDE = { providerID: "anthropic", id: "claude-opus-5-5" }
const LOCAL = { providerID: "ollama", id: "qwen3:8b" }
const ROOT = "ses_root"
const CLAUDE_SLOT = { detected: true, version: "1.0.0", integrity: null, verified: true }

type Machine = Awaited<ReturnType<typeof machine>>

async function started(input: MachineInput = {}, model: Variant.Ref = A) {
  const m = await machine({ claude: CLAUDE_SLOT, ...input, models: { [ROOT]: model } })
  await m.send("session.created", { sessionID: ROOT, model, projectID: "p", slug: "s", version: "2", location: {} })
  await m.turn(ROOT, model, { input: 12_000 })
  return m
}

/** A subagent session below `parentID`, running unless `running` is false. */
async function child(m: Machine, sessionID: string, model: Variant.Ref, parentID = ROOT, running = true) {
  m.models.set(sessionID, model)
  await m.send("session.created", { sessionID, parentID, model, projectID: "p", slug: "s", version: "2", location: {} })
  if (running) await m.send("session.execution.started", { sessionID })
  await m.flush()
}

async function finish(m: Machine, sessionID: string) {
  await m.send("session.execution.succeeded", { sessionID })
  await m.flush()
}

async function estimate(m: Machine, target: Variant.Ref) {
  const result = await m.rpc("switch.estimate", { sessionID: ROOT, target })
  if (failure(result) || !("estimateID" in result)) throw new Error("estimate failed")
  return result
}

/** `ctx.session.interrupt` (the harness has none): records the call and ends the run like core, asynchronously. */
function interrupts(m: Machine) {
  const calls: string[] = []
  Object.assign(m.deps.ctx.session, {
    interrupt: async (request: { readonly sessionID: string }) => {
      calls.push(request.sessionID)
      setTimeout(
        () => void m.send("session.execution.interrupted", { sessionID: request.sessionID, reason: "user" }),
        0,
      )
      return { interrupted: true }
    },
  })
  return calls
}

describe("session tree wait (07 §5.5)", () => {
  test("after-idle: the switch to ChatGPT 02 waits in WAIT_SAFE until the subagents on 01 finished", async () => {
    await using m = await started()
    // A relative-target child runs on the main account; a metered one never holds the switch.
    await child(m, "ses_rel", A)
    await child(m, "ses_paid", OA)
    const planned = await estimate(m, B)
    expect(planned.busyChildren).toEqual({ count: 1, accountID: "acc_codexA" })

    const applied = await m.rpc("switch.apply", {
      sessionID: ROOT,
      estimateID: planned.estimateID,
      target: B,
      strategy: "now",
      reason: "manual",
    })
    expect(applied).toMatchObject({ state: "WAIT_SAFE", detail: { state: "WAIT_SAFE", target: B } })
    await finish(m, "ses_paid")
    expect(m.calls.switchModel).toEqual([])
    expect(await m.rpc("switch.state", { sessionID: ROOT })).toMatchObject({ state: "WAIT_SAFE" })

    // Only once nothing in the tree runs on 01 does the root move to 02.
    await finish(m, "ses_rel")
    expect(m.calls.switchModel).toEqual([{ sessionID: ROOT, model: B }])
    expect(await m.rpc("switch.state", { sessionID: ROOT })).toMatchObject({ state: "COOLDOWN" })
    expect(m.events("switch.recorded")).toEqual([expect.objectContaining({ from: A, to: B })])
  })

  test("after-idle covers the whole tree and the root's own turn, whichever ends last", async () => {
    await using m = await started()
    await m.send("session.execution.started", { sessionID: ROOT })
    await child(m, "ses_child", OB)
    // A grandchild on 01 under a metered child still counts: the tree, not only direct children.
    await child(m, "ses_grand", A, "ses_child")
    expect((await estimate(m, B)).busyChildren).toEqual({ count: 1, accountID: "acc_codexA" })
    expect(
      await m.rpc("switch.apply", { sessionID: ROOT, target: B, strategy: "now", reason: "manual" }),
    ).toMatchObject({ state: "WAIT_SAFE" })

    await finish(m, ROOT)
    expect(m.calls.switchModel).toEqual([])
    await finish(m, "ses_grand")
    expect(m.calls.switchModel).toEqual([{ sessionID: ROOT, model: B }])

    // And the other order: the subagent ends first, the root's turn later.
    await m.flush()
    await m.turn(ROOT, B, { input: 1_000 })
    await child(m, "ses_next", B)
    await m.send("session.execution.started", { sessionID: ROOT })
    expect(
      await m.rpc("switch.apply", { sessionID: ROOT, target: A, strategy: "now", reason: "manual" }),
    ).toMatchObject({ state: "WAIT_SAFE" })
    await finish(m, "ses_next")
    expect(m.calls.switchModel).toHaveLength(1)
    await finish(m, ROOT)
    expect(m.calls.switchModel).toEqual([
      { sessionID: ROOT, model: B },
      { sessionID: ROOT, model: A },
    ])
  })

  test("stop interrupts the subagents on the old subscription first, then switches", async () => {
    await using m = await started()
    const interrupted = interrupts(m)
    await child(m, "ses_rel", A)
    await child(m, "ses_grand", A, "ses_rel")
    await child(m, "ses_paid", OA)
    const applied = await m.rpc("switch.apply", {
      sessionID: ROOT,
      target: B,
      strategy: "now",
      reason: "manual",
      children: "stop",
    })
    expect(applied).toMatchObject({ state: "WAIT_SAFE" })
    expect(new Set(interrupted)).toEqual(new Set(["ses_rel", "ses_grand"]))
    expect(m.calls.switchModel).toEqual([])

    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: ROOT, model: B }])
    // The metered subagent was never stopped and still runs.
    expect(interrupted).not.toContain("ses_paid")
    expect(m.deps.runtime.sessions.get("ses_paid")?.busy).toBe(true)
  })

  test("subagents on another company, a metered account or a local model never hold the switch", async () => {
    await using m = await started()
    await child(m, "ses_claude", CLAUDE)
    await child(m, "ses_paid", OA)
    await child(m, "ses_local", LOCAL)
    // A finished child on 01 does not run anymore.
    await child(m, "ses_done", A, ROOT, false)
    expect((await estimate(m, B)).busyChildren).toBeNull()
    expect(
      await m.rpc("switch.apply", { sessionID: ROOT, target: B, strategy: "now", reason: "manual" }),
    ).toMatchObject({ state: "SWITCHING" })
    expect(m.calls.switchModel).toEqual([{ sessionID: ROOT, model: B }])
  })

  test("a target that is no subscription, or another company's, does not wait either", async () => {
    await using m = await started()
    await child(m, "ses_rel", A)
    expect((await estimate(m, CLAUDE)).busyChildren).toBeNull()
    expect((await estimate(m, OA)).busyChildren).toBeNull()
    expect(
      await m.rpc("switch.apply", { sessionID: ROOT, target: OA, strategy: "now", reason: "manual" }),
    ).toMatchObject({ state: "SWITCHING" })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: ROOT, model: OA }])
  })
})

describe("one ChatGPT login (07 §5.4): codex and siwc are one subscription", () => {
  const SIWC = "own-siwc-eeee"
  const OTHER = "own-siwc-ffff"
  const S = { providerID: SIWC, id: "gpt-5.6-sol", variant: "high" }
  const T = { providerID: OTHER, id: "gpt-5.6-sol", variant: "high" }

  test("moving the main between them needs no wait; a siwc account of another login does", async () => {
    await using m = await started({ registry: withSiwc() })
    await child(m, "ses_rel", A)
    expect((await estimate(m, S)).busyChildren).toBeNull()
    expect((await estimate(m, T)).busyChildren).toEqual({ count: 1, accountID: "acc_codexA" })
    expect(
      await m.rpc("switch.apply", { sessionID: ROOT, target: S, strategy: "now", reason: "manual" }),
    ).toMatchObject({ state: "SWITCHING" })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: ROOT, model: S }])
  })

  /** The registry plus two `siwc` accounts: one of codexA's ChatGPT login, one of another login. */
  function withSiwc() {
    const base = Schema.encodeSync(Registry.File)(registry())
    const codexA = base.accounts.find((account) => account.id === "acc_codexA")
    if (!codexA) throw new Error("fixture: no codexA")
    const siwc = (id: string, providerID: string, login: string) => ({
      ...codexA,
      id,
      kind: "siwc",
      providerID,
      cacheDomain: `cd_${providerID.slice(-4)}`,
      quotaDomain: `qd_${providerID.slice(-4)}`,
      identity: { login },
    })
    const slot = (accountID: string) => ({ ...base.slots[PROVIDERS.codexA], kind: "siwc", accounts: [accountID] })
    return Schema.decodeUnknownSync(Registry.File)({
      ...base,
      cacheDomains: {
        ...base.cacheDomains,
        cd_eeee: { kind: "siwc", scope: "api_key", poolingVerified: false },
        cd_ffff: { kind: "siwc", scope: "api_key", poolingVerified: false },
      },
      quotaDomains: {
        ...base.quotaDomains,
        qd_eeee: { kind: "siwc", scope: "api_key" },
        qd_ffff: { kind: "siwc", scope: "api_key" },
      },
      accounts: [
        ...base.accounts.map((account) =>
          account.id === "acc_codexA" ? { ...account, identity: { fingerprint: "login-01" } } : account,
        ),
        siwc("acc_siwcA", SIWC, "login-01"),
        siwc("acc_siwcB", OTHER, "login-02"),
      ],
      slots: { ...base.slots, [SIWC]: slot("acc_siwcA"), [OTHER]: slot("acc_siwcB") },
    })
  }
})

describe("child policy (02 §5.11 rule 4, 07 §5.5)", () => {
  async function switched(from: Variant.Ref, to: Variant.Ref, reason: "manual" | "hard" = "manual") {
    const m = await started({}, from)
    await m.rpc("switch.apply", { sessionID: ROOT, target: to, strategy: "now", reason })
    await m.flush()
    return m
  }

  test("children keep the slot the main left only after a manual switch that keeps it in the new A", async () => {
    // ChatGPT 01 → 02: another subscription of the same company, never in A.
    await using same = await switched(A, B)
    expect(same.kv.get(Kv.childPolicy(ROOT))).toMatchObject({ policy: "follow", providerID: PROVIDERS.codexA })
    // ChatGPT 01 → an OpenAI API key: a metered main of the same company admits no subscription of it.
    await using metered = await switched(A, OA)
    expect(metered.kv.get(Kv.childPolicy(ROOT))).toMatchObject({ policy: "follow", providerID: PROVIDERS.codexA })
    // ChatGPT 01 → the Claude slot: another company's subscription stays in A.
    await using claude = await switched(A, CLAUDE)
    expect(claude.kv.get(Kv.childPolicy(ROOT))).toMatchObject({ policy: "keep", providerID: PROVIDERS.codexA })
    // A metered key → another one: metered targets stay in A.
    await using keys = await switched(OA, OB)
    expect(keys.kv.get(Kv.childPolicy(ROOT))).toMatchObject({ policy: "keep", providerID: PROVIDERS.oaiA })
  })

  test("after a hard or auth trigger children always follow", async () => {
    await using m = await switched(OA, OB, "hard")
    expect(m.kv.get(Kv.childPolicy(ROOT))).toMatchObject({ policy: "follow", providerID: PROVIDERS.oaiA })
  })

  test("a variant-only switch leaves no policy", async () => {
    await using m = await switched(A, { ...A, variant: "low" })
    expect(m.kv.get(Kv.childPolicy(ROOT))).toBeUndefined()
  })
})
