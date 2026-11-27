// 03 §4.3 순서와 고정: a server's project list in the browser (./project-list.ts) — read on connect, kept for the next
// start, changed by the service's event, and browser-only on a service that does not have it until it does.
import { afterEach, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { OwnRpcError } from "@/data"
import type { ProjectListView } from "./arrange"
import { createProjectList, type ProjectListRuntime } from "./project-list"

const KEY = "own.web.sidebar.projects.h-one"
const EMPTY: ProjectListView = { pinned: [], order: null, orderedAt: null }

afterEach(() => localStorage.clear())

function rig(answer: (method: string, input: unknown) => Promise<unknown>, allowed = (_method: string) => true) {
  const [status, setStatus] = createSignal<"connected" | "connecting">("connecting")
  const calls: { method: string; input: unknown }[] = []
  let changed: ((event: { data: { list: ProjectListView } }) => void) | undefined
  // SAFETY: the list reads only these members of a runtime.
  const runtime = {
    connection: { status },
    rpc: {
      allowed,
      call: (method: string, input: unknown) => {
        calls.push({ method, input })
        return answer(method, input)
      },
    },
    own: {
      on: (_name: string, listener: typeof changed) => {
        changed = listener
        return () => {}
      },
    },
  } as unknown as ProjectListRuntime
  return createRoot((dispose) => ({
    list: createProjectList("h-one", runtime),
    calls,
    setStatus,
    emit: (list: ProjectListView) => changed!({ data: { list } }),
    dispose,
  }))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("read once connected, kept for the next start, changed by the service's event", async () => {
  const saved = { pinned: ["a"], order: ["b"], orderedAt: 5 }
  const first = rig(async () => saved)
  expect(first.list.view()).toEqual(EMPTY)
  expect(first.list.can()).toBe(false)
  first.setStatus("connected")
  await settle()
  expect(first.list.view()).toEqual(saved)
  expect(first.list.can()).toBe(true)
  first.emit({ pinned: ["c"], order: null, orderedAt: null })
  expect(first.list.view().pinned).toEqual(["c"])
  first.dispose()
  // The next start paints it before the service answers.
  const next = rig(() => new Promise(() => {}))
  expect(next.list.view().pinned).toEqual(["c"])
  next.dispose()
})

test("an older service: browser only, then handed over once", async () => {
  const old = rig(async () => {
    throw new OwnRpcError("rpc.method_not_found", "no such method")
  })
  old.setStatus("connected")
  await settle()
  expect(old.list.unsupported()).toBe(true)
  old.list.apply({ pinned: ["a"], order: ["b"], orderedAt: 7 }, true)
  old.dispose()

  const updated = rig(async (method, input) =>
    method === "projectList.get" ? EMPTY : { ...(input as object), orderedAt: 9 },
  )
  expect(updated.list.view().pinned).toEqual(["a"])
  updated.setStatus("connected")
  await settle()
  await settle()
  expect(updated.calls.map((call) => call.method)).toEqual(["projectList.get", "projectList.set"])
  expect(updated.list.view()).toEqual({ pinned: ["a"], order: ["b"], orderedAt: 9 })
  expect(updated.list.unsupported()).toBe(false)
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ pinned: ["a"], order: ["b"], orderedAt: 9 })
  updated.dispose()
})

test("a service that already has a list wins over what the browser kept", async () => {
  localStorage.setItem(KEY, JSON.stringify({ pinned: ["mine"], order: null, orderedAt: null, local: true }))
  const r = rig(async () => ({ pinned: ["theirs"], order: null, orderedAt: null }))
  r.setStatus("connected")
  await settle()
  expect(r.list.view().pinned).toEqual(["theirs"])
  expect(r.calls).toHaveLength(1)
  r.dispose()
})

test("a connection that may not read asks nothing; a failure keeps what was there", async () => {
  localStorage.setItem(KEY, JSON.stringify({ pinned: ["a"], order: null, orderedAt: null }))
  const none = rig(
    async () => EMPTY,
    () => false,
  )
  none.setStatus("connected")
  await settle()
  expect(none.calls).toEqual([])
  expect(none.list.can()).toBe(false)
  none.dispose()
  const failing = rig(async () => {
    throw new Error("offline")
  })
  failing.setStatus("connected")
  await settle()
  expect(failing.list.view().pinned).toEqual(["a"])
  expect(failing.list.unsupported()).toBe(false)
  failing.dispose()
})

test("while this window's own change is on its way, the service's events do not put the older list back", async () => {
  const r = rig(async () => EMPTY)
  r.setStatus("connected")
  await settle()
  expect(r.list.hold(1)).toBe(1)
  r.list.apply({ pinned: ["a", "b"], order: null, orderedAt: null })
  r.emit({ pinned: ["a"], order: null, orderedAt: null })
  expect(r.list.view().pinned).toEqual(["a", "b"])
  expect(r.list.hold(-1)).toBe(0)
  r.emit({ pinned: ["c"], order: null, orderedAt: null })
  expect(r.list.view().pinned).toEqual(["c"])
  r.dispose()
})

test("broken storage is no list", () => {
  localStorage.setItem(KEY, "{")
  const r = rig(async () => EMPTY)
  expect(r.list.view()).toEqual(EMPTY)
  r.dispose()
})
