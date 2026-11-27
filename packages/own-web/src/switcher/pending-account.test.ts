// SL-17 (2026-10-27): the switcher moves a ChatGPT conversation's tree to the chosen Claude account
// (`plugin.claudeAuth.session.set`, AC-03) before it asks for the switch, but its binding names the ChatGPT account
// until the switch lands, so every pending surface named the first Claude account on `anthropic` (AC-01). The router
// now names the Claude account in the pending switch record and the estimate. A real OwnStore over a fake own.accounts
// transport with fake accounts: 개인 Pro (ChatGPT) and AC-01 (the slot's own), AC-02, AC-03 on `anthropic`.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent, SessionInboxInfo } from "@opencode/client"
import type { Ledger } from "@own/protocol"
import { createRoot, createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import { createQueue } from "@/queue/controller"
import { switchNote } from "@/sidebar/model"
import { latestLine } from "@/subagent/data"
import { accountOf, targetAccount } from "./labels"

const SRC = path.join(import.meta.dir, "..")
const tick = () => new Promise((resolve) => setTimeout(resolve, 80))
const CODEX = { providerID: "own-codex-a1b2", id: "gpt-5.6-sol", variant: "high" }
const CLAUDE = { providerID: "anthropic", id: "claude-haiku-5-5" }
const SONNET = { providerID: "anthropic", id: "claude-sonnet-5-5" }
const CL01 = "acc_claude_slot"
const CL02 = "acc_01M57GC3"
const CL03 = "acc_01M57GR3"
/** A ChatGPT conversation whose tree the switcher bound to AC-03, and a Claude conversation on AC-03. */
const GPT = "ses_gpt_to_claude"
const ON_CL3 = "ses_on_cl3"
const CHILD_A = "ses_child_a"
const CHILD_B = "ses_child_b"

const view = (id: string, providerID: string, kind: string, label: string) => ({
  id,
  providerID,
  kind,
  label,
  shortLabel: label,
  color: "teal",
  billing: "subscription",
  status: "ready",
  thirdParty: false,
})

/** A primary ledger line of `sessionID` signed by `accountID` at `ts`. */
function line(sessionID: string, accountID: string, ts: number): Ledger.Line {
  // SAFETY: fixture data in the shape of the schema's decoded type (branded ids are plain strings at runtime).
  return {
    v: 1,
    ts,
    sessionID,
    messageID: `msg_${sessionID}`,
    kind: "primary",
    accountID,
    providerID: "anthropic",
    modelID: CLAUDE.id,
    variant: null,
    credentialRef: null,
    transport: "http",
    switchEpoch: 0,
    compactionEpoch: 0,
    tokens: { input: 1_000, cacheRead: 0, cacheWrite: 900, cacheWrite1h: null, output: 30, reasoning: 0 },
    P: 1_000,
    hit: 0,
    cost: null,
    costUSDOpenCode: 0,
    coldExpected: null,
  } as unknown as Ledger.Line
}

async function withStore(run: (input: Fixture) => Promise<void> | void) {
  // `ledger.session` answers when the test says so (a late answer for a child shown before).
  const ledger = new Map<string, (lines: Ledger.Line[]) => void>()
  const answers: Record<string, (input: Record<string, unknown>) => unknown> = {
    health: () => ({ version: "local", buildId: "b", guard: "ok", controlDir: "C:\\ctl" }),
    "accounts.list": () => ({
      revision: 3,
      accounts: [
        view("acc_personal", CODEX.providerID, "codex", "개인 Pro"),
        view(CL01, "anthropic", "claude-sub", "AC-01"),
        view(CL02, "anthropic", "claude-sub", "AC-02"),
        view(CL03, "anthropic", "claude-sub", "AC-03"),
      ],
    }),
    "quota.snapshot": () => ({ windows: [], exhausted: [] }),
    "session.binding": (input) => ({
      bindings: (input.sessionIDs as string[]).map((sessionID) => ({
        sessionID,
        model: sessionID === GPT ? CODEX : CLAUDE,
        accountID: sessionID === GPT ? "acc_personal" : CL03,
        builtin: false,
        thirdParty: sessionID !== GPT,
        home: null,
        switch: { state: "STEADY" },
      })),
    }),
    // The router's records: ChatGPT → Claude waits for the turn and names AC-03; the Claude conversation's model switch
    // comes from a service before the record named an account.
    "switch.state": (input) =>
      input.sessionID === GPT
        ? { state: "WAIT_SAFE", target: CLAUDE, strategy: "now", reason: "manual", accountID: CL03 }
        : { state: "COMPACTING", target: SONNET, requestedAt: 1, timeout: 600_000 },
    "cache.state": (input) => ({ sessionID: input.sessionID, now: 1, slots: [] }),
    "ledger.session": (input) =>
      new Promise((resolve) =>
        ledger.set(String(input.sessionID), (steps) => resolve({ steps, totals: { byAccount: {} }, switchCount: 0 })),
      ),
    "presets.list": () => ({ groups: [] }),
    "policy.get": () => ({ policy: { defaults: { byKind: {} } } }),
  }
  const client = {
    rpc: {
      call: async (input: { method: string; input?: Record<string, unknown> }) => ({
        output: (await answers[input.method]?.(input.input ?? {})) ?? {},
      }),
    },
    session: { get: async () => ({}), list: async () => ({ data: [], cursor: {} }), compact: async () => ({}) },
    project: { list: async () => [] },
  }
  await createRoot(async (dispose) => {
    const bus = createEventBus()
    const rpc = createOwnRpc({
      // SAFETY: the store only reaches the members defined above.
      client: () => client as unknown as OpenCodeClient,
      routing: { control: async () => "C:\\ctl", sessionDirectory: () => "D:\\p" },
      scopes: () => ALL_SCOPES,
    })
    const own = createOwnStore({
      rpc,
      bus,
      client: () => client as unknown as OpenCodeClient,
      sessionDirectory: () => "D:\\p",
    })
    own.watchVisible([GPT, ON_CL3])
    own.watchOpen(GPT)
    own.watchOpen(ON_CL3)
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    // A queued prompt waits for the switch; the session runs.
    const queued = {
      id: "inb_1",
      sessionID: GPT,
      time: { created: 1 },
      type: "user",
      delivery: "queue",
      payload: { text: "다음" },
    } as SessionInboxInfo
    // SAFETY: the queue and the labels read only these members of the runtime.
    const runtime = {
      key: "local",
      own,
      data: {
        session: {
          get: () => undefined,
          status: () => "running",
          pending: { list: () => [queued] },
        },
        location: { model: { list: () => [] } },
      },
    } as unknown as ServerRuntime
    await run({ runtime, ledger })
    dispose()
  })
}

interface Fixture {
  readonly runtime: ServerRuntime
  readonly ledger: Map<string, (lines: Ledger.Line[]) => void>
}

describe("a pending switch names the account it lands on (SL-17)", () => {
  test("ChatGPT → Claude names the Claude account of its record; a Claude conversation its own", async () => {
    await withStore(({ runtime }) => {
      // What the pill, the sidebar, the queue, the chip and the dialogs read before: the provider's first account.
      expect(accountOf(runtime, "anthropic", GPT)?.label).toBe("AC-01")
      expect(targetAccount(runtime, "anthropic", GPT)?.label).toBe("AC-03")
      // The cost dialog has no record yet: the estimate names the account (a switcher row of AC-02).
      expect(targetAccount(runtime, "anthropic", GPT, CL02)?.label).toBe("AC-02")
      // A record without an account (an older service): the conversation's own Claude account, never AC-01.
      expect(targetAccount(runtime, "anthropic", ON_CL3)?.label).toBe("AC-03")
      expect(targetAccount(runtime, CODEX.providerID, ON_CL3)?.label).toBe("개인 Pro")
      // The queue: the queued prompt runs on AC-03 after the switch; a steer now still on 개인 Pro.
      const queue = createQueue({
        runtime: () => runtime,
        serverKey: () => "local",
        sessionID: () => GPT,
        held: () => [],
      })
      expect(queue.rows().map((row) => ("note" in row ? row.note : undefined))).toEqual([
        { kind: "afterSwitch", account: "AC-03" },
      ])
      // The sidebar's note carries the record's account to the row.
      expect(switchNote(runtime.own.state.switchState[GPT])).toEqual({
        kind: "pending",
        target: CLAUDE,
        accountID: CL03,
      })
    })
  })

  test("the chip, the pill, the queue, the sidebar, the toasts and the cost dialog read the session or the record", async () => {
    const read = (file: string) => Bun.file(path.join(SRC, file)).text()
    // 1: the chip's labels pass the session; its targets and the landing toast read the record.
    const chip = await read("switcher/pending-chip.tsx")
    expect(chip).toContain("accountOf(props.runtime, model.providerID, props.sessionID)")
    expect(chip).toContain(
      "targetAccount(props.runtime, pending.target.providerID, props.sessionID, pending.accountID)",
    )
    expect(chip).not.toMatch(/accountOf\(props\.runtime, \w+\)/)
    // 2
    expect(await read("switcher/index.tsx")).toContain("targetAccount(runtime, detail.to.providerID, detail.sessionID)")
    // 3
    for (const file of ["switcher/pill.tsx", "queue/controller.ts", "switcher/cost-dialog.tsx", "switcher/flow.ts"])
      expect([file, (await read(file)).includes("targetAccount(")]).toEqual([file, true])
    expect(await read("switcher/cost-dialog.tsx")).toContain("estimate().target.accountID")
    expect(await read("sidebar/rows.tsx")).toContain("ctl.accountOn(id, value.target.providerID, value.accountID)")
  })
})

describe("a subagent's latest signed step (SL-17)", () => {
  test("a late answer for the child shown before never lands on the child shown now", async () => {
    await withStore(async ({ runtime, ledger }) => {
      const [child, setChild] = createSignal<string | undefined>(CHILD_A)
      const signed = latestLine(() => runtime, child)
      await tick()
      setChild(CHILD_B)
      await tick()
      ledger.get(CHILD_B)?.([line(CHILD_B, CL02, 1_000)])
      await tick()
      expect(String(signed()?.accountID)).toBe(CL02)
      // Child A's page comes back last, with a newer step.
      ledger.get(CHILD_A)?.([line(CHILD_A, CL03, 2_000)])
      await tick()
      expect([signed()?.sessionID, signed()?.accountID].map(String)).toEqual([CHILD_B, CL02])
    })
  })
})
