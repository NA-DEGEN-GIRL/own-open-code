// Worktree conversations on every agent harness (06 §13.6, 2026-11-24): with own-harness loaded last, a conversation
// on each harness asks the scripted model to start a worktree conversation, and the call reaches own.team's
// `worktree_start` the harness's own way: core's Code Mode `execute` (`tools.worktree.start`) for opencode, pi, dsh,
// omo and claude-code on a non-Claude-Agent provider (both run core's request as opencode does), Codex's freeform
// `exec` (`tools.worktree__start`) for codex's Code Mode. Each started conversation runs in `<project>/.worktrees` on
// the parent's harness and model, and its end wakes the parent. One opencode conversation then moves itself
// (`worktree_move`, only on an explicit request).
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarnessRouting } from "@own/protocol/rpc-harness-routing"
import { BOOT_TIMEOUT, MODEL, messages, startTeamServer, until, type TeamServer } from "./harness.js"
import { kv, toolNames } from "./inspect.js"
import { REPO_ROOT, sessionInfo } from "../../../own-accounts/test/e2e-kit"

const STEP_TIMEOUT = 300_000

const CASES = [
  { harness: "opencode", model: MODEL["01"], tool: "execute" },
  { harness: "codex", model: MODEL["01"], tool: "exec" },
  { harness: "pi", model: MODEL["01"], tool: "execute" },
  { harness: "dsh", model: MODEL.deepseek, tool: "execute" },
  { harness: "omo", model: MODEL["01"], tool: "execute" },
  { harness: "claude-code", model: MODEL["01"], tool: "execute" },
] as const

describe("worktree conversations on every harness (F1, own-harness loaded)", () => {
  const state: { team?: TeamServer } = {}

  beforeAll(async () => {
    state.team = await startTeamServer({
      name: "wtharness",
      plugins: [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }],
    })
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.team?.stop()
  }, 120_000)

  for (const item of CASES)
    test(
      `${item.harness}: worktree_start reaches own.team through ${item.tool}; the conversation runs in .worktrees on ${item.harness}`,
      async () => {
        const team = required(state.team)
        const project = required(team.project)
        const parent = await team.createSession({
          model: item.model,
          title: `${item.harness} 대화`,
          metadata: { [OwnHarnessRouting.META_KEY]: OwnHarnessRouting.value(item.harness) },
        })
        await team.accounts("session.approval.set", { sessionID: parent, mode: "full" }, project)
        const mark = team.fakes.codex.requests.length + team.fakes.deepseek.requests.length
        const name = `h-${item.harness}`
        await team.turn(parent, `[tool worktree.start {"tasks":[{"name":"${name}","task":"확인만 하고 끝내 주세요."}]}]`)
        const child = await until(
          async () => recordOf(team, parent) !== undefined,
          `no worktree conversation for ${item.harness}`,
        )
          .then(() => required(recordOf(team, parent)))
          .catch(async (error: unknown) => {
            // What the parent's turn did instead.
            const sent = [...team.fakes.codex.requests, ...team.fakes.deepseek.requests].slice(mark).map((request) => {
              const json = record(request.json)
              const items = [...(Array.isArray(json.input) ? json.input : []), ...(Array.isArray(json.messages) ? json.messages : [])]
              return {
                tools: toolNames(request),
                rawTools: JSON.stringify(json.tools ?? null).slice(0, 300),
                items: items.map((item) => JSON.stringify(item).slice(0, 160)),
              }
            })
            throw new Error(`${error instanceof Error ? error.message : String(error)}
${JSON.stringify(sent, null, 1).slice(0, 12000)}`)
          })
        expect(same(String(child.directory), path.join(project, ".worktrees", name))).toBe(true)
        const session = await sessionInfo(team.server, String(child.sessionID))
        expect(OwnHarnessRouting.bound(record(session.metadata))).toBe(item.harness)
        expect(record(session.model).id).toBe(item.model.id)
        // The parent's request carried the harness's way to the tool.
        const requests = [...team.fakes.codex.requests, ...team.fakes.deepseek.requests].slice(mark)
        expect(requests.some((request) => toolNames(request).includes(item.tool))).toBe(true)
        await until(async () => recordOf(team, parent)?.state === "done", `${item.harness}: the conversation did not end`, STEP_TIMEOUT)
        await until(
          async () => (await texts(team, parent)).some((text) => text.includes(`name="${name}"`)),
          `${item.harness}: the parent was not told`,
          STEP_TIMEOUT,
        )
      },
      STEP_TIMEOUT * 2,
    )

  test(
    "worktree_move moves this conversation into a new worktree on its own branch",
    async () => {
      const team = required(state.team)
      const project = required(team.project)
      const session = await team.createSession({ model: MODEL["01"], title: "옮길 대화" })
      await team.turn(session, `[tool worktree.move {"name":"moved"}]`)
      const target = path.join(project, ".worktrees", "moved")
      await until(async () => {
        const info = await sessionInfo(team.server, session)
        return same(String(record(info.location).directory), target)
      }, "the conversation did not move").catch(async (error: unknown) => {
        const last = (await messages(team, session)).slice(-3)
        throw new Error(`${error instanceof Error ? error.message : String(error)}
${JSON.stringify(last).slice(0, 4000)}`)
      })
      expect(fs.existsSync(target)).toBe(true)
    },
    STEP_TIMEOUT,
  )
})

function recordOf(team: TeamServer, parentID: string) {
  const entry = Object.entries(kv(team.server.paths.database)).find(([key]) => key.startsWith(`wtchat:${parentID}:`))
  return entry === undefined ? undefined : record(entry[1])
}

async function texts(team: TeamServer, sessionID: string) {
  return (await messages(team, sessionID)).flatMap((message) => {
    const content = Array.isArray(message.content) ? message.content : []
    const parts = content.flatMap((part) => {
      const value = record(part)
      return typeof value.text === "string" ? [value.text] : []
    })
    return typeof message.text === "string" ? [message.text, ...parts] : parts
  })
}

function same(a: string, b: string) {
  const norm = (value: string) => path.resolve(value).replaceAll("\\", "/").toLowerCase()
  return norm(fs.existsSync(a) ? fs.realpathSync(a) : a) === norm(fs.existsSync(b) ? fs.realpathSync(b) : b)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {}
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("missing value")
  return value
}

