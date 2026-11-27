// Golden comparison (10 §4.1) for a model outside Codex's catalog: the `exec-unknown-model` scenario through own's
// `codex` harness against what Codex CLI 0.171.0 sent (test/golden/codex/exec-unknown-model.json): the fallback
// prompt, no apply_patch, and the v1 agent tools up front. Normalized as in golden.test.ts; what differs by design is
// listed in KNOWN_GAPS.
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

const GOLDEN = path.join(import.meta.dir, "..", "golden", "codex", "exec-unknown-model.json")
const MODEL = { providerID: "fake-a", id: "own-unknown-model" }
/** The capture ran read-only: own's read-only mode (shell and edits refused). */
const READ_ONLY = [
  { action: "edit", resource: "**", effect: "deny" },
  { action: "shell", resource: "**", effect: "deny" },
]

/** Differences by design. */
const KNOWN_GAPS = {
  /** own runs sessions as Codex's interactive app does, which adds `<collaboration_mode>`; `codex exec` has none. */
  developer: ["<collaboration_mode>", "# Code Mode", "When you create a worktree"],
  /**
   * own's Code Mode (`execute`), which Direct sessions keep for own's tools (session, models, MCP resources), and own's
   * `websearch`, which read-only sends in place of Codex's hosted `web_search` because it asks first (MR12-5).
   */
  tools: ["execute", "websearch"],
  /** Codex's tools own does not send in this mode: its hosted search, which nobody is asked about. */
  theirs: ["web_search"],
  fields: [] as Array<string>,
}

type Item = Record<string, any>
type Body = { input: Array<Item>; tools?: Array<Item>; [key: string]: unknown }

let fake: FakeOpenAIResponses
let server: OpencodeServer

beforeAll(async () => {
  fake = startFakeOpenAIResponses({ models: ["own-unknown-model"] })
  server = await startOpencodeServer({
    startupTimeoutMs: 170_000,
    projectConfig: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-a": openAIResponsesProvider(fake, {
            apiKey: "fake-key-a",
            models: { "own-unknown-model": { name: "own-unknown-model" } },
          }),
        },
        // Codex's bytes: the original variant (the plugin's default is own's revision, 10 §3.9 H-D7).
        plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: { prompt: "reference" } }],
      })
    },
  })
  await server.waitForModels([MODEL])
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await fake?.stop()
}, 60_000)

function normalize(value: unknown, workspace?: string): unknown {
  const text = JSON.stringify(value, (key, entry) =>
    key === "id" || key === "internal_chat_message_metadata_passthrough" ? undefined : entry,
  )
  const folded = text
    .replaceAll("\\r\\n", "\\n")
    .replace(/<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/g, "<current_date>DATE</current_date>")
  const placed =
    workspace === undefined ? folded : folded.replaceAll(JSON.stringify(workspace).slice(1, -1), "<WORKSPACE>")
  return JSON.parse(placed)
}

const texts = (item: Item): Array<string> => item.content.map((part: { text: string }) => part.text)
const frame = (text: string) => text.replace(/### Skill roots\n[\s\S]*<\/skills_instructions>$/, "<SKILLS></skills_instructions>")

describe("codex harness vs Codex 0.171.0 (exec-unknown-model)", () => {
  test("the same scenario gives the same request, except the known gaps", async () => {
    const golden: { requests: Array<{ body: Body }> } = await Bun.file(GOLDEN).json()
    const created = (await server.call("POST", "/api/session", {
      body: { title: "golden", model: MODEL, location: { directory: server.paths.workspace }, permissions: READ_ONLY },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    while (OwnHarness.bound((await sessionInfo(server, sessionID)).metadata as Record<string, unknown>) === undefined)
      await Bun.sleep(50)
    fake.enqueue({ type: "text", text: "Hi." })
    const before = fake.requests.length
    await server.prompt(sessionID, "Say hi.")
    await server.waitIdle(sessionID)
    const mine = fake.requests
      .slice(before)
      .map((request) => normalize(request.json, server.paths.workspace) as Body)
      .find((body) => JSON.stringify(body.input).includes("Say hi."))!
    const theirs = normalize(golden.requests[0]!.body) as Body

    expect(mine.input[0]).toEqual(theirs.input[0])
    const myDeveloper = texts(mine.input[1]!).filter((text) => !KNOWN_GAPS.developer.some((tag) => text.startsWith(tag)))
    expect(myDeveloper.map(frame)).toEqual(texts(theirs.input[1]!).map(frame))
    expect(mine.input.slice(2)).toEqual(theirs.input.slice(2))
    expect(mine.tools!.filter((tool) => !KNOWN_GAPS.tools.includes(tool.name))).toEqual(
      theirs.tools!.filter((tool) => !KNOWN_GAPS.theirs.includes(tool.name ?? tool.type)),
    )
    expect(mine.tools!.map((tool) => tool.name ?? tool.type)).toContain("websearch")
    const fields = Object.keys(theirs).filter(
      (field) => !["input", "tools", "client_metadata", "prompt_cache_key", "model"].includes(field),
    )
    expect(fields.filter((field) => JSON.stringify(mine[field]) !== JSON.stringify(theirs[field]))).toEqual(
      KNOWN_GAPS.fields,
    )
  }, 180_000)
})
