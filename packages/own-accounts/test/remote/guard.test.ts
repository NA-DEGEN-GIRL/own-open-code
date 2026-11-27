// Guard 1 of the remote mode (04 §9.1): `OWN_REMOTE=1` on top of the version and `OWN_OPEN_CODE=1`, and only a
// mirror of this schema version is ever loaded as the registry; a remote service refuses account changes.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Broker } from "@own/protocol"
import { Guard } from "../../src/health/guard.js"
import { RemoteMirror } from "../../src/remote/mirror.js"
import { REMOTE_MANAGED, remoteHandlers } from "../../src/rpc/register.js"
import type { RpcTypes } from "../../src/rpc/types.js"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe("remote guard", () => {
  test("mode remote needs OWN_REMOTE=1; local mode does not", () => {
    const env = { OWN_OPEN_CODE: "1" }
    expect(Guard.check({ appVersion: "local", env }).guard).toBe("ok")
    expect(Guard.check({ appVersion: "local", env, mode: "remote" })).toMatchObject({ guard: "unmanaged" })
    expect(Guard.check({ appVersion: "local", env: { ...env, OWN_REMOTE: "1" }, mode: "remote" }).guard).toBe("ok")
    expect(Guard.check({ appVersion: "other", env: { ...env, OWN_REMOTE: "1" }, mode: "remote" }).guard).toBe("skew")
  })

  test("an accounts.json that is not a mirror of this schema is set aside before the modules load it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-remote-guard-"))
    dirs.push(dir)
    const file = path.join(dir, "accounts.json")
    expect(await RemoteMirror.prepare(file)).toBe("none")
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, revision: 3, accounts: [] }))
    expect(await RemoteMirror.prepare(file)).toBe("moved")
    expect(await fs.readdir(dir)).toEqual([expect.stringMatching(/^accounts\.json\.not-mirror-\d+$/)])
    const mirror = {
      schemaVersion: 1,
      revision: 3,
      accounts: [],
      mirror: { schemaVersion: Broker.MIRROR_SCHEMA_VERSION, from: "own-x", registryRevision: 3, policyRevision: 1, ratecardsRevision: 2, fetchedAt: 1 },
    }
    await fs.writeFile(file, JSON.stringify(mirror))
    expect(await RemoteMirror.prepare(file)).toBe("ok")
    await fs.writeFile(file, JSON.stringify({ ...mirror, mirror: { ...mirror.mirror, schemaVersion: 99 } }))
    expect(await RemoteMirror.prepare(file)).toBe("moved")
  })

  test("account, policy, rate card and Claude slot changes answer remote_managed", async () => {
    const calls: string[] = []
    const all = new Proxy({} as RpcTypes.Handlers, {
      get: (_target, method: string) => async () => {
        calls.push(method)
        return {}
      },
      ownKeys: () => ["accounts.list", ...REMOTE_MANAGED],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    })
    const handlers = remoteHandlers(all)
    const context = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    for (const method of REMOTE_MANAGED) {
      const handler = handlers[method] as unknown as (input: unknown, context: unknown) => Promise<unknown>
      expect(await handler({}, context)).toEqual({ type: "remote_managed", message: `${method} is managed on the local PC`, data: { method } })
    }
    expect(calls).toEqual([])
    expect(REMOTE_MANAGED).toContain("accounts.update")
    expect(REMOTE_MANAGED).not.toContain("accounts.list" as never)
  })
})
