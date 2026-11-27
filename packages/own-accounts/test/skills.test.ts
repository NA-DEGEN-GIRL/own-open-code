// The built-in skill edits (external-repos-2026-10-05 P0-1, decision D5) over a fake skill editor with core's
// semantics: the `opencode` section is appended once, the `report` snapshot shows the home directory as `~` and gets
// one private-fork sentence, names and descriptions stay as they were, and a missing skill or config directory is a
// logged no-op for that skill. The config directories are fake paths and the report paths are strings built from
// `os.homedir()`; nothing is read from or written to any of them.

import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import type { Types } from "effect"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Hooks } from "../src/hooks.js"
import { Logger } from "../src/logger.js"
import type { RemoteHost } from "../src/remote/host.js"
import { Skills } from "../src/skills.js"
import { testDeps } from "./support/deps.js"

/** `OPENCODE_CONFIG_DIR` on this PC and of a remote host's service (fake paths). */
const LOCAL_DIR = "C:\\Users\\dev\\.config\\own-open-code"
const REMOTE_DIR = "/home/dev/.config/own-open-code"
const MODES = [
  { mode: "local", configDir: LOCAL_DIR },
  { mode: "remote", configDir: REMOTE_DIR },
] as const

/** The home directory as written natively, with `/` (how the launcher writes plugin entries) and in other case. */
const HOME = os.homedir()
const SLASHED = HOME.replaceAll("\\", "/")
const UPPER = HOME.toUpperCase()

/**
 * A report snapshot whose home-directory prefixes are written by `home`; the `Elsewhere` paths only share the home
 * directory's leading characters and must never change.
 */
function snapshot(home: (form: string) => string) {
  return [
    "# Report",
    "",
    `- Active plugins: ${home(HOME)}${path.sep}plugins${path.sep}own-accounts, ${home(SLASHED)}/AppData/Local/own-open-code/app/2.0.18-own.6/plugins/own-team`,
    `- Shell: ${home(UPPER)}${path.sep}bin${path.sep}bash`,
    `- Elsewhere: ${HOME}2${path.sep}plugins, ${SLASHED}.old/plugins`,
    `- Working directory: ${home(HOME)}`,
  ].join("\n")
}
const SCRUBBED = snapshot(() => "~")

/** Core's two built-in skills with fixture content (the real text lives in core). */
function builtins() {
  return [
    Skill.Info.make({
      id: Skill.ID.make("opencode"),
      name: Skill.Name.make("OpenCode"),
      description: "Use this skill for any question about OpenCode itself.",
      path: AbsolutePath.make("/builtin/opencode.md"),
      content: "# OpenCode\n\nGlobal configuration lives at `~/.config/opencode/opencode.json(c)`.",
    }),
    Skill.Info.make({
      id: Skill.ID.make("report"),
      name: Skill.Name.make("Report"),
      description: "Use when the user wants to report an opencode issue or bug.",
      path: AbsolutePath.make("/builtin/report.md"),
      content: snapshot((form) => form),
    }),
  ]
}

/** A skill editor over a map, like core's (`update` edits the stored record and ignores a missing id). */
function editor(skills: ReadonlyArray<Skill.Info>) {
  const records = new Map<string, Types.DeepMutable<Skill.Info>>(skills.map((skill) => [skill.id, { ...skill }]))
  const updates: string[] = []
  const value: SkillEditor = {
    list: () => [...records.values()],
    get: (id) => records.get(id),
    add: (skill) => void records.set(skill.id, { ...skill }),
    update: (id, update) => {
      updates.push(id)
      const current = records.get(id)
      if (current) update(current)
    },
    remove: (id) => void records.delete(id),
  }
  return { value, records, updates }
}

function capture() {
  const lines: string[] = []
  return { lines, log: Logger.create({ scope: "test", level: "debug", sink: (line) => lines.push(line) }) }
}

describe("Skills.transform", () => {
  for (const { mode, configDir } of MODES)
    test(`${mode}: appends the own section to opencode once; name and description unchanged`, () => {
      const before = builtins()
      const fake = editor(before)
      Skills.transform(fake.value, { configDir, log: Logger.silent })
      const opencode = fake.records.get("opencode")
      const original = before[0]
      if (!opencode || !original) throw new Error("opencode skill missing")
      expect(fake.updates).toEqual(["opencode", "report"])
      expect({ ...opencode, content: original.content }).toEqual({ ...original })
      expect(opencode.content.startsWith(`${original.content}\n\n## own-open-code\n`)).toBe(true)
      expect(opencode.content.split("## own-open-code").length).toBe(2)
      const section = opencode.content.slice(original.content.length)
      expect(section.length).toBeGreaterThanOrEqual(600)
      expect(section.length).toBeLessThanOrEqual(800)
      expect(section).toContain(`\`${configDir}\``)
      for (const phrase of [
        "OPENCODE_CONFIG_DIR",
        "`opencode.jsonc`, `cli.json` and the global `AGENTS.md` live there",
        "Every `~/.config/opencode` or `$XDG_CONFIG_HOME/opencode` path in this skill means that directory",
        "Never create or edit files under `~/.config/opencode`",
        "Do not edit the own plugin entries (`own-*`)",
        "Accounts, presets and the approval mode belong in the own app settings",
      ])
        expect(section).toContain(phrase)
      // Core rebuilds the skills for every fold: the next fold appends the same bytes once again.
      const again = editor(builtins())
      Skills.transform(again.value, { configDir, log: Logger.silent })
      expect(again.records.get("opencode")?.content).toBe(opencode.content)
    })

  test("report: home-directory prefixes become ~ and one private-fork sentence is appended; name and description unchanged", () => {
    const before = builtins()
    const fake = editor(before)
    Skills.transform(fake.value, { configDir: LOCAL_DIR, log: Logger.silent })
    const report = fake.records.get("report")
    const original = before[1]
    if (!report || !original) throw new Error("report skill missing")
    expect({ ...report, content: original.content }).toEqual({ ...original })
    expect(report.content.startsWith(`${SCRUBBED}\n\n`)).toBe(true)
    const sentence = report.content.slice(SCRUBBED.length + 2)
    expect(sentence).not.toContain("\n")
    expect(sentence.endsWith(".")).toBe(true)
    expect(sentence.slice(0, -1)).not.toMatch(/[.!?]\s/)
    for (const phrase of [
      "own-open-code, a private fork",
      "overrides the publishing steps above",
      "never file an issue at `anomalyco/opencode`",
      "publish only to a repository the user names (`gh issue create --repo <owner/name>`)",
    ])
      expect(sentence).toContain(phrase)
    // Core rebuilds the skills for every fold: the next fold produces the same bytes, config directory or not.
    const again = editor(builtins())
    Skills.transform(again.value, { configDir: undefined, log: Logger.silent })
    expect(again.records.get("report")?.content).toBe(report.content)
  })

  test("a missing opencode skill is logged once; report still gets its edit", () => {
    const fake = editor(builtins().filter((skill) => skill.id === "report"))
    const logs = capture()
    Skills.transform(fake.value, { configDir: LOCAL_DIR, log: logs.log })
    expect(fake.updates).toEqual(["report"])
    expect(fake.records.has("opencode")).toBe(false)
    expect(fake.records.get("report")?.content.startsWith(`${SCRUBBED}\n\n`)).toBe(true)
    expect(logs.lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: "debug", msg: "skill_missing", skill: "opencode" }),
    ])
  })

  test("a missing report skill is logged once; opencode still gets its section", () => {
    const fake = editor(builtins().filter((skill) => skill.id === "opencode"))
    const logs = capture()
    Skills.transform(fake.value, { configDir: LOCAL_DIR, log: logs.log })
    expect(fake.updates).toEqual(["opencode"])
    expect(fake.records.has("report")).toBe(false)
    expect(fake.records.get("opencode")?.content).toContain(`\`${LOCAL_DIR}\``)
    expect(logs.lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: "debug", msg: "skill_missing", skill: "report" }),
    ])
  })

  test("an unset config directory leaves opencode unchanged (one debug log); report still gets its edit", () => {
    const before = builtins()
    const fake = editor(before)
    const logs = capture()
    Skills.transform(fake.value, { configDir: undefined, log: logs.log })
    expect(fake.updates).toEqual(["report"])
    expect(fake.records.get("opencode")).toEqual({ ...before[0] })
    expect(fake.records.get("report")?.content.startsWith(`${SCRUBBED}\n\n`)).toBe(true)
    expect(logs.lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: "debug", msg: "skill_section_skipped", reason: "config_dir_unset" }),
    ])
  })
})

describe("registration (hooks.ts)", () => {
  for (const { mode, configDir } of MODES)
    test(`${mode}: Hooks.register adds the fold once in setup, through the guard, with the deps' directory`, async () => {
      const transforms: Array<(editor: SkillEditor) => void> = []
      const registration = { dispose: async () => {} }
      const registered = async () => registration
      const logs: string[] = []
      await using t = await testDeps({
        logs,
        configDir,
        ctx: {
          provider: { transform: registered },
          model: { transform: registered },
          agent: { transform: registered },
          skill: {
            transform: async (callback: (editor: SkillEditor) => void) => {
              transforms.push(callback)
              return registration
            },
          },
          session: { hook: registered },
          tool: { hook: registered },
          permission: { hook: registered },
        },
      })
      // SAFETY: registration only checks that the remote service is there; its methods run inside hooks, never here.
      const remote = mode === "remote" ? { remote: {} as unknown as RemoteHost.Api } : {}
      await Hooks.register({ ...t.deps, ...remote }, t.modules())
      expect(transforms).toHaveLength(1)
      const fold = transforms[0]
      if (!fold) throw new Error("skill.transform was not registered")

      const fake = editor(builtins())
      fold(fake.value)
      expect(fake.records.get("opencode")?.content).toContain(`\`${configDir}\``)
      expect(fake.records.get("report")?.content.startsWith(`${SCRUBBED}\n\n`)).toBe(true)

      // A failing fold is logged and never reaches core.
      const failing = editor(builtins())
      fold({
        ...failing.value,
        update: () => {
          throw new Error("editor failed")
        },
      })
      expect(logs.some((line) => line.includes("hook_failed") && line.includes("skill.transform"))).toBe(true)
    })
})
