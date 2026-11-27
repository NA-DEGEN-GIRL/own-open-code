import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { CodexSource, Credentials, Hash, Refresh, Vault } from "../src/index.js"
import { ACCOUNT_A, account, chatgptTokens, clock, tmpdir, writeAuth } from "./fixture.js"

// Every process test starts Bun or own-vault.exe, and a cold Bun start alone can take seconds on a busy machine.
setDefaultTimeout(30_000)

const FAKE_HELPER = path.join(import.meta.dir, "fixture", "fake-helper.ts")
const ID = "acc_01JAX3ABCDEFGHJKMNPQRSTVWX"
const item = (generation: number) => JSON.stringify({ v: 1, type: "key", key: `fake-key-${generation}`, generation })

// The whole protocol surface, run against any transport.
async function protocolRoundTrip(client: Vault.Client) {
  expect(await client.hello()).toMatchObject({ ok: true, protocol: 1 })
  expect(await client.get(ID)).toEqual({ ok: false, error: "not_found", hasPrev: false })
  expect(await client.put(ID, item(1))).toEqual({ ok: true, generation: 1 })
  expect(await client.put(ID, item(2), { keepPrev: true, ifGeneration: 1 })).toEqual({ ok: true, generation: 2 })
  expect(await client.put(ID, item(3), { ifGeneration: 1 })).toEqual({ ok: false, error: "conflict", generation: 2 })
  expect(await client.get(ID)).toEqual({ ok: true, value: item(2), generation: 2 })
  expect(await client.get(ID, { prev: true })).toEqual({ ok: true, value: item(1), generation: 1 })
  expect(await client.list()).toEqual({ ok: true, ids: [ID] })
  const lease = await client.acquireLease(ID, { pid: process.pid, ttlMs: 60_000 })
  expect(lease).toMatchObject({ ok: true, acquired: true, lease: { pid: process.pid } })
  expect(await client.acquireLease(ID, { pid: process.pid })).toMatchObject({ ok: true, acquired: false })
  if (!lease.ok || !lease.lease) throw new Error("lease expected")
  expect(await client.releaseLease(ID, { pid: process.pid, startedAt: lease.lease.startedAt + 1 })).toEqual({
    ok: true,
    released: false,
  })
  expect(await client.releaseLease(ID, lease.lease)).toEqual({ ok: true, released: true })
  expect(await client.delete(ID, { shred: true })).toEqual({ ok: true, deleted: true })
  expect(await client.delete(ID)).toEqual({ ok: true, deleted: false })
  expect(await client.list()).toEqual({ ok: true, ids: [] })
}

describe("Vault.Client over the in-memory helper", () => {
  test("implements the README §5 protocol", async () => {
    const client = new Vault.Client(Vault.memory())
    expect(client.status()).toBe("unknown")
    await protocolRoundTrip(client)
    expect(client.status()).toBe("ok")
    expect(client.info()).toMatchObject({ name: "own-vault-memory", protocol: 1 })
  })

  test("rejects invalid ids before sending, and reports helper errors as values", async () => {
    const memory = Vault.memory()
    const client = new Vault.Client(memory)
    expect(await client.get("../escape")).toMatchObject({ ok: false, error: "invalid_id" })
    expect(await client.get("CON")).toMatchObject({ ok: false, error: "invalid_id" })
    expect(memory.calls.get("get")).toBeUndefined()
    expect(await client.put(ID, "x".repeat(Vault.MAX_VALUE_BYTES + 1))).toMatchObject({
      ok: false,
      error: "bad_request",
    })
    expect(await client.acquireLease(ID, { pid: 0 })).toMatchObject({ ok: false, error: "bad_request" })
    memory.inject((request) => (request.op === "get" ? { ok: false, error: "busy", message: "mutex held" } : undefined))
    expect(await client.get(ID)).toEqual({ ok: false, error: "busy", message: "mutex held" })
    memory.inject(() => ({ ok: false, error: "future_error" }))
    expect(await client.list()).toEqual({ ok: false, error: "io_error" })
    memory.inject(() => ({ ok: true, surprise: 1 }))
    expect(await client.list()).toMatchObject({ ok: false, error: "unavailable" })
  })

  test("leases of dead or expired owners are taken over", async () => {
    const time = clock()
    const alive = new Set([100])
    const client = new Vault.Client(Vault.memory({ now: time.now, isAlive: (pid) => alive.has(pid) }))
    expect(await client.acquireLease(ID, { pid: 100, ttlMs: 1_000 })).toMatchObject({ acquired: true })
    expect(await client.acquireLease(ID, { pid: 200 })).toMatchObject({ acquired: false, lease: { pid: 100 } })
    time.advance(1_000)
    expect(await client.acquireLease(ID, { pid: 200 })).toMatchObject({ acquired: true, lease: { pid: 200 } })
    alive.delete(200)
    expect(await client.acquireLease(ID, { pid: 100 })).toMatchObject({ acquired: true, lease: { pid: 100 } })
  })

  test("a closed transport is unavailable", async () => {
    const client = new Vault.Client(Vault.memory())
    await client.close()
    expect(await client.list()).toMatchObject({ ok: false, error: "unavailable" })
    expect(client.status()).toBe("unavailable")
  })
})

describe("Vault.spawnHelper (child process transport)", () => {
  const helper = (args: string[] = [], options: Partial<Vault.SpawnOptions> = {}) =>
    new Vault.Client(
      Vault.spawnHelper({
        exePath: process.execPath,
        home: "unused",
        command: [process.execPath, FAKE_HELPER, ...args],
        ...options,
      }),
    )

  test("speaks the protocol over stdio with a minimal environment", async () => {
    const client = helper()
    await protocolRoundTrip(client)
    await client.close()
  })

  test("matches concurrent answers to their requests by rid", async () => {
    const client = helper()
    const puts = await Promise.all(
      Array.from({ length: 20 }, (_, index) => client.put(`acc_${index}`, item(index + 1))),
    )
    expect(puts.map((result) => result.ok && result.generation)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
    await client.close()
  })

  test("answers without rid go to the oldest request", async () => {
    const client = helper(["--no-rid"])
    expect(await client.list()).toEqual({ ok: true, ids: [] })
    await client.close()
  })

  test("a timed-out helper is killed, pending requests fail, and the next request starts a new helper", async () => {
    await using dir = await tmpdir()
    const pidFile = path.join(dir.path, "pid")
    // Long enough for a cold Bun start of the fake helper, which the hello handshake also has to fit in.
    const client = helper(["--hang", "list", "--pid-file", pidFile], { timeoutMs: 4_000 })
    expect(await client.put(ID, item(1))).toMatchObject({ ok: true })
    const first = await fs.readFile(pidFile, "utf8")
    const [listed, got] = await Promise.all([client.list(), client.get(ID)])
    expect(listed).toMatchObject({ ok: false, error: "unavailable" })
    expect(client.status()).toBe("unavailable")
    expect(got.ok).toBe(true)
    // The replacement helper has a fresh in-memory store: state lives in files for the real one.
    expect(await client.get(ID)).toMatchObject({ ok: false, error: "not_found" })
    expect(await fs.readFile(pidFile, "utf8")).not.toBe(first)
    await client.close()
  })

  test("a crashed helper fails its requests and is restarted", async () => {
    const client = helper(["--exit", "delete"])
    expect(await client.delete(ID)).toMatchObject({ ok: false, error: "unavailable" })
    expect(await client.list()).toEqual({ ok: true, ids: [] })
    await client.close()
  })

  test("a helper with another protocol version is refused and backs off after repeated failures", async () => {
    const time = clock()
    const client = helper(["--protocol", "2"], { now: time.now })
    for (const _ of [1, 2, 3]) expect(await client.list()).toMatchObject({ ok: false, error: "unavailable" })
    expect(await client.list()).toMatchObject({ ok: false, message: expect.stringContaining("backoff") })
    await client.close()
  })

  test("a missing executable is unavailable, not a crash", async () => {
    const client = new Vault.Client(
      Vault.spawnHelper({ exePath: path.join("Z:", "missing", "own-vault.exe"), home: "x" }),
    )
    expect(await client.hello()).toMatchObject({ ok: false, error: "unavailable" })
    await client.close()
  })

  test("close ends the helper through stdin EOF and later requests fail", async () => {
    await using dir = await tmpdir()
    const pidFile = path.join(dir.path, "pid")
    const client = helper(["--pid-file", pidFile])
    await client.list()
    const pid = Number(await fs.readFile(pidFile, "utf8"))
    await client.close()
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await client.list()).toMatchObject({ ok: false, error: "unavailable" })
  })
})

const EXE = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "own",
  "native",
  "own-vault",
  "target",
  "release",
  "own-vault.exe",
)
const hasExe = process.platform === "win32" && existsSync(EXE)

describe.skipIf(!hasExe)("own-vault.exe (real DPAPI helper)", () => {
  test("round-trips the protocol and never stores plaintext", async () => {
    await using dir = await tmpdir()
    const client = new Vault.Client(Vault.spawnHelper({ exePath: EXE, home: dir.path }))
    await protocolRoundTrip(client)
    expect(await client.put(ID, item(9))).toMatchObject({ ok: true, generation: 9 })
    const blob = await fs.readFile(path.join(dir.path, "vault", `${ID}.dpapi`))
    expect(blob.toString("latin1")).not.toContain("fake-key-9")
    await client.close()
  })

  test("a damaged blob is decrypt_failed with hasPrev, and .prev stays readable", async () => {
    await using dir = await tmpdir()
    const client = new Vault.Client(Vault.spawnHelper({ exePath: EXE, home: dir.path }))
    await client.put(ID, item(1))
    await client.put(ID, item(2), { keepPrev: true, ifGeneration: 1 })
    await fs.writeFile(path.join(dir.path, "vault", `${ID}.dpapi`), "not a dpapi blob")
    expect(await client.get(ID)).toEqual({ ok: false, error: "decrypt_failed", hasPrev: true })
    expect(await client.get(ID, { prev: true })).toEqual({ ok: true, value: item(1), generation: 1 })
    // A compare-and-swap never guesses over an unreadable value.
    expect(await client.put(ID, item(3), { ifGeneration: 2 })).toMatchObject({ ok: false, error: "decrypt_failed" })
    await client.close()
  })

  test("takeover, then a lease-guarded refresh shared by two helper processes, then shred", async () => {
    await using dir = await tmpdir()
    const time = clock(Date.now())
    const authPath = path.join(dir.path, "control-center", "profiles", "p1", "codex", "auth.json")
    const tokens = chatgptTokens(ACCOUNT_A, time.now() + 60_000)
    await writeAuth(authPath, tokens)
    const source = CodexSource.source(path.join(dir.path, "control-center"), { id: "p1", alias: null })
    const before = await fs.readFile(authPath, "utf8")
    const clients = [0, 1].map(() => new Vault.Client(Vault.spawnHelper({ exePath: EXE, home: dir.path })))
    // Two server processes: each has its own helper and its own lease owner pid (the test process is alive for both).
    const services = clients.map(
      (vault) =>
        new Credentials.Service({ vault, now: time.now, secretCacheSeconds: 0, refresh: { pollMs: [20, 50] } }),
    )
    const takeover = account("codex", {
      identity: {
        chatgptAccountId: ACCOUNT_A.accountId,
        fingerprint: Hash.fingerprint(ACCOUNT_A.accountId, ACCOUNT_A.sub),
      },
      credential: { type: "takeover-codex-source", source, takenOverAt: "2026-09-27T03:00:00Z" },
    })
    const [first, second] = services
    if (!first || !second) throw new Error("two services expected")
    expect(await first.takeover(takeover.id, source, { expected: Credentials.expectedOf(takeover) })).toMatchObject({
      ok: true,
      generation: 1,
    })
    const calls: string[] = []
    const refresher: Refresh.Refresher = async (current) => {
      calls.push(current.refresh)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const next = chatgptTokens(ACCOUNT_A, time.now() + 3_600_000)
      return { type: "tokens", access: next.accessToken, refresh: next.refreshToken, expiresAt: time.now() + 3_600_000 }
    }
    // Due within 5 minutes: both processes want to refresh at once; only one may call the token endpoint.
    const results = await Promise.all(
      services.map((service) => service.headersFor({ account: takeover, sessionID: "ses_test", refresher })),
    )
    expect(results.map((result) => result.ok)).toEqual([true, true])
    expect(calls).toEqual([tokens.refreshToken])
    const headers = results.map((result) => result.ok && result.headers.authorization)
    expect(headers[0]).toBe(headers[1])
    expect(headers[0]).not.toBe(`Bearer ${tokens.accessToken}`)
    expect(await first.inspect(takeover)).toMatchObject({ ok: true, type: "oauth", generation: 2 })
    const files = await fs.readdir(path.join(dir.path, "vault"))
    expect(files).toEqual(expect.arrayContaining([`${takeover.id}.dpapi`, `${takeover.id}.dpapi.prev`]))
    expect(files.some((file) => file.endsWith(".lock"))).toBe(false)
    // The source is only ever read.
    expect(await fs.readFile(authPath, "utf8")).toBe(before)
    expect(await second.remove(takeover)).toEqual({ ok: true, deleted: true })
    expect(await fs.readdir(path.join(dir.path, "vault"))).not.toContain(`${takeover.id}.dpapi.prev`)
    expect(await fs.readFile(authPath, "utf8")).toBe(before)
    await Promise.all(clients.map((client) => client.close()))
  })

  // 02 §3.2b: a key the old app saved (DPAPI CurrentUser, no entropy; written here by .NET ProtectedData the way the
  // old app's ctypes call does) is decrypted in memory by `linked.get`, read-only. Fake key only.
  test("linked.get reads an old-app key file read-only; the reader follows a replaced key", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "codex-multi-provider", "profiles", "deepseek.dpapi")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const protect = (value: string) => {
      const script =
        "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
        "$v=[Text.Encoding]::UTF8.GetBytes($env:OWN_FAKE_KEY); " +
        "[IO.File]::WriteAllBytes($env:OWN_FAKE_FILE,[Security.Cryptography.ProtectedData]::Protect($v,$null," +
        "[Security.Cryptography.DataProtectionScope]::CurrentUser))"
      const run = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
        env: { ...process.env, OWN_FAKE_KEY: value, OWN_FAKE_FILE: file },
      })
      if (run.exitCode !== 0) throw new Error(`powershell failed: ${run.stderr.toString()}`)
    }
    protect("sk-fake-legacy-000000000000000000000000")
    const blob = await fs.readFile(file)
    const client = new Vault.Client(Vault.spawnHelper({ exePath: EXE, home: dir.path }))
    expect(await client.hello()).toMatchObject({ ok: true, ops: expect.arrayContaining(["linked.get"]) })
    expect(await client.linkedGet(file)).toMatchObject({
      ok: true,
      value: "sk-fake-legacy-000000000000000000000000",
      size: blob.byteLength,
    })
    expect(await client.get("acc_COPY")).toMatchObject({ ok: false, error: "not_found" })
    const time = clock(Date.now())
    const service = new Credentials.Service({ vault: client, now: time.now })
    const linked = account("oai", {
      credential: {
        type: "linked-legacy-key",
        source: { app: "codex-multi-provider", providerRef: "legacy:deepseek", name: "DeepSeek", path: file },
        linkedAt: "2026-09-28T00:00:00Z",
      },
    })
    const first = await service.headersFor({ account: linked, sessionID: "ses_test" })
    expect(first.ok && first.headers.authorization).toBe("Bearer sk-fake-legacy-000000000000000000000000")
    // The old app saves a new key (its atomic replace): the next stat sees it and the helper decrypts the new file.
    protect("sk-fake-legacy-111111111111111111111111")
    const later = new Date(Date.now() + 5_000)
    await fs.utimes(file, later, later)
    time.advance(1_000)
    const second = await service.headersFor({ account: linked, sessionID: "ses_test" })
    expect(second.ok && second.headers.authorization).toBe("Bearer sk-fake-legacy-111111111111111111111111")
    expect(await service.remove(linked)).toEqual({ ok: true, deleted: false })
    expect(await fs.readdir(path.dirname(file))).toEqual(["deepseek.dpapi"])
    expect(await fs.readdir(path.join(dir.path, "vault"))).not.toContain("deepseek.dpapi")
    expect(await client.linkedGet(path.join(dir.path, "vault", ".own-vault.mutex"))).toMatchObject({
      ok: false,
      error: "path_denied",
    })
    await client.close()
  })
})
