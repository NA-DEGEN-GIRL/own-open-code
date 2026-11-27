import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@own/protocol"
import { Hash, Home } from "@own/runtime"
import { Inventory } from "../../src/plugins/inventory.js"
import { Plugins } from "../../src/plugins/plugins.js"
import { Trust } from "../../src/plugins/trust.js"
import { builtin, call, local, ok, sessionEvent, world, type Entry, type World } from "./support.js"

const PLUGIN_SOURCE = 'export default { id: "x", setup: () => {} }\n'

async function withProjectPlugin(w: World, content = PLUGIN_SOURCE) {
  const file = path.join(w.workspace, ".opencode", "plugins", "x.ts")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content)
  w.project.push(local("x", file))
  return file
}

/** Delivers `plugin.updated` and waits for the re-check it queued (`trust.list` joins the same refresh). */
async function settle(w: World) {
  w.plugins.onEvent?.(sessionEvent("plugin.updated", {}, w.workspace), { local: true })
  await ok(w.plugins.trustList, {})
}

describe("Trust.allowed", () => {
  test("builtin, sdk, own bundles (the Claude bundle among them) and the Claude state folder are allowed", () => {
    const roots = { own: [path.resolve("/own/app/current/plugins")], claude: [path.resolve("/own/thirdparty/claude-auth")] }
    const entry = (source: Entry["source"]): Entry => ({ source, features: {}, state: { status: "active" } })
    expect(Trust.allowed(entry({ type: "builtin" }), roots)).toBe(true)
    expect(Trust.allowed(entry({ type: "sdk" }), roots)).toBe(true)
    expect(
      Trust.allowed(
        entry({ type: "local", path: path.resolve("/own/app/current/plugins/own-accounts/index.js") }),
        roots,
      ),
    ).toBe(true)
    expect(
      Trust.allowed(entry({ type: "local", path: path.resolve("/OWN/thirdparty/claude-auth/server.js") }), roots),
    ).toBe(process.platform === "win32")
    // The bundle the app ships sits in the version's plugin folder (02 §8.2).
    expect(
      Trust.allowed(entry({ type: "local", path: path.resolve("/own/app/current/plugins/claude-auth/server.js") }), roots),
    ).toBe(true)
    expect(Trust.allowed(entry({ type: "local", path: path.resolve("/work/.opencode/plugins/x.ts") }), roots)).toBe(
      false,
    )
    expect(Trust.allowed(entry({ type: "package", target: "some-plugin@1.0.0" }), roots)).toBe(false)
  })

  test("the installed version's bundles (app\\current.json) and the previous version's are allowed, no junction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-pointer-"))
    try {
      const bundle = async (version: string) => {
        const dir = path.join(root, "app", version)
        await fs.mkdir(path.join(dir, "plugins", "own-accounts"), { recursive: true })
        await Bun.write(path.join(dir, "plugins", "own-accounts", "index.js"), "export default {}\n")
        await Bun.write(path.join(dir, "manifest.json"), JSON.stringify({ version }))
        return dir
      }
      const current = await bundle("2.0.18-own.3")
      const previous = await bundle("2.0.18-own.2")
      const older = await bundle("2.0.18-own.1")
      await Bun.write(
        Home.pointerFile(root),
        JSON.stringify({ schema: 1, version: "2.0.18-own.3", previous: "2.0.18-own.2" }),
      )
      const roots = { own: Inventory.ownRoots(Home.layout(root)), claude: [path.join(root, "thirdparty", "claude-auth")] }
      const entry = (file: string): Entry => ({ source: { type: "local", path: file }, features: {}, state: { status: "active" } })
      // What `ctx.plugin.list()` reports for `<OWN_HOME>/app/2.0.18-own.3/plugins/own-accounts`: its entry file.
      expect(Trust.allowed(entry(path.join(current, "plugins", "own-accounts", "index.js")), roots)).toBe(true)
      // A plugin that failed to load (no file) inside the bundle directory.
      expect(Trust.allowed(entry(path.join(current, "plugins", "own-remote", "index.js")), roots)).toBe(true)
      // own-import (09 §5.1) and own-harness, the last own bundle (10 H0), are among them.
      expect(Trust.allowed(entry(path.join(current, "plugins", "own-import", "index.js")), roots)).toBe(true)
      expect(Trust.allowed(entry(path.join(current, "plugins", "own-harness", "index.js")), roots)).toBe(true)
      // The version the pointer replaced (a service of it may still run): allowed; an older one is not.
      expect(Trust.allowed(entry(path.join(previous, "plugins", "own-accounts", "index.js")), roots)).toBe(true)
      expect(Trust.allowed(entry(path.join(older, "plugins", "own-accounts", "index.js")), roots)).toBe(false)
      expect(Trust.allowed(entry(path.join(root, "app", "plugins", "x", "index.js")), roots)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("a bundle loaded from a version folder of the same OWN_HOME allows that version (the one running)", () => {
    const root = path.resolve("/own")
    const layout = { root, app: path.join(root, "app", "2.0.18-own.3"), installed: { previous: undefined } }
    const bundled = path.join(root, "app", "2.0.18-own.1", "plugins", "own-accounts", "index.js")
    expect(Inventory.ownRoots(layout, bundled)).toEqual([
      path.join(root, "app", "2.0.18-own.3", "plugins"),
      path.join(root, "app", "2.0.18-own.1", "plugins"),
    ])
    // A bundle somewhere else does not make its surroundings trusted.
    expect(Inventory.ownRoots(layout, path.resolve("/tmp/x/plugins/own-accounts/index.js"))).toEqual([
      path.join(root, "app", "2.0.18-own.3", "plugins"),
    ])
  })

  test("source runs allow the sibling own packages of this repository", () => {
    const roots = Inventory.ownRoots({ root: path.resolve("/nowhere"), app: path.resolve("/nowhere/app/current") })
    const packages = path.resolve(import.meta.dir, "..", "..", "..")
    expect(roots).toContain(path.join(packages, "own-telemetry"))
    // The computer-use plugin of a development config is ours too (else the Location is blocked_by_plugin).
    expect(roots).toContain(path.join(packages, "own-computer-use"))
    expect(roots).not.toContain(path.join(packages, "core"))
  })

  test("a source run trusts packages/own-import: the entry file the host lists for it is allowed", () => {
    const roots = {
      own: Inventory.ownRoots({ root: path.resolve("/nowhere"), app: path.resolve("/nowhere/app/current") }),
      claude: [path.resolve("/nowhere/thirdparty/claude-auth")],
    }
    const packages = path.resolve(import.meta.dir, "..", "..", "..")
    expect(roots.own).toContain(path.join(packages, "own-import"))
    // `{ "package": "<repo>/packages/own-import" }` is listed by its entry file, `<dir>/server` (plugin host).
    expect(Trust.allowed(local("own.import", path.join(packages, "own-import", "server.ts")), roots)).toBe(true)
    // A sibling folder that only starts with the name is not.
    expect(Trust.allowed(local("x", path.join(packages, "own-import-x", "server.ts")), roots)).toBe(false)
    // packages/own-harness (10 H0) likewise.
    expect(roots.own).toContain(path.join(packages, "own-harness"))
    expect(Trust.allowed(local("own.harness", path.join(packages, "own-harness", "server.ts")), roots)).toBe(true)
  })
})

describe("project plugin allowlist", () => {
  test("an unknown project plugin blocks the Location, raises untrusted_plugin and lists it", async () => {
    await using w = await world()
    const file = await withProjectPlugin(w)
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
    await w.plugins.start()
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
    expect(w.alerts).toEqual([
      expect.objectContaining({ code: "untrusted_plugin", severity: "error", directory: w.workspace }),
    ])
    expect(w.events.filter((event) => event.name === "plugin.trust.changed").map((event) => event.payload)).toEqual([
      expect.objectContaining({ directory: w.workspace, status: "blocked_by_plugin", pending: 1, origin: "global" }),
    ])
    const list = await ok(w.plugins.trustList, {})
    expect(list.locations).toEqual([
      {
        directory: w.workspace,
        status: "blocked_by_plugin",
        plugins: [{ id: "x", source: `local:${file}`, sha256: Hash.sha256(PLUGIN_SOURCE), approved: false }],
      },
    ])
  })

  test("a clean Location is ok; a list from before this generation keeps it blocked", async () => {
    await using w = await world()
    w.override = { entries: [builtin("core")] }
    await w.plugins.start()
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
    expect(w.events.filter((event) => event.name === "plugin.trust.changed")).toEqual([])
    w.override = {}
    await settle(w)
    expect(w.plugins.trustStatus()).toBe("ok")
    expect(w.alerts).toEqual([])
  })

  test("own.import and own.harness loaded last from their bundle folders keep the Location ok and the Claude slot order ok", async () => {
    await using w = await world()
    // The release order (01 §4, 09 §5.1, 10 H0): own.import after own.computer-use, own.harness last, the slot fourth.
    const entries = [
      builtin("core"),
      local("own.accounts", path.join(w.own.accounts, "index.js")),
      local("own.remote", path.join(w.own.root, "own-remote", "index.js")),
      local("own.team", path.join(w.own.root, "own-team", "index.js")),
      local(Plugin.CLAUDE_AUTH_ID, path.join(w.bundleDir, "server.js")),
      local("own.telemetry", path.join(w.own.telemetry, "index.js")),
      local("own.computer-use", path.join(w.own.root, "own-computer-use", "index.js")),
      local("own.import", path.join(w.own.root, "own-import", "index.js")),
      local("own.harness", path.join(w.own.root, "own-harness", "index.js")),
      builtin("post"),
    ]
    w.override = { entries }
    await w.plugins.start()
    await settle(w)
    expect(w.plugins.trustStatus()).toBe("ok")
    expect(Inventory.order(entries)).toBe("ok")
    expect(await ok(w.plugins.trustList, {})).toEqual({
      locations: [{ directory: w.workspace, status: "ok", plugins: [] }],
    })
    expect(w.alerts).toEqual([])
    expect(w.events.filter((event) => event.name === "plugin.trust.changed").map((event) => event.payload)).toEqual([
      expect.objectContaining({ directory: w.workspace, status: "ok", pending: 0 }),
    ])
  })

  test("trustSettled waits for the first check after boot, and fails closed when it never lands", async () => {
    await using w = await world()
    w.override = { entries: [builtin("core")] }
    await w.plugins.start()
    const waiting = w.plugins.trustSettled()
    w.override = {}
    await settle(w)
    expect(await waiting).toBe("ok")
    // Once checked it answers at once.
    expect(await w.plugins.trustSettled()).toBe("ok")

    await using never = await world()
    never.override = { entries: [builtin("core")] }
    await never.plugins.start()
    const pending = never.plugins.trustSettled()
    never.clock.advance(Plugins.TRUST_SETTLE_MS)
    expect(await pending).toBe("blocked_by_plugin")
  })

  test("approve plan → execute writes trust.json and unblocks; a later edit blocks again; revoke blocks", async () => {
    await using w = await world()
    const file = await withProjectPlugin(w)
    await w.plugins.start()
    const source = `local:${file}`

    expect(
      await call(w.plugins.trustApprovePlan, { directory: w.workspace, sources: ["local:C:/elsewhere.ts"] }),
    ).toMatchObject({
      ok: false,
      type: "internal_error",
      message: "unknown_source",
    })
    expect(
      await call(w.plugins.trustApprovePlan, { directory: path.join(w.root, "closed"), sources: [source] }),
    ).toMatchObject({
      ok: false,
      message: "location_not_open",
    })

    const plan = await ok(w.plugins.trustApprovePlan, { directory: w.workspace, sources: [source] })
    expect(plan.plugins).toEqual([{ id: "x", source, sha256: Hash.sha256(PLUGIN_SOURCE) }])
    expect(plan.warning).toBe(Trust.APPROVAL_WARNING)
    const approved = await ok(w.plugins.trustApproveExecute, { nonce: plan.nonce })
    expect(approved).toEqual({ directory: w.workspace, status: "ok" })
    expect(w.plugins.trustStatus()).toBe("ok")
    const file1 = await w.deps.runtime.trust.read()
    expect(file1).toEqual([
      {
        location: w.workspace,
        source,
        sha256: Hash.sha256(PLUGIN_SOURCE),
        approvedAt: new Date(w.clock.now()).toISOString(),
      },
    ])
    expect(w.events.filter((event) => event.name === "plugin.trust.changed").at(-1)?.payload).toMatchObject({
      status: "ok",
      pending: 0,
    })
    expect(await call(w.plugins.trustApproveExecute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "nonce_invalid",
    })

    await Bun.write(file, PLUGIN_SOURCE + "// changed\n")
    await settle(w)
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")

    await Bun.write(file, PLUGIN_SOURCE)
    await settle(w)
    expect(w.plugins.trustStatus()).toBe("ok")
    expect(await ok(w.plugins.trustRevoke, { directory: w.workspace, source })).toEqual({
      directory: w.workspace,
      status: "blocked_by_plugin",
    })
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
    expect(await w.deps.runtime.trust.read()).toEqual([])
  })

  test("a file changed between plan and execute is refused with trust_hash_mismatch", async () => {
    await using w = await world()
    const file = await withProjectPlugin(w)
    await w.plugins.start()
    const plan = await ok(w.plugins.trustApprovePlan, { directory: w.workspace, sources: [`local:${file}`] })
    await Bun.write(file, "export default { id: 'x', setup: () => steal() }\n")
    const result = await call(w.plugins.trustApproveExecute, { nonce: plan.nonce })
    expect(result).toMatchObject({
      ok: false,
      type: "trust_hash_mismatch",
      data: {
        source: `local:${file}`,
        expected: Hash.sha256(PLUGIN_SOURCE),
        actual: Hash.sha256("export default { id: 'x', setup: () => steal() }\n"),
      },
    })
    expect(await w.deps.runtime.trust.read()).toEqual([])
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
  })

  test("a plugin the host lists by its directory is approved by its entry file: old approvals match, edits block", async () => {
    await using w = await world()
    // Upstream v2.2 lists a configured local plugin by its directory, not the entry file it imports.
    const dir = path.join(w.root, "plugins", "dir-plugin")
    const entry = path.join(dir, "index.js")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(entry, PLUGIN_SOURCE)
    w.project.push(local("x", dir))
    // An approval written before the upgrade names the entry file and its hash.
    await w.deps.runtime.trust.update(() => [
      { location: w.workspace, source: `local:${entry}`, sha256: Hash.sha256(PLUGIN_SOURCE), approvedAt: "2026-10-01T00:00:00.000Z" },
    ])
    await w.plugins.start()
    expect(w.plugins.trustStatus()).toBe("ok")
    expect((await ok(w.plugins.trustList, {})).locations).toEqual([
      {
        directory: w.workspace,
        status: "ok",
        plugins: [{ id: "x", source: `local:${entry}`, sha256: Hash.sha256(PLUGIN_SOURCE), approved: true }],
      },
    ])

    // Changed code with the same file names blocks the Location again.
    await Bun.write(entry, "export default { id: 'x', setup: () => steal() }\n")
    await settle(w)
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")

    // A plan made now and a change before execute is refused.
    const plan = await ok(w.plugins.trustApprovePlan, { directory: w.workspace, sources: [`local:${entry}`] })
    await Bun.write(entry, "export default { id: 'x', setup: () => stealMore() }\n")
    expect(await call(w.plugins.trustApproveExecute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "trust_hash_mismatch",
    })
  })

  test("a creator code plugin's version folder is approved by the hash of all its files", async () => {
    await using w = await world()
    // own.creator's version folder (17 §12.4): extension.json of kind plugin, the shim core loads, the plugin's code.
    const dir = path.join(w.root, "own-home", "creator", "ext", "brief", "v1")
    const entry = path.join(dir, "server.ts")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "extension.json"), JSON.stringify({ format: "own.ext/1", id: "brief", kind: "plugin" }))
    await Bun.write(entry, PLUGIN_SOURCE)
    await Bun.write(path.join(dir, "plugin.ts"), "export default 1\n")
    w.project.push(local("own.creator.ext.brief", dir))
    const folderHash = await Hash.folder(dir)
    expect(folderHash).not.toBe(Hash.sha256(PLUGIN_SOURCE))
    // An approval of the entry file alone does not cover the folder.
    await w.deps.runtime.trust.update(() => [
      { location: w.workspace, source: `local:${entry}`, sha256: Hash.sha256(PLUGIN_SOURCE), approvedAt: "2026-11-04T00:00:00.000Z" },
    ])
    await w.plugins.start()
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
    const listed = await ok(w.plugins.trustList, {})
    expect(listed.locations[0]!.plugins).toEqual([
      { id: "own.creator.ext.brief", source: `local:${entry}`, sha256: folderHash, approved: false },
    ])
    // own.creator's approval of the folder hash unblocks it.
    await w.deps.runtime.trust.update(() => [
      { location: w.workspace, source: `local:${entry}`, sha256: folderHash, approvedAt: "2026-11-04T00:00:00.000Z" },
    ])
    await settle(w)
    expect(w.plugins.trustStatus()).toBe("ok")
    // A helper file changed beside an unchanged entry blocks it again.
    await Bun.write(path.join(dir, "plugin.ts"), "export default steal()\n")
    await settle(w)
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
  })

  test("a folder whose extension.json is not a creator plugin keeps the entry-file hash", async () => {
    await using w = await world()
    const dir = path.join(w.root, "plugins", "declared")
    const entry = path.join(dir, "index.js")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "extension.json"), JSON.stringify({ format: "own.ext/1", id: "x", kind: "mcp" }))
    await Bun.write(entry, PLUGIN_SOURCE)
    w.project.push(local("x", dir))
    expect(await Trust.creatorFolder(dir)).toBeUndefined()
    await w.deps.runtime.trust.update(() => [
      { location: w.workspace, source: `local:${entry}`, sha256: Hash.sha256(PLUGIN_SOURCE), approvedAt: "2026-11-04T00:00:00.000Z" },
    ])
    await w.plugins.start()
    expect(w.plugins.trustStatus()).toBe("ok")
  })

  test("an unreadable trust.json approves nothing (fail closed) and is not overwritten", async () => {
    await using w = await world()
    const file = await withProjectPlugin(w)
    await Bun.write(w.deps.runtime.layout.trust, "{ not json")
    await w.plugins.start()
    expect(w.plugins.trustStatus()).toBe("blocked_by_plugin")
    expect(await call(w.plugins.trustRevoke, { directory: w.workspace, source: `local:${file}` })).toMatchObject({
      ok: false,
      message: "trust_write_failed",
    })
    expect(await Bun.file(w.deps.runtime.layout.trust).text()).toBe("{ not json")
  })

  test("package plugins are pinned by target and version", async () => {
    await using w = await world()
    const pkg: Entry = {
      id: "pkg",
      source: { type: "package", target: "some-plugin@1.2.3", version: "1.2.3" },
      features: {},
      state: { status: "active" },
    }
    w.project.push(pkg)
    await w.plugins.start()
    const plan = await ok(w.plugins.trustApprovePlan, {
      directory: w.workspace,
      sources: ["package:some-plugin@1.2.3"],
    })
    expect(plan.plugins[0].sha256).toBe(Hash.sha256("some-plugin@1.2.3@1.2.3"))
    expect(await ok(w.plugins.trustApproveExecute, { nonce: plan.nonce })).toMatchObject({ status: "ok" })
  })
})

describe("allowlist across Locations", () => {
  test("every open Location answers the control instance; approvals propagate through store.changed", async () => {
    await using w = await world()
    await w.plugins.start()
    const other = path.join(w.root, "other")
    const file = path.join(other, ".opencode", "plugins", "y.js")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, "export default {}\n")
    const entries = [local("own.accounts", path.join(w.own.accounts, "index.js")), local("y", file)]
    const second = await w.location(other, () => entries)
    expect(second.trustStatus()).toBe("blocked_by_plugin")
    expect(w.plugins.trustStatus()).toBe("ok")
    expect(w.plugins.locations().map((location) => [location.directory, location.status])).toEqual(
      [
        [w.workspace, "ok"],
        [other, "blocked_by_plugin"],
      ].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    )
    // The control instance (leader) reports the other Location's change.
    expect(w.events.filter((event) => event.name === "plugin.trust.changed").at(-1)?.payload).toMatchObject({
      directory: other,
      status: "blocked_by_plugin",
    })

    const plan = await ok(w.plugins.trustApprovePlan, { directory: other, sources: [`local:${file}`] })
    expect(await ok(w.plugins.trustApproveExecute, { nonce: plan.nonce })).toEqual({ directory: other, status: "ok" })
    // The second instance re-checks on store.changed; its own trust.list joins that refresh.
    await ok(second.trustList, {})
    expect(second.trustStatus()).toBe("ok")
    expect(
      (await ok(w.plugins.trustList, {})).locations.find((location) => location.directory === other),
    ).toMatchObject({
      status: "ok",
      plugins: [{ id: "y", approved: true }],
    })
    await second.stop()
    expect(w.plugins.locations().map((location) => location.directory)).toEqual([w.workspace])
  })
})
