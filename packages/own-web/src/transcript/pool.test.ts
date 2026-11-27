import { describe, expect, test } from "bun:test"
import { createViewPool, type PooledView } from "./pool"

describe("transcript view pool", () => {
  test("one budget for the detached views of every pane; shown views never count and are never evicted", () => {
    const pool = createViewPool(2)
    const evicted: string[] = []
    const view = (name: string): PooledView => ({ evict: () => void evicted.push(name) })
    // Pane 1 walks through a, b, c; pane 2 shows x the whole time.
    const [a, b, c, d, x] = ["a", "b", "c", "d", "x"].map(view)
    pool.attach(x!)
    pool.attach(a!)
    pool.detach(a!)
    pool.attach(b!)
    pool.detach(b!)
    pool.attach(c!)
    expect(evicted).toEqual([])
    expect(pool.size()).toBe(4)
    expect(pool.attachedCount()).toBe(2)
    // A third detached view: the least recently used detached one (a) goes, whichever pane kept it.
    pool.detach(c!)
    pool.attach(d!)
    expect(evicted).toEqual(["a"])
    // Re-attaching b makes it the most recent; the next overflow evicts c.
    pool.attach(b!)
    pool.detach(d!)
    pool.detach(b!)
    expect(evicted).toEqual(["a", "c"])
    // x stayed attached through all of it.
    expect(evicted).not.toContain("x")
    // A closed pane's views leave without a callback.
    pool.forget(x!)
    expect(pool.attachedCount()).toBe(0)
    expect(evicted).not.toContain("x")
  })
})
