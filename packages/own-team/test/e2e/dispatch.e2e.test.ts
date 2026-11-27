// TG7 메인 요청과 메인 멈춤 on a real server (06 §11.3, §5.1–5.4, §5.7): a team of two areas on F1; the scripted main
// sends main requests (`team_dispatch`), the scripted owners run the directives inside them, and the test plays the
// user (direct input with either Enter behaviour, the stop button, another conversation in the area folder, Main 멈춤,
// 모두 멈추기, a kill and restart, 새 대화로 이어가기). Verdicts come from durable state: the dispatch records in KV,
// the owners' messages and inbox events on the event stream, and the registry.
//
// - A main request is never `steer`, goes in only while the area folder is idle, and an owner's queue holds at most
//   one undelivered main request; requests keep their order although their message ids are hashes.
// - The user's input comes before a waiting main request whatever the Enter behaviour, and reaches the owner unchanged
//   (the prompt hook only records it; the next team update and `team_status` show the direct talk).
// - Main 멈춤: new requests wait and none goes in; the stop button turns it on and nothing restarts the owner; turning
//   it off sends the waiting requests in order. 다시 시작 leaves an area the user paused paused.
// - A kill while a request waits and a restart: it goes in exactly once.
// - A request during a rotation goes to the new owner; with Main 멈춤 on, a user rotation lets no request in.
// - A request to an area whose setup command still runs waits (`maintaining`) and goes in once it ended (F1 with a
//   slow `bun.lock` install, its own server).
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { toolParts } from "../../../own-accounts/test/e2e-kit"
import { commit, f1, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  active,
  dispatchOf,
  dispatches,
  enableTeam,
  enqueued,
  interrupt,
  mainRequests,
  messages,
  opEnd,
  startTeamServer,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { inbox } from "./inspect.js"

const STEP_TIMEOUT = 240_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
const AREA_2 = OwnTeam.AreaID.make("ar_area-2")

interface Team {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly main: string
  readonly areas: Readonly<Record<string, OwnTeam.AreaView>>
}

describe("TG7 main requests and Main 멈춤 (two areas, F1)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "dispatch" })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 2]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    state.team = {
      server,
      teamID: team.id,
      main: team.main.sessionID,
      areas: Object.fromEntries(enabled.view.areas.map((area) => [area.id, area])),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "three requests: one at a time, `queue` only, each when the folder is idle, in order",
    async () => {
      const team = required(state.team)
      const o1 = owner(team, AREA_1)
      await team.server.turn(
        team.main,
        "[dispatch area-1 [slow 4000] [report progress 하나]] [dispatch area-1 [report progress 둘]] [dispatch area-1 [report done 셋]]",
      )
      // The main heard: the first went in, the other two wait.
      const results = (await toolParts(team.server.server, team.main, "execute")).map((part) => JSON.stringify(part))
      // Code Mode results are compact JSON since upstream v2.4 (`"state":"queued"`), pretty-printed before.
      const shows = (value: string) => new RegExp(`\\\\"state\\\\": ?\\\\"${value}\\\\"`)
      expect(results.filter((text) => shows("queued").test(text))).toHaveLength(1)
      expect(results.filter((text) => shows("waiting").test(text))).toHaveLength(2)

      await settled(team, AREA_1, 3)
      const received = await mainRequests(team.server, o1)
      expect(received.map((message) => body(message))).toEqual([
        "[slow 4000] [report progress 하나]",
        "[report progress 둘]",
        "[report done 셋]",
      ])
      // Hashed message ids (`msg_` + base32 of a hash): their order is the admission order, not the id order.
      for (const message of received) expect(String(message.id)).toMatch(/^msg_[0-9a-z]{26}$/)
      oneAtATime(team, o1)
    },
    STEP_TIMEOUT,
  )

  test(
    "the user's input (steer or queue) comes before the waiting main request and reaches the owner unchanged",
    async () => {
      const team = required(state.team)
      const o1 = owner(team, AREA_1)
      const before = (await mainRequests(team.server, o1)).length
      await team.server.server.prompt(
        team.main,
        "[dispatch area-1 [slow 6000] [report progress 넷]] [dispatch area-1 [report progress 다섯]]",
      )
      // The owner works on the first request and the main has asked for the second (it waits in the outbox).
      await until(
        async () =>
          (await active(team.server)).has(o1) &&
          dispatches(team.server.server.paths.database, team.teamID).some(
            (item) => item.text === "[report progress 다섯]" && item.state === "waiting",
          ),
        "the owner never started the request",
      )
      const steer = "사용자 직접 입력: 끼워 넣기로 보냅니다"
      const queue = "사용자 직접 입력: 대기열로 보냅니다"
      await team.server.server.prompt(o1, steer, { delivery: "steer" })
      await team.server.server.prompt(o1, queue, { delivery: "queue" })
      await team.server.server.waitIdle(team.main)
      await settled(team, AREA_1, before + 2)

      const all = (await messages(team.server, o1)).filter((message) => message.type === "user")
      const at = (match: (message: Readonly<Record<string, unknown>>) => boolean) => all.findIndex(match)
      const fifth = at((message) => body(message) === "[report progress 다섯]")
      const steered = at((message) => message.text === steer)
      const queued = at((message) => message.text === queue)
      expect(steered).toBeGreaterThan(at((message) => body(message) === "[slow 6000] [report progress 넷]"))
      expect(steered).toBeLessThan(fifth)
      expect(queued).toBeLessThan(fifth)
      // Unchanged and not taken for a main request.
      for (const index of [steered, queued]) expect(dispatchOf(required(all[index]))).toBeUndefined()
      oneAtATime(team, o1)

      // The registry noted the direct talk (information only), and the main reads it in team_status.
      const area = await areaOf(team, AREA_1)
      expect(area.direct?.sessionID).toBe(o1)
      await team.server.turn(team.main, "[status area-1]")
      const status = (await toolParts(team.server.server, team.main, "execute")).at(-1)
      expect(JSON.stringify(status)).toContain("사용자가 직접 대화함")
    },
    STEP_TIMEOUT,
  )

  test(
    "another conversation working in the area folder holds the request back until it is idle",
    async () => {
      const team = required(state.team)
      const o1 = owner(team, AREA_1)
      // Counted once the owner is idle: three files at once on a loaded PC, the previous test's last request was still
      // on its way into the conversation and showed up during this one (2026-10-29).
      await team.server.server.waitIdle(o1)
      const before = (await mainRequests(team.server, o1)).length
      const folder = team.areas[AREA_1]?.directory
      const other = await team.server.createSession({ directory: required(folder), title: "사용자의 다른 대화" })
      // Busy long enough to cover the main's turn and both reads: with 6 s the other conversation ended between
      // `outbox.list` and the count on a loaded PC (8.2 s into the test), and the held request was in (RL8-T4).
      await team.server.server.prompt(other, "[slow 15000] 다른 대화에서 하는 일")
      await until(async () => (await active(team.server)).has(other), "the other conversation never started")
      await team.server.turn(team.main, "[dispatch area-1 [report progress 여섯]]")
      const outbox = await team.server.team("outbox.list", { teamID: team.teamID, areaID: AREA_1 })
      expect(outbox.items.map((item) => item.text)).toEqual(["[report progress 여섯]"])
      expect(outbox.why).toBe("busy")
      expect(await mainRequests(team.server, o1)).toHaveLength(before)

      await team.server.server.waitIdle(other)
      await settled(team, AREA_1, before + 1)
      const ended = team.server.events.events.findLastIndex(
        (event) => event.type === "session.execution.succeeded" && event.data.sessionID === other,
      )
      const sent = enqueued(team.server, o1).findLast((item) => OwnTeam.DISPATCH_META in item.metadata)
      expect(required(sent).index).toBeGreaterThan(ended)
    },
    STEP_TIMEOUT,
  )

  test(
    "Main 멈춤: requests wait and none goes in; a cancelled one never does; off sends the rest in order",
    async () => {
      const team = required(state.team)
      const o1 = owner(team, AREA_1)
      const before = (await mainRequests(team.server, o1)).length
      expect(
        (await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_1, on: true })).area.paused,
      ).toBe("user")
      await team.server.turn(
        team.main,
        "[dispatch area-1 [report progress 일곱]] [dispatch area-1 [report progress 여덟]] [dispatch area-1 [report progress 아홉]]",
      )
      const outbox = await team.server.team("outbox.list", { teamID: team.teamID, areaID: AREA_1 })
      expect(outbox.why).toBe("paused")
      expect(outbox.items.map((item) => item.text)).toEqual([
        "[report progress 일곱]",
        "[report progress 여덟]",
        "[report progress 아홉]",
      ])
      expect(inbox(team.server.server.paths.database, o1)).toEqual([])
      expect(await mainRequests(team.server, o1)).toHaveLength(before)

      const cancelled = required(outbox.items[1])
      await team.server.team("outbox.cancel", { teamID: team.teamID, areaID: AREA_1, dispatchID: cancelled.id })
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_1, on: false })
      await settled(team, AREA_1, before + 2)
      expect((await mainRequests(team.server, o1)).slice(before).map((message) => body(message))).toEqual([
        "[report progress 일곱]",
        "[report progress 아홉]",
      ])
      expect(
        dispatches(team.server.server.paths.database, team.teamID).find((item) => item.id === cancelled.id)?.state,
      ).toBe("cancelled")
    },
    STEP_TIMEOUT,
  )

  test(
    "the stop button turns Main 멈춤 on; nothing restarts the owner; off lets the next request in",
    async () => {
      const team = required(state.team)
      const o1 = owner(team, AREA_1)
      await team.server.turn(team.main, "[dispatch area-1 [slow 10000] [report progress 열]]")
      await until(async () => (await active(team.server)).has(o1), "the owner never started the request")
      await interrupt(team.server, o1)
      await until(async () => (await areaOf(team, AREA_1)).paused === "user", "the stop did not turn Main 멈춤 on")
      await team.server.server.waitIdle(o1)
      const count = (await messages(team.server, o1)).length
      await Bun.sleep(3_000)
      expect((await active(team.server)).has(o1)).toBe(false)
      expect(await messages(team.server, o1)).toHaveLength(count)

      const before = (await mainRequests(team.server, o1)).length
      await team.server.turn(team.main, "[dispatch area-1 [report progress 열하나]]")
      expect((await team.server.team("outbox.list", { teamID: team.teamID, areaID: AREA_1 })).why).toBe("paused")
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_1, on: false })
      await settled(team, AREA_1, before + 1)
      expect(body(required((await mainRequests(team.server, o1)).at(-1)))).toBe("[report progress 열하나]")
    },
    STEP_TIMEOUT,
  )

  test(
    "모두 멈추기 stops the working owner; 다시 시작 resumes only the areas it paused",
    async () => {
      const team = required(state.team)
      const o1 = owner(team, AREA_1)
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_2, on: true })
      await team.server.turn(team.main, "[dispatch area-1 [slow 10000] [report progress 열둘]]")
      await until(async () => (await active(team.server)).has(o1), "the owner never started the request")
      await team.server.team("team.pause", { teamID: team.teamID, on: true })
      await until(async () => !(await active(team.server)).has(o1), "모두 멈추기 did not stop the owner")
      expect(await paused(team)).toEqual({ [AREA_1]: "all", [AREA_2]: "user" })
      await team.server.team("team.pause", { teamID: team.teamID, on: false })
      expect(await paused(team)).toEqual({ [AREA_1]: false, [AREA_2]: "user" })
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_2, on: false })
      expect(await paused(team)).toEqual({ [AREA_1]: false, [AREA_2]: false })
    },
    STEP_TIMEOUT,
  )

  test(
    "a kill while a request waits, then a restart: it goes in exactly once",
    async () => {
      const team = required(state.team)
      const o2 = owner(team, AREA_2)
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_2, on: true })
      await team.server.turn(team.main, "[dispatch area-2 [report progress 열셋]]")
      const waiting = required(
        dispatches(team.server.server.paths.database, team.teamID).find(
          (item) => item.areaID === AREA_2 && item.state === "waiting",
        ),
      )
      await team.server.restart({ kill: true })
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_2, on: false })
      await settled(team, AREA_2, 1)
      // Resumes and the release after the restart send it once; core keeps the first admission of the hashed id.
      await Bun.sleep(2_000)
      expect((await mainRequests(team.server, o2)).map((message) => dispatchOf(message))).toEqual([waiting.id])
      const ids = (await mainRequests(team.server, owner(team, AREA_1))).map((message) => dispatchOf(message))
      expect(new Set(ids).size).toBe(ids.length)
    },
    STEP_TIMEOUT,
  )

  test(
    "a request during a rotation goes to the new owner; with Main 멈춤 on, a user rotation lets none in",
    async () => {
      const team = required(state.team)
      const old = owner(team, AREA_2)
      await team.server.server.prompt(old, "[slow 6000] 사용자가 직접 시키는 일")
      await until(async () => (await active(team.server)).has(old), "the owner never started the user's turn")
      const rotation = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_2 })
      await team.server.turn(team.main, "[dispatch area-2 [report progress 열넷]]")
      const op = await opEnd(team.server, rotation.opID)
      expect(op.steps.filter((step) => step.state !== "done")).toEqual([])
      const rotated = await areaOf(team, AREA_2)
      const next = required(rotated.owner.sessionID ?? undefined)
      expect(next).not.toBe(old)
      expect(rotated.owner.previous.map((item) => [item.sessionID, item.why])).toEqual([[old, "user"]])
      const sent = await waitValue(
        async () =>
          dispatches(team.server.server.paths.database, team.teamID).find(
            (item) => item.text === "[report progress 열넷]" && item.state === "sent",
          ),
        "the request during the rotation was never sent",
        STEP_TIMEOUT,
      )
      expect(sent.sentTo?.sessionID).toBe(next)
      expect((await mainRequests(team.server, old)).map((message) => body(message))).not.toContain(
        "[report progress 열넷]",
      )

      // Main 멈춤 on: the user's rotation still runs, and no main request reaches the new conversation.
      await team.server.server.waitIdle(next)
      await team.server.team("area.pause", { teamID: team.teamID, areaID: AREA_2, on: true })
      await team.server.turn(team.main, "[dispatch area-2 [report progress 열다섯]]")
      const again = await team.server.team("area.rotate", { teamID: team.teamID, areaID: AREA_2 })
      expect((await opEnd(team.server, again.opID)).state).toBe("done")
      const newest = required((await areaOf(team, AREA_2)).owner.sessionID ?? undefined)
      expect(newest).not.toBe(next)
      await Bun.sleep(2_000)
      expect(await mainRequests(team.server, newest)).toEqual([])
      expect((await team.server.team("outbox.list", { teamID: team.teamID, areaID: AREA_2 })).items).toHaveLength(1)
    },
    STEP_TIMEOUT,
  )
})

describe("TG7 a main request to an area whose setup command runs (06 §5.1, §0.4 #6)", () => {
  const state: { team?: Team } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "dispatch-setup", project: slowSetup })
    const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
    const enabled = await enableTeam(server, { hint: "[propose-areas 1 +setup]", sessionID: viewed })
    const team = required(enabled.view.team ?? undefined)
    expect(team.commands.setup).toEqual({ argv: ["bun", "install"] })
    state.team = {
      server,
      teamID: team.id,
      main: team.main.sessionID,
      areas: Object.fromEntries(enabled.view.areas.map((area) => [area.id, area])),
    }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.server.stop()
  }, 120_000)

  test(
    "the request waits (`maintaining`) while the new area prepares and goes in once its setup ended",
    async () => {
      const team = required(state.team)
      // The new area's setup command runs until the test removes the hold, so the request below lands while it runs.
      const hold = setupHold(required(team.server.project))
      fs.writeFileSync(hold, "")
      const started = await team.server.team("reorg.apply", {
        teamID: team.teamID,
        proposal: { version: 1, ops: [{ op: "new", slug: "area-2", name: "영역 2", goal: "준비 명령 뒤 작업" }] },
      })
      // The area exists while its setup command (a held `bun install`) still runs: 준비 중.
      await until(
        async () =>
          (await team.server.team("team.get", { directory: required(team.server.project) })).areas.some(
            (area) => area.id === AREA_2 && area.status.kind === "preparing" && area.owner.sessionID !== null,
          ),
        "the new area never showed 준비 중",
      )
      await team.server.turn(team.main, "[dispatch area-2 [report done 준비 뒤 작업]]")
      const outbox = await team.server.team("outbox.list", { teamID: team.teamID, areaID: AREA_2 })
      expect(outbox.items.map((item) => item.text)).toEqual(["[report done 준비 뒤 작업]"])
      expect(outbox.why).toBe("maintaining")
      const answer = (await toolParts(team.server.server, team.main, "execute")).at(-1)
      expect(JSON.stringify(answer)).toContain("maintaining")

      fs.rmSync(hold)
      expect((await opEnd(team.server, started.opID)).state).toBe("done")
      const area = await areaOf(team, AREA_2)
      expect(area.status.kind).not.toBe("preparing")
      const owner2 = required(area.owner.sessionID ?? undefined)
      await until(
        async () =>
          dispatches(team.server.server.paths.database, team.teamID).some(
            (item) => item.areaID === AREA_2 && item.state === "sent",
          ),
        "the request never went in after the setup",
      )
      await team.server.server.waitIdle(owner2)
      expect((await mainRequests(team.server, owner2)).map((message) => body(message))).toEqual([
        "[report done 준비 뒤 작업]",
      ])
    },
    STEP_TIMEOUT,
  )
})

/**
 * F1 with a setup command the test holds: a `bun.lock` install of a local package whose `postinstall` waits while
 * {@link setupHold} exists (at most two minutes), its `node_modules` ignored. A fixed wait raced the dispatch turn,
 * which a loaded PC ran after the setup had ended.
 */
function slowSetup(root: string) {
  const home = f1(root).home
  write(home, {
    "hold.js": [
      `const hold = ${JSON.stringify(setupHold(home))}`,
      "const deadline = Date.now() + 120_000",
      'while (require("node:fs").existsSync(hold) && Date.now() < deadline) Bun.sleepSync(100)',
      "",
    ].join("\n"),
    "package.json": `${JSON.stringify(
      {
        name: "f1",
        private: true,
        dependencies: { "f1-local": "file:./local" },
        scripts: { postinstall: "bun hold.js" },
      },
      null,
      2,
    )}\n`,
    "local/package.json": '{ "name": "f1-local", "version": "1.0.0" }\n',
    ".gitignore": "node_modules/\n",
  })
  const locked = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (locked.exitCode !== 0) throw new Error(`bun install --lockfile-only: ${locked.stderr.toString()}`)
  commit(home, "setup")
  return home
}

/** The file that holds {@link slowSetup}'s setup command, beside the project's main folder. */
function setupHold(home: string) {
  return path.join(path.dirname(home), "setup-hold")
}

// ---------------------------------------------------------------------------------------------------------------

function owner(team: Team, areaID: OwnTeam.AreaID) {
  return required(team.areas[areaID]?.owner.sessionID ?? undefined)
}

async function areaOf(team: Team, areaID: OwnTeam.AreaID) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return required(view.areas.find((area) => area.id === areaID))
}

async function paused(team: Team) {
  const view = await team.server.team("team.get", { directory: required(team.server.project) })
  return Object.fromEntries(view.areas.map((area) => [area.id, area.paused]))
}

/** Waits until the area has `count` sent requests, nothing waits, and its owner is idle. */
async function settled(team: Team, areaID: OwnTeam.AreaID, count: number) {
  await until(
    async () => {
      const items = dispatches(team.server.server.paths.database, team.teamID).filter((item) => item.areaID === areaID)
      const area = await areaOf(team, areaID)
      const sessionID = area.owner.sessionID
      return (
        items.filter((item) => item.state === "sent").length >= count &&
        items.every((item) => item.state !== "waiting" || area.paused !== false) &&
        sessionID !== null &&
        !(await active(team.server)).has(sessionID) &&
        inbox(team.server.server.paths.database, sessionID).length === 0
      )
    },
    `area ${areaID} did not settle with ${count} requests sent`,
    STEP_TIMEOUT,
  )
}

/**
 * Over the recorded stream: every main request entered the owner's inbox as `queue`, and each one after the first only
 * after the previous one was delivered and the owner's run ended (at most one in its queue; none while it worked).
 */
function oneAtATime(team: Team, sessionID: string) {
  const events = team.server.events.events
  const sent = enqueued(team.server, sessionID).filter((item) => OwnTeam.DISPATCH_META in item.metadata)
  expect(sent.map((item) => item.delivery).filter((delivery) => delivery !== "queue")).toEqual([])
  sent.slice(1).forEach((item, index) => {
    const previous = required(sent[index])
    const between = events.slice(previous.index + 1, item.index)
    expect(
      between.some((event) => event.type === "session.inbox.delivered" && event.data.inboxID === previous.inboxID),
    ).toBe(true)
    expect(
      between.some(
        (event) =>
          event.data.sessionID === sessionID &&
          (event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted"),
      ),
    ).toBe(true)
  })
}

/** The request text inside a main request's envelope (`<dispatch …>\n<text>\n</dispatch>`). */
function body(message: Readonly<Record<string, unknown>>) {
  const text = typeof message.text === "string" ? message.text : ""
  const match = /^<dispatch[^>]*>\n([\s\S]*?)\n(?:[^\n]*\n)?<\/dispatch>$/.exec(text)
  return match?.[1] ?? text
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
