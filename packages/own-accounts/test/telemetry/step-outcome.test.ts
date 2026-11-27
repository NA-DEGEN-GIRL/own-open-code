import { describe, expect, test } from "bun:test"
import { Home } from "@own/runtime"
import { Telemetry } from "../../src/telemetry/telemetry.js"
import {
  CODEX,
  DEFAULT_SEEDS,
  DS,
  OTHER_SESSION,
  SESSION,
  event,
  httpEvent,
  registry,
  setup,
  tokens,
  type Usage,
} from "./support.js"

// P2-16: `output_truncated` (finish `length`) and `empty_completion` (finish `stop`, no visible output) on own slots.

type Setup = Awaited<ReturnType<typeof setup>>

/** Without the DeepSeek balance poll: these tests move the clock past its tick and must not reach a real endpoint. */
const offline = () => setup({ registry: registry(DEFAULT_SEEDS.map((seed) => ({ ...seed, pollBalance: false }))) })

/** `session.step.started` + `session.step.ended` with an explicit finish reason. */
async function finished(
  t: Setup,
  input: {
    readonly finish: string
    readonly messageID: string
    readonly usage: Usage
    readonly providerID?: string
    readonly modelID?: string
    readonly sessionID?: string
  },
) {
  const directory = t.deps.location.directory
  const at = t.clock.now()
  const sessionID = input.sessionID ?? SESSION
  const model = { providerID: input.providerID ?? DS, id: input.modelID ?? "deepseek-v4-pro" }
  await t.telemetry.onEvent?.(
    event({
      type: "session.step.started",
      at,
      directory,
      data: { sessionID, assistantMessageID: input.messageID, agent: "build", model, started: at },
    }),
    { local: true },
  )
  await t.telemetry.onEvent?.(
    event({
      type: "session.step.ended",
      at: at + 1_000,
      directory,
      data: {
        sessionID,
        assistantMessageID: input.messageID,
        finish: input.finish,
        cost: 0,
        tokens: tokens(input.usage),
      },
    }),
    { local: true },
  )
  await t.telemetry.flush()
}

function outcomes(t: Setup) {
  return t
    .emitted("alert")
    .filter((item) => item.data.code === "output_truncated" || item.data.code === "empty_completion")
    .map((item) => [item.data.code, item.data.severity, item.data.sessionID, item.data.origin])
}

describe("step outcome alerts", () => {
  test("finish length raises output_truncated with the model in the events.jsonl line", async () => {
    await using t = await offline()
    await finished(t, { finish: "length", messageID: "m1", usage: { input: 4_000, output: 8_192 } })
    expect(outcomes(t)).toEqual([["output_truncated", "info", SESSION, "session"]])
    expect(String(t.emitted("alert")[0].data.message)).toContain(`${DS}/deepseek-v4-pro`)
    // The RPC event keeps its schema; the fields live in the ledger line only.
    expect("fields" in t.emitted("alert")[0].data).toBe(false)
    await t.deps.runtime.ledger.flush()
    const lines = await t.deps.runtime.ledger.eventsOf(Home.month(t.clock.now()))
    expect(lines.filter((line) => line.type === "alert")).toEqual([
      expect.objectContaining({
        sessionID: SESSION,
        data: expect.objectContaining({
          code: "output_truncated",
          severity: "info",
          fields: { providerID: DS, modelID: "deepseek-v4-pro", finish: "length" },
        }),
      }),
    ])
  })

  test("finish stop with zero visible output raises empty_completion even when the model reasoned", async () => {
    await using t = await offline()
    await finished(t, { finish: "stop", messageID: "m1", usage: { input: 4_000, output: 0, reasoning: 900 } })
    expect(outcomes(t)).toEqual([["empty_completion", "info", SESSION, "session"]])
    await t.deps.runtime.ledger.flush()
    const lines = await t.deps.runtime.ledger.eventsOf(Home.month(t.clock.now()))
    expect(lines.find((line) => line.type === "alert")?.data).toMatchObject({
      code: "empty_completion",
      fields: { providerID: DS, modelID: "deepseek-v4-pro", finish: "stop" },
    })
  })

  test("normal answers, tool calls and steps without reported usage raise nothing", async () => {
    await using t = await offline()
    await finished(t, { finish: "stop", messageID: "m1", usage: { input: 4_000, output: 120 } })
    await finished(t, { finish: "tool-calls", messageID: "m2", usage: { input: 4_000, output: 0 } })
    // All-zero usage: the provider reported none, which is not an empty answer.
    await finished(t, { finish: "stop", messageID: "m3", usage: { input: 0, output: 0 } })
    expect(outcomes(t)).toEqual([])
  })

  test("only own slots: a step on a provider that is not an own slot raises nothing", async () => {
    await using t = await offline()
    await finished(t, { finish: "length", messageID: "m1", providerID: "openai", usage: { input: 4_000 } })
    await finished(t, { finish: "stop", messageID: "m2", providerID: "anthropic", usage: { input: 4_000, output: 0 } })
    expect(outcomes(t)).toEqual([])
  })

  test("de-duplicated per session and code within the alert window", async () => {
    await using t = await offline()
    await finished(t, { finish: "length", messageID: "m1", usage: { input: 4_000 } })
    t.clock.advance(60_000)
    // Another slot of the same session still counts as the same (session, code).
    await finished(t, {
      finish: "length",
      messageID: "m2",
      providerID: CODEX,
      modelID: "gpt-5.5",
      usage: { input: 4_000 },
    })
    await finished(t, { finish: "stop", messageID: "m3", usage: { input: 4_000, output: 0 } })
    await finished(t, { finish: "length", messageID: "m4", sessionID: OTHER_SESSION, usage: { input: 4_000 } })
    expect(outcomes(t)).toEqual([
      ["output_truncated", "info", SESSION, "session"],
      ["empty_completion", "info", SESSION, "session"],
      ["output_truncated", "info", OTHER_SESSION, "session"],
    ])
    t.clock.advance(Telemetry.ALERT_DEDUPE_MS)
    await finished(t, { finish: "length", messageID: "m5", usage: { input: 4_000 } })
    expect(outcomes(t).at(-1)).toEqual(["output_truncated", "info", SESSION, "session"])
    expect(outcomes(t)).toHaveLength(4)
  })

  test("never for compaction or generate requests", async () => {
    await using t = await offline()
    const directory = t.deps.location.directory
    await t.telemetry.onEvent?.(
      event({
        type: "session.compaction.ended",
        at: t.clock.now(),
        directory,
        data: {
          sessionID: SESSION,
          reason: "auto",
          model: { providerID: DS, id: "deepseek-v4-pro" },
          text: "",
          recent: "",
          cost: 0,
          tokens: { input: 9_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
      { local: true },
    )
    const empty = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":900,"output_tokens":0}}}\n\n'
    await t.telemetry.onHttpResponse(httpEvent({ providerID: CODEX, kind: "generate", response: new Response(empty) }))
    await t.telemetry.flush()
    expect(outcomes(t)).toEqual([])
  })

  test("a replayed step event (same id, already in the ledger) raises nothing again", async () => {
    await using t = await offline()
    const directory = t.deps.location.directory
    const at = t.clock.now()
    const ended = event({
      type: "session.step.ended",
      at,
      directory,
      data: {
        sessionID: SESSION,
        assistantMessageID: "m1",
        finish: "length",
        cost: 0,
        tokens: tokens({ input: 4_000 }),
      },
    })
    await t.telemetry.onEvent?.(
      event({
        type: "session.step.started",
        at,
        directory,
        data: {
          sessionID: SESSION,
          assistantMessageID: "m1",
          agent: "build",
          model: { providerID: DS, id: "deepseek-v4-pro" },
          started: at,
        },
      }),
      { local: true },
    )
    await t.telemetry.onEvent?.(ended, { local: true })
    await t.telemetry.flush()
    t.clock.advance(Telemetry.ALERT_DEDUPE_MS)
    await t.telemetry.onEvent?.(ended, { local: true })
    await t.telemetry.flush()
    expect(outcomes(t)).toEqual([["output_truncated", "info", SESSION, "session"]])
  })
})
