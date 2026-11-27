// Voice plans and their approval (06 §2.9, user decision V-D1): a plan changes nothing and answers a token; the token
// runs the plan once, only in the turn the first user message after the plan's turn opened. A reply in the plan's own
// turn (steered in), synthetic messages, main requests and machine prompts never count; an idle after the reply ends
// the approval; a device's reply approves only what its button scopes allow and never a `local` action; the plan
// expires with the earlier of 10 minutes and a wrapped nonce; one live plan per session; message reads that fail stay
// closed; two calls at once run it once; no reply carries an inner nonce. `backed` (2026-11-14) says whether the user
// wrote into the current run, from a device that holds the scope. The session's messages come from a fake
// own service on 127.0.0.1 (`GET /api/session/:id/message`); the clock is manual; fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import { OwnTeam } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { PromptHook } from "../../src/hooks/prompt.js"
import { Confirm } from "../../src/ops/confirm.js"
import type { MainTools } from "../../src/tools/main.js"
import { VoicePlan } from "../../src/tools/voice.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OWNER_SESSION, World, controller } from "../support/context.js"
import { start, type FakeService } from "../support/service.js"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const HOME = "C:\\fake\\home"
const MAIN = { sessionID: MAIN_SESSION, directory: HOME }
const OWNER = { sessionID: OWNER_SESSION, directory: HOME }
/** An inner nonce a plan may wrap (a step confirm's, a push's): never in a reply. */
const INNER = "INNERNONCE0123456789ABCDEFGH"

type Message = Readonly<Record<string, unknown>>

/** A session's messages, oldest first, as the fake service pages them (newest first, `limit`). */
class Log {
  readonly items: Message[] = []
  #next = 0
  fail = false

  constructor(service: FakeService, sessionID: string) {
    service.routes.set(`GET /api/session/${sessionID}/message`, (request) => {
      if (this.fail) return Response.json({ _tag: "Unavailable", message: "down" }, { status: 503 })
      const limit = Number(request.query.limit ?? "50")
      const page = request.query.order === "asc" ? [...this.items] : this.items.toReversed()
      return Response.json({ data: page.slice(0, limit), cursor: {} })
    })
  }

  add(type: string, metadata?: Readonly<Record<string, unknown>>) {
    const id = `msg_${String(++this.#next).padStart(26, "0")}`
    this.items.push({ id, type, time: { created: this.#next }, ...(metadata === undefined ? {} : { metadata }) })
    return id
  }

  user(metadata?: Readonly<Record<string, unknown>>) {
    return this.add("user", metadata)
  }

  /** The assistant message of a step (what the newest message is while a tool runs). */
  step() {
    return this.add("assistant")
  }

  idle() {
    return this.add("idle")
  }
}

async function setup() {
  const service = start()
  cleanups.push(() => service.stop())
  const clock = manual()
  const h = controller(new World(), { directory: HOME, clock, source: service.source })
  cleanups.push(() => h.close())
  const main = new Log(service, MAIN_SESSION)
  const owner = new Log(service, OWNER_SESSION)
  const runs: string[] = []
  const issue = (input: Partial<VoicePlan.Issue> & { readonly caller?: VoicePlan.Caller } = {}) =>
    VoicePlan.issue(h.services, input.caller ?? MAIN, {
      tool: "control",
      action: "disable",
      method: "disable",
      text: "팀 모드를 끕니다.",
      run: async (): Promise<MainTools.Reply> => {
        runs.push(input.action ?? "disable")
        return { ok: true, text: "껐습니다." }
      },
      ...input,
    })
  const redeem = (token: unknown, input: { readonly tool?: string; readonly action?: string; caller?: VoicePlan.Caller } = {}) =>
    VoicePlan.redeem(h.services, input.caller ?? MAIN, {
      tool: input.tool ?? "control",
      action: input.action ?? "disable",
      token: String(token),
    })
  return { service, clock, h, main, owner, runs, issue, redeem }
}

/** A plan made while the turn of `[user]` runs: the user's request and the step that calls the tool. */
async function planned(s: Awaited<ReturnType<typeof setup>>, input: Parameters<typeof s.issue>[0] = {}) {
  s.main.user()
  s.main.step()
  const reply = await s.issue(input)
  expect(reply).toMatchObject({ ok: true, plan: true })
  return reply
}

describe("approval: the first user message after the plan's turn ended", () => {
  test("in the plan's own turn it is refused and kept; after an idle and the user's reply it runs once", async () => {
    const s = await setup()
    const plan = await planned(s)
    expect(plan.text).toContain("팀 모드를 끕니다.")
    expect(plan.text).toContain(VoicePlan.ASK)
    expect(String(plan.token)).toMatch(/^[0-9A-Z]{24}$/)
    expect(await s.redeem(plan.token)).toEqual({ ok: false, error: "needs_user", text: VoicePlan.TEXT.needs_user })
    // The turn ends; nobody answered yet.
    s.main.step()
    s.main.idle()
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "needs_user" })
    expect(s.runs).toEqual([])
    // The user's answer opens the next turn: the token runs the plan once.
    s.main.user()
    s.main.step()
    expect(await s.redeem(plan.token)).toEqual({ ok: true, text: "껐습니다." })
    expect(s.runs).toEqual(["disable"])
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "plan_unknown" })
    expect(s.runs).toEqual(["disable"])
  })

  test("a reply steered into the plan's turn does not count; the next user message does", async () => {
    const s = await setup()
    const plan = await planned(s)
    s.main.user()
    s.main.step()
    s.main.idle()
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "needs_user" })
    s.main.user()
    expect(await s.redeem(plan.token)).toMatchObject({ ok: true })
  })

  test("synthetic messages, main requests and machine prompts are no reply; a real one after them is", async () => {
    const s = await setup()
    const plan = await planned(s)
    s.main.idle()
    s.main.add("synthetic")
    s.main.idle()
    s.main.user({ [OwnTeam.DISPATCH_META]: { id: "dp_x" } })
    s.main.user({ source: OwnTeam.PROMPT_SOURCE })
    s.main.user({ source: "own.accounts" })
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "needs_user" })
    s.main.user({ source: "own-web" })
    expect(await s.redeem(plan.token)).toMatchObject({ ok: true })
    expect(PromptHook.machine({ source: "own.team" })).toBe(true)
    expect(PromptHook.machine({ [OwnTeam.DISPATCH_META]: {} })).toBe(true)
    expect(PromptHook.machine({ source: "own-web" })).toBe(false)
    expect(PromptHook.machine(undefined)).toBe(false)
  })

  test("an idle after the reply ends the approval: a later turn cannot use it", async () => {
    const s = await setup()
    const plan = await planned(s)
    s.main.idle()
    s.main.user()
    s.main.step()
    s.main.idle()
    s.main.user()
    expect(await s.redeem(plan.token)).toEqual({ ok: false, error: "plan_stale", text: VoicePlan.TEXT.plan_stale })
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "plan_unknown" })
    expect(s.runs).toEqual([])
  })
})

describe("the reply's device stamp (05 §13.4)", () => {
  const stamp = (scopes: unknown) => ({ [OwnRemote.DEVICE_META]: { scopes } })

  test("an admin action: a default phone's reply is refused and the plan is gone; one with admin runs it", async () => {
    const s = await setup()
    const first = await planned(s)
    s.main.idle()
    s.main.user(stamp(["prompt", "read", "switch"]))
    expect(await s.redeem(first.token)).toEqual({ ok: false, error: "needs_pc", text: VoicePlan.needsPc("admin") })
    expect(await s.redeem(first.token)).toMatchObject({ ok: false, error: "plan_unknown" })

    const second = await planned(s)
    s.main.idle()
    s.main.user(stamp(["admin", "prompt", "read"]))
    expect(await s.redeem(second.token)).toMatchObject({ ok: true })
    expect(s.runs).toEqual(["disable"])
  })

  test("a local action is never approved from a device; a stamp that does not decode has no scopes; none is the PC", async () => {
    const s = await setup()
    const local = { tool: "control", action: "settings", method: "settings.set" as const }
    const device = await planned(s, local)
    s.main.idle()
    s.main.user(stamp(["admin", "files", "prompt", "read", "switch", "terminal"]))
    expect(await s.redeem(device.token, local)).toEqual({
      ok: false,
      error: "needs_pc",
      text: VoicePlan.needsPc("local"),
    })

    const broken = await planned(s)
    s.main.idle()
    s.main.user({ [OwnRemote.DEVICE_META]: "admin" })
    expect(await s.redeem(broken.token)).toMatchObject({ ok: false, error: "needs_pc" })

    const pc = await planned(s, local)
    s.main.idle()
    s.main.user({ "own.dictation": true })
    expect(await s.redeem(pc.token, local)).toMatchObject({ ok: true })
    expect(s.runs).toEqual(["settings"])
  })

  test("a prompt-scope action is approved from a default phone", async () => {
    const s = await setup()
    const resume = { tool: "control", action: "resume_all", method: "team.pause" as const }
    const plan = await planned(s, resume)
    s.main.idle()
    s.main.user(stamp(["prompt", "read", "switch"]))
    expect(await s.redeem(plan.token, resume)).toMatchObject({ ok: true })
  })
})

describe("plan records", () => {
  test("10 minutes, or the earlier end of a wrapped nonce", async () => {
    const s = await setup()
    const plan = await planned(s)
    expect(plan.expiresAt).toBe(s.clock.now() + Confirm.TTL_MS)
    s.main.idle()
    s.main.user()
    s.clock.advance(Confirm.TTL_MS)
    expect(await s.redeem(plan.token)).toEqual({ ok: false, error: "plan_expired", text: VoicePlan.TEXT.plan_expired })
    expect(await s.redeem(plan.token)).toMatchObject({ error: "plan_unknown" })

    const wrapped = await planned(s, { expiresAt: s.clock.now() + 60_000 })
    expect(wrapped.expiresAt).toBe(s.clock.now() + 60_000)
    s.main.idle()
    s.main.user()
    s.clock.advance(60_000)
    expect(await s.redeem(wrapped.token)).toMatchObject({ ok: false, error: "plan_expired" })
    expect(s.runs).toEqual([])
  })

  test("another tool or action is a mismatch and keeps the plan; the planned call still runs", async () => {
    const s = await setup()
    const plan = await planned(s)
    s.main.idle()
    s.main.user()
    expect(await s.redeem(plan.token, { action: "unadopt" })).toEqual({
      ok: false,
      error: "plan_mismatch",
      text: VoicePlan.TEXT.plan_mismatch,
    })
    expect(await s.redeem(plan.token, { tool: "area" })).toMatchObject({ error: "plan_mismatch" })
    expect(await s.redeem(plan.token)).toMatchObject({ ok: true })
  })

  test("a token of another session is unknown there", async () => {
    const s = await setup()
    const plan = await planned(s)
    s.main.idle()
    s.main.user()
    s.owner.user()
    expect(await s.redeem(plan.token, { caller: OWNER })).toMatchObject({ ok: false, error: "plan_unknown" })
    expect(await s.redeem(plan.token)).toMatchObject({ ok: true })
  })

  test("an anchor that is gone (reverted, past the window) ends the plan", async () => {
    const s = await setup()
    const plan = await planned(s)
    s.main.items.splice(0)
    s.main.idle()
    s.main.user()
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "plan_unknown" })
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "plan_unknown" })
    // More than the read window after the anchor: the same.
    const far = await planned(s)
    s.main.idle()
    Array.from({ length: VoicePlan.WINDOW }).forEach(() => s.main.add("synthetic"))
    s.main.user()
    expect(await s.redeem(far.token)).toMatchObject({ ok: false, error: "plan_unknown" })
    expect(s.runs).toEqual([])
  })

  test("messages that cannot be read: no plan is made, and a plan is not approved but kept", async () => {
    const s = await setup()
    s.main.fail = true
    expect(await s.issue()).toEqual({ ok: false, error: "plan_failed", text: VoicePlan.NO_ANCHOR })
    s.main.fail = false
    const plan = await planned(s)
    s.main.idle()
    s.main.user()
    s.main.fail = true
    expect(await s.redeem(plan.token)).toMatchObject({ ok: false, error: "needs_user" })
    s.main.fail = false
    expect(await s.redeem(plan.token)).toMatchObject({ ok: true })
  })

  test("a new plan replaces the session's plan and says so", async () => {
    const s = await setup()
    const first = await planned(s)
    expect(first.text).not.toContain(VoicePlan.REPLACED)
    const second = await planned(s, { action: "unadopt", method: "area.unadopt" })
    expect(second.text).toContain(VoicePlan.REPLACED)
    s.main.idle()
    s.main.user()
    expect(await s.redeem(first.token)).toMatchObject({ ok: false, error: "plan_unknown" })
    expect(await s.redeem(second.token, { action: "unadopt" })).toMatchObject({ ok: true })
    expect(s.runs).toEqual(["unadopt"])
  })

  test("two calls at once run it once", async () => {
    const s = await setup()
    const plan = await planned(s)
    s.main.idle()
    s.main.user()
    const answers = await Promise.all([s.redeem(plan.token), s.redeem(plan.token), s.redeem(plan.token)])
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1)
    expect(answers.filter((answer) => answer.error === "plan_unknown")).toHaveLength(2)
    expect(s.runs).toEqual(["disable"])
  })

  test("a run that fails used the token; no reply carries an inner nonce", async () => {
    const s = await setup()
    s.main.user()
    s.main.step()
    const plan = await s.issue({
      expiresAt: s.clock.now() + 5 * 60_000,
      run: async () => ({ ok: false, error: "busy", text: "팀에 다른 작업이 진행 중입니다." }),
    })
    const answers: MainTools.Reply[] = [plan, await s.redeem(plan.token)]
    s.main.idle()
    s.main.user()
    const failed = await s.redeem(plan.token)
    expect(failed).toEqual({ ok: false, error: "busy", text: `팀에 다른 작업이 진행 중입니다. ${VoicePlan.USED}` })
    answers.push(failed, await s.redeem(plan.token))
    for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(INNER)
  })
})

describe("backed: the user wrote into the current run (2026-11-14)", () => {
  const stamp = (scopes: unknown) => ({ [OwnRemote.DEVICE_META]: { scopes } })

  test("a run the user's message opened is ok; once it ended, the next one needs its own", async () => {
    const s = await setup()
    expect(await VoicePlan.backed(s.h.services, MAIN, "admin")).toBe("none")
    s.main.user()
    s.main.step()
    expect(await VoicePlan.backed(s.h.services, MAIN, "admin")).toBe("ok")
    s.main.idle()
    expect(await VoicePlan.backed(s.h.services, MAIN, "admin")).toBe("none")
    s.main.add("synthetic")
    s.main.step()
    expect(await VoicePlan.backed(s.h.services, MAIN, "admin")).toBe("none")
  })

  test("main requests, area messages and machine prompts are not the user; a user message steered in is", async () => {
    const s = await setup()
    s.owner.user({ [OwnTeam.DISPATCH_META]: { id: "dp_x" } })
    s.owner.step()
    s.owner.user({ source: OwnTeam.PROMPT_SOURCE })
    expect(await VoicePlan.backed(s.h.services, OWNER, "prompt")).toBe("none")
    s.owner.user({ source: "own-web" })
    expect(await VoicePlan.backed(s.h.services, OWNER, "prompt")).toBe("ok")
  })

  test("the device stamp of the user's message must hold the scope; the PC's own messages have none", async () => {
    const s = await setup()
    s.main.user(stamp(["prompt", "read", "switch"]))
    expect(await VoicePlan.backed(s.h.services, MAIN, "admin")).toBe("scope")
    expect(await VoicePlan.backed(s.h.services, MAIN, "prompt")).toBe("ok")
    s.main.idle()
    s.main.user(stamp(["admin", "prompt"]))
    expect(await VoicePlan.backed(s.h.services, MAIN, "admin")).toBe("ok")
    expect(await VoicePlan.backed(s.h.services, MAIN, "local")).toBe("scope")
    s.main.idle()
    s.main.user()
    expect(await VoicePlan.backed(s.h.services, MAIN, "local")).toBe("ok")
  })

  test("messages that cannot be read: none (the closed side)", async () => {
    const s = await setup()
    s.main.user()
    s.main.fail = true
    expect(await VoicePlan.backed(s.h.services, MAIN, "prompt")).toBe("none")
  })
})
