import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Home, Runtime, Sessions, Vault } from "../src/index.js"
import { clock, tmpdir } from "./fixture.js"

describe("Sessions.Index", () => {
  test("merges patches, counts bindings and running sessions per provider id", async () => {
    await using dir = await tmpdir()
    const time = clock()
    const index = new Sessions.Index({ file: path.join(dir.path, "sessions.json"), now: time.now })
    index.update("ses_a", { directory: "D:\\work", providerID: "own-codex-aaaa", modelID: "gpt-5.5" })
    index.update("ses_b", { providerID: "own-codex-aaaa", modelID: "gpt-5.5", busy: true })
    index.update("ses_c", { providerID: "own-oai-bbbb", parentID: "ses_a" })
    // `undefined` fields keep what the entry has.
    const updated = index.update("ses_a", { P: 120_000, providerID: undefined })
    expect(updated).toMatchObject({ providerID: "own-codex-aaaa", P: 120_000, directory: "D:\\work", busy: false })
    expect(index.counts("own-codex-aaaa")).toEqual({ running: 1, total: 2 })
    expect(index.counts("own-oai-bbbb")).toEqual({ running: 0, total: 1 })
    expect(index.list({ providerID: "own-oai-bbbb" }).map((entry) => entry.sessionID)).toEqual(["ses_c"])
    expect(index.children("ses_a").map((entry) => entry.sessionID)).toEqual(["ses_c"])
    // A switch moves the session to the other slot.
    index.update("ses_b", { providerID: "own-oai-bbbb" })
    expect(index.counts("own-codex-aaaa")).toEqual({ running: 0, total: 1 })
    index.remove("ses_c")
    expect(index.get("ses_c")).toBeUndefined()
  })

  test("persists bindings without the busy flag and forgets the oldest entries past the cap", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "sessions.json")
    const index = new Sessions.Index({ file, max: 2 })
    index.update("ses_1", { providerID: "own-ds-aaaa" })
    index.update("ses_2", { providerID: "own-ds-aaaa", busy: true, revertStaged: true })
    index.update("ses_3", { providerID: "own-ds-aaaa" })
    expect(index.list().map((entry) => entry.sessionID)).toEqual(["ses_2", "ses_3"])
    expect(await index.save()).toBe(true)
    expect(await index.save()).toBe(false)
    // Only busy changed: nothing to write.
    index.update("ses_3", { busy: true })
    expect(await index.save()).toBe(false)
    const reloaded = new Sessions.Index({ file })
    expect(await reloaded.load()).toBe(true)
    expect(reloaded.get("ses_2")).toMatchObject({ busy: false, revertStaged: true, providerID: "own-ds-aaaa" })
    expect(reloaded.counts("own-ds-aaaa")).toEqual({ running: 0, total: 2 })
    await fs.writeFile(file, "{ not json")
    expect(await new Sessions.Index({ file }).load()).toBe(false)
  })

  test("the runtime shares one index and saves it on the last release", async () => {
    await using dir = await tmpdir()
    const handle = await Runtime.acquire({
      buildId: `sessions-${process.pid}-${Date.now()}`,
      home: dir.path,
      vault: { transport: Vault.memory() },
    })
    handle.sessions.update("ses_x", { providerID: "own-anth-cccc", modelID: "claude-opus-5-5" })
    await handle.release()
    const layout = Home.layout(dir.path)
    expect(JSON.parse(await fs.readFile(layout.sessions, "utf8")).sessions).toEqual([
      expect.objectContaining({ sessionID: "ses_x", providerID: "own-anth-cccc" }),
    ])
    expect(layout.claudeAuth).toBe(path.join(dir.path, "claude-auth.json"))
  })
})
