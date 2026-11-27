// Upstream #58432 and #58439: `controller.abort()` and `new Error()` inside a Solid cleanup record the caller's stack,
// and V8 keeps every frame of it (the disposing batch, detached timeline DOM included) alive for as long as the signal
// or the rejected promise is reachable. own-web's streaming render and its markdown substitutes abort with upstream's
// shared reason and reject with one shared disposal error.
import { describe, expect, test } from "bun:test"
import { markdownBlockKey } from "../../../session-ui/src/components/markdown-worker-protocol"
import { renderCachedMarkdown } from "@/vendor/session-ui/markdown-cache"
import { markdownWorkerDisposed, parseMarkdown } from "@/vendor/session-ui/markdown-worker"
import { createStreamRenderer, type StreamDeps } from "./stream"
import { createTailProjector } from "./tail"

describe("disposal pins no caller stack", () => {
  test("disposing a streamed answer aborts its lifetime with the shared reason", async () => {
    const signals: AbortSignal[] = []
    const projector = createTailProjector()
    const deps: StreamDeps = {
      project: async (key, value, live) => projector.project(key, value, live),
      markdown: (block, _key, _live, signal) => {
        signals.push(signal)
        return new Promise(() => undefined)
      },
      code: async () => ({ language: "text", generation: 1, stable: [], unstable: [] }),
      disposeCode: () => undefined,
      frame: (callback) => void callback(),
      blockKey: (index, mode) => markdownBlockKey("a", "a", index, mode),
      cacheKey: (index, mode) => `a:${index}:${mode}`,
    }
    const renderer = createStreamRenderer({ key: "a", deps, view: { commit: () => undefined, ready: () => undefined } })
    renderer.update("Hello\n\nworld", true)
    for (let round = 0; round < 5 && signals.length === 0; round++)
      await new Promise((resolve) => setImmediate(resolve))
    expect(signals.length).toBeGreaterThan(0)
    function disposeTranscriptRow() {
      renderer.dispose()
    }
    disposeTranscriptRow()
    const reason: unknown = signals[0]?.reason
    expect(signals[0]?.aborted).toBe(true)
    expect(reason).toBeInstanceOf(DOMException)
    expect((reason as DOMException).name).toBe("AbortError")
    expect(String((reason as DOMException).stack)).not.toContain("disposeTranscriptRow")
  })

  test("an aborted parse rejects with the one shared disposal error", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(parseMarkdown("text", controller.signal)).rejects.toBe(markdownWorkerDisposed)
    expect(renderCachedMarkdown({ raw: "x", src: "x" }, "k", controller.signal)).rejects.toBe(markdownWorkerDisposed)
  })
})
