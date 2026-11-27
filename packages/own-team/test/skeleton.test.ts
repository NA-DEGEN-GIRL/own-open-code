// The own.team plugin skeleton (06 §2.6–2.7, TG1 plugin part): guard 1, health-only registrations, the full RPC
// registration, leader-only events with an eventId and origin "global", the process singleton's references and
// linger, the controller lock, event intake deduplication, and the self-HTTP client. Fake contexts, the real
// @own/runtime on a temp OWN_HOME, a manual clock and a fake loopback service; nothing here reaches a real account.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { Log } from "../src/log.js"
import { TeamRpc } from "../src/rpc/handlers.js"
import { Teams } from "../src/registry/team.js"
import { SessionHttp } from "../src/sessions/http.js"
import { Singleton } from "../src/singleton.js"
import { manual } from "./support/clock.js"
import { f1, git, temp } from "./fixtures/repo.js"
import { boot, buildId, call, managedEnv, team, tempHome, World } from "./support/context.js"
import { session, start } from "./support/service.js"

const restore = managedEnv()
afterAll(restore)

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

interface Standard {
  readonly "~standard": { readonly validate: (value: unknown) => { readonly issues?: unknown } }
}

/**
 * What the host does with a handler's output or an emitted event (Standard Schema "parse forward", 01 §17.0): no
 * issues means no `rpc.invalid_output` for that value.
 */
function valid(kind: "output" | "event", name: string, value: unknown) {
  const definition = TeamRpc.definition()
  // SAFETY (test): every method output and event schema of the portable definition is a Standard Schema object.
  const schema =
    kind === "output"
      ? (definition.methods as unknown as Record<string, { readonly output: Standard }>)[name]!.output
      : (definition.events as unknown as Record<string, { readonly schema: Standard }>)[name]!.schema
  return schema["~standard"].validate(value).issues
}

describe("guard 1", () => {
  test("an unmanaged service registers health only, with no tools, denies or hooks", async () => {
    const env = managedEnv({ OWN_OPEN_CODE: undefined })
    await using home = await tempHome()
    const booted = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: buildId("unmanaged"), logLevel: "error" },
    }).finally(env)
    expect(booted.registrations).toHaveLength(1)
    const registered = booted.registrations[0]!
    expect(Object.keys(registered.definition.methods)).toEqual(["health"])
    expect(await call(registered, "health", {})).toMatchObject({ guard: "unmanaged", features: [], mode: "local" })
    expect(booted.tools).toHaveLength(0)
    expect(booted.agentTransforms).toHaveLength(0)
    expect(booted.hooks.size).toBe(0)
    await booted.cleanup()
    expect(registered.disposed).toBe(true)
  })

  test("an app version other than the build's is skew", async () => {
    await using home = await tempHome()
    const booted = await boot(new World(), {
      directory: home.root,
      version: "2.0.17",
      options: { home: home.root, buildId: buildId("skew"), logLevel: "error" },
    })
    expect(await call(booted.registrations[0]!, "health", {})).toMatchObject({ guard: "skew", features: [] })
    expect(booted.tools).toHaveLength(0)
    await booted.cleanup()
  })

  test("remote mode needs OWN_REMOTE=1; with it the plugin loads in full (06 §4.13)", async () => {
    await using home = await tempHome()
    const missing = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: buildId("remote"), mode: "remote", logLevel: "error" },
    })
    expect(await call(missing.registrations[0]!, "health", {})).toMatchObject({ guard: "unmanaged", mode: "remote" })
    await missing.cleanup()

    const env = managedEnv({ OWN_OPEN_CODE: "1", OWN_REMOTE: "1" })
    const remote = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: buildId("remote"), mode: "remote", lingerSeconds: 0, logLevel: "error" },
    }).finally(env)
    // A remote instance that is never cleaned up leaves the process in remote mode for the later tests.
    try {
      expect(Object.keys(remote.registrations[0]!.definition.methods).sort()).toEqual(
        Object.keys(OwnTeam.Definition.methods).sort(),
      )
      expect(await call(remote.registrations[0]!, "health", {})).toMatchObject({ guard: "ok", mode: "remote" })
      expect(remote.tools).toHaveLength(11)
    } finally {
      await remote.cleanup()
    }
  })
})

describe("a managed instance", () => {
  test("registers every own.team method, the tools, the agent denies and the hooks", async () => {
    await using home = await tempHome()
    const id = buildId("managed")
    const booted = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" },
    })
    const registered = booted.registrations[0]!
    expect(Object.keys(registered.definition.methods).sort()).toEqual(Object.keys(OwnTeam.Definition.methods).sort())
    expect(booted.tools).toHaveLength(11)
    expect(booted.agentTransforms).toHaveLength(1)
    expect([...booted.hooks.keys()].sort()).toEqual([
      "permission.evaluate",
      "session.prompt",
      "tool.execute.after",
      "tool.execute.before",
    ])
    expect(Singleton.peek(id)?.refs).toBe(1)
    await booted.cleanup()
    // `lingerSeconds: 0`: the last release closes the controller at once and removes the lock.
    expect(Singleton.peek(id)).toBeUndefined()
    expect(fs.existsSync(Singleton.lockFile(home.root))).toBe(false)
  })

  test("answers health, reads and the write methods with declared errors", async () => {
    await using home = await tempHome()
    const id = buildId("rpc")
    const booted = await boot(new World(), {
      directory: path.join(home.root, "control"),
      options: { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" },
    })
    const registered = booted.registrations[0]!
    const health = await call(registered, "health", {})
    expect(health).toMatchObject({ guard: "ok", buildId: id, mode: "local", leader: true })
    expect(valid("output", "health", health)).toBeUndefined()
    expect((health as OwnTeam.Health).features).toEqual(expect.arrayContaining(["settings", "diagnostics"]))
    expect((health as OwnTeam.Health).git?.ok).toBe(true)
    expect(await call(registered, "team.list", {})).toEqual({ teams: [] })
    expect(await call(registered, "team.get", { directory: home.root })).toEqual({
      team: null,
      areas: [],
      waiting: {},
      op: null,
      pending: [],
    })
    expect(await call(registered, "settings.get", { teamID: "tm_000000000000" })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
    expect(await call(registered, "op.get", { opID: OwnTeam.OpID.create() })).toMatchObject({ type: "not_found" })
    expect(await call(registered, "enable", { directory: home.root })).toMatchObject({ type: "not_git" })
    expect(await call(registered, "area.adopt", { teamID: "tm_000000000000", directory: home.root })).toMatchObject({
      type: "not_found",
      data: { what: "team", id: "tm_000000000000" },
    })
    expect(await call(registered, "team.pause", { teamID: "tm_000000000000", on: true })).toMatchObject({
      type: "not_found",
      data: { what: "team" },
    })
    await booted.cleanup()
  })
})

describe("team reads and settings", () => {
  test("team.get finds the team from any checkout of the repository; diagnostics and settings work", async () => {
    const box = temp()
    try {
      const repo = f1(box.root)
      const sibling = path.join(box.root, "side")
      git(repo.home, ["worktree", "add", "-q", "-b", "side", sibling, repo.head])
      await using home = await tempHome()
      const id = buildId("reads")
      const booted = await boot(new World(), {
        directory: path.join(home.root, "control"),
        options: { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" },
      })
      const registered = booted.registrations[0]!
      const services = Singleton.peek(id)!.controller.services
      const commonDir = path.join(repo.home, ".git")
      const record = { ...team({ home: repo.home }), id: Teams.id(commonDir), commonDir }
      await services.write(record.id, () => services.registry.teams.put(record))

      const got = (await call(registered, "team.get", { directory: path.join(sibling, "src") })) as {
        readonly team: OwnTeam.Team | null
      }
      expect(got.team?.id).toBe(record.id)
      expect(valid("output", "team.get", got)).toBeUndefined()
      expect(await call(registered, "team.list", {})).toEqual({
        teams: [{ id: record.id, projectID: "prj_test", home: repo.home, state: "on", areas: 0 }],
      })

      const diagnostics = (await call(registered, "diagnostics", { teamID: record.id })) as OwnTeam.Diagnostics
      expect(valid("output", "diagnostics", diagnostics)).toBeUndefined()
      expect(diagnostics.versions.git.ok).toBe(true)
      expect(diagnostics.inventory.map((entry) => entry.class)).toEqual(["home", "candidate"])
      expect(diagnostics.inventory[1]).toMatchObject({ branch: "side", locked: null, nested: false })
      expect(diagnostics.lastErrors).toEqual([])

      const set = (await call(registered, "settings.set", {
        teamID: record.id,
        patch: { policy: { mergeLocal: "ask" }, patterns: ["**/.claude/worktrees/**"] },
      })) as { readonly team: OwnTeam.Team }
      expect(set.team.rev).toBe(1)
      expect(valid("output", "settings.set", set)).toBeUndefined()
      // settings.get also answers the effective direct-work keys and 팀 지시문 (2026-11-14).
      expect(await call(registered, "settings.get", { teamID: record.id })).toMatchObject({
        policy: { ...record.policy, mergeLocal: "ask" },
        commands: record.commands,
        patterns: ["**/.claude/worktrees/**"],
      })
      await Bun.sleep(0)
      expect(registered.emitted).toContainEqual({
        name: "team.changed",
        data: expect.objectContaining({ teamID: record.id, rev: 1, origin: "global" }),
      })
      await booted.cleanup()
    } finally {
      box.dispose()
    }
  })
})

describe("leadership and events", () => {
  test("only the leader emits rpc.own.team events, each with a ULID eventId and origin global", async () => {
    await using home = await tempHome()
    const id = buildId("leader")
    const world = new World()
    const options = { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" }
    const control = path.join(home.root, "control")
    const area = path.join(home.root, "area")
    fs.mkdirSync(area, { recursive: true })
    // The area instance starts first; the control location instance still leads (preferLeader).
    const other = await boot(world, { directory: area, options })
    const leader = await boot(world, { directory: control, options })
    const controller = Singleton.peek(id)!.controller
    controller.hub.publish({ name: "team.changed", data: { teamID: OwnTeam.TeamID.make("tm_0123456789ab"), rev: 3 } })
    await Bun.sleep(0)
    expect(other.registrations[0]!.emitted).toHaveLength(0)
    const emitted = leader.registrations[0]!.emitted
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      name: "team.changed",
      data: { origin: "global", teamID: "tm_0123456789ab", rev: 3 },
    })
    expect(String(emitted[0]!.data.eventId)).toMatch(ULID)
    expect(valid("event", "team.changed", emitted[0]!.data)).toBeUndefined()
    expect(await call(other.registrations[0]!, "health", {})).toMatchObject({ leader: false })

    // The leader goes away: the remaining instance leads and publishes.
    await leader.cleanup()
    controller.hub.publish({ name: "team.changed", data: { teamID: OwnTeam.TeamID.make("tm_0123456789ab"), rev: 4 } })
    await Bun.sleep(0)
    expect(other.registrations[0]!.emitted).toHaveLength(1)
    expect(other.registrations[0]!.emitted[0]).toMatchObject({ data: { rev: 4, origin: "global" } })
    await other.cleanup()
    // Two boots and a handover: more than the default 5 s when other suites load the PC.
  }, 30_000)

  test("a core event seen by several instances reaches the controller once", async () => {
    await using home = await tempHome()
    const id = buildId("intake")
    const world = new World()
    const options = { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" }
    const first = await boot(world, { directory: path.join(home.root, "control"), options })
    const second = await boot(world, { directory: home.root, options })
    const seen: string[] = []
    Singleton.peek(id)!.controller.hub.on((event) => {
      seen.push(event.id)
    })
    await Bun.sleep(0)
    const event = {
      id: "evt_1",
      created: 1,
      type: "session.execution.succeeded",
      durable: { aggregateID: "ses_x", seq: 1, version: 1 },
      data: { sessionID: "ses_x" },
    }
    // SAFETY (test): a core event of the shape the client types describe.
    world.publish(event as never)
    world.publish({ ...event, id: "evt_2", type: "session.text.delta" } as never)
    await Bun.sleep(10)
    expect(seen).toEqual(["evt_1"])
    await second.cleanup()
    await first.cleanup()
  })
})

describe("process singleton", () => {
  test("shares one controller per build, counts references and lingers 30 s after the last release", async () => {
    await using home = await tempHome()
    const clock = manual()
    const input = {
      buildId: buildId("linger"),
      home: home.root,
      log: Log.silent,
      clock,
      source: ServiceTarget.fixed({ url: "http://127.0.0.1:9", password: "fake-password-unused" }),
    }
    const a = Singleton.acquire(input)
    const b = Singleton.acquire(input)
    expect(a.controller).toBe(b.controller)
    expect(Singleton.peek(input.buildId)?.refs).toBe(2)
    await a.ready
    const lock = JSON.parse(fs.readFileSync(Singleton.lockFile(home.root), "utf8")) as Record<string, unknown>
    expect(lock).toMatchObject({ pid: process.pid, buildId: input.buildId })

    await a.release()
    await a.release()
    expect(Singleton.peek(input.buildId)).toMatchObject({ refs: 1, lingering: false })
    await b.release()
    expect(Singleton.peek(input.buildId)).toMatchObject({ refs: 0, lingering: true })
    clock.advance(29_000)
    expect(Singleton.peek(input.buildId)).toBeDefined()

    // A new reference inside the linger keeps the same controller.
    const c = Singleton.acquire(input)
    expect(c.controller).toBe(a.controller)
    expect(Singleton.peek(input.buildId)).toMatchObject({ refs: 1, lingering: false })
    await c.release()
    clock.advance(30_000)
    expect(Singleton.peek(input.buildId)).toBeUndefined()
    for (let tries = 0; tries < 100 && fs.existsSync(Singleton.lockFile(home.root)); tries++) await Bun.sleep(10)
    expect(fs.existsSync(Singleton.lockFile(home.root))).toBe(false)
  })

  test("a lock left by a dead process is taken over", async () => {
    await using home = await tempHome()
    fs.mkdirSync(path.dirname(Singleton.lockFile(home.root)), { recursive: true })
    // A pid far above any live one on a test machine.
    fs.writeFileSync(Singleton.lockFile(home.root), JSON.stringify({ pid: 2_147_483_000, buildId: "old", token: "x" }))
    const handle = Singleton.acquire({
      buildId: buildId("stale"),
      home: home.root,
      log: Log.silent,
      clock: manual(),
      source: ServiceTarget.fixed({ url: "http://127.0.0.1:9", password: "fake-password-unused" }),
      lingerSeconds: 0,
    })
    await handle.ready
    expect(JSON.parse(fs.readFileSync(Singleton.lockFile(home.root), "utf8"))).toMatchObject({ pid: process.pid })
    await handle.release()
  })

  test("a lock its live pid stopped touching is taken over (a reused pid); a fresh one is waited for", async () => {
    await using home = await tempHome()
    const file = Singleton.lockFile(home.root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // This test's parent process runs: it stands for a dead holder's pid that Windows gave to a new process.
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, buildId: "old", token: "x" }))
    const handle = Singleton.acquire({
      buildId: buildId("lease"),
      home: home.root,
      log: Log.silent,
      clock: manual(),
      source: ServiceTarget.fixed({ url: "http://127.0.0.1:9", password: "fake-password-unused" }),
      lingerSeconds: 0,
    })
    const state = { ready: false }
    void handle.ready.then(() => {
      state.ready = true
    })
    await Bun.sleep(1_500)
    expect(state.ready).toBe(false)
    // No heartbeat for longer than the lease.
    const old = new Date(Date.now() - 2 * Singleton.LEASE_MS)
    fs.utimesSync(file, old, old)
    await handle.ready
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid })
    await handle.release()
  })
})

describe("self-HTTP", () => {
  test("sends the Basic credential and location[directory], and decodes the session view", async () => {
    const service = start()
    try {
      service.routes.set("GET /api/session/ses_a", () =>
        Response.json({ data: session({ id: "ses_a", directory: "C:\\work\\area" }) }),
      )
      const http = SessionHttp.create({ source: service.source })
      const got = await http.session.get({ sessionID: "ses_a", directory: "C:\\work\\area" })
      expect(got).toMatchObject({ ok: true, value: { id: "ses_a", location: { directory: "C:\\work\\area" } } })
      expect(service.requests[0]).toMatchObject({
        method: "GET",
        authorization: ServiceTarget.basic(service.password),
        query: { "location[directory]": "C:\\work\\area" },
      })
      const missing = await http.session.get({ sessionID: "ses_b", directory: "C:\\work" })
      expect(missing).toMatchObject({ ok: false, status: 404, type: "NotFound" })
    } finally {
      await service.stop()
    }
  })

  test("a 401 reads the source again once", async () => {
    const service = start()
    try {
      service.routes.set("GET /api/session/active", () => Response.json({ data: { ses_a: { type: "running" } } }))
      const state = { invalidated: 0 }
      const source: ServiceTarget.Source = {
        current: async () => ({
          url: service.url,
          authorization: ServiceTarget.basic(state.invalidated === 0 ? "stale-fake-password" : service.password),
        }),
        invalidate: () => {
          state.invalidated++
        },
      }
      const active = await SessionHttp.create({ source }).session.active()
      expect(active.ok && [...active.value]).toEqual(["ses_a"])
      expect(state.invalidated).toBe(1)
      expect(service.requests).toHaveLength(2)
    } finally {
      await service.stop()
    }
  })

  test("a request whose socket the service closed before answering goes once more, unless it is a POST (RH-28)", async () => {
    // Every first request on a connection is cut (a pooled keep-alive socket the service closed as idle).
    const state = { requests: 0 }
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          state.requests++
          if (state.requests % 2 === 1) return void socket.terminate()
          const body = JSON.stringify({ data: { ses_a: { type: "running" } } })
          socket.end(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
          )
        },
      },
    })
    try {
      const source = SessionHttp.source({
        service: { url: `http://127.0.0.1:${server.port}`, password: "fake" },
        channel: "local",
      })
      const http = SessionHttp.create({ source })
      const active = await http.session.active()
      expect(active.ok && [...active.value]).toEqual(["ses_a"])
      expect(state.requests).toBe(2)
      const posted = await http.session.interrupt({ sessionID: "ses_a", directory: "C:\\w", resume: false })
      expect(posted).toMatchObject({ ok: false, type: "unreachable", status: null })
      expect(state.requests).toBe(3)
    } finally {
      server.stop(true)
    }
  })

  test("RH-43: a POST that names what it makes (create, prompt, synthetic) and the worktree refresh go once more", async () => {
    // The first time each request arrives its socket is cut, as a busy service closing a pooled socket late does after
    // a restart; the same request again is answered.
    const state = { requests: 0, seen: new Set<string>() }
    const session = JSON.stringify({
      data: { id: "ses_a", projectID: "prj_a", location: { directory: "C:\\w" }, time: { created: 1, updated: 1 } },
    })
    const item = JSON.stringify({
      data: { id: "msg_a", sessionID: "ses_a", type: "user", delivery: "steer", payload: { text: "hi" } },
    })
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          state.requests++
          const text = new TextDecoder().decode(data)
          const line = text.split("\r\n")[0] ?? ""
          const key = `${line} ${text.split("\r\n\r\n")[1] ?? ""}`
          if (!state.seen.has(key)) {
            state.seen.add(key)
            return void socket.terminate()
          }
          const body = line.includes("/worktree/") ? "" : /^POST \/api\/session[ ?]/.test(line) ? session : item
          socket.end(
            `HTTP/1.1 ${body === "" ? "204 No Content" : "200 OK"}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
          )
        },
      },
    })
    try {
      const source = SessionHttp.source({
        service: { url: `http://127.0.0.1:${server.port}`, password: "fake" },
        channel: "local",
      })
      const http = SessionHttp.create({ source })
      const ref = { sessionID: "ses_a", directory: "C:\\w" }
      expect(await http.session.create({ id: "ses_a", directory: "C:\\w" })).toMatchObject({ ok: true })
      expect(await http.session.prompt({ ...ref, id: "msg_a", text: "hi" })).toMatchObject({ ok: true })
      expect(await http.session.synthetic({ ...ref, id: "msg_a", text: "hi" })).toMatchObject({ ok: true })
      expect(await http.worktree.refresh({ projectID: "prj_a" })).toMatchObject({ ok: true })
      expect(state.requests).toBe(8)
      // Without an id a second create would make a second conversation: it fails at once.
      expect(await http.session.create({ directory: "C:\\w" })).toMatchObject({ ok: false, type: "unreachable" })
      expect(await http.session.prompt({ ...ref, text: "hi" })).toMatchObject({ ok: false, type: "unreachable" })
      expect(state.requests).toBe(10)
    } finally {
      server.stop(true)
    }
  })

  test("only a loopback http service is used", async () => {
    const source = SessionHttp.source({ service: { url: "http://10.1.2.3:4096", password: "fake" }, channel: "local" })
    const result = await SessionHttp.create({ source }).session.active()
    expect(result).toMatchObject({ ok: false, type: "no_service", status: null })
  })

  test("reads the session log after a cursor and rewrites metadata read-modify-write", async () => {
    const service = start()
    try {
      service.routes.set(
        "GET /api/experimental/session/ses_a/log",
        () =>
          new Response(
            'data: {"type":"session.inbox.delivered","seq":5}\n\n: keep-alive\n\ndata: {"type":"session.idle","seq":6}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      )
      service.routes.set("GET /api/session/ses_a", () =>
        Response.json({ data: session({ id: "ses_a", directory: "C:\\w", metadata: { keep: 1 } }) }),
      )
      service.routes.set("PATCH /api/session/ses_a", () => new Response(null, { status: 204 }))
      const http = SessionHttp.create({ source: service.source })
      const log = await http.session.log({ sessionID: "ses_a", directory: "C:\\w", after: 4 })
      expect(log).toMatchObject({ ok: true, value: [{ seq: 5 }, { seq: 6 }] })
      expect(service.requests[0]!.query).toMatchObject({ after: "4", "location[directory]": "C:\\w" })
      const written = await http.session.metadata({
        sessionID: "ses_a",
        directory: "C:\\w",
        change: (current) => ({ ...current, "own.archived": true }) as never,
      })
      expect(written).toMatchObject({ ok: true, value: { keep: 1, "own.archived": true } })
      expect(service.requests.at(-1)).toMatchObject({
        method: "PATCH",
        body: { metadata: { keep: 1, "own.archived": true } },
      })
    } finally {
      await service.stop()
    }
  })
})
