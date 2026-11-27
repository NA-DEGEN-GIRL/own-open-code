// Pure parts of the `@` mentions (03 §18.12): trigger detection (same rules as upstream suggestions/machine.ts,
// bounded), ranking, `#L10-40` ranges, the prompt parts and file URIs (Windows `#` paths, Hangul).
import { describe, expect, test } from "bun:test"
import { chipID, chipToken, createChipStore, fileUri, mentionParts } from "./chips"
import { matchClass, rank, score } from "./rank"
import { formatRange, splitRange } from "./range"
import { detectTrigger } from "./trigger"

describe("detectTrigger", () => {
  test("@ at the start or after whitespace opens the mention list with the word before the caret", () => {
    expect(detectTrigger("@rou", 4)).toEqual({ kind: "mention", query: "rou", start: 0, end: 4 })
    expect(detectTrigger("look at @src/rou", 16)).toEqual({ kind: "mention", query: "src/rou", start: 8, end: 16 })
    expect(detectTrigger("줄바꿈\n@", 5)).toEqual({ kind: "mention", query: "", start: 4, end: 5 })
    // The replaced range covers the rest of the word after the caret.
    expect(detectTrigger("@router.ts please", 3)).toEqual({ kind: "mention", query: "ro", start: 0, end: 10 })
  })

  test("e-mail addresses, finished words and a second @ do not open it", () => {
    expect(detectTrigger("mail me@example.com", 19)).toBeUndefined()
    expect(detectTrigger("@router.ts ", 11)).toBeUndefined()
    expect(detectTrigger("@a@b", 4)).toBeUndefined()
  })

  test("/ at the very start lists commands while the caret is in the first word", () => {
    expect(detectTrigger("/", 1)).toEqual({ kind: "command", query: "", start: 0, end: 1 })
    expect(detectTrigger("/rev", 4)).toEqual({ kind: "command", query: "rev", start: 0, end: 4 })
    expect(detectTrigger("/review main", 3)).toEqual({ kind: "command", query: "re", start: 0, end: 7 })
    expect(detectTrigger("see /rev", 8)).toBeUndefined()
  })

  test("after `/name ` only commands with arguments open a list or hint", () => {
    const has = (name: string) => name === "agent"
    expect(detectTrigger("/agent pl", 9, has)).toEqual({
      kind: "argument",
      command: "agent",
      query: "pl",
      start: 0,
      end: 9,
    })
    expect(detectTrigger("/compact now", 12, has)).toBeUndefined()
    expect(detectTrigger("/agent a\nb", 10, has)).toBeUndefined()
  })

  test("a mention inside command arguments wins", () => {
    expect(detectTrigger("/review @src", 12, () => true)).toEqual({ kind: "mention", query: "src", start: 8, end: 12 })
  })

  test("work is bounded by the word, not the text (PF2)", () => {
    const long = `${"x ".repeat(200_000)}@rou`
    const started = performance.now()
    for (let run = 0; run < 1_000; run++) detectTrigger(long, long.length)
    expect(performance.now() - started).toBeLessThan(200)
    expect(detectTrigger(`@${"a".repeat(600)}`, 601)).toBeUndefined()
  })
})

describe("rank", () => {
  test("exact > prefix > word start > substring > letters in order; no match is dropped", () => {
    expect(score("review", "review")).toBeGreaterThan(score("reviewer", "review"))
    expect(score("reviewer", "rev")).toBeGreaterThan(score("code-review", "rev"))
    expect(score("code-review", "rev")).toBeGreaterThan(score("prevent", "rev"))
    expect(score("prevent", "rev")).toBeGreaterThan(score("r-e-v", "rev"))
    expect(score("abc", "xyz")).toBe(-1)
  })

  test("keeps catalog order on ties, prefers the first key, respects the limit", () => {
    const items = ["docs:summarize", "summary", "sum", "review"]
    expect(rank(items, "sum", (item) => [item], 10)).toEqual(["sum", "summary", "docs:summarize"])
    expect(rank(items, "", (item) => [item], 2)).toEqual(["docs:summarize", "summary"])
    const described = [
      { name: "a", description: "explore the code" },
      { name: "explore", description: "" },
    ]
    expect(rank(described, "explore", (item) => [item.name, item.description], 5).map((item) => item.name)).toEqual([
      "explore",
      "a",
    ])
  })

  test("match classes: a prefix counts with an exact match, whatever the name's length", () => {
    expect(matchClass(score("review", "review"))).toBe(3)
    expect(matchClass(score("reviewer", "rev"))).toBe(3)
    expect(matchClass(score(`rev${"x".repeat(200)}`, "rev"))).toBe(3)
    expect(matchClass(score("code-review", "rev"))).toBe(2)
    expect(matchClass(score(`${"x".repeat(200)}-rev`, "rev"))).toBe(2)
    expect(matchClass(score("prevent", "rev"))).toBe(1)
    expect(matchClass(score(`${"x".repeat(200)}rev`, "rev"))).toBe(1)
    expect(matchClass(score("r-e-v", "rev"))).toBe(0)
  })

  test("Hangul queries match by substring (partial syllables while composing)", () => {
    expect(rank(["리뷰 도우미", "문서 요약"], "요약", (item) => [item], 5)).toEqual(["문서 요약"])
  })
})

describe("line ranges", () => {
  test("#L10-40, #L10, #10-40 and half-typed suffixes", () => {
    expect(splitRange("router#L10-40")).toEqual({ query: "router", range: { start: 10, end: 40 } })
    expect(splitRange("router#L40-10")).toEqual({ query: "router", range: { start: 10, end: 40 } })
    expect(splitRange("router#L7")).toEqual({ query: "router", range: { start: 7 } })
    expect(splitRange("router#12-14")).toEqual({ query: "router", range: { start: 12, end: 14 } })
    expect(splitRange("router#L10-")).toEqual({ query: "router", range: { start: 10 } })
    expect(splitRange("router#")).toEqual({ query: "router" })
    expect(splitRange("router")).toEqual({ query: "router" })
    expect(formatRange({ start: 10, end: 40 })).toBe("#L10-40")
    expect(formatRange({ start: 3 })).toBe("#L3")
  })
})

describe("prompt parts", () => {
  test("file URIs percent-encode every segment and keep the drive colon", () => {
    expect(fileUri("D:\\#Projects\\own open", "src/라우터.ts")).toBe(
      "file:///D:/%23Projects/own%20open/src/%EB%9D%BC%EC%9A%B0%ED%84%B0.ts",
    )
    expect(fileUri("/home/me/repo", "a/b%c.ts", { start: 10, end: 40 })).toBe(
      "file:///home/me/repo/a/b%25c.ts?start=10&end=40",
    )
    expect(fileUri("/home/me/repo", "C:\\refs\\docs", undefined)).toBe("file:///C:/refs/docs")
    expect(fileUri("/r", "x.ts", { start: 5 })).toBe("file:///r/x.ts?start=5&end=5")
  })

  test("a prompt gets a token line and mention spans; resources become a text line", () => {
    const parts = mentionParts({
      text: "이 부분 고쳐줘",
      directory: "/repo",
      chips: [
        { kind: "file", path: "src/router.ts", range: { start: 10, end: 40 } },
        { kind: "agent", name: "explore" },
        { kind: "skill", id: "review-guide", name: "Review guide" },
        { kind: "reference", name: "docs", path: "/refs/docs" },
        { kind: "resource", server: "wiki", uri: "wiki://page/42", name: "Onboarding" },
      ],
    })
    const head = "@src/router.ts#L10-40 @explore @review-guide @docs"
    expect(parts.text).toBe(`${head}\n이 부분 고쳐줘\nMCP resource "Onboarding" (server: wiki, uri: wiki://page/42)`)
    expect(parts.files).toEqual([
      {
        uri: "file:///repo/src/router.ts?start=10&end=40",
        name: "router.ts#L10-40",
        mention: { start: 0, end: 21, text: "@src/router.ts#L10-40" },
      },
      { uri: "file:///refs/docs", name: "docs", mention: { start: 45, end: 50, text: "@docs" } },
    ])
    expect(parts.agents).toEqual([{ name: "explore", mention: { start: 22, end: 30, text: "@explore" } }])
    expect(parts.skills).toEqual([{ id: "review-guide", mention: { start: 31, end: 44, text: "@review-guide" } }])
    for (const part of [...parts.files!, ...parts.agents!, ...parts.skills!])
      expect(parts.text.slice(part.mention!.start, part.mention!.end)).toBe(part.mention!.text)
  })

  test("a server command keeps its argument text as is", () => {
    const parts = mentionParts({
      text: "main",
      directory: "/repo",
      inline: false,
      chips: [
        { kind: "agent", name: "explore" },
        { kind: "file", path: "a.ts" },
      ],
    })
    expect(parts).toEqual({
      text: "main",
      files: [{ uri: "file:///repo/a.ts", name: "a.ts" }],
      agents: [{ name: "explore" }],
    })
  })

  test("no chips: the text only; duplicate URIs are sent once", () => {
    expect(mentionParts({ text: "hi", chips: [], directory: "/r" })).toEqual({ text: "hi" })
    const parts = mentionParts({
      text: "x",
      directory: "/r",
      chips: [
        { kind: "file", path: "docs", directory: true },
        { kind: "reference", name: "docs", path: "/r/docs" },
      ],
    })
    expect(parts.files?.map((file) => file.uri)).toEqual(["file:///r/docs"])
  })
})

describe("chip store", () => {
  test("per draft, deduplicated, take/restore/move", () => {
    const store = createChipStore()
    const file = { kind: "file", path: "a.ts", range: { start: 1, end: 2 } } as const
    expect(store.add("s1", file)).toBe(true)
    expect(store.add("s1", { ...file })).toBe(false)
    expect(store.add("s1", { kind: "file", path: "a.ts" })).toBe(true)
    expect(store.list("s2")).toEqual([])
    expect(chipToken(file)).toBe("@a.ts#L1-2")
    const taken = store.take("s1")
    expect(taken).toHaveLength(2)
    expect(store.list("s1")).toEqual([])
    store.restore("s1", taken)
    store.remove("s1", chipID(file))
    expect(store.list("s1").map(chipID)).toEqual(["file:a.ts"])
    store.move("s1", "s3")
    expect(store.list("s3").map(chipID)).toEqual(["file:a.ts"])
    expect(store.list("s1")).toEqual([])
  })
})
