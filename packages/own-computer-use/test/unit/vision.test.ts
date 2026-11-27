// Computer use needs a model that sees images (01 §10.2, user decision 2026-10-18 "안 됨으로 두기"): on a text-only model
// (a local model without a projector, for instance) every computer call is refused before the driver with
// `[computer.no_vision]`, and nothing else stands in (no accessibility text, no helper model). A model whose input the
// model list cannot tell is not refused. Fake sessions and models only; nothing here reaches a server.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Audit } from "../../src/core/audit.js"
import { CHILD, harness, MAIN, ON, SESSION, type Harness } from "./support.js"

const TEXT_ONLY = { providerID: "own-compat-lc01", id: "qwen3:8b" }
const VISION = { providerID: "own-compat-lc01", id: "qwen2.5vl:7b" }

const open: Array<Harness> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})

async function setup(options: Record<string, unknown> = {}) {
  const value = await harness({ options })
  open.push(value)
  value.images.set(`${TEXT_ONLY.providerID}/${TEXT_ONLY.id}`, false)
  value.images.set(`${VISION.providerID}/${VISION.id}`, true)
  return value
}

describe("a model that cannot see images", () => {
  test("every computer call is refused before the driver, observing ones too, and audited as denied", async () => {
    const env = await setup()
    env.sessions.set(SESSION, { permissions: ON, model: TEXT_ONLY })
    const message = await env.error("screenshot")
    expect(message).toStartWith("[computer.no_vision] This conversation's model cannot see images")
    expect(message).toContain("Do not retry")
    expect(await env.error("left_click", { coordinate: [200, 200] })).toStartWith("[computer.no_vision]")
    expect(await env.error("list_windows")).toStartWith("[computer.no_vision]")
    expect(env.driver.ops()).toEqual([])
    const entries = await Effect.runPromise(Audit.list(`${env.home}/audit`, { limit: 1 }))
    expect(entries.map((entry) => [entry.sessionID, entry.outcome, entry.code])).toEqual([
      [SESSION, "denied", "no_vision"],
    ])
  })

  test("switching the conversation to a model that sees images makes the same session work again", async () => {
    const env = await setup()
    env.sessions.set(SESSION, { permissions: ON, model: TEXT_ONLY })
    expect(await env.error("screenshot")).toStartWith("[computer.no_vision]")
    env.sessions.set(SESSION, { permissions: ON, model: VISION })
    await env.ok("screenshot")
    await env.ok("left_click", { coordinate: [200, 200] })
    expect(env.driver.ops().some((op) => op.op === "button")).toBe(true)
  })

  test("consent comes first: a session without computer use on hears not_enabled, not no_vision", async () => {
    const env = await setup()
    env.sessions.set(SESSION, { permissions: [], model: TEXT_ONLY })
    expect(await env.error("screenshot")).toStartWith("[computer.not_enabled]")
  })

  test("a subagent on its text-only root's model is refused for the model, not let through", async () => {
    const env = await setup({ policy: { allowSubagents: true } })
    env.sessions.set(SESSION, { permissions: ON, model: TEXT_ONLY })
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, model: TEXT_ONLY })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.no_vision]")
  })

  test("a model the model list does not know is not refused", async () => {
    const env = await setup()
    env.images.set(`${MAIN.providerID}/${MAIN.id}`, "unknown")
    await env.ok("screenshot")
  })
})
