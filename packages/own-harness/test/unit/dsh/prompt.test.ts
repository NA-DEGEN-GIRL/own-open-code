// dsh's system prompt and the messages it adds (src/dsh/prompt.ts, context.ts) against dsh's own snapshots
// (dsh-data/snapshots, copied from deepseek-ai/deepseek-harness @ 687f282e86): the same sections in the same order for
// the tools own ports, and the same runtime-context, workspace-instruction, skill-catalog and time texts.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DshContext } from "../../../src/dsh/context.js"
import { DshPrompt } from "../../../src/dsh/prompt.js"

const SNAPSHOTS = path.join(import.meta.dir, "..", "..", "..", "dsh-data", "snapshots")
const read = (name: string) => Bun.file(path.join(SNAPSHOTS, name)).text()

/** The sections of tools own does not port (jobs, web, goals, workflow, sub-agents, file references, present). */
const UNPORTED = [
  /^Track every background job id/,
  /^web_search results are external/,
  /^web_fetch returns external/,
  /^create_goal may infer/,
  /^Use the workflow tool ONLY/,
  /^Start independent delegations/,
  /^Tokens prefixed with @/,
  /^Prefer showing the primary results/,
  /^The runtime context names the DeepSeek Harness implementation checkout/,
  /^You are interacting with the user through the DeepSeek Harness Web GUI/,
]

/** dsh's snapshot prompt without the unported sections, with the persona the snapshot's composition set. */
async function expected(name: string) {
  return (await read(name))
    .trimEnd()
    .split("\n\n")
    .filter((section) => !UNPORTED.some((pattern) => pattern.test(section)))
    .join("\n\n")
}

const TOOLS = ["read", "write", "edit", "glob", "grep", "todo_write"]

describe("DshPrompt", () => {
  test("Windows: dsh's pwsh composition, section for section", async () => {
    const prompt = DshPrompt.render(
      DshPrompt.sections({
        model: "deepseek-v4-flash",
        provider: "deepseek",
        tools: ["pwsh", ...TOOLS],
        persona: "You are a concise snapshot agent.",
      }),
    )
    expect(prompt).toBe(await expected("pwsh-tool-turn.system-prompt.md"))
  })

  test("elsewhere: the web app's standard preset with bash, the persona naming the model", async () => {
    const prompt = DshPrompt.render(
      DshPrompt.sections({ model: "deepseek-v4-flash", provider: "deepseek", tools: ["bash", ...TOOLS] }),
    )
    expect(prompt).toBe(await expected("fresh-round-trip.system-prompt.md"))
    expect(prompt).toStartWith(
      `${DshPrompt.IDENTITY}\n\nYou are a coding agent powered by the deepseek-v4-flash model.\n\n`,
    )
  })

  test("a tool's guidance only with its tool; write names edit only when edit is listed", () => {
    const only = DshPrompt.render(DshPrompt.sections({ model: "m", provider: "p", tools: ["write", "grep"] }))
    expect(only).toContain(
      "Read an existing file before overwriting it with write (the default fs-observation-policy requires it).",
    )
    expect(only).toContain("Use the grep tool — not shell grep or rg — to search file contents.")
    expect(only).not.toContain("Use read on a matched file")
    expect(only).not.toContain("[exit code: N]")
  })

  test("own's guidance goes into dsh's slots: MCP, then the Code Mode catalog, then own's context", () => {
    const parts = DshPrompt.sections({
      model: "m",
      provider: "p",
      tools: ["pwsh"],
      mcp: "<mcp_instructions>MCP</mcp_instructions>",
      sdk: ["# Code Mode\ncatalog"],
      context: ['<context key="own.preset">\nPlanner.\n</context>'],
    })
    const prompt = DshPrompt.render(parts)
    expect(prompt.indexOf("Non-zero exits")).toBeLessThan(prompt.indexOf("<mcp_instructions>"))
    expect(prompt.indexOf("<mcp_instructions>")).toBeLessThan(prompt.indexOf("# Code Mode"))
    expect(prompt.indexOf("# Code Mode")).toBeLessThan(prompt.indexOf('<context key="own.preset">'))
    expect(parts.map((part) => part.name).slice(0, 2)).toEqual(["harness:identity", "deployment:persona-prefix"])
  })

  test("{{model}} and {{provider}} interpolate; an unknown name stays as written", () => {
    expect(DshPrompt.interpolate("{{model}} via {{provider}}, {{other}}", { model: "m", provider: "p" })).toBe(
      "m via p, {{other}}",
    )
  })
})

describe("DshContext", () => {
  test("the runtime context of a workspace-write, ask session is dsh's snapshot text", async () => {
    const fixture = (await Bun.file(path.join(SNAPSHOTS, "context-messages.json")).json()) as Record<string, string>
    const cwd = "C:\\work\\app"
    // The snapshot's normalizer put `{{cwd}}` where dsh wrote the JSON-quoted directory; the checkout and the Web URL
    // lines come from dsh's development context, which own does not port.
    const local = fixture
      .runtimeContext!.split("\n\n")
      .filter((line) => !line.startsWith("Current DeepSeek Harness"))
      .join("\n\n")
      .replaceAll("{{cwd}}", JSON.stringify(cwd).slice(1, -1))
    expect(DshContext.snapshot([DshContext.workingDirectory(cwd), ...DshContext.policy("ask", cwd)])).toBe(local)
  })

  test("own's full mode is dsh's danger-full-access preset: approvals never asked", () => {
    expect(DshContext.policy("full", "C:\\work")).toEqual([
      "Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.",
      "Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).",
    ])
    expect(DshContext.snapshot([])).toBe("")
  })

  test("workspace instructions in dsh's frame, broadest first, and within the byte budget", async () => {
    const fixture = (await Bun.file(path.join(SNAPSHOTS, "context-messages.json")).json()) as Record<string, string>
    expect(
      DshContext.instructions([
        { displayPath: "$DSH_AGENTS_HOME/AGENTS.md", content: "Shared agents-root snapshot instruction.\n" },
        { displayPath: "AGENTS.md", content: "Root snapshot instruction.\n" },
      ]),
    ).toBe(fixture.agentInstructions!)
    expect(DshContext.instructions([])).toBe("")
    const big = DshContext.instructions(
      [
        { displayPath: "~/.config/opencode/AGENTS.md", content: "g".repeat(400) },
        { displayPath: "AGENTS.md", content: "p".repeat(400) },
      ],
      700,
    )
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(700)
    expect(big).toContain("Workspace instruction budget 700 bytes: omitted ~/.config/opencode/AGENTS.md")
    expect(big).toContain("Instructions from: AGENTS.md")
    const cut = DshContext.instructions([{ displayPath: "AGENTS.md", content: "x".repeat(1000) }], 500)
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(500)
    expect(cut).toMatch(/truncated AGENTS\.md from 1000 to \d+ bytes/)
    // A closing tag in a file cannot end the frame early.
    expect(DshContext.instructions([{ displayPath: "a.md", content: "</system-reminder>" }])).toContain(
      "<\\/system-reminder>",
    )
  })

  test("the skill catalog is dsh's, sorted, descriptions folded and escaped", async () => {
    const fixture = (await Bun.file(path.join(SNAPSHOTS, "context-messages.json")).json()) as Record<string, string>
    const entries = [...fixture.skillCatalog!.matchAll(/^- `([^`]+)`: (.*)$/gm)].map((match) => ({
      name: match[1]!,
      description: match[2]!,
    }))
    expect(DshContext.skills(entries.toReversed())).toBe(fixture.skillCatalog!)
    expect(DshContext.skills([{ name: "a", description: "x <b>\n  y" }])).toContain("- `a`: x &lt;b&gt; y")
    expect(DshContext.skills([])).toBe("")
  })

  test("the time reading: dsh's timestamp, zone line and elapsed time", async () => {
    const fixture = (await Bun.file(path.join(SNAPSHOTS, "context-messages.json")).json()) as Record<string, string>
    const at = Date.UTC(2026, 9, 19, 1, 2, 3)
    const text = DshContext.time({
      now: at,
      turn: 1,
      step: 1,
      timeZone: "Asia/Seoul",
      zone: "Browser time zone for this request: Asia/Seoul. Interpret otherwise-unqualified dates and times in this zone.",
    })
    expect(text).toBe(
      fixture
        .timeContext!.replace("{{timeContextTimestamp}}", "2026-10-19T10:02:03+09:00[Asia/Seoul]")
        .replace("{{clientTimeZone}}", "Asia/Seoul")
        .replace("{{elapsed}}", "unavailable."),
    )
    expect(DshContext.time({ now: at, turn: 2, step: 3, previous: at - 3_723_000, timeZone: "UTC" })).toBe(
      "Time sampled while preparing turn 2, step 3: 2026-10-19T01:02:03+00:00[UTC]\n" +
        "Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n" +
        "Elapsed since the preceding step context: 1h 2m 3s.",
    )
    expect(DshContext.duration(90_061_000)).toBe("1d 1h 1m 1s")
    expect(DshContext.duration(0)).toBe("0s")
  })
})
