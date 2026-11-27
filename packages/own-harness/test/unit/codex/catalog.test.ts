import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { CodexModels } from "@own/protocol"
import { Catalog } from "../../../src/codex/catalog.js"

const GOLDEN = path.join(import.meta.dir, "..", "..", "golden", "codex")

/**
 * The base instructions of a golden. Codex's Windows builds embed some assets (prompt.md, permission templates, the
 * apply_patch grammar) as checked out with CRLF; own sends the canonical LF bytes of the repository, so CRLF is folded.
 */
async function baseInstructions(scenario: string) {
  const golden = await Bun.file(path.join(GOLDEN, `${scenario}.json`)).json()
  return (golden.requests[0].body.input[0].content[0].text as string).replaceAll("\r\n", "\n")
}

describe("Catalog", () => {
  test("longest slug prefix, then one namespace segment, else fallback metadata", () => {
    expect(Catalog.lookup("gpt-6-sol-2026-09-01").slug).toBe("gpt-6-sol")
    expect(Catalog.lookup("gpt-6.1-sol").slug).toBe("gpt-6.1-sol")
    expect(Catalog.lookup("openai/gpt-5.5").slug).toBe("gpt-5.5")
    expect(Catalog.lookup("a/b/gpt-5.5").known).toBe(false)
    const unknown = Catalog.lookup("claude-opus-5-5")
    expect(unknown.known).toBe(false)
    expect(unknown.apply_patch_tool_type).toBeNull()
    expect(unknown.truncation_policy).toEqual({ mode: "bytes", limit: 10_000 })
  })

  test("base instructions equal what Codex 0.171.0 sends for gpt-5.5 and for a model outside the catalog", async () => {
    expect(Catalog.instructions(Catalog.lookup("gpt-5.5"))).toBe(await baseInstructions("exec-basic"))
    expect(Catalog.instructions(Catalog.lookup("own-unknown-model"))).toBe(await baseInstructions("exec-unknown-model"))
  })

  test("every bundled catalog row passes own-accounts' model list check (07 §4.5, CA)", async () => {
    // own-accounts leaves out Codex model list rows whose harness values this port does not handle
    // (`CodexModels.decode`). Its catalog is what this port runs: a codex-sync that brings a new shell, apply_patch,
    // tool mode, truncation, web search, agent, reasoning summary or verbosity value must teach both.
    const models = await Bun.file(path.join(import.meta.dir, "..", "..", "..", "codex-data", "models.json")).json()
    const decoded = CodexModels.decode(models)
    expect(decoded?.rejected).toBe(0)
    expect(decoded?.models.map((model) => model.slug)).toEqual(models.models.map((model: { slug: string }) => model.slug))
  })

  test("update_plan stripping keeps a Planning section without checklist text", () => {
    const text = "# A\n## Planning\nThink first.\n## B\nx\n"
    expect(Catalog.withoutUpdatePlan(text)).toBe(text)
    expect(
      Catalog.withoutUpdatePlan("## Planning\nYou have access to an `update_plan` tool.\n## B\n- Use the plan tool often\n  more\nend\n"),
    ).toBe("## B\nend\n")
    expect(Catalog.withoutUpdatePlan("Progress visibility:\nIf update_plan is available, use it.\n\nnext\n")).toBe("next\n")
  })
})

describe("the served catalog (10 §6.14)", () => {
  const golden = async (name: string) => Bun.file(path.join(GOLDEN, name)).json()
  afterEach(() => Catalog.serve("", []))

  test("a served row the bundled catalog lacks runs as Codex runs it: its instructions, its tools, its fields", async () => {
    const decoded = CodexModels.decode(await golden("runtime-row-catalog.json"))!
    expect(decoded.harness.map((row) => row.slug)).toEqual(["gpt-6.9-nova"])
    expect(Catalog.lookup("gpt-6.9-nova").known).toBe(false)
    Catalog.serve("r1", decoded.harness)
    const nova = Catalog.lookup("gpt-6.9-nova")
    expect(nova).toMatchObject({ slug: "gpt-6.9-nova", known: true, served: {}, tool_mode: "code_mode_only" })
    // Code Mode: the base instructions follow the `additional_tools` item.
    const capture = await golden("exec-runtime-row.json")
    expect(Catalog.instructions(nova)).toBe(capture.requests[0].body.input[1].content[0].text)
    // The same values the bundled gpt-6.2-sol row (its source) gives.
    const bundled = Catalog.lookup("gpt-6.2-sol")
    for (const field of [
      "use_responses_lite",
      "apply_patch_tool_type",
      "truncation_policy",
      "support_verbosity",
      "default_verbosity",
      "default_reasoning_summary",
      "default_reasoning_level",
      "supports_reasoning_effort_updates",
      "supports_image_detail_original",
      "input_modalities",
      "experimental_supported_tools",
      "multi_agent_version",
      "supports_search_tool",
      "web_search_tool_type",
    ] as const)
      expect([field, nova[field]]).toEqual([field, bundled[field]])
    expect(Catalog.revision()).toBe("r1")
  })

  test("a served row wins over the bundled entry of its model; a model it lacks keeps the bundled one", async () => {
    const decoded = CodexModels.decode(await golden("runtime-row-catalog.json"))!
    const row = { ...decoded.harness[0]!, slug: "gpt-6.1-sol", model_messages: { instructions_template: "served text" } }
    Catalog.serve("r2", [row])
    expect(Catalog.instructions(Catalog.lookup("gpt-6.1-sol-fast"))).toBe("served text")
    expect(Catalog.lookup("gpt-6.1-terra").served).toBeUndefined()
    expect(Catalog.lookup("gpt-5.5").slug).toBe("gpt-5.5")
  })

  test("a new model without instructions borrows the nearest bundled model's", async () => {
    const decoded = CodexModels.decode(await golden("runtime-row-catalog.json"))!
    const bare = { ...decoded.harness[0]!, slug: "gpt-6.9-sol", model_messages: {} }
    Catalog.serve("r3", [bare])
    const model = Catalog.lookup("gpt-6.9-sol")
    expect(model.served).toEqual({ borrowed: CodexModels.nearest("gpt-6.9-sol") })
    expect(Catalog.instructions(model)).toBe(Catalog.instructions(Catalog.lookup(CodexModels.nearest("gpt-6.9-sol"))))
  })

  test("spawn_agent lists the served models as Codex does (the runtime-row capture's paragraph)", async () => {
    expect(Catalog.spawnModels()).toBeUndefined()
    const decoded = CodexModels.decode(await golden("runtime-row-catalog.json"))!
    Catalog.serve("r4", decoded.harness)
    const capture = await golden("exec-runtime-row.json")
    const collaboration = capture.requests[0].body.input[0].tools.find(
      (namespace: { name: string }) => namespace.name === "collaboration",
    )
    const spawn = collaboration.tools.find((tool: { name: string }) => tool.name === "spawn_agent").description as string
    expect(spawn).toContain(`${Catalog.spawnModels()}
`)
    Catalog.serve("r5", decoded.harness.map((row) => ({ ...row, visibility: "hide" })))
    expect(Catalog.spawnModels()).toBe("No picker-visible model overrides are currently loaded.")
  })

  test("the experimental tool names the harness implements", () => {
    expect(Catalog.EXPERIMENTAL_TOOLS).toEqual([
      "clock",
      "request_user_input_async",
      "send_user_message_async",
      "send_message_to_user_async",
      "literature_search_query",
    ])
  })
})
