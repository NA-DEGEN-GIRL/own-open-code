// Ports packages/coding-agent/test/system-prompt.test.ts and tool-system-prompt-contributions.test.ts (the `docs`
// cases go: own leaves Pi's documentation section out), plus the whole default prompt, spelled out so a change of Pi's
// text shows here (Pi 1.5.0 tightened it, 705d047cb).
// Ported from earendil-works/pi (MIT, Copyright (c) 2025 Mario Zechner) @ dd30101cf.
import { describe, expect, test } from "bun:test"
import { PiPrompt } from "../../../src/pi/prompt.js"

const testSkill: PiPrompt.Skill = {
  name: "test-skill",
  description: "A test skill.",
  filePath: "/skills/test-skill/SKILL.md",
}

const DEFAULT = [
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
  "",
  "<tools>",
  "- read: Read file contents",
  "- bash: Execute bash commands (ls, grep, find, etc.)",
  "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  "- write: Create or overwrite files",
  "",
  "Additional tools may be available.",
  "</tools>",
  "",
  "<rules>",
  "- Use bash for file operations like ls, rg, find",
  "- Use read to examine files instead of cat or sed.",
  "- You can inspect PI_* environment variables for current model and session details.",
  "- Use edit for targeted changes. Batch changes to one file in a single call.",
  "- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
  "- Use write only for new files or complete rewrites.",
  "- Be concise in your responses",
  "- Show file paths clearly when working with files",
  "</rules>",
  "",
  "<cwd>",
  "C:/work/project",
  "</cwd>",
].join("\n")

describe("PiPrompt.build", () => {
  test("the default prompt with Pi's four tools, as Pi renders it without its docs section", () => {
    expect(PiPrompt.build({ cwd: "C:\\work\\project" })).toBe(DEFAULT)
  })

  test("addendum, project context and skills sit between the rules and the cwd, in Pi's order", () => {
    const prompt = PiPrompt.build({
      cwd: "/tmp",
      appendSystemPrompt: "Extra.",
      contextFiles: [
        { path: "/home/u/.pi/agent/AGENTS.md", content: "Global." },
        { path: "/tmp/AGENTS.md", content: "Project." },
      ],
      skills: [testSkill],
    })
    const order = ["</rules>", "<addendum>", "<project_context>", "<skills>", "<cwd>"].map((tag) => prompt.indexOf(tag))
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    expect(prompt).toContain(
      [
        "<project_context>",
        "Project-specific instructions and guidelines:",
        "",
        '<project_instructions path="/home/u/.pi/agent/AGENTS.md">',
        "Global.",
        "</project_instructions>",
        "",
        '<project_instructions path="/tmp/AGENTS.md">',
        "Project.",
        "</project_instructions>",
        "</project_context>",
      ].join("\n"),
    )
    expect(prompt).toContain(
      [
        "<skills>",
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
        "",
        "<available_skills>",
        "  <skill>",
        "    <name>test-skill</name>",
        "    <description>A test skill.</description>",
        "    <location>/skills/test-skill/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
        "</skills>",
      ].join("\n"),
    )
  })
})

describe("buildSystemPrompt (Pi's tests)", () => {
  describe("empty tools", () => {
    test("shows (none) for empty tools list", () => {
      const prompt = PiPrompt.render({ selectedTools: [], contextFiles: [], skills: [], cwd: process.cwd() })
      expect(prompt).toContain("<tools>\n(none)\n")
    })

    test("shows file paths guideline even with no tools", () => {
      const prompt = PiPrompt.render({ selectedTools: [], contextFiles: [], skills: [], cwd: process.cwd() })
      expect(prompt).toContain("Show file paths clearly")
    })
  })

  describe("prompt structure", () => {
    test("keeps the default and custom prompt prefixes exact", () => {
      const defaultPrompt = PiPrompt.render({ cwd: "/tmp", selectedTools: [], contextFiles: [], skills: [] })
      const customPrompt = PiPrompt.render({
        customPrompt: "You are Exact.",
        cwd: "/tmp",
        selectedTools: [],
        contextFiles: [],
        skills: [],
      })
      expect(defaultPrompt.startsWith("You are a coding assistant running inside pi, a coding agent harness.")).toBe(
        true,
      )
      expect(customPrompt.startsWith("You are Exact.\n\n<cwd>")).toBe(true)
    })

    test("maps appended instructions and project context to stable sections", () => {
      const prompt = PiPrompt.render({
        customPrompt: "You are Exact.",
        appendSystemPrompt: "Additional instructions.",
        contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project instructions." }],
        selectedTools: [],
        skills: [],
        cwd: "/tmp",
      })
      expect(prompt).toContain("<addendum>\nAdditional instructions.\n</addendum>")
      expect(prompt).toContain(
        '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/tmp/AGENTS.md">',
      )
      expect(prompt).toContain("<cwd>\n/tmp\n</cwd>")
    })
  })

  describe("default tools", () => {
    test("includes all default tools when snippets are provided", () => {
      const prompt = PiPrompt.render({
        toolSnippets: {
          read: "Read file contents",
          bash: "Execute bash commands",
          edit: "Make surgical edits",
          write: "Create or overwrite files",
        },
        contextFiles: [],
        skills: [],
        cwd: process.cwd(),
      })
      expect(prompt).toContain("- read:")
      expect(prompt).toContain("- bash:")
      expect(prompt).toContain("- edit:")
      expect(prompt).toContain("- write:")
    })

    test.each([
      [["powershell"], "Use PowerShell for file operations"],
      [["bash", "powershell"], "Use bash or PowerShell for file operations"],
    ] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
      const prompt = PiPrompt.render({
        selectedTools: [...selectedTools],
        contextFiles: [],
        skills: [],
        cwd: process.cwd(),
      })
      expect(prompt).toContain(expected)
    })

    test("leaves Pi's documentation section out", () => {
      const prompt = PiPrompt.build({ contextFiles: [], skills: [], cwd: process.cwd() })
      expect(prompt).not.toContain("<docs>")
      expect(prompt).not.toContain("Pi documentation")
    })
  })

  describe("custom tool snippets", () => {
    test("includes custom tools in available tools section when promptSnippet is provided", () => {
      const prompt = PiPrompt.render({
        selectedTools: ["read", "dynamic_tool"],
        toolSnippets: { dynamic_tool: "Run dynamic test behavior" },
        contextFiles: [],
        skills: [],
        cwd: process.cwd(),
      })
      expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior")
    })

    test("omits custom tools from available tools section when promptSnippet is not provided", () => {
      const prompt = PiPrompt.render({
        selectedTools: ["read", "dynamic_tool"],
        contextFiles: [],
        skills: [],
        cwd: process.cwd(),
      })
      expect(prompt).not.toContain("dynamic_tool")
    })
  })

  describe("prompt guidelines", () => {
    test("appends promptGuidelines to default guidelines", () => {
      const prompt = PiPrompt.render({
        selectedTools: ["read", "dynamic_tool"],
        promptGuidelines: ["Use dynamic_tool for project summaries."],
        contextFiles: [],
        skills: [],
        cwd: process.cwd(),
      })
      expect(prompt).toContain("- Use dynamic_tool for project summaries.")
    })

    test("deduplicates and trims promptGuidelines", () => {
      const prompt = PiPrompt.render({
        selectedTools: ["read", "dynamic_tool"],
        promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
        contextFiles: [],
        skills: [],
        cwd: process.cwd(),
      })
      expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1)
    })
  })

  describe("skills", () => {
    test.each([
      { name: "default prompt", customPrompt: undefined },
      { name: "custom prompt", customPrompt: "Custom system prompt" },
    ])("includes skills with only bash in the $name", ({ customPrompt }) => {
      const prompt = PiPrompt.render({
        customPrompt,
        selectedTools: ["bash"],
        contextFiles: [],
        skills: [testSkill],
        cwd: process.cwd(),
      })
      expect(prompt).toContain("<skills>")
      expect(prompt).toContain("<available_skills>")
      expect(prompt).toContain("<name>test-skill</name>")
      expect(prompt).toContain("Use bash to load a skill's file")
      expect(prompt).toContain(
        "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
      )
    })

    test("omits skills without read or bash", () => {
      const prompt = PiPrompt.render({
        selectedTools: ["write"],
        contextFiles: [],
        skills: [testSkill],
        cwd: process.cwd(),
      })
      expect(prompt).not.toContain("<available_skills>")
    })

    test("escapes skill fields and hides skills the model may not invoke", () => {
      const prompt = PiPrompt.formatSkills([
        { name: "a&b", description: `<"quoted">'s`, filePath: "/s/SKILL.md" },
        { name: "hidden", description: "x", filePath: "/h/SKILL.md", disableModelInvocation: true },
      ])
      expect(prompt).toContain("<name>a&amp;b</name>")
      expect(prompt).toContain("<description>&lt;&quot;quoted&quot;&gt;&apos;s</description>")
      expect(prompt).not.toContain("hidden")
    })
  })

  // #10343
  describe("hidden tools", () => {
    const build = (hiddenTools: Array<string>) =>
      PiPrompt.render({
        selectedTools: ["read", "bash", "run"],
        hiddenTools,
        toolSnippets: { read: "Read files", bash: "Run commands", run: "Run a task" },
        toolGuidelines: { read: ["Use read for files."], run: ["Prefer run."] },
        contextFiles: [],
        skills: [testSkill],
        cwd: process.cwd(),
      })

    test("leaves hidden tools out of the tool list and rules", () => {
      const prompt = build(["read", "bash"])
      expect(prompt).toContain("<tools>\n- run: Run a task\n")
      expect(prompt).not.toContain("- read: ")
      expect(prompt).not.toContain("Use read for files.")
      expect(prompt).not.toContain("Use bash for file operations")
      expect(prompt).toContain("- Prefer run.")
    })

    test("keeps skills without naming a hidden reader", () => {
      expect(build(["read", "bash"])).toContain("\nLoad a skill's file when the task matches its description.")
      expect(build(["read"])).toContain("Use bash to load a skill's file")
      expect(build([])).toContain("Use the read tool to load a skill's file")
    })
  })
})

describe("built-in tool system prompt contributions", () => {
  test("each of Pi's default tools has a snippet and guidelines", () => {
    expect(Object.keys(PiPrompt.CONTRIBUTIONS)).toEqual([...PiPrompt.DEFAULT_TOOLS])
    PiPrompt.DEFAULT_TOOLS.forEach((name) => {
      expect(PiPrompt.CONTRIBUTIONS[name]!.snippet.length).toBeGreaterThan(0)
      expect(PiPrompt.CONTRIBUTIONS[name]!.guidelines.length).toBeGreaterThan(0)
    })
  })
})
