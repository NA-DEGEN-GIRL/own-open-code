import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Broker } from "../../src/protocol/broker.js"
import { Singleton } from "../../src/singleton.js"

describe("process-lifetime controller (04 §4.1)", () => {
  let home: string
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "own-remote-singleton-"))
  })
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

  const input = (buildId: string, lingerSeconds = 0) => ({
    buildId,
    version: "2.0.18-own.1",
    ownHome: home,
    options: { lingerSeconds, sshCommand: ["C:\\nowhere\\ssh.exe"] },
  })

  test("every plugin instance of a build shares one controller; the last release closes it after the linger", async () => {
    const a = Singleton.acquire(input("singleton-a", 1))
    const b = Singleton.acquire(input("singleton-a", 1))
    expect(a.controller).toBe(b.controller)
    await a.ready
    const lock = path.join(home, "locks", "remote-controller.lock")
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toMatchObject({ pid: process.pid, buildId: "singleton-a" })
    expect((globalThis as Record<symbol, unknown>)[Broker.endpointsKey("singleton-a")]).toBeDefined()
    await a.release()
    await b.release()
    // Still alive during the linger: a new instance (a Location reopening) gets the same controller.
    const c = Singleton.acquire(input("singleton-a", 1))
    expect(c.controller).toBe(a.controller)
    await c.release()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const d = Singleton.acquire(input("singleton-a", 0))
    expect(d.controller).not.toBe(a.controller)
    await d.ready
    await d.release()
    expect(fs.existsSync(lock)).toBe(false)
  }, 20_000)

  test("an overlapping new build waits for the old build's lock", async () => {
    const old = Singleton.acquire(input("singleton-old", 0))
    await old.ready
    const next = Singleton.acquire(input("singleton-new", 0))
    let started = false
    void next.ready.then(() => (started = true))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(started).toBe(false)
    await old.release()
    await next.ready
    expect(started).toBe(true)
    await next.release()
  }, 20_000)

  test("a different OWN_HOME for the same build is refused", async () => {
    const a = Singleton.acquire(input("singleton-home", 0))
    expect(() => Singleton.acquire({ ...input("singleton-home", 0), ownHome: path.join(home, "other") })).toThrow("OWN_HOME")
    await a.ready
    await a.release()
  })
})
