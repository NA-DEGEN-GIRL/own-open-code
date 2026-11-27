// Records the Responses requests the installed Codex CLI sends (10 §4.1), as goldens for the `codex` harness. Codex runs
// with a throwaway CODEX_HOME and a fake API key against own-accounts' fake Responses server, so the user's ~/.codex
// (login, config, sessions) is never read or written and nothing leaves this PC. Each scenario scripts the model's
// replies; the tool calls Codex runs execute for real inside a temp workspace.
//
//   bun script/codex-golden.ts [scenario…]      → test/golden/codex/<scenario>.json, codex-data/tools.<platform>.json
//
// The Codex binary is OWN_CODEX_BIN, else the pinned release installed next to the reference clone
// (refs/codex-cli/<version>, own/ledger/codex-pin.json `cli`), else `codex` on PATH. Whichever it is must report the
// pinned version: a golden captured with another Codex would compare own against the wrong release.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startFakeOpenAIResponses, type Reply } from "../../own-accounts/test/e2e-kit"

interface Scenario {
  readonly model: string
  readonly prompt: string
  readonly files: Readonly<Record<string, string>>
  readonly replies: ReadonlyArray<Reply>
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access"
  /**
   * A model list Codex reads as its whole catalog (`model_catalog_json`, as a ChatGPT login reads the backend's
   * `/models`): the rows of test/golden/codex/<file>, so Codex runs a model its bundled catalog does not have.
   */
  readonly catalog?: string
}

/** A Code Mode scenario on `model`: one JS `exec` call that runs a nested shell tool, then an answer. */
const codeMode = (model: string, catalog?: string): Scenario => ({
  model,
  prompt: "Show me what is in hello.txt.",
  files: { "AGENTS.md": "Answer in one short sentence.\n", "hello.txt": "hello from the workspace\n" },
  replies: [
    {
      type: "tool-call",
      name: "exec",
      input: {},
      freeform: 'const result = await tools.exec_command({ cmd: "Get-Content hello.txt" });\ntext(result.output);',
    },
    { type: "text", text: "It says hello from the workspace." },
  ],
  sandbox: "danger-full-access",
  ...(catalog === undefined ? {} : { catalog }),
})

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  // One shell call and a final answer, in a project with AGENTS.md.
  "exec-basic": {
    model: "gpt-5.5",
    prompt: "Show me what is in hello.txt.",
    files: { "AGENTS.md": "Answer in one short sentence.\n", "hello.txt": "hello from the workspace\n" },
    replies: [
      { type: "tool-call", name: "exec_command", input: { cmd: "Get-Content hello.txt" } },
      { type: "text", text: "It says hello from the workspace." },
    ],
    sandbox: "danger-full-access",
  },
  // GPT-6 Code Mode Only with Responses Lite: one JS `exec` call that runs a nested shell tool, then an answer.
  "exec-gpt6": {
    model: "gpt-6.1-sol",
    prompt: "Show me what is in hello.txt.",
    files: { "AGENTS.md": "Answer in one short sentence.\n", "hello.txt": "hello from the workspace\n" },
    replies: [
      {
        type: "tool-call",
        name: "exec",
        input: {},
        freeform: 'const result = await tools.exec_command({ cmd: "Get-Content hello.txt" });\ntext(result.output);',
      },
      { type: "text", text: "It says hello from the workspace." },
    ],
    sandbox: "danger-full-access",
  },
  // The same Code Mode scenario on GPT-6.1 Terra (catalog since rust-v0.165.0): Terra's own base instructions and
  // collaboration text, and the first-window `configuration_update`.
  "exec-terra": {
    model: "gpt-6.1-terra",
    prompt: "Show me what is in hello.txt.",
    files: { "AGENTS.md": "Answer in one short sentence.\n", "hello.txt": "hello from the workspace\n" },
    replies: [
      {
        type: "tool-call",
        name: "exec",
        input: {},
        freeform: 'const result = await tools.exec_command({ cmd: "Get-Content hello.txt" });\ntext(result.output);',
      },
      { type: "text", text: "It says hello from the workspace." },
    ],
    sandbox: "danger-full-access",
  },
  // GPT-6.2 Sol (catalog since rust-v0.169.1): its own instructions and `send_message_to_user_async`.
  "exec-gpt62": codeMode("gpt-6.2-sol"),
  // A model no bundled catalog has, run from a served row (`model_catalog_json`, runtime-row-catalog.json): what Codex
  // sends for a model the backend lists before own's next sync (07 §4.5, 10 §6.14). own's harness takes the same row
  // from the account's model list and must send the same request.
  "exec-runtime-row": codeMode("gpt-6.9-nova", "runtime-row-catalog.json"),
  // A model outside the catalog: Codex's fallback prompt and tool surface.
  "exec-unknown-model": {
    model: "own-unknown-model",
    prompt: "Say hi.",
    files: {},
    replies: [{ type: "text", text: "hi" }],
    sandbox: "workspace-write",
  },
}

const OUT = path.join(import.meta.dir, "..", "test", "golden", "codex")
/** The scenario whose tool definitions become codex-data/tools.<platform>.json. */
const TOOLS_SCENARIO = "exec-basic"
/** The scenario whose Responses Lite tools and multi-agent texts become codex-data/code-mode.<platform>.json. */
const CODE_MODE_SCENARIO = "exec-gpt6"
const REPO = path.resolve(import.meta.dir, "..", "..", "..")
const pin: { cli?: string } = await Bun.file(path.join(REPO, "own", "ledger", "codex-pin.json")).json()
const CODEX = process.env.OWN_CODEX_BIN ?? pinned() ?? "codex"
const names = process.argv.slice(2)
const version = run([CODEX, "--version"], process.cwd()).stdout.trim()
if (pin.cli !== undefined && version.split(/\s+/).at(-1) !== pin.cli) {
  console.error(
    `codex-golden: ${CODEX} reports "${version}", not the pinned ${pin.cli} (own/ledger/codex-pin.json). ` +
      `Install it (bun own/scripts/codex-sync.ts --apply) or point OWN_CODEX_BIN at it.`,
  )
  process.exit(1)
}
fs.mkdirSync(OUT, { recursive: true })

for (const [name, scenario] of Object.entries(SCENARIOS).filter(([key]) => names.length === 0 || names.includes(key)))
  await capture(name, scenario)

async function capture(name: string, scenario: Scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-codex-golden-"))
  const home = path.join(root, "codex-home")
  const workspace = path.join(root, "workspace")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  Object.entries(scenario.files).forEach(([file, text]) => fs.writeFileSync(path.join(workspace, file), text))
  run(["git", "init", "-q"], workspace)
  const fake = startFakeOpenAIResponses({ models: [scenario.model] })
  fake.enqueue(...scenario.replies)
  const catalog = scenario.catalog === undefined ? undefined : path.join(home, "catalog.json")
  if (catalog !== undefined) fs.copyFileSync(path.join(OUT, scenario.catalog!), catalog)
  fs.writeFileSync(
    path.join(home, "config.toml"),
    [
      `model = "${scenario.model}"`,
      ...(catalog === undefined ? [] : [`model_catalog_json = '${catalog}'`]),
      // A provider named "OpenAI" counts as OpenAI (`ModelProviderInfo::is_openai`), so the request has the OpenAI shape;
      // unlike the built-in one it can turn the WebSocket transport off, which the fake does not serve.
      `model_provider = "golden"`,
      `approval_policy = "never"`,
      `sandbox_mode = "${scenario.sandbox}"`,
      `check_for_update_on_startup = false`,
      `[model_providers.golden]`,
      `name = "OpenAI"`,
      `base_url = "${fake.baseURL}"`,
      `env_key = "OWN_GOLDEN_API_KEY"`,
      `wire_api = "responses"`,
      `supports_websockets = false`,
      `[analytics]`,
      `enabled = false`,
      `[projects.'${workspace.replaceAll("\\", "\\\\")}']`,
      `trust_level = "trusted"`,
      "",
    ].join("\n"),
  )
  // Async: the fake answers from this process, so a blocking spawn would deadlock.
  const result = await spawn([CODEX, "exec", "--skip-git-repo-check", scenario.prompt], workspace, {
    CODEX_HOME: home,
    OWN_GOLDEN_API_KEY: "sk-own-golden-fake",
    // Anything not bound for the fake goes to a dead proxy, so a wrong setting can never reach the network.
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  })
  await fake.stop()
  const requests = fake.requests
    .filter((request) => request.method === "POST")
    .map((request) => ({ path: request.path, headers: request.headers, body: request.json }))
  const golden = withoutUserSkills(normalize({ codex: version, scenario: name, model: scenario.model, sandbox: scenario.sandbox, requests }, [
    [workspace, "<WORKSPACE>"],
    [workspace.replaceAll("\\", "/"), "<WORKSPACE>"],
    [home, "<CODEX_HOME>"],
    [home.replaceAll("\\", "/"), "<CODEX_HOME>"],
    [os.homedir(), "<HOME>"],
    [os.homedir().replaceAll("\\", "/"), "<HOME>"],
  ]))
  fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(golden, null, 2)}\n`)
  if (name === TOOLS_SCENARIO) writeTools(requests[0]?.body)
  if (name === CODE_MODE_SCENARIO) writeCodeMode(requests[0]?.body)
  console.log(`${name}: ${requests.length} requests, codex exit ${result.code}`)
  if (requests.length === 0) console.log(result.stdout, result.stderr)
  fs.rmSync(root, { recursive: true, force: true })
}


/**
 * The Direct-mode tool definitions Codex sent in the gpt-5.5 scenario, as codex-data/tools.<platform>.json: the harness
 * sends exactly those bytes (Codex builds them in Rust, and some text depends on the OS). Codex's Windows builds embed
 * the apply_patch grammar as checked out with CRLF (and mangle `%import`), so the data keeps the repository's grammar.
 */
function writeTools(body: unknown) {
  const tools = (body as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? []
  const data = path.join(import.meta.dir, "..", "codex-data")
  const grammar = fs.readFileSync(path.join(data, "apply_patch.lark"), "utf8")
  const canonical = tools.map((tool) =>
    tool.type === "custom" && tool.name === "apply_patch"
      ? { ...tool, format: { ...(tool.format as object), definition: grammar } }
      : tool,
  )
  fs.writeFileSync(
    path.join(data, `tools.${process.platform}.json`),
    `${JSON.stringify({ codex: version, tools: canonical }, null, 2)}\n`,
  )
}

/**
 * Codex's Code Mode Only surface for GPT-6 (Responses Lite): the namespaces of the `additional_tools` item (`exec`'s
 * description lists Codex's default nested tools) and the multi-agent developer texts, as codex-data/code-mode.<platform>.json.
 */
function writeCodeMode(body: unknown) {
  const input = (body as { input?: Array<Record<string, any>> } | undefined)?.input ?? []
  const additional = input.find((item) => item.type === "additional_tools")
  const developer = (tag: string) =>
    input
      .filter((item) => item.type === "message" && item.role === "developer")
      .flatMap((item) => (item.content as Array<{ text: string }>).map((part) => part.text))
      .find((text) => text.startsWith(`<${tag}>`))
  fs.writeFileSync(
    path.join(import.meta.dir, "..", "codex-data", `code-mode.${process.platform}.json`),
    `${JSON.stringify(
      {
        codex: version,
        tools: additional?.tools ?? [],
        multiAgentRole: developer("multi_agent_role"),
        multiAgentMode: developer("multi_agent_mode"),
      },
      null,
      2,
    )}\n`,
  )
}

/** The pinned CLI in refs/codex-cli/<version> beside the main checkout's reference clone, when installed. */
function pinned() {
  if (pin.cli === undefined) return undefined
  const common = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], REPO).stdout.trim()
  const bin = path.join(path.dirname(common), "refs", "codex-cli", pin.cli, "node_modules", ".bin", "codex")
  return fs.existsSync(process.platform === "win32" ? `${bin}.cmd` : bin) ? bin : undefined
}

/** Replaces machine-specific paths so goldens compare across runs. */
function normalize(value: unknown, pairs: ReadonlyArray<readonly [string, string]>) {
  const text = JSON.stringify(value)
  // Each path as JSON text and as JSON text nested in a JSON string (client_metadata's turn metadata).
  const replaced = pairs.reduce(
    (current, [from, to]) =>
      current
        .replaceAll(JSON.stringify(JSON.stringify(from).slice(1, -1)).slice(1, -1), to)
        .replaceAll(JSON.stringify(from).slice(1, -1), to),
    text,
  )
  return JSON.parse(replaced) as unknown
}

/**
 * The capture without the skills of the PC user's own `~/.agents/skills`: Codex lists that root and its skills, and on
 * Windows finds the profile folder through the system (`dirs::home_dir`), whatever HOME or USERPROFILE say, so a
 * throwaway home cannot hide it. The golden keeps what a PC without that folder sends: the root's line and its skills
 * go, and the other roots' aliases (`r1` …) move up.
 */
function withoutUserSkills(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUserSkills)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutUserSkills(item)]))
  if (typeof value !== "string" || !value.startsWith("<skills_instructions>")) return value
  const roots = [...value.matchAll(/^- `(r\d+)` = `([^`]*)`$/gm)]
  const own = roots.find((root) => root[2] === "<HOME>/.agents/skills")?.[1]
  if (own === undefined) return value
  const kept = roots.filter((root) => root[1] !== own).map((root) => root[1]!)
  const alias = new Map(kept.map((name, index) => [name, `r${index}`]))
  return value
    .split("\n")
    .filter((line) => !line.startsWith(`- \`${own}\` = `) && !line.includes(`(file: ${own}/`))
    .map((line) =>
      line
        .replace(/^- `(r\d+)` = /, (_, name: string) => `- \`${alias.get(name) ?? name}\` = `)
        .replace(/\(file: (r\d+)\//, (_, name: string) => `(file: ${alias.get(name) ?? name}/`),
    )
    .join("\n")
}

async function spawn(command: ReadonlyArray<string>, cwd: string, env: Readonly<Record<string, string>>) {
  const proc = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), 120_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  clearTimeout(timer)
  return { code: await proc.exited, stdout, stderr }
}

function run(command: ReadonlyArray<string>, cwd: string, env: Readonly<Record<string, string>> = {}) {
  const result = Bun.spawnSync([...command], { cwd, env: { ...process.env, ...env }, stdin: "ignore" })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}
