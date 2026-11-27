// The shell each harness's prompt names is the shell its tool runs (decisions SA-3), end to end on a real server
// (source plugin, fake OpenAI Responses provider). A scripted model asks every harness's shell tool which shell it is:
// - `opencode` (and `omo`, `claude-code` off the Claude Agent provider): core's `shell` tool names the shell in its
//   description ("Commands run on Windows using pwsh") and runs it;
// - `codex`: `<environment_context>` names `<shell>powershell</shell>` on Windows and exec_command runs PowerShell;
// - `dsh`: the tool itself is `pwsh` on Windows (`bash` elsewhere) and runs it;
// - `pi`: the tool is `bash` everywhere; on Windows it runs Git Bash, and own's <rules> line says so, since nothing else
//   in Pi's prompt does and AGENTS.md files often speak of PowerShell.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  sessionInfo,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { HARNESS_PLUGINS } from "./full-prefix.js"
import { PiShell } from "../../src/pi/shell.js"

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-5.5" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const win = process.platform === "win32"
/** Prints which shell runs it: PowerShell prints its edition, bash its version. */
const WHICH = win ? 'Write-Output "edition:$($PSVersionTable.PSEdition)"' : 'echo "bash:$BASH_VERSION"'
/** Identifies PowerShell (`edition:Core`) or bash (`bash:5.…`) in one command both run. */
const EITHER = 'echo "edition:$($PSVersionTable.PSEdition) bash:$BASH_VERSION"'

type Body = { input: Array<Record<string, any>>; tools?: Array<Record<string, any>>; [key: string]: unknown }

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: ["gpt-5.5"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    env: { OWN_OPEN_CODE: "1" },
    config: opencodeConfig({
      providers: {
        "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: { "gpt-5.5": { name: "gpt-5.5" } } }),
      },
      plugins: HARNESS_PLUGINS,
    }),
  })
  await server.waitForModels([MODEL])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

async function create(harness: OwnHarness.HarnessID) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: `shells ${harness}`,
      model: MODEL,
      location: { directory: server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
      permissions: FULL,
    },
  })) as { data: { id: string } }
  const sessionID = created.data.id
  const deadline = Date.now() + 15_000
  while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined) {
    if (Date.now() > deadline) throw new Error("own.harness did not stamp the session")
    await Bun.sleep(50)
  }
  // A harness's tools are listed once its gate rule is written after the binding.
  await Bun.sleep(200)
  return sessionID
}

/** One shell call: the first request (prompt and tools) and the call's output in the second. */
async function ask(harness: OwnHarness.HarnessID, call: { name: string; input: Record<string, unknown> }) {
  const sessionID = await create(harness)
  const text = `Which shell runs ${harness}?`
  fake.enqueue({ type: "tool-call", ...call }, { type: "text", text: "done" })
  const before = fake.requests.length
  await server.prompt(sessionID, text)
  await server.waitIdle(sessionID)
  const bodies = fake.requests
    .slice(before)
    .filter((request) => request.method === "POST")
    .map((request) => request.json as Body)
    .filter((body) => JSON.stringify(body.input).includes(text))
  const output = bodies.at(-1)!.input.findLast((item) => item.type === "function_call_output")?.output
  return {
    prompt: JSON.stringify([bodies[0]!.instructions ?? "", bodies[0]!.input]),
    tools: bodies[0]!.tools ?? [],
    output: typeof output === "string" ? output : JSON.stringify(output),
  }
}

describe("the shell a harness's prompt names is the shell its tool runs", () => {
  test("opencode: core's shell tool names its shell and runs it", async () => {
    // Core picks the shell from SHELL first, then pwsh on Windows (core shell/select.ts), and its description names the
    // same pick; this command identifies either.
    const result = await ask("opencode", { name: "shell", input: { command: EITHER } })
    const named = /Commands run on \S+ using (\S+)\./.exec(
      String(result.tools.find((tool) => tool.name === "shell")?.description),
    )?.[1]
    expect(named).toBeDefined()
    if (win && process.env.SHELL === undefined) expect(named).toBe("pwsh")
    if (named === "pwsh" || named === "powershell") expect(result.output).toContain("edition:")
    if (named === "pwsh") expect(result.output).toContain("edition:Core")
    if (named === "bash") expect(result.output).toMatch(/bash:\d+\./)
  }, 180_000)

  test("codex: <environment_context> names the shell exec_command runs", async () => {
    const result = await ask("codex", { name: "exec_command", input: { cmd: WHICH } })
    if (win) expect(result.prompt).toContain("<shell>powershell</shell>")
    expect(result.output).toContain(win ? "edition:Core" : "bash:")
  }, 180_000)

  test("dsh: the tool is named for the shell it runs", async () => {
    const name = win ? "pwsh" : "bash"
    const result = await ask("dsh", { name, input: { description: "which shell", command: WHICH } })
    expect(result.tools.map((tool) => tool.name)).toContain(name)
    expect(result.output).toContain(win ? "edition:Core" : "bash:")
  }, 180_000)

  test("pi: bash runs bash, and on Windows Pi's <rules> say it is Git Bash, not PowerShell", async () => {
    const result = await ask("pi", { name: "bash", input: { command: 'echo "bash:$BASH_VERSION"' } })
    expect(result.output).toMatch(/bash:\d+\./)
    const [line] = PiShell.windowsGuidelines()
    if (!win) {
      expect(line).toBeUndefined()
      return
    }
    expect(line).toContain("On Windows the bash tool runs Git Bash, not PowerShell")
    expect(result.prompt).toContain(JSON.stringify(`- ${line}`).slice(1, -1))
    // What the model did in the user's report: a PowerShell cmdlet in bash fails there.
    const cmdlet = await ask("pi", { name: "bash", input: { command: "Get-ChildItem" } })
    expect(cmdlet.output).toContain("Get-ChildItem: command not found")
  }, 180_000)
})
