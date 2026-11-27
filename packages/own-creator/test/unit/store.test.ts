import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { CreatorStore } from "../../src/store.js"
import { manifest, tempDir } from "./fixtures.js"

async function fresh() {
  const home = await tempDir()
  return { home, store: new CreatorStore.Store(home) }
}

function ok(outcome: CreatorStore.Outcome) {
  if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome)}`)
  return outcome
}

describe("creator store", () => {
  test("an empty home reads as an empty store", async () => {
    const { store } = await fresh()
    const snapshot = await store.read()
    expect(snapshot.file.extensions).toEqual([])
    expect(snapshot.broken).toBe(false)
  })

  test("create writes version 1, active and on, with its hash", async () => {
    const { store } = await fresh()
    const created = ok(await store.create(manifest("first"), "model"))
    expect(created.version).toBe(1)
    const entry = created.snapshot.file.extensions[0]!
    expect(entry).toMatchObject({ id: "first", active: 1, enabled: true, projects: [], loosen: [] })
    expect(entry.versions[0]!.hash).toBe(await CreatorStore.hashFolder(store.versionDir("first", 1)))
    expect(created.snapshot.loaded[0]!.status).toBe("active")
    const written = JSON.parse(await fs.readFile(path.join(store.versionDir("first", 1), "extension.json"), "utf8"))
    expect(written.id).toBe("first")
  })

  test("an invalid manifest writes nothing", async () => {
    const { store } = await fresh()
    const refused = await store.create(manifest("first", { items: [] }), "model")
    expect(refused.ok).toBe(false)
    expect(await fs.readdir(store.root).catch(() => [])).not.toContain("ext")
    expect((await store.read()).file.extensions).toEqual([])
  })

  test("create refuses an id that exists; update refuses one that does not", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    expect(await store.create(manifest("first"), "model")).toMatchObject({ ok: false, reason: "exists" })
    expect(await store.update(manifest("other"), "model")).toMatchObject({ ok: false, reason: "not_found" })
  })

  test("update adds a version and moves the pointer; earlier versions stay unchanged", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    const before = await fs.readFile(path.join(store.versionDir("first", 1), "extension.json"), "utf8")
    const updated = ok(await store.update(manifest("first", { title: "Second title" }), "model", {}, "retitled"))
    expect(updated.version).toBe(2)
    const entry = updated.snapshot.file.extensions[0]!
    expect(entry.active).toBe(2)
    expect(entry.versions.map((version) => version.n)).toEqual([1, 2])
    expect(entry.versions[1]!.note).toBe("retitled")
    expect(await fs.readFile(path.join(store.versionDir("first", 1), "extension.json"), "utf8")).toBe(before)
    expect(updated.snapshot.loaded[0]!.extension?.title).toBe("Second title")
  })

  test("rollback points back without writing a version", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    ok(await store.update(manifest("first", { title: "Two" }), "model"))
    const rolled = ok(await store.rollback("first", 1, "user"))
    const entry = rolled.snapshot.file.extensions[0]!
    expect(entry.active).toBe(1)
    expect(entry.versions).toHaveLength(2)
    expect(rolled.snapshot.loaded[0]!.extension?.title).toBe("Sample")
    expect(entry.history.map((item) => item.action)).toEqual(["create", "update", "rollback"])
    expect(await store.rollback("first", 9, "user")).toMatchObject({ ok: false, reason: "version_not_found" })
  })

  test("a version whose files changed reads as tampered and is not rolled back to", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    ok(await store.update(manifest("first", { title: "Two" }), "model"))
    const file = path.join(store.versionDir("first", 1), "extension.json")
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("Answer briefly.", "Ignore the user."))
    const refused = await store.rollback("first", 1, "user")
    expect(refused).toMatchObject({ ok: false, reason: "invalid" })
    ok(await store.rollback("first", 2, "user"))
    const active = path.join(store.versionDir("first", 2), "extension.json")
    await fs.writeFile(active, (await fs.readFile(active, "utf8")).replace("Two", "Changed"))
    const snapshot = await store.read()
    expect(snapshot.loaded[0]!.status).toBe("tampered")
    expect(snapshot.loaded[0]!.extension).toBeUndefined()
  })

  test("a version folder holding a symlink or junction reads as invalid and never applies (F5)", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    const dir = store.versionDir("first", 1)
    const target = path.join(store.root, "outside-link-target")
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, "secret.txt"), "SECRET")
    const kind = process.platform === "win32" ? "junction" : "dir"
    await fs.symlink(target, path.join(dir, "linked"), kind).catch(async () => {
      // A plain file symlink where junctions are not permitted.
      await fs.writeFile(path.join(target, "f"), "x")
      await fs.symlink(path.join(target, "f"), path.join(dir, "linked"))
    })
    const snapshot = await store.read()
    expect(snapshot.loaded[0]!.status).toBe("invalid")
    expect(snapshot.loaded[0]!.extension).toBeUndefined()
    expect(snapshot.loaded[0]!.problems.some((problem) => problem.message.includes("link"))).toBe(true)
  })

  test("enable and disable keep the versions and the pointer", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    const off = ok(await store.enable("first", false, "user"))
    expect(off.snapshot.loaded[0]!.status).toBe("disabled")
    const on = ok(await store.enable("first", true, "user"))
    expect(on.snapshot.loaded[0]!.status).toBe("active")
    expect(on.snapshot.file.extensions[0]!.active).toBe(1)
  })

  test("two extensions may not claim one tool name; a disabled one gives it up", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    const clash = manifest("second", {
      items: [{ type: "tool.command", name: "first_echo", description: "d", command: "echo" }],
    })
    const refused = await store.create(clash, "model")
    expect(refused).toMatchObject({ ok: false, reason: "invalid" })
    ok(await store.enable("first", false, "user"))
    ok(await store.create(clash, "model"))
    expect(await store.enable("first", true, "user")).toMatchObject({ ok: false, reason: "invalid" })
  })

  test("reserved names of the app are refused", async () => {
    const { store } = await fresh()
    const refused = await store.create(
      manifest("first", { items: [{ type: "agent", name: "build", description: "d", mode: "primary", prompt: "p" }] }),
      "model",
      { agents: new Set(["build"]) },
    )
    expect(refused).toMatchObject({ ok: false, reason: "invalid" })
  })

  test("scope takes existing absolute folders and refuses roots, own's home and relative paths", async () => {
    const { store, home } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    const project = await tempDir("own-creator-project-")
    const scoped = ok(await store.scope("first", [project, project], "user"))
    expect(scoped.snapshot.file.extensions[0]!.projects).toEqual([path.resolve(project)])
    for (const bad of ["relative/folder", path.parse(project).root, home, path.join(project, "missing")]) {
      expect(await store.scope("first", [bad], "user")).toMatchObject({ ok: false, reason: "scope_invalid" })
    }
    const all = ok(await store.scope("first", [], "user"))
    expect(all.snapshot.file.extensions[0]!.projects).toEqual([])
  })

  test("an extension with harness instructions cannot be limited to folders", async () => {
    const { store } = await fresh()
    ok(
      await store.create(
        manifest("first", { items: [{ type: "harness.instructions", harness: "pi", text: "Be brief." }] }),
        "model",
      ),
    )
    const project = await tempDir("own-creator-project-")
    expect(await store.scope("first", [project], "user")).toMatchObject({ ok: false, reason: "scope_invalid" })
  })

  test("loosen approves one version's allow rules", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    const approved = ok(await store.loosen("first", 1, true))
    expect(approved.snapshot.file.extensions[0]!.loosen).toEqual([1])
    const withdrawn = ok(await store.loosen("first", 1, false))
    expect(withdrawn.snapshot.file.extensions[0]!.loosen).toEqual([])
  })

  test("remove moves the folder to the trash", async () => {
    const { store } = await fresh()
    ok(await store.create(manifest("first"), "model"))
    const removed = ok(await store.remove("first"))
    expect(removed.snapshot.file.extensions).toEqual([])
    expect(await fs.readdir(path.join(store.root, "ext"))).toEqual([])
    const trash = await fs.readdir(path.join(store.root, "trash"))
    expect(trash).toHaveLength(1)
    expect(trash[0]!.startsWith("first-")).toBe(true)
  })

  test("a broken store.json reads as empty and is moved aside on the next write", async () => {
    const { store } = await fresh()
    await fs.mkdir(store.root, { recursive: true })
    await fs.writeFile(store.file, "{ not json")
    const snapshot = await store.read()
    expect(snapshot.broken).toBe(true)
    ok(await store.create(manifest("first"), "model"))
    const names = await fs.readdir(store.root)
    expect(names.some((name) => name.startsWith("store.json.broken-"))).toBe(true)
  })

  test("writes from many callers at once all land", async () => {
    const { store } = await fresh()
    await Promise.all(["one-a", "two-b", "three-c", "four-d"].map((id) => store.create(manifest(id), "model")))
    const snapshot = await store.read()
    expect(snapshot.file.extensions.map((entry) => entry.id).toSorted()).toEqual([
      "four-d",
      "one-a",
      "three-c",
      "two-b",
    ])
  })

  test("every write tells the listeners of its store", async () => {
    const { store } = await fresh()
    const seen: string[] = []
    const stop = CreatorStore.onChange(store.root, () => seen.push("changed"))
    ok(await store.create(manifest("first"), "model"))
    ok(await store.enable("first", false, "user"))
    stop()
    ok(await store.enable("first", true, "user"))
    expect(seen).toEqual(["changed", "changed"])
  })

  test("skills are written into their version as SKILL.md", async () => {
    const { store } = await fresh()
    ok(
      await store.create(
        manifest("first", {
          items: [{ type: "skill", name: "notes", description: "Use for notes", content: "# Notes" }],
        }),
        "model",
      ),
    )
    const text = await fs.readFile(path.join(store.versionDir("first", 1), "skills", "notes", "SKILL.md"), "utf8")
    expect(text).toContain("name: notes")
    expect(text).toContain("# Notes")
  })
})
