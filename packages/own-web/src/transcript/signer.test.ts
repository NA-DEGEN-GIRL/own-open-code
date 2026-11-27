// The account that signed a step or a compaction (SL 2026-10-26): a real OwnStore over a fake own.accounts transport
// with three fake Claude accounts on `anthropic` (AC-01 = the slot's own, AC-02, AC-03), and ledger lines in the shape
// the router writes. Bug of 2026-10-26: one conversation switched AC-03 → AC-01 → AC-02 between turns; the ledger named
// each step's account, but every footer said AC-01, the first account on the provider.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { Cache, Ledger } from "@own/protocol"
import { createRoot } from "solid-js"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import { createI18n } from "@/i18n"
import { slotOf } from "@/switcher/labels"
import { signerOf, switchSigners } from "./signer"

const SRC = path.join(import.meta.dir, "..")
const tick = () => new Promise((resolve) => setTimeout(resolve, 80))
const SESSION = "ses_claude_multi"
const claude = (id: string, label: string, color: string) => ({
  id,
  providerID: "anthropic",
  kind: "claude-sub",
  label,
  shortLabel: label,
  color,
  billing: "subscription",
  status: "ready",
  thirdParty: false,
})

/** A primary ledger line of `messageID` signed by `accountID` (02 §7.5), cold: nothing read from the cache. */
function line(messageID: string, accountID: string | null, providerID = "anthropic"): Ledger.Line {
  // SAFETY: fixture data in the shape of the schema's decoded type (branded ids are plain strings at runtime).
  return {
    v: 1,
    ts: 1_790_000_000_000,
    sessionID: SESSION,
    messageID,
    kind: "primary",
    accountID,
    providerID,
    modelID: "claude-haiku-5-5",
    variant: null,
    credentialRef: null,
    transport: "http",
    switchEpoch: 0,
    compactionEpoch: 0,
    tokens: { input: 52_000, cacheRead: 0, cacheWrite: 51_000, cacheWrite1h: null, output: 300, reasoning: 0 },
    P: 52_000,
    hit: 0,
    cost: null,
    costUSDOpenCode: 0,
    coldExpected: null,
  } as unknown as Ledger.Line
}

async function withStore(run: (own: ReturnType<typeof createOwnStore>) => Promise<void> | void) {
  const answers: Record<string, unknown> = {
    health: { version: "local", buildId: "b", guard: "ok", controlDir: "C:\\ctl" },
    "accounts.list": {
      revision: 7,
      accounts: [
        claude("acc_claude_slot", "AC-01", "indigo"),
        claude("acc_01M57GC3", "AC-02", "teal"),
        claude("acc_01M57GR3", "AC-03", "amber"),
      ],
    },
    "quota.snapshot": { windows: [], exhausted: [] },
    // The conversation is bound to AC-02 now (its last switch).
    "session.binding": {
      bindings: [{ sessionID: SESSION, accountID: "acc_01M57GC3", model: { providerID: "anthropic", id: "h" } }],
    },
    "presets.list": { groups: [] },
    "policy.get": { policy: { defaults: { byKind: {} } } },
  }
  const client = {
    rpc: { call: async (input: { method: string }) => ({ output: answers[input.method] ?? {} }) },
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
    own.watchVisible([SESSION])
    bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
    await tick()
    await run(own)
    dispose()
  })
}

describe("the account that signed a step (SL 2026-10-26)", () => {
  const i18n = createI18n("ko")
  const providerName = () => "Anthropic"

  test("three steps on three Claude accounts name three accounts; the provider names only the first", async () => {
    await withStore((own) => {
      const names = { own, i18n, providerName }
      const steps = [line("msg_1", "acc_01M57GR3"), line("msg_2", "acc_claude_slot"), line("msg_3", "acc_01M57GC3")]
      const signers = steps.map((item) => signerOf(names, { sessionID: SESSION, providerID: "anthropic", line: item }))
      expect(signers.map((item) => [item.display.label, item.display.color, item.recorded])).toEqual([
        ["AC-03", "amber", true],
        ["AC-01", "indigo", true],
        ["AC-02", "teal", true],
      ])
      expect(new Set(signers.map((item) => item.key)).size).toBe(3)
      // What the footer read before: the provider's first account, the same for every step.
      expect(own.accountFor("anthropic")?.label).toBe("AC-01")
    })
  })

  test("before its line: the bound account; a removed account, a built-in provider, a stand-in's line", async () => {
    await withStore((own) => {
      const names = { own, i18n, providerName }
      const of = (item: Ledger.Line | undefined, providerID = "anthropic") =>
        signerOf(names, { sessionID: SESSION, providerID, line: item })
      // A running step (its line comes with `ledger.step`): the conversation's bound account, not the first.
      expect([of(undefined).display.label, of(undefined).recorded]).toEqual(["AC-02", false])
      // An account removed since: said so, never another account's name.
      expect([of(line("msg_4", "acc_01REMOVED")).display.label, of(line("msg_4", "acc_01REMOVED")).key]).toEqual([
        "뺀 계정",
        "acc_01REMOVED",
      ])
      // No own account signed it: the built-in provider with global credentials.
      expect(of(line("msg_5", null)).display).toMatchObject({ builtin: true, label: "기본 Anthropic · 전역 계정" })
      // A compaction a stand-in model of another provider wrote: its line does not name this provider's account.
      expect(of(line("msg_6", "acc_01M57GR3", "own-oai-c3d4")).display.label).toBe("AC-02")
    })
  })

  test("a cache badge shows a slot's state only for the account that signed its last request", () => {
    const slot = { providerID: "anthropic", state: "warm", L: 52_000, lastReqAt: 1, accountID: "acc_01M57GR3" }
    // SAFETY: fixture snapshot in the decoded shape (branded ids are plain strings at runtime).
    const snapshot = { sessionID: SESSION, now: 2, slots: [slot] } as unknown as Cache.Snapshot
    expect(slotOf(snapshot, "anthropic", "acc_01M57GR3")?.state).toBe("warm")
    // AC-02 never read AC-03's cache: no slot, so the badge says cold.
    expect(slotOf(snapshot, "anthropic", "acc_01M57GC3")).toBeUndefined()
    // Without an account on either side (a slot written before SL, a built-in provider): the provider's slot.
    expect(slotOf(snapshot, "anthropic")?.state).toBe("warm")
    const old = { sessionID: SESSION, now: 2, slots: [{ ...slot, accountID: undefined }] } as unknown as Cache.Snapshot
    expect(slotOf(old, "anthropic", "acc_01M57GC3")?.state).toBe("warm")
    // SL-8: one slot per Claude account (newest first): each account reads its own.
    const both = {
      sessionID: SESSION,
      now: 2,
      slots: [
        { ...slot, state: "cooling", lastReqAt: 2, accountID: "acc_01M57GC3" },
        { ...slot, state: "warm", lastReqAt: 1 },
      ],
    } as unknown as Cache.Snapshot
    expect(slotOf(both, "anthropic", "acc_01M57GR3")?.state).toBe("warm")
    expect(slotOf(both, "anthropic", "acc_01M57GC3")?.state).toBe("cooling")
    expect(slotOf(both, "anthropic", "acc_claude_slot")).toBeUndefined()
    expect(slotOf(both, "anthropic")?.state).toBe("cooling")
  })

  test("the footer, the markers, the viewer and the announcer name the signer, not the provider", async () => {
    const read = (file: string) => Bun.file(path.join(SRC, file)).text()
    for (const file of [
      "transcript/footer.tsx",
      "transcript/compaction-marker.tsx",
      "compactions/dialog.tsx",
      "transcript/session.tsx",
    ])
      expect([file, (await read(file)).includes("signerOf(")]).toEqual([file, true])
    // SL-8: the switch marker and its screen-reader line read the steps around the switch.
    for (const file of ["transcript/switch-marker.tsx", "transcript/session.tsx"])
      expect([file, (await read(file)).includes("switchSigners(")]).toEqual([file, true])
    for (const file of ["transcript/switch-marker.tsx", "transcript/session.tsx", "transcript/footer.tsx"])
      expect([file, (await read(file)).includes("accountFor(")]).toEqual([file, false])
  })

  // SL-8: a switch marker named the provider's first Claude account on both sides.
  test("a switch marker's sides: the steps around it, else the bound account; a Claude switch that moved the account", async () => {
    await withStore((own) => {
      const names = { own, i18n, providerName }
      const CLAUDE = { providerID: "anthropic", id: "claude-haiku-5-5" }
      const CODEX = { providerID: "own-codex-a1b2", id: "gpt-5.6-sol" }
      const lines: Record<string, Ledger.Line> = {
        msg_cl3: line("msg_cl3", "acc_01M57GR3"),
        msg_cl2: line("msg_cl2", "acc_01M57GC3"),
        msg_cl2b: line("msg_cl2b", "acc_01M57GC3"),
        msg_codex: line("msg_codex", null, CODEX.providerID),
      }
      const sides = (marker: Parameters<typeof switchSigners>[2]) => {
        const value = switchSigners(names, SESSION, marker, (id) => lines[id])
        return [value.kind, value.from.display.label, value.to.display.label]
      }
      // AC-03 → ChatGPT: the step before was AC-03's.
      expect(
        sides({ kind: "account", from: CLAUDE, to: CODEX, beforeStepID: "msg_cl3", firstStepID: "msg_codex" }).slice(
          0,
          2,
        ),
      ).toEqual(["account", "AC-03"])
      // ChatGPT → Claude before its first step: the conversation's bound Claude account (AC-02 here), not AC-01.
      expect(
        sides({ kind: "account", from: CODEX, to: CLAUDE, beforeStepID: "msg_codex", firstStepID: undefined })[2],
      ).toBe("AC-02")
      // A Claude model switch on AC-02 keeps the account.
      const sonnet = { ...CLAUDE, id: "claude-sonnet-5-5" }
      expect(
        sides({ kind: "model", from: CLAUDE, to: sonnet, beforeStepID: "msg_cl2", firstStepID: "msg_cl2b" }),
      ).toEqual(["model", "AC-02", "AC-02"])
      // One whose steps ran on two accounts is an account switch; a stand-in from the binding never decides it.
      expect(
        sides({ kind: "model", from: CLAUDE, to: sonnet, beforeStepID: "msg_cl3", firstStepID: "msg_cl2b" }),
      ).toEqual(["account", "AC-03", "AC-02"])
      expect(
        sides({ kind: "model", from: CLAUDE, to: sonnet, beforeStepID: "msg_cl3", firstStepID: undefined }),
      ).toEqual(["model", "AC-03", "AC-02"])
    })
  })
})
