// Builds `codex-data/` from a Codex checkout (10 §3.1, §5): the model catalog fields the `codex` harness reads, the
// fallback prompt, the apply_patch grammar, the compaction, permission and collaboration-mode templates, with Codex's
// LICENSE and NOTICE (Apache-2.0). tools.<platform>.json comes from script/codex-golden.ts instead and is kept.
// It also writes the catalog's slugs to own-protocol (`src/codex-slugs.ts`), which CodexModels.decode checks Codex's
// model list against (own-protocol never imports own-harness), with the slugs earlier catalogs up to the pin had
// (read from the catalog file's git history), which are older models rather than ones own does not know yet.
// The output is generated: never edit it by hand. own/scripts/codex-sync.ts runs this after moving the pin.
// Files are read from git objects, not the working tree: a Windows checkout may have CRLF where Codex ships LF.
//
//   bun script/codex-data.ts <codex checkout> [revision, default HEAD]
import { mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

/** Catalog fields the harness reads; the rest (plans, NUX, service tiers) is ChatGPT product data. */
const MODEL_FIELDS = [
  "slug",
  "display_name",
  "tool_mode",
  "use_responses_lite",
  "apply_patch_tool_type",
  "shell_type",
  "web_search_tool_type",
  "supports_image_detail_original",
  "truncation_policy",
  "supports_parallel_tool_calls",
  "support_verbosity",
  "default_verbosity",
  "supports_reasoning_summaries",
  "default_reasoning_summary",
  "default_reasoning_level",
  "supports_reasoning_effort_updates",
  "context_window",
  "input_modalities",
  "experimental_supported_tools",
  "multi_agent_version",
  "include_skills_usage_instructions",
  "supports_search_tool",
  "web_search_tool_type",
  "supports_image_detail_original",
  "model_messages",
] as const

/** Codex path → file name in codex-data/. */
const COPIES = {
  "codex-rs/models-manager/prompt.md": "prompt.md",
  "codex-rs/core/assets/tools/apply_patch.lark": "apply_patch.lark",
  "codex-rs/prompts/templates/compact/prompt.md": "compact-prompt.md",
  "codex-rs/prompts/templates/compact/summary_prefix.md": "compact-summary-prefix.md",
  "codex-rs/prompts/templates/permissions/sandbox_mode/read_only.md": "permissions/sandbox-read-only.md",
  "codex-rs/prompts/templates/permissions/sandbox_mode/workspace_write.md": "permissions/sandbox-workspace-write.md",
  "codex-rs/prompts/templates/permissions/sandbox_mode/danger_full_access.md": "permissions/sandbox-danger-full-access.md",
  "codex-rs/prompts/templates/permissions/approval_policy/never.md": "permissions/approval-never.md",
  "codex-rs/prompts/templates/permissions/approval_policy/on_request.md": "permissions/approval-on-request.md",
  "codex-rs/prompts/templates/permissions/approval_policy/unless_trusted.md": "permissions/approval-unless-trusted.md",
  "codex-rs/collaboration-mode-templates/templates/default.md": "collaboration-default.md",
  "codex-rs/collaboration-mode-templates/templates/plan.md": "collaboration-plan.md",
  LICENSE: "LICENSE",
  NOTICE: "NOTICE",
}

const CATALOG = "codex-rs/models-manager/models.json"

const source = process.argv[2]
if (source === undefined) {
  console.error("usage: bun script/codex-data.ts <codex checkout> [revision]")
  process.exit(2)
}
const out = path.join(import.meta.dir, "..", "codex-data")
const commit = git(source, "rev-parse", `${process.argv[3] ?? "HEAD"}^{commit}`).toString().trim()
const date = git(source, "log", "-1", "--format=%cI", commit).toString().trim()
const read = (file: string) => git(source, "show", `${commit}:${file}`)

// Everything this script writes is replaced; the golden captures (tools.<platform>.json, code-mode.<platform>.json) stay.
await Promise.all(
  (await readdir(out).catch(() => []))
    .filter((name) => !/^(tools|code-mode)\..+\.json$/.test(name))
    .map((name) => rm(path.join(out, name), { recursive: true, force: true })),
)
await mkdir(path.join(out, "permissions"), { recursive: true })

const catalog: { models: Array<Record<string, unknown>> } = JSON.parse(read(CATALOG).toString())
const models = catalog.models.map((model) =>
  Object.fromEntries(MODEL_FIELDS.filter((field) => field in model).map((field) => [field, model[field]])),
)
await Bun.write(path.join(out, "models.json"), `${JSON.stringify({ models }, null, 2)}\n`)
const slugs = catalog.models.map((model) => String(model.slug))
// Every catalog Codex bundled up to the pin, through the file's renames (codex-rs/core/models.json before).
const retired = [
  ...new Set(
    git(source, "log", "--follow", "--name-only", "--format=@%H", commit, "--", CATALOG)
      .toString()
      .split("\n@")
      .flatMap((entry) => {
        const [sha, file] = entry.replace(/^@/, "").trim().split(/\s+/)
        if (sha === undefined || file === undefined) return []
        const older: { models?: Array<{ slug?: unknown }> } = JSON.parse(
          git(source, "show", `${sha}:${file}`).toString(),
        )
        return (older.models ?? []).map((model) => String(model.slug))
      }),
  ),
]
  .filter((slug) => !slugs.includes(slug))
  .toSorted()
await Bun.write(
  path.join(import.meta.dir, "..", "..", "own-protocol", "src", "codex-slugs.ts"),
  [
    "// Generated by packages/own-harness/script/codex-data.ts; never edit by hand.",
    `// Source: openai/codex ${commit.slice(0, 10)} (${date}).`,
    "",
    "/**",
    " * The slugs of the Codex model catalog own's `codex` harness bundles (codex-data/models.json): a Codex model list",
    " * row whose slug starts with one of them is a model the harness knows (CodexModels.decode).",
    " */",
    "export const CODEX_SLUGS: ReadonlyArray<string> = [",
    ...slugs.map((slug) => `  ${JSON.stringify(slug)},`),
    "]",
    "",
    "/**",
    " * The slugs Codex's bundled catalog had at an earlier commit up to the pin and no longer has: models older than the",
    " * pinned release, so a row of one is never a model own does not know yet (CodexModels.decode).",
    " */",
    "export const CODEX_RETIRED_SLUGS: ReadonlyArray<string> = [",
    ...retired.map((slug) => `  ${JSON.stringify(slug)},`),
    "]",
    "",
  ].join("\n"),
)

const files = Object.fromEntries(
  [CATALOG, ...Object.keys(COPIES)].map((file) => [file, new Bun.CryptoHasher("sha256").update(read(file)).digest("hex")]),
)
await Promise.all(Object.entries(COPIES).map(([from, to]) => Bun.write(path.join(out, to), read(from))))
await Bun.write(
  path.join(out, "source.json"),
  `${JSON.stringify({ repository: "https://github.com/openai/codex", license: "Apache-2.0", commit, date, files }, null, 2)}\n`,
)
console.log(`codex-data: ${models.length} models from ${commit.slice(0, 10)} (${date})`)

function git(cwd: string, ...args: Array<string>) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args])
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout
}
