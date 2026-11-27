// Subagents and the desktop through the registered tools: with `policy.allowSubagents` a child may drive the desktop
// only on its root's main model (07 §2.4 target `rel:"main"`), read through the parent chain; anything it cannot
// tell refuses. Fake sessions and models only; nothing here reaches a server.
import { afterEach, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import type { Tool } from "@opencode/schema/tool"
import { Cause, Effect, Exit } from "effect"
import { Audit } from "../../src/core/audit.js"
import { CHILD, context, harness, MAIN, ON, SESSION, type Harness } from "./support.js"

const GRANDCHILD = SessionID.make("ses_computer_use_test_grandchild")
const LOCAL = { providerID: "ollama", id: "qwen3" }

const open: Array<Harness> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})

async function setup(allowSubagents = true) {
  const value = await harness({ options: { policy: { allowSubagents } } })
  open.push(value)
  return value
}

describe("children on the root's main model", () => {
  test("a child on the root's provider and model drives the desktop; the effort (variant) may differ", async () => {
    const env = await setup()
    // Core's Model.Ref: the variant (effort) is not part of the comparison.
    const lighterEffort = { ...MAIN, variant: "low" }
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, model: lighterEffort })
    await env.ok("screenshot", {}, CHILD)
    await env.ok("left_click", { coordinate: [200, 200] }, CHILD)
    expect(env.driver.ops().some((op) => op.op === "button")).toBe(true)
  })

  test("a child pinned to another account, provider or a lighter model is refused before the driver", async () => {
    const env = await setup()
    const pinned = [
      { providerID: "own-codex-cx02", id: MAIN.id },
      { providerID: "anthropic", id: "claude-sonnet-5" },
      LOCAL,
      { providerID: MAIN.providerID, id: "gpt-6-luna" },
    ]
    for (const model of pinned) {
      env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, model })
      const message = await env.error("left_click", { coordinate: [200, 200] }, CHILD)
      expect(message).toStartWith(
        "[computer.subagent_model] This subagent does not run on the main conversation's model.",
      )
      expect(message).toContain("Do not retry")
      expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.subagent_model]")
    }
    expect(env.driver.ops()).toEqual([])
    const entries = await Effect.runPromise(Audit.list(`${env.home}/audit`, { limit: 1 }))
    expect(entries.map((entry) => [entry.sessionID, entry.outcome, entry.code])).toEqual([
      [CHILD, "denied", "subagent_model"],
    ])
  })

  test("the root's model decides at any depth, read through the parent chain", async () => {
    const env = await setup()
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON })
    env.sessions.set(GRANDCHILD, { parentID: CHILD, permissions: ON })
    await env.ok("screenshot", {}, GRANDCHILD)
    // The middle session's model does not count, only the root's.
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, model: LOCAL })
    await env.ok("screenshot", {}, GRANDCHILD)
    // The main conversation moved to another account: its children no longer match.
    env.sessions.set(SESSION, { permissions: ON, model: { providerID: "own-codex-cx02", id: MAIN.id } })
    expect(await env.error("screenshot", {}, GRANDCHILD)).toStartWith("[computer.subagent_model]")
  })

  test("a read-only role (explore, own-review) is refused even on the main model with the copied consent", async () => {
    const env = await setup()
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, model: MAIN })
    for (const agent of ["explore", "own-review"]) {
      const tool = env.tools.get("screenshot")
      if (tool === undefined) throw new Error("no screenshot tool")
      const exit = await Effect.runPromiseExit(
        tool.execute({}, { ...context(CHILD, `call_${agent}`), agent: agent as Tool.Context["agent"] }),
      )
      expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "ok").toContain(
        "[computer.subagent] This subagent role is read-only and may not use the computer",
      )
    }
    await env.ok("screenshot", {}, CHILD)
    expect(env.driver.ops().filter((op) => op.op === "capture")).toHaveLength(1)
  })

  test("allowSubagents off keeps the plain subagent refusal", async () => {
    const env = await setup(false)
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.subagent] Subagents cannot use")
  })

  test("fails closed: an unreadable root, or a model either side does not record", async () => {
    const env = await setup()
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON })
    env.sessions.delete(SESSION)
    expect(await env.error("screenshot", {}, CHILD)).toStartWith(
      "[computer.subagent_model] The main conversation cannot be read.",
    )
    env.sessions.set(SESSION, { permissions: ON, model: undefined })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith(
      "[computer.subagent_model] The model of this subagent or of the main conversation is not known.",
    )
    env.sessions.set(SESSION, { permissions: ON })
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, model: undefined })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.subagent_model]")
    expect(env.driver.ops()).toEqual([])
  })

  test("the child's own consent and the kill switch are checked first", async () => {
    const env = await setup()
    env.sessions.set(CHILD, { parentID: SESSION, model: LOCAL })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.not_enabled]")
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, model: LOCAL })
    await Effect.runPromise(env.desktop.engage("rpc"))
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.stopped]")
  })
})
