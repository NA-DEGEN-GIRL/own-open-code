import { describe, expect, test } from "bun:test"
import { Creator } from "@own/protocol/creator"
import { Schema } from "effect"
import { CreatorStore } from "../../src/store.js"
import { manifest } from "./fixtures.js"

describe("own.ext/1 schema", () => {
  test("a manifest with every C1 type decodes", () => {
    const checked = CreatorStore.checkManifest(manifest())
    expect(checked.ok).toBe(true)
  })

  test("C0 items decode", () => {
    const checked = CreatorStore.checkManifest({
      format: "own.ext/1",
      id: "c0-items",
      title: "C0",
      items: [
        { type: "agent", name: "reviewer", description: "Reviews", mode: "subagent", prompt: "Review." },
        { type: "command", name: "changelog", template: "Write: $ARGUMENTS" },
        { type: "skill", name: "notes", description: "Use for notes", content: "# Notes" },
        { type: "harness.instructions", harness: "codex", text: "Be careful." },
      ],
    })
    expect(checked.ok).toBe(true)
  })

  test.each([
    ["wrong format", { format: "own.ext/2" }, "format"],
    ["bad id", { id: "Bad_Id" }, "id"],
    ["no items", { items: [] }, "items"],
    ["unknown item type", { items: [{ type: "plugin.hook", entry: "x.ts" }] }, "items[0]"],
    ["fragment too long", { items: [{ type: "prompt.fragment", id: "a", text: "x".repeat(4001) }] }, "items[0].text"],
    ["retry over core's ten", { items: [{ type: "retry", maxRetries: 11 }] }, "items[0].maxRetries"],
    [
      "cwd outside the project",
      { items: [{ type: "tool.command", name: "go", description: "d", command: "ls", cwd: "../x" }] },
      "items[0].cwd",
    ],
    [
      "absolute cwd",
      { items: [{ type: "tool.command", name: "go", description: "d", command: "ls", cwd: "C:\\x" }] },
      "items[0].cwd",
    ],
  ])("%s is refused at its path", (_, overrides, at) => {
    const checked = CreatorStore.checkManifest(manifest("sample", overrides))
    expect(checked.ok).toBe(false)
    if (checked.ok) return
    expect(checked.problems.map((problem) => problem.path)).toContain(at)
  })

  test.each([
    [
      "a rule with two targets",
      { type: "tool.rule", rules: [{ tool: "read", permission: "read", effect: "deny" }] },
      "exactly one",
    ],
    [
      "a placeholder without a parameter",
      { type: "tool.command", name: "go", description: "d", command: "ls {{dir}}" },
      "names no parameter",
    ],
    ["an allow tool rule", { type: "tool.rule", rules: [{ tool: "read", effect: "allow" }] }, "permission rules only"],
    [
      "an allow with a wildcard action",
      { type: "tool.rule", rules: [{ permission: "*", effect: "allow" }] },
      "cannot name",
    ],
    [
      "an allow of own's gate",
      { type: "tool.rule", rules: [{ permission: "own_creator", effect: "allow" }] },
      "cannot name",
    ],
    [
      "a command naming the vault",
      { type: "tool.command", name: "go", description: "d", command: "type %LOCALAPPDATA%\\own-open-code\\vault\\x" },
      "credential",
    ],
    [
      "a command reading a token variable",
      { type: "tool.command", name: "go", description: "d", command: "echo $env:GITHUB_TOKEN" },
      "credential",
    ],
    [
      "a command listing the environment",
      { type: "tool.command", name: "go", description: "d", command: "Get-ChildItem env:" },
      "credential",
    ],
    ["a code kind without its code item", undefined, "exactly one plugin.code item"],
  ])("%s is refused", (name, item, message) => {
    const input = item === undefined ? manifest("sample", { kind: "plugin" }) : manifest("sample", { items: [item] })
    const checked = CreatorStore.checkManifest(input)
    expect(checked.ok, name).toBe(false)
    if (checked.ok) return
    expect(checked.problems.map((problem) => problem.message).join("\n")).toContain(message)
  })

  test("duplicate names inside one extension are refused", () => {
    const checked = CreatorStore.checkManifest(
      manifest("sample", {
        items: [
          { type: "prompt.fragment", id: "a", text: "one" },
          { type: "prompt.fragment", id: "a", text: "two" },
        ],
      }),
    )
    expect(checked.ok).toBe(false)
  })

  test("the fragments of one extension are capped together", () => {
    const items = [0, 1, 2, 3].map((n) => ({ type: "prompt.fragment", id: `f${n}`, text: "x".repeat(3500) }))
    const checked = CreatorStore.checkManifest(manifest("sample", { items }))
    expect(checked.ok).toBe(false)
  })

  test("the JSON schema document names every item type", () => {
    const document = JSON.stringify(Schema.toJsonSchemaDocument(Creator.Extension))
    Creator.ITEM_TYPES.forEach((type) => expect(document).toContain(`"${type}"`))
  })

  test("effects say what each item does to the cache", () => {
    const effects = Creator.effects({
      items: [
        { type: "prompt.fragment", id: "a", text: "t" },
        { type: "tool.command", name: "aa", description: "d", command: "ls" },
        { type: "tool.command", name: "bb", description: "d", command: "ls", direct: true },
        { type: "tool.rule", rules: [{ permission: "shell", effect: "allow" }] },
      ],
    })
    expect(effects.map((effect) => effect.cache)).toEqual(["keeps", "keeps", "breaks", "none"])
    expect(effects.map((effect) => effect.loosens)).toEqual([false, false, false, true])
    expect(effects[1]!.name).toBe("ext_aa")
  })
})
