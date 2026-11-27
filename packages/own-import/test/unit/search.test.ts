import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { View } from "../../src/render/view.js"
import { Search } from "../../src/search.js"
import { ClaudeSource } from "../../src/sources/claude.js"
import { CodexStore } from "../../src/sources/codex.js"
import { Paths } from "../../src/sources/paths.js"
import { CWD, IDS, basic, write } from "../fixtures/claude.js"
import { rollout, threadId, writeRollout } from "../fixtures/codex.js"
import { claudeFolder, fixture, type Fixture } from "../fixtures/make.js"
import { start } from "../support/guard.js"

const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.cleanup()))
})

async function make() {
  const item = await fixture({ under: "한글 #폴더" })
  fixtures.push(item)
  const roots = Paths.defaults({ options: { roots: { codex: [item.codex], claude: [item.claude] } } })
  return { item, codex: roots[0], claude: roots[1] }
}

const decodeRef = Schema.decodeUnknownSync(OwnImport.SourceRef)
const range = (count: number) => Array.from({ length: count }, (_, index) => index)

async function codexTarget(
  root: Paths.Root,
  id: string,
  records: ReadonlyArray<unknown>,
  zst = false,
): Promise<View.CodexTarget> {
  const file = await CodexStore.resolve(root, await writeRollout(root.directory, { id, records, zst }))
  if (file === undefined) throw new Error("no rollout")
  return { kind: "codex", ref: decodeRef({ kind: "codex", rootID: root.rootID, id }), root, file }
}

async function claudeTarget(root: Paths.Root, id: string): Promise<View.ClaudeTarget> {
  const listed = await ClaudeSource.conversations(root, claudeFolder(CWD))
  const conversation = listed.ok ? listed.value.find((item) => item.id === id) : undefined
  if (conversation === undefined) throw new Error(`no conversation ${id}`)
  return { kind: "claude-code", ref: decodeRef({ kind: "claude-code", rootID: root.rootID, id }), root, conversation }
}

async function found(result: Promise<View.Result<Search.Found>>) {
  const value = await result
  if (!value.ok) throw new Error(value.reason)
  return value.value
}

const turns = (value: Search.Found) => value.hits.map((hit) => [String(hit.ref.id), hit.turn])

/** Two turns: the request, a command and its output, a reasoning summary, the answer. */
function talk(id: string) {
  return rollout()
    .meta({ id })
    .taskStarted("u1")
    .turnContext({ model: "gpt-5.5", turnId: "u1" })
    .user("설치기 정리해 줘", { kinds: true, turnId: "u1" })
    .reasoning({ summary: "Looking at the installer" })
    .call("exec_command", { cmd: "bun test" }, "c1")
    .output("c1", "12 pass")
    .call("lookup", { q: "docs" }, "c2", "mcp__docs")
    .output("c2", "doc text")
    .assistant("정리했습니다.")
    .taskComplete("u1")
    .taskStarted("u2")
    .user("이제 커밋해 줘", { kinds: true, turnId: "u2" })
    .call("shell", { command: ["git", "commit"] }, "c3")
    .output("c3", { content: "nothing to commit", success: false })
    .assistant("커밋할 것이 없습니다.")
    .taskComplete("u2")
    .records()
}

/** `count` turns whose requests and answers all contain `word`. */
function repeated(id: string, count: number, word: string) {
  return range(count)
    .reduce(
      (builder, index) =>
        builder
          .taskStarted(`u${index}`)
          .user(`request ${index} about the ${word}`, { kinds: true, turnId: `u${index}` })
          .call("exec_command", { cmd: `step ${index}` }, `c${index}`)
          .output(`c${index}`, `output ${index}`)
          .assistant(`the ${word} answer ${index}`)
          .taskComplete(`u${index}`),
      rollout().meta({ id }),
    )
    .records()
}

describe("matching, titles and snippets", () => {
  test("a case-insensitive substring of the trimmed query; regex characters are literal; a blank query matches all titles", () => {
    const items = [
      { title: "설치기 정리", firstPrompt: "fix the INSTALLER" },
      { title: "a.b docs" },
      { title: "aXb other" },
    ]
    expect(Search.titles(items, " installer ").map((item) => item.title)).toEqual(["설치기 정리"])
    expect(Search.titles(items, "설치기").map((item) => item.title)).toEqual(["설치기 정리"])
    expect(Search.titles(items, "a.b").map((item) => item.title)).toEqual(["a.b docs"])
    expect(Search.titles(items, "(").map((item) => item.title)).toEqual([])
    expect(Search.titles(items, "  ")).toEqual(items)
    expect(Search.matcher("")).toBeUndefined()
  })

  test("snippets: at most 160 characters, 40 before the match, one line, … where cut, no split surrogate pair", () => {
    const text = `${"x".repeat(500)}\n\nthe needle  is\there${"y".repeat(500)}`
    const cut = Search.snippet(text, text.indexOf("needle"))
    expect(cut.length).toBeLessThanOrEqual(Search.SNIPPET_MAX)
    expect(cut.startsWith("…")).toBe(true)
    expect(cut.endsWith("…")).toBe(true)
    expect(cut).toContain("the needle is here")
    expect(cut.indexOf("needle")).toBeLessThanOrEqual(41)
    expect(Search.snippet("short  text\nwith a needle", 18)).toBe("short text with a needle")
    const emoji = `${"😀".repeat(100)}needle${"😀".repeat(100)}`
    const pairs = Search.snippet(emoji, emoji.indexOf("needle"))
    expect(pairs.length).toBeLessThanOrEqual(Search.SNIPPET_MAX)
    expect(pairs).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

describe("in one conversation (sessions.search {ref})", () => {
  test("the whole conversation: requests, answers, reasoning, tool names, inputs and output; one hit per turn", async () => {
    const { item, codex } = await make()
    const target = await codexTarget(codex, threadId(1), talk(threadId(1)))
    const viewer = View.viewer()
    const guard = await start([item.codex])
    const search = (query: string) => found(Search.conversation(viewer, target, { query }))
    expect(turns(await search("12 PASS"))).toEqual([[threadId(1), 0]])
    expect(turns(await search("nothing to commit"))).toEqual([[threadId(1), 1]])
    expect(turns(await search("mcp__docs"))).toEqual([[threadId(1), 0]])
    expect(turns(await search("looking at"))).toEqual([[threadId(1), 0]])
    expect(turns(await search("bun test"))).toEqual([[threadId(1), 0]])
    expect(await search("커밋")).toEqual({
      hits: [{ ref: target.ref, turn: 1, snippet: "이제 커밋해 줘" }],
      complete: true,
    })
    expect(await search("not there")).toEqual({ hits: [], complete: true })
    expect(await guard.stop()).toEqual([])
  })

  test("limit and cursor: the cursor resumes at the next turn, from its offset when the viewer knows it", async () => {
    const { codex } = await make()
    const target = await codexTarget(codex, threadId(2), repeated(threadId(2), 30, "needle"), true)
    const viewer = View.viewer()
    // The viewer read it: its turn offsets are known.
    await viewer.read(target, { from: 29 })
    const one = await found(Search.conversation(viewer, target, { query: "needle", limit: 10 }))
    expect(one.hits.map((hit) => hit.turn)).toEqual(range(10))
    expect(one.complete).toBe(false)
    const lines = viewer.stats().lines
    const two = await found(Search.conversation(viewer, target, { query: "needle", limit: 10, cursor: one.cursor }))
    expect(two.hits.map((hit) => hit.turn)).toEqual(range(10).map((index) => index + 10))
    // Turns 10–19 and the line opening turn 20: 6 lines each, none before.
    expect(viewer.stats().lines - lines).toBe(10 * 6 + 1)
    const three = await found(Search.conversation(viewer, target, { query: "needle", limit: 10, cursor: two.cursor }))
    expect(three.hits.map((hit) => hit.turn)).toEqual(range(10).map((index) => index + 20))
    expect(three).toMatchObject({ complete: true })
    expect(three.cursor).toBeUndefined()
    // A cursor of another conversation or not a cursor at all starts from the beginning.
    expect(
      (await found(Search.conversation(viewer, target, { query: "needle", limit: 1, cursor: "garbage" }))).hits[0]
        ?.turn,
    ).toBe(0)
  })

  test("hits in turns the tool rolled back later are dropped", async () => {
    const { codex } = await make()
    const records = rollout()
      .meta({ id: threadId(3) })
      .taskStarted("u1")
      .user("first", { turnId: "u1" })
      .assistant("one")
      .taskComplete("u1")
      .taskStarted("u2")
      .user("the needle, later undone", { turnId: "u2" })
      .assistant("two")
      .taskComplete("u2")
      .rolledBack(1)
      .taskStarted("u3")
      .user("again with the needle", { turnId: "u3" })
      .taskComplete("u3")
      .records()
    const target = await codexTarget(codex, threadId(3), records)
    const value = await found(Search.conversation(View.viewer(), target, { query: "needle" }))
    expect(value.hits).toEqual([{ ref: target.ref, turn: 1, snippet: "again with the needle" }])
  })

  test("Claude Code tool output; a cancelled search answers cancelled", async () => {
    const { item, claude } = await make()
    const fixture = basic("2.1.288")
    await write(item.claude, fixture.input, fixture.session)
    const target = await claudeTarget(claude, IDS.basic)
    const viewer = View.viewer()
    expect(turns(await found(Search.conversation(viewer, target, { query: "3 pass" })))).toEqual([[IDS.basic, 0]])
    const controller = new AbortController()
    controller.abort()
    expect(await Search.conversation(viewer, target, { query: "3 pass", signal: controller.signal })).toEqual({
      ok: false,
      reason: "cancelled",
    })
  })
})

describe("in a folder (sessions.search {directory}: 내용까지)", () => {
  test("the human's and the model's text only, conversations in list order", async () => {
    const { item, codex, claude } = await make()
    const fixture = basic("2.1.288")
    await write(item.claude, fixture.input, fixture.session)
    const targets = [await codexTarget(codex, threadId(10), talk(threadId(10))), await claudeTarget(claude, IDS.basic)]
    const viewer = View.viewer()
    const search = (query: string) => found(Search.folder(viewer, targets, { query }))
    expect(await search("12 pass")).toEqual({ hits: [], complete: true })
    expect(await search("3 pass")).toEqual({ hits: [], complete: true })
    expect(await search("looking at")).toEqual({ hits: [], complete: true })
    expect(turns(await search("정리했습니다"))).toEqual([[threadId(10), 0]])
    expect(turns(await search("설치기"))).toEqual([
      [threadId(10), 0],
      [IDS.basic, 0],
    ])
    expect(turns(await search("the tests pass"))).toEqual([[IDS.basic, 0]])
  })

  test("at most `limit` hits; the cursor resumes inside the conversation it stopped in, then the next ones", async () => {
    const { codex } = await make()
    const ids = [threadId(20), threadId(21), threadId(22)]
    const targets = await Promise.all(ids.map((id) => codexTarget(codex, id, repeated(id, 2, "needle"))))
    const viewer = View.viewer()
    const one = await found(Search.folder(viewer, targets, { query: "needle", limit: 3 }))
    expect(turns(one)).toEqual([
      [ids[0], 0],
      [ids[0], 1],
      [ids[1], 0],
    ])
    expect(one.complete).toBe(false)
    const two = await found(Search.folder(viewer, targets, { query: "needle", limit: 3, cursor: one.cursor }))
    expect(turns(two)).toEqual([
      [ids[1], 1],
      [ids[2], 0],
      [ids[2], 1],
    ])
    expect(two.complete).toBe(true)
    // The default limit is 100 (09 §3).
    expect(Search.LIMIT).toBe(100)
  })

  test("the time budget: an exhausted budget answers what it has with a cursor; a conversation that left the list resumes at its place", async () => {
    const { codex } = await make()
    const ids = [threadId(30), threadId(31), threadId(32)]
    const targets = await Promise.all(ids.map((id) => codexTarget(codex, id, repeated(id, 2, "needle"))))
    const viewer = View.viewer()
    const stopped = await found(Search.folder(viewer, targets, { query: "needle", budget: -1 }))
    expect(stopped).toMatchObject({ hits: [], complete: false })
    const resumed = await found(Search.folder(viewer, targets, { query: "needle", cursor: stopped.cursor }))
    expect(resumed.hits).toHaveLength(6)
    expect(resumed.complete).toBe(true)
    // Stopped inside the second conversation, which then left the list: resume at its old place, from the start.
    const partial = await found(Search.folder(viewer, targets, { query: "needle", limit: 3 }))
    expect(turns(partial).at(-1)).toEqual([ids[1], 0])
    const rest = await found(
      Search.folder(viewer, [targets[0], targets[2]], { query: "needle", cursor: partial.cursor }),
    )
    expect(turns(rest)).toEqual([
      [ids[2], 0],
      [ids[2], 1],
    ])
    expect(Search.BUDGET_MS).toBe(5000)
  })

  test("an unreadable conversation is passed over; a cancelled search answers cancelled", async () => {
    const { codex } = await make()
    const gone = await codexTarget(codex, threadId(40), repeated(threadId(40), 1, "needle"))
    await fs.rm(gone.file.path)
    const kept = await codexTarget(codex, threadId(41), repeated(threadId(41), 1, "needle"))
    const viewer = View.viewer()
    expect(turns(await found(Search.folder(viewer, [gone, kept], { query: "needle" })))).toEqual([[threadId(41), 0]])
    const controller = new AbortController()
    controller.abort()
    expect(await Search.folder(viewer, [kept], { query: "needle", signal: controller.signal })).toEqual({
      ok: false,
      reason: "cancelled",
    })
  })
})
