// Skills global first (03 §19.6.1, decisions SG 2026-10-26): the fold every project's Location runs over its skills
// (scopes, the global switch, project switches shallow to deep, never in the control Location), the write rule of
// `skillset.switch` (a value a place inherits is a deletion), `skillset.view` (the catalog, a project's own answer on
// the runtime broadcast, the fallback judged over the catalog), the validation, the reload on `skillset.changed` and
// the registration made again after `plugin.updated` so it folds after a transform registered later. A fake skill
// domain with core's semantics: every read runs every registered transform in order over fresh skills.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import type { Types } from "effect"
import type { OwnSkillset } from "@own/protocol"
import { Location } from "../../src/location.js"
import type { Module } from "../../src/module.js"
import { SkillsetRpc } from "../../src/rpc/skillset.js"
import { Register } from "../../src/rpc/register.js"
import { SkillsetFold } from "../../src/skillset/fold.js"
import { SkillsetRegister } from "../../src/skillset/register.js"
import { call, ok, recordEvents, until } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"

interface Info {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly path: string
  readonly autoinvoke?: boolean
  readonly content: string
}

const OWN = path.resolve("/home/demo/.config/own-open-code/skills")
const PROJECT_A = path.resolve("/work/a")
const PROJECT_B = path.resolve("/work/b")

const skill = (id: string, folder: string, extra: Partial<Info> = {}): Info => ({
  id,
  name: id.toUpperCase(),
  path: path.join(folder, id, "SKILL.md"),
  content: `# ${id}`,
  ...extra,
})
const builtin = (id: string): Info => ({ id, name: id, path: `/builtin/${id}.md`, content: `# ${id}` })

/** A skill editor over a map, like core's (`remove` of a missing id is a no-op). */
function editor(skills: ReadonlyArray<Info>) {
  const records = new Map<string, Types.DeepMutable<Info>>(skills.map((item) => [item.id, { ...item }]))
  const edit = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    add: (item: Info) => void records.set(item.id, { ...item }),
    update: (id: string, update: (item: Types.DeepMutable<Info>) => void) => {
      const current = records.get(id)
      if (current) update(current)
    },
    remove: (id: string) => void records.delete(id),
  }
  // SAFETY: the fake has every member of core's skill editor; its records are plain `Skill.Info` values.
  return { edit: edit as unknown as SkillEditor, records }
}

/**
 * core's skill domain for one Location: `transform` registrations in order, every read folds them over fresh skills,
 * `reload` counts. `base` stands for core's built-in skills; a later registration (a `post` plugin) adds more.
 */
function domain(base: ReadonlyArray<Info>) {
  const transforms: Array<{ readonly run: (editor: SkillEditor) => void }> = []
  const state = { reloads: 0, folds: 0 }
  const read = () => {
    state.folds++
    const fold = editor(base)
    for (const transform of [...transforms]) transform.run(fold.edit)
    return [...fold.records.values()]
  }
  return {
    state,
    transforms,
    read,
    skill: {
      transform: async (run: (editor: SkillEditor) => void) => {
        const entry = { run }
        transforms.push(entry)
        read()
        return {
          dispose: async () => {
            transforms.splice(transforms.indexOf(entry), 1)
            read()
          },
        }
      },
      reload: async () => {
        state.reloads++
        read()
      },
      list: async () => ({ location: { directory: "" }, data: read() }),
    },
  }
}

const snapshot = (switches: OwnSkillset.Switch[] = [], scopes: OwnSkillset.Scope[] = []): SkillsetFold.Snapshot => ({
  switches,
  scopes,
})

const PLUGIN_UPDATED = { type: "plugin.updated", data: {} } as unknown as Module.OpenCodeEvent

describe("fold", () => {
  const all = [
    skill("pdf", OWN),
    skill("deploy", OWN),
    skill("notes", path.join(PROJECT_A, ".opencode", "skills")),
    builtin("opencode"),
  ]
  const run = (shot: SkillsetFold.Snapshot, directory: string, control = false) => {
    const fold = editor(all)
    const off = SkillsetFold.fold(fold.edit, shot, { directory, control })
    return { left: [...fold.records.keys()].toSorted(), off }
  }

  test("a scope keeps its folder's skill in one project and the folders inside it", () => {
    const scoped = snapshot([], [{ folder: path.join(OWN, "deploy"), directory: PROJECT_A }])
    expect(run(scoped, path.join(PROJECT_A, "sub")).left).toEqual(["deploy", "notes", "opencode", "pdf"])
    const outside = run(scoped, PROJECT_B)
    expect(outside.left).toEqual(["notes", "opencode", "pdf"])
    expect(outside.off).toEqual([
      { id: "deploy", by: "scope", name: "DEPLOY", path: path.join(OWN, "deploy", "SKILL.md") },
    ])
  })

  test("a scope beats the switches; a scope on another folder leaves a same-id skill alone", () => {
    const scoped = snapshot(
      [{ id: "deploy", directory: PROJECT_B, enabled: true }],
      [
        { folder: path.join(OWN, "deploy"), directory: PROJECT_A },
        // The project's own `notes` lives in A's folder; this scope names own's copy, which this Location does not load.
        { folder: path.join(OWN, "notes"), directory: PROJECT_B },
      ],
    )
    const inB = run(scoped, PROJECT_B)
    expect(inB.off.map((item) => [item.id, item.by])).toEqual([["deploy", "scope"]])
    expect(run(scoped, PROJECT_A).left).toContain("notes")
  })

  test("the global switch, project switches off and on, the deepest folder last; built-ins too", () => {
    const shot = snapshot([
      { id: "pdf", enabled: false },
      { id: "pdf", directory: PROJECT_A, enabled: true },
      { id: "pdf", directory: path.join(PROJECT_A, "deep"), enabled: false },
      { id: "opencode", directory: PROJECT_B, enabled: false },
    ])
    expect(run(shot, PROJECT_A).left).toContain("pdf")
    const deep = run(shot, path.join(PROJECT_A, "deep", "er"))
    expect(deep.off.map((item) => [item.id, item.by])).toEqual([["pdf", "project"]])
    expect(run(shot, PROJECT_B).off.map((item) => [item.id, item.by])).toEqual([
      ["pdf", "global"],
      ["opencode", "project"],
    ])
    // The removed rows carry what core had, never the content.
    expect(run(shot, PROJECT_B).off[0]).toEqual({
      id: "pdf",
      by: "global",
      name: "PDF",
      path: path.join(OWN, "pdf", "SKILL.md"),
    })
  })

  // Review finding (2026-10-26): a scope matched only `dirname(SKILL.md) === folder`, while core reads
  // `{*.md,**/SKILL.md}`: a skill nested in a scoped folder escaped it, and a flat skill's scope named the folder
  // every flat skill there shares.
  test("a scope holds the skills nested in its folder; a flat skill is scoped by its file, not its shared folder", () => {
    const pack = path.join(OWN, "pack")
    const skills = [
      skill("pack", OWN),
      { id: "nested", name: "nested", path: path.join(pack, "nested", "SKILL.md"), content: "# nested" },
      { id: "deeper", name: "deeper", path: path.join(pack, "nested", "deeper", "SKILL.md"), content: "# deeper" },
      { id: "flat", name: "flat", path: path.join(OWN, "flat.md"), content: "# flat" },
      { id: "other", name: "other", path: path.join(OWN, "other.md"), content: "# other" },
    ]
    const left = (shot: SkillsetFold.Snapshot, directory: string) => {
      const fold = editor(skills)
      SkillsetFold.fold(fold.edit, shot, { directory, control: false })
      return [...fold.records.keys()].toSorted()
    }
    const scoped = snapshot(
      [],
      [
        { folder: pack, directory: PROJECT_A },
        // The deepest scope that holds a skill decides.
        { folder: path.join(pack, "nested", "deeper"), directory: PROJECT_B },
        { folder: path.join(OWN, "flat.md"), directory: PROJECT_A },
      ],
    )
    expect(left(scoped, PROJECT_A)).toEqual(["flat", "nested", "other", "pack"])
    expect(left(scoped, PROJECT_B)).toEqual(["deeper", "other"])
    expect(SkillsetFold.scopeOf(path.join(pack, "nested", "SKILL.md"), scoped.scopes)?.folder).toBe(pack)
    // A folder whose name only starts like the scoped one is not inside it.
    expect(SkillsetFold.scopeOf(path.join(OWN, "package", "SKILL.md"), scoped.scopes)).toBeUndefined()
  })

  test("the control Location removes nothing", () => {
    const shot = snapshot([{ id: "pdf", enabled: false }], [{ folder: path.join(OWN, "deploy"), directory: PROJECT_A }])
    expect(run(shot, path.resolve("/own/control"), true)).toEqual({
      left: ["deploy", "notes", "opencode", "pdf"],
      off: [],
    })
  })

  test("inherited: the global switch, then the folders that hold the place, not the place itself", () => {
    const shot = snapshot([
      { id: "pdf", enabled: false },
      { id: "pdf", directory: PROJECT_A, enabled: true },
    ])
    expect(SkillsetFold.inherited("pdf", undefined, shot)).toBe(true)
    expect(SkillsetFold.inherited("pdf", PROJECT_A, shot)).toBe(false)
    expect(SkillsetFold.inherited("pdf", path.join(PROJECT_A, "sub"), shot)).toBe(true)
    expect(SkillsetFold.inherited("pdf", PROJECT_B, shot)).toBe(false)
    expect(SkillsetFold.inherited("other", PROJECT_B, shot)).toBe(true)
  })
})

async function rig() {
  const core = domain([skill("pdf", OWN), skill("deploy", OWN), builtin("opencode")])
  const t = await testDeps({ control: true, ctx: { skill: core.skill } })
  const control = path.join(t.home, "control")
  const deps = { ...t.deps, location: { directory: control, control: true } }
  return {
    t,
    core,
    control,
    rpc: SkillsetRpc.handlers(deps),
    events: recordEvents(t.deps),
    file: () => fs.readFile(t.deps.runtime.layout.skillSwitches, "utf8"),
    [Symbol.asyncDispose]: () => t[Symbol.asyncDispose](),
  }
}

describe("skillset.switch and skillset.view", () => {
  test("the write rule: a value the place inherits is a deletion; null deletes; the scopes first", async () => {
    await using r = await rig()
    // On where it is on anyway: nothing stored.
    expect((await ok(r.rpc["skillset.switch"], { changes: [{ id: "pdf", enabled: true }] })).switches).toEqual([])
    expect(
      (await ok(r.rpc["skillset.switch"], { changes: [{ id: "pdf", directory: PROJECT_A, enabled: true }] })).switches,
    ).toEqual([])
    const view = await ok(r.rpc["skillset.switch"], {
      changes: [
        { id: "pdf", enabled: false },
        { id: "pdf", directory: PROJECT_A, enabled: true },
        // Inherits A's on: not stored.
        { id: "pdf", directory: path.join(PROJECT_A, "sub"), enabled: true },
      ],
      scopes: [{ folder: path.join(OWN, "deploy"), directory: PROJECT_B }],
    })
    expect(view.switches).toEqual([
      { id: "pdf", enabled: false },
      { id: "pdf", directory: PROJECT_A, enabled: true },
    ])
    expect(view.scopes).toEqual([{ folder: path.join(OWN, "deploy"), directory: PROJECT_B }])
    // A scope of the same folder replaces the old one; null clears it. One write, one event.
    const before = r.events.length
    const next = await ok(r.rpc["skillset.switch"], {
      changes: [{ id: "pdf", directory: PROJECT_A, enabled: null }],
      scopes: [
        { folder: path.join(OWN, "deploy"), directory: PROJECT_A },
        { folder: path.join(OWN, "pdf"), directory: PROJECT_B },
        { folder: path.join(OWN, "pdf"), directory: null },
      ],
    })
    expect(next.switches).toEqual([{ id: "pdf", enabled: false }])
    expect(next.scopes).toEqual([{ folder: path.join(OWN, "deploy"), directory: PROJECT_A }])
    expect(r.events.slice(before).map((event) => event.name)).toEqual(["skillset.changed"])
    // The file holds ids and folders only.
    expect(JSON.parse(await r.file())).toEqual({
      version: 1,
      switches: [{ id: "pdf", enabled: false }],
      scopes: [{ folder: path.join(OWN, "deploy"), directory: PROJECT_A }],
    })
    expect(await r.file()).not.toContain("# pdf")
  })

  test("validation: relative folders and an empty change are refused, nothing stored", async () => {
    await using r = await rig()
    const refused = async (input: OwnSkillset.SwitchInput, field: string) =>
      expect(await call(r.rpc["skillset.switch"], input)).toMatchObject({
        ok: false,
        type: "skillset_invalid",
        data: { field },
      })
    await refused({ changes: [] }, "changes")
    await refused({ changes: [], scopes: [] }, "changes")
    await refused({ changes: [{ id: "pdf", directory: "relative", enabled: false }] }, "directory")
    await refused({ changes: [], scopes: [{ folder: "skills/pdf", directory: PROJECT_A }] }, "folder")
    await refused({ changes: [], scopes: [{ folder: path.join(OWN, "pdf"), directory: "a" }] }, "directory")
    expect(await fs.stat(r.t.deps.runtime.layout.skillSwitches).catch(() => undefined)).toBeUndefined()
    expect(r.events).toEqual([])
    expect(Register.REMOTE_MANAGED).toContain("skillset.view")
    expect(Register.REMOTE_MANAGED).toContain("skillset.switch")
  })

  test("the view: the catalog without content; with a folder its Location's answer, else judged with id-only rows", async () => {
    await using r = await rig()
    await ok(r.rpc["skillset.switch"], {
      changes: [
        { id: "pdf", enabled: false },
        { id: "gone", directory: PROJECT_A, enabled: false },
      ],
      scopes: [{ folder: path.join(OWN, "deploy"), directory: PROJECT_B }],
    })
    const plain = await ok(r.rpc["skillset.view"], {})
    expect(plain.catalog.map((item) => item.id)).toEqual(["pdf", "deploy", "opencode"])
    expect(JSON.stringify(plain.catalog)).not.toContain("# pdf")
    expect(plain.off).toBeUndefined()
    // No Location of A is open: judged over the catalog, the switch of an unknown id answered by id.
    const judged = await ok(r.rpc["skillset.view"], { directory: PROJECT_A })
    expect(judged.off?.map((item) => [item.id, item.by])).toEqual([
      ["pdf", "global"],
      ["deploy", "scope"],
      ["gone", "project"],
    ])
    expect(judged.off?.at(-1)).toEqual({ id: "gone", by: "project" })
    // A's Location answers on the runtime broadcast: its answer is taken as it is.
    const answer: OwnSkillset.Off[] = [{ id: "notes", by: "project", name: "Notes", path: "x" }]
    const stop = r.t.deps.runtime.broadcast.on("skillset.removed.query", (query) => {
      if (Location.same(query.directory, PROJECT_A)) query.reply(answer)
    })
    expect((await ok(r.rpc["skillset.view"], { directory: PROJECT_A })).off).toEqual(answer)
    stop()
  })
})

describe("the module", () => {
  async function instance(directory: string, base: ReadonlyArray<Info>) {
    const core = domain(base)
    const t = await testDeps({ directory, ctx: { skill: core.skill } })
    const module = SkillsetRegister.create(t.deps)
    return { t, core, module, [Symbol.asyncDispose]: () => t[Symbol.asyncDispose]() }
  }

  test("reads the switches before its first fold, answers the query for its folder, reloads on a change", async () => {
    await using a = await instance(PROJECT_A, [skill("pdf", OWN), builtin("opencode")])
    await Bun.write(
      a.t.deps.runtime.layout.skillSwitches,
      JSON.stringify({ version: 1, switches: [{ id: "opencode", enabled: false }], scopes: [] }),
    )
    // No answer before the fold.
    const asked = () => {
      const replies: OwnSkillset.Off[][] = []
      a.t.deps.runtime.broadcast.emit("skillset.removed.query", {
        directory: PROJECT_A,
        reply: (removed) => replies.push([...removed]),
      })
      return replies
    }
    await a.module.start()
    expect(asked()).toEqual([])
    await a.module.register()
    // Built-ins are switchable: the first fold already has the switch.
    expect(a.core.read().map((item) => item.id)).toEqual(["pdf"])
    expect(asked()).toEqual([[{ id: "opencode", by: "global", name: "opencode", path: "/builtin/opencode.md" }]])
    // Another folder's query is not this Location's.
    const other: OwnSkillset.Off[][] = []
    a.t.deps.runtime.broadcast.emit("skillset.removed.query", {
      directory: PROJECT_B,
      reply: (x) => other.push([...x]),
    })
    expect(other).toEqual([])
    // A change on the broadcast: read again, reload only when the snapshot changed.
    await Bun.write(
      a.t.deps.runtime.layout.skillSwitches,
      JSON.stringify({ version: 1, switches: [{ id: "pdf", directory: PROJECT_A, enabled: false }], scopes: [] }),
    )
    a.t.deps.runtime.broadcast.emit("skillset.changed", {})
    await until(() => a.core.state.reloads === 1)
    expect(a.core.read().map((item) => item.id)).toEqual(["opencode"])
    a.t.deps.runtime.broadcast.emit("skillset.changed", {})
    await Bun.sleep(50)
    expect(a.core.state.reloads).toBe(1)
    await a.module.stop()
    expect(a.core.transforms).toHaveLength(0)
    // Stopped: no answer any more.
    expect(asked()).toEqual([])
  })

  test("registered again after plugin.updated, it folds after a transform registered later (a post plugin)", async () => {
    await using a = await instance(PROJECT_A, [builtin("opencode")])
    await Bun.write(
      a.t.deps.runtime.layout.skillSwitches,
      JSON.stringify({ version: 1, switches: [{ id: "pdf", enabled: false }], scopes: [] }),
    )
    await a.module.start()
    await a.module.register()
    // core's config skill plugin activates after the configured plugins and adds the folders' skills.
    await a.core.skill.transform((edit) => edit.add(skill("pdf", OWN) as never))
    expect(a.core.read().map((item) => item.id)).toEqual(["opencode", "pdf"])
    a.module.onEvent?.(PLUGIN_UPDATED, { local: false })
    await Bun.sleep(20)
    expect(a.core.transforms).toHaveLength(2)
    a.module.onEvent?.(PLUGIN_UPDATED, { local: true })
    await until(() => a.core.read().every((item) => item.id !== "pdf"))
    // The previous registration is gone: one fold of own's, last.
    expect(a.core.transforms).toHaveLength(2)
    expect(a.core.read().map((item) => item.id)).toEqual(["opencode"])
    await a.module.stop()
  })

  test("skillset.switch answers once every open Location folded the change", async () => {
    await using r = await rig()
    const coreA = domain([skill("pdf", OWN)])
    const a = SkillsetRegister.create({
      ...r.t.deps,
      ctx: { ...r.t.deps.ctx, skill: coreA.skill } as never,
      location: { directory: PROJECT_A, control: false },
    })
    await a.start()
    await a.register()
    await ok(r.rpc["skillset.switch"], { changes: [{ id: "pdf", directory: PROJECT_A, enabled: false }] })
    // No waiting: core's reload of A is done when the answer (and the page event) comes.
    expect(coreA.state.reloads).toBe(1)
    expect(coreA.read().map((item) => item.id)).toEqual([])
    expect(r.events.map((event) => event.name)).toEqual(["skillset.changed"])
    await a.stop()
  })

  test("a remote service registers nothing", async () => {
    const core = domain([builtin("opencode")])
    await using t = await testDeps({ directory: PROJECT_A, ctx: { skill: core.skill }, remote: {} as never })
    const module = SkillsetRegister.create(t.deps)
    await module.start()
    await module.register()
    module.onEvent?.(PLUGIN_UPDATED, { local: true })
    await Bun.sleep(20)
    expect(core.transforms).toHaveLength(0)
    await module.stop()
  })
})
