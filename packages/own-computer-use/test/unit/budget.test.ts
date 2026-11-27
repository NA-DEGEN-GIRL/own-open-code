import { describe, expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Effect, Exit } from "effect"
import { Budget } from "../../src/core/budget.js"
import { ComputerError } from "../../src/core/errors.js"

type Message = SessionContext["messages"][number]

const history = { keep: 8, batch: 7 }

const shot = (id: string) => ({
  type: "file" as const,
  uri: "data:image/png;base64,QUJD",
  mime: "image/png",
  name: `${Budget.IMAGE_PREFIX}${id}.png`,
})

// Plain objects shaped like core's lowered messages (`core/src/session/runner/to-llm-message.ts`); core turns them back
// into `Message` instances after the hooks.
const toolResult = (id: string, value: ReadonlyArray<unknown>, name = "computer_screenshot") =>
  ({
    role: "tool",
    content: [{ type: "tool-result", id, name, result: { type: "content", value } }],
  }) as unknown as Message

const userWithImage = {
  role: "user",
  content: [
    { type: "text", text: "look at this" },
    { type: "media", media: { mediaType: "image/png", source: { type: "base64", data: "QUJD" } } },
  ],
} as unknown as Message

const conversation = (count: number) => [
  userWithImage,
  ...Array.from({ length: count }, (_, index) =>
    toolResult(`call_${index}`, [{ type: "text", text: `cap_${index} 1429x804` }, shot(`cap_${index}`)]),
  ),
]

const pruned = (messages: Array<Message>) => {
  const copy = [...messages]
  const removed = Budget.pruneScreenshots(copy, history)
  return { messages: copy, removed }
}

const images = (messages: ReadonlyArray<Message>) => JSON.stringify(messages).split(Budget.IMAGE_PREFIX).length - 1

describe("pruneScreenshots", () => {
  test("keeps everything until keep + batch screenshots, then removes a whole batch of the oldest", () => {
    expect(pruned(conversation(8)).removed).toBe(0)
    expect(pruned(conversation(14)).removed).toBe(0)
    const result = pruned(conversation(15))
    expect(result.removed).toBe(7)
    expect(images(result.messages)).toBe(8)
    expect(JSON.stringify(result.messages[1])).toContain(
      "[Earlier computer-use screenshot cap_0 removed; take a new screenshot if needed.]",
    )
    expect(JSON.stringify(result.messages[7])).toContain("cap_6 removed")
    expect(JSON.stringify(result.messages[8])).toContain(`${Budget.IMAGE_PREFIX}cap_7.png`)
    // The tool's own text part survives; only the image is replaced.
    expect(JSON.stringify(result.messages[1])).toContain("cap_0 1429x804")
    expect(pruned(conversation(22)).removed).toBe(14)
  })

  test("the removal count changes only at batch boundaries", () => {
    const counts = Array.from({ length: 50 }, (_, count) => pruned(conversation(count)).removed)
    counts.forEach((removed, count) => {
      if (count === 0) return
      const boundary = count >= history.keep + history.batch && (count - history.keep) % history.batch === 0
      expect(removed !== counts[count - 1]).toBe(boundary)
      expect(count - removed).toBeLessThanOrEqual(history.keep + history.batch - 1)
      expect(count - removed).toBeGreaterThanOrEqual(Math.min(count, history.keep))
    })
  })

  test("inside a batch the pruned prefix is byte-identical from one request to the next", () => {
    for (const count of [15, 16, 20, 23, 30]) {
      const before = pruned(conversation(count))
      const after = pruned(conversation(count + 1))
      if (before.removed !== after.removed) continue
      expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages))
    }
    // ...and it changes exactly when a boundary is crossed.
    const last = pruned(conversation(21))
    const next = pruned(conversation(22))
    expect(JSON.stringify(next.messages.slice(0, last.messages.length))).not.toBe(JSON.stringify(last.messages))
  })

  test("is idempotent", () => {
    const once = pruned(conversation(23))
    const twice = pruned(once.messages)
    expect(twice.removed).toBe(0)
    expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once.messages))
  })

  test("covers Code Mode results and leaves user images, other files and errors alone", () => {
    const browser = { type: "file", uri: "data:image/png;base64,QUJD", mime: "image/png", name: "browser-capture.png" }
    const unnamed = { type: "file", uri: "data:image/png;base64,QUJD", mime: "image/png" }
    const ownJson = {
      type: "file",
      uri: "data:application/json;base64,e30=",
      mime: "application/json",
      name: `${Budget.IMAGE_PREFIX}state.json`,
    }
    const errorResult = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call_err",
          name: "computer_click",
          result: { type: "error", value: { error: "x", content: [shot("cap_err")] } },
        },
      ],
    } as unknown as Message
    const messages = [
      userWithImage,
      // One Code Mode `execute` result carrying 15 inner screenshots plus foreign files.
      toolResult(
        "call_exec",
        [
          { type: "text", text: "done" },
          browser,
          ...Array.from({ length: 15 }, (_, index) => shot(`cap_${index}`)),
          unnamed,
          ownJson,
        ],
        "execute",
      ),
      errorResult,
    ]
    const result = pruned(messages)
    expect(result.removed).toBe(7)
    const text = JSON.stringify(result.messages)
    expect(text).toContain("browser-capture.png")
    expect(text).toContain(`${Budget.IMAGE_PREFIX}state.json`)
    expect(text).toContain(`${Budget.IMAGE_PREFIX}cap_err.png`)
    expect(text).toContain("cap_6 removed")
    expect(text).toContain(`${Budget.IMAGE_PREFIX}cap_7.png`)
    expect(result.messages[0]).toBe(userWithImage)
    expect(result.messages[2]).toBe(errorResult)
  })

  test("unchanged messages keep their identity", () => {
    const messages = conversation(15)
    const result = pruned(messages)
    expect(result.messages[0]).toBe(messages[0])
    expect(result.messages[8]).toBe(messages[8])
    expect(result.messages[1]).not.toBe(messages[1])
  })
})

describe("encoding ladder", () => {
  const capture = (sizes: Readonly<Record<string, number>>, calls: Array<string>) => (encoding: Budget.Encoding) => {
    const key = encoding.format === "png" ? "png" : `jpeg${encoding.quality}`
    calls.push(key)
    return Effect.succeed({ data: new Uint8Array(sizes[key] ?? 0) })
  }

  test("PNG is used when it fits", async () => {
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Budget.encodeWithin({ format: "auto", maxBase64Bytes: 4_500_000 }, capture({ png: 3_000_000 }, calls)),
    )
    expect(result.encoding).toEqual({ format: "png" })
    expect(calls).toEqual(["png"])
  })

  test("falls down the JPEG ladder until the base64 form fits", async () => {
    const calls: Array<string> = []
    const result = await Effect.runPromise(
      Budget.encodeWithin(
        { format: "auto", maxBase64Bytes: 4_500_000 },
        capture({ png: 5_000_000, jpeg85: 3_500_000, jpeg75: 3_000_000, jpeg60: 1_000_000 }, calls),
      ),
    )
    expect(result.encoding).toEqual({ format: "jpeg", quality: 75 })
    expect(calls).toEqual(["png", "jpeg85", "jpeg75"])
    expect(Budget.base64Length(result.capture.data.byteLength)).toBeLessThanOrEqual(4_500_000)
  })

  test("never returns an image over the limit", async () => {
    for (const limit of [100_000, 1_000_000, 4_500_000])
      for (const scale of [0.5, 0.8, 1, 1.2, 2, 5]) {
        const sizes = {
          png: limit * scale,
          jpeg85: limit * scale * 0.7,
          jpeg75: limit * scale * 0.6,
          jpeg60: limit * scale * 0.5,
        }
        const exit = await Effect.runPromiseExit(
          Budget.encodeWithin({ format: "auto", maxBase64Bytes: limit }, capture(sizes, [])),
        )
        if (Exit.isSuccess(exit))
          expect(Budget.base64Length(exit.value.capture.data.byteLength)).toBeLessThanOrEqual(limit)
        if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("image_too_large")
      }
  })

  test("png-only fails instead of falling back to JPEG", async () => {
    const calls: Array<string> = []
    const exit = await Effect.runPromiseExit(
      Budget.encodeWithin({ format: "png", maxBase64Bytes: 1_000 }, capture({ png: 5_000, jpeg85: 10 }, calls)),
    )
    expect(calls).toEqual(["png"])
    expect(Exit.isFailure(exit)).toBe(true)
    const error = await Effect.runPromise(
      Effect.flip(Budget.encodeWithin({ format: "png", maxBase64Bytes: 1_000 }, capture({ png: 5_000 }, []))),
    )
    expect(error).toBeInstanceOf(ComputerError)
    expect((error as ComputerError).code).toBe("image_too_large")
    expect(error.message).toContain("[computer.image_too_large]")
  })

  test("base64 length", () => {
    expect(Budget.base64Length(0)).toBe(0)
    expect(Budget.base64Length(1)).toBe(4)
    expect(Budget.base64Length(3)).toBe(4)
    expect(Budget.base64Length(4)).toBe(8)
    expect(Buffer.from(new Uint8Array(1000)).toString("base64").length).toBe(Budget.base64Length(1000))
  })
})

describe("request image budget", () => {
  // Core's trigger (`IMAGE_BYTES_TRIGGER`, core/src/session/model-request.ts): above it core replaces the oldest images.
  const CORE_TRIGGER = 25 * 1024 * 1024

  // Image bytes of a request as core counts them for tool results: the data URI of every image file.
  const coreBytes = (messages: ReadonlyArray<Message>) =>
    messages.reduce(
      (total, message) =>
        total +
        message.content.reduce((sum, part) => {
          if (part.type !== "tool-result" || part.result.type !== "content") return sum
          return (
            sum +
            part.result.value.reduce(
              (bytes, item) => bytes + (item.type === "file" && item.mime.startsWith("image/") ? item.uri.length : 0),
              0,
            )
          )
        }, 0),
      0,
    )

  test("the per-image limit fits the most a request carries into the budget, and never exceeds the option", () => {
    expect(Budget.REQUEST_BYTES).toBeLessThan(CORE_TRIGGER)
    expect(Budget.imageLimit(4_500_000, history)).toBe(1_497_942)
    for (const keep of [1, 4, 8, 16, 32])
      for (const batch of [1, 7, 16, 32]) {
        const limit = Budget.imageLimit(4_500_000, { keep, batch })
        const prefix = "data:image/jpeg;base64,".length
        expect((keep + batch - 1) * (limit + prefix)).toBeLessThanOrEqual(Budget.REQUEST_BYTES)
        expect(limit).toBeLessThanOrEqual(4_500_000)
        expect(limit).toBeGreaterThan(300_000)
      }
    expect(Budget.imageLimit(200_000, history)).toBe(200_000)
  })

  test("screenshots at the limit never reach core's trigger after pruning, so the cut stays on batch boundaries", () => {
    // One string shared by every image keeps this cheap.
    const uri = `data:image/jpeg;base64,${"A".repeat(Budget.imageLimit(4_500_000, history))}`
    const big = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        toolResult(`call_${index}`, [
          { type: "file", uri, mime: "image/jpeg", name: `${Budget.IMAGE_PREFIX}cap_${index}.jpg` },
        ]),
      )
    for (const count of Array.from({ length: 50 }, (_, index) => index + 1)) {
      const messages = big(count)
      const removed = Budget.pruneScreenshots(messages, history)
      expect(coreBytes(messages)).toBeLessThanOrEqual(Budget.REQUEST_BYTES)
      expect(count - removed).toBeGreaterThanOrEqual(Math.min(count, history.keep))
      expect(removed % history.batch).toBe(0)
    }
  })
})
