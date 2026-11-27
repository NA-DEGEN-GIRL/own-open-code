import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Audit } from "../../src/core/audit.js"

const dirs: Array<string> = []
const tempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "own-cu-audit-"))
  dirs.push(dir)
  return dir
}
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

const entry = (input: Partial<Audit.Entry> & { readonly ts: number }): Audit.Entry => ({
  sessionID: "ses_a",
  callID: "call_1",
  tool: "left_click",
  args: { coordinate: [1, 2] },
  outcome: "ok",
  ms: 12,
  ...input,
})

describe("audit", () => {
  test("typed text is reduced to its length, with no hash a short value could be found from; other arguments stay", () => {
    const secret = "correct horse battery staple"
    const redacted = Audit.redactArgs("type", { text: secret })
    expect(redacted).toEqual({ text: { length: secret.length } })
    expect(JSON.stringify(redacted)).not.toContain("horse")
    // A 6-digit code: nothing derived from the digits is kept.
    expect(Audit.redactArgs("type", { text: "493817" })).toEqual({ text: { length: 6 } })
    expect(Audit.redactArgs("key", { text: "ctrl+c", repeat: 2 })).toEqual({
      text: { chords: ["ctrl+c"], characters: 0 },
      repeat: 2,
    })
    expect(Audit.redactArgs("left_click", { coordinate: [3, 4], text: "shift" })).toEqual({
      coordinate: [3, 4],
      text: "shift",
    })
    expect(Audit.titleHash("Inbox - mail")).toMatch(/^[0-9a-f]{12}$/)
    expect(Audit.titleHash("Inbox - mail")).not.toBe(Audit.titleHash("Inbox - mail 2"))
  })

  test("key presses that type a character are only counted; the other chords stay, in order", () => {
    // A PIN or one-time code pressed key by key is typed text too.
    const pin = Audit.redactArgs("key", { text: "4 9 3 8 1 7 Return" })
    expect(pin).toEqual({ text: { chords: ["Return"], characters: 6 } })
    expect(JSON.stringify(pin)).not.toMatch(/[0-9]{2}|"[0-9]"/)
    expect(Audit.redactArgs("key", { text: "ctrl+a shift+h i space Tab ctrl+s" })).toEqual({
      text: { chords: ["ctrl+a", "Tab", "ctrl+s"], characters: 3 },
    })
    expect(Audit.redactArgs("hold_key", { text: "shift", duration: 1 })).toEqual({
      text: { chords: ["shift"], characters: 0 },
      duration: 1,
    })
    expect(Audit.redactArgs("hold_key", { text: "x", duration: 1 })).toEqual({
      text: { chords: [], characters: 1 },
      duration: 1,
    })
  })

  test("entries are partitioned by UTC month", () => {
    expect(Audit.monthFile(Date.UTC(2026, 0, 31, 23, 59, 59))).toBe("computer-2026-01.jsonl")
    expect(Audit.monthFile(Date.UTC(2026, 1, 1))).toBe("computer-2026-02.jsonl")
    expect(Audit.monthFile(Date.UTC(2026, 11, 31, 12))).toBe("computer-2026-12.jsonl")
  })

  test("append writes JSON lines that list reads back newest first, by session and before a time", async () => {
    const dir = await tempDir()
    const january = Date.UTC(2026, 0, 10)
    const february = Date.UTC(2026, 1, 10)
    await Effect.runPromise(
      Effect.forEach(
        [
          entry({ ts: january, callID: "c1" }),
          entry({ ts: january + 1_000, callID: "c2", sessionID: "ses_b" }),
          entry({
            ts: february,
            callID: "c3",
            outcome: "denied",
            code: "app_denied",
            target: { app: "cmd", titleHash: "abc" },
          }),
          entry({ ts: february + 1_000, callID: "c4" }),
        ],
        (item) => Audit.append(dir, item),
        { discard: true },
      ),
    )
    expect((await readFile(path.join(dir, "computer-2026-01.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2)
    // A torn or foreign line never breaks reading.
    await writeFile(path.join(dir, "computer-2026-02.jsonl"), "{not json\n", { flag: "a" })
    await writeFile(path.join(dir, "notes.txt"), "ignored")

    const all = await Effect.runPromise(Audit.list(dir, { limit: 10 }))
    expect(all.map((item) => item.callID)).toEqual(["c4", "c3", "c2", "c1"])
    expect(all[1]).toMatchObject({ outcome: "denied", code: "app_denied", target: { app: "cmd", titleHash: "abc" } })
    expect((await Effect.runPromise(Audit.list(dir, { limit: 2 }))).map((item) => item.callID)).toEqual(["c4", "c3"])
    expect(
      (await Effect.runPromise(Audit.list(dir, { limit: 10, sessionID: "ses_b" }))).map((item) => item.callID),
    ).toEqual(["c2"])
    expect(
      (await Effect.runPromise(Audit.list(dir, { limit: 10, before: february }))).map((item) => item.callID),
    ).toEqual(["c2", "c1"])
  })

  test("a failing write never fails the caller, and a missing directory lists nothing", async () => {
    const dir = await tempDir()
    const file = path.join(dir, "not-a-directory")
    await writeFile(file, "x")
    const exit = await Effect.runPromiseExit(
      Audit.append(path.join(file, "audit"), entry({ ts: Date.UTC(2026, 0, 1) })),
    )
    expect(exit._tag).toBe("Success")
    expect(await Effect.runPromise(Audit.list(path.join(dir, "missing"), { limit: 10 }))).toEqual([])
  })
})
