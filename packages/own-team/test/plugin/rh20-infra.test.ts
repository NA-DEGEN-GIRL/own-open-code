// RH-20 (06 §2.6): what keeps own.team from going quiet for good. A core event stream that ends is read again and the
// controller resumes; own.accounts calls answer `timeout` instead of hanging; a controller lock another live process
// holds is logged and shown, and writes answer `unavailable` instead of waiting; own.team logs to
// `OWN_HOME\logs\own-team.log` and keeps its last warnings for `diagnostics`; `team_status` names the step an op waits
// at, since when, why and what the user can do. Fake values and temp folders only.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { Controller } from "../../src/controller.js"
import { Hub } from "../../src/hub.js"
import { Intake } from "../../src/intake.js"
import { Log } from "../../src/log.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { Services } from "../../src/services.js"
import { AccountsRpc } from "../../src/sessions/accounts-rpc.js"
import { Singleton } from "../../src/singleton.js"
import { StatusTool } from "../../src/tools/status.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, buildId, tempHome } from "../support/context.js"

async function eventually(check: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(10)
  }
}

describe("the event stream (RH-20)", () => {
  test("a stream that ends is read again, and the controller resumes to cover the gap", async () => {
    const reads = { count: 0 }
    const ctx = {
      event: {
        // SAFETY (test): an async iterable of core events with the fields own.team reads.
        subscribe: (() => {
          reads.count++
          const first = reads.count === 1
          return (async function* () {
            yield { id: first ? "evt_1" : "evt_2", type: "session.execution.succeeded", data: { sessionID: "ses_x" } }
            // The first stream ends; the second stays open until the test stops it.
            if (!first) await new Promise(() => {})
          })()
        }) as never,
      },
    }
    const hub = new Hub.Bus(Log.silent)
    const seen: string[] = []
    hub.on((event) => {
      seen.push(event.id)
    })
    const lines: string[] = []
    const restarted = { count: 0 }
    const states: string[] = []
    const stop = Intake.start({
      ctx,
      hub,
      dedup: new Intake.Dedup(),
      log: Log.create({ scope: "intake", sink: (line) => lines.push(line) }),
      restarted: () => restarted.count++,
      status: (status) => states.push(`${status.state}:${status.restarts}`),
    })
    await eventually(() => seen.includes("evt_2"))
    stop()
    expect(seen).toEqual(["evt_1", "evt_2"])
    expect(restarted.count).toBe(1)
    expect(states).toEqual(["reading:0", "restarting:0", "reading:1"])
    expect(lines.some((line) => line.includes("event_stream_ended"))).toBe(true)
    expect(lines.some((line) => line.includes("event_stream_restarted"))).toBe(true)
  })
})

describe("own.accounts calls (RH-20)", () => {
  test("a call own.accounts never answers comes back as timeout", async () => {
    const never = new Promise(() => {})
    // SAFETY (test): an RPC client whose every method waits for good.
    const rpc = (() => new Proxy({}, { get: () => () => never })) as never
    const client = AccountsRpc.create(() => ({ rpc }), { timeoutMs: 50, applyTimeoutMs: 80 })
    expect(await client.accountsList()).toMatchObject({ ok: false, type: "timeout" })
    const began = Date.now()
    expect(
      await client.switchApply({
        sessionID: "ses_main0000000000000000000001",
        target: { providerID: "openai", id: "gpt" },
        strategy: "now",
        reason: "manual",
      } as never),
    ).toMatchObject({ ok: false, type: "timeout" })
    expect(Date.now() - began).toBeGreaterThanOrEqual(70)
  })
})

describe("the controller lock (RH-20)", () => {
  test("while another live process holds it: logged, shown by health, and writes answer unavailable", async () => {
    await using home = await tempHome()
    const file = Singleton.lockFile(home.root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // This test's parent process runs and keeps the lock fresh: another service on the same OWN_HOME.
    const hold = () => fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, buildId: "other", token: "x" }))
    hold()
    const touching = setInterval(() => {
      if (fs.existsSync(file)) fs.utimesSync(file, new Date(), new Date())
    }, 1_000)
    const lines: string[] = []
    const handle = Singleton.acquire({
      buildId: buildId("lock"),
      home: home.root,
      log: Log.create({ scope: "controller", sink: (line) => lines.push(line) }),
      clock: Services.system,
      source: ServiceTarget.fixed({ url: "http://127.0.0.1:9", password: "fake-password-unused" }),
      lingerSeconds: 0,
    })
    try {
      const services = handle.controller.services
      await eventually(() => services.status.controller().state === "lock")
      expect(services.status.controller()).toMatchObject({
        state: "lock",
        holder: { pid: process.ppid, buildId: "other" },
      })
      expect(lines.some((line) => line.includes("controller_lock_waiting"))).toBe(true)
      expect(await services.ready(50)).toBe(false)
      const handlers = TeamRpc.create({ services, leader: () => true, log: Log.silent })
      // SAFETY (test): every handler takes its method's input and `{signal, error}`.
      const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
      const context = {
        signal: new AbortController().signal,
        error: (type: string, message: string, data: unknown) => ({ type, message, data }),
      }
      const health = await loose.health!({}, context)
      expect(health).toMatchObject({ controller: { state: "lock", holder: { pid: process.ppid } } })
      clearInterval(touching)
      fs.rmSync(file)
      await handle.ready
      expect(services.status.controller()).toEqual({ state: "running" })
      expect(await services.ready(50)).toBe(true)
    } finally {
      clearInterval(touching)
      await handle.release()
    }
  }, 120_000)

  test("an RPC method that writes answers unavailable after its wait; one that reads answers", async () => {
    await using home = await tempHome()
    const clock = manual()
    // A controller that never got the lock (another process holds it).
    const waiting = new Controller.Service({
      buildId: buildId("waiting"),
      home: home.root,
      log: Log.silent,
      clock,
      source: ServiceTarget.fixed({ url: "http://127.0.0.1:9", password: "fake-password-unused" }),
    })
    waiting.waitingForLock({ pid: 4242, buildId: "other" })
    const handlers = TeamRpc.create({ services: waiting.services, leader: () => true, log: Log.silent })
    // SAFETY (test): every handler takes its method's input and `{signal, error}`.
    const loose = handlers as unknown as Record<string, (input: unknown, context: unknown) => Promise<unknown>>
    const context = {
      signal: new AbortController().signal,
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    }
    const before = clock.pending()
    const paused = loose["area.pause"]!({ teamID: TEAM_ID, areaID: "ar_ui", on: true }, context)
    await eventually(() => clock.pending() > before)
    clock.advance(TeamRpc.WRITE_WAIT_MS)
    expect(await paused).toMatchObject({ type: "unavailable", data: { why: "controller_lock", pid: 4242 } })
    expect(await loose.health!({}, context)).toMatchObject({ controller: { state: "lock" } })
    await waiting.close()
  })
})

describe("the log (RH-20)", () => {
  test("lines go to own-team.log too, and the team's warnings are kept for diagnostics", async () => {
    await using home = await tempHome()
    const file = path.join(home.root, "logs", "own-team.log")
    const log = Log.create({ scope: "own.team", sink: () => {}, file }).child("runner")
    const teamID = `tm_${Date.now().toString(16).padStart(12, "0").slice(-12)}`
    log.info("op_start", { teamID, opID: "op_x" })
    log.warn("wait_stalled", { teamID, opID: "op_x", ms: 300_000 })
    log.warn("other_team", { teamID: "tm_000000000000" })
    await eventually(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("other_team"))
    const written = fs.readFileSync(file, "utf8").trim().split("\n")
    expect(written.map((line) => JSON.parse(line).msg)).toEqual(["op_start", "wait_stalled", "other_team"])
    const kept = Log.recent(teamID)
    expect(kept.some((line) => line.includes("wait_stalled"))).toBe(true)
    expect(kept.some((line) => line.includes("op_start") || line.includes("other_team"))).toBe(false)
  })
})

describe("team_status names the wait (RH-20)", () => {
  test("the op line: step n/m, what it waits for, since when, what the user can do; past 5 minutes, tell the user", () => {
    const now = Date.UTC(2026, 9, 29, 3, 0, 0)
    const area = { id: OwnTeam.AreaID.make("ar_api"), name: "api" }
    const op = {
      id: OwnTeam.OpID.make("op_01M6000000000000000000000A"),
      teamID: TEAM_ID,
      kind: "rotate",
      by: "main",
      state: "running",
      areaID: area.id,
      createdAt: now - 17 * 60_000,
      steps: [
        {
          id: "s1",
          kind: "rotate.begin",
          args: {},
          mode: "auto",
          state: "pending",
          startedAt: now - 17 * 60_000,
          wait: {
            why: "safe-point",
            detail: "shell",
            text: "api: 실행 중인 명령이 끝나기를 기다려요: 'bun run dev'",
            since: now - 17 * 60_000,
            actions: ["cancel", "force", "stop-shell"],
          },
        },
        ...["rotate.handoff", "rotate.owner", "rotate.swap", "rotate.archive"].map((kind, index) => ({
          id: `s${index + 2}`,
          kind,
          args: {},
          mode: "auto",
          state: "pending",
        })),
      ],
    } as unknown as OwnTeam.Op
    const line = StatusTool.opLine(op, [area as unknown as OwnTeam.Area], now, { state: "running" })
    expect(line).toBe(
      "- 지금 도는 작업: 새 대화로 이어가기 · 'api' (op_01M6000000000000000000000A) · 1/5 영역이 쉬기를 기다림 · 17분째 · " +
        "기다리는 것: api: 실행 중인 명령이 끝나기를 기다려요: 'bun run dev' · " +
        "할 수 있는 것: 사용자에게 [명령 멈추고 진행]이나 [바로 진행]이나 [취소]를 부탁하세요 · " +
        "5분 넘게 기다리고 있어요. team_status를 다시 부르지 말고 사용자에게 알리세요",
    )
  })
})
