// own's test and source runs keep core's feature flags as a release has them (own/scripts/test/release-flags.ts).
import { describe, expect, test } from "bun:test"
import { ConfigFlag } from "@opencode/schema/config/flag"
import { Flag } from "../../core/src/flag.ts"
import { RELEASE_FLAGS } from "../../../own/scripts/test/release-flags.ts"

const off = (flags: ReturnType<typeof Flag.resolve>) =>
  Object.entries(flags).filter((entry) => entry[1].enabled).map((entry) => entry[0])

describe("release flags", () => {
  test("own's release channel resolves every flag off", () => {
    const flags = Flag.resolve({ entries: [], channel: "own" })
    expect(Object.keys(flags).toSorted()).toEqual(Object.keys(ConfigFlag.registry).toSorted())
    expect(off(flags)).toEqual([])
  })

  test("the pinned list names every flag of the registry, so a source run matches a release", () => {
    expect(RELEASE_FLAGS.split(",").toSorted()).toEqual(Object.keys(ConfigFlag.registry).map((key) => `-${key}`).toSorted())
    expect(off(Flag.resolve({ entries: [], channel: "local", overrides: RELEASE_FLAGS }))).toEqual([])
    // Without the pin a source run (channel local) would have them all on but the opt-in-only ones.
    expect(off(Flag.resolve({ entries: [], channel: "local" })).toSorted()).toEqual(
      Object.keys(ConfigFlag.registry)
        .filter((key) => !ConfigFlag.optInOnly.has(key as ConfigFlag.Key))
        .toSorted(),
    )
  })

  test("the preload pinned this test run", () => {
    expect(process.env.OPENCODE_FLAGS).toBe(RELEASE_FLAGS)
  })
})
