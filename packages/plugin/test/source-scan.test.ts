// OWN-PATCH(P-056) begin
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { prepareSource } from "../src/source.bun.js"

// Each call stands for one more Location preparing the same plugin: the import graph it tracks must follow the
// file's current text, whether or not the scan was kept from an earlier call.
async function tracked(entry: string) {
  const files: string[] = []
  await prepareSource(pathToFileURL(entry).href, (file) => files.push(file))
  return files.map((file) => path.basename(file)).sort()
}

describe("prepareSource", () => {
  it("tracks the same graph for every Location and follows edits to an unchanged path", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-source-scan-")))
    try {
      const entry = path.join(root, "index.ts")
      await writeFile(path.join(root, "a.ts"), "export const a = 1")
      await writeFile(path.join(root, "b.ts"), "export const b = 2")
      await writeFile(entry, 'export { a } from "./a.ts"')
      assert.deepEqual(await tracked(entry), ["a.ts", "index.ts"])
      assert.deepEqual(await tracked(entry), ["a.ts", "index.ts"])
      await writeFile(entry, 'export { a } from "./a.ts"\nexport { b } from "./b.ts"')
      assert.deepEqual(await tracked(entry), ["a.ts", "b.ts", "index.ts"])
      await writeFile(entry, 'export { a } from "./a.ts"')
      assert.deepEqual(await tracked(entry), ["a.ts", "index.ts"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
// OWN-PATCH(P-056) end
