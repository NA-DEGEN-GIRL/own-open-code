// The own.computer handlers over a FakeDriver desktop, registered through a fake `ctx.rpc` that records handlers and
// emitted events.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { SessionID } from "@opencode/schema/session-id"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { Effect, Exit, Scope } from "effect"
import { Audit } from "../../src/core/audit.js"
import { FakeDriver } from "../../src/driver/fake.js"
import { Options } from "../../src/options.js"
import { ComputerRpc } from "../../src/rpc.js"
import { Desktop } from "../../src/singleton.js"

type Handler = (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>

function rpc() {
  const registered: Array<{
    readonly id: string
    readonly methods: Array<string>
    readonly handlers: Record<string, Handler>
  }> = []
  const events: Array<readonly [string, unknown]> = []
  const ctx = {
    rpc: {
      register: (definition: { id: string; methods: Record<string, unknown> }, handlers: Record<string, Handler>) =>
        Effect.sync(() => {
          registered.push({ id: definition.id, methods: Object.keys(definition.methods), handlers })
          return {
            dispose: Effect.void,
            events: { emit: (name: string, data: unknown) => Effect.sync(() => void events.push([name, data])) },
          }
        }),
    },
  } as unknown as Pick<Context, "rpc">
  return { ctx, registered, events }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => item()))
})

async function setup(options: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "own-cu-rpc-"))
  const driver = await Effect.runPromise(FakeDriver.make({ displays: FakeDriver.DISPLAYS.single }))
  const created = Desktop.create(Options.decode({ ...options, driver: "fake", home }), driver)
  const env = rpc()
  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(
    ComputerRpc.register(env.ctx, created.desktop, { buildId: "b1", version: "9.9.9" }).pipe(Scope.provide(scope)),
  )
  cleanup.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await Effect.runPromise(created.close)
    rmSync(home, { recursive: true, force: true })
  })
  const handlers = env.registered[0]!.handlers
  const call = (method: string, input: unknown = {}) => Effect.runPromise(handlers[method]!(input, {}))
  return { ...env, driver, desktop: created.desktop, home, call }
}

const SESSION = SessionID.make("ses_rpc_test_session_aaaaaaaa")

describe("own.computer handlers", () => {
  test("every method of the definition is handled", async () => {
    const env = await setup()
    expect(env.registered.map((item) => item.id)).toEqual([OwnComputer.ID])
    expect(Object.keys(env.registered[0]!.handlers).sort()).toEqual(Object.keys(OwnComputer.Definition.methods).sort())
  })

  test("status, Stop button and reset; held input is released and a status event goes out", async () => {
    const env = await setup()
    expect(await env.call("status")).toEqual({
      available: true,
      buildId: "b1",
      version: "9.9.9",
      driver: "fake",
      approval: "session",
      policy: { allowApps: [], denyApps: [], allowTerminals: false, allowSubagents: false },
      helper: { running: true, version: "fake", protocol: 1, killChord: true },
      killSwitch: { engaged: false },
      lease: { holder: null },
      grants: [],
    })
    await Effect.runPromise(env.driver.button("left", "down"))
    expect(await env.call("killswitch.engage")).toMatchObject({ engaged: true, reason: "rpc" })
    expect(env.driver.held().buttons).toEqual([])
    expect(await env.call("killswitch.reset")).toEqual({ engaged: false })
    await Bun.sleep(20)
    expect(env.events.filter(([name]) => name === "status").length).toBeGreaterThanOrEqual(2)
    expect(env.events.at(-1)).toEqual(["status", expect.objectContaining({ killSwitch: { engaged: false } })])
  })

  test("status reports the app policy of the options with normalized names", async () => {
    const env = await setup({
      approval: "question",
      policy: { allowApps: ["Notepad.EXE", "C:\\x\\Paint.exe", "notepad"], denyApps: ["Chrome"], allowSubagents: true },
    })
    expect(await env.call("status")).toMatchObject({
      approval: "question",
      policy: { allowApps: ["notepad", "paint"], denyApps: ["chrome"], allowTerminals: false, allowSubagents: true },
    })
  })

  test("session grants are normalized app names; revoke removes some or all", async () => {
    const env = await setup()
    expect(
      await env.call("session.grants.set", {
        sessionID: SESSION,
        apps: ["Notepad.EXE", "C:\\x\\paint.exe", "notepad"],
      }),
    ).toEqual({
      sessionID: SESSION,
      apps: ["notepad", "paint"],
    })
    expect(await env.call("session.grants.revoke", { sessionID: SESSION, apps: ["PAINT"] })).toEqual({
      sessionID: SESSION,
      apps: ["notepad"],
    })
    expect(await env.call("session.grants.get", { sessionID: SESSION })).toEqual({
      sessionID: SESSION,
      apps: ["notepad"],
    })
    expect(await env.call("session.grants.revoke", { sessionID: SESSION })).toEqual({ sessionID: SESSION, apps: [] })
    expect(env.desktop.grants.size).toBe(0)
  })

  test("audit.list reads the audit directory under OWN_HOME; helper.restart reports the helper", async () => {
    const env = await setup()
    const entry = {
      ts: 1_000,
      sessionID: SESSION,
      callID: "c1",
      tool: "screenshot",
      args: {},
      outcome: "ok",
      ms: 3,
    } as const
    await Effect.runPromise(Audit.append(path.join(env.home, "audit"), entry))
    await Effect.runPromise(Audit.append(path.join(env.home, "audit"), { ...entry, ts: 2_000, sessionID: "ses_other" }))
    expect(await env.call("audit.list", { sessionID: SESSION })).toEqual({ entries: [entry] })
    expect(((await env.call("audit.list", { limit: 1 })) as { entries: Array<unknown> }).entries).toHaveLength(1)
    expect(await env.call("helper.restart")).toEqual({ running: true, version: "fake", protocol: 1, killChord: true })
  })

  test("an unavailable plugin serves only status", async () => {
    const env = rpc()
    const status = { available: false, reason: "unmanaged", buildId: "dev", version: "0.0.0-dev" } as const
    await Effect.runPromise(Effect.scoped(ComputerRpc.registerUnavailable(env.ctx, status)))
    expect(env.registered.map((item) => [item.id, item.methods])).toEqual([[OwnComputer.ID, ["status"]]])
    expect(await Effect.runPromise(env.registered[0]!.handlers.status!({}, {}))).toEqual(status)
  })
})
