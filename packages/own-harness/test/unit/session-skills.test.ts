// The skills block of the Codex, Pi and dsh requests (`Hooks.sessionSkills`): the ids core's baseline lists, kept only
// while the Location still loads them. A skill own.accounts' switches turn off in the project (SG 2026-10-26) leaves
// the block at the next request, though the baseline still names it: the block sits near the start of those requests,
// so the cached prefix is rebuilt from there (the settings page's cache note says so).
import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Hooks } from "../../src/hooks.js"

const baseline = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  ...["review", "pdf", "deploy"].flatMap((id) => [
    "  <skill>",
    `    <id>${id}</id>`,
    `    <name>${id}</name>`,
    "  </skill>",
  ]),
  "</available_skills>",
  "",
  "Today's date: Mon Oct 26 2026",
  "",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  String.raw`  Working directory: D:\work\a`,
  "</env>",
].join("\n")

const folder = (id: string) => path.win32.join("D:\\skills", id, "SKILL.md")

type Ctx = Parameters<typeof Hooks.sessionSkills>[0]
type Event = Parameters<typeof Hooks.sessionSkills>[1]

function ctx(ids: ReadonlyArray<string>): Ctx {
  const data = ids.map((id) => ({ id, name: id, description: `${id} skill`, path: folder(id), content: "" }))
  // SAFETY: `sessionSkills` reads `skill.list()` only; the fake gives core's answer shape with plain strings.
  return { skill: { list: () => Effect.succeed({ location: { directory: String.raw`D:\work\a` }, data }) } } as never
}

// SAFETY: `sessionSkills` reads the system parts' text only.
const event = { system: [{ text: baseline }] } as unknown as Event

test("the block keeps the baseline's order and drops an id the Location no longer loads", async () => {
  const all = await Effect.runPromise(Hooks.sessionSkills(ctx(["deploy", "pdf", "review"]), event))
  expect(all.map((skill) => skill.id)).toEqual(["review", "pdf", "deploy"])
  // `pdf` switched off in this project: core's list lacks it, the baseline still names it.
  const off = await Effect.runPromise(Hooks.sessionSkills(ctx(["deploy", "review"]), event))
  expect(off.map((skill) => skill.id)).toEqual(["review", "deploy"])
  expect(off.map((skill) => [skill.id, skill.name, skill.description, skill.path])).toEqual([
    ["review", "review", "review skill", folder("review")],
    ["deploy", "deploy", "deploy skill", folder("deploy")],
  ])
})
