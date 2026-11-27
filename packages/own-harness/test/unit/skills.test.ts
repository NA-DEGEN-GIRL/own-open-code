import { expect, test } from "bun:test"
import { Skills } from "../../src/skills.js"

test("the Claude desktop app's synced skills are recognised; the user's own skills are not", () => {
  expect(Skills.synced(String.raw`C:\Users\a\.claude\skills\synced\org_id\docx\SKILL.md`)).toBe(true)
  expect(Skills.synced("/home/a/.claude/skills/synced/org_id/docs/SKILL.md")).toBe(true)
  expect(Skills.synced(String.raw`C:\Users\a\.claude\skills\my-skill\SKILL.md`)).toBe(false)
  expect(Skills.synced("/home/a/.agents/skills/synced/x/SKILL.md")).toBe(false)
})
