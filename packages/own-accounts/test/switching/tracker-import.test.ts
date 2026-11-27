// 09 §4.2 "own.accounts 측정에서 빼기", IG7 (tracker part): a session own.import wrote (an imported conversation or a
// hidden helper, `session.created` metadata `own.import`) carries the imported history in its first step, so it never
// measures Z and never enters a slot's medians; its Z is the slot's. Normal sessions measure as before. The helper's
// compaction usage still reaches the account ledger (09 §4.4, unchanged code). Every value here is a fixture.

import { describe, expect, test } from "bun:test"
import { OwnImport } from "@own/protocol/rpc-import"
import { SlotSamples } from "@own/runtime"
import { Tracker } from "../../src/switching/tracker.js"
import { sessionEvent } from "../plugins/support.js"
import { CODEX, CODEX_ACCOUNT, SESSION, event, ok, setup } from "../telemetry/support.js"

const SLOT = "own-codex-aaaa"
const OTHER = "own-oai-cccc"
const SOL = { providerID: SLOT, id: "gpt-5.6-sol", variant: "high" }

/** `own.import` of an imported Codex conversation (09 §4.7); checked against the protocol schema below. */
const IMPORTED = {
  [OwnImport.META_KEY]: {
    v: 1,
    kind: "codex",
    sourceID: "0199f1a2-b3c4-7d5e-8f60-71829a3b4c5d",
    root: "codex-default",
    path: "C:\\fixtures\\codex\\sessions\\2026\\10\\01\\rollout-fixture.jsonl",
    title: "Fixture conversation",
    cwd: "C:\\work\\repo",
    models: [{ provider: "openai", id: "gpt-5.5" }],
    versions: ["0.130.0"],
    sourceUpdatedAt: 1_790_000_000_000,
    sourceBytes: 123_456,
    turns: 12,
    contentHash: "a".repeat(64),
    mode: "full",
    checkpoint: null,
    storedFull: true,
    redactions: 0,
    dropped: {},
    importedAt: 1_790_000_100_000,
  },
}

/** `own.import` of the hidden helper that summarizes for a job (09 §4.4). */
const HELPER = { [OwnImport.META_KEY]: { v: 1, helper: true, jobID: "job_01TESTJOB00000000000000000" } }

/** Feeds hand-built events to a fresh tracker; each step is `session.step.started` + `session.step.ended`. */
function tracked() {
  const tracker = new Tracker.Store()
  const counter = { message: 0 }
  return {
    tracker,
    created: (sessionID: string, extra: Record<string, unknown> = {}) =>
      tracker.observe(sessionEvent("session.created", { sessionID, model: SOL, ...extra }), 0),
    step: (sessionID: string, tokens: { readonly input: number; readonly read?: number }, model = SOL) => {
      const assistantMessageID = `msg_${++counter.message}`
      tracker.observe(sessionEvent("session.step.started", { sessionID, assistantMessageID, model, started: 0 }), 0)
      tracker.observe(
        sessionEvent("session.step.ended", {
          sessionID,
          assistantMessageID,
          tokens: { input: tokens.input, output: 0, reasoning: 0, cache: { read: tokens.read ?? 0, write: 0 } },
        }),
        0,
      )
    },
  }
}

describe("the fixtures are real own.import metadata (09 §4.7)", () => {
  test("an import and a helper both decode, and both are marked", () => {
    const imported = OwnImport.decodeMetadata(IMPORTED)
    const helper = OwnImport.decodeMetadata(HELPER)
    expect(imported && !OwnImport.isHelper(imported)).toBe(true)
    expect(helper && OwnImport.isHelper(helper)).toBe(true)
    expect([OwnImport.marked(IMPORTED), OwnImport.marked(HELPER), OwnImport.marked({ "own.team": {} })]).toEqual([
      true,
      true,
      false,
    ])
  })
})

describe("Z and the slot medians skip own.import sessions (09 §4.2, IG7)", () => {
  test("a normal root session measures Z = first step − first prompt and feeds its slot, as before", () => {
    const t = tracked()
    t.created("ses_root")
    t.tracker.prompt("ses_root", "x".repeat(4_000), 0)
    t.step("ses_root", { input: 18_000, read: 2_000 })
    expect(t.tracker.get("ses_root")?.firstL).toBe(20_000)
    expect(t.tracker.Z("ses_root")).toBe(19_000)
    expect(t.tracker.slotMeasure(SLOT)).toEqual({ Z: 19_000, zSource: "measured", exchange: Tracker.DEFAULTS.delta })
    t.step("ses_root", { input: 2_500, read: 20_000 })
    expect(t.tracker.delta("ses_root")).toBe(2_500)
    expect(t.tracker.slotMeasure(SLOT).exchange).toBe(2_500)
  })

  test("an imported conversation never sets firstL or Z; its steps stay out; its Z is the slot's", () => {
    const t = tracked()
    t.created("ses_import", { metadata: IMPORTED })
    t.tracker.prompt("ses_import", "continue", 0)
    t.step("ses_import", { input: 180_000 })
    expect(t.tracker.get("ses_import")?.firstL).toBeUndefined()
    expect(t.tracker.slotMeasure(SLOT)).toEqual({
      Z: Tracker.DEFAULTS.Z,
      zSource: "default",
      exchange: Tracker.DEFAULTS.delta,
    })
    // Its own δ still counts for its own switches; the slot's does not move.
    t.step("ses_import", { input: 4_000, read: 180_000 })
    expect(t.tracker.delta("ses_import")).toBe(4_000)
    expect(t.tracker.slotMeasure(SLOT).exchange).toBe(Tracker.DEFAULTS.delta)
    expect(t.tracker.Z("ses_import")).toBe(Tracker.DEFAULTS.Z)

    // Once the slot measured a normal session, that is the imported session's Z too.
    t.created("ses_root")
    t.tracker.prompt("ses_root", "x".repeat(400), 0)
    t.step("ses_root", { input: 16_100 })
    expect(t.tracker.slotMeasure(SLOT).Z).toBe(16_000)
    expect(t.tracker.Z("ses_import")).toBe(16_000)
    expect(t.tracker.Zu1("ses_import")).toBe(16_000)
  })

  test("after its compaction an imported session's context is the slot's Z + summary + keep", () => {
    const t = tracked()
    t.created("ses_root")
    t.step("ses_root", { input: 16_000 })
    t.created("ses_import", { metadata: IMPORTED })
    t.step("ses_import", { input: 200_000 })
    t.tracker.observe(
      sessionEvent("session.compaction.ended", {
        sessionID: "ses_import",
        tokens: { input: 150_000, output: 6_000, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      0,
    )
    expect(t.tracker.P("ses_import")).toBe(16_000 + 6_000 + 15_000)
  })

  test("a hidden helper is skipped the same way", () => {
    const t = tracked()
    t.created("ses_helper", { metadata: HELPER })
    t.step("ses_helper", { input: 90_000 })
    t.step("ses_helper", { input: 9_000, read: 90_000 })
    expect(t.tracker.get("ses_helper")?.firstL).toBeUndefined()
    expect(t.tracker.slotMeasure(SLOT)).toEqual({
      Z: Tracker.DEFAULTS.Z,
      zSource: "default",
      exchange: Tracker.DEFAULTS.delta,
    })
  })

  test("a subagent keeps its own Z but stays out of the slot medians", () => {
    const t = tracked()
    t.created("ses_child", { parentID: "ses_root" })
    t.tracker.prompt("ses_child", "y".repeat(800), 0)
    t.step("ses_child", { input: 8_200 })
    t.step("ses_child", { input: 1_000, read: 8_200 })
    expect(t.tracker.Z("ses_child")).toBe(8_000)
    expect(t.tracker.slotMeasure(SLOT).zSource).toBe("default")
    expect(t.tracker.slotMeasure(SLOT).exchange).toBe(Tracker.DEFAULTS.delta)
  })

  test("medians of recent root sessions, per slot", () => {
    const t = tracked()
    const OAI = { providerID: OTHER, id: "gpt-5.5", variant: "high" }
    ;[10_000, 30_000, 20_000].forEach((input, index) => {
      t.created(`ses_${index}`)
      t.step(`ses_${index}`, { input })
      t.step(`ses_${index}`, { input: (index + 1) * 1_000, read: input })
    })
    t.created("ses_oai", { model: OAI })
    t.step("ses_oai", { input: 7_000 }, OAI)
    expect(t.tracker.slotMeasure(SLOT)).toEqual({ Z: 20_000, zSource: "measured", exchange: 2_000 })
    expect(t.tracker.slotMeasure(OTHER)).toEqual({ Z: 7_000, zSource: "measured", exchange: Tracker.DEFAULTS.delta })
    expect(t.tracker.slotMeasure("own-ds-none")).toEqual({
      Z: Tracker.DEFAULTS.Z,
      zSource: "default",
      exchange: Tracker.DEFAULTS.delta,
    })
  })

  test("the slot samples are the process's: a session in one Location sizes the slot at the control Location", () => {
    const samples = new SlotSamples.Store()
    const folder = new Tracker.Store({ samples })
    const control = new Tracker.Store({ samples })
    folder.observe(sessionEvent("session.created", { sessionID: "ses_import", model: SOL, metadata: IMPORTED }), 0)
    folder.observe(
      sessionEvent("session.step.started", {
        sessionID: "ses_import",
        assistantMessageID: "msg_i",
        model: SOL,
        started: 0,
      }),
      0,
    )
    folder.observe(
      sessionEvent("session.step.ended", {
        sessionID: "ses_import",
        assistantMessageID: "msg_i",
        tokens: { input: 150_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      0,
    )
    // The imported session left the slot unmeasured everywhere (IG7).
    expect(control.slotMeasure(SLOT).zSource).toBe("default")
    folder.observe(sessionEvent("session.created", { sessionID: "ses_root", model: SOL }), 0)
    folder.observe(
      sessionEvent("session.step.started", {
        sessionID: "ses_root",
        assistantMessageID: "msg_r",
        model: SOL,
        started: 0,
      }),
      0,
    )
    folder.observe(
      sessionEvent("session.step.ended", {
        sessionID: "ses_root",
        assistantMessageID: "msg_r",
        tokens: { input: 14_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      0,
    )
    expect(control.slotMeasure(SLOT)).toEqual({ Z: 14_000, zSource: "measured", exchange: Tracker.DEFAULTS.delta })
    // Only the samples are shared: the control Location's tracker knows nothing of the folder's sessions.
    expect(control.get("ses_root")).toBeUndefined()
  })
})

describe("the helper's compaction usage reaches the account ledger (09 §4.4)", () => {
  test("a compaction line on the summarizing slot's account, as for any session", async () => {
    await using t = await setup()
    const directory = t.deps.location.directory
    const at = t.clock.now()
    const model = { providerID: CODEX, id: "gpt-5.5" }
    await t.telemetry.onEvent?.(
      event({
        type: "session.created",
        at,
        directory,
        data: {
          sessionID: SESSION,
          projectID: "prj_fixture",
          location: { directory },
          slug: "helper",
          model,
          metadata: HELPER,
          version: "2",
        },
      }),
      { local: true },
    )
    await t.telemetry.onEvent?.(
      event({
        type: "session.compaction.ended",
        at: at + 5_000,
        directory,
        data: {
          sessionID: SESSION,
          reason: "manual",
          model,
          text: "summary",
          recent: "",
          cost: 0,
          tokens: { input: 40_000, output: 3_000, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
      { local: true },
    )
    await t.telemetry.flush()
    const ledger = await ok(t.telemetry.ledgerSession, { sessionID: SESSION })
    expect(ledger.steps).toEqual([
      expect.objectContaining({
        kind: "compaction",
        accountID: CODEX_ACCOUNT,
        providerID: CODEX,
        tokens: expect.objectContaining({ input: 40_000, output: 3_000 }),
      }),
    ])
  })
})
