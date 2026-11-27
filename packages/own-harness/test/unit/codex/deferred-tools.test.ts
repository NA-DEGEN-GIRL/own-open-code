// Codex's deferred tool namespaces in the world state (rust-v0.167.0, 0e31c29e25 #58410, `deferred_tool_world_state`):
// the `<tools>` developer fragment and its budget (core/src/context/world_state/tools_tests.rs and tools_budget_tests.rs,
// whose cases are ported here with their expected texts), and how the codex harness places it: in the initial developer
// message after the other fragments, and as an update at each change of model that changes the namespaces.
import { describe, expect, test } from "bun:test"
import { Message, SystemPart } from "@opencode/ai/effect"
import GOLDEN from "../../golden/codex/exec-basic.json" with { type: "json" }
import { Checkpoint } from "../../../src/checkpoint.js"
import { CodexAgentsV1 } from "../../../src/codex/agents/v1.js"
import { Catalog } from "../../../src/codex/catalog.js"
import { CodexEffort } from "../../../src/codex/effort.js"
import { Fragments } from "../../../src/codex/fragments.js"
import { CodexIncremental } from "../../../src/codex/incremental.js"
import { CodexRequest } from "../../../src/codex/request.js"

const DIRECT = "gpt-5.5"
const SOL = "gpt-6.1-sol"
const TERRA = "gpt-6.1-terra"
const UNKNOWN = "own-unknown-model"

const MULTI_AGENT = new Map([[CodexAgentsV1.NAMESPACE, CodexAgentsV1.NAMESPACE_DESCRIPTION]])
const LISTED =
  "<tools>\nDeferred tool namespaces:\n- multi_agent_v1: Tools for spawning and managing sub-agents.\n</tools>"
const REMOVED =
  "<tools>\nRemoved deferred tool namespaces:\n- multi_agent_v1: Tools for spawning and managing sub-agents.\nNo deferred tool namespaces remain.\n</tools>"

describe("Fragments.deferredTools (Codex's ToolsState)", () => {
  test("gpt-5.5's fragment is what Codex 0.167.0 sent in the exec-basic capture", () => {
    const developer = GOLDEN.requests[0]!.body.input[1] as { content: Array<{ text: string }> }
    expect(developer.content.at(-1)!.text).toBe(LISTED)
    expect(Fragments.deferredTools(MULTI_AGENT)).toBe(LISTED)
  })

  test("nothing to say: no namespaces before or now, or the same ones", () => {
    expect(Fragments.deferredTools(new Map())).toBeUndefined()
    expect(Fragments.deferredTools(new Map(), new Map())).toBeUndefined()
    expect(Fragments.deferredTools(MULTI_AGENT, MULTI_AGENT)).toBeUndefined()
    // Compared as Codex keeps them: a description that normalizes the same is no change.
    expect(Fragments.deferredTools(new Map([["a", " text \nmore"]]), new Map([["a", "text"]]))).toBeUndefined()
  })

  test("renders the first line of namespace descriptions", () => {
    const rendered = Fragments.deferredTools(
      new Map([
        ["app", "  control the Codex App  \nAdditional instructions."],
        ["gmail", "access your Google Gmail Account & labels"],
        ["hotline", ""],
      ]),
    )
    expect(rendered).toBe(
      "<tools>\nDeferred tool namespaces:\n- app: control the Codex App\n- gmail: access your Google Gmail Account & labels\n- hotline\n</tools>",
    )
  })

  test("renders added, removed and updated namespace descriptions", () => {
    const rendered = Fragments.deferredTools(
      new Map([
        ["app", "control the Codex App"],
        ["kept", "unchanged"],
        ["gmail", "access your Google Gmail Account"],
      ]),
      new Map([
        ["kept", "unchanged"],
        ["gmail", "old Gmail description"],
        ["hotline", "access hotline information"],
      ]),
    )
    expect(rendered).toBe(
      "<tools>\nAdded deferred tool namespaces:\n- app: control the Codex App\n- gmail: access your Google Gmail Account\nRemoved deferred tool namespaces:\n- hotline: access hotline information\n</tools>",
    )
  })

  test("all removed: the removal and that none remain; added again: the full list", () => {
    expect(Fragments.deferredTools(new Map(), MULTI_AGENT)).toBe(REMOVED)
    expect(Fragments.deferredTools(MULTI_AGENT, new Map())).toBe(LISTED)
  })

  test("caps namespace descriptions by character count", () => {
    const exact = "🦀".repeat(250)
    const rendered = Fragments.deferredTools(
      new Map([
        ["exact", exact],
        ["over", "🦀".repeat(251)],
      ]),
    )
    expect(rendered).toBe(
      `<tools>\nDeferred tool namespaces:\n- exact: ${exact}\n- over: ${"🦀".repeat(247)}...\n</tools>`,
    )
  })

  test("normalizes descriptions before the byte cap and keeps every one of 100 names", () => {
    const rendered = Fragments.deferredTools(
      new Map(
        Array.from({ length: 100 }, (_, index) => [`namespace_${index}`, `${"界&<>'\"".repeat(100)}\nsecond line`]),
      ),
    )!
    expect(bytes(rendered)).toBeLessThanOrEqual(4096)
    expect(rendered.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(100)
  })

  test("retains all names before sharing description bytes", () => {
    const names = Array.from({ length: 100 }, (_, index) => `namespace_${index}`)
    const rendered = Fragments.deferredTools(new Map(names.map((name) => [name, "&".repeat(250)])))!
    // Name-only rows leave 2,564 bytes: 200 separator bytes, 300 ellipsis bytes, and 20 ampersands per namespace, plus
    // one for the first 64 (in byte order).
    const rows = names
      .toSorted()
      .map((name, index) => `- ${name}: ${"&".repeat(index < 64 ? 21 : 20)}...\n`)
      .join("")
    expect(bytes(rendered)).toBe(4096)
    expect(rendered).toBe(`<tools>\nDeferred tool namespaces:\n${rows}</tools>`)
  })

  test("retains names that fit without reserving an omission notice", () => {
    const names = Array.from(
      { length: 80 },
      (_, index) => `service_${String(index).padStart(2, "0")}_${"x".repeat(36)}`,
    )
    const rendered = Fragments.deferredTools(new Map(names.map((name) => [name, ""])))!
    expect(bytes(rendered)).toBe(4042)
    expect(rendered).toBe(`<tools>\nDeferred tool namespaces:\n${names.map((name) => `- ${name}\n`).join("")}</tools>`)
  })

  test("preserves raw names and complete Unicode at the budget boundary", () => {
    const name = `a${"<".repeat(4032)}`
    const rendered = Fragments.deferredTools(
      new Map([
        [name, "&🦀x"],
        ["z", "🦀&y"],
      ]),
    )!
    expect(bytes(rendered)).toBe(4096 - 3)
    expect(rendered).toBe(`<tools>\nDeferred tool namespaces:\n- ${name}: &...\n- z: ...\n</tools>`)
  })

  test("redistributes description space after short and empty descriptions", () => {
    const name = "a".repeat(4031)
    const rendered = Fragments.deferredTools(
      new Map([
        [name, "abcdefgh"],
        ["b", "X"],
        ["c", ""],
      ]),
    )
    expect(rendered).toBe(`<tools>\nDeferred tool namespaces:\n- ${name}: abcd...\n- b: X\n- c\n</tools>`)
  })

  test("shares descriptions across the added and removed groups", () => {
    const name = "a".repeat(3992)
    const rendered = Fragments.deferredTools(new Map([[name, "AAAAAAAA"]]), new Map([["z", "ZZZZZZZZ"]]))
    expect(rendered).toBe(
      `<tools>\nAdded deferred tool namespaces:\n- ${name}: AAA...\nRemoved deferred tool namespaces:\n- z: ZZ...\n</tools>`,
    )
  })

  test("omits whole names per group only after dropping every description", () => {
    const retained = "b".repeat(3870)
    const rendered = Fragments.deferredTools(
      new Map([
        ["a".repeat(4000), "oversized namespace"],
        [retained, "large namespace"],
        ["c".repeat(100), "another omitted namespace"],
        ["d", "short namespace"],
      ]),
      new Map([
        ["y".repeat(100), "omitted removed namespace"],
        ["z", "short removed namespace"],
      ]),
    )
    expect(rendered).toBe(
      `<tools>\nAdded deferred tool namespaces:\n- ${retained}\n- d\n... 2 additional namespaces omitted.\nRemoved deferred tool namespaces:\n- z\n... 1 additional namespaces omitted.\n</tools>`,
    )
  })

  test("reserves the empty-state notice when all namespaces are removed", () => {
    const name = "a".repeat(3988)
    const rendered = Fragments.deferredTools(
      new Map(),
      new Map([
        [name, "long namespace"],
        ["z", "short namespace"],
      ]),
    )!
    expect(bytes(rendered)).toBe(4096)
    expect(rendered).toBe(
      `<tools>\nRemoved deferred tool namespaces:\n- ${name}: lon...\n- z: sh...\nNo deferred tool namespaces remain.\n</tools>`,
    )
  })

  test("Codex's snapshots: shared description truncation and namespace omission", () => {
    const description =
      "Search project documents by title, owner, date, or status. Read matching documents with their summaries, source links, and recent activity. Create documents, update their contents, and organize results into collections for follow-up."
    const truncated = Fragments.deferredTools(
      new Map(
        Array.from({ length: 20 }, (_, index) => [`project_${String(index).padStart(2, "0")}_documents`, description]),
      ),
    )!
    const rows = truncated.split("\n").filter((line) => line.startsWith("- "))
    expect(rows).toHaveLength(20)
    expect(rows.slice(0, 14).every((row) => row.endsWith("update their cont..."))).toBe(true)
    expect(rows.slice(14).every((row) => row.endsWith("update their con..."))).toBe(true)
    const omitted = Fragments.deferredTools(
      new Map(
        Array.from({ length: 80 }, (_, index) => [
          `mcp__codex_apps__workspace_${String(index).padStart(2, "0")}_project_documents_and_search`,
          "Search project documents.",
        ]),
      ),
    )!
    const kept = omitted.split("\n").filter((line) => line.startsWith("- "))
    expect(kept).toHaveLength(65)
    expect(kept.at(-1)).toBe("- mcp__codex_apps__workspace_64_project_documents_and_search")
    expect(omitted).toEndWith("\n... 15 additional namespaces omitted.\n</tools>")
  })
})

describe("Fragments.namespaceRows (Codex's truncate_namespace_rows)", () => {
  test("truncates raw rows at character boundaries in group order", () => {
    const groups = [
      [
        "first",
        new Map([
          ["&", "🦀&y"],
          ["🦀", "&🦀x"],
        ]),
      ],
      ["empty", new Map()],
      ["last", new Map([["b", "x<&"]])],
    ] as const
    const cases: ReadonlyArray<readonly [number, number, ReadonlyArray<string | undefined>]> = [
      [36, 64, ["- &: 🦀&y\n", "- 🦀: &🦀x\n", "- b: x<&\n"]],
      [32, 64, ["- &: ...\n", "- 🦀: &...\n", "- b\n"]],
      [15, 64, ["- &\n", "- 🦀\n", "- b\n"]],
      [14, 6, ["- &\n", undefined, "- b\n"]],
    ]
    for (const [budget, reserve, expected] of cases)
      expect(Fragments.namespaceRows(groups, budget, reserve)).toEqual(expected)
  })

  test("marks truncated descriptions within the allocated bytes", () => {
    const cases = [
      ["abcdef", 4, "- n\n"],
      ["abcdef", 7, "- n\n"],
      ["abcdef", 8, "- n\n"],
      ["abcdef", 9, "- n: ...\n"],
      ["abcdef", 10, "- n: a...\n"],
      ["abcdef", 12, "- n: abcdef\n"],
      ["ab", 8, "- n: ab\n"],
      ["🦀abcdef", 10, "- n: ...\n"],
      ["🦀abcdef", 13, "- n: 🦀...\n"],
      ["éabcdef", 11, "- n: é...\n"],
    ] as const
    for (const [description, budget, expected] of cases) {
      const rows = Fragments.namespaceRows([["namespaces", new Map([["n", description]])]], budget, 64)
      expect(rows).toEqual([expected])
      expect(bytes(rows.join(""))).toBeLessThanOrEqual(budget)
    }
  })

  test("keeps names before descriptions and charges the omission reserve only on overflow", () => {
    const rows = (entries: ReadonlyArray<readonly [string, string]>, budget: number, reserve: number) =>
      Fragments.namespaceRows([["group", new Map(entries)]], budget, reserve)
    // `a` keeps one description byte, too few for `...`, so both rows keep their names only.
    expect(
      rows(
        [
          ["a", "abcd"],
          ["b", "x"],
        ],
        11,
        64,
      ),
    ).toEqual(["- a\n", "- b\n"])
    expect(
      rows(
        [
          ["a", ""],
          ["b", ""],
        ],
        8,
        64,
      ),
    ).toEqual(["- a\n", "- b\n"])
    expect(
      rows(
        [
          ["aaaa", "x"],
          ["bbbb", "x"],
          ["c", "x"],
        ],
        15,
        3,
      ),
    ).toEqual(["- aaaa\n", undefined, "- c\n"])
    // An oversized name cannot keep later complete names from fitting.
    expect(
      rows(
        [
          ["oversized_name_aaa", "x"],
          ["a", "x"],
          ["b", "x"],
        ],
        14,
        2,
      ),
    ).toEqual([undefined, "- a\n", "- b\n"])
    expect(
      rows(
        [
          ["ab", "x"],
          ["c", ""],
        ],
        0,
        2,
      ),
    ).toEqual([undefined, undefined])
    expect(
      rows(
        [
          ["a", "x"],
          ["b", "x"],
        ],
        6,
        64,
      ),
    ).toEqual([undefined, undefined])
  })
})

const user = (id: string) => Message.make({ id, role: "user", content: `question ${id}` })
const assistant = (id: string) => Message.make({ id, role: "assistant", content: `answer ${id}` })
const checkpoint = (id: string) =>
  Message.make({ id, role: "user", content: Checkpoint.render("## Objective\n- Keep going.", []) })

const SESSION: CodexRequest.Session = {
  model: DIRECT,
  sessionID: "ses_deferred",
  responses: true,
  cwd: "C:\\work\\app",
  mode: "full",
  reads: false,
  shell: "powershell",
  timezone: "Asia/Seoul",
  plan: false,
  skills: [],
  freeform: true,
}

/** A request with the v1 agent tools and tool_search, as own's codex harness registers them. */
function build(messages: Array<Message>, session: Partial<CodexRequest.Session>, agents = true) {
  const draft: CodexRequest.Draft = {
    system: [
      SystemPart.make("You are an AI agent running in OpenCode, a coding agent harness."),
      SystemPart.make("Today's date: Sun Oct 11 2026"),
    ],
    messages,
    options: {},
    tools: {
      exec_command: { description: "exec", input: { type: "object" } },
      exec: { description: "exec", input: { type: "object" } },
      wait: { description: "wait", input: {} },
      request_user_input: { description: "ask", input: {} },
      ...(agents
        ? {
            multi_agent_v1__spawn_agent: { description: "spawn", input: { type: "object" } },
            multi_agent_v1__wait_agent: { description: "wait", input: { type: "object" } },
            tool_search: { description: "search", input: { type: "object" } },
          }
        : {}),
    },
  }
  CodexRequest.build(draft, { ...SESSION, ...session })
  return draft
}

const texts = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : part.type))
/** The initial developer message's texts (after the base instructions). */
const initial = (draft: CodexRequest.Draft) => texts(draft.messages[1]!)
/** Each developer message right before a message, as its list of input texts (effort updates left out). */
const before = (draft: CodexRequest.Draft, id: string) => {
  const at = draft.messages.findIndex((message) => message.id === id)
  const start = draft.messages.slice(0, at).findLastIndex((message) => message.role !== "system")
  return draft.messages
    .slice(start + 1, at)
    .filter((message) => !CodexEffort.isUpdate(message))
    .map(texts)
}
const modelSwitch = (model: string) =>
  `<model_switch>\nThe user was previously using a different model. Please continue the conversation according to the following instructions:\n\n${Catalog.instructions(Catalog.lookup(model))}\n</model_switch>`
const collaboration = (model: string) => Fragments.collaboration(false, Catalog.lookup(model))

describe("CodexRequest.build: deferred tool namespaces (Codex 0.167.0)", () => {
  test("gpt-5.5 lists multi_agent_v1 last in the initial developer message, and tool_search no longer lists sources", () => {
    const draft = build([user("u1")], {})
    expect(initial(draft).at(-1)).toBe(LISTED)
    expect(initial(draft).at(-2)).toStartWith("<collaboration_mode>")
    const hosted = (draft.tools!.tool_search!.input as Record<string, { description: string }>)["x-opencode-hosted"]!
    expect(hosted.description).not.toContain("You have access to tools from the following sources")
  })

  test("no fragment without deferred tools: no agent tools, a model without tool search, Code Mode, or off Responses", () => {
    expect(initial(build([user("u1")], {}, false)).join("\n")).not.toContain("<tools>")
    expect(initial(build([user("u1")], { model: UNKNOWN })).join("\n")).not.toContain("<tools>")
    expect(initial(build([user("u1")], { model: SOL })).join("\n")).not.toContain("<tools>")
    const chat = build([user("u1")], { responses: false, freeform: false })
    expect(chat.system.map((part) => part.text).join("\n")).not.toContain("<tools>")
  })

  test("gpt-5.5 → a v2 model and back: the window keeps its list; each change gets what changed", () => {
    const history = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")]
    const steps = new Map([
      ["a1", { model: DIRECT }],
      ["a2", { model: SOL }],
    ])
    const switches = new Map([
      ["u2", SOL],
      ["u3", DIRECT],
    ])
    // On Sol: the window gpt-5.5 opened still lists the namespaces; the change to Sol removes them.
    const onSol = build(history.slice(0, 3), { model: SOL, steps, switches: new Map([["u2", SOL]]) })
    expect(initial(onSol).at(-1)).toBe(LISTED)
    expect(before(onSol, "u2")).toEqual([[modelSwitch(SOL)], [REMOVED]])
    // Back on gpt-5.5: none remained, so Codex lists them afresh.
    const back = build(history, { steps, switches })
    expect(initial(back).at(-1)).toBe(LISTED)
    expect(before(back, "u2")).toEqual([[modelSwitch(SOL)], [REMOVED]])
    expect(before(back, "u3")).toEqual([[modelSwitch(DIRECT)], [LISTED]])
  })

  test("gpt-5.5 → a model without tool search: its agent tools come up front, so the namespace goes", () => {
    const draft = build([user("u1"), assistant("a1"), user("u2")], {
      model: UNKNOWN,
      steps: new Map([["a1", { model: DIRECT }]]),
      switches: new Map([["u2", UNKNOWN]]),
    })
    expect(initial(draft).at(-1)).toBe(LISTED)
    expect(before(draft, "u2")).toEqual([[modelSwitch(UNKNOWN)], [REMOVED]])
  })

  test("a Responses Lite window: the update shares a developer message with the new <collaboration_mode>", () => {
    const draft = build([user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3")], {
      model: TERRA,
      steps: new Map([
        ["a1", { model: SOL }],
        ["a2", { model: DIRECT }],
      ]),
      switches: new Map([
        ["u2", DIRECT],
        ["u3", TERRA],
      ]),
    })
    // Sol opened the window and defers nothing, so its initial context lists no namespaces.
    expect(initial(draft).join("\n")).not.toContain("<tools>")
    expect(before(draft, "u2")).toEqual([[modelSwitch(DIRECT)], [collaboration(DIRECT), LISTED]])
    expect(before(draft, "u3")).toEqual([
      [CodexIncremental.instructions(TERRA, Catalog.instructions(Catalog.lookup(TERRA)))],
      [collaboration(TERRA), REMOVED],
    ])
  })

  test("a new window lists the namespaces of its first step's model; earlier changes get no update", () => {
    const draft = build([user("u1"), assistant("a1"), user("u2"), assistant("a2"), checkpoint("c1"), user("u3")], {
      model: SOL,
      steps: new Map([
        ["a1", { model: DIRECT }],
        ["a2", { model: SOL }],
      ]),
      switches: new Map([["u2", SOL]]),
    })
    expect(initial(draft).join("\n")).not.toContain("<tools>")
    expect(before(draft, "u2")).toEqual([[modelSwitch(SOL)]])
  })
})

function bytes(text: string) {
  return new TextEncoder().encode(text).length
}
