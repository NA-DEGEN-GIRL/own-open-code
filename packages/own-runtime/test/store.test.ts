import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Policy, Preset, Registry } from "@own/protocol"
import { Fsx, Home, Lock, Store } from "../src/index.js"
import { account, tmpdir } from "./fixture.js"

describe("Fsx", () => {
  test("writeAtomic replaces content and leaves no temp files", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "nested", "value.json")
    await Fsx.writeAtomic(file, "one")
    await Fsx.writeAtomic(file, "two")
    expect(await fs.readFile(file, "utf8")).toBe("two")
    expect(await fs.readdir(path.dirname(file))).toEqual(["value.json"])
  })

  test("writeAtomic waits out a reader holding the target open", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "held.json")
    await Fsx.writeAtomic(file, "old")
    const reader = await fs.open(file, "r")
    const write = Fsx.writeAtomic(file, "new")
    setTimeout(() => void reader.close(), 100)
    await write
    expect(await fs.readFile(file, "utf8")).toBe("new")
  })

  test("readBounded and readText strip a BOM and report missing or oversized files", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "bom.json")
    await fs.writeFile(file, "\uFEFF{}")
    expect(await Fsx.readText(file)).toBe("{}")
    expect(await Fsx.readText(path.join(dir.path, "none"))).toBeUndefined()
    expect(await Fsx.readBounded(file, 100)).toMatchObject({ type: "ok", text: "{}" })
    expect(await Fsx.readBounded(file, 2)).toMatchObject({ type: "too_large" })
    expect(await Fsx.readBounded(path.join(dir.path, "none"), 10)).toEqual({ type: "missing" })
  })
})

// Windows refuses to remove a file that another process (the indexer, antivirus) holds open without delete sharing.
describe.skipIf(process.platform !== "win32")("Fsx.removeTree with a file another process holds (Windows)", () => {
  test(
    "waits until the holder lets go",
    async () => {
      await using dir = await tmpdir()
      const tree = path.join(dir.path, "tree")
      const file = path.join(tree, "sub", "held.txt")
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, "x")
      // Windows PowerShell opens the file without sharing, says so, and closes it on a line from stdin.
      const holder = Bun.spawn(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$s = [IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'None'); 'ready'; [void][Console]::In.ReadLine(); $s.Close()`,
        ],
        { stdin: "pipe", stdout: "pipe", windowsHide: true },
      )
      await holder.stdout.getReader().read()
      await expect(fs.rm(tree, { recursive: true, force: true })).rejects.toMatchObject({ code: "EBUSY" })
      const removing = Fsx.removeTree(tree)
      setTimeout(() => {
        holder.stdin.write("\n")
        void holder.stdin.end()
      }, 150)
      await removing
      expect(fsSync.existsSync(tree)).toBe(false)
      await holder.exited
    },
    // Windows PowerShell can take seconds to start on a loaded machine.
    30_000,
  )
})

describe("Lock", () => {
  test("mutex runs sections in order and survives a failing section", async () => {
    const mutex = new Lock.Mutex()
    const order: number[] = []
    const first = mutex.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push(1)
    })
    const failing = mutex.run(async () => {
      order.push(2)
      throw new Error("boom")
    })
    const third = mutex.run(async () => order.push(3))
    await first
    await expect(failing).rejects.toThrow("boom")
    await third
    expect(order).toEqual([1, 2, 3])
  })

  test("a lease file excludes a second holder until released", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "locks", "registry.lock")
    const lease = await Lock.acquire(file)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      pid: process.pid,
      until: lease.startedAt + 60_000,
    })
    await expect(Lock.acquire(file, { timeoutMs: 50 })).rejects.toBeInstanceOf(Lock.TimeoutError)
    expect(await Lock.release(file, lease)).toBe(true)
    expect(await Lock.release(file, lease)).toBe(false)
    const again = await Lock.acquire(file, { timeoutMs: 50 })
    await Lock.release(file, again)
  })

  test("stale leases (expired, dead pid, corrupt and old) are broken", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "registry.lock")
    const now = Date.now()
    await fs.writeFile(
      file,
      JSON.stringify({ pid: process.pid, startedAt: now - 120_000, until: now - 60_000, token: "t" }),
    )
    await Lock.release(file, await Lock.acquire(file, { timeoutMs: 50 }))
    await fs.writeFile(file, JSON.stringify({ pid: 424242, startedAt: now, until: now + 60_000, token: "t" }))
    await Lock.release(file, await Lock.acquire(file, { timeoutMs: 50, isAlive: () => false }))
    await fs.writeFile(file, "garbage")
    await fs.utimes(file, new Date(now - 120_000), new Date(now - 120_000))
    await Lock.release(file, await Lock.acquire(file, { timeoutMs: 50 }))
    await fs.writeFile(file, "garbage")
    await expect(Lock.acquire(file, { timeoutMs: 50 })).rejects.toBeInstanceOf(Lock.TimeoutError)
    expect(await fs.readdir(dir.path)).toEqual(["registry.lock"])
  })

  test("another process's lease blocks until that process dies, then is broken", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "registry.lock")
    const child = spawn(process.execPath, [path.join(import.meta.dir, "fixture", "hold-lock.ts"), file, "60000"], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()))
    const holder = JSON.parse(await fs.readFile(file, "utf8"))
    expect(holder.pid).toBe(child.pid)
    await expect(Lock.acquire(file, { timeoutMs: 100 })).rejects.toBeInstanceOf(Lock.TimeoutError)
    const exited = new Promise((resolve) => child.once("exit", resolve))
    child.kill()
    await exited
    const lease = await Lock.acquire(file, { timeoutMs: 2_000 })
    expect(lease.pid).toBe(process.pid)
    await Lock.release(file, lease)
  })
})

describe("Store", () => {
  const shared = (root: string) => ({ layout: Home.layout(root), mutex: new Lock.Mutex() })

  test("accounts.json starts empty, bumps revision on every write, and keeps unknown fields", async () => {
    await using dir = await tmpdir()
    const registry = Store.accounts(shared(dir.path))
    expect(await registry.read()).toEqual(Store.emptyRegistry())
    await expect(fs.stat(path.join(dir.path, "accounts.json"))).rejects.toThrow()
    const first = await registry.update((file) => ({ ...file, accounts: [account("codex")] }))
    expect(first.revision).toBe(1)
    const raw = JSON.parse(await fs.readFile(registry.file, "utf8"))
    raw.futureField = { keep: true }
    raw.accounts[0].futureAccountField = 7
    await fs.writeFile(registry.file, JSON.stringify(raw))
    const second = await registry.update((file) => ({
      ...file,
      accounts: file.accounts.map((item) => ({ ...item, label: "업무" })),
    }))
    expect(second.revision).toBe(2)
    const saved = JSON.parse(await fs.readFile(registry.file, "utf8"))
    expect(saved.futureField).toEqual({ keep: true })
    expect(saved.accounts[0]).toMatchObject({ label: "업무", futureAccountField: 7 })
    expect(Store.accountFor(second, "own-codex-7k2m")?.id).toBe(account("codex").id)
    expect(Store.accountFor(second, "own-codex-zzzz")).toBeUndefined()
  })

  test("a watcher woken by the rename knows the value being written; cached() stays what was read or written", async () => {
    // own-accounts' StoreWatch compares the file with this process's values to tell another process's change from its
    // own. With only cached(), set after the rename, a loop busy past the watcher's debounce announced its own registry
    // write a second time.
    await using dir = await tmpdir()
    const registry = Store.accounts(shared(dir.path))
    await registry.update((file) => ({ ...file, accounts: [account("codex")] }))
    const seen: Array<{ readonly writing: number | undefined; readonly cached: number | undefined }> = []
    const watcher = fsSync.watch(dir.path, (_event, name) => {
      if (name === "accounts.json")
        seen.push({ writing: registry.writing()?.revision, cached: registry.cached()?.revision })
    })
    for (const label of ["a", "b", "c", "d", "e"])
      await registry.update((file) => ({ ...file, accounts: [account("codex", { label })] }))
    await Bun.sleep(200)
    watcher.close()
    // Every event of a write knew that write's revision (2…6) while cached() still had the one before it.
    expect(seen.length).toBeGreaterThan(0)
    const known = seen.map((item) => item.writing ?? item.cached ?? 0)
    expect(known.every((revision) => revision >= 2 && revision <= 6)).toBe(true)
    expect(known).toEqual([...known].sort((a, b) => a - b))
    expect(registry.writing()).toBeUndefined()
    expect(registry.cached()?.revision).toBe(6)
  })

  test("an unchanged update does not write", async () => {
    await using dir = await tmpdir()
    const registry = Store.accounts(shared(dir.path))
    await registry.update((file) => ({ ...file, accounts: [account("anth")] }))
    const before = await fs.stat(registry.file)
    expect((await registry.update(() => undefined)).revision).toBe(1)
    expect((await registry.update((file) => file)).revision).toBe(1)
    expect((await fs.stat(registry.file)).mtimeMs).toBe(before.mtimeMs)
  })

  test("normalize upgrades what is read before a change sees it; the file keeps its shape until a write", async () => {
    await using dir = await tmpdir()
    const file = new Store.JsonFile({
      file: path.join(dir.path, "shape.json"),
      schema: Schema.Struct({ version: Schema.Literals([1, 2]), items: Schema.Array(Schema.String) }),
      fallback: () => ({ version: 2 as const, items: [] }),
      // Version 1 kept a placeholder item that version 2 drops.
      normalize: (value) =>
        value.version === 1 ? { version: 2 as const, items: value.items.filter((item) => item !== "-") } : value,
    })
    expect(await file.read()).toEqual({ version: 2, items: [] })
    await fs.writeFile(file.file, JSON.stringify({ version: 1, items: ["-", "a"] }))
    expect(await file.read()).toEqual({ version: 2, items: ["a"] })
    expect(JSON.parse(await fs.readFile(file.file, "utf8")).version).toBe(1)
    // The change gets the upgraded value; leaving it as given writes nothing.
    const seen: unknown[] = []
    await file.update((current) => {
      seen.push(current)
      return current
    })
    expect(seen).toEqual([{ version: 2, items: ["a"] }])
    expect(JSON.parse(await fs.readFile(file.file, "utf8")).version).toBe(1)
    await file.update((current) => ({ ...current, items: [...current.items, "b"] }))
    expect(JSON.parse(await fs.readFile(file.file, "utf8"))).toEqual({ version: 2, items: ["a", "b"] })
  })

  test("concurrent updates from two store instances serialize through the lock file", async () => {
    await using dir = await tmpdir()
    const one = Store.accounts(shared(dir.path))
    const two = Store.accounts(shared(dir.path))
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? one : two).update((file) => ({
          ...file,
          accounts: [...file.accounts, account("codex", { label: `n${index}` })],
        })),
      ),
    )
    const final = await one.read()
    expect(final.revision).toBe(10)
    expect(final.accounts).toHaveLength(10)
  })

  test("a corrupt or invalid file is reported and never overwritten", async () => {
    await using dir = await tmpdir()
    const registry = Store.accounts(shared(dir.path))
    await fs.writeFile(registry.file, "{not json")
    await expect(registry.read()).rejects.toMatchObject({ reason: "parse_failed" })
    await expect(registry.update((file) => file)).rejects.toBeInstanceOf(Store.StoreError)
    await fs.writeFile(registry.file, JSON.stringify({ ...Store.emptyRegistry(), schemaVersion: 2 }))
    await expect(registry.read()).rejects.toMatchObject({ reason: "invalid" })
    expect(JSON.parse(await fs.readFile(registry.file, "utf8")).schemaVersion).toBe(2)
  })

  test("policy defaults, trust approvals and the ratecards seed", async () => {
    await using dir = await tmpdir()
    const files = shared(dir.path)
    expect(await Store.policy(files).read()).toEqual(Policy.defaults)
    await Store.policy(files).update((policy) => ({ ...policy, secretCacheSeconds: 0 }))
    expect((await Store.policy(files).read()).secretCacheSeconds).toBe(0)

    const trust = Store.trust(files)
    expect(await trust.read()).toEqual([])
    const entry = { location: "D:\\proj", source: "x.ts", sha256: "a".repeat(64), approvedAt: "2026-09-27T00:00:00Z" }
    await trust.update((list) => [...list, entry])
    expect(await Store.trust(files).read()).toEqual([entry] satisfies Registry.TrustFile)

    expect((await Store.ratecards(files).read()).cards).toEqual([])
    const seed = path.join(import.meta.dir, "..", "..", "..", "own", "config", "ratecards.default.json")
    const seeded = await Store.ratecards(files, seed).read()
    expect(seeded.cards.length).toBeGreaterThan(3)
    expect(seeded.cards.some((card) => card.match.kind === "codex")).toBe(true)
  })

  test("presets.json is empty until written and keeps fields of a later shape (07 §8.1)", async () => {
    await using dir = await tmpdir()
    const files = shared(dir.path)
    const presets = Store.presets(files)
    expect(presets.file).toBe(path.join(dir.path, "presets.json"))
    expect(await presets.read()).toEqual(Preset.empty())
    await fs.writeFile(
      presets.file,
      JSON.stringify({ version: 1, groups: { codex: { star: "builtin:codex" } }, ultraCaps: "large" }),
    )
    const defaultModel = Schema.decodeUnknownSync(Preset.DefaultModel)({ id: "gpt-6-astra", source: "auto" })
    await presets.update((file) => ({
      ...file,
      groups: { ...file.groups, codex: { ...file.groups.codex, defaultModel } },
    }))
    expect(JSON.parse(await fs.readFile(presets.file, "utf8"))).toEqual({
      version: 2,
      groups: { codex: { star: "builtin:codex", defaultModel: { id: "gpt-6-astra", source: "auto" } } },
      ultraCaps: "large",
    })
  })

  test("presets.json version 1: a conversation cap of exactly 100 reads as none and is written so (SC-1)", async () => {
    await using dir = await tmpdir()
    const presets = Store.presets(shared(dir.path))
    const preset = (id: string, perSession: number | null) =>
      Schema.decodeUnknownSync(Preset.Info)({
        ...Preset.builtin("codex"),
        id,
        name: id,
        caps: { concurrent: 3, perMessage: 6, perSession },
      })
    const ids = ["pr_01JB0000000000000000000001", "pr_01JB0000000000000000000002"] as const
    await fs.writeFile(
      presets.file,
      JSON.stringify({ version: 1, groups: { codex: { presets: [preset(ids[0], 100), preset(ids[1], 40)] } } }),
    )
    const caps = (file: Preset.File) => file.groups.codex?.presets?.map((item) => item.caps.perSession)
    expect(caps(await presets.read())).toEqual([null, 40])
    // The file keeps version 1 until a change writes it; the write is version 2.
    expect(JSON.parse(await fs.readFile(presets.file, "utf8")).version).toBe(1)
    await presets.update((file) => ({ ...file, ultraCaps: "save" }))
    const written = JSON.parse(await fs.readFile(presets.file, "utf8"))
    expect(written.version).toBe(2)
    expect(written.groups.codex.presets.map((item: Preset.Info) => item.caps.perSession)).toEqual([null, 40])
    // A cap of 100 set in version 2 is the user's and stays.
    await presets.update((file) => ({ ...file, groups: { codex: { presets: [preset(ids[0], 100)] } } }))
    expect(caps(await Store.presets(shared(dir.path)).read())).toEqual([100])
    // A version 1 value written as it is (an older build's shape) is written as version 2.
    await presets.write({ version: 1, groups: { codex: { presets: [preset(ids[1], 100)] } } })
    expect(JSON.parse(await fs.readFile(presets.file, "utf8")).version).toBe(2)
    expect(caps(await presets.read())).toEqual([null])
  })
})
