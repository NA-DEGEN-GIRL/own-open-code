// Two Claude Agent accounts on a real server (02 §8.10 phase 2, CAG): own-accounts links both folders' `projects` to the
// shared transcript folder and binds each conversation tree (and each team, 07 R4) to one account; only the user moves
// it (`claudeAgent.session.set`), never a limit. The fake `claude` (`fake-claude.ts`) runs under each account's folder
// (its log, `fake-claude.jsonl`, is that folder's), keeps its transcripts where Claude Code does, and reports plan
// limits like Claude Code on a subscription.
//
// - A conversation moves to the other account by hand: claude starts on the other folder and resumes the same Claude
//   conversation from the shared transcript (`--resume`, only the new text sent, no catch-up).
// - A refused five-hour window marks the account; nothing moves the conversation.
// - An idle account's plan windows are read with a claude that sends no prompt.
// - A transcript link that points elsewhere is repaired before the request; one that cannot be repaired (a file) fails
//   the turn and says why.
// - The folder screen lists both routes; a move needs claude-auth with several accounts.
// - A team runs on one Claude Agent account; moving its owner moves the team, and the owner resumes on the other one.
// - A conversation saved under a `[1m]` id Claude Code no longer lists (2.1.311) runs on the model without it.
// - Every claude of an account (login checks, chats, usage reads) names that folder's own Anthropic profile directory,
//   never the PC's (core P-045).
//
// Fake credentials only; nothing reaches a real `claude` or account; every listener binds 127.0.0.1. Run from a path
// without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnAccounts, OwnTeam } from "@own/protocol"
import { LIMIT_REJECTED, USAGE_FILE, readLog, type LogLine } from "./fake-claude.js"
import {
  BOOT_TIMEOUT,
  CLAUDE_AGENT,
  CLAUDE_AGENT_B,
  MODEL,
  claudeAgentFolder,
  claudeAgentTranscripts,
  enableTeam,
  messages,
  opEnd,
  startTeamServer,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { kv } from "./inspect.js"

const STEP_TIMEOUT = 300_000
const AREA_1 = OwnTeam.AreaID.make("ar_area-1")
const PROVIDER_PLUGIN = "opencode.provider.claude-agent"
const A = CLAUDE_AGENT.accountID
const B = CLAUDE_AGENT_B.accountID

describe("claude-agent accounts: two Claude Agent accounts, switched by hand (fake claude)", () => {
  const state: { server?: TeamServer; session?: string } = {}

  beforeAll(async () => {
    state.server = await startTeamServer({ name: "claude-agent-accounts", claudeAgent: 2 })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
  }, 120_000)

  test(
    "claude-agent accounts: both folders' projects link to the one shared transcript folder",
    async () => {
      const server = required(state.server)
      const status = await server.accounts("claudeAgent.status")
      expect(listOf(status.accounts).map((item) => [item.accountID, item.default])).toEqual([
        [A, true],
        [B, false],
      ])
      for (const accountID of [A, B]) {
        const link = path.join(claudeAgentFolder(server.ownHome, accountID), "projects")
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
        expect(fs.realpathSync(link)).toBe(fs.realpathSync(claudeAgentTranscripts(server.ownHome)))
      }
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: a conversation moves to the other account by hand and resumes the same Claude conversation",
    async () => {
      const server = required(state.server)
      const directory = required(server.project)
      const session = await server.createSession({ model: CLAUDE_AGENT.model, title: "두 계정" })
      state.session = session
      await server.turn(session, "첫 질문이에요")
      const claude = conversationOf(server, session)
      expect(spawnsOf(server, A, claude).map((line) => line.args)).toEqual([
        expect.arrayContaining([`--session-id=${claude}`]),
      ])
      expect(await server.accounts("claudeAgent.session.get", { sessionID: session }, directory)).toEqual({
        accountID: A,
        bound: true,
      })

      const moved = await server.accounts("claudeAgent.session.set", { sessionID: session, accountID: B }, directory)
      expect(moved).toEqual({ accountID: B, sessions: [session] })
      await server.turn(session, "둘째 질문이에요")

      // The same Claude conversation, resumed by a claude on B's folder from the shared transcript: only the new text
      // goes in, no catch-up text.
      expect(conversationOf(server, session)).toBe(claude)
      const resumed = spawnsOf(server, B, claude)
      expect(resumed).toHaveLength(1)
      expect(resumed[0]!.args).toContain(`--resume=${claude}`)
      const texts = userTexts(logOf(server, B).filter((line) => line.pid === resumed[0]!.pid))
      expect(texts).toEqual(["둘째 질문이에요"])
      expect(texts.join("\n")).not.toContain("<conversation-checkpoint>")
      const transcript = fs
        .readdirSync(claudeAgentTranscripts(server.ownHome), { recursive: true })
        .map(String)
        .find((name) => name.endsWith(`${claude}.jsonl`))
      const lines = fs.readFileSync(path.join(claudeAgentTranscripts(server.ownHome), required(transcript)), "utf8")
      expect(lines).toContain("첫 질문이에요")
      expect(lines).toContain("둘째 질문이에요")
      // New conversations start on the account chosen last.
      const status = await server.accounts("claudeAgent.status")
      expect(listOf(status.accounts).find((item) => item.default)?.accountID).toBe(B)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: a refused five-hour window marks the account, and nothing moves the conversation",
    async () => {
      const server = required(state.server)
      const directory = required(server.project)
      const session = required(state.session)
      await server.turn(session, `${LIMIT_REJECTED} 셋째 질문이에요`)
      const exhausted = await waitValue(async () => {
        const snapshot = await server.accounts("quota.snapshot")
        const windows = listOf(snapshot.windows).filter((window) => window.accountID === B)
        return windows.find((window) => window.id === "claude.5h" && window.status === "exhausted")
      }, "B's five-hour window was never marked exhausted")
      expect(exhausted.providerID).toBe("claude-agent")
      await server.turn(session, "넷째 질문이에요")
      expect(await server.accounts("claudeAgent.session.get", { sessionID: session }, directory)).toEqual({
        accountID: B,
        bound: true,
      })
      expect(userTexts(logOf(server, B)).some((text) => text.includes("넷째 질문이에요"))).toBe(true)
      expect(userTexts(logOf(server, A)).some((text) => text.includes("넷째 질문이에요"))).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: an idle account's plan windows are read with a claude that sends no prompt",
    async () => {
      const server = required(state.server)
      fs.writeFileSync(path.join(claudeAgentFolder(server.ownHome, A), USAGE_FILE), JSON.stringify({ fiveHour: 37 }))
      const before = logOf(server, A).length
      const answer = await server.accounts("claudeAgent.limits.refresh", { accountID: A })
      const windows = listOf(answer.windows)
      expect(windows.find((window) => window.id === "claude.5h")).toMatchObject({ accountID: A, usedPercent: 37 })
      const lines = logOf(server, A).slice(before)
      expect(lines.some((line) => controlOf(line) === "get_usage")).toBe(true)
      expect(lines.some((line) => line.kind === "in" && line.message?.type === "user")).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: a link that points elsewhere is repaired; one that cannot be repaired fails the turn",
    async () => {
      const server = required(state.server)
      const session = required(state.session)
      const link = path.join(claudeAgentFolder(server.ownHome, B), "projects")
      const elsewhere = path.join(server.root, "elsewhere")
      fs.mkdirSync(elsewhere, { recursive: true })
      fs.unlinkSync(link)
      fs.symlinkSync(elsewhere, link, "junction")
      // Its process restarts so the next turn resumes from the folder again.
      await server.restart()
      const claude = conversationOf(server, session)
      await server.turn(session, "다섯째 질문이에요")
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(claudeAgentTranscripts(server.ownHome)))
      expect(spawnsOf(server, B, claude).at(-1)?.args).toContain(`--resume=${claude}`)
      expect(fs.readdirSync(elsewhere)).toEqual([])

      fs.unlinkSync(link)
      fs.writeFileSync(link, "not a folder")
      await server.turn(session, "여섯째 질문이에요")
      const said = JSON.stringify(await messages(server, session))
      expect(said).toContain("폴더가 아니라 파일이에요")
      expect(userTexts(logOf(server, B)).some((text) => text.includes("여섯째 질문이에요"))).toBe(false)
      fs.rmSync(link)
      await server.turn(session, "일곱째 질문이에요")
      expect(userTexts(logOf(server, B)).some((text) => text.includes("일곱째 질문이에요"))).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: the folder screen lists the route's folders; a move needs claude-auth with several accounts",
    async () => {
      const server = required(state.server)
      const listed = await server.accounts("claudeAgent.folders.list")
      expect(listOf(listed.folders).map((item) => [item.accountID, item.route, item.movable, item.reason])).toEqual([
        [B, "claude-agent", false, "not_patched"],
        [A, "claude-agent", false, "not_patched"],
      ])
      const refused = await server.rpc(OwnAccounts.ID, "claudeAgent.folders.assign", {
        accountID: A,
        route: "claude-auth",
      })
      expect(refused).toMatchObject({ status: 400, type: "claude_account_unavailable", data: { reason: "not_patched" } })
      expect(fs.existsSync(claudeAgentFolder(server.ownHome, A))).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: a team runs on one Claude Agent account and moves as one",
    async () => {
      const server = required(state.server)
      const viewed = await server.createSession({ model: MODEL["01"], title: "팀 대화" })
      const enabled = await enableTeam(server, { hint: "[propose-areas 1]", sessionID: viewed })
      const team = required(enabled.view.team ?? undefined)
      const changed = await server.team("area.main", { teamID: team.id, areaID: AREA_1, model: CLAUDE_AGENT.model })
      await opEnd(server, required(changed.opID))
      const area = required(
        (await server.team("team.get", { directory: required(server.project) })).areas.find((item) => item.id === AREA_1),
      )
      const owner = required(area.owner.sessionID ?? undefined)
      await server.turn(owner, "팀 담당의 첫 일이에요")
      const first = required(teamBinding(server, team.id))
      const claude = conversationOf(server, owner)
      expect(userTexts(logOf(server, first)).some((text) => text.includes("팀 담당의 첫 일이에요"))).toBe(true)

      const other = first === A ? B : A
      const moved = await server.accounts("claudeAgent.session.set", { sessionID: owner, accountID: other }, area.directory)
      expect(moved.accountID).toBe(other)
      expect(teamBinding(server, team.id)).toBe(other)
      await server.turn(owner, "팀 담당의 둘째 일이에요")
      expect(conversationOf(server, owner)).toBe(claude)
      expect(spawnsOf(server, other, claude).at(-1)?.args).toContain(`--resume=${claude}`)
      expect(userTexts(logOf(server, other)).some((text) => text.includes("팀 담당의 둘째 일이에요"))).toBe(true)
      expect(userTexts(logOf(server, first)).some((text) => text.includes("팀 담당의 둘째 일이에요"))).toBe(false)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: a conversation saved under a retired [1m] id still runs, on the model without it",
    async () => {
      const server = required(state.server)
      // The fake lists `sonnet` and `haiku` as Claude Code 2.1.311+ does, never `sonnet[1m]`.
      const session = await server.createSession({
        model: { providerID: CLAUDE_AGENT.model.providerID, id: "sonnet[1m]" },
        title: "옛 모델 이름",
      })
      await server.turn(session, "옛 이름으로 저장된 대화예요")
      // Without the alias core fails the step (`ModelUnavailableError`) and no claude starts.
      const claude = conversationOf(server, session)
      const spawned = [A, B].flatMap((accountID) => spawnsOf(server, accountID, claude))
      expect(spawned).toHaveLength(1)
      expect(spawned[0]!.args).toContain("--model=sonnet")
      const said = [A, B].flatMap((accountID) => userTexts(logOf(server, accountID).filter((line) => line.session === claude)))
      expect(said.some((text) => text.includes("옛 이름으로 저장된 대화예요"))).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent accounts: every claude of an account names that folder's own Anthropic profile directory (P-045)",
    async () => {
      const server = required(state.server)
      for (const accountID of [A, B]) {
        const folder = claudeAgentFolder(server.ownHome, accountID)
        const spawns = logOf(server, accountID).filter((line) => line.kind === "spawn")
        // Login checks, conversations and the idle usage read above.
        expect(spawns.length).toBeGreaterThan(1)
        expect(new Set(spawns.map((line) => line.anthropicConfigDir))).toEqual(new Set([path.join(folder, "anthropic")]))
      }
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

function db(server: TeamServer) {
  return server.server.paths.database
}

/** The Claude conversation the provider keeps for an OpenCode session (its record in the plugin's KV). */
function conversationOf(server: TeamServer, sessionID: string) {
  const saved = record(kv(db(server), PROVIDER_PLUGIN)[`sessions/${sessionID}`])
  if (typeof saved.claudeSessionID !== "string") throw new Error(`no Claude conversation for ${sessionID}`)
  return saved.claudeSessionID
}

/** The Claude Agent account a team runs on (own-accounts' KV `claude-agent:team:<teamID>`). */
function teamBinding(server: TeamServer, teamID: string) {
  const bound = record(kv(db(server), OwnAccounts.ID)[`claude-agent:team:${teamID}`])
  return typeof bound.accountID === "string" ? bound.accountID : undefined
}

/** What the fake `claude` received and answered under one account's folder, in order. */
function logOf(server: TeamServer, accountID: string) {
  return readLog(claudeAgentFolder(server.ownHome, accountID))
}

function spawnsOf(server: TeamServer, accountID: string, claude: string) {
  return logOf(server, accountID).filter((line) => line.kind === "spawn" && line.session === claude)
}

function controlOf(line: LogLine) {
  return line.kind === "in" && line.message?.type === "control_request"
    ? record(line.message.request).subtype
    : undefined
}

/** The texts of the user messages the SDK sent, oldest first, each joined over its text blocks. */
function userTexts(lines: ReadonlyArray<LogLine>) {
  return lines.flatMap((line) => {
    if (line.kind !== "in" || line.message?.type !== "user") return []
    const content = record(line.message.message).content
    const blocks = Array.isArray(content) ? content : [{ text: content }]
    return [blocks.map((block) => String(record(block).text ?? "")).join("\n")]
  })
}

function listOf(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return Array.isArray(value) ? value.map(record) : []
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
