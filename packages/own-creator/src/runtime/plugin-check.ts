// plugin-check.ts: staging's end-to-end check of a creator code plugin (own/docs/17 §12.3), run by own.creator in a
// child process with an allow-listed environment. It loads the staged version through the same shim the service uses
// (`own-shim.ts`) and runs each of its hooks on a fixed request, the fake model's conversation:
//
// - e2e: the hook runs, does not throw, does not time out, and leaves a request;
// - golden: the same request twice gives the same bytes (a hook is a pure function of the request, 02 §4.3 D1), and a
//   plugin that keeps the cache (`cache: "keeps"`) leaves the cached prefix, the system prompt, the tools and every
//   message before the last, byte for byte as the request without it.
//
// It prints one JSON line: `{ ok, checks: [{ name, ok, detail? }] }`.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

interface CheckConfig {
  /** The staged version folder. */
  readonly folder: string
  readonly extension: string
  readonly entry: string
  readonly version: number
  readonly cache: "keeps" | "breaks"
  /** A scratch folder for the check's crash file and log. */
  readonly scratch: string
  readonly hookMs: number
}

type Hook = "context" | "compaction"

interface Runner {
  readonly hooks: ReadonlyArray<Hook>
  readonly run: (hook: Hook, event: Record<string, unknown>) => Promise<void>
}

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")) as CheckConfig
const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
const crashes = path.join(config.scratch, "crashes.jsonl")

const shim = (await import(pathToFileURL(path.join(config.folder, "own-shim.ts")).href)) as {
  load: (options: unknown, folder: string, extension: string, directory: string) => Promise<Runner | undefined>
}
const options = {
  entry: config.entry,
  version: config.version,
  log: path.join(config.scratch, "plugin.log"),
  crashes,
  hookMs: config.hookMs,
}
const runner = await shim.load(options, config.folder, config.extension, config.scratch)
checks.push({ name: "load", ok: runner !== undefined, ...(runner === undefined ? { detail: lastCrash() } : {}) })

for (const hook of runner?.hooks ?? []) {
  const first = request(hook)
  await runner!.run(hook, first)
  const threw = lastCrash()
  checks.push({ name: `e2e ${hook}`, ok: threw === undefined, ...(threw === undefined ? {} : { detail: threw }) })
  if (threw !== undefined) break
  const second = request(hook)
  await runner!.run(hook, second)
  const again = JSON.stringify(second) === JSON.stringify(first)
  checks.push({
    name: `golden ${hook} stable`,
    ok: again,
    ...(again ? {} : { detail: "the same request gave different bytes on a second run" }),
  })
  if (config.cache === "keeps") {
    const plain = request(hook)
    const kept =
      JSON.stringify(first.system) === JSON.stringify(plain.system) &&
      JSON.stringify(first.tools) === JSON.stringify(plain.tools) &&
      JSON.stringify(first.messages.slice(0, plain.messages.length - 1)) ===
        JSON.stringify(plain.messages.slice(0, plain.messages.length - 1))
    checks.push({
      name: `golden ${hook} prefix`,
      ok: kept,
      ...(kept
        ? {}
        : { detail: "the system prompt, the tools or an earlier message changed: declare cache 'breaks' or keep them" }),
    })
  }
}

process.stdout.write(`${JSON.stringify({ ok: checks.every((check) => check.ok), checks })}\n`)

/** The fixed request of the fake model's conversation. */
function request(hook: Hook) {
  return {
    sessionID: "ses_creator_check",
    agent: "build",
    model: { providerID: "fake", id: "fake-model" },
    system: [{ type: "text" as const, text: "You are a coding agent working in a project for the user." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Read README.md and tell me what this project does." }] },
      { role: "assistant", content: [{ type: "text", text: "It is a small command line tool." }] },
      { role: "user", content: [{ type: "text", text: "Thanks. Now list its commands." }] },
    ],
    tools: {
      read: { description: "Reads a file", input: { type: "object" } },
      edit: { description: "Edits a file", input: { type: "object" } },
    },
    options: {},
    ...(hook === "compaction" ? { prompt: "Summarize the conversation for a continuation." } : {}),
  }
}

function lastCrash() {
  const text = fs.existsSync(crashes) ? fs.readFileSync(crashes, "utf8").trim() : ""
  if (text === "") return undefined
  const line = text.split("\n").at(-1) ?? ""
  try {
    const entry = JSON.parse(line) as { hook?: string; message?: string }
    return `${entry.hook ?? "?"}: ${entry.message ?? ""}`
  } catch {
    return line
  }
}
