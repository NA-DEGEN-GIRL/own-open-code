// Claude Agent phase 3 on a real server with the fake `claude` (02 §8.10.11–12, core P-043 and P-044): the history a
// conversation made on another provider reaches Claude as its own transcript (structured tool_use and tool_result
// blocks, no catch-up text), a catch-up after alternating providers writes into the same Claude conversation, a
// hand-edited transcript is found before the resume and rebuilt, transcripts no record points to are swept, and the
// process pool keeps a team with more Claude Agent areas than the cap within it. Verdicts come from the provider's
// records (core's KV), the transcripts on disk and what the fake received (its log: `request` lines hold the messages
// each model step read).
//
// Fake credentials only; nothing reaches a real `claude` or account; every listener binds 127.0.0.1. Run from a path
// without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { readLog, type LogLine } from "./fake-claude.js"
import {
  BOOT_TIMEOUT,
  CLAUDE_AGENT,
  MODEL,
  claudeAgentFolder,
  claudeAgentTranscripts,
  dispatches,
  enableTeam,
  opEnd,
  until,
  type TeamServer,
  startTeamServer,
} from "./harness.js"
import { kv } from "./inspect.js"

const STEP_TIMEOUT = 300_000
const PROVIDER_PLUGIN = "opencode.provider.claude-agent"
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
] as const

describe("claude-agent: native transcripts and the process pool (fake claude)", () => {
  const state: { server?: TeamServer; session?: string; conversation?: string } = {}

  beforeAll(async () => {
    state.server = await startTeamServer({ name: "ca-native", claudeAgent: true })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
  }, 120_000)

  test(
    "a ChatGPT turn with a tool call, then a move to Claude Agent: claude resumes it as structured history",
    async () => {
      const server = required(state.server)
      const sessionID = await server.createSession({ model: MODEL["01"], title: "옮기는 대화", permissions: FULL })
      state.session = sessionID
      await server.turn(sessionID, "[write native.txt 지피티가 썼어요]")
      // GPT adds the file with a patch, which ends it with a newline.
      expect(fs.readFileSync(path.join(required(server.project), "native.txt"), "utf8").trim()).toBe("지피티가 썼어요")

      await move(server, sessionID, CLAUDE_AGENT.model)
      await server.turn(sessionID, "옮긴 뒤 첫 질문이에요")
      const conversation = conversationOf(server, sessionID)
      state.conversation = conversation
      const lines = log(server).filter((line) => line.session === conversation)
      const spawn = required(lines.find((line) => line.kind === "spawn"))
      // own wrote the transcript before claude started, and claude resumed it.
      expect(spawn.args).toContain(`--resume=${conversation}`)
      expect(userTexts(lines)).toEqual(["옮긴 뒤 첫 질문이에요"])
      const read = messagesOf(lines)
      const call = read
        .flatMap((message) => (message.role === "assistant" ? message.content : []))
        .find((block) => block.type === "tool_use")
      expect(String(call?.name)).toMatch(/^mcp__opencode__/)
      const result = read
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .find((block) => block.type === "tool_result")
      expect(result?.tool_use_id).toBe(call?.id)
      expect(JSON.stringify(read)).toContain("지피티가 썼어요")
      expect(JSON.stringify(read)).not.toContain("conversation-checkpoint")
      // The transcript sits in the shared folder every account resumes from.
      expect(transcriptFile(server, conversation)).toBeDefined()
    },
    STEP_TIMEOUT,
  )

  test(
    "a catch-up after alternating providers writes the missed turn into the same Claude conversation",
    async () => {
      const server = required(state.server)
      const sessionID = required(state.session)
      const conversation = required(state.conversation)
      await move(server, sessionID, MODEL["01"])
      await server.turn(sessionID, "[write native2.txt 다시 지피티]")
      await move(server, sessionID, CLAUDE_AGENT.model)
      await server.turn(sessionID, "다시 옮긴 뒤 질문이에요")
      expect(conversationOf(server, sessionID)).toBe(conversation)
      const lines = log(server).filter((line) => line.session === conversation)
      const spawn = required(lines.findLast((line) => line.kind === "spawn"))
      expect(spawn.args).toContain(`--resume=${conversation}`)
      const mine = lines.filter((line) => line.pid === spawn.pid)
      expect(userTexts(mine)).toEqual(["다시 옮긴 뒤 질문이에요"])
      const read = JSON.stringify(messagesOf(mine))
      expect(read).toContain("다시 지피티")
      expect(read).toContain("옮긴 뒤 첫 질문이에요")
      expect(read).not.toContain("conversation-checkpoint")
    },
    STEP_TIMEOUT,
  )

  test(
    "a hand-edited transcript is found before the resume and rebuilt from the history",
    async () => {
      const server = required(state.server)
      const sessionID = required(state.session)
      const conversation = required(state.conversation)
      await server.restart()
      const file = required(transcriptFile(server, conversation))
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("지피티가 썼어요", "손으로 고쳤어요"))
      await server.turn(sessionID, "고친 뒤 질문이에요")
      const rebuilt = conversationOf(server, sessionID)
      expect(rebuilt).not.toBe(conversation)
      const lines = log(server).filter((line) => line.session === rebuilt)
      expect(required(lines.find((line) => line.kind === "spawn")).args).toContain(`--resume=${rebuilt}`)
      expect(userTexts(lines)).toEqual(["고친 뒤 질문이에요"])
      const read = JSON.stringify(messagesOf(lines))
      expect(read).toContain("지피티가 썼어요")
      expect(read).not.toContain("손으로 고쳤어요")
      // The changed transcript is gone, and no record keeps it.
      expect(fs.existsSync(file)).toBe(false)
      expect(JSON.stringify(record(server, sessionID).previous ?? [])).not.toContain(conversation)
      state.conversation = rebuilt
    },
    STEP_TIMEOUT,
  )

  test(
    "transcripts no record points to are removed a while after start; referenced and recent ones stay",
    async () => {
      const server = required(state.server)
      const shared = claudeAgentTranscripts(server.ownHome)
      const project = path.join(shared, "stray-project")
      fs.mkdirSync(project, { recursive: true })
      const old = path.join(project, `${crypto.randomUUID()}.jsonl`)
      const recent = path.join(project, `${crypto.randomUUID()}.jsonl`)
      for (const file of [old, recent]) fs.writeFileSync(file, "{}\n")
      const hours = new Date(Date.now() - 3 * 3_600_000)
      fs.utimesSync(old, hours, hours)
      await server.restart()
      // The provider sweeps a minute after it starts.
      await until(async () => !fs.existsSync(old), "the orphan transcript was never removed", 180_000)
      expect(fs.existsSync(recent)).toBe(true)
      expect(transcriptFile(server, required(state.conversation))).toBeDefined()
    },
    STEP_TIMEOUT,
  )

  test(
    "the pool: a team with more Claude Agent areas than the cap runs them all, never more processes than the cap",
    async () => {
      const server = required(state.server)
      const pool = await server.accounts("claudeAgent.pool.set", { processes: 2 })
      expect(pool).toMatchObject({ cap: 2 })
      const viewed = await server.createSession({ model: MODEL["01"], title: "켠 대화" })
      const enabled = await enableTeam(server, { hint: "[propose-areas 3]", sessionID: viewed })
      const team = required(enabled.view.team ?? undefined)
      const areas = enabled.view.areas.map((area) => area.id)
      expect(areas).toHaveLength(3)
      for (const areaID of areas) {
        const changed = await server.team("area.main", { teamID: team.id, areaID, model: CLAUDE_AGENT.model })
        await opEnd(server, required(changed.opID))
      }
      const since = Date.now()
      const work = areas
        .map((areaID) => `[dispatch ${slugOf(areaID)} [slow 4000] [report progress ${slugOf(areaID)} 끝]]`)
        .join(" ")
      await server.turn(team.main.sessionID, work)
      await until(
        async () =>
          dispatches(server.server.paths.database, team.id).filter((item) => item.state === "sent").length >= 3 &&
          areas.every((areaID) =>
            log(server).some(
              (line) =>
                line.kind === "out" && JSON.stringify(line.message ?? {}).includes(`${slugOf(areaID)} 끝`),
            ),
          ),
        "the areas did not all report",
        STEP_TIMEOUT,
      )
      // Never more than two conversation processes at once (side calls and login checks aside).
      expect(peak(log(server).filter((line) => line.at >= since))).toBeLessThanOrEqual(2)
      // A start waited for a slot, and own told the clients.
      const waited = server.events.events.some(
        (event) =>
          event.type === "rpc.own.accounts.claudeAgent.pool" &&
          (event.data as { pool?: { waiting?: ReadonlyArray<unknown> } }).pool?.waiting?.length,
      )
      expect(waited).toBe(true)
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

type Block = Readonly<Record<string, unknown>> & { readonly type?: string; readonly id?: unknown; readonly name?: unknown }
interface Message {
  readonly role: string
  readonly content: ReadonlyArray<Block>
}

/** Moves a session to another model, as the switcher's `now` does. */
async function move(server: TeamServer, sessionID: string, model: { readonly providerID: string; readonly id: string }) {
  await server.server.call("POST", `/api/session/${sessionID}/model`, { body: { model } })
}

function record(server: TeamServer, sessionID: string) {
  return (kv(server.server.paths.database, PROVIDER_PLUGIN)[`sessions/${sessionID}`] ?? {}) as {
    readonly claudeSessionID?: string
    readonly previous?: ReadonlyArray<{ readonly claudeSessionID: string }>
  }
}

function conversationOf(server: TeamServer, sessionID: string) {
  return required(record(server, sessionID).claudeSessionID)
}

function log(server: TeamServer) {
  return readLog(claudeAgentFolder(server.ownHome))
}

function transcriptFile(server: TeamServer, conversation: string) {
  const shared = claudeAgentTranscripts(server.ownHome)
  return fs
    .readdirSync(shared, { recursive: true, encoding: "utf8" })
    .map((name) => path.join(shared, name))
    .find((file) => file.endsWith(`${conversation}.jsonl`))
}

function userTexts(lines: ReadonlyArray<LogLine>) {
  return lines.flatMap((line) => {
    if (line.kind !== "in" || line.message?.type !== "user") return []
    const content = (line.message.message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? content : [{ text: content }]
    return [blocks.map((block: { text?: unknown }) => String(block.text ?? "")).join("\n")]
  })
}

/** The messages the first model step of these lines read. */
function messagesOf(lines: ReadonlyArray<LogLine>): ReadonlyArray<Message> {
  const request = required(lines.find((line) => line.kind === "request")).request
  return (request?.messages ?? []) as ReadonlyArray<Message>
}

/** The most conversation processes alive at once (a spawn with partial messages and persistence, until its exit). */
function peak(lines: ReadonlyArray<LogLine>) {
  const conversation = (line: LogLine) =>
    (line.args ?? []).includes("--include-partial-messages") && !(line.args ?? []).includes("--no-session-persistence")
  const started = new Set(lines.filter((line) => line.kind === "spawn" && conversation(line)).map((line) => line.pid))
  let live = 0
  let most = 0
  for (const line of lines) {
    if (!started.has(line.pid)) continue
    if (line.kind === "spawn") live++
    if (line.kind === "exit") live--
    most = Math.max(most, live)
  }
  return most
}

function slugOf(areaID: string) {
  return OwnTeam.AreaID.make(areaID).replace(/^ar_/, "")
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("e2e fixture was not started")
  return value
}
