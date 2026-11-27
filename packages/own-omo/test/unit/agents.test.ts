// omo's subagents as own-omo registers them (15 §4.5): their rules replace the agent's whole list after own.accounts'
// agent transform ran, so they carry its GitHub rule themselves (16 §5.4, GH-13): a GitHub write asks, whatever omo
// restricts, and the other harnesses' gates stay denied.
import { describe, expect, test } from "bun:test"
import { OwnGitHub } from "@own/protocol"
import { Agents } from "../../src/host/agents.js"
// Core's rule matcher, as core evaluates an agent's rules (the last matching rule wins).
import { Wildcard } from "../../../core/src/util/wildcard.js"

const effect = (rules: ReadonlyArray<{ action: string; effect: string }>, action: string) =>
  rules.findLast((rule) => Wildcard.match(action, rule.action))?.effect

describe("omo's subagents and GitHub writes", () => {
  test("a GitHub write asks under every omo subagent; the default allow stays for the rest", () => {
    for (const restrictions of [{}, { write: false }, { edit: false, task: false }] as Array<Record<string, boolean>>) {
      const rules = Agents.permissions({ id: "omo-oracle", restrictions })
      expect(effect(rules, OwnGitHub.WRITE_ACTION)).toBe("ask")
      expect(effect(rules, "own_harness_codex")).toBe("deny")
      expect(effect(rules, "read")).toBe("allow")
    }
    expect(effect(Agents.permissions({ id: "omo-oracle", restrictions: { write: false } }), "edit")).toBe("deny")
  })
})
