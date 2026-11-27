// Skill formats (09 §9.3): what core reads of a SKILL.md, what makes a Codex or Claude Code skill incompatible, the one
// lossless conversion, ids, keys and the content hash.
import { describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SkillFormat } from "../../src/skills/format.js"
import { codeSkillMd } from "../fixtures/skills.js"

const md = (front: string, body = "Do the thing.\n") => `---\n${front}\n---\n\n${body}`

/** A YAML alias bomb: `l0` holds nine strings, each next level nine aliases of the one before (9^levels values). */
const bomb = (levels: number) =>
  md(
    [
      "name: bomb",
      "description: d",
      `l0: &l0 [${Array(9).fill('"lol"')}]`,
      ...Array.from(
        { length: levels - 1 },
        (_, index) => `l${index + 1}: &l${index + 1} [${Array(9).fill(`*l${index}`)}]`,
      ),
    ].join("\n"),
  )

describe("analyze", () => {
  test("a plain Agent Skills file (Codex or Claude Code) is ok, with its name and description", () => {
    const analysis = SkillFormat.analyze(md("name: release-notes\ndescription: Write release notes\nlicense: MIT"))
    expect(analysis).toEqual({
      format: { status: "ok", problems: [], notes: [], ignored: [] },
      name: "release-notes",
      description: "Write release notes",
    })
  })

  test("no frontmatter is still a skill for core; no SKILL.md is not", () => {
    expect(SkillFormat.analyze("# Just steps\n").format.status).toBe("ok")
    expect(SkillFormat.analyze(undefined).format).toEqual({
      status: "incompatible",
      problems: ["no_skill_md"],
      notes: [],
      ignored: [],
    })
  })

  test("frontmatter core cannot read, or a name that is not text, is incompatible", () => {
    expect(SkillFormat.analyze(md("name: [a, b\ndescription: x")).format.problems).toEqual(["frontmatter"])
    expect(SkillFormat.analyze(md("name: 42\ndescription: x")).format.problems).toEqual(["frontmatter"])
    expect(SkillFormat.analyze(md("name: x\ndescription:\n  nested: true")).format.problems).toEqual(["frontmatter"])
  })

  test("09 §9.12: a frontmatter in another language (`---js`) is refused, never run or read", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "own-import-code-front-"))
    try {
      const opens = ["---js", "---javascript", "--- js ", "---JS", "---Javascript", "---coffee", "---cson", "---json"]
      const texts = [
        ...opens.map((open, index) => codeSkillMd(path.join(dir, `open-${index}`), open)),
        // Only `yaml` and `yml` name YAML (core's P-036): a longer or other token is refused.
        ...["---yamljs", "---yaml js", "---toml", "---ymlx"].map((open, index) => codeSkillMd(path.join(dir, `other-${index}`), open)),
        `﻿${codeSkillMd(path.join(dir, "bom"))}`,
        codeSkillMd(path.join(dir, "crlf")).replaceAll("\n", "\r\n"),
        // gray-matter takes the line up to the first `\n`, so a lone CR before the token still names `js`.
        codeSkillMd(path.join(dir, "cr"), "---\rjs"),
      ]
      const results = texts.map((text) => ({
        text,
        analysis: SkillFormat.analyze(text),
        codex: SkillFormat.analyze(text, "policy:\n  allow_implicit_invocation: false\n", { codex: true }).format,
        front: SkillFormat.frontmatter(text),
      }))
      // Nothing ran (on 8d8c7960f3 every `js` and `javascript` case wrote its marker).
      expect(await fsp.readdir(dir)).toEqual([])
      for (const result of results) {
        expect([result.text.slice(0, 16), result.analysis]).toEqual([
          result.text.slice(0, 16),
          { format: { status: "incompatible", problems: ["frontmatter_language"], notes: [], ignored: [] } },
        ])
        expect(result.codex).toMatchObject({ status: "incompatible", problems: ["frontmatter_language"] })
        // The detail shows the file as text, no key read from it.
        expect(result.front).toEqual({ entries: [], body: result.text })
      }
      // An opening line with spaces only is YAML, as before.
      expect(SkillFormat.analyze("--- \nname: a\ndescription: b\n---\n").name).toBe("a")
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  test("09 §9.12: `---yaml` and `---yml` in any case are YAML, read as core reads them (P-036)", () => {
    const opens = ["---yaml", "---yml", "---YAML", "--- Yml ", "﻿---yaml", "---yaml\r"]
    for (const open of opens) {
      const text = `${open}\nname: release-notes\ndescription: Write release notes\n---\n\nSteps.\n`
      expect([open, SkillFormat.analyze(text)]).toEqual([
        open,
        {
          format: { status: "ok", problems: [], notes: [], ignored: [] },
          name: "release-notes",
          description: "Write release notes",
        },
      ])
      expect(SkillFormat.frontmatter(text)).toEqual({
        entries: [
          { key: "name", value: "release-notes" },
          { key: "description", value: "Write release notes" },
        ],
        body: "\nSteps.\n",
      })
    }
    // A converted skill keeps its opening line, the new key under it.
    const converted = SkillFormat.convert("---yaml\nname: imagegen\ndescription: Make images\n---\nBody\n")
    expect(converted).toBe("---yaml\ndisable-model-invocation: true\nname: imagegen\ndescription: Make images\n---\nBody\n")
    expect(SkillFormat.analyze(converted, "policy:\n  allow_implicit_invocation: false\n")).toMatchObject({
      format: { status: "ok" },
      name: "imagegen",
    })
  })

  test("an unquoted colon in a value reads like core reads it (block scalar retry)", () => {
    const analysis = SkillFormat.analyze(md("name: deploy\ndescription: Use when: the user deploys"))
    expect(analysis.format.status).toBe("ok")
    expect(analysis.description).toBe("Use when: the user deploys")
  })

  test("Claude Code fields that only change permissions or display are notes", () => {
    const analysis = SkillFormat.analyze(
      md(
        [
          "name: x",
          "description: y",
          "allowed-tools: Read, Grep",
          "user-invocable: false",
          "argument-hint: <file>",
          "model: sonnet",
          "when_to_use: on reviews",
          "color: blue",
          "disable-model-invocation: true",
        ].join("\n"),
      ),
    )
    expect(analysis.format).toEqual({
      status: "ok",
      problems: [],
      notes: ["allowed_tools", "user_invocable", "argument_hint", "model", "when_to_use", "unknown_fields"],
      ignored: ["color"],
    })
  })

  test("what Claude Code does around a skill and own would skip makes it incompatible", () => {
    const problems = (front: string, body?: string) => SkillFormat.analyze(md(`name: x\n${front}`, body)).format
    expect(problems("hooks:\n  PreToolUse: []")).toMatchObject({ status: "incompatible", problems: ["hooks"] })
    expect(problems("context: fork\nagent: Explore")).toEqual({
      status: "incompatible",
      problems: ["context_fork"],
      notes: [],
      ignored: [],
    })
    expect(problems("description: y", "Status: !`git status`\n").problems).toEqual(["dynamic_context"])
    expect(problems("description: y", "Run ${CLAUDE_SKILL_DIR}/scripts/a.py\n").problems).toEqual(["skill_variables"])
    expect(problems("description: y", "Read ${CLAUDE_PLUGIN_ROOT}/x\n").problems).toEqual(["skill_variables"])
    expect(problems("description: y", "Fix issue $ARGUMENTS now\n").problems).toEqual(["arguments"])
    // A shell variable, an escaped bang and inline code that merely mentions `!` are not dynamic context.
    expect(problems("description: y", "Use $1 and `echo !x` and \\!`no`\n").status).toBe("ok")
  })

  test("SK2: what a fenced code block shows is an example; a `!` fence is Claude Code's command", () => {
    const format = (body: string) => SkillFormat.analyze(md("name: x\ndescription: y", body)).format
    expect(format("Run:\n\n```bash\nfix $ARGUMENTS\necho ${CLAUDE_SKILL_DIR}\n```\n").status).toBe("ok")
    expect(format("~~~~\nStatus: !`git status`\n~~~~\nDone.\n").status).toBe("ok")
    // A fence closes only with a run as long as its opener: the shorter run stays inside.
    expect(format("````md\n```\n$ARGUMENTS\n```\n````\n").status).toBe("ok")
    // After the fence the body is checked again, and an unclosed fence hides the rest.
    expect(format("```\nx\n```\nFix $ARGUMENTS\n").problems).toEqual(["arguments"])
    expect(format("```\n$ARGUMENTS\n").status).toBe("ok")
    // Inline code with three backticks is not a fence.
    expect(format("Use ```inline``` then $ARGUMENTS\n").problems).toEqual(["arguments"])
    expect(format("```!\ngit status\n```\n").problems).toEqual(["dynamic_context"])
  })

  test("SK2: a Codex skill's Claude Code syntax is a note, as Codex leaves it as text too", () => {
    const skill = md("name: x\ndescription: y\nhooks:\n  PreToolUse: []", "Fix $ARGUMENTS and !`git status`\n")
    expect(SkillFormat.analyze(skill).format.problems).toEqual(["hooks", "dynamic_context", "arguments"])
    expect(SkillFormat.analyze(skill, undefined, { codex: true }).format).toEqual({
      status: "ok",
      problems: [],
      notes: ["claude_only"],
      ignored: [],
    })
  })

  test("SK2: the version shows from version or metadata.version; the detail lists every key as text", () => {
    expect(SkillFormat.analyze(md("name: a\nversion: 2.0.0")).version).toBe("2.0.0")
    expect(SkillFormat.analyze(md("name: a\nversion: 2")).version).toBe("2")
    expect(SkillFormat.analyze(md("name: a\nmetadata:\n  version: '1.1'")).version).toBe("1.1")
    expect(SkillFormat.analyze(md("name: a")).version).toBeUndefined()
    const front = SkillFormat.frontmatter(
      md("name: a\ndescription: b\nallowed-tools: [Read, Grep]\nmetadata:\n  owner: me\nempty:", "# Body\n"),
    )
    expect(front.entries).toEqual([
      { key: "name", value: "a" },
      { key: "description", value: "b" },
      { key: "allowed-tools", value: "Read, Grep" },
      { key: "metadata", value: '{"owner":"me"}' },
      { key: "empty", value: "" },
    ])
    expect(front.body).toBe("\n# Body\n")
    expect(SkillFormat.frontmatter("# no frontmatter\n")).toEqual({ entries: [], body: "# no frontmatter\n" })
  })

  // SK2 (2026-10-25): 462 bytes of eight alias levels took 68 s and 1.9 GB as JSON on the service thread.
  for (const levels of [8, 9])
    test(`a YAML alias bomb of ${levels} levels is measured, not expanded: fast, and its values say why they are missing`, () => {
      const started = performance.now()
      const front = SkillFormat.frontmatter(bomb(levels))
      expect(performance.now() - started).toBeLessThan(2_000)
      const byKey = new Map(front.entries.map((entry) => [entry.key, entry]))
      expect(byKey.get("name")).toEqual({ key: "name", value: "bomb" })
      expect(byKey.get("l0")?.value).toBe("lol, lol, lol, lol, lol, lol, lol, lol, lol")
      // 9^5 values and more: not shown, said so.
      for (const level of Array.from({ length: levels - 4 }, (_, index) => index + 4))
        expect(byKey.get(`l${level}`)).toEqual({ key: `l${level}`, value: "", omitted: "aliases" })
      // 9^3 values: still shown, cut at 2,000 characters.
      expect(byKey.get("l2")?.value).toHaveLength(2_000)
      expect(byKey.get("l2")?.value.endsWith("…")).toBe(true)
      // The format check reads the same file as fast (it never writes the values out).
      expect(SkillFormat.analyze(bomb(levels)).format.status).toBe("ok")
    })

  test("a YAML loop, a long value and a large list without aliases: bounded, said or cut, never a throw", () => {
    const front = SkillFormat.frontmatter(
      md(
        `name: a\nloop: &x [1, *x]\nlong: ${"x".repeat(5_000)}\nlist: [${Array.from({ length: 50_000 }, (_, i) => i)}]`,
      ),
    )
    expect(front.entries.find((entry) => entry.key === "loop")).toEqual({ key: "loop", value: "", omitted: "aliases" })
    expect(front.entries.find((entry) => entry.key === "long")?.value).toBe(`${"x".repeat(1_999)}…`)
    const list = front.entries.find((entry) => entry.key === "list")
    expect(list?.omitted).toBeUndefined()
    expect(list?.value.startsWith("0, 1, 2, ")).toBe(true)
    expect(list?.value).toHaveLength(2_000)
    // The call's own budget: once it is spent, later keys are omitted, not written.
    const spent = SkillFormat.frontmatter(md("name: a\ndescription: bbbb\nc: d"), { ms: 1_000, chars: 3 })
    expect(spent.entries).toEqual([
      { key: "name", value: "a" },
      { key: "description", value: "bbbb" },
      { key: "c", value: "", omitted: "budget" },
    ])
  })

  test("Codex agents/openai.yaml: UI and dependencies are notes, implicit use off converts losslessly", () => {
    const skill = md("name: imagegen\ndescription: Make images")
    expect(SkillFormat.analyze(skill, "interface:\n  display_name: Image Gen\n").format).toEqual({
      status: "ok",
      problems: [],
      notes: ["codex_interface"],
      ignored: [],
    })
    expect(
      SkillFormat.analyze(skill, "policy:\n  allow_implicit_invocation: false\ndependencies:\n  tools: []\n").format,
    ).toEqual({ status: "converted", problems: [], notes: ["codex_dependencies"], ignored: [] })
    // Already said in SKILL.md (or by own's metadata key): nothing to convert.
    expect(
      SkillFormat.analyze(
        md("name: a\ndisable-model-invocation: true"),
        "policy:\n  allow_implicit_invocation: false\n",
      ).format.status,
    ).toBe("ok")
    expect(
      SkillFormat.analyze(
        md("name: a\nmetadata:\n  opencode/autoinvoke: true"),
        "policy:\n  allow_implicit_invocation: false\n",
      ).format.status,
    ).toBe("ok")
    expect(SkillFormat.analyze(skill, "policy:\n  allow_implicit_invocation: true\n").format.status).toBe("ok")
  })

  test("file problems make any format incompatible", () => {
    const ok = SkillFormat.analyze(md("name: a")).format
    expect(SkillFormat.withProblems(ok, [])).toBe(ok)
    expect(SkillFormat.withProblems(ok, ["links", "links", "secret_file"])).toEqual({
      ...ok,
      status: "incompatible",
      problems: ["links", "secret_file"],
    })
  })
})

describe("convert", () => {
  test("adds disable-model-invocation as the first key and changes nothing else", () => {
    const source = md("name: imagegen\ndescription: Make images", "Body\n")
    const out = SkillFormat.convert(source)
    expect(out).toBe(`---\ndisable-model-invocation: true\nname: imagegen\ndescription: Make images\n---\n\nBody\n`)
    expect(out.replace("disable-model-invocation: true\n", "")).toBe(source)
    const converted = SkillFormat.analyze(out, "policy:\n  allow_implicit_invocation: false\n")
    expect(converted.format.status).toBe("ok")
    expect(converted.name).toBe("imagegen")
  })

  test("keeps CRLF and a BOM, and adds a frontmatter when there is none", () => {
    expect(SkillFormat.convert("\uFEFF---\r\nname: a\r\n---\r\nB\r\n")).toBe(
      "\uFEFF---\r\ndisable-model-invocation: true\r\nname: a\r\n---\r\nB\r\n",
    )
    expect(SkillFormat.convert("# Steps\n")).toBe("---\ndisable-model-invocation: true\n---\n# Steps\n")
  })
})

describe("ids, keys, files and the hash", () => {
  test("cleanID keeps a valid folder name and cleans others into a valid id", () => {
    expect<string>(SkillFormat.cleanID("release-notes")).toBe("release-notes")
    expect<string>(SkillFormat.cleanID("My Skill (v2)")).toBe("My-Skill-v2-")
    expect(SkillFormat.validID(SkillFormat.cleanID("My Skill (v2)"))).toBe(true)
    expect<string>(SkillFormat.cleanID(".system")).toBe("system")
    expect<string>(SkillFormat.cleanID("한글")).toBe("skill")
    expect<string>(SkillFormat.cleanID("con")).toBe("skill")
    expect(SkillFormat.cleanID("a".repeat(80)).length).toBe(64)
  })

  test("keys are path-free and stable", () => {
    const key = SkillFormat.key("codex-0123", "skills/a")
    expect(key).toMatch(/^sk-[0-9a-f]{20}$/)
    expect(SkillFormat.key("codex-0123", "skills/a")).toBe(key)
    expect(SkillFormat.key("codex-0123", "skills/b")).not.toBe(key)
  })

  test("scripts by extension, folder or mode; secrets by name", () => {
    expect(["run.py", "scripts/a.txt", "bin/tool", "x.ps1", "README.md"].map((f) => SkillFormat.isScript(f))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
    expect(SkillFormat.isScript("tool", true)).toBe(true)
    expect(
      ["auth.json", "a/.env", ".env.local", "deploy.pem", "id_rsa", "notes.md", "env.md"].map(SkillFormat.isSecret),
    ).toEqual([true, true, true, true, true, false, false])
    // SK2: an environment template shows the settings, never their values.
    expect([".env.example", "a/.env.sample", ".env.template", ".env.prod"].map(SkillFormat.isSecret)).toEqual([
      false,
      false,
      false,
      true,
    ])
  })

  test("the hash covers paths and bytes in path order, whatever order they come in", () => {
    const a = { relative: "SKILL.md", bytes: new TextEncoder().encode("x") }
    const b = { relative: "scripts/run.py", bytes: new TextEncoder().encode("print(1)") }
    expect(SkillFormat.digest([a, b])).toBe(SkillFormat.digest([b, a]))
    expect(SkillFormat.digest([a, b])).not.toBe(SkillFormat.digest([a, { ...b, relative: "scripts/run2.py" }]))
    expect(SkillFormat.digest([a, b])).not.toBe(SkillFormat.digest([a, { ...b, bytes: new Uint8Array([1]) }]))
  })
})
