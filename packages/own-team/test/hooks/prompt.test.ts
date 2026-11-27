// The session `prompt` hook (06 §5.4): a root session's user input in an area folder records `area.direct`; main
// requests, machine sources (own.accounts, own.team), children and the main folder record nothing, and the prompt
// itself is never changed. The record runs detached, so the hook never waits for the self-HTTP lookup or for the
// controller lock. 직접 작업 (2026-11-14): with `directHold` on, the owner conversation's user message starts or moves the
// area's direct work unless the owner serves a main request; a peer, a third conversation and a team without the hold
// keep only the mark; a user message in the main conversation is remembered before the detached record. The own
// service is a fake HTTP server on 127.0.0.1.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { SessionPrompt } from "@opencode/plugin/promise/session"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { OwnTeam } from "@own/protocol"
import { Direct } from "../../src/dispatch/direct.js"
import { MsgID } from "../../src/dispatch/msg-id.js"
import { PromptHook } from "../../src/hooks/prompt.js"
import { Digest } from "../../src/report/digest.js"
import { Fold } from "../../src/report/fold.js"
import { RoleInstructions } from "../../src/sessions/instructions.js"
import { manual } from "../support/clock.js"
import { MAIN_SESSION, OLD_OWNER, OWNER_SESSION, TEAM_ID, World, area, controller, team } from "../support/context.js"
import { session, start } from "../support/service.js"
import { temp } from "../fixtures/repo.js"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const UI = OwnTeam.AreaID.make("ar_ui")
const USER = SessionID.make("ses_user0000000000000000000001")
const CHILD = SessionID.make("ses_child000000000000000000001")
const NESTED = SessionID.make("ses_user0000000000000000000002")
const PEER = SessionID.make("ses_peer0000000000000000000001")

async function setup(state: "on" | "off" = "on", options: { readonly hold?: boolean } = {}) {
  const box = temp("own-team-prompt-")
  cleanups.push(() => box.dispose())
  const home = path.join(box.root, "home")
  const folder = path.join(box.root, "home-team", "ui")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(folder, "src"), { recursive: true })
  const service = start()
  cleanups.push(() => service.stop())
  const sessions: Array<{ id: string; directory: string; parentID?: string }> = [
    { id: OWNER_SESSION, directory: folder },
    { id: OLD_OWNER, directory: folder },
    { id: USER, directory: folder },
    { id: NESTED, directory: path.join(folder, "src") },
    { id: CHILD, directory: folder, parentID: OWNER_SESSION },
    { id: MAIN_SESSION, directory: home },
    { id: PEER, directory: folder },
  ]
  for (const item of sessions)
    service.routes.set(`GET /api/session/${item.id}`, () => Response.json({ data: session(item) }))
  const clock = manual()
  const h = controller(new World(), { directory: home, clock, source: service.source })
  cleanups.push(() => h.close())
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put(team({ home, state, directHold: options.hold ?? false }))
    await h.services.registry.areas.put({
      ...area({ slug: "ui", directory: folder }),
      peers: [{ key: "p1", label: "검토", role: "", attached: true, sessionID: PEER, origin: "registered", at: 1 }],
    })
  })
  const hook = PromptHook.create(h.services)
  const prompt = (sessionID: SessionID, metadata?: Record<string, unknown>): SessionPrompt => ({
    sessionID,
    messageID: SessionMessage.ID.make("msg_prompt"),
    prompt: { text: "사용자가 쓴 글" },
    ...(metadata === undefined ? {} : { metadata }),
    delivery: "steer",
  })
  const direct = async () => (await h.services.registry.areas.get(TEAM_ID, UI))?.direct
  /** Waits until the detached record shows `expected`. */
  const recorded = async (expected: unknown) => {
    for (let tries = 0; tries < 200 && !Bun.deepEquals(await direct(), expected); tries++) await Bun.sleep(10)
    expect<unknown>(await direct()).toEqual(expected)
  }
  const stored = async () => h.services.registry.areas.get(TEAM_ID, UI)
  return { ...h, service, clock, hook, prompt, direct, recorded, stored }
}

describe("direct user talk (5.4)", () => {
  test("the owner, a previous owner and any conversation of the area folder record it; the prompt is unchanged", async () => {
    const h = await setup()
    for (const sessionID of [OWNER_SESSION, OLD_OWNER, USER, NESTED]) {
      h.clock.advance(1_000)
      const input = h.prompt(sessionID, { client: "own-web" })
      const before = structuredClone(input)
      await h.hook(input)
      expect(input).toEqual(before)
      await h.recorded({ at: h.clock.now(), sessionID })
    }
    const changed = h.published.filter((item) => item.name === "area.changed")
    expect(changed).toHaveLength(4)
    expect(changed[0]!.data).toMatchObject({ teamID: TEAM_ID, areaID: UI, paused: false })
  })

  test("main requests, own.accounts and own.team prompts, children and the main folder record nothing", async () => {
    const h = await setup()
    const machine = [
      h.prompt(OWNER_SESSION, { "own.dispatch": { id: "dp_x" }, source: "own.team" }),
      h.prompt(OWNER_SESSION, { "own.dispatch": { id: "dp_x" } }),
      h.prompt(OWNER_SESSION, { source: "own.accounts" }),
      h.prompt(OWNER_SESSION, { source: "own.team" }),
    ]
    for (const input of machine) {
      const before = structuredClone(input)
      await h.hook(input)
      expect(input).toEqual(before)
    }
    // Machine prompts are not even looked up.
    expect(h.service.requests.filter((request) => request.path === `/api/session/${OWNER_SESSION}`)).toEqual([])
    for (const sessionID of [CHILD, MAIN_SESSION]) await PromptHook.record(h.services, sessionID)
    expect(await h.direct()).toBeUndefined()
    expect(h.published).toEqual([])
  })

  test("a team that is off records nothing; an unknown session is skipped without throwing", async () => {
    const off = await setup("off")
    await PromptHook.record(off.services, USER)
    expect(await off.direct()).toBeUndefined()
    const h = await setup()
    await PromptHook.record(h.services, SessionID.make("ses_gone0000000000000000000001"))
    expect(await h.direct()).toBeUndefined()
  })

  test("the hook never holds the admission: a controller that never gets its lock still lets the prompt in", async () => {
    const h = await setup()
    // `services.write` waits for the controller lock (a reused pid, an old build lingering): here it never comes.
    const stuck = { ...h.services, write: () => new Promise<never>(() => {}) }
    await PromptHook.create(stuck)(h.prompt(USER))
    // The lookup still happens on its own, and nothing is recorded while the write waits.
    const lookups = () => h.service.requests.filter((request) => request.path === `/api/session/${USER}`)
    for (let tries = 0; tries < 200 && lookups().length === 0; tries++) await Bun.sleep(10)
    expect(lookups()).toHaveLength(1)
    expect(await h.direct()).toBeUndefined()
  })
})

describe("the role text where the user writes (06 §6.2, 2026-10-16)", () => {
  test("a user prompt in the owner conversation brings its role up to date once per controller; others do not", async () => {
    const h = await setup()
    const entries = `/api/experimental/session/${OWNER_SESSION}/instructions/entries`
    const stored: Array<{ key: string; value: unknown }> = [{ key: RoleInstructions.OWNER, value: "옛 역할" }]
    h.service.routes.set(`GET ${entries}`, () => Response.json({ data: stored }))
    h.service.routes.set(`PUT ${entries}/${RoleInstructions.OWNER}`, () => new Response(null, { status: 204 }))
    const puts = () =>
      h.service.requests.filter((request) => request.method === "PUT" && request.path.startsWith(entries))
    await PromptHook.record(h.services, USER)
    await PromptHook.record(h.services, OLD_OWNER)
    // No area conversation's instructions were read (the main's own resume writes the main's at the home).
    expect(
      h.service.requests.filter(
        (request) => request.path.includes("/instructions/") && !request.path.includes(MAIN_SESSION),
      ),
    ).toEqual([])
    await PromptHook.record(h.services, OWNER_SESSION)
    expect(puts()).toHaveLength(1)
    expect(JSON.stringify(puts()[0]?.body)).toContain('team_report(kind:\\"relay\\"')
    await PromptHook.record(h.services, OWNER_SESSION)
    expect(puts()).toHaveLength(1)
  })
})

describe("direct work (2026-11-14)", () => {
  test("the owner's message on an idle owner starts it; the next one moves only `at`, one area.changed each", async () => {
    const h = await setup("on", { hold: true })
    h.clock.advance(1_000)
    const since = h.clock.now()
    await PromptHook.record(h.services, OWNER_SESSION)
    expect(await h.stored()).toMatchObject({
      direct: { at: since, sessionID: OWNER_SESSION },
      directWork: { since, at: since },
    })
    h.clock.advance(5_000)
    await PromptHook.record(h.services, OWNER_SESSION)
    expect((await h.stored())?.directWork).toEqual({ since, at: h.clock.now() })
    expect(h.published.filter((item) => item.name === "area.changed")).toHaveLength(2)
  })

  test("an owner serving a main request (queued, or received and unanswered) is steered: no direct work", async () => {
    const queued = await setup("on", { hold: true })
    const dispatchID = OwnTeam.DispatchID.create()
    const fold = (change: (fold: Fold.AreaFold) => Fold.AreaFold) => Fold.withArea(Fold.empty(TEAM_ID), UI, change)
    await queued.services.write(TEAM_ID, () =>
      Digest.save(
        queued.services.kv,
        fold((item) => ({ ...item, queued: { msg_q: dispatchID } })),
      ),
    )
    await PromptHook.record(queued.services, OWNER_SESSION)
    expect(await queued.stored()).toMatchObject({ direct: { sessionID: OWNER_SESSION } })
    expect((await queued.stored())?.directWork).toBeUndefined()

    const received = await setup("on", { hold: true })
    await received.services.write(TEAM_ID, () =>
      Digest.save(
        received.services.kv,
        fold((item) => ({ ...item, received: { dispatchID, at: 1 } })),
      ),
    )
    await PromptHook.record(received.services, OWNER_SESSION)
    expect((await received.stored())?.directWork).toBeUndefined()
    // Its run ended (`ended`): the owner no longer serves it, so the next message starts direct work.
    await received.services.write(TEAM_ID, () =>
      Digest.save(
        received.services.kv,
        fold((item) => ({ ...item, received: { dispatchID, at: 1 }, ended: dispatchID })),
      ),
    )
    await PromptHook.record(received.services, OWNER_SESSION)
    expect((await received.stored())?.directWork).toBeDefined()
  })

  test("a request sent to the owner and not folded yet counts as served for a minute", async () => {
    const h = await setup("on", { hold: true })
    const dispatchID = OwnTeam.DispatchID.create()
    await h.services.write(TEAM_ID, () =>
      h.services.registry.dispatches.put({
        id: dispatchID,
        teamID: TEAM_ID,
        areaID: UI,
        seq: 0,
        from: "main",
        kind: "task",
        text: "일",
        state: "sent",
        sentTo: { sessionID: OWNER_SESSION, msgID: MsgID.dispatch(dispatchID, OWNER_SESSION), at: h.clock.now() },
        createdAt: h.clock.now(),
      }),
    )
    h.clock.advance(Direct.FOLD_LAG_MS - 1)
    await PromptHook.record(h.services, OWNER_SESSION)
    expect((await h.stored())?.directWork).toBeUndefined()
    // A cancelled inbox item leaves the request `sent`: after the bound it no longer counts.
    h.clock.advance(1)
    await PromptHook.record(h.services, OWNER_SESSION)
    expect((await h.stored())?.directWork).toEqual({ since: h.clock.now(), at: h.clock.now() })
  })

  test("a peer, a third conversation of the folder and a team without the hold keep only the mark", async () => {
    const h = await setup("on", { hold: true })
    await PromptHook.record(h.services, PEER)
    expect((await h.stored())?.peers?.[0]?.direct).toEqual({ at: h.clock.now() })
    await PromptHook.record(h.services, USER)
    expect(await h.stored()).toMatchObject({ direct: { sessionID: USER } })
    expect((await h.stored())?.directWork).toBeUndefined()

    const off = await setup("on", { hold: false })
    await PromptHook.record(off.services, OWNER_SESSION)
    expect(await off.stored()).toMatchObject({ direct: { sessionID: OWNER_SESSION } })
    expect((await off.stored())?.directWork).toBeUndefined()
  })

  test("the user's message in the main conversation is remembered before the detached record; a machine's is not", async () => {
    const h = await setup("on", { hold: true })
    // The record waits for the controller lock forever: `spoke` is written before it anyway.
    const stuck = { ...h.services, write: () => new Promise<never>(() => {}) }
    const hook = PromptHook.create(stuck)
    h.clock.advance(2_000)
    await hook(h.prompt(MAIN_SESSION, { source: "own.team" }))
    expect(h.services.features().direct.spoke(TEAM_ID)).toBe(0)
    await hook(h.prompt(MAIN_SESSION, { client: "own-web" }))
    const said = h.clock.now()
    expect(h.services.features().direct.spoke(TEAM_ID)).toBe(said)
    // An area conversation is not the main's.
    h.clock.advance(2_000)
    await hook(h.prompt(OWNER_SESSION))
    expect(h.services.features().direct.spoke(TEAM_ID)).toBe(said)
  })
})
