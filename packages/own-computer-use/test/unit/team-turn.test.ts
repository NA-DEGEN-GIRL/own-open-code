// Turns that own.team started never drive the desktop (06 §5.1, §5.6): the gate reads the session's messages since
// its latest compaction (fake `ctx.session.context`), and before it when the turn began earlier (fake
// `ctx.session.messages` pages), and refuses a turn holding a team message, also for every
// subagent of such a turn. The messages are minimal fakes of core's (`id`, `type`, `metadata`).
import { afterEach, describe, expect, test } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Effect } from "effect"
import type { Gate } from "../../src/gate.js"
import { CHILD, harness, ON, SESSION, STEP, type Harness } from "./support.js"

const GRANDCHILD = SessionID.make("ses_computer_use_test_grandchild")

const open: Array<Harness> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()))
})

async function setup(allowSubagents = false) {
  const value = await harness({ options: { policy: { allowSubagents } } })
  open.push(value)
  return value
}

const user = (id: string, metadata?: Gate.MessageView["metadata"]): Gate.MessageView => ({ id, type: "user", metadata })
const synthetic = (id: string, metadata: Gate.MessageView["metadata"]): Gate.MessageView => ({
  id,
  type: "synthetic",
  metadata,
})
const assistant = (id: string): Gate.MessageView => ({ id, type: "assistant" })
const idle = (id: string): Gate.MessageView => ({ id, type: "idle" })
const compaction = (id: string): Gate.MessageView => ({ id, type: "compaction" })

const TEAM = { source: OwnTeam.PROMPT_SOURCE }
const DISPATCH = {
  [OwnTeam.DISPATCH_META]: { id: "dp_x", from: "main", teamID: "tm_0123456789ab", areaID: "ar_x" },
}
const UPDATE = { [OwnTeam.UPDATE_META]: { seq: 4, reasons: ["ready"] } }

/** A finished direct turn, then the turn of the calling step ({@link STEP}) started by `first`. */
const turn = (first: Gate.MessageView): ReadonlyArray<Gate.MessageView> => [
  user("msg_01"),
  assistant("msg_02"),
  idle("msg_03"),
  first,
  assistant(STEP),
]

describe("turns started by own.team", () => {
  test("a team prompt, a main request or a team update starting the turn refuses every computer call", async () => {
    const env = await setup()
    for (const first of [user("msg_04", TEAM), user("msg_04", DISPATCH), synthetic("msg_04", { ...UPDATE, ...TEAM })]) {
      env.sessions.set(SESSION, { permissions: ON, messages: turn(first) })
      const message = await env.error("left_click", { coordinate: [200, 200] })
      expect(message).toStartWith("[computer.team_turn] Computer tools are never used in a turn that a team request")
      expect(message).toContain("Do not retry")
      expect(await env.error("screenshot")).toStartWith("[computer.team_turn]")
    }
    // A team update without the source marker is still the team's.
    env.sessions.set(SESSION, { permissions: ON, messages: turn(synthetic("msg_04", UPDATE)) })
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn]")
    expect(env.driver.ops()).toEqual([])
  })

  test("a direct user turn on the same session is admitted, also after a team turn", async () => {
    const env = await setup()
    env.sessions.set(SESSION, { permissions: ON, messages: turn(user("msg_04")) })
    await env.ok("screenshot")
    env.sessions.set(SESSION, {
      permissions: ON,
      messages: [user("msg_01", DISPATCH), assistant("msg_02"), idle("msg_03"), user("msg_04"), assistant(STEP)],
    })
    await env.ok("screenshot")
    await env.ok("left_click", { coordinate: [200, 200] })
  })

  test("the call's own step decides: an earlier step of a team turn is refused, a later direct turn is not", async () => {
    const env = await setup()
    env.sessions.set(SESSION, {
      permissions: ON,
      messages: [user("msg_01", TEAM), assistant("msg_02"), idle("msg_03"), user("msg_04"), assistant("msg_05")],
    })
    expect(await env.error("screenshot", {}, SESSION, "msg_02")).toStartWith("[computer.team_turn]")
    await env.ok("screenshot", {}, SESSION, "msg_05")
  })

  test("a team message delivered later in the same busy period, or steered in, refuses too", async () => {
    const env = await setup()
    // The user's request, then a queued team update delivered without the session going idle in between.
    env.sessions.set(SESSION, {
      permissions: ON,
      messages: [user("msg_01"), assistant("msg_02"), synthetic("msg_03", UPDATE), assistant(STEP)],
    })
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn]")
    // A team turn the user steered into stays the team's.
    env.sessions.set(SESSION, {
      permissions: ON,
      messages: [user("msg_01", DISPATCH), assistant("msg_02"), user("msg_03"), assistant(STEP)],
    })
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn]")
  })

  test("a step the messages do not hold falls back to the session's latest turn", async () => {
    const env = await setup()
    env.sessions.set(SESSION, {
      permissions: ON,
      messages: [user("msg_01"), assistant("msg_02"), user("msg_03", TEAM)],
    })
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn]")
    env.sessions.set(SESSION, { permissions: ON, messages: [user("msg_01", TEAM), idle("msg_02"), user("msg_03")] })
    await env.ok("screenshot")
  })

  test("fails closed when the messages cannot be read", async () => {
    const env = await setup()
    env.sessions.set(SESSION, { permissions: ON, messages: "unreadable" })
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn] The messages of this turn cannot be read.")
    // The next turn after a compaction is readable without looking further back; so is a session's first turn.
    env.sessions.set(SESSION, {
      permissions: ON,
      messages: [compaction("msg_c0"), assistant("msg_02"), idle("msg_03"), user("msg_04"), assistant(STEP)],
    })
    await env.ok("screenshot")
    env.sessions.set(SESSION, { permissions: ON, messages: [user("msg_01"), assistant(STEP)] })
    await env.ok("screenshot")
    expect(env.pages).toEqual([])
    expect(env.driver.ops()).toHaveLength(2)
  })
})

describe("a turn that began before the latest compaction", () => {
  test("the user's own long turn keeps working after a compaction lands in it, and is read back only once", async () => {
    const env = await setup()
    // 45 steps of this turn before the compaction: three pages back to the idle marker that started it.
    const steps = Array.from({ length: 45 }, (_, index) => assistant(`msg_s${index}`))
    env.sessions.set(SESSION, {
      permissions: ON,
      earlier: [user("msg_01", TEAM), assistant("msg_02"), idle("msg_03"), user("msg_04"), ...steps],
      messages: [compaction("msg_c1"), assistant(STEP)],
    })
    await env.ok("screenshot")
    await env.ok("left_click", { coordinate: [200, 200] })
    // Read once, newest first from the compaction, until the idle marker; the second call reads nothing.
    expect(env.pages.map((page) => page.before)).toEqual(["msg_c1", "msg_s25", "msg_s5"])
    expect(env.pages.every((page) => page.sessionID === SESSION && page.limit === 20)).toBe(true)
  })

  test("a turn the team started stays refused after the compaction", async () => {
    const env = await setup()
    for (const [index, first] of [user("msg_04", TEAM), synthetic("msg_04", UPDATE)].entries()) {
      env.sessions.set(SESSION, {
        permissions: ON,
        earlier: [user("msg_01"), idle("msg_03"), first, assistant("msg_05")],
        messages: [compaction(`msg_c2${index}`), assistant(STEP)],
      })
      expect(await env.error("screenshot")).toStartWith(
        "[computer.team_turn] Computer tools are never used in a turn that a team request",
      )
    }
    // A session whose first turn the team started, with no idle marker before it.
    env.sessions.set(SESSION, {
      permissions: ON,
      earlier: [user("msg_01", DISPATCH), assistant("msg_02")],
      messages: [compaction("msg_c22"), assistant(STEP)],
    })
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn]")
    // The session's first turn, the user's own: the start of the session ends the search.
    env.sessions.set(SESSION, {
      permissions: ON,
      earlier: [user("msg_01"), assistant("msg_02")],
      messages: [compaction("msg_c23"), assistant(STEP)],
    })
    await env.ok("screenshot")
    expect(env.driver.ops()).toHaveLength(1)
  })

  test("refuses when the start cannot be read or lies too far back, and asks again next time", async () => {
    const env = await setup()
    env.sessions.set(SESSION, {
      permissions: ON,
      earlier: "unreadable",
      messages: [compaction("msg_c3"), assistant(STEP)],
    })
    expect(await env.error("screenshot")).toStartWith(
      "[computer.team_turn] This turn began before the conversation was compacted, and its start cannot be read",
    )
    // Not remembered: once readable, the same compaction is read again.
    env.sessions.set(SESSION, {
      permissions: ON,
      earlier: [idle("msg_01"), user("msg_02")],
      messages: [compaction("msg_c3"), assistant(STEP)],
    })
    await env.ok("screenshot")
    // 25 full pages without an idle marker: given up on.
    const long = Array.from({ length: 25 * 20 + 1 }, (_, index) => assistant(`msg_l${index}`))
    env.sessions.set(SESSION, { permissions: ON, earlier: long, messages: [compaction("msg_c4"), assistant(STEP)] })
    const before = env.pages.length
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn] This turn began before the conversation")
    expect(env.pages.length - before).toBe(25)
  })

  test("a team message after the compaction refuses without reading back", async () => {
    const env = await setup()
    env.sessions.set(SESSION, {
      permissions: ON,
      earlier: [idle("msg_01"), user("msg_02")],
      messages: [compaction("msg_c5"), user("msg_06", TEAM), assistant(STEP)],
    })
    expect(await env.error("screenshot")).toStartWith("[computer.team_turn] Computer tools are never used")
    expect(env.pages).toEqual([])
  })
})

describe("checks before the turn", () => {
  test("the session's consent and the kill switch are still checked first", async () => {
    const env = await setup()
    env.sessions.set(SESSION, { permissions: [], messages: turn(user("msg_04", TEAM)) })
    expect(await env.error("screenshot")).toStartWith("[computer.not_enabled]")
    env.sessions.set(SESSION, { permissions: ON, messages: turn(user("msg_04", TEAM)) })
    await Effect.runPromise(env.desktop.engage("rpc"))
    expect(await env.error("screenshot")).toStartWith("[computer.stopped]")
  })
})

describe("subagents follow their root's latest turn", () => {
  test("a child at any depth of a root whose turn own.team started is refused, even on the main model", async () => {
    const env = await setup(true)
    env.sessions.set(SESSION, { permissions: ON, messages: turn(user("msg_04", DISPATCH)) })
    // The children's own prompts come from the subagent tool and carry nothing of the team's.
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, messages: [user("msg_11"), assistant(STEP)] })
    env.sessions.set(GRANDCHILD, { parentID: CHILD, permissions: ON, messages: [user("msg_21"), assistant(STEP)] })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.team_turn]")
    expect(await env.error("left_click", { coordinate: [200, 200] }, GRANDCHILD)).toStartWith("[computer.team_turn]")
    // A root that went idle after the team turn: a background child is still judged by that turn.
    env.sessions.set(SESSION, { permissions: ON, messages: [...turn(user("msg_04", DISPATCH)), idle("msg_06")] })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.team_turn]")
    expect(env.driver.ops()).toEqual([])
  })

  test("children of the user's own turns keep working; session metadata own.team alone never refuses", async () => {
    const env = await setup(true)
    const owner = { [OwnTeam.SESSION_META]: { role: "owner" } }
    env.sessions.set(SESSION, { permissions: ON, metadata: owner, messages: turn(user("msg_04")) })
    // Core copies the parent's metadata into the child.
    env.sessions.set(CHILD, { parentID: SESSION, permissions: ON, metadata: owner })
    await env.ok("screenshot")
    await env.ok("screenshot", {}, CHILD)
    // The root's next turn is the team's: the same child is refused from then on.
    env.sessions.set(SESSION, {
      permissions: ON,
      metadata: owner,
      messages: [...turn(user("msg_04")), idle("msg_06"), synthetic("msg_07", UPDATE), assistant("msg_08")],
    })
    expect(await env.error("screenshot", {}, CHILD)).toStartWith("[computer.team_turn]")
  })
})
