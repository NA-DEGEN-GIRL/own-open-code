import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { Transcript } from "../../src/transcript/ir.js"

const T0 = Date.UTC(2026, 9, 8, 9)

function turn(index: number, time: number, steps: Transcript.Step[] = [], text = `request ${index}`): Transcript.Turn {
  return { index, time, user: { text, images: [] }, steps, end: "completed" }
}

const sample: Transcript.Info = {
  source: {
    kind: "codex",
    id: "019a0000-0000-7000-8000-000000000001",
    rootID: "codex-0123456789ab",
    path: "C:\\fixture\\codex\\sessions\\2026\\10\\08\\rollout-2026-10-08T09-00-00-x.jsonl",
    versions: ["0.140.0", "0.153.0"],
    app: "cli",
    cwds: ["\\\\?\\C:\\work\\proj"],
    branch: "main",
    title: "설치기 정리",
    firstPrompt: "installer cleanup",
    models: [{ provider: "openai", id: "gpt-5.5" }],
    createdAt: T0,
    updatedAt: T0 + 60_000,
    bytes: 1234,
    base: { id: "019a0000-0000-7000-8000-000000000000", endByteOffset: 512 },
    subagent: false,
    live: false,
  },
  turns: [
    {
      index: 0,
      time: T0,
      user: { text: "고쳐 줘", images: [{ mime: "image/png", bytes: 3, data: "AAEC" }] },
      steps: [
        { type: "reasoning-summary", text: "thinking about it", time: T0 + 1 },
        {
          type: "tool",
          name: "exec_command",
          input: { cmd: ["bun", "test"], workdir: "C:\\work\\proj" },
          output: { text: "ok", error: false },
          exit: 0,
          time: T0 + 2,
        },
        {
          type: "tool",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
          output: { text: "done", error: false, truncatedFrom: 9000 },
          diff: [{ file: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" }],
          time: T0 + 3,
        },
        { type: "tool", name: "spawn_agent", input: {}, child: "child-1", time: T0 + 4 },
        { type: "note", text: "task finished", time: T0 + 5 },
        { type: "text", text: "고쳤습니다", model: "gpt-5.5", time: T0 + 6 },
      ],
      end: "completed",
    },
    { index: 1, time: T0 + 10, user: { text: "더", images: [], queued: true }, steps: [], end: "open" },
  ],
  checkpoints: [
    {
      at: { turn: 0, step: 2, source: { ordinal: 17 } },
      kind: "codex-remote",
      recent: [{ role: "user", text: "[User]: 고쳐 줘" }],
      trigger: "auto",
    },
    {
      at: { turn: 1, step: 0, source: { uuid: "6c1f2b3a-0000-4000-8000-000000000001" } },
      kind: "foreign",
      summary: "summary",
      recent: [
        { role: "assistant", text: "a" },
        { role: "tool-call", text: "b" },
        { role: "tool-result", text: "c" },
      ],
      preTokens: 100,
      postTokens: 10,
    },
  ],
  children: [{ id: "child-1", title: "explorer", agent: "explore", at: { turn: 0, step: 3 } }],
  dropped: { encryptedReasoning: 2, tornLine: 1 },
  usage: { input: 10, output: 5, cached: 2 },
}

describe("Transcript IR (09 §2.4)", () => {
  test("a complete transcript decodes to the same value", () => {
    const decoded = Transcript.decode(sample)
    expect(Result.isSuccess(decoded)).toBe(true)
    expect(Result.getOrUndefined(decoded)).toEqual(sample)
  })

  test.each([
    ["an unknown step type", { ...sample, turns: [turn(0, T0, [{ type: "image", time: T0 } as never])] }],
    ["a time that is not finite", { ...sample, turns: [turn(0, Number.NaN)] }],
    ["a negative index", { ...sample, turns: [turn(-1, T0)] }],
    ["a negative drop count", { ...sample, dropped: { tornLine: -1 } }],
    ["an unknown checkpoint kind", { ...sample, checkpoints: [{ ...sample.checkpoints[0], kind: "native" }] }],
    [
      "a checkpoint anchor without uuid or ordinal",
      { ...sample, checkpoints: [{ ...sample.checkpoints[0], at: { turn: 0, step: 0, source: {} } }] },
    ],
    ["an unknown source kind", { ...sample, source: { ...sample.source, kind: "gemini" } }],
  ])("rejects %s", (_name, input) => {
    expect(Result.isFailure(Transcript.decode(input))).toBe(true)
  })

  test("a drop kind it does not know is left out", () => {
    const decoded = Transcript.decode({ ...sample, dropped: { tornLine: 1, somethingElse: 1 } })
    expect(Result.getOrUndefined(decoded)?.dropped).toEqual({ tornLine: 1 })
  })

  test("drop adds to the count of one kind", () => {
    const once = Transcript.drop({}, "unknownRecord")
    expect(Transcript.drop(once, "unknownRecord", 2)).toEqual({ unknownRecord: 3 })
    expect(Transcript.drop(once, "thinking")).toEqual({ unknownRecord: 1, thinking: 1 })
  })
})

describe("repairTimes", () => {
  const text = (time: number): Transcript.Step => ({ type: "text", text: "x", time })

  test("missing and backward times become the previous time + 1 ms; equal and later times stay", () => {
    const repaired = Transcript.repairTimes(
      [
        turn(0, Number.NaN, [text(Number.NaN), text(T0 + 5), text(T0 + 5)]),
        turn(1, T0 + 2, [text(T0 + 1), text(Number.POSITIVE_INFINITY)]),
        turn(2, T0 + 100, [text(T0 + 200)]),
      ],
      T0,
    )
    expect(repaired.map((item) => [item.time, item.steps.map((step) => step.time)])).toEqual([
      [T0, [T0 + 1, T0 + 5, T0 + 5]],
      [T0 + 6, [T0 + 7, T0 + 8]],
      [T0 + 100, [T0 + 200]],
    ])
  })

  test("the first time falls back to start, then 0", () => {
    expect(Transcript.repairTimes([turn(0, Number.NaN)], 42)[0].time).toBe(42)
    expect(Transcript.repairTimes([turn(0, Number.NaN)])[0].time).toBe(0)
  })

  test("repaired turns decode", () => {
    const repaired = Transcript.repairTimes([turn(0, Number.NaN, [text(Number.NaN)])], T0)
    expect(Result.isSuccess(Transcript.decode({ ...sample, turns: repaired }))).toBe(true)
  })
})

describe("contentHash (09 §4.7, §4.8)", () => {
  test("a sha256 hex digest, the same for the same turns", () => {
    const hash = Transcript.contentHash(sample.turns)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Transcript.contentHash(structuredClone(sample.turns))).toBe(hash)
  })

  test("normalized: key order, CRLF and NFD do not change it, absent optionals equal undefined ones", () => {
    const base = [turn(0, T0, [{ type: "text", text: "줄 하나\n줄 둘", time: T0 + 1 }], "한글 요청")]
    const reordered = [
      {
        end: "completed" as const,
        steps: [{ time: T0 + 1, text: "줄 하나\r\n줄 둘".normalize("NFD"), type: "text" as const, model: undefined }],
        user: { images: [], text: "한글 요청".normalize("NFD"), queued: undefined },
        time: T0,
        index: 0,
      },
    ]
    expect(Transcript.contentHash(reordered)).toBe(Transcript.contentHash(base))
  })

  test("any content change changes it", () => {
    const base = [turn(0, T0, [{ type: "text", text: "a", time: T0 + 1 }])]
    const hash = Transcript.contentHash(base)
    expect(Transcript.contentHash([turn(0, T0, [{ type: "text", text: "b", time: T0 + 1 }])])).not.toBe(hash)
    expect(Transcript.contentHash([turn(0, T0 + 1, [{ type: "text", text: "a", time: T0 + 1 }])])).not.toBe(hash)
    expect(Transcript.contentHash([{ ...base[0], end: "interrupted" }])).not.toBe(hash)
    expect(Transcript.contentHash([...base, turn(1, T0 + 2)])).not.toBe(hash)
  })

  test("a source that only grew keeps the hash of its first turns", () => {
    const before = [turn(0, T0), turn(1, T0 + 1)]
    const grown = [...before, turn(2, T0 + 2), turn(3, T0 + 3)]
    expect(Transcript.contentHash(grown.slice(0, 2))).toBe(Transcript.contentHash(before))
  })
})
