import { describe, expect, test } from "bun:test"
import { Runtime } from "../../src/runtime.js"

// omo's own project skill discovery (OMO-P9) is on only where core reads project config, read the way core's CLI
// reads it (packages/cli/src/server-process.ts).
describe("project skills follow the service's project config", () => {
  test("on by default, off with either of core's variables", () => {
    expect(Runtime.projectSkills({})).toBe(true)
    expect(Runtime.projectSkills({ OPENCODE_CONFIG_PROJECT_DISABLE: "1" })).toBe(false)
    expect(Runtime.projectSkills({ OPENCODE_CONFIG_PROJECT_DISABLE: "TRUE" })).toBe(false)
    expect(Runtime.projectSkills({ OPENCODE_DISABLE_PROJECT_CONFIG: "true" })).toBe(false)
    expect(Runtime.projectSkills({ OPENCODE_CONFIG_PROJECT_DISABLE: "0" })).toBe(true)
    // The newer name wins, as in core.
    expect(Runtime.projectSkills({ OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "1" })).toBe(true)
  })

  test("an SSH host's `instructions` state reads AGENTS.md only: project skills stay off", () => {
    expect(
      Runtime.projectSkills({ OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_CONFIG_PROJECT_INSTRUCTIONS: "1" }),
    ).toBe(false)
  })
})
