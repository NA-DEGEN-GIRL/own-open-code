// Extensions on SSH hosts (own/docs/17 §10): this PC's read-only view per host (which extensions reach a host, with
// which folders, C3 only with that host's allowance), the chunks of the files that view names and nothing else, the
// store's host selection, host folders and per-host allowance, and a host's mirror (Mirror.sync through a link that
// plays the broker): the files must hash as the PC's version, the host's store is read only, a C2 version runs the
// host's staging in its sandbox, rollback and removal on the PC follow, and a forged C3 entry without the allowance
// never loads.
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Broker } from "@own/protocol"
import { Creator } from "@own/protocol/creator"
import { CreatorBridge } from "@own/runtime"
import { Schema } from "effect"
import { Mirror } from "../../src/mirror.js"
import { Remote } from "../../src/remote.js"
import { Staging } from "../../src/staging.js"
import { CreatorStore } from "../../src/store.js"
import { manifest, mcpManifest, pluginManifest, tempDir } from "./fixtures.js"

setDefaultTimeout(120_000)

const HOST = "h-abc123"
const OTHER = "h-zzz999"
const decodeView = Schema.decodeUnknownSync(Creator.MirrorView)

async function pc() {
  const home = await tempDir()
  const project = path.join(home, "..", path.basename(home) + "-project")
  return { home, store: new CreatorStore.Store(home, { app: "local" }), project }
}

async function host() {
  const home = await tempDir()
  return { home, store: new CreatorStore.Store(home, { app: "local", mirror: true }) }
}

/** The broker between a host and a PC store: `creator.get`/`creator.file` answered from the PC, reports recorded. */
function link(store: CreatorStore.Store, hostId = HOST, tamper?: (chunk: Broker.CreatorChunk) => Broker.CreatorChunk) {
  const reports: Creator.HostReport[] = []
  const calls: string[] = []
  const current = async () => Remote.view(store, await store.read(), hostId)
  const value: CreatorBridge.Link = {
    request: async (method, params) => {
      calls.push(method)
      if (method === "creator.get") return { ok: true, result: { view: await current() } }
      if (method === "creator.file") {
        const chunk = await Remote.file(store, await current(), Schema.decodeUnknownSync(Broker.CreatorFile)(params))
        return chunk === undefined ? { ok: false } : { ok: true, result: tamper ? tamper(chunk) : chunk }
      }
      reports.push(Schema.decodeUnknownSync(Creator.HostReport)(params))
      return { ok: true, result: { ok: true } }
    },
    on: () => () => undefined,
  }
  return { link: value, reports, calls }
}

function decoded(input: unknown) {
  const checked = CreatorStore.checkManifest(input)
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems))
  return checked.extension
}

function ok(outcome: CreatorStore.Outcome) {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome))
  return outcome
}

describe("this PC's view for a host", () => {
  test("an extension in force reaches every host by default, with its active version's record and files", async () => {
    const { store } = await pc()
    ok(await store.create(manifest("house"), "user"))
    const view = decodeView(await Remote.view(store, await store.read(), HOST))
    expect(view.extensions.map((entry) => entry.id)).toEqual(["house"])
    const entry = view.extensions[0]!
    expect(entry.version.n).toBe(1)
    expect(entry.version.hash).toBe((await store.read()).file.extensions[0]!.versions[0]!.hash)
    expect(entry.files.map((file) => file.path)).toEqual(["extension.json"])
    expect(entry.projects).toEqual([])
    expect(entry.loosen).toBe(false)
    // Stable: the same store gives the same revision; a change gives another.
    const again = await Remote.view(store, await store.read(), HOST)
    expect(again.revision).toBe(view.revision)
    ok(await store.enable("house", false, "user"))
    const off = await Remote.view(store, await store.read(), HOST)
    expect(off.extensions).toEqual([])
    expect(off.revision).not.toBe(view.revision)
  })

  test("host selection: only, except; and the scope maps to host folders tagged with their host", async () => {
    const { store, project } = await pc()
    await fs.mkdir(project, { recursive: true })
    ok(await store.create(manifest("house"), "user"))
    const reach = async (hostId: string) => {
      const snapshot = await store.read()
      return Remote.reach(snapshot, snapshot.loaded[0]!, hostId)
    }
    ok(await store.hosts("house", { mode: "only", ids: [HOST] }))
    expect((await reach(HOST)).reach).toBe("sent")
    expect((await reach(OTHER)).reach).toBe("excluded")
    ok(await store.hosts("house", { mode: "except", ids: [HOST] }))
    expect((await reach(HOST)).reach).toBe("excluded")
    expect((await reach(OTHER)).reach).toBe("sent")
    ok(await store.hosts("house", { mode: "all", ids: [] }))
    // A scope of this PC's folders only: no host has those folders.
    ok(await store.scope("house", [project], "user"))
    expect((await reach(HOST)).reach).toBe("out_of_scope")
    // Host folders: only the tagged host gets them; the other host is out of scope.
    ok(await store.scope("house", [project], "user", undefined, [{ host: HOST, directory: "/home/me/work/" }]))
    const sent = await reach(HOST)
    expect(sent).toEqual({ reach: "sent", projects: ["/home/me/work"], hostTrusted: false })
    expect((await reach(OTHER)).reach).toBe("out_of_scope")
    // A relative or root host folder is refused, nothing changes.
    const bad = await store.scope("house", [], "user", undefined, [{ host: HOST, directory: "work" }])
    expect(bad.ok === false && bad.reason).toBe("scope_invalid")
    const root = await store.scope("house", [], "user", undefined, [{ host: HOST, directory: "/" }])
    expect(root.ok === false && root.reason).toBe("scope_invalid")
    // Without hostProjects a scope change keeps the host folders.
    ok(await store.scope("house", [], "user"))
    expect((await store.read()).file.extensions[0]!.hostProjects).toEqual([{ host: HOST, directory: "/home/me/work" }])
    // A harness's 내 지시문 applies everywhere: no host folder narrows it.
    ok(
      await store.create(
        { format: "own.ext/1", id: "mine", title: "Mine", items: [{ type: "harness.instructions", harness: "codex", text: "Hi." }] },
        "user",
      ),
    )
    const global = await store.scope("mine", [], "user", undefined, [{ host: HOST, directory: "/home/me/work" }])
    expect(global.ok === false && global.reason).toBe("scope_invalid")
  })

  test("C3 stays PC-only without that host's allowance; the allowance is per host and per version", async () => {
    const { store } = await pc()
    ok(await store.settings({ plugins: true }))
    const staged = await Staging.run(store, decoded(pluginManifest()), { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    ok(await store.create(pluginManifest(), "user", {}, undefined, staged.staged))
    const reach = async (hostId: string) => {
      const snapshot = await store.read()
      return Remote.reach(snapshot, snapshot.loaded[0]!, hostId).reach
    }
    // Pending on this PC (not trusted here) and not allowed on the host: PC-only, never in the view.
    expect(await reach(HOST)).toBe("pc_only")
    expect((await Remote.view(store, await store.read(), HOST)).extensions).toEqual([])
    // This PC's own trust does not reach a host.
    ok(await store.trust("brief", 1, true))
    expect(await reach(HOST)).toBe("pc_only")
    ok(await store.hostTrust("brief", HOST, 1, true))
    expect(await reach(HOST)).toBe("sent")
    expect(await reach(OTHER)).toBe("pc_only")
    const view = await Remote.view(store, await store.read(), HOST)
    expect(view.extensions.map((entry) => [entry.id, entry.kind, entry.hostTrusted])).toEqual([["brief", "plugin", true]])
    expect(view.plugins).toBe(true)
    // The switch off: PC-only again.
    ok(await store.settings({ plugins: false }))
    expect(await reach(HOST)).toBe("pc_only")
    ok(await store.settings({ plugins: true }))
    // Withdrawn: PC-only; a declarative extension cannot be allowed per host.
    ok(await store.hostTrust("brief", HOST, 1, false))
    expect(await reach(HOST)).toBe("pc_only")
    ok(await store.create(manifest("house"), "user"))
    const refused = await store.hostTrust("house", HOST, 1, true)
    expect(refused.ok === false && refused.reason).toBe("invalid")
    const history = (await store.read()).file.extensions[0]!.history.map((entry) => [entry.action, entry.host])
    expect(history).toContainEqual(["host_trust", HOST])
    expect(history).toContainEqual(["host_untrust", HOST])
  })

  test("a file chunk is served only for a file of a version the host's view names", async () => {
    const { store } = await pc()
    ok(await store.create(manifest("house"), "user"))
    const view = await Remote.view(store, await store.read(), HOST)
    const chunk = await Remote.file(store, view, { id: "house", n: 1, path: "extension.json", offset: 0 })
    expect(chunk?.end).toBe(true)
    expect(Buffer.from(chunk!.data, "base64").toString("utf8")).toContain('"house"')
    // Not in the view: another path, version, extension, or a path out of the folder.
    expect(await Remote.file(store, view, { id: "house", n: 1, path: "../store.json", offset: 0 })).toBeUndefined()
    expect(await Remote.file(store, view, { id: "house", n: 2, path: "extension.json", offset: 0 })).toBeUndefined()
    expect(await Remote.file(store, view, { id: "other", n: 1, path: "extension.json", offset: 0 })).toBeUndefined()
    // Big files come in chunks.
    const big = await Remote.file(store, view, { id: "house", n: 1, path: "extension.json", offset: chunk!.size })
    expect(big).toEqual({ data: "", size: chunk!.size, end: true })
  })
})

describe("a host's mirror", () => {
  test("declarative: the files hash as the PC's version, the store is written with the host's folders, read only", async () => {
    const source = await pc()
    const target = await host()
    const folder = path.join(target.home, "..", `${path.basename(target.home)}-work`)
    ok(await source.store.create(manifest("house"), "user"))
    ok(await source.store.scope("house", [], "user", undefined, [{ host: HOST, directory: folder }]))
    const broker = link(source.store)
    const result = await Mirror.sync(target.store, broker.link, { bun: process.execPath })
    expect(result.report?.extensions).toEqual([{ id: "house", n: 1, status: "active", problems: [] }])
    expect(broker.reports).toHaveLength(1)
    const snapshot = await target.store.read()
    expect(snapshot.loaded.map((loaded) => [loaded.entry.id, loaded.status, loaded.entry.projects])).toEqual([
      ["house", "active", [path.resolve(folder)]],
    ])
    // The host never writes: every store write but the mirror's is refused.
    for (const outcome of [
      await target.store.create(manifest("forged"), "model"),
      await target.store.enable("house", false, "user"),
      await target.store.rollback("house", 1, "user"),
      await target.store.remove("house"),
      await target.store.scope("house", [], "user"),
      await target.store.loosen("house", 1, true),
      await target.store.hosts("house", { mode: "all", ids: [] }),
      await target.store.settings({ plugins: true }),
    ])
      expect(outcome.ok === false && outcome.reason).toBe("read_only")
    // The PC's store saw no write from the host: the same file as before the sync.
    expect((await source.store.read()).file.extensions[0]!.history.map((entry) => entry.action)).toEqual(["create", "scope"])
    // A second sync with nothing new fetches no file again.
    const again = link(source.store)
    await Mirror.sync(target.store, again.link, { bun: process.execPath })
    expect(again.calls.filter((call) => call === "creator.file")).toEqual([])
  })

  test("files that do not hash as the PC's version are refused and nothing of the version applies", async () => {
    const source = await pc()
    const target = await host()
    ok(await source.store.create(manifest("house"), "user"))
    const broker = link(source.store, HOST, (chunk) => ({
      ...chunk,
      data: Buffer.from(Buffer.from(chunk.data, "base64").toString("utf8").replace("Answer briefly.", "Answer loudly.")).toString("base64"),
    }))
    const result = await Mirror.sync(target.store, broker.link, { bun: process.execPath })
    expect(result.report?.extensions[0]).toMatchObject({ id: "house", status: "failed" })
    expect(result.report?.extensions[0]!.problems[0]!.message).toContain("hash")
    expect((await target.store.read()).loaded).toEqual([])
    await expect(fs.stat(target.store.versionDir("house", 1))).rejects.toThrow()
  })

  test("a copy changed on the host reads as tampered; the next sync fetches the PC's version again", async () => {
    const source = await pc()
    const target = await host()
    ok(await source.store.create(manifest("house"), "user"))
    await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    const file = path.join(target.store.versionDir("house", 1), "extension.json")
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("Answer briefly.", "Answer loudly."))
    expect((await target.store.read()).loaded[0]!.status).toBe("tampered")
    await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    expect((await target.store.read()).loaded[0]!.status).toBe("active")
    expect(await fs.readFile(file, "utf8")).toContain("Answer briefly.")
  })

  test("update, rollback and removal on the PC follow on the host; folders of versions it no longer names go", async () => {
    const source = await pc()
    const target = await host()
    ok(await source.store.create(manifest("house"), "user"))
    const changed = manifest("house")
    changed.items[0] = { type: "prompt.fragment", id: "style", text: "Answer in Korean." }
    ok(await source.store.update(changed, "user"))
    await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    const fragment = async () => {
      const loaded = (await target.store.read()).loaded[0]
      const item = loaded?.extension?.items.find((entry) => entry.type === "prompt.fragment")
      return item?.type === "prompt.fragment" ? [loaded!.entry.active, item.text] : undefined
    }
    expect(await fragment()).toEqual([2, "Answer in Korean."])
    ok(await source.store.rollback("house", 1, "user"))
    await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    expect(await fragment()).toEqual([1, "Answer briefly."])
    await expect(fs.stat(target.store.versionDir("house", 2))).rejects.toThrow()
    ok(await source.store.remove("house"))
    await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    expect((await target.store.read()).loaded).toEqual([])
    await expect(fs.stat(path.join(target.store.root, "ext", "house"))).rejects.toThrow()
  })

  test("a scope whose host folders cannot be used here never widens to every project", async () => {
    const source = await pc()
    const target = await host()
    ok(await source.store.create(manifest("house"), "user"))
    // Own's home on the host is no project folder.
    ok(await source.store.scope("house", [], "user", undefined, [{ host: HOST, directory: path.join(target.home, "x") }]))
    const result = await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    expect(result.report?.extensions[0]).toMatchObject({ id: "house", status: "failed" })
    expect((await target.store.read()).loaded).toEqual([])
  })

  test("C2: the host runs its own staging in its sandbox before the servers register; the confirmation is the host's", async () => {
    const source = await pc()
    const target = await host()
    const staged = await Staging.run(source.store, decoded(mcpManifest()), { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    ok(await source.store.create(mcpManifest(), "user", {}, undefined, staged.staged))
    const result = await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    expect(result.report?.extensions).toEqual([{ id: "words", n: 1, status: "active", problems: [] }])
    const log = await fs.readFile(path.join(target.store.root, "logs", "words.log"), "utf8")
    expect(log).toContain("host staging words: host smoke ok")
    expect(log).toContain("host staging words: host tests: counts words ok")
    // The host's approval of a first call stays on the host, and a later mirror keeps it.
    ok(await target.store.confirm("words", 1))
    await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    expect((await target.store.read()).file.extensions[0]!.confirmed).toEqual([1])
    expect((await source.store.read()).file.extensions[0]!.confirmed).toEqual([])
  })

  test("C2: a version whose host staging fails does not register", async () => {
    const source = await pc()
    const target = await host()
    const staged = await Staging.run(source.store, decoded(mcpManifest()), { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    ok(await source.store.create(mcpManifest(), "user", {}, undefined, staged.staged))
    // A host whose Bun cannot run own's host: its smoke fails, so the version stays out.
    const result = await Mirror.sync(target.store, link(source.store).link, {
      bun: path.join(target.home, "no-bun.exe"),
    })
    expect(result.report?.extensions[0]).toMatchObject({ id: "words", status: "failed" })
    expect((await target.store.read()).loaded).toEqual([])
  })

  test("C3: a mirrored code plugin loads only with this host's allowance (a forged entry stays pending)", async () => {
    const target = await host()
    const source = await pc()
    ok(await source.store.settings({ plugins: true }))
    const staged = await Staging.run(source.store, decoded(pluginManifest()), { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    ok(await source.store.create(pluginManifest(), "user", {}, undefined, staged.staged))
    ok(await source.store.hostTrust("brief", HOST, 1, true))
    // A broker that drops the allowance (a forged view): the host keeps the version but never loads it.
    const forged = link(source.store)
    const request = forged.link.request
    const tampered: CreatorBridge.Link = {
      ...forged.link,
      request: async (method, params, timeoutMs) => {
        const reply = await request(method, params, timeoutMs)
        if (method !== "creator.get" || !reply.ok) return reply
        const view = (reply.result as { view: Creator.MirrorView }).view
        return { ok: true, result: { view: { ...view, extensions: view.extensions.map((entry) => ({ ...entry, hostTrusted: false })) } } }
      },
    }
    const result = await Mirror.sync(target.store, tampered, { bun: process.execPath })
    expect(result.report?.extensions[0]).toMatchObject({ id: "brief", status: "unavailable" })
    // With the allowance it is active (the host's own folder-hash trust and config entry follow in the service).
    const allowed = await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    expect(allowed.report?.extensions[0]).toMatchObject({ id: "brief", status: "active" })
  })

  test("in drain (the PC runs another build) the host withdraws its code plugins and allow rules, keeps the rest", async () => {
    const target = await host()
    const source = await pc()
    ok(await source.store.settings({ plugins: true }))
    const staged = await Staging.run(source.store, decoded(pluginManifest()), { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    ok(await source.store.create(pluginManifest(), "user", {}, undefined, staged.staged))
    ok(await source.store.hostTrust("brief", HOST, 1, true))
    ok(await source.store.create(looseManifest(), "user"))
    ok(await source.store.loosen("loose", 1, true))
    ok(await source.store.hostTrust("loose", HOST, 1, true))
    ok(await source.store.create(manifest("house"), "user"))
    await Mirror.sync(target.store, link(source.store).link, { bun: process.execPath })
    const before = (await target.store.read()).file
    expect(before.extensions.map((entry) => [entry.id, entry.loosen, entry.trusted])).toEqual([
      ["brief", [], [1]],
      ["loose", [1], []],
      ["house", [], []],
    ])
    let reloads = 0
    const drain: CreatorBridge.Link = { request: async () => ({ ok: false, error: "skew_drain" }), on: () => () => undefined }
    const result = await Mirror.sync(target.store, drain, { bun: process.execPath, reload: async () => void reloads++ })
    expect(result).toEqual({ revision: undefined, report: undefined })
    const after = (await target.store.read()).file
    expect(after.extensions.map((entry) => [entry.id, entry.loosen])).toEqual([
      ["loose", []],
      ["house", []],
    ])
    expect(after.settings?.plugins).toBe(false)
    expect(reloads).toBe(1)
    // Another drain answer changes nothing more; a plain refusal (no session) keeps the mirror as it is.
    await Mirror.sync(target.store, drain, { bun: process.execPath, reload: async () => void reloads++ })
    await Mirror.sync(target.store, { request: async () => ({ ok: false }), on: () => () => undefined }, { bun: process.execPath })
    expect(reloads).toBe(1)
    expect((await target.store.read()).file).toEqual(after)
  })
})

describe("allow rules and reports on hosts (CRM-33, CRM-34)", () => {
  test("approved allow rules reach a host only with that host's allowance of the version", async () => {
    const { store } = await pc()
    ok(await store.create(looseManifest(), "user"))
    ok(await store.loosen("loose", 1, true))
    const loosen = async (hostId: string) => (await Remote.view(store, await store.read(), hostId)).extensions[0]!.loosen
    // This PC's approval is about this PC: every host keeps its baseline asks.
    expect(await loosen(HOST)).toBe(false)
    ok(await store.hostTrust("loose", HOST, 1, true))
    expect(await loosen(HOST)).toBe(true)
    expect(await loosen(OTHER)).toBe(false)
    // The allowance without this PC's approval sends nothing loosened either.
    ok(await store.loosen("loose", 1, false))
    expect(await loosen(HOST)).toBe(false)
  })

  test("a file changed after the view was built is not served", async () => {
    const { store } = await pc()
    ok(await store.create(manifest("house"), "user"))
    const view = await Remote.view(store, await store.read(), HOST)
    const target = path.join(store.versionDir("house", 1), "extension.json")
    await fs.writeFile(target, `${await fs.readFile(target, "utf8")}
 `)
    expect(await Remote.file(store, view, { id: "house", n: 1, path: "extension.json", offset: 0 })).toBeUndefined()
  })

  test("a host's report shows for the version in force; withdrawn but still on at the host, the line keeps it", async () => {
    const { store } = await pc()
    ok(await store.create(manifest("house"), "user"))
    const line = async () => {
      const snapshot = await store.read()
      return Remote.hostViews(snapshot).lines(snapshot.loaded[0]!)[0]
    }
    const state = (n: number, status: Creator.HostStatus) => ({ revision: "r", at: 1, extensions: [{ id: "house", n, status, problems: [] }] })
    try {
      CreatorBridge.report(HOST, state(1, "active"))
      expect(await line()).toEqual({ host: HOST, reach: "sent", state: { id: "house", n: 1, status: "active", problems: [] } })
      // A report of another version waits for the host's next sync.
      CreatorBridge.report(HOST, state(2, "active"))
      expect(await line()).toEqual({ host: HOST, reach: "sent" })
      // Left out here, still on at the host: the line says so.
      CreatorBridge.report(HOST, state(1, "active"))
      ok(await store.hosts("house", { mode: "except", ids: [HOST] }))
      expect(await line()).toMatchObject({ host: HOST, reach: "excluded", state: { status: "active" } })
      CreatorBridge.report(HOST, state(1, "failed"))
      expect(await line()).toEqual({ host: HOST, reach: "excluded" })
    } finally {
      CreatorBridge.forget(HOST)
    }
    expect(CreatorBridge.reports().has(HOST)).toBe(false)
  })

  test("listeners hear a host's reports coalesced, and only a report that says something new", async () => {
    let heard = 0
    const stop = CreatorBridge.onReport(() => void heard++)
    try {
      const value = { revision: "r", at: 1, extensions: [] }
      for (let index = 0; index < 50; index++) CreatorBridge.report(OTHER, { ...value, at: index })
      await Bun.sleep(CreatorBridge.REPORT_COALESCE_MS + 300)
      expect(heard).toBe(1)
      // The same content again: nothing to hear.
      CreatorBridge.report(OTHER, { ...value, at: 99 })
      await Bun.sleep(CreatorBridge.REPORT_COALESCE_MS + 300)
      expect(heard).toBe(1)
      // Report strings over the caps do not decode.
      const decode = Schema.decodeUnknownOption(Creator.HostReport)
      expect(decode({ ...value, revision: "x".repeat(129) })._tag).toBe("None")
      expect(
        decode({ ...value, extensions: [{ id: "house", n: 1, status: "failed", problems: [{ path: "p", message: "m".repeat(401) }] }] })._tag,
      ).toBe("None")
    } finally {
      stop()
      CreatorBridge.forget(OTHER)
    }
  })
})

/** Rules only, one of them an allow rule that needs the user's approval. */
function looseManifest() {
  return {
    format: "own.ext/1",
    id: "loose",
    title: "Loose",
    items: [{ type: "tool.rule", rules: [{ permission: "webfetch", pattern: "https://docs.example.com/*", effect: "allow" }] }],
  }
}
