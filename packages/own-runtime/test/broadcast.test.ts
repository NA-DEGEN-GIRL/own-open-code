import { describe, expect, test } from "bun:test"
import path from "node:path"
import { CodexModels } from "@own/protocol"
import { Broadcast, Runtime, Store, Vault } from "../src/index.js"
import { tmpdir } from "./fixture.js"

describe("Broadcast", () => {
  test("delivers to every listener in order, isolates a throwing listener, and unsubscribes", () => {
    const errors: string[] = []
    const hub = new Broadcast.Hub({ onError: (topic) => errors.push(topic) })
    const seen: string[] = []
    const off = hub.on("store.changed", (payload) => seen.push(`a:${payload.store}`))
    hub.on("store.changed", () => {
      throw new Error("listener bug")
    })
    hub.on("store.changed", (payload) => seen.push(`c:${payload.origin}`))
    hub.emit("store.changed", { store: "accounts", origin: "local" })
    expect(seen).toEqual(["a:accounts", "c:local"])
    expect(errors).toEqual(["store.changed"])
    off()
    expect(hub.size("store.changed")).toBe(2)
    hub.emit("claudeSlot.changed", { reason: "ack" })
  })

  test("a Codex metadata change reaches every instance of the build, with the store file in the layout", async () => {
    await using dir = await tmpdir()
    const buildId = `test-broadcast-meta-${process.pid}`
    const options = { buildId, home: dir.path, vault: { transport: Vault.memory() } }
    const first = await Runtime.acquire(options)
    const second = await Runtime.acquire(options)
    const seen: string[] = []
    second.broadcast.on("store.changed", (payload) => seen.push(`${payload.store}:${payload.origin}`))
    first.broadcast.emit("store.changed", { store: "codex-meta", origin: "local" })
    expect(seen).toEqual(["codex-meta:local"])
    expect(first.layout.codexMeta).toBe(path.join(dir.path, "codex-meta.json"))
    // The store reads as empty until the first fetch writes it, and a written snapshot reads back.
    const file = Store.codexMeta(first.layout)
    expect(await file.read()).toEqual(CodexModels.empty())
    const snapshot = { source: "backend" as const, fetchedAt: 1, etag: 'W/"1"', clientVersion: "0.0.1", models: [] }
    await file.write({ version: 1, kinds: { codex: snapshot } })
    expect(await Store.codexMeta(first.layout).read()).toEqual({ version: 1, kinds: { codex: snapshot } })
    await first.release()
    await second.release()
  })

  test("instances of one build share the hub; the last release clears it", async () => {
    await using dir = await tmpdir()
    const buildId = `test-broadcast-${process.pid}`
    const options = { buildId, home: dir.path, vault: { transport: Vault.memory() } }
    const first = await Runtime.acquire(options)
    const second = await Runtime.acquire(options)
    const seen: string[] = []
    second.broadcast.on("claudeSlot.changed", (payload) => seen.push(payload.reason))
    first.broadcast.emit("claudeSlot.changed", { reason: "detected" })
    expect(seen).toEqual(["detected"])
    const hub = first.broadcast
    await first.release()
    await second.release()
    expect(hub.size("claudeSlot.changed")).toBe(0)
  })
})
