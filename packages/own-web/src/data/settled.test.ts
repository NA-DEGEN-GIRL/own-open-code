// Per-message answers of whole-history scans (settled.ts): kept for a message that can no longer change, read again
// for an assistant step that is still running.
import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { perSettledMessage } from "./settled"

test("a settled message is read once; a running step every time", () => {
  const reads: string[] = []
  const read = perSettledMessage((message) => {
    reads.push(message.id)
    return message.id
  })
  const user = { id: "u", type: "user", text: "q", time: { created: 1 } } as unknown as SessionMessageInfo
  const step = (id: string, completed?: number) =>
    ({ id, type: "assistant", content: [], time: { created: 2, completed } }) as unknown as SessionMessageInfo
  const done = step("a", 3)
  const running = step("r")
  for (let pass = 0; pass < 3; pass++) [user, done, running].forEach(read)
  expect(reads).toEqual(["u", "a", "r", "r", "r"])
})
