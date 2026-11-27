import { describe, expect, test } from "bun:test"
import path from "node:path"
import { PatchInvocation } from "../../../src/codex/apply-patch/invocation.js"
import { CodexAgentsV1 } from "../../../src/codex/agents/v1.js"
import { Catalog } from "../../../src/codex/catalog.js"
import { Fragments } from "../../../src/codex/fragments.js"
import { CodexVariant } from "../../../src/codex/variant.js"

describe("CodexVariant", () => {
  const fallback = Catalog.lookup("claude-sonnet-5-5")
  const opus = Catalog.lookup("claude-opus-5-5")

  test("the original variant, and Codex's own models under either variant, keep Codex's text", () => {
    expect(CodexVariant.instructions(fallback, "reference")).toBe(Catalog.instructions(fallback))
    expect(CodexVariant.instructions(fallback, undefined)).toBe(Catalog.instructions(fallback))
    expect(CodexVariant.instructions(opus, "reference")).toBe(Catalog.instructions(opus))
    const gpt = Catalog.lookup("gpt-6-astra")
    expect(CodexVariant.instructions(gpt, "own")).toBe(Catalog.instructions(gpt))
    expect(CodexVariant.revised(gpt, "own")).toBe(false)
  })

  test("every replacement finds its line in Codex's fallback prompt, so a Codex update cannot drop one silently", () => {
    const base = Catalog.instructions(fallback)
    CodexVariant.REPLACEMENTS.forEach(({ from }) => expect([from, base.split(from).length]).toEqual([from, 2]))
    const revised = CodexVariant.instructions(fallback, "own")
    CodexVariant.REPLACEMENTS.forEach(({ from, to }) => {
      expect(revised).not.toContain(from)
      if (to !== "") expect(revised).toContain(to)
    })
    expect(revised).not.toContain("Codex CLI is an open source project led by OpenAI")
    expect(revised).not.toContain("styled by the CLI")
    expect(revised.startsWith("You are a coding agent running in own,")).toBe(true)
    expect(CodexVariant.revised(fallback, "own")).toBe(true)
  })

  test("the revised fallback names own's approval modes and no Codex escalation or call form", () => {
    const revised = CodexVariant.instructions(fallback, "own")
    ;[
      "escalated",
      "Sandbox and approvals",
      "same tools, plans and approvals",
      "**never**",
      "**on-request**",
      '{"command":["apply_patch"',
    ].forEach((word) => expect([word, revised.includes(word)]).toEqual([word, false]))
    expect(revised).toContain("approval mode **full**, proactively run tests")
    expect(revised).toContain("approval mode **ask**, hold off on running tests")
    // No line treats `apply_patch` as a tool of its own (DeepSeek called one on 2026-10-16).
    expect(revised).toContain("There is no `apply_patch` tool")
    expect(revised).not.toContain("after calling `apply_patch`")
    expect(revised).not.toContain("Use the `apply_patch` tool")
  })

  test("the lean tier is Claude Code's: Opus 4.8 and later, Fable and Mythos, by model id", () => {
    const lean = [
      "claude-opus-4-8",
      "claude-opus-4-8-fast",
      "claude-opus-5",
      "claude-opus-5-fast",
      "claude-opus-5-5",
      "claude-opus-5-5-fast",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-5.5",
      "~anthropic/claude-opus-latest",
      "anthropic.claude-opus-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
      "anthropic/claude-fable-5.1",
      "~anthropic/claude-fable-latest",
      "claude-mythos-5-1",
      // Claude Code's aliases, the Claude Agent route's model ids (02 §8.10).
      "opus",
      "opus[1m]",
      "fable",
    ]
    const full = [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-3-opus-20240229",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "anthropic/claude-sonnet-4.6",
      "claude-haiku-4-5",
      "deepseek-v4-pro",
      "gpt-5.4",
      "sonnet",
      "sonnet[1m]",
      "haiku",
      "default",
    ]
    lean.forEach((id) => expect([id, CodexVariant.lean(Catalog.lookup(id), "own")]).toEqual([id, true]))
    full.forEach((id) => expect([id, CodexVariant.lean(Catalog.lookup(id), "own")]).toEqual([id, false]))
    expect(CodexVariant.lean(opus, "reference")).toBe(false)
    expect(CodexVariant.lean(Catalog.lookup("gpt-6-astra"), "own")).toBe(false)
  })

  test("the lean base text describes own's app and tools, not Codex's terminal and sandbox", () => {
    const text = CodexVariant.instructions(opus, "own")
    expect(text).toStartWith("You are a coding agent running in own, a coding app")
    expect(text.match(/^# .+$/gm)).toEqual([
      "# How own works",
      "# AGENTS.md",
      "# Working on code",
      "# Editing files",
      "# Communicating",
      "# Working on your own",
    ])
    expect(text.length).toBeLessThan(4_500)
    expect(text).not.toContain("\r")
    expect(text).not.toContain("{{")
    ;["Codex", "sandbox", "require_escalated", "update_plan", "ANSI", "terminal", "【F:", "cd <dir>"].forEach((word) =>
      expect([word, text.includes(word)]).toEqual([word, false]),
    )
  })

  test("the patch shape both revised texts give is one own intercepts, relative to `workdir` or not", () => {
    const shapes = (text: string) =>
      [...text.matchAll(/```\n(apply_patch <<'EOF'\n[\s\S]*?\nEOF)\n```/g)].map((match) => match[1]!)
    const leanText = CodexVariant.instructions(opus, "own")
    const fallbackText = CodexVariant.instructions(fallback, "own")
    // One grammar for both tiers: the lean text's `# Editing files` section, which the fallback's models also get.
    ;[leanText, fallbackText].forEach((text) => {
      expect(text.split(CodexVariant.PATCH).length).toBe(2)
      ;[
        "- `*** Add File: <path>`, then every line of the new file prefixed with `+`.",
        "- `*** Delete File: <path>`.",
        "optionally `*** Move to: <new path>`",
        "unchanged and removed lines must match the file",
        "set the call's `workdir`",
      ].forEach((line) => expect([line, text.includes(line)]).toEqual([line, true]))
    })
    expect(leanText).toContain("# Editing files\nEdit files with a patch:")
    const lean = shapes(leanText)
    expect(lean).toHaveLength(1)
    const added = lean[0]!.replace("<file sections>", "*** Add File: notes.txt\n+hello")
    expect(PatchInvocation.extractHeredocPatch(added)).toEqual({
      patch: "*** Begin Patch\n*** Add File: notes.txt\n+hello\n*** End Patch",
    })
    // The fallback's models also get Codex's worked example, in the same shape.
    const examples = shapes(fallbackText)
    expect(examples).toEqual([lean[0]!, examples[1]!])
    expect(PatchInvocation.extractHeredocPatch(examples[1]!)).toEqual({
      patch:
        "*** Begin Patch\n*** Update File: path/to/file.py\n@@ def example():\n- pass\n+ return 123\n*** End Patch",
    })
    // `workdir` is resolved before the patch (tools.ts `runExec`): a `cd` with a Windows path is not an invocation
    // own intercepts.
    expect(PatchInvocation.extractHeredocPatch(String.raw`cd C:\work\app\src && ` + added)).toBeUndefined()
  })

  test("own's permissions text for each approval mode, without Codex's escalation or a path", () => {
    const modes: ReadonlyArray<readonly [Fragments.Mode, boolean]> = [
      ["full", false],
      ["ask", true],
      ["ask", false],
      ["read-only", true],
      ["read-only", false],
    ]
    modes.forEach(([mode, reads]) => {
      const text = CodexVariant.permissions(mode, reads)
      expect(text).toStartWith(`<permissions instructions>\nApproval mode: ${mode}.`)
      // The same bytes in every folder, so other folders' sessions read the block from the prompt cache.
      expect(text).not.toMatch(/[A-Za-z]:\\|`\//)
      expect(text).toEndWith(
        "switches them with the mode button in the conversation header.\n</permissions instructions>",
      )
      // own-web's ko.ts and en.ts `own.approval.full|ask|readOnly`.
      expect(text).toContain(
        "`전체 허용` / Full access (full), `묻기` / Ask (ask) and `읽기 전용` / Read only (read-only)",
      )
      CodexVariant.ESCALATION_FIELDS.forEach((field) => expect(text).not.toContain(field))
      expect(text).not.toContain("escalat")
      expect(text).not.toContain("user's computer")
      // Access outside the working directory is not asked about in any mode (FT-Q1, 2026-10-17).
      expect(text).not.toContain("outside the working directory")
    })
    const ask = CodexVariant.permissions("ask", true)
    expect(ask).toContain("If the user declines without a note, your turn ends.")
    expect(ask).toContain("patches to a few protected files (credentials, own's settings) are always refused")
    const readOnly = CodexVariant.permissions("read-only", true)
    const reads = ["reading the files itself", "`Get-Content`", "`rg`", "`Select-String`", "protected files"]
    reads.forEach((part) => expect([part, readOnly.includes(part)]).toEqual([part, true]))
    // In ask mode the same reads run without a card (RO-D4, amended 2026-10-17); rules that serve none leave them out.
    expect(ask).toContain("Simple reads run without asking")
    reads.forEach((part) => expect([part, ask.includes(part)]).toEqual([part, true]))
    // `.env` reads still ask, and a read own refuses itself can be asked for with another command.
    expect(ask).toContain("reading a `.env` file still asks")
    expect(ask).toContain("a different command for the same need is asked about like any other")
    expect(readOnly).not.toContain("asked about like any other")
    const asking = CodexVariant.permissions("ask", false)
    expect(asking).not.toContain("reading the files itself")
    expect(asking).toContain("If the user declines without a note, your turn ends.")
    // Rules that deny shell without own's protected denies serve no reads (CodexReadOnly.serves).
    const refusing = CodexVariant.permissions("read-only", false)
    expect(refusing).toContain("`exec_command` calls fail with a permission error")
    expect(refusing).not.toContain("reading the files itself")
  })

  test("the reference variant's read-only text stays the bytes Codex 0.162.1 sent", async () => {
    const golden: { requests: Array<{ body: { input: Array<{ content: Array<{ text: string }> }> } }> } =
      await Bun.file(path.join(import.meta.dir, "..", "..", "golden", "codex", "exec-unknown-model.json")).json()
    const sent = golden.requests[0]!.body.input[1]!.content.find((part) => part.text.startsWith("<permissions"))
    // Line ends as golden.test.ts folds them: the capture's approval text ends in CRLF.
    const fold = (text: string) => text.replaceAll("\r\n", "\n")
    expect(fold(Fragments.permissions("read-only", "C:\\work"))).toBe(fold(sent!.text))
  })

  test("own's approval mode is read from the last `{shell, **}` rule", () => {
    const rule = (effect: "allow" | "ask" | "deny") => ({ action: "shell", resource: "**", effect })
    expect(Fragments.mode([{ action: "edit", resource: "**", effect: "allow" }, rule("allow")])).toBe("full")
    expect(Fragments.mode([rule("ask")])).toBe("ask")
    expect(Fragments.mode([rule("allow"), rule("deny"), { action: "read", resource: "/x/**", effect: "deny" }])).toBe(
      "read-only",
    )
    expect(Fragments.mode([{ action: "shell", resource: "git *", effect: "deny" }])).toBe("ask")
    expect(Fragments.mode(undefined)).toBe("ask")
  })

  test("spawn_agent: own's model rule in place of the Codex account's models, every replaced line found", () => {
    const codex = CodexAgentsV1.DEFINITION.tools.find((tool) => tool.name === "spawn_agent")!.description
    expect(codex.split(CodexVariant.SPAWN_AGENT_START).length).toBe(2)
    CodexVariant.SPAWN_AGENT_REPLACEMENTS.forEach(({ from }) =>
      expect([from, codex.split(from).length]).toEqual([from, 2]),
    )
    const own = CodexVariant.spawnAgent(codex, false)
    expect(own).toStartWith(CodexVariant.SPAWN_AGENT_START)
    CodexVariant.SPAWN_AGENT_REPLACEMENTS.forEach(({ to }) => expect(own).toContain(to))
    ;["gpt-", "Available model overrides", "forked workspace", "uploaded changes"].forEach((word) =>
      expect([word, own.includes(word)]).toEqual([word, false]),
    )
    // The model rule is said once: Codex's default-model sentences stay, own's provider rule follows them.
    expect(own.split("# Your Model").length).toBe(2)
    expect(own).toContain("### When to delegate vs. do the subtask yourself")
    expect(CodexVariant.spawnAgent(codex, true)).toBe(CodexVariant.SPAWN_AGENT_LEAN)
    expect(CodexVariant.SPAWN_AGENT_LEAN).not.toContain("gpt-")
    // The preset context permits delegating; its `subagent` roles, `background` and model pool are not spawn_agent's.
    ;[own, CodexVariant.SPAWN_AGENT_LEAN].forEach((text) => {
      expect(text).toContain("the delegation mode in the `own.preset` context")
      expect(text).toContain(
        "its roles, `agent`, `background`, effort levels and model names are not spawn_agent arguments.",
      )
      expect(text).toContain("only ever a model id of your")
    })
  })
})
