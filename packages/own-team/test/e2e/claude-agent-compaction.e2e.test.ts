// Claude Agent accounts' per-account surfaces on a real server (02 §8.10.5, decisions CAG-49–CAG-53), on the fake
// `claude` (`fake-claude.ts`): two accounts, A and B.
//
// - Auto-compaction per account (CAG-50): `accounts.list` shows each account's setting over the route's models and the
//   window Claude Code reported (200k on the fake); `accounts.update{compaction}` on a Claude Agent account checks it,
//   answers its impact (`dryRun`) and stores it; `policy.set{byKind["claude-agent"]}` takes a kind default. A
//   conversation on A whose context passes A's 40 % compacts (own admits it: core keeps its own ceiling for the route);
//   the same context on B (no setting) does not. `cache.state` names A's threshold.
// - The ledger names the Claude Agent account of each step (CAG-53): `accounts.usage{accountID}` answers its rows and the
//   account's `lastUsedAt` is set (the sidebar's accounts in use); the cache entry is keyed by the account.
// - A Claude Code that leaves the version out of its `initialize` answer (CAG-49) still runs the conversation.
//
// Fake credentials only; nothing reaches a real `claude` or account; every listener binds 127.0.0.1. Run from a path
// without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Kv, OwnAccounts } from "@own/protocol"
import { NO_VERSION_FILE, SUMMARY } from "./fake-claude.js"
import {
  BOOT_TIMEOUT,
  CLAUDE_AGENT,
  CLAUDE_AGENT_B,
  claudeAgentFolder,
  messages,
  startTeamServer,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { kv } from "./inspect.js"

const STEP_TIMEOUT = 300_000
const A = CLAUDE_AGENT.accountID
const B = CLAUDE_AGENT_B.accountID
/** The fake's window (`get_context_usage`), and 40 % of it. */
const WINDOW = 200_000
const EARLY = 80_000
/** A line of the summary the fake writes for a compaction (`SUMMARY`). */
const SUMMARY_HEAD = SUMMARY.slice(SUMMARY.indexOf("- ") + 2, SUMMARY.indexOf("."))

describe("claude-agent compaction and per-account surfaces (fake claude)", () => {
  const state: { server?: TeamServer; onA?: string } = {}

  beforeAll(async () => {
    state.server = await startTeamServer({ name: "claude-agent-compaction", claudeAgent: 2 })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.server?.stop()
  }, 120_000)

  test(
    "claude-agent compaction: each account shows and takes its own setting over the route's windows",
    async () => {
      const server = required(state.server)
      // The route's models come from a Location whose provider listed them (the project's; the control has none).
      const compaction = await waitValue(async () => {
        const found = record((await accountView(server, A)).compaction)
        return listOf(found.effective).length > 0 ? found : undefined
      }, "A's compaction never listed the route's models")
      expect(compaction.setting).toBeNull()
      const effective = listOf(compaction.effective)
      expect(effective.map((item) => item.modelID)).toEqual(expect.arrayContaining(["sonnet", "haiku"]))
      expect(effective.every((item) => item.windowTokens === WINDOW)).toBe(true)

      // Out of range is refused with the range, as for any account.
      const refused = await server.rpc(OwnAccounts.ID, "accounts.update", {
        accountID: A,
        compaction: { triggerPercent: 5 },
      })
      expect(refused.type).toBe("setting_out_of_range")

      const dry = await server.accounts("accounts.update", {
        accountID: A,
        compaction: { triggerPercent: 40 },
        dryRun: true,
      })
      expect(record(dry.compactionImpact).sessions).toEqual([])
      expect(record(record(dry.account).compaction).setting).toBeNull()
      const saved = await server.accounts("accounts.update", { accountID: A, compaction: { triggerPercent: 40 } })
      const after = record(record(saved.account).compaction)
      expect(after.setting).toEqual({ triggerPercent: 40 })
      expect(listOf(after.effective).find((item) => item.modelID === "haiku")).toMatchObject({
        triggerTokens: EARLY,
        source: "account",
      })
      // B keeps the kind default.
      expect(record((await accountView(server, B)).compaction).setting).toBeNull()

      // A kind default for the route is accepted and checked the same way.
      const kind = await server.accounts("policy.set", {
        patch: { compaction: { byKind: { "claude-agent": { triggerPercent: 80 } } } },
        dryRun: true,
      })
      expect(record(kind.compactionImpact).sessions).toEqual([])
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent compaction: a conversation on A compacts at A's 40 %, the same context on B does not",
    async () => {
      const server = required(state.server)
      const directory = required(server.project)
      const onA = await server.createSession({ model: CLAUDE_AGENT.model, title: "A의 압축" })
      state.onA = onA
      await server.turn(onA, "[usage:100000] 큰 문맥이에요")
      await waitValue(
        async () => ((await messages(server, onA)).some((message) => message.type === "compaction") ? true : undefined),
        "A's conversation never compacted",
        120_000,
      )
      // Core ran it to its end on A's Claude (the fake writes core's summary).
      await waitValue(
        async () => (JSON.stringify(await messages(server, onA)).includes(SUMMARY_HEAD) ? true : undefined),
        "A's compaction never finished",
        120_000,
      )
      const view = record(record(await server.accounts("cache.state", { sessionID: onA }, directory)).compaction)
      expect(view).toMatchObject({ windowTokens: WINDOW, slotTriggerTokens: EARLY, source: "account" })

      // B: the same context stays below the route's default (core's 170k), so nothing compacts.
      await server.accounts("claudeAgent.default.set", { accountID: B })
      const onB = await server.createSession({ model: CLAUDE_AGENT.model, title: "B는 그대로" })
      await server.turn(onB, "[usage:100000] 큰 문맥이에요")
      await Bun.sleep(3_000)
      expect((await messages(server, onB)).some((message) => message.type === "compaction")).toBe(false)
      await server.accounts("claudeAgent.default.set", { accountID: A })
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent surfaces: the ledger, the account's last use and the cache entry name the Claude Agent account",
    async () => {
      const server = required(state.server)
      const onA = required(state.onA)
      // A step's ledger line is written by its session's queue, a little after the step.
      const rows = await waitValue(async () => {
        const usage = await server.accounts("accounts.usage", {
          accountID: A,
          from: Date.now() - 3_600_000,
          to: Date.now() + 60_000,
          groupBy: "day",
        })
        return listOf(usage.rows).length > 0 ? usage.rows : undefined
      }, "A's ledger rows never showed")
      expect(listOf(rows).length).toBeGreaterThan(0)
      expect(typeof (await accountView(server, A)).lastUsedAt).toBe("number")
      const cache = Object.keys(kv(server.server.paths.database, OwnAccounts.ID)).filter((key) =>
        key.startsWith(`${Kv.sessionPrefix(onA)}cache:`),
      )
      expect(cache).toContain(Kv.cache(onA, "claude-agent", A))
    },
    STEP_TIMEOUT,
  )

  test(
    "claude-agent version: a Claude Code that reports no version still runs the conversation (CAG-49)",
    async () => {
      const server = required(state.server)
      fs.writeFileSync(path.join(claudeAgentFolder(server.ownHome, B), NO_VERSION_FILE), "")
      await server.accounts("claudeAgent.default.set", { accountID: B })
      const session = await server.createSession({ model: CLAUDE_AGENT.model, title: "버전 없음" })
      await server.turn(session, "버전 없이도 답해 주세요")
      const list = await messages(server, session)
      const reply = JSON.stringify(list.filter((message) => message.type === "assistant"))
      expect(reply).not.toContain("did not report its version")
      expect(reply).not.toContain("너무 오래돼서")
      expect(list.some((message) => message.type === "assistant" && JSON.stringify(message).includes('"text"'))).toBe(
        true,
      )
    },
    STEP_TIMEOUT,
  )
})

async function accountView(server: TeamServer, accountID: string) {
  const list = await server.accounts("accounts.list")
  const found = listOf(list.accounts).find((item) => item.id === accountID)
  if (!found) throw new Error(`no account ${accountID} in accounts.list`)
  return found
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
