// 07 §5.5 팀 거르기 and the teamOp guard (06 §10.1 경로): with own.team's team context in the root binding
// (`session.preset.apply{team}`), switch suggestions and the target ranking leave out every other subscription of a
// team account's company, and a switch onto one is `team_switch_required` unless own.team's team account operation
// (`teamOp`) asks for it. Fake codex accounts 01 (`codexA`) and 02 (`codexB`), metered OpenAI keys and `siwc` accounts
// of one or another ChatGPT login; every credential is fake.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Schema } from "effect"
import { Kv, Registry } from "@own/protocol"
import { failure, machine, type MachineInput } from "./harness.js"
import { PROVIDERS, registry } from "./support.js"

// Several turns and subagent runs per test; a loaded machine (parallel suites) needs more than the 5 s default.
setDefaultTimeout(30_000)

const A = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const B = { providerID: PROVIDERS.codexB, id: "gpt-5.6-sol", variant: "high" }
const OA = { providerID: PROVIDERS.oaiA, id: "gpt-5.5", variant: "high" }
const SIWC = "own-siwc-eeee"
const OTHER = "own-siwc-ffff"
const S = { providerID: SIWC, id: "gpt-5.6-sol", variant: "high" }
const T = { providerID: OTHER, id: "gpt-5.6-sol", variant: "high" }
const ROOT = "ses_root"
const PLAIN = "ses_plain"
const MINUTE = 60_000

type Machine = Awaited<ReturnType<typeof machine>>

async function started(sessionIDs: ReadonlyArray<string> = [ROOT], input: MachineInput = {}) {
  const m = await machine({ registry: withSiwc(), ...input })
  for (const sessionID of sessionIDs) {
    m.models.set(sessionID, A)
    await m.send("session.created", { sessionID, model: A, projectID: "p", slug: "s", version: "2", location: {} })
    await m.turn(sessionID, A, { input: 12_000 })
  }
  return m
}

/** What own.team stores with `session.preset.apply{team}` in the root binding (07 §5.1). */
function bind(m: Machine, sessionID: string, accounts: ReadonlyArray<string>, role: "main" | "owner" = "owner") {
  m.kv.set(Kv.preset(sessionID), {
    presetID: "builtin:codex",
    group: "codex",
    revision: 0,
    appliedAt: 0,
    entryHash: null,
    team: { teamID: "tm_one", role, accounts: [...accounts], pinned: [] },
  })
}

/** The providers `switch.suggested` offered after a hard exhaustion of `sessionID`'s account. */
async function suggested(m: Machine, sessionID: string) {
  await m.retry(sessionID, A, { class: "hard" })
  await m.turn(sessionID, A, { input: 100 }, "failed")
  const event = m.events("switch.suggested").find((item) => item.sessionID === sessionID)
  const candidates = Array.isArray(event?.candidates) ? event.candidates : []
  return candidates.map((item: { readonly providerID: string }) => item.providerID)
}

describe("team filter (07 §5.5)", () => {
  test("suggestions and the ranked target leave out another ChatGPT subscription outside the team", async () => {
    await using m = await started([ROOT, PLAIN])
    bind(m, ROOT, ["acc_codexA"])
    const team = await suggested(m, ROOT)
    expect(team).not.toContain(PROVIDERS.codexB)
    expect(team).not.toContain(OTHER)
    expect(team).toEqual(expect.arrayContaining([PROVIDERS.oaiA, PROVIDERS.oaiB]))
    // The same ChatGPT login's siwc account is the team's subscription too.
    expect(team).toContain(SIWC)
    expect(await m.rpc("switch.state", { sessionID: ROOT })).not.toMatchObject({ target: B })

    // A session outside a team keeps every candidate.
    expect(await suggested(m, PLAIN)).toEqual(
      expect.arrayContaining([PROVIDERS.codexB, PROVIDERS.oaiA, PROVIDERS.oaiB, SIWC, OTHER]),
    )
  })

  test("a team without an account of that company, or a binding without a team, filters nothing", async () => {
    await using m = await started([ROOT])
    bind(m, ROOT, ["acc_claude_slot"])
    expect(await suggested(m, ROOT)).toEqual(expect.arrayContaining([PROVIDERS.codexB, OTHER]))
  })

  test("the return to the account a team left is never suggested", async () => {
    await using m = await started([ROOT, PLAIN], { teamOps: [MOVE] })
    for (const sessionID of [ROOT, PLAIN]) {
      await m.retry(sessionID, A, { class: "hard", until: m.clock.now() + 10 * MINUTE })
      await m.turn(sessionID, A, { input: 100 }, "failed")
    }
    // own.team moved the team to ChatGPT 02 (its team account operation) and stored the new team account.
    bind(m, ROOT, ["acc_codexA"], "main")
    await m.rpc("switch.apply", { sessionID: ROOT, target: B, strategy: "now", reason: "manual", teamOp: MOVE.id })
    bind(m, ROOT, ["acc_codexB"], "main")
    await m.rpc("switch.apply", { sessionID: PLAIN, target: B, strategy: "now", reason: "manual" })
    await m.flush()
    m.clock.advance(11 * MINUTE)
    for (const sessionID of [ROOT, PLAIN]) await m.turn(sessionID, B, { input: 1_000 })
    const home = m.events("switch.suggested").filter((item) => item.reason === "home_available")
    expect(home.map((item) => item.sessionID)).toEqual([PLAIN])
  })
})

describe("teamOp guard (06 §10.1 경로)", () => {
  test("a team session's switch to another ChatGPT subscription needs own.team's operation", async () => {
    await using m = await started([ROOT, PLAIN])
    bind(m, ROOT, ["acc_codexA"], "main")
    const required = { type: "team_switch_required", data: { teamID: "tm_one" } }
    expect(failure(await m.rpc("switch.estimate", { sessionID: ROOT, target: B }))).toMatchObject(required)
    expect(failure(await m.rpc("switch.estimate", { sessionID: ROOT, target: T }))).toMatchObject(required)
    expect(
      failure(await m.rpc("switch.apply", { sessionID: ROOT, target: B, strategy: "now", reason: "manual" })),
    ).toMatchObject(required)
    // A cold-point schedule never moves the team's account either.
    expect(failure(await m.rpc("switch.schedule", { sessionID: ROOT, target: B, trigger: "either" }))).toMatchObject(
      required,
    )
    expect(m.calls.switchModel).toEqual([])

    // Metered keys, the same login's siwc account and sessions outside a team are unchanged.
    for (const target of [OA, S])
      expect(failure(await m.rpc("switch.estimate", { sessionID: ROOT, target }))).toBe(undefined)
    expect(failure(await m.rpc("switch.estimate", { sessionID: PLAIN, target: B }))).toBeUndefined()
  })

  test("a subagent session of a team root is guarded by the root's team", async () => {
    await using m = await started([ROOT])
    bind(m, ROOT, ["acc_codexA"])
    m.models.set("ses_child", A)
    await m.send("session.created", {
      sessionID: "ses_child",
      parentID: ROOT,
      model: A,
      projectID: "p",
      slug: "s",
      version: "2",
      location: {},
    })
    await m.flush()
    expect(failure(await m.rpc("switch.estimate", { sessionID: "ses_child", target: B }))).toMatchObject({
      type: "team_switch_required",
    })
  })

  test("with teamOp the switch goes through and opens no undo window", async () => {
    await using m = await started([ROOT], { teamOps: [MOVE] })
    bind(m, ROOT, ["acc_codexA"], "main")
    const planned = await m.rpc("switch.estimate", { sessionID: ROOT, target: B, teamOp: MOVE.id })
    if (failure(planned) || !("estimateID" in planned)) throw new Error("estimate failed")
    const applied = await m.rpc("switch.apply", {
      sessionID: ROOT,
      estimateID: planned.estimateID,
      target: B,
      strategy: "now",
      reason: "manual",
      teamOp: MOVE.id,
    })
    expect(applied).toMatchObject({ state: "SWITCHING" })
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: ROOT, model: B }])
    // An undo would take the team main back to 01 alone, outside own.team's operation.
    expect(failure(await m.rpc("switch.undo", { sessionID: ROOT }))).toMatchObject({ type: "undo_window_closed" })
  })

  test("a teamOp own.team does not run as this team's account move is refused (07 §8.1 own.team만 넘김)", async () => {
    await using m = await started([ROOT], {
      teamOps: [
        { ...MOVE, id: "op_01JB0000000000000000000002", teamID: "tm_two" },
        { ...MOVE, id: "op_01JB0000000000000000000003", state: "done" },
        { ...MOVE, id: "op_01JB0000000000000000000004", kind: "rotate" },
      ],
    })
    bind(m, ROOT, ["acc_codexA"], "main")
    const required = { type: "team_switch_required", data: { teamID: "tm_one" } }
    for (const teamOp of [
      "op_01JB0000000000000000000009",
      "op_01JB0000000000000000000002",
      "op_01JB0000000000000000000003",
      "op_01JB0000000000000000000004",
    ])
      expect(
        failure(await m.rpc("switch.apply", { sessionID: ROOT, target: B, strategy: "now", reason: "manual", teamOp })),
      ).toMatchObject(required)
    // An estimate moves nothing and takes the op at its word: own.team plans a move before its op exists.
    expect(
      failure(await m.rpc("switch.estimate", { sessionID: ROOT, target: B, teamOp: "op_01JB0000000000000000000009" })),
    ).toBeUndefined()
    await m.flush()
    expect(m.calls.switchModel).toEqual([])
  })

  test("without own.team every teamOp is refused", async () => {
    await using m = await started([ROOT])
    bind(m, ROOT, ["acc_codexA"], "main")
    expect(
      failure(
        await m.rpc("switch.apply", { sessionID: ROOT, target: B, strategy: "now", reason: "manual", teamOp: MOVE.id }),
      ),
    ).toMatchObject({ type: "team_switch_required" })
  })
})

/** own.team's running team account operation of team `tm_one`. */
const MOVE = { id: "op_01JB0000000000000000000001", teamID: "tm_one", kind: "team-account", state: "running" }

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
