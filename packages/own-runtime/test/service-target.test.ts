// The local service target for self-HTTP and the gateway relay (06 §2.6, §12.2; moved from own-remote in 06 §10.4 #4):
// registration file per channel, loopback-only, mtime cache, fixed plugin-option endpoint, password never exposed.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceTarget } from "../src/index.js"
import { tmpdir } from "./fixture.js"

const PASSWORD = "svc-password-fake-0123456789abcdef"
const BASIC = "Basic b3BlbmNvZGU6c3ZjLXBhc3N3b3JkLWZha2UtMDEyMzQ1Njc4OWFiY2RlZg=="
const ROTATED = "svc-password-fake-rotated"
const ROTATED_BASIC = "Basic b3BlbmNvZGU6c3ZjLXBhc3N3b3JkLWZha2Utcm90YXRlZA=="
/** A whole-second mtime, so rewriting a file and restoring it gives the same `mtimeMs` on every filesystem. */
const MTIME = new Date(Date.UTC(2026, 8, 30, 12, 0, 0))

async function register(file: string, content: unknown, mtime = MTIME) {
  await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
  await fs.utimes(file, mtime, mtime)
}

function registration(url: string, password: unknown = PASSWORD) {
  return { id: "fake", version: "local", url, pid: 1234, password }
}

describe("ServiceTarget.registrationPath", () => {
  test("upstream channels share service.json, others get service-<channel>.json under XDG_STATE_HOME", () => {
    const env = { XDG_STATE_HOME: path.join("x", "state") }
    for (const channel of ["latest", "dev", "beta", "next"])
      expect(ServiceTarget.registrationPath(channel, env)).toBe(path.join("x", "state", "opencode", "service.json"))
    expect(ServiceTarget.registrationPath("own", env)).toBe(path.join("x", "state", "opencode", "service-own.json"))
    expect(ServiceTarget.registrationPath("own/test 1", env)).toBe(
      path.join("x", "state", "opencode", "service-own-test-1.json"),
    )
  })

  test("without XDG_STATE_HOME (or with an empty one) the state dir is ~/.local/state", () => {
    const expected = path.join(os.homedir(), ".local", "state", "opencode", "service-own.json")
    expect(ServiceTarget.registrationPath("own", {})).toBe(expected)
    expect(ServiceTarget.registrationPath("own", { XDG_STATE_HOME: "" })).toBe(expected)
  })
})

describe("ServiceTarget.Service", () => {
  test("a loopback http registration gives the origin and the Basic credential", async () => {
    await using dir = await tmpdir()
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["http://127.0.0.1:4096", "http://127.0.0.1:4096"],
      ["http://127.8.9.10:4096/api/ignored?x=1#y", "http://127.8.9.10:4096"],
      ["http://localhost:4096/", "http://localhost:4096"],
      ["http://[::1]:4096", "http://[::1]:4096"],
    ]
    for (const [index, entry] of cases.entries()) {
      const file = path.join(dir.path, `ok-${index}.json`)
      await register(file, registration(entry[0]))
      expect(await new ServiceTarget.Service(file).current()).toEqual({ url: entry[1], authorization: BASIC })
    }
  })

  test("a byte order mark before the JSON is accepted", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "service-own.json")
    await register(file, `﻿${JSON.stringify(registration("http://127.0.0.1:4096"))}`)
    expect(await new ServiceTarget.Service(file).current()).toEqual({
      url: "http://127.0.0.1:4096",
      authorization: BASIC,
    })
  })

  test("https, another interface, a bad url or a missing password is no target", async () => {
    await using dir = await tmpdir()
    const contents: ReadonlyArray<unknown> = [
      registration("https://127.0.0.1:4096"),
      registration("http://192.168.1.10:4096"),
      registration("http://0.0.0.0:4096"),
      registration("http://example.com:4096"),
      registration("not a url"),
      registration("http://127.0.0.1:4096", ""),
      registration("http://127.0.0.1:4096", 42),
      { url: "http://127.0.0.1:4096" },
      { url: 4096, password: PASSWORD },
      [registration("http://127.0.0.1:4096")],
      `{"url":"http://127.0.0.1:4096","password":"${PASSWORD}"`,
      "",
    ]
    for (const [index, content] of contents.entries()) {
      const file = path.join(dir.path, `bad-${index}.json`)
      await register(file, content)
      expect(await new ServiceTarget.Service(file).current()).toBeUndefined()
    }
    expect(await new ServiceTarget.Service(path.join(dir.path, "missing.json")).current()).toBeUndefined()
  })

  test("the target is cached by mtime until invalidate(); a missing or invalid file is never cached", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "service-own.json")
    const service = new ServiceTarget.Service(file)
    expect(service.file).toBe(file)
    const first = { url: "http://127.0.0.1:4096", authorization: BASIC }
    const rotated = { url: "http://127.0.0.1:4096", authorization: ROTATED_BASIC }

    await register(file, registration("http://127.0.0.1:4096"))
    expect(await service.current()).toEqual(first)
    // Same mtime: the cached target, without reading the file.
    await register(file, registration("http://127.0.0.1:4096", ROTATED))
    expect(await service.current()).toEqual(first)
    // A 401 from the service: read again.
    service.invalidate()
    expect(await service.current()).toEqual(rotated)

    // A new mtime: read again.
    await register(file, registration("http://127.0.0.1:4097"), new Date(MTIME.getTime() + 10_000))
    expect(await service.current()).toEqual({ url: "http://127.0.0.1:4097", authorization: BASIC })

    // Gone: no target and no cache, so the same mtime later is read fresh.
    await fs.rm(file)
    expect(await service.current()).toBeUndefined()
    await register(file, registration("http://127.0.0.1:4096", ROTATED))
    expect(await service.current()).toEqual(rotated)

    // An invalid registration is not cached either: fixed under the same mtime, it is read fresh.
    const later = new Date(MTIME.getTime() + 20_000)
    await register(file, registration("http://192.168.1.10:4096"), later)
    expect(await service.current()).toBeUndefined()
    await register(file, registration("http://127.0.0.1:4096"), later)
    expect(await service.current()).toEqual(first)
  })
})

describe("ServiceTarget.fixed", () => {
  test("the plugin option endpoint is checked like a registration and invalidate() keeps it", async () => {
    const source = ServiceTarget.fixed({ url: "http://127.0.0.1:4096/ignored", password: PASSWORD })
    expect(await source.current()).toEqual({ url: "http://127.0.0.1:4096", authorization: BASIC })
    source.invalidate()
    expect(await source.current()).toEqual({ url: "http://127.0.0.1:4096", authorization: BASIC })
    expect(await ServiceTarget.fixed({ url: "http://localhost:4096", password: PASSWORD }).current()).toEqual({
      url: "http://localhost:4096",
      authorization: BASIC,
    })
  })

  test("https, another interface or an empty password is no target", async () => {
    expect(await ServiceTarget.fixed({ url: "https://127.0.0.1:4096", password: PASSWORD }).current()).toBeUndefined()
    expect(await ServiceTarget.fixed({ url: "http://192.168.1.10:4096", password: PASSWORD }).current()).toBeUndefined()
    expect(await ServiceTarget.fixed({ url: "http://127.0.0.1:4096", password: "" }).current()).toBeUndefined()
    expect(await ServiceTarget.fixed({ url: "127.0.0.1:4096", password: PASSWORD }).current()).toBeUndefined()
  })
})

describe("ServiceTarget.isLoopback and ServiceTarget.basic (shared with own-remote's gateway)", () => {
  test("loopback addresses only: 127/8, ::1 and IPv4-mapped 127, bracketed or not; host names are not addresses", () => {
    const loopback = ["127.0.0.1", "127.255.0.9", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]
    const other = ["localhost", "192.168.0.2", "10.0.0.1", "::2", "::ffff:10.0.0.1", "128.0.0.1", ""]
    for (const address of [...loopback, "[::FFFF:127.1.2.3]"])
      expect({ address, loopback: ServiceTarget.isLoopback(address) }).toEqual({ address, loopback: true })
    for (const address of other)
      expect({ address, loopback: ServiceTarget.isLoopback(address) }).toEqual({ address, loopback: false })
  })

  test("basic is the Basic header of user opencode", () => {
    expect(ServiceTarget.basic(PASSWORD)).toBe(BASIC)
  })
})

describe("password exposure", () => {
  const secrets = [PASSWORD, BASIC.slice("Basic ".length)]

  function expectHidden(value: unknown) {
    for (const text of [String(value), JSON.stringify(value), Bun.inspect(value)])
      for (const secret of secrets) expect(text).not.toContain(secret)
  }

  test("a loaded Service and a fixed source never show the password or the credential", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "service-own.json")
    await register(file, registration("http://127.0.0.1:4096"))
    const service = new ServiceTarget.Service(file)
    expect(await service.current()).toBeDefined()
    expectHidden(service)
    const source = ServiceTarget.fixed({ url: "http://127.0.0.1:4096", password: PASSWORD })
    expect(await source.current()).toBeDefined()
    expectHidden(source)
  })

  test("unreadable or malformed registrations resolve to undefined instead of an error carrying the content", async () => {
    await using dir = await tmpdir()
    const malformed = path.join(dir.path, "malformed.json")
    await register(malformed, `{"url":"http://127.0.0.1:4096","password":"${PASSWORD}",}`)
    expect(await new ServiceTarget.Service(malformed).current()).toBeUndefined()
    const directory = path.join(dir.path, "directory.json")
    await fs.mkdir(directory)
    expect(await new ServiceTarget.Service(directory).current()).toBeUndefined()
  })
})
