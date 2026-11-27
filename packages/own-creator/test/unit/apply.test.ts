import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Creator } from "@own/protocol/creator"
import { Authored } from "../../src/authored.js"
import { CommandTools } from "../../src/command-tools.js"
import { Fragments } from "../../src/fragments.js"
import { Match } from "../../src/match.js"
import { Rules } from "../../src/rules.js"
import { Safety } from "../../src/safety.js"
import { CreatorStore } from "../../src/store.js"
import { CreatorTools } from "../../src/tools.js"
import { Views } from "../../src/views.js"
import { manifest, tempDir } from "./fixtures.js"

const FACTS: Match.Facts = {
  harness: "codex",
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5-5" },
  directory: "D:\\work\\app",
}

describe("when", () => {
  test("every given list must match", () => {
    expect(Match.when(undefined, FACTS)).toBe(true)
    expect(Match.when({ harness: ["codex"] }, FACTS)).toBe(true)
    expect(Match.when({ harness: ["pi"] }, FACTS)).toBe(false)
    expect(Match.when({ model: ["anthropic/*"] }, FACTS)).toBe(true)
    expect(Match.when({ model: ["claude-opus-*"] }, FACTS)).toBe(true)
    expect(Match.when({ model: ["gpt-*"] }, FACTS)).toBe(false)
    expect(Match.when({ agent: ["build"], harness: ["pi"] }, FACTS)).toBe(false)
    expect(Match.when({ project: ["D:\\work"] }, FACTS)).toBe(true)
    expect(Match.when({ project: ["D:\\other"] }, FACTS)).toBe(false)
  })

  test("project folders match the folder and the folders inside it, not a sibling with the same start", () => {
    expect(Safety.inScope([], "D:\\x")).toBe(true)
    expect(Safety.inScope([path.resolve("D:\\work\\app")], path.resolve("D:\\work\\app\\sub"))).toBe(true)
    expect(Safety.inScope([path.resolve("D:\\work\\app")], path.resolve("D:\\work\\app2"))).toBe(false)
  })
})

async function snapshotWith(...manifests: unknown[]) {
  const store = new CreatorStore.Store(await tempDir())
  for (const item of manifests) {
    const created = await store.create(item, "model")
    if (!created.ok) throw new Error(JSON.stringify(created))
  }
  return { store, snapshot: await store.read() }
}

describe("fragments", () => {
  test("one entry per extension, matching fragments joined, the session cap kept", async () => {
    const { snapshot } = await snapshotWith(
      manifest("first", {
        items: [
          { type: "prompt.fragment", id: "a", text: "One." },
          { type: "prompt.fragment", id: "b", text: "Pi only.", when: { harness: ["pi"] } },
          { type: "prompt.fragment", id: "c", text: "Two." },
        ],
      }),
      manifest("second", { items: [{ type: "prompt.fragment", id: "a", text: "x".repeat(4000) }] }),
    )
    const list = Match.applicable(snapshot, FACTS.directory)
    const entries = Fragments.desired(list, FACTS, "mode text")
    expect([...entries.keys()]).toEqual(["own.creator.ext.first", "own.creator.ext.second"])
    expect(entries.get("own.creator.ext.first")).toBe("One.\n\nTwo.")
    expect(Fragments.desired(list, { ...FACTS, agent: "creator" }, "mode text").get(Fragments.MODE_KEY)).toBe(
      "mode text",
    )
  })

  test("an extension limited to other folders adds nothing here", async () => {
    const { store } = await snapshotWith(manifest("first"))
    const project = await tempDir("own-creator-project-")
    await store.scope("first", [project], "user")
    const snapshot = await store.read()
    expect(Match.applicable(snapshot, project)).toHaveLength(1)
    expect(Match.applicable(snapshot, path.join(path.dirname(project), "elsewhere"))).toHaveLength(0)
  })
})

describe("rules", () => {
  test("deny beats ask beats allow; an allow needs its version approved", async () => {
    const { store, snapshot } = await snapshotWith(
      manifest("first", {
        items: [
          {
            type: "tool.rule",
            rules: [
              { permission: "shell", pattern: "git push*", effect: "deny", reason: "no pushes" },
              { permission: "shell", pattern: "git *", effect: "ask" },
              { permission: "webfetch", pattern: "https://docs.example.com/*", effect: "allow" },
            ],
          },
        ],
      }),
    )
    const rules = Match.items(Match.applicable(snapshot, FACTS.directory), "tool.rule")
    expect(Rules.decide(rules, "shell", ["git push origin"])?.effect).toBe("deny")
    expect(Rules.decide(rules, "shell", ["git status"])?.effect).toBe("ask")
    expect(Rules.decide(rules, "shell", ["ls"])).toBeUndefined()
    expect(Rules.decide(rules, "webfetch", ["https://docs.example.com/a"])).toBeUndefined()
    await store.loosen("first", 1, true)
    const approved = Match.items(Match.applicable(await store.read(), FACTS.directory), "tool.rule")
    expect(Rules.decide(approved, "webfetch", ["https://docs.example.com/a"])?.effect).toBe("allow")
  })

  test("the approval mode reads own's bundles", () => {
    expect(CreatorTools.modeOf([])).toBe("ask")
    expect(
      CreatorTools.modeOf([
        { action: "edit", resource: "**", effect: "allow" },
        { action: "shell", resource: "**", effect: "allow" },
      ]),
    ).toBe("full")
    expect(CreatorTools.modeOf([{ action: "edit", resource: "**", effect: "deny" }])).toBe("read-only")
    expect(
      CreatorTools.modeOf([
        { action: "edit", resource: "**", effect: "allow" },
        { action: "shell", resource: "**", effect: "ask" },
      ]),
    ).toBe("ask")
  })
})

describe("command tools", () => {
  const item: Creator.CommandTool = {
    type: "tool.command",
    name: "grep_it",
    description: "d",
    command: "rg {{pattern}} {{path}} --max-count {{count}}",
    params: {
      pattern: { type: "string", description: "p" },
      path: { type: "string", description: "p", optional: true },
      count: { type: "number", description: "n" },
    },
  }

  test("arguments are checked against the parameters", () => {
    expect(CommandTools.check(item, { pattern: "a", count: 2 })).toEqual({ pattern: "a", count: 2 })
    expect(CommandTools.check(item, { pattern: "a" })).toContain("Missing argument count")
    expect(CommandTools.check(item, { pattern: 1, count: 2 })).toContain("must be a string")
    expect(CommandTools.check(item, { pattern: "a", count: 2, extra: 1 })).toContain("Unknown argument extra")
  })

  test("string arguments are quoted for the shell, so they stay one word", () => {
    const args = { pattern: "a'; rm -rf / #", count: 3 }
    expect(CommandTools.render(item.command, args, "posix")).toBe(`rg 'a'\\''; rm -rf / #'  --max-count 3`)
    expect(CommandTools.render(item.command, args, "powershell")).toBe(`rg 'a''; rm -rf / #'  --max-count 3`)
  })

  test("the command's environment has no secrets", () => {
    const env = Safety.commandEnv({
      PATH: "p",
      HOME: "h",
      OPENAI_API_KEY: "k",
      GITHUB_TOKEN: "t",
      OWN_HOME: "o",
      OPENCODE_SERVER_PASSWORD: "x",
      MY_SECRET_VALUE: "s",
    })
    expect(env).toEqual({ PATH: "p", HOME: "h" })
  })
})

describe("commands", () => {
  test("templates fill $ARGUMENTS and positions as core does", () => {
    expect(Authored.expand("Write: $ARGUMENTS", "a b")).toBe("Write: a b")
    expect(Authored.expand("$1 then $2", "one two three")).toBe("one then two three")
    expect(Authored.expand("Plain", "extra")).toBe("Plain\n\nextra")
  })
})

describe("approval card", () => {
  test("names the action, each item with its cache effect, and the warnings", () => {
    const checked = CreatorStore.checkManifest(
      manifest("first", {
        items: [
          { type: "prompt.fragment", id: "a", text: "t" },
          { type: "tool.command", name: "go", description: "d", command: "ls", direct: true },
          { type: "tool.rule", rules: [{ permission: "webfetch", effect: "allow" }] },
        ],
      }),
    )
    if (!checked.ok) throw new Error("invalid")
    const card = Views.card("create", "first", checked.extension, 1)
    expect(card[0]).toBe("확장 first 만들기 (판 1)")
    expect(card).toContain("· 명령 도구 ext_go, 직접 도구 — 열린 대화의 캐시를 한 번 깸")
    expect(card.some((line) => line.includes("allow 규칙"))).toBe(true)
    expect(card.some((line) => line.includes("캐시가 한 번 깨져요"))).toBe(true)
  })
})
