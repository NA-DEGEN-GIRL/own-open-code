// The read-only roles' tighten-only `permission` `evaluate` hook (07 §2.4, 06 §4.9, PG10 own-accounts part, 06 TG6
// deny side): `explore` and `own-review` children are denied edits (and `explore` the shell), and both every computer
// tool and every GitHub write (MR9-8), whatever the parent's approval mode and its computer allow; parents and incoming denies are untouched and
// nothing is raised to allow. The context is a fake that only answers `session.get`; nothing may be written.

import { describe, expect, test } from "bun:test"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { Permission } from "@opencode/schema/permission"
import { Preset } from "@own/protocol"
import { Hooks } from "../../src/hooks.js"
import { ReadOnly } from "../../src/presets/readonly.js"
import { SessionApproval } from "../../src/switching/approval.js"
import { testDeps } from "../support/deps.js"

const PARENT = "ses_ro_parent"
const EXPLORE = "ses_ro_explore"
const REVIEW = "ses_ro_review"

/** The parent's session rules: `full` approval with computer use on, which children copy (core `session.ts`). */
const RULES: ReadonlyArray<Permission.Rule> = SessionApproval.withComputerUse(
  SessionApproval.bundle("full", []),
  "on",
  [],
)

interface SessionRecord {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly permissions: ReadonlyArray<Permission.Rule>
}

async function setup() {
  const sessions = new Map<string, SessionRecord>([
    [PARENT, { id: PARENT, agent: "build", permissions: structuredClone([...RULES]) }],
    [EXPLORE, { id: EXPLORE, parentID: PARENT, agent: "explore", permissions: structuredClone([...RULES]) }],
    [REVIEW, { id: REVIEW, parentID: PARENT, agent: "own-review", permissions: structuredClone([...RULES]) }],
  ])
  const lookups: string[] = []
  const logs: string[] = []
  // Only `session.get`: a write anywhere (session rules, KV, an approval switch) would throw.
  const t = await testDeps({
    logs,
    ctx: {
      session: {
        get: async (request: { readonly sessionID: string }) => {
          lookups.push(request.sessionID)
          const found = sessions.get(request.sessionID)
          if (!found) throw new Error(`session not found: ${request.sessionID}`)
          return { ...found, location: { directory: "D:/work" } }
        },
      },
    },
  })
  return {
    t,
    sessions,
    lookups,
    logs,
    hook: ReadOnly.create(t.deps),
    async [Symbol.asyncDispose]() {
      await t[Symbol.asyncDispose]()
    },
  }
}

/** An evaluation as core hands it to hooks: no rule denied it, the session rules made it `allow` (or `ask`). */
function evaluation(
  sessionID: string,
  action: string,
  input: { readonly agent?: string; readonly effect?: Permission.Effect; readonly message?: string } = {},
): PermissionEvaluation {
  // SAFETY: ids are branded strings in the plugin types; the hook reads them as strings.
  return {
    sessionID,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    action,
    resources: [action === "shell" ? "bun run typecheck" : "src/index.ts"],
    effect: input.effect ?? "allow",
    ...(input.message === undefined ? {} : { message: input.message }),
  } as unknown as PermissionEvaluation
}

describe("read-only roles (07 §2.4, PG10)", () => {
  test("explore children: edit, shell and computer are denied although the copied session rules allow them", async () => {
    await using s = await setup()
    for (const action of ["edit", "shell", "computer"]) {
      const event = evaluation(EXPLORE, action, { agent: "explore" })
      await s.hook(event)
      expect([action, event.effect]).toEqual([action, "deny"])
      expect(event.message).toBeString()
    }
    // `ask` is tightened the same way.
    const asked = evaluation(EXPLORE, "edit", { agent: "explore", effect: "ask" })
    await s.hook(asked)
    expect(asked.effect).toBe("deny")
  })

  test("own-review children: edit and computer are denied; the shell follows the approval mode", async () => {
    await using s = await setup()
    const results = await Promise.all(
      (["edit", "computer", "shell"] as const).map(async (action) => {
        const event = evaluation(REVIEW, action, { agent: "own-review" })
        await s.hook(event)
        return [action, event.effect]
      }),
    )
    expect(results).toEqual([
      ["edit", "deny"],
      ["computer", "deny"],
      ["shell", "allow"],
    ])
  })

  test("both read-only roles are denied GitHub writes outright, asked or allowed; the parent keeps its ask (MR9-8)", async () => {
    await using s = await setup()
    const pr = "create_pull_request octo/hello as octo-work (gh_01WORK)"
    // GitHub's reads ask no permission (16 §5.4), so a read-only role still reads issues and pull requests.
    const judged = async (sessionID: string, agent: string, effect: Permission.Effect) => {
      const event = { ...evaluation(sessionID, "github.write", { agent, effect }), resources: [pr] }
      await s.hook(event)
      return [agent, effect, event.effect, typeof event.message]
    }
    expect(
      await Promise.all([
        judged(EXPLORE, "explore", "ask"),
        judged(EXPLORE, "explore", "allow"),
        judged(REVIEW, "own-review", "ask"),
        // A saved `항상 허용` of exactly this write (GitHub's hook keeps it as `allow`) does not lift the role's deny.
        judged(REVIEW, "own-review", "allow"),
        judged(PARENT, "build", "ask"),
        judged(PARENT, "build", "allow"),
      ]),
    ).toEqual([
      ["explore", "ask", "deny", "string"],
      ["explore", "allow", "deny", "string"],
      ["own-review", "ask", "deny", "string"],
      ["own-review", "allow", "deny", "string"],
      ["build", "ask", "ask", "undefined"],
      ["build", "allow", "allow", "undefined"],
    ])
    expect(ReadOnly.DENIED.explore).toContain("github.write")
    expect(ReadOnly.DENIED["own-review"]).toContain("github.write")
  })

  test("both read-only roles are denied own's image tool; the parent and a writing role keep their ask (MR13)", async () => {
    await using s = await setup()
    const judged = async (sessionID: string, agent: string, effect: Permission.Effect) => {
      const event = { ...evaluation(sessionID, "image_generate", { agent, effect }), resources: ["gpt-image-2.6-flare"] }
      await s.hook(event)
      return [agent, event.effect, typeof event.message]
    }
    expect(
      await Promise.all([
        judged(EXPLORE, "explore", "ask"),
        judged(REVIEW, "own-review", "allow"),
        judged(PARENT, "build", "ask"),
      ]),
    ).toEqual([
      ["explore", "deny", "string"],
      ["own-review", "deny", "string"],
      ["build", "ask", "undefined"],
    ])
  })

  test("both read-only roles are denied every creator C2 tool (action `creator-…`), asked or allowed; `creator` itself is not (F4, MR15)", async () => {
    await using s = await setup()
    const judged = async (sessionID: string, agent: string, action: string, effect: Permission.Effect) => {
      const event = { ...evaluation(sessionID, action, { agent, effect }), resources: ["*"] }
      await s.hook(event)
      return [agent, action, event.effect, typeof event.message]
    }
    expect(
      await Promise.all([
        // A creator C2 server tool, whatever the approval mode on the session.
        judged(EXPLORE, "explore", "creator-words-words_count_words", "allow"),
        judged(REVIEW, "own-review", "creator-words-words_count_words", "ask"),
        // creator mode's own write action is not a C2 tool and is not denied here (creator mode gates it).
        judged(REVIEW, "own-review", "creator", "ask"),
        // The parent (a writing role) keeps its decision.
        judged(PARENT, "build", "creator-words-words_count_words", "allow"),
      ]),
    ).toEqual([
      ["explore", "creator-words-words_count_words", "deny", "string"],
      ["own-review", "creator-words-words_count_words", "deny", "string"],
      ["own-review", "creator", "ask", "undefined"],
      ["build", "creator-words-words_count_words", "allow", "undefined"],
    ])
  })

  test("both read-only roles are denied every 내 브라우저 사용 action, never its reads (BRW)", async () => {
    await using s = await setup()
    const judged = async (sessionID: string, agent: string, action: string, input?: unknown) => {
      const event = {
        ...evaluation(sessionID, action, { agent, effect: "allow" }),
        resources: ["*"],
        ...(input === undefined ? {} : { metadata: { input } }),
      }
      await s.hook(event)
      return [agent, action, event.effect]
    }
    expect(
      await Promise.all([
        judged(EXPLORE, "explore", "browse_click"),
        judged(REVIEW, "own-review", "browse_navigate"),
        judged(REVIEW, "own-review", "browse_tabs", { action: "new", url: "https://example.test" }),
        // Reads stay, under the conversation's switch and mode.
        judged(EXPLORE, "explore", "browse_snapshot"),
        judged(REVIEW, "own-review", "browse_tabs", { action: "list" }),
        // A writing role keeps its decision; the mode hook (browse/browse.ts) decides there.
        judged(PARENT, "build", "browse_click"),
      ]),
    ).toEqual([
      ["explore", "browse_click", "deny"],
      ["own-review", "browse_navigate", "deny"],
      ["own-review", "browse_tabs", "deny"],
      ["explore", "browse_snapshot", "allow"],
      ["own-review", "browse_tabs", "allow"],
      ["build", "browse_click", "allow"],
    ])
  })

  test("the roles denied `shell` are exactly the protocol's no-shell roles, whose reads own.harness answers", () => {
    // own.harness serves these roles' simple reads in Codex's exec_command and Pi's bash (10 §3.10, decisions SA).
    expect(Preset.READ_ONLY_ROLES.filter((role) => ReadOnly.DENIED[role].includes("shell"))).toEqual([
      ...Preset.NO_SHELL_ROLES,
    ])
  })

  test("`computer` for every computer tool, even with the session's {computer,*,allow} (cu-review)", async () => {
    await using s = await setup()
    expect(SessionApproval.computerUseOf(s.sessions.get(EXPLORE)?.permissions ?? [])).toBe("on")
    for (const resource of ["*", "screenshot", "click", "type"]) {
      const event = { ...evaluation(EXPLORE, "computer", { agent: "explore" }), resources: [resource] }
      await s.hook(event)
      expect(event.effect).toBe("deny")
    }
  })

  test("the parent is unaffected: its edits, shell and computer allow stay, and its rules and mode are not touched", async () => {
    await using s = await setup()
    for (const action of ["edit", "shell", "computer"]) {
      const event = evaluation(PARENT, action, { agent: "build" })
      await s.hook(event)
      expect(event.effect).toBe("allow")
    }
    for (const sessionID of [PARENT, EXPLORE, REVIEW]) {
      const rules = s.sessions.get(sessionID)?.permissions ?? []
      expect(rules).toEqual(RULES)
      expect(SessionApproval.modeOf(rules, [])).toBe("full")
      expect(SessionApproval.computerUseOf(rules)).toBe("on")
    }
  })

  test("tighten only: an incoming deny is never changed and nothing is raised to allow", async () => {
    await using s = await setup()
    const denied = evaluation(PARENT, "edit", { agent: "build", effect: "deny", message: "an earlier hook said no" })
    await s.hook(denied)
    expect([denied.effect, denied.message]).toEqual(["deny", "an earlier hook said no"])
    const asked = evaluation(PARENT, "shell", { agent: "build", effect: "ask" })
    await s.hook(asked)
    expect(asked.effect).toBe("ask")
    // A read-only role's allowed actions stay as core decided them.
    const read = evaluation(EXPLORE, "read", { agent: "explore", effect: "ask" })
    await s.hook(read)
    expect(read.effect).toBe("ask")
  })

  test("without the event's agent the session's agent decides; unreadable fails closed for these actions only", async () => {
    await using s = await setup()
    const looked = evaluation(EXPLORE, "edit")
    await s.hook(looked)
    expect(looked.effect).toBe("deny")
    const parent = evaluation(PARENT, "edit")
    await s.hook(parent)
    expect(parent.effect).toBe("allow")
    const unknown = evaluation("ses_ro_missing", "shell")
    await s.hook(unknown)
    expect(unknown.effect).toBe("deny")
    expect(s.logs.some((line) => line.includes("readonly_role_undecided"))).toBe(true)
    // Actions no role is denied never need a lookup.
    s.lookups.length = 0
    const grep = evaluation("ses_ro_missing", "grep")
    await s.hook(grep)
    expect([grep.effect, s.lookups]).toEqual(["allow", []])
  })
})

describe("registration (hooks.ts)", () => {
  test("Hooks.register adds the evaluate hook once, after the tool hooks, through the guard", async () => {
    await using s = await setup()
    const order: string[] = []
    const evaluate: Array<(event: PermissionEvaluation) => Promise<void> | void> = []
    const registration = { dispose: async () => {} }
    const registered = (name: string) => async () => {
      order.push(name)
      return registration
    }
    const ctx = {
      ...s.t.deps.ctx,
      provider: { transform: registered("provider.transform") },
      model: { transform: registered("model.transform") },
      agent: { transform: registered("agent.transform") },
      skill: { transform: registered("skill.transform") },
      session: { ...s.t.deps.ctx.session, hook: registered("session.hook") },
      tool: { hook: async (name: string) => registered(`tool.${name}`)() },
      permission: {
        hook: async (name: string, callback: (event: PermissionEvaluation) => Promise<void> | void) => {
          order.push(`permission.${name}`)
          evaluate.push(callback)
          return registration
        },
      },
    }
    // SAFETY: the context parts `Hooks.register` touches; registrations other than `evaluate` are recorded no-ops.
    await Hooks.register({ ...s.t.deps, ctx: ctx as unknown as typeof s.t.deps.ctx }, s.t.modules())
    expect(order.filter((name) => name.startsWith("permission."))).toEqual(["permission.evaluate"])
    expect(order.at(-1)).toBe("permission.evaluate")
    const event = evaluation(EXPLORE, "edit", { agent: "explore" })
    await evaluate[0]?.(event)
    expect(event.effect).toBe("deny")
  })
})
