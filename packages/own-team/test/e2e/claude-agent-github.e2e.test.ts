// A team area owner on the Claude Agent provider (fake claude) whose area folder has a GitHub account pinned (16 §3.2,
// 02 §8.10; the MR9 review's scratch test, kept): what the GitHub connection promises holds on the Claude Agent route.
// - A GitHub write the owner makes (`mcp__opencode__execute` → `tools.github.create_pull_request`) asks first, and runs
//   once as the pinned account after the user's answer.
// - The area's shells get the pinned account's git login (own's credential helper through `GIT_CONFIG_*`); a token a
//   shell prints is cut out of the owner's history.
// - A token the user typed never reaches claude unmasked: neither the primary request nor a one-off `generate` (`POST
//   /api/session/:id/generate`), which the Claude Agent route writes as a forked transcript into the account's shared
//   projects folder (the review's finding: GitHub's backstop covered only `context` and `compaction`).
// The token is looked for in every file under the Claude Agent folders (the shared transcripts, the account folder and
// the fake's log of what it received), while the side call runs too: its fork is removed when it ends.
//
// Fake GitHub, fake claude and fake tokens only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { startFakeGitHub, type FakeGitHub } from "../../../own-accounts/test/e2e-kit/fakes/github.js"
import {
  BOOT_TIMEOUT,
  CLAUDE_AGENT,
  MODEL,
  claudeAgentFolder,
  claudeAgentTranscripts,
  enableTeam,
  messages,
  opEnd,
  permissions,
  reply,
  startTeamServer,
  waitValue,
  type TeamServer,
} from "./harness.js"

const STEP_TIMEOUT = 300_000
const TOKEN = "ghp_mv9TeamTok7Q2x9Lp4Rz8Tn6Vb1Mk3WyZ0"
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
const state: { server?: TeamServer; github?: FakeGitHub; owner?: string; area?: string; account?: string } = {}

beforeAll(async () => {
  state.github = startFakeGitHub({ accounts: { [TOKEN]: { login: "octo-team", scopes: "repo" } } })
  const server = await startTeamServer({
    name: "claude-agent-github",
    claudeAgent: true,
    accountsEndpoints: state.github.endpoints,
  })
  state.server = server
  const viewed = await server.createSession({ model: MODEL["01"], title: "팀 대화" })
  const enabled = await enableTeam(server, { hint: "[propose-areas 1]", sessionID: viewed })
  const team = enabled.view.team!
  const changed = await server.team("area.main", { teamID: team.id, areaID: AREA_1, model: CLAUDE_AGENT.model })
  await opEnd(server, changed.opID!)
  const area = (await server.team("team.get", { directory: server.project! })).areas.find((item) => item.id === AREA_1)!
  state.area = area.directory
  state.owner = area.owner.sessionID!
  const added = await server.accounts("github.add.token", { token: TOKEN, label: "팀", write: true })
  state.account = (added.accounts as Array<{ id: string }>)[0]!.id
  await server.accounts("github.bind", { target: { type: "project", directory: area.directory }, account: state.account })
}, BOOT_TIMEOUT + 600_000)

afterAll(async () => {
  await state.server?.stop()
  state.github?.stop()
}, 120_000)

describe("claude-agent-github: a Claude Agent owner with a GitHub account pinned to its area", () => {
  test(
    "a GitHub write from the Claude Agent owner asks, and runs as the pinned account once allowed",
    async () => {
      const server = state.server!
      const owner = state.owner!
      // The area's Location reads the account's tool list in the background.
      await server.turn(owner, "준비해 주세요")
      await waitValue(async () => (offered(server, state.area!) ? true : undefined), "github tools never offered", 120_000)
      const from = state.github!.mcp.length
      await server.server.prompt(owner, `[github create_pull_request {"owner":"octo","repo":"hello","title":"Fix"}]`)
      const asked = await waitValue(async () => {
        const list = await permissions(server, owner)
        return list.find((item) => item.action === "github.write")
      }, "the write never asked", 120_000)
      expect(asked.resources).toEqual([`create_pull_request octo/hello as octo-team (${state.account})`])
      expect(created(from)).toEqual([])
      await reply(server, owner, String(asked.id), "once")
      await server.server.waitIdle(owner)
      expect(created(from).map((call) => call.login)).toEqual(["octo-team"])
    },
    STEP_TIMEOUT,
  )

  test(
    "the area's shell gets the pinned account's git login; a token a shell prints is masked",
    async () => {
      const server = state.server!
      const owner = state.owner!
      await answered(server, owner, `[shell git config --get-regexp "credential.*"]`)
      // The command holds the token reversed, so neither the prompt nor the call carries it; the output does.
      const reversed = [...TOKEN].toReversed().join("")
      await answered(server, owner, `[shell bun -e "console.log('${reversed}'.split('').reverse().join(''))"]`)
      const replies = JSON.stringify((await messages(server, owner)).filter((message) => message.type !== "user"))
      expect(replies).toContain("OWN_GITHUB_CREDENTIAL")
      expect(replies).toContain("••••")
      expect(replies.includes(TOKEN)).toBe(false)
      expect(holders(server)).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "a token the user typed: masked in the primary request and in a generate side call's forked transcript",
    async () => {
      const server = state.server!
      const owner = state.owner!
      await server.turn(owner, `토큰은 ${TOKEN} 이에요. 기억만 하세요.`)
      expect(holders(server)).toEqual([])
      // The side call's forked transcript is removed when the call ends: look while it runs.
      const seen = new Set<string>()
      const watch = setInterval(() => {
        for (const file of holders(server)) seen.add(file)
      }, 15)
      const generated = await server.server
        .call("POST", `/api/session/${owner}/generate`, { body: { prompt: "지금까지를 한 줄로 요약해 주세요" } })
        .finally(() => clearInterval(watch))
      expect(JSON.stringify(generated)).toContain("text")
      // The side call reached claude: it asked on a fork of the owner's conversation.
      expect(received(server).some((line) => line.includes("지금까지를 한 줄로 요약해 주세요"))).toBe(true)
      expect([...seen, ...holders(server)]).toEqual([])
    },
    STEP_TIMEOUT,
  )
})

/** The fake GitHub's `create_pull_request` calls since `from`. */
function created(from: number) {
  return state.github!.mcp.slice(from).filter((call) => call.tool === "create_pull_request")
}

/** Every file under the Claude Agent folders (shared transcripts, account folder, the fake's log) holding the token. */
function holders(server: TeamServer) {
  return [claudeAgentTranscripts(server.ownHome), claudeAgentFolder(server.ownHome)].flatMap((root) =>
    listed(root).flatMap((name) => {
      const file = path.join(root, name)
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return []
      return readText(file).includes(TOKEN) ? [file] : []
    }),
  )
}

/** The lines the fake claude logged as received (`fake-claude.jsonl` in the account folder). */
function received(server: TeamServer) {
  return readText(path.join(claudeAgentFolder(server.ownHome), "fake-claude.jsonl"))
    .split(/\r?\n/)
    .filter((line) => line.includes('"kind":"in"'))
}

// A transcript may be removed between the listing and the read (the side call's fork ends): read what is there.
function listed(root: string) {
  try {
    return fs.readdirSync(root, { recursive: true }).map(String)
  } catch {
    return []
  }
}

function readText(file: string) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** Whether own-accounts logged the GitHub tools offered at `directory`. */
function offered(server: TeamServer, directory: string) {
  const want = JSON.stringify(path.resolve(directory)).slice(1, -1).toLowerCase()
  return readText(path.join(server.ownHome, "logs", "own-accounts.log"))
    .split(/\r?\n/)
    .some((line) => line.includes("github_tools_offered") && line.toLowerCase().includes(want))
}

/** A turn whose permission questions (a shell the team does not allow by itself) are answered `once`. */
async function answered(server: TeamServer, sessionID: string, text: string) {
  await server.server.prompt(sessionID, text)
  const turn = { done: false }
  const idle = server.server.waitIdle(sessionID).then(() => {
    turn.done = true
  })
  while (!turn.done) {
    for (const item of await permissions(server, sessionID)) await reply(server, sessionID, String(item.id), "once")
    await Bun.sleep(300)
  }
  await idle
}
