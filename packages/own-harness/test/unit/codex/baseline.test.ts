import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Baseline } from "../../../src/codex/baseline.js"

const ENV = [
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: C:\work\app",
  "  Workspace root folder: C:\work\app",
  "  Is directory a git repo: yes",
  "  Platform: win32",
  "  Prefer C:\tmp\own over generic system temporary directories such as /tmp; it is pre-created and approved for external access.",
  "</env>",
].join("\n")

const SKILLS = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <id>review</id>",
  "    <name>review</name>",
  "    <description>Review code</description>",
  "  </skill>",
  "</available_skills>",
].join("\n")

describe("Baseline.parse", () => {
  test("splits every section of a full baseline", () => {
    const baseline = [
      "# Code Mode\n\nUse the `execute` tool to call the tools listed below.\n\n## Available tools\n\n- own (2 tools)",
      "<mcp_instructions>\n  <server name=\"x\">\n    hi\n  </server>\n</mcp_instructions>",
      SKILLS,
      "Instructions from: C:\Users\me\.config\opencode\AGENTS.md\nGlobal rule.",
      "Instructions from: C:\work\app\AGENTS.md\nProject rule.\n\nSecond paragraph.",
      "Today's date: Sun Oct 11 2026",
      ENV,
      '<context key="own.preset">\nYou are the planner.\n</context>',
      '<context key="own.team.role">\n{\n  "role": "lead"\n}\n</context>',
    ].join("\n\n")
    const parsed = Baseline.parse(baseline)
    expect(parsed.codemode).toStartWith("# Code Mode")
    expect(parsed.mcp).toStartWith("<mcp_instructions>")
    expect(parsed.skills).toBe(SKILLS)
    expect(parsed.instructions).toEqual([
      { path: "C:\Users\me\.config\opencode\AGENTS.md", content: "Global rule." },
      { path: "C:\work\app\AGENTS.md", content: "Project rule.\n\nSecond paragraph." },
    ])
    expect(parsed.date).toBe("Sun Oct 11 2026")
    expect(Baseline.isoDate(parsed.date!)).toBe("2026-10-11")
    expect(parsed.environment).toEqual({
      workingDirectory: "C:\work\app",
      workspaceRoot: "C:\work\app",
      git: true,
      platform: "win32",
    })
    expect(parsed.contexts).toEqual([
      { key: "own.preset", value: "You are the planner." },
      { key: "own.team.role", value: '{\n  "role": "lead"\n}' },
    ])
    expect(parsed.rest).toEqual([])
  })

  test("a minimal baseline has only the date and environment", () => {
    const parsed = Baseline.parse(["Today's date: Sun Oct 11 2026", ENV].join("\n\n"))
    expect(parsed.instructions).toEqual([])
    expect(parsed.environment?.workingDirectory).toBe("C:\work\app")
    expect(parsed.contexts).toEqual([])
  })

  test("unknown text is kept in rest", () => {
    const parsed = Baseline.parse(["Something new", "Today's date: Sun Oct 11 2026", ENV, "trailing note"].join("\n\n"))
    expect(parsed.rest).toEqual(["Something new", "trailing note"])
  })
})

describe("Baseline.sources", () => {
  const file = (path: string) => ({ path, content: path })
  const CWD = "C:\\work\\app\\pkg"

  test("the global AGENTS.md, the project's from the root down, then config instructions in config order", () => {
    const sources = Baseline.sources(
      [
        file("C:\\Users\\me\\.config\\opencode\\AGENTS.md"),
        file("C:\\work\\app\\pkg\\AGENTS.md"),
        file("C:\\work\\app\\AGENTS.md"),
        // Config `instructions`: a file in a project folder, an AGENTS.md below the working directory, a URL, and an
        // AGENTS.md elsewhere. None of them is a project file, and nothing after the first moves back.
        file("C:\\work\\app\\CONTRIBUTING.md"),
        file("C:\\work\\app\\pkg\\docs\\AGENTS.md"),
        file("https://example.com/rules/AGENTS.md"),
        file("D:\\shared\\AGENTS.md"),
      ],
      CWD,
    )
    expect(sources.global.map((entry) => entry.path)).toEqual(["C:\\Users\\me\\.config\\opencode\\AGENTS.md"])
    expect(sources.project.map((entry) => entry.path)).toEqual([
      "C:\\work\\app\\AGENTS.md",
      "C:\\work\\app\\pkg\\AGENTS.md",
    ])
    expect(sources.configured.map((entry) => entry.path)).toEqual([
      "C:\\work\\app\\CONTRIBUTING.md",
      "C:\\work\\app\\pkg\\docs\\AGENTS.md",
      "https://example.com/rules/AGENTS.md",
      "D:\\shared\\AGENTS.md",
    ])
  })

  test("without a global file the project's come first; a real path's name case does not matter", () => {
    const sources = Baseline.sources([file("C:\\work\\app\\pkg\\agents.md"), file("C:\\work\\app\\AGENTS.md")], CWD)
    expect(sources.global).toEqual([])
    expect(sources.project.map((entry) => entry.path)).toEqual([
      "C:\\work\\app\\AGENTS.md",
      "C:\\work\\app\\pkg\\agents.md",
    ])
    expect(sources.configured).toEqual([])
  })

  test("config instructions alone stay configured, a URL first included", () => {
    const sources = Baseline.sources([file("https://example.com/AGENTS.md"), file("C:\\work\\app\\AGENTS.md")], CWD)
    expect(sources.global).toEqual([])
    expect(sources.project).toEqual([])
    expect(sources.configured.map((entry) => entry.path)).toEqual([
      "https://example.com/AGENTS.md",
      "C:\\work\\app\\AGENTS.md",
    ])
  })
})

describe("Baseline.sources through a junction", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-baseline-")))
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  test("the files core lists by real path are read against the working directory's real path", () => {
    const real = path.join(root, "real")
    fs.mkdirSync(path.join(real, "app", "pkg"), { recursive: true })
    const link = path.join(root, "link")
    // A real junction (a directory link on other platforms), as a Location reached through one.
    fs.symlinkSync(real, link, "junction")
    const cwd = path.join(link, "app", "pkg")
    // Core walks from the real folder and lists each file by its real path (config/plugin/instruction.ts).
    const listed = [
      path.join(real, "app", "pkg", "AGENTS.md"),
      path.join(real, "app", "AGENTS.md"),
      path.join(real, "app", "CONTRIBUTING.md"),
    ].map((file) => ({ path: file, content: file }))
    const realCwd = fs.realpathSync(cwd)
    expect(realCwd).toBe(path.join(real, "app", "pkg"))
    const sources = Baseline.sources(listed, realCwd)
    expect(sources.global).toEqual([])
    expect(sources.project.map((file) => file.path)).toEqual([
      path.join(real, "app", "AGENTS.md"),
      path.join(real, "app", "pkg", "AGENTS.md"),
    ])
    expect(sources.configured.map((file) => file.path)).toEqual([path.join(real, "app", "CONTRIBUTING.md")])
    // Against the Location's spelling the nearest file read as the global one and the rest as configured.
    const spelled = Baseline.sources(listed, cwd)
    expect(spelled.global.map((file) => file.path)).toEqual([path.join(real, "app", "pkg", "AGENTS.md")])
    expect(spelled.project).toEqual([])
  })
})
