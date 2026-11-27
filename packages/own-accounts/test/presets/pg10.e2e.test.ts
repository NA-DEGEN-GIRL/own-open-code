// End to end on a real upstream server: gate PG10 of 07 §8.4, base part (read-only roles; the 06 team area part with
// own.team's unasked commands belongs to own.team). A child copies its parent's session rules, which come after its
// agent's rules, so a parent in `ask` or `full` approval (`edit ** ask|allow`, `shell ** ask|allow`) would lift the
// read-only roles' own deny. own-accounts' tighten-only `permission` `evaluate` hook (07 §2.4) turns those calls back
// to `deny` without asking: an `own-review` child may not edit, an `explore` child may neither edit nor run a shell
// command. The parent keeps its mode: in `full` it edits and runs commands without asking, in `ask` it is asked. The
// approval mode both read (`modeOf`, `session.approval.get`) does not change: nothing is written to any session.
//
// own-accounts loads from its package directory (`startPresetRig`) with one linked ChatGPT account (01) answering from
// a fake Codex backend. The scripted model reads directives: in the parent's last user text it calls the subagent,
// `patch` (core's edit tool for GPT models) or `shell` tool; a child's prompt names the tool it calls. Patches only
// add files to the temp workspace and commands only `echo`. Every credential is fake; the server binds 127.0.0.1.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import {
  afterToolResult,
  childOf,
  lastUserText,
  startFakeCodex,
  startPresetRig,
  toolError,
  toolParts,
  type FakeCodex,
  type PresetRig,
  type RecordedRequest,
  type Reply,
  type ToolPart,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const TURN_TIMEOUT = 120_000

const ONE = { accountID: "acct-pg10-01", email: "one@example.test", plan: "plus" }
const MAIN = { providerID: "own-codex-pg01", id: "gpt-6-sol", variant: "high" }

const SUBAGENT_PROMPT = "You are a subagent spawned by another session."
const AFTER_TOOL = "도구 결과를 읽었습니다."
/** core's read-only refusals as the hook writes them (`ReadOnly` `MESSAGE`). */
const NO_EDIT = "This subagent role is read-only: it may not edit files."
const NO_SHELL = "This subagent role is read-only: it may not run shell commands."

const fixture: { codex?: FakeCodex; rig?: PresetRig } = {}

beforeAll(async () => {
  const codex = startFakeCodex({ cache: { minTokens: 0, blockTokens: 32 }, responder: reply })
  fixture.codex = codex
  fixture.rig = await startPresetRig({
    name: "pg10",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ONE) }],
    models: [MAIN],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await fixture.codex?.stop()
}, 60_000)

for (const mode of ["ask", "full"] as const) {
  describe(`PG10 base: a parent in \`${mode}\` (07 §2.4, §8.4)`, () => {
    const state: { root?: string; children: string[] } = { children: [] }

    beforeAll(async () => {
      const rig = required(fixture.rig)
      const session = await rig.server.createSession({ model: MAIN })
      state.root = session.id
      expect(await rig.call("session.approval.set", { sessionID: session.id, mode })).toMatchObject({ mode })
      expect(await rig.call("session.approval.get", { sessionID: session.id })).toMatchObject({ mode })
    }, TURN_TIMEOUT)

    const refusals = [
      { name: "own-review edits", directive: "[review-edit]", tool: "patch", message: NO_EDIT },
      { name: "explore edits", directive: "[explore-edit]", tool: "patch", message: NO_EDIT },
      { name: "explore runs a shell command", directive: "[explore-shell]", tool: "shell", message: NO_SHELL },
    ] as const

    for (const item of refusals)
      test(
        `${item.name}: denied without asking`,
        async () => {
          const rig = required(fixture.rig)
          const root = required(state.root)
          const asked = asks().length
          await rig.server.prompt(root, `${item.directive} ${mode}`)
          await rig.server.waitIdle(root)
          const call = required((await toolParts(rig.server, root, "subagent")).at(-1))
          expect(call.state.status).toBe("completed")
          const child = await childOf(rig.server, call)
          expect(child.parentID).toBe(root)
          state.children.push(child.id)
          // Subagents run in the background since upstream v2.3.0 (#63382): the child may still be settling its call.
          await rig.server.waitIdle(child.id)
          const [denied] = await toolParts(rig.server, child.id, item.tool)
          expect(required(denied).state.status).toBe("error")
          expect(toolError(required(denied))).toContain(item.message)
          // Nobody was asked, and the edit never happened.
          expect(asks().slice(asked)).toEqual([])
          if (item.tool === "patch")
            expect(await Bun.file(workspaceFile(fileOf(required(denied)))).exists()).toBe(false)
        },
        TURN_TIMEOUT,
      )

    test(
      `the parent's own edit and shell keep \`${mode}\`: ${mode === "ask" ? "asked, then run" : "run without asking"}`,
      async () => {
        const rig = required(fixture.rig)
        const root = required(state.root)
        for (const directive of ["[parent-edit]", "[parent-shell]"]) {
          const asked = asks().length
          const seen = new Set(asks())
          await rig.server.prompt(root, `${directive} ${mode}`)
          if (mode === "ask") {
            const request = await rig.events.waitFor(
              (event) => event.type === "permission.asked" && event.data.sessionID === root && !seen.has(event),
            )
            await rig.server.call("POST", `/api/session/${root}/permission/${String(request.data.id)}/reply`, {
              body: { decision: "once" },
            })
          }
          await rig.server.waitIdle(root)
          expect(
            asks()
              .slice(asked)
              .map((event) => event.data.sessionID),
          ).toEqual(mode === "ask" ? [root] : [])
        }
        const [patch] = await toolParts(rig.server, root, "patch")
        expect(required(patch).state.status).toBe("completed")
        expect((await Bun.file(workspaceFile(fileOf(required(patch)))).text()).trim()).toBe(`parent ${mode}`)
        const [shell] = await toolParts(rig.server, root, "shell")
        expect(required(shell).state.status).toBe("completed")
      },
      TURN_TIMEOUT,
    )

    test("the approval mode reads the same for the parent and its children (`modeOf`, nothing written)", async () => {
      const rig = required(fixture.rig)
      expect(state.children).toHaveLength(3)
      for (const sessionID of [required(state.root), ...state.children])
        expect(await rig.call("session.approval.get", { sessionID })).toMatchObject({ mode })
    })
  })
}

test("no hook failed", () => {
  expect(required(fixture.rig).server.logs()).not.toMatch(
    /hook_failed|readonly_hook_unavailable|readonly_role_undecided/,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/**
 * The scripted model. A tool result gets a short text; a child calls the tool its prompt names; the parent's
 * directive calls a subagent (`[review-edit]`, `[explore-edit]`, `[explore-shell]`) or a tool of its own.
 */
function reply(request: RecordedRequest): Reply | undefined {
  if (afterToolResult(request)) return { type: "text", text: AFTER_TOOL }
  const text = lastUserText(request)
  const mode = text.includes(" full") ? "full" : "ask"
  if (text.includes(SUBAGENT_PROMPT)) {
    const file = /<<patch:([^>]+)>>/.exec(text)?.[1]
    if (file) return addFile(file, `child ${file}`)
    const command = /<<shell:([^>]+)>>/.exec(text)?.[1]
    if (command) return { type: "tool-call", name: "shell", input: { command } }
    return { type: "text", text: "자식 작업을 마쳤습니다." }
  }
  const subagent = (agent: string, task: string): Reply => ({
    type: "tool-call",
    name: "subagent",
    input: { agent, description: "읽기 전용 역할", prompt: `자식 작업 ${mode}: ${task}` },
  })
  if (text.includes("[review-edit]")) return subagent("own-review", `<<patch:review-${mode}.txt>>`)
  if (text.includes("[explore-edit]")) return subagent("explore", `<<patch:explore-${mode}.txt>>`)
  if (text.includes("[explore-shell]")) return subagent("explore", `<<shell:echo explore-${mode}>>`)
  if (text.includes("[parent-edit]")) return addFile(`parent-${mode}.txt`, `parent ${mode}`)
  if (text.includes("[parent-shell]"))
    return { type: "tool-call", name: "shell", input: { command: `echo parent-${mode}` } }
  return { type: "text", text: "답변" }
}

/** A `patch` call that adds one file. */
function addFile(file: string, text: string): Reply {
  return {
    type: "tool-call",
    name: "patch",
    input: { patchText: ["*** Begin Patch", `*** Add File: ${file}`, `+${text}`, "*** End Patch"].join("\n") },
  }
}

/** Every permission request the server asked (`permission.asked`). */
function asks() {
  return required(fixture.rig).events.events.filter((event) => event.type === "permission.asked")
}

/** The file a `patch` call adds. */
function fileOf(part: ToolPart) {
  const input = part.state.input
  const text = isRecord(input) && typeof input.patchText === "string" ? input.patchText : ""
  return /\*\*\* Add File: (.+)/.exec(text)?.[1] ?? ""
}

function workspaceFile(name: string) {
  return path.join(required(fixture.rig).server.paths.workspace, name)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
