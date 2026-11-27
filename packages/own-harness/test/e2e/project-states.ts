// What every harness reads from a repository in each of an SSH host's three project states (04 §5.6): `disabled`
// reads nothing, `instructions` the AGENTS.md files only, `trusted` everything. One real server per state (source
// plugins own-harness and own-omo, a fake OpenAI Responses provider, no account), started with exactly the variables
// own-remote's `serviceEnv` gives a host's service. A temp git repository holds marker files; a session per harness
// in `repo/sub` sends a prompt, makes one scripted read of `sub/deep/note.txt` and sends a second prompt, and the
// request bodies the provider received are searched for the markers.
//
// The states are three test files (`project-states-*.test.ts`) so they boot side by side. omo needs its built runtime
// (`bun run bundle` in packages/own-omo). Run from a path without '#' (OpenTUI's preload truncates paths at '#').
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  openAIResponsesProvider,
  opencodeConfig,
  removeTree,
  REPO_ROOT,
  startFakeOpenAIResponses,
  startOpencodeServer,
  type FakeOpenAIResponses,
  type OpencodeServer,
} from "../../../own-accounts/test/e2e-kit"
import { FAKE_MCP_STDIO } from "../../../own-accounts/test/e2e-kit/fakes/mcp-stdio"
import { Runtime } from "../../../own-omo/src/runtime.js"
import { RemoteModel } from "../../../own-remote/src/remote/model.js"

export type State = "disabled" | "instructions" | "trusted"

const MODEL = { providerID: "fake-a", id: "gpt-5.5" }
const HARNESSES: ReadonlyArray<OwnHarness.HarnessID> = ["opencode", "codex", "pi", "dsh", "omo", "claude-code"]
/** Core's `read` injects a folder's AGENTS.md after a read below it; pi, codex and dsh read with their own tools. */
const NESTED_READERS: ReadonlyArray<OwnHarness.HarnessID> = ["opencode", "omo", "claude-code"]
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
  { action: "read", resource: "**", effect: "allow" },
]

const M = {
  /** AGENTS.md of the repository root and of the session folder: discovery from the session folder upward. */
  upward: ["HPS_ROOT_AGENTS_MD", "HPS_SUB_AGENTS_MD"],
  /** AGENTS.md of a folder below the session folder: injected after a read there. */
  nested: "HPS_DEEP_AGENTS_MD",
  /** Never read by any harness in any state. */
  never: ["HPS_ROOT_CLAUDE_MD", "HPS_SUB_CLAUDE_MD", "HPS_HOME_CLAUDE_MD", "HPS_HOME_AGENTS_MD", "hps_dotmcp"],
  /** Project config: its `instructions` entry, the three skill roots (description and name) and its MCP tool. */
  project: [
    "HPS_PROJECT_CONFIG_INSTRUCTIONS",
    "HPS_SKILL_OPENCODE",
    "HPS_SKILL_CLAUDE",
    "HPS_SKILL_AGENTS",
    "hps-oc-skill",
    "hps-claude-skill",
    "hps-agents-skill",
    "hps_lookup",
    "hps-agent",
  ],
  /** The server's own home (global config folder, `~/.claude/skills`, `~/.agents/skills`): read in every state. */
  home: ["HPS_GLOBAL_AGENTS_MD", "HPS_SKILL_GLOBAL_CONFIG", "HPS_SKILL_HOME_CLAUDE", "HPS_SKILL_HOME_AGENTS"],
  note: "HPS_NOTE_CONTENT",
}

/** The project variables own-remote puts in a host's service env for `state` (and nothing else of it). */
function hostEnv(state: State) {
  // SAFETY: serviceEnv reads only `projectConfig` and `env` of the record and two folders of the paths.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const record = { projectConfig: state, env: {} } as unknown as Parameters<typeof RemoteModel.serviceEnv>[0]
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const paths = { ownHome: "/o", configDir: "/c" } as unknown as Parameters<typeof RemoteModel.serviceEnv>[1]
  return Object.fromEntries(
    Object.entries(RemoteModel.serviceEnv(record, paths)).filter(([key]) => key.startsWith("OPENCODE_CONFIG_PROJECT_")),
  )
}

/**
 * A root outside the user's profile. With project config on, core walks from the session folder to the drive root for
 * `.opencode`, `.claude` and `.agents`, and Windows' default temp folder is inside the profile: the walk would read the
 * developer's own skills and load their plugins.
 */
function scratch(state: State) {
  const temp = os.tmpdir()
  const inside = path.relative(os.homedir(), temp)
  const base = inside.startsWith("..") || path.isAbsolute(inside) ? temp : path.join(path.parse(temp).root, "t")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, `own-hps-${state}-`))
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function skill(dir: string, name: string, marker: string) {
  write(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker} skill description\n---\n\n${marker}_BODY\n`,
  )
}

/** The repository under test and the server's own home, with a marker in every file a harness could read. */
function fixture(paths: { workspace: string; config: string; home: string }) {
  const ws = paths.workspace
  write(path.join(ws, "AGENTS.md"), "HPS_ROOT_AGENTS_MD\n")
  write(path.join(ws, "CLAUDE.md"), "HPS_ROOT_CLAUDE_MD\n")
  write(path.join(ws, "sub", "AGENTS.md"), "HPS_SUB_AGENTS_MD\n")
  write(path.join(ws, "sub", "CLAUDE.md"), "HPS_SUB_CLAUDE_MD\n")
  write(path.join(ws, "sub", "deep", "AGENTS.md"), `${M.nested}\n`)
  write(path.join(ws, "sub", "deep", "note.txt"), `${M.note}\n`)
  write(path.join(ws, "HPS-EXTRA.md"), "HPS_PROJECT_CONFIG_INSTRUCTIONS\n")
  skill(path.join(ws, ".opencode", "skills"), "hps-oc-skill", "HPS_SKILL_OPENCODE")
  skill(path.join(ws, ".claude", "skills"), "hps-claude-skill", "HPS_SKILL_CLAUDE")
  skill(path.join(ws, ".agents", "skills"), "hps-agents-skill", "HPS_SKILL_AGENTS")
  write(
    path.join(ws, ".opencode", "commands", "hps-cmd.md"),
    "---\ndescription: HPS_COMMAND_DESC\n---\nSay HPS_COMMAND_BODY $ARGUMENTS\n",
  )
  write(
    path.join(ws, ".opencode", "agents", "hps-agent.md"),
    "---\ndescription: HPS_AGENT_DESC project subagent\nmode: subagent\n---\nHPS_AGENT_PROMPT\n",
  )
  // Repository code, as RG17's probe (04 §20.3): it records that it ran and what it could see of a model request.
  write(
    path.join(ws, ".opencode", "plugins", "hps-plugin.ts"),
    [
      'import fs from "node:fs"',
      'const log = (entry) => fs.appendFileSync(process.env.HPS_CODE_LOG, JSON.stringify(entry) + "\\n")',
      "export default {",
      '  id: "hps-probe-plugin",',
      "  async setup(ctx) {",
      '    log({ event: "loaded" })',
      '    await ctx.session.hook("http.request", async (event) => {',
      '      log({ event: "http.request", auth: event.request.headers.has("authorization") })',
      "    })",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  write(
    path.join(ws, "opencode.jsonc"),
    JSON.stringify(
      {
        instructions: ["HPS-EXTRA.md"],
        mcp: { servers: { hpsmcp: { type: "local", command: [process.execPath, FAKE_MCP_STDIO, "hps_lookup"] } } },
      },
      null,
      2,
    ),
  )
  write(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { hpsdot: { command: process.execPath, args: [FAKE_MCP_STDIO, "hps_dotmcp"] } } }),
  )
  Bun.spawnSync(["git", "init", "-q"], { cwd: ws })
  write(path.join(paths.config, "AGENTS.md"), "HPS_GLOBAL_AGENTS_MD\n")
  skill(path.join(paths.config, "skills"), "hps-global-skill", "HPS_SKILL_GLOBAL_CONFIG")
  skill(path.join(paths.home, ".claude", "skills"), "hps-home-claude-skill", "HPS_SKILL_HOME_CLAUDE")
  skill(path.join(paths.home, ".agents", "skills"), "hps-home-agents-skill", "HPS_SKILL_HOME_AGENTS")
  write(path.join(paths.home, ".claude", "CLAUDE.md"), "HPS_HOME_CLAUDE_MD\n")
  write(path.join(paths.home, "AGENTS.md"), "HPS_HOME_AGENTS_MD\n")
}

export function projectStates(state: State) {
  const reads = state !== "disabled"
  const trusted = state === "trusted"
  const root = scratch(state)
  const codeLog = path.join(root, "repo-code.log")
  /** One scripted tool call per session key: the first request naming the key gets it, later ones a text. */
  const plans = new Map<string, { name: string; input: Record<string, unknown> }>()
  const seen = new Map<string, number>()
  const ctx = {} as { fake: FakeOpenAIResponses; server: OpencodeServer }

  beforeAll(async () => {
    // A source run loads the omo runtime from `own/.out/omo`, built by hand: one built before OMO-P9 reads project
    // skills in every state, and the omo cases would fail as if the gate were wrong (2.2.6-own.12's tier, RL21-T).
    const runtime = Runtime.locate()
    if (!fs.readFileSync(runtime, "utf8").includes("OMO_OWN_PROJECT_SKILLS"))
      throw new Error(`${runtime} was built before OMO-P9: run \`bun run bundle\` in packages/own-omo`)
    ctx.fake = startFakeOpenAIResponses({
      models: ["gpt-5.5"],
      responder: (request) => {
        const key = [...plans.keys()].find((candidate) => request.body.includes(candidate))
        if (key === undefined) return undefined
        const count = seen.get(key) ?? 0
        seen.set(key, count + 1)
        const plan = plans.get(key)!
        if (count === 0) return { type: "tool-call", name: plan.name, input: plan.input }
        return { type: "text", text: `ok ${count}` }
      },
    })
    ctx.server = await startOpencodeServer({
      root,
      startupTimeoutMs: 280_000,
      // The kit's switch on (it sets core's older variable); the host variables below decide, as on a host.
      projectConfig: true,
      env: {
        OWN_OPEN_CODE: "1",
        // The server's home for everything: `~/.claude` and `~/.agents` of this PC stay out.
        USERPROFILE: path.join(root, "home"),
        HPS_CODE_LOG: codeLog,
        ...hostEnv(state),
      },
      config: (paths) => {
        fixture(paths)
        return opencodeConfig({
          providers: {
            "fake-a": openAIResponsesProvider(ctx.fake, {
              apiKey: "fake-key-a",
              models: { "gpt-5.5": { name: "gpt-5.5" } },
            }),
          },
          model: "fake-a/gpt-5.5",
          plugins: [
            { package: path.join(import.meta.dir, "fixtures/cache-verdict"), options: {} },
            { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
            { package: path.join(REPO_ROOT, "packages/own-omo"), options: {} },
          ],
        })
      },
    })
    await ctx.server.waitForModels([MODEL])
  }, 400_000)

  afterAll(async () => {
    await ctx.server?.stop()
    await ctx.fake?.stop()
    if (process.env.OWN_E2E_KEEP !== "1") await removeTree(root)
  }, 120_000)

  const sub = () => path.join(ctx.server.paths.workspace, "sub")

  /** A session of `harness` in `repo/sub` that runs `plan` on its first request, then a second prompt; its requests. */
  async function run(harness: OwnHarness.HarnessID, tag: string, plan: { name: string; input: Record<string, unknown> }) {
    const key = `HPSKEY-${state}-${tag}-x`
    plans.set(key, plan)
    const created = (await ctx.server.call("POST", "/api/session", {
      body: {
        title: `hps ${tag}`,
        model: MODEL,
        location: { directory: sub() },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
        permissions: FULL,
      },
    })) as { data: { id: string } }
    const sessionID = created.data.id
    // own.harness writes the session's tool gate after `session.created`.
    await Bun.sleep(3_000)
    const done = { value: false }
    const approving = (async () => {
      while (!done.value) {
        const body = (await ctx.server
          .call("GET", `/api/session/${sessionID}/permission`)
          .catch(() => ({ data: [] }))) as { data?: Array<Record<string, unknown>> }
        await Promise.all(
          (body.data ?? []).map((request) =>
            ctx.server
              .call("POST", `/api/session/${sessionID}/permission/${String(request.id)}/reply`, {
                body: { decision: "once" },
              })
              .catch(() => undefined),
          ),
        )
        await Bun.sleep(150)
      }
    })()
    const before = ctx.fake.requests.length
    await ctx.server.prompt(sessionID, `${key} first: read the note`)
    await ctx.server.waitIdle(sessionID)
    await ctx.server.prompt(sessionID, `${key} second: anything else`)
    await ctx.server.waitIdle(sessionID)
    done.value = true
    await approving
    return ctx.fake.requests
      .slice(before)
      .filter((request) => request.method === "POST" && request.body.includes(key))
      .map((request) => request.body)
  }

  const note = () => path.join(ctx.server.paths.workspace, "sub", "deep", "note.txt")
  const readPlan = (harness: OwnHarness.HarnessID) => {
    if (harness === "codex") return { name: "exec_command", input: { cmd: "cat deep/note.txt" } }
    if (harness === "dsh") return { name: "read", input: { file_path: note() } }
    return { name: "read", input: { path: note() } }
  }

  describe(`project state ${state}: what each harness reads from the repository`, () => {
    test("the service env is the host's", () => {
      expect(hostEnv(state)).toEqual(
        {
          disabled: { OPENCODE_CONFIG_PROJECT_DISABLE: "1" },
          instructions: { OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_CONFIG_PROJECT_INSTRUCTIONS: "1" },
          trusted: {},
        }[state],
      )
    })

    for (const harness of HARNESSES) {
      test(`${harness}`, async () => {
        const bodies = await run(harness, harness, readPlan(harness))
        expect(bodies.length).toBeGreaterThanOrEqual(2)
        const first = bodies[0]!
        const all = bodies.join("\n")
        // The scripted read ran: its result is in a later request.
        expect(all).toContain(M.note)
        // Upward discovery, from the first request on.
        for (const marker of M.upward) expect([marker, first.includes(marker)]).toEqual([marker, reads])
        // A folder below the session folder: never before the read, afterwards only through core's read.
        expect(first).not.toContain(M.nested)
        expect([M.nested, all.includes(M.nested)]).toEqual([M.nested, reads && NESTED_READERS.includes(harness)])
        for (const marker of M.never) expect([marker, all.includes(marker)]).toEqual([marker, false])
        for (const marker of M.project) expect([marker, all.includes(marker)]).toEqual([marker, trusted])
        for (const marker of M.home) expect([marker, first.includes(marker)]).toEqual([marker, true])
      }, 300_000)
    }

    // omo finds skills by itself, beside core's list (OMO-P9): its task tool loads a project skill's body into the
    // child's prompt only where project config is read.
    test("omo task(load_skills): a project skill's body reaches the child only when trusted", async () => {
      const bodies = await run("omo", "omo-task", {
        name: "task",
        input: {
          subagent_type: "explore",
          load_skills: ["hps-oc-skill", "hps-agents-skill"],
          description: "probe child",
          prompt: `HPSKEY-${state}-omo-task-x child: say ok`,
          run_in_background: false,
        },
      })
      const all = bodies.join("\n")
      for (const marker of ["HPS_SKILL_OPENCODE_BODY", "HPS_SKILL_AGENTS_BODY"])
        expect([marker, all.includes(marker)]).toEqual([marker, trusted])
      if (!trusted) expect(all).toContain("Skills not found")
    }, 300_000)

    test("commands, agents, skills and MCP of the repository are listed only when trusted", async () => {
      const listed = async (route: string, marker: string) => {
        const deadline = Date.now() + (trusted ? 60_000 : 0)
        for (;;) {
          const text = JSON.stringify(await ctx.server.call("GET", route, { directory: sub() }).catch(String))
          if (text.includes(marker) || Date.now() >= deadline) return [route, marker, text.includes(marker)]
          await Bun.sleep(1_000)
        }
      }
      for (const [route, marker] of [
        ["/api/skill", "HPS_SKILL_OPENCODE"],
        ["/api/skill", "HPS_SKILL_CLAUDE"],
        ["/api/skill", "HPS_SKILL_AGENTS"],
        ["/api/command", "HPS_COMMAND_DESC"],
        ["/api/agent", "HPS_AGENT_DESC"],
        ["/api/mcp", "hpsmcp"],
      ] as const)
        expect(await listed(route, marker)).toEqual([route, marker, trusted])
      // The server's own home is listed in every state.
      expect(await listed("/api/skill", "HPS_SKILL_GLOBAL_CONFIG")).toEqual(["/api/skill", "HPS_SKILL_GLOBAL_CONFIG", true])
    }, 180_000)

    // RG17's question for every state (04 §20.3): repository code that never runs sees no request and no credential.
    test("repository code runs only when trusted: off and instructions-only never load the plugin", () => {
      const entries = fs.existsSync(codeLog)
        ? fs
            .readFileSync(codeLog, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { event: string; auth?: boolean })
        : []
      if (!trusted) {
        expect(entries).toEqual([])
        return
      }
      // The probe works where it is allowed to load, so its silence in the other states means it never ran.
      expect(entries.some((entry) => entry.event === "loaded")).toBe(true)
      expect(entries.some((entry) => entry.event === "http.request")).toBe(true)
    })
  })
}
