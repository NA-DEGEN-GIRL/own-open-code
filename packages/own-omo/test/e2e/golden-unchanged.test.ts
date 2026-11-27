// Cache regression guard (own/docs/15 §8): the first request of an `opencode`, `codex`, `pi` and `dsh` session, byte
// for byte as it was before own-omo. The goldens (test/golden/unchanged/) were recorded from main 2904b08d7b without
// own-omo, with OWN_UPDATE_GOLDEN=1; this test then runs the same sessions with own-omo loaded and enabled, and again
// with `enabled: false`. Core's environment block names the platform, so the goldens are per platform (Windows
// recorded). The omo runtime must be built first (`bun script/bundle.ts`; OWN_OMO_RUNTIME_DIR, else own/.out/omo).
// Run from a path without '#' (OpenTUI's preload truncates paths at '#').
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

const BOOT_TIMEOUT = 180_000
const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const HARNESSES = ["opencode", "codex", "pi", "dsh"] as const
const RECORD = process.env.OWN_UPDATE_GOLDEN === "1"

/** own-harness as the release loads it, after own-harness's verdict fixture; own-omo after own-harness (own-remote bundle order). */
function plugins(omo: { enabled: boolean } | undefined) {
  return [
    { package: path.join(REPO_ROOT, "packages/own-harness/test/e2e/fixtures/cache-verdict"), options: {} },
    { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
    ...(omo === undefined ? [] : [{ package: path.join(REPO_ROOT, "packages/own-omo"), options: omo }]),
  ]
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
 * the workspace other than the built-in skills' root (`skill:/`, `/` before v2.2.6) are left out with their skills, and the
 * rest are numbered again.
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

for (const variant of RECORD ? [undefined] : [{ enabled: true }, { enabled: false }]) {
  describe(`first requests own-omo must not change (${variant === undefined ? "recording" : `own-omo enabled: ${variant.enabled}`})`, () => {
    let fake: FakeOpenAIChat
    let server: OpencodeServer

    beforeAll(async () => {
      fake = startFakeOpenAIChat({ models: ["deepseek-v4-pro"] })
      server = await startOpencodeServer({
        startupTimeoutMs: 170_000,
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
            plugins: plugins(variant),
          })
        },
      })
      await server.waitForModels([MODEL])
    }, BOOT_TIMEOUT)

    afterAll(async () => {
      await server?.stop()
      await fake?.stop()
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

    for (const harness of HARNESSES)
      test(harness, async () => {
        const golden = path.join(import.meta.dir, "..", "golden", "unchanged", `${harness}.${process.platform}.json`)
        const body = await first(harness, `unchanged ${harness} request`)
        expect(body).toBeDefined()
        const normalized = normalize(body, server.paths.workspace)
        if (RECORD) {
          fs.mkdirSync(path.dirname(golden), { recursive: true })
          fs.writeFileSync(golden, `${JSON.stringify(normalized, null, 2)}\n`)
        }
        expect(normalized).toEqual(JSON.parse(fs.readFileSync(golden, "utf8")))
      }, 120_000)
  })
}
