// The Codex model metadata store and its helpers (07 §4.5, Appendix A). The rows are fixtures shaped like the Codex
// backend's list and the Codex CLI's `models_cache.json`, with Appendix A's values; nothing reads a real `.codex`.

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { CODEX_RETIRED_SLUGS, CODEX_SLUGS } from "../src/codex-slugs.js"
import { CodexModels } from "../src/index.js"
import { roundTrip } from "./fixtures.js"

const LEVELS = ["low", "medium", "high", "xhigh", "max"]
const levels = (list: ReadonlyArray<string>) => list.map((effort) => ({ effort, description: `${effort} effort` }))

/** A backend row: Appendix A's fields plus some Codex keeps for itself (never stored). */
function row(slug: string, input: Record<string, unknown>) {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: "fixture",
    visibility: "list",
    base_instructions: "You are Codex. (fixture text that is never stored)",
    supported_in_api: true,
    context_window: 272_000,
    ...input,
  }
}

/** Appendix A, the newer bundle (11 models in Codex; the eight own uses). */
const BUNDLE = [
  row("gpt-6.1-sol", {
    priority: 1,
    default_reasoning_level: "low",
    multi_agent_reasoning_effort: "xhigh",
    supported_reasoning_levels: levels([...LEVELS, "ultra"]),
    max_context_window: 872_000,
    supports_reasoning_effort_updates: true,
    upgrade: null,
  }),
  row("gpt-6-astra", {
    priority: 2,
    default_reasoning_level: "low",
    multi_agent_reasoning_effort: "xhigh",
    supported_reasoning_levels: levels([...LEVELS, "ultra"]),
    max_context_window: 872_000,
    supports_reasoning_effort_updates: true,
  }),
  row("gpt-6-sol", {
    priority: 3,
    default_reasoning_level: "medium",
    supported_reasoning_levels: levels([...LEVELS, "ultra"]),
    max_context_window: 872_000,
  }),
  row("gpt-6-luna", {
    priority: 4,
    default_reasoning_level: "medium",
    supported_reasoning_levels: levels(LEVELS),
    max_context_window: 872_000,
  }),
  row("gpt-5.6-sol", {
    priority: 5,
    default_reasoning_level: "low",
    multi_agent_reasoning_effort: null,
    supported_reasoning_levels: levels([...LEVELS, "ultra"]),
    max_context_window: 872_000,
    supports_reasoning_effort_updates: false,
    upgrade: { model: "gpt-6-sol", retirement_at: null, migration_markdown: "fixture" },
  }),
  row("gpt-5.6-terra", {
    priority: 8,
    default_reasoning_level: "medium",
    supported_reasoning_levels: levels([...LEVELS, "ultra"]),
    max_context_window: 872_000,
    supports_reasoning_effort_updates: false,
    upgrade: { model: "gpt-6-sol", retirement_at: null },
  }),
  row("gpt-5.6-luna", {
    priority: 9,
    default_reasoning_level: "medium",
    supported_reasoning_levels: levels(LEVELS),
    max_context_window: 872_000,
    supports_reasoning_effort_updates: false,
    upgrade: { model: "gpt-6-luna", retirement_at: "2026-10-14T00:00:00Z" },
  }),
  row("gpt-5.5", {
    priority: 13,
    default_reasoning_level: "medium",
    supported_reasoning_levels: levels(["low", "medium", "high", "xhigh"]),
    max_context_window: 272_000,
    supports_reasoning_effort_updates: false,
    upgrade: { model: "gpt-6-sol" },
  }),
]

/** Rows of another shape: no slug, a priority as text, levels that are not a list, a negative window, not a row. */
const MALFORMED = [
  { priority: 1 },
  row("bad-priority", { priority: "first" }),
  row("bad-levels", { supported_reasoning_levels: "low,high" }),
  row("bad-window", { max_context_window: -1 }),
  "gpt-6-sol",
]

/** `models_cache.json` of the Codex CLI 0.157.0 (Appendix A, the cache column), shortened. */
const CACHE = {
  fetched_at: "2026-09-25T08:30:00Z",
  etag: 'W/"fixture-etag"',
  client_version: "0.157.0",
  models: [
    row("gpt-6-astra", {
      priority: 1,
      default_reasoning_level: "medium",
      multi_agent_reasoning_effort: "xhigh",
      supported_reasoning_levels: levels([...LEVELS, "ultra"]),
      max_context_window: 872_000,
      supports_reasoning_effort_updates: true,
    }),
    row("gpt-6-sol", { priority: 2, default_reasoning_level: "medium", supports_reasoning_effort_updates: true }),
    row("gpt-5.5", { priority: 12, default_reasoning_level: "medium", max_context_window: 272_000 }),
    ...MALFORMED,
  ],
}

const decoded = CodexModels.decode({ models: [...BUNDLE, ...MALFORMED] })
const bundle = decoded?.models ?? []
const meta = (slug: string) => {
  const found = CodexModels.find({ models: bundle }, slug)
  if (!found) throw new Error(`fixture row ${slug} missing`)
  return found
}

describe("decoding (07 §4.5)", () => {
  test("a backend list: every good row in order, malformed rows left out one by one", () => {
    expect(decoded?.rejected).toBe(MALFORMED.length)
    expect(bundle.map((model) => model.slug)).toEqual(BUNDLE.map((model) => model.slug))
  })

  test("rows keep Codex's field names and only the fields own uses", () => {
    expect(meta("gpt-6-astra")).toEqual({
      slug: "gpt-6-astra",
      context_window: 272_000,
      max_context_window: 872_000,
      default_reasoning_level: "low",
      supported_reasoning_levels: levels([...LEVELS, "ultra"]).map((level) => ({ effort: level.effort })),
      multi_agent_reasoning_effort: "xhigh",
      supports_reasoning_effort_updates: true,
      priority: 2,
      // T4: Codex's description is frozen into a model pool card (07 §3.3).
      description: "fixture",
    })
    expect(meta("gpt-5.6-sol").upgrade).toEqual({ model: "gpt-6-sol", retirement_at: null })
    expect(Object.keys(meta("gpt-6-sol"))).not.toContain("base_instructions")
  })

  test("CA: a row naming a tool or request value own's Codex harness does not handle is left out and counted", () => {
    // Each names a value Codex rust-v0.165.0 (own's harness port) has no handling for in own. The slugs extend one of
    // the bundled catalog's, so only the value leaves them out.
    const newer = [
      row("gpt-6.1-terra-patch", { apply_patch_tool_type: "function" }),
      row("gpt-6.1-terra-shell", { shell_type: "pty_v2" }),
      row("gpt-6.1-terra-truncation", { truncation_policy: { mode: "lines", limit: 200 } }),
      row("gpt-6.1-terra-truncation-shape", { truncation_policy: "tokens" }),
      row("gpt-6.1-terra-tools", { tool_mode: "code_mode" }),
      row("gpt-6.1-terra-agents", { multi_agent_version: "v3" }),
      row("gpt-6.1-terra-search", { web_search_tool_type: "video" }),
      row("gpt-6.1-terra-summary", { default_reasoning_summary: "verbose" }),
      row("gpt-6.1-terra-verbosity", { default_verbosity: "max" }),
    ]
    // Every judged field at a value own handles, plus what is never judged: a newer minimal_client_version, an
    // experimental tool own lacks, another input modality and a field own has never seen.
    const known = row("gpt-6.1-terra-next", {
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      tool_mode: "code_mode_only",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      web_search_tool_type: "text_and_image",
      multi_agent_version: "v2",
      default_reasoning_summary: "none",
      default_verbosity: "low",
      minimal_client_version: "0.165.0",
      experimental_supported_tools: ["a-tool-own-lacks"],
      input_modalities: ["text", "image", "audio"],
      a_field_own_never_saw: { on: true },
    })
    const older = row("gpt-5.5-old", {
      shell_type: "local",
      apply_patch_tool_type: null,
      tool_mode: null,
      truncation_policy: { mode: "bytes", limit: 10_000 },
      multi_agent_version: null,
      default_verbosity: null,
    })
    const decoded = CodexModels.decode({ models: [known, ...newer, older] })
    expect(decoded?.models.map((model) => model.slug)).toEqual(["gpt-6.1-terra-next", "gpt-5.5-old"])
    expect(decoded?.rejected).toBe(newer.length)
    // Each left-out row names its field and value, for the card.
    expect(decoded?.left).toEqual([
      { slug: "gpt-6.1-terra-patch", field: "apply_patch_tool_type", value: '"function"' },
      { slug: "gpt-6.1-terra-shell", field: "shell_type", value: '"pty_v2"' },
      { slug: "gpt-6.1-terra-truncation", field: "truncation_policy.mode", value: '"lines"' },
      { slug: "gpt-6.1-terra-truncation-shape", field: "truncation_policy", value: '"tokens"' },
      { slug: "gpt-6.1-terra-tools", field: "tool_mode", value: '"code_mode"' },
      { slug: "gpt-6.1-terra-agents", field: "multi_agent_version", value: '"v3"' },
      { slug: "gpt-6.1-terra-search", field: "web_search_tool_type", value: '"video"' },
      { slug: "gpt-6.1-terra-summary", field: "default_reasoning_summary", value: '"verbose"' },
      { slug: "gpt-6.1-terra-verbosity", field: "default_verbosity", value: '"max"' },
    ])
    // Only own's fields are kept, as before.
    expect(Object.keys(decoded?.models[0] ?? {})).not.toContain("shell_type")
  })

  test("a row of a model the bundled Codex catalog does not know, without what the harness needs, is left out and counted", () => {
    // The harness looks models up by the longest catalog slug they start with (Codex's models-manager), so a Codex
    // variant of a catalog model is known; a model of a newer Codex is not, whatever its values.
    expect(CODEX_SLUGS).toContain("gpt-6.1-terra")
    const fields = {
      shell_type: "shell_command",
      apply_patch_tool_type: "freeform",
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      max_context_window: 872_000,
    }
    const decoded = CodexModels.decode({
      models: [
        row("gpt-6.1-terra", fields),
        row("gpt-6.1-terra-fast", fields),
        row("gpt-6.9-sol", fields),
        row("gpt-7", fields),
        row("gpt-7-reserve", { ...fields, visibility: "hide" }),
      ],
    })
    expect(decoded?.models.map((model) => model.slug)).toEqual(["gpt-6.1-terra", "gpt-6.1-terra-fast"])
    expect(decoded?.rejected).toBe(2)
    expect(CodexModels.ROWS).toBe(5)
    // Without a truncation policy the harness cannot run them from their rows: left out with that field.
    expect(decoded?.left.map((left) => [left.slug, left.field])).toEqual([
      ["gpt-6.9-sol", "truncation_policy"],
      ["gpt-7", "truncation_policy"],
    ])
    // Token sharing's catalog entries are not judged by the Codex catalog: their tiers read alone.
    expect(CodexModels.entryTiers({ slug: "gpt-7", additional_speed_tiers: ["fast"] })).toEqual([
      { id: "priority", name: "Fast" },
    ])
    expect(CodexModels.entryTiers({ slug: "gpt-7" })).toBeUndefined()
  })

  test("rows of models older than the pin stay whole and are not counted: an earlier catalog's, or with an upgrade hint", () => {
    // The backend and models_cache.json still list retired models (gpt-5.4 left Codex's catalog before 0.165.0).
    // Their upgrade hint is preset repair's first successor source, and their retirement date, window, priority and
    // tiers are read as before (07 §4.3); only a model of a newer Codex waits for the next sync.
    expect(CODEX_SLUGS).not.toContain("gpt-5.4")
    expect(CODEX_RETIRED_SLUGS).toContain("gpt-5.4")
    const decoded = CodexModels.decode({
      models: [
        row("gpt-5.4", {
          upgrade: { model: "gpt-6-sol", retirement_at: "2026-12-01T00:00:00Z" },
          max_context_window: 272_000,
          priority: 9,
          service_tiers: [{ id: "priority", name: "Fast" }],
        }),
        // An earlier catalog's model without a hint, and a model no bundled catalog had that Codex points onward.
        row("gpt-5.2", {}),
        row("gpt-4.9-internal", { upgrade: { model: "gpt-5.5", retirement_at: null } }),
        row("gpt-6.9-sol", {}),
        row("gpt-6-luna", {}),
      ],
    })
    expect(decoded?.models.map((model) => model.slug)).toEqual(["gpt-5.4", "gpt-5.2", "gpt-4.9-internal", "gpt-6-luna"])
    expect(decoded?.rejected).toBe(1)
    const old = CodexModels.find(decoded, "gpt-5.4")!
    expect(CodexModels.upgrade(old)).toEqual({ model: "gpt-6-sol", retirementAt: Date.parse("2026-12-01T00:00:00Z") })
    expect(CodexModels.maxInput(old)).toBe(272_000)
    expect(CodexModels.priority(old)).toBe(9)
    expect(CodexModels.tiers(old)).toEqual([{ id: "priority", name: "Fast" }])
    // A retired slug is matched whole: a newer model that merely starts with one is still unknown.
    expect(CodexModels.decode({ models: [row("gpt-5.4-next", {})] })?.rejected).toBe(1)
  })

  test("CA: rows Codex hides are left out of the count, whatever they hold", () => {
    const decoded = CodexModels.decode({
      models: [
        row("gpt-reserve", { visibility: "hide", shell_type: "pty_v2" }),
        row("gpt-hidden", { visibility: "none", priority: "first" }),
        row("codex-auto-review", { visibility: "hide" }),
        row("gpt-7-listed", { visibility: "list", apply_patch_tool_type: "function" }),
      ],
    })
    expect(decoded?.models.map((model) => model.slug)).toEqual(["codex-auto-review"])
    expect(decoded?.rejected).toBe(1)
  })

  test("a body without a models list is no list at all; an empty list is one", () => {
    expect(CodexModels.decode({ data: [] })).toBeUndefined()
    expect(CodexModels.decode({ models: "none" })).toBeUndefined()
    expect(CodexModels.decode(null)).toBeUndefined()
    expect(CodexModels.decode({ models: [] })).toEqual({ models: [], rejected: 0, left: [], harness: [] })
  })

  test("models_cache.json: a pc-cache snapshot with its time, etag and client version", () => {
    const snapshot = CodexModels.fromCache(JSON.stringify(CACHE), 1)
    expect(snapshot).toMatchObject({
      source: "pc-cache",
      fetchedAt: Date.parse("2026-09-25T08:30:00Z"),
      etag: 'W/"fixture-etag"',
      clientVersion: "0.157.0",
    })
    expect(snapshot?.models.map((model) => [model.slug, model.priority])).toEqual([
      ["gpt-6-astra", 1],
      ["gpt-6-sol", 2],
      ["gpt-5.5", 12],
    ])
  })

  test("models_cache.json without a readable time takes the file's own; other text is no snapshot", () => {
    const { fetched_at: _time, etag: _etag, client_version: _version, ...bare } = CACHE
    expect(CodexModels.fromCache(JSON.stringify(bare), 1_790_000_000_000)).toEqual({
      source: "pc-cache",
      fetchedAt: 1_790_000_000_000,
      models: expect.any(Array),
    })
    expect(CodexModels.fromCache(JSON.stringify({ ...CACHE, fetched_at: "yesterday" }), 5)?.fetchedAt).toBe(5)
    expect(CodexModels.fromCache("{ not json", 1)).toBeUndefined()
    expect(CodexModels.fromCache(JSON.stringify({ fetched_at: "2026-09-25T08:30:00Z" }), 1)).toBeUndefined()
  })
})

/** A served row the harness can run: what a GPT-6.2 row of the live list carries (10 §6.14), with fixture texts. */
function served(slug: string, input: Record<string, unknown> = {}) {
  return row(slug, {
    priority: 1,
    default_reasoning_level: "low",
    supported_reasoning_levels: levels([...LEVELS, "ultra"]),
    service_tiers: [{ id: "priority", name: "Fast", description: "fixture" }],
    max_context_window: 872_000,
    shell_type: "shell_command",
    apply_patch_tool_type: "freeform",
    tool_mode: "code_mode_only",
    use_responses_lite: true,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    web_search_tool_type: "text_and_image",
    multi_agent_version: "v2",
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    supports_reasoning_effort_updates: true,
    supports_reasoning_summary_parameter: true,
    input_modalities: ["text", "image"],
    experimental_supported_tools: ["request_user_input_async", "send_message_to_user_async", "clock", "a-future-tool"],
    include_skills_usage_instructions: false,
    include_apps_usage_instructions: true,
    include_plugin_usage_instructions: true,
    guardian: null,
    model_messages: {
      instructions_template: "You are Codex. (fixture template)",
      instructions_variables: null,
      collaboration_modes: { default: "fixture mode" },
      multi_agent: { role: { root: "fixture root" } },
      approvals: { on_request: null, on_request_auto_review: "fixture review", never: null },
      token_budget: { enabled: true },
      tools: null,
      apps: null,
    },
    ...input,
  })
}

describe("runtime acceptance (07 §4.5, 10 §6.14)", () => {
  test("a model the bundled catalog does not know runs from its served row: kept, not counted, its harness row taken", () => {
    const decoded = CodexModels.decode({ models: [served("gpt-6.9-nova"), served("gpt-6.1-terra")] })
    expect(decoded?.models.map((model) => model.slug)).toEqual(["gpt-6.9-nova", "gpt-6.1-terra"])
    expect(decoded?.rejected).toBe(0)
    expect(decoded?.left).toEqual([])
    // A bundled model's served row is taken too (Codex on a ChatGPT login runs from the served rows only).
    expect(decoded?.harness.map((model) => model.slug)).toEqual(["gpt-6.9-nova", "gpt-6.1-terra"])
    const nova = decoded!.harness[0]!
    expect(nova.model_messages).toEqual({
      instructions_template: "You are Codex. (fixture template)",
      collaboration_modes: { default: "fixture mode" },
      multi_agent: { role: { root: "fixture root" } },
    })
    expect(nova.experimental_supported_tools).toEqual([
      "request_user_input_async",
      "send_message_to_user_async",
      "clock",
      "a-future-tool",
    ])
    expect(nova.truncation_policy).toEqual({ mode: "tokens", limit: 10_000 })
    expect(Object.keys(nova)).not.toContain("include_apps_usage_instructions")
    expect(roundTrip(CodexModels.HarnessRow, nova)).toEqual(nova)
  })

  test("the legacy top-level base_instructions fills a missing template, as Codex promotes it", () => {
    const legacy = served("gpt-6.9-nova", { model_messages: { collaboration_modes: null } })
    const decoded = CodexModels.decode({ models: [legacy] })
    expect(decoded?.harness[0]?.model_messages.instructions_template).toBe(
      "You are Codex. (fixture text that is never stored)",
    )
  })

  test("a new model without instructions borrows the nearest bundled model's, and says so", () => {
    const bare = served("gpt-6.9-sol", { base_instructions: undefined, model_messages: {} })
    const decoded = CodexModels.decode({ models: [bare] })
    expect(decoded?.harness.map((model) => model.slug)).toEqual(["gpt-6.9-sol"])
    expect(CodexModels.borrowed(decoded!.harness)).toEqual([{ slug: "gpt-6.9-sol", from: CodexModels.nearest("gpt-6.9-sol") }])
    expect(CodexModels.nearest("gpt-6.9-sol")).toBe(CODEX_SLUGS.find((slug) => slug.endsWith("-sol"))!)
    expect(CodexModels.nearest("gpt-6.9-astra")).toBe(CODEX_SLUGS.find((slug) => slug.endsWith("-astra"))!)
    expect(CodexModels.nearest("gpt-7")).toBe(CODEX_SLUGS[0]!)
    expect(CodexModels.nearest("codex-next")).toBe(CODEX_SLUGS[0]!)
    // A bundled model's served row without instructions keeps the bundled entry instead.
    expect(CodexModels.decode({ models: [served("gpt-6.1-terra", { base_instructions: undefined, model_messages: {} })] })?.harness).toEqual([])
  })

  test("a value the harness cannot reproduce: a new model is left out with that field, a bundled one keeps its entry", () => {
    const gaps: ReadonlyArray<readonly [Record<string, unknown>, string, string]> = [
      [{ truncation_policy: undefined }, "truncation_policy", ""],
      [{ include_skills_usage_instructions: true }, "include_skills_usage_instructions", "true"],
      [{ multi_agent_tools_in_code_mode: true }, "multi_agent_tools_in_code_mode", "true"],
      [{ web_search_provider: "search_mcp" }, "web_search_provider", '"search_mcp"'],
      [{ guardian: { policy: "x" } }, "guardian", '{"policy":"x"}'],
      [
        { supports_reasoning_summary_parameter: false, default_reasoning_summary: "auto" },
        "supports_reasoning_summary_parameter",
        "false",
      ],
      [{ input_modalities: ["text"] }, "input_modalities", '["text"]'],
      [{ input_modalities: ["text", "image", "audio"] }, "input_modalities", '["text","image","audio"]'],
      [{ model_messages: { instructions_template: "x", tools: { exec: "y" } } }, "model_messages.tools", '{"exec":"y"}'],
      [{ model_messages: { instructions_template: "x", permissions: { read_only: "y" } } }, "model_messages.permissions", '{"read_only":"y"}'],
      [{ model_messages: { instructions_template: "x", approvals: { never: "y" } } }, "model_messages.approvals.never", '"y"'],
    ]
    for (const [input, field, value] of gaps) {
      const decoded = CodexModels.decode({ models: [served("gpt-6.9-nova", input), served("gpt-6.1-terra", input)] })
      expect(decoded?.left).toEqual([{ slug: "gpt-6.9-nova", field, value }])
      expect(decoded?.models.map((model) => model.slug)).toEqual(["gpt-6.1-terra"])
      expect(decoded?.harness).toEqual([])
    }
    // A summary of `none` needs no summary parameter; a long value is cut for the card.
    expect(
      CodexModels.decode({
        models: [served("gpt-6.9-nova", { supports_reasoning_summary_parameter: false, default_reasoning_summary: "none" })],
      })?.harness,
    ).toHaveLength(1)
    const long = CodexModels.decode({ models: [served("gpt-6.9-nova", { web_search_provider: "x".repeat(200) })] })
    expect(long?.left[0]?.value).toHaveLength(80)
  })

  test("a hidden new model is taken when runnable and never counted when not", () => {
    const decoded = CodexModels.decode({
      models: [served("gpt-reserve-next", { visibility: "hide" }), served("gpt-hidden-next", { visibility: "hide", guardian: {} })],
    })
    expect(decoded?.harness.map((model) => model.slug)).toEqual(["gpt-reserve-next"])
    expect(decoded?.rejected).toBe(0)
    expect(decoded?.left).toEqual([])
  })
})

describe("the store file (OWN_HOME/codex-meta.json)", () => {
  const file = {
    version: 1,
    kinds: {
      codex: {
        source: "backend",
        fetchedAt: 1_790_000_000_000,
        etag: 'W/"fixture-etag"',
        clientVersion: "0.157.0",
        models: bundle,
      },
    },
  }

  test("round-trips one snapshot per kind; an empty store has none", () => {
    expect(roundTrip(CodexModels.File, file)).toEqual(file)
    expect(roundTrip(CodexModels.File, CodexModels.empty())).toEqual({ version: 1, kinds: {} })
    const { etag: _etag, clientVersion: _version, ...plain } = file.kinds.codex
    expect(roundTrip(CodexModels.Snapshot, { ...plain, source: "pc-cache" })).toEqual({ ...plain, source: "pc-cache" })
  })

  test("T4: a row keeps Codex's description; ROWS marks snapshots stored with it; older files still decode", () => {
    expect(CodexModels.ROWS).toBe(5)
    const described = CodexModels.decode({ models: [{ slug: "gpt-5.5", description: "Fast and affordable." }] })
    expect(described?.models[0]?.description).toBe("Fast and affordable.")
    expect(CodexModels.decode({ models: [{ slug: "gpt-5.5", description: null }] })?.models[0]?.description).toBeNull()
    // A file written before T4: no rows marker, no descriptions.
    const older = Schema.decodeUnknownSync(CodexModels.File)(file)
    expect(older.kinds.codex?.rows).toBeUndefined()
    const marked = { ...file, kinds: { codex: { ...file.kinds.codex, rows: CodexModels.ROWS } } }
    expect(roundTrip(CodexModels.File, marked)).toEqual(marked)
  })

  test("CA: the registry's newest release, the setting and each snapshot's left-out rows are kept", () => {
    const stored = {
      ...file,
      kinds: { codex: { ...file.kinds.codex, rows: CodexModels.ROWS, rejected: 2 } },
      latest: { version: "0.165.0", fetchedAt: 1_790_000_000_000 },
      autoVersion: false,
    }
    expect(roundTrip(CodexModels.File, stored)).toEqual(stored)
    const decode = Schema.decodeUnknownSync(CodexModels.File)
    // A file written before them has none: the setting reads as on.
    expect(decode(file).latest).toBeUndefined()
    expect(decode(file).autoVersion).toBeUndefined()
    // Only `major.minor.patch`: Codex asks without a pre-release part.
    for (const version of ["0.165", "v0.165.0", "0.165.0-alpha.1", "", "0.165.0.1", "1234567890.0.0"])
      expect(() => decode({ ...file, latest: { version, fetchedAt: 1 } })).toThrow()
    expect(() => decode({ ...file, kinds: { codex: { ...file.kinds.codex, rejected: -1 } } })).toThrow()
  })

  test("CA: the view of codexModels.get", () => {
    const view = {
      autoVersion: true,
      version: "0.165.0",
      build: "0.164.0",
      latest: { version: "0.165.0", fetchedAt: 1_790_000_000_000 },
      fetchedAt: 1_790_000_000_500,
      rejected: 1,
      accounts: { acc_chatgpt01: 1 },
    }
    expect(roundTrip(CodexModels.View, view)).toEqual(view)
    const { latest: _latest, fetchedAt: _fetchedAt, ...first } = view
    expect(roundTrip(CodexModels.View, { ...first, rejected: 0, accounts: {} })).toEqual({
      ...first,
      rejected: 0,
      accounts: {},
    })
    expect(roundTrip(CodexModels.SetInput, { autoVersion: false })).toEqual({ autoVersion: false })
  })

  test("codex only: a siwc snapshot is never kept; unknown versions and sources are refused", () => {
    const decode = Schema.decodeUnknownSync(CodexModels.File)
    expect(decode({ version: 1, kinds: { siwc: file.kinds.codex } }).kinds).toEqual({})
    expect(() => decode({ ...file, version: 2 })).toThrow()
    expect(() => decode({ version: 1, kinds: { codex: { ...file.kinds.codex, source: "bundle" } } })).toThrow()
  })
})

describe("helpers", () => {
  test("maxInput: max_context_window only; Codex's default context_window is never a window (R8)", () => {
    expect(CodexModels.maxInput(meta("gpt-6.1-sol"))).toBe(872_000)
    expect(CodexModels.maxInput(meta("gpt-5.5"))).toBe(272_000)
    expect(CodexModels.maxInput({ slug: "x", context_window: 272_000, max_context_window: null })).toBeUndefined()
    expect(CodexModels.maxInput({ slug: "x", context_window: 272_000 })).toBeUndefined()
    expect(CodexModels.maxInput({ slug: "x" })).toBeUndefined()
  })

  test("levels: Codex's order, narrowed to what the model offers; without metadata the offered list", () => {
    expect(CodexModels.levels(meta("gpt-6-sol"))).toEqual([...LEVELS, "ultra"])
    expect(CodexModels.levels(meta("gpt-6-sol"), ["high", "low", "max", "minimal"])).toEqual(["low", "high", "max"])
    expect(CodexModels.levels(undefined, ["high", "low"])).toEqual(["high", "low"])
    expect(CodexModels.levels({ slug: "x" }, ["high", "low"])).toEqual(["high", "low"])
    expect(CodexModels.levels(undefined)).toEqual([])
  })

  test("ultraLevel (Appendix A): the multi-agent effort, else max, else the highest level; never ultra", () => {
    expect(BUNDLE.map((model) => [model.slug, CodexModels.ultraLevel(meta(model.slug))])).toEqual([
      ["gpt-6.1-sol", "xhigh"],
      ["gpt-6-astra", "xhigh"],
      ["gpt-6-sol", "max"],
      ["gpt-6-luna", "max"],
      ["gpt-5.6-sol", "max"],
      ["gpt-5.6-terra", "max"],
      ["gpt-5.6-luna", "max"],
      ["gpt-5.5", "xhigh"],
    ])
    const ultra = {
      slug: "x",
      multi_agent_reasoning_effort: "ultra",
      supported_reasoning_levels: levels(["low", "ultra"]),
    }
    expect(CodexModels.ultraLevel(ultra)).toBe("low")
    expect(CodexModels.ultraLevel({ slug: "x", multi_agent_reasoning_effort: "xhigh" })).toBeUndefined()
    // The registered model's variants narrow the list: a level the model does not offer is never picked.
    expect(CodexModels.ultraLevel(meta("gpt-6-astra"), ["low", "high", "max"])).toBe("max")
    expect(CodexModels.ultraLevel(meta("gpt-6-sol"), ["low", "medium"])).toBe("medium")
  })

  test("priority and the ChatGPT group's default hints", () => {
    expect(CodexModels.priority(meta("gpt-6.1-sol"))).toBe(1)
    expect(CodexModels.priority({ slug: "x", priority: null })).toBeUndefined()
    expect(
      CodexModels.hints([meta("gpt-6.1-sol"), { slug: "x", priority: null, default_reasoning_level: null }]),
    ).toEqual([{ slug: "gpt-6.1-sol", priority: 1, defaultEffort: "low" }, { slug: "x" }])
  })

  test("upgrade: the named successor and a readable retirement time", () => {
    expect(CodexModels.upgrade(meta("gpt-5.6-sol"))).toEqual({ model: "gpt-6-sol" })
    expect(CodexModels.upgrade(meta("gpt-5.5"))).toEqual({ model: "gpt-6-sol" })
    expect(CodexModels.upgrade(meta("gpt-5.6-luna"))).toEqual({
      model: "gpt-6-luna",
      retirementAt: Date.parse("2026-10-14T00:00:00Z"),
    })
    expect(CodexModels.upgrade({ slug: "x", upgrade: { model: "y", retirement_at: "soon" } })).toEqual({ model: "y" })
    expect(CodexModels.upgrade(meta("gpt-6-sol"))).toBeUndefined()
  })
})

describe("no hard-coded models (07 §3.5)", () => {
  test("codex-models.ts names no model id, window or price", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../src/codex-models.ts")).text()
    expect(source).not.toContain("gpt-")
    expect(source).not.toMatch(/\b(272|872)[_,]?000\b/)
  })
})
