// 설정 > 스킬 and MCP 서버 e2e backend (SM 2026-10-24; 03 §5.7, §18.14, §19.6.1). Run by this suite's Playwright
// webServer (playwright.config.ts) or by hand: `bun e2e/tools/backend.ts`.
//
// The real server from source with own-accounts and own-import (own-team off), booted by own-team's e2e harness
// (packages/own-team/test/e2e/harness.ts, read only) with `importer: true`. The other tools live in a fake home of this
// suite's temp folder, never this PC's:
//   - Codex (`.codex`): one skill (`release-notes`) and `config.toml` with an MCP server `codex-files` (the e2e kit's
//     fake stdio server, `bun <mcp-stdio.ts> read_file list_files`) that stores a fake token in `env`;
//   - Claude Code (`.claude.json`): `mcpServers` with `claude-notes` (the same fake server, `write_note`), `codex-twin`
//     (the very server Codex has as `codex-files` with another token, so the import shows them as one row whose values
//     differ), `api-keyed` (an address with a made-up key in its path) and an old SSE server `old-sse` (not importable).
// own-import's roots and own-accounts' `codexHome`/`claudeHome` name exactly these folders; own-accounts asks a fake
// MCP Registry (own-accounts' e2e kit, `mcpRegistry`), never the real one. One conversation in the project makes it
// the page's project. Fake values only; every listener binds 127.0.0.1. The backend removes the fake home and its
// state file when it stops (stdin closed, SIGINT, SIGTERM, or `<tmp>/stop`, which teardown.ts writes because
// Playwright hard-kills the web server on Windows); teardown.ts removes what is left.
//
// SK2 (2026-10-24), the skills import's design fixture (./skills.ts): pdf four times (three the same, one other with
// version 2.0.0), bundled copies, a fake codex-multi-provider control center with two accounts and one whose `skills` is
// a junction onto the default home's, a linked skill inside the skills area and one outside it, removed and
// half-installed folders, a Claude app synced folder and a skill whose SKILL.md is hostile markdown. The fake home is
// core's home too (`OPENCODE_TEST_HOME`), so core loads its `.claude/skills` as it loads the user's. 2026-10-25: a
// local probe host for the remote pictures of one skill's body, hostile bodies for the parse, and skills own's skills
// folder holds by hand with the same content as found ones.
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import { startFakeGitHub } from "../../../own-accounts/test/e2e-kit/fakes/github"
import { startFakeMcpRegistry } from "../../../own-accounts/test/e2e-kit/fakes/mcp-registry"
import { FAKE_MCP_STDIO } from "../../../own-accounts/test/e2e-kit/fakes/mcp-stdio"
import { REPO_ROOT } from "../../../own-accounts/test/e2e-kit/harness/opencode-server"
import { removeTree } from "../../../own-accounts/test/e2e-kit/harness/remove"
import { codexSkill, skillMd } from "../../../own-import/test/fixtures/skills"
import { ownSkills, skillsWorld } from "./skills"
import { MODEL, startTeamServer } from "../../../own-team/test/e2e/harness"
import { HOME, NAME, STATE_FILE, STOP_FILE, TOOLS_TMP } from "./paths"

export const TOOLS_PORT = Number(process.env.OWN_WEB_TOOLS_E2E_PORT ?? 6831)
/** The fake values the other tools' settings hold: the page, its requests and own's files must never show them. */
const TOKENS = {
  codex: "fake-codex-files-token-0000Zz9",
  claude: "fake-claude-notes-token-0000Yy8",
  path: "fakePathKey0000aaaa1111bbbb2222",
  /** GH (2026-10-31): two fake GitHub tokens the fake GitHub knows (설정 > GitHub, github.pw.ts). */
  githubWork: "ghp_fakeE2eWork7Kq2Lm9Np4Rt8Vx3Zc6Hb1",
  githubHome: "github_pat_11FAKEE2EHOME_fakeE2eHome3Jd8Ks5Lw2Qx7Rv4Ty9Mn6",
}

for (const entry of await fsp.readdir(TOOLS_TMP, { withFileTypes: true }).catch(() => []))
  if (entry.isDirectory() && entry.name.startsWith(`own-team-e2e-${NAME}-`))
    await fsp.rm(path.join(TOOLS_TMP, entry.name), { recursive: true, force: true }).catch(() => undefined)
await fsp.rm(HOME, { recursive: true, force: true })
await fsp.rm(STOP_FILE, { force: true })
const codex = path.join(HOME, ".codex")
const claude = path.join(HOME, ".claude")
await Promise.all([codex, claude].map((folder) => fsp.mkdir(folder, { recursive: true })))
await codexSkill(codex, "release-notes", {
  files: { "SKILL.md": skillMd("release-notes", "Writes release notes from the commit log") },
})
await Bun.write(
  path.join(codex, "config.toml"),
  [
    "[mcp_servers.codex-files]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(FAKE_MCP_STDIO)}, "read_file", "list_files"]`,
    "startup_timeout_sec = 20",
    "[mcp_servers.codex-files.env]",
    `FILES_TOKEN = "${TOKENS.codex}"`,
    "",
  ].join("\n"),
)
await Bun.write(
  path.join(HOME, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      "claude-notes": {
        command: process.execPath,
        args: [FAKE_MCP_STDIO, "write_note"],
        env: { NOTES_TOKEN: TOKENS.claude },
      },
      "codex-twin": {
        command: process.execPath,
        args: [FAKE_MCP_STDIO, "read_file", "list_files"],
        env: { FILES_TOKEN: "fake-other-files-token-0000Xx7" },
      },
      "api-keyed": { type: "http", url: `http://127.0.0.1:9/api/${TOKENS.path}/mcp` },
      "old-sse": { type: "sse", url: "http://127.0.0.1:9/sse" },
    },
  }),
)
const registry = startFakeMcpRegistry()
// GH (2026-10-31): a fake GitHub (its `/user`, its MCP server) for 설정 > GitHub; never github.com.
const github = startFakeGitHub({
  accounts: {
    [TOKENS.githubWork]: { login: "octo-work", scopes: "repo, read:org" },
    [TOKENS.githubHome]: { login: "octo-home", expiration: "2027-01-31 09:00:00 +0900" },
  },
})

// SK2 (2026-10-25): the local probe host the `pictures` skill's remote pictures point at. It counts what reaches it
// (path and Referer) and answers a 1×1 PNG; `GET /__probe` reads the count, `DELETE /__probe` clears it.
const PIXEL = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
)
const hits: { readonly path: string; readonly referer: string | null }[] = []
const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/__probe") {
      if (request.method === "DELETE") hits.splice(0)
      return Response.json({ hits })
    }
    hits.push({ path: url.pathname, referer: request.headers.get("referer") })
    return new Response(PIXEL, { headers: { "content-type": "image/png", "access-control-allow-origin": "*" } })
  },
})
const probeOrigin = `http://127.0.0.1:${probe.port}`

const world = await skillsWorld(HOME, codex, claude, probeOrigin)

const team = await startTeamServer({
  name: NAME,
  team: false,
  env: { OPENCODE_TEST_HOME: HOME },
  // Core's file watcher on, as in an installed service: a copied skill folder is loaded without a restart.
  watchConfig: true,
  importer: true,
  importOptions: { roots: { codex: [codex], claude: [claude] }, controlCenter: world.controlCenter },
  accountsOptions: {
    ratecardsSeed: path.join(REPO_ROOT, "own/config/ratecards.default.json"),
    codexHome: codex,
    claudeHome: HOME,
  },
  accountsEndpoints: { mcpRegistry: registry.url, ...github.endpoints },
})
const project = team.project
if (!project) throw new Error("the harness made no project")
const session = await team.createSession({ model: MODEL.deepseek, title: "도구 설정 시험" })

const password = atob(team.server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: team.server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: team.control,
})
// Skills own's skills folder holds by hand (no record): core loads them as it loads the user's.
await ownSkills(path.join(team.server.paths.config, "skills"))
const dev = await startViteDev({ port: TOOLS_PORT, hmr: false })

const state = {
  dev: `http://127.0.0.1:${TOOLS_PORT}`,
  control: team.control,
  ownHome: team.ownHome,
  project,
  session,
  /** The fake stdio MCP server and the program that runs it. */
  bun: process.execPath,
  script: FAKE_MCP_STDIO,
  tokens: TOKENS,
  codexConfig: path.join(codex, "config.toml"),
  /** The server's global config file (the harness turns project config files off). */
  configFile: team.configFile,
  registry: registry.url,
  /** own's skills folder (`<OPENCODE_CONFIG_DIR>/skills`), where imports land. */
  skillsDir: path.join(team.server.paths.config, "skills"),
  home: HOME,
  elsewhere: world.elsewhere,
  /** The local probe host of the `pictures` skill (SK2 2026-10-25). */
  probe: probeOrigin,
}
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev.ready()
console.log(`OWN_WEB_TOOLS_READY ${JSON.stringify({ dev: state.dev, project })}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await dev.close().catch(() => undefined)
  await team.stop()
  registry.stop()
  github.stop()
  probe.stop(true)
  await removeTree(HOME).catch(() => undefined)
  await fsp.rm(STATE_FILE, { force: true })
  await fsp.rm(STOP_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()
setInterval(() => {
  if (fs.existsSync(STOP_FILE)) void stop()
}, 300)
