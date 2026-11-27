// Golden comparison (10 §4.1): the `exec-basic` scenario run through own's `codex` harness against the request Codex
// CLI 0.171.0 itself sent (test/golden/codex/exec-basic.json, script/codex-golden.ts). Both are normalized: item ids,
// Codex's internal metadata and client_metadata are dropped, the workspace path is a placeholder, and the CRLF that
// Codex's Windows build embeds in its template files is folded to the repository's LF. What still differs is listed in
// KNOWN_GAPS, so closing a gap fails this test until the list is updated.
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  REPO_ROOT,
  sessionInfo,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"

const GOLDEN = path.join(import.meta.dir, "..", "golden", "codex", "exec-basic.json")
const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-a", id: "gpt-5.5" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

/** Tools Codex sends that the codex harness does not have yet. */
const KNOWN_GAPS = {
  tools: [] as Array<string>,
  fields: [] as Array<string>,
}

type Body = { input: Array<Record<string, any>>; tools?: Array<Record<string, any>>; [key: string]: unknown }

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: ["gpt-5.5"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
      fs.writeFileSync(path.join(paths.workspace, "hello.txt"), "hello from the workspace\n")
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, { apiKey: "fake-key-a", models: { "gpt-5.5": { name: "gpt-5.5" } } }),
        },
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
      })
    },
  })
  await server.waitForModels([MODEL])
}, BOOT_TIMEOUT)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

/** Drops what differs by design between any two runs (ids, Codex-internal metadata) and folds paths and CRLF. */
function normalize(value: unknown, workspace?: string): unknown {
  const text = JSON.stringify(value, (key, entry) =>
    key === "id" || key === "internal_chat_message_metadata_passthrough" ? undefined : entry,
  )
  // The capture's date is the day it was taken.
  const folded = text
    .replaceAll("\\r\\n", "\\n")
    .replace(/<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/g, "<current_date>DATE</current_date>")
  const placed =
    workspace === undefined ? folded : folded.replaceAll(JSON.stringify(workspace).slice(1, -1), "<WORKSPACE>")
  return JSON.parse(placed)
}

function texts(item: Record<string, any>): Array<string> {
  return Array.isArray(item.content) ? item.content.map((part: { text: string }) => part.text) : [item.content]
}

describe("codex harness vs Codex 0.171.0 (exec-basic)", () => {
  test("the same scenario gives the same request, except the known gaps", async () => {
    const golden: { requests: Array<{ body: Body }> } = await Bun.file(GOLDEN).json()
    const created = (await server.call("POST", "/api/session", {
      body: { title: "golden", model: MODEL, location: { directory: server.paths.workspace }, permissions: FULL },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    const command = "Get-Content hello.txt"
    fake.enqueue(
      { type: "tool-call", name: "exec_command", input: { cmd: command } },
      { type: "text", text: "It says hello from the workspace." },
    )
    const before = fake.requests.length
    await server.prompt(sessionID, "Show me what is in hello.txt.")
    await server.waitIdle(sessionID)
    const ours = fake.requests
      .slice(before)
      .map((request) => request.json as Body)
      .filter((body) => JSON.stringify(body.input).includes("Show me what is in hello.txt."))
    expect(ours).toHaveLength(2)
    const theirs = golden.requests.map((request) => normalize(request.body) as Body)
    const mine = ours.map((body) => normalize(body, server.paths.workspace) as Body)

    // Base instructions: identical.
    expect(mine[0]!.input[0]).toEqual(theirs[0]!.input[0])
    // Developer fragments: Codex's skills list is its own system skills; collaboration mode is what the interactive
    // Codex app adds (codex exec has none). The permissions fragment is identical, and so is the deferred tool
    // namespaces fragment that closes the message (0.167.0).
    const theirDeveloper = texts(theirs[0]!.input[1]!)
    const myDeveloper = texts(mine[0]!.input[1]!)
    expect(myDeveloper.find((text) => text.startsWith("<permissions instructions>"))).toBe(
      theirDeveloper.find((text) => text.startsWith("<permissions instructions>")),
    )
    expect(theirDeveloper.at(-1)).toStartWith("<tools>\n")
    expect(myDeveloper.at(-1)).toBe(theirDeveloper.at(-1))
    expect(myDeveloper.at(-2)).toStartWith("<collaboration_mode>")
    // AGENTS.md and environment_context: identical.
    expect(mine[0]!.input[2]).toEqual(theirs[0]!.input[2])
    // The prompt, then the call and its output with Codex's header (the chunk id and timings differ per run).
    expect(mine[0]!.input[3]).toEqual(theirs[0]!.input[3])
    const myCall = mine[1]!.input.find((item) => item.type === "function_call")
    const theirCall = theirs[1]!.input.find((item) => item.type === "function_call")
    expect({ ...myCall, call_id: undefined }).toEqual({ ...theirCall, call_id: undefined })
    const header =
      /^Chunk ID: [0-9a-f]{6}\nWall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOriginal token count: \d+\nOutput:\n/
    const myOutput = mine[1]!.input.find((item) => item.type === "function_call_output")!.output as string
    const theirOutput = theirs[1]!.input.find((item) => item.type === "function_call_output")!.output as string
    expect(myOutput).toMatch(header)
    expect(myOutput.replace(header, "")).toBe(theirOutput.replace(header, ""))

    // Tools: Codex's first, with Codex's bytes; what own does not have yet is listed.
    const theirTools = theirs[0]!.tools!
    const myTools = mine[0]!.tools!
    const shared = theirTools.filter((tool) => !KNOWN_GAPS.tools.includes(tool.name ?? tool.type))
    expect(myTools.slice(0, shared.length)).toEqual(shared)
    expect(
      theirTools
        .map((tool) => tool.name ?? tool.type)
        .filter((name) => !myTools.some((tool) => (tool.name ?? tool.type) === name)),
    ).toEqual(KNOWN_GAPS.tools)

    // Request fields.
    const fields = Object.keys(theirs[0]!).filter(
      (field) => !["input", "tools", "client_metadata", "prompt_cache_key", "model"].includes(field),
    )
    expect(fields.filter((field) => JSON.stringify(mine[0]![field]) !== JSON.stringify(theirs[0]![field]))).toEqual(
      KNOWN_GAPS.fields,
    )
  }, 180_000)
})
