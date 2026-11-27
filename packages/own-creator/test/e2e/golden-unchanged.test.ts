// Cache regression guard for own-creator (own/docs/17 §5.6): with own-creator loaded and no extension in force, the
// first request of an `opencode`, `codex`, `pi` and `dsh` session is byte for byte own-omo's golden of it
// (packages/own-omo/test/golden/unchanged, recorded before own-omo and own-creator). Three variants: an empty store,
// an extension that is turned off, and an extension limited to another project folder. Creator mode's agent, tools and
// skills never show in these (non-creator) sessions. Core's environment block names the platform, so the goldens are
// per platform (Windows recorded). Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  deepseekProvider,
  opencodeConfig,
  REPO_ROOT,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { CreatorStore } from "../../src/store.js"

const BOOT_TIMEOUT = 560_000
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const HARNESSES = ["opencode", "codex", "pi", "dsh"] as const
const GOLDEN = path.join(REPO_ROOT, "packages", "own-omo", "test", "golden", "unchanged")

/** An extension with an item of every kind that changes a request. */
const PROBE = {
  format: "own.ext/1",
  id: "golden-probe",
  title: "Golden probe",
  items: [
    { type: "prompt.fragment", id: "probe", text: "GOLDEN-PROBE fragment" },
    { type: "tool.command", name: "probe", description: "Probe", command: "echo probe" },
    { type: "tool.command", name: "probe_direct", description: "Probe", command: "echo probe", direct: true },
    { type: "skill", name: "golden-probe-skill", description: "Probe skill", content: "Probe" },
    { type: "agent", name: "golden-probe-agent", description: "Probe agent", mode: "subagent", prompt: "Probe" },
  ],
}

const VARIANTS = ["empty store", "extension turned off", "extension in another project"] as const

/** Writes the store a variant starts with, before the server boots. */
async function prepare(variant: (typeof VARIANTS)[number], home: string, elsewhere: string) {
  if (variant === "empty store") return
  const store = new CreatorStore.Store(home)
  const created = await store.create(PROBE, "user")
  if (!created.ok) throw new Error(JSON.stringify(created))
  if (variant === "extension turned off") await store.enable(PROBE.id, false, "user")
  if (variant === "extension in another project") {
    fs.mkdirSync(elsewhere, { recursive: true })
    const scoped = await store.scope(PROBE.id, [elsewhere], "user")
    if (!scoped.ok) throw new Error(JSON.stringify(scoped))
  }
}

/**
 * What differs between any two runs or PCs: the workspace path, the temporary folder, dates, times, the skill lists and
 * codex's skill roots outside the test (`testRoots`).
 */
function normalize(body: unknown, workspace: string) {
  const escaped = JSON.stringify(workspace).slice(1, -1)
  const text = JSON.stringify(body)
    // dsh quotes the folder inside its text, so it is escaped twice there.
    .replaceAll(JSON.stringify(escaped).slice(1, -1), "<WORKSPACE>")
    .replaceAll(escaped, "<WORKSPACE>")
    .replaceAll(workspace.replace(/\\/g, "/"), "<WORKSPACE>")
    .replaceAll(JSON.stringify(os.tmpdir()).slice(1, -1), "<TEMP>")
    .replace(/Today's date: [^\\]+/g, "Today's date: <DATE>")
    .replace(/<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/g, "<current_date>DATE</current_date>")
    // dsh's per-step clock.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/g, "<TIME>")
    .replace(/<available_skills>.*?<\/available_skills>/g, "<available_skills>\\n<SKILLS>\\n</available_skills>")
    // Core's shell tool names the shell it found (`SHELL`, else Git Bash or pwsh): it depends on where the test runs.
    .replace(/Commands run on (\w+) using (?:bash|pwsh|powershell|cmd|sh|zsh)\./g, "Commands run on $1 using <SHELL>.")
  return JSON.parse(text, (_key, value: unknown) => (typeof value === "string" ? testRoots(value) : value)) as unknown
}

/**
 * Codex's skill roots with only the test's own: core also walks up from the workspace for `.agents/skills`, so a
 * temporary folder under the user's profile adds the user's skills (`C:/Users/<user>/.agents/skills`). Roots outside
 * the workspace other than the built-in `/` are left out with their skills, and the rest are numbered again.
 */
function testRoots(text: string) {
  return text.replace(
    /(### Skill roots\n)((?:- `r\d+` = `[^`]*`\n)+)(### Available skills\n)((?:- .*\n)*)/g,
    (_match, rootsHeading: string, roots: string, skillsHeading: string, skills: string) => {
      const kept = [...roots.matchAll(/- `(r\d+)` = `([^`]*)`\n/g)].filter(
        // The built-in skills: in-memory `skill://<id>/SKILL.md` since upstream v2.2.6 (69269e4ebe), `/builtin/<id>.md` before.
        (root) => root[2] === "skill:/" || root[2] === "/" || root[2]!.startsWith("<WORKSPACE>"),
      )
      const renamed = new Map(kept.map((root, index) => [root[1]!, `r${index}`]))
      return [
        rootsHeading,
        ...kept.map((root) => `- \`${renamed.get(root[1]!)}\` = \`${root[2]}\`\n`),
        skillsHeading,
        ...skills.split(/(?<=\n)/).flatMap((line) => {
          const root = /\(file: (r\d+)\//.exec(line)?.[1]
          const name = root === undefined ? undefined : renamed.get(root)
          return name === undefined ? [] : [line.replace(`(file: ${root}/`, `(file: ${name}/`)]
        }),
      ].join("")
    },
  )
}

for (const variant of VARIANTS) {
  describe(`first requests own-creator must not change (${variant})`, () => {
    let fake: FakeOpenAIChat
    let server: OpencodeServer
    let root: string

    beforeAll(async () => {
      fake = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
      // The store is written before the boot, in the root the server then uses (`own-home` is the kit's OWN_HOME).
      root = fs.mkdtempSync(path.join(os.tmpdir(), "own-creator-golden-"))
      await prepare(variant, path.join(root, "own-home"), path.join(root, "elsewhere"))
      server = await startOpencodeServer({
        root,
        startupTimeoutMs: 540_000,
        projectConfig: true,
        env: { OWN_OPEN_CODE: "1" },
        config: (paths) => {
          fs.mkdirSync(paths.workspace, { recursive: true })
          fs.writeFileSync(path.join(paths.workspace, "AGENTS.md"), "Answer in one short sentence.\n")
          Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
          return opencodeConfig({
            providers: {
              "fake-ds": deepseekProvider(fake, {
                apiKey: "fake-key-ds",
                models: {
                  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", limit: { context: 1_000_000, output: 393_216 } },
                },
              }),
            },
            plugins: [
              { package: path.join(REPO_ROOT, "packages/own-harness/test/e2e/fixtures/cache-verdict"), options: {} },
              { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
              { package: path.join(REPO_ROOT, "packages/own-creator"), options: { home: paths.ownHome } },
            ],
          })
        },
      })
      await server.waitForModels([MODEL])
    }, BOOT_TIMEOUT)

    afterAll(async () => {
      await server?.stop()
      await fake?.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }, 60_000)

    /** The first request of a new session of `harness` for one prompt. */
    async function first(harness: OwnHarness.HarnessID, text: string) {
      const created = (await server.call("POST", "/api/session", {
        body: {
          title: "unchanged",
          model: MODEL,
          location: { directory: server.paths.workspace },
          metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
          permissions: FULL,
        },
      })) as { data: { id: string } }
      fake.enqueue({ type: "text", text: "done" })
      const before = fake.requests.length
      await server.prompt(created.data.id, text)
      await server.waitIdle(created.data.id)
      return fake.requests
        .slice(before)
        .filter((request) => request.method === "POST")
        .map((request) => request.json)
        .find((body) => JSON.stringify(body).includes(text))
    }

    test("own.creator is loaded and reads the store", async () => {
      const response = await server.request("POST", "/api/rpc/own.creator/list", {
        body: { input: {} },
        query: { "location[directory]": server.paths.workspace },
      })
      const output = ((await response.json()) as { output?: { extensions: Array<{ status: string }> } }).output
      expect(output?.extensions.map((item) => item.status)).toEqual(
        variant === "empty store" ? [] : variant === "extension turned off" ? ["disabled"] : ["active"],
      )
    })

    for (const harness of HARNESSES)
      test(
        harness,
        async () => {
          const body = await first(harness, `unchanged ${harness} request`)
          expect(body).toBeDefined()
          const golden = JSON.parse(fs.readFileSync(path.join(GOLDEN, `${harness}.${process.platform}.json`), "utf8"))
          expect(normalize(body, server.paths.workspace)).toEqual(golden)
        },
        120_000,
      )
  })
}
