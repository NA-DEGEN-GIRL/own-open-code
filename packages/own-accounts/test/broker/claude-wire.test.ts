// T3 (04 §8.11.5): the PC relay's claude-auth loader. It must return the instance core already imported (same file,
// same module state), refuse an instance without an active account (`wire`) and an install whose exports differ
// (`incompatible`), and never expose or log the account object. Fake shim only.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClaudeWire } from "../../src/broker/claude-wire.js"
import { writeFakeClaudeAuth, type FakeState } from "../support/fake-claude-auth.js"

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-claude-wire-")))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const FAKE_TOKEN = "sk-ant-oat01-ownWireTestFakeToken0001"
/** The state folder own names to every module it loads (`ownUseStateDir`). */
const STATE = path.join(root, "state")

async function install(name: string, omit?: ReadonlyArray<string>) {
  const shim = writeFakeClaudeAuth(path.join(root, name, "claude-auth"), { omit })
  // Core loads the shim first (`server.js` re-exports the package); the loader must reach that same instance.
  const plugin: { default: { id: string } } = await import(shim.entry)
  const module: { fake: FakeState } = await import(shim.module)
  return { ...shim, plugin, fake: module.fake }
}

describe("ClaudeWire.load", () => {
  test("the instance core imported, with an active account: the relay gets its three exports", async () => {
    const shim = await install("ok")
    expect(shim.plugin.default.id).toBe("heymaaz.claude-auth-v2")
    shim.fake.account = { source: "fake", token: FAKE_TOKEN }
    const loaded = await ClaudeWire.load(shim.entry, STATE)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(Object.keys(loaded.wire).sort()).toEqual([
      "finishClaudeResponse",
      "injectClaudeIdentity",
      "prepareClaudeRequest",
    ])
    // Same module state: what the wire does is what core's instance records.
    const system: Array<{ type: string; text: string }> = []
    loaded.wire.injectClaudeIdentity({ model: { providerID: "anthropic" }, system })
    expect(shim.fake.calls.inject).toBe(1)
    expect(system).toHaveLength(1)
    // The loaded value carries no account field and no token.
    expect(JSON.stringify(loaded)).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(loaded)).not.toContain("source")
    // The shim directory resolves the same file as its entry.
    const again = await ClaudeWire.load(path.dirname(shim.entry), STATE)
    expect(again.ok).toBe(true)
  })

  test("an instance without an active account is not ready (wire); it never runs on an empty instance", async () => {
    const shim = await install("empty")
    expect(await ClaudeWire.load(shim.entry, STATE)).toEqual({ ok: false, detail: "wire" })
    shim.fake.account = { source: "fake", token: FAKE_TOKEN }
    expect((await ClaudeWire.load(shim.entry, STATE)).ok).toBe(true)
    shim.fake.account = null
    expect(await ClaudeWire.load(shim.entry, STATE)).toEqual({ ok: false, detail: "wire" })
  })

  test("a missing or non-function export is incompatible; no entry or no package is wire", async () => {
    for (const name of ["finishClaudeResponse", "prepareClaudeRequest", "injectClaudeIdentity", "getActiveAccount"]) {
      const shim = await install(`omit-${name}`, [name])
      expect(await ClaudeWire.load(shim.entry, STATE)).toEqual({ ok: false, detail: "incompatible" })
    }
    expect(await ClaudeWire.load(undefined, STATE)).toEqual({ ok: false, detail: "wire" })
    const empty = path.join(root, "no-package")
    fs.mkdirSync(empty, { recursive: true })
    expect(await ClaudeWire.load(path.join(empty, "server.js"), STATE)).toEqual({ ok: false, detail: "wire" })
  })
})

describe("ClaudeWire.multi (02 §8.2)", () => {
  test("a shim without the installed package answers at once and never resolves elsewhere (no auto-install)", async () => {
    const started = performance.now()
    expect(await ClaudeWire.multi(path.join(root, "nowhere", "claude-auth"), STATE)).toBeUndefined()
    expect((await ClaudeWire.load(path.join(root, "nowhere", "claude-auth"), STATE)).ok).toBe(false)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("only a module with the marker and every multi-account export is the patched plugin", async () => {
    const plain = await install("plain")
    expect(await ClaudeWire.multi(plain.entry, STATE)).toBeUndefined()
    const patched = writeFakeClaudeAuth(path.join(root, "patched", "claude-auth"), { multi: true })
    const multi = await ClaudeWire.multi(patched.entry, STATE)
    expect(multi).toBeDefined()
    multi!.bindSession("ses_a", "key-a")
    const module: { fake: FakeState } = await import(patched.module)
    expect(module.fake.bound).toEqual({ ses_a: "key-a" })
    // Every import names own's stable state folder to the module (02 §8.7).
    expect(module.fake.stateDir).toBe(STATE)
    // A patched module that cannot be told the folder would read no list: not the bundle's plugin.
    const old = writeFakeClaudeAuth(path.join(root, "old", "claude-auth"), { multi: true, omit: ["ownUseStateDir"] })
    expect(await ClaudeWire.multi(old.entry, STATE)).toBeUndefined()
  })
})
