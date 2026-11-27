import { afterAll, describe, expect, test } from "bun:test"
import { Refs } from "../../src/git/refs.js"
import { commit, f1, git, temp, write } from "../fixtures/repo.js"

const box = temp()
afterAll(() => box.dispose())
const repo = f1(box.root)
const first = repo.head
write(repo.home, { "src/app/second.ts": "2\n" })
const second = commit(repo.home, "second")

function refs() {
  return git(repo.home, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/own"]).trim()
}

describe("Refs.create (06 §2.4 create-only)", () => {
  test("creates once; the same value again counts as done", async () => {
    const item = { ref: `refs/own/keep/${first}`, oid: first }
    expect(await Refs.create(repo.home, item)).toEqual({ ok: true, created: true, oid: first })
    expect(await Refs.create(repo.home, item)).toEqual({ ok: true, created: false, oid: first })
    expect(await Refs.read(repo.home, item.ref)).toBe(first)
  })

  test("a keep or integrate ref holding another value is not overwritten", async () => {
    const ref = "refs/own/integrate/ig_1/base"
    expect((await Refs.create(repo.home, { ref, oid: first })).ok).toBe(true)
    const again = await Refs.create(repo.home, { ref, oid: second })
    expect(again).toMatchObject({ ok: false, error: "exists", ref, oid: first })
    expect(await Refs.read(repo.home, ref)).toBe(first)
  })

  test("a hold ref is done once it exists, whatever its value", async () => {
    const ref = "refs/own/hold/ar_ui/op_1"
    expect((await Refs.create(repo.home, { ref, oid: first })).ok).toBe(true)
    expect(await Refs.create(repo.home, { ref, oid: second })).toEqual({ ok: true, created: false, oid: first })
    expect(await Refs.read(repo.home, ref)).toBe(first)
  })

  test("bad names and bad OIDs are refused before git runs", async () => {
    const before = refs()
    for (const item of [
      { ref: "refs/own/keep/x", oid: "" },
      { ref: "refs/own/keep/x", oid: first.slice(0, 7) },
      { ref: "refs/own/keep/x", oid: "HEAD" },
      { ref: "own/keep/x", oid: first },
      { ref: "refs/own/keep/a b", oid: first },
      { ref: "refs/own/keep/x..y", oid: first },
      { ref: "refs/own/keep/x.lock", oid: first },
    ])
      expect((await Refs.create(repo.home, item)).ok).toBe(false)
    expect(refs()).toBe(before)
  })

  test("read: null for a missing ref, exact names only", async () => {
    expect(await Refs.read(repo.home, "refs/own/keep/none")).toBeNull()
    // `refs/own/integrate/ig_1` is only a prefix of an existing ref
    expect(await Refs.read(repo.home, "refs/own/integrate/ig_1")).toBeNull()
  })
})

describe("Refs.createAll (--stdin transaction)", () => {
  const set = (id: string, oid = second) => [
    { ref: `refs/own/integrate/${id}/base`, oid: first },
    { ref: `refs/own/integrate/${id}/source`, oid },
    { ref: `refs/own/integrate/${id}/candidate`, oid },
  ]

  test("creates all, and a rerun with the same values is done", async () => {
    expect(await Refs.createAll(repo.home, set("ig_2"))).toEqual({ ok: true, created: true })
    expect(await Refs.createAll(repo.home, set("ig_2"))).toEqual({ ok: true, created: false })
  })

  test("one conflicting ref fails the transaction and writes nothing", async () => {
    await Refs.create(repo.home, { ref: "refs/own/integrate/ig_3/candidate", oid: first })
    const before = refs()
    const result = await Refs.createAll(repo.home, set("ig_3"))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toBe("exists")
    expect(refs()).toBe(before)
    expect(await Refs.read(repo.home, "refs/own/integrate/ig_3/base")).toBeNull()
  })

  test("refs that already exist with their values are kept and the rest are created", async () => {
    await Refs.create(repo.home, { ref: "refs/own/integrate/ig_4/base", oid: first })
    expect(await Refs.createAll(repo.home, set("ig_4"))).toEqual({ ok: true, created: true })
    expect(await Refs.read(repo.home, "refs/own/integrate/ig_4/candidate")).toBe(second)
  })

  test("a bad OID in any line refuses the whole transaction", async () => {
    const before = refs()
    const result = await Refs.createAll(repo.home, [
      { ref: "refs/own/keep/good", oid: first },
      { ref: "refs/own/keep/bad", oid: "" },
    ])
    expect(!result.ok && result.error).toBe("invalid")
    expect(refs()).toBe(before)
  })
})

describe("Refs.removeIf", () => {
  test("deletes only while the ref holds the expected value", async () => {
    const ref = "refs/heads/area-undo"
    await Refs.create(repo.home, { ref, oid: first })
    expect((await Refs.removeIf(repo.home, { ref, oid: second })).ok).toBe(false)
    expect(await Refs.read(repo.home, ref)).toBe(first)
    expect((await Refs.removeIf(repo.home, { ref, oid: first })).ok).toBe(true)
    expect(await Refs.read(repo.home, ref)).toBeNull()
  })
})

describe("Refs.valid", () => {
  test("accepts own's ref shapes and rejects the rest", () => {
    expect(Refs.valid(`refs/own/keep/${first}`)).toBe(true)
    expect(Refs.valid("refs/own/hold/assets/op_01J")).toBe(true)
    expect(Refs.valid("refs/heads/inventory-ui")).toBe(true)
    for (const ref of ["HEAD", "refs/", "refs/x/", "refs/.x", "refs/x@{1}", "refs/a//b", "refs/a~1", "refs/a:b"])
      expect(Refs.valid(ref)).toBe(false)
  })
})
