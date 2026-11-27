import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach } from "bun:test"

const made: string[] = []

/** A fresh folder under the system temp folder, removed after the test. */
export async function tempDir(prefix = "own-creator-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => removeTree(dir)))
})

const RETRIED: ReadonlySet<string> = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])

// Bun accepts `fs.rm`'s `maxRetries` but does not retry: on Windows a file a just-ended sandbox host, the indexer or
// Defender still holds answers EBUSY or EPERM for a moment, so the removal is retried here (about 2 s at most).
async function removeTree(target: string, attempts = 20): Promise<void> {
  const failure = await fs.rm(target, { recursive: true, force: true }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => error,
  )
  if (failure === undefined) return
  if (attempts <= 1 || !RETRIED.has(failure.code ?? "")) throw failure
  await Bun.sleep(100)
  return removeTree(target, attempts - 1)
}

/** A valid manifest with one item of every C1 type. */
export function manifest(id = "sample", overrides: Record<string, unknown> = {}) {
  return {
    format: "own.ext/1",
    id,
    title: "Sample",
    items: [
      { type: "prompt.fragment", id: "style", text: "Answer briefly." },
      {
        type: "tool.command",
        name: `${id.replaceAll("-", "_")}_echo`,
        description: "Echoes a word",
        command: "echo {{word}}",
        params: { word: { type: "string", description: "The word" } },
      },
      { type: "tool.rule", rules: [{ permission: "shell", pattern: "git push*", effect: "ask" }] },
      { type: "retry", maxRetries: 2 },
      { type: "compaction.prompt", text: "Keep the TODO list." },
    ],
    ...overrides,
  }
}

/** A C2 server: `count_words` and `read_file` (through own's file API), with a test of its own. */
export const SERVER = `import { serve, type ServerDefinition } from "./own-mcp"

export const definition: ServerDefinition = {
  name: "words",
  tools: {
    count_words: {
      description: "Counts the words of a text.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: (args) => \`words: \${String(args.text).split(" ").filter(Boolean).length}\`,
    },
    read_file: {
      description: "Reads a file of the project.",
      input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      run: async (args, context) => context.files.read(String(args.path)),
    },
  },
}

serve(definition)
`

export const SERVER_TEST = `import { expect, test, callTool } from "./own-mcp"
import { definition } from "./tools"

test("counts words", async () => {
  const result = await callTool(definition, "count_words", { text: "a b c" })
  expect(JSON.stringify(result)).toContain("words: 3")
})
`

/** A valid C2 extension: one server whose entry imports its tools from another file. */
export function mcpManifest(id = "words", overrides: Record<string, unknown> = {}) {
  return {
    format: "own.ext/1",
    id,
    title: "Words",
    kind: "mcp",
    items: [
      {
        type: "mcp.server",
        name: "words",
        files: {
          "tools.ts": SERVER.replace("\nserve(definition)\n", "\n"),
          "server.ts": 'import { serve } from "./own-mcp"\nimport { definition } from "./tools"\n\nserve(definition)\n',
          "tools.test.ts": SERVER_TEST,
        } as Record<string, string>,
        smoke: [{ tool: "count_words", arguments: { text: "one two" }, expect: "words: 2" }],
        ...overrides,
      },
    ],
  }
}

export const PLUGIN = `import { definePlugin } from "./own-plugin.ts"

export default definePlugin({
  hooks: {
    context: (request) => {
      request.messages.push({ role: "user", content: [{ type: "text", text: "PLUGIN-NOTE: be brief." }] })
    },
  },
})
`

/** A valid C3 extension: a context hook that appends a note after the conversation (the cache is kept). */
export function pluginManifest(id = "brief", source = PLUGIN, overrides: Record<string, unknown> = {}) {
  return {
    format: "own.ext/1",
    id,
    title: "Brief",
    kind: "plugin",
    items: [{ type: "plugin.code", hooks: ["context"], files: { "plugin.ts": source } as Record<string, string>, ...overrides }],
  }
}
