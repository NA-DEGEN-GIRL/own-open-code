// Ports codex-rs/apply-patch/tests/suite/scenarios.rs over the fixtures of
// codex-rs/apply-patch/tests/fixtures/scenarios (copied byte for byte into test/fixtures/codex-apply-patch): copy
// `input/` to a temporary directory, apply `patch.txt`, and compare the whole tree with `expected/`.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ApplyPatch } from "../../../src/codex/apply-patch/index.js"

const SCENARIOS = path.join(import.meta.dir, "..", "..", "fixtures", "codex-apply-patch")

const scenarios = (await readdir(SCENARIOS, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

/** Relative path → file bytes (as hex, for readable diffs) or `dir`. */
async function snapshot(root: string): Promise<Record<string, string>> {
  if (!existsSync(root)) return {}
  const entries = await readdir(root, { recursive: true })
  const pairs = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(root, entry)
      const metadata = await stat(full)
      const key = entry.split(path.sep).join("/")
      if (metadata.isDirectory()) return [key, "dir"] as const
      return [key, (await readFile(full)).toString("hex")] as const
    }),
  )
  return Object.fromEntries(pairs.toSorted((left, right) => left[0].localeCompare(right[0])))
}

async function run(scenario: string, verify: boolean) {
  const dir = path.join(SCENARIOS, scenario)
  const tmp = await mkdtemp(path.join(os.tmpdir(), "codex-scenario-"))
  try {
    if (existsSync(path.join(dir, "input"))) await cp(path.join(dir, "input"), tmp, { recursive: true })
    const patch = await readFile(path.join(dir, "patch.txt"), "utf8")
    // Like scenarios.rs, only the final filesystem state is asserted, not the outcome.
    await ApplyPatch.applyPatch(patch, tmp, ApplyPatch.nodeFs, { verify }).catch((error: unknown) => {
      if (!(error instanceof ApplyPatch.ApplyPatchError)) throw error
    })
    return { actual: await snapshot(tmp), expected: await snapshot(path.join(dir, "expected")) }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

describe("apply_patch scenarios (standalone apply_patch: no verification)", () => {
  test("all 25 fixtures are present", () => {
    expect(scenarios.length).toBe(25)
  })

  for (const scenario of scenarios)
    test(scenario, async () => {
      const result = await run(scenario, false)
      expect(result.actual).toEqual(result.expected)
    })
})

describe("apply_patch scenarios (tool path: verification first)", () => {
  for (const scenario of scenarios)
    test(scenario, async () => {
      const result = await run(scenario, true)
      // Verification rejects the missing file before the first hunk writes, so nothing changes.
      if (scenario === "015_failure_after_partial_success_leaves_changes") return expect(result.actual).toEqual({})
      expect(result.actual).toEqual(result.expected)
    })
})
