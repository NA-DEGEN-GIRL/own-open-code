// OWN-PATCH(P-050) begin
// A Linux binary compiled on Windows must not hold the build machine's path for effect's createRequire (P-050).
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ownFilenamePlugin } from "../script/own-filename"

test("effect's node:http loader is bundled with import.meta.url, not the build machine's __filename", async () => {
  const dir = await fs.mkdtemp(path.join(path.resolve(import.meta.dirname, ".."), ".own-filename-"))
  try {
    const entry = path.join(dir, "entry.ts")
    await Bun.write(
      entry,
      'import { NodeHttpServer } from "@effect/platform-node"\nconsole.log(typeof NodeHttpServer)\n',
    )
    const bundle = async (plugins: Array<typeof ownFilenamePlugin>) => {
      const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", plugins })
      expect(result.success).toBe(true)
      return (await Promise.all(result.outputs.map((output) => output.text()))).join("\n")
    }
    // Without the plugin Bun inlines the source path (a Windows path on this PC, refused by Linux's createRequire).
    const http = /__filename\s*=\s*"[^"]*internal[/\\]+http\.js"/
    expect(await bundle([])).toMatch(http)
    const patched = await bundle([ownFilenamePlugin])
    expect(patched).not.toMatch(http)
    expect(patched).toContain("createRequire")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
// OWN-PATCH(P-050) end
