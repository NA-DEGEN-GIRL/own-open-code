// markAfterPaint (03 §20.1 PF1 "rAF 2번"): never before the first contentful paint was presented (PF1 honesty on
// a cold GPU process, 05 §9.1), and plain two frames where paint timing does not exist.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { markAfterPaint } from "./marks"

type Observer = { callback: () => void; disconnected: boolean }
const saved = {
  raf: globalThis.requestAnimationFrame,
  observer: globalThis.PerformanceObserver,
  getEntriesByName: performance.getEntriesByName.bind(performance),
}
let frames: (() => void)[] = []
let observers: Observer[] = []
let fcp: number | undefined

beforeEach(() => {
  frames = []
  observers = []
  fcp = undefined
  globalThis.requestAnimationFrame = ((callback: () => void) => frames.push(callback)) as typeof requestAnimationFrame
  class FakeObserver {
    static supportedEntryTypes = ["paint", "mark"]
    private readonly entry: Observer
    constructor(callback: () => void) {
      this.entry = { callback, disconnected: false }
      observers.push(this.entry)
    }
    observe() {}
    disconnect() {
      this.entry.disconnected = true
    }
  }
  globalThis.PerformanceObserver = FakeObserver as unknown as typeof PerformanceObserver
  performance.getEntriesByName = ((name: string, type?: string) =>
    name === "first-contentful-paint" && fcp !== undefined
      ? [{ startTime: fcp, name, entryType: "paint" }]
      : saved.getEntriesByName(name, type)) as typeof performance.getEntriesByName
})

afterEach(() => {
  globalThis.requestAnimationFrame = saved.raf
  globalThis.PerformanceObserver = saved.observer
  performance.getEntriesByName = saved.getEntriesByName
})

const runFrames = () => {
  while (frames.length) frames.shift()!()
}
const mark = (name: string) => saved.getEntriesByName(name, "mark")[0]

describe("markAfterPaint", () => {
  test("first contentful paint already presented: marks after two frames", () => {
    fcp = 5
    markAfterPaint("own:panel-open:test-a")
    expect(mark("own:panel-open:test-a")).toBeUndefined()
    runFrames()
    expect(mark("own:panel-open:test-a")).toBeDefined()
  })

  test("no first contentful paint yet: waits for it and marks at its presentation time", () => {
    markAfterPaint("own:panel-open:test-b")
    runFrames()
    expect(mark("own:panel-open:test-b")).toBeUndefined()
    expect(observers).toHaveLength(1)
    fcp = performance.now() + 250
    observers[0]!.callback()
    expect(observers[0]!.disconnected).toBe(true)
    expect(mark("own:panel-open:test-b")?.startTime).toBe(fcp)
  })

  test("without paint timing it is two frames", () => {
    ;(globalThis.PerformanceObserver as unknown as { supportedEntryTypes: string[] }).supportedEntryTypes = []
    markAfterPaint("own:panel-open:test-c")
    runFrames()
    expect(mark("own:panel-open:test-c")).toBeDefined()
    expect(observers).toHaveLength(0)
  })
})
