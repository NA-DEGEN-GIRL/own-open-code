// Claude on the own harnesses' prompts and tools, through `claude -p` (own/reports/harness-live-2026-10-14.md §5).
// There is no Anthropic API key and the Claude subscription's credentials must not be used directly, so the loop is
// Claude Code's: its system prompt is replaced with the harness's (from script/prompt-capture.ts) and its built-in tools
// with the harness's own tools over MCP (mcp-tools.ts). This measures how Claude works with each harness's
// instructions and tools; own's request plumbing (history translation, compaction, caching) is not on this path.
// `claude-code` runs Claude Code's own prompt and tools for reference.
//
//   bun script/live/claude/run.ts --prompts <capture dir> [--suite bugfix|steps] [--variants codex,pi,claude-code]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TASKS } from "../tasks.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const PROMPTS = path.resolve(option("prompts") ?? path.join(os.tmpdir(), "own-prompts"))
const SUITE = option("suite") ?? "bugfix"
const VARIANTS = (option("variants") ?? "codex,pi,claude-code").split(",")
const MODEL = option("model") ?? "opus"
const OUT = path.resolve(option("out") ?? path.join(os.tmpdir(), "own-live-claude"))
const ROOT = path.join(OUT, "work")
const LIVE = path.join(import.meta.dirname, "..")
const AGENTS = "Use Bun. Keep the code small and typed.\n"
const STEPS = SUITE === "steps" ? ["merge", "subtract", "cli", "review"] : ["bugfix"]

fs.mkdirSync(ROOT, { recursive: true })
const results = (await Promise.all(VARIANTS.map(runVariant))).flat()
fs.writeFileSync(path.join(OUT, `results-${SUITE}.json`), JSON.stringify(results, null, 2))
console.table(results.map(({ reply: _, ...row }) => row))

async function runVariant(variant: string) {
  const directory = path.join(ROOT, `${SUITE}-${variant}-${Date.now()}`)
  seed(directory)
  const setup = variant === "claude-code" ? undefined : harness(variant, directory)
  const rows = []
  let session: string | undefined
  for (const [index, task] of STEPS.entries()) {
    const text = TASKS[task as keyof typeof TASKS]
    const prompt = index === 0 && setup?.context ? `${setup.context}\n\n${text}` : text
    const started = Date.now()
    const outcome = await claude(directory, prompt, setup, session)
    session = outcome.session ?? session
    const tests = runTests(directory)
    const row = {
      variant,
      step: index,
      task,
      seconds: Math.round((Date.now() - started) / 1000),
      turns: outcome.turns,
      tools: outcome.tools,
      tests: `${tests.pass}/${tests.pass + tests.fail}`,
      ok: tests.ok && (task !== "bugfix" || !testsChanged(directory)),
      error: outcome.error,
      reply: outcome.reply.slice(0, 300),
    }
    console.log(JSON.stringify(row))
    rows.push(row)
  }
  return rows
}

/** The harness's system prompt for Claude and its contextual user message, rewritten for this folder. */
function harness(name: string, directory: string) {
  const body = JSON.parse(fs.readFileSync(path.join(PROMPTS, `${name}.claude-opus-5-5.json`), "utf8")) as {
    system: Array<{ text: string }>
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
  }
  const workspace = /[A-Za-z]:\\[^\s"<>]*?own-e2e-[A-Za-z0-9]+\\workspace/
  const fix = (text: string) =>
    text
      .split(workspace.exec(text)?.[0] ?? "\u0000")
      .join(directory)
      .replace("(Project instructions from AGENTS.md go here.)", AGENTS.trim())
  // own's Code Mode catalog and core's worktree note name tools this test does not serve.
  const system = body.system
    .map((block) => block.text)
    .filter((text) => !text.startsWith("# Code Mode") && !text.startsWith("When you create a worktree"))
    .map((text) => text.replace(/<addendum>[\s\S]*?<\/addendum>\n*/g, ""))
    .map(fix)
    .join("\n\n")
  const first = body.messages[0]
  const context =
    first && first.role === "user"
      ? (typeof first.content === "string" ? first.content : first.content.map((part) => part.text ?? "").join("\n"))
      : ""
  const promptFile = path.join(OUT, `${name}-system.txt`)
  fs.writeFileSync(promptFile, system)
  const mcpFile = path.join(OUT, `${name}-${path.basename(directory)}-mcp.json`)
  fs.writeFileSync(
    mcpFile,
    JSON.stringify({
      mcpServers: { own: { command: "bun", args: [path.join(import.meta.dirname, "mcp-tools.ts"), "--harness", name, "--cwd", directory] } },
    }),
  )
  // Pi puts AGENTS.md in its system prompt; Codex sends it as the first user message.
  return { promptFile, mcpFile, context: name === "codex" ? fix(context) : "" }
}

async function claude(
  directory: string,
  prompt: string,
  setup: { promptFile: string; mcpFile: string } | undefined,
  session: string | undefined,
) {
  const flags = setup
    ? [
        "--system-prompt-file", setup.promptFile,
        "--exclude-dynamic-system-prompt-sections",
        "--mcp-config", setup.mcpFile,
        "--strict-mcp-config",
        "--tools", "",
        "--allowedTools", "mcp__own",
      ]
    : ["--allowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "--permission-mode", "acceptEdits"]
  const proc = Bun.spawn(
    [
      "claude", "-p", "--model", MODEL, "--output-format", "stream-json", "--verbose", "--max-turns", "80",
      ...flags,
      ...(session ? ["--resume", session] : []),
    ],
    { cwd: directory, stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const events = stdout.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as Record<string, any>] : []
    } catch {
      return []
    }
  })
  const tools = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => (event.message?.content ?? []) as Array<{ type: string; name?: string }>)
    .filter((part) => part.type === "tool_use")
    .reduce<Record<string, number>>((counts, part) => {
      const name = String(part.name).replace(/^mcp__own__/, "")
      return { ...counts, [name]: (counts[name] ?? 0) + 1 }
    }, {})
  const result = events.findLast((event) => event.type === "result")
  return {
    session: result?.session_id as string | undefined,
    turns: result?.num_turns as number | undefined,
    tools: Object.entries(tools).map(([name, count]) => `${name}×${count}`).join(" "),
    reply: String(result?.result ?? ""),
    error: result?.is_error ? String(result?.subtype ?? "error") : result ? undefined : stderr.slice(0, 300),
  }
}

function seed(directory: string) {
  fs.mkdirSync(path.join(directory, "test"), { recursive: true })
  if (SUITE === "bugfix") {
    fs.cpSync(path.join(LIVE, "fixtures", "bugfix"), directory, { recursive: true })
    for (const file of fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".txt")))
      fs.renameSync(path.join(directory, file), path.join(directory, file.slice(0, -".txt".length)))
  }
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "claude-live", type: "module" }, null, 2))
  fs.writeFileSync(path.join(directory, "AGENTS.md"), AGENTS)
  fs.writeFileSync(path.join(directory, "CLAUDE.md"), AGENTS)
  Bun.spawnSync(["git", "init", "-q"], { cwd: directory })
  Bun.spawnSync(["git", "add", "-A"], { cwd: directory })
  Bun.spawnSync(["git", "-c", "user.name=live", "-c", "user.email=live@example.test", "commit", "-qm", "seed"], { cwd: directory })
}

function testsChanged(directory: string) {
  return Bun.spawnSync(["git", "diff", "--quiet", "HEAD", "--", "test"], { cwd: directory }).exitCode !== 0
}

function runTests(directory: string) {
  const run = Bun.spawnSync(["bun", "test"], { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 120_000 })
  const text = run.stdout.toString() + run.stderr.toString()
  const pass = Number(/(\d+) pass/.exec(text)?.[1] ?? 0)
  const fail = Number(/(\d+) fail/.exec(text)?.[1] ?? 0)
  return { pass, fail, ok: run.exitCode === 0 && pass > 0 }
}
