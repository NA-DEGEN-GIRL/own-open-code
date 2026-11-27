// PresetUsage.message: the root's current user message, found by indexed reads of single messages (never the whole
// context, which in a long computer-use session is hundreds of MB of screenshots).
import { describe, expect, test } from "bun:test"
import { PresetUsage } from "../../src/presets/usage.js"
import { testDeps } from "../support/deps.js"
import { messagesOver } from "../support/session-messages.js"

type Row = { readonly id: string; readonly type: string; readonly status?: string; readonly undone?: number }

async function current(rows: ReadonlyArray<Row>, reads: Array<unknown> = []) {
  const all = messagesOver(() => rows)
  await using t = await testDeps({
    ctx: {
      session: {
        messages: async (input: Parameters<typeof all>[0]) => {
          reads.push(input)
          return all(input)
        },
        context: async () => {
          throw new Error("the whole context must not be read")
        },
      },
    },
  })
  return PresetUsage.message(t.deps, "ses_usage")
}

const user = (id: string): Row => ({ id, type: "user" })
const assistant = (id: string): Row => ({ id, type: "assistant" })
const compaction = (id: string, status = "completed", undone?: number): Row => ({
  id,
  type: "compaction",
  status,
  ...(undone === undefined ? {} : { undone }),
})

describe("PresetUsage.message", () => {
  test("the newest user message when nothing was compacted", async () => {
    expect(await current([user("msg_1"), assistant("msg_2"), user("msg_3"), assistant("msg_4")])).toBe("msg_3")
  })

  test("the first message when the session holds no user message", async () => {
    expect(await current([assistant("msg_1"), assistant("msg_2")])).toBe("msg_1")
    expect(await current([])).toBe(PresetUsage.UNKNOWN_MESSAGE)
  })

  test("a user message after the latest compaction counts, the newest one", async () => {
    const rows = [user("msg_1"), compaction("msg_2"), user("msg_3"), assistant("msg_4"), user("msg_5")]
    expect(await current(rows)).toBe("msg_5")
  })

  test("a context that starts at a compaction with no user message counts against the compaction", async () => {
    expect(await current([user("msg_1"), assistant("msg_2"), compaction("msg_3"), assistant("msg_4")])).toBe("msg_3")
    expect(await current([compaction("msg_1")])).toBe("msg_1")
  })

  test("running, failed and undone compactions bound nothing", async () => {
    const rows = [
      user("msg_1"),
      compaction("msg_2"),
      user("msg_3"),
      compaction("msg_4", "completed", 1),
      compaction("msg_5", "running"),
      compaction("msg_6", "failed"),
      compaction("msg_7", "completed", 2),
      compaction("msg_8", "cancelled"),
      assistant("msg_9"),
    ]
    // msg_2 is past the first page of compactions: the search pages on.
    expect(await current(rows)).toBe("msg_3")
    expect(await current(rows.filter((row) => row.id !== "msg_3"))).toBe("msg_2")
  })

  test("each read asks for at most a few rows", async () => {
    const reads: Array<{ readonly limit?: number }> = []
    await current([user("msg_1"), compaction("msg_2"), user("msg_3")], reads)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((read) => read.limit !== undefined && read.limit <= 4)).toBe(true)
  })

  test("a read that fails counts against the unknown message", async () => {
    await using t = await testDeps({
      ctx: {
        session: {
          messages: async () => {
            throw new Error("Session.NotFoundError")
          },
        },
      },
    })
    expect(await PresetUsage.message(t.deps, "ses_gone")).toBe(PresetUsage.UNKNOWN_MESSAGE)
  })
})
